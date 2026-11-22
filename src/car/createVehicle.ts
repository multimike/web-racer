import { Vector3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { PhysicsEngineV2 } from '@babylonjs/core';
import type { InputProvider } from '../input/types';
import type { TuningParam, Vehicle } from './Vehicle';
import { DEFAULT_CAR_ID, GAME_GRAVITY, rigFor } from './rig';
import type { VehicleRig } from './rig';
import { HANDLING_MODEL, applyHandling, handlingFor } from './handling';
import type { HandlingPreset } from './handling';
import { RigidWheelVehicle } from './RigidWheelVehicle';
import { AssistedRigidVehicle } from './AssistedRigidVehicle';
import { HybridVehicle } from './HybridVehicle';
import { RaycastVehicle } from './RaycastVehicle';

/**
 * THE VEHICLE ENTRY POINT — everything the game needs from the physics side
 * of a car goes through this file.
 *
 * ---------------------------------------------------------------------------
 * 1. CREATE
 *
 *   const car = createVehicle(scene, input, { model: 'raycast', carId: 'reef-rocket' });
 *
 *   model   'raycast' (PRIMARY, default)  one chassis body, shape-cast wheels,
 *                                         explicit tire model, slide assists
 *           'assist'  (RUNNER-UP)         real wheel bodies + Havok friction,
 *                                         solver aids and slide assists
 *           'hybrid'                      real wheel bodies, explicit tires
 *           'rigid'                       LEGACY RigidWheelVehicle; with
 *                                         carId 'rb01' it is the old game
 *                                         car's physics (hardcoded RB-01
 *                                         layout, lab only, no bodywork)
 *   carId   'reef-rocket' (default) | 'neon-wasp' | 'riot-ram' | 'comet-fox' | 'rb01'
 *           picks the rig (rig.ts: dimensions, masses, springs from the
 *           design's CarSpec) and, for the primary model, the handling
 *           personality (handling.ts). `handling: false` = plain defaults.
 *
 *   The scene must have Havok physics enabled first; the rig is built for the
 *   scene's gravity. A/B switch: read `?vehicle=` (the labs: `?model=`) / `?car=` from the URL and
 *   pass them straight in — `vehicleModelNames()` lists what exists.
 *
 * ---------------------------------------------------------------------------
 * 2. EVERY FRAME
 *
 *   car.update(dt);        // BEFORE the physics step, once
 *   …physics step…         // scene.render() does it
 *   pose the visuals       // from car.visual, e.g. in onBeforeRenderObservable
 *
 *   IMPORTANT — `dt` must be the time the physics engine is about to step.
 *   The primary model integrates its own tire forces over `dt` and hands
 *   Havok a velocity; if Havok then steps a DIFFERENT time the car gets only
 *   dt_car / dt_physics of every force. The old loop did exactly that: it
 *   clamped car.update to 1/30 s while Havok stepped the real frame time
 *   (Babylon caps that at 0.1 s). Measured below 30 fps: 0.52 instead of
 *   0.77 mu·g of cornering and 0 → 20 m/s in 1.35 s instead of 0.88 s at
 *   20 fps. Use one number for both:
 *
 *     engine.runRenderLoop(() => {
 *       const dt = beginPhysicsFrame(scene);   // = what Havok will step
 *       car.update(dt);
 *       scene.render();
 *     });
 *
 *   `beginPhysicsFrame` returns the step the plugin is going to take: with
 *   the default `new HavokPlugin()` that is the frame time capped at 0.1 s;
 *   with `new HavokPlugin(false, havok)` (fixed-step mode) it SETS the step
 *   to the frame time clamped to `maxStep` (default 1/20 s) — choose that
 *   mode if long hitches must not turn into long physics steps.
 *   The primary model is frame-rate independent from 20 to 240 Hz when both
 *   get the same dt (its tire model sub-steps at 360 Hz; lab maneuver
 *   frameRate, reef-rocket, 2026-11-22: steady step-steer lateral grip
 *   0.707 / 0.711 / 0.711 / 0.712 / 0.712 mu·g at 30 / 60 / 72 / 90 / 120
 *   Hz), so no accumulator is needed.
 *   The Havok-friction models ('assist', 'rigid') degrade below ~45 Hz.
 *
 * ---------------------------------------------------------------------------
 * 3. WHAT GRAPHICS / AUDIO / UI READ  (all on the `Vehicle` interface)
 *
 *   car.visual.root                TransformNode in MODEL space (ground under
 *                                  the wheelbase centre, +z nose) parented to
 *                                  the physics chassis: parent the bodywork
 *                                  to it and it follows with no code.
 *   car.visual.wheels[i]           FL, FR, RL, RR hub poses, refreshed by
 *                                  update():
 *       .position   Vector3        hub centre, model space
 *       .rotation   Quaternion     NON-SPINNING hub frame, model space
 *                                  (x = axle toward car right, y = up,
 *                                  z = forward; steers with the wheel)
 *       .steerAngle rad, + right   .spinAngle  rad, + forward roll (wrapped)
 *       .spinSpeed  rad/s          .travel     m, + = compressed
 *       .grounded   boolean        .radius     m
 *       .worldPosition / .worldRotation   after car.visual.refreshWorld()
 *   car.visual.throttle / .brake / .steerInput     pedals and stick, 0..1 / −1..1
 *   car.visual.steerAngle          front-axle steer angle, rad (steering wheel)
 *   car.visual.reversing           brake trigger is acting as reverse
 *   car.chassisMesh                chassis transform (position +
 *                                  rotationQuaternion) — camera target
 *   car.wheelStates[i]             contact kinematics for dust / skid marks /
 *                                  sound: world position + velocity,
 *                                  rollSpeed, slipSpeed, grounded, spinSpeed
 *   car.forwardSpeed, car.drivenRimSpeed, car.topSpeed, car.isReversing
 *   car.isSelfRighting             (primary model) true while it is rolling
 *                                  itself back onto its wheels
 *
 *   With the asset assembler (src/assets/assemble.ts):
 *
 *     const body = instantiateCar(scene, asset);
 *     body.root.parent = car.visual.root;
 *     scene.onBeforeRenderObservable.add(() => {
 *       const v = car.visual;
 *       for (let i = 0; i < 4; i++) {
 *         const w = v.wheels[i];
 *         body.setHubTransform(i, w.position, w.rotation, w.spinAngle);
 *       }
 *       body.update(dt, v.throttle, v.steerAngle);
 *     });
 *
 *   The physics colliders are invisible proxies; nothing in car.visual
 *   depends on which model is running. No model draws a body of its own
 *   (the RB-01 shell of 'rigid' was retired): what you see is whatever you
 *   parent to car.visual.root.
 *
 * ---------------------------------------------------------------------------
 * 4. TUNING PANEL
 *
 *   for (const c of tuningSchema(car)) addSlider(c.group, c.label, c.min, c.max, c.step, c.value, c.onChange, c.hint);
 *
 *   `tuningSchema` is generic over the model: name, range, step, the current
 *   value and an `onChange` that pushes the new value into the physics.
 *   Values found by feel-testing must be copied back into the model's
 *   tuning file (raycast/tuning.ts) or the car's preset (handling.ts) by hand.
 *
 * ---------------------------------------------------------------------------
 * 5. GAME RULES THE PHYSICS LEAVES TO THE GAME
 *
 *   - `car.reset(groundPoint, yaw)` teleports (respawn). Lab-verified: 100
 *     consecutive respawns out of any state end exactly at rest.
 *   - The primary model lands wheels-down from most tumbles, rolls itself
 *     back onto its wheels when it does end on its side or roof (about
 *     2.5 s), and pushes itself off a rock it is high-centred on when the
 *     player uses a pedal. `needsRescue(car, dt)` is the fallback: true when
 *     the car has been lying off its wheels, or resting with (almost) no
 *     wheel on the ground, for 4 s — or at once if the pose has become
 *     non-finite. Give the player a manual reset button as well.
 *   - Nothing stops a car driving over the terrain rim:
 *     `isOutOfWorld(car, bounds, killY)` says when it has. Typical loop:
 *
 *       if (isOutOfWorld(car, 98, -30) || needsRescue(car, dt)) car.reset(spawn, yaw);
 *
 * ---------------------------------------------------------------------------
 * ADD A MODEL: implement `Vehicle` (Vehicle.ts), take ALL geometry and mass
 * numbers from the `VehicleRig`, own a `VehicleVisual`, and either call
 * `registerVehicleModel(def)` or drop a `<name>.vehicle.ts` file that
 * default-exports a `VehicleModelDef` anywhere under src/car/ (found by
 * import.meta.glob; `await loadVehicleModel(name)` before creating it).
 * Measure it: tools/physlab.sh "model=<name>" out.json.
 */

/** The model the game should default to. */
export const DEFAULT_VEHICLE_MODEL = 'raycast';

export interface CreateVehicleOptions {
  /** Physics model name; default DEFAULT_VEHICLE_MODEL. */
  model?: string;
  /** Car design id (rig + handling preset); default 'reef-rocket'. */
  carId?: string;
  /**
   * false = no per-car handling preset (the model's plain defaults); a
   * preset object = use that instead of the car's own. Presets exist for the
   * primary model only and are ignored by the others.
   */
  handling?: boolean | HandlingPreset;
  /** Extra tuning overrides applied last (key → value, see tuningSchema). */
  tune?: Readonly<Record<string, number>>;
  /**
   * Advanced / lab: use this rig instead of building one from `carId`.
   * `null` = the legacy model's own hardcoded RB-01 layout ('rigid' only).
   */
  rig?: VehicleRig | null;
}

export interface VehicleContext {
  scene: Scene;
  input: InputProvider;
  /** null = the model's own legacy/default layout (only 'rigid' supports it). */
  rig: VehicleRig | null;
}

export interface VehicleModelDef {
  name: string;
  description: string;
  create(ctx: VehicleContext): Vehicle;
}

const registry = new Map<string, VehicleModelDef>();

export function registerVehicleModel(def: VehicleModelDef): void {
  registry.set(def.name, def);
}

// Lazy drop-in discovery: <name>.vehicle.ts anywhere under src/car/.
const dropIns = import.meta.glob<{ default: VehicleModelDef }>('./**/*.vehicle.ts');

function dropInPath(name: string): string | undefined {
  return Object.keys(dropIns).find((path) => path.endsWith(`/${name}.vehicle.ts`));
}

/** Names of every model that can be created (registered + drop-in files). */
export function vehicleModelNames(): string[] {
  const names = new Set(registry.keys());
  for (const path of Object.keys(dropIns)) {
    names.add(path.slice(path.lastIndexOf('/') + 1, -'.vehicle.ts'.length));
  }
  return [...names].sort();
}

/** Make sure `name` is registered, importing its drop-in file if needed.
 * The four built-in models never need this. */
export async function loadVehicleModel(name: string): Promise<VehicleModelDef> {
  const known = registry.get(name);
  if (known) return known;
  const path = dropInPath(name);
  if (!path) {
    throw new Error(`unknown vehicle model '${name}' (available: ${vehicleModelNames().join(', ')})`);
  }
  const def = (await dropIns[path]()).default;
  if (!def || typeof def.create !== 'function') {
    throw new Error(`${path} must default-export a VehicleModelDef`);
  }
  if (def.name !== name) {
    throw new Error(`${path} exports model '${def.name}' — the file stem must match the model name`);
  }
  registry.set(name, def);
  return def;
}

/**
 * Build a car. Synchronous for the built-in models (a drop-in model must
 * have been loaded with `loadVehicleModel` first).
 */
export function createVehicle(scene: Scene, input: InputProvider, options: CreateVehicleOptions = {}): Vehicle {
  const model = options.model ?? DEFAULT_VEHICLE_MODEL;
  const carId = options.carId ?? DEFAULT_CAR_ID;
  const def = registry.get(model);
  if (!def) {
    throw new Error(
      `vehicle model '${model}' is not loaded (built in: ${[...registry.keys()].join(', ')}; ` +
      `drop-ins need await loadVehicleModel('${model}') first)`,
    );
  }
  let rig = options.rig;
  if (rig === undefined) {
    // 'rigid' + rb01 = the old game car's exact hardcoded layout.
    if (model === 'rigid' && carId === 'rb01') {
      rig = null;
    } else {
      const engine = scene.getPhysicsEngine() as PhysicsEngineV2 | null;
      rig = rigFor(carId, { gravity: engine?.gravity.length() || GAME_GRAVITY });
    }
  }
  const vehicle = def.create({ scene, input, rig });
  if (model === HANDLING_MODEL && options.handling !== false) {
    const preset = typeof options.handling === 'object' ? options.handling : handlingFor(carId);
    if (preset) applyHandling(vehicle, preset);
  }
  for (const [key, value] of Object.entries(options.tune ?? {})) {
    if (!vehicle.setTuning(key, value)) {
      throw new Error(`vehicle model '${model}' has no tuning key '${key}'`);
    }
  }
  return vehicle;
}

// --- frame helper ------------------------------------------------------------

/**
 * The time step to drive with this frame, seconds — the same one the physics
 * engine is about to take (see the header, section 2):
 *  - plugin in its default "step by frame time" mode: the engine's frame
 *    time capped at 0.1 s, exactly as Babylon will step it;
 *  - plugin created with `new HavokPlugin(false, havok)`: the frame time
 *    clamped to [1/240, maxStep] is SET as the plugin's step and returned.
 * Pass the result to `vehicle.update(dt)`.
 */
export function beginPhysicsFrame(scene: Scene, maxStep = 1 / 20): number {
  const raw = scene.getEngine().getDeltaTime() / 1000;
  const frame = Number.isFinite(raw) && raw > 0 ? raw : 1 / 60;
  const plugin = (scene.getPhysicsEngine() as PhysicsEngineV2 | null)?.getPhysicsPlugin() as
    { setTimeStep?: (step: number) => void; _useDeltaForWorldStep?: boolean } | undefined;
  if (plugin && plugin._useDeltaForWorldStep === false && plugin.setTimeStep) {
    const dt = Math.min(Math.max(frame, 1 / 240), maxStep);
    plugin.setTimeStep(dt);
    return dt;
  }
  // Babylon: step = clamp(frame time, 1 ms, 1 s), then capped at 0.1 s.
  return Math.min(Math.max(frame, 0.001), 0.1);
}

/**
 * True when the car cannot drive away by itself and should be respawned
 * (`car.reset(point, yaw)`):
 *  - at once, if its pose or velocity is not a finite number any more (a
 *    physics blow-up: the model stops driving such a car, only a reset
 *    brings it back);
 *  - once it has been resting (below `maxSpeed` m/s) tilted more than
 *    `maxTiltDeg` from upright for `holdSeconds`. The primary model rolls
 *    itself back onto its wheels within about 2.5 s (tuning.selfRightDelay),
 *    so the default hold of 4 s only fires where that did not work — wedged
 *    under something, or with self-righting switched off;
 *  - once it has been resting STRANDED for `holdSeconds`: at most one wheel
 *    carrying load, or only two while it leans more than 20 deg — sitting on
 *    its belly on a rock, or propped against one. ("Resting" = slower than
 *    `maxSpeed`, or not having left a 2.5 m circle for over a second: a
 *    player rocking the car on the spot does not hold the rescue off.) The primary model pushes
 *    itself off such a rock when the player uses a pedal
 *    (tuning.unstickAccel), so this too only fires where that did not work.
 *    A car parked normally has all four wheels loaded and never trips it.
 * Call it every frame with the frame time. No allocations.
 *
 * A manual "reset car" button in the game is still worth having: this
 * function cannot know that a player WANTS out of a spot the car could in
 * principle drive away from.
 */
export function needsRescue(vehicle: Vehicle, dt = 0, maxTiltDeg = 70, maxSpeed = 1.5, holdSeconds = 4): boolean {
  let state = rescueTimers.get(vehicle);
  if (!state) {
    state = { time: 0, anchorX: NaN, anchorZ: NaN, anchorTime: 0 };
    rescueTimers.set(vehicle, state);
  }
  const mesh = vehicle.chassisMesh;
  const p = mesh.position;
  const q = mesh.rotationQuaternion;
  vehicle.chassisBody.getLinearVelocityToRef(scratch);
  const speed = Math.hypot(scratch.x, scratch.y, scratch.z);
  if (!q || !Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w + speed)) return true;
  // World-up component of the chassis up axis (= cos of the tilt).
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  let loaded = 0;
  for (const w of vehicle.wheelStates) if (w.grounded) loaded++;
  const stranded = loaded <= 1 || (loaded === 2 && upY < STRANDED_LEAN_COS);
  // "Resting": slow — or going nowhere. A stranded car whose player keeps
  // trying (wheels spinning, the car rocking on the rock at 2-3 m/s) is not
  // slow all the time, but it has not left a 2.5 m circle for over a second.
  if (!(Math.hypot(p.x - state.anchorX, p.z - state.anchorZ) < RESCUE_ANCHOR_RADIUS)) {
    state.anchorX = p.x;
    state.anchorZ = p.z;
    state.anchorTime = 0;
  } else {
    state.anchorTime += dt;
  }
  const resting = speed < maxSpeed || state.anchorTime > 1;
  const stuck = (upY < Math.cos((maxTiltDeg * Math.PI) / 180) || stranded) && resting;
  // (counted down, not cleared, when the condition lapses for a moment: a
  // third wheel that touches for a frame must not restart the wait)
  state.time = stuck ? state.time + dt : Math.max(0, state.time - 2 * dt);
  return stuck && state.time >= holdSeconds;
}
const rescueTimers = new WeakMap<Vehicle, { time: number; anchorX: number; anchorZ: number; anchorTime: number }>();
/** A car that stays inside this radius (m) is "going nowhere". */
const RESCUE_ANCHOR_RADIUS = 2.5;
/** cos(20 deg): two loaded wheels only count as stranded when the car leans. */
const STRANDED_LEAN_COS = Math.cos((20 * Math.PI) / 180);
const scratch = new Vector3();

