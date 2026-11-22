import {
  Matrix,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsMotionType,
  PhysicsShapeType,
  Quaternion,
  Vector3,
} from '@babylonjs/core';
import type { TransformNode } from '@babylonjs/core';
import type { CarIntent } from '../../../input/types';
import { ActuationLimiter } from '../../../car/DriverModel';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim, Telemetry } from '../sim';
import type { MetricValue } from '../types';

/**
 * Shared tools of the break tests (extra-assist). Everything here works
 * through the public `Vehicle` interface plus the scene's dynamic bodies —
 * no model internals — so the same tests run on any vehicle model.
 */

/** Every node of the scene that carries a DYNAMIC body (chassis + wheels). */
export function dynamicNodes(sim: Sim): TransformNode[] {
  const scene = sim.world.scene;
  const out: TransformNode[] = [];
  for (const node of scene.transformNodes.concat(scene.meshes)) {
    if (node.physicsBody && node.physicsBody.getMotionType() === PhysicsMotionType.DYNAMIC) out.push(node);
  }
  return out;
}

/**
 * Rigidly rotate the whole car (all dynamic bodies) about `pivot`.
 * MUST be called right after `sim.place()` (the models' reset leaves the
 * bodies in pre-step-copy mode for the next step, so mesh transforms written
 * here are what Havok starts from). Velocities are left as they are.
 */
export function rotateCar(sim: Sim, axis: Vector3, angle: number, pivot: Vector3): void {
  const m = Matrix.RotationAxis(axis.normalizeToNew(), angle);
  const rot = new Matrix();
  for (const node of dynamicNodes(sim)) {
    const rel = node.position.subtract(pivot);
    node.position.copyFrom(Vector3.TransformNormal(rel, m).addInPlace(pivot));
    Matrix.FromQuaternionToRef(node.rotationQuaternion!, rot);
    node.rotationQuaternion!.copyFrom(Quaternion.FromRotationMatrix(rot.multiply(m)));
    node.computeWorldMatrix(true);
  }
}

/** Rotate the car about `pivot` so that its up axis becomes `normal`. */
export function alignUp(sim: Sim, normal: Vector3, pivot: Vector3): void {
  const up = sim.vehicle.chassisMesh.up.clone();
  const n = normal.normalizeToNew();
  const axis = Vector3.Cross(up, n);
  const sinA = axis.length();
  if (sinA < 1e-6) return;
  let angle = Math.atan2(sinA, Vector3.Dot(up, n));
  // Convention-proof: check which sign of the angle really maps up → n.
  const test = Vector3.TransformNormal(up, Matrix.RotationAxis(axis.normalizeToNew(), angle));
  if (Vector3.Dot(test, n) < 0.9999) angle = -angle;
  rotateCar(sim, axis, angle, pivot);
}

/** Translate the whole car (call right after sim.place, like rotateCar). */
export function moveCar(sim: Sim, dx: number, dy: number, dz: number): void {
  for (const node of dynamicNodes(sim)) {
    node.position.addInPlaceFromFloats(dx, dy, dz);
    node.computeWorldMatrix(true);
  }
}

/** Impose one rigid-body motion on chassis + wheels (wheels do not roll). */
export function setRigidMotion(sim: Sim, linear: Vector3, angular: Vector3): void {
  const origin = sim.vehicle.chassisMesh.position;
  for (const node of dynamicNodes(sim)) {
    const r = node.position.subtract(origin);
    node.physicsBody!.setLinearVelocity(linear.add(Vector3.Cross(angular, r)));
    node.physicsBody!.setAngularVelocity(angular);
  }
}

/** Static box (wall, bank, step). */
export function addStaticBox(
  sim: Sim,
  o: { center: [number, number, number]; size: [number, number, number]; yaw?: number; friction?: number },
): void {
  const scene = sim.world.scene;
  const box = MeshBuilder.CreateBox('labExtraBox', { width: o.size[0], height: o.size[1], depth: o.size[2] }, scene);
  box.position.set(o.center[0], o.center[1], o.center[2]);
  box.rotationQuaternion = Quaternion.FromEulerAngles(0, o.yaw ?? 0, 0);
  box.isVisible = sim.env.watch;
  new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0, friction: o.friction ?? 1.0, restitution: 0 }, scene);
}

/** Height of the top face of the lab's 'ramp' obstacle, `d` metres past its
 * entry edge measured horizontally along its yaw (0.5 m slab, see world.ts). */
