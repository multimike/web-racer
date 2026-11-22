import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { aim, polygonFacing, quadFacing, toV3, triFacing } from '../../../gfx/solid';
import type { Paint, SolidMesh, Vec3 } from '../../../gfx/solid';

/**
 * Small solids the building parts are made of, beyond the kit's primitives.
 * They exist for TRIANGLE ECONOMY: a village building is dozens of beams,
 * planks and blocks, and a `roundedBox` (44–92 triangles) for each would eat
 * the 6 000 budget before the roof is on. These spend triangles only where a
 * bevel is seen.
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/**
 * Section of a moulding: a w × h rectangle with its four corners chamfered
 * by `c` — 8 points, counter-clockwise from the +x side. With a paint
 * softened to 45° it shades as a rounded section at two thirds of the
 * triangles of `roundedRectRing(w, h, r, 1)` (which also carries edge
 * midpoints).
 */
export function chamferRing(w: number, h: number, c: number): [number, number][] {
  const hw = w / 2;
  const hh = h / 2;
  const k = Math.max(0, Math.min(c, hw * 0.9, hh * 0.9));
  return [[hw, -hh + k], [hw, hh - k], [hw - k, hh], [-hw + k, hh], [-hw, hh - k], [-hw, -hh + k], [-hw + k, -hh], [hw - k, -hh]];
}

// ---------------------------------------------------------------------------
// Beam

export interface BeamOptions {
  from: Vec3;
  to: Vec3;
  /** Section: one number (square) or [w, d] with `d` measured along `side`. */
  size: number | readonly [number, number];
  /** Edge chamfer in meters (default 18 % of the thinner side). */
  chamfer?: number;
  /** Direction the section's `d` side points (projected square to the beam).
   * Give it for anything that lies ON a surface: the surface normal. */
  side?: Vec3;
  /** End caps (default both). Drop the ones buried in another part. */
  caps?: boolean | 'start' | 'end';
  /** Rings along the length (default: one every 2 m, and at least two
   * segments for anything longer than 1.2 m). Baked AO lives on vertices: a
   * beam with both ends buried and nothing between them bakes contact-dark
   * from end to end. */
  segments?: number;
  /** false = leave out the face on the far side from `side` and its two
   * chamfers — for timber lying ON a wall (gable framing, wall plates),
   * where that third of the beam is buried anyway. Default true. */
  back?: boolean;
}

/**
 * Timber between two points: a rectangular bar with its four long edges
 * chamfered (octagonal section, 16 triangles a segment + 6 a cap). The chamfers stay crisp —
 * they are what makes it read as sawn timber rather than a pipe.
 *   beam(m, { from: [-3, 2.8, -2.56], to: [3, 2.8, -2.56], size: [0.3, 0.14], side: [0, 0, -1] }, P.timber);
 * Sink the ends into whatever they join; never stop a beam on a surface.
 */
