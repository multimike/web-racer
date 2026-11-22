import { Vector3 } from '@babylonjs/core';
import { DEG, RAD } from '../sim';
import type { LabEnv, ScriptKey, Sim } from '../sim';
import type { CaseResult, MetricValue } from '../types';
import type { WorldSpec } from '../world';
import { circlePath, profilePath } from '../paths';
import { FLAT, Report, fitCircle, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import {
  Health,
  addStaticBox,
  alignUp,
  moveCar,
  prng,
  rampHeight,
  rotateCar,
  setDt,
  setRigidMotion,
  timeToCalm,
} from './helpers';

/**
 * PLAYER-ABUSE maneuvers (break tests). Names start with 'ab'. They are
 * model-independent (public Vehicle interface only) and are appended to the
 * lab's suite by breakLab.ts — see break.html for how to run them.
 *
 * None of these has a scorecard line; each emits checks whose bands are the
 * minimum a player would expect (no NaN, no explosion, wheels stay on the
 * hubs, no rollover on flat ground from steering alone, parked = parked).
 */

function common(sim: Sim): Record<string, MetricValue> {
  return {
    maxBetaDeg: sim.track.maxAbsBeta * DEG,
    maxTiltDeg: sim.track.maxTilt * DEG,
    tiltEndDeg: sim.tel.tilt * DEG,
    sideLiftTime: sim.track.sideLiftTime,
    rolledOver: sim.track.rolledOver,
    spun: sim.track.spun,
    speedEnd: sim.tel.speed,
  };
}

function healthy(m: Record<string, MetricValue>, speedLimit = 40): boolean {
  return m.nan === false && (m.maxSpeed3d as number) < speedLimit && (m.maxHubShift as number) < 0.15;
}

function all(cases: CaseResult[], test: (m: Record<string, MetricValue>) => boolean): boolean {
  return cases.every((c) => test(c.metrics));
}

function count(cases: CaseResult[], test: (m: Record<string, MetricValue>) => boolean): string {
  const bad = cases.filter((c) => !test(c.metrics)).map((c) => c.id);
  return bad.length === 0 ? `${cases.length} / ${cases.length}` : `failed: ${bad.join(', ')}`;
}

// ---------------------------------------------------------------------------
// abSaw — full-lock left-right-left sawing at top speed.

async function sawCase(env: LabEnv, period: number, throttle: number) {
  return runCase(env, `p${Math.round(period * 1000)}.t${Math.round(throttle * 100)}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: 24.5 });
    sim.useFixed({ throttle: 1 });
    await sim.run(1.0);
    const health = new Health(sim);
    const keys: ScriptKey[] = [];
    for (let i = 0, t = 0; t < 8; i++, t += period / 2) keys.push({ t, steering: i % 2 === 0 ? -1 : 1, throttle, brake: 0 });
    sim.useScript(keys);
    sim.resetTrack();
    let maxYawRate = 0;
    let minSpeed = Infinity;
    let maxX = 0;
    let maxYaw = 0;
    await sim.run(8, (tel) => {
      health.watch();
      maxYawRate = Math.max(maxYawRate, Math.abs(tel.yawRate));
      minSpeed = Math.min(minSpeed, tel.speed);
      maxX = Math.max(maxX, Math.abs(tel.x));
      maxYaw = Math.max(maxYaw, Math.abs(tel.yaw));
    });
    const during = common(sim);
    const peakLat = sim.track.maxAbsALat / sim.mug;
    // Let go: stick centred, light throttle. Does it calm down by itself?
    sim.useScript([{ t: 0, steering: 0, throttle: 0.3, brake: 0 }]);
    const calm = await timeToCalm(sim, 5);
    return {
      period,
      throttle,
      ...during,
      maxYawRateDeg: maxYawRate * DEG,
      maxHeadingSwingDeg: maxYaw * DEG,
      minSpeed,
      maxLateral: maxX,
      peakLatFraction: peakLat,
      calmAfterRelease: calm,
      ...health.metrics(),
    };
  });
}

const abSaw: ManeuverDef = {
  name: 'abSaw',
  title: 'ab. full-lock left-right sawing at top speed (3 rhythms, on and off the throttle)',
  async run(env) {
    const report = new Report();
    for (const period of [0.4, 0.8, 1.6]) {
      for (const throttle of [1, 0]) report.cases.push(await sawCase(env, period, throttle));
    }
    const c = report.cases;
    report.check('abSaw.noRollover', count(c, (m) => m.rolledOver === false), 'never rolls over', all(c, (m) => m.rolledOver === false));
    report.check('abSaw.noSideLift', Math.max(...c.map((x) => x.metrics.sideLiftTime as number)), 'no 2-wheel lift > 0.2 s', all(c, (m) => (m.sideLiftTime as number) <= 0.2));
    report.check('abSaw.noSpin', count(c, (m) => m.spun === false), 'never spins (|beta| > 90 deg)', all(c, (m) => m.spun === false));
    report.check('abSaw.calms', count(c, (m) => m.calmAfterRelease !== null && (m.calmAfterRelease as number) < 2), 'calm < 2 s after letting go', all(c, (m) => m.calmAfterRelease !== null && (m.calmAfterRelease as number) < 2));
    report.check('abSaw.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    report.summary.worstBetaDeg = Math.max(...c.map((x) => x.metrics.maxBetaDeg as number));
    report.summary.worstTiltDeg = Math.max(...c.map((x) => x.metrics.maxTiltDeg as number));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abDonut — full throttle + full lock from standstill.

async function donutCase(env: LabEnv, id: string, stick: number) {
  return runCase(env, id, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    await sim.run(0.5);
    const health = new Health(sim);
    sim.resetTrack();
    sim.useScript([{ t: 0, steering: stick, throttle: 1, brake: 0 }]);
    const measure = async (seconds: number, tail: number) => {
      const xs: number[] = [];
      const zs: number[] = [];
      const rates: number[] = [];
      const betas: number[] = [];
      const speeds: number[] = [];
      const spins: number[] = [];
      const t0 = sim.time;
      await sim.run(seconds, (tel) => {
        health.watch();
        if (tel.t - t0 >= seconds - tail) {
          xs.push(tel.x);
          zs.push(tel.z);
          rates.push(tel.yawRate * DEG);
          betas.push(tel.beta * DEG);
          speeds.push(tel.speed);
          spins.push(sim.vehicle.drivenRimSpeed - tel.vFwd);
        }
      });
      const fit = fitCircle(xs, zs);
      return {
        radius: fit.r,
        radiusRms: fit.rms,
        yawRate: mean(rates),
        yawRateStd: std(rates),
        beta: mean(betas),
        betaStd: std(betas),
        speed: mean(speeds),
        wheelspin: mean(spins),
      };
    };
    // A: 10 s flat out on the lock stop.
    const a = await measure(10, 5);
    const tiltA = sim.track.maxTilt * DEG;
    const liftA = sim.track.sideLiftTime;
    // B: half throttle, same lock — does the throttle steer the donut?
    sim.useScript([{ t: 0, steering: stick, throttle: 0.5, brake: 0 }]);
    const b = await measure(4, 2);
    // C: flick to the opposite lock, flat out — transition.
    sim.useScript([{ t: 0, steering: -stick, throttle: 1, brake: 0 }]);
    let tFlip: number | null = null;
    const tC = sim.time;
    const wantSign = -Math.sign(a.yawRate);
    await sim.run(5, (tel) => {
      health.watch();
      if (tFlip === null && tel.yawRate * DEG * wantSign > 0.5 * Math.abs(a.yawRate)) tFlip = tel.t - tC;
    });
    // D: let go of everything.
    sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
    let tStill: number | null = null;
    const tD = sim.time;
    await sim.run(6, (tel) => {
      health.watch();
      if (tStill === null && Math.abs(tel.yawRate) < 10 * RAD && (tel.speed < 0.5 || Math.abs(tel.beta) < 5 * RAD)) tStill = tel.t - tD;
    });
    const L = sim.vehicle.wheelbase;
    return {
      lockRadiusKinematic: Math.hypot(L / Math.tan(sim.vehicle.maxSteerAngle), L / 2),
      radius: a.radius,
      radiusRms: a.radiusRms,
      yawRateDeg: a.yawRate,
      yawRateStdDeg: a.yawRateStd,
      betaDeg: a.beta,
      betaStdDeg: a.betaStd,
      speed: a.speed,
      wheelspin: a.wheelspin,
      latFraction: (a.speed * Math.abs(a.yawRate) * RAD) / sim.mug,
      maxTiltFlatOutDeg: tiltA,
      sideLiftFlatOut: liftA,
      halfThrottleRadius: b.radius,
      halfThrottleBetaDeg: b.beta,
      halfThrottleSpeed: b.speed,
      halfThrottleYawRateDeg: b.yawRate,
      flipTime: tFlip,
      stillAfterRelease: tStill,
      ...common(sim),
      ...health.metrics(),
    };
  });
}

const abDonut: ManeuverDef = {
  name: 'abDonut',
  title: 'ab. donuts: full throttle + full lock from standstill, throttle change, direction flip, release',
  async run(env) {
    const report = new Report();
    report.cases.push(await donutCase(env, 'right', 1));
    report.cases.push(await donutCase(env, 'left', -1));
    const c = report.cases;
    Object.assign(report.summary, c[0].metrics);
    report.check('abDonut.noRollover', count(c, (m) => m.rolledOver === false), 'never rolls over', all(c, (m) => m.rolledOver === false));
    report.check('abDonut.noSideLift', Math.max(...c.map((x) => x.metrics.sideLiftTime as number)), 'no 2-wheel lift > 0.2 s', all(c, (m) => (m.sideLiftTime as number) <= 0.2));
    report.check('abDonut.isDonut', c[0].metrics.betaDeg, 'tail out: |beta| > 15 deg flat out on the lock', all(c, (m) => Math.abs(m.betaDeg as number) > 15));
    report.check('abDonut.steady', c[0].metrics.yawRateStdDeg, 'steady rotation: yaw-rate std < 20 % of mean', all(c, (m) => (m.yawRateStdDeg as number) < 0.2 * Math.abs(m.yawRateDeg as number)));
    report.check('abDonut.symmetric', (c[1].metrics.radius as number) / (c[0].metrics.radius as number), 'left / right radius within 10 %', Math.abs((c[1].metrics.radius as number) / (c[0].metrics.radius as number) - 1) < 0.1);
    report.check('abDonut.flips', c[0].metrics.flipTime, 'opposite lock reverses the rotation < 2.5 s', all(c, (m) => m.flipTime !== null && (m.flipTime as number) < 2.5));
    report.check('abDonut.stops', c[0].metrics.stillAfterRelease, 'stops rotating < 2 s after release', all(c, (m) => m.stillAfterRelease !== null && (m.stillAfterRelease as number) < 2));
    report.check('abDonut.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abBrakeLock — slam the brake and the stick at speed.

async function brakeLockCase(env: LabEnv, v: number, stick: number, throttle: number) {
  return runCase(env, `v${Math.round(v)}.s${Math.round(stick * 100)}${throttle > 0 ? '.gas' : ''}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v });
    sim.useFixed({ throttle: 0.5 });
    await sim.run(0.3);
    const health = new Health(sim);
    const v0 = sim.tel.speed;
    sim.useScript([{ t: 0, steering: stick, brake: 1, throttle }]);
    sim.resetTrack();
    let dist = 0;
    const yaw0 = sim.tel.yaw;
    const t0 = sim.time;
    let tStop: number | null = null;
    await sim.run(6, (tel) => {
      health.watch();
      dist += tel.speed * sim.dt;
      if (tel.speed < 0.3) {
        tStop = tel.t - t0;
        return true;
      }
      return false;
    });
    return {
      entrySpeed: v0,
      stopTime: tStop,
      stopDistance: dist,
      idealDistance: (v0 * v0) / (2 * sim.mug),
      efficiency: (v0 * v0) / (2 * sim.mug) / dist,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      isReversing: sim.vehicle.isReversing,
      ...common(sim),
      ...health.metrics(),
    };
  });
}

