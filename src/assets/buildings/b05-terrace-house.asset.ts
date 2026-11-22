import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, compose, convexHull, cylinder, extrudePolygon, mix, mixOklab, paint, polygonFacing, quadFacing, rotation, roundedBox, roundedRectRing, shade, soften, sweep, translation } from '../../gfx/solid';
import type { Paint, RGB, Vec2, Vec3 } from '../../gfx/solid';
import { STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  awning,
  barrel,
  beam,
  chamferRing,
  door,
  finishBuilding,
  frameRing,
  kneeBrace,
  lantern,
  openingRing,
  planter,
  schemePaints,
  stoneCourse,
  toFacade,
  variantPaints,
  variation,
  wallBox,
  windowUnit,
} from './parts';
import type { BuildingPaints, Facade, Opening } from './parts';

/**
 * B05 — Terrace House. Sheet scheme: COASTAL (turquoise plaster, cream trim,
 * coral door; the scheme's cobalt shows on the solar cells); it also builds
 * as 'warm' and 'sunny'.
 *
 * MAIN BODY 5.0 (x) × 5.0 (z) m, a soft plaster shell with 0.42 m plan
 * corners. Stone plinth to 0.5 m, cream parapet band 2.72 – 3.2 m round a
 * roof deck at 2.85 m, chunky cream posts with two steel rails on the band,
 * timber pergola on the LEFT roof half (front view), solar panel on the
 * right-front corner, external stair along the rear wall up to a landing at
 * the rear-right corner.
 * OVERALL 5.34 × 6.41 m in plan (x ±2.67, z −2.84 … +3.57), top of the
 * pergola at 4.7 m — inside the brief's 5.8 × 6.8 m placement envelope; the
 * deepest variant (awning + barrel) is 6.85 m. `size.y` counts the 0.1 m
 * skirt below the ground as the lab measures it.
 *
 * HEIGHTS — the sheet's proportions inside the brief's numbers. The brief
 * says "deck 2.8, parapet top 3.3, pergola top 4.5". Measured on the front
 * inset against the 5 m body: band 2.66 – 3.06, post tops 3.68, pergola top
 * 4.74 — the pergola stands a full 1.7 m over the band, which is what makes
 * the silhouette. Kept: the deck (2.85), a 0.48 m band, 0.6 m posts, and a
 * pergola top of 4.7 m (brief + 4 %; a 4.5 m top leaves the rafters a hand
 * above the railing). `PERGOLA_TOP` is the one number to change.
 *
 * THE DOOR REACHES THE GROUND, as on the sheet: the plinth stops either side
 * of a fat cream casing that stands prouder than the stones, with a low
 * cream threshold slab in front. The shared `stonePlinth` cannot be
 * interrupted (and has square corners), so the plinth here is the file's
 * own: `stoneCourse` runs between ROUNDED corner stones that follow the
 * shell, on a dark core notched at the door.
 *
 * Opening schedule (brief): front = two narrow windows left of the door,
 * door offset right; one narrow window in each side wall; rear = stair and
 * plain wall. Windows are W02 (0.45 × 1.1) in a 0.165 m cream surround with
 * a wall-coloured sash and one bar.
 *
 * OWN PARTS (not in the shared kit): the rounded plinth with a door gap, the
 * proud door casing + threshold, window sashes (4 triangles a point instead
 * of a second `frameRing`), the roof railing (fat soft block posts, slim
 * stanchions, steel rails — the kit's `railing` posts are 15 cm), the
 * pergola (cream post caps, ring beam, braces both ways — the kit's has
 * none of the sheet's capitals), the stair (chunky flight behind a smooth
 * raised stringer, foot block, landing, sloping handrail), and versions of
 * the kit's flatRoof / solarPanel / wallLamp (see their comments).
 *
 * SCHEMES. The deck is sand stone in every scheme, as on the vision image.
 * Under 'coastal' and 'sunny' the trim is cream; the window sash is the
 * scheme's frame colour, except under 'coastal' (cream frames) where the
 * sheet draws it in the wall's own turquoise. 'warm' has a cream wall, so
 * the band and door casing go coral and the window surrounds teal there.
 *
 * TRIANGLES. The rounded outlines (band, plinth, surrounds, casing) take 5
 * steps a corner; that and the newels' rounded tops are where the budget
 * goes, and why the deck has 1.2 m slabs rather than a staggered pattern.
 *
 * Seeds: 0 = the sheet. 1 = the vision image's shop front: a striped awning
 * over the two windows, a barrel planter by the corner, no solar panel
 * (the front railing then runs through); 2 = pergola rafters turned to run
 * along x with a lantern under the front beam, the panel moved onto the
 * deck behind it, a lit window, a pot at the door, knob on the right.
 * The door colour cycles with `variantPaints`; window width (±3 cm) and
 * pergola height (±8 cm) roll. 5 635 triangles for seed 0, 5 863 / 5 737
 * for seeds 1 / 2 (the game's three), at most 5 900 for any seed 0 – 5.
 */

const W = 5.0;
const D = 5.0;
const R = 0.42;
const PLINTH = 0.5;
const DECK = 2.85;
const BAND_BOTTOM = 2.72;
const PARAPET = 3.2;
const BAND_PROUD = 0.17;
const BAND_THICK = 0.5;
const PERGOLA_TOP = 4.7;
/** Centre line of the roof railing (posts and rails) on the band. */
const RAIL = 2.3;
const RAIL_POST = 0.32;
const RAIL_HEIGHT = 0.6;

const DOOR_U = 1.16;
const DOOR_W = 1.04;
const DOOR_SILL = 0.12;
const DOOR_TOP = 1.97;
const CASING = 0.19;
const CASING_PROUD = 0.16;

/** Rear stair: foot at x0, top riser at x1, landing to xEnd, between zIn (in the wall) and zOut. */
const STAIR = { x0: -2.45, x1: 1.5, xEnd: 2.62, zIn: 2.47, zOut: 3.47, top: PARAPET + 0.02, steps: 12 };

