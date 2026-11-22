import { DEG, SolidMesh, mixOklab } from '../../gfx/solid';
import type { PropAsset } from '../types';
import { Polytope, fitSize, stonePaint, stoneTones, variant } from './nature';
import type { StoneTones } from './nature';

/**
 * S05 BROKEN CHUNK — ONE squat, lopsided boulder that has split: a diagonal
 * crack runs from its right shoulder down to the ground at the middle of the
 * front, and the second lobe in front of it sits flush with the main body,
 * same stone, same facets, only a narrow dark line between them
 * (small-rocks/design-sheet.png, fifth column).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - plan: an irregular octagon, about 1.3 : 1;
 *  - flanks: eight walls leaning in 6–10° up to about 55 % of the height;
 *  - the chamfer tier: six planes at 35–50° between 55 % and 85 %, the one
 *    on the right shoulder lowest, so the top falls toward the lobe;
 *  - the cream top: about 40 % of the plan, pushed to the back-left, tipped
 *    a few degrees to the front-left;
 *  - the crack: ONE plane cuts the whole stone in two. It stands on a chord
 *    across the front-right of the footprint and leans out over that corner
 *    as it rises, so on the front it climbs from the ground at the middle to
 *    the right shoulder, and the main body overhangs the lobe (seen from
 *    above, the crack is the arc where the plane leaves the surface). The
 *    two halves are the same solid cut a groove's width apart — the
 *    lobe's flanks and chamfers ARE the main body's, carried across the
 *    crack — and the groove has constant width;
 *  - the lobe's two ends, where the crack plane runs out along the ground,
 *    are clipped square so they end in a face, not a knife.
 *
 * Variants: the stone's plane pattern is turned inside the footprint and
 * every plane drawn again, the top moved and tipped, the crack swung round
 * the stone and moved in or out (a lobe of a fifth … half the stone), its
 * lean and the groove width redrawn — odd seeds are mirrored.
 */

const ID = 's05-broken-chunk';
const SIZE = { x: 0.65, y: 0.5, z: 0.5 };
// The lab measures the height WITH the skirt (8 % band): 5.5 cm of burial
// leaves the stone 47.5 cm above ground.
const SKIRT = 0.055;
const H = 0.5;
const RX = 0.325;
const RZ = 0.25;

// [compass (0 = back, 90 = right, 180 = front), reach as a fraction of the
// footprint ellipse, lean in from vertical, height of the point the plane
// passes through as a fraction of H].
type Plane = readonly [number, number, number, number];
const WALLS: readonly Plane[] = [
  [352, 1.0, 11, 0.2],
  [40, 0.97, 10, 0.2],
  [88, 1.0, 9, 0.2],
  [133, 1.0, 12, 0.2],
  [178, 0.98, 10, 0.2],
  [222, 1.0, 11, 0.2],
  [266, 0.98, 9, 0.2],
  [310, 1.0, 12, 0.2],
];
// The chamfer tier: broad planes from about 55 % of the height, so the
// stone reads squat and rounded-shouldered rather than a block with a lid.
const CHAMFERS: readonly Plane[] = [
  [8, 0.94, 46, 0.78],
  [66, 0.94, 42, 0.72],
  // the right shoulder: lower, so the top falls toward the lobe
  [124, 0.92, 32, 0.5],
  [172, 0.92, 42, 0.6],
  [222, 0.92, 46, 0.64],
  [292, 0.96, 44, 0.76],
];

