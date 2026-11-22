// ACCEPTANCE SWEEP of the track and world data (every `TRACK_RULES` rule,
// the planner's self-checks, the carve, determinism, `WorldData`
// invariants). Plain Node, no browser; from the repo root:
//
//   node --import ./tools/node/register.mjs tools/node/world-sweep.ts [fromSeed=1] [toSeed=40]
//
// Needs, from src/terrain/generateTerrain.ts:  generateTerrain(seed),
// generateBaseTerrain(seed). Independent of the generator's own measuring
// code on purpose: it uses the planner's TrackFrame directly.
// Exit status 0 = every seed passes every rule; 1 otherwise.
// If THIS script has a bug, fix the script and say so — do not bend a rule
// to suit it.
import { createHash } from 'node:crypto';
// WORLD_SWEEP_MODULE: test this script against another module with the same
// two exports (e.g. a shim around a prototype generator).
const terrain = await import(process.env.WORLD_SWEEP_MODULE ?? '../../src/terrain/generateTerrain.ts');
import { TrackFrame } from '../../src/world/trackFrame.ts';
import { measureRoadCarve } from '../../src/world/planWorld.ts';
import { runSelfChecks } from '../../src/world/checks.ts';

type AnyData = Record<string, any>;
const gen = (terrain as AnyData).generateTerrain as (seed: number) => AnyData;
const genBase = (terrain as AnyData).generateBaseTerrain as ((seed: number) => AnyData) | undefined;
if (typeof genBase !== 'function') {
  console.error('generateBaseTerrain(seed) is not exported from src/terrain/generateTerrain.ts');
  process.exit(1);
}

const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? 40);

function hashOf(data: AnyData): string {
  const h = createHash('sha1');
  h.update(Buffer.from(data.track.points.buffer));
  h.update(Buffer.from(data.track.roadHeights.buffer));
  h.update(Buffer.from(data.heightfield.heights.buffer));
  h.update(Buffer.from(data.splat.buffer));
  h.update(Buffer.from(data.shade.buffer));
  h.update(Buffer.from(data.paved.buffer));
  h.update(JSON.stringify(data.plan));
  return h.digest('hex').slice(0, 12);
}

interface Row { seed: number; fails: string[]; text: string }
const rows: Row[] = [];
const shapes = new Map<string, number>();
let worstMs = 0;
const times: number[] = [];

