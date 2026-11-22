import { Heightfield } from '../terrain/Heightfield';
import type { Track } from '../terrain/track';
import { clamp, smoothstep, toLocal } from './geom';
import { TrackFrame } from './trackFrame';
import type { HeightSampler, Placement, TerrainModifier, WorldPlan } from './types';

/**
 * Terrain side of the plan: the modifiers `planWorld` emits are applied to a
 * heightfield here, by the planner itself (on a private copy, to know the
 * final ground height under every placement) and by the terrain generator at
 * integration time (on the real field, before splat / AO / mesh).
 */

/** Sample-for-sample copy of a Heightfield, or a 256² resample of any sampler. */
export function copyHeightfield(src: HeightSampler): Heightfield {
  const asField = src as Partial<Heightfield>;
  if (asField.heights instanceof Float32Array && typeof asField.n === 'number') {
    const out = new Heightfield(asField.n, src.size);
    out.heights.set(asField.heights);
    return out;
  }
  const n = 256;
  const out = new Heightfield(n, src.size);
  const half = src.size / 2;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      out.set(ix, iz, src.getHeight(-half + ix * out.step, -half + iz * out.step));
    }
  }
  return out;
}

/** Weight 0..1 of a flatten pad at a world point (1 inside the rectangle). */
export function flattenWeight(m: Extract<TerrainModifier, { kind: 'flatten' }>, wx: number, wz: number): number {
  const [lx, lz] = toLocal(m.x, m.z, m.yaw, wx, wz);
  // Overshoot past each edge, measured in units of THAT edge's falloff so a
  // retaining-wall edge can be steep while the open sides ease out gently.
  // Local +x is the building's right-hand side seen from behind it, i.e.
  // `right`; local −z is its front.
  const ox = lx > 0 ? (lx - m.halfX) / m.falloff.right : (-lx - m.halfX) / m.falloff.left;
  const oz = lz > 0 ? (lz - m.halfZ) / m.falloff.back : (-lz - m.halfZ) / m.falloff.front;
  const u = Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
  return u >= 1 ? 0 : 1 - smoothstep(0, 1, u);
}

/** How far around a flatten pad its influence reaches (bounding radius). */
function flattenReach(m: Extract<TerrainModifier, { kind: 'flatten' }>): number {
  const f = Math.max(m.falloff.front, m.falloff.back, m.falloff.left, m.falloff.right);
  return Math.hypot(m.halfX + f, m.halfZ + f);
}

export interface ApplyOptions {
  /** Reuse a frame built for the same track (saves ~3 ms). */
  frame?: TrackFrame;
  /** Road half width the plan was made for; modifiers never touch the
   * drivable surface of ANY part of the loop. */
  roadHalfWidth: number;
}

/**
 * Apply the plan's terrain modifiers to `hf` IN PLACE, in plan order.
 * Call it after the road carve and before anything derived from heights
 * (splat, AO, baked shadows, mesh, physics heightfield).
 *
 * The drivable road is protected: inside the road every weight is forced to
 * 0 and ramps up over the first 1.5 m beyond the edge, so a pad whose blend
 * skirt reaches a neighbouring piece of the loop cannot dent it.
 */
