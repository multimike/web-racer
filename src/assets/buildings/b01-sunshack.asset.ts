import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, bakeAO, blob, cylinder, extrudePolygon, frustum, hex, lighten, paint, polygonFacing, quadFacing, rng, roundedBox, shade, soften, sphere } from '../../gfx/solid';
import type { Paint, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  barrel,
  beam,
  cornerPosts,
  crate,
  door,
  finishBuilding,
  frameRing,
  gableRoof,
  gableRoofInfo,
  lantern,
  openingRing,
  pillow,
  plankPanel,
  planter,
  post,
  rib,
  schemePaints,
  solarPanel,
  stonePlinth,
  toFacade,
  variantPaints,
  variation,
  wallBox,
  wallLamp,
  windowUnit,
  withPaints,
} from './parts';
import type { BuildingPaints, Facade, Opening } from './parts';

/**
 * B01 — Sunshack. Porch shack: mustard lapped boards, coral seamed gable
 * roof, teal door and mint window frames, and a timber porch (deck, two
 * posts, open truss) under the roof's long front overhang.
 *
 * MAIN BODY 4.0 (x) × 3.0 (z) m, walls to the 2.45 m eave. The gable ends
 * face front (−z) and back, so the ridge runs along z (the brief's +Y).
 * Stone plinth to 0.5 m; the porch deck (0.52 m) covers it at the front and
 * stands on a lower plinth of its own.
 * OVERALL 4.74 × 4.57 × 4.13 m (x ±2.37, z −2.72 … +1.85) with bargeboards,
 * kneelers, porch and step — inside the brief's 4.8 × 4.6 m placement
 * envelope with centimeters to spare, which is why nothing in any variant
 * stands on the ground beside the building: all dressing is on the porch.
 *
 * SCHEME. The sheet is SUNNY (mustard boards) with a coral roof and a teal
 * door where the style guide's 'sunny' has a teal roof and a coral door; the
 * hero scheme overrides those two paints (`withPaints`, the kit's pattern
 * for a sheet that is none of the three schemes exactly). 'warm' and
 * 'coastal' build exactly as the guide defines them.
 *
 * HEIGHT — THE SHEET WINS OVER THE BRIEF, as on the Gable Cottage and as
 * parts.ts rule 10 says ("keep the brief's eave and take the pitch from the
 * drawing"). The brief says "front eave 2.5 m, ridge 3.3 m" (a 22° roof);
 * every view of the sheet draws a 35° gable as tall as the walls under it,
 * 4.13 m to the top of the apex saddle at this width (measured on the
 * sheet's front view against the 4 m plinth: ~3.9 – 4.1 m). src/world/
 * catalog.ts still lists 3.3 m. `RISE` sets the pitch, and bargeboards,
 * truss, seams and colliders follow it.
 *
 * NOT FROM THE KIT, and why:
 *  - bargeboards: this sheet draws a mitred pair with a kneeler block on
 *    each lower end and a low saddle bent over the apex, not the cottages'
 *    crossed boards under a 0.7 m round boss (see `bargeboards`);
 *  - the porch truss stands free and is seen from behind, so it is closed
 *    beams, not the wall-mounted, open-backed `gableFraming`;
 *  - roof seams: the kit spaces them over the whole slab, which leaves short
 *    end panels against bargeboards that stand this far out; the sheet has
 *    five equal panels between the boards (`roofSeams`);
 *  - door: the sheet's door has a 45° chamfered head, the kit's arches, and
 *    its strap hinges have a knuckle barrel (`shackDoor`);
 *  - windows: flat square-cornered mint frames, not the kit's pillow
 *    surround (`shackWindow`);
 *  - lapped boards instead of the kit's battens, laid AFTER `finishBuilding`
 *    and baked on their own (see `lapBoards`) — with board geometry in place
 *    during the bake every wall vertex that happens to lie beside a lap bakes
 *    darker and plain walls come out in grey wedges.
 *
 * Opening schedule (brief): front = door left + one window right; right
 * side = one window; rear = one centred window; left side plain. The door
 * is 1.0 × 1.58 m, not the nominal 2.2: the sheet's door stops one board
 * under the 2.4 m tie beam.
 *
 * Seeds: 0 = the sheet. The game instantiates 0 – 2, so everything that
 * shows at a glance cycles: door colour (`variantPaints`, with this
 * building's timber posts kept off the door); 1 = lantern under the tie
 * beam, shutters on the side and rear windows, barrel and crate on the
 * porch; 2 = bulkhead lamp beside the door, flower box and pot, closed rear
 * shutters, a solar panel on the right slope. Window width and ridge height
 * shift by a few centimeters.
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

const W = 4.0;
const D = 3.0;
const EAVE = 2.45;
const PLINTH = 0.5;
const WALL_BOTTOM = PLINTH - 0.1;
/** Rise of the roof's underside from the eave line to the ridge: 34.8°, the
 * sheet's pitch. */
const RISE = 1.39;
const ROOF_THICK = 0.14;
/** Side eaves: the slab runs out to the kneelers' outer corners, as drawn. */
const EAVE_OVERHANG = 0.23;
/** Outer faces of the bargeboards: how far in front of the front wall /
 * behind the back wall. */