for (let seed = from; seed <= to; seed++) {
  const fails: string[] = [];
  const need = (ok: boolean, what: string): void => { if (!ok) fails.push(what); };

  // --- base terrain (road carved, spawn shifted, BEFORE the plan) + planner self-checks
  const base = genBase(seed);
  const run = runSelfChecks({ track: base.track, heightfield: base.heightfield, seed }, 1000);
  const failedChecks = run.checks.filter((c) => !c.pass && !c.advisory);
  need(failedChecks.length === 0, `planner self-checks: ${failedChecks.map((c) => c.name).join(' | ')}`);
  const baseFrame = new TrackFrame(base.track, base.heightfield.size);
  const carve = measureRoadCarve(baseFrame, base.heightfield, base.track.halfWidth);
  need(carve <= 0.1, `carve ${carve.toFixed(3)} m off at the road edge (limit 0.1)`);

  // --- the full world data
  const t0 = performance.now();
  const data = gen(seed);
  const ms = performance.now() - t0;
  worstMs = Math.max(worstMs, ms);
  const again = gen(seed);
  need(hashOf(data) === hashOf(again), 'not deterministic: two calls differ');

  const track = data.track;
  const hf = data.heightfield;
  const f = new TrackFrame(track, hf.size);
  const n = f.n;

  // Rules (`TRACK_RULES`, src/terrain/trackRules.ts; CLAUDE.md, World).
  need(f.length >= 450 && f.length <= 650, `length ${f.length.toFixed(0)} m (450–650)`);
  let maxK = 0;
  for (let i = 0; i < n; i++) maxK = Math.max(maxK, Math.abs(f.curv[i]));
  const minR = 1 / maxK;
  need(minR >= 10, `min radius ${minR.toFixed(2)} m (≥ 10)`);
  need(Math.hypot(track.points[0], track.points[1]) < 0.01, 'point 0 is not at the origin');
  const heading = Math.atan2(track.points[2] - track.points[0], track.points[3] - track.points[1]);
  need(Math.abs(heading) < 0.01, `first segment heads ${(heading * 57.3).toFixed(2)}° off +z`);
  let ahead = 0;
  for (let i = 0; i < n; i++) { if (Math.abs(f.curv[i]) > 1 / 150) break; ahead = f.s[i + 1]; }
  let behind = 0;
  for (let i = n - 1; i >= 0; i--) { if (Math.abs(f.curv[i]) > 1 / 150) break; behind = f.length - f.s[i]; }
  need(ahead >= 40, `straight ahead ${ahead.toFixed(0)} m (≥ 40)`);
  need(behind >= 20, `straight behind ${behind.toFixed(0)} m (≥ 20)`);
  let extent = 0;
  for (let i = 0; i < n; i++) extent = Math.max(extent, Math.abs(f.px[i]), Math.abs(f.pz[i]));
  need(extent <= 64, `extent ${extent.toFixed(1)} m (≤ 64)`);
  let pinch = Infinity;
  for (let i = 0; i < n; i += 2) for (let j = i + 2; j < n; j += 2) {
    const ds = Math.min(f.s[j] - f.s[i], f.length - (f.s[j] - f.s[i]));
    if (ds < 40) continue;
    pinch = Math.min(pinch, Math.hypot(f.px[i] - f.px[j], f.pz[i] - f.pz[j]));
  }
  need(pinch >= 20, `legs ${pinch.toFixed(1)} m apart (≥ 20)`);
  need(track.halfWidth === 5 && track.shoulder === 3, `halfWidth ${track.halfWidth} / shoulder ${track.shoulder} (5 / 3)`);
  let worstStep = 0;
  for (let i = 0; i < n; i++) worstStep = Math.max(worstStep, Math.abs(f.s[i + 1] - f.s[i] - 1));
  need(worstStep <= 0.05, `point spacing off by ${worstStep.toFixed(3)} m (≤ 0.05)`);
  let maxGrade = 0;
  let startGrade = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const g = Math.abs(f.h[j] - f.h[i]) / Math.max(1e-6, f.s[i + 1] - f.s[i]);
    maxGrade = Math.max(maxGrade, g);
    if (f.s[i] <= 40 || f.s[i] >= f.length - 20) startGrade = Math.max(startGrade, g);
  }
  need(maxGrade <= 0.12, `grade ${(maxGrade * 100).toFixed(1)} % (≤ 12)`);
  need(startGrade <= 0.04, `grade on the start straight ${(startGrade * 100).toFixed(1)} % (≤ 4)`);
  need(Math.abs(f.h[0]) < 1e-3, `road at the start line is y = ${f.h[0].toFixed(3)} (0)`);
  const bends = f.findBends(1 / 22);
  const tight = bends.filter((b) => b.minRadius >= 9.5 && b.minRadius <= 16).length;
  const lefts = bends.filter((b) => b.direction === 'left').length;
  need(tight >= 2, `${tight} corners of radius 10–16 m (≥ 2)`);
  need(lefts >= 1 && lefts < bends.length, `corners turn one way only (${lefts} left of ${bends.length})`);
  // Sweeper: a stretch of at least 15 m with 1/150 < |curv| <= 1/30.
  let sweep = 0;
  let bestSweep = 0;
  for (let i = 0; i < 2 * n; i++) {
    const k = Math.abs(f.curv[i % n]);
    sweep = k > 1 / 150 && k <= 1 / 30 ? sweep + 1 : 0;
    bestSweep = Math.max(bestSweep, sweep);
  }
  need(bestSweep >= 15, `longest sweeper (radius ≥ 30 m) is ${bestSweep} m (≥ 15)`);

  // WorldData invariants.
  const plan = data.plan;
  need(!!plan && plan.version === 1, 'data.plan missing');
  if (plan) {
    need(plan.warnings.length === 0, `plan warnings: ${plan.warnings.join(' / ')}`);
    need(plan.road.startLine.marker === 'gantry', `start marker is '${plan.road.startLine.marker}'`);
    need(plan.road.halfWidth === track.halfWidth, 'plan.road.halfWidth differs from track.halfWidth');
    let worstY = 0;
    const all = [...plan.dressing, ...plan.nature];
    for (let i = 0; i < all.length; i += 7) {
      const p = all[i];
      if (p.role === 'start-gantry') continue;
      worstY = Math.max(worstY, Math.abs(p.y - hf.getHeight(p.x, p.z)));
    }
    need(worstY <= 0.003, `a placement is ${worstY.toFixed(3)} m off the final ground (≤ 0.003)`);
  }
  const samples = hf.n * hf.n;
  need(data.splat?.length === samples * 4, 'splat has the wrong length');
  need(data.shade?.length === samples * 3, 'shade has the wrong length');
  need(data.paved?.length === samples, 'paved has the wrong length');
  if (data.splat?.length === samples * 4 && data.shade?.length === samples * 3 && data.paved?.length === samples) {
    let badSum = 0, badShade = 0, paved = 0, badPaved = 0;
    for (let i = 0; i < samples; i++) {
      const s = data.splat[i * 4] + data.splat[i * 4 + 1] + data.splat[i * 4 + 2] + data.splat[i * 4 + 3];
      if (Math.abs(s - 1) > 1e-3) badSum++;
      for (let c = 0; c < 2; c++) { const v = data.shade[i * 3 + c]; if (!(v >= 0 && v <= 1.0001)) badShade++; }
      const p = data.paved[i];
      if (!(p >= 0 && p <= 1.0001)) badPaved++;
      if (p > 0.5) paved++;
    }
    need(badSum === 0, `${badSum} splat samples do not sum to 1`);
    need(badShade === 0, `${badShade} shade values outside 0..1`);
    need(badPaved === 0, `${badPaved} paved values outside 0..1`);
    need(paved > 200, `only ${paved} samples are paved (the village road alone is > 1,000 m²)`);
  }
  need(data.seed === seed, 'data.seed missing');
  // Time is gated on the MEDIAN over the sweep (below): one seed can be slow
  // for reasons that are not the generator's (another agent's Chrome, a GC).
  times.push(ms);

  // Shape signature for the variety rule: sequence of bend directions.
  const sig = bends.map((b) => (b.direction === 'left' ? 'L' : 'R')).join('');
  shapes.set(sig, (shapes.get(sig) ?? 0) + 1);

  rows.push({
    seed,
    fails,
    text:
      `seed ${String(seed).padStart(3)}  len ${f.length.toFixed(0)}  minR ${minR.toFixed(1)}  ahead ${ahead.toFixed(0)}  behind ${behind.toFixed(0)}` +
      `  ext ${extent.toFixed(0)}  legs ${pinch.toFixed(1)}  grade ${(maxGrade * 100).toFixed(1)}%  bends ${sig || '-'}` +
      `  lots ${plan?.lots.length ?? '?'}  trees ${plan?.stats.trees ?? '?'}  backdrop ${plan?.stats.backdrop ?? '?'}  batches ${plan?.stats.batches ?? '?'}  ${ms.toFixed(0)} ms` +
      (fails.length ? `\n      FAIL: ${fails.join('\n      FAIL: ')}` : ''),
  });
}

console.log(rows.map((r) => r.text).join('\n'));
const failed = rows.filter((r) => r.fails.length);
console.log(`\n${rows.length - failed.length} of ${rows.length} seeds pass every rule; slowest generateTerrain ${worstMs.toFixed(0)} ms`);
console.log(`distinct bend sequences: ${shapes.size} (${[...shapes.entries()].map(([k, v]) => `${k}×${v}`).join(', ')})`);
if (rows.length >= 30 && shapes.size < 6) {
  console.log('VARIETY: fewer than 6 distinct bend sequences over the sweep — the layouts are too alike');
  process.exit(1);
}
times.sort((a, b) => a - b);
const medianMs = times[Math.floor(times.length / 2)] ?? 0;
console.log(`median generateTerrain ${medianMs.toFixed(0)} ms (gate: ≤ 400)`);
if (medianMs > 400) {
  console.log('TIME: the median generation time is over 400 ms');
  process.exit(1);
}
process.exit(failed.length ? 1 : 0);
