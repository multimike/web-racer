import { SolidMesh, box, compose, cylinder, extrudePolygon, paint, polygonFacing, rotation, roundedBox, roundedRectRing, soften, torus, translation, tube } from '../../gfx/solid';
import type { Vec2 } from '../../gfx/solid';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  boxFacades,
  cornerPosts,
  crate,
  emblem,
  EMBLEMS,
  finishBuilding,
  frameRing,
  frameSegments,
  openingRing,
  plankPanel,
  rib,
  schemePaints,
  shedRoof,
  solarPanel,
  stoneCourse,
  toFacade,
  variantPaints,
  variation,
  wallPanel,
  windowUnit,
  withPaints,
} from './parts';
import type { BuildingPaints, Facade, Opening, RoofInfo } from './parts';

/**
 * B02 — Workshop Shed. Turquoise board-and-batten utility shed under a thick
 * cobalt mono-pitch roof, mustard double doors in a chunky cream surround
 * with clipped top corners, a bulkhead lamp over them, one high window on
 * the right wall, a louvre vent at the back and a propped solar panel on the
 * roof.
 *
 * Sheet scheme: COASTAL (turquoise walls, cobalt roof, cream frames) — with
 * the sheet's mustard doors in place of the style guide's coral door. In
 * 'warm' the walls are cream themselves, so this shed's cream trim (posts,
 * cap, surrounds, vent) turns to timber there and the emblem to coral — cream
 * on cream erased the design's whole trim graphic. 'sunny' is as the guide
 * defines it.
 *
 * MAIN BODY 4.0 (x) × 3.5 (z) m. One roof plane falling across x only (the
 * brief's resolution of the sheet's conflicting views). HEIGHT follows the
 * brief's written numbers: the finished roof is 3.3 m at its high (left)
 * edge, with the walls at 3.0 m (left) / 2.5 m (right) under a 0.28 m slab —
 * the brief's 0.5 m fall. The cream cap blocks on the high edge stand 7 cm
 * above the slab, so the very top is ≈ 3.37 m (2 % over the brief's total).
 * The sheet's front inset is taller (≈ 0.93 height : width); the brief wins
 * on dimensions so the shed sits level with B01 in the village.
 * OVERALL 4.63 (x) × 4.16 (z) m including the roof's overhangs and the cap
 * (x −2.27 … 2.36, z ±2.08) — inside the 4.8 × 4.2 m placement envelope,
 * dressing included on every seed. `size.y` includes the 0.1 m plinth skirt.
 *
 * ROOF. The sheet's roof is a thick smooth slab in three broad panels: two
 * soft wide seams running eave to eave (not the kit's narrow standing-seam
 * ribs), the solar panel in one panel, never across a seam.
 *
 * DOORS. The sheet draws the pair 2.15 – 2.4 m wide, the brief says 1.8 m:
 * 2.0 × 2.1 m here (a lower wall leaves the bulkhead lamp room under the
 * eave). They stand wholly in FRONT of the wall face, so the wall carries no
 * opening behind them and its battens run on behind the surround — a cut
 * opening stopped them in mid-wall over the clipped corners. The doors reach
 * the ground: the plinth is cut away between the jambs, which stand prouder
 * than its stones and hide the cut.
 *
 * Opening schedule (brief): front = centred double doors; right = one high
 * window; rear = one small vent (a real recessed opening, so the boards stop
 * at its frame); left = plain.
 *
 * Seeds (the game instantiates 0 – 2): 0 = the sheet. 1 = no solar panel, a
 * spanner on the plain left wall, two slim crates under the window, three-
 * pane window. 2 = solar panel on the front half, a spare tyre hung on the
 * left wall and a slim crate beside it. Door colour cycles with the scheme
 * (`variantPaints`); window and vent widths and the high wall shift a few
 * centimeters. All dressing hugs the walls inside the placement envelope.
 */

const W = 4.0;
const D = 3.5;
const HIGH = 3.0;
const LOW = 2.5;
const PLINTH = 0.42;
const ROOF_THICK = 0.28;
const OVERHANG = { low: 0.32, high: 0.16, sides: 0.3 };
const POST = 0.36;
/** How far the cream cap blocks rise above the slab at the high edge. */
const CAP_RISE = 0.07;
/** The plinth's corner blocks: how far they run along each wall, stand out
 * of it (the courses stand 0.12) and rise above the courses. */
