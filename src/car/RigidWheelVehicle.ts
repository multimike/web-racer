import {
  Mesh,
  MeshBuilder,
  Quaternion,
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
import type { TuningParam, Vehicle, WheelGroundState } from './Vehicle';
import type { VehicleRig } from './rig';
import { VehicleVisual } from './visual';
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
  /**
   * Turning radius at full lock, m — measured at the REAR AXLE CENTER
   * (bicycle model: R = wheelbase / tan δ). The curb-to-curb radius real
   * spec sheets quote is roughly this + half the track width. This is THE
   * steering knob: max steer angle is derived from it and the wheelbase.
   */
  minTurnRadius: number;
  /** How much steering tightens down with speed (per m/s). 0 = off: wheels
   * reach full lock at any speed, like a real steering rack. */
  steerSpeedFalloff: number;
  /**
   * Grip-circle steering cap: commanded lateral accel is limited to this ×
   * μ·g. 1 = corner exactly at the tire limit (no slide), higher lets the
   * driver push a bit past it for controllable drift. 0 = cap disabled
   * (fixed-angle steering test — expect understeer/slide when overdriven).
   */
  steerGripMargin: number;
  /** How fast the steering angle chases the stick, rad/s equivalent. */
  steerResponse: number;
}

// Real-scale tuning for what the geometry actually is: the 4.1 m RB-01 buggy
// on 1.04 m tires, ~1500 kg all-in (1300 kg chassis + 4 × 50 kg wheels).
// Corner mass ≈ 325 kg.
export const DEFAULT_RIGID_TUNING: RigidWheelTuning = {
  // Blueprint tire: 1040 mm tall, 420 mm wide.
  wheelRadius: 0.52,
  wheelWidth: 0.42,
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
  minTurnRadius: 5,
  // Both speed limiters OFF by default: testing real fixed-angle steering
  // (2026-07). Re-enable live from the tuning panel / console for A/B — the
  // old feel was steerSpeedFalloff 0.04, steerGripMargin 0.6 (0.6 against
  // scene gravity 25 ≈ the cap 1.5 gave against 9.81).
  steerSpeedFalloff: 0,
  steerGripMargin: 0,
  steerResponse: 12,            // Increased from 8 so the wheels snap to the stick faster
}

// Empirical sign flips for the constraint axis conventions (they depend on
// which body is A vs B in the constraint). Verified by driving: positive
// ANGULAR_X motor target = forward roll, positive ANGULAR_Y target = right.
const DRIVE_SIGN = 1;
const STEER_SIGN = 1;

// Wheel attach points in chassis local space, straight off the RB-01
// blueprint: 2100 mm overall width over the tires (2 × 0.84 + the 0.42 wheel
// width) on a 2600 mm wheelbase. Changing these changes the car's stance AND
// its steering geometry — WHEELBASE below is derived from WHEEL_Z, so
// minTurnRadius keeps meaning the same thing while full lock moves with it.
const WHEEL_X = 0.84;
const WHEEL_Z = 1.3;
/** Front-to-rear axle distance — the L in every steering-geometry formula. */
const WHEELBASE = 2 * WHEEL_Z;
// Mount height: wheel center rests here (plus spring sag) below chassis center.
const ATTACH_Y = -0.5;

interface WheelUnit {
  mesh: Mesh;
  body: PhysicsBody;
  shape: PhysicsShapeCylinder;
  constraint: Physics6DoFConstraint;
  steered: boolean;
  driven: boolean;
  /** Lateral offset from the chassis centerline, m (+ = right side). */
  localX: number;
  /** Tire radius, m (= tuning.wheelRadius without a rig; per axle on a rig). */
  radius: number;
  /** Constraint pivot in chassis space (the hub sits here with the spring relaxed). */
  pivot: Vector3;
  /** Static spring compression at rest, m (reset() placement + grounded test). */
  sag: number;
}

// Moved to Vehicle.ts so every vehicle model shares it; re-exported because
// GFX code imports it from here.
export type { WheelGroundState } from './Vehicle';

