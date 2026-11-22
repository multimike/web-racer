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
  PhysicsConstraintMotorType,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import type { TuningParam, Vehicle, WheelGroundState } from './Vehicle';
import type { VehicleRig } from './rig';
import { VehicleVisual } from './visual';
import { ASSIST_TUNING_PARAMS, assistTuningForRig } from './assist/tuning';
import type { AssistTuning } from './assist/tuning';
import { TireCurve, smoothstep } from './assist/tire';

/**
 * 'assist' — the legacy rigid-wheel architecture pushed as far as it goes.
 *
 * UNCHANGED from RigidWheelVehicle: four real cylinder wheel bodies on 6DoF
 * constraints (vertical axis = damped spring, yaw axis = kinematic steering
 * clamp with Ackermann geometry, axle = velocity motor used in torque mode),
 * and Havok contact friction as the ONLY source of grip, load transfer and
 * collision response. Nothing is raycast, no tire force is synthesised.
 *
 * WHAT THE PHYSICS LAB FOUND, and what this class does about it (every item
 * is a number in `AssistTuning`, bounded, and can be switched off):
 *
 *  A. SOLVER AIDS — make Havok hold what the model asks for.
 *     - The "lateral grip deficit" of the legacy model is mostly the STEERING
 *       giving way: at 24 m/s the hubs sat at 2.0-2.5° with 4.8° commanded,
 *       and at half that again at 30 Hz. Wheel inertia ACROSS the axle is
 *       scaled up (wheelInertiaScale) and the shortfall is integrated back
 *       into the commanded limit (steerTrimRate). With that the contact
 *       itself delivers the same cornering force from 30 to 120 Hz.
 *     - A parked car creeps through the hub constraints (parking hold).
 *  B. MEASUREMENT — measureContact() reads the lateral force each axle's
 *     contacts really delivered from the momentum balance of the whole car,
 *     and the total normal force the same way (airborne test, tire loads).
 *  C. TIRE BEHAVIOUR the Coulomb contact does not have:
 *     - friction circle: a spinning or locked Havok wheel keeps ~75 % of its
 *       side force where a tire keeps ~50 %. The surplus over the tire model
 *       (assist/tire.ts) is REMOVED at that axle (gripAssistCut). This is
 *       what makes power oversteer exist at all.
 *     - compliance: the front wheels give way to the side force they carry
 *       (steerCompliance), which stands in for slip angle below the limit.
 *     (The opposite correction — ADDING force where the contact delivers
 *     less than the tire model — is implemented and OFF: once the steering
 *     holds it scored lower and was itself frame-rate dependent.)
 *  D. DRIVER AIDS:
 *     - traction control as the drift knob: wheelspin is limited to a slip
 *       ratio that grows with the trigger, so the throttle sets the slide
 *       angle instead of flipping between hooked-up and rev limit;
 *     - ABS + brake bias; continuous engine braking; brake holds on a slope;
 *     - slide-angle damper: a bounded yaw moment against CHANGES of slip
 *       angle while sliding on the throttle — without it a 25° slide at this
 *       gravity collapses or spins within 0.2 s, faster than any human;
 *     - catch help, air damping / levelling; optional speed-shaped steering
 *       map, front slip-angle cap, anti-roll bars.
 *
 * FRAMES AND SIGNS (same as Vehicle.ts): +x right, +y up, +z forward; yaw,
 * yaw rate and steer angles positive = RIGHT. Babylon is left-handed, but
 * the ALGEBRAIC cross products used here are consistent with that: with
 * omega = (0, +r, 0), omega × forward points right.
 */

const RAD = Math.PI / 180;
/** Hair-width range of the suspension axis (see the constraint comment). */
const SPRING_SLOP = 0.01;
/** Slip regularisation speed, m/s. */
const V_REF = 3;
// Empirical constraint sign conventions (CLAUDE.md): positive ANGULAR_X motor
// target = forward roll, positive ANGULAR_Y = steer right.
const DRIVE_SIGN = 1;
const STEER_SIGN = 1;

interface AssistWheel {
  mesh: Mesh;
  body: PhysicsBody;
  shape: PhysicsShapeCylinder;
  constraint: Physics6DoFConstraint;
  front: boolean;
  steered: boolean;
  driven: boolean;
  /** Lateral offset from the centreline, m (+ = right). */
  x: number;
  radius: number;
  mass: number;
  /** Inertia about any axis across the axle, kg·m². */
  crossInertia: number;
  springRate: number;
  damperRate: number;
  /** Constraint pivot in chassis space (hub position with the spring relaxed). */
  pivot: Vector3;
  /** Static spring compression at rest incl. the slop, m. */
  sag: number;
  // --- refreshed every update
  axle: Vector3;
  heading: Vector3;
  pivotWorld: Vector3;
  /** Ground speed along the wheel's heading / along its axle, m/s. */
  vLong: number;
  vLat: number;
  /** Rim speed, m/s (+ = forward roll). */
  rim: number;
  compression: number;
  /** Tire load estimate, N (spring + damper + wheel weight), low-passed. */
  load: number;
  /** Anti-roll bar force on this corner last frame, N (+ = pushes the wheel down). */
  barForce: number;
  /** Steer angle asked of this wheel last frame, and the trim added to the
   * constraint limit so the hub really gets there, rad. */
  steerTarget: number;
  steerTrim: number;
  /** Rotation since the parking hold engaged, rad. */
  holdAngle: number;
}

let instanceCounter = 0;

export class AssistedRigidVehicle implements Vehicle {
  readonly modelName = 'assist';
  readonly rig: VehicleRig;
  readonly tuningParams: readonly TuningParam[] = ASSIST_TUNING_PARAMS;
  readonly chassisMesh: Mesh;
  readonly chassisBody: PhysicsBody;
  readonly wheelStates: WheelGroundState[] = [];
  readonly visual: VehicleVisual;
  /** Live tuning; mutate through setTuning (pushes friction into Havok). */
  readonly tuning: AssistTuning;

  private input: InputProvider;
  private gravity: number;
  private wheels: AssistWheel[] = [];
  private wheelAggregates: PhysicsAggregate[] = [];
  private chassisShape: PhysicsShapeContainer;
  private chassisParts: PhysicsShapeBox[] = [];
  private curve = new TireCurve();
  private instance = ++instanceCounter;

  // --- constants derived from the rig
  private totalMass: number;
  private weight: number;
  /** Chassis CoM in chassis space. */
  private comLocal = new Vector3();
  /** Height of the chassis origin above the ground at rest, m. */
  private originHeight: number;
  private lockAngle = 0;

  // --- chassis state, refreshed every update
  private right = new Vector3(1, 0, 0);
  private up = new Vector3(0, 1, 0);
  private forward = new Vector3(0, 0, 1);
  private linVel = new Vector3();
  private angVel = new Vector3();
  private comWorld = new Vector3();
  private sysCom = new Vector3();
  private planarSpeed = 0;
  private _forwardSpeed = 0;
  private _drivenRimSpeed = 0;
  private _reversing = false;
  private steerAngle = 0;
  private steerFull = 0;
  private preStepFrames = 0;
  private time = 0;

  // --- pedal state
  /** What the current brake press is: 0 none, 1 braking, 2 reverse. */
  private brakeLatch = 0;
  private reverseIntent = false;
  /** Parking hold: the wheel motors servo each wheel's ANGLE (see updateDrivetrain). */
  private parked = false;
  private stillTime = 0;
  private parkPosition = new Vector3();

