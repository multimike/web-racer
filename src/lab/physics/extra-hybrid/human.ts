/**
 * "HUMAN" criteria for the 'hybrid' model, as numbers:
 *
 *   huReaction     how late may the driver be? Imposed 35 / 50 deg slides and
 *                  the two slides a player really produces (floored in a
 *                  hairpin; lift-off flick at 15 m/s), caught after reaction
 *                  delays of 0.25 .. 1.5 s — and never.
 *   huOvercorrect  the same slides caught with 1x / 2x / 3x the tuned
 *                  countersteer, without yaw damping, and by a bang-bang
 *                  thumb (full opposite lock while the car is sideways).
 *   huDrift        can the DriverModel hold a drift for 5 s, and how wide is
 *                  the band of FIXED throttle that keeps it alive (steering
 *                  closed-loop, 0.2 s and ~0 s reaction)?
 */
import type { DriverParams } from '../../../car/DriverModel';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { circlePath } from '../paths';
import { FLAT, Report, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { StickPlayer, analyzeSlide } from './kit';

type M = Record<string, MetricValue>;

/** The hybrid author's drift-driver overrides (his report, section 5). */
const ADAPTED: Partial<DriverParams> = {
  driftSteerBias: 0.4, driftSteerGain: 0.5, driftSteerKi: 0,
  driftThrottle: 0.5, driftThrottleGain: 1.0, driftThrottleKi: 0.3, driftThrottleRate: 0.15,
};

type Onset = 'imposed35' | 'imposed50' | 'imposed35.floored' | 'hairpinPower' | 'flick15';

/**
 * Bring the car to the moment the slide has begun; returns false if this
 * car does not slide in that scenario. Inputs are left as the player had
 * them (they stay there for the whole reaction delay).
 */
async function slideOnset(sim: Sim, onset: Onset): Promise<boolean> {
  if (onset.startsWith('imposed')) {
    const b0 = (onset === 'imposed50' ? 50 : 35) * RAD;
    sim.place({ x: 0, z: 0, yaw: b0, speed: 15, beta: -b0, yawRate: b0 });
    sim.useFixed({ throttle: onset.endsWith('floored') ? 1 : 0.3 });
    return true;
  }
  const slow = onset === 'hairpinPower';
  const R = slow ? 12 : 20;
  const v = slow ? 9 : 15;
  sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
  const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
  cruise.followPath(circlePath(R, 1), v);
  await sim.run(2.5);
  if (slow) {
    sim.useScript([{ t: 0, steering: Math.min(1, sim.intent.steering + 0.3), throttle: 1, brake: 0 }]);
  } else {
    sim.useScript([
      { t: 0, steering: -1, throttle: 0, brake: 0 },
      { t: 0.25, steering: 1 },
      { t: 0.6, throttle: 1 },
    ]);
  }
  return sim.run(3.5, (tel) => tel.speed > 5 && -tel.beta >= 12 * RAD);
}

type Response =
  | { kind: 'driver'; delay: number; params?: Partial<DriverParams> }
  | { kind: 'never' }
  | { kind: 'liftOnly'; delay: number }
  | { kind: 'counterOnly'; delay: number }
  | { kind: 'bangBang'; delay: number; brake?: boolean; floored?: boolean };

async function catchCase(env: LabEnv, id: string, onset: Onset, response: Response) {
  return runCase(env, id, FLAT, async (sim): Promise<M> => {
    const slid = await slideOnset(sim, onset);
    if (!slid) return { slid: false };
    const onsetSpeed = sim.tel.speed;
    const course0 = sim.tel.yaw + sim.tel.beta;
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    const held = { ...sim.intent };
    const betas: number[] = [];
    const rates: number[] = [];
    let maxOff = 0;
    let player: StickPlayer | null = null;
    if (response.kind === 'driver') {
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: response.delay, ...response.params }));
      driver.recover(null, null);
    } else if (response.kind !== 'never') {
      player = new StickPlayer(response.delay, held);
    }
    sim.resetTrack();
    const maxSteer = sim.vehicle.maxSteerAngle;
    const L = sim.vehicle.wheelbase;
    let t45: number | null = null;
    let t90: number | null = null;
    const t0 = sim.time;
    await sim.run(6, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      // Distance from the line the car was travelling along at onset.
      const dx = tel.x - x0;
      const dz = tel.z - z0;
      maxOff = Math.max(maxOff, Math.abs(dx * Math.cos(course0) - dz * Math.sin(course0)));
      if (t45 === null && Math.abs(tel.beta) > 45 * RAD && tel.speed > 3) t45 = tel.t - t0;
      if (t90 === null && Math.abs(tel.beta) > 90 * RAD && tel.speed > 3) t90 = tel.t - t0;
      if (player) {
        let want = held;
        if (response.kind === 'liftOnly') want = { ...held, throttle: 0 };
        else if (response.kind === 'counterOnly') {
          // The lab driver's countersteer law, foot left where it was.
          const steer = 1.2 * tel.beta - 0.35 * Math.atan((L * tel.yawRate) / Math.max(tel.speed, 3));
          want = { ...held, steering: Math.max(-1, Math.min(1, steer / maxSteer)) };
        } else if (response.kind === 'bangBang') {
          const sideways = Math.abs(tel.beta) > 3 * RAD && tel.speed > 3;
          want = {
            steering: sideways ? Math.sign(tel.beta) : 0,
            throttle: response.floored ? 1 : 0,
            brake: response.brake ? 1 : 0,
          };
        }
        sim.useFixed(player.push(tel.t, want, sim.dt));
      }
    });
    const a = analyzeSlide(sim.dt, betas, rates);
    return {
      slid: true,
      onset,
      response: response.kind,
      delay: 'delay' in response ? response.delay : null,
      onsetSpeed,
      ...a,
      timeToBeta45: t45,
      timeToBeta90: t90,
      // Everything below is over the whole 6 s, not just up to the catch.
      everSpun: sim.track.spun,
      maxBetaDeg6s: sim.track.maxAbsBeta * DEG,
      lateralUsed: maxOff,
      headingEndVsCourseDeg: (sim.tel.yaw - course0) * DEG,
      speedEnd: sim.tel.speed,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      rolledOver: sim.track.rolledOver,
    };
  });
}

