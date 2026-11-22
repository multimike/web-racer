import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, anyPerpendicular, toV3, toV3s } from './math';
import type { Vec2, Vec3 } from './math';

/**
 * Path builders and samplers: polylines in 3D (`Vector3[]`) for `tube`,
 * `sweep` and hand placement, plus 2D fillets for profiles and outlines.
 * Angles are DEGREES. All functions return NEW arrays of NEW vectors.
 */

/** Total length of a polyline (adds the closing edge when `closed`). */
export function pathLength(points: readonly Vec3[], closed = false): number {
  const p = points.map(toV3);
  let len = 0;
  for (let i = 0; i + 1 < p.length; i++) len += Vector3.Distance(p[i], p[i + 1]);
  if (closed && p.length > 1) len += Vector3.Distance(p[p.length - 1], p[0]);
  return len;
}

/**
 * Resample a polyline to `count` points evenly spaced by arc length. Open:
 * first and last points are kept (count ≥ 2). Closed: `count` points starting
 * at points[0], the closing point is not repeated.
 */
export function resamplePath(points: readonly Vec3[], count: number, closed = false): Vector3[] {
  const p = toV3s(points);
  if (p.length < 2) return p;
  const src = closed ? [...p, p[0]] : p;
  const cum: number[] = [0];
  for (let i = 0; i + 1 < src.length; i++) cum.push(cum[i] + Vector3.Distance(src[i], src[i + 1]));
  const total = cum[cum.length - 1];
  const out: Vector3[] = [];
  const n = closed ? count : count - 1;
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = n > 0 ? (total * k) / n : 0;
    while (seg < src.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? (d - cum[seg]) / span : 0;
    out.push(Vector3.Lerp(src[seg], src[seg + 1], Math.min(Math.max(t, 0), 1)));
  }
  return out;
}

/** Straight line a→b as `segments` + 1 points. */
export function linePath(a: Vec3, b: Vec3, segments = 1): Vector3[] {
  const A = toV3(a);
  const B = toV3(b);
  segments = Math.max(1, Math.round(segments));
  const out: Vector3[] = [];
  for (let i = 0; i <= segments; i++) out.push(Vector3.Lerp(A, B, i / segments));
  return out;
}

/** Cubic Bézier p0 → p3 with control points p1, p2; `segments` + 1 points. */
export function bezierPath(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, segments = 12): Vector3[] {
  const a = toV3(p0);
  const b = toV3(p1);
  const c = toV3(p2);
  const d = toV3(p3);
  const out: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const k0 = u * u * u;
    const k1 = 3 * u * u * t;
    const k2 = 3 * u * t * t;
    const k3 = t * t * t;
    out.push(
      new Vector3(
        a.x * k0 + b.x * k1 + c.x * k2 + d.x * k3,
        a.y * k0 + b.y * k1 + c.y * k2 + d.y * k3,
        a.z * k0 + b.z * k1 + c.z * k2 + d.z * k3,
      ),
    );
  }
  return out;
}

/** Quadratic Bézier p0 → p2 with one control point; `segments` + 1 points. */
export function quadraticBezierPath(p0: Vec3, p1: Vec3, p2: Vec3, segments = 10): Vector3[] {
  const a = toV3(p0);
  const b = toV3(p1);
  const c = toV3(p2);
  const out: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push(
      new Vector3(
        a.x * u * u + 2 * b.x * u * t + c.x * t * t,
        a.y * u * u + 2 * b.y * u * t + c.y * t * t,
        a.z * u * u + 2 * b.z * u * t + c.z * t * t,
      ),
    );
  }
  return out;
}

/**
 * One point on a Catmull-Rom span p1 → p2 (neighbours p0, p3) with explicit
 * knot intervals d01, d12, d23 (Barry–Goldman form; pass chord lengths^0.5
 * for the centripetal curve that never loops or overshoots at uneven
 * spacing). `s` runs 0..1 across the span.
 */
