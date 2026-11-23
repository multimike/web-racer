# Web Racer — XR RC-style racing game

WebXR racing game for Quest 3: players stand and look down at a diorama-scale
world (a 200 × 200 m world shown as a ~4 m table, cars ~10 cm) and race toy
buggies against three AI rivals. Meant to ship as a PWA ("install from web
page"); no manifest or service worker exists yet.
Development happens on desktop (Mac) with a DualShock 4 or keyboard; the WebXR
session itself is NOT wired up yet — `?view=xr` is its mono desktop preview.
Owner's target look: `design-documents/gameplay-vision/` (two images); the
design packs beside it (cars, environment, buildings, ground materials).

## Stack and commands

- Vite + TypeScript (`erasableSyntaxOnly` ON — no constructor parameter
  properties, no enums; `noUnusedLocals` / `noUnusedParameters` ON)
- Babylon.js 9 (`@babylonjs/core`) + Havok (`@babylonjs/havok`)
- Dev server: port **5183**, launch config `racer` in `.claude/launch.json`
  (5173 / 5174 belong to another project). `tools/shot.sh` and
  `tools/physlab.sh` restart it if it is down.
- `npx tsc --noEmit` type-checks `src/` only (`tools/node/*.ts`: never).
  `npx vite build` emits `index.html` only (other `*.html` = dev-server
  labs); `vite.config.ts` holds ONLY `base: './'`, so a build also boots
  from a sub-folder. Node tools need Node ≥ 22.18.
- HOSTING: public repo `multimike/web-racer`; every push to `main` runs
  `.github/workflows/pages.yml` (`npm ci`, `npm run build`, publish `dist/`)
  to GitHub Pages: https://multimike.github.io/web-racer/ . `README.md` is
  the public front page (play link, controls, URL options, design-pack
  links; its pictures are `docs/screenshot-*.jpg`): keep its controls and
  options tables in step with the game.
- `window.__game` (dev builds) = the `Game` of `createScene.ts`;
  `__look.config` = live lighting; `__game.dust[i].params` = per-car dust.

## Architecture

Everything is procedural TypeScript: no imported meshes, no textures on
assets (the generated ground materials are the only textures). Data flow:

```
seed → generateTerrain(seed) = WorldData        Babylon-free, ~0.2 s
        ├─ createTerrainSurface  terrain chunks + paving + Havok heightfield
        ├─ createWorldProps      near / far thin-instance tiers + colliders
        ├─ buildField + gridPoses → createGameCar × 4 (vehicle + procedural car)
        ├─ RivalField + RivalDriver per rival
        └─ RaceSession: RaceState → HudSnapshot → Hud
```

- `src/game/contracts/` — TYPE-ONLY seams between modules (`world.ts`
  WorldData / GroundQuery, `terrain.ts`, `props.ts`, `car.ts`, `camera.ts`,
  `quality.ts`, `report.ts`). No logic, no values; import with `import type`.
  The header comment of each is the spec its implementer meets.
- `src/main.ts` → `src/scene/createScene.ts` (`createGame`): BOOT ORDER =
  parse URL (`src/game/options.ts`) → loading screen (`main.ts`) → quality
  preset (`src/game/quality.ts`) → Engine → Scene → Havok with `new
  HavokPlugin(false, …)` (fixed-step mode) at gravity 25 → `createLook` (sky, sun shadows, fog) →
  `BootBakes` starts baking the cars in workers → hills: `generateTerrain` →
  surface → backdrop hills → `await createWorldProps` (prop bakes join the
  pool; progress on the loading screen; `worldScatterDensity` thins quest
  scatter on heavy worlds) / flat: `createFlatArena` → cars one by one → camera rig, actions, dust, engine
  sound + music, dev UI → the after-physics observer LAST (each vehicle's own
  observers must run before it) → two warm-up frames → loop.
- FRAME ORDER (one `dt` rule): `dt = beginPhysicsFrame(scene)` (sets Havok's
  step to the frame time clamped 1/240 … 1/20 s, so below 20 fps the game runs
  in slow motion instead of taking long steps; shot / report: fixed 1/60) →
  render resolution (`DprGovernor`, before drawing: a resize clears the
  canvas) → actions → `session.beforePhysics`: rivals decide (`RivalField.update`),
  every `vehicle.update(dt)` → `scene.render()` steps Havok by the SAME dt →
  `onAfterPhysicsObservable`: `car.syncVisual` → `session.afterPhysics` (race,
  respawns, HUD) → camera rig → `props.update` (near ring) → shadow focus →
  dust, engine sound + music, perf.
- `src/boot/` — LOAD TIME. `gameBoot.ts` (`BootBakes`, `bootFlags`): asset
  preparation (builders, AO bakes, far models, car lite meshes) runs in a
  pool of `min(4, cores − 1)` module workers (`bakePool.ts`, `bakeWorker.ts`,
  `prepare.ts`), the idle main thread takes prop jobs too; AO bakes and
  simplifications are cached in IndexedDB (`store.ts`, `persist.ts`) under a
  content hash of the step's EXACT input plus a version constant. Every path
  (main thread, workers, cold, warm, production build) gives byte-identical
  buffers; `?bakehash=1` prints digests to compare. A lost worker falls back
  to the main thread and fails the report check `boot.bakeWorkers`. CHANGE A
  BAKE'S ALGORITHM → BUMP ITS VERSION (`AO_BAKE_VERSION` in
  `src/gfx/solid/ao.ts`, `SIMPLIFY_VERSION` in `src/render/scatter/simplify.ts`,
  `HULL_INDICES_VERSION` in `src/gfx/solid/hull.ts`), or returning visitors
  keep the old result. Dev console: `__bootCache.clear()`.
