import type { WorldData } from '../game/contracts/world';
import { applyPlanToTerrain, catalogEntry, copyHeightfield, measureRoadCarve, planWorld, recarveRoad, TrackFrame } from '../world';
import type { WorldPlan } from '../world';
import { obbDistance, pointInPolygon, polygonEdgeDistance } from '../world/geom';
import { Heightfield, clamp, smoothstep } from './Heightfield';
import { Noise2D } from './noise';
import { generateTrack } from './track';
import type { Track } from './track';

/**
 * The generated world as plain data (contract: `WorldData`, src/game/contracts/world.ts):
 * heightfield (road carved, plan modifiers applied), track, world plan,
 * splat, shade, paved, timings. Only GAINS fields over the legacy shape, so
 * the old terrain mesh / scatter path keeps running on it.
 */
export interface TerrainData extends WorldData {}

export const TERRAIN_SAMPLES = 256;
export const TERRAIN_SIZE = 200;

/** Direction TOWARD the sun (normalized). Low side angle (~46° elevation) so
 * slopes get distinct toon bands even when viewed from above — a straight-down
 * sun collapses the whole map into one band. Shared by the terrain shader,
 * the baked shadow march below, and the scene's DirectionalLight. */
export const SUN_DIR = normalize({ x: -0.5, y: 0.72, z: -0.48 });

function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** The planner's input: terrain with the road carved and the spawn shift
 * applied, BEFORE the plan's modifiers. */
export interface BaseTerrain {
  heightfield: Heightfield;
  track: Track;
  /** The same terrain before the carve (same spawn shift): what the road was
   * cut into / filled over. */
  natural: Heightfield;
  /** Per sample: index of the nearest track point (−1 beyond the shoulder). */
  nearestPoint: Int32Array;
  timings: Record<string, number>;
}

/**
 * Base noise + rim bowl → new track → road carve at track.halfWidth → shift
 * so the road at the start line is y = 0. Deterministic per seed, nothing
 * cached between calls.
 */
export function generateBaseTerrain(seed: number): BaseTerrain {
  const timings: Record<string, number> = {};
  let t0 = performance.now();

  const n = TERRAIN_SAMPLES;
  const hf = new Heightfield(n, TERRAIN_SIZE);
  const half = TERRAIN_SIZE / 2;
  const noise = new Noise2D(seed);

  // Base: rolling hills (wavelength ~70 m), medium undulation, small bumps
  // that keep the suspension busy off-road, plus a containment rim that turns
  // the whole map into a shallow bowl — the diorama edge, no walls needed.
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      let h = 4.5 * noise.fbm(wx / 70, wz / 70, 4);
      h += 0.5 * noise.sample(wx / 11, wz / 11);
      h += 0.1 * noise.sample(wx / 3.2, wz / 3.2);
      const edge = Math.max(Math.abs(wx), Math.abs(wz));
      const rim = smoothstep(72, 98, edge);
      h += rim * (10 + 3 * noise.sample(wx / 25, wz / 25));
      hf.set(ix, iz, h);
    }
  }
  timings.baseNoise = performance.now() - t0;

  t0 = performance.now();
  const track = generateTrack(seed, hf);
  timings.track = performance.now() - t0;

  t0 = performance.now();
  const natural = copyHeightfield(hf);
  const nearestPoint = carveTrack(hf, track);
  // Shift the whole field so the road at the spawn point (track point 0 ==
  // world origin) sits at y = 0 — cars spawn at a hardcoded height.
  const spawnH = track.roadHeights[0];
  for (let i = 0; i < hf.heights.length; i++) {
    hf.heights[i] -= spawnH;
    natural.heights[i] -= spawnH;
  }
  for (let i = 0; i < track.roadHeights.length; i++) track.roadHeights[i] -= spawnH;
  // The planner refuses (warns about) a carve narrower than the road it
  // plans; the generator's own carve should always pass — re-carve if not.
  // (Heights only, inside the same halfWidth + shoulder footprint of the same
  // track: `sampleRoadDist` and `nearestPoint` are planar distances to the
  // track points and stay valid.)
  if (measureRoadCarve(new TrackFrame(track, hf.size), hf, track.halfWidth) > 0.1) recarveRoad(hf, track, track.halfWidth);
  timings.carve = performance.now() - t0;

  return { heightfield: hf, track, natural, nearestPoint, timings };
}

