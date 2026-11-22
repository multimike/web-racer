#!/bin/zsh
# Load a report page SEVERAL TIMES IN ONE Chrome profile and save each run's
# result JSON — the way to measure a WARM boot (the second visit, with the
# boot bake cache in IndexedDB from the first). tools/physlab.sh uses a fresh
# profile per call, so every run there is cold.
#
#   tools/warmboot.sh "<query>" <out-prefix> [runs=2] [timeout-seconds-per-run=300]
#
# e.g. tools/warmboot.sh "seed=6&autopilot=1&rivals=3&report=1&seconds=5&liveboot=1" /tmp/wb 3
#      → /tmp/wb-1.json (cold), /tmp/wb-2.json, /tmp/wb-3.json (warm)
#
# PHYSLAB_PAGE selects the page (default index.html). Same machine
# protection as physlab.sh: one Chrome slot from tools/_chrome_slot.zsh, a
# throwaway profile deleted afterwards, Vite's HMR socket stubbed out, a hard
# lifetime watchdog. Exit 0 when every run reached title 'done'.
set -e
if [ $# -lt 2 ]; then
  echo "usage: tools/warmboot.sh \"<query>\" <out-prefix> [runs] [timeout-seconds]" >&2
  exit 2
fi
QUERY="${1#\?}"; OUT="$2"; RUNS="${3:-2}"; TIMEOUT="${4:-300}"
PORT="${RACER_PORT:-5183}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
source "${0:A:h}/_chrome_slot.zsh"
racer_ensure_server
racer_slot_acquire
trap racer_slot_release EXIT
PROFILE="$(mktemp -d -t racer-warmboot)"
PAGE="${PHYSLAB_PAGE:-index.html}"
# $WB_BASE_URL: another origin (tools/distboot.sh serves a production build).
URL="${WB_BASE_URL:-http://localhost:$PORT}/${PAGE#/}?$QUERY"

"$CHROME" --headless=new --use-angle=metal --enable-webgl --ignore-gpu-blocklist \
  --mute-audio --no-first-run \
  --disable-extensions --disable-background-timer-throttling \
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --remote-debugging-port=0 --user-data-dir="$PROFILE" about:blank \
  >/dev/null 2>&1 &
CHROME_PID=$!
( sleep $((TIMEOUT * RUNS + 120)); kill -9 "$CHROME_PID" 2>/dev/null ) >/dev/null 2>&1 &!
WATCHDOG_PID=$!
cleanup() {
  pkill -P "$WATCHDOG_PID" 2>/dev/null || true
  kill "$WATCHDOG_PID" 2>/dev/null || true
  kill "$CHROME_PID" 2>/dev/null || true
  wait "$CHROME_PID" 2>/dev/null || true
  rm -rf "$PROFILE"
  racer_slot_release
}
trap cleanup EXIT
# zsh runs no EXIT trap when a signal kills it: turn the signal into an exit.
trap 'exit 143' TERM INT HUP

set +e
WB_PROFILE="$PROFILE" WB_URL="$URL" WB_OUT="$OUT" WB_TIMEOUT="$TIMEOUT" WB_RUNS="$RUNS" \
node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { WB_PROFILE: profile, WB_URL: url, WB_OUT: out } = process.env;
const timeoutMs = Number(process.env.WB_TIMEOUT) * 1000;
const runs = Number(process.env.WB_RUNS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  console.error(`warmboot: FAILED — ${message}`);
  process.exit(1);
};

let port = 0;
for (let i = 0; i < 200 && !port; i++) {
  const file = `${profile}/DevToolsActivePort`;
  if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0]);
  if (!port) await sleep(50);
}
if (!port) fail('Chrome did not open a DevTools port');
let target;
for (let i = 0; i < 100 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* not up yet */ }
  if (!target) await sleep(50);
}
if (!target) fail('no page target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
});
let nextId = 1;
const pending = new Map();
let pageErrors = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(`uncaught: ${d.exception?.description ?? d.text} (${d.url ?? ''}:${d.lineNumber ?? ''})`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    pageErrors.push(`log: ${msg.params.entry.text} (${msg.params.entry.url ?? ''})`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = window.WebSocket;
    const isVite = (p) => [].concat(p ?? []).some((x) => typeof x === 'string' && x.startsWith('vite-'));
    function Stub(url, protocols) {
      if (!isVite(protocols)) return new Real(url, protocols);
      const t = new EventTarget();
      return Object.assign(t, { url: String(url), readyState: 0, protocol: '', bufferedAmount: 0, send() {}, close() {} });
    }
    Stub.prototype = Real.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Stub[k] = Real[k];
    window.WebSocket = Stub;
  })();`,
});

let bad = 0;
for (let run = 1; run <= runs; run++) {
  pageErrors = [];
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  const started = Date.now();
  await send('Page.navigate', { url });
  let title = '';
  for (;;) {
    if (Date.now() - started > timeoutMs) fail(`run ${run}: timeout after ${timeoutMs / 1000} s`);
    try {
      const got = await Promise.race([evaluate('document.title'), sleep(5000)]);
      if (typeof got === 'string') title = got;
    } catch { /* navigating */ }
    if (title === 'done' || title === 'error') break;
    await sleep(200);
  }
  const text = await evaluate("document.getElementById('result').textContent");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail(`run ${run}: result is not JSON`);
  }
  result.errors = [...(result.errors ?? []), ...pageErrors.filter((e) => !(result.errors ?? []).some((x) => e.includes(x)))];
  result.runner = { url, run, wallSeconds: Math.round((Date.now() - started) / 100) / 10 };
  const file = `${out}-${run}.json`;
  writeFileSync(file, JSON.stringify(result));
  const s = result.stats ?? {};
  console.log(`run ${run}: gameMs ${s['boot.gameMs']}  totalMs ${s['boot.totalMs']}  props ${s['boot.propsMs']}  cars ${s['boot.carsMs']}  hits ${s['boot.bake.cacheHits']}  misses ${s['boot.bake.cacheMisses']}  persisted ${s['boot.bake.persisted']}  → ${file}`);
  if (title === 'error' || result.fatal || result.errors.length) {
    bad++;
    for (const e of result.errors) console.error(`  ${e}`);
  }
  // Let the page's background cache write finish before the next visit.
  await sleep(1500);
}
ws.close();
process.exit(bad ? 1 : 0);
NODE
exit $?
