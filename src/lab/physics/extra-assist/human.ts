import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { DriverParams } from '../../../car/DriverModel';
import type { CaseResult, MetricValue } from '../types';
import { circlePath } from '../paths';
import { FLAT, Report, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { driftSustain, slideRecoveryCase } from '../maneuvers/sliding';
import { analyzeRecovery, driveWith, envWith } from './helpers';

/**
 * "HUMAN" criteria (break tests, names start with 'hu'):
 *   huReaction     how late may the driver react to a slide and still save it
 *   huOvercorrect  what over-correcting costs (2x / 3x gain, no damping,
 *                  bang-bang thumb)
 *   huDriftWindow  is a drift holdable, by whom, and how wide is the
 *                  throttle window; leaving a drift; changing direction
 * Appended to the lab's suite by breakLab.ts (see break.html).
 */

const DELAYS = [0.25, 0.4, 0.6, 0.8, 1.0, 1.5];

interface PowerSlide {
  /** Corner radius / speed the slide is provoked in. */
  R: number;
  v: number;
  /** Extra lock added with the throttle floored. */
  addStick: number;
  /** Tail-out angle at which the driver "notices". */
  onsetDeg: number;
  /** Reaction delay, s; Infinity = never reacts (foot down, lock held). */
  delay: number;
  driver?: Partial<DriverParams>;
  /** The `thumb` controller instead of the lab driver (gain Infinity =
   * bang-bang), with this throttle once it reacts. */
  thumb?: { gain: number; throttle: number };
}

/**
 * Power slide the player gets by flooring it in a corner. From the moment
 * the tail is `onsetDeg` out, the foot STAYS DOWN and the stick stays where
 * it was for `delay` seconds; then the driver countersteers and lifts.
 */
async function powerSlideCase(env: LabEnv, id: string, o: PowerSlide) {
  return runCase(env, id, FLAT, async (sim: Sim): Promise<Record<string, MetricValue>> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: o.v, yawRate: o.v / o.R });
    const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
    cruise.followPath(circlePath(o.R, 1), o.v);
    await sim.run(2.5);
    sim.useScript([{ t: 0, steering: Math.min(1, sim.intent.steering + o.addStick), throttle: 1, brake: 0 }]);
    const t0 = sim.time;
    let peakBefore = 0;
    const slid = await sim.run(4.0, (tel) => {
      peakBefore = Math.max(peakBefore, -tel.beta);
      return tel.speed > 5 && -tel.beta >= o.onsetDeg * RAD;
    });
    if (!slid) {
      return { slid: false, peakOversteerDeg: peakBefore * DEG, delay: Number.isFinite(o.delay) ? o.delay : null };
    }
    const timeToSlide = sim.time - t0;
    const onsetSpeed = sim.tel.speed;
    const course0 = sim.tel.yaw + sim.tel.beta;
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    const log = (tel: Sim['tel']) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    };
    sim.resetTrack();
    let betaAtReaction: number | null = null;
    let speedAtReaction: number | null = null;
    if (!Number.isFinite(o.delay)) {
      await sim.run(6.0, log);
    } else if (o.thumb) {
      const before = { steering: sim.intent.steering, throttle: 1 };
      const tR = sim.time;
      await driveWith(sim, 6.0, thumb(sim, { gain: o.thumb.gain, delay: o.delay, throttle: o.thumb.throttle, before }), (tel) => {
        log(tel);
        if (betaAtReaction === null && tel.t - tR >= o.delay) {
          betaAtReaction = tel.beta * DEG;
          speedAtReaction = tel.speed;
        }
      });
    } else {
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: o.delay, ...o.driver }));
      driver.recover(null, null);
      const tR = sim.time;
      await sim.run(6.0, (tel) => {
        log(tel);
        if (betaAtReaction === null && tel.t - tR >= o.delay) {
          betaAtReaction = tel.beta * DEG;
          speedAtReaction = tel.speed;
        }
      });
    }
    const tail = betas.slice(-Math.round(2 / sim.dt));
    return {
      slid: true,
      delay: Number.isFinite(o.delay) ? o.delay : null,
      timeToSlide,
      onsetSpeed,
      onsetBetaDeg: o.onsetDeg,
      betaAtReactionDeg: betaAtReaction,
      speedAtReaction,
      ...analyzeRecovery(sim.dt, betas, rates, yaws, course0),
      // What the car is doing over the last 2 s (held slide? spinning?).
      tailBetaMeanDeg: mean(tail) * DEG,
      tailBetaStdDeg: std(tail) * DEG,
      weaveYawRateRmsDeg: weave(sim.dt, rates),
      yawTurnedDeg: (yaws[yaws.length - 1] - yaws[0]) * DEG,
      speedEnd: sim.tel.speed,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      rolledOver: sim.track.rolledOver,
    };
  });
}

