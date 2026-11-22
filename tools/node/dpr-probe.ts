// Mock-clock probe of DprGovernor (src/game/quality.ts): the pixel-ratio
// step-down of the high preset. Each case has an EXPECTED end ratio and an
// allowed number of trials; exit 1 on any mismatch.
//   node --import ./tools/node/register.mjs tools/node/dpr-probe.ts
// Frames snap to vsync unless snap: false. GPU cost scales with ratio² where the case says so.
import { DprGovernor } from '../../src/game/quality.ts';
type Cost = (t: number, ratio: number) => number;
interface Case { name: string; hz: number | ((t: number) => number); cost: Cost; seconds: number; snap?: boolean; gaps?: { at: number; len: number }[]; jitter?: number; boot?: boolean; expect: number; maxTrials?: number; minTrials?: number; maxChanges?: number; note?: string }
let fail = 0;
function run(c: Case): void {
  const g = new DprGovernor(2);
  let t = 0; let rnd = 12345; let low = 0;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const pending = [...(c.gaps ?? [])];
  const ev: string[] = [];
  if (c.boot !== false) for (const h of [0.3, 0.2, 0.1]) { g.frame(h); t += h; }
  while (t < c.seconds) {
    const hz = typeof c.hz === 'number' ? c.hz : c.hz(t);
    const iv = 1 / hz;
    const cost = c.cost(t, g.ratio) * (1 + (c.jitter ?? 0) * (rand() - 0.5) * 2);
    let dt = c.snap === false ? Math.max(cost, iv) : Math.max(1, Math.ceil(cost / iv - 1e-9)) * iv;
    if (pending.length && t >= pending[0].at) { dt += pending[0].len; pending.shift(); }
    t += dt;
    if (g.ratio < 2) low += dt;
    if (g.frame(dt)) ev.push(`${t.toFixed(1)}s→${g.ratio}`);
  }
  const ok = g.ratio === c.expect && g.trials <= (c.maxTrials ?? 99) && g.trials >= (c.minTrials ?? 0) && ev.length <= (c.maxChanges ?? Infinity);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      end ${g.ratio} (expect ${c.expect}), trials ${g.trials} (allowed ${c.minTrials ?? 0}..${c.maxTrials ?? '∞'}), ${ev.length} changes${c.maxChanges !== undefined ? ` (allowed ${c.maxChanges})` : ''}, ${low.toFixed(1)} s below 2, ceiling ${g.ceiling.toFixed(0)}, fps ${g.fps.toFixed(0)}\n      ${ev.join(' ') || 'no step'}${c.note ? '\n      [' + c.note + ']' : ''}`);
}
const px = (r: number) => (r / 2) ** 2;
const scaled = (k: number): Cost => (_t, r) => k * px(r);
const cases: Case[] = [];
for (const hz of [60, 120, 30]) {
  const iv = 1 / hz;
  const amb = hz < 50; // ambiguous ceiling: one probe trial (1.5, 1, back)
  cases.push({ name: `${hz} Hz steady (GPU 0.6 interval)`, hz, cost: scaled(0.6 * iv), seconds: 40, expect: 2, maxTrials: amb ? 1 : 0 });
  cases.push({ name: `${hz} Hz steady (GPU exactly 1 interval)`, hz, cost: scaled(1.0 * iv), seconds: 40, expect: 2, maxTrials: amb ? 1 : 0 });
  cases.push({ name: `${hz} Hz falling (0.6 → 1.6 interval at 10 s)`, hz, cost: (t, r) => (t < 10 ? 0.6 : 1.6) * iv * px(r), seconds: 40, expect: 1.5 });
  cases.push({ name: `${hz} Hz falling hard (0.6 → 3.5 at 10 s)`, hz, cost: (t, r) => (t < 10 ? 0.6 : 3.5) * iv * px(r), seconds: 40, expect: 1 });
  cases.push({ name: `${hz} Hz jitter 10 %`, hz, cost: scaled(0.6 * iv), seconds: 40, jitter: 0.1, expect: 2, maxTrials: amb ? 1 : 0 });
}
for (const len of [2, 3, 5, 60, 600]) cases.push({ name: `60 Hz idle, tab hidden ${len} s at t=20`, hz: 60, cost: scaled(0.6 / 60), seconds: 45, gaps: [{ at: 20, len }], expect: 2, maxTrials: 0 });
for (const hz of [60, 120, 30]) cases.push({ name: `${hz} Hz idle, tab hidden 30 s twice (t=20, t=40)`, hz, cost: scaled(0.6 / hz), seconds: 60, gaps: [{ at: 20, len: 30 }, { at: 40, len: 30 }], expect: 2, maxTrials: hz < 50 ? 1 : 0 });
for (const len of [0.5, 1, 3]) cases.push({ name: `60 Hz idle, single hitch ${len} s at t=20`, hz: 60, cost: scaled(0.6 / 60), seconds: 40, gaps: [{ at: 20, len }], expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz idle, 2 s first frame', hz: 60, cost: scaled(0.6 / 60), seconds: 40, gaps: [{ at: 0, len: 2 }], expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz idle, two 0.3 s hitches back to back at t=20', hz: 60, cost: scaled(0.6 / 60), seconds: 40, gaps: [{ at: 20, len: 0.3 }, { at: 20, len: 0.3 }], expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz falling at 10 s, tab hidden 30 s at t=12', hz: 60, cost: (t, r) => (t < 10 ? 0.6 : 1.6) / 60 * px(r), seconds: 50, gaps: [{ at: 12, len: 30 }], expect: 1.5 });
cases.push({ name: '60 Hz CPU-bound 22 ms from t=10 (ratio does not help)', hz: 60, cost: (t) => (t < 10 ? 0.01 : 0.022), seconds: 60, expect: 2, maxTrials: 1 });
cases.push({ name: '60 Hz, browser caps to 30 fps at t=15 (GPU idle)', hz: (t) => (t < 15 ? 60 : 30), cost: scaled(0.005), seconds: 60, expect: 2, maxTrials: 1 });
cases.push({ name: '60 Hz, cap 30 fps 15–30 s, 60 again, GPU falls to 30 fps at 40 s (200 s)', hz: (t) => (t < 15 || t >= 30 ? 60 : 30), cost: (t, r) => (t < 40 ? 0.005 : 1.6 / 60 * px(r)), seconds: 200, expect: 1.5, note: 'the fall lands on the failed rate: tried only after the 120 s retry wait (step at ~144 s)' });
cases.push({ name: '60 Hz, cap 30 fps 15–30 s, 60 again, GPU falls DEEPER (15 fps) at 40 s', hz: (t) => (t < 15 || t >= 30 ? 60 : 30), cost: (t, r) => (t < 40 ? 0.005 : 3.5 / 60 * px(r)), seconds: 70, expect: 1 });
cases.push({ name: '60 Hz GPU-bound from the start (1.6 interval)', hz: 60, cost: scaled(1.6 / 60), seconds: 40, expect: 1.5 });
cases.push({ name: '30 Hz GPU-bound from the start (1.6 interval)', hz: 30, cost: scaled(1.6 / 30), seconds: 40, expect: 1.5 });
cases.push({ name: '60 Hz, 25 ms frames for the first 4.2 s (warm-up), then idle', hz: 60, cost: (t, r) => (t < 4.2 ? 0.025 : 0.005 * px(r)), seconds: 40, expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz, 25 ms frames for the first 8 s (warm-up), then idle', hz: 60, cost: (t, r) => (t < 8 ? 0.025 : 0.005 * px(r)), seconds: 40, expect: 2, maxTrials: 1, note: 'was a KNOWN LIMIT (ended at 1.5): the probe trial at 7 s now verifies its gain at ratio 2 and sees the warm-up end' });
cases.push({ name: '60 Hz, 25 ms frames for the first 20 s (long CPU-bound warm-up), then idle', hz: 60, cost: (t, r) => (t < 20 ? 0.025 : 0.005 * px(r)), seconds: 60, expect: 2, maxTrials: 1 });
cases.push({ name: '120 Hz, 120 fps on the grid then 11.5 ms frames at ratio 2', hz: 120, cost: (t, r) => (t < 6 ? 0.007 : 0.0115 * px(r)), seconds: 40, expect: 1.5, note: 'by design: 60 fps is under 80 % of 120' });
// Round-2 reviewer's cases (boot hitches off, as in dpr-r2.ts).
cases.push({ name: 'A1 60 Hz CPU-bound, 10 / 22 ms alternating every 10 s, 120 s', hz: 60, cost: (t) => (Math.floor(t / 10) % 2 ? 0.022 : 0.010), seconds: 120, boot: false, expect: 2, maxTrials: 1 });
cases.push({ name: 'A2 120 Hz CPU-bound, 7 / 11.5 ms alternating every 10 s, 120 s (no snap)', hz: 120, cost: (t) => (Math.floor(t / 10) % 2 ? 0.0115 : 0.007), seconds: 120, snap: false, boot: false, expect: 2, maxTrials: 1 });
cases.push({ name: 'A3 60 Hz CPU-bound, 22 ms for 6 s once a 40 s lap, 240 s', hz: 60, cost: (t) => (t % 40 > 34 ? 0.022 : 0.010), seconds: 240, boot: false, expect: 2, maxTrials: 2, note: 'retry wait 120 s, doubling: trials grow as log2 of the session length' });
cases.push({ name: 'A3b same, 600 s', hz: 60, cost: (t) => (t % 40 > 34 ? 0.022 : 0.010), seconds: 600, boot: false, expect: 2, maxTrials: 3 });
cases.push({ name: 'B1 60 Hz GPU-bound from t=10: 31 ms at 2 (17.4 at 1.5, 7.8 at 1)', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 0.031 * px(r)), seconds: 60, boot: false, expect: 1 });
cases.push({ name: 'B2 60 Hz GPU-bound from the start: 31 ms at 2', hz: 60, cost: (_t, r) => 0.031 * px(r), seconds: 60, boot: false, expect: 1 });
cases.push({ name: 'B3 60 Hz GPU-bound from the start: 45 ms at 2 (25 at 1.5, 11 at 1)', hz: 60, cost: (_t, r) => 0.045 * px(r), seconds: 60, boot: false, expect: 1 });
cases.push({ name: 'B4 60 Hz GPU-bound from t=10: 45 ms at 2', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 0.045 * px(r)), seconds: 60, boot: false, expect: 1 });
cases.push({ name: 'C1 60 Hz from t=10: 14 ms CPU + 10 ms GPU at 2 (no snap)', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 0.014 + 0.010 * px(r)), seconds: 60, snap: false, boot: false, expect: 1.5 });
cases.push({ name: 'C2 60 Hz from t=10: 6 ms CPU + 16 ms GPU at 2 (no snap)', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 0.006 + 0.016 * px(r)), seconds: 60, snap: false, boot: false, expect: 1.5 });
cases.push({ name: 'D1 60 Hz GPU falls at 10 s, hidden 30 s during the trial (t=14)', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 1.6 / 60 * px(r)), seconds: 60, gaps: [{ at: 14, len: 30 }], boot: false, expect: 1.5 });
cases.push({ name: 'D2 60 Hz GPU falls at 10 s, a 0.3 s hitch every 2.5 s', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 1.6 / 60 * px(r)), seconds: 60, gaps: Array.from({ length: 20 }, (_, i) => ({ at: 10 + i * 2.5, len: 0.3 })), boot: false, expect: 1.5 });
cases.push({ name: 'E1 60 Hz, 0.3 s frames at 2 from the start (3 fps)', hz: 60, cost: (_t, r) => 0.3 * px(r), seconds: 60, boot: false, expect: 1 });
// Final review (budget-governor finding 1): a CPU-bound dip that ENDS during
// a trial must not be read as a gain (it used to leave 1.5 for good).
const dip = (from: number, len: number, slow: number, fast: number): Cost => (t) => (t >= from && t < from + len ? slow : fast);
for (const len of [2.5, 3, 4, 5, 5.5]) {
  for (const snap of [true, false]) {
    cases.push({ name: `60 Hz one CPU-bound dip 22 ms for ${len} s at t=20${snap ? '' : ' (no snap)'}, 600 s`, hz: 60, cost: dip(20, len, 0.022, 0.010), seconds: 600, snap, boot: false, expect: 2, maxTrials: 1 });
    cases.push({ name: `120 Hz one CPU-bound dip 11.5 ms for ${len} s at t=20${snap ? '' : ' (no snap)'}, 600 s`, hz: 120, cost: dip(20, len, 0.0115, 0.007), seconds: 600, snap, boot: false, expect: 2, maxTrials: 1 });
  }
}
for (const len of [3, 4, 5]) {
  const two: Cost = (t) => ((t >= 20 && t < 20 + len) || (t >= 60 && t < 60 + len) ? 0.022 : 0.010);
  cases.push({ name: `60 Hz two CPU-bound dips 22 ms for ${len} s (t=20, t=60), 600 s`, hz: 60, cost: two, seconds: 600, boot: false, expect: 2, maxTrials: 2 });
}
for (const len of [4, 5, 6, 7]) cases.push({ name: `60 Hz page throttled to 1 frame/s for ${len} s at t=20, 600 s`, hz: 60, cost: dip(20, len, 1.0, 0.010), seconds: 600, boot: false, expect: 2, maxTrials: 1 });
cases.push({ name: 'A1 run for 1800 s', hz: 60, cost: (t) => (Math.floor(t / 10) % 2 ? 0.022 : 0.010), seconds: 1800, boot: false, expect: 2, maxTrials: 5 });
cases.push({ name: 'A2 run for 1800 s (no snap)', hz: 120, cost: (t) => (Math.floor(t / 10) % 2 ? 0.0115 : 0.007), seconds: 1800, snap: false, boot: false, expect: 2, maxTrials: 5 });
for (const len of [2.5, 3, 4, 5, 5.5]) cases.push({ name: `A3 with a ${len} s section once a 40 s lap, 240 s`, hz: 60, cost: (t) => (t % 40 > 40 - len ? 0.022 : 0.010), seconds: 240, boot: false, expect: 2, maxTrials: 3 });
// Finding 4: a steady 50 Hz display is not an ambiguous ceiling.
for (const snap of [true, false]) cases.push({ name: `50 Hz steady (GPU 0.6 interval)${snap ? '' : ' (no snap)'}`, hz: 50, cost: scaled(0.6 / 50), seconds: 60, snap, expect: 2, maxTrials: 0 });
cases.push({ name: '50 Hz falling (0.6 → 1.6 interval at 10 s)', hz: 50, cost: (t, r) => (t < 10 ? 0.6 : 1.6) / 50 * px(r), seconds: 60, expect: 1.5 });
// Finding 3: GPU-bound slowness that never stays low 3 s in one run.
cases.push({ name: '60 Hz GPU-bound 30 fps (1.6 interval) for 2.2 s of every 3.2 s from t=10', hz: 60, cost: (t, r) => (t >= 10 && (t - 10) % 3.2 < 2.2 ? 1.6 / 60 * px(r) : 0.6 / 60 * px(r)), seconds: 120, boot: false, expect: 1.5 });
cases.push({ name: '60 Hz GPU falls to 30 fps at 10 s, a 0.3 s hitch every 1.2 s', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 1.6 / 60 * px(r)), seconds: 120, gaps: Array.from({ length: 90 }, (_, i) => ({ at: 10 + i * 1.2, len: 0.3 })), boot: false, expect: 1.5 });
cases.push({ name: '60 Hz GPU falls to 30 fps at 10 s, a 0.3 s hitch every 1 s', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 1.6 / 60 * px(r)), seconds: 120, gaps: Array.from({ length: 110 }, (_, i) => ({ at: 10 + i, len: 0.3 })), boot: false, expect: 1.5 });
// ... and what must still NOT step (no oscillation, no trial on short dips).
cases.push({ name: '60 Hz idle, a 0.3 s hitch every 1.2 s for 300 s', hz: 60, cost: scaled(0.6 / 60), seconds: 300, gaps: Array.from({ length: 240 }, (_, i) => ({ at: 10 + i * 1.2, len: 0.3 })), expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz GPU-bound 30 fps for 1 s of every 3.2 s (under half the time)', hz: 60, cost: (t, r) => (t >= 10 && (t - 10) % 3.2 < 1 ? 1.6 / 60 * px(r) : 0.6 / 60 * px(r)), seconds: 300, boot: false, expect: 2, maxTrials: 0 });
cases.push({ name: '60 Hz CPU-bound 22 ms for 2.2 s of every 3.2 s, 600 s', hz: 60, cost: (t) => (t >= 10 && (t - 10) % 3.2 < 2.2 ? 0.022 : 0.010), seconds: 600, boot: false, expect: 2, maxTrials: 4 });
// A fall that stays costs 4 ratio
// changes when both steps pay within 20 s: the step after a kept step that
// did not cure the fall is kept without a second check-back (CHAIN_SECONDS).
cases.push({ name: '60 Hz falling hard (0.6 → 3.5 at 10 s): at most 4 changes', hz: 60, cost: (t, r) => (t < 10 ? 0.6 : 3.5) / 60 * px(r), seconds: 600, expect: 1, maxChanges: 4 });
cases.push({ name: 'B1 for 600 s: at most 4 changes', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : 0.031 * px(r)), seconds: 600, boot: false, expect: 1, maxChanges: 4 });
cases.push({ name: 'B3 for 600 s: at most 4 changes', hz: 60, cost: (_t, r) => 0.045 * px(r), seconds: 600, boot: false, expect: 1, maxChanges: 4 });
// TRIAL_BELOW = 49: a GPU at a third of 144 Hz from the first frame reads a
// ceiling of 48.0 and must make the start-up trial (with 48 it was rounding).
for (const jitter of [0, 0.02, 0.05]) cases.push({ name: `144 Hz GPU-bound at a third of the rate from the start (2.9 intervals), jitter ${jitter * 100} %`, hz: 144, cost: scaled(2.9 / 144), seconds: 120, jitter, expect: 1.5 });
// A kept step that CURED the fall opens no
// chain: a CPU-bound dip in the next 20 s gets the full check-back.
cases.push({ name: '60 Hz GPU fall that 1.5 cures (t=10), one CPU-bound dip 3.2 iv for 4 s at t=24, 600 s', hz: 60, cost: (t, r) => ((t >= 24 && t < 28 ? 3.2 : 0.2) + (t < 10 ? 0.5 : 1.3) * px(r)) / 60, seconds: 600, boot: false, expect: 1.5, note: 'ended at 1 with round 2 (the dip was kept as the next step of the fall)' });
// (A dip that overlaps the fall's own first trial, 13–21 s, fails that trial: the failed-trial
// ceiling KNOWN LIMIT below, not pinned here.)
for (const at of [22, 26, 30, 40]) cases.push({ name: `60 Hz GPU fall that 1.5 cures (t=10), one CPU-bound dip 3.2 iv for 4 s at t=${at}, no snap, 600 s`, hz: 60, snap: false, cost: (t, r) => ((t >= at && t < at + 4 ? 3.2 : 0.2) + (t < 10 ? 0.5 : 1.3) * px(r)) / 60, seconds: 600, boot: false, expect: 1.5 });
// Change counts that the round-2 header got wrong, pinned at what they are.
cases.push({ name: '60 Hz fall whose next step does not pay (15 / 30 / 30 fps): 5 changes', hz: 60, cost: (t, r) => (t < 10 ? 0.010 : (0.4 + 2.7 * px(r)) / 60), seconds: 600, boot: false, expect: 1.5, maxChanges: 5 });
cases.push({ name: 'KNOWN LIMIT 60 Hz GPU cost rising 0.5 -> 2.2 iv over 20 s from t=30 (thermal sink): up to 8 changes', hz: 60, cost: (t, r) => (0.2 + (t < 30 ? 0.5 : t > 50 ? 2.2 : 0.5 + 1.7 * (t - 30) / 20) * px(r)) / 60, seconds: 600, boot: false, expect: 1, maxChanges: 8 });
// A hitch straight followed by hidden time (two long frames in a row, the
// second over PAUSE_GAP s) is a pause, not a 0 fps rate sample.
for (const [a, b] of [[0.3, 3], [0.3, 60], [2, 600], [0.26, 3600]]) cases.push({ name: `60 Hz idle, hitch ${a} s straight followed by ${b} s hidden at t=30`, hz: 60, cost: scaled(0.6 / 60), seconds: 330, gaps: [{ at: 30, len: a }, { at: 30, len: b }], expect: 2, maxTrials: 0, maxChanges: 0 });
// KNOWN LIMITS (pinned so a change shows): nothing ever steps back up, so
// the governor keeps a step only on evidence it can check at once.
cases.push({ name: 'KNOWN LIMIT 60 Hz GPU-bound 30 fps (1.6 interval) for 5 s of every 28 s, 600 s', hz: 60, cost: (t, r) => (t % 28 >= 20 && t % 28 < 25 ? 1.6 : 0.6) / 60 * px(r), seconds: 600, boot: false, expect: 2, note: 'a GPU-bound section shorter than ~8 s a lap is not stepped down: its check-back at the old ratio (3 s to notice + 2.5 s down + 2.5 s back) sees the section end' });
cases.push({ name: 'KNOWN LIMIT 60 Hz two CPU-bound dips close together (22 ms, 3 s at t=20 and 3 s at t=26), 600 s', hz: 60, cost: (t) => ((t >= 20 && t < 23) || (t >= 26 && t < 29) ? 0.022 : 0.010), seconds: 600, boot: false, expect: 1.5, note: 'the second dip lands on the confirm step and fakes both comparisons; the low ratio stays for the session (cure: a step back up)' });
cases.push({ name: 'KNOWN LIMIT 60 Hz one long dip of 1.8 intervals CPU + a 0.25 interval GPU share for 10 s at t=20', hz: 60, cost: (t, r) => (t >= 20 && t < 30 ? 1.8 : 0.35) / 60 + 0.25 / 60 * px(r), seconds: 600, boot: false, expect: 1.5, note: 'the gain is REAL while the dip lasts (1.5 brings the frame under the 2-interval vsync line), so the trial is right; the ratio stays after the dip because nothing steps back up' });
for (const c of cases) run(c);
console.log(fail ? `${fail} FAILED of ${cases.length}` : `ALL PASS (${cases.length} cases)`);
process.exit(fail ? 1 : 0);
