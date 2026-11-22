/**
 * LINKED DRIFTS — the S-bend half of "drifting shall be possible, but it
 * should still be possible to react and straighten a car that has begun
 * skidding". Raw scripted sticks and triggers only (no lab driver).
 *
 *   driftLink      a held RIGHT drift, then a drift to the LEFT:
 *                  - throttle: full left lock, foot flat (at once, and after
 *                    0.3 s with the stick centred)
 *                  - brake tap: full left + 0.3 s brake, then floor it (at
 *                    once, and after 0.5 s with the stick centred)
 *                  - after a CATCH: an imposed slide caught with full opposite
 *                    lock at 30 % throttle (the catch latch holds the rear), then a
 *                    brake tap with the stick still over, then floor it
 *   overHeldCatch  panic opposite lock that is never let go of: it must not
 *                  turn into a spin or a tank-slapper —
 *                  - an imposed (unfed) slide: lift, then full opposite lock
 *                    + floor held 5 s: stays caught (< 10 deg the other way)
 *                  - a held drift: full opposite lock + floor held 5 s: at
 *                    most ONE change of side (a drift the other way is what
 *                    stick and throttle ask for), no swing back, no spin
 *                  - a held drift: the same for 0.6 s, then the stick let go
 *                    (foot down): straight again within 1.5 s
 *                  - a SKID fed for a moment only (0.2 s of stick-in + floor
 *                    at its start, then lift, or stick centred with the foot
 *                    flat), full opposite lock + floor 0.7 s later: stays
 *                    caught (< 10 deg the other way) — the held-drift clock
 *                    must count fed time, not time since first fed
 *                  - a catch that uses the BRAKE (lift + full opposite lock
 *                    + full brake 0.3 s, then floor it; a floored catch with
 *                    a 0.3 s brake stab 0.45 s in): stays caught — a brake
 *                    inside a catch is not the brake-tap entry. Not covered:
 *                    a brake EDGE 0.5 s or more after the rear grips, lock
 *                    still on, IS the entry, even with the throttle floored
 *                    (reef-rocket and neon-wasp then drift the other way)
 *
 * Everything starts as a RIGHT-hand situation: `rear` (deg) is the rear
 * axle's slip angle (all angles and link times here are rear-axle numbers;
 * in the xdTrace probes body slip reaches 15 deg 0.2-0.45 s later), + = tail out in a right turn; the new drift is negative.
 * Stick + = right. No scorecard weight; the checks are gates.
 */
import { handlingFor } from '../../../car/handling';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { FLAT, Report, mean, runCase } from './common';
import type { ManeuverDef } from './common';

type Metrics = Record<string, MetricValue>;

/** Slip angle of the rear axle, deg, + = tail out in a right turn. */
function rearSlide(sim: Sim): number {
  const tel = sim.tel;
  if (tel.speed < 1.5) return 0;
  return -Math.atan2(tel.vLat - tel.yawRate * 0.5 * sim.vehicle.wheelbase, Math.max(Math.abs(tel.vFwd), 1)) * DEG;
}

const DRIFT_CENTRIPETAL = 0.65;

/** A held right drift: imposed 25 deg at 15 m/s on its arc, then 2 s of 3/4
 * stick into the turn at 80 % throttle (the car settles into its own drift:
 * rear axle 28-29 deg at 15-16 m/s on all four cars — the entry of
 * slideCatch's lift cases). */
async function holdRightDrift(sim: Sim): Promise<number> {
  const b = 25 * RAD;
  sim.place({ x: 0, z: 0, yaw: b, speed: 15, beta: -b, yawRate: (DRIFT_CENTRIPETAL * sim.mug) / 15 });
  sim.useFixed({ throttle: 0.8, steering: 0.75 });
  await sim.run(2.0);
  return rearSlide(sim);
}

/** Watches the switch from the right slide to a left one. Times count from
 * `t0` (the moment the thumb starts to move). */
