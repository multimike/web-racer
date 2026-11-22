import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, cylinder, extrudePolygon, hex, mix, mixOklab, paint, quadFacing, revolve, roundedBox, soften, sphere } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { Paint, Vec2 } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  boxFacades,
  cornerPosts,
  door,
  facadePoint,
  finishBuilding,
  flowerBox,
  frameRing,
  gableRoof,
  gableRoofInfo,
  hipRoof,
  offsetFacade,
  openingRing,
  pillow,
  planter,
  schemePaints,
  steps,
  stoneCourse,
  stonePlinth,
  toFacade,
  variantPaints,
  variation,
  withPaints,
  wallBox,
  wallLantern,
  wallPanel,
  windowUnit,
} from './parts';
import type { BuildingPaints, Facade, Opening, RoofInfo } from './parts';

/**
 * B10 — Village Hall. Sheet scheme: SUNNY (mustard plaster, teal seamed
 * roof, coral front door, teal frames and rear door); it also builds as
 * 'warm' and 'coastal'.
 *
 * MAIN BODY 8.0 (x) × 6.0 (z) m, walls to the 3.35 m eave, gable ends left
 * and right (ridge along x, as the brief rules), roof slab apex 4.8 m (the
 * brief's ridge; ~23.4°, the sheet's side view draws ~25°). Stone plinth to
 * 0.5 m. CLOCK TOWER 2.4 × 2.4 m, centred, standing 0.8 m out of the front
 * wall and through the front roof slope; cornice at 5.75 m, pyramid cap and
 * finial block to 7.5 m (the brief's written height — the sheet's views
 * disagree about it).
 * OVERALL 8.96 × 7.6 × 7.87 m with bargeboards, eaves, tower and door steps
 * (x ±4.48, z −4.48 … 3.39) — inside the brief's 9 × 8 m placement envelope.
 *
 * Opening schedule (brief): front = arched double door in the tower + one
 * broad six-pane window per wing; each side = two windows; rear = service
 * door (standing at ground level in a cream case in front of the plinth)
 * between two windows. Every window has the sheet's cream surround and sill.
 *
 * Seeds: 0 = the sheet. The game instantiates 0 – 2, so the visible choices
 * CYCLE: 1 = hanging lanterns instead of the bulkhead lamps, two flower pots
 * in the corners beside the tower, a weathervane on the cap; 2 = flower
 * boxes under the front windows, a flagpole with a pennant on the cap, one
 * lit side window. The front door keeps the scheme's colour on every seed
 * (the coral door is what makes the sunny hall); the variant door colour
 * goes to the rear service door. The clock shows a different time, the
 * front windows shift a few centimeters in width.
 * 5 532 triangles for seed 0, ~5 900 for seeds 1 and 2 (sunny).
 */

const W = 8.0;
const D = 6.0;
const PLINTH = 0.5;
const EAVE = 3.35;
const ROOF_RISE = 1.3;
const ROOF_T = 0.14;
const EAVE_OVER = 0.25;
/** Gable wall to the outer face of the bargeboard. */
const GABLE_OVER = 0.48;
const BARGE_T = 0.4;
const BARGE_D = 0.46;

const TOWER_W = 2.4;
const TOWER_OUT = 0.8;
/** Plan centre of the tower. */
const TZ = -D / 2 - TOWER_OUT + TOWER_W / 2;
const TOWER_FRONT = TZ - TOWER_W / 2;
const TOP = 7.5;
const CORNICE = 5.75;
const CORNICE_H = 0.38;
const CORNICE_OVER = 0.27;
const POST = 0.36;
const POST_PROUD = 0.06;
/** Belt course of the tower, level with the main roof's edge. */
const BAND_Y = EAVE;

const STEP_WIDTH = 2.6;
const STEP_TREAD = 0.34;
const STEP_FLARE = 0.2;

const CLOCK_Y = 4.64;
/** Bezel radius: it bites 2 cm into the pilasters on either side, as drawn. */
const CLOCK_R = 0.92;

const DOOR: Opening = { u: 0, v: PLINTH, w: 1.36, h: 2.3, round: 0.34 };
const REAR_DOOR: Opening = { u: 0, v: 0.04, w: 1.05, h: 2.34, round: 0.12 };
/** The rear door stands in a case this far out of the wall. */
const REAR_CASE = 0.27;

const SURROUND = 0.15;

