import { SolidMesh, jitterColor, mix, noise3, paint, rng, roundedBox } from '../../gfx/solid';
import type { RGB, Rng } from '../../gfx/solid';
import { STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';

/**
 * Low retaining wall of the vision: two courses of big, chunky lavender
 * blocks with broad chamfers, joints staggered between the courses, every
 * block a slightly different size, depth and tone. Upward planes are the
 * cream "sunlit top" material of the rock sheets, the top course unevenly
 * high so the wall has a broken skyline.
 *
 * TILING: 3 m long, both ends flat at x = ±1.5 (chamfered like every other
 * joint), so segments butt end to end and the seam reads as one more joint.
 * Faceted on purpose (smooth: 0), like the rocks.
 */

const LENGTH = 3.0;
const DEPTH = 0.56;
const COURSE = [0.56, 0.5] as const;
const HEIGHT = COURSE[0] + COURSE[1];
// Longest edge left unsplit before the faces are knocked out of square. At
// 0.72 m a wall of nine blocks stays inside the 400-triangle dressing budget.
const TESS = 0.72;

/** Split `LENGTH` into n widths around the mean, none thinner than 55 %. */
function partition(r: Rng, n: number): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = r.range(0.62, 1.38);
    w.push(v);
    sum += v;
  }
  return w.map((v) => (v / sum) * LENGTH);
}

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd12-stone-wall');
  const hero = seed === 0;
  const m = new SolidMesh();
  const noiseSeed = hero ? 11 : r.int(0, 9999);

  // Hero: hand-picked joints. Other seeds: random, but an upper joint never
  // sits right above a lower one (a running vertical crack reads as a seam).
  let lower = hero ? [0.84, 1.16, 1.0] : partition(r, r.int(3, 4));
  let upper = hero ? [0.62, 1.02, 0.78, 0.58] : partition(r, r.int(3, 5));
  if (!hero) {
    for (let tries = 0; tries < 12; tries++) {
      const joints = (ws: number[]): number[] => ws.slice(0, -1).map((_, i) => ws.slice(0, i + 1).reduce((a, b) => a + b, 0));
      const lj = joints(lower);
      if (joints(upper).every((u) => lj.every((l) => Math.abs(u - l) > 0.16))) break;
      upper = partition(r, upper.length);
      lower = tries > 6 ? partition(r, lower.length) : lower;
    }
  }

  const tone = hero ? STONE.base : jitterColor(r, STONE.base, { hue: 8, lightness: 0.03 });
  const courses = [lower, upper];
  let y0 = -0.05;
  courses.forEach((widths, c) => {
    const top = c === 1;
    let x = -LENGTH / 2;
    const yTop = c === 0 ? COURSE[0] : HEIGHT;
    widths.forEach((w, i) => {
      const s = m.mark();
      // Lower course a touch deeper: a 3–5 cm ledge at its top, front and back.
      const d = (top ? DEPTH - 0.09 : DEPTH) + r.range(-0.035, 0.0);
      const zc = r.range(-0.012, 0.012);
      // Top course: uneven heights; the lowest still covers the joint line.
      const h = top ? yTop + (hero ? [0.0, -0.07, -0.02, -0.1][i] : r.range(-0.11, 0)) : yTop + r.range(-0.012, 0.012);
      const base: RGB = mix(mix(tone, STONE.midSlate, r.range(0, 0.8)), STONE.upperFace, r.range(0, 0.14));
      const radius = r.range(0.055, 0.085);
      roundedBox(
        m,
        {
          // Overlap with the neighbours and the course below: sunk into
          // each other, so the chamfers meet in a shallow groove.
          min: [x - (i === 0 ? 0 : 0.02), y0 - (top ? 0.035 : 0.07), zc - d / 2],
          max: [x + w + (i === widths.length - 1 ? 0 : 0.02), h, zc + d / 2],
          radius,
          segments: 1,
          // Lower course: the end faces buried in the neighbours are left
          // out (the chamfer rings around them stay and close the grooves).
          // The top course keeps them — its blocks differ in height, so
          // part of every end face shows above the shorter neighbour.
          faces: { ny: null, ...(top || i === 0 ? {} : { nx: null }), ...(top || i === widths.length - 1 ? {} : { px: null }) },
        },
        paint(base, { gloss: 0.06, smooth: 0 }),
      );
      // Break the big faces into a few facets and knock them out of square,
      // as on the rock sheets — but never the two wall ends, which must stay
      // flat to butt against the next segment.
      // The lower course's bottom chamfer ring is underground: drop it.
      if (!top) m.repaint((c) => (c.y < y0 - 0.07 + radius * 0.75 ? null : undefined), s);
      m.tessellate(TESS, s);
      const k = 0.04;
      m.displace((p) => {
        // x and y use ONE noise field for the whole wall, so neighbouring
        // blocks move together and no joint opens; z is per block, which is
        // what sets each face on its own plane.
        const nx = (noise3(p.x * 2.3, p.y * 2.3, p.z * 2.3, noiseSeed) - 0.5) * 2 * k;
        const ny = (noise3(p.x * 1.9, p.y * 2.2 + 5, p.z * 2.4, noiseSeed + 5) - 0.5) * 2 * k * (p.y > 0.2 ? 0.8 : 0);
        const nz = (noise3(p.x * 2.9 + 9, p.y * 3.3, p.z * 2.2, noiseSeed + 3 + i * 7 + c * 31) - 0.5) * 2 * k;
        const atEnd = Math.abs(Math.abs(p.x) - LENGTH / 2) < 0.1;
        return [p.x + (atEnd ? 0 : nx * 0.5), p.y + ny, p.z + nz * 1.7];
      }, s);
      m.recolor((_p, n, col) => {
        if (n.y > 0.5) return mix(STONE.upperFace, col, top ? 0.08 : 0.3);
        // Above the tilt the faceting gives a wall face (≈ 0.25), so only
        // true bevels are tinted.
        if (n.y > 0.4) return mix(col, STONE.upperFace, 0.35);
        if (n.y < -0.25) return mix(col, STONE.shadow, 0.4);
        return col;
      }, s);
      x += w;
    });
    y0 = yTop;
  });
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'box', center: [0, HEIGHT / 2, 0], half: [LENGTH / 2, HEIGHT / 2, DEPTH / 2] }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd12-stone-wall',
  name: 'Low stone wall segment',
  category: 'dressing',
  // y includes the 5 cm skirt below ground.
  size: { x: LENGTH, y: HEIGHT + 0.1, z: DEPTH + 0.08 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