const CORNER = { leg: 0.5, proud: 0.17, rise: 0.04 };
/** z of the two broad roof seams (three panels ≈ 1.35 m wide). */
const SEAMS_Z = [-0.7, 0.7];

const DOOR_W = 2.0;
const DOOR_H = 2.1;
const DOOR_CHAMFER = 0.24;
const SURROUND = 0.18;
/** How far the surround's face stands out of the wall — prouder than the
 * plinth stones (0.12 – 0.145), whose cut ends are buried in the jambs. */
const SURROUND_PROUD = 0.17;
const LEAF_PROUD = 0.09;
/** Bulkhead lamp: centre and casing size. Its casing (2.33 – 2.63) has the
 * wall between the surround's head (2.28) and the roof (2.70 above its
 * right-hand end) to itself. */
const LAMP = { u: -0.08, v: 2.48, w: 0.72, h: 0.3 };

const TAN = (h: number): number => (h - LOW) / W;

// Local paints the palette has no entry for.
/** Solar cells: a deep navy at low gloss — the kit's glossy cells catch the
 * sky and read paler than the cobalt roof they sit on. */
const SOLAR_CELL = paint('#1C2F6E', { gloss: 0.22 });
/** The sheet's lamp: grey-bronze casing, warm cream-white glow. */
const LAMP_CASING = paint('#67626A', { gloss: 0.4, metal: 0.25 });
const LAMP_LENS = paint('#FFD596', { emissive: 0.7, gloss: 0.5 });

function choices(seed: number) {
  const v = variation(seed, 'b02');
  return {
    v,
    high: HIGH + v.shift('high', 0.05),
    solar: v.cycle(['back', 'none', 'front'] as const),
    sign: v.cycle([false, true, false] as const),
    /** Two slim crates under the window on the right wall. */
    stores: v.cycle([false, true, false] as const),
    /** A spare tyre hung on the plain left wall, a crate beside it. */
    tyre: v.cycle([false, false, true] as const),
    panes: v.cycle([2, 3, 2] as const),
    winW: 1.22 + v.shift('winW', 0.08),
    winU: 0.25 + v.shift('winU', 0.12),
    ventW: 0.86 + v.shift('ventW', 0.08),
  };
}

/** Roof surface height above plan x (same formula as the kit's `shedRoof`). */
function roofTopAt(x: number, high: number): number {
  const tan = TAN(high);
  return (high + LOW) / 2 - x * tan + ROOF_THICK * Math.hypot(1, tan);
}

/**
 * D02 as the sheet draws it: a pair of framed, boarded leaves under a cream
 * surround whose top corners are CLIPPED at 45° (the kit's `door` rounds
 * them), short chunky hinge plates with a knuckle block on the surround, two
 * bar pulls. Everything stands in FRONT of the wall face.
 */
