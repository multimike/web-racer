/**
 * BREAK TESTS, part 2 — the "human" criteria, in numbers.
 *
 *   xhReaction     how long may a driver take before a slide is lost?
 *                  (imposed slides with the inputs FROZEN for the reaction
 *                  time — stick still in the turn, foot still down — and the
 *                  hairpin power slide, reaction 0.25 … 2 s)
 *   xhOvercorrect  what does a clumsy catch cost? (2x / 3x the ideal
 *                  countersteer, bang-bang full opposite lock, opposite lock
 *                  held too long, panic brake)
 *   xhDrift        is a drift holdable for 5 / 10 s, by how slow a driver,
 *                  and how wide is the throttle window that holds it?
 */
import { ActuationLimiter } from '../../../car/DriverModel';
import type { DriverParams } from '../../../car/DriverModel';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { circlePath } from '../paths';
import { FLAT, Report, mean, runCase, std } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { judgeRecovery } from './kit';

type Metrics = Record<string, MetricValue>;

const DELAYS = [0.25, 0.4, 0.6, 0.8, 1.0, 1.5];

// ---------------------------------------------------------------------------
// xhReaction

/**
 * Imposed slide (as the standard slideRecovery: nose `beta0` inside the
 * direction of travel of a right-hand slide, still rotating in), but until
 * the driver reacts the controls stay where a player caught out would have
 * them: `stick` (1 = still steering INTO the corner) and `throttle`.
 */
async function frozenSlideCase(env: LabEnv, v0: number, beta0Deg: number, stick: number, throttle: number, delay: number) {
  const id = `v${v0}.b${beta0Deg}.stick${Math.round(stick * 100)}.thr${Math.round(throttle * 100)}.d${Math.round(delay * 100)}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    sim.useFixed({ throttle, steering: stick });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: delay }));
    driver.recover(0, null);
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    let maxX = 0;
    let betaAtReaction = 0;
    await sim.run(7, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
      maxX = Math.max(maxX, Math.abs(tel.x));
      if (Math.abs(tel.t - delay) < sim.dt / 2) betaAtReaction = -tel.beta * DEG;
    });
    return {
      speed: v0,
      onsetBetaDeg: beta0Deg,
      stickHeld: stick,
      throttleHeld: throttle,
      reactionDelay: delay,
      betaWhenDriverActsDeg: betaAtReaction,
      ...judgeRecovery(sim.dt, betas, rates, yaws, 0, -1),
      lateralUsed: maxX,
      speedEnd: sim.tel.speed,
      rolledOver: sim.track.rolledOver,
    };
  });
}

/** The hairpin power slide of the standard suite with a variable reaction. */
async function powerSlideCase(env: LabEnv, v: number, R: number, delay: number, onsetDeg: number) {
  return runCase(env, `power.v${v}.R${R}.d${Math.round(delay * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
    const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
    cruise.followPath(circlePath(R, 1), v);
    await sim.run(2.5);
    sim.useScript([{ t: 0, steering: Math.min(1, sim.intent.steering + 0.3), throttle: 1, brake: 0 }]);
    const t0 = sim.time;
    const slid = await sim.run(3.0, (tel) => tel.speed > 5 && -tel.beta >= onsetDeg * RAD);
    if (!slid) return { slid: false, peakBetaNoSlideDeg: sim.track.maxAbsBeta * DEG };
    const timeToSlide = sim.time - t0;
    const course0 = sim.tel.yaw + sim.tel.beta;
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: delay }));
    driver.recover(null, null);
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    const tA = sim.time;
    let betaAtReaction = 0;
    await sim.run(6.0, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
      if (Math.abs(tel.t - tA - delay) < sim.dt / 2) betaAtReaction = -tel.beta * DEG;
    });
    return {
      slid: true,
      timeToSlide,
      reactionDelay: delay,
      betaWhenDriverActsDeg: betaAtReaction,
      ...judgeRecovery(sim.dt, betas, rates, yaws, course0, -1),
      speedEnd: sim.tel.speed,
    };
  });
}