/** Pure CPU-side generation of the whole world (see `WorldData` for the
 * fixed pipeline order). No Babylon types in here so it can move to a worker
 * (or run headless for tests) as is. */
export function generateTerrain(seed: number): TerrainData {
  const tStart = performance.now();
  const base = generateBaseTerrain(seed);
  const { heightfield: hf, track, nearestPoint } = base;
  const timings: Record<string, number> = { ...base.timings };
  const macroNoise = new Noise2D(seed + 101);

  let t0 = performance.now();
  const plan = planWorld({ track, heightfield: hf, seed });
  timings.plan = performance.now() - t0;

  t0 = performance.now();
  const frame = new TrackFrame(track, hf.size);
  applyPlanToTerrain(hf, plan, track, frame);
  timings.modifiers = performance.now() - t0;

  t0 = performance.now();
  const padMask = rasterizePads(hf, plan);
  const splat = buildSplat(hf, track, macroNoise, plan, frame, nearestPoint);
  timings.splat = performance.now() - t0;

  t0 = performance.now();
  const paved = buildPaved(hf, track, plan, nearestPoint, padMask);
  timings.paved = performance.now() - t0;

  t0 = performance.now();
  const ao = buildAO(hf);
  timings.ao = performance.now() - t0;

  t0 = performance.now();
  const tint = new Float32Array(hf.n * hf.n).fill(1);
  stampContacts(hf, plan, ao, tint);
  timings.stamps = performance.now() - t0;

  t0 = performance.now();
  const sunVis = buildSunVisibility(hf);
  timings.sunShadow = performance.now() - t0;

  // Interleave into one vertex buffer: [ao, sunVis, tint] per sample.
  const shade = new Float32Array(hf.n * hf.n * 3);
  for (let i = 0; i < hf.n * hf.n; i++) {
    shade[i * 3] = ao[i];
    shade[i * 3 + 1] = sunVis[i];
    shade[i * 3 + 2] = tint[i];
  }
  timings.total = performance.now() - tStart;

  return { seed, heightfield: hf, track, plan, splat, shade, paved, timings };
}

/** Bilinear sample of the splat weights at a world position → out (RGBA =
 * grass, rock, dirt road, meadow; sums to 1). Matches the interpolation the
 * GPU does with the per-vertex colors, so CPU consumers (wheel dust) agree
 * with the rendered surface. Clamps outside the field. */