function shedDoors(m: SolidMesh, o: { on: Facade }, P: BuildingPaints): void {
  const start = m.mark();
  const a = DOOR_W / 2;
  const h = DOOR_H;
  const c = DOOR_CHAMFER;
  const s = SURROUND;
  const sill = 0.045;
  // A 45° clip offset outward by s keeps the band's width if its ends move tan(22.5°)·s.
  const k = Math.tan(Math.PI / 8);
  const inner: Vec2[] = [[a, sill], [a, h - c], [a - c, h], [-(a - c), h], [-a, h - c], [-a, sill]];
  const outer: Vec2[] = [[a + s, -0.1], [a + s, h - c + k * s], [a - c + k * s, h + s], [-(a - c + k * s), h + s], [-(a + s), h - c + k * s], [-(a + s), -0.1]];
  // The ring's bottom bar is the threshold.
  frameRing(m, { inner, outer, z0: -0.03, z1: SURROUND_PROUD, bevel: 0.05 }, soften(P.trim, 45));

  // Dark strip behind the hairline gap where the two leaves meet.
  box(m, { min: [-0.05, 0.02, 0.02], max: [0.05, h + 0.02, 0.05], faces: { nz: null, px: null, nx: null, py: null, ny: null } }, P.iron);

  const half = m.mark();
  const gap = 0.007;
  const g = 0.02;
  const stile = 0.17;
  const meet = 0.13;
  const railLow = sill + 0.2;
  const railTop = h - 0.2;
  // Leaf frame: clipped outside, square inside (the top-right corner of the
  // inner ring is doubled to pair with the two ends of the clip).
  const leafOuter: Vec2[] = [[gap, 0.02], [a + g, 0.02], [a + g, h - c + k * g], [a - c + k * g, h + g], [gap, h + g]];
  const leafInner: Vec2[] = [[meet, railLow], [a - stile, railLow], [a - stile, railTop], [a - stile, railTop], [meet, railTop]];
  frameRing(m, { inner: leafInner, outer: leafOuter, z0: 0.03, z1: LEAF_PROUD, bevel: 0.02 }, P.door);
  // Two recessed boards; their faces end inside the frame so they bake in the open.
  plankPanel(m, { x0: meet - 0.02, x1: a - stile + 0.02, y0: railLow - 0.02, y1: railTop + 0.02, z0: 0.03, z1: LEAF_PROUD - 0.032, planks: 2, groove: 0.016, edge: 0.04, rim: false, rows: 3 }, P.door);
  // Hinges as the sheet draws them: short square-ended plates (0.3 × 0.12)
  // on the leaf, a knuckle block on the surround's inner edge, two bolts.
  for (const y of [0.55, 1.6]) {
    roundedBox(m, { min: [a - 0.06, y - 0.08, 0.07], max: [a + 0.09, y + 0.08, SURROUND_PROUD + 0.04], radius: 0.025, segments: 1 }, P.iron);
    roundedBox(m, { min: [a - 0.32, y - 0.06, LEAF_PROUD - 0.012], max: [a - 0.02, y + 0.06, LEAF_PROUD + 0.03], radius: 0.014, segments: 1 }, P.iron);
    for (const x of [a - 0.27, a - 0.13]) {
      cylinder(m, { from: [x, y, LEAF_PROUD + 0.02], to: [x, y, LEAF_PROUD + 0.042], radius: 0.018, sides: 6, caps: 'top' }, P.metal);
    }
  }
  // Bar pull: one bent rod, both feet sunk in the meeting stile.
  const zh = LEAF_PROUD + 0.085;
  tube(m, { path: [[0.075, 0.84, LEAF_PROUD - 0.015], [0.075, 0.84, zh], [0.075, 1.26, zh], [0.075, 1.26, LEAF_PROUD - 0.015]], radius: 0.034, sides: 6, fillet: 0.055, filletSegments: 2, caps: false }, P.iron);
  m.mirrorCopy('x', half);
  toFacade(m, start, o.on);
}

/**
 * L01 as the sheet draws it on this shed: a smooth PILL casing in grey-bronze
 * (the kit's lamp is a clipped octagon at this size), a warm cream-white
 * lens, a cross of cage bars whose ends sit on the casing's rim, and the
 * conduit boss on the right-hand end.
 */
function bulkheadLamp(m: SolidMesh, on: Facade): void {
  const start = m.mark();
  const { u, v, w, h } = LAMP;
  const ring = (rw: number, rh: number, cs: number): Vec2[] => roundedRectRing(rw, rh, rh / 2 - 0.004, cs);
  // Conduit boss first, half buried in the casing's end.
  roundedBox(m, { min: [u + w / 2 - 0.08, v - 0.07, -0.02], max: [u + w / 2 + 0.09, v + 0.07, 0.07], radius: 0.03, segments: 1 }, LAMP_CASING);
  extrudePolygon(m, { outline: ring(w, h, 5), depth: 0.1, bevel: 0.035, bevelSegments: 2, back: false, at: [u, v, -0.02] }, soften(LAMP_CASING, 60));
  const rim = 0.06;
  const lw = w - rim * 2;
  const lh = h - rim * 2;
  extrudePolygon(m, { outline: ring(lw, lh, 4), depth: 0.065, bevel: 0.025, bevelSegments: 2, back: false, at: [u, v, 0.04] }, soften(LAMP_LENS, 60));
  const bar = 0.032;
  // Bar ends land 2 cm onto the rim, sunk 1 cm into the casing's face.
  box(m, { min: [u - lw / 2 - 0.02, v - bar / 2, 0.07], max: [u + lw / 2 + 0.02, v + bar / 2, 0.125], faces: { nz: null } }, LAMP_CASING);
  box(m, { min: [u - bar / 2, v - lh / 2 - 0.02, 0.07], max: [u + bar / 2, v + lh / 2 + 0.02, 0.122], faces: { nz: null } }, LAMP_CASING);
  toFacade(m, start, on);
}

