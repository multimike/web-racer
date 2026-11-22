import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { catmullRomPoint } from '../../../gfx/solid';

/**
 * Curve and cross-section helpers for the Reef Rocket shell.
 *
 * The body is authored the way a clay model is sectioned: a handful of KEY
 * cross-sections (each the right half of the outline, a fixed number of
 * control points from the bottom centre round to the top centre) at known
 * stations along the car, blended lengthwise per control point. Everything
 * that has to sit ON the body — cage feet, decals, bolts — asks the same
 * functions where the surface is, so nothing is placed by eye.
 */

export type P2 = readonly [number, number];

/**
 * Monotone cubic interpolation (Fritsch–Carlson) through `keys` = [x, y]
 * pairs. Unlike Catmull-Rom it never overshoots: a floor line that runs flat
 * and then sweeps up must not dip below the flat first, or the car's lowest
 * point (its ground clearance) moves.
 */
export function mono(keys: readonly P2[]): (x: number) => number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  const n = k.length;
  if (n === 1) return () => k[0][1];
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    h.push(k[i + 1][0] - k[i][0]);
    d.push((k[i + 1][1] - k[i][1]) / h[i]);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i + 1 < n; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (x: number): number => {
    if (x <= k[0][0]) return k[0][1];
    if (x >= k[n - 1][0]) return k[n - 1][1];
    let i = 0;
    while (i + 2 < n && k[i + 1][0] < x) i++;
    const t = (x - k[i][0]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * k[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * k[i + 1][1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

/** A key cross-section: the control points of the RIGHT half, bottom centre
 * (x = 0) first, top centre (x = 0) last. */
export interface SectionKey {
  z: number;
  pts: readonly P2[];
}

/** Blend key sections lengthwise: returns the control points at any z. */
export function sectionAt(keys: readonly SectionKey[]): (z: number) => P2[] {
  const count = keys[0].pts.length;
  for (const k of keys) if (k.pts.length !== count) throw new Error(`sectionAt: key at z ${k.z} has ${k.pts.length} points, expected ${count}`);
  const fx: ((z: number) => number)[] = [];
  const fy: ((z: number) => number)[] = [];
  for (let i = 0; i < count; i++) {
    fx.push(mono(keys.map((k) => [k.z, k.pts[i][0]] as P2)));
    fy.push(mono(keys.map((k) => [k.z, k.pts[i][1]] as P2)));
  }
  return (z) => fx.map((f, i) => [f(z), fy[i](z)] as P2);
}

/**
 * Smooth dense polyline through the control points of a half section
 * (centripetal Catmull-Rom, so unevenly spaced controls do not overshoot).
 * The curve is continued by its own mirror image across x = 0 at both ends,
 * which makes it cross the centre line square — no ridge or dimple there.
 * `samples[i]` = segments on the span from control i to i + 1.
 */
export function denseHalf(ctrl: readonly P2[], samples: readonly number[]): P2[] {
  const n = ctrl.length;
  const v = (i: number): Vector3 => {
    if (i < 0) return new Vector3(-ctrl[-i][0], ctrl[-i][1], 0);
    if (i >= n) return new Vector3(-ctrl[2 * n - 2 - i][0], ctrl[2 * n - 2 - i][1], 0);
    return new Vector3(ctrl[i][0], ctrl[i][1], 0);
  };
  const knot = (a: Vector3, b: Vector3): number => Math.sqrt(Math.max(Vector3.Distance(a, b), 1e-6));
  const out: P2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = v(i - 1), p1 = v(i), p2 = v(i + 1), p3 = v(i + 2);
    const steps = samples[i] ?? 2;
    for (let s = 0; s < steps; s++) {
      const q = s === 0 ? p1 : catmullRomPoint(p0, p1, p2, p3, knot(p0, p1), knot(p1, p2), knot(p2, p3), s / steps);
      out.push([Math.max(q.x, 0), q.y]);
    }
  }
  out.push([0, ctrl[n - 1][1]]);
  out[0] = [0, ctrl[0][1]];
  return out;
}

/** Push a dense half section outward by `d` along its own normals (a panel
 * that sits proud of the one under it). */
export function offsetHalf(half: readonly P2[], d: number): P2[] {
  const n = half.length;
  return half.map((p, i) => {
    if (i === 0) return [0, p[1] - d] as P2;
    if (i === n - 1) return [0, p[1] + d] as P2;
    const a = half[i - 1];
    const b = half[i + 1];
    // Walking bottom → top up the right side, outward is to the right of
    // the direction of travel.
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    return [p[0] + (ty / l) * d, p[1] - (tx / l) * d] as P2;
  });
}

/** Scale a dense half section about a point on the centre line (rounded
 * nose and tail caps). */
export function scaleHalf(half: readonly P2[], cy: number, f: number): P2[] {
  return half.map(([x, y]) => [x * f, cy + (y - cy) * f] as P2);
}

/** The full closed ring of a symmetric section at station z: up the right
 * side, back down the left. */
export function ringOf(half: readonly P2[], z: number): Vector3[] {
  const out = half.map(([x, y]) => new Vector3(x, y, z));
  for (let i = half.length - 2; i >= 1; i--) out.push(new Vector3(-half[i][0], half[i][1], z));
  return out;
}

/** Height of the section's UPPER surface at lateral position x ≥ 0 (walks
 * down from the top centre until the outline has moved out to x). */
export function topYAt(half: readonly P2[], x: number): number {
  for (let i = half.length - 1; i > 0; i--) {
    const a = half[i];
    const b = half[i - 1];
    if (b[0] >= x) {
      const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
    if (b[0] < a[0]) return a[1]; // past the widest point: x is outside the section
  }
  return half[0][1];
}

/** Half-width of the section at height y, measured on its outer flank (the
 * widest crossing). */
export function sideXAt(half: readonly P2[], y: number): number {
  let best = 0;
  for (let i = 0; i + 1 < half.length; i++) {
    const a = half[i];
    const b = half[i + 1];
    if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
    const t = (y - a[1]) / (b[1] - a[1]);
    best = Math.max(best, a[0] + (b[0] - a[0]) * t);
  }
  return best;
}

/** Smooth polyline through 2D points (centripetal Catmull-Rom, open). */
export function smooth2(points: readonly P2[], samples: number): P2[] {
  const n = points.length;
  const v = (i: number): Vector3 => {
    const c = Math.min(Math.max(i, 0), n - 1);
    const p = new Vector3(points[c][0], points[c][1], 0);
    // Ends leave straight: reflect the neighbour through the end point.
    if (i < 0) return p.scale(2).subtract(new Vector3(points[1][0], points[1][1], 0));
    if (i >= n) return p.scale(2).subtract(new Vector3(points[n - 2][0], points[n - 2][1], 0));
    return p;
  };
  const knot = (a: Vector3, b: Vector3): number => Math.sqrt(Math.max(Vector3.Distance(a, b), 1e-6));
  const out: P2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = v(i - 1), p1 = v(i), p2 = v(i + 1), p3 = v(i + 2);
    for (let s = 0; s < samples; s++) {
      const q = s === 0 ? p1 : catmullRomPoint(p0, p1, p2, p3, knot(p0, p1), knot(p1, p2), knot(p2, p3), s / samples);
      out.push([q.x, q.y]);
    }
  }
  out.push([points[n - 1][0], points[n - 1][1]]);
  return out;
}
