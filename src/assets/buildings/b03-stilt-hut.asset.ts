import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, aim, box, cylinder, extrudePolygon, frustum, mixOklab, paint, polygonFacing, quadFacing, shade, soften, sphere } from '../../gfx/solid';
import type { Paint, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  barrel,
  beam,
  chamferRing,
  cornerPosts,
  crate,
  door,
  finishBuilding,
  hipRoof,
  kneeBrace,
  planter,
  rib,
  schemePaints,
  solarPanel,
  stoneBlock,
  toFacade,
  variantPaints,
  variation,
  wallBox,
  wallLantern,
  windowUnit,
  withPaints,
} from './parts';
import type { BuildingPaints, Opening } from './parts';

/**
 * B03 — Stilt Hut. Sheet colours: cream boarded walls, TEAL hip roof with
 * coral hip straps and apex cap, coral door, teal window frames. That is the
 * style guide's WARM scheme (cream walls, teal frames) wearing the roof and
 * door of 'sunny', so 'warm' seed 0 is overridden to the sheet's roof / door;
 * other 'warm' seeds keep the style guide's coral roof (teal straps), and
 * 'sunny' gets cream straps so it differs from the sheet in more than wall
 * colour. 'coastal' is the style guide's own.
 *
 * MAIN BODY 4.0 (x) × 4.0 (z) m on a raised timber deck: floor 0.9 m, cream
 * fascia band 3.08 – 3.43, roof springing 3.5 m, top of the apex cap 4.6 m
 * (all the brief's numbers). OVERALL 4.8 × 4.6 × 6.8 m (x ±2.4,
 * z −4.42 … +2.38) with the eaves, the sheet's 1.1 m veranda and a 1.32 m
 * stair — exactly the brief's 4.8 × 6.8 m placement envelope.
 *
 * STRUCTURE (brief): six main stilts in a 3 × 2 plan — x = −1.7 / 0 / +1.7,
 * z = ∓1.7 (the brief's Y = 0.3 and 3.7 behind the front wall) — plus two
 * veranda stilts under the front edge of the deck, each on a footing block,
 * with bold knee braces (0.5 m reach, 17 cm section) up to the deck, the
 * veranda stilts braced back toward the house too. Central stair, 0.9 m
 * rise, 1.32 m run (the brief's "approximately 1.6" would leave the
 * envelope).
 *
 * FLOOR HEIGHT. The sheet draws the hut on ~1.2 m legs; the brief resolves
 * "floor 0.9 m, stair rises 0.9 m". The brief is kept; a 0.15 m deck and
 * 0.16 m footings leave ~0.6 m of stilt showing. `FLOOR` is the one number
 * to change if the sheet's taller legs are wanted: deck, stilts, stair, door
 * and colliders follow it (window sills and wall boards are plain numbers).
 *
 * Opening schedule (brief): front = centred door + a window each side; one
 * window on each side wall; one centred rear window. Windows carry the
 * sheet's thick frame-coloured surround instead of a cream sill and lintel.
 * The door is 1.0 × 1.95 m, not the shared nominal 2.2: the wall has 2.18 m
 * between deck and fascia, and the sheet draws the door head barely above
 * the window heads.
 *
 * OWN PARTS (not in the shared kit): the fascia band with proud corner blocks
 * cut at 45° in plan, the folded hip straps with rivets, their corner
 * starter plates and the octagonal apex cap, crisp post capitals, the
 * veranda railing with chunky 7 × 17 cm boards, a satin door knob sized to
 * the sheet, and the stair with chunky cream stringers standing proud of the
 * treads (the kit's `stairFlight` 'open' has 8 cm stringers under the
 * nosings).
 *
 * Seeds: 0 = the sheet. 1 = lavender stone footings, lantern on the right
 * corner post, a planter on the veranda, a barrel planter by the stair;
 * 2 = open shutters on the side windows, a lit front window, a crate on the
 * veranda, a solar panel on the rear roof slope. The door colour cycles
 * (`DOOR_COLOURS`), the knob changes side, window width shifts ±2 cm.
 * 5 206 triangles for seed 0, 5 732 / 5 882 for seeds 1 / 2; the scheme
 * does not change the count.
 */

