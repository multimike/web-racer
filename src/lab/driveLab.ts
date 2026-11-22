import { Effect, Engine, HavokPlugin, Matrix, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import type { AbstractMesh, Mesh } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { beginPhysicsFrame } from '../car/createVehicle';
import { GAME_GRAVITY } from '../car/rig';
import { CAMERA_TUNING, createCameraRig } from '../game/camera/CameraRig';
import { createGameCar } from '../game/car/GameCar';
import type { CarLod } from '../game/car/CarLod';
import type { CarLodLevel, DustGround, GameCar } from '../game/contracts/car';
import type { ViewMode } from '../game/contracts/camera';
import type { FrameStats, LabReport, ReportValue } from '../game/contracts/report';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, createLook } from '../gfx/look/lighting';
import { simplifyMesh } from '../render/scatter/simplify';
import type { LookRuntime, ShadowQuality } from '../gfx/look/lighting';
import { WheelDust } from '../gfx/WheelDust';
import { CompositeInput } from '../input/CompositeInput';
import { DesktopGamepadInput } from '../input/DesktopGamepadInput';
import { createGameActions } from '../input/GameActions';
import { KeyboardInput } from '../input/KeyboardInput';
import type { CarIntent, InputProvider } from '../input/types';
import { ZERO_INTENT } from '../input/types';

/**
 * DRIVE LAB — proving ground of the game car: a game car (any vehicle model
 * in any of the four designs), the camera rig, the game actions and the
 * wheel dust on a plain floor, booted exactly like the game boots (boot
 * order and frame order of src/scene/createScene.ts): Havok in fixed-step mode driven by `beginPhysicsFrame`, the look
 * runtime with sky and 2048 shadows, cars, rig, actions, dust; visuals posed
 * in `onAfterPhysicsObservable`, registered after the cars.
 *
 * URL:  car= vehicle= livery= view=chase|high|xr cars=1..4 lod=0|1|2
 *       shadows=off|1024|2048 auto=1 shot=1 at=<s> report=1 seconds=<n>
 *
 * shot=1    synchronous: shaders compiled synchronously, `at` seconds
 *           simulated at a fixed 1/60 s, three more frames, NO render loop.
 * report=1  the protocol of contracts/report.ts (numbers through
 *           tools/physlab.sh, PHYSLAB_PAGE=drive-lab.html).
 */

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};

const DESIGNS = ['reef-rocket', 'neon-wasp', 'riot-ram', 'comet-fox'];
const carParam = params.get('car') ?? 'reef-rocket';
const model = params.get('vehicle') ?? 'raycast';
const livery = Math.max(0, Math.round(num('livery', 0)));
const viewParam = params.get('view');
const startView: ViewMode = viewParam === 'high' || viewParam === 'xr' ? viewParam : 'chase';
const carCount = Math.min(4, Math.max(1, Math.round(num('cars', 1))));
const lodParam = params.get('lod');
const lodForce: CarLodLevel | null = lodParam === '0' || lodParam === '1' || lodParam === '2' ? (Number(lodParam) as CarLodLevel) : null;
const shadowParam = params.get('shadows') ?? '2048';
const shadowQuality: ShadowQuality = shadowParam === 'off' ? 'off' : shadowParam === '1024' ? 1024 : 2048;
const auto = params.get('auto') === '1';
const shotMode = params.get('shot') === '1';
const reportMode = params.get('report') === '1';
const FIXED_DT = 1 / 60;

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const setStatus = (text: string): void => {
  if (statusEl) statusEl.textContent = text;
};
if (shotMode || reportMode) document.body.classList.add('quiet');
if (params.get('debug') === '1') document.body.classList.add('debug');
window.addEventListener('error', (e) => setStatus(`window error: ${e.message}`));

// ---------------------------------------------------------------------------
// Scripted driver

