#!/bin/zsh
# Headless runner for the raycast break-test page: tools/physlab.sh itself
# (same queue of at most 3 headless Chromes, same protocol), pointed at this
# folder's page through $PHYSLAB_PAGE.
#   src/lab/physics/extra-raycast/breaklab.sh "<query>" <out.json> [timeout-seconds]
#   e.g. breaklab.sh "model=raycast&suite=xrSaw,xrDonut&series=0" out.json 300
set -e
HERE="${0:A:h}"
ROOT="${HERE:h:h:h:h}"
PHYSLAB_PAGE="src/lab/physics/extra-raycast/break.html" exec "$ROOT/tools/physlab.sh" "$@"