- `src/game/RaceSession.ts` — race rules: 3 s countdown with the player's
  input gated to zero and rivals held; respawns (`snapshot.needsReset`,
  `needsRescue`, `isOutOfWorld`, a rival's `rescue`, the reset button) through
  `race.respawn(id)` → sideways shift if a car is in the way → `car.place`.
  `restart()` (Enter) resets every rival driver and pushes each chassis
  pose into Havok at once: race 1 replays bit-identically (`raycast`,
  `hybrid`). With the game menu the session starts HELD (`held`,
  `setHeld`: `race.update(0)`, the countdown stays at 3, respawn rules keep
  running) and `menuLocked` gates the player's input; without it the live
  page restarts the countdown once the loading panel has faded (not with
  `?spot=`). Best lap: `localStorage` key
  `web-racer.bestLap.hills2-<seed>`,
  only for a human on the stock `raycast` car.
  `src/game/RaceState.ts` (lap logic, every metre a checkpoint, cuts) and
  `src/ui/Hud.ts` (DOM HUD fed a plain snapshot) are finished modules.
- `src/game/car/` (`GameCar`, `CarLod`) — vehicle + procedural car from the
  asset registry; 3 LODs by camera distance (the followed car is always LOD
  0); `car.place(pose)` = `Vehicle.reset` is the ONLY way to move a car.
- `src/game/camera/` — `CAMERA_TUNING` and the rig: `chase` (tuned on vision
  image 1), `high` (vision image 2), `xr` (diorama orbit: `CAMERA_TUNING.xr`
  is 85 m up / 85 m back ≈ a 1.7 m viewer at a 4 m table; the game's default
  pose scales it by `XR_PREVIEW` — ×1.22, target z −20 — so the eye sits
  ~104 m up / ~84 m behind the target). Labs pose their cameras from it.
- `src/input/` — `CarIntent` {throttle, steering, brake} from an
  `InputProvider` (gamepad, keyboard, `CompositeInput` = strongest wins; a
  `RivalDriver` is one too). `GameActions.ts` = edge-triggered non-driving
  buttons. Brake-at-standstill = reverse is decided in the VEHICLE. Every
  `standard`-mapped pad is read, strongest wins (`pads.ts`); `KeyboardInput`
  drops held keys on blur, a hidden page and the Meta keyup.
- `src/terrain/` — `generateTerrain.ts` (pipeline below), `track.ts` +
  `trackRules.ts` (loop generator + `TRACK_RULES`), `Heightfield.ts` (256 ×
  256 samples over 200 × 200 m, the single source of truth for height),
  `groundQuery.ts` (`GroundQuery`), `noise.ts` (seeded FBM, deterministic).
- `src/world/` — the world planner (`planWorld`, `applyPlanToTerrain`,
  `CATALOG`, self-checks): village lots, dressing, nature placements.
- `src/render/terrain/` — terrain chunks, paving, `createTerrainCollider`,
  flat arena. `src/render/scatter/` — prop tiers, `simplifyMesh`, colliders.
  `src/render/backdrop/` — hill rings beyond the rim (chase view only).
- `src/assets/` — procedural asset contract (`types.ts`), auto-discovered
  `*.asset.ts` (`registry.ts`, lazy `import.meta.glob`; never edit a central
  list, file name = id), `assemble.ts` (AO bake, instancing, cars),
  `palette.ts`. Geometry kit: `src/gfx/solid/` (`SolidMesh`).
- `src/gfx/look/` — one lighting model for everything (below);
  `src/gfx/ground/` — generated ground materials; `src/gfx/WheelDust.ts` —
  slip-driven, surface-coloured dust per car (Babylon `ParticleSystem`, one
  draw call per car; bigger, clumpier puffs within 10–18 m of the camera).
- `src/car/` — vehicle models (see Vehicles), `rig.ts` (per-car physics rig
  from the design's `CarSpec`), `ai/` (rivals). `src/audio/` — ONE
  `AudioContext` (`AudioHub.ts`: autoplay unlock, hidden-tab suspend, peak
  limiter) shared by the sine-layer engine sound (`EngineSound.ts`,
  `carAudio.ts`; player only) and the race MUSIC (`music/`), both wired in
  `gameAudio.ts`.
- MUSIC (`src/audio/music/`): procedural, no audio files. `song.ts` = the
  score ("Table Top Rally", A major, 160 BPM: a bar is 1.5 s, so the 3 s
  countdown is 2 bars) as 16-step bar patterns (formats: `notes.ts`);
  `instruments.ts` = synth voices (any `BaseAudioContext`, seeded noise);
  `MusicPlayer.ts` = look-ahead sequencer + mixer (part buses, delay,
  convolution reverb, kick-pumped pad, glue compressor). Moods from the
  PLAYER's race (`moodFor`): countdown = hard cut to a count-in ending ON GO
  (blips on the countdown seconds, output latency subtracted; re-aligns if GO
  moves 0.2 s), racing = 72 s loop, last lap of 2+ = one-bar lift then the
  choruses a whole tone up, finished = sting (fanfare for 1st or alone) then
  the idle loop; flat arena = race loop. Ticked every frame AND by a 50 ms
  timer. M toggles it (`localStorage` `web-racer.music`), `?music=0` drops it.
  Levels: `MUSIC_LEVEL` (gameAudio.ts) × part `LEVEL` (MusicPlayer.ts) ×
  the volume (default 0.7 ≈ −3 dB since 2026-11-23, owner's ask; the lab
  measures volume 1);
  measure with music-lab. Offline renders must never `disconnect()` (it acts
  on the whole timeline; the live player drops cut segments after 3 s).
  Measured 2026-11-22 (music-lab report): race −23.7 LUFS, peak −7.3 dBFS
  before the limiter; the engine drone on the lab's scripted rpm −21.7 LUFS;
  stems drums −26.9, melody −27.2, fx −28.4, bass −29, arp −33, chords
  −36.3. Live game checked: one shared context, ~29 notes/s scheduled, M
  toggles. NEVER HEARD BY ANYONE (only measured).
  `src/car/AutomaticGearbox.ts` is parked by owner decision (shifts inaudible).
- `src/ui/` — `Hud`, `LoadingScreen`, `TuningPanel` (generic over
  `tuningSchema(vehicle)`), `DevOverlay`, `PerfOverlay`.
- GAME MENU (spec + pictures: `design-documents/menu-mockups/SPEC.md`,
  `final.html`, `final-*.png`; seams: `src/game/contracts/menu.ts`): title,
  car, race setup, settings, controls, pause, confirm, post-race. A DOM
  overlay (`.rmenu`, z-index 6) over the live world. `src/ui/menu/` —
  `MenuModel.ts` (Babylon- and DOM-free state machine: screen stack, focus,
  `running` / `staged` world values, `snapshot()`), `MenuView.ts` +
  `menuCss.ts` + `glyphs.ts` (renderer; pointer → `MenuPointerAction`s),
  `menuCars.ts` (car screen data from the assets' `paints`,
  `HANDLING_PRESETS`, `rigFor`), `trackPreview.ts` + `trackWorker.ts`
  (outlines; a staged seed is generated in a worker 300 ms after the last
  change). `src/input/MenuInput.ts` — keys + every pad + pushed pointer
  actions → one `MenuCommand` per frame (repeat, stick hysteresis, release
  guard, `autoPause` on blur / hidden page / pad gone). `src/game/menuFlow.ts`
  — reload, storage, `randomSeed`, `carStats`. createScene implements
  `MenuHost` and exposes `game.menu`; `main.ts` calls `game.menu.boot()`
  once the loading panel is gone. WORLD values (car, livery, seed, laps,
  rivals, difficulty, quality) are staged and applied by ONE reload from a
  "go racing" row (RACE, START RACE, NEXT TRACK), which lands in the 3-2-1
  (one-shot `sessionStorage['web-racer.menu.next']`); camera and music
  volume are live; the MUSIC row shows the EFFECTIVE level (OFF while the M
  mute is on) and raising it clears the mute. PAUSE = the frame loop stops
  simulating AND drawing (the canvas keeps its last frame; `redrawPaused()`
  draws one still frame — car LODs re-picked for the new eye — after a
  pause-menu camera change, a resize or the page shown again). A URL
  `livery` past the car's paint count is wrapped; choosing that car and
  paint again stages nothing. Small windows: below ~640 px of height the
  13 px caption floor outgrows the unit, so `--grow` (`.rmenu-stage`)
  widens the default band, the title rows and the car spec sheet; the post
  stack is clamped inside the window (between 5:4 and ~7:5 its skewed lower
  rows then reach over the finish panel's right rim). No menu at
  all (today's page, bit for bit) with `shot`, `report`, `autopilot`,
  `spot`, `countdown=0`, `terrain=flat` or `menu=0` (`menuEnabled`).
  Storage: `web-racer.view` (chase / high / xr) and `web-racer.musicVolume`
  (0 … 1) in `localStorage`, read at boot when the URL lacks `view` /
  `music` (a URL value is stored), menu pages only.

## Game URL parameters (`src/game/options.ts`) and buttons

| parameter | values (default) | meaning |
|---|---|---|
| `seed` | int ≥ 1 (16) | world / track seed |
| `terrain` | `hills` \| `flat` | flat = bare test arena with 3 ramps, one car, no race |
| `view` | `chase` \| `high` \| `xr` | starting camera (default `chase`, `xr` on a Quest user agent) |
| `vehicle` | `raycast` \| `assist` \| `hybrid` \| `rigid` | the PLAYER's model; rivals are always `raycast` |
| `car` | `reef-rocket` \| `neon-wasp` \| `riot-ram` \| `comet-fox` | player's design |
| `livery` | 0 … (0) | player's paint; rivals wear livery 0 of their own design (the next free one if that is on the grid already) |
| `laps` | 0 … 99 (3) | 0 = endless |
| `rivals` | 0 … 3 (3) | |
| `difficulty` | `easy` \| `normal` \| `hard` \| 0 … 1 (normal) | `DIFFICULTY_PRESETS` in `src/car/ai/grid.ts` |
| `quality` | `high` \| `quest` | default `quest` on a Quest user agent, else `high` |
| `shadows` | `off` \| `1024` \| `2048` | override the preset |
| `dpr` | 0.25 … 4 | force the render ratio (default: quest 1, high min(devicePixelRatio, 2) with the `DprGovernor` step-down of `quality.ts`) |
| `workers` | 0 … 16 | bake pool size; 0 = bake on the main thread (read in `src/boot/gameBoot.ts`, not `options.ts`) |
| `nocache` | `1` \| `0` | skip / force the IndexedDB bake cache (shot pages default to `workers=0&nocache=1`) |
| `bakehash` | `1` | put digests of every baked buffer in the report |
| `backdrop` | `0` | hide the far hills (to measure them) |
| `music` | 0 … 1 (0.7) | music volume; 0 = no music (M toggles in game) |
| `tune` | `key:value,…` | player vehicle tuning; a malformed entry or an unknown key stops the boot; repeated `tune=` are merged |
| `cuts` | `flash` \| `reset` | what a shortcut does (flash = "TRACK CUT", lap invalid until rejoined) |
| `countdown` / `autopilot` / `dev` / `perf` | `0` / `1` / `1` / `1` | skip 3-2-1 / a RivalDriver drives the player / dev strip + tuning panel (a production build creates them ONLY with `dev=1`) / dc + tri readout |
| `spot` | arc m \| `village` | start the player there |
| `shot` | `1` (+ `at=<s>`) | screenshot mode: sync shader compile, `at` s at fixed 1/60, 3 frames, NO loop |
| `report` | `1` (+ `seconds=<n>` (90), `liveboot=1`) | headless report protocol (`contracts/report.ts`); nobody drives the player without `autopilot=1`, so a gate-clean game run is `autopilot=1&report=1&seconds=130` (3 laps ≈ 95 s simulated) |
| `menu` | `0` | no game menu (title / pause / post-race): the race starts after loading, Enter and pad Options restart, as before the menu. Never a menu with `shot`, `report`, `autopilot`, `spot`, `countdown=0`, `terrain=flat` |
| `pausetest` / `titlehold` | s / frames | report mode only (parsed only with `report=1`; menu checks 5 / 6): take the pause path for 120 frames at `<s>` simulated seconds / hold the race like the title for `<frames>` frames, then start it like RACE. Compare with a plain run: `node tools/node/report-diff.mjs plain.json test.json` |
| `menushot` | `title` \| `car` \| `setup` \| `settings` \| `controls` \| `pause` \| `confirm` (+ `menustaged=1`, `menukb=1`, `menufrom=paused`) | shot mode only: the REAL menu over the real world (title side holds the grid with the title camera; pause / confirm freeze the race at `at` s) |

Keys: W A S D / arrows drive (S / Down = brake, held at standstill =
reverse); R reset car; C cycle camera; Esc or P pause (menu pages); Enter
restart race (only with `menu=0` or `dev=1`; otherwise RESTART RACE is in the
pause menu); M music on / off; T tuning panel; H dev strip (T / H:
production build only with `dev=1`). DualShock (standard mapping): left
stick steer, R2 throttle (button 7 `.value`), L2 brake / reverse (button 6),
Circle (1) reset, Triangle (3) camera, Options (9) pause (restart with
`menu=0`). In the menus: arrows / W S A D / D-pad / left stick move and
change, Enter / Space / Cross select, Esc / Circle back, Delete / Backspace
/ Square undo a staged value, R / Triangle random track, digits type a
track number; while a menu is open R / C / Enter / Circle / Triangle never
reset, cycle or restart, and the release guard swallows a button held
through a screen change. A focused form control blocks R / C / Enter / M / T
/ H and the menu keys only; sliders take the mouse only. Engine sound and music start at the first click or key (a pad
press is no user activation by the HTML spec, so a pad-only session is
expected to stay silent — not tested).

## Vehicles

One interface (`src/car/Vehicle.ts`), four models, one entry point
`createVehicle(scene, input, { model, carId, tune })` (`src/car/createVehicle.ts`
— its header is the manual: create, frame loop, what graphics read, tuning).
- `raycast` (PRIMARY, default, all rivals) — `RaycastVehicle.ts`: one chassis
  body, shape-cast wheels, explicit tire model, slide assists, self-righting.
  Tuning: `src/car/raycast/tuning.ts`; per-car HANDLING PRESETS (modest
  multipliers on that tuning) in `src/car/handling.ts`. CATCH LATCH:
  opposite lock out of a slide nobody fed holds the rear. Not armed out of
  a HELD drift (fed ≥ `catchLinkTime` 0.8 s, `catchLinkHeld`); a brake TAP
  once the rear has gripped `catchBrakeHooked` 0.5 s frees it
  (`catchBrakeForget`). Lab `driftLink` / `overHeldCatch` (`linking.ts`,
  rear axle): linked 15° the other way 0.53–0.67 s after the stick, 0.53–
  0.75 s after a tap (body slip from the stick 0.70–0.95 / 0.87–1.33 s).
- `assist` (`AssistedRigidVehicle.ts`, `assist/`) — real wheel bodies + Havok
  friction with solver aids; `hybrid` (`HybridVehicle.ts`, `hybrid/`) — real
  wheel bodies, explicit tires; `rigid` (`RigidWheelVehicle.ts`) — LEGACY:
  cylinder wheels on 6DoF constraints, grip from Havok contact friction,
  Ackermann via `minTurnRadius`. No model draws a body of its own: colliders
  are invisible, the game hangs the procedural car on `vehicle.visual.root`.
  `car=rb01` (the old 4.1 m RB-01 rig) is a physics-lab rig only.
- Rigs: `rigFor(carId)` in `src/car/rig.ts` derives wheel positions, tire
  sizes, masses, springs, CoM and inertia from a `CarSpec`, so every model
  drives the same car. Two copies: `CAR_SPECS` in `rig.ts` and each car
  asset's own `SPEC` — equal today, nothing compares them.
- `needsRescue(vehicle, dt)` (on its roof / stranded for 4 s) and
  `isOutOfWorld(vehicle, bounds, killY)` in `createVehicle.ts` decide
  automatic respawns; the race uses 97 m bounds, flat arena 99 m / −20 m.
- Tuning panel (T) edits the live vehicle; numbers found by feel must be
  copied back by hand into `raycast/tuning.ts` or `handling.ts`.
- RIVALS (`src/car/ai/`): `RivalDriver` is an `InputProvider` driving the
  same car and physics as the player — minimum-bending racing line, corner
  speeds from the car's own grip, follow / attack / defend racecraft, yields
  to a much faster car (`fastCarRule` 'yield', alternatives 'hold' / 'off'),
  recovery and `rescue` requests. `RivalField` = the race as the rivals see
  it (trackers, rubber band 0.04); `grid.ts` = `buildField`, `gridPoses`
  (player starts last, 4 / 4), `DIFFICULTY_PRESETS` (easy 0.2 / 0.2, normal
  0.46 / 0.3, hard 0.72 / 0.2 = skill / spread). Parameters: `rivalParams`
  in `RivalDriver.ts`. Measured in the physics lab's `race` suite.

## World

- TRACK RULES (`TRACK_RULES`, `src/terrain/trackRules.ts`): closed loop
  450–650 m (496–609 m on seeds 1–300, median 588), R ≥ 10 m, point 0 =
  origin heading +z = start line with ≥ 40 m straight ahead and ≥ 20 m
  behind (the grid),
  inside ±64 m, legs ≥ 20 m apart, road half width 5 + shoulder 3, grade ≤
  12 % (≤ 4 % round the line), ≥ 2 tight corners + 1 sweeper both ways,
  4 layout families + mirrors, bit-identical per seed.
- `generateTerrain(seed)`: base FBM + rim bowl → track → carve at half width
  5 → road at point 0 shifted to y = 0 → `planWorld` → `applyPlanToTerrain`
  (pads flattened, verges levelled) → splat (grass / rock / dirt / meadow),
  `paved`, AO + contact stamps, baked hill self-shadow along `SUN_DIR`. The
  plan: village (≥ 12 lots on seeds 1–1100), race garage, start gantry,
  fences, banners, kerbs, pads (asphalt apron, cobble square, paver
  forecourts), ~1,400 trees (1,282–1,500 on seeds 1–300), bushes, plants,
  rocks. Road surfaces are dirt and cobble only; asphalt / pavers / cobble
  also appear as pads. Single landmarks (garage, market hall, water tower,
  village hall) take their variant from a hash of the world seed.
- Drawn: terrain = 4 × 4 frozen chunk meshes (frustum-culled) in
  `lookShadeMatte` × generated ground textures × splat; paving (road ribbon
  dirt ↔ cobble, kerb stones, 2 m start line, pads + markings) ≤ 2 meshes
  3 cm above the heightfield. Props: NEAR tier = full meshes as thin
  instances, only inside a ring round the view focus (rewritten after 6 m of
  movement; ring centre ahead of the car in chase), NOT frustum-culled; FAR
  tier = one simplified mesh per asset and scheme holding ALL placements,
  frozen, ring collapsed in its vertex shader so the tiers never both draw a
  placement; designed far models (`PropAsset.buildFar`) for trees, plants,
  flags, banners, fence, tire stack; far buildings = one merged mesh.
  Colliders: one static compound body from `PropAsset.colliders`.
- Shadow casters: cars (body, driver, wheels; lite meshes at LOD 2), near
  trees, large rocks, buildings (+ dressing on `high`); in `xr` the far tier
  casts INSTEAD of the near tier — never both (the depth pass does not know
  the ring). Bushes, plants and small rocks never cast (baked contact AO).
- LOOK (`src/gfx/look/`): one forward-pass lighting chunk `lookShade` /
  `lookShadeMatte` — sun + hemispheric sky fill in LINEAR space, lavender
  shadow tint, toon terminator, specular + procedural reflection, rim,
  emissive, tone map, grade, gamma and EXP2 fog all in the shader (no
  post-processing, so it survives WebXR). `LookRuntime` owns the uniforms
  (`look.config`), one sun shadow map following a focus (own depth pass,
  PCF taps), sky dome (clouds at 3.5–8°: visible in chase only), wind;
  `LOOK_VIEWS` per camera.
- Ground textures (`src/gfx/ground/`): eight tileable generators; the game
  generates seven at load (`TERRAIN_GROUND_MATERIALS`: dirt, grass, gravel,
  asphalt, cobblestone — 0.3–0.5 m stones on a 6 m tile —, kerb — blocks
  0.24–0.6 m —, pavers). Sunlit Sand (G02, `generateSand.ts`) is
  ground-lab only and in no world. Repeat hidden by 2-tap sampling /
  per-stone tones; `#include<groundLayers>`. Review: `/ground-lab.html`.

## Performance

Presets (`src/game/quality.ts`): `high` (desktop) — shadow 2048 / 9 taps,
near ring 46 m / buildings 90 m, scatter density 1, car LOD 14 / 45 m;
`quest` — 1024 / 4 taps, 32 / 60 m (scaled per view by `RING_LAYOUT`),
density 0.5, car LOD 8 / 25 m, no rival dust in chase. Target on Quest 3:
~150 draw calls / 400k triangles, main + shadow pass, in the MONO preview
(one eye; no stereo target exists). Acceptance limit ≤ 150 / ≤ 420,000
— NOT an automated check: read `frame.drawCalls.max` /
`frame.triangles.max` in the report's stats; the budget
aims at 412,500 estimated (`QUEST_FRAME_TARGET`), measured < 415,000.

Measured 2026-11-22, before the lighter clouds (seed 1,
autopilot, 3 rivals, 40 s, `report=1`, medians / max; dc =
`engine._drawCalls`, tri = `scene.getActiveIndices() / 3`, main + shadow
pass):

| preset + view | dc median / max | triangles median / max | shadow pass dc / tri | cars tri |
|---|---|---|---|---|
| quest + xr | 115 / 115 | 402,649 / 402,649 | 36 / 96k | 17k |
| quest + chase | 168 / 196 | 816,943 / 1,008,836 | 46 / 290k | 197k |
| quest + high | 167 / 193 | 898,594 / 1,030,648 | 45 / 309k | 115k |
| high + chase | 261 / 331 | 1,533,757 / 1,695,306 | 91 / 494k | 209k |
| high + high | 255 / 290 | 1,504,585 / 1,700,148 | 91 / 496k | 197k |

(Headless Chrome, device pixel ratio 1, fps median 60 in every run. Rows
move by a few hundred triangles between runs; the starting grid is the
draw-call peak. Lighter clouds since: quest + xr seed 1 is 399,547.)

- `quest` + `xr` (the shipping view) stays under 415,000 on every seed
  measured (1, 16, 79, 147, 379, 430, 1128, 1300: 399.5–410.9k, 113–115
  dc): `questBudget` / `worldScatterDensity` (`src/game/quality.ts`)
  estimate the frame from the world plan at boot and thin the collider-less
  scatter (bushes, low plants, small rocks) on worlds estimated over
  412,500 — 113 of seeds 1–300 (lowest density 0.31, seed 147); the
  heaviest seeds measured, 1128 and 1300, go to 0.29.
  Seed 16, the default, is NOT thinned (estimate 412,377). The estimate is
  a FIT (`QUEST_ESTIMATE`, ~3k high since the lighter clouds):
  re-measure heavy seeds after changing the planner, far models or far
  triangle targets. Any car's-eye view on `quest` is over (cars at LOD 0
  with shadows, the near ring and its shadows dominate); `high` is over by
  design.
- STEREO: the main pass is drawn per eye. Seed 16, production build: 113
  dc / 409,037 tri, shadow 36 / 101,128 → 190 dc without multiview (113
  with), ~717k triangles either way. Never measured on a Quest. No memory
  number exists (the report has no heap or GPU stat).
- Levers: ring radii / centre per view (`RING_LAYOUT`), variants per class,
  scatter density, caster classes, car LOD distances, far triangles. Next
  ones need code: car shadows from the lite meshes, a lighter LOD 0 car, a
  middle tree LOD.
- Boot (this Mac, idle, 2026-11-22, `tools/warmboot.sh`, seeds 1 / 6 / 16,
  `high`): cold median 5.8 s (5.6–6.1 s, 5 runs), warm — second visit, bake
  cache in IndexedDB — median 2.8 s (2.6–3.0 s, 10 runs). Before the worker
  pool and cache: 16–17.5 s. With one worker (a 2-core machine) cold is
  about 9.5 s. A Quest was never measured (scaled guess: cold 20–25 s, warm
  8–10 s); a ship-time prebake (bake buffers at build time into `public/`)
  is not built. Each worker and the main thread read the WHOLE bake store
  (12 MB per world, `CACHE_CAP` 96 MB); the trim evicts by WRITE time.
- First load of the build: ~460 requests / 11 MB (3 MB gzip); `index-*.js`
  is 5.2 MB because 56 files import the `@babylonjs/core` barrel.

## Labs and tools (dev server only)

- `/physics-lab.html` — vehicle measurement harness, fresh scene + Havok per
  case, manual fixed steps: `model= car= suite= seed= dt= tune= handling=0
  series=0 watch=1`. Hill worlds use the GAME's `createTerrainCollider`.
  Break tests: `PHYSLAB_PAGE=src/lab/physics/extra-raycast/break.html`.
- `/drive-lab.html` — game car + camera rig + dust on a floor (`car= vehicle=
  view= cars= lod= auto=1 shot=1 report=1`).
- `/terrain-lab.html` — terrain surface, paving, collider alignment check
  (`seed= view= s= size= chunks= paving=0 flat=1 shot=1 report=1`).
- `/props-lab.html` — near / far tiers, casters, colliders, simplifier
  side-by-side (`seed= view= s= quality= tier= ring=1 compare= shot=1 report=1`).
- `/world-lab.html` — 2D plan map + planner self-checks, no WebGL
  (`seed= focus= layers= catalog=1`).
- `/asset-lab.html` — any registered asset as the game draws it, blueprint
  views + spec table (`asset= seed= livery= view=quad|hero|sheet|… debug=`).
- `/look-lab.html` (lighting / shadows / sky bench), `/ground-lab.html`
  (generated vs pack ground materials), `/hud-lab.html` (HUD on a real
  `RaceState`, `state=` pins any HUD state), `/solid-test.html` (temporary
  kit audit), `/sound-lab.html` (engine sound playground, standalone).
- `/menu-lab.html` — the game menu over the mockup's backdrop pictures:
  `screen=` (title car setup settings controls pause confirm post),
  `state=` variants (staged kb countdown paused restart first chosen entry
  endless skill unlock long), `focus=`, `bg=picture|color|none`,
  `stage=WxH`, `src=model` (default: the REAL `MenuModel` + real car data,
  driven live by the real `MenuInput`; its host only logs) / `src=mock`
  (hand-built snapshots), `shot=1`, `report=1` (check 4: no text overflows
  its row or the band, plates in the window, text ≥ 13 px / tags ≥ 11 px,
  text inside its plate (`plateTextPx`, gated for the worst-case `long`
  texts too) and no sticker / car tag over other text (`overlayTextPx`), at
  1600×900, 1024×768, 900×600, 800×500 (the spec's minimum), 620×900, mock
  and model; ungated worst-case `long` texts still overflow by 7–19 px: the
  mock RACE sub-line at ≤ 900×600, post NEXT TRACK `TRACK 1101 · NEW
  WORLD` at 800×500, mock and model). The real 3D world behind the
  real menu: `/?shot=1&menushot=title` (table above).
- `/music-lab.html` — the race music by mood button, part mutes, an engine
  drone for balance, WAV download. `report=1` renders a scripted race
  OFFLINE on the game's 1/60 clock and checks the score, GO / blip / lift /
  sting timing (±1 ms), peak (≤ −3 dBFS before the limiter) and BS.1770
  loudness per section and stem (matches ffmpeg `ebur128` to 0.1 LU);
  `&wav=music|mix` adds the render: `node tools/node/report-wav.mjs out.json
  out.wav`. A report run takes 1.5–5 min: run it in the background.
- `tools/shot.sh "<path?query>" out.png [w] [h] [wait-ms]` — headless Chrome
  screenshot on a VIRTUAL clock: pages must compile shaders synchronously
  and render their frames synchronously in `shot=1` (it only sees the first
  frames). Numbers never come from screenshots.
  A LIVE game page (no `shot=1`) bakes in workers and is captured on its
  loading screen: add `&workers=0&nocache=1` AND a 30000 ms wait (with the
  default 6000 ms it usually hangs until the watchdog: exit 1 after wait +
  120 s). A live `view=xr` page is often captured under its fading loading
  panel even then: use `shot=1` for xr pictures.
  `tools/shotlive.sh` (real clock, several loads in one profile) takes
  `shot=1` pages ONLY (without, it times out waiting for "shot ready").
- `tools/warmboot.sh "<query>" <out-prefix> [runs]` — loads a report page
  several times in ONE Chrome profile (run 1 cold, later runs warm);
  `tools/distboot.sh <dist-dir> "<query>" <out-prefix>` does the same on a
  production build served by `tools/node/static-serve.mjs` (a sub-folder:
  `<dir>/sub/game/` + `PHYSLAB_PAGE=sub/game/index.html`).
- `tools/physlab.sh "<query>" out.json [timeout-s]` — runs a report page on a
  REAL clock (default `physics-lab.html`; `PHYSLAB_PAGE=index.html` /
  `drive-lab.html` / … for other pages). Protocol: the page writes its JSON
  into `<pre id="result">`, sets `document.title` to `done` / `error`, and
  needs a `data:,` favicon, `#status` and `#result`. EXIT STATUS IS 0 WHENEVER
  THE PAGE RAN TO THE END without page errors (1 on a timeout, `fatal`, an
  uncaught exception or a console error), whatever its checks say.
- The gate is `node tools/node/report-checks.mjs out.json [--need=id,prefix.]
  [--allow=…]` (exit 1 on a failed check, `fatal`, page errors, a missing
  `--need` id; known rival stand-in checks fail raycast lab suites:
  `--allow=proxyEasy.,proxyQuick.,s.fastBehind.,race.maxLateral`). Node
  runner: `node --import ./tools/node/register.mjs tools/node/world-sweep.ts
  1 60` (also `track-stats.ts`, `dpr-probe.ts`); `pngdiff.mjs` compares
  screenshots; see `tools/node/README.md`.
- All five Chrome tools (shot, shotlive, physlab, warmboot, distboot) queue
  on a machine-wide semaphore (3 Chromes, `tools/_chrome_slot.zsh`) and kill
  Chrome after a lifetime watchdog or on TERM / INT / HUP (`distboot.sh`:
  watchdog only): never
  launch Chrome yourself, at most 2 tool runs in parallel per agent — 12
  parallel headless Chromes kernel-panicked this Mac. Runs over ~400 s go
  in the background.

## Hard-won Havok / Babylon gotchas (do not rediscover these)

- ONE `dt` for vehicles and Havok: `beginPhysicsFrame(scene)` with the plugin
  in fixed-step mode (`new HavokPlugin(false, …)`). Two different steps (the
  old loop clamped the car's dt but Havok stepped the real frame time) change
  launch, grip and braking with the frame rate.
- Constraint axis limits with `minLimit === maxLimit === 0` are hard-LOCKED by
  the plugin: Havok then IGNORES stiffness / damping AND later limit updates.
  For a spring axis or limits updated per frame use a hair-width range (±0.01).
- Position motors on constraint axes have soft default gains — a spinning
  wheel on a position-motor steering axis shimmies. Kinematic limit clamping
  is the stable way to steer (rigid model).
- Full lock at speed commands far more lateral accel (v²·tanδ/L) than the
  tires deliver. The rigid model's `steerGripMargin` (grip-circle cap) and
  `steerSpeedFalloff` are opt-in (0 = off by default). A cap must use TOTAL
  planar speed: forward speed collapses in a slide, and a forward-speed cap
  opens up and winds steering INTO the spin.
- Motor sign conventions must be verified WITH A KNOWN HEADING (a yawed car
  flips the world-frame reading). Rigid: positive ANGULAR_X target = forward
  roll, positive ANGULAR_Y = steer right.
- NEVER use a velocity motor as a throttle-scaled wheel-speed servo: partial
  throttle at speed puts the target below the rolling speed and the motor
  BRAKES with the full force limit → instant spin. Command torque (target =
  speed cap, force limit = throttle × torque). Keep drive torque near the
  traction limit μ·N·r; more only spins the tires and pitches the chassis.
- Havok contact friction on fast-rolling constraint-mounted cylinder wheels
  at real masses delivers only ~40–50 % of μ·N laterally (solver
  convergence; substepping and higher μ do not fix it) — why the
  Havok-friction models understeer at the limit and `raycast` is primary.
- The `inertia` Babylon hands to Havok is PER UNIT MASS (m²), not kg·m²:
  absolute values made a chassis ~650× too heavy in yaw (`rigLayout` in `RigidWheelVehicle.ts`).
- Static bodies default to low friction: always pass `friction` (terrain
  heightfield 2.0, ramps / kerbs 1.0).
- Havok HEIGHTFIELD is CENTRED on its body, and the plugin's documented
  layout `data[(nX-1-x)*nZ+z]` gives the TRANSPOSE: feed `at(z,x)` there
  (`Heightfield.toBabylonHeightFieldData`). terrain-lab re-checks it with 200
  rays. A heightfield has ONE friction value.
- Moving a car = `Vehicle.reset(groundPoint, yaw)` only: models with wheel
  bodies move five bodies with `disablePreStep = false`, zeroed velocities,
  and switch pre-step off again on the next update. Writing a chassis mesh
  position tears such a car apart. Havok takes the new pose only at the next
  `scene.render()`'s pre-step (a `vehicle.update` before it sees the OLD
  pose): `plugin.setPhysicsBodyTransformation(body, mesh)` makes it count at
  once (`RaceSession.restart` does).
- `RaceState` contract: `snapshot.needsReset` MUST be answered (`respawn(id)`
  + move the car), and own teleports announced (`resync` / `respawn`) — an
  unannounced jump is judged as a shortcut.
- A brake still held from before `reset()` brakes; it does not turn into
  reverse until released once (lab check `pedals.respawnBrakeHeld`).
- Havok IGNORES a velocity write only a hair from the body's current
  velocity: `setAngularVelocity(0)` on a chassis settled at ~1e-7 rad/s
  left it untouched (race 1 after a long title hold then differed).
  `RaycastVehicle.reset` writes `RESET_KICK` (1, 1, 1) first, then zero.
  The assist / hybrid / rigid resets (chassis and wheel bodies) still use
  a plain zero write: untested, same trap.
- Manual-step harnesses (`pe._step`) must call `mesh.computeWorldMatrix(true)`
  every step before `vehicle.update` — without `scene.render()` the cache
  goes stale and raycasts fire from old positions. Bodies fall asleep after
  a settle phase: nudge them.
- Vertex colour ALPHA is an EMISSIVE amount in every look shader, not
  opacity: force `mesh.hasVertexAlpha = false`, or the mesh goes to the
  transparent pass without depth writes and triangles smear.
- Look / custom ShaderMaterials: set `mesh.applyFog = false` (fog is in the
  shader; Babylon would inject clashing FOG code). Every new shader copies
  the toy shader's `MULTIVIEW` branch (WebXR). EXCEPTION: the dust is
  Babylon's `ParticleSystem`, whose shader has no multiview path — in a
  multiview session it will not draw (switch it off or replace it first).
- A thin-instance mesh with `thinInstanceCount = 0` draws ONE copy at its
  origin: disable it (`setEnabled(false)`) while empty.
- Thin-instance buffers live on the GEOMETRY: two thin-instanced meshes
  sharing one geometry overwrite each other's placements — give each its own
  (`assemble.ts`, `ownGeometry`).
- The sun shadow pass culls nothing: every registered caster is drawn every
  frame. Keep the caster list short and managed (see World).
- GLSL ES 3.00 reserved words bite as identifiers: `patch`, `sample`,
  `cast`. No semicolon inside a comment on a `uniform` line — Babylon's
  shader processor splits on it.
- Headless screenshots see only the first frames: compile shaders
  synchronously (`engine.getCaps().parallelShaderCompile = undefined`), and
  re-render on resize (Chrome resizes just before the capture). Babylon 9
  loads particle shaders asynchronously: wait for `dust.isReady()`.
- A camera looking straight down: `setTarget` is a gimbal case and an
  `ArcRotateCamera` at beta ≈ 0 silently degenerates — set the rotation of a
  `UniversalCamera` directly (asset-lab blueprint views).
- A hidden tab gets no animation frames: anything awaited during boot needs a
  timer fallback (`nextPaint` in `createScene.ts`, `paintYield` in
  `gameBoot.ts`), and Babylon reports the whole pause as one frame time (the
  `DprGovernor` treats a frame over 0.25 s as a pause; from the third long
  frame in a row, one under 2 s counts as a rate sample).
- `MeshBuilder.CreateGround` needs `updatable: true` for vertex displacement;
  `DynamicTexture` defaults to CLAMP — set WRAP before tiling.
- Winding: `SolidMesh` (header of `src/gfx/solid/SolidMesh.ts`) emits
  Babylon's reversed front-face order; reason with the cross product, not
  "clockwise".

## Physics scale & tuning

World units are meters at REAL scale, gravity 25 m/s² (`GAME_GRAVITY`, the
owner's feel choice). Cars (`rigFor`, `src/car/rig.ts`; mass all-in,
wheelbase, tire radius front / rear):
- reef-rocket 810 kg, 2.20 m, 0.38 / 0.47 m (default car)
- neon-wasp 730 kg, 2.20 m, 0.37 / 0.41 m
- riot-ram 973 kg, 2.30 m, 0.50 / 0.50 m
- comet-fox 892 kg, 2.55 m, 0.36 / 0.51 m
- rb01 (lab only) 1041 kg, 2.60 m, 0.52 / 0.52 m; the `rigid` model without a
  rig keeps the old hardcoded 1500 kg RB-01 layout (`DEFAULT_RIGID_TUNING`).
Top speeds ~25 m/s. Sanity-check tuning changes against real-vehicle numbers.
XR diorama: do NOT scale the world or a render parent (Havok writes
world-space transforms every frame and would fight it). Counter-scale the
PLAYER: parent the WebXR camera under a rig node scaled ×50 (200 m world /
4 m table); head motion, IPD and controllers then scale correctly (scaled
IPD is what makes the miniature look). Set camera `minZ` ≈ 0.5–1 world
units. Feel caveat: apparent gravity at that scale is 1/50, airborne cars
may look floaty — a feel-test decision (speed up time / gravity ~7×?).

## Open / next

Deferred: the WebXR session (Enter-VR, ×50 rig, controllers, world-space
HUD; dust first, see gotchas); PWA manifest / icons / service worker; deep
Babylon imports; a car's-eye view in the Quest budget (lite car shadows via
a shadow-only layer in `src/gfx/look/shadows.ts`, lighter LOD 0 car, middle
tree LOD); near / far cross-fade; per-surface grip; skid marks, rival
engine sound, collision sounds, bloom, camera collision (the
high camera looks through the gantry), minimap; menu UI blips (the model
emits `blip` effects, nobody plays them); a rendered car portrait for the
car screen (today the camera hops to that design on the grid, paint not
previewed); a ship-time
prebake; merged far chunks; heap / GPU stats; flying grit. The legacy hills
road's two jump ramps were DROPPED (the flat arena keeps ramps; lab option
`roadRamps`) — say so if they should come back.

Owner decisions pending:
- GAME MENU (feel test, SPEC 13): yellow focus (cyan stays "what is set");
  Options = pause instead of instant restart; RESUME during the 3-2-1
  restarts the countdown; NEXT TRACK = seed + 1 (not random); title camera
  offset 0.8 m (chase; the spec's 2.2 m put the car at 79 % of the width,
  under the NEXT RACE plate — 0.8 m puts it at ~63 %, as final-title.png) /
  4 m (high) (`TITLE_OFFSET` in createScene.ts); whether the last setup should be
  remembered across visits (today: URL only); the staged car shows the OLD
  car on the grid until RACE reloads (alternative: reload to the title on
  CHOOSE); portrait post-race: the 2 × 2 stack at `bottom: 10em` overlaps
  the HUD's speed plate.
- Sunlit Sand (G02): place it or keep it lab-only; `solid-test.html`:
  delete or keep. (There is no `public/` folder: the palm `.blend` / `.glb`
  were dropped, `dist/` is 12 MB.)
- DECIDED: `design-documents/ground-material-pack/` (148 MB) is reference
  only and git-ignored except `source/` (its generator), README and
  manifest; ground-lab reads its PNGs from disk and shows blank cells
  without it. The other design folders (32 MB) are meant to be committed.
- `?cuts=flash` (default) vs `reset`; `fastCarRule` 'yield' vs 'hold'
  (`&rival=fastCarRule:hold` in the lab); the hills ramps; the player's xr
  plume (~6 car lengths; the high view's is ~1.4); a `DprGovernor` that
  steps back UP (the limits below come from never doing so) and whether
  120 / 144 Hz displays should trade resolution to hold 80 % of the rate.

Known defects / limits:
- Menu: FIXED 2026-11-23 — race 1 after a LONG title hold used to differ
  from race 1 after a short one (`titlehold=600` vs `titlehold=1`, finishing
  times 0.4–1.6 s apart): Havok ignored the zero-velocity write of a reset
  on a car settled at ~1e-7 rad/s (see gotchas). Now `titlehold=600`
  equals `titlehold=1` (43 race + 48 probe values) and `pausetest=40`
  equals the plain run; plain vs `titlehold=1` still differ by one frame
  of report bookkeeping (`moved30` +1, `simSeconds` 94.55 / 94.58), not
  physics. Not checked for the assist / hybrid / rigid models. Menu checks run only headless; the
  live menu was driven by hand in a throttled browser pane (~2 fps: two
  taps inside one frame count once) — never by the owner, never with a pad,
  never in Safari / on a Quest (does a paused canvas keep its frame there?).
- Rivals: stand-in gates open — rival-at-fault contacts ~1.1 per race
  (limit 1), a few impacts over 10 m/s, `duel.k50k80` on seed 44,
  `s.fastBehind` on 7 of 48 files, `difficulty.normal` on unseen seeds,
  `proxyQuick.contacts` / `.aRace`, `s.blockedBend`, `race.maxLateral` at
  30 Hz; hard is nearly unbeatable on reef-rocket; alone, comet-fox laps
  ~3 % and riot-ram ~1.7 % quicker than reef-rocket (the default).
- Physics: break tests fail — `xrGameLoop.below30fps`, `xrOffroad.contained`
  (legacy loop, no respawn: obsolete), `xrBrakeLock.stops` (lock THEN brake:
  1.9–2.0× ideal), `xrSlope.traverseHolds` (10–11 m down a 30° side slope),
  `xrDonut.isADonut` on neon-wasp (`extra-raycast/abuse.ts`). A caught slide
  keeps its rotation, not the road (3–4 m sideways after 1 s). No tool runs
  the live loop (report / shot step a fixed 1/60); 30 Hz halves the donut.
  Drift: a drift fed < ~0.7 s latches like a skid (a brake tap ≥ 0.5 s after
  the rear grips links out); a late brake edge with lock on flips an
  over-held catch into a drift even floored (reef-rocket, neon-wasp);
  throttle linking needs the trigger fully down (reef-rocket, comet-fox).
- Runtime: boot and `spot=` placement do not push the pose into Havok
  (restart and respawn do: `RaceSession.pushPose`); a `?spot=` page runs the 3-2-1 under the fading panel; R does nothing
  after the finish; an exception in a live frame freezes the picture
  silently; `devicePixelRatio` is read once at boot; no context-loss handler.
- World: 63 of 1413 start-straight fence segments stand over a ground step
  > 0.06 m; `src/lab/worldLab.ts` still draws the old two-row start line;
  seed 5038 fails a planner check; props-lab `colliders.hit` fails on one
  palm on seeds 2 and 217 (catalogue radius).
- Look: oak canopy reads as stacked plates up close; corner house and stilt
  hut crumple at 40 m; quest fence runs lack an end post; the car hides
  ~0.2 s under the gantry beam in the high view; the building ring shares
  the near ring's centre (`PropsView`); dust is unlit; clouds sit in one band; the kerb is a straight band; cobble shimmer unjudged in motion.
  Against the vision: shadow cores on dirt 12–18 levels too dark, backdrop
  hills flatter (field contrast 26–28 against 35–39) with sparse crest
  woods, a small (~40 px) chase countdown; tyres, comet-fox side boards,
  riot-ram flanks and the fan fern differ from their sheets.
- Load: with every bake worker lost the bar stands at 80 % while the main
  thread bakes (15 s; 57 s if a worker hangs until its 60 s watchdog);
  `boot.bakeWorkers` cannot notice workers baking something the build does
  not ask for. Terrain surface build ~320–370 ms (the ~200-stone cobble tile).
- `DprGovernor` (high preset, ratio > 1): mock clock only (`dpr-probe.ts`,
  115 cases). A first gain is checked back at the old ratio (a kept step =
  3 changes over ~7.5 s); within `CHAIN_SECONDS` (20 s) of a kept step that
  did not cure the fall the next gain is kept unchecked; low time counts
  as a share. Limits: a GPU-bound stretch < ~8 s is never stepped down,
  however often it recurs; a fall near a failed trial's rate waits the
  doubled retry (120, 240 s …) or is never tried; close CPU dips can leave
  a lower ratio; a rising load makes up to 10 changes in 30 s.

Never verified by anyone — FEEL TESTS for the owner on the DualShock: the
default car's handling and the four handling presets; braking / hold-to-
reverse; respawn (R and automatic); linked drifts in an S-bend (throttle
and brake tap), opposite lock held out of a held drift, a skid held ~1 s
then caught (swings too easily → raise `catchLinkTime`); the rivals on each
difficulty and `fastCarRule`; `cuts=flash` vs `reset`; chase camera at speed
and the high camera in hairpins (and the gantry lift); dust; engine sound;
the music (taste, level against the engine, GO and blips heard on the
digits, the final-lap lift, M);
tuning sliders; any keyboard, gamepad or mouse input; the governor on a
ratio-2 display; the production build; a Quest. A/B the `assist` / `hybrid`
/ `rigid` models with `rivals=0` (raycast rivals' wheel casts do not see
their wheel bodies).