/** `auto=1`: throttle 0.7, steering 0.5·sin(0.8 t). */
class AutoInput implements InputProvider {
  readonly name = 'auto';
  enabled = true;
  t = 0;
  private readonly intent: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  isActive(): boolean {
    return true;
  }
  advance(dt: number): void {
    if (this.enabled) this.t += dt;
  }
  poll(): CarIntent {
    if (!this.enabled) return ZERO_INTENT;
    this.intent.throttle = 0.7;
    this.intent.steering = 0.5 * Math.sin(0.8 * this.t);
    this.intent.brake = 0;
    return this.intent;
  }
}

/** What the dust asks the lab floor: flat at y = 0, all dirt road, unpaved
 * (closures — GroundQuery methods are called unbound). The ramp is not in it:
 * up there a wheel counts as airborne and throws nothing, like planking. */
const LAB_GROUND: DustGround = {
  heightAt: () => 0,
  surfaceAt: (_x, _z, out) => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    out[3] = 0;
  },
  pavedAt: () => 0,
};

const PARKED: InputProvider = { name: 'parked', isActive: () => true, poll: () => ZERO_INTENT };

// ---------------------------------------------------------------------------
// World

/** Look-matte floor material (see lookLab's buildGround): a dirt checker
 * computed in the shader from world x / z, timber planking on anything raised
 * (the ramp). Receives the cars' contact pools. */
