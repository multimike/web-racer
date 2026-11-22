import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, compose, linePath, mixOklab, paint, quadFacing, rng, rotation, roundedBox, shade, soften, translation, tube } from '../../gfx/solid';
import type { Paint, Vec3 } from '../../gfx/solid';
import { BUILDING, STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  chimney,
  cornerPosts,
  door,
  finishBuilding,
  frameRing,
  frameSegments,
  hipRoof,
  openingRing,
  pillow,
  planter,
  post,
  schemePaints,
  solarPanel,
  stoneCourse,
  toFacade,
  trimBand,
  variantPaints,
  variation,
  wallBox,
  wallLantern,
  windowUnit,
  withPaints,
} from './parts';
import type { BoxFacades, BuildingPaints, Facade, Opening } from './parts';

/**
 * B06 — Corner House. Two-storey plaster house: cream corner pilasters, an
 * inter-storey band, a thick cornice under a low cobalt hip roof with a cream
 * apex block, and a full-width balcony on three timber brackets over the
 * front door.
 *
 * SCHEME. The sheet is apricot + cobalt, which is none of the style guide's
 * three combinations; following the kit's convention it is the hero of
 * 'warm' (teal door, frames and shutters, as 'warm' defines them) with the
 * wall and roof paints overridden. 'coastal' and 'sunny' build exactly as
 * the guide defines them. The balcony railing takes the shutter colour.
 *
 * MAIN BODY 5.0 (x) × 4.0 (z) m; two 2.7 m storeys (band centred on 2.72 m),
 * walls to the brief's 5.4 m eave.
 * OVERALL 5.68 × 6.85 × 5.24 m (x ±2.84 at the cornice, z −2.90 at the
 * balcony front … +2.34, y −0.1 … 6.75) — inside the 5.8 × 5.8 m envelope.
 *
 * HEIGHT — THE SHEET'S PITCH, as on the other houses. The brief's "hip roof
 * from 5.4 to 6.5 m" is a 20° roof on this plan; the sheet's elevations draw
 * 26°, and at 20° the roof all but disappears behind the cornice from the
 * street. The eave keeps the brief's 5.4 m and the roof takes the drawn
 * pitch: apex block at 6.75 m (+4 % on the brief's total;
 * src/world/catalog.ts still lists 6.5). `ROOF_TOP` is the one number to
 * change if the brief's height must be met; the colliders follow it.
 *
 * THE DOOR STANDS ON THE GROUND, as every view of the sheet draws it: the
 * cream surround runs down through the plinth to a threshold slab, so there
 * are no steps in the street. The kit's `stonePlinth` is one closed ring;
 * the plinth here is assembled from the kit's `stoneCourse` runs between
 * four big corner stones of this file's own (the sheet draws exactly those
 * under the pilaster bases), the front left one reaching the door surround.
 *
 * Opening schedule (brief): front ground floor = door left, window right;
 * front upper floor = a full-height glazed balcony door in place of the
 * sheet's window (same width, frame and shutters); each side = one window
 * per storey; rear = two vertically aligned windows.
 *
 * Own parts (not in the shared kit): corner stones, the prouder door
 * surround, panelled shutters (the sheet's are framed panels, not the
 * boarded leaves of the cottage), the balcony railing (two chunky capped
 * posts, a fat round rail, seven square balusters — the kit's railing is a
 * finer 26 cm picket) and the balcony brackets (a square bearer and a
 * straight strut, as drawn — the kit's `bracket` is a curved console).
 * The roof stands 0.19 m in from the cornice edge, leaving the sheet's cream
 * ledge all round.
 *
 * Seeds: 0 = the sheet. The game instantiates 0 – 2, so what shows at a
 * glance cycles: 1 = chimney mid left slope (clear of the hips and the apex
 * block), a wall lantern on the pilaster beside the door, a pot by the door
 * and one on the balcony, new door colour; 2 = closed shutters, flower box,
 * solar panel on a mounting block on the right slope, two pots, another
 * door colour. Window width, apex block and wall / roof tints roll.
 * 5 136 triangles for seed 0, 5 868 / 5 828 for seeds 1 / 2.
 */