export function catmullRomPoint(
  p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3,
  d01: number, d12: number, d23: number,
  s: number,
): Vector3 {
  const e = 1e-9;
  const t0 = 0;
  const t1 = t0 + Math.max(d01, e);
  const t2 = t1 + Math.max(d12, e);
  const t3 = t2 + Math.max(d23, e);
  const t = t1 + (t2 - t1) * s;
  const mixv = (a: Vector3, b: Vector3, ta: number, tb: number): Vector3 => {
    const k = (t - ta) / (tb - ta);
    return new Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  };
  const a1 = mixv(p0, p1, t0, t1);
  const a2 = mixv(p1, p2, t1, t2);
  const a3 = mixv(p2, p3, t2, t3);
  const b1 = mixv(a1, a2, t0, t2);
  const b2 = mixv(a2, a3, t1, t3);
  return mixv(b1, b2, t1, t2);
}

/**
 * Smooth curve THROUGH the given points (centripetal Catmull-Rom).
 * `samples` = segments per span between consecutive points. Open: returns
 * (points − 1) × samples + 1 points; closed: points × samples, not repeating
 * the first.
 */
export function catmullRomPath(points: readonly Vec3[], samples = 8, closed = false): Vector3[] {
  const p = toV3s(points);
  const n = p.length;
  if (n < 3) return n === 2 ? linePath(p[0], p[1], samples) : p;
  const at = (i: number): Vector3 => {
    if (closed) return p[((i % n) + n) % n];
    // Reflected phantom end points = natural end tangents.
    if (i < 0) return p[0].scale(2).subtract(p[1]);
    if (i >= n) return p[n - 1].scale(2).subtract(p[n - 2]);
    return p[i];
  };
  const out: Vector3[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const d01 = Math.sqrt(Vector3.Distance(p0, p1));
    const d12 = Math.sqrt(Vector3.Distance(p1, p2));
    const d23 = Math.sqrt(Vector3.Distance(p2, p3));
    for (let k = 0; k < samples; k++) out.push(catmullRomPoint(p0, p1, p2, p3, d01, d12, d23, k / samples));
  }
  if (!closed) out.push(p[n - 1].clone());
  return out;
}

export interface ArcPathOptions {
  /** Arc centre (default origin). */
  center?: Vec3;
  radius: number;
  /** Start / end angle in DEGREES. */
  from: number;
  to: number;
  segments?: number;
  /**
   * Plane of the arc and where angle 0 points:
   *  'xz' (default, lying flat): 0° = +x, 90° = +z;
   *  'xy' (facing forward):      0° = +x, 90° = +y;
   *  'zy' (side view):           0° = +z, 90° = +y.
   */
  plane?: 'xz' | 'xy' | 'zy';
}

/** Circular arc as `segments` + 1 points. */
export function arcPath(o: ArcPathOptions): Vector3[] {
  const c = o.center ? toV3(o.center) : Vector3.Zero();
  const segments = o.segments ?? Math.max(2, Math.ceil(Math.abs(o.to - o.from) / 12));
  const out: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (o.from + ((o.to - o.from) * i) / segments) * DEG;
    const u = Math.cos(a) * o.radius;
    const v = Math.sin(a) * o.radius;
    if (o.plane === 'xy') out.push(new Vector3(c.x + u, c.y + v, c.z));
    else if (o.plane === 'zy') out.push(new Vector3(c.x, c.y + v, c.z + u));
    else out.push(new Vector3(c.x + u, c.y, c.z + v));
  }
  return out;
}

export interface HelixPathOptions {
  radius: number;
  /** Radius at the far end, for conical springs (default = radius). */
  radiusEnd?: number;
  /** The helix climbs the +Y axis from yFrom (default 0) to yTo. */
  yFrom?: number;
  yTo: number;
  turns: number;
  samplesPerTurn?: number;
  /** Angle of the first point in DEGREES (0 = +x, 90 = +z). */
  startDeg?: number;
}

