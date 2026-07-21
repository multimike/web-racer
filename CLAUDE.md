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
  ({throttle 0..1, steering −1..1, brake 0..1}) from an `InputProvider`.
  Providers: DualShock/gamepad (left stick steers, R2 = throttle, L2 =
  brake — triggers are buttons 6/7 `.value` in the standard mapping),
  keyboard (WASD/arrows; S/Down = brake), composite (strongest signal wins).
  Brake-at-standstill = reverse; that decision lives in the VEHICLE
  (RigidWheelVehicle.update), not the providers. An XR provider slots in
  later without touching game code.
- `src/car/` — ONE vehicle model behind the `Vehicle` interface:
  `RigidWheelVehicle` (blue car): 4 real cylinder wheel colliders joined to
  the chassis by 6DoF constraints — vertical axis = damped spring
  (suspension), axle = velocity motor driven in torque mode (see gotchas),
  steering = per-frame clamping of the yaw-axis limits (kinematic hold). Grip
  comes from Havok contact friction. All four wheels carry a velocity motor:
  rears drive/coast, fronts sit at zero force until braking (brake = target 0,
  force = brake × maxBrakeTorque on all four — the one legitimate use of a
  below-rolling-speed velocity target). Holding brake at (near) standstill
  reverses. (A raycast-suspension alternative with
  explicit tire forces existed for A/B comparison and was removed 2026-07 by
  user decision — recover from git history if the rigid model's Havok grip
  limitation at real scale ever forces a hybrid.)
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
- `src/gfx/WheelDust.ts` — ground dust at the wheels: 4 ParticleSystems (one
  per wheel, procedural blob texture, alpha blend) fed by
  `RigidWheelVehicle.wheelStates` — per-wheel roll speed and contact slip
  computed from physics (rim ω·r vs ground speed along the wheel's heading +
  lateral speed along the axle), so wheelspin under power and brake lockup
  count as skids, not just sideways slides. Emit rate = surface dustiness ×
  (small rolling term + large skid term); color/amount blended from
  `sampleSplat` splat weights at the contact (dirt road plumes most tan, rock
  barely dusts grey). Grounded gate = wheel height vs `Heightfield.getHeight`
  bounded on BOTH sides (no dust when airborne, on ramps the heightfield
  doesn't know, or after falling out of the world below the terrain). Params
  live-tweakable in the console via `__game.dust.params`.
- `src/ui/TuningPanel.ts` — DOM overlay (top right): sliders bound live to
  `car.tuning` (CoM height/fore-aft and tire friction call
  `applyCenterOfMass`/`applyWheelFriction` to push into Havok; torque and
  max speed are read every frame anyway) + throttle/brake pedal bars fed
  from `input.poll()` per frame. The vehicle clones DEFAULT_RIGID_TUNING so
  slider tweaks never mutate the shared default — good numbers found by
  feel-testing must be copied back into RigidWheelVehicle.ts by hand.
- `window.__game` exposed in dev builds for console poking
  ({engine, scene, car, terrain, view}).

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
- Keep `maxDriveTorque` near the tire traction limit μ·N·r (see comment in
  RigidWheelVehicle): extra torque only spins the tires, and its reaction
  pitches the chassis (backflipped the old 5 kg toy-mass chassis outright).
- NEVER use a constraint VELOCITY motor as a throttle-scaled wheel-speed
  servo: any partial throttle at speed puts the target below the current
  rolling speed and the motor BRAKES the driven wheels with the full force
  limit, spending the whole rear friction budget longitudinally → instant
  spin. Throttle must command TORQUE (motor target = speed cap, force limit =
  throttle × tapered torque) — see RigidWheelVehicle.update.
- At real-scale masses (~1500 kg through 50 kg wheels) Havok's contact
  friction on fast-ROLLING constraint-mounted cylinder wheels delivers only
  ~40-50 % of μ·N laterally (solver convergence through the
  chassis→constraint→wheel→ground chain; verified numerically: a pure
  sideways slide stops at full μ·g ≈ 10 m/s², a rolling-straight lateral kick
  also damps out, but steady cornering generates only ~4-5 m/s² centripetal
  and diverges into a slide). Substepping (4/8/16 × per frame) does NOT fix
  it and destabilizes straight-line running; raising μ to 2 makes it worse;
  Babylon exposes no Havok solver-iteration API. Consequence: the rigid model
  understeers/slides when pushed near the grip limit at speed — a KNOWN OPEN
  LIMITATION, kept by user decision (the raycast model with explicit tire
  forces cornered cleanly and is recoverable from git history; a hybrid —
  rigid wheels for collision + explicit lateral force assist — is the likely
  eventual fix).
- Steering at speed must be capped by the grip circle (lateral accel
  v²·tanδ/L ≤ margin × μ·g, `steerGripMargin`) or full stick at speed
  commands 3× more lateral accel than tires deliver = the old high-speed
  slide. Compute the cap from TOTAL planar speed, not forward speed —
  forward speed collapses in a slide and a forward-speed cap winds steering
  INTO the spin.
- Test harnesses that step physics manually (pe._step) MUST call
  mesh.computeWorldMatrix(true) each frame before vehicle.update — without
  scene.render() the world-matrix cache goes stale and raycasts fire from
  positions frames behind the body (the car appears to free-fall through the
  ground / pogo-launch). Also nudge bodies after a settle phase: Havok puts
  them to sleep and a sleeping body ignores the drive forces.
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

World units are meters at REAL scale: car chassis 1.4×0.6×2.4 m (~3.9 m over
the wheels), wheels r=0.75 m (monster-truck proportions), ~1500 kg all-in
(1300 kg chassis + 4×50 kg wheels), speeds ~14 m/s (≈50 km/h). All
tuning values are physically real for that mass — suspension ~1.2 Hz ride
frequency, drive torque near the tire traction limit, μ ≈ 1.0 — so sanity-
check changes against real-vehicle numbers. Steering is capped by a
grip-circle limit (commanded lateral accel ≤ steerGripMargin × μ·g) on top of
the linear speed falloff; that cap is what stops terminal understeer/slide at
high speed. For the XR
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
Tuning object: `DEFAULT_RIGID_TUNING` in RigidWheelVehicle.ts.

## Next planned workstream

Procedural landscape phase 1 (heightfield + carved road loop + toon splat
material, `src/terrain/`) is DONE. Remaining, in rough order:

- Static assets on the terrain: rocks, trees, houses, small settlement.
  Placement queries `Heightfield.getHeight/getNormal`; render via thin
  instances (one draw call per asset type — Quest 3 is draw-call-bound, not
  poly-bound at this scene size). Prop/car contact shadows via blob decals.
- Tiling textures multiplied into the existing splat weights
  (albedo = Σ weight_i × color_i × [texture_i]) in `TerrainMaterial.ts`.
- Thin ribbon road meshes along the track polyline if the car needs
  road-specific friction (heightfield = one friction value).
- XR diorama: keep physics at RC scale; counter-scale the XR camera rig ×50
  instead of scaling the world (see "Physics scale & tuning"). Desktop
  `?view=xr` already previews the resulting framing.
