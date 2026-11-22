import {
  ArcRotateCamera,
  Camera,
  Color3,
  Engine,
  HavokPlugin,
  MeshBuilder,
  Mesh,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  VertexData,
  Viewport,
} from '@babylonjs/core';
import type { AbstractMesh, PhysicsEngineV2 } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { prepareCar, prepareProp, toyMaterial } from '../assets/assemble';
import { loadAsset } from '../assets/registry';
import type { CarAsset, PropAsset } from '../assets/types';
import { GAME_GRAVITY } from '../car/rig';
import { CAMERA_TUNING, followVerticalFov } from '../game/camera/CameraRig';
import type { PropsView, WorldPropsOptions, WorldPropsStats } from '../game/contracts/props';
import type { PropClass } from '../game/contracts/quality';
import type { FrameStats, LabReport, ReportValue } from '../game/contracts/report';
import type { WorldData } from '../game/contracts/world';
import { LOOK_VIEWS, createLook } from '../gfx/look/lighting';
import type { LookRuntime, ShadowQuality, ShadowTaps } from '../gfx/look/lighting';
import type { SolidVertexData } from '../gfx/solid/SolidMesh';
import { COLLIDER_VARIANTS, createWorldProps, farBuildingTarget, farModel, inspectWorldProps, ringInside, simplifyMesh, simplifyWithInfo } from '../render/scatter';
import type { SimplifyResult, WorldPropsInternals } from '../render/scatter';
import { generateTerrain } from '../terrain/generateTerrain';
import { catalogEntry } from '../world/catalog';

/**
 * PROPS LAB — the world props on a plain ground: near / far
 * tiers, shadow casters, colliders, the simplifier side by side, and the
 * numbers (`report=1`).
 *
 *   ?seed=1 &view=chase|high|top|xr|free &s=<arc m>|village|bend
 *   &yaw= &pitch= &dist= &near=<m> &building=<m> &density= &quality=high|quest
 *   &tier=both|near|far &ring=1 &colliders=1 &shadows=off|1024|2048
 *   &compare=<assetId>|car:<carId> (&pairDist= &pairHeight= &pairFov= &scheme= &far=simplify) &shot=1 &report=1 &ui=0
 *   s=garage with view=free orbits the garage, from in front of its doors
 *
 * Cameras for chase / high / xr are the game's (`CAMERA_TUNING`), standing
 * still behind the track point at `s` (xr: the diorama orbit at the world
 * centre).
 */

const params = new URLSearchParams(location.search);
const str = (k: string, d: string): string => params.get(k) ?? d;
const num = (k: string, d: number): number => {
  const v = params.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const shotMode = params.get('shot') === '1';
const reportMode = params.get('report') === '1';
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const infoEl = document.getElementById('info');
if (params.get('ui') === '0') document.body.classList.add('quiet');
const setStatus = (s: string): void => {
  if (statusEl) statusEl.textContent = s;
};
const setInfo = (s: string): void => {
  if (infoEl) infoEl.textContent = s;
};

// The lab's OWN copy of the prop numbers of the `high` / `quest` presets of
// src/game/quality.ts (equal on 2026-11-22; nothing compares them — keep in
// step by hand, or the lab measures a preset the game does not use).
interface Preset {
  nearRadius: number;
  buildingRadius: number;
  variantLimit: Record<PropClass, number>;
  farTriangles: Record<PropClass, number>;
  scatterDensity: number;
  shadowCasters: PropClass[];
  shadowQuality: ShadowQuality;
  shadowTaps: ShadowTaps;
}
const PRESET_HIGH: Preset = {
  nearRadius: 46,
  buildingRadius: 90,
  variantLimit: { tree: 4, bush: 3, lowPlant: 2, largeRock: 3, smallRock: 2, dressing: 4, building: 3 },
  farTriangles: { tree: 72, bush: 24, lowPlant: 12, largeRock: 36, smallRock: 8, dressing: 40, building: 900 },
  scatterDensity: 1,
  shadowCasters: ['tree', 'largeRock', 'dressing', 'building'],
  shadowQuality: 2048,
  shadowTaps: 9,
};
const PRESET_QUEST: Preset = {
  nearRadius: 32,
  buildingRadius: 60,
  variantLimit: { tree: 2, bush: 2, lowPlant: 1, largeRock: 2, smallRock: 1, dressing: 2, building: 3 },
  farTriangles: { tree: 48, bush: 16, lowPlant: 8, largeRock: 24, smallRock: 6, dressing: 24, building: 600 },
  scatterDensity: 0.5,
  shadowCasters: ['tree', 'largeRock', 'building'],
  shadowQuality: 1024,
  shadowTaps: 4,
};
const PRESETS = { high: PRESET_HIGH, quest: PRESET_QUEST };

type LabView = 'chase' | 'high' | 'top' | 'xr' | 'free';

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

function propClassOf(asset: PropAsset): PropClass {
  switch (asset.category) {
    case 'tree':
      return 'tree';
    case 'vegetation':
      return asset.id === 'v01-puff-bush' ? 'bush' : 'lowPlant';
    case 'large-rock':
      return 'largeRock';
    case 'small-rock':
      return 'smallRock';
    case 'building':
      return 'building';
    default:
      return 'dressing';
  }
}

function meshFromData(name: string, d: SolidVertexData, scene: Scene): Mesh {
  const vd = new VertexData();
  vd.positions = d.positions;
  vd.normals = d.normals;
  vd.colors = d.colors;
  vd.uvs = d.uvs;
  vd.uvs2 = d.uvs2;
  vd.indices = d.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh, false);
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false;
  mesh.material = toyMaterial(scene);
  return mesh;
}

// ---------------------------------------------------------------------------
// Plain ground: the heightfield as one matte toy mesh — green, the road
// dirt-coloured from the splat, paving pale. It only has to carry shadows.