const abBrakeLock: ManeuverDef = {
  name: 'abBrakeLock',
  title: 'ab. slam brake + full lock at 15 and 24.5 m/s (and both pedals)',
  async run(env) {
    const report = new Report();
    for (const v of [15, 24.5]) {
      report.cases.push(await brakeLockCase(env, v, 0, 0));
      report.cases.push(await brakeLockCase(env, v, 1, 0));
    }
    report.cases.push(await brakeLockCase(env, 24.5, 1, 1));
    const c = report.cases;
    report.check('abBrakeLock.stops', count(c, (m) => m.stopTime !== null), 'comes to a stop', all(c, (m) => m.stopTime !== null));
    report.check('abBrakeLock.noSpin', Math.max(...c.map((x) => x.metrics.maxBetaDeg as number)), 'no spin, tail-out < 30 deg', all(c, (m) => m.spun === false && (m.maxBetaDeg as number) < 30));
    report.check('abBrakeLock.noRollover', count(c, (m) => m.rolledOver === false), 'never rolls over', all(c, (m) => m.rolledOver === false && (m.sideLiftTime as number) <= 0.2));
    report.check('abBrakeLock.distance', Math.min(...c.map((x) => x.metrics.efficiency as number)), 'stops within 2x the ideal distance even with lock on', all(c, (m) => (m.efficiency as number) >= 0.5));
    report.check('abBrakeLock.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abReverse — full reverse, then full forward; J-turn; both pedals.

async function reverseCase(env: LabEnv, id: 'straight' | 'jturn' | 'bothPedals' | 'gentleSteer') {
  return runCase(env, id, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    await sim.run(0.5);
    const health = new Health(sim);
    sim.resetTrack();
    sim.useScript([{ t: 0, brake: 1 }]);
    let top = 0;
    let headDev = 0;
    let latDev = 0;
    let maxTilt = 0;
    const watch = (tel: Sim['tel']) => {
      health.watch();
      top = Math.min(top, tel.vFwd);
      headDev = Math.max(headDev, Math.abs(tel.yaw));
      latDev = Math.max(latDev, Math.abs(tel.x));
      maxTilt = Math.max(maxTilt, tel.tilt);
    };
    await sim.run(5, watch);
    const out: Record<string, MetricValue> = {
      reverseTopSpeed: -top,
      reverseSpeedAfter5s: -sim.tel.vFwd,
      reverseHeadingDevDeg: headDev * DEG,
      reverseLateralDev: latDev,
      wasReversing: sim.vehicle.isReversing,
    };
    if (id === 'straight') {
      sim.useScript([{ t: 0, brake: 0, throttle: 1 }]);
      const t0 = sim.time;
      let tZero: number | null = null;
      let tTen: number | null = null;
      let pitch = 0;
      await sim.run(4, (tel) => {
        watch(tel);
        pitch = Math.max(pitch, Math.abs(tel.pitch));
        if (tZero === null && tel.vFwd >= 0) tZero = tel.t - t0;
        if (tTen === null && tel.vFwd >= 10) tTen = tel.t - t0;
      });
      out.forwardZeroTime = tZero;
      out.forwardTenTime = tTen;
      out.flipMaxPitchDeg = pitch * DEG;
      out.totalHeadingDevDeg = headDev * DEG;
    } else if (id === 'jturn' || id === 'gentleSteer') {
      // Stick over while still reversing flat out.
      sim.useScript([{ t: 0, brake: 1, steering: id === 'jturn' ? 1 : 0.3 }]);
      const yaw0 = sim.tel.yaw;
      let maxRate = 0;
      let maxSlip = 0;
      let lift = 0;
      const trackBefore = sim.track.sideLiftTime;
      await sim.run(4, (tel) => {
        watch(tel);
        maxRate = Math.max(maxRate, Math.abs(tel.yawRate));
        // Slip relative to travelling BACKWARDS (beta itself reads ±180°).
        if (tel.speed > 1.5) maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(-tel.vLat, -tel.vFwd)));
      });
      lift = sim.track.sideLiftTime - trackBefore;
      out.steerYawChangeDeg = (sim.tel.yaw - yaw0) * DEG;
      out.steerMaxYawRateDeg = maxRate * DEG;
      out.steerMaxReverseSlipDeg = maxSlip * DEG;
      out.steerSideLiftTime = lift;
      out.steerSpeedEnd = sim.tel.speed;
      // ...and floor it forward out of the turn.
      sim.useScript([{ t: 0, brake: 0, throttle: 1, steering: 0 }]);
      await sim.run(3, watch);
      out.exitForwardSpeed = sim.tel.vFwd;
    } else {
      // Throttle floored while the brake is still held.
      sim.useScript([{ t: 0, brake: 1, throttle: 1 }]);
      const z0 = sim.tel.z;
      await sim.run(4, watch);
      out.bothPedalsSpeedEnd = sim.tel.vFwd;
      out.bothPedalsTravel = sim.tel.z - z0;
      out.bothPedalsReversing = sim.vehicle.isReversing;
      out.bothPedalsRimSpeed = sim.vehicle.drivenRimSpeed;
    }
    out.maxTiltDeg = maxTilt * DEG;
    out.rolledOver = sim.track.rolledOver;
    Object.assign(out, health.metrics());
    return out;
  });
}

