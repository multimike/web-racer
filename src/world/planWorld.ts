import { CATALOG, natureClass } from './catalog';
import { planDressing } from './dressing';
import { r3, smoothstep } from './geom';
import { planNature } from './nature';
import { Occupancy } from './occupancy';
import { rng } from './rng';
import { applyTerrainModifiers, copyHeightfield } from './terrainModifiers';
import { TrackFrame } from './trackFrame';
import type { Bend, KerbSection, KerbStyle, NatureBudgets, PlanStats, RoadPlan, WorldPlan, WorldPlanInput } from './types';
import { planStartMarker, planVillage, roadDims } from './village';
import type { PlanContext } from './village';

/** Instance budgets for Quest 3 (thin instances, one draw call per asset
 * variant). The planner aims at the middle of each range. */
export const DEFAULT_BUDGETS: NatureBudgets = {
  trees: [1200, 1800],
  bushes: [600, 1000],
  lowPlants: [3000, 5000],
  largeRocks: [200, 300],
  smallRocks: [600, 1000],
};

/** Wall-clock milliseconds of the stages of the most recent `planWorld`
 * call (not part of the plan: a plan must be identical run to run). */
export const lastPlanTimings: Record<string, number> = {};

/** Bends tighter than this radius (m) get chevrons and apex kerbs. */
export const BEND_RADIUS = 22;
/** Length of the dirt ↔ cobble cross-fade at each end of the village. */
export const SURFACE_BLEND = 8;
/** Start-line band depth along the road, m: four rows of the paving's 0.5 m
 * checker squares, centred on s = 0 (the timing line stays at s = 0). Two
 * metres so the band still reads as a checker from the high camera, where
 * the old 0.6 m band was a thin zigzag of about 6 px. */
const START_LINE_DEPTH = 2.0;

/**
 * Plan the whole world for one track. Pure and deterministic: the same
 * (track, heightfield, seed, roadHalfWidth) always gives the same plan, and
 * the input is never modified.
 *
 * Order matters and is fixed: village (lots, pads, terrain modifiers) →
 * modifiers applied to a private copy of the terrain → dressing → nature,
 * each layer avoiding everything placed before it.
 */
