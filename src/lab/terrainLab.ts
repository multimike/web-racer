import { ArcRotateCamera, Engine, HavokPlugin, Quaternion, Scene, ShaderMaterial, UniversalCamera, Vector3, VertexBuffer } from '@babylonjs/core';
import type { AbstractMesh, Camera, Mesh } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { carContact, instantiateCar } from '../assets/assemble';
import { loadAsset } from '../assets/registry';
import type { CarAsset } from '../assets/types';
import { GAME_GRAVITY } from '../car/rig';
import { CAMERA_TUNING, followVerticalFov } from '../game/camera/CameraRig';
import type { FrameStats, LabReport, ReportValue } from '../game/contracts/report';
import type { FlatArena, TerrainSurface } from '../game/contracts/terrain';
import type { GroundQuery, WorldData } from '../game/contracts/world';
import { LOOK_VIEWS, createLook } from '../gfx/look/lighting';
import type { LookRuntime, ShadowQuality } from '../gfx/look/lighting';
import { createFlatArena, createTerrainSurface, kerbAt } from '../render/terrain';
import { ROAD_STATIONS, ROW } from '../render/terrain/paving';
import { generateTerrain } from '../terrain/generateTerrain';
import { mulberry32 } from '../terrain/noise';
import { TrackFrame } from '../world/trackFrame';

/**
 * terrain-lab: the game's ground on its own — terrain chunks, paving,
 * Havok heightfield, or the flat arena — posed with the game's still cameras.
 *
 *   seed=<n>  view=chase|high|top|xr|free  s=<arc m>|village|villageEdge
 *   lat=<m> (sideways, + = left)  yaw=<deg> (added to the track heading)
 *   pitch=<deg> (overrides the look-down angle)  dist=<m>
 *   size=256|512  chunks=<n>  shadows=off|1024|2048  paving=0  flat=1
 *   car=1 (static reef-rocket at s, display only)  debug=1..7
 *   shot=1 (synchronous build + 3 frames, no loop)  report=1
 *
 * chase / high: the game's follow cameras standing still behind the track
 * point, heading along the track (CAMERA_TUNING, read only); top: straight
 * down from 260 m; xr: eye (0, 85, −85) looking at the origin; free: an
 * orbit camera around the track point.
 */

const params = new URLSearchParams(location.search);
const shotMode = params.get('shot') === '1';
const reportMode = params.get('report') === '1';
const flatMode = params.get('flat') === '1';
const view = (['chase', 'high', 'top', 'xr', 'free'].includes(params.get('view') ?? '') ? params.get('view') : 'chase') as View;
const seed = Math.max(1, Math.floor(num('seed', 1)));
const shadowParam = params.get('shadows') ?? '2048';
const shadowQuality: ShadowQuality = shadowParam === 'off' ? 'off' : shadowParam === '1024' ? 1024 : 2048;
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
if (shotMode || reportMode) document.body.classList.add('quiet');

type View = 'chase' | 'high' | 'top' | 'xr' | 'free';