export function beam(m: SolidMesh, o: BeamOptions, p: Paint): void {
  const start = m.mark();
  const a = toV3(o.from);
  const b = toV3(o.to);
  const L = Vector3.Distance(a, b);
  if (L < 1e-6) return;
  const [w, d] = typeof o.size === 'number' ? [o.size, o.size] : o.size;
  const hw = w / 2;
  const hd = d / 2;
  const c = Math.max(0, Math.min(o.chamfer ?? Math.min(w, d) * 0.18, hw * 0.9, hd * 0.9));
  const ring: [number, number][] =
    c > 1e-6
      ? [[hw, -hd + c], [hw, hd - c], [hw - c, hd], [-hw + c, hd], [-hw, hd - c], [-hw, -hd + c], [-hw + c, -hd], [hw - c, -hd]]
      : [[hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
  const n = ring.length;
  const segs = Math.max(1, Math.round(o.segments ?? Math.max(L > 1.2 ? 2 : 1, Math.ceil(L / 2 - 1e-6))));
  // Faces 5, 6, 7 of the octagon are the back chamfer, back face, back chamfer.
  const skipBack = o.back === false && n === 8;
  for (let k = 0; k < segs; k++) {
    const y0 = (L * k) / segs;
    const y1 = (L * (k + 1)) / segs;
    for (let i = 0; i < n; i++) {
      if (skipBack && i >= 5) continue;
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % n];
      quadFacing(m, V(x0, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z0), V(x0 + x1, 0, z0 + z1), p);
    }
  }
  const caps = o.caps ?? true;
  if (caps === true || caps === 'start') polygonFacing(m, ring.map(([x, z]) => V(x, 0, z)), V(0, -1, 0), p);
  if (caps === true || caps === 'end') polygonFacing(m, ring.map(([x, z]) => V(x, L, z)), V(0, 1, 0), p);
  m.transform(aim(a, b, false, o.side), start);
}

// ---------------------------------------------------------------------------
// Pillow: a chamfered block seen from one side

export interface PillowOptions {
  /** Outline rectangle in the local XY plane. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Back plane (where it is buried) and front face, along local +Z. */
  z0: number;
  z1: number;
  chamfer: number;
  /** Lean of the two upright joints: the top corners move this far in x
   * (irregular masonry). [left, right], default [0, 0]. */
  skew?: readonly [number, number];
  /** Extra depth of the four FRONT corners (bottom-left, bottom-right,
   * top-right, top-left): a few centimeters each makes the face a pair of
   * subtle facets instead of a machined plane. */
  dent?: readonly [number, number, number, number];
  /** Push the middle of the front face out by this much: the face becomes
   * four facets round a centre point and, with a smooth paint, shades like
   * a cushion (rough-dressed stone). Default 0 = flat. */
  bulge?: number;
  /** Sides to leave out because they are buried (default: none). */
  omit?: readonly ('top' | 'bottom' | 'left' | 'right')[];
}

/**
 * A block with a chamfered FRONT (toward local +z) and no back: front face,
 * four chamfers, four sides — 18 triangles (20 with `bulge`). Stone plinth blocks, door
 * panels, quoin faces. Built in local XY; place it with `m.transform`.
 */
export function pillow(m: SolidMesh, o: PillowOptions, p: Paint): void {
  const c = Math.max(0, Math.min(o.chamfer, (o.x1 - o.x0) * 0.45, (o.y1 - o.y0) * 0.45, (o.z1 - o.z0) * 0.9));
  const [sl, sr] = o.skew ?? [0, 0];
  const dent = o.dent ?? [0, 0, 0, 0];
  // Corners in order bottom-left, bottom-right, top-right, top-left.
  const X = [o.x0, o.x1, o.x1 + sr, o.x0 + sl];
  const Y = [o.y0, o.y0, o.y1, o.y1];
  const IX = [c, -c, -c, c];
  const IY = [c, c, -c, -c];
  const A = X.map((x, k) => V(x, Y[k], o.z0));
  const B = X.map((x, k) => V(x, Y[k], o.z1 - c));
  const C = X.map((x, k) => V(x + IX[k], Y[k] + IY[k], o.z1 + dent[k]));
  const names = ['bottom', 'right', 'top', 'left'] as const;
  const out = [V(0, -1, 0), V(1, 0, 0), V(0, 1, 0), V(-1, 0, 0)];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    if (!o.omit?.includes(names[k])) quadFacing(m, A[k], A[j], B[j], B[k], out[k], p);
    if (c > 1e-6) quadFacing(m, B[k], B[j], C[j], C[k], out[k].add(V(0, 0, 1)), p);
  }
  if (o.bulge) {
    const mid = C[0].add(C[1]).add(C[2]).add(C[3]).scale(0.25).add(V(0, 0, o.bulge));
    for (let k = 0; k < 4; k++) triFacing(m, C[k], C[(k + 1) % 4], mid, V(0, 0, 1), p);
  } else {
    quadFacing(m, C[0], C[1], C[2], C[3], V(0, 0, 1), p);
  }
}

