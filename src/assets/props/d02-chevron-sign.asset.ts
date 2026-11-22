import { SolidMesh, box, extrudePolygon, frustum, jitterColor, mix, paint, rng, roundedBox, roundedRectRing, sphere } from '../../gfx/solid';
import type { Vec2 } from '../../gfx/solid';
import { BUILDING, STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { IRON, LAMP, TRACK } from './dressing-track-parts';

/**
 * Corner board from the vision: yellow chevrons on a navy face inside a
 * bright cobalt frame, standing on two short iron legs — about two thirds of
 * a car long and hip high. The navy face and the chevrons are thin raised
 * plates. The back is the same frame round a bare slate panel, with the two
 * legs and two rails the board is bolted to. Scheme = which way the arrows
 * point, as read from the front (−z, the side that faces oncoming cars).
 */

const BOARD_H = 0.82;
const BOARD_T = 0.14;
const FRAME = 0.065; // visible width of the cobalt frame
const PROUD = 0.008; // each plate over the one behind it
const SKIRT = 0.05;
/** The legs go deeper than the feet, so a leaning sign keeps both in the ground. */
const LEG_SKIRT = 0.1;

interface Layout {
  width: number;
  count: number;
  /** Underside of the board above the ground. */
  boardY: number;
  /** Chevron stroke width, depth of the V, pitch between chevrons. */
  stroke: number;
  vee: number;
  pitch: number;
  lamps: boolean;
}

function layout(seed: number): Layout {
  switch (seed % 4) {
    case 1: return { width: 2.2, count: 3, boardY: 0.42, stroke: 0.22, vee: 0.27, pitch: 0.63, lamps: true };
    case 2: return { width: 1.56, count: 2, boardY: 0.3, stroke: 0.23, vee: 0.28, pitch: 0.66, lamps: false };
    case 3: return { width: 2.7, count: 4, boardY: 0.3, stroke: 0.21, vee: 0.26, pitch: 0.61, lamps: true };
    default: return { width: 2.2, count: 3, boardY: 0.3, stroke: 0.22, vee: 0.27, pitch: 0.63, lamps: false };
  }
}

/** One "<" as seen from the front, centred on the origin. */
function chevron(L: Layout, dir: 1 | -1): Vec2[] {
  const hh = BOARD_H / 2 - FRAME - 0.07;
  const w = L.vee + L.stroke;
  const x0 = -w / 2;
  const pts: Vec2[] = [
    [x0, 0],
    [x0 + L.vee, hh],
    [x0 + w, hh],
    [x0 + L.stroke, 0],
    [x0 + w, -hh],
    [x0 + L.vee, -hh],
  ];
  return dir === 1 ? pts : pts.map(([x, y]) => [-x, y] as const);
}

function build(seed: number, scheme?: string): SolidMesh {
  const r = rng(seed, 'chevron-sign');
  const hero = seed === 0;
  const L = layout(seed);
  const dir: 1 | -1 = scheme === 'right' ? -1 : 1;
  const frame = hero ? BUILDING.cobalt : jitterColor(r, r.pick([BUILDING.cobalt, BUILDING.cobalt, BUILDING.turquoise]), { hue: 4, lightness: 0.03 });

  const FRAME_P = paint(frame, { gloss: 0.6 });
  const NAVY = paint(TRACK.navy, { gloss: 0.35 });
  const ARROW = paint(TRACK.chevron, { gloss: 0.55 });
  // Unpainted sheet on the back: light enough to read as a surface in shade.
  const BACK = paint(mix(STONE.base, BUILDING.cream, 0.25), { gloss: 0.2 });

  const m = new SolidMesh();
  const cy = L.boardY + BOARD_H / 2;
  const top = L.boardY + BOARD_H;
  const zf = -BOARD_T / 2;
  const zb = BOARD_T / 2;

  // Frame, the navy face a step proud of it, the chevrons a step proud of
  // that: every colour edge is a real step, so nothing is coplanar and each
  // edge catches a highlight.
  roundedBox(m, { size: [L.width, BOARD_H, BOARD_T], radius: 0.05, segments: 2, at: [0, cy, 0] }, FRAME_P);
  const face = roundedRectRing(L.width - FRAME * 2, BOARD_H - FRAME * 2, 0.04, 2);
  extrudePolygon(m, { outline: face, depth: PROUD + 0.004, back: false, facing: '-z', at: [0, cy, zf + 0.004] }, NAVY);
  extrudePolygon(m, { outline: face, depth: PROUD + 0.004, back: false, facing: '+z', at: [0, cy, zb - 0.004] }, BACK);
  const first = -((L.count - 1) * L.pitch) / 2;
  for (let i = 0; i < L.count; i++) {
    extrudePolygon(m, { outline: chevron(L, dir), depth: 0.014, back: false, facing: '-z', at: [first + i * L.pitch, cy, zf - PROUD] }, ARROW);
  }

  // Back: two rails across the panel, and the legs over them.
  const lx = L.width / 2 - 0.36;
  const legZ0 = zb - 0.02;
  const legZ1 = zb + 0.085;
  for (const f of [0.27, 0.73]) {
    const y = L.boardY + BOARD_H * f;
    box(m, { min: [-lx - 0.17, y - 0.04, zb], max: [lx + 0.17, y + 0.04, zb + 0.045], faces: { nz: null } }, IRON);
  }
  for (const sx of [-1, 1]) {
    box(m, { min: [sx * lx - 0.055, -LEG_SKIRT, legZ0], max: [sx * lx + 0.055, top - 0.1, legZ1], faces: { ny: null } }, IRON);
  }

  if (L.lamps) {
    // Night marker lamps on the top edge.
    for (const sx of [-1, 1]) {
      sphere(m, { radius: 0.075, segments: 6, rings: 3, latitude: [0, 90], caps: false, at: [sx * (L.width / 2 - 0.26), top - 0.012, 0] }, LAMP);
    }
  }

  let lean = 0;
  let tip = 0;
  if (!hero) {
    // One foot has sunk: the whole sign leans along its length and tips a
    // little back.
    lean = r.range(1, 2.4) * r.sign();
    tip = r.range(-0.5, 3);
    m.rotate('z', lean, 0, [0, 0, 0]);
    m.rotate('x', tip, 0, [0, 0, 0]);
  }
  // Feet go on AFTER the lean, flat on the ground under each leg: a pad
  // across the board's thickness, sunk a little.
  const legZ = (legZ0 + legZ1) / 2;
  for (const sx of [-1, 1]) {
    const s = m.mark();
    frustum(m, { radiusBottom: 0.5 * Math.SQRT2, radiusTop: 0.34 * Math.SQRT2, from: [0, -SKIRT, 0], to: [0, 0.09, 0], sides: 4, round: false, arcStart: 45, caps: 'top' }, IRON);
    m.scale([0.25, 1, 0.58], s);
    // Where the leaning leg's centre line meets the ground.
    const x = sx * lx * Math.cos((lean * Math.PI) / 180);
    m.translate([x, 0, legZ * Math.cos((tip * Math.PI) / 180) - 0.02], s);
  }
  return m;
}

function colliders(seed: number): ColliderSpec[] {
  const L = layout(seed);
  const half = (L.boardY + BOARD_H) / 2;
  // A little deeper than the board: covers the lean of seeds ≥ 1.
  return [{ shape: 'box', center: [0, half, 0.03], half: [L.width / 2, half, 0.15] }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd02-chevron-sign',
  name: 'Chevron corner board',
  category: 'dressing',
  size: { x: 2.2, y: 0.3 + BOARD_H + LEG_SKIRT, z: 0.58 },
  variants: 4,
  schemes: ['left', 'right'],
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders,
  build,
};

export default asset;
