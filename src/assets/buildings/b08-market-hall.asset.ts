import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, cylinder, extrudePolygon, frustum, hex, jitterColor, mix, paint, paintStripe, polygonFacing, quadFacing, rng, roundedBox, roundedRectRing, soften, sphere } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  cornerPosts,
  finishBuilding,
  frameRing,
  gableFraming,
  gableRoof,
  gableRoofInfo,
  offsetFacade,
  openingRing,
  pillow,
  planter,
  plankPanel,
  schemePaints,
  solarPanel,
  stonePlinth,
  toFacade,
  variantPaints,
  variation,
  wallBox,
  wallLantern,
  windowUnit,
  withPaints,
} from './parts';
import type { BuildingPaints, Facade, Opening, RoofInfo } from './parts';

/**
 * B08 — Market Hall. "Mint shop with a coral roof and a striped full-width
 * awning."
 *
 * SCHEMES. The sheet is the WARM scheme (coral roof, teal door / frames /
 * shutters, coral accent) with one paint changed: the walls are mint instead
 * of cream (and the shutters one step deeper, so they show on it). 'warm' is
 * therefore the hero and builds the sheet; 'coastal' (turquoise walls, cobalt
 * roof, cream frames, coral door) and 'sunny' (mustard walls, teal roof,
 * coral door) are the style guide's schemes untouched.
 *
 * MAIN BODY 8.0 (x) × 5.0 (z) m, walls to the 2.8 m eave, gable ends front
 * (−z) and back: the ridge runs along z (the brief's +Y — the sheet's REAR
 * and TOP insets draw it across x and are overruled by the brief). Stone
 * plinth to 0.5 m, cut away at the two doors, which stand on the ground.
 * OVERALL 8.78 × 5.47 × 6.57 m (x ±4.39, y −0.10 … 5.37, z −3.72 … 2.85)
 * with eaves, bargeboards, chimney and the awning — inside the 8.8 × 6.8 m envelope.
 *
 * HEIGHT — THE SHEET WINS OVER THE BRIEF, as on the cottage. The brief says
 * "eave 2.8, ridge 4.2"; that is a 15° roof, and every view of the sheet
 * draws 24 – 25° with the apex boss 5 m up. The eave keeps the brief's 2.8 m,
 * the roof takes the sheet's pitch (24°): apex boss at 4.95 m, chimney cap
 * at 5.37 m — the village rule in parts.ts ("keep the brief's eave and take
 * the pitch from the drawing"), as on B01, B04 and B06. `ROOF_TOP` is the one
 * number to change (to 4.2) if the brief's height must be met; roof boards,
 * truss, chimney and colliders follow it.
 *
 * FRONT, as on the sheet: boarded truss with an oval lamp over a tie beam
 * 0.4 m above the eave line; the awning hangs from the beam's underside and
 * runs the whole width, so its two top corners die into the bargeboard feet
 * (the sheet hides them there too). Awning 1.22 m out: 7 cm of canvas at a
 * 24° pitch tucked into the tie beam, rolled over a rounded front edge whose
 * foot is 2.46 m up (the brief's "about 2.4") into a valance of eleven
 * half-round lobes, down to 2.24 m (`shopAwning`). Four timber knee brackets
 * carry it. The apex boss is this sheet's faceted pentagon (`marketRoof`).
 *
 * Opening schedule (brief): front = central entry + a serving window each
 * side (lined cream recess with a dark back, counter at 1.0 m); each side =
 * one shuttered window; rear = central stockroom door + two louvre vents.
 * Both doors are portals standing proud of the wall, so no wall opening is
 * cut for them: only the plinth is.
 *
 * Seeds: 0 = the sheet. The game instantiates 0 – 2, so everything that shows
 * at a glance cycles: awning stripe colour, door / shutter colours
 * (`variantPaints`), side shutters open / closed, chimney slope, a tray of
 * fruit on one serving counter, a lantern on a front pilaster, a solar panel
 * (1 = cobalt stripes, closed shutters, chimney left, lantern, apples on the
 * left counter; 2 = mustard stripes, solar panel; flower boxes on seed 3,
 * oranges and a door pot on seed 4, lab only). 'coastal' leads with cobalt
 * stripes (see `stripePaint`). The village's crates and barrels in front of
 * the hall are placed by the world dressing (src/world/dressing.ts), which is
 * why this building stands none on the ground itself. 5 677 triangles for
 * seed 0, 5 855 / 5 784 for seeds 1 / 2, at most 5 905 for seeds 0 – 4.
 */

const W = 8.0;
const D = 5.0;
const EAVE = 2.8;
const PLINTH = 0.5;
/** Finished height of the roof (top of the apex boss). */
const ROOF_TOP = 4.95;
const OVERHANG = { eave: 0.24, gable: [0.4, 0.3] as const };
/** Tie beam: centre height above the eave line and depth. */
const TIE_RAISE = 0.4;
const TIE_SIZE = 0.32;
const POST = 0.44;
const POST_PROUD = 0.08;

/**
 * Awning, in the front facade's (u, v, w): top edge at the wall (5 cm up
 * INTO the tie beam, so no strip of wall shows between the two), reach to the
 * face of the valance, pitch of the canvas, radius of the rolled front edge,
 * thickness, then the valance — a straight strip and one hanging lobe a
 * stripe. Foot of the roll 2.46 m (the brief's "about 2.4"), lobes to 2.24.
 */
const AWN_V = EAVE + TIE_RAISE - TIE_SIZE / 2 + 0.05;
const AWN_OUT = 1.22;
const AWN_PITCH = 24;
const AWN_NOSE = 0.14;
const AWN_THICK = 0.07;
const AWN_STRAIGHT = 0.04;
const AWN_LOBE = 0.18;
const AWN_WIDTH = 7.5;
const AWN_STRIPES = 11;
/** Bracket positions along the front: flanking the door, and at the pilasters. */
const BRACKETS = [-3.42, -0.92, 0.92, 3.42];

