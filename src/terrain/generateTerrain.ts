import { Heightfield, clamp, smoothstep } from './Heightfield';
import { Noise2D } from './noise';
import { generateTrack } from './track';
import type { Track } from './track';

export interface TerrainData {
  heightfield: Heightfield;
  track: Track;
  /** Per-sample splat weights, RGBA per vertex (grass, rock, dirt road, meadow), sums to 1. */
  splat: Float32Array;
  /** Per-sample shading, 3 floats per vertex: [ambient occlusion, baked sun
   * visibility (terrain self-shadow), albedo tint (road-edge outline)]. */
  shade: Float32Array;
  timings: Record<string, number>;
}

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

/** Pure CPU-side generation: heights + track carve + splat + AO. No Babylon
 * types in here so it can move to a worker (or run headless for tests) as is. */
export function generateTerrain(seed: number): TerrainData {
  const timings: Record<string, number> = {};
  let t0 = performance.now();

  const n = TERRAIN_SAMPLES;
  const hf = new Heightfield(n, TERRAIN_SIZE);
  const half = TERRAIN_SIZE / 2;
  const noise = new Noise2D(seed);
  const macroNoise = new Noise2D(seed + 101);

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
  carveTrack(hf, track);
  timings.track = performance.now() - t0;

  // Shift the whole field so the road at the spawn point (track point 0 ==
  // world origin) sits at y = 0 — cars spawn at a hardcoded height.
  const spawnH = track.roadHeights[0];
  for (let i = 0; i < hf.heights.length; i++) hf.heights[i] -= spawnH;
  for (let i = 0; i < track.roadHeights.length; i++) track.roadHeights[i] -= spawnH;

  t0 = performance.now();
  const splat = buildSplat(hf, track, macroNoise);
  timings.splat = performance.now() - t0;

  t0 = performance.now();
  const ao = buildAO(hf);
  timings.ao = performance.now() - t0;

  t0 = performance.now();
  const sunVis = buildSunVisibility(hf);
  timings.sunShadow = performance.now() - t0;

  const tint = buildEdgeTint(hf, track);

  // Interleave into one vertex buffer: [ao, sunVis, tint] per sample.
  const shade = new Float32Array(hf.n * hf.n * 3);
  for (let i = 0; i < hf.n * hf.n; i++) {
    shade[i * 3] = ao[i];
    shade[i * 3 + 1] = sunVis[i];
    shade[i * 3 + 2] = tint[i];
  }

  return { heightfield: hf, track, splat, shade, timings };
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

/** Baked terrain self-shadow: march toward the sun and compare the horizon
 * angle against the sun elevation. Soft penumbra via smoothstep in tan space.
 * Terrain is static, so this is real cast shadowing at zero runtime cost —
 * no shadow map needed for the landscape. */
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

/** Darker band straddling the road border — reads as a drawn outline, turning
 * the fuzzy tan smear into a deliberate toy road. */
function buildEdgeTint(hf: Heightfield, track: Track): Float32Array {
  const n = hf.n;
  const out = new Float32Array(n * n).fill(1);
  const roadDist = track.sampleRoadDist!;
  const hw = track.halfWidth;
  for (let i = 0; i < n * n; i++) {
    const d = roadDist[i];
    if (!Number.isFinite(d)) continue;
    // Transitions ≥ 2 heightmap samples (~1.6 m) wide, or the band aliases
    // into stair-steps along diagonal road sections.
    const edge = smoothstep(hw - 1.8, hw - 0.2, d) * (1 - smoothstep(hw + 0.3, hw + 2.0, d));
    out[i] = 1 - 0.18 * edge;
  }
  return out;
}

/** Distance-field carve: flatten toward the smoothed road profile inside
 * halfWidth, smoothstep-blend across the shoulder. A coarse bucket grid keeps
 * this O(samples × nearby points) instead of O(samples × whole polyline). */
function carveTrack(hf: Heightfield, track: Track): void {
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

  // Store road distance per sample for the splat pass (reused as scratch).
  const roadDist = new Float32Array(n * n).fill(Infinity);
  const roadH = new Float32Array(n * n);
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
      roadH[idx] = track.roadHeights[bestI];
      const blend = 1 - smoothstep(track.halfWidth, maxDist, d);
      hf.heights[idx] = hf.heights[idx] * (1 - blend) + roadH[idx] * blend;
    }
  }
  track.sampleRoadDist = roadDist;
}

/** RGBA splat per sample: R grass, G rock (steep slopes), B dirt road,
 * A meadow patches (macro noise). Normalized so the shader can just dot with
 * the palette. */
function buildSplat(hf: Heightfield, track: Track, macro: Noise2D): Float32Array {
  const n = hf.n;
  const half = hf.size / 2;
  const out = new Float32Array(n * n * 4);
  const roadDist = track.sampleRoadDist!;
  const maxDist = track.halfWidth + track.shoulder;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      const wx = -half + ix * hf.step;
      const wz = -half + iz * hf.step;
      const road = 1 - smoothstep(track.halfWidth * 0.9, maxDist * 0.9, roadDist[idx]);
      const slope = hf.slopeAt(ix, iz);
      const rock = smoothstep(0.55, 0.95, slope) * (1 - road);
      const meadow =
        smoothstep(0.15, 0.45, macro.fbm(wx / 40 + 31, wz / 40 - 17, 3)) * (1 - road) * (1 - rock);
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
