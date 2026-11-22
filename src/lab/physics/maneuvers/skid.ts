/**
 * "A SKID IS ALWAYS CATCHABLE" maneuvers of the standard suite — the
 * accidents and panic inputs the verifier of the drift round found with raw
 * stick probes and that no suite check covered. Raw inputs only (a fixed or
 * scripted stick and trigger): no driver model in the loop. No scorecard
 * weight (totals stay comparable); every check is listed under "failing
 * checks" when it breaks.
 *
 *   bumped     the car is knocked sideways and the player just keeps the
 *              trigger down: stick CENTRED, throttle held, imposed slides of
 *              15 / 25 / 40 deg at 8-18 m/s (also at 30-120 Hz), and one
 *              wheel onto a rock with the foot down — it must straighten and
 *              keep (roughly) its heading, not be turned round
 *   lateCatch  the other input order of "full opposite lock + floor it": the
 *              player LIFTS when the tail steps out, then goes to full
 *              opposite lock and full throttle together (0.25 / 0.4 s later)
 *              and holds both — the slide must end and stay ended, not flip
 *              into a held slide the other way
 *   stuck      a centre hit on a game-sized rock: the car must either drive
 *              off it with the pedals the player would use, or `needsRescue`
 *              must say so — never sit there with no way out and no signal
 *
 * Everything is a RIGHT-hand situation: `slide` (deg) is positive with the
 * tail out in a right turn, stick + = INTO the turn, - = opposite lock.
 */
import { needsRescue } from '../../../car/createVehicle';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import type { WorldSpec } from '../world';
import { Watchdog, runWatched } from '../extra-raycast/kit';
import { FLAT, Report, mean, runCase } from './common';
import type { ManeuverDef } from './common';

type Metrics = Record<string, MetricValue>;

const RATES = [30, 72, 90, 120];

