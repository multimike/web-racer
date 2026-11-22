/**
 * DRIFT-FEEL maneuvers of the standard suite (w - z): the two-sided
 * requirement "drifting shall be possible, but it should still be possible
 * to react and straighten a car that has begun skidding", measured with RAW
 * STICK inputs wherever possible (a fixed or scripted stick and trigger, or a
 * plain proportional thumb) — the lab's DriverModel, which may ask the car
 * for the stick position that gives a wheel angle, is only used where the
 * question is about it. No scorecard weight (totals stay comparable); every
 * check is listed under "failing checks" when it breaks.
 *
 *   w slideCatch   the panic inputs: full opposite lock HELD with the foot
 *                  flat / at 70 % / at 40 % (35 deg slide, also at 30-120 Hz
 *                  and from 22 m/s); lifting out of a held drift
 *   x driftHold    who can hold it: open-loop throttle x stick cells for 10 s
 *                  (quarter stick ... full stick), equilibrium speed and
 *                  radius, "is it sticky" (stick centred below 40 % throttle,
 *                  large opposite lock), raw proportional thumbs with 0.25 -
 *                  0.6 s reactions, a "classic countersteer" thumb, and the
 *                  lab driver's three styles with slow reactions
 *   y powerOver    flooring it in a 0.375 mu*g corner at 12 / 15 / 18 m/s, at
 *                  30-120 Hz, against the car's declared trait
 *                  (handling.ts); donut from rest
 *   z assist       assistLevel 0.5 and 0: is a slide still caught by a
 *                  0.25 s driver and by a raw opposite-lock thumb
 *
 * Everything is a RIGHT-hand situation: `slide` (deg) is positive with the
 * tail out in a right turn, stick + = INTO the turn, - = opposite lock.
 */
import { ActuationLimiter } from '../../../car/DriverModel';
import type { DriverParams } from '../../../car/DriverModel';
import { handlingFor } from '../../../car/handling';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { circlePath } from '../paths';
import { judgeRecovery } from '../extra-raycast/kit';
import { FLAT, Report, fitCircle, mean, runCase, std } from './common';
import type { ManeuverDef } from './common';

type Metrics = Record<string, MetricValue>;

const RATES = [30, 72, 90, 120];
const DRIFT_CENTRIPETAL = 0.65;

/** Slip angle of the rear axle, deg, + = tail out in a right turn. */
function rearSlide(sim: Sim): number {
  const tel = sim.tel;
  if (tel.speed < 1.5) return 0;
  return -Math.atan2(tel.vLat - tel.yawRate * 0.5 * sim.vehicle.wheelbase, Math.max(Math.abs(tel.vFwd), 1)) * DEG;
}

/** The standard mid-drift state: 25 deg, on the arc of a 0.65 mu*g corner. */
function placeMidDrift(sim: Sim, v0: number, slideDeg = 25): void {
  const b = slideDeg * RAD;
  sim.place({ x: 0, z: 0, yaw: b, speed: v0, beta: -b, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
}

// ---------------------------------------------------------------------------
// w. slideCatch

/**
 * Imposed slide (as slideRecovery: nose `beta0` inside the direction of
 * travel, still rotating in), throttle held at `throttle` THROUGHOUT; after
 * the reaction time the thumb goes to full opposite lock and STAYS there.
 * The slide must end and stay ended: the car may then turn the other way
 * (that is what the stick says) but on its tires, not in a slide.
 */
export async function oppositeLockCase(env: LabEnv, v0: number, beta0Deg: number, throttle: number, dt: number = env.dt, tune?: Record<string, number>) {
  const id = `opp.v${v0}.b${beta0Deg}.t${Math.round(throttle * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, v] of Object.entries(tune)) sim.vehicle.setTuning(k, v);
    const beta0 = beta0Deg * RAD;
    const react = 0.25;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    sim.useFixed({ throttle, steering: 0 });
    sim.useScript([{ t: 0, throttle, steering: 0, brake: 0 }, { t: react, steering: -1 }]);
    sim.resetTrack();
    const rear: number[] = [];
    const body: number[] = [];
    let slideAtAction = 0;
    await sim.run(5, (tel) => {
      rear.push(rearSlide(sim));
      body.push(-tel.beta * DEG);
      if (Math.abs(tel.t - react) < sim.dt / 2) slideAtAction = -tel.beta * DEG;
    });
    // Closed = the rear axle slides less than 5 deg on the original side.
    let closed: number | null = null;
    for (let i = 0; i < rear.length; i++) {
      if (rear[i] < 5) {
        closed = (i + 1) * sim.dt;
        break;
      }
    }
    let wrongWay = 0;
    let wrongBody = 0;
    let overshoots = 0;
    let side = 1;
    let stays: number | null = null;
    for (let i = 0; i < rear.length; i++) {
      if (-rear[i] > wrongWay) wrongWay = -rear[i];
      if (-body[i] > wrongBody) wrongBody = -body[i];
      if (rear[i] * side < -5) {
        overshoots++;
        side = -side;
      }
      // "Straight" = from here on no slide either way: less than 5 deg on
      // the original side, less than 10 deg on the far side.
      if (rear[i] < 5 && rear[i] > -10) {
        if (stays === null) stays = (i + 1) * sim.dt;
      } else {
        stays = null;
      }
    }
    const tail = Math.round(1 / sim.dt);
    return {
      speed: v0,
      onsetBetaDeg: beta0Deg,
      throttle,
      slideWhenStickMovesDeg: slideAtAction,
      // Times count from the moment the thumb starts to move.
      closedAfter: closed === null ? null : closed - react,
      straightAfter: stays === null ? null : Math.max(0, stays - react),
      wrongWayRearDeg: wrongWay,
      wrongWayBodyDeg: wrongBody,
      overshoots,
      endRearSlideDeg: mean(rear.slice(-tail)),
      endBodySlideDeg: mean(body.slice(-tail)),
      endYawRateDeg: sim.tel.yawRate * DEG,
      endSpeed: sim.tel.speed,
      spun: sim.track.spun,
    };
  }, dt);
}

function catchOk(m: Metrics): boolean {
  return m.spun === false && typeof m.straightAfter === 'number' && m.straightAfter <= 1.5 &&
    (m.overshoots as number) <= 1 && (m.wrongWayRearDeg as number) < 10;
}

function catchText(m: Metrics): string {
  const t = typeof m.straightAfter === 'number' ? `${m.straightAfter.toFixed(2)} s` : 'never';
  return `${m.spun ? 'SPIN ' : ''}straight ${t}, far side ${(m.wrongWayRearDeg as number).toFixed(1)} deg, ${m.overshoots} overshoot(s), ends ${(m.endRearSlideDeg as number).toFixed(1)} deg`;
}

/**
 * Lift out of a held drift: imposed 25 deg slide, 2 s of stick 75 % into the
 * turn at 80 % throttle (the car settles into its own drift), then the foot
 * comes off (0.1 s pedal travel); the stick either stays where it was or is
 * let go of at the same moment.
 */
async function liftCase(env: LabEnv, v0: number, stickAfter: number, dt: number = env.dt) {
  const id = `lift.v${v0}.${stickAfter === 0 ? 'centre' : 'stickIn'}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    placeMidDrift(sim, v0);
    sim.useFixed({ throttle: 0.8, steering: 0.75 });
    await sim.run(2.0);
    const slide0 = -sim.tel.beta * DEG;
    const speed0 = sim.tel.speed;
    sim.useScript([{ t: 0, throttle: 0, steering: stickAfter, brake: 0 }]);
    const t0 = sim.time;
    let closed: number | null = null;
    let quarter = 0;
    let over = 0;
    let peakRate = 0;
    let prev = slide0;
    await sim.run(2.0, (tel) => {
      const slide = -tel.beta * DEG;
      const t = tel.t - t0;
      if (Math.abs(t - 0.25) < sim.dt / 2) quarter = slide;
      if (closed === null && slide < 5) closed = t;
      // (rear axle: with the stick still in, the car then corners hard on
      // its tires, and the BODY slip angle of that is a few degrees negative)
      if (-rearSlide(sim) > over) over = -rearSlide(sim);
      peakRate = Math.max(peakRate, (prev - slide) / sim.dt);
      prev = slide;
    });
    return {
      entrySpeed: v0,
      slideAtLiftDeg: slide0,
      speedAtLift: speed0,
      slideAfterQuarterSecondDeg: quarter,
      keptAfterQuarterSecond: slide0 > 1 ? quarter / slide0 : null,
      closedAfter: closed,
      overshootDeg: over,
      peakClosingRateDegPerS: peakRate,
      speedEnd: sim.tel.speed,
    };
  }, dt);
}

