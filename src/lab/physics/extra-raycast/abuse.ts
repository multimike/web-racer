/**
 * BREAK TESTS, part 1 — abuse a player would dish out. Written against the
 * 'raycast' model but model-agnostic (only the Vehicle interface is used), so
 * `model=rigid` gives a like-for-like comparison.
 *
 * Maneuver names (all start with `xr`):
 *   xrSaw         full-lock left-right sawing at top speed
 *   xrDonut       full throttle + full lock from standstill; lift; flip lock
 *   xrBrakeLock   slam brake + full lock (and the three-finger panic mash)
 *   xrReverse     full reverse → full forward, reverse + full lock, brake while
 *                 rolling BACKWARD (after a spin)
 *   xrAirLanding  landing sideways, on two wheels, nose first, tumbling
 *   xrBoulder     one wheel into a boulder / low ledge at 20 m/s and top speed
 *   xrSlope       30° side slope traverse + turns; resting on slopes for 30 s
 *   xrWall        nose into a wall at top speed, hold the throttle, reverse out
 *   xrInverted    upside down / on its side: explosions, creep, NaN
 *   xrHitch       frame hitches (one long frame) + 20 Hz / 144 Hz stepping
 *   xrRespawn     100 teleports in a row out of nasty states
 *   xrOffroad     full throttle hands-off straight across the hills terrain
 *   xrGameLoop    the render loop as written in createScene.ts below 30 fps
 *   xrMisc        steep / half-on ramps, sideways into a kerb, wake after 60 s,
 *                 a second car of the same model (T-bone, rear-end, head-on…)
 */
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import type { WorldSpec } from '../world';
import { FLAT, Report, fitCircle, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { Vector3 } from '@babylonjs/core';
import { createVehicle } from '../../../car/createVehicle';
import { Watchdog, addBox, lcg, placeOnRamp, placePose, runWatched, stepWith } from './kit';

type Metrics = Record<string, MetricValue>;

/** Time until |beta| < 5° and |yaw rate| < 10°/s have held for 0.5 s. */
async function settleTime(sim: Sim, dog: Watchdog, limit: number): Promise<number | null> {
  let calm = 0;
  const t0 = sim.time;
  let found: number | null = null;
  await runWatched(sim, dog, limit, (s) => {
    const tel = s.tel;
    if (Math.abs(tel.beta) < 5 * RAD && Math.abs(tel.yawRate) < 10 * RAD) {
      calm += s.dt;
      if (calm >= 0.5) {
        found = tel.t - t0 - 0.5;
        return true;
      }
    } else {
      calm = 0;
    }
    return false;
  });
  return found;
}

// ---------------------------------------------------------------------------
// xrSaw

async function sawCase(env: LabEnv, half: number, throttle: number) {
  return runCase(env, `half${Math.round(half * 100)}.thr${Math.round(throttle * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    const v0 = sim.vehicle.topSpeed;
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 1 });
    await sim.run(1.0);
    const keys = [];
    for (let k = 0; k * half < 8; k++) keys.push({ t: k * half, steering: k % 2 === 0 ? 1 : -1, throttle, brake: 0 });
    sim.useScript(keys);
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let minSpeed = Infinity;
    let maxYawRate = 0;
    let maxX = 0;
    await runWatched(sim, dog, 8, (s) => {
      minSpeed = Math.min(minSpeed, s.tel.speed);
      maxYawRate = Math.max(maxYawRate, Math.abs(s.tel.yawRate));
      maxX = Math.max(maxX, Math.abs(s.tel.x));
    });
    const sawBeta = sim.track.maxAbsBeta * DEG;
    const spun = sim.track.spun;
    const rolled = sim.track.rolledOver;
    const roll = sim.track.maxAbsRoll * DEG;
    const sideLift = sim.track.sideLiftTime;
    const endSpeed = sim.tel.speed;
    // Let go: how long until it runs straight again?
    sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
    const settle = await settleTime(sim, dog, 4);
    return {
      halfPeriod: half,
      throttle,
      entrySpeed: v0,
      maxBetaDeg: sawBeta,
      spun,
      rolledOver: rolled,
      maxRollDeg: roll,
      sideLiftTime: sideLift,
      minSpeed,
      endSpeed,
      maxYawRateDeg: maxYawRate * DEG,
      lateralUsed: maxX,
      settleAfterRelease: settle,
      ...dog.metrics(),
    };
  });
}

const xrSaw: ManeuverDef = {
  name: 'xrSaw',
  title: 'xr: full-lock left-right sawing at top speed (4 rhythms x throttle on/off)',
  async run(env) {
    const report = new Report();
    let worstBeta = 0;
    let spins = 0;
    let rolls = 0;
    let worstSettle = 0;
    let exploded = false;
    for (const half of [0.3, 0.5, 0.8, 1.2]) {
      for (const throttle of [1, 0]) {
        const c = await sawCase(env, half, throttle);
        report.cases.push(c);
        const m = c.metrics;
        worstBeta = Math.max(worstBeta, m.maxBetaDeg as number);
        if (m.spun) spins++;
        if (m.rolledOver) rolls++;
        if (m.exploded) exploded = true;
        worstSettle = Math.max(worstSettle, m.settleAfterRelease === null ? 99 : (m.settleAfterRelease as number));
      }
    }
    report.summary.worstBetaDeg = worstBeta;
    report.summary.spins = spins;
    report.summary.rollovers = rolls;
    report.summary.worstSettle = worstSettle;
    report.check('xrSaw.noRollover', rolls, '0 rollovers in 8 cases', rolls === 0);
    report.check('xrSaw.noSpin', spins, '0 spins (|beta| > 90 deg) in 8 cases', spins === 0);
    report.check('xrSaw.settle', worstSettle, 'runs straight < 1.5 s after letting go', worstSettle < 1.5);
    report.check('xrSaw.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrDonut

async function donutCase(env: LabEnv, throttle: number, after: 'release' | 'flip' | 'counter') {
  return runCase(env, `thr${Math.round(throttle * 100)}.${after}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    sim.useScript([{ t: 0, steering: 1, throttle, brake: 0 }]);
    sim.resetTrack();
    const dog = new Watchdog(sim);
    const xs: number[] = [];
    const zs: number[] = [];
    const betas: number[] = [];
    const speeds: number[] = [];
    const rates: number[] = [];
    await runWatched(sim, dog, 8, (s) => {
      if (s.time >= 4) {
        xs.push(s.tel.x);
        zs.push(s.tel.z);
        betas.push(-s.tel.beta * DEG);
        speeds.push(s.tel.speed);
        rates.push(s.tel.yawRate * DEG);
      }
    });
    const circle = fitCircle(xs, zs);
    const donutRoll = sim.track.maxAbsRoll * DEG;
    const donutLift = sim.track.sideLiftTime;
    const rolledInDonut = sim.track.rolledOver;
    const vDonut = sim.tel.speed;
    const betaBefore = -sim.tel.beta * DEG;
    sim.resetTrack();
    let settle: number | null = null;
    let peakAfter = 0;
    let reversedIn: number | null = null;
    if (after === 'release') {
      sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
      settle = await settleTime(sim, dog, 5);
    } else if (after === 'counter') {
      // Player catches it: opposite lock, lift.
      sim.useScript([{ t: 0, steering: -1, throttle: 0, brake: 0 }, { t: 0.4, steering: 0 }]);
      settle = await settleTime(sim, dog, 5);
    } else {
      // Figure of eight: flip the lock, foot stays down.
      sim.useScript([{ t: 0, steering: -1, throttle, brake: 0 }]);
      const t0 = sim.time;
      await runWatched(sim, dog, 5, (s) => {
        peakAfter = Math.max(peakAfter, Math.abs(s.tel.beta));
        if (reversedIn === null && s.tel.yawRate < -20 * RAD) reversedIn = s.tel.t - t0;
      });
    }
    return {
      throttle,
      radius: circle.r,
      radiusRms: circle.rms,
      speedMean: mean(speeds),
      speedStd: std(speeds),
      betaMeanDeg: mean(betas),
      betaStdDeg: std(betas),
      yawRateMeanDeg: mean(rates),
      yawRateStdDeg: std(rates),
      maxRollDeg: donutRoll,
      sideLiftTime: donutLift,
      rolledOver: rolledInDonut || sim.track.rolledOver,
      speedAtExit: vDonut,
      betaAtExitDeg: betaBefore,
      settleAfter: settle,
      spunAfter: sim.track.spun,
      flipPeakBetaDeg: after === 'flip' ? peakAfter * DEG : null,
      flipYawReversedIn: reversedIn,
      ...dog.metrics(),
    };
  });
}