export function sampleSplat(data: TerrainData, wx: number, wz: number, out: Float32Array): void {
  const hf = data.heightfield;
  const half = hf.size / 2;
  const fx = clamp((wx + half) / hf.step, 0, hf.n - 1.001);
  const fz = clamp((wz + half) / hf.step, 0, hf.n - 1.001);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const i00 = (z0 * hf.n + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + hf.n * 4;
  const i11 = i01 + 4;
  const s = data.splat;
  for (let c = 0; c < 4; c++) {
    out[c] =
      (s[i00 + c] * (1 - tx) + s[i10 + c] * tx) * (1 - tz) +
      (s[i01 + c] * (1 - tx) + s[i11 + c] * tx) * tz;
  }
}

/** Bilinear sample of `paved` (0..1) at a world position. Clamps outside the field. */
export function samplePaved(data: Pick<TerrainData, 'heightfield' | 'paved'>, wx: number, wz: number): number {
  const hf = data.heightfield;
  const half = hf.size / 2;
  const fx = clamp((wx + half) / hf.step, 0, hf.n - 1.001);
  const fz = clamp((wz + half) / hf.step, 0, hf.n - 1.001);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const i = z0 * hf.n + x0;
  const p = data.paved;
  return (p[i] * (1 - tx) + p[i + 1] * tx) * (1 - tz) + (p[i + hf.n] * (1 - tx) + p[i + hf.n + 1] * tx) * tz;
}

/** Baked terrain self-shadow: march toward the sun and compare the horizon
 * angle against the sun elevation. Soft penumbra via smoothstep in tan space.
 * Terrain only — props cast real shadows now. */
function buildSunVisibility(hf: Heightfield): Float32Array {
  const n = hf.n;
  const half = hf.size / 2;
  const out = new Float32Array(n * n);
  const hLen = Math.hypot(SUN_DIR.x, SUN_DIR.z);
  const sx = SUN_DIR.x / hLen;
  const sz = SUN_DIR.z / hLen;
  const tanElev = SUN_DIR.y / hLen;
  // Log-spaced steps out to ~45 m: near steps catch crisp local shadows,
  // far steps catch the long soft ones from the rim.
  const steps: number[] = [];
  for (let t = 1.2; t < 45; t *= 1.35) steps.push(t);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const h = hf.at(ix, iz);
      let maxTan = 0;
      for (const t of steps) {
        // Small bias so a surface never shadows itself with its own bumps.
        const tan = (hf.getHeight(wx + sx * t, wz + sz * t) - h - 0.1) / t;
        if (tan > maxTan) maxTan = tan;
      }
      out[iz * n + ix] = 1 - 0.85 * smoothstep(tanElev * 0.9, tanElev * 1.35, maxTan);
    }
  }
  return out;
}

/** Distance-field carve: flatten toward the smoothed road profile inside
 * halfWidth, smoothstep-blend across the shoulder. A coarse bucket grid keeps
 * this O(samples × nearby points) instead of O(samples × whole polyline).
 * Fills `track.sampleRoadDist`; returns the nearest track point per sample. */
function carveTrack(hf: Heightfield, track: Track): Int32Array {
  const n = hf.n;
  const half = hf.size / 2;
  const maxDist = track.halfWidth + track.shoulder;

  const CELL = 8;
  const cells = Math.ceil(hf.size / CELL);
  const buckets: number[][] = Array.from({ length: cells * cells }, () => []);
  // A polyline point influences samples within maxDist, so register it in
  // every cell whose center is within maxDist + half a cell diagonal.
  const reach = maxDist + CELL * 0.71;
  for (let i = 0; i < track.count; i++) {
    const px = track.points[i * 2];
    const pz = track.points[i * 2 + 1];
    const c0x = clamp(Math.floor((px - reach + half) / CELL), 0, cells - 1);
    const c1x = clamp(Math.floor((px + reach + half) / CELL), 0, cells - 1);
    const c0z = clamp(Math.floor((pz - reach + half) / CELL), 0, cells - 1);
    const c1z = clamp(Math.floor((pz + reach + half) / CELL), 0, cells - 1);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        buckets[cz * cells + cx].push(i);
      }
    }
  }

  const roadDist = new Float32Array(n * n).fill(Infinity);
  const nearest = new Int32Array(n * n).fill(-1);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const cx = clamp(Math.floor((wx + half) / CELL), 0, cells - 1);
      const cz = clamp(Math.floor((wz + half) / CELL), 0, cells - 1);
      const candidates = buckets[cz * cells + cx];
      let best = Infinity;
      let bestI = -1;
      for (const i of candidates) {
        const dx = track.points[i * 2] - wx;
        const dz = track.points[i * 2 + 1] - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bestI = i;
        }
      }
      if (bestI < 0) continue;
      const d = Math.sqrt(best);
      if (d >= maxDist) continue;
      const idx = iz * n + ix;
      roadDist[idx] = d;
      nearest[idx] = bestI;
      const blend = 1 - smoothstep(track.halfWidth, maxDist, d);
      hf.heights[idx] = hf.heights[idx] * (1 - blend) + track.roadHeights[bestI] * blend;
    }
  }
  track.sampleRoadDist = roadDist;
  return nearest;
}