/** Slip angle at the REAR axle, rad (the actual slide; the body slip at the
 * wheelbase centre also contains the kinematic term of any turn, which makes
 * a "steer toward beta" law hold full lock for ever at low speed). */
function rearSlip(sim: Sim): number {
  const tel = sim.tel;
  if (tel.speed < 1.5) return 0;
  return Math.atan2(tel.vLat - 0.5 * sim.vehicle.wheelbase * tel.yawRate, Math.max(Math.abs(tel.vFwd), 1));
}

/**
 * A thumb, not a control law: steer toward the rear slip as seen `delay`
 * seconds ago, `gain` x the angle that would point the front wheels along
 * the direction of travel (1 = textbook, 2-3 = over-correcting, Infinity =
 * bang-bang: full opposite lock until the tail is within 3°). No yaw-rate
 * damping, no anticipation. Until the first delayed sample arrives the
 * controls stay as they were.
 */
function thumb(sim: Sim, o: { gain: number; delay: number; throttle: number; before: { steering: number; throttle: number } }) {
  const seen: Array<[number, number]> = [];
  const lock = Math.max(sim.vehicle.maxSteerAngle, 1e-3);
  return (_tel: Sim['tel'], t: number) => {
    seen.push([t, rearSlip(sim)]);
    while (seen.length > 1 && seen[1][0] <= t - o.delay) seen.shift();
    if (seen[0][0] > t - o.delay) return { steering: o.before.steering, throttle: o.before.throttle };
    const slip = seen[0][1];
    const steering = Number.isFinite(o.gain)
      ? Math.max(-1, Math.min(1, (o.gain * slip) / lock))
      : Math.abs(slip) > 3 * RAD ? Math.sign(slip) : 0;
    return { steering, throttle: o.throttle };
  };
}

/** Residual weave after a catch: RMS yaw rate (deg/s) over the last 3 s. */
function weave(dt: number, rates: number[]): number {
  const tail = rates.slice(-Math.round(3 / dt));
  let sum = 0;
  for (const r of tail) sum += r * r;
  return Math.sqrt(sum / Math.max(1, tail.length)) * DEG;
}

const CORNERS = {
  hairpin: { R: 12, v: 9, addStick: 0.3 },
  fast: { R: 20, v: 15, addStick: 0.5 },
};

/**
 * The lab's imposed slide (15 m/s, nose `beta0Deg` inside the direction of
 * travel, still rotating into it), driven by the `thumb` controller — or,
 * with gain 0, nobody: stick centred, throttle held at `throttle`.
 */