/**
 * Where the bodies of this rig sit. Without a rig the class uses
 * `legacyLayout()` — the hardcoded RB-01 numbers it has always had (only the
 * lab's `rigid` + `rb01` asks for that). Everywhere else, the game included,
 * `createVehicle` passes the car's `VehicleRig` (`rigLayout()`), which only
 * changes these numbers, never the model: same constraints, same motors,
 * same update().
 */
interface RigidLayout {
  chassisSize: [number, number, number];
  chassisMass: number;
  /** Explicit principal inertia PER UNIT MASS, m² (rig path); null = Havok's box default. */
  inertia: Vector3 | null;
  wheelbase: number;
  /** Chassis origin height above the ground while the bodies are created. */
  spawnY: number;
  /** Chassis origin height above the ground at static rest. */
  restHeight: number;
  wheels: Array<{
    x: number; y: number; z: number;
    radius: number; width: number; mass: number;
    stiffness: number; damping: number; sag: number;
    steered: boolean; driven: boolean;
  }>;
}

/** Hair-width range of the suspension axis (see the constraint comment). */
const SPRING_SLOP = 0.01;

function legacyLayout(t: RigidWheelTuning, gravity: number): RigidLayout {
  const sag = ((1300 / 4) * gravity) / t.suspensionStiffness + SPRING_SLOP;
  const wheel = (x: number, z: number, steered: boolean, driven: boolean) => ({
    x, y: ATTACH_Y, z,
    radius: t.wheelRadius, width: t.wheelWidth, mass: t.wheelMass,
    stiffness: t.suspensionStiffness, damping: t.suspensionDamping, sag,
    steered, driven,
  });
  return {
    chassisSize: [1.4, 0.6, 2.4],
    chassisMass: 1300,
    inertia: null,
    wheelbase: WHEELBASE,
    spawnY: 1.6,
    restHeight: t.wheelRadius - ATTACH_Y - sag,
    wheels: [
      wheel(-WHEEL_X, WHEEL_Z, true, false),
      wheel(WHEEL_X, WHEEL_Z, true, false),
      wheel(-WHEEL_X, -WHEEL_Z, false, true),
      wheel(WHEEL_X, -WHEEL_Z, false, true),
    ],
  };
}

function rigLayout(rig: VehicleRig, gravity: number): RigidLayout {
  // Chassis origin = centre of the rig's collision hull.
  const [, hy, hz] = rig.hull.center;
  return {
    chassisSize: rig.hull.size,
    chassisMass: rig.sprungMass,
    // GOTCHA (verified in the physics lab): the `inertia` Babylon hands to
    // Havok is PER UNIT MASS (m²), not kg·m² — the legacy 1.4 × 0.6 × 2.4 box
    // reads back (0.51, 0.64, 0.19) = (h²+l², w²+l², w²+h²)/12 at mass 1300.
    // Passing absolute kg·m² made the chassis ~650× too heavy in yaw.
    inertia: new Vector3(
      rig.inertia[0] / rig.sprungMass,
      rig.inertia[1] / rig.sprungMass,
      rig.inertia[2] / rig.sprungMass,
    ),
    wheelbase: rig.wheelbase,
    spawnY: hy + 0.05,
    restHeight: hy,
    wheels: rig.wheels.map((w) => {
      const axle = w.axle === 'front' ? rig.front : rig.rear;
      const sag = (axle.sprungCornerMass * gravity) / axle.springRate + SPRING_SLOP;
      return {
        x: w.x, y: w.y - hy - sag, z: w.z - hz,
        radius: w.radius, width: w.width, mass: w.mass,
        stiffness: axle.springRate, damping: axle.damperRate, sag,
        steered: w.steered, driven: w.driven,
      };
    }),
  };
}