/** Helix about the +Y axis — coil springs (`tube` it), vines, spiral stairs. */
export function helixPath(o: HelixPathOptions): Vector3[] {
  const steps = Math.max(2, Math.round(o.turns * (o.samplesPerTurn ?? 16)));
  const y0 = o.yFrom ?? 0;
  const r1 = o.radiusEnd ?? o.radius;
  const out: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (o.startDeg ?? 0) * DEG + t * o.turns * Math.PI * 2;
    const r = o.radius + (r1 - o.radius) * t;
    out.push(new Vector3(Math.cos(a) * r, y0 + (o.yTo - y0) * t, Math.sin(a) * r));
  }
  return out;
}

export interface FilletOptions {
  /** Segments per corner arc. Default: one per `maxStepDeg` of bend. */
  segments?: number;
  /** Used when `segments` is not given (default 15°). */
  maxStepDeg?: number;
  /** Treat the path as a closed loop (every point is a corner). */
  closed?: boolean;
  /** Only round corners where the path turns by MORE than this many degrees
   * (default 0 = every corner). */
  minBendDeg?: number;
}

/**
 * Round every corner of a polyline with a circular arc of `radius`, tangent
 * to both neighbouring segments — a bent tube instead of a mitered kink. The
 * radius is reduced automatically where a segment is too short to fit it
 * (each corner may use at most half of a segment shared with another corner,
 * all of a segment that ends the path). Straight-through points are kept.
 * A tangent arc eats radius / tan(interior angle / 2) of each leg, which
 * explodes on hairpins; that length is capped at 3 × radius, so a bend
 * sharper than ~143° keeps its corner where it was drawn and gets a
 * proportionally tighter arc instead of swallowing both legs.
 */
export function filletPath(points: readonly Vec3[], radius: number, options: FilletOptions = {}): Vector3[] {
  const p = toV3s(points);
  const n = p.length;
  const closed = options.closed ?? false;
  if (n < 3 || radius <= 0) return p;
  const out: Vector3[] = [];
  const maxStep = (options.maxStepDeg ?? 15) * DEG;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(p[i]);
      continue;
    }
    const iPrev = (i + n - 1) % n;
    const iNext = (i + 1) % n;
    const A = p[iPrev];
    const P = p[i];
    const B = p[iNext];
    const u = A.subtract(P);
    const v = B.subtract(P);
    const lu = u.length();
    const lv = v.length();
    if (lu < 1e-9 || lv < 1e-9) {
      out.push(P);
      continue;
    }
    u.scaleInPlace(1 / lu);
    v.scaleInPlace(1 / lv);
    const cos = Math.min(1, Math.max(-1, Vector3.Dot(u, v)));
    const theta = Math.acos(cos); // interior angle at the corner
    const bend = Math.PI - theta; // how far the path turns
    if (bend < 1e-3 || theta < 1e-3 || bend < (options.minBendDeg ?? 0) * DEG) {
      out.push(P);
      continue;
    }
    const prevIsEnd = !closed && iPrev === 0;
    const nextIsEnd = !closed && iNext === n - 1;
    const maxD = Math.min(lu * (prevIsEnd ? 1 : 0.5), lv * (nextIsEnd ? 1 : 0.5));
    const tanHalf = Math.tan(theta / 2);
    const d = Math.min(radius / tanHalf, maxD, radius * 3);
    const r = d * tanHalf;
    const bis = u.add(v);
    bis.normalize();
    const C = P.add(bis.scale(r / Math.sin(theta / 2)));
    const a = P.add(u.scale(d)).subtract(C);
    const b = P.add(v.scale(d)).subtract(C);
    const segs = Math.max(1, Math.round(options.segments ?? Math.ceil(bend / maxStep)));
    const sinO = Math.sin(bend);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      // Slerp between the two radius vectors (both length r, `bend` apart).
      const ka = Math.sin((1 - t) * bend) / sinO;
      const kb = Math.sin(t * bend) / sinO;
      out.push(new Vector3(C.x + a.x * ka + b.x * kb, C.y + a.y * ka + b.y * kb, C.z + a.z * ka + b.z * kb));
    }
  }
  // Tangent points of neighbouring corners can coincide (a segment fully
  // consumed by its two fillets); drop the duplicates.
  const clean: Vector3[] = [];
  for (const q of out) {
    const last = clean[clean.length - 1];
    if (last && Vector3.DistanceSquared(last, q) < 1e-16) continue;
    clean.push(q);
  }
  if (closed && clean.length > 1 && Vector3.DistanceSquared(clean[0], clean[clean.length - 1]) < 1e-16) clean.pop();
  return clean;
}