const ROOF = { span: D, length: W, ridge: 'x' as const, eave: EAVE, rise: ROOF_RISE, thickness: ROOF_T, overhang: { eave: EAVE_OVER, gable: GABLE_OVER - 0.07 }, bargeboards: false, seamPitch: 0.9 };

/** The sheet's lamps glow warm cream with an amber edge, not lemon; the lit
 * window is a warm interior, not yellow card. */
const LAMP_LENS = paint('#FFC47A', { gloss: 0.5, emissive: 0.6 });
const LIT_GLASS = paint('#F7A04E', { gloss: 0.6, emissive: 0.42 });
/** Lit glass glows brighter low down (lamp light on the sill), deeper at the head. */
const LIT_LOW = hex('#FFC274');
const LIT_HIGH = hex('#E9873D');

const WARM_WALL = mixOklab(BUILDING.cream, BUILDING.apricot, 0.4);

const CLOCK_DARK = paint('#473F55', { gloss: 0.4 });
const CLOCK_FACE = paint('#FBF2DE', { gloss: 0.4 });

/** Flower pots of seed 1: in the corners between the tower and the wings. */
const POT_AT: readonly [number, number] = [1.74, -D / 2 - 0.5];
const POT_R = 0.32;
const POT_H = 0.5;

/**
 * The scheme's paints. 'warm' is cream walls with cream trim, which erases
 * the tower's pilasters, belts, cornice and every surround — the hall's whole
 * articulation — so its wall is pushed toward apricot until the wall / trim
 * gap is about what the mustard 'sunny' sheet shows.
 */
function hallPaints(scheme?: string): BuildingPaints {
  const P = schemePaints(scheme, 'sunny');
  return P.scheme === 'warm' ? withPaints(P, { wall: WARM_WALL }) : P;
}

/**
 * Secondary choices of one variant (seed 0 = the sheet). Shared by `build`
 * and `colliders`, so whatever stands on the ground also blocks.
 */
function choices(seed: number) {
  const v = variation(seed, 'b10');
  // The game instantiates seeds 0 – 2, so everything that shows at a glance
  // cycles. Each extra is paid for inside the budget: the lanterns of seed 1
  // cost less than the lamps they replace, which buys its two pots.
  const pots = v.cycle([0, 2, 0] as const);
  return {
    v,
    time: v.cycle([[10, 9], [3, 40], [7, 24]] as const),
    lights: v.cycle(['lamp', 'lantern', 'lamp'] as const),
    finial: v.cycle(['block', 'vane', 'flag'] as const),
    flowerBoxes: v.cycle([false, false, true] as const),
    /** Which side wall has a lit window (0 = none). */
    lit: v.cycle([0, 0, 1] as const),
    frontW: 1.7 + v.shift('frontW', 0.07),
    pots: Array.from({ length: pots }, (_, i): [number, number] => [(i === 0 ? 1 : -1) * POT_AT[0], POT_AT[1]]),
  };
}

// Drawn as seen from the front: x = viewer's right, y = up.
const VANE_ARROW: Vec2[] = [[-0.52, -0.16], [-0.34, -0.04], [0.2, -0.04], [0.2, -0.17], [0.54, 0], [0.2, 0.17], [0.2, 0.04], [-0.34, 0.04], [-0.52, 0.16], [-0.44, 0]];
const PENNANT: Vec2[] = [[0, -0.25], [0.86, -0.2], [0.68, 0], [0.86, 0.2], [0, 0.25]];

/** What stands on the cap's apex block on seeds other than the sheet's. */
function capTopper(m: SolidMesh, kind: 'vane' | 'flag', P: BuildingPaints): void {
  const y = TOP - 0.06;
  if (kind === 'vane') {
    cylinder(m, { from: [0, y, TZ], to: [0, y + 0.98, TZ], radius: 0.04, sides: 6, caps: 'top' }, P.iron);
    sphere(m, { radius: 0.13, segments: 6, rings: 3, at: [0, y + 0.3, TZ] }, paint(P.metal, { smooth: 180 }));
    extrudePolygon(m, { outline: VANE_ARROW, depth: 0.05, centered: true, bevel: 0.015, bevelBack: true, facing: '-z', at: [0, y + 0.74, TZ] }, P.iron);
  } else {
    cylinder(m, { from: [0, y, TZ], to: [0, y + 1.36, TZ], radius: 0.05, sides: 6, caps: 'top', bevel: { top: 0.03 }, bevelSegments: 1 }, P.trim);
    const s = m.mark();
    extrudePolygon(m, { outline: PENNANT, depth: 0.05, centered: true, bevel: 0.015, bevelBack: true, facing: '-z', at: [0.03, y + 0.98, TZ] }, P.accent);
    // Swung off the facade plane, so that it is not edge-on from the side.
    m.rotate('y', 28, s, [0, 0, TZ]);
  }
}

