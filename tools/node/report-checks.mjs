// Gate for a `?report=1` result (contracts/report.ts) or a physics-lab result.
// tools/physlab.sh exits 0 whenever the page ran to the end — WHATEVER its
// checks say. This script is what turns failed checks into a failed command:
//
//   node <this dir>/report-checks.mjs <result.json> [more.json …] [--allow=id,id] [--need=id,id]
//
// - LabReport pages (index.html, drive-lab, terrain-lab, props-lab):
//     every entry of `checks` must have pass === true;
// - physics-lab results: every `maneuvers.<name>.checks[]` entry must pass;
// - `--allow=a,b` : check ids that may fail (exact id, or a PREFIX when it
//                   ends with a dot: `--allow=driftInitiate.` — no `*`, zsh
//                   would try to glob it);
// - `--need=a,b`  : check ids (exact, or prefix ending with a dot) that must
//                   be PRESENT (and pass).
// Prints one line per failing check and a summary; exit 1 on any failure,
// on `fatal`, on a non-empty `errors` array, or on a missing --need id.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const list = (flag) => (args.find((a) => a.startsWith(`--${flag}=`)) ?? '').split('=').slice(1).join('=').split(',').filter(Boolean);
const allow = list('allow');
const need = list('need');
const matches = (id, pattern) => (pattern.endsWith('.') ? id.startsWith(pattern) : id === pattern);
if (files.length === 0) {
  console.error('usage: node report-checks.mjs <result.json> [more.json …] [--allow=id,prefix.] [--need=id,prefix.]');
  process.exit(2);
}

let bad = 0;
for (const file of files) {
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`${file}: cannot read (${e.message})`);
    bad++;
    continue;
  }
  const checks = [];
  if (Array.isArray(r.checks)) for (const c of r.checks) checks.push(c);
  if (r.maneuvers && typeof r.maneuvers === 'object') {
    for (const m of Object.values(r.maneuvers)) if (Array.isArray(m?.checks)) for (const c of m.checks) checks.push(c);
  }
  const failed = checks.filter((c) => c.pass !== true && !allow.some((p) => matches(String(c.id), p)));
  const waved = checks.filter((c) => c.pass !== true && allow.some((p) => matches(String(c.id), p)));
  const missing = need.filter((p) => !checks.some((c) => matches(String(c.id), p)));
  for (const c of failed) console.log(`FAIL ${file}: ${c.id} = ${JSON.stringify(c.value)}  (target: ${c.target ?? '?'})`);
  for (const c of waved) console.log(`allowed ${file}: ${c.id} = ${JSON.stringify(c.value)}`);
  for (const p of missing) console.log(`MISSING ${file}: no check '${p}'`);
  if (r.fatal) console.log(`FATAL ${file}: ${r.fatal}`);
  const errors = Array.isArray(r.errors) ? r.errors : [];
  for (const e of errors) console.log(`ERROR ${file}: ${e}`);
  const ok = failed.length === 0 && missing.length === 0 && !r.fatal && errors.length === 0 && checks.length > 0;
  if (checks.length === 0) console.log(`EMPTY ${file}: no checks found`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${checks.length - failed.length - waved.length} of ${checks.length} checks pass` + (waved.length ? `, ${waved.length} allowed to fail` : ''));
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