const abReverse: ManeuverDef = {
  name: 'abReverse',
  title: 'ab. full reverse then full forward, reverse J-turn, both pedals',
  async run(env) {
    const report = new Report();
    for (const id of ['straight', 'gentleSteer', 'jturn', 'bothPedals'] as const) report.cases.push(await reverseCase(env, id));
    const c = report.cases;
    const s = c[0].metrics;
    Object.assign(report.summary, s);
    report.check('abReverse.straight', s.reverseHeadingDevDeg, 'hands-off reverse stays within 5 deg over 5 s', (s.reverseHeadingDevDeg as number) < 5);
    report.check('abReverse.forwardAgain', s.forwardTenTime, 'back to +10 m/s within 2.5 s of flooring it', s.forwardTenTime !== null && (s.forwardTenTime as number) < 2.5);
    report.check('abReverse.noFlip', s.flipMaxPitchDeg, 'pitch < 20 deg through the direction change', (s.flipMaxPitchDeg as number) < 20);
    report.check('abReverse.noRollover', count(c, (m) => m.rolledOver === false), 'never rolls over (incl. J-turn)', all(c, (m) => m.rolledOver === false));
    report.check('abReverse.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abBackwardBrake — what the BRAKE does while the car travels backwards or
// sideways (after a spin). A brake press that starts below 0.5 m/s FORWARD
// speed is "reverse" in both the legacy and the assist model.

async function backwardCase(env: LabEnv, id: string, v: number, betaDeg: number, pedal: 'brake' | 'throttle' | 'none') {
  return runCase(env, id, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v, beta: betaDeg * RAD });
    const health = new Health(sim);
    sim.useScript([{ t: 0, brake: pedal === 'brake' ? 1 : 0, throttle: pedal === 'throttle' ? 1 : 0, steering: 0 }]);
    sim.resetTrack();
    let dist = 0;
    let tStop: number | null = null;
    let peak = 0;
    let reversingAt = false;
    let revTime = 0;
    const t0 = sim.time;
    await sim.run(8, (tel) => {
      health.watch();
      dist += tel.speed * sim.dt;
      peak = Math.max(peak, tel.speed);
      if (sim.vehicle.isReversing) revTime += sim.dt;
      if (Math.abs(tel.t - t0 - 0.3) < sim.dt / 2) reversingAt = sim.vehicle.isReversing;
      if (tStop === null && tel.speed < 0.5) tStop = tel.t - t0;
      // "Stopped" for the throttle case = no longer travelling backwards.
      return tStop !== null || (pedal === 'throttle' && tel.vFwd > 0.5 && (tStop = tel.t - t0) !== null);
    });
    return {
      entrySpeed: v,
      entryBetaDeg: betaDeg,
      pedal,
      stopTime: tStop,
      stopDistance: dist,
      idealBrakeDistance: (v * v) / (2 * sim.mug),
      peakSpeed: peak,
      isReversingAt0p3s: reversingAt,
      reversingTime: revTime,
      speedEnd: sim.tel.speed,
      vFwdEnd: sim.tel.vFwd,
      maxTiltDeg: sim.track.maxTilt * DEG,
      rolledOver: sim.track.rolledOver,
      ...health.metrics(),
    };
  });
}

