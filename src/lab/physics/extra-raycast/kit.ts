/**
 * Shared helpers of the raycast break tests (this folder only).
 *
 * Everything here goes through the PUBLIC surface of the harness (Sim,
 * Vehicle, LabWorld) — no shared harness file is edited. Two things the
 * standard Sim does not offer are added from the outside:
 *   - `placePose`: put the car anywhere in the air / on a slope, with any
 *     attitude and any linear + angular velocity (Sim.place is upright only);
 *   - `stepWith`: take ONE step with a different dt (frame hitches, mixed
 *     frame lengths) by swapping Sim.dt for that step.
 */
import { MeshBuilder, PhysicsAggregate, PhysicsShapeType, Quaternion, Vector3 } from '@babylonjs/core';
import { DEG, RAD } from '../sim';
import type { Sim } from '../sim';
import type { MetricValue } from '../types';

export interface Pose {
  x: number;
  z: number;
  /** Height of the mesh origin ABOVE its rest height on flat ground, m. */
  lift?: number;
  yaw?: number;
  /** Babylon yaw-pitch-roll angles, rad. pitch > 0 = nose DOWN,
   * roll > 0 = left side down (right side up). */
  pitch?: number;
  roll?: number;
  /** World velocity, m/s. */
  vx?: number;
  vy?: number;
  vz?: number;
  /** World angular velocity, rad/s. */
  wx?: number;
  wy?: number;
  wz?: number;
}

const tmpAng = new Vector3();
const tmpLin = new Vector3();

/** Teleport the car to an arbitrary pose + motion (see Pose). */
export function placePose(sim: Sim, o: Pose): void {
  const yaw = o.yaw ?? 0;
  sim.place({ x: o.x, z: o.z, yaw });
  const mesh = sim.vehicle.chassisMesh;
  mesh.position.y += o.lift ?? 0;
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
  Quaternion.RotationYawPitchRollToRef(yaw, o.pitch ?? 0, o.roll ?? 0, mesh.rotationQuaternion);
  mesh.computeWorldMatrix(true);
  const v = new Vector3(o.vx ?? 0, o.vy ?? 0, o.vz ?? 0);
  sim.vehicle.setMotion(v, 0);
  sim.vehicle.chassisBody.setLinearVelocity(v);
  sim.vehicle.chassisBody.setAngularVelocity(new Vector3(o.wx ?? 0, o.wy ?? 0, o.wz ?? 0));
}

/**
 * Put the car on the top face of a lab 'ramp' obstacle (see world.ts
 * buildRamp: entry edge at (rampX, rampZ), rising along rampYaw).
 * `along` = horizontal distance up the slope from the entry edge, `across` =
 * distance to the right of the rise direction. `heading` is the car's yaw.
 */
export function placeOnRamp(
  sim: Sim,
  ramp: { x: number; z: number; yaw: number; angleDeg: number },
  along: number,
  across: number,
  heading: number,
  speed = 0,
): void {
  const a = ramp.angleDeg * RAD;
  const sin = Math.sin(ramp.yaw);
  const cos = Math.cos(ramp.yaw);
  // Slope normal and the surface point (0.5 m slab, see buildRamp).
  const n = new Vector3(-Math.sin(a) * sin, Math.cos(a), -Math.sin(a) * cos);
  const height = (along + 0.25 * Math.sin(a)) * Math.tan(a);
  const px = ramp.x + sin * along + cos * across;
  const pz = ramp.z + cos * along - sin * across;
  sim.place({ x: px, z: pz, yaw: heading });
  const mesh = sim.vehicle.chassisMesh;
  const origin = mesh.position.y; // rest height of the mesh origin on flat ground
  // Chassis axes: up = slope normal, forward = heading projected into the slope.
  const f = new Vector3(Math.sin(heading), 0, Math.cos(heading));
  f.subtractInPlace(n.scale(Vector3.Dot(f, n))).normalize();
  const r = Vector3.Cross(n, f);
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
  Quaternion.RotationQuaternionFromAxisToRef(r, n, f, mesh.rotationQuaternion);
  mesh.position.set(px + n.x * (origin + 0.01), height + n.y * (origin + 0.01), pz + n.z * (origin + 0.01));
  mesh.computeWorldMatrix(true);
  const v = f.scale(speed);
  sim.vehicle.setMotion(v, 0);
  sim.vehicle.chassisBody.setLinearVelocity(v);
  sim.vehicle.chassisBody.setAngularVelocity(Vector3.Zero());
}

/** One step with a different frame length (dt is otherwise fixed per Sim). */
export function stepWith(sim: Sim, dt: number): void {
  const s = sim as unknown as { dt: number };
  const old = s.dt;
  s.dt = dt;
  try {
    sim.step();
  } finally {
    s.dt = old;
  }
}

