/**
 * xdTrace — a debugging probe, not a test: one scripted run with a trace of
 * the slide state in the summary. Everything is a RIGHT-hand situation, so
 * stick + = INTO the turn, - = opposite lock; "b" in the trace is the slide
 * angle (deg, + = tail out in a right turn).
 *
 *   &probe=init:0,v:15,beta:35,...   start state
 *     init 0  imposed slide: v, beta (deg), yr (yaw rate, share of mu*g/v;
 *             default: beta rad/s as the standard slideRecovery)
 *     init 1  steady circle: radius R at speed v for 2.5 s (path driver)
 *     init 2  at rest
 *   &keys=t:throttle:stick[:brake];t:...   input timeline (human ramps);
 *     in init 1 a stick written as "+0.5" is added to the cruise stick.
 *   &probe=...,secs:5,every:3       run length, trace every n-th step
 */
import { FLAT, Report, runCase } from '../maneuvers/common';
import type { ManeuverDef } from '../maneuvers/common';
import { circlePath } from '../paths';
import { DEG, RAD } from '../sim';
import type { ScriptKey } from '../sim';
import type { MetricValue } from '../types';

type Metrics = Record<string, MetricValue>;

function parse(): Record<string, number> {
  const out: Record<string, number> = { init: 0, v: 15, beta: 35, yr: -1, R: 20, secs: 5, every: 3 };
  const text = new URLSearchParams(location.search).get('probe');
  if (text) {
    for (const pair of text.split(',')) {
      const [k, v] = pair.split(':');
      if (k && Number.isFinite(Number(v))) out[k] = Number(v);
    }
  }
  return out;
}

export const xdTrace: ManeuverDef = {
  name: 'xdTrace',
  title: 'xd: scripted slide with a trace (see driftProbe.ts)',
  async run(env) {
    const report = new Report();
    const p = parse();
    const keyText = new URLSearchParams(location.search).get('keys') ?? '0:0:0';
    const rows: string[] = [];
    const c = await runCase(env, 'trace', FLAT, async (sim): Promise<Metrics> => {
      let cruise = 0;
      if (p.init === 1) {
        sim.place({ x: 0, z: 0, yaw: 0, speed: p.v, yawRate: p.v / p.R });
        const driver = sim.useDriver(sim.makeDriver({ reactionDelay: 0.12, pathKp: 0.06, pathKi: 0.1 }));
        driver.followPath(circlePath(p.R, 1), p.v);
        await sim.run(2.5);
        cruise = sim.intent.steering;
      } else if (p.init === 2) {
        sim.place({ x: 0, z: 0, yaw: 0 });
        sim.useFixed({});
        await sim.run(0.5);
      } else {
        const b = p.beta * RAD;
        sim.place({ x: 0, z: 0, yaw: b, speed: p.v, beta: -b, yawRate: p.yr < 0 ? b : (p.yr * sim.mug) / p.v });
      }
      const keys: ScriptKey[] = [];
      for (const part of keyText.split(';')) {
        const f = part.split(':');
        if (f.length < 3) continue;
        const rel = f[2].startsWith('+') || f[2].startsWith(' ');
        const stick = Number(f[2]);
        keys.push({ t: Number(f[0]), throttle: Number(f[1]), steering: Math.max(-1, Math.min(1, rel ? cruise + stick : stick)), brake: f.length > 3 ? Number(f[3]) : 0 });
      }
      if (p.init === 0 && keys.length && keys[0].t === 0) sim.useFixed({ throttle: keys[0].throttle, steering: keys[0].steering, brake: keys[0].brake });
      sim.useScript(keys);
      sim.resetTrack();
      const veh = sim.vehicle as unknown as { debug?: Float64Array };
      const t0 = sim.time;
      let n = 0;
      await sim.run(p.secs, (tel) => {
        if (n++ % p.every === 0) {
          const d = veh.debug;
          const v = sim.vehicle;
          rows.push(
            `${(tel.t - t0).toFixed(2)} b=${(-tel.beta * DEG).toFixed(1)} yr=${(tel.yawRate * DEG).toFixed(0)} v=${tel.speed.toFixed(1)} ` +
            `thr=${tel.throttle.toFixed(2)} stk=${tel.steering.toFixed(2)} st=${(v.currentSteerAngle * DEG).toFixed(1)} rim=${v.drivenRimSpeed.toFixed(1)} ` +
            `ac=${(tel.aCent / sim.mug).toFixed(2)} al=${(tel.aLong / sim.mug).toFixed(2)}` +
            (d ? ` | sl=${d[0].toFixed(2)} rs=${(-d[1] * DEG).toFixed(1)} ft=${(-d[2] * DEG).toFixed(1)} grip=${d[3].toFixed(2)} gov=${d[4].toFixed(1)} dy=${(-d[5]).toFixed(2)} dx=${d[6].toFixed(2)} latch=${d[7].toFixed(2)} hold=${d[8].toFixed(2)} cg=${d[9].toFixed(2)}` : ''),
          );
        }
        return false;
      });
      return { endBetaDeg: -sim.tel.beta * DEG, endSpeed: sim.tel.speed };
    });
    delete c.series;
    report.cases.push(c);
    report.summary.trace = rows.join('\n');
    return report.output();
  },
};