const W = 5.0;
const D = 4.0;
const PLINTH = 0.45;
const EAVE = 5.4;
const ROOF_TOP = 6.75;
const ROOF_OVERHANG = 0.15;
const ROOF_THICKNESS = 0.12;
const FINIAL_HEIGHT = 0.3;
/** Inter-storey band (centre, height) and the cornice under the eave. */
const BAND_Y = 2.72;
const BAND_H = 0.34;
const CORNICE_H = 0.36;
const CORNICE_OUT = 0.34;
const PILASTER = 0.42;
/** Balcony: top of the deck, slab thickness, width, projection (brief: 0.9). */
const DECK_TOP = 2.93;
const DECK_T = 0.37;
const DECK_W = 4.7;
const DECK_OUT = 0.9;
const RAIL_H = 0.74;
const RAIL_POST = 0.4;
/** Plan x of the two railing posts and how far their centres stand out of the wall. */
const RAIL_POST_X = 2.04;
const RAIL_POST_OUT = DECK_OUT - 0.28;
/** Balcony brackets: width along the wall, reach, drop below the deck. */
const BRACKET_W = 0.42;
const BRACKET_OUT = 0.78;
const BRACKET_DROP = 0.7;
const BRACKET_U = [-1.93, 0.02, 1.93];

const DOOR: Opening = { u: -1.0, v: 0.03, w: 1.1, h: 2.12, round: 0.16 };
const DOOR_SURROUND = 0.16;
/** Starts 3 cm below the deck so its sill never shares the deck's plane. */
const BALCONY_DOOR: Opening = { u: 0, v: DECK_TOP - 0.03, w: 1.5, h: 1.72 };

/** How far each corner stone runs along the x and the z wall, by corner
 * (sx, sz). The front left one ends inside the door surround. */
const DOOR_LEFT = DOOR.u - DOOR.w / 2 - DOOR_SURROUND;
const DOOR_RIGHT = DOOR.u + DOOR.w / 2 + DOOR_SURROUND;
const CORNER_LEGS: Record<string, readonly [number, number]> = {
  '-1,-1': [W / 2 + DOOR_LEFT + 0.015, 0.56],
  '1,-1': [0.62, 0.5],
  '-1,1': [0.5, 0.62],
  '1,1': [0.58, 0.52],
};
const STONE_PROUD = 0.12;
/** Seeded roof furniture: plan positions (x, z). */
const SOLAR: readonly [number, number] = [1.65, 0];
const CHIMNEY: readonly [number, number] = [-1.75, 0.15];
const CHIMNEY_SIZE = 0.62;
const CHIMNEY_HEIGHT = 0.85;

function choices(seed: number) {
  const v = variation(seed, 'b06');
  const pots = v.cycle([0, 1, 2] as const);
  return {
    v,
    shutters: v.cycle(['open', 'open', 'closed'] as const),
    lantern: v.cycle([false, true, false] as const),
    balconyPot: v.cycle([false, true, false] as const),
    flowerBox: v.cycle([false, false, true] as const),
    solar: v.cycle([false, false, true] as const),
    chimney: v.cycle([false, true, false] as const),
    winW: 1.12 + v.shift('winW', 0.05),
    // Ground pots, plan (x, z): between door and window, then at the right corner.
    pots: ([[0.28, -D / 2 - 0.5], [2.05, -D / 2 - 0.5]] as [number, number][]).slice(0, pots),
  };
}

/** A corner stone: one chunky block wrapping the plan corner, top planes a
 * tone lighter like the kit's masonry. */