// ---------------------------------------------------------------------------
// Plank panel

export interface PlankPanelOptions {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  /** Number of boards. */
  planks: number;
  /** Depth = half-width of the V-groove between boards (default 0.012). */
  groove?: number;
  /** Boards run left-right instead of up-down. */
  horizontal?: boolean;
  /** Width of the bevel round the panel's own perimeter (default = groove).
   * A leaf that is LARGER than its opening (a door: its rim is buried in the
   * wall) sets this so that the board faces end inside the opening — see
   * the AO note below. */
  edge?: number;
  /** Stations along the boards (default one every 0.9 m). */
  rows?: number;
  /** The rim from the bevel down to `z0` round the perimeter (default true;
   * false for a leaf whose perimeter is buried). */
  rim?: boolean;
}

/**
 * A boarded leaf — door, shutter, hatch, crate side — as ONE welded surface:
 * each board has its own slightly raised face and the boards meet in real
 * V-grooves, without the hidden faces a row of separate boxes would carry.
 * Front toward local +z, no back.
 *
 * AO: every vertex of a board FACE must be in the open. A board that is one
 * quad whose four corners are all buried in the wall or the step bakes from
 * four contact-line guesses, and neighbouring boards come out alternately
 * white and grey. Hence `edge` (faces end inside the opening) and `rows`
 * (vertices along the board carry the gradient).
 */
