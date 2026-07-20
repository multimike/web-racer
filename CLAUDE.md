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
  `environment.ts` (checkerboard ground, arena walls, 3 ramps, wavy road —
  all with explicit friction values).
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

## Physics scale & tuning

World units are meters at "RC scale": car chassis 1.4×0.6×2.4 m, mass 5 kg,
wheels r=0.75 m (monster-truck proportions), speeds ~14 m/s. For the XR
diorama the plan is: keep physics at this scale, scale only the RENDERED
scene under a parent node (~1:60) — do not scale the physics world.
Tuning objects: `DEFAULT_TUNING` (raycast), `DEFAULT_RIGID_TUNING` (rigid).

## Next planned workstream (discussed, not started)

Procedural landscape replacing the flat ground: heightfield terrain
(`PhysicsShapeType.HEIGHTFIELD` is supported by the web Havok build) from a
noise-based height function, ~256×256 samples over a smaller track area;
track/dirt-road carved by flattening terrain along a spline; ramps stay as
placed props. Graphics direction: cosy/toon at diorama scale —
procedural-FIRST without textures (palette + toon ramp + per-vertex AO
computed from the height data + height-based tint + macro color variation),
custom node/shader material with 4 splat weights in vertex-color RGBA;
tiling textures added later by multiplying into the same weight structure
(albedo = Σ weight_i × color_i × [texture_i]). Per-vertex AO at heightmap
resolution is sufficient (terrain AO is low-frequency); prop/car contact
shadows via blob decals. Roads may need thin ribbon meshes with own friction
for the rigid car (heightfield = one friction value).