/** Street-side dressing of the variants, as plan positions (x, z): a barrel
 * planter by the left corner, pots either side of the door. */
const BARREL_AT: readonly [number, number] = [-2.05, -D / 2 - 0.48];
const POTS_AT: readonly (readonly [number, number])[] = [[2.2, -D / 2 - 0.45], [0.2, -D / 2 - 0.45]];

/** Height of the stair's upper handrail above the nosing line. */
const STAIR_RAIL = 0.76;

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** The sheet's lamp bezel is a warm bronze, not the cream of the band above it. */
const LAMP_CASING = paint('#A8926C', { gloss: 0.6, metal: 0.7 });
/** Cream-amber glow (the shared lamp's orange reads lemon at this size). */
const LAMP_LENS = paint('#FFC98A', { gloss: 0.5, emissive: 0.72 });
/** The grey-lavender box the sheet's solar panel is propped on. */
const SOLAR_STAND = paint('#8E8FA6', { gloss: 0.3 });
/** Deep cobalt cells: the shared `P.solar` at gloss 0.85 mirrors the sky and
 * goes periwinkle; the sheet's cells stay royal blue. */
const SOLAR_CELL = paint('#24418F', { gloss: 0.5 });
const SOLAR_FRAME = paint('#F6EEDF', { gloss: 0.45 });

/** Corner steps of the rounded outlines the eye follows (band, plinth,
 * surrounds): at 4 a quarter round reads as an octagon up close. */
const BAND_SEGS = 5;
const PLINTH_SEGS = 5;
const SURROUND_SEGS = 5;

// ---------------------------------------------------------------------------
// Plinth

const STONE_JOINT = 0.03;
const STONE_BEVEL = 0.05;
const STONE_PROUD = 0.12;
/** The kit's numbers (walls.ts): bevels fall back 5.5 cm to a rim that is
 * sunk 6 mm in the dark core, whose top stays 4 mm under the crowns. */
const STONE_RIM = STONE_PROUD - 0.055;
const CORE = STONE_RIM + 0.006;
const CORE_DROP = 0.004;

interface Station {
  /** Plan point on the wall surface and the unit outward normal there. */
  p: Vec2;
  n: Vec2;
}

function shadedQuad(m: SolidMesh, q: readonly [Vector3, Vector3, Vector3, Vector3], dir: Vector3, p: Paint, colors: readonly [RGB, RGB, RGB, RGB], normals: readonly [Vector3, Vector3, Vector3, Vector3]): void {
  const n = Vector3.Cross(q[1].subtract(q[0]), q[2].subtract(q[0])).add(Vector3.Cross(q[2].subtract(q[0]), q[3].subtract(q[0])));
  if (Vector3.Dot(n, dir) >= 0) m.quad(q[0], q[1], q[2], q[3], p, colors, normals);
  else m.quad(q[0], q[3], q[2], q[1], p, [colors[0], colors[3], colors[2], colors[1]], [normals[0], normals[3], normals[2], normals[1]]);
}

/**
 * One plinth stone that follows a plan path (a straight leg, a quarter
 * round, a straight leg): flat-to-curved face with pinned radial normals,
 * top bevel, bevelled joint ends, closed ledge on top. Same tones and bevel
 * as the kit's `stoneCourse` stones, so the two sit in one course. Its rim
 * is sunk in the dark core.
 */