/**
 * 2D `filletPath` for an OPEN profile (revolve profiles, lathe outlines):
 * rounds every interior corner; the two end points stay.
 */
export function filletProfile(points: readonly Vec2[], radius: number, segments?: number): Vec2[] {
  return filletPath(points.map((p) => [p[0], p[1], 0] as const), radius, { segments }).map((p) => [p.x, p.y] as const);
}

/**
 * 2D `filletPath` for a CLOSED ring (extrude outlines, loft sections): rounds
 * every corner, e.g. a rounded-corner plate from four points. Winding is
 * preserved.
 */
export function filletRing(ring: readonly Vec2[], radius: number, segments?: number): Vec2[] {
  return filletPath(ring.map((p) => [p[0], p[1], 0] as const), radius, { segments, closed: true }).map(
    (p) => [p.x, p.y] as const,
  );
}

/** Rotate `v` by the smallest rotation that takes unit `from` onto unit `to`
 * (parallel transport of a frame vector around a bend). */
export function rotateBetween(v: Vector3, from: Vector3, to: Vector3): Vector3 {
  const k = Vector3.Cross(from, to);
  const sin = k.length();
  const cos = Vector3.Dot(from, to);
  if (sin < 1e-9) return v.clone();
  k.scaleInPlace(1 / sin);
  const kv = Vector3.Cross(k, v);
  const kd = Vector3.Dot(k, v) * (1 - cos);
  return new Vector3(
    v.x * cos + kv.x * sin + k.x * kd,
    v.y * cos + kv.y * sin + k.y * kd,
    v.z * cos + kv.z * sin + k.z * kd,
  );
}

/** A frame riding along a path: `tangent` forward, `normal` and `binormal`
 * spanning the cross-section (binormal = normal × tangent). */
export interface PathFrame {
  position: Vector3;
  tangent: Vector3;
  normal: Vector3;
  binormal: Vector3;
}

/**
 * Twist-free (parallel-transported) frames at every path point — for placing
 * things along a path by hand (bolts along a rail, leaves along a stem).
 * `up` chooses where the first frame's normal points (projected
 * perpendicular to the path); later normals follow the bends without
 * spinning around the path.
 */
export function pathFrames(points: readonly Vec3[], closed = false, up?: Vec3): PathFrame[] {
  const p = toV3s(points);
  const n = p.length;
  const frames: PathFrame[] = [];
  if (n < 2) return frames;
  const tangentAt = (i: number): Vector3 => {
    const a = closed ? p[(i + n - 1) % n] : p[Math.max(i - 1, 0)];
    const b = closed ? p[(i + 1) % n] : p[Math.min(i + 1, n - 1)];
    const t = b.subtract(a);
    if (t.lengthSquared() < 1e-18) t.set(0, 1, 0);
    t.normalize();
    return t;
  };
  let t = tangentAt(0);
  let nrm: Vector3 | null = null;
  if (up) {
    const h = toV3(up);
    const proj = h.subtract(t.scale(Vector3.Dot(h, t)));
    if (proj.lengthSquared() > 1e-12) {
      proj.normalize();
      nrm = proj;
    }
  }
  if (!nrm) nrm = anyPerpendicular(t);
  for (let i = 0; i < n; i++) {
    const ti = tangentAt(i);
    nrm = rotateBetween(nrm, t, ti);
    // Re-orthogonalise so error cannot accumulate along long paths.
    nrm = nrm.subtract(ti.scale(Vector3.Dot(nrm, ti)));
    nrm.normalize();
    t = ti;
    frames.push({ position: p[i], tangent: ti, normal: nrm.clone(), binormal: Vector3.Cross(nrm, ti) });
  }
  return frames;
}
