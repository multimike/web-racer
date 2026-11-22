#!/bin/zsh
# Screenshot a SHOT page (shot=1) on the REAL clock, several times in ONE
# Chrome profile — for picture A/B of the boot paths: the bake-worker and warm-cache
# boot paths cannot run under tools/shot.sh's virtual clock (it does not wait
# for workers or IndexedDB), so this tool waits until the page's #status says
# "shot ready" and captures the viewport through the DevTools protocol.
# ONLY for shot=1 pages: a page without shot=1 never says "shot ready", so
# the run times out (timeout-s) without a picture. A live page goes through
# tools/shot.sh with &workers=0&nocache=1 and a long wait instead.
#
#   tools/shotlive.sh "<path-and-query>" <out-prefix> [runs=1] [width=1600] [height=1000] [timeout-s=300]
#
# e.g. tools/shotlive.sh "/index.html?seed=1&shot=1&at=0.5&workers=4&nocache=0" /tmp/g1 2 1280 720
#      → /tmp/g1-1.png (cold cache), /tmp/g1-2.png (warm)
#
# Same machine protection as physlab.sh (one Chrome slot, throwaway profile,
# HMR socket stubbed, lifetime watchdog).
set -e
if [ $# -lt 2 ]; then
  echo "usage: tools/shotlive.sh \"<path-and-query>\" <out-prefix> [runs] [w] [h] [timeout-s]" >&2
  exit 2
fi
URL_PATH="$1"; OUT="$2"; RUNS="${3:-1}"; W="${4:-1600}"; H="${5:-1000}"; TIMEOUT="${6:-300}"
PORT="${RACER_PORT:-5183}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
source "${0:A:h}/_chrome_slot.zsh"
racer_ensure_server
racer_slot_acquire
trap racer_slot_release EXIT
PROFILE="$(mktemp -d -t racer-shotlive)"
URL="http://localhost:$PORT$URL_PATH"

"$CHROME" --headless=new --use-angle=metal --enable-webgl --ignore-gpu-blocklist \
  --mute-audio --no-first-run --hide-scrollbars --window-size="$W,$H" \
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
WB_PROFILE="$PROFILE" WB_URL="$URL" WB_OUT="$OUT" WB_TIMEOUT="$TIMEOUT" WB_RUNS="$RUNS" WB_W="$W" WB_H="$H" \
node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { WB_PROFILE: profile, WB_URL: url, WB_OUT: out } = process.env;
const timeoutMs = Number(process.env.WB_TIMEOUT) * 1000;
const runs = Number(process.env.WB_RUNS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  console.error(`shotlive: FAILED — ${message}`);
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

await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.WB_W), height: Number(process.env.WB_H), deviceScaleFactor: 1, mobile: false });
let bad = 0;
for (let run = 1; run <= runs; run++) {
  pageErrors = [];
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  const started = Date.now();
  await send('Page.navigate', { url });
  let status = '';
  for (;;) {
    if (Date.now() - started > timeoutMs) fail(`run ${run}: timeout after ${timeoutMs / 1000} s (status: ${status})`);
    try {
      const got = await Promise.race([evaluate("document.getElementById('status')?.textContent ?? ''"), sleep(5000)]);
      if (typeof got === 'string') status = got;
    } catch { /* navigating */ }
    if (status.startsWith('shot ready') || /error|fail/i.test(status)) break;
    await sleep(200);
  }
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${out}-${run}.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`run ${run}: ${((Date.now() - started) / 1000).toFixed(1)} s  ${status}  → ${file}`);
  if (pageErrors.length) {
    bad++;
    for (const e of pageErrors) console.error(`  ${e}`);
  }
  await sleep(1500);
}
ws.close();
process.exit(bad ? 1 : 0);
NODE
exit $?
