/**
 * ROBUSTNESS maneuvers of the standard suite (r - v): the everyday accidents
 * of a game with rocks, ramps, rivals and a world edge. They carry no
 * scorecard weight (the 0..100 total stays comparable with older runs) but
 * every one of their checks is listed under "failing checks" when it breaks.
 *
 *   r obstacle     one wheel onto a dome / rock / kerb, half-on ramps,
 *                  sideways into a kerb; dome + rock again at 30-120 Hz
 *   s selfRight    parked on the roof / side / nose, bad-attitude drops,
 *                  needsRescue (incl. a non-finite pose), isOutOfWorld,
 *                  reset() out of a fall with the pedals held
 *   t carContact   this car against each of the four designs: T-bone,
 *                  rear-end, head-on, offset head-on, side-swipe
 *   u pedals       brake held through a panic stop, release-and-repress,
 *                  brake held from a crawl, brake held through a respawn
 *   v rateRobust   frame-rate checks that need no driver model: step brake,
 *                  hands-off slides, offset wall strike, at 20 / 30-240 Hz
 *
 * All of it goes through the public Vehicle interface, so every model can be
 * run through it (models without self-righting simply report what they do).
 */
import { Quaternion, Vector3 } from '@babylonjs/core';
import { createVehicle, isOutOfWorld, needsRescue } from '../../../car/createVehicle';
import type { Vehicle } from '../../../car/Vehicle';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import type { WorldSpec } from '../world';
import { boulderCase, rampCase, tripCase, wallCase, wallCases } from '../extra-raycast/abuse';
import { Watchdog, judgeRecovery, placePose, runWatched } from '../extra-raycast/kit';
import { FLAT, Report, runCase } from './common';
import type { ManeuverDef } from './common';

type Metrics = Record<string, MetricValue>;

const RATES = [30, 60, 72, 90, 120];
const CAR_IDS = ['reef-rocket', 'neon-wasp', 'riot-ram', 'comet-fox'];

// ---------------------------------------------------------------------------
// r. obstacle