const W = 4.0;
const D = 4.0;
const FLOOR = 0.9;
/** A thin deck and low footings buy leg length under the brief's 0.9 m floor. */
const DECK_T = 0.15;
const DECK_BOTTOM = FLOOR - DECK_T;
/** Half-width of the deck, and how far it runs behind the back wall. */
const DECK_X = 2.16;
const DECK_BACK = D / 2 + 0.14;
/** Veranda depth in front of the front wall. */
const VERANDA = 1.1;
const DECK_FRONT = -D / 2 - VERANDA;
/** Underside and top of the cream fascia band; the roof slopes start at `SPRING`. */
const FASCIA_BOTTOM = 3.08;
const FASCIA_TOP = 3.43;
const SPRING = 3.5;
const ROOF_TOP = 4.6;
const OVERHANG = 0.38;
/** Roof apex (under the cap) and the cap's height above it. */
const CAP_CROWN = 0.1;
const APEX = ROOF_TOP - CAP_CROWN;
const POST = 0.32;
/** How far the corner posts stand out of the walls: more than the window
 * surrounds (0.07), so the posts stay the outermost wall element. */
const POST_PROUD = 0.09;
const STILT = 0.28;
const FOOTING: readonly [number, number, number] = [0.46, 0.16, 0.46];
const BRACE_REACH = 0.5;
const BRACE_SIZE = 0.17;
const RAIL_H = 0.9;
const RAIL_Z = DECK_FRONT + 0.13;
const RAIL_X = 2.0;
/** Stair: clear half-width between the stringers, stringer width, run (the
 * brief's "approximately 1.6" would push past the 6.8 m envelope with the
 * sheet's deeper veranda). */
const STAIR_HALF = 0.54;
const STRINGER = 0.16;
const STAIR_RUN = 1.32;
const STAIR_STEPS = 5;
/** Board pitch and wall top chosen together: the joints then land at
 * 1.13 … 2.78 and 3.11 (behind the fascia), never in the strip between the
 * opening heads and the fascia where they would read as floating bars. */
const BOARD_PITCH = 0.33;
const WALL_BOTTOM = FLOOR - 0.1;
const WALL_TOP = WALL_BOTTOM + 8 * BOARD_PITCH;

const STILTS: readonly (readonly [number, number])[] = [
  [-1.7, -1.7], [0, -1.7], [1.7, -1.7],
  [-1.7, 1.7], [0, 1.7], [1.7, 1.7],
  [-1.7, DECK_FRONT + 0.22], [1.7, DECK_FRONT + 0.22],
];

/** The opening starts 1.5 cm above the deck: its reveal has a floor of its
 * own, which must not share the deck's plane (it reads as a cream threshold). */
const DOOR: Opening = { u: 0, v: FLOOR + 0.015, w: 1.0, h: 1.95, round: 0.12 };

/** No teal door on 'warm' / 'sunny': it would sit beside teal frames. */
const DOOR_COLOURS = {
  warm: [BUILDING.coral, BUILDING.cobalt, BUILDING.mustard],
  coastal: [BUILDING.coral, BUILDING.mustard, BUILDING.cobalt],
  sunny: [BUILDING.coral, BUILDING.cobalt, BUILDING.timber],
} as const;

function choices(seed: number) {
  const v = variation(seed, 'b03');
  return {
    v,
    footing: v.cycle(['cream', 'stone', 'cream'] as const),
    lantern: v.cycle([0, 1, 0] as const),
    sideShutters: v.cycle(['none', 'none', 'open'] as const),
    veranda: v.cycle(['none', 'planter', 'crate'] as const),
    barrelSide: v.cycle([0, 1, 0] as const),
    solar: v.cycle([false, false, true] as const),
    lit: v.cycle([false, false, true] as const),
    knobSide: v.cycle([-1, 1, -1] as const),
    winW: 0.68 + v.shift('winW', 0.02),
  };
}

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/**
 * A chamfered band swept along an open plan polyline (x, z) around the
 * building's centre, section `height` × `thick` centred on the line at
 * height `y`, mitred at the inner vertices. `caps` closes the two ends.
 * The paint is used as given: a crease below 45° keeps the plan corners and
 * the section chamfers crisp (smoothing across them smeared each corner into
 * a pillow gradient).
 */
