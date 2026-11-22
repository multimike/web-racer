import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, applyMatrix } from './math';
import type { Vec2 } from './math';
import type { PathFrame } from './paths';

function wantCount(what: string, count: number, min: number): number {
  const n = Math.round(count);
  if (!(n >= min)) throw new Error(`${what}: needs at least ${min} points, got ${count}`);
  return n;
}

/**
 * 2D cross-section rings for `loft`, `sweep` and `extrudePolygon`.
 *
 * Every generator returns a closed ring of `[x, y]` points (the closing point
 * is NOT repeated) that
 *  - is wound COUNTER-CLOCKWISE (x right, y up), and
 *  - STARTS ON THE +X AXIS (y = 0, x > 0) and proceeds toward +y.
 * Sharing the start and the direction is what lets `loft` connect rings of
 * different shapes point-for-point without twisting: a circle station can
 * follow a rounded-rectangle station as long as both have the same point
 * count (use `resampleRing` to make counts match).
 *
 * Use an EVEN point count for shapes that must be left/right symmetric.
 */

/** Circle of `count` points. */
export function circleRing(radius: number, count: number): Vec2[] {
  return ellipseRing(radius, radius, count);
}

/** Ellipse with half-axes rx (along x) and ry (along y). */
export function ellipseRing(rx: number, ry: number, count: number): Vec2[] {
  count = wantCount('ellipseRing / circleRing', count, 3);
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push([Math.cos(a) * rx, Math.sin(a) * ry]);
  }
  return out;
}

/**
 * Superellipse |x/rx|^e + |y/ry|^e = 1. exponent 2 = ellipse, ~4 = squircle
 * (the classic soft toy cross-section), 8+ = nearly a rectangle with tight
 * round corners, < 2 = pinched diamond. Points are spaced by angle, which
 * naturally clusters them in the corners where the curvature is.
 */
export function superellipseRing(rx: number, ry: number, exponent: number, count: number): Vec2[] {
  count = wantCount('superellipseRing', count, 3);
  const out: Vec2[] = [];
  const k = 2 / exponent;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    // cos / sin of 90°, 180°, 270° come out as ±1e-16, not 0, and a SMALL
    // power of that is not small (1e-16 ^ 0.125 = 0.01): the on-axis points
    // would be pushed millimetres off their axis, differently on each side.
    let c = Math.cos(a);
    let s = Math.sin(a);
    if (Math.abs(c) < 1e-12) c = 0;
    if (Math.abs(s) < 1e-12) s = 0;
    out.push([Math.sign(c) * Math.pow(Math.abs(c), k) * rx, Math.sign(s) * Math.pow(Math.abs(s), k) * ry]);
  }
  return out;
}

/**
 * Rectangle `width` × `height` centred on the origin with rounded corners.
 * `radius` is one number or per corner [+x+y, −x+y, −x−y, +x−y] (clamped to
 * half the shorter side). The point count is ALWAYS 4 × (cornerSegments + 2):
 * one point at the middle of each side plus cornerSegments + 1 per corner —
 * independent of the dimensions, so rounded rectangles of any size and
 * radius loft to each other point-for-point. With radius 0 the corner points
 * coincide (a sharp corner; duplicate points are tolerated by loft/extrude).
 * `cornerSegments: 0` gives one point per corner, on the SHARP corner itself
 * (the radius is then ignored).
 */
export function roundedRectRing(
  width: number,
  height: number,
  radius: number | readonly [number, number, number, number],
  cornerSegments = 4,
): Vec2[] {
  const hw = width / 2;
  const hh = height / 2;
  const lim = Math.min(hw, hh);
  const r = (typeof radius === 'number' ? [radius, radius, radius, radius] : radius).map((x) =>
    Math.max(0, Math.min(x, lim)),
  );
  cornerSegments = Math.max(0, Math.round(cornerSegments));
  const out: Vec2[] = [];
  // Corner k: centre sign and the angle its arc starts at.
  const corners: [number, number, number][] = [
    [1, 1, 0],
    [-1, 1, 90],
    [-1, -1, 180],
    [1, -1, 270],
  ];
  const mids: Vec2[] = [
    [hw, 0],
    [0, hh],
    [-hw, 0],
    [0, -hh],
  ];
  for (let k = 0; k < 4; k++) {
    out.push(mids[k]);
    const [sx, sy, a0] = corners[k];
    const cxk = sx * (hw - r[k]);
    const cyk = sy * (hh - r[k]);
    if (cornerSegments === 0) {
      out.push([sx * hw, sy * hh]);
      continue;
    }
    for (let i = 0; i <= cornerSegments; i++) {
      const a = (a0 + (90 * i) / cornerSegments) * DEG;
      out.push([cxk + Math.cos(a) * r[k], cyk + Math.sin(a) * r[k]]);
    }
  }
  return out;
}