export const obstacle: ManeuverDef = {
  name: 'obstacle',
  title: 'r. one-sided obstacles: one wheel onto a dome / rock / kerb, half-on ramps, sideways into a kerb',
  async run(env) {
    const report = new Report();
    const wheelX = env.rig ? env.rig.front.track / 2 : 0.84;
    const z = 60;
    const flat = (o: NonNullable<WorldSpec['obstacles']>[number]): WorldSpec => ({ kind: 'flat', obstacles: [o] });
    const dome50 = flat({ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0 });
    const rock70 = flat({ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 });
    // The two ends of the game's collidable rocks (props.ts: sphere of
    // radius 0.85 x scale, centre 0.1 x scale above the ground, scale >= 0.7).
    const gameRockS = flat({ type: 'boulder', x: -wheelX, z, radius: 0.6, centerY: 0.07 });
    const gameRockL = flat({ type: 'boulder', x: -wheelX - 0.5, z, radius: 1.1, centerY: 0.13 });
    const kerb30 = flat({ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.4, height: 0.3 });
    let exploded = false;

    const strike = async (name: string, spec: WorldSpec, v: number, dt?: number) => {
      const c = await boulderCase(env, dt ? `${name}.v${Math.round(v)}.hz${Math.round(1 / dt)}` : `${name}.v${Math.round(v)}`, v, spec, z, dt);
      delete c.series;
      report.cases.push(c);
      if (c.metrics.exploded) exploded = true;
      return c.metrics;
    };
    const text = (m: Metrics) =>
      `${m.endsUpright ? 'upright' : 'OFF ITS WHEELS'}, max tilt ${Math.round(m.maxTiltDeg as number)} deg, heading kick ${Math.round(m.headingKickDeg as number)} deg, hop ${(m.hopHeight as number).toFixed(2)} m, -${Math.round(m.speedLostPct as number)} %`;

    // --- dome and rock at this run's frame rate ...
    let domeBad = 0;
    let rockBad = 0;
    let worstDomeTilt = 0;
    let worstRockKick = 0;
    let worstRockTilt = 0;
    const dome = (m: Metrics) => {
      worstDomeTilt = Math.max(worstDomeTilt, m.maxTiltDeg as number);
      if (!m.endsUpright) domeBad++;
    };
    const rock = (m: Metrics) => {
      worstRockKick = Math.max(worstRockKick, m.headingKickDeg as number);
      worstRockTilt = Math.max(worstRockTilt, m.maxTiltDeg as number);
      if (!m.endsUpright || (m.headingKickDeg as number) >= 45) rockBad++;
    };
    for (const v of [20, 24.5]) {
      const d = await strike('dome50', dome50, v);
      dome(d);
      report.summary[`dome50.v${Math.round(v)}`] = text(d);
      const r = await strike('rock70', rock70, v);
      rock(r);
      report.summary[`rock70.v${Math.round(v)}`] = text(r);
    }
    // --- ... and at every frame rate the game runs at.
    for (const hz of RATES) {
      const d = await strike('dome50', dome50, 20, 1 / hz);
      dome(d);
      const r20 = await strike('rock70', rock70, 20, 1 / hz);
      rock(r20);
      const r25 = await strike('rock70', rock70, 24.5, 1 / hz);
      rock(r25);
      report.summary[`hz${hz}`] = `dome50 @20: tilt ${Math.round(d.maxTiltDeg as number)} deg${d.endsUpright ? '' : ' OFF'} | rock70 @20 / @25: kick ${Math.round(r20.headingKickDeg as number)} / ${Math.round(r25.headingKickDeg as number)} deg, tilt ${Math.round(r20.maxTiltDeg as number)} / ${Math.round(r25.maxTiltDeg as number)} deg${r20.endsUpright && r25.endsUpright ? '' : ' OFF'}`;
    }
    report.summary.worstDomeTiltDeg = worstDomeTilt;
    report.summary.worstRockKickDeg = worstRockKick;
    report.summary.worstRockTiltDeg = worstRockTilt;
    report.check('obstacle.dome', `${domeBad} of 7 bad, worst tilt ${Math.round(worstDomeTilt)} deg`, `one wheel onto a 0.5 m dome at 20 / 24.5 m/s, and at ${RATES.join('/')} Hz: never past 75 deg, ends on its wheels`, domeBad === 0);
    report.check('obstacle.rock', `${rockBad} of 12 bad, worst kick ${Math.round(worstRockKick)} deg, worst tilt ${Math.round(worstRockTilt)} deg`, `one wheel on a 0.7 m rock at 20 / 24.5 m/s, and at ${RATES.join('/')} Hz: heading kick < 45 deg, no rollover`, rockBad === 0);

    // --- the rocks the game really scatters, and a square kerb.
    let otherBad = 0;
    for (const [name, spec, v] of [
      ['gameRockS', gameRockS, 12], ['gameRockS', gameRockS, 22], ['gameRockL', gameRockL, 12], ['gameRockL', gameRockL, 22], ['kerb30', kerb30, 20],
    ] as const) {
      const m = await strike(name, spec, v);
      if (!m.endsUpright) otherBad++;
      report.summary[`${name}.v${v}`] = text(m);
    }
    report.check('obstacle.gameRocks', otherBad, 'one wheel onto a game-size rock (0.67 m and 1.2 m tall) at 12 / 22 m/s and a 0.3 m kerb at 20 m/s: ends on its wheels', otherBad === 0);

    // --- ramps taken badly.
    let rampDown = 0;
    let rampTotal = 0;
    const down: string[] = [];
    const ramp = async (id: string, angle: number, v: number, halfOn: boolean, steer: number) => {
      const c = await rampCase(env, id, angle, v, halfOn, steer);
      delete c.series;
      report.cases.push(c);
      rampTotal++;
      if (c.metrics.exploded) exploded = true;
      if (!c.metrics.endsUpright) {
        rampDown++;
        down.push(id);
      }
    };
    for (const [angle, v] of [[25, 24.5], [35, 24.5], [45, 24.5], [35, 15], [45, 15]] as const) await ramp(`ramp${angle}.v${Math.round(v)}`, angle, v, false, 0);
    for (const [angle, v, steer] of [[12, 15, 0], [12, 22, 0], [18, 15, 0], [18, 22, 0], [25, 15, 0], [25, 22, 0], [18, 22, 1], [18, 22, -1]] as const) {
      await ramp(`halfRamp${angle}.v${v}.s${steer}`, angle, v, true, steer);
    }
    report.summary.rampsOffWheels = `${rampDown} of ${rampTotal}${down.length ? `: ${down.join(', ')}` : ''}`;
    report.check('obstacle.ramps', `${rampDown} of ${rampTotal}`, 'steep (25-45 deg) and half-on (12-25 deg, left wheels only) ramps at 15-24.5 m/s: at most 2 end off the wheels', rampDown <= 2);

    // --- sliding sideways into a kerb.
    let trips = 0;
    let worstTrip = 0;
    for (const v of [8, 14, 20]) {
      for (const h of [0.15, 0.3, 0.6]) {
        const c = await tripCase(env, v, h);
        delete c.series;
        report.cases.push(c);
        if (c.metrics.exploded) exploded = true;
        worstTrip = Math.max(worstTrip, c.metrics.maxTiltDeg as number);
        if (!c.metrics.endsUpright || c.metrics.wentPast75) trips++;
      }
    }
    report.summary.tripWorstTiltDeg = worstTrip;
    report.check('obstacle.trip', `${trips} of 9, worst tilt ${Math.round(worstTrip)} deg`, 'sliding sideways into a 0.15 / 0.3 / 0.6 m kerb at 8 / 14 / 20 m/s: never past 75 deg', trips === 0);
    report.check('obstacle.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// s. selfRight

/** Wheels under the car again: nearly level and at least three loaded. */
function onWheels(sim: Sim): boolean {
  return sim.tel.tilt < 25 * RAD && sim.tel.wheelsOff <= 1;
}

async function parkedCase(env: LabEnv, id: string, rollDeg: number, pitchDeg: number) {
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    const restY = sim.tel.y;
    // Lowered onto the ground in that attitude with the self-righting held
    // off, so "parked" really starts from rest.
    const delay = sim.vehicle.getTuning('selfRightDelay');
    const level = sim.vehicle.getTuning('airLevel');
    sim.vehicle.setTuning('selfRightDelay', 0);
    sim.vehicle.setTuning('airLevel', 0);
    placePose(sim, { x: 0, z: 0, lift: 1.4, roll: rollDeg * RAD, pitch: pitchDeg * RAD });
    sim.useFixed({});
    const dog = new Watchdog(sim);
    await runWatched(sim, dog, 2.5);
    const restTilt = sim.tel.tilt * DEG;
    const atRest = Math.hypot(sim.tel.speed, sim.tel.vy) < 0.3;
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    const parkedY = sim.tel.y;
    if (delay !== undefined) sim.vehicle.setTuning('selfRightDelay', delay);
    if (level !== undefined) sim.vehicle.setTuning('airLevel', level);
    // From here the car is on its own.
    const t0 = sim.time;
    let righted: number | null = null;
    let peakY = -Infinity;
    let peakUp = 0;
    let peakSpeed = 0;
    let rescue = false;
    await runWatched(sim, dog, 6, (s) => {
      peakY = Math.max(peakY, s.tel.y - Math.max(parkedY, restY));
      peakUp = Math.max(peakUp, s.tel.vy);
      peakSpeed = Math.max(peakSpeed, Math.hypot(s.tel.speed, s.tel.vy));
      if (needsRescue(s.vehicle, s.dt)) rescue = true;
      if (righted === null && onWheels(s)) righted = s.time - t0;
      return righted !== null && s.time - t0 > righted + 1.5;
    });
    return {
      startRollDeg: rollDeg,
      startPitchDeg: pitchDeg,
      restTiltDeg: restTilt,
      wasAtRest: atRest,
      rightedAfter: righted,
      // Highest the chassis origin got above where it lay (or above ride
      // height, for a car lying lower than that).
      peakRise: peakY,
      peakUpSpeed: peakUp,
      peakSpeed,
      moved: Math.hypot(sim.tel.x - x0, sim.tel.z - z0),
      endTiltDeg: sim.tel.tilt * DEG,
      endSpeed: Math.hypot(sim.tel.speed, sim.tel.vy),
      rescueAsked: rescue,
      ...dog.metrics(),
    };
  });
}

async function dropCase(env: LabEnv, id: string, rollDeg: number, pitchDeg: number, vz: number) {
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    placePose(sim, { x: 0, z: 0, lift: 2.2, roll: rollDeg * RAD, pitch: pitchDeg * RAD, vz });
    sim.useFixed({});
    sim.resetTrack();
    const dog = new Watchdog(sim);
    let righted: number | null = null;
    let stable = 0;
    await runWatched(sim, dog, 8, (s) => {
      // On its wheels and staying there (it may still be rolling along).
      stable = onWheels(s) && Math.abs(s.tel.vy) < 1 ? stable + s.dt : 0;
      if (righted === null && stable > 0.3) righted = s.time - 0.3;
      return righted !== null && s.time > righted + 1.5;
    });
    return {
      startRollDeg: rollDeg, startPitchDeg: pitchDeg, speed: vz,
      onWheelsAfter: righted,
      endTiltDeg: sim.tel.tilt * DEG,
      endsOnWheels: sim.tel.tilt < 25 * RAD,
      ...dog.metrics(),
    };
  });
}

