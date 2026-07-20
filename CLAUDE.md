# Web Racer — XR RC-style racing game prototype

WebXR racing game for Quest 3: players stand and look down at a diorama-scale
track (roughly 4×4 m in real space, cars ~10–15 cm) and drive RC-style cars
with controller thumbsticks. Multiplayer planned. Distributed as a PWA
("install from web page"). Development happens on desktop (Mac) with a
DualShock 4 or keyboard; XR support is not wired up yet.

## Stack

- Vite + TypeScript (strict-ish: `erasableSyntaxOnly` is ON — no constructor
  parameter properties)
- Babylon.js 9 (`@babylonjs/core`) + Havok physics (`@babylonjs/havok`)
- `npm run dev` (port 5173), `npx tsc --noEmit` to type-check
- Dev-server config for browser preview in `.claude/launch.json`

## Architecture

- `src/input/` — input abstraction: game code consumes a `CarIntent`
  ({throttle, steering} in [-1,1]) from an `InputProvider`. Providers:
  DualShock/gamepad, keyboard (WASD/arrows), composite (strongest signal
  wins). An XR thumbstick provider slots in later without touching game code.
- `src/car/` — TWO vehicle physics models behind a common `Vehicle` interface,
  A/B selectable via URL `?vehicle=raycast|rigid` (HUD top-left shows active
  model + switch link):
  - `RaycastVehicle` (red car): chassis-only rigid body; per-wheel suspension
    raycasts + spring/damper forces, slip-based lateral grip saturating at
    μ×load, motor-taper drive, tilted "bumper" raycasts to stop against steep
    obstacles. Wheels are cosmetic (`WheelVisuals`). Factory:
    `createRaycastCar.ts`.
  - `RigidWheelVehicle` (blue car): 4 real cylinder wheel colliders joined to
    the chassis by 6DoF constraints — vertical axis = damped spring
    (suspension), axle = velocity motor (drive), steering = per-frame clamping
    of the yaw-axis limits (kinematic hold). Grip comes from Havok contact
    friction.
  - As of last evaluation the user prefers the rigid model ("close to very
    good").
- `src/scene/` — `createScene.ts` (engine/physics/camera/loop),
  `environment.ts` (terrain-mode switch; flat: checkerboard ground, arena
  walls, 3 ramps, wavy road — all with explicit friction values). Camera A/B
  via `?view=chase|xr` (default chase): `xr` simulates the diorama view with
  an ArcRotateCamera at world (0, 85, −85) looking 45° down at the origin —
  the exact mono-equivalent of a 1.7 m-tall viewer at a 4 m diorama
  (knobs: `DIORAMA_SIZE`, `XR_EYE_HEIGHT` in createScene.ts); orbit/zoom =
  "walking around the table".
- `src/terrain/` — procedural landscape, A/B via `?terrain=hills|flat`
  (default hills) + `?seed=N`. Pipeline (all CPU-side, Babylon-free except
  `terrainMesh.ts`/`TerrainMaterial.ts`, so it can move to a worker):
  `noise.ts` (seeded gradient FBM — deterministic for future multiplayer) →
  `Heightfield.ts` (256×256 over 200×200 m, bilinear getHeight/getNormal —
  the single source of truth; asset scattering should query it) →
  `track.ts` (closed Catmull-Rom loop resampled to ~1 m polyline, translated/
  rotated so point 0 = world origin heading +z = spawn; road elevation =
  circularly low-pass-filtered terrain) → `generateTerrain.ts` (base FBM +
  containment rim bowl [no walls in hills mode], bucket-grid distance-field
  carve, RGBA splat weights grass/rock/dirt/meadow, multi-scale cavity AO,
  baked sun-shadow horizon march along `SUN_DIR`, road-edge outline tint) →
  `terrainMesh.ts` (single frozen 130k-tri mesh, one draw call, Uint32
  indices, custom `shade` vertex buffer [AO, sun visibility, albedo tint],
  Havok HEIGHTFIELD body on the same transform, dev-mode raycast verification
  + timings in console) + `TerrainMaterial.ts` (ShaderMaterial: palette ×
  splat, quantized grass patchwork, 4-band toon N·L × baked shadow, AO on
  ambient, height tint, manual EXP2 fog matching scene fog — no textures;
  tiling textures multiply into the same weights later; `mesh.applyFog =
  false` or Babylon injects clashing FOG code; "patch" is a GLSL ES 3.00
  reserved word). Whole generation ~70 ms.
  Scene look (createScene.ts): warm DirectionalLight along `SUN_DIR` + cool
  hemispheric fill, sky-blue clearColor, EXP2 fog, blob shadow disc following
  the car at `Heightfield.getHeight` (no shadow maps anywhere).
- `window.__game` exposed in dev builds for console poking
  ({engine, scene, car, mode}).

## Hard-won Havok/Babylon gotchas (do not rediscover these)

- Constraint axis limits with `minLimit === maxLimit === 0` are hard-LOCKED
  by the Babylon plugin and Havok then IGNORES stiffness/damping AND later
  setAxisMinLimit/MaxLimit calls. For a damped-spring axis or an axis whose
  limits you'll update per frame, use a hair-width range (e.g. ±0.01).
- Position motors on constraint axes have soft default gains — a spinning
  wheel on a POSITION-motor steering axis shimmies violently. Kinematic
  limit-clamping is the stable way to steer.
- Motor sign conventions must be verified empirically WITH A KNOWN HEADING
  (a yawed car flips the world-frame reading). Current: positive ANGULAR_X
  target = forward roll, positive ANGULAR_Y = steer right.
- Static bodies (`PhysicsAggregate`) default to low friction — always pass
  `friction` explicitly or tires won't grip.
- Drive torque reaction can backflip the light chassis: keep
  `maxDriveTorque` near the traction limit (see comment in
  RigidWheelVehicle).
- `DynamicTexture` defaults to CLAMP wrap mode — set `wrapU/wrapV` to
  WRAP_ADDRESSMODE before tiling with uScale/vScale > 1.
- `MeshBuilder.CreateGround` needs `updatable: true` for vertex displacement.
- Render loop clamps dt to 1/30 so frame hitches can't tunnel physics.
- Teleporting the rigid car = move chassis AND all 4 wheel meshes with
  `disablePreStep = false`, zero velocities, restore `disablePreStep` next
  frame.
- Havok HEIGHTFIELD shape is CENTERED on the body transform (not
  corner-anchored), and the plugin's documented data layout
  `data[(nX-1-x)*nZ+z]` yields a physics field that is the TRANSPOSE of the
  intended heights — feed `at(z,x)` at that index (see
  `Heightfield.toBabylonHeightFieldData`). Both verified numerically by
  raycast-probing all mirror/transpose hypotheses; the dev build re-checks on
  every load and logs `[terrain] physics vs heightmap` (healthy: mean err
  ~1 mm). A heightfield has ONE friction value — roads needing different grip
  want thin ribbon meshes on top.

## Physics scale & tuning

World units are meters at "RC scale": car chassis 1.4×0.6×2.4 m, mass 5 kg,
wheels r=0.75 m (monster-truck proportions), speeds ~14 m/s. For the XR
diorama: do NOT scale the world or a render parent (Havok writes world-space
transforms into meshes every frame and would fight a scaled parent). Instead
counter-scale the PLAYER — parent the WebXR camera under a rig node scaled
×50 (= 200 m world / 4 m diorama). Head motion, stereo IPD, and controller
poses then scale automatically and correctly (scaled IPD is what produces the
miniature look). Desktop `?view=xr` is the mono preview of exactly this.
After rig-scaling set camera `minZ` ≈ 0.5–1 world units (1–2 cm real) so
leaning in doesn't clip. Known feel caveat: apparent gravity at diorama scale
is 1/50th, so airborne cars look floaty/slow-motion (film-miniature effect);
if that reads badly, speed up time/gravity (~√50 ≈ 7× rule of thumb) — a
feel-test decision since it changes handling.
Tuning objects: `DEFAULT_TUNING` (raycast), `DEFAULT_RIGID_TUNING` (rigid).

## Next planned workstream

Procedural landscape phase 1 (heightfield + carved road loop + toon splat
material, `src/terrain/`) is DONE. Remaining, in rough order:

- Static assets on the terrain: rocks, trees, houses, small settlement.
  Placement queries `Heightfield.getHeight/getNormal`; render via thin
  instances (one draw call per asset type — Quest 3 is draw-call-bound, not
  poly-bound at this scene size). Prop/car contact shadows via blob decals.
- Tiling textures multiplied into the existing splat weights
  (albedo = Σ weight_i × color_i × [texture_i]) in `TerrainMaterial.ts`.
- Thin ribbon road meshes along the track polyline if the rigid car needs
  road-specific friction (heightfield = one friction value).
- XR diorama: keep physics at RC scale; counter-scale the XR camera rig ×50
  instead of scaling the world (see "Physics scale & tuning"). Desktop
  `?view=xr` already previews the resulting framing.
