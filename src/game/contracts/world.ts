import type { Heightfield } from '../../terrain/Heightfield';
import type { Track } from '../../terrain/track';
import type { WorldPlan } from '../../world/types';

/**
 * CONTRACT — the generated world as plain data.
 *
 * Produced by `generateTerrain(seed)` in src/terrain/generateTerrain.ts
 * Its `TerrainData` must be assignable to `WorldData`. Consumed
 * by the terrain surface, the world props, the race session and the
 * labs. Babylon-free, deterministic per seed.
 *
 * Pipeline order that produced it (fixed):
 *   base noise → track (new generator) → road carve at track.halfWidth →
 *   spawn-height shift (road at track point 0 is y = 0) → planWorld →
 *   applyPlanToTerrain → splat → paved → AO (+ canopy / rock / building
 *   contact stamps from the plan) → baked hill self-shadow.
 *
 * Types only. No logic lives in src/game/contracts.
 */
export interface WorldData {
  seed: number;
  /** FINAL ground: road carved, plan modifiers applied. The single source of
   * truth for height — render mesh, Havok heightfield, prop placement,
   * respawn heights and cameras all read it. 256 × 256 over 200 × 200 m. */
  heightfield: Heightfield;
  /** Closed loop; point 0 = world origin heading +z = start / finish line.
   * `halfWidth` is 5, `shoulder` 3, `sampleRoadDist` is filled. */
  track: Track;
  /** The world plan made for exactly this track and ground: every
   * placement's `y` already is `heightfield.getHeight(x, z)`. */
  plan: WorldPlan;
  /** 4 floats per heightfield sample, layout [z * n + x]: grass, rock, dirt,
   * meadow. Sums to 1. Paved pads and the cobbled road are NOT in here (they
   * are meshes laid on top); under them the splat is dirt. */
  splat: Float32Array;
  /** 3 floats per sample: [ambient occlusion 0..1 (terrain cavities × contact
   * stamps under trees, large rocks and buildings), baked sun visibility 0..1
   * (terrain self-shadow ONLY — no canopy stamps, real shadows do that now),
   * albedo tint around 1]. */
  shade: Float32Array;
  /** 1 float per sample, 0..1: how much of the surface is paving (cobbled
   * road × its cross-fade, asphalt / paver / cobble pads). Dust and audio
   * read it; 0 everywhere off the paving. */
  paved: Float32Array;
  /** Stage → milliseconds of the generation that produced this object. */
  timings: Record<string, number>;
}

/** `generateTerrain` must have this type. */
export type GenerateWorld = (seed: number) => WorldData;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * What gameplay code may ask the ground, whichever world is loaded (hills:
 * built from a `WorldData` by `createGroundQuery`; flat arena:
 * built by `createFlatArena`). No allocations in any method.
 *
 * EVERY METHOD MUST WORK UNBOUND: callers hand single methods around
 * (`{ heightAt: ground.heightAt }` for the camera rig, the race's respawn
 * options, the wheel dust), so implement the object with closures / arrow
 * functions, never with methods that read `this`.
 */
export interface GroundQuery {
  /** World y of the ground surface under (x, z). */
  heightAt(x: number, z: number): number;
  /** Unit surface normal under (x, z), written to `out` and returned. */
  normalAt(x: number, z: number, out: Vec3Like): Vec3Like;
  /** Splat weights under (x, z): out[0..3] = grass, rock, dirt, meadow
   * (sum 1). `out` must hold at least 4 floats. */
  surfaceAt(x: number, z: number, out: Float32Array): void;
  /** 0..1 paving under (x, z) (see `WorldData.paved`). */
  pavedAt(x: number, z: number): number;
  /** Half the side of the square world centred on the origin, m. */
  readonly halfExtent: number;
}

/** `createGroundQuery` (src/terrain/groundQuery.ts) has this type. */
export type CreateGroundQuery = (data: WorldData) => GroundQuery;
