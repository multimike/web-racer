import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, aim, box, cylinder, darken, extrudePolygon, frustum, lighten, mix, paint, polygonFacing, quadFacing, revolve, roundedBox, roundedRectRing, soften, sphere, tube } from '../../gfx/solid';
import type { Paint, Rng } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { barrel, beam, chamferRing, crate, finishBuilding, rib, schemePaints, toFacade, variantPaints, variation, withPaints } from './parts';
import type { BuildingPaints } from './parts';

/**
 * B09 — Water Tower. Sheet colours: CORAL tank, TEAL octagonal cap, teal
 * ladder, cream bands / deck / rails, timber trestle on lavender stone
 * footings. Those are the WARM scheme's three colours with wall and roof
 * swapped, so the hero scheme 'warm' overrides its wall (→ coral) and roof
 * (→ turquoise); 'coastal' (turquoise tank, cobalt cap) and 'sunny' (mustard
 * tank, teal cap) are the style guide's own.
 *
 * MAIN BODY 4.4 × 4.4 m deck on a trestle whose feet stand on a 3.44 m
 * square, 8.0 m tall. Heights are the brief's: maintenance deck 4.4 m, tank
 * 4.7 – 6.9 m with a 3.4 m diameter, cap top 8.0 m. OVERALL 4.85 × 8.0 ×
 * 4.83 m (the splayed stone footings, the pipe mouth at x 2.49 and the
 * ladder foot) — inside the brief's 5 × 5 m placement envelope, which is
 * also what limits the pipe's reach.
 *
 * THE BRIEF WINS OVER THE SHEET'S PROPORTIONS. The sheet draws a squat tower
 * (about 5 m at this footprint) with a tank only 60 % as wide as the deck;
 * the brief asks for "the proposed height if a tall landmark is desired" and
 * a 3.4 m tank. Both are kept, so the legs are twice as long as drawn and
 * the walkway round the tank is narrow (0.5 m at the middle of a side,
 * roomy at the corners). The deck is SQUARE (4.4 m, lightly chamfered
 * corners, big cream corner blocks) as in the sheet's top view. The trestle
 * keeps the sheet's A-frame stance: leg heads at ±1.28 m, feet splayed to
 * ±1.72 m (about 7°; the sheet's 14° at half the height would push the feet
 * out of the envelope), legs 0.68 m square.
 *
 * LAYOUT (brief): ONE ladder, at the rear (+z), with a gate in the railing
 * where it lands; the discharge pipe on the right (+x); X braces on all four
 * sides, the rear pair behind the ladder. A flat facet of the cap and the
 * middle of a tank panel face the front.
 *
 * OWN PARTS (nothing like them in the shared kit): faceted footing blocks,
 * the stave tank with real V-joints, hoop / eave rings, the octagonal cap
 * with hip ribs and finial, riveting, elbow pipe, round-bar ladder, the
 * slab-post railing and a bulkhead lamp with a closed back (the kit's
 * `wallLamp` is open behind — fine on a wall, not on a rail).
 *
 * Seeds: 0 = the sheet (one hoop, lamps front and left). 1 = two hoops, a
 * pennant on the finial, one front lamp, a crate between the front feet. 2 = bare-metal ladder, lamps front and left, a barrel planter on the
 * right beside the trestle.
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const RAD = Math.PI / 180;

const TOP = 8.0;
const DECK = 4.4;
const DECK_T = 0.36;
const DECK_HALF = 2.2;
const TANK_R = 1.7;
const TANK_BASE = 4.7;
const TANK_TOP = 6.9;
/** Cream eave ring round the tank top: underside, top, outer radius (an
 * octagon: this is the corner radius, its flats stand at 1.89 m). */
const EAVE_Y0 = 6.6;
const EAVE_Y1 = 6.93;
const EAVE_R = 2.05;
/** Trestle: leg centres at the foot (on the pad) and under the deck. */
const LEG = 0.68;
const LEG_Y0 = 0.52;
const LEG_Y1 = 3.92;
const LEG_FOOT = 1.72;
const LEG_HEAD = 1.28;
const legHalf = (y: number): number => LEG_FOOT + ((LEG_HEAD - LEG_FOOT) * (y - LEG_Y0)) / (LEG_Y1 - LEG_Y0);
/** Railing: post-centre line, heights above the deck. */
const RAIL_LINE = 1.95;
/** Railing posts between the corner blocks, at ±POST_U along every side; on
 * the rear side the span between them is the ladder gate. */
