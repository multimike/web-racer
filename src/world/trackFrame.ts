import type { Track } from '../terrain/track';
import type { Bend, Vec2 } from './types';

/** Where a world point is relative to the road centreline. */
export interface RoadHit {
  /** Nearest track point index. */
  index: number;
  /** Arc length of the nearest centreline point. */
  s: number;
  /** Distance to the centreline. */
  dist: number;
  /** +1 = left of the direction of travel, −1 = right. */
  side: 1 | -1;
}

export interface RoadPoint {
  x: number;
  z: number;
  tx: number;
  tz: number;
  /** Road surface height. */
  h: number;
  /** Signed curvature 1/m, + = the road turns left. */
  k: number;
}

/**
 * The track loop as a measured curve: arc length, curvature, offset points
 * and a distance field for "how far from the road is this".
 *
 * LEFT of travel is nl = (−tz, tx): heading +z, left is −x (x right, z up on
 * a top-down map). Lateral offsets are positive to the left.
 */
export class TrackFrame {
  readonly n: number;
  readonly length: number;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly tx: Float64Array;
  readonly tz: Float64Array;
  /** Cumulative arc length per point, n + 1 entries (s[n] = length). */
  readonly s: Float64Array;
  readonly h: Float32Array;
  /** Smoothed signed curvature per point. */
  readonly curv: Float32Array;
  readonly worldSize: number;

  // 1 m distance field over the world: nearest track point per cell (within
  // FIELD_REACH), for the tens of thousands of scatter queries.
  private readonly gridN: number;
  private readonly gridDist: Float32Array;
  private readonly gridIdx: Int32Array;

  /** Beyond this the distance field reports Infinity. */
  static readonly FIELD_REACH = 30;