function num(key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

const DEG = Math.PI / 180;

interface Pose {
  eye: Vector3;
  /** Euler rotation (UniversalCamera) */
  rot: Vector3;
  fov: number;
  /** Where the shadow map is centred and the car would stand. */
  focus: Vector3;
  /** Car pose on the ground. */
  car: { x: number; y: number; z: number; tx: number; tz: number };
  diorama: boolean;
}

interface World {
  ground: GroundQuery;
  frame: TrackFrame | null;
  data: WorldData | null;
}

/** Arc length from the `s` parameter: a number (wrapped), or the village shorthands. */
function arcOf(world: World, raw: string | null): number {
  const f = world.frame;
  if (!f || !world.data) return 0;
  const v = world.data.plan.village;
  if (raw === 'village') return f.wrap(v.s0 + 20);
  if (raw === 'villageEdge') return f.wrap(v.s0 - 6);
  const n = Number(raw ?? 0);
  return f.wrap(Number.isFinite(n) ? n : 0);
}

function lookAt(eye: Vector3, tx: number, ty: number, tz: number): Vector3 {
  const dx = tx - eye.x;
  const dy = ty - eye.y;
  const dz = tz - eye.z;
  return new Vector3(Math.atan2(-dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0);
}

function poseFor(world: World, v: View, s: number, aspect: number): Pose {
  const g = world.ground;
  let px = 0;
  let pz = 0;
  let tx = 0;
  let tz = 1;
  if (world.frame) {
    const p = world.frame.at(s);
    px = p.x;
    pz = p.z;
    tx = p.tx;
    tz = p.tz;
  }
  const lat = num('lat', 0);
  px += -tz * lat;
  pz += tx * lat;
  const base = g.heightAt(px, pz);
  // The car stands along the track; `yaw` turns only the camera round it.
  const car = { x: px, y: base, z: pz, tx, tz };
  const heading = Math.atan2(tx, tz) + num('yaw', 0) * DEG;
  const sy = Math.sin(heading);
  const cy = Math.cos(heading);
  const focus = new Vector3(px, base, pz);

  if (v === 'chase' || v === 'high') {
    const c = CAMERA_TUNING.chase;
    const h = CAMERA_TUNING.high;
    const dist = num('dist', v === 'chase' ? c.distance : h.distance);
    const height = v === 'chase' ? c.height : h.height;
    const lookUp = v === 'chase' ? c.lookUp : 0;
    const lookAhead = v === 'chase' ? c.lookAhead : h.lookAhead;
    const ex = px - sy * dist;
    const ez = pz - cy * dist;
    const ey = Math.max(base + height, g.heightAt(ex, ez) + c.minClearance);
    const eye = new Vector3(ex, ey, ez);
    const rot = lookAt(eye, px + sy * lookAhead, base + lookUp, pz + cy * lookAhead);
    if (params.has('pitch')) rot.x = num('pitch', 0) * DEG;
    return { eye, rot, fov: followVerticalFov(v === 'chase' ? c.fov : h.fov, aspect), focus, car, diorama: false };
  }
  if (v === 'top') {
    const eye = new Vector3(0, num('dist', 260), 0);
    // Rotation set directly: setTarget straight down is a gimbal case.
    return { eye, rot: new Vector3(Math.PI / 2, 0, 0), fov: 2 * Math.atan(108 / eye.y), focus: Vector3.Zero(), car, diorama: true };
  }
  // xr (and the start of free): the diorama eye.
  const x = CAMERA_TUNING.xr;
  const k = params.has('dist') ? num('dist', 120) / Math.hypot(x.back, x.eyeHeight) : 1;
  const eye = new Vector3(0, x.eyeHeight * k, -x.back * k);
  return { eye, rot: lookAt(eye, 0, 0, 0), fov: 0.8, focus: Vector3.Zero(), car, diorama: true };
}

/** shot=1 must give the same picture every run. */
function seedMathRandom(s: number): void {
  let x = s >>> 0 || 1;
  Math.random = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

interface DrawCounter {
  current: number;
  fetchNewFrame(): void;
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

/** Materials that failed to compile do not draw: name them. */
function notReady(scene: Scene): string[] {
  const out: string[] = [];
  for (const mesh of scene.meshes) {
    const mat = mesh.material;
    if (!(mat instanceof ShaderMaterial) || !mesh.isEnabled() || !mesh.isVisible) continue;
    if (mat.isReady(mesh)) continue;
    const effect = mesh.subMeshes?.[0]?.effect ?? mat.getEffect();
    out.push(`${mesh.name} / ${mat.name}: ${effect?.getCompilationError() || 'not ready'}`);
  }
  return out;
}

async function main(): Promise<void> {
  if (shotMode) seedMathRandom(0x2545f491);
  const tBoot = performance.now();
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: shotMode });
  // Headless runs: compile shaders synchronously (an async compile reports
  // back after the virtual clock has run out).
  if (shotMode || reportMode) engine.getCaps().parallelShaderCompile = undefined;
  // Report numbers at the vision's frame shape, whatever window Chrome has.
  if (reportMode) engine.setSize(1672, 941);
  const scene = new Scene(engine);
  if (shotMode || reportMode) scene.useConstantAnimationDeltaTime = true;

  const havok = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -GAME_GRAVITY, 0), new HavokPlugin(false, havok));

  const startDiorama = view === 'xr' || view === 'top';
  const viewLook = startDiorama ? LOOK_VIEWS.diorama : LOOK_VIEWS.chase;
  const look = createLook(scene, { shadowQuality, shadowRegion: viewLook.shadowRegion, sky: true, config: { fogDensity: viewLook.fogDensity } });
  look.debugView = Math.max(0, Math.min(7, Math.floor(num('debug', 0))));

  setStatus('generating world');
  let surface: TerrainSurface | null = null;
  let arena: FlatArena | null = null;
  let data: WorldData | null = null;
  let generateMs = 0;
  let world: World;
  if (flatMode) {
    arena = createFlatArena(scene);
    world = { ground: arena.ground, frame: null, data: null };
  } else {
    const t0 = performance.now();
    data = generateTerrain(seed);
    generateMs = performance.now() - t0;
    setStatus('building surface');
    // The ground kit wants a power of two (>= 32): anything else falls back
    // to 512 instead of failing the page.
    const sizeParam = num('size', 512);
    const textureSize = [64, 128, 256, 512, 1024].includes(sizeParam) ? sizeParam : 512;
    if (textureSize !== sizeParam) console.warn(`[terrain-lab] size=${params.get('size')} is not 64|128|256|512|1024: using 512`);
    surface = createTerrainSurface(scene, data, {
      groundTextureSize: textureSize,
      chunks: Math.max(1, Math.floor(num('chunks', 4))),
      paving: params.get('paving') !== '0',
    });
    world = { ground: surface.ground, frame: new TrackFrame(data.track, data.heightfield.size), data };
  }
  const buildMs = performance.now() - tBoot;

  // Cameras: one still camera for every posed view, an orbit camera for free.
  const still = new UniversalCamera('labCam', new Vector3(0, 3, -6), scene);
  still.rotationQuaternion = null;
  still.minZ = 0.3;
  still.maxZ = 1000;
  const aspect = (): number => engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
  const applyPose = (p: Pose): void => {
    still.position.copyFrom(p.eye);
    still.rotation.copyFrom(p.rot);
    still.fov = p.fov;
    still.minZ = p.diorama ? 0.5 : 0.3;
    const vl = p.diorama ? LOOK_VIEWS.diorama : LOOK_VIEWS.chase;
    look.shadows.region = vl.shadowRegion;
    look.config.fogDensity = vl.fogDensity;
    look.shadows.setFocus(p.focus);
  };
  const s0 = arcOf(world, params.get('s'));
  const pose = poseFor(world, view === 'free' ? 'chase' : view, s0, aspect());
  applyPose(pose);
  let camera: Camera = still;
  if (view === 'free') {
    const orbit = new ArcRotateCamera('labOrbit', -Math.PI / 2 - Math.atan2(pose.car.tx, pose.car.tz), (90 - num('pitch', 30)) * DEG, num('dist', 25), pose.focus.clone(), scene);
    orbit.minZ = 0.3;
    orbit.maxZ = 1000;
    orbit.wheelPrecision = 5;
    orbit.attachControl(canvas, true);
    camera = orbit;
  } else if (!shotMode && !reportMode) {
    still.attachControl(canvas, true);
  }
  scene.activeCamera = camera;

  // car=1: a static reef-rocket at s (display only: no body in the physics
  // world). Never in report mode, so the frame numbers are the ground's.
  if (params.get('car') === '1' && !reportMode) {
    setStatus('loading car');
    const asset = (await loadAsset('reef-rocket')) as CarAsset;
    const car = instantiateCar(scene, asset);
    const c = pose.car;
    const up = new Vector3();
    world.ground.normalAt(c.x, c.z, up);
    const fwd = new Vector3(c.tx, 0, c.tz);
    fwd.subtractInPlace(up.scale(Vector3.Dot(fwd, up))).normalize();
    const right = Vector3.Cross(up, fwd).normalize();
    car.root.position.set(c.x, c.y, c.z);
    car.root.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(right, up, fwd);
    look.contacts = [carContact(car)];
  }

  window.addEventListener('resize', () => {
    engine.resize();
    if (reportMode) engine.setSize(1672, 941);
    // No render loop in shot mode, and a resize clears the canvas (headless
    // Chrome resizes the viewport for its screenshot): draw the frame again.
    if (shotMode) scene.render();
  });
  (window as unknown as { __terrain: unknown }).__terrain = { engine, scene, look, surface, arena, data, world, CAMERA_TUNING };

  if (reportMode) {
    await runReport({ engine, scene, look, still, world, surface, arena, data, applyPose, aspect, generateMs, buildMs });
    return;
  }

  // Render until every material is compiled (synchronous in shot mode), then
  // three frames: shadow map, contact uniforms and the picture.
  for (let i = 0; i < 10; i++) {
    scene.render();
    if (notReady(scene).length === 0) break;
  }
  for (let i = 0; i < 3; i++) scene.render();
  const broken = notReady(scene);
  for (const b of broken) console.error(`[terrain-lab] material not ready: ${b}`);
  const st = surface?.stats;
  const info =
    `terrain-lab seed ${seed} view ${view} s ${s0.toFixed(1)}  build ${buildMs.toFixed(0)} ms (generate ${generateMs.toFixed(0)})` +
    (st ? `\ntextures ${st.textureMs.toFixed(0)} ms, chunks ${st.meshMs.toFixed(0)} ms, paving ${st.pavingMs.toFixed(0)} ms, physics ${st.physicsMs.toFixed(0)} ms; terrain ${st.terrainTriangles} tris, paving ${st.pavingTriangles} tris` : '') +
    `\nactive meshes ${scene.getActiveMeshes().length}`;
  setStatus(info);
  if (shotMode) return;
  engine.runRenderLoop(() => scene.render());
}