const xrDonut: ManeuverDef = {
  name: 'xrDonut',
  title: 'xr: donuts — full lock + throttle from standstill 8 s, then release / countersteer / flip the lock',
  async run(env) {
    const report = new Report();
    let rolls = 0;
    let exploded = false;
    let worstSettle = 0;
    for (const throttle of [1, 0.7, 0.4]) {
      for (const after of ['release', 'counter', 'flip'] as const) {
        if (throttle !== 1 && after !== 'release') continue;
        const c = await donutCase(env, throttle, after);
        report.cases.push(c);
        const m = c.metrics;
        if (m.rolledOver) rolls++;
        if (m.exploded) exploded = true;
        if (after !== 'flip') worstSettle = Math.max(worstSettle, m.settleAfter === null ? 99 : (m.settleAfter as number));
        report.summary[`${c.id}.betaMeanDeg`] = m.betaMeanDeg;
        report.summary[`${c.id}.radius`] = m.radius;
        report.summary[`${c.id}.speedMean`] = m.speedMean;
      }
    }
    // Where between "drives a wide circle" and "donut" does the throttle flip it?
    const map: string[] = [];
    for (const throttle of [0.75, 0.8, 0.85, 0.9, 0.95]) {
      const c = await donutCase(env, throttle, 'release');
      report.cases.push(c);
      if (c.metrics.rolledOver) rolls++;
      map.push(`${throttle}: R ${(c.metrics.radius as number).toFixed(1)} m at ${(c.metrics.speedMean as number).toFixed(1)} m/s, beta ${(c.metrics.betaMeanDeg as number).toFixed(0)}`);
    }
    report.summary.throttleMap = map.join(' | ');
    const full = report.cases[0].metrics;
    report.check('xrDonut.noRollover', rolls, 'never flips', rolls === 0);
    report.check('xrDonut.isADonut', full.betaMeanDeg, 'full throttle + full lock from rest swings the tail out (beta > 15 deg)', (full.betaMeanDeg as number) > 15);
    report.check('xrDonut.steady', full.betaStdDeg, 'steady: beta std < 8 deg, radius rms < 1 m', (full.betaStdDeg as number) < 8 && (full.radiusRms as number) < 1);
    report.check('xrDonut.exit', worstSettle, 'straight < 2 s after release / countersteer', worstSettle < 2);
    report.check('xrDonut.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrBrakeLock

async function brakeLockCase(env: LabEnv, v0: number, mode: 'brakeLock' | 'mash' | 'lockThenBrake') {
  return runCase(env, `v${Math.round(v0)}.${mode}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 0.6 });
    await sim.run(0.5);
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    const yaw0 = sim.tel.yaw;
    const entry = sim.tel.speed;
    if (mode === 'brakeLock') sim.useScript([{ t: 0, steering: 1, throttle: 0, brake: 1 }]);
    else if (mode === 'mash') sim.useScript([{ t: 0, steering: 1, throttle: 1, brake: 1 }]);
    else sim.useScript([{ t: 0, steering: 1, throttle: 0, brake: 0 }, { t: 0.35, brake: 1 }]);
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let path = 0;
    let px = x0;
    let pz = z0;
    let stopT: number | null = null;
    const t0 = sim.time;
    await runWatched(sim, dog, 5, (s) => {
      path += Math.hypot(s.tel.x - px, s.tel.z - pz);
      px = s.tel.x;
      pz = s.tel.z;
      if (stopT === null && s.tel.speed < 0.3) stopT = s.tel.t - t0;
      // Judged up to the stop (+0.25 s): a brake still held after that may
      // legitimately turn into reverse (tuning.autoReverseDelay).
      return stopT !== null && s.tel.t - t0 > stopT + 0.25;
    });
    const ideal = (entry * entry) / (2 * sim.mug);
    return {
      entrySpeed: entry,
      stopDistance: path,
      idealDistance: ideal,
      distanceVsIdeal: path / ideal,
      stopTime: stopT,
      peakBetaDeg: sim.track.maxAbsBeta * DEG,
      yawChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      lateralMoved: sim.tel.x - x0,
      spun: sim.track.spun,
      rolledOver: sim.track.rolledOver,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      sideLiftTime: sim.track.sideLiftTime,
      creepAfterStop: Math.hypot(sim.tel.x - px, sim.tel.z - pz),
      endSpeed: sim.tel.speed,
      reversing: sim.vehicle.isReversing,
      ...dog.metrics(),
    };
  });
}

const xrBrakeLock: ManeuverDef = {
  name: 'xrBrakeLock',
  title: 'xr: slam brake + full lock at 15 m/s and top speed (also: all three at once, lock then brake)',
  async run(env) {
    const report = new Report();
    let spins = 0;
    let rolls = 0;
    let worstRatio = 0;
    let turned = 0;
    for (const v of [15, 24.5]) {
      for (const mode of ['brakeLock', 'mash', 'lockThenBrake'] as const) {
        const c = await brakeLockCase(env, v, mode);
        report.cases.push(c);
        const m = c.metrics;
        if (m.spun) spins++;
        if (m.rolledOver) rolls++;
        worstRatio = Math.max(worstRatio, m.stopTime === null ? 99 : (m.distanceVsIdeal as number));
        if (mode === 'brakeLock' && v > 20) turned = m.yawChangeDeg as number;
      }
    }
    report.summary.spins = spins;
    report.summary.rollovers = rolls;
    report.summary.worstDistanceVsIdeal = worstRatio;
    report.summary.topSpeedBrakeLockYawDeg = turned;
    report.check('xrBrakeLock.noSpin', spins, 'no spin in 6 cases', spins === 0);
    report.check('xrBrakeLock.noRollover', rolls, 'no rollover', rolls === 0);
    report.check('xrBrakeLock.stops', worstRatio, 'stops within 1.6 x v^2/(2 mu g)', worstRatio < 1.6);
    report.check('xrBrakeLock.stillSteers', turned, 'brake + lock at top speed still turns the car (> 10 deg of heading change)', Math.abs(turned) > 10);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrReverse

async function reverseCase(env: LabEnv, mode: 'thenForward' | 'lock' | 'lockThrottle') {
  return runCase(env, `reverse.${mode}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 1 }]);
    const dog = new Watchdog(sim);
    let tCap: number | null = null;
    let vMin = 0;
    await runWatched(sim, dog, 5, (s) => {
      vMin = Math.min(vMin, s.tel.vFwd);
      if (tCap === null && s.tel.vFwd < -0.95 * 0.5 * s.vehicle.topSpeed) tCap = s.tel.t;
    });
    const reverseSpeed = -sim.tel.vFwd;
    const yaw0 = sim.tel.yaw;
    const x0 = sim.tel.x;
    sim.resetTrack();
    const t0 = sim.time;
    let tStop: number | null = null;
    let t10: number | null = null;
    if (mode === 'thenForward') sim.useScript([{ t: 0, steering: 0, throttle: 1, brake: 0 }]);
    else if (mode === 'lock') sim.useScript([{ t: 0, steering: 1, throttle: 0, brake: 1 }]);
    else sim.useScript([{ t: 0, steering: 1, throttle: 1, brake: 0 }]);
    let maxYawRate = 0;
    await runWatched(sim, dog, 4, (s) => {
      if (tStop === null && s.tel.vFwd >= 0) tStop = s.tel.t - t0;
      if (t10 === null && s.tel.vFwd >= 10) t10 = s.tel.t - t0;
      maxYawRate = Math.max(maxYawRate, Math.abs(s.tel.yawRate));
    });
    return {
      reverseTopSpeed: reverseSpeed,
      reverseCapExpected: 0.5 * sim.vehicle.topSpeed,
      timeToReverseCap: tCap,
      timeToStop: tStop,
      timeToPlus10: t10,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      lateralMoved: sim.tel.x - x0,
      maxYawRateDeg: maxYawRate * DEG,
      sideLiftTime: sim.track.sideLiftTime,
      rolledOver: sim.track.rolledOver,
      endForwardSpeed: sim.tel.vFwd,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  });
}