export const selfRight: ManeuverDef = {
  name: 'selfRight',
  title: 's. self-righting, rescue and respawn: parked on roof / side / nose, bad-attitude drops, needsRescue, isOutOfWorld, reset out of a fall',
  async run(env) {
    const report = new Report();
    let exploded = false;

    // --- parked off its wheels.
    let slow = 0;
    let launched = 0;
    let worstTime = 0;
    let worstPeak = 0;
    const parked: Array<[string, number, number]> = [['roof', 180, 0], ['side', 90, 0], ['side.right', -90, 0], ['roof.leaning', 150, 0], ['nose', 0, 90], ['tail', 0, -90]];
    for (const [id, roll, pitch] of parked) {
      const c = await parkedCase(env, `parked.${id}`, roll, pitch);
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      if (m.exploded) exploded = true;
      const t = m.rightedAfter as number | null;
      if (t === null || t > 2.5) slow++;
      worstTime = Math.max(worstTime, t ?? 99);
      worstPeak = Math.max(worstPeak, m.peakRise as number);
      if ((m.peakRise as number) > 0.5 || (m.peakUpSpeed as number) > 4 || (m.moved as number) > 4) launched++;
      report.summary[`parked.${id}`] = `rests at ${Math.round(m.restTiltDeg as number)} deg; ${t === null ? 'NOT righted in 6 s' : `on its wheels after ${t.toFixed(2)} s`}, rises ${(m.peakRise as number).toFixed(2)} m, up to ${(m.peakSpeed as number).toFixed(1)} m/s (${(m.peakUpSpeed as number).toFixed(1)} m/s upward), moved ${(m.moved as number).toFixed(1)} m${m.rescueAsked ? ', needsRescue fired' : ''}`;
    }
    report.summary.parkedWorstTime = worstTime;
    report.check('selfRight.parked', `${parked.length - slow} of ${parked.length} within 2.5 s, worst ${worstTime.toFixed(2)} s`, 'parked on roof / side / nose / tail: back on its wheels within 2.5 s', slow === 0);
    report.check('selfRight.noLaunch', `${launched} launched, highest rise ${worstPeak.toFixed(2)} m`, 'while righting: the chassis never rises more than 0.5 m above where it lay, never moves up faster than 4 m/s, ends within 4 m', launched === 0);

    // --- dropped in a bad attitude (the 11 of the break tests).
    let off = 0;
    const offList: string[] = [];
    const drops: Array<[string, number, number, number]> = [
      ['roof', 180, 0, 0], ['roof.v15', 180, 0, 15], ['side', 90, 0, 0], ['side.v15', 90, 0, 15],
      ['side100', 100, 0, 0], ['side120', 120, 0, 0], ['nose', 0, 90, 0], ['nose80', 0, 80, 0], ['nose100', 0, 100, 0],
      ['tail', 0, -90, 0], ['roof.tilted', 160, 20, 5],
    ];
    let slowest = 0;
    for (const [id, roll, pitch, vz] of drops) {
      const c = await dropCase(env, `drop.${id}`, roll, pitch, vz);
      delete c.series;
      report.cases.push(c);
      if (c.metrics.exploded) exploded = true;
      if (!c.metrics.endsOnWheels) {
        off++;
        offList.push(id);
      }
      slowest = Math.max(slowest, (c.metrics.onWheelsAfter as number | null) ?? 0);
    }
    report.summary.dropsOffWheels = `${off} of ${drops.length}${offList.length ? `: ${offList.join(', ')}` : ''}`;
    report.summary.dropsSlowestOnWheels = slowest;
    report.check('selfRight.drops', `${off} of ${drops.length}`, 'dropped from 2.2 m upside down / on a side / on the nose or tail: at most 1 of 11 ends off its wheels', off <= 1);

    // --- needsRescue: the fallback when the car cannot right itself.
    const rescue = await runCase(env, 'rescue.fallback', FLAT, async (sim): Promise<Metrics> => {
      // Self-righting and air levelling off: the car stays on its roof.
      sim.vehicle.setTuning('selfRightDelay', 0);
      sim.vehicle.setTuning('airLevel', 0);
      placePose(sim, { x: 0, z: 0, lift: 1.4, roll: Math.PI });
      sim.useFixed({});
      let firedAt: number | null = null;
      let early = false;
      await sim.run(8, (tel) => {
        const fired = needsRescue(sim.vehicle, sim.dt);
        if (fired && tel.tilt < 60 * RAD) early = true;
        if (fired && firedAt === null) firedAt = tel.t;
        return firedAt !== null;
      });
      const tiltWhenFired = sim.tel.tilt * DEG;
      // The game's answer: respawn. Then it must simply drive.
      sim.place({ x: 20, z: 0, yaw: 0.5 });
      sim.useFixed({ throttle: 1 });
      let t10: number | null = null;
      const t0 = sim.time;
      await sim.run(2, (tel) => {
        if (t10 === null && tel.speed >= 10) t10 = tel.t - t0;
        return t10 !== null;
      });
      // An upright, driving car never asks for rescue.
      let falseAlarm = false;
      await sim.run(1, () => {
        if (needsRescue(sim.vehicle, sim.dt)) falseAlarm = true;
      });
      return { firedAt, tiltWhenFiredDeg: tiltWhenFired, firedWhileUpright: early, t10AfterRespawn: t10, falseAlarmWhileDriving: falseAlarm };
    });
    delete rescue.series;
    report.cases.push(rescue);
    const rm = rescue.metrics;
    report.summary.rescueFiredAt = rm.firedAt;
    report.check('selfRight.rescue', rm.firedAt, 'with self-righting off, needsRescue fires for a car on its roof (4 s hold), never for an upright one; after reset() the car launches', rm.firedAt !== null && rm.firedWhileUpright === false && rm.falseAlarmWhileDriving === false && rm.t10AfterRespawn !== null);

    // --- a non-finite pose (physics blow-up) must be reported, and reset()
    // must bring the car back.
    const broken = await runCase(env, 'rescue.nonFinitePose', FLAT, async (sim): Promise<Metrics> => {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 10 });
      sim.useFixed({ throttle: 1 });
      await sim.run(0.5);
      const before = needsRescue(sim.vehicle, sim.dt);
      const mesh = sim.vehicle.chassisMesh;
      const body = sim.vehicle.chassisBody;
      // What a solver blow-up looks like from outside: the pose the engine
      // hands back is NaN on every frame (Havok itself refuses a NaN that is
      // pushed into it, so the poison is re-applied around every step).
      const poison = () => {
        mesh.position.set(NaN, NaN, NaN);
        if (mesh.rotationQuaternion) mesh.rotationQuaternion.set(NaN, NaN, NaN, NaN);
      };
      body.setLinearVelocity(new Vector3(NaN, NaN, NaN));
      body.setAngularVelocity(new Vector3(NaN, NaN, NaN));
      let threw = '';
      let fired = 0;
      let frames = 0;
      let outOfWorld = true;
      try {
        for (let i = 0; i < 30; i++) {
          poison();
          sim.step();
          poison();
          frames++;
          if (needsRescue(sim.vehicle, sim.dt)) fired++;
          if (!isOutOfWorld(sim.vehicle, 100, -30)) outOfWorld = false;
        }
      } catch (err) {
        threw = String(err);
      }
      // Respawn.
      if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
      sim.place({ x: 5, z: 5, yaw: 0.3 });
      sim.useFixed({});
      await sim.run(0.5);
      const p = mesh.position;
      const finite = Number.isFinite(p.x + p.y + p.z + sim.tel.speed + sim.tel.tilt);
      const restSpeed = Math.hypot(sim.tel.speed, sim.tel.vy);
      const moved = Math.hypot(sim.tel.x - 5, sim.tel.z - 5);
      sim.useFixed({ throttle: 1 });
      let t10: number | null = null;
      const t0 = sim.time;
      await sim.run(2, (tel) => {
        if (t10 === null && tel.speed >= 10) t10 = tel.t - t0;
        return t10 !== null;
      });
      return {
        rescueBefore: before,
        framesSurvived: frames,
        threw: threw || 'no',
        rescueFiredFrames: fired,
        outOfWorldWhileBroken: outOfWorld,
        finiteAfterReset: finite,
        restSpeedAfterReset: restSpeed,
        movedAfterReset: moved,
        tiltAfterResetDeg: sim.tel.tilt * DEG,
        t10AfterReset: t10,
        rescueAfterReset: needsRescue(sim.vehicle, sim.dt),
      };
    });
    delete broken.series;
    report.cases.push(broken);
    const bm = broken.metrics;
    report.summary.nonFinite = `${bm.rescueFiredFrames} of ${bm.framesSurvived} frames reported, threw: ${bm.threw}; after reset: finite ${bm.finiteAfterReset}, 0-10 m/s in ${bm.t10AfterReset} s`;
    report.check('selfRight.nonFinitePose', bm.rescueFiredFrames, 'a NaN pose: update() does not throw, needsRescue and isOutOfWorld are true on every frame, reset() brings back a car that is at rest and launches',
      bm.threw === 'no' && bm.rescueBefore === false && bm.rescueFiredFrames === bm.framesSurvived && bm.outOfWorldWhileBroken === true &&
      bm.finiteAfterReset === true && (bm.restSpeedAfterReset as number) < 0.2 && (bm.movedAfterReset as number) < 0.05 && bm.t10AfterReset !== null && bm.rescueAfterReset === false);

    // --- isOutOfWorld (pure) and reset() out of a fall with the pedals held.
    const fall = await runCase(env, 'respawn.afterFall', FLAT, async (sim): Promise<Metrics> => {
      const v = sim.vehicle;
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      const restY = sim.tel.y;
      const inside = isOutOfWorld(v, 100, -30) || isOutOfWorld(v, { minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
      sim.place({ x: 100.5, z: 0, yaw: 0 });
      const pastEdge = isOutOfWorld(v, 100, -30);
      const insideRect = isOutOfWorld(v, { minX: 0, maxX: 200, minZ: -5, maxZ: 5 });
      let bad = 0;
      let first = '';
      let worstSpeed = 0;
      let worstMove = 0;
      let worstYaw = 0;
      let worstHop = 0;
      let worstRim = 0;
      let reversed = 0;
      let throttleYaw = 0;
      let killSeen = 0;
      const pedals = [
        { throttle: 0, brake: 0, steering: 0 }, { throttle: 1, brake: 0, steering: 0 }, { throttle: 0, brake: 1, steering: 0 },
        { throttle: 1, brake: 1, steering: 1 }, { throttle: 0, brake: 1, steering: -1 }, { throttle: 1, brake: 0, steering: 1 },
      ];
      for (let i = 0; i < 12; i++) {
        const held = pedals[i % pedals.length];
        // Falling out of the world: fast, tumbling, far below the ground.
        sim.useFixed(held);
        placePose(sim, { x: 120, z: 40, lift: -60, roll: 0.9 * i, pitch: 0.5 * i, vx: 6, vy: -40, vz: 18, wx: 4, wy: -3, wz: 5 });
        for (let k = 0; k < 6; k++) sim.step();
        if (isOutOfWorld(v, 1000, -30)) killSeen++;
        // Respawn with whatever the player is still holding.
        const x = -40 + 7 * i;
        const zz = 30 - 5 * i;
        const yaw = 0.5 * i - 2;
        sim.place({ x, z: zz, yaw });
        const yaw0 = sim.tel.yaw;
        const wantsToMove = held.throttle > 0 && held.brake === 0;
        if (!wantsToMove) {
          let speed = 0;
          let hop = 0;
          await sim.run(0.3);
          await sim.run(1.7, (tel) => {
            speed = Math.max(speed, Math.hypot(tel.speed, tel.vy));
            hop = Math.max(hop, Math.abs(tel.y - restY));
          });
          const move = Math.hypot(sim.tel.x - x, sim.tel.z - zz);
          const yawErr = Math.abs(sim.tel.yaw - yaw0) * DEG;
          let rim = 0;
          for (const w of v.wheelStates) rim = Math.max(rim, Math.abs(w.spinSpeed * w.radius));
          if (v.isReversing) reversed++;
          worstSpeed = Math.max(worstSpeed, speed);
          worstMove = Math.max(worstMove, move);
          worstYaw = Math.max(worstYaw, yawErr);
          worstHop = Math.max(worstHop, hop);
          worstRim = Math.max(worstRim, rim);
          // Brake + throttle together spins the driven wheels against the
          // brake on some models: only the car itself is judged there.
          const rimBad = held.throttle === 0 && rim > 0.3;
          if (speed > 0.2 || move > 0.05 || yawErr > 1 || hop > 0.03 || sim.tel.tilt > 3 * RAD || rimBad || v.isReversing) {
            bad++;
            if (!first) first = `#${i} (throttle ${held.throttle}, brake ${held.brake}, stick ${held.steering}): speed ${speed.toFixed(2)}, moved ${move.toFixed(3)} m, yaw ${yawErr.toFixed(2)} deg, hop ${hop.toFixed(3)} m, rim ${rim.toFixed(2)} m/s${v.isReversing ? ', REVERSING' : ''}`;
          }
        } else if (held.steering === 0) {
          // Throttle held through the respawn: it drives off straight.
          await sim.run(1.0);
          const err = Math.abs(sim.tel.yaw - yaw0) * DEG;
          throttleYaw = Math.max(throttleYaw, err);
          if (err > 1 || sim.tel.vFwd < 5) {
            bad++;
            if (!first) first = `#${i} throttle held: heading ${err.toFixed(2)} deg off, ${sim.tel.vFwd.toFixed(1)} m/s after 1 s`;
          }
        } else {
          await sim.run(1.0);
          if (!(sim.tel.vFwd > 3) || sim.tel.tilt > 20 * RAD) {
            bad++;
            if (!first) first = `#${i} throttle + lock held: ${sim.tel.vFwd.toFixed(1)} m/s, tilt ${(sim.tel.tilt * DEG).toFixed(0)} deg after 1 s`;
          }
        }
      }
      return {
        insideReportedOut: inside, pastEdgeReported: pastEdge, insideRectReportedOut: insideRect, fallsSeenByKillPlane: killSeen,
        respawns: 12, badRespawns: bad, firstBad: first || 'none',
        worstSpeed, worstMove, worstYawErrDeg: worstYaw, worstHeightError: worstHop, worstResidualRimSpeed: worstRim,
        reversedWithBrakeHeld: reversed, throttleHeldHeadingErrDeg: throttleYaw,
      };
    });
    delete fall.series;
    report.cases.push(fall);
    const fm = fall.metrics;
    report.summary.respawnAfterFall = `${fm.badRespawns} of 12 bad (${fm.firstBad}); worst speed ${fm.worstSpeed} m/s, moved ${fm.worstMove} m, yaw ${fm.worstYawErrDeg} deg`;
    report.check('selfRight.outOfWorld', fm.fallsSeenByKillPlane, 'isOutOfWorld: false inside, true past the edge, below the kill height (12 of 12 falls) and outside a rectangle',
      fm.insideReportedOut === false && fm.pastEdgeReported === true && fm.insideRectReportedOut === false && fm.fallsSeenByKillPlane === 12);
    report.check('selfRight.resetAfterFall', fm.badRespawns, '12 respawns out of a 40 m/s tumbling fall with pedals held: at rest (< 0.2 m/s), on the spot (< 5 cm, < 1 deg), level; a held brake does not reverse; a held throttle drives off straight (< 1 deg)', fm.badRespawns === 0);
    report.check('selfRight.sane', exploded, 'no NaN / explosion', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// t. carContact

type ContactMode = 'tbone' | 'tboneRear' | 'rearEnd' | 'headOn' | 'headOnOffset' | 'sideSwipe';
const CONTACT_MODES: ContactMode[] = ['tbone', 'tboneRear', 'rearEnd', 'headOn', 'headOnOffset', 'sideSwipe'];

/** This run's car (A, driven) against a second car of design `otherId` (B). */
export async function contactCase(env: LabEnv, otherId: string, mode: ContactMode, hz = 0) {
  const dt = hz > 0 ? 1 / hz : env.dt;
  const id = `${mode}.vs.${otherId}${hz > 0 ? `.hz${hz}` : ''}`;
  return runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
    const scene = sim.world.scene;
    const idle = { name: 'idle', intent: { throttle: 0, steering: 0, brake: 0 }, isActive: () => true, poll() { return this.intent; } };
    const other: Vehicle = createVehicle(scene, idle, { model: env.model, carId: otherId, handling: env.handling });
    const otherNodes = scene.meshes.filter((m) => m.physicsBody && m !== sim.vehicle.chassisMesh && !m.name.startsWith('lab'));
    const hook = scene.onBeforePhysicsObservable.add(() => {
      for (const node of otherNodes) node.computeWorldMatrix(true);
      other.update(sim.dt);
    });
    try {
      const v = mode === 'rearEnd' ? 14 : 20;
      const length = env.rig ? env.rig.spec.length : 3.5;
      // B waits at the origin; A arrives along +z.
      const side = mode === 'tbone' || mode === 'tboneRear';
      const bYaw = side ? Math.PI / 2 : mode === 'headOn' || mode === 'headOnOffset' ? Math.PI : 0;
      // tboneRear: A's nose meets B's rear wheel (B's nose points +x).
      const bx = mode === 'sideSwipe' ? 1.75 : mode === 'headOnOffset' ? 0.9 : mode === 'tboneRear' ? 0.9 : 0;
      other.reset(new Vector3(bx, 0, 0), bYaw);
      const oncoming = mode === 'headOn' || mode === 'headOnOffset';
      if (oncoming) {
        other.setMotion(new Vector3(0, 0, -20), 0);
        idle.intent.throttle = 1;
      }
      sim.place({ x: 0, z: -(mode === 'sideSwipe' ? 20 : (oncoming ? 2 : 1) * v + length + 1), yaw: 0, speed: v });
      sim.useFixed({ throttle: 1 });
      sim.resetTrack();
      for (const node of otherNodes) node.computeWorldMatrix(true);
      const dog = new Watchdog(sim);
      const restA = sim.tel.y;
      const restB = other.chassisMesh.position.y;
      const lin = new Vector3();
      const ang = new Vector3();
      let bMaxSpeed = 0;
      let bMaxSpin = 0;
      let bMaxY = -Infinity;
      let bMinY = Infinity;
      let bNan = false;
      let bMaxTilt = 0;
      let stacked = 0;
      let touchedAt: number | null = null;
      let minGap = Infinity;
      await runWatched(sim, dog, 4, (s) => {
        other.chassisBody.getLinearVelocityToRef(lin);
        other.chassisBody.getAngularVelocityToRef(ang);
        const p = other.chassisMesh.position;
        if (!Number.isFinite(lin.x + lin.y + lin.z + ang.x + ang.y + ang.z + p.x + p.y + p.z)) bNan = true;
        bMaxSpeed = Math.max(bMaxSpeed, lin.length());
        bMaxSpin = Math.max(bMaxSpin, ang.length());
        bMaxY = Math.max(bMaxY, p.y);
        bMinY = Math.min(bMinY, p.y);
        const q = other.chassisMesh.rotationQuaternion;
        if (q) bMaxTilt = Math.max(bMaxTilt, Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z)))));
        const gap = Math.hypot(s.tel.x - p.x, s.tel.z - p.z);
        minGap = Math.min(minGap, gap);
        if (touchedAt === null && (lin.length() > 21 || (!oncoming && lin.length() > 0.5))) touchedAt = s.time;
        // One car riding on the other: close together and one of them lifted.
        if (gap < 1.5 && (s.tel.y - restA > 0.4 || p.y - restB > 0.4)) stacked += s.dt;
      });
      const q = other.chassisMesh.rotationQuaternion;
      const bEndTilt = q ? Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z)))) * DEG : 0;
      return {
        ran: true,
        other: otherId,
        closingSpeed: oncoming ? v + 20 : v,
        contact: touchedAt !== null || minGap < length,
        aPeakLift: dog.maxY - restA,
        bPeakLift: bMaxY - restB,
        bSunk: restB - bMinY,
        aMaxTiltDeg: sim.track.maxTilt * DEG,
        bMaxTiltDeg: bMaxTilt * DEG,
        aEndTiltDeg: sim.tel.tilt * DEG,
        bEndTiltDeg: bEndTilt,
        stackedTime: stacked,
        aMaxSpin: dog.maxAngSpeed,
        bMaxSpin,
        bMaxSpeed,
        aEndSpeed: sim.tel.speed,
        bNan,
        ...dog.metrics(),
      };
    } finally {
      scene.onBeforePhysicsObservable.remove(hook);
      other.dispose();
    }
  }, dt);
}