const ROOF_FRONT = 0.95;
const ROOF_BACK = 0.3;
/** Bargeboards: depth across the slope, thickness along the ridge, how far
 * their top stands above the roof surface (clear of the seams) and how far
 * their lower end runs past the slab's edge. */
const BARGE_DEPTH = 0.36;
const BARGE_THICK = 0.3;
const BARGE_LIFT = 0.065;
const BARGE_OVERSHOOT = 0.02;
/** Six boards from the wall's foot to the eave, as drawn. */
const BOARD_PITCH = (EAVE - WALL_BOTTOM) / 6;

/** Porch: the deck's reach from the front wall, its half width, the height
 * of its boards (= the door threshold) and its thickness. */
const PORCH = 0.84;
const DECK_HALF = 2.14;
const DECK_TOP = 0.52;
const DECK_THICK = 0.18;
/** Posts and the truss they carry stand this far in front of the wall. */
const POST_OUT = 0.6;
const POST_X = 1.82;
const POST = 0.36;
const BEAM_BOTTOM = 2.4;
const BEAM_H = 0.3;

/** The step sits between the door and the middle of the porch, as drawn. */
const STEP_U = -0.5;
const STEP_W = 1.7;
const STEP_H = 0.26;
const STEP_OUT = 0.36;

const DOOR_U = -0.75;
/** The wall's cut is arched (the kit's walls cut round corners only); the
 * chamfered surround covers it. */
const DOOR: Opening = { u: DOOR_U, v: DECK_TOP, w: 1.0, h: 1.58, round: 0.14 };
const DOOR_SURROUND = 0.15;
/** The sheet's door head: 45° chamfers of this size in the surround's inner
 * outline. */
const DOOR_CHAMFER = 0.17;
const WINDOW_U = 0.78;
const SURROUND = 0.1;

/** The kit's roof without its bargeboards or seams: the slab stops 7 cm
 * inside the outer faces of this building's own boards. */
const ROOF = {
  span: W,
  length: D,
  eave: EAVE,
  thickness: ROOF_THICK,
  overhang: { eave: EAVE_OVERHANG, gable: [ROOF_FRONT - BARGE_THICK + 0.07, ROOF_BACK - BARGE_THICK + 0.07] as const },
  bargeboards: false,
  covering: 'plain' as const,
};

/** Secondary choices of one variant (seed 0 = the sheet). */
function choices(seed: number) {
  const v = variation(seed, 'b01');
  return {
    v,
    sideShutters: v.cycle(['none', 'open', 'none'] as const),
    rearShutters: v.cycle(['none', 'open', 'closed'] as const),
    lamp: v.cycle(['none', 'lantern', 'bulkhead'] as const),
    /** Barrel and crate on the porch, under the window. */
    stores: v.cycle([false, true, false] as const),
    flowerBox: v.cycle([false, false, true] as const),
    pot: v.cycle([false, false, true] as const),
    solar: v.cycle([false, false, true] as const),
    winW: 0.84 + v.shift('winW', 0.04),
    rise: RISE + v.shift('ridge', 0.07),
  };
}

/** Slope numbers of the roof for a given rise. */
function slope(rise: number) {
  const half = W / 2;
  const len = Math.hypot(half, rise);
  return { half, c: half / len, sn: rise / len, tan: rise / half, pitch: (Math.atan2(rise, half) * 180) / Math.PI };
}

/** Height of the bargeboards' top line at the apex. */
const bargeApex = (rise: number): number => EAVE + rise + (ROOF_THICK + BARGE_LIFT) / slope(rise).c;

/**
 * The gable-end trim as THIS sheet draws it: the two cream bargeboards as
 * one mitred chevron, a chunky kneeler block wrapping each lower end and a
 * low saddle bent over the apex. Same board thickness and edge softness as
 * the kit's. `z` = centre of the boards' thickness.
 */