class SwitchWatch {
  /** Old slide through straight (rear < 0). */
  zero: number | null = null;
  /** New drift reaches 15 deg (rear <= -15). */
  left15: number | null = null;
  peakLeft = 0;
  /** After the new drift reached 10 deg: the deepest swing BACK to the
   * original side (a tank-slapper). */
  backSwing = 0;
  private reachedLeft = false;
  readonly window: number[] = [];
  readonly t0: number;
  private readonly from: number;
  private readonly to: number;
  constructor(t0: number, windowFrom: number, windowTo: number) {
    this.t0 = t0;
    this.from = windowFrom;
    this.to = windowTo;
  }
  step(t: number, rear: number): void {
    const s = t - this.t0;
    if (this.zero === null && rear < 0) this.zero = s;
    if (this.left15 === null && rear <= -15) this.left15 = s;
    if (-rear > this.peakLeft) this.peakLeft = -rear;
    if (rear <= -10) this.reachedLeft = true;
    if (this.reachedLeft && rear > this.backSwing) this.backSwing = rear;
    if (s >= this.from && s <= this.to) this.window.push(-rear);
  }
  metrics(): Metrics {
    return {
      throughStraightAfter: this.zero,
      newDrift15After: this.left15,
      zeroTo15: this.zero !== null && this.left15 !== null ? this.left15 - this.zero : null,
      newDriftPeakDeg: this.peakLeft,
      newDriftHeldDeg: this.window.length ? mean(this.window) : null,
      backSwingDeg: this.backSwing,
    };
  }
}

type LinkKind = 'throttle' | 'throttleCentre' | 'brake' | 'brakeCentre';

/**
 * A held right drift, then a drift to the left:
 *   throttle        full left lock, foot flat, at once
 *   throttleCentre  stick centred 0.3 s (foot flat), then full left lock
 *   brake           full left + brake 0.6 for 0.3 s (throttle off), then floor
 *   brakeCentre     stick centred 0.5 s (foot flat), then as `brake`
 */
async function linkCase(env: LabEnv, kind: LinkKind) {
  return runCase(env, `link.${kind}`, FLAT, async (sim): Promise<Metrics> => {
    const entry = await holdRightDrift(sim);
    const entrySpeed = sim.tel.speed;
    const pause = kind === 'throttleCentre' ? 0.3 : kind === 'brakeCentre' ? 0.5 : 0;
    const keys = [];
    if (pause > 0) keys.push({ t: 0, steering: 0, throttle: 1, brake: 0 });
    if (kind === 'throttle' || kind === 'throttleCentre') {
      keys.push({ t: pause, steering: -1, throttle: 1, brake: 0 });
    } else {
      keys.push({ t: pause, steering: -1, throttle: 0, brake: 0.6 }, { t: pause + 0.3, brake: 0, throttle: 1 });
    }
    sim.useScript(keys);
    sim.resetTrack();
    // Times count from the moment the stick starts for the left lock.
    const watch = new SwitchWatch(sim.time + pause, 2.0, 3.5);
    await sim.run(pause + 3.5, (tel) => {
      watch.step(tel.t, rearSlide(sim));
    });
    return { kind, entryRearDeg: entry, entrySpeed, pause, ...watch.metrics(), endSpeed: sim.tel.speed, spun: sim.track.spun };
  });
}

/**
 * After a CATCH: an imposed, unfed 35 deg slide at 15 m/s (as lateCatch:
 * lift, 0.25 s later full opposite lock and the foot back in, here at 30 %
 * throttle so the car stays near drift speed (18-20 m/s at the tap; at 50 %
 * or floored it reaches 21-26 m/s, where a 0.3 s brake tap starts no slide
 * on riot-ram and comet-fox with the latch switched off as well — the car),
 * held 1.5 s — the catch latch keeps the rear
 * gripping and the car turns left on its tires — then a 0.3 s brake tap with
 * the stick still full left, then floor it.
 */
async function catchThenTapCase(env: LabEnv) {
  return runCase(env, 'link.afterCatch.brake', FLAT, async (sim): Promise<Metrics> => {
    const b = 35 * RAD;
    sim.place({ x: 0, z: 0, yaw: b, speed: 15, beta: -b, yawRate: b });
    sim.useFixed({ throttle: 0, steering: 0 });
    sim.useScript([{ t: 0, throttle: 0, steering: 0, brake: 0 }, { t: 0.25, steering: -1, throttle: 0.3 }]);
    await sim.run(1.75);
    const caughtRear = rearSlide(sim);
    const speedAtTap = sim.tel.speed;
    sim.useScript([{ t: 0, steering: -1, throttle: 0, brake: 0.6 }, { t: 0.3, brake: 0, throttle: 1 }]);
    sim.resetTrack();
    const watch = new SwitchWatch(sim.time, 2.0, 3.5);
    await sim.run(3.5, (tel) => {
      watch.step(tel.t, rearSlide(sim));
    });
    return { caughtRearDeg: caughtRear, speedAtTap, ...watch.metrics(), endSpeed: sim.tel.speed, spun: sim.track.spun };
  });
}