function band(m: SolidMesh, plan: readonly Vec2[], o: { y: number; height: number; thick: number; caps: boolean }, p: Paint): void {
  const n = plan.length;
  // Outward (away from the building centre) unit normal of segment i → i + 1.
  const normals: Vec2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const [x0, z0] = plan[i];
    const [x1, z1] = plan[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    let nx = (z1 - z0) / len;
    let nz = -(x1 - x0) / len;
    if (nx * (x0 + x1) + nz * (z0 + z1) < 0) {
      nx = -nx;
      nz = -nz;
    }
    normals.push([nx, nz]);
  }
  // Mitre vector of each vertex: a section point `d` out of the centre line
  // sits at vertex + mitre · d. End vertices are square to their segment.
  const mitre: Vec2[] = plan.map((_, i) => {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(n - 2, i)];
    const s = 1 + a[0] * b[0] + a[1] * b[1];
    return [(a[0] + b[0]) / s, (a[1] + b[1]) / s];
  });
  const section = chamferRing(o.height, o.thick, Math.min(o.height, o.thick) * 0.2);
  const at = (i: number, j: number): Vector3 => {
    const [sh, sd] = section[j];
    return V(plan[i][0] + mitre[i][0] * sd, o.y + sh, plan[i][1] + mitre[i][1] * sd);
  };
  const s = section.length;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < s; j++) {
      const j1 = (j + 1) % s;
      const hm = (section[j][0] + section[j1][0]) / 2;
      const dm = (section[j][1] + section[j1][1]) / 2;
      // The inner face lies inside the wall: not emitted.
      if (dm < -o.thick / 2 + 1e-6) continue;
      quadFacing(m, at(i, j), at(i, j1), at(i + 1, j1), at(i + 1, j), V(normals[i][0] * dm, hm, normals[i][1] * dm), p);
    }
  }
  if (o.caps) {
    const ends: [number, number][] = [[0, 1], [n - 1, n - 2]];
    for (const [i, k] of ends) {
      const dir = V(plan[i][0] - plan[k][0], 0, plan[i][1] - plan[k][1]);
      polygonFacing(m, section.map((_, j) => at(i, j)), dir, p);
    }
  }
}

/**
 * The cream fascia round the eaves, as the sheet draws it: a chunky band
 * between four corner blocks that stand 2 cm prouder and taller, each with
 * its PLAN corner cut off at 45° (a square block would end in a knife-edge
 * arris right at eye level of the elevated camera). The straight runs end
 * inside the blocks; each carries a mid point so its long faces have a
 * vertex in the open for the AO bake.
 */
function fascia(m: SolidMesh, o: { half: number; cut: number; block: number; y: number; height: number; thick: number }, p: Paint): void {
  const h = o.half;
  const k = o.cut;
  const b = h - o.block;
  const run = b + 0.04;
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      band(m, [[sx * h, sz * b], [sx * h, sz * (h - k)], [sx * (h - k), sz * h], [sx * b, sz * h]], { y: o.y, height: o.height + 0.04, thick: o.thick + 0.04, caps: true }, p);
    }
    band(m, [[sx * h, -run], [sx * h, 0], [sx * h, run]], { y: o.y, height: o.height, thick: o.thick, caps: false }, p);
    band(m, [[-run, sx * h], [0, sx * h], [run, sx * h]], { y: o.y, height: o.height, thick: o.thick, caps: false }, p);
  }
}

/**
 * A cover strip folded over a hip from `a` up to `b`: two flat wings lying on
 * the two roof faces (unit normals `n1`, `n2`), chamfered outer edges, open
 * underneath. The sheet's hips are broad flat straps, not the kit's round
 * rolls — and a flat board on a hip would float 5 cm off the roof along both
 * edges, hence the fold.
 */
function hipCover(
  m: SolidMesh,
  a: Vector3,
  b: Vector3,
  n1: Vector3,
  n2: Vector3,
  o: { width: number; thick: number; chamfer: number; segments?: number; capStart?: boolean; capEnd?: boolean },
  p: Paint,
): void {
  const d = b.subtract(a).normalize();
  const length = Vector3.Distance(a, b);
  const mid = n1.add(n2).normalize();
  const ridgeLift = o.thick / Vector3.Dot(mid, n1);
  // In-face direction square to the hip, pointing away from the other face.
  const across = (n: Vector3, other: Vector3): Vector3 => {
    const s = Vector3.Cross(n, d).normalize();
    return Vector3.Dot(s, other) > 0 ? s.scale(-1) : s;
  };
  const wings = [
    { n: n1, s: across(n1, n2) },
    { n: n2, s: across(n2, n1) },
  ];
  const hw = o.width / 2;
  const c = o.chamfer;
  const sink = 0.012;
  // Section of one wing at hip point q: ridge, top edge, chamfer foot, base.
  const ring = (q: Vector3, w: { n: Vector3; s: Vector3 }): [Vector3, Vector3, Vector3, Vector3] => [
    q.add(mid.scale(ridgeLift)),
    q.add(w.s.scale(hw - c)).add(w.n.scale(o.thick)),
    q.add(w.s.scale(hw)).add(w.n.scale(o.thick - c)),
    q.add(w.s.scale(hw)).subtract(w.n.scale(sink)),
  ];
  const segs = Math.max(1, o.segments ?? 1);
  for (let k = 0; k < segs; k++) {
    const q0 = a.add(d.scale((length * k) / segs));
    const q1 = a.add(d.scale((length * (k + 1)) / segs));
    for (const w of wings) {
      const A = ring(q0, w);
      const B = ring(q1, w);
      quadFacing(m, A[0], B[0], B[1], A[1], w.n, p);
      quadFacing(m, A[1], B[1], B[2], A[2], w.n.add(w.s), p);
      quadFacing(m, A[2], B[2], B[3], A[3], w.s, p);
    }
  }
  const cap = (q: Vector3, dir: Vector3): void => {
    const L = ring(q, wings[0]);
    const R = ring(q, wings[1]);
    polygonFacing(m, [L[3], L[2], L[1], L[0], R[1], R[2], R[3]], dir, p);
  };
  if (o.capStart ?? true) cap(a, d.scale(-1));
  if (o.capEnd ?? false) cap(b, d);
}