function bargeboards(m: SolidMesh, o: { z: number; rise: number }, p: Paint): void {
  const { half, c, sn, tan, pitch } = slope(o.rise);
  // Top line of the boards and its lower end, just past the roof's edge.
  const yApex = bargeApex(o.rise);
  const xEnd = half + EAVE_OVERHANG + ROOF_THICK * sn + BARGE_OVERSHOOT;
  const yEnd = yApex - xEnd * tan;
  const bd = BARGE_DEPTH;
  const chevron: Vec2[] = [[0, yApex - bd / c], [xEnd - bd * sn, yEnd - bd * c], [xEnd, yEnd], [0, yApex], [-xEnd, yEnd], [-xEnd + bd * sn, yEnd - bd * c]];
  extrudePolygon(m, { outline: chevron, depth: BARGE_THICK, centered: true, bevel: 0.06, bevelSegments: 2, bevelBack: true, at: [0, 0, o.z] }, soften(p, 46));
  for (const s of [1, -1]) {
    // Kneeler: 0.2 m up the slope from the board's end, centred on its depth.
    const x = xEnd - 0.2 * c - (bd / 2) * sn;
    const y = yEnd + 0.2 * sn - (bd / 2) * c;
    roundedBox(m, { size: [0.5, bd + 0.09, BARGE_THICK + 0.09], radius: 0.07, segments: 2, rot: [0, 0, -pitch * s], at: [s * x, y, o.z] }, p);
  }
  // Apex saddle: a short sleeve of the chevron's own outline, 5 cm proud of
  // the boards' top, 3 cm below their underside and 4 cm proud front and
  // back — the sheet's low bent cap, not a block standing on the mitre.
  // Its crown is blunted (two points 7 cm either side of the apex, half-way
  // down the slope's drop) so the bevel rounds it instead of sharpening it.
  const a = 0.21;
  const yT = (x: number): number => yApex + 0.05 / c - Math.abs(x) * tan;
  const yB = (x: number): number => yApex - (bd + 0.03) / c - Math.abs(x) * tan;
  const crown = yT(0) - 0.035 * tan;
  const saddle: Vec2[] = [[0, yB(0)], [a, yB(a)], [a, yT(a)], [0.07, crown], [-0.07, crown], [-a, yT(-a)], [-a, yB(-a)]];
  extrudePolygon(m, { outline: saddle, depth: BARGE_THICK + 0.08, centered: true, bevel: 0.035, bevelSegments: 2, bevelBack: true, at: [0, 0, o.z] }, soften(p, 46));
}

/**
 * The open truss at the front of the porch, in the plane z = `z`: tie beam
 * on the posts, king post, two struts and the rake boards that show under
 * the cream bargeboards. Every member is a closed beam.
 */
function porchTruss(m: SolidMesh, o: { z: number; rise: number }, p: Paint): void {
  const { half, c, tan } = slope(o.rise);
  const side: [number, number, number] = [0, 0, -1];
  // Rake boards: top edge 2 cm inside the roof slab, lower edge 12 cm below
  // the bargeboard's.
  const rakeDepth = 0.3;
  const drop = (rakeDepth / 2 - 0.02) / c;
  const rakeY = (x: number): number => EAVE + (half - Math.abs(x)) * tan - drop;
  const beamTop = BEAM_BOTTOM + BEAM_H;
  // Members differ a little in thickness and stand at slightly different
  // depths: where they cross, no two faces share a plane.
  for (const s of [1, -1]) {
    const xe = half - 0.12;
    beam(m, { from: [0, rakeY(0), o.z + 0.006], to: [s * xe, rakeY(xe), o.z + 0.006], size: [rakeDepth, 0.18], side, segments: 3 }, p);
    // Strut: from the king post's foot up to the rake at 42°.
    const ta = Math.tan((42 * Math.PI) / 180);
    const x = (rakeY(0) - beamTop - 0.02) / (ta + tan) + 0.04;
    beam(m, { from: [0, beamTop + 0.02, o.z], to: [s * x, beamTop + 0.02 + ta * x, o.z], size: [0.19, 0.16], side }, p);
  }
  beam(m, { from: [0, beamTop - 0.05, o.z - 0.004], to: [0, rakeY(0) + 0.02, o.z - 0.004], size: [0.24, 0.2], side }, p);
  beam(m, { from: [-POST_X, BEAM_BOTTOM + BEAM_H / 2, o.z - 0.01], to: [POST_X, BEAM_BOTTOM + BEAM_H / 2, o.z - 0.01], size: [BEAM_H, 0.24], side, segments: 4 }, p);
}

/**
 * The timber rake boards on the REAR gable (sheet, rear view): a band on the
 * wall face showing 12 cm below the cream bargeboards, whose top edge it
 * runs into. Their feet run into the cream corner boards.
 */
function rearRake(m: SolidMesh, rise: number, p: Paint): void {
  const { half, c, tan } = slope(rise);
  const low = (x: number): number => bargeApex(rise) - BARGE_DEPTH / c - Math.abs(x) * tan;
  const depth = 0.2;
  const y = (x: number): number => low(x) - (depth / 2 - 0.08) / c;
  const z = D / 2 + 0.045;
  for (const s of [1, -1]) {
    const xe = half - 0.06;
    beam(m, { from: [0, y(0), z], to: [s * xe, y(xe), z], size: [depth, 0.1], side: [0, 0, 1], back: false, caps: false, segments: 3 }, p);
  }
}

/**
 * Standing seams: four per slope, five equal panels between the inner faces
 * of the bargeboards (sheet, side view), from under the ridge roll over the
 * eave's top edge. The kit's seam section.
 */