function wrapStone(m: SolidMesh, st: readonly Station[], o: { bottom: number; top: number; face: number }, p: Paint, P: BuildingPaints): void {
  const last = st.length - 1;
  const tones = { face: p.color, top: mixOklab(p.color, STONE.upperFace, 0.26), joint: mixOklab(p.color, P.stoneDark.color, 0.7) };
  const upper = mixOklab(tones.face, tones.top, 0.35);
  const yH = o.top - STONE_BEVEL;
  const dir = (a: Station, b: Station): Vec2 => {
    const dx = b.p[0] - a.p[0];
    const dz = b.p[1] - a.p[1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const d0 = dir(st[0], st[1]);
  const d1 = dir(st[last - 1], st[last]);
  // Face points: the two end stations are pulled in along the path by the bevel.
  const F = (i: number, y: number): Vector3 => {
    const s = st[i];
    const pull: Vec2 = i === 0 ? [d0[0] * STONE_BEVEL, d0[1] * STONE_BEVEL] : i === last ? [-d1[0] * STONE_BEVEL, -d1[1] * STONE_BEVEL] : [0, 0];
    return V(s.p[0] + s.n[0] * o.face + pull[0], y, s.p[1] + s.n[1] * o.face + pull[1]);
  };
  const T = (i: number, y: number): Vector3 => V(st[i].p[0] + st[i].n[0] * STONE_RIM, y, st[i].p[1] + st[i].n[1] * STONE_RIM);
  const L = (i: number): Vector3 => V(st[i].p[0] - st[i].n[0] * 0.03, o.top, st[i].p[1] - st[i].n[1] * 0.03);
  const N = (i: number): Vector3 => V(st[i].n[0], 0, st[i].n[1]);
  const up = V(0, 1, 0);
  const tilt = (20 * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const ledge = paint(p, { color: tones.top, smooth: 0 });
  for (let i = 0; i < last; i++) {
    const j = i + 1;
    shadedQuad(m, [F(i, o.bottom), F(j, o.bottom), F(j, yH), F(i, yH)], N(i).add(N(j)), p, [tones.face, tones.face, upper, upper], [N(i), N(j), N(j), N(i)]);
    const ri = N(i).scale(sinT).add(up.scale(cosT));
    const rj = N(j).scale(sinT).add(up.scale(cosT));
    shadedQuad(m, [F(i, yH), F(j, yH), T(j, o.top), T(i, o.top)], N(i).add(N(j)).add(up), p, [upper, upper, tones.top, tones.top], [N(i), N(j), rj, ri]);
    quadFacing(m, T(i, o.top), T(j, o.top), L(j), L(i), up, ledge);
  }
  for (const [i, d] of [[0, [-d0[0], -d0[1]]], [last, d1]] as const) {
    const joint = V(d[0], 0, d[1]);
    const low = joint.scale(cosT).add(N(i).scale(sinT));
    const high = joint.add(up).normalize().scale(cosT).add(N(i).scale(sinT));
    shadedQuad(m, [F(i, o.bottom), T(i, o.bottom), T(i, o.top), F(i, yH)], N(i).add(joint), p, [tones.face, tones.joint, tones.joint, upper], [N(i), low, high, N(i)]);
  }
}

/** Stations of the stone wrapping plan corner `k` (0 = front-right, then
 * counter-clockwise seen from above): `legIn` meters of the wall before the
 * curve, the quarter round, `legOut` meters of the wall after it. */
function cornerStations(k: number, legIn: number, legOut: number): Station[] {
  const a0 = -90 + k * 90;
  const sx = k === 0 || k === 1 ? 1 : -1;
  const sz = k === 1 || k === 2 ? 1 : -1;
  const cx = sx * (W / 2 - R);
  const cz = sz * (D / 2 - R);
  const rad = Math.PI / 180;
  const at = (deg: number): Station => ({ p: [cx + Math.cos(deg * rad) * R, cz + Math.sin(deg * rad) * R], n: [Math.cos(deg * rad), Math.sin(deg * rad)] });
  const out: Station[] = [];
  const s0 = at(a0);
  const s1 = at(a0 + 90);
  // Walking counter-clockwise, the wall before the curve runs along (−sin a0, cos a0).
  const t0: Vec2 = [-Math.sin(a0 * rad), Math.cos(a0 * rad)];
  const t1: Vec2 = [-Math.sin((a0 + 90) * rad), Math.cos((a0 + 90) * rad)];
  if (legIn > 0.02) out.push({ p: [s0.p[0] - t0[0] * legIn, s0.p[1] - t0[1] * legIn], n: s0.n });
  const steps = PLINTH_SEGS;
  for (let i = 0; i <= steps; i++) out.push(at(a0 + (90 * i) / steps));
  if (legOut > 0.02) out.push({ p: [s1.p[0] + t1[0] * legOut, s1.p[1] + t1[1] * legOut], n: s1.n });
  return out;
}

/** Plan outline of the body grown by `e`, counter-clockwise seen from above
 * (x right, z up), starting and ending on the front wall either side of the
 * door, where it is notched back behind the door leaf. */
function coreOutline(e: number): Vec2[] {
  const rad = Math.PI / 180;
  const out: Vec2[] = [];
  const nL = DOOR_U - DOOR_W / 2 - 0.07;
  const nR = DOOR_U + DOOR_W / 2 + 0.07;
  const zF = -D / 2 - e;
  const zN = -D / 2 + 0.22;
  out.push([nR, zN], [nR, zF]);
  for (let k = 0; k < 4; k++) {
    const sx = k === 0 || k === 1 ? 1 : -1;
    const sz = k === 1 || k === 2 ? 1 : -1;
    // Two steps a corner are enough: the core's curve hides entirely inside
    // the corner stone wrapped round it (chords stay outside nothing).
    for (let i = 0; i <= 2; i++) {
      const a = (-90 + k * 90 + (90 * i) / 2) * rad;
      out.push([sx * (W / 2 - R) + Math.cos(a) * (R + e), sz * (D / 2 - R) + Math.sin(a) * (R + e)]);
    }
  }
  out.push([nL, zF], [nL, zN]);
  return out;
}

function plinth(m: SolidMesh, F: Record<'front' | 'back' | 'left' | 'right', Facade>, seed: number, P: BuildingPaints): void {
  const bottom = -0.1;
  const top = PLINTH;
  // Dark core: what shows at the bottom of every joint.
  const core = coreOutline(CORE);
  const yc = top - CORE_DROP;
  for (let i = 0; i < core.length; i++) {
    const [ax, az] = core[i];
    const [bx, bz] = core[(i + 1) % core.length];
    quadFacing(m, V(ax, bottom, az), V(bx, bottom, bz), V(bx, yc, bz), V(ax, yc, az), V(bz - az, 0, ax - bx), P.stoneDark);
  }
  polygonFacing(m, core.map(([x, z]) => V(x, yc, z)), V(0, 1, 0), P.stoneDark);
  // One plate under everything, out past the stone faces and the door
  // casing: neither has an underside of its own, and a building tipped on a
  // slope or seen from below during a jump must stay closed.
  const g = STONE_PROUD + 0.045;
  polygonFacing(m, roundedRectRing(W + 2 * g, D + 2 * g, R + g, PLINTH_SEGS).map(([x, z]) => V(x, bottom, z)), V(0, -1, 0), P.stoneDark);

  const r = variation(seed, 'b05').rng('plinth');
  const casingL = DOOR_U - DOOR_W / 2 - CASING + 0.04;
  const casingR = DOOR_U + DOOR_W / 2 + CASING - 0.04;
  // Legs of the four corner stones: [before the curve, after it]. The
  // front-right stone starts inside the door casing, as on the sheet.
  const legs: [number, number][] = [
    [W / 2 - R - casingR, r.range(0.28, 0.5)],
    [r.range(0.2, 0.45), r.range(0.2, 0.45)],
    [r.range(0.2, 0.45), r.range(0.2, 0.45)],
    [r.range(0.2, 0.45), r.range(0.25, 0.5)],
  ];
  const stones = [P.stone, P.stoneLight, P.stone, paint(P.stone, { color: shade(P.stone.color, 0.92) })];
  legs.forEach(([a, b], k) => wrapStone(m, cornerStations(k, a, b), { bottom, top, face: STONE_PROUD + 0.02 }, stones[(k + seed) % stones.length], P));

  const half = W / 2 - R;
  const course = (on: Facade, u0: number, u1: number): void => stoneCourse(m, { on, u0, u1, bottom, top, proud: STONE_PROUD, backing: false, seed }, P);
  // u runs counter-clockwise on every facade: corner k − 1 is at its low end.
  course(F.front, -half + legs[3][1] + STONE_JOINT, casingL);
  course(F.right, -half + legs[0][1] + STONE_JOINT, half - legs[1][0] - STONE_JOINT);
  course(F.back, -half + legs[1][1] + STONE_JOINT, half - legs[2][0] - STONE_JOINT);
  course(F.left, -half + legs[2][1] + STONE_JOINT, half - legs[3][0] - STONE_JOINT);
}

// ---------------------------------------------------------------------------
// Door casing, window sash

/** The fat cream door casing: lines the whole reveal down to the ground and
 * stands prouder than the plinth stones that die into its sides. */
function doorCasing(m: SolidMesh, on: Facade, op: Opening, casing: Paint, P: BuildingPaints): void {
  const start = m.mark();
  // The outer ring is the opening grown by the casing width all round: start
  // it a casing width above the skirt, or its foot digs 0.3 m into the ground.
  const foot: Opening = { u: op.u, v: CASING - 0.1, w: op.w, h: op.v + op.h + 0.1 - CASING, round: op.round };
  // Only the two top corners are round; the square foot corners come out as
  // coincident points, which `frameRing` skips, so the steps cost little.
  frameRing(m, { inner: openingRing(op, -0.012, 0, SURROUND_SEGS, true), outer: openingRing(foot, CASING, 0, SURROUND_SEGS, true), z0: -0.12, z1: CASING_PROUD, bevel: 0.05 }, soften(casing, 45));
  // Threshold slab: wider and prouder than the casing, a low step at the ground.
  roundedBox(m, { min: [op.u - op.w / 2 - CASING - 0.1, -0.085, 0.02], max: [op.u + op.w / 2 + CASING + 0.1, 0.09, CASING_PROUD + 0.18], radius: 0.04, segments: 1, faces: { nz: null } }, P.trim);
  toFacade(m, start, on);
}

/** Sash of a narrow window: a wall-coloured ring in front of the glass —
 * front face and inner lip only (its outer side is buried in the reveal). */
function sash(m: SolidMesh, on: Facade, op: Opening, recess: number, p: Paint, surround: number, surroundPaint: Paint): void {
  const start = m.mark();
  // The fat surround, as `windowUnit` builds it.
  frameRing(m, { inner: openingRing(op, -0.012, 0.02, SURROUND_SEGS, true), outer: openingRing(op, surround, 0.08, SURROUND_SEGS, true), z0: -0.03, z1: 0.08, bevel: 0.035 }, soften(surroundPaint, 45));
  const width = 0.065;
  const inner = openingRing(op, -width, 0, 2, true);
  const outer = openingRing(op, 0.012, 0, 2, true);
  const z0 = -recess;
  const z1 = -recess + 0.06;
  for (let i = 0; i < inner.length; i++) {
    const j = (i + 1) % inner.length;
    const a = inner[i];
    const b = inner[j];
    const c = outer[j];
    const d = outer[i];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;
    const cu = op.u - (a[0] + b[0]) / 2;
    const cv = op.v + op.h / 2 - (a[1] + b[1]) / 2;
    quadFacing(m, V(a[0], a[1], z1), V(b[0], b[1], z1), V(c[0], c[1], z1), V(d[0], d[1], z1), V(0, 0, 1), p);
    quadFacing(m, V(a[0], a[1], z0), V(b[0], b[1], z0), V(b[0], b[1], z1), V(a[0], a[1], z1), V(cu, cv, 0), p);
  }
  toFacade(m, start, on);
}

// ---------------------------------------------------------------------------
// Roof furniture

/**
 * A soft block post standing on y0 (buried end, open unless `bottom`) up to y1: square
 * section with chamfered upright edges, and a top rounded over in two steps
 * to a flat crown — 54 triangles, where a `roundedBox` that round costs 92.
 * The softened paint shades the chamfers as round.
 */
function softPost(m: SolidMesh, x: number, z: number, y0: number, y1: number, size: number, p: Paint, bottom = false): void {
  const c = size * 0.2;
  const r = Math.min(size * 0.3, (y1 - y0) * 0.4);
  const ring = (inset: number, y: number): Vector3[] => {
    const h = size / 2 - inset;
    const k = Math.max(0.005, c - inset * 0.6);
    return chamferRing(h * 2, h * 2, k).map(([a, b]) => V(x + a, y, z + b));
  };
  const rings = [ring(0, y0), ring(0, y1 - r), ring(r * (1 - Math.SQRT1_2), y1 - r * (1 - Math.SQRT1_2)), ring(r, y1)];
  const sp = soften(p, 50);
  for (let k = 0; k + 1 < rings.length; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const mid = a[i].add(a[j]).scale(0.5);
      quadFacing(m, a[i], a[j], b[j], b[i], V(mid.x - x, k === 0 ? 0 : 0.6 * k, mid.z - z), sp);
    }
  }
  polygonFacing(m, rings[3], V(0, 1, 0), sp);
  if (bottom) polygonFacing(m, rings[0], V(0, -1, 0), sp);
}

/** Fat cream block post of the roof railing, sunk in the band. */
function railPost(m: SolidMesh, x: number, z: number, P: BuildingPaints, size = RAIL_POST, height = RAIL_HEIGHT, base = PARAPET): void {
  softPost(m, x, z, base - 0.05, base + height, size, P.trim);
}

/** Slim cream stanchion between two block posts. */
function stanchion(m: SolidMesh, x: number, z: number, P: BuildingPaints, base = PARAPET): void {
  beam(m, { from: [x, base - 0.04, z], to: [x, base + RAIL_HEIGHT - 0.06, z], size: 0.13, side: [0, 0, 1], caps: 'end', segments: 1 }, P.trim);
}

/** Two steel rails between plan points a and b (their ends buried in posts). */
function rails(m: SolidMesh, a: readonly [number, number], b: readonly [number, number], P: BuildingPaints, base = PARAPET, baseB = base): void {
  for (const h of [0.24, 0.46]) cylinder(m, { from: [a[0], base + h, a[1]], to: [b[0], baseB + h, b[1]], radius: 0.045, sides: 5, caps: false }, P.metal);
}

interface PergolaSpec {
  x: readonly [number, number];
  z: readonly [number, number];
  base: number;
  top: number;
  /** Which way the top rafters run; the two carriers run the other way. */
  rafterAxis: 'x' | 'z';
  rafters: number;
}

/**
 * The sheet's pergola: square timber posts with cream capitals, two carrier
 * beams with sailing ends, two tie beams closing the ring, a row of rafters
 * notched over the carriers, and a knee brace each way from every post.
 */
function pergolaFrame(m: SolidMesh, o: PergolaSpec, P: BuildingPaints): void {
  // Chunky, as on the sheet: the posts nearly as fat as the cream railing posts.
  const ps = 0.28;
  const oh = 0.36;
  const rafterH = 0.18;
  const carrierH = 0.24;
  const carrierTop = o.top - rafterH * 0.7;
  const carrierY = carrierTop - carrierH / 2;
  const capTop = carrierTop - carrierH + 0.03;
  const capBottom = capTop - 0.15;
  const alongX = o.rafterAxis === 'z';
  for (const x of o.x) {
    for (const z of o.z) {
      beam(m, { from: [x, o.base - 0.03, z], to: [x, capBottom + 0.03, z], size: ps, side: [0, 0, 1], caps: false, segments: 1 }, P.timber);
      beam(m, { from: [x, capBottom, z], to: [x, capTop, z], size: ps + 0.12, chamfer: 0.045, side: [0, 0, 1], segments: 1 }, P.trim);
      const ix = x === o.x[0] ? 1 : -1;
      const iz = z === o.z[0] ? 1 : -1;
      kneeBrace(m, { at: [x, carrierY - carrierH * 0.3, z], along: [ix, 0, 0], reach: 0.48, size: 0.15 }, P.timber);
      kneeBrace(m, { at: [x, carrierY - carrierH * 0.3, z], along: [0, 0, iz], reach: 0.48, size: 0.15 }, P.timber);
    }
  }
  // Carriers (sailing ends) and the ties between them (a touch lower and
  // slimmer, so no two faces share a plane where they cross).
  const carrier = (a: [number, number, number], b: [number, number, number]): void => beam(m, { from: a, to: b, size: [0.21, carrierH], side: [0, 1, 0], segments: 1 }, P.timber);
  const tie = (a: [number, number, number], b: [number, number, number]): void => beam(m, { from: a, to: b, size: [0.17, carrierH - 0.04], side: [0, 1, 0], caps: false, segments: 1 }, P.timber);
  if (alongX) {
    for (const z of o.z) carrier([o.x[0] - oh, carrierY, z], [o.x[1] + oh, carrierY, z]);
    for (const x of o.x) tie([x, carrierY - 0.03, o.z[0]], [x, carrierY - 0.03, o.z[1]]);
  } else {
    for (const x of o.x) carrier([x, carrierY, o.z[0] - oh], [x, carrierY, o.z[1] + oh]);
    for (const z of o.z) tie([o.x[0], carrierY - 0.03, z], [o.x[1], carrierY - 0.03, z]);
  }
  const [a0, a1] = alongX ? o.x : o.z;
  const [b0, b1] = alongX ? o.z : o.x;
  for (let i = 0; i < o.rafters; i++) {
    const a = a0 - oh * 0.55 + (i / (o.rafters - 1)) * (a1 - a0 + oh * 1.1);
    const y = o.top - rafterH / 2;
    const from: [number, number, number] = alongX ? [a, y, b0 - oh] : [b0 - oh, y, a];
    const to: [number, number, number] = alongX ? [a, y, b1 + oh] : [b1 + oh, y, a];
    beam(m, { from, to, size: [0.15, rafterH], side: [0, 1, 0], chamfer: 0.03, segments: 1 }, P.timber);
  }
}

// ---------------------------------------------------------------------------
// Rear stair

function rearStair(m: SolidMesh, P: BuildingPaints): void {
  const run = STAIR.x1 - STAIR.x0;
  const rise = STAIR.top;
  const n = STAIR.steps;
  const going = run / n;
  const riser = rise / n;
  const landing = STAIR.xEnd - STAIR.x1;
  // Side view: x along the run from the foot, y up. Stepped top, a landing,
  // a flat underside to the landing and a sloping one to the flight.
  const outline: Vec2[] = [];
  for (let i = 0; i < n; i++) outline.push([i * going, i * riser], [i * going, (i + 1) * riser]);
  const slope = (rise - 0.32 - riser + 0.1) / (run - going);
  const under = rise - 0.3;
  const soffit: Vec2[] = [[run + landing, under], [going + (under + 0.1) / slope, under], [going, -0.1]];
  outline.push([run + landing, rise], ...soffit, [0, -0.1]);
  // The stepped body stops short of the open side: the stringer takes over there.
  const zIn = STAIR.zIn;
  const zBody = STAIR.zOut - 0.1;
  const stairPaint = soften(P.trim, 40);
  // Its +z face is buried in the stringer.
  extrudePolygon(m, { outline, depth: zBody - zIn, centered: true, bevel: 0.04, front: false, at: [STAIR.x0, 0, (zIn + zBody) / 2] }, stairPaint);

  // The sheet's smooth raised stringer on the open side: a slab whose top
  // runs parallel to the nosing line, 0.13 m above it, then level along the
  // landing — it hides the sawtooth, so the flight reads as one chunky piece.
  const lift = 0.13;
  const nose = (x: number): number => Math.min(rise, riser + (x * riser) / going);
  const stringer: Vec2[] = [[0, -0.1], [0, nose(0) + lift], [run - going, rise + lift], [run + landing, rise + lift], ...soffit];
  const sw = 0.2;
  const zs = STAIR.zOut - sw / 2 + 0.02;
  extrudePolygon(m, { outline: stringer, depth: sw, centered: true, bevel: 0.05, at: [STAIR.x0, 0, zs] }, stairPaint);
  // A wide low foot block, as on the sheet, that the first newel stands on.
  roundedBox(m, { min: [STAIR.x0 - 0.14, -0.1, zIn + 0.05], max: [STAIR.x0 + going + 0.05, riser * 0.6, STAIR.zOut + 0.1], radius: 0.05, segments: 1 }, stairPaint);

  // Handrail on the stringer: stout newels, two rails following the nosings.
  const along = (x: number): number => x - STAIR.x0;
  const top = (x: number): number => nose(along(x)) + lift;
  const xs = [STAIR.x0 + 0.14, STAIR.x0 + run * 0.4, STAIR.x1 - going * 0.6, STAIR.xEnd - 0.2];
  xs.forEach((x) => softPost(m, x, zs, top(x) - 0.06, nose(along(x)) + STAIR_RAIL + 0.16, 0.25, P.trim, true));
  for (const h of [STAIR_RAIL - 0.32, STAIR_RAIL]) {
    const pt = (i: number): [number, number, number] => [xs[i], nose(along(xs[i])) + h, zs];
    cylinder(m, { from: pt(0), to: pt(2), radius: 0.042, sides: 5, caps: false }, P.metal);
    cylinder(m, { from: pt(2), to: pt(3), radius: 0.042, sides: 5, caps: false }, P.metal);
    // Across the end of the landing, into the roof's corner post.
    cylinder(m, { from: pt(3), to: [xs[3], rise + h, RAIL], radius: 0.042, sides: 5, caps: false }, P.metal);
  }
}

// ---------------------------------------------------------------------------
// Roof, solar array, lamp (own versions of the kit's flatRoof / solarPanel /
// wallLamp: the kit's band corners have 3 steps, its panel has no hidden
// stand and a mirror-glossy cell, its lamp is an octagon with one bar)

/**
 * The fat parapet band (as `flatRoof` sweeps it, with `BAND_SEGS` corner
 * steps) round a sand-stone deck. The vision image paves this roof in the
 * parapet's cream family; seen from the game camera the deck is the biggest
 * surface of the house, so it carries joints at a flagstone pitch to give it
 * scale, and only a hint of the scheme's roof colour.
 */
function terraceRoof(m: SolidMesh, band: Paint, P: BuildingPaints): void {
  const off = BAND_PROUD - BAND_THICK / 2;
  const ring = roundedRectRing(W + off * 2, D + off * 2, R + off, BAND_SEGS);
  const h = PARAPET - BAND_BOTTOM;
  const yc = (PARAPET + BAND_BOTTOM) / 2;
  sweep(m, { path: ring.map(([x, z]) => V(x, yc, z)), closed: true, section: chamferRing(h, BAND_THICK, Math.min(BAND_THICK, h) * 0.24), up: [0, 1, 0] }, soften(band, 45));

  // The deck is laid out as its own quads, cut exactly on the joints (region
  // paint on a fan-triangulated plate costs four times the triangles). Its
  // square corners hide inside the band. 1.2 m slabs, as on the vision's
  // terraces (staggered joints cost half as much again).
  const sand = shade(mix(mix(P.trim.color, P.stone.color, 0.14), P.roof.color, 0.06), 0.9);
  const deck = paint(sand, { gloss: 0.2 });
  const joint = paint(deck, { color: shade(sand, 0.82) });
  const e = W / 2 - 0.05;
  const j = 0.022;
  const rows = [-1.2, 0, 1.2];
  const cross = (): number[] => [-1.2, 0, 1.2];
  const cuts = (xs: readonly number[]): number[] => [-e, ...xs.flatMap((x) => [x - j, x + j]), e];
  const up = V(0, 1, 0);
  const strip = (z0: number, z1: number, xs: readonly number[], p: (k: number) => Paint): void => {
    for (let k = 0; k + 1 < xs.length; k++) quadFacing(m, V(xs[k], DECK, z0), V(xs[k + 1], DECK, z0), V(xs[k + 1], DECK, z1), V(xs[k], DECK, z1), up, p(k));
  };
  const zs = [-e, ...rows.flatMap((z) => [z - j, z + j]), e];
  for (let i = 0; i <= rows.length; i++) {
    // A row of stones, then the long joint above it, carrying every vertex
    // of both neighbouring rows (no T-junctions in the plane).
    strip(zs[i * 2], zs[i * 2 + 1], cuts(cross()), (k) => (k % 2 ? joint : deck));
    if (i < rows.length) {
      const xs = cuts(cross());
      strip(zs[i * 2 + 1], zs[i * 2 + 2], xs, () => joint);
    }
  }
}

/**
 * The sheet's roof panel: near-white frame, 4 × 2 deep-cobalt cells,
 * propped up `tilt` degrees on a lavender-grey box that stays inside the
 * frame's outline. Faces −z before `yaw`; `at` = middle of the low edge's
 * underside; the box reaches `drop` below it.
 */
function solarArray(m: SolidMesh, at: readonly [number, number, number], yaw: number, tilt: number, drop: number): void {
  const start = m.mark();
  const w = 1.3;
  const d = 0.92;
  const th = 0.07;
  roundedBox(m, { min: [-w / 2, 0, -d / 2], max: [w / 2, th, d / 2], radius: 0.03, segments: 1 }, SOLAR_FRAME);
  const cols = 4;
  const rows = 2;
  const margin = 0.07;
  const gap = 0.03;
  const cw = (w - margin * 2 + gap) / cols;
  const cd = (d - margin * 2 + gap) / rows;
  const bev = 0.012;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x0 = -w / 2 + margin + i * cw;
      const z0 = -d / 2 + margin + j * cd;
      const x1 = x0 + cw - gap;
      const z1 = z0 + cd - gap;
      const lo = [V(x0, th - 0.003, z0), V(x1, th - 0.003, z0), V(x1, th - 0.003, z1), V(x0, th - 0.003, z1)];
      const hi = [V(x0 + bev, th + bev, z0 + bev), V(x1 - bev, th + bev, z0 + bev), V(x1 - bev, th + bev, z1 - bev), V(x0 + bev, th + bev, z1 - bev)];
      quadFacing(m, hi[0], hi[1], hi[2], hi[3], V(0, 1, 0), SOLAR_CELL);
      const out = [V(0, 1, -1), V(1, 1, 0), V(0, 1, 1), V(-1, 1, 0)];
      for (let k = 0; k < 4; k++) quadFacing(m, lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k], out[k], SOLAR_CELL);
    }
  }
  // Tip about the low (front) edge: the high edge is at the back.
  m.rotate('x', -tilt, start, [0, 0, -d / 2]);
  const t = (tilt * Math.PI) / 180;
  // The underside at plan depth z; the box's top sinks 3 cm into the frame.
  const under = (z: number): number => (z + d / 2) * Math.tan(t) + 0.03;
  const za = -d / 2 + 0.14;
  const zb = -d / 2 + d * Math.cos(t) - 0.12;
  const xs = w / 2 - 0.22;
  const points: Vec3[] = [];
  for (const x of [-xs, xs]) points.push([x, -drop, za], [x, -drop, zb], [x, under(za), za], [x, under(zb), zb]);
  convexHull(m, { points }, SOLAR_STAND);
  m.transform(compose(translation(0, 0, d / 2), rotation('y', yaw), translation(at[0], at[1], at[2])), start);
}

