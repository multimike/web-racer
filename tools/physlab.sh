#!/bin/zsh
# Run the physics lab (physics-lab.html) in headless Chrome and save its
# result JSON. This is how vehicle models get measured without a visible
# browser.
#
#   tools/physlab.sh "<query>" <out.json> [timeout-seconds]
#
# e.g. tools/physlab.sh "model=rigid&car=reef-rocket&suite=all" /tmp/rigid.json
#      tools/physlab.sh "model=rigid&suite=launch,brake&dt=1/90&series=0" out.json 120
#
# Prints the scorecard to stdout. Exit status: 0 = suite ran to completion
# (whatever the score), 1 = timeout / page error / uncaught exception / bad
# JSON — the reason goes to stderr and, where a result exists, into its
# "errors" array (console errors and uncaught exceptions are captured too).
#
# Pages come from the dev server on $RACER_PORT (default 5183); if it is
# down this script starts it (racer_ensure_server). Each call
# uses its own throwaway Chrome profile and an OS-assigned DevTools port, so
# calls can run in parallel — but only $RACER_CHROME_SLOTS (default 3)
# headless Chromes run at once machine-wide; extra calls wait in line and the
# wait does NOT count against [timeout-seconds] (see tools/_chrome_slot.zsh).
# The page is cut off from Vite's HMR socket, so source saves by other agents
# cannot restart a run, and Chrome is killed after timeout + 120 s even if this
# shell dies.
# No npm dependencies: plain Node 22 (built-in
# WebSocket + fetch) speaking the Chrome DevTools Protocol. Virtual-time
# tricks are deliberately avoided — the page computes in real wall time and
# signals completion through document.title.
set -e
if [ $# -lt 2 ]; then
  echo "usage: tools/physlab.sh \"<query>\" <out.json> [timeout-seconds]" >&2
  exit 2
fi
QUERY="${1#\?}"; OUT="$2"; TIMEOUT="${3:-600}"
PORT="${RACER_PORT:-5183}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
source "${0:A:h}/_chrome_slot.zsh"
racer_ensure_server
racer_slot_acquire
trap racer_slot_release EXIT
PROFILE="$(mktemp -d -t racer-physlab)"
# $PHYSLAB_PAGE: another lab page with the same protocol (the break-test pages
# under src/lab/physics/extra-*/break.html); default the standard lab.
PAGE="${PHYSLAB_PAGE:-physics-lab.html}"
URL="http://localhost:$PORT/${PAGE#/}?$QUERY"

"$CHROME" --headless=new --use-angle=metal --enable-webgl --ignore-gpu-blocklist \
  --mute-audio --no-first-run \
  --disable-extensions --disable-background-timer-throttling \
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --remote-debugging-port=0 --user-data-dir="$PROFILE" about:blank \
  >/dev/null 2>&1 &
CHROME_PID=$!
# Hard lifetime: if this shell is killed (agent timeout), nothing else stops
# Chrome, and an orphaned lab page keeps computing at 100 % CPU. The watchdog
# is disowned so it outlives the shell.
( sleep $((TIMEOUT + 120)); kill -9 "$CHROME_PID" 2>/dev/null ) >/dev/null 2>&1 &!
WATCHDOG_PID=$!
cleanup() {
  pkill -P "$WATCHDOG_PID" 2>/dev/null || true   # its sleep first, while the parent link exists
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
PHYSLAB_PROFILE="$PROFILE" PHYSLAB_URL="$URL" PHYSLAB_OUT="$OUT" PHYSLAB_TIMEOUT="$TIMEOUT" \
node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { PHYSLAB_PROFILE: profile, PHYSLAB_URL: url, PHYSLAB_OUT: out } = process.env;
const timeoutMs = Number(process.env.PHYSLAB_TIMEOUT) * 1000;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  console.error(`physlab: FAILED — ${message}`);
  process.exit(1);
};

// 1. Chrome writes the port it picked into <profile>/DevToolsActivePort.
let port = 0;
for (let i = 0; i < 200 && !port; i++) {
  const file = `${profile}/DevToolsActivePort`;
  if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0]);
  if (!port) await sleep(50);
}
if (!port) fail('Chrome did not open a DevTools port');

// 2. Attach to the blank page target.
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
const pageErrors = [];
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// Cut the page off from Vite's HMR socket. The dev server broadcasts a full
// reload to every connected page whenever ANY source file is saved, which
// restarted a running suite from zero each time another agent saved a file
// (runs longer than the save interval never finished). The stub never opens
// and never closes, so the Vite client neither reloads nor starts polling.
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
await send('Page.navigate', { url });

// 3. Wait for the page to announce it is finished.
let title = '';
let lastStatus = '';
for (;;) {
  if (Date.now() - started > timeoutMs) {
    let status = '';
    try {
      status = await Promise.race([evaluate("document.getElementById('status')?.textContent"), sleep(2000)]);
    } catch { /* page busy */ }
    for (const e of pageErrors) console.error(`  ${e}`);
    fail(`timeout after ${timeoutMs / 1000} s (last status: ${status || lastStatus || 'unknown'})`);
  }
  try {
    // Race: a busy page answers late; never hang on one call.
    const got = await Promise.race([
      evaluate("JSON.stringify([document.title, document.getElementById('status')?.textContent ?? ''])"),
      sleep(5000),
    ]);
    if (got) [title, lastStatus] = JSON.parse(got);
  } catch { /* navigating */ }
  if (title === 'done' || title === 'error') break;
  await sleep(200);
}

// 4. Extract, annotate, save.
const text = await evaluate("document.getElementById('result').textContent");
let result;
try {
  result = JSON.parse(text);
} catch {
  fail(`result is not JSON: ${String(text).slice(0, 200)}`);
}
result.errors = [...(result.errors ?? []), ...pageErrors.filter((e) => !(result.errors ?? []).some((x) => e.includes(x)))];
result.runner = { url, wallSeconds: Math.round((Date.now() - started) / 100) / 10 };
writeFileSync(out, JSON.stringify(result));
ws.close();

if (title === 'error' || result.fatal) {
  for (const e of result.errors) console.error(`  ${e}`);
  fail(`page reported a fatal error: ${result.fatal ?? 'see errors'}`);
}
console.log(result.scorecard?.text ?? '');
console.log(`physlab: wrote ${out} — ${result.totals.simSeconds} s simulated, ${result.runner.wallSeconds} s wall`);
if (result.errors.length > 0) {
  for (const e of result.errors) console.error(`  ${e}`);
  fail(`${result.errors.length} page error(s) during the run (result still written to ${out})`);
}
process.exit(0);
NODE
STATUS=$?
exit $STATUS