async function imposedThumbCase(env: LabEnv, id: string, beta0Deg: number, o: { gain: number; delay: number; throttle: number }) {
  return runCase(env, id, FLAT, async (sim) => {
    const v0 = 15;
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    const handsOff = o.gain === 0;
    sim.useFixed({ throttle: handsOff ? o.throttle : 0.3 });
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    let maxX = 0;
    sim.resetTrack();
    const log = (tel: Sim['tel']) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
      maxX = Math.max(maxX, Math.abs(tel.x));
    };
    if (handsOff) await sim.run(6.0, log);
    else await driveWith(sim, 6.0, thumb(sim, { ...o, before: { steering: 0, throttle: 0.3 } }), log);
    const tail = betas.slice(-Math.round(2 / sim.dt));
    return {
      onsetBetaDeg: beta0Deg,
      gain: Number.isFinite(o.gain) ? o.gain : 'bang',
      delay: o.delay,
      throttle: o.throttle,
      ...analyzeRecovery(sim.dt, betas, rates, yaws, 0),
      lateralUsed: maxX,
      weaveYawRateRmsDeg: weave(sim.dt, rates),
      tailBetaMeanDeg: mean(tail) * DEG,
      tailBetaStdDeg: std(tail) * DEG,
      yawTurnedDeg: (yaws[yaws.length - 1] - yaws[0]) * DEG,
      speedEnd: sim.tel.speed,
      rolledOver: sim.track.rolledOver,
    };
  });
}

function relabel(c: CaseResult, id: string, extra: Record<string, MetricValue> = {}): CaseResult {
  c.id = id;
  Object.assign(c.metrics, extra);
  return c;
}

/** Largest delay of an ascending list for which every case up to it passed. */
function budget(rows: Array<{ delay: number; ok: boolean }>): number | null {
  let best: number | null = null;
  for (const r of rows) {
    if (!r.ok) break;
    best = r.delay;
  }
  return best;
}