function cornerStone(m: SolidMesh, sx: number, sz: number, top: number, p: Paint): void {
  const start = m.mark();
  const [lx, lz] = CORNER_LEGS[`${sx},${sz}`];
  // Proud enough for the pilaster base (0.12 out of the wall) to stand on
  // its flat top, inside the chamfer.
  const out = STONE_PROUD + 0.06;
  const x = [sx * (W / 2 + out), sx * (W / 2 - lx)];
  const z = [sz * (D / 2 + out), sz * (D / 2 - lz)];
  roundedBox(m, { min: [Math.min(...x), -0.1, Math.min(...z)], max: [Math.max(...x), top, Math.max(...z)], radius: 0.05, segments: 1 }, p);
  const topTone = mixOklab(p.color, STONE.upperFace, 0.26);
  m.recolor((_p, n) => (n.y > 0.4 ? topTone : undefined), start);
}

/** The plinth: corner stones, kit masonry between them, a gap for the door. */
function plinth(m: SolidMesh, F: BoxFacades, seed: number, P: BuildingPaints): void {
  const r = rng(seed, 'b06', 'plinth');
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) cornerStone(m, sx, sz, PLINTH + 0.01 + r.range(0, 0.02), r.chance(0.5) ? P.stone : P.stoneLight);
  }
  const leg = (sx: number, sz: number, axis: 0 | 1): number => CORNER_LEGS[`${sx},${sz}`][axis];
  const run = (on: Facade, u0: number, u1: number): void => stoneCourse(m, { on, u0, u1, top: PLINTH, proud: STONE_PROUD, seed }, P);
  // u runs toward +x on the front, −x on the back, +z on the right, −z on the left.
  run(F.front, DOOR_RIGHT - 0.015, W / 2 - leg(1, -1, 0));
  run(F.back, -(W / 2 - leg(1, 1, 0)), W / 2 - leg(-1, 1, 0));
  run(F.right, -(D / 2 - leg(1, -1, 1)), D / 2 - leg(1, 1, 1));
  run(F.left, -(D / 2 - leg(-1, 1, 1)), D / 2 - leg(-1, -1, 1));
  // One plate under everything: the courses have no undersides. It reaches
  // past the proudest stone (the corner blocks, and the courses' bevels) and
  // sits 4 mm below their bottoms so the two never share a plane.
  const g = STONE_PROUD + 0.1;
  const y = -0.104;
  quadFacing(m, new Vector3(-W / 2 - g, y, -D / 2 - g), new Vector3(W / 2 + g, y, -D / 2 - g), new Vector3(W / 2 + g, y, D / 2 + g), new Vector3(-W / 2 - g, y, D / 2 + g), new Vector3(0, -1, 0), P.stoneDark);
}

/**
 * The door's surround, threshold and the reveal below the wall. The wall
 * panel starts on the plinth, so under it the door bay has no jambs of its
 * own: two quads continue the reveal to the ground and a sill closes the
 * floor behind the threshold.
 */
function doorPortal(m: SolidMesh, on: Facade, P: BuildingPaints): void {
  const start = m.mark();
  const { u, v, w, h } = DOOR;
  const trim = soften(P.trim, 45);
  // Prouder than the kit's surround (0.08): it has to stand clear of the
  // plinth stones that end against it.
  // Its foot bar ends exactly on the −0.1 m skirt line.
  const foot: Opening = { u, v: DOOR_SURROUND - 0.1, w, h: h + v - DOOR_SURROUND + 0.1, round: DOOR.round };
  const segs = frameSegments((DOOR.round ?? 0) + DOOR_SURROUND);
  frameRing(m, { inner: openingRing(DOOR, -0.012, 0, segs, true), outer: openingRing(foot, DOOR_SURROUND, 0, segs, true), z0: -0.03, z1: 0.18, bevel: 0.05 }, trim);
  const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  for (const s of [1, -1]) {
    const x = u + (s * w) / 2;
    quadFacing(m, V(x, -0.1, -0.25), V(x, -0.1, 0), V(x, PLINTH - 0.08, 0), V(x, PLINTH - 0.08, -0.25), V(-s, 0, 0), P.wall);
  }
  quadFacing(m, V(u - w / 2, v - 0.01, -0.25), V(u + w / 2, v - 0.01, -0.25), V(u + w / 2, v - 0.01, 0), V(u - w / 2, v - 0.01, 0), V(0, 1, 0), P.trim);
  // Threshold slab, wider than the surround and sunk in the stones beside it.
  roundedBox(m, { min: [u - w / 2 - DOOR_SURROUND - 0.2, -0.1, 0.02], max: [u + w / 2 + DOOR_SURROUND + 0.2, 0.08, 0.46], radius: 0.05, segments: 2 }, P.trim);
  toFacade(m, start, on);
}

