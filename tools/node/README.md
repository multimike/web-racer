# Node-side tools (Babylon-free checks and the report gate)

Plain Node ≥ 22.18 (native TypeScript type stripping; `hooks.mjs` needs it) — no browser, no Chrome
slot, a few hundred milliseconds per seed. Only Babylon-free repo modules
can be imported this way (src/terrain, src/world, src/game/RaceState.ts,
src/car/ai mostly). These `*.ts` files are outside tsconfig's `include`:
`npx tsc --noEmit` never type-checks them (Node only strips the types).

Run everything from the repo root:

    node --import ./tools/node/register.mjs tools/node/<script.ts> [args]

- `register.mjs` + `hooks.mjs` — resolve hook: lets Node import the repo's
  extensionless TypeScript imports (`./track` → `./track.ts`,
  `./world` → `./world/index.ts`).
- `track-stats.ts [from] [to]` — per seed: length, minimum radius, straight
  ahead / behind the start line, extent, closest approach of two legs,
  grade, generation time of whatever `generateTerrain` currently does.
- `world-sweep.ts [from=1] [to=40]` — ACCEPTANCE SWEEP: every track rule of
  `TRACK_RULES`, the planner's self-checks on `generateBaseTerrain`, the
  carve, determinism, the `WorldData` invariants. Exit status 1 on any
  failure. Generation time is gated on the MEDIAN over the sweep
  (≤ 400 ms), not on every single seed.
- `report-checks.mjs <result.json> … [--allow=id,prefix.] [--need=id,prefix.]`
  — THE PASS / FAIL GATE for every `?report=1` result (index.html,
  drive-lab, terrain-lab, props-lab) and every physics-lab result:
  `tools/physlab.sh` exits 0 whenever the page ran to the end without page
  errors, whatever its checks say; this script exits 1 on any failed check, on `fatal`, on page
  errors and on a missing `--need` id. Plain `node`, no register hook.
- `dpr-probe.ts` — mock-clock cases for `DprGovernor` (the high preset's
  pixel-ratio step-down, src/game/quality.ts), each with an expected end
  ratio and trial count. Exit status 1 on any mismatch.
- `pngdiff.mjs a.png b.png [diff.png]` — pixel comparison of two
  screenshots (largest per-channel difference, bounding box, optional diff
  image). Plain `node`. Exit 0 when the largest difference is ≤ 2 of 255.
- `static-serve.mjs <dir>` — minimal static server for a production build;
  started and stopped by `tools/distboot.sh` only.

Browser-side companions in `tools/`: `shot.sh` (virtual-clock screenshot),
`shotlive.sh` (real-clock screenshot of `shot=1` pages only, several loads
in one profile),
`physlab.sh` (report run, fresh profile), `warmboot.sh` (report runs in one
profile: cold, then warm), `distboot.sh` (the same against a built `dist/`).