/** Doors stand on the ground. Leaf plane and face of the surround, out of the wall. */
const FRONT_DOOR: Opening = { u: 0, v: 0.12, w: 1.0, h: 1.92, round: 0.14 };
const REAR_DOOR: Opening = { u: 0, v: 0.12, w: 1.1, h: 1.9, round: 0.14 };
const DOOR_SURROUND = 0.2;
const DOOR_LEAF = 0.045;
const DOOR_PROUD = 0.2;

/** W03 serving window, as drawn: 1.8 × 1.0 m clear over a counter at 1.0 m. */
const COUNTER = 1.0;
const SERVE_U = 2.15;
const SERVE_W = 1.8;
const SERVE_SURROUND = 0.15;
const COUNTER_OUT = 0.36;
const COUNTER_HALF = SERVE_W / 2 + 0.28;

/** Rear louvre vents: centre and slatted field. */
const VENT_U = 2.1;
const VENT_V = 2.05;
const VENT_W = 1.4;
const VENT_H = 0.6;

/** `stonePlinth` layouts by seed. Its stone count swings by 120 triangles
 * from one layout to the next; these are six of the lean ones. */
const PLINTH_LAYOUTS = [0, 7, 12, 3, 6, 8];

const CHIMNEY: readonly [number, number] = [1.3, 1.05];
const CHIMNEY_SIZE = 1.0;
const CHIMNEY_HEIGHT = 1.2;

// The sheet's wall: a turquoise pulled toward green and a step lighter.
const MINT: RGB = hex('#42C6BC');
const DEEP_TEAL: RGB = hex('#0E9997');
// The sheet's gable infill: a mid brown between the beams' orange and the
// kit's soffit brown, so the boarded triangle does not read as a hole.
const GABLE_BOARDS: RGB = hex('#94522B');
// Warm amber lamp glass: the kit's #FFD9A0 tone-maps to white on a lens this
// big, the scheme lamp (#FFB454) to lemon.
const LAMP_GLOW = paint('#FFA65A', { gloss: 0.5, emissive: 0.42 });
const CHIMNEY_SLAT = paint('#6E7480', { gloss: 0.2 });

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/**
 * Secondary choices of one variant (seed 0 = the sheet). Shared by `build`
 * and `colliders`, so whatever stands on the ground also blocks.
 */
function choices(seed: number) {
  const v = variation(seed, 'b08');
  return {
    v,
    // 0 = the scheme's accent (coral), 1 and 2 = the two alternatives below.
    stripe: v.cycle([0, 1, 2, 0, 1] as const),
    sideShutters: v.cycle(['open', 'closed', 'open', 'open', 'closed'] as const),
    chimneySide: v.cycle([1, -1, 1, -1, 1] as const),
    // On a front pilaster: 1 = the right-hand one, −1 = the left.
    lantern: v.cycle([0, 1, 0, 0, 0] as const),
    solar: v.cycle([false, false, true, false, false] as const),
    flowerBoxes: v.cycle([false, false, false, true, false] as const),
    winW: 1.0 + v.shift('winW', 0.05),
    // Goods on a serving counter: which counter (0 = none) and what is on it.
    produce: v.cycle([0, -1, 0, 0, 1] as const),
    fruit: v.cycle([0, 0, 0, 0, 1] as const),
    // A pot beside the front door, as plan positions (x, z) — where the world
    // dressing leaves a gap between its barrel and its crates.
    pots: v.cycle<[number, number][]>([[], [], [], [], [[1.32, -D / 2 - 0.5]]]),
  };
}

/** Awning canvas colours: the sheet's coral first, then two that neither
 * repeat it nor vanish against the scheme's wall. 'coastal' leads with cobalt
 * to match its roof: with a coral awning on its turquoise walls it is the
 * warm hall with the roof repainted. */
function stripePaint(P: BuildingPaints, which: 0 | 1 | 2): Paint {
  const order: Record<BuildingPaints['scheme'], readonly RGB[]> = {
    warm: [P.accent.color, BUILDING.cobalt, BUILDING.mustard],
    coastal: [BUILDING.cobalt, P.accent.color, BUILDING.mustard],
    sunny: [P.accent.color, BUILDING.turquoise, BUILDING.cobalt],
  };
  return paint(P.accent, { gloss: 0.15, color: order[P.scheme][which] });
}

/**
 * A door as the sheet draws it on this building: a thick cream portal that
 * stands on the ground in front of the plinth, the boarded leaf set back in
 * it. Nothing is cut out of the wall — the portal is proud of it — so the
 * leaf needs no reveal behind it; the plinth between the jambs is removed by
 * the caller. The ring's foot bar is the threshold.
 */
