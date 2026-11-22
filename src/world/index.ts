/**
 * WORLD PLANNER — decides where the village, its buildings, the track
 * dressing and every tree, rock and flower go. Babylon-free, deterministic.
 *
 * INTEGRATION (terrain generator, after the road carve and the spawn-height
 * shift, BEFORE splat / AO / sun shadow / mesh / physics):
 *
 *   const plan = planWorld({ track, heightfield: hf, seed, splat });
 *   applyPlanToTerrain(hf, plan, track);      // flatten pads, level verges
 *   // splat: road channel × plan.road.cobble[i] = cobble; rasterize plan.pads
 *   // buildings: plan.lots      → asset.build(lot.seed, lot.scheme) at (x, y, z), rotation.y = yaw
 *   // props:     plan.dressing, plan.nature → thin instances per (asset, seed[, scheme])
 *
 * ROAD WIDTH. `roadHalfWidth` defaults to `track.halfWidth`, and the terrain
 * handed in must be CARVED to it: the planner treats everything inside as
 * road and protects it from the modifiers. To widen the road, widen
 * `track.halfWidth` where the track is generated (so carve, splat and edge
 * tint follow). Until then `recarveRoad(hf, track, halfWidth)` widens the
 * carve of a heightfield in place — the lab and the sweeps use it. A plan
 * made on the wrong carve says so in `plan.warnings` and fails the first
 * self-check.
 *
 * Every placement's `y` is already the ground height AFTER the modifiers.
 * If the terrain is changed again afterwards (road re-carved, smoothing),
 * call resamplePlanHeights(plan, hf). Props that are long (fence, wall,
 * chevron, bench) or stand near a bank should be tilted to the ground normal
 * by the integrator (Heightfield.getNormal): the planner levels the verges
 * they stand on, but not every bank behind a cut-in lot.
 *
 * START LINE. `plan.road.startLine.marker` is 'gantry' (a 'start-gantry'
 * placement exists) or 'flags' (the gantry would not clear the road: wider
 * than its opening, or the line sits on a hairpin; only 'start-flag' poles).
 *
 * QUEST BUDGET. `plan.stats.batches` = prop draw calls; placements flagged
 * `backdrop` (trees / large rocks > 30 m from any road, most of the tree
 * budget) can take a cheap LOD; `budgets` in the input scales the counts
 * without moving the village or the dressing.
 *
 * Shape and conventions of the plan: types.ts. Pipeline: planWorld.ts.
 * Self-checks: checks.ts (world-lab.html shows them on a map).
 */
export { planWorld, lastPlanTimings, measureRoadCarve, DEFAULT_BUDGETS, BEND_RADIUS, SURFACE_BLEND, CARVE_TOLERANCE } from './planWorld';
export { applyTerrainModifiers, applyPlanToTerrain, resamplePlanHeights, copyHeightfield, flattenWeight, recarveRoad } from './terrainModifiers';
export { TrackFrame } from './trackFrame';
export type { RoadHit, RoadPoint } from './trackFrame';
export { CATALOG, BUILDING_IDS, catalogEntry, natureClass } from './catalog';
export type { CatalogEntry, CatalogCategory, NatureClass } from './catalog';
export { checkWorldPlan, runSelfChecks, formatChecks, CUT_FILL_LIMIT } from './checks';
export type { CheckResult, SelfCheckRun } from './checks';
export { roadDims, planStartMarker } from './village';
export type { RoadDims, StartMarker } from './village';
export { frontOf, yawFacing, yawAlong } from './geom';
export type * from './types';