/**
 * The block over a roof corner where a hip strap starts: a square pad lying
 * on both roof faces (folded along the hip), with its two outer edges turned
 * down over the roof's lip. Built flat in corner coordinates — (u, w) =
 * meters in from the two eaves — and sheared onto the roof, so every face
 * that does not cross the hip stays planar.
 */
function hipStarter(m: SolidMesh, sx: number, sz: number, p: Paint): void {
  const a = W / 2 + OVERHANG;
  const slope = (APEX - SPRING) / a;
  // A thin plate (the sheet's corner pads are ~0.2 m tall in elevation).
  const L = 0.38;
  const e = 0.02;
  const t = 0.06;
  const c = 0.025;
  const drop = -0.06;
  const at = (u: number, w: number, h: number): Vector3 => V(sx * (a - u), SPRING + Math.min(u, w) * slope + h, sz * (a - w));
  const centre = at(L / 2, L / 2, 0);
  const face = (q: Vector3[], lift: number): void => {
    const mid = q.reduce((s, x) => s.add(x), V(0, 0, 0)).scale(1 / q.length);
    const dir = mid.subtract(centre);
    dir.y = lift;
    if (q.length === 3) polygonFacing(m, q, dir, p);
    else quadFacing(m, q[0], q[1], q[2], q[3], dir, p);
  };
  // Outline, chamfer foot and top rings: corner, along the z-eave, hip, along the x-eave.
  const outline: Vec2[] = [[-e, -e], [L, -e], [L, L], [-e, L]];
  const inset: Vec2[] = [[-e + c, -e + c], [L - c, -e + c], [L - c, L - c], [-e + c, L - c]];
  const top = inset.map(([u, w]) => at(u, w, t));
  // Split along the hip, or the top would bridge the fold.
  face([top[0], top[1], top[2]], 1);
  face([top[0], top[2], top[3]], 1);
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    const foot = [at(outline[k][0], outline[k][1], t - c), at(outline[j][0], outline[j][1], t - c)];
    // All four walls reach the underside: the outer two hang down over the
    // roof's lip, the inner two run on down inside the roof slab (stopping
    // them at the roof surface leaves a slot where they overhang the eave).
    const base = [at(outline[k][0], outline[k][1], drop), at(outline[j][0], outline[j][1], drop)];
    face([foot[0], foot[1], top[j], top[k]], 0.5);
    face([base[0], base[1], foot[1], foot[0]], 0);
  }
  // Closed underneath where it overhangs the roof corner.
  face([at(-e, -e, drop), at(L, -e, drop), at(L, L, drop), at(-e, L, drop)], -5);
  const rivet = at(0.17, 0.17, t - 0.012);
  sphere(m, { radii: [0.055, 0.038, 0.055], segments: 8, rings: 3, latitude: [0, 90], at: [rivet.x, rivet.y, rivet.z] }, p);
}

/** Roof furniture the sheet draws on the hip roof: a strap up every hip, a
 * square starter block with a rivet over each corner, the apex cap. */
function roofTrim(m: SolidMesh, P: BuildingPaints): void {
  const a = W / 2 + OVERHANG;
  const rise = APEX - SPRING;
  const apex = V(0, APEX, 0);
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const corner = V(sx * a, SPRING, sz * a);
      const nz = V(0, a, sz * rise).normalize();
      const nx = V(sx * rise, a, 0).normalize();
      const d = apex.subtract(corner).normalize();
      const L = Vector3.Distance(corner, apex);
      const s0 = 0.4;
      const s1 = L - 0.25;
      hipCover(m, corner.add(d.scale(s0)), corner.add(d.scale(s1)), nz, nx, { width: 0.3, thick: 0.05, chamfer: 0.02, segments: 3, capStart: false }, P.roofAlt);
      hipStarter(m, sx, sz, P.roofAlt);
      // Two dome rivets on the strap's crown, as the sheet draws them.
      const lift = nz.add(nx).normalize();
      for (const f of [0.25, 0.75]) {
        const q = corner.add(d.scale(s0 + (s1 - s0) * f)).add(lift.scale(0.05 / Vector3.Dot(lift, nz) - 0.012));
        const r = m.mark();
        sphere(m, { radii: [0.052, 0.036, 0.052], segments: 8, rings: 2, latitude: [0, 90] }, P.roofAlt);
        m.transform(aim(q, q.add(lift)), r);
      }
    }
  }
  // Apex cap: a low octagonal block with its flats square to the faces and
  // hips. Its foot is sunk below the roof at the middle of a flat, where the
  // roof has fallen furthest.
  const capR = 0.5;
  const foot = APEX - (capR * rise) / a - 0.02;
  frustum(
    m,
    { radiusBottom: capR, radiusTop: capR - 0.06, height: ROOF_TOP - foot, sides: 8, round: false, bevel: { top: 0.08 }, rot: [0, 22.5, 0], at: [0, (ROOF_TOP + foot) / 2, 0] },
    P.roofAlt,
  );
}

