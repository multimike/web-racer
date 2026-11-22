/**
 * Small probes used while investigating break-test findings:
 *   hxDebug    plain respawn at several headings (yaw error, drift)
 *   hxGarbage  NaN / Infinity / out-of-range stick and pedal values, update()
 *              called with dt = 0 / NaN / negative, a 1 s frame
 */
import { DEG } from '../sim';
import { FLAT, Report, runCase } from '../maneuvers/common';
import { Extremes } from './kit';
import type { ManeuverDef } from '../maneuvers/common';

export const hxDebug: ManeuverDef = {
  name: 'hxDebug',
  title: 'hx. debug probes',
  async run(env) {
    const report = new Report();
    for (const mess of ['none', 'lockRight', 'lockLeft', 'straight'] as const) {
      for (const yawDeg of [-180, -100, 0, 61]) {
        const c = await runCase(env, `respawnYaw.${mess}.${yawDeg}`, FLAT, async (sim) => {
          sim.place({ x: 0, z: 0, yaw: 0 });
          await sim.run(0.5);
          if (mess === 'lockRight') sim.useFixed({ throttle: 1, steering: 1 });
          if (mess === 'lockLeft') sim.useFixed({ throttle: 1, steering: -1 });
          if (mess === 'straight') sim.useFixed({ throttle: 1 });
          await sim.run(0.45);
          const steerBefore = sim.vehicle.wheelStates[0].steerAngle * DEG;
          sim.useFixed({});
          const yaw = (yawDeg * Math.PI) / 180;
          sim.place({ x: 5, z: 5, yaw });
          const log: string[] = [];
          let n = 0;
          await sim.run(0.65, (tel) => {
            if (n++ < 6 || n % 10 === 0) log.push(`${(tel.yaw * DEG - yawDeg).toFixed(1)}@${tel.yawRate.toFixed(2)}`);
          });
          return {
            steerBeforeDeg: steerBefore,
            yawErrorDeg: sim.tel.yaw * DEG - yawDeg,
            drift: Math.hypot(sim.tel.x - 5, sim.tel.z - 5),
            hubSteerAfterDeg: sim.vehicle.wheelStates[0].steerAngle * DEG,
            log: log.join(' '),
          };
        });
        delete c.series;
        report.cases.push(c);
      }
    }
    return report.output();
  },
};

export const hxGarbage: ManeuverDef = {
  name: 'hxGarbage',
  title: 'hx. garbage in: NaN / Infinity / out-of-range inputs, bad dt',
  async run(env) {
    const report = new Report();
    const feeds: Array<[string, { throttle: number; steering: number; brake: number }]> = [
      ['nan', { throttle: NaN, steering: NaN, brake: NaN }],
      ['inf', { throttle: Infinity, steering: -Infinity, brake: 0 }],
      ['range', { throttle: 7, steering: -3, brake: -2 }],
      ['nanSteerFullThrottle', { throttle: 1, steering: NaN, brake: 0 }],
      ['nanBrake', { throttle: 0, steering: 0.5, brake: NaN }],
    ];
    for (const [id, intent] of feeds) {
      const c = await runCase(env, `garbage.${id}`, FLAT, async (sim) => {
        sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
        sim.useFixed({ throttle: 0.3 });
        await sim.run(0.5);
        const ex = new Extremes(sim);
        const v0 = sim.tel.speed;
        sim.useFixed(intent);
        await sim.run(1.5, () => ex.sample());
        const vMid = sim.tel.speed;
        const yawMid = sim.tel.yaw * DEG;
        // Back to sane inputs: does the car still answer?
        sim.useFixed({ throttle: 1 });
        await sim.run(1.5, () => ex.sample());
        return { speedBefore: v0, speedAfterGarbage: vMid, yawAfterGarbageDeg: yawMid, speedAfterRecovery: sim.tel.speed, ...ex.metrics() };
      });
      delete c.series;
      report.cases.push(c);
      report.check(`hxGarbage.${id}`, c.metrics.finite, 'stays finite and drives on', c.metrics.finite === true && (c.metrics.speedAfterRecovery as number) > 15);
    }
    const dtCase = await runCase(env, 'garbage.dt', FLAT, async (sim) => {
      sim.place({ x: 0, z: 0, yaw: 0, speed: 15 });
      sim.useFixed({ throttle: 0.5, steering: 0.3 });
      await sim.run(0.5);
      const ex = new Extremes(sim);
      // update() called directly with nonsense between normal frames.
      for (const dt of [0, NaN, -0.016, 1e-9]) {
        sim.vehicle.update(dt);
        sim.step();
        ex.sample();
      }
      const v1 = sim.tel.speed;
      // One whole-second frame (tab was in the background, no clamp).
      const s = sim as unknown as { dt: number };
      const keep = s.dt;
      s.dt = 0.1;
      for (let i = 0; i < 10; i++) {
        sim.step();
        ex.sample();
      }
      s.dt = keep;
      await sim.run(1.5, () => ex.sample());
      return { speedAfterBadDt: v1, speedEnd: sim.tel.speed, tiltEndDeg: sim.tel.tilt * DEG, ...ex.metrics() };
    });
    delete dtCase.series;
    report.cases.push(dtCase);
    report.check('hxGarbage.dt', dtCase.metrics.finite, 'stays finite', dtCase.metrics.finite === true);
    return report.output();
  },
};