function floorMaterial(scene: Scene, look: LookRuntime): ShaderMaterial {
  Effect.ShadersStore['driveFloorVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    uniform mat4 world;
    uniform mat4 viewProjection;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      gl_Position = viewProjection * wp;
    }
  `;
  Effect.ShadersStore['driveFloorFragmentShader'] = `
    precision highp float;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    #include<lookLighting>
    void main() {
      // 4 m checker in the vision's warm ochre road dirt (sRGB), a darker
      // line every 20 m to read speed. The dust reads this floor as dirt.
      vec2 cell = floor(vWorldPos.xz / 4.0);
      float k = mod(cell.x + cell.y, 2.0);
      vec3 dirt = mix(vec3(0.82, 0.62, 0.42), vec3(0.76, 0.56, 0.37), k);
      vec2 m = abs(fract(vWorldPos.xz / 20.0 + 0.5) - 0.5) * 20.0;
      dirt *= 1.0 - 0.15 * (1.0 - step(0.12, min(m.x, m.y)));
      vec3 plank = mix(vec3(0.58, 0.38, 0.27), vec3(0.50, 0.32, 0.22), mod(floor(vWorldPos.z / 0.6), 2.0));
      vec3 albedo = mix(dirt, plank, step(0.02, vWorldPos.y));
      gl_FragColor = lookShadeMatte(lookToLinear(albedo), normalize(vNormal), vWorldPos, 1.0, 1.0);
    }
  `;
  const mat = new ShaderMaterial('driveFloor', scene, 'driveFloor', {
    attributes: ['position', 'normal'],
    uniforms: ['world', 'viewProjection', ...LOOK_UNIFORMS],
    samplers: [...LOOK_SAMPLERS],
  });
  mat.needAlphaBlendingForMesh = () => false;
  look.register(mat, { contact: true });
  return mat;
}

function buildWorld(scene: Scene, look: LookRuntime): { floor: Mesh; ramp: Mesh } {
  const mat = floorMaterial(scene, look);
  // 400 × 400 m static box, top face at y = 0.
  const floor = MeshBuilder.CreateBox('floor', { width: 400, height: 1, depth: 400 }, scene);
  floor.position.set(0, -0.5, 0);
  floor.material = mat;
  floor.applyFog = false;
  floor.isPickable = false;
  new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0, friction: 2.0, restitution: 0 }, scene);

  // 12° ramp, 6 × 0.5 × 10 m: entry edge flush with the floor 30 m ahead of
  // the start and 8 m to the right (the scripted auto run keeps left of it).
  const angle = (12 * Math.PI) / 180;
  const ramp = MeshBuilder.CreateBox('ramp', { width: 6, height: 0.5, depth: 10 }, scene);
  // Negative rotation about +x lifts the +z end (Babylon's left-handed frame).
  ramp.rotation.x = -angle;
  // Top surface centre 5 m up the slope from the entry edge (30, y = 0); the
  // box centre sits half its thickness below that, along the slope normal.
  const topZ = 30 + 5 * Math.cos(angle);
  const topY = 5 * Math.sin(angle);
  ramp.position.set(8, topY - 0.25 * Math.cos(angle), topZ + 0.25 * Math.sin(angle));
  ramp.material = mat;
  ramp.applyFog = false;
  ramp.isPickable = false;
  new PhysicsAggregate(ramp, PhysicsShapeType.BOX, { mass: 0, friction: 1.0, restitution: 0 }, scene);
  look.shadows.addCaster(ramp);
  return { floor, ramp };
}

// ---------------------------------------------------------------------------
// Measuring

type DrawCounter = { current: number; fetchNewFrame(): void };

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

/** Projected screen rectangle helper (fractions of the render size). */
const SCRATCH = { v: new Vector3(), out: new Vector3() };
function project(scene: Scene, engine: Engine, x: number, y: number, z: number): { x: number; y: number } {
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();
  const cam = scene.activeCamera!;
  const vp = cam.viewport.toGlobal(w, h);
  SCRATCH.v.set(x, y, z);
  Vector3.ProjectToRef(SCRATCH.v, Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp, SCRATCH.out);
  return { x: SCRATCH.out.x / w, y: SCRATCH.out.y / h };
}

/** The car's projected width tire to tire, as a share of the render width:
 * the outer face of every tire sampled round its rim. */
function projectedWidth(scene: Scene, engine: Engine, car: GameCar): number {
  const inst = car.instance;
  const spec = inst.asset.spec;
  const m = inst.root.computeWorldMatrix(true).m;
  const right = [m[0], m[1], m[2]], up = [m[4], m[5], m[6]], fwd = [m[8], m[9], m[10]];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4; i++) {
    const hub = inst.hubNodes[i].computeWorldMatrix(true);
    const c = hub.getTranslation();
    const front = i < 2;
    const r = front ? spec.frontTireRadius : spec.rearTireRadius;
    const half = (front ? spec.frontTireWidth : spec.rearTireWidth) / 2;
    const side = i % 2 === 0 ? -1 : 1;
    for (let s = 0; s < 16; s++) {
      const a = (s / 16) * Math.PI * 2;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      const p = project(
        scene,
        engine,
        c.x + right[0] * side * half + up[0] * ca + fwd[0] * sa,
        c.y + right[1] * side * half + up[1] * ca + fwd[1] * sa,
        c.z + right[2] * side * half + up[2] * ca + fwd[2] * sa,
      );
      lo = Math.min(lo, p.x);
      hi = Math.max(hi, p.x);
    }
  }
  return hi - lo;
}

// ---------------------------------------------------------------------------

/** shot=1 must give the same picture every run. Babylon's
 * particle system draws life, size, scale, angle and gradient picks from
 * `Math.random`, so the shot page swaps it for a seeded generator before
 * anything is built. Lab page only — the game keeps the real one. */
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

async function main(): Promise<void> {
  if (shotMode) seedMathRandom(0x2545f491);
  const tBoot = performance.now();
  const canvas = document.getElementById('drive') as HTMLCanvasElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: shotMode });
  // Headless screenshots run on a virtual clock that expires before an
  // async (parallel) shader compile reports back; compile synchronously.
  if (shotMode || reportMode) engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);
  // Particles and the look's clock read the engine's frame time; in the
  // synchronous modes that is meaningless, so use a constant 1/60.
  if (shotMode || reportMode) scene.useConstantAnimationDeltaTime = true;

  const havok = await HavokPhysics();
  // `false` = fixed-step mode: beginPhysicsFrame sets the step each frame.
  const plugin = new HavokPlugin(false, havok);
  scene.enablePhysics(new Vector3(0, -GAME_GRAVITY, 0), plugin);
  if (shotMode || reportMode) plugin.setTimeStep(FIXED_DT);

  const look = createLook(scene, { shadowQuality, shadowRegion: 80, sky: true });
  buildWorld(scene, look);

  const rig = createCameraRig(scene, canvas, { mode: reportMode ? 'chase' : startView, heightAt: () => 0 });
  const applyViewLook = (): void => {
    look.shadows.region = rig.look.shadowRegion;
    look.config.fogDensity = rig.look.fogDensity;
  };
  applyViewLook();
  const worldMs = performance.now() - tBoot;

  const dc = (engine as unknown as { _drawCalls: DrawCounter })._drawCalls;
  const ORIGIN = new Vector3(0, 0, 0);
  const measure = (step: () => void): FrameStats => {
    dc.fetchNewFrame();
    step();
    const shadow = shadowPass(look);
    return { drawCalls: dc.current, triangles: Math.round(scene.getActiveIndices() / 3), shadowDrawCalls: shadow.drawCalls, shadowTriangles: Math.round(shadow.triangles) };
  };

  // The empty frame (floor, ramp, sky), from where the chase camera will
  // stand behind a car at the start: BEFORE any car exists.
  let empty: FrameStats | null = null;
  if (reportMode) {
    const cam = rig.camera as unknown as { position: Vector3; rotation: Vector3; fov: number };
    const c = CAMERA_TUNING.chase;
    cam.position.set(0, c.height, -c.distance);
    cam.rotation.set(Math.atan2(c.height - c.lookUp, c.distance + c.lookAhead), 0, 0);
    cam.fov = c.fov;
    look.shadows.setFocus(ORIGIN);
    setStatus('empty frame');
    scene.render();
    empty = measure(() => scene.render());
  }

  // Cars: the player first, then the other designs parked in a row to the
  // left (the auto run's heading never swings left of +z), zero input.
  const autoInput = new AutoInput();
  autoInput.enabled = auto && !reportMode;
  const playerInput: InputProvider = auto ? autoInput : new CompositeInput([new DesktopGamepadInput(), new KeyboardInput()]);
  const designs = [carParam, ...DESIGNS.filter((d) => d !== carParam)].slice(0, carCount);
  const cars: GameCar[] = [];
  const carMs: number[] = [];
  const starts: Vector3[] = [];
  for (let i = 0; i < designs.length; i++) {
    setStatus(`car ${i + 1} / ${designs.length}: ${designs[i]}`);
    const t0 = performance.now();
    const car = await createGameCar(scene, i === 0 ? playerInput : PARKED, {
      id: i === 0 ? 'player' : `parked-${i}`,
      carId: designs[i],
      model: i === 0 ? model : 'raycast',
      livery: i === 0 ? livery : 0,
      simplify: simplifyMesh,
    });
    carMs.push(performance.now() - t0);
    const start = new Vector3(-4.5 * i, 0, 3 * i);
    car.place(start, 0);
    car.lodOverride = lodForce;
    starts.push(start);
    cars.push(car);
  }
  const player = cars[0];
  const dusts = cars.map((car) => new WheelDust(scene, car.vehicle, LAB_GROUND));
  look.contacts = cars.slice(0, 4).map((c) => c.contact);
  rig.setSubject(player.vehicle);

  const actions = createGameActions();
  let frameDt = FIXED_DT;
  // Registered AFTER the cars, so each vehicle's own observers run first.
  scene.onAfterPhysicsObservable.add(() => {
    for (const car of cars) car.syncVisual(frameDt, rig.eye);
    rig.update(frameDt);
    look.shadows.setFocus(rig.look.followCar ? rig.focus : ORIGIN);
    for (const d of dusts) d.update();
  });

  const frame = (dt: number): void => {
    frameDt = dt;
    const a = actions.poll();
    if (a.camera) {
      rig.cycle();
      applyViewLook();
    }
    if (a.reset) {
      player.place(starts[0], 0);
      rig.snap();
    }
    autoInput.advance(dt);
    for (const car of cars) car.vehicle.update(dt);
    scene.render();
  };

  // The particle shaders arrive through an async import: a synchronous
  // simulation started before that would run without dust.
  for (let waited = 0; waited < 5000 && !dusts.every((d) => d.isReady()); waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // A first frame poses everything (the cars were placed, the rig snaps).
  frame(FIXED_DT);
  rig.snap();

  (window as unknown as { __drive: unknown }).__drive = { engine, scene, look, rig, cars, dusts, actions, CAMERA_TUNING, autoInput };
  window.addEventListener('resize', () => {
    engine.resize();
    // Shot mode has no render loop, and resizing clears the canvas (headless
    // Chrome resizes the viewport for its screenshot): draw the same frame
    // again — physics is frozen by then, so nothing moves.
    if (shotMode && !scene.physicsEnabled) scene.render();
  });

  if (shotMode) {
    const steps = Math.round(num('at', 1) / FIXED_DT);
    for (let i = 0; i < steps; i++) frame(FIXED_DT);
    for (let i = 0; i < 3; i++) frame(FIXED_DT);
    scene.physicsEnabled = false;
    const cam = scene.activeCamera!;
    setStatus(`shot ready  cam ${cam.name} ${cam.position.toString()} rot ${(cam as unknown as { rotation: Vector3 }).rotation?.toString()}  render ${engine.getRenderWidth()}x${engine.getRenderHeight()}  meshes ${scene.meshes.length} active ${scene.getActiveMeshes().length}  car ${player.vehicle.chassisMesh.position.toString()}  dust ${dusts[0].activeParticles} (ready ${dusts[0].isReady()})  lods ${cars.map((c) => c.lod).join(',')}`);
    return; // no render loop: the picture is this frame
  }

  if (reportMode) {
    await runReport({ engine, scene, look, rig, cars, dusts, player, autoInput, frame, measure, empty: empty!, carMs, worldMs });
    return;
  }

  setStatus('running');
  engine.runRenderLoop(() => frame(beginPhysicsFrame(scene)));
}

// ---------------------------------------------------------------------------
// Report

interface ReportCtx {
  engine: Engine;
  scene: Scene;
  look: LookRuntime;
  rig: ReturnType<typeof createCameraRig>;
  cars: GameCar[];
  dusts: WheelDust[];
  player: GameCar;
  autoInput: AutoInput;
  frame: (dt: number) => void;
  measure: (step: () => void) => FrameStats;
  empty: FrameStats;
  carMs: number[];
  worldMs: number;
}

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function runFrames(ctx: ReportCtx, n: number, after?: () => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    ctx.frame(FIXED_DT);
    after?.();
    if (i % 10 === 9) await yieldToBrowser();
  }
}

async function runReport(ctx: ReportCtx): Promise<void> {
  const { engine, scene, rig, cars, player, dusts } = ctx;
  const stats: Record<string, ReportValue> = {};
  const checks: LabReport['checks'] = [];
  const check = (id: string, value: ReportValue, target: string, pass: boolean): void => {
    checks.push({ id, value: typeof value === 'number' ? Math.round(value * 10000) / 10000 : value, target, pass });
  };
  let simSeconds = 0;

  stats['boot.worldMs'] = Math.round(ctx.worldMs);
  stats['boot.carMs'] = Math.round(ctx.carMs[0]);
  stats['boot.carMs.max'] = Math.round(Math.max(...ctx.carMs));
  cars.forEach((c, i) => (stats[`boot.carMs.${c.carId}`] = Math.round(ctx.carMs[i])));
  stats['empty.drawCalls'] = ctx.empty.drawCalls;
  stats['empty.triangles'] = ctx.empty.triangles;
  stats['empty.shadowDrawCalls'] = ctx.empty.shadowDrawCalls;
  stats['car.fullTriangles'] = player.fullTriangles;
  stats['car.vehicle'] = player.vehicle.modelName;

  // 1. Settle 2 s at rest (no input).
  setStatus('settling');
  await runFrames(ctx, 120);
  simSeconds += 2;
  {
    const v = player.vehicle;
    let hubError = 0;
    let groundError = 0;
    v.chassisMesh.computeWorldMatrix(true);
    v.visual.root.computeWorldMatrix(true);
    player.instance.root.computeWorldMatrix(true);
    for (let i = 0; i < 4; i++) {
      const hub = player.instance.hubNodes[i];
      hub.computeWorldMatrix(true);
      const p = hub.getAbsolutePosition();
      const w = v.wheelStates[i];
      hubError = Math.max(hubError, Vector3.Distance(p, w.position));
      groundError = Math.max(groundError, Math.abs(p.y - w.radius));
    }
    stats['rest.hubError'] = Math.round(hubError * 10000) / 10000;
    stats['rest.groundError'] = Math.round(groundError * 10000) / 10000;
    check('rest.hubError', hubError, '≤ 0.01 m (hub node vs wheelStates, max over wheels)', hubError <= 0.01);
    check('rest.wheelOnGround', groundError, '|hub y − tire radius − floor| ≤ 0.03 m', groundError <= 0.03);
    stats['rest.dustParticles'] = dusts[0].activeParticles;
  }

  // 2. Per-level cost of ONE car at rest: frame − empty frame.
  setStatus('lod');
  for (let i = 1; i < cars.length; i++) cars[i].instance.root.setEnabled(false);
  const recheck: FrameStats[] = [];
  {
    // Validate the empty baseline with every car hidden, same camera pose.
    player.instance.root.setEnabled(false);
    ctx.frame(FIXED_DT);
    recheck.push(ctx.measure(() => ctx.frame(FIXED_DT)));
    player.instance.root.setEnabled(true);
    stats['empty.recheck.drawCalls'] = recheck[0].drawCalls;
    stats['empty.recheck.triangles'] = recheck[0].triangles;
  }
  const level: FrameStats[] = [];
  for (const L of [0, 1, 2] as CarLodLevel[]) {
    player.lodOverride = L;
    await runFrames(ctx, 3);
    const f = ctx.measure(() => ctx.frame(FIXED_DT));
    level.push(f);
    const dcs = f.drawCalls - ctx.empty.drawCalls;
    const tris = f.triangles - ctx.empty.triangles;
    stats[`lod${L}.drawCalls`] = dcs;
    stats[`lod${L}.triangles`] = tris;
    stats[`lod${L}.shadowDrawCalls`] = f.shadowDrawCalls - ctx.empty.shadowDrawCalls;
    stats[`lod${L}.shadowTriangles`] = f.shadowTriangles - ctx.empty.shadowTriangles;
    stats[`lod${L}.carTriangles`] = Math.round(player.triangles);
  }
  const dc0 = level[0].drawCalls, dc1 = level[1].drawCalls, dc2 = level[2].drawCalls;
  check('lod.order', `${dc0 - ctx.empty.drawCalls} > ${dc1 - ctx.empty.drawCalls} > ${dc2 - ctx.empty.drawCalls}`, 'draw calls strictly falling 0 → 1 → 2', dc0 > dc1 && dc1 > dc2);
  const lod1 = dc1 - ctx.empty.drawCalls;
  const lod2 = dc2 - ctx.empty.drawCalls;
  check('lod1.drawCalls', lod1, '≤ 15 (car share incl. shadow pass; design 13–14)', lod1 <= 15);
  check('lod2.drawCalls', lod2, '≤ 12 (car share incl. shadow pass; design 11)', lod2 <= 12);
  const t0 = level[0].triangles - ctx.empty.triangles;
  const t2 = level[2].triangles - ctx.empty.triangles;
  check('lod2.triangles', t2 / Math.max(1, t0), '≤ 0.25 × lod0.triangles', t2 <= 0.25 * t0);

  // 3. All cars at the chosen level (by distance unless ?lod=).
  for (const car of cars) {
    car.instance.root.setEnabled(true);
    car.lodOverride = lodForce;
  }
  await runFrames(ctx, 3);
  const all = ctx.measure(() => ctx.frame(FIXED_DT));
  stats[`cars${cars.length}.drawCalls`] = all.drawCalls;
  stats[`cars${cars.length}.triangles`] = all.triangles;
  stats[`cars${cars.length}.lods`] = cars.map((c) => c.lod).join(',');

  // 4. Chase framing at rest.
  rig.setMode('chase');
  rig.snap();
  await runFrames(ctx, 2);
  const width = projectedWidth(scene, engine, player);
  check('camera.size', width, '24–36 % of the canvas width (chase, at rest, tire to tire)', width >= 0.24 && width <= 0.36);
  stats['camera.renderWidth'] = engine.getRenderWidth();
  stats['camera.renderHeight'] = engine.getRenderHeight();

  // 4b. The ground clamp really lifts the eye: a second rig over a 6 m cliff
  // behind the start (the lab floor is flat, so camera.aboveGround alone
  // cannot fail).
  {
    const cliff = createCameraRig(scene, engine.getRenderingCanvas()!, { mode: 'chase', heightAt: (_x, z) => (z < -1 ? 6 : 0) });
    cliff.setSubject(player.vehicle);
    cliff.snap();
    const eyeY = cliff.eye.y;
    cliff.dispose();
    scene.activeCamera = rig.camera;
    check('camera.groundClamp', eyeY, 'eye ≥ 6.8 m over a 6 m cliff behind the car (ground + minClearance 0.8)', eyeY >= 6.8 - 1e-6);
  }

  // 4c. LOD by distance with hysteresis (a sweep through CarLod.choose; the
  // per-level costs above use overrides).
  {
    const lod: CarLod = (player as unknown as { lodState: CarLod }).lodState;
    const saved = lod.override;
    lod.override = null;
    const [d0, d1] = lod.distances;
    const seq: string[] = [];
    let ok = true;
    const expect = (d: number, want: number): void => {
      const got = lod.choose(d);
      seq.push(`${d.toFixed(1)}:${got}`);
      if (got !== want) ok = false;
    };
    expect(0, 0);
    expect(d0 * 1.03, 0); // inside the band: stays
    expect(d0 * 1.06, 1);
    expect(d0 * 0.97, 1); // inside the band: stays
    expect(d1 * 1.06, 2);
    expect(d1 * 0.97, 2);
    expect(d1 * 0.94, 1);
    expect(d0 * 0.94, 0);
    lod.override = saved;
    lod.choose(0);
    stats['lod.sweep'] = seq.join(' ');
    check('lod.byDistance', ok ? 'ok' : seq.join(' '), 'switches at d·1.05 going out, d·0.95 coming in (14 / 45 m)', ok);
  }

  // 4d. The followed car stays at full detail in the high view (the high eye
  // is ~18 m away, past the 14 m LOD 0 distance).
  {
    player.lodOverride = null;
    rig.setMode('high');
    rig.snap();
    await runFrames(ctx, 2);
    const dist = rig.focusDistance;
    stats['high.subjectDistance'] = Math.round(dist * 100) / 100;
    check('lod.followedFull', `lod ${player.lod} at ${dist.toFixed(1)} m`, 'followed car at LOD 0 in the high view', player.lod === 0);
    rig.setMode('chase');
    rig.snap();
    player.lodOverride = lodForce;
    await runFrames(ctx, 2);
  }

  // 5. Drive: the scripted input (auto=1) for `seconds`.
  const seconds = num('seconds', 8);
  setStatus(`driving ${seconds} s`);
  ctx.autoInput.enabled = auto;
  ctx.autoInput.t = 0;
  let framed = 0;
  let frames = 0;
  let minEye = Infinity;
  let maxSpeed = 0;
  let maxY = 0;
  let dustDraw: number | null = null;
  let sizeSum = 0;
  let sizeN = 0;
  let sizeMin = Infinity;
  const tDrive = performance.now();
  const steps = Math.round(seconds / FIXED_DT);
  await runFrames(ctx, steps, () => {
    frames++;
    // Size at racing speed (every 5th frame above 15 m/s).
    if (frames % 5 === 0 && Math.abs(player.vehicle.forwardSpeed) > 15) {
      const w = projectedWidth(scene, engine, player);
      sizeSum += w;
      sizeN++;
      sizeMin = Math.min(sizeMin, w);
    }
    minEye = Math.min(minEye, rig.eye.y);
    const root = player.instance.root.computeWorldMatrix(true).m;
    const p = project(scene, engine, root[12], root[13] + 0.6, root[14]);
    if (p.x >= 0.2 && p.x <= 0.8 && p.y >= 0.2 && p.y <= 0.8) framed++;
    maxSpeed = Math.max(maxSpeed, Math.abs(player.vehicle.forwardSpeed));
    maxY = Math.max(maxY, player.vehicle.chassisMesh.position.y);
  });
  const driveMs = performance.now() - tDrive;
  simSeconds += seconds;
  // Dust cost: the same frame with and without particle rendering.
  if (dusts[0].activeParticles > 0) {
    const on = ctx.measure(() => ctx.frame(FIXED_DT));
    scene.particlesEnabled = false;
    const off = ctx.measure(() => ctx.frame(FIXED_DT));
    scene.particlesEnabled = true;
    dustDraw = on.drawCalls - off.drawCalls;
  }
  stats['dust.drawCalls'] = dustDraw;
  stats['dust.particles'] = dusts[0].activeParticles;
  const share = frames ? framed / frames : 0;
  check('camera.framed', share, '≥ 0.95 of frames with the car in the central 60 % (chase' + (auto ? ', auto=1)' : ', no input)'), share >= 0.95);
  check('camera.aboveGround', minEye, 'eye ≥ 0.8 m above the floor on every frame', minEye >= 0.8);
  if (auto) {
    const mean = sizeN ? sizeSum / sizeN : 0;
    stats['camera.sizeAtSpeed.samples'] = sizeN;
    stats['camera.sizeAtSpeed.min'] = sizeN ? Math.round(sizeMin * 10000) / 10000 : null;
    check('camera.sizeAtSpeed', mean, 'mean 27–36 % of the width above 15 m/s (chase, auto=1; about a third, as in the vision)', sizeN > 0 && mean >= 0.27 && mean <= 0.36);
  }

  {
    const end = player.vehicle.chassisMesh.position;
    stats['drive.endX'] = Math.round(end.x * 10) / 10;
    stats['drive.endZ'] = Math.round(end.z * 10) / 10;
  }

  // 6. Respawn: place() back at the start, snap(), and the eye is at the
  // settled pose behind the car (distance + height of CAMERA_TUNING.chase,
  // width-normalised, so only the shape is checked: straight behind, level).
  {
    player.place(new Vector3(0, 0, 0), 0);
    ctx.frame(FIXED_DT);
    rig.snap();
    const p = player.vehicle.chassisMesh.position;
    const e = rig.eye;
    const behind = p.z - e.z;
    const side = Math.abs(e.x - p.x);
    const ok = Math.hypot(p.x, p.z) < 0.3 && side < 0.05 && behind > 3 && behind < 8 && Math.abs(e.y - CAMERA_TUNING.chase.height) < 0.3;
    check('camera.snapAfterPlace', `car (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) eye side ${side.toFixed(3)} behind ${behind.toFixed(2)} up ${e.y.toFixed(2)}`, 'car back at the start, eye straight behind at chase height', ok);
  }
  stats['drive.frames'] = frames;
  stats['drive.maxSpeed'] = Math.round(maxSpeed * 100) / 100;
  stats['drive.maxChassisY'] = Math.round(maxY * 100) / 100;
  stats['drive.msPerFrame'] = Math.round((driveMs / Math.max(1, frames)) * 100) / 100;

  const lines: string[] = [];
  for (const [k, v] of Object.entries(stats)) lines.push(`${k.padEnd(26)} ${v}`);
  for (const c of checks) lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(22)} ${c.value}  (${c.target})`);
  const report: LabReport = {
    page: 'drive-lab',
    query: location.search.replace(/^\?/, ''),
    totals: { simSeconds },
    scorecard: { text: lines.join('\n') },
    errors: [],
    stats,
    checks,
  };
  if (resultEl) resultEl.textContent = JSON.stringify(report);
  setStatus('done');
  document.title = 'done';
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  setStatus(`error: ${message}`);
  // Visible outside debug / report too: a boot error must not leave a blank page.
  document.body.classList.add('failed');
  if (reportMode && resultEl) {
    const report: LabReport = {
      page: 'drive-lab',
      query: location.search.replace(/^\?/, ''),
      totals: { simSeconds: 0 },
      scorecard: { text: `fatal: ${message}` },
      errors: [],
      fatal: message,
      stats: {},
      checks: [],
    };
    resultEl.textContent = JSON.stringify(report);
    document.title = 'error';
  } else {
    console.error(e);
  }
});
