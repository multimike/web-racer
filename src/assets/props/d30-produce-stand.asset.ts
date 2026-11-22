import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, jitterColor, mix, paint, quadFacing, rng } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FOLIAGE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { FRUIT, WOOD, crateCorners, fruit, leaf, slat } from './dressing-village-parts';

/**
 * The market stall's produce display, as it stands in front of the shop in
 * both vision images: a slatted timber base with a two-bay display tray
 * propped on it, tilted toward the street (−z) and packed with small glossy
 * toy fruit — apples in one bay, oranges in the other, a sprig of leaves
 * behind.
 *
 * Seeds change what is in the trays (apples / oranges / lemons / green
 * apples), which side is which, and the timber tone.
 */

const W = 1.66;
const D = 0.78;
const BASE_H = 0.46;
const TILT = 21;
const TRAY_D = 0.66;
const TRAY_WALL = 0.17;
const SLAT_T = 0.035;
const POST = 0.09;
const TRAY_W = W - 0.1;
const TRAY_T = 0.04;
const DIVIDER = 0.05;
// Clear width of one bay.
const BAY_W = (TRAY_W - 2 * TRAY_T - DIVIDER) / 2;
// Height of the dark bed the fruit lie on, inside the tray.
const BED_Y = TRAY_WALL - 0.03;
// Top of the trays' raised back edge.
const TOP = BASE_H + Math.sin((TILT * Math.PI) / 180) * TRAY_D + Math.cos((TILT * Math.PI) / 180) * TRAY_WALL;

/**
 * Two display bays in one long tray: outer walls, the rim, and the inner
 * walls down to just under the fruit bed. No floor and no underside — the
 * bed quads close it from above, the wedge and the base from below.
 * Local frame: x centred, y 0 … TRAY_WALL, z 0 (front) … TRAY_D.
 */
