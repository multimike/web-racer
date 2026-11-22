import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Effect,
  Engine,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  Viewport,
} from '@babylonjs/core';
import type { AbstractMesh, Material, Mesh } from '@babylonjs/core';
import { assembleSettings, carContact, instantiateCar, instantiateProp, prepareProp, toyMaterial } from '../assets/assemble';
import type { CarInstance, CarPart, PreparedMesh } from '../assets/assemble';
import { listAssetEntries, loadAsset } from '../assets/registry';
import type { Asset, CarAsset, ColliderSpec, PropAsset } from '../assets/types';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, createLook } from '../gfx/look/lighting';
import type { LookRuntime, ShadowQuality } from '../gfx/look/lighting';
import type { SolidMesh } from '../gfx/solid/SolidMesh';
import { SUN_DIR } from '../terrain/generateTerrain';

/**
 * Asset lab (asset-lab.html) — review any registered asset exactly as the
 * game will draw it: same builders, same assembler (`assets/assemble.ts`),
 * same toy shader, sun shadows and sky fill. Blueprint layout (front / top /
 * side orthographic + a ¾ view) over a spec table that measures the built
 * geometry against the asset's own numbers and flags what is out of
 * tolerance.
 *
 * URL parameters
 *   asset=<id>            any id from src/assets/{cars,props,buildings}
 *   seed=<n>              prop variant (default 0)        scheme=<name>
 *   livery=<n>            car livery (default 0)
 *   variants=<n>          n seeds (props) / liveries (cars) side by side, starting at seed / livery
 *   view=quad|hero|turntable|sheet|front|side|top|rear   (default quad; sheet = 8 yaws in one picture)
 *   yaw=<deg> pitch=<deg> zoom=<f>   hero camera. yaw 0 = camera on the −z side (a car's rear, a
 *                         building's front); positive yaw orbits it to the right (90 = on +x,
 *                         180 = on +z). Negative pitch looks from below.
 *   target=<x,y,z>        aim every view at this MODEL-space point instead of the centre
 *   dist=<m>              hero camera distance from its target (default: fit, then zoom)
 *   focus=<name>          frame only the meshes whose name contains this — car part groups
 *                         (body, wheel, upright, link, spinner, steeringWheel) or one mesh
 *                         (wheelFL, link3, uprightRR …). Close-ups: focus=wheelFR&zoom=1.5,
 *                         or target=0.4,0.9,1.6&dist=1.2
 *   bg=studio|blueprint|scene   studio: grey floor receiving sun shadows (default for single
 *                         views); blueprint: transparent over the page grid (default for quad);
 *                         scene: sky dome + grass ground + game fog
 *   steer=<deg> bump=<m>  cars: pose the wheels so links can be checked (bump > 0 = compression;
 *                         the body moves, the tires stay on the floor)
 *   run=1                 cars: animate wheels, suspension, steering, spinners
 *   driver=0              cars: hide the driver figure
 *   spin=1                orbit the hero camera        wire=1   wireframe
 *   debug=albedo|normal|shadow|ao|light|backface        inspection views (backface: magenta = seen from inside)
 *   ao=0                  skip the AO bake             shadows=off|1024|2048   region=<m>
 *   sun=<azimuth>,<elevation>   degrees, azimuth as yaw (where the sun stands)
 *   colliders=1           props: draw the gameplay colliders
 *   contact=0             cars: no contact pool on the floor
 *   ui=0                  picture only (no header, panel or labels)
 *   <any LookConfig key>=<number | r,g,b>   e.g. exposure=1.1
 *
 * Headless (tools/shot.sh): the page builds and renders synchronously as
 * soon as the asset module has loaded, then sets `window.__lab.ready`; the
 * report is also written into <script id="lab-report"> for --dump-dom.
 */

type ViewMode = 'quad' | 'hero' | 'turntable' | 'sheet' | 'front' | 'side' | 'top' | 'rear';
type Background = 'studio' | 'blueprint' | 'scene';
type OrthoAxis = 'front' | 'rear' | 'side' | 'top';
type RGB = [number, number, number];

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const raw = params.get(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const oneOf = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
  const raw = params.get(key) as T | null;
  return raw !== null && options.includes(raw) ? raw : fallback;
};
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const VIEW = oneOf<ViewMode>('view', ['quad', 'hero', 'turntable', 'sheet', 'front', 'side', 'top', 'rear'], 'quad');
const BG = oneOf<Background>('bg', ['studio', 'blueprint', 'scene'], VIEW === 'quad' ? 'blueprint' : 'studio');
const DEBUG = params.get('debug') ?? '';
const UI = params.get('ui') !== '0';
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Problems are shown IN the page: a headless screenshot has no console.

const problemsEl = el<HTMLPreElement>('problems');
const fatalEl = el<HTMLPreElement>('fatal');
const problems: string[] = [];

