import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Cage, SolidMesh, cylinder, extrudePolygon, filletRing, paint, paintDecal, polygonFacing, quadFacing, roundedBox } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { CHARCOAL, addBolt } from '../parts';
import { NOSE_TIP_Z } from './layout';
import type { Paints } from './layout';

/**
 * NOSE SHELL — the wasp's sting: one closed, inflated wedge from the tip
 * back to the dashboard. Ahead of the front clip it is a faceted beak — a
 * top plane, and a broad yellow flank either side that slopes out and down
 * to a low edge chine, with the head lamp set into it; from there back the
 * belly sweeps up steeply and the shell thins into the hood, whose rear half
 * carries the recessed louvre panel. The tube frame and the wishbones run in
 * the open under the hood, as on the sheet: the nose is a cover, not a body.
 */

/**
 * Cross-section stations, tip → dashboard:
 * [z, ridge y, shoulder x, shoulder y, edge x, edge y, keel y].
 * The section is a kite: a nearly flat top plane rising to a shallow ridge,
 * a crisp shoulder chine, the FLANK sloping out and down (about 60° from
 * the ground, and turned forward by the taper, so the front view shows it as
 * the sheet's broad V with the lamps in its lower half) to the edge chine,
 * then a near-flat chin back in to the keel. The lab's clearance check
 * counts the whole body against the spec's 0.30 m (pass ≥ 0.28), so the
 * keel holds at 0.283 under the sting even though the sheet droops the tip
 * lower. Behind the beak the edge chine rises steeply — the front lower
 * wishbones pivot just under it at z ≈ 1.29 — and the section thins into
 * the hood over the clip's upper rails (y 0.54, x 0.205).
 */
const STATIONS: [number, number, number, number, number, number, number][] = [
  [NOSE_TIP_Z, 0.298, 0.006, 0.294, 0.009, 0.287, 0.283],
  [1.66, 0.35, 0.03, 0.338, 0.06, 0.294, 0.284],
  [1.54, 0.425, 0.062, 0.406, 0.132, 0.302, 0.286],
  [1.42, 0.5, 0.095, 0.476, 0.192, 0.322, 0.292],
  [1.32, 0.56, 0.124, 0.534, 0.226, 0.37, 0.333],
  [1.24, 0.605, 0.152, 0.58, 0.236, 0.45, 0.425],
  [1.16, 0.65, 0.184, 0.627, 0.205, 0.6, 0.59],
  [1.06, 0.7, 0.222, 0.676, 0.226, 0.656, 0.648],
  [0.94, 0.755, 0.256, 0.729, 0.259, 0.711, 0.703],
  [0.8, 0.806, 0.288, 0.778, 0.291, 0.758, 0.75],
  [0.66, 0.845, 0.315, 0.817, 0.318, 0.795, 0.787],
  [0.52, 0.868, 0.334, 0.84, 0.337, 0.815, 0.806],
];

interface Section {
  z: number;
  top: number;
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  k: number;
}

/** The nose's section at any z (linear between stations). */
function noseSection(z: number): Section {
  const S = STATIONS;
  let i = 0;
  while (i + 2 < S.length && S[i + 1][0] > z) i++;
  const a = S[i];
  const b = S[i + 1];
  const t = Math.min(1, Math.max(0, (a[0] - z) / (a[0] - b[0])));
  const mix = (j: number): number => a[j] + (b[j] - a[j]) * t;
  return { z, top: mix(1), sx: mix(2), sy: mix(3), ex: mix(4), ey: mix(5), k: mix(6) };
}

/** A point on the right flank: `v` 0 = shoulder chine … 1 = edge chine. */
function flankPoint(z: number, v: number): Vector3 {
  const c = noseSection(z);
  return Vector3.Lerp(new Vector3(c.sx, c.sy, z), new Vector3(c.ex, c.ey, z), v);
}

/** Slant height of the flank, shoulder → edge, at z. */
function flankHeight(z: number): number {
  return Vector3.Distance(flankPoint(z, 0), flankPoint(z, 1));
}

/** Outward normal of the right flank at (z, v). */
function flankNormal(z: number, v: number): Vector3 {
  const along = flankPoint(z + 0.03, v).subtract(flankPoint(z - 0.03, v));
  const down = flankPoint(z, Math.min(1, v + 0.1)).subtract(flankPoint(z, Math.max(0, v - 0.1)));
  const n = Vector3.Cross(along, down).normalize();
  return n.x < 0 ? n.scaleInPlace(-1) : n;
}