export const slideCatch: ManeuverDef = {
  name: 'slideCatch',
  title: 'w. panic inputs: full opposite lock HELD at 100 / 70 / 40 % throttle (35 deg slide, 30-120 Hz), lift out of a held drift',
  async run(env) {
    const report = new Report();
    const fails: string[] = [];
    const add = async (v: number, beta: number, thr: number, dt?: number) => {
      const c = await oppositeLockCase(env, v, beta, thr, dt);
      delete c.series;
      report.cases.push(c);
      report.summary[c.id] = catchText(c.metrics);
      if (!catchOk(c.metrics)) fails.push(c.id.replace('opp.', ''));
      return c.metrics;
    };
    for (const thr of [1, 0.7, 0.4]) await add(15, 35, thr);
    await add(22, 35, 1);
    await add(15, 50, 1);
    await add(15, 20, 1);
    await add(9, 35, 1);
    for (const hz of RATES) for (const thr of [1, 0.7, 0.4]) await add(15, 35, thr, 1 / hz);
    report.check('slideCatch.oppositeLockHeld', fails.length ? `${fails.length} of ${report.cases.length}: ${fails.join(', ')}` : `0 of ${report.cases.length} fail`,
      'floored / 70 % / 40 % throttle + full opposite lock held: straight within 1.5 s of the stick moving, at most one overshoot, under 10 deg, no drift the other way (30-120 Hz)', fails.length === 0);

    const lifts: Metrics[] = [];
    const liftFails: string[] = [];
    const liftRun = async (v: number, stick: number, dt?: number) => {
      const c = await liftCase(env, v, stick, dt);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      lifts.push(m);
      report.summary[c.id] = `${(m.slideAtLiftDeg as number).toFixed(1)} deg at ${(m.speedAtLift as number).toFixed(1)} m/s -> ${(m.slideAfterQuarterSecondDeg as number).toFixed(1)} deg after 0.25 s, closed ${m.closedAfter === null ? 'never' : `${(m.closedAfter as number).toFixed(2)} s`}, overshoot ${(m.overshootDeg as number).toFixed(1)} deg, peak ${(m.peakClosingRateDegPerS as number).toFixed(0)} deg/s`;
      // Progressive: scaled to the 25 deg the target was written for.
      const scale = Math.max(0.5, (m.slideAtLiftDeg as number) / 25);
      const ok = typeof m.closedAfter === 'number' && m.closedAfter >= 0.4 * scale && m.closedAfter <= 1.0 * Math.max(1, scale) &&
        (m.keptAfterQuarterSecond as number) >= 0.35 && (m.overshootDeg as number) < 4;
      if (!ok) liftFails.push(c.id.replace('lift.', ''));
    };
    for (const v of [20, 12]) for (const stick of [0, 0.75]) await liftRun(v, stick);
    for (const hz of RATES) await liftRun(20, 0, 1 / hz);
    report.check('slideCatch.liftIsProgressive', liftFails.length ? `${liftFails.length} of ${lifts.length}: ${liftFails.join(', ')}` : `0 of ${lifts.length} fail`,
      'lifting out of a held drift closes it in 0.4-1.0 s (per 25 deg), at least 35 % of the angle is still there after 0.25 s, the rear swings less than 4 deg past straight (30-120 Hz)', liftFails.length === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// x. driftHold

interface CellOut {
  held: boolean;
  slide: number;
  speed: number;
  radius: number;
  closed: number | null;
}

/** Fixed stick + fixed throttle from the mid-drift state, `seconds` long. */
async function cellCase(env: LabEnv, report: Report, v0: number, stick: number, throttle: number, seconds = 10): Promise<CellOut> {
  const id = `cell.v${v0}.s${Math.round(stick * 100)}.t${Math.round(throttle * 100)}`;
  const out: CellOut = { held: false, slide: 0, speed: 0, radius: 0, closed: null };
  const c = await runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    placeMidDrift(sim, v0);
    sim.useFixed({ throttle, steering: stick });
    sim.resetTrack();
    let exit = 'held';
    let exitAt: number | null = null;
    let closed: number | null = null;
    const slides: number[] = [];
    const speeds: number[] = [];
    const rates: number[] = [];
    const cents: number[] = [];
    await sim.run(seconds, (tel) => {
      const slide = -tel.beta * DEG;
      if (closed === null && slide < 5) closed = tel.t;
      if (exitAt === null) {
        if (tel.speed < 4) exit = 'stopped';
        else if (slide < 6) exit = 'straightened';
        else if (slide > 55) exit = 'spun out';
        if (exit !== 'held') exitAt = tel.t;
      }
      if (tel.t > seconds - 3) {
        slides.push(slide);
        speeds.push(tel.speed);
        rates.push(tel.yawRate);
        cents.push(tel.aCent / sim.mug);
      }
    });
    out.held = exit === 'held';
    out.slide = mean(slides);
    out.speed = mean(speeds);
    out.radius = Math.abs(mean(rates)) > 0.02 ? mean(speeds) / Math.abs(mean(rates)) : 999;
    out.closed = closed;
    return {
      entrySpeed: v0, stick, throttle,
      exit, exitAt, closedAt: closed,
      slideMeanDeg: out.slide, slideStdDeg: std(slides),
      speedMean: out.speed, radius: out.radius, centripetalFraction: mean(cents),
      held: out.held, spun: sim.track.spun,
    };
  });
  delete c.series;
  report.cases.push(c);
  return out;
}

/**
 * A plain human thumb, no car knowledge: the stick is `bias` plus `gain` per
 * degree of missing slide angle, clamped to [lo, hi], through a reaction
 * delay and the thumb's travel time; the throttle is fixed.
 */
async function rawThumbCase(
  env: LabEnv, report: Report, name: string, v0: number, delay: number,
  o: { throttle: number; target: number; bias: number; gain: number; lo: number; hi: number; tune?: Record<string, number> },
): Promise<boolean> {
  let held = false;
  const c = await runCase(env, `${name}.v${v0}.d${Math.round(delay * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    if (o.tune) for (const [k, v] of Object.entries(o.tune)) sim.vehicle.setTuning(k, v);
    placeMidDrift(sim, v0);
    const hands = new ActuationLimiter(0.12, 0.1);
    hands.set({ throttle: o.throttle, steering: o.bias, brake: 0 });
    const queue: Array<{ t: number; s: number }> = [];
    const slides: number[] = [];
    const sticks: number[] = [];
    let exit = 'held';
    let exitAt: number | null = null;
    sim.resetTrack();
    while (sim.time < 10) {
      const tel = sim.tel;
      const slide = -tel.beta * DEG;
      const want = Math.max(o.lo, Math.min(o.hi, o.bias + o.gain * (o.target - slide)));
      queue.push({ t: tel.t, s: want });
      while (queue.length > 1 && queue[1].t <= tel.t - delay + 1e-9) queue.shift();
      const acted = queue[0].t <= tel.t - delay + 1e-9 ? queue[0].s : o.bias;
      sim.useFixed(hands.apply({ steering: acted, throttle: o.throttle, brake: 0 }, sim.dt));
      sim.step();
      const now = -sim.tel.beta * DEG;
      if (sim.time >= 1) {
        slides.push(now);
        sticks.push(sim.intent.steering);
      }
      if (exitAt === null) {
        if (sim.tel.speed < 4) exit = 'stopped';
        else if (now < 6) exit = 'straightened';
        else if (now > 55) exit = 'spun out';
        if (exit !== 'held') exitAt = sim.time;
      }
    }
    held = exit === 'held';
    return {
      style: name, entrySpeed: v0, reactionDelay: delay, throttle: o.throttle,
      exit, timeInBand: exitAt ?? 10, held,
      slideMeanDeg: mean(slides), slideStdDeg: std(slides), slideMinDeg: Math.min(...slides), slideMaxDeg: Math.max(...slides),
      stickMean: mean(sticks), stickStd: std(sticks), speedEnd: sim.tel.speed, spun: sim.track.spun,
    };
  });
  delete c.series;
  report.cases.push(c);
  const m = c.metrics;
  report.summary[c.id] = `${m.exit} (${(m.timeInBand as number).toFixed(1)} s), slide ${(m.slideMeanDeg as number).toFixed(1)} +- ${(m.slideStdDeg as number).toFixed(1)}, stick ${(m.stickMean as number).toFixed(2)} +- ${(m.stickStd as number).toFixed(2)}, ${(m.speedEnd as number).toFixed(1)} m/s`;
  return held;
}

const STYLES: Array<{ name: string; params: Partial<DriverParams> }> = [
  { name: 'balanced', params: {} },
  { name: 'throttleLed', params: { driftSteerGain: 0.8, driftSteerBias: 6 * RAD, driftYawDamp: 0.5, driftThrottle: 0.7, driftThrottleGain: 2.5, driftThrottleRate: 0.35 } },
  { name: 'steerLed', params: { driftSteerGain: 1.8, driftSteerBias: 2 * RAD, driftYawDamp: 0.3, driftThrottle: 0.45, driftThrottleGain: 1.0, driftThrottleRate: 0.15 } },
];

/**
 * The lab driver's drift law (DriverModel.driftHold) for 10 s, with the
 * reaction time applied in one of two places:
 *  - 'stick' (what the checks use): the driver decides, the decision becomes a
 *    STICK POSITION at once, and that stick position reaches the car
 *    `delay` seconds later (plus the thumb's travel time). A human's output
 *    is a thumb position; this is the honest reading of "0.4 s reactions".
 *  - 'angle' (as the break test xhDrift, reported for comparison): the wanted
 *    front-WHEEL ANGLE travels through the delay and is turned into a stick
 *    position by hands that know the car's slide-steering map of the current
 *    frame. On this model the stick sets the slide angle, not a wheel angle,
 *    so a stale wheel angle is a wrong stick: a slide that has closed a few
 *    degrees since reads as "countersteer" and gets opposite lock.
 */
async function labDriverCase(env: LabEnv, report: Report, style: (typeof STYLES)[number], v0: number, delay: number, through: 'stick' | 'angle'): Promise<boolean> {
  let held = false;
  const c = await runCase(env, `driver.${through}.${style.name}.v${v0}.d${Math.round(delay * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    const target = 25 * RAD;
    placeMidDrift(sim, v0);
    const slides: number[] = [];
    const throttles: number[] = [];
    const sticks: number[] = [];
    let exit = 'held';
    let exitAt: number | null = null;
    let bodyOut: number | null = null;
    let lateLoss = false;
    const see = () => {
      const tel = sim.tel;
      const slide = -tel.beta * DEG;
      if (tel.t >= 1) {
        slides.push(slide);
        throttles.push(tel.throttle);
        sticks.push(tel.steering);
      }
      // The break test's criterion (BODY slip angle between 10 and 50 deg),
      // kept as a metric ...
      if (bodyOut === null && (slide < 10 || slide > 50)) bodyOut = tel.t;
      // ... but "held" is judged at the REAR AXLE: a drift that has wound
      // itself into a tight donut still has the tail 30 deg out while its
      // body slip angle is under 10 deg by geometry alone.
      const rear = rearSlide(sim);
      if (exitAt === null) {
        if (tel.speed < 4) exit = 'stopped';
        else if (rear < 10) exit = 'straightened';
        else if (rear > 55) exit = 'spun out';
        if (exit !== 'held') exitAt = tel.t;
      }
      // A style may START with a stick that lets the slide dip (the
      // steering-led one begins a little AGAINST the turn at 43 % throttle,
      // which on this car means "end it") and have the drift back a moment
      // later: also recorded is whether the tail stays out from 1.5 s on.
      if (tel.t >= 1.5 && (tel.speed < 4 || rear < 10 || rear > 55)) lateLoss = true;
    };
    if (through === 'angle') {
      const driver = sim.makeDriver({ ...style.params, reactionDelay: delay });
      driver.driftHold(-target);
      sim.useSettledDriver(driver);
      sim.resetTrack();
      await sim.run(10, see);
    } else {
      const driver = sim.makeDriver({ ...style.params, reactionDelay: 0, steerTime: 0, pedalTime: 0 });
      driver.driftHold(-target);
      const obs = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0 };
      const read = () => {
        const tel = sim.tel;
        obs.x = tel.x; obs.z = tel.z; obs.yaw = tel.yaw; obs.vx = tel.vx; obs.vz = tel.vz; obs.yawRate = tel.yawRate;
        return obs;
      };
      driver.settle(read());
      const first = driver.update(read(), 0);
      const hands = new ActuationLimiter(0.12, 0.1);
      hands.set({ steering: first.steering, throttle: first.throttle, brake: 0 });
      const queue: Array<{ t: number; s: number; p: number }> = [{ t: -99, s: first.steering, p: first.throttle }];
      sim.resetTrack();
      while (sim.time < 10) {
        const want = driver.update(read(), sim.dt);
        queue.push({ t: sim.time, s: want.steering, p: want.throttle });
        while (queue.length > 1 && queue[1].t <= sim.time - delay + 1e-9) queue.shift();
        sim.useFixed(hands.apply({ steering: queue[0].s, throttle: queue[0].p, brake: 0 }, sim.dt));
        sim.step();
        see();
      }
    }
    held = exit === 'held';
    return {
      style: style.name, delayThrough: through, entrySpeed: v0, reactionDelay: delay, exit, timeInBand: exitAt ?? 10, held,
      bodySlipInBandUntil: bodyOut ?? 10, endedAsDonut: held && sim.tel.speed < 8, heldFrom1p5s: !lateLoss,
      slideMeanDeg: mean(slides), slideStdDeg: std(slides),
      throttleMean: mean(throttles), stickMean: mean(sticks), stickStd: std(sticks), speedEnd: sim.tel.speed,
    };
  });
  delete c.series;
  report.cases.push(c);
  const m = c.metrics;
  report.summary[c.id] = `${m.exit}${m.endedAsDonut ? ' as a donut' : ''} (${(m.timeInBand as number).toFixed(1)} s; body slip in 10-50 deg until ${(m.bodySlipInBandUntil as number).toFixed(1)} s), slide ${(m.slideMeanDeg as number).toFixed(1)} +- ${(m.slideStdDeg as number).toFixed(1)}, throttle ${(m.throttleMean as number).toFixed(2)}, stick ${(m.stickMean as number).toFixed(2)} +- ${(m.stickStd as number).toFixed(2)}, ${(m.speedEnd as number).toFixed(1)} m/s`;
  return held;
}

export const driftHold: ManeuverDef = {
  name: 'driftHold',
  title: 'x. who can hold a drift: fixed stick x throttle for 10 s, equilibrium speed / radius, stickiness, raw thumbs, slow lab drivers',
  async run(env) {
    const report = new Report();
    const cellText = (c: CellOut) => (c.held ? `${c.slide.toFixed(0)} deg, ${c.speed.toFixed(1)} m/s, R ${c.radius.toFixed(0)} m` : c.closed !== null ? `closed ${c.closed.toFixed(1)} s` : 'lost');

    // 1. Quarter stick: a shallow drift at high throttle.
    const quarter: string[] = [];
    let quarterOk = true;
    for (const v of [12, 18]) for (const thr of [0.8, 1]) {
      const c = await cellCase(env, report, v, 0.25, thr);
      quarter.push(`v${v} t${thr}: ${cellText(c)}`);
      if (!(c.held && c.slide >= 8 && c.slide <= 14)) quarterOk = false;
    }
    report.summary.quarterStick = quarter.join(' | ');
    report.check('driftHold.quarterStick', quarter.join(' | '), 'stick 25 % into the turn at 80 / 100 % throttle holds a shallow 8-14 deg drift for 10 s (from 12 and 18 m/s)', quarterOk);

    // 2. The window, and where a held drift settles (speed, radius).
    const rows: string[] = [];
    let windowHeld = 0;
    let windowTotal = 0;
    let widest = 0;
    let fastest = 0;
    for (const [stick, thr] of [[0.5, 0.6], [0.5, 0.8], [0.5, 1], [0.75, 0.6], [0.75, 0.8], [0.75, 1], [1, 0.8], [1, 1]] as const) {
      const cells: string[] = [];
      for (const v of [12, 18]) {
        const c = await cellCase(env, report, v, stick, thr);
        // Full stick below full throttle from 12 m/s winds itself down into
        // a donut within a few seconds (the low-speed attractor of full
        // lock + power): reported, not counted.
        if (stick === 1 && thr < 1 && v === 12) {
          cells.push(`(${cellText(c)})`);
          continue;
        }
        windowTotal++;
        if (c.held) {
          windowHeld++;
          widest = Math.max(widest, c.radius);
          fastest = Math.max(fastest, c.speed);
        }
        cells.push(cellText(c));
      }
      rows.push(`stick ${stick} thr ${thr}: ${cells.join(' / ')}`);
    }
    report.summary.window = rows.join(' | ');
    report.summary.windowHeld = `${windowHeld} of ${windowTotal}`;
    report.summary.widestRadius = widest;
    report.summary.fastestDrift = fastest;
    report.check('driftHold.window', `${windowHeld} of ${windowTotal}`, 'stick 50 / 75 % into the turn at 60-100 % throttle and full stick at 80-100 % hold for 10 s (from 12 and 18 m/s; full stick at 80 % only from 18)', windowHeld === windowTotal);
    report.check('driftHold.staysOnABend', `widest R ${widest.toFixed(1)} m, fastest ${fastest.toFixed(1)} m/s`, 'a held drift scrubs to a medium bend: radius <= 20 m, speed <= 20 m/s after 10 s in every held cell', windowHeld > 0 && widest <= 20 && fastest <= 20);

    // 3. Not sticky: stick centred below 40 % throttle, big opposite lock on power.
    const loose: string[] = [];
    let worstLoose = 0;
    for (const v of [12, 18]) for (const [stick, thr] of [[0, 0.2], [0, 0.39], [-0.6, 1], [-1, 1]] as const) {
      const c = await cellCase(env, report, v, stick, thr, 3);
      const t = c.closed ?? 99;
      worstLoose = Math.max(worstLoose, t);
      loose.push(`v${v} s${stick} t${thr}: ${c.closed === null ? 'NOT closed' : `${c.closed.toFixed(2)} s`}`);
    }
    report.summary.notSticky = loose.join(' | ');
    report.check('driftHold.notSticky', worstLoose >= 99 ? 'never' : worstLoose, 'stick centred at 20 / 39 % throttle, or 60-100 % opposite lock floored: under 5 deg within 1 s', worstLoose < 1);

    // 4. Classic countersteer (info): high throttle, stick centred or a little opposite.
    const classic: string[] = [];
    for (const [stick, thr] of [[0, 0.6], [0, 0.8], [0, 1], [-0.15, 0.9], [-0.15, 1], [-0.3, 1]] as const) {
      const cells: string[] = [];
      for (const v of [12, 18]) cells.push(cellText(await cellCase(env, report, v, stick, thr, 6)));
      classic.push(`stick ${stick} thr ${thr}: ${cells.join(' / ')}`);
    }
    report.summary.classicCells = classic.join(' | ');

    // 5. Raw thumbs. 'into' steers into the turn around half stick; 'classic'
    // never leaves the range a countersteering driver uses (-60 % .. +10 %).
    let rawHeld = 0;
    let rawTotal = 0;
    let rawSlow = true;
    for (const v of [12, 18]) for (const delay of [0.25, 0.4, 0.6]) {
      const held = await rawThumbCase(env, report, 'thumb.into', v, delay, { throttle: 0.8, target: 20, bias: 0.5, gain: 0.03, lo: 0, hi: 1 });
      rawTotal++;
      if (held) rawHeld++;
      else if (delay <= 0.4) rawSlow = false;
    }
    report.summary.rawThumbHeld = `${rawHeld} of ${rawTotal}`;
    report.check('driftHold.rawThumb', `${rawHeld} of ${rawTotal}`, 'a plain proportional thumb (no car knowledge) holds 10 s with 0.25 and 0.4 s reactions at 12 and 18 m/s', rawSlow);
    // The classic way: foot (nearly) flat, the thumb works between 60 %
    // opposite lock and 10 % into the turn. With the default tuning that
    // range closes a slide (the stick INTO the turn holds it); with
    // tuning.classicDrift = 1 the throttle alone holds a shallow drift and
    // small opposite lock balances it. Both reported, neither judged.
    for (const [label, tune] of [['default', undefined], ['classicDrift1', { classicDrift: 1 }]] as const) {
      let n = 0;
      let total = 0;
      for (const v of [12, 18]) for (const delay of [0.25, 0.4]) {
        total++;
        if (await rawThumbCase(env, report, `thumb.classic.${label}`, v, delay, { throttle: 0.95, target: 18, bias: -0.15, gain: 0.02, lo: -0.6, hi: 0.1, tune })) n++;
      }
      report.summary[`classicThumbHeld.${label}`] = `${n} of ${total}`;
    }
    report.check('driftHold.classicThumb.info', `${report.summary['classicThumbHeld.default']} by default, ${report.summary['classicThumbHeld.classicDrift1']} with classicDrift 1`, 'info: a thumb that stays between 60 % opposite lock and 10 % into the turn at 95 % throttle holds 10 s (tuning.classicDrift)', true);

    // 6. The lab driver's drift law with slow reactions (see labDriverCase).
    let slow = 0;
    for (const style of STYLES.slice(0, 2)) {
      let both = true;
      for (const v of [12, 18]) if (!(await labDriverCase(env, report, style, v, 0.4, 'stick'))) both = false;
      if (both) slow++;
    }
    report.check('driftHold.slowDriver', `${slow} of 2 styles`, 'the lab driver\'s drift law with a 0.4 s delay on the stick (balanced or throttle-led) holds 10 s at 12 AND 18 m/s', slow >= 1);
    let steerLed = 0;
    for (const v of [12, 18]) for (const delay of [0.2, 0.3, 0.4, 0.5]) if (await labDriverCase(env, report, STYLES[2], v, delay, 'stick')) steerLed++;
    report.summary.steerLedHeld = `${steerLed} of 8`;
    report.summary.steerLedHeldFrom1p5s = `${report.cases.filter((c) => c.id.startsWith('driver.stick.steerLed') && c.metrics.heldFrom1p5s === true).length} of 8`;
    report.summary.labDriversEndingAsDonut = `${report.cases.filter((c) => c.id.startsWith('driver.stick') && c.metrics.endedAsDonut === true).length} of ${report.cases.filter((c) => c.id.startsWith('driver.stick')).length}`;
    report.check('driftHold.steerLed', `${steerLed} of 8`, 'the steering-led style (delay on the stick) holds at least half of its 8 cases (12 / 18 m/s x 0.2-0.5 s)', steerLed >= 4);
    // ... and with the delay on the wheel angle, as the break test xhDrift
    // has it (info: comparison with round 1).
    let angleHeld = 0;
    let angleTotal = 0;
    for (const style of STYLES) for (const v of [12, 18]) for (const delay of [0.2, 0.4]) {
      angleTotal++;
      if (await labDriverCase(env, report, style, v, delay, 'angle')) angleHeld++;
    }
    report.check('driftHold.angleDelay.info', `${angleHeld} of ${angleTotal}`, 'info: the same drift law with the delay on the wanted WHEEL ANGLE (3 styles x 12 / 18 m/s x 0.2 / 0.4 s)', true);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// y. powerOver

/**
 * Steady R at `v` (0.375 mu*g for the three standard pairs), then the stick
 * goes 50 % further into the turn and the foot goes flat — nothing else.
 */
async function powerOverCase(env: LabEnv, v: number, R: number, dt: number = env.dt) {
  const id = `power.v${v}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
    const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
    cruise.followPath(circlePath(R, 1), v);
    await sim.run(2.5);
    const stick = sim.intent.steering;
    sim.useScript([{ t: 0, steering: Math.min(1, stick + 0.5), throttle: 1, brake: 0 }]);
    sim.resetTrack();
    const t0 = sim.time;
    let peak = 0;
    let t15: number | null = null;
    const tail: number[] = [];
    await sim.run(4, (tel) => {
      const slide = -tel.beta * DEG;
      const t = tel.t - t0;
      if (tel.speed > 6 && slide > peak) peak = slide;
      if (t15 === null && slide >= 15) t15 = t;
      if (t > 3) tail.push(slide);
    });
    return {
      speed: v, radius: R, cruiseStick: stick,
      peakOversteerDeg: peak, timeTo15Deg: t15,
      slideAfter3sDeg: mean(tail), speedEnd: sim.tel.speed, spun: sim.track.spun,
    };
  }, dt);
}

async function donutCase(env: LabEnv, throttle: number, dt: number = env.dt) {
  const id = `donut.t${Math.round(throttle * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    sim.useScript([{ t: 0, steering: 1, throttle, brake: 0 }]);
    sim.resetTrack();
    const xs: number[] = [];
    const zs: number[] = [];
    const rear: number[] = [];
    const body: number[] = [];
    const speeds: number[] = [];
    const rates: number[] = [];
    let early = 0;
    // A donut winds itself in over the first seconds: judged from 9 to 12 s.
    await sim.run(12, (tel) => {
      if (Math.abs(tel.t - 3) < sim.dt / 2) early = rearSlide(sim);
      if (tel.t >= 9) {
        xs.push(tel.x);
        zs.push(tel.z);
        rear.push(rearSlide(sim));
        body.push(-tel.beta * DEG);
        speeds.push(tel.speed);
        rates.push(tel.yawRate * DEG);
      }
    });
    const circle = fitCircle(xs, zs);
    return {
      throttle,
      radius: circle.r, radiusRms: circle.rms,
      rearSlideAfter3sDeg: early,
      rearSlideMeanDeg: mean(rear), rearSlideStdDeg: std(rear),
      bodySlideMeanDeg: mean(body),
      speedMean: mean(speeds), speedDrift: speeds[speeds.length - 1] - speeds[0],
      yawRateMeanDeg: mean(rates),
      spun: sim.track.spun, rolledOver: sim.track.rolledOver,
    };
  }, dt);
}

export const powerOver: ManeuverDef = {
  name: 'powerOver',
  title: 'y. power-over at 12 / 15 / 18 m/s (floored in a 0.375 mu*g corner, 30-120 Hz) against the declared trait; donut from rest',
  async run(env) {
    const report = new Report();
    const mugRef = 0.375 * 1.2 * 25;
    const peaks: Record<number, number> = {};
    for (const v of [12, 15, 18]) {
      const c = await powerOverCase(env, v, Math.round((v * v) / mugRef * 10) / 10);
      delete c.series;
      report.cases.push(c);
      peaks[v] = c.metrics.peakOversteerDeg as number;
      report.summary[`power.v${v}`] = `peak ${(c.metrics.peakOversteerDeg as number).toFixed(1)} deg, 15 deg after ${c.metrics.timeTo15Deg === null ? '-' : `${(c.metrics.timeTo15Deg as number).toFixed(2)} s`}, ${(c.metrics.slideAfter3sDeg as number).toFixed(1)} deg at 3-4 s, ${(c.metrics.speedEnd as number).toFixed(1)} m/s`;
    }
    const atRates = [peaks[15]];
    for (const hz of RATES) {
      const c = await powerOverCase(env, 15, 20, 1 / hz);
      delete c.series;
      report.cases.push(c);
      atRates.push(c.metrics.peakOversteerDeg as number);
    }
    report.summary['power.v15.rates'] = `60 / ${RATES.join(' / ')} Hz: ${atRates.map((p) => p.toFixed(1)).join(' / ')} deg`;
    const spread = Math.max(...atRates) - Math.min(...atRates);
    report.check('powerOver.sameAtEveryRate', `${atRates.map((p) => p.toFixed(1)).join(' / ')} deg`, 'peak oversteer at 15 m/s within 4 deg across 30 / 60 / 72 / 90 / 120 Hz', spread <= 4);
    // The trait the car's preset declares (handling.ts): the peak slide when
    // floored at 12 / 15 / 18 m/s, as [min, max] degrees.
    const trait = (env.handling ? handlingFor(env.carId)?.powerOver : undefined) ?? handlingFor('reef-rocket')?.powerOver;
    if (trait) {
      const bad: string[] = [];
      for (const v of [12, 15, 18] as const) {
        const band = trait[`v${v}`];
        if (peaks[v] < band[0] || peaks[v] > band[1]) bad.push(`${v} m/s: ${peaks[v].toFixed(1)} not in ${band[0]}-${band[1]}`);
      }
      report.check('powerOver.asDeclared', bad.length ? bad.join('; ') : `${peaks[12].toFixed(0)} / ${peaks[15].toFixed(0)} / ${peaks[18].toFixed(0)} deg`,
        `peak oversteer at 12 / 15 / 18 m/s inside the bands the handling preset declares (${[12, 15, 18].map((v) => trait[`v${v}` as 'v12'].join('-')).join(' / ')} deg)`, bad.length === 0);
    }
    // Donut.
    const fails: string[] = [];
    const text: string[] = [];
    const donut = async (thr: number, dt?: number) => {
      const c = await donutCase(env, thr, dt);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      text.push(`${c.id.replace('donut.', '')}: R ${(m.radius as number).toFixed(1)} m, rear ${(m.rearSlideMeanDeg as number).toFixed(0)} deg, body ${(m.bodySlideMeanDeg as number).toFixed(0)} deg, ${(m.speedMean as number).toFixed(1)} m/s (${(m.speedDrift as number) >= 0 ? '+' : ''}${(m.speedDrift as number).toFixed(1)}), ${(m.yawRateMeanDeg as number).toFixed(0)} deg/s`);
      // The tail is out (rear axle; the BODY slip angle of a 2.5 m circle is
      // small by geometry alone) and the car rotates briskly on a small
      // circle. (It keeps winding itself in for 10 s and more on some cars —
      // the speed drift over the last 3 s is reported, not judged.)
      const ok = m.rolledOver === false && (m.radius as number) >= 2 && (m.radius as number) <= 10 && (m.rearSlideMeanDeg as number) >= 20 &&
        (m.rearSlideAfter3sDeg as number) >= 20 && (m.yawRateMeanDeg as number) >= 60 && (m.radiusRms as number) < 1 && (m.rearSlideStdDeg as number) < 8;
      if (!ok) fails.push(c.id.replace('donut.', ''));
    };
    await donut(1);
    for (const hz of RATES) await donut(1, 1 / hz);
    // (80 % throttle: reported, not judged — a planted car may simply drive
    // a circle on its tires there.)
    {
      const c = await donutCase(env, 0.8);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      report.summary['donut.t80'] = `R ${(m.radius as number).toFixed(1)} m, rear ${(m.rearSlideMeanDeg as number).toFixed(0)} deg, ${(m.speedMean as number).toFixed(1)} m/s, ${(m.yawRateMeanDeg as number).toFixed(0)} deg/s`;
    }
    report.summary.donut = text.join(' | ');
    report.check('powerOver.donut', fails.length ? `fails: ${fails.join(', ')}` : text[0], 'full lock + full throttle from rest: the tail is out after 3 s (rear >= 20 deg) and from 9 to 12 s the car circles on a 2-10 m radius, rear >= 20 deg, >= 60 deg/s, 30-120 Hz', fails.length === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// z. assist

/** Bang-bang thumb: full opposite lock while the rear is out, lift. */
async function bangCase(env: LabEnv, level: number, v0: number, beta0Deg: number, delay: number) {
  return runCase(env, `bang.a${Math.round(level * 100)}.v${v0}.b${beta0Deg}.d${Math.round(delay * 100)}`, FLAT, async (sim): Promise<Metrics> => {
    sim.vehicle.setTuning('assistLevel', level);
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    const hands = new ActuationLimiter(0.12, 0.1);
    hands.set({ throttle: 0.3, steering: 0, brake: 0 });
    const queue: Array<{ t: number; s: number }> = [];
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    sim.resetTrack();
    while (sim.time < 6) {
      const tel = sim.tel;
      const slip = rearSlide(sim);
      const want = Math.abs(slip) > 4 && tel.vFwd > 0 ? -Math.sign(slip) : 0;
      queue.push({ t: tel.t, s: want });
      while (queue.length > 1 && queue[1].t <= tel.t - delay + 1e-9) queue.shift();
      const acted = queue[0].t <= tel.t - delay + 1e-9 ? queue[0].s : 0;
      sim.useFixed(hands.apply({ steering: acted, throttle: tel.t >= delay ? 0 : 0.3, brake: 0 }, sim.dt));
      sim.step();
      betas.push(sim.tel.beta);
      rates.push(sim.tel.yawRate);
      yaws.push(sim.tel.yaw);
    }
    return { assistLevel: level, reactionDelay: delay, ...judgeRecovery(sim.dt, betas, rates, yaws, 0, -1), speedEnd: sim.tel.speed };
  });
}

/** The standard 35 deg slide with the 0.25 s lab driver at an assist level. */
async function driverCatchCase(env: LabEnv, level: number, beta0Deg: number, held: 'neutral' | 'floored') {
  return runCase(env, `driver.a${Math.round(level * 100)}.b${beta0Deg}.${held}`, FLAT, async (sim): Promise<Metrics> => {
    sim.vehicle.setTuning('assistLevel', level);
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: 15, beta: -beta0, yawRate: beta0 });
    // Until the driver reacts the controls stay where they were.
    sim.useFixed(held === 'floored' ? { throttle: 1, steering: 1 } : { throttle: 0.3, steering: 0 });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.25 }));
    driver.recover(0, null);
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    await sim.run(6, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    });
    return { assistLevel: level, held, ...judgeRecovery(sim.dt, betas, rates, yaws, 0, -1), speedEnd: sim.tel.speed };
  });
}