function portalDoor(m: SolidMesh, o: { on: Facade; opening: Opening; leaf: Paint; knobSide?: 1 | -1; detail?: 0 | 1 }, P: BuildingPaints): void {
  const start = m.mark();
  const op = o.opening;
  const { u, v, w, h } = op;
  const round = Math.max(op.round ?? 0, 0.03);
  // Board faces end inside the hole, clear of the rounded head (see `door`).
  const inside = Math.max(0.014, Math.min(round, 0.25) * 0.3 + 0.006);
  plankPanel(m, { x0: u - w / 2 - 0.02, x1: u + w / 2 + 0.02, y0: v - 0.02, y1: v + h + 0.02, z0: DOOR_LEAF - 0.04, z1: DOOR_LEAF, planks: 3, groove: 0.018, edge: 0.02 + inside, rim: false }, o.leaf);
  // Outer ring: the surround's width at the sides and the head, down to the
  // 10 cm skirt at the foot.
  const foot: Opening = { u, v: DOOR_SURROUND - 0.1, w, h: v + h - (DOOR_SURROUND - 0.1), round };
  // `detail` 1 = the street door, seen close; 0 = the stockroom door (coarser
  // arch and knob, and the ring's own foot bar as its only threshold).
  const detail = o.detail ?? 1;
  const segs = detail ? 5 : 4;
  frameRing(
    m,
    { inner: openingRing({ ...op, round }, -0.012, 0, segs, true), outer: openingRing(foot, DOOR_SURROUND, 0, segs, true), z0: -0.03, z1: DOOR_PROUD, bevel: 0.05 },
    soften(P.trim, 45),
  );
  // Threshold slab, wider than the portal (the sheet's cream foot block).
  if (detail) roundedBox(m, { min: [u - w / 2 - DOOR_SURROUND - 0.13, -0.1, -0.02], max: [u + w / 2 + DOOR_SURROUND + 0.13, 0.09, DOOR_PROUD + 0.2], radius: 0.05, segments: 1 }, P.trim);
  // Oversized chrome ball on its rose. The ball's pole points out of the
  // door and its back third (facing the leaf, behind a flat cap) is left off:
  // the triangles go where they show, so it reads round, not as a hex nut.
  const x = u + (o.knobSide ?? 1) * (w / 2 - 0.2);
  const y = v + h * 0.44;
  const chrome = paint(P.metal, { smooth: 180 });
  frustum(m, { from: [x, y, DOOR_LEAF - 0.01], to: [x, y, DOOR_LEAF + 0.022], radiusBottom: 0.12, radiusTop: 0.1, sides: 10, caps: 'top', bevel: { top: 0.012 }, bevelSegments: 1 }, paint(P.metal, { smooth: 50 }));
  cylinder(m, { from: [x, y, DOOR_LEAF + 0.01], to: [x, y, DOOR_LEAF + 0.06], radius: 0.042, sides: 8, caps: false }, chrome);
  sphere(m, { radius: 0.09, segments: detail ? 12 : 10, rings: detail ? 5 : 4, latitude: [-30, 90], caps: true, rot: [90, 0, 0], at: [x, y, DOOR_LEAF + 0.1] }, chrome);
  toFacade(m, start, o.on);
}

/**
 * W03 serving window: no glass and no sash — a cream-lined recess the depth
 * of the wall with a dark stall box behind (brief: "modeled recesses, not holes through
 * an empty shell"), a thick cream surround on the wall face and the counter
 * slab running through the opening as its sill.
 */
function servingWindow(m: SolidMesh, o: { on: Facade; opening: Opening }, P: BuildingPaints): void {
  const start = m.mark();
  const op = o.opening;
  const { u, v, w, h } = op;
  const zb = -0.24;
  // Behind the cream reveal, a shallow dark stall box (brief: "shallow
  // interior boxes behind serving windows"): dark-teal sides, floor and
  // ceiling a step lighter than the back, and one timber shelf across the
  // back, so the two biggest features of the front are rooms, not black
  // rectangles. Matte: a mirror-glossy back would read as a glazed shop window.
  const zr = -0.62;
  const back = paint(P.glass, { gloss: 0.3 });
  const side = paint(P.glass, { gloss: 0.3, color: mix(P.glass.color, DEEP_TEAL, 0.3) });
  const [bx0, bx1, by0, by1] = [u - w / 2 - 0.03, u + w / 2 + 0.03, v - 0.03, v + h + 0.03];
  quadFacing(m, V(bx0, by0, zr), V(bx1, by0, zr), V(bx1, by1, zr), V(bx0, by1, zr), V(0, 0, 1), back);
  quadFacing(m, V(bx0, by0, zb + 0.02), V(bx0, by0, zr), V(bx0, by1, zr), V(bx0, by1, zb + 0.02), V(1, 0, 0), side);
  quadFacing(m, V(bx1, by0, zr), V(bx1, by0, zb + 0.02), V(bx1, by1, zb + 0.02), V(bx1, by1, zr), V(-1, 0, 0), side);
  quadFacing(m, V(bx0, by1, zb + 0.02), V(bx0, by1, zr), V(bx1, by1, zr), V(bx1, by1, zb + 0.02), V(0, -1, 0), side);
  quadFacing(m, V(bx0, by0, zr), V(bx0, by0, zb + 0.02), V(bx1, by0, zb + 0.02), V(bx1, by0, zr), V(0, 1, 0), side);
  box(m, { min: [bx0 + 0.01, v + 0.52, zr - 0.01], max: [bx1 - 0.01, v + 0.57, zr + 0.2], faces: { nz: null } }, paint(P.timber, { gloss: 0.2 }));
  // The ring's inner wall is the lining of the reveal, back to the dark plane.
  // Its foot is square and only two points: the counter swallows it whole.
  const ring = (grow: number, r: number): [number, number][] => {
    const [hw, y0, y1] = [w / 2 + grow, v - grow, v + h + grow];
    const out: [number, number][] = [];
    for (const [sx, a0] of [[1, 0], [-1, 90]] as const) {
      for (let k = 0; k <= 3; k++) {
        const t = ((a0 + k * 30) * Math.PI) / 180;
        out.push([u + sx * (hw - r) + Math.cos(t) * r, y1 - r + Math.sin(t) * r]);
      }
    }
    out.push([u - hw, y0], [u + hw, y0]);
    return out;
  };
  const round = op.round ?? 0.1;
  frameRing(m, { inner: ring(-0.012, round - 0.012), outer: ring(SERVE_SURROUND, round + SERVE_SURROUND), z0: zb - 0.01, z1: 0.09, bevel: 0.035 }, soften(P.trim, 45));
  // Counter: top 2 cm above the reveal's floor, so the two never share a plane.
  roundedBox(m, { min: [u - COUNTER_HALF, v - 0.24, -0.2], max: [u + COUNTER_HALF, v + 0.02, COUNTER_OUT], radius: 0.06, segments: 1 }, P.trim);
  toFacade(m, start, o.on);
}