const DELAYS = [0.25, 0.4, 0.6, 0.8, 1.0, 1.5];
const ONSETS: Onset[] = ['imposed35', 'imposed50', 'imposed35.floored', 'hairpinPower', 'flick15'];

export const huReaction: ManeuverDef = {
  name: 'huReaction',
  title: 'hu. reaction time: slides caught after 0.25 .. 1.5 s, lift only, countersteer only, never',
  async run(env) {
    const report = new Report();
    for (const onset of ONSETS) {
      let latestClean: number | null = null;
      let latestNoSpin: number | null = null;
      for (const delay of DELAYS) {
        const c = await catchCase(env, `${onset}.driver.d${Math.round(delay * 100)}`, onset, { kind: 'driver', delay });
        delete c.series;
        report.cases.push(c);
        const m = c.metrics;
        if (m.slid === false) break;
        if (m.everSpun === false) latestNoSpin = delay;
        if (m.recovered === true && (m.overshoots as number) <= 1 && (m.recoveryTime as number) < delay + 2.0) latestClean = delay;
      }
      for (const [name, response] of [
        ['never', { kind: 'never' }],
        ['liftOnly.d40', { kind: 'liftOnly', delay: 0.4 }],
        ['counterOnly.d40', { kind: 'counterOnly', delay: 0.4 }],
      ] as Array<[string, Response]>) {
        const c = await catchCase(env, `${onset}.${name}`, onset, response);
        report.cases.push(c);
      }
      report.summary[`${onset}.latestDelayCleanCatch`] = latestClean;
      report.summary[`${onset}.latestDelayNoSpin`] = latestNoSpin;
      const never = report.cases.find((c) => c.id === `${onset}.never`)!.metrics;
      report.summary[`${onset}.never.timeToBeta90`] = never.timeToBeta90 ?? null;
      report.summary[`${onset}.never.maxBetaDeg`] = never.maxBetaDeg6s ?? null;
      report.check(`huReaction.${onset}.d60`, latestNoSpin, 'a 0.6 s-late driver still does not spin', latestNoSpin !== null && latestNoSpin >= 0.6);
    }
    return report.output();
  },
};

