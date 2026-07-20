import type { Mesh } from '@babylonjs/core';

/**
 * Minimal contract both vehicle models implement, so the scene, camera, and
 * game loop don't care which physics approach is driving the car.
 */
export interface Vehicle {
  /** Chassis mesh: camera target and pose reference. */
  readonly chassisMesh: Mesh;
  update(dt: number): void;
}