/**
 * One panelled shutter leaf: a stile-and-rail frame round two recessed
 * panels (the sheet's B06 shutters). Open = flat on the wall beside the
 * opening, closed = over its half of it.
 */
function panelShutter(m: SolidMesh, o: { on: Facade; opening: Opening; side: 1 | -1; state: 'open' | 'closed' }, p: Paint): void {
  const start = m.mark();
  const { u, v, w, h } = o.opening;
  const leaf = w / 2 - 0.01;
  const closed = o.state === 'closed';
  const hinge = u + o.side * (w / 2 + 0.04);
  const x0 = closed ? (o.side < 0 ? u - w / 2 - 0.02 : u + 0.005) : o.side < 0 ? hinge - leaf : hinge;
  const x1 = closed ? (o.side < 0 ? u - 0.005 : u + w / 2 + 0.02) : x0 + leaf;
  const y0 = v + 0.06;
  const y1 = v + h + 0.012;
  const stile = 0.095;
  const rect = (g: number): [number, number][] => [[x1 - g, y1 - g], [x0 + g, y1 - g], [x0 + g, y0 + g], [x1 - g, y0 + g]];
  frameRing(m, { inner: rect(stile), outer: rect(0), z0: 0, z1: 0.075, bevel: 0.02 }, p);
  // Recessed panels: one plane behind the frame, the middle rail laid on it
  // 5 mm shy of the frame's face.
  const panel = paint(p, { color: shade(p.color, 0.9) });
  quadFacing(m, new Vector3(x0 + stile, y0 + stile, 0.025), new Vector3(x1 - stile, y0 + stile, 0.025), new Vector3(x1 - stile, y1 - stile, 0.025), new Vector3(x0 + stile, y1 - stile, 0.025), new Vector3(0, 0, 1), panel);
  const mid = y0 + (y1 - y0) * 0.54;
  box(m, { min: [x0 + stile - 0.01, mid - 0.05, 0.02], max: [x1 - stile + 0.01, mid + 0.05, 0.07], faces: { nz: null, px: null, nx: null } }, p);
  toFacade(m, start, o.on);
}

/** Railing of the balcony: two capped posts on the front corners, a fat
 * round rail through them back to the wall, seven square balusters (the
 * sheet's: about as wide as the gaps are half their height). */
