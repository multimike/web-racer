import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { DriverParams } from '../../../car/DriverModel';
import { handlingFor } from '../../../car/handling';
import type { CaseResult, MetricValue } from '../types';
import { circlePath } from '../paths';
import { FLAT, Report, mean, num, runCase, std } from './common';
import type { ManeuverDef } from './common';

// ---------------------------------------------------------------------------
// i. slide recovery — THE test for "possible to react and straighten".
//
// The car is put into a slide at 15 m/s: travelling along +z with the nose
// `beta0` to the RIGHT of the direction of travel (an oversteer slide in a
// right-hander) and still rotating into it at beta0 [rad] per second, part
// throttle, stick centred. Then either
//   'driver'   — after the 0.25 s reaction delay the driver countersteers
//                (steer toward the velocity direction, yaw-rate damping),
//                eases the throttle and steers back to the original course;
//   'handsOff' — stick and pedals released: the car must straighten itself.

export async function slideRecoveryCase(
  env: LabEnv,
  beta0Deg: number,
  mode: 'driver' | 'handsOff',
  dt: number = env.dt,
  /** The driver's reaction time, s (0.25 keeps the original case id). */
  reaction = 0.25,
) {
  const tag = mode === 'driver' && reaction !== 0.25 ? `.r${Math.round(reaction * 100)}` : '';
  return runCase(env, `b${beta0Deg}.${mode}${tag}`, FLAT, async (sim: Sim) => {
    const v0 = 15;
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    sim.useFixed({ throttle: 0.3 });
    if (mode === 'driver') {
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: reaction }));
      driver.recover(0, v0);
    } else {
      sim.useScript([{ t: 0, steering: 0, throttle: 0, brake: 0 }]);
    }
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    let maxX = 0;
    let minSpeed = v0;
    await sim.run(6.0, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
      maxX = Math.max(maxX, Math.abs(tel.x));
      minSpeed = Math.min(minSpeed, tel.speed);
    });

    return {
      onsetBetaDeg: beta0Deg,
      ...analyzeRecovery(sim, betas, rates, yaws, 0),
      lateralUsed: maxX,
      minSpeed,
      speedEnd: sim.tel.speed,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      rolledOver: sim.track.rolledOver,
    };
  }, dt);
}

/**
 * Judge a recovery from per-step logs that start at slide onset with
 * beta < 0 (nose inside the direction of travel of a right-hand slide).
 */
function analyzeRecovery(
  sim: Sim,
  betas: number[],
  rates: number[],
  yaws: number[],
  /** Direction of travel at slide onset, rad. */
  course0: number,
): Record<string, MetricValue> {
  // Recovered = first moment from which |beta| < 5° and |yaw rate| < 10°/s
  // hold for 0.5 s.
  const hold = Math.round(0.5 / sim.dt);
  let recovery: number | null = null;
  let headingAtRecovery: number | null = null;
  let calm = 0;
  for (let i = 0; i < betas.length; i++) {
    if (Math.abs(betas[i]) < 5 * RAD && Math.abs(rates[i]) < 10 * RAD) {
      if (++calm >= hold) {
        recovery = (i + 1 - hold + 1) * sim.dt;
        headingAtRecovery = (yaws[i + 1 - hold] - course0) * DEG;
        break;
      }
    } else {
      calm = 0;
    }
  }
  // Judged up to the catch (+0.5 s); what happens afterwards (driver
  // steering back to the course) is reported separately.
  const judged = recovery === null ? betas.length : Math.min(betas.length, Math.round((recovery + 0.5) / sim.dt));
  // Overshoots (tank-slappers): swings past 5° on the far side of zero.
  let overshoots = 0;
  let side = -1;
  let counterSwing = 0;
  let peak = 0;
  let spunInCatch = false;
  let afterMax = 0;
  for (let i = 0; i < betas.length; i++) {
    const b = betas[i];
    if (i >= judged) {
      afterMax = Math.max(afterMax, Math.abs(b));
      continue;
    }
    if (Math.abs(b) > peak) peak = Math.abs(b);
    if (Math.abs(b) > Math.PI / 2) spunInCatch = true;
    if (b > 0 && b > counterSwing) counterSwing = b;
    if (b * side < -5 * RAD) {
      overshoots++;
      side = -side;
    }
  }
  return {
    peakBetaDeg: peak * DEG,
    recovered: recovery !== null && !spunInCatch,
    recoveryTime: spunInCatch ? null : recovery,
    overshoots,
    counterSwingDeg: counterSwing * DEG,
    spun: spunInCatch,
    // Largest slip angle AFTER the catch, while resuming course and speed.
    afterCatchMaxBetaDeg: afterMax * DEG,
    // Where the car points, relative to the direction it was TRAVELLING at
    // slide onset, when the slide is caught (a perfect catch keeps the car
    // on its line: 0) and at the end of the run.
    headingAtRecoveryDeg: spunInCatch ? null : headingAtRecovery,
    finalHeadingErrorDeg: (yaws[yaws.length - 1] - course0) * DEG,
  };
}

