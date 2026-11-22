import { DEG, SolidMesh, mixOklab } from '../../gfx/solid';
import type { PropAsset } from '../types';
import { Polytope, fitSize, stonePaint, stoneTones, variant } from './nature';
import type { StoneTones } from './nature';

/**
 * S03 FLAT SLAB — a low oblong stone, nearly all of it one level cream
 * plane inside a thin chunky bevel, with a corner chipped out (small-rocks/
 * design-sheet.png, third column).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - plan: an irregular polygon, 3 : 2, no two sides alike (the hero's ten
 *    walls are measured off the top view);
 *  - sides: short walls, most leaning in a few degrees, a few leaning OUT
 *    (the slab lies on the ground with a dark line under its edge there,
 *    instead of rising out of it all round);
 *  - bevel: 45° chamfers staggered against the walls over the top third of
 *    the thickness — the pale band round the cream;
 *  - top: one plane, a degree or two off level;
 *  - the chip: a square bite out of the front-right corner. A notch is not
 *    convex, so the slab is two convex pieces that meet on the plane through
 *    the notch's inner corner which bisects it — each piece then owns one
 *    wall of the notch and its bevel, and the two bevels mitre;
 *  - the underside is closed: on a slope the downhill edge lifts, and a
 *    low camera must see stone there, not into a shell.
 *
 * Variants redraw the outline (9–10 walls, depth 0.58–0.75 of the width,
 * maybe end for end), the bevel, and the chip ANYWHERE round the outline:
 * a square step 5–12 cm deep, skewed so it is wider or narrower, or (every
 * fourth seed from 2) a deep diagonal corner clip.
 */

const ID = 's03-flat-slab';
const SIZE = { x: 0.9, y: 0.18, z: 0.6 };
// The lab measures the height WITH the skirt (8 % band): 2.2 cm of burial
// leaves the slab 17 cm above ground. The closed underside covers the rest.
const SKIRT = 0.022;
const H = 0.17;

// [compass (0 = back, 90 = right, 180 = front), reach from the centre, lean
// in from vertical (negative = leaning out)], measured off the top view.
type Plane = readonly [number, number, number];
const WALLS: readonly Plane[] = [
  [301, 0.386, 8],
  [334, 0.322, -7],
  [4, 0.292, 9],
  [35, 0.344, 6],
  [70, 0.424, -6],
  [102, 0.44, 9],
  [173, 0.292, 7],
  [200, 0.299, -8],
  [237, 0.377, 8],
  // the left tip, clipped
  [269, 0.428, 7],
];
const BEVEL: readonly Plane[] = [
  [326, 0.335, 45],
  [14, 0.3, 44],
  [56, 0.385, 45],
  [92, 0.43, 46],
  [186, 0.288, 44],
  [268, 0.41, 45],
];

type V3 = [number, number, number];