const abBackwardBrake: ManeuverDef = {
  name: 'abBackwardBrake',
  title: 'ab. brake / throttle while travelling backwards or sideways (after a spin)',
  async run(env) {
    const report = new Report();
    report.cases.push(await backwardCase(env, 'fwd15.brake', 15, 0, 'brake'));
    report.cases.push(await backwardCase(env, 'back15.brake', 15, 180, 'brake'));
    report.cases.push(await backwardCase(env, 'back15.throttle', 15, 180, 'throttle'));
    report.cases.push(await backwardCase(env, 'back15.none', 15, 180, 'none'));
    report.cases.push(await backwardCase(env, 'back8.brake', 8, 180, 'brake'));
    report.cases.push(await backwardCase(env, 'side15.brake', 15, 90, 'brake'));
    report.cases.push(await backwardCase(env, 'side15.none', 15, 90, 'none'));
    report.cases.push(await backwardCase(env, 'spun120.brake', 15, 120, 'brake'));
    report.cases.push(await backwardCase(env, 'spun120.none', 15, 120, 'none'));
    const by = (id: string) => report.cases.find((c) => c.id === id)!.metrics;
    for (const c of report.cases) {
      report.summary[`${c.id}.stopDistance`] = c.metrics.stopDistance;
      report.summary[`${c.id}.stopTime`] = c.metrics.stopTime;
    }
    const fwd = by('fwd15.brake').stopDistance as number;
    for (const id of ['back15.brake', 'back8.brake', 'spun120.brake']) {
      const m = by(id);
      report.check(`abBackwardBrake.${id}`, m.stopTime === null ? `not stopped after 8 s (${Math.round(m.speedEnd as number)} m/s)` : m.stopDistance, `brake stops the car within 3x the forward distance (${fwd.toFixed(1)} m)`, m.stopTime !== null && (m.stopDistance as number) < 3 * fwd);
    }
    report.check('abBackwardBrake.sideways', by('side15.brake').stopDistance, 'brake does not lengthen a sideways slide (vs no pedal)', (by('side15.brake').stopDistance as number) <= 1.1 * (by('side15.none').stopDistance as number));
    report.check('abBackwardBrake.healthy', count(report.cases, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(report.cases, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abAirLanding — sideways / two-wheel / nose-first / spinning landings.

interface AirCase {
  id: string;
  speed: number;
  height: number;
  betaDeg?: number;
  rollDeg?: number;
  pitchDeg?: number;
  yawRate?: number;
  rollRate?: number;
  throttle?: number;
}

async function airCase(env: LabEnv, a: AirCase) {
  return runCase(env, a.id, FLAT, async (sim) => {
    const beta = (a.betaDeg ?? 0) * RAD;
    sim.place({ x: 0, z: 0, yaw: 0, speed: a.speed, beta });
    moveCar(sim, 0, a.height, 0);
    const pivot = sim.vehicle.chassisMesh.position.clone();
    if (a.rollDeg) rotateCar(sim, new Vector3(0, 0, 1), a.rollDeg * RAD, pivot);
    if (a.pitchDeg) rotateCar(sim, new Vector3(1, 0, 0), a.pitchDeg * RAD, pivot);
    const v = new Vector3(Math.sin(beta) * a.speed, 0, Math.cos(beta) * a.speed);
    sim.vehicle.setMotion(v, a.yawRate ?? 0);
    if (a.rollRate) setRigidMotion(sim, v, new Vector3(0, 0, a.rollRate));
    sim.useFixed({ throttle: a.throttle ?? 0 });
    const health = new Health(sim);
    sim.resetTrack();
    let startRoll: number | null = null;
    let startPitch = 0;
    let landing: number | null = null;
    let landRoll = 0;
    let landPitch = 0;
    let landBeta = 0;
    let tEnd = Infinity;
    let settled: number | null = null;
    let calm = 0;
    const yaw0 = sim.tel.yaw;
    await sim.run(10, (tel) => {
      health.watch();
      if (startRoll === null) {
        startRoll = tel.roll;
        startPitch = tel.pitch;
      }
      if (landing === null) {
        if (tel.wheelsOff < 4 || tel.y < 0.9 * sim.vehicle.wheelStates[2].radius) {
          landing = tel.t;
          landRoll = tel.roll;
          landPitch = tel.pitch;
          landBeta = tel.speed > 1.5 ? Math.atan2(tel.vLat, tel.vFwd) : 0;
          tEnd = tel.t + 4;
          sim.resetTrack();
        }
        return false;
      }
      const down = tel.wheelsOff === 0 && tel.tilt < 15 * RAD && Math.abs(tel.yawRate) < 20 * RAD && Math.abs(tel.vy) < 1;
      calm = down ? calm + sim.dt : 0;
      if (settled === null && calm >= 0.3) settled = tel.t - landing - 0.3;
      return tel.t >= tEnd;
    });
    return {
      startRollDeg: (startRoll ?? 0) * DEG,
      startPitchDeg: startPitch * DEG,
      airtime: landing,
      landingRollDeg: landRoll * DEG,
      landingPitchDeg: landPitch * DEG,
      landingBetaDeg: landBeta * DEG,
      settleTime: settled,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      endsUpright: !sim.track.rolledOver && sim.tel.tilt < 25 * RAD,
      ...common(sim),
      ...health.metrics(),
    };
  });
}

async function kickerCase(env: LabEnv, v: number) {
  const rig = env.rig;
  const wheelX = rig ? rig.front.track / 2 : 0.84;
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: -wheelX, z: 40, angleDeg: 15, width: 1.0, length: 4 }] };
  return runCase(env, `kicker.v${v}`, spec, async (sim) => {
    sim.place({ x: 0, z: 40 - 2 * v, yaw: 0, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, 0);
    await sim.run(5, (tel) => tel.z >= 37);
    sim.useScript([{ t: 0, steering: 0, throttle: sim.meanThrottle(0.5), brake: 0 }]);
    const health = new Health(sim);
    sim.resetTrack();
    const yaw0 = sim.tel.yaw;
    let kick = 0;
    let dev = 0;
    await sim.run(5, (tel) => {
      health.watch();
      kick = Math.max(kick, Math.abs(tel.yaw - yaw0));
      dev = Math.max(dev, Math.abs(tel.x));
    });
    return {
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      headingKickDeg: kick * DEG,
      lateralDeviation: dev,
      endsUpright: !sim.track.rolledOver && sim.tel.tilt < 25 * RAD,
      ...common(sim),
      ...health.metrics(),
    };
  });
}

const abAirLanding: ManeuverDef = {
  name: 'abAirLanding',
  title: 'ab. bad landings: sideways, on two wheels, nose / tail first, spinning, one-side kicker',
  async run(env) {
    const report = new Report();
    const h = 2.0; // 0.4 s of fall at g = 25
    const cases: AirCase[] = [
      { id: 'level', speed: 15, height: h },
      { id: 'side30', speed: 15, height: h, betaDeg: 30 },
      { id: 'side60', speed: 15, height: h, betaDeg: 60 },
      { id: 'side90', speed: 15, height: h, betaDeg: 90 },
      { id: 'side60.gas', speed: 15, height: h, betaDeg: 60, throttle: 1 },
      { id: 'side90.v8', speed: 8, height: h, betaDeg: 90 },
      { id: 'roll20', speed: 15, height: h, rollDeg: 20 },
      { id: 'roll35', speed: 15, height: h, rollDeg: 35 },
      { id: 'roll50', speed: 15, height: h, rollDeg: 50 },
      { id: 'roll35.low', speed: 15, height: 0.6, rollDeg: 35 },
      { id: 'pitchA30', speed: 15, height: h, pitchDeg: 30 },
      { id: 'pitchA45', speed: 15, height: h, pitchDeg: 45 },
      { id: 'pitchB30', speed: 15, height: h, pitchDeg: -30 },
      { id: 'pitchB45', speed: 15, height: h, pitchDeg: -45 },
      { id: 'yawSpin4', speed: 15, height: h, yawRate: 4 },
      { id: 'rollSpin3', speed: 15, height: h, rollRate: 3 },
      { id: 'high5m', speed: 20, height: 5 },
    ];
    for (const a of cases) report.cases.push(await airCase(env, a));
    for (const v of [15, 22]) report.cases.push(await kickerCase(env, v));
    const c = report.cases;
    for (const x of c) report.summary[`${x.id}.upright`] = x.metrics.endsUpright;
    const mild = c.filter((x) => ['level', 'side30', 'roll20', 'roll35', 'roll35.low', 'pitchA30', 'pitchB30', 'high5m', 'kicker.v15', 'kicker.v22'].includes(x.id));
    report.check('abAirLanding.mildUpright', count(mild, (m) => m.endsUpright === true), 'mild cases (<= 35 deg off, <= 30 deg sideways) end upright', all(mild, (m) => m.endsUpright === true));
    report.check('abAirLanding.allUpright', count(c, (m) => m.endsUpright === true), 'info: every case ends upright', all(c, (m) => m.endsUpright === true));
    report.check('abAirLanding.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abBoulder — one wheel square onto a rock at 20 m/s.

async function boulderCase(env: LabEnv, id: string, v: number, x: number, radius: number, centerY: number) {
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'boulder', x, z: 30, radius, centerY }] };
  return runCase(env, id, spec, async (sim) => {
    sim.place({ x: 0, z: 30 - 2.5 * v, yaw: 0, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, 0);
    await sim.run(6, (tel) => tel.z >= 30 - radius - 4);
    sim.useScript([{ t: 0, steering: 0, throttle: sim.meanThrottle(0.5), brake: 0 }]);
    const health = new Health(sim);
    sim.resetTrack();
    const yaw0 = sim.tel.yaw;
    const entry = sim.tel.speed;
    const y0 = sim.tel.y;
    let kick = 0;
    let dev = 0;
    let minSpeed = entry;
    let passed = false;
    await sim.run(6, (tel) => {
      health.watch();
      kick = Math.max(kick, Math.abs(tel.yaw - yaw0));
      dev = Math.max(dev, Math.abs(tel.x));
      minSpeed = Math.min(minSpeed, tel.speed);
      if (tel.z > 30 + radius + 3) passed = true;
    });
    return {
      rockTop: centerY + radius,
      entrySpeed: entry,
      passed,
      hopHeight: health.maxY - y0,
      headingKickDeg: kick * DEG,
      lateralDeviation: dev,
      speedLostPct: (1 - minSpeed / entry) * 100,
      airborneTime: sim.track.anyLiftTime,
      endsUpright: !sim.track.rolledOver && sim.tel.tilt < 25 * RAD,
      ...common(sim),
      ...health.metrics(),
    };
  });
}

const abBoulder: ManeuverDef = {
  name: 'abBoulder',
  title: 'ab. one wheel square onto a rock at 20 m/s (0.2 / 0.35 / 0.5 / 0.7 m tall), and centre hit',
  async run(env) {
    const report = new Report();
    const rig = env.rig;
    const wheelX = rig ? rig.front.track / 2 : 0.84;
    report.cases.push(await boulderCase(env, 'wheel.h20', 20, wheelX, 0.4, -0.2));
    report.cases.push(await boulderCase(env, 'wheel.h35', 20, wheelX, 0.5, -0.15));
    report.cases.push(await boulderCase(env, 'wheel.h50', 20, wheelX, 0.5, 0));
    report.cases.push(await boulderCase(env, 'wheel.h70', 20, wheelX, 0.5, 0.2));
    report.cases.push(await boulderCase(env, 'wheel.h70.v10', 10, wheelX, 0.5, 0.2));
    report.cases.push(await boulderCase(env, 'centre.h50', 20, 0, 0.5, 0));
    report.cases.push(await boulderCase(env, 'centre.h70', 20, 0, 0.5, 0.2));
    const c = report.cases;
    for (const x of c) {
      report.summary[`${x.id}.upright`] = x.metrics.endsUpright;
      report.summary[`${x.id}.hop`] = x.metrics.hopHeight;
    }
    const small = c.filter((x) => x.id === 'wheel.h20' || x.id === 'wheel.h35');
    report.check('abBoulder.smallRocks', count(small, (m) => m.endsUpright === true && m.passed === true), 'rocks up to 0.35 m: upright and through', all(small, (m) => m.endsUpright === true && m.passed === true));
    report.check('abBoulder.allUpright', count(c, (m) => m.endsUpright === true), 'info: every rock ends upright', all(c, (m) => m.endsUpright === true));
    report.check('abBoulder.noLaunch', Math.max(...c.map((x) => x.metrics.hopHeight as number)), 'never thrown more than 3 m up', all(c, (m) => (m.hopHeight as number) < 3));
    report.check('abBoulder.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abSlope — driving along a side slope; resting on slopes for 30 s.

/** Put the freshly placed car onto a ramp obstacle's face. `d` = horizontal
 * distance past the entry edge, `rise` = unit horizontal direction the ramp
 * rises along. */
function seatOnRamp(sim: Sim, angleDeg: number, d: number, rise: [number, number]): void {
  const a = angleDeg * RAD;
  const p = sim.vehicle.chassisMesh.position;
  const ground = new Vector3(p.x, 0, p.z);
  const h = rampHeight(angleDeg, d);
  moveCar(sim, 0, h, 0);
  ground.y = h;
  const normal = new Vector3(-Math.sin(a) * rise[0], Math.cos(a), -Math.sin(a) * rise[1]);
  alignUp(sim, normal, ground);
  moveCar(sim, normal.x * 0.02, normal.y * 0.02, normal.z * 0.02);
}

async function traverseCase(env: LabEnv, angleDeg: number, v: number, mode: 'driver' | 'handsOff', tag = '') {
  // Ramp rising along +x; the car drives along +z across its face.
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: 0, yaw: Math.PI / 2, angleDeg, width: 500, length: 60 }] };
  return runCase(env, `traverse${angleDeg}.v${v}.${mode}${tag}`, spec, async (sim) => {
    const d0 = 25;
    sim.place({ x: d0, z: -150, yaw: 0 });
    seatOnRamp(sim, angleDeg, d0, [1, 0]);
    const fwd = sim.vehicle.chassisMesh.forward;
    sim.vehicle.setMotion(new Vector3(fwd.x * v, fwd.y * v, fwd.z * v), 0);
    if (mode === 'driver') {
      // Follows the contour line it starts on (pure pursuit + integral).
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.2 }));
      driver.followPath(profilePath(-150, 250, () => d0), v);
    } else {
      sim.useFixed({ throttle: 0.25 });
    }
    const health = new Health(sim);
    sim.resetTrack();
    let maxYaw = 0;
    let minX = d0;
    let maxX = d0;
    const upDot: number[] = [];
    let yawAt2s = 0;
    let stickSum = 0;
    const tStart = sim.time;
    await sim.run(6, (tel) => {
      health.watch();
      if (tel.t - tStart <= 2) yawAt2s = tel.yaw;
      stickSum += tel.steering * sim.dt;
      maxYaw = Math.max(maxYaw, Math.abs(tel.yaw));
      minX = Math.min(minX, tel.x);
      maxX = Math.max(maxX, tel.x);
      upDot.push(tel.tilt * DEG);
      // Ran off the bottom of the bank: stop judging.
      return tel.x < 3;
    });
    return {
      slopeDeg: angleDeg,
      requiredLatFraction: Math.tan(angleDeg * RAD) / sim.vehicle.nominalGrip,
      downhillDrift: d0 - minX,
      uphillDrift: maxX - d0,
      ranOffBottom: sim.tel.x < 3,
      runTime: upDot.length * sim.dt,
      maxHeadingDevDeg: maxYaw * DEG,
      // Hands-off: how fast the nose swings (− = downhill) in the first 2 s.
      headingRateFirst2sDeg: (yawAt2s * DEG) / 2,
      meanStick: stickSum / (upDot.length * sim.dt),
      meanTiltDeg: mean(upDot),
      maxLeanBeyondSlopeDeg: sim.track.maxTilt * DEG - angleDeg,
      speedEnd: sim.tel.speed,
      rolledOver: sim.track.rolledOver,
      sideLiftTime: sim.track.sideLiftTime,
      ...health.metrics(),
    };
  });
}

async function restCase(env: LabEnv, angleDeg: number, facing: 'up' | 'down' | 'across', pedal: 'none' | 'brake') {
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: 0, angleDeg, width: 40, length: 80 }] };
  return runCase(env, `rest${angleDeg}.${facing}.${pedal}`, spec, async (sim) => {
    const d0 = 30;
    const yaw = facing === 'up' ? 0 : facing === 'down' ? Math.PI : Math.PI / 2;
    sim.place({ x: 0, z: d0, yaw });
    seatOnRamp(sim, angleDeg, d0, [0, 1]);
    if (pedal === 'brake') {
      // The brake must be pressed while ROLLING to be a brake (a press at
      // standstill is reverse):
      const fwd = sim.vehicle.chassisMesh.forward;
      // roll at 4 m/s and press at once (on 40° the slope alone takes 16 m/s
      // off per second, so a later press would already be a standstill one).
      sim.vehicle.setMotion(new Vector3(fwd.x * 4, fwd.y * 4, fwd.z * 4), 0);
      sim.useFixed({});
      sim.useScript([{ t: 0, brake: 1 }], 0.12, 0.02);
    } else {
      sim.useFixed({});
    }
    const health = new Health(sim);
    // 2 s to come to rest, then 30 s of watching.
    await sim.run(2, () => health.watch());
    const p0 = sim.vehicle.chassisMesh.position.clone();
    const yaw0 = sim.tel.yaw;
    const speedAtStart = Math.hypot(sim.tel.speed, sim.tel.vy);
    let maxSpeed = 0;
    let creep5 = 0;
    const t0 = sim.time;
    await sim.run(30, (tel) => {
      health.watch();
      maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
      if (tel.t - t0 <= 5) creep5 = Vector3.Distance(sim.vehicle.chassisMesh.position, p0);
      // Rolled away: no point watching it leave the ramp.
      return Vector3.Distance(sim.vehicle.chassisMesh.position, p0) > 10;
    });
    const creep = Vector3.Distance(sim.vehicle.chassisMesh.position, p0);
    return {
      slopeDeg: angleDeg,
      facing,
      pedal,
      slopeLoadFraction: Math.sin(angleDeg * RAD),
      speedAfterSettle: speedAtStart,
      creep5s: creep5,
      creep30s: creep,
      watchedFor: sim.time - t0,
      rolledAway: creep > 10,
      maxSpeed,
      yawCreepDeg: (sim.tel.yaw - yaw0) * DEG,
      isReversing: sim.vehicle.isReversing,
      tiltEndDeg: sim.tel.tilt * DEG,
      ...health.metrics(),
    };
  });
}