function roofSeams(m: SolidMesh, rise: number, p: Paint): void {
  const { half, c, sn, tan } = slope(rise);
  const apexT = EAVE + rise + ROOF_THICK / c;
  const Ebx = half + EAVE_OVERHANG;
  const Eby = EAVE - EAVE_OVERHANG * tan;
  // The slab's top eave corner, 1.5 cm back up the slope: its nose is
  // chamfered, and the seam's sunk base still buries its end in it.
  const Etx = Ebx + ROOF_THICK * sn - 0.015 * c;
  const Ety = Eby + ROOF_THICK * c + 0.015 * sn;
  const slopeLen = Math.hypot(Etx, apexT - Ety);
  const z0 = -D / 2 - ROOF_FRONT + BARGE_THICK;
  const z1 = D / 2 + ROOF_BACK - BARGE_THICK;
  const shape = { width: 0.085, topWidth: 0.05, height: 0.055, sink: 0.03, capEnd: true, breakAt: Math.min(0.34, slopeLen * 0.2) - 0.06 };
  for (let k = 1; k <= 4; k++) {
    const z = z0 + (k * (z1 - z0)) / 5;
    for (const s of [1, -1]) {
      rib(m, [s * 0.06 * c, apexT - 0.06 * sn, z], [s * Etx, Ety, z], [s * sn, c, 0], shape, p);
    }
  }
}

