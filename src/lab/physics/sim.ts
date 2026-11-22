import { PhysicsMotionType, Vector3 } from '@babylonjs/core';
import type { AbstractEngine, PhysicsEngineV2, TransformNode } from '@babylonjs/core';
import type { CarIntent, InputProvider } from '../../input/types';
import type { Vehicle } from '../../car/Vehicle';
import type { VehicleRig } from '../../car/rig';
import { createVehicle } from '../../car/createVehicle';
import { ActuationLimiter, DriverModel, wrapAngle } from '../../car/DriverModel';
import type { DriverObservation, DriverParams } from '../../car/DriverModel';
import { buildWorld } from './world';
import type { LabWorld, WorldSpec } from './world';
import type { Series } from './types';

/**
 * Sim — one vehicle in one fresh physics world, advanced by MANUAL fixed
 * steps (no render loop, no wall clock): deterministic and as fast as the
 * CPU allows.
 *
 * Per step, in the game's own order:
 *   1. force world matrices of every dynamic body (without scene.render()
 *      Babylon's matrix cache goes stale — CLAUDE.md gotcha)
 *   2. compute this frame's CarIntent (script / driver / fixed)
 *   3. vehicle.update(dt)
 *   4. physics step (pe._step(dt), with the before/after-physics observables
 *      a model may hook)
 *   5. refresh matrices, derive telemetry from the chassis body
 */

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export interface LabEnv {
  engine: AbstractEngine;
  havok: unknown;
  model: string;
  carId: string;
  /** null = legacy hardcoded layout (model 'rigid', ?car=rb01). */
  rig: VehicleRig | null;
  dt: number;
  seed: number;
  /** Render in real time with a chase camera (human inspection). */
  watch: boolean;
  keepSeries: boolean;
  /** Peak tire grip the model declares (filled from a probe vehicle). */
  nominalGrip: number;
  /** Apply the car's handling preset (handling.ts); ?handling=0 turns it off. */
  handling: boolean;
  /** Tuning overrides applied to every vehicle (?tune=key:value,...). */
  tune: Record<string, number>;
  /** Driver-model overrides applied to EVERY driver (?driver=key:value,...)
   * — for asking "is it the car or the driver?". */
  driverTune: Partial<DriverParams>;
  /** Watch-mode hook: called for every new Sim (camera attach) / frame. */
  onSim?: (sim: Sim) => void;
  onFrame?: (sim: Sim) => Promise<void>;
  /** Called between cases so the page stays responsive / reports progress. */
  totals: { steps: number; simSeconds: number };
}

/** One keyframe of a scripted input: targets hold until the next keyframe. */
export interface ScriptKey {
  t: number;
  steering?: number;
  throttle?: number;
  brake?: number;
}

/**
 * Plays a timeline of stick/trigger TARGETS through human-like ramps: the
 * stick takes `steerTime` (0.12 s) centre → lock, triggers `pedalTime`
 * (0.1 s) 0 → 1. Also usable as a plain InputProvider outside the lab.
 */
export class ScriptedInput implements InputProvider {
  readonly name = 'scripted';
  readonly hands: ActuationLimiter;
  private keys: ScriptKey[];
  private target: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  private next = 0;
  private time = 0;

  constructor(keys: ScriptKey[], start: CarIntent = { throttle: 0, steering: 0, brake: 0 }, steerTime = 0.12, pedalTime = 0.1) {
    this.keys = [...keys].sort((a, b) => a.t - b.t);
    this.hands = new ActuationLimiter(steerTime, pedalTime);
    this.hands.set(start);
    this.target = { ...start };
  }

  isActive(): boolean {
    return true;
  }

  /** Advance the timeline by dt and return the rate-limited intent. */
  advance(dt: number): CarIntent {
    // Keys fire at the START of the frame that contains them.
    while (this.next < this.keys.length && this.keys[this.next].t <= this.time + 1e-9) {
      const key = this.keys[this.next++];
      if (key.steering !== undefined) this.target.steering = key.steering;
      if (key.throttle !== undefined) this.target.throttle = key.throttle;
      if (key.brake !== undefined) this.target.brake = key.brake;
    }
    this.time += dt;
    return this.hands.apply(this.target, dt);
  }

