import { mulberry32 } from './noise';
import type { Heightfield } from './Heightfield';

/** Closed racing loop as a dense, evenly spaced polyline. The spline itself is
 * only used at generation time — carving, ramp placement, and spawn all work
 * from this sampled form. */
export interface Track {
  /** Polyline points, ~1 m apart, [x0,z0, x1,z1, ...]. Closed: last connects to first. */
  points: Float32Array;
  /** Unit tangents per point, same layout. */
  tangents: Float32Array;
  /** Smoothed road height per point (world y of the carved surface). */
  roadHeights: Float32Array;
  count: number;
  /** Drivable half-width in meters (flat part; blend shoulder extends beyond). */
  halfWidth: number;
  shoulder: number;
  /** Per-heightfield-sample distance to the road centerline; filled by the
   * carve pass and reused by the splat pass (Infinity beyond the shoulder). */
  sampleRoadDist?: Float32Array;
}

const POINT_SPACING = 1.0;

/** Control points on a radius-perturbed circle, then translated/rotated so the
 * loop passes through the world origin heading +z — the cars spawn at (0,·,0)
 * facing +z and land on the start line without touching vehicle code. */
export function generateTrack(seed: number, hf: Heightfield): Track {
  const rand = mulberry32(seed * 7919 + 17);
  const numCtrl = 10 + Math.floor(rand() * 3);
  const baseRadius = 42;
  const ctrl: Array<[number, number]> = [];
  for (let i = 0; i < numCtrl; i++) {
    const a = (i / numCtrl) * Math.PI * 2;
    const r = baseRadius * (0.72 + 0.55 * rand());
    ctrl.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  // Dense-sample the closed Catmull-Rom, then resample by arc length.
  const dense: number[] = [];
  const SUB = 24;
  for (let i = 0; i < numCtrl; i++) {
    const p0 = ctrl[(i + numCtrl - 1) % numCtrl];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % numCtrl];
    const p3 = ctrl[(i + 2) % numCtrl];
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB;
      dense.push(catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t));
    }
  }
  const resampled = resampleClosed(dense, POINT_SPACING);

  // Move point 0 to the origin and rotate its tangent onto +z.
  const n = resampled.length / 2;
  const ox = resampled[0];
  const oz = resampled[1];
  const tx = resampled[2] - ox;
  const tz = resampled[3] - oz;
  const tlen = Math.hypot(tx, tz);
  // Rotation mapping (tx,tz)/|t| -> (0,1) in the xz-plane.
  const cos = tz / tlen;
  const sin = tx / tlen;
  const points = new Float32Array(resampled.length);
  for (let i = 0; i < n; i++) {
    const x = resampled[i * 2] - ox;
    const z = resampled[i * 2 + 1] - oz;
    points[i * 2] = x * cos - z * sin;
    points[i * 2 + 1] = x * sin + z * cos;
  }

  // Translating the loop onto the origin can push the far side out toward the
  // terrain rim — uniformly shrink about the origin until it fits.
  const MAX_EXTENT = 70;
  let extent = 0;
  for (let i = 0; i < points.length; i++) extent = Math.max(extent, Math.abs(points[i]));
  if (extent > MAX_EXTENT) {
    const s = MAX_EXTENT / extent;
    for (let i = 0; i < points.length; i++) points[i] *= s;
  }

  const tangents = new Float32Array(points.length);
  for (let i = 0; i < n; i++) {
    const ax = points[((i + n - 1) % n) * 2];
    const az = points[((i + n - 1) % n) * 2 + 1];
    const bx = points[((i + 1) % n) * 2];
    const bz = points[((i + 1) % n) * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    tangents[i * 2] = dx / len;
    tangents[i * 2 + 1] = dz / len;
  }

  // Road elevation: terrain height along the loop, circularly low-pass
  // filtered so the road climbs and dips gently instead of copying every bump.
  const roadHeights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    roadHeights[i] = hf.getHeight(points[i * 2], points[i * 2 + 1]);
  }
  boxBlurCircular(roadHeights, 12, 3);

  return { points, tangents, roadHeights, count: n, halfWidth: 3.5, shoulder: 3.0 };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3)
  );
}

/** Resample a closed [x,z,...] polyline to (approximately) even spacing. */
function resampleClosed(pts: number[], spacing: number): number[] {
  const n = pts.length / 2;
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    segLen.push(l);
    total += l;
  }
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: number[] = [];
  let seg = 0;
  let segStart = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (segStart + segLen[seg] < target) {
      segStart += segLen[seg];
      seg++;
    }
    const t = segLen[seg] === 0 ? 0 : (target - segStart) / segLen[seg];
    const i = seg;
    const j = (seg + 1) % n;
    out.push(
      pts[i * 2] + (pts[j * 2] - pts[i * 2]) * t,
      pts[i * 2 + 1] + (pts[j * 2 + 1] - pts[i * 2 + 1]) * t,
    );
  }
  return out;
}

/** In-place circular box blur, `passes`× (3 passes ≈ gaussian). */
function boxBlurCircular(data: Float32Array, radius: number, passes: number): void {
  const n = data.length;
  const tmp = new Float32Array(n);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += data[((i % n) + n) % n];
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / w;
      sum -= data[(((i - radius) % n) + n) % n];
      sum += data[((i + radius + 1) % n) % n];
    }
    data.set(tmp);
  }
}