/** Offset a convex 2D outline (either winding) outward by `d` — mitred. */
function offsetOutline(pts: readonly Vec2[], d: number): Vec2[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const s = area > 0 ? 1 : -1;
  const edgeN = (a: Vec2, b: Vec2): Vec2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(s * (b[1] - a[1])) / l, (-s * (b[0] - a[0])) / l];
  };
  return pts.map((p, i) => {
    const n0 = edgeN(pts[(i + n - 1) % n], p);
    const n1 = edgeN(p, pts[(i + 1) % n]);
    const bx = n0[0] + n1[0];
    const by = n0[1] + n1[1];
    const k = Math.max(0.3, (bx * bx + by * by) / 2);
    return [p[0] + (bx / k) * d, p[1] + (by / k) * d] as Vec2;
  });
}

/**
 * A plate let into the right flank, its outline drawn ON the flank in
 * (z, v) — z along the car, v 0 = shoulder chine … 1 = edge chine — so it
 * keeps its margins to both chines however the flank tapers toward the tip.
 * `grow` (m) enlarges the outline (a bezel round a lens). The top stands
 * `lift` proud of the flank with a `bevel` round its rim; the body runs
 * 18 mm into the shell. Convex outlines only.
 */
function flankPlate(m: SolidMesh, outline: readonly Vec2[], o: { lift: number; bevel: number; grow?: number }, p: Paint): void {
  // Work in metres on the flank: (z, v·h) with h the flank height at the
  // outline's middle, then back to (z, v).
  const zc = outline.reduce((a, q) => a + q[0], 0) / outline.length;
  const vc = outline.reduce((a, q) => a + q[1], 0) / outline.length;
  const h = flankHeight(zc);
  const metric = outline.map(([z, v]) => [z, v * h] as Vec2);
  const toZV = (pts: Vec2[]): Vec2[] => pts.map(([z, s]) => [z, s / h] as Vec2);
  const outer = toZV(o.grow ? offsetOutline(metric, o.grow) : metric);
  const inner = o.bevel > 0 ? toZV(offsetOutline(o.grow ? offsetOutline(metric, o.grow) : metric, -o.bevel)) : outer;
  const at = (q: Vec2, d: number): Vector3 => flankPoint(q[0], q[1]).add(flankNormal(q[0], q[1]).scale(d));
  const top = inner.map((q) => at(q, o.lift));
  const rim = outer.map((q) => at(q, o.lift - o.bevel));
  const bot = outer.map((q) => at(q, -0.018));
  const n0 = flankNormal(zc, vc);
  const centre = bot.reduce((a, q) => a.add(q), Vector3.Zero()).scale(1 / bot.length);
  polygonFacing(m, top, n0, p);
  polygonFacing(m, bot, n0.scale(-1), p);
  const k = outer.length;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const out = rim[i].add(rim[j]).scale(0.5).subtract(centre);
    out.subtractInPlace(n0.scale(Vector3.Dot(out, n0))).normalize();
    if (o.bevel > 0) quadFacing(m, top[i], top[j], rim[j], rim[i], out.add(n0).normalize(), p);
    quadFacing(m, rim[i], rim[j], bot[j], bot[i], out, p);
  }
}

/** Head-lamp lens, on the flank in (z, v): a slanted blade pointing at the
 * sting — the wasp's eye — with yellow above, ahead and below it. */
const LENS: Vec2[] = [
  [1.34, 0.2],
  [1.515, 0.19],
  [1.585, 0.35],
  [1.53, 0.5],
  [1.35, 0.52],
];
/** The dark intake slot under it, following the edge chine toward the tip,
 * a yellow lip left below it. */
const INTAKE: Vec2[] = [
  [1.33, 0.6],
  [1.545, 0.6],
  [1.655, 0.7],
  [1.55, 0.79],
  [1.335, 0.8],
];

/** Height of the topmost up-facing surface of `m` (triangles `from`…`to`)
 * over the plan point (x, z) — where a recess cut at that point meets it. */
function surfaceY(m: SolidMesh, from: number, to: number, x: number, z: number): number {
  const P = m.positions;
  let best = -Infinity;
  for (let t = from; t < to; t++) {
    const o = t * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
    const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / d;
    const v = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / d;
    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
    best = Math.max(best, ay + (by - ay) * u + (cy - ay) * v);
  }
  return best;
}