/**
 * Rear louvre vent as the sheet draws it: a rounded-rectangle cream frame
 * round four dark slots, the three bars between them as wide as the slots
 * (7 equal bands), so no slot thins to a hairline that aliases into dashes.
 */
function rearVent(m: SolidMesh, o: { on: Facade; u: number }, P: BuildingPaints): void {
  const start = m.mark();
  const [w, h] = [VENT_W, VENT_H];
  const op: Opening = { u: o.u, v: VENT_V - h / 2, w, h, round: 0.12, roundAll: true };
  // Dark backing a few mm proud of the wall, so it never fights the wall face.
  quadFacing(m, V(o.u - w / 2, op.v, 0.006), V(o.u + w / 2, op.v, 0.006), V(o.u + w / 2, op.v + h, 0.006), V(o.u - w / 2, op.v + h, 0.006), V(0, 0, 1), P.iron);
  const band = h / 7;
  for (let i = 1; i <= 3; i++) {
    const y = op.v + band * (2 * i - 0.5);
    box(m, { min: [o.u - w / 2, y - band / 2, 0.006], max: [o.u + w / 2, y + band / 2, 0.04], faces: { nz: null, px: null, nx: null } }, P.trim);
  }
  frameRing(m, { inner: openingRing(op, -0.01, 0, 2, true), outer: openingRing(op, 0.1, 0, 2, true), z0: -0.02, z1: 0.07, bevel: 0.03 }, soften(P.trim, 45));
  toFacade(m, start, o.on);
}

/** Apples, oranges, limes: what the vision image's stall has in its crates. */
const FRUIT: readonly RGB[] = [hex('#F0483C'), hex('#FFA62B'), hex('#B5E33A')];
const TRAY_HALF = 0.45;

/**
 * A display tray of fruit on a serving counter (variants only — the sheet's
 * counters are bare): a timber block tipped toward the street, six big domes
 * showing above its rim. The block reaches down INTO the counter slab, so the
 * tipped tray has no open underside to look into.
 */
function produceTray(m: SolidMesh, o: { on: Facade; u: number; fruit: number; seed: number }, P: BuildingPaints): void {
  const start = m.mark();
  const r = rng(o.seed, 'b08', 'produce');
  const [w0, w1, top] = [-0.12, 0.24, COUNTER + 0.1];
  // `pillow` has its chamfered face toward local +z: turned up, that is the rim.
  pillow(m, { x0: o.u - TRAY_HALF, x1: o.u + TRAY_HALF, y0: -w1, y1: -w0, z0: COUNTER - 0.2, z1: top, chamfer: 0.035 }, P.timber);
  m.rotate('x', -90, start);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const radius = 0.13 + r.range(-0.012, 0.012);
      const at: [number, number, number] = [o.u + (i - 1) * 0.27 + r.range(-0.02, 0.02), top - 0.035, w1 - 0.1 - j * 0.17 + r.range(-0.012, 0.012)];
      sphere(m, { radius, segments: 9, rings: 3, latitude: [0, 90], caps: false, at }, paint(jitterColor(r, FRUIT[o.fruit % FRUIT.length], { hue: 5, lightness: 0.04 }), { gloss: 0.6, smooth: 90 }));
    }
  }
  m.rotate('x', 26, start, [o.u, COUNTER, w1]);
  toFacade(m, start, o.on);
}

/**
 * The shop awning as the sheet draws it — thick canvas, not a sheet of
 * paper: the stripes run down the pitch, roll over a rounded front edge and
 * end in a valance with one hanging lobe each. (The kit's `awning` is a flat
 * 5 cm board with a three-step scallop; on this building the awning IS the
 * front, so it is built here.) Every stripe is its own strip of faces on one
 * shared section, so the surface shades as one piece and the colour edge is
 * crisp. Closed all round: the underside is what the chase camera sees.
 */