export function planWorld(input: WorldPlanInput): WorldPlan {
  const { track, seed } = input;
  const hw = input.roadHalfWidth ?? track.halfWidth;
  const worldSize = input.heightfield.size;
  let t0 = performance.now();
  const lap = (name: string): void => {
    const t = performance.now();
    lastPlanTimings[name] = t - t0;
    t0 = t;
  };
  const frame = new TrackFrame(track, worldSize);
  const base = copyHeightfield(input.heightfield);
  const dims = roadDims(hw);
  // The bowl rim starts climbing at 72 m from the centre; lots stay inside.
  const bends: Bend[] = frame.findBends(1 / BEND_RADIUS).map((b) => ({
    s0: r3(b.s0),
    s1: r3(b.s1),
    apexS: r3(b.apexS),
    direction: b.direction,
    minRadius: r3(b.minRadius),
    angle: r3(b.angle),
  }));
  const startMarker = planStartMarker(frame, dims);
  const ctx: PlanContext = { frame, base, seed, dims, limit: worldSize / 2 - 32, start: startMarker, bends };
  const budgets: NatureBudgets = { ...DEFAULT_BUDGETS, ...input.budgets };
  const warnings: string[] = [];
  const carve = measureRoadCarve(frame, base, hw);
  if (carve > CARVE_TOLERANCE) {
    warnings.push(
      `terrain is not carved to the planned road: typically ${carve.toFixed(2)} m off the road height at ${(hw - CARVE_PROBE_INSET).toFixed(2)} m from the centreline` +
        ` (roadHalfWidth ${hw}, track.halfWidth ${track.halfWidth}). Carve the heightfield to roadHalfWidth before planning.`,
    );
  }
  if (startMarker.kind === 'flags') warnings.push(`no start gantry: ${startMarker.reason}`);
  lap('frame');

  const village = planVillage(ctx, rng(seed, 'village'));
  lap('village');

  // Final ground: everything below stands on it.
  const ground = copyHeightfield(base);
  applyTerrainModifiers(ground, village.modifiers, track, { frame, roadHalfWidth: hw });
  lap('terrain');

  const occ = new Occupancy(village.lots, village.pads, worldSize);
  const windYaw = r3(rng(seed, 'wind').range(0, Math.PI * 2));
  const dressing = planDressing(ctx, ground, village, bends, occ, rng(seed, 'dressing'), windYaw);
  lap('dressing');
  const nature = planNature(ctx, ground, village, dressing, occ, budgets, input.splat);
  lap('nature');

  // --- Road surface.
  const vs0 = village.village.s0;
  const vs1 = village.village.s1;
  const vlen = village.village.length;
  const cobble: number[] = [];
  for (let i = 0; i < frame.n; i++) {
    const u = frame.wrap(frame.s[i] - vs0 + SURFACE_BLEND / 2);
    // u runs 0 … vlen + blend through the village including both half blends.
    const w = u <= vlen + SURFACE_BLEND ? smoothstep(0, SURFACE_BLEND, u) * smoothstep(0, SURFACE_BLEND, vlen + SURFACE_BLEND - u) : 0;
    cobble.push(r3(w));
  }
  const kerbs = planKerbs(frame, village.openings, vs0, vlen, dims.kerbDressed, dims.kerbRough);
  const start = frame.at(0);
  const road: RoadPlan = {
    length: r3(frame.length),
    halfWidth: hw,
    sections: [
      { s0: vs0, s1: vs1, surface: 'cobble', blend: SURFACE_BLEND },
      { s0: vs1, s1: vs0, surface: 'dirt', blend: 0 },
    ],
    kerbs,
    startLine: { s: 0, x: r3(start.x), y: r3(start.h), z: r3(start.z), yaw: r3(startMarker.yaw), halfWidth: hw, depth: START_LINE_DEPTH, marker: startMarker.kind },
    cobble,
  };

  // --- Stats.
  const perAsset: Record<string, number> = {};
  for (const e of CATALOG) perAsset[e.id] = 0;
  const stats: PlanStats = {
    buildings: village.lots.length,
    villageBuildings: village.lots.filter((l) => l.zone === 'village').length,
    outlyingBuildings: village.lots.filter((l) => l.zone === 'outlying').length,
    dressing: dressing.placements.length,
    trees: 0,
    bushes: 0,
    lowPlants: 0,
    largeRocks: 0,
    smallRocks: 0,
    backdrop: 0,
    batches: 0,
    perAsset,
  };
  const batches = new Set<string>();
  for (const l of village.lots) perAsset[l.asset]++;
  for (const p of dressing.placements) {
    perAsset[p.asset]++;
    batches.add(`${p.asset}/${p.seed}/${p.scheme ?? ''}`);
  }
  for (const p of nature) {
    perAsset[p.asset]++;
    batches.add(`${p.asset}/${p.seed}`);
    const c = natureClass(p.asset);
    if (c) stats[c]++;
    if (p.backdrop) stats.backdrop++;
  }
  stats.batches = batches.size;

  return {
    version: 1,
    seed,
    worldSize,
    road,
    bends,
    village: village.village,
    lots: village.lots,
    terrainModifiers: village.modifiers,
    pads: village.pads,
    dressing: dressing.placements,
    nature,
    windYaw,
    warnings,
    stats,
  };
}

/** The carve check probes this far inside the planned road edge. */
export const CARVE_PROBE_INSET = 0.25;
/** More than this much off the road height there (9 probes in 10) = not
 * carved to this width. Measured on seeds 0–40: a matching carve reads
 * ≤ 0.03 m, a 5 m road planned on the 3.5 m carve ≥ 0.20 m. */
export const CARVE_TOLERANCE = 0.1;

/**
 * How far the terrain just inside the planned road edge is from the road's
 * own height, meters (90th percentile of the probes round the loop: where
 * two legs of the loop pinch together at different heights a few probes are
 * honestly off, and they must not condemn a correct carve). The planner takes the road
 * half width as a parameter, but the ground is only flat as far as it was
 * CARVED: asked for a 5 m road on a 3.5 m carve it would call the carve's
 * bank "road", protect that bank from the terrain modifiers and stand the
 * kerb-side dressing on a slope. Measured rather than compared with
 * `track.halfWidth`, so it holds whichever way the caller widened the road.
 */