function balconyRail(m: SolidMesh, P: BuildingPaints, p: Paint): void {
  const zPost = -D / 2 - RAIL_POST_OUT;
  const yRail = DECK_TOP + RAIL_H;
  // Rings along the rail: its two ends are buried in posts or wall, and a
  // rail with no vertices between them bakes contact-dark from end to end.
  const rail = (a: Vec3, b: Vec3, rings: number): void => tube(m, { path: linePath(a, b, rings), radius: 0.1, sides: 8, caps: false }, p);
  for (const sx of [1, -1]) {
    // The cap starts clear of the rail's top, so the rail runs into the shaft.
    post(m, { at: [sx * RAIL_POST_X, zPost], bottom: DECK_TOP - 0.04, top: yRail + 0.3, size: RAIL_POST, cap: { height: 0.2, grow: 0.07, paint: P.trim } }, p);
    rail([sx * RAIL_POST_X, yRail, zPost], [sx * RAIL_POST_X, yRail, -D / 2 + 0.03], 2);
  }
  rail([-RAIL_POST_X, yRail, zPost], [RAIL_POST_X, yRail, zPost], 5);
  // Square, chamfered, a little narrower than the rail: their fronts stay
  // inside its round, so the joint is a clean saddle rather than a point.
  const baluster = (x: number, z: number): void => {
    beam(m, { from: [x, DECK_TOP - 0.03, z], to: [x, yRail, z], size: 0.14, chamfer: 0.025, caps: false, side: [0, 0, 1], segments: 1 }, p);
  };
  const count = 7;
  const clear = RAIL_POST_X * 2 - RAIL_POST;
  for (let i = 1; i <= count; i++) baluster(-clear / 2 + (clear * i) / (count + 1), zPost);
  // The side returns are only 0.4 m long between post and wall: one each.
  for (const sx of [1, -1]) baluster(sx * RAIL_POST_X, (zPost + RAIL_POST / 2 - D / 2) / 2);
}

/**
 * Balcony bracket as the sheet draws it: a square timber bearer under the
 * deck and a straight diagonal strut from the wall up to its outer end
 * (the kit's `bracket` is a curved console). `top` = the deck's underside.
 */
