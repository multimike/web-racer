import {
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  PhysicsAggregate,
  PhysicsBody,
  PhysicsShapeType,
  PhysicsShapeCylinder,
  Physics6DoFConstraint,
  PhysicsConstraintAxis,
  PhysicsConstraintMotorType,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import type { Vehicle } from './Vehicle';
import { clamp } from '../input/deadzone';

export interface RigidWheelTuning {
  wheelRadius: number;
  wheelWidth: number;
  wheelMass: number;
  /** Tire grip comes straight from Havok contact friction on the cylinder. */
  wheelFriction: number;
  /** Suspension spring holding each wheel at its mount point, N/m. */
  suspensionStiffness: number;
  /** Suspension damper, N·s/m. */
  suspensionDamping: number;
  /** Peak axle torque per driven wheel, N·m. */
  maxDriveTorque: number;
  /** Wheel-rim speed the drive motor aims for at full throttle, m/s. */
  maxSpeed: number;
  /** Reverse speed cap as a fraction of maxSpeed. */
  reverseSpeedFactor: number;
  /** Torque pulling driven wheels toward zero spin when coasting, N·m. */
  coastTorque: number;
  /** Peak brake torque per wheel (all four brake), N·m. */
  maxBrakeTorque: number;
  /** Chassis center of mass, local Y relative to chassis center, m. */
  comHeight: number;
  /** Chassis center of mass, local Z (+ = toward the nose), m. */
  comForward: number;
  /** Max steering angle at standstill, rad. */
  maxSteerAngle: number;
  /** How much steering tightens down with speed (per m/s). */
  steerSpeedFalloff: number;
  /**
   * Grip-circle steering cap: commanded lateral accel is limited to this ×
   * μ·g. 1 = corner exactly at the tire limit (no slide), higher lets the
   * driver push a bit past it for controllable drift.
   */
  steerGripMargin: number;
  /** How fast the steering angle chases the stick, rad/s equivalent. */
  steerResponse: number;
}

// Real-scale tuning for what the geometry actually is: a ~3.9 m off-road
// buggy on 1.5 m tires, ~1500 kg all-in (1300 kg chassis + 4 × 50 kg wheels).
// Corner mass ≈ 325 kg.
export const DEFAULT_RIGID_TUNING: RigidWheelTuning = {
  wheelRadius: 0.75,
  wheelWidth: 0.5,
  wheelMass: 50,
  wheelFriction: 1.2,           // Slightly more grip to handle the aggressive physics
  suspensionStiffness: 85000,   // Jacked up from 25000 to resist high gravity
  suspensionDamping: 4500,      // Increased to stop the car from bouncing like a toy
  maxDriveTorque: 10000,         // Increased so it can propel the heavy-feeling car instantly
  maxSpeed: 25,                 // Increased for a faster sense of speed
  reverseSpeedFactor: 0.5,
  coastTorque: 2000,             // More engine braking helps it feel grounded when letting off gas
  maxBrakeTorque: 10000,         // Stronger brakes to match the speed
  comHeight: -0.45,              // Lowered COM further to prevent flipping at high speeds
  comForward: 0,
  maxSteerAngle: 0.5,           // Slightly lower angle so it doesn't spin out instantly
  steerSpeedFalloff: 0.04,
  // The cap now uses REAL scene gravity (25, not a hard-coded 9.81), so 0.6
  // here reproduces the same steering cap 1.5 gave against 9.81.
  steerGripMargin: 0.6,
  steerResponse: 12,            // Increased from 8 so the wheels snap to the stick faster
}

// Empirical sign flips for the constraint axis conventions (they depend on
// which body is A vs B in the constraint). Verified by driving: positive
// ANGULAR_X motor target = forward roll, positive ANGULAR_Y target = right.
const DRIVE_SIGN = 1;
const STEER_SIGN = 1;

// Wheel attach points in chassis local space. Same footprint as the raycast
// car so A/B comparison is fair: outboard of the 1.4-wide body, ±1.0 wheelbase.
const WHEEL_X = 1.05;
const WHEEL_Z = 1.0;
// Mount height: wheel center rests here (plus spring sag) below chassis center.
const ATTACH_Y = -0.5;

interface WheelUnit {
  mesh: Mesh;
  body: PhysicsBody;
  shape: PhysicsShapeCylinder;
  constraint: Physics6DoFConstraint;
  steered: boolean;
  driven: boolean;
}

/**
 * Rigid-body vehicle: each wheel is a real dynamic cylinder collider joined
 * to the chassis by a 6DoF constraint — vertical axis soft-locked with
 * stiffness/damping (the damped suspension spring), axle axis free with a
 * velocity motor for drive, steering via a position motor on the yaw axis of
 * the front constraints. Grip, load transfer, and obstacle collision all come
 * from the physics engine's own contact solving: nothing is faked with rays.
 */
export class RigidWheelVehicle implements Vehicle {
  readonly chassisMesh: Mesh;
  /** Live tuning: torque/speed fields are read every frame, so mutating them
   * takes effect immediately; COM and friction need applyCenterOfMass /
   * applyWheelFriction after mutation. */
  readonly tuning: RigidWheelTuning;
  private chassisBody: PhysicsBody;
  private input: InputProvider;
  private wheelUnits: WheelUnit[] = [];
  private steerAngle = 0;
  private linVel = new Vector3();
  private _forwardSpeed = 0;
  private _reversing = false;
  private _drivenRimSpeed = 0;
  private angVel = new Vector3();
  /** Scene gravity magnitude — grip scales with m·g, so the steering cap must too. */
  private gravityMag: number;

  constructor(scene: Scene, input: InputProvider, tuning: RigidWheelTuning = DEFAULT_RIGID_TUNING) {
    this.input = input;
    // Clone so slider tweaks on this instance never bleed into the shared default.
    this.tuning = { ...tuning };
    this.gravityMag = scene.getPhysicsEngine()?.gravity.length() ?? 9.81;

    // --- Chassis (blue, to tell the models apart at a glance) ---
    const chassis = MeshBuilder.CreateBox('car', { width: 1.4, height: 0.6, depth: 2.4 }, scene);
    chassis.position.set(0, 1.6, 0);
    const chassisMat = new StandardMaterial('rigidCarMat', scene);
    chassisMat.diffuseColor = new Color3(0.15, 0.35, 0.85);
    chassis.material = chassisMat;
    this.chassisMesh = chassis;

    const chassisAggregate = new PhysicsAggregate(
      chassis,
      PhysicsShapeType.BOX,
      { mass: 1300, friction: 0.5, restitution: 0.1 },
      scene,
    );
    this.chassisBody = chassisAggregate.body;
    this.applyCenterOfMass();
    // Token aero/driveline losses only — yaw damping is the tires' job.
    this.chassisBody.setAngularDamping(0.1);
    this.chassisBody.setLinearDamping(0.02);

    const wheelMat = new StandardMaterial('rigidWheelMat', scene);
    wheelMat.diffuseColor = new Color3(0.12, 0.12, 0.12);

    const configs = [
      { x: -WHEEL_X, z: WHEEL_Z, steered: true, driven: false },
      { x: WHEEL_X, z: WHEEL_Z, steered: true, driven: false },
      { x: -WHEEL_X, z: -WHEEL_Z, steered: false, driven: true },
      { x: WHEEL_X, z: -WHEEL_Z, steered: false, driven: true },
    ];

    configs.forEach((cfg, i) => {
      const t = this.tuning;

      const mesh = MeshBuilder.CreateCylinder(
        `rigidWheel${i}`,
        { diameter: t.wheelRadius * 2, height: t.wheelWidth, tessellation: 4 },
        scene,
      );
      // Cylinder is built along Y; bake a 90° roll so its local axis is X
      // (the axle), which the physics shape below assumes.
      mesh.rotation.z = Math.PI / 2;
      mesh.bakeCurrentTransformIntoVertices();
      mesh.material = wheelMat;
      mesh.position.set(cfg.x, 1.6 + ATTACH_Y, cfg.z);

      const shape = new PhysicsShapeCylinder(
        new Vector3(-t.wheelWidth / 2, 0, 0),
        new Vector3(t.wheelWidth / 2, 0, 0),
        t.wheelRadius,
        scene,
      );
      const aggregate = new PhysicsAggregate(mesh, shape, {
        mass: t.wheelMass,
        friction: t.wheelFriction,
        restitution: 0,
      }, scene);
      aggregate.body.setAngularDamping(0.05);

      const constraint = new Physics6DoFConstraint(
        {
          pivotA: new Vector3(cfg.x, ATTACH_Y, cfg.z),
          pivotB: new Vector3(0, 0, 0),
          axisA: new Vector3(1, 0, 0),
          axisB: new Vector3(1, 0, 0),
          perpAxisA: new Vector3(0, 1, 0),
          perpAxisB: new Vector3(0, 1, 0),
          collision: false,
        },
        [
          // Hard-locked: the hub can only move vertically relative to the chassis.
          { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
          { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
          // Damped spring holding the hub at the mount: suspension. The limit
          // range must be non-zero — min=max=0 makes the plugin hard-LOCK the
          // axis and Havok then ignores stiffness/damping entirely (verified:
          // zero sag under load). A hair-width LIMITED range keeps the soft
          // spring engaged on both sides of the mount point. It must ALSO
          // stay hair-width: stiffness/damping only act PAST a limit, so any
          // real range here is free fall before the spring engages (±0.5
          // measurably sank the ride height 0.6 m), not suspension travel.
          {
            axis: PhysicsConstraintAxis.LINEAR_Y,
            minLimit: -0.01,
            maxLimit: 0.01,
            stiffness: t.suspensionStiffness,
            damping: t.suspensionDamping,
          },
          // No camber flop.
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: 0, maxLimit: 0 },
          // Steering yaw: fronts start in LIMITED mode with a hair-width range
          // (min=max=0 would hard-LOCK the axis and make later limit updates
          // inert); update() then clamps the limits to the commanded steer
          // angle each frame. Rears are locked. ANGULAR_X (axle spin) is free.
          cfg.steered
            ? { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -0.001, maxLimit: 0.001 }
            : { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: 0, maxLimit: 0 },
        ],
        scene,
      );
      this.chassisBody.addConstraint(aggregate.body, constraint);

      // Steering is held by clamping the yaw limits to the commanded angle
      // each frame (see update) — a hard kinematic hold. A POSITION motor was
      // tried first: its default gains are too soft for a fast-spinning
      // wheel and it shimmied violently between the limit stops.
      // Every wheel gets an axle VELOCITY motor: driven wheels use it for
      // drive + coast, undriven fronts sit at zero force until the brakes
      // clamp all four (target 0, force = brake torque).
      constraint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
      constraint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, cfg.driven ? t.coastTorque : 0);
      constraint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);

      this.wheelUnits.push({ mesh, body: aggregate.body, shape, constraint, steered: cfg.steered, driven: cfg.driven });
    });
  }

  get currentSteerAngle(): number {
    return this.steerAngle;
  }

  /** Chassis speed along its forward axis, m/s (negative = rolling backward). */
  get forwardSpeed(): number {
    return this._forwardSpeed;
  }

  /** True while the brake pedal is acting as reverse throttle. */
  get isReversing(): boolean {
    return this._reversing;
  }

  /**
   * Mean rim speed of the driven wheels, m/s, signed (+ = forward roll).
   * This is what the engine sound should track: unlike chassis speed it
   * keeps revving when the wheels spin without traction (airborne, flipped,
   * wheelspin on a slick surface).
   */
  get drivenRimSpeed(): number {
    return this._drivenRimSpeed;
  }

  /** Push tuning.comHeight/comForward into the chassis body. */
  applyCenterOfMass(): void {
    this.chassisBody.setMassProperties({
      mass: 1300,
      centerOfMass: new Vector3(0, this.tuning.comHeight, this.tuning.comForward),
    });
  }

  /** Push tuning.wheelFriction into the wheel colliders (new contacts pick it up). */
  applyWheelFriction(): void {
    for (const wheel of this.wheelUnits) {
      wheel.shape.material = { friction: this.tuning.wheelFriction, restitution: 0 };
    }
  }

  update(dt: number): void {
    const t = this.tuning;
    const intent = this.input.poll();

    this.chassisBody.getLinearVelocityToRef(this.linVel);
    const forwardSpeed = Vector3.Dot(this.linVel, this.chassisMesh.forward);
    this._forwardSpeed = forwardSpeed;

    // Driven-wheel rim speed for the engine sound: spin about the rear axle,
    // which stays aligned with the chassis right axis (rears don't steer).
    const right = this.chassisMesh.right;
    let rimSpeed = 0;
    let drivenCount = 0;
    for (const wheel of this.wheelUnits) {
      if (!wheel.driven) continue;
      wheel.body.getAngularVelocityToRef(this.angVel);
      rimSpeed += DRIVE_SIGN * Vector3.Dot(this.angVel, right) * t.wheelRadius;
      drivenCount += 1;
    }
    this._drivenRimSpeed = drivenCount > 0 ? rimSpeed / drivenCount : 0;

    const speedScale = 1 / (1 + Math.abs(forwardSpeed) * t.steerSpeedFalloff);
    // Grip-circle cap: steering demands lateral accel v²·tanδ/L; past μ·g the
    // front tires just wash out sideways — that was the high-speed slide. Cap
    // the command at the angle the tires can actually hold (plus margin).
    // Uses TOTAL planar speed, not forward speed: in a slide forward speed
    // collapses while the car still carries full velocity sideways, and a
    // forward-speed cap would open right back up and wind steering into the
    // spin.
    const planarSq = this.linVel.x * this.linVel.x + this.linVel.z * this.linVel.z;
    const gripSteer = Math.atan(
      (t.steerGripMargin * t.wheelFriction * this.gravityMag * 2 * WHEEL_Z) / Math.max(planarSq, 0.01),
    );
    const targetSteer = intent.steering * Math.min(t.maxSteerAngle * speedScale, gripSteer);
    this.steerAngle += clamp(targetSteer - this.steerAngle, -t.steerResponse * dt, t.steerResponse * dt);

    // Brake pedal (left trigger / S): while rolling forward it clamps all
    // four wheels toward zero spin; once (nearly) stopped and off the
    // accelerator it becomes reverse throttle — the standard arcade scheme.
    const reversing = intent.brake > 0.01 && forwardSpeed < 0.5 && intent.throttle <= 0.01;
    const braking = intent.brake > 0.01 && !reversing;
    this._reversing = reversing;
    // Signed drive command: the driven-wheel motor code below is direction-
    // agnostic, so reverse is just negative throttle to it.
    const drive = reversing ? -intent.brake : braking ? 0 : intent.throttle;

    for (const wheel of this.wheelUnits) {
      if (wheel.steered) {
        // Kinematic steering hold: pin the yaw axis limits at the commanded
        // angle so the solver enforces it rigidly — no motor gains to shimmy.
        const steer = STEER_SIGN * this.steerAngle;
        wheel.constraint.setAxisMinLimit(PhysicsConstraintAxis.ANGULAR_Y, steer);
        wheel.constraint.setAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_Y, steer);
      }
      if (braking) {
        // Brake = velocity motor holding zero spin with the brake-scaled
        // force budget. This is the one place a target-below-rolling-speed
        // motor is CORRECT: spending the friction budget longitudinally is
        // exactly what a brake is for.
        wheel.constraint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);
        wheel.constraint.setAxisMotorMaxForce(
          PhysicsConstraintAxis.ANGULAR_X,
          intent.brake * t.maxBrakeTorque,
        );
      } else if (wheel.driven) {
        if (Math.abs(drive) > 0.01) {
          const speedCap = drive > 0 ? t.maxSpeed : t.maxSpeed * t.reverseSpeedFactor;
          const targetOmega = (DRIVE_SIGN * Math.sign(drive) * speedCap) / t.wheelRadius;
          wheel.constraint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, targetOmega);
          wheel.constraint.setAxisMotorMaxForce(
            PhysicsConstraintAxis.ANGULAR_X,
            Math.abs(drive) * t.maxDriveTorque,
          );
        } else {
          wheel.constraint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);
          wheel.constraint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, t.coastTorque);
        }
      } else {
        // Undriven front wheel, brakes released: leave the axle free.
        wheel.constraint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, 0);
      }
    }
  }
}