/**
 * A recessed panel let into the shell's top: cuts the outline (a top view,
 * [x, z]) out of the shell and closes the hole with a thin cup — a yellow
 * return wall down to a dark floor `depth` below the surface, its lip rolled
 * a hair over the cut edge so no seam shows. One closed solid, all faces
 * outward. Returns the floor height at each outline point.
 */
function recess(m: SolidMesh, shellFrom: number, shellTo: number, outline: readonly Vec2[], depth: number, wall: Paint, floor: Paint): void {
  // Densify the outline so the lip follows the hood's crown.
  const pts: Vec2[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.03));
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const out = (p: Vec2, d: number): Vec2 => {
    const l = Math.hypot(p[0] - cx, p[1] - cz) || 1;
    return [p[0] + ((p[0] - cx) / l) * d, p[1] + ((p[1] - cz) / l) * d];
  };
  const T: Vector3[] = [];
  const O: Vector3[] = [];
  const B: Vector3[] = [];
  const F: Vector3[] = [];
  for (const p of pts) {
    const y = surfaceY(m, shellFrom, shellTo, p[0], p[1]);
    const q = out(p, 0.014);
    const yq = surfaceY(m, shellFrom, shellTo, q[0], q[1]);
    T.push(new Vector3(p[0], y + 0.0015, p[1]));
    O.push(new Vector3(q[0], (Number.isFinite(yq) ? yq : y) - 0.004, q[1]));
    B.push(new Vector3(q[0], y - depth - 0.012, q[1]));
    F.push(new Vector3(p[0], y - depth, p[1]));
  }
  paintDecal(m, { outline, facing: '+y', maxAngle: 60, only: (_c, n) => n.y > 0.4, from: shellFrom }, null);
  const n = pts.length;
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mid = T[i].add(T[j]).scale(0.5);
    const outward = new Vector3(mid.x - cx, 0, mid.z - cz).normalize();
    quadFacing(m, T[i], T[j], O[j], O[i], up, wall);
    quadFacing(m, T[i], T[j], F[j], F[i], outward.scale(-1), wall);
    quadFacing(m, O[i], O[j], B[j], B[i], outward, wall);
  }
  polygonFacing(m, F, up, floor);
  polygonFacing(m, B, up.scale(-1), floor);
}