  // --- momentum bookkeeping (measureContact)
  private momentum = new Vector3();
  private prevMomentum = new Vector3();
  private prevAngular = 0;
  private prevDt = 0;
  private momentumValid = false;
  /** Assist applied during the previous step (N, N, N·m). */
  private appliedFront = 0;
  private appliedRear = 0;
  private appliedYaw = 0;
  /** Contact lateral force per axle, measured (raw) and low-passed, N. */
  private contactFront = 0;
  private contactRear = 0;
  private contactFrontRaw = 0;
  private contactRearRaw = 0;
  private armFront = 1;
  private armRear = 1;
  /** Total normal force on the car measured from momentum, low-passed, N. */
  private normalTotal = 0;
  /** Correction factor applied to the spring-based wheel loads. */
  private loadScale = 1;
  /** Tire-model lateral targets per axle, chassis-lateral, N. */
  private targetFront = 0;
  private targetRear = 0;
  /** 0..1 per axle: how far its tires are past the peak LONGITUDINAL slip
   * (wheelspin / lock-up), load-weighted. Gates the friction-circle cut. */
  private spinFront = 0;
  private spinRear = 0;

  // --- slide state
  private compliance = 0;
  private frontTravel = 0;
  private rearSlip = 0;
  private bodySlip = 0;
  private bodySlipRate = 0;
  private slideHold = 0;
  private airTime = 0;

  // --- scratch
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();