/** Thick cream boards on a gable end as ONE mitred chevron. */
function bargeboard(m: SolidMesh, side: 1 | -1, p: Paint): void {
  const half = D / 2;
  const len = Math.hypot(half, ROOF_RISE);
  const c = half / len;
  const sn = ROOF_RISE / len;
  const tan = ROOF_RISE / half;
  const apexT = EAVE + ROOF_RISE + ROOF_T / c;
  const lift = 0.065;
  const top = (u: number): number => apexT + lift / c - Math.abs(u) * tan;
  const bottom = (u: number): number => apexT + (lift - BARGE_D) / c - Math.abs(u) * tan;
  const uF = half + EAVE_OVER + ROOF_T * sn + 0.08;
  const cut = 0.24;
  const yL = bottom(uF - cut);
  const outline: Vec2[] = [
    [uF - cut, yL],
    [uF, yL],
    [uF, top(uF)],
    [0.16, top(0.16)],
    // A slight peak, not a dip: the main roof's ridge roll runs out to the
    // gable and must die inside the board, not show over its apex.
    [0, top(0) + 0.05],
    [-0.16, top(0.16)],
    [-uF, top(uF)],
    [-uF, yL],
    [-uF + cut, yL],
    [0, bottom(0)],
  ];
  extrudePolygon(
    m,
    { outline, depth: BARGE_T, facing: side > 0 ? '+x' : '-x', bevel: 0.08, bevelSegments: 2, bevelBack: true, at: [side * (W / 2 + GABLE_OVER - BARGE_T), 0, 0] },
    soften(p, 46),
  );
}

/**
 * The hall's window dressing: the kit's cream surround (`windowUnit({
 * surround })`: same depths, same bevel) with ONE step round its 8 cm
 * corners instead of two — eight windows make that 320 triangles — and the
 * wider sill slab every window on the sheet stands on.
 */
function dressing(m: SolidMesh, on: Facade, op: Opening, P: BuildingPaints): void {
  const s = m.mark();
  // Outer corners round (r 0.1, two 45° steps that shade as one curve), the
  // inner ones square like the glazing frame — coincident inner points fold
  // the corner strips into triangles, a third cheaper than a round inner
  // ring. The ring reaches back into the glazing frame (front at −0.065), so
  // no strip of wall paint shows in the reveal between surround and frame.
  frameRing(m, { inner: openingRing(op, -0.012, 0, 2, true), outer: openingRing(op, SURROUND, 0.1, 2, true), z0: -0.075, z1: 0.07, bevel: 0.03 }, soften(P.trim, 46));
  pillow(m, { x0: op.u - op.w / 2 - SURROUND - 0.1, x1: op.u + op.w / 2 + SURROUND + 0.1, y0: op.v - SURROUND - 0.17, y1: op.v - SURROUND + 0.03, z0: -0.03, z1: 0.17, chamfer: 0.05 }, soften(P.trim, 45));
  toFacade(m, s, on);
}

/** The sheet's two plain silver balls (no rose), sunk 2 cm into the leaf,
 * a little below the middle of the door. Smooth whatever the facet count. */
function knobs(m: SolidMesh, on: Facade, op: Opening, w: number, P: BuildingPaints, segments = 9): void {
  const s = m.mark();
  const ball = paint(P.metal, { smooth: 180 });
  for (const side of [-1, 1]) {
    const x = op.u + side * 0.15;
    const y = op.v + op.h * 0.38;
    sphere(m, { radius: 0.095, segments, rings: segments > 9 ? 5 : 4, at: [x, y, w + 0.075] }, ball);
  }
  toFacade(m, s, on);
}

/**
 * Surround of the front door: the kit door's ring (same width, depth and
 * bevel), but reaching back to the leaf, so the reveal between them shows
 * cream instead of a strip of wall paint; the ring's lower bar is the
 * threshold.
 */
