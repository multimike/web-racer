/**
 * xpProbe — a debugging probe, not a test: one open-loop run from an imposed
 * slide, with a 20 Hz trace in the summary. Parameters come from the URL:
 *   &probe=v:12,beta:25,thr:0.7,stick:0.3,secs:5,lift:99,brake:0
 *   v      entry speed, m/s            beta   imposed slip angle, deg
 *   thr    fixed throttle              stick  fixed stick, + = INTO the turn
 *   lift   time the throttle is released at (default: never)
 *   yr     yaw rate as a share of mu*g/v (default 0.65)
 */
import { FLAT, Report, runCase } from '../maneuvers/common';
import { DEG, RAD } from '../sim';
import type { ManeuverDef } from '../maneuvers/common';
import type { MetricValue } from '../types';

type Metrics = Record<string, MetricValue>;

function parse(): Record<string, number> {
  const out: Record<string, number> = { v: 12, beta: 25, thr: 0.7, stick: 0, secs: 5, lift: 99, yr: 0.65, brake: 0 };
  const text = new URLSearchParams(location.search).get('probe');
  if (text) {
    for (const pair of text.split(',')) {
      const [k, v] = pair.split(':');
      if (k && Number.isFinite(Number(v))) out[k] = Number(v);
    }
  }
  return out;
}

export const xpProbe: ManeuverDef = {
  name: 'xpProbe',
  title: 'xp: open-loop probe with a trace (see probe.ts)',
  async run(env) {
    const report = new Report();
    const p = parse();
    const rows: string[] = [];
    const c = await runCase(env, 'probe', FLAT, async (sim): Promise<Metrics> => {
      const b = p.beta * RAD;
      sim.place({ x: 0, z: 0, yaw: b, speed: p.v, beta: -b, yawRate: p.beta === 0 ? 0 : (p.yr * sim.mug) / p.v });
      sim.useFixed({ throttle: p.thr, steering: p.stick, brake: p.brake });
      sim.resetTrack();
      let n = 0;
      await sim.run(p.secs, (tel) => {
        if (tel.t >= p.lift) sim.useFixed({ throttle: 0, steering: p.stick, brake: p.brake });
        if (n++ % 3 === 0) {
          const veh = sim.vehicle;
          const ws = veh.wheelStates;
          const rim = veh.drivenRimSpeed;
          rows.push(
            `${tel.t.toFixed(2)} b=${(-tel.beta * DEG).toFixed(1)} yr=${(tel.yawRate * DEG).toFixed(0)} v=${tel.speed.toFixed(1)} ` +
            `st=${(veh.currentSteerAngle * DEG).toFixed(1)} rim=${rim.toFixed(1)} slipR=${ws[2].slipSpeed.toFixed(1)}/${ws[3].slipSpeed.toFixed(1)} ` +
            `slipF=${ws[0].slipSpeed.toFixed(1)}/${ws[1].slipSpeed.toFixed(1)} ac=${(tel.aCent / sim.mug).toFixed(2)}`,
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

/**
 * xpGrid — drift map, no driver: from an imposed 25 deg slide, every
 * combination of a fixed throttle and a fixed stick (+ = INTO the turn) for
 * 5 s. Cell = slip angle over the last second (deg) and the speed at the end,
 * or how the slide ended ('-t' straightened after t s, 'S' spun past 60 deg,
 * 'x' stopped). `&probe=v:12` picks the entry speed (default both 12 and 18).
 */
export const xpGrid: ManeuverDef = {
  name: 'xpGrid',
  title: 'xp: open-loop drift map, throttle x stick',
  async run(env) {
    const report = new Report();
    const p = parse();
    const text = new URLSearchParams(location.search).get('probe') ?? '';
    const speeds = text.includes('v:') ? [p.v] : [12, 18];
    const sticks = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
    const throttles = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    let heldCells = 0;
    for (const v of speeds) {
      const lines: string[] = [`v=${v}  stick: ${sticks.map((s) => s.toFixed(2).padStart(9)).join('')}`];
      for (const thr of throttles) {
        let line = `thr ${thr.toFixed(1)}       `;
        for (const stick of sticks) {
          let cell = '';
          const c = await runCase(env, `grid.v${v}.t${thr}.s${stick}`, FLAT, async (sim): Promise<Metrics> => {
            const b = 25 * RAD;
            sim.place({ x: 0, z: 0, yaw: b, speed: v, beta: -b, yawRate: (0.65 * sim.mug) / v });
            sim.useFixed({ throttle: thr, steering: stick, brake: 0 });
            sim.resetTrack();
            let exit = '';
            let sum = 0;
            let n = 0;
            await sim.run(5, (tel) => {
              const slide = -tel.beta * DEG;
              if (tel.t > 4) {
                sum += slide;
                n++;
              }
              if (tel.speed < 3) exit = 'x';
              else if (slide < 8) exit = `-${tel.t.toFixed(1)}`;
              else if (slide > 60) exit = `S${tel.t.toFixed(1)}`;
              return exit !== '';
            });
            if (exit === '') {
              heldCells++;
              cell = `${Math.round(sum / Math.max(n, 1))}@${sim.tel.speed.toFixed(0)}`;
            } else {
              cell = exit;
            }
            return { held: exit === '' };
          });
          void c;
          line += cell.padStart(9);
        }
        lines.push(line);
      }
      report.summary[`map.v${v}`] = lines.join('\n');
    }
    report.summary.heldCells = heldCells;
    return report.output();
  },
};