/**
 * The rear vent as a real opening: the wall is cut (so its battens stop at
 * the frame instead of showing through the slats), a dark recess panel
 * closes the hole 10 cm in, three cream louvre slats span it with their ends
 * buried in the reveal, and a chunky rounded-rectangle frame covers the cut.
 */
function rearVent(m: SolidMesh, o: { on: Facade; opening: Opening; frame: number }, P: BuildingPaints): void {
  const start = m.mark();
  const op = o.opening;
  const back = openingRing(op, 0.02, 0, 3, true).map(([x, y]) => new Vector3(x, y, -0.1));
  polygonFacing(m, back, new Vector3(0, 0, 1), P.iron);
  const n = 3;
  for (let i = 0; i < n; i++) {
    const y = op.v + ((i + 0.5) / n) * op.h;
    const s = m.mark();
    box(m, { min: [op.u - op.w / 2 - 0.03, -0.022, -0.05], max: [op.u + op.w / 2 + 0.03, 0.022, 0.05], faces: { px: null, nx: null } }, soften(P.trim, 45));
    // Louvres lean down and out, as rain shedders do.
    m.rotate('x', 28, s);
    m.translate([0, y, -0.05], s);
  }
  const outerR = (op.round ?? 0) + o.frame;
  const segs = frameSegments(outerR);
  frameRing(
    m,
    { inner: openingRing(op, -0.03, 0.02, segs, true), outer: openingRing(op, o.frame, 0.08, segs, true), z0: -0.03, z1: 0.075, bevel: 0.03 },
    soften(P.trim, 45),
  );
  toFacade(m, start, o.on);
}

/**
 * The sheet's solar panel: propped 16° off the roof on two grey bracket legs
 * under its raised (back) edge and a low hinge rail along its front edge,
 * dark navy cells. Built flat with the kit's panel, tipped here, then laid
 * on the slope.
 */
function proppedSolar(m: SolidMesh, at: readonly [number, number], roof: RoofInfo, P: BuildingPaints): void {
  const start = m.mark();
  const [w, d] = [1.4, 0.95];
  const tilt = 16;
  solarPanel(m, { at: [0, 0, 0], size: [w, d], cells: [4, 2] }, withPaints(P, { solar: SOLAR_CELL }));
  m.rotate('x', -tilt, start, [0, 0, -d / 2]);
  const rad = (tilt * Math.PI) / 180;
  const legZ = -d / 2 + (d - 0.1) * Math.cos(rad);
  const legTop = (d - 0.1) * Math.sin(rad) + 0.02;
  const legPaint = paint(P.metal, { color: [0.55, 0.56, 0.6], gloss: 0.4 });
  for (const x of [-w / 2 + 0.18, w / 2 - 0.18]) {
    cylinder(m, { from: [x, -0.06, legZ], to: [x, legTop, legZ], radius: 0.028, sides: 6, caps: 'top' }, legPaint);
    // Foot plate on the roof.
    roundedBox(m, { min: [x - 0.07, -0.05, legZ - 0.06], max: [x + 0.07, 0.0, legZ + 0.06], radius: 0.015, segments: 1 }, legPaint);
  }
  roundedBox(m, { min: [-w / 2 + 0.12, -0.06, -d / 2 - 0.02], max: [w / 2 - 0.12, 0.035, -d / 2 + 0.07], radius: 0.02, segments: 1 }, legPaint);
  const r = roof.tiltAt(at[0], at[1]);
  m.transform(compose(rotation('x', r[0]), rotation('y', r[1]), rotation('z', r[2]), translation(at[0], roof.heightAt(at[0], at[1]) + 0.03, at[1])), start);
}