/**
 * Legacy tuning carried onto a rig: geometry, masses and springs come from
 * the rig; drive/brake/coast torques keep the legacy force-to-weight ratio
 * (scaled by mass and by the driven tire radius), everything else is the
 * legacy DEFAULT_RIGID_TUNING. Used whenever a rig is given (the game's
 * `vehicle=rigid` included); only rigless RB-01 skips it.
 */
export function rigidTuningForRig(rig: VehicleRig): RigidWheelTuning {
  const d = DEFAULT_RIGID_TUNING;
  const torqueScale = (rig.totalMass / 1500) * (rig.rear.tireRadius / d.wheelRadius);
  return {
    ...d,
    wheelRadius: rig.rear.tireRadius,
    wheelWidth: rig.rear.tireWidth,
    wheelMass: rig.rear.wheelMass,
    suspensionStiffness: (rig.front.springRate + rig.rear.springRate) / 2,
    suspensionDamping: (rig.front.damperRate + rig.rear.damperRate) / 2,
    maxDriveTorque: d.maxDriveTorque * torqueScale,
    coastTorque: d.coastTorque * torqueScale,
    maxBrakeTorque: d.maxBrakeTorque * torqueScale,
    comHeight: rig.com[1] - rig.hull.center[1],
    comForward: rig.com[2] - rig.hull.center[2],
  };
}

const RIGID_TUNING_PARAMS: TuningParam[] = [
  { key: 'comHeight', label: 'CoM height', min: -0.5, max: 0.4, step: 0.01 },
  { key: 'comForward', label: 'CoM fwd/back', min: -1.0, max: 1.0, step: 0.05 },
  { key: 'wheelFriction', label: 'tire friction', min: 0.2, max: 8, step: 0.1 },
  { key: 'maxDriveTorque', label: 'drive torque', min: 500, max: 20000, step: 250 },
  { key: 'maxBrakeTorque', label: 'brake torque', min: 500, max: 20000, step: 250 },
  { key: 'coastTorque', label: 'coast torque', min: 0, max: 6000, step: 100 },
  { key: 'maxSpeed', label: 'max speed', min: 5, max: 40, step: 1 },
  { key: 'minTurnRadius', label: 'turn radius (m)', min: 2, max: 12, step: 0.25 },
  { key: 'steerSpeedFalloff', label: 'steer speed falloff', min: 0, max: 0.2, step: 0.005 },
  { key: 'steerGripMargin', label: 'grip steer cap (0=off)', min: 0, max: 2, step: 0.05 },
  { key: 'steerResponse', label: 'steer response', min: 1, max: 30, step: 0.5 },
];

/**
 * Rigid-body vehicle: each wheel is a real dynamic cylinder collider joined
 * to the chassis by a 6DoF constraint — vertical axis soft-locked with
 * stiffness/damping (the damped suspension spring), axle axis free with a
 * velocity motor for drive (torque-commanded: target = speed cap, force limit
 * = throttle × torque), steering by kinematic limit clamping on the yaw axis
 * of the front constraints (a position motor there shimmies). Grip, load transfer, and obstacle collision all come
 * from the physics engine's own contact solving: nothing is faked with rays.
 */
export class RigidWheelVehicle implements Vehicle {
  readonly modelName = 'rigid';
  /** null only for the rigless RB-01 (hardcoded layout, the lab's `rigid` + `rb01`); otherwise the car's rig. */
  readonly rig: VehicleRig | null;
  readonly tuningParams: readonly TuningParam[] = RIGID_TUNING_PARAMS;
  readonly chassisMesh: Mesh;
  /** Live tuning: torque/speed fields are read every frame, so mutating them
   * takes effect immediately; COM and friction need applyCenterOfMass /
   * applyWheelFriction after mutation. */
  readonly tuning: RigidWheelTuning;
  /** One entry per wheel (FL, FR, RL, RR), refreshed every update(). */
  readonly wheelStates: WheelGroundState[] = [];
  readonly visual: VehicleVisual;
  readonly chassisBody: PhysicsBody;
  private input: InputProvider;
  private layout: RigidLayout;
  private chassisAggregate: PhysicsAggregate;
  private wheelAggregates: PhysicsAggregate[] = [];
  private pivotWorld = new Vector3();
  private steerCap = 0;
  /** update() calls left until reset()'s pre-step teleport is switched off again. */
  private preStepFrames = 0;
  private wheelUnits: WheelUnit[] = [];
  private steerAngle = 0;
  private linVel = new Vector3();
  private _forwardSpeed = 0;
  private _reversing = false;
  private _drivenRimSpeed = 0;
  private angVel = new Vector3();
  /** Scene gravity magnitude — grip scales with m·g, so the steering cap must too. */
  private gravityMag: number;