/**
 * The front stair as the sheet draws it: two chunky cream stringers standing
 * proud of four timber treads. Stringers are cut level with the deck at the
 * top and plumb at the toe; they reach 10 cm underground.
 */
function stair(m: SolidMesh, P: BuildingPaints): void {
  const slope = FLOOR / STAIR_RUN;
  const lift = 0.12;
  const depth = 0.36;
  // Side view, s = distance out from the deck edge. Top line of the stringer:
  const top = (s: number): number => FLOOR + lift - s * slope;
  const level = FLOOR + 0.006;
  const toe = STAIR_RUN - 0.02;
  const pts: Vec2[] = [
    [-0.08, level],
    [(FLOOR + lift - level) / slope, level],
    [toe, top(toe)],
    [toe, -0.1],
    [(FLOOR + lift - depth + 0.1) / slope, -0.1],
    [-0.08, top(-0.08) - depth],
  ];
  // Seen from +x the viewer's right is +z: outline x = model z.
  const outline = pts.map(([s, y]): Vec2 => [DECK_FRONT - s, y]);
  for (const sx of [1, -1]) {
    extrudePolygon(m, { outline, depth: STRINGER, centered: true, bevel: 0.03, bevelBack: true, facing: '+x', at: [sx * (STAIR_HALF + STRINGER / 2), 0, 0] }, soften(P.trim, 45));
  }
  const riser = FLOOR / STAIR_STEPS;
  const going = STAIR_RUN / STAIR_STEPS;
  // Step k: tread top at `stepY(k)`, nosing line at `nose(k)` (k = 0 is the deck).
  const stepY = (k: number): number => FLOOR - k * riser;
  const nose = (k: number): number => DECK_FRONT - k * going;
  // Each tread runs from 1.5 cm past its nosing back to 6 cm UNDER the step
  // above, so the riser board above lands on it and no slot opens between
  // the two when the elevated camera looks down the flight.
  for (let k = 1; k < STAIR_STEPS; k++) {
    const front = nose(k) - 0.015;
    const back = nose(k - 1) + 0.06;
    const z = (front + back) / 2;
    const y = stepY(k) - 0.045;
    beam(m, { from: [-STAIR_HALF - 0.03, y, z], to: [STAIR_HALF + 0.03, y, z], size: [back - front, 0.09], side: [0, 1, 0], caps: false, chamfer: 0.02 }, P.timber);
  }
  // Riser boards set 2 cm back under each nosing: top buried in the tread (or
  // the deck) above, foot buried in the tread below, ends in the stringers —
  // so only the front and back faces are emitted. The deck's own edge is the
  // first riser; its board only closes the strip under the deck's chamfer.
  for (let k = 0; k < STAIR_STEPS; k++) {
    const z0 = nose(k) + 0.005;
    // (k = 0: clear of the deck's 5 cm bottom chamfer, or the open top shows.)
    const yTop = k === 0 ? DECK_BOTTOM + 0.07 : stepY(k) - 0.02;
    const yBottom = k === STAIR_STEPS - 1 ? -0.1 : stepY(k + 1) - 0.04;
    box(m, { min: [-STAIR_HALF - 0.03, yBottom, z0], max: [STAIR_HALF + 0.03, yTop, z0 + 0.04], faces: { px: null, nx: null, py: null, ny: k === STAIR_STEPS - 1 ? P.timberDark : null } }, P.timberDark);
  }
}

/**
 * The veranda railing either side of the stair: a capped post at the corner
 * and one at the stair, two chunky cream boards returning into the corner
 * post. Own part: the kit's 'boards' railing has 5 × 15 cm planks, the
 * sheet's boards are toy-chunky (~7 × 17 cm, rounded edges).
 */