export const huOvercorrect: ManeuverDef = {
  name: 'huOvercorrect',
  title: 'hu. over-correction: 1x / 2x / 3x countersteer, no yaw damping, bang-bang thumb',
  async run(env) {
    const report = new Report();
    const responses: Array<[string, Response]> = [
      ['x1', { kind: 'driver', delay: 0.25 }],
      ['x2', { kind: 'driver', delay: 0.25, params: { counterGain: 2.4 } }],
      ['x3', { kind: 'driver', delay: 0.25, params: { counterGain: 3.6 } }],
      ['x2.noDamp', { kind: 'driver', delay: 0.25, params: { counterGain: 2.4, yawDamp: 0 } }],
      ['x2.d40', { kind: 'driver', delay: 0.4, params: { counterGain: 2.4 } }],
      ['x2.floored', { kind: 'driver', delay: 0.25, params: { counterGain: 2.4, recoverThrottle: 1 } }],
      ['bang.d25', { kind: 'bangBang', delay: 0.25 }],
      ['bang.d40', { kind: 'bangBang', delay: 0.4 }],
      ['bang.d25.brake', { kind: 'bangBang', delay: 0.25, brake: true }],
      ['bang.d25.floored', { kind: 'bangBang', delay: 0.25, floored: true }],
    ];
    for (const onset of ['imposed35', 'hairpinPower', 'flick15'] as Onset[]) {
      for (const [name, response] of responses) {
        const c = await catchCase(env, `${onset}.${name}`, onset, response);
        report.cases.push(c);
        const m = c.metrics;
        if (name === 'x2' || name === 'bang.d25') {
          report.check(`huOvercorrect.${onset}.${name}`, m.slid === false ? 'no slide' : `${m.overshoots} overshoots, swing ${Math.round(m.counterSwingDeg as number)} deg, spun ${m.everSpun}`,
            'no spin and <= 1 overshoot', m.slid === false || (m.everSpun === false && (m.overshoots as number) <= 1));
        }
      }
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// Drift.

type Entry = 'equilibrium' | 'brakeTap' | 'liftFlick' | 'powerOverSlow' | 'lab065';

async function driftEntry(sim: Sim, entry: Entry): Promise<{ ok: boolean; minSpeed: number }> {
  const target = 25 * RAD;
  if (entry === 'equilibrium' || entry === 'lab065') {
    // 'equilibrium': the steady drift the author's planar replica found
    // (12 m/s, 25 deg, 0.91 mu g). 'lab065': the lab's own entry state.
    const frac = entry === 'equilibrium' ? 0.91 : 0.65;
    sim.place({ x: 0, z: 0, yaw: target, speed: 12, beta: -target, yawRate: (frac * sim.mug) / 12 });
    return { ok: true, minSpeed: 5 };
  }
  const slow = entry === 'powerOverSlow';
  const R = slow ? 10 : 20;
  const v = slow ? 9 : 15;
  sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
  const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
  cruise.followPath(circlePath(R, 1), v);
  await sim.run(2.5);
  const stick = sim.intent.steering;
  if (slow) sim.useScript([{ t: 0, steering: Math.min(1, stick + 0.5), throttle: 1, brake: 0 }]);
  else if (entry === 'liftFlick') {
    sim.useScript([{ t: 0, steering: -1, throttle: 0, brake: 0 }, { t: 0.25, steering: 1 }, { t: 0.6, throttle: 1 }]);
  } else {
    sim.useScript([{ t: 0, steering: 1, throttle: 0, brake: 0.6 }, { t: 0.15, brake: 0, throttle: 1 }]);
  }
  const minSpeed = slow ? 4 : 7;
  const ok = await sim.run(3.5, (tel) => tel.speed >= minSpeed + 1 && -tel.beta >= 15 * RAD);
  return { ok, minSpeed };
}

async function driftHoldCase(env: LabEnv, id: string, entry: Entry, params: Partial<DriverParams>, targetDeg = 25, seconds = 6) {
  return runCase(env, id, FLAT, async (sim): Promise<M> => {
    const e = await driftEntry(sim, entry);
    if (!e.ok) return { initiated: false, holdTime: 0 };
    const driver = sim.makeDriver({ reactionDelay: 0.2, ...params });
    driver.driftHold(-targetDeg * RAD);
    if (entry === 'equilibrium' || entry === 'lab065') sim.useSettledDriver(driver);
    else sim.useDriver(driver);
    sim.resetTrack();
    const t0 = sim.time;
    const v0 = sim.tel.speed;
    let holdTime: number | null = null;
    let exit = `held ${seconds} s`;
    const slides: number[] = [];
    const speeds: number[] = [];
    const throttles: number[] = [];
    const steers: number[] = [];
    const all: number[] = [];
    const late: number[] = [];
    await sim.run(seconds, (tel) => {
      const slide = -tel.beta;
      all.push(slide * DEG);
      if (tel.t - t0 >= seconds - 2) late.push(slide * DEG);
      if (holdTime === null) {
        if (tel.speed < e.minSpeed) exit = 'too slow';
        else if (slide < 8 * RAD) exit = 'straightened';
        else if (slide > 55 * RAD) exit = 'spun out';
        if (exit !== `held ${seconds} s`) holdTime = tel.t - t0;
        else {
          slides.push(slide * DEG);
          speeds.push(tel.speed);
          throttles.push(tel.throttle);
          steers.push(tel.steering);
        }
      }
    });
    return {
      initiated: true,
      entry,
      targetDeg,
      entrySpeed: v0,
      holdTime: holdTime ?? seconds,
      exit,
      betaMeanDeg: mean(slides),
      betaStdDeg: std(slides),
      speedMean: mean(speeds),
      speedEnd: sim.tel.speed,
      throttleMean: mean(throttles),
      throttleStd: std(throttles),
      steerMean: mean(steers),
      steerStd: std(steers),
      everSpun: sim.track.spun,
      // Whole run, whatever happened: is it still some kind of slide?
      fractionOfRunAbove8Deg: all.filter((b) => b > 8).length / all.length,
      betaMeanWholeRunDeg: mean(all),
      betaStdWholeRunDeg: std(all),
      betaMeanLast2sDeg: mean(late),
      betaMaxLast2sDeg: Math.max(...late),
    };
  });
}

export const huDrift: ManeuverDef = {
  name: 'huDrift',
  title: 'hu. drift: 5 s hold by the DriverModel (default / adapted), fixed-throttle window, target angles',
  async run(env) {
    const report = new Report();
    const entries: Entry[] = ['equilibrium', 'lab065', 'brakeTap', 'liftFlick', 'powerOverSlow'];
    // (1) Closed-loop hold, 6 s: default lab driver and the author's adapted one.
    let bestHold = 0;
    for (const entry of entries) {
      for (const [name, params] of [['default', {}], ['adapted', ADAPTED]] as Array<[string, Partial<DriverParams>]>) {
        const c = await driftHoldCase(env, `hold.${entry}.${name}`, entry, params);
        report.cases.push(c);
        report.summary[`hold.${entry}.${name}`] = `${c.metrics.holdTime} s, ${c.metrics.exit ?? 'not initiated'}`;
        bestHold = Math.max(bestHold, c.metrics.holdTime as number);
      }
    }
    for (const target of [15, 35]) {
      for (const entry of ['equilibrium', 'brakeTap'] as Entry[]) {
        const c = await driftHoldCase(env, `hold.${entry}.adapted.target${target}`, entry, ADAPTED, target);
        delete c.series;
        report.cases.push(c);
        bestHold = Math.max(bestHold, c.metrics.holdTime as number);
      }
    }
    report.summary.bestClosedLoopHold = bestHold;
    report.check('huDrift.hold5s', bestHold, 'some driver/entry combination holds a drift >= 5 s', bestHold >= 5);

    // (2) Fixed-throttle window: steering closed-loop (adapted steering law),
    // throttle pinned. How many 5 %-wide throttle steps keep the slide alive?
    const fixedFoot = (throttle: number): Partial<DriverParams> => ({
      ...ADAPTED, driftThrottle: throttle, driftThrottleGain: 0, driftThrottleKi: 0, driftThrottleRate: 0,
    });
    for (const [tag, entry, delay] of [
      ['eq.d20', 'equilibrium', 0.2],
      ['eq.d02', 'equilibrium', 0.02],
      ['tap.d20', 'brakeTap', 0.2],
      ['tap.d02', 'brakeTap', 0.02],
    ] as Array<[string, Entry, number]>) {
      let best = 0;
      let bestAt = 0;
      const row: string[] = [];
      let wide3 = 0;
      let wide5 = 0;
      for (let pct = 20; pct <= 100; pct += 5) {
        const c = await driftHoldCase(env, `window.${tag}.t${pct}`, entry, { ...fixedFoot(pct / 100), reactionDelay: delay }, 25, 5);
        delete c.series;
        report.cases.push(c);
        const h = c.metrics.holdTime as number;
        row.push(h.toFixed(1));
        if (h > best) {
          best = h;
          bestAt = pct;
        }
        if (h >= 3) wide3++;
        if (h >= 4.99) wide5++;
      }
      report.summary[`window.${tag}.holdTimesAt20to100pct`] = row.join(' ');
      report.summary[`window.${tag}.best`] = `${best.toFixed(2)} s at ${bestAt} %`;
      report.summary[`window.${tag}.throttleStepsHolding3s`] = wide3;
      report.summary[`window.${tag}.throttleStepsHolding5s`] = wide5;
    }
    return report.output();
  },
};

export const HUMAN_MANEUVERS: ManeuverDef[] = [huReaction, huOvercorrect, huDrift];