// ---------------------------------------------------------------------------
// Report

interface ReportCtx {
  engine: Engine;
  scene: Scene;
  look: LookRuntime;
  still: UniversalCamera;
  world: World;
  surface: TerrainSurface | null;
  arena: FlatArena | null;
  data: WorldData | null;
  applyPose: (p: Pose) => void;
  aspect: () => number;
  generateMs: number;
  buildMs: number;
}

async function runReport(ctx: ReportCtx): Promise<void> {
  const { engine, scene, look, world, surface, data } = ctx;
  const report: LabReport = {
    page: 'terrain-lab',
    query: location.search,
    totals: { simSeconds: 0 },
    scorecard: { text: '' },
    errors: [],
    stats: {},
    checks: [],
  };
  const stats = report.stats;
  const check = (id: string, value: ReportValue, target: string, pass: boolean): void => {
    report.checks.push({ id, value, target, pass });
  };
  const dc = (engine as unknown as { _drawCalls: DrawCounter })._drawCalls;
  const measure = (): FrameStats => {
    scene.render();
    scene.render();
    dc.fetchNewFrame();
    scene.render();
    const shadow = shadowPass(look);
    return { drawCalls: dc.current, triangles: Math.round(scene.getActiveIndices() / 3), shadowDrawCalls: shadow.drawCalls, shadowTriangles: Math.round(shadow.triangles) };
  };
  const record = (name: string, f: FrameStats): void => {
    stats[`frame.${name}.drawCalls`] = f.drawCalls;
    stats[`frame.${name}.triangles`] = f.triangles;
    stats[`frame.${name}.shadowDrawCalls`] = f.shadowDrawCalls;
    stats[`frame.${name}.shadowTriangles`] = f.shadowTriangles;
  };

  stats.seed = seed;
  stats['boot.generateMs'] = round(ctx.generateMs);
  stats['boot.buildMs'] = round(ctx.buildMs);
  stats['render.width'] = engine.getRenderWidth();
  stats['render.height'] = engine.getRenderHeight();

  // Compile everything first (synchronous), so no frame below misses a mesh.
  ctx.applyPose(poseFor(world, 'xr', 0, ctx.aspect()));
  for (let i = 0; i < 10; i++) {
    scene.render();
    if (notReady(scene).length === 0) break;
  }
  for (const b of notReady(scene)) report.errors.push(`material not ready: ${b}`);

  const lines: string[] = [];
  if (surface && data && world.frame) {
    const st = surface.stats;
    for (const [k, v] of Object.entries(st)) stats[`surface.${k}`] = typeof v === 'number' ? round(v) : v;
    stats['ground.generationMs'] = round(surface.groundTextures.generationMs);
    stats['ground.uploadMs'] = round(surface.groundTextures.uploadMs);
    stats['ground.size'] = surface.groundTextures.size;
    const frame = world.frame;
    const villageS = frame.wrap(data.plan.village.s0 + 20);
    stats['track.length'] = round(frame.length);
    stats['village.s'] = round(villageS);

    // Frames: the game's cameras standing still.
    setStatus('frames');
    const chunkSet = new Set<AbstractMesh>(surface.terrain);
    // Chunks among the meshes the last rendered frame selected (frustum culled).
    const chunksActive = (): number => {
      let count = 0;
      const active = scene.getActiveMeshes();
      for (let i = 0; i < active.length; i++) if (chunkSet.has(active.data[i])) count++;
      return count;
    };
    ctx.applyPose(poseFor(world, 'chase', 0, ctx.aspect()));
    const chase = measure();
    const chunksDrawn = chunksActive();
    record('chase', chase);
    stats['frame.chase.terrainChunks'] = chunksDrawn;
    ctx.applyPose(poseFor(world, 'chase', villageS, ctx.aspect()));
    const chaseVillage = measure();
    record('chaseVillage', chaseVillage);
    stats['frame.chaseVillage.terrainChunks'] = chunksActive();
    ctx.applyPose(poseFor(world, 'high', villageS, ctx.aspect()));
    const high = measure();
    record('high', high);
    stats['frame.high.terrainChunks'] = chunksActive();
    // A pose that should see a different set: chase half way round the loop.
    ctx.applyPose(poseFor(world, 'chase', frame.length / 2, ctx.aspect()));
    record('chaseHalf', measure());
    stats['frame.chaseHalf.terrainChunks'] = chunksActive();
    ctx.applyPose(poseFor(world, 'xr', 0, ctx.aspect()));
    const xr = measure();
    record('xr', xr);
    stats['frame.xr.terrainChunks'] = chunksActive();

    // Physics vs heightmap: 200 seeded downward rays.
    setStatus('physics alignment');
    const hf = data.heightfield;
    const pe = scene.getPhysicsEngine();
    let hits = 0;
    let sum = 0;
    let max = 0;
    if (pe && 'raycast' in pe) {
      const rand = mulberry32(0x7e44a1 + seed);
      const half = hf.size / 2 - 2;
      for (let i = 0; i < 200; i++) {
        const x = (rand() * 2 - 1) * half;
        const z = (rand() * 2 - 1) * half;
        const r = pe.raycast(new Vector3(x, 60, z), new Vector3(x, -60, z));
        if (!r.hasHit) continue;
        const err = Math.abs(r.hitPointWorld.y - hf.getHeight(x, z));
        hits++;
        sum += err;
        max = Math.max(max, err);
      }
    }
    const mean = hits ? sum / hits : NaN;
    stats['physics.hits'] = hits;
    stats['physics.meanErr'] = round(mean, 4);
    stats['physics.maxErr'] = round(max, 4);
    check('physics.alignment', `mean ${mean.toFixed(4)} max ${max.toFixed(4)} hits ${hits}`, 'mean <= 0.01 m, max <= 0.25 m, hits >= 190', mean <= 0.01 && max <= 0.25 && hits >= 190);

    // Ribbon and pads against the heightfield.
    setStatus('paving checks');
    const ribbon = surface.paving.find((m) => m.name === 'pavingRibbon') ?? null;
    const pads = surface.paving.find((m) => m.name === 'pavingPads') ?? null;
    if (ribbon) {
      const pos = ribbon.getVerticesData(VertexBuffer.PositionKind)!;
      const col = ribbon.getVerticesData(VertexBuffer.ColorKind)!;
      const idx = ribbon.getIndices()!;
      let lo = Infinity;
      let hi = -Infinity;
      let roadVerts = 0;
      for (let v = 0; v < pos.length / 3; v++) {
        if (col[v * 4] > 0.5) continue;
        const d = pos[v * 3 + 1] - hf.getHeight(pos[v * 3], pos[v * 3 + 2]);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
        roadVerts++;
      }
      stats['ribbon.roadVertices'] = roadVerts;
      check('ribbon.clearance', `${lo.toFixed(4)}..${hi.toFixed(4)}`, 'every road vertex 0.02..0.09 m above the heightfield', lo >= 0.02 && hi <= 0.09);
      // Dense cover: the order-7 barycentric lattice of every triangle (the
      // centroid and edge midpoints are not on it; the fit probes the
      // order-8 lattice, which shares only the corners with it).
      const nor = ribbon.getVerticesData(VertexBuffer.NormalKind)!;
      const road = denseCover(pos, idx, hf, (a, b, c) => col[a * 4] < 0.5 && col[b * 4] < 0.5 && col[c * 4] < 0.5);
      stats['ribbon.roadTriangles'] = road.tris;
      stats['ribbon.coverWorstAt'] = road.at;
      check('ribbon.cover', round(road.min, 4), '33 interior + edge points (order-7 lattice) of every road triangle >= 0.005 m above the heightfield', road.min >= 0.005);
      // Kerb tops (kind 1, all three normals up: the lip and skirt faces
      // carry sideways normals).
      const isTop = (a: number, b: number, c: number): boolean => col[a * 4] > 0.5 && nor[a * 3 + 1] > 0.5 && nor[b * 3 + 1] > 0.5 && nor[c * 3 + 1] > 0.5;
      const kerbTop = denseCover(pos, idx, hf, isTop);
      stats['kerbs.topTriangles'] = kerbTop.tris;
      stats['kerbs.topCoverWorstAt'] = kerbTop.at;
      check('kerbs.topCover', round(kerbTop.min, 4), 'order-7 lattice of every kerb-top triangle >= 0.005 m above the heightfield', kerbTop.min >= 0.005);
      // Flush kerbs: a threshold row ON the pad they front, on any slope.
      if (pads) {
        const padHeight = padHeightLookup(pads);
        let worstFlush = Infinity;
        let flushAt = '';
        let samples = 0;
        forLattice(pos, idx, (a, b, c) => isTop(a, b, c) && col[a * 4 + 2] > 0.75 && col[b * 4 + 2] > 0.75 && col[c * 4 + 2] > 0.75, (x, y, z) => {
          for (const h of padHeight(x, z)) {
            samples++;
            if (y - h < worstFlush) {
              worstFlush = y - h;
              flushAt = `${x.toFixed(1)},${z.toFixed(1)}`;
            }
          }
        });
        stats['kerbs.flushSamplesOverPad'] = samples;
        stats['kerbs.flushWorstAt'] = flushAt;
        check('kerbs.flushOverPad', samples ? round(worstFlush, 4) : 'no flush kerb over a pad', 'flush kerb tops >= 0.005 m above the pad under them (order-7 lattice)', samples === 0 || worstFlush >= 0.005);
        // Every kerb style against any pad it meets (pads are cut away under
        // the kerbs, so they meet along the outer edge only).
        let worstKerb = Infinity;
        let kerbSamples = 0;
        forLattice(pos, idx, isTop, (x, y, z) => {
          for (const h of padHeight(x, z)) {
            kerbSamples++;
            worstKerb = Math.min(worstKerb, y - h);
          }
        });
        stats['kerbs.samplesOverPad'] = kerbSamples;
        check('kerbs.overPad', kerbSamples ? round(worstKerb, 4) : 'no kerb over a pad', 'every kerb top (any style) >= 0.005 m above any pad under it (order-7 lattice)', kerbSamples === 0 || worstKerb >= 0.005);
        // Pads must not reach under the road or the kerbs (they are cut away
        // there): order-7 lattice points of pad triangles strictly inside a
        // road or kerb-top triangle.
        const insideRibbon = triLookup(pos, idx, (a, b, c) => (col[a * 4] < 0.5 && col[b * 4] < 0.5 && col[c * 4] < 0.5) || isTop(a, b, c));
        const pp = pads.getVerticesData(VertexBuffer.PositionKind)!;
        let under = 0;
        let underAt = '';
        forLattice(pp, pads.getIndices()!, () => true, (x, _y, z) => {
          if (insideRibbon(x, z, 1e-3).length) {
            if (!under) underAt = `${x.toFixed(1)},${z.toFixed(1)}`;
            under++;
          }
        });
        stats['pads.underRoadAt'] = underAt;
        check('pads.offRoad', under, '0 pad lattice points (order 7) inside a road or kerb-top triangle', under === 0);
      }
      // Flush kerbs are dropped kerbs: their top at the road edge stands at
      // most 0.03 m over the road edge (the brief's lip is 0).
      {
        let worstLip = 0;
        let lipAt = '';
        let rows = 0;
        const rowsAll = pos.length / 3 / ROW;
        for (let r = 0; r < rowsAll; r++) {
          for (let side = 0; side < 2; side++) {
            const o = r * ROW + ROAD_STATIONS + side * 6;
            if (col[(o + 2) * 4 + 2] <= 0.75) continue;
            rows++;
            const lip = pos[(o + 1) * 3 + 1] - pos[o * 3 + 1];
            if (lip > worstLip) {
              worstLip = lip;
              lipAt = `${pos[o * 3].toFixed(1)},${pos[o * 3 + 2].toFixed(1)}`;
            }
          }
        }
        stats['kerbs.flushRows'] = rows;
        stats['kerbs.flushLipWorstAt'] = lipAt;
        check('kerbs.flushLip', round(worstLip, 4), 'flush kerb top at the road edge <= 0.03 m over the road edge', worstLip <= 0.03);
      }
    } else {
      check('ribbon.clearance', null, 'ribbon present', false);
      check('ribbon.cover', null, 'ribbon present', false);
    }
    if (pads) {
      const pos = pads.getVerticesData(VertexBuffer.PositionKind)!;
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < pos.length / 3; v++) {
        const d = pos[v * 3 + 1] - hf.getHeight(pos[v * 3], pos[v * 3 + 2]);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      stats['pads.vertices'] = pos.length / 3;
      stats['pads.triangles'] = pads.getTotalIndices() / 3;
      check('pads.clearance', `${lo.toFixed(4)}..${hi.toFixed(4)}`, 'every pad vertex 0.02..0.09 m above the heightfield', lo >= 0.02 && hi <= 0.09);
      const padCover = denseCover(pos, pads.getIndices()!, hf, () => true);
      stats['pads.coverWorstAt'] = padCover.at;
      check('pads.cover', round(padCover.min, 4), 'order-7 lattice of every pad and marking triangle >= 0.02 m above the heightfield', padCover.min >= 0.02);
      const tj = tJunctions(pos, pads.getIndices()!, pads.getVerticesData(VertexBuffer.ColorKind)!);
      stats['pads.tJunctionMaxGap'] = round(tj.maxGap, 4);
      stats['pads.tJunctionAt'] = tj.at;
      check('pads.tJunctions', tj.count, '0 pad vertices inside an edge of a triangle of the same pad with a vertical gap > 1 mm (open seams)', tj.count === 0);
    } else {
      check('pads.clearance', data.plan.pads.length === 0 ? 'no pads' : 'pads missing', 'pad mesh present when the plan has pads', data.plan.pads.length === 0);
    }
    stats['pads.count'] = data.plan.pads.length;
    if (ribbon) stats['ribbon.triangles'] = ribbon.getTotalIndices() / 3;

    let missing = 0;
    for (let i = 0; i < frame.n; i++) {
      for (const side of [1, -1] as const) if (!kerbAt(frame, data.plan.road.kerbs, frame.s[i], side)) missing++;
    }
    check('kerbs.cover', missing, '0 (point, side) pairs without a kerb section', missing === 0);
    check('terrain.triangles', st.terrainTriangles, '= 130050', st.terrainTriangles === 130050);
    check('paving.meshes', surface.paving.length, '<= 2', surface.paving.length <= 2);
    // The brief's numbers are for the default 4 × 4 chunks; another `chunks=`
    // scales them (10 of 16 → the same share; 16 chunks + 4 → chunks² + 4).
    const chunkCount = surface.terrain.length;
    const chaseChunkMax = chunkCount === 16 ? 10 : Math.ceil((10 / 16) * chunkCount);
    const xrDrawMax = chunkCount === 16 ? 20 : chunkCount + 4;
    check('frame.chase.terrainChunks', chunksDrawn, `<= ${chaseChunkMax} of ${chunkCount} chunks in the chase pose at s = 0`, chunksDrawn <= chaseChunkMax);
    check('frame.xr.drawCalls', xr.drawCalls, `<= ${xrDrawMax}`, xr.drawCalls <= xrDrawMax);

    lines.push(
      `terrain-lab seed ${seed}  size ${surface.groundTextures.size}px  track ${frame.length.toFixed(1)} m`,
      `build: generate ${ctx.generateMs.toFixed(0)} ms, textures ${st.textureMs.toFixed(0)} ms, chunks ${st.meshMs.toFixed(0)} ms, paving ${st.pavingMs.toFixed(0)} ms, physics ${st.physicsMs.toFixed(0)} ms`,
      `triangles: terrain ${st.terrainTriangles}, paving ${st.pavingTriangles}; meshes ${st.meshes}`,
      `chase s=0:      ${chase.drawCalls} dc / ${chase.triangles} tris (chunks ${chunksDrawn})`,
      `chase village:  ${chaseVillage.drawCalls} dc / ${chaseVillage.triangles} tris`,
      `high village:   ${high.drawCalls} dc / ${high.triangles} tris`,
      `xr:             ${xr.drawCalls} dc / ${xr.triangles} tris`,
      `physics: ${hits} hits, mean ${mean.toFixed(4)} m, max ${max.toFixed(4)} m`,
    );
  } else if (ctx.arena) {
    ctx.applyPose(poseFor(world, 'chase', 0, ctx.aspect()));
    const chase = measure();
    record('chase', chase);
    check('arena.meshes', ctx.arena.meshes.length, '= 9 (floor, 4 walls, 3 ramps, wavy road)', ctx.arena.meshes.length === 9);
    lines.push(`flat arena: chase ${chase.drawCalls} dc / ${chase.triangles} tris`);
  }
  for (const c of report.checks) lines.push(`${c.pass ? 'ok  ' : 'FAIL'} ${c.id} = ${JSON.stringify(c.value)}  (${c.target})`);
  report.scorecard.text = lines.join('\n');
  if (resultEl) resultEl.textContent = JSON.stringify(report);
  setStatus('done');
  document.title = 'done';
}

