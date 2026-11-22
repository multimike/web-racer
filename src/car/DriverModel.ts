import type { CarIntent } from '../input/types';

/**
 * DriverModel — a closed-loop "human-ish" driver that turns what a driver can
 * perceive (pose, velocity, yaw rate) into a `CarIntent`.
 *
 * It is deliberately free of Babylon, physics-engine and lab dependencies:
 * the physics lab uses it to judge vehicle models (src/lab/physics), and the
 * same class is meant to drive rival AI cars later — feed it an observation
 * per frame, pass the returned intent to the car's InputProvider.
 *
 * Skills (pick one with the goal methods, switch at any time):
 *   holdSpeed(v, course)  keep a speed, optionally keep a compass course
 *   followPath(plan)      pure pursuit + curvature-based speed plan, with a
 *                         built-in slide catch (countersteer + lift)
 *   recover(course)       countersteer toward the velocity direction, ease
 *                         the throttle, straighten up
 *   driftHold(beta)       hold a body slip angle with throttle + countersteer
 *   manual(intent)        fixed target intent (still rate-limited/delayed)
 *
 * Human limits (all configurable, set to 0 for a perfect robot):
 *   reactionDelay  transport delay between decision and hands/feet (s)
 *   steerTime      time for the stick to travel centre → full lock (s)
 *   pedalTime      time for a trigger to travel 0 → 1 (s)
 *
 * Conventions (same as Vehicle.ts): yaw 0 = +z, positive yaw / yaw rate /
 * steering = RIGHT (toward +x). Body slip angle beta = direction of travel
 * relative to the nose: beta > 0 means the car is moving toward its right
 * side, i.e. the nose points LEFT of where the car is going. Countersteering
 * is therefore simply "steer toward beta".
 */

export interface DriverObservation {
  /** Position of the car (wheelbase centre), world m. */
  x: number;
  z: number;
  /** Heading, rad. */
  yaw: number;
  /** Planar world velocity, m/s. */
  vx: number;
  vz: number;
  /** rad/s, + = turning right. */
  yawRate: number;
}

/** What the driver knows about the car it sits in. */
export interface DriverCar {
  wheelbase: number;
  /** Bicycle-model steer angle at full stick, rad. */
  maxSteerAngle: number;
  /** Peak tire grip coefficient (speed plan uses μ·g). */
  grip: number;
  gravity: number;
  topSpeed: number;
  /** Stick position for a wanted front-wheel angle (see
   * Vehicle.stickForSteerAngle). Absent = stick is angle / maxSteerAngle. */
  stickForSteerAngle?: (angle: number) => number;
}

export interface DriverParams {
  reactionDelay: number;
  steerTime: number;
  pedalTime: number;

  // --- speed control
  /** Throttle per m/s of speed error. */
  speedKp: number;
  /** Throttle per m of integrated speed error. */
  speedKi: number;
  /** Brake per m/s of overspeed beyond `brakeDeadband`. */
  brakeKp: number;
  brakeDeadband: number;
  /** How far the driver is willing to press the pedals (0..1). */
  maxThrottle: number;
  maxBrake: number;

  // --- path following
  /** Lookahead distance = lookBase + lookTime · speed, clamped to [lookMin, lookMax]. */
  lookBase: number;
  lookTime: number;
  lookMin: number;
  lookMax: number;
  /** Corner speed: lateral acceleration budget as a fraction of μ·g. */
  cornerGrip: number;
  /** Braking / acceleration budgets for the speed plan, fraction of μ·g. */
  brakeGrip: number;
  accelGrip: number;
  /** Never plan above this speed, m/s. */
  maxSpeed: number;
  /** Extra steer (rad) per metre of lateral offset from the path, and per
   * metre·second of integrated offset — "the car is not turning in, add
   * lock". The integral is what lets the driver hold a radius on a car that
   * needs far more than the kinematic steer angle (skidpad). */
  pathKp: number;
  pathKi: number;
  /** Slide catch while path following: starts blending in at this |beta|
   * (rad) and has full authority at `catchBetaFull`. */
  catchBetaStart: number;
  catchBetaFull: number;

