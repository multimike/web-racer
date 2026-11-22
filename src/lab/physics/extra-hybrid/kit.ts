/**
 * Helpers for the hybrid break tests (this folder only; nothing here is
 * imported by the shared harness).
 *
 *  - rigidMove / airPose: put the whole car (every dynamic body) into an
 *    arbitrary pose — rolled, pitched, lifted, on a tilted slab — which
 *    Sim.place() cannot do (it only teleports upright onto the base ground).
 *  - addSlab: static box (walls, tilted ground).
 *  - Extremes: per-step NaN / explosion watch.
 *  - StickPlayer: a delayed, rate-limited thumb for hand-written control laws.
 *  - analyzeSlide: recovery time / overshoots / counter-swing of a slide.
 *  - runVar: advance a Sim with a different dt every step (hitch, jitter).
 */
import {
  MeshBuilder,
  PhysicsAggregate,
  PhysicsMotionType,
  PhysicsShapeType,
  Quaternion,
  Vector3,
} from '@babylonjs/core';
import type { AbstractMesh, Mesh } from '@babylonjs/core';
import { ActuationLimiter } from '../../../car/DriverModel';
import type { CarIntent } from '../../../input/types';
import { DEG, RAD } from '../sim';
import type { Sim, Telemetry } from '../sim';
import type { MetricValue } from '../types';

/** Every dynamic body of the scene = the car (chassis + wheels). */
export function carBodies(sim: Sim): AbstractMesh[] {
  return sim.world.scene.meshes.filter(
    (m) => m.physicsBody && m.physicsBody.getMotionType() === PhysicsMotionType.DYNAMIC,
  );
}

/**
 * Rigidly rotate the whole car by `rot` (world frame) about `pivot`, then
 * translate by `shift`. Call right after sim.place() (the vehicle's reset()
 * leaves the pre-step transform copy on for the next two steps) or pass
 * `own = true` to manage disablePreStep here (teleport WITHOUT reset()).
 */
export function rigidMove(sim: Sim, rot: Quaternion, pivot: Vector3, shift: Vector3, own = false): void {
  const rel = new Vector3();
  const turned = new Vector3();
  for (const m of carBodies(sim)) {
    m.position.subtractToRef(pivot, rel);
    rel.rotateByQuaternionToRef(rot, turned);
    m.position.copyFrom(pivot).addInPlace(turned).addInPlace(shift);
    m.rotationQuaternion = rot.multiply(m.rotationQuaternion ?? Quaternion.Identity());
    m.physicsBody!.disablePreStep = false;
    m.computeWorldMatrix(true);
  }
  if (own) {
    // Restore after the next physics step has consumed the transforms.
    let frames = 2;
    const scene = sim.world.scene;
    const obs = scene.onAfterPhysicsObservable.add(() => {
      if (--frames > 0) return;
      for (const m of carBodies(sim)) m.physicsBody!.disablePreStep = true;
      scene.onAfterPhysicsObservable.remove(obs);
    });
  }
}

/**
 * Car in the air: placed at (0, 0) heading `yawDeg`, then rolled/pitched
 * about its own axes, lifted by `height` and launched with planar velocity
 * `speed` along +z (so yawDeg is also the slide angle at touchdown) plus
 * vertical velocity `vy` and yaw rate `yawRate`.
 */
export function airPose(
  sim: Sim,
  o: { height: number; speed: number; yawDeg?: number; rollDeg?: number; pitchDeg?: number; yawRate?: number; vy?: number },
): void {
  const yaw = (o.yawDeg ?? 0) * RAD;
  sim.place({ x: 0, z: 0, yaw });
  const chassis = sim.vehicle.chassisMesh;
  const pivot = chassis.position.clone();
  const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  // + roll = right side down, + pitch = nose up (Telemetry conventions; the
  // resulting angles are read back and reported, so a sign slip would show).
  const roll = Quaternion.RotationAxis(fwd, -(o.rollDeg ?? 0) * RAD);
  const pitch = Quaternion.RotationAxis(right, -(o.pitchDeg ?? 0) * RAD);
  rigidMove(sim, roll.multiply(pitch), pivot, new Vector3(0, o.height, 0));
  sim.vehicle.setMotion(new Vector3(0, o.vy ?? 0, o.speed), o.yawRate ?? 0);
}

/** Static box. `rot` rotates it (and its centre) about the world origin. */
export function addSlab(
  sim: Sim,
  name: string,
  center: Vector3,
  size: Vector3,
  rot: Quaternion | null = null,
  friction = 1.0,
): Mesh {
  const scene = sim.world.scene;
  const box = MeshBuilder.CreateBox(`lab${name}`, { width: size.x, height: size.y, depth: size.z }, scene);
  if (rot) {
    const c = new Vector3();
    center.rotateByQuaternionToRef(rot, c);
    box.position.copyFrom(c);
    box.rotationQuaternion = rot.clone();
  } else {
    box.position.copyFrom(center);
  }
  box.isVisible = sim.env.watch;
  new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0 }, scene);
  return box;
}

/** NaN / explosion watch. Call sample() after every step. */
export class Extremes {
  finite = true;
  maxSpeed = 0;
  maxAngVel = 0;
  maxWheelSpin = 0;
  maxHubDistance = 0;
  minY = Infinity;
  maxY = -Infinity;
  private lin = new Vector3();
  private ang = new Vector3();
  private bodies: AbstractMesh[];
  private chassis: AbstractMesh;

  constructor(sim: Sim) {
    this.bodies = carBodies(sim);
    this.chassis = sim.vehicle.chassisMesh;
  }