/** Largest delay in `rows` (ascending) up to which every case recovered cleanly. */
function budget(rows: Array<{ delay: number; m: Metrics }>, ok: (m: Metrics) => boolean): number {
  let best = 0;
  for (const r of rows) {
    if (!ok(r.m)) break;
    best = r.delay;
  }
  return best;
}

const xhReaction: ManeuverDef = {
  name: 'xhReaction',
  title: 'xh: reaction-time budget — slides with the controls frozen for 0.25 … 1.5 s, hairpin power slide',
  async run(env) {
    const report = new Report();
    const clean = (m: Metrics) => m.recovered === true && (m.overshoots as number) <= 1 && (m.peakBetaDeg as number) < 80;
    const caught = (m: Metrics) => m.recovered === true;
    // A: standard slide, controls neutral-ish (throttle 0.3, stick centred) — baseline.
    // B: stick still INTO the corner, part throttle.   C: stick in + foot flat.
    const scenarios: Array<{ name: string; v: number; beta: number; stick: number; thr: number }> = [
      { name: 'neutral.v15.b35', v: 15, beta: 35, stick: 0, thr: 0.3 },
      { name: 'stickIn.v15.b35', v: 15, beta: 35, stick: 1, thr: 0.3 },
      { name: 'stickIn.floored.v15.b35', v: 15, beta: 35, stick: 1, thr: 1 },
      { name: 'stickIn.floored.v15.b20', v: 15, beta: 20, stick: 1, thr: 1 },
      { name: 'stickIn.floored.v22.b35', v: 22, beta: 35, stick: 1, thr: 1 },
      { name: 'stickIn.floored.v9.b35', v: 9, beta: 35, stick: 1, thr: 1 },
      { name: 'stickIn.lift.v22.b35', v: 22, beta: 35, stick: 1, thr: 0 },
      { name: 'neutral.floored.v15.b50', v: 15, beta: 50, stick: 0, thr: 1 },
    ];
    for (const sc of scenarios) {
      const rows: Array<{ delay: number; m: Metrics }> = [];
      for (const delay of DELAYS) {
        const c = await frozenSlideCase(env, sc.v, sc.beta, sc.stick, sc.thr, delay);
        delete c.series;
        report.cases.push(c);
        rows.push({ delay, m: c.metrics });
      }
      const line = rows.map((r) => `${r.delay}s:${r.m.spun ? 'SPIN' : r.m.recovered ? `${(r.m.recoveryTime as number).toFixed(2)}s` : 'never'}/pk${Math.round(r.m.peakBetaDeg as number)}/os${r.m.overshoots}`).join('  ');
      report.summary[`${sc.name}`] = line;
      report.summary[`${sc.name}.budgetClean`] = budget(rows, clean);
      report.summary[`${sc.name}.budgetCaught`] = budget(rows, caught);
    }
    for (const [v, R] of [[9, 12], [12, 20]] as const) {
      const rows: Array<{ delay: number; m: Metrics }> = [];
      for (const delay of [...DELAYS, 2.0]) {
        const c = await powerSlideCase(env, v, R, delay, 12);
        delete c.series;
        report.cases.push(c);
        if (c.metrics.slid) rows.push({ delay, m: c.metrics });
      }
      const name = `power.v${v}.R${R}`;
      report.summary[name] = rows.length
        ? rows.map((r) => `${r.delay}s:${r.m.spun ? 'SPIN' : r.m.recovered ? `${(r.m.recoveryTime as number).toFixed(2)}s` : 'never'}/pk${Math.round(r.m.peakBetaDeg as number)}/os${r.m.overshoots}`).join('  ')
        : 'never slides';
      report.summary[`${name}.budgetClean`] = rows.length ? budget(rows, clean) : null;
    }
    const s = report.summary;
    const b = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : 0);
    report.check('xhReaction.neutral', b('neutral.v15.b35.budgetClean'), '35 deg slide, controls neutral: clean catch with reactions up to >= 0.6 s', b('neutral.v15.b35.budgetClean') >= 0.6);
    report.check('xhReaction.stickIn', b('stickIn.v15.b35.budgetClean'), '... stick still held into the corner for the reaction time: >= 0.6 s', b('stickIn.v15.b35.budgetClean') >= 0.6);
    report.check('xhReaction.floored', b('stickIn.floored.v15.b35.budgetClean'), '... stick in AND foot flat for the reaction time: >= 0.4 s', b('stickIn.floored.v15.b35.budgetClean') >= 0.4);
    report.check('xhReaction.floored22', b('stickIn.floored.v22.b35.budgetClean'), '... same at 22 m/s: >= 0.4 s', b('stickIn.floored.v22.b35.budgetClean') >= 0.4);
    report.check('xhReaction.power', s['power.v9.R12.budgetClean'] ?? null, 'hairpin power slide: clean catch with reactions up to >= 0.6 s', typeof s['power.v9.R12.budgetClean'] !== 'number' || (s['power.v9.R12.budgetClean'] as number) >= 0.6);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xhOvercorrect

/** A clumsy human: full opposite lock while the tail is out, with a reaction
 * delay and thumb travel time; `holdOver` keeps the lock on that long after
 * the slip angle has come back through zero. */
async function bangBangCase(env: LabEnv, v0: number, beta0Deg: number, delay: number, holdOver: number, pedal: 'lift' | 'brake' | 'floor') {
  const id = `bang.v${v0}.b${beta0Deg}.d${Math.round(delay * 100)}.hold${Math.round(holdOver * 100)}.${pedal}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    const hands = new ActuationLimiter(0.12, 0.1);
    hands.set({ throttle: 0.3, steering: 0, brake: 0 });
    const queue: Array<{ t: number; s: number }> = [];
    let lastSign = 0;
    let lastSeen = -99;
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    sim.resetTrack();
    let flips = 0;
    let prevActed = 0;
    let lateBeta = 0;
    let rateSq = 0;
    let rateN = 0;
    let speedAt3 = 0;
    while (sim.time < 7) {
      const tel = sim.tel;
      // Decision (what the eyes see now): opposite lock toward the slide.
      // "The tail is out" = slip angle of the REAR axle (the body slip angle
      // at the CoM is ~11 deg in any tight low-speed turn, sliding or not).
      const rearSlip = tel.speed > 2 ? Math.atan2(tel.vLat - tel.yawRate * 0.5 * sim.vehicle.wheelbase, Math.max(Math.abs(tel.vFwd), 1)) : 0;
      let want = 0;
      if (Math.abs(rearSlip) > 4 * RAD && tel.vFwd > 0) {
        want = Math.sign(rearSlip);
        lastSign = want;
        lastSeen = tel.t;
      } else if (tel.t - lastSeen < holdOver) {
        want = lastSign;
      }
      queue.push({ t: tel.t, s: want });
      while (queue.length > 1 && queue[1].t <= tel.t - delay + 1e-9) queue.shift();
      const acted = queue[0].t <= tel.t - delay + 1e-9 ? queue[0].s : 0;
      const reacting = tel.t >= delay;
      const intent = hands.apply({
        steering: acted,
        throttle: !reacting ? 0.3 : pedal === 'floor' ? 1 : 0,
        brake: reacting && pedal === 'brake' ? 1 : 0,
      }, sim.dt);
      if (acted !== 0 && prevActed !== 0 && acted !== prevActed) flips++;
      if (acted !== 0) prevActed = acted;
      sim.useFixed(intent);
      sim.step();
      if (sim.time > 1.5 && sim.tel.speed > 3) {
        lateBeta = Math.max(lateBeta, Math.abs(sim.tel.beta));
        rateSq += sim.tel.yawRate * sim.tel.yawRate;
        rateN++;
      }
      if (Math.abs(sim.time - 3) < sim.dt / 2) speedAt3 = sim.tel.speed;
      betas.push(sim.tel.beta);
      rates.push(sim.tel.yawRate);
      yaws.push(sim.tel.yaw);
    }
    return {
      style: 'bang-bang',
      reactionDelay: delay,
      holdOver,
      pedal,
      // The weave a bang-bang thumb leaves behind after the catch (t > 1.5 s).
      stickFlips: flips,
      weaveMaxBetaDeg: lateBeta * DEG,
      weaveYawRateRmsDeg: rateN ? Math.sqrt(rateSq / rateN) * DEG : 0,
      speedAt3s: speedAt3,
      ...judgeRecovery(sim.dt, betas, rates, yaws, 0, -1),
      speedEnd: sim.tel.speed,
      rolledOver: sim.track.rolledOver,
    };
  });
}

async function gainCase(env: LabEnv, v0: number, beta0Deg: number, delay: number, gain: number, yawDamp: number) {
  const id = `gain.v${v0}.b${beta0Deg}.d${Math.round(delay * 100)}.g${Math.round(gain * 10)}.yd${Math.round(yawDamp * 100)}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    sim.useFixed({ throttle: 0.3 });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: delay, counterGain: gain, yawDamp }));
    driver.recover(0, null);
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    await sim.run(7, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    });
    return {
      style: 'proportional',
      reactionDelay: delay,
      counterGain: gain,
      yawDamp,
      ...judgeRecovery(sim.dt, betas, rates, yaws, 0, -1),
      speedEnd: sim.tel.speed,
    };
  });
}

