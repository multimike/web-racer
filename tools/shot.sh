#!/bin/zsh
# Headless-Chrome screenshot of a dev-server page, for visual review of
# procedural assets and the game look without a visible browser.
#
#   tools/shot.sh "<path-and-query>" <out.png> [width] [height] [wait-ms]
#
# e.g. tools/shot.sh "/asset-lab.html?asset=t02-switchback-pine" /tmp/pine.png 1600 1000 6000
# Pages come from the dev server on $RACER_PORT (default 5183); if it is down
# this script starts it (racer_ensure_server). Each call uses its own
# throwaway Chrome profile, so calls can run in parallel — but only
# $RACER_CHROME_SLOTS (default 3) headless Chromes run at once machine-wide;
# extra calls wait in line (see tools/_chrome_slot.zsh).
#
# The virtual clock (--virtual-time-budget) does not wait for Web Workers or
# IndexedDB. Shot pages (`shot=1`) bake on the main thread without the boot
# cache by default and capture fine. A LIVE game page (no `shot=1`) bakes in
# workers and is captured on its loading screen: add `&workers=0&nocache=1`
# and give it a long wait (30000 ms). tools/shotlive.sh is for SHOT pages
# (`shot=1`) on the real clock only — it cannot capture a page without
# `shot=1` (it times out waiting for "shot ready").
#
# A live view=xr page is captured under its fading loading panel: use shot=1
# for xr pictures.
#
# Lifetime watchdog: a page that never lets the virtual clock finish (seen
# once with a live view=xr page) would hold Chrome — and a machine-wide slot — for
# ever. Chrome is killed after wait + 120 s; the call then fails with
# "screenshot failed" and the slot is freed.
set -e
source "${0:A:h}/_chrome_slot.zsh"
URL_PATH="$1"; OUT="$2"; W="${3:-1600}"; H="${4:-1000}"; WAIT="${5:-6000}"
PORT="${RACER_PORT:-5183}"
LIFETIME=$(( WAIT / 1000 + 120 ))
racer_ensure_server
racer_slot_acquire
PROFILE="$(mktemp -d -t racer-shot)"
CHROME_PID=""
WATCHDOG_PID=""
cleanup() {
  [ -n "$WATCHDOG_PID" ] && { pkill -P "$WATCHDOG_PID" 2>/dev/null || true; kill "$WATCHDOG_PID" 2>/dev/null || true; }
  [ -n "$CHROME_PID" ] && { kill "$CHROME_PID" 2>/dev/null || true; wait "$CHROME_PID" 2>/dev/null || true; }
  rm -rf "$PROFILE"
  racer_slot_release
}
trap cleanup EXIT
# zsh runs no EXIT trap when a signal kills it: turn the signal into an exit.
trap 'exit 143' TERM INT HUP
rm -f "$OUT"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --use-angle=metal --enable-webgl --ignore-gpu-blocklist \
  --hide-scrollbars --mute-audio --no-first-run --disable-extensions \
  --window-size="$W,$H" --virtual-time-budget="$WAIT" \
  --user-data-dir="$PROFILE" --screenshot="$OUT" \
  "http://localhost:$PORT$URL_PATH" >/dev/null 2>&1 &
CHROME_PID=$!
STARTED=$SECONDS
( sleep "$LIFETIME"; kill -9 "$CHROME_PID" 2>/dev/null ) >/dev/null 2>&1 &!
WATCHDOG_PID=$!
set +e
wait "$CHROME_PID"
CHROME_STATUS=$?
set -e
CHROME_PID=""
if [ "$CHROME_STATUS" -ge 128 ] && ! [ -s "$OUT" ]; then
  if (( SECONDS - STARTED >= LIFETIME )); then
    echo "screenshot failed: $OUT (Chrome killed after the ${LIFETIME} s lifetime)" >&2
  else
    echo "screenshot failed: $OUT (Chrome died, status $CHROME_STATUS, after $(( SECONDS - STARTED )) s)" >&2
  fi
  exit 1
fi
[ -s "$OUT" ] && echo "wrote $OUT" || { echo "screenshot failed: $OUT" >&2; exit 1; }