function shopAwning(m: SolidMesh, o: { on: Facade; stripe: Paint; canvas: Paint }): void {
  const start = m.mark();
  const a = (AWN_PITCH * Math.PI) / 180;
  const [sa, ca] = [Math.sin(a), Math.cos(a)];
  const top = (w: number): number => AWN_V - Math.tan(a) * w;
  // The roll: centre, and where the pitch runs into it.
  const cw = AWN_OUT - AWN_NOSE;
  const tw = cw + AWN_NOSE * sa;
  const cv = top(tw) - AWN_NOSE * ca;
  const back = -0.04; // buried in the wall
  // Section (w, v), wall to valance: outer skin with a station near the wall
  // (the tie beam's contact shadow stays there instead of fading down the
  // whole canvas), then the inner skin.
  const NOSE = 4;
  const outer: [number, number][] = [[back, top(back)], [0.34, top(0.34)], [tw, top(tw)]];
  for (let k = 1; k <= NOSE; k++) {
    const th = (Math.PI / 2 - a) * (1 - k / NOSE);
    outer.push([cw + AWN_NOSE * Math.cos(th), cv + AWN_NOSE * Math.sin(th)]);
  }
  const ri = AWN_NOSE - AWN_THICK;
  const inner: [number, number][] = [[back, top(back) - AWN_THICK / ca], [cw + ri * sa, cv + ri * ca], [AWN_OUT - AWN_THICK, cv]];
  const sw = AWN_WIDTH / AWN_STRIPES;
  const vs = cv - AWN_STRAIGHT;
  const LOBE = 8;
  for (let i = 0; i < AWN_STRIPES; i++) {
    const p = soften(i % 2 ? o.canvas : o.stripe, 40);
    const u0 = -AWN_WIDTH / 2 + i * sw;
    const u1 = u0 + sw;
    const skin = (pts: [number, number][], sign: 1 | -1): void => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const [w0, v0] = pts[k];
        const [w1, v1] = pts[k + 1];
        quadFacing(m, V(u0, v0, w0), V(u1, v0, w0), V(u1, v1, w1), V(u0, v1, w1), V(0, sign * (w1 - w0), sign * (v0 - v1)), p);
      }
    };
    skin(outer, 1);
    skin(inner, -1);
    // Valance: front and back face of the lobe, and the edge between them.
    const lobe: [number, number][] = [];
    for (let k = 0; k <= LOBE; k++) {
      const ph = Math.PI + (k / LOBE) * Math.PI;
      lobe.push([(u0 + u1) / 2 + (Math.cos(ph) * sw) / 2, vs + Math.sin(ph) * AWN_LOBE]);
    }
    const outline: [number, number][] = [[u0, cv], ...lobe, [u1, cv]];
    polygonFacing(m, outline.map(([u, v]) => V(u, v, AWN_OUT)), V(0, 0, 1), p);
    polygonFacing(m, outline.map(([u, v]) => V(u, v, AWN_OUT - AWN_THICK)), V(0, 0, -1), p);
    for (let k = 0; k < LOBE; k++) {
      const [ax, ay] = lobe[k];
      const [bx, by] = lobe[k + 1];
      quadFacing(m, V(ax, ay, AWN_OUT), V(bx, by, AWN_OUT), V(bx, by, AWN_OUT - AWN_THICK), V(ax, ay, AWN_OUT - AWN_THICK), V((ax + bx) / 2 - (u0 + u1) / 2, (ay + by) / 2 - vs - 0.02, 0), p);
    }
    // The two free ends of the whole awning.
    for (const [u, su] of [[u0, -1], [u1, 1]] as const) {
      if (i !== (su < 0 ? 0 : AWN_STRIPES - 1)) continue;
      polygonFacing(m, [...outer, ...[...inner].reverse()].map(([w, v]) => V(u, v, w)), V(su, 0, 0), p);
      quadFacing(m, V(u, cv, AWN_OUT), V(u, vs, AWN_OUT), V(u, vs, AWN_OUT - AWN_THICK), V(u, cv, AWN_OUT - AWN_THICK), V(su, 0, 0), p);
    }
  }
  toFacade(m, start, o.on);
}

/**
 * One awning bracket, as the sheet draws them: a timber wall plate, an arm
 * lying under the canvas and a diagonal strut between the two.
 */
function awningBracket(m: SolidMesh, o: { on: Facade; u: number }, p: Paint): void {
  const start = m.mark();
  const a = (AWN_PITCH * Math.PI) / 180;
  // Centre line of the arm: its top is sunk a centimeter into the canvas.
  const armV = (w: number): number => AWN_V - Math.tan(a) * w - AWN_THICK / Math.cos(a) - 0.05;
  const tip = AWN_OUT - 0.22;
  beam(m, { from: [o.u, 1.52, 0.05], to: [o.u, armV(0.05) + 0.02, 0.05], size: [0.2, 0.14], side: [0, 0, 1], back: false, caps: 'start', segments: 1 }, p);
  beam(m, { from: [o.u, armV(-0.02), -0.02], to: [o.u, armV(tip), tip], size: [0.16, 0.12], side: [0, Math.cos(a), Math.sin(a)], caps: 'end', segments: 1 }, p);
  beam(m, { from: [o.u, 1.66, 0.07], to: [o.u, armV(tip - 0.16) + 0.02, tip - 0.16], size: 0.15, side: [1, 0, 0], caps: false, segments: 2 }, p);
  toFacade(m, start, o.on);
}

/**
 * The sheet's gable lamp: a broad timber-orange oval with a glowing amber
 * lens behind a cross of cage bars. (The kit's L01 `wallLamp` has a thin
 * cream rim; this one is half casing.)
 */
function gableLamp(m: SolidMesh, o: { on: Facade; u: number; v: number }, P: BuildingPaints): void {
  const start = m.mark();
  const [w, h] = [1.0, 0.54];
  const casing = soften(paint(P.timber, { gloss: 0.45 }), 45);
  // Its open back starts inside the gable wall: beside the truss there is
  // nothing behind it, and from below the chase camera would see into it.
  extrudePolygon(m, { outline: roundedRectRing(w, h, h / 2, 6), depth: 0.23, bevel: 0.045, back: false, at: [o.u, o.v, -0.11] }, casing);
  const [lw, lh] = [w - 0.26, h - 0.24];
  // The lens is a flat glowing pane 6 mm proud of the casing's face.
  polygonFacing(m, roundedRectRing(lw, lh, lh / 2, 5).map(([x, y]) => V(o.u + x, o.v + y, 0.126)), V(0, 0, 1), LAMP_GLOW);
  // The upright bar stands a hair behind the cross bar, so their faces differ.
  box(m, { min: [o.u - 0.017, o.v - lh / 2 - 0.02, 0.1], max: [o.u + 0.017, o.v + lh / 2 + 0.02, 0.172], faces: { nz: null } }, casing);
  box(m, { min: [o.u - lw / 2 - 0.02, o.v - 0.017, 0.1], max: [o.u + lw / 2 + 0.02, o.v + 0.017, 0.178], faces: { nz: null } }, casing);
  toFacade(m, start, o.on);
}