export function measureRoadCarve(frame: TrackFrame, terrain: { getHeight(x: number, z: number): number }, halfWidth: number): number {
  const lat = halfWidth - CARVE_PROBE_INSET;
  const off: number[] = [];
  for (let i = 0; i < frame.n; i++) {
    for (const side of [1, -1]) {
      const x = frame.px[i] - frame.tz[i] * side * lat;
      const z = frame.pz[i] + frame.tx[i] * side * lat;
      // Inside a hairpin the probe lands nearer to another piece of road,
      // whose own height it then (rightly) has.
      if (frame.fastDist(x, z) < lat - 0.2) continue;
      off.push(Math.abs(terrain.getHeight(x, z) - frame.h[i]));
    }
  }
  off.sort((a, b) => a - b);
  return off.length ? off[Math.floor(off.length * 0.9)] : 0;
}

/**
 * Kerb sections of both sides: every meter of each side is covered by
 * exactly one section. Dressed through the village, rough outside it, flush
 * wherever a paved pad joins the road — including the part of an apron or a
 * square that reaches past the end of the village.
 */
function planKerbs(
  frame: TrackFrame,
  openings: readonly { side: 1 | -1; s0: number; s1: number; kind: 'gate' | 'pad' }[],
  vs0: number,
  vlen: number,
  dressedWidth: number,
  roughWidth: number,
): KerbSection[] {
  const L = frame.length;
  const kerbs: KerbSection[] = [];
  for (const side of [1, -1] as const) {
    // Everything in u = arc length past the village start, 0 … L. An opening
    // that begins before the village start wraps and is split in two.
    const flush: [number, number][] = [];
    for (const o of openings) {
      if (o.kind !== 'pad' || o.side !== side) continue;
      const a = frame.wrap(o.s0 - vs0);
      const b = a + Math.min(frame.wrap(o.s1 - o.s0), L);
      if (b <= L) flush.push([a, b]);
      else flush.push([a, L], [0, b - L]);
    }
    const cuts = new Set<number>([0, Math.min(vlen, L), L]);
    for (const [a, b] of flush) {
      cuts.add(a);
      cuts.add(b);
    }
    const marks = [...cuts].sort((p, q) => p - q);
    let run: { u0: number; u1: number; style: KerbStyle; width: number } | null = null;
    const runs: { u0: number; u1: number; style: KerbStyle; width: number }[] = [];
    for (let i = 0; i + 1 < marks.length; i++) {
      const u0 = marks[i];
      const u1 = marks[i + 1];
      if (u1 - u0 < 1e-6) continue;
      const mid = (u0 + u1) / 2;
      const village = mid < vlen;
      const open = flush.some(([a, b]) => mid >= a && mid < b);
      const style: KerbStyle = open ? 'flush' : village ? 'dressed' : 'rough';
      const width = village ? dressedWidth : roughWidth;
      if (run && run.style === style && run.width === width) run.u1 = u1;
      else runs.push((run = { u0, u1, style, width }));
    }
    // Slivers (the last centimetres of a square that ends just past the
    // village, the gap between two pads' openings) are folded into a
    // neighbour: nobody can build half a kerb stone.
    for (let i = runs.length - 1; i >= 0 && runs.length > 1; i--) {
      if (runs[i].u1 - runs[i].u0 >= 1) continue;
      if (i > 0) runs[i - 1].u1 = runs[i].u1;
      else runs[1].u0 = runs[0].u0;
      runs.splice(i, 1);
    }
    // Folding can leave two sections of one kind side by side.
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].style === runs[i - 1].style && runs[i].width === runs[i - 1].width) {
        runs[i - 1].u1 = runs[i].u1;
        runs.splice(i, 1);
      }
    }
    for (const r of runs) kerbs.push({ s0: r3(frame.wrap(vs0 + r.u0)), s1: r3(frame.wrap(vs0 + r.u1)), side, width: r.width, style: r.style });
  }
  return kerbs;
}
