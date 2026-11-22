import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, mixOklab } from '../../gfx/solid';
import type { PropAsset } from '../types';
import { Polytope, faceCenter, fitSize, stonePaint, stoneTones, variant } from './nature';
import type { StoneTones } from './nature';

/**
 * S02 WEDGE — an angular, triangular stone with ONE ridge: low and pointed
 * at one end, tall and blunt at the other, a cream slope running the whole
 * way from the tip up to the summit (small-rocks/design-sheet.png, second
 * column).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - plan: a triangle, tip on the left, the tall end on the right, all three
 *    corners clipped;
 *  - the cream slope: ONE plane climbing ~35° from the tip to the summit
 *    over the back-right corner, falling a little toward the front. Its
 *    front edge stays within a few centimetres of the ground along the low
 *    half, so from the front the stone reads as a cream ramp over a thin
 *    lavender foot, not a tent with a cream patch;
 *  - the ridge: where the slope meets the back. Off centre, toward the back,
 *    with a kink in plan, and chamfered by a narrow pale facet so the crest
 *    is a facet, not a knife edge;
 *  - the back: three planes turned against each other (±15–20°) and leaning
 *    10–30°, so from behind it is a faceted flank, not one doorstop wall;
 *  - the front: a steep lavender foot in two planes; the tall end: three
 *    walls with two chamfers under the summit, the summit itself clipped.
 * Only planes within ~37° of level are cream; the steeper ones are flank.
 * The underside is broad, flat and closed.
 *
 * Variants: how long and how steep the slope is, how far the ridge sits off
 * centre and where it kinks, the back planes turned and leaned anew, the
 * tip blunter or sharper, the tall end wider or narrower — and odd seeds
 * are mirrored.
 */

const ID = 's02-wedge';
const SIZE = { x: 0.55, y: 0.32, z: 0.35 };
// The lab measures the height WITH the skirt (8 % band): 3.8 cm of burial
// leaves the stone 30 cm above ground.
const SKIRT = 0.038;
const H = 0.32;

// [compass (0 = back, 90 = right, 180 = front), reach from the centre at
// height y, lean in from vertical, y]
type Wall = readonly [number, number, number, number];
const TALL_END: readonly Wall[] = [
  [98, 0.255, 10, 0],
  [140, 0.222, 17, 0],
  [58, 0.236, 13, 0],
];
// Chamfers under the summit, on the tall end.
const SUMMIT: readonly Wall[] = [
  [102, 0.226, 38, 0.19],
  [134, 0.212, 42, 0.14],
];

// Plan points [x, z] (z = back), measured off the top view.
// The ridge: tip → two kinks → summit. Each run turns 12–19° against the
// last, so the crest is not a ruled line and the back is three planes.
const RIDGE: readonly (readonly [number, number])[] = [
  [-0.265, -0.035],
  [-0.12, 0.055],
  [0.035, 0.07],
  [0.18, 0.135],
];
// How far each back plane leans in from vertical, degrees.
const BACK_LEAN = [10, 32, 18];
// The foot under the slope's front edge: ground line tip → kink → front
// corner of the tall end, and the lean of each plane.
const FOOT: readonly (readonly [number, number])[] = [
  [-0.27, -0.045],
  [-0.03, -0.138],
  [0.2, -0.168],
];
const FOOT_LEAN = [17, 20];

type V3 = [number, number, number];