/** Bargeboard section (the kit's defaults) and the roof slab thickness. */
const BOARD_DEPTH = 0.44;
const BOARD_THICK = 0.3;
const SLAB = 0.14;

/**
 * The roof: the kit's `gableRoof` built WITHOUT its bargeboards, and the
 * boards re-laid here with this sheet's apex boss — a faceted pentagon
 * (flat top, shoulders along the rakes, broad bevels) instead of the kit's
 * round-topped one. The slab's gable overhang is shortened by what the
 * boards would have overlapped and the rise is passed explicitly, so slab,
 * seams, ridge roll and `heightAt` are exactly those of the boarded roof.
 */
function marketRoof(m: SolidMesh, P: BuildingPaints): RoofInfo {
  const lap = 0.07;
  const rise = gableRoofInfo({ span: W, length: D, eave: EAVE, top: ROOF_TOP, overhang: OVERHANG }).rise;
  const [ogA, ogB] = OVERHANG.gable;
  const roof = gableRoof(m, { span: W, length: D, eave: EAVE, rise, overhang: { eave: OVERHANG.eave, gable: [ogA - BOARD_THICK + lap, ogB - BOARD_THICK + lap] }, bargeboards: false }, P);
  const half = W / 2;
  const len = Math.hypot(half, rise);
  const [c, sn, tan] = [half / len, rise / len, rise / half];
  const pitch = roof.pitch;
  const apexT = EAVE + rise + SLAB / c;
  const ebx = half + OVERHANG.eave + SLAB * sn;
  // Boards: their top 6.5 cm proud of the roof surface (as in the kit).
  const lift = 0.065;
  const s1 = ebx / c + 0.1;
  const mid = s1 / 2;
  const bx = mid * c + (lift - BOARD_DEPTH / 2) * sn;
  const by = apexT - mid * sn + (lift - BOARD_DEPTH / 2) * c;
  // Boss, as seen from the front (x right, y up from its top): flat top,
  // shoulders parallel to the rakes, short upright sides, a V underneath
  // that follows the boards.
  const [hw, ht] = [0.4, 0.17];
  const sh = (hw - ht) * tan;
  const boss: [number, number][] = [[-ht, 0], [-hw, -sh], [-hw, -0.4], [0, -0.4 - hw * tan], [hw, -0.4], [hw, -sh], [ht, 0]];
  const trim = soften(P.trim, 46);
  for (const zc of [-D / 2 - ogA + BOARD_THICK / 2, D / 2 + ogB - BOARD_THICK / 2]) {
    for (const s of [1, -1]) {
      roundedBox(m, { size: [s1, BOARD_DEPTH, BOARD_THICK], radius: 0.07, segments: 2, rot: [0, 0, -pitch * s], at: [s * bx, by, zc] }, P.trim);
    }
    extrudePolygon(m, { outline: boss, depth: BOARD_THICK + 0.1, centered: true, bevel: 0.07, bevelSegments: 1, bevelBack: true, at: [0, ROOF_TOP, zc] }, trim);
  }
  return roof;
}

/**
 * The kit's `chimney` with this sheet's stack: a louvre of three slats in
 * the slot instead of two (the sheet draws three or four).
 */