/** Axis-aligned extent of the drivable world on the ground plane, m. */
export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * True when the car has left the world and should be respawned: its chassis
 * is outside `bounds` on the ground plane, below `killY`, or not at a finite
 * position at all. Pure — no state, no allocations; call it every frame.
 *
 * @param bounds the drivable rectangle, or a single number = half the side
 *        of a square world centred on the origin (hills terrain: 100, minus
 *        whatever margin the rim needs)
 * @param killY height below which the car counts as fallen out (default:
 *        no height test)
 *
 *   if (isOutOfWorld(car, 98, -30) || needsRescue(car, dt)) car.reset(spawnPoint, spawnYaw);
 *
 * `reset()` is safe out of any state (falling at speed, tumbling, pedals
 * held): the lab drops the car out of the world 12 times and checks every
 * respawn ends at rest, level, on the spot, with the wheels stopped; a brake
 * that is still held from before the respawn brakes — it does not reverse
 * until it has been released once.
 */
export function isOutOfWorld(vehicle: Vehicle, bounds: WorldBounds | number, killY = -Infinity): boolean {
  const p = vehicle.chassisMesh.position;
  if (!Number.isFinite(p.x + p.y + p.z)) return true;
  if (p.y < killY) return true;
  if (typeof bounds === 'number') return Math.abs(p.x) > bounds || Math.abs(p.z) > bounds;
  return p.x < bounds.minX || p.x > bounds.maxX || p.z < bounds.minZ || p.z > bounds.maxZ;
}