/** L01 bulkhead lamp, the sheet's way: a smooth stadium bezel in warm
 * bronze, a cream-amber lens a hair proud of it, a cross guard kept inside
 * the bezel. */
function bulkheadLamp(m: SolidMesh, on: Facade, u: number, v: number): void {
  const start = m.mark();
  const w = 0.62;
  const h = 0.28;
  extrudePolygon(m, { outline: roundedRectRing(w, h, h / 2, 3), depth: 0.1, bevel: 0.03, back: false, at: [u, v, -0.02] }, soften(LAMP_CASING, 45));
  const lw = w - 0.12;
  const lh = h - 0.12;
  extrudePolygon(m, { outline: roundedRectRing(lw, lh, lh / 2, 2), depth: 0.045, bevel: 0.02, back: false, at: [u, v, 0.05] }, soften(LAMP_LENS, 45));
  const bar = 0.032;
  box(m, { min: [u - bar / 2, v - lh / 2 + 0.015, 0.08], max: [u + bar / 2, v + lh / 2 - 0.015, 0.112], faces: { nz: null } }, LAMP_CASING);
  box(m, { min: [u - lw / 2 + 0.05, v - bar / 2, 0.08], max: [u + lw / 2 - 0.05, v + bar / 2, 0.11], faces: { nz: null } }, LAMP_CASING);
  toFacade(m, start, on);
}