function doorSurround(m: SolidMesh, on: Facade, op: Opening, sw: number, leafZ: number, P: BuildingPaints): void {
  const s = m.mark();
  const foot: Opening = { ...op, v: op.v - 0.03, h: op.h + 0.03, round: Math.max(op.round ?? 0, 0.02) };
  const segs = 4;
  frameRing(m, { inner: openingRing(op, -0.012, 0, segs, true), outer: openingRing(foot, sw, 0, segs, true), z0: leafZ - 0.005, z1: 0.08, bevel: 0.035 }, soften(P.trim, 45));
  toFacade(m, s, on);
}

/**
 * The sheet's door leaves are plain, each with one large raised panel whose
 * outer top corner follows the arch. `leafZ` = the leaf's front face.
 */
function doorPanels(m: SolidMesh, on: Facade, op: Opening, leafZ: number, p: Paint): void {
  const s = m.mark();
  const half = op.w / 2;
  const inset = 0.1;
  const pw = half - 2 * inset + 0.02;
  const y0 = op.v + 0.16;
  const y1 = op.v + op.h - 0.13;
  const outerR = Math.max(0.06, (op.round ?? 0) - inset + 0.02);
  for (const side of [-1, 1] as const) {
    const cx = op.u + side * (half / 2 + 0.005);
    // Arch-side top corner: three steps along the arch; the other three
    // corners: one chamfer step (small, and softened, they read as round).
    const xa = cx + side * pw / 2;
    const xs = cx - side * pw / 2;
    const k = 0.05;
    const ring: Vec2[] = [[xs + side * k, y0], [xa - side * k, y0], [xa, y0 + k]];
    for (let i = 0; i <= 3; i++) {
      const a = (i * Math.PI) / 6;
      ring.push([xa - side * outerR * (1 - Math.cos(a)), y1 - outerR + Math.sin(a) * outerR]);
    }
    ring.push([xs + side * 0.07, y1], [xs, y1 - 0.07], [xs, y0 + k]);
    // Counter-clockwise as seen from the front: on the left leaf the walk
    // above runs clockwise.
    if (side < 0) ring.reverse();
    // Crisp 45° bevel: its light / dark rim is the panel line the sheet draws.
    extrudePolygon(m, { outline: ring, depth: 0.045, bevel: 0.025, back: false, at: [0, 0, leafZ - 0.012] }, p);
  }
  toFacade(m, s, on);
}

/** Clock on a wall that faces −z: bezel, face, four marks, two hands. */
function clock(m: SolidMesh, at: readonly [number, number, number], radius: number, time: readonly [number, number], P: BuildingPaints): void {
  const s = m.mark();
  // Built lying on its back (axis +y out of the wall, +z = twelve o'clock).
  const R = radius;
  const w = 0.15;
  const h = 0.17;
  const f = 0.08;
  // 30 segments: the bezel is the building's signature outline, seen square
  // on in the front elevation, where 20 read as a polygon.
  revolve(m, { profile: [[R, -0.03], [R, h - 0.06], [R - 0.06, h], [R - w, f], [0, f]], segments: 30 }, (band) => (band >= 3 ? CLOCK_FACE : P.trim));
  const rf = R - w;
  const dark = soften(CLOCK_DARK, 50);
  for (let k = 0; k < 4; k++) {
    const k0 = m.mark();
    box(m, { min: [-0.05, f - 0.01, rf - 0.32], max: [0.05, f + 0.035, rf - 0.08], faces: { ny: null } }, CLOCK_DARK);
    m.rotate('y', k * 90, k0);
  }
  const [hours, minutes] = time;
  // Thick hands with round tips, drawn flat (x across, y along the hand)
  // and laid on the face (facing '+y': outline y = +z = twelve o'clock),
  // then turned to the hour.
  const hand = (length: number, width: number, lift: number, angle: number): void => {
    const h0 = m.mark();
    const r = width / 2;
    const outline: Vec2[] = [[r * 0.8, -0.1], [r, length - r]];
    for (let i = 1; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      outline.push([Math.cos(a) * r, length - r + Math.sin(a) * r]);
    }
    outline.push([-r, length - r], [-r * 0.8, -0.1]);
    extrudePolygon(m, { outline, depth: lift, facing: '+y', bevel: 0.015, bevelSegments: 1, back: false, at: [0, f - 0.01, 0] }, dark);
    m.rotate('y', angle, h0);
  };
  hand(rf * 0.52, 0.11, 0.05, (hours + minutes / 60) * 30);
  hand(rf * 0.8, 0.085, 0.07, minutes * 6);
  cylinder(m, { from: [0, f, 0], to: [0, f + 0.11, 0], radius: 0.085, sides: 10, caps: 'top', bevel: { top: 0.035 }, bevelSegments: 1 }, soften(CLOCK_DARK, 50));
  m.rotate('x', -90, s);
  m.translate([at[0], at[1], at[2]], s);
}

