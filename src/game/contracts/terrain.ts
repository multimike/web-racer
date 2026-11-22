import type { Mesh, PhysicsBody, Scene } from '@babylonjs/core';
import type { GroundTextureSet } from '../../gfx/ground';
import type { GroundQuery, WorldData } from './world';

/**
 * CONTRACT — the ground you see and drive on (implemented in
 * src/render/terrain/, consumed by the game and the labs).
 *
 * `createTerrainSurface(scene, data, options)`:
 *   - terrain chunks shaded through `lookShadeMatte` with the generated
 *     ground textures blended by `data.splat`, AO and baked hill shadow from
 *     `data.shade`, registered with the look runtime as a contact receiver;
 *   - the paving: road ribbon (dirt ↔ cobble by `plan.road.cobble`), kerb
 *     stones by `plan.road.kerbs`, the painted start line, the pads of
 *     `plan.pads` with their markings — at most 2 meshes / draw calls;
 *   - the Havok HEIGHTFIELD body (friction 2.0, restitution 0), unless
 *     `physics: false`.
 * Everything it creates is static: world matrices frozen, nothing per frame.
 * The scene must already have Havok enabled (when physics is wanted) and a
 * look runtime (`createLook`) — or it gets the default one.
 *
 * Types only.
 */
export interface TerrainSurfaceOptions {
  /** Side of the generated ground textures, px. Default 512. */
  groundTextureSize?: number;
  /** chunks × chunks terrain meshes for frustum culling. Default 4; 1 = one mesh. */
  chunks?: number;
  /** Build the Havok heightfield body. Default true. */
  physics?: boolean;
  /** Draw road ribbon, kerbs, start line and pads. Default true. */
  paving?: boolean;
  /** Anisotropic filtering of the ground textures. Default 8. */
  anisotropy?: number;
}

export interface TerrainSurfaceStats {
  terrainTriangles: number;
  pavingTriangles: number;
  /** Meshes that can draw at once: terrain chunks + paving meshes. */
  meshes: number;
  /** Milliseconds: ground textures, terrain meshes, paving, physics. */
  textureMs: number;
  meshMs: number;
  pavingMs: number;
  physicsMs: number;
}

export interface TerrainSurface {
  /** Terrain chunk meshes (`chunks²` of them). */
  readonly terrain: readonly Mesh[];
  /** Road ribbon + kerbs + start line, and the pads (0, 1 or 2 meshes). */
  readonly paving: readonly Mesh[];
  /** The static heightfield body; null with `physics: false`. */
  readonly body: PhysicsBody | null;
  /** The textures it generated (shared with nobody else; disposed with it). */
  readonly groundTextures: GroundTextureSet;
  /** Ground lookups for gameplay, from the same `WorldData`. */
  readonly ground: GroundQuery;
  readonly stats: TerrainSurfaceStats;
  dispose(): void;
}

/** `createTerrainSurface` (src/render/terrain/terrainSurface.ts). */
export type CreateTerrainSurface = (scene: Scene, data: WorldData, options?: TerrainSurfaceOptions) => TerrainSurface;

/**
 * `createTerrainCollider` (same file): ONLY the static Havok heightfield
 * body on an invisible node — no mesh, no material, no textures. Must work
 * under a `NullEngine` (the physics lab builds its hill worlds with it).
 */
export type CreateTerrainCollider = (scene: Scene, data: WorldData) => PhysicsBody;

/** Where a car is put down: a point ON the ground and a heading (yaw 0 = +z,
 * positive turns toward +x). */
export interface SpawnPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * The bare test arena of `?terrain=flat`: a 200 × 200 m plane at y = 0 with
 * four walls, three ramps (12°, 18°, 25°) and the wavy road — the same
 * obstacles and friction values as the old arena, drawn with look materials
 * so the cars cast shadows and get their contact pools.
 */
export interface FlatArena {
  readonly ground: GroundQuery;
  readonly spawn: SpawnPose;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/** `createFlatArena` (src/render/terrain/flatArena.ts). */
export type CreateFlatArena = (scene: Scene) => FlatArena;