function verandaRail(m: SolidMesh, sx: number, P: BuildingPaints, capPaint: Paint): void {
  const corner: Vec2 = [sx * RAIL_X, RAIL_Z];
  const stairEnd: Vec2 = [sx * (STAIR_HALF + STRINGER / 2), RAIL_Z];
  const wallEnd: Vec2 = [sx * RAIL_X, -D / 2 - 0.04];
  const top = FLOOR + RAIL_H + 0.02;
  for (const [x, z] of [corner, stairEnd]) {
    beam(m, { from: [x, FLOOR - 0.04, z], to: [x, top, z], size: 0.2, side: [0, 0, 1], caps: false }, P.timber);
    beam(m, { from: [x, top - 0.03, z], to: [x, top + 0.08, z], size: 0.27, chamfer: 0.03, side: [0, 0, 1] }, capPaint);
  }
  for (const f of [0.42, 0.78]) {
    const y = FLOOR + RAIL_H * f;
    for (const [a, b] of [[wallEnd, corner], [corner, stairEnd]] as const) {
      beam(m, { from: [a[0], y, a[1]], to: [b[0], y, b[1]], size: [0.07, 0.17], chamfer: 0.025, side: [0, 1, 0], caps: false }, P.trim);
    }
  }
}

/** A satin mid-grey knob on a round rose (the sheet's is ~0.13 m across;
 * the kit's oversized chrome knob reads as a hubcap on this small door). */