/** Calls `visit` at the order-7 barycentric lattice points of every
 * triangle `pick` accepts, corners excluded (33 points per triangle). */
function forLattice(pos: ArrayLike<number>, idx: ArrayLike<number>, pick: (a: number, b: number, c: number) => boolean, visit: (x: number, y: number, z: number) => void): number {
  const N = 7;
  let tris = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (!pick(a, b, c)) continue;
    tris++;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N - i; j++) {
        const k = N - i - j;
        if (i === N || j === N || k === N) continue;
        const u = i / N;
        const v = j / N;
        const w = k / N;
        visit(pos[a * 3] * u + pos[b * 3] * v + pos[c * 3] * w, pos[a * 3 + 1] * u + pos[b * 3 + 1] * v + pos[c * 3 + 1] * w, pos[a * 3 + 2] * u + pos[b * 3 + 2] * v + pos[c * 3 + 2] * w);
      }
    }
  }
  return tris;
}

/** Lowest clearance over the heightfield on the order-7 lattice. */
function denseCover(pos: ArrayLike<number>, idx: ArrayLike<number>, hf: WorldData['heightfield'], pick: (a: number, b: number, c: number) => boolean): { min: number; at: string; tris: number } {
  let min = Infinity;
  let at = '';
  const tris = forLattice(pos, idx, pick, (x, y, z) => {
    const d = y - hf.getHeight(x, z);
    if (d < min) {
      min = d;
      at = `${x.toFixed(1)},${z.toFixed(1)}`;
    }
  });
  return { min, at, tris };
}

