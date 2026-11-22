#!/bin/zsh
# Headless runner for the hybrid break-test page: tools/physlab.sh itself (same
# queue of at most 3 headless Chromes, same protocol), pointed at this
# folder's page through $PHYSLAB_PAGE.
#   src/lab/physics/extra-hybrid/breaklab.sh "<query>" <out.json> [timeout-seconds]
set -e
HERE="${0:A:h}"
ROOT="${HERE:h:h:h:h}"
PHYSLAB_PAGE="src/lab/physics/extra-hybrid/break.html" exec "$ROOT/tools/physlab.sh" "$@"