function doorKnob(m: SolidMesh, on: Parameters<typeof toFacade>[2], side: 1 | -1): void {
  const s = m.mark();
  const knob = paint(BUILDING.roofMetal, { color: shade(BUILDING.roofMetal, 0.82), gloss: 0.5, metal: 0.6 });
  const x = DOOR.u + side * (DOOR.w / 2 - 0.17);
  const y = DOOR.v + DOOR.h * 0.46;
  const zf = -0.1;
  frustum(m, { from: [x, y, zf - 0.01], to: [x, y, zf + 0.018], radiusBottom: 0.075, radiusTop: 0.064, sides: 12, caps: 'top' }, knob);
  cylinder(m, { from: [x, y, zf + 0.01], to: [x, y, zf + 0.05], radius: 0.026, sides: 8, caps: false }, knob);
  sphere(m, { radius: 0.06, segments: 12, rings: 6, at: [x, y, zf + 0.085] }, knob);
  toFacade(m, s, on);
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'warm');
  // 'warm' seed 0 is the sheet: teal roof with coral hips, coral door. Other
  // 'warm' seeds wear the style guide's own coral roof, with teal straps, so a
  // village of huts gets two rooflines; 'sunny' (teal roof) takes cream
  // straps, or it would differ from the sheet in wall colour alone.
  const sheet =
    base.scheme === 'warm'
      ? seed === 0
        ? withPaints(base, { roof: BUILDING.turquoise, roofAlt: BUILDING.coral, door: BUILDING.coral })
        : withPaints(base, { roofAlt: BUILDING.turquoise })
      : base.scheme === 'sunny'
        ? withPaints(base, { roofAlt: BUILDING.cream })
        : base;
  const varied = variantPaints(sheet, v);
  // Door colours of seeds 0 / 1 / 2 (the kit's own cycle puts a timber door
  // between timber posts on seed 1).
  const doors = DOOR_COLOURS[sheet.scheme];
  const P = withPaints(varied, { door: doors[Math.abs(Math.round(seed)) % doors.length] });
  const m = new SolidMesh();

  // a. Roof: a thin teal slab whose lip shows above the fascia, then the trim.
  hipRoof(
    m,
    { width: W, depth: D, eave: SPRING - 0.07, rise: APEX - (SPRING - 0.07), overhang: OVERHANG, thickness: 0.1, ridgeLength: 0, seamPitch: 1.19, hipCaps: false, finial: false, soffit: P.trim },
    P,
  );
  roofTrim(m, P);
  fascia(m, { half: W / 2 + 0.15, cut: 0.1, block: 0.45, y: (FASCIA_BOTTOM + FASCIA_TOP) / 2, height: FASCIA_TOP - FASCIA_BOTTOM, thick: 0.36 }, P.trim);

  // b. Deck, stilts on their footings, braces.
  deck(m, P);
  const footPaint = c.footing === 'stone' ? P.stone : P.trim;
  for (const [x, z] of STILTS) {
    beam(m, { from: [x, FOOTING[1] - 0.04, z], to: [x, DECK_BOTTOM + 0.04, z], size: STILT, side: [0, 0, 1], caps: false, segments: 1 }, P.timber);
    stoneBlock(m, { at: [x, z], size: FOOTING }, footPaint);
  }
  const brace = (x: number, z: number, ax: number, az: number): void =>
    kneeBrace(m, { at: [x + (ax * STILT) / 2, DECK_BOTTOM, z + (az * STILT) / 2], along: [ax, 0, az], reach: BRACE_REACH, size: BRACE_SIZE }, P.timber);
  // Across the back and the veranda front (seen from the road) …
  for (const z of [1.7, DECK_FRONT + 0.22]) {
    brace(-1.7, z, 1, 0);
    brace(1.7, z, -1, 0);
  }
  brace(0, 1.7, 1, 0);
  brace(0, 1.7, -1, 0);
  // … and along both sides, the veranda stilts braced back toward the house.
  for (const x of [-1.7, 1.7]) {
    brace(x, 1.7, 0, -1);
    brace(x, -1.7, 0, 1);
    brace(x, DECK_FRONT + 0.22, 0, 1);
  }

  // c. Walls.
  // Front windows centred between the door surround (0.61) and the post's
  // inner face (1.78): ~0.15 m of wall on both sides, as on the sheet.
  const frontWin = (side: 1 | -1): Opening => ({ u: side * 1.195, v: 1.96, w: c.winW, h: 0.86 });
  const sideWin: Opening = { u: 0, v: 1.78, w: 0.95, h: 1.04 };
  const F = wallBox(
    m,
    {
      width: W,
      depth: D,
      bottom: WALL_BOTTOM,
      top: WALL_TOP,
      openings: { front: [DOOR, frontWin(-1), frontWin(1)], left: [sideWin], right: [sideWin], back: [sideWin] },
      boards: { direction: 'horizontal', pitch: BOARD_PITCH },
    },
    P.wall,
  );

  // d. Timber corner posts with a capital under the fascia. The capital is a
  // crisp chamfered block of our own: the kit's rounded cap smooths its one
  // chamfer step into the faces and reads as a pillow in close-up.
  const postTop = FASCIA_BOTTOM + 0.14;
  cornerPosts(m, { width: W, depth: D, bottom: FLOOR - 0.06, top: postTop, size: POST, proud: POST_PROUD }, P.timber);
  const postAt = W / 2 - POST / 2 + POST_PROUD;
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      beam(m, { from: [sx * postAt, FASCIA_BOTTOM - 0.17, sz * postAt], to: [sx * postAt, postTop + 0.02, sz * postAt], size: POST + 0.07, chamfer: 0.035, side: [0, 0, 1], caps: 'start', segments: 1 }, P.timber);
    }
  }

  // f. Openings.
  door(m, { on: F.front, opening: DOOR, planks: 3, surround: 0.11, handle: 'none' }, P);
  doorKnob(m, F.front, c.knobSide);
  for (const side of [1, -1] as const) windowUnit(m, { on: F.front, opening: frontWin(side), surround: 0.1, surroundPaint: P.frame, lit: c.lit && side > 0 }, P);
  for (const on of [F.left, F.right]) windowUnit(m, { on, opening: sideWin, surround: 0.1, surroundPaint: P.frame, shutters: c.sideShutters }, P);
  windowUnit(m, { on: F.back, opening: sideWin, surround: 0.1, surroundPaint: P.frame }, P);

  // g. Veranda railing either side of the stair, returning to the corner posts.
  const capPaint = paint(P.timber, { color: mixOklab(P.timber.color, BUILDING.cream, 0.4) });
  for (const sx of [1, -1]) verandaRail(m, sx, P, capPaint);
  stair(m, P);
  if (c.lantern) wallLantern(m, { on: F.front, u: c.lantern * postAt, v: 2.72, reach: 0.36, proud: 0.06 }, P);
  if (c.solar) {
    const z = 1.25;
    const y = SPRING + ((APEX - SPRING) * (W / 2 + OVERHANG - z)) / (W / 2 + OVERHANG);
    const pitch = (Math.atan((APEX - SPRING) / (W / 2 + OVERHANG)) * 180) / Math.PI;
    // Narrower than S01 so it lies between the two middle seams (±0.6 m).
    solarPanel(m, { at: [0, y, z], size: [1.08, 0.76], rot: [pitch, 0, 0] }, P);
  }

  // h. Dressing.
  if (c.veranda === 'planter') planter(m, { at: [1.5, -D / 2 - 0.4], base: FLOOR, seed: seed * 5 + 1 }, P);
  if (c.veranda === 'crate') crate(m, { at: [-1.45, -D / 2 - 0.4], base: FLOOR, size: [0.6, 0.42, 0.46], rotY: 6, produce: P.accent, seed }, P);
  if (c.barrelSide) barrel(m, { at: [c.barrelSide * 1.35, DECK_FRONT - 0.45], planted: true, seed: seed * 3 }, P);
  return finishBuilding(m);
}