/** Slip angle of the rear axle, deg, + = tail out in a right turn. */
function rearSlide(sim: Sim): number {
  const tel = sim.tel;
  if (tel.speed < 1.5) return 0;
  return -Math.atan2(tel.vLat - tel.yawRate * 0.5 * sim.vehicle.wheelbase, Math.max(Math.abs(tel.vFwd), 1)) * DEG;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

// ---------------------------------------------------------------------------
// bumped

/**
 * Imposed slide with NO yaw rate (the car has been knocked sideways: nose
 * `beta0` to the right of where it travels), stick centred, throttle fixed.
 * "Straight" = rear slip under 4 deg and yaw rate under 12 deg/s for 0.3 s.
 * The heading change is counted from the heading the car had when it was
 * knocked: a car that straightens along its nose changes it by nothing, one
 * that swings back onto its old course by `beta0`, one that is turned round
 * by 90-180 deg.
 */
export async function bumpedCase(env: LabEnv, v0: number, beta0Deg: number, throttle: number, dt: number = env.dt, tune?: Record<string, number>) {
  const id = `slide.v${v0}.b${beta0Deg}.t${Math.round(throttle * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, v] of Object.entries(tune)) sim.vehicle.setTuning(k, v);
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: 0 });
    sim.useFixed({ throttle, steering: 0 });
    sim.resetTrack();
    const hold = Math.max(1, Math.round(0.3 / sim.dt));
    let calm = 0;
    let straightAt: number | null = null;
    let headingAtStraight: number | null = null;
    let maxHeading = 0;
    let peakSlide = 0;
    await sim.run(5, (tel) => {
      const slide = rearSlide(sim);
      const heading = (tel.yaw - beta0) * DEG;
      if (Math.abs(heading) > maxHeading) maxHeading = Math.abs(heading);
      if (Math.abs(slide) > peakSlide) peakSlide = Math.abs(slide);
      if (straightAt === null) {
        if (Math.abs(slide) < 4 && Math.abs(tel.yawRate) * DEG < 12) {
          if (++calm >= hold) {
            straightAt = tel.t - (hold - 1) * sim.dt;
            headingAtStraight = heading;
          }
        } else {
          calm = 0;
        }
      }
    });
    return {
      speed: v0,
      onsetSlideDeg: beta0Deg,
      throttle,
      straightAfter: straightAt,
      // Heading change by the time the car is straight (all of the run if it
      // never is).
      headingChangeDeg: Math.abs(headingAtStraight ?? maxHeading),
      maxHeadingChangeDeg: maxHeading,
      headingAfter5sDeg: (sim.tel.yaw - beta0) * DEG,
      peakSlideDeg: peakSlide,
      endSpeed: sim.tel.speed,
      lateralUsed: Math.abs(sim.tel.x),
      spun: sim.track.spun,
    };
  }, dt);
}

/**
 * One front wheel onto a rock, hands off, throttle HELD at `throttle`. The
 * heading is followed for 6 s: `kick1s` is the largest heading change within
 * 1 s of the hit, `headingAfter` where the car points in the end.
 */
export async function rockFootDownCase(env: LabEnv, id: string, spec: WorldSpec, zRock: number, v: number, throttle: number, dt: number = env.dt, tune?: Record<string, number>) {
  return runCase(env, id, spec, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, t] of Object.entries(tune)) sim.vehicle.setTuning(k, t);
    sim.place({ x: 0, z: zRock - 1.0 * v, yaw: 0, speed: v });
    sim.useFixed({ throttle, steering: 0 });
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let hitAt: number | null = null;
    let kick1s = 0;
    let maxHeading = 0;
    await runWatched(sim, dog, 7, (s) => {
      const tel = s.tel;
      if (hitAt === null && tel.z > zRock - 1.5) hitAt = tel.t;
      if (hitAt !== null) {
        const heading = Math.abs(tel.yaw) * DEG;
        if (heading > maxHeading) maxHeading = heading;
        if (tel.t - hitAt <= 1 && heading > kick1s) kick1s = heading;
        return tel.t - hitAt >= 6;
      }
      return false;
    });
    return {
      speed: v,
      throttle,
      kickWithin1sDeg: kick1s,
      maxHeadingDeg: maxHeading,
      headingAfterDeg: Math.abs(sim.tel.yaw) * DEG,
      maxTiltDeg: sim.track.maxTilt * DEG,
      endsUpright: sim.tel.tilt < 25 * RAD && !sim.track.rolledOver,
      endSpeed: sim.tel.speed,
      ...dog.metrics(),
    };
  }, dt);
}

/** The game's collidable rock (props.ts): sphere of radius 0.85 x scale with
 * its centre 0.1 x scale above the ground. */
export function gameRock(scale: number, x: number, z: number): WorldSpec {
  return { kind: 'flat', obstacles: [{ type: 'boulder', x, z, radius: 0.85 * scale, centerY: 0.1 * scale }] };
}

export const bumped: ManeuverDef = {
  name: 'bumped',
  title: 'bumped: knocked sideways with the stick centred and the trigger held; one wheel onto a rock with the foot down',
  async run(env) {
    const report = new Report();
    // --- imposed slides, foot flat, stick centred.
    const changes: number[] = [];
    const times: number[] = [];
    const bad: string[] = [];
    let worst = 0;
    let slowest = 0;
    const add = async (v: number, b: number, thr: number, dt?: number) => {
      const c = await bumpedCase(env, v, b, thr, dt);
      delete c.series;
      report.cases.push(c);
      return c;
    };
    for (const v of [8, 11, 14, 18]) {
      const row: string[] = [];
      for (const b of [15, 25, 40]) {
        const c = await add(v, b, 1);
        const m = c.metrics;
        const change = m.headingChangeDeg as number;
        const t = m.straightAfter as number | null;
        changes.push(change);
        if (t !== null) times.push(t);
        worst = Math.max(worst, change);
        slowest = Math.max(slowest, t ?? 99);
        if (m.spun || t === null || t > 1.2 || change > 30) bad.push(c.id.replace('slide.', ''));
        row.push(`${change.toFixed(0)} deg in ${t === null ? 'never' : `${t.toFixed(2)} s`}`);
      }
      report.summary[`floored.v${v}`] = row.join(' | ');
    }
    report.summary.flooredHeadingChangeMeanDeg = mean(changes);
    report.summary.flooredHeadingChangeWorstDeg = worst;
    report.summary.flooredStraightSlowest = slowest;
    report.check('bumped.footDown', bad.length ? `${bad.length} of ${changes.length}: ${bad.join(', ')}` : `mean ${mean(changes).toFixed(0)} deg, worst ${worst.toFixed(0)} deg, straight in ${mean(times).toFixed(2)} s (slowest ${slowest.toFixed(2)} s)`,
      'stick centred, throttle floored, slides of 15 / 25 / 40 deg at 8 / 11 / 14 / 18 m/s: straight within 1.2 s, heading changed by less than 30 deg, no spin', bad.length === 0);

    // --- the same at part throttle and off it (it was always fine there).
    const partBad: string[] = [];
    for (const thr of [0.5, 0]) {
      for (const v of [11, 18]) {
        const c = await add(v, 25, thr);
        const m = c.metrics;
        report.summary[c.id] = `${(m.headingChangeDeg as number).toFixed(0)} deg in ${m.straightAfter === null ? 'never' : `${(m.straightAfter as number).toFixed(2)} s`}`;
        if (m.spun || m.straightAfter === null || (m.straightAfter as number) > 1.2 || (m.headingChangeDeg as number) > 30) partBad.push(c.id.replace('slide.', ''));
      }
    }
    report.check('bumped.partThrottle', partBad.length ? partBad.join(', ') : 'ok', 'the same 25 deg slide at 50 % and 0 % throttle (11 and 18 m/s): straight within 1.2 s, heading changed by less than 30 deg', partBad.length === 0);

    // --- frame rate.
    const rateChanges: number[] = [];
    const rateBad: string[] = [];
    for (const hz of RATES) {
      const c = await add(11, 25, 1, 1 / hz);
      const m = c.metrics;
      rateChanges.push(m.headingChangeDeg as number);
      if (m.spun || m.straightAfter === null || (m.straightAfter as number) > 1.2 || (m.headingChangeDeg as number) > 30) rateBad.push(`${hz} Hz`);
    }
    report.summary.rateHeadingChangeDeg = rateChanges.map((x) => x.toFixed(0)).join(' / ');
    report.check('bumped.everyRate', rateBad.length ? rateBad.join(', ') : `${rateChanges.map((x) => x.toFixed(0)).join(' / ')} deg`, `25 deg at 11 m/s, floored, at ${RATES.join(' / ')} Hz: the same verdict`, rateBad.length === 0);

    // --- one wheel onto a rock with the foot down.
    const wheelX = env.rig ? env.rig.front.track / 2 : 0.84;
    const z = 60;
    const rock70: WorldSpec = { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 }] };
    const after: number[] = [];
    const kicks: number[] = [];
    const rockBad: string[] = [];
    let exploded = false;
    let worstTilt = 0;
    const rock = async (name: string, spec: WorldSpec, v: number, thr: number) => {
      const c = await rockFootDownCase(env, `${name}.v${Math.round(v)}.t${Math.round(thr * 100)}`, spec, z, v, thr);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      after.push(m.headingAfterDeg as number);
      kicks.push(m.kickWithin1sDeg as number);
      worstTilt = Math.max(worstTilt, m.maxTiltDeg as number);
      if (m.exploded) exploded = true;
      if (!m.endsUpright || (m.maxHeadingDeg as number) >= 60) rockBad.push(c.id);
      report.summary[c.id] = `kick ${(m.kickWithin1sDeg as number).toFixed(0)} deg within 1 s, ${(m.headingAfterDeg as number).toFixed(0)} deg off after 6 s (max ${(m.maxHeadingDeg as number).toFixed(0)}), tilt ${(m.maxTiltDeg as number).toFixed(0)} deg${m.endsUpright ? '' : ' OFF ITS WHEELS'}`;
    };
    for (const thr of [1, 0.5]) for (const v of [20, 24.5]) await rock('rock70', rock70, v, thr);
    for (const scale of [0.7, 1.0]) for (const v of [12, 18, 24]) await rock(`gameRock${Math.round(scale * 100)}`, gameRock(scale, -wheelX, z), v, 1);
    report.summary.rockHeadingAfterMedianDeg = median(after);
    report.summary.rockHeadingAfterWorstDeg = Math.max(...after);
    report.summary.rockKickMedianDeg = median(kicks);
    report.summary.rockWorstTiltDeg = worstTilt;
    report.check('bumped.rockFootDown', rockBad.length ? `${rockBad.length} of ${after.length} turned round: ${rockBad.join(', ')}` : `median ${median(after).toFixed(0)} deg, worst ${Math.max(...after).toFixed(0)} deg off after 6 s`,
      'one wheel onto a 0.7 m rock (20 / 24.5 m/s, 100 and 50 % throttle) and onto game rocks of scale 0.7 / 1.0 (12 / 18 / 24 m/s, floored), hands off: never turned more than 60 deg off its course in the 6 s after the hit, ends on its wheels', rockBad.length === 0);
    report.check('bumped.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// lateCatch

/**
 * Imposed slide (nose `beta0` inside the direction of travel, still rotating
 * in). The player LIFTS at once (throttle 0, stick centred); after the
 * reaction time the thumb goes to full opposite lock and the foot to the
 * floor TOGETHER, and both stay there.
 */
export async function lateCatchCase(env: LabEnv, v0: number, beta0Deg: number, react: number, dt: number = env.dt, tune?: Record<string, number>) {
  const id = `late.v${v0}.b${beta0Deg}.d${Math.round(react * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, v] of Object.entries(tune)) sim.vehicle.setTuning(k, v);
    const beta0 = beta0Deg * RAD;
    sim.place({ x: 0, z: 0, yaw: beta0, speed: v0, beta: -beta0, yawRate: beta0 });
    sim.useFixed({ throttle: 0, steering: 0 });
    sim.useScript([{ t: 0, throttle: 0, steering: 0, brake: 0 }, { t: react, steering: -1, throttle: 1 }]);
    sim.resetTrack();
    const rear: number[] = [];
    let slideAtAction = 0;
    await sim.run(5, (tel) => {
      rear.push(rearSlide(sim));
      if (Math.abs(tel.t - react) < sim.dt / 2) slideAtAction = rearSlide(sim);
    });
    let wrongWay = 0;
    let stays: number | null = null;
    for (let i = 0; i < rear.length; i++) {
      if (-rear[i] > wrongWay) wrongWay = -rear[i];
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
      reaction: react,
      slideWhenStickMovesDeg: slideAtAction,
      straightAfter: stays === null ? null : Math.max(0, stays - react),
      wrongWayRearDeg: wrongWay,
      endRearSlideDeg: mean(rear.slice(-tail)),
      endYawRateDeg: sim.tel.yawRate * DEG,
      endSpeed: sim.tel.speed,
      spun: sim.track.spun,
    };
  }, dt);
}