  sample(): void {
    const c = this.chassis.position;
    for (const m of this.bodies) {
      const body = m.physicsBody!;
      body.getLinearVelocityToRef(this.lin);
      body.getAngularVelocityToRef(this.ang);
      const p = m.position;
      const q = m.rotationQuaternion;
      const sum = p.x + p.y + p.z + this.lin.x + this.lin.y + this.lin.z + this.ang.x + this.ang.y + this.ang.z +
        (q ? q.x + q.y + q.z + q.w : 0);
      if (!Number.isFinite(sum)) {
        this.finite = false;
        continue;
      }
      if (m === this.chassis) {
        this.maxSpeed = Math.max(this.maxSpeed, this.lin.length());
        this.maxAngVel = Math.max(this.maxAngVel, this.ang.length());
        this.minY = Math.min(this.minY, p.y);
        this.maxY = Math.max(this.maxY, p.y);
      } else {
        this.maxWheelSpin = Math.max(this.maxWheelSpin, this.ang.length());
        this.maxHubDistance = Math.max(this.maxHubDistance, Vector3.Distance(p, c));
      }
    }
  }

  metrics(): Record<string, MetricValue> {
    return {
      finite: this.finite,
      maxSpeed3D: this.maxSpeed,
      maxChassisAngVel: this.maxAngVel,
      maxWheelAngVel: this.maxWheelSpin,
      maxHubDistance: this.maxHubDistance,
      maxY: this.maxY,
      minY: this.minY,
    };
  }
}

/** A thumb with a reaction delay and the lab's standard stick/trigger ramps. */
export class StickPlayer {
  readonly hands = new ActuationLimiter(0.12, 0.1);
  private queue: Array<{ t: number; steering: number; throttle: number; brake: number }> = [];
  private held: CarIntent;
  private delay: number;

  constructor(delay: number, start: CarIntent) {
    this.delay = delay;
    this.held = { ...start };
    this.hands.set(start);
  }

  /** Feed the decision made at time `t`; returns what the hands do now. */
  push(t: number, want: CarIntent, dt: number): CarIntent {
    this.queue.push({ t, steering: want.steering, throttle: want.throttle, brake: want.brake });
    const at = t - this.delay;
    while (this.queue.length > 1 && this.queue[1].t <= at + 1e-9) this.queue.shift();
    const a = this.queue[0];
    if (a.t <= at + 1e-9) {
      this.held.steering = a.steering;
      this.held.throttle = a.throttle;
      this.held.brake = a.brake;
    }
    return { ...this.hands.apply(this.held, dt) };
  }
}

/**
 * Judge a slide from per-step logs (beta, yaw rate; rad). The slide's own
 * side is the sign of the first |beta| > 5°. Recovered = |beta| < 5° and
 * |yaw rate| < 10°/s held for 0.5 s (same definition as the lab).
 */
export function analyzeSlide(dt: number, betas: number[], rates: number[]): Record<string, MetricValue> {
  const hold = Math.round(0.5 / dt);
  let recovery: number | null = null;
  let calm = 0;
  for (let i = 0; i < betas.length; i++) {
    if (Math.abs(betas[i]) < 5 * RAD && Math.abs(rates[i]) < 10 * RAD) {
      if (++calm >= hold) {
        recovery = (i + 1 - hold + 1) * dt;
        break;
      }
    } else {
      calm = 0;
    }
  }
  let side = 0;
  for (const b of betas) {
    if (Math.abs(b) > 5 * RAD) {
      side = Math.sign(b);
      break;
    }
  }
  const judged = recovery === null ? betas.length : Math.min(betas.length, Math.round((recovery + 0.5) / dt));
  let overshoots = 0;
  let cur = side;
  let counter = 0;
  let peak = 0;
  let spun = false;
  let spinTime: number | null = null;
  for (let i = 0; i < judged; i++) {
    const b = betas[i];
    if (Math.abs(b) > peak) peak = Math.abs(b);
    if (Math.abs(b) > Math.PI / 2 && !spun) {
      spun = true;
      spinTime = (i + 1) * dt;
    }
    if (side !== 0 && b * side < 0 && Math.abs(b) > counter) counter = Math.abs(b);
    if (cur !== 0 && b * cur < -5 * RAD) {
      overshoots++;
      cur = -cur;
    }
  }
  return {
    recovered: recovery !== null && !spun,
    recoveryTime: spun ? null : recovery,
    overshoots,
    counterSwingDeg: counter * DEG,
    peakBetaDeg: peak * DEG,
    spun,
    spinTime,
  };
}

/** Advance `seconds` with a per-step dt from `dtOf(stepIndex)`. */
export function runVar(
  sim: Sim,
  seconds: number,
  dtOf: (i: number) => number,
  onStep?: (tel: Telemetry, dt: number) => boolean | void,
): void {
  const s = sim as unknown as { dt: number };
  const original = s.dt;
  const tEnd = sim.time + seconds;
  for (let i = 0; sim.time < tEnd - 1e-9; i++) {
    const dt = dtOf(i);
    s.dt = dt;
    sim.step();
    if (onStep && onStep(sim.tel, dt) === true) break;
  }
  s.dt = original;
}

/** Deterministic dt jitter: uniform in [lo, hi] from a 32-bit LCG. */
export function jitterDt(lo: number, hi: number, seed = 12345): (i: number) => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return lo + (hi - lo) * (state / 4294967296);
  };
}

/** Not rolled over and within 25° of level right now. */
export function upright(sim: Sim): boolean {
  return !sim.track.rolledOver && sim.tel.tilt < 25 * RAD;
}
