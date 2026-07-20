import { PhysicsBody, TransformNode, Vector3, Quaternion } from '@babylonjs/core';
import { PhysicsRaycastResult } from '@babylonjs/core/Physics/physicsRaycastResult';
import type { PhysicsEngine } from '@babylonjs/core/Physics/v2/physicsEngine';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import { clamp } from '../input/deadzone';

export interface WheelConfig {
  /** Suspension attach point in chassis local space. */
  localPosition: Vector3;
  steered: boolean;
  driven: boolean;
}

export interface VehicleTuning {
  wheelRadius: number;
  /** Suspension travel from attach point to wheel center at full extension, in m. */
  suspensionRestLength: number;
  /** Spring stiffness, N/m. */
  suspensionStiffness: number;
  /** Damper strength, N·s/m. */
  suspensionDamping: number;
  /** Peak motor force per driven wheel, N. Tapers linearly to 0 at maxSpeed. */
  maxDriveForce: number;
  /** Forward speed where drive force reaches zero, m/s. */
  maxSpeed: number;
  /** Reverse speed cap as a fraction of maxSpeed. */
  reverseSpeedFactor: number;
  /** Lateral tire stiffness, N per m/s of sideways slip (linear region). */
  lateralGrip: number;
  /** Friction coefficient capping lateral force at μ × suspension load — lower = driftier. */
  lateralFrictionCoeff: number;
  /** Rolling resistance per grounded wheel when coasting, N per m/s. */
  rollingResistance: number;
  /** Max steering angle at standstill, rad. */
  maxSteerAngle: number;
  /** How much steering tightens down with speed (per m/s). */
  steerSpeedFalloff: number;
  /** How fast the steering angle chases the stick, rad/s equivalent (higher = twitchier). */
  steerResponse: number;
  /**
   * Where tire forces are applied along mount→contact-patch: 0 = at the mount
   * (no load transfer, body stays flat), 1 = at the contact patch (max roll/
   * dive/squat, cornering at the grip limit can lift inner wheels).
   */
  tireForceContactLerp: number;
  /** Bumper spring stiffness against steep obstacles, N/m of penetration. */
  bumperStiffness: number;
  /** Bumper damping against approach speed into the obstacle, N·s/m. */
  bumperDamping: number;
  /** Cap on a single wheel's bumper force, N — keeps wall hits from exploding. */
  bumperMaxForce: number;
  /**
   * Surfaces whose normal·chassisUp is above this are terrain the suspension
   * handles; below it they count as obstacles the bumper pushes back from.
   * 0.75 ≈ faces steeper than ~41°.
   */
  obstacleMaxNormalDot: number;
}

export const DEFAULT_TUNING: VehicleTuning = {
  wheelRadius: 0.75,
  suspensionRestLength: 0.5,
  suspensionStiffness: 100,
  suspensionDamping: 14,
  maxDriveForce: 50,
  maxSpeed: 14,
  reverseSpeedFactor: 0.5,
  lateralGrip: 25,
  lateralFrictionCoeff: 1.1,
  // Keep tiny: undriven wheels pay this at all times, so it directly caps top
  // speed (fronts drag 2 × this × v against the motor taper).
  rollingResistance: 0.3,
  maxSteerAngle: 0.6,
  steerSpeedFalloff: 0.06,
  steerResponse: 8,
  tireForceContactLerp: 0.6,
  bumperStiffness: 2500,
  bumperDamping: 120,
  bumperMaxForce: 1200,
  obstacleMaxNormalDot: 0.75,
};

// Bumper casts tilt ~40° below the wheel's heading: steep enough to catch
// curb-like step edges below hub height, shallow enough that the cast never
// reaches flat ground under the wheel (cast length × sin(tilt) < wheelRadius).
const BUMPER_TILT_COS = Math.cos(0.7);
const BUMPER_TILT_SIN = Math.sin(0.7);
const BUMPER_CAST_MARGIN = 0.2;

interface WheelState {
  config: WheelConfig;
  grounded: boolean;
  /** Distance from attach point to wheel center, clamped to [0, restLength]. */
  suspensionLength: number;
  /** Suspension load this frame, N — reused as the grip budget for the tire. */
  load: number;
  /** Accumulated visual roll angle, rad. */
  spin: number;
  /** True while the bumper cast is pushing back from a steep obstacle. */
  bumperActive: boolean;
}

