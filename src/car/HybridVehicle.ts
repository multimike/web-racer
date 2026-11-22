import {
  Mesh,
  MeshBuilder,
  Quaternion,
  Vector3,
  PhysicsAggregate,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  PhysicsShapeCylinder,
  Physics6DoFConstraint,
  PhysicsConstraintAxis,
  PhysicsActivationControl,
  PhysicsMaterialCombineMode,
  PhysicsRaycastResult,
} from '@babylonjs/core';
import type { HavokPlugin, PhysicsEngineV2 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import type { TuningParam, Vehicle, WheelGroundState } from './Vehicle';
import type { VehicleRig } from './rig';
import { VehicleVisual } from './visual';
import { HYBRID_TUNING_PARAMS, hybridTuningForRig } from './hybrid/tuning';
import type { HybridTuning } from './hybrid/tuning';

export { hybridTuningForRig } from './hybrid/tuning';
export type { HybridTuning } from './hybrid/tuning';

/**
 * HYBRID vehicle: real wheel bodies, explicit tire forces.
 *
 * What Havok does (unchanged from the legacy rigid model, because it is the
 * part that works): a chassis body, four dynamic cylinder wheel colliders on
 * 6DoF constraints — vertical axis = damped spring (suspension), axle free,
 * steering = per-frame clamping of the yaw limits. Wheels really collide with
 * ramps, kerbs, rocks and the terrain; the suspension is solved implicitly by
 * the engine.
 *
 * What Havok no longer does: GRIP. The wheel colliders are frictionless. Each
 * frame this class looks at every wheel (one short ray for the ground point
 * and normal, the suspension deflection for the normal load) and computes the
 * tire force itself — a combined-slip friction-circle model with a rising
 * branch, a peak at `grip`·N and a gentle fall to a plateau when sliding (see
 * `solveTires`). Longitudinal force reacts on the wheel body's real spin, so
 * wheelspin, lockup and engine braking are states of the physics bodies, not
 * animations.
 *
 * Force bookkeeping (all momentum-conserving):
 *  - tire force of wheel i acts on the CHASSIS at the contact point (the hub
 *    is rigidly guided by the constraint, so this is statically equivalent to
 *    pushing the wheel and spares the constraint solver the work);
 *  - whatever angular impulse changes a wheel's spin (drive, brake, tire
 *    reaction) is applied to the wheel about its axle and, with opposite
 *    sign, to the chassis — drive torque reaction and brake dive are real,
 *    and throttle/brake pitch the car in the air like an RC car.
 *
 * Frame-rate independence: the tire model is integrated in fixed sub-steps
 * of at most `SUBSTEP` seconds inside update(), against a planar prediction
 * of how the car answers the tire forces (total mass, total yaw inertia,
 * each wheel's spin inertia, gravity along a slope, the car's own rotation
 * during the frame). The summed impulse of the sub-steps is handed to Havok.
 * So tire stiffness never meets the frame time, whatever it is.
 *
 * Non-physical assists, each bounded and with an off switch in the tuning
 * object: anti-lock brakes (`absStrength`), in-air pitch/roll damping
 * (`airStability`), countersteer assist (`slideAssist`, off by default),
 * roll assist (`rollAssist`, off), speed-sensitive lock (`steerSpeedFalloff`,
 * off), parking hold (`autoHold`, off). All tuning: ./hybrid/tuning.ts.
 */

/** Longest tire-model sub-step, s (60 Hz → 7 sub-steps, 30 Hz → 14). */
const SUBSTEP = 1 / 400;
/** Hair-width range of the suspension axis (soft-limit spring acts past it). */
const SPRING_SLOP = 0.01;
/** Collision filter bit of every car shape; wheel rays do not collide with it. */
const CAR_FILTER_BIT = 0x2;

const BRAKE_NONE = 0;
const BRAKE_BRAKING = 1;
const BRAKE_REVERSE = 2;

interface HybridWheel {
  mesh: Mesh;
  body: PhysicsBody;
  shape: PhysicsShapeCylinder;
  constraint: Physics6DoFConstraint;
  steered: boolean;
  driven: boolean;
  front: boolean;
  /** Lateral offset from the centreline, m (+ = right). */
  localX: number;
  radius: number;
  mass: number;
  /** Spin inertia about the axle, kg·m². */
  inertia: number;
  /** Constraint pivot in chassis space (hub sits here with the spring relaxed). */
  pivot: Vector3;
  /** Static spring compression at rest incl. the slop, m. */
  sag: number;
  springRate: number;
  damperRate: number;
  /** Normal load at rest on level ground, N. */
  staticLoad: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** NaN/undefined-safe 0..1 pedal value. */
function pedal(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

export class HybridVehicle implements Vehicle {
  readonly modelName = 'hybrid';
  readonly rig: VehicleRig;
  readonly tuningParams: readonly TuningParam[] = HYBRID_TUNING_PARAMS;
  /** Live tuning object (a private clone of the per-rig defaults). Mutate
   * through setTuning() so values that live inside Havok get pushed. */
  readonly tuning: HybridTuning;
  readonly chassisMesh: Mesh;
  readonly chassisBody: PhysicsBody;
  /** Collider proxies of the four wheels (FL, FR, RL, RR) — invisible; hang
   * the visible wheels on these, they spin and steer with the physics. */
  readonly wheelMeshes: Mesh[] = [];
  readonly wheelStates: WheelGroundState[] = [];
  readonly visual: VehicleVisual;

  private input: InputProvider;
  private engine: PhysicsEngineV2;
  private gravity: number;
  private wheels: HybridWheel[] = [];
  private chassisShape: PhysicsShapeContainer;
  private chassisParts: PhysicsShapeBox[] = [];
  private wheelAggregates: PhysicsAggregate[] = [];

  // --- mass model (constant) ------------------------------------------------
  private totalMass: number;
  /** Yaw inertia of the whole car about its own CoM, kg·m². */
  private totalYawInertia = 1;
  private totalComZ = 0;
  /** Sprung CoM and whole-car CoM in chassis space. */
  private comLocal = new Vector3();
  private totalComLocal = new Vector3();
  /** Chassis principal inertia per unit mass (Havok convention), m². */
  private inertiaPerMass = new Vector3();
  /** Chassis origin height above the ground at static rest. */
  private restHeight: number;

  // --- driver state ---------------------------------------------------------
  private steerAngle = 0;
  /** Countersteer the slide assist is adding right now, rad. */
  private assistAngle = 0;
  /** Stick lock right now (full lock unless steerSpeedFalloff is on), rad. */
  private steerLimit = 0;
  private brakeMode = BRAKE_NONE;
  private brakeHoldTime = 0;
  private _forwardSpeed = 0;
  private _drivenRimSpeed = 0;
  private _reversing = false;
  private preStepFrames = 0;
  private reverseIntent = false;
  private airTime = 0;

  // --- per-wheel solver state (typed arrays: no per-frame allocation) -------
  /** Tire deflection state (longitudinal / lateral), dimensionless slip. */
  private ux = new Float64Array(4);
  private uy = new Float64Array(4);
  private spin = new Float64Array(4);
  private spin0 = new Float64Array(4);
  private load = new Float64Array(4);
  private loadFiltered = new Float64Array(4);
  private mu = new Float64Array(4);
  private grounded = new Uint8Array(4);
  /** Patch velocity at frame start in the tire frame (forward, right),
   * split into the whole-car CoM velocity (vc) and the rotational rest (v0). */
  private vcx = new Float64Array(4);
  private vcy = new Float64Array(4);
  private v0x = new Float64Array(4);
  private v0y = new Float64Array(4);
  private yawRate0 = 0;
  /** Yaw-rate influence on the patch velocity / lever arm about the yaw axis. */
  private kf = new Float64Array(4);
  private kl = new Float64Array(4);
  /** Tire frame (forward f, right l), contact point p, axle a — world. */
  private fwdX = new Float64Array(4);
  private fwdY = new Float64Array(4);
  private fwdZ = new Float64Array(4);
  private latX = new Float64Array(4);
  private latY = new Float64Array(4);
  private latZ = new Float64Array(4);
  private hitX = new Float64Array(4);
  private hitY = new Float64Array(4);
  private hitZ = new Float64Array(4);
  private axX = new Float64Array(4);
  private axY = new Float64Array(4);
  private axZ = new Float64Array(4);
  private forceX = new Float64Array(4);
  private forceY = new Float64Array(4);
  private impulseX = new Float64Array(4);
  private impulseY = new Float64Array(4);
  private brakeTorque = new Float64Array(4);
  private slipNow = new Float64Array(4);

  // --- scratch --------------------------------------------------------------
  private lin = new Vector3();
  private ang = new Vector3();
  private wLin = new Vector3();
  private wAng = new Vector3();
  private rayFrom = new Vector3();
  private rayTo = new Vector3();
  private rayResult = new PhysicsRaycastResult();
  private rayQuery = { membership: ~0, collideWith: ~CAR_FILTER_BIT };
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpQ = new Quaternion();
  /** Pose of the previous frame (sprung CoM, orientation, suspension) and the
   * step that led from it to now; historyDt = 0 = no valid history. */
  private prevCom = new Vector3();
  private prevQuat = new Quaternion();
  private prevCompression = new Float64Array(4);
  private historyDt = 0;

  constructor(scene: Scene, input: InputProvider, rig: VehicleRig, tuning?: HybridTuning) {
    this.input = input;
    this.rig = rig;
    this.engine = scene.getPhysicsEngine() as PhysicsEngineV2;
    this.gravity = this.engine?.gravity.length() ?? rig.gravity;
    this.tuning = { ...(tuning ?? hybridTuningForRig(rig)) };
    const t = this.tuning;

    // --- mass model -------------------------------------------------------
    const [, hullY, hullZ] = rig.hull.center;
    this.restHeight = hullY;
    let unsprung = 0;
    let comY = rig.sprungMass * rig.com[1];
    let comZ = rig.sprungMass * rig.com[2];
    for (const w of rig.wheels) {
      unsprung += w.mass;
      comY += w.mass * w.y;
      comZ += w.mass * w.z;
    }
    this.totalMass = rig.sprungMass + unsprung;
    comY /= this.totalMass;
    comZ /= this.totalMass;
    this.totalComZ = comZ;
    this.totalComLocal.set(0, comY - hullY, comZ - hullZ);

    // --- chassis: hull box + roll-cage box, one body ----------------------
    const [hullW, hullH, hullL] = rig.hull.size;
    const chassis = MeshBuilder.CreateBox('hybridChassis', { width: hullW, height: hullH, depth: hullL }, scene);
    chassis.position.set(0, hullY + 0.02, 0);
    chassis.rotationQuaternion = Quaternion.Identity();
    chassis.isVisible = false;
    this.chassisMesh = chassis;

    const container = new PhysicsShapeContainer(scene);
    const hull = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(hullW, hullH, hullL), scene);
    const [cageW, cageH, cageL] = rig.cage.size;
    const cage = new PhysicsShapeBox(
      new Vector3(rig.cage.center[0], rig.cage.center[1] - hullY, rig.cage.center[2] - hullZ),
      Quaternion.Identity(),
      new Vector3(cageW, cageH, cageL),
      scene,
    );
    for (const part of [hull, cage]) {
      part.material = { friction: t.bodyFriction, restitution: 0 };
      part.filterMembershipMask = CAR_FILTER_BIT;
      container.addChild(part);
      this.chassisParts.push(part);
    }
    container.filterMembershipMask = CAR_FILTER_BIT;
    this.chassisShape = container;
    const body = new PhysicsBody(chassis, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = container;
    this.chassisBody = body;
    this.applyCenterOfMass();
    // No engine-side damping: drag and every assist is explicit in update().
    body.setLinearDamping(0);
    body.setAngularDamping(0);

    // The car never sleeps: its tire forces are impulses applied from here
    // every frame, and a sleeping Havok body ignores what is done to it
    // (CLAUDE.md gotcha). Five bodies; the cost is nil.
    const plugin = this.engine?.getPhysicsPlugin() as HavokPlugin | undefined;
    plugin?.setActivationControl?.(body, PhysicsActivationControl.ALWAYS_ACTIVE);

    // --- wheels -----------------------------------------------------------
    for (const w of rig.wheels) {
      const axle = w.axle === 'front' ? rig.front : rig.rear;
      const sag = (axle.sprungCornerMass * this.gravity) / axle.springRate + SPRING_SLOP;
      const pivot = new Vector3(w.x, w.y - hullY - sag, w.z - hullZ);

      const mesh = MeshBuilder.CreateCylinder(
        `hybridWheel${w.index}`,
        { diameter: w.radius * 2, height: w.width, tessellation: 16 },
        scene,
      );
      // Built along Y; bake a 90° roll so the local X axis is the axle.
      mesh.rotation.z = Math.PI / 2;
      mesh.bakeCurrentTransformIntoVertices();
      mesh.rotationQuaternion = Quaternion.Identity();
      mesh.isVisible = false;
      mesh.position.set(w.x, chassis.position.y + pivot.y + sag, w.z);

      // One full-width cylinder — the same collider the legacy model uses.
      // (A crowned stack of thin cylinders was tried to give the tread a
      // single contact point: it removed a 3 % left/right load bias that
      // Havok's line contact produces, but the thin centre band caught the
      // facet edges of meshes and of the terrain heightfield — washboard
      // speed loss 33 % -> 61 %, attacking hill lap 12.3 s -> 16.9 s.)
      const shape = new PhysicsShapeCylinder(
        new Vector3(-w.width / 2, 0, 0),
        new Vector3(w.width / 2, 0, 0),
        w.radius,
        scene,
      );
      shape.filterMembershipMask = CAR_FILTER_BIT;
      const aggregate = new PhysicsAggregate(mesh, shape, { mass: w.mass, friction: 0, restitution: 0 }, scene);
      // Frictionless: grip is computed in solveTires(), never by Havok.
      // (Set after the aggregate, which assigns its own material.)
      shape.material = { friction: 0, restitution: 0, frictionCombine: PhysicsMaterialCombineMode.MINIMUM };
      const transverse = (3 * w.radius * w.radius + w.width * w.width) / 12;
      aggregate.body.setMassProperties({
        mass: w.mass,
        centerOfMass: Vector3.Zero(),
        // Per unit mass (Havok convention): axle, then the two diameters.
        inertia: new Vector3(axle.wheelSpinInertia / w.mass, transverse, transverse),
        inertiaOrientation: Quaternion.Identity(),
      });
      aggregate.body.setLinearDamping(0);
      aggregate.body.setAngularDamping(0);

      const constraint = new Physics6DoFConstraint(
        {
          pivotA: pivot.clone(),
          pivotB: new Vector3(0, 0, 0),
          axisA: new Vector3(1, 0, 0),
          axisB: new Vector3(1, 0, 0),
          perpAxisA: new Vector3(0, 1, 0),
          perpAxisB: new Vector3(0, 1, 0),
          collision: false,
        },
        [
          { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
          { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
          // Suspension: soft limit = damped spring. The range must be
          // hair-width but NOT zero (CLAUDE.md gotcha: 0/0 hard-locks).
          {
            axis: PhysicsConstraintAxis.LINEAR_Y,
            minLimit: -SPRING_SLOP,
            maxLimit: SPRING_SLOP,
            stiffness: axle.springRate,
            damping: axle.damperRate,
          },
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: 0, maxLimit: 0 },
          // Steering: kinematic hold, limits re-pinned every frame.
          w.steered
            ? { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -0.001, maxLimit: 0.001 }
            : { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: 0, maxLimit: 0 },
        ],
        scene,
      );
      body.addConstraint(aggregate.body, constraint);

      this.wheelAggregates.push(aggregate);
      this.wheelMeshes.push(mesh);
      this.wheels.push({
        mesh,
        body: aggregate.body,
        shape,
        constraint,
        steered: w.steered,
        driven: w.driven,
        front: w.axle === 'front',
        localX: w.x,
        radius: w.radius,
        mass: w.mass,
        inertia: axle.wheelSpinInertia,
        pivot,
        sag,
        springRate: axle.springRate,
        damperRate: axle.damperRate,
        staticLoad: (axle.sprungCornerMass + w.mass) * this.gravity,
      });
      plugin?.setActivationControl?.(aggregate.body, PhysicsActivationControl.ALWAYS_ACTIVE);
      this.wheelStates.push({
        position: mesh.position.clone(),
        velocity: new Vector3(),
        rollSpeed: 0,
        slipSpeed: 0,
        grounded: false,
        steerAngle: 0,
        spinSpeed: 0,
        radius: w.radius,
      });
    }
    this.visual = new VehicleVisual(
      scene, this.chassisMesh,
      { x: -rig.hull.center[0], y: -rig.hull.center[1], z: -rig.hull.center[2] },
      rig.wheels,
    );
  }

  // --- Vehicle interface: read-outs -----------------------------------------

  get forwardSpeed(): number {
    return this._forwardSpeed;
  }
  get drivenRimSpeed(): number {
    return this._drivenRimSpeed;
  }
  get isReversing(): boolean {
    return this._reversing;
  }
  get currentSteerAngle(): number {
    return this.steerAngle + this.assistAngle;
  }
  get maxSteerAngle(): number {
    return this.steerLimit > 0 ? this.steerLimit : this.fullLock;
  }
  /** Bicycle steer angle at full lock, from the turning-radius knob. */
  private get fullLock(): number {
    return Math.atan(this.rig.wheelbase / Math.max(this.tuning.minTurnRadius, this.rig.front.track / 2 + 0.1));
  }
  get wheelbase(): number {
    return this.rig.wheelbase;
  }
  get topSpeed(): number {
    return this.tuning.topSpeed;
  }
  get nominalGrip(): number {
    return this.tuning.grip;
  }

  getTuning(key: string): number | undefined {
    const value = (this.tuning as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  }

  setTuning(key: string, value: number): boolean {
    if (this.getTuning(key) === undefined || !Number.isFinite(value)) return false;
    (this.tuning as unknown as Record<string, number>)[key] = value;
    if (key === 'comHeight' || key === 'comForward' || key === 'yawInertiaScale') this.applyCenterOfMass();
    if (key === 'bodyFriction') {
      for (const part of this.chassisParts) part.material = { friction: value, restitution: 0 };
    }
    return true;
  }

  /** Chassis inertia (Havok: per unit mass) and whole-car yaw inertia from
   * the rig, with the yaw axis scaled by tuning.yawInertiaScale. */
  private computeInertia(): void {
    const rig = this.rig;
    const scale = Math.max(0.2, this.tuning.yawInertiaScale);
    const sprungYaw = rig.inertia[1] * scale;
    this.inertiaPerMass.set(rig.inertia[0] / rig.sprungMass, sprungYaw / rig.sprungMass, rig.inertia[2] / rig.sprungMass);
    let yawInertia = sprungYaw + rig.sprungMass * (rig.com[2] - this.totalComZ) ** 2;
    for (const w of rig.wheels) yawInertia += w.mass * (w.x * w.x + (w.z - this.totalComZ) ** 2);
    this.totalYawInertia = yawInertia;
  }

  /** Push tuning.comHeight / comForward (and the rig's mass + inertia) into Havok. */
  private applyCenterOfMass(): void {
    const rig = this.rig;
    this.comLocal.set(0, this.tuning.comHeight - rig.hull.center[1], this.tuning.comForward - rig.hull.center[2]);
    this.computeInertia();
    this.chassisBody.setMassProperties({
      mass: rig.sprungMass,
      centerOfMass: this.comLocal.clone(),
      inertia: this.inertiaPerMass.clone(),
      inertiaOrientation: Quaternion.Identity(),
    });
  }

  // --- the frame ------------------------------------------------------------

  update(dt: number): void {
    if (!(dt > 0)) return;
    const t = this.tuning;
    const rig = this.rig;
    const intent = this.input.poll();
    const throttle = pedal(intent.throttle);
    const brake = pedal(intent.brake);
    const stick = intent.steering >= -1 ? (intent.steering <= 1 ? intent.steering : 1) : intent.steering < -1 ? -1 : 0;

    // reset() teleports through Havok's pre-step transform copy; switch it
    // back off once the step after the reset has consumed it.
    if (this.preStepFrames > 0 && --this.preStepFrames === 0) {
      this.chassisBody.disablePreStep = true;
      for (const wheel of this.wheels) wheel.body.disablePreStep = true;
    }

    // --- chassis pose and motion (straight from the body transform: no
    // dependence on Babylon's world-matrix cache) --------------------------
    const pos = this.chassisMesh.position;
    const q = this.chassisMesh.rotationQuaternion!;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const rX = 1 - 2 * (qy * qy + qz * qz), rY = 2 * (qx * qy + qz * qw), rZ = 2 * (qx * qz - qy * qw);
    const uX = 2 * (qx * qy - qz * qw), uY = 1 - 2 * (qx * qx + qz * qz), uZ = 2 * (qy * qz + qx * qw);
    const fX = 2 * (qx * qz + qy * qw), fY = 2 * (qy * qz - qx * qw), fZ = 1 - 2 * (qx * qx + qy * qy);

    this.chassisBody.getLinearVelocityToRef(this.lin);
    this.chassisBody.getAngularVelocityToRef(this.ang);
    let vX = this.lin.x, vY = this.lin.y, vZ = this.lin.z;
    let wX = this.ang.x, wY = this.ang.y, wZ = this.ang.z;
    if (!Number.isFinite(vX + vY + vZ + wX + wY + wZ + qx + qy + qz + qw)) return;

    // Sprung CoM (where Havok's linear velocity lives) and whole-car CoM.
    const cl = this.comLocal;
    const comX = pos.x + rX * cl.x + uX * cl.y + fX * cl.z;
    const comY = pos.y + rY * cl.x + uY * cl.y + fY * cl.z;
    const comZ = pos.z + rZ * cl.x + uZ * cl.y + fZ * cl.z;

    // Velocity from the POSE HISTORY, not from the velocity Havok stores on
    // the body. Measured in the lab: with the suspension springs loaded
    // unevenly the stored velocity does not match how the body actually
    // moves — braked on a 15° slope it read 0.017 m/s forward plus a steady
    // 0.035 rad/s pitch rate while the pose crept UPHILL at 0.063 m/s with a
    // constant pitch angle; at full throttle it shows 0.12 rad/s of pitch
    // rate that never turns into pitch. Tires that trusted it saw a parked
    // car as rolling (0.24 m of creep in 5 s; 0.04 m from the pose).
    const hadHistory = this.historyDt > 0;
    const prevDt = this.historyDt;
    if (hadHistory && t.poseVelocity > 0) {
      const inv = 1 / this.historyDt;
      const pvx = (comX - this.prevCom.x) * inv;
      const pvy = (comY - this.prevCom.y) * inv;
      const pvz = (comZ - this.prevCom.z) * inv;
      // dq = q ⊗ conj(q_prev);  ω ≈ 2·dq.xyz / dt
      const p = this.prevQuat;
      let dW = qw * p.w + qx * p.x + qy * p.y + qz * p.z;
      let dX = p.w * qx - qw * p.x - (qy * p.z - qz * p.y);
      let dY = p.w * qy - qw * p.y - (qz * p.x - qx * p.z);
      let dZ = p.w * qz - qw * p.z - (qx * p.y - qy * p.x);
      if (dW < 0) { dW = -dW; dX = -dX; dY = -dY; dZ = -dZ; }
      // A pose that jumped (someone teleported the body without reset())
      // is not a velocity: keep Havok's numbers for that frame.
      const jump = Math.abs(pvx - vX) + Math.abs(pvy - vY) + Math.abs(pvz - vZ);
      if (jump < 12 && dW > 0.9) {
        vX = pvx; vY = pvy; vZ = pvz;
        wX = 2 * dX * inv;
        wY = 2 * dY * inv;
        wZ = 2 * dZ * inv;
      }
    }
    this.prevCom.set(comX, comY, comZ);
    this.prevQuat.copyFrom(q);
    this.historyDt = dt;
    const tl = this.totalComLocal;
    const tcX = pos.x + rX * tl.x + uX * tl.y + fX * tl.z;
    const tcY = pos.y + rY * tl.x + uY * tl.y + fY * tl.z;
    const tcZ = pos.z + rZ * tl.x + uZ * tl.y + fZ * tl.z;

    const forwardSpeed = vX * fX + vY * fY + vZ * fZ;
    this._forwardSpeed = forwardSpeed;
    // Velocity of the whole-car CoM (rigid motion of the chassis) and yaw rate.
    const tdx = tcX - comX, tdy = tcY - comY, tdz = tcZ - comZ;
    const tvX = vX + wY * tdz - wZ * tdy;
    const tvY = vY + wZ * tdx - wX * tdz;
    const tvZ = vZ + wX * tdy - wY * tdx;
    this.yawRate0 = wX * uX + wY * uY + wZ * uZ;

    // --- steering: rate-limited bicycle angle, Ackermann per wheel ----------
    const maxSteer = this.fullLock;
    let steerLimit = maxSteer;
    if (t.steerSpeedFalloff > 0) steerLimit = maxSteer / (1 + Math.abs(forwardSpeed) * t.steerSpeedFalloff);
    this.steerLimit = steerLimit;
    const steerStep = t.steerResponse * dt;
    this.steerAngle += clamp(stick * steerLimit - this.steerAngle, -steerStep, steerStep);
    const L = rig.wheelbase;

    // ASSIST (non-physical, bounded by `slideAssistMaxDeg`, `slideAssist` = 0
    // switches it off): countersteer for the player. A real car's caster
    // turns the front wheels into a slide as soon as the driver loosens his
    // grip; a thumbstick has no such feedback. So the front wheels are
    // steered toward the direction the REAR axle is sliding in, by a share of
    // the rear slip angle beyond `slideAssistStartDeg` (below that — any
    // normal cornering — it does nothing at all).
    let assistAngle = 0;
    const planarForward = Math.abs(forwardSpeed);
    if (t.slideAssist > 0 && forwardSpeed > 3) {
      // Lateral velocity of the chassis at the rear axle: v + ω × (p − com).
      const rz = rig.rear.z - rig.hull.center[2] - cl.z;
      const ox = fX * rz - (uX * cl.y), oy = fY * rz - (uY * cl.y), oz = fZ * rz - (uZ * cl.y);
      const rvX = vX + wY * oz - wZ * oy;
      const rvY = vY + wZ * ox - wX * oz;
      const rvZ = vZ + wX * oy - wY * ox;
      const lateral = rvX * rX + rvY * rY + rvZ * rZ;
      const slip = Math.atan2(lateral, planarForward);
      const start = (t.slideAssistStartDeg * Math.PI) / 180;
      const excess = Math.abs(slip) - start;
      if (excess > 0) {
        const cap = (t.slideAssistMaxDeg * Math.PI) / 180;
        // Fades in over the first 3 m/s so it cannot twitch at parking speed.
        const fade = clamp((forwardSpeed - 3) / 3, 0, 1);
        assistAngle = Math.sign(slip) * Math.min(cap, t.slideAssist * excess) * fade;
      }
    }
    this.assistAngle += clamp(assistAngle - this.assistAngle, -steerStep, steerStep);
    const tanSteer = Math.tan(this.steerAngle + this.assistAngle);

    // --- pedals: brake / reverse latch -------------------------------------
    // A brake press that began while rolling forward stays a BRAKE until it
    // is released (so it holds the car on a slope); a press that begins at
    // (near) standstill is REVERSE. `reverseHoldDelay` > 0 restores the
    // classic "keep holding and it backs up" after that many seconds.
    if (throttle > 0.01 || forwardSpeed > t.reverseEngageSpeed) this.reverseIntent = false;
    if (brake <= 0.01) {
      this.brakeMode = BRAKE_NONE;
      this.brakeHoldTime = 0;
    } else if (this.brakeMode === BRAKE_NONE) {
      // MOVING in any direction (forward, sideways in a slide, rolling
      // backward after a spin or down a hill) = brake. Only a press at (near)
      // standstill, or while backing up on purpose, is reverse.
      const planarSpeed = Math.hypot(vX, vZ);
      const still = planarSpeed < 2 * t.reverseEngageSpeed && Math.abs(forwardSpeed) <= t.reverseEngageSpeed;
      const reverse = still || (this.reverseIntent && forwardSpeed <= t.reverseEngageSpeed);
      this.brakeMode = reverse ? BRAKE_REVERSE : BRAKE_BRAKING;
      this.brakeHoldTime = 0;
    } else if (this.brakeMode === BRAKE_BRAKING && t.reverseHoldDelay > 0 && Math.abs(forwardSpeed) < t.reverseEngageSpeed) {
      this.brakeHoldTime += dt;
      if (this.brakeHoldTime >= t.reverseHoldDelay) this.brakeMode = BRAKE_REVERSE;
    } else if (this.brakeMode === BRAKE_REVERSE && forwardSpeed > 2 * t.reverseEngageSpeed + 1) {
      // Rolling forward fast again (pushed, downhill): it is a brake.
      this.brakeMode = BRAKE_BRAKING;
    }
    if (this.brakeMode === BRAKE_REVERSE) this.reverseIntent = true;
    const reversing = this.brakeMode === BRAKE_REVERSE && throttle <= 0.01;
    const braking = brake > 0.01 && !reversing;
    this._reversing = reversing;
    /** Signed drive demand, −1..1. */
    const drive = reversing ? -brake : braking ? 0 : throttle;
    const brakeDemand = braking ? brake : 0;

    // --- sense every wheel --------------------------------------------------
    const weight = this.totalMass * this.gravity;
    let groundedCount = 0;
    let rimSum = 0;
    let drivenCount = 0;
    const slideGripF = t.slideGrip * t.frontSlideScale;
    const loadBlend = t.loadFilterTime > 0 ? 1 - Math.exp(-dt / t.loadFilterTime) : 1;
    for (let i = 0; i < 4; i++) {
      const wheel = this.wheels[i];
      const state = this.wheelStates[i];
      const wp = wheel.mesh.position;
      const wq = wheel.mesh.rotationQuaternion!;
      // Axle = wheel-local X in world space (spin about X cannot smear it).
      let aX = 1 - 2 * (wq.y * wq.y + wq.z * wq.z);
      let aY = 2 * (wq.x * wq.y + wq.z * wq.w);
      let aZ = 2 * (wq.x * wq.z - wq.y * wq.w);
      if (!Number.isFinite(aX + aY + aZ)) {
        aX = rX; aY = rY; aZ = rZ;
      }
      this.axX[i] = aX; this.axY[i] = aY; this.axZ[i] = aZ;
      // Rolling direction of the TIRE: from the steer angle commanded for
      // this step (Ackermann: both fronts aim at the common turn centre
      // R = L / tan(delta) to the side of the rear axle), not from where the
      // hub was at the end of the last one — the constraint needs a step to
      // get there, and that step is latency between the stick and the force.
      let cX = rX, cY = rY, cZ = rZ;
      if (wheel.steered) {
        const angle = Math.atan((L * tanSteer) / (L - wheel.localX * tanSteer));
        wheel.constraint.setAxisMinLimit(PhysicsConstraintAxis.ANGULAR_Y, angle);
        wheel.constraint.setAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_Y, angle);
        const ca = Math.cos(angle), sa = Math.sin(angle);
        cX = rX * ca - fX * sa; cY = rY * ca - fY * sa; cZ = rZ * ca - fZ * sa;
      }
      wheel.body.getLinearVelocityToRef(this.wLin);
      wheel.body.getAngularVelocityToRef(this.wAng);
      state.position.copyFrom(wp);
      state.velocity.copyFrom(this.wLin);
      // Spin relative to the chassis, about the axle.
      const spin = (this.wAng.x - wX) * aX + (this.wAng.y - wY) * aY + (this.wAng.z - wZ) * aZ;
      this.spin[i] = Number.isFinite(spin) ? spin : 0;
      this.spin0[i] = this.spin[i];
      state.spinSpeed = this.spin[i];
      if (wheel.steered) {
        state.steerAngle = Math.atan2(-(aX * fX + aY * fY + aZ * fZ), aX * rX + aY * rY + aZ * rZ);
      }
      if (wheel.driven) {
        rimSum += this.spin[i] * wheel.radius;
        drivenCount++;
      }

      // Suspension deflection and its rate → spring + damper force → load.
      const pv = wheel.pivot;
      const pX = pos.x + rX * pv.x + uX * pv.y + fX * pv.z;
      const pY = pos.y + rY * pv.x + uY * pv.y + fY * pv.z;
      const pZ = pos.z + rZ * pv.x + uZ * pv.y + fZ * pv.z;
      const compression = (wp.x - pX) * uX + (wp.y - pY) * uY + (wp.z - pZ) * uZ;
      // Chassis point velocity at the pivot: v + ω × (p − com).
      const ox = pX - comX, oy = pY - comY, oz = pZ - comZ;
      const cvX = vX + wY * oz - wZ * oy;
      const cvY = vY + wZ * ox - wX * oz;
      const cvZ = vZ + wX * oy - wY * ox;
      let rate = (this.wLin.x - cvX) * uX + (this.wLin.y - cvY) * uY + (this.wLin.z - cvZ) * uZ;
      if (hadHistory && t.poseVelocity > 0) rate = (compression - this.prevCompression[i]) / prevDt;
      this.prevCompression[i] = compression;
      let spring = 0;
      if (compression > SPRING_SLOP) spring = wheel.springRate * (compression - SPRING_SLOP);
      else if (compression < -SPRING_SLOP) spring = wheel.springRate * (compression + SPRING_SLOP);

      // Ground under the wheel: one ray along the chassis' down direction.
      const reach = wheel.radius + t.groundTolerance;
      this.rayFrom.set(wp.x, wp.y, wp.z);
      this.rayTo.set(wp.x - uX * reach, wp.y - uY * reach, wp.z - uZ * reach);
      this.engine.raycastToRef(this.rayFrom, this.rayTo, this.rayResult, this.rayQuery);
      let grounded = false;
      this.load[i] = 0;
      if (this.rayResult.hasHit) {
        const hp = this.rayResult.hitPointWorld;
        const hn = this.rayResult.hitNormalWorld;
        let nX = hn.x, nY = hn.y, nZ = hn.z;
        const nLen = Math.hypot(nX, nY, nZ);
        if (nLen > 1e-6) {
          nX /= nLen; nY /= nLen; nZ /= nLen;
          // Tire frame on the ground plane: forward = axle × normal.
          let tfX = cY * nZ - cZ * nY;
          let tfY = cZ * nX - cX * nZ;
          let tfZ = cX * nY - cY * nX;
          const tfLen = Math.hypot(tfX, tfY, tfZ);
          const facing = nX * uX + nY * uY + nZ * uZ;
          let load = spring + wheel.damperRate * rate + wheel.mass * this.gravity * Math.max(0, nY);
          if (tfLen > 0.3 && facing > 0.3 && load > 0 && Number.isFinite(load)) {
            tfX /= tfLen; tfY /= tfLen; tfZ /= tfLen;
            grounded = true;
            groundedCount++;
            load = Math.min(load, t.maxLoadFactor * wheel.staticLoad);
            // Low-pass (the damper term is a difference of two noisy numbers;
            // unfiltered it makes left and right thrust flicker at the limit).
            const prev = this.loadFiltered[i];
            this.loadFiltered[i] = prev > 0 ? prev + (load - prev) * loadBlend : load;
            this.load[i] = this.loadFiltered[i];
            this.fwdX[i] = tfX; this.fwdY[i] = tfY; this.fwdZ[i] = tfZ;
            // right = normal × forward
            const tlX = nY * tfZ - nZ * tfY;
            const tlY = nZ * tfX - nX * tfZ;
            const tlZ = nX * tfY - nY * tfX;
            this.latX[i] = tlX; this.latY[i] = tlY; this.latZ[i] = tlZ;
            this.hitX[i] = hp.x; this.hitY[i] = hp.y; this.hitZ[i] = hp.z;
            // Patch velocity from the chassis' rigid motion at the contact.
            const dx = hp.x - comX, dy = hp.y - comY, dz = hp.z - comZ;
            const pvX = vX + wY * dz - wZ * dy;
            const pvY = vY + wZ * dx - wX * dz;
            const pvZ = vZ + wX * dy - wY * dx;
            // Split: velocity of the whole-car CoM (turns relative to the
            // tire frame as the car yaws) + the rotational remainder.
            this.vcx[i] = tvX * tfX + tvY * tfY + tvZ * tfZ;
            this.vcy[i] = tvX * tlX + tvY * tlY + tvZ * tlZ;
            this.v0x[i] = pvX * tfX + pvY * tfY + pvZ * tfZ - this.vcx[i];
            this.v0y[i] = pvX * tlX + pvY * tlY + pvZ * tlZ - this.vcy[i];
            // Yaw (about chassis up, through the whole-car CoM) influence:
            // (up × r)·f and (up × r)·l.
            const ax = hp.x - tcX, ay = hp.y - tcY, az = hp.z - tcZ;
            const yX = uY * az - uZ * ay;
            const yY = uZ * ax - uX * az;
            const yZ = uX * ay - uY * ax;
            this.kf[i] = yX * tfX + yY * tfY + yZ * tfZ;
            this.kl[i] = yX * tlX + yY * tlY + yZ * tlZ;
            // Grip of this tire right now: axle scale and load sensitivity.
            const ratio = this.load[i] / wheel.staticLoad;
            const sens = clamp(1 - t.loadSensitivity * (ratio - 1), 0.6, 1.2);
            this.mu[i] = t.grip * (wheel.front ? t.frontGrip : t.rearGrip) * sens;
          }
        }
      }
      this.grounded[i] = grounded ? 1 : 0;
      state.grounded = grounded;
      if (!grounded) {
        this.ux[i] = 0;
        this.uy[i] = 0;
        this.loadFiltered[i] = 0;
      }

      // Brake torque demand of this wheel (ABS acts inside the sub-steps).
      const share = wheel.front ? t.brakeBias : 1 - t.brakeBias;
      this.brakeTorque[i] = brakeDemand * t.brakeG * weight * share * 0.5 * wheel.radius;
    }
    this._drivenRimSpeed = drivenCount > 0 ? rimSum / drivenCount : 0;
    this.airTime = groundedCount === 0 ? this.airTime + dt : 0;

    // --- tires ---------------------------------------------------------------
    // Gravity component in the chassis plane: the tire solver must know the
    // car is being pulled downhill, or a parked car creeps half a frame of
    // gravity per frame.
    const gUp = -this.gravity * uY;
    const gpX = -gUp * uX;
    const gpY = -this.gravity - gUp * uY;
    const gpZ = -gUp * uZ;
    this.solveTires(dt, drive, drivenCount, slideGripF, groundedCount > 0 ? gpX : 0, groundedCount > 0 ? gpY : 0, groundedCount > 0 ? gpZ : 0);

    // --- hand the summed impulses to Havok ---------------------------------
    let linX = 0, linY = 0, linZ = 0;
    let angX = 0, angY = 0, angZ = 0;
    for (let i = 0; i < 4; i++) {
      const wheel = this.wheels[i];
      const state = this.wheelStates[i];
      if (this.grounded[i]) {
        const jX = this.impulseX[i] * this.fwdX[i] + this.impulseY[i] * this.latX[i];
        const jY = this.impulseX[i] * this.fwdY[i] + this.impulseY[i] * this.latY[i];
        const jZ = this.impulseX[i] * this.fwdZ[i] + this.impulseY[i] * this.latZ[i];
        // Contact point, optionally lifted toward the CoM height (roll assist).
        const lift = t.rollAssist > 0 ? t.rollAssist * ((comX - this.hitX[i]) * uX + (comY - this.hitY[i]) * uY + (comZ - this.hitZ[i]) * uZ) : 0;
        const dx = this.hitX[i] + uX * lift - comX;
        const dy = this.hitY[i] + uY * lift - comY;
        const dz = this.hitZ[i] + uZ * lift - comZ;
        linX += jX; linY += jY; linZ += jZ;
        angX += dy * jZ - dz * jY;
        angY += dz * jX - dx * jZ;
        angZ += dx * jY - dy * jX;
        state.rollSpeed = Math.abs(this.vcx[i] + this.v0x[i]);
        state.slipSpeed = this.slipNow[i];
      } else {
        state.rollSpeed = 0;
        state.slipSpeed = 0;
      }
      // Spin change → wheel body about its axle, reaction on the chassis.
      const dSpin = this.spin[i] - this.spin0[i];
      if (dSpin !== 0) {
        const a = wheel.inertia * dSpin;
        this.tmpA.set(this.axX[i] * a, this.axY[i] * a, this.axZ[i] * a);
        wheel.body.applyAngularImpulse(this.tmpA);
        const r = -a * t.torqueReaction;
        angX += this.axX[i] * r; angY += this.axY[i] * r; angZ += this.axZ[i] * r;
      }
    }

    // Aerodynamic drag (quadratic, at the CoM).
    const speed = Math.hypot(vX, vY, vZ);
    if (t.aeroDrag > 0 && speed > 0.1) {
      const k = -Math.min(t.aeroDrag * speed * dt, 0.5 * rig.sprungMass);
      linX += vX * k; linY += vY * k; linZ += vZ * k;
    }

    // ASSIST (non-physical, bounded, `airStability` = 0 switches it off):
    // while no wheel touches the ground, pitch and roll rates decay as if
    // the car had a gyro — keeps ramp take-off rotation from growing into a
    // nose dive during the flight.
    if (t.airStability > 0 && groundedCount === 0 && this.airTime > t.airStabilityDelay) {
      const k = Math.min(1, t.airStability * dt) * rig.sprungMass;
      const pitchRate = wX * rX + wY * rY + wZ * rZ;
      const rollRate = wX * fX + wY * fY + wZ * fZ;
      const ip = -k * this.inertiaPerMass.x * pitchRate;
      const ir = -k * this.inertiaPerMass.z * rollRate;
      angX += rX * ip + fX * ir;
      angY += rY * ip + fY * ir;
      angZ += rZ * ip + fZ * ir;
    }

    // Dev hook: set `window.__hybridLog = []` before the car is built and
    // every frame appends one row — [forward speed, lateral speed, yaw rate,
    // steer angle, throttle, brake, 4 wheel loads N, 4 longitudinal and
    // 4 lateral tire forces N, 4 wheel spins rad/s, wheels on the ground].
    const log = (globalThis as { __hybridLog?: number[][] }).__hybridLog;
    if (log && log.length < 60000) {
      log.push([
        forwardSpeed, vX * rX + vY * rY + vZ * rZ, this.yawRate0, this.steerAngle + this.assistAngle, throttle, brake,
        this.load[0], this.load[1], this.load[2], this.load[3],
        this.impulseX[0] / dt, this.impulseX[1] / dt, this.impulseX[2] / dt, this.impulseX[3] / dt,
        this.impulseY[0] / dt, this.impulseY[1] / dt, this.impulseY[2] / dt, this.impulseY[3] / dt,
        this.spin[0], this.spin[1], this.spin[2], this.spin[3], groundedCount,
      ]);
    }

    // In the frame after reset() Havok still holds the body at its OLD pose
    // (the teleport is copied in by the next pre-step): an impulse applied at
    // a world point of the new pose would get the teleport distance as its
    // lever arm (measured: 919 deg/s of yaw from an 80 m respawn with the
    // throttle held). Nothing is applied until the pose has arrived.
    const posed = this.preStepFrames === 0;
    if (posed && (linX !== 0 || linY !== 0 || linZ !== 0)) {
      this.tmpA.set(linX, linY, linZ);
      this.tmpB.set(comX, comY, comZ);
      this.chassisBody.applyImpulse(this.tmpA, this.tmpB);
    }
    if (posed && (angX !== 0 || angY !== 0 || angZ !== 0)) {
      this.tmpA.set(angX, angY, angZ);
      this.chassisBody.applyAngularImpulse(this.tmpA);
    }
    this.visual.capture(this.wheelStates, dt, intent, this.currentSteerAngle, this.isReversing);
  }

  /**
   * The tire model, integrated in fixed sub-steps against a planar
   * prediction of the car's answer.
   *
   * Per wheel, per sub-step:
   *   slip velocity      s = (rim − vx, −vy)          [m/s, tire frame]
   *   deflection state   u' = (s − vt·u) / relaxation  (vt = transport speed)
   *                      — at speed u → (slip ratio, tan slip angle); at rest
   *                      it is a spring, so a parked car does not creep
   *   normalised slip    q = (u + damping·u') / (peakSlipRatio, tan peakSlipAngle)
   *   force              F = mu·N · rise(|q|) · fall(lambda) along q
   *     rise(x) = x(3 − x²)/2 up to 1 at x = 1 (the peak), 1 beyond;
   *     fall = 1 until the tire slides outright — right after the peak slip
   *     ratio lengthwise, but sideways only past `plateauWidth` × the peak
   *     slip angle — then eases down to `slideGrip`. Sliding outright, the
   *     force turns to oppose the slip velocity.
   * Friction circle: |F| never exceeds mu·N whatever the mix of drive, brake
   * and cornering, so wheelspin costs side grip and vice versa.
   *
   * Wheel spin is integrated here too (drive torque with rev limiter and
   * power knee, tire reaction semi-implicitly, brakes / engine braking /
   * rolling resistance as resistances that can stop a wheel but not reverse
   * it, the differential coupling), and the result is written back to the
   * wheel bodies as an angular impulse.
   */
  private solveTires(
    dt: number, drive: number, drivenCount: number, slideGripF: number,
    gpX: number, gpY: number, gpZ: number,
  ): void {
    const t = this.tuning;
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-9));
    const h = dt / steps;
    const invM = 1 / this.totalMass;
    const invIz = 1 / this.totalYawInertia;
    const kp = Math.max(0.02, t.peakSlipRatio);
    const apFront = Math.max(0.02, Math.tan((t.peakSlipAngleDeg * Math.PI) / 180));
    const apRear = Math.max(0.02, Math.tan((t.peakSlipAngleDeg * t.rearSlipAngleScale * Math.PI) / 180));
    const invLx = 1 / Math.max(0.02, t.relaxationLength * t.longRelaxationScale);
    const invLy = 1 / Math.max(0.02, t.relaxationLength);
    const vLow = Math.max(0.2, t.lowSpeed);
    const plateau = Math.max(1, t.plateauWidth);
    const weight = this.totalMass * this.gravity;
    const driveTorqueMax = drivenCount > 0 ? (t.driveG * weight) / drivenCount : 0;
    const coastForce = drivenCount > 0 ? (t.engineBrakeG * weight) / drivenCount : 0;
    /** Pedal travel over which engine braking fades out. */
    const coastFade = Math.max(0.02, t.engineBrakeFade);
    const powerSpeed = t.powerSpeed > 0 ? Math.max(1, t.powerSpeed) : Infinity;
    const cap = drive >= 0 ? t.topSpeed : t.topSpeed * t.reverseSpeedFactor;
    const taperBand = Math.max(0.01, t.revTaper) * cap;
    const driveSign = drive >= 0 ? 1 : -1;
    const driveAbs = Math.abs(drive);
    const diffCoupling = Math.max(0, t.diffPreload + t.diffLock * driveAbs);
    const braking = this.brakeTorque[0] + this.brakeTorque[2] > 0;
    // Parking hold: no pedals, (nearly) stopped → brakes on.
    const parkTorqueScale = t.autoHold > 0 && driveAbs <= 0.01 && !braking && Math.abs(this._forwardSpeed) < t.autoHoldSpeed ? t.autoHold : 0;

    let dvX = 0, dvY = 0, dvZ = 0, dw = 0;
    for (let i = 0; i < 4; i++) {
      this.impulseX[i] = 0;
      this.impulseY[i] = 0;
      this.slipNow[i] = 0;
    }
    // The car turns while the frame lasts: the tire frames turn with it by
    // theta about the yaw axis. Without this a cornering force stays aimed
    // where "sideways" was at the frame's start — it then both under-reads
    // the slip angle and pumps speed into the car, more so at low frame rates.
    let theta = 0;
    const yaw0 = this.yawRate0;

    for (let step = 0; step < steps; step++) {
      const thetaMid = theta + 0.5 * (yaw0 + dw) * h;
      const cosT = Math.cos(thetaMid);
      const sinT = Math.sin(thetaMid);
      for (let i = 0; i < 4; i++) {
        const wheel = this.wheels[i];
        const r = wheel.radius;
        const ap = wheel.front ? apFront : apRear;
        let om = this.spin[i];
        let fx = 0;
        let fy = 0;
        let stiff = 0;
        let lockSlip = 0;
        if (this.grounded[i]) {
          // Car-CoM velocity (start + predicted change) in the START tire
          // frame, turned into the current one; the yaw and roll/pitch-rate
          // parts of the patch velocity turn with the car, so they keep
          // their components.
          const cx = this.vcx[i] + dvX * this.fwdX[i] + dvY * this.fwdY[i] + dvZ * this.fwdZ[i];
          const cy = this.vcy[i] + dvX * this.latX[i] + dvY * this.latY[i] + dvZ * this.latZ[i];
          const vx = cx * cosT + cy * sinT + this.v0x[i] + dw * this.kf[i];
          const vy = cy * cosT - cx * sinT + this.v0y[i] + dw * this.kl[i];
          const rim = om * r;
          const sx = rim - vx;
          const sy = -vy;
          const vt = Math.max(Math.abs(vx), Math.abs(rim));
          const vref = Math.max(vt, vLow);
          if (step === 0) this.slipNow[i] = Math.hypot(sx, sy);
          // Deflection state, implicit in the relaxation term.
          const ux0 = this.ux[i];
          const uy0 = this.uy[i];
          let ux = (ux0 + h * sx * invLx) / (1 + h * vt * invLx);
          let uy = (uy0 + h * sy * invLy) / (1 + h * vt * invLy);
          // Carcass damping: lead term on the rate of deflection.
          const qx = (ux + t.tireDamping * (ux - ux0) / h) / kp;
          const qy = (uy + t.tireDamping * (uy - uy0) / h) / ap;
          // The patch slides beyond the peak: the carcass holds no more.
          const stored = Math.hypot(ux / kp, uy / ap);
          if (stored > 1) {
            ux /= stored;
            uy /= stored;
          }
          this.ux[i] = ux;
          this.uy[i] = uy;

          const rho = Math.hypot(qx, qy);
          if (rho > 1e-9) {
            const rise = rho < 1 ? 0.5 * rho * (3 - rho * rho) : 1;
            // Instantaneous slip, in units of the peak slip.
            const lx = sx / (kp * vref);
            const ly = sy / (ap * vref);
            const lambda = Math.hypot(lx, ly);
            let fall = 1;
            let dirX = qx / rho;
            let dirY = qy / rho;
            // Grip falls toward `slideGrip` once the tire slides outright:
            // straight after the peak slip RATIO (spinning / locked), but
            // sideways only beyond the end of the progressive plateau.
            const lambdaFall = Math.hypot(lx, ly / plateau);
            if (lambdaFall > 1) {
              const slide = wheel.front ? slideGripF : t.slideGrip;
              const over = (lambdaFall - 1) / Math.max(0.05, t.slideFalloff);
              fall = slide + (1 - slide) / (1 + over * over);
            }
            if (lambda > 1) {
              // Sliding outright, friction opposes the slip VELOCITY.
              const blend = clamp((lambda - 1) * 0.5, 0, 1);
              const sLen = Math.hypot(sx, sy);
              if (sLen > 1e-6) {
                dirX += (sx / sLen - dirX) * blend;
                dirY += (sy / sLen - dirY) * blend;
                const dLen = Math.hypot(dirX, dirY);
                if (dLen > 1e-6) {
                  dirX /= dLen;
                  dirY /= dLen;
                }
              }
            }
            // Optional progressive side grip (off at gain 0): across the
            // plateau the tire gains up to `…PlateauGain` more side force.
            const side = Math.min(1, Math.abs(ly) / plateau);
            const cap = 1 + (wheel.front ? t.frontPlateauGain : t.rearPlateauGain) * 0.5 * side * (3 - side * side);
            const peak = this.mu[i] * this.load[i];
            const mag = peak * rise * fall;
            fx = mag * dirX * t.longGrip;
            fy = mag * dirY * cap;
            // d(force)/d(rim speed), for the implicit spin update.
            if (rho < 1) stiff = (peak * 1.5 * (h + t.tireDamping) * invLx) / kp;
          }
          // Wheel slowing against the ground (0 rolling .. 1 locked) → ABS.
          if (Math.abs(vx) > 2) lockSlip = (-sx * Math.sign(vx)) / vref;
        }
        this.forceX[i] = fx;
        this.forceY[i] = fy;

        // --- wheel spin: drive torque, tire reaction, then the resistances -
        let torque = -fx * r;
        let slope = stiff * r * r;
        if (wheel.driven && driveAbs > 0.01) {
          const along = om * r * driveSign;
          // Rev limiter at the top, constant POWER above `powerSpeed`.
          let taper = clamp((cap - along) / taperBand, 0, 1);
          if (along > powerSpeed) taper *= powerSpeed / along;
          torque += driveSign * driveAbs * driveTorqueMax * r * taper;
          if (taper > 0 && taper < 1) slope += (driveAbs * driveTorqueMax * r * r) / taperBand;
        }
        om += (h * torque) / (wheel.inertia + h * slope);
        // Resistances can stop a wheel but never turn it backwards.
        let resist = t.rollingResistance * this.load[i] * r;
        let brakeT = this.brakeTorque[i];
        if (brakeT > 0 && t.absStrength > 0 && lockSlip > t.absSlip) {
          const release = clamp((lockSlip - t.absSlip) / Math.max(0.02, t.absBand), 0, 1);
          brakeT *= 1 - t.absStrength * release;
        }
        resist += brakeT;
        // Engine braking fades out as the throttle opens (continuous at zero
        // pedal: no thrust step for a speed-holding foot to hunt around).
        if (wheel.driven && driveAbs < coastFade) resist += coastForce * (1 - driveAbs / coastFade) * r;
        if (parkTorqueScale > 0) resist += parkTorqueScale * wheel.staticLoad * r;
        const dOm = (h * resist) / wheel.inertia;
        om = Math.abs(om) <= dOm ? 0 : om - Math.sign(om) * dOm;
        this.spin[i] = om;
      }
      // Differential: a speed-difference coupling between the two wheels of
      // a driven axle (implicit, so any stiffness is stable). Loose when
      // coasting — the car turns in freely — and locking up with throttle,
      // so that under power BOTH rear tires spin together instead of the
      // unloaded inside one alone.
      if (diffCoupling > 0) {
        for (let i = 0; i < 4; i += 2) {
          const left = this.wheels[i];
          const right = this.wheels[i + 1];
          if (!left.driven || !right.driven) continue;
          const invL = 1 / left.inertia;
          const invR = 1 / right.inertia;
          const diff = this.spin[i] - this.spin[i + 1];
          // Angular momentum handed from the faster to the slower wheel.
          const moved = (diff - diff / (1 + h * diffCoupling * (invL + invR))) / (invL + invR);
          this.spin[i] -= moved * invL;
          this.spin[i + 1] += moved * invR;
        }
      }
      // Jacobi update of the predicted car motion (all four tires saw the
      // same state — no left/right bias).
      let ax = gpX, ay = gpY, az = gpZ, aw = 0;
      for (let i = 0; i < 4; i++) {
        if (!this.grounded[i]) continue;
        // Force back into the start tire frame (world impulse is summed there).
        const fx = this.forceX[i] * cosT - this.forceY[i] * sinT;
        const fy = this.forceX[i] * sinT + this.forceY[i] * cosT;
        this.impulseX[i] += fx * h;
        this.impulseY[i] += fy * h;
        ax += (fx * this.fwdX[i] + fy * this.latX[i]) * invM;
        ay += (fx * this.fwdY[i] + fy * this.latY[i]) * invM;
        az += (fx * this.fwdZ[i] + fy * this.latZ[i]) * invM;
        aw += (this.forceX[i] * this.kf[i] + this.forceY[i] * this.kl[i]) * invIz;
      }
      theta += (yaw0 + dw + 0.5 * aw * h) * h;
      dvX += ax * h;
      dvY += ay * h;
      dvZ += az * h;
      dw += aw * h;
    }
  }

  // --- placement --------------------------------------------------------------

  reset(groundPoint: Vector3, yaw: number): void {
    const q = Quaternion.FromEulerAnglesToRef(0, yaw, 0, this.tmpQ);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const cy = groundPoint.y + this.restHeight + 0.005;
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
    for (const wheel of this.wheels) {
      place(wheel.mesh, wheel.body, wheel.pivot.x, wheel.pivot.y + wheel.sag, wheel.pivot.z);
      if (wheel.steered) {
        wheel.constraint.setAxisMinLimit(PhysicsConstraintAxis.ANGULAR_Y, -0.001);
        wheel.constraint.setAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_Y, 0.001);
      }
    }
    for (let i = 0; i < 4; i++) {
      this.ux[i] = 0;
      this.uy[i] = 0;
      this.spin[i] = 0;
      this.loadFiltered[i] = 0;
      const state = this.wheelStates[i];
      state.position.copyFrom(this.wheels[i].mesh.position);
      state.velocity.setAll(0);
      state.rollSpeed = 0;
      state.slipSpeed = 0;
      state.spinSpeed = 0;
      state.steerAngle = 0;
      state.grounded = true;
    }
    this.historyDt = 0;
    this.steerAngle = 0;
    this.assistAngle = 0;
    this.brakeMode = BRAKE_NONE;
    this.brakeHoldTime = 0;
    this.airTime = 0;
    this._forwardSpeed = 0;
    this._drivenRimSpeed = 0;
    this._reversing = false;
    this.preStepFrames = 2;
    this.reverseIntent = false;
    this.visual.reset();
  }

  setMotion(velocity: Vector3, yawRate: number): void {
    this.historyDt = 0;
    const origin = this.chassisMesh.position;
    const q = this.chassisMesh.rotationQuaternion!;
    const rX = 1 - 2 * (q.y * q.y + q.z * q.z), rY = 2 * (q.x * q.y + q.z * q.w), rZ = 2 * (q.x * q.z - q.y * q.w);
    const uX = 2 * (q.x * q.y - q.z * q.w), uZ = 2 * (q.y * q.z + q.x * q.w);
    const fX = 2 * (q.x * q.z + q.y * q.w), fY = 2 * (q.y * q.z - q.x * q.w), fZ = 1 - 2 * (q.x * q.x + q.y * q.y);
    const v = this.tmpA;
    const w = this.tmpB;
    // ω × r with ω = (0, yawRate, 0): (yawRate·rz, 0, −yawRate·rx).
    const cl = this.comLocal;
    const cx = rX * cl.x + uX * cl.y + fX * cl.z;
    const cz = rZ * cl.x + uZ * cl.y + fZ * cl.z;
    v.set(velocity.x + yawRate * cz, velocity.y, velocity.z - yawRate * cx);
    this.chassisBody.setLinearVelocity(v);
    w.set(0, yawRate, 0);
    this.chassisBody.setAngularVelocity(w);
    for (let i = 0; i < 4; i++) {
      const wheel = this.wheels[i];
      const p = wheel.mesh.position;
      v.set(velocity.x + yawRate * (p.z - origin.z), velocity.y, velocity.z - yawRate * (p.x - origin.x));
      wheel.body.setLinearVelocity(v);
      // Rolling without slip for the forward component: spin about the axle.
      const spin = (v.x * fX + v.y * fY + v.z * fZ) / wheel.radius;
      w.set(rX * spin, yawRate + rY * spin, rZ * spin);
      wheel.body.setAngularVelocity(w);
      this.spin[i] = spin;
      this.ux[i] = 0;
      this.uy[i] = 0;
    }
  }

  dispose(): void {
    for (const wheel of this.wheels) wheel.constraint.dispose();
    for (const aggregate of this.wheelAggregates) aggregate.dispose();
    for (const wheel of this.wheels) wheel.mesh.dispose();
    this.chassisBody.dispose();
    this.chassisShape.dispose();
    for (const part of this.chassisParts) part.dispose();
    this.chassisMesh.dispose();
  }
}
