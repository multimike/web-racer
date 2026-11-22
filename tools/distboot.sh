#!/bin/zsh
# Boot a PRODUCTION BUILD (npx vite build --outDir <dir>) in headless Chrome
# through the report protocol: serves <dir> with tools/node/static-serve.mjs
# on a free local port for the duration of the run only, then runs
# tools/warmboot.sh against it (so the runs share one profile: run 1 cold,
# later runs warm).
#
#   tools/distboot.sh <dist-dir> "<query>" <out-prefix> [runs=2] [timeout-s=300]
set -e
if [ $# -lt 3 ]; then
  echo "usage: tools/distboot.sh <dist-dir> \"<query>\" <out-prefix> [runs] [timeout-s]" >&2
  exit 2
fi
DIR="$1"; QUERY="$2"; OUT="$3"; RUNS="${4:-2}"; TIMEOUT="${5:-300}"
HERE="${0:A:h}"
LOG="$(mktemp -t racer-distserve)"
node "$HERE/node/static-serve.mjs" "$DIR" > "$LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -f "$LOG"' EXIT
PORT=""
for i in $(seq 1 100); do
  PORT="$(sed -n 's/^port //p' "$LOG")"
  [ -n "$PORT" ] && break
  sleep 0.05
done
[ -n "$PORT" ] || { echo "distboot: static server did not start" >&2; exit 1; }
WB_BASE_URL="http://127.0.0.1:$PORT" "$HERE/warmboot.sh" "$QUERY" "$OUT" "$RUNS" "$TIMEOUT"
