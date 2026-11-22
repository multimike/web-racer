import type { Mesh, PhysicsBody, Vector3 } from '@babylonjs/core';
import type { DriverParams } from './DriverModel';
import type { VehicleRig } from './rig';
import type { VehicleVisual } from './visual';

/**
 * Per-wheel contact kinematics, refreshed by every `Vehicle.update()` — read
 * by GFX (dust, skid marks), audio and the physics lab without touching the
 * model's internals. Order: 0 FL, 1 FR, 2 RL, 3 RR.
 */
export interface WheelGroundState {
  /** Wheel center, world space. */
  readonly position: Vector3;
  /** Hub linear velocity, world space. */
  readonly velocity: Vector3;
  /** Travel speed over the ground along the wheel's rolling direction, m/s. */
  rollSpeed: number;
  /** Total contact-patch slip, m/s: rim-vs-ground (wheelspin under power,
   * lockup under braking) plus sideways sliding along the axle. */
  slipSpeed: number;
  /** Tire is carrying load (touching the ground). */
  grounded: boolean;
  /** Wheel steer angle relative to the chassis, rad (+ = right). */
  steerAngle: number;
  /** Spin about the axle, rad/s (+ = rolling forward). */
  spinSpeed: number;
  /** Tire radius, m (front and rear differ on most cars). */
  radius: number;
}

/** One live-tunable number of a vehicle model (tuning UI builds sliders from
 * these; the physics lab sweeps them via `?tune=key:value,...`). */
export interface TuningParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Section heading in a tuning panel ('tires', 'drive', …). */
  group?: string;
  /** What changing it feels like, one line. */
  hint?: string;
}

/**
 * Contract every vehicle model implements, so the scene, camera, dust GFX,
 * engine sound, tuning UI and the physics lab (physics-lab.html) do not care
 * which physics approach is driving the car.
 *
 * Conventions shared by all models:
 *  - world: +y up, meters; heading yaw = atan2(forward.x, forward.z), so
 *    yaw 0 looks down +z and POSITIVE yaw / yaw rate turns RIGHT (toward +x);
 *  - steering +1 = right, steer angles positive = right;
 *  - wheel order FL, FR, RL, RR.
 */
export interface Vehicle {
  /** Registry name of the model ('rigid' = legacy rigid-wheel model). */
  readonly modelName: string;
  /** Rig this instance was built from; `null` only for the legacy model in
   * its hardcoded RB-01 game configuration. */
  readonly rig: VehicleRig | null;
  /** Chassis mesh: camera target and pose reference. */
  readonly chassisMesh: Mesh;
  /** Chassis rigid body — the lab derives slip angle, yaw rate and
   * accelerations from its velocities. */
  readonly chassisBody: PhysicsBody;
  /** One entry per wheel (FL, FR, RL, RR), refreshed every update(). */
  readonly wheelStates: readonly WheelGroundState[];
  /**
   * Everything a VISUAL car needs, model-independent (see visual.ts): the
   * node to parent the bodywork to, the four hub poses (position, hub frame,
   * steer and spin angle, suspension travel, grounded), the pedals and the
   * steer angle. Refreshed every update().
   */
  readonly visual: VehicleVisual;

  /** Advance the model by one frame: poll input, apply forces/motors.
   * Called once per frame BEFORE the physics step. */
  update(dt: number): void;

  /** Chassis speed along its forward axis, m/s (negative = backward). */
  readonly forwardSpeed: number;
  /** Mean rim speed of the driven wheels, m/s, signed. Engine sound tracks
   * this (keeps revving on wheelspin / airborne). */
  readonly drivenRimSpeed: number;
  /** True while the brake pedal is acting as reverse throttle. */
  readonly isReversing: boolean;
  /** True while the model is rolling itself back onto its wheels after
   * ending on its side or roof (models without self-righting leave it out).
   * A game can hold back a "press to respawn" prompt for that long. */
  readonly isSelfRighting?: boolean;
  /** Current bicycle-model steer angle, rad (+ = right). */
  readonly currentSteerAngle: number;
  /** Bicycle-model steer angle at full stick right now, rad. */
  readonly maxSteerAngle: number;
  /**
   * Stick position (−1..1) that makes the front wheels point at the given
   * bicycle-model steer angle (rad, + = right) RIGHT NOW. Models whose stick
   * is a plain angle command leave it out (stick = angle / maxSteerAngle);
   * a model that re-interprets the stick in a slide (the raycast model's
   * slide steering) implements it, so an AI driver can keep thinking in
   * wheel angles.
   */
  stickForSteerAngle?(angle: number): number;
  /**
   * How an AI driver (DriverModel) should drive THIS model where its
   * defaults do not fit — e.g. how much throttle holds a drift. Explicit
   * driver parameters win over hints.
   */
  readonly driverHints?: Partial<DriverParams>;
  /** Front-to-rear axle distance, m. */
  readonly wheelbase: number;
  /** Rim speed the drivetrain tops out at, m/s (rpm normalisation). */
  readonly topSpeed: number;
  /** Peak tire-road friction coefficient the model is tuned for on a
   * high-grip surface — the lab normalises lateral/brake g against it. */
  readonly nominalGrip: number;

  /**
   * Teleport: put the car upright at static ride height with the wheelbase
   * centre above `groundPoint` (a point ON the ground), heading `yaw`, all
   * linear/angular velocities and internal state (steer angle, wheel spin)
   * zeroed. Takes effect on the next physics step.
   */
  reset(groundPoint: Vector3, yaw: number): void;
  /**
   * Impose a planar motion state on the whole car (chassis + any wheel
   * bodies moving rigidly with it, wheels spinning at rolling speed for the
   * forward component). Valid right after reset() or any time later; the lab
   * uses it to start maneuvers at speed and to impose slides.
   * @param velocity world-space velocity of the chassis, m/s
   * @param yawRate rad/s about world up (+ = turning right)
   */
  setMotion(velocity: Vector3, yawRate: number): void;

  /** Live-tunable parameters of this model. */
  readonly tuningParams: readonly TuningParam[];
  /** Read any numeric tuning value by key (also keys not in tuningParams). */
  getTuning(key: string): number | undefined;
  /** Change a tuning value and push it into the physics engine where
   * needed. Returns false for an unknown key. */
  setTuning(key: string, value: number): boolean;

  dispose(): void;
}