/** Static box (wall / post / ledge). Centre (x, y, z), full sizes. */
export function addBox(
  sim: Sim,
  name: string,
  center: [number, number, number],
  size: [number, number, number],
  yaw = 0,
  friction = 1.0,
): void {
  const scene = sim.world.scene;
  const box = MeshBuilder.CreateBox(`lab${name}`, { width: size[0], height: size[1], depth: size[2] }, scene);
  box.position.set(center[0], center[1], center[2]);
  box.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
  box.isVisible = sim.env.watch;
  new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0 }, scene);
}

/**
 * Watchdog: follows a run and records the things that mean "the simulation
 * broke" — NaN, absurd speeds / spin rates, falling through the world — plus
 * the usual attitude maxima.
 */
export class Watchdog {
  nan = false;
  maxSpeed3 = 0;
  maxAngSpeed = 0;
  maxY = -Infinity;
  minY = Infinity;
  maxVyUp = 0;
  maxTilt = 0;
  maxAbsBeta = 0;
  steps = 0;
  private sim: Sim;

  constructor(sim: Sim) {
    this.sim = sim;
  }

  /** Call after every step. */
  see(): void {
    const sim = this.sim;
    const tel = sim.tel;
    const body = sim.vehicle.chassisBody;
    body.getAngularVelocityToRef(tmpAng);
    body.getLinearVelocityToRef(tmpLin);
    const q = sim.vehicle.chassisMesh.rotationQuaternion;
    const sum = tel.x + tel.y + tel.z + tmpLin.x + tmpLin.y + tmpLin.z + tmpAng.x + tmpAng.y + tmpAng.z +
      (q ? q.x + q.y + q.z + q.w : 0);
    if (!Number.isFinite(sum)) {
      this.nan = true;
      return;
    }
    for (const w of sim.vehicle.wheelStates) {
      if (!Number.isFinite(w.position.x + w.position.y + w.position.z + w.spinSpeed + w.slipSpeed + w.rollSpeed + w.steerAngle)) {
        this.nan = true;
      }
    }
    this.steps++;
    this.maxSpeed3 = Math.max(this.maxSpeed3, tmpLin.length());
    this.maxAngSpeed = Math.max(this.maxAngSpeed, tmpAng.length());
    this.maxY = Math.max(this.maxY, tel.y);
    this.minY = Math.min(this.minY, tel.y);
    this.maxVyUp = Math.max(this.maxVyUp, tmpLin.y);
    this.maxTilt = Math.max(this.maxTilt, tel.tilt);
    this.maxAbsBeta = Math.max(this.maxAbsBeta, Math.abs(tel.beta));
  }

  /** "Exploded" = NaN, or faster than any input could make it. */
  exploded(speedLimit = 45, spinLimit = 25): boolean {
    return this.nan || this.maxSpeed3 > speedLimit || this.maxAngSpeed > spinLimit;
  }

  metrics(speedLimit = 45, spinLimit = 25): Record<string, MetricValue> {
    return {
      nan: this.nan,
      exploded: this.exploded(speedLimit, spinLimit),
      maxSpeed3: this.maxSpeed3,
      maxAngSpeed: this.maxAngSpeed,
      maxOriginY: this.maxY,
      minOriginY: this.minY,
      maxTiltDeg: this.maxTilt * DEG,
    };
  }
}

/** Run `seconds`, feeding the watchdog; optional per-step callback. */
export async function runWatched(
  sim: Sim,
  dog: Watchdog,
  seconds: number,
  onStep?: (sim: Sim) => boolean | void,
): Promise<boolean> {
  return sim.run(seconds, () => {
    dog.see();
    return onStep ? onStep(sim) === true : false;
  });
}

/** Deterministic pseudo-random numbers (no Math.random in the lab). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Judge a slide recovery from per-step logs (same rules as the standard
 * slideRecovery maneuver: recovered = |beta| < 5° and |yaw rate| < 10°/s held
 * for 0.5 s; overshoots = swings past 5° on the far side). `sign` is the
 * sign of beta at onset (−1 for the standard right-hand slide).
 */
export function judgeRecovery(
  dt: number,
  betas: number[],
  rates: number[],
  yaws: number[],
  course0: number,
  sign: number,
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
  let side = sign;
  let counterSwing = 0;
  let peak = 0;
  let spun = false;
  for (let i = 0; i < judged; i++) {
    const b = betas[i];
    if (Math.abs(b) > peak) peak = Math.abs(b);
    if (Math.abs(b) > Math.PI / 2) spun = true;
    if (b * sign < 0 && Math.abs(b) > counterSwing) counterSwing = Math.abs(b);
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
