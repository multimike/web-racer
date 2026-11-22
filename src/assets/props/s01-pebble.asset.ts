import { DEG, SolidMesh, mixOklab } from '../../gfx/solid';
import type { PropAsset } from '../types';
import { Polytope, fitSize, stonePaint, stoneTones, variant } from './nature';

/**
 * S01 PEBBLE — a squashed, irregular pebble: a small cream top plane set off
 * centre, a band of broad chamfers under it, a waist that is the widest part
 * a third of the way up, and an undercut foot, so it LIES on the ground
 * instead of growing out of it (small-rocks/design-sheet.png, first column).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - top: a hexagon over half the width, pushed toward the back-left and
 *    tipped a few degrees to the front-left;
 *  - six chamfers, 44–50° — the one on the front-left lies flatter and takes
 *    the cream, the broad one on the front-right is the big slate facet;
 *  - seven waist planes leaning in 7–10°, staggered against the chamfers;
 *  - five shallow tuck planes from the waist down to the buried rim: a
 *    narrow band, so the pebble lies ON the ground without a dark undercut.
 * Authored plane by plane, like the R01 boulder: at 80 triangles every face
 * is on show, and a rolled mound puts half of them in the wrong place.
 *
 * Variants turn the whole plane pattern inside the footprint (the box is
 * then filled again, so the outline really changes), draw every plane again,
 * move and tip the top, change how much chamfer there is (a flat river stone
 * … a rounder cobble), drop a chamfer for one sharper corner, and mirror
 * every odd seed.
 */

const ID = 's01-pebble';
const SIZE = { x: 0.3, y: 0.16, z: 0.24 };
// The lab measures the height WITH the skirt (8 % band): 2 cm of burial
// leaves the stone 15 cm above ground. The underside is closed.
const SKIRT = 0.02;
const RX = 0.15;
const RZ = 0.12;
const H = 0.16;

// [compass (0 = back, 90 = right, 180 = front), reach as a fraction of the
// footprint ellipse, lean in from vertical (negative = an undercut), height
// of the point the plane passes through as a fraction of the stone's].
type Plane = readonly [number, number, number, number];
// The flank band: nearly upright, from the foot to the chamfers.
const WAIST: readonly Plane[] = [
  [176, 1.0, 9, 0.3],
  [127, 0.97, 7, 0.3],
  [80, 1.0, 10, 0.3],
  [28, 0.95, 8, 0.3],
  [334, 1.0, 9, 0.3],
  [283, 0.98, 7, 0.3],
  [229, 0.94, 10, 0.3],
];
const CHAMFER: readonly Plane[] = [
  [150, 0.97, 42, 0.6],
  [96, 1.0, 40, 0.6],
  [40, 0.96, 44, 0.6],
  [348, 1.0, 42, 0.6],
  [292, 0.97, 40, 0.6],
  // The cream one: flatter, and only the upper half of the band.
  [222, 0.8, 55, 0.8],
];
// A shallow tuck under the waist, so the pebble lies ON the ground: a
// narrow band, not a dark undercut.
const FOOT: readonly Plane[] = [
  [205, 1.0, -22, 0.16],
  [135, 0.98, -24, 0.16],
  [62, 1.0, -22, 0.16],
  [350, 0.97, -24, 0.16],
  [276, 1.0, -24, 0.16],
];

function build(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const mirror = seed % 2 ? -1 : 1;
  // The pattern is turned inside the footprint, not the stone as a whole:
  // the planes then meet a different part of the ellipse.
  const turn = v.range(0, 0, 360);
  const compass = (az: number): number => mirror * (az + turn);
  const rho = (az: number): number => (RX * RZ) / Math.hypot(RZ * Math.sin(az * DEG), RX * Math.cos(az * DEG));

  const rock = Polytope.block(H * 1.5, SKIRT);
  // One plane by compass, through the point `reach` out at height y. Like
  // `Polytope.wall`, but the lean may be negative.
  const carve = (az: number, k: number, lean: number, y: number, tag: string): void => {
    const a = az * DEG;
    const e = lean * DEG;
    const r = rho(az) * k;
    try {
      rock.cut([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)], [Math.sin(a) * r, y, Math.cos(a) * r], tag);
    } catch {
      /* a plane that would remove the stone: leave it out */
    }
  };

  // The seed moves the two band lines: a flat river stone … a rounder cobble.
  const waist = v.num(0, 0.05);
  const band = v.num(0, 0.08);
  const vw = v.fork('waist');
  for (const [az, k, lean, y] of WAIST) carve(compass(az + vw.num(0, 9)), k * vw.num(1, 0.06), lean + vw.num(0, 4), H * (y + waist), 'flank');
  const vf = v.fork('foot');
  for (const [az, k, lean, y] of FOOT) carve(compass(az + vf.num(0, 10)), k * vf.num(1, 0.04), lean + vf.num(0, 6), H * (y + waist), 'flank');
  const vc = v.fork('chamfer');
  // One chamfer left out = one corner where the flank runs up to the top.
  const skip = vc.int(-1, -1, CHAMFER.length - 1);
  CHAMFER.forEach(([az, k, lean, y], i) => {
    if (i === skip) return;
    carve(compass(az + vc.num(0, 10)), k * vc.num(1, 0.05), lean + vc.num(0, 6), H * (y + band), 'flank');
  });
  // The top: off centre, tipped a little.
  const vt = v.fork('top');
  const tilt = vt.num(5, 5) * DEG;
  const toward = compass(vt.range(212, 0, 360)) * DEG;
  rock.cut(
    [Math.sin(toward) * Math.sin(tilt), Math.cos(tilt), Math.cos(toward) * Math.sin(tilt)],
    [mirror * vt.num(-0.02, 0.03), H, vt.num(0.015, 0.025)],
    'top',
  );

  const m = new SolidMesh();
  // The flattest chamfer joins the cream; the rest stay in the flank tones,
  // only paler (a ring of rim tone round the top is a cut gem's bevel).
  // On top of the variant's mood the seeds cycle the flank cast — lavender
  // (the sheet), slate, mauve — so neighbours in a scatter differ in colour
  // as well as in outline, all inside the stone palette.
  const cast = [{}, { side: tones.alt, warm: tones.side }, { side: tones.warm, alt: tones.side }][Math.abs(seed) % 3];
  const soft = { low: mixOklab(tones.side, tones.low, 0.55), crevice: mixOklab(tones.side, tones.crevice, 0.8) };
  const shade = stonePaint(tones, { seed, height: H, topAbove: 0.8, rimAbove: 0.6, tones: { ...soft, ...cast } });
  // Closed underneath: the budget allows it here, and a pebble is the one
  // most likely to end up tipped on a kerb or a root.
  rock.emit(m, shade);
  fitSize(m, v.size(SIZE, 0.12, 0.1));
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Pebble',
  category: 'small-rock',
  size: SIZE,
  variants: 4,
  build,
  triBudget: 80,
  reference: {
    sheet: 'design-documents/environment-design-pack/small-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/small-rocks/s01-pebble-brief.txt',
  },
};

export default asset;