function build(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const mirror = seed % 2 ? -1 : 1;
  const dir = (az: number): V3 => [Math.sin(mirror * az * DEG), 0, Math.cos(mirror * az * DEG)];

  // The plan. Variants keep the hero's measured pattern of walls and
  // bevels — every reach as a fraction of the hero's ellipse — but put it
  // on an ellipse of another aspect, maybe end for end, jitter every plane
  // and maybe drop one: a new outline in the same hand.
  const vo = v.fork('outline');
  const aspect = vo.range(2 / 3, 0.58, 0.75);
  const RX = 0.45;
  const RZ = RX * aspect;
  const ellipse = (rx: number, rz: number) => (az: number): number => (rx * rz) / Math.hypot(rz * Math.sin(az * DEG), rx * Math.cos(az * DEG));
  const rhoHero = ellipse(0.45, 0.3);
  const rho = ellipse(RX, RZ);
  // Half turns only (plus a little): the hero's dense walls stay on the
  // long ends, where a sparse pattern would leave a pointed tip.
  const turn = v.hero ? 0 : vo.pick(0, [0, 180]) + vo.range(0, -12, 12);
  const redraw = (list: readonly Plane[], drop: number): Plane[] => {
    const out = list.map(([az, reach, lean]): Plane => [az + turn, (reach / rhoHero(az)) * rho(az + turn), lean]);
    for (let i = 0; i < drop; i++) out.splice(vo.int(0, 0, out.length - 1), 1);
    return out;
  };
  const walls = redraw(WALLS, vo.int(0, 0, 1));
  const bevel = redraw(BEVEL, vo.int(0, 0, 1));

  const slab = Polytope.block(H * 1.5, SKIRT);
  // One plane by compass through the point `reach` out at height y. Like
  // `Polytope.wall`, but the lean may be negative.
  const carve = (p: Polytope, az: number, reach: number, lean: number, y: number, tag: string): void => {
    const a = mirror * az * DEG;
    const e = lean * DEG;
    try {
      p.cut([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)], [Math.sin(a) * reach, y, Math.cos(a) * reach], tag);
    } catch {
      /* a plane that would remove the slab: leave it out */
    }
  };
  const vw = v.fork('walls');
  // Leaning walls are placed at mid height, so in or out they keep the plan.
  for (const [az, reach, lean] of walls) carve(slab, az + vw.num(0, 9), reach * vw.num(1, 0.05), lean + vw.num(0, 3), H * 0.45, 'flank');
  const bevelY = H * v.num(0.7, 0.06);
  const vb = v.fork('bevel');
  for (const [az, reach, lean] of bevel) carve(slab, az + vb.num(0, 8), reach * vb.num(1, 0.04), lean + vb.num(0, 5), bevelY, 'shoulder');
  const vt = v.fork('top');
  const tilt = vt.num(1.5, 1.5) * DEG;
  const toward = vt.range(200, 0, 360) * DEG;
  slab.cut([Math.sin(toward) * Math.sin(tilt), Math.cos(tilt), Math.cos(toward) * Math.sin(tilt)], [0, H, 0], 'top');

  // The chip at compass `at` round the outline.
  const vn = v.fork('chip');
  const at = vn.range(140, 0, 360);
  const w = H - bevelY;
  const chamfer = (n: V3): V3 => [n[0], 1, n[2]];
  const mid = H * 0.45;
  const pieces: Polytope[] = [];
  if (seed % 4 === 2) {
    // A diagonal corner clip: one broken plane square to the compass, with
    // its own bevel.
    const depth = vn.range(0, 0.09, 0.13);
    const n = dir(at + vn.num(0, 12));
    const q = slab.surface([0, mid, 0], n);
    const p: V3 = [q.x - n[0] * depth, mid, q.z - n[2] * depth];
    try {
      slab.cut(n, p, 'flank').cut(chamfer(n), [p[0], H - w, p[2]], 'shoulder');
    } catch {
      /* leave it */
    }
    pieces.push(slab);
  } else {
    // A square step: inner corner C `depth` in from the outline at the
    // compass, its two upright walls (a fresh break) at ±45° to it, the pair
    // skewed so one wall runs long along the edge and one is short — a step,
    // as on the sheet. Both walls leave C outward, so on a convex outline
    // each meets the edge once: no spur is ever left. The hero's is the
    // sheet's bite out of the front edge at the right-hand corner.
    const depth = vn.range(0.1, 0.05, 0.12);
    const skew = v.hero ? 5 : vn.range(0, -28, 28);
    const nB = dir(at - 45 + skew);
    const nA = dir(at + 45 + skew);
    const radial = dir(at);
    const q = slab.surface([0, mid, 0], radial);
    const C: V3 = [q.x - radial[0] * depth, 0, q.z - radial[2] * depth];
    // The plane the two pieces meet on: through C, bisecting the notch (its
    // normal points to the piece behind wall B).
    const nS: V3 = [nA[0] - nB[0], 0, nA[2] - nB[2]];
    const edgeAt: V3 = [C[0], H - w, C[2]];
    try {
      pieces.push(
        slab.clone().cut(nS, C, 'inner').cut(nA, C, 'flank').cut(chamfer(nA), edgeAt, 'shoulder'),
        slab.clone().cut([-nS[0], 0, -nS[2]], C, 'inner').cut(nB, C, 'flank').cut(chamfer(nB), edgeAt, 'shoulder'),
      );
    } catch {
      // The corner fell outside this seed's outline: an unchipped slab.
      pieces.length = 0;
      pieces.push(slab);
    }
  }

  const m = new SolidMesh();
  // On top of the variant's mood the seeds cycle the flank cast — lavender
  // (the sheet), slate, mauve — so neighbours in a scatter differ in colour
  // as well as in outline, all inside the stone palette.
  const cast = [{}, { side: tones.alt, warm: tones.side }, { side: tones.warm, alt: tones.side }][Math.abs(seed) % 3];
  const shade = stonePaint(tones, { seed, height: H, tones: { ...softShade(tones), ...cast } });
  for (const p of pieces) p.emit(m, shade);
  // The plan's own aspect survives the fit (within the lab's band).
  const size = v.size(SIZE, 0.12, 0.05);
  if (!v.hero) size.z = Math.min(0.75, Math.max(0.45, size.x * aspect));
  fitSize(m, size);
  return m;
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
  name: 'Flat Slab',
  category: 'small-rock',
  size: SIZE,
  variants: 4,
  build,
  triBudget: 80,
  reference: {
    sheet: 'design-documents/environment-design-pack/small-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/small-rocks/s03-flat-slab-brief.txt',
  },
};

export default asset;