/** 1 per heightfield sample inside any of the plan's paved pads, else 0. */
function rasterizePads(hf: Heightfield, plan: WorldPlan): Uint8Array {
  const n = hf.n;
  const half = hf.size / 2;
  const mask = new Uint8Array(n * n);
  for (const pad of plan.pads) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of pad.polygon) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const ix0 = clamp(Math.floor((x0 + half) / hf.step), 0, n - 1);
    const ix1 = clamp(Math.ceil((x1 + half) / hf.step), 0, n - 1);
    const iz0 = clamp(Math.floor((z0 + half) / hf.step), 0, n - 1);
    const iz1 = clamp(Math.ceil((z1 + half) / hf.step), 0, n - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (pointInPolygon(pad.polygon, -half + ix * hf.step, -half + iz * hf.step)) mask[iz * n + ix] = 1;
      }
    }
  }
  return mask;
}

/** Worn dirt edge beyond the paving (kerb outer edge, pad outline): the
 * grass / dirt crossing (dirt weight 0.5) sits this far out, ± FRINGE_WANDER. */
const FRINGE_MID = 0.1;
const FRINGE_WANDER = 0.12;
/** Width of the linear dirt ramp across that crossing, m. The splat is
 * per-vertex (0.78 m cells) and the ground shader's height-aware blend makes
 * the 0.5 crossing a hard-ish edge: a ramp narrower than about two cells (or
 * the old binary pad mask) lets the triangle grid draw that edge as a
 * staircase. A linear field over ≥ 1.4 m interpolates exactly between
 * vertices, so the edge follows the outline instead of the grid; the
 * height-aware blend (dirt stands proud of grass: it still shows down to a
 * weight of about 0.3) then breaks it into a ragged 0.3–0.6 m worn strip. */
const FRINGE_RAMP = 1.3;

/** RGBA splat per sample: R grass, G rock (steep slopes), B dirt road, A
 * meadow patches (macro noise), from the FINAL heights. The road channel is
 * dirt under the whole loop and under every paved pad (cobbles, pavers and
 * asphalt are meshes on top), and fades out in a narrow, noisy worn edge
 * just beyond the kerb's outer edge and round each pad's outline. */
