/**
 * xbTrace — a debugging probe, not a test: one obstacle strike with a
 * per-step trace in the summary, split into what the MODEL did to the chassis
 * velocity this frame (suspension / tire forces, integrated in update()) and
 * what HAVOK did to it in the step (hull contacts). Parameters from the URL:
 *   &probe=sc:0,v:20,h:0.5,a:18,from:-0.1,to:0.6
 *   sc   0 dome (radius h, half buried)   1 rock (radius 0.5, centre 0.2 up)
 *        2 half-on ramp of `a` degrees    3 sideways into a kerb `h` tall
 *        4 one-wheel kerb `h` tall        5 dome under the REAR-left wheel only
 *   v    approach speed, m/s
 *   from/to   trace window, seconds relative to reaching the obstacle
 */
import { Vector3 } from '@babylonjs/core';
import { Report, runCase } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { DEG } from '../sim';
import type { MetricValue } from '../types';
import type { WorldSpec } from '../world';
import { addBox } from './kit';

type Metrics = Record<string, MetricValue>;

function parse(): Record<string, number> {
  const out: Record<string, number> = { sc: 0, v: 20, h: 0.5, a: 18, from: -0.1, to: 0.6, thr: 0.5 };
  const text = new URLSearchParams(location.search).get('probe');
  if (text) {
    for (const pair of text.split(',')) {
      const [k, v] = pair.split(':');
      if (k && Number.isFinite(Number(v))) out[k] = Number(v);
    }
  }
  return out;
}

export const xbTrace: ManeuverDef = {
  name: 'xbTrace',
  title: 'xb: obstacle strike with a per-step model / Havok impulse trace (see trace.ts)',
  async run(env) {
    const report = new Report();
    const p = parse();
    const rows: string[] = [];
    const wheelX = env.rig ? env.rig.front.track / 2 : 0.84;
    const z = 60;
    let spec: WorldSpec = { kind: 'flat' };
    if (p.sc === 0) spec = { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: p.h, centerY: 0 }] };
    else if (p.sc === 1) spec = { kind: 'flat', obstacles: [{ type: 'boulder', x: -wheelX, z, radius: 0.5, centerY: 0.2 }] };
    else if (p.sc === 2) spec = { kind: 'flat', obstacles: [{ type: 'ramp', x: -3 - 0.1, z, angleDeg: p.a }] };
    else if (p.sc === 4) spec = { kind: 'flat', obstacles: [{ type: 'kerb', x: -wheelX, z, width: 1.0, depth: 0.4, height: p.h }] };
    const c = await runCase(env, 'trace', spec, async (sim): Promise<Metrics> => {
      const veh = sim.vehicle as unknown as {
        wheelLoad?: Float64Array; suspensionTravel?: Float64Array; staticLoad?: Float64Array;
      };
      const body = sim.vehicle.chassisBody;
      let tHit = z / p.v;
      if (p.sc === 3) {
        addBox(sim, 'Trip', [0, p.h / 2, 20.2], [40, p.h, 0.4]);
        const halfWidth = env.rig ? Math.max(env.rig.front.track + env.rig.front.tireWidth, env.rig.rear.track + env.rig.rear.tireWidth) / 2 : 1.05;
        sim.place({ x: 0, z: 20 - halfWidth - 0.5, yaw: Math.PI / 2, speed: p.v, beta: -Math.PI / 2 });
        sim.useFixed({});
        tHit = 0.5 / p.v;
      } else {
        sim.place({ x: 0, z: z - 1.5 * p.v, yaw: 0, speed: p.v });
        sim.useFixed({ throttle: p.thr });
        tHit = -1;
      }
      sim.resetTrack();
      const rest = sim.tel.y;
      const scene = sim.world.scene;
      const pre = new Vector3();
      const preW = new Vector3();
      const post = new Vector3();
      const postW = new Vector3();
      const before = new Vector3();
      const beforeW = new Vector3();
      const hook = scene.onBeforePhysicsObservable.add(() => {
        body.getLinearVelocityToRef(pre);
        body.getAngularVelocityToRef(preW);
      });
      const fmt = (v: Vector3) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
      let maxTilt = 0;
      const reach = (env.rig ? env.rig.wheelbase / 2 : 1.3) + 1.6;
      while (tHit < 0 || sim.time < tHit + p.to + 2) {
        if (tHit < 0 && (sim.tel.z > z - reach || sim.time > 5)) tHit = sim.time - p.from;
        body.getLinearVelocityToRef(before);
        body.getAngularVelocityToRef(beforeW);
        sim.step();
        body.getLinearVelocityToRef(post);
        body.getAngularVelocityToRef(postW);
        const tel = sim.tel;
        maxTilt = Math.max(maxTilt, tel.tilt);
        const rel = sim.time - tHit;
        if (rel >= p.from && rel <= p.to) {
          const load = veh.wheelLoad;
          const st = veh.staticLoad;
          const trav = veh.suspensionTravel;
          const loads = load && st ? Array.from(load, (l, i) => (l / st[i]).toFixed(1)).join('/') : '?';
          const travel = trav ? Array.from(trav, (t) => t.toFixed(2)).join('/') : '?';
          rows.push(
            `${rel.toFixed(3)} y=${(tel.y - rest).toFixed(2)} roll=${(tel.roll * DEG).toFixed(0)} pitch=${(tel.pitch * DEG).toFixed(0)} yaw=${(tel.yaw * DEG).toFixed(0)} ` +
            `| model dv=${fmt(pre.subtract(before))} dw=${fmt(preW.subtract(beforeW))} | havok dv=${fmt(post.subtract(pre))} dw=${fmt(postW.subtract(preW))} ` +
            `| v=${fmt(post)} w=${fmt(postW)} | load ${loads} travel ${travel}`,
          );
        }
      }
      scene.onBeforePhysicsObservable.remove(hook);
      return { maxTiltDeg: maxTilt * DEG, endTiltDeg: sim.tel.tilt * DEG, endYawDeg: sim.tel.yaw * DEG, endSpeed: sim.tel.speed };
    });
    delete c.series;
    report.cases.push(c);
    report.summary.trace = rows.join('\n');
    report.summary.maxTiltDeg = c.metrics.maxTiltDeg;
    report.summary.endTiltDeg = c.metrics.endTiltDeg;
    report.summary.endYawDeg = c.metrics.endYawDeg;
    return report.output();
  },
};