  constructor(track: Track, worldSize: number) {
    const n = track.count;
    this.n = n;
    this.worldSize = worldSize;
    this.px = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.h = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = track.points[i * 2];
      this.pz[i] = track.points[i * 2 + 1];
      this.tx[i] = track.tangents[i * 2];
      this.tz[i] = track.tangents[i * 2 + 1];
      this.h[i] = track.roadHeights[i];
    }
    this.s = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.s[i + 1] = this.s[i] + Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
    }
    this.length = this.s[n];

    // Curvature from the turn between the neighbouring tangents, then a
    // circular blur: the raw polyline curvature is noisy at 1 m spacing and
    // bends must be judged over a car length or two, not per sample.
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n;
      const b = (i + 1) % n;
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b];
      const dot = this.tx[a] * this.tx[b] + this.tz[a] * this.tz[b];
      const ds = this.arc(a, b);
      raw[i] = Math.atan2(cross, dot) / (ds || 1);
    }
    this.curv = raw;
    const tmp = new Float32Array(n);
    const R = 3;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -R; k <= R; k++) sum += this.curv[(i + k + n) % n];
        tmp[i] = sum / (2 * R + 1);
      }
      this.curv.set(tmp);
    }

    const gn = Math.ceil(worldSize);
    this.gridN = gn;
    this.gridDist = new Float32Array(gn * gn).fill(Infinity);
    this.gridIdx = new Int32Array(gn * gn).fill(-1);
    const half = worldSize / 2;
    const reach = TrackFrame.FIELD_REACH;
    const best = new Float32Array(gn * gn).fill(reach * reach);
    for (let i = 0; i < n; i++) {
      const x = this.px[i];
      const z = this.pz[i];
      const cx0 = Math.max(0, Math.floor(x - reach + half));
      const cx1 = Math.min(gn - 1, Math.ceil(x + reach + half));
      const cz0 = Math.max(0, Math.floor(z - reach + half));
      const cz1 = Math.min(gn - 1, Math.ceil(z + reach + half));
      for (let cz = cz0; cz <= cz1; cz++) {
        const dz = cz + 0.5 - half - z;
        const dz2 = dz * dz;
        const row = cz * gn;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = cx + 0.5 - half - x;
          const d2 = dx * dx + dz2;
          if (d2 < best[row + cx]) {
            best[row + cx] = d2;
            this.gridIdx[row + cx] = i;
          }
        }
      }
    }
    for (let c = 0; c < gn * gn; c++) {
      if (this.gridIdx[c] >= 0) this.gridDist[c] = Math.sqrt(best[c]);
    }
  }

  /** Forward arc length from point a to point b. */
  private arc(a: number, b: number): number {
    const d = this.s[b] - this.s[a];
    return d >= 0 ? d : d + this.length;
  }

  wrap(s: number): number {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /** Shortest signed arc from s0 to s1 (−L/2 … L/2). */
  delta(s0: number, s1: number): number {
    const L = this.length;
    let d = (s1 - s0) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  /** True if s lies in the forward range s0 → s1 (which may wrap). */
  inRange(s: number, s0: number, s1: number): boolean {
    s = this.wrap(s);
    s0 = this.wrap(s0);
    s1 = this.wrap(s1);
    return s0 <= s1 ? s >= s0 && s <= s1 : s >= s0 || s <= s1;
  }

  /** Segment index i with s[i] ≤ s < s[i+1], and the fraction along it. */
  private locate(s: number): { i: number; t: number } {
    s = this.wrap(s);
    const n = this.n;
    // Spacing is near-uniform, so a proportional guess is one or two steps off.
    let i = Math.min(n - 1, Math.floor((s / this.length) * n));
    while (i > 0 && this.s[i] > s) i--;
    while (i < n - 1 && this.s[i + 1] <= s) i++;
    const len = this.s[i + 1] - this.s[i];
    return { i, t: len > 0 ? (s - this.s[i]) / len : 0 };
  }

  at(s: number): RoadPoint {
    const { i, t } = this.locate(s);
    const j = (i + 1) % this.n;
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t;
    let tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    return {
      x: this.px[i] + (this.px[j] - this.px[i]) * t,
      z: this.pz[i] + (this.pz[j] - this.pz[i]) * t,
      tx,
      tz,
      h: this.h[i] + (this.h[j] - this.h[i]) * t,
      k: this.curv[i] + (this.curv[j] - this.curv[i]) * t,
    };
  }

  /** Point at arc length s, moved `lateral` meters to the left (negative = right). */
  offset(s: number, lateral: number): Vec2 {
    const p = this.at(s);
    return [p.x - p.tz * lateral, p.z + p.tx * lateral];
  }

  /** Exact nearest centreline point (segment projection over the whole loop). */
  nearest(wx: number, wz: number): RoadHit {
    const n = this.n;
    let best = Infinity;
    let bi = 0;
    let bt = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = this.px[i];
      const az = this.pz[i];
      const dx = this.px[j] - ax;
      const dz = this.pz[j] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((wx - ax) * dx + (wz - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = wx - (ax + dx * t);
      const ez = wz - (az + dz * t);
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
      }
    }
    const j = (bi + 1) % n;
    const dx = this.px[j] - this.px[bi];
    const dz = this.pz[j] - this.pz[bi];
    const cross = dx * (wz - this.pz[bi]) - dz * (wx - this.px[bi]);
    return {
      index: bt < 0.5 ? bi : j,
      s: this.wrap(this.s[bi] + (this.s[bi + 1] - this.s[bi]) * bt),
      dist: Math.sqrt(best),
      side: cross >= 0 ? 1 : -1,
    };
  }

  /**
   * Distance to the centreline from the 1 m field (bilinear): good to a few
   * centimetres, Infinity beyond FIELD_REACH. For scatter masks.
   */
  fastDist(wx: number, wz: number): number {
    const gn = this.gridN;
    const half = this.worldSize / 2;
    const fx = Math.min(Math.max(wx + half - 0.5, 0), gn - 1.001);
    const fz = Math.min(Math.max(wz + half - 0.5, 0), gn - 1.001);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const g = this.gridDist;
    const i = z0 * gn + x0;
    const d00 = g[i];
    const d10 = g[i + 1];
    const d01 = g[i + gn];
    const d11 = g[i + gn + 1];
    // One Infinity corner would poison the interpolation; near the reach
    // limit the exact value does not matter, so fall back to the minimum.
    if (d00 === Infinity || d10 === Infinity || d01 === Infinity || d11 === Infinity) {
      return Math.min(d00, d10, d01, d11);
    }
    return (d00 * (1 - tx) + d10 * tx) * (1 - tz) + (d01 * (1 - tx) + d11 * tx) * tz;
  }

  /** Track point nearest to the centre of the 1 m cell holding the query
   * (−1 beyond FIELD_REACH). */
  fastIndex(wx: number, wz: number): number {
    const gn = this.gridN;
    const half = this.worldSize / 2;
    const cx = Math.min(Math.max(Math.floor(wx + half), 0), gn - 1);
    const cz = Math.min(Math.max(Math.floor(wz + half), 0), gn - 1);
    return this.gridIdx[cz * gn + cx];
  }

  /** Side of the road a point lies on, judged at track point `index`. */
  sideAt(index: number, wx: number, wz: number): 1 | -1 {
    const cross = this.tx[index] * (wz - this.pz[index]) - this.tz[index] * (wx - this.px[index]);
    return cross >= 0 ? 1 : -1;
  }

  /**
   * Bends = runs where |curvature| stays above `threshold`. Runs separated
   * by less than `mergeGap` meters and turning the same way are one bend;
   * a run that turns less than `minAngle` radians in all is a kink, not a
   * bend, and is dropped.
   */
  findBends(threshold: number, mergeGap = 5, minAngle = 0.42): Bend[] {
    const n = this.n;
    const sign = (i: number): number => (Math.abs(this.curv[i]) >= threshold ? (this.curv[i] > 0 ? 1 : -1) : 0);
    // Start scanning at a point that is NOT inside a bend so no run wraps.
    let start = 0;
    while (start < n && sign(start) !== 0) start++;
    if (start === n) start = 0;
    const runs: { a: number; b: number; dir: number }[] = [];
    let i = 0;
    while (i < n) {
      const idx = (start + i) % n;
      const dir = sign(idx);
      if (dir === 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && sign((start + j + 1) % n) === dir) j++;
      runs.push({ a: (start + i) % n, b: (start + j) % n, dir });
      i = j + 1;
    }
    const merged: { a: number; b: number; dir: number }[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.dir === r.dir && this.arc(last.b, r.a) < mergeGap) last.b = r.b;
      else merged.push({ ...r });
    }
    const bends: Bend[] = [];
    for (const r of merged) {
      let apex = r.a;
      let angle = 0;
      for (let k = r.a; ; k = (k + 1) % n) {
        if (Math.abs(this.curv[k]) > Math.abs(this.curv[apex])) apex = k;
        angle += Math.abs(this.curv[k]) * (this.s[k + 1] - this.s[k]);
        if (k === r.b) break;
      }
      if (angle < minAngle) continue;
      bends.push({
        s0: this.s[r.a],
        s1: this.s[r.b],
        apexS: this.s[apex],
        direction: r.dir > 0 ? 'left' : 'right',
        minRadius: 1 / Math.abs(this.curv[apex]),
        angle,
      });
    }
    return bends;
  }
}