function buildSplat(hf: Heightfield, track: Track, macro: Noise2D, plan: WorldPlan, frame: TrackFrame, nearest: Int32Array): Float32Array {
  const n = hf.n;
  const half = hf.size / 2;
  const out = new Float32Array(n * n * 4);
  const roadDist = track.sampleRoadDist!;
  const hw = track.halfWidth;
  const maxDist = hw + track.shoulder;
  // Kerb outer edge per track point and side (the plan's kerb sections).
  const count = track.count;
  const edgeL = new Float32Array(count).fill(hw + 0.5);
  const edgeR = new Float32Array(count).fill(hw + 0.5);
  if (frame.n === count) {
    for (const kb of plan.road.kerbs) {
      const edge = kb.side === 1 ? edgeL : edgeR;
      for (let i = 0; i < count; i++) if (frame.inRange(frame.s[i], kb.s0, kb.s1)) edge[i] = hw + kb.width;
    }
  }
  const wander = (wx: number, wz: number): number => clamp(macro.fbm(wx / 2.4 + 57.3, wz / 2.4 - 21.9, 2) * 1.6, -1, 1) * FRINGE_WANDER;
  const ramp = (d: number, edge: number, wx: number, wz: number): number => clamp(0.5 - (d - edge - FRINGE_MID - wander(wx, wz)) / FRINGE_RAMP, 0, 1);

  // Dirt from the road: 1 on the carriageway, the worn edge beyond the kerb.
  const dirt = new Float32Array(n * n);
  /** Distance beyond the kerb's outer edge (Infinity off the road's reach). */
  const beyondKerb = new Float32Array(n * n).fill(Infinity);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      const d = roadDist[idx];
      if (!(d < maxDist)) continue;
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const i = nearest[idx];
      if (i < 0) continue;
      const side = (wx - track.points[i * 2]) * -track.tangents[i * 2 + 1] + (wz - track.points[i * 2 + 1]) * track.tangents[i * 2] >= 0 ? 1 : -1;
      const edge = side === 1 ? edgeL[i] : edgeR[i];
      beyondKerb[idx] = d - edge;
      dirt[idx] = d <= hw ? 1 : ramp(d, edge, wx, wz);
    }
  }
  // And round every pad: signed distance to its outline (negative inside).
  const reach = FRINGE_MID + FRINGE_WANDER + FRINGE_RAMP / 2 + hf.step;
  for (const pad of plan.pads) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of pad.polygon) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const ix0 = clamp(Math.floor((x0 - reach + half) / hf.step), 0, n - 1);
    const ix1 = clamp(Math.ceil((x1 + reach + half) / hf.step), 0, n - 1);
    const iz0 = clamp(Math.floor((z0 - reach + half) / hf.step), 0, n - 1);
    const iz1 = clamp(Math.ceil((z1 + reach + half) / hf.step), 0, n - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = -half + ix * hf.step;
        const wz = -half + iz * hf.step;
        const e = polygonEdgeDistance(pad.polygon, wx, wz);
        const d = pointInPolygon(pad.polygon, wx, wz) ? -e : e;
        if (d > reach) continue;
        const idx = iz * n + ix;
        // Where a pad meets the road (or a path runs up to the kerb) the
        // pad's worn edge fades out: no dirt bridge between pad and kerb.
        dirt[idx] = Math.max(dirt[idx], ramp(d, 0, wx, wz) * smoothstep(0.4, 1.6, beyondKerb[idx]));
      }
    }
  }

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const road = dirt[idx];
      // Rock and meadow stay off the road's banks as before (the carve
      // shoulder): grass, not scree, meets the worn edge.
      const verge = Math.max(road, 1 - smoothstep(hw * 0.9, maxDist * 0.9, roadDist[idx]));
      const slope = hf.slopeAt(ix, iz);
      const rock = smoothstep(0.55, 0.95, slope) * (1 - verge);
      const meadow = smoothstep(0.15, 0.45, macro.fbm(wx / 40 + 31, wz / 40 - 17, 3)) * (1 - verge) * (1 - rock);
      const grass = Math.max(0, 1 - road - rock - meadow);
      const sum = road + rock + meadow + grass;
      out[idx * 4] = grass / sum;
      out[idx * 4 + 1] = rock / sum;
      out[idx * 4 + 2] = road / sum;
      out[idx * 4 + 3] = meadow / sum;
    }
  }
  return out;
}

/** Paving per sample: on the drivable road the plan's cobble weight of the
 * nearest track point (eased over ±0.5 m at the road edge), inside a pad 1. */
function buildPaved(hf: Heightfield, track: Track, plan: WorldPlan, nearest: Int32Array, padMask: Uint8Array): Float32Array {
  const out = new Float32Array(hf.n * hf.n);
  const roadDist = track.sampleRoadDist!;
  const hw = track.halfWidth;
  const cobble = plan.road.cobble;
  for (let i = 0; i < out.length; i++) {
    if (padMask[i]) {
      out[i] = 1;
      continue;
    }
    const k = nearest[i];
    if (k < 0) continue;
    const c = cobble[k];
    if (!(c > 0)) continue;
    out[i] = c * (1 - smoothstep(hw - 0.5, hw + 0.5, roadDist[i]));
  }
  return out;
}

/** Contact AO from the plan, multiplied into `ao`: under every tree canopy,
 * under every large rock, and a band round every building's body. Overlaps
 * multiply; floor AO_FLOOR. Trees also tint the ground slightly darker. */