const huReaction: ManeuverDef = {
  name: 'huReaction',
  title: 'hu. reaction-time budget: imposed 35 / 50 deg slides and power slides, driver reacting 0.25 - 1.5 s late',
  async run(env) {
    const report = new Report();
    // A. Imposed slide (the lab's own slideRecovery case, only the delay changes).
    for (const beta of [35, 50]) {
      const rows: Array<{ delay: number; ok: boolean }> = [];
      for (const delay of DELAYS) {
        const c = relabel(
          await slideRecoveryCase(envWith(env, { driver: { reactionDelay: delay } }), beta, 'driver'),
          `imposed.b${beta}.d${Math.round(delay * 1000)}`,
          { delay },
        );
        report.cases.push(c);
        const m = c.metrics;
        rows.push({ delay, ok: m.recovered === true && (m.overshoots as number) <= 1 });
        report.summary[`${c.id}.time`] = m.recoveryTime;
        report.summary[`${c.id}.headingAtCatchDeg`] = m.headingAtRecoveryDeg;
        report.summary[`${c.id}.lateralUsed`] = m.lateralUsed;
      }
      report.summary[`imposed.b${beta}.budget`] = budget(rows);
      report.check(`huReaction.imposed.b${beta}.d400`, rows[1].ok, '0.4 s driver still catches it (no spin, <= 1 overshoot)', rows[1].ok);
      report.check(`huReaction.imposed.b${beta}.d600`, rows[2].ok, '0.6 s driver still catches it (no spin, <= 1 overshoot)', rows[2].ok);
    }
    // B. Power slides: foot down and lock held until the driver reacts.
    for (const corner of ['hairpin', 'fast'] as const) {
      for (const onset of [12, 35]) {
        const rows: Array<{ delay: number; ok: boolean }> = [];
        for (const delay of [...DELAYS, Infinity]) {
          const name = `power.${corner}.o${onset}.${Number.isFinite(delay) ? `d${Math.round(delay * 1000)}` : 'never'}`;
          const c = await powerSlideCase(env, name, { ...CORNERS[corner], onsetDeg: onset, delay });
          report.cases.push(c);
          const m = c.metrics;
          if (Number.isFinite(delay)) rows.push({ delay, ok: m.slid === true && m.recovered === true && (m.overshoots as number) <= 1 });
          report.summary[`${name}.time`] = m.recoveryTime ?? null;
          report.summary[`${name}.spun`] = m.spun ?? null;
          report.summary[`${name}.peakBetaDeg`] = m.peakBetaDeg ?? m.peakOversteerDeg ?? null;
          report.summary[`${name}.overshoots`] = m.overshoots ?? null;
          report.summary[`${name}.counterSwingDeg`] = m.counterSwingDeg ?? null;
        }
        const slid = report.cases[report.cases.length - 1].metrics.slid === true;
        report.summary[`power.${corner}.o${onset}.slid`] = slid;
        report.summary[`power.${corner}.o${onset}.budget`] = slid ? budget(rows) : null;
        if (slid) {
          report.check(`huReaction.power.${corner}.o${onset}.d400`, rows[1].ok, '0.4 s driver still catches it (no spin, <= 1 overshoot)', rows[1].ok);
          report.check(`huReaction.power.${corner}.o${onset}.d600`, rows[2].ok, '0.6 s driver still catches it (no spin, <= 1 overshoot)', rows[2].ok);
        }
      }
    }
    // C. Nobody reacts at all: stick centred, throttle simply held. Does a
    // slide end by itself when the player keeps the trigger down?
    const variants: Array<[string, LabEnv]> = [['', env]];
    if (env.model === 'assist') variants.push(['.noDamper', envWith(env, { tune: { slideDamp: 0 } })]);
    for (const [tag, e] of variants) {
      for (const beta of [20, 35, 50]) {
        for (const throttle of [0, 0.3, 0.6, 1]) {
          const c = await imposedThumbCase(e, `handsOff${tag}.b${beta}.t${Math.round(throttle * 100)}`, beta, { gain: 0, delay: 0, throttle });
          report.cases.push(c);
          report.summary[`${c.id}.time`] = c.metrics.recoveryTime;
          report.summary[`${c.id}.yawTurnedDeg`] = c.metrics.yawTurnedDeg;
          if (tag === '') {
            report.check(`huReaction.${c.id}`, c.metrics.recoveryTime ?? `still sliding (${Math.round(c.metrics.tailBetaMeanDeg as number)} deg, turned ${Math.round(c.metrics.yawTurnedDeg as number)} deg)`, 'stick centred: straight within 2.5 s whatever the throttle', c.metrics.recovered === true && (c.metrics.recoveryTime as number) < 2.5);
          }
        }
      }
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------

const huOvercorrect: ManeuverDef = {
  name: 'huOvercorrect',
  title: 'hu. over-correction: 2x / 3x countersteer gain, no yaw damping, bang-bang thumb',
  async run(env) {
    const report = new Report();
    const judge = (c: CaseResult) => {
      const m = c.metrics;
      report.summary[`${c.id}.time`] = m.recoveryTime ?? null;
      report.summary[`${c.id}.overshoots`] = m.overshoots ?? null;
      report.summary[`${c.id}.counterSwingDeg`] = m.counterSwingDeg ?? null;
      report.summary[`${c.id}.spun`] = m.spun ?? null;
      report.summary[`${c.id}.weaveYawRateRmsDeg`] = m.weaveYawRateRmsDeg ?? null;
    };
    // A. Imposed 35° slide, proportional driver with wrong gains.
    // (The lab driver steers toward the BODY slip, which contains the
    // kinematic term of any turn: at 2x gain it settles into a slow steady
    // turn on every model — see section B for the clean measurement.)
    for (const delay of [0.25]) {
      for (const gain of [1.2, 2.4]) {
        for (const damp of ['damped', 'undamped'] as const) {
          const driver: Partial<DriverParams> = { reactionDelay: delay, counterGain: gain };
          if (damp === 'undamped') driver.yawDamp = 0;
          const c = relabel(
            await slideRecoveryCase(envWith(env, { driver }), 35, 'driver'),
            `imposed.g${Math.round(gain * 10)}.${damp}.d${Math.round(delay * 1000)}`,
            { delay, counterGain: gain, damp },
          );
          report.cases.push(c);
          judge(c);
        }
      }
    }
    // B. Imposed 35° slide, the thumb (rear-slip countersteer, no damping):
    // textbook gain, 2x, 3x and bang-bang; lifting, holding 30 %, flooring.
    for (const delay of [0.25, 0.4]) {
      for (const gain of [1, 2, 3, Infinity]) {
        for (const throttle of [0.1, 1]) {
          const name = `thumb.imposed.${Number.isFinite(gain) ? `g${gain}` : 'bang'}.t${Math.round(throttle * 100)}.d${Math.round(delay * 1000)}`;
          const c = await imposedThumbCase(env, name, 35, { gain, delay, throttle });
          report.cases.push(c);
          judge(c);
        }
      }
    }
    // C. Power slide (hairpin and fast corner), same thumb.
    for (const corner of ['hairpin', 'fast'] as const) {
      const lab = await powerSlideCase(env, `power.${corner}.labDriver`, { ...CORNERS[corner], onsetDeg: 12, delay: 0.25 });
      report.cases.push(lab);
      judge(lab);
      for (const gain of [1, 2, 3, Infinity]) {
        for (const throttle of [0.1, 1]) {
          const name = `thumb.power.${corner}.${Number.isFinite(gain) ? `g${gain}` : 'bang'}.t${Math.round(throttle * 100)}`;
          const c = await powerSlideCase(env, name, { ...CORNERS[corner], onsetDeg: 12, delay: 0.25, thumb: { gain, throttle } });
          report.cases.push(c);
          judge(c);
        }
      }
    }
    const get = (id: string) => report.cases.find((c) => c.id === id)!.metrics;
    const tame = (id: string) => {
      const m = get(id);
      return m.recovered === true && m.spun === false && (m.overshoots as number) <= 1 && (m.counterSwingDeg as number) < 20;
    };
    const noSpin = (id: string) => get(id).spun === false && get(id).rolledOver === false;
    const val = (id: string) => `${get(id).recoveryTime ?? 'not calm'} s, ${get(id).overshoots} overshoot(s), swing ${Math.round(get(id).counterSwingDeg as number)} deg`;
    for (const g of ['g1', 'g2', 'g3', 'bang']) {
      report.check(`huOvercorrect.imposed.${g}.lift`, val(`thumb.imposed.${g}.t10.d250`), 'thumb, lifting: recovers, <= 1 overshoot, swing < 20 deg', tame(`thumb.imposed.${g}.t10.d250`));
      report.check(`huOvercorrect.imposed.${g}.lift.d400`, val(`thumb.imposed.${g}.t10.d400`), 'thumb 0.4 s, lifting: recovers, <= 1 overshoot, swing < 20 deg', tame(`thumb.imposed.${g}.t10.d400`));
      report.check(`huOvercorrect.imposed.${g}.floored`, val(`thumb.imposed.${g}.t100.d250`), 'thumb, foot down: no spin', noSpin(`thumb.imposed.${g}.t100.d250`));
      for (const corner of ['hairpin', 'fast']) {
        report.check(`huOvercorrect.power.${corner}.${g}.lift`, val(`thumb.power.${corner}.${g}.t10`), 'power slide, thumb, lifting: recovers, <= 1 overshoot, swing < 20 deg', tame(`thumb.power.${corner}.${g}.t10`));
        report.check(`huOvercorrect.power.${corner}.${g}.floored`, val(`thumb.power.${corner}.${g}.t100`), 'power slide, thumb, foot down: no spin', noSpin(`thumb.power.${corner}.${g}.t100`));
      }
    }
    return report.output();
  },
};

// ---------------------------------------------------------------------------

const DRIFT_ENTRIES = [12, 18];
/** The lab's 'throttle-led' drift style (sliding.ts) — the one combination
 * that holds the drift at the lab's 0.2 s reaction time. */
const THROTTLE_LED: Partial<DriverParams> = {
  driftSteerGain: 0.8, driftSteerBias: 6 * RAD, driftYawDamp: 0.5, driftThrottle: 0.7, driftThrottleGain: 2.5, driftThrottleRate: 0.35,
};
const DRIFT_CENTRIPETAL = 0.65;

function placeMidDrift(sim: Sim, v0: number): void {
  const target = 25 * RAD;
  sim.place({ x: 0, z: 0, yaw: target, speed: v0, beta: -target, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
}

/** Driver steers (drift law, 0.2 s delay); the throttle is a FIXED value. */
async function fixedThrottleCase(env: LabEnv, v0: number, throttle: number, tag = '') {
  return runCase(env, `fixedThrottle${tag}.v${v0}.t${Math.round(throttle * 100)}`, FLAT, async (sim) => {
    placeMidDrift(sim, v0);
    const driver = sim.makeDriver({
      reactionDelay: 0.2,
      driftThrottle: throttle,
      driftThrottleGain: 0,
      driftThrottleKi: 0,
      driftThrottleRate: 0,
    });
    driver.driftHold(-25 * RAD);
    sim.useSettledDriver(driver);
    sim.resetTrack();
    const betas: number[] = [];
    const speeds: number[] = [];
    const pedal: number[] = [];
    let straightRun = 0;
    let straightened = false;
    let tLost: number | null = null;
    const t0 = sim.time;
    await sim.run(6.0, (tel) => {
      if (tel.t - t0 >= 1.0) {
        betas.push(-tel.beta * DEG);
        speeds.push(tel.speed);
        pedal.push(tel.throttle);
      }
      straightRun = Math.abs(tel.beta) < 8 * RAD ? straightRun + sim.dt : 0;
      if (straightRun >= 1.0) straightened = true;
      if (tLost === null && (straightened || sim.track.spun || tel.speed < 4)) tLost = tel.t - t0;
    });
    const m = mean(betas);
    const s = std(betas);
    const sustained = !sim.track.spun && !straightened && Math.min(...speeds) >= 4;
    return {
      entrySpeed: v0,
      throttle,
      // The drift law still cuts the pedal when the speed runs away / the
      // angle is far too deep; this is what the foot really did.
      pedalMean: mean(pedal),
      betaMeanDeg: m,
      betaStdDeg: s,
      speedKept: mean(speeds) / v0,
      spun: sim.track.spun,
      straightened,
      sustained,
      lostAt: tLost,
      isDrift: sustained && m > 15 && m < 45 && s < 8,
    };
  });
}

async function openLoopCase(env: LabEnv, v0: number, throttle: number, counter: number, tag = '') {
  return runCase(env, `open${tag}.v${v0}.t${Math.round(throttle * 100)}.c${Math.round(counter * 100)}`, FLAT, async (sim) => {
    placeMidDrift(sim, v0);
    sim.useFixed({ throttle, steering: -counter });
    let exit = 'held 5 s';
    const t0 = sim.time;
    const betas: number[] = [];
    await sim.run(5.0, (tel) => {
      const slide = -tel.beta;
      betas.push(slide * DEG);
      if (tel.speed < 4) exit = 'stopped';
      else if (slide < 10 * RAD) exit = 'straightened';
      else if (slide > 50 * RAD) exit = 'spun out';
      else return false;
      return true;
    });
    const tail = betas.slice(-Math.round(1 / sim.dt));
    return { entrySpeed: v0, throttle, countersteer: counter, windowTime: sim.time - t0, exit, betaTailDeg: mean(tail), speedEnd: sim.tel.speed };
  });
}

/** 3 s of closed-loop drift, then the player leaves it in one of four ways. */
type ExitMode = 'release' | 'liftKeepSteer' | 'liftOppositeLock' | 'recoverDriver' | 'floorStraight' | 'flip';
async function driftExitCase(env: LabEnv, mode: ExitMode) {
  return runCase(env, `exit.${mode}`, FLAT, async (sim) => {
    placeMidDrift(sim, 18);
    const driver = sim.makeDriver({ reactionDelay: 0.2, ...THROTTLE_LED });
    driver.driftHold(-25 * RAD);
    sim.useSettledDriver(driver);
    const held: number[] = [];
    await sim.run(3.0, (tel) => {
      if (tel.t > 2) held.push(-tel.beta * DEG);
    });
    const betaBefore = mean(held);
    const stick = sim.intent.steering;
    const course0 = sim.tel.yaw + sim.tel.beta;
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    const log = (tel: Sim['tel']) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    };
    sim.resetTrack();
    let extra: Record<string, MetricValue> = {};
    if (mode === 'flip') {
      // Change of direction: ask for the mirror-image drift.
      const other = sim.makeDriver({ reactionDelay: 0.2, ...THROTTLE_LED });
      other.driftHold(25 * RAD);
      sim.useDriver(other);
      let tOther: number | null = null;
      const t0 = sim.time;
      const tail: number[] = [];
      await sim.run(5.0, (tel) => {
        log(tel);
        if (tOther === null && tel.beta >= 15 * RAD) tOther = tel.t - t0;
        if (tel.t - t0 >= 3) tail.push(tel.beta * DEG);
      });
      extra = { flipTimeTo15Deg: tOther, flipHeldBetaDeg: mean(tail), flipHeldStdDeg: std(tail), flipPeakBetaDeg: sim.track.maxAbsBeta * DEG };
    } else if (mode === 'recoverDriver') {
      const rec = sim.useDriver(sim.makeDriver({ reactionDelay: 0.25 }));
      rec.recover(null, null);
      await sim.run(5.0, log);
    } else {
      const keys = mode === 'release'
        ? { t: 0, steering: 0, throttle: 0, brake: 0 }
        : mode === 'liftKeepSteer'
          ? { t: 0, steering: stick, throttle: 0, brake: 0 }
          : mode === 'liftOppositeLock'
            ? { t: 0, steering: -1, throttle: 0, brake: 0 }
            : { t: 0, steering: 0, throttle: 1, brake: 0 };
      sim.useScript([keys]);
      await sim.run(5.0, log);
    }
    return {
      mode,
      betaBeforeDeg: betaBefore,
      stickBefore: stick,
      ...analyzeRecovery(sim.dt, betas, rates, yaws, course0),
      ...extra,
      spunAfter: sim.track.spun,
      speedEnd: sim.tel.speed,
    };
  });
}

const huDriftWindow: ManeuverDef = {
  name: 'huDriftWindow',
  title: 'hu. drift: holdable at 0.1 - 0.5 s reaction, throttle window, open-loop map (with / without the slide damper), exits',
  async run(env) {
    const report = new Report();
    // A. The lab's closed-loop sustain, ALL six combinations, vs reaction delay.
    for (const delay of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      const out = await driftSustain.run(envWith(env, { driver: { reactionDelay: delay } }));
      const sustain = out.cases.filter((c) => !c.id.startsWith('window.'));
      let good = 0;
      for (const c of sustain) {
        const m = c.metrics;
        const ok = m.sustained === true && Math.abs((m.betaMeanDeg as number) - 25) < 8 && (m.betaStdDeg as number) < 8 && (m.speedKept as number) > 0.6;
        if (ok) good++;
        delete c.series;
        report.cases.push(relabel(c, `sustain.d${Math.round(delay * 1000)}.${c.id}`, { delay, meetsBand: ok }));
      }
      report.summary[`sustain.d${Math.round(delay * 1000)}.combosInBand`] = good;
      report.summary[`sustain.d${Math.round(delay * 1000)}.best`] = `${out.summary.bestCase}: ${(out.summary.betaMeanDeg as number).toFixed(1)} +- ${(out.summary.betaStdDeg as number).toFixed(1)} deg, sustained ${out.summary.sustained}`;
      if (delay >= 0.2 && delay <= 0.4) {
        report.check(`huDriftWindow.sustain.d${Math.round(delay * 1000)}`, good, `>= 3 of 6 driver/entry combinations hold 25 +- 8 deg for 5 s at ${delay} s reaction`, good >= 3);
      }
    }
    // B. Throttle window: the driver only steers, the foot is fixed.
    const throttles = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const [tag, e] of [['', env], ['.noDamper', envWith(env, { tune: { slideDamp: 0 } })]] as const) {
      // The damper A/B only makes sense on a model that has the knob.
      if (tag !== '' && env.model !== 'assist') continue;
      for (const v0 of DRIFT_ENTRIES) {
        const held: number[] = [];
        for (const throttle of throttles) {
          const c = await fixedThrottleCase(e, v0, throttle, tag);
          delete c.series;
          report.cases.push(c);
          if (c.metrics.isDrift === true) held.push(throttle);
        }
        report.summary[`throttleWindow${tag}.v${v0}.count`] = held.length;
        report.summary[`throttleWindow${tag}.v${v0}.values`] = held.join(' ');
        if (tag === '') {
          report.check(`huDriftWindow.throttleWindow.v${v0}`, held.join(' ') || 'none', 'a fixed throttle holds the drift (driver steering) over >= 0.3 of pedal travel', held.length >= 4);
        }
      }
    }
    // C. Open-loop map: fixed throttle x fixed countersteer.
    const counters = [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1.0];
    for (const [tag, e] of [['', env], ['.noDamper', envWith(env, { tune: { slideDamp: 0 } })]] as const) {
      if (tag !== '' && env.model !== 'assist') continue;
      for (const v0 of DRIFT_ENTRIES) {
        let cells = 0;
        let heldCells = 0;
        let over2 = 0;
        let spins = 0;
        let straight = 0;
        let sum = 0;
        for (const throttle of throttles.slice(1)) {
          for (const counter of counters) {
            const c = await openLoopCase(e, v0, throttle, counter, tag);
            delete c.series;
            report.cases.push(c);
            cells++;
            sum += c.metrics.windowTime as number;
            if (c.metrics.exit === 'held 5 s') heldCells++;
            if ((c.metrics.windowTime as number) >= 2) over2++;
            if (c.metrics.exit === 'spun out') spins++;
            if (c.metrics.exit === 'straightened') straight++;
          }
        }
        report.summary[`openLoop${tag}.v${v0}.cells`] = cells;
        report.summary[`openLoop${tag}.v${v0}.held5s`] = heldCells;
        report.summary[`openLoop${tag}.v${v0}.over2s`] = over2;
        report.summary[`openLoop${tag}.v${v0}.spunOut`] = spins;
        report.summary[`openLoop${tag}.v${v0}.straightened`] = straight;
        report.summary[`openLoop${tag}.v${v0}.meanWindow`] = sum / cells;
        // Is the throttle an ANGLE knob? Held slide angle vs throttle, stick centred.
        report.summary[`openLoop${tag}.v${v0}.angleVsThrottleStickCentred`] = report.cases
          .filter((c) => c.id.startsWith(`open${tag}.v${v0}.`) && c.id.endsWith('.c0') && c.metrics.exit === 'held 5 s')
          .map((c) => `${c.metrics.throttle}:${Math.round(c.metrics.betaTailDeg as number)}`)
          .join(' ');
      }
    }
    // D. Leaving the drift.
    for (const mode of ['release', 'liftKeepSteer', 'liftOppositeLock', 'recoverDriver', 'floorStraight', 'flip'] as const) {
      const c = await driftExitCase(env, mode);
      report.cases.push(c);
      const m = c.metrics;
      report.summary[`exit.${mode}.time`] = m.recoveryTime;
      report.summary[`exit.${mode}.counterSwingDeg`] = m.counterSwingDeg;
      report.summary[`exit.${mode}.spun`] = m.spunAfter;
      report.summary[`exit.${mode}.betaBeforeDeg`] = m.betaBeforeDeg;
      if (mode === 'flip') {
        report.summary['exit.flip.timeTo15Deg'] = m.flipTimeTo15Deg;
        report.summary['exit.flip.heldBetaDeg'] = m.flipHeldBetaDeg;
        report.check('huDriftWindow.flip', m.flipTimeTo15Deg, 'direction change: mirror drift reached < 2.5 s, no spin', m.flipTimeTo15Deg !== null && (m.flipTimeTo15Deg as number) < 2.5 && m.spunAfter === false);
      } else if (mode !== 'floorStraight' && mode !== 'liftOppositeLock') {
        report.check(`huDriftWindow.exit.${mode}`, m.recoveryTime, 'straight < 2 s, counter-swing < 15 deg, no spin', m.recovered === true && (m.recoveryTime as number) < 2 && (m.counterSwingDeg as number) < 15);
      }
    }
    return report.output();
  },
};

export const HUMAN_MANEUVERS: ManeuverDef[] = [huReaction, huOvercorrect, huDriftWindow];