/**
 * The slide players actually get: power oversteer. R = 12 m right-hander at
 * 9 m/s, throttle floored with the stick held. When the tail is 12° out ("it has
 * begun skidding") the driver notices; 0.25 s later (foot still down until then!) the hands
 * countersteer and the foot eases. `null` metrics = the car never slid.
 */
const ONSET = 12;

async function powerSlideCase(env: LabEnv) {
  return runCase(env, 'powerSlide.driver', FLAT, async (sim: Sim): Promise<Record<string, MetricValue>> => {
    const R = 12;
    const v = 9;
    sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
    const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
    cruise.followPath(circlePath(R, 1), v);
    await sim.run(2.5);
    sim.useScript([{ t: 0, steering: Math.min(1, sim.intent.steering + 0.3), throttle: 1, brake: 0 }]);
    const t0 = sim.time;
    const slid = await sim.run(3.0, (tel) => tel.speed > 5 && -tel.beta >= ONSET * RAD);
    if (!slid) {
      return { slid: false, timeToSlide: null, recovered: null, recoveryTime: null, overshoots: null, counterSwingDeg: null, spun: null };
    }
    const timeToSlide = sim.time - t0;
    const onsetSpeed = sim.tel.speed;
    const course0 = sim.tel.yaw + sim.tel.beta;
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.25 }));
    driver.recover(null, null);
    sim.resetTrack();
    const betas: number[] = [];
    const rates: number[] = [];
    const yaws: number[] = [];
    await sim.run(5.0, (tel) => {
      betas.push(tel.beta);
      rates.push(tel.yawRate);
      yaws.push(tel.yaw);
    });
    return {
      slid: true,
      timeToSlide,
      onsetSpeed,
      onsetBetaDeg: ONSET,
      ...analyzeRecovery(sim, betas, rates, yaws, course0),
      speedEnd: sim.tel.speed,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
    };
  });
}

/**
 * [slide deg, reaction cs, limit m] for the `recover.road*` gates: the
 * largest `lateralUsed` measured on the four cars at 30 / 60 / 72 / 90 / 120
 * Hz (2026-11-21), plus 15 % — the fallback for
 * a car not in ROAD_LIMITS_BY_CAR.
 */
const ROAD_LIMITS: Array<[number, number, number]> = [
  [20, 25, 12.9], // worst 11.22 m (comet-fox, 72 Hz)
  [20, 40, 17.7], // worst 15.37 m (riot-ram, 120 Hz)
  [50, 25, 22.9], // worst 19.92 m (riot-ram, 30 Hz)
  [50, 40, 20.7], // worst 17.98 m (riot-ram, 30 Hz)
];

/** The same per car (its own worst over the five rates + 15 %, rounded up
 * to 0.1 m), in ROAD_LIMITS order: one number for four cars only showed a
 * regression of the worst car (neon-wasp uses 4.1 m where the shared
 * 50 deg / 0.4 s limit is 20.7). */