/**
 * The pendulum flick — the one deliberate input that looks like a late
 * catch: from a straight, a short opposite flick with the foot off
 * (`flick` s of full stick the WRONG way), then full lock into the corner
 * and full throttle, both held. It must still start a slide INTO the corner.
 */
export async function flickCase(env: LabEnv, v0: number, flick: number, dt: number = env.dt, tune?: Record<string, number>) {
  const id = `flick.v${v0}.f${Math.round(flick * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, v] of Object.entries(tune)) sim.vehicle.setTuning(k, v);
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 0.4, steering: 0 });
    await sim.run(0.3);
    sim.useScript([{ t: 0, throttle: 0, steering: -1, brake: 0 }, { t: flick, steering: 1, throttle: 1 }]);
    sim.resetTrack();
    const t0 = sim.time;
    let peak = 0;
    let firstSwing = 0;
    let to15: number | null = null;
    const late: number[] = [];
    await sim.run(4, (tel) => {
      const t = tel.t - t0;
      const slide = rearSlide(sim);
      if (-slide > firstSwing) firstSwing = -slide;
      if (t > flick) {
        if (slide > peak) peak = slide;
        if (to15 === null && slide >= 15) to15 = t - flick;
        if (t >= 2 && t <= 3) late.push(slide);
      }
    });
    return {
      speed: v0,
      flick,
      firstSwingDeg: firstSwing,
      peakSlideDeg: peak,
      timeTo15Deg: to15,
      heldSlideDeg: mean(late),
      endSpeed: sim.tel.speed,
      spun: sim.track.spun,
    };
  }, dt);
}

/**
 * The pendulum flick as a player does it with the foot half in (the
 * verification probe of 2026-11, reproduced exactly): at `v0` with the stick
 * already full the WRONG way and half throttle, 0.25 s later full lock into
 * the corner and full throttle, after 2 s eased to 75 % stick / 80 %
 * throttle. Its first swing (5-8 deg of rear slip) is the one the catch
 * latch must not take for a slide being caught. Works = the tail is out
 * past 15 deg and still held at 10+ deg from 2.5 to 4 s.
 */
export async function halfFlickCase(env: LabEnv, v0: number, dt: number = env.dt, tune?: Record<string, number>) {
  const id = `flick.v${v0}.half${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, v] of Object.entries(tune)) sim.vehicle.setTuning(k, v);
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    sim.useFixed({ throttle: 0.5, steering: -1, brake: 0 });
    sim.useScript([{ t: 0, throttle: 0.5, steering: -1, brake: 0 }, { t: 0.25, throttle: 1, steering: 1 }, { t: 2, throttle: 0.8, steering: 0.75 }]);
    sim.resetTrack();
    const t0 = sim.time;
    let peak = 0;
    let firstSwing = 0;
    const late: number[] = [];
    await sim.run(4, (tel) => {
      const t = tel.t - t0;
      const slide = rearSlide(sim);
      if (-slide > firstSwing) firstSwing = -slide;
      if (t > 0.25 && slide > peak) peak = slide;
      if (t >= 2.5) late.push(slide);
    });
    return { speed: v0, flick: 0.25, firstSwingDeg: firstSwing, peakSlideDeg: peak, heldSlideDeg: mean(late), endSpeed: sim.tel.speed, spun: sim.track.spun };
  }, dt);
}