  poll(): CarIntent {
    return this.hands.current;
  }
}

/** The InputProvider the lab vehicle reads; the Sim fills it once per step. */
class LabInput implements InputProvider {
  readonly name = 'lab';
  readonly intent: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  isActive(): boolean {
    return true;
  }
  poll(): CarIntent {
    return this.intent;
  }
}

export interface Telemetry {
  t: number;
  x: number;
  y: number;
  z: number;
  /** Continuous (unwrapped) heading, rad. */
  yaw: number;
  /** Nose-up pitch and right-side-down roll, rad. */
  pitch: number;
  roll: number;
  /** Angle between chassis up and world up, rad (0 upright, π inverted). */
  tilt: number;
  vx: number;
  vy: number;
  vz: number;
  /** Planar speed, m/s. */
  speed: number;
  vFwd: number;
  vLat: number;
  /** Body slip angle, rad (see DriverModel for the sign). */
  beta: number;
  /** rad/s, + = right. */
  yawRate: number;
  /** Chassis-frame accelerations, m/s², low-passed (τ = 0.08 s). */
  aLong: number;
  aLat: number;
  /** Path-normal (centripetal) acceleration, m/s², low-passed; + = the
   * velocity vector is turning right. This is "cornering g". */
  aCent: number;
  /** Wheels not touching the ground (0..4) and per-wheel flags. */
  wheelsOff: number;
  wheelOff: [boolean, boolean, boolean, boolean];
  steering: number;
  throttle: number;
  brake: number;
}

export interface Trackers {
  maxAbsBeta: number;
  maxTilt: number;
  maxAbsRoll: number;
  maxAbsPitch: number;
  maxWheelsOff: number;
  /** Seconds with both wheels of one SIDE off the ground. */
  sideLiftTime: number;
  /** Seconds with any wheel off the ground. */
  anyLiftTime: number;
  /** |beta| exceeded 90° while moving faster than 3 m/s. */
  spun: boolean;
  /** Tilt exceeded 75°. */
  rolledOver: boolean;
  /** Peak |aCent| (cornering acceleration), m/s². */
  maxAbsALat: number;
  maxSpeed: number;
}

type Source =
  | { kind: 'fixed'; intent: CarIntent }
  | { kind: 'script'; script: ScriptedInput }
  | { kind: 'driver'; driver: DriverModel };

export class Sim {
  readonly env: LabEnv;
  readonly world: LabWorld;
  readonly vehicle: Vehicle;
  readonly dt: number;
  readonly gravity: number;
  /** Nominal mu·g of this vehicle, m/s². */
  readonly mug: number;
  time = 0;
  steps = 0;
  readonly tel: Telemetry;
  readonly track: Trackers;
  readonly series: Series = { t: [], x: [], z: [], yaw: [], speed: [], yawRate: [], beta: [], steer: [], throttle: [], brake: [], aux: [] };
  /** Free debug channel a maneuver may set each step (recorded as series.aux;
   * path-following maneuvers put the lateral path offset here). */
  aux = 0;
  /**
   * 'geometric': a wheel is off when its tread is > 4 cm above the base
   * ground (independent of what the model claims — right on the flat plane
   * and the heightfield). 'flag': trust WheelGroundState.grounded (needed ON
   * obstacles the base ground does not know).
   */
  liftMode: 'geometric' | 'flag';