const xhOvercorrect: ManeuverDef = {
  name: 'xhOvercorrect',
  title: 'xh: over-correction — 2x / 3x countersteer gain, bang-bang opposite lock, lock held too long, panic pedals',
  async run(env) {
    const report = new Report();
    const fmt = (m: Metrics) => `${m.spun ? 'SPIN' : m.recovered ? `${(m.recoveryTime as number).toFixed(2)}s` : 'never'}/os${m.overshoots}/swing${Math.round(m.counterSwingDeg as number)}`;
    let idealTime = 0;
    let twoXTime: number | null = null;
    let twoXOvershoots = 0;
    let twoXSwing = 0;
    for (const delay of [0.25, 0.4]) {
      for (const gain of [1.2, 2.4, 3.6]) {
        for (const yd of [0.35, 0]) {
          const c = await gainCase(env, 15, 35, delay, gain, yd);
          delete c.series;
          report.cases.push(c);
          const m = c.metrics;
          report.summary[c.id] = fmt(m);
          if (delay === 0.25 && gain === 1.2 && yd === 0.35) idealTime = (m.recoveryTime as number) ?? 99;
          if (delay === 0.25 && gain === 2.4 && yd === 0.35) {
            twoXTime = m.recovered ? (m.recoveryTime as number) : null;
            twoXOvershoots = m.overshoots as number;
            twoXSwing = m.counterSwingDeg as number;
          }
        }
      }
    }
    let bangSpins = 0;
    let bangWorstOvershoots = 0;
    let bangWorstTime = 0;
    let bangCases = 0;
    for (const [v, beta] of [[15, 35], [22, 35], [15, 50]] as const) {
      for (const delay of [0.25, 0.4]) {
        for (const hold of [0, 0.3, 0.6]) {
          for (const pedal of ['lift', 'brake', 'floor'] as const) {
            if (pedal !== 'lift' && (hold !== 0.3 || v !== 15 || beta !== 35)) continue;
            const c = await bangBangCase(env, v, beta, delay, hold, pedal);
            delete c.series;
            report.cases.push(c);
            const m = c.metrics;
            report.summary[c.id] = `${fmt(m)}  weave: ${m.stickFlips} flips, beta <= ${(m.weaveMaxBetaDeg as number).toFixed(1)} deg, yaw rate rms ${(m.weaveYawRateRmsDeg as number).toFixed(0)} deg/s, ${(m.speedAt3s as number).toFixed(1)} m/s at 3 s`;
            if (pedal === 'lift') {
              bangCases++;
              if (m.spun || !m.recovered) bangSpins++;
              bangWorstOvershoots = Math.max(bangWorstOvershoots, m.overshoots as number);
              bangWorstTime = Math.max(bangWorstTime, m.recovered ? (m.recoveryTime as number) : 99);
            }
          }
        }
      }
    }
    report.summary.idealTime = idealTime;
    report.summary.twoXTime = twoXTime;
    report.summary.bangCases = bangCases;
    report.summary.bangLost = bangSpins;
    report.summary.bangWorstOvershoots = bangWorstOvershoots;
    report.summary.bangWorstTime = bangWorstTime;
    report.check('xhOvercorrect.twoX', twoXTime, '2x the ideal countersteer still recovers, < 1 s slower than ideal, <= 1 overshoot, counter-swing < 15 deg', twoXTime !== null && twoXTime - idealTime < 1 && twoXOvershoots <= 1 && twoXSwing < 15);
    report.check('xhOvercorrect.bangBang', `${bangSpins} lost of ${bangCases}, worst ${bangWorstOvershoots} overshoots, ${bangWorstTime.toFixed(2)} s`, 'full opposite lock (bang-bang, lift): never spins, <= 2 overshoots, straight < 3 s', bangSpins === 0 && bangWorstOvershoots <= 2 && bangWorstTime < 3);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xhDrift

const DRIFT_CENTRIPETAL = 0.65;

/** Drift hold with the lab's driver; `fixedThrottle` freezes the foot. */
async function driftCase(env: LabEnv, id: string, v0: number, seconds: number, params: Partial<DriverParams>, fixedThrottle: number | null) {
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const target = 25 * RAD;
    sim.place({ x: 0, z: 0, yaw: target, speed: v0, beta: -target, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
    const driver = sim.makeDriver({ reactionDelay: 0.2, ...params });
    driver.driftHold(-target);
    const obs = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0 };
    const read = () => {
      const tel = sim.tel;
      obs.x = tel.x; obs.z = tel.z; obs.yaw = tel.yaw; obs.vx = tel.vx; obs.vz = tel.vz; obs.yawRate = tel.yawRate;
      return obs;
    };
    driver.settle(read());
    sim.resetTrack();
    const betas: number[] = [];
    const speeds: number[] = [];
    const throttles: number[] = [];
    const sticks: number[] = [];
    let outOfBand: number | null = null;
    let exit = 'held';
    while (sim.time < seconds) {
      const intent = driver.update(read(), sim.dt);
      sim.useFixed({ steering: intent.steering, throttle: fixedThrottle ?? intent.throttle, brake: 0 });
      sim.step();
      const tel = sim.tel;
      const slide = -tel.beta * DEG;
      if (tel.t >= 1) {
        betas.push(slide);
        speeds.push(tel.speed);
        throttles.push(sim.intent.throttle);
        sticks.push(sim.intent.steering);
      }
      if (outOfBand === null) {
        if (tel.speed < 4) exit = 'stopped';
        else if (slide < 10) exit = 'straightened';
        else if (slide > 50) exit = 'spun out';
        if (exit !== 'held') outOfBand = tel.t;
      }
    }
    return {
      entrySpeed: v0,
      seconds,
      fixedThrottle,
      reactionDelay: driver.params.reactionDelay,
      betaMeanDeg: mean(betas),
      betaStdDeg: std(betas),
      betaMinDeg: Math.min(...betas),
      betaMaxDeg: Math.max(...betas),
      speedMean: mean(speeds),
      speedEnd: sim.tel.speed,
      speedKept: mean(speeds) / v0,
      throttleMean: mean(throttles),
      throttleStd: std(throttles),
      throttleMin: Math.min(...throttles),
      throttleMax: Math.max(...throttles),
      stickMean: mean(sticks),
      stickStd: std(sticks),
      timeInBand: outOfBand ?? seconds,
      exit,
      held: outOfBand === null,
      spun: sim.track.spun,
    };
  });
}

/** No driver at all: fixed stick + fixed throttle from the mid-drift state. */
async function openLoopCase(env: LabEnv, v0: number, throttle: number, counter: number) {
  return runCase(env, `open.v${v0}.t${Math.round(throttle * 100)}.c${Math.round(counter * 100)}`, FLAT, async (sim: Sim): Promise<Metrics> => {
    const target = 25 * RAD;
    sim.place({ x: 0, z: 0, yaw: target, speed: v0, beta: -target, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
    sim.useFixed({ throttle, steering: -counter });
    sim.resetTrack();
    let exit = 'held';
    const tail: number[] = [];
    await sim.run(5.0, (tel) => {
      const slide = -tel.beta;
      if (tel.t > 3) tail.push(slide * DEG);
      if (tel.speed < 4) exit = 'stopped';
      else if (slide < 10 * RAD) exit = 'straightened';
      else if (slide > 50 * RAD) exit = 'spun out';
      else return false;
      return true;
    });
    return { entrySpeed: v0, throttle, countersteer: counter, windowTime: sim.time, exit, endBetaDeg: tail.length ? mean(tail) : null, speedEnd: sim.tel.speed };
  });
}

/** Widest contiguous run of `true` in a throttle sweep, as [lo, hi] or null. */
function widest(throttles: number[], held: boolean[]): { lo: number; hi: number; width: number } | null {
  let best: { lo: number; hi: number; width: number } | null = null;
  let start = -1;
  for (let i = 0; i <= held.length; i++) {
    if (i < held.length && held[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const lo = throttles[start];
      const hi = throttles[i - 1];
      // A single held point counts as one grid cell (0.05) wide.
      const width = hi - lo + 0.05;
      if (!best || width > best.width) best = { lo, hi, width };
      start = -1;
    }
  }
  return best;
}

const PRESETS: Array<{ name: string; params: Partial<DriverParams> }> = [
  { name: 'balanced', params: {} },
  { name: 'throttleLed', params: { driftSteerGain: 0.8, driftSteerBias: 6 * RAD, driftYawDamp: 0.5, driftThrottle: 0.7, driftThrottleGain: 2.5, driftThrottleRate: 0.35 } },
  { name: 'steerLed', params: { driftSteerGain: 1.8, driftSteerBias: 2 * RAD, driftYawDamp: 0.3, driftThrottle: 0.45, driftThrottleGain: 1.0, driftThrottleRate: 0.15 } },
];

const xhDrift: ManeuverDef = {
  name: 'xhDrift',
  title: 'xh: drift — held 10 s by 3 driver styles at 0.2 … 0.5 s reaction; throttle window with a steering driver and with a fixed stick',
  async run(env) {
    const report = new Report();
    // 1. Closed loop, pedals and stick by the driver: 3 styles x 2 speeds x 4 reaction times, 10 s.
    let held = 0;
    let total = 0;
    const heldBy: Record<string, number> = {};
    let slowestHeld = 0;
    for (const preset of PRESETS) {
      heldBy[preset.name] = 0;
      for (const v of [12, 18]) {
        for (const delay of [0.2, 0.3, 0.4, 0.5]) {
          const c = await driftCase(env, `hold.${preset.name}.v${v}.d${Math.round(delay * 100)}`, v, 10, { ...preset.params, reactionDelay: delay }, null);
          delete c.series;
          report.cases.push(c);
          const m = c.metrics;
          total++;
          report.summary[c.id] = `${m.exit} (${(m.timeInBand as number).toFixed(1)} s), beta ${(m.betaMeanDeg as number).toFixed(1)} +- ${(m.betaStdDeg as number).toFixed(1)} [${(m.betaMinDeg as number).toFixed(0)}..${(m.betaMaxDeg as number).toFixed(0)}], throttle ${(m.throttleMean as number).toFixed(2)} +- ${(m.throttleStd as number).toFixed(2)} [${(m.throttleMin as number).toFixed(2)}..${(m.throttleMax as number).toFixed(2)}], stick ${(m.stickMean as number).toFixed(2)} +- ${(m.stickStd as number).toFixed(2)}, speed ${(m.speedMean as number).toFixed(1)}`;
          if (m.held) {
            held++;
            heldBy[preset.name]++;
            slowestHeld = Math.max(slowestHeld, delay);
          }
        }
      }
    }
    // 2. Throttle window: the style that works steers, the foot is FROZEN.
    const grid: number[] = [];
    for (let t = 0.2; t <= 1.0001; t += 0.05) grid.push(Math.round(t * 100) / 100);
    const windows: Record<string, { lo: number; hi: number; width: number } | null> = {};
    for (const preset of PRESETS) {
      for (const v of [12, 18]) {
        const ok: boolean[] = [];
        const row: string[] = [];
        for (const thr of grid) {
          const c = await driftCase(env, `steerOnly.${preset.name}.v${v}.t${Math.round(thr * 100)}`, v, 5, preset.params, thr);
          delete c.series;
          report.cases.push(c);
          const m = c.metrics;
          ok.push(m.held === true);
          row.push(`${thr.toFixed(2)}:${m.held ? `${Math.round(m.betaMeanDeg as number)}` : m.exit === 'spun out' ? 'S' : m.exit === 'straightened' ? '-' : 'x'}`);
        }
        const key = `steerOnly.${preset.name}.v${v}`;
        const w = widest(grid, ok);
        windows[key] = w;
        report.summary[`${key}.map`] = row.join(' ');
        report.summary[`${key}.width`] = w ? w.width : 0;
      }
    }
    // 3. Throttle window with NO driver (fixed stick; negative = INTO the turn).
    for (const v of [12, 18]) {
      for (const counter of [-1, -0.75, -0.5, -0.3, 0, 0.1, 0.2, 0.35, 0.5]) {
        const ok: boolean[] = [];
        const row: string[] = [];
        for (const thr of grid) {
          const c = await openLoopCase(env, v, thr, counter);
          delete c.series;
          report.cases.push(c);
          const m = c.metrics;
          const h = m.exit === 'held';
          ok.push(h);
          row.push(`${thr.toFixed(2)}:${h ? `${Math.round(m.endBetaDeg as number)}` : m.exit === 'spun out' ? 'S' : m.exit === 'straightened' ? `-${(m.windowTime as number).toFixed(1)}` : 'x'}`);
        }
        const key = `open.v${v}.c${Math.round(counter * 100)}`;
        const w = widest(grid, ok);
        windows[key] = w;
        report.summary[`${key}.map`] = row.join(' ');
        report.summary[`${key}.width`] = w ? w.width : 0;
      }
    }
    report.summary.held10s = `${held} of ${total} (balanced ${heldBy.balanced}/8, throttleLed ${heldBy.throttleLed}/8, steerLed ${heldBy.steerLed}/8)`;
    report.summary.slowestDriverHolding = slowestHeld;
    let steerBest = 0;
    let openBest = 0;
    for (const [k, w] of Object.entries(windows)) {
      if (!w) continue;
      if (k.startsWith('open.')) openBest = Math.max(openBest, w.width);
      else steerBest = Math.max(steerBest, w.width);
    }
    report.summary.steerOnlyBestWidth = steerBest;
    report.summary.openLoopBestWidth = openBest;
    report.check('xhDrift.hold10s', `${held} of ${total}`, 'some driver style holds a 10-50 deg slide for 10 s at 12 AND 18 m/s with 0.2 s reactions', PRESETS.some((p) => {
      const id = (v: number) => report.cases.find((c) => c.id === `hold.${p.name}.v${v}.d20`)!.metrics.held === true;
      return id(12) && id(18);
    }));
    report.check('xhDrift.styleRobust', `balanced ${heldBy.balanced}/8, throttleLed ${heldBy.throttleLed}/8, steerLed ${heldBy.steerLed}/8`, 'at least 2 of the 3 driver styles can hold it (not one lucky gain set)', Object.values(heldBy).filter((n) => n > 0).length >= 2);
    report.check('xhDrift.slowDriver', slowestHeld, 'still held by a 0.4 s-reaction driver', slowestHeld >= 0.4);
    report.check('xhDrift.throttleWindow', steerBest, 'driver steers, foot FROZEN: slide held 5 s over a throttle band >= 0.2 wide', steerBest >= 0.2);
    report.check('xhDrift.openLoopWindow', openBest, 'no driver (fixed stick): some stick position holds 5 s over a throttle band >= 0.15 wide', openBest >= 0.15);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// xhSpin — can this car be spun at all, and is the spin recoverable?

async function spinCase(env: LabEnv, v0: number, beta0Deg: number, yawRate: number, pedal: 'floor' | 'lift', stick: number) {
  const id = `spin.v${v0}.b${beta0Deg}.r${Math.round(yawRate * 10)}.${pedal}.s${Math.round(stick * 100)}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate });
    sim.useFixed({ throttle: pedal === 'floor' ? 1 : 0, steering: stick });
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    // 1 s with the controls frozen, then a 0.4 s-reaction driver takes over.
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 1.0 }));
    driver.recover(null, null);
    await sim.run(8, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    });
    const j = judgeRecovery(sim.dt, betas, rates, yaws, 0, -1);
    return {
      speed: v0, onsetBetaDeg: beta0Deg, onsetYawRate: yawRate, pedal, stick,
      ...j,
      totalRotationDeg: (sim.tel.yaw - beta0) * DEG,
      speedEnd: sim.tel.speed,
      rolledOver: sim.track.rolledOver,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
    };
  });
}

const xhSpin: ManeuverDef = {
  name: 'xhSpin',
  title: 'xh: can it be spun? 35-120 deg slides with up to 6 rad/s of rotation, controls frozen 1 s (floored / lifted, stick in / centred)',
  async run(env) {
    const report = new Report();
    let spins = 0;
    let lost = 0;
    let total = 0;
    let rolls = 0;
    const spunList: string[] = [];
    for (const v of [15, 22]) {
      for (const [beta, rate] of [[35, 2], [35, 4], [60, 1], [60, 4], [90, 2], [90, 6], [120, 3]] as const) {
        for (const pedal of ['floor', 'lift'] as const) {
          for (const stick of [1, 0]) {
            const c = await spinCase(env, v, beta, rate, pedal, stick);
            delete c.series;
            report.cases.push(c);
            const m = c.metrics;
            total++;
            if (m.spun) {
              spins++;
              spunList.push(c.id.replace('spin.', ''));
            }
            if (!m.recovered && !m.spun) lost++;
            if (m.rolledOver) rolls++;
          }
        }
      }
    }
    report.summary.cases = total;
    report.summary.spins = spins;
    report.summary.neverCalm = lost;
    report.summary.rollovers = rolls;
    report.summary.spunCases = spunList.join(', ') || 'none';
    report.check('xhSpin.info', `${spins} of ${total} go past 90 deg, ${lost} more never settle, ${rolls} roll over`, 'info: how hard the car is to spin (a car that cannot be spun at all is assist-bound, one that spins from 35 deg is not catchable)', true);
    report.check('xhSpin.noRollover', rolls, 'a spin never becomes a rollover on flat ground', rolls === 0);
    return report.output();
  },
};

export const HUMAN_MANEUVERS: ManeuverDef[] = [xhReaction, xhOvercorrect, xhDrift, xhSpin];