const POST_U = 0.62;
const CORNER_POST = 0.68;
/** Deck plan-corner chamfer: small, so the corner blocks sit wholly on the deck. */
const DECK_C = 0.15;
const POST_H = 0.82;
const RAIL_HI = 0.56;
const RAIL_LO = 0.24;
/** Discharge pipe: axis height at the tank, plan position of the down leg. */
const PIPE_Y = 5.62;
const PIPE_R = 0.2;
const PIPE_X = 2.24;
/** Ladder: half width between rail centres, plan z of the foot and at the deck edge. */
const LADDER_HALF = 0.34;
const LADDER_FOOT_Z = 2.41;
const LADDER_DECK_Z = DECK_HALF + 0.035;

function choices(seed: number) {
  const v = variation(seed, 'b09');
  return {
    v,
    hoops: v.cycle([1, 2, 1] as const),
    pennant: v.cycle([false, true, false] as const),
    // Rail lamps as [side, u]: side is a turn from the front (0 = front, 90 =
    // left), u along that side's rail. Only the middle spans are wide enough
    // for the lamp; the right one is under the pipe and the rear one is the gate.
    lamps: v.cycle([[[0, 0], [90, 0]], [[0, 0]], [[0, 0], [90, 0]]] as const),
    barrel: v.cycle([null, null, [1.98, 0.42]] as const),
    crate: v.cycle([null, [0.35, -1.7], null] as const),
  };
}

// ---------------------------------------------------------------------------
// Own parts

/**
 * Sawn timber made of two planks: the kit's `beam` section (a bar with
 * chamfered edges) with a V-joint down the middle of the chosen faces — the
 * line the sheet draws along every leg and brace. Faces: 0 = +x, 1 = +side,
 * 2 = −x, 3 = −side of the section. Ends are open (always buried here).
 */
function plankBeam(m: SolidMesh, o: { from: Vector3; to: Vector3; size: readonly [number, number]; chamfer: number; side: Vector3; segments: number; joints: readonly number[] }, p: Paint, jointPaint: Paint): void {
  const start = m.mark();
  const L = Vector3.Distance(o.from, o.to);
  const hw = o.size[0] / 2;
  const hd = o.size[1] / 2;
  const c = o.chamfer;
  const gw = 0.024;
  const gd = 0.026;
  // Section corners, counter-clockwise from the +x face; each entry is one
  // flat face followed by the chamfer to the next.
  const corners: [number, number][] = [[hw, -hd + c], [hw, hd - c], [hw - c, hd], [-hw + c, hd], [-hw, hd - c], [-hw, -hd + c], [-hw + c, -hd], [hw - c, -hd]];
  const ring: { x: number; z: number; joint: boolean }[] = [];
  for (let f = 0; f < 4; f++) {
    const [ax, az] = corners[f * 2];
    const [bx, bz] = corners[f * 2 + 1];
    ring.push({ x: ax, z: az, joint: false });
    if (o.joints.includes(f)) {
      const len = Math.hypot(bx - ax, bz - az);
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      // Inward normal of a counter-clockwise outline: the tangent turned left.
      const nx = -tz;
      const nz = tx;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      ring.push({ x: mx - tx * gw, z: mz - tz * gw, joint: true }, { x: mx + nx * gd, z: mz + nz * gd, joint: true }, { x: mx + tx * gw, z: mz + tz * gw, joint: false });
    }
    ring.push({ x: bx, z: bz, joint: false });
  }
  const n = ring.length;
  for (let k = 0; k < o.segments; k++) {
    const y0 = (L * k) / o.segments;
    const y1 = (L * (k + 1)) / o.segments;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (Math.hypot(a.x - b.x, a.z - b.z) < 1e-9) continue;
      // Out of the section: the edge direction turned right.
      const dir = V(b.z - a.z, 0, -(b.x - a.x));
      quadFacing(m, V(a.x, y0, a.z), V(b.x, y0, b.z), V(b.x, y1, b.z), V(a.x, y1, a.z), dir, a.joint ? jointPaint : p);
    }
  }
  m.transform(aim(o.from, o.to, false, o.side), start);
}

/** One chunky cut-stone footing: an eight-sided block that widens to a belt
 * line and tapers to a flat top, every corner nudged so no two are alike. */