export function rampHeight(angleDeg: number, d: number): number {
  const a = angleDeg * RAD;
  return Math.tan(a) * d + 0.25 * Math.sin(a) * Math.tan(a);
}

/** Change the fixed step of a running Sim (frame hitch / jitter tests). */
export function setDt(sim: Sim, dt: number): void {
  (sim as unknown as { dt: number }).dt = dt;
}

/** Deterministic PRNG (mulberry32), 0..1. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Watches for "physics went wrong": NaNs, bodies shooting off, the wheels
 * leaving their hubs. Construct after the car has been placed; call
 * `watch()` once per step.
 */
export class Health {
  nan = false;
  /** Peak 3-D chassis speed, m/s, and peak angular speed, rad/s. */
  maxSpeed = 0;
  maxAngVel = 0;
  maxVy = 0;
  maxY = -Infinity;
  minY = Infinity;
  /** Largest in-plane (chassis x/z) displacement of a wheel centre from
   * where it sat at construction, m — the hub constraint being stretched. */
  maxHubShift = 0;
  /** Extremes of wheel travel along the chassis up axis vs construction, m. */
  maxBump = 0;
  maxDroop = 0;
  private sim: Sim;
  private nodes: TransformNode[];
  private wheels: TransformNode[];
  private base: Array<[number, number, number]> = [];
  private lin = new Vector3();
  private ang = new Vector3();

  constructor(sim: Sim) {
    this.sim = sim;
    this.nodes = dynamicNodes(sim);
    // The wheel BODIES (WheelGroundState.position is a per-update copy that
    // lags the chassis by one step — useless for a 1 cm measurement).
    this.wheels = this.nodes.filter((n) => n !== sim.vehicle.chassisMesh);
    for (let i = 0; i < this.wheels.length; i++) this.base.push(this.hubLocal(i));
  }

  private hubLocal(i: number): [number, number, number] {
    const mesh = this.sim.vehicle.chassisMesh;
    const rel = this.wheels[i].position.subtract(mesh.position);
    return [Vector3.Dot(rel, mesh.right), Vector3.Dot(rel, mesh.up), Vector3.Dot(rel, mesh.forward)];
  }

  watch(): void {
    for (const node of this.nodes) {
      const p = node.position;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) this.nan = true;
      const q = node.rotationQuaternion!;
      if (!Number.isFinite(q.x + q.y + q.z + q.w)) this.nan = true;
    }
    const body = this.sim.vehicle.chassisBody;
    body.getLinearVelocityToRef(this.lin);
    body.getAngularVelocityToRef(this.ang);
    const speed = this.lin.length();
    const spin = this.ang.length();
    if (!Number.isFinite(speed) || !Number.isFinite(spin)) this.nan = true;
    if (speed > this.maxSpeed) this.maxSpeed = speed;
    if (spin > this.maxAngVel) this.maxAngVel = spin;
    if (Math.abs(this.lin.y) > this.maxVy) this.maxVy = Math.abs(this.lin.y);
    const y = this.sim.vehicle.chassisMesh.position.y;
    if (y > this.maxY) this.maxY = y;
    if (y < this.minY) this.minY = y;
    for (let i = 0; i < this.wheels.length; i++) {
      const [x, up, z] = this.hubLocal(i);
      const b = this.base[i];
      const shift = Math.hypot(x - b[0], z - b[2]);
      if (shift > this.maxHubShift) this.maxHubShift = shift;
      if (up - b[1] > this.maxBump) this.maxBump = up - b[1];
      if (b[1] - up > this.maxDroop) this.maxDroop = b[1] - up;
    }
  }

  /** Largest in-plane hub displacement right now (is the stretch permanent?). */
  hubShiftNow(): number {
    let worst = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const [x, , z] = this.hubLocal(i);
      worst = Math.max(worst, Math.hypot(x - this.base[i][0], z - this.base[i][2]));
    }
    return worst;
  }

  metrics(prefix = ''): Record<string, MetricValue> {
    return {
      [`${prefix}nan`]: this.nan,
      [`${prefix}maxSpeed3d`]: this.maxSpeed,
      [`${prefix}maxAngVel`]: this.maxAngVel,
      [`${prefix}maxVy`]: this.maxVy,
      [`${prefix}maxY`]: this.maxY,
      [`${prefix}minY`]: this.minY,
      [`${prefix}maxHubShift`]: this.maxHubShift,
      [`${prefix}hubShiftEnd`]: this.hubShiftNow(),
      [`${prefix}maxBump`]: this.maxBump,
      [`${prefix}maxDroop`]: this.maxDroop,
    };
  }
}