const AO_FLOOR = 0.35;
const TINT_FLOOR = 0.85;
function stampContacts(hf: Heightfield, plan: WorldPlan, ao: Float32Array, tint: Float32Array): void {
  const n = hf.n;
  const half = hf.size / 2;
  const step = hf.step;
  const disc = (
    x: number,
    z: number,
    r: number,
    inner: number,
    aoDepth: number,
    tintDepth: number,
  ): void => {
    const ix0 = clamp(Math.floor((x - r + half) / step), 0, n - 1);
    const ix1 = clamp(Math.ceil((x + r + half) / step), 0, n - 1);
    const iz0 = clamp(Math.floor((z - r + half) / step), 0, n - 1);
    const iz1 = clamp(Math.ceil((z + r + half) / step), 0, n - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = -half + iz * step - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = -half + ix * step - x;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= r) continue;
        const w = 1 - smoothstep(inner, r, d);
        const i = iz * n + ix;
        ao[i] *= 1 - aoDepth * w;
        if (tintDepth > 0) tint[i] *= 1 - tintDepth * smoothstep(0, 1, w * 1.6);
      }
    }
  };

  for (const p of plan.nature) {
    const e = catalogEntry(p.asset);
    if (e.category === 'tree') {
      // About 0.6 at the trunk, open again at 1.15 × the canopy radius.
      const r = e.spreadRadius * p.scale * 1.15;
      disc(p.x, p.z, r, r * 0.12, 0.4, 0.07);
    } else if (e.category === 'large-rock') {
      const r = e.collisionRadius * p.scale * 1.2;
      disc(p.x, p.z, r, r * 0.5, 0.35, 0);
    }
  }

  // Buildings: about 0.65 at the wall, open 1.2 m out.
  const BAND = 1.2;
  for (const lot of plan.lots) {
    const obb = { x: lot.x, z: lot.z, yaw: lot.yaw, hx: lot.bodyHalfX, hz: lot.bodyHalfZ };
    const reach = Math.hypot(lot.bodyHalfX, lot.bodyHalfZ) + BAND;
    const ix0 = clamp(Math.floor((lot.x - reach + half) / step), 0, n - 1);
    const ix1 = clamp(Math.ceil((lot.x + reach + half) / step), 0, n - 1);
    const iz0 = clamp(Math.floor((lot.z - reach + half) / step), 0, n - 1);
    const iz1 = clamp(Math.ceil((lot.z + reach + half) / step), 0, n - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = obbDistance(obb, -half + ix * step, -half + iz * step);
        if (d >= BAND) continue;
        ao[iz * n + ix] *= 1 - 0.35 * (1 - smoothstep(0, BAND, d));
      }
    }
  }

  for (let i = 0; i < ao.length; i++) {
    if (ao[i] < AO_FLOOR) ao[i] = AO_FLOOR;
    if (tint[i] < TINT_FLOOR) tint[i] = TINT_FLOOR;
  }
}

/** Multi-scale "cavity" AO: a sample is occluded to the degree its
 * neighborhood average (at several radii) sits above it. Low-frequency by
 * nature, so heightmap-resolution per-vertex data is all we need. */
function buildAO(hf: Heightfield): Float32Array {
  const n = hf.n;
  const ao = new Float32Array(n * n).fill(1);
  const scales = [
    { radius: 2, strength: 0.5 },
    { radius: 5, strength: 0.35 },
    { radius: 12, strength: 0.25 },
  ];
  const blurred = new Float32Array(n * n);
  const tmp = new Float32Array(n * n);
  for (const { radius, strength } of scales) {
    blurred.set(hf.heights);
    boxBlur2D(blurred, tmp, n, radius);
    const worldR = radius * hf.step;
    for (let i = 0; i < n * n; i++) {
      const occ = Math.max(0, (blurred[i] - hf.heights[i]) / worldR);
      ao[i] *= 1 - strength * Math.min(occ, 1);
    }
  }
  return ao;
}

/** Separable in-place box blur on an n×n grid (clamped edges). */
function boxBlur2D(data: Float32Array, tmp: Float32Array, n: number, radius: number): void {
  const w = radius * 2 + 1;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += data[z * n + clamp(x + k, 0, n - 1)];
      tmp[z * n + x] = sum / w;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let z = 0; z < n; z++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[clamp(z + k, 0, n - 1) * n + x];
      data[z * n + x] = sum / w;
    }
  }
}