function linkOk(m: Metrics, zeroTo15Max: number): boolean {
  return m.spun === false && typeof m.newDrift15After === 'number' && typeof m.zeroTo15 === 'number' && m.zeroTo15 <= zeroTo15Max &&
    typeof m.newDriftHeldDeg === 'number' && m.newDriftHeldDeg >= 10 && m.newDriftHeldDeg <= 45 && (m.backSwingDeg as number) < 10;
}

function linkText(m: Metrics): string {
  const f = (v: MetricValue) => (typeof v === 'number' ? `${v.toFixed(2)} s` : 'never');
  return `${m.spun ? 'SPIN ' : ''}straight ${f(m.throughStraightAfter)}, 15 deg left ${f(m.newDrift15After)} (${f(m.zeroTo15)} after straight), held ${typeof m.newDriftHeldDeg === 'number' ? m.newDriftHeldDeg.toFixed(0) : '-'} deg, back-swing ${(m.backSwingDeg as number).toFixed(1)} deg`;
}

/** The cars expected to link on the throttle alone: those whose preset
 * declares a power-over at 15 m/s (riot-ram, by design, slides only with a
 * brake tap or a lift-flick). */
function powersOver(env: LabEnv): boolean {
  const trait = (env.handling ? handlingFor(env.carId)?.powerOver : undefined) ?? handlingFor('reef-rocket')?.powerOver;
  return !trait || trait.v15[1] >= 15;
}

export const driftLink: ManeuverDef = {
  name: 'driftLink',
  title: 'linked drifts: a held right drift, then a left one by throttle + stick, by a brake tap, and a brake tap after a caught slide',
  async run(env) {
    const report = new Report();
    const by: Record<string, Metrics> = {};
    for (const kind of ['throttle', 'throttleCentre', 'brake', 'brakeCentre'] as const) {
      const c = await linkCase(env, kind);
      delete c.series;
      report.cases.push(c);
      by[kind] = c.metrics;
      report.summary[c.id] = linkText(c.metrics);
    }
    const after = await catchThenTapCase(env);
    delete after.series;
    report.cases.push(after);
    by.afterCatch = after.metrics;
    report.summary[after.id] = linkText(after.metrics);
    const zeroMax = 0.5;
    const target = `the new drift reaches 15 deg within ${zeroMax} s of the old slide passing through straight, is held at 10-45 deg 2-3.5 s after the stick moved, no swing back past 10 deg, no spin`;
    if (powersOver(env)) {
      for (const kind of ['throttle', 'throttleCentre'] as const) {
        report.check(`driftLink.${kind}`, linkText(by[kind]), `${kind === 'throttle' ? 'full left lock + foot flat at once' : 'stick centred 0.3 s, then full left lock, foot flat'}: ${target}`, linkOk(by[kind], zeroMax));
      }
    } else {
      report.check('driftLink.throttle.info', linkText(by.throttle), 'info: this car declares no power-over at 15 m/s (handling.ts) — throttle-only linking is not expected', true);
    }
    // (a brake tap is a slower start than a power-over: 0.7-0.9 s to 15 deg
    // from a straight car in driftInitiate — judged from the stick moving)
    const brakeMax = 1.2;
    for (const kind of ['brake', 'brakeCentre'] as const) {
      const m = by[kind];
      const ok = m.spun === false && typeof m.newDrift15After === 'number' && (m.newDrift15After as number) <= brakeMax &&
        typeof m.newDriftHeldDeg === 'number' && m.newDriftHeldDeg >= 10 && m.newDriftHeldDeg <= 45 && (m.backSwingDeg as number) < 10;
      report.check(`driftLink.${kind}`, linkText(m), `${kind === 'brake' ? 'full left + 0.3 s brake tap at once' : 'stick centred 0.5 s, then full left + 0.3 s brake tap'}, then floor it: 15 deg left within ${brakeMax} s of the stick moving, held at 10-45 deg, no swing back, no spin`, ok);
    }
    {
      const m = by.afterCatch;
      const ok = m.spun === false && typeof m.newDrift15After === 'number' && (m.newDrift15After as number) <= brakeMax &&
        typeof m.newDriftHeldDeg === 'number' && m.newDriftHeldDeg >= 10 && m.newDriftHeldDeg <= 45;
      report.check('driftLink.afterCatch.brake', linkText(m), `a 35 deg slide caught with full opposite lock at 30 % throttle (latched), 1.5 s later a 0.3 s brake tap with the stick still over, then floor it: 15 deg the new way within ${brakeMax} s of the tap, held at 10-45 deg, no spin`, ok);
    }
    return report.output();
  },
};