/**
 * The deck: one chamfered timber slab under the body and the veranda, closed
 * below (a jumping car sees the underside), with two board joints across the
 * veranda floor in the wall boards' language.
 */
function deck(m: SolidMesh, P: BuildingPaints): void {
  const start = m.mark();
  const c = 0.05;
  const sp = soften(P.timber, 45);
  const ring = (y: number, inset: number): Vector3[] => [
    V(-DECK_X + inset, y, DECK_FRONT + inset),
    V(DECK_X - inset, y, DECK_FRONT + inset),
    V(DECK_X - inset, y, DECK_BACK - inset),
    V(-DECK_X + inset, y, DECK_BACK - inset),
  ];
  // Bottom face, bottom chamfer, edge, top chamfer, top face.
  const levels: readonly (readonly [number, number])[] = [[DECK_BOTTOM, c], [DECK_BOTTOM + c, 0], [FLOOR - c, 0], [FLOOR, c]];
  const out = [V(0, 0, -1), V(1, 0, 0), V(0, 0, 1), V(-1, 0, 0)];
  for (let k = 0; k + 1 < levels.length; k++) {
    const A = ring(levels[k][0], levels[k][1]);
    const B = ring(levels[k + 1][0], levels[k + 1][1]);
    const tilt = k === 0 ? -1 : k === 2 ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quadFacing(m, A[i], A[j], B[j], B[i], out[i].add(V(0, tilt, 0)), sp);
    }
  }
  polygonFacing(m, ring(DECK_BOTTOM, c), V(0, -1, 0), sp);
  polygonFacing(m, ring(FLOOR, c), V(0, 1, 0), sp);
  // Rows across the slab: its corners alone would bake the whole underside
  // and the veranda floor from four contact guesses.
  m.tessellate(1.6, start);
  const joint = paint(P.timber, { color: shade(P.timber.color, 0.8) });
  for (const f of [1 / 3, 2 / 3]) {
    const z = -D / 2 - VERANDA * f;
    rib(m, [-DECK_X + 0.07, FLOOR, z], [DECK_X - 0.07, FLOOR, z], [0, 1, 0], { width: 0.04, topWidth: 0.022, height: 0.012, capStart: true, capEnd: true, breakAt: DECK_X }, joint);
  }
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const a = W / 2 + OVERHANG;
  const roofAt = (inset: number): number => SPRING + ((APEX - SPRING) * inset) / a;
  // Roof as stacked boxes, each topping out at the slope's height 0.4 m
  // inside its own edge (see the cottage).
  const roofStep = (half: number, bottom: number): ColliderSpec => {
    const top = roofAt(a - half + 0.4);
    return { shape: 'box', center: [0, (bottom + top) / 2, 0], half: [half, (top - bottom) / 2, half] };
  };
  const out: ColliderSpec[] = [
    // Body down to the ground: the 1.4 m gaps between the stilts under a
    // 0.7 m deck are no passage for a 2 m buggy.
    { shape: 'box', center: [0, FASCIA_BOTTOM / 2, (DECK_BACK - D / 2) / 2], half: [DECK_X, FASCIA_BOTTOM / 2, (DECK_BACK + D / 2) / 2] },
    // Veranda with its railing.
    { shape: 'box', center: [0, (FLOOR + RAIL_H) / 2, (DECK_FRONT - D / 2) / 2], half: [DECK_X, (FLOOR + RAIL_H) / 2, VERANDA / 2] },
    roofStep(a + 0.02, FASCIA_BOTTOM),
    roofStep(1.6, roofAt(0.4)),
    roofStep(0.8, roofAt(1.18)),
    // Stair, as two steps.
    { shape: 'box', center: [0, FLOOR / 4, DECK_FRONT - STAIR_RUN * 0.75], half: [STAIR_HALF + STRINGER, FLOOR / 4, STAIR_RUN / 4] },
    { shape: 'box', center: [0, FLOOR / 2, DECK_FRONT - STAIR_RUN * 0.25], half: [STAIR_HALF + STRINGER, FLOOR / 2, STAIR_RUN / 4] },
  ];
  if (c.barrelSide) out.push({ shape: 'cylinder', base: [c.barrelSide * 1.35, 0, DECK_FRONT - 0.45], height: 0.75, radius: 0.34 });
  return out;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b03-stilt-hut',
  name: 'B03 Stilt Hut',
  category: 'building',
  size: { x: 4.8, y: 4.6, z: 6.8 },
  variants: 3,
  schemes: ['warm', 'coastal', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/shacks/design-sheet.png',
    brief: 'design-documents/building-design-pack/shacks/b03-stilt-hut-brief.txt',
  },
  build,
  colliders,
};

export default asset;