/** Heights of the pad SURFACE (paint excluded) at a point: every pad
 * triangle containing it, through a 1 m bucket grid. */
function padHeightLookup(pads: Mesh): (x: number, z: number) => number[] {
  const pc = pads.getVerticesData(VertexBuffer.ColorKind)!;
  const find = triLookup(pads.getVerticesData(VertexBuffer.PositionKind)!, pads.getIndices()!, (a) => pc[a * 4 + 1] <= 0.5);
  return (x, z) => find(x, z, -1e-9);
}

/** Vertices lying inside an edge of a triangle they are not a corner of
 * (0.25 m buckets of vertices, 0.01 mm on-edge tolerance), counted where
 * the vertex is more than 1 mm off the edge's height: an open seam. Pad
 * surface and paint (colour y) are separate layers and only checked
 * against their own kind. */
function tJunctions(pos: ArrayLike<number>, idx: ArrayLike<number>, col: ArrayLike<number>): { count: number; maxGap: number; at: string } {
  const G = 0.25;
  const grid = new Map<string, number[]>();
  const nv = pos.length / 3;
  for (let v = 0; v < nv; v++) {
    const k = `${Math.floor(pos[v * 3] / G)},${Math.floor(pos[v * 3 + 2] / G)}`;
    const l = grid.get(k);
    if (l) l.push(v);
    else grid.set(k, [v]);
  }
  // Only within one pad (one welded component): where a path lies over a
  // forecourt the forecourt's cut edge meets the path's 6 mm lower, a step
  // between two surfaces, not a seam.
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let t = 0; t < idx.length; t += 3) {
    parent[find(idx[t + 1])] = find(idx[t]);
    parent[find(idx[t + 2])] = find(idx[t]);
  }
  const EPS = 1e-5;
  let count = 0;
  let maxGap = 0;
  let at = '';
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e];
      const c = idx[t + ((e + 1) % 3)];
      const ax = pos[a * 3];
      const az = pos[a * 3 + 2];
      const ex = pos[c * 3] - ax;
      const ez = pos[c * 3 + 2] - az;
      const len = Math.hypot(ex, ez);
      if (len < 1e-6) continue;
      for (let gx = Math.floor((Math.min(ax, ax + ex) - EPS) / G); gx <= Math.floor((Math.max(ax, ax + ex) + EPS) / G); gx++) {
        for (let gz = Math.floor((Math.min(az, az + ez) - EPS) / G); gz <= Math.floor((Math.max(az, az + ez) + EPS) / G); gz++) {
          for (const v of grid.get(`${gx},${gz}`) ?? []) {
            const dx = pos[v * 3] - ax;
            const dz = pos[v * 3 + 2] - az;
            const tt = (dx * ex + dz * ez) / (len * len);
            if (tt * len < EPS || (1 - tt) * len < EPS) continue;
            if (Math.abs(dx * ez - dz * ex) / len > EPS) continue;
            if ((col[v * 4 + 1] > 0.5) !== (col[a * 4 + 1] > 0.5) || find(v) !== find(a)) continue;
            const gap = Math.abs(pos[v * 3 + 1] - (pos[a * 3 + 1] + tt * (pos[c * 3 + 1] - pos[a * 3 + 1])));
            if (gap > 0.001) {
              count++;
              if (gap > maxGap) {
                maxGap = gap;
                at = `${pos[v * 3].toFixed(1)},${pos[v * 3 + 2].toFixed(1)}`;
              }
            }
          }
        }
      }
    }
  }
  return { count, maxGap, at };
}