  private input = new LabInput();
  private source: Source = { kind: 'fixed', intent: { throttle: 0, steering: 0, brake: 0 } };
  private pe: PhysicsEngineV2;
  private dynamicNodes: TransformNode[] = [];
  private lin = new Vector3();
  private ang = new Vector3();
  private prevVx = 0;
  private prevVz = 0;
  private prevYawRaw = 0;
  private fresh = true;
  private seriesNext = 0;
  private obs: DriverObservation = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0 };
  private frameDebt = 0;
  private throttleLog: number[] = [];

  constructor(env: LabEnv, spec: WorldSpec, dt: number = env.dt) {
    this.env = env;
    this.dt = dt;
    this.world = buildWorld(env.engine, env.havok, spec, env.watch);
    this.gravity = this.world.gravity;
    const scene = this.world.scene;
    // The lab steps physics itself; scene.render() (watch mode) must not.
    scene.physicsEnabled = false;
    this.pe = scene.getPhysicsEngine() as PhysicsEngineV2;
    // The game's own entry point: rig + per-car handling preset + overrides.
    this.vehicle = createVehicle(scene, this.input, {
      model: env.model, carId: env.carId, rig: env.rig, handling: env.handling, tune: env.tune,
    });
    this.mug = this.vehicle.nominalGrip * this.gravity;
    this.liftMode = spec.obstacles?.length || spec.roadRamps ? 'flag' : 'geometric';
    for (const node of scene.transformNodes.concat(scene.meshes)) {
      if (node.physicsBody && node.physicsBody.getMotionType() === PhysicsMotionType.DYNAMIC) {
        this.dynamicNodes.push(node);
      }
    }
    this.tel = {
      t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, tilt: 0,
      vx: 0, vy: 0, vz: 0, speed: 0, vFwd: 0, vLat: 0, beta: 0, yawRate: 0,
      aLong: 0, aLat: 0, aCent: 0, wheelsOff: 0, wheelOff: [false, false, false, false],
      steering: 0, throttle: 0, brake: 0,
    };
    this.track = this.newTrackers();
    env.onSim?.(this);
  }

  private newTrackers(): Trackers {
    return {
      maxAbsBeta: 0, maxTilt: 0, maxAbsRoll: 0, maxAbsPitch: 0, maxWheelsOff: 0,
      sideLiftTime: 0, anyLiftTime: 0, spun: false, rolledOver: false, maxAbsALat: 0, maxSpeed: 0,
    };
  }

  resetTrack(): void {
    Object.assign(this.track, this.newTrackers());
  }

  // --- input sources -------------------------------------------------------

  /** Hold a fixed intent (no ramps). */
  useFixed(intent: Partial<CarIntent>): void {
    const full = { throttle: 0, steering: 0, brake: 0, ...intent };
    this.source = { kind: 'fixed', intent: full };
    // Effective immediately, so a script/driver started next ramps from here.
    Object.assign(this.input.intent, full);
  }

  /** Play a timeline; t = 0 is now. Ramps start from the current intent. */
  useScript(keys: ScriptKey[], steerTime = 0.12, pedalTime = 0.1): ScriptedInput {
    const script = new ScriptedInput(keys, { ...this.input.intent }, steerTime, pedalTime);
    this.source = { kind: 'script', script };
    return script;
  }

  /** New driver for this car (not yet driving — pass it to useDriver). */
  makeDriver(params: Partial<DriverParams> = {}): DriverModel {
    const v = this.vehicle;
    return new DriverModel(
      {
        wheelbase: v.wheelbase,
        maxSteerAngle: v.maxSteerAngle,
        grip: v.nominalGrip,
        gravity: this.gravity,
        topSpeed: v.topSpeed,
        stickForSteerAngle: v.stickForSteerAngle ? (angle) => v.stickForSteerAngle!(angle) : undefined,
      },
      { ...v.driverHints, ...params, ...this.env.driverTune },
    );
  }

  /** Hand the controls to a driver; its hands start where the controls are. */
  useDriver(driver: DriverModel): DriverModel {
    driver.prime(this.input.intent);
    this.source = { kind: 'driver', driver };
    return driver;
  }

  /** Like useDriver, but the driver starts as if it had been pursuing its
   * goal already (see DriverModel.settle) — set the goal BEFORE calling. */
  useSettledDriver(driver: DriverModel): DriverModel {
    const tel = this.tel;
    driver.settle({ x: tel.x, z: tel.z, yaw: tel.yaw, vx: tel.vx, vz: tel.vz, yawRate: tel.yawRate });
    Object.assign(this.input.intent, driver.hands.current);
    this.source = { kind: 'driver', driver };
    return driver;
  }

  /** Mean throttle over the last `seconds` (what the foot has been doing). */
  meanThrottle(seconds: number): number {
    const n = Math.min(this.throttleLog.length, Math.max(1, Math.round(seconds / this.dt)));
    let sum = 0;
    for (let i = this.throttleLog.length - n; i < this.throttleLog.length; i++) sum += this.throttleLog[i];
    return n > 0 && this.throttleLog.length > 0 ? sum / n : this.input.intent.throttle;
  }

  get intent(): CarIntent {
    return this.input.intent;
  }

  // --- placement -----------------------------------------------------------

  /**
   * Teleport the car onto the ground at (x, z) heading `yaw`, optionally
   * already moving: `speed` along the direction yaw + beta (a non-zero beta
   * imposes a slide), rotating at `yawRate`.
   */
  place(o: { x: number; z: number; yaw: number; speed?: number; beta?: number; yawRate?: number }): void {
    const y = this.world.groundHeight(o.x, o.z);
    this.vehicle.reset(new Vector3(o.x, y, o.z), o.yaw);
    const speed = o.speed ?? 0;
    const course = o.yaw + (o.beta ?? 0);
    const v = new Vector3(Math.sin(course) * speed, 0, Math.cos(course) * speed);
    if (speed !== 0 || o.yawRate) this.vehicle.setMotion(v, o.yawRate ?? 0);
    this.prevVx = v.x;
    this.prevVz = v.z;
    this.tel.yaw = o.yaw;
    this.prevYawRaw = wrapAngle(o.yaw);
    this.tel.aLat = 0;
    this.tel.aCent = 0;
    this.tel.aLong = 0;
    this.fresh = true;
    this.syncMatrices();
    this.readTelemetry(0);
  }

  // --- stepping ------------------------------------------------------------

  private syncMatrices(): void {
    for (const node of this.dynamicNodes) node.computeWorldMatrix(true);
  }

  step(): void {
    const dt = this.dt;
    this.syncMatrices();

    const out = this.input.intent;
    const src = this.source;
    let intent: CarIntent;
    if (src.kind === 'fixed') {
      intent = src.intent;
    } else if (src.kind === 'script') {
      intent = src.script.advance(dt);
    } else {
      const tel = this.tel;
      const obs = this.obs;
      obs.x = tel.x;
      obs.z = tel.z;
      obs.yaw = tel.yaw;
      obs.vx = tel.vx;
      obs.vz = tel.vz;
      obs.yawRate = tel.yawRate;
      intent = src.driver.update(obs, dt);
    }
    out.throttle = intent.throttle;
    out.steering = intent.steering;
    out.brake = intent.brake;
    this.throttleLog.push(intent.throttle);
    if (this.throttleLog.length > 1024) this.throttleLog.splice(0, 512);

    this.vehicle.update(dt);

    const scene = this.world.scene;
    scene.onBeforePhysicsObservable.notifyObservers(scene);
    this.pe._step(dt);
    scene.onAfterPhysicsObservable.notifyObservers(scene);

    this.time += dt;
    this.steps++;
    this.env.totals.steps++;
    this.env.totals.simSeconds += dt;
    this.syncMatrices();
    this.readTelemetry(dt);
  }

  private readTelemetry(dt: number): void {
    const tel = this.tel;
    const v = this.vehicle;
    const mesh = v.chassisMesh;
    const pos = mesh.position;
    tel.t = this.time;
    tel.x = pos.x;
    tel.y = pos.y;
    tel.z = pos.z;

    const fwd = mesh.forward;
    const right = mesh.right;
    const up = mesh.up;
    const yawRaw = Math.atan2(fwd.x, fwd.z);
    tel.yaw += wrapAngle(yawRaw - this.prevYawRaw);
    this.prevYawRaw = yawRaw;
    tel.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    tel.roll = Math.asin(Math.max(-1, Math.min(1, -right.y)));
    tel.tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));

    v.chassisBody.getLinearVelocityToRef(this.lin);
    v.chassisBody.getAngularVelocityToRef(this.ang);
    tel.vx = this.lin.x;
    tel.vy = this.lin.y;
    tel.vz = this.lin.z;
    tel.speed = Math.hypot(tel.vx, tel.vz);
    // Heading frame on the ground plane.
    const sin = Math.sin(yawRaw);
    const cos = Math.cos(yawRaw);
    tel.vFwd = tel.vx * sin + tel.vz * cos;
    tel.vLat = tel.vx * cos - tel.vz * sin;
    tel.beta = tel.speed < 1.5 ? 0 : Math.atan2(tel.vLat, tel.vFwd);
    tel.yawRate = this.ang.y;

    if (dt > 0 && !this.fresh) {
      const ax = (tel.vx - this.prevVx) / dt;
      const az = (tel.vz - this.prevVz) / dt;
      const k = Math.min(1, dt / 0.08);
      tel.aLong += (ax * sin + az * cos - tel.aLong) * k;
      tel.aLat += (ax * cos - az * sin - tel.aLat) * k;
      const cent = tel.speed > 0.5 ? (ax * tel.vz - az * tel.vx) / tel.speed : 0;
      tel.aCent += (cent - tel.aCent) * k;
    }
    if (dt > 0) this.fresh = false;
    this.prevVx = tel.vx;
    this.prevVz = tel.vz;

    let off = 0;
    for (let i = 0; i < 4; i++) {
      const w = v.wheelStates[i];
      let isOff: boolean;
      if (this.liftMode === 'geometric') {
        const ground = this.world.groundHeight(w.position.x, w.position.z);
        isOff = w.position.y - w.radius - ground > 0.04;
      } else {
        isOff = !w.grounded;
      }
      tel.wheelOff[i] = isOff;
      if (isOff) off++;
    }
    tel.wheelsOff = off;

    tel.steering = this.input.intent.steering;
    tel.throttle = this.input.intent.throttle;
    tel.brake = this.input.intent.brake;

    if (dt <= 0) return;
    const tr = this.track;
    const absBeta = Math.abs(tel.beta);
    if (absBeta > tr.maxAbsBeta) tr.maxAbsBeta = absBeta;
    if (absBeta > Math.PI / 2 && tel.speed > 3) tr.spun = true;
    if (tel.tilt > tr.maxTilt) tr.maxTilt = tel.tilt;
    if (tel.tilt > 75 * RAD) tr.rolledOver = true;
    if (Math.abs(tel.roll) > tr.maxAbsRoll) tr.maxAbsRoll = Math.abs(tel.roll);
    if (Math.abs(tel.pitch) > tr.maxAbsPitch) tr.maxAbsPitch = Math.abs(tel.pitch);
    if (off > tr.maxWheelsOff) tr.maxWheelsOff = off;
    if (off > 0) tr.anyLiftTime += dt;
    if ((tel.wheelOff[0] && tel.wheelOff[2]) || (tel.wheelOff[1] && tel.wheelOff[3])) tr.sideLiftTime += dt;
    if (Math.abs(tel.aCent) > tr.maxAbsALat) tr.maxAbsALat = Math.abs(tel.aCent);
    if (tel.speed > tr.maxSpeed) tr.maxSpeed = tel.speed;

    if (this.env.keepSeries && this.time + 1e-9 >= this.seriesNext) {
      this.seriesNext += 0.1;
      const s = this.series;
      s.t.push(round(this.time, 3));
      s.x.push(round(tel.x, 2));
      s.z.push(round(tel.z, 2));
      s.yaw.push(round(tel.yaw * DEG, 1));
      s.speed.push(round(tel.speed, 2));
      s.yawRate.push(round(tel.yawRate * DEG, 1));
      s.beta.push(round(tel.beta * DEG, 1));
      s.steer.push(round(tel.steering, 2));
      s.throttle.push(round(tel.throttle, 2));
      s.brake.push(round(tel.brake, 2));
      s.aux.push(round(this.aux, 2));
    }
  }

  /**
   * Run for `seconds` of simulated time. `onStep` is called after every step
   * with the fresh telemetry; return true to stop early. Resolves to true if
   * it was stopped early.
   */
  async run(seconds: number, onStep?: (tel: Telemetry, sim: Sim) => boolean | void): Promise<boolean> {
    const n = Math.max(1, Math.round(seconds / this.dt));
    for (let i = 0; i < n; i++) {
      this.step();
      if (onStep && onStep(this.tel, this) === true) return true;
      if (this.env.watch && this.env.onFrame) {
        // Real-time pacing: one rendered frame per 1/60 s of simulated time.
        this.frameDebt += this.dt;
        if (this.frameDebt >= 1 / 60) {
          this.frameDebt -= 1 / 60;
          await this.env.onFrame(this);
        }
      }
    }
    return false;
  }

  dispose(): void {
    this.vehicle.dispose();
    this.world.dispose();
  }
}

export function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
