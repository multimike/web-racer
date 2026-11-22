import { DEG } from '../sim';
import type { LabEnv, Sim } from '../sim';
import type { MetricValue } from '../types';
import { FLAT, Report, fitCircle, mean, runCase, std } from './common';
import type { ManeuverDef } from './common';

// ---------------------------------------------------------------------------
// a. launch — standing start, full throttle, hands off the stick.

export async function launchCase(env: LabEnv, dt: number = env.dt) {
  return runCase(env, `dt${Math.round(1 / dt)}`, FLAT, async (sim: Sim) => {
    sim.place({ x: 0, z: 0, yaw: 0 });
    await sim.run(1.0);
    const restY = sim.tel.y;
    const yaw0 = sim.tel.yaw;
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    sim.resetTrack();
    sim.useScript([{ t: 0, throttle: 1 }]);
    const t0 = sim.time;
    let t10: number | null = null;
    let t20: number | null = null;
    let top = 0;
    let peakSlip = 0;
    let spinTime = 0;
    let maxDrift = 0;
    let maxOffset = 0;
    let tTop: number | null = null;
    const speedLog: number[] = [];
    await sim.run(14, (tel) => {
      const t = tel.t - t0;
      if (t10 === null && tel.vFwd >= 10) t10 = t;
      if (t20 === null && tel.vFwd >= 20) t20 = t;
      if (tel.vFwd > top) top = tel.vFwd;
      // Slip ratio of the driven wheels, 0 (rolling) .. 1 (spinning in place).
      const rim = sim.vehicle.drivenRimSpeed;
      const slip = (rim - tel.vFwd) / Math.max(Math.abs(rim), Math.abs(tel.vFwd), 1);
      if (slip > peakSlip) peakSlip = slip;
      if (slip > 0.2) spinTime += sim.dt;
      maxDrift = Math.max(maxDrift, Math.abs(tel.yaw - yaw0));
      maxOffset = Math.max(maxOffset, Math.abs(tel.x - x0));
      speedLog.push(tel.vFwd);
    });
    // Top speed = mean over the last 2 s (the peak can be a one-frame spike).
    const tail = speedLog.slice(-Math.round(2 / sim.dt));
    const settled = mean(tail);
    tTop = null;
    for (let i = 0; i < speedLog.length; i++) {
      if (speedLog[i] >= 0.95 * settled) {
        tTop = (i + 1) * sim.dt;
        break;
      }
    }
    const metrics: Record<string, MetricValue> = {
      restHeight: restY,
      t10,
      t20,
      topSpeed: settled,
      peakSpeed: top,
      timeTo95Top: tTop,
      distance: sim.tel.z - z0,
      // Mean 0→10 m/s acceleration as a fraction of scene g.
      launchG: t10 !== null ? 10 / t10 / sim.gravity : null,
      peakWheelspin: peakSlip,
      wheelspinTime: spinTime,
      headingDriftDeg: maxDrift * DEG,
      lateralOffset: maxOffset,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
      maxWheelsOff: sim.track.maxWheelsOff,
    };
    return metrics;
  }, dt);
}