export const carContact: ManeuverDef = {
  name: 'carContact',
  title: 't. car-to-car contact: this car against each of the four designs (T-bone, rear-end, head-on, offset head-on, side-swipe)',
  async run(env) {
    const report = new Report();
    if (!env.rig) {
      report.summary.skipped = 'legacy hardcoded layout: no second car';
      return report.output();
    }
    let bad = 0;
    let exploded = false;
    let worstLift = 0;
    let worstLiftCase = '';
    let worstSpin = 0;
    let worstTilt = 0;
    let noContact = 0;
    const badList: string[] = [];
    const judge = (id: string, m: Metrics) => {
      if (m.exploded || m.bNan || (m.bMaxSpeed as number) > 45 || (m.bMaxSpin as number) > 25) exploded = true;
      const lift = Math.max(m.aPeakLift as number, m.bPeakLift as number);
      if (lift > worstLift) {
        worstLift = lift;
        worstLiftCase = id;
      }
      worstSpin = Math.max(worstSpin, m.aMaxSpin as number, m.bMaxSpin as number);
      worstTilt = Math.max(worstTilt, m.aMaxTiltDeg as number, m.bMaxTiltDeg as number);
      if (!m.contact) noContact++;
      const isBad = lift > 0.3 || (m.stackedTime as number) > 0 || (m.aEndTiltDeg as number) > 25 || (m.bEndTiltDeg as number) > 25 || (m.bSunk as number) > 0.3;
      if (isBad) {
        bad++;
        badList.push(`${id} (lift ${lift.toFixed(2)} m, stacked ${(m.stackedTime as number).toFixed(2)} s, ends ${Math.round(m.aEndTiltDeg as number)} / ${Math.round(m.bEndTiltDeg as number)} deg)`);
      }
    };
    let total = 0;
    for (const otherId of CAR_IDS) {
      const row: string[] = [];
      for (const mode of CONTACT_MODES) {
        const c = await contactCase(env, otherId, mode);
        delete c.series;
        report.cases.push(c);
        total++;
        judge(c.id, c.metrics);
        row.push(`${mode} ${Math.max(c.metrics.aPeakLift as number, c.metrics.bPeakLift as number).toFixed(2)}`);
      }
      report.summary[`lift.vs.${otherId}`] = row.join(', ');
    }
    // The hardest two again at every frame rate, against its own kind.
    for (const hz of RATES) {
      for (const mode of ['headOn', 'tbone'] as const) {
        const c = await contactCase(env, env.carId, mode, hz);
        delete c.series;
        report.cases.push(c);
        total++;
        judge(c.id, c.metrics);
      }
    }
    report.summary.worstLift = worstLift;
    report.summary.worstLiftCase = worstLiftCase;
    report.summary.worstSpin = worstSpin;
    report.summary.worstTiltDeg = worstTilt;
    report.summary.bad = badList.join(' | ') || 'none';
    report.check('carContact.noLift', `${bad} of ${total} bad, worst lift ${worstLift.toFixed(2)} m (${worstLiftCase})`, 'driving collisions against all four designs (and head-on / T-bone at 30-120 Hz): no car lifted more than 0.3 m, none stacked, both end on their wheels', bad === 0);
    report.check('carContact.contact', noContact, 'every case really is a collision', noContact === 0);
    report.check('carContact.sane', exploded, 'no NaN / explosion (speed < 45 m/s, spin < 25 rad/s)', !exploded);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// u. pedals

export const pedals: ManeuverDef = {
  name: 'pedals',
  title: 'u. brake / reverse: brake held through a panic stop, release-and-repress, brake held from a crawl',
  async run(env) {
    const report = new Report();
    const stopThen = async (id: string, v0: number, lock: number) =>
      runCase(env, id, FLAT, async (sim): Promise<Metrics> => {
        sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
        sim.useFixed({});
        await sim.run(0.1);
        sim.useScript([{ t: 0, throttle: 0, brake: 1, steering: lock }]);
        const t0 = sim.time;
        let stopAt: number | null = null;
        let reverseAt: number | null = null;
        let speed1sAfterStop: number | null = null;
        let backward3s = 0;
        let movingBackAt: number | null = null;
        let halfSecondIn: number | null = null;
        await sim.run(6, (tel) => {
          const t = tel.t - t0;
          if (stopAt === null && tel.speed < 0.4) stopAt = t;
          if (stopAt !== null && movingBackAt === null && sim.vehicle.isReversing) movingBackAt = t;
          if (movingBackAt !== null && halfSecondIn === null && t >= movingBackAt + 0.5) halfSecondIn = tel.vFwd;
          if (stopAt !== null && reverseAt === null && tel.vFwd < -1) reverseAt = t - stopAt;
          if (stopAt !== null && speed1sAfterStop === null && t >= stopAt + 1.0) speed1sAfterStop = tel.vFwd;
          if (stopAt !== null && t <= stopAt + 3) backward3s = Math.min(backward3s, tel.vFwd);
          return stopAt !== null && t > stopAt + 3.2;
        });
        return { v0, stopTime: stopAt, vFwd1sAfterStop: speed1sAfterStop, reverseAfterStop: reverseAt, fastestBackwardWithin3s: backward3s, vFwdHalfSecondIntoReverse: halfSecondIn };
      });

    // Panic stop from speed, brake kept down.
    const panic = await stopThen('panic.v20', 20, 0);
    const panicLock = await stopThen('panic.v20.lock', 20, 1);
    // The same from a crawl: the documented hold-to-reverse.
    const crawl = await stopThen('crawl.v2', 2, 0);
    for (const c of [panic, panicLock, crawl]) {
      delete c.series;
      report.cases.push(c);
      const m = c.metrics;
      report.summary[c.id] = `stops after ${m.stopTime} s; 1 s later ${m.vFwd1sAfterStop} m/s; backing up (-1 m/s) ${m.reverseAfterStop === null ? 'never within 3 s' : `${m.reverseAfterStop} s after the stop`}; fastest backward within 3 s: ${m.fastestBackwardWithin3s} m/s`;
    }
    const still = (c: typeof panic) => c.metrics.stopTime !== null && Math.abs((c.metrics.vFwd1sAfterStop as number | null) ?? 9) < 0.3;
    report.check('pedals.panicStopHolds', panic.metrics.vFwd1sAfterStop, 'brake held through a stop from 20 m/s (straight and at full lock): the car still stands 1 s after stopping', still(panic) && still(panicLock));
    // ... and when the held brake does turn into reverse, the thrust eases in
    // (tuning.autoReverseRamp) instead of arriving all at once.
    const ease = [panic, panicLock, crawl].map((c) => c.metrics.vFwdHalfSecondIntoReverse as number | null);
    report.summary.vFwdHalfSecondIntoReverse = ease.map((v) => (v === null ? 'none' : v.toFixed(1))).join(' / ');
    report.check('pedals.reverseEasesIn', report.summary.vFwdHalfSecondIntoReverse, 'held brake turned reverse (panic stop straight / at full lock / from a crawl): slower than 6 m/s backward half a second after it switches to reverse', ease.every((v) => v !== null && v > -6));
    const crawlRev = crawl.metrics.reverseAfterStop as number | null;
    report.check('pedals.crawlReverses', crawlRev, 'brake held from a 2 m/s crawl: backs up within 1 s of stopping (hold-to-reverse)', crawlRev !== null && crawlRev < 1);

    // Release and press again after a panic stop: reverse at once.
    const repress = await runCase(env, 'panic.repress', FLAT, async (sim): Promise<Metrics> => {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 20 });
      sim.useScript([{ t: 0, throttle: 0, brake: 1 }]);
      await sim.run(4, (tel) => tel.speed < 0.3);
      sim.useScript([{ t: 0, brake: 0 }, { t: 0.2, brake: 1 }]);
      const t0 = sim.time;
      let rev: number | null = null;
      await sim.run(2.5, (tel) => {
        if (rev === null && tel.vFwd < -1) rev = tel.t - t0 - 0.2;
        return rev !== null;
      });
      return { reverseAfterRepress: rev, reversing: sim.vehicle.isReversing };
    });
    delete repress.series;
    report.cases.push(repress);
    const rr = repress.metrics.reverseAfterRepress as number | null;
    report.summary.repress = rr;
    report.check('pedals.repressReverses', rr, 'after the stop: release, press again -> backing up within 0.8 s', rr !== null && rr < 0.8);

    // A brake that is down through a respawn is not a reverse command.
    const respawn = await runCase(env, 'respawn.brakeHeld', FLAT, async (sim): Promise<Metrics> => {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
      sim.useFixed({ brake: 1 });
      await sim.run(0.2);
      sim.place({ x: 30, z: 0, yaw: 1 });
      let maxSpeed = 0;
      await sim.run(3, (tel) => {
        maxSpeed = Math.max(maxSpeed, tel.speed);
      });
      const heldStill = maxSpeed;
      const reversing = sim.vehicle.isReversing;
      sim.useScript([{ t: 0, brake: 0 }, { t: 0.2, brake: 1 }]);
      let rev: number | null = null;
      const t0 = sim.time;
      await sim.run(2, (tel) => {
        if (rev === null && tel.vFwd < -1) rev = tel.t - t0 - 0.2;
        return rev !== null;
      });
      return { maxSpeedWhileHeld: heldStill, reversingWhileHeld: reversing, reverseAfterRepress: rev };
    });
    delete respawn.series;
    report.cases.push(respawn);
    const sm = respawn.metrics;
    report.summary.respawnBrakeHeld = `max ${sm.maxSpeedWhileHeld} m/s in 3 s; re-press backs up after ${sm.reverseAfterRepress} s`;
    report.check('pedals.respawnBrakeHeld', sm.maxSpeedWhileHeld, 'brake held through a respawn: the car stands (< 0.2 m/s for 3 s); released and pressed again it backs up', (sm.maxSpeedWhileHeld as number) < 0.2 && sm.reversingWhileHeld === false && sm.reverseAfterRepress !== null);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// v. rateRobust — frame-rate checks with no driver model in the loop (so a
// spread here is the CAR's, not the lab driver's or an input ramp's).

const WIDE_RATES = [20, 30, 60, 120, 240];

function spreadPct(values: number[], floor: number): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return ((Math.max(...values) - Math.min(...values)) / Math.max(Math.abs(mean), floor)) * 100;
}

export const rateRobust: ManeuverDef = {
  name: 'rateRobust',
  title: 'v. frame-rate independence without a driver: step brake 20 -> 0, hands-off slides, offset wall strike (20 / 30 - 240 Hz)',
  async run(env) {
    const report = new Report();

    // --- full brake as a STEP input (no pedal ramp) from 20 m/s.
    const dists: number[] = [];
    for (const hz of WIDE_RATES) {
      const c = await runCase(env, `brakeStep.hz${hz}`, FLAT, async (sim): Promise<Metrics> => {
        sim.place({ x: 0, z: 0, yaw: 0, speed: 20 });
        sim.useFixed({ brake: 1 });
        let stop: number | null = null;
        let prevZ = 0;
        let prevV = 20;
        await sim.run(3, (tel) => {
          if (tel.speed < 0.5) {
            // Interpolate to the 0.5 m/s crossing inside this frame.
            const f = (prevV - 0.5) / Math.max(prevV - tel.speed, 1e-6);
            stop = prevZ + (tel.z - prevZ) * f;
            return true;
          }
          prevZ = tel.z;
          prevV = tel.speed;
          return false;
        });
        return { stopDistance: stop, ideal: (20 * 20) / (2 * sim.mug) };
      }, 1 / hz);
      delete c.series;
      report.cases.push(c);
      dists.push((c.metrics.stopDistance as number | null) ?? NaN);
    }
    const brakeSpread = spreadPct(dists, 1);
    // The frame-level integrator (Havok moves the body by end-of-frame
    // velocity x dt) shortens a stop by v0·dt/2: with that known term taken
    // out, nothing else may depend on the frame rate.
    const corrected = dists.map((d, i) => d + (20 * 0.5) / WIDE_RATES[i]);
    const correctedSpread = spreadPct(corrected, 1);
    report.summary.brakeStepDistances = dists.map((d) => d.toFixed(2)).join(' / ');
    report.summary.brakeStepSpreadPct = brakeSpread;
    report.summary.brakeStepSpreadWithoutHalfFramePct = correctedSpread;
    report.check('rateRobust.brakeStep', `${brakeSpread.toFixed(1)} % raw, ${correctedSpread.toFixed(1)} % without the integrator's v·dt/2`,
      `step brake 20 -> 0 at ${WIDE_RATES.join('/')} Hz: stopping distance within 1.5 % once the frame integrator's known half-frame term (v·dt/2) is taken out — or within 1.5 % raw (tuning meanVelocityHandoff 1)`,
      Math.min(brakeSpread, correctedSpread) < 1.5);

    // --- hands-off slides: time to straight.
    let worstSlide = 0;
    for (const beta of [20, 35]) {
      const times: number[] = [];
      for (const hz of WIDE_RATES) {
        const c = await runCase(env, `slide${beta}.handsOff.hz${hz}`, FLAT, async (sim): Promise<Metrics> => {
          const b = beta * RAD;
          sim.place({ x: 0, z: 0, yaw: b, speed: 15, beta: -b, yawRate: b });
          sim.useFixed({});
          const betas: number[] = [];
          const rates: number[] = [];
          const yaws: number[] = [];
          await sim.run(4, (tel) => {
            betas.push(tel.beta);
            rates.push(tel.yawRate);
            yaws.push(tel.yaw);
          });
          return judgeRecovery(sim.dt, betas, rates, yaws, 0, -1);
        }, 1 / hz);
        delete c.series;
        report.cases.push(c);
        times.push((c.metrics.recoveryTime as number | null) ?? 99);
      }
      const range = Math.max(...times) - Math.min(...times);
      worstSlide = Math.max(worstSlide, range);
      report.summary[`slide${beta}.handsOff.times`] = times.map((t) => t.toFixed(2)).join(' / ');
    }
    report.summary.slideWorstRange = worstSlide;
    report.check('rateRobust.slideHandsOff', worstSlide, `hands-off 20 and 35 deg slides at ${WIDE_RATES.join('/')} Hz: time to straight within 0.1 s`, worstSlide <= 0.1 + 1e-6);

    // --- into a wall at top speed: head-on, and with the left front wheel
    // only (the end of a wall).
    const walls = wallCases(env);
    const headOn = walls.find((w) => w.id === 'headOn.top');
    const offset = walls.find((w) => w.id === 'offsetLeftWheel.top');
    const bounces: number[] = [];
    const rebounds: number[] = [];
    let wallBad = 0;
    if (headOn && offset) {
      for (const hz of [30, 60, 90, 120]) {
        const a = await wallCase(env, { ...headOn, id: `wallHeadOn.hz${hz}` }, 1 / hz);
        const b = await wallCase(env, { ...offset, id: `wallOffset.hz${hz}` }, 1 / hz);
        for (const c of [a, b]) {
          delete c.series;
          report.cases.push(c);
          if (!c.metrics.endsUpright || c.metrics.exploded) wallBad++;
        }
        if (a.metrics.wentThroughOrOver) wallBad++;
        // Head-on: the bounce off the wall (first 0.3 s). Offset: the car
        // swings round the wall end — the fastest it moves back in 2 s.
        bounces.push(a.metrics.bounceSpeed as number);
        rebounds.push(b.metrics.reboundSpeed as number);
      }
    }
    report.summary.wallHeadOnBounce = bounces.map((r) => r.toFixed(2)).join(' / ');
    report.summary.wallOffsetRebounds = rebounds.map((r) => r.toFixed(1)).join(' / ');
    const worstRebound = Math.max(0, ...bounces, ...rebounds);
    report.check('rateRobust.wallRebound', worstRebound, 'into a wall at 24.5 m/s, head-on and with the left front wheel only, at 30/60/90/120 Hz: comes back at < 3 m/s, ends upright, not through', bounces.length === 4 && worstRebound < 3 && wallBad === 0);
    return report.output();
  },
};