// --- tuning schema -----------------------------------------------------------

/** One slider of a generic tuning panel. */
export interface TuningControl {
  key: string;
  /** Short name. */
  label: string;
  /** Section heading ('tires', 'drive', 'slide assists', …); '' if none. */
  group: string;
  /** What it feels like, one line; '' if none. */
  hint: string;
  min: number;
  max: number;
  step: number;
  /** Value at the time the schema was built (read `get()` for the live one). */
  value: number;
  get(): number;
  /** Push a new value into the physics. */
  onChange(value: number): void;
}

/**
 * The sliders worth showing for this vehicle, in display order, bound to it.
 * Works for every model (each declares its own `tuningParams`).
 */
export function tuningSchema(vehicle: Vehicle): TuningControl[] {
  return vehicle.tuningParams.map((p: TuningParam): TuningControl => ({
    key: p.key,
    label: p.label,
    group: p.group ?? '',
    hint: p.hint ?? '',
    min: p.min,
    max: p.max,
    step: p.step,
    value: vehicle.getTuning(p.key) ?? 0,
    get: () => vehicle.getTuning(p.key) ?? 0,
    onChange: (value: number) => {
      vehicle.setTuning(p.key, value);
    },
  }));
}

// --- Built-in models ---------------------------------------------------------

registerVehicleModel({
  name: 'raycast',
  description:
    'PRIMARY: one chassis body, tire-sized shape casts for wheels, explicit transient tire model ' +
    '(360 Hz sub-steps, frame-rate independent), slide-steering + yaw-damper assists',
  create: ({ scene, input, rig }) => {
    if (!rig) throw new Error("model 'raycast' needs a rig (any car id)");
    return new RaycastVehicle(scene, input, rig);
  },
});

registerVehicleModel({
  name: 'assist',
  description:
    'RUNNER-UP: real wheel bodies + Havok contact friction with solver aids (wheel inertia, steering trim), ' +
    'traction control / ABS, friction-circle correction and bounded slide assists',
  create: ({ scene, input, rig }) => {
    if (!rig) throw new Error("model 'assist' needs a rig (any car id)");
    return new AssistedRigidVehicle(scene, input, rig);
  },
});

registerVehicleModel({
  name: 'hybrid',
  description:
    'Real wheel bodies on suspension constraints (Havok: collision + springs), frictionless treads; ' +
    'grip from an explicit sub-stepped friction-circle tire model acting on the real wheel spin',
  create: ({ scene, input, rig }) => {
    if (!rig) throw new Error("model 'hybrid' needs a rig (any car id)");
    return new HybridVehicle(scene, input, rig);
  },
});

registerVehicleModel({
  name: 'rigid',
  description:
    'LEGACY: 4 dynamic cylinder wheels on 6DoF constraints, grip from Havok contact friction',
  // rig === null → the old game car's configuration (hardcoded RB-01 layout).
  create: ({ scene, input, rig }) => new RigidWheelVehicle(scene, input, undefined, rig ?? undefined),
});
