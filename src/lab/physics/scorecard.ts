import type { LabResult, ManeuverResult, MetricValue, ScoreLine, Scorecard } from './types';

/**
 * SCORECARD — turns a lab result into one compact table and one weighted
 * score (0..100). The group weights follow the owner's words:
 *
 *   "robust and enjoyable ... drifting shall be possible, but it should still
 *    be possible to react and straighten a car that has begun skidding"
 *
 *   RECOVER  30  can a human (0.25 s reactions) catch a slide; does the car
 *                straighten itself hands-off
 *   ROBUST   30  never spins/rolls from plain inputs, survives jumps, kerbs,
 *                an attacking lap, braking in a turn; same car at 30-120 Hz
 *   DRIFT    20  a slide can be started and HELD
 *   GRIP     20  cornering grip vs the declared mu·g, slalom/lane change,
 *                braking, launch, lap pace
 *
 * Lines are graded 0..1 (linear between a "full marks" and a "zero" value —
 * not just pass/fail), weighted inside their group; a group's score is the
 * weighted mean of the lines that could be evaluated, the total is the
 * weighted mean of the groups present. Running a partial suite therefore
 * still yields a (partial) score; `coverage` says how much of the full
 * scorecard it represents.
 *
 * The pass/fail CHECKS recorded by the maneuvers are the target bands; the
 * scorecard lists how many fail and which.
 */

export const GROUP_WEIGHTS: Record<string, number> = {
  RECOVER: 30,
  ROBUST: 30,
  DRIFT: 20,
  GRIP: 20,
};

