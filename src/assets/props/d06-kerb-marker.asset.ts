import { SolidMesh, jitterColor, mix, paint, rng, roundedBox } from '../../gfx/solid';
import type { RGB } from '../../gfx/solid';
import { BUILDING, STONE } from '../palette';
import type { PropAsset } from '../types';
import { TRACK } from './dressing-track-parts';

/**
 * Apex marker: a short run of the village's cream kerb stones standing a
 * little proud of the road edge, every other stone with its crown painted.
 * 1.6 m long with half a joint at each end, so a chain of them laid end to
 * end follows any corner the road makes and the joints stay even. The
 * stones are separate chunky blocks with real gaps between them (the ground
 * and its contact shadow show through), each a touch different in size and
 * tint. Scheme = paint colour; seeds change how the run is cut into stones.
 */

const LENGTH = 1.6;
const WIDTH = 0.46;
const HEIGHT = 0.2;
const SKIRT = 0.05;
const JOINT = 0.024;
const ROUND = 0.062;

/** Relative stone lengths along the run. */
const CUTS: number[][] = [
  [1, 1, 1, 1],
  [1.3, 1, 1.3],
  [1.2, 0.8, 1.2, 0.8],
  [1, 1.45, 1],
];
/** The design's own irregularities (seed 0): height and width trimmed off
 * each stone, and how far its cream leans to the warm stone colour. */
const HERO_TRIM: [number, number, number][] = [
  [0, 0.004, 0.1],
  [0.014, 0.022, 0.45],
  [0.004, 0.01, 0.2],
  [0.01, 0.028, 0.6],
];

function build(seed: number, scheme?: string): SolidMesh {
  const r = rng(seed, 'kerb-marker');
  const hero = seed === 0;
  const base = scheme === 'teal' ? TRACK.teal : BUILDING.coral;
  const accent: RGB = hero ? base : jitterColor(r, base, { hue: 4, lightness: 0.03 });
  const cuts = CUTS[seed % CUTS.length];
  const total = cuts.reduce((a, b) => a + b, 0);
  const run = LENGTH - cuts.length * JOINT;
  const ACCENT = paint(accent, { gloss: 0.5 });

  const m = new SolidMesh();
  let x = -LENGTH / 2 + JOINT / 2;
  cuts.forEach((cut, i) => {
    const len = (run * cut) / total;
    const [dh, dw, warm] = hero ? HERO_TRIM[i] : [r.range(0, 0.02), r.range(0, 0.035), r.range(0, 0.6)];
    const h = HEIGHT - dh;
    const w = WIDTH - dw;
    const STONE_P = paint(mix(BUILDING.cream, STONE.upperFace, warm), { gloss: 0.25 });
    const s = m.mark();
    roundedBox(m, { min: [-len / 2, -SKIRT, -w / 2], max: [len / 2, h, w / 2], radius: ROUND, segments: 2, faces: { ny: null } }, STONE_P);
    if (i % 2 === 0) {
      // Kerb paint on the crown: the flat top and the upper half of the
      // rounding, so the colour edge follows a ring of faces all round.
      m.repaint((c) => (c.y > h - ROUND * 0.5 ? ACCENT : undefined), s);
    }
    // Cut stone is wider at its bed than at its crown.
    m.displace((p) => {
      const t = Math.max(0, p.y) / h;
      return [p.x * (1 - 0.05 * t), p.y, p.z * (1 - 0.1 * t)];
    }, s);
    if (!hero) m.rotate('y', r.range(-1.6, 1.6), s);
    m.translate([x + len / 2, 0, hero ? 0 : r.range(-0.008, 0.008)], s);
    x += len + JOINT;
  });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd06-kerb-marker',
  name: 'Painted apex kerb stones',
  category: 'dressing',
  size: { x: LENGTH - JOINT, y: HEIGHT + SKIRT, z: WIDTH },
  variants: 4,
  schemes: ['coral', 'teal'],
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  // Low enough to drive over: a bump, not a wall.
  colliders: () => [{ shape: 'box', center: [0, 0.09, 0], half: [LENGTH / 2 - 0.03, 0.09, WIDTH / 2 - 0.04] }],
  build,
};

export default asset;