function problem(kind: string, message: string): void {
  if (problems.length >= 8) return;
  problems.push(`${kind}: ${message.slice(0, 500)}`);
  problemsEl.textContent = problems.join('\n');
  lab.problems = problems;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n\n${error.stack ?? ''}`;
  return String(error);
}

/** The asset could not be shown at all: replace the canvas with the reason. */
function fatal(what: string, error: unknown): void {
  fatalEl.textContent = `${what}\n\n${describe(error)}`;
  lab.error = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  lab.ready = true;
  publish();
  consoleError(what, error);
}

window.addEventListener('error', (e) => problem('error', e.message));
window.addEventListener('unhandledrejection', (e) => problem('rejection', describe(e.reason)));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  // Babylon reports shader compile errors here.
  problem('console.error', args.map(String).join(' '));
  consoleError(...args);
};

// ---------------------------------------------------------------------------
// Report — what the spec table shows, also as JSON for headless checks.

interface Check {
  label: string;
  /** Meters for unit 'mm' (shown as millimetres); a count otherwise. */
  value: number | string;
  unit?: 'mm' | 'tris' | 'ms' | '';
  target?: number;
  /** Pass band around the target (lengths), or undefined for "≤ target". */
  tolerance?: number;
  /** undefined = information only. */
  pass?: boolean;
  note?: string;
  /** Show the value across both columns (it carries its own verdict). */
  freeText?: boolean;
}

interface Report {
  asset: string;
  kind: 'prop' | 'car';
  seed?: number;
  scheme?: string;
  livery?: number;
  triangles: number;
  drawCalls: number;
  checks: Check[];
  failed: string[];
  pass: boolean;
  timings: { buildMs: number; aoMs: number; finalizeMs: number };
}

interface Lab {
  ready: boolean;
  frames: number;
  error: string | null;
  problems: string[];
  report: Report | null;
  [key: string]: unknown;
}

const lab: Lab = { ready: false, frames: 0, error: null, problems: [], report: null };
(window as unknown as { __lab: Lab }).__lab = lab;

function publish(): void {
  const payload = { ready: lab.ready, error: lab.error, problems: lab.problems, report: lab.report };
  el<HTMLScriptElement>('lab-report').textContent = JSON.stringify(payload);
  document.body.dataset.ready = lab.ready ? '1' : '0';
}

const length = (label: string, value: number, target: number, tolerance: number): Check => ({
  label,
  value,
  unit: 'mm',
  target,
  tolerance,
  pass: Math.abs(value - target) <= tolerance + 1e-6,
});
const info = (label: string, value: number | string, unit: Check['unit'] = ''): Check => ({ label, value, unit });
const must = (label: string, value: number | string, pass: boolean, note?: string): Check => ({ label, value, pass, note });

// ---------------------------------------------------------------------------
// Geometry audit (SolidMesh level)

interface Audit {
  /** Edges with a face on one side only: the rim of an open surface (a plate
   * built with `back: false`, a leaf card, an un-thickened shell).
   * Information — legitimate, but every one is a place you can see inside. */
  boundaryEdges: number;
  /** Edges that two faces walk in the SAME direction: the two faces point
   * opposite ways across the edge, i.e. one of them is inside-out (a flipped
   * cap, a patch with reversed winding). Always a defect. */
  flippedEdges: number;
  /** Closed shells (no boundary, consistent winding) whose volume is
   * negative: an entire part built inside-out. */
  insideOut: number;
  /** Connected shells in the mesh. */
  shells: number;
  /** Corners whose shading normal points away from their own face. */
  badNormals: number;
  /** Signed volume, m³. */
  volume: number;
}

function audit(m: SolidMesh): Audit {
  const N = m.computeNormals();
  const P = m.positions;
  const T = m.triangleCount;
  const edges = new Map<number, number>();
  const owner = new Map<number, number>();
  const K = N.weldCount + 1;
  let volume = 0;
  let badNormals = 0;
  // Shells: triangles joined through shared edges (either direction).
  const parent = new Int32Array(T);
  for (let t = 0; t < T; t++) parent[t] = t;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const vol = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    vol[t] =
      (P[o] * (P[o + 4] * P[o + 8] - P[o + 5] * P[o + 7]) -
        P[o + 1] * (P[o + 3] * P[o + 8] - P[o + 5] * P[o + 6]) +
        P[o + 2] * (P[o + 3] * P[o + 7] - P[o + 4] * P[o + 6])) /
      6;
    volume += vol[t];
    for (let k = 0; k < 3; k++) {
      const a = N.weld[t * 3 + k];
      const b = N.weld[t * 3 + ((k + 1) % 3)];
      edges.set(a * K + b, (edges.get(a * K + b) ?? 0) + 1);
      const u = a < b ? a * K + b : b * K + a;
      const first = owner.get(u);
      if (first === undefined) owner.set(u, t);
      else parent[find(t)] = find(first);
      const c = t * 3 + k;
      const d =
        N.normals[c * 3] * N.faceNormals[t * 3] +
        N.normals[c * 3 + 1] * N.faceNormals[t * 3 + 1] +
        N.normals[c * 3 + 2] * N.faceNormals[t * 3 + 2];
      if (!(d > 0.05)) badNormals++;
    }
  }
  let boundaryEdges = 0;
  let flippedEdges = 0;
  const open = new Set<number>(); // shells that are not closed, consistent solids
  for (const [key, count] of edges) {
    const a = Math.floor(key / K);
    const b = key % K;
    const back = edges.get(b * K + a) ?? 0;
    if (count === 1 && back === 1) continue;
    const shell = find(owner.get(a < b ? a * K + b : b * K + a)!);
    open.add(shell);
    if (back === 0 && count === 1) boundaryEdges++;
    else if (back === 0 && count >= 2) flippedEdges++;
  }
  const shellVolume = new Map<number, number>();
  for (let t = 0; t < T; t++) {
    const s = find(t);
    shellVolume.set(s, (shellVolume.get(s) ?? 0) + vol[t]);
  }
  let insideOut = 0;
  for (const [s, v] of shellVolume) if (!open.has(s) && v < -1e-9) insideOut++;
  return { boundaryEdges, flippedEdges, insideOut, shells: shellVolume.size, badNormals, volume };
}

/** Buffer-level facts of a set of prepared meshes. */
function bufferStats(meshes: PreparedMesh[]): { nan: number; aoMin: number; windMax: number; vertices: number; audits: Audit } {
  let nan = 0;
  let aoMin = 1;
  let windMax = 0;
  let vertices = 0;
  const audits: Audit = { boundaryEdges: 0, flippedEdges: 0, insideOut: 0, shells: 0, badNormals: 0, volume: 0 };
  for (const p of new Set(meshes)) {
    const d = p.data;
    vertices += d.vertexCount;
    for (const arr of [d.positions, d.normals, d.colors, d.uvs, d.uvs2]) {
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nan++;
    }
    for (let i = 0; i < d.uvs2.length; i += 2) {
      if (d.uvs2[i] < aoMin) aoMin = d.uvs2[i];
      if (d.uvs2[i + 1] > windMax) windMax = d.uvs2[i + 1];
    }
    if (p.solid) {
      const a = audit(p.solid);
      audits.boundaryEdges += a.boundaryEdges;
      audits.flippedEdges += a.flippedEdges;
      audits.insideOut += a.insideOut;
      audits.shells += a.shells;
      audits.badNormals += a.badNormals;
      audits.volume += a.volume;
    }
  }
  return { nan, aoMin, windMax, vertices, audits };
}

function geometryChecks(meshes: PreparedMesh[], expectWind: boolean): Check[] {
  const s = bufferStats(meshes);
  const checks: Check[] = [
    info('vertices', s.vertices),
    must('inverted normals', s.audits.badNormals, s.audits.badNormals === 0, 'corners shading away from their face'),
    must('non-finite', s.nan, s.nan === 0),
    must('flipped faces', s.audits.flippedEdges, s.audits.flippedEdges === 0, 'edges where two faces point opposite ways — an inside-out cap or patch'),
    must('inside-out shells', `${s.audits.insideOut} of ${s.audits.shells}`, s.audits.insideOut === 0, 'closed parts with negative volume'),
    info('volume', `${s.audits.volume.toFixed(3)} m³`),
    {
      label: 'open rim edges',
      value: s.audits.boundaryEdges,
      note: 'edges with a face on one side only (back: false plates, leaf cards, un-thickened shells) — fine if intended; look at debug=backface',
    },
    info('AO darkest', s.aoMin.toFixed(2)),
  ];
  if (expectWind) checks.push(must('wind weights', `max ${s.windMax.toFixed(2)}`, s.windMax > 0, 'asset.wind is set but no vertex sways'));
  else if (s.windMax > 0) checks.push(must('wind weights', `max ${s.windMax.toFixed(2)}`, false, 'weights present but asset.wind is not set'));
  return checks;
}

// ---------------------------------------------------------------------------
// Subject

interface PartGroup {
  label: string;
  triangles: number;
  meshes: AbstractMesh[];
}

interface Box {
  min: Vector3;
  max: Vector3;
}

interface Subject {
  asset: Asset;
  meshes: AbstractMesh[];
  cars: CarInstance[];
  parts: PartGroup[];
  report: Report;
}

const emptyBox = (): Box => ({
  min: new Vector3(Infinity, Infinity, Infinity),
  max: new Vector3(-Infinity, -Infinity, -Infinity),
});

function boxOf(meshes: AbstractMesh[], into: Box = emptyBox()): Box {
  for (const mesh of meshes) {
    if (!mesh.isEnabled()) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    into.min.minimizeInPlace(bb.minimumWorld);
    into.max.maximizeInPlace(bb.maximumWorld);
  }
  return into;
}

function finishReport(report: Omit<Report, 'failed' | 'pass'>): Report {
  const failed = report.checks.filter((c) => c.pass === false).map((c) => c.label);
  return { ...report, failed, pass: failed.length === 0 };
}

function buildPropSubject(scene: Scene, asset: PropAsset, seed: number, scheme: string | undefined, count: number): Subject {
  const first = prepareProp(asset, seed, scheme);
  const size = [first.mesh.max[0] - first.mesh.min[0], first.mesh.max[1] - first.mesh.min[1], first.mesh.max[2] - first.mesh.min[2]];
  const pitch = Math.max(asset.size.x, size[0]) * 1.2;
  const meshes: Mesh[] = [];
  for (let k = 0; k < count; k++) {
    const mesh = instantiateProp(scene, asset, seed + k, scheme);
    mesh.position.x = (k - (count - 1) / 2) * pitch;
    meshes.push(mesh);
  }

  // Seed 0 is the hero and must match the design; other seeds vary on
  // purpose, so they only have to stay in the neighbourhood.
  const band = seed === 0 ? 0.08 : 0.3;
  const minY = first.mesh.min[1];
  const skirt = Math.max(0.3, asset.size.y * 0.15);
  const cx = (first.mesh.min[0] + first.mesh.max[0]) / 2;
  const cz = (first.mesh.min[2] + first.mesh.max[2]) / 2;
  const checks: Check[] = [
    info('measured', count > 1 ? `seed ${seed} (first of ${count} shown)` : `seed ${seed}`),
    length('width (x)', size[0], asset.size.x, asset.size.x * band),
    length('height (y)', size[1], asset.size.y, asset.size.y * band),
    length('depth (z)', size[2], asset.size.z, asset.size.z * band),
    {
      label: 'lowest point',
      value: minY,
      unit: 'mm',
      pass: minY <= 0.02 && minY >= -skirt,
      note: `stands on y = 0; a skirt down to −${Math.round(skirt * 1000)} mm is accepted`,
    },
    { label: 'centre x / z', value: `${Math.round(cx * 1000)} / ${Math.round(cz * 1000)} mm` },
    { label: 'triangles', value: first.mesh.triangles, unit: 'tris', target: asset.triBudget, pass: first.mesh.triangles <= asset.triBudget },
    ...(first.mesh.triangles !== first.mesh.authoredTriangles
      ? [info('  as authored', `${first.mesh.authoredTriangles.toLocaleString('en-US')} (+${(first.mesh.triangles - first.mesh.authoredTriangles).toLocaleString('en-US')} for AO)`)]
      : []),
    ...geometryChecks([first.mesh], asset.wind ?? false),
    ...(count > 1 ? [variantCheck(asset, seed, scheme, count)] : []),
    info('AO', first.mesh.ao),
    info('variants / schemes', `${asset.variants} / ${asset.schemes?.join(', ') ?? '—'}`),
    info('colliders', asset.colliders ? asset.colliders(seed).length : 0),
  ];
  const report = finishReport({
    asset: asset.id,
    kind: 'prop',
    seed,
    scheme: first.scheme,
    triangles: first.mesh.triangles,
    drawCalls: 0,
    checks,
    timings: { buildMs: first.buildMs, aoMs: first.aoMs, finalizeMs: first.finalizeMs },
  });
  return {
    asset,
    meshes,
    cars: [],
    parts: [{ label: asset.category, triangles: first.mesh.triangles, meshes }],
    report,
  };
}

/**
 * The hard checks, run on EVERY variant on show (the table itself measures
 * the first): one row naming the seeds that fail and why. Seeded variation
 * is the point of the props, and a seed that blows the budget or turns a
 * face inside-out must not hide behind a clean seed 0.
 */
function variantCheck(asset: PropAsset, seed: number, scheme: string | undefined, count: number): Check {
  const bad: string[] = [];
  for (let k = 0; k < count; k++) {
    const p = prepareProp(asset, seed + k, scheme).mesh;
    const why: string[] = [];
    const band = seed + k === 0 ? 0.08 : 0.3;
    const dims = ['x', 'y', 'z'] as const;
    dims.forEach((d, i) => {
      if (Math.abs(p.max[i] - p.min[i] - asset.size[d]) > asset.size[d] * band + 1e-6) why.push(`size ${d}`);
    });
    if (p.triangles > asset.triBudget) why.push(`${p.triangles} tris`);
    if (p.min[1] > 0.02 || p.min[1] < -Math.max(0.3, asset.size.y * 0.15)) why.push('lowest point');
    const s = bufferStats([p]);
    if (s.nan > 0) why.push('non-finite');
    if (s.audits.badNormals > 0) why.push('inverted normals');
    if (s.audits.flippedEdges > 0) why.push('flipped faces');
    if (s.audits.insideOut > 0) why.push('inside-out shell');
    if (why.length) bad.push(`seed ${seed + k}: ${why.join(', ')}`);
  }
  // The reasons go into the value text (a free-text row that wraps); the
  // pass mark comes from the summary line under the table.
  return {
    label: `seeds ${seed}…${seed + count - 1}`,
    value: bad.length ? `✗ ${bad.join('; ')}` : 'all pass ✓',
    pass: bad.length === 0,
    note: 'size band, budget, lowest point and geometry audit for every variant shown',
    freeText: true,
  };
}

const CAR_PARTS: CarPart[] = ['body', 'driver', 'wheels', 'hubs', 'links', 'spinners', 'steeringWheel'];

function buildCarSubject(scene: Scene, asset: CarAsset, livery: number, count: number): Subject {
  const cars: CarInstance[] = [];
  const liveries = Math.max(1, asset.liveries);
  for (let k = 0; k < count; k++) cars.push(instantiateCar(scene, asset, (livery + k) % liveries));
  const car = cars[0];
  const p = car.prepared;
  const spec = asset.spec;

  // Measured at the STATIC pose with the root still on the origin, so world
  // space is model space.
  const all = boxOf(car.meshes());
  const wheels = boxOf(car.part('wheels'));
  const sprung = boxOf([...car.part('links'), ...car.part('hubs'), car.body]);
  const wf = p.wheels[1];
  const wr = p.wheels[3];
  const dia = (w: PreparedMesh): number => Math.max(w.max[1] - w.min[1], w.max[2] - w.min[2]);
  const offCentre = (w: PreparedMesh): number => Math.max(Math.abs(w.max[1] + w.min[1]), Math.abs(w.max[2] + w.min[2])) / 2;
  const hub = car.restHubs;

  const checks: Check[] = [
    length('length', all.max.z - all.min.z, spec.length, Math.max(0.04, spec.length * 0.015)),
    length('width over tires', wheels.max.x - wheels.min.x, spec.width, 0.03),
    length('height', all.max.y, spec.height, 0.03),
    length('wheelbase', hub[0].z - hub[2].z, spec.wheelbase, 0.005),
    length('front track', hub[1].x - hub[0].x, spec.frontTrack, 0.005),
    length('rear track', hub[3].x - hub[2].x, spec.rearTrack, 0.005),
    length('front tire Ø', dia(wf), spec.frontTireRadius * 2, 0.02),
    length('rear tire Ø', dia(wr), spec.rearTireRadius * 2, 0.02),
    length('front tire width', wf.max[0] - wf.min[0], spec.frontTireWidth, 0.02),
    length('rear tire width', wr.max[0] - wr.min[0], spec.rearTireWidth, 0.02),
    length('clearance', p.body.min[1], spec.groundClearance, 0.02),
    {
      label: 'wheels centred',
      value: Math.max(offCentre(wf), offCentre(wr)),
      unit: 'mm',
      pass: Math.max(offCentre(wf), offCentre(wr)) < 0.005,
      note: 'wheel meshes are authored around the wheel centre',
    },
    { label: 'lowest sprung pt', value: sprung.min.y, unit: 'mm', pass: sprung.min.y > 0.03, note: 'body, hubs and links clear the ground' },
    { label: 'body past tires', value: Math.max(0, all.max.x - wheels.max.x, wheels.min.x - all.min.x), unit: 'mm' },
    { label: 'triangles', value: p.triangles, unit: 'tris', target: asset.triBudget, pass: p.triangles <= asset.triBudget },
    ...(p.body.triangles !== p.body.authoredTriangles
      ? [info('  body as authored', `${p.body.authoredTriangles.toLocaleString('en-US')} (+${(p.body.triangles - p.body.authoredTriangles).toLocaleString('en-US')} for AO)`)]
      : []),
    ...linkChecks(car),
    ...geometryChecks([p.body, ...(p.driver ? [p.driver] : []), ...p.wheels, ...p.hubs.filter((h): h is PreparedMesh => h !== null), ...p.links, ...p.spinners, ...(p.steeringWheel ? [p.steeringWheel] : [])], false),
    info('spinners / wheel', `${p.spinners.length} / ${p.steeringWheel ? 'yes' : 'no'}`),
    info('liveries', asset.liveries),
  ];

  const pitch = Math.max(spec.width, all.max.x - all.min.x) * 1.35;
  // The default car camera stands in front of the row looking back, where
  // +x is on the LEFT of the picture: lay the row out toward −x so the
  // first livery is the leftmost car.
  cars.forEach((c, k) => {
    c.root.position.x = -(k - (count - 1) / 2) * pitch;
  });

  const tris = (list: (PreparedMesh | null)[]): number => list.reduce((n, m) => n + (m?.triangles ?? 0), 0);
  const partTris: Record<CarPart, number> = {
    body: p.body.triangles,
    driver: p.driver?.triangles ?? 0,
    wheels: tris(p.wheels),
    hubs: tris(p.hubs),
    links: tris(p.links),
    spinners: tris(p.spinners),
    steeringWheel: p.steeringWheel?.triangles ?? 0,
  };
  const report = finishReport({
    asset: asset.id,
    kind: 'car',
    livery: car.livery,
    triangles: p.triangles,
    drawCalls: 0,
    checks,
    timings: { buildMs: p.buildMs, aoMs: p.aoMs, finalizeMs: p.finalizeMs },
  });
  return {
    asset,
    meshes: cars.flatMap((c) => c.meshes()),
    cars,
    parts: CAR_PARTS.map((part) => ({ label: part, triangles: partTris[part], meshes: cars.flatMap((c) => c.part(part)) })).filter((g) => g.meshes.length > 0),
    report,
  };
}

/**
 * The lab's static pose. `setReviewPose` moves the WHEELS relative to the
 * body; lowering the body by the same amount keeps the tires on the floor,
 * which is what compression and droop look like on the road.
 */
function poseCar(car: CarInstance, steer: number, bump: number): void {
  car.setReviewPose({ steer, bump });
  car.root.position.y = -bump;
}

/** Contract checks on the link meshes (pose-independent). */
function linkChecks(car: CarInstance): Check[] {
  const geo = car.prepared.layout;
  const perWheel = [0, 0, 0, 0];
  let badStretch = 0;
  let badHang = 0;
  geo.links.forEach((link, i) => {
    perWheel[link.wheel]++;
    const p = car.prepared.links[i];
    if (link.mode === 'stretch') {
      // Unit length hanging from the origin: y from 0 down to −1.
      if (Math.abs(p.min[1] + 1) > 0.04 || p.max[1] > 0.04) badStretch++;
    } else if (p.max[1] > 0.08 || p.min[1] > -0.05) {
      badHang++;
    }
  });
  const stretch = geo.links.filter((l) => l.mode === 'stretch').length;
  return [
    must('links FL/FR/RL/RR', perWheel.join(' / '), perWheel.every((n) => n > 0), 'every corner needs suspension members'),
    must('stretch links 0…−1', `${stretch - badStretch} / ${stretch}`, badStretch === 0, 'mesh must span y 0 … −1'),
    must('rigid links hang −Y', `${geo.links.length - stretch - badHang} / ${geo.links.length - stretch}`, badHang === 0),
  ];
}

/**
 * Telescoping pairs at the CURRENT pose: a 'fromBody' and a 'fromHub' link
 * on the same anchors must overlap (no gap between tube and rod) without
 * either poking out past the other's anchor.
 */
function telescopeCheck(car: CarInstance): Check | null {
  const geo = car.prepared.layout;
  const same = (a: readonly number[], b: readonly number[]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-4;
  let pairs = 0;
  let worstGap = 0;
  let worstPoke = 0;
  geo.links.forEach((tube, i) => {
    if (tube.mode !== 'fromBody') return;
    const j = geo.links.findIndex((l) => l.mode === 'fromHub' && l.wheel === tube.wheel && same(l.bodyAnchor, tube.bodyAnchor) && same(l.hubAnchor, tube.hubAnchor));
    if (j < 0) return;
    pairs++;
    const span = Vector3.Distance(car.links[i].position, car.links[j].position);
    const a = -car.prepared.links[i].min[1];
    const b = -car.prepared.links[j].min[1];
    worstGap = Math.max(worstGap, span - (a + b));
    worstPoke = Math.max(worstPoke, a - span, b - span);
  });
  if (pairs === 0) return null;
  const ok = worstGap <= 0 && worstPoke <= 0;
  const value = ok ? `${pairs} ok` : worstGap > 0 ? `GAP ${Math.round(worstGap * 1000)} mm` : `POKES OUT ${Math.round(worstPoke * 1000)} mm`;
  return must('dampers this pose', value, ok, 'tube + rod must cover the span, each shorter than it');
}

// ---------------------------------------------------------------------------
// Stage floor, inspection material, colliders

/** Floor for bg=studio / bg=scene: its own small shader on the shared
 * lighting chunk (so it RECEIVES the sun shadow and the sky fill exactly as
 * the terrain will), fading into the backdrop toward the stage edge. */
function createFloor(scene: Scene, look: LookRuntime, o: { color: RGB; backdrop: RGB; fade: boolean; radius: number; grid: number; center: Vector3 }): Mesh {
  Effect.ShadersStore['labFloorVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    uniform mat4 world;
    uniform mat4 viewProjection;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = viewProjection * wp;
    }
  `;
  Effect.ShadersStore['labFloorFragmentShader'] = `
    precision highp float;
    varying vec3 vWorldPos;
    uniform vec3 floorColor;
    uniform vec4 floorFade;  // rgb backdrop (display space), a = on/off
    uniform vec4 floorStage; // xy = centre x/z, z = radius, w = grid strength
    #include<lookLighting>
    void main() {
      vec3 albedo = floorColor;
      // 1 m grid, fading out where a pixel covers too much floor to draw it.
      vec2 fw = max(fwidth(vWorldPos.xz), vec2(1e-6));
      vec2 g = abs(fract(vWorldPos.xz - 0.5) - 0.5) / fw;
      float line = (1.0 - min(min(g.x, g.y), 1.0)) * (1.0 - smoothstep(0.08, 0.3, max(fw.x, fw.y)));
      albedo *= 1.0 - floorStage.w * line;
      vec4 c = lookShadeMatte(lookToLinear(albedo), vec3(0.0, 1.0, 0.0), vWorldPos, 1.0, 1.0);
      float r = length(vWorldPos.xz - floorStage.xy) / floorStage.z;
      c.rgb = mix(c.rgb, floorFade.rgb, floorFade.a * smoothstep(0.35, 1.0, r));
      gl_FragColor = c;
    }
  `;
  const mat = new ShaderMaterial('labFloor', scene, 'labFloor', {
    attributes: ['position'],
    uniforms: ['world', 'viewProjection', 'floorColor', 'floorFade', 'floorStage', ...LOOK_UNIFORMS],
    samplers: [...LOOK_SAMPLERS],
  });
  mat.setColor3('floorColor', new Color3(o.color[0], o.color[1], o.color[2]));
  mat.setColor4('floorFade', new Color4(o.backdrop[0], o.backdrop[1], o.backdrop[2], o.fade ? 1 : 0));
  mat.setColor4('floorStage', new Color4(o.center.x, o.center.z, o.radius, o.grid));
  // The floor stands in for the terrain: it receives the cars' contact pools.
  look.register(mat, { contact: true });
  const size = o.radius * 2.4;
  const floor = MeshBuilder.CreateGround('labFloor', { width: size, height: size, subdivisions: 1 }, scene);
  floor.position.set(o.center.x, 0, o.center.z);
  floor.material = mat;
  floor.applyFog = false;
  floor.isPickable = false;
  return floor;
}

