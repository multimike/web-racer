import type { LabEnv } from '../sim';
import type { MetricValue } from '../types';
import { Report, num } from './common';
import type { ManeuverDef } from './common';
import { launchCase } from './straight';
import { stepSteerCase } from './cornering';
import { slideRecoveryCase } from './sliding';

// ---------------------------------------------------------------------------
// n. frame-rate independence — the same three maneuvers at the physics steps
// the game really runs at: 30 Hz (hitch clamp), 60 (desktop), 72 / 90
// (Quest), 120 (ProMotion / high-refresh).

const RATES = [30, 60, 72, 90, 120];

/**
 * Metrics compared across rates: [case, metric key, floor, tolerance].
 * Spread = (max − min) / max(|mean|, floor): the floor stops a metric that
 * is ~0 at every rate (a 1° slip angle) from reading as a huge relative
 * spread. A metric passes if the spread is < 10 % OR (max − min) is within
 * `tolerance`, the harness's own resolution for that metric — measured on
 * the 'reference' model, whose physics is sub-stepped at 2 ms regardless of
 * the frame rate: it still shows 0.18 s of recovery-time scatter, purely
 * from the driver's hands and the 0.5 s "calm" window being sampled per
 * frame.
 */
const KEYS: Array<[string, string, number, number]> = [
  ['launch', 't10', 0.1, 0.04],
  ['launch', 't20', 0.1, 0.04],
  ['launch', 'topSpeed', 1, 0],
  ['stepSteer', 'yawRateSteadyDeg', 5, 0],
  ['stepSteer', 'betaPeakDeg', 5, 1.5],
  ['stepSteer', 'latSteadyFraction', 0.1, 0],
  ['slide', 'recoveryTime', 0.3, 0.25],
  ['slide', 'counterSwingDeg', 5, 1.5],
  ['slide', 'peakBetaDeg', 5, 2],
];

export const frameRate: ManeuverDef = {
  name: 'frameRate',
  title: 'n. frame-rate independence: launch, step-steer 100 % @ 15 m/s, slide recovery 35 deg at 30-120 Hz',
  async run(env: LabEnv) {
    const report = new Report();
    const table: Record<string, Array<MetricValue>> = {};
    // The throttle that holds 15 m/s, found once (driver, 60 Hz) and then
    // used open-loop at every rate: see stepSteerCase.
    const probe = await stepSteerCase(env, 15, 1.0, 1 / 60);
    const heldThrottle = (probe.metrics.heldThrottle as number | undefined) ?? 0.05;
    report.summary.stepSteerThrottle = heldThrottle;
    for (const hz of RATES) {
      const dt = 1 / hz;
      const runs = {
        launch: await launchCase(env, dt),
        stepSteer: await stepSteerCase(env, 15, 1.0, dt, heldThrottle),
        slide: await slideRecoveryCase(env, 35, 'driver', dt),
      };
      for (const [name, c] of Object.entries(runs)) {
        c.id = `${name}.hz${hz}`;
        // The series of 15 extra runs would double the JSON: keep metrics only.
        delete c.series;
        report.cases.push(c);
      }
      for (const [group, key] of KEYS) {
        (table[`${group}.${key}`] ??= []).push(runs[group as keyof typeof runs].metrics[key]);
      }
    }
    let worst = 0;
    let worstKey = '';
    for (const [group, key, floor, tolerance] of KEYS) {
      const id = `${group}.${key}`;
      const values = table[id].map(num);
      report.summary[`${id}.values`] = table[id].map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v))).join(' / ');
      let spread: number | null = null;
      if (values.every((v) => v !== null)) {
        const nums = values as number[];
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const range = Math.max(...nums) - Math.min(...nums);
        // Within the harness's own resolution counts as no spread at all.
        spread = range <= tolerance ? 0 : (range / Math.max(Math.abs(mean), floor)) * 100;
      }
      report.summary[`${id}.spreadPct`] = spread;
      // A metric that exists at some rates and not at others (e.g. recovers
      // at 60 Hz, spins at 30) is the worst kind of rate dependence.
      const consistent = values.every((v) => v === null) || spread !== null;
      const s = spread ?? (consistent ? 0 : 100);
      if (s > worst) {
        worst = s;
        worstKey = id;
      }
      report.check(`frameRate.${id}`, spread ?? (consistent ? 0 : 'inconsistent'), `spread across ${RATES.join('/')} Hz < 10 % (or within harness resolution)`, consistent && s < 10);
    }
    report.summary.rates = RATES.join(' / ');
    report.summary.worstSpreadPct = worst;
    report.summary.worstMetric = worstKey;
    return report.output();
  },
};