  // --- slide recovery (countersteer)
  /** Steer angle per rad of beta (1 = front wheels exactly along travel). */
  counterGain: number;
  /** Fraction of the current yaw rate the driver steers against (damps the
   * tank-slapper). Dimensionless: the steer angle is the one that would
   * kinematically produce that yaw rate, atan(L·r/v) — so the loop gain is
   * the same at every speed and stays < 1 (stable with the reaction delay). */
  yawDamp: number;
  /** Time constant for steering back onto a target course, s: the driver
   * asks for a yaw rate of (heading error / courseTime). */
  courseTime: number;
  /** Throttle held while catching a slide. */
  recoverThrottle: number;

  // --- drift hold
  /** Front slip angle (rad) asked for per rad of beta error. */
  driftSteerGain: number;
  /** Front slip angle held into the turn at the target angle, rad — the
   * front tires must still pull the car round the arc. */
  driftSteerBias: number;
  /** Front slip angle per rad·s of accumulated beta error. */
  driftSteerKi: number;
  /** Like yawDamp, against yaw-rate CHANGES (steady rotation is wanted). */
  driftYawDamp: number;
  /** Baseline throttle in a drift and throttle per rad of missing angle. */
  driftThrottle: number;
  driftThrottleGain: number;
  /** Throttle per rad·s of accumulated missing angle (finds the balance
   * throttle of whatever car this is). */
  driftThrottleKi: number;
  /** Throttle taken off per rad/s of the angle GROWING (anticipation: the
   * foot must come up before the angle arrives, not after). */
  driftThrottleRate: number;
}

export const DEFAULT_DRIVER_PARAMS: DriverParams = {
  reactionDelay: 0.25,
  steerTime: 0.12,
  pedalTime: 0.1,
  speedKp: 0.35,
  speedKi: 0.25,
  brakeKp: 0.35,
  brakeDeadband: 0.6,
  maxThrottle: 1,
  maxBrake: 1,
  lookBase: 3.0,
  lookTime: 0.4,
  lookMin: 4.0,
  lookMax: 16,
  cornerGrip: 0.7,
  brakeGrip: 0.5,
  accelGrip: 0.5,
  maxSpeed: 60,
  pathKp: 0.03,
  pathKi: 0,
  catchBetaStart: (8 * Math.PI) / 180,
  catchBetaFull: (18 * Math.PI) / 180,
  counterGain: 1.2,
  yawDamp: 0.35,
  courseTime: 0.7,
  recoverThrottle: 0.1,
  driftSteerGain: 1.2,
  driftSteerBias: (3 * Math.PI) / 180,
  driftSteerKi: 1.0,
  driftYawDamp: 0.4,
  driftThrottle: 0.45,
  driftThrottleGain: 1.5,
  driftThrottleKi: 0.5,
  driftThrottleRate: 0.25,
};

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Body slip angle (rad) from an observation; 0 below walking pace. */
export function bodySlip(obs: DriverObservation): number {
  const sin = Math.sin(obs.yaw);
  const cos = Math.cos(obs.yaw);
  const vFwd = obs.vx * sin + obs.vz * cos;
  const vLat = obs.vx * cos - obs.vz * sin;
  if (Math.hypot(vFwd, vLat) < 1.5) return 0;
  return Math.atan2(vLat, vFwd);
}

// ---------------------------------------------------------------------------
// Human actuation: rate-limited stick and triggers.

/** Slew-rate limiter for stick and triggers — a thumb cannot teleport. */
export class ActuationLimiter {
  steerTime: number;
  pedalTime: number;
  readonly current: CarIntent = { throttle: 0, steering: 0, brake: 0 };

  constructor(steerTime = 0.12, pedalTime = 0.1) {
    this.steerTime = steerTime;
    this.pedalTime = pedalTime;
  }

  /** Jump straight to an intent (start of a maneuver). */
  set(intent: CarIntent): void {
    this.current.throttle = intent.throttle;
    this.current.steering = intent.steering;
    this.current.brake = intent.brake;
  }

  apply(target: CarIntent, dt: number): CarIntent {
    const c = this.current;
    const ds = this.steerTime > 0 ? dt / this.steerTime : 2;
    const dp = this.pedalTime > 0 ? dt / this.pedalTime : 1;
    c.steering += clamp(clamp(target.steering, -1, 1) - c.steering, -ds, ds);
    c.throttle += clamp(clamp(target.throttle, 0, 1) - c.throttle, -dp, dp);
    c.brake += clamp(clamp(target.brake, 0, 1) - c.brake, -dp, dp);
    return c;
  }
}