export const launch: ManeuverDef = {
  name: 'launch',
  title: 'a. launch: 0 → top speed, full throttle, hands-off',
  async run(env) {
    const report = new Report();
    const c = await launchCase(env);
    report.cases.push(c);
    const m = c.metrics;
    Object.assign(report.summary, m);
    report.check('launch.reaches10', m.t10, 'reaches 10 m/s', m.t10 !== null);
    report.check('launch.headingDrift', m.headingDriftDeg, '< 1 deg', (m.headingDriftDeg as number) < 1);
    const per100 = ((m.lateralOffset as number) / Math.max(1, m.distance as number)) * 100;
    report.summary.lateralOffsetPer100m = per100;
    report.check('launch.lateralOffset', per100, '< 1 m sideways per 100 m travelled', per100 < 1);
    report.check('launch.noWheelie', m.maxPitchDeg, 'pitch < 12 deg', (m.maxPitchDeg as number) < 12);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// b. brake — full brake from 20 m/s, hands off the stick.

export async function brakeCase(env: LabEnv, v0 = 20, dt: number = env.dt) {
  return runCase(env, `v${v0}`, FLAT, async (sim: Sim) => {
    sim.place({ x: 0, z: 0, yaw: 0, speed: v0 });
    const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
    driver.holdSpeed(v0, 0);
    await sim.run(2.0);
    const entrySpeed = sim.tel.vFwd;
    const yaw0 = sim.tel.yaw;
    const x0 = sim.tel.x;
    const z0 = sim.tel.z;
    sim.resetTrack();
    sim.useScript([{ t: 0, throttle: 0, brake: 1, steering: 0 }]);
    let peakDecel = 0;
    let maxYaw = 0;
    let maxOffset = 0;
    let lockTime = 0;
    let stopTime: number | null = null;
    const t0 = sim.time;
    await sim.run(8, (tel) => {
      peakDecel = Math.max(peakDecel, -tel.aLong);
      maxYaw = Math.max(maxYaw, Math.abs(tel.yaw - yaw0));
      maxOffset = Math.max(maxOffset, Math.abs(tel.x - x0));
      if (tel.speed > 3) {
        for (const w of sim.vehicle.wheelStates) {
          if (Math.abs(w.spinSpeed * w.radius) < 0.3 * tel.speed) {
            lockTime += sim.dt;
            break;
          }
        }
      }
      // Stop at 0.6 m/s: below 0.5 the legacy brake pedal turns into reverse.
      if (tel.speed < 0.6) {
        stopTime = tel.t - t0;
        return true;
      }
      return false;
    });
    const distance = Math.hypot(sim.tel.z - z0, sim.tel.x - x0);
    // Hand physics: a locked or perfectly modulated tire stops in v²/(2·mu·g).
    const ideal = (entrySpeed * entrySpeed) / (2 * sim.mug);
    return {
      entrySpeed,
      stopped: stopTime !== null,
      stopTime,
      distance,
      idealDistance: ideal,
      efficiency: ideal / distance,
      meanDecelG: (entrySpeed * entrySpeed) / (2 * distance) / sim.gravity,
      peakDecelG: peakDecel / sim.gravity,
      nominalMu: sim.vehicle.nominalGrip,
      headingDevDeg: maxYaw * DEG,
      lateralOffset: maxOffset,
      lockupTime: lockTime,
      spun: maxYaw > Math.PI / 4,
      maxPitchDeg: sim.track.maxAbsPitch * DEG,
    };
  }, dt);
}

export const brake: ManeuverDef = {
  name: 'brake',
  title: 'b. brake: full brake from 20 m/s',
  async run(env) {
    const report = new Report();
    const c = await brakeCase(env);
    report.cases.push(c);
    const m = c.metrics;
    Object.assign(report.summary, m);
    report.check('brake.stops', m.stopped, 'stops within 8 s', m.stopped === true);
    report.check('brake.efficiency', m.efficiency, 'ideal v^2/(2 mu g) / measured >= 0.80', (m.efficiency as number) >= 0.8);
    report.check('brake.headingDev', m.headingDevDeg, '< 3 deg', (m.headingDevDeg as number) < 3);
    report.check('brake.noSpin', m.spun, 'no spin under lockup', m.spun === false);
    return report.output();
  },
};

// ---------------------------------------------------------------------------
// o. standstill / low speed.

export const standstill: ManeuverDef = {
  name: 'standstill',
  title: 'o. standstill & low speed: rest, creep, full lock, slope hold, reverse',
  async run(env) {
    const report = new Report();
    const S = report.summary;

    // --- rest: no drift, no jitter while "stopped"; wakes up on throttle.
    const rest = await runCase(env, 'rest', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(2.0);
      const x0 = sim.tel.x;
      const z0 = sim.tel.z;
      const y0 = sim.tel.y;
      const yaw0 = sim.tel.yaw;
      let maxSpeed = 0;
      let maxBounce = 0;
      await sim.run(5.0, (tel) => {
        maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
        maxBounce = Math.max(maxBounce, Math.abs(tel.y - y0));
      });
      const drift = Math.hypot(sim.tel.x - x0, sim.tel.z - z0);
      const yawDrift = Math.abs(sim.tel.yaw - yaw0) * DEG;
      // After 7 s at rest Havok has put the bodies to sleep: does a throttle
      // press still move the car? (A sleeping body ignores motor changes.)
      sim.useScript([{ t: 0, throttle: 1 }]);
      await sim.run(1.0);
      return {
        restDrift: drift,
        restYawDriftDeg: yawDrift,
        restJitterSpeed: maxSpeed,
        restBounce: maxBounce,
        wakeSpeedAfter1s: sim.tel.vFwd,
      };
    });
    report.cases.push(rest);
    Object.assign(S, rest.metrics);
    report.check('standstill.restDrift', rest.metrics.restDrift, '< 0.02 m over 5 s', (rest.metrics.restDrift as number) < 0.02);
    report.check('standstill.restJitter', rest.metrics.restJitterSpeed, '< 0.02 m/s', (rest.metrics.restJitterSpeed as number) < 0.02);
    report.check('standstill.wakes', rest.metrics.wakeSpeedAfter1s, '> 3 m/s 1 s after throttle from sleep', (rest.metrics.wakeSpeedAfter1s as number) > 3);

    // --- creep: hold 1 m/s.
    const creep = await runCase(env, 'creep', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      // Feathered throttle, as a human creeps: low gains.
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1, speedKp: 0.1, speedKi: 0.15 }));
      driver.holdSpeed(1.0, 0);
      await sim.run(4.0);
      const speeds: number[] = [];
      let maxYawRate = 0;
      await sim.run(4.0, (tel) => {
        speeds.push(tel.vFwd);
        maxYawRate = Math.max(maxYawRate, Math.abs(tel.yawRate));
      });
      return {
        creepSpeedMean: mean(speeds),
        creepSpeedStd: std(speeds),
        creepMaxYawRateDeg: maxYawRate * DEG,
      };
    });
    report.cases.push(creep);
    Object.assign(S, creep.metrics);
    report.check('standstill.creepHolds', creep.metrics.creepSpeedMean, '1.0 +- 0.25 m/s', Math.abs((creep.metrics.creepSpeedMean as number) - 1) < 0.25);
    report.check('standstill.creepSmooth', creep.metrics.creepSpeedStd, 'std < 0.15 m/s', (creep.metrics.creepSpeedStd as number) < 0.15);

    // --- full-lock circle at walking pace: measured vs commanded radius.
    const lock = await runCase(env, 'fullLock', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1, speedKp: 0.1, speedKi: 0.15 }));
      driver.holdSpeed(2.5, null, 1);
      await sim.run(4.0);
      // Kinematic radius of the chassis origin (wheelbase centre):
      // rear-axle-centre radius R = L / tan(delta), origin sits L/2 ahead.
      const L = sim.vehicle.wheelbase;
      const rRear = L / Math.tan(sim.vehicle.maxSteerAngle);
      const commanded = Math.hypot(rRear, L / 2);
      const xs: number[] = [];
      const zs: number[] = [];
      const yawStart = sim.tel.yaw;
      // One full turn (or 40 s).
      await sim.run(40, (tel) => {
        xs.push(tel.x);
        zs.push(tel.z);
        return Math.abs(tel.yaw - yawStart) >= 2 * Math.PI;
      });
      const fit = fitCircle(xs, zs);
      return {
        lockCommandedRadius: commanded,
        lockMeasuredRadius: fit.r,
        lockRadiusError: fit.r / commanded - 1,
        lockRadiusRms: fit.rms,
        lockSpeed: sim.tel.speed,
        // Did the hubs actually reach the commanded lock? (bicycle angle vs
        // the mean of the two measured front wheel angles)
        lockCommandedSteerDeg: sim.vehicle.maxSteerAngle * DEG,
        lockActualSteerDeg: ((sim.vehicle.wheelStates[0].steerAngle + sim.vehicle.wheelStates[1].steerAngle) / 2) * DEG,
        lockCircleCompleted: Math.abs(sim.tel.yaw - yawStart) >= 2 * Math.PI,
        // + = turned right for stick +1 (sign convention check).
        lockTurnDirection: Math.sign(sim.tel.yaw - yawStart),
      };
    });
    report.cases.push(lock);
    Object.assign(S, lock.metrics);
    report.check('standstill.lockRadius', lock.metrics.lockRadiusError, 'within +-10 % of commanded', Math.abs(lock.metrics.lockRadiusError as number) < 0.1);
    report.check('standstill.steerSign', lock.metrics.lockTurnDirection, 'stick +1 turns right (+1)', lock.metrics.lockTurnDirection === 1);

    // --- 15 degree slope: stop with the brake and hold; then hands-off.
    const slopeSpec = {
      kind: 'flat' as const,
      obstacles: [{ type: 'ramp' as const, x: 0, z: 12, angleDeg: 15, width: 14, length: 40 }],
    };
    const climbAndStop = async (sim: Sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(0.5);
      const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.1 }));
      driver.holdSpeed(4, 0);
      // Climb until the wheelbase centre is 10 m onto the slope.
      const reached = await sim.run(15, (tel) => tel.z > 12 + 10);
      sim.useScript([{ t: 0, throttle: 0, brake: 1, steering: 0 }]);
      let stopped = false;
      await sim.run(3, (tel) => {
        stopped = Math.abs(tel.vFwd) < 0.15;
        return stopped;
      });
      return { reached, stopped };
    };
    const measureHold = async (sim: Sim) => {
      const p0 = { x: sim.tel.x, y: sim.tel.y, z: sim.tel.z };
      let maxSpeed = 0;
      // `drift` counts from the frame the car first reads "stopped", so it
      // includes the rock-back on tire and suspension springs as the stop
      // completes (about 4 cm; whether that frame falls before or after it
      // is a matter of phase). `creep` is what a failing hold looks like:
      // movement from 1 s after the stop on.
      let p1: { x: number; y: number; z: number } | null = null;
      const t0 = sim.time;
      await sim.run(5, (tel) => {
        maxSpeed = Math.max(maxSpeed, Math.hypot(tel.speed, tel.vy));
        if (p1 === null && tel.t - t0 >= 1) p1 = { x: tel.x, y: tel.y, z: tel.z };
      });
      const q = p1 ?? p0;
      return {
        drift: Math.hypot(sim.tel.x - p0.x, sim.tel.y - p0.y, sim.tel.z - p0.z),
        creep: Math.hypot(sim.tel.x - q.x, sim.tel.y - q.y, sim.tel.z - q.z),
        maxSpeed,
      };
    };
    // Brake held for 5 s after stopping on the slope.
    const slope = await runCase(env, 'slope15.brakeHeld', slopeSpec, async (sim) => {
      const { reached, stopped } = await climbAndStop(sim);
      const hold = await measureHold(sim);
      return {
        slopeReached: reached,
        slopeStopped: stopped,
        slopeHoldDrift: hold.drift,
        slopeHoldCreep: hold.creep,
        slopeHoldMaxSpeed: hold.maxSpeed,
        slopeBrakeBecameReverse: sim.vehicle.isReversing,
      };
    });
    report.cases.push(slope);
    Object.assign(S, slope.metrics);
    // Hands and feet off after stopping on the slope.
    const slopeOff = await runCase(env, 'slope15.handsOff', slopeSpec, async (sim) => {
      await climbAndStop(sim);
      sim.useFixed({});
      const hold = await measureHold(sim);
      return { slopeHandsOffDrift: hold.drift, slopeHandsOffMaxSpeed: hold.maxSpeed };
    });
    report.cases.push(slopeOff);
    Object.assign(S, slopeOff.metrics);
    report.check('standstill.slopeClimb', slope.metrics.slopeReached, 'climbs a 15 deg slope', slope.metrics.slopeReached === true);
    report.check('standstill.slopeHold', slope.metrics.slopeHoldDrift, 'brake holds: < 0.05 m in 5 s', (slope.metrics.slopeHoldDrift as number) < 0.05);
    report.check('standstill.slopeCreep', slope.metrics.slopeHoldCreep, 'brake holds: < 0.01 m of creep from 1 s to 5 s after the stop', (slope.metrics.slopeHoldCreep as number) < 0.01);

    // --- reverse engage from rest, then forward again.
    const reverse = await runCase(env, 'reverse', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0 });
      await sim.run(1.0);
      sim.useScript([{ t: 0, brake: 1 }]);
      let tRev: number | null = null;
      const t0 = sim.time;
      let minSpeed = 0;
      let maxYaw = 0;
      await sim.run(3.0, (tel) => {
        if (tRev === null && tel.vFwd <= -1) tRev = tel.t - t0;
        minSpeed = Math.min(minSpeed, tel.vFwd);
        maxYaw = Math.max(maxYaw, Math.abs(tel.yaw));
      });
      const reverseSpeed = sim.tel.vFwd;
      sim.useScript([{ t: 0, brake: 0, throttle: 1 }]);
      let tFwd: number | null = null;
      const t1 = sim.time;
      await sim.run(3.0, (tel) => {
        if (tFwd === null && tel.vFwd >= 1) tFwd = tel.t - t1;
        maxYaw = Math.max(maxYaw, Math.abs(tel.yaw));
      });
      return {
        reverseEngageTime: tRev,
        reverseSpeedAfter3s: reverseSpeed,
        reverseToForwardTime: tFwd,
        reverseHeadingDevDeg: maxYaw * DEG,
      };
    });
    report.cases.push(reverse);
    Object.assign(S, reverse.metrics);
    report.check('standstill.reverseEngages', reverse.metrics.reverseEngageTime, 'reaches -1 m/s within 1 s', reverse.metrics.reverseEngageTime !== null && (reverse.metrics.reverseEngageTime as number) < 1);
    report.check('standstill.forwardAgain', reverse.metrics.reverseToForwardTime, 'forward again within 2 s', reverse.metrics.reverseToForwardTime !== null && (reverse.metrics.reverseToForwardTime as number) < 2);
    report.check('standstill.reverseStraight', reverse.metrics.reverseHeadingDevDeg, '< 3 deg heading change', (reverse.metrics.reverseHeadingDevDeg as number) < 3);

    return report.output();
  },
};