/**
 * The sheet's bulkhead lamp: a rounded-rectangle cream casing with a glowing
 * rounded lens — two rounded boxes, smoother and cheaper than the kit's
 * extruded pill (whose two-step corners read as an octagon this close to the
 * door). Centre (u, v) on the facade; the casing stands 0.11 m proud.
 */
function hallLamp(m: SolidMesh, on: Facade, u: number, v: number, P: BuildingPaints): void {
  const s = m.mark();
  roundedBox(m, { min: [u - 0.13, v - 0.23, -0.02], max: [u + 0.13, v + 0.23, 0.11], radius: 0.055, segments: 2, faces: { nz: null } }, P.trim);
  roundedBox(m, { min: [u - 0.075, v - 0.165, 0.07], max: [u + 0.075, v + 0.165, 0.135], radius: 0.03, segments: 1, faces: { nz: null } }, soften(LAMP_LENS, 50));
  toFacade(m, s, on);
}

/**
 * Drops every triangle that lies wholly inside the tower shaft or inside the
 * hall below its roof: the stretch of main front wall, plinth stones and
 * roof seams the tower swallows, and the tower's side walls where they run
 * on through the hall to the roof. Nothing outside sees them (doors closed,
 * windows glazed, cap on top), and the triangles pay for the rounder clock,
 * knobs and window surrounds.
 */
function cullHidden(m: SolidMesh): void {
  const tx = TOWER_W / 2 - 0.01;
  const tz0 = TOWER_FRONT + 0.3;
  const tz1 = TZ + TOWER_W / 2 - 0.02;
  const ty = CORNICE - 0.02;
  // The hall: behind its walls' 0.25 m thickness, under the roof's underside.
  const hx = W / 2 - 0.27;
  const hz = D / 2 - 0.27;
  const under = (z: number): number => EAVE + ROOF_RISE * (1 - Math.abs(z) / (D / 2)) - 0.03;
  const p = m.positions;
  const inTower = (o: number): boolean => Math.abs(p[o]) < tx && p[o + 1] > PLINTH + 0.02 && p[o + 1] < ty && p[o + 2] > tz0 && p[o + 2] < tz1;
  const inHall = (o: number): boolean => Math.abs(p[o]) < hx && Math.abs(p[o + 2]) < hz && p[o + 1] > PLINTH + 0.02 && p[o + 1] < under(p[o + 2]);
  let t = 0;
  m.repaint(() => {
    const o = 9 * t++;
    if (inTower(o) && inTower(o + 3) && inTower(o + 6)) return null;
    return inHall(o) && inHall(o + 3) && inHall(o + 6) ? null : undefined;
  });
}

/**
 * One side wall of the tower, in two pieces. In front of the hall's wall line
 * it is a full-height kit panel. Behind it the wall only shows ABOVE the main
 * roof, so it is a plain grid that starts inside the roof slab and follows
 * its slope: a kit panel there would run its 0.9 m cells straight through
 * the roof, and every cell that straddles it bakes black at its buried
 * corners and smears dark wedges up the open wall.
 */