/** Triangles `pick` accepts that contain (x, z) with every barycentric
 * weight > `margin` (negative = inclusive); returns the heights there. */
function triLookup(pp: ArrayLike<number>, pi: ArrayLike<number>, pick: (a: number, b: number, c: number) => boolean): (x: number, z: number, margin: number) => number[] {
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < pi.length; t += 3) {
    if (!pick(pi[t], pi[t + 1], pi[t + 2])) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let e = 0; e < 3; e++) {
      const v = pi[t + e];
      x0 = Math.min(x0, pp[v * 3]);
      x1 = Math.max(x1, pp[v * 3]);
      z0 = Math.min(z0, pp[v * 3 + 2]);
      z1 = Math.max(z1, pp[v * 3 + 2]);
    }
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
      for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
        const k = `${x},${z}`;
        const list = buckets.get(k);
        if (list) list.push(t);
        else buckets.set(k, [t]);
      }
    }
  }
  return (x, z, margin) => {
    const out: number[] = [];
    for (const t of buckets.get(`${Math.floor(x)},${Math.floor(z)}`) ?? []) {
      const a = pi[t];
      const b = pi[t + 1];
      const c = pi[t + 2];
      const ax = pp[a * 3];
      const az = pp[a * 3 + 2];
      const bx = pp[b * 3];
      const bz = pp[b * 3 + 2];
      const cx = pp[c * 3];
      const cz = pp[c * 3 + 2];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u <= margin || v <= margin || w <= margin) continue;
      out.push(u * pp[a * 3 + 1] + v * pp[b * 3 + 1] + w * pp[c * 3 + 1]);
    }
    return out;
  };
}

function round(v: number, digits = 1): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  document.body.classList.add('failed');
  setStatus(`FAILED: ${message}`);
  if (reportMode && resultEl) {
    const report: Partial<LabReport> = { page: 'terrain-lab', query: location.search, totals: { simSeconds: 0 }, scorecard: { text: message }, errors: [message], stats: {}, checks: [], fatal: message };
    resultEl.textContent = JSON.stringify(report);
    document.title = 'error';
  } else {
    console.error(e);
  }
});