function buildGround(scene: Scene, data: WorldData): Mesh {
  const hf = data.heightfield;
  const n = hf.n;
  const half = hf.size / 2;
  const V = n * n;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const col = new Float32Array(V * 4);
  const uv = new Float32Array(V * 2);
  const uv2 = new Float32Array(V * 2);
  const GRASS = [0.52, 0.72, 0.3], ROCK = [0.63, 0.59, 0.68], DIRT = [0.8, 0.62, 0.42], MEADOW = [0.63, 0.78, 0.34], PAVED = [0.82, 0.76, 0.72];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const wx = -half + x * hf.step, wz = -half + z * hf.step;
      pos[i * 3] = wx;
      pos[i * 3 + 1] = hf.at(x, z);
      pos[i * 3 + 2] = wz;
      const g = hf.getNormal(wx, wz);
      nrm[i * 3] = g.x;
      nrm[i * 3 + 1] = g.y;
      nrm[i * 3 + 2] = g.z;
      const s = data.splat;
      const p = data.paved[i];
      for (let c = 0; c < 3; c++) {
        const base = s[i * 4] * GRASS[c] + s[i * 4 + 1] * ROCK[c] + s[i * 4 + 2] * DIRT[c] + s[i * 4 + 3] * MEADOW[c];
        col[i * 4 + c] = (base * (1 - p) + PAVED[c] * p) * data.shade[i * 3 + 2];
      }
      uv2[i * 2] = data.shade[i * 3];
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let z = 0; z < n - 1; z++) {
    for (let x = 0; x < n - 1; x++) {
      const a = z * n + x;
      // Reversed (Babylon) winding of upward faces.
      idx[k++] = a;
      idx[k++] = a + 1;
      idx[k++] = a + n;
      idx[k++] = a + 1;
      idx[k++] = a + n + 1;
      idx[k++] = a + n;
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.colors = col;
  vd.uvs = uv;
  vd.uvs2 = uv2;
  vd.indices = idx;
  const mesh = new Mesh('labGround', scene);
  vd.applyToMesh(mesh, false);
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.material = toyMaterial(scene);
  mesh.freezeWorldMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------
// Track points

interface TrackPoint {
  x: number;
  y: number;
  z: number;
  /** Heading: yaw of the tangent (0 = +z, positive toward +x). */
  yaw: number;
}

function trackSampler(data: WorldData): { length: number; at(s: number): TrackPoint; resolve(spec: string): number } {
  const t = data.track;
  const cum = new Float64Array(t.count + 1);
  for (let i = 0; i < t.count; i++) {
    const j = (i + 1) % t.count;
    cum[i + 1] = cum[i] + Math.hypot(t.points[j * 2] - t.points[i * 2], t.points[j * 2 + 1] - t.points[i * 2 + 1]);
  }
  const length = cum[t.count];
  const wrap = (s: number): number => ((s % length) + length) % length;
  const at = (sIn: number): TrackPoint => {
    const s = wrap(sIn);
    let lo = 0, hi = t.count;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const j = (lo + 1) % t.count;
    const f = (s - cum[lo]) / Math.max(1e-9, cum[lo + 1] - cum[lo]);
    const x = t.points[lo * 2] + (t.points[j * 2] - t.points[lo * 2]) * f;
    const z = t.points[lo * 2 + 1] + (t.points[j * 2 + 1] - t.points[lo * 2 + 1]) * f;
    const tx = t.tangents[lo * 2] + (t.tangents[j * 2] - t.tangents[lo * 2]) * f;
    const tz = t.tangents[lo * 2 + 1] + (t.tangents[j * 2 + 1] - t.tangents[lo * 2 + 1]) * f;
    return { x, y: data.heightfield.getHeight(x, z), z, yaw: Math.atan2(tx, tz) };
  };
  const resolve = (spec: string): number => {
    if (spec === 'village') return wrap(data.plan.village.s0 + 20);
    if (spec === 'bend') return wrap(data.plan.bends[0]?.apexS ?? 0);
    if (spec === 'garage') return wrap(data.plan.lots.find((l) => l.id === data.plan.village.garageLot)?.s ?? 0);
    const v = Number(spec);
    return Number.isFinite(v) ? wrap(v) : 0;
  };
  return { length, at, resolve };
}

// ---------------------------------------------------------------------------
// Cameras

interface Cams {
  follow: UniversalCamera;
  orbit: ArcRotateCamera;
  top: UniversalCamera;
}

function makeCams(scene: Scene): Cams {
  const follow = new UniversalCamera('labFollow', new Vector3(0, 3, -6), scene);
  follow.minZ = 0.3;
  follow.maxZ = 600;
  follow.rotationQuaternion = null as never;
  const t = CAMERA_TUNING.xr;
  const orbit = new ArcRotateCamera('labOrbit', -Math.PI / 2, Math.atan2(t.back, t.eyeHeight), Math.hypot(t.back, t.eyeHeight), Vector3.Zero(), scene);
  orbit.minZ = 0.5;
  orbit.maxZ = 1000;
  orbit.wheelPrecision = 1;
  orbit.lowerRadiusLimit = t.minRadius;
  orbit.upperRadiusLimit = t.maxRadius * 2;
  // Straight down: a UniversalCamera with its rotation set directly (an
  // ArcRotateCamera at beta ≈ 0 degenerates), orthographic over the world.
  const top = new UniversalCamera('labTop', new Vector3(0, 300, 0), scene);
  top.rotation.set(Math.PI / 2, 0, 0);
  top.mode = Camera.ORTHOGRAPHIC_CAMERA;
  top.minZ = 1;
  top.maxZ = 800;
  return { follow, orbit, top };
}

/** Pose the follow camera the way the game's rig does, standing still. */
function poseFollow(cam: UniversalCamera, p: TrackPoint, mode: 'chase' | 'high', heightAt: (x: number, z: number) => number, yawDeg: number, dist: number | null): void {
  const c = mode === 'chase' ? CAMERA_TUNING.chase : null;
  const h = CAMERA_TUNING.high;
  const distance = dist ?? (c ? c.distance : h.distance);
  const height = c ? c.height : h.height;
  const lookUp = c ? c.lookUp : 0;
  const lookAhead = c ? c.lookAhead : h.lookAhead;
  const fov = c ? c.fov : h.fov;
  const yaw = p.yaw + (yawDeg * Math.PI) / 180;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const ex = p.x - sy * distance, ez = p.z - cy * distance;
  const ey = Math.max(p.y + height, heightAt(ex, ez) + CAMERA_TUNING.chase.minClearance);
  const tx = p.x + Math.sin(p.yaw) * lookAhead, ty = p.y + lookUp, tz = p.z + Math.cos(p.yaw) * lookAhead;
  cam.position.set(ex, ey, ez);
  const dx = tx - ex, dy = ty - ey, dz = tz - ez;
  cam.rotation.set(Math.atan2(-dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0);
  cam.fov = followVerticalFov(fov, cam.getEngine().getAspectRatio(cam));
}

function poseTop(cam: UniversalCamera, engine: Engine, extent: number): void {
  const aspect = engine.getAspectRatio(cam);
  const h = extent / 2;
  cam.orthoTop = h;
  cam.orthoBottom = -h;
  cam.orthoLeft = -h * aspect;
  cam.orthoRight = h * aspect;
}

// ---------------------------------------------------------------------------

async function boot(): Promise<{ engine: Engine; scene: Scene; look: LookRuntime; canvas: HTMLCanvasElement }> {
  const canvas = document.getElementById('props') as HTMLCanvasElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: shotMode });
  // Headless screenshots run on a virtual clock that expires before an
  // async (parallel) shader compile reports back; compile synchronously.
  if (shotMode || reportMode) engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);
  if (shotMode || reportMode) scene.useConstantAnimationDeltaTime = true;
  const havok = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -GAME_GRAVITY, 0), new HavokPlugin(false, havok));
  const quality = str('quality', 'high') === 'quest' ? PRESET_QUEST : PRESET_HIGH;
  const sh = params.get('shadows');
  const shadowQuality: ShadowQuality = sh === 'off' ? 'off' : sh === '1024' ? 1024 : sh === '2048' ? 2048 : quality.shadowQuality;
  const look = createLook(scene, { shadowQuality, shadowTaps: quality.shadowTaps, shadowRegion: LOOK_VIEWS.chase.shadowRegion, sky: true });
  // Wind: still in screenshots.
  if (shotMode) look.freezeTime = true;
  return { engine, scene, look, canvas };
}

function finishShot(engine: Engine, scene: Scene, frame: () => void): void {
  for (let i = 0; i < 3; i++) frame();
  scene.physicsEnabled = false;
  window.addEventListener('resize', () => {
    engine.resize();
    // No render loop in shot mode, and headless Chrome resizes the viewport
    // for its screenshot (which clears the canvas): draw the frame again.
    frame();
  });
  setStatus('shot ready');
}

async function main(): Promise<void> {
  const compare = params.get('compare');
  if (compare) return runCompare(compare);
  if (reportMode) return runReport();

  const { engine, scene, look, canvas } = await boot();
  const quality = str('quality', 'high') === 'quest' ? PRESET_QUEST : PRESET_HIGH;
  const seed = Math.max(1, Math.round(num('seed', 1)));
  setStatus(`generating seed ${seed}`);
  const data = generateTerrain(seed);
  buildGround(scene, data);
  const track = trackSampler(data);
  const view = str('view', 'chase') as LabView;
  const s = track.resolve(str('s', '0'));
  const p = track.at(s);

  const showColliders = params.get('colliders') === '1';
  const options: WorldPropsOptions & { nearTint?: [number, number, number]; colliderDebug?: boolean } = {
    nearRadius: quality.nearRadius,
    buildingRadius: quality.buildingRadius,
    variantLimit: quality.variantLimit,
    farTriangles: quality.farTriangles,
    scatterDensity: num('density', quality.scatterDensity),
    shadowCasters: quality.shadowCasters,
    colliders: true,
    colliderDebug: showColliders,
    onProgress: (f, label) => setStatus(`props ${(f * 100).toFixed(0)} % ${label}`),
  };
  if (params.get('ring') === '1') options.nearTint = [1.5, 0.55, 0.5];
  const t0 = performance.now();
  const props = await createWorldProps(scene, data, options);
  const bootMs = performance.now() - t0;
  const internals = inspectWorldProps(props)!;
  if (showColliders) buildColliderWireframes(scene, internals);

  const cams = makeCams(scene);
  const heightAt = (x: number, z: number): number => data.heightfield.getHeight(x, z);
  const yawDeg = num('yaw', 0);
  const distP = params.get('dist') !== null ? num('dist', 0) : null;
  const xr = view === 'xr';
  const focus = xr ? { x: 0, y: 0, z: 0 } : { x: p.x, y: p.y, z: p.z };
  const propsView: PropsView = {
    x: focus.x,
    z: focus.z,
    nearRadius: num('near', xr ? 0 : quality.nearRadius),
    buildingRadius: num('building', xr ? 0 : quality.buildingRadius),
    farDetail: view === 'xr' || view === 'top' || view === 'free',
    farShadows: xr,
  };
  const wide = xr || view === 'top';
  look.shadows.region = wide ? LOOK_VIEWS.diorama.shadowRegion : LOOK_VIEWS.chase.shadowRegion;
  look.config.fogDensity = wide ? LOOK_VIEWS.diorama.fogDensity : LOOK_VIEWS.chase.fogDensity;
  const shadowFocus = wide ? { x: 0, y: 0, z: 0 } : focus;

  if (view === 'chase' || view === 'high') {
    scene.activeCamera = cams.follow;
  } else if (view === 'top') {
    scene.activeCamera = cams.top;
  } else {
    const o = cams.orbit;
    o.target.set(focus.x, xr ? 0 : focus.y, focus.z);
    o.alpha = -Math.PI / 2 + (yawDeg * Math.PI) / 180;
    // free + s=garage: orbit the garage itself, from in front of its doors.
    const garage = data.plan.lots.find((l) => l.id === data.plan.village.garageLot);
    if (view === 'free' && str('s', '') === 'garage' && garage) {
      o.target.set(garage.x, garage.y + 1.5, garage.z);
      // Its front looks along (−sin yaw, −cos yaw); alpha measures from +x.
      o.alpha = Math.atan2(-Math.cos(garage.yaw), -Math.sin(garage.yaw)) + (yawDeg * Math.PI) / 180;
      if (params.get('pitch') === null) o.beta = Math.PI / 2 - 0.35;
      if (distP === null) o.radius = 16;
    }
    if (params.get('pitch') !== null) o.beta = Math.PI / 2 - (num('pitch', 45) * Math.PI) / 180;
    if (distP !== null) o.radius = distP;
    else if (!xr) o.radius = 60;
    o.attachControl(canvas, true);
    scene.activeCamera = o;
  }
  const tier = str('tier', 'both');

  const frame = (): void => {
    if (view === 'chase' || view === 'high') poseFollow(cams.follow, p, view, heightAt, yawDeg, distP);
    if (view === 'top') poseTop(cams.top, engine, data.heightfield.size);
    props.update(propsView);
    if (tier === 'far') for (const m of props.nearMeshes) m.setEnabled(false);
    if (tier === 'near') for (const m of props.farMeshes) m.setEnabled(false);
    look.shadows.setFocus(shadowFocus);
    scene.render();
  };

  const st = props.stats;
  const info = [
    `props-lab  seed ${seed}  view ${view}  s ${s.toFixed(1)} / ${track.length.toFixed(0)}  quality ${str('quality', 'high')}  tier ${tier}`,
    `near r ${propsView.nearRadius} / ${propsView.buildingRadius}  farDetail ${propsView.farDetail}  farShadows ${propsView.farShadows}`,
  ];
  const report = (): void => {
    setInfo(
      [
        ...info,
        `placements ${st.placements}  drawn ${st.drawn}  near ${st.nearActive}/${st.nearBatches} meshes ${st.nearInstances} inst ${(st.nearTriangles / 1000).toFixed(0)}k tri`,
        `far ${st.farActive}/${st.farBatches} meshes ${st.farInstances} inst ${(st.farTriangles / 1000).toFixed(0)}k tri  casters ${st.casterMeshes} ${(st.casterTriangles / 1000).toFixed(0)}k tri`,
        `colliders ${st.colliderShapes} shapes / ${st.colliderBodies} bodies  load ${(bootMs / 1000).toFixed(1)} s  permanent: ${internals.permanentAssets.join(', ') || '-'}`,
        internals.skippedAssets.length ? `SKIPPED assets: ${internals.skippedAssets.join(', ')}` : '',
      ].join('\n'),
    );
  };
  (window as unknown as { __props: unknown }).__props = { engine, scene, look, props, internals, data, cams, propsView };

  if (shotMode) {
    finishShot(engine, scene, frame);
    report();
    return;
  }
  setStatus('running');
  engine.runRenderLoop(() => {
    frame();
    report();
  });
  window.addEventListener('resize', () => engine.resize());
}

