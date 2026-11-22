/**
 * BREAK TESTS for the 'hybrid' vehicle model — player-style abuse. Extra
 * maneuvers appended to the lab suite by ./breakLab.ts (page
 * /src/lab/physics/extra-hybrid/break.html, runner ./breaklab.sh).
 *
 *   hxSaw       full-lock left-right-left sawing at top speed
 *   hxDonut     full throttle + full lock from standstill, exits
 *   hxBrakeLock slam brake + full lock at 20 / 25 m/s
 *   hxReverse   reverse flat out -> full forward; reverse + lock; brake while
 *               rolling BACKWARD
 *   hxAir       landings: sideways, two wheels, nose down, spinning
 *   hxObstacle  one wheel over a boulder / square step at 20 m/s
 *   hxSlope     30 deg side slope (parked, driving, turning), nose-up slopes 30 s
 *   hxWall      nose-first into a wall at top speed, reverse out; 45 deg; half
 *   hxInverted  on the roof / on its side: NaN, explosions, what the pedals do
 *   hxFrame     dt 1/20 .. 1/144, jittered dt, single frame hitch
 *   hxRespawn   100 reset()s in a row from ugly states; nudges without reset()
 *
 * Every case reports plain numbers; checks are deliberately few — these are
 * probes, the judgement is in the report.
 */
