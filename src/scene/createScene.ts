import { Engine, HavokPlugin, Scene, Vector3 } from '@babylonjs/core';
import type { AbstractMesh, Mesh } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { attachEngineSound } from '../audio/carAudio';
import { RivalDriver, RivalField, buildField, gridPoses } from '../car/ai';
import { beginPhysicsFrame, isOutOfWorld, needsRescue } from '../car/createVehicle';
import { GAME_GRAVITY } from '../car/rig';
import { loadAsset } from '../assets/registry';
import { BootBakes, bootFlags } from '../boot/gameBoot';
import { createGameCameraRig } from '../game/camera/CameraRig';
import type { CameraOccluder } from '../game/camera/CameraRig';
import { createGameCar } from '../game/car/GameCar';
import type { CameraRig, GameActionSource } from '../game/contracts/camera';
import type { GameCar } from '../game/contracts/car';
import type { PropsView, WorldProps } from '../game/contracts/props';
import type { QualitySettings } from '../game/contracts/quality';
import type { FrameStats, LabReport, ReportValue } from '../game/contracts/report';
import type { FlatArena, TerrainSurface } from '../game/contracts/terrain';
import type { GroundQuery, WorldData } from '../game/contracts/world';
import { assignLiveries, difficultyPreset } from '../game/options';
import type { GameOptions } from '../game/options';
import { DprGovernor, RING_LAYOUT, RING_DIR_TAU, XR_NEAR_DISTANCE, pickQuality, renderRatio, worldScatterDensity } from '../game/quality';
import { RaceSession } from '../game/RaceSession';
import { LOOK_VIEWS, createLook } from '../gfx/look/lighting';
import type { LookRuntime } from '../gfx/look/lighting';
import { NEUTRAL_DUST_VIEW, WheelDust } from '../gfx/WheelDust';
import type { DustViewScale } from '../gfx/WheelDust';
import { CompositeInput } from '../input/CompositeInput';
import { DesktopGamepadInput } from '../input/DesktopGamepadInput';
import { createGameActions } from '../input/GameActions';
import { KeyboardInput } from '../input/KeyboardInput';
import type { InputProvider } from '../input/types';
import { createBackdrop } from '../render/backdrop';
import type { Backdrop } from '../render/backdrop';
import { createWorldProps, simplifyMesh } from '../render/scatter';
import { lastWorldPropsPhases } from '../render/scatter/worldProps';
import type { WorldPropsBootOptions } from '../render/scatter/worldProps';
import { createFlatArena, createTerrainSurface } from '../render/terrain';
import { generateTerrain } from '../terrain/generateTerrain';
import { catalogEntry } from '../world/catalog';
import { DEV_OVERLAY_HEIGHT, createDevOverlay } from '../ui/DevOverlay';
import type { DevOverlayHandle } from '../ui/DevOverlay';
import { Hud } from '../ui/Hud';
import type { HudOptions } from '../ui/Hud';
import { createPerfOverlay } from '../ui/PerfOverlay';
import type { PerfOverlayHandle, PerfReadout } from '../ui/PerfOverlay';
import { createTuningPanel } from '../ui/TuningPanel';
import type { TuningPanelHandle } from '../ui/TuningPanel';

/**
 * THE GAME — boot order and frame loop (CLAUDE.md, Architecture).
 *
 * Boot: Engine → Scene → Havok in fixed-step mode (`beginPhysicsFrame` sets
 * the step every frame) → look runtime (sky, sun shadows, fog; no Babylon
 * lights) → `BootBakes` starts baking the cars in the pool of bake workers
 * (src/boot: builders, AO bakes, far models, car lite meshes; cached in
 * IndexedDB) → hills: generateTerrain → terrain surface → backdrop hills →
 * world props (async: their bakes join the pool, the loading screen shows
 * the progress) / flat: the test arena → the cars one by one on the grid
 * (each takes its finished bake) → camera rig, actions, dust, engine sound,
 * dev UI → the after-physics observer LAST (each vehicle's own observers
 * must run before it) → two warm-up frames → loop.
 *
 * Frame: dt = beginPhysicsFrame (shot / report: a fixed 1/60) → render
 * resolution (DprGovernor, before the frame is drawn: resizing the canvas
 * clears it) → actions → camera cycle → session.beforePhysics (rivals think,
 * every vehicle.update) → scene.render() steps Havok by the SAME dt, then,
 * after the step: car.syncVisual → session.afterPhysics (race, respawns,
 * HUD) → rig.update → props ring → shadow focus → dust, engine sound, perf.
 *
 * Dev UI (tuning panel T, dev strip H): dev-server builds always; a
 * production build only with `?dev=1` (otherwise T and H do nothing).
 *
 * Modes: `shot=1` simulates `at` seconds synchronously, draws three frames
 * and stops (no render loop: the picture is that frame); `report=1` runs the
 * race in real time at a fixed 1/60 step and writes the report protocol of
 * contracts/report.ts into #result.
 */

export interface Game {
  engine: Engine;
  scene: Scene;
  options: GameOptions;
  quality: QualitySettings;
  look: LookRuntime;
  data: WorldData | null;
  surface: TerrainSurface | null;
  arena: FlatArena | null;
  props: WorldProps | null;
  cars: GameCar[];
  player: GameCar;
  rig: CameraRig;
  session: RaceSession | null;
  /** Far hills (hills worlds only; drawn in the chase view only). */
  backdrop: Backdrop | null;
  /** Render resolution in device pixels per CSS pixel (see quality.renderRatio). */
  readonly dpr: number;
  /** Boot timings, ms (dataMs, surfaceMs, propsMs, carsMs, totalMs, …). */
  boot: Record<string, number>;
  dust: WheelDust[];
  frameStats(): FrameStats;
  dispose(): void;
}

const FIXED_DT = 1 / 60;
const ORIGIN = { x: 0, y: 0, z: 0 };
/** Respawn bounds of the flat arena: ±99 m, 20 m below the floor. */
const FLAT_HALF = 99;
const FLAT_KILL_Y = -20;

type DrawCounter = { current: number; fetchNewFrame(): void };

