import { DEG, SolidMesh, clamp, mixOklab } from '../../gfx/solid';
import type { PropAsset } from '../types';
import { Polytope, fitSize, stonePaint, stoneTones, variant } from './nature';
import type { Variant } from './nature';

/**
 * S04 CHIP CLUSTER — exactly three separate small stones in a loose
 * triangle, with clear ground between them and no shared base (small-rocks/
 * design-sheet.png, fourth column; the style guide's resolution: "three
 * separate stones; no fused terrain base").
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - the COBBLE at the back, right of the middle: the largest and tallest,
 *    six walls round a cream hexagon tipped toward the front;
 *  - the TABLET front-left: low and oblong, nearly upright walls, a level
 *    cream top over most of its plan;
 *  - the CHIP front-right: a wedge on a triangular plan, its cream plane
 *    falling to the left from a ridge near the right-hand end.
 * Three species with three plan shapes, so each stays identifiable from
 * every view, the game camera's top-down one included.
 *
 * 80 triangles for three closed stones is tight (a convex stone with V
 * corners is 2V − 4 triangles), which is why none of them has the pebble's
 * undercut foot: each is one band of walls and a few chamfers under its top.
 *
 * Variants: the triangle is turned and its sides redrawn, the three species
 * change places, each stone is turned in its own footprint and resized, and
 * every odd seed is the mirror image. Whatever the layout, the stones are
 * pushed apart until there is ground between them.
 */

const ID = 's04-chip-cluster';
const SIZE = { x: 0.75, y: 0.22, z: 0.65 };
// The lab measures the height WITH the skirt (8 % band): 2.6 cm of burial
// leaves the tallest stone 21 cm above ground; the undersides are closed.
const SKIRT = 0.026;
// Least clear ground between two stones.
const GAP = 0.06;

// [compass (0 = back, 90 = right, 180 = front), reach as a fraction of the
// footprint ellipse, lean in from vertical, height of the point the plane
// passes through as a fraction of the stone's].
type Plane = readonly [number, number, number, number];

interface Species {
  /** Half width, height, half depth. */
  radii: readonly [number, number, number];
  walls: readonly Plane[];
  chamfers: readonly Plane[];
  /** The top planes: [tilt, compass it falls toward, offset of the point it
   * passes through at full height (x, z) as fractions of the radii, cream?]. */
  tops: readonly (readonly [number, number, number, number, boolean])[];
}

// Three species with three plan shapes, so no two stones read alike from
// the game camera: a HEXAGONAL cobble, an OBLONG tablet, a TRIANGULAR chip.
const COBBLE: Species = {
  radii: [0.17, 0.22, 0.14],
  walls: [
    [174, 1.0, 9, 0.3],
    [118, 0.97, 8, 0.3],
    [58, 1.0, 10, 0.3],
    [0, 0.96, 8, 0.3],
    [298, 1.0, 9, 0.3],
    [238, 0.97, 10, 0.3],
  ],
  // Steep, or a stone this tall for its footprint closes to a point: the
  // cream is to keep half the plan.
  chamfers: [
    [206, 0.95, 40, 0.68],
    [140, 0.98, 34, 0.62],
    [30, 0.98, 36, 0.66],
    [282, 0.98, 38, 0.7],
  ],
  tops: [[9, 200, -0.08, 0.06, true]],
};

// Low, long and level: nearly upright walls, a broad flat cream top.
const TABLET: Species = {
  radii: [0.165, 0.12, 0.11],
  walls: [
    [190, 1.0, 6, 0.3],
    [128, 0.94, 8, 0.3],
    [66, 1.0, 5, 0.3],
    [338, 0.97, 7, 0.3],
    [266, 1.0, 6, 0.3],
  ],
  chamfers: [
    [158, 0.98, 36, 0.7],
    [300, 0.98, 38, 0.7],
  ],
  tops: [[3, 150, 0, 0, true]],
};

// A wedge on a triangular plan: tall at the right-hand corner, its cream
// plane falling to the left.
const CHIP: Species = {
  radii: [0.14, 0.16, 0.12],
  walls: [
    [318, 0.62, 14, 0],
    [80, 0.95, 9, 0],
    [168, 0.8, 12, 0],
    [214, 0.74, 24, 0],
    // the left tip, clipped
    [262, 0.92, 28, 0],
  ],
  chamfers: [],
  tops: [
    // The cream plane, falling to the left from the ridge …
    [30, 262, 0.5, 0.1, true],
    // … and the lavender one behind it, down to the tall end.
    [44, 70, 0.45, 0.1, false],
  ],
};

// The sheet's layout: [species, x, z].
const HERO: readonly (readonly [Species, number, number])[] = [
  [COBBLE, 0.07, 0.17],
  [TABLET, -0.21, -0.16],
  [CHIP, 0.215, -0.19],
];