export function plankPanel(m: SolidMesh, o: PlankPanelOptions, p: Paint): void {
  const n = Math.max(1, Math.round(o.planks));
  const horizontal = o.horizontal ?? false;
  // Work in (a, b): a across the boards, b along them.
  const a0 = horizontal ? o.y0 : o.x0;
  const a1 = horizontal ? o.y1 : o.x1;
  const b0 = horizontal ? o.x0 : o.y0;
  const b1 = horizontal ? o.x1 : o.y1;
  const step = (a1 - a0) / n;
  const g = Math.max(0, Math.min(o.groove ?? 0.012, step * 0.3, (o.z1 - o.z0) * 0.8));
  const e = Math.max(g, Math.min(o.edge ?? g, step * 0.45, (b1 - b0) * 0.2));
  const rows = Math.max(1, Math.round(o.rows ?? (b1 - b0) / 0.9));
  const P = (a: number, b: number, z: number): Vector3 => (horizontal ? V(b, a, z) : V(a, b, z));
  // Directions swap the same way as points.
  const D = P;
  const zg = o.z1 - g;
  // Stations along the boards: on the faces, and on the groove lines (which
  // run out to the panel's own corners — the mitre of the end bevels).
  const fb = Array.from({ length: rows + 1 }, (_, k) => b0 + e + ((b1 - b0 - 2 * e) * k) / rows);
  const gb = fb.map((b, k) => (k === 0 ? b0 : k === rows ? b1 : b));
  const rim = o.rim ?? true;
  for (let i = 0; i < n; i++) {
    const l = a0 + i * step;
    const r = l + step;
    const fl = i === 0 ? a0 + e : l + g;
    const fr = i === n - 1 ? a1 - e : r - g;
    for (let k = 0; k < rows; k++) {
      // Board face and its two long bevels down to the groove lines.
      quadFacing(m, P(fl, fb[k], o.z1), P(fr, fb[k], o.z1), P(fr, fb[k + 1], o.z1), P(fl, fb[k + 1], o.z1), V(0, 0, 1), p);
      quadFacing(m, P(l, gb[k], zg), P(fl, fb[k], o.z1), P(fl, fb[k + 1], o.z1), P(l, gb[k + 1], zg), D(-1, 0, 1), p);
      quadFacing(m, P(r, gb[k], zg), P(fr, fb[k], o.z1), P(fr, fb[k + 1], o.z1), P(r, gb[k + 1], zg), D(1, 0, 1), p);
    }
    // End bevels.
    quadFacing(m, P(l, b0, zg), P(r, b0, zg), P(fr, fb[0], o.z1), P(fl, fb[0], o.z1), D(0, -1, 1), p);
    quadFacing(m, P(l, b1, zg), P(r, b1, zg), P(fr, fb[rows], o.z1), P(fl, fb[rows], o.z1), D(0, 1, 1), p);
    if (rim) {
      quadFacing(m, P(l, b0, o.z0), P(r, b0, o.z0), P(r, b0, zg), P(l, b0, zg), D(0, -1, 0), p);
      quadFacing(m, P(l, b1, o.z0), P(r, b1, o.z0), P(r, b1, zg), P(l, b1, zg), D(0, 1, 0), p);
    }
  }
  if (rim) {
    for (let k = 0; k < rows; k++) {
      quadFacing(m, P(a0, gb[k], o.z0), P(a0, gb[k + 1], o.z0), P(a0, gb[k + 1], zg), P(a0, gb[k], zg), D(-1, 0, 0), p);
      quadFacing(m, P(a1, gb[k], o.z0), P(a1, gb[k + 1], o.z0), P(a1, gb[k + 1], zg), P(a1, gb[k], zg), D(1, 0, 0), p);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame ring

export interface FrameRingOptions {
  /** The frame's inner and outer outline in local XY: both counter-clockwise,
   * the SAME number of points, point i of one opposite point i of the other
   * (`openingRing(…, { uniform })` makes such pairs). */
  inner: readonly (readonly [number, number])[];
  outer: readonly (readonly [number, number])[];
  /** Back plane (buried) and front face, along local +z. */
  z0: number;
  z1: number;
  /** Chamfer of the two front rims (default 0). */
  bevel?: number;
}

/**
 * A raised frame between two matching outlines — door and window surrounds,
 * glazing frames, vent surrounds: inner wall, chamfer, flat front, chamfer,
 * outer wall (10 triangles a point), no back. Built as quad strips between
 * the two rings, so it needs no polygon-with-hole triangulation (which the
 * kit's `extrudePolygon` gets wrong for some frame sizes: a triangle of the
 * front face lands across the hole).
 */
export function frameRing(m: SolidMesh, o: FrameRingOptions, p: Paint): void {
  const n = Math.min(o.inner.length, o.outer.length);
  if (n < 3) return;
  const bevel = Math.max(0, Math.min(o.bevel ?? 0, (o.z1 - o.z0) * 0.9));
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += o.inner[i][0] / n;
    cy += o.inner[i][1] / n;
  }
  // Front-face points: each rim moved `bevel` toward the other ring.
  const fi: [number, number][] = [];
  const fo: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const dx = o.outer[i][0] - o.inner[i][0];
    const dy = o.outer[i][1] - o.inner[i][1];
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(bevel, len * 0.4) / len;
    fi.push([o.inner[i][0] + dx * k, o.inner[i][1] + dy * k]);
    fo.push([o.outer[i][0] - dx * k, o.outer[i][1] - dy * k]);
  }
  const zb = o.z1 - bevel;
  const same = (a: Vector3, b: Vector3): boolean => Vector3.DistanceSquared(a, b) < 1e-12;
  // A quad, or the triangle left of it where two of its corners coincide (a
  // square corner of one ring opposite a rounded corner of the other).
  const face = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, dir: Vector3): void => {
    if (same(a, b)) {
      if (!same(c, d)) triFacing(m, a, c, d, dir, p);
    } else if (same(c, d)) triFacing(m, a, b, c, dir, p);
    else quadFacing(m, a, b, c, d, dir, p);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mid = V((o.outer[i][0] + o.outer[j][0]) / 2 - cx, (o.outer[i][1] + o.outer[j][1]) / 2 - cy, 0);
    const out = mid.lengthSquared() > 1e-12 ? mid.normalize() : V(1, 0, 0);
    const inn = out.scale(-1);
    const P3 = (q: readonly [number, number], z: number): Vector3 => V(q[0], q[1], z);
    face(P3(o.inner[i], o.z0), P3(o.inner[j], o.z0), P3(o.inner[j], zb), P3(o.inner[i], zb), inn);
    face(P3(o.outer[i], o.z0), P3(o.outer[j], o.z0), P3(o.outer[j], zb), P3(o.outer[i], zb), out);
    if (bevel > 1e-6) {
      face(P3(o.inner[i], zb), P3(o.inner[j], zb), P3(fi[j], o.z1), P3(fi[i], o.z1), inn.add(V(0, 0, 1)));
      face(P3(o.outer[i], zb), P3(o.outer[j], zb), P3(fo[j], o.z1), P3(fo[i], o.z1), out.add(V(0, 0, 1)));
    }
    face(P3(fi[i], o.z1), P3(fi[j], o.z1), P3(fo[j], o.z1), P3(fo[i], o.z1), V(0, 0, 1));
  }
}