export const assist: ManeuverDef = {
  name: 'assist',
  title: 'z. assistLevel 1 / 0.5 / 0: 35 deg slide caught by the 0.25 s driver, by a raw opposite-lock thumb, and panic opposite lock on power',
  async run(env) {
    const report = new Report();
    // Other models have no such key: nothing to measure.
    let hasKey = false;
    await runCase(env, 'probe', FLAT, async (sim): Promise<Metrics> => {
      hasKey = sim.vehicle.getTuning('assistLevel') !== undefined;
      return {};
    });
    if (!hasKey) {
      report.summary.note = 'model has no assistLevel key';
      return report.output();
    }
    const fmt = (m: Metrics) => `${m.spun ? 'SPIN' : m.recovered ? `${(m.recoveryTime as number).toFixed(2)} s` : 'never'} / ${m.overshoots} os / swing ${(m.counterSwingDeg as number).toFixed(0)}`;
    const half: Metrics[] = [];
    for (const level of [1, 0.5, 0]) {
      const row: string[] = [];
      for (const held of ['neutral', 'floored'] as const) {
        const c = await driverCatchCase(env, level, 35, held);
        delete c.series;
        report.cases.push(c);
        row.push(`driver ${held}: ${fmt(c.metrics)}`);
        if (level === 0.5) half.push(c.metrics);
      }
      for (const delay of [0.25, 0.4]) {
        const c = await bangCase(env, level, 15, 35, delay);
        delete c.series;
        report.cases.push(c);
        row.push(`thumb ${delay} s: ${fmt(c.metrics)}`);
        if (level === 0.5 && delay === 0.25) half.push(c.metrics);
      }
      const c = await oppositeLockCase(env, 15, 35, 1, env.dt, { assistLevel: level });
      c.id = `opp.a${Math.round(level * 100)}`;
      delete c.series;
      report.cases.push(c);
      row.push(`opposite lock floored: ${catchText(c.metrics)}`);
      report.summary[`assist${Math.round(level * 100)}`] = row.join(' | ');
    }
    const ok = half.every((m) => m.recovered === true && m.spun === false && (m.overshoots as number) <= 2 && (m.recoveryTime as number) < 2.5);
    report.check('assist.halfIsCatchable', String(report.summary.assist50), 'at assistLevel 0.5 a 0.25 s driver (controls neutral, and stick in + foot flat until he reacts) and a raw opposite-lock thumb catch a 35 deg slide: no spin, <= 2 overshoots, < 2.5 s', ok);
    return report.output();
  },
};

export const DRIFT_MANEUVERS: ManeuverDef[] = [slideCatch, driftHold, powerOver, assist];