export function addNose(m: SolidMesh, P: Paints): void {
  const { BODY, BODY_IN, GLOW, GLOW_CORE } = P;
  const start = m.mark();

  // --- the shell ----------------------------------------------------------
  // Flat facets with thick soft edges, the way the sheet folds this nose: a
  // support loop either side of every feature line (ridge, shoulder, edge,
  // keel) holds the faces flat, and one Catmull-Clark level rounds the lines
  // themselves to about `BEVEL`.
  const BEVEL = 0.011;
  const cage = new Cage();
  const col: number[][] = [];
  for (const [z] of STATIONS) {
    const c = noseSection(z);
    const C = new Vector3(0, c.top, z);
    const S = new Vector3(c.sx, c.sy, z);
    const E = new Vector3(c.ex, c.ey, z);
    const K = new Vector3(0, c.k, z);
    const toward = (from: Vector3, to: Vector3): Vector3 => Vector3.Lerp(from, to, Math.min(0.4, BEVEL / Math.max(Vector3.Distance(from, to), 1e-6)));
    col.push(cage.vertices([C, toward(C, S), toward(S, C), S, toward(S, E), toward(E, S), E, toward(E, K), toward(K, E), K]));
  }
  const strips = col[0].length - 1;
  for (let i = 0; i + 1 < col.length; i++) {
    for (let j = 0; j < strips; j++) cage.face([col[i][j], col[i][j + 1], col[i + 1][j + 1], col[i + 1][j]], BODY);
  }
  const last = col.length - 1;
  cage.face(col[0], BODY);
  cage.face(col[last].slice().reverse(), BODY);
  cage.mirror('x');
  cage.emit(m, { levels: 1 });
  // The underside of the hood is finished, but duller.
  m.repaint((c, n, p) => (p === BODY && n.y < -0.55 && c.z < 1.2 ? BODY_IN : undefined), start);
  const shellEnd = m.mark();

  // --- louvre panel let into the hood, ahead of the dashboard --------------
  // A dark V sunk 14 mm below the yellow with a short yellow return wall
  // round it, its slats below hood level — the concept's inset vent.
  const VENT = paint(CHARCOAL, { gloss: 0.35, smooth: 50 });
  const DEPTH = 0.014;
  // A top view: [x, z].
  const vent: Vec2[] = [
    [0, 0.98],
    [-0.2, 0.75],
    [-0.222, 0.575],
    [0.222, 0.575],
    [0.2, 0.75],
  ];
  const floorY = (x: number, z: number): number => surfaceY(m, start, shellEnd, x, z) - DEPTH;
  const slatYs: [number, number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const z = 0.62 + i * 0.072;
    const half = Math.max(0.03, 0.196 - Math.max(0, z - 0.75) * 0.82) - 0.012;
    const slope = (floorY(0, z - 0.03) - floorY(0, z + 0.03)) / 0.06;
    slatYs.push([z, half, slope]);
  }
  const floorAt = slatYs.map(([z]) => floorY(0, z));
  recess(m, start, shellEnd, vent, DEPTH, BODY, VENT);
  const SLAT = paint('#4A4B55', { gloss: 0.45 });
  slatYs.forEach(([z, half, slope], i) => {
    // Tipped up at the back like a real louvre; stands on the floor, its
    // top a few millimetres under the hood surface.
    roundedBox(m, { size: [half * 2, 0.011, 0.034], radius: 0.004, segments: 1, rot: [(-Math.atan(slope) * 180) / Math.PI - 16, 0, 0], at: [0, floorAt[i] + 0.004, z] }, SLAT);
  });

  // --- head lamps and the intake under them ------------------------------
  // Each lamp is a glowing lens let into the yellow flank inside a thin
  // dark bezel (8 mm), with yellow showing above, ahead and below it; under
  // it a dark intake slot with slats — the two tiers of the sheet's flank.
  const SOCKET = paint('#26262D', { gloss: 0.5, smooth: 50 });
  const SLOT = paint('#1E1E24', { gloss: 0.3, smooth: 50 });
  const flank = new SolidMesh();
  // The bezel stands 2 mm proud of the flank, the lens 4 mm.
  flankPlate(flank, LENS, { lift: 0.002, bevel: 0.0015, grow: 0.008 }, SOCKET);
  flankPlate(flank, LENS, { lift: 0.0045, bevel: 0.003 }, GLOW);
  const on = (z: number, v: number, d: number): Vector3 => flankPoint(z, v).add(flankNormal(z, v).scale(d));
  // The bulb: a thin hot strip along the lens (small faces only — a broad
  // face this bright clips to a blank patch).
  cylinder(flank, { from: on(1.375, 0.37, 0.003), to: on(1.535, 0.345, 0.003), radius: 0.0045, sides: 6 }, GLOW_CORE);
  flankPlate(flank, INTAKE, { lift: 0.0015, bevel: 0.0015 }, SLOT);
  // Two slats along the slot, standing a hair proud of it.
  for (const v of [0.665, 0.74]) cylinder(flank, { from: on(1.35, v, 0.0), to: on(1.56 - (v - 0.665) * 0.6, v, 0.0), radius: 0.0042, sides: 6 }, CHARCOAL);
  flank.mirrorCopy('x');
  m.append(flank);

  // --- cockpit coaming: the hood's two prongs run on past the dashboard ----
  // Flat pointed plates continuing the hood's shoulders, a small step down.
  for (const s of [-1, 1]) {
    const prong: Vec2[] = [
      [0.232, 0.62],
      [0.33, 0.64],
      [0.352, 0.42],
      [0.33, 0.27],
      [0.262, 0.36],
    ];
    // '+y': a top view, [x, z]; the plate grows upward from `at`.
    extrudePolygon(
      m,
      { outline: filletRing(prong.map(([x, z]) => [s * x, z] as Vec2), 0.016, 2), depth: 0.045, bevel: 0.007, bevelSegments: 1, bevelBack: true, facing: '+y', rot: [0, 0, s * -5], at: [0, 0.762, 0] },
      BODY,
    );
    addBolt(m, { at: [s * 0.31, 0.784, 0.37], normal: [s * 0.09, 1, 0], radius: 0.011 });
    const hood = noseSection(0.8);
    addBolt(m, { at: [s * 0.245, hood.top + (hood.sy - hood.top) * (0.245 / hood.sx), 0.8], normal: [s * 0.1, 0.97, 0.22], radius: 0.011 });
  }
}