function balconyBracket(m: SolidMesh, on: Facade, u: number, top: number, p: Paint): void {
  const start = m.mark();
  const hw = BRACKET_W / 2;
  // Bearer: sunk 2 cm into the deck and 4 cm into the wall.
  roundedBox(m, { min: [u - hw, top - 0.24, -0.04], max: [u + hw, top + 0.02, BRACKET_OUT], radius: 0.045, segments: 1 }, p);
  // Strut: its foot buried in the wall, its head in the bearer; both ends
  // are hidden, so no caps.
  const slope = (BRACKET_DROP - 0.2) / BRACKET_OUT;
  const at = (w: number): Vec3 => [u, top - BRACKET_DROP + 0.18 + w * slope, w];
  beam(m, { from: at(-0.16), to: at(BRACKET_OUT - 0.12), size: [0.26, 0.24], chamfer: 0.04, caps: false, side: [1, 0, 0], segments: 1 }, p);
  toFacade(m, start, on);
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'warm');
  // The sheet's plaster is a shade deeper and redder than the palette apricot.
  const sheet = base.scheme === 'warm' ? withPaints(base, { wall: mixOklab(BUILDING.apricot, BUILDING.coral, 0.3), roof: BUILDING.cobalt, roofAlt: BUILDING.coral }) : base;
  const P = variantPaints(sheet, v);
  const m = new SolidMesh();

  // a. Roof: a low hip with a short ridge under the cream apex block.
  const roof = hipRoof(
    m,
    { width: W, depth: D, eave: EAVE, top: ROOF_TOP, overhang: ROOF_OVERHANG, thickness: ROOF_THICKNESS, seamPitch: 1.1, finial: { size: 1.0 + v.shift('finial', 0.06), height: FINIAL_HEIGHT } },
    P,
  );

  // b + c. Walls with their openings, then the plinth round them.
  const frontWin: Opening = { u: 1.0, v: 1.2, w: c.winW, h: 1.0 };
  const sideWin = (y: number): Opening => ({ u: 0, v: y, w: 1.05, h: 1.05 });
  const storeys = [sideWin(1.0), sideWin(3.45)];
  const F = wallBox(m, { width: W, depth: D, bottom: PLINTH - 0.1, top: EAVE, grid: 1.0, openings: { front: [DOOR, frontWin, BALCONY_DOOR], left: storeys, right: storeys, back: storeys } }, P.wall);
  plinth(m, F, seed, P);

  // d + e. Pilasters, band, cornice.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.03, top: EAVE - CORNICE_H + 0.03, size: PILASTER, base: { height: 0.3, grow: 0.06 }, cap: { height: 0.27, grow: 0.11 } }, P.trim);
  trimBand(m, { width: W, depth: D, y: BAND_Y, height: BAND_H, proud: 0.16 }, P.trim);
  trimBand(m, { width: W, depth: D, y: EAVE - CORNICE_H / 2 + 0.01, height: CORNICE_H, proud: CORNICE_OUT }, P.trim);

  // f. Openings.
  door(m, { on: F.front, opening: DOOR, planks: 2, surround: 0 }, P);
  doorPortal(m, F.front, P);
  windowUnit(m, { on: F.front, opening: frontWin, surround: 0.16, flowerBox: c.flowerBox, seed }, P);
  for (const on of [F.left, F.right, F.back]) {
    for (const op of storeys) windowUnit(m, { on, opening: op, surround: 0.16, lit: on === F.right && op.v > 3 && v.chance('lit', 0.35, false) }, P);
  }
  door(m, { on: F.front, opening: BALCONY_DOOR, glazed: [2, 3], surround: 0, handle: 'none', paint: P.frame }, P);
  {
    const start = m.mark();
    const { u, v: y, w, h } = BALCONY_DOOR;
    pillow(m, { x0: u - w / 2 - 0.2, x1: u + w / 2 + 0.2, y0: y + h + 0.03, y1: y + h + 0.23, z0: -0.04, z1: 0.13, chamfer: 0.05 }, soften(P.trim, 45));
    toFacade(m, start, F.front);
  }
  for (const side of [1, -1] as const) panelShutter(m, { on: F.front, opening: BALCONY_DOOR, side, state: c.shutters }, P.shutter);

  // g. Balcony: deck slab level with the band, three brackets, railing.
  {
    const start = m.mark();
    roundedBox(m, { min: [-DECK_W / 2, DECK_TOP - DECK_T, -0.06], max: [DECK_W / 2, DECK_TOP, DECK_OUT], radius: 0.075, segments: 2, faces: { nz: null } }, P.trim);
    toFacade(m, start, F.front);
  }
  for (const u of BRACKET_U) balconyBracket(m, F.front, u, DECK_TOP - DECK_T, P.timber);
  balconyRail(m, P, P.shutter);

  // h. Dressing by seed.
  if (c.chimney) chimney(m, { at: CHIMNEY, roof, size: CHIMNEY_SIZE, height: CHIMNEY_HEIGHT, vent: '-x' }, P);
  // Wall lantern on the face of the pilaster beside the door: the only
  // spot on the ground floor clear of door, window and brackets.
  if (c.lantern) wallLantern(m, { on: F.front, u: -(W / 2 + 0.06 - PILASTER / 2), v: 1.95, proud: 0.06, reach: 0.4 }, P);
  if (c.solar) {
    // On the right-hand slope, long side along the eave, raised on a dark
    // mounting block so it stands clear of the seams. Cells a shade deeper
    // and less glossy than the kit's: on a cobalt roof the glossy ones
    // mirror the sky and vanish into it.
    const [x, z] = SOLAR;
    const base = roof.heightAt(x, z) - 0.01;
    const tilt = roof.tiltAt(x, z)[2];
    const s = m.mark();
    roundedBox(m, { min: [-0.48, -0.14, -0.28], max: [0.48, 0.07, 0.28], radius: 0.02, segments: 1 }, P.iron);
    m.transform(compose(rotation('y', 90), rotation('z', tilt), translation(x, base, z)), s);
    const cells = paint(P.solar, { color: shade(P.solar.color, 0.8), gloss: 0.45 });
    solarPanel(m, { at: [x, base + 0.06, z], rot: [0, 90, tilt] }, { ...P, solar: cells });
  }
  if (c.balconyPot) planter(m, { at: [1.5, -D / 2 - 0.5], base: DECK_TOP, radius: 0.2, height: 0.32, seed: seed + 3, paint: P.accent }, P);
  c.pots.forEach((at, i) => planter(m, { at, seed: seed * 5 + i, paint: i === 0 ? P.accent : P.trim }, P));
  return finishBuilding(m);
}

