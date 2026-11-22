import { TrackFrame } from '../world/trackFrame';
import type { Track } from './track';

/**
 * The rules every generated loop must satisfy (CLAUDE.md, World, "TRACK
 * RULES"). `generateTrack` validates each candidate with `measureTrack` +
 * `trackViolations` and retries until one passes; the acceptance sweep
 * re-measures them independently.
 *
 * Curvature is the planner's (TrackFrame: smoothed over about ±6 m), so a
 * drawn straight reads 4–5 m shorter at each end and a drawn 10 m fillet can
 * read 9.4 m: the generator draws with margin.
 */
export interface TrackRules {
  minLength: number;
  maxLength: number;
  /** Smallest centreline radius anywhere, m (1 / max |TrackFrame.curv|). */
  minRadius: number;
  /** Straight road (|curv| ≤ straightCurvature) ahead of / behind the start line, m. */
  straightAhead: number;
  straightBehind: number;
  straightCurvature: number;
  /** Every centreline point within ±maxExtent in x and z (the bowl rim climbs from 72 m). */
  maxExtent: number;
  /** Points more than legGapArc apart along the loop are at least minLegGap apart on the map. */
  minLegGap: number;
  legGapArc: number;
  halfWidth: number;
  shoulder: number;
  pointSpacing: number;
  /** Road grade (rise / run) anywhere, and from straightBehind behind to straightAhead ahead of the line. */
  maxGrade: number;
  maxStartGrade: number;
}

export const TRACK_RULES: TrackRules = {
  minLength: 450,
  maxLength: 650,
  minRadius: 10,
  straightAhead: 40,
  straightBehind: 20,
  straightCurvature: 1 / 150,
  maxExtent: 64,
  minLegGap: 20,
  legGapArc: 40,
  halfWidth: 5,
  shoulder: 3,
  pointSpacing: 1.0,
  maxGrade: 0.12,
  maxStartGrade: 0.04,
};

/** Character of a loop: at least this many corners of radius 10–16 m, a
 * sweeper (radius ≥ 30 m) at least this long, corners both ways. */
export const TIGHT_CORNER_MAX_RADIUS = 16;
export const MIN_TIGHT_CORNERS = 2;
export const SWEEPER_MIN_RADIUS = 30;
export const MIN_SWEEPER_LENGTH = 15;
/** Bends are found as the planner signs them (BEND_RADIUS in src/world). */
const BEND_THRESHOLD = 1 / 22;

export interface TrackMetrics {
  length: number;
  minRadius: number;
  straightAhead: number;
  straightBehind: number;
  extent: number;
  /** Closest approach of two points more than legGapArc apart along the loop. */
  legGap: number;
  maxGrade: number;
  /** Largest grade from straightBehind behind to straightAhead ahead of the line. */
  startGrade: number;
  /** Bends (|curv| > 1/22) whose minimum radius is 10–16 m. */
  tightCorners: number;
  /** Longest run with 1/150 < |curv| ≤ 1/30, m. */
  sweeperLength: number;
  lefts: number;
  rights: number;
  /** Largest |road height − uncarved terrain| along the centreline, m (0 without `natural`). */
  maxCutFill: number;
}

/**
 * Measure a loop against the rules. `natural` is the terrain BEFORE the carve
 * (what generateTrack is handed); without it `maxCutFill` is 0.
 */