/** After a spin the car rolls BACKWARD: what do the pedals do then? */
async function backwardCase(env: LabEnv, v0: number, pedal: 'brake' | 'throttle' | 'none' | 'both') {
  return runCase(env, `backward.v${v0}.${pedal}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0, beta: Math.PI });
    sim.useFixed({});
    await sim.run(0.2);
    const entry = sim.tel.speed;
    sim.useScript([{
      t: 0, steering: 0,
      throttle: pedal === 'throttle' || pedal === 'both' ? 1 : 0,
      brake: pedal === 'brake' || pedal === 'both' ? 1 : 0,
    }]);
    const dog = new Watchdog(sim);
    sim.resetTrack();
    const t0 = sim.time;
    let tStop: number | null = null;
    let v1 = entry;
    let dist = 0;
    let pz = sim.tel.z;
    await runWatched(sim, dog, 6, (s) => {
      if (tStop === null) dist += Math.abs(s.tel.z - pz);
      pz = s.tel.z;
      if (Math.abs(s.tel.t - t0 - 1.0) < s.dt / 2) v1 = s.tel.speed;
      if (tStop === null && s.tel.vFwd > -0.3) tStop = s.tel.t - t0;
      return tStop !== null && s.tel.t - t0 > tStop + 0.5;
    });
    return {
      entrySpeed: entry,
      pedal,
      speedAfter1s: v1,
      decelFirstSecondG: (entry - v1) / sim.gravity,
      timeToStop: tStop,
      distanceToStop: tStop === null ? null : dist,
      idealDistance: (entry * entry) / (2 * sim.mug),
      endForwardSpeed: sim.tel.vFwd,
      isReversingFlag: sim.vehicle.isReversing,
      peakBetaOffDeg: (Math.PI - Math.min(Math.PI, sim.track.maxAbsBeta)) * DEG,
      headingChangeDeg: sim.tel.yaw * DEG,
      ...dog.metrics(),
    };
  });
}

const xrReverse: ManeuverDef = {
  name: 'xrReverse',
  title: 'xr: full reverse then full forward; reverse + full lock; pedals while rolling backward',
  async run(env) {
    const report = new Report();
    let rolls = 0;
    for (const mode of ['thenForward', 'lock', 'lockThrottle'] as const) {
      const c = await reverseCase(env, mode);
      report.cases.push(c);
      if (c.metrics.rolledOver) rolls++;
    }
    const fwd = report.cases[0].metrics;
    report.check('xrReverse.noRollover', rolls, 'reverse abuse never flips the car', rolls === 0);
    report.check('xrReverse.toForward', fwd.timeToPlus10, 'full reverse -> +10 m/s in < 2 s, heading kept within 5 deg', fwd.timeToPlus10 !== null && (fwd.timeToPlus10 as number) < 2 && Math.abs(fwd.headingChangeDeg as number) < 5);
    for (const v of [8, 15, 22]) {
      for (const pedal of ['brake', 'throttle', 'none', 'both'] as const) {
        const c = await backwardCase(env, v, pedal);
        report.cases.push(c);
        report.summary[`${c.id}.decelG`] = c.metrics.decelFirstSecondG;
        report.summary[`${c.id}.timeToStop`] = c.metrics.timeToStop;
      }
    }
    const byId = (id: string) => report.cases.find((c) => c.id === id)!.metrics;
    for (const v of [15, 22]) {
      const b = byId(`backward.v${v}.brake`);
      const n = byId(`backward.v${v}.none`);
      report.check(
        `xrReverse.backwardBrake.v${v}`,
        b.decelFirstSecondG,
        'rolling backward (after a spin) the BRAKE trigger slows the car: > 0.5 g more than coasting',
        // (a car that STOPS inside the first second cannot show more than v / 1 s)
        (b.decelFirstSecondG as number) - (n.decelFirstSecondG as number) > 0.5 ||
          (typeof b.timeToStop === 'number' && b.timeToStop < 1),
      );
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrAirLanding

interface AirCase {
  id: string;
  /** Drop height, m. */
  h: number;
  speed: number;
  /** Heading relative to the direction of travel (+z), deg. */
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  /** Angular velocity in the air, rad/s (world). */
  wx?: number;
  wy?: number;
  wz?: number;
  /** A clean landing is expected (checked). */
  mustLand: boolean;
}

const AIR_CASES: AirCase[] = [
  { id: 'level.h1.5', h: 1.5, speed: 15, mustLand: true },
  { id: 'level.h6', h: 6, speed: 0, mustLand: true },
  { id: 'level.h6.v20', h: 6, speed: 20, mustLand: true },
  { id: 'yaw20.h1.5', h: 1.5, speed: 15, yawDeg: 20, mustLand: true },
  { id: 'yaw45.h1.5', h: 1.5, speed: 15, yawDeg: 45, mustLand: true },
  { id: 'yaw90.h1.5', h: 1.5, speed: 15, yawDeg: 90, mustLand: false },
  { id: 'yaw90.h1.5.v22', h: 1.5, speed: 22, yawDeg: 90, mustLand: false },
  { id: 'yaw90.h0.5.v10', h: 0.5, speed: 10, yawDeg: 90, mustLand: true },
  { id: 'yaw180.h1.5', h: 1.5, speed: 15, yawDeg: 180, mustLand: true },
  { id: 'roll20.h1.5', h: 1.5, speed: 15, rollDeg: 20, mustLand: true },
  { id: 'roll35.h1.5', h: 1.5, speed: 15, rollDeg: 35, mustLand: true },
  { id: 'roll50.h1.5', h: 1.5, speed: 15, rollDeg: 50, mustLand: false },
  { id: 'roll35.yaw30.h1.5', h: 1.5, speed: 15, rollDeg: 35, yawDeg: 30, mustLand: false },
  { id: 'noseDown30.h1.5', h: 1.5, speed: 15, pitchDeg: 30, mustLand: true },
  { id: 'noseDown50.h2', h: 2, speed: 15, pitchDeg: 50, mustLand: false },
  { id: 'tailDown30.h1.5', h: 1.5, speed: 15, pitchDeg: -30, mustLand: true },
  { id: 'tailDown50.h2', h: 2, speed: 15, pitchDeg: -50, mustLand: false },
  { id: 'yawSpin4.h1.5', h: 1.5, speed: 15, wy: 4, mustLand: true },
  { id: 'rollSpin3.h1.5', h: 1.5, speed: 15, wz: 3, mustLand: false },
];

async function airCase(env: LabEnv, a: AirCase, hitch = 0) {
  return runCase(env, hitch > 0 ? `${a.id}.hitch${Math.round(hitch * 1000)}` : a.id, FLAT, async (sim): Promise<Metrics> => {
    // Extra lift so a rolled / pitched car starts clear of the ground.
    const tiltLift = 1.2 * Math.max(Math.abs(Math.sin((a.rollDeg ?? 0) * RAD)), Math.abs(Math.sin((a.pitchDeg ?? 0) * RAD)));
    sim.place({ x: 0, z: 0, yaw: 0 });
    const rest = sim.tel.y;
    placePose(sim, {
      x: 0, z: 0, lift: a.h + tiltLift,
      yaw: (a.yawDeg ?? 0) * RAD, pitch: (a.pitchDeg ?? 0) * RAD, roll: (a.rollDeg ?? 0) * RAD,
      vz: a.speed, wx: a.wx, wy: a.wy, wz: a.wz,
    });
    sim.useFixed({});
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let touched: number | null = null;
    let maxReboundY = 0;
    let bounceAir = 0;
    let settled: number | null = null;
    let calm = 0;
    let hitchDone = hitch <= 0;
    const total = 6;
    while (sim.time < total) {
      // One long frame just before touchdown (lowest wheel within 0.5 m).
      let lowest = Infinity;
      for (const w of sim.vehicle.wheelStates) lowest = Math.min(lowest, w.position.y - w.radius);
      if (!hitchDone && touched === null && lowest < 0.5) {
        stepWith(sim, hitch);
        hitchDone = true;
      } else {
        sim.step();
      }
      dog.see();
      const tel = sim.tel;
      if (touched === null && tel.wheelsOff < 4) touched = tel.t;
      if (touched !== null && tel.t > touched + 0.15) {
        maxReboundY = Math.max(maxReboundY, tel.y - rest);
        if (tel.wheelsOff === 4) bounceAir += sim.dt;
      }
      if (touched !== null && settled === null) {
        calm = tel.speed < 0.5 && Math.abs(tel.vy) < 0.3 ? calm + sim.dt : 0;
        if (calm > 0.3) settled = tel.t - touched;
      }
      if (settled !== null && tel.t > touched! + settled + 0.5) break;
    }
    const upright = sim.tel.tilt < 25 * RAD;
    return {
      dropHeight: a.h,
      speed: a.speed,
      touchdownAt: touched,
      endTiltDeg: sim.tel.tilt * DEG,
      landsUpright: upright && !sim.track.rolledOver,
      wentOver75: sim.track.rolledOver,
      endsOnWheels: upright,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      reboundHeight: maxReboundY,
      bounceAirTime: bounceAir,
      endSpeed: sim.tel.speed,
      settledAfter: settled,
      mustLand: a.mustLand,
      ...dog.metrics(),
    };
  });
}

const xrAirLanding: ManeuverDef = {
  name: 'xrAirLanding',
  title: 'xr: landings — sideways, on two wheels, nose / tail first, spinning in the air',
  async run(env) {
    const report = new Report();
    let exploded = false;
    let mustFail = 0;
    const failed: string[] = [];
    let over = 0;
    let ended = 0;
    for (const a of AIR_CASES) {
      const c = await airCase(env, a);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      if (!m.landsUpright) {
        over++;
        failed.push(a.id);
        if (a.mustLand) mustFail++;
      }
      if (!m.endsOnWheels) ended++;
      report.summary[`${a.id}.endTiltDeg`] = m.endTiltDeg;
    }
    report.summary.crashed = failed.join(', ') || 'none';
    report.summary.crashedCount = over;
    report.summary.endOffWheels = ended;
    report.check('xrAirLanding.reasonable', mustFail, 'every landing a player would expect to survive ends upright (level, <= 45 deg yawed, <= 35 deg rolled, <= 30 deg pitched)', mustFail === 0);
    report.check('xrAirLanding.all', `${over} of ${AIR_CASES.length}: ${failed.join(', ') || 'none'}`, 'info: landings that went past 75 deg of tilt', true);
    report.check('xrAirLanding.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrBoulder

export async function boulderCase(env: LabEnv, id: string, v: number, spec: WorldSpec, zObstacle: number, dt: number = env.dt) {
  return runCase(env, id, spec, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: zObstacle - 1.5 * v, yaw: 0, speed: v });
    sim.useFixed({ throttle: 0.5 });
    sim.resetTrack();
    const dog = new Watchdog(sim);
    const restY = sim.tel.y;
    let kick = 0;
    let minSpeed = v;
    let maxDev = 0;
    let air = 0;
    await runWatched(sim, dog, 6, (s) => {
      const tel = s.tel;
      if (tel.z > zObstacle - 3) {
        kick = Math.max(kick, Math.abs(tel.yaw));
        minSpeed = Math.min(minSpeed, tel.speed);
        maxDev = Math.max(maxDev, Math.abs(tel.x));
        if (tel.wheelsOff === 4) air += s.dt;
      }
      return tel.z > zObstacle + 2.5 * v || (tel.t > 2 && tel.speed < 0.3);
    });
    return {
      speed: v,
      passed: sim.tel.z > zObstacle + 5,
      headingKickDeg: kick * DEG,
      lateralDeviation: maxDev,
      speedLostPct: (1 - minSpeed / v) * 100,
      hopHeight: dog.maxY - restY,
      airTime: air,
      maxTiltDeg: sim.track.maxTilt * DEG,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      rolledOver: sim.track.rolledOver,
      spun: sim.track.spun,
      endsUpright: sim.tel.tilt < 25 * RAD && !sim.track.rolledOver,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  }, dt);
}

const xrBoulder: ManeuverDef = {
  name: 'xrBoulder',
  title: 'xr: one front wheel square into a boulder / ledge / kerb at 20 m/s and top speed',
  async run(env) {
    const report = new Report();
    const wheelX = env.rig ? env.rig.front.track / 2 : 0.84;
    let rolls = 0;
    let exploded = false;
    let worstHop = 0;
    let worstKick = 0;
    const z = 60;
    const obstacles: Array<{ name: string; spec: WorldSpec }> = [
      // Half-buried boulders (dome 0.35 / 0.5 m tall) and the lab's standard one (0.7 m tall).
      { name: 'dome35', spec: { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.35, centerY: 0 }] } },
      { name: 'dome50', spec: { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0 }] } },
      { name: 'rock70', spec: { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 }] } },
      // Square kerbs under the left wheels only.
      { name: 'kerb15', spec: { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.4, height: 0.15 }] } },
      { name: 'kerb30', spec: { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.4, height: 0.3 }] } },
      // Boulder dead centre between the wheels (hull strike).
      { name: 'centre50', spec: { kind: 'flat', obstacles: [{ type: 'boulder', x: 0, z, radius: 0.5, centerY: 0 }] } },
    ];
    for (const o of obstacles) {
      for (const v of [20, 24.5]) {
        const c = await boulderCase(env, `${o.name}.v${Math.round(v)}`, v, o.spec, z);
        report.cases.push(c);
        const m = c.metrics;
        if (!m.endsUpright) rolls++;
        if (m.exploded) exploded = true;
        worstHop = Math.max(worstHop, m.hopHeight as number);
        worstKick = Math.max(worstKick, m.headingKickDeg as number);
        report.summary[`${c.id}`] = `${m.endsUpright ? 'upright' : 'CRASHED'}, kick ${Math.round(m.headingKickDeg as number)} deg, hop ${(m.hopHeight as number).toFixed(2)} m, tilt ${Math.round(m.maxTiltDeg as number)} deg, -${Math.round(m.speedLostPct as number)} %`;
      }
    }
    report.summary.crashes = rolls;
    report.summary.worstHop = worstHop;
    report.summary.worstKickDeg = worstKick;
    report.check('xrBoulder.upright', rolls, 'all 12 strikes end upright', rolls === 0);
    report.check('xrBoulder.hop', worstHop, 'chassis is never thrown more than 1.5 m up', worstHop < 1.5);
    report.check('xrBoulder.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrSlope

const SIDE_RAMP = { x: -10, z: 0, yaw: Math.PI / 2 };

function sideSlope(angleDeg: number): WorldSpec {
  // Rises toward +x; 400 m long in z, 40 m up the slope.
  return { kind: 'flat', obstacles: [{ type: 'ramp', x: SIDE_RAMP.x, z: SIDE_RAMP.z, yaw: SIDE_RAMP.yaw, angleDeg, width: 400, length: 40 }] };
}

async function traverseCase(env: LabEnv, angleDeg: number, v: number, steer: number) {
  return runCase(env, `traverse${angleDeg}.v${v}.s${Math.round(steer * 100)}`, sideSlope(angleDeg), async (sim): Promise<Metrics> => {
    const ramp = { ...SIDE_RAMP, angleDeg };
    placeOnRamp(sim, ramp, 15, 150, 0, v);
    const up0 = sim.tel.x;
    sim.useFixed({ throttle: 0.35, steering: 0 });
    const dog = new Watchdog(sim);
    await runWatched(sim, dog, 0.5);
    sim.useScript([{ t: 0, steering: steer, throttle: 0.35, brake: 0 }]);
    sim.resetTrack();
    const slopeTilt = angleDeg * RAD;
    let maxExtraTilt = 0;
    let onSlope = true;
    await runWatched(sim, dog, 3.5, (s) => {
      // Still on the slope face (not run off its top / bottom edge)?
      const h = s.tel.x - SIDE_RAMP.x;
      if (h < 2 || h > 32) onSlope = false;
      if (onSlope) maxExtraTilt = Math.max(maxExtraTilt, Math.abs(s.tel.tilt - slopeTilt));
      return !onSlope;
    });
    return {
      slopeDeg: angleDeg,
      speed: v,
      steer,
      // + = slid / steered DOWNHILL (slope rises toward +x).
      downhillDrift: up0 - sim.tel.x,
      yawChangeDeg: sim.tel.yaw * DEG,
      maxTiltOffSlopeDeg: maxExtraTilt * DEG,
      rolledOver: sim.tel.tilt > 75 * RAD || dog.maxTilt > 75 * RAD,
      stayedOnSlopeFace: onSlope,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  });
}

async function slopeRestCase(env: LabEnv, angleDeg: number, facing: 'up' | 'down' | 'side', pedal: 'none' | 'brakeHeld') {
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: 0, yaw: 0, angleDeg, width: 30, length: 60 }] };
  return runCase(env, `rest${angleDeg}.${facing}.${pedal}`, spec, async (sim): Promise<Metrics> => {
    const heading = facing === 'up' ? 0 : facing === 'down' ? Math.PI : Math.PI / 2;
    placeOnRamp(sim, { x: 0, z: 0, yaw: 0, angleDeg }, 25, 0, heading, 0);
    const dog = new Watchdog(sim);
    if (pedal === 'brakeHeld') {
      // Arrive rolling (2 m/s forward along the heading) and stop on the brake, then hold it.
      placeOnRamp(sim, { x: 0, z: 0, yaw: 0, angleDeg }, 25, 0, heading, 2);
      sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 1 }]);
    } else {
      sim.useFixed({});
    }
    // 2 s to settle on the springs, then 30 s of rest.
    await runWatched(sim, dog, 2);
    const x0 = sim.tel.x;
    const y0 = sim.tel.y;
    const z0 = sim.tel.z;
    let maxSpeed = 0;
    let d5 = 0;
    await runWatched(sim, dog, 30, (s) => {
      maxSpeed = Math.max(maxSpeed, s.tel.speed);
      if (Math.abs(s.time - 7) < s.dt / 2) d5 = Math.hypot(s.tel.x - x0, s.tel.y - y0, s.tel.z - z0);
      return Math.hypot(s.tel.x - x0, s.tel.z - z0) > 15;
    });
    const moved = Math.hypot(sim.tel.x - x0, sim.tel.y - y0, sim.tel.z - z0);
    return {
      slopeDeg: angleDeg,
      facing,
      pedal,
      movedIn30s: moved,
      movedIn5s: d5,
      maxSpeed,
      endSpeed: sim.tel.speed,
      ranAway: moved > 15 || Math.hypot(sim.tel.x - x0, sim.tel.z - z0) > 15,
      reversingFlag: sim.vehicle.isReversing,
      endTiltDeg: sim.tel.tilt * DEG,
      ...dog.metrics(),
    };
  });
}

const xrSlope: ManeuverDef = {
  name: 'xrSlope',
  title: 'xr: 30 deg side slope traverse / turns, and resting on 15-35 deg slopes for 30 s',
  async run(env) {
    const report = new Report();
    let rolls = 0;
    for (const [angle, v, steer] of [[30, 10, 0], [30, 18, 0], [30, 12, 1], [30, 12, -1], [30, 20, 1], [30, 20, -1], [20, 18, 1], [20, 18, -1]] as const) {
      const c = await traverseCase(env, angle, v, steer);
      report.cases.push(c);
      if (c.metrics.rolledOver) rolls++;
      report.summary[`${c.id}.downhillDrift`] = c.metrics.downhillDrift;
      report.summary[`${c.id}.rolledOver`] = c.metrics.rolledOver;
    }
    const straight = report.cases[1].metrics;
    report.check('xrSlope.traverseNoRoll', rolls, 'no rollover traversing / turning on a 20-30 deg side slope', rolls === 0);
    report.check('xrSlope.traverseHolds', straight.downhillDrift, '30 deg side slope at 18 m/s hands-off: < 6 m downhill in 3.5 s (gravity alone would give 77 m)', Math.abs(straight.downhillDrift as number) < 6);
    let creepers = 0;
    let worstCreep = 0;
    for (const angle of [15, 25, 30, 35]) {
      for (const facing of ['up', 'down', 'side'] as const) {
        const c = await slopeRestCase(env, angle, facing, 'none');
        report.cases.push(c);
        const m = c.metrics;
        report.summary[`${c.id}.movedIn30s`] = m.movedIn30s;
        if (angle <= 30) {
          worstCreep = Math.max(worstCreep, m.movedIn30s as number);
          if ((m.movedIn30s as number) > 0.1) creepers++;
        }
      }
    }
    for (const angle of [15, 30]) {
      for (const facing of ['up', 'down'] as const) {
        const c = await slopeRestCase(env, angle, facing, 'brakeHeld');
        report.cases.push(c);
        report.summary[`${c.id}.movedIn30s`] = c.metrics.movedIn30s;
      }
    }
    report.summary.worstCreepUpTo30 = worstCreep;
    report.check('xrSlope.rest30s', worstCreep, 'hands-off on 15 / 25 / 30 deg slopes (any facing): moves < 0.1 m in 30 s', creepers === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrWall

export interface WallCase {
  id: string;
  /** Approach speed (m/s); negative = reversing into it. */
  v: number;
  build(sim: Sim, z: number): void;
  /** Car heading relative to the wall normal, deg. */
  yawDeg?: number;
}

export function wallCases(env: LabEnv): WallCase[] {
  const halfTrack = env.rig ? env.rig.front.track / 2 : 0.84;
  return [
    { id: 'headOn.top', v: 24.5, build: (sim, z) => addBox(sim, 'Wall', [0, 1.5, z + 0.5], [30, 3, 1]) },
    { id: 'headOn.v12', v: 12, build: (sim, z) => addBox(sim, 'Wall', [0, 1.5, z + 0.5], [30, 3, 1]) },
    { id: 'angled45.top', v: 24.5, yawDeg: 45, build: (sim, z) => addBox(sim, 'Wall', [0, 1.5, z + 0.5], [80, 3, 1]) },
    { id: 'angled20.top', v: 24.5, yawDeg: 70, build: (sim, z) => addBox(sim, 'Wall', [0, 1.5, z + 0.5], [200, 3, 1]) },
    // Wall end covers only the left front wheel.
    { id: 'offsetLeftWheel.top', v: 24.5, build: (sim, z) => addBox(sim, 'Wall', [-halfTrack - 5 + 0.25, 1.5, z + 0.5], [10, 3, 1]) },
    { id: 'offsetLeftWheel.v15', v: 15, build: (sim, z) => addBox(sim, 'Wall', [-halfTrack - 5 + 0.25, 1.5, z + 0.5], [10, 3, 1]) },
    // Thin post (0.3 m) dead centre, and on the left wheel.
    { id: 'postCentre.top', v: 24.5, build: (sim, z) => addBox(sim, 'Post', [0, 1.5, z + 0.15], [0.3, 3, 0.3]) },
    { id: 'postLeftWheel.v20', v: 20, build: (sim, z) => addBox(sim, 'Post', [-halfTrack, 1.5, z + 0.15], [0.3, 3, 0.3]) },
    // Low walls: below / around hub height.
    { id: 'low25.top', v: 24.5, build: (sim, z) => addBox(sim, 'Wall', [0, 0.125, z + 0.5], [30, 0.25, 1]) },
    { id: 'low45.top', v: 24.5, build: (sim, z) => addBox(sim, 'Wall', [0, 0.225, z + 0.5], [30, 0.45, 1]) },
    { id: 'low60.top', v: 24.5, build: (sim, z) => addBox(sim, 'Wall', [0, 0.3, z + 0.5], [30, 0.6, 1]) },
    { id: 'reverseInto', v: -12, build: (sim, z) => addBox(sim, 'Wall', [0, 1.5, z - 0.5], [30, 3, 1]) },
  ];
}

export async function wallCase(env: LabEnv, w: WallCase, dt: number = env.dt) {
  return runCase(env, w.id, FLAT, async (sim): Promise<Metrics> => {
    const reverse = w.v < 0;
    const v = Math.abs(w.v);
    const zWall = reverse ? -30 : 40;
    w.build(sim, zWall);
    const yaw = (w.yawDeg ?? 0) * RAD;
    // Approach so the car's centre line meets the wall face at x = 0.
    const run = reverse ? 0 : 1.0 * v;
    if (reverse) sim.place({ x: 0, z: 0, yaw: 0 });
    else sim.place({ x: -Math.sin(yaw) * run, z: zWall - Math.cos(yaw) * run - 2.2, yaw, speed: v });
    const dog = new Watchdog(sim);
    sim.resetTrack();
    if (reverse) {
      sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 1 }]);
    } else {
      sim.useFixed({ throttle: 1 });
    }
    let impactSpeed = 0;
    let impactT: number | null = null;
    let maxZ = -Infinity;
    let minZ = Infinity;
    let prevSpeed = sim.tel.speed;
    let rebound = 0;
    let bounce = 0;
    // Phase 1: drive in, keep the pedal down for 2 s after the impact.
    await runWatched(sim, dog, 8, (s) => {
      const tel = s.tel;
      maxZ = Math.max(maxZ, tel.z);
      minZ = Math.min(minZ, tel.z);
      if (impactT === null && prevSpeed > 0.6 * v && tel.speed < prevSpeed - 2.5) {
        impactT = tel.t;
        impactSpeed = prevSpeed;
      }
      prevSpeed = tel.speed;
      if (impactT !== null) {
        const away = reverse ? tel.vz : -(tel.vx * Math.sin(yaw) + tel.vz * Math.cos(yaw));
        rebound = Math.max(rebound, away);
        // The bounce itself: the first 0.3 s (later the held pedal is
        // driving the car again, possibly away from the wall).
        if (tel.t <= impactT + 0.3) bounce = Math.max(bounce, away);
      }
      return impactT !== null && tel.t > impactT + 2;
    });
    const hit = impactT !== null;
    const pinnedSpeed = sim.tel.speed;
    const pinnedTilt = sim.tel.tilt * DEG;
    const pinnedPitch = sim.tel.pitch * DEG;
    const wheelsOffPinned = sim.tel.wheelsOff;
    const through = reverse ? sim.tel.z < zWall - 1.5 : sim.tel.z > zWall + 1.5;
    // Phase 2: let go for 0.5 s, then back out (reverse = press the brake from rest; after a reverse hit: throttle).
    sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
    await runWatched(sim, dog, 0.6);
    const x1 = sim.tel.x;
    const z1 = sim.tel.z;
    sim.useScript(reverse ? [{ t: 0, steering: 0, throttle: 1, brake: 0 }] : [{ t: 0, steering: 0, throttle: 0, brake: 1 }]);
    await runWatched(sim, dog, 2);
    const backedOut = Math.hypot(sim.tel.x - x1, sim.tel.z - z1);
    return {
      approachSpeed: w.v,
      hit,
      impactSpeed,
      reboundSpeed: rebound,
      bounceSpeed: bounce,
      pedalHeldSpeed: pinnedSpeed,
      pedalHeldTiltDeg: pinnedTilt,
      pedalHeldPitchDeg: pinnedPitch,
      wheelsOffWhilePinned: wheelsOffPinned,
      wentThroughOrOver: through,
      backedOutIn2s: backedOut,
      freed: backedOut > 2,
      maxTiltDeg: sim.track.maxTilt * DEG,
      rolledOver: sim.track.rolledOver,
      endTiltDeg: sim.tel.tilt * DEG,
      endsUpright: sim.tel.tilt < 25 * RAD,
      spun: sim.track.spun,
      ...dog.metrics(),
    };
  }, dt);
}

const xrWall: ManeuverDef = {
  name: 'xrWall',
  title: 'xr: into a wall at top speed (head-on, angled, offset, post, low walls, in reverse), pedal held, then back out',
  async run(env) {
    const report = new Report();
    let exploded = false;
    let stuck = 0;
    let down = 0;
    let through = 0;
    const notes: string[] = [];
    for (const w of wallCases(env)) {
      const c = await wallCase(env, w);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      const solid = !w.id.startsWith('low') && !w.id.startsWith('post') && !w.id.startsWith('angled');
      if (solid && m.hit && !m.freed) {
        stuck++;
        notes.push(`${w.id}: not freed (${(m.backedOutIn2s as number).toFixed(2)} m)`);
      }
      if (!m.endsUpright) {
        down++;
        notes.push(`${w.id}: ends ${Math.round(m.endTiltDeg as number)} deg tilted`);
      }
      if (solid && m.wentThroughOrOver) {
        through++;
        notes.push(`${w.id}: went through / over`);
      }
      report.summary[w.id] = `${m.hit ? `hit at ${(m.impactSpeed as number).toFixed(1)}` : 'no impact seen'}, rebound ${(m.reboundSpeed as number).toFixed(1)} m/s, max tilt ${Math.round(m.maxTiltDeg as number)} deg, backs out ${(m.backedOutIn2s as number).toFixed(1)} m${m.wentThroughOrOver ? ', PAST THE WALL' : ''}`;
    }
    report.summary.notes = notes.join(' | ') || 'none';
    report.check('xrWall.sane', exploded, 'no NaN / explosion (speed < 45 m/s, spin < 25 rad/s)', !exploded);
    report.check('xrWall.noTunnel', through, 'never ends up on the far side of a 3 m wall', through === 0);
    report.check('xrWall.upright', down, 'ends upright in every case', down === 0);
    report.check('xrWall.backsOut', stuck, 'after a solid-wall hit the car backs out > 2 m in 2 s', stuck === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrInverted

async function invertedCase(env: LabEnv, id: string, rollDeg: number, pitchDeg: number, vz: number) {
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    placePose(sim, { x: 0, z: 0, lift: 2.2, roll: rollDeg * RAD, pitch: pitchDeg * RAD, vz });
    sim.useFixed({});
    sim.resetTrack();
    const dog = new Watchdog(sim);
    // 3 s to come to rest (how long does it take?), then 5 s idle.
    let restAt = 0;
    await runWatched(sim, dog, 3, (s) => {
      if (Math.hypot(s.tel.speed, s.tel.vy) > 0.2 || dog.maxAngSpeed > 0 && Math.abs(s.tel.yawRate) > 0.1) restAt = s.tel.t;
    });
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    let idleMax = 0;
    await runWatched(sim, dog, 5, (s) => {
      idleMax = Math.max(idleMax, s.tel.speed);
    });
    const idleCreep = Math.hypot(sim.tel.x - x0, sim.tel.z - z0);
    const idleTilt = sim.tel.tilt * DEG;
    // 5 s of a player mashing everything.
    const keys = [];
    for (let k = 0; k < 10; k++) keys.push({ t: k * 0.5, steering: k % 2 ? -1 : 1, throttle: k % 3 === 2 ? 0 : 1, brake: k % 3 === 2 ? 1 : 0 });
    sim.useScript(keys);
    let mashMax = 0;
    let maxSpin = 0;
    await runWatched(sim, dog, 5, (s) => {
      mashMax = Math.max(mashMax, s.tel.speed);
      for (const w of s.vehicle.wheelStates) maxSpin = Math.max(maxSpin, Math.abs(w.spinSpeed * w.radius));
    });
    const mashMoved = Math.hypot(sim.tel.x - x0, sim.tel.z - z0);
    sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
    await runWatched(sim, dog, 3);
    return {
      startRollDeg: rollDeg,
      startPitchDeg: pitchDeg,
      idleTiltDeg: idleTilt,
      lastMotionAt: restAt,
      idleMaxSpeed: idleMax,
      idleCreep5s: idleCreep,
      mashMaxSpeed: mashMax,
      mashMoved,
      wheelRimSpeedMax: maxSpin,
      endTiltDeg: sim.tel.tilt * DEG,
      endSpeed: sim.tel.speed,
      endsOnWheels: sim.tel.tilt < 25 * RAD,
      ...dog.metrics(),
    };
  });
}

const xrInverted: ManeuverDef = {
  name: 'xrInverted',
  title: 'xr: dropped upside down / on its side / on its nose: rest, mash the controls',
  async run(env) {
    const report = new Report();
    let exploded = false;
    let creep = 0;
    let stuckOff = 0;
    for (const [id, roll, pitch, vz] of [
      ['roof', 180, 0, 0], ['roof.v15', 180, 0, 15], ['side', 90, 0, 0], ['side.v15', 90, 0, 15],
      ['side100', 100, 0, 0], ['side120', 120, 0, 0], ['nose', 0, 90, 0], ['nose80', 0, 80, 0], ['nose100', 0, 100, 0],
      ['tail', 0, -90, 0], ['roof.tilted', 160, 20, 5],
    ] as const) {
      const c = await invertedCase(env, id, roll, pitch, vz);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      if (vz === 0) creep = Math.max(creep, m.idleCreep5s as number);
      if (!m.endsOnWheels) stuckOff++;
      report.summary[id] = `rests at ${Math.round(m.idleTiltDeg as number)} deg, idle creep ${(m.idleCreep5s as number).toFixed(3)} m, mash: max ${(m.mashMaxSpeed as number).toFixed(2)} m/s, moved ${(m.mashMoved as number).toFixed(2)} m, ends ${Math.round(m.endTiltDeg as number)} deg`;
    }
    report.summary.endOffWheels = stuckOff;
    report.check('xrInverted.sane', exploded, 'no NaN / explosion', !exploded);
    report.check('xrInverted.rests', creep, 'a car dropped at rest in a bad attitude lies still (< 0.05 m creep in 5 s)', creep < 0.05);
    report.check('xrInverted.selfRights', stuckOff, 'info: cases that end off their wheels (the game needs a respawn for these)', true);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrHitch — frame-length abuse.

type Pattern = { name: string; dtAt(step: number, base: number): number };

const PATTERNS: Pattern[] = [
  { name: 'clean', dtAt: (_s, base) => base },
  // What the game loop passes on when a frame takes 0.2 s: one 1/30 step.
  { name: 'hitch30.every0.5s', dtAt: (s, base) => (s % 30 === 15 ? 1 / 30 : base) },
  { name: 'alternate60.30', dtAt: (s, base) => (s % 2 ? 1 / 30 : base) },
  { name: 'jitter', dtAt: (s) => [1 / 60, 1 / 90, 1 / 45, 1 / 72, 1 / 30, 1 / 120][s % 6] },
  // Unclamped long frames (what happens if the clamp is ever removed / on XR reprojection).
  { name: 'one0.1s', dtAt: (s, base) => (s === 60 ? 0.1 : base) },
  { name: 'one0.2s', dtAt: (s, base) => (s === 60 ? 0.2 : base) },
  { name: 'fixed20Hz', dtAt: () => 1 / 20 },
  { name: 'fixed144Hz', dtAt: () => 1 / 144 },
  { name: 'fixed240Hz', dtAt: () => 1 / 240 },
];

async function hitchCornerCase(env: LabEnv, p: Pattern) {
  return runCase(env, `corner.${p.name}`, FLAT, async (sim): Promise<Metrics> => {
    // Open loop: 15 m/s, fixed 55 % throttle, full lock for 3 s.
    sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
    sim.useScript([{ t: 0, steering: 1, throttle: 0.55, brake: 0 }]);
    sim.resetTrack();
    const dog = new Watchdog(sim);
    const rates: number[] = [];
    const lats: number[] = [];
    const speeds: number[] = [];
    let step = 0;
    while (sim.time < 3) {
      stepWith(sim, p.dtAt(step++, 1 / 60));
      dog.see();
      if (sim.time > 2) {
        rates.push(sim.tel.yawRate * DEG);
        lats.push(Math.abs(sim.tel.aCent) / sim.mug);
        speeds.push(sim.tel.speed);
      }
    }
    return {
      pattern: p.name,
      yawRateSteadyDeg: mean(rates),
      latSteadyFraction: mean(lats),
      speedSteady: mean(speeds),
      peakBetaDeg: sim.track.maxAbsBeta * DEG,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      spun: sim.track.spun,
      endX: sim.tel.x,
      endZ: sim.tel.z,
      ...dog.metrics(),
    };
  });
}

async function hitchSlideCase(env: LabEnv, p: Pattern) {
  return runCase(env, `slide35.${p.name}`, FLAT, async (sim): Promise<Metrics> => {
    // Hands-off 35° slide (no driver: pure model).
    const b = 35 * RAD;
    sim.place({ x: 0, z: 0, yaw: b, speed: 15, beta: -b, yawRate: b });
    sim.useFixed({});
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let step = 0;
    let calm = 0;
    let rec: number | null = null;
    // Hitch patterns index from step 60; shift so the long frame lands mid-slide.
    while (sim.time < 3) {
      const dt = p.dtAt(step + 50, 1 / 60);
      step++;
      stepWith(sim, dt);
      dog.see();
      if (rec === null) {
        calm = Math.abs(sim.tel.beta) < 5 * RAD && Math.abs(sim.tel.yawRate) < 10 * RAD ? calm + dt : 0;
        if (calm >= 0.5) rec = sim.time - calm;
      }
    }
    return {
      pattern: p.name,
      recoveryTime: rec,
      peakBetaDeg: sim.track.maxAbsBeta * DEG,
      endYawDeg: sim.tel.yaw * DEG,
      endX: sim.tel.x,
      spun: sim.track.spun,
      ...dog.metrics(),
    };
  });
}

async function hitchRestCase(env: LabEnv, p: Pattern) {
  return runCase(env, `rest.${p.name}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    sim.useFixed({});
    const dog = new Watchdog(sim);
    const y0 = sim.tel.y;
    let step = 0;
    let maxHop = 0;
    let maxSpeed = 0;
    while (sim.time < 4) {
      stepWith(sim, p.dtAt(step++, 1 / 60));
      dog.see();
      maxHop = Math.max(maxHop, Math.abs(sim.tel.y - y0));
      if (sim.time > 0.5) maxSpeed = Math.max(maxSpeed, Math.hypot(sim.tel.speed, sim.tel.vy));
    }
    return { pattern: p.name, maxHeightChange: maxHop, maxSpeedAfterSettle: maxSpeed, drift: Math.hypot(sim.tel.x, sim.tel.z), ...dog.metrics() };
  });
}