function buildColliderWireframes(scene: Scene, internals: WorldPropsInternals): void {
  const debug = internals.colliders?.debug ?? [];
  const kinds: { kind: 'box' | 'cylinder' | 'sphere'; mesh: Mesh; color: Color3 }[] = [
    { kind: 'box', mesh: MeshBuilder.CreateBox('colBox', { size: 1 }, scene), color: new Color3(1, 0.45, 0.1) },
    { kind: 'cylinder', mesh: MeshBuilder.CreateCylinder('colCyl', { height: 1, diameter: 2, tessellation: 12 }, scene), color: new Color3(0.1, 0.95, 1) },
    { kind: 'sphere', mesh: MeshBuilder.CreateSphere('colSph', { diameter: 2, segments: 6 }, scene), color: new Color3(1, 0.2, 0.9) },
  ];
  for (const k of kinds) {
    const list = debug.filter((d) => d.kind === k.kind);
    const mat = new StandardMaterial(`colMat.${k.kind}`, scene);
    mat.wireframe = true;
    mat.disableLighting = true;
    mat.emissiveColor = k.color;
    k.mesh.material = mat;
    k.mesh.applyFog = false;
    k.mesh.isPickable = false;
    if (list.length === 0) {
      k.mesh.setEnabled(false);
      continue;
    }
    const buf = new Float32Array(list.length * 16);
    list.forEach((d, i) => buf.set(d.matrix.m, i * 16));
    k.mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
    k.mesh.alwaysSelectAsActiveMesh = true;
  }
}

// ---------------------------------------------------------------------------
// compare=<assetId> | car:<carId>

async function runCompare(spec: string): Promise<void> {
  const { engine, scene, look } = await boot();
  const quality = str('quality', 'high') === 'quest' ? PRESET_QUEST : PRESET_HIGH;
  const mat = toyMaterial(scene);
  const lines: string[] = [];

  // Ground plates under the row and under the 60 m pair.
  const groundAt = (name: string, x: number, z: number, size: number): void => {
    const g = MeshBuilder.CreateGround(name, { width: size, height: size }, scene);
    const n = g.getTotalVertices();
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) colors.set([0.55, 0.74, 0.32, 0], i * 4);
    g.setVerticesData('color', colors, false, 4);
    g.setVerticesData('uv2', new Float32Array(n * 2).fill(1), false, 2);
    g.setVerticesData('uv', new Float32Array(n * 2), false, 2);
    g.position.set(x, 0, z);
    g.hasVertexAlpha = false;
    g.applyFog = false;
    g.material = mat;
  };

  /** Full and far meshes of one subject, as (name, full data, far result). */
  const pairs: { label: string; full: SolidVertexData[]; far: SimplifyResult[]; width: number; height: number; offsets: Vector3[] }[] = [];
  if (spec.startsWith('car:')) {
    const id = spec.slice(4);
    const asset = (await loadAsset(id)) as CarAsset;
    const pc = prepareCar(asset, 0);
    const wheel = pc.wheels[1];
    const parts = [pc.body, ...(pc.driver ? [pc.driver] : []), wheel];
    const far = parts.map((m) => simplifyWithInfo(m.data, Math.max(12, Math.round(m.triangles * 0.12))));
    const offsets = parts.map((_, i) => (i === parts.length - 1 ? new Vector3(asset.spec.width * 0.5 + 0.9, 0, 0) : Vector3.Zero()));
    pairs.push({ label: id, full: parts.map((m) => m.data), far, width: asset.spec.width + 2.2, height: asset.spec.height, offsets });
    ['body', ...(pc.driver ? ['driver'] : []), 'wheel'].forEach((n, i) =>
      lines.push(`${id} ${n}: ${parts[i].triangles} → ${far[i].data.triangleCount} (${far[i].method}, silhouette ${far[i].silhouette.toFixed(2)}, bounds ${(far[i].boundsError * 100).toFixed(1)} %)`),
    );
  } else {
    const asset = (await loadAsset(spec)) as PropAsset;
    const cls = propClassOf(asset);
    const target = cls === 'building' ? farBuildingTarget(asset.id, quality.farTriangles.building) : quality.farTriangles[cls];
    const scheme = params.get('scheme') ?? asset.schemes?.[0];
    const seeds = [0, 1, 2].filter((s) => s < asset.variants);
    for (const seed of seeds) {
      const p = prepareProp(asset, seed, scheme);
      // The far model the game draws (designed, if the asset has one);
      // `far=simplify` shows the generic simplifier's instead (A/B).
      const r = farModel(asset, seed, scheme, target, { simplify: params.get('far') === 'simplify' });
      pairs.push({ label: `${asset.id} #${seed}`, full: [p.mesh.data], far: [r], width: p.mesh.max[0] - p.mesh.min[0], height: p.mesh.max[1] - p.mesh.min[1], offsets: [Vector3.Zero()] });
      lines.push(`${asset.id} #${seed}${scheme ? ` ${scheme}` : ''}: ${p.mesh.triangles} → ${r.data.triangleCount} / ${target} (${r.method}, cluster silhouette ${r.clusterSilhouette.toFixed(2)}, result ${r.silhouette.toFixed(2)}, bounds ${(r.boundsError * 100).toFixed(1)} %)`);
    }
  }

  // Row: [full | far] per subject, along +x.
  const gap = Math.max(...pairs.map((p) => p.width)) * 0.35 + 0.3;
  let x = 0;
  const placed: { mesh: Mesh; x: number }[] = [];
  for (const pr of pairs) {
    for (const [k, list] of [pr.full, pr.far.map((r) => r.data)].entries()) {
      const cx = x + pr.width / 2;
      list.forEach((d, i) => {
        const m = meshFromData(`${pr.label}.${k ? 'far' : 'full'}${i}`, d, scene);
        m.position.set(cx + pr.offsets[i].x, 0, 0);
        placed.push({ mesh: m, x: cx });
        look.shadows.addCaster(m);
      });
      x += pr.width + gap;
    }
    x += gap;
  }
  const rowWidth = x - 2 * gap;
  const tallest = Math.max(...pairs.map((p) => p.height));
  for (const pl of placed) pl.mesh.position.x -= rowWidth / 2;
  groundAt('rowGround', 0, 0, Math.max(40, rowWidth * 2));

  // The first pair again, 60 m from a chase-height eye, far away from the row.
  const P = new Vector3(2000, 0, 0);
  const pr0 = pairs[0];
  const pairGap = pr0.width * 0.2 + 0.4;
  for (const [k, list] of [pr0.full, pr0.far.map((r) => r.data)].entries()) {
    list.forEach((d, i) => {
      const m = meshFromData(`p60.${k}.${i}`, d, scene);
      m.position.set(P.x + (k === 0 ? -1 : 1) * (pr0.width / 2 + pairGap / 2) + pr0.offsets[i].x, 0, P.z);
    });
  }
  groundAt('pairGround', P.x, P.z, 200);

  const camA = new ArcRotateCamera('cmpRow', -Math.PI / 2 + 0.12, 1.22, 10, new Vector3(0, tallest * 0.45, 0), scene);
  const fovA = 0.6;
  camA.fov = fovA;
  const aspectA = (engine.getRenderWidth() || 1672) / ((engine.getRenderHeight() || 941) * 0.62);
  const fitW = (rowWidth * 1.08) / (2 * Math.tan(fovA / 2) * aspectA);
  const fitH = (tallest * 1.3) / (2 * Math.tan(fovA / 2));
  camA.radius = Math.max(fitW, fitH) * 1.12 + 2;
  camA.minZ = 0.1;
  camA.viewport = new Viewport(0, 0.38, 1, 0.62);
  // The distant pair: 60 m from a chase-height eye by default; `pairDist` /
  // `pairHeight` / `pairFov` pose it like another view (e.g. the high camera
  // at the car LOD 2 distance: pairDist=45&pairHeight=14&pairFov=0.7).
  const pairDist = num('pairDist', 60);
  const pairHeight = num('pairHeight', CAMERA_TUNING.chase.height);
  const horiz = Math.sqrt(Math.max(1, pairDist * pairDist - pairHeight * pairHeight));
  const camB = new UniversalCamera('cmp60', new Vector3(P.x, pairHeight, P.z - horiz), scene);
  camB.rotationQuaternion = null as never;
  const dy = pr0.height * 0.4 - pairHeight;
  camB.rotation.set(Math.atan2(-dy, horiz), 0, 0);
  camB.fov = num('pairFov', CAMERA_TUNING.chase.fov);
  camB.minZ = 0.3;
  camB.viewport = new Viewport(0, 0, 1, 0.38);
  scene.activeCameras = [camA, camB];
  look.shadows.setFocus({ x: 0, y: 0, z: 0 });
  look.shadows.region = Math.max(40, rowWidth * 1.3);
  if (shotMode) look.freezeTime = true;

  setInfo([`compare ${spec}  (top: full | far per variant; bottom: the first pair ${pairDist} m from an eye ${pairHeight.toFixed(1)} m up)`, ...lines].join('\n'));
  const frame = (): void => scene.render();
  if (shotMode) {
    finishShot(engine, scene, frame);
    return;
  }
  camA.attachControl(document.getElementById('props') as HTMLCanvasElement, true);
  engine.runRenderLoop(frame);
  window.addEventListener('resize', () => engine.resize());
}