/** `?bakehash=1`: content hashes of everything the boot baked (the
 * identity check between boot paths), printed by report mode. */
let bakeDigests: Record<string, string> | null = null;

/** Page-side errors (report mode reads them): window errors and rejections. */
export const pageErrors: string[] = [];

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Let the browser PAINT (the loading label) before the next long step: a
 * timer task alone does not guarantee a frame in between. A hidden tab gets
 * no animation frames at all, so a timer stands in after 100 ms — otherwise
 * a game opened in a background tab would not boot until it is shown. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 100);
  });

/**
 * Dust per camera view, as multipliers on each car's `params` (WheelDust
 * `view`; a camera change writes only these, so console tweaks of
 * `__game.dust[i].params` survive it). Every car's params are the player's
 * defaults (DEFAULT_DUST_PARAMS).
 *
 * Rivals in chase: the chase camera looks straight down the length of the
 * plume of every car ahead, so at the player's settings a rival's dust
 * veiled the player's car and the road.
 * The vision shows a rival's plume no higher than a tire and about a car
 * length long: low throw (2 → 0.6 m/s), small and thin puffs, fewer of them
 * (rates 3 / 30 / 200 → 1.5 / 12 / 80), almost nothing on paving (damping
 * 0.85 → 0.97).
 */
const RIVAL_DUST_CHASE: DustViewScale = {
  rollRate: 0.5,
  skidRate: 0.4,
  maxRate: 0.4,
  kickUp: 0.3,
  size: 0.6,
  opacity: 0.5,
  life: 1,
  pavedKeep: 0.2,
};
/** Rival dust where the preset has none (quest, chase view): no emission. */
const RIVAL_DUST_OFF: DustViewScale = { ...RIVAL_DUST_CHASE, maxRate: 0 };
/** High camera, player AND rivals: seen from above, a plume's length is its
 * life × the car's speed. At the full life (0.7–1.3 s) a plume trailed three
 * or more car lengths (the vision: about one,
 * tire-high). Life × 0.2 (0.14–0.26 s): measured from the high camera
 * the visible plume is ~1.5 car lengths at 24 m/s, i.e. ~1.25 at 20 m/s
 * (× 0.3 still drew 2.1 at 24 m/s, plume-axis measurements). Same
 * density at the wheels; the shorter life also keeps puffs small. */
const DUST_HIGH: DustViewScale = { ...NEUTRAL_DUST_VIEW, life: 0.2 };
/** Diorama: rivals keep a longer streak (it is what tells the pack apart
 * from 120 m away); the player's plume is the default. */
const RIVAL_DUST_XR: DustViewScale = { ...NEUTRAL_DUST_VIEW, life: 0.65 };
/** Enough for a rival's rear-wheel plume at the chase multipliers, the
 * longest-lived of its views (≈ 200 particles alive at racing speed). */
const RIVAL_DUST_CAPACITY = 300;
/** Where the countdown digit sits per view (centre, fractions of the HUD
 * area from the top / left) and its size (× the HUD's digit).
 * At 0.2 in the middle it covered the gantry's medallion and start lights in
 * chase and high.
 *  - chase: a smaller digit in the gap between the banner and the rival in
 *    the slot ahead (the far end of the straight). Measured at 16:9 (941 px
 *    high): banner lower edge / top of the rival ahead 172 / 248 px on seed
 *    1 (riot-ram's roof bar), 195 / 288 on seed 44, 187 / 305 on seed 16 —
 *    common to all three only 195–248, so the digit is small (0.28, a glyph
 *    ~40 px high) and centred at 0.235. It is pinned to the chase
 *    picture (`refAspect`, the camera's 16:9 fov rule): at 4:3 the picture
 *    zooms out about its centre and the digit shrinks and moves with it —
 *    at a fixed screen place it overlapped the banner there.
 *    On the sky above the banner there is no room at 16:9: the medallion
 *    reaches the top edge;
 *  - high: beside the road, over the verge on the right (the grid fills the
 *    road below the gantry);
 *  - xr: unchanged (clear of the gantry and the grid). */
const COUNTDOWN: Record<'chase' | 'high' | 'xr', { x: number; y: number; scale: number; refAspect?: number }> = {
  chase: { x: 0.5, y: 0.235, scale: 0.28, refAspect: 16 / 9 },
  high: { x: 0.78, y: 0.34, scale: 0.7 },
  xr: { x: 0.5, y: 0.17, scale: 1 },
};
/** Start gantry (d01-start-gantry, scale 1) as the high camera's occluder.
 * The span comes from the world catalog's design size (14.5 m to the
 * plinths' outer faces). The top of the crest medallion over the road and
 * the truss + sign depth are NOT exposed by the catalog or the asset (its
 * 7.15 m height is the pylon lanterns, outside the road; the 2 m depth is
 * the plinths): those two are a copy of the asset's geometry, to re-check
 * when the gantry asset changes. */
const GANTRY_ID = 'd01-start-gantry';
const GANTRY = { halfWidth: catalogEntry(GANTRY_ID).size[0] / 2, top: 6.5, halfDepth: 0.5 };
/** HUD size in the diorama view: the countdown digit otherwise covers the
 * grid it counts down for. */
const XR_HUD_SCALE = 0.7;
/** Tuning panel's distance from the top edge, px (below the dev strip while it shows). */
const TUNING_TOP = 10;

/** shot=1 must give the same picture every run: Babylon's particles draw
 * life, size and angle from Math.random. Shot mode only. */