const xrHitch: ManeuverDef = {
  name: 'xrHitch',
  title: 'xr: frame hitches and odd frame rates (1/30 hitch, alternating, jitter, 0.1 / 0.2 s frames, 20 / 144 / 240 Hz)',
  async run(env) {
    const report = new Report();
    let exploded = false;
    let cleanLat = 0;
    let cleanRate = 0;
    let worstLat = 0;
    let worstLatName = '';
    let worstClamped = 0;
    let worstClampedName = '';
    for (const p of PATTERNS) {
      const c = await hitchCornerCase(env, p);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      if (p.name === 'clean') {
        cleanLat = m.latSteadyFraction as number;
        cleanRate = m.yawRateSteadyDeg as number;
      }
      const dev = Math.abs((m.latSteadyFraction as number) / cleanLat - 1) * 100;
      report.summary[`corner.${p.name}`] = `lat ${(m.latSteadyFraction as number).toFixed(3)} mu g (${dev.toFixed(1)} % off clean), yaw ${(m.yawRateSteadyDeg as number).toFixed(1)} deg/s, peak beta ${(m.peakBetaDeg as number).toFixed(1)} deg`;
      if (dev > worstLat) {
        worstLat = dev;
        worstLatName = p.name;
      }
      const clampedWorld = !p.name.startsWith('one0') && p.name !== 'fixed20Hz';
      if (clampedWorld && dev > worstClamped) {
        worstClamped = dev;
        worstClampedName = p.name;
      }
    }
    report.summary.cleanYawRateDeg = cleanRate;
    let slideClean = 0;
    let worstSlide = 0;
    for (const p of PATTERNS) {
      const c = await hitchSlideCase(env, p);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      const rec = m.recoveryTime === null ? 99 : (m.recoveryTime as number);
      if (p.name === 'clean') slideClean = rec;
      worstSlide = Math.max(worstSlide, Math.abs(rec - slideClean));
      report.summary[`slide35.${p.name}`] = `straight in ${rec.toFixed(2)} s, end heading ${(m.endYawDeg as number).toFixed(1)} deg, peak beta ${(m.peakBetaDeg as number).toFixed(1)}`;
    }
    let restWorst = 0;
    for (const p of PATTERNS) {
      const c = await hitchRestCase(env, p);
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      restWorst = Math.max(restWorst, m.maxHeightChange as number);
      report.summary[`rest.${p.name}`] = `height change ${(m.maxHeightChange as number).toFixed(4)} m, speed ${(m.maxSpeedAfterSettle as number).toFixed(4)} m/s`;
    }
    report.check('xrHitch.sane', exploded, 'no NaN / explosion with any frame pattern', !exploded);
    report.check('xrHitch.cornerClamped', `${worstClamped.toFixed(1)} % (${worstClampedName})`, 'cornering grip within 5 % of clean for every pattern the game loop can produce (dt <= 1/30)', worstClamped < 5);
    report.check('xrHitch.cornerAll', `${worstLat.toFixed(1)} % (${worstLatName})`, 'info: incl. unclamped 0.1 / 0.2 s frames and 20 Hz', worstLat < 15);
    report.check('xrHitch.slide', worstSlide, 'hands-off 35 deg slide: time to straight within 0.25 s of clean', worstSlide < 0.25);
    report.check('xrHitch.rest', restWorst, 'a parked car does not hop when a long frame arrives (< 2 cm)', restWorst < 0.02);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrRespawn

const xrRespawn: ManeuverDef = {
  name: 'xrRespawn',
  title: 'xr: 100 teleports in a row out of nasty states (flat) + 24 respawns onto the hills track',
  async run(env) {
    const report = new Report();
    const flat = await runCase(env, 'flat100', FLAT, async (sim): Promise<Metrics> => {
      const rnd = lcg(12345);
      const dog = new Watchdog(sim);
      let worstMove = 0;
      let worstYaw = 0;
      let worstSpeed = 0;
      let worstTilt = 0;
      let worstHeight = 0;
      let worstSpin = 0;
      let worstSteer = 0;
      let bad = 0;
      let worstState = '';
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      const restY = sim.tel.y;
      for (let i = 0; i < 100; i++) {
        // 0.4 s of something nasty.
        const kind = i % 5;
        const names = ['donut', 'airborne tumbling', 'inverted', '60 deg slide at 20 m/s', 'spinning 8 rad/s'];
        if (kind === 0) {
          sim.useFixed({ throttle: 1, steering: i % 2 ? 1 : -1 });
        } else if (kind === 1) {
          placePose(sim, { x: sim.tel.x, z: sim.tel.z, lift: 3, vz: 15, vy: 5, wx: 3, wz: 2 });
          sim.useFixed({ throttle: 1 });
        } else if (kind === 2) {
          placePose(sim, { x: sim.tel.x, z: sim.tel.z, lift: 1.5, roll: Math.PI, vz: 8 });
          sim.useFixed({ throttle: 1, steering: 1 });
        } else if (kind === 3) {
          sim.place({ x: sim.tel.x, z: sim.tel.z, yaw: 1, speed: 20, beta: -1.05, yawRate: 2 });
          sim.useFixed({ brake: 1, steering: -1 });
        } else {
          sim.place({ x: sim.tel.x, z: sim.tel.z, yaw: 0, speed: 12, yawRate: 8 });
          sim.useFixed({ throttle: 1, brake: 1, steering: 1 });
        }
        await runWatched(sim, dog, 0.4);
        // Respawn: pedals may still be held (a player does not let go).
        const x = (rnd() - 0.5) * 400;
        const z = (rnd() - 0.5) * 400;
        const yaw = (rnd() - 0.5) * 2 * Math.PI;
        const held = i % 3 === 0;
        sim.place({ x, z, yaw });
        if (!held) sim.useFixed({});
        else sim.useFixed({ steering: 1 });
        const yaw0 = sim.tel.yaw;
        await runWatched(sim, dog, 0.3);
        let speed = 0;
        let hop = 0;
        await runWatched(sim, dog, 0.3, (s) => {
          speed = Math.max(speed, Math.hypot(s.tel.speed, s.tel.vy));
          hop = Math.max(hop, Math.abs(s.tel.y - restY));
        });
        const move = Math.hypot(sim.tel.x - x, sim.tel.z - z);
        const yawErr = Math.abs(sim.tel.yaw - yaw0);
        let spin = 0;
        for (const w of sim.vehicle.wheelStates) spin = Math.max(spin, Math.abs(w.spinSpeed * w.radius));
        const steer = held ? 0 : Math.abs(sim.vehicle.currentSteerAngle);
        const isBad = move > 0.05 || yawErr > 1 * RAD || speed > 0.2 || sim.tel.tilt > 3 * RAD || hop > 0.03 || spin > 0.3;
        if (isBad) {
          bad++;
          if (!worstState) worstState = `#${i} after ${names[kind]}: moved ${move.toFixed(3)} m, yaw ${(yawErr * DEG).toFixed(2)} deg, speed ${speed.toFixed(3)}, hop ${hop.toFixed(3)}, rim ${spin.toFixed(2)} m/s`;
        }
        worstMove = Math.max(worstMove, move);
        worstYaw = Math.max(worstYaw, yawErr);
        worstSpeed = Math.max(worstSpeed, speed);
        worstTilt = Math.max(worstTilt, sim.tel.tilt);
        worstHeight = Math.max(worstHeight, hop);
        worstSpin = Math.max(worstSpin, spin);
        worstSteer = Math.max(worstSteer, steer);
      }
      return {
        respawns: 100,
        badRespawns: bad,
        firstBad: worstState || 'none',
        worstMove,
        worstYawErrDeg: worstYaw * DEG,
        worstSpeed0_3to0_6s: worstSpeed,
        worstTiltDeg: worstTilt * DEG,
        worstHeightError: worstHeight,
        worstResidualRimSpeed: worstSpin,
        worstResidualSteerDeg: worstSteer * DEG,
        nan: dog.nan,
      };
    });
    report.cases.push(flat);
    // Moving respawn (rolling start): speed and heading are kept.
    const rolling = await runCase(env, 'rollingStart', FLAT, async (sim): Promise<Metrics> => {
      let worstLoss = 0;
      let worstYaw = 0;
      for (const v of [5, 15, 24]) {
        sim.place({ x: 0, z: 0, yaw: 0.7, speed: v });
        sim.useFixed({ throttle: 0.5 });
        let minV = v;
        await sim.run(0.5, (tel) => {
          minV = Math.min(minV, tel.speed);
        });
        worstLoss = Math.max(worstLoss, (v - minV) / v);
        worstYaw = Math.max(worstYaw, Math.abs(sim.tel.yaw - 0.7));
      }
      return { worstSpeedDipPct: worstLoss * 100, worstYawErrDeg: worstYaw * DEG };
    });
    report.cases.push(rolling);
    const hills = await runCase(env, 'hills24', { kind: 'hills', seed: env.seed }, async (sim): Promise<Metrics> => {
      const track = sim.world.track;
      if (!track) return { ran: false };
      const dog = new Watchdog(sim);
      let worstMove = 0;
      let worstTilt = 0;
      let worstSpeed = 0;
      let moved = 0;
      for (let k = 0; k < 24; k++) {
        const i = Math.floor((k / 24) * track.count);
        const x = track.points[i * 2];
        const z = track.points[i * 2 + 1];
        const yaw = Math.atan2(track.tangents[i * 2], track.tangents[i * 2 + 1]);
        sim.place({ x, z, yaw });
        sim.useFixed({});
        await runWatched(sim, dog, 1.0);
        let speed = 0;
        await runWatched(sim, dog, 1.0, (s) => {
          speed = Math.max(speed, s.tel.speed);
        });
        const move = Math.hypot(sim.tel.x - x, sim.tel.z - z);
        if (move > 0.15) moved++;
        worstMove = Math.max(worstMove, move);
        worstTilt = Math.max(worstTilt, sim.tel.tilt);
        worstSpeed = Math.max(worstSpeed, speed);
      }
      return { ran: true, respawns: 24, movedMoreThan15cm: moved, worstMove, worstTiltDeg: worstTilt * DEG, worstSpeedSecond2: worstSpeed, nan: dog.nan, terrain: sim.world.terrainSource };
    });
    report.cases.push(hills);
    const f = flat.metrics;
    Object.assign(report.summary, f);
    report.summary['hills.worstMove'] = hills.metrics.worstMove ?? null;
    report.summary['hills.worstSpeed'] = hills.metrics.worstSpeedSecond2 ?? null;
    report.check('xrRespawn.clean', f.badRespawns, '100 / 100 respawns: at rest (< 0.2 m/s), in place (< 5 cm, < 1 deg), level, wheels stopped', f.badRespawns === 0);
    report.check('xrRespawn.sane', f.nan, 'no NaN', f.nan === false);
    report.check('xrRespawn.rolling', rolling.metrics.worstSpeedDipPct, 'rolling respawn keeps its speed (dip < 5 %) and heading', (rolling.metrics.worstSpeedDipPct as number) < 5 && (rolling.metrics.worstYawErrDeg as number) < 2);
    report.check('xrRespawn.hills', hills.metrics.worstMove ?? null, 'on the hills track: stays put (< 0.15 m in 2 s) at 24 points', hills.metrics.movedMoreThan15cm === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrOffroad — straight across the hills at full throttle, hands off.

const xrOffroad: ManeuverDef = {
  name: 'xrOffroad',
  title: 'xr: full throttle hands-off across the hills terrain from 16 start points (10 s each)',
  async run(env) {
    const report = new Report();
    let rolled = 0;
    let exploded = 0;
    let fell = 0;
    let endOff = 0;
    let stuck = 0;
    let escaped = 0;
    const notes: string[] = [];
    for (let k = 0; k < 16; k++) {
      const c = await runCase(env, `start${k}`, { kind: 'hills', seed: env.seed }, async (sim): Promise<Metrics> => {
        const track = sim.world.track;
        const hf = sim.world.heightfield;
        if (!track || !hf) return { ran: false };
        const i = Math.floor((k / 16) * track.count);
        const x = track.points[i * 2];
        const z = track.points[i * 2 + 1];
        // Alternate: straight off the road to the left / right / 45° across it.
        const tangent = Math.atan2(track.tangents[i * 2], track.tangents[i * 2 + 1]);
        const yaw = tangent + [Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4][k % 4];
        sim.place({ x, z, yaw });
        sim.useScript([{ t: 0, steering: k % 3 === 0 ? 0.3 : 0, throttle: 1, brake: 0 }]);
        sim.resetTrack();
        const dog = new Watchdog(sim);
        let below = 0;
        let air = 0;
        let lowSpeedTime = 0;
        let leftAt: number | null = null;
        let leftSpeed = 0;
        let maxSpeedInside = 0;
        let maxSpinInside = 0;
        const half = hf.size / 2 - 1;
        await runWatched(sim, dog, 10, (s) => {
          // The terrain is a 200 m square: beyond it there is nothing.
          const inside = Math.abs(s.tel.x) < half && Math.abs(s.tel.z) < half;
          if (!inside && leftAt === null) {
            leftAt = s.tel.t;
            leftSpeed = s.tel.speed;
          }
          if (leftAt === null) {
            const ground = s.world.groundHeight(s.tel.x, s.tel.z);
            below = Math.max(below, ground - s.tel.y);
            if (s.tel.wheelsOff === 4) air += s.dt;
            if (s.tel.t > 1 && s.tel.speed < 1) lowSpeedTime += s.dt;
            maxSpeedInside = Math.max(maxSpeedInside, Math.hypot(s.tel.speed, s.tel.vy));
            maxSpinInside = Math.max(maxSpinInside, Math.abs(s.tel.yawRate));
          }
          return leftAt !== null;
        });
        const fellThrough = below > 0.5;
        return {
          ran: true,
          rolledOver: sim.track.rolledOver,
          endTiltDeg: sim.tel.tilt * DEG,
          maxTiltDeg: sim.track.maxTilt * DEG,
          maxSpeed: sim.track.maxSpeed,
          endSpeed: sim.tel.speed,
          airTime: air,
          deepestBelowTerrain: below,
          fellThrough,
          leftTheWorldAt: leftAt,
          leftTheWorldSpeed: leftAt === null ? null : leftSpeed,
          maxSpeedInside,
          timeBelow1ms: lowSpeedTime,
          endRadius: Math.hypot(sim.tel.x, sim.tel.z),
          ...dog.metrics(60, 30),
        };
      });
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      if (m.rolledOver) rolled++;
      if (m.exploded) exploded++;
      if (m.fellThrough) fell++;
      if ((m.endTiltDeg as number) > 60) endOff++;
      if ((m.timeBelow1ms as number) > 3 && (m.endTiltDeg as number) <= 60) stuck++;
      if (m.leftTheWorldAt !== null && m.leftTheWorldAt !== undefined) {
        escaped++;
        notes.push(`start${k}: drove off the edge of the terrain after ${(m.leftTheWorldAt as number).toFixed(1)} s at ${(m.leftTheWorldSpeed as number).toFixed(1)} m/s`);
      }
      if (m.rolledOver || m.exploded || m.fellThrough) {
        notes.push(`start${k}: max tilt ${Math.round(m.maxTiltDeg as number)}, end tilt ${Math.round(m.endTiltDeg as number)}, max speed ${(m.maxSpeed3 as number).toFixed(1)}, spin ${(m.maxAngSpeed as number).toFixed(1)} rad/s, below ${(m.deepestBelowTerrain as number).toFixed(2)} m`);
      }
    }
    report.summary.rolledOver = rolled;
    report.summary.endOffWheels = endOff;
    report.summary.exploded = exploded;
    report.summary.fellThrough = fell;
    report.summary.stuckUpright = stuck;
    report.summary.leftTheWorld = escaped;
    report.summary.notes = notes.join(' | ') || 'none';
    report.check('xrOffroad.sane', exploded, 'no NaN / explosion (speed < 60 m/s, spin < 30 rad/s)', exploded === 0);
    report.check('xrOffroad.noFallThrough', fell, 'never more than 0.5 m below the terrain', fell === 0);
    report.check('xrOffroad.contained', escaped, 'the rim bowl keeps a full-throttle car inside the 200 m terrain (0 of 16 drive off the edge)', escaped === 0);
    report.check('xrOffroad.rollovers', `${rolled} went past 75 deg, ${endOff} ended off their wheels, ${stuck} stuck upright`, 'info: hands-off full throttle across open terrain', true);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrMisc — ramps taken badly, sideways into a kerb, waking after a long rest,
// and a second car (multiplayer is planned).

export async function rampCase(env: LabEnv, id: string, angleDeg: number, v: number, halfOn: boolean, steer: number, dt: number = env.dt) {
  const halfTrack = env.rig ? env.rig.front.track / 2 : 0.84;
  // halfOn: the ramp's right edge runs under the middle of the car (left wheels on it only).
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: halfOn ? -3 - 0.1 : 0, z: 40, angleDeg }] };
  return runCase(env, id, spec, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 40 - 1.2 * v, yaw: 0, speed: v });
    sim.useScript([{ t: 0, steering: 0, throttle: 0.6, brake: 0 }, { t: 1.25, steering: steer, throttle: 1 }]);
    sim.resetTrack();
    const dog = new Watchdog(sim);
    const restY = sim.tel.y;
    let air = 0;
    await runWatched(sim, dog, 7, (s) => {
      if (s.tel.wheelsOff === 4) air += s.dt;
    });
    return {
      rampDeg: angleDeg, speed: v, halfOn, halfTrack,
      airTime: air,
      peakHeight: dog.maxY - restY,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      wentPast75: sim.track.rolledOver,
      endTiltDeg: sim.tel.tilt * DEG,
      endsUpright: sim.tel.tilt < 25 * RAD,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  }, dt);
}

export async function tripCase(env: LabEnv, v: number, height: number, dt: number = env.dt) {
  return runCase(env, `trip.v${v}.h${Math.round(height * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    // A long kerb across the path; the car arrives sliding fully sideways.
    addBox(sim, 'Trip', [0, height / 2, 20.2], [40, height, 0.4]);
    // Start 0.5 m short of the kerb face (sideways sliding scrubs 33 m/s per second here).
    const halfWidth = env.rig ? Math.max(env.rig.front.track + env.rig.front.tireWidth, env.rig.rear.track + env.rig.rear.tireWidth) / 2 : 1.05;
    sim.place({ x: 0, z: 20 - halfWidth - 0.5, yaw: Math.PI / 2, speed: v, beta: -Math.PI / 2 });
    sim.useFixed({});
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let hitSpeed = 0;
    await runWatched(sim, dog, 5, (s) => {
      if (hitSpeed === 0 && s.tel.z > 20 - halfWidth - 0.05) hitSpeed = s.tel.speed;
    });
    return {
      speed: v, kerbHeight: height, speedAtKerb: hitSpeed,
      maxTiltDeg: sim.track.maxTilt * DEG,
      wentPast75: sim.track.rolledOver,
      endTiltDeg: sim.tel.tilt * DEG,
      endsUpright: sim.tel.tilt < 25 * RAD,
      crossedKerb: sim.tel.z > 21.5,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  }, dt);
}

async function sleepCase(env: LabEnv, restSeconds: number) {
  return runCase(env, `sleep${restSeconds}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    sim.useFixed({});
    await sim.run(restSeconds);
    const drift = Math.hypot(sim.tel.x, sim.tel.z);
    sim.useScript([{ t: 0, steering: 0, throttle: 1, brake: 0 }]);
    const t0 = sim.time;
    let t10: number | null = null;
    await sim.run(2, (tel) => {
      if (t10 === null && tel.speed >= 10) t10 = tel.t - t0;
      return t10 !== null;
    });
    return { restSeconds, driftWhileResting: drift, t10AfterRest: t10 };
  });
}

/** A second car of the same model in the same world (no driver: parked). */
async function twoCarCase(env: LabEnv, id: string, mode: 'tbone' | 'rearEnd' | 'headOn' | 'sideSwipe' | 'landOn') {
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (!env.rig) return { ran: false };
    const scene = sim.world.scene;
    const idle = { name: 'idle', intent: { throttle: 0, steering: 0, brake: 0 }, isActive: () => true, poll() { return this.intent; } };
    const other = createVehicle(scene, idle, { model: env.model, carId: env.carId, rig: env.rig, handling: env.handling });
    const hook = scene.onBeforePhysicsObservable.add(() => {
      other.chassisMesh.computeWorldMatrix(true);
      other.update(sim.dt);
    });
    try {
      const v = mode === 'rearEnd' ? 12 : 20;
      // B is parked at the origin; A arrives along +z.
      const bYaw = mode === 'tbone' ? Math.PI / 2 : mode === 'headOn' ? Math.PI : 0;
      other.reset(new Vector3(mode === 'sideSwipe' ? 1.75 : 0, 0, 0), bYaw);
      if (mode === 'headOn') other.setMotion(new Vector3(0, 0, -20), 0);
      if (mode === 'landOn') {
        placePose(sim, { x: 0, z: -6, lift: 2.0, vz: 12 });
      } else {
        sim.place({ x: 0, z: -(mode === 'sideSwipe' ? 20 : 1.0 * v + 4), yaw: 0, speed: v });
      }
      if (mode === 'headOn') idle.intent.throttle = 1;
      sim.useFixed({ throttle: mode === 'landOn' ? 0 : 1 });
      sim.resetTrack();
      const dog = new Watchdog(sim);
      const restY = sim.tel.y;
      const lin = new Vector3();
      const ang = new Vector3();
      let bMaxSpeed = 0;
      let bMaxSpin = 0;
      let bMaxY = -Infinity;
      let bMinY = Infinity;
      let bNan = false;
      let aOnTop = 0;
      let vA = 0;
      let vB = 0;
      await runWatched(sim, dog, 4, (s) => {
        other.chassisBody.getLinearVelocityToRef(lin);
        other.chassisBody.getAngularVelocityToRef(ang);
        const y = other.chassisMesh.position.y;
        if (!Number.isFinite(lin.x + lin.y + lin.z + ang.x + ang.y + ang.z + y)) bNan = true;
        bMaxSpeed = Math.max(bMaxSpeed, lin.length());
        bMaxSpin = Math.max(bMaxSpin, ang.length());
        bMaxY = Math.max(bMaxY, y);
        bMinY = Math.min(bMinY, y);
        // A riding on B: A is lifted and horizontally within a car length of B.
        const near = Math.hypot(s.tel.x - other.chassisMesh.position.x, s.tel.z - other.chassisMesh.position.z) < 1.5;
        if (near && s.tel.y - restY > 0.4) aOnTop += s.dt;
        if (Math.abs(s.time - 1.6) < s.dt / 2) {
          vA = s.tel.vz;
          vB = lin.z;
        }
      });
      const up = other.chassisMesh.up;
      const bTilt = Math.acos(Math.max(-1, Math.min(1, up.y))) * DEG;
      const m: Metrics = {
        ran: true,
        aSpeedBefore: v,
        aVzAfter: vA,
        bVzAfter: vB,
        // Equal masses: momentum along z before = m·v (B parked).
        momentumKeptPct: mode === 'headOn' || mode === 'landOn' ? null : ((vA + vB) / v) * 100,
        aPeakLift: dog.maxY - restY,
        aMaxTiltDeg: sim.track.maxTilt * DEG,
        aEndTiltDeg: sim.tel.tilt * DEG,
        aTimeOnTopOfB: aOnTop,
        bMaxSpeed,
        bMaxSpin,
        bPeakLift: bMaxY - restY,
        bSunk: restY - bMinY,
        bEndTiltDeg: bTilt,
        bNan,
        ...dog.metrics(),
      };
      return m;
    } finally {
      scene.onBeforePhysicsObservable.remove(hook);
      other.dispose();
    }
  });
}

