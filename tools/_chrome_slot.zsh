# Counting semaphore shared by the headless-Chrome tools (shot.sh, shotlive.sh,
# physlab.sh, warmboot.sh, distboot.sh). Every tool also kills its Chrome after
# a lifetime watchdog, so a hung page cannot hold a slot for ever.
#
# Why: many agents calling these tools at once starved the Mac until the
# kernel watchdog panicked (2026-11-21). At most $RACER_CHROME_SLOTS (default
# 3) headless Chromes run at any moment, machine-wide; further calls wait in
# line. A slot whose owner process died is reclaimed automatically.
#
# Usage (sourced):  racer_slot_acquire; trap racer_slot_release EXIT
RACER_SLOT=""
racer_slot_acquire() {
  local n="${RACER_CHROME_SLOTS:-3}"
  local dir="${RACER_SLOT_DIR:-${TMPDIR:-/tmp}/racer-chrome-slots}"
  local i pid waited=0 now mtime
  mkdir -p "$dir"
  while true; do
    for i in $(seq 1 "$n"); do
      if mkdir "$dir/$i" 2>/dev/null; then
        echo $$ > "$dir/$i/pid"
        RACER_SLOT="$dir/$i"
        return 0
      fi
      pid="$(cat "$dir/$i/pid" 2>/dev/null || true)"
      if [ -n "$pid" ]; then
        # Owner gone (killed tool, timed-out agent): free the slot.
        kill -0 "$pid" 2>/dev/null || rm -rf "$dir/$i"
      else
        # No pid yet: either being claimed right now or orphaned mid-claim.
        now="$(date +%s)"; mtime="$(stat -f %m "$dir/$i" 2>/dev/null || echo "$now")"
        [ $((now - mtime)) -gt 15 ] && rm -rf "$dir/$i"
      fi
    done
    if [ "$waited" -eq 20 ]; then
      echo "waiting for a free headless-Chrome slot (max $n at once, machine protection)…" >&2
    fi
    waited=$((waited + 1))
    sleep 0.5
  done
}
racer_slot_release() {
  [ -n "$RACER_SLOT" ] && rm -rf "$RACER_SLOT"
  RACER_SLOT=""
  return 0
}

# The dev server (launch config "racer", port 5183) sometimes dies during long
# unattended runs. Bring it back instead of failing every screenshot: vite
# with --strictPort, so a second start attempt simply exits if one is up.
RACER_ROOT="${0:A:h:h}"   # evaluated while sourcing: $0 is this file here, a function name inside functions
racer_ensure_server() {
  local port="${RACER_PORT:-5183}" root="$RACER_ROOT" i
  curl -s -o /dev/null --max-time 5 "http://localhost:$port/" && return 0
  echo "dev server on $port is down — starting it…" >&2
  ( cd "$root" && nohup npx vite --port "$port" --strictPort >/dev/null 2>&1 & ) >/dev/null 2>&1
  for i in $(seq 1 60); do
    sleep 0.5
    curl -s -o /dev/null --max-time 2 "http://localhost:$port/" && return 0
  done
  echo "dev server on $port did not come up" >&2
  return 1
}