/** 1 at `full`, 0 at `zero`, linear in between (either direction). */
function band(value: number | null, full: number, zero: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const t = (value - zero) / (full - zero);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function n(value: MetricValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fmt(value: MetricValue | undefined, digits = 2, unit = ''): string {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return `${value.toFixed(digits)}${unit}`;
  return String(value);
}

export function buildScorecard(result: Omit<LabResult, 'scorecard'>): Scorecard {
  const lines: ScoreLine[] = [];
  const M = result.maneuvers;
  const add = (group: string, item: string, value: string, target: string, score: number, weight: number) => {
    lines.push({ group, item, value, target, score: Math.max(0, Math.min(1, score)), weight });
  };
  const cases = (m: ManeuverResult | undefined) => {
    const map: Record<string, Record<string, MetricValue>> = {};
    for (const c of m?.cases ?? []) map[c.id] = c.metrics;
    return map;
  };
  const ok = (m: ManeuverResult | undefined): m is ManeuverResult => !!m && !m.error && m.cases.length > 0;

  // ------------------------------------------------------------- RECOVER
  if (ok(M.slideRecovery)) {
    const c = cases(M.slideRecovery);
    const d20 = c['b20.driver'];
    const d35 = c['b35.driver'];
    const d50 = c['b50.driver'];
    const rec = (m: Record<string, MetricValue>) => (m.recovered === true ? n(m.recoveryTime) : null);
    add('RECOVER', 'slide 35 deg: time to straight (driver, 0.25 s reaction)', fmt(rec(d35), 2, ' s'), '< 1.6 s', band(rec(d35), 1.0, 2.5), 5);
    const os = n(d35.overshoots) ?? 9;
    const swing = n(d35.counterSwingDeg);
    add('RECOVER', 'slide 35 deg: tank-slapper (overshoots / counter-swing)', `${fmt(d35.overshoots, 0)} / ${fmt(swing, 1, ' deg')}`, '<= 1 / < 12 deg',
      d35.recovered === true ? (os <= 1 ? 1 : os === 2 ? 0.5 : 0) * band(swing, 8, 25) : 0, 4);
    add('RECOVER', 'slide 20 deg: time to straight', fmt(rec(d20), 2, ' s'), '< 1.2 s', band(rec(d20), 0.8, 2.0), 2);
    add('RECOVER', 'slide 50 deg: recoverable at all', d50.recovered === true ? fmt(rec(d50), 2, ' s') : 'spun / never', 'recovers', d50.recovered === true ? 0.5 + 0.5 * band(rec(d50), 1.5, 4.0) : 0, 4);
    const line = n(d35.lateralUsed);
    const head = n(d35.headingAtRecoveryDeg);
    add('RECOVER', 'slide 35 deg: stays on its line (lateral m / heading deg at catch)', `${fmt(line, 1, ' m')} / ${fmt(head, 0, ' deg')}`, '< 8 m / < 25 deg',
      d35.recovered === true ? 0.5 * band(line, 6, 16) + 0.5 * band(head === null ? null : Math.abs(head), 10, 40) : 0, 3);
    // Road used catching the 20 and 50 deg slides, 0.25 / 0.4 s driver: no
    // weight (a feel decision for the owner), gated in slideRecovery
    // (recover.road20.r25 … recover.road50.r40) so a regression shows.
    const road = (id: string) => fmt(c[id]?.lateralUsed, 1, ' m');
    add('RECOVER', 'slide 20 deg: sideways road used (0.25 / 0.4 s driver)', `${road('b20.driver')} / ${road('b20.driver.r40')}`, 'gated, no weight', 0, 0);
    add('RECOVER', 'slide 50 deg: sideways road used (0.25 / 0.4 s driver)', `${road('b50.driver')} / ${road('b50.driver.r40')}`, 'gated, no weight', 0, 0);
    const h20 = c['b20.handsOff'];
    const h35 = c['b35.handsOff'];
    const h50 = c['b50.handsOff'];
    const hands = (m: Record<string, MetricValue>) => (m.spun === false ? band(rec(m), 1.0, 3.0) : 0);
    add('RECOVER', 'hands-off self-straightening (20 / 35 deg time, 50 deg no spin)', `${fmt(rec(h20), 2, ' s')} / ${fmt(rec(h35), 2, ' s')} / ${h50.spun ? 'spins' : 'ok'}`, '< 2.5 s, no spin',
      (hands(h20) + hands(h35) + (h50.spun === false ? 1 : 0)) / 3, 4);
    const p = c['powerSlide.driver'];
    if (p && p.slid === true) {
      const pos = n(p.overshoots) ?? 9;
      add('RECOVER', 'power slide (floored in a hairpin) caught by the driver', p.recovered === true ? `${fmt(rec(p), 2, ' s')}, ${fmt(p.overshoots, 0)} overshoot, swing ${fmt(p.counterSwingDeg, 0, ' deg')}` : 'spun / never', '< 2.0 s, <= 1 overshoot',
        p.recovered === true ? band(rec(p), 1.2, 3.0) * (pos <= 1 ? 1 : 0.5) * (0.5 + 0.5 * band(n(p.counterSwingDeg), 10, 30)) : 0, 6);
    } else if (p) {
      // Not scored either way: there was no slide to recover from.
      add('RECOVER', 'power slide (floored in a hairpin) caught by the driver', 'car never slid on power', 'n/a (see DRIFT)', 0, 0);
    }
  }
  if (ok(M.laneChange)) {
    const c = cases(M.laneChange);
    const v20 = c.v20;
    add('RECOVER', 'lane change 20 m/s: settles after the last gate', v20.spun ? 'SPUN' : fmt(v20.settleTime, 2, ' s'), '< 1.5 s', v20.spun === false ? band(n(v20.settleTime), 1.0, 3.5) : 0, 2);
  }

  // -------------------------------------------------------------- ROBUST
  if (ok(M.stepSteer)) {
    const all = M.stepSteer.cases;
    const clean = all.filter((c) => c.metrics.spun === false && c.metrics.rolledOver === false && (n(c.metrics.sideLiftTime) ?? 0) < 0.2).length;
    add('ROBUST', 'step-steer: cases without spin / roll / 2-wheel lift', `${clean} / ${all.length}`, 'all', clean / all.length, 4);
    const worst = cases(M.stepSteer)['v20.s100'];
    add('ROBUST', 'full lock at 20 m/s: no spin, no roll', worst.spun ? 'SPINS' : worst.rolledOver ? 'ROLLS' : `ok (beta ${fmt(worst.betaPeakDeg, 0, ' deg')})`, 'must not', worst.spun === false && worst.rolledOver === false ? 1 : 0, 2);
  }
  if (ok(M.rollover)) {
    const s = M.rollover.summary;
    const good = s.rolledOver === false ? (0.5 + 0.5 * band(n(s.worstSideLiftTime), 0.05, 0.6)) : 0;
    add('ROBUST', 'fishhook: slides before it rolls (static margin, 2-wheel lift)', `margin ${fmt(s.staticMargin, 2)}, lift ${fmt(s.worstSideLiftTime, 2, ' s')}${s.rolledOver ? ', ROLLED' : ''}`, 'margin > 1.1, no roll', good * (0.5 + 0.5 * band(n(s.staticMargin), 1.1, 0.9)), 3);
  }
  if (ok(M.jump)) {
    const s = M.jump.summary;
    add('ROBUST', 'jumps: land upright and on course (12 cases)', fmt((n(s.onCourseFraction) ?? 0) * 100, 0, ' %'), '100 %', n(s.onCourseFraction) ?? 0, 3);
    add('ROBUST', 'jumps: land level (|pitch| < 30 deg)', `${fmt((n(s.flatLandingFraction) ?? 0) * 100, 0, ' %')}, worst ${fmt(s.worstLandingPitchDeg, 0, ' deg')}`, '>= 75 %', band(n(s.flatLandingFraction), 0.75, 0.1), 1);
  }
  if (ok(M.rough)) {
    const c = cases(M.rough);
    const list = [c['washboard.v15'], c['kerb.v10'], c['boulder.v10']];
    const fine = list.filter((m) => m.staysUpright === true && m.passed === true).length;
    add('ROBUST', 'rough ground: upright and through (washboard, kerb, boulder)', `${fine} / 3`, 'all', fine / 3, 2);
    add('ROBUST', 'rough ground: heading kick hands-off (washboard / kerb / boulder)', list.map((m) => fmt(m.headingKickDeg, 0)).join(' / ') + ' deg', '< 5 / 12 / 30 deg',
      (band(n(list[0].headingKickDeg), 5, 20) + band(n(list[1].headingKickDeg), 12, 30) + band(n(list[2].headingKickDeg), 30, 70)) / 3, 2);
  }
  if (ok(M.hillLap)) {
    const c = cases(M.hillLap);
    const a = c.aggressive;
    const f = c.fast;
    const trouble = (n(a.rollovers) ?? 0) + (n(a.stuck) ?? 0) + (n(a.lost) ?? 0);
    add('ROBUST', 'attacking lap: 2 laps, 0 rollovers, 0 stuck', a.completed === true ? `${fmt(a.rollovers, 0)} rolls, ${fmt(trouble - (n(a.rollovers) ?? 0), 0)} stuck` : 'DNF', '0 / 0', a.completed === true && trouble === 0 ? 1 : 0, 4);
    const offShare = (n(a.offRoadTime) ?? 0) / Math.max(1, n(a.totalTime) ?? 1);
    add('ROBUST', 'attacking lap: spins / time off the road', `${fmt(a.spins, 0)} spins, ${fmt(offShare * 100, 0, ' %')} off-road`, '<= 1 spin, < 5 %', 0.4 * band(n(a.spins), 0, 4) + 0.6 * band(offShare, 0.05, 0.5), 3);
    add('ROBUST', 'careful lap: stays on the road', `${fmt(f.offRoadExcursions, 0)} excursions, ${fmt(f.spins, 0)} spins`, '0 / 0', f.completed === true ? band((n(f.offRoadExcursions) ?? 9) + 2 * (n(f.spins) ?? 9), 0, 4) : 0, 2);
  }
  if (ok(M.frameRate)) {
    const checks = M.frameRate.checks;
    const passing = checks.filter((c) => c.pass).length;
    const s = M.frameRate.summary;
    add('ROBUST', `frame-rate independence (${s.rates} Hz): metrics within 10 %`, `${passing} / ${checks.length}, worst ${fmt(s.worstSpreadPct, 0, ' %')} (${s.worstMetric})`, 'all < 10 %',
      0.5 * (passing / checks.length) + 0.5 * band(n(s.worstSpreadPct), 10, 60), 4);
  }
  if (ok(M.brake)) {
    const s = M.brake.summary;
    add('ROBUST', 'full brake from 20 m/s stays straight', s.spun ? 'SPINS' : fmt(s.headingDevDeg, 1, ' deg'), '< 3 deg', s.spun === false ? band(n(s.headingDevDeg), 1, 10) : 0, 1);
  }
  if (ok(M.brakeTurn)) {
    const list = M.brakeTurn.cases.map((c) => c.metrics);
    const score = list.reduce((sum, m) => sum + (m.spun === false ? band(n(m.peakOversteerDeg), 10, 45) : 0), 0) / list.length;
    add('ROBUST', 'braking in a turn (40 % / 100 %): tail-out angle', list.map((m) => (m.spun ? 'SPIN' : fmt(m.peakOversteerDeg, 0))).join(' / ') + ' deg', '< 30 deg, no spin', score, 2);
  }
  if (ok(M.launch)) {
    const s = M.launch.summary;
    add('ROBUST', 'launch tracks straight hands-off (heading drift)', fmt(s.headingDriftDeg, 2, ' deg'), '< 1 deg', band(n(s.headingDriftDeg), 1, 4), 1);
  }
  if (ok(M.standstill)) {
    const checks = M.standstill.checks;
    const passing = checks.filter((c) => c.pass).length;
    const failed = checks.filter((c) => !c.pass).map((c) => c.id.replace('standstill.', ''));
    add('ROBUST', 'standstill / low speed checks', `${passing} / ${checks.length}${failed.length ? ` (fails: ${failed.join(', ')})` : ''}`, 'all', passing / checks.length, 2);
  }

  // --------------------------------------------------------------- DRIFT
  if (ok(M.driftInitiate)) {
    const list = M.driftInitiate.cases.map((c) => c.metrics);
    let score = 0;
    const text: string[] = [];
    for (const m of list) {
      if (m.initiated === true && m.caught === true) {
        score += 1;
        text.push('held');
      } else if (m.initiated === true) {
        score += 0.35;
        text.push('starts, lost');
      } else {
        score += 0.25 * band(n(m.peakOversteerDeg), 15, 5);
        text.push(`${fmt(m.peakOversteerDeg, 0)} deg`);
      }
    }
    add('DRIFT', 'initiation: power-over / lift+flick / brake-tap / slow power-over', text.join(' | '), '15 deg reached and held', score / list.length, 7);
  }
  if (ok(M.driftSustain)) {
    const s = M.driftSustain.summary;
    const sustained = s.sustained === true;
    const mean = n(s.betaMeanDeg);
    const sd = n(s.betaStdDeg);
    add('DRIFT', 'sustain 25 deg for 5 s (best of 6 driver/entry combinations)', sustained ? `beta ${fmt(mean, 1)} +- ${fmt(sd, 1)} deg, speed kept ${fmt((n(s.speedKept) ?? 0) * 100, 0, ' %')}` : `not held (beta ends ${fmt(mean, 1)} deg)`, '25 +- 8 deg, std < 8 deg',
      sustained ? (0.4 + 0.3 * band(mean === null ? null : Math.abs(mean - 25), 3, 12) + 0.3 * band(sd, 3, 12)) * ((n(s.speedKept) ?? 0) > 0.6 ? 1 : 0.7) : 0, 7);
    add('DRIFT', 'open-loop slide window (fixed throttle + countersteer, no driver)', `${fmt(s.openLoopWindow, 2, ' s')} (${s.openLoopWindowExit}; ${String(s.openLoopWindowCase).replace('window.', '')})`, '>= 1.5 s',
      band(n(s.openLoopWindow), 2.5, 0.3), 6);
  }

  // ---------------------------------------------------------------- GRIP
  if (ok(M.skidpad)) {
    const list = M.skidpad.cases.map((c) => c.metrics).filter((m) => m.limitReached === true);
    if (list.length > 0) {
      const mean = list.reduce((sum, m) => sum + (n(m.maxLatFraction) ?? 0), 0) / list.length;
      const all = M.skidpad.cases.map((c) => `${fmt(c.metrics.maxLatFraction, 2)}${c.metrics.limitReached ? '' : '+'}`).join(' / ');
      // Too little grip is a plow; far more than declared is a car on rails.
      // (0.87 = what the known-answer reference car reads, see cornering.ts.)
      const score = mean <= 1.1 ? band(mean, 0.87, 0.45) : band(mean, 1.1, 1.5);
      add('GRIP', 'skidpad max lateral accel / (mu*g) at R = 10 / 20 / 35 m', all, '0.85 - 1.1', score, 6);
      const snaps = list.filter((m) => m.limitBehaviour === 'snap/spin').length;
      add('GRIP', 'skidpad behaviour at the limit', M.skidpad.cases.map((c) => String(c.metrics.limitBehaviour)).join(' / '), 'push or slide, no snap', 1 - snaps / list.length, 2);
    }
    const grads = M.skidpad.cases.map((c) => n(c.metrics.understeerDegPerG)).filter((v): v is number => v !== null);
    if (grads.length > 0) {
      const g = grads.reduce((a, b) => a + b, 0) / grads.length;
      add('GRIP', 'understeer gradient (deg of steer per g of cornering)', fmt(g, 1, ' deg/g'), '0 - 3 deg/g (info)', band(Math.abs(g), 3, 10), 1);
    }
  }
  if (ok(M.slalom)) {
    const s = M.slalom.summary;
    add('GRIP', 'slalom (18 m cones): highest clean speed', fmt(s.highestCleanSpeed, 1, ' m/s'), '>= 16 m/s', band(n(s.highestCleanSpeed), 20, 10), 3);
  }
  if (ok(M.laneChange)) {
    const list = M.laneChange.cases.map((c) => c.metrics);
    // Graded on how far the car strays from the lane centre (the pass/fail
    // check is "< 1.75 m and settles"; a car at 1.7 m is not a different
    // car from one at 1.8 m).
    const score = list.reduce((sum, m) => sum + (m.spun === false ? band(n(m.maxPathOffset), 0.8, 2.6) : 0), 0) / list.length;
    add('GRIP', 'double lane change (15 / 20 m/s): max deviation from the lane', list.map((m) => (m.spun ? 'SPUN' : fmt(m.maxPathOffset, 2))).join(' / ') + ' m', '< 1.75 m', score, 2);
  }
  if (ok(M.brake)) {
    const s = M.brake.summary;
    add('GRIP', 'braking 20 -> 0: distance vs v^2 / (2 mu g)', `${fmt(s.distance, 2, ' m')} (ideal ${fmt(s.idealDistance, 2, ' m')})`, 'ideal / measured >= 0.8', band(n(s.efficiency), 0.9, 0.5), 2);
  }
  if (ok(M.launch)) {
    const s = M.launch.summary;
    add('GRIP', 'launch: 0 -> 10 / 20 m/s, top speed', `${fmt(s.t10, 2)} / ${fmt(s.t20, 2)} s, ${fmt(s.topSpeed, 1)} m/s`, 'snappy (info)', 0.5 * band(n(s.t10), 0.7, 2.0) + 0.5 * band(n(s.t20), 1.5, 4.0), 2);
  }
  if (ok(M.hillLap)) {
    const c = cases(M.hillLap);
    const laps = [n(c.fast?.lap2Time), n(c.aggressive?.lap2Time)].filter((v): v is number => v !== null);
    const length = n(c.fast?.trackLength) ?? 0;
    if (laps.length > 0 && length > 0) {
      const best = Math.min(...laps);
      add('GRIP', 'hill lap pace: best flying lap', `${fmt(best, 2, ' s')} (${fmt(length / best, 1)} m/s mean; fast ${fmt(c.fast?.lap2Time, 1)} / aggressive ${fmt(c.aggressive?.lap2Time, 1)})`, 'faster is better', band(length / best, 18, 10), 2);
    } else {
      add('GRIP', 'hill lap pace: best flying lap', 'no completed lap', 'faster is better', 0, 2);
    }
  }

  // ------------------------------------------------------------- totals
  // Line weight per group when the whole suite ran (RECOVER without the
  // optional power-slide line) — only used to report coverage.
  const FULL: Record<string, number> = { RECOVER: 24, ROBUST: 36, DRIFT: 20, GRIP: 20 };
  const groups: Scorecard['groups'] = [];
  let total = 0;
  let totalWeight = 0;
  let covered = 0;
  let coverable = 0;
  for (const [group, weight] of Object.entries(GROUP_WEIGHTS)) {
    const own = lines.filter((l) => l.group === group && l.weight > 0);
    const w = own.reduce((sum, l) => sum + l.weight, 0);
    coverable += weight;
    if (w === 0) continue;
    const score = own.reduce((sum, l) => sum + l.weight * l.score, 0) / w;
    groups.push({ group, weight, score: Math.round(score * 1000) / 10 });
    total += weight * score;
    totalWeight += weight;
    covered += weight * Math.min(1, w / FULL[group]);
  }
  const score = totalWeight > 0 ? (total / totalWeight) * 100 : 0;
  const coverage = coverable > 0 ? covered / coverable : 0;

  const failing: string[] = [];
  let checkCount = 0;
  for (const m of Object.values(M)) {
    for (const c of m.checks) {
      checkCount++;
      if (!c.pass) failing.push(c.id);
    }
  }

  // ---------------------------------------------------------------- text
  const out: string[] = [];
  const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
  out.push(
    `PHYSICS LAB SCORECARD — model '${result.model}', car '${result.car}', dt 1/${Math.round(1 / result.dt)}, ` +
    `gravity ${result.gravity}, declared mu ${result.nominalGrip}`,
  );
  out.push(
    `TOTAL ${score.toFixed(1)} / 100` +
    (coverage < 0.999 ? `   (PARTIAL suite: ${(coverage * 100).toFixed(0)} % of the scorecard evaluated)` : '') +
    `   target bands: ${checkCount - failing.length} / ${checkCount} checks pass`,
  );
  for (const g of groups) out.push(`  ${pad(g.group, 8)} weight ${String(g.weight).padStart(2)}   ${g.score.toFixed(1).padStart(5)} %`);
  out.push('');
  out.push(`${pad('group', 8)} ${pad('item', 66)} ${pad('value', 58)} ${pad('target', 26)} score   w`);
  out.push('-'.repeat(8 + 1 + 66 + 1 + 58 + 1 + 26 + 11));
  for (const l of lines) {
    out.push(
      `${pad(l.group, 8)} ${pad(l.item, 66)} ${pad(l.value, 58)} ${pad(l.target, 26)} ` +
      `${l.weight > 0 ? l.score.toFixed(2).padStart(5) : '    -'} ${String(l.weight).padStart(3)}`,
    );
  }
  if (failing.length > 0) {
    out.push('');
    out.push(`FAILING CHECKS (${failing.length}): ${failing.join(', ')}`);
  }
  if (result.errors.length > 0) {
    out.push('');
    out.push(`ERRORS (${result.errors.length}): ${result.errors.map((e) => e.split('\n')[0]).join(' ; ')}`);
  }

  return {
    total: Math.round(score * 10) / 10,
    coverage: Math.round(coverage * 1000) / 1000,
    groups,
    lines,
    failingChecks: failing,
    text: out.join('\n'),
  };
}