const ROAD_LIMITS_BY_CAR: Record<string, number[]> = {
  'reef-rocket': [12.4, 16.2, 19.8, 15.8], // worst 10.71 / 14.08 / 17.18 / 13.66
  'neon-wasp': [12.2, 16.4, 11.7, 4.8], // worst 10.57 / 14.23 / 10.11 / 4.12
  'riot-ram': [12.1, 17.7, 23.0, 20.7], // worst 10.48 / 15.37 / 19.92 / 17.98
  'comet-fox': [12.9, 17.6, 20.7, 18.0], // worst 11.22 / 15.26 / 17.97 / 15.58
};

export const slideRecovery: ManeuverDef = {
  name: 'slideRecovery',
  title: 'i. slide recovery from 20 / 35 / 50 deg at 15 m/s (driver 0.25 s, hands-off) + power slide',
  async run(env) {
    const report = new Report();
    const byId: Record<string, CaseResult> = {};
    for (const beta of [20, 35, 50]) {
      for (const mode of ['driver', 'handsOff'] as const) {
        const c = await slideRecoveryCase(env, beta, mode);
        report.cases.push(c);
        byId[c.id] = c;
        report.summary[`${c.id}.time`] = c.metrics.recoveryTime;
        report.summary[`${c.id}.overshoots`] = c.metrics.overshoots;
        report.summary[`${c.id}.counterSwingDeg`] = c.metrics.counterSwingDeg;
        report.summary[`${c.id}.spun`] = c.metrics.spun;
      }
    }
    // Road used while catching: the 20 and 50 deg slides with a slower
    // driver too (0.4 s). The 35 deg / 0.25 s case is the scorecard's best
    // case; these keep the rest from regressing unseen. A MEASUREMENT gate
    // (worst of the four cars at 30 / 60 / 72 / 90 / 120 Hz + 15 %), not a
    // handling target — whether the car should use less road is the
    // owner's feel decision.
    for (const beta of [20, 50]) {
      const c = await slideRecoveryCase(env, beta, 'driver', env.dt, 0.4);
      report.cases.push(c);
      byId[c.id] = c;
      report.summary[`${c.id}.time`] = c.metrics.recoveryTime;
    }
    for (const [k, [beta, react, shared]] of ROAD_LIMITS.entries()) {
      const limit = ROAD_LIMITS_BY_CAR[env.carId]?.[k] ?? shared;
      const id = `b${beta}.driver${react === 25 ? '' : `.r${react}`}`;
      const used = num(byId[id].metrics.lateralUsed);
      report.summary[`road${beta}.r${react}`] = used;
      report.check(`recover.road${beta}.r${react}`, used, `sideways ground used catching a ${beta} deg slide at 15 m/s, ${react / 100} s driver: <= ${limit} m (${env.carId in ROAD_LIMITS_BY_CAR ? 'this car\'s' : 'all cars\''} measured worst + 15 %)`, used !== null && used <= limit);
    }
    const power = await powerSlideCase(env);
    report.cases.push(power);
    const pm = power.metrics;
    report.summary['powerSlide.slid'] = pm.slid;
    report.summary['powerSlide.time'] = pm.recoveryTime;
    report.summary['powerSlide.overshoots'] = pm.overshoots;
    report.summary['powerSlide.counterSwingDeg'] = pm.counterSwingDeg;
    report.summary['powerSlide.spun'] = pm.spun;
    const t = (id: string) => num(byId[id].metrics.recoveryTime);
    const lt = (v: number | null, limit: number) => v !== null && v < limit;
    const d20 = byId['b20.driver'].metrics;
    const d35 = byId['b35.driver'].metrics;
    const d50 = byId['b50.driver'].metrics;
    report.check('slideRecovery.b20.time', d20.recoveryTime, '< 1.2 s', lt(t('b20.driver'), 1.2));
    report.check('slideRecovery.b35.time', d35.recoveryTime, '< 1.6 s', lt(t('b35.driver'), 1.6));
    report.check('slideRecovery.b35.overshoots', d35.overshoots, '<= 1 overshoot', d35.recovered === true && (d35.overshoots as number) <= 1);
    report.check('slideRecovery.b35.counterSwing', d35.counterSwingDeg, '< 12 deg', d35.recovered === true && (d35.counterSwingDeg as number) < 12);
    report.check('slideRecovery.b35.onLine', d35.headingAtRecoveryDeg, 'caught within 25 deg of the original course', d35.recovered === true && Math.abs(d35.headingAtRecoveryDeg as number) < 25);
    report.check('slideRecovery.b35.heading', d35.finalHeadingErrorDeg, 'back within 5 deg of the original course after 6 s', d35.recovered === true && Math.abs(d35.finalHeadingErrorDeg as number) < 5);
    report.check('slideRecovery.b50.recoverable', d50.recoveryTime, 'recovers at all (< 6 s, no spin)', d50.recovered === true);
    for (const beta of [20, 35]) {
      const h = byId[`b${beta}.handsOff`].metrics;
      report.check(`slideRecovery.b${beta}.handsOff`, h.recoveryTime, 'self-straightens < 2.5 s, no spin', lt(t(`b${beta}.handsOff`), 2.5) && h.spun === false);
    }
    // Power slide: only judged if the car can be made to slide on power at
    // all (if not, that is a drift-capability failure, scored there).
    if (pm.slid === true) {
      report.check('slideRecovery.powerSlide.caught', pm.recoveryTime, 'power slide caught < 2.0 s, no spin', pm.recovered === true && (pm.recoveryTime as number) < 2.0);
      report.check('slideRecovery.powerSlide.overshoots', pm.overshoots, '<= 1 overshoot, counter-swing < 15 deg', pm.recovered === true && (pm.overshoots as number) <= 1 && (pm.counterSwingDeg as number) < 15);
    }
    const h50 = byId['b50.handsOff'].metrics;
    report.check('slideRecovery.b50.handsOffNoSpin', h50.spun, 'hands-off from 50 deg does not spin', h50.spun === false);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// g. drift initiation — three techniques from 15 m/s in an R = 20 m right turn.

type Technique = 'powerOver' | 'liftFlick' | 'brakeTap' | 'powerOverSlow';

async function driftInitiateCase(env: LabEnv, technique: Technique) {
  return runCase(env, technique, FLAT, async (sim: Sim) => {
    // The three briefed techniques start from 15 m/s on R = 20 m. The extra
    // 'powerOverSlow' is a second-gear hairpin: 9 m/s on R = 10 m, where a
    // car that tops out at 25 m/s still has torque to spare.
    const slow = technique === 'powerOverSlow';
    const R = slow ? 10 : 20;
    const v = slow ? 9 : 15;
    const minSpeed = slow ? 5 : 8;
    const plan = circlePath(R, 1);
    sim.place({ x: 0, z: 0, yaw: 0, speed: v, yawRate: v / R });
    const cruise = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
    cruise.followPath(plan, v);
    await sim.run(2.5);
    const stick = sim.intent.steering;
    sim.resetTrack();
    if (technique === 'powerOver' || technique === 'powerOverSlow') {
      // Add lock and stand on the throttle.
      sim.useScript([{ t: 0, steering: Math.min(1, stick + 0.5), throttle: 1, brake: 0 }]);
    } else if (technique === 'liftFlick') {
      // Lift, flick away from the corner, then throw it in and get back on it.
      sim.useScript([
        { t: 0, steering: -1, throttle: 0, brake: 0 },
        { t: 0.25, steering: 1 },
        { t: 0.6, throttle: 1 },
      ]);
    } else {
      // Tap the brake with lock on to unload the rear, then power. (At this
      // gravity a full brake sheds 30 m/s per second — a tap is 0.15 s.)
      sim.useScript([
        { t: 0, steering: 1, throttle: 0, brake: 0.6 },
        { t: 0.15, brake: 0, throttle: 1 },
      ]);
    }
    // Oversteer in a right turn = nose inside the velocity vector = beta < 0.
    let tInit: number | null = null;
    let peakOver = 0;
    let peakUnder = 0;
    const t0 = sim.time;
    await sim.run(3.5, (tel) => {
      // Sliding at walking pace is a pivot, not a drift.
      if (tel.speed < minSpeed) return false;
      peakOver = Math.max(peakOver, -tel.beta);
      peakUnder = Math.max(peakUnder, tel.beta);
      if (-tel.beta >= 15 * RAD) {
        tInit = tel.t - t0;
        return true;
      }
      return false;
    });
    let caught: boolean | null = null;
    let heldMean: number | null = null;
    let heldStd: number | null = null;
    if (tInit !== null) {
      // Hand over to the drift driver: can the slide be held, or does it spin?
      const drifter = sim.makeDriver({ reactionDelay: 0.2 });
      drifter.driftHold(-25 * RAD);
      sim.useDriver(drifter);
      const tail: number[] = [];
      const tHold = sim.time;
      let wild = false;
      let tooSlow = false;
      await sim.run(2.5, (tel) => {
        if (Math.abs(tel.beta) > 70 * RAD) wild = true;
        if (tel.speed < minSpeed - 1) tooSlow = true;
        if (tel.t - tHold > 1.0) tail.push(-tel.beta * DEG);
      });
      heldMean = mean(tail);
      heldStd = std(tail);
      // Held = stays a drift: 10-45° on average, steady, still moving.
      caught = !wild && !tooSlow && heldMean > 10 && heldMean < 45 && heldStd < 10;
    }
    return {
      technique,
      initiated: tInit !== null,
      timeTo15Deg: tInit,
      peakOversteerDeg: peakOver * DEG,
      peakUndersteerDeg: peakUnder * DEG,
      caught,
      heldBetaDeg: heldMean,
      heldBetaStdDeg: heldStd,
      speedEnd: sim.tel.speed,
      spun: sim.track.spun,
    };
  });
}

/** The power-over bands the car's handling preset declares (as the
 * powerOver maneuver reads them; ?handling=0 = the reference car's). */
function declaredPowerOver(env: LabEnv) {
  return (env.handling ? handlingFor(env.carId)?.powerOver : undefined) ?? handlingFor('reef-rocket')?.powerOver;
}

export const driftInitiate: ManeuverDef = {
  name: 'driftInitiate',
  title: 'g. drift initiation: power-over, lift-off + flick, brake-tap (15 m/s, R = 20 m) + slow power-over',
  async run(env) {
    const report = new Report();
    let initiated = 0;
    let usable = 0;
    for (const technique of ['powerOver', 'liftFlick', 'brakeTap', 'powerOverSlow'] as const) {
      const c = await driftInitiateCase(env, technique);
      report.cases.push(c);
      const m = c.metrics;
      if (m.initiated) initiated++;
      if (m.initiated && m.caught) usable++;
      report.summary[`${technique}.timeTo15Deg`] = m.timeTo15Deg;
      report.summary[`${technique}.peakOversteerDeg`] = m.peakOversteerDeg;
      report.summary[`${technique}.caught`] = m.caught;
      // POWER-OVER is a per-car trait (handling.ts `powerOver`, measured by
      // the powerOver maneuver): a car whose preset declares that it does NOT
      // step out when floored at 15 m/s (band top under 15 deg — riot-ram,
      // 0-6) is judged against that band, not asked for a drift.
      const band = technique === 'powerOver' ? declaredPowerOver(env)?.v15 : undefined;
      if (band && band[1] < 15) {
        report.check(`driftInitiate.${technique}`, m.peakOversteerDeg, `declared not to step out at 15 m/s: peak oversteer inside the preset's band ${band[0]}-${band[1]} deg, no spin`,
          m.spun === false && (m.peakOversteerDeg as number) >= band[0] && (m.peakOversteerDeg as number) <= band[1]);
        continue;
      }
      report.check(`driftInitiate.${technique}`, m.initiated && m.caught ? m.timeTo15Deg : m.peakOversteerDeg, 'reaches 15 deg of oversteer within 3.5 s and can be held (no spin)', m.initiated === true && m.caught === true);
    }
    report.summary.techniquesInitiated = initiated;
    report.summary.techniquesUsable = usable;
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// h. drift sustain — hold beta = 25 deg for 5 s with throttle + countersteer.

const DRIFT_PRESETS: Array<{ name: string; params: Partial<DriverParams> }> = [
  { name: 'balanced', params: {} },
  { name: 'throttle-led', params: { driftSteerGain: 0.8, driftSteerBias: 6 * RAD, driftYawDamp: 0.5, driftThrottle: 0.7, driftThrottleGain: 2.5, driftThrottleRate: 0.35 } },
  { name: 'steer-led', params: { driftSteerGain: 1.8, driftSteerBias: 2 * RAD, driftYawDamp: 0.3, driftThrottle: 0.45, driftThrottleGain: 1.0, driftThrottleRate: 0.15 } },
];

/**
 * Entry states: mid-drift at 12 and 18 m/s. A steady 25° drift is a hard
 * corner — hand physics for a rear-driven car with sliding rear tires puts
 * the centripetal acceleration near 0.65·mu·g (rear side force + front side
 * force balancing it in yaw + the inward component of the thrust), so the
 * arc radius follows from the speed: R = v² / (0.65·mu·g) ≈ 7 m and 17 m.
 * Starting on that arc (rather than on a gentle one) puts the car near its
 * drift equilibrium instead of asking the driver to find it from far away.
 */
const DRIFT_ENTRIES = [
  { name: 'v12', speed: 12 },
  { name: 'v18', speed: 18 },
];
const DRIFT_CENTRIPETAL = 0.65;

async function driftSustainCase(
  env: LabEnv,
  preset: (typeof DRIFT_PRESETS)[number],
  entry: (typeof DRIFT_ENTRIES)[number],
) {
  return runCase(env, `${entry.name}.${preset.name}`, FLAT, async (sim: Sim) => {
    const v0 = entry.speed;
    const target = 25 * RAD;
    // Mid-drift state: nose 25° inside the velocity vector, yawing right
    // along the equilibrium arc; the driver's hands and feet start where its own
    // drift law puts them for that state (no stale-command transient).
    sim.place({ x: 0, z: 0, yaw: target, speed: v0, beta: -target, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
    const driver = sim.makeDriver({ reactionDelay: 0.2, ...preset.params });
    driver.driftHold(-target);
    sim.useSettledDriver(driver);
    sim.resetTrack();
    const betas: number[] = [];
    const speeds: number[] = [];
    let straightRun = 0;
    let straightened = false;
    const t0 = sim.time;
    await sim.run(6.0, (tel) => {
      if (tel.t - t0 >= 1.0) {
        betas.push(-tel.beta * DEG);
        speeds.push(tel.speed);
      }
      straightRun = Math.abs(tel.beta) < 8 * RAD ? straightRun + sim.dt : 0;
      if (straightRun >= 1.0) straightened = true;
    });
    const inBand = betas.filter((b) => Math.abs(b - 25) <= 10).length / betas.length;
    return {
      preset: preset.name,
      entrySpeed: v0,
      betaMeanDeg: mean(betas),
      betaStdDeg: std(betas),
      inBandFraction: inBand,
      speedMean: mean(speeds),
      speedKept: mean(speeds) / v0,
      minSpeed: Math.min(...speeds),
      spun: sim.track.spun,
      straightened,
      sustained: !sim.track.spun && !straightened,
    };
  });
}

/**
 * Open-loop drift window — no driver model at all. From the same mid-drift
 * state, hold a FIXED throttle and a FIXED stick (`counter` > 0 = against the
 * turn, < 0 = into it) and time how long
 * the car stays in a slide (10° < |beta| < 50°, still moving) before it
 * either snaps straight or spins. A car whose slide lingers is one a human
 * can ride and correct; a car that leaves the window in a quarter of a
 * second cannot be drifted with 0.25 s reactions, whatever the technique.
 */
async function driftWindowCase(env: LabEnv, entry: (typeof DRIFT_ENTRIES)[number], throttle: number, counter: number) {
  return runCase(env, `window.${entry.name}.t${Math.round(throttle * 100)}.c${Math.round(counter * 100)}`, FLAT, async (sim: Sim) => {
    const v0 = entry.speed;
    const target = 25 * RAD;
    sim.place({ x: 0, z: 0, yaw: target, speed: v0, beta: -target, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / v0 });
    sim.useFixed({ throttle, steering: -counter });
    sim.resetTrack();
    let exit = 'held 5 s';
    const t0 = sim.time;
    await sim.run(5.0, (tel) => {
      const slide = -tel.beta;
      if (tel.speed < 4) exit = 'stopped';
      else if (slide < 10 * RAD) exit = 'straightened';
      else if (slide > 50 * RAD) exit = 'spun out';
      else return false;
      return true;
    });
    return {
      entrySpeed: v0,
      throttle,
      countersteer: counter,
      windowTime: sim.time - t0,
      exit,
      speedEnd: sim.tel.speed,
    };
  });
}

export const driftSustain: ManeuverDef = {
  name: 'driftSustain',
  title: 'h. drift sustain: hold beta = 25 deg for 5 s (2 entry speeds x 3 driver styles) + open-loop slide window',
  async run(env) {
    const report = new Report();
    let best: CaseResult | null = null;
    let bestCost = Infinity;
    for (const entry of DRIFT_ENTRIES) for (const preset of DRIFT_PRESETS) {
      const c = await driftSustainCase(env, preset, entry);
      report.cases.push(c);
      const m = c.metrics;
      const cost = (m.sustained ? 0 : 1000) + Math.abs((m.betaMeanDeg as number) - 25) + (m.betaStdDeg as number);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    const m = best!.metrics;
    Object.assign(report.summary, m);
    report.summary.bestCase = best!.id;

    // Open-loop window: best fixed-input combination.
    let window = 0;
    let windowCase = '';
    let windowExit = '';
    for (const entry of DRIFT_ENTRIES) {
      for (const throttle of [0.4, 0.7, 1.0]) {
        // Stick positions across the WHOLE range: countersteered (the
        // classic technique) and held INTO the turn (how a car with a
        // steering gyro / slide-steering assist is drifted).
        for (const counter of [0.2, 0.5, 0.8, -0.5, -0.75, -1]) {
          const c = await driftWindowCase(env, entry, throttle, counter);
          delete c.series;
          report.cases.push(c);
          if ((c.metrics.windowTime as number) > window) {
            window = c.metrics.windowTime as number;
            windowCase = c.id;
            windowExit = c.metrics.exit as string;
          }
        }
      }
    }
    report.summary.openLoopWindow = window;
    report.summary.openLoopWindowCase = windowCase;
    report.summary.openLoopWindowExit = windowExit;
    report.check('driftSustain.openLoopWindow', window, 'some fixed throttle + fixed stick keeps the slide alive >= 1.5 s', window >= 1.5);
    report.check('driftSustain.sustained', m.sustained, 'neither spins nor straightens for 5 s', m.sustained === true);
    report.check('driftSustain.betaMean', m.betaMeanDeg, '25 +- 8 deg', m.sustained === true && Math.abs((m.betaMeanDeg as number) - 25) < 8);
    report.check('driftSustain.betaStd', m.betaStdDeg, 'std < 8 deg', m.sustained === true && (m.betaStdDeg as number) < 8);
    report.check('driftSustain.speedKept', m.speedKept, '> 0.6 of entry speed', m.sustained === true && (m.speedKept as number) > 0.6);
    return report.output();
  },
};