// ---------------------------------------------------------------------------
// report=1

async function runReport(): Promise<void> {
  const tBoot = performance.now();
  const { engine, scene, look } = await boot();
  const seed = Math.max(1, Math.round(num('seed', 1)));
  const stats: Record<string, ReportValue> = {};
  const checks: LabReport['checks'] = [];
  const check = (id: string, value: ReportValue, target: string, pass: boolean): void => {
    checks.push({ id, value, target, pass });
  };
  const r2 = (v: number): number => Math.round(v * 100) / 100;

  setStatus(`generating seed ${seed}`);
  const tGen = performance.now();
  const data = generateTerrain(seed);
  stats['boot.generateMs'] = r2(performance.now() - tGen);
  buildGround(scene, data);
  const track = trackSampler(data);
  const cams = makeCams(scene);
  const heightAt = (x: number, z: number): number => data.heightfield.getHeight(x, z);
  const dc = (engine as unknown as { _drawCalls: DrawCounter })._drawCalls;
  const measure = (): FrameStats => {
    scene.render();
    dc.fetchNewFrame();
    scene.render();
    const sp = shadowPass(look);
    return { drawCalls: dc.current, triangles: Math.round(scene.getActiveIndices() / 3), shadowDrawCalls: sp.drawCalls, shadowTriangles: Math.round(sp.triangles) };
  };
  const median = (a: number[]): number => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };
  const focusS = Array.from({ length: 20 }, (_, k) => (k * track.length) / 20);
  let highColliderVariant: Int32Array | null = null;
  let highHeroVariant: Int32Array | null = null;

  for (const qName of ['high', 'quest'] as const) {
    const q = PRESETS[qName];
    look.shadows.setQuality(q.shadowQuality);
    look.shadows.taps = q.shadowTaps;
    setStatus(`${qName}: building props`);
    const t0 = performance.now();
    const props = await createWorldProps(scene, data, {
      nearRadius: q.nearRadius,
      buildingRadius: q.buildingRadius,
      variantLimit: q.variantLimit,
      farTriangles: q.farTriangles,
      scatterDensity: q.scatterDensity,
      shadowCasters: q.shadowCasters,
      // Colliders once (the high build); the quest build shows it needs no physics.
      colliders: qName === 'high',
      onProgress: (f, label) => setStatus(`${qName}: props ${(f * 100).toFixed(0)} % ${label}`),
    });
    stats[`${qName}.loadMs`] = r2(performance.now() - t0);
    const I = inspectWorldProps(props)!;
    if (qName === 'high') highColliderVariant = I.colliderVariant.slice();
    else if (highColliderVariant) {
      let diff = 0;
      for (let i = 0; i < I.count; i++) if (I.colliderVariant[i] !== highColliderVariant[i]) diff++;
      check('colliders.preset', `${diff} of ${I.count} placements collide as a different variant on quest than on high`, 'collider variants identical on every preset', diff === 0 && I.count === highColliderVariant.length);
    }
    // Drawn variant = colliding variant for the props whose colliders differ
    // by variant (large rocks, chevrons), in the near tier AND the far tier,
    // on both builds. Everything else may differ (< 0.3 m): counted, a stat.
    {
      let n = 0, bad = 0, other = 0, otherDiff = 0;
      const withColliders = new Set([0, 3, 5, 6]); // tree, largeRock, dressing, building
      for (let i = 0; i < I.count; i++) {
        if (!I.drawn[i]) continue;
        if (I.drawAsCollider[i]) {
          n++;
          const fv = I.farVariant[i];
          if (I.drawVariant[i] !== I.colliderVariant[i] || (fv >= 0 && fv !== I.colliderVariant[i])) bad++;
        } else if (withColliders.has(I.cls[i])) {
          other++;
          if (I.drawVariant[i] !== I.colliderVariant[i]) otherDiff++;
        }
      }
      check(`colliders.variant.${qName}`, `${bad} of ${n} rocks / chevrons / hero pieces drawn (near or far) as another variant than they collide as`, 'large rocks, chevrons, buildings, one-off dressing: drawn variant = collider variant in both tiers', bad === 0 && n > 0);
      stats[`${qName}.drawnNotColliderVariant`] = `${otherDiff} of ${other}`;
    }
    // Variant continuity at the ring: every drawn placement that has a far
    // model is drawn in the far tier as the SAME variant the near tier draws
    // (a tree does not change shape or colour when it crosses the ring).
    {
      let n = 0, bad = 0, noFar = 0;
      for (let i = 0; i < I.count; i++) {
        if (!I.drawn[i] || I.permanent[i]) continue;
        n++;
        if (I.farVariant[i] < 0) noFar++;
        else if (I.farVariant[i] !== I.drawVariant[i]) bad++;
      }
      check(`variant.continuity.${qName}`, `${bad} of ${n} placements drawn as another variant in the far tier, ${noFar} without a far model`, 'far variant = near variant for every placement with a far model (none missing)', bad === 0 && noFar === 0 && n > 0);
    }
    // Hero pieces (buildings, the gantry and the other one-off dressing):
    // the same variant on both presets.
    if (qName === 'high') highHeroVariant = I.drawVariant.slice();
    else if (highHeroVariant) {
      let n = 0, bad = 0;
      const hero: string[] = [];
      for (let i = 0; i < I.count; i++) {
        if (!(I.cls[i] === 6 || I.permanentAssets.includes(I.assetId[i]))) continue;
        n++;
        if (I.drawVariant[i] !== highHeroVariant[i]) {
          bad++;
          hero.push(`${I.assetId[i]} ${highHeroVariant[i]}→${I.drawVariant[i]}`);
        }
      }
      check('hero.preset', `${bad} of ${n} hero pieces drawn as another variant on quest than on high${hero.length ? `: ${hero.slice(0, 4).join(', ')}` : ''}`, 'buildings and one-off dressing (gantry): same variant on every preset', bad === 0 && n > 0);
    }
    const view: PropsView = { x: 0, z: 0, nearRadius: q.nearRadius, buildingRadius: q.buildingRadius, farDetail: false, farShadows: false };

    // --- partition, near.active, refresh.ms, empty.batch over 20 focus points
    let partitionBad = 0;
    let partitionWorst = '';
    let maxActive = 0;
    let emptySeen = 0;
    let emptyBad = 0;
    const refreshMs: number[] = [];
    for (const s of focusS) {
      const p = track.at(s);
      view.x = p.x;
      view.z = p.z;
      view.farDetail = true;
      I.invalidate();
      props.update(view);
      refreshMs.push(props.stats.lastRefreshMs);
      maxActive = Math.max(maxActive, props.stats.nearActive);
      const res = partition(I);
      if (res.bad > 0) {
        partitionBad += res.bad;
        partitionWorst = `s ${s.toFixed(0)}: ${res.text}`;
      }
      for (const b of I.near) {
        if (b.count > 0) continue;
        emptySeen++;
        if (b.mesh.isEnabled(false)) emptyBad++;
      }
    }
    if (qName === 'high') {
      check('partition', partitionBad === 0 ? 'exact at 20 focus points' : partitionWorst, 'near + far outside the ring = drawn, none in both', partitionBad === 0);
      check('refresh.ms', r2(median(refreshMs)), 'median of 20 refreshes ≤ 4 ms', median(refreshMs) <= 4);
      check('empty.batch', `${emptySeen} empty batches seen, ${emptyBad} enabled`, 'every near batch with 0 instances is disabled (and some exist)', emptySeen > 0 && emptyBad === 0);
    } else {
      check('partition.quest', partitionBad === 0 ? 'exact at 20 focus points' : partitionWorst, 'near + far outside the ring = drawn, none in both', partitionBad === 0);
    }
    stats[`${qName}.refreshMsMedian`] = r2(median(refreshMs));
    stats[`${qName}.refreshMsMax`] = r2(Math.max(...refreshMs));
    // The original limits 105 / 70 were counted on plans of 110–115 prop
    // batches; plans now have 114–120, so they are scaled by 120 / 115:
    // 110 / 73.
    const activeLimit = qName === 'high' ? 110 : 73;
    check(`near.active.${qName}`, maxActive, `≤ ${activeLimit} (105 / 70 × 120 / 115: plans grew to 114–120 batches)`, maxActive <= activeLimit);

    // --- far tier totals
    // Every far triangle submitted: the instanced batches, the merged
    // buildings and the merged dressing.
    let farTotal = I.merged.triangles + I.mergedDressing.triangles;
    for (const f of I.farBatches) farTotal += f.count * f.triangles;
    check(`far.total.${qName}`, farTotal, qName === 'high' ? '≤ 260000' : '≤ 140000', farTotal <= (qName === 'high' ? 260000 : 140000));
    stats[`${qName}.farTotalTriangles`] = farTotal;
    if (qName === 'high') check('far.batches', props.farMeshes.length, '≤ 45', props.farMeshes.length <= 45);
    else stats['quest.farBatchesCheck'] = props.farMeshes.length;
    // Budget sheet per asset kind (stats only): far instances (all drawn
    // placements with a far model — the diorama view draws exactly these),
    // triangles per far mesh, Σ submitted triangles, far meshes.
    {
      const rows = new Map<string, { inst: number; tris: Set<number>; total: number; meshes: string }>();
      const row = (id: string, meshes: string) => {
        let r = rows.get(id);
        if (!r) rows.set(id, (r = { inst: 0, tris: new Set(), total: 0, meshes }));
        return r;
      };
      for (const f of I.farBatches) {
        const r = row(f.asset.id, '');
        r.inst += f.count;
        r.tris.add(f.triangles);
        r.total += f.count * f.triangles;
        r.meshes = String((Number(r.meshes) || 0) + 1);
      }
      for (const l of I.merged.perLot) {
        const r = row(l.assetId, 'merged');
        r.inst++;
        r.tris.add(l.triangles);
        r.total += l.triangles;
      }
      for (const l of I.mergedDressing?.perItem ?? []) {
        const r = row(l.assetId, 'merged');
        r.inst++;
        r.tris.add(l.triangles);
        r.total += l.triangles;
      }
      for (const [id, r] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
        stats[`budget.${qName}.${id}`] = `${r.inst} inst, ${[...r.tris].sort((a, b) => a - b).join('/')} tri/mesh, ${r.total} total, ${r.meshes || '?'} meshes`;
      }
    }

    // --- casters exclusive (needs the shadow map)
    if (qName === 'high') {
      const list = (): AbstractMesh[] => (look.shadows.map?.renderList ?? []) as AbstractMesh[];
      view.farShadows = true;
      props.update(view);
      // Permanently near meshes (gantry, single dressing) have no far twin
      // and cast in both modes: they cannot be drawn twice.
      const permanent = new Set(I.near.filter((b) => b.permanent).map((b) => b.mesh));
      const nearIn = props.nearMeshes.filter((m) => !permanent.has(m) && list().includes(m)).length;
      const farIn1 = props.farMeshes.filter((m) => list().includes(m)).length;
      view.farShadows = false;
      props.update(view);
      const farIn = props.farMeshes.filter((m) => list().includes(m)).length;
      const nearIn2 = props.nearMeshes.filter((m) => list().includes(m)).length;
      check(
        'casters.exclusive',
        `farShadows: ${nearIn} near / ${farIn1} far registered; near shadows: ${farIn} far / ${nearIn2} near registered`,
        'farShadows on: no near mesh with a far twin is a caster; off: no far mesh is',
        nearIn === 0 && farIn === 0 && farIn1 > 0 && nearIn2 > 0,
      );
    }

    // --- colliders
    if (qName === 'high') {
      let expected = 0;
      // Colliders use a fixed variant rule, never the preset's.
      for (const lot of data.plan.lots) expected += await colliderCount(lot.asset, lot.seed % COLLIDER_VARIANTS.building);
      for (const d of data.plan.dressing) expected += await colliderCount(d.asset, d.seed % COLLIDER_VARIANTS.dressing);
      for (const n of data.plan.nature) {
        const e = catalogEntry(n.asset);
        const cls: PropClass = e.category === 'tree' ? 'tree' : e.category === 'large-rock' ? 'largeRock' : e.category === 'small-rock' ? 'smallRock' : n.asset === 'v01-puff-bush' ? 'bush' : 'lowPlant';
        expected += await colliderCount(n.asset, n.seed % COLLIDER_VARIANTS[cls]);
      }
      check('colliders.count', `${props.stats.colliderShapes} child shapes, ${expected} expected`, 'child shapes = Σ over placements of their asset\'s collider count', props.stats.colliderShapes === expected && expected > 0);
      const hits = await colliderHits(scene, data);
      check('colliders.hit', hits.text, '5 trees, 3 large rocks, 3 buildings hit within catalog radius + 0.3 m', hits.pass);
    }

    // --- simplification per asset, for BOTH presets (quest ships). Bounds
    // and degenerate triangles are measured here from the mesh data, not
    // taken from the simplifier's own numbers.
    {
      const worst = new Map<string, { tris: number; target: number; bounds: number; degenerate: number; method: string }>();
      const note = (id: string, tris: number, target: number, bounds: number, degenerate: number, method: string): void => {
        const w = worst.get(id);
        if (!w) worst.set(id, { tris, target, bounds, degenerate, method });
        else {
          if (tris / target > w.tris / w.target) {
            w.tris = tris;
            w.target = target;
          }
          w.bounds = Math.max(w.bounds, bounds);
          w.degenerate += degenerate;
          if (!w.method.includes(method)) w.method += `+${method}`;
        }
      };
      for (const f of I.farBatches) {
        const src = prepareProp(f.asset, f.variant, f.scheme).mesh.data;
        const pos = f.mesh.getVerticesData('position') ?? new Float32Array(0);
        const idx = f.mesh.getIndices() ?? [];
        note(f.asset.id, idx.length / 3, f.target, measureBounds(src.positions, pos), countDegenerate(pos, idx), f.method);
      }
      // The merged far dressing: every (asset, variant, scheme) in it, its far
      // model measured the same way (the merged mesh holds exactly these).
      {
        const seen = new Set<string>();
        for (const it of I.mergedDressing.perItem) {
          const k = `${it.assetId}|${it.variant}|${it.scheme ?? ''}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const a = (await loadAsset(it.assetId)) as PropAsset;
          const src = prepareProp(a, it.variant, it.scheme).mesh.data;
          const out = farModel(a, it.variant, it.scheme, it.target).data;
          note(it.assetId, out.triangleCount, it.target, measureBounds(src.positions, out.positions), countDegenerate(out.positions, out.indices), it.method);
        }
      }
      // Lots are the first placements (worldProps pushes them first).
      for (let i = 0; i < data.plan.lots.length; i++) {
        if (!I.drawn[i]) continue;
        const lot = data.plan.lots[i];
        const a = (await loadAsset(lot.asset)) as PropAsset;
        const src = prepareProp(a, lot.seed, lot.scheme).mesh.data;
        const lotTarget = farBuildingTarget(lot.asset, q.farTriangles.building);
        const out = simplifyMesh(src, lotTarget);
        note(lot.asset, out.triangleCount, lotTarget, measureBounds(src.positions, out.positions), countDegenerate(out.positions, out.indices), I.merged.perLot.find((l) => l.assetId === lot.asset)?.method ?? '?');
      }
      // Assets that stay near permanently have no far mesh: simplify them here.
      for (const id of I.permanentAssets) {
        const a = (await loadAsset(id)) as PropAsset;
        const src = prepareProp(a, 0, a.schemes?.[0]).mesh.data;
        const r = simplifyWithInfo(src, q.farTriangles.dressing);
        note(id, r.data.triangleCount, q.farTriangles.dressing, measureBounds(src.positions, r.data.positions), countDegenerate(r.data.positions, r.data.indices), `${r.method} (permanent near)`);
      }
      const ids = new Set(I.assetId.filter((_, i) => I.drawn[i]));
      const prefix = qName === 'high' ? 'simplify.' : 'simplify.quest.';
      for (const id of [...ids].sort()) {
        const w = worst.get(id);
        if (!w) {
          check(`${prefix}${id}`, 'no far mesh', 'simplified', false);
          continue;
        }
        const ok = w.tris >= 4 && w.tris <= 1.15 * w.target && w.bounds <= 0.06 && w.degenerate === 0;
        check(`${prefix}${id}`, `${w.tris} / ${w.target} tris, bounds ${(w.bounds * 100).toFixed(1)} % (lab-measured), ${w.degenerate} degenerate, ${w.method}`, '4 ≤ tris ≤ 1.15 × target, bounds within 6 %, no degenerate triangle', ok);
      }
      // Thin parts keep their width: a trunk or pole stand-in no wider than
      // 1.5 × the source in a height band where only the trunk / pole is
      // seen (round 2: the pine's trunk became a slab between its tiers, the
      // quest lamp a plank — triangle count, bounds and degenerates all
      // passed). 0 = hidden inside the canopy, which is fine.
      const brown = (r: number, g: number, b: number): boolean => r > g * 1.2 && r > b * 1.2;
      const anyColour = (): boolean => true;
      const widthCases: { id: string; what: string; lo: number; hi: number; pick: (r: number, g: number, b: number) => boolean }[] = [
        { id: 't02-switchback-pine', what: 'trunk, 55–90 % of the height', lo: 0.55, hi: 0.9, pick: brown },
        { id: 't03-turbo-palm', what: 'trunk, 10–30 %', lo: 0.1, hi: 0.3, pick: brown },
        { id: 't01-rally-oak', what: 'trunk, 10–30 %', lo: 0.1, hi: 0.3, pick: brown },
        { id: 'd08-street-lamp', what: 'pole, 30–60 %', lo: 0.3, hi: 0.6, pick: anyColour },
      ];
      // Every far model of the asset that the world draws (each variant; the
      // round-2 check looked at the first far mesh only), worst ratio.
      for (const c of widthCases) {
        const models: { asset: PropAsset; variant: number; scheme: string | undefined; target: number }[] = [];
        for (const b of I.farBatches) if (b.asset.id === c.id) models.push({ asset: b.asset, variant: b.variant, scheme: b.scheme, target: b.target });
        for (const it of I.mergedDressing.perItem) {
          if (it.assetId !== c.id || models.some((q) => q.variant === it.variant && q.scheme === it.scheme)) continue;
          models.push({ asset: (await loadAsset(it.assetId)) as PropAsset, variant: it.variant, scheme: it.scheme, target: it.target });
        }
        if (models.length === 0) continue;
        let worst: { ratio: number; text: string; ok: boolean } | null = null;
        for (const q of models) {
          const src = prepareProp(q.asset, q.variant, q.scheme).mesh.data;
          const [y0, y1] = heightRange(src.positions);
          const ya = y0 + c.lo * (y1 - y0), yb = y0 + c.hi * (y1 - y0);
          const ws = bandWidth(src.positions, src.colors, src.indices, ya, yb, c.pick);
          const far = farModel(q.asset, q.variant, q.scheme, q.target).data;
          const wf = bandWidth(far.positions, far.colors, far.indices, ya, yb, c.pick);
          const ratio = wf / Math.max(ws, 1e-6);
          const ok = ws > 0 && ratio <= 1.5;
          const text = `${c.what}: source ${ws.toFixed(2)} m, far ${wf.toFixed(2)} m (× ${ratio.toFixed(2)}), variant ${q.variant} (worst of ${models.length})`;
          if (!worst || (worst.ok && (!ok || ratio > worst.ratio))) worst = { ratio, ok, text };
        }
        check(`${prefix}width.${c.id}`, worst!.text, 'far trunk / pole ≤ 1.5 × the source width in that band, every far variant', worst!.ok);
      }

      // DESIGNED far models (buildFar), every one the world draws — in far
      // batches and in the merged dressing. An earlier version of this check passed 113
      // of 113 with flags in the wrong colour and banners blank from behind:
      // bounds hold by construction (the model is fitted onto the near box),
      // so these three look at what the fit can hide.
      const designedModels: { asset: PropAsset; variant: number; scheme: string | undefined; target: number }[] = [];
      for (const b of I.farBatches) if (b.method === 'designed') designedModels.push({ asset: b.asset, variant: b.variant, scheme: b.scheme, target: b.target });
      {
        const seen = new Set<string>();
        for (const it of I.mergedDressing.perItem) {
          const k = `${it.assetId}|${it.variant}|${it.scheme ?? ''}`;
          if (it.method !== 'designed' || seen.has(k)) continue;
          seen.add(k);
          designedModels.push({ asset: (await loadAsset(it.assetId)) as PropAsset, variant: it.variant, scheme: it.scheme, target: it.target });
        }
      }
      {
        // Drawn designed: every kind that HAS a designed far model is drawn
        // with it — a builder that throws or runs over the limit falls back
        // to the simplifier and would drop out of every check below.
        const fallen: string[] = [];
        let kinds = 0;
        for (const b of I.farBatches) {
          if (!b.asset.buildFar) continue;
          kinds++;
          if (b.method !== 'designed') fallen.push(`${b.asset.id}${b.scheme ? `:${b.scheme}` : ''} #${b.variant} (${b.method})`);
        }
        for (const it of I.mergedDressing.perItem) {
          const a = (await loadAsset(it.assetId)) as PropAsset;
          if (!a.buildFar) continue;
          kinds++;
          if (it.method !== 'designed') fallen.push(`${it.assetId}${it.scheme ? `:${it.scheme}` : ''} #${it.variant} (${it.method})`);
        }
        check(`${prefix}designed.drawn`, fallen.length ? `${fallen.length} of ${kinds} fell back: ${fallen.slice(0, 4).join(', ')}` : `${kinds} of ${kinds} drawn designed`, 'every far model of a kind with buildFar is the designed one (no silent simplifier fallback)', fallen.length === 0);
      }
      {
        // Seen from the diorama's angle: 45° down from each of the four
        // sides, back faces culled as the far shader does, the far model's
        // visible footprint against the near model's. A later version
        // passed everything with quest fence rails that were two vertical
        // cards (0.33–0.47 here): wires from above, nothing along the run.
        const DIRS: [string, number[]][] = [['−z', [0, 1, -1]], ['+z', [0, 1, 1]], ['−x', [-1, 1, 0]], ['+x', [1, 1, 0]]];
        let worst: { r: number; text: string } | null = null;
        for (const q of designedModels) {
          const src = prepareProp(q.asset, q.variant, q.scheme).mesh.data;
          const far = farModel(q.asset, q.variant, q.scheme, q.target).data;
          for (const [nm, d] of DIRS) {
            const a = viewCover(src.positions, src.indices, d, 64);
            const b = viewCover(far.positions, far.indices, d, 64, a.box);
            let cn = 0;
            let cf = 0;
            for (let i = 0; i < a.cells.length; i++) {
              cn += a.cells[i];
              cf += b.cells[i];
            }
            const r = cf / Math.max(cn, 1);
            if (!worst || r < worst.r) worst = { r, text: `${q.asset.id}${q.scheme ? `:${q.scheme}` : ''} #${q.variant} from ${nm}: ${r.toFixed(2)}` };
          }
        }
        if (worst) check(`${prefix}designed.view45`, `worst ${worst.text} of ${designedModels.length} designed models`, 'seen 45° down from each side, back faces culled: far visible footprint ≥ 0.55 of the near one', worst.r >= 0.55);
      }
      {
        // Coverage: the far model's silhouette covers at least half of the
        // near model's (the simplifier's own measure, three views).
        let worst: { cov: number; text: string } | null = null;
        // Stretch: how far the fit had to pull the model — dressing is
        // built to its near box (thin posts would fatten), plants and trees
        // may be pulled a little more.
        let worstDress: { s: number; text: string } | null = null;
        let worstOther: { s: number; text: string } | null = null;
        for (const q of designedModels) {
          const r = farModel(q.asset, q.variant, q.scheme, q.target);
          const name = `${q.asset.id}${q.scheme ? `:${q.scheme}` : ''} #${q.variant}`;
          if (!worst || r.silhouette < worst.cov) worst = { cov: r.silhouette, text: `${name} ${r.silhouette.toFixed(2)}` };
          if (q.asset.category === 'dressing') {
            if (!worstDress || r.stretch > worstDress.s) worstDress = { s: r.stretch, text: `${name} × ${r.stretch.toFixed(2)}` };
          } else if (!worstOther || r.stretch > worstOther.s) worstOther = { s: r.stretch, text: `${name} × ${r.stretch.toFixed(2)}` };
        }
        if (designedModels.length) {
          check(`${prefix}designed.coverage`, `worst ${worst!.text} of ${designedModels.length} designed models`, 'far silhouette ≥ 0.5 of the near one, every designed far model', worst!.cov >= 0.5);
          check(
            `${prefix}designed.stretch`,
            `dressing worst ${worstDress?.text ?? '-'}, others worst ${worstOther?.text ?? '-'}`,
            'fit stretch ≤ 1.15 for dressing (merged models included), ≤ 1.4 for plants and trees',
            (worstDress?.s ?? 1) <= 1.15 && (worstOther?.s ?? 1) <= 1.4,
          );
        }
      }
      {
        // Cloth: every flag / banner / banner fence the world draws, seen
        // from the front AND from behind — the far field colour is the near
        // one and the checks show on both faces.
        const CLOTH_ASSETS = new Set(['d03-flag-pole', 'd21-checker-banner', 'd07-wood-fence']);
        let worst: { bad: number; dc: number; text: string } | null = null;
        let cases = 0;
        let failed = 0;
        for (const q of designedModels) {
          if (!CLOTH_ASSETS.has(q.asset.id) || (q.asset.id === 'd07-wood-fence' && q.scheme !== 'banner')) continue;
          const near = q.asset.build(q.variant, q.scheme);
          const far = q.asset.buildFar!(q.variant, q.scheme, q.target);
          const region = whiteBox(near.positions, near.cornerColors);
          if (!region) continue;
          for (const dir of [-1, 1]) {
            cases++;
            const a = clothFace(near.positions, near.cornerColors, region, dir);
            const b = clothFace(far.positions, far.cornerColors, region, dir);
            const dc = a.field && b.field ? Math.hypot(a.field[0] - b.field[0], a.field[1] - b.field[1], a.field[2] - b.field[2]) : 1;
            const whiteOk = a.white <= 0.02 || b.white >= 0.4 * a.white;
            const ok = dc <= 0.06 && whiteOk;
            if (!ok) failed++;
            const badness = (dc > 0.06 ? dc : 0) + (whiteOk ? 0 : 1);
            const fmt = (c: number[] | null): string => (c ? c.map((v) => v.toFixed(2)).join(',') : 'none');
            const text = `${q.asset.id}${q.scheme ? `:${q.scheme}` : ''} #${q.variant} ${dir < 0 ? '−z' : '+z'} face: field near ${fmt(a.field)} far ${fmt(b.field)} (Δ ${dc.toFixed(3)}), checks ${(a.white * 100).toFixed(0)} % → ${(b.white * 100).toFixed(0)} %`;
            // Worst = most off; among equally passing faces, the largest colour difference.
            if (!worst || badness > worst.bad || (badness === worst.bad && dc > worst.dc)) worst = { bad: badness, dc, text };
          }
        }
        if (cases) check(`${prefix}designed.cloth`, `${failed} of ${cases} faces off; worst ${worst!.text}`, 'flags and banners, both faces: far field colour within 0.06 of the near one, far checks ≥ 0.4 × the near share', failed === 0);
      }
    }
    if (qName === 'high') {
      const methods: Record<string, number> = {};
      for (const f of I.farBatches) methods[`${f.asset.id}${f.scheme ? `:${f.scheme}` : ''}`] = f.method === 'hull' ? 1 : f.method === 'designed' ? 2 : 0;
      for (const it of I.mergedDressing.perItem) methods[`${it.assetId}${it.scheme ? `:${it.scheme}` : ''}`] = it.method === 'hull' ? 1 : it.method === 'designed' ? 2 : 0;
      stats['high.hullAssets'] = Object.entries(methods).filter(([, v]) => v === 1).map(([k]) => k).join(' ');
      stats['high.designedAssets'] = Object.entries(methods).filter(([, v]) => v === 2).map(([k]) => k).join(' ');
      stats['high.designedStretchMax'] = r2(Math.max(1, ...I.farBatches.map((f) => f.stretch)));
      stats['high.permanentNear'] = I.permanentAssets.join(' ');
      stats['high.skippedAssets'] = I.skippedAssets.join(' ');

      const car = (await loadAsset('reef-rocket')) as CarAsset;
      const body = prepareCar(car, 0).body;
      const target = Math.round(body.triangles * 0.12);
      const tc = performance.now();
      const r = simplifyWithInfo(body.data, target);
      stats['car.simplifyMs'] = r2(performance.now() - tc);
      check('simplify.car', `${body.triangles} → ${r.data.triangleCount} / ${target}, bounds ${(r.boundsError * 100).toFixed(1)} %, ${r.method}, silhouette ${r.silhouette.toFixed(2)}`, '≤ 1.15 × target, bounds within 6 %', r.data.triangleCount <= 1.15 * target && r.data.triangleCount >= 4 && r.boundsError <= 0.06);
    }

    // --- frames
    const villageS = track.resolve('village');
    const spots: { name: string; mode: 'chase' | 'high' | 'xr'; s: number }[] = [
      { name: 'chase_s0', mode: 'chase', s: 0 },
      { name: 'chase_village', mode: 'chase', s: villageS },
      { name: 'chase_half', mode: 'chase', s: track.length / 2 },
      { name: 'high_village', mode: 'high', s: villageS },
      { name: 'xr', mode: 'xr', s: 0 },
    ];
    for (const sp of spots) {
      setStatus(`${qName}: frame ${sp.name}`);
      const p = track.at(sp.s);
      if (sp.mode === 'xr') {
        const o = cams.orbit;
        const t = CAMERA_TUNING.xr;
        o.target.set(0, 0, 0);
        o.alpha = -Math.PI / 2;
        o.beta = Math.atan2(t.back, t.eyeHeight);
        o.radius = Math.hypot(t.back, t.eyeHeight);
        scene.activeCamera = o;
        Object.assign(view, { x: 0, z: 0, nearRadius: 0, buildingRadius: 0, farDetail: true, farShadows: true });
        look.shadows.region = LOOK_VIEWS.diorama.shadowRegion;
        look.config.fogDensity = LOOK_VIEWS.diorama.fogDensity;
        look.shadows.setFocus({ x: 0, y: 0, z: 0 });
      } else {
        poseFollow(cams.follow, p, sp.mode, heightAt, 0, null);
        scene.activeCamera = cams.follow;
        Object.assign(view, { x: p.x, z: p.z, nearRadius: q.nearRadius, buildingRadius: q.buildingRadius, farDetail: false, farShadows: false });
        look.shadows.region = LOOK_VIEWS.chase.shadowRegion;
        look.config.fogDensity = LOOK_VIEWS.chase.fogDensity;
        look.shadows.setFocus(p);
      }
      props.update(view);
      const f = measure();
      stats[`frame.${sp.name}.${qName}.drawCalls`] = f.drawCalls;
      stats[`frame.${sp.name}.${qName}.triangles`] = f.triangles;
      stats[`frame.${sp.name}.${qName}.shadowDrawCalls`] = f.shadowDrawCalls;
      stats[`frame.${sp.name}.${qName}.shadowTriangles`] = f.shadowTriangles;
      stats[`frame.${sp.name}.${qName}.nearActive`] = props.stats.nearActive;
      stats[`frame.${sp.name}.${qName}.farActive`] = props.stats.farActive;
      stats[`frame.${sp.name}.${qName}.casterTriangles`] = props.stats.casterTriangles;
    }

    // --- all of WorldPropsStats, flattened (after a chase update at s = 0)
    const p0 = track.at(0);
    Object.assign(view, { x: p0.x, z: p0.z, nearRadius: q.nearRadius, buildingRadius: q.buildingRadius, farDetail: false, farShadows: false });
    props.update(view);
    flattenStats(stats, qName, props.stats);
    stats[`${qName}.nearBatchesExisting`] = props.nearMeshes.length;

    props.dispose();
    await new Promise((r) => setTimeout(r));
  }
  stats['boot.totalMs'] = r2(performance.now() - tBoot);

  const lines: string[] = [];
  for (const [k, v] of Object.entries(stats)) if (!k.includes('.perAsset.')) lines.push(`${k.padEnd(44)} ${v}`);
  for (const c of checks) lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(30)} ${c.value}  (${c.target})`);
  const report: LabReport = {
    page: 'props-lab',
    query: location.search.replace(/^\?/, ''),
    totals: { simSeconds: 0 },
    scorecard: { text: lines.join('\n') },
    errors: [],
    stats,
    checks,
  };
  if (resultEl) resultEl.textContent = JSON.stringify(report);
  setStatus('done');
  document.title = 'done';
}

/** Largest per-axis bounding-box deviation of `out` from `src`, as a
 * fraction of the source extent (an axis thinner than 2 % of the largest
 * one is measured against that 2 %). */
/** Lowest and highest y of a position array. */
type ClothBox = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/** Box round the near model's white (check) faces — the cloth: 15 % wider
 * and taller, 1.5 cm deeper (so rails and posts behind it stay out). */
/** Coverage of the view from direction D (toward the viewer) of
 * indexed vertex data in Babylon's reversed order (front face:
 * cross(b − a, c − a)·D < 0), on an N × N grid over `box` (default: this
 * mesh's own extent in the view plane). */
function viewCover(P: ArrayLike<number>, I: ArrayLike<number>, D: readonly number[], N: number, box?: number[]): { cells: Uint8Array; box: number[] } {
  const L = Math.hypot(D[0], D[1], D[2]);
  const d = [D[0] / L, D[1] / L, D[2] / L];
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = u.map((v) => v / ul);
  const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const pu = (i: number): number => P[i * 3] * u[0] + P[i * 3 + 1] * u[1] + P[i * 3 + 2] * u[2];
  const pw = (i: number): number => P[i * 3] * w[0] + P[i * 3 + 1] * w[1] + P[i * 3 + 2] * w[2];
  if (!box) {
    box = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < P.length / 3; i++) {
      box[0] = Math.min(box[0], pu(i)); box[1] = Math.max(box[1], pu(i));
      box[2] = Math.min(box[2], pw(i)); box[3] = Math.max(box[3], pw(i));
    }
  }
  const s = Math.max(box[1] - box[0], box[3] - box[2], 1e-6) / N;
  const cells = new Uint8Array(N * N);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= 0) continue; // reversed order: back face
    const U = [pu(a), pu(b), pu(c)].map((v) => (v - box![0]) / s);
    const W = [pw(a), pw(b), pw(c)].map((v) => (v - box![2]) / s);
    const ar = (U[1] - U[0]) * (W[2] - W[0]) - (W[1] - W[0]) * (U[2] - U[0]);
    if (Math.abs(ar) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor(Math.min(U[0], U[1], U[2]))), i1 = Math.min(N - 1, Math.ceil(Math.max(U[0], U[1], U[2])));
    const j0 = Math.max(0, Math.floor(Math.min(W[0], W[1], W[2]))), j1 = Math.min(N - 1, Math.ceil(Math.max(W[0], W[1], W[2])));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const x = i + 0.5, y = j + 0.5;
        const l0 = ((U[2] - U[1]) * (y - W[1]) - (W[2] - W[1]) * (x - U[1])) / ar;
        const l1 = ((U[0] - U[2]) * (y - W[2]) - (W[0] - W[2]) * (x - U[2])) / ar;
        if (l0 >= 0 && l1 >= 0 && 1 - l0 - l1 >= 0) cells[i * N + j] = 1;
      }
    }
  }
  return { cells, box };
}

function whiteBox(P: ArrayLike<number>, C: ArrayLike<number>): ClothBox | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const c = [0, 1, 2].map((k) => (C[o + k] + C[o + 3 + k] + C[o + 6 + k]) / 3);
    if (!(c[0] > 0.8 && c[1] > 0.8 && c[2] > 0.7)) continue;
    for (let v = 0; v < 3; v++) {
      x0 = Math.min(x0, P[o + v * 3]);
      x1 = Math.max(x1, P[o + v * 3]);
      y0 = Math.min(y0, P[o + v * 3 + 1]);
      y1 = Math.max(y1, P[o + v * 3 + 1]);
      z0 = Math.min(z0, P[o + v * 3 + 2]);
      z1 = Math.max(z1, P[o + v * 3 + 2]);
    }
  }
  if (!Number.isFinite(x0)) return null;
  const mx = 0.15 * (x1 - x0), my = 0.15 * (y1 - y0);
  return { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my, z0: z0 - 0.015, z1: z1 + 0.015 };
}

/** The faces inside `box` that face `dirZ` (n.z · dirZ > 0.7): share of
 * white area against the dominant non-white colour (area-weighted 0.1-RGB
 * bins; field = mean of the faces within 0.12 of the top bin). */
function clothFace(P: ArrayLike<number>, C: ArrayLike<number>, box: ClothBox, dirZ: number): { white: number; field: [number, number, number] | null } {
  const faces: { c: number[]; a: number }[] = [];
  let white = 0;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
    const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const a2 = Math.hypot(nx, ny, nz);
    if (a2 < 1e-9 || (nz / a2) * dirZ < 0.7) continue;
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cy = (P[o + 1] + P[o + 4] + P[o + 7]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    if (cx < box.x0 || cx > box.x1 || cy < box.y0 || cy > box.y1 || cz < box.z0 || cz > box.z1) continue;
    const c = [0, 1, 2].map((k) => (C[o + k] + C[o + 3 + k] + C[o + 6 + k]) / 3);
    if (c[0] > 0.8 && c[1] > 0.8 && c[2] > 0.7) white += a2 / 2;
    else faces.push({ c, a: a2 / 2 });
  }
  const bins = new Map<string, number>();
  for (const f of faces) {
    const k = f.c.map((v) => Math.floor(v * 10)).join(',');
    bins.set(k, (bins.get(k) ?? 0) + f.a);
  }
  let top = '', best = -1;
  for (const [k, a] of bins) if (a > best) [top, best] = [k, a];
  if (best <= 0) return { white: white > 0 ? 1 : 0, field: null };
  const centre = top.split(',').map((v) => (Number(v) + 0.5) / 10);
  const sum = [0, 0, 0];
  let area = 0;
  for (const f of faces) {
    if (Math.hypot(f.c[0] - centre[0], f.c[1] - centre[1], f.c[2] - centre[2]) > 0.12) continue;
    for (let k = 0; k < 3; k++) sum[k] += f.c[k] * f.a;
    area += f.a;
  }
  return { white: white / Math.max(1e-9, white + area), field: area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : null };
}

function heightRange(p: ArrayLike<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    lo = Math.min(lo, p[i]);
    hi = Math.max(hi, p[i]);
  }
  return [lo, hi];
}

/** Horizontal width (max of the x and z extents) of the faces of one colour
 * class inside the height band [y0, y1] — edges sampled, enough for an extent. */
function bandWidth(P: ArrayLike<number>, C: ArrayLike<number>, I: ArrayLike<number>, y0: number, y1: number, pick: (r: number, g: number, b: number) => boolean): number {
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    const v = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const r = (C[v[0] * 4] + C[v[1] * 4] + C[v[2] * 4]) / 3, g = (C[v[0] * 4 + 1] + C[v[1] * 4 + 1] + C[v[2] * 4 + 1]) / 3, b = (C[v[0] * 4 + 2] + C[v[1] * 4 + 2] + C[v[2] * 4 + 2]) / 3;
    if (!pick(r, g, b)) continue;
    for (let e = 0; e < 3; e++) {
      const a = v[e] * 3, c = v[(e + 1) % 3] * 3;
      for (let s = 0; s <= 16; s++) {
        const k = s / 16;
        const y = P[a + 1] + (P[c + 1] - P[a + 1]) * k;
        if (y < y0 || y > y1) continue;
        const x = P[a] + (P[c] - P[a]) * k, z = P[a + 2] + (P[c + 2] - P[a + 2]) * k;
        mnx = Math.min(mnx, x);
        mxx = Math.max(mxx, x);
        mnz = Math.min(mnz, z);
        mxz = Math.max(mxz, z);
      }
    }
  }
  return mxx > mnx ? Math.max(mxx - mnx, mxz - mnz) : 0;
}

function measureBounds(src: ArrayLike<number>, out: ArrayLike<number>): number {
  const box = (p: ArrayLike<number>): number[][] => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], p[i + k]);
        mx[k] = Math.max(mx[k], p[i + k]);
      }
    }
    return [mn, mx];
  };
  const [smn, smx] = box(src);
  const [omn, omx] = box(out);
  const big = Math.max(smx[0] - smn[0], smx[1] - smn[1], smx[2] - smn[2]);
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const e = Math.max(smx[k] - smn[k], 0.02 * big, 1e-6);
    worst = Math.max(worst, Math.abs(omn[k] - smn[k]) / e, Math.abs(omx[k] - smx[k]) / e);
  }
  return worst;
}

/** Triangles with (numerically) zero area. */
function countDegenerate(p: ArrayLike<number>, idx: ArrayLike<number>): number {
  let n = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    if (!(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 > 1e-9)) n++;
  }
  return n;
}

function flattenStats(out: Record<string, ReportValue>, prefix: string, s: WorldPropsStats): void {
  for (const [k, v] of Object.entries(s)) {
    if (k === 'perAsset') {
      for (const [id, [full, far, n]] of Object.entries(v as WorldPropsStats['perAsset'])) {
        out[`${prefix}.perAsset.${id}.full`] = full;
        out[`${prefix}.perAsset.${id}.far`] = far;
        out[`${prefix}.perAsset.${id}.placements`] = n;
      }
    } else {
      out[`${prefix}.${k}`] = typeof v === 'number' ? Math.round(v * 100) / 100 : (v as ReportValue);
    }
  }
}

const colliderCache = new Map<string, number>();
async function colliderCount(id: string, variant: number): Promise<number> {
  const key = `${id}|${variant}`;
  const hit = colliderCache.get(key);
  if (hit !== undefined) return hit;
  let n = 0;
  try {
    const a = (await loadAsset(id)) as PropAsset;
    n = a.colliders?.(variant).length ?? 0;
  } catch {
    n = 0;
  }
  colliderCache.set(key, n);
  return n;
}

/** Independent recount of the tier partition from the internals: the near
 * set is what the near buffers hold; the far set is what the far shaders
 * draw — every drawn placement with a far mesh, outside the ring (same
 * float32 test, same uploaded ring). */
function partition(I: WorldPropsInternals): { bad: number; text: string } {
  const inNear = new Uint8Array(I.count);
  let dupNear = 0;
  for (const b of I.near) {
    for (let k = 0; k < b.count; k++) {
      const i = b.items[k];
      if (inNear[i]) dupNear++;
      inNear[i] = 1;
    }
  }
  let both = 0, missing = 0, ghost = 0, drawn = 0;
  for (let i = 0; i < I.count; i++) {
    if (!I.drawn[i]) {
      if (inNear[i]) ghost++;
      continue;
    }
    drawn++;
    let far = false;
    if (I.cls[i] === 6) far = !ringInside(I.x[i], I.z[i], I.buildingRing) && I.merged.mesh !== null;
    else if (I.farMergedDressing[i]) far = I.mergedDressing.mesh !== null && I.mergedDressing.mesh.isEnabled(false) && !ringInside(I.x[i], I.z[i], I.propsRing);
    else if (I.far[i] >= 0) far = I.farBatches[I.far[i]].mesh.isEnabled(false) && !ringInside(I.x[i], I.z[i], I.propsRing);
    if (far && inNear[i]) both++;
    if (!far && !inNear[i]) missing++;
  }
  const bad = both + missing + ghost + dupNear;
  return { bad, text: `drawn ${drawn}: in both ${both}, in neither ${missing}, undrawn in near ${ghost}, duplicated ${dupNear}` };
}

async function colliderHits(scene: Scene, data: WorldData): Promise<{ pass: boolean; text: string }> {
  const pe = scene.getPhysicsEngine() as PhysicsEngineV2;
  // Havok reports one hit per ray by default; the test wants them all.
  (pe.getPhysicsPlugin() as HavokPlugin).setMaxQueryCollectorHits(32);
  // One frame so every static body is in the broadphase.
  scene.render();
  interface Solid {
    x: number;
    z: number;
    r: number;
  }
  interface Target extends Solid {
    y: number;
    h: number;
    id: string;
  }
  const solid: Solid[] = [];
  const trees: Target[] = [];
  const rocks: Target[] = [];
  const buildings: Target[] = [];
  for (const l of data.plan.lots) {
    const r = catalogEntry(l.asset).collisionRadius;
    solid.push({ x: l.x, z: l.z, r });
    buildings.push({ x: l.x, z: l.z, r, y: l.y, h: 1.2, id: l.asset });
  }
  for (const d of data.plan.dressing) {
    const r = catalogEntry(d.asset).collisionRadius * d.scale;
    if (r > 0) solid.push({ x: d.x, z: d.z, r });
  }
  for (const n of data.plan.nature) {
    const e = catalogEntry(n.asset);
    const r = e.collisionRadius * n.scale;
    if (r <= 0) continue;
    solid.push({ x: n.x, z: n.z, r });
    if (e.category === 'tree') trees.push({ x: n.x, z: n.z, r, y: n.y, h: 1.0, id: n.asset });
    else if (e.category === 'large-rock') rocks.push({ x: n.x, z: n.z, r, y: n.y, h: 0.5 * n.scale, id: n.asset });
  }
  // A ray is fair when nothing else with a collider stands near its path:
  // the test is whether the TARGET's collider is there, not what hides it.
  const START = 3;
  const cleanDir = (t: Target): [number, number] | null => {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const dx = Math.cos(a), dz = Math.sin(a);
      const len = t.r + START;
      let clean = true;
      for (const o of solid) {
        if (o.x === t.x && o.z === t.z) continue;
        const px = o.x - t.x, pz = o.z - t.z;
        const along = Math.min(len, Math.max(0, px * dx + pz * dz));
        if (Math.hypot(px - dx * along, pz - dz * along) < o.r + 0.6) {
          clean = false;
          break;
        }
      }
      if (clean) return [dx, dz];
    }
    return null;
  };
  const pick = (list: Target[], n: number): { t: Target; d: [number, number] }[] => {
    const ok: { t: Target; d: [number, number] }[] = [];
    for (const t of list) {
      const d = cleanDir(t);
      if (d) ok.push({ t, d });
    }
    const out: { t: Target; d: [number, number] }[] = [];
    for (let k = 0; k < n && ok.length; k++) out.push(ok[Math.floor((k * ok.length) / n)]);
    return out;
  };
  const targets = [...pick(trees, 5), ...pick(rocks, 3), ...pick(buildings, 3)];
  // Through the target and out the far side; every hit along the ray
  // counts (a ray that starts inside another shape, or meets an open garage
  // bay first, still finds the target's own collider if it is there).
  let hits = 0;
  const parts: string[] = [];
  for (const { t, d } of targets) {
    const start = t.r + START;
    const from = new Vector3(t.x + d[0] * start, t.y + t.h, t.z + d[1] * start);
    const to = new Vector3(t.x - d[0] * start, t.y + t.h, t.z - d[1] * start);
    const all = pe.raycastMulti(from, to);
    let dist = Infinity;
    for (const r of all) if (r.hasHit) dist = Math.min(dist, Math.hypot(r.hitPointWorld.x - t.x, r.hitPointWorld.z - t.z));
    const ok = dist <= t.r + 0.3;
    if (ok) hits++;
    parts.push(`${t.id.slice(0, 3)}@${t.x.toFixed(0)},${t.z.toFixed(0)} ${Number.isFinite(dist) ? dist.toFixed(2) : 'miss'}/${(t.r + 0.3).toFixed(2)}`);
  }
  return { pass: targets.length === 11 && hits === targets.length, text: `${hits}/${targets.length} hit: ${parts.join(', ')}` };
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  setStatus(`error: ${message}`);
  document.body.classList.add('failed');
  if (reportMode && resultEl) {
    const report: LabReport = {
      page: 'props-lab',
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

