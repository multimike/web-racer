/** Result shapes of the physics lab (physics-lab.html). Plain JSON. */

export type MetricValue = number | boolean | string | null;

/** One pass/fail judgement against a target band. */
export interface Check {
  /** Unique within the run, e.g. 'slideRecovery.b35.time'. */
  id: string;
  /** What was measured. */
  value: MetricValue;
  /** Human-readable band, e.g. '< 1.6 s'. */
  target: string;
  pass: boolean;
}

/** 10 Hz debug time series, column-oriented (one array per channel). */
export interface Series {
  t: number[];
  x: number[];
  z: number[];
  /** deg */
  yaw: number[];
  speed: number[];
  /** deg/s */
  yawRate: number[];
  /** deg */
  beta: number[];
  steer: number[];
  throttle: number[];
  brake: number[];
  /** Maneuver-specific channel (lateral path offset in path-following tests). */
  aux: number[];
}

export interface CaseResult {
  /** e.g. 'v15.s100' */
  id: string;
  metrics: Record<string, MetricValue>;
  series?: Series;
  notes?: string[];
}

export interface ManeuverResult {
  name: string;
  cases: CaseResult[];
  /** Headline numbers (also used by the scorecard). */
  summary: Record<string, MetricValue>;
  checks: Check[];
  pass: boolean;
  /** Simulated seconds and wall-clock milliseconds spent. */
  simSeconds: number;
  wallMs: number;
  error?: string;
}

export interface LabResult {
  harness: string;
  model: string;
  car: string;
  suite: string[];
  dt: number;
  seed: number;
  /** ?tune= / ?driver= overrides in effect (empty for a standard run). */
  overrides: { tune: Record<string, number>; driver: Record<string, number> };
  gravity: number;
  /** Peak tire grip the model declares; metrics are normalised by mu·g. */
  nominalGrip: number;
  rig: Record<string, MetricValue>;
  /** Mass properties Havok reports for the chassis body (chassis frame). */
  chassisBody: Record<string, MetricValue>;
  tuning: Record<string, number>;
  maneuvers: Record<string, ManeuverResult>;
  scorecard: Scorecard;
  totals: { simSeconds: number; wallMs: number; steps: number };
  errors: string[];
}

export interface ScoreLine {
  group: string;
  item: string;
  /** Short value text for the table. */
  value: string;
  target: string;
  /** 0..1 */
  score: number;
  weight: number;
}

export interface Scorecard {
  /** 0..100 weighted total. */
  total: number;
  /** 0..1 share of the full scorecard that could be evaluated (1 = full suite). */
  coverage: number;
  /** Ids of the target-band checks that failed. */
  failingChecks: string[];
  groups: Array<{ group: string; weight: number; score: number }>;
  lines: ScoreLine[];
  /** Preformatted fixed-width table. */
  text: string;
}