type HeldKind = 'unfed' | 'held' | 'heldLetGo' | 'shortFedLift' | 'shortFedFlat' | 'brakeCatch' | 'brakeStab';
type Key = { t: number; steering?: number; throttle?: number; brake?: number };

/** Imposed 35 deg right slide at 15 m/s (as lateCatch): the script and the
 * moment the opposite lock goes on. */
const IMPOSED: Partial<Record<HeldKind, { keys: Key[]; move: number }>> = {
  unfed: { keys: [{ t: 0, throttle: 0, steering: 0, brake: 0 }, { t: 0.25, steering: -1, throttle: 1 }], move: 0.25 },
  shortFedLift: { keys: [{ t: 0, throttle: 1, steering: 1, brake: 0 }, { t: 0.2, throttle: 0, steering: 0 }, { t: 0.9, throttle: 1, steering: -1 }], move: 0.9 },
  shortFedFlat: { keys: [{ t: 0, throttle: 1, steering: 1, brake: 0 }, { t: 0.2, throttle: 1, steering: 0 }, { t: 0.9, throttle: 1, steering: -1 }], move: 0.9 },
  brakeCatch: { keys: [{ t: 0, throttle: 0.3, steering: 0, brake: 0 }, { t: 0.25, throttle: 0, steering: -1, brake: 1 }, { t: 0.55, throttle: 1, brake: 0 }], move: 0.25 },
  brakeStab: { keys: [{ t: 0, throttle: 1, steering: 0, brake: 0 }, { t: 0.25, steering: -1 }, { t: 0.7, brake: 1 }, { t: 1.0, brake: 0 }], move: 0.25 },
};

/**
 *   unfed        imposed 35 deg slide at 15 m/s, lift, 0.25 s later full
 *                opposite lock + floor, both held 5 s (as lateCatch)
 *   held         a held right drift, then full opposite lock + floor held 5 s
 *   heldLetGo    the same for 0.6 s, then the stick centred (foot still flat)
 *   shortFedLift imposed 35 deg slide, stick in + floor for 0.2 s, lift +
 *                centre, full opposite lock + floor at 0.9 s, held
 *   shortFedFlat the same with the foot kept flat and the stick centred
 *   brakeCatch   imposed slide, lift, 0.25 s full opposite lock + full brake
 *                for 0.3 s, then floor it with the lock still on
 *   brakeStab    imposed slide, floored, full opposite lock at 0.25 s, a
 *                full brake stab 0.7-1.0 s, the lock and the throttle kept
 */
async function overHeldCase(env: LabEnv, kind: HeldKind) {
  return runCase(env, `overheld.${kind}`, FLAT, async (sim): Promise<Metrics> => {
    let move = 0;
    const imposed = IMPOSED[kind];
    if (imposed) {
      const b = 35 * RAD;
      sim.place({ x: 0, z: 0, yaw: b, speed: 15, beta: -b, yawRate: b });
      const k0 = imposed.keys[0];
      sim.useFixed({ throttle: k0.throttle, steering: k0.steering, brake: k0.brake });
      sim.useScript(imposed.keys);
      move = imposed.move;
    } else {
      await holdRightDrift(sim);
      const keys: Key[] = [{ t: 0, steering: -1, throttle: 1, brake: 0 }];
      if (kind === 'heldLetGo') keys.push({ t: 0.6, steering: 0 });
      sim.useScript(keys);
    }
    sim.resetTrack();
    const t0 = sim.time;
    const rear: number[] = [];
    const times: number[] = [];
    let maxYaw = 0;
    await sim.run(5, (tel) => {
      rear.push(rearSlide(sim));
      times.push(tel.t - t0);
      if (tel.t - t0 > move) maxYaw = Math.max(maxYaw, Math.abs(tel.yawRate) * DEG);
    });
    // Side changes past 10 deg (a tank-slapper changes side again and again).
    let side = 1;
    let changes = 0;
    let farSide = 0;
    let deepest = 0;
    for (const r of rear) {
      if (r * side < -10) {
        changes++;
        side = -side;
      }
      if (-r > farSide) farSide = -r;
      deepest = Math.max(deepest, Math.abs(r));
    }
    // Straight = from here on |rear| < 5 deg on the original side and < 10
    // the other way, as lateCatch counts it.
    let stays: number | null = null;
    for (let i = 0; i < rear.length; i++) {
      if (rear[i] < 5 && rear[i] > -10) {
        if (stays === null) stays = times[i];
      } else {
        stays = null;
      }
    }
    const letGo = kind === 'heldLetGo' ? 0.6 : move;
    const tail = Math.round(1 / sim.dt);
    return {
      kind,
      sideChanges: changes,
      farSideDeg: farSide,
      deepestDeg: deepest,
      straightAfter: stays === null ? null : Math.max(0, stays - letGo),
      endRearDeg: mean(rear.slice(-tail)),
      maxYawRateDeg: maxYaw,
      endSpeed: sim.tel.speed,
      spun: sim.track.spun,
    };
  });
}

