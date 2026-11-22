import type { Scene } from '@babylonjs/core';
import type { CarInstance } from '../../assets/assemble';
import type { Vehicle } from '../../car/Vehicle';
import type { ContactOccluder } from '../../gfx/look/lighting';
import type { InputProvider } from '../../input/types';
import type { SimplifyMesh } from './props';
import type { GroundQuery, Vec3Like } from './world';

/**
 * CONTRACT — one car of the game: a physics `Vehicle` (any model from
 * src/car/createVehicle.ts) wearing a procedural car model
 * (`instantiateCar`, src/assets/assemble.ts). Implemented in
 * src/game/car/, consumed by the game.
 *
 * Frame order the owner of a GameCar must keep:
 *   car.vehicle.update(dt)        before the physics step (G calls it)
 *   …scene.render() steps Havok…
 *   car.syncVisual(dt, cameraPosition)   after the step, before drawing
 *
 * Types only.
 */

/** 0 = everything; 1 = no suspension links, hubs or steering wheel;
 * 2 = simplified body / driver / wheels only. */
export type CarLodLevel = 0 | 1 | 2;

export interface GameCarOptions {
  /** Unique in the race: 'player', 'rival-1' … */
  id: string;
  /** Design: 'reef-rocket' | 'neon-wasp' | 'riot-ram' | 'comet-fox'. */
  carId: string;
  /** Vehicle model: 'raycast' (default) | 'assist' | 'hybrid' | 'rigid'. */
  model?: string;
  /** Paint scheme 0 … asset.liveries − 1 (wrapped with `%` if larger). Default 0. */
  livery?: number;
  /** Tuning overrides, pushed through `Vehicle.setTuning`. */
  tune?: Readonly<Record<string, number>>;
  /** Camera distances for LOD 0 → 1 and 1 → 2, m. Default [14, 45]. */
  lodDistances?: [number, number];
  /** Builds the LOD 2 meshes. Without it LOD 2 looks like LOD 1. */
  simplify?: SimplifyMesh;
  /** Share of each part's triangles the LOD 2 mesh keeps. Default 0.12. */
  liteRatio?: number;
  /** Cast sun shadows (body, driver and wheels; LOD 2: the lite body and
   * wheels). Default true. */
  castShadows?: boolean;
}

export interface GameCar {
  readonly id: string;
  readonly carId: string;
  readonly livery: number;
  readonly vehicle: Vehicle;
  /** The visual car, parented to `vehicle.visual.root`. */
  readonly instance: CarInstance;
  /** Contact pool for `look.contacts`; refreshed by `syncVisual`. */
  readonly contact: ContactOccluder;
  /** LOD chosen by the last `syncVisual`. */
  readonly lod: CarLodLevel;
  /** Force a level (null = by camera distance, the default). */
  lodOverride: CarLodLevel | null;
  /** Triangles drawn at the current LOD / at LOD 0. */
  readonly triangles: number;
  readonly fullTriangles: number;
  /**
   * Pose the visual from `vehicle.visual` (hubs, links, spinners, steering
   * wheel), pick the LOD from the distance to `cameraPosition`, refresh
   * `contact`. Call after the physics step.
   */
  syncVisual(dt: number, cameraPosition: Vec3Like): void;
  /** Teleport: `vehicle.reset(ground, yaw)` and the visual back to rest.
   * The ONLY way to move a car: models with real wheel bodies ('assist',
   * 'hybrid', 'rigid') move five bodies inside `reset`; writing the chassis
   * mesh position directly tears such a car apart. */
  place(ground: Vec3Like, yaw: number): void;
  dispose(): void;
}

/** `createGameCar` (src/game/car/GameCar.ts). Async: the car asset is a
 * lazy import; the scene must have Havok enabled. */
export type CreateGameCar = (scene: Scene, input: InputProvider, options: GameCarOptions) => Promise<GameCar>;

/** What the wheel dust needs from the ground. */
export type DustGround = Pick<GroundQuery, 'heightAt' | 'surfaceAt' | 'pavedAt'>;