function footing(m: SolidMesh, cx: number, cz: number, r: Rng, P: BuildingPaints): void {
  const start = m.mark();
  const half = 0.58 + r.range(-0.015, 0.015);
  const rows: [number, number, number][] = [
    // y, half size, corner chamfer
    [-0.1, half, 0.13],
    [0.22 + r.range(-0.03, 0.04), half + 0.025, 0.17],
    [0.47, half - 0.12, 0.12],
  ];
  const rings = rows.map(([y, h, c], k) =>
    chamferRing(2 * h, 2 * h, c).map(([x, z]) => V(x + (k === 1 ? r.range(-0.025, 0.025) : 0), y + (k === 1 ? r.range(-0.03, 0.03) : 0), z + (k === 1 ? r.range(-0.025, 0.025) : 0))),
  );
  // Crisp facets: the sheet's footings are cut blocks, not pebbles.
  const tone = (p: Paint): Paint => paint(p, { smooth: 18 });
  const side = tone(P.stone);
  const lit = tone(P.stoneLight);
  const dark = tone(paint(P.stone, { color: darken(P.stone.color, 0.1) }));
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const a = rings[k][i];
      const b = rings[k][j];
      const out = V(a.x + b.x, k === 1 ? 0.6 : 0, a.z + b.z);
      // Upper facets catch the light; the odd lower one is a darker stone face.
      quadFacing(m, a, b, rings[k + 1][j], rings[k + 1][i], out, k === 1 ? (i % 2 ? lit : side) : r.chance(0.3) ? dark : side);
    }
  }
  polygonFacing(m, rings[2], V(0, 1, 0), lit);
  // Closed underneath too: a car jumping past sees the bottom.
  polygonFacing(m, rings[0], V(0, -1, 0), side);
  m.rotate('y', r.range(-7, 7), start);
  m.translate([cx, 0, cz], start);
}

/**
 * The tank: eight coral staves round a cylinder, meeting in V-joints at
 * 22.5° + k·45° (under the cap's hips). One welded shell, so the panels
 * shade round and only the joints crease; rows of vertices carry the contact
 * shadows of the hoop, the eave ring and the base.
 */
function tankShell(m: SolidMesh, rows: readonly number[], shell: Paint, joint: Paint): void {
  const ARC = 4;
  const jointHalf = 0.032 / TANK_R; // radians
  const jointDepth = 0.04;
  const at = (deg: number, radius: number, y: number): Vector3 => V(Math.cos(deg * RAD) * radius, y, Math.sin(deg * RAD) * radius);
  const p = soften(shell, 45 / ARC);
  for (let k = 0; k < 8; k++) {
    const a0 = 22.5 + 45 * k + jointHalf / RAD;
    const a1 = 22.5 + 45 * (k + 1) - jointHalf / RAD;
    const seam = 22.5 + 45 * (k + 1);
    const next = seam + jointHalf / RAD;
    for (let j = 0; j + 1 < rows.length; j++) {
      const y0 = rows[j];
      const y1 = rows[j + 1];
      for (let i = 0; i < ARC; i++) {
        const b0 = a0 + ((a1 - a0) * i) / ARC;
        const b1 = a0 + ((a1 - a0) * (i + 1)) / ARC;
        const mid = (b0 + b1) / 2;
        quadFacing(m, at(b0, TANK_R, y0), at(b1, TANK_R, y0), at(b1, TANK_R, y1), at(b0, TANK_R, y1), at(mid, 1, 0), p);
      }
      const g0 = at(seam, TANK_R - jointDepth, y0);
      const g1 = at(seam, TANK_R - jointDepth, y1);
      quadFacing(m, at(a1, TANK_R, y0), g0, g1, at(a1, TANK_R, y1), at(seam + 60, 1, 0), joint);
      quadFacing(m, g0, at(next, TANK_R, y0), at(next, TANK_R, y1), g1, at(seam - 60, 1, 0), joint);
    }
  }
}

/** The octagonal cap: eight flat facets from the eave to a small apex ring
 * (buried in the finial), a thin lip standing on the eave ring, and a rib
 * down every hip. Flats face ±x / ±z; corners at 22.5° + k·45°. */
