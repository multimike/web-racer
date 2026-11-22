import { Mesh, MeshBuilder, PhysicsAggregate, PhysicsBody, PhysicsShapeType, Quaternion, Vector3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../../input/types';
import type { TuningParam, Vehicle, WheelGroundState } from '../../car/Vehicle';
import type { VehicleRig } from '../../car/rig';
import { VehicleVisual } from '../../car/visual';
import type { VehicleModelDef } from '../../car/createVehicle';

/**
 * REFERENCE model — a textbook planar car with a known answer, used to
 * CALIBRATE THE HARNESS, not to be played:
 *
 *  - three degrees of freedom (x, z, yaw) on FLAT ground only: no suspension,
 *    no pitch/roll, no collisions with ramps/kerbs/terrain (those maneuvers
 *    are meaningless for it);
 *  - four tires with an isotropic friction-circle law: force = mu · N ·
 *    f(slip) along the slip velocity, f = sin(C·atan(B·slip)) — peaks at
 *    exactly 1 (so the car corners at exactly mu·g minus load-transfer
 *    effects) and falls to `slideGrip` when fully sliding (so it can drift);
 *  - quasi-static load transfer from the CoM height;
 *  - wheel spin integrated per wheel (rear drive, all-wheel brakes).
 *
 * Because every number in it is known in closed form, the lab's metrics can
 * be checked against hand physics on it: skidpad → mu·g, full-lock circle →
 * L/tan(delta), locked-wheel braking → v²/(2·slideGrip·mu·g). It also proves
 * the target bands are attainable and exercises the drift/recovery driver on
 * a car that really can slide.
 *
 * The planar dynamics are sub-stepped in JS (2 ms) and written into a Havok
 * body as velocities; Havok only integrates the pose.
 */

interface RefTuning {
  mu: number;
  /** f(inf): share of peak grip left when the tire is sliding outright. */
  slideGrip: number;
  /** Slip stiffness B (peak grip near slip = tan(pi/2C)/B ≈ 0.12). */
  slipStiffness: number;
  minTurnRadius: number;
  steerResponse: number;
  /** Peak thrust / weight at full throttle. */
  driveG: number;
  /** Peak brake force / weight (all four wheels together). */
  brakeG: number;
  maxSpeed: number;
  comHeight: number;
}

const DEFAULTS: RefTuning = {
  mu: 1.2,
  slideGrip: 0.8,
  slipStiffness: 12,
  minTurnRadius: 5,
  steerResponse: 12,
  driveG: 1.0,
  brakeG: 1.6,
  maxSpeed: 25,
  comHeight: 0,
};

const PARAMS: TuningParam[] = [
  { key: 'mu', label: 'tire grip', min: 0.3, max: 2.5, step: 0.05 },
  { key: 'slideGrip', label: 'sliding grip share', min: 0.4, max: 1, step: 0.05 },
  { key: 'slipStiffness', label: 'slip stiffness', min: 4, max: 30, step: 1 },
  { key: 'minTurnRadius', label: 'turn radius (m)', min: 2, max: 12, step: 0.25 },
  { key: 'driveG', label: 'thrust / weight', min: 0.2, max: 2, step: 0.05 },
  { key: 'brakeG', label: 'brake / weight', min: 0.5, max: 3, step: 0.1 },
  { key: 'maxSpeed', label: 'max speed', min: 5, max: 40, step: 1 },
  { key: 'comHeight', label: 'CoM height (m)', min: 0, max: 1, step: 0.02 },
];

const V0 = 2.5; // slip regularisation speed, m/s

export class ReferenceVehicle implements Vehicle {
  readonly modelName = 'reference';
  readonly rig: VehicleRig;
  readonly chassisMesh: Mesh;
  readonly chassisBody: PhysicsBody;
  readonly wheelStates: WheelGroundState[] = [];
  readonly visual: VehicleVisual;
  readonly tuningParams: readonly TuningParam[] = PARAMS;
  readonly tuning: RefTuning;

  private input: InputProvider;
  private aggregate: PhysicsAggregate;
  private gravity: number;
  private mass: number;
  private yawInertia: number;
  /** Total CoM along the car, rig space z. */
  private comZ: number;
  private originY: number;
  private spin = [0, 0, 0, 0];
  private steer = 0;
  private wheelSteer = [0, 0, 0, 0];
  private ax = 0;
  private ay = 0;
  private lin = new Vector3();
  private ang = new Vector3();
  private _forwardSpeed = 0;
  private _reversing = false;
  private preStepFrames = 0;

  constructor(scene: Scene, input: InputProvider, rig: VehicleRig) {
    this.input = input;
    this.rig = rig;
    this.gravity = scene.getPhysicsEngine()?.gravity.length() ?? 9.81;
    const unsprung = rig.wheels.reduce((sum, w) => sum + w.mass, 0);
    this.mass = rig.sprungMass + unsprung;
    this.comZ = (rig.sprungMass * rig.com[2] + rig.wheels.reduce((sum, w) => sum + w.mass * w.z, 0)) / this.mass;
    const comY = (rig.sprungMass * rig.com[1] + rig.wheels.reduce((sum, w) => sum + w.mass * w.y, 0)) / this.mass;
    this.tuning = { ...DEFAULTS, comHeight: comY };
    this.yawInertia =
      rig.inertia[1] +
      rig.sprungMass * (rig.com[2] - this.comZ) ** 2 +
      rig.wheels.reduce((sum, w) => sum + w.mass * (w.x * w.x + (w.z - this.comZ) ** 2), 0);

    const [w, h, d] = rig.hull.size;
    this.originY = rig.hull.center[1];
    const chassis = MeshBuilder.CreateBox('refCar', { width: w, height: h, depth: d }, scene);
    chassis.position.set(0, this.originY, 0);
    chassis.rotationQuaternion = Quaternion.Identity();
    chassis.isVisible = false;
    this.chassisMesh = chassis;
    this.aggregate = new PhysicsAggregate(chassis, PhysicsShapeType.BOX, { mass: this.mass, friction: 0, restitution: 0 }, scene);
    this.chassisBody = this.aggregate.body;
    this.chassisBody.setMassProperties({
      mass: this.mass,
      centerOfMass: new Vector3(0, 0, this.comZ),
      // Per unit mass (Havok convention); pitch/roll are held at zero anyway.
      inertia: new Vector3(this.yawInertia / this.mass, this.yawInertia / this.mass, this.yawInertia / this.mass),
    });
    // Planar: the body floats at ride height, velocities are written each frame.
    this.chassisBody.setGravityFactor(0);
    this.chassisBody.setLinearDamping(0);
    this.chassisBody.setAngularDamping(0);

    for (const wheel of rig.wheels) {
      this.wheelStates.push({
        position: new Vector3(wheel.x, wheel.y, wheel.z),
        velocity: new Vector3(),
        rollSpeed: 0,
        slipSpeed: 0,
        grounded: true,
        steerAngle: 0,
        spinSpeed: 0,
        radius: wheel.radius,
      });
    }
    this.visual = new VehicleVisual(scene, this.chassisMesh, { x: 0, y: -this.originY, z: 0 }, rig.wheels);
  }

  get forwardSpeed(): number {
    return this._forwardSpeed;
  }
  get drivenRimSpeed(): number {
    return ((this.spin[2] + this.spin[3]) / 2) * this.rig.rear.tireRadius;
  }
  get isReversing(): boolean {
    return this._reversing;
  }
  get currentSteerAngle(): number {
    return this.steer;
  }
  get maxSteerAngle(): number {
    return Math.atan(this.rig.wheelbase / this.tuning.minTurnRadius);
  }
  get wheelbase(): number {
    return this.rig.wheelbase;
  }
  get topSpeed(): number {
    return this.tuning.maxSpeed;
  }
  get nominalGrip(): number {
    return this.tuning.mu;
  }

  getTuning(key: string): number | undefined {
    const value = (this.tuning as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  }
  setTuning(key: string, value: number): boolean {
    if (this.getTuning(key) === undefined) return false;
    (this.tuning as unknown as Record<string, number>)[key] = value;
    return true;
  }

  update(dt: number): void {
    const t = this.tuning;
    const rig = this.rig;
    const intent = this.input.poll();
    if (this.preStepFrames > 0 && --this.preStepFrames === 0) this.chassisBody.disablePreStep = true;

    const body = this.chassisBody;
    body.getLinearVelocityToRef(this.lin);
    body.getAngularVelocityToRef(this.ang);
    const fwd = this.chassisMesh.forward;
    const yaw = Math.atan2(fwd.x, fwd.z);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Chassis-frame planar state of the CoM: u forward, v right, r yaw rate.
    let u = this.lin.x * sin + this.lin.z * cos;
    let v = this.lin.x * cos - this.lin.z * sin;
    let r = this.ang.y;

    // Steering with Ackermann geometry.
    const maxSteer = this.maxSteerAngle;
    const want = Math.max(-1, Math.min(1, intent.steering)) * maxSteer;
    const ds = t.steerResponse * dt;
    this.steer += Math.max(-ds, Math.min(ds, want - this.steer));
    const tan = Math.tan(this.steer);
    for (let i = 0; i < 4; i++) {
      const w = rig.wheels[i];
      this.wheelSteer[i] = w.steered ? Math.atan((rig.wheelbase * tan) / (rig.wheelbase - w.x * tan)) : 0;
    }

    // Pedals (same arcade scheme as the game: brake at rest = reverse).
    const reversing = intent.brake > 0.01 && u < 0.5 && intent.throttle <= 0.01;
    const braking = intent.brake > 0.01 && !reversing;
    this._reversing = reversing;
    const drive = reversing ? -intent.brake : braking ? 0 : intent.throttle;
    const weight = this.mass * this.gravity;
    const driven = rig.wheels.filter((w) => w.driven).length;

    const C = Math.max(1.0001, 2 - (2 / Math.PI) * Math.asin(Math.min(1, t.slideGrip)));
    const B = t.slipStiffness;
    const h = dt / Math.max(1, Math.ceil(dt / 0.002));
    const steps = Math.round(dt / h);
    const hCom = t.comHeight;
    const track = (rig.front.track + rig.rear.track) / 2;
    const a = rig.front.z - this.comZ; // CoM → front axle
    const b = this.comZ - rig.rear.z; // CoM → rear axle
    let sumAx = 0;
    let sumAy = 0;
    let turned = 0;
    const slipOut = [0, 0, 0, 0];

    for (let step = 0; step < steps; step++) {
      // Quasi-static wheel loads from the (filtered) accelerations.
      const dLong = (this.mass * this.ax * hCom) / rig.wheelbase / 2;
      const dLat = (this.mass * this.ay * hCom) / track / 2;
      let fx = 0;
      let fy = 0;
      let mz = 0;
      for (let i = 0; i < 4; i++) {
        const w = rig.wheels[i];
        const front = w.axle === 'front';
        const stat = (weight * (front ? b : a)) / rig.wheelbase / 2;
        // Accelerating forward loads the rear; turning right (ay > 0) loads the left.
        const N = Math.max(0, stat + (front ? -dLong : dLong) - w.side * dLat);
        const px = w.x;
        const pz = w.z - this.comZ;
        // Contact-point velocity in the chassis frame, then the wheel frame.
        const cu = u - r * px;
        const cv = v + r * pz;
        const sd = Math.sin(this.wheelSteer[i]);
        const cd = Math.cos(this.wheelSteer[i]);
        const wu = cu * cd + cv * sd;
        const wv = -cu * sd + cv * cd;
        const rim = this.spin[i] * w.radius;
        // Slip velocity = direction the tire pushes the car.
        const sx = rim - wu;
        const sy = -wv;
        const slipSpeed = Math.hypot(sx, sy);
        const ref = Math.max(Math.abs(wu), Math.abs(rim), V0);
        const sigma = slipSpeed / ref;
        const grip = t.mu * N * Math.sin(C * Math.atan(B * sigma));
        const tx = slipSpeed > 1e-6 ? (grip * sx) / slipSpeed : 0;
        const ty = slipSpeed > 1e-6 ? (grip * sy) / slipSpeed : 0;
        slipOut[i] = slipSpeed;

        // Wheel spin: drive / brake / rolling drag against the tire reaction,
        // implicit in the tire's (maximum) slip stiffness for stability.
        const inertia = (front ? rig.front : rig.rear).wheelSpinInertia;
        let torque = -tx * w.radius;
        if (w.driven && Math.abs(drive) > 0.01) {
          const cap = drive > 0 ? t.maxSpeed : t.maxSpeed * 0.5;
          const taper = Math.max(0, Math.min(1, (cap - Math.abs(rim)) / (0.08 * cap)));
          torque += (Math.sign(drive) * Math.abs(drive) * t.driveG * weight * w.radius * taper) / driven;
        }
        const stiffness = (t.mu * N * B * C) / ref;
        let spin = this.spin[i] + (h * torque) / (inertia + h * stiffness * w.radius * w.radius);
        const resist = (braking ? (intent.brake * t.brakeG * weight * w.radius) / 4 : 0) + 0.015 * N * w.radius;
        const dSpin = (h * resist) / inertia;
        // Brakes and rolling drag can stop a wheel but never reverse it.
        spin = Math.abs(spin) <= dSpin ? 0 : spin - Math.sign(spin) * dSpin;
        this.spin[i] = spin;

        // Tire force back in the chassis frame.
        const cx = tx * cd - ty * sd;
        const cy = tx * sd + ty * cd;
        fx += cx;
        fy += cy;
        mz += pz * cy - px * cx;
      }
      // Planar rigid body in a rotating frame.
      const axBody = fx / this.mass;
      const ayBody = fy / this.mass;
      u += (axBody + r * v) * h;
      v += (ayBody - r * u) * h;
      r += (mz / this.yawInertia) * h;
      turned += r * h;
      sumAx += axBody;
      sumAy += ayBody;
    }
    const k = Math.min(1, dt / 0.05);
    this.ax += (sumAx / steps - this.ax) * k;
    this.ay += (sumAy / steps - this.ay) * k;

    this._forwardSpeed = u;
    // (u, v) live in the chassis frame, which has turned by `turned` during
    // the sub-steps; Havok turns the body by the same angle in its own step,
    // so the world velocity must be expressed with the END-of-frame heading.
    // (Using the start heading double-counts the rotating-frame terms and
    // halves the cornering force — caught by the skidpad known-answer check.)
    const sinE = Math.sin(yaw + turned);
    const cosE = Math.cos(yaw + turned);
    this.lin.set(u * sinE + v * cosE, 0, u * cosE - v * sinE);
    this.ang.set(0, r, 0);
    body.setLinearVelocity(this.lin);
    body.setAngularVelocity(this.ang);

    const matrix = this.chassisMesh.getWorldMatrix();
    for (let i = 0; i < 4; i++) {
      const w = rig.wheels[i];
      const state = this.wheelStates[i];
      Vector3.TransformCoordinatesFromFloatsToRef(w.x, w.y - this.originY, w.z, matrix, state.position);
      const px = w.x;
      const pz = w.z - this.comZ;
      const cu = u - r * px;
      const cv = v + r * pz;
      state.velocity.set(cu * sin + cv * cos, 0, cu * cos - cv * sin);
      state.rollSpeed = Math.abs(cu * Math.cos(this.wheelSteer[i]) + cv * Math.sin(this.wheelSteer[i]));
      state.slipSpeed = slipOut[i];
      state.steerAngle = this.wheelSteer[i];
      state.spinSpeed = this.spin[i];
    }
    this.visual.capture(this.wheelStates, dt, intent, this.currentSteerAngle, this.isReversing);
  }

  reset(groundPoint: Vector3, yaw: number): void {
    const mesh = this.chassisMesh;
    mesh.position.set(groundPoint.x, groundPoint.y + this.originY, groundPoint.z);
    mesh.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0);
    mesh.computeWorldMatrix(true);
    this.chassisBody.disablePreStep = false;
    this.chassisBody.setLinearVelocity(Vector3.ZeroReadOnly);
    this.chassisBody.setAngularVelocity(Vector3.ZeroReadOnly);
    this.preStepFrames = 2;
    this.spin.fill(0);
    this.steer = 0;
    this.ax = 0;
    this.ay = 0;
    this._forwardSpeed = 0;
    this._reversing = false;
    this.visual.reset();
  }

  setMotion(velocity: Vector3, yawRate: number): void {
    const fwd = this.chassisMesh.forward;
    // CoM sits comZ ahead of the origin: v_com = v + omega × r.
    const cx = fwd.x * this.comZ;
    const cz = fwd.z * this.comZ;
    this.chassisBody.setLinearVelocity(new Vector3(velocity.x + yawRate * cz, 0, velocity.z - yawRate * cx));
    this.chassisBody.setAngularVelocity(new Vector3(0, yawRate, 0));
    const forward = velocity.x * fwd.x + velocity.z * fwd.z;
    for (let i = 0; i < 4; i++) this.spin[i] = forward / this.rig.wheels[i].radius;
  }

  dispose(): void {
    this.aggregate.dispose();
    this.chassisMesh.dispose();
  }
}

export const referenceModel: VehicleModelDef = {
  name: 'reference',
  description: 'HARNESS CALIBRATION: planar 3-DOF car with friction-circle tires (flat ground only)',
  create: ({ scene, input, rig }) => {
    if (!rig) throw new Error("model 'reference' needs a rig (use any car except rb01 with model=rigid)");
    return new ReferenceVehicle(scene, input, rig);
  },
};