import { Quaternion, Vector3 } from '@babylonjs/core';
import { DEG, RAD } from '../sim';
import type { LabEnv, ScriptKey, Sim } from '../sim';
import type { MetricValue } from '../types';
import { FLAT, Report, fitCircle, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import type { WorldSpec } from '../world';
import { Extremes, StickPlayer, addSlab, airPose, analyzeSlide, jitterDt, rigidMove, runVar, upright } from './kit';

type M = Record<string, MetricValue>;

function track(sim: Sim): M {
  return {
    maxRollDeg: sim.track.maxAbsRoll * DEG,
    maxPitchDeg: sim.track.maxAbsPitch * DEG,
    maxTiltDeg: sim.track.maxTilt * DEG,
    sideLiftTime: sim.track.sideLiftTime,
    anyLiftTime: sim.track.anyLiftTime,
    rolledOver: sim.track.rolledOver,
    endsUpright: upright(sim),
  };
}

/** Time (s) until calm: |beta| < 5 deg and |yaw rate| < 10 deg/s for 0.5 s. */
function calmTime(dt: number, betas: number[], rates: number[]): number | null {
  const hold = Math.round(0.5 / dt);
  let calm = 0;
  for (let i = 0; i < betas.length; i++) {
    if (Math.abs(betas[i]) < 5 * RAD && Math.abs(rates[i]) < 10 * RAD) {
      if (++calm >= hold) return (i + 1 - hold + 1) * dt;
    } else calm = 0;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sawing at top speed.

async function sawCase(env: LabEnv, period: number, v0: number) {
  return runCase(env, `saw.v${v0}.p${Math.round(period * 100)}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    const keys: ScriptKey[] = [{ t: 0, throttle: 1, steering: 0 }];
    let k = 0;
    for (let t = 0.5; t < 8.5; t += period / 2) keys.push({ t, steering: k++ % 2 === 0 ? 1 : -1 });
    keys.push({ t: 8.5, steering: 0 });
    sim.useScript(keys);
    const ex = new Extremes(sim);
    sim.resetTrack();
    let minSpeed = v0;
    let maxX = 0;
    let spunAt: number | null = null;
    const betas: number[] = [];
    const rates: number[] = [];
    await sim.run(11, (tel) => {
      ex.sample();
      minSpeed = Math.min(minSpeed, tel.speed);
      maxX = Math.max(maxX, Math.abs(tel.x));
      if (spunAt === null && sim.track.spun) spunAt = tel.t;
      if (tel.t >= 8.5) {
        betas.push(tel.beta);
        rates.push(tel.yawRate);
      }
    });
    return {
      period,
      ...track(sim),
      spun: sim.track.spun,
      spunAt,
      maxBetaDeg: sim.track.maxAbsBeta * DEG,
      peakLatFraction: sim.track.maxAbsALat / sim.mug,
      minSpeed,
      speedEnd: sim.tel.speed,
      lateralSpan: maxX,
      // After the hands let go at 8.5 s: how long until the car is calm.
      calmAfterRelease: calmTime(sim.dt, betas, rates),
      ...ex.metrics(),
    };
  });
}

export const hxSaw: ManeuverDef = {
  name: 'hxSaw',
  title: 'hx. full-lock sawing at top speed (periods 0.3 - 2.0 s), then hands off',
  async run(env) {
    const report = new Report();
    for (const period of [0.3, 0.5, 0.8, 1.2, 2.0]) {
      const c = await sawCase(env, period, 24);
      report.cases.push(c);
      report.check(`hxSaw.p${period}.upright`, c.metrics.maxTiltDeg, 'no rollover, finite', c.metrics.rolledOver === false && c.metrics.finite === true);
      report.check(`hxSaw.p${period}.noSpin`, c.metrics.maxBetaDeg, 'no spin (|beta| < 90 deg)', c.metrics.spun === false);
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Donuts.

async function donutCase(env: LabEnv, throttle: number, dir: 1 | -1, exit: 'ease' | 'floored' | 'lift' | 'flooredCounter' | 'to70' | 'to60' | 'to50') {
  return runCase(env, `donut.t${Math.round(throttle * 100)}.${dir > 0 ? 'R' : 'L'}.${exit}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    await sim.run(0.5);
    sim.useScript([{ t: 0, throttle, steering: dir }]);
    const ex = new Extremes(sim);
    sim.resetTrack();
    const xs: number[] = [];
    const zs: number[] = [];
    const speeds: number[] = [];
    const rates: number[] = [];
    const betas: number[] = [];
    const slips: number[] = [];
    const t0 = sim.time;
    let tBeta30: number | null = null;
    await sim.run(8, (tel) => {
      ex.sample();
      if (tBeta30 === null && tel.speed > 2 && Math.abs(tel.beta) > 30 * RAD) tBeta30 = tel.t - t0;
      if (tel.t - t0 >= 5) {
        xs.push(tel.x);
        zs.push(tel.z);
        speeds.push(tel.speed);
        rates.push(tel.yawRate * dir);
        betas.push(-tel.beta * dir);
        slips.push(sim.vehicle.drivenRimSpeed - tel.vFwd);
      }
    });
    const circle = fitCircle(xs, zs);
    const donutSpin = sim.track.spun;
    const donutRoll = sim.track.maxAbsRoll * DEG;
    const donutLift = sim.track.sideLiftTime;
    // Exit: stick centred, throttle eased / kept / lifted.
    // 'flooredCounter': foot down, full OPPOSITE lock. 'to70/60/50': stick
    // stays at full lock, throttle eased to that level (can the donut be
    // widened with the foot?).
    const exitThrottle = exit === 'ease' ? 0.3 : exit === 'floored' || exit === 'flooredCounter' ? throttle
      : exit === 'to70' ? 0.7 : exit === 'to60' ? 0.6 : exit === 'to50' ? 0.5 : 0;
    const exitSteer = exit === 'flooredCounter' ? -dir : exit.startsWith('to') ? dir : 0;
    sim.useScript([{ t: 0, steering: exitSteer, throttle: exitThrottle }]);
    const ex2x: number[] = [];
    const ex2z: number[] = [];
    const ex2v: number[] = [];
    const ex2b: number[] = [];
    const tExit = sim.time;
    const yaw0 = sim.tel.yaw;
    const eb: number[] = [];
    const er: number[] = [];
    let exitSpun = false;
    await sim.run(4, (tel) => {
      ex.sample();
      eb.push(tel.beta);
      er.push(tel.yawRate);
      if (Math.abs(tel.beta) > Math.PI / 2 && tel.speed > 3) exitSpun = true;
      if (tel.t - tExit > 2.5) {
        ex2x.push(tel.x);
        ex2z.push(tel.z);
        ex2v.push(tel.speed);
        ex2b.push(-tel.beta * dir * DEG);
      }
    });
    const after = fitCircle(ex2x, ex2z);
    return {
      throttle,
      dir,
      // Steady state over the last 3 s of the 8 s donut.
      radius: circle.r,
      radiusRms: circle.rms,
      speedMean: mean(speeds),
      speedStd: std(speeds),
      yawRateMeanDeg: mean(rates) * DEG,
      yawRateStdDeg: std(rates) * DEG,
      betaMeanDeg: mean(betas) * DEG,
      betaStdDeg: std(betas) * DEG,
      rearSlipSpeedMean: mean(slips),
      timeToBeta30: tBeta30,
      donutSpunBeyond90: donutSpin,
      donutMaxRollDeg: donutRoll,
      donutSideLiftTime: donutLift,
      exit,
      exitCalmTime: calmTime(sim.dt, eb, er),
      exitSpun,
      exitHeadingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      exitSpeedEnd: sim.tel.speed,
      // Last 1.5 s of the 4 s exit phase.
      afterRadius: after.r,
      afterSpeedMean: mean(ex2v),
      afterBetaMeanDeg: mean(ex2b),
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

export const hxDonut: ManeuverDef = {
  name: 'hxDonut',
  title: 'hx. donuts: throttle + full lock from standstill, radius vs throttle, exits',
  async run(env) {
    const report = new Report();
    for (const throttle of [0.4, 0.6, 0.8, 1.0]) {
      const c = await donutCase(env, throttle, 1, 'ease');
      delete c.series;
      report.cases.push(c);
    }
    for (const throttle of [0.65, 0.7, 0.75]) {
      const c = await donutCase(env, throttle, 1, 'ease');
      delete c.series;
      report.cases.push(c);
    }
    for (const exit of ['floored', 'lift', 'flooredCounter', 'to70', 'to60', 'to50'] as const) report.cases.push(await donutCase(env, 1, 1, exit));
    // Mirror image: must behave the same (left/right bias check).
    report.cases.push(await donutCase(env, 1, -1, 'ease'));
    for (const c of report.cases) {
      report.check(`hxDonut.${c.id}.upright`, c.metrics.maxTiltDeg, 'never flips, finite', c.metrics.rolledOver === false && c.metrics.finite === true);
    }
    const r = report.cases.find((c) => c.id === 'donut.t100.R.ease')!.metrics;
    const l = report.cases.find((c) => c.id === 'donut.t100.L.ease')!.metrics;
    report.summary.leftRightRadius = `${r.radius} / ${l.radius}`;
    report.check('hxDonut.symmetry', Math.abs((r.radius as number) - (l.radius as number)), 'left/right donut radius within 10 %',
      Math.abs((r.radius as number) - (l.radius as number)) < 0.1 * (r.radius as number));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Slam brake + full lock.

async function brakeLockCase(env: LabEnv, v0: number, withThrottle: boolean) {
  return runCase(env, `brakeLock.v${v0}${withThrottle ? '.throttleHeld' : ''}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 0.6 });
    await sim.run(0.4);
    const v1 = sim.tel.speed;
    sim.useScript([{ t: 0, brake: 1, steering: 1, throttle: withThrottle ? 1 : 0 }]);
    const ex = new Extremes(sim);
    sim.resetTrack();
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    const yaw0 = sim.tel.yaw;
    let dist = 0;
    let px = x0;
    let pz = z0;
    const t0 = sim.time;
    const stopped = await sim.run(6, (tel) => {
      ex.sample();
      dist += Math.hypot(tel.x - px, tel.z - pz);
      px = tel.x;
      pz = tel.z;
      return tel.speed < 0.3;
    });
    const tStop = sim.time - t0;
    // Keep holding for 2 s more: does the held brake turn into reverse?
    let maxAfter = 0;
    await sim.run(2, (tel) => {
      maxAfter = Math.max(maxAfter, tel.speed);
    });
    return {
      entrySpeed: v1,
      stopped,
      stopTime: tStop,
      stopDistance: dist,
      idealDistance: (v1 * v1) / (2 * sim.mug),
      forwardTravel: sim.tel.z - z0,
      lateralTravel: sim.tel.x - x0,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      peakBetaDeg: sim.track.maxAbsBeta * DEG,
      spun: sim.track.spun,
      speedWhileHeldAfterStop: maxAfter,
      isReversing: sim.vehicle.isReversing,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

export const hxBrakeLock: ManeuverDef = {
  name: 'hxBrakeLock',
  title: 'hx. slam brake + full lock at 15 / 20 / 25 m/s',
  async run(env) {
    const report = new Report();
    for (const v of [15, 20, 25]) report.cases.push(await brakeLockCase(env, v, false));
    report.cases.push(await brakeLockCase(env, 25, true));
    for (const c of report.cases) {
      report.check(`hxBrakeLock.${c.id}`, c.metrics.peakBetaDeg, 'stops, no spin, no roll', c.metrics.stopped === true && c.metrics.spun === false && c.metrics.rolledOver === false);
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Reverse.

async function reverseFlatOut(env: LabEnv, lock: boolean) {
  return runCase(env, lock ? 'reverse.lockThenForward' : 'reverse.flatOutThenForward', FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    await sim.run(0.5);
    const ex = new Extremes(sim);
    sim.resetTrack();
    sim.useScript([{ t: 0, brake: 1 }]);
    const yaw0 = sim.tel.yaw;
    let v1 = 0, v2 = 0;
    const t0 = sim.time;
    await sim.run(3, (tel) => {
      ex.sample();
      if (Math.abs(tel.t - t0 - 1) < sim.dt / 2) v1 = tel.vFwd;
      if (Math.abs(tel.t - t0 - 2) < sim.dt / 2) v2 = tel.vFwd;
    });
    const v3 = sim.tel.vFwd;
    const revHeadingDrift = (sim.tel.yaw - yaw0) * DEG;
    let lockPeakYawRate = 0;
    let lockSpun = false;
    let lockMaxRoll = 0;
    let lockSideLift = 0;
    let lockHeading = 0;
    if (lock) {
      // Full lock while reversing flat out, 2.5 s.
      sim.resetTrack();
      sim.useScript([{ t: 0, brake: 1, steering: 1 }]);
      const y1 = sim.tel.yaw;
      await sim.run(2.5, (tel) => {
        ex.sample();
        lockPeakYawRate = Math.max(lockPeakYawRate, Math.abs(tel.yawRate));
      });
      lockSpun = Math.abs(sim.tel.yaw - y1) > Math.PI; // swapped ends
      lockMaxRoll = sim.track.maxAbsRoll * DEG;
      lockSideLift = sim.track.sideLiftTime;
      lockHeading = (sim.tel.yaw - y1) * DEG;
    }
    // Flat out forward (stick centred).
    sim.resetTrack();
    sim.useScript([{ t: 0, brake: 0, throttle: 1, steering: 0 }]);
    const tSwitch = sim.time;
    const vSwitch = sim.tel.vFwd;
    const y2 = sim.tel.yaw;
    let tZero: number | null = null;
    let t10: number | null = null;
    let peakSlip = 0;
    await sim.run(4, (tel) => {
      ex.sample();
      if (tZero === null && tel.vFwd >= 0) tZero = tel.t - tSwitch;
      if (t10 === null && tel.vFwd >= 10) t10 = tel.t - tSwitch;
      peakSlip = Math.max(peakSlip, sim.vehicle.drivenRimSpeed - tel.vFwd);
    });
    return {
      reverseSpeedAt1s: v1,
      reverseSpeedAt2s: v2,
      reverseSpeedAt3s: v3,
      reverseHeadingDriftDeg: revHeadingDrift,
      lockPeakYawRateDeg: lockPeakYawRate * DEG,
      lockSwappedEnds: lockSpun,
      lockMaxRollDeg: lockMaxRoll,
      lockSideLiftTime: lockSideLift,
      lockHeadingChangeDeg: lockHeading,
      speedAtSwitch: vSwitch,
      timeToZero: tZero,
      timeToForward10: t10,
      forwardHeadingChangeDeg: (sim.tel.yaw - y2) * DEG,
      forwardMaxPitchDeg: sim.track.maxAbsPitch * DEG,
      forwardPeakRimSlip: peakSlip,
      forwardAnyLiftTime: sim.track.anyLiftTime,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

/** Rolling BACKWARD at speed (after a 180 spin) and the player hits a pedal. */
async function backwardPedal(env: LabEnv, v0: number, pedal: 'brake' | 'throttle' | 'both' | 'none' | 'brakeTap') {
  return runCase(env, `backward.v${v0}.${pedal}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: -v0 });
    await sim.run(0.1);
    const ex = new Extremes(sim);
    if (pedal === 'brakeTap') {
      // Release-and-press again every 0.5 s (a player pumping the brake).
      const keys: ScriptKey[] = [];
      for (let t = 0; t < 6; t += 0.5) keys.push({ t, brake: 1 }, { t: t + 0.35, brake: 0 });
      sim.useScript(keys);
    } else {
      sim.useScript([{ t: 0, brake: pedal === 'brake' || pedal === 'both' ? 1 : 0, throttle: pedal === 'throttle' || pedal === 'both' ? 1 : 0 }]);
    }
    const z0 = sim.tel.z;
    const t0 = sim.time;
    let tStop: number | null = null;
    let zStop = 0;
    let vAt1 = 0, vAt2 = 0, vAt4 = 0;
    let reversingFlag = false;
    await sim.run(6, (tel) => {
      ex.sample();
      const t = tel.t - t0;
      if (Math.abs(t - 1) < sim.dt / 2) vAt1 = tel.vFwd;
      if (Math.abs(t - 2) < sim.dt / 2) vAt2 = tel.vFwd;
      if (Math.abs(t - 4) < sim.dt / 2) vAt4 = tel.vFwd;
      if (t < 0.5 && sim.vehicle.isReversing) reversingFlag = true;
      if (tStop === null && tel.vFwd > -0.3) {
        tStop = t;
        zStop = tel.z;
      }
    });
    return {
      pedal,
      entrySpeed: -v0,
      modelSaysReversing: reversingFlag,
      vFwdAt1s: vAt1,
      vFwdAt2s: vAt2,
      vFwdAt4s: vAt4,
      vFwdAt6s: sim.tel.vFwd,
      timeToStop: tStop,
      distanceToStop: tStop !== null ? Math.abs(zStop - z0) : null,
      idealBrakeDistance: (v0 * v0) / (2 * sim.mug),
      distanceIn6s: Math.abs(sim.tel.z - z0),
      ...ex.metrics(),
    };
  });
}

export const hxReverse: ManeuverDef = {
  name: 'hxReverse',
  title: 'hx. reverse flat out -> full forward; reverse + lock; pedals while rolling backward',
  async run(env) {
    const report = new Report();
    report.cases.push(await reverseFlatOut(env, false));
    report.cases.push(await reverseFlatOut(env, true));
    for (const pedal of ['brake', 'throttle', 'both', 'none', 'brakeTap'] as const) report.cases.push(await backwardPedal(env, 15, pedal));
    report.cases.push(await backwardPedal(env, 8, 'brake'));
    const b = report.cases.find((c) => c.id === 'backward.v15.brake')!.metrics;
    report.check('hxReverse.backwardBrakeStops', b.timeToStop, 'brake pedal stops a car rolling backward at 15 m/s within 3 s', b.timeToStop !== null && (b.timeToStop as number) < 3);
    for (const c of report.cases.slice(0, 2)) {
      report.check(`hxReverse.${c.id}.upright`, c.metrics.maxTiltDeg, 'no flip, finite', c.metrics.rolledOver === false && c.metrics.finite === true);
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Landings.

interface AirSpec { id: string; height: number; speed: number; yawDeg?: number; rollDeg?: number; pitchDeg?: number; yawRate?: number; throttle?: number }

async function airCase(env: LabEnv, a: AirSpec) {
  return runCase(env, `air.${a.id}`, FLAT, async (sim) => {
    airPose(sim, a);
    sim.useFixed({ throttle: a.throttle ?? 0 });
    const ex = new Extremes(sim);
    const wheels = sim.vehicle.wheelStates;
    const lowest = () => Math.min(...wheels.map((w) => w.position.y - w.radius));
    let touch: number | null = null;
    let touchPitch = 0, touchRoll = 0, touchBeta = 0, touchVy = 0, touchSpeed = 0;
    await sim.run(0.02);
    const startRoll = sim.tel.roll * DEG;
    const startPitch = sim.tel.pitch * DEG;
    const startTilt = sim.tel.tilt * DEG;
    await sim.run(3, (tel) => {
      ex.sample();
      // First contact: a tyre within 2 cm of the ground, or the body low.
      if (lowest() < 0.02 || tel.wheelsOff < 4) {
        touch = tel.t;
        touchPitch = tel.pitch * DEG;
        touchRoll = tel.roll * DEG;
        touchBeta = tel.beta * DEG;
        touchVy = tel.vy;
        touchSpeed = tel.speed;
        return true;
      }
      return false;
    });
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    let bounces = 0;
    let airRun = 0;
    let wasAir = false;
    let maxX = 0;
    await sim.run(4, (tel) => {
      ex.sample();
      betas.push(tel.speed > 3 ? tel.beta : 0);
      rates.push(tel.yawRate);
      maxX = Math.max(maxX, Math.abs(tel.x));
      const allAir = tel.wheelsOff === 4;
      airRun = allAir ? airRun + sim.dt : 0;
      if (airRun >= 0.05 && !wasAir) {
        bounces++;
        wasAir = true;
      }
      if (!allAir) wasAir = false;
    });
    return {
      startRollDeg: startRoll,
      startPitchDeg: startPitch,
      startTiltDeg: startTilt,
      landed: touch !== null,
      touchdownVy: touchVy,
      touchdownSpeed: touchSpeed,
      touchdownPitchDeg: touchPitch,
      touchdownRollDeg: touchRoll,
      touchdownBetaDeg: touchBeta,
      bounces,
      calmTime: calmTime(sim.dt, betas, rates),
      spunAfter: sim.track.spun,
      peakBetaAfterDeg: sim.track.maxAbsBeta * DEG,
      headingEndDeg: sim.tel.yaw * DEG,
      lateralSpan: maxX,
      speedEnd: sim.tel.speed,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

export const hxAir: ManeuverDef = {
  name: 'hxAir',
  title: 'hx. landings from 1 m at 15 m/s: sideways, two wheels, nose down / up, spinning, throttle held',
  async run(env) {
    const report = new Report();
    const cases: AirSpec[] = [
      { id: 'level', height: 1, speed: 15 },
      { id: 'yaw30', height: 1, speed: 15, yawDeg: 30 },
      { id: 'yaw60', height: 1, speed: 15, yawDeg: 60 },
      { id: 'yaw90', height: 1, speed: 15, yawDeg: 90 },
      { id: 'yaw90.v22', height: 1, speed: 22, yawDeg: 90 },
      { id: 'roll20', height: 1, speed: 15, rollDeg: 20 },
      { id: 'roll40', height: 1, speed: 15, rollDeg: 40 },
      { id: 'roll60', height: 1, speed: 15, rollDeg: 60 },
      { id: 'roll30.yaw30', height: 1, speed: 15, rollDeg: 30, yawDeg: 30 },
      { id: 'noseDown30', height: 1.2, speed: 15, pitchDeg: -30 },
      { id: 'noseDown50', height: 1.5, speed: 15, pitchDeg: -50 },
      { id: 'noseUp30', height: 1.2, speed: 15, pitchDeg: 30 },
      { id: 'spin3', height: 1, speed: 15, yawRate: 3 },
      { id: 'level.h3', height: 3, speed: 15 },
      { id: 'level.h3.throttle', height: 3, speed: 15, throttle: 1 },
      { id: 'roll40.h2', height: 2, speed: 15, rollDeg: 40 },
    ];
    let ok = 0;
    for (const a of cases) {
      const c = await airCase(env, a);
      report.cases.push(c);
      if (c.metrics.endsUpright === true && c.metrics.finite === true) ok++;
      report.check(`hxAir.${a.id}`, c.metrics.maxTiltDeg, 'ends upright, finite', c.metrics.endsUpright === true && c.metrics.finite === true);
    }
    report.summary.uprightFraction = ok / cases.length;
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// One wheel over a boulder / a square step at 20 m/s.

async function obstacleCase(env: LabEnv, id: string, v: number, spec: WorldSpec, zObstacle: number) {
  return runCase(env, id, spec, async (sim) => {
    // Speed held by a driver up to 3 m before the obstacle, then the foot
    // freezes and the hands let go (same protocol as the lab's rough test).
    sim.place({ x: 0, z: zObstacle - 3 - 2.5 * v, yaw: 0, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, 0);
    await sim.run(10, (tel) => tel.z >= zObstacle - 3);
    const throttle = sim.meanThrottle(1.0);
    const entrySpeed = sim.tel.speed;
    sim.useScript([{ t: 0, steering: 0, throttle, brake: 0 }]);
    const ex = new Extremes(sim);
    sim.resetTrack();
    let kick = 0;
    let minSpeed = v;
    let maxDev = 0;
    let kickAt05: number | null = null;
    let tHit: number | null = null;
    await sim.run(4, (tel) => {
      ex.sample();
      if (tHit === null && tel.z >= zObstacle - 1.6) tHit = tel.t;
      // Heading 0.5 s after the front axle reached the obstacle: the kick
      // itself, before 3 more seconds of driving where the nose points.
      if (tHit !== null && kickAt05 === null && tel.t - tHit >= 0.5) kickAt05 = tel.yaw * DEG;
      kick = Math.max(kick, Math.abs(tel.yaw));
      minSpeed = Math.min(minSpeed, tel.speed);
      maxDev = Math.max(maxDev, Math.abs(tel.x));
    });
    return {
      speed: v,
      entrySpeed,
      heldThrottle: throttle,
      passed: sim.tel.z > zObstacle + 10,
      headingAt05sDeg: kickAt05,
      headingKickDeg: kick * DEG,
      headingEndDeg: sim.tel.yaw * DEG,
      lateralDeviation: maxDev,
      minSpeed,
      speedEnd: sim.tel.speed,
      spun: sim.track.spun,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

export const hxObstacle: ManeuverDef = {
  name: 'hxObstacle',
  title: 'hx. one wheel dead-centre over a boulder, square steps, at 20 m/s (and 25)',
  async run(env) {
    const report = new Report();
    const rig = env.rig;
    const wheelX = rig ? rig.front.track / 2 : 0.84;
    const z = 40;
    const add = async (id: string, v: number, spec: WorldSpec) => {
      const c = await obstacleCase(env, id, v, spec, z);
      report.cases.push(c);
      report.check(`hxObstacle.${id}`, c.metrics.maxTiltDeg, 'upright, through, finite', c.metrics.endsUpright === true && c.metrics.finite === true && c.metrics.passed === true);
    };
    // Boulders centred on the LEFT wheel line; top at 0.9 r above ground.
    await add('boulder.r35.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.35, centerY: 0.0 }] });
    await add('boulder.r50.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.0 }] });
    await add('boulder.r50high.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 }] });
    await add('boulder.r50high.v25', 25, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 }] });
    // Boulder under the middle of the car (belly strike).
    await add('boulder.belly.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: 0, z, radius: 0.5, centerY: 0.0 }] });
    // Square-edged steps: one side, and full width.
    await add('step15.left.v20', 20, { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.5, height: 0.15 }] });
    await add('step25.left.v20', 20, { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.5, height: 0.25 }] });
    await add('step25.full.v20', 20, { kind: 'flat', obstacles: [{ type: 'kerb', x: 0, z, width: 6, depth: 0.5, height: 0.25 }] });
    await add('step40.full.v20', 20, { kind: 'flat', obstacles: [{ type: 'kerb', x: 0, z, width: 6, depth: 0.5, height: 0.4 }] });
    // Speed sweeps of the two everyday strikes (one-side kerb, small rock).
    for (const v of [8, 12, 16, 24]) {
      await add(`step15.left.v${v}`, v, { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.5, height: 0.15 }] });
      await add(`boulder.r35.v${v}`, v, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.35, centerY: 0.0 }] });
    }
    // Low rock (top 0.2 m: below the hull) and a rounded 0.15 m bump.
    await add('boulder.low20.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: -0.3 }] });
    await add('boulder.low10.v20', 20, { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: -0.4 }] });
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Slopes.

interface SlopeSetup { rot: Quaternion; down: Vector3; normal: Vector3; p0: Vector3 }

/**
 * Tilted 300 x 300 m slab through the origin and the car on it. `axis` 'z'
 * tilts sideways for a car heading +z (side slope, downhill = car's right for
 * yaw 0); 'x' tilts nose-up for a car heading +z.
 */
function onSlope(sim: Sim, axis: 'x' | 'z', angleDeg: number, o: { yaw?: number; speed?: number }): SlopeSetup {
  const a = angleDeg * RAD;
  // Side slope: surface rises toward −x. Nose-up: surface rises toward +z.
  const rot = axis === 'z' ? Quaternion.RotationAxis(new Vector3(0, 0, 1), -a) : Quaternion.RotationAxis(new Vector3(1, 0, 0), -a);
  // Probe the sign so the car always ends up on the HIGH side.
  const probe = new Vector3();
  (axis === 'z' ? new Vector3(-40, 0, 0) : new Vector3(0, 0, 40)).rotateByQuaternionToRef(rot, probe);
  const sign = probe.y > 0 ? 1 : -1;
  const flat = axis === 'z' ? new Vector3(-40 * sign, 0, 0) : new Vector3(0, 0, 40 * sign);
  addSlab(sim, 'Slope', new Vector3(0, -1, 0), new Vector3(300, 2, 300), rot, 2.0);
  const normal = new Vector3();
  new Vector3(0, 1, 0).rotateByQuaternionToRef(rot, normal);
  // Downhill unit vector in the surface.
  const down = new Vector3(normal.x * normal.y, normal.y * normal.y - 1, normal.z * normal.y).normalize();
  const pose = () => {
    sim.place({ x: flat.x, z: flat.z, yaw: o.yaw ?? 0 });
    rigidMove(sim, rot, Vector3.Zero(), Vector3.Zero());
    if (o.speed) {
      const yaw = o.yaw ?? 0;
      const v = new Vector3();
      new Vector3(Math.sin(yaw) * o.speed, 0, Math.cos(yaw) * o.speed).rotateByQuaternionToRef(rot, v);
      sim.vehicle.setMotion(v, 0);
    }
  };
  // Posed TWICE with one step in between. The hybrid model applies its tire
  // impulse at a world point of the NEW pose while Havok still holds the body
  // at the OLD one for that first frame (found by hxRespawn: a yaw kick
  // proportional to the teleport distance) — the second posing starts from a
  // body that is already there, so the slope numbers are free of that kick.
  pose();
  sim.step();
  pose();
  return { rot, down, normal, p0: sim.vehicle.chassisMesh.position.clone() };
}

function slopeTilt(sim: Sim, s: SlopeSetup): number {
  const up = sim.vehicle.chassisMesh.up;
  return Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(up, s.normal)))) * DEG;
}

async function slopeRest(env: LabEnv, id: string, axis: 'x' | 'z', angle: number, mode: 'handsOff' | 'brakeFromRoll' | 'brakeFromRest' | 'brakeFromRollBack', seconds: number) {
  return runCase(env, id, FLAT, async (sim) => {
    // 'brakeFromRoll': arrive rolling uphill/along at 3 m/s with the brake going on.
    const rolling = mode === 'brakeFromRoll';
    const s = onSlope(sim, axis, angle, { yaw: 0, speed: rolling ? 3 : 0 });
    const ex = new Extremes(sim);
    if (mode === 'brakeFromRoll') sim.useScript([{ t: 0, brake: 1 }]);
    else if (mode === 'brakeFromRest') sim.useScript([{ t: 0.3, brake: 1 }]);
    // Let it roll back for 1 s first, THEN brake (the player reacts late).
    else if (mode === 'brakeFromRollBack') sim.useScript([{ t: 1.0, brake: 1 }]);
    if (rolling) {
      await sim.run(3, (tel) => {
        ex.sample();
        return Math.hypot(tel.speed, tel.vy) < 0.1;
      });
    } else if (mode !== 'handsOff') {
      await sim.run(mode === 'brakeFromRest' ? 0.5 : 1.2, () => ex.sample());
    } else {
      await sim.run(0.3, () => ex.sample());
    }
    const start = sim.vehicle.chassisMesh.position.clone();
    const speedAtStart = Math.hypot(sim.tel.speed, sim.tel.vy);
    sim.resetTrack();
    let maxSpeed = 0;
    let at5 = 0;
    const t0 = sim.time;
    let maxTilt = 0;
    await sim.run(seconds, (tel) => {
      ex.sample();
      maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
      maxTilt = Math.max(maxTilt, slopeTilt(sim, s));
      if (Math.abs(tel.t - t0 - 5) < sim.dt / 2) at5 = Vector3.Distance(sim.vehicle.chassisMesh.position, start);
      // Left the slab: no point going on.
      return tel.y < 2;
    });
    const end = sim.vehicle.chassisMesh.position;
    return {
      slopeDeg: angle,
      mode,
      seconds: sim.time - t0,
      speedWhenTimingStarted: speedAtStart,
      driftAt5s: at5,
      drift: Vector3.Distance(end, start),
      downhillTravel: Vector3.Dot(end.subtract(start), s.down),
      maxSpeed,
      speedEnd: Math.hypot(sim.tel.speed, sim.tel.vy),
      modelSaysReversing: sim.vehicle.isReversing,
      maxTiltVsSlopeDeg: maxTilt,
      ...ex.metrics(),
    };
  });
}

async function slopeDrive(env: LabEnv, id: string, v: number, mode: 'handsOff' | 'hold' | 'turnUp' | 'turnDown' | 'brake') {
  return runCase(env, id, FLAT, async (sim) => {
    const s = onSlope(sim, 'z', 30, { yaw: 0, speed: v });
    const ex = new Extremes(sim);
    const start = sim.vehicle.chassisMesh.position.clone();
    // Which stick direction is downhill for this car? (+x = right)
    const downRight = Math.sign(Vector3.Dot(s.down, new Vector3(1, 0, 0)));
    const player = new StickPlayer(0.2, { throttle: 0.4, steering: 0, brake: 0 });
    sim.useFixed({ throttle: 0.4 });
    if (mode === 'turnUp') sim.useScript([{ t: 0.3, steering: -downRight, throttle: 0.4 }]);
    if (mode === 'turnDown') sim.useScript([{ t: 0.3, steering: downRight, throttle: 0.4 }]);
    if (mode === 'brake') sim.useScript([{ t: 0.3, brake: 1, throttle: 0 }]);
    let maxTilt = 0;
    let steerSum = 0;
    let n = 0;
    let rolled = false;
    const yaw0 = sim.tel.yaw;
    let maxDown = 0;
    await sim.run(5, (tel) => {
      ex.sample();
      if (mode === 'hold') {
        // Hold the heading along the contour (P on heading, D on yaw rate).
        const want = { throttle: 0.4, brake: 0, steering: Math.max(-1, Math.min(1, -(tel.yaw - yaw0) * 3 - tel.yawRate * 0.4)) };
        sim.useFixed(player.push(tel.t, want, sim.dt));
        steerSum += sim.intent.steering;
        n++;
      }
      const tilt = slopeTilt(sim, s);
      maxTilt = Math.max(maxTilt, tilt);
      if (tilt > 60) rolled = true;
      maxDown = Math.max(maxDown, Vector3.Dot(sim.vehicle.chassisMesh.position.subtract(start), s.down));
      return tel.y < 2 || rolled;
    });
    const end = sim.vehicle.chassisMesh.position;
    return {
      mode,
      speed: v,
      seconds: sim.time,
      downhillTravel: Vector3.Dot(end.subtract(start), s.down),
      maxDownhillTravel: maxDown,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      meanSteering: n > 0 ? steerSum / n : null,
      downhillIsRight: downRight,
      maxTiltVsSlopeDeg: maxTilt,
      rolledOnSlope: rolled,
      speedEnd: Math.hypot(sim.tel.speed, sim.tel.vy),
      ...ex.metrics(),
    };
  });
}

export const hxSlope: ManeuverDef = {
  name: 'hxSlope',
  title: 'hx. slopes: 30 deg side slope parked 30 s / driving / turning; nose-up 10-30 deg parked 30 s',
  async run(env) {
    const report = new Report();
    report.cases.push(await slopeRest(env, 'side30.parked.handsOff', 'z', 30, 'handsOff', 30));
    report.cases.push(await slopeRest(env, 'side30.parked.brakeFromRoll', 'z', 30, 'brakeFromRoll', 30));
    report.cases.push(await slopeRest(env, 'side20.parked.handsOff', 'z', 20, 'handsOff', 30));
    for (const angle of [5, 10, 15, 25]) report.cases.push(await slopeRest(env, `nose${angle}.handsOff`, 'x', angle, 'handsOff', 30));
    for (const angle of [15, 25, 30]) report.cases.push(await slopeRest(env, `nose${angle}.brakeFromRoll`, 'x', angle, 'brakeFromRoll', 30));
    report.cases.push(await slopeRest(env, 'nose15.brakeFromRest', 'x', 15, 'brakeFromRest', 5));
    report.cases.push(await slopeRest(env, 'nose15.brakeFromRollBack', 'x', 15, 'brakeFromRollBack', 5));
    report.cases.push(await slopeRest(env, 'nose25.brakeFromRollBack', 'x', 25, 'brakeFromRollBack', 5));
    for (const mode of ['handsOff', 'hold', 'turnUp', 'turnDown', 'brake'] as const) {
      report.cases.push(await slopeDrive(env, `side30.v10.${mode}`, 10, mode));
    }
    report.cases.push(await slopeDrive(env, 'side30.v18.hold', 18, 'hold'));
    report.cases.push(await slopeDrive(env, 'side30.v18.turnUp', 18, 'turnUp'));
    report.cases.push(await slopeDrive(env, 'side30.v18.turnDown', 18, 'turnDown'));
    for (const c of report.cases) {
      delete c.series;
      report.check(`hxSlope.${c.id}.finite`, c.metrics.finite, 'finite', c.metrics.finite === true);
    }
    const m = (id: string) => report.cases.find((c) => c.id === id)!.metrics;
    report.check('hxSlope.side30.parkedCreep', m('side30.parked.handsOff').drift, 'parked across a 30 deg slope: < 0.3 m in 30 s', (m('side30.parked.handsOff').drift as number) < 0.3);
    report.check('hxSlope.nose30.brakeCreep', m('nose30.brakeFromRoll').drift, 'brake holds on 30 deg: < 0.3 m in 30 s', (m('nose30.brakeFromRoll').drift as number) < 0.3);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Walls.

async function wallCase(env: LabEnv, id: string, v0: number, kind: 'square' | 'angled45' | 'half' | 'angled20') {
  return runCase(env, id, FLAT, async (sim) => {
    const faceZ = 60;
    const rig = sim.vehicle.rig;
    const noseLen = rig ? Math.max(rig.hull.size[2] / 2, rig.front.z + rig.front.tireRadius) : 2;
    if (kind === 'square') addSlab(sim, 'Wall', new Vector3(0, 2, faceZ + 1), new Vector3(60, 4, 2));
    else if (kind === 'half') addSlab(sim, 'Wall', new Vector3(-30, 2, faceZ + 1), new Vector3(60, 4, 2));
    else {
      // Wall rotated about the vertical through (0, faceZ): the car meets it
      // at 45 deg (or a 20 deg glance).
      const ang = kind === 'angled45' ? 45 : 70;
      const rot = Quaternion.RotationAxis(new Vector3(0, 1, 0), ang * RAD);
      const wall = addSlab(sim, 'Wall', new Vector3(0, 2, 1), new Vector3(80, 4, 2), rot);
      wall.position.z += faceZ;
      wall.computeWorldMatrix(true);
      wall.physicsBody!.disablePreStep = false;
    }
    sim.place({ x: 0, z: faceZ - noseLen - v0 * 1.0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 1 });
    const ex = new Extremes(sim);
    sim.resetTrack();
    let hitT: number | null = null;
    let maxNose = -Infinity;
    let minVz = Infinity;
    let peakDecel = 0;
    await sim.run(2.5, (tel) => {
      ex.sample();
      maxNose = Math.max(maxNose, tel.z + noseLen - faceZ);
      if (hitT === null && tel.vFwd < v0 * 0.6) hitT = tel.t;
      if (hitT !== null) minVz = Math.min(minVz, tel.vz);
      peakDecel = Math.max(peakDecel, -tel.aLong);
      return hitT !== null && tel.t - hitT > 1.5;
    });
    const afterHit = {
      speedAfterHit: sim.tel.speed,
      headingAfterHitDeg: sim.tel.yaw * DEG,
      tiltAfterHitDeg: sim.tel.tilt * DEG,
      yAfterHit: sim.tel.y,
      wheelsOffAfterHit: sim.tel.wheelsOff,
    };
    // Foot still down for 1.5 s (done above), now lift, then back out.
    sim.useScript([{ t: 0, throttle: 0 }, { t: 0.3, brake: 1 }]);
    const zBefore = sim.tel.z;
    const xBefore = sim.tel.x;
    let backed: number | null = null;
    const tB = sim.time;
    await sim.run(3.3, (tel) => {
      ex.sample();
      if (backed === null && Math.hypot(tel.z - zBefore, tel.x - xBefore) > 5) backed = tel.t - tB - 0.3;
    });
    return {
      kind,
      approachSpeed: v0,
      hit: hitT !== null,
      maxNosePastFace: maxNose,
      reboundVz: minVz === Infinity ? null : minVz,
      peakDecelG: peakDecel / sim.gravity,
      ...afterHit,
      timeToBackOut5m: backed,
      movedWhileBacking: Math.hypot(sim.tel.z - zBefore, sim.tel.x - xBefore),
      isReversingAtEnd: sim.vehicle.isReversing,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

export const hxWall: ManeuverDef = {
  name: 'hxWall',
  title: 'hx. walls: nose-first at 10 / 25 m/s with the foot down, then reverse out; 45 deg; glance; half-width',
  async run(env) {
    const report = new Report();
    report.cases.push(await wallCase(env, 'wall.square.v10', 10, 'square'));
    report.cases.push(await wallCase(env, 'wall.square.v25', 25, 'square'));
    report.cases.push(await wallCase(env, 'wall.angled45.v25', 25, 'angled45'));
    report.cases.push(await wallCase(env, 'wall.glance20.v25', 25, 'angled20'));
    report.cases.push(await wallCase(env, 'wall.half.v25', 25, 'half'));
    for (const c of report.cases) {
      report.check(`hxWall.${c.id}.sane`, c.metrics.maxSpeed3D, 'finite, upright, no explosion (speed never above 1.3 x approach)',
        c.metrics.finite === true && c.metrics.endsUpright === true && (c.metrics.maxSpeed3D as number) < 1.3 * (c.metrics.approachSpeed as number) + 2);
    }
    for (const c of report.cases.slice(0, 2)) {
      report.check(`hxWall.${c.id}.backsOut`, c.metrics.timeToBackOut5m, 'reverses 5 m clear within 3 s', c.metrics.timeToBackOut5m !== null);
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Upside down / on its side.

async function invertedCase(env: LabEnv, id: string, rollDeg: number, speed: number) {
  return runCase(env, id, FLAT, async (sim) => {
    airPose(sim, { height: 1.0, speed, rollDeg });
    const ex = new Extremes(sim);
    await sim.run(0.02);
    const startTilt = sim.tel.tilt * DEG;
    sim.useFixed({});
    await sim.run(4, () => ex.sample());
    const restTilt = sim.tel.tilt * DEG;
    const restSpeed = Math.hypot(sim.tel.speed, sim.tel.vy);
    const p1 = sim.vehicle.chassisMesh.position.clone();
    const grounded = sim.vehicle.wheelStates.filter((w) => w.grounded).length;
    // Now the player mashes everything.
    sim.useScript([
      { t: 0, throttle: 1, steering: 1 },
      { t: 2, throttle: 0, brake: 1, steering: -1 },
      { t: 4, throttle: 1, brake: 1, steering: 1 },
      { t: 5, throttle: 0, brake: 0, steering: 0 },
    ]);
    const exMash = new Extremes(sim);
    let maxRim = 0;
    await sim.run(7, () => {
      ex.sample();
      exMash.sample();
      maxRim = Math.max(maxRim, Math.abs(sim.vehicle.drivenRimSpeed));
    });
    const m = exMash.metrics();
    return {
      startTiltDeg: startTilt,
      tiltAfter4sDeg: restTilt,
      speedAfter4s: restSpeed,
      wheelsGroundedAtRest: grounded,
      mashMaxSpeed: m.maxSpeed3D,
      mashMaxAngVel: m.maxChassisAngVel,
      mashMoved: Vector3.Distance(sim.vehicle.chassisMesh.position, p1),
      mashMaxRimSpeed: maxRim,
      tiltEndDeg: sim.tel.tilt * DEG,
      selfRighted: sim.tel.tilt < 25 * RAD,
      ...ex.metrics(),
    };
  });
}

export const hxInverted: ManeuverDef = {
  name: 'hxInverted',
  title: 'hx. upside down / on its side: dropped from 1 m, 4 s rest, then every pedal mashed',
  async run(env) {
    const report = new Report();
    report.cases.push(await invertedCase(env, 'inverted.rest', 180, 0));
    report.cases.push(await invertedCase(env, 'inverted.v15', 180, 15));
    report.cases.push(await invertedCase(env, 'side90.rest', 90, 0));
    report.cases.push(await invertedCase(env, 'side90.v15', 90, 15));
    report.cases.push(await invertedCase(env, 'roll120.rest', 120, 0));
    report.cases.push(await invertedCase(env, 'roll75.rest', 75, 0));
    for (const c of report.cases) {
      report.check(`hxInverted.${c.id}.sane`, c.metrics.mashMaxSpeed, 'finite, no explosion (< 20 m/s from pedals alone, hubs stay attached)',
        c.metrics.finite === true && (c.metrics.maxHubDistance as number) < 3 && (c.id.endsWith('rest') ? (c.metrics.mashMaxSpeed as number) < 20 : true));
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Frame time: fixed 1/20 .. 1/144, jitter, hitch.

type DtOf = (i: number) => number;

async function ftLaunch(env: LabEnv, id: string, dtOf: DtOf) {
  return runCase(env, `launch.${id}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    runVar(sim, 1, dtOf);
    const ex = new Extremes(sim);
    const restDriftProbe = Math.hypot(sim.tel.x, sim.tel.z);
    sim.useScript([{ t: 0, throttle: 1 }]);
    const t0 = sim.time;
    let t10: number | null = null, t20: number | null = null;
    let drift = 0;
    runVar(sim, 6, dtOf, (tel) => {
      ex.sample();
      if (t10 === null && tel.vFwd >= 10) t10 = tel.t - t0;
      if (t20 === null && tel.vFwd >= 20) t20 = tel.t - t0;
      drift = Math.max(drift, Math.abs(tel.yaw));
    });
    return { restDrift1s: restDriftProbe, t10, t20, speedAt6s: sim.tel.vFwd, headingDriftDeg: drift * DEG, lateralOffset: Math.abs(sim.tel.x), ...ex.metrics() };
  });
}

async function ftStep(env: LabEnv, id: string, dtOf: DtOf) {
  return runCase(env, `stepSteer.${id}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
    sim.useFixed({ throttle: 0.35 });
    runVar(sim, 1, dtOf);
    sim.useScript([{ t: 0, steering: 1, throttle: 0.35 }]);
    const ex = new Extremes(sim);
    sim.resetTrack();
    const rates: number[] = [];
    const lats: number[] = [];
    const t0 = sim.time;
    runVar(sim, 3, dtOf, (tel) => {
      ex.sample();
      if (tel.t - t0 > 2.5) {
        rates.push(tel.yawRate);
        lats.push(Math.abs(tel.aCent));
      }
    });
    return {
      yawRateSteadyDeg: mean(rates) * DEG,
      yawRateRippleDeg: std(rates) * DEG,
      latSteadyFraction: mean(lats) / sim.mug,
      betaPeakDeg: sim.track.maxAbsBeta * DEG,
      spun: sim.track.spun,
      speedEnd: sim.tel.speed,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

async function ftSlide(env: LabEnv, id: string, dtOf: DtOf) {
  return runCase(env, `slide35.${id}`, FLAT, async (sim) => {
    const b0 = 35 * RAD;
    sim.place({ x: 0, z: 0, yaw: b0, speed: 15, beta: -b0, yawRate: b0 });
    sim.useFixed({});
    const ex = new Extremes(sim);
    // Fixed-interval resample of beta / yaw rate so the 0.5 s calm window
    // means the same at every step size.
    const betas: number[] = [];
    const rates: number[] = [];
    let next = 0;
    runVar(sim, 5, dtOf, (tel) => {
      ex.sample();
      while (tel.t >= next) {
        betas.push(tel.beta);
        rates.push(tel.yawRate);
        next += 1 / 120;
      }
    });
    return { ...analyzeSlide(1 / 120, betas, rates), headingEndDeg: sim.tel.yaw * DEG, speedEnd: sim.tel.speed, ...ex.metrics() };
  });
}

async function ftBrake(env: LabEnv, id: string, dtOf: DtOf) {
  return runCase(env, `brake.${id}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: 20 });
    sim.useFixed({ throttle: 0.5 });
    runVar(sim, 0.5, dtOf);
    const v1 = sim.tel.speed;
    const z1 = sim.tel.z;
    sim.useScript([{ t: 0, throttle: 0, brake: 1 }]);
    let yaw = 0;
    runVar(sim, 4, dtOf, (tel) => {
      yaw = Math.max(yaw, Math.abs(tel.yaw));
      return tel.speed < 0.2;
    });
    return { entrySpeed: v1, distance: sim.tel.z - z1, ideal: (v1 * v1) / (2 * sim.mug), headingDevDeg: yaw * DEG };
  });
}

async function ftRest(env: LabEnv, id: string, dtOf: DtOf) {
  return runCase(env, `rest.${id}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    const ex = new Extremes(sim);
    let maxSpeed = 0;
    let yMin = Infinity, yMax = -Infinity;
    runVar(sim, 10, dtOf, (tel) => {
      ex.sample();
      if (tel.t > 2) {
        maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
        yMin = Math.min(yMin, tel.y);
        yMax = Math.max(yMax, tel.y);
      }
    });
    return { restDrift10s: Math.hypot(sim.tel.x, sim.tel.z), restMaxSpeedAfter2s: maxSpeed, rideHeightBobbing: yMax - yMin, restYawDeg: sim.tel.yaw * DEG, ...ex.metrics() };
  });
}

/** Jump off the game's 18 deg ramp at 18 m/s at a given step. */
async function ftJump(env: LabEnv, id: string, dtOf: DtOf) {
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: 40, angleDeg: 18 }] };
  return runCase(env, `jump18.${id}`, spec, async (sim) => {
    sim.place({ x: 0, z: 10, yaw: 0, speed: 18 });
    sim.useFixed({ throttle: 0.45 });
    const ex = new Extremes(sim);
    sim.resetTrack();
    let maxY = 0;
    let airStart: number | null = null;
    let airEnd: number | null = null;
    let landPitch = 0;
    const wheels = sim.vehicle.wheelStates;
    runVar(sim, 6, dtOf, (tel) => {
      ex.sample();
      maxY = Math.max(maxY, tel.y);
      const allAir = wheels.every((w) => w.position.y - w.radius > 0.03) && tel.z > 40 + 9.5;
      if (airStart === null && allAir) airStart = tel.t;
      if (airStart !== null && airEnd === null && !allAir && tel.t > airStart + 0.05) {
        airEnd = tel.t;
        landPitch = tel.pitch * DEG;
      }
    });
    return {
      airtime: airStart !== null && airEnd !== null ? airEnd - airStart : null,
      apexY: maxY,
      landingPitchDeg: landPitch,
      headingEndDeg: sim.tel.yaw * DEG,
      speedEnd: sim.tel.speed,
      ...track(sim),
      ...ex.metrics(),
    };
  });
}

/** Steady full-lock circle at 15 m/s, then a disturbance in the frame time. */
async function ftHitch(env: LabEnv, id: string, hitch: number[]) {
  return runCase(env, `hitch.${id}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
    sim.useScript([{ t: 0, steering: 0.6, throttle: 0.4 }]);
    const base = 1 / 60;
    const pre: number[] = [];
    runVar(sim, 2.5, () => base, (tel) => {
      if (tel.t > 1.5) pre.push(tel.yawRate);
    });
    const steady = mean(pre);
    const steadyRipple = std(pre);
    const ex = new Extremes(sim);
    sim.resetTrack();
    let peakDev = 0;
    let peakBeta = 0;
    const tHitch = sim.time;
    let settle: number | null = null;
    let lastOut = 0;
    // Same total simulated time for every variant: 1.5 s.
    runVar(sim, 1.5, (i) => (i < hitch.length ? hitch[i] : base), (tel) => {
      ex.sample();
      const dev = Math.abs(tel.yawRate - steady);
      if (tel.t - tHitch > 0.001) peakDev = Math.max(peakDev, dev);
      peakBeta = Math.max(peakBeta, Math.abs(tel.beta));
      if (dev > Math.max(3 * steadyRipple, 2 * RAD)) lastOut = tel.t - tHitch;
    });
    settle = lastOut;
    return {
      hitchFrames: hitch.map((h) => h.toFixed(4)).join(','),
      steadyYawRateDeg: steady * DEG,
      steadyRippleDeg: steadyRipple * DEG,
      peakYawRateDeviationDeg: peakDev * DEG,
      peakBetaDeg: peakBeta * DEG,
      disturbedFor: settle,
      xEnd: sim.tel.x,
      zEnd: sim.tel.z,
      yawEndDeg: sim.tel.yaw * DEG,
      speedEnd: sim.tel.speed,
      tEnd: sim.time,
      ...ex.metrics(),
    };
  });
}

export const hxFrame: ManeuverDef = {
  name: 'hxFrame',
  title: 'hx. frame time: fixed 20 / 30 / 60 / 144 Hz, jittered 40-100 Hz, alternating 30/60, frame hitches',
  async run(env) {
    const report = new Report();
    const variants: Array<[string, () => DtOf]> = [
      ['hz20', () => () => 1 / 20],
      ['hz30', () => () => 1 / 30],
      ['hz60', () => () => 1 / 60],
      ['hz144', () => () => 1 / 144],
      ['jitter40to100', () => jitterDt(1 / 100, 1 / 40)],
      ['jitter30to120', () => jitterDt(1 / 120, 1 / 30, 777)],
      ['alt30and60', () => (i: number) => (i % 2 === 0 ? 1 / 30 : 1 / 60)],
    ];
    for (const [id, make] of variants) {
      for (const c of [
        await ftLaunch(env, id, make()),
        await ftStep(env, id, make()),
        await ftSlide(env, id, make()),
        await ftBrake(env, id, make()),
        await ftRest(env, id, make()),
        await ftJump(env, id, make()),
      ]) {
        delete c.series;
        report.cases.push(c);
        if ('finite' in c.metrics) report.check(`hxFrame.${c.id}.finite`, c.metrics.finite, 'finite', c.metrics.finite === true);
      }
    }
    const b = 1 / 60;
    report.cases.push(await ftHitch(env, 'none', []));
    report.cases.push(await ftHitch(env, 'one30', [1 / 30]));
    report.cases.push(await ftHitch(env, 'five30', [1 / 30, 1 / 30, 1 / 30, 1 / 30, 1 / 30]));
    report.cases.push(await ftHitch(env, 'one100ms', [0.1]));
    report.cases.push(await ftHitch(env, 'one200ms', [0.1, 0.1]));
    report.cases.push(await ftHitch(env, 'tiny1ms', [0.001, b, 0.001, b]));
    for (const c of report.cases.slice(-6)) delete c.series;
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Respawns and un-announced teleports.

export const hxRespawn: ManeuverDef = {
  name: 'hxRespawn',
  title: 'hx. 100 respawns in a row from ugly states; teleport without reset(); nudges',
  async run(env) {
    const report = new Report();
    // Fresh-car reference launch.
    const fresh = await ftLaunch(env, 'fresh', () => 1 / 60);
    delete fresh.series;
    report.cases.push(fresh);

    const c = await runCase(env, 'respawn100', FLAT, async (sim) => {
      const ex = new Extremes(sim);
      let worstDrift = 0, worstSpeed = 0, worstTilt = 0, worstYawErr = 0, worstHeight = 0, worstSpin = 0;
      let restY: number | null = null;
      let failures = 0;
      const bad: string[] = [];
      const yawBad: string[] = [];
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(1);
      restY = sim.tel.y;
      for (let i = 0; i < 100; i++) {
        // Make a mess first.
        const kind = i % 6;
        if (kind === 0) sim.useFixed({ throttle: 1, steering: 1 });
        else if (kind === 1) sim.useFixed({ brake: 1, steering: -1 });
        else if (kind === 2) sim.useFixed({ throttle: 1 });
        else if (kind === 3) {
          // Thrown into the air, tumbling.
          sim.vehicle.setMotion(new Vector3(6, 9, 12), 4);
          sim.useFixed({ throttle: 1 });
        } else if (kind === 4) {
          // On its roof.
          airPose(sim, { height: 1.5, speed: 10, rollDeg: 180 });
          sim.useFixed({ throttle: 1, steering: 1 });
        } else sim.useFixed({ throttle: 1, brake: 1, steering: 1 });
        await sim.run(0.45, () => ex.sample());
        // Respawn while the inputs are still held for the first 3 frames.
        const x = ((i * 37) % 80) - 40;
        const z = ((i * 53) % 80) - 40;
        const yaw = ((i * 0.7) % (2 * Math.PI)) - Math.PI;
        sim.place({ x, z, yaw });
        await sim.run(0.05, () => ex.sample());
        sim.useFixed({});
        await sim.run(0.6, () => ex.sample());
        const tel = sim.tel;
        const drift = Math.hypot(tel.x - x, tel.z - z);
        const speed = Math.hypot(tel.speed, tel.vy);
        let yawErr = Math.abs(tel.yaw - yaw) % (2 * Math.PI);
        if (yawErr > Math.PI) yawErr = 2 * Math.PI - yawErr;
        let spin = 0;
        for (const w of sim.vehicle.wheelStates) spin = Math.max(spin, Math.abs(w.spinSpeed));
        // Held throttle/brake during the first 0.05 s legitimately moves the car a little.
        worstDrift = Math.max(worstDrift, drift);
        worstSpeed = Math.max(worstSpeed, speed);
        worstTilt = Math.max(worstTilt, tel.tilt * DEG);
        worstYawErr = Math.max(worstYawErr, yawErr * DEG);
        worstHeight = Math.max(worstHeight, Math.abs(tel.y - restY));
        worstSpin = Math.max(worstSpin, spin);
        if (speed > 0.5 || tel.tilt > 5 * RAD || Math.abs(tel.y - restY) > 0.05 || !ex.finite) {
          failures++;
          if (bad.length < 6) bad.push(`#${i} kind${kind}: drift ${drift.toFixed(2)} m, speed ${speed.toFixed(2)}, tilt ${(tel.tilt * DEG).toFixed(1)}, vFwd ${tel.vFwd.toFixed(2)}`);
        }
        if (yawErr * DEG > 2 && yawBad.length < 6) yawBad.push(`#${i} kind${kind}: yaw err ${(yawErr * DEG).toFixed(1)} (asked ${(yaw * DEG).toFixed(0)}, got ${(tel.yaw * DEG).toFixed(0)}, yawRate ${(tel.yawRate * DEG).toFixed(1)})`);
      }
      // After the 100th respawn: is it still the same car?
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(1);
      sim.useScript([{ t: 0, throttle: 1 }]);
      const t0 = sim.time;
      let t10: number | null = null, t20: number | null = null;
      let drift = 0;
      await sim.run(6, (tel) => {
        if (t10 === null && tel.vFwd >= 10) t10 = tel.t - t0;
        if (t20 === null && tel.vFwd >= 20) t20 = tel.t - t0;
        drift = Math.max(drift, Math.abs(tel.yaw));
      });
      return {
        respawns: 100,
        badRespawns: failures,
        badList: bad.join(' | '),
        yawBadList: yawBad.join(' | '),
        worstDriftAfter065s: worstDrift,
        worstSpeedAfter065s: worstSpeed,
        worstTiltDeg: worstTilt,
        worstYawErrorDeg: worstYawErr,
        worstHeightError: worstHeight,
        worstWheelSpinAfter: worstSpin,
        afterT10: t10,
        afterT20: t20,
        afterSpeedAt6s: sim.tel.vFwd,
        afterHeadingDriftDeg: drift * DEG,
        ...ex.metrics(),
      };
    });
    delete c.series;
    report.cases.push(c);
    report.check('hxRespawn.clean', c.metrics.badRespawns, '0 of 100 respawns end moving / tilted / at the wrong height', c.metrics.badRespawns === 0);
    report.check('hxRespawn.sameCar', c.metrics.afterT20, 'launch after 100 respawns = fresh car (t20 within 0.02 s)',
      Math.abs((c.metrics.afterT20 as number) - (fresh.metrics.t20 as number)) < 0.02);

    // Respawn with the stick/pedals HELD the whole time (the player never lets go).
    const held = await runCase(env, 'respawnHeld', FLAT, async (sim) => {
      const ex = new Extremes(sim);
      sim.place({ x: 0, z: 0, yaw: 0 });
      sim.useFixed({ brake: 1 });
      await sim.run(2, () => ex.sample());
      const vBefore = sim.tel.vFwd;
      // Brake held through a respawn: forward-rolling latch must not survive.
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(1.5, () => ex.sample());
      return { reverseSpeedBeforeRespawn: vBefore, vFwd15sAfterRespawnBrakeHeld: sim.tel.vFwd, isReversing: sim.vehicle.isReversing, ...ex.metrics() };
    });
    delete held.series;
    report.cases.push(held);

    // Respawn with the THROTTLE held (the player never lifts off the trigger
    // while pressing reset), `far` metres to the side of where the car was.
    for (const [far, pedal] of [[0, 'throttle'], [5, 'throttle'], [20, 'throttle'], [80, 'throttle'], [150, 'throttle'], [80, 'none'], [80, 'brake'], [80, 'throttleLock']] as Array<[number, string]>) {
      const r = await runCase(env, `respawnPedalHeld.${pedal}.far${far}`, FLAT, async (sim) => {
        const ex = new Extremes(sim);
        sim.place({ x: 0, z: 0, yaw: 0 });
        await sim.run(0.5);
        const intent = pedal === 'throttle' ? { throttle: 1 } : pedal === 'brake' ? { brake: 1 } : pedal === 'throttleLock' ? { throttle: 1, steering: 1 } : {};
        sim.useFixed(intent);
        await sim.run(0.6, () => ex.sample());
        // Respawn `far` m to the side of the CURRENT position, heading +z.
        const x = sim.tel.x + far;
        const z = sim.tel.z;
        sim.place({ x, z, yaw: 0 });
        let peakYawRate = 0;
        let peakLat = 0;
        let yawAt02 = 0;
        const t0 = sim.time;
        await sim.run(1.5, (tel) => {
          ex.sample();
          peakYawRate = Math.max(peakYawRate, Math.abs(tel.yawRate));
          peakLat = Math.max(peakLat, Math.abs(tel.vx));
          if (Math.abs(tel.t - t0 - 0.2) < sim.dt / 2) yawAt02 = tel.yaw * DEG;
        });
        return {
          far,
          pedal,
          peakYawRateDeg: peakYawRate * DEG,
          yawAt02sDeg: yawAt02,
          yawAfter15sDeg: sim.tel.yaw * DEG,
          lateralAfter15s: sim.tel.x - x,
          forwardAfter15s: sim.tel.z - z,
          peakLateralSpeed: peakLat,
          peakBetaDeg: sim.track.maxAbsBeta * DEG,
          ...track(sim),
          ...ex.metrics(),
        };
      });
      delete r.series;
      report.cases.push(r);
      if (pedal === 'throttle') {
        report.check(`hxRespawn.pedalHeld.far${far}`, r.metrics.yawAfter15sDeg, 'respawn with the throttle held: heading within 3 deg after 1.5 s', Math.abs(r.metrics.yawAfter15sDeg as number) < 3);
      }
    }

    // Teleport WITHOUT reset(): the whole car shifted rigidly in one frame
    // (network correction, moving platform, editor nudge).
    for (const [id, shift, speed] of [
      ['nudge.side5cm.rest', new Vector3(0.05, 0, 0), 0],
      ['nudge.side15cm.rest', new Vector3(0.15, 0, 0), 0],
      ['nudge.fwd15cm.rest', new Vector3(0, 0, 0.15), 0],
      ['nudge.side15cm.v15', new Vector3(0.15, 0, 0), 15],
      ['nudge.side50cm.v15', new Vector3(0.5, 0, 0), 15],
      ['nudge.up20cm.rest', new Vector3(0, 0.2, 0), 0],
      ['nudge.far10m.v15', new Vector3(10, 0, 0), 15],
    ] as Array<[string, Vector3, number]>) {
      const n = await runCase(env, id, FLAT, async (sim) => {
        sim.place({ x: 0, z: 0, yaw: 0, speed });
        sim.useFixed({ throttle: speed > 0 ? 0.35 : 0 });
        await sim.run(1.0);
        const ex = new Extremes(sim);
        const x0 = sim.tel.x;
        const z0 = sim.tel.z;
        const yaw0 = sim.tel.yaw;
        const v0 = sim.tel.speed;
        rigidMove(sim, Quaternion.Identity(), Vector3.Zero(), shift, true);
        let peakLat = 0, peakYawRate = 0, peakBeta = 0, peakSpeedDelta = 0;
        await sim.run(2, (tel) => {
          ex.sample();
          peakLat = Math.max(peakLat, Math.abs(tel.vx));
          peakYawRate = Math.max(peakYawRate, Math.abs(tel.yawRate));
          peakBeta = Math.max(peakBeta, Math.abs(tel.beta));
          peakSpeedDelta = Math.max(peakSpeedDelta, Math.abs(tel.speed - v0));
        });
        return {
          shiftX: shift.x, shiftY: shift.y, shiftZ: shift.z,
          speed,
          // Where it ended relative to "shifted and otherwise undisturbed".
          lateralError: sim.tel.x - x0 - shift.x,
          alongError: speed > 0 ? null : sim.tel.z - z0 - shift.z,
          peakLateralSpeed: peakLat,
          peakYawRateDeg: peakYawRate * DEG,
          peakBetaDeg: peakBeta * DEG,
          peakSpeedChange: peakSpeedDelta,
          headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
          ...track(sim),
          ...ex.metrics(),
        };
      });
      delete n.series;
      report.cases.push(n);
    }
    return report.output();
  },
};

export const ABUSE_MANEUVERS: ManeuverDef[] = [
  hxSaw, hxDonut, hxBrakeLock, hxReverse, hxAir, hxObstacle, hxSlope, hxWall, hxInverted, hxFrame, hxRespawn,
];