  constructor(scene: Scene, input: InputProvider, rig: VehicleRig, tuning?: AssistTuning) {
    this.input = input;
    this.rig = rig;
    this.tuning = { ...(tuning ?? assistTuningForRig(rig)) };
    this.gravity = scene.getPhysicsEngine()?.gravity.length() ?? rig.gravity;
    const t = this.tuning;

    const unsprung = rig.wheels.reduce((sum, w) => sum + w.mass, 0);
    this.totalMass = rig.sprungMass + unsprung;
    this.weight = this.totalMass * this.gravity;

    // --- Chassis: hull box + roll-cage box in one compound body. Origin =
    // centre of the hull, so the rig's numbers convert by one offset.
    const [hx, hy, hz] = rig.hull.center;
    this.originHeight = hy;
    this.comLocal.set(rig.com[0] - hx, rig.com[1] - hy, rig.com[2] - hz);
    const [hullW, hullH, hullL] = rig.hull.size;
    const chassis = MeshBuilder.CreateBox('assistCar', { width: hullW, height: hullH, depth: hullL }, scene);
    chassis.position.set(0, hy + 0.05, 0);
    chassis.rotationQuaternion = Quaternion.Identity();
    chassis.isVisible = false;
    this.chassisMesh = chassis;

    const container = new PhysicsShapeContainer(scene);
    const hull = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(hullW, hullH, hullL), scene);
    const cage = new PhysicsShapeBox(
      new Vector3(rig.cage.center[0] - hx, rig.cage.center[1] - hy, rig.cage.center[2] - hz),
      Quaternion.Identity(),
      new Vector3(rig.cage.size[0], rig.cage.size[1], rig.cage.size[2]),
      scene,
    );
    // Bodywork slides on things rather than gripping them.
    hull.material = { friction: 0.4, restitution: 0.05 };
    cage.material = { friction: 0.4, restitution: 0.05 };
    container.addChild(hull);
    container.addChild(cage);
    this.chassisShape = container;
    this.chassisParts.push(hull, cage);
    const body = new PhysicsBody(chassis, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = container;
    // GOTCHA: `inertia` is PER UNIT MASS (m²), not kg·m² (verified in the lab).
    body.setMassProperties({
      mass: rig.sprungMass,
      centerOfMass: this.comLocal.clone(),
      inertia: new Vector3(
        rig.inertia[0] / rig.sprungMass,
        rig.inertia[1] / rig.sprungMass,
        rig.inertia[2] / rig.sprungMass,
      ),
    });
    // Token aero/driveline losses only — yaw damping is the tires' job.
    body.setAngularDamping(0.1);
    body.setLinearDamping(0.02);
    this.chassisBody = body;

    // --- Wheels
    for (const rw of rig.wheels) {
      const axle = rw.axle === 'front' ? rig.front : rig.rear;
      const sag = (axle.sprungCornerMass * this.gravity) / axle.springRate + SPRING_SLOP;
      const pivot = new Vector3(rw.x - hx, rw.y - hy - sag, rw.z - hz);

      const mesh = MeshBuilder.CreateCylinder(
        `assistWheel${rw.index}`,
        { diameter: rw.radius * 2, height: rw.width, tessellation: 12 },
        scene,
      );
      // Built along Y; bake a 90° roll so the local X axis is the axle.
      mesh.rotation.z = Math.PI / 2;
      mesh.bakeCurrentTransformIntoVertices();
      mesh.rotationQuaternion = Quaternion.Identity();
      mesh.isVisible = false;
      mesh.position.set(pivot.x, chassis.position.y + pivot.y, pivot.z);

      const tread = (rw.width * Math.min(1, Math.max(0.1, t.treadWidthShare))) / 2;
      const shape = new PhysicsShapeCylinder(new Vector3(-tread, 0, 0), new Vector3(tread, 0, 0), rw.radius, scene);
      const aggregate = new PhysicsAggregate(mesh, shape, {
        mass: rw.mass,
        friction: t.contactFriction,
        restitution: 0,
      }, scene);
      aggregate.body.setAngularDamping(0.05);

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
          // Damped spring = suspension. The range must be hair-width and
          // non-zero (CLAUDE.md gotchas): 0/0 hard-locks the axis, a real
          // range is free travel before the spring engages.
          {
            axis: PhysicsConstraintAxis.LINEAR_Y,
            minLimit: -SPRING_SLOP,
            maxLimit: SPRING_SLOP,
            stiffness: axle.springRate,
            damping: axle.damperRate,
          },
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: 0, maxLimit: 0 },
          // Yaw: limits are clamped to the commanded angle every frame
          // (kinematic hold), so they must start as a hair-width range.
          // The rears stay hard-LOCKED: a locked axis is held far more rigidly
          // than a limited one (a limited rear axis shimmied at 30 Hz).
          rw.steered
            ? { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -0.001, maxLimit: 0.001 }
            : { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: 0, maxLimit: 0 },
        ],
        scene,
      );
      body.addConstraint(aggregate.body, constraint);
      constraint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
      constraint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, 0);
      constraint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);

      this.wheelAggregates.push(aggregate);
      this.wheels.push({
        mesh, body: aggregate.body, shape, constraint,
        front: rw.axle === 'front', steered: rw.steered, driven: rw.driven,
        x: rw.x, radius: rw.radius, mass: rw.mass,
        crossInertia: (rw.mass * (3 * rw.radius * rw.radius + rw.width * rw.width)) / 12,
        springRate: axle.springRate, damperRate: axle.damperRate,
        pivot, sag,
        axle: new Vector3(1, 0, 0), heading: new Vector3(0, 0, 1), pivotWorld: new Vector3(),
        vLong: 0, vLat: 0, rim: 0, compression: 0, load: 0, barForce: 0, steerTarget: 0, steerTrim: 0, holdAngle: 0,
      });
      this.wheelStates.push({
        position: mesh.position.clone(), velocity: new Vector3(), rollSpeed: 0, slipSpeed: 0,
        grounded: false, steerAngle: 0, spinSpeed: 0, radius: rw.radius,
      });
    }
    this.lockAngle = this.computeLock();
    this.steerFull = this.lockAngle;
    this.curve.configure(t.slideGripShare);
    this.applyWheelInertia();
    this.visual = new VehicleVisual(
      scene, this.chassisMesh,
      { x: -rig.hull.center[0], y: -rig.hull.center[1], z: -rig.hull.center[2] },
      rig.wheels,
    );
  }

  /**
   * Wheel mass properties. Spin inertia is the rig's (real). The inertia
   * ACROSS the axle is scaled up by `wheelInertiaScale`: the steering and
   * camber locks couple a ~1.5 kg·m² wheel to a ~600 kg·m² chassis, and
   * Havok's iterative solver cannot hold such a ratio rigid — measured at
   * 24 m/s, the hubs sat at half the commanded steer angle. A heavier wheel
   * (in rotation across the axle only) is what the solver needs.
   */
  private applyWheelInertia(): void {
    const scale = Math.max(1, this.tuning.wheelInertiaScale);
    for (const w of this.wheels) {
      const axle = w.front ? this.rig.front : this.rig.rear;
      const base = (3 * w.radius * w.radius + axle.tireWidth * axle.tireWidth) / 12;
      w.crossInertia = w.mass * base * scale;
      w.body.setMassProperties({
        mass: w.mass,
        centerOfMass: Vector3.Zero(),
        inertia: new Vector3(axle.wheelSpinInertia / w.mass, base * scale, base * scale),
      });
    }
  }

  // --- Vehicle interface: read-outs ----------------------------------------

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
    return this.steerAngle;
  }
  get maxSteerAngle(): number {
    return this.steerFull;
  }
  get wheelbase(): number {
    return this.rig.wheelbase;
  }
  get topSpeed(): number {
    return this.tuning.maxSpeed;
  }
  get nominalGrip(): number {
    return this.tuning.tireGrip;
  }

  getTuning(key: string): number | undefined {
    const value = (this.tuning as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  }

  setTuning(key: string, value: number): boolean {
    if (this.getTuning(key) === undefined || !Number.isFinite(value)) return false;
    (this.tuning as unknown as Record<string, number>)[key] = value;
    if (key === 'contactFriction') {
      for (const wheel of this.wheels) wheel.shape.material = { friction: value, restitution: 0 };
    }
    if (key === 'wheelInertiaScale') this.applyWheelInertia();
    if (key === 'treadWidthShare') {
      // Rebuild the wheel colliders (construction-time geometry).
      const scene = this.chassisMesh.getScene();
      for (const w of this.wheels) {
        const axle = w.front ? this.rig.front : this.rig.rear;
        const tread = (axle.tireWidth * Math.min(1, Math.max(0.1, value))) / 2;
        const shape = new PhysicsShapeCylinder(new Vector3(-tread, 0, 0), new Vector3(tread, 0, 0), w.radius, scene);
        shape.material = { friction: this.tuning.contactFriction, restitution: 0 };
        const old = w.shape;
        w.body.shape = shape;
        w.shape = shape;
        old.dispose();
      }
      this.applyWheelInertia();
    }
    if (key === 'minTurnRadius') {
      this.lockAngle = this.computeLock();
      this.steerFull = this.lockAngle;
    }
    return true;
  }

  private computeLock(): number {
    const halfTrack = this.rig.front.track / 2;
    return Math.atan(this.rig.wheelbase / Math.max(this.tuning.minTurnRadius, halfTrack + 0.1));
  }

  // --- per-frame -----------------------------------------------------------

  update(dt: number): void {
    const t = this.tuning;
    const intent = this.input.poll();
    const throttle = clamp01(intent.throttle);
    const brake = clamp01(intent.brake);
    const stick = Math.max(-1, Math.min(1, Number.isFinite(intent.steering) ? intent.steering : 0));

    // reset() teleports through Havok's pre-step transform copy; switch it
    // back off once the step after the reset has consumed it.
    if (this.preStepFrames > 0 && --this.preStepFrames === 0) {
      this.chassisBody.disablePreStep = true;
      for (const wheel of this.wheels) wheel.body.disablePreStep = true;
    }

    this.readState(dt);
    this.measureContact(dt);
    if (!(dt > 0)) return;
    this.time += dt;

    // Fades shared by the assists: none at parking speed (Havok is fine
    // there and a force that depends on noise must not move a resting car).
    const speedFade = smoothstep(t.gripAssistMinSpeed, 2 * t.gripAssistMinSpeed, this.planarSpeed);

    // "Sliding" lingers for a moment after the tail comes back, so the
    // slide assists are still there when the car swings through straight.
    const slide = speedFade *
      smoothstep(t.slideDampOnDeg * RAD, t.slideDampFullDeg * RAD, Math.abs(this.rearSlip));
    this.slideHold = Math.max(slide, this.slideHold - dt / 0.4);

    this.updateSteering(stick, dt, speedFade);
    this.updateDrivetrain(throttle, brake, dt);
    this.updateTireTargets(dt);
    this.applyGripAssist(dt, speedFade, stick);
    this.applyYawAssists(dt, throttle, stick, speedFade);
    this.applyBodyControl(dt);

    if (t.debugLog > 0) this.log(throttle, brake, stick);
    this.visual.capture(this.wheelStates, dt, intent, this.currentSteerAngle, this.isReversing);
  }

  /** Chassis and wheel kinematics, tire loads, system momentum. */
  private readState(dt: number): void {
    const body = this.chassisBody;
    const mesh = this.chassisMesh;
    const q = mesh.rotationQuaternion!;
    basisFromQuaternion(q, this.right, this.up, this.forward);
    const right = this.right;
    const up = this.up;
    const forward = this.forward;
    body.getLinearVelocityToRef(this.linVel);
    body.getAngularVelocityToRef(this.angVel);
    const lin = this.linVel;
    const ang = this.angVel;
    const pos = mesh.position;
    const cl = this.comLocal;
    const com = this.comWorld.set(
      pos.x + right.x * cl.x + up.x * cl.y + forward.x * cl.z,
      pos.y + right.y * cl.x + up.y * cl.y + forward.y * cl.z,
      pos.z + right.z * cl.x + up.z * cl.y + forward.z * cl.z,
    );
    this._forwardSpeed = Vector3.Dot(lin, forward);
    this.planarSpeed = Math.hypot(lin.x, lin.z);

    const rig = this.rig;
    const sprung = rig.sprungMass;
    // System momentum and centre of mass (chassis + four wheels).
    const P = this.momentum.set(lin.x * sprung, lin.y * sprung, lin.z * sprung);
    const sys = this.sysCom.set(com.x * sprung, com.y * sprung, com.z * sprung);

    const kLoad = dt > 0 ? Math.min(1, dt / 0.03) : 1;
    let rimSum = 0;
    let drivenCount = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const state = this.wheelStates[i];
      const wp = w.mesh.position;
      state.position.copyFrom(wp);
      w.body.getLinearVelocityToRef(state.velocity);
      w.body.getAngularVelocityToRef(this.tmpA);
      const vel = state.velocity;
      const wq = w.mesh.rotationQuaternion!;
      // Axle = the wheel's local X in world space.
      const axle = w.axle.set(
        1 - 2 * (wq.y * wq.y + wq.z * wq.z),
        2 * (wq.x * wq.y + wq.z * wq.w),
        2 * (wq.x * wq.z - wq.y * wq.w),
      );
      const spin = DRIVE_SIGN * Vector3.Dot(this.tmpA, axle);
      w.rim = spin * w.radius;
      state.spinSpeed = spin;
      // Heading = axle × chassis-up; degenerate only if the axle points
      // along the chassis's up axis, which the constraint forbids.
      const heading = w.heading.set(
        axle.y * up.z - axle.z * up.y,
        axle.z * up.x - axle.x * up.z,
        axle.x * up.y - axle.y * up.x,
      );
      const hl = heading.length();
      if (hl > 0.2) heading.scaleInPlace(1 / hl);
      else heading.copyFrom(forward);
      w.vLong = Vector3.Dot(vel, heading);
      w.vLat = Vector3.Dot(vel, axle);

      // Suspension: hub position relative to the relaxed-spring pivot.
      const p = w.pivot;
      const pw = w.pivotWorld.set(
        pos.x + right.x * p.x + up.x * p.y + forward.x * p.z,
        pos.y + right.y * p.x + up.y * p.y + forward.y * p.z,
        pos.z + right.z * p.x + up.z * p.y + forward.z * p.z,
      );
      const compression = (wp.x - pw.x) * up.x + (wp.y - pw.y) * up.y + (wp.z - pw.z) * up.z;
      w.compression = compression;
      // Velocity of the chassis at the pivot: v + omega × (pivot − com).
      const rx = pw.x - com.x;
      const ry = pw.y - com.y;
      const rz = pw.z - com.z;
      const pvx = lin.x + ang.y * rz - ang.z * ry;
      const pvy = lin.y + ang.z * rx - ang.x * rz;
      const pvz = lin.z + ang.x * ry - ang.y * rx;
      const rate = (vel.x - pvx) * up.x + (vel.y - pvy) * up.y + (vel.z - pvz) * up.z;
      let load = 0;
      if (compression > SPRING_SLOP) {
        load = w.springRate * (compression - SPRING_SLOP) + w.damperRate * rate + w.barForce;
        // The contact also carries the wheel itself.
        load = Math.max(0, load) + w.mass * this.gravity * Math.max(0, up.y);
      }
      w.load += (load - w.load) * kLoad;
      if (compression <= SPRING_SLOP) w.load = 0;
      state.grounded = compression > SPRING_SLOP + 0.15 * (w.sag - SPRING_SLOP);

      // ACTUAL yaw of the hub relative to the chassis (not the command).
      state.steerAngle = Math.atan2(-Vector3.Dot(axle, forward), Vector3.Dot(axle, right));
      if (w.driven) {
        rimSum += w.rim;
        drivenCount++;
      }
      state.rollSpeed = Math.abs(w.vLong);
      state.slipSpeed = Math.hypot(w.rim - w.vLong, w.vLat);

      P.x += vel.x * w.mass;
      P.y += vel.y * w.mass;
      P.z += vel.z * w.mass;
      sys.x += wp.x * w.mass;
      sys.y += wp.y * w.mass;
      sys.z += wp.z * w.mass;
    }
    sys.scaleInPlace(1 / this.totalMass);
    this._drivenRimSpeed = drivenCount > 0 ? rimSum / drivenCount : 0;

    // Travel directions (chassis frame, + = moving toward the car's right).
    const ws = this.wheelStates;
    const fl = ws[0].velocity;
    const fr = ws[1].velocity;
    const rl = ws[2].velocity;
    const rr = ws[3].velocity;
    const fLat = 0.5 * ((fl.x + fr.x) * right.x + (fl.y + fr.y) * right.y + (fl.z + fr.z) * right.z);
    const fLong = 0.5 * ((fl.x + fr.x) * forward.x + (fl.y + fr.y) * forward.y + (fl.z + fr.z) * forward.z);
    const rLat = 0.5 * ((rl.x + rr.x) * right.x + (rl.y + rr.y) * right.y + (rl.z + rr.z) * right.z);
    const rLong = 0.5 * ((rl.x + rr.x) * forward.x + (rl.y + rr.y) * forward.y + (rl.z + rr.z) * forward.z);
    const kSlip = dt > 0 ? Math.min(1, dt / 0.04) : 1;
    const frontTravel = Math.atan2(fLat, Math.max(Math.abs(fLong), V_REF));
    const rearSlip = Math.atan2(rLat, Math.max(Math.abs(rLong), V_REF));
    this.frontTravel += (frontTravel - this.frontTravel) * kSlip;
    this.rearSlip += (rearSlip - this.rearSlip) * kSlip;
    const vLatBody = Vector3.Dot(lin, right);
    const bodySlip = this.planarSpeed > 1.5 ? Math.atan2(vLatBody, Math.max(Math.abs(this._forwardSpeed), 0.5)) : 0;
    if (dt > 0 && this.momentumValid) {
      const rate = (bodySlip - this.bodySlip) / dt;
      this.bodySlipRate += (rate - this.bodySlipRate) * Math.min(1, dt / 0.05);
    } else {
      this.bodySlipRate = 0;
    }
    this.bodySlip = bodySlip;
  }

  /**
   * What did the CONTACTS deliver sideways during the last physics step?
   *
   * The momentum of the whole car (chassis + wheels) only changes through
   * external forces: contacts, gravity, and the assist forces this class
   * applied itself — constraint and motor forces are internal and cancel.
   * So   contact = d(momentum)/dt − gravity − own assists,
   * exactly, as a mean over the step, with no model of the contact at all.
   * The same for the yaw angular momentum about the car's CoM gives the
   * yaw moment, and the two together split into a front-axle and a
   * rear-axle lateral force.
   */
  private measureContact(dt: number): void {
    const right = this.right;
    const up = this.up;
    const forward = this.forward;
    const sys = this.sysCom;
    const P = this.momentum;

    // Yaw angular momentum about the system CoM, along the chassis's up axis.
    const lin = this.linVel;
    const com = this.comWorld;
    const sprung = this.rig.sprungMass;
    let angular = this.rig.inertia[1] * Vector3.Dot(this.angVel, up);
    angular += sprung * tripleUp(com.x - sys.x, com.y - sys.y, com.z - sys.z, lin, up);
    let frontZ = 0;
    let rearZ = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const wp = this.wheelStates[i].position;
      const rx = wp.x - sys.x;
      const ry = wp.y - sys.y;
      const rz = wp.z - sys.z;
      angular += w.mass * tripleUp(rx, ry, rz, this.wheelStates[i].velocity, up);
      // Wheel's own yaw (steering motion); its spin has no component along up.
      w.body.getAngularVelocityToRef(this.tmpA);
      const spin = Vector3.Dot(this.tmpA, w.axle);
      angular += w.crossInertia * (Vector3.Dot(this.tmpA, up) - spin * Vector3.Dot(w.axle, up));
      const along = rx * forward.x + ry * forward.y + rz * forward.z;
      if (w.front) frontZ += 0.5 * along;
      else rearZ += 0.5 * along;
    }
    this.armFront = Math.max(0.1, frontZ);
    this.armRear = Math.max(0.1, -rearZ);

    if (this.momentumValid && this.prevDt > 0) {
      const inv = 1 / this.prevDt;
      const prev = this.prevMomentum;
      // Total external lateral force minus gravity's share (slopes, roll).
      let lateral =
        ((P.x - prev.x) * right.x + (P.y - prev.y) * right.y + (P.z - prev.z) * right.z) * inv +
        this.weight * right.y;
      let moment = (angular - this.prevAngular) * inv;
      lateral -= this.appliedFront + this.appliedRear;
      moment -= this.armFront * this.appliedFront - this.armRear * this.appliedRear + this.appliedYaw;
      // Same bookkeeping along the chassis's up axis = the total normal force.
      // The spring-based per-wheel loads share it out (they read ~10 % low
      // in hard cornering); this makes their SUM exact.
      const normal =
        ((P.x - prev.x) * up.x + (P.y - prev.y) * up.y + (P.z - prev.z) * up.z) * inv + this.weight * up.y;
      this.normalTotal += (normal - this.normalTotal) * Math.min(1, this.prevDt / 0.06);
      let springSum = 0;
      for (const w of this.wheels) springSum += w.load;
      const scale = springSum > 0.05 * this.weight ? this.normalTotal / springSum : 1;
      // (Down to zero: in the air a spring still reads load whenever the
      // chassis is being rotated, the momentum balance does not.)
      this.loadScale = Math.max(0, Math.min(1.6, scale));
      const span = this.armFront + this.armRear;
      this.contactFrontRaw = (this.armRear * lateral + moment) / span;
      this.contactRearRaw = (this.armFront * lateral - moment) / span;
      const k = Math.min(1, this.prevDt / Math.max(this.tuning.gripAssistTau, 1e-3));
      this.contactFront += (this.contactFrontRaw - this.contactFront) * k;
      this.contactRear += (this.contactRearRaw - this.contactRear) * k;
    } else {
      this.contactFront = 0;
      this.contactRear = 0;
      this.contactFrontRaw = 0;
      this.contactRearRaw = 0;
      this.normalTotal = this.weight * Math.max(0, up.y);
      this.loadScale = 1;
    }
    this.prevMomentum.copyFrom(P);
    this.prevAngular = angular;
    this.prevDt = dt;
    this.momentumValid = dt > 0;
    this.appliedFront = 0;
    this.appliedRear = 0;
    this.appliedYaw = 0;
  }

  private updateSteering(stick: number, dt: number, speedFade: number): void {
    const t = this.tuning;
    const L = this.rig.wheelbase;
    const lock = this.lockAngle;

    // Stick → bicycle steer angle. With steerShaping the map is bent by the
    // tire model (see shapedSteer); full stick is then lock minus the peak
    // slip angle at speed, and exactly lock at parking speed.
    this.steerFull = this.shapedSteer(lock);
    let target = Math.sign(stick) * this.shapedSteer(Math.abs(stick) * lock);

    // Front slip-angle cap: never hold the wheels further than the limit
    // past the direction the front axle is actually travelling.
    if (t.steerSlipLimitDeg > 0 && speedFade > 0 && this._forwardSpeed > 0) {
      const limit = t.steerSlipLimitDeg * RAD + (1 - speedFade) * 2 * lock;
      target = Math.max(this.frontTravel - limit, Math.min(this.frontTravel + limit, target));
      target = Math.max(-lock, Math.min(lock, target));
    }
    const maxStep = t.steerResponse * dt;
    this.steerAngle += Math.max(-maxStep, Math.min(maxStep, target - this.steerAngle));

    // Steering compliance: the front wheels give way to the side force
    // they carry (measured CONTACT force — never the assist's own force, or
    // the wheels would be steered away until the assist carried the car).
    // This is what tire slip angle / a real steering system's compliance
    // does: more lock is needed as cornering force builds, and force
    // transients are softened. Low-passed: the contact answers a change of
    // wheel angle with an impulse, and a fast loop on it rings (13 Hz).
    if (t.steerCompliance > 0) {
      const w = this.wheels;
      const cap = t.tireGrip * this.loadScale * (w[0].load + w[1].load);
      const share = cap > 1 ? Math.max(-1, Math.min(1, this.contactFront / cap)) : 0;
      const wanted = -share * t.steerCompliance * RAD * speedFade;
      this.compliance += (wanted - this.compliance) * Math.min(1, dt / Math.max(t.steerComplianceTau, dt));
    } else {
      this.compliance = 0;
    }

    // Ackermann: both front wheels aim at the common turn centre.
    const tan = Math.tan(this.steerAngle + this.compliance);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.steered) continue;
      // Steering trim: Havok's angular limit gives under tire load (hubs were
      // measured 15-50 % short of the commanded angle at speed, depending on
      // the frame rate). Integrate the shortfall into the commanded limit so
      // the hub ends up where the steering says, at any step size.
      if (t.steerTrimRate > 0) {
        // Only while actually steering: the limit yields under side load,
        // and with the wheels straight there is none — there the trim would
        // just integrate measurement noise into a wandering toe angle
        // (measured: 14 s hands-off run drifted 1.6° with it, 0.7° without).
        const active = smoothstep(0.5 * RAD, 2 * RAD, Math.abs(w.steerTarget));
        const error = w.steerTarget - this.wheelStates[i].steerAngle;
        w.steerTrim += active * Math.max(-0.1, Math.min(0.1, error)) * Math.min(1, t.steerTrimRate * dt);
        w.steerTrim -= (1 - active) * w.steerTrim * Math.min(1, 4 * dt);
        w.steerTrim = Math.max(-0.2, Math.min(0.2, w.steerTrim));
      } else {
        w.steerTrim = 0;
      }
      const angle = Math.atan((L * tan) / (L - w.x * tan));
      w.steerTarget = angle;
      const limit = STEER_SIGN * (angle + w.steerTrim);
      w.constraint.setAxisMinLimit(PhysicsConstraintAxis.ANGULAR_Y, limit);
      w.constraint.setAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_Y, limit);
    }
  }

  /**
   * GRIP-SHAPED STEERING MAP (speed-sensitive steering, from TOTAL planar
   * speed so a slide cannot open the steering back up into the spin).
   *
   * A Havok wheel has no slip angle below the limit: it tracks its heading
   * rigidly, so cornering force rises in a straight line with steer angle
   * and then stops dead — at 20 m/s the whole grip range is 9° of lock and
   * the last degree is a cliff. A tire needs slip angle to make force, so a
   * real car needs
   *     steer = kinematic angle for the turn + front slip angle for its force.
   * This map solves that the other way round: the stick asks for `command`,
   * and the wheels get the angle `eff` with
   *     command = eff + peakSlipFront · slipFor(v² · tan(eff) / (L · mu·g)),
   * slipFor being the inverse tire curve. Low speed: eff ≈ command. At
   * speed: the response softens progressively toward the grip limit instead
   * of hitting it — the same thing a slip angle does, with no feedback loop
   * (a measured-force version of this oscillated at 13 Hz, see the log).
   */
  private shapedSteer(command: number): number {
    const t = this.tuning;
    const shaping = Math.min(1, Math.max(0, t.steerShaping));
    if (shaping <= 0 || command <= 0) return command;
    const peak = shaping * t.peakSlipFrontDeg * RAD;
    const k = (this.planarSpeed * this.planarSpeed) / (this.rig.wheelbase * t.tireGrip * this.gravity);
    // command(eff) is monotonic: bisect.
    let lo = Math.max(0, command - peak);
    let hi = command;
    for (let i = 0; i < 14; i++) {
      const eff = 0.5 * (lo + hi);
      const asked = eff + peak * this.curve.slipFor(k * Math.tan(eff));
      if (asked > command) hi = eff;
      else lo = eff;
    }
    return 0.5 * (lo + hi);
  }

  private updateDrivetrain(throttle: number, brake: number, dt: number): void {
    const t = this.tuning;
    const v = this._forwardSpeed;

    // --- What is the brake pedal doing? A press that starts while the car
    // is (nearly) stopped is REVERSE; a press that starts while rolling is a
    // BRAKE and stays one until released — so it holds the car on a slope
    // instead of driving it backwards down the hill.
    // "Rolling" means MOVING, in any direction: sideways in a slide or
    // backward after a spin / down a hill the trigger is a brake too (it used
    // to latch reverse whenever the FORWARD speed was low, and drove a
    // spun car backward at 12 m/s). Backing up on purpose keeps reversing.
    if (throttle > 0.02 || v > 0.5) this.reverseIntent = false;
    if (brake <= 0.02) {
      this.brakeLatch = 0;
    } else if (this.brakeLatch === 0) {
      const still = this.planarSpeed < 1 && Math.abs(v) < 0.5;
      this.brakeLatch = throttle <= 0.02 && (still || (this.reverseIntent && v < 0.5)) ? 2 : 1;
    } else if (this.brakeLatch === 1 && t.reverseOnHeldBrake > 0 && v < 0.5 && throttle <= 0.02) {
      this.brakeLatch = 2;
    } else if (this.brakeLatch === 2 && (throttle > 0.02 || v > 1.5)) {
      this.brakeLatch = 1;
    }
    if (this.brakeLatch === 2) this.reverseIntent = true;
    const reversing = this.brakeLatch === 2;
    const braking = this.brakeLatch === 1;
    this._reversing = reversing;
    const drive = reversing ? -brake : braking ? 0 : throttle;

    // --- Parking hold. A velocity motor at target 0 still creeps under a
    // steady load (measured: 7 cm/s down a 15° slope with the brake held).
    // So once the car has stopped — brake held, or no pedal at all — each
    // wheel motor servos the wheel's ANGLE instead (target speed = −gain ×
    // how far it has turned since), until throttle or reverse.
    const wantsHold = t.idleHoldG > 0 && Math.abs(drive) < 0.02;
    this.stillTime = wantsHold && this.planarSpeed < 0.3 && Math.abs(this.linVel.y) < 0.5 ? this.stillTime + dt : 0;
    const park = wantsHold && (this.parked ? this.planarSpeed < 1.5 : this.stillTime > 0.1);
    if (park && !this.parked) {
      for (const w of this.wheels) w.holdAngle = 0;
      this.parkPosition.copyFrom(this.chassisMesh.position);
    }
    this.parked = park;
    let standing = 0;
    for (const w of this.wheels) if (w.load > 0) standing++;
    if (park && standing >= 3 && this.up.y > 0.5) {
      // Parking anchor. With the wheels held, Havok still lets the chassis
      // creep downhill at ~2.5 cm/s THROUGH the hub constraints: its solver
      // leaves about a quarter of each step's along-slope gravity impulse
      // unresolved and drags the wheels after the chassis by position
      // correction (measured: rim speed and hub velocity 0.000, chassis
      // 0.025 m/s; on another rig the same creep ran UPHILL). So while
      // parked, the along-slope part of the chassis's weight is carried
      // directly, plus a damped spring to the spot where the car stopped —
      // all bounded by idleHoldG × weight: it cannot hold the car on a wall.
      const lin = this.linVel;
      const up = this.up;
      const m = this.rig.sprungMass;
      const along = lin.x * up.x + lin.y * up.y + lin.z * up.z;
      // Gravity (0, −g, 0) minus its component along the chassis's up axis.
      const gUp = -this.gravity * up.y;
      const pos = this.chassisMesh.position;
      const park0 = this.parkPosition;
      const dx = pos.x - park0.x;
      const dy = pos.y - park0.y;
      const dz = pos.z - park0.z;
      const off = dx * up.x + dy * up.y + dz * up.z;
      const spring = 60 * m; // N/m: ~1.2 Hz on the sprung mass
      const damp = 0.5 * (m / dt);
      let fx = -m * (0 - up.x * gUp) - damp * (lin.x - up.x * along) - spring * (dx - up.x * off);
      let fy = -m * (-this.gravity - up.y * gUp) - damp * (lin.y - up.y * along) - spring * (dy - up.y * off);
      let fz = -m * (0 - up.z * gUp) - damp * (lin.z - up.z * along) - spring * (dz - up.z * off);
      const size = Math.hypot(fx, fy, fz);
      const bound = t.idleHoldG * this.weight;
      if (size > bound) {
        fx *= bound / size;
        fy *= bound / size;
        fz *= bound / size;
      }
      this.chassisBody.applyImpulse(this.tmpC.set(fx * dt, fy * dt, fz * dt), this.comWorld);
    }

    let drivenCount = 0;
    for (const w of this.wheels) if (w.driven) drivenCount++;
    const dir = drive < 0 ? -1 : 1;
    const amount = Math.abs(drive);
    const cap = dir > 0 ? t.maxSpeed : t.maxSpeed * t.reverseSpeedFactor;
    // No pedal at walking pace: brake gently to a stop (the parking hold
    // above takes over once stopped).
    const idle = amount < 0.02 && !braking ? t.idleHoldG * Math.max(0, 1 - this.planarSpeed / 1.5) : 0;

    for (const w of this.wheels) {
      const axis = PhysicsConstraintAxis.ANGULAR_X;
      const r = w.radius;
      if (park) {
        w.holdAngle += (w.rim / r) * dt;
        const back = Math.max(-3, Math.min(3, -12 * w.holdAngle));
        w.constraint.setAxisMotorTarget(axis, DRIVE_SIGN * back);
        w.constraint.setAxisMotorMaxForce(axis, (Math.max(t.idleHoldG, brake * t.brakeG) * this.weight * r) / 4);
        continue;
      }
      if (braking) {
        // ABS: hold the rim at (1 − slip) × ground speed instead of zero, so
        // the tire keeps a rolling direction and with it some side force.
        const share = w.front ? t.brakeBiasFront : 1 - t.brakeBiasFront;
        const slip = Math.min(1, Math.max(0.02, w.front ? t.absSlipFront : t.absSlipRear));
        const rolling = smoothstep(1, 3, Math.abs(w.vLong));
        const targetRim = w.vLong * (1 - slip) * rolling;
        w.constraint.setAxisMotorTarget(axis, (DRIVE_SIGN * targetRim) / r);
        w.constraint.setAxisMotorMaxForce(axis, (brake * t.brakeG * share * this.weight * r) / 2);
        continue;
      }
      let torque = 0;
      let targetRim = 0;
      if (w.driven) {
        // Net of drive and engine braking: one continuous function of the
        // trigger, no step where the coast motor cuts in.
        const along = w.vLong * dir;
        const engineBrake = t.engineBrakeG * (1 - amount) * Math.min(1, Math.abs(w.rim) / 3);
        const net = ((amount * t.driveG - engineBrake) * this.weight * r) / drivenCount;
        if (net > 0) {
          if (along > cap) {
            // Over the rev limit (downhill): engine braking only.
            targetRim = dir * cap;
            torque = (t.engineBrakeG * this.weight * r) / drivenCount;
          } else {
            // Traction control: wheelspin limited to a slip that grows with
            // the trigger. The target is always ABOVE the rolling speed, so
            // the motor can never brake the car (CLAUDE.md gotcha).
            const allowance =
              (t.driveSlipBase + t.driveSlipRatio * Math.max(along, 0)) * Math.pow(amount, t.driveSlipCurve) + 0.3;
            targetRim = dir * Math.min(Math.max(along, 0) + allowance, cap);
            torque = net;
          }
        } else {
          targetRim = 0;
          torque = -net;
        }
      }
      if (idle > 0) {
        targetRim = 0;
        torque = Math.max(torque, (idle * this.weight * r) / 4);
      }
      w.constraint.setAxisMotorTarget(axis, (DRIVE_SIGN * targetRim) / r);
      w.constraint.setAxisMotorMaxForce(axis, torque);
    }
  }

  /** Tire-model lateral force each axle should deliver, chassis-lateral, N. */
  private updateTireTargets(dt: number): void {
    const t = this.tuning;
    this.curve.configure(t.slideGripShare);
    const peakFront = Math.tan(Math.max(1, t.peakSlipFrontDeg) * RAD);
    const peakRear = Math.tan(Math.max(1, t.peakSlipRearDeg) * RAD);
    const right = this.right;
    let front = 0;
    let rear = 0;
    let spinFront = 0;
    let spinRear = 0;
    let loadFront = 0;
    let loadRear = 0;
    for (const w of this.wheels) {
      if (w.load <= 0) continue;
      const peak = w.front ? peakFront : peakRear;
      const ref = Math.max(Math.abs(w.vLong), V_REF) * peak;
      const sx = (w.rim - w.vLong) / ref;
      const sy = -w.vLat / ref;
      const rho = Math.hypot(sx, sy);
      if (rho < 1e-6) continue;
      const force = (t.tireGrip * w.load * this.loadScale * this.curve.shape(rho)) / rho;
      // Along the heading and along the axle, then onto the chassis's right.
      const lateral =
        force * sx * Vector3.Dot(w.heading, right) + force * sy * Vector3.Dot(w.axle, right);
      const spin = smoothstep(0.5, 1.5, Math.abs(sx)) * w.load;
      if (w.front) {
        front += lateral;
        spinFront += spin;
        loadFront += w.load;
      } else {
        rear += lateral;
        spinRear += spin;
        loadRear += w.load;
      }
    }
    this.spinFront = loadFront > 0 ? spinFront / loadFront : 0;
    this.spinRear = loadRear > 0 ? spinRear / loadRear : 0;
    // Tire relaxation (the force lags the slip a little) — also keeps
    // single-frame slip noise out of the assist.
    const k = Math.min(1, dt / 0.03);
    this.targetFront += (front - this.targetFront) * k;
    this.targetRear += (rear - this.targetRear) * k;
  }

  private applyGripAssist(dt: number, speedFade: number, stick: number): void {
    const t = this.tuning;
    if (t.gripAssist <= 0 || speedFade <= 0) return;
    const w = this.wheels;
    const gain = Math.min(1, t.gripAssist) * speedFade;
    const frontCap = t.tireGrip * this.loadScale * (w[0].load + w[1].load);
    const rearCap = t.tireGrip * this.loadScale * (w[2].load + w[3].load);
    // ADD what the contact fails to deliver (off by default, see the class
    // comment); CUT the side force a spinning or locked tire should not have
    // (friction circle): Havok's contact keeps ~75 % of its side force under
    // full wheelspin where an isotropic tire keeps ~50 % (measured).
    // The cut only applies while the driver is steering or the car is
    // already sliding: hands-off on the throttle the contact keeps all the
    // side force it has, which is what holds a full-throttle launch straight
    // (with the cut, a 1.5 % left/right load difference turned the launch).
    const turning = Math.min(1, Math.max(Math.abs(stick) * 4, this.slideHold));
    const front = gain * (
      deficit(this.targetFront, this.contactFront, t.gripAssistMax * frontCap) +
      turning * this.spinFront * surplus(this.targetFront, this.contactFront, t.gripAssistCut * frontCap));
    const rear = gain * (
      deficit(this.targetRear, this.contactRear, t.gripAssistMax * rearCap) +
      turning * this.spinRear * surplus(this.targetRear, this.contactRear, t.gripAssistCut * rearCap));
    this.applyLateral(front, 0.5 * (w[0].pivot.z + w[1].pivot.z), dt);
    this.applyLateral(rear, 0.5 * (w[2].pivot.z + w[3].pivot.z), dt);
    this.appliedFront += front;
    this.appliedRear += rear;
  }

  /** Lateral force on the chassis at an axle (chassis-space z), as an impulse
   * over the coming step. (`applyForce` would scale by the plugin's fixed
   * 1/60 s, whatever the real step is.) */
  private applyLateral(force: number, axleZ: number, dt: number): void {
    if (force === 0 || !Number.isFinite(force)) return;
    const right = this.right;
    const up = this.up;
    const forward = this.forward;
    const pos = this.chassisMesh.position;
    const h = Math.min(1, Math.max(0, this.tuning.gripAssistHeight));
    const y = -this.originHeight + h * (this.comLocal.y + this.originHeight);
    const point = this.tmpB.set(
      pos.x + up.x * y + forward.x * axleZ,
      pos.y + up.y * y + forward.y * axleZ,
      pos.z + up.z * y + forward.z * axleZ,
    );
    const impulse = this.tmpC.set(right.x * force * dt, right.y * force * dt, right.z * force * dt);
    this.chassisBody.applyImpulse(impulse, point);
  }

  private applyYawAssists(dt: number, throttle: number, stick: number, speedFade: number): void {
    const t = this.tuning;
    if (speedFade <= 0 || this._forwardSpeed < 1) return;
    const w = this.wheels;
    // Needs the rear on the ground: the moments stand in for tire forces.
    const rearLoad = w[2].load + w[3].load;
    const frontLoad = w[0].load + w[1].load;
    if (rearLoad <= 0 || frontLoad <= 0) return;
    const scale = this.weight * this.rig.wheelbase;
    let moment = 0;

    if (t.slideDamp > 0) {
      // Full authority on the throttle (holding a drift), a fraction off it
      // (so lifting still straightens the car, just without the snap).
      const powered = smoothstep(t.slideDampThrottle, t.slideDampThrottle + 0.25, throttle);
      const authority = t.slideDampLift + (1 - t.slideDampLift) * powered;
      const rate = t.slideDamp * this.totalMass * this.rig.wheelbase * this.rig.wheelbase;
      const bound = t.slideDampMax * scale;
      // A slide that is still GROWING is only resisted once it is deep
      // (slideDampGrowDeg … 2×): the tail must be free to step out, and
      // held once it is out. A slide that is closing is damped throughout.
      const growing = this.bodySlipRate * this.bodySlip > 0;
      const depth = growing
        ? smoothstep(t.slideDampGrowDeg * RAD, 2 * t.slideDampGrowDeg * RAD, Math.abs(this.rearSlip))
        : 1;
      // Slip angle growing (+) → yaw the car right (+) so it follows.
      moment += this.slideHold * authority * depth *
        Math.max(-bound, Math.min(bound, rate * this.bodySlipRate));

    }
    if (t.catchAssist > 0) {
      // Countersteering = stick toward the body slip; off the throttle.
      const beta = this.bodySlip;
      const intent = Math.max(0, Math.min(1, stick * Math.sign(beta) * 2)) * (1 - smoothstep(0.2, 0.6, throttle));
      const excess = Math.sign(beta) * Math.max(0, Math.abs(beta) - 4 * RAD);
      const bound = t.catchAssistMax * scale;
      moment += intent * Math.max(-bound, Math.min(bound, t.catchAssist * scale * excess));
    }
    moment *= speedFade;
    if (moment === 0 || !Number.isFinite(moment)) return;
    const up = this.up;
    this.chassisBody.applyAngularImpulse(this.tmpC.set(up.x * moment * dt, up.y * moment * dt, up.z * moment * dt));
    this.appliedYaw += moment;
  }

  /** Anti-roll bars and the airborne stabiliser. */
  private applyBodyControl(dt: number): void {
    const t = this.tuning;
    const up = this.up;
    const w = this.wheels;

    // --- Anti-roll bars: a spring between the two wheels of an axle.
    for (let a = 0; a < 2; a++) {
      const left = w[a * 2];
      const rightWheel = w[a * 2 + 1];
      const share = a === 0 ? t.antiRollFront : t.antiRollRear;
      if (share <= 0) {
        left.barForce = 0;
        rightWheel.barForce = 0;
        continue;
      }
      const stroke = Math.max(-0.2, Math.min(0.2, left.compression - rightWheel.compression));
      const force = share * left.springRate * stroke;
      left.barForce = force;
      rightWheel.barForce = -force;
      if (force === 0) continue;
      // More compressed side: chassis pushed up, wheel pushed down.
      const j = this.tmpC.set(up.x * force * dt, up.y * force * dt, up.z * force * dt);
      this.chassisBody.applyImpulse(j, left.pivotWorld);
      rightWheel.body.applyImpulse(j, rightWheel.mesh.position);
      j.scaleInPlace(-1);
      this.chassisBody.applyImpulse(j, rightWheel.pivotWorld);
      left.body.applyImpulse(j, left.mesh.position);
    }

    // --- In the air: damp tumbling, level out. (Fake: stands in for the
    // driver's throttle/brake air control and for aerodynamic stability.)
    // Airborne = the ground carries (almost) none of the car's weight, by
    // the momentum balance — spring compression alone is fooled by the
    // stabiliser's own torque swinging the wheels on their springs.
    const airborne = this.momentumValid && this.normalTotal < 0.08 * this.weight;
    this.airTime = airborne ? this.airTime + dt : 0;
    // Only in real flight: moving, and not for ever — a car lying on its
    // side or roof also has four unloaded wheels and must not be torqued.
    const flying = this.airTime > 0.05 && this.airTime < 4 &&
      (this.planarSpeed > 2 || Math.abs(this.linVel.y) > 2);
    if (flying && (t.airDampTime > 0 || t.airLevel > 0)) {
      const right = this.right;
      const forward = this.forward;
      const ang = this.angVel;
      const pitchRate = Vector3.Dot(ang, right);
      const rollRate = Vector3.Dot(ang, forward);
      const damp = t.airDampTime > 0 ? 1 / Math.max(t.airDampTime, dt) : 0;
      const max = t.airMaxAccel;
      // +pitchRate = nose going down; forward.y > 0 = nose up.
      const pitchAccel = Math.max(-max, Math.min(max, t.airLevel * forward.y - damp * pitchRate));
      const rollAccel = Math.max(-max, Math.min(max, -t.airLevel * right.y - damp * rollRate));
      const ix = this.rig.inertia[0] * pitchAccel * dt;
      const iz = this.rig.inertia[2] * rollAccel * dt;
      this.chassisBody.applyAngularImpulse(this.tmpC.set(
        right.x * ix + forward.x * iz,
        right.y * ix + forward.y * iz,
        right.z * ix + forward.z * iz,
      ));
    }
  }

  private log(throttle: number, brake: number, stick: number): void {
    const g = globalThis as unknown as { __assistLog?: number[][] };
    const rows = (g.__assistLog ??= []);
    if (rows.length > 60000) return;
    const w = this.wheels;
    rows.push([
      this.instance, this.time, this.planarSpeed, this._forwardSpeed, this.bodySlip / RAD, this.angVel.y,
      throttle, brake, stick, this.steerAngle / RAD,
      w[0].load, w[1].load, w[2].load, w[3].load,
      this.targetFront, this.targetRear, this.contactFrontRaw, this.contactRearRaw,
      this.contactFront, this.contactRear, this.appliedFront, this.appliedRear, this.appliedYaw,
      w[2].rim, w[2].vLong, w[3].rim, w[3].vLong, this.rearSlip / RAD, this.frontTravel / RAD,
      w[0].rim, w[0].vLong, this.wheelStates[0].steerAngle / RAD, this.wheelStates[1].steerAngle / RAD,
      this.wheelStates[2].steerAngle / RAD, this.wheelStates[3].steerAngle / RAD, 0, 0,
      w[0].vLat, w[1].vLat, w[2].vLat, w[3].vLat, this.chassisMesh.position.x, this.chassisMesh.position.z,
      this.loadScale, this.normalTotal,
    ]);
  }

  // --- teleport ------------------------------------------------------------

  reset(groundPoint: Vector3, yaw: number): void {
    const q = Quaternion.FromEulerAngles(0, yaw, 0);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const cy = groundPoint.y + this.originHeight + 0.01;
    const place = (mesh: Mesh, body: PhysicsBody, lx: number, ly: number, lz: number) => {
      mesh.position.set(groundPoint.x + lx * cos + lz * sin, cy + ly, groundPoint.z - lx * sin + lz * cos);
      mesh.rotationQuaternion!.copyFrom(q);
      mesh.computeWorldMatrix(true);
      body.disablePreStep = false;
      body.setLinearVelocity(Vector3.ZeroReadOnly);
      body.setAngularVelocity(Vector3.ZeroReadOnly);
    };
    place(this.chassisMesh, this.chassisBody, 0, 0, 0);
    for (const w of this.wheels) {
      place(w.mesh, w.body, w.pivot.x, w.pivot.y + w.sag, w.pivot.z);
      w.load = 0;
      w.barForce = 0;
      w.steerTarget = 0;
      w.steerTrim = 0;
    }
    this.steerAngle = 0;
    this._forwardSpeed = 0;
    this._drivenRimSpeed = 0;
    this._reversing = false;
    this.brakeLatch = 0;
    this.reverseIntent = false;
    this.stillTime = 0;
    this.parked = false;
    this.clearAssistState();
    this.preStepFrames = 2;
    this.visual.reset();
  }

  setMotion(velocity: Vector3, yawRate: number): void {
    const origin = this.chassisMesh.position;
    const q = this.chassisMesh.rotationQuaternion!;
    basisFromQuaternion(q, this.right, this.up, this.forward);
    const forward = this.forward;
    const right = this.right;
    const v = new Vector3();
    // omega × r with omega = (0, yawRate, 0): (yawRate·rz, 0, −yawRate·rx).
    const pointVelocity = (p: Vector3): Vector3 =>
      v.set(velocity.x + yawRate * (p.z - origin.z), velocity.y, velocity.z - yawRate * (p.x - origin.x));
    const cl = this.comLocal;
    const com = new Vector3(
      origin.x + right.x * cl.x + this.up.x * cl.y + forward.x * cl.z,
      origin.y + right.y * cl.x + this.up.y * cl.y + forward.y * cl.z,
      origin.z + right.z * cl.x + this.up.z * cl.y + forward.z * cl.z,
    );
    this.chassisBody.setLinearVelocity(pointVelocity(com));
    this.chassisBody.setAngularVelocity(new Vector3(0, yawRate, 0));
    for (const w of this.wheels) {
      const wv = pointVelocity(w.mesh.position);
      w.body.setLinearVelocity(wv);
      // Rolling without slip for the forward component: spin about the axle.
      const spin = (DRIVE_SIGN * Vector3.Dot(wv, forward)) / w.radius;
      w.body.setAngularVelocity(new Vector3(right.x * spin, yawRate + right.y * spin, right.z * spin));
    }
    this.clearAssistState();
  }

  /** Forget everything measured across frames (after a teleport). */
  private clearAssistState(): void {
    this.momentumValid = false;
    this.contactFront = 0;
    this.contactRear = 0;
    this.contactFrontRaw = 0;
    this.contactRearRaw = 0;
    this.targetFront = 0;
    this.targetRear = 0;
    this.spinFront = 0;
    this.spinRear = 0;
    this.appliedFront = 0;
    this.appliedRear = 0;
    this.appliedYaw = 0;
    this.bodySlipRate = 0;
    this.slideHold = 0;
    this.compliance = 0;
    this.airTime = 0;
  }

  dispose(): void {
    for (const w of this.wheels) w.constraint.dispose();
    for (const aggregate of this.wheelAggregates) aggregate.dispose();
    this.chassisBody.dispose();
    this.chassisShape.dispose();
    for (const part of this.chassisParts) part.dispose();
    for (const w of this.wheels) w.mesh.dispose();
    this.chassisMesh.dispose();
  }
}