// ---------------------------------------------------------------------------
// Variants

/** Secondary choices of one variant (seed 0 = the sheet), shared by `build`
 * and `colliders`. The game instantiates seeds 0 – 2, so what should be seen
 * cycles. */
function choices(seed: number) {
  const v = variation(seed, 'b05');
  return {
    v,
    // 1 = the vision's shop front: striped awning over the two windows and a
    // barrel, no solar panel; 2 = pergola turned, panel at the back, lantern, pots.
    awning: v.cycle([false, true, false] as const),
    solar: v.cycle(['front', 'none', 'rear'] as const),
    rafterAxis: v.cycle(['z', 'z', 'x'] as const),
    lantern: v.cycle([false, false, true] as const),
    barrel: v.cycle([false, true, false] as const),
    pots: v.cycle([0, 0, 1] as const),
    litWindow: v.cycle([false, false, true, false] as const),
    knob: v.cycle([-1, -1, 1] as const),
    winW: 0.45 + v.shift('winW', 0.03),
    pergolaTop: PERGOLA_TOP + v.shift('pergola', 0.08),
  };
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const P = variantPaints(schemePaints(scheme, 'coastal'), c.v);
  const m = new SolidMesh();

  // Under 'warm' the wall is cream: cream surrounds and a cream band would
  // vanish into it. The band then takes the scheme's coral roof colour (it
  // is this house's roof edge), the door casing too, and the window
  // surrounds the teal frame colour.
  const warm = P.scheme === 'warm';
  const bandPaint = warm ? P.roof : P.trim;
  const surroundPaint = warm ? P.frame : P.trim;
  // The casing must still part from the door, whose colour cycles by seed.
  const near = (a: RGB, b: RGB): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.25;
  const casingPaint = !warm ? P.trim : near(P.door.color, P.roof.color) ? P.frame : P.roof;

  // a. Roof: the fat band round a sand-stone deck.
  terraceRoof(m, bandPaint, P);

  // c. Walls. The door is cut from the panel's foot (a bay); its leaf runs on down to the threshold.
  const DOOR: Opening = { u: DOOR_U, v: DOOR_SILL, w: DOOR_W, h: DOOR_TOP - DOOR_SILL, round: 0.12 };
  const DOOR_CUT: Opening = { u: DOOR_U, v: PLINTH - 0.1, w: DOOR_W, h: DOOR_TOP - (PLINTH - 0.1), round: 0.12 };
  const win = (u: number): Opening => ({ u, v: 0.95, w: c.winW, h: 1.1, round: 0.12, roundAll: true });
  const frontWins = [win(-1.55), win(-0.45)];
  const sideWin = win(0);
  const F = wallBox(m, { width: W, depth: D, bottom: PLINTH - 0.1, top: DECK, cornerRadius: R, grid: 1.15, openings: { front: [DOOR_CUT, ...frontWins], left: [sideWin], right: [sideWin] } }, P.wall);

  // b. Plinth (after the walls: it needs their facades).
  plinth(m, F, seed, P);

  // f. Openings.
  door(m, { on: F.front, opening: DOOR, surround: 0, planks: 3, handleSide: c.knob }, P);
  doorCasing(m, F.front, DOOR, casingPaint, P);
  // The sash is the wall's own colour on the sheet (cream would vanish in the surround).
  const sashPaint = P.scheme === 'coastal' ? paint(P.frame, { color: shade(P.wall.color, 0.92) }) : warm ? P.trim : P.frame;
  const windows: [Facade, Opening, boolean][] = [
    [F.front, frontWins[0], false],
    [F.front, frontWins[1], c.litWindow],
    [F.left, sideWin, false],
    [F.right, sideWin, false],
  ];
  for (const [on, opening, lit] of windows) {
    windowUnit(m, { on, opening, sill: false, head: false, mullions: [1, 2], frame: 0, framePaint: sashPaint, lit }, P);
    sash(m, on, opening, 0.13, sashPaint, 0.165, surroundPaint);
  }

  // g. Attachments. The lamp sits between the casing (to 2.16) and the band (from 2.72).
  bulkheadLamp(m, F.front, DOOR_U, 2.44);
  // One bracket, between the two surrounds; 0.78 m out keeps the variant inside the placement envelope.
  if (c.awning) awning(m, { on: F.front, u: -1.0, v: 2.62, width: 2.3, projection: 0.78, drop: 0.38, stripes: 7, brackets: 1 }, P);

  // Roof railing: block posts at the corners and where a run ends, stanchions between.
  const solarFront = c.solar === 'front';
  const frontEnd = solarFront ? 0.56 : RAIL;
  for (const [x, z] of [[-RAIL, -RAIL], [RAIL, -RAIL], [-RAIL, RAIL], [-0.25, -RAIL], [1.3, RAIL]] as const) railPost(m, x, z, P);
  // The rear-right corner post is the stair's newel: tall enough to take the landing's higher handrail.
  railPost(m, RAIL, RAIL, P, RAIL_POST, STAIR_RAIL + 0.14);
  if (solarFront) railPost(m, frontEnd, -RAIL, P);
  rails(m, [-RAIL, -RAIL], [frontEnd, -RAIL], P);
  rails(m, [RAIL, -RAIL], [RAIL, RAIL], P);
  rails(m, [-RAIL, -RAIL], [-RAIL, RAIL], P);
  rails(m, [-RAIL, RAIL], [1.3, RAIL], P);
  for (const [x, z] of [[-1.28, -RAIL], [RAIL, 0], [-RAIL, 0], [-0.5, RAIL]] as const) stanchion(m, x, z, P);
  if (!solarFront) stanchion(m, 1.05, -RAIL, P);

  pergolaFrame(m, { x: [-1.98, 0.2], z: [-1.92, 0.42], base: DECK, top: c.pergolaTop, rafterAxis: c.rafterAxis, rafters: 7 }, P);
  if (c.lantern) lantern(m, { at: [-0.9, c.pergolaTop - 0.36, -1.92], size: 0.22 }, P);

  if (c.solar === 'front') {
    // On a cream base across the band, in the gap the front railing leaves.
    roundedBox(m, { min: [0.8, PARAPET - 0.08, -2.6], max: [2.05, PARAPET + 0.12, -1.5], radius: 0.05, segments: 1, faces: { ny: null } }, P.trim);
    // Turned a little toward the sheet's front-right hero camera.
    solarArray(m, [1.42, PARAPET + 0.3, -2.32], -8, 38, 0.22);
  } else if (c.solar === 'rear') {
    solarArray(m, [1.2, DECK + 0.3, -0.25], -18, 34, 0.34);
  }

  rearStair(m, P);
  // Step down from the band onto the deck at the head of the stair.
  beam(m, { from: [1.52, DECK + 0.07, 1.96], to: [2.12, DECK + 0.07, 1.96], size: [0.48, 0.22], side: [0, 1, 0], chamfer: 0.04, segments: 1 }, soften(P.trim, 45));

  // h. Dressing.
  if (c.barrel) barrel(m, { at: BARREL_AT, planted: true, seed }, P);
  POTS_AT.slice(0, c.pots).forEach((at, i) => planter(m, { at, seed: seed * 7 + i, paint: i === 0 ? P.accent : P.trim }, P));
  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const run = STAIR.x1 - STAIR.x0;
  const zc = (STAIR.zIn + STAIR.zOut) / 2;
  const hz = (STAIR.zOut - STAIR.zIn) / 2 + 0.1;
  // The flight as three stepped boxes, each as high as the stair at its upper end.
  const flight = (f0: number, f1: number): ColliderSpec => {
    const x0 = f0 <= 0 ? STAIR.x0 - 0.14 : STAIR.x0 + run * f0;
    const x1 = f1 >= 1 ? STAIR.xEnd : STAIR.x0 + run * f1;
    const h = STAIR.top * Math.min(1, f1);
    return { shape: 'box', center: [(x0 + x1) / 2, h / 2, zc], half: [(x1 - x0) / 2, h / 2, hz] };
  };
  // Walls, plinth and band, rounded like the shell: a cross of two boxes
  // plus a post at each plan corner, so a car sliding along the house does
  // not catch on an invisible square corner. The top is the parapet a car
  // would land on.
  const o = BAND_PROUD;
  const cr = R + o;
  const cx = W / 2 - R;
  const cz = D / 2 - R;
  const out: ColliderSpec[] = [
    { shape: 'box', center: [0, PARAPET / 2, 0], half: [W / 2 + o, PARAPET / 2, cz] },
    { shape: 'box', center: [0, PARAPET / 2, 0], half: [cx, PARAPET / 2, D / 2 + o] },
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz): ColliderSpec => ({ shape: 'cylinder', base: [sx * cx, 0, sz * cz], height: PARAPET, radius: cr }))),
    flight(0, 0.34),
    flight(0.34, 0.67),
    flight(0.67, 1),
  ];
  if (c.barrel) out.push({ shape: 'cylinder', base: [BARREL_AT[0], 0, BARREL_AT[1]], height: 0.8, radius: 0.34 });
  for (const [x, z] of POTS_AT.slice(0, c.pots)) out.push({ shape: 'cylinder', base: [x, 0, z], height: 0.45, radius: 0.28 });
  return out;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b05-terrace-house',
  name: 'B05 Terrace House',
  category: 'building',
  size: { x: 5.34, y: 4.8, z: 6.41 },
  variants: 3,
  schemes: ['coastal', 'warm', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/houses/design-sheet.png',
    brief: 'design-documents/building-design-pack/houses/b05-terrace-house-brief.txt',
  },
  build,
  colliders,
};

export default asset;