/** A region of a wall the lapped boards must stop under (a surround). */
interface Block {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Lapped boards: how far each board's foot stands proud of the wall, and
 * how far up the wall its taper runs back into it — all the way to the next
 * joint, so the boards cover the wall: the wall's own face, baked with
 * every surround's contact shadow on a 0.9 m grid, would show between them
 * as grey wedges. */
const LIP = 0.03;
const LAP = BOARD_PITCH - 0.012;

/**
 * Lapped weatherboards on one wall, as the sheet draws them: at every board
 * joint the upper board's foot stands proud with a rounded lip and a
 * shadowed underside, tapering back into the wall over `LAP`. Rows start at
 * the wall's foot (`BOARD_PITCH`), so neighbouring walls' rows meet at the
 * corners, where each runs `LIP` past the wall's end and the two overlap as
 * lapped board ends. They stop under every surround (`blocks`) and follow
 * the gable.
 */
function lapBoards(
  m: SolidMesh,
  on: Facade,
  o: { width: number; rise?: number; blocks?: readonly Block[]; /** Wall ends (−u, +u) whose board ends show; the others run under a corner board. */ open?: readonly [boolean, boolean] },
  p: Paint,
  under: Paint,
): void {
  const start = m.mark();
  const hw = o.width / 2;
  const rise = o.rise ?? 0;
  const top = EAVE + rise;
  // Half width of the wall at a height: the gable narrows (minus a hand, so
  // a gable row ends under the rake trim rather than past the wall's edge).
  const reach = (y: number): number => (rise && y > EAVE ? hw * (1 - (y - EAVE) / rise) - 0.05 : hw + LIP);
  // Section in (out of the wall, up), relative to the joint line.
  // The two back points touch the wall face rather than sink into it: a
  // vertex buried in the wall bakes black (its AO rays start inside), and
  // the bake's smoothing smears that over the board as grey blotches.
  // Underside, lip (shaded round with the taper: `p` is soft), taper.
  const sec: Vec2[] = [[0.001, -0.012], [LIP - 0.006, -0.006], [LIP, 0.016], [0.0015, LAP]];
  const faceDir = (i: number): Vector3 => {
    const [w0, y0] = sec[i];
    const [w1, y1] = sec[i + 1];
    return V(0, w1 - w0, -(y1 - y0)).scale(-1);
  };
  // Row 0 starts inside the plinth, which hides its lip.
  for (let j = 0; WALL_BOTTOM + j * BOARD_PITCH < top - 0.12; j++) {
    const v = WALL_BOTTOM + j * BOARD_PITCH;
    const r = reach(v + LAP);
    if (r < 0.15) break;
    let spans: [number, number][] = [[-r, r]];
    for (const b of o.blocks ?? []) {
      if (v + LAP <= b.v0 || v >= b.v1) continue;
      spans = spans.flatMap(([s0, s1]): [number, number][] => {
        if (b.u1 <= s0 || b.u0 >= s1) return [[s0, s1]];
        const out: [number, number][] = [];
        if (b.u0 > s0) out.push([s0, b.u0]);
        if (b.u1 < s1) out.push([b.u1, s1]);
        return out;
      });
    }
    for (const [a, b] of spans) {
      if (b - a < 0.1) continue;
      // Stations every ≤ 2.2 m, plus one 10 cm in from each end: the laps
      // bake their own AO on vertices, and the contact shadow where a board
      // runs under a surround or a corner board must stop within a hand of
      // it instead of fading over the next metre.
      // (Not at an open wall end: nothing there casts one.)
      const wallEnd = (u: number): boolean => Math.abs(Math.abs(u) - r) < 1e-6;
      const isOpen = (u: number, i: 0 | 1): boolean => wallEnd(u) && !!o.open?.[i] && r > hw;
      const long = b - a > 0.6;
      const ea = long && !isOpen(a, 0) ? 0.1 : 0;
      const eb = long && !isOpen(b, 1) ? 0.1 : 0;
      const n = Math.max(1, Math.ceil((b - a - ea - eb) / 2.2));
      const us = Array.from({ length: n + 1 }, (_, i) => a + ea + ((b - a - ea - eb) * i) / n);
      if (ea) us.unshift(a);
      if (eb) us.push(b);
      const at = (u: number, k: number): Vector3 => V(u, v + sec[k][1], sec[k][0]);
      for (let i = 0; i + 1 < us.length; i++) {
        const u0 = us[i];
        const u1 = us[i + 1];
        for (let k = 0; k + 1 < sec.length; k++) {
          // Face k = 0 is the shadowed underside of the lip.
          quadFacing(m, at(u0, k), at(u1, k), at(u1, k + 1), at(u0, k + 1), faceDir(k), k === 0 ? under : p);
        }
      }
      // End caps where they can be seen: at a surround (whose top a board
      // may overshoot) and at an open wall end; not under a corner board or
      // at a gable's sloping edge.
      const showA = wallEnd(a) ? isOpen(a, 0) : true;
      const showB = wallEnd(b) ? isOpen(b, 1) : true;
      if (showA) polygonFacing(m, sec.map((_, k) => at(a, k)), V(-1, 0, 0), p);
      if (showB) polygonFacing(m, sec.map((_, k) => at(b, k)), V(1, 0, 0), p);
      // Past an open wall end the board's back is in the air (seen from the
      // neighbouring wall's side between its own boards): close it there.
      const last = sec.length - 1;
      if (isOpen(a, 0)) quadFacing(m, at(a, 0), at(-hw, 0), at(-hw, last), at(a, last), V(0, 0, -1), p);
      if (isOpen(b, 1)) quadFacing(m, at(hw, 0), at(b, 0), at(b, last), at(hw, last), V(0, 0, -1), p);
    }
  }
  toFacade(m, start, on);
}

/**
 * The sheet's door: the kit's boarded leaf (no surround, knob or hinges)
 * behind a cream surround with a 45° chamfered head; a smooth grey knob on
 * a round rose; chunky iron strap hinges with a knuckle barrel at the frame
 * edge.
 */
function shackDoor(m: SolidMesh, on: Facade, op: Opening, P: BuildingPaints): void {
  door(m, { on, opening: op, surround: 0, handle: 'none', hinges: false }, P);
  const start = m.mark();
  const { u, v, w, h } = op;
  const sw = DOOR_SURROUND;
  // A 45° chamfer grown by `g` with its rectangle keeps the band width when
  // its size grows by g(2 − √2); `openingRing` adds g, hence the correction.
  const outerChamfer = DOOR_CHAMFER + sw * (2 - Math.SQRT2) - sw;
  // One segment per corner = a straight chamfer; `uniform` keeps the square
  // foot corners as coincident pairs so both rings match point for point.
  const inner = openingRing({ ...op, round: DOOR_CHAMFER }, -0.012, 0, 1, true);
  // The foot runs 3 cm down into the deck; the ring's lower bar is the threshold.
  const outer = openingRing({ u, v: v - 0.03, w, h: h + 0.03, round: outerChamfer }, sw, 0, 1, true);
  frameRing(m, { inner, outer, z0: -0.03, z1: 0.08, bevel: 0.035 }, soften(P.trim, 45));
  const zf = -0.1;
  // Knob: smooth and mid grey, as drawn (the kit's chrome reads white here).
  const knob = paint('#8E9299', { gloss: 0.55, metal: 0.55 });
  const kx = u + w / 2 - 0.2;
  const ky = v + h * 0.46;
  frustum(m, { from: [kx, ky, zf - 0.01], to: [kx, ky, zf + 0.024], radiusBottom: 0.1, radiusTop: 0.085, sides: 16, caps: 'top' }, knob);
  cylinder(m, { from: [kx, ky, zf + 0.015], to: [kx, ky, zf + 0.06], radius: 0.035, sides: 10, caps: false }, knob);
  sphere(m, { radius: 0.08, segments: 16, rings: 8, at: [kx, ky, zf + 0.1] }, knob);
  // Hinges on the left edge: a bevelled strap across the boards and a
  // barrel standing in the reveal's corner.
  const hx = u - w / 2;
  for (const fy of [0.17, 0.83]) {
    const y = v + h * fy;
    roundedBox(m, { min: [hx - 0.01, y - 0.05, zf - 0.006], max: [hx + 0.36, y + 0.05, zf + 0.026], radius: 0.012, segments: 1 }, P.iron);
    cylinder(m, { from: [hx + 0.02, y - 0.085, zf + 0.03], to: [hx + 0.02, y + 0.085, zf + 0.03], radius: 0.036, sides: 8 }, P.iron);
  }
  toFacade(m, start, on);
}

/**
 * The sheet's window: the kit's glazing (thinner sash bars) inside a flat,
 * square-cornered painted frame with a small chamfer, and a slightly wider
 * bottom rail.
 */
function shackWindow(m: SolidMesh, on: Facade, op: Opening, o: { shutters?: 'none' | 'open' | 'closed'; ledge?: boolean }, P: BuildingPaints, frameP: Paint): void {
  windowUnit(m, { on, opening: op, frame: 0.055, sill: false, head: false, framePaint: frameP, shutters: o.shutters }, P);
  const start = m.mark();
  const inner = openingRing(op, -0.012, 0, 1, true);
  const outer = openingRing(op, SURROUND, 0.025, 1, true);
  frameRing(m, { inner, outer, z0: -0.03, z1: 0.07, bevel: 0.022 }, soften(frameP, 40));
  if (o.ledge ?? true) {
    const reach = op.w / 2 + SURROUND + 0.03;
    pillow(m, { x0: op.u - reach, x1: op.u + reach, y0: op.v - SURROUND - 0.03, y1: op.v - 0.04, z0: -0.02, z1: 0.1, chamfer: 0.03 }, soften(frameP, 40));
  }
  toFacade(m, start, on);
}

/** A planter trough under a window, fuller than the kit's: six overlapping
 * faceted clumps with two or three flowers each. */
function fullFlowerBox(m: SolidMesh, on: Facade, op: Opening, seed: number, P: BuildingPaints): void {
  const start = m.mark();
  const r = rng(seed, 'b01-flowerbox');
  const width = op.w + 0.3;
  const top = op.v - SURROUND - 0.03;
  const depth = 0.26;
  roundedBox(m, { min: [op.u - width / 2, top - 0.22, -0.02], max: [op.u + width / 2, top, depth], radius: 0.035, segments: 1 }, P.timber);
  const clumps = 6;
  for (let i = 0; i < clumps; i++) {
    const x = op.u - width / 2 + 0.07 + ((i + 0.5) / clumps) * (width - 0.14);
    const rad = r.range(0.1, 0.13);
    const z = depth * 0.5 + (i % 2 ? 0.04 : -0.03);
    blob(m, { radii: [rad * 1.2, rad * 0.95, rad], points: 9, seed: r.int(1, 9999), jitter: 0.3, at: [x, top + rad * 0.3, z] }, i % 2 ? P.foliage : P.foliageLight);
    const flowers = r.chance(0.5) ? 3 : 2;
    for (let f = 0; f < flowers; f++) {
      sphere(m, { radius: 0.045, segments: 4, rings: 2, at: [x + r.range(-0.09, 0.09), top + rad * r.range(0.9, 1.25), z + r.range(0.02, 0.1)] }, f === 0 && r.chance(0.3) ? P.flowerCenter : P.flower);
    }
  }
  toFacade(m, start, on);
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'sunny');
  let P = variantPaints(base.scheme === 'sunny' ? withPaints(base, { roof: BUILDING.coral, roofAlt: BUILDING.turquoise, door: BUILDING.turquoise }) : base, v);
  // A timber door would vanish against this building's timber posts and
  // porch; the scheme's accent takes its place.
  const near = (a: readonly number[], b: readonly number[]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.08;
  if (near(P.door.color, P.timber.color)) P = { ...P, door: paint(P.door, { color: P.accent.color }) };
  // Window frames a step lighter than the door, toward the sheet's mint.
  const frameP = paint(P.frame, { color: P.scheme === 'sunny' ? hex('#33BCAA') : lighten(P.frame.color, 0.06) });
  const m = new SolidMesh();
  const zFront = -D / 2;
  const zPost = zFront - POST_OUT;

  // a. Roof: runs out over the porch.
  const roof = gableRoof(m, { ...ROOF, rise: c.rise }, P);
  roofSeams(m, roof.rise, soften(P.roof, 45));
  bargeboards(m, { z: zFront - ROOF_FRONT + BARGE_THICK / 2, rise: c.rise }, P.trim);
  bargeboards(m, { z: D / 2 + ROOF_BACK - BARGE_THICK / 2, rise: c.rise }, P.trim);

  // b. Plinths: the body's, and a lower one carrying the porch deck. The
  // porch's is 5 cm narrower each side so that its stones stay inside the
  // body's corner stones where the two overlap.
  stonePlinth(m, { width: W, depth: D, top: PLINTH, seed }, P);
  const porchStoneFront = zFront - PORCH + 0.16;
  const porchStoneBack = zFront + 0.2;
  stonePlinth(m, { width: W - 0.1, depth: porchStoneBack - porchStoneFront, cz: (porchStoneBack + porchStoneFront) / 2, top: DECK_TOP - DECK_THICK + 0.01, seed: seed + 11 }, P);

  // c. Walls (their lapped boards go on last, see below).
  const win = (u: number): Opening => ({ u, v: 1.22, w: c.winW, h: 0.84 });
  const frontWin = win(WINDOW_U);
  const sideWin = win(0);
  const rearWin = win(0);
  const openings = { front: [DOOR, frontWin], right: [sideWin], back: [rearWin] };
  const F = wallBox(m, { width: W, depth: D, bottom: WALL_BOTTOM, top: EAVE, gable: { ridge: 'z', rise: roof.rise }, openings }, P.wall);

  // d. Cream corner boards at the back; the porch posts stand before the front corners.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.05, top: EAVE + 0.05, size: 0.26, proud: 0.05, corners: ['bl', 'br'] }, P.trim);
  rearRake(m, roof.rise, P.timber);

  // e. Porch: deck, posts, truss.
  roundedBox(m, { min: [-DECK_HALF, DECK_TOP - DECK_THICK, zFront - PORCH], max: [DECK_HALF, DECK_TOP - 0.012, zFront + 0.05], radius: 0.05, segments: 2 }, P.timber);
  {
    // Deck boards, built facing +z and laid flat: local y runs out of the wall.
    const s = m.mark();
    plankPanel(m, { x0: -DECK_HALF + 0.05, x1: DECK_HALF - 0.05, y0: D / 2 - 0.03, y1: D / 2 + PORCH - 0.05, z0: DECK_TOP - 0.03, z1: DECK_TOP, planks: 3, horizontal: true, groove: 0.014, rows: 5 }, P.timber);
    m.rotate('x', -90, s);
  }
  for (const s of [1, -1]) {
    post(m, { at: [s * POST_X, zPost], bottom: DECK_TOP - 0.03, top: BEAM_BOTTOM + 0.04, size: POST, cap: { height: 0.22, grow: 0.07 } }, P.timber);
    // Cream foot block, rounder than the kit post's chamfered base: it sits at
    // the chase camera's eye level.
    const foot = POST / 2 + 0.07;
    roundedBox(m, { min: [s * POST_X - foot, DECK_TOP - 0.03, zPost - foot], max: [s * POST_X + foot, DECK_TOP + 0.3, zPost + foot], radius: 0.07, segments: 2 }, P.trim);
    // Plate from the post back to the wall, under the eave.
    beam(m, { from: [s * POST_X, BEAM_BOTTOM + 0.12, zPost], to: [s * POST_X, BEAM_BOTTOM + 0.12, zFront + 0.06], size: [0.24, 0.2], side: [s, 0, 0], caps: false }, P.timber);
  }
  porchTruss(m, { z: zPost, rise: roof.rise }, P.timber);

  // Step: a cream block with a timber riser panel.
  const stepFront = zFront - PORCH - STEP_OUT;
  roundedBox(m, { min: [STEP_U - STEP_W / 2, -0.1, stepFront], max: [STEP_U + STEP_W / 2, STEP_H, zFront - PORCH + 0.06], radius: 0.05, segments: 2 }, P.trim);
  roundedBox(m, { min: [STEP_U - STEP_W / 2 + 0.14, 0.05, stepFront - 0.018], max: [STEP_U + STEP_W / 2 - 0.14, STEP_H - 0.07, stepFront + 0.1], radius: 0.02, segments: 1 }, P.timber);

  // f. Openings: flat painted frames on the wall face, as on the sheet.
  shackDoor(m, F.front, DOOR, P);
  shackWindow(m, F.front, frontWin, { ledge: true }, P, frameP);
  shackWindow(m, F.right, sideWin, { shutters: c.sideShutters }, P, frameP);
  shackWindow(m, F.back, rearWin, { shutters: c.rearShutters }, P, frameP);
  if (c.flowerBox) fullFlowerBox(m, F.front, frontWin, seed, P);

  // g + h. By seed; everything stands on the porch (see the envelope note above).
  if (c.lamp === 'lantern') lantern(m, { at: [0, BEAM_BOTTOM + 0.01, zPost] }, P);
  // A slim bulkhead centred in the wall between the door's surround and the
  // window's, 10 cm clear of each.
  const gapL = DOOR_U + DOOR.w / 2 + DOOR_SURROUND;
  const gapR = WINDOW_U - c.winW / 2 - SURROUND;
  const lampSpot: Opening = { u: (gapL + gapR) / 2, v: 1.72, w: 0.15, h: 0.3 };
  if (c.lamp === 'bulkhead') wallLamp(m, { on: F.front, u: lampSpot.u, v: lampSpot.v + lampSpot.h / 2, size: [lampSpot.w, lampSpot.h] }, P);
  if (c.solar) {
    // Centred in a seam panel, the long side down the slope.
    const zp = -D / 2 - ROOF_FRONT + BARGE_THICK + 3.5 * ((D + ROOF_FRONT + ROOF_BACK - 2 * BARGE_THICK) / 5);
    solarPanel(m, { at: [1.05, roof.heightAt(1.05, zp) + 0.05, zp], rot: roof.tiltAt(1.05, zp), size: [1.15, 0.6], cells: [4, 2] }, P);
  }
  if (c.stores) {
    barrel(m, { at: [0.36, zFront - 0.36], base: DECK_TOP - 0.01, radius: 0.25, height: 0.6 }, P);
    crate(m, { at: [1.12, zFront - 0.34], base: DECK_TOP, size: [0.62, 0.4, 0.46], rotY: -6, produce: P.accent, seed }, P);
  }
  if (c.pot) planter(m, { at: [1.3, zFront - 0.36], base: DECK_TOP, radius: 0.22, height: 0.36, seed }, P);

  finishBuilding(m);

  // Lapped boards, after the bake: the walls keep the clean gradients they
  // bake without them, and the laps get their own occlusion (under the
  // eaves and the porch roof) with the whole building as occluder, eased
  // exactly like `finishBuilding` eases the rest.
  const joints = m.mark();
  const under = paint(P.wall, { color: shade(P.wall.color, 0.8) });
  const surround = (op: Opening, sw: number, foot = 0): Block => ({ u0: op.u - op.w / 2 - sw * 0.5, u1: op.u + op.w / 2 + sw * 0.5, v0: op.v - sw - foot, v1: op.v + op.h + sw });
  const winBlock = (op: Opening): Block => surround(op, SURROUND, 0.03);
  const frontBlocks = [surround(DOOR, DOOR_SURROUND, 0.1), winBlock(frontWin)];
  if (c.lamp === 'bulkhead') frontBlocks.push({ u0: lampSpot.u - lampSpot.w / 2 + 0.02, u1: lampSpot.u + lampSpot.w / 2 - 0.02, v0: lampSpot.v, v1: lampSpot.v + lampSpot.h });
  // Per wall: the triangle range and the axis that runs along it.
  const walls: [number, number, 0 | 2][] = [];
  const lay = (axis: 0 | 2, f: () => void): void => {
    const t0 = m.triangleCount;
    f();
    walls.push([t0, m.triangleCount, axis]);
  };
  lay(0, () => lapBoards(m, F.front, { width: W, rise: roof.rise, blocks: frontBlocks, open: [true, true] }, P.wall, under));
  lay(0, () => lapBoards(m, F.back, { width: W, rise: roof.rise, blocks: [winBlock(rearWin)] }, P.wall, under));
  lay(2, () => lapBoards(m, F.right, { width: D, blocks: [winBlock(sideWin)], open: [true, true] }, P.wall, under));
  lay(2, () => lapBoards(m, F.left, { width: D, open: [true, true] }, P.wall, under));
  bakeAO(m, { rays: 24, ground: true, maxDistance: 0.9, smoothPasses: 2, floor: 0, only: [joints, m.triangleCount] });
  const ao = Float32Array.from(m.cornerAO);
  // Eased like `finishBuilding`, and a quarter weaker: the laps' own
  // contact shadows (where a board runs under a surround) are a hand wide.
  for (let i = joints * 3; i < ao.length; i++) ao[i] = Math.max(0.35, 1 - 0.75 * Math.pow(1 - ao[i], 1.35));
  // One AO value per board per station, the mean of its section: a board is
  // 22 cm tall with its corners 3 cm apart in depth, so the bake's
  // top-to-bottom difference is noise, and on stations a metre apart it shades
  // as light and dark wedges along the triangle diagonals.
  const pos = m.positions;
  for (const [t0, t1, axis] of walls) {
    const groups = new Map<string, number[]>();
    for (let i = t0 * 3; i < t1 * 3; i++) {
      const row = Math.floor((pos[i * 3 + 1] - WALL_BOTTOM + 0.03) / BOARD_PITCH);
      const key = `${row}:${Math.round(pos[i * 3 + axis] * 500)}`;
      const g = groups.get(key);
      if (g) g.push(i);
      else groups.set(key, [i]);
    }
    for (const g of groups.values()) {
      const mean = g.reduce((s, i) => s + ao[i], 0) / g.length;
      for (const i of g) ao[i] = mean;
    }
  }
  m.writeAO(ao);
  return m;
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const wallTop = EAVE + 0.1;
  const roof = gableRoofInfo({ ...ROOF, rise: c.rise });
  // The roof covers body and porch: five stacked boxes, each topping out at
  // the surface's height 0.2 m inside its own edge, the last at the ridge.
  const zMid = (ROOF_BACK - ROOF_FRONT) / 2;
  const zHalf = (D + ROOF_FRONT + ROOF_BACK) / 2;
  const roofStep = (halfWidth: number): ColliderSpec => {
    const top = roof.heightAt(Math.max(0, halfWidth - 0.2), 0);
    return { shape: 'box', center: [0, (wallTop + top) / 2, zMid], half: [halfWidth, (top - wallTop) / 2, zHalf] };
  };
  const zPost = -D / 2 - POST_OUT;
  return [
    // Walls, including the plinth's proud blocks.
    { shape: 'box', center: [0, wallTop / 2, 0], half: [W / 2 + 0.15, wallTop / 2, D / 2 + 0.15] },
    ...[2.3, 1.75, 1.2, 0.65, 0.2].map(roofStep),
    // Porch deck, the step before it, and the two posts on the road side.
    { shape: 'box', center: [0, DECK_TOP / 2, -D / 2 - PORCH / 2], half: [DECK_HALF, DECK_TOP / 2, PORCH / 2] },
    { shape: 'box', center: [STEP_U, STEP_H / 2, -D / 2 - PORCH - STEP_OUT / 2], half: [STEP_W / 2, STEP_H / 2, STEP_OUT / 2] },
    ...[1, -1].map((s): ColliderSpec => ({ shape: 'box', center: [s * POST_X, (DECK_TOP + wallTop) / 2, zPost], half: [0.24, (wallTop - DECK_TOP) / 2, 0.24] })),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b01-sunshack',
  name: 'B01 Sunshack',
  category: 'building',
  // Height: 4.13 m above the ground plus the 10 cm skirt below it, as the lab measures.
  size: { x: 4.74, y: 4.23, z: 4.57 },
  variants: 3,
  schemes: ['sunny', 'warm', 'coastal'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/shacks/design-sheet.png',
    brief: 'design-documents/building-design-pack/shacks/b01-sunshack-brief.txt',
  },
  build,
  colliders,
};

export default asset;