// ---------------------------------------------------------------------------
// Rib

export interface RibOptions {
  /** Base width, top width (default 60 % of the base) and height. */
  width: number;
  topWidth?: number;
  height: number;
  /** How far the base sits below the surface (default 5 mm) so it never floats. */
  sink?: number;
  /** Close the ends (default: end only — the start is usually under a ridge cap). */
  capStart?: boolean;
  capEnd?: boolean;
  /** Add a ring of vertices this far from `a`. A seam that starts under a
   * ridge roll bakes its contact shadow from there to its far end otherwise. */
  breakAt?: number;
}

/**
 * A raised rib from `a` to `b` on a surface with unit normal `normal`:
 * standing roof seams, panel ribs, awning battens. Trapezoid section, open
 * underneath — 8 triangles with one end cap (14 with `breakAt`).
 */
export function rib(m: SolidMesh, a: Vec3, b: Vec3, normal: Vec3, o: RibOptions, p: Paint): void {
  const A = toV3(a);
  const B = toV3(b);
  const n = toV3(normal).clone().normalize();
  const along = B.subtract(A);
  if (along.lengthSquared() < 1e-10) return;
  along.normalize();
  const side = Vector3.Cross(along, n).normalize();
  const hb = o.width / 2;
  const ht = (o.topWidth ?? o.width * 0.6) / 2;
  const sink = o.sink ?? 0.005;
  const at = (q: Vector3, s: number, h: number): Vector3 => q.add(side.scale(s)).add(n.scale(h));
  const ring = (q: Vector3): [Vector3, Vector3, Vector3, Vector3] => [at(q, -hb, -sink), at(q, -ht, o.height), at(q, ht, o.height), at(q, hb, -sink)];
  const length = Vector3.Distance(A, B);
  const stations = [ring(A)];
  if (o.breakAt !== undefined && o.breakAt > 0.02 && o.breakAt < length - 0.02) stations.push(ring(A.add(along.scale(o.breakAt))));
  stations.push(ring(B));
  for (let i = 0; i + 1 < stations.length; i++) {
    const [a0, a1, a2, a3] = stations[i];
    const [b0, b1, b2, b3] = stations[i + 1];
    quadFacing(m, a0, b0, b1, a1, side.scale(-1), p);
    quadFacing(m, a1, b1, b2, a2, n, p);
    quadFacing(m, a2, b2, b3, a3, side, p);
  }
  const [a0, a1, a2, a3] = stations[0];
  const [b0, b1, b2, b3] = stations[stations.length - 1];
  if (o.capStart ?? false) quadFacing(m, a0, a1, a2, a3, along.scale(-1), p);
  if (o.capEnd ?? true) quadFacing(m, b0, b1, b2, b3, along, p);
}