/** The seeded chimney, from just inside the roof to its cap. `roofAt` is
 * the hip's surface height (it stands on the left slope, so the x distance
 * to the eave decides, not z). */
function chimneyBox(roofAt: (x: number, z: number) => number): ColliderSpec {
  const surface = roofAt(CHIMNEY[0], CHIMNEY[1]);
  const top = surface + CHIMNEY_HEIGHT + 0.1;
  const bottom = surface - 0.3;
  return { shape: 'box', center: [CHIMNEY[0], (top + bottom) / 2, CHIMNEY[1]], half: [CHIMNEY_SIZE / 2 + 0.1, (top - bottom) / 2, CHIMNEY_SIZE / 2 + 0.1] };
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  // The hip as three stacked boxes, each topping out at the roof's height
  // 0.4 m inside its own edge (same staircase rule as the cottage).
  const y1 = EAVE - 0.03 + ROOF_THICKNESS;
  const ridge = ROOF_TOP - FINIAL_HEIGHT * 0.75;
  const b = D / 2 + ROOF_OVERHANG;
  const slope = (ridge - y1) / b;
  // Mirrors hipRoof's geometry: the ridge is the difference of the sides.
  const a = W / 2 + ROOF_OVERHANG;
  const rl = (W - D) / 2;
  const roofAt = (x: number, z: number): number => Math.min(ridge, y1 + (b - Math.abs(z)) * slope, y1 + (a - Math.abs(x)) * ((ridge - y1) / (a - rl)));
  let from = EAVE;
  const roofStep = (inset: number): ColliderSpec => {
    const top = Math.min(ROOF_TOP, y1 + (inset + 0.4) * slope);
    const spec: ColliderSpec = { shape: 'box', center: [0, (from + top) / 2, 0], half: [W / 2 + ROOF_OVERHANG - inset, (top - from) / 2, b - inset] };
    from = top;
    return spec;
  };
  return [
    // Walls with plinth and pilasters, up to the eave.
    { shape: 'box', center: [0, EAVE / 2, 0], half: [W / 2 + 0.16, EAVE / 2, D / 2 + 0.16] },
    ...[0, 0.75, 1.5].map(roofStep),
    // Balcony deck: nothing under it but the brackets (boxes below), so a
    // buggy passes below and one that lands on it stays there.
    { shape: 'box', center: [0, DECK_TOP - DECK_T / 2, -D / 2 - DECK_OUT / 2], half: [DECK_W / 2, DECK_T / 2, DECK_OUT / 2] },
    // Railing (posts to rail top) along the deck's front edge.
    { shape: 'box', center: [0, DECK_TOP + (RAIL_H + 0.3) / 2, -D / 2 - RAIL_POST_OUT], half: [RAIL_POST_X + RAIL_POST / 2, (RAIL_H + 0.3) / 2, RAIL_POST / 2] },
    // The brackets reach down to 1.86 m: a 2 m buggy hugging the wall hits them.
    ...BRACKET_U.map((u): ColliderSpec => ({ shape: 'box', center: [u, DECK_TOP - DECK_T - BRACKET_DROP / 2, -D / 2 - BRACKET_OUT / 2], half: [BRACKET_W / 2, BRACKET_DROP / 2, BRACKET_OUT / 2] })),
    ...(c.chimney ? [chimneyBox(roofAt)] : []),
    ...c.pots.map(([x, z]): ColliderSpec => ({ shape: 'cylinder', base: [x, 0, z], height: 0.45, radius: 0.28 })),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b06-corner-house',
  name: 'B06 Corner House',
  category: 'building',
  size: { x: 5.68, y: 6.85, z: 5.24 },
  variants: 3,
  schemes: ['warm', 'coastal', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/houses/design-sheet.png',
    brief: 'design-documents/building-design-pack/houses/b06-corner-house-brief.txt',
  },
  build,
  colliders,
};

export default asset;