function stone(sp: Species, v: Variant, mirror: number): Polytope {
  const k = v.num(1, 0.12);
  const R = [sp.radii[0] * k * v.num(1, 0.08), sp.radii[1] * v.num(1, 0.1) * k, sp.radii[2] * k * v.num(1, 0.08)];
  const turn = v.range(0, 0, 360);
  const rho = (az: number): number => (R[0] * R[2]) / Math.hypot(R[2] * Math.sin(az * DEG), R[0] * Math.cos(az * DEG));
  const rock = Polytope.block(R[1] * 1.5, SKIRT);
  const carve = (az: number, reach: number, lean: number, y: number, tag: string): void => {
    const a = mirror * (az + turn) * DEG;
    const e = lean * DEG;
    const r = rho(mirror * (az + turn)) * reach;
    try {
      rock.cut([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)], [Math.sin(a) * r, y, Math.cos(a) * r], tag);
    } catch {
      /* a plane that would remove the stone: leave it out */
    }
  };
  for (const [az, reach, lean, y] of sp.walls) carve(az + v.num(0, 8), reach * v.num(1, 0.05), lean + v.num(0, 3), R[1] * y, 'flank');
  for (const [az, reach, lean, y] of sp.chamfers) carve(az + v.num(0, 10), reach * v.num(1, 0.04), lean + v.num(0, 5), R[1] * (y + v.num(0, 0.05)), 'flank');
  for (const [tilt, toward, ox, oz, cream] of sp.tops) {
    const t = (tilt + v.num(0, 4)) * DEG;
    const a = mirror * (toward + turn + v.num(0, 12)) * DEG;
    // The point the plane hangs from turns with the pattern.
    const c = Math.cos(mirror * turn * DEG);
    const s = Math.sin(mirror * turn * DEG);
    const px = mirror * ox * R[0];
    const pz = oz * R[2];
    try {
      rock.cut([Math.sin(a) * Math.sin(t), Math.cos(t), Math.cos(a) * Math.sin(t)], [px * c + pz * s, R[1], pz * c - px * s], cream ? 'top' : 'shoulder');
    } catch {
      /* leave it out */
    }
  }
  return rock;
}

function build(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const mirror = seed % 2 ? -1 : 1;

  // Layout: the sheet's triangle; variants turn it, redraw it and deal the
  // three species to other corners.
  const vl = v.fork('layout');
  const order = v.hero ? [0, 1, 2] : vl.r.shuffle([0, 1, 2]);
  const spin = vl.range(0, 0, 360) * DEG;
  const spots = HERO.map(([, x, z]) => {
    const d = vl.num(1, 0.12);
    const c = Math.cos(spin);
    const s = Math.sin(spin);
    return [mirror * (x * c + z * s) * d + vl.num(0, 0.03), (z * c - x * s) * d + vl.num(0, 0.03)];
  });
  const stones = spots.map((_, i) => stone(HERO[order[i]][0], v.fork(`stone${i}`), mirror));
  // Clear ground between every pair: push overlapping stones apart along
  // the line between them (footprints taken as circles round their boxes).
  const radius = stones.map((p) => {
    const b = p.bounds();
    return Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
  });
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const dx = spots[j][0] - spots[i][0];
        const dz = spots[j][1] - spots[i][1];
        const d = Math.hypot(dx, dz) || 1e-6;
        const need = radius[i] + radius[j] + GAP;
        if (d >= need) continue;
        const push = (need - d) / 2 / d;
        spots[i][0] -= dx * push;
        spots[i][1] -= dz * push;
        spots[j][0] += dx * push;
        spots[j][1] += dz * push;
      }
    }
  }

  const m = new SolidMesh();
  // On top of the variant's mood the seeds cycle the flank cast — lavender
  // (the sheet), slate, mauve — so neighbours in a scatter differ in colour
  // as well as in outline, all inside the stone palette.
  const cast = [{}, { side: tones.alt, warm: tones.side }, { side: tones.warm, alt: tones.side }][Math.abs(seed) % 3];
  const soft = { low: mixOklab(tones.side, tones.low, 0.55), crevice: mixOklab(tones.side, tones.crevice, 0.8) };
  stones.forEach((p, i) => {
    p.move([spots[i][0], 0, spots[i][1]]);
    // Each stone draws its own flank tones (seed + i), all from one palette.
    const shade = stonePaint(tones, { seed: seed * 3 + i, height: p.bounds().max.y, topAbove: 0.8, rimAbove: 0.6, tones: { ...soft, ...cast } });
    p.emit(m, shade);
  });

  // The hero fills the design's box. A turned triangle has other
  // proportions: variants keep theirs (the stones are not stretched to
  // fit), scaled to the design's ground area and held inside the lab's band.
  let size = { ...SIZE };
  if (!v.hero) {
    const b = m.bounds();
    const bx = b.max.x - b.min.x;
    const bz = b.max.z - b.min.z;
    const s = Math.sqrt((SIZE.x * SIZE.z) / (bx * bz)) * v.num(1, 0.08);
    size = { x: clamp(bx * s, SIZE.x * 0.78, SIZE.x * 1.22), y: SIZE.y * v.num(1, 0.1), z: clamp(bz * s, SIZE.z * 0.78, SIZE.z * 1.22) };
  }
  fitSize(m, size);
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Chip Cluster',
  category: 'small-rock',
  size: SIZE,
  variants: 4,
  build,
  triBudget: 80,
  reference: {
    sheet: 'design-documents/environment-design-pack/small-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/small-rocks/s04-chip-cluster-brief.txt',
  },
};

export default asset;