function seedMathRandom(seed: number): void {
  let x = seed >>> 0 || 1;
  Math.random = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function shadowPass(look: LookRuntime): { drawCalls: number; triangles: number } {
  const list = look.shadows.map?.renderList ?? [];
  let drawCalls = 0;
  let triangles = 0;
  for (const m of list as AbstractMesh[]) {
    if (!m.isEnabled() || !m.isVisible) continue;
    const count = m.hasThinInstances ? (m as Mesh).thinInstanceCount : 1;
    if (count <= 0) continue;
    drawCalls++;
    triangles += (m.getTotalIndices() / 3) * count;
  }
  return { drawCalls, triangles };
}

export async function createGame(canvas: HTMLCanvasElement, options: GameOptions, onProgress?: (fraction: number, label: string) => void): Promise<Game> {
  // A boot that throws stops the bake workers it started.
  const held: { bakes: BootBakes | null } = { bakes: null };
  try {
    return await bootGame(canvas, options, onProgress, held);
  } catch (e) {
    held.bakes?.abort();
    throw e;
  }
}

async function bootGame(canvas: HTMLCanvasElement, options: GameOptions, onProgress: ((fraction: number, label: string) => void) | undefined, held: { bakes: BootBakes | null }): Promise<Game> {
  const tStart = performance.now();
  const boot: Record<string, number> = {};
  // The bar only moves forward: the bake workers report from their own
  // clock while the main thread reports its steps.
  let progressAt = 0;
  // Longest stretch without a progress update (the report shows whether the
  // bar kept moving).
  let progressLast = performance.now();
  let progressGap = 0;
  let progressCount = 0;
  const progress = (f: number, label: string): void => {
    progressAt = Math.max(progressAt, f);
    const now = performance.now();
    progressGap = Math.max(progressGap, now - progressLast);
    progressLast = now;
    progressCount++;
    onProgress?.(progressAt, label);
  };
  const quality = pickQuality(options);
  // Shot and report pages compile shaders synchronously and skip
  // whenReadyAsync; `report=1&liveboot=1` keeps the live page's boot path
  // (parallel compile + whenReadyAsync) so its time can be measured.
  const sync = options.shot || (options.report && !options.liveBoot);
  /** Shot and report pages run the fixed 1/60 step and have no human. */
  const fixedStep = options.shot || options.report;
  const yieldStep = sync ? nextTask : nextPaint;
  if (options.shot) seedMathRandom(0x2545f491);

  // --- engine, scene, physics
  progress(0.01, 'engine');
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: options.shot });
  // Render resolution: `high` follows the display (min(devicePixelRatio, 2),
  // so a ratio-2 MacBook is sharp) and steps down when the frame rate cannot
  // hold it; `quest` stays at 1; `?dpr=` forces a value (no step-down).
  let dpr = renderRatio(quality, options.dpr, window.devicePixelRatio);
  engine.setHardwareScalingLevel(quality.hardwareScaling / dpr);
  // Headless screenshots run on a virtual clock that expires before an async
  // (parallel) shader compile reports back: compile synchronously.
  if (sync) engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);
  // Particles and the look's clock read the engine's frame time, which means
  // nothing when frames are simulated back to back.
  if (fixedStep) scene.useConstantAnimationDeltaTime = true;
  let t = performance.now();
  const havok = await HavokPhysics();
  // `false` = fixed-step mode: beginPhysicsFrame SETS the step every frame,
  // so the vehicles and Havok always integrate the same dt.
  const plugin = new HavokPlugin(false, havok);
  scene.enablePhysics(new Vector3(0, -GAME_GRAVITY, 0), plugin);
  if (fixedStep) plugin.setTimeStep(FIXED_DT);
  boot.physicsMs = performance.now() - t;

  // --- look: sky, sun shadows (quality chosen once: changing it recompiles
  // every receiver), fog of the chase view until the rig says otherwise.
  t = performance.now();
  const look = createLook(scene, {
    shadowQuality: quality.shadowQuality,
    shadowTaps: quality.shadowTaps,
    shadowRegion: LOOK_VIEWS.chase.shadowRegion,
    sky: true,
    config: { fogDensity: LOOK_VIEWS.chase.fogDensity },
  });
  if (options.shot) look.freezeTime = true;
  boot.lookMs = performance.now() - t;

  // --- bakes (src/boot/gameBoot.ts): the field is known from the
  // options alone, so the cars start baking in the workers NOW, while the
  // world data and the terrain are made here; the props follow as soon as
  // the plan is known. Same results as baking here, only sooner.
  const bakes = new BootBakes(bootFlags(options.shot), options.terrain === 'hills');
  held.bakes = bakes;
  const baked = bakes.pool !== null;
  bakes.onProgress = (f, done, queued): void => progress(0.14 + 0.66 * f, `baking ${done} / ${queued}`);
  const fieldPreset = difficultyPreset(options);
  const entries =
    options.terrain === 'hills'
      ? buildField({ playerCarId: options.car, rivals: options.rivals, difficulty: fieldPreset.difficulty, spread: fieldPreset.spread, seed: options.seed })
      : [];
  // Rivals wear their design sheet's colours (livery 0); only a design that
  // is already on the grid shifts to its next free livery.
  const liveryCounts: Record<string, number> = {};
  for (const id of [options.car, ...entries.map((e) => e.carId)]) {
    if (liveryCounts[id] !== undefined) continue;
    const asset = await loadAsset(id);
    liveryCounts[id] = asset.kind === 'car' ? asset.liveries : 1;
  }
  const liveries = assignLiveries(entries, options.livery, liveryCounts);
  /** The livery createGameCar will use (it wraps the index into range). */
  const wrapLivery = (carId: string, livery: number): number => {
    const n = Math.max(1, liveryCounts[carId] ?? 1);
    return ((livery % n) + n) % n;
  };
  bakes.prefetchCars(
    entries.length
      ? entries.map((e) => ({ carId: e.carId, livery: wrapLivery(e.carId, liveries.get(e.id) ?? 0) }))
      : [{ carId: options.car, livery: wrapLivery(options.car, options.livery) }],
    quality.carLiteRatio,
  );
  await bakes.ready();

  // --- world
  let data: WorldData | null = null;
  let surface: TerrainSurface | null = null;
  let arena: FlatArena | null = null;
  let props: WorldProps | null = null;
  let backdrop: Backdrop | null = null;
  let ground: GroundQuery;
  if (options.terrain === 'hills') {
    progress(0.03, `world, seed ${options.seed}`);
    await yieldStep();
    t = performance.now();
    data = generateTerrain(options.seed);
    boot.dataMs = performance.now() - t;
    progress(0.08, 'terrain surface');
    await yieldStep();
    t = performance.now();
    surface = createTerrainSurface(scene, data, { groundTextureSize: quality.groundTextureSize, chunks: quality.terrainChunks });
    boot.surfaceMs = performance.now() - t;
    ground = surface.ground;
    t = performance.now();
    if (options.backdrop) backdrop = createBackdrop(scene, { seed: options.seed });
    boot.backdropMs = performance.now() - t;
    progress(0.14, 'props');
    t = performance.now();
    const propsOptions: WorldPropsBootOptions = {
      nearRadius: quality.nearRadius,
      buildingRadius: quality.buildingRadius,
      variantLimit: quality.variantLimit,
      farTriangles: quality.farTriangles,
      // Quest: thinned on heavy worlds to hold the diorama's triangle budget.
      scatterDensity: worldScatterDensity(quality, data),
      shadowCasters: quality.shadowCasters,
      // With workers the bakes carry the bar to 0.8; the meshes are quick.
      onProgress: (f, label) => progress(baked ? 0.8 + 0.06 * f : 0.14 + 0.5 * f, `props: ${label}`),
      prefetch: bakes.propsPrefetch,
    };
    props = await createWorldProps(scene, data, propsOptions);
    boot.propsMs = performance.now() - t;
  } else {
    t = performance.now();
    arena = createFlatArena(scene);
    ground = arena.ground;
    boot.dataMs = 0;
    boot.surfaceMs = performance.now() - t;
    boot.propsMs = 0;
  }

  // --- cars
  t = performance.now();
  const humanInput = new CompositeInput([new DesktopGamepadInput(), new KeyboardInput()]);
  const carOptions = {
    simplify: simplifyMesh,
    lodDistances: quality.carLodDistances,
    liteRatio: quality.carLiteRatio,
  };
  const cars: GameCar[] = [];
  let session: RaceSession | null = null;
  let player: GameCar;
  let playerInput: InputProvider = humanInput;
  // The rig exists only after the cars; respawn / restart callbacks reach it late.
  let rigRef: CameraRig | null = null;
  let resetRingDir = (): void => {};
  let tuningRef: TuningPanelHandle | null = null;

  if (data) {
    const preset = fieldPreset;
    const poses = gridPoses(data.track, entries.length);
    const field = new RivalField(data.track, { rubberBand: preset.rubberBand });
    const drivers = new Map<string, RivalDriver>();
    session = new RaceSession({
      cars: [],
      playerId: 'player',
      track: data.track,
      ground,
      options,
      field,
      drivers,
      hud: null,
      // A teleport: the camera snaps, and the ring centre's low-passed
      // direction starts afresh with it (otherwise it swings round from the
      // old heading for up to seconds).
      onRespawn: (id) => {
        if (id !== 'player') return;
        rigRef?.snap();
        resetRingDir();
      },
      onRestart: () => {
        rigRef?.snap();
        resetRingDir();
      },
      // A lap driven after a tuning slider moved is not the stock car's.
      canStoreBest: () => !(tuningRef?.touched ?? false),
    });
    let built = 0;
    for (const entry of entries) {
      progress((baked ? 0.86 : 0.65) + ((baked ? 0.11 : 0.32) * built) / entries.length, `car ${built + 1} / ${entries.length}: ${entry.carId}`);
      await yieldStep();
      await bakes.car(entry.carId, wrapLivery(entry.carId, liveries.get(entry.id) ?? 0));
      let input: InputProvider;
      if (entry.isPlayer && !options.autopilot) {
        input = session.gate(humanInput);
        playerInput = input;
      } else {
        const driver = entry.isPlayer
          ? new RivalDriver({ skill: 0.6, seed: options.seed })
          : new RivalDriver({ skill: entry.skill ?? options.difficulty, seed: entry.seed });
        drivers.set(entry.id, driver);
        input = driver;
        if (entry.isPlayer) playerInput = driver;
      }
      const car = await createGameCar(scene, input, {
        id: entry.id,
        carId: entry.carId,
        // Rivals are tuned and measured on the primary model only.
        model: entry.isPlayer ? options.vehicle : 'raycast',
        livery: liveries.get(entry.id) ?? 0,
        tune: entry.isPlayer ? options.tune : undefined,
        ...carOptions,
      });
      // Placed before the field sees it (inside addCar).
      session.addCar(car, poses[entry.slot]);
      cars.push(car);
      built++;
    }
    session.begin();
    player = cars.find((c) => c.id === 'player')!;
    if (options.spot !== null) {
      const s = options.spot === 'village' ? data.plan.village.s0 + 30 : options.spot;
      session.placeAt('player', s);
    }
  } else {
    progress(baked ? 0.86 : 0.65, `car: ${options.car}`);
    await yieldStep();
    await bakes.car(options.car, wrapLivery(options.car, options.livery));
    player = await createGameCar(scene, humanInput, {
      id: 'player',
      carId: options.car,
      model: options.vehicle,
      livery: options.livery,
      tune: options.tune,
      ...carOptions,
    });
    player.place(arena!.spawn, arena!.spawn.yaw);
    cars.push(player);
  }
  boot.carsMs = performance.now() - t;

  // --- camera, actions, dust, sound, UI
  progress(0.97, 'starting');
  // The high camera eases over the start gantry (its place is in the plan).
  const occluders: CameraOccluder[] = [];
  for (const d of data?.plan.dressing ?? []) {
    if (d.asset !== GANTRY_ID) continue;
    occluders.push({
      x: d.x,
      z: d.z,
      yaw: d.yaw,
      halfWidth: GANTRY.halfWidth * d.scale,
      halfDepth: GANTRY.halfDepth * d.scale,
      top: d.y + GANTRY.top * d.scale,
    });
  }
  const rig = createGameCameraRig(scene, canvas, { mode: options.view, heightAt: ground.heightAt, occluders });
  rigRef = rig;
  rig.setSubject(player.vehicle);
  const rivalDust: WheelDust[] = [];
  let playerDust: WheelDust | null = null;
  const applyViewLook = (): void => {
    look.shadows.region = rig.look.shadowRegion;
    look.config.fogDensity = rig.look.fogDensity;
    // The diorama is a table: no hills beyond its edge, only the sky. The
    // high camera's frame top is ~22° below the horizon: the hills cannot
    // show there either (it used to draw them for nothing).
    backdrop?.setVisible(rig.mode === 'chase');
    // Presets without rival dust (quest) still give the rivals a plume in
    // the wide views, where it is what tells the pack apart from above (the
    // diorama is the view Quest ships), and none in chase.
    const rivalSet = rig.mode === 'chase' ? (quality.rivalDust ? RIVAL_DUST_CHASE : RIVAL_DUST_OFF) : rig.mode === 'high' ? DUST_HIGH : RIVAL_DUST_XR;
    for (const d of rivalDust) Object.assign(d.view, rivalSet);
    if (playerDust) Object.assign(playerDust.view, rig.mode === 'high' ? DUST_HIGH : NEUTRAL_DUST_VIEW);
  };
  const actions: GameActionSource = createGameActions();
  const dust: WheelDust[] = [];
  for (const car of cars) {
    if (car === player) {
      playerDust = new WheelDust(scene, car.vehicle, ground, { wheels: 'all' });
      dust.push(playerDust);
    } else {
      // Every preset: on quest it is switched off in chase (applyViewLook).
      const d = new WheelDust(scene, car.vehicle, ground, { wheels: 'rear', capacity: RIVAL_DUST_CAPACITY });
      rivalDust.push(d);
      dust.push(d);
    }
  }
  applyViewLook();
  look.contacts = cars.slice(0, 4).map((c) => c.contact);
  const sound = fixedStep ? null : attachEngineSound(player.vehicle);

  // The tuning panel and dev strip are for development: every dev-server
  // build, and a production build only when the URL asks with `dev=1`.
  const devUi = !fixedStep && (import.meta.env.DEV || options.dev);
  const tuning: TuningPanelHandle | null = devUi ? createTuningPanel(scene, player.vehicle, playerInput) : null;
  tuningRef = tuning;
  const devOverlay: DevOverlayHandle | null = devUi ? createDevOverlay(options) : null;
  const perf: PerfOverlayHandle | null = !fixedStep && options.perf ? createPerfOverlay() : null;
  if (options.dev) {
    tuning?.show();
    devOverlay?.show();
  }
  // Each HUD offset is tied to the element it avoids: the dev strip (top
  // edge, full width) pushes everything down; the tuning panel (top right
  // corner) moves only the lap panel left. The panel itself starts below the
  // strip while the strip shows.
  const hudKey = (): string =>
    `${devOverlay?.visible ? 1 : 0}${tuning?.visible ? 1 : 0}${rig.mode}`;
  const hudOptions = (): HudOptions => {
    const o: HudOptions = options.shot ? { animate: false } : {};
    const count = COUNTDOWN[rig.mode];
    o.countdownY = count.y;
    o.countdownX = count.x;
    o.countdownScale = count.scale;
    o.countdownRefAspect = count.refAspect;
    const dev = devOverlay?.visible ?? false;
    if (dev) o.insets = { top: DEV_OVERLAY_HEIGHT };
    if (tuning?.visible) o.lapPanelShift = { x: 262 };
    if (rig.mode === 'xr') o.scale = XR_HUD_SCALE;
    tuning?.setTop(dev ? DEV_OVERLAY_HEIGHT + TUNING_TOP : TUNING_TOP);
    return o;
  };
  let hudState = '';
  if (session) {
    session.hud = new Hud(hudOptions());
    hudState = hudKey();
  } else {
    hudOptions(); // places the tuning panel
  }
  const refreshHud = (): void => {
    const want = hudKey();
    if (want === hudState) return;
    hudState = want;
    const o = hudOptions();
    if (!session) return;
    session.hud?.dispose();
    session.hud = new Hud(o);
  };

  // --- frame
  const dc = (engine as unknown as { _drawCalls: DrawCounter })._drawCalls;
  let frameDt = FIXED_DT;
  let flatReset = false;
  let lastDrawCalls = 0;
  let lastTriangles = 0;
  const propsView: PropsView = { x: 0, z: 0, nearRadius: 0, buildingRadius: 0, farDetail: false, farShadows: false };
  /** Low-passed horizontal view direction the ring centre is pushed along
   * (unit; 0,0 = not started: the first frame takes the view as it is). */
  let ringDirX = 0;
  let ringDirZ = 0;
  resetRingDir = (): void => {
    ringDirX = ringDirZ = 0;
  };

  const updatePropsView = (dt: number): void => {
    if (!props) return;
    const xr = rig.mode === 'xr';
    const nearOn = !xr || rig.focusDistance < XR_NEAR_DISTANCE;
    const layout = RING_LAYOUT[quality.name][rig.mode];
    const radius = quality.nearRadius * layout.radius;
    let x = rig.focus.x;
    let z = rig.focus.z;
    if (!xr && layout.ahead > 0) {
      // Centre ahead of the car along the view direction: the near tier is
      // not frustum-culled, so this spends its instances where the camera
      // looks. The direction is low-passed (RING_DIR_TAU) so a drift or a
      // spin does not sweep the ring edge across trees every frame.
      const dx = rig.focus.x - rig.eye.x;
      const dz = rig.focus.z - rig.eye.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-3) {
        const ux = dx / len;
        const uz = dz / len;
        if (ringDirX === 0 && ringDirZ === 0) {
          ringDirX = ux;
          ringDirZ = uz;
        } else {
          const k = dt > 0 ? 1 - Math.exp(-dt / RING_DIR_TAU) : 1;
          ringDirX += (ux - ringDirX) * k;
          ringDirZ += (uz - ringDirZ) * k;
          const l = Math.hypot(ringDirX, ringDirZ);
          if (l > 1e-3) {
            ringDirX /= l;
            ringDirZ /= l;
          } else {
            ringDirX = ux;
            ringDirZ = uz;
          }
        }
        x += layout.ahead * radius * ringDirX;
        z += layout.ahead * radius * ringDirZ;
      }
    }
    propsView.x = x;
    propsView.z = z;
    propsView.nearRadius = nearOn ? radius : 0;
    propsView.buildingRadius = nearOn ? quality.buildingRadius * layout.buildingRadius : 0;
    propsView.farDetail = xr;
    propsView.farShadows = xr;
    props.update(propsView);
  };

  const perfReadout: PerfReadout = {
    fps: 0, drawCalls: 0, triangles: 0, shadowDrawCalls: 0, shadowTriangles: 0,
    nearInstances: 0, farInstances: 0, nearActive: 0, farActive: 0, carTriangles: 0, carLods: '',
    dpr: dpr, drawWidth: 0, drawHeight: 0,
  };
  // Automatic step-down of the render resolution (`high` only, not forced,
  // not in shot / report pages), against the display's own frame-rate
  // ceiling (DprGovernor: a 30 Hz display is not a slow GPU).
  const dprGov = options.dpr === null && quality.name === 'high' && !fixedStep && dpr > 1 ? new DprGovernor(dpr) : null;
  const watchDpr = (): void => {
    if (!dprGov || !dprGov.frame(engine.getDeltaTime() / 1000)) return;
    dpr = dprGov.ratio;
    engine.setHardwareScalingLevel(quality.hardwareScaling / dpr);
    console.info(`[game] render resolution ${dpr}× (smoothed ${dprGov.fps.toFixed(0)} fps, display ceiling ${dprGov.ceiling.toFixed(0)} fps)`);
  };
  let perfNext = 0;
  const frameStats = (): FrameStats => {
    const sh = shadowPass(look);
    return { drawCalls: lastDrawCalls, triangles: lastTriangles, shadowDrawCalls: sh.drawCalls, shadowTriangles: Math.round(sh.triangles) };
  };
  const samplePerf = (): void => {
    if (!perf) return;
    const now = performance.now();
    if (now < perfNext) return;
    perfNext = now + 250;
    const f = frameStats();
    perfReadout.fps = engine.getFps();
    perfReadout.drawCalls = f.drawCalls;
    perfReadout.triangles = f.triangles;
    perfReadout.shadowDrawCalls = f.shadowDrawCalls;
    perfReadout.shadowTriangles = f.shadowTriangles;
    perfReadout.nearInstances = props?.stats.nearInstances ?? 0;
    perfReadout.farInstances = props?.stats.farInstances ?? 0;
    perfReadout.nearActive = props?.stats.nearActive ?? 0;
    perfReadout.farActive = props?.stats.farActive ?? 0;
    let tris = 0;
    let lods = '';
    for (const c of cars) {
      tris += c.triangles;
      lods += c.lod;
    }
    perfReadout.carTriangles = tris;
    perfReadout.carLods = lods;
    perfReadout.dpr = dpr;
    perfReadout.drawWidth = engine.getRenderWidth();
    perfReadout.drawHeight = engine.getRenderHeight();
    perf.update(perfReadout);
  };

  // After the physics step. Registered LAST: every vehicle's own observers
  // (wheel poses, contact states) have run by the time this reads them.
  scene.onAfterPhysicsObservable.add(() => {
    const dt = frameDt;
    for (let i = 0; i < cars.length; i++) cars[i].syncVisual(dt, rig.eye);
    if (session) {
      session.afterPhysics(dt);
    } else {
      const v = player.vehicle;
      const rescue = needsRescue(v, dt);
      if (flatReset || rescue || isOutOfWorld(v, FLAT_HALF, FLAT_KILL_Y)) {
        player.place(arena!.spawn, arena!.spawn.yaw);
        rig.snap();
      }
    }
    rig.update(dt);
    updatePropsView(dt);
    look.shadows.setFocus(rig.look.followCar ? rig.focus : ORIGIN);
    for (let i = 0; i < dust.length; i++) dust[i].update();
    sound?.update();
    samplePerf();
  });

  const frame = (dt: number): void => {
    frameDt = dt;
    // Before the frame is drawn: a new ratio resizes the canvas, which clears
    // it; after scene.render() that presented one blank frame per change.
    watchDpr();
    const a = actions.poll();
    if (a.camera) {
      rig.cycle();
      ringDirX = ringDirZ = 0;
      applyViewLook();
      devOverlay?.setView(rig.mode);
      refreshHud();
    }
    if (a.tuning && tuning) {
      tuning.toggle();
      refreshHud();
    }
    if (a.dev && devOverlay) {
      devOverlay.toggle();
      refreshHud();
    }
    if (session) {
      session.beforePhysics(dt, a);
    } else {
      flatReset = a.reset;
      player.vehicle.update(dt);
    }
    dc.fetchNewFrame();
    scene.render();
    lastDrawCalls = dc.current;
    lastTriangles = Math.round(scene.getActiveIndices() / 3);
  };

  let disposed = false;
  const onResize = (): void => {
    engine.resize();
    // Shot mode has no render loop and resizing clears the canvas (headless
    // Chrome resizes the viewport right before its screenshot): draw the same
    // frame again — physics is frozen by then, nothing moves. The rig takes
    // a zero step first: it re-derives the fov from the NEW aspect (the
    // chase rule keeps the horizontal fov below 16:9), which a picture taken
    // at another window shape than the boot's otherwise lacks (4:3
    // shots showed the 3D view at the boot window's fov while the HUD
    // followed the real one).
    if (options.shot && !scene.physicsEnabled) {
      rig.update(0);
      scene.render();
    }
  };
  window.addEventListener('resize', onResize);

  const game: Game = {
    engine,
    scene,
    options,
    quality,
    look,
    data,
    surface,
    arena,
    props,
    cars,
    player,
    rig,
    session,
    backdrop,
    get dpr(): number {
      return dpr;
    },
    boot,
    dust,
    frameStats,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      engine.stopRenderLoop();
      actions.dispose();
      humanInput.dispose();
      sound?.dispose();
      tuning?.dispose();
      devOverlay?.dispose();
      perf?.dispose();
      for (const d of dust) d.dispose();
      session?.dispose();
      props?.dispose();
      for (const c of cars) c.dispose();
      rig.dispose();
      surface?.dispose();
      backdrop?.dispose();
      arena?.dispose();
      scene.dispose();
      engine.dispose();
    },
  };

  // --- warm-up and start
  if (sync) {
    // Babylon 9 loads the particle shaders with an async import; a synchronous
    // simulation started before that would run without dust.
    for (let waited = 0; waited < 5000 && !dust.every((d) => d.isReady()); waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // Two warm-up frames (shader compile, shadow map); the rig settles behind
  // the car instead of swinging in from its default pose.
  frame(FIXED_DT);
  rig.snap();
  frame(FIXED_DT);
  if (!sync) await scene.whenReadyAsync();
  boot.gameMs = performance.now() - tStart;
  // Workers stop; what they computed goes to the persistent cache in the
  // background (the numbers land in `boot` as `bake.*`).
  if (props) {
    boot['bake.propsPrepareMs'] = props.stats.prepareMs;
    boot['bake.propsSimplifyMs'] = props.stats.simplifyMs;
    boot['bake.propsMeshMs'] = props.stats.meshMs;
    boot['bake.propsColliderMs'] = props.stats.colliderMs;
    for (const [k, v] of Object.entries(lastWorldPropsPhases)) boot[`bake.propsPhase.${k}`] = v;
  }
  if (new URLSearchParams(location.search).get('bakehash') === '1') bakeDigests = await bakes.digests();
  boot['bake.progressUpdates'] = progressCount;
  boot['bake.progressMaxGapMs'] = Math.max(progressGap, performance.now() - progressLast);
  Object.assign(boot, bakes.stats);
  void bakes.finish().then(() => Object.assign(boot, bakes.stats));
  boot.totalMs = performance.now();
  progress(1, 'ready');

  if (options.shot) {
    const steps = Math.round(options.at / FIXED_DT);
    for (let i = 0; i < steps; i++) frame(FIXED_DT);
    for (let i = 0; i < 3; i++) frame(FIXED_DT);
    scene.physicsEnabled = false;
    setStatus(`shot ready  seed ${options.seed}  view ${rig.mode}  model ${player.vehicle.modelName}  car ${fmtV(player.vehicle.chassisMesh.position)}  lods ${cars.map((c) => c.lod).join('')}  dust ${dust[0]?.activeParticles ?? 0}  dpr ${dpr} draw ${engine.getRenderWidth()}x${engine.getRenderHeight()}`);
    return game; // no render loop: the picture is this frame
  }
  if (options.report) {
    void runReport(game, frame).catch((e: unknown) => writeFatal(e));
    return game;
  }
  engine.runRenderLoop(() => frame(beginPhysicsFrame(scene)));
  return game;
}

// ---------------------------------------------------------------------------
// Report mode (contracts/report.ts)

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function fmtV(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function writeResult(report: LabReport, title: 'done' | 'error'): void {
  const el = document.getElementById('result');
  if (el) el.textContent = JSON.stringify(report);
  document.title = title;
}

/** An error as one text: the message once, then where it happened. V8's
 * `stack` already starts with the message; Firefox's and Safari's hold only
 * the frames, so the message goes in front there. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const stack = e.stack ?? '';
  if (!stack) return e.message;
  return stack.includes(e.message) ? stack : `${e.name}: ${e.message}\n${stack}`;
}

/** A boot or run that could not finish: `{ fatal }` and the title `error`. */
export function writeFatal(e: unknown): void {
  const message = errorText(e);
  writeResult(
    {
      page: 'index',
      query: location.search.replace(/^\?/, ''),
      totals: { simSeconds: 0 },
      scorecard: { text: `fatal: ${message}` },
      errors: [...pageErrors],
      fatal: message,
      stats: {},
      checks: [],
    },
    'error',
  );
}

async function runReport(game: Game, frame: (dt: number) => void): Promise<void> {
  const { engine, session, cars, props, options } = game;
  const race = session?.race ?? null;
  const samples = {
    drawCalls: [] as number[], triangles: [] as number[], shadowDrawCalls: [] as number[], shadowTriangles: [] as number[],
    nearInstances: [] as number[], farInstances: [] as number[], nearActive: [] as number[], farActive: [] as number[],
    carTriangles: [] as number[], fps: [] as number[],
  };
  let sim = 0;
  let frames = 0;
  let nextSample = 0.5;
  const moved30: Record<string, number> = {};
  const allDone = (): boolean => {
    if (!race || !Number.isFinite(race.config.laps)) return false;
    for (const c of cars) if (!race.snapshot(c.id).finish) return false;
    return true;
  };
  setStatus('racing');
  const tWall = performance.now();
  await new Promise<void>((resolve) => {
    engine.runRenderLoop(() => {
      frame(FIXED_DT);
      sim += FIXED_DT;
      frames++;
      if (sim >= nextSample) {
        nextSample += 0.5;
        const f = game.frameStats();
        samples.drawCalls.push(f.drawCalls);
        samples.triangles.push(f.triangles);
        samples.shadowDrawCalls.push(f.shadowDrawCalls);
        samples.shadowTriangles.push(f.shadowTriangles);
        if (props) {
          samples.nearInstances.push(props.stats.nearInstances);
          samples.farInstances.push(props.stats.farInstances);
          samples.nearActive.push(props.stats.nearActive);
          samples.farActive.push(props.stats.farActive);
        }
        let tris = 0;
        for (const c of cars) tris += c.triangles;
        samples.carTriangles.push(tris);
        // The first second still compiles / fills caches; skip it for fps.
        if (sim > 1) samples.fps.push(engine.getFps());
        setStatus(`racing ${sim.toFixed(0)} / ${options.seconds} s`);
      }
      if (session && sim >= 30 && Object.keys(moved30).length === 0) {
        for (const c of cars) moved30[c.id] = session.odometer(c.id);
      }
      if (sim >= options.seconds || allDone()) {
        engine.stopRenderLoop();
        resolve();
      }
    });
  });
  const wallMs = performance.now() - tWall;
  if (session && Object.keys(moved30).length === 0) for (const c of cars) moved30[c.id] = session.odometer(c.id);

  const stats: Record<string, ReportValue> = {};
  const checks: LabReport['checks'] = [];
  const round = (v: number | null, k = 1): number | null => (v === null ? null : Math.round(v * k) / k);
  const check = (id: string, value: ReportValue, target: string, pass: boolean): void => {
    checks.push({ id, value: typeof value === 'number' ? Math.round(value * 1000) / 1000 : value, target, pass });
  };
  for (const key of ['dataMs', 'surfaceMs', 'backdropMs', 'propsMs', 'carsMs', 'totalMs', 'physicsMs', 'lookMs', 'gameMs']) {
    stats[`boot.${key}`] = round(game.boot[key] ?? null);
  }
  for (const [key, v] of Object.entries(game.boot)) if (key.startsWith('bake.')) stats[`boot.${key}`] = round(v, 10);
  if (bakeDigests) for (const [key, v] of Object.entries(bakeDigests)) stats[`bakehash.${key}`] = v;
  stats['frame.drawCalls.median'] = round(median(samples.drawCalls));
  stats['frame.drawCalls.max'] = samples.drawCalls.length ? Math.max(...samples.drawCalls) : null;
  stats['frame.triangles.median'] = round(median(samples.triangles));
  stats['frame.triangles.max'] = samples.triangles.length ? Math.max(...samples.triangles) : null;
  stats['frame.shadowDrawCalls.median'] = round(median(samples.shadowDrawCalls));
  stats['frame.shadowTriangles.median'] = round(median(samples.shadowTriangles));
  stats['props.nearInstances'] = round(median(samples.nearInstances));
  stats['props.farInstances'] = round(median(samples.farInstances));
  stats['props.nearActive'] = round(median(samples.nearActive));
  stats['props.farActive'] = round(median(samples.farActive));
  stats['cars.triangles.median'] = round(median(samples.carTriangles));
  stats['quality'] = game.quality.name;
  stats['render.dpr'] = game.dpr;
  stats['render.width'] = engine.getRenderWidth();
  stats['render.height'] = engine.getRenderHeight();
  stats['render.cssWidth'] = engine.getRenderingCanvas()?.clientWidth ?? null;
  stats['render.cssHeight'] = engine.getRenderingCanvas()?.clientHeight ?? null;
  stats['backdrop.triangles'] = game.backdrop?.triangles ?? 0;
  stats['backdrop.visible'] = game.backdrop?.visible ?? false;
  stats['view'] = options.view;
  stats['vehicle'] = game.player.vehicle.modelName;
  stats['sim.seconds'] = round(sim, 100);
  stats['sim.frames'] = frames;
  stats['wall.seconds'] = round(wallMs / 1000, 10);
  stats['fps.median'] = round(median(samples.fps), 10);

  if (race && session) {
    let finished = 0;
    let storm = '';
    let lazy = '';
    for (const c of cars) {
      const id = c.id;
      const snap = race.snapshot(id);
      const st = race.carState(id);
      if (snap.finish) finished++;
      stats[`race.${id}.car`] = c.carId;
      stats[`race.${id}.laps`] = st.lapsDone;
      stats[`race.${id}.time`] = snap.finish ? round(snap.finish.totalTime, 100) : null;
      stats[`race.${id}.position`] = snap.position;
      stats[`race.${id}.respawns`] = session.respawnCounts[id] ?? 0;
      const causes = Object.entries(session.respawnCauses[id] ?? {}).map(([k, n]) => `${k}:${n}`).join(' ');
      stats[`race.${id}.respawnCauses`] = causes;
      stats[`race.${id}.moved30`] = round(moved30[id] ?? 0);
      const inLap = session.maxRespawnsPerLap[id] ?? 0;
      stats[`race.${id}.maxRespawnsInOneLap`] = inLap;
      if (inLap > 2) storm += `${id}:${inLap} in one lap `;
      if (!((moved30[id] ?? 0) > 100)) lazy += `${id}:${(moved30[id] ?? 0).toFixed(0)}m `;
    }
    stats['race.finished'] = finished;
    stats['race.phase'] = race.phase;
    check('race.noRespawnStorm', storm.trim() || 'ok', '≤ 2 respawns per car per lap', storm === '');
    check('race.allMoved', lazy.trim() || 'ok', 'every car covered > 100 m in the first 30 s', lazy === '');
    if (Number.isFinite(race.config.laps)) {
      check('race.allFinished', `${finished} / ${cars.length}`, `every car finished ${race.config.laps} lap(s) within ${options.seconds} s`, finished === cars.length);
    }
  }
  // Booted = createGame returned with a player car, the loop ran frames,
  // and the player's car is still a finite position (not NaN from a broken
  // physics step).
  const pp = game.player.vehicle.chassisMesh.position;
  const bootOk = frames > 0 && Number.isFinite(game.boot.totalMs) && Number.isFinite(pp.x + pp.y + pp.z);
  check('boot.ok', bootOk ? 'ok' : `frames ${frames}, player at ${fmtV(pp)}`, 'the game booted, ran frames, player position finite', bootOk);
  // A boot that wanted bake workers got every job back from them
  // (a broken worker path still boots, on the main thread, ~2.5× slower).
  const bk = (k: string): number => game.boot[`bake.${k}`] ?? 0;
  const bakeWanted = bk('workers') > 0 || bk('workerStartFailed') > 0;
  const bakeFallbacks = bk('failedCars') + bk('failedProps') + bk('workerStartFailed');
  check(
    'boot.bakeWorkers',
    bakeWanted ? `${bakeFallbacks} job(s) redone on the main thread, ${bk('lost')} worker(s) lost` : 'no workers asked for',
    'with bake workers: no job falls back to the main thread',
    !bakeWanted || (bakeFallbacks === 0 && bk('lost') === 0),
  );
  const errors = [...pageErrors];
  check('errors.none', errors.length, 'no page errors', errors.length === 0);

  const lines: string[] = [];
  for (const [k, v] of Object.entries(stats)) lines.push(`${k.padEnd(30)} ${v}`);
  for (const c of checks) lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(22)} ${c.value}  (${c.target})`);
  setStatus('done');
  writeResult(
    {
      page: 'index',
      query: location.search.replace(/^\?/, ''),
      totals: { simSeconds: Math.round(sim * 100) / 100 },
      scorecard: { text: lines.join('\n') },
      errors,
      stats,
      checks,
    },
    'done',
  );
}