/** debug=backface: every face seen from behind is magenta. */
function createBackfaceMaterial(scene: Scene): ShaderMaterial {
  Effect.ShadersStore['labBackfaceVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;
    varying vec3 vNormal;
    void main() {
      #include<instancesVertex>
      vNormal = mat3(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz) * normal;
      gl_Position = viewProjection * (finalWorld * vec4(position, 1.0));
    }
  `;
  Effect.ShadersStore['labBackfaceFragmentShader'] = `
    precision highp float;
    varying vec3 vNormal;
    void main() {
      if (!gl_FrontFacing) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
      float l = dot(normalize(vNormal), normalize(vec3(-0.45, 0.75, -0.5))) * 0.5 + 0.5;
      gl_FragColor = vec4(vec3(0.22 + 0.7 * l), 1.0);
    }
  `;
  const mat = new ShaderMaterial('labBackface', scene, 'labBackface', {
    attributes: ['position', 'normal'],
    uniforms: ['world', 'viewProjection'],
  });
  mat.backFaceCulling = false;
  return mat;
}

function showColliders(scene: Scene, colliders: ColliderSpec[], offsetX: number): void {
  const mat = new StandardMaterial('labCollider', scene);
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(1, 0.2, 0.9);
  mat.wireframe = true;
  colliders.forEach((c, i) => {
    let mesh: Mesh;
    if (c.shape === 'box') {
      mesh = MeshBuilder.CreateBox(`collider${i}`, { width: c.half[0] * 2, height: c.half[1] * 2, depth: c.half[2] * 2 }, scene);
      mesh.position.set(c.center[0], c.center[1], c.center[2]);
      // ColliderSpec.rotY is in DEGREES like every authored angle (positive
      // turns +z toward +x); Babylon's rotation.y is the same sense in radians.
      mesh.rotation.y = (c.rotY ?? 0) * DEG;
    } else if (c.shape === 'cylinder') {
      mesh = MeshBuilder.CreateCylinder(`collider${i}`, { diameter: c.radius * 2, height: c.height, tessellation: 16 }, scene);
      mesh.position.set(c.base[0], c.base[1] + c.height / 2, c.base[2]);
    } else {
      mesh = MeshBuilder.CreateSphere(`collider${i}`, { diameter: c.radius * 2, segments: 8 }, scene);
      mesh.position.set(c.center[0], c.center[1], c.center[2]);
    }
    mesh.position.x += offsetX;
    mesh.material = mat;
    mesh.isPickable = false;
  });
}

// ---------------------------------------------------------------------------
// Views

interface Slot {
  title: string;
  /** Fractions of the stage, y from the TOP. */
  rect: { x: number; y: number; w: number; h: number };
  ortho?: OrthoAxis;
  camera: UniversalCamera | ArcRotateCamera;
  scaleBar?: HTMLElement;
}

/** Direction FROM the subject TO the camera, and the camera rotation that
 * looks back along it. Rotation is set directly on a UniversalCamera:
 * setTarget straight down is a gimbal case, and an ArcRotateCamera at
 * beta ≈ 0 silently degenerates. */
const ORTHO: Record<OrthoAxis, { toCamera: Vector3; rotation: Vector3 }> = {
  front: { toCamera: new Vector3(0, 0, 1), rotation: new Vector3(0, Math.PI, 0) },
  rear: { toCamera: new Vector3(0, 0, -1), rotation: new Vector3(0, 0, 0) },
  side: { toCamera: new Vector3(1, 0, 0), rotation: new Vector3(0, -Math.PI / 2, 0) },
  top: { toCamera: new Vector3(0, 1, 0), rotation: new Vector3(Math.PI / 2, 0, 0) },
};

function viewportOf(rect: Slot['rect']): Viewport {
  // Babylon's viewport y runs from the BOTTOM.
  return new Viewport(rect.x, 1 - rect.y - rect.h, rect.w, rect.h);
}

function orthoSlot(scene: Scene, axis: OrthoAxis, title: string, rect: Slot['rect']): Slot {
  const camera = new UniversalCamera(axis, Vector3.Zero(), scene);
  camera.rotation.copyFrom(ORTHO[axis].rotation);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.viewport = viewportOf(rect);
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  return { title, rect, ortho: axis, camera };
}

const HERO_FOV = 34 * DEG;

function heroSlot(scene: Scene, title: string, rect: Slot['rect'], yaw: number, pitch: number): Slot {
  const camera = new ArcRotateCamera(title, (yaw - 90) * DEG, (90 - pitch) * DEG, 10, Vector3.Zero(), scene);
  camera.viewport = viewportOf(rect);
  camera.fov = HERO_FOV;
  camera.minZ = 0.05;
  camera.maxZ = BG === 'scene' ? 12000 : 2000; // the sky dome is far away
  camera.wheelPrecision = 30;
  camera.panningSensibility = 400;
  return { title, rect, camera };
}

function frameOrtho(slot: Slot, box: Box, aspect: number, zoom: number, target: Vector3 | null): number {
  const camera = slot.camera as UniversalCamera;
  const axis = slot.ortho!;
  const center = target ?? box.min.add(box.max).scale(0.5);
  const size = box.max.subtract(box.min);
  const w = axis === 'side' ? size.z : size.x;
  const h = axis === 'top' ? size.z : size.y;
  let halfW = (w * 1.16) / 2 / zoom;
  let halfH = (h * 1.16) / 2 / zoom;
  // Grow whichever dimension is short so the box matches the viewport aspect.
  if (halfW / halfH < aspect) halfW = halfH * aspect;
  else halfH = halfW / aspect;
  camera.orthoLeft = -halfW;
  camera.orthoRight = halfW;
  camera.orthoTop = halfH;
  camera.orthoBottom = -halfH;
  // Stand well off so nothing clips the near plane.
  camera.position.copyFrom(center.add(ORTHO[axis].toCamera.scale(size.length() + 20)));
  return halfW * 2;
}

/** Put the hero camera at the distance where the whole box just fits (or at
 * `dist`), looking at the box centre (or at `target`). */
function frameHero(slot: Slot, box: Box, aspect: number, zoom: number, target: Vector3 | null, dist: number): void {
  const camera = slot.camera as ArcRotateCamera;
  const center = box.min.add(box.max).scale(0.5);
  const dir = new Vector3(
    Math.cos(camera.alpha) * Math.sin(camera.beta),
    Math.cos(camera.beta),
    Math.sin(camera.alpha) * Math.sin(camera.beta),
  );
  const right = Vector3.Cross(Vector3.Up(), dir);
  if (right.lengthSquared() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = Vector3.Cross(dir, right);
  const tanV = Math.tan(camera.fov / 2);
  const tanH = tanV * aspect;
  let radius = 0;
  for (let i = 0; i < 8; i++) {
    const v = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).subtractInPlace(center);
    const depth = Vector3.Dot(v, dir);
    radius = Math.max(radius, Math.abs(Vector3.Dot(v, right)) / tanH + depth, Math.abs(Vector3.Dot(v, up)) / tanV + depth);
  }
  camera.setTarget(target ?? center);
  camera.radius = dist > 0 ? dist : (radius * 1.1) / zoom;
  camera.lowerRadiusLimit = camera.radius * 0.05;
}

// ---------------------------------------------------------------------------
// Page

function fillAssetSelect(current: string): void {
  const select = el<HTMLSelectElement>('asset');
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const entry of listAssetEntries()) {
    let group = groups.get(entry.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = entry.group;
      groups.set(entry.group, group);
      select.append(group);
    }
    group.append(new Option(entry.id, entry.id));
  }
  if (!listAssetEntries().some((e) => e.id === current)) select.append(new Option(`${current} (unknown)`, current));
  select.value = current;
}

/** Reload with one or more parameters changed (empty string removes one). */
function go(changes: Record<string, string>): void {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === '') next.delete(key);
    else next.set(key, value);
  }
  location.search = next.toString();
}

function bindReload(id: string, key: string, also: Record<string, string> = {}): void {
  const input = el<HTMLInputElement | HTMLSelectElement>(id);
  input.addEventListener('change', () => go({ ...also, [key]: input.value }));
}

function formatCheck(c: Check): { value: string; verdict: string; cls: string } {
  let value: string;
  if (typeof c.value === 'string') value = c.value;
  else if (c.unit === 'mm') value = Math.round(c.value * 1000).toLocaleString('en-US');
  else if (c.unit === 'ms') value = `${c.value.toFixed(0)} ms`;
  else value = Math.round(c.value).toLocaleString('en-US');
  let verdict = '';
  if (c.target !== undefined && typeof c.value === 'number') {
    if (c.unit === 'mm') {
      const delta = Math.round((c.value - c.target) * 1000);
      verdict = `${Math.round(c.target * 1000).toLocaleString('en-US')} (${delta > 0 ? '+' : ''}${delta})`;
    } else {
      verdict = `≤ ${c.target.toLocaleString('en-US')}`;
    }
  }
  if (c.pass !== undefined && !c.freeText) verdict = `${c.pass ? '✓' : '✗'} ${verdict}`.trim();
  return { value, verdict, cls: c.pass === undefined ? '' : c.pass ? 'ok' : 'off' };
}

function renderReport(report: Report): void {
  const table = el<HTMLTableElement>('specTable');
  table.textContent = '';
  for (const c of report.checks) {
    const f = formatCheck(c);
    const row = table.insertRow();
    if (c.note) row.title = c.note;
    const k = row.insertCell();
    k.className = 'k';
    k.textContent = c.label;
    const v = row.insertCell();
    v.className = 'v';
    v.textContent = f.value;
    if (f.verdict === '') {
      if (c.freeText && f.cls) v.classList.add(f.cls);
      // Free-text values (timings, lists) may be long: let them use the
      // verdict column too instead of widening the value column for all rows.
      v.colSpan = 2;
      v.classList.add('wide');
      continue;
    }
    const d = row.insertCell();
    d.className = `d ${f.cls}`;
    d.textContent = f.verdict;
  }
  const verdict = el<HTMLElement>('verdict');
  verdict.className = report.pass ? 'ok' : 'off';
  verdict.textContent = report.pass ? '✓ all checks pass' : `✗ ${report.failed.length} failing: ${report.failed.join(', ')}`;
}

async function main(): Promise<void> {
  if (!UI) document.body.classList.add('bare');
  if (BG !== 'blueprint') document.body.style.background = BG === 'studio' ? '#dfe3ea' : '#bde0f7';

  const entries = listAssetEntries();
  const assetId = params.get('asset') ?? (entries.some((e) => e.id === 'calibration') ? 'calibration' : (entries[0]?.id ?? ''));
  fillAssetSelect(assetId);
  el<HTMLSelectElement>('view').value = VIEW;
  el<HTMLSelectElement>('bg').value = BG;
  el<HTMLSelectElement>('debug').value = DEBUG;
  el<HTMLInputElement>('variants').value = String(Math.max(1, Math.round(num('variants', 1))));
  // A new asset starts from its own defaults.
  bindReload('asset', 'asset', { seed: '', scheme: '', livery: '', steer: '', bump: '', variants: '' });
  bindReload('view', 'view', { bg: '' });
  bindReload('bg', 'bg');
  bindReload('debug', 'debug');
  bindReload('variants', 'variants');
  bindReload('seed', 'seed');
  bindReload('scheme', 'scheme');
  bindReload('livery', 'livery');
  bindReload('steer', 'steer');
  bindReload('bump', 'bump');

  let asset: Asset;
  try {
    asset = await loadAsset(assetId);
  } catch (error) {
    fatal(`Could not load asset "${assetId}".`, error);
    return;
  }
  const isCar = asset.kind === 'car';
  for (const id of ['seedCtl', 'schemeCtl']) el(id).hidden = isCar;
  for (const id of ['liveryCtl', 'steerCtl', 'bumpCtl', 'runCtl']) el(id).hidden = !isCar;

  // --- engine, scene, look ---------------------------------------------------
  const canvas = el<HTMLCanvasElement>('lab');
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  // Compile shaders synchronously: a headless screenshot runs on a virtual
  // clock that expires before an async (parallel) compile reports back.
  engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);

  const shadowParam = params.get('shadows') ?? '2048';
  const shadowQuality: ShadowQuality = shadowParam === 'off' ? 'off' : shadowParam === '1024' ? 1024 : 2048;
  // syncScene off: the lab owns the clear colour (transparent on blueprint).
  const look = createLook(scene, { shadowQuality, sky: BG === 'scene', syncScene: false });
  const backdrop: RGB = BG === 'studio' ? [0.875, 0.89, 0.918] : look.config.fogColor;
  scene.clearColor = BG === 'blueprint' ? new Color4(0, 0, 0, 0) : new Color4(backdrop[0], backdrop[1], backdrop[2], 1);
  if (BG !== 'scene') look.config.fogDensity = 0;

  // Sun: the game's own direction for props and buildings (it lights their
  // −z fronts); mirrored in z for cars so it lights the nose. Either way the
  // default hero camera stands ~75° round from it: lit, with visible shadows.
  const sunZ = isCar ? -SUN_DIR.z : SUN_DIR.z;
  look.config.sunDir = { x: SUN_DIR.x, y: SUN_DIR.y, z: sunZ };
  const sunParam = params.get('sun')?.split(',').map(Number);
  if (sunParam && sunParam.length === 2 && sunParam.every(Number.isFinite)) {
    const [az, elev] = [sunParam[0] * DEG, sunParam[1] * DEG];
    look.config.sunDir = { x: Math.sin(az) * Math.cos(elev), y: Math.sin(elev), z: -Math.cos(az) * Math.cos(elev) };
  }
  // Any LookConfig key can be overridden from the URL for A/B screenshots.
  const cfg = look.config as unknown as Record<string, unknown>;
  for (const [key, raw] of params) {
    if (!(key in cfg) || key === 'sunDir') continue;
    const values = raw.split(',').map(Number);
    if (values.some((v) => !Number.isFinite(v))) continue;
    if (typeof cfg[key] === 'number') cfg[key] = values[0];
    else if (Array.isArray(cfg[key])) cfg[key] = values;
  }
  const debugViews: Record<string, number> = { albedo: 1, normal: 2, shadow: 3, ao: 4, light: 5 };
  look.debugView = debugViews[DEBUG] ?? 0;

  // --- subject ---------------------------------------------------------------
  assembleSettings.keepSolids = true;
  assembleSettings.ao = params.get('ao') !== '0';
  const count = Math.max(1, Math.min(12, Math.round(num('variants', 1))));
  const seed = Math.max(0, Math.round(num('seed', 0)));
  const livery = Math.max(0, Math.round(num('livery', 0)));
  const steer = num('steer', 0);
  const bump = num('bump', 0);
  let subject: Subject;
  try {
    subject =
      asset.kind === 'car'
        ? buildCarSubject(scene, asset, livery, count)
        : buildPropSubject(scene, asset, seed, params.get('scheme') ?? undefined, count);
  } catch (error) {
    fatal(`Asset "${assetId}" threw while building.`, error);
    return;
  }
  const report = subject.report;
  lab.report = report;

  if (asset.kind === 'car') {
    if (params.get('driver') === '0') for (const car of subject.cars) car.setPartEnabled('driver', false);
    for (const car of subject.cars) poseCar(car, steer * DEG, bump);
    // Same contact pools the game puts under its cars.
    if (params.get('contact') !== '0') look.contacts = subject.cars.slice(0, 4).map((car) => carContact(car));
    const telescope = telescopeCheck(subject.cars[0]);
    if (telescope) {
      report.checks.splice(report.checks.findIndex((c) => c.label === 'vertices'), 0, telescope);
      if (telescope.pass === false) {
        report.failed.push(telescope.label);
        report.pass = false;
      }
    }
  } else if (params.get('colliders') === '1' && asset.colliders) {
    subject.meshes.forEach((mesh, k) => showColliders(scene, asset.colliders!(seed + k), mesh.position.x));
  }

  // Controls that depend on the asset.
  el<HTMLInputElement>('seed').value = String(seed);
  const schemeSelect = el<HTMLSelectElement>('scheme');
  if (asset.kind === 'prop' && asset.schemes?.length) {
    for (const s of asset.schemes) schemeSelect.add(new Option(s, s));
    schemeSelect.value = report.scheme ?? asset.schemes[0];
  } else {
    el('schemeCtl').hidden = true;
  }
  if (asset.kind === 'car') {
    const liverySelect = el<HTMLSelectElement>('livery');
    for (let i = 0; i < Math.max(1, asset.liveries); i++) liverySelect.add(new Option(String(i), String(i)));
    liverySelect.value = String(livery % Math.max(1, asset.liveries));
    el<HTMLInputElement>('steer').value = String(steer);
    el<HTMLInputElement>('bump').value = String(bump);
  }

  const sheet = `/${asset.reference.sheet}`;
  el('meta').innerHTML = '';
  const meta = el('meta');
  const line = (label: string, value: string, href?: string): void => {
    const div = document.createElement('div');
    div.append(`${label} `);
    const b = document.createElement(href ? 'a' : 'b');
    b.textContent = value;
    if (href) {
      (b as HTMLAnchorElement).href = href;
      (b as HTMLAnchorElement).target = '_blank';
    }
    div.append(b);
    meta.append(div);
  };
  line('name', asset.name);
  line('id', `${asset.id} · ${asset.category}`);
  line('sheet', asset.reference.sheet.split('/').slice(-2).join('/'), sheet);
  if (asset.reference.brief) line('brief', asset.reference.brief.split('/').slice(-2).join('/'), `/${asset.reference.brief}`);

  const toggles = el('partToggles');
  for (const part of subject.parts) {
    const label = document.createElement('label');
    label.className = 'ctl';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      for (const mesh of part.meshes) mesh.setEnabled(cb.checked);
    });
    label.append(cb, ` ${part.label} — ${part.triangles.toLocaleString()} tris`);
    toggles.append(label);
  }

  // --- stage -----------------------------------------------------------------
  const box = boxOf(subject.meshes);
  // The floor is part of the framing only as the plane things stand on.
  box.min.y = Math.min(box.min.y, 0);
  const center = box.min.add(box.max).scale(0.5);
  const extent = box.max.subtract(box.min).length();

  // One shadow map over the whole subject: far finer than the game's 80 m
  // region, so contact shadows can be judged. `region=80` previews the
  // softness the game will have.
  const region = num('region', Math.min(Math.max(extent * 2.2, 4), 200));
  look.shadows.region = region;
  // The depth bias is a world distance; keep it in proportion to the texels.
  look.shadows.depthBias = Math.max(0.002, (0.03 * region) / 80);
  look.shadows.setFocus(center);

  // In the inspection views that paint the subject white-ish (AO, light) or
  // in raw data colours, a lit floor would be white under a white subject:
  // use a flat mid-grey one so silhouettes stay readable. (debug=shadow keeps
  // the real floor — the shadow ON it is the point.)
  const flatFloor = DEBUG !== '' && DEBUG !== 'shadow' && DEBUG !== 'backface';
  if (BG !== 'blueprint' && flatFloor) {
    const floor = MeshBuilder.CreateGround('labFloor', { width: Math.max(extent * 10, 30), height: Math.max(extent * 10, 30) }, scene);
    floor.position.set(center.x, 0, center.z);
    const mat = new StandardMaterial('labFloorFlat', scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(0.42, 0.43, 0.46);
    floor.material = mat;
    floor.applyFog = false;
    floor.isPickable = false;
  } else if (BG === 'studio') {
    createFloor(scene, look, { color: [0.8, 0.8, 0.81], backdrop, fade: true, radius: Math.max(extent * 4, 12), grid: 0.07, center });
  } else if (BG === 'scene') {
    createFloor(scene, look, { color: [0.44, 0.64, 0.24], backdrop, fade: false, radius: 2500, grid: 0, center });
  }

  // What the cameras frame: everything, or the meshes `focus` names.
  let frameBox = box;
  const focus = params.get('focus')?.toLowerCase();
  if (focus) {
    const group = subject.parts.find((g) => g.label.toLowerCase() === focus);
    const hit = group ? group.meshes : subject.meshes.filter((mesh) => mesh.name.toLowerCase().includes(focus));
    if (hit.length) frameBox = boxOf(hit);
    else problem('focus', `no mesh name contains "${focus}" — names: ${[...new Set(subject.meshes.map((mesh) => mesh.name.slice(asset.id.length + 1) || mesh.name))].join(', ')}`);
  }
  const targetParam = params.get('target')?.split(',').map(Number);
  const target = targetParam && targetParam.length === 3 && targetParam.every(Number.isFinite) ? new Vector3(targetParam[0], targetParam[1], targetParam[2]) : null;
  const dist = num('dist', 0);

  if (DEBUG === 'backface') {
    const mat = createBackfaceMaterial(scene);
    for (const mesh of subject.meshes) if (!mesh.isAnInstance) mesh.material = mat;
  }

  // --- views -----------------------------------------------------------------
  // Cars point their nose at +z, buildings their front door at −z: "front"
  // is whichever side that is.
  const frontAxis: OrthoAxis = isCar ? 'front' : 'rear';
  const rearAxis: OrthoAxis = isCar ? 'rear' : 'front';
  const frontTitle = `Front (from ${isCar ? '+z' : '−z'})`;
  const yaw = num('yaw', isCar ? 150 : 30);
  const pitch = num('pitch', 20);
  const zoom = num('zoom', 1);
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const slots: Slot[] = [];
  if (VIEW === 'quad') {
    slots.push(
      orthoSlot(scene, frontAxis, frontTitle, { x: 0, y: 0, w: 0.5, h: 0.5 }),
      orthoSlot(scene, 'top', 'Top', { x: 0.5, y: 0, w: 0.5, h: 0.5 }),
      heroSlot(scene, '¾ view', { x: 0, y: 0.5, w: 0.5, h: 0.5 }, yaw, pitch),
      orthoSlot(scene, 'side', 'Side (from +x)', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }),
    );
  } else if (VIEW === 'sheet') {
    for (let k = 0; k < 8; k++) {
      const a = (((yaw + k * 45) % 360) + 360) % 360;
      slots.push(heroSlot(scene, `yaw ${a}`, { x: (k % 4) / 4, y: Math.floor(k / 4) / 2, w: 0.25, h: 0.5 }, a, pitch));
    }
  } else if (VIEW === 'hero' || VIEW === 'turntable') {
    slots.push(heroSlot(scene, VIEW === 'hero' ? '¾ view' : 'Turntable', full, yaw, pitch));
  } else if (VIEW === 'front') {
    slots.push(orthoSlot(scene, frontAxis, frontTitle, full));
  } else if (VIEW === 'rear') {
    slots.push(orthoSlot(scene, rearAxis, `Rear (from ${isCar ? '−z' : '+z'})`, full));
  } else if (VIEW === 'side') {
    slots.push(orthoSlot(scene, 'side', 'Side (from +x)', full));
  } else {
    slots.push(orthoSlot(scene, 'top', 'Top', full));
  }
  scene.activeCameras = slots.map((s) => s.camera);
  const heroes = slots.filter((s) => !s.ortho).map((s) => s.camera as ArcRotateCamera);
  // Only a single orbit camera takes the mouse; a sheet is for looking at.
  if (heroes.length === 1) {
    heroes[0].attachControl(canvas, true);
    scene.cameraToUseForPointers = heroes[0];
  }

  // View furniture.
  const chrome = el('chrome');
  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
  for (const slot of slots) {
    const label = document.createElement('div');
    label.className = 'vlabel';
    label.textContent = slot.title;
    label.style.left = `calc(${pct(slot.rect.x)} + 10px)`;
    label.style.top = `calc(${pct(slot.rect.y)} + 8px)`;
    chrome.append(label);
    if (slot.ortho) {
      const scale = document.createElement('div');
      scale.className = 'scale';
      scale.style.left = `calc(${pct(slot.rect.x)} + 10px)`;
      scale.style.top = `calc(${pct(slot.rect.y + slot.rect.h)} - 30px)`;
      const bar = document.createElement('span');
      bar.className = 'bar';
      scale.append(bar, '1 m');
      chrome.append(scale);
      slot.scaleBar = bar;
    }
    for (const [x, y, w, h] of [
      [slot.rect.x, slot.rect.y, 0, slot.rect.h],
      [slot.rect.x, slot.rect.y, slot.rect.w, 0],
    ]) {
      if ((w === 0 && x === 0) || (h === 0 && y === 0)) continue;
      const rule = document.createElement('div');
      rule.className = 'rule';
      rule.style.left = pct(x);
      rule.style.top = pct(y);
      rule.style.width = w === 0 ? '1px' : pct(w);
      rule.style.height = h === 0 ? '1px' : pct(h);
      chrome.append(rule);
    }
  }

  const layout = (): void => {
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    for (const slot of slots) {
      const aspect = (w * slot.rect.w) / (h * slot.rect.h);
      if (slot.ortho) {
        const meters = frameOrtho(slot, frameBox, aspect, zoom, target);
        if (slot.scaleBar) slot.scaleBar.style.width = `${((canvas.clientWidth * slot.rect.w) / meters).toFixed(1)}px`;
      } else {
        frameHero(slot, frameBox, aspect, zoom, target, dist);
      }
    }
  };
  layout();
  window.addEventListener('resize', () => {
    engine.resize();
    layout();
  });

  // --- live controls -----------------------------------------------------------
  const wire = el<HTMLInputElement>('wire');
  const spin = el<HTMLInputElement>('spin');
  const run = el<HTMLInputElement>('run');
  wire.checked = params.get('wire') === '1';
  spin.checked = params.get('spin') === '1' || VIEW === 'turntable';
  run.checked = params.get('run') === '1';
  const applyWire = (): void => {
    const materials = new Set<Material>();
    for (const mesh of subject.meshes) if (mesh.material) materials.add(mesh.material);
    materials.add(toyMaterial(scene));
    for (const m of materials) m.wireframe = wire.checked;
  };
  wire.addEventListener('change', applyWire);
  applyWire();
  run.addEventListener('change', () => {
    if (!run.checked) for (const car of subject.cars) poseCar(car, steer * DEG, bump);
  });

  // --- render ------------------------------------------------------------------
  const drawCalls = (engine as unknown as { _drawCalls: { current: number; fetchNewFrame(): void } })._drawCalls;
  let clock = 0;
  const animate = (dt: number): void => {
    if (spin.checked) for (const camera of heroes) camera.alpha += dt * 0.6;
    if (run.checked && subject.cars.length) {
      clock += dt;
      for (const car of subject.cars) {
        car.setReviewPose({
          steer: steer * DEG + Math.sin(clock * 1.3) * 0.45,
          bump: [0, 1, 2, 3].map((i) => bump + Math.sin(clock * 3.1 + i * 1.7) * 0.07),
          spin: clock * 9,
        });
        car.advanceSpinners(dt, 0.5 + 0.5 * Math.sin(clock * 0.8));
      }
    }
  };
  const frame = (): void => {
    // Babylon only resets its draw-call counter when a SceneInstrumentation
    // is attached; without this it would report the running total.
    drawCalls.fetchNewFrame();
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    lab.frames++;
  };
  // Three frames straight away, without waiting for the browser's frame
  // clock: under headless virtual time that clock may tick only once or twice
  // before the screenshot. (Frame 1 fills the shadow map, 2 is complete.)
  for (let i = 0; i < 3; i++) frame();

  report.drawCalls = drawCalls.current;
  // Under headless virtual time the clock stands still while script runs, so
  // every duration reads 0 there; real numbers need a real browser.
  const t = report.timings;
  const timed = t.buildMs + t.aoMs + t.finalizeMs > 0;
  report.checks.push(
    info('draw calls', report.drawCalls),
    info('build / AO / index', timed ? `${t.buildMs.toFixed(0)} / ${t.aoMs.toFixed(0)} / ${t.finalizeMs.toFixed(0)} ms` : 'n/a (headless clock)'),
  );
  renderReport(report);
  Object.assign(lab, { engine, scene, look, asset, subject, slots });
  lab.ready = true;
  publish();
  console.log(`[asset-lab] ${JSON.stringify(report)}`);

  // runRenderLoop wraps its callback in beginFrame / endFrame itself.
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    animate(dt);
    scene.render();
    lab.frames++;
  });
}

main().catch((error) => fatal('The asset lab itself failed.', error));