export function applyTerrainModifiers(
  hf: Heightfield,
  modifiers: readonly TerrainModifier[],
  track: Track,
  options: ApplyOptions,
): void {
  const frame = options.frame ?? new TrackFrame(track, hf.size);
  const hw = options.roadHalfWidth;
  const n = hf.n;
  const half = hf.size / 2;
  const step = hf.step;
  const protect = (wx: number, wz: number): number => smoothstep(hw, hw + 1.5, frame.fastDist(wx, wz));
  let buckets: PointBuckets | undefined;

  for (const m of modifiers) {
    if (m.kind === 'flatten') {
      const reach = flattenReach(m);
      const ix0 = Math.max(0, Math.floor((m.x - reach + half) / step));
      const ix1 = Math.min(n - 1, Math.ceil((m.x + reach + half) / step));
      const iz0 = Math.max(0, Math.floor((m.z - reach + half) / step));
      const iz1 = Math.min(n - 1, Math.ceil((m.z + reach + half) / step));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const wx = -half + ix * step;
          const wz = -half + iz * step;
          let w = flattenWeight(m, wx, wz);
          if (w <= 0) continue;
          w *= protect(wx, wz);
          const i = iz * n + ix;
          hf.heights[i] += (m.height - hf.heights[i]) * w;
        }
      }
    } else {
      // Corridor: walk the track points of the range and visit the samples
      // around each. A sample is levelled to the road height of the track
      // points NEAREST to it — plural: a soft minimum over every point
      // within CORRIDOR_SOFTNESS of the nearest distance, weighted
      // (1 − (dᵢ − d) / CORRIDOR_SOFTNESS)².
      //
      // Taking the single nearest point would be simpler, and is wrong
      // wherever two stretches of road are about equally near: on the
      // inside of a bend, and between two legs of the loop. There "the
      // nearest point" jumps from one stretch to the other, and with it the
      // height (roads climb through bends) and whether the point belongs to
      // this corridor at all — a cliff along the seam, right where the
      // village fence runs. The soft minimum makes height AND membership
      // (range, side, taper) change over a couple of meters instead.
      buckets ??= new PointBuckets(frame);
      const { head, next, cells, cellSize } = buckets;
      const { px, pz, tx, tz } = frame;
      const span = frame.wrap(m.s1 - m.s0);
      // Per track point: how much it belongs to this corridor's range.
      const along = new Float32Array(frame.n);
      for (let j = 0; j < frame.n; j++) {
        const dsj = frame.wrap(frame.s[j] - m.s0);
        if (dsj > span) continue;
        along[j] = m.taper > 0 ? Math.max(1e-6, smoothstep(0, m.taper, dsj) * smoothstep(0, m.taper, span - dsj)) : 1;
      }
      // Per track point: how much wider the band is there (`widen`); a
      // sample's outer edge is the same soft blend over its nearest points
      // as its height, so the edge moves smoothly along the road.
      let wider: Float32Array | undefined;
      let maxWiden = 0;
      if (m.widen && m.widen.by > 0) {
        const wd = m.widen;
        wider = new Float32Array(frame.n);
        maxWiden = wd.by;
        const wspan = frame.wrap(wd.s1 - wd.s0);
        for (let j = 0; j < frame.n; j++) {
          const dsj = frame.wrap(frame.s[j] - wd.s0);
          if (dsj > wspan) continue;
          wider[j] = wd.by * (wd.taper > 0 ? smoothstep(0, wd.taper, dsj) * smoothstep(0, wd.taper, wspan - dsj) : 1);
        }
      }
      const reach = m.outer + maxWiden + m.falloff;
      const visited = new Uint8Array(n * n);
      for (let k = 0; k < frame.n; k++) {
        if (along[k] === 0) continue;
        const ix0 = Math.max(0, Math.floor((px[k] - reach + half) / step));
        const ix1 = Math.min(n - 1, Math.ceil((px[k] + reach + half) / step));
        const iz0 = Math.max(0, Math.floor((pz[k] - reach + half) / step));
        const iz1 = Math.min(n - 1, Math.ceil((pz[k] + reach + half) / step));
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const i = iz * n + ix;
            if (visited[i]) continue;
            visited[i] = 1;
            const wx = -half + ix * step;
            const wz = -half + iz * step;
            const d = frame.fastDist(wx, wz);
            // (The road itself is protected: nothing to do on it.)
            if (!(d > hw) || d >= reach) continue;
            const r = d + CORRIDOR_SOFTNESS;
            const r2 = r * r;
            const cx0 = Math.max(0, Math.floor((wx - r + half) / cellSize));
            const cx1 = Math.min(cells - 1, Math.floor((wx + r + half) / cellSize));
            const cz0 = Math.max(0, Math.floor((wz - r + half) / cellSize));
            const cz1 = Math.min(cells - 1, Math.floor((wz + r + half) / cellSize));
            let all = 0;
            let mine = 0;
            let height = 0;
            let widen = 0;
            for (let cz = cz0; cz <= cz1; cz++) {
              for (let cx = cx0; cx <= cx1; cx++) {
                for (let j = head[cz * cells + cx]; j >= 0; j = next[j]) {
                  const dx = wx - px[j];
                  const dz = wz - pz[j];
                  const d2 = dx * dx + dz * dz;
                  if (d2 >= r2) continue;
                  const t = 1 - (Math.sqrt(d2) - d) / CORRIDOR_SOFTNESS;
                  // (A point can be a hair nearer than the field's bilinear d.)
                  const a = t >= 1 ? 1 : t * t;
                  all += a;
                  if (along[j] === 0) continue;
                  // Left of travel at point j ⇔ cross(tangent, offset) ≥ 0.
                  if (m.side !== 0 && (tx[j] * dz - tz[j] * dx >= 0 ? 1 : -1) !== m.side) continue;
                  mine += a * along[j];
                  height += a * along[j] * frame.h[j];
                  if (wider) widen += a * along[j] * wider[j];
                }
              }
            }
            if (mine <= 0) continue;
            const outer = m.outer + widen / mine;
            const across = 1 - smoothstep(outer, outer + m.falloff, d);
            const w = across * (mine / all) * protect(wx, wz);
            if (w <= 0) continue;
            const shift = height / mine - hf.heights[i];
            hf.heights[i] += (m.limit !== undefined ? clamp(shift, -m.limit, m.limit) : shift) * w;
          }
        }
      }
    }
  }
}