function build(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const mirror = seed % 2 ? -1 : 1;
  const rock = Polytope.block(H * 1.6, SKIRT);
  const wall = (w: Wall, r: ReturnType<typeof v.fork>, tag: string): void => {
    rock.wall(mirror * (w[0] + r.num(0, 9)), w[1] * r.num(1, 0.08), w[2] + r.num(0, 6), w[3], tag);
  };
  // A plane containing the line a→b and leaning in by `lean` from vertical
  // as it rises, its outside toward `out` (a plan direction).
  const lean = (a: V3, b: V3, deg: number, out: [number, number], tag: string): void => {
    const A = new Vector3(a[0] * mirror, a[1], a[2]);
    const B = new Vector3(b[0] * mirror, b[1], b[2]);
    const h = new Vector3(out[0] * mirror, 0, out[1]).normalize();
    // Down the face: outward by tan(lean) per unit drop.
    const down = h.scale(Math.sin(deg * DEG)).add(new Vector3(0, -Math.cos(deg * DEG), 0));
    const n = Vector3.Cross(B.subtract(A), down).normalize();
    if (Vector3.Dot(n, h) < 0) n.scaleInPlace(-1);
    try {
      rock.cut([n.x, n.y, n.z], [A.x, A.y, A.z], tag);
    } catch {
      /* a plane that would remove the stone: leave it out */
    }
  };

  // The slope: one plane through the summit, climbing along the ridge from
  // the tip and falling toward the front across it.
  const vr = v.fork('ridge');
  const ridge = RIDGE.map(([x, z], i) => [x + (i ? vr.num(0, 0.025) : 0), z + vr.num(0, 0.025)] as [number, number]);
  const tip = ridge[0];
  const peak = ridge[ridge.length - 1];
  const run = Math.hypot(peak[0] - tip[0], peak[1] - tip[1]);
  const u = [(peak[0] - tip[0]) / run, (peak[1] - tip[1]) / run];
  const w = [-u[1], u[0]]; // toward the back
  const climb = (H - vr.num(0.012, 0.01)) / run;
  const fall = vr.num(0.5, 0.12);
  const height = (x: number, z: number): number => H + climb * ((x - peak[0]) * u[0] + (z - peak[1]) * u[1]) + fall * ((x - peak[0]) * w[0] + (z - peak[1]) * w[1]);
  rock.cut([-(climb * u[0] + fall * w[0]) * mirror, 1, -(climb * u[1] + fall * w[1])], [peak[0] * mirror, H, peak[1]], 'top');

  // The back: one plane down from each run of the ridge.
  const vb = v.fork('back');
  for (let i = 0; i < ridge.length - 1; i++) {
    const [x0, z0] = ridge[i];
    const [x1, z1] = ridge[i + 1];
    lean([x0, height(x0, z0), z0], [x1, height(x1, z1), z1], BACK_LEAN[i] + vb.num(0, 8), [-(z1 - z0), x1 - x0], 'back');
  }
  // A steeper foot along the back's lower edge: a second band of facets,
  // so from behind the stone is not one sheet from the ground to the crest.
  rock.wall(mirror * vb.num(350, 10), vb.num(0.122, 0.012), vb.num(6, 3), 0, 'back');
  // The foot: the ground line tip → front corner, two planes.
  const vf = v.fork('foot');
  const foot = FOOT.map(([x, z]) => [x, z + vf.num(0, 0.02)] as [number, number]);
  for (let i = 0; i < foot.length - 1; i++) {
    const [x0, z0] = foot[i];
    const [x1, z1] = foot[i + 1];
    lean([x0, 0, z0], [x1, 0, z1], FOOT_LEAN[i] + vf.num(0, 5), [z1 - z0, -(x1 - x0)], 'flank');
  }
  // The tall end, wider or narrower as one.
  const vw = v.fork('walls');
  const wide = v.num(1, 0.1);
  for (const t of TALL_END) wall([t[0], t[1] * wide, t[2], t[3]], vw, 'flank');
  for (const t of SUMMIT) wall([t[0], t[1] * wide, t[2], t[3]], vw, 'flank');
  // The tip, clipped — a little on the hero, bluntly on some variants.
  rock.wall(mirror * (263 + vw.num(0, 12)), v.num(0.258, 0.03), v.num(30, 10), 0, 'flank');
  // "Clip the sharpest corner": the summit, toward the tall end.
  rock.wall(mirror * vr.num(68, 15), Math.hypot(peak[0], peak[1]) + 0.012, vr.num(58, 6), H - 0.03, 'shoulder');
  // The crest: a narrow facet along the ridge, so it is not a knife edge.
  chamferBetween(rock, 'top', 'back', v.num(0.032, 0.008));
  // Two chipped corners off the flanks break the long straight edges.
  rock.clip({ count: 2, size: 0.016, seed: seed * 7 + 3, above: 0.05 });

  const m = new SolidMesh();
  // On top of the variant's mood the seeds cycle the flank cast — lavender
  // (the sheet), slate, mauve — so neighbours in a scatter differ in colour
  // as well as in outline, all inside the stone palette.
  const cast = [{}, { side: tones.alt, warm: tones.side }, { side: tones.warm, alt: tones.side }][Math.abs(seed) % 3];
  const shade = stonePaint(tones, { seed, height: H, topAbove: 0.8, rimAbove: 0.6, tones: { ...softShade(tones), ...cast } });
  rock.emit(m, (f) => shade(f.tag === 'back' ? { ...f, tag: 'flank' } : f));
  fitSize(m, v.size(SIZE, 0.12, 0.1));
  return m;
}

/**
 * Chamfer the edges where a face tagged `a` meets one tagged `b` with a
 * strip `width` wide measured on the `a` face (Polytope.bevel does every edge
 * of a tag; here only the crest may be softened).
 */
function chamferBetween(p: Polytope, a: string, b: string, width: number): void {
  const near = (x: Vector3, y: Vector3): boolean => Vector3.DistanceSquared(x, y) < 1e-10;
  const planes: { n: Vector3; at: Vector3 }[] = [];
  for (const f of p.faces) {
    if (f.tag !== a) continue;
    const centre = faceCenter(f);
    for (let i = 0; i < f.points.length; i++) {
      const s = f.points[i];
      const e = f.points[(i + 1) % f.points.length];
      const g = p.faces.find((o) => o !== f && o.tag === b && o.points.some((q) => near(q, s)) && o.points.some((q) => near(q, e)));
      // Skip stubs: a chamfer on an edge shorter than itself is a sliver.
      if (!g || Vector3.Distance(s, e) < width * 2) continue;
      const n = f.normal.add(g.normal).normalize();
      const mid = s.add(e).scale(0.5);
      const inward = Vector3.Cross(f.normal, e.subtract(s)).normalize();
      if (Vector3.Dot(inward, centre.subtract(mid)) < 0) inward.scaleInPlace(-1);
      planes.push({ n, at: mid.add(inward.scale(width)) });
    }
  }
  for (const pl of planes) {
    try {
      p.cut(pl.n, pl.at, 'rim');
    } catch {
      /* leave it */
    }
  }
  p.tidy();
}

/** The foot and crevice tones a step lighter than the family default: a
 * small rock is mostly foot, and the shader's shade side already takes it
 * to violet (the sheet's darkest stone is #626195). */
function softShade(t: StoneTones): Partial<StoneTones> {
  return { low: mixOklab(t.side, t.low, 0.55), crevice: mixOklab(t.side, t.crevice, 0.8) };
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Wedge',
  category: 'small-rock',
  size: SIZE,
  variants: 4,
  build,
  triBudget: 80,
  reference: {
    sheet: 'design-documents/environment-design-pack/small-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/small-rocks/s02-wedge-brief.txt',
  },
};

export default asset;