/** Pure transport delay on a stream of intents (reaction time). */
class IntentDelay {
  private queue: Array<{ t: number; steering: number; throttle: number; brake: number }> = [];
  private out: CarIntent = { throttle: 0, steering: 0, brake: 0 };

  reset(intent: CarIntent): void {
    this.queue.length = 0;
    this.out = { ...intent };
  }

  push(now: number, intent: CarIntent, delay: number): CarIntent {
    if (delay <= 0) {
      this.queue.length = 0;
      this.out.steering = intent.steering;
      this.out.throttle = intent.throttle;
      this.out.brake = intent.brake;
      return this.out;
    }
    this.queue.push({ t: now, steering: intent.steering, throttle: intent.throttle, brake: intent.brake });
    // Output = the command stream at time (now − delay), linearly
    // interpolated between samples so the delay is the same at any frame
    // rate (a whole-frame delay would be 0.267 s at 30 Hz, 0.25 s at 60).
    const at = now - delay;
    while (this.queue.length > 1 && this.queue[1].t <= at + 1e-9) this.queue.shift();
    const a = this.queue[0];
    if (a.t > at + 1e-9) return this.out; // nothing that old yet: hold
    const b = this.queue.length > 1 ? this.queue[1] : a;
    const f = b.t > a.t ? Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t))) : 0;
    this.out.steering = a.steering + (b.steering - a.steering) * f;
    this.out.throttle = a.throttle + (b.throttle - a.throttle) * f;
    this.out.brake = a.brake + (b.brake - a.brake) * f;
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// Path + speed plan.

export interface PathPlanOptions {
  closed: boolean;
  /** Lateral / braking / acceleration budgets, m/s². */
  cornerAccel: number;
  brakeAccel: number;
  driveAccel: number;
  maxSpeed: number;
  /** Speed at the first point of an open path (default: maxSpeed). */
  entrySpeed?: number;
}

/**
 * A polyline to drive along, with per-point curvature and a speed plan:
 * corner speed sqrt(a_lat / |κ|), then a backward pass so the car can brake
 * down to every corner and a forward pass so it never plans to out-accelerate
 * the drivetrain.
 */
export class PathPlan {
  /** [x0, z0, x1, z1, ...] */
  readonly points: Float32Array;
  readonly count: number;
  readonly closed: boolean;
  /** Arc length at each point, m; `length` is the total (incl. closing segment). */
  readonly s: Float32Array;
  readonly length: number;
  /** Signed curvature, 1/m (+ = turning right). */
  readonly curvature: Float32Array;
  /** Planned speed at each point, m/s. */
  readonly speed: Float32Array;

  constructor(points: ArrayLike<number>, options: PathPlanOptions) {
    this.points = Float32Array.from(points);
    const n = this.points.length / 2;
    this.count = n;
    this.closed = options.closed;
    const p = this.points;
    const idx = (i: number) => (this.closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));

