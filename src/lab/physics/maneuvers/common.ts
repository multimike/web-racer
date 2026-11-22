import type { CaseResult, Check, ManeuverResult, MetricValue } from '../types';
import { Sim, round } from '../sim';
import type { LabEnv } from '../sim';
import type { WorldSpec } from '../world';

export const FLAT: WorldSpec = { kind: 'flat' };

/** What a maneuver's run() hands back; the runner adds name/timing/pass. */
export type ManeuverOutput = Pick<ManeuverResult, 'cases' | 'summary' | 'checks'>;

export interface ManeuverDef {
  /** URL name (?suite=launch,brake,...). */
  name: string;
  title: string;
  run(env: LabEnv): Promise<ManeuverOutput>;
}

/** Collects cases, headline numbers and pass/fail checks of one maneuver. */
export class Report {
  readonly cases: CaseResult[] = [];
  readonly checks: Check[] = [];
  readonly summary: Record<string, MetricValue> = {};

  /** Record a judgement. `pass` null/undefined value always fails. */
  check(id: string, value: MetricValue, target: string, pass: boolean): void {
    this.checks.push({ id, value: typeof value === 'number' ? round(value, 3) : value, target, pass });
  }

  output(): ManeuverOutput {
    return { cases: this.cases, summary: this.summary, checks: this.checks };
  }
}

/**
 * Run one case in a fresh world: build the Sim, hand it to `body`, keep the
 * 10 Hz series, dispose. Numbers in the returned metrics are rounded to 4
 * significant decimals so the JSON stays readable (and diffable).
 */
export async function runCase(
  env: LabEnv,
  id: string,
  spec: WorldSpec,
  body: (sim: Sim) => Promise<Record<string, MetricValue>>,
  dt: number = env.dt,
): Promise<CaseResult> {
  const sim = new Sim(env, spec, dt);
  try {
    const raw = await body(sim);
    const metrics: Record<string, MetricValue> = {};
    for (const [key, value] of Object.entries(raw)) {
      metrics[key] = typeof value === 'number' ? round(value, 4) : value;
    }
    const result: CaseResult = { id, metrics };
    if (env.keepSeries) result.series = sim.series;
    return result;
  } finally {
    sim.dispose();
    // Let the page breathe (status line, CDP polling) between cases.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export function num(value: MetricValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function std(values: number[]): number {
  if (values.length === 0) return NaN;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / values.length);
}

/** Least-squares slope of y over x. */
export function slope(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

/**
 * Least-squares circle through points (Kasa fit): solves
 * x² + z² = 2a·x + 2b·z + c. Returns centre, radius and the RMS radial error.
 */
export function fitCircle(xs: number[], zs: number[]): { cx: number; cz: number; r: number; rms: number } {
  const n = xs.length;
  const mx = mean(xs);
  const mz = mean(zs);
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx;
    const v = zs[i] - mz;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (n < 3 || Math.abs(det) < 1e-12) return { cx: NaN, cz: NaN, r: NaN, rms: NaN };
  const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det;
  const vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const cx = uc + mx;
  const cz = vc + mz;
  let err = 0;
  for (let i = 0; i < n; i++) err += (Math.hypot(xs[i] - cx, zs[i] - cz) - r) ** 2;
  return { cx, cz, r, rms: Math.sqrt(err / n) };
}