function marketChimney(m: SolidMesh, o: { x: number; z: number; roof: RoofInfo; height: number }, P: BuildingPaints): void {
  const { x, z } = o;
  const sx = CHIMNEY_SIZE;
  const yRoof = o.roof.heightAt(x, z);
  const top = yRoof + o.height;
  const r = 0.07;
  const y0 = yRoof - 0.5;
  const y1 = top - 0.08;
  roundedBox(m, { min: [x - sx / 2, y0, z - sx / 2], max: [x + sx / 2, y1, z + sx / 2], radius: r, segments: 1, faces: { ny: null, nz: null } }, P.trim);
  const over = 0.12;
  roundedBox(m, { min: [x - sx / 2 - over, top - 0.32, z - sx / 2 - over], max: [x + sx / 2 + over, top, z + sx / 2 + over], radius: 0.13, segments: 3 }, P.roof);
  roundedBox(m, { size: [sx + 0.22, 0.24, sx + 0.22], radius: 0.06, segments: 1, rot: o.roof.tiltAt(x, z), at: [x, yRoof + 0.03, z] }, P.roof);
  // The front face rebuilt as a frame of cells round a recessed slot.
  const start = m.mark();
  const us = [-sx / 2 + r, -sx * 0.27, sx * 0.27, sx / 2 - r];
  const vs = [y0 + r, top - 0.72, top - 0.46, y1 - r];
  const front = V(0, 0, 1);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      quadFacing(m, V(us[i], vs[j], 0), V(us[i + 1], vs[j], 0), V(us[i + 1], vs[j + 1], 0), V(us[i], vs[j + 1], 0), front, P.trim);
    }
  }
  const depth = 0.09;
  const [l, rr, b, tp] = [us[1], us[2], vs[1], vs[2]];
  quadFacing(m, V(l, b, 0), V(rr, b, 0), V(rr, b, -depth), V(l, b, -depth), V(0, 1, 0), P.iron);
  quadFacing(m, V(l, tp, 0), V(rr, tp, 0), V(rr, tp, -depth), V(l, tp, -depth), V(0, -1, 0), P.iron);
  quadFacing(m, V(l, b, 0), V(l, tp, 0), V(l, tp, -depth), V(l, b, -depth), V(1, 0, 0), P.iron);
  quadFacing(m, V(rr, b, 0), V(rr, tp, 0), V(rr, tp, -depth), V(rr, b, -depth), V(-1, 0, 0), P.iron);
  quadFacing(m, V(l, b, -depth), V(rr, b, -depth), V(rr, tp, -depth), V(l, tp, -depth), front, P.iron);
  for (const f of [0.22, 0.5, 0.78]) {
    const yy = b + (tp - b) * f;
    box(m, { min: [l - 0.01, yy - 0.018, -depth], max: [rr + 0.01, yy + 0.018, -0.03], faces: { nz: null, px: null, nx: null } }, CHIMNEY_SLAT);
  }
  toFacade(m, start, { facing: '-z', plane: sx / 2 - z, center: x });
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'warm');
  const P = variantPaints(base.scheme === 'warm' ? withPaints(base, { wall: MINT, shutter: DEEP_TEAL }) : base, v);
  const m = new SolidMesh();

  // a. Roof — its rise sets the gable walls.
  const roof = marketRoof(m, P);

  // b. Plinth, removed between the jambs of the two doors. Two true-plane
  // cuts each (a region test misses faces wider than the region): split the
  // core's big top face along the wall plane, then drop everything in front
  // of that plane between the jambs.
  const plinth = m.mark();
  stonePlinth(m, { width: W, depth: D, top: PLINTH, seed: PLINTH_LAYOUTS[Math.abs(Math.round(seed)) % PLINTH_LAYOUTS.length], blockLength: [0.8, 1.5], split: 0.45 }, P);
  const coreTop = (q: Vector3, n: Vector3): boolean => n.y > 0.9 && Math.abs(q.z) < D / 2 - 0.3 && Math.abs(q.x) < W / 2 - 0.3;
  paintStripe(m, { axis: 'z', max: -D / 2 - 0.005, only: coreTop, from: plinth }, P.stoneDark);
  paintStripe(m, { axis: 'z', min: D / 2 + 0.005, only: coreTop, from: plinth }, P.stoneDark);
  const cut = (door: Opening): number => door.w / 2 + DOOR_SURROUND / 2;
  paintStripe(m, { axis: 'x', min: -cut(FRONT_DOOR), max: cut(FRONT_DOOR), only: (q) => q.z < -D / 2 - 0.001, from: plinth }, null);
  paintStripe(m, { axis: 'x', min: -cut(REAR_DOOR), max: cut(REAR_DOOR), only: (q) => q.z > D / 2 + 0.001, from: plinth }, null);

  // c. Walls with their openings.
  const serve = (side: 1 | -1): Opening => ({ u: side * SERVE_U, v: COUNTER - 0.02, w: SERVE_W, h: 1.0, round: 0.1 });
  const sideWin: Opening = { u: 0, v: 1.2, w: c.winW, h: 1.0 };
  const tieY = EAVE + TIE_RAISE;
  // Doors and vents are mounted ON the wall and need no hole, but the wall
  // gets one behind each all the same: baked AO lives on the wall grid's
  // vertices, and a vertex buried under a door leaf or a vent bakes black and
  // smears a dark star over the open wall round it. Each hole is smaller than
  // the part that covers it.
  const bottom = PLINTH - 0.1;
  const behindDoor = (d: Opening): Opening => ({ u: d.u, v: bottom, w: d.w - 0.12, h: d.v + d.h - 0.22 - bottom });
  const vent = (side: number): Opening => ({ u: side * VENT_U, v: VENT_V - VENT_H / 2 + 0.04, w: VENT_W - 0.08, h: VENT_H - 0.08 });
  const walls = m.mark();
  const F = wallBox(
    m,
    {
      width: W,
      depth: D,
      bottom,
      top: EAVE,
      gable: { ridge: 'z', rise: roof.rise },
      gablePaint: paint(GABLE_BOARDS, { gloss: 0.15 }),
      gableFrom: tieY,
      grid: 1.2,
      openings: { front: [serve(-1), behindDoor(FRONT_DOOR), serve(1)], left: [sideWin], right: [sideWin], back: [vent(-1), behindDoor(REAR_DOOR), vent(1)] },
    },
    P.wall,
  );

  const wallsEnd = m.mark();

  // d. Cream pilasters on stout bases, up into the roof.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.05, top: EAVE + 0.05, size: POST, proud: POST_PROUD, base: { height: 0.34, grow: 0.07 } }, P.trim);

  // e. Truss in both gables (the brief's ridge puts a gable at the back too).
  const framing = { width: W - 0.3, base: EAVE, rise: roof.rise * ((W - 0.3) / W), size: 0.3, tieRaise: TIE_RAISE, tieSize: TIE_SIZE, strutAngle: 30 };
  gableFraming(m, { on: F.front, ...framing }, P.timber);
  gableFraming(m, { on: F.back, ...framing, struts: false, rakes: false }, P.timber);

  // f. Openings.
  portalDoor(m, { on: F.front, opening: FRONT_DOOR, leaf: P.door }, P);
  // The stockroom door is the scheme's pop colour (coral on the sheet).
  portalDoor(m, { on: F.back, opening: REAR_DOOR, leaf: P.accent, detail: 0 }, P);
  for (const side of [1, -1] as const) servingWindow(m, { on: F.front, opening: serve(side) }, P);
  if (c.produce) produceTray(m, { on: F.front, u: c.produce * SERVE_U, fruit: c.fruit, seed }, P);
  windowUnit(m, { on: F.left, opening: sideWin, shutters: c.sideShutters, flowerBox: c.flowerBoxes, seed: seed * 2 }, P);
  windowUnit(m, { on: F.right, opening: sideWin, shutters: c.sideShutters, flowerBox: c.flowerBoxes, seed: seed * 2 + 1 }, P);
  for (const side of [1, -1]) rearVent(m, { on: F.back, u: side * VENT_U }, P);

  // g. Attachments.
  shopAwning(m, { on: F.front, stripe: stripePaint(P, c.stripe), canvas: P.fabric });
  for (const u of BRACKETS) awningBracket(m, { on: F.front, u }, P.timber);
  // In front of the truss (proud 0.08), over the king post's foot.
  gableLamp(m, { on: offsetFacade(F.front, 0.09), u: 0, v: tieY + 0.36 }, P);
  marketChimney(m, { x: c.chimneySide * CHIMNEY[0], z: CHIMNEY[1], roof, height: CHIMNEY_HEIGHT + v.shift('chimneyH', 0.08) }, P);
  if (c.lantern) wallLantern(m, { on: F.front, u: c.lantern * (W / 2 - POST / 2 + POST_PROUD), v: 2.2, reach: 0.4, proud: POST_PROUD }, P);
  if (c.solar) {
    const at: [number, number] = [-c.chimneySide * 1.7, 0.3];
    solarPanel(m, { at: [at[0], roof.heightAt(at[0], at[1]) + 0.05, at[1]], size: [1.6, 1.0], cells: [4, 2], rot: [0, 90, roof.tiltAt(at[0], at[1])[2]] }, P);
  }

  // h. Dressing.
  c.pots.forEach((at, i) => planter(m, { at, seed: seed * 7 + i, paint: i === 0 ? P.accent : P.trim }, P));
  finishBuilding(m);
  easeWallAO(m, walls, wallsEnd);
  return m;
}

