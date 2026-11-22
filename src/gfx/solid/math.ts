import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * Small vector / matrix vocabulary shared by the whole solid kit.
 *
 * CONVENTIONS (the same everywhere in `src/gfx/solid`):
 *  - Axes: +x right, +y up, +z forward. Meters.
 *  - ANGLES ARE DEGREES in every kit function (Babylon's own Matrix/Quaternion
 *    functions take radians — only use those through the helpers here).
 *  - Rotation sense, in coordinates: about X turns +y toward +z, about Y turns
 *    +z toward +x (a positive yaw turns the nose to the RIGHT), about Z turns
 *    +x toward +y.
 *  - Matrices are Babylon `Matrix` (row-vector convention: `a.multiply(b)`
 *    applies a FIRST, then b). Use `compose(a, b, c)` — applied left to right
 *    — and never think about it again.
 *  - Any function taking a point accepts a `Vector3` or an `[x, y, z]` tuple.
 */

/** A point or direction: Babylon Vector3 or an [x, y, z] tuple. */
export type Vec3 = Vector3 | readonly [number, number, number];

/** A 2D point [x, y] (ring / outline / profile coordinates). */
export type Vec2 = readonly [number, number];

export const DEG = Math.PI / 180;

/** Shorthand constructor. */
export function v3(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

/**
 * Normalise a `Vec3` to a Vector3. Returns the SAME instance when given a
 * Vector3 — clone before mutating.
 */
export function toV3(p: Vec3): Vector3 {
  return p instanceof Vector3 ? p : new Vector3(p[0], p[1], p[2]);
}

/** Convert a list of `Vec3` to fresh Vector3 instances (always copies). */
export function toV3s(points: readonly Vec3[]): Vector3[] {
  return points.map((p) => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2])));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Hermite 0..1 ramp between edge0 and edge1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Matrices

/** Translation matrix. */
export function translation(x: number | Vec3, y = 0, z = 0): Matrix {
  if (typeof x === 'number') return Matrix.Translation(x, y, z);
  const v = toV3(x);
  return Matrix.Translation(v.x, v.y, v.z);
}

/**
 * Rotation by `deg` DEGREES about a principal axis ('x' | 'y' | 'z') or an
 * arbitrary axis vector through the origin. Sense: see the file header
 * (about Y, positive turns +z toward +x).
 */
export function rotation(axis: 'x' | 'y' | 'z' | Vec3, deg: number): Matrix {
  const a = deg * DEG;
  if (axis === 'x') return Matrix.RotationX(a);
  if (axis === 'y') return Matrix.RotationY(a);
  if (axis === 'z') return Matrix.RotationZ(a);
  const v = toV3(axis).clone();
  v.normalize();
  return Matrix.RotationAxis(v, a);
}

/** Euler rotation in DEGREES: about X first, then Y, then Z (world axes). */
export function rotationXYZ(degX: number, degY: number, degZ: number): Matrix {
  return compose(rotation('x', degX), rotation('y', degY), rotation('z', degZ));
}

/** Scale matrix; one argument = uniform. Negative values mirror. */
export function scaling(sx: number, sy = sx, sz = sx): Matrix {
  return Matrix.Scaling(sx, sy, sz);
}

/** Mirror across the plane through the origin perpendicular to `axis`. */
export function mirroring(axis: 'x' | 'y' | 'z'): Matrix {
  return Matrix.Scaling(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1);
}

/**
 * Chain transforms in the order they are APPLIED: `compose(a, b, c)` moves a
 * point by a, then b, then c. (Hides Babylon's row-vector multiply order.)
 */
export function compose(...ms: Matrix[]): Matrix {
  let out = ms.length ? ms[0] : Matrix.Identity();
  for (let i = 1; i < ms.length; i++) out = out.multiply(ms[i]);
  return out;
}

/**
 * Rigid frame from three unit axes and an origin: local +x/+y/+z map onto
 * `xAxis`/`yAxis`/`zAxis`. Pass axes with xAxis = yAxis × zAxis for a proper
 * (non-mirroring) frame.
 */
export function frame(origin: Vec3, xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Matrix {
  const o = toV3(origin);
  const x = toV3(xAxis);
  const y = toV3(yAxis);
  const z = toV3(zAxis);
  return Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, o.x, o.y, o.z, 1);
}

/** A unit vector perpendicular to `d` (deterministic choice). */
export function anyPerpendicular(d: Vector3): Vector3 {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  // Seed with the world axis least aligned with d, then Gram-Schmidt.
  const r = ax <= ay && ax <= az ? new Vector3(1, 0, 0) : ay <= az ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const n = r.subtract(d.scale(Vector3.Dot(r, d)));
  n.normalize();
  return n;
}

/**
 * Rigid matrix that carries the local +Y axis onto the direction `from → to`
 * with the local origin at `from` (or at the midpoint when `centered`). This
 * is how +Y-axis shapes (cylinder, cone, capsule, revolve) are laid between
 * two points. `zHint` picks where local +z ends up (projected perpendicular
 * to the axis); by default a deterministic perpendicular is chosen.
 */
export function aim(from: Vec3, to: Vec3, centered = false, zHint?: Vec3): Matrix {
  const a = toV3(from);
  const b = toV3(to);
  const y = b.subtract(a);
  if (y.lengthSquared() < 1e-18) y.set(0, 1, 0);
  y.normalize();
  let z: Vector3 | null = null;
  if (zHint) {
    const h = toV3(zHint);
    z = h.subtract(y.scale(Vector3.Dot(h, y)));
    if (z.lengthSquared() < 1e-12) z = null;
    else z.normalize();
  }
  // An already-vertical axis keeps the identity frame, so `from/to` straight
  // up behaves exactly like the default +Y placement.
  if (!z && Math.abs(y.x) < 1e-9 && Math.abs(y.z) < 1e-9) z = new Vector3(0, 0, 1);
  if (!z) z = anyPerpendicular(y);
  const x = Vector3.Cross(y, z);
  const o = centered ? a.add(b).scale(0.5) : a;
  return frame(o, x, y, z);
}

// ---------------------------------------------------------------------------
// Placement — the optional `at` / `rot` every shape helper accepts.

/**
 * Where a shape goes. Shapes are authored around their local origin with
 * their main axis along +Y; a placement moves them:
 *  - `rot`: Euler DEGREES [x, y, z], applied about the local origin in the
 *    order X, then Y, then Z;
 *  - `at`: then a translation `[x, y, z]`, or a full `Matrix` (use `compose`,
 *    `aim`, `frame` to build one).
 */
export interface Placement {
  at?: Vec3 | Matrix;
  rot?: Vec3;
}

/** Resolve a Placement into one matrix, or null when it is the identity. */
export function placementMatrix(p: Placement | undefined): Matrix | null {
  if (!p || (p.at === undefined && p.rot === undefined)) return null;
  let m: Matrix | null = null;
  if (p.rot !== undefined) {
    const r = toV3(p.rot);
    m = rotationXYZ(r.x, r.y, r.z);
  }
  if (p.at !== undefined) {
    const t = p.at instanceof Matrix ? p.at : translation(p.at);
    m = m ? m.multiply(t) : t;
  }
  return m;
}

/** Transform a point by a matrix (new Vector3). */
export function applyMatrix(p: Vec3, m: Matrix): Vector3 {
  const v = toV3(p);
  const a = m.m;
  return new Vector3(
    v.x * a[0] + v.y * a[4] + v.z * a[8] + a[12],
    v.x * a[1] + v.y * a[5] + v.z * a[9] + a[13],
    v.x * a[2] + v.y * a[6] + v.z * a[10] + a[14],
  );
}
