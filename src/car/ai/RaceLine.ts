/**
 * Track geometry and racing line for the rival drivers (src/car/ai).
 *
 * Babylon-free and allocation-free after construction, so it can run in a
 * worker or on a server. Two classes:
 *
 *   TrackGeometry  the closed centreline as a measured curve: arc length,
 *                  tangents, signed curvature, road height / slope / vertical
 *                  curvature, and a windowed nearest-point projection. ONE
 *                  per track, shared by every car.
 *   RaceLine       one driver's line through that track: a lateral offset
 *                  per centreline point (minimum-bending line inside the
 *                  corridor that driver is willing to use), the curvature of
 *                  that line and a speed plan for a given grip budget. One
 *                  per rival (corridor width, bias and budgets differ).
 *
 * Conventions (same as Vehicle.ts / DriverModel.ts): heading yaw =
 * atan2(x, z); lateral offsets and curvature are POSITIVE TO THE RIGHT of
 * the direction of travel (right of tangent (tx, tz) is (tz, −tx)).
 *
 * The track half-width is never copied: `halfWidth` reads the track object
 * every time, so widening the road later needs no change here (a RaceLine
 * built before the change keeps its old corridor until `solve()` is called
 * again — RivalDriver does that when it notices).
 */

/** What the rivals need from a track — structurally satisfied by
 * `terrain/track.ts` `Track` (and by RaceState's `RaceTrackSource`). */
export interface RivalTrack {
  /** Closed polyline [x0,z0, x1,z1, ...]; point 0 = start line, travel
   * direction = increasing index. */
  points: ArrayLike<number>;
  count: number;
  /** Drivable half-width, m. */
  halfWidth: number;
  /** Road surface height per point. Missing = flat at y 0. */
  roadHeights?: ArrayLike<number>;
}

export interface TrackProjection {
  /** Nearest centreline point. */
  index: number;
  /** Arc length of the projection, 0..length. */
  s: number;
  /** Signed offset from the centreline, m (+ = right of travel). */
  lateral: number;
  /** Distance to the nearest centreline point, m. */
  distance: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/** In-place circular box blur. */
function blurCircular(data: Float64Array, radius: number, passes: number): void {
  const n = data.length;
  if (radius < 1 || n < 3) return;
  const tmp = new Float64Array(n);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += data[((i % n) + n) % n];
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / w;
      sum -= data[(((i - radius) % n) + n) % n];
      sum += data[(i + radius + 1) % n];
    }
    data.set(tmp);
  }
}

export class TrackGeometry {
  readonly track: RivalTrack;
  readonly n: number;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  /** Unit tangent per point. */
  readonly tx: Float64Array;
  readonly tz: Float64Array;
  /** Length of segment i → i + 1. */
  readonly seg: Float64Array;
  /** Arc length at point i; n + 1 entries, s[n] = length. */
  readonly s: Float64Array;
  readonly length: number;
  readonly meanStep: number;
  /** Signed curvature of the centreline, 1/m (+ = right turn). */
  readonly curvature: Float64Array;
  /** Road height, slope dh/ds and vertical curvature d²h/ds² (+ = dip). */
  readonly height: Float64Array;
  readonly slope: Float64Array;
  readonly vcurv: Float64Array;