function cap(m: SolidMesh, o: { eaveR: number; lipY0: number; lipY1: number; apexR: number; apexY: number }, roof: Paint, ribPaint: Paint): void {
  // 17° between neighbouring facets: keep them crisp.
  const flat = paint(roof, { smooth: 8 });
  const at = (deg: number, radius: number, y: number): Vector3 => V(Math.cos(deg * RAD) * radius, y, Math.sin(deg * RAD) * radius);
  const midR = (o.eaveR + o.apexR) / 2;
  const midY = (o.lipY1 + o.apexY) / 2;
  for (let k = 0; k < 8; k++) {
    const a0 = 22.5 + 45 * k;
    const a1 = a0 + 45;
    const out = at(a0 + 22.5, 1, 1);
    quadFacing(m, at(a0, o.eaveR, o.lipY0), at(a1, o.eaveR, o.lipY0), at(a1, o.eaveR, o.lipY1), at(a0, o.eaveR, o.lipY1), at(a0 + 22.5, 1, 0), flat);
    quadFacing(m, at(a0, o.eaveR, o.lipY1), at(a1, o.eaveR, o.lipY1), at(a1, midR, midY), at(a0, midR, midY), out, flat);
    quadFacing(m, at(a0, midR, midY), at(a1, midR, midY), at(a1, o.apexR, o.apexY), at(a0, o.apexR, o.apexY), out, flat);
    // Hip rib, standing square to the hip line.
    const top = at(a0, o.apexR, o.apexY);
    // The rib stops 6 cm short of the lip and ends in a plain sloped face.
    const eave = at(a0, o.eaveR, o.lipY1 - 0.008);
    const along = eave.subtract(top).normalize();
    const foot = eave.subtract(along.scale(0.06));
    const up = V(0, 1, 0);
    const normal = up.subtract(along.scale(Vector3.Dot(up, along))).normalize();
    rib(m, top, foot, normal, { width: 0.15, topWidth: 0.09, height: 0.075, sink: 0.025, breakAt: 0.35 }, ribPaint);
  }
}

/**
 * Plan ring of the deck, 20 points: a square of half size `r` with its
 * corners chamfered by `c`, five points per side (both chamfer ends, the
 * quarters and the middle). `radius` instead puts the same 20 directions on
 * a circle, so a square edge and the round foot of the tank connect point
 * for point. Side 0 faces −z (the front), then +x, +z, −x.
 */
function deckRing(r: number, c: number, y: number, radius?: number): Vector3[] {
  const out: Vector3[] = [];
  const s = r - c;
  let nx = 0;
  let nz = -1;
  for (let k = 0; k < 4; k++) {
    const tx = -nz;
    const tz = nx;
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const x = nx * r + tx * s * f;
      const z = nz * r + tz * s * f;
      const l = radius === undefined ? 1 : radius / Math.hypot(x, z);
      out.push(V(x * l, y, z * l));
    }
    nx = tx;
    nz = tz;
  }
  return out;
}

/**
 * The maintenance deck: a SQUARE slab with chamfered corners (the sheet's
 * top view — big cream post blocks on four square corners), in two tiers
 * like the sheet: a plate over a slightly smaller fascia. The rings carry
 * vertices in the open on the top (round the tank) and the underside (round
 * the leg heads) for the baked contact shadows; the middle of the top is
 * left open inside the tank's base ring.
 */
function deck(m: SolidMesh, half: number, y0: number, y1: number, p: Paint): void {
  const b = 0.05;
  const inset = 0.11;
  const C = DECK_C;
  const split = y0 + (y1 - y0) * 0.55;
  const ring = (r: number, y: number): Vector3[] => deckRing(r, (C * r) / half, y);
  const strip = (a: Vector3[], c: Vector3[], dir: (mid: Vector3) => Vector3): void => {
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      if (Vector3.Distance(a[i], a[j]) < 1e-6 && Vector3.Distance(c[i], c[j]) < 1e-6) continue;
      quadFacing(m, a[i], a[j], c[j], c[i], dir(a[i].add(a[j])), p);
    }
  };
  const up = (): Vector3 => V(0, 1, 0);
  const down = (): Vector3 => V(0, -1, 0);
  const out = (mid: Vector3): Vector3 => V(mid.x, 0, mid.z);
  const slant = (sy: number) => (mid: Vector3): Vector3 => V(mid.x, sy * Math.hypot(mid.x, mid.z), mid.z);
  // Underside: centre fan, a ring through the leg heads, the fascia's rim.
  const under = [ring(0.6, y0), ring(LEG_HEAD, y0), ring(half - inset - b, y0)];
  const n = under[0].length;
  for (let i = 0; i < n; i++) m.tri(V(0, y0, 0), under[0][i], under[0][(i + 1) % n], p);
  strip(under[0], under[1], down);
  strip(under[1], under[2], down);
  strip(under[2], ring(half - inset, y0 + b), slant(-1));
  strip(ring(half - inset, y0 + b), ring(half - inset, split), out);
  strip(ring(half - inset, split), ring(half - b * 0.6, split), down);
  strip(ring(half - b * 0.6, split), ring(half, split + b * 0.6), slant(-1));
  strip(ring(half, split + b * 0.6), ring(half, y1 - b), out);
  strip(ring(half, y1 - b), ring(half - b, y1), slant(1));
  // Walkway: a row of vertices half way out, then the tank's foot (under the
  // cream base ring, r 1.84). Inside it the top stays open: the tank, its
  // base ring and the deck's underside close that cavity.
  const foot = deckRing(half, C, y1, 1.8);
  const mid = ring(half - b, y1).map((q, i) => Vector3.Lerp(q, foot[i], 0.5));
  strip(ring(half - b, y1), mid, up);
  strip(mid, foot, up);
}