    this.s = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      this.s[i] = this.s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    }
    this.length = this.closed
      ? this.s[n - 1] + Math.hypot(p[0] - p[n * 2 - 2], p[1] - p[n * 2 - 1])
      : this.s[n - 1];

    // Curvature = heading change over arc length across a ±K point window
    // (K picked so the window spans ~6 m: enough to ignore polyline noise).
    const meanStep = this.length / Math.max(1, this.closed ? n : n - 1);
    const K = Math.max(1, Math.round(3 / Math.max(meanStep, 0.05)));
    this.curvature = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = idx(i - K);
      const b = idx(i);
      const c = idx(i + K);
      if (a === b || b === c) continue;
      const h0 = Math.atan2(p[b * 2] - p[a * 2], p[b * 2 + 1] - p[a * 2 + 1]);
      const h1 = Math.atan2(p[c * 2] - p[b * 2], p[c * 2 + 1] - p[b * 2 + 1]);
      const d0 = Math.hypot(p[b * 2] - p[a * 2], p[b * 2 + 1] - p[a * 2 + 1]);
      const d1 = Math.hypot(p[c * 2] - p[b * 2], p[c * 2 + 1] - p[b * 2 + 1]);
      this.curvature[i] = wrapAngle(h1 - h0) / Math.max((d0 + d1) / 2, 1e-3);
    }

    this.speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.curvature[i]);
      this.speed[i] = Math.min(options.maxSpeed, k > 1e-5 ? Math.sqrt(options.cornerAccel / k) : options.maxSpeed);
    }
    if (!this.closed && options.entrySpeed !== undefined) {
      this.speed[0] = Math.min(this.speed[0], options.entrySpeed);
    }
    const segment = (i: number, j: number) => Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
    // Two sweeps each way so a closed loop converges across the seam.
    const sweeps = this.closed ? 2 : 1;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      for (let k = n - 1; k >= 0; k--) {
        const j = k + 1;
        if (!this.closed && j >= n) continue;
        const next = idx(j);
        const limit = Math.sqrt(this.speed[next] ** 2 + 2 * options.brakeAccel * segment(k, next));
        if (this.speed[k] > limit) this.speed[k] = limit;
      }
      for (let k = 0; k < n; k++) {
        const j = k - 1;
        if (!this.closed && j < 0) continue;
        const prev = idx(j);
        const limit = Math.sqrt(this.speed[prev] ** 2 + 2 * options.driveAccel * segment(prev, k));
        if (this.speed[k] > limit) this.speed[k] = limit;
      }
    }
  }

  /** Index of the closest point, searching `window` points around `hint`
   * (or the whole path when hint < 0). */
  nearest(x: number, z: number, hint = -1, window = 40): number {
    const n = this.count;
    const p = this.points;
    let best = 0;
    let bestD = Infinity;
    const test = (i: number) => {
      const d = (p[i * 2] - x) ** 2 + (p[i * 2 + 1] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint < 0) {
      for (let i = 0; i < n; i++) test(i);
    } else {
      for (let k = -5; k <= window; k++) {
        const i = this.closed ? (((hint + k) % n) + n) % n : hint + k;
        if (i >= 0 && i < n) test(i);
      }
    }
    return best;
  }

  /** Point `distance` metres along the path from point `from`. */
  ahead(from: number, distance: number, out: { x: number; z: number; index: number }): void {
    const n = this.count;
    const p = this.points;
    let i = from;
    let left = distance;
    for (let guard = 0; guard < n; guard++) {
      let j = i + 1;
      if (j >= n) {
        if (!this.closed) break;
        j = 0;
      }
      const seg = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
      if (seg >= left && seg > 0) {
        const t = left / seg;
        out.x = p[i * 2] + (p[j * 2] - p[i * 2]) * t;
        out.z = p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * t;
        out.index = i;
        return;
      }
      left -= seg;
      i = j;
    }
    // Ran off the end of an open path: extrapolate along the last segment.
    const a = Math.max(0, n - 2);
    const b = n - 1;
    const dx = p[b * 2] - p[a * 2];
    const dz = p[b * 2 + 1] - p[a * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    out.x = p[b * 2] + (dx / len) * left;
    out.z = p[b * 2 + 1] + (dz / len) * left;
    out.index = b;
  }

  /** Signed lateral offset of (x, z) from the path at point `i`, m (+ = right of it). */
  lateralOffset(x: number, z: number, i: number): number {
    const n = this.count;
    const p = this.points;
    const a = this.closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = this.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const tx = p[b * 2] - p[a * 2];
    const tz = p[b * 2 + 1] - p[a * 2 + 1];
    const len = Math.hypot(tx, tz) || 1;
    // right of the tangent (tx, tz) is (tz, −tx)
    return ((x - p[i * 2]) * tz - (z - p[i * 2 + 1]) * tx) / len;
  }
}

/** Speed-plan budgets for a path from the driver's grip fractions. */
export function planOptions(car: DriverCar, params: DriverParams, closed: boolean): PathPlanOptions {
  const mug = car.grip * car.gravity;
  return {
    closed,
    cornerAccel: params.cornerGrip * mug,
    brakeAccel: params.brakeGrip * mug,
    driveAccel: params.accelGrip * mug,
    maxSpeed: Math.min(params.maxSpeed, car.topSpeed),
  };
}

// ---------------------------------------------------------------------------

type Goal =
  | { kind: 'manual'; intent: CarIntent }
  | { kind: 'holdSpeed'; speed: number; course: number | null; steering: number }
  | { kind: 'followPath'; plan: PathPlan; fixedSpeed: number | null }
  | { kind: 'recover'; course: number | null; resumeSpeed: number | null; calm: number }
  | { kind: 'driftHold'; beta: number };

export class DriverModel {
  readonly car: DriverCar;
  readonly params: DriverParams;
  /** Rate limiter state = what the hands are doing right now. */
  readonly hands: ActuationLimiter;

  private goal: Goal = { kind: 'manual', intent: { throttle: 0, steering: 0, brake: 0 } };
  private delay = new IntentDelay();
  private acted: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  private time = 0;
  private speedIntegral = 0;
  private pathIndex = -1;
  private offsetIntegral = 0;
  private driftIntegral = 0;
  private driftSteerIntegral = 0;
  private driftSpeed = 0;
  private driftPrevBeta = 0;
  private driftBetaRate = 0;
  private yawRateSlow = 0;
  private target = { x: 0, z: 0, index: 0 };
  private wanted: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  /** launchInLane state. */
  private lane = { active: false, offset: 0, armedAt: 0, holdTime: 0, holdSpeed: 0, blendTime: 1, blendFrom: -1 };

  // --- read-only debug/telemetry of the last update
  /** Nearest path point index while following a path. */
  lastPathIndex = -1;
  /** Signed lateral offset from the path, m. */
  lastPathOffset = 0;
  /** Planned speed the driver is aiming for, m/s. */
  lastTargetSpeed = 0;
  /** 0..1 authority of the slide catch in followPath. */
  lastCatch = 0;

  constructor(car: DriverCar, params: Partial<DriverParams> = {}) {
    this.car = car;
    this.params = { ...DEFAULT_DRIVER_PARAMS, ...params };
    this.hands = new ActuationLimiter(this.params.steerTime, this.params.pedalTime);
  }

  /** Forget the command history and start from this hand/foot position. */
  prime(intent: CarIntent): void {
    this.hands.set(intent);
    this.delay.reset(intent);
    this.speedIntegral = 0;
  }

  /**
   * Assume the driver has ALREADY been pursuing the current goal: hands and
   * the reaction-delay line start at what the goal wants for `obs`, instead
   * of at neutral. Use when a maneuver starts mid-action (e.g. mid-drift).
   */
  settle(obs: DriverObservation): void {
    const delay = this.params.reactionDelay;
    this.params.reactionDelay = 0;
    this.hands.steerTime = 0;
    this.hands.pedalTime = 0;
    this.yawRateSlow = obs.yawRate;
    const intent = this.update(obs, 0);
    this.params.reactionDelay = delay;
    this.hands.steerTime = this.params.steerTime;
    this.hands.pedalTime = this.params.pedalTime;
    // (the delay line carries what the goal WANTS — see update())
    this.delay.reset(this.car.stickForSteerAngle ? this.wanted : intent);
  }

  manual(intent: CarIntent): void {
    this.goal = { kind: 'manual', intent: { ...intent } };
  }

  /** Hold `speed`; `course` (rad) additionally steers to hold a heading,
   * otherwise the stick is held at `steering`. */
  holdSpeed(speed: number, course: number | null = null, steering = 0): void {
    this.goal = { kind: 'holdSpeed', speed, course, steering };
  }

  /** Follow a path at its planned speed, or at `fixedSpeed` if given. */
  followPath(plan: PathPlan, fixedSpeed: number | null = null): void {
    this.goal = { kind: 'followPath', plan, fixedSpeed };
    this.pathIndex = -1;
    this.offsetIntegral = 0;
    this.lane.active = false;
  }

  /**
   * Launch like a player: drive the path `offset` m to the right of it (the
   * grid slot's lane) for the first `holdTime` s of the current followPath
   * goal or until `holdSpeed` m/s, then blend onto the path itself over
   * `blendTime` s. Call right after followPath(); any later followPath()
   * clears it. Off unless called (a driver that is not told to aims for its
   * path at once — from a grid slot beside it, that is a swerve across the
   * grid a second after the start).
   */
  launchInLane(offset: number, holdTime = 3, holdSpeed = 15, blendTime = 1.5): void {
    const lane = this.lane;
    lane.active = offset !== 0;
    lane.offset = offset;
    lane.armedAt = this.time;
    lane.holdTime = holdTime;
    lane.holdSpeed = holdSpeed;
    lane.blendTime = Math.max(blendTime, 1e-3);
    lane.blendFrom = -1;
  }

  /** End a launchInLane hold now (start the blend onto the path): a corner
   * is coming. No-op when no hold is active or it is already blending. */
  endLaunchHold(): void {
    if (this.lane.active && this.lane.blendFrom < 0) this.lane.blendFrom = this.time;
  }

  /** True while launchInLane still holds the grid lane (not yet blending). */
  get holdingLaunchLane(): boolean {
    return this.lane.active && this.lane.blendFrom < 0;
  }

  /**
   * Catch a slide. Stage 1: countersteer toward the direction of travel and
   * damp the rotation, throttle eased — nothing else. Stage 2, once the car
   * has been calm for 0.6 s: steer back onto `course` and resume
   * `resumeSpeed` (both optional).
   */
  recover(course: number | null = null, resumeSpeed: number | null = null): void {
    this.goal = { kind: 'recover', course, resumeSpeed, calm: 0 };
  }

  /** True while a recover() goal is still in its catching stage. */
  get catching(): boolean {
    return this.goal.kind === 'recover' && this.goal.calm < 0.6;
  }

  /** Hold a body slip angle (rad, signed: negative = drifting through a RIGHT turn). */
  driftHold(beta: number): void {
    this.goal = { kind: 'driftHold', beta };
    this.driftIntegral = 0;
    this.driftSteerIntegral = 0;
    this.driftSpeed = 0;
    this.driftBetaRate = 0;
    this.driftPrevBeta = NaN;
  }

  /** Change the target speed of the current holdSpeed / fixed-speed
   * followPath goal without restarting it. */
  setTargetSpeed(speed: number): void {
    if (this.goal.kind === 'holdSpeed') this.goal.speed = speed;
    else if (this.goal.kind === 'followPath') this.goal.fixedSpeed = speed;
  }

  get goalKind(): Goal['kind'] {
    return this.goal.kind;
  }

  update(obs: DriverObservation, dt: number): CarIntent {
    this.time += dt;
    const p = this.params;
    const car = this.car;
    const sin = Math.sin(obs.yaw);
    const cos = Math.cos(obs.yaw);
    const vFwd = obs.vx * sin + obs.vz * cos;
    const speed = Math.hypot(obs.vx, obs.vz);
    const beta = bodySlip(obs);
    this.yawRateSlow += (obs.yawRate - this.yawRateSlow) * Math.min(1, dt / 0.5);

    const want = this.wanted;
    want.throttle = 0;
    want.brake = 0;
    want.steering = 0;
    this.lastCatch = 0;
    // A wanted front-wheel ANGLE, normalised by full lock. On a car whose
    // stick is a plain angle command that IS the stick position. On a car
    // that re-interprets the stick in a slide (stickForSteerAngle) the wanted
    // angle travels through the reaction delay as an angle and is turned
    // into a stick position by the hands, below: the decision is late, the
    // hands know the car.
    const maxSteer = Math.max(car.maxSteerAngle, 1e-3);
    let steerIsAngle = false;
    const toStick = (angle: number) => {
      if (!car.stickForSteerAngle) return clamp(angle / maxSteer, -1, 1);
      steerIsAngle = true;
      return clamp(angle / maxSteer, -3, 3);
    };
    // Steer angle that kinematically yields a yaw rate at the current speed.
    const steerForYawRate = (rate: number) => Math.atan((car.wheelbase * rate) / Math.max(speed, 3));

    const goal = this.goal;
    switch (goal.kind) {
      case 'manual':
        want.throttle = goal.intent.throttle;
        want.brake = goal.intent.brake;
        want.steering = goal.intent.steering;
        break;

      case 'holdSpeed':
        this.speedControl(goal.speed, vFwd, dt, want, 1);
        want.steering = goal.course === null
          ? goal.steering
          : toStick(steerForYawRate(wrapAngle(goal.course - obs.yaw) / p.courseTime - 0.3 * obs.yawRate));
        this.lastTargetSpeed = goal.speed;
        break;

      case 'followPath': {
        const plan = goal.plan;
        this.pathIndex = plan.nearest(obs.x, obs.z, this.pathIndex);
        this.lastPathIndex = this.pathIndex;
        this.lastPathOffset = plan.lateralOffset(obs.x, obs.z, this.pathIndex);
        const look = clamp(p.lookBase + p.lookTime * speed, p.lookMin, p.lookMax);
        plan.ahead(this.pathIndex, look, this.target);
        // (launchInLane: the path shifted sideways while the lane is held)
        let shift = 0;
        const lane = this.lane;
        if (lane.active) {
          if (lane.blendFrom < 0 && (this.time - lane.armedAt >= lane.holdTime || speed >= lane.holdSpeed)) lane.blendFrom = this.time;
          const f = lane.blendFrom < 0 ? 1 : 1 - (this.time - lane.blendFrom) / lane.blendTime;
          if (f <= 0) lane.active = false;
          else {
            shift = lane.offset * f;
            const a = this.target.index;
            const b = plan.closed ? (a + 1) % plan.count : Math.min(plan.count - 1, a + 1);
            const tx = plan.points[b * 2] - plan.points[a * 2];
            const tz = plan.points[b * 2 + 1] - plan.points[a * 2 + 1];
            const len = Math.hypot(tx, tz) || 1;
            // right of the tangent (tx, tz) is (tz, −tx)
            this.target.x += (shift * tz) / len;
            this.target.z -= (shift * tx) / len;
          }
        }
        const dx = this.target.x - obs.x;
        const dz = this.target.z - obs.z;
        const lat = dx * cos - dz * sin;
        const dist2 = Math.max(dx * dx + dz * dz, 1e-3);
        // Pure pursuit: the arc through the target point has κ = 2·lat / d².
        const kappa = (2 * lat) / dist2;
        let steer = Math.atan(car.wheelbase * kappa);
        // Cross-track correction. The integral only winds while the stick
        // is not already pinned in the direction it wants to go.
        const offset = this.lastPathOffset - shift;
        if (p.pathKi > 0) {
          const pinned = Math.abs(this.hands.current.steering) > 0.98 &&
            Math.sign(this.hands.current.steering) === -Math.sign(offset);
          if (!pinned) this.offsetIntegral += offset * dt;
          const cap = car.maxSteerAngle / p.pathKi;
          this.offsetIntegral = clamp(this.offsetIntegral, -cap, cap);
        }
        steer -= p.pathKp * clamp(offset, -4, 4) + p.pathKi * this.offsetIntegral;
        // Slide catch: past a few degrees of slip, countersteer takes over.
        const w = clamp((Math.abs(beta) - p.catchBetaStart) / (p.catchBetaFull - p.catchBetaStart), 0, 1);
        this.lastCatch = w;
        if (w > 0) {
          const catchSteer = p.counterGain * beta - p.yawDamp * steerForYawRate(obs.yawRate - speed * kappa);
          steer = steer * (1 - w) + (steer * 0.5 + catchSteer) * w;
        }
        want.steering = toStick(steer);
        let targetSpeed = goal.fixedSpeed;
        if (targetSpeed === null) {
          // Plan speed a reaction time ahead of the car.
          plan.ahead(this.pathIndex, Math.max(1, speed * (p.reactionDelay + 0.15)), this.target);
          targetSpeed = Math.min(plan.speed[this.pathIndex], plan.speed[this.target.index]);
        }
        this.lastTargetSpeed = targetSpeed;
        this.speedControl(targetSpeed, vFwd, dt, want, 1 - 0.8 * w);
        break;
      }

      case 'recover': {
        const sliding = Math.abs(beta) > (5 * Math.PI) / 180 || Math.abs(obs.yawRate) > (10 * Math.PI) / 180;
        if (goal.calm < 0.6) {
          // Stage 1 — catch: front wheels toward the direction of travel,
          // steer against the rotation.
          goal.calm = sliding ? 0 : goal.calm + dt;
          want.steering = toStick(p.counterGain * beta - p.yawDamp * steerForYawRate(obs.yawRate));
          want.throttle = p.recoverThrottle;
          this.speedIntegral = 0;
        } else {
          // Stage 2 — resume: back onto the course, back up to speed.
          const courseRate = goal.course === null ? 0 : wrapAngle(goal.course - obs.yaw) / p.courseTime;
          want.steering = toStick(p.counterGain * beta + steerForYawRate(courseRate - p.yawDamp * obs.yawRate));
          if (goal.resumeSpeed === null) want.throttle = p.recoverThrottle;
          else this.speedControl(goal.resumeSpeed, vFwd, dt, want, 1);
          // Just caught a slide: never stab the brake, coast down instead.
          want.brake = 0;
        }
        break;
      }

      case 'driftHold': {
        // STEERING holds the angle. The front wheels are aimed relative to
        // where the FRONT AXLE is actually travelling (body slip plus the
        // yaw contribution at the axle), plus a slip angle into the turn:
        // a small bias that keeps the nose pulled round the arc, more when
        // the angle is too shallow, less (= more countersteer) when it is
        // too deep, and an integral that learns the car's own balance.
        const turn = goal.beta < 0 ? 1 : -1;
        const vLat = obs.vx * cos - obs.vz * sin;
        const frontTravel = Math.atan2(vLat + 0.55 * car.wheelbase * obs.yawRate, Math.max(vFwd, 3));
        const err = beta - goal.beta;
        const angle = Math.abs(beta);
        const missing = Math.abs(goal.beta) - angle;
        if (this.driftSpeed <= 0) this.driftSpeed = speed;
        if (dt > 0) {
          if (!Number.isNaN(this.driftPrevBeta)) {
            const rate = (angle - this.driftPrevBeta) / dt;
            this.driftBetaRate += (rate - this.driftBetaRate) * Math.min(1, dt / 0.06);
          }
          this.driftPrevBeta = angle;
          this.driftIntegral = clamp(this.driftIntegral + missing * dt, -0.8, 0.8);
          this.driftSteerIntegral = clamp(this.driftSteerIntegral + err * dt, -0.25, 0.25);
        }
        const steer = frontTravel + turn * p.driftSteerBias + p.driftSteerGain * err +
          p.driftSteerKi * this.driftSteerIntegral -
          p.driftYawDamp * steerForYawRate(obs.yawRate - this.yawRateSlow);
        want.steering = toStick(steer);
        // THROTTLE feeds the slide: more wheelspin = less rear side grip =
        // more angle. PI on the missing angle (finds this car's balance
        // throttle), minus anticipation of how fast the angle is growing.
        let throttle = p.driftThrottle + p.driftThrottleGain * missing + p.driftThrottleKi * this.driftIntegral -
          p.driftThrottleRate * this.driftBetaRate;
        // A drift is not a drag race: never chase a lost angle with speed.
        if (speed > 1.25 * this.driftSpeed) throttle = Math.min(throttle, 0.5 * p.driftThrottle);
        // Far past the target angle: that is a spin starting — lift.
        if (angle > Math.abs(goal.beta) + 0.5) throttle = 0;
        want.throttle = clamp(throttle, 0, 1);
        break;
      }
    }

    const delayed = this.delay.push(this.time, want, p.reactionDelay);
    if (steerIsAngle && car.stickForSteerAngle) {
      const act = this.acted;
      act.throttle = delayed.throttle;
      act.brake = delayed.brake;
      act.steering = clamp(car.stickForSteerAngle(delayed.steering * maxSteer), -1, 1);
      return this.hands.apply(act, dt);
    }
    return this.hands.apply(delayed, dt);
  }

  private speedControl(target: number, vFwd: number, dt: number, out: CarIntent, authority: number): void {
    const p = this.params;
    const err = target - vFwd;
    if (err < -p.brakeDeadband) {
      out.brake = clamp(p.brakeKp * (-err - p.brakeDeadband), 0, p.maxBrake);
      out.throttle = 0;
      this.speedIntegral = 0;
      return;
    }
    this.speedIntegral = clamp(this.speedIntegral + err * dt, -1, 2);
    out.throttle = clamp(p.speedKp * err + p.speedKi * this.speedIntegral, 0, p.maxThrottle) * authority;
  }
}