const abSlope: ManeuverDef = {
  name: 'abSlope',
  title: 'ab. side-slope traverse (20 / 30 deg) and resting on slopes for 30 s',
  async run(env) {
    const report = new Report();
    const traverses: CaseResult[] = [];
    for (const angle of [20, 30]) {
      for (const v of [10, 18]) {
        for (const mode of ['driver', 'handsOff'] as const) traverses.push(await traverseCase(env, angle, v, mode));
      }
    }
    report.cases.push(...traverses);
    if (env.model === 'assist') {
      // Is the downhill swing the steering compliance? Same car without it.
      const stiff = { ...env, tune: { ...env.tune, steerCompliance: 0 } };
      report.cases.push(await traverseCase(stiff, 20, 10, 'handsOff', '.noCompliance'));
      report.cases.push(await traverseCase(stiff, 20, 10, 'driver', '.noCompliance'));
    }
    const rests: CaseResult[] = [];
    for (const angle of [15, 22, 30]) rests.push(await restCase(env, angle, 'up', 'none'));
    rests.push(await restCase(env, 15, 'down', 'none'));
    rests.push(await restCase(env, 22, 'down', 'none'));
    rests.push(await restCase(env, 15, 'across', 'none'));
    rests.push(await restCase(env, 30, 'across', 'none'));
    for (const angle of [15, 30, 40]) rests.push(await restCase(env, angle, 'up', 'brake'));
    rests.push(await restCase(env, 40, 'down', 'brake'));
    rests.push(await restCase(env, 30, 'down', 'brake'));
    report.cases.push(...rests);
    for (const c of rests) report.summary[`${c.id}.creep30s`] = c.metrics.creep30s;
    for (const c of traverses) report.summary[`${c.id}.downhillDrift`] = c.metrics.downhillDrift;

    report.check('abSlope.traverseNoRoll', count(traverses, (m) => m.rolledOver === false), 'never rolls over on a 20-30 deg side slope', all(traverses, (m) => m.rolledOver === false));
    const driven = traverses.filter((c) => c.id.endsWith('driver'));
    report.check('abSlope.traverseHolds', Math.max(...driven.map((c) => c.metrics.downhillDrift as number)), 'line-following driver slips < 2 m downhill in 6 s', all(driven, (m) => (m.downhillDrift as number) < 2));
    const off = traverses.filter((c) => c.id.endsWith('handsOff'));
    report.check('abSlope.traverseHandsOff', Math.min(...off.map((c) => c.metrics.headingRateFirst2sDeg as number)), 'info: hands-off the nose swings downhill slower than 5 deg/s', all(off, (m) => Math.abs(m.headingRateFirst2sDeg as number) < 5));
    const gentle = rests.filter((c) => (c.metrics.slopeDeg as number) <= 22 && c.metrics.pedal === 'none');
    report.check('abSlope.restHandsOff', Math.max(...gentle.map((c) => c.metrics.creep30s as number)), 'hands-off on <= 22 deg: < 0.10 m in 30 s', all(gentle, (m) => (m.creep30s as number) < 0.1));
    const braked = rests.filter((c) => c.metrics.pedal === 'brake' && (c.metrics.slopeDeg as number) <= 30);
    report.check('abSlope.restBrake', Math.max(...braked.map((c) => c.metrics.creep30s as number)), 'brake held on <= 30 deg: < 0.10 m in 30 s', all(braked, (m) => (m.creep30s as number) < 0.1));
    const across = rests.filter((c) => c.metrics.facing === 'across');
    report.check('abSlope.restAcross', Math.max(...across.map((c) => c.metrics.creep30s as number)), 'parked across the slope: < 0.10 m in 30 s', all(across, (m) => (m.creep30s as number) < 0.1));
    report.check('abSlope.healthy', count(report.cases, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(report.cases, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abWall — nose-first into a wall at top speed, then reverse out.

async function wallCase(env: LabEnv, id: string, v: number, wallYawDeg: number, tailFirst: boolean) {
  return runCase(env, id, FLAT, async (sim) => {
    const wallZ = tailFirst ? -60 : 80;
    // 4 m thick so even one 1/20 s step at top speed cannot jump it.
    const half = 2;
    const yaw = wallYawDeg * RAD;
    const sign = tailFirst ? -1 : 1;
    addStaticBox(sim, {
      center: [0, 3, wallZ + (sign * half) / Math.max(0.3, Math.cos(yaw))],
      size: [80, 6, 2 * half],
      yaw,
    });
    const rig = sim.vehicle.rig;
    const noseOffset = rig ? rig.hull.size[2] / 2 : 1.2;
    if (tailFirst) {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      sim.useScript([{ t: 0, brake: 1 }]);
    } else {
      sim.place({ x: 0, z: 80 - 2.5 * v, yaw: 0, speed: v });
      // Arrive AT the asked speed (flat out the car would be at top speed).
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
      driver.holdSpeed(v, null, 0);
    }
    const health = new Health(sim);
    sim.resetTrack();
    // Contact = near the wall the car has lost 30 % of its approach speed
    // (square hit) or is suddenly yawing (glancing hit).
    let peak = 0;
    let impactSpeed = 0;
    const hit = await sim.run(8, (tel) => {
      health.watch();
      if (tel.speed > peak) peak = tel.speed;
      const near = Math.abs(tel.z - wallZ) < 8;
      if (near && (tel.speed < 0.7 * peak || Math.abs(tel.yawRate) > 1.5)) {
        impactSpeed = peak;
        return true;
      }
      return false;
    });
    const yawAtHit = sim.tel.yaw;
    // Keep the pedal pinned for 1.5 s against the wall.
    if (!tailFirst) sim.useFixed({ throttle: 1 });
    let deepest = -Infinity;
    let rebound = 0;
    let judgingRebound = true;
    let maxTilt = 0;
    let maxPitch = 0;
    const y0 = sim.tel.y;
    let maxClimb = 0;
    const pinned = (tel: Sim['tel']) => {
      health.watch();
      // Depth past the wall face of the leading end of the hull.
      const lead = sign * (tel.z - wallZ) + noseOffset * Math.abs(Math.cos(tel.yaw));
      deepest = Math.max(deepest, lead);
      if (judgingRebound) rebound = Math.max(rebound, -sign * tel.vFwd);
      maxTilt = Math.max(maxTilt, tel.tilt);
      maxPitch = Math.max(maxPitch, Math.abs(tel.pitch));
      maxClimb = Math.max(maxClimb, tel.y - y0);
    };
    await sim.run(1.5, pinned);
    judgingRebound = false;
    // Glancing hits: how far does the car turn in those 1.5 s with the
    // throttle still down and the stick centred?
    const yawTurnedPinned = (sim.tel.yaw - yawAtHit) * DEG;
    const betaPinned = sim.tel.beta * DEG;
    const yawAfterHit = sim.tel.yaw * DEG;
    const speedPinned = sim.tel.speed;
    // Release, then back out (tail-first: drive out forwards).
    sim.useScript([{ t: 0, throttle: 0, brake: 0, steering: 0 }]);
    await sim.run(0.4, pinned);
    const zOut0 = sim.tel.z;
    const x0 = sim.tel.x;
    sim.useScript([tailFirst ? { t: 0, throttle: 1 } : { t: 0, brake: 1 }]);
    let tOut: number | null = null;
    const t0 = sim.time;
    await sim.run(3, (tel) => {
      pinned(tel);
      if (tOut === null && Math.hypot(tel.z - zOut0, tel.x - x0) >= 3) tOut = tel.t - t0;
    });
    return {
      hitWall: hit,
      impactSpeed,
      wallYawDeg,
      deepestPastFace: deepest,
      reboundSpeed: rebound,
      maxTiltDeg: maxTilt * DEG,
      maxPitchDeg: maxPitch * DEG,
      maxClimb,
      yawAfterHitDeg: yawAfterHit,
      yawTurnedWhilePinnedDeg: yawTurnedPinned,
      betaAfterPinnedDeg: betaPinned,
      speedWhilePinned: speedPinned,
      escapeTime3m: tOut,
      escaped: tOut !== null,
      endsUpright: !sim.track.rolledOver && sim.tel.tilt < 25 * RAD,
      rolledOver: sim.track.rolledOver,
      ...health.metrics(),
    };
  });
}

const abWall: ManeuverDef = {
  name: 'abWall',
  title: 'ab. into a wall at top speed (head-on, oblique, tail-first), pedal held, then back out',
  async run(env) {
    const report = new Report();
    report.cases.push(await wallCase(env, 'headOn.v24', 24.5, 0, false));
    report.cases.push(await wallCase(env, 'headOn.v12', 12, 0, false));
    report.cases.push(await wallCase(env, 'oblique30.v24', 24.5, 30, false));
    report.cases.push(await wallCase(env, 'oblique60.v24', 24.5, 60, false));
    report.cases.push(await wallCase(env, 'tailFirst', 12.5, 0, true));
    const c = report.cases;
    for (const x of c) {
      report.summary[`${x.id}.escapeTime3m`] = x.metrics.escapeTime3m;
      report.summary[`${x.id}.deepest`] = x.metrics.deepestPastFace;
    }
    report.check('abWall.hits', count(c, (m) => m.hitWall === true), 'harness: every case reaches the wall', all(c, (m) => m.hitWall === true));
    const squareOn = c.filter((x) => !x.id.startsWith('oblique'));
    report.check('abWall.noTunnel', Math.max(...squareOn.map((x) => x.metrics.deepestPastFace as number)), 'hull never more than 0.5 m into the wall (square hits)', all(squareOn, (m) => (m.deepestPastFace as number) < 0.5));
    report.check('abWall.upright', count(c, (m) => m.endsUpright === true), 'ends upright', all(c, (m) => m.endsUpright === true));
    report.check('abWall.noClimb', Math.max(...c.map((x) => x.metrics.maxClimb as number)), 'does not climb the wall (< 1 m) with the pedal held', all(c, (m) => (m.maxClimb as number) < 1));
    report.check('abWall.escapes', count(squareOn, (m) => m.escaped === true && (m.escapeTime3m as number) < 1.5), 'backs 3 m away within 1.5 s', all(squareOn, (m) => m.escaped === true && (m.escapeTime3m as number) < 1.5));
    report.check('abWall.healthy', count(c, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abInverted — on its roof / side / nose: NaNs, explosions, energy injection.

async function invertedCase(env: LabEnv, id: string, rollDeg: number, pitchDeg: number, slide: number) {
  return runCase(env, id, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    moveCar(sim, 0, 1.6, 0);
    const pivot = sim.vehicle.chassisMesh.position.clone();
    if (rollDeg) rotateCar(sim, new Vector3(0, 0, 1), rollDeg * RAD, pivot);
    if (pitchDeg) rotateCar(sim, new Vector3(1, 0, 0), pitchDeg * RAD, pivot);
    if (slide > 0) setRigidMotion(sim, new Vector3(0, 0, slide), Vector3.Zero());
    sim.useFixed({});
    const health = new Health(sim);
    sim.resetTrack();
    // 3 s to fall and come to rest, hands off.
    await sim.run(slide > 0 ? 5 : 3, () => health.watch());
    const restTilt = sim.tel.tilt * DEG;
    const restSpeed = Math.hypot(sim.tel.speed, sim.tel.vy);
    const restHealth = health.metrics('rest.');
    const p0 = sim.vehicle.chassisMesh.position.clone();
    // 8 s of a player mashing everything.
    const keys: ScriptKey[] = [];
    for (let i = 0, t = 0; t < 8; i++, t += 0.5) {
      keys.push({ t, steering: i % 2 === 0 ? 1 : -1, throttle: i % 4 < 3 ? 1 : 0, brake: i % 4 === 3 ? 1 : 0 });
    }
    sim.useScript(keys);
    let maxSpeed = 0;
    let maxSpin = 0;
    let maxRim = 0;
    await sim.run(8, (tel) => {
      health.watch();
      maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
      maxSpin = Math.max(maxSpin, Math.abs(tel.yawRate));
      maxRim = Math.max(maxRim, Math.abs(sim.vehicle.drivenRimSpeed));
    });
    return {
      restTiltDeg: restTilt,
      restSpeed,
      mashTravel: Vector3.Distance(sim.vehicle.chassisMesh.position, p0),
      mashMaxSpeed: maxSpeed,
      mashMaxYawRateDeg: maxSpin * DEG,
      mashMaxRimSpeed: maxRim,
      tiltEndDeg: sim.tel.tilt * DEG,
      selfRighted: sim.tel.tilt < 25 * RAD,
      ...restHealth,
      ...health.metrics(),
    };
  });
}

const abInverted: ManeuverDef = {
  name: 'abInverted',
  title: 'ab. on its roof / side / nose, then 8 s of mashing every control',
  async run(env) {
    const report = new Report();
    report.cases.push(await invertedCase(env, 'roof', 180, 0, 0));
    report.cases.push(await invertedCase(env, 'roof.slide15', 180, 0, 15));
    report.cases.push(await invertedCase(env, 'side', 90, 0, 0));
    report.cases.push(await invertedCase(env, 'side.slide15', 90, 0, 15));
    report.cases.push(await invertedCase(env, 'side120', 120, 0, 0));
    report.cases.push(await invertedCase(env, 'noseA', 0, 90, 0));
    report.cases.push(await invertedCase(env, 'noseB', 0, -90, 0));
    const c = report.cases;
    for (const x of c) {
      report.summary[`${x.id}.tiltEndDeg`] = x.metrics.tiltEndDeg;
      report.summary[`${x.id}.mashMaxSpeed`] = x.metrics.mashMaxSpeed;
    }
    report.check('abInverted.healthy', count(c, (m) => healthy(m, 30)), 'no NaN / explosion / hub stretch', all(c, (m) => healthy(m, 30)));
    const still = c.filter((x) => !x.id.includes('slide'));
    report.check('abInverted.rests', Math.max(...still.map((x) => x.metrics.restSpeed as number)), 'comes to rest (< 0.3 m/s after 3 s)', all(still, (m) => (m.restSpeed as number) < 0.3));
    const stuck = c.filter((x) => (x.metrics.restTiltDeg as number) > 100);
    report.check('abInverted.noRoofDrive', stuck.length ? Math.max(...stuck.map((x) => x.metrics.mashMaxSpeed as number)) : 0, 'a car resting on its roof cannot be driven (< 3 m/s)', all(stuck, (m) => (m.mashMaxSpeed as number) < 3));
    report.check('abInverted.selfRights', count(c, (m) => m.selfRighted === true), 'info: ends on its wheels (needs a respawn otherwise)', all(c, (m) => m.selfRighted === true));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abHitch — a dropped frame (one or five 1/30 s steps in a 60 Hz stream) and
// jittered frame times, compared with the undisturbed run of the same state.

type Disturbance = 'none' | 'one30' | 'five30' | 'jitter';
type HitchScenario = 'straight24' | 'corner21' | 'drift12' | 'brake20' | 'park15';

async function hitchCase(env: LabEnv, scenario: HitchScenario, disturbance: Disturbance) {
  const spec: WorldSpec = scenario === 'park15'
    ? { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: 0, angleDeg: 15, width: 40, length: 80 }] }
    : FLAT;
  return runCase(env, `${scenario}.${disturbance}`, spec, async (sim) => {
    const base = sim.dt;
    const rand = prng(12345);
    const jitter = disturbance === 'jitter';
    // Every step goes through here so the jitter case jitters from t = 0.
    const advance = async (seconds: number, onStep?: (tel: Sim['tel']) => boolean | void): Promise<void> => {
      const end = sim.time + seconds;
      while (sim.time < end - 1e-9) {
        setDt(sim, jitter ? base * (0.6 + 0.9 * rand()) : base);
        await sim.run(sim.dt);
        if (onStep?.(sim.tel) === true) break;
      }
      setDt(sim, base);
    };

    if (scenario === 'straight24') {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 24.5 });
      sim.useFixed({ throttle: 1 });
    } else if (scenario === 'corner21') {
      const R = 20;
      const v = 21;
      sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
      driver.followPath(circlePath(R, 1), v);
      await advance(3.0);
      // Freeze the controls: from here on the car is open-loop.
      sim.useFixed({ steering: sim.intent.steering, throttle: sim.meanThrottle(0.5) });
    } else if (scenario === 'drift12') {
      const target = 25 * RAD;
      sim.place({ x: 0, z: 0, yaw: target, speed: 12, beta: -target, yawRate: (0.65 * sim.mug) / 12 });
      sim.useFixed({ throttle: 0.7, steering: -0.2 });
    } else if (scenario === 'brake20') {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 20 });
      sim.useFixed({ throttle: 0.3 });
    } else {
      sim.place({ x: 0, z: 30, yaw: 0 });
      seatOnRamp(sim, 15, 30, [0, 1]);
      sim.useFixed({});
    }
    const health = new Health(sim);
    // 1 s lead-in; reference values = mean of its last 0.5 s.
    const refRate: number[] = [];
    const refBeta: number[] = [];
    const refSpeed: number[] = [];
    const lead = scenario === 'park15' ? 3 : 1;
    const tLead = sim.time;
    await advance(lead, (tel) => {
      health.watch();
      if (tel.t - tLead >= lead - 0.5) {
        refRate.push(tel.yawRate);
        refBeta.push(tel.beta);
        refSpeed.push(tel.speed);
      }
    });
    const rate0 = mean(refRate);
    const beta0 = mean(refBeta);
    const speed0 = mean(refSpeed);
    const p0 = sim.vehicle.chassisMesh.position.clone();
    const yaw0 = sim.tel.yaw;
    if (scenario === 'brake20') sim.useScript([{ t: 0, throttle: 0, brake: 1 }]);

    // The disturbance.
    const slow = disturbance === 'one30' ? 1 : disturbance === 'five30' ? 5 : 0;
    let dRate = 0;
    let dBeta = 0;
    let dSpeed = 0;
    let maxSpeed3 = 0;
    let dist = 0;
    let stopped: number | null = null;
    const tD = sim.time;
    const note = (tel: Sim['tel']) => {
      health.watch();
      if (tel.t - tD <= 1.0) {
        dRate = Math.max(dRate, Math.abs(tel.yawRate - rate0));
        dBeta = Math.max(dBeta, Math.abs(tel.beta - beta0));
        dSpeed = Math.max(dSpeed, Math.abs(tel.speed - speed0));
      }
      maxSpeed3 = Math.max(maxSpeed3, Math.hypot(tel.speed, tel.vy));
      dist += tel.speed * sim.dt;
      if (stopped === null && tel.speed < 0.3) stopped = dist;
    };
    for (let i = 0; i < slow; i++) {
      setDt(sim, 1 / 30);
      await sim.run(sim.dt);
      note(sim.tel);
    }
    setDt(sim, base);
    const marks: Record<string, MetricValue> = {};
    let next = 0;
    const at = [0.5, 1, 3];
    await advance(3 - slow / 30, (tel) => {
      note(tel);
      if (next < at.length && tel.t - tD >= at[next] - 1e-9) {
        const k = `t${at[next]}`;
        marks[`${k}.betaDeg`] = tel.beta * DEG;
        marks[`${k}.yawRateDeg`] = tel.yawRate * DEG;
        marks[`${k}.speed`] = tel.speed;
        next++;
      }
    });
    return {
      scenario,
      disturbance,
      refYawRateDeg: rate0 * DEG,
      refBetaDeg: beta0 * DEG,
      refSpeed: speed0,
      peakYawRateDevDeg: dRate * DEG,
      peakBetaDevDeg: dBeta * DEG,
      peakSpeedDev: dSpeed,
      headingChangeDeg: (sim.tel.yaw - yaw0) * DEG,
      lateralShift: sim.tel.x - p0.x,
      moved: Vector3.Distance(sim.vehicle.chassisMesh.position, p0),
      brakeDistance: scenario === 'brake20' ? stopped : null,
      maxSpeedAfter: maxSpeed3,
      ...marks,
      spun: sim.track.spun,
      rolledOver: sim.track.rolledOver,
      ...health.metrics(),
    };
  });
}

const abHitch: ManeuverDef = {
  name: 'abHitch',
  title: 'ab. frame hitch (1 or 5 steps at 1/30 s) and jittered frame times vs the undisturbed run',
  async run(env) {
    const report = new Report();
    const scenarios: HitchScenario[] = ['straight24', 'corner21', 'drift12', 'brake20', 'park15'];
    const kinds: Disturbance[] = ['none', 'one30', 'five30', 'jitter'];
    const by: Record<string, Record<string, MetricValue>> = {};
    for (const s of scenarios) {
      for (const k of kinds) {
        const c = await hitchCase(env, s, k);
        report.cases.push(c);
        by[c.id] = c.metrics;
      }
    }
    const n = (id: string, key: string) => by[id][key] as number;
    for (const k of ['one30', 'five30', 'jitter'] as const) {
      // Extra disturbance the hitch adds over what the undisturbed car does.
      const cornerRate = n(`corner21.${k}`, 'peakYawRateDevDeg') - n('corner21.none', 'peakYawRateDevDeg');
      const cornerBeta = n(`corner21.${k}`, 'peakBetaDevDeg') - n('corner21.none', 'peakBetaDevDeg');
      const straightHead = Math.abs(n(`straight24.${k}`, 'headingChangeDeg')) - Math.abs(n('straight24.none', 'headingChangeDeg'));
      const driftEnd = n(`drift12.${k}`, 't3.betaDeg') - n('drift12.none', 't3.betaDeg');
      const brake = n(`brake20.${k}`, 'brakeDistance') - n('brake20.none', 'brakeDistance');
      const park = n(`park15.${k}`, 'moved') - n('park15.none', 'moved');
      report.summary[`${k}.corner.extraYawRateDeg`] = cornerRate;
      report.summary[`${k}.corner.extraBetaDeg`] = cornerBeta;
      report.summary[`${k}.straight.extraHeadingDeg`] = straightHead;
      report.summary[`${k}.drift.betaAt3sDiffDeg`] = driftEnd;
      report.summary[`${k}.brake.extraDistance`] = brake;
      report.summary[`${k}.park.extraCreep`] = park;
      report.check(`abHitch.${k}.corner`, cornerRate, 'cornering: < 8 deg/s extra yaw-rate disturbance, < 3 deg extra slip', cornerRate < 8 && cornerBeta < 3);
      report.check(`abHitch.${k}.straight`, straightHead, 'top speed straight: < 1 deg extra heading change in 3 s', straightHead < 1);
      report.check(`abHitch.${k}.drift`, n(`drift12.${k}`, 't3.betaDeg'), 'open-loop drift still a drift 3 s later (|beta| 10-50 deg), as undisturbed', Math.abs(n(`drift12.${k}`, 't3.betaDeg')) > 10 === Math.abs(n('drift12.none', 't3.betaDeg')) > 10 && by[`drift12.${k}`].spun === by['drift12.none'].spun);
      report.check(`abHitch.${k}.brake`, brake, 'braking distance within 0.7 m of undisturbed', Math.abs(brake) < 0.7);
      report.check(`abHitch.${k}.park`, park, 'parked on 15 deg: < 0.05 m extra movement', park < 0.05);
    }
    report.check('abHitch.healthy', count(report.cases, (m) => healthy(m)), 'no NaN / explosion / hub stretch', all(report.cases, (m) => healthy(m)));
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abRespawn — 100 teleports in a row out of every kind of state.

const abRespawn: ManeuverDef = {
  name: 'abRespawn',
  title: 'ab. 100 respawns in a row (out of slides, flight, roof, parked), then rest and launch',
  async run(env) {
    const report = new Report();
    const launchT10 = async (sim: Sim): Promise<number | null> => {
      sim.useScript([{ t: 0, throttle: 1 }]);
      const t0 = sim.time;
      let t10: number | null = null;
      await sim.run(3, (tel) => {
        if (t10 === null && tel.vFwd >= 10) t10 = tel.t - t0;
        return t10 !== null;
      });
      return t10;
    };
    const fresh = await runCase(env, 'fresh', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      sim.useFixed({});
      await sim.run(2);
      const p0 = sim.vehicle.chassisMesh.position.clone();
      await sim.run(2);
      const drift = Vector3.Distance(sim.vehicle.chassisMesh.position, p0);
      // What a first spawn does in its first 0.5 s, for comparison.
      return { restDrift: drift, launchT10: await launchT10(sim) };
    });
    report.cases.push(fresh);

    const hundred = await runCase(env, 'x100', FLAT, async (sim) => {
      const rand = prng(777);
      const names = ['slide', 'flight', 'roof', 'brakeLock', 'parked'];
      const perKind: Record<string, MetricValue> = {};
      for (const n of names) {
        perKind[`${n}.planarKick`] = 0;
        perKind[`${n}.verticalKick`] = 0;
        perKind[`${n}.yawRateKickDeg`] = 0;
        perKind[`${n}.yawTurnedDeg`] = 0;
        perKind[`${n}.moved`] = 0;
      }
      let worstKick = 0;
      let worstKickAt = -1;
      let worstYawKick = 0;
      let worstTilt = 0;
      let worstSettle = 0;
      let nan = false;
      let maxHub = 0;
      for (let i = 0; i < 100; i++) {
        // 1. Get into some state.
        const kind = i % 5;
        if (kind === 0) {
          // mid-slide at speed, full throttle and lock
          sim.place({ x: 0, z: 0, yaw: 0.6, speed: 18, beta: -0.6, yawRate: 1.5 });
          sim.useFixed({ throttle: 1, steering: 1 });
          await sim.run(0.1 + 0.3 * rand());
        } else if (kind === 1) {
          // in the air, tumbling
          sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
          moveCar(sim, 0, 3, 0);
          setRigidMotion(sim, new Vector3(0, 4, 15), new Vector3(2, 1, 3));
          sim.useFixed({ throttle: 1 });
          await sim.run(0.1 + 0.3 * rand());
        } else if (kind === 2) {
          // on its roof
          sim.place({ x: 0, z: 0, yaw: 0 });
          moveCar(sim, 0, 1.6, 0);
          rotateCar(sim, new Vector3(0, 0, 1), Math.PI, sim.vehicle.chassisMesh.position.clone());
          sim.useFixed({ throttle: 1, steering: -1 });
          await sim.run(0.6);
        } else if (kind === 3) {
          // braking hard with lock
          sim.place({ x: 0, z: 0, yaw: 0, speed: 24 });
          sim.useFixed({ brake: 1, steering: -1 });
          await sim.run(0.1 + 0.2 * rand());
        } else {
          // parked (parking hold engaged), or reversing
          sim.place({ x: 0, z: 0, yaw: 0 });
          sim.useFixed(i % 2 === 0 ? {} : { brake: 1 });
          await sim.run(0.5);
        }
        // 2. Respawn somewhere else, hands off — sometimes twice in a frame.
        const x = (rand() - 0.5) * 400;
        const z = (rand() - 0.5) * 400;
        const yaw = (rand() - 0.5) * 2 * Math.PI;
        sim.useFixed({});
        sim.place({ x, z, yaw });
        if (i % 10 === 9) sim.place({ x, z, yaw });
        const health = new Health(sim);
        let kick = 0;
        let planar = 0;
        let vertical = 0;
        let yawKick = 0;
        let tilt = 0;
        const yawStart = sim.tel.yaw;
        await sim.run(0.5, (tel) => {
          health.watch();
          kick = Math.max(kick, Math.hypot(tel.speed, tel.vy));
          planar = Math.max(planar, tel.speed);
          vertical = Math.max(vertical, Math.abs(tel.vy));
          yawKick = Math.max(yawKick, Math.abs(tel.yawRate));
          tilt = Math.max(tilt, tel.tilt);
        });
        const n = names[kind];
        const worse = (key: string, value: number) => {
          if (value > (perKind[`${n}.${key}`] as number)) perKind[`${n}.${key}`] = value;
        };
        worse('planarKick', planar);
        worse('verticalKick', vertical);
        worse('yawRateKickDeg', yawKick * DEG);
        worse('yawTurnedDeg', Math.abs(sim.tel.yaw - yawStart) * DEG);
        worse('moved', Math.hypot(sim.tel.x - x, sim.tel.z - z));
        if (kick > worstKick) {
          worstKick = kick;
          worstKickAt = i;
        }
        worstYawKick = Math.max(worstYawKick, yawKick);
        worstTilt = Math.max(worstTilt, tilt);
        worstSettle = Math.max(worstSettle, Math.hypot(sim.tel.speed, sim.tel.vy));
        maxHub = Math.max(maxHub, health.maxHubShift);
        nan = nan || health.nan;
      }
      // 3. After the hundredth: is it still the same car?
      sim.place({ x: 0, z: 0, yaw: 0 });
      sim.useFixed({});
      await sim.run(2);
      const p0 = sim.vehicle.chassisMesh.position.clone();
      await sim.run(2);
      const drift = Vector3.Distance(sim.vehicle.chassisMesh.position, p0);
      const t10 = await launchT10(sim);
      return {
        respawns: 100,
        worstSpeedKick: worstKick,
        worstSpeedKickAt: worstKickAt,
        worstYawRateKickDeg: worstYawKick * DEG,
        worstTiltDeg: worstTilt * DEG,
        worstSpeedAfterHalfSecond: worstSettle,
        maxHubShift: maxHub,
        nan,
        restDrift: drift,
        launchT10: t10,
        maxSpeed3d: worstKick,
        ...perKind,
      };
    });
    report.cases.push(hundred);
    const m = hundred.metrics;
    Object.assign(report.summary, m);
    report.summary.freshLaunchT10 = fresh.metrics.launchT10;
    const worstOf = (key: string) => Math.max(...['slide', 'flight', 'roof', 'brakeLock', 'parked'].map((n) => m[`${n}.${key}`] as number));
    report.check('abRespawn.noKick', worstOf('planarKick'), 'a respawned car never moves faster than 0.3 m/s over the ground in its first 0.5 s', worstOf('planarKick') < 0.3);
    report.check('abRespawn.staysPut', worstOf('moved'), 'ends within 0.05 m of the spawn point', worstOf('moved') < 0.05);
    report.check('abRespawn.noYawKick', worstOf('yawTurnedDeg'), 'heading changes < 1 deg after a respawn', worstOf('yawTurnedDeg') < 1);
    report.check('abRespawn.upright', m.worstTiltDeg, 'tilt < 3 deg after a respawn', (m.worstTiltDeg as number) < 3);
    report.check('abRespawn.rest', m.restDrift, 'rests after the 100th: < 0.02 m in 2 s', (m.restDrift as number) < 0.02);
    report.check('abRespawn.sameCar', m.launchT10, `launch 0-10 within 5 % of a fresh car (${fresh.metrics.launchT10} s)`, m.launchT10 !== null && fresh.metrics.launchT10 !== null && Math.abs((m.launchT10 as number) / (fresh.metrics.launchT10 as number) - 1) < 0.05);
    report.check('abRespawn.healthy', m.nan, 'no NaN, hubs in place', m.nan === false && (m.maxHubShift as number) < 0.15);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// abSteady — FIXED stick and throttle in a corner: does the car hold a steady
// arc, or does it hunt (steering trim / compliance / damper limit cycles)?

async function steadyCase(env: LabEnv, v: number, stick: number) {
  return runCase(env, `v${v}.s${Math.round(stick * 100)}`, FLAT, async (sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, null, stick);
    await sim.run(4);
    // Freeze both controls: fully open-loop from here.
    sim.useFixed({ steering: stick, throttle: sim.meanThrottle(1.0) });
    await sim.run(1);
    const rates: number[] = [];
    const betas: number[] = [];
    const speeds: number[] = [];
    const lats: number[] = [];
    const hubs: number[] = [];
    sim.resetTrack();
    await sim.run(8, (tel) => {
      rates.push(tel.yawRate * DEG);
      betas.push(tel.beta * DEG);
      speeds.push(tel.speed);
      lats.push((tel.speed * Math.abs(tel.yawRate)) / sim.mug);
      hubs.push(((sim.vehicle.wheelStates[0].steerAngle + sim.vehicle.wheelStates[1].steerAngle) / 2) * DEG);
    });
    const m = mean(rates);
    // Detrend with a straight line (the speed drifts), then count crossings.
    let crossings = 0;
    const n = rates.length;
    const first = mean(rates.slice(0, Math.round(n / 4)));
    const last = mean(rates.slice(-Math.round(n / 4)));
    let prev = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const trend = first + ((last - first) * (i - n / 8)) / (n * 0.75);
      const d = rates[i] - trend;
      peak = Math.max(peak, Math.abs(d));
      if (i > 0 && d * prev < 0) crossings++;
      if (d !== 0) prev = d;
    }
    return {
      speedTarget: v,
      stick,
      commandedSteerDeg: sim.vehicle.currentSteerAngle * DEG,
      hubSteerMeanDeg: mean(hubs),
      hubSteerStdDeg: std(hubs),
      yawRateMeanDeg: m,
      yawRateStdDeg: std(rates),
      yawRateRippleDeg: peak,
      yawRateStdPct: (std(rates) / Math.max(Math.abs(m), 1e-6)) * 100,
      yawRateDriftDeg: last - first,
      ripplePeriod: crossings > 1 ? (2 * n * sim.dt) / crossings : null,
      latFractionMean: mean(lats),
      latFractionMin: Math.min(...lats),
      latFractionMax: Math.max(...lats),
      betaMeanDeg: mean(betas),
      betaStdDeg: std(betas),
      speedMean: mean(speeds),
      speedStart: speeds[0],
      speedEnd: speeds[n - 1],
      spun: sim.track.spun,
    };
  });
}

const abSteady: ManeuverDef = {
  name: 'abSteady',
  title: 'ab. fixed stick + fixed throttle cornering for 8 s: steady arc or hunting?',
  async run(env) {
    const report = new Report();
    for (const v of [10, 15, 20]) {
      for (const stick of [0.15, 0.3, 0.6, 1]) report.cases.push(await steadyCase(env, v, stick));
    }
    const c = report.cases;
    for (const x of c) report.summary[`${x.id}.yawRateStdPct`] = x.metrics.yawRateStdPct;
    report.check('abSteady.noHunting', Math.max(...c.map((x) => x.metrics.yawRateStdPct as number)), 'yaw-rate std < 6 % of its mean with frozen controls', all(c, (m) => (m.yawRateStdPct as number) < 6));
    report.check('abSteady.noSpin', count(c, (m) => m.spun === false), 'never spins', all(c, (m) => m.spun === false));
    return report.output();
  },
};

export const ABUSE_MANEUVERS: ManeuverDef[] = [
  abSaw,
  abDonut,
  abBrakeLock,
  abReverse,
  abBackwardBrake,
  abAirLanding,
  abBoulder,
  abSlope,
  abWall,
  abInverted,
  abHitch,
  abRespawn,
  abSteady,
];