  /**
   * @param rig Omitted (only the lab's `rigid` + `rb01`), the car is the
   * hardcoded RB-01 layout exactly as before; given (every game car), body
   * sizes/positions/masses/springs come from the rig and `tuning` defaults
   * to `rigidTuningForRig(rig)`.
   */
  constructor(scene: Scene, input: InputProvider, tuning?: RigidWheelTuning, rig?: VehicleRig) {
    this.input = input;
    this.rig = rig ?? null;
    // Clone so slider tweaks on this instance never bleed into the shared default.
    this.tuning = { ...(tuning ?? (rig ? rigidTuningForRig(rig) : DEFAULT_RIGID_TUNING)) };
    this.gravityMag = scene.getPhysicsEngine()?.gravity.length() ?? 9.81;
    const layout = rig ? rigLayout(rig, this.gravityMag) : legacyLayout(this.tuning, this.gravityMag);
    this.layout = layout;

    // --- Chassis: the collider box stays exactly as tuned. It is an invisible
    // proxy: this class draws nothing — the game dresses it with a procedural
    // car through `visual` (GameCar), the physics lab draws its own debug. ---
    const [chassisW, chassisH, chassisD] = layout.chassisSize;
    const chassis = MeshBuilder.CreateBox('car', { width: chassisW, height: chassisH, depth: chassisD }, scene);
    chassis.position.set(0, layout.spawnY, 0);
    chassis.isVisible = false;
    this.chassisMesh = chassis;

    const chassisAggregate = new PhysicsAggregate(
      chassis,
      PhysicsShapeType.BOX,
      { mass: layout.chassisMass, friction: 0.5, restitution: 0.1 },
      scene,
    );
    this.chassisAggregate = chassisAggregate;
    this.chassisBody = chassisAggregate.body;
    this.applyCenterOfMass();
    // Token aero/driveline losses only — yaw damping is the tires' job.
    this.chassisBody.setAngularDamping(0.1);
    this.chassisBody.setLinearDamping(0.02);

    layout.wheels.forEach((cfg, i) => {
      const t = this.tuning;

      const mesh = MeshBuilder.CreateCylinder(
        `rigidWheel${i}`,
        { diameter: cfg.radius * 2, height: cfg.width, tessellation: rig ? 12 : 4 },
        scene,
      );
      // Cylinder is built along Y; bake a 90° roll so its local axis is X
      // (the axle), which the physics shape below assumes.
      mesh.rotation.z = Math.PI / 2;
      mesh.bakeCurrentTransformIntoVertices();
      // Collision proxy only (see the chassis comment).
      mesh.isVisible = false;
      mesh.position.set(cfg.x, layout.spawnY + cfg.y, cfg.z);

      const shape = new PhysicsShapeCylinder(
        new Vector3(-cfg.width / 2, 0, 0),
        new Vector3(cfg.width / 2, 0, 0),
        cfg.radius,
        scene,
      );
      const aggregate = new PhysicsAggregate(mesh, shape, {
        mass: cfg.mass,
        friction: t.wheelFriction,
        restitution: 0,
      }, scene);
      aggregate.body.setAngularDamping(0.05);

      const constraint = new Physics6DoFConstraint(
        {
          pivotA: new Vector3(cfg.x, cfg.y, cfg.z),
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
            minLimit: -SPRING_SLOP,
            maxLimit: SPRING_SLOP,
            stiffness: cfg.stiffness,
            damping: cfg.damping,
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

      this.wheelAggregates.push(aggregate);
      this.wheelUnits.push({
        mesh, body: aggregate.body, shape, constraint,
        steered: cfg.steered, driven: cfg.driven, localX: cfg.x,
        radius: cfg.radius, pivot: new Vector3(cfg.x, cfg.y, cfg.z), sag: cfg.sag,
      });
      this.wheelStates.push({
        position: new Vector3(), velocity: new Vector3(), rollSpeed: 0, slipSpeed: 0,
        grounded: false, steerAngle: 0, spinSpeed: 0, radius: cfg.radius,
      });
    });

    // Visual contract (visual.ts): model space = ground under the wheelbase centre.
    this.visual = new VehicleVisual(
      scene, this.chassisMesh,
      rig ? { x: 0, y: -rig.hull.center[1], z: -rig.hull.center[2] } : { x: 0, y: -layout.restHeight, z: 0 },
      rig ? rig.wheels : layout.wheels.map((w) => ({ x: w.x, y: w.radius, z: w.z, radius: w.radius })),
    );
  }

  /** Bicycle-model steer angle, rad (per-wheel Ackermann angles derive from it). */
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
    const centerOfMass = new Vector3(0, this.tuning.comHeight, this.tuning.comForward);
    if (this.layout.inertia) {
      this.chassisBody.setMassProperties({
        mass: this.layout.chassisMass,
        centerOfMass,
        inertia: this.layout.inertia,
      });
      return;
    }
    this.chassisBody.setMassProperties({ mass: this.layout.chassisMass, centerOfMass });
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

    // reset() teleports through Havok's pre-step transform copy; switch it
    // back off once the step after the reset has consumed it.
    if (this.preStepFrames > 0 && --this.preStepFrames === 0) {
      this.chassisBody.disablePreStep = true;
      for (const wheel of this.wheelUnits) wheel.body.disablePreStep = true;
    }

    this.chassisBody.getLinearVelocityToRef(this.linVel);
    const forwardSpeed = Vector3.Dot(this.linVel, this.chassisMesh.forward);
    this._forwardSpeed = forwardSpeed;

    // Per-wheel contact kinematics: rolling speed + slip for the dust GFX,
    // driven-wheel rim speed for the engine sound. The wheel mesh's world X
    // is its axle — spin is ABOUT local X so it can't smear the reading, and
    // it follows steering on the fronts (rears stay = chassis right).
    let rimSpeed = 0;
    let drivenCount = 0;
    for (let i = 0; i < this.wheelUnits.length; i++) {
      const wheel = this.wheelUnits[i];
      const state = this.wheelStates[i];
      state.position.copyFrom(wheel.mesh.position);
      wheel.body.getLinearVelocityToRef(state.velocity);
      wheel.body.getAngularVelocityToRef(this.angVel);
      const axle = wheel.mesh.right;
      const spin = DRIVE_SIGN * Vector3.Dot(this.angVel, axle);
      const rim = spin * wheel.radius;
      state.spinSpeed = spin;
      // Loaded = the hub sits above its relaxed position by a real fraction
      // of the static sag (airborne, the spring pushes it back to the pivot).
      Vector3.TransformCoordinatesToRef(wheel.pivot, this.chassisMesh.getWorldMatrix(), this.pivotWorld);
      const up = this.chassisMesh.up;
      const compression =
        (state.position.x - this.pivotWorld.x) * up.x +
        (state.position.y - this.pivotWorld.y) * up.y +
        (state.position.z - this.pivotWorld.z) * up.z;
      state.grounded = compression > 0.25 * wheel.sag;
      // ACTUAL steer angle of the hub (what the constraint achieved, not what
      // was commanded): axle direction in the chassis frame.
      if (wheel.steered) {
        state.steerAngle = Math.atan2(
          -Vector3.Dot(axle, this.chassisMesh.forward),
          Vector3.Dot(axle, this.chassisMesh.right),
        );
      }
      if (wheel.driven) {
        rimSpeed += rim;
        drivenCount += 1;
      }
      // Rolling direction = axle × up, i.e. the wheel's heading projected onto
      // the ground plane. Degenerates when the wheel lies on its side — call
      // everything slide then (a capsized wheel has no rolling direction).
      const headingLen = Math.hypot(axle.x, axle.z);
      if (headingLen < 0.2) {
        state.rollSpeed = 0;
        state.slipSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      } else {
        const fwdX = -axle.z / headingLen;
        const fwdZ = axle.x / headingLen;
        const groundFwd = state.velocity.x * fwdX + state.velocity.z * fwdZ;
        const longSlip = rim - groundFwd;
        const latSlip = Vector3.Dot(state.velocity, axle);
        state.rollSpeed = Math.abs(groundFwd);
        state.slipSpeed = Math.hypot(longSlip, latSlip);
      }
    }
    this._drivenRimSpeed = drivenCount > 0 ? rimSpeed / drivenCount : 0;

    // Full lock derived from the turning-radius knob (bicycle model).
    const WHEELBASE = this.layout.wheelbase;
    const maxSteer = Math.atan(WHEELBASE / Math.max(t.minTurnRadius, this.layout.wheels[1].x + 0.1));
    // Optional speed limiters, both OFF (0) while testing real fixed-angle
    // steering. Falloff shrinks lock with speed; the grip-circle cap limits
    // commanded lateral accel v²·tanδ/L to margin × μ·g — past that the
    // front tires just wash out sideways (the old high-speed slide). The cap
    // uses TOTAL planar speed, not forward speed: in a slide forward speed
    // collapses while the car still carries full velocity sideways, and a
    // forward-speed cap would open right back up and wind steering into the
    // spin.
    let steerCap = t.steerSpeedFalloff > 0
      ? maxSteer / (1 + Math.abs(forwardSpeed) * t.steerSpeedFalloff)
      : maxSteer;
    if (t.steerGripMargin > 0) {
      const planarSq = this.linVel.x * this.linVel.x + this.linVel.z * this.linVel.z;
      const gripSteer = Math.atan(
        (t.steerGripMargin * t.wheelFriction * this.gravityMag * WHEELBASE) / Math.max(planarSq, 0.01),
      );
      steerCap = Math.min(steerCap, gripSteer);
    }
    this.steerCap = steerCap;
    const targetSteer = intent.steering * steerCap;
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

    // Ackermann geometry: steerAngle is the BICYCLE steer angle (a virtual
    // center wheel); each real front wheel is aimed at the common turn
    // center, which sits R = L/tanδ to the side of the rear axle. The wheel
    // offset x from the centerline gives tanδ_wheel = L / (R − x), i.e. the
    // inner wheel turns tighter than the outer. Signed math handles both
    // directions (positive steerAngle = right turn = center on the +x side).
    const tanSteer = Math.tan(this.steerAngle);
    for (const wheel of this.wheelUnits) {
      if (wheel.steered) {
        // Kinematic steering hold: pin the yaw axis limits at the commanded
        // angle so the solver enforces it rigidly — no motor gains to shimmy.
        const ackermann = Math.atan(
          (WHEELBASE * tanSteer) / (WHEELBASE - wheel.localX * tanSteer),
        );
        const steer = STEER_SIGN * ackermann;
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
          const targetOmega = (DRIVE_SIGN * Math.sign(drive) * speedCap) / wheel.radius;
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

    this.visual.capture(this.wheelStates, dt, intent, this.currentSteerAngle, this.isReversing);
  }

  // --- Vehicle interface additions (lab / generic consumers) ---------------

  get maxSteerAngle(): number {
    return this.steerCap > 0
      ? this.steerCap
      : Math.atan(this.layout.wheelbase / Math.max(this.tuning.minTurnRadius, this.layout.wheels[1].x + 0.1));
  }

  get wheelbase(): number {
    return this.layout.wheelbase;
  }

  get topSpeed(): number {
    return this.tuning.maxSpeed;
  }

  get nominalGrip(): number {
    return this.tuning.wheelFriction;
  }

  getTuning(key: string): number | undefined {
    const value = (this.tuning as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  }

  /** Suspension/geometry keys are construction-time only: they are stored
   * but do not reach the already-built constraints. */
  setTuning(key: string, value: number): boolean {
    if (this.getTuning(key) === undefined) return false;
    (this.tuning as unknown as Record<string, number>)[key] = value;
    if (key === 'comHeight' || key === 'comForward') this.applyCenterOfMass();
    if (key === 'wheelFriction') this.applyWheelFriction();
    return true;
  }

  /**
   * Teleport (see the CLAUDE.md gotcha): chassis AND all four wheel meshes
   * are moved, pre-step transform copy is enabled for the next physics step,
   * velocities are zeroed; update() switches the pre-step copy off again.
   */
  reset(groundPoint: Vector3, yaw: number): void {
    const q = Quaternion.FromEulerAngles(0, yaw, 0);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const cy = groundPoint.y + this.layout.restHeight + 0.01;
    const place = (mesh: Mesh, body: PhysicsBody, lx: number, ly: number, lz: number) => {
      mesh.position.set(groundPoint.x + lx * cos + lz * sin, cy + ly, groundPoint.z - lx * sin + lz * cos);
      if (mesh.rotationQuaternion) mesh.rotationQuaternion.copyFrom(q);
      else mesh.rotationQuaternion = q.clone();
      mesh.computeWorldMatrix(true);
      body.disablePreStep = false;
      body.setLinearVelocity(Vector3.ZeroReadOnly);
      body.setAngularVelocity(Vector3.ZeroReadOnly);
    };
    place(this.chassisMesh, this.chassisBody, 0, 0, 0);
    for (const wheel of this.wheelUnits) {
      place(wheel.mesh, wheel.body, wheel.pivot.x, wheel.pivot.y + wheel.sag, wheel.pivot.z);
    }
    this.steerAngle = 0;
    this._forwardSpeed = 0;
    this._drivenRimSpeed = 0;
    this._reversing = false;
    this.preStepFrames = 2;
    this.visual.reset();
  }

  setMotion(velocity: Vector3, yawRate: number): void {
    const origin = this.chassisMesh.position;
    const forward = this.chassisMesh.forward;
    const right = this.chassisMesh.right;
    const v = new Vector3();
    // ω × r with ω = (0, yawRate, 0): (yawRate·rz, 0, −yawRate·rx).
    const pointVelocity = (p: Vector3): Vector3 =>
      v.set(velocity.x + yawRate * (p.z - origin.z), velocity.y, velocity.z - yawRate * (p.x - origin.x));
    const com = Vector3.TransformCoordinates(
      new Vector3(0, this.tuning.comHeight, this.tuning.comForward),
      this.chassisMesh.getWorldMatrix(),
    );
    this.chassisBody.setLinearVelocity(pointVelocity(com));
    this.chassisBody.setAngularVelocity(new Vector3(0, yawRate, 0));
    for (const wheel of this.wheelUnits) {
      const wv = pointVelocity(wheel.mesh.position);
      wheel.body.setLinearVelocity(wv);
      // Rolling without slip for the forward component: spin about the axle.
      const spin = (DRIVE_SIGN * Vector3.Dot(wv, forward)) / wheel.radius;
      wheel.body.setAngularVelocity(new Vector3(right.x * spin, yawRate + right.y * spin, right.z * spin));
    }
  }

  dispose(): void {
    for (const wheel of this.wheelUnits) wheel.constraint.dispose();
    for (const aggregate of this.wheelAggregates) aggregate.dispose();
    this.chassisAggregate.dispose();
    for (const wheel of this.wheelUnits) wheel.mesh.dispose();
    this.chassisMesh.dispose();
  }
}
