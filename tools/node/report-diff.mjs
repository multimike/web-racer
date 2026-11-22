// Compare the race of two `?report=1` results (contracts/report.ts): the
// menu's pause and title-hold checks (SPEC 12, checks 5 and 6) say a run
// with `pausetest=` / `titlehold=` must give the SAME race as a plain run.
//
//   node <this dir>/report-diff.mjs <a.json> <b.json> [--keys=prefix,prefix]
//
// Compares every stat whose key starts with one of the prefixes (default
// `race.`: per-car laps, finish time, position, respawns, odometer, lap
// times, moved30) and `totals.simSeconds`. Prints each difference; exit 1
// on any, on a missing file or on a report without race stats.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const keysArg = (args.find((a) => a.startsWith('--keys=')) ?? '--keys=race.').slice('--keys='.length);
const prefixes = keysArg.split(',').filter(Boolean);
if (files.length !== 2) {
  console.error('usage: node report-diff.mjs <a.json> <b.json> [--keys=race.,frame.]');
  process.exit(2);
}
const load = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`${f}: cannot read (${e.message})`);
    process.exit(1);
  }
};
const [a, b] = files.map(load);
const pick = (r) => {
  const out = {};
  for (const [k, v] of Object.entries(r.stats ?? {})) if (prefixes.some((p) => k.startsWith(p))) out[k] = v;
  out['totals.simSeconds'] = r.totals?.simSeconds ?? null;
  return out;
};
const sa = pick(a);
const sb = pick(b);
const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort();
let diff = 0;
for (const k of keys) {
  const va = JSON.stringify(sa[k] ?? null);
  const vb = JSON.stringify(sb[k] ?? null);
  if (va !== vb) {
    diff++;
    console.log(`DIFF ${k}: ${va} vs ${vb}`);
  }
}
if (keys.length <= 1) {
  console.log('no race stats to compare');
  process.exit(1);
}
console.log(`${keys.length} values compared, ${diff} differ`);
process.exit(diff === 0 ? 0 : 1);