  constructor(track: RivalTrack) {
    const n = track.count;
    if (n < 8) throw new Error('TrackGeometry: a closed track needs at least 8 points');
    this.track = track;
    this.n = n;
    this.px = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.seg = new Float64Array(n);
    this.s = new Float64Array(n + 1);
    this.curvature = new Float64Array(n);
    this.height = new Float64Array(n);
    this.slope = new Float64Array(n);
    this.vcurv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = track.points[i * 2];
      this.pz[i] = track.points[i * 2 + 1];
      this.height[i] = track.roadHeights ? track.roadHeights[i] : 0;
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.s[i] = total;
      this.seg[i] = Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
      total += this.seg[i];
    }
    this.s[n] = total;
    this.length = total;
    this.meanStep = total / n;
    // Windows in POINTS for a given distance (the polyline is ~evenly spaced).
    const K = Math.max(1, Math.round(3 / Math.max(this.meanStep, 0.05)));
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n;
      const b = (i + 2) % n;
      const dx = this.px[b] - this.px[a];
      const dz = this.pz[b] - this.pz[a];
      const len = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / len;
      this.tz[i] = dz / len;
    }
    curvatureOf(this.px, this.pz, K, this.curvature);
    // Vertical profile. The road heights are already low-passed by the
    // terrain generator; one more light blur keeps the second difference
    // from amplifying sampling noise.
    const span = Math.max(2, Math.round(4 / Math.max(this.meanStep, 0.05)));
    for (let i = 0; i < n; i++) {
      const a = (i - span + n) % n;
      const b = (i + span) % n;
      const d = span * this.meanStep;
      this.slope[i] = (this.height[b] - this.height[a]) / (2 * d);
      this.vcurv[i] = (this.height[b] - 2 * this.height[i] + this.height[a]) / (d * d);
    }
    blurCircular(this.vcurv, span, 2);
  }

  /** Drivable half-width RIGHT NOW (read from the track object). */
  get halfWidth(): number {
    return this.track.halfWidth;
  }

  wrapIndex(i: number): number {
    const n = this.n;
    return ((i % n) + n) % n;
  }

  /** Signed shortest arc from a to b, in (−length/2, length/2]. */
  arcDelta(a: number, b: number): number {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L;
    else if (d <= -L / 2) d += L;
    return d;
  }

  /** Point index `distance` metres further along than point `from`. */
  indexAhead(from: number, distance: number): number {
    const n = this.n;
    let i = from;
    let left = distance;
    for (let guard = 0; guard < n && left > 0; guard++) {
      left -= this.seg[i];
      i = i + 1 === n ? 0 : i + 1;
    }
    return i;
  }

  /**
   * Project (x, z) onto the centreline. `hint` ≥ 0 searches a window around
   * that index (`back` points behind, `fwd` ahead) — the cheap per-frame
   * path; `hint` < 0 searches the whole loop (after a teleport).
   */
  project(x: number, z: number, hint: number, out: TrackProjection, back = 8, fwd = 40): TrackProjection {
    const n = this.n;
    const px = this.px;
    const pz = this.pz;
    let best = 0;
    let bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const d = (px[i] - x) * (px[i] - x) + (pz[i] - z) * (pz[i] - z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    } else {
      for (let k = -back; k <= fwd; k++) {
        let i = hint + k;
        if (i < 0) i += n;
        else if (i >= n) i -= n;
        const d = (px[i] - x) * (px[i] - x) + (pz[i] - z) * (pz[i] - z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    const dx = x - px[best];
    const dz = z - pz[best];
    const tx = this.tx[best];
    const tz = this.tz[best];
    let s = this.s[best] + dx * tx + dz * tz;
    if (s < 0) s += this.length;
    else if (s >= this.length) s -= this.length;
    out.index = best;
    out.s = s;
    out.lateral = dx * tz - dz * tx;
    out.distance = Math.sqrt(bestD);
    return out;
  }
}

/** Signed curvature of a closed polyline: heading change over arc length
 * across a ±K point window (+ = right turn). */
function curvatureOf(px: Float64Array, pz: Float64Array, K: number, out: Float64Array): void {
  const n = px.length;
  for (let i = 0; i < n; i++) {
    const a = (i - K + n) % n;
    const c = (i + K) % n;
    const ax = px[i] - px[a];
    const az = pz[i] - pz[a];
    const bx = px[c] - px[i];
    const bz = pz[c] - pz[i];
    const d0 = Math.hypot(ax, az);
    const d1 = Math.hypot(bx, bz);
    if (d0 < 1e-6 || d1 < 1e-6) {
      out[i] = 0;
      continue;
    }
    out[i] = wrapAngle(Math.atan2(bx, bz) - Math.atan2(ax, az)) / ((d0 + d1) / 2);
  }
}

export interface RaceLineOptions {
  /** Half-width of the band the line may use around the centreline, m. */
  halfCorridor: number;
  /** 0..1: how much of the ideal line is used (1 = all of it, lower = the
   * line stays nearer the middle of the road: a less committed driver). */
  use?: number;
  /** Constant sideways preference, m (+ = right). */
  bias?: number;
  /** Weight of "shortest path" against "least bending" (0 = pure minimum
   * bending). A little keeps the line from wandering on straights. */
  shortness?: number;
}

export class RaceLine {
  readonly geo: TrackGeometry;
  /** Lateral offset of the line per centreline point, m (+ = right). */
  readonly offset: Float64Array;
  /** Signed curvature of the line, 1/m. */
  readonly curvature: Float64Array;
  /** Planned speed per point for the budgets of the last plan(), m/s. */
  readonly speed: Float64Array;
  halfCorridor = 0;
  /** Budgets of the last plan() (to decide when a re-plan is worth it). */
  plannedLatAccel = 0;
  plannedBrakeAccel = 0;
  plannedTopSpeed = 0;

  private readonly lx: Float64Array;
  private readonly lz: Float64Array;

  constructor(geo: TrackGeometry, options: RaceLineOptions) {
    this.geo = geo;
    const n = geo.n;
    this.offset = new Float64Array(n);
    this.curvature = new Float64Array(n);
    this.speed = new Float64Array(n);
    this.lx = new Float64Array(n);
    this.lz = new Float64Array(n);
    this.solve(options);
  }

  /**
   * Compute the line: projected Gauss-Seidel on the (re-weighted) bending
   * energy Σ w·|P[i−1] − 2P[i] + P[i+1]|² of the path P[i] = centre[i] +
   * L[i]·normal[i] with |L[i]| ≤ halfCorridor — the classic out-in-out line:
   * it opens every corner as far as the corridor allows. Solved on control
   * points ~3 m apart (fast convergence), interpolated to the track points.
   * Costs a few milliseconds per driver, once.
   */
  solve(options: RaceLineOptions): void {
    const geo = this.geo;
    const n = geo.n;
    const W = Math.max(0, options.halfCorridor);
    this.halfCorridor = W;
    const use = clamp(options.use ?? 1, 0, 1);
    const bias = options.bias ?? 0;
    const lambda = Math.max(0, options.shortness ?? 0.25);

    const m = Math.max(8, Math.round(geo.length / 3));
    const cx = new Float64Array(m);
    const cz = new Float64Array(m);
    const nx = new Float64Array(m);
    const nz = new Float64Array(m);
    const L = new Float64Array(m);
    // Bend weights (see the rounds below); start uniform.
    const w = new Float64Array(m).fill(1);
    for (let k = 0; k < m; k++) {
      const f = (k * n) / m;
      const i = Math.floor(f);
      const j = (i + 1) % n;
      const t = f - i;
      cx[k] = geo.px[i] + (geo.px[j] - geo.px[i]) * t;
      cz[k] = geo.pz[i] + (geo.pz[j] - geo.pz[i]) * t;
      const tx = geo.tx[i] + (geo.tx[j] - geo.tx[i]) * t;
      const tz = geo.tz[i] + (geo.tz[j] - geo.tz[i]) * t;
      const len = Math.hypot(tx, tz) || 1;
      nx[k] = tz / len;
      nz[k] = -tx / len;
    }
    if (W > 0) {
      // Plain least-squares bending spreads the turning evenly but leaves the
      // PEAK (the apex of a hairpin, which sets the corner speed) too sharp.
      // Re-weighting each bend by its own size for a few rounds (iteratively
      // re-weighted least squares ≈ minimising Σκ⁴) flattens the peaks: the
      // line turns in earlier and uses all the road at the apex.
      for (let round = 0; round < 4; round++) {
        for (let iter = 0; iter < 700; iter++) {
          let moved = 0;
          for (let k = 0; k < m; k++) {
            const a = (k - 2 + m) % m;
            const b = (k - 1 + m) % m;
            const c = (k + 1) % m;
            const d = (k + 2) % m;
            const ax = cx[a] + L[a] * nx[a], az = cz[a] + L[a] * nz[a];
            const bx = cx[b] + L[b] * nx[b], bz = cz[b] + L[b] * nz[b];
            const ex = cx[c] + L[c] * nx[c], ez = cz[c] + L[c] * nz[c];
            const dx = cx[d] + L[d] * nx[d], dz = cz[d] + L[d] * nz[d];
            // Minimiser of w[b]·|bend at b|² + w[k]·|bend at k|² + w[c]·|bend
            // at c|² (+ lambda·length) over the position of point k.
            const wb = w[b], wk = w[k], wc = w[c];
            const sum = wb + 4 * wk + wc + 2 * lambda;
            const tgx = (wb * (2 * bx - ax) + (2 * wk + lambda) * (bx + ex) + wc * (2 * ex - dx)) / sum;
            const tgz = (wb * (2 * bz - az) + (2 * wk + lambda) * (bz + ez) + wc * (2 * ez - dz)) / sum;
            const target = clamp((tgx - cx[k]) * nx[k] + (tgz - cz[k]) * nz[k], -W, W);
            moved += Math.abs(target - L[k]);
            L[k] = target;
          }
          if (moved < 2e-4 * m) break;
        }
        if (round === 3) break;
        let mean = 0;
        for (let k = 0; k < m; k++) {
          const b = (k - 1 + m) % m;
          const c = (k + 1) % m;
          const bendX = cx[b] + L[b] * nx[b] - 2 * (cx[k] + L[k] * nx[k]) + cx[c] + L[c] * nx[c];
          const bendZ = cz[b] + L[b] * nz[b] - 2 * (cz[k] + L[k] * nz[k]) + cz[c] + L[c] * nz[c];
          w[k] = bendX * bendX + bendZ * bendZ;
          mean += w[k] / m;
        }
        for (let k = 0; k < m; k++) w[k] = clamp((w[k] + 0.05 * mean) / (1.05 * mean + 1e-12), 0.05, 40);
      }
    }
    // Periodic Catmull-Rom from the control points to the track points.
    const off = this.offset;
    for (let i = 0; i < n; i++) {
      const f = (i * m) / n;
      const k = Math.floor(f);
      const t = f - k;
      const p0 = L[(k - 1 + m) % m];
      const p1 = L[k % m];
      const p2 = L[(k + 1) % m];
      const p3 = L[(k + 2) % m];
      const v = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
      off[i] = clamp(v * use + bias, -W, W);
    }
    blurCircular(off, 1, 2);
    for (let i = 0; i < n; i++) {
      this.lx[i] = geo.px[i] + off[i] * geo.tz[i];
      this.lz[i] = geo.pz[i] - off[i] * geo.tx[i];
    }
    const K = Math.max(1, Math.round(3 / Math.max(geo.meanStep, 0.05)));
    curvatureOf(this.lx, this.lz, K, this.curvature);
    blurCircular(this.curvature, 1, 1);
    this.plannedLatAccel = 0;
  }

  /**
   * Speed plan along the line.
   *  - corner speed from the lateral budget, corrected for the road's
   *    vertical curvature (a crest unloads the tires, a dip loads them):
   *    v²·|κ| = a_lat·(1 + v²·h''/g);
   *  - on a crest never faster than keeps `minLoad` of the static wheel load;
   *  - a backward pass so every corner can be braked for with what is left
   *    of the friction circle after cornering, plus the slope's help/hurt.
   * There is no forward (acceleration) pass on purpose: what the engine can
   * do is found out by flooring it, not assumed.
   */
  plan(latAccel: number, brakeAccel: number, topSpeed: number, gravity: number, minLoad = 0.45): void {
    const geo = this.geo;
    const n = geo.n;
    const speed = this.speed;
    const lat = Math.max(latAccel, 0.1);
    const brk = Math.max(brakeAccel, 0.1);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.curvature[i]);
      const hv = geo.vcurv[i];
      const den = k - (lat / gravity) * hv;
      let v = den > 1e-5 ? Math.sqrt(lat / den) : topSpeed;
      if (hv < -1e-5) v = Math.min(v, Math.sqrt(((1 - minLoad) * gravity) / -hv));
      speed[i] = v < topSpeed ? v : topSpeed;
    }
    for (let sweep = 0; sweep < 2; sweep++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = i + 1 === n ? 0 : i + 1;
        const vj = speed[j];
        const u = Math.min(1, (vj * vj * Math.abs(this.curvature[i])) / lat);
        let a = brk * Math.sqrt(Math.max(0.15, 1 - u * u)) + gravity * geo.slope[i];
        if (a < 0.2 * brk) a = 0.2 * brk;
        const limit = Math.sqrt(vj * vj + 2 * a * geo.seg[i]);
        if (speed[i] > limit) speed[i] = limit;
      }
    }
    this.plannedLatAccel = latAccel;
    this.plannedBrakeAccel = brakeAccel;
    this.plannedTopSpeed = topSpeed;
  }
}