/** Regular polygon with `sides` corners on a circle of `radius`; the first
 * corner is rotated by `startDeg` from +x (e.g. 45 for an upright square). */
export function polygonRing(sides: number, radius: number, startDeg = 0): Vec2[] {
  sides = wantCount('polygonRing', sides, 3);
  const out: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = startDeg * DEG + (i / sides) * Math.PI * 2;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

/**
 * Resample any closed 2D polyline to `count` points evenly spaced along its
 * perimeter, starting at its first point — turns a hand-drawn outline (or a
 * ring with the wrong point count) into a loft-compatible ring. Corners are
 * cut slightly unless a sample happens to land on them; raise `count` or
 * keep the ring as-is where sharp corners matter.
 */
export function resampleRing(ring: readonly Vec2[], count: number): Vec2[] {
  count = wantCount('resampleRing', count, 3);
  const n = ring.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n];
  const out: Vec2[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? (d - cum[seg]) / span : 0;
    const a = ring[seg];
    const b = ring[(seg + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** 3D version of `resampleRing` (closed polyline of Vector3). */
export function resampleRing3(ring: readonly Vector3[], count: number): Vector3[] {
  count = wantCount('resampleRing3', count, 3);
  const n = ring.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Vector3.Distance(ring[i], ring[(i + 1) % n]));
  const total = cum[n];
  const out: Vector3[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? (d - cum[seg]) / span : 0;
    out.push(Vector3.Lerp(ring[seg], ring[(seg + 1) % n], t));
  }
  return out;
}

/** Scale a ring about the origin (sy defaults to sx). */
export function scaleRing(ring: readonly Vec2[], sx: number, sy = sx): Vec2[] {
  return ring.map((p) => [p[0] * sx, p[1] * sy] as const);
}

/** Shift a ring. */
export function translateRing(ring: readonly Vec2[], dx: number, dy: number): Vec2[] {
  return ring.map((p) => [p[0] + dx, p[1] + dy] as const);
}

/**
 * Stand a 2D ring up in the XY plane at depth `z` — the station of a loft
 * that runs along Z (car bodies, fuselages): ring (x, y) → (x + dx, y + dy, z).
 */
export function ringXY(ring: readonly Vec2[], z = 0, dx = 0, dy = 0): Vector3[] {
  return ring.map((p) => new Vector3(p[0] + dx, p[1] + dy, z));
}

/**
 * Lay a 2D ring flat in the XZ plane at height `y` — the station of a loft
 * that runs UP +Y (trunks, towers, bottles): ring (x, y₂) → (x + dx, y, y₂ + dz).
 */
export function ringXZ(ring: readonly Vec2[], y = 0, dx = 0, dz = 0): Vector3[] {
  return ring.map((p) => new Vector3(p[0] + dx, y, p[1] + dz));
}

/** Place a 2D ring with a matrix: ring (x, y) is taken as (x, y, 0). */
export function placeRing(ring: readonly Vec2[], m: Matrix): Vector3[] {
  return ring.map((p) => applyMatrix([p[0], p[1], 0], m));
}

/**
 * Stand a 2D ring (or an open 2D polyline) on a path frame from
 * `pathFrames()`: ring x runs along the frame's NORMAL (the `up` you gave
 * pathFrames), ring y along its BINORMAL, centred on the frame position —
 * the same layout `sweep` uses. This is how a loft gets a DIFFERENT section
 * at every station along a curved spine (fenders, wheel-arch lips, tapering
 * bumpers, a body shell along its centre line):
 *   const frames = pathFrames(spine, false, [0, 1, 0]);
 *   loft(m, { rings: frames.map((f, i) => ringOnFrame(section(i / (frames.length - 1)), f)) }, P);
 */
export function ringOnFrame(ring: readonly Vec2[], frame: PathFrame, scale = 1): Vector3[] {
  const { position: o, normal: n, binormal: b } = frame;
  return ring.map(
    (p) =>
      new Vector3(
        o.x + (n.x * p[0] + b.x * p[1]) * scale,
        o.y + (n.y * p[0] + b.y * p[1]) * scale,
        o.z + (n.z * p[0] + b.z * p[1]) * scale,
      ),
  );
}