/**
 * Raycast vehicle: the chassis is the only rigid body; each wheel is a ray
 * fired down from its attach point. Suspension is a spring/damper force at
 * the attach point, tires add a lateral grip force (clamped to μ × load,
 * which is where drifting comes from) and a motor/rolling-resistance force
 * along the wheel's heading. Wheel meshes are purely cosmetic.
 */
export class RaycastVehicle {
  readonly wheels: WheelState[];
  private body: PhysicsBody;
  private transform: TransformNode;
  private input: InputProvider;
  private scene: Scene;
  private tuning: VehicleTuning;
  private steerAngle = 0;

  // Scratch vectors, reused every frame to avoid per-frame allocation.
  private linVel = new Vector3();
  private angVel = new Vector3();
  private raycastResult = new PhysicsRaycastResult();

  constructor(
    body: PhysicsBody,
    transform: TransformNode,
    input: InputProvider,
    scene: Scene,
    wheelConfigs: WheelConfig[],
    tuning: VehicleTuning = DEFAULT_TUNING,
  ) {
    this.body = body;
    this.transform = transform;
    this.input = input;
    this.scene = scene;
    this.tuning = tuning;
    this.wheels = wheelConfigs.map((config) => ({
      config,
      grounded: false,
      suspensionLength: tuning.suspensionRestLength,
      load: 0,
      spin: 0,
      bumperActive: false,
    }));
  }

  get currentSteerAngle(): number {
    return this.steerAngle;
  }