function build(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const mirror = seed % 2 ? -1 : 1;
  const turn = v.range(0, -40, 40);
  const rho = (az: number): number => (RX * RZ) / Math.hypot(RZ * Math.sin(az * DEG), RX * Math.cos(az * DEG));
  const dir = (az: number, lift: number): [number, number, number] => {
    const a = mirror * az * DEG;
    const e = lift * DEG;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
  };
  const at = (az: number, reach: number, y: number): [number, number, number] => [Math.sin(mirror * az * DEG) * reach, y, Math.cos(mirror * az * DEG) * reach];

  const rock = Polytope.block(H * 1.5, SKIRT);
  const carve = (az: number, k: number, lean: number, y: number, tag: string): void => {
    try {
      rock.cut(dir(az, lean), at(az, rho(az) * k, y), tag);
    } catch {
      /* a plane that would remove the stone: leave it out */
    }
  };
  const vw = v.fork('walls');
  for (const [az, k, lean, y] of WALLS) carve(az + turn + vw.num(0, 8), k * vw.num(1, 0.05), lean + vw.num(0, 3), H * y, 'flank');
  const vc = v.fork('chamfers');
  for (const [az, k, lean, y] of CHAMFERS) carve(az + turn + vc.num(0, 10), k * vc.num(1, 0.05), lean + vc.num(0, 5), H * (y + vc.num(0, 0.05)), 'flank');
  const vt = v.fork('top');
  // Through a point back-left of the middle, tipped toward the front-left.
  rock.cut(dir(vt.num(205, 30), 90 - vt.num(15, 4)), [mirror * vt.num(-0.08, 0.03), H * 0.9, vt.num(0.07, 0.03)], 'top');

  // The crack: chord at `reach` from the centre toward compass `az` (on the
  // ground), the plane leaning out over the lobe by `over`.
  const vk = v.fork('crack');
  const az = vk.num(132, 22);
  const reach = vk.num(0.115, 0.035);
  const over = vk.num(13, 4);
  const gap = vk.num(0.018, 0.004);
  const n = dir(az, -over);
  const base = at(az, reach, 0);
  const off = (d: number): [number, number, number] => [base[0] + n[0] * d, base[1] + n[1] * d, base[2] + n[2] * d];
  const pieces: Polytope[] = [];
  try {
    const main = rock.clone().cut(n, off(-gap / 2), 'groove');
    const lobe = rock.clone().cut([-n[0], -n[1], -n[2]], off(gap / 2), 'groove');
    // Its two ends, where the crack runs out along the ground: clipped
    // square to the chord, so the lobe ends in a face instead of a fin.
    const end = vk.num(0.035, 0.01);
    for (const s of [-1, 1]) {
      const along = dir(az + 90 * s, 0);
      const tip = lobe.surface(off(gap), along);
      lobe.cut(along, [tip.x - along[0] * end, 0, tip.z - along[2] * end], 'flank');
    }
    pieces.push(main, lobe);
  } catch {
    pieces.length = 0;
    pieces.push(rock);
  }

  const m = new SolidMesh();
  // On top of the variant's mood the seeds cycle the flank cast — lavender
  // (the sheet), slate, mauve. Both halves take the SAME one: one stone.
  const casts: Partial<StoneTones>[] = [{}, { side: tones.alt, warm: tones.side }, { side: tones.warm, alt: tones.side }];
  const soft = softShade(tones);
  const shade = stonePaint(tones, { seed, height: H, topAbove: 0.8, rimAbove: 0.6, tones: { ...soft, ...casts[Math.abs(seed) % 3] } });
  for (const p of pieces) p.emit(m, shade);
  fitSize(m, v.size(SIZE, 0.12, 0.08));
  return m;
}

/** The foot and crevice tones a step lighter than the family default: at
 * 50 cm the small rocks are all foot, and the shader's shade side already
 * takes them to violet (the sheet's darkest stone is #626195). */
function softShade(t: StoneTones): Partial<StoneTones> {
  return { low: mixOklab(t.side, t.low, 0.55), crevice: mixOklab(t.side, t.crevice, 0.8) };
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Broken Chunk',
  category: 'small-rock',
  size: SIZE,
  variants: 4,
  build,
  triBudget: 80,
  reference: {
    sheet: 'design-documents/environment-design-pack/small-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/small-rocks/s05-broken-chunk-brief.txt',
  },
};

export default asset;