const xrMisc: ManeuverDef = {
  name: 'xrMisc',
  title: 'xr: steep / half-on ramps, sideways into a kerb, waking after a long rest, a second car',
  async run(env) {
    const report = new Report();
    let exploded = false;
    let rampDown = 0;
    let rampTotal = 0;
    const rampNotes: string[] = [];
    for (const [angle, v] of [[25, 24.5], [35, 24.5], [45, 24.5], [35, 15], [45, 15]] as const) {
      const c = await rampCase(env, `ramp${angle}.v${Math.round(v)}`, angle, v, false, 0);
      report.cases.push(c);
      rampTotal++;
      if (c.metrics.exploded) exploded = true;
      if (!c.metrics.endsUpright) {
        rampDown++;
        rampNotes.push(c.id);
      }
      report.summary[c.id] = `${c.metrics.endsUpright ? 'upright' : `ENDS ${Math.round(c.metrics.endTiltDeg as number)} deg`}, air ${(c.metrics.airTime as number).toFixed(2)} s, peak ${(c.metrics.peakHeight as number).toFixed(1)} m, pitch ${Math.round(c.metrics.maxPitchDeg as number)}, roll ${Math.round(c.metrics.maxRollDeg as number)}`;
    }
    for (const [angle, v, steer] of [[12, 15, 0], [12, 22, 0], [18, 15, 0], [18, 22, 0], [25, 15, 0], [25, 22, 0], [18, 22, 1], [18, 22, -1]] as const) {
      const c = await rampCase(env, `halfRamp${angle}.v${v}.s${steer}`, angle, v, true, steer);
      report.cases.push(c);
      rampTotal++;
      if (c.metrics.exploded) exploded = true;
      if (!c.metrics.endsUpright) {
        rampDown++;
        rampNotes.push(c.id);
      }
      report.summary[c.id] = `${c.metrics.endsUpright ? 'upright' : `ENDS ${Math.round(c.metrics.endTiltDeg as number)} deg`}, air ${(c.metrics.airTime as number).toFixed(2)} s, pitch ${Math.round(c.metrics.maxPitchDeg as number)}, roll ${Math.round(c.metrics.maxRollDeg as number)}`;
    }
    report.check('xrMisc.ramps', `${rampDown} of ${rampTotal}: ${rampNotes.join(', ') || 'none'}`, 'steep (25-45 deg) and half-on ramps end upright', rampDown === 0);
    let trips = 0;
    const tripNotes: string[] = [];
    for (const v of [8, 14, 20]) {
      for (const h of [0.15, 0.3, 0.6]) {
        const c = await tripCase(env, v, h);
        report.cases.push(c);
        if (c.metrics.exploded) exploded = true;
        if (!c.metrics.endsUpright) {
          trips++;
          tripNotes.push(c.id);
        }
        report.summary[c.id] = `${c.metrics.endsUpright ? 'upright' : `ENDS ${Math.round(c.metrics.endTiltDeg as number)} deg`}, max tilt ${Math.round(c.metrics.maxTiltDeg as number)}, at the kerb ${(c.metrics.speedAtKerb as number).toFixed(1)} m/s, ${c.metrics.crossedKerb ? 'crossed' : 'stopped by it'}`;
      }
    }
    report.check('xrMisc.trip', `${trips} of 9: ${tripNotes.join(', ') || 'none'}`, 'sliding sideways into a 0.15-0.6 m kerb at 8-20 m/s ends upright', trips === 0);
    const fresh = await sleepCase(env, 1);
    const slept = await sleepCase(env, 60);
    report.cases.push(fresh, slept);
    const tf = fresh.metrics.t10AfterRest as number | null;
    const ts = slept.metrics.t10AfterRest as number | null;
    report.summary.t10Fresh = tf;
    report.summary.t10After60s = ts;
    report.summary.driftIn60s = slept.metrics.driftWhileResting;
    report.check('xrMisc.wake', ts, 'after 60 s parked (Havok sleep) the car launches like a fresh one (0-10 m/s within 0.05 s)', tf !== null && ts !== null && Math.abs(ts - tf) < 0.05);
    let twoBad = 0;
    for (const mode of ['tbone', 'rearEnd', 'headOn', 'sideSwipe', 'landOn'] as const) {
      const c = await twoCarCase(env, `twoCars.${mode}`, mode);
      report.cases.push(c);
      const m = c.metrics;
      if (!m.ran) continue;
      if (m.exploded || m.bNan) exploded = true;
      const odd = (m.bMaxSpeed as number) > 45 || (m.bMaxSpin as number) > 25 || (m.bSunk as number) > 0.3 || (m.aTimeOnTopOfB as number) > 0.5;
      if (odd) twoBad++;
      report.summary[c.id] = `A ${(m.aVzAfter as number).toFixed(1)} / B ${(m.bVzAfter as number).toFixed(1)} m/s after${m.momentumKeptPct === null ? '' : ` (momentum ${Math.round(m.momentumKeptPct as number)} %)`}; A lift ${(m.aPeakLift as number).toFixed(2)} m, tilt ${Math.round(m.aMaxTiltDeg as number)}, on top of B ${(m.aTimeOnTopOfB as number).toFixed(2)} s; B max ${(m.bMaxSpeed as number).toFixed(1)} m/s, spin ${(m.bMaxSpin as number).toFixed(1)} rad/s, lift ${(m.bPeakLift as number).toFixed(2)} m, sunk ${(m.bSunk as number).toFixed(2)} m, ends ${Math.round(m.bEndTiltDeg as number)} deg`;
    }
    report.check('xrMisc.twoCars', twoBad, 'car-to-car hits: nobody explodes, sinks into the ground or parks on the other car', twoBad === 0);
    report.check('xrMisc.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xrGameLoop — the game's render loop as it is today (createScene.ts):
//     dt = min(frameTime, 1/30);  car.update(dt);  scene.render();
// and scene.render() steps Havok with the REAL frame time (Babylon clamps it
// at 0.1 s). On any frame longer than 1/30 s a model that integrates its own
// forces in update() (raycast) applies 1/30 s of force to a longer step.

function gameStep(sim: Sim, frame: number): void {
  const v = sim.vehicle as unknown as { update?: (dt: number) => void };
  const proto = Object.getPrototypeOf(v) as { update: (dt: number) => void };
  v.update = (dt: number) => proto.update.call(v, Math.min(dt, 1 / 30));
  try {
    stepWith(sim, Math.min(frame, 0.1));
  } finally {
    delete v.update;
  }
}

async function gameLoopCase(env: LabEnv, fps: number, kind: 'launch' | 'corner' | 'drop' | 'brake') {
  return runCase(env, `${kind}.fps${fps}`, FLAT, async (sim): Promise<Metrics> => {
    const frame = 1 / fps;
    const dog = new Watchdog(sim);
    if (kind === 'launch') {
      sim.place({ x: 0, z: 0, yaw: 0 });
      sim.useFixed({ throttle: 1 });
      let t20: number | null = null;
      while (sim.time < 4) {
        gameStep(sim, frame);
        dog.see();
        if (t20 === null && sim.tel.speed >= 20) t20 = sim.time;
      }
      return { fps, t20, speedAt4s: sim.tel.speed, ...dog.metrics() };
    }
    if (kind === 'brake') {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 20 });
      sim.useFixed({ brake: 1 });
      while (sim.time < 3 && sim.tel.speed > 0.3) {
        gameStep(sim, frame);
        dog.see();
      }
      return { fps, stopDistance: sim.tel.z, stopTime: sim.time, ...dog.metrics() };
    }
    if (kind === 'drop') {
      sim.place({ x: 0, z: 0, yaw: 0 });
      placePose(sim, { x: 0, z: 0, lift: 3, vz: 10 });
      sim.useFixed({});
      let touch: number | null = null;
      while (sim.time < 2) {
        gameStep(sim, frame);
        dog.see();
        if (touch === null && sim.tel.wheelsOff < 4) touch = sim.time;
      }
      return { fps, fallTime: touch, expected: Math.sqrt((2 * 3) / sim.gravity), ...dog.metrics() };
    }
    sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
    sim.useFixed({ throttle: 0.55, steering: 1 });
    // The stick ramp is part of the input, not of the car: start at lock.
    const lats: number[] = [];
    const rates: number[] = [];
    while (sim.time < 3) {
      gameStep(sim, frame);
      dog.see();
      if (sim.time > 2) {
        lats.push(Math.abs(sim.tel.aCent) / sim.mug);
        rates.push(sim.tel.yawRate * DEG);
      }
    }
    return { fps, latSteadyFraction: mean(lats), yawRateSteadyDeg: mean(rates), speedEnd: sim.tel.speed, peakBetaDeg: sim.track.maxAbsBeta * DEG, ...dog.metrics() };
  });
}

async function gameHitchCase(env: LabEnv, hitch: number) {
  return runCase(env, `cornerHitch${Math.round(hitch * 1000)}ms`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
    sim.useFixed({ throttle: 0.55, steering: 0.5 });
    let step = 0;
    let elapsed = 0;
    // Same wall-clock duration for every variant (2.5 s).
    while (elapsed < 2.5 - 1e-9) {
      const frame = step === 60 && hitch > 0 ? hitch : 1 / 60;
      step++;
      elapsed += frame;
      gameStep(sim, frame);
    }
    return { hitch, endX: sim.tel.x, endZ: sim.tel.z, endYawDeg: sim.tel.yaw * DEG, simTime: sim.time, endSpeed: sim.tel.speed };
  });
}