  update(dt: number): void {
    const t = this.tuning;
    const intent = this.input.poll();

    this.body.getLinearVelocityToRef(this.linVel);
    this.body.getAngularVelocityToRef(this.angVel);

    const up = Vector3.TransformNormal(Vector3.UpReadOnly, this.transform.getWorldMatrix()).normalize();
    const centerWorld = this.body.getObjectCenterWorld();
    const forwardSpeed = Vector3.Dot(this.linVel, this.transform.forward);

    // Steering chases the stick, and tightens at speed so full lock at top
    // speed doesn't just spin you out.
    const speedScale = 1 / (1 + Math.abs(forwardSpeed) * t.steerSpeedFalloff);
    const targetSteer = intent.steering * t.maxSteerAngle * speedScale;
    this.steerAngle += clamp(targetSteer - this.steerAngle, -t.steerResponse * dt, t.steerResponse * dt);

    // scene.getPhysicsEngine() is typed as the v1 interface, but with the
    // Havok plugin enabled it is always the v2 engine, which has raycastToRef.
    const physicsEngine = this.scene.getPhysicsEngine() as PhysicsEngine | null;
    if (!physicsEngine) return;

    // Which way the car is moving — or trying to move from rest — so bumper
    // casts look ahead when driving forward and behind when reversing.
    const travelSign =
      Math.abs(forwardSpeed) > 0.25 ? Math.sign(forwardSpeed) : Math.sign(intent.throttle);

    // Throttling into an obstacle must not flip the car: drive reacting
    // against a pinned nose torques into a wheelie, and once pitched the
    // bumper casts lose the wall and full drive would finish the flip. So:
    // crawl-only drive while any bumper (from last frame) is engaged, and no
    // drive at all when pitched past ~30° at near-standstill — steeper than
    // any drivable ramp, so hill starts are unaffected. Reversing away is
    // never cut, since the casts flip with travel direction and lose the wall.
    const pitchUp = Vector3.Dot(this.transform.forward, Vector3.UpReadOnly);
    let driveScale = this.wheels.some((w) => w.bumperActive) ? 0.2 : 1;
    if (pitchUp > 0.5 && Math.abs(forwardSpeed) < 3 && intent.throttle > 0) driveScale = 0;

    for (const wheel of this.wheels) {
      const attachWorld = Vector3.TransformCoordinates(wheel.config.localPosition, this.transform.getWorldMatrix());

      // Wheel heading: chassis forward/right, steered for front wheels.
      let wheelForward = this.transform.forward;
      let wheelRight = this.transform.right;
      if (wheel.config.steered && this.steerAngle !== 0) {
        const steerRot = Quaternion.RotationAxis(up, this.steerAngle);
        wheelForward = wheelForward.applyRotationQuaternion(steerRot);
        wheelRight = wheelRight.applyRotationQuaternion(steerRot);
      }

      // Velocity of the chassis at this wheel's attach point.
      const r = attachWorld.subtract(centerWorld);
      const pointVel = this.linVel.add(Vector3.Cross(this.angVel, r));

      const rayLength = t.suspensionRestLength + t.wheelRadius;
      const rayEnd = attachWorld.subtract(up.scale(rayLength));
      physicsEngine.raycastToRef(attachWorld, rayEnd, this.raycastResult, { ignoreBody: this.body });

      if (this.raycastResult.hasHit) {
        wheel.grounded = true;
        wheel.suspensionLength = clamp(this.raycastResult.hitDistance - t.wheelRadius, 0, t.suspensionRestLength);

        // --- Suspension: spring pushes, damper resists travel. Never pulls.
        // Acts at the mount, like the real strut. ---
        const compression = t.suspensionRestLength - wheel.suspensionLength;
        const compressionVel = -Vector3.Dot(pointVel, up);
        const suspensionForce = Math.max(
          t.suspensionStiffness * compression + t.suspensionDamping * compressionVel,
          0,
        );
        wheel.load = suspensionForce;
        this.body.applyForce(up.scale(suspensionForce), attachWorld);

        // Tire forces act down toward the contact patch so cornering and
        // accel/brake transfer load between wheels — that torque against the
        // springs is what makes the body roll, dive, and squat.
        const tirePoint = Vector3.Lerp(
          attachWorld,
          this.raycastResult.hitPointWorld,
          t.tireForceContactLerp,
        );

        // --- Lateral grip: linear in slip, saturating at μ × load. ---
        const lateralSlip = Vector3.Dot(pointVel, wheelRight);
        const gripLimit = t.lateralFrictionCoeff * wheel.load;
        const lateralForce = clamp(-lateralSlip * t.lateralGrip, -gripLimit, gripLimit);
        this.body.applyForce(wheelRight.scale(lateralForce), tirePoint);

        // --- Longitudinal: motor force tapering with speed, or rolling resistance. ---
        const wheelForwardSpeed = Vector3.Dot(pointVel, wheelForward);
        let longitudinalForce = 0;
        if (Math.abs(intent.throttle) > 0.01 && wheel.config.driven) {
          const speedCap = intent.throttle > 0 ? t.maxSpeed : t.maxSpeed * t.reverseSpeedFactor;
          const taper = clamp(1 - (wheelForwardSpeed / speedCap) * Math.sign(intent.throttle), 0, 1.5);
          longitudinalForce = intent.throttle * t.maxDriveForce * taper * driveScale;
        } else {
          longitudinalForce = -wheelForwardSpeed * t.rollingResistance;
        }
        this.body.applyForce(wheelForward.scale(longitudinalForce), tirePoint);

        wheel.spin += (wheelForwardSpeed / t.wheelRadius) * dt;
      } else {
        wheel.grounded = false;
        wheel.suspensionLength = t.suspensionRestLength;
        wheel.load = 0;
      }

      // --- Bumper: a tilted cast along the direction of travel that pushes
      // back from faces too steep to drive, so wheels stop against walls and
      // steep slopes instead of clipping through until the chassis hits. ---
      wheel.bumperActive = false;
      if (travelSign !== 0) {
        const hub = attachWorld.subtract(up.scale(wheel.suspensionLength));
        const castDir = wheelForward.scale(travelSign * BUMPER_TILT_COS).subtract(up.scale(BUMPER_TILT_SIN));
        const castLength = t.wheelRadius + BUMPER_CAST_MARGIN;
        const castEnd = hub.add(castDir.scale(castLength));
        physicsEngine.raycastToRef(hub, castEnd, this.raycastResult, { ignoreBody: this.body });

        if (
          this.raycastResult.hasHit &&
          Vector3.Dot(this.raycastResult.hitNormalWorld, up) < t.obstacleMaxNormalDot
        ) {
          const normal = this.raycastResult.hitNormalWorld;
          const penetration = castLength - this.raycastResult.hitDistance;
          const approachSpeed = Math.max(-Vector3.Dot(pointVel, normal), 0);
          const bumperForce = Math.min(
            t.bumperStiffness * penetration + t.bumperDamping * approachSpeed,
            t.bumperMaxForce,
          );
          this.body.applyForce(normal.scale(bumperForce), hub);
          wheel.bumperActive = true;
        }
      }
    }
  }
}