/** Meters over which a corridor's "nearest road point" is blended (see
 * applyTerrainModifiers). */
const CORRIDOR_SOFTNESS = 3;

/** Track points in a coarse grid (per-cell linked lists), for "every point
 * within r of here". */
class PointBuckets {
  readonly cellSize = 6;
  readonly cells: number;
  readonly head: Int32Array;
  readonly next: Int32Array;

  constructor(frame: TrackFrame) {
    const half = frame.worldSize / 2;
    this.cells = Math.ceil(frame.worldSize / this.cellSize);
    this.head = new Int32Array(this.cells * this.cells).fill(-1);
    this.next = new Int32Array(frame.n);
    const cell = (v: number): number => Math.min(this.cells - 1, Math.max(0, Math.floor((v + half) / this.cellSize)));
    for (let i = 0; i < frame.n; i++) {
      const c = cell(frame.pz[i]) * this.cells + cell(frame.px[i]);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }
}

/**
 * Widen the road carve of an already carved heightfield IN PLACE: flat at
 * the road's height out to `halfWidth`, blended back to the existing ground
 * over `shoulder` — the same rule as the terrain generator's own carve
 * (src/terrain/generateTerrain.ts, carveTrack), which only knows
 * `track.halfWidth`.
 *
 * The planner must be given terrain carved to the width it plans for. This
 * is how the lab and the self-check sweep get a 5 m road out of today's
 * 3.5 m track; the game should instead widen `track.halfWidth` at the source
 * (the splat's road channel and the edge tint follow it there, not here).
 */
export function recarveRoad(hf: Heightfield, track: Track, halfWidth: number, shoulder = track.shoulder, frame?: TrackFrame): void {
  const f = frame ?? new TrackFrame(track, hf.size);
  const n = hf.n;
  const half = hf.size / 2;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const idx = f.fastIndex(wx, wz);
      if (idx < 0) continue;
      // Distance to the nearest track POINT, as the generator's carve uses.
      const d = Math.hypot(f.px[idx] - wx, f.pz[idx] - wz);
      if (d >= halfWidth + shoulder) continue;
      const blend = 1 - smoothstep(halfWidth, halfWidth + shoulder, d);
      const i = iz * n + ix;
      hf.heights[i] += (f.h[idx] - hf.heights[i]) * blend;
    }
  }
}

/** Apply a whole plan's modifiers (convenience for the terrain generator). */
export function applyPlanToTerrain(hf: Heightfield, plan: WorldPlan, track: Track, frame?: TrackFrame): void {
  applyTerrainModifiers(hf, plan.terrainModifiers, track, { frame, roadHalfWidth: plan.road.halfWidth });
}

/**
 * Re-read the ground height under every placement from the FINAL terrain.
 * `planWorld` already fills `y` from its own modified copy; call this when
 * the terrain changed afterwards (road re-carved wider, extra smoothing) so
 * nothing floats or sinks. Lots keep their pad height.
 */
export function resamplePlanHeights(plan: WorldPlan, terrain: HeightSampler): void {
  const fix = (p: Placement): void => {
    p.y = Math.round(terrain.getHeight(p.x, p.z) * 1000) / 1000;
  };
  for (const p of plan.dressing) {
    // The gantry stands on the road surface, which the planner takes from
    // the track profile (exact), not from the terrain grid (bilinear).
    if (p.role === 'start-gantry') continue;
    fix(p);
  }
  for (const p of plan.nature) fix(p);
}