/**
 * The plinth as the sheet draws it here: the kit's irregular stone courses
 * (`stoneCourse`, each with its own dark backing) between four BIG corner
 * blocks that stand proud under the posts and rise a little above the
 * courses — the kit's `stonePlinth` wraps its corners in a slim L-stone
 * instead (and that stone's top shows a dark notch at the arris). The front
 * course stops at the door jambs, which stand prouder and bury its ends; the
 * doors reach the ground between them.
 */
function shedPlinth(m: SolidMesh, seed: number, P: BuildingPaints): void {
  const skirt = 0.1;
  const proud = 0.12;
  const F = boxFacades(W, D);
  // One plate under everything: a building seen from below stays closed.
  const g = CORNER.proud + 0.01;
  polygonFacing(
    m,
    [new Vector3(-W / 2 - g, -skirt, -D / 2 - g), new Vector3(W / 2 + g, -skirt, -D / 2 - g), new Vector3(W / 2 + g, -skirt, D / 2 + g), new Vector3(-W / 2 - g, -skirt, D / 2 + g)],
    new Vector3(0, -1, 0),
    P.stoneDark,
  );
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const s = m.mark();
      const xa = sx * (W / 2 + CORNER.proud);
      const xb = sx * (W / 2 - CORNER.leg);
      const za = sz * (D / 2 + CORNER.proud);
      const zb = sz * (D / 2 - CORNER.leg);
      roundedBox(m, { min: [Math.min(xa, xb), -skirt, Math.min(za, zb)], max: [Math.max(xa, xb), PLINTH + CORNER.rise, Math.max(za, zb)], radius: 0.075, segments: 2 }, P.stone);
      // Sunlit top planes a tone lighter, as on the sheet.
      m.repaint((_c, n) => (n.y > 0.6 ? P.stoneLight : undefined), s);
    }
  }
  // Each course starts and ends 6 cm INSIDE a corner block (or a jamb): its
  // end stones and backing are buried there, so no joint opens onto the
  // hollow under the walls.
  const leg = CORNER.leg - 0.06;
  const course = (on: Facade, u0: number, u1: number): void => stoneCourse(m, { on, u0, u1, bottom: -skirt, top: PLINTH, proud, blockLength: [0.45, 0.9], seed }, P);
  const cut = DOOR_W / 2 + SURROUND / 2;
  course(F.front, -W / 2 + leg, -cut);
  course(F.front, cut, W / 2 - leg);
  course(F.back, -W / 2 + leg, W / 2 - leg);
  course(F.left, -D / 2 + leg, D / 2 - leg);
  course(F.right, -D / 2 + leg, D / 2 - leg);
}

/** A spare buggy tyre hung on a peg flat against a wall (workshop dressing):
 * a chunky matte torus, its back sunk a few mm into the boards. */