function doubleTray(m: SolidMesh, outer: Paint, inner: Paint): void {
  const hx = TRAY_W / 2;
  const P = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  const top = TRAY_WALL;
  // Outer walls.
  quadFacing(m, P(-hx, 0, 0), P(hx, 0, 0), P(hx, top, 0), P(-hx, top, 0), P(0, 0, -1), outer);
  quadFacing(m, P(-hx, 0, TRAY_D), P(hx, 0, TRAY_D), P(hx, top, TRAY_D), P(-hx, top, TRAY_D), P(0, 0, 1), outer);
  for (const sx of [-1, 1]) quadFacing(m, P(sx * hx, 0, 0), P(sx * hx, 0, TRAY_D), P(sx * hx, top, TRAY_D), P(sx * hx, top, 0), P(sx, 0, 0), outer);
  // Rim: front and back strips the full width, then the two ends and the
  // divider between them.
  const up = P(0, 1, 0);
  const z0 = TRAY_T;
  const z1 = TRAY_D - TRAY_T;
  quadFacing(m, P(-hx, top, 0), P(hx, top, 0), P(hx, top, z0), P(-hx, top, z0), up, outer);
  quadFacing(m, P(-hx, top, z1), P(hx, top, z1), P(hx, top, TRAY_D), P(-hx, top, TRAY_D), up, outer);
  const strips: [number, number][] = [
    [-hx, -hx + TRAY_T],
    [-DIVIDER / 2, DIVIDER / 2],
    [hx - TRAY_T, hx],
  ];
  for (const [a, b] of strips) quadFacing(m, P(a, top, z0), P(b, top, z0), P(b, top, z1), P(a, top, z1), up, outer);
  // Inner walls of the two bays.
  const low = BED_Y - 0.01;
  for (const sx of [-1, 1]) {
    const a = sx * (DIVIDER / 2);
    const b = sx * (hx - TRAY_T);
    quadFacing(m, P(a, low, z0), P(b, low, z0), P(b, top, z0), P(a, top, z0), P(0, 0, 1), inner);
    quadFacing(m, P(a, low, z1), P(b, low, z1), P(b, top, z1), P(a, top, z1), P(0, 0, -1), inner);
    quadFacing(m, P(a, low, z0), P(a, low, z1), P(a, top, z1), P(a, top, z0), P(sx, 0, 0), inner);
    quadFacing(m, P(b, low, z0), P(b, low, z1), P(b, top, z1), P(b, top, z0), P(-sx, 0, 0), inner);
  }
}

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd30-produce-stand');
  const hero = seed === 0;
  const wood: RGB = hero ? WOOD.pale : jitterColor(r, r.pick([WOOD.pale, WOOD.plank]), { hue: 4, lightness: 0.04 });
  const SLAT = [paint(wood, { gloss: 0.2 }), paint(mix(wood, WOOD.plank, 0.45), { gloss: 0.2 })];
  const POSTP = paint(mix(wood, WOOD.post, 0.7), { gloss: 0.25 });
  const INSIDE = paint(mix(wood, WOOD.dark, 0.75), { gloss: 0.05 });
  const TRAY = paint(mix(wood, WOOD.plank, 0.7), { gloss: 0.22 });
  const m = new SolidMesh();

  // Base: a closed dark core behind two slats on the front and on each
  // side, corner posts standing proud. The back is the core alone — it
  // stands against the shop wall.
  const hx = W / 2 - SLAT_T * 0.6;
  const hz = D / 2 - SLAT_T * 0.6;
  box(m, { min: [-hx, -0.05, -hz], max: [hx, BASE_H - 0.004, hz], faces: { ny: null } }, INSIDE);
  crateCorners(m, W / 2 + 0.012, D / 2 + 0.012, POST, -0.05, BASE_H + 0.015, POSTP);
  const gap = 0.055;
  const slatH = (BASE_H - 0.05 - gap * 2) / 2;
  for (let k = 0; k < 2; k++) {
    const y = 0.05 + gap * 0.6 + slatH / 2 + k * (slatH + gap);
    const inset = POST * 0.5;
    slat(m, new Vector3(-W / 2 + inset, y, -D / 2 + SLAT_T), new Vector3(W / 2 - inset, y, -D / 2 + SLAT_T), slatH, SLAT_T, new Vector3(0, 0, -1), SLAT[k % 2]);
    for (const sx of [-1, 1]) {
      slat(m, new Vector3(sx * (W / 2 - SLAT_T), y, -D / 2 + inset), new Vector3(sx * (W / 2 - SLAT_T), y, D / 2 - inset), slatH, SLAT_T, new Vector3(sx, 0, 0), SLAT[(k + 1) % 2]);
    }
  }
  // Wedge under the tilted trays, standing 2 cm INTO their hollow underside
  // so there is no daylight between the two from any side. Only its ends and
  // back can be seen: the rest is buried in the base and the trays.
  const tan = Math.tan((TILT * Math.PI) / 180);
  const run = Math.cos((TILT * Math.PI) / 180) * TRAY_D;
  const zFront = -D / 2 + 0.05;
  const trayY = BASE_H - 0.012;
  const wz0 = zFront + 0.03;
  const wz1 = zFront + run - 0.01;
  const wx = TRAY_W / 2 - 0.01;
  const wy = (z: number): number => trayY + (z - zFront) * tan + 0.02;
  for (const sx of [-1, 1]) {
    quadFacing(m, new Vector3(sx * wx, BASE_H - 0.03, wz0), new Vector3(sx * wx, BASE_H - 0.03, wz1), new Vector3(sx * wx, wy(wz1), wz1), new Vector3(sx * wx, wy(wz0), wz0), new Vector3(sx, 0, 0), POSTP);
  }
  quadFacing(m, new Vector3(-wx, BASE_H - 0.03, wz1), new Vector3(wx, BASE_H - 0.03, wz1), new Vector3(wx, wy(wz1), wz1), new Vector3(-wx, wy(wz1), wz1), new Vector3(0, 0, 1), POSTP);

  // The trays: one long box with a divider. Built flat with the front bottom
  // edge on the origin, filled, then tipped about that edge onto the wedge.
  const s = m.mark();
  doubleTray(m, TRAY, INSIDE);

  const sets: RGB[][] = [
    [FRUIT.apple, FRUIT.apple, mix(FRUIT.apple, [0.75, 0.1, 0.15], 0.4)],
    [FRUIT.orange, FRUIT.orange, mix(FRUIT.orange, FRUIT.lemon, 0.4)],
    [FRUIT.lemon, FRUIT.lemon, mix(FRUIT.lemon, FRUIT.greenApple, 0.4)],
    [FRUIT.greenApple, FRUIT.greenApple, mix(FRUIT.greenApple, FRUIT.lemon, 0.3)],
  ];
  const left = hero ? 0 : r.int(0, 3);
  const right = hero ? 1 : (left + r.int(1, 3)) % 4;
  let sprig = false;
  [left, right].forEach((kind, side) => {
    const sx = side === 0 ? -1 : 1;
    const cx = sx * (BAY_W / 2 + DIVIDER / 2);
    // Dark bed just under the fruit: what shows between them reads as shade.
    const bed = paint(mix(sets[kind][0], [0.2, 0.08, 0.08], 0.65), { gloss: 0.1 });
    const up = new Vector3(0, 1, 0);
    quadFacing(m, new Vector3(cx - BAY_W / 2, BED_Y, TRAY_T), new Vector3(cx + BAY_W / 2, BED_Y, TRAY_T), new Vector3(cx + BAY_W / 2, BED_Y, TRAY_D - TRAY_T), new Vector3(cx - BAY_W / 2, BED_Y, TRAY_D - TRAY_T), up, bed);
    // Small toy fruit packed like oranges in a box: rows of four and three,
    // each in the next row's hollows. The packed layer is six-triangle caps
    // set so close that they run into each other well above their rims —
    // what shows is a field of round tops, the pack hiding every flank (a
    // whole fruit each would cost three times as much and show no more).
    // Two whole fruit ride on top.
    const pitch = BAY_W / 4;
    const fr = pitch / 1.4;
    const depth = TRAY_D - 2 * TRAY_T;
    const rows = 4;
    // The caps' rims stay inside the tray walls.
    const edge = fr - TRAY_T + 0.006;
    const rowZ = (j: number): number => TRAY_T + edge + ((depth - 2 * edge) * j) / (rows - 1);
    const tone = (): RGB => jitterColor(r, r.weighted(sets[kind], [5, 4, 2]), { hue: 4, lightness: 0.03 });
    for (let j = 0; j < rows; j++) {
      const n = j % 2 ? 3 : 4;
      for (let i = 0; i < n; i++) {
        // The heap crowns a little toward the back.
        const y = BED_Y - fr * 0.4 + j * 0.006 + (hero ? 0 : r.range(-0.004, 0.006));
        fruit(m, [cx + (i - (n - 1) / 2) * pitch, y, rowZ(j)], { radius: fr * (hero ? 1 : r.range(0.97, 1.03)), color: tone(), yaw: r.range(0, 360), sides: n === 4 ? 6 : 5 });
      }
    }
    // The riders sit in hollows of the layer (between a fruit of one row and
    // the two behind it); bay and seed decide which.
    const hollows: [number, number][] = [
      [-1, 0.5],
      [0.5, 1.5],
      [1, 0.5],
      [-0.5, 1.5],
      [0, 2.5],
    ];
    const first = hero ? side * 2 : r.int(0, hollows.length - 1);
    for (let k = 0; k < 2; k++) {
      const [hx, hj] = hollows[(first + k) % hollows.length];
      fruit(m, [cx + hx * pitch, BED_Y + fr * 0.27 + hj * 0.006, rowZ(hj)], { radius: fr * 0.8, color: tone(), yaw: r.range(0, 360), sides: 5, full: true });
    }
    // Leaf sprig behind the citrus, as in the vision.
    if ((kind === 1 || kind === 2) && !sprig) {
      sprig = true;
      const GREEN = mix(FOLIAGE.lime, FRUIT.leaf, 0.5);
      const root = new Vector3(cx + 0.02, BED_Y + 0.03, TRAY_D - TRAY_T - 0.03);
      leaf(m, root, root.add(new Vector3(-0.2, 0.24, 0.05)), 0.17, GREEN);
      leaf(m, root, root.add(new Vector3(0.19, 0.22, 0.03)), 0.17, mix(GREEN, FOLIAGE.jade, 0.25));
    }
  });
  m.rotate('x', -TILT, s, [0, 0, 0]);
  m.translate([0, trayY, zFront], s);
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'box', center: [0, TOP / 2, 0], half: [W / 2, TOP / 2, D / 2] }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd30-produce-stand',
  name: 'Produce stand',
  category: 'dressing',
  // y: up to the tips of the leaf sprig, plus the 5 cm skirt.
  size: { x: W + 0.024, y: 1.11, z: D + 0.024 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-elevated-camera.png' },
};

export default asset;