const xrGameLoop: ManeuverDef = {
  name: 'xrGameLoop',
  title: 'xr: the game loop as written (car.update gets min(dt, 1/30), Havok gets the real frame time) at 60 / 30 / 25 / 20 / 15 / 10 fps',
  async run(env) {
    const report = new Report();
    const ref: Record<string, number> = {};
    let worst = 0;
    let worstName = '';
    const rows: string[] = [];
    for (const fps of [60, 30, 25, 20, 15, 10]) {
      const launch = await gameLoopCase(env, fps, 'launch');
      const corner = await gameLoopCase(env, fps, 'corner');
      const drop = await gameLoopCase(env, fps, 'drop');
      const brake = await gameLoopCase(env, fps, 'brake');
      report.cases.push(launch, corner, drop, brake);
      const vals: Record<string, number> = {
        t20: (launch.metrics.t20 as number | null) ?? 99,
        lat: corner.metrics.latSteadyFraction as number,
        fall: (drop.metrics.fallTime as number | null) ?? 99,
        stop: brake.metrics.stopDistance as number,
      };
      if (fps === 60) Object.assign(ref, vals);
      rows.push(`${fps} fps: 0-20 in ${vals.t20.toFixed(2)} s, cornering ${vals.lat.toFixed(2)} mu g, 3 m drop takes ${vals.fall.toFixed(2)} s, 20-0 in ${vals.stop.toFixed(1)} m`);
      report.summary[`fps${fps}`] = rows[rows.length - 1];
      for (const k of Object.keys(vals)) {
        const dev = Math.abs(vals[k] / ref[k] - 1) * 100;
        report.summary[`fps${fps}.${k}.devPct`] = dev;
        if (fps >= 20 && dev > worst) {
          worst = dev;
          worstName = `${k} at ${fps} fps`;
        }
      }
    }
    const clean = await gameHitchCase(env, 0);
    report.cases.push(clean);
    for (const hitch of [0.05, 0.1, 0.2]) {
      const c = await gameHitchCase(env, hitch);
      report.cases.push(c);
      const off = Math.hypot((c.metrics.endX as number) - (clean.metrics.endX as number), (c.metrics.endZ as number) - (clean.metrics.endZ as number));
      report.summary[`hitch${Math.round(hitch * 1000)}ms.positionShift`] = off;
      report.summary[`hitch${Math.round(hitch * 1000)}ms.headingShiftDeg`] = (c.metrics.endYawDeg as number) - (clean.metrics.endYawDeg as number);
    }
    report.check('xrGameLoop.below30fps', `${worst.toFixed(0)} % (${worstName})`, 'with the game loop as written, 20-30 fps changes launch / grip / gravity / braking by < 10 %', worst < 10);
    return report.output();
  },
};

export const ABUSE_MANEUVERS: ManeuverDef[] = [
  xrGameLoop,
  xrMisc,
  xrSaw, xrDonut, xrBrakeLock, xrReverse, xrAirLanding, xrBoulder, xrSlope, xrWall, xrInverted, xrHitch, xrRespawn, xrOffroad,
];