/**
 * Run with a per-step control law instead of a script or DriverModel.
 * `control(tel, t)` returns the stick/trigger TARGETS (t = seconds since the
 * call); they pass through the same human ramps as ScriptedInput (0.12 s
 * centre → lock, 0.1 s triggers). `onStep` may return true to stop early.
 */
export async function driveWith(
  sim: Sim,
  seconds: number,
  control: (tel: Telemetry, t: number) => Partial<CarIntent>,
  onStep?: (tel: Telemetry, t: number) => boolean | void,
  steerTime = 0.12,
  pedalTime = 0.1,
): Promise<boolean> {
  const hands = new ActuationLimiter(steerTime, pedalTime);
  hands.set(sim.intent);
  const t0 = sim.time;
  const target: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  const apply = () => {
    Object.assign(target, { throttle: 0, steering: 0, brake: 0 }, control(sim.tel, sim.time - t0));
    sim.useFixed({ ...hands.apply(target, sim.dt) });
  };
  apply();
  return sim.run(seconds, (tel) => {
    const stop = onStep?.(tel, sim.time - t0) === true;
    apply();
    return stop;
  });
}

/**
 * Same judgement as the lab's slideRecovery (sliding.ts, analyzeRecovery —
 * not exported there, so reproduced): per-step logs starting at slide onset
 * with beta < 0. Recovered = first moment from which |beta| < 5° and
 * |yaw rate| < 10°/s hold for 0.5 s; overshoot = swing past 5° on the far
 * side; spun = |beta| > 90° before the catch (+0.5 s).
 */
export function analyzeRecovery(
  dt: number,
  betas: number[],
  rates: number[],
  yaws: number[],
  course0: number,
): Record<string, MetricValue> {
  const hold = Math.round(0.5 / dt);
  let recovery: number | null = null;
  let headingAtRecovery: number | null = null;
  let calm = 0;
  for (let i = 0; i < betas.length; i++) {
    if (Math.abs(betas[i]) < 5 * RAD && Math.abs(rates[i]) < 10 * RAD) {
      if (++calm >= hold) {
        recovery = (i + 1 - hold + 1) * dt;
        headingAtRecovery = (yaws[i + 1 - hold] - course0) * DEG;
        break;
      }
    } else {
      calm = 0;
    }
  }
  const judged = recovery === null ? betas.length : Math.min(betas.length, Math.round((recovery + 0.5) / dt));
  let overshoots = 0;
  let side = -1;
  let counterSwing = 0;
  let peak = 0;
  let spun = false;
  for (let i = 0; i < judged; i++) {
    const b = betas[i];
    if (Math.abs(b) > peak) peak = Math.abs(b);
    if (Math.abs(b) > Math.PI / 2) spun = true;
    if (b > 0 && b > counterSwing) counterSwing = b;
    if (b * side < -5 * RAD) {
      overshoots++;
      side = -side;
    }
  }
  return {
    peakBetaDeg: peak * DEG,
    recovered: recovery !== null && !spun,
    recoveryTime: spun ? null : recovery,
    overshoots,
    counterSwingDeg: counterSwing * DEG,
    spun,
    headingAtRecoveryDeg: spun ? null : headingAtRecovery,
    finalHeadingErrorDeg: (yaws[yaws.length - 1] - course0) * DEG,
  };
}

/** A LabEnv that differs only in tuning / driver overrides (A/B inside one run). */
export function envWith(env: LabEnv, o: { tune?: Record<string, number>; driver?: LabEnv['driverTune'] }): LabEnv {
  return {
    ...env,
    tune: { ...env.tune, ...(o.tune ?? {}) },
    driverTune: { ...env.driverTune, ...(o.driver ?? {}) },
  };
}

/** Time until the car is calm (|beta| < 5°, |yaw rate| < 10°/s for 0.5 s),
 * running at most `seconds`; null if it never calms down. */
export async function timeToCalm(sim: Sim, seconds: number): Promise<number | null> {
  let calm = 0;
  const t0 = sim.time;
  let at: number | null = null;
  await sim.run(seconds, (tel) => {
    if (Math.abs(tel.beta) < 5 * RAD && Math.abs(tel.yawRate) < 10 * RAD) {
      calm += sim.dt;
      if (calm >= 0.5) {
        at = tel.t - t0 - 0.5;
        return true;
      }
    } else {
      calm = 0;
    }
    return false;
  });
  return at;
}