function heldText(m: Metrics): string {
  return `${m.spun ? 'SPIN ' : ''}${m.sideChanges} side change(s), far side ${(m.farSideDeg as number).toFixed(1)} deg, deepest ${(m.deepestDeg as number).toFixed(0)} deg, straight ${typeof m.straightAfter === 'number' ? `${m.straightAfter.toFixed(2)} s` : 'never'}, ends ${(m.endRearDeg as number).toFixed(1)} deg at ${(m.endSpeed as number).toFixed(1)} m/s`;
}

export const overHeldCatch: ManeuverDef = {
  name: 'overHeldCatch',
  title: 'over-held catch: full opposite lock + floor never let go of (an unfed slide, a held drift), and let go after 0.6 s',
  async run(env) {
    const report = new Report();
    const by: Record<string, Metrics> = {};
    for (const kind of ['unfed', 'held', 'heldLetGo', 'shortFedLift', 'shortFedFlat', 'brakeCatch', 'brakeStab'] as const) {
      const c = await overHeldCase(env, kind);
      delete c.series;
      report.cases.push(c);
      by[kind] = c.metrics;
      report.summary[c.id] = heldText(c.metrics);
    }
    const u = by.unfed;
    report.check('overHeldCatch.unfed', heldText(u), 'an imposed 35 deg slide, lift, then full opposite lock + floor held 5 s: straight within 1.5 s, under 10 deg the other way, no spin', u.spun === false && (u.farSideDeg as number) < 10 && typeof u.straightAfter === 'number' && u.straightAfter <= 1.5);
    const h = by.held;
    report.check('overHeldCatch.held', heldText(h), 'a held drift, then full opposite lock + floor held 5 s: at most ONE change of side (into the drift the stick asks for), never deeper than 45 deg, no spin', h.spun === false && (h.sideChanges as number) <= 1 && (h.deepestDeg as number) < 45);
    const g = by.heldLetGo;
    for (const kind of ['shortFedLift', 'shortFedFlat', 'brakeCatch', 'brakeStab'] as const) {
      const m = by[kind];
      const what = {
        shortFedLift: 'an imposed 35 deg slide fed 0.2 s (stick in + floor), lift + centre, full opposite lock + floor at 0.9 s held',
        shortFedFlat: 'an imposed 35 deg slide fed 0.2 s, stick centred with the foot flat, full opposite lock at 0.9 s held',
        brakeCatch: 'an imposed 35 deg slide, lift, full opposite lock + full brake 0.3 s, then floor it with the lock held',
        brakeStab: 'an imposed 35 deg slide, floored, full opposite lock held, a 0.3 s full brake stab during the catch',
      }[kind];
      report.check(`overHeldCatch.${kind}`, heldText(m), `${what}: under 10 deg the other way, no spin`, m.spun === false && (m.farSideDeg as number) < 10);
    }
    report.check('overHeldCatch.heldLetGo', heldText(g), 'a held drift, full opposite lock + floor for 0.6 s, then the stick let go (foot flat): straight within 1.5 s of letting go, no spin', g.spun === false && typeof g.straightAfter === 'number' && g.straightAfter <= 1.5);
    return report.output();
  },
};

export const LINK_MANEUVERS: ManeuverDef[] = [driftLink, overHeldCatch];