/** Bulkhead lamp in the family of the kit's `wallLamp` (cream pill casing,
 * glowing pill lens, cage bars), but closed all round: it hangs on a rail,
 * where its back is seen from the deck side. Built on the front rail and
 * turned to its side of the deck (`turn` 90 = the left side). */
/** Warm cream-yellow glow (the style rule: warm, never white or lemon). */
const LENS = paint('#FFCB80', { gloss: 0.5, emissive: 0.75 });

function railLamp(m: SolidMesh, turn: number, u: number, v: number, P: BuildingPaints): void {
  const start = m.mark();
  const w = 0.74;
  const h = 0.44;
  const lw = w - 0.15;
  const lh = h - 0.15;
  // Fat pill casing clamped round both rails; a domed warm lens in front.
  extrudePolygon(m, { outline: roundedRectRing(w, h, h / 2, 3), depth: 0.22, bevel: 0.05, at: [u, v, -0.1] }, soften(P.trim, 50));
  extrudePolygon(m, { outline: roundedRectRing(lw, lh, lh / 2, 3), depth: 0.07, bevel: 0.045, back: false, at: [u, v, 0.08] }, soften(LENS, 60));
  // The sheet's lens is quartered by a cross that stays on the lens.
  box(m, { min: [u - 0.016, v - lh / 2 + 0.03, 0.12], max: [u + 0.016, v + lh / 2 - 0.03, 0.168], faces: { nz: null } }, P.trim);
  box(m, { min: [u - lw / 2 + 0.05, v - 0.015, 0.12], max: [u + lw / 2 - 0.05, v + 0.015, 0.166], faces: { nz: null } }, P.trim);
  toFacade(m, start, { facing: '-z', plane: RAIL_LINE });
  m.rotate('y', turn, start);
}