export function measureTrack(
  track: Track,
  worldSize = 200,
  natural?: { getHeight(x: number, z: number): number },
  rules: TrackRules = TRACK_RULES,
): TrackMetrics {
  const f = new TrackFrame(track, worldSize);
  const n = f.n;
  let maxK = 0;
  for (let i = 0; i < n; i++) maxK = Math.max(maxK, Math.abs(f.curv[i]));
  let ahead = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(f.curv[i]) > rules.straightCurvature) break;
    ahead = f.s[i + 1];
  }
  let behind = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(f.curv[i]) > rules.straightCurvature) break;
    behind = f.length - f.s[i];
  }
  let extent = 0;
  for (let i = 0; i < n; i++) extent = Math.max(extent, Math.abs(f.px[i]), Math.abs(f.pz[i]));
  // Brute force over every other point: the loop is ~600 points.
  let legGap = Infinity;
  for (let i = 0; i < n; i += 2) {
    for (let j = i + 2; j < n; j += 2) {
      const ds = Math.min(f.s[j] - f.s[i], f.length - (f.s[j] - f.s[i]));
      if (ds < rules.legGapArc) continue;
      const d = Math.hypot(f.px[i] - f.px[j], f.pz[i] - f.pz[j]);
      if (d < legGap) legGap = d;
    }
  }
  let maxGrade = 0;
  let startGrade = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const g = Math.abs(f.h[j] - f.h[i]) / Math.max(1e-6, f.s[i + 1] - f.s[i]);
    maxGrade = Math.max(maxGrade, g);
    if (f.s[i] <= rules.straightAhead || f.s[i] >= f.length - rules.straightBehind) startGrade = Math.max(startGrade, g);
  }
  const bends = f.findBends(BEND_THRESHOLD);
  let tightCorners = 0;
  let lefts = 0;
  for (const b of bends) {
    if (b.minRadius <= TIGHT_CORNER_MAX_RADIUS) tightCorners++;
    if (b.direction === 'left') lefts++;
  }
  let run = 0;
  let sweeperLength = 0;
  for (let i = 0; i < 2 * n; i++) {
    const k = Math.abs(f.curv[i % n]);
    run = k > rules.straightCurvature && k <= 1 / SWEEPER_MIN_RADIUS ? run + 1 : 0;
    sweeperLength = Math.max(sweeperLength, Math.min(run, n));
  }
  let maxCutFill = 0;
  if (natural) {
    for (let i = 0; i < n; i++) maxCutFill = Math.max(maxCutFill, Math.abs(f.h[i] - natural.getHeight(f.px[i], f.pz[i])));
  }
  return {
    length: f.length,
    minRadius: maxK > 0 ? 1 / maxK : Infinity,
    straightAhead: ahead,
    straightBehind: behind,
    extent,
    legGap,
    maxGrade,
    startGrade,
    tightCorners,
    sweeperLength,
    lefts,
    rights: bends.length - lefts,
    maxCutFill,
  };
}

/** Every rule a measured loop breaks, as text; [] = valid. */
export function trackViolations(m: TrackMetrics, rules: TrackRules = TRACK_RULES): string[] {
  const v: string[] = [];
  if (m.length < rules.minLength || m.length > rules.maxLength) v.push(`length ${m.length.toFixed(0)} m (${rules.minLength}–${rules.maxLength})`);
  if (m.minRadius < rules.minRadius) v.push(`min radius ${m.minRadius.toFixed(2)} m (≥ ${rules.minRadius})`);
  if (m.straightAhead < rules.straightAhead) v.push(`straight ahead ${m.straightAhead.toFixed(1)} m (≥ ${rules.straightAhead})`);
  if (m.straightBehind < rules.straightBehind) v.push(`straight behind ${m.straightBehind.toFixed(1)} m (≥ ${rules.straightBehind})`);
  if (m.extent > rules.maxExtent) v.push(`extent ${m.extent.toFixed(1)} m (≤ ${rules.maxExtent})`);
  if (m.legGap < rules.minLegGap) v.push(`legs ${m.legGap.toFixed(1)} m apart (≥ ${rules.minLegGap})`);
  if (m.maxGrade > rules.maxGrade) v.push(`grade ${(m.maxGrade * 100).toFixed(1)} % (≤ ${rules.maxGrade * 100})`);
  if (m.startGrade > rules.maxStartGrade) v.push(`start grade ${(m.startGrade * 100).toFixed(1)} % (≤ ${rules.maxStartGrade * 100})`);
  if (m.tightCorners < MIN_TIGHT_CORNERS) v.push(`${m.tightCorners} corners of radius 10–${TIGHT_CORNER_MAX_RADIUS} m (≥ ${MIN_TIGHT_CORNERS})`);
  if (m.sweeperLength < MIN_SWEEPER_LENGTH) v.push(`longest sweeper ${m.sweeperLength} m (≥ ${MIN_SWEEPER_LENGTH})`);
  if (m.lefts < 1 || m.rights < 1) v.push(`corners turn one way only (${m.lefts} left, ${m.rights} right)`);
  return v;
}