function lateOk(m: Metrics): boolean {
  return m.spun === false && typeof m.straightAfter === 'number' && m.straightAfter <= 1.5 && (m.wrongWayRearDeg as number) < 10;
}

export const lateCatch: ManeuverDef = {
  name: 'lateCatch',
  title: 'lateCatch: lift when the tail steps out, THEN full opposite lock + full throttle together, both held',
  async run(env) {
    const report = new Report();
    const fails: string[] = [];
    let total = 0;
    let worstWrong = 0;
    const add = async (v: number, b: number, react: number, dt?: number) => {
      const c = await lateCatchCase(env, v, b, react, dt);
      delete c.series;
      report.cases.push(c);
      total++;
      worstWrong = Math.max(worstWrong, c.metrics.wrongWayRearDeg as number);
      if (!lateOk(c.metrics)) fails.push(c.id.replace('late.', ''));
      return c.metrics;
    };
    for (const v of [12, 15, 18]) {
      for (const react of [0.25, 0.4]) {
        const row: string[] = [];
        for (const b of [10, 20, 35, 50]) {
          const m = await add(v, b, react);
          row.push(`${typeof m.straightAfter === 'number' ? `${m.straightAfter.toFixed(2)} s` : 'never'} / far ${(m.wrongWayRearDeg as number).toFixed(0)}`);
        }
        report.summary[`v${v}.d${Math.round(react * 100)}`] = row.join(' | ');
      }
    }
    for (const hz of RATES) await add(15, 35, 0.4, 1 / hz);
    report.summary.worstFarSideDeg = worstWrong;
    // The flick must survive the catch latch's memory.
    const flicks: string[] = [];
    let flickBest = 0;
    // (the half-throttle flick is counted on its own as well: it is the one
    // the latch used to swallow on neon-wasp)
    let halfBest = 0;
    const halfAt: number[] = [];
    for (const v of [8, 10, 12, 14, 16]) {
      const row: string[] = [];
      for (const f of [0, 0.25, 0.4, -1]) {
        // (f = -1: the half-throttle flick, halfFlickCase)
        const c = f < 0 ? await halfFlickCase(env, v) : await flickCase(env, v, f);
        delete c.series;
        report.cases.push(c);
        const m = c.metrics;
        const works = (m.peakSlideDeg as number) >= 15 && (m.heldSlideDeg as number) >= 10 && !m.spun;
        if (works) flickBest = Math.max(flickBest, v);
        if (works && f < 0) {
          halfBest = Math.max(halfBest, v);
          halfAt.push(v);
        }
        row.push(`first swing ${(m.firstSwingDeg as number).toFixed(0)}, then ${(m.peakSlideDeg as number).toFixed(0)} deg (held ${(m.heldSlideDeg as number).toFixed(0)})`);
      }
      flicks.push(`${v} m/s: ${row.join(' / ')}`);
      report.summary[`flick.v${v}`] = row.join(' / ');
    }
    report.summary.flickWorksUpTo = flickBest;
    report.summary.halfThrottleFlickWorksAt = halfAt.join(' / ') || 'none';
    report.check('lateCatch.flick.info', flickBest > 0 ? `up to ${flickBest} m/s` : 'at no speed', 'info: from a straight — full lock + full throttle together, also after a 0.25 / 0.4 s opposite flick off the throttle (and a 0.25 s one at half throttle): the tail comes out INTO the corner (15 deg, held at 10+) — highest of 8 / 10 / 12 / 14 / 16 m/s (the catch latch must not take a flick for a catch)', true);
    report.check('lateCatch.flick.halfThrottle.info', halfBest > 0 ? `at ${halfAt.join(' / ')} m/s` : 'at no speed', 'info: 0.25 s opposite flick at HALF throttle, then full lock + full throttle: speeds (8-16 m/s) at which it starts a held slide', true);
    // neon-wasp's per-car catch latch (handling.ts) exists for exactly this
    // flick: gated there at 60 Hz and above (at 30 Hz the 10 m/s flick fails
    // with the latch switched off as well — the car, a known limit).
    if (env.carId === 'neon-wasp' && env.dt <= 1 / 59) {
      report.check('lateCatch.flick.halfThrottle', halfAt.length ? `at ${halfAt.join(' / ')} m/s` : 'at no speed',
        'neon-wasp, >= 60 Hz: the half-throttle flick starts a held slide at 8 AND 10 m/s (before its latch values: at no speed)', halfAt.includes(8) && halfAt.includes(10));
    }
    report.check('lateCatch.staysCaught', fails.length ? `${fails.length} of ${total}: ${fails.join(', ')}` : `0 of ${total} fail, far side at most ${worstWrong.toFixed(1)} deg`,
      'slides of 10 / 20 / 35 / 50 deg at 12 / 15 / 18 m/s: lift, then (0.25 / 0.4 s later) full opposite lock + full throttle held: straight within 1.5 s of the stick moving, rear under 10 deg the other way, no spin (30-120 Hz)', fails.length === 0);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// stuck

function loadedWheels(sim: Sim): number {
  let n = 0;
  for (const w of sim.vehicle.wheelStates) if (w.grounded) n++;
  return n;
}

/**
 * Straight at a game-sized rock, centred or 0.3 m off, throttle held. If the
 * car comes to rest on or against it, the player's own way out is tried
 * while `needsRescue` is polled every frame, exactly as the game would:
 * throttle held 2 s more, then reverse for 3 s, then throttle with full lock
 * for 3 s. "Free" = clear of the rock by 4 m with at least three wheels
 * carrying and moving.
 */
export async function stuckCase(env: LabEnv, scale: number, v: number, offset: number, dt: number = env.dt, tune?: Record<string, number>, ball = false) {
  const id = `${ball ? 'ball' : 'rock'}${Math.round(scale * 100)}.v${v}.x${Math.round(offset * 100)}${dt === env.dt ? '' : `.hz${Math.round(1 / dt)}`}`;
  const zRock = 40;
  // `ball`: a steeper, ball-shaped rock (radius 0.6 x scale, centre 0.3 x
  // scale up: 0.9 m tall at scale 1) — harsher than anything the game
  // scatters; `offset` is then where the rock sits (under a wheel).
  const spec: WorldSpec = ball
    ? { kind: 'flat', obstacles: [{ type: 'boulder', x: offset, z: zRock, radius: 0.6 * scale, centerY: 0.3 * scale }] }
    : gameRock(scale, offset, zRock);
  return runCase(env, id, spec, async (sim): Promise<Metrics> => {
    if (tune) for (const [k, t] of Object.entries(tune)) sim.vehicle.setTuning(k, t);
    sim.place({ x: 0, z: zRock - 1.0 * v, yaw: 0, speed: v });
    sim.useFixed({ throttle: 1, steering: 0 });
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let rescueAt: number | null = null;
    let slow = 0;
    let stoppedAt: number | null = null;
    const poll = (s: Sim) => {
      if (rescueAt === null && needsRescue(s.vehicle, s.dt)) rescueAt = s.tel.t;
    };
    const clear = (s: Sim) => Math.hypot(s.tel.x - offset, s.tel.z - zRock) > 4 + 0.85 * scale && loadedWheels(s) >= 3 && s.tel.speed > 2;
    // Phase 1: the hit, throttle held.
    await runWatched(sim, dog, 5, (s) => {
      poll(s);
      slow = s.tel.speed < 0.7 && s.tel.t > 0.5 ? slow + s.dt : 0;
      if (slow > 1.0 && stoppedAt === null) stoppedAt = s.tel.t;
      return stoppedAt !== null || (s.tel.t > 1.5 && clear(s));
    });
    if (stoppedAt === null) {
      return { scale, speed: v, offset, stopped: false, freed: true, freedBy: 'did not stop', rescueFiredAfter: null, tiltDeg: sim.tel.tilt * DEG, wheelsLoaded: loadedWheels(sim), maxTiltDeg: sim.track.maxTilt * DEG, ...dog.metrics() };
    }
    const tilt = sim.tel.tilt * DEG;
    const wheels = loadedWheels(sim);
    // Phase 2: the player's way out, rescue polled throughout.
    let freedBy: string | null = null;
    const phase = async (name: string, seconds: number, intent: { throttle?: number; brake?: number; steering?: number }) => {
      if (freedBy !== null) return;
      sim.useFixed({});
      await runWatched(sim, dog, 0.15, poll);
      sim.useFixed(intent);
      const freed = await runWatched(sim, dog, seconds, (s) => {
        poll(s);
        return clear(s);
      });
      if (freed) freedBy = name;
    };
    await phase('throttle', 2, { throttle: 1 });
    await phase('reverse', 3, { brake: 1 });
    await phase('throttle + full lock', 3, { throttle: 1, steering: 1 });
    await phase('reverse + full lock', 3, { brake: 1, steering: -1 });
    return {
      scale, speed: v, offset,
      stopped: true,
      freed: freedBy !== null,
      freedBy: freedBy ?? 'no',
      rescueFiredAfter: rescueAt === null ? null : rescueAt - stoppedAt,
      tiltDeg: tilt,
      wheelsLoaded: wheels,
      maxTiltDeg: sim.track.maxTilt * DEG,
      ...dog.metrics(),
    };
  }, dt);
}

export const stuck: ManeuverDef = {
  name: 'stuck',
  title: 'stuck: centre hit on a game-sized rock — the car drives off it, or needsRescue says it cannot',
  async run(env) {
    const report = new Report();
    let stopped = 0;
    let freed = 0;
    let rescued = 0;
    let total = 0;
    let exploded = false;
    const lost: string[] = [];
    const stoppedIds: string[] = [];
    for (const scale of [0.85, 1.0, 1.15]) {
      for (const v of [10, 16, 24]) {
        for (const offset of [0, 0.3]) {
          const c = await stuckCase(env, scale, v, offset);
          delete c.series;
          report.cases.push(c);
          const m = c.metrics;
          total++;
          if (m.exploded) exploded = true;
          if (!m.stopped) continue;
          stopped++;
          const id = c.id;
          stoppedIds.push(`${id} (tilt ${(m.tiltDeg as number).toFixed(0)} deg, ${m.wheelsLoaded} wheels: ${m.freed ? `off by ${m.freedBy}` : m.rescueFiredAfter !== null ? `rescue after ${(m.rescueFiredAfter as number).toFixed(1)} s` : 'NO WAY OUT'})`);
          if (m.freed) freed++;
          else if (m.rescueFiredAfter !== null) rescued++;
          else lost.push(id);
        }
      }
    }
    // A steeper, ball-shaped 0.9 m rock under one front wheel (harsher than
    // the game's rocks): the car may be thrown about, but must not end up
    // propped against it with no way out.
    const wheelX = env.rig ? env.rig.front.track / 2 : 0.84;
    for (const v of [10, 16, 24]) {
      const c = await stuckCase(env, 1, v, -wheelX, env.dt, undefined, true);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      total++;
      if (m.exploded) exploded = true;
      report.summary[c.id] = m.stopped ? `stopped (tilt ${(m.tiltDeg as number).toFixed(0)} deg, ${m.wheelsLoaded} wheels): ${m.freed ? `off by ${m.freedBy}` : m.rescueFiredAfter !== null ? `rescue after ${(m.rescueFiredAfter as number).toFixed(1)} s` : 'NO WAY OUT'}` : `drove on, max tilt ${(m.maxTiltDeg as number).toFixed(0)} deg`;
      if (!m.stopped) continue;
      stopped++;
      if (m.freed) freed++;
      else if (m.rescueFiredAfter !== null) rescued++;
      else lost.push(c.id);
    }
    report.summary.cases = total;
    report.summary.stoppedOnTheRock = stopped;
    report.summary.droveOff = freed;
    report.summary.rescueFired = rescued;
    report.summary.noWayOut = lost.length;
    report.summary.stoppedCases = stoppedIds.join(' | ') || 'none';
    report.check('stuck.neverStranded', lost.length ? `${lost.length} of ${stopped} stranded: ${lost.join(', ')}` : `${stopped} of ${total} stopped on the rock: ${freed} drove off, ${rescued} rescued`,
      'game rocks of scale 0.85 / 1.0 / 1.15 hit centred or 0.3 m off, and a steeper 0.9 m ball rock under one wheel, at 10 / 16 / 24 m/s with the throttle held: a car that comes to rest on the rock drives off it (throttle, reverse, throttle + lock, reverse + lock) or needsRescue fires', lost.length === 0);
    // The player should not NEED the rescue: with the unstick assist the held
    // pedal gets the car off (tuning.unstickAccel).
    report.check('stuck.drivesOff', `${freed} of ${stopped} drove off, ${rescued} needed the rescue`, 'at most 1 of the cars that came to rest on a rock needs the rescue instead of driving off', rescued + lost.length <= 1);
    report.check('stuck.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

export const SKID_MANEUVERS: ManeuverDef[] = [bumped, lateCatch, stuck];