// ---------------------------------------------------------------------------

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'warm');
  const sheet = base.scheme === 'warm' ? withPaints(base, { wall: BUILDING.coral, roof: BUILDING.turquoise, roofAlt: BUILDING.coral }) : base;
  const P = variantPaints(sheet, v);
  // The tank is painted metal, not plaster.
  const TANK = paint(P.wall, { gloss: 0.42 });
  const JOINT = paint(TANK, { color: darken(TANK.color, 0.28), gloss: 0.25 });
  // The sheet paints ladder and cap the same bright turquoise. Coastal's
  // cobalt cap would make a heavy navy ladder, so it keeps its teal shutters.
  const ladderPaint = sheet.scheme === 'coastal' ? paint(BUILDING.turquoise, { gloss: 0.45 }) : paint(P.roof, { gloss: 0.45 });
  const LADDER = v.cycle([ladderPaint, ladderPaint, P.metal]);
  // The sheet's pipe is a lavender-grey casting, duller than the bright rails.
  const PIPE = paint(mix(BUILDING.stone, BUILDING.roofMetal, 0.3), { gloss: 0.45, metal: 0.45 });
  const BORE = paint(darken(BUILDING.stoneDark, 0.35), { gloss: 0.1 });
  const m = new SolidMesh();

  // --- Trestle -------------------------------------------------------------
  const stones = v.rng('stones');
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      footing(m, sx * LEG_FOOT, sz * LEG_FOOT, stones, P);
      // Cream pad the leg stands on, sunk into the stone.
      // Rounded plan corners keep it inside the footing's chamfered top however the stone is turned.
      roundedBox(m, { min: [sx * LEG_FOOT - 0.38, 0.43, sz * LEG_FOOT - 0.38], max: [sx * LEG_FOOT + 0.38, 0.66, sz * LEG_FOOT + 0.38], radius: 0.08, segments: 1, faces: { ny: null } }, P.trim);
      plankBeam(m, { from: V(sx * LEG_FOOT, LEG_Y0, sz * LEG_FOOT), to: V(sx * LEG_HEAD, LEG_Y1, sz * LEG_HEAD), size: [LEG, LEG], chamfer: 0.065, side: V(0, 0, sz), segments: 2, joints: [0, 1, 2, 3] }, P.timber, P.timberDark);
      // Cream head block between leg and deck.
      roundedBox(m, { min: [sx * LEG_HEAD - 0.43, LEG_Y1 - 0.2, sz * LEG_HEAD - 0.43], max: [sx * LEG_HEAD + 0.43, DECK - DECK_T + 0.04, sz * LEG_HEAD + 0.43], radius: 0.06, segments: 1, faces: { py: null } }, P.trim);
    }
  }
  // Four sides: a tie under the head blocks and an X of flat boards, one
  // board 5 cm outside the legs' centre plane and one 5 cm inside it, so
  // they cross without sharing a face.
  for (let k = 0; k < 4; k++) {
    const s = m.mark();
    const tieY = LEG_Y1 - 0.1;
    const th = legHalf(tieY);
    beam(m, { from: [-th, tieY, -th], to: [th, tieY, -th], size: [0.4, 0.32], side: [0, 0, -1], caps: false, segments: 2 }, P.timber);
    const lo = 0.98;
    const hi = 3.42;
    const l = legHalf(lo);
    const h = legHalf(hi);
    // The side leans in with the legs: offset along its own outward normal.
    const lean = (LEG_FOOT - LEG_HEAD) / (LEG_Y1 - LEG_Y0);
    const n = V(0, lean, -1).normalize();
    for (const dir of [1, -1]) {
      const off = n.scale(dir * 0.06);
      plankBeam(m, { from: V(-dir * l, lo, -l).add(off), to: V(dir * h, hi, -h).add(off), size: [0.48, 0.17], chamfer: 0.04, side: n, segments: 2, joints: [1, 3] }, P.timber, P.timberDark);
    }
    m.rotate('y', k * 90, s);
  }

  // --- Deck ----------------------------------------------------------------
  deck(m, DECK_HALF, DECK - DECK_T, DECK, P.trim);

  // Railing, built one side at a time in the front frame and turned to its
  // side (90 = left, 180 = rear): a big cream corner block, two slab posts,
  // two round rails from post to post; the rear middle span is the gate.
  for (let k = 0; k < 4; k++) {
    const s = m.mark();
    const z = -RAIL_LINE;
    const ch = POST_H + 0.12;
    // Its outer faces stay 6 cm inside the deck edge (its rounded plan corner
    // inside the deck's corner chamfer) and its foot sinks below the edge
    // bevel, so no open bottom shows from below and no face is coplanar.
    const cc = DECK_HALF - 0.06 - CORNER_POST / 2;
    roundedBox(m, { size: [CORNER_POST, ch + 0.06, CORNER_POST], radius: 0.1, segments: 2, faces: { ny: null }, at: [cc, DECK + ch / 2 - 0.05, -cc] }, P.trim);
    // Slab posts with flat tops (a small chamfer, not a pencil point).
    for (const u of [-POST_U, POST_U]) {
      roundedBox(m, { size: [0.36, POST_H + 0.04, 0.3], radius: 0.04, segments: 1, faces: { ny: null }, at: [u, DECK + POST_H / 2 - 0.02, z] }, P.trim);
    }
    const end = cc - CORNER_POST / 2 + 0.04;
    const spans: [number, number, boolean][] = [[-end, -POST_U, false], [-POST_U, POST_U, k === 2], [POST_U, end, false]];
    for (const [u0, u1, gate] of spans) {
      if (gate) {
        // Gate leaf where the ladder lands: two bars and a diagonal in the ladder's colour.
        for (const y of [RAIL_LO, RAIL_HI + 0.03]) beam(m, { from: [u0, DECK + y, z], to: [u1, DECK + y, z], size: [0.11, 0.07], side: [0, 0, -1], caps: false, segments: 1 }, LADDER);
        beam(m, { from: [u0 + 0.1, DECK + RAIL_LO + 0.03, z], to: [u1 - 0.1, DECK + RAIL_HI, z], size: [0.09, 0.05], side: [0, 0, -1], caps: false, segments: 1 }, LADDER);
      } else {
        cylinder(m, { from: [u0, DECK + RAIL_HI, z], to: [u1, DECK + RAIL_HI, z], radius: 0.07, sides: 8, caps: false }, P.metal);
        cylinder(m, { from: [u0, DECK + RAIL_LO, z], to: [u1, DECK + RAIL_LO, z], radius: 0.042, sides: 6, caps: false }, P.metal);
      }
    }
    m.rotate('y', k * 90, s);
  }

  // --- Tank ----------------------------------------------------------------
  // Cream base ring between deck and tank.
  revolve(m, { profile: [[1.84, DECK - 0.04], [1.84, TANK_BASE - 0.08], [1.66, TANK_BASE + 0.03]], segments: 24 }, P.trim);
  tankShell(m, [TANK_BASE - 0.02, 5.55, 6.3, EAVE_Y0 + 0.06], TANK, JOINT);
  const hoop = (y: number, height: number): void => {
    const r = TANK_R + 0.065;
    // Flat top and bottom faces running 4.5 cm inside the shell: they close
    // the stave joints' 4 cm V-grooves where the band crosses them (a sloped
    // underside would show through each groove as a small cream tooth).
    const y0 = y - height / 2;
    const y1 = y + height / 2;
    revolve(m, { profile: [[TANK_R - 0.045, y0], [r - 0.025, y0], [r, y0 + 0.025], [r, y1 - 0.025], [r - 0.025, y1], [TANK_R - 0.045, y1]], segments: 24 }, soften(P.trim, 50));
  };
  const rivetRows = c.hoops === 1 ? [6.42, 5.2] : [6.42, 5.08];
  if (c.hoops === 1) hoop(5.98, 0.26);
  else {
    hoop(6.16, 0.2);
    hoop(5.48, 0.2);
  }
  // Small dull round rivet heads in pairs either side of every joint: a row
  // under the eave and one just above the railing (the sheet's hero).
  const RIVET = paint(mix(BUILDING.roofMetal, BUILDING.stone, 0.35), { gloss: 0.35, metal: 0.4 });
  for (let k = 0; k < 8; k++) {
    const seam = 22.5 + 45 * k;
    for (const y of rivetRows) {
      for (const side of [1, -1]) {
        const a = (seam + side * 5.2) * RAD;
        const dir = V(Math.cos(a), 0, Math.sin(a));
        frustum(m, { from: dir.scale(TANK_R - 0.01).add(V(0, y, 0)), to: dir.scale(TANK_R + 0.035).add(V(0, y, 0)), radiusBottom: 0.05, radiusTop: 0.03, sides: 5, caps: 'top' }, RIVET);
      }
    }
  }
  // Eave ring: a fat cream moulding the cap stands on, OCTAGONAL with flats
  // under the cap's flats (the sheet's top view shows an even cream border
  // round the cap, corners included).
  revolve(
    m,
    { profile: [[TANK_R - 0.12, EAVE_Y0], [EAVE_R - 0.07, EAVE_Y0], [EAVE_R, EAVE_Y0 + 0.07], [EAVE_R, EAVE_Y1 - 0.08], [EAVE_R - 0.07, EAVE_Y1 - 0.01], [TANK_R - 0.1, EAVE_Y1 + 0.01]], segments: 8, arcStart: 22.5, round: false },
    paint(P.trim, { smooth: 30 }),
  );
  // Same octagon, inset so about 14 cm of cream shows all round from above.
  cap(m, { eaveR: EAVE_R - 0.15, lipY0: EAVE_Y1 - 0.05, lipY1: EAVE_Y1 + 0.08, apexR: 0.36, apexY: 7.68 }, P.roof, paint(P.roof, { color: lighten(P.roof.color, 0.08) }));
  // Finial: a smooth domed cream bun.
  revolve(m, { profile: [[0.44, 7.6], [0.48, 7.66], [0.47, 7.75], [0.38, 7.88], [0.21, 7.97], [0, TOP]], segments: 16 }, soften(P.trim, 60));
  void TANK_TOP;

  // --- Discharge pipe (right side) -----------------------------------------
  // The envelope (x ≤ 2.5) caps the reach, so the pipe is slimmer than
  // before to leave a straight run between the flange and a roomy bend.
  cylinder(m, { from: [TANK_R - 0.06, PIPE_Y, 0], to: [TANK_R + 0.1, PIPE_Y, 0], radius: 0.29, sides: 12, caps: 'top', bevel: { top: 0.03 }, bevelSegments: 1 }, PIPE);
  tube(m, { path: [[TANK_R - 0.05, PIPE_Y, 0], [PIPE_X, PIPE_Y, 0], [PIPE_X, PIPE_Y - 0.5, 0]], radius: PIPE_R, sides: 10, fillet: 0.3, filletSegments: 6, caps: false }, PIPE);
  const mouth = PIPE_Y - 0.54;
  // Mouth flange with a 20 cm deep dark bore, so it reads as a hole.
  revolve(
    m,
    { profile: [[0, mouth + 0.2], [0.14, mouth + 0.2], [0.14, mouth], [0.25, mouth], [0.25, mouth + 0.12], [PIPE_R - 0.02, mouth + 0.14]], segments: 12, at: [PIPE_X, 0, 0] },
    (band) => (band < 2 ? BORE : PIPE),
  );

  // --- Ladder (rear) and its lamps -----------------------------------------
  const slope = (LADDER_FOOT_Z - LADDER_DECK_Z) / (DECK - DECK_T / 2 + 0.1);
  const ladderZ = (y: number): number => LADDER_FOOT_Z - (y + 0.1) * slope;
  // Each rail climbs past the deck and hooks over onto it (as on the sheet),
  // coming down between the deck edge and the gate leaf.
  const hookY = DECK + 0.62;
  const hookZ = 2.09;
  for (const sx of [1, -1]) {
    const x = sx * LADDER_HALF;
    const path: [number, number, number][] = [-0.1, 1.5, 3.0, DECK + 0.2].map((y): [number, number, number] => [x, y, ladderZ(y)]);
    path.push([x, hookY, ladderZ(hookY)], [x, hookY, hookZ], [x, DECK - 0.04, hookZ]);
    tube(m, { path, radius: 0.075, sides: 6, fillet: 0.11, filletSegments: 3, caps: true }, LADDER);
  }
  for (let y = 0.45; y < DECK + 0.3; y += 0.44) {
    cylinder(m, { from: [-LADDER_HALF, y, ladderZ(y)], to: [LADDER_HALF, y, ladderZ(y)], radius: 0.058, sides: 6, caps: false }, LADDER);
  }
  for (const [turn, u] of c.lamps) railLamp(m, turn, u, DECK + 0.42, P);

  // --- Seeded dressing -----------------------------------------------------
  if (c.pennant) {
    cylinder(m, { from: [0, TOP - 0.06, 0], to: [0, TOP + 0.85, 0], radius: 0.028, sides: 6, caps: false }, P.metal);
    sphere(m, { radius: 0.055, segments: 6, rings: 3, at: [0, TOP + 0.87, 0] }, P.metal);
    extrudePolygon(m, { outline: [[0, 0.36], [0, 0], [0.62, 0.18]], depth: 0.03, centered: true, facing: '-z', at: [0.02, TOP + 0.45, 0] }, P.accent);
  }
  if (c.barrel) barrel(m, { at: c.barrel, planted: seed % 2 === 0, seed }, P);
  if (c.crate) crate(m, { at: c.crate, rotY: 12, seed }, P);

  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const out: ColliderSpec[] = [
    // Footings, then the splayed trestle in two steps (the braces close every
    // side to a car), deck with its rails.
    { shape: 'box', center: [0, 0.33, 0], half: [2.28, 0.33, 2.28] },
    { shape: 'box', center: [0, 1.43, 0], half: [2.05, 0.77, 2.05] },
    { shape: 'box', center: [0, 3.12, 0], half: [1.78, 0.92, 1.78] },
    { shape: 'box', center: [0, DECK - DECK_T / 2 + POST_H / 2, 0], half: [DECK_HALF, (DECK_T + POST_H) / 2, DECK_HALF] },
    { shape: 'cylinder', base: [0, DECK, 0], height: EAVE_Y1 - DECK, radius: 1.95 },
    { shape: 'cylinder', base: [0, EAVE_Y1, 0], height: 0.45, radius: 1.3 },
    // Ladder on the rear side.
    { shape: 'box', center: [0, DECK / 2, (LADDER_FOOT_Z + DECK_HALF) / 2 + 0.03], half: [LADDER_HALF + 0.07, DECK / 2, (LADDER_FOOT_Z - DECK_HALF) / 2 + 0.06] },
  ];
  if (c.barrel) out.push({ shape: 'cylinder', base: [c.barrel[0], 0, c.barrel[1]], height: 0.75, radius: 0.32 });
  if (c.crate) out.push({ shape: 'box', center: [c.crate[0], 0.22, c.crate[1]], half: [0.36, 0.22, 0.27], rotY: 12 });
  return out;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b09-water-tower',
  name: 'B09 Water Tower',
  category: 'building',
  size: { x: 4.85, y: 8.0, z: 4.83 },
  variants: 3,
  schemes: ['warm', 'coastal', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/village-landmarks/design-sheet.png',
    brief: 'design-documents/building-design-pack/village-landmarks/b09-water-tower-brief.txt',
  },
  build,
  colliders,
};

export default asset;
