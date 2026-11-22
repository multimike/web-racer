import { PathPlan, planOptions } from '../../../car/DriverModel';
import type { DriverParams } from '../../../car/DriverModel';
import { DEG, RAD } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { RAMP_LENGTH } from '../world';
import type { WorldSpec } from '../world';
import { Report, mean, num, runCase } from './common';
import type { ManeuverDef } from './common';

// ---------------------------------------------------------------------------
// j. jump — the game's ramps (12 / 18 / 25°, 10 m long, 6 m wide).

const RAMP_Z = 40;

async function jumpCase(env: LabEnv, angleDeg: number, v: number, yawDeg: number) {
  const spec: WorldSpec = { kind: 'flat', obstacles: [{ type: 'ramp', x: 0, z: RAMP_Z, angleDeg }] };
  return runCase(env, `a${angleDeg}.v${v}.y${yawDeg}`, spec, async (sim: Sim) => {
    const course = yawDeg * RAD;
    const angle = angleDeg * RAD;
    // Approach along `course`, aimed at the middle of the ramp's entry edge.
    const run = 30;
    sim.place({ x: -run * Math.sin(course), z: RAMP_Z - run * Math.cos(course), yaw: course, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, course);
    const restY = sim.tel.y;
    const lipZ = RAMP_Z + RAMP_LENGTH * Math.cos(angle);
    const wheels = sim.vehicle.wheelStates;
    // Beyond the lip the ground is the flat plane again: a wheel is in the
    // air when its tread is more than 3 cm above y = 0 (model-independent).
    const airborne = (i: number) => wheels[i].position.y - wheels[i].radius > 0.03;

    let takeoff: number | null = null;
    let landing: number | null = null;
    let takeoffSpeed = 0;
    let takeoffVy = 0;
    let takeoffY = 0;
    let takeoffX = 0;
    let takeoffZ = 0;
    let landingPitch = 0;
    let landingRoll = 0;
    let flightMaxPitch = 0;
    let flightMaxRoll = 0;
    let bounces = 0;
    let airRun = 0;
    let wasAir = false;
    let jumpDistance = 0;
    let tEnd = Infinity;
    sim.resetTrack();
    await sim.run(14, (tel) => {
      if (takeoff === null) {
        const rearZ = (wheels[2].position.z + wheels[3].position.z) / 2;
        if (rearZ >= lipZ) {
          takeoff = tel.t;
          takeoffSpeed = tel.speed;
          takeoffVy = tel.vy;
          takeoffY = tel.y;
          takeoffX = tel.x;
          takeoffZ = tel.z;
        }
        return false;
      }
      const allAir = airborne(0) && airborne(1) && airborne(2) && airborne(3);
      if (landing === null) {
        flightMaxPitch = Math.max(flightMaxPitch, Math.abs(tel.pitch));
        flightMaxRoll = Math.max(flightMaxRoll, Math.abs(tel.roll));
        if (!allAir) {
          landing = tel.t;
          landingPitch = tel.pitch;
          landingRoll = tel.roll;
          jumpDistance = Math.hypot(tel.x - takeoffX, tel.z - takeoffZ);
          tEnd = tel.t + 3.0;
        }
        return false;
      }
      // After touchdown: count the times the whole car leaves the ground
      // again for at least 0.05 s.
      airRun = allAir ? airRun + sim.dt : 0;
      if (airRun >= 0.05 && !wasAir) {
        bounces++;
        wasAir = true;
      }
      if (!allAir) wasAir = false;
      return tel.t >= tEnd;
    });
    const airtime = takeoff !== null && landing !== null ? landing - takeoff : null;
    // Hand physics: ballistic flight of the chassis from its take-off state
    // down to ride height.
    const g = sim.gravity;
    const drop = Math.max(0, takeoffY - restY);
    const ballistic = takeoff !== null ? (takeoffVy + Math.sqrt(takeoffVy * takeoffVy + 2 * g * drop)) / g : null;
    const headingError = (sim.tel.yaw - course) * DEG;
    const upright = !sim.track.rolledOver && sim.tel.tilt < 25 * RAD;
    const metrics: Record<string, MetricValue> = {
      rampDeg: angleDeg,
      approachSpeed: v,
      approachYawDeg: yawDeg,
      tookOff: takeoff !== null,
      landed: landing !== null,
      takeoffSpeed,
      airtime,
      ballisticAirtime: ballistic,
      airtimeVsBallistic: airtime !== null && ballistic ? airtime / ballistic : null,
      jumpDistance,
      landingPitchDeg: landingPitch * DEG,
      landingRollDeg: landingRoll * DEG,
      flightMaxPitchDeg: flightMaxPitch * DEG,
      flightMaxRollDeg: flightMaxRoll * DEG,
      bounces,
      maxTiltDeg: sim.track.maxTilt * DEG,
      endsUpright: upright,
      headingErrorDeg: headingError,
      onCourse: upright && Math.abs(headingError) < 25,
      speedEnd: sim.tel.speed,
    };
    return metrics;
  });
}

export const jump: ManeuverDef = {
  name: 'jump',
  title: 'j. jump: 12 / 18 / 25 deg ramps at 12 and 18 m/s, straight and 8 deg yawed',
  async run(env) {
    const report = new Report();
    let total = 0;
    let upright = 0;
    let onCourse = 0;
    let bounces = 0;
    let flat = 0;
    let worstPitch = 0;
    const ratios: number[] = [];
    for (const angle of [12, 18, 25]) {
      for (const v of [12, 18]) {
        for (const yaw of [0, 8]) {
          const c = await jumpCase(env, angle, v, yaw);
          report.cases.push(c);
          const m = c.metrics;
          total++;
          if (m.endsUpright) upright++;
          if (m.onCourse) onCourse++;
          bounces += m.bounces as number;
          // Lands on its wheels rather than on its nose/tail.
          if (m.landed === true && Math.abs(m.landingPitchDeg as number) < 30) flat++;
          worstPitch = Math.max(worstPitch, Math.abs(m.landingPitchDeg as number));
          const ratio = num(m.airtimeVsBallistic);
          if (ratio !== null) ratios.push(ratio);
          report.check(`jump.${c.id}`, m.endsUpright === true ? `upright, heading ${Math.round(m.headingErrorDeg as number)} deg` : 'crashed', 'lands upright and within 25 deg of the approach course', m.onCourse === true);
        }
      }
    }
    report.summary.cases = total;
    report.summary.uprightFraction = upright / total;
    report.summary.onCourseFraction = onCourse / total;
    report.summary.meanBounces = bounces / total;
    report.summary.flatLandingFraction = flat / total;
    report.summary.worstLandingPitchDeg = worstPitch;
    report.check('jump.flatLandings', flat / total, 'lands within 30 deg of level in >= 75 % of the jumps', flat / total >= 0.75);
    report.summary.airtimeVsBallistic = ratios.length ? mean(ratios) : null;
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// k. rough — washboard, one-sided kerb strike, boulder glance. Hands off the
// stick, constant throttle: what does the CAR do when the ground hits back?

async function roughCase(env: LabEnv, id: string, v: number, spec: WorldSpec, zStart: number, zEnd: number) {
  return runCase(env, id, spec, async (sim: Sim) => {
    // 3 s of run-up so the speed-hold throttle has settled.
    sim.place({ x: 0, z: zStart - 3 - 3 * v, yaw: 0, speed: v });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v, 0);
    // Drive up to 3 m before the obstacle, then freeze the throttle (at its
    // 1 s average — what it takes to hold this speed on smooth ground) and
    // let go of the stick.
    await sim.run(10, (tel) => tel.z >= zStart - 3);
    const throttle = sim.meanThrottle(1.0);
    const entrySpeed = sim.tel.speed;
    const yaw0 = sim.tel.yaw;
    const x0 = sim.tel.x;
    sim.useScript([{ t: 0, steering: 0, throttle, brake: 0 }]);
    sim.resetTrack();
    let kick = 0;
    let minSpeed = entrySpeed;
    let maxDev = 0;
    let tExit: number | null = null;
    let exitSpeed = 0;
    await sim.run(12, (tel) => {
      kick = Math.max(kick, Math.abs(tel.yaw - yaw0));
      minSpeed = Math.min(minSpeed, tel.speed);
      maxDev = Math.max(maxDev, Math.abs(tel.x - x0));
      if (tExit === null && tel.z >= zEnd) {
        tExit = tel.t;
        exitSpeed = tel.speed;
      }
      // 1.5 s past the obstacle, or stopped dead.
      return (tExit !== null && tel.t - tExit >= 1.5) || tel.speed < 0.3;
    });
    const upright = !sim.track.rolledOver && sim.tel.tilt < 25 * RAD;
    return {
      entrySpeed,
      heldThrottle: throttle,
      passed: tExit !== null,
      exitSpeed: tExit !== null ? exitSpeed : null,
      speedLostPct: (1 - minSpeed / entrySpeed) * 100,
      headingKickDeg: kick * DEG,
      lateralDeviation: maxDev,
      maxTiltDeg: sim.track.maxTilt * DEG,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      maxRollDeg: sim.track.maxAbsRoll * DEG,
      // 'flag' lift mode on obstacles: what the model reports.
      wheelsOffTime: sim.track.anyLiftTime,
      spun: sim.track.spun,
      staysUpright: upright,
    };
  });
}

export const rough: ManeuverDef = {
  name: 'rough',
  title: 'k. rough: washboard at 15 m/s, one-sided 0.15 m kerb and boulder glance at 10 m/s',
  async run(env) {
    const report = new Report();
    const rig = env.rig;
    const wheelX = rig ? rig.front.track / 2 : 0.84;
    const wheelW = rig ? rig.front.tireWidth : 0.42;
    const wheelR = rig ? rig.front.tireRadius : 0.52;

    const wash = await roughCase(env, 'washboard.v15', 15,
      { kind: 'flat', obstacles: [{ type: 'washboard', x: 0, z: 30, length: 30, wavelength: 1.5, height: 0.08 }] }, 30, 60);
    // Kerb under the LEFT wheels only.
    const kerb = await roughCase(env, 'kerb.v10', 10,
      { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z: 25, width: 1.0, depth: 0.4, height: 0.15 }] }, 25, 25.4 + (rig?.wheelbase ?? 2.6));
    // Boulder: r = 0.5 m, centre 0.2 m up; positioned so 0.15 m of the left
    // front tire's outer edge overlaps it at hub height — a glancing blow.
    const radius = 0.5;
    const centerY = 0.2;
    const atHub = Math.sqrt(Math.max(0.01, radius * radius - (wheelR - centerY) ** 2));
    const boulderX = -(wheelX + wheelW / 2 + atHub - 0.15);
    const boulder = await roughCase(env, 'boulder.v10', 10,
      { kind: 'flat', obstacles: [{ type: 'boulder', x: boulderX, z: 25, radius, centerY }] }, 25 - radius, 25 + radius + (rig?.wheelbase ?? 2.6));

    for (const c of [wash, kerb, boulder]) {
      report.cases.push(c);
      const m = c.metrics;
      const name = c.id.split('.')[0];
      report.summary[`${name}.speedLostPct`] = m.speedLostPct;
      report.summary[`${name}.headingKickDeg`] = m.headingKickDeg;
      report.summary[`${name}.staysUpright`] = m.staysUpright;
      report.check(`rough.${name}.upright`, m.staysUpright, 'stays upright and gets past', m.staysUpright === true && m.passed === true);
    }
    report.check('rough.washboard.heading', wash.metrics.headingKickDeg, 'heading kick < 5 deg hands-off', (wash.metrics.headingKickDeg as number) < 5);
    report.check('rough.washboard.speed', wash.metrics.speedLostPct, 'loses < 25 % speed', (wash.metrics.speedLostPct as number) < 25);
    report.check('rough.kerb.heading', kerb.metrics.headingKickDeg, 'heading kick < 12 deg', (kerb.metrics.headingKickDeg as number) < 12);
    report.check('rough.boulder.heading', boulder.metrics.headingKickDeg, 'heading kick < 30 deg, no spin', (boulder.metrics.headingKickDeg as number) < 30 && boulder.metrics.spun === false);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// m. hill lap — 2 laps of the real hills track with the path-following driver.

const LAP_STYLES: Record<string, Partial<DriverParams>> = {
  // Leaves margin everywhere and squeezes the throttle (half pedal, gentle
  // gains): a competent rival AI / careful player. The legacy car laps
  // cleanly like this, so "0 excursions" is an attainable band.
  fast: { cornerGrip: 0.5, brakeGrip: 0.4, accelGrip: 0.4, maxThrottle: 0.5, speedKp: 0.15, speedKi: 0.1, reactionDelay: 0.15 },
  // Plans to use nearly all of the declared grip and stamps on the pedals:
  // an attacking player with human reactions.
  aggressive: { cornerGrip: 0.85, brakeGrip: 0.7, accelGrip: 0.8, reactionDelay: 0.15 },
};

async function hillLapCase(env: LabEnv, style: string) {
  const spec: WorldSpec = { kind: 'hills', seed: env.seed };
  return runCase(env, style, spec, async (sim: Sim) => {
    const track = sim.world.track!;
    const driver = sim.makeDriver(LAP_STYLES[style]);
    const plan = new PathPlan(track.points, planOptions(driver.car, driver.params, true));
    const n = plan.count;
    sim.place({ x: track.points[0], z: track.points[1], yaw: Math.atan2(track.tangents[0], track.tangents[1]) });
    await sim.run(0.5);
    sim.useDriver(driver);
    driver.followPath(plan);
    sim.resetTrack();

    const LAPS = 2;
    let progress = 0;
    let lastIndex = 0;
    const lapTimes: number[] = [];
    let lapStart = sim.time;
    let offRoad = false;
    let excursions = 0;
    let offTime = 0;
    let maxOffset = 0;
    let spinning = false;
    let spins = 0;
    let rollovers = 0;
    let stuck = 0;
    let lost = 0;
    let slowTime = 0;
    let tiltTime = 0;
    let distance = 0;
    const t0 = sim.time;
    // Debug trail: where and how each excursion started (first 8).
    const notes: string[] = [];
    let excStart = { t: 0, index: 0, speed: 0, planned: 0, tilt: 0, off: 0 };
    let excMax = 0;

    const respawn = () => {
      // Like the game would: back on the road a little further on, stopped.
      const i = (driver.lastPathIndex + 3) % n;
      const j = (i + 1) % n;
      sim.place({
        x: plan.points[i * 2],
        z: plan.points[i * 2 + 1],
        yaw: Math.atan2(plan.points[j * 2] - plan.points[i * 2], plan.points[j * 2 + 1] - plan.points[i * 2 + 1]),
      });
      sim.useDriver(driver);
      driver.followPath(plan);
      slowTime = 0;
      tiltTime = 0;
      offRoad = false;
    };

    await sim.run(240, (tel) => {
      const index = driver.lastPathIndex;
      sim.aux = driver.lastPathOffset;
      let delta = index - lastIndex;
      if (delta > n / 2) delta -= n;
      else if (delta < -n / 2) delta += n;
      progress += delta;
      lastIndex = index;
      distance += tel.speed * sim.dt;
      while (progress >= (lapTimes.length + 1) * n) {
        lapTimes.push(tel.t - lapStart);
        lapStart = tel.t;
      }
      if (lapTimes.length >= LAPS) return true;

      const offset = Math.abs(driver.lastPathOffset);
      maxOffset = Math.max(maxOffset, offset);
      // Car CENTRE beyond the drivable half-width (hysteresis 0.5 m).
      if (!offRoad && offset > track.halfWidth) {
        offRoad = true;
        excursions++;
        excStart = { t: tel.t - t0, index, speed: tel.speed, planned: plan.speed[index], tilt: tel.tilt * DEG, off: tel.wheelsOff };
        excMax = offset;
      } else if (offRoad && offset < track.halfWidth - 0.5) {
        offRoad = false;
        if (notes.length < 8) {
          notes.push(
            `excursion t=${excStart.t.toFixed(1)}s point ${excStart.index}/${n}: speed ${excStart.speed.toFixed(1)} ` +
            `(plan ${excStart.planned.toFixed(1)}), curvature R=${(1 / Math.max(1e-3, Math.abs(plan.curvature[excStart.index]))).toFixed(0)} m, ` +
            `tilt ${excStart.tilt.toFixed(0)} deg, wheels off ${excStart.off}, max offset ${excMax.toFixed(1)} m, ` +
            `lasted ${(tel.t - t0 - excStart.t).toFixed(1)} s`,
          );
        }
      }
      if (offRoad) excMax = Math.max(excMax, offset);
      if (offRoad) offTime += sim.dt;

      const spun = Math.abs(tel.beta) > Math.PI / 2 && tel.speed > 3;
      if (spun && !spinning) spins++;
      spinning = spun;

      tiltTime = tel.tilt > 75 * RAD ? tiltTime + sim.dt : 0;
      if (tiltTime > 1.0) {
        rollovers++;
        respawn();
        return false;
      }
      slowTime = tel.speed < 0.7 && tel.t - t0 > 2 ? slowTime + sim.dt : 0;
      if (slowTime > 2.5) {
        stuck++;
        respawn();
        return false;
      }
      if (offset > 25 || tel.y < -30) {
        lost++;
        respawn();
      }
      return stuck + rollovers + lost >= 8;
    });
    const total = sim.time - t0;
    return {
      style,
      terrain: sim.world.terrainSource,
      trackLength: plan.length,
      completed: lapTimes.length >= LAPS,
      lapsDone: lapTimes.length,
      lap1Time: lapTimes[0] ?? null,
      lap2Time: lapTimes[1] ?? null,
      totalTime: total,
      meanSpeed: distance / total,
      maxSpeed: sim.track.maxSpeed,
      offRoadExcursions: excursions,
      offRoadTime: offTime,
      maxPathOffset: maxOffset,
      spins,
      rollovers,
      stuck,
      lost,
      maxTiltDeg: sim.track.maxTilt * DEG,
      planMaxSpeed: Math.max(...plan.speed),
      planMinSpeed: Math.min(...plan.speed),
      excursionLog: notes.join(' | '),
    };
  });
}

export const hillLap: ManeuverDef = {
  name: 'hillLap',
  title: 'm. hill lap: 2 laps of the hills track, driver "fast" and "aggressive"',
  async run(env) {
    const report = new Report();
    for (const style of ['fast', 'aggressive']) {
      const c = await hillLapCase(env, style);
      report.cases.push(c);
      const m = c.metrics;
      for (const key of ['completed', 'lap1Time', 'lap2Time', 'offRoadExcursions', 'spins', 'rollovers', 'stuck', 'lost', 'maxSpeed', 'meanSpeed']) {
        report.summary[`${style}.${key}`] = m[key];
      }
      report.check(`hillLap.${style}.completes`, m.completed, '2 laps completed', m.completed === true);
      report.check(`hillLap.${style}.rollovers`, m.rollovers, '0 rollovers', m.rollovers === 0);
      report.check(`hillLap.${style}.stuck`, (m.stuck as number) + (m.lost as number), '0 stuck / lost', m.stuck === 0 && m.lost === 0);
      report.check(`hillLap.${style}.spins`, m.spins, style === 'fast' ? '0 spins' : '<= 1 spin', (m.spins as number) <= (style === 'fast' ? 0 : 1));
      if (style === 'fast') {
        report.check('hillLap.fast.onRoad', m.offRoadExcursions, '0 off-road excursions', m.offRoadExcursions === 0);
      }
    }
    return report.output();
  },
};