function hungTyre(m: SolidMesh, o: { on: Facade; u: number; v: number }, P: BuildingPaints): void {
  const start = m.mark();
  const rubber = paint(P.iron, { color: [0.2, 0.2, 0.23], gloss: 0.2, metal: 0 });
  const tubeR = 0.12;
  const k = 0.8;
  torus(m, { radius: 0.3, tube: tubeR, segments: 14, sides: 6, tubeScaleY: k, rot: [90, 0, 0], at: [o.u, o.v, tubeR * k - 0.006] }, rubber);
  // Peg through the hub, up against the tyre's inner top.
  cylinder(m, { from: [o.u, o.v + 0.17, -0.02], to: [o.u, o.v + 0.17, 0.3], radius: 0.035, sides: 6, caps: 'top', bevel: { top: 0.012 }, bevelSegments: 1 }, P.iron);
  toFacade(m, start, o.on);
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'coastal');
  let P = variantPaints(base.scheme === 'coastal' ? withPaints(base, { door: BUILDING.mustard }) : base, v);
  if (P.scheme === 'warm') {
    // Timber trim on the cream walls; a door that would match it goes cobalt.
    P = withPaints(P, { trim: P.timber });
    const dc = P.door.color;
    const tc = P.timber.color;
    if (Math.hypot(dc[0] - tc[0], dc[1] - tc[1], dc[2] - tc[2]) < 0.1) P = withPaints(P, { door: BUILDING.cobalt });
  }
  const emblemPaint = P.scheme === 'warm' ? P.accent : P.trim;
  const m = new SolidMesh();
  const high = c.high;
  const F = boxFacades(W, D);

  // a. Roof: a plain slab with two broad, soft seams running eave to eave.
  const roof = shedRoof(m, { width: W, depth: D, low: LOW, high, fall: '+x', overhang: OVERHANG, thickness: ROOF_THICK, covering: 'plain' }, P);
  {
    const rise = high - LOW;
    const len = Math.hypot(W, rise);
    const cs = W / len;
    const sn = rise / len;
    const tan = rise / W;
    const t = ROOF_THICK;
    // Top-surface ends of the slab (the kit's `shedRoof` outline).
    const Ht: Vec2 = [-W / 2 - OVERHANG.high + t * sn, high + OVERHANG.high * tan + t * cs];
    const Lt: Vec2 = [W / 2 + OVERHANG.low + t * sn, LOW - OVERHANG.low * tan + t * cs];
    // Start under the cream fascia, stop just short of the nose's chamfer.
    const a0: Vec2 = [Ht[0] + cs * 0.08, Ht[1] - sn * 0.08];
    const a1: Vec2 = [Lt[0] - cs * 0.06, Lt[1] + sn * 0.06];
    const length = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    for (const z of SEAMS_Z) {
      rib(m, [a0[0], a0[1], z], [a1[0], a1[1], z], [sn, cs, 0], { width: 0.13, topWidth: 0.075, height: 0.04, breakAt: length * 0.5 }, soften(P.roof, 70));
    }
  }

  // b. Plinth: the kit's masonry courses between four chunky corner blocks of
  // this file's own, the front course stopping at the door jambs.
  shedPlinth(m, seed, P);

  // c. Walls: front and back follow the roof, the left one is the high wall.
  // The front wall has no door opening (see the file comment).
  const bottom = PLINTH - 0.1;
  const t = 0.25;
  const boards = { direction: 'vertical' as const, pitch: 0.44 };
  const WIN: Opening = { u: c.winU, v: 1.66, w: c.winW, h: 0.44 };
  const VENT: Opening = { u: 0, v: 1.96, w: c.ventW, h: 0.4, round: 0.08, roundAll: true };
  wallPanel(m, { on: F.front, width: W, bottom, top: [high, LOW], thickness: t, boards }, P.wall);
  wallPanel(m, { on: F.back, width: W, bottom, top: [LOW, high], thickness: t, openings: [VENT], boards }, P.wall);
  const sideWidth = D - 2 * t + 0.02;
  wallPanel(m, { on: F.left, width: sideWidth, bottom, top: high, thickness: t, boards }, P.wall);
  wallPanel(m, { on: F.right, width: sideWidth, bottom, top: LOW, thickness: t, openings: [WIN], boards }, P.wall);

  // d. Cream corner posts up into the roof.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.05, top: high + 0.03, size: POST, corners: ['fl', 'bl'] }, P.trim);
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.05, top: LOW + 0.03, size: POST, corners: ['fr', 'br'] }, P.trim);

  // e. The roof's high edge: a cream cap block on each left-hand post (the
  // sheet's signature corner) and a slimmer fascia board between them. All
  // three top out level and swallow the slab's nose and the seams' ends.
  {
    const x0 = -W / 2 - 0.27;
    const x1 = -W / 2 + POST - 0.06 - 0.02;
    const y0 = high - 0.1;
    const y1 = roofTopAt(-W / 2 - OVERHANG.high, high) + CAP_RISE;
    const zEnd = D / 2 + OVERHANG.sides + 0.03;
    const cream = soften(P.trim, 45);
    const block = x1 - x0;
    for (const sz of [1, -1]) {
      roundedBox(m, { min: [x0, y0, sz > 0 ? zEnd - block : -zEnd], max: [x1, y1, sz > 0 ? zEnd : -zEnd + block], radius: 0.07, segments: 2 }, cream);
    }
    beam(m, { from: [x0 + 0.15, (y0 + y1) / 2 + 0.03, -zEnd + block - 0.05], to: [x0 + 0.15, (y0 + y1) / 2 + 0.03, zEnd - block + 0.05], size: [0.22, y1 - y0 - 0.1], side: [0, 1, 0], chamfer: 0.05, segments: 3, caps: false }, cream);
  }

  // f. Openings.
  shedDoors(m, { on: F.front }, P);
  // Surround 0.16 wide = the boards' clearance, so the battens end on it.
  // Sash in the wall colour where the scheme's frame is cream too.
  windowUnit(m, { on: F.right, opening: WIN, surround: 0.16, mullions: [c.panes, 1], frame: 0.06, framePaint: P.scheme === 'coastal' ? P.wall : P.frame }, P);
  rearVent(m, { on: F.back, opening: VENT, frame: 0.16 }, P);

  // g. Attachments.
  bulkheadLamp(m, F.front);
  if (c.solar !== 'none') proppedSolar(m, c.solar === 'back' ? [0.78, 1.38] : [-0.2, -1.38], roof, P);
  // Bolt heads on the roof's front and back fascias.
  for (const sz of [1, -1]) {
    for (const x of [-1.6, 2.1]) {
      const y = roofTopAt(x, high) - ROOF_THICK * 0.55;
      const z = sz * (D / 2 + OVERHANG.sides);
      cylinder(m, { from: [x, y, z - sz * 0.02], to: [x, y, z + sz * 0.022], radius: 0.035, sides: 6, caps: 'top', bevel: { top: 0.012 }, bevelSegments: 1 }, P.metal);
    }
  }
  if (c.sign) emblem(m, { on: F.left, u: 0, v: 1.7, size: 1.6, outline: EMBLEMS.wrench, turn: 18 }, emblemPaint);

  // h. Dressing — slim, against the walls, inside the 4.8 × 4.2 envelope
  // (the plinth's stone face is at ±2.15 in x).
  if (c.stores) {
    crate(m, { at: [W / 2 + 0.27, -0.62], size: [0.62, 0.44, 0.24], rotY: 90, produce: P.accent, seed }, P);
    crate(m, { at: [W / 2 + 0.27, 0.12], size: [0.56, 0.36, 0.24], rotY: 93, seed: seed + 7 }, P);
  }
  if (c.tyre) {
    hungTyre(m, { on: F.left, u: 0.45, v: 1.45 }, P);
    crate(m, { at: [-W / 2 - 0.27, 0.95], size: [0.6, 0.42, 0.24], rotY: 88, seed }, P);
  }
  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const wallTop = LOW + 0.1;
  const x0 = -W / 2 - 0.27;
  const zHalf = D / 2 + OVERHANG.sides;
  const capTop = roofTopAt(-W / 2 - OVERHANG.high, c.high) + CAP_RISE;
  // The roof as three steps climbing toward the high (−x) edge; each tops
  // out at the roof's height 0.5 m inside its own low end.
  const roofStep = (xEnd: number): ColliderSpec => {
    const top = roofTopAt(xEnd - 0.5, c.high);
    return { shape: 'box', center: [(x0 + xEnd) / 2, (wallTop + top) / 2, 0], half: [(xEnd - x0) / 2, (top - wallTop) / 2, zHalf] };
  };
  const out: ColliderSpec[] = [
    // Walls, including the plinth's proud blocks and the door surround.
    { shape: 'box', center: [0, wallTop / 2, -0.02], half: [W / 2 + 0.15, wallTop / 2, D / 2 + 0.17] },
    ...[W / 2 + OVERHANG.low, 0.9, -0.6].map(roofStep),
    // The cream cap along the high edge.
    { shape: 'box', center: [-W / 2 + 0.005, (wallTop + capTop) / 2, 0], half: [0.275, (capTop - wallTop) / 2, zHalf + 0.03] },
  ];
  if (c.stores) out.push({ shape: 'box', center: [W / 2 + 0.27, 0.22, -0.25], half: [0.13, 0.22, 0.65] });
  if (c.tyre) out.push({ shape: 'box', center: [-W / 2 - 0.27, 0.21, 0.95], half: [0.13, 0.21, 0.31] });
  return out;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b02-workshop-shed',
  name: 'B02 Workshop Shed',
  category: 'building',
  size: { x: 4.63, y: 3.47, z: 4.16 },
  variants: 3,
  schemes: ['coastal', 'warm', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/shacks/design-sheet.png',
    brief: 'design-documents/building-design-pack/shacks/b02-workshop-shed-brief.txt',
  },
  build,
  colliders,
};

export default asset;