/**
 * The back and side walls are big bare plaster fields on a 1.2 m grid. Their
 * grid vertices on the edges of the holes behind the vents and the door sit
 * under those parts' frames and bake dark, and across 1.2 m cells that
 * darkness interpolates into wedges and stars on the open wall; the faint
 * 0.8 – 0.95 tones elsewhere do the same on a smaller scale. On the outer
 * faces of those walls, the open field (clear of the plinth, the eave and the
 * corner pilasters, where the real contact shadows are) is therefore held at
 * 0.9 or lighter, and the light end of the range is eased everywhere else on
 * them. The front wall keeps its bake: there the awning's shade is the point.
 */
function easeWallAO(m: SolidMesh, from: number, to: number): void {
  const P = m.positions;
  const A = Float32Array.from(m.cornerAO);
  for (let t = from; t < to; t++) {
    const o = t * 9;
    const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
    const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3;
    const cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    const back = nz / len > 0.9 && cz > D / 2 - 0.05;
    const side = Math.abs(nx / len) > 0.9 && Math.abs(cx) > W / 2 - 0.05;
    if (!back && !side) continue;
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const [x, y, z] = [P[o + k * 3], P[o + k * 3 + 1], P[o + k * 3 + 2]];
      const along = back ? W / 2 - Math.abs(x) : D / 2 - Math.abs(z);
      const open = y > PLINTH + 0.25 && y < EAVE - 0.4 && along > 0.55;
      const a = A[i];
      if (open) A[i] = Math.max(a, 0.9);
      // Untouched up to 0.7, ramping to 45 % of the darkening from 0.85 up.
      else if (a > 0.7) A[i] = 1 - (1 - a) * (1 - 0.55 * Math.min(1, (a - 0.7) / 0.15));
    }
  }
  m.writeAO(A);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const wallTop = EAVE + 0.1;
  const roof = gableRoofInfo({ span: W, length: D, eave: EAVE, top: ROOF_TOP });
  // The slopes as stacked boxes, each topping out at the roof's height 0.5 m
  // inside its own edge, so a car that lands on the roof rests on what it sees.
  const roofStep = (halfWidth: number): ColliderSpec => {
    const top = roof.heightAt(Math.max(0, halfWidth - 0.5), 0);
    return { shape: 'box', center: [0, (wallTop + top) / 2, -0.05], half: [halfWidth, (top - wallTop) / 2, D / 2 + 0.35] };
  };
  const cx = c.chimneySide * CHIMNEY[0];
  const chimneyBase = roof.heightAt(cx, 0) - 0.3;
  const chimneyTop = roof.heightAt(cx, 0) + CHIMNEY_HEIGHT;
  return [
    // Walls, including the plinth's proud blocks and the door portals.
    { shape: 'box', center: [0, wallTop / 2, 0], half: [W / 2 + 0.15, wallTop / 2, D / 2 + 0.2] },
    ...[3.7, 2.5, 1.3].map(roofStep),
    { shape: 'box', center: [cx, (chimneyBase + chimneyTop) / 2, CHIMNEY[1]], half: [CHIMNEY_SIZE / 2 + 0.12, (chimneyTop - chimneyBase) / 2, CHIMNEY_SIZE / 2 + 0.12] },
    // Serving counters, down to the ground so nothing wedges under them. The
    // awning (2.24 m and up) and its brackets (1.5 m and up, on the wall) stay open.
    ...[1, -1].map((s): ColliderSpec => ({ shape: 'box', center: [s * SERVE_U, COUNTER / 2, -D / 2 - COUNTER_OUT / 2], half: [COUNTER_HALF, COUNTER / 2, COUNTER_OUT / 2] })),
    ...c.pots.map(([x, z]): ColliderSpec => ({ shape: 'cylinder', base: [x, 0, z], height: 0.45, radius: 0.28 })),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b08-market-hall',
  name: 'B08 Market Hall',
  category: 'building',
  size: { x: 8.78, y: 5.47, z: 6.57 },
  variants: 3,
  schemes: ['warm', 'coastal', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/village-services/design-sheet.png',
    brief: 'design-documents/building-design-pack/village-services/b08-market-hall-brief.txt',
  },
  build,
  colliders,
};

export default asset;
