import type { Camera, Scene } from '@babylonjs/core';
import type { Vehicle } from '../../car/Vehicle';
import type { Vec3Like } from './world';

/**
 * CONTRACT — the game's cameras and its non-driving buttons (implemented
 * in src/game/camera/ and src/input/GameActions.ts, consumed by the game).
 *
 * Types only.
 */

/** 'chase' low and close behind the car; 'high' elevated follow (the
 * gameplay vision's second image); 'xr' the desktop preview of the diorama:
 * eye 85 m up, 85 m back from the world centre, looking 45° down, orbit and
 * zoom with the mouse. */
export type ViewMode = 'chase' | 'high' | 'xr';

export interface CameraRigOptions {
  /** Starting mode. Default 'chase'. */
  mode?: ViewMode;
  /** Ground height lookup so a follow camera never dips into a hill. */
  heightAt?: (x: number, z: number) => number;
}

/**
 * `CAMERA_TUNING` (exported by src/game/camera/CameraRig.ts) has this shape.
 * Plain numbers, meters / radians / seconds, live-tweakable from the
 * console. The terrain lab and the props lab pose their still cameras from
 * the same object, so their pictures and frame costs are the game's.
 */
export interface CameraTuning {
  chase: {
    /** Eye this far behind the car / above the ground under the car. */
    distance: number;
    height: number;
    /** Look-at point: the car + `lookUp` up + `lookAhead` along its heading. */
    lookUp: number;
    lookAhead: number;
    /** Vertical field of view, rad. */
    fov: number;
    /** Added to `distance` / `fov` at the car's top speed (scaled by speed). */
    speedDistance: number;
    speedFov: number;
    /** Time constants of the yaw follow and of the height smoothing, s. */
    yawTau: number;
    heightTau: number;
    /** The eye never goes below the ground + this, m. */
    minClearance: number;
  };
  high: { distance: number; height: number; lookAhead: number; fov: number; yawTau: number };
  xr: { eyeHeight: number; back: number; minRadius: number; maxRadius: number };
}

/** Look-runtime settings that go with a view (from `LOOK_VIEWS`). */
export interface ViewLook {
  /** Side of the shadowed square, m. */
  shadowRegion: number;
  fogDensity: number;
  /** true: the shadow focus follows the car; false: fixed on the world centre. */
  followCar: boolean;
}

export interface CameraRig {
  readonly mode: ViewMode;
  /** The Babylon camera of the current mode (already `scene.activeCamera`). */
  readonly camera: Camera;
  /** World position of the eye, refreshed by `update`. */
  readonly eye: Vec3Like;
  /** Where detail and shadows should be centred, on the ground: the car in
   * chase / high, the orbit target in xr. Refreshed by `update`. */
  readonly focus: Vec3Like;
  /** Distance from the eye to `focus`, m. */
  readonly focusDistance: number;
  readonly look: ViewLook;
  /** The car to follow (chase / high). May be changed at any time. */
  setSubject(vehicle: Vehicle | null): void;
  setMode(mode: ViewMode): void;
  /** chase → high → xr → chase; returns the new mode. */
  cycle(): ViewMode;
  /** Jump straight to the settled pose behind the subject (after a respawn
   * or a restart) instead of swinging there. */
  snap(): void;
  /** Call after the physics step, before rendering. */
  update(dt: number): void;
  dispose(): void;
}

/** `createCameraRig` (src/game/camera/CameraRig.ts). */
export type CreateCameraRig = (scene: Scene, canvas: HTMLCanvasElement, options?: CameraRigOptions) => CameraRig;

/** Buttons that are not driving. Every field is EDGE-triggered: true for the
 * one poll in which the key or button went down. */
export interface GameActions {
  /** Put my car back on the road. Keyboard R, gamepad button 1 (Circle / B). */
  reset: boolean;
  /** Next camera. Keyboard C, gamepad button 3 (Triangle / Y). */
  camera: boolean;
  /** Restart the race. Keyboard Enter, gamepad button 9 (Options / Start). */
  restart: boolean;
  /** Show / hide the tuning panel. Keyboard T. */
  tuning: boolean;
  /** Show / hide the dev overlay (A/B links, perf counters). Keyboard H. */
  dev: boolean;
}

export interface GameActionSource {
  /** Call exactly once per frame. The returned object is reused. */
  poll(): Readonly<GameActions>;
  dispose(): void;
}

/** `createGameActions` (src/input/GameActions.ts). */
export type CreateGameActions = () => GameActionSource;