function towerSide(m: SolidMesh, on: Facade, roof: RoofInfo, P: BuildingPaints): void {
  const z0 = facadePoint(on, 0, 0).z;
  const dz = facadePoint(on, 1, 0).z - z0;
  const uAt = (z: number): number => (z - z0) / dz;
  const zSplit = -D / 2 + 0.02;
  const uF = uAt(TOWER_FRONT);
  const uS = uAt(zSplit);
  wallPanel(m, { on, u: (uF + uS) / 2, width: Math.abs(uS - uF), bottom: PLINTH - 0.1, top: CORNICE + 0.03, grid: 0.9, ends: false }, P.wall);
  // 3 mm inside the panel's plane, overlapping it by 2 cm: the panel covers
  // the joint, and no two faces share a plane.
  const x = facadePoint(on, 0, 0, -0.003).x;
  const n = new Vector3(Math.sign(x), 0, 0);
  const zs = [zSplit - 0.02, -2.4, -1.9, TZ + TOWER_W / 2];
  const top = CORNICE + 0.03;
  for (let i = 0; i + 1 < zs.length; i++) {
    const [za, zb] = [zs[i], zs[i + 1]];
    const ya = roof.heightAt(0, za) - 0.06;
    const yb = roof.heightAt(0, zb) - 0.06;
    for (let k = 0; k < 3; k++) {
      const f0 = k / 3;
      const f1 = (k + 1) / 3;
      const lo = (y: number, f: number): number => y + (top - y) * f;
      quadFacing(m, new Vector3(x, lo(ya, f0), za), new Vector3(x, lo(yb, f0), zb), new Vector3(x, lo(yb, f1), zb), new Vector3(x, lo(ya, f1), za), n, P.wall);
    }
  }
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = hallPaints(scheme);
  const P = variantPaints(base, v);
  const m = new SolidMesh();
  const T = boxFacades(TOWER_W, TOWER_W, 0, TZ);

  // a. Roofs.
  // Cream soffit: from a low camera the sheet shows teal over cream there.
  const roof = gableRoof(m, { ...ROOF, soffit: P.trim }, P);
  bargeboard(m, 1, P.trim);
  bargeboard(m, -1, P.trim);
  hipRoof(m, { width: TOWER_W, depth: TOWER_W, cz: TZ, eave: CORNICE + CORNICE_H + 0.01, top: TOP, overhang: 0.17, thickness: 0.14, ridgeLength: 0, seamPitch: 2.0, finial: { size: 0.56, height: 0.24 } }, P);
  // b. Plinth.
  stonePlinth(m, { width: W, depth: D, top: PLINTH, seed, blockLength: [0.9, 1.2], split: 0.06 }, P);
  stoneCourse(m, { on: T.right, u0: -TOWER_W / 2, u1: -TOWER_W / 2 + TOWER_OUT, top: PLINTH, seed: seed + 11 }, P);
  stoneCourse(m, { on: T.left, u0: TOWER_W / 2 - TOWER_OUT, u1: TOWER_W / 2, top: PLINTH, seed: seed + 12 }, P);
  // The tower stands on the plinth course and the steps, not on the hall's
  // stone core: close its foot from below (seen only from under the ground,
  // but no open shell anywhere).
  // Wide enough to run in under the side courses' stones.
  const TF = TOWER_W / 2 + 0.08;
  quadFacing(m, new Vector3(-TF, -0.09, TOWER_FRONT), new Vector3(TF, -0.09, TOWER_FRONT), new Vector3(TF, -0.09, -D / 2 + 0.05), new Vector3(-TF, -0.09, -D / 2 + 0.05), new Vector3(0, -1, 0), P.stoneDark);
  // c. Walls.
  const frontWin = (side: 1 | -1): Opening => ({ u: side * 2.47, v: 1.4, w: c.frontW, h: 1.0 });
  const sideWin = (side: 1 | -1): Opening => ({ u: side * 1.35, v: 1.3, w: 0.95, h: 1.1 });
  const rearWin = (side: 1 | -1): Opening => ({ u: side * 2.45, v: 1.3, w: 1.0, h: 1.1 });
  const F = wallBox(
    m,
    {
      width: W,
      depth: D,
      bottom: PLINTH - 0.1,
      top: EAVE,
      gable: { ridge: 'x', rise: roof.rise },
      grid: 1.2,
      openings: { front: [frontWin(-1), frontWin(1)], left: [sideWin(-1), sideWin(1)], right: [sideWin(-1), sideWin(1)], back: [rearWin(-1), rearWin(1)] },
    },
    P.wall,
  );
  // Tower shaft: four plates without end faces — every corner is under a
  // pilaster. The back one starts inside the main roof.
  const shaft = { width: TOWER_W, bottom: PLINTH - 0.1, top: CORNICE + 0.03, grid: 0.9, ends: false };
  wallPanel(m, { ...shaft, on: T.front, openings: [DOOR] }, P.wall);
  for (const on of [T.left, T.right]) towerSide(m, on, roof, P);
  wallPanel(m, { ...shaft, on: T.back, bottom: 4.0, foot: 0 }, P.wall);
  // d. Corner pilasters.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH, top: EAVE + 0.05, size: POST, proud: POST_PROUD }, P.trim);
  const cap = { height: 0.28, grow: 0.06 };
  cornerPosts(m, { width: TOWER_W, depth: TOWER_W, cz: TZ, bottom: PLINTH - 0.03, top: CORNICE, size: POST, proud: POST_PROUD, corners: ['fl', 'fr'], base: { height: 0.45, grow: 0.07 }, cap }, P.trim);
  cornerPosts(m, { width: TOWER_W, depth: TOWER_W, cz: TZ, bottom: 4.0, top: CORNICE + 0.02, size: POST, proud: POST_PROUD, corners: ['bl', 'br'] }, P.trim);
  // e. Bands.
  const px = TOWER_W / 2 - (POST / 2 - POST_PROUD);
  const pz = TOWER_FRONT + (POST / 2 - POST_PROUD);
  for (const s of [1, -1]) {
    roundedBox(m, { size: [0.54, 0.5, 0.54], radius: 0.07, segments: 1, at: [s * px, BAND_Y, pz] }, P.trim);
    // Tower belt, side: from the corner block back into the main roof.
    beam(m, { from: [s * (TOWER_W / 2 + 0.02), BAND_Y, pz], to: [s * (TOWER_W / 2 + 0.02), BAND_Y, -D / 2 + 0.1], size: [0.32, 0.16], side: [s, 0, 0], caps: false, back: false }, P.trim);
    // Wall band under the main roof's front edge: deep enough (0.24 m out)
    // to run up into the soffit just behind the roof's edge, so the sheet's
    // teal-over-cream shows there and not a strip of shaded soffit. It ends
    // in a cap over the corner pilaster.
    beam(m, { from: [s * (TOWER_W / 2 - 0.05), EAVE - 0.2, -D / 2 - 0.09], to: [s * (W / 2 + POST_PROUD), EAVE - 0.2, -D / 2 - 0.09], size: [0.36, 0.3], side: [0, 0, -1], caps: 'end', back: false, segments: 3 }, P.trim);
  }
  beam(m, { from: [-px, BAND_Y, TOWER_FRONT - 0.02], to: [px, BAND_Y, TOWER_FRONT - 0.02], size: [0.32, 0.16], side: [0, 0, -1], caps: false, back: false }, P.trim);
  beam(m, { from: [-W / 2 - POST_PROUD, EAVE - 0.2, D / 2 + 0.09], to: [W / 2 + POST_PROUD, EAVE - 0.2, D / 2 + 0.09], size: [0.36, 0.3], side: [0, 0, 1], caps: true, back: false, segments: 4 }, P.trim);
  // Cornice slab under the cap.
  const co = TOWER_W / 2 + CORNICE_OVER;
  roundedBox(m, { min: [-co, CORNICE, TZ - co], max: [co, CORNICE + CORNICE_H, TZ + co], radius: 0.1, segments: 2 }, P.trim);
  // f. Openings.
  // The landmark keeps its scheme's front door on every seed (the coral door
  // IS the sunny hall); the variant's door colour goes to the service door.
  door(m, { on: T.front, opening: DOOR, double: true, planks: 2, surround: 0, paint: base.door, handle: 'none' }, P);
  doorSurround(m, T.front, DOOR, 0.15, -0.1, P);
  doorPanels(m, T.front, DOOR, -0.1, base.door);
  knobs(m, T.front, DOOR, -0.1, P, 12);
  const plain = { sill: false, head: false };
  const LIT = { ...P, glassLit: LIT_GLASS };
  for (const side of [1, -1] as const) {
    windowUnit(m, { on: F.front, opening: frontWin(side), mullions: [3, 2], ...plain }, P);
    dressing(m, F.front, frontWin(side), P);
    // Hung in front of the sill slab, its top just under the sill's.
    if (c.flowerBoxes) flowerBox(m, { on: F.front, u: frontWin(side).u, v: frontWin(side).v - SURROUND - 0.03, width: c.frontW + 0.1, seed: seed * 2 + (side > 0 ? 1 : 0) }, P);
    windowUnit(m, { on: F.back, opening: rearWin(side), ...plain }, P);
    dressing(m, F.back, rearWin(side), P);
    for (const on of [F.left, F.right]) {
      // The lit one is the window nearest the street on the right-hand wall.
      const lit = c.lit === 1 && on === F.right && side === -1;
      const w0 = m.mark();
      windowUnit(m, { on, opening: sideWin(side), ...plain, lit }, LIT);
      if (lit) {
        const { v: y0, h } = sideWin(side);
        m.recolor((q, _n, col) => (col[0] > 0.85 && col[2] < 0.5 ? mix(LIT_LOW, LIT_HIGH, Math.min(1, Math.max(0, (q.y - y0) / h))) : undefined), w0);
      }
      dressing(m, on, sideWin(side), P);
    }
  }
  // Rear service door: at ground level in a cream case that stands in front
  // of the plinth (the sheet's rear view), so the masonry needs no gap.
  {
    const s = m.mark();
    const sw = 0.15;
    const foot: Opening = { ...REAR_DOOR, v: sw - 0.1, h: REAR_DOOR.v + REAR_DOOR.h - (sw - 0.1) };
    const segs = 2;
    frameRing(m, { inner: openingRing(REAR_DOOR, -0.012, 0, segs, true), outer: openingRing(foot, sw, 0, segs, true), z0: -0.03, z1: REAR_CASE, bevel: 0.035 }, soften(P.trim, 45));
    toFacade(m, s, F.back);
    const leaf = offsetFacade(F.back, REAR_CASE - 0.02);
    door(m, { on: leaf, opening: REAR_DOOR, double: true, planks: 2, surround: 0, paint: v.seed === 0 ? P.shutter : P.door, handle: 'none' }, P);
    knobs(m, leaf, REAR_DOOR, -0.1, P, 6);
  }
  // g. Attachments.
  steps(m, { on: T.front, u: 0, width: STEP_WIDTH, top: PLINTH, steps: 2, tread: STEP_TREAD, flare: STEP_FLARE }, P);
  for (const s of [1, -1]) {
    // On the face of the tower's pilasters, between the door surround's
    // shoulder and the belt blocks.
    if (c.lights === 'lamp') hallLamp(m, offsetFacade(T.front, POST_PROUD), s * px, 2.62, P);
    else wallLantern(m, { on: T.front, u: s * px, v: 2.93, reach: 0.34, proud: POST_PROUD }, P);
  }
  clock(m, [0, CLOCK_Y, TOWER_FRONT], CLOCK_R, c.time, P);
  if (c.finial !== 'block') capTopper(m, c.finial, P);

  // h. Dressing.
  c.pots.forEach((at, i) => planter(m, { at, radius: POT_R, height: POT_H, seed: seed * 7 + i, paint: i === 0 ? P.accent : P.trim }, P));
  cullHidden(m);
  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const roof = gableRoofInfo(ROOF);
  const wallTop = EAVE + 0.1;
  // The slopes as two stacked boxes, each topping out at the roof's height
  // half-way up its own strip (a box cannot roll, only turn in plan).
  const roofStep = (halfDepth: number, at: number): ColliderSpec => {
    const top = roof.heightAt(0, at);
    return { shape: 'box', center: [0, (wallTop + top) / 2, 0], half: [W / 2 + 0.3, (top - wallTop) / 2, halfDepth] };
  };
  const stepsOut = 2 * STEP_TREAD;
  const towerTop = CORNICE + CORNICE_H;
  return [
    // Walls, including the plinth's proud blocks.
    { shape: 'box', center: [0, wallTop / 2, 0], half: [W / 2 + 0.15, wallTop / 2, D / 2 + 0.15] },
    roofStep(D / 2 + 0.1, 2.2),
    roofStep(1.5, 0.7),
    // Tower shaft up to the cornice (the cap above it is out of any car's reach).
    { shape: 'box', center: [0, towerTop / 2, TZ], half: [TOWER_W / 2 + 0.15, towerTop / 2, TOWER_W / 2 + 0.15] },
    // Door steps on the street side, one box per step: lower 3.0 m wide,
    // 0.68 m out, 0.25 high; upper 2.6 m wide, 0.34 m out, 0.5 high.
    { shape: 'box', center: [0, PLINTH / 4, TOWER_FRONT - stepsOut / 2], half: [STEP_WIDTH / 2 + STEP_FLARE, PLINTH / 4, stepsOut / 2] },
    { shape: 'box', center: [0, PLINTH / 2, TOWER_FRONT - STEP_TREAD / 2], half: [STEP_WIDTH / 2, PLINTH / 2, STEP_TREAD / 2] },
    // Flower pots of this variant.
    ...c.pots.map(([x, z]): ColliderSpec => ({ shape: 'cylinder', base: [x, 0, z], height: POT_H + 0.05, radius: POT_R + 0.02 })),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b10-village-hall',
  name: 'B10 Village Hall',
  category: 'building',
  size: { x: 8.96, y: 7.6, z: 7.8 },
  variants: 3,
  schemes: ['sunny', 'warm', 'coastal'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/village-landmarks/design-sheet.png',
    brief: 'design-documents/building-design-pack/village-landmarks/b10-village-hall-brief.txt',
  },
  build,
  colliders,
};

export default asset;