function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

/** World-space images of the local X, Y, Z axes of a unit quaternion. */
function basisFromQuaternion(q: Quaternion, x: Vector3, y: Vector3, z: Vector3): void {
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const yz = q.y * q.z;
  const wx = q.w * q.x;
  const wy = q.w * q.y;
  const wz = q.w * q.z;
  x.set(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy));
  y.set(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx));
  z.set(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy));
}

/** (r × v) · up for r = (rx, ry, rz). */
function tripleUp(rx: number, ry: number, rz: number, v: Vector3, up: Vector3): number {
  return (ry * v.z - rz * v.y) * up.x + (rz * v.x - rx * v.z) * up.y + (rx * v.y - ry * v.x) * up.z;
}

/**
 * How much of a target the measured force is missing (0 if it is not),
 * bounded by `addMax` and by the target itself: when the measured force
 * points the other way (transients, measurement noise) the assist must not
 * turn into a force that cancels the contact.
 */
function deficit(target: number, measured: number, addMax: number): number {
  if (target === 0) return 0;
  const sign = target > 0 ? 1 : -1;
  const along = (target - measured) * sign;
  return along > 0 ? sign * Math.min(along, addMax, target * sign) : 0;
}

/**
 * How much the measured force EXCEEDS the target, as a correction opposing
 * the measured force, bounded by `cutMax`. Never cuts below zero force.
 */
function surplus(target: number, measured: number, cutMax: number): number {
  if (measured === 0 || cutMax <= 0) return 0;
  const sign = measured > 0 ? 1 : -1;
  const allowed = Math.max(0, target * sign);
  const over = measured * sign - allowed;
  return over > 0 ? -sign * Math.min(over, cutMax) : 0;
}
