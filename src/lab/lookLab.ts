import {
  ArcRotateCamera,
  Effect,
  Engine,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, createLook } from '../gfx/look/lighting';
import type { LookRuntime, ShadowQuality, ShadowTaps } from '../gfx/look/lighting';
import { createToyMaterial } from '../gfx/look/ToyMaterial';

/**
 * Look lab (look-lab.html) — the test bench for the shared lighting, the toy
 * shader, sun shadows and the sky. Everything is built from MeshBuilder
 * primitives with hand-filled SolidMesh attributes, so the look can be judged
 * (and tuned against the vision images) independently of the asset kit.
 *
 * URL parameters
 *   shot=wide|car|spheres|shadow|field|top|low   camera preset
 *   yaw, pitch (deg), dist, tx, ty, tz, fov (deg) override the preset
 *   shadows=off|1024|2048   taps=1|4|9   region=<m>   focus=<x>,<z>
 *   late=off|1024|2048      switch shadow quality after frame 1 (runtime recompile test)
 *   sky=0                   hide the sky dome
 *   t=<seconds>             freeze the shader clock (wind) at a fixed time
 *   debug=1                 overlay with draw calls / fps / warnings
 *   view=1..7               inspection: albedo, normal, shadow, AO, light, baked sun, shadow uv
 *   <any LookConfig key>=<number | r,g,b>   e.g. exposure=1.1&sunColor=1,0.9,0.7
 */

type RGB = [number, number, number];

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Debug overlay: headless screenshots have no console, so errors must be IN
// the picture.

const debugEl = document.getElementById('debug') as HTMLPreElement;
const debugOn = params.get('debug') === '1';
const problems: string[] = [];
function report(kind: string, message: string): void {
  if (problems.length > 12) return;
  problems.push(`${kind}: ${message.slice(0, 600)}`);
  renderDebug('');
}
function renderDebug(stats: string): void {
  debugEl.innerHTML = '';
  if (stats) debugEl.append(stats + (problems.length ? '\n' : ''));
  for (const p of problems) {
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = p + '\n';
    debugEl.append(span);
  }
}
window.addEventListener('error', (e) => report('error', e.message));
window.addEventListener('unhandledrejection', (e) => report('rejection', String(e.reason)));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  report('console.error', args.map(String).join(' '));
  consoleError(...args);
};
if (debugOn) {
  const consoleWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    report('console.warn', args.map(String).join(' '));
    consoleWarn(...args);
  };
}

// ---------------------------------------------------------------------------
// Palette (design packs)

const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const C = {
  turquoise: hex('#1CAFAE'),
  coral: hex('#F16B59'),
  cream: hex('#F4E3C4'),
  cobalt: hex('#3153BA'),
  mustard: hex('#E5AB35'),
  lavender: hex('#8C88B8'),
  slate: hex('#777CAE'),
  stoneDark: hex('#655584'),
  stoneTop: hex('#F0CDB1'),
  lime: hex('#9BD916'),
  limeHi: hex('#C7F039'),
  jade: hex('#139B68'),
  teal: hex('#116957'),
  bark: hex('#B86132'),
  ochre: hex('#C9875C'),
  ochreLight: hex('#DCA070'),
  grass: hex('#69AE38'),
  rubber: hex('#50474A'),
  steel: hex('#C9CED6'),
  cyan: hex('#44DDE8'),
  warmLamp: hex('#FFD890'),
  tailLamp: hex('#FF5A2E'),
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------------------------------------------------------------------------
// Filling the SolidMesh vertex format on MeshBuilder primitives

type Field<T> = T | ((p: Vector3, n: Vector3) => T);
interface Paint {
  color: Field<RGB>;
  gloss?: Field<number>;
  metal?: Field<number>;
  emissive?: Field<number>;
  ao?: Field<number>;
  wind?: Field<number>;
}

function evalField<T>(f: Field<T> | undefined, fallback: T, p: Vector3, n: Vector3): T {
  if (f === undefined) return fallback;
  return typeof f === 'function' ? (f as (p: Vector3, n: Vector3) => T)(p, n) : f;
}

/** color rgba [a = emissive], uv [gloss, metal], uv2 [ao, wind]. Field
 * functions see positions/normals in the mesh's LOCAL space. */
function paint(mesh: Mesh, spec: Paint): Mesh {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const count = pos.length / 3;
  const colors = new Float32Array(count * 4);
  const uv = new Float32Array(count * 2);
  const uv2 = new Float32Array(count * 2);
  const p = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < count; i++) {
    p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    n.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    const c = evalField(spec.color, C.cream, p, n);
    colors[i * 4] = c[0];
    colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2];
    colors[i * 4 + 3] = evalField(spec.emissive, 0, p, n);
    uv[i * 2] = evalField(spec.gloss, 0.2, p, n);
    uv[i * 2 + 1] = evalField(spec.metal, 0, p, n);
    uv2[i * 2] = evalField(spec.ao, 1, p, n);
    uv2[i * 2 + 1] = evalField(spec.wind, 0, p, n);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
  mesh.setVerticesData(VertexBuffer.UVKind, uv, false, 2);
  mesh.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2);
  // Alpha is emissive, never opacity.
  mesh.hasVertexAlpha = false;
  return mesh;
}

function place(mesh: Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Mesh {
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  return mesh;
}

function merge(name: string, parts: Mesh[]): Mesh {
  const merged = Mesh.MergeMeshes(parts, true, true)!;
  merged.name = name;
  merged.hasVertexAlpha = false;
  return merged;
}

/**
 * Superellipsoid |x/a|^p + |y/b|^p + |z/c|^p = 1 with p = 2/e: e = 1 is an
 * ellipsoid, smaller e squares it off into a pillow with broad soft bevels —
 * the cheapest stand-in for a moulded toy body. Normals are analytic (the
 * surface gradient), so the shading is as smooth as the real kit's will be.
 */
function superEllipsoid(scene: Scene, a: number, b: number, c: number, e: number, segments = 28): Mesh {
  const mesh = MeshBuilder.CreateSphere('se', { diameter: 2, segments }, scene);
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const nrm = new Float32Array(pos.length);
  const sp = (u: number, k: number) => Math.sign(u) * Math.pow(Math.abs(u), k);
  for (let i = 0; i < pos.length; i += 3) {
    const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]) || 1;
    const ux = pos[i] / l;
    const uy = pos[i + 1] / l;
    const uz = pos[i + 2] / l;
    pos[i] = a * sp(ux, e);
    pos[i + 1] = b * sp(uy, e);
    pos[i + 2] = c * sp(uz, e);
    const nx = sp(ux, 2 - e) / a;
    const ny = sp(uy, 2 - e) / b;
    const nz = sp(uz, 2 - e) / c;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nrm[i] = nx / nl;
    nrm[i + 1] = ny / nl;
    nrm[i + 2] = nz / nl;
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, pos);
  mesh.setVerticesData(VertexBuffer.NormalKind, nrm);
  return mesh;
}

/** Icosphere pushed around by a position hash, then flat-shaded: every face
 * gets one normal and the paint function can colour whole facets. Hashing
 * the POSITION keeps duplicated vertices welded. */
function facetedBlob(scene: Scene, radius: number, squash: number, rough: number, seed: number, subdivisions = 2): Mesh {
  const mesh = MeshBuilder.CreateIcoSphere('blob', { radius: 1, subdivisions, flat: false }, scene);
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < pos.length; i += 3) {
    const h = hash3(pos[i] + seed, pos[i + 1] - seed * 0.37, pos[i + 2] + seed * 1.91);
    const k = radius * (1 + (h - 0.5) * rough);
    pos[i] *= k;
    pos[i + 1] *= k * squash;
    pos[i + 2] *= k;
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, pos);
  mesh.convertToFlatShadedMesh();
  return mesh;
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(Math.round(x * 1000) * 0.0127 + Math.round(y * 1000) * 0.0311 + Math.round(z * 1000) * 0.0743) * 43758.5453;
  return s - Math.floor(s);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Test subjects

/** Ground with its OWN tiny material instead of the toy shader: it is the
 * reference for how any other material (the terrain) plugs into the shared
 * lighting — list LOOK_UNIFORMS / LOOK_SAMPLERS, #include<lookLighting>,
 * call lookShadeMatte, register with the runtime. */
function buildGround(scene: Scene, look: LookRuntime): Mesh {
  Effect.ShadersStore['labGroundVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    uniform mat4 world;
    uniform mat4 viewProjection;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec4 vColor;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      vColor = color;
      gl_Position = viewProjection * wp;
    }
  `;
  Effect.ShadersStore['labGroundFragmentShader'] = `
    precision highp float;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec4 vColor;
    #include<lookLighting>
    void main() {
      // color.a carries baked AO here (contact darkening around the props).
      gl_FragColor = lookShadeMatte(lookToLinear(vColor.rgb), normalize(vNormal), vWorldPos, vColor.a, 1.0);
    }
  `;
  const mat = new ShaderMaterial('labGround', scene, 'labGround', {
    attributes: ['position', 'normal', 'color'],
    uniforms: ['world', 'viewProjection', ...LOOK_UNIFORMS],
    samplers: [...LOOK_SAMPLERS],
  });
  mat.needAlphaBlendingForMesh = () => false;
  // Ground materials receive the cars' contact pools (see look.contacts).
  look.register(mat, { contact: true });

  const size = 400;
  const ground = MeshBuilder.CreateGround('ground', { width: size, height: size, subdivisions: 100 }, scene);
  const pos = ground.getVerticesData(VertexBuffer.PositionKind)!;
  const colors = new Float32Array((pos.length / 3) * 4);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3];
    const z = pos[i * 3 + 2];
    // Ochre dirt road down the middle, a cobbled lavender yard to the right,
    // lime grass elsewhere — the three ground tones of the vision.
    const wobble = Math.sin(z * 0.07) * 3;
    const road = 1 - smooth(7, 10, Math.abs(x - wobble));
    const yard = smooth(9, 12, x) * (1 - smooth(34, 38, x)) * smooth(-14, -10, z) * (1 - smooth(22, 26, z));
    const n = hash3(x, 0, z);
    let c = mix(C.grass, C.lime, n * 0.25);
    c = mix(c, mix(C.slate, C.stoneTop, 0.35 + n * 0.3), yard);
    c = mix(c, mix(C.ochre, C.ochreLight, n * 0.6), road);
    colors[i * 4] = c[0];
    colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2];
    colors[i * 4 + 3] = 1;
  }
  ground.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
  ground.hasVertexAlpha = false;
  ground.material = mat;
  ground.applyFog = false;
  ground.isPickable = false;
  return ground;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function buildSpheres(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const x = (i - (n - 1) / 2) * 2.6;
    // Row 1: gloss 0 → 1 on turquoise paint.
    const a = MeshBuilder.CreateSphere('g', { diameter: 2, segments: 32 }, scene);
    parts.push(place(paint(a, { color: C.turquoise, gloss: k }), x, 1, 12));
    // Row 2: metal 0 → 1 at a fixed mid gloss, steel.
    const b = MeshBuilder.CreateSphere('m', { diameter: 2, segments: 32 }, scene);
    parts.push(place(paint(b, { color: C.steel, gloss: 0.6, metal: k }), x, 1, 15.2));
    // Row 3: coloured metal at high gloss (mustard = "gold").
    const c = MeshBuilder.CreateSphere('m2', { diameter: 2, segments: 32 }, scene);
    parts.push(place(paint(c, { color: C.mustard, gloss: 0.35 + 0.65 * k, metal: 1 }), x, 1, 18.4));
  }
  return merge('spheres', parts);
}

function buildLamps(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const lamps: [RGB, number][] = [
    [C.warmLamp, 1],
    [C.cyan, 1],
    [C.tailLamp, 1],
    [C.warmLamp, 0.4],
  ];
  lamps.forEach(([color, emissive], i) => {
    const x = -8 + i * 1.8;
    const post = MeshBuilder.CreateCylinder('post', { diameter: 0.16, height: 2.2, tessellation: 10 }, scene);
    parts.push(place(paint(post, { color: C.cobalt, gloss: 0.5 }), x, 1.1, 7));
    const cap = MeshBuilder.CreateCylinder('cap', { diameterTop: 0.2, diameterBottom: 0.7, height: 0.3, tessellation: 12 }, scene);
    parts.push(place(paint(cap, { color: C.cobalt, gloss: 0.5 }), x, 2.75, 7));
    const bulb = MeshBuilder.CreateSphere('bulb', { diameter: 0.55, segments: 16 }, scene);
    parts.push(place(paint(bulb, { color, emissive }), x, 2.4, 7));
  });
  return merge('lamps', parts);
}

function buildRock(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const blobs: [number, number, number, number, number][] = [
    [0, 0.9, 0, 2.1, 1],
    [1.9, 0.5, 0.8, 1.3, 2],
    [-1.4, 0.4, 1.1, 1.0, 3],
  ];
  for (const [x, y, z, r, seed] of blobs) {
    const blob = facetedBlob(scene, r, 0.72, 0.42, seed, 1);
    // Sunlit top planes cream, flanks lavender, undersides deep slate.
    paint(blob, {
      color: (_p, n) => (n.y > 0.55 ? mix(C.stoneTop, C.lavender, 0.15) : n.y > -0.1 ? mix(C.lavender, C.slate, 0.5 - n.y * 0.5) : C.stoneDark),
      gloss: 0.12,
      ao: (p) => 0.55 + 0.45 * smooth(-0.9 * r, 0.2 * r, p.y),
    });
    parts.push(place(blob, x, y, z));
  }
  return merge('rock', parts);
}

function buildHouse(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const plinth = MeshBuilder.CreateBox('plinth', { width: 5.6, height: 0.5, depth: 5.6 }, scene);
  parts.push(place(paint(plinth, { color: C.lavender, gloss: 0.1 }), 0, 0.25, 0));
  const walls = MeshBuilder.CreateBox('walls', { width: 5, height: 3.2, depth: 5 }, scene);
  // Baked AO: walls darken toward the plinth and under the eaves.
  parts.push(place(paint(walls, { color: C.cream, gloss: 0.18, ao: (p) => 0.6 + 0.4 * smooth(-1.6, -0.6, p.y) * (1 - 0.35 * smooth(1.1, 1.6, p.y)) }), 0, 2.1, 0));
  const roof = MeshBuilder.CreateCylinder('roof', { diameterTop: 0, diameterBottom: 8.4, height: 2.4, tessellation: 4 }, scene);
  roof.convertToFlatShadedMesh();
  parts.push(place(paint(roof, { color: C.coral, gloss: 0.45 }), 0, 4.9, 0, 0, Math.PI / 4));
  const trim = MeshBuilder.CreateBox('trim', { width: 5.5, height: 0.28, depth: 5.5 }, scene);
  parts.push(place(paint(trim, { color: mix(C.cream, [1, 1, 1], 0.4), gloss: 0.3 }), 0, 3.7, 0));
  const door = MeshBuilder.CreateBox('door', { width: 1.1, height: 2.0, depth: 0.16 }, scene);
  parts.push(place(paint(door, { color: C.turquoise, gloss: 0.55 }), -0.9, 1.5, -2.52));
  const win = MeshBuilder.CreateBox('win', { width: 1.2, height: 1.1, depth: 0.12 }, scene);
  parts.push(place(paint(win, { color: C.warmLamp, emissive: 0.75 }), 1.1, 2.2, -2.52));
  const frame = MeshBuilder.CreateBox('frame', { width: 1.5, height: 1.4, depth: 0.08 }, scene);
  parts.push(place(paint(frame, { color: C.cobalt, gloss: 0.5 }), 1.1, 2.2, -2.5));
  const chimney = MeshBuilder.CreateBox('chimney', { width: 0.8, height: 1.8, depth: 0.8 }, scene);
  parts.push(place(paint(chimney, { color: C.cream, gloss: 0.18 }), 1.3, 5.0, 1.0));
  return merge('house', parts);
}

/** Reef-Rocket-ish toy buggy from primitives: glossy turquoise pillow body
 * and fenders, cream stripe, matte chunky tires, coral cage and rims, metal
 * bumper, emissive lamps and turbines. */
function buildToyCar(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const paintGloss = 0.92;
  const body = superEllipsoid(scene, 0.86, 0.44, 1.8, 0.62);
  parts.push(place(paint(body, {
    // Cream racing stripe down the middle: colour split by position on the
    // SAME smooth surface, as the real kit does with face regions.
    color: (p) => (Math.abs(p.x) < 0.2 ? C.cream : C.turquoise),
    gloss: paintGloss,
    ao: (p) => 0.6 + 0.4 * smooth(-0.44, 0.05, p.y),
  }), 0, 1.0, 0));

  const fenders: [number, number, number, number][] = [
    [0.98, 1.06, 1.18, 0.9],
    [-0.98, 1.06, 1.18, 0.9],
    [1.02, 1.12, -1.2, 1.05],
    [-1.02, 1.12, -1.2, 1.05],
  ];
  for (const [x, y, z, s] of fenders) {
    const f = superEllipsoid(scene, 0.4 * s, 0.3 * s, 0.72 * s, 0.7, 20);
    parts.push(place(paint(f, { color: C.turquoise, gloss: paintGloss, ao: (p) => 0.55 + 0.45 * smooth(-0.3, 0.05, p.y) }), x, y, z));
  }

  const wheels: [number, number][] = [
    [1.02, 1.2],
    [-1.02, 1.2],
    [1.06, -1.22],
    [-1.06, -1.22],
  ];
  for (const [x, z] of wheels) {
    const tire = MeshBuilder.CreateTorus('tire', { diameter: 0.7, thickness: 0.46, tessellation: 28 }, scene);
    parts.push(place(paint(tire, { color: C.rubber, gloss: 0.1 }), x, 0.58, z, 0, 0, Math.PI / 2));
    const rim = MeshBuilder.CreateCylinder('rim', { diameter: 0.52, height: 0.34, tessellation: 20 }, scene);
    parts.push(place(paint(rim, { color: C.coral, gloss: 0.8 }), x, 0.58, z, 0, 0, Math.PI / 2));
    const cap = MeshBuilder.CreateSphere('cap', { diameter: 0.24, segments: 12 }, scene);
    parts.push(place(paint(cap, { color: C.steel, gloss: 0.85, metal: 1 }), x + Math.sign(x) * 0.16, 0.58, z));
  }

  // Roll cage: two hoops and two roof rails, coral tube.
  const hoop = (z: number): Vector3[] => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI * (i / 16);
      pts.push(new Vector3(-Math.cos(a) * 0.62, 1.25 + Math.sin(a) * 0.72, z));
    }
    return pts;
  };
  for (const z of [0.25, -0.75]) {
    const tube = MeshBuilder.CreateTube('hoop', { path: hoop(z), radius: 0.065, tessellation: 12, cap: Mesh.CAP_ALL }, scene);
    parts.push(paint(tube, { color: C.coral, gloss: 0.85 }));
  }
  for (const x of [-0.36, 0.36]) {
    const rail = MeshBuilder.CreateTube('rail', {
      path: [new Vector3(x, 1.88, 0.25), new Vector3(x, 1.88, -0.75), new Vector3(x * 1.2, 1.3, -1.45)],
      radius: 0.06,
      tessellation: 12,
      cap: Mesh.CAP_ALL,
    }, scene);
    parts.push(paint(rail, { color: C.coral, gloss: 0.85 }));
  }

  const seat = MeshBuilder.CreateBox('seat', { width: 0.7, height: 0.7, depth: 0.5 }, scene);
  parts.push(place(paint(seat, { color: C.rubber, gloss: 0.15 }), 0, 1.5, -0.35));

  // Headlights: cream pods with a glowing lens.
  for (const x of [-0.5, 0.5]) {
    const pod = superEllipsoid(scene, 0.24, 0.22, 0.26, 0.8, 16);
    parts.push(place(paint(pod, { color: C.cream, gloss: 0.9 }), x, 1.12, 1.62));
    const lens = MeshBuilder.CreateSphere('lens', { diameter: 0.3, segments: 12 }, scene);
    lens.scaling.z = 0.4;
    parts.push(place(paint(lens, { color: C.warmLamp, emissive: 1 }), x, 1.12, 1.84));
  }
  // Tail lamps.
  for (const x of [-0.42, 0.42]) {
    const lamp = MeshBuilder.CreateBox('tail', { width: 0.34, height: 0.14, depth: 0.08 }, scene);
    parts.push(place(paint(lamp, { color: C.tailLamp, emissive: 1 }), x, 1.02, -1.79));
  }
  // Twin turbines on the rear deck.
  for (const x of [-0.42, 0.42]) {
    const ring = MeshBuilder.CreateTorus('ring', { diameter: 0.62, thickness: 0.2, tessellation: 24 }, scene);
    parts.push(place(paint(ring, { color: C.cream, gloss: 0.9 }), x, 1.72, -1.35, Math.PI / 2));
    const disc = MeshBuilder.CreateCylinder('disc', { diameter: 0.56, height: 0.1, tessellation: 20 }, scene);
    parts.push(place(paint(disc, { color: C.rubber, gloss: 0.3 }), x, 1.72, -1.35, Math.PI / 2));
    const hub = MeshBuilder.CreateSphere('hub', { diameter: 0.22, segments: 12 }, scene);
    parts.push(place(paint(hub, { color: C.cyan, emissive: 1 }), x, 1.72, -1.43));
  }
  // Brushed metal bumper bars.
  for (const z of [1.9, -1.9]) {
    const bar = MeshBuilder.CreateCylinder('bumper', { diameter: 0.16, height: 1.5, tessellation: 14 }, scene);
    parts.push(place(paint(bar, { color: C.steel, gloss: 0.6, metal: 1 }), 0, 0.68, z, 0, 0, Math.PI / 2));
  }
  return merge('toyCar', parts);
}

/** Shadow test: a box and a sphere casting onto the ground AND each other. */
function buildShadowTest(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = MeshBuilder.CreateBox('tall', { width: 2, height: 4.5, depth: 2 }, scene);
  parts.push(place(paint(box, { color: C.cream, gloss: 0.25 }), 0, 2.25, 0, 0, 0.5));
  const ball = MeshBuilder.CreateSphere('ball', { diameter: 2.4, segments: 32 }, scene);
  parts.push(place(paint(ball, { color: C.coral, gloss: 0.7 }), 2.5, 1.2, 2.3));
  const slab = MeshBuilder.CreateBox('slab', { width: 3.2, height: 0.5, depth: 3.2 }, scene);
  parts.push(place(paint(slab, { color: C.lavender, gloss: 0.15 }), -3.4, 0.25, -0.6));
  const small = MeshBuilder.CreateSphere('small', { diameter: 1.2, segments: 24 }, scene);
  parts.push(place(paint(small, { color: C.mustard, gloss: 0.85 }), -3.9, 1.1, -1.2));
  // Thin post: the narrowest caster, shows peter-panning at its foot.
  const post = MeshBuilder.CreateCylinder('thin', { diameter: 0.12, height: 3, tessellation: 10 }, scene);
  parts.push(place(paint(post, { color: C.cobalt, gloss: 0.5 }), -1.2, 1.5, 3.4));
  return merge('shadowTest', parts);
}

function buildFlag(scene: Scene): Mesh {
  // An open, single-sided sheet: both faces must light and both must cast.
  const sheet = MeshBuilder.CreateGround('flag', { width: 2.4, height: 1.5, subdivisions: 6 }, scene);
  paint(sheet, {
    color: (p) => ((Math.floor((p.x + 5) * 2.5) + Math.floor((p.z + 5) * 2.5)) % 2 === 0 ? C.turquoise : C.cream),
    gloss: 0.3,
    wind: (p) => smooth(-1.2, 1.2, p.x) * 0.6,
  });
  return sheet;
}

/** Thin-instance prototype: bark trunk + three faceted canopy blobs with
 * lighter tops / cooler undersides, wind weight rising with height. */
function buildTreePrototype(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const trunk = MeshBuilder.CreateCylinder('trunk', { diameterTop: 0.34, diameterBottom: 0.55, height: 2.6, tessellation: 7 }, scene);
  trunk.convertToFlatShadedMesh();
  parts.push(place(paint(trunk, { color: C.bark, gloss: 0.1, ao: (p) => 0.7 + 0.3 * smooth(-1.3, -0.6, p.y) }), 0, 1.3, 0));
  const blobs: [number, number, number, number, number][] = [
    [0, 3.5, 0, 1.6, 11],
    [1.1, 3.0, 0.4, 1.1, 12],
    [-0.9, 3.1, -0.6, 1.2, 13],
  ];
  for (const [x, y, z, r, seed] of blobs) {
    const blob = facetedBlob(scene, r, 0.82, 0.3, seed, 1);
    paint(blob, {
      color: (_p, n) => (n.y > 0.45 ? mix(C.lime, C.limeHi, 0.5) : n.y > -0.25 ? mix(C.lime, C.jade, 0.5 - n.y) : mix(C.jade, C.teal, 0.5)),
      gloss: 0.15,
      ao: (_p, n) => 0.7 + 0.3 * smooth(-0.8, 0.5, n.y),
      wind: 1,
    });
    parts.push(place(blob, x, y, z));
  }
  const tree = merge('treeProto', parts);
  // Rewrite wind weight from the merged height: 0 at the trunk base, 1 at the crown.
  const pos = tree.getVerticesData(VertexBuffer.PositionKind)!;
  const uv2 = tree.getVerticesData(VertexBuffer.UV2Kind)!;
  for (let i = 0; i < pos.length / 3; i++) uv2[i * 2 + 1] = smooth(1.2, 5.0, pos[i * 3 + 1]);
  tree.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2);
  return tree;
}

function buildRockPrototype(scene: Scene): Mesh {
  const blob = facetedBlob(scene, 0.6, 0.7, 0.45, 5, 1);
  paint(blob, {
    color: (_p, n) => (n.y > 0.5 ? C.stoneTop : n.y > -0.1 ? C.lavender : C.stoneDark),
    gloss: 0.1,
    ao: (p) => 0.6 + 0.4 * smooth(-0.4, 0.1, p.y),
  });
  blob.position.y = 0.25;
  blob.bakeCurrentTransformIntoVertices();
  blob.hasVertexAlpha = false;
  return blob;
}

interface Placement {
  x: number;
  z: number;
  scale: number;
  height: number;
  rotY: number;
  tint: RGB;
  ao: number;
  sunVis: number;
}

function scatter(count: number, seed: number, x0: number, x1: number, z0: number, z1: number, scale: [number, number]): Placement[] {
  const rand = mulberry32(seed);
  const list: Placement[] = [];
  for (let i = 0; i < count; i++) {
    const hue = rand();
    list.push({
      x: x0 + rand() * (x1 - x0),
      z: z0 + rand() * (z1 - z0),
      scale: scale[0] + rand() * (scale[1] - scale[0]),
      height: 0.85 + rand() * 0.4,
      rotY: rand() * Math.PI * 2,
      // Tint variety: yellower / bluer / darker individuals.
      tint: [0.82 + hue * 0.3, 0.9 + rand() * 0.14, 0.78 + (1 - hue) * 0.34],
      // Every 5th instance stands in baked shade: proves instanceShade.
      ao: i % 5 === 0 ? 0.55 : 1,
      sunVis: i % 5 === 0 ? 0.25 : 1,
    });
  }
  return list;
}

function instantiate(mesh: Mesh, list: Placement[]): void {
  const matrices = new Float32Array(list.length * 16);
  const tint = new Float32Array(list.length * 3);
  const shade = new Float32Array(list.length * 2);
  const m = new Matrix();
  const q = new Quaternion();
  list.forEach((p, i) => {
    Quaternion.FromEulerAnglesToRef(0, p.rotY, 0, q);
    Matrix.ComposeToRef(new Vector3(p.scale, p.scale * p.height, p.scale), q, new Vector3(p.x, 0, p.z), m);
    m.copyToArray(matrices, i * 16);
    tint.set(p.tint, i * 3);
    shade[i * 2] = p.ao;
    shade[i * 2 + 1] = p.sunVis;
  });
  mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
  mesh.thinInstanceSetBuffer('instanceTint', tint, 3, true);
  mesh.thinInstanceSetBuffer('instanceShade', shade, 2, true);
  mesh.alwaysSelectAsActiveMesh = true;
}

// ---------------------------------------------------------------------------
// Scene

interface Shot {
  yaw: number;
  pitch: number;
  dist: number;
  target: [number, number, number];
  fov?: number;
}

// yaw 0 looks along +z (the chase direction); positive yaw orbits the camera
// to the right (clockwise seen from above).
const SHOTS: Record<string, Shot> = {
  wide: { yaw: 8, pitch: 20, dist: 34, target: [0, 1.5, 6] },
  car: { yaw: -28, pitch: 16, dist: 8.5, target: [0, 1.0, 0] },
  carRear: { yaw: 18, pitch: 20, dist: 9, target: [0, 1.0, 0] },
  carFront: { yaw: 150, pitch: 14, dist: 8.5, target: [0, 1.0, 0] },
  spheres: { yaw: 0, pitch: 24, dist: 17, target: [0, 1, 15] },
  lamps: { yaw: 0, pitch: 12, dist: 9, target: [-5.3, 1.8, 7] },
  shadow: { yaw: -20, pitch: 34, dist: 16, target: [-12, 1.2, -6] },
  contact: { yaw: -40, pitch: 12, dist: 4.2, target: [0.6, 0.5, 0.6] },
  post: { yaw: 30, pitch: 28, dist: 9, target: [-12.5, 0.8, -2.5] },
  house: { yaw: -32, pitch: 18, dist: 20, target: [17, 2, 6] },
  rock: { yaw: 25, pitch: 16, dist: 11, target: [-10, 1, 2] },
  field: { yaw: 35, pitch: 22, dist: 30, target: [-26, 2, 22] },
  top: { yaw: 0, pitch: 52, dist: 60, target: [0, 0, 8] },
  low: { yaw: 5, pitch: 3, dist: 16, target: [0, 4.5, 2] },
};

async function main(): Promise<void> {
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  // Compile shaders synchronously: headless screenshots run on a virtual
  // clock that expires long before an async (parallel) compile reports back,
  // which leaves the first frames — the only ones captured — empty.
  engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);

  const shadowParam = params.get('shadows') ?? '2048';
  const shadowQuality: ShadowQuality = shadowParam === 'off' ? 'off' : shadowParam === '1024' ? 1024 : 2048;
  const tapsParam = params.get('taps');
  const look = createLook(scene, {
    shadowQuality,
    shadowRegion: num('region', 80),
    shadowTaps: tapsParam ? (Number(tapsParam) as ShadowTaps) : undefined,
    sky: params.get('sky') !== '0',
  });

  // Any LookConfig key can be overridden from the URL for A/B screenshots.
  const cfg = look.config as unknown as Record<string, unknown>;
  for (const [key, raw] of params) {
    if (!(key in cfg)) continue;
    const values = raw.split(',').map(Number);
    if (values.some((v) => !Number.isFinite(v))) continue;
    const current = cfg[key];
    if (typeof current === 'number') cfg[key] = values[0];
    else if (Array.isArray(current)) cfg[key] = values;
    else if (current && typeof current === 'object' && values.length === 3) cfg[key] = { x: values[0], y: values[1], z: values[2] };
  }
  look.debugView = num('view', 0);
  // The toy car stands on the origin, nose toward +z.
  if (params.get('contact') !== '0') look.contacts = [{ x: 0, z: 0, yaw: 0, halfX: 1.05, halfZ: 1.75, y: 0 }];
  if (params.has('t')) {
    look.freezeTime = true;
    look.time = num('t', 0);
  }

  const shot = SHOTS[params.get('shot') ?? 'wide'] ?? SHOTS.wide;
  const yaw = (num('yaw', shot.yaw) * Math.PI) / 180;
  const pitch = (num('pitch', shot.pitch) * Math.PI) / 180;
  const camera = new ArcRotateCamera(
    'labCam',
    -Math.PI / 2 - yaw,
    Math.PI / 2 - pitch,
    num('dist', shot.dist),
    new Vector3(num('tx', shot.target[0]), num('ty', shot.target[1]), num('tz', shot.target[2])),
    scene,
  );
  camera.fov = (num('fov', shot.fov ?? 46) * Math.PI) / 180;
  camera.minZ = 0.3;
  camera.maxZ = 3000;
  camera.wheelPrecision = 12;
  camera.lowerRadiusLimit = 2;
  camera.attachControl(canvas, true);

  const toy = createToyMaterial(scene);
  const toyInst = createToyMaterial(scene, { instanced: true });
  const toyInstWind = createToyMaterial(scene, { instanced: true, wind: true });
  const toyFlag = createToyMaterial(scene, { doubleSided: true, wind: true });

  buildGround(scene, look);

  const solids: Mesh[] = [
    buildToyCar(scene),
    buildSpheres(scene),
    buildLamps(scene),
    place(buildRock(scene), -10, 0, 2),
    place(buildHouse(scene), 17, 0, 6, 0, -0.35),
    place(buildShadowTest(scene), -12, 0, -6),
  ];
  for (const mesh of solids) {
    mesh.material = toy;
    mesh.applyFog = false;
    look.shadows.addCaster(mesh);
  }

  const flag = place(buildFlag(scene), -15.5, 2.6, -3.5, Math.PI / 2, 0.6);
  flag.material = toyFlag;
  flag.applyFog = false;
  look.shadows.addCaster(flag, { wind: true });

  const trees = buildTreePrototype(scene);
  instantiate(trees, [
    ...scatter(90, 3, -44, -15, 6, 46, [0.8, 1.5]),
    ...scatter(40, 4, 22, 46, 20, 60, [0.9, 1.6]),
    ...scatter(60, 6, -60, 60, 70, 150, [1.2, 2.4]),
  ]);
  trees.material = toyInstWind;
  trees.applyFog = false;
  look.shadows.addCaster(trees, { wind: true });

  const rocks = buildRockPrototype(scene);
  instantiate(rocks, [
    ...scatter(40, 8, -40, -12, 4, 40, [0.6, 2.2]),
    ...scatter(14, 9, 9, 13, -12, 30, [0.5, 1.2]),
  ]);
  rocks.material = toyInst;
  rocks.applyFog = false;
  look.shadows.addCaster(rocks);

  const focusParam = params.get('focus')?.split(',').map(Number) ?? [];
  const focus = new Vector3(focusParam[0] || 0, 0, focusParam[1] || 0);
  look.shadows.setFocus(focus);

  // late=<quality>: switch shadow quality after the first frame, to prove
  // that a runtime change recompiles every receiver.
  const late = params.get('late');
  let frames = 0;
  if (debugOn) renderDebug('scene built, waiting for first frame');
  engine.runRenderLoop(() => {
    // Babylon only resets this counter under a SceneInstrumentation; without
    // the reset the overlay would show a running total.
    (engine as unknown as { _drawCalls: { fetchNewFrame(): void } })._drawCalls.fetchNewFrame();
    scene.render();
    frames++;
    if (late && frames === 1) look.shadows.setQuality(late === 'off' ? 'off' : late === '1024' ? 1024 : 2048);
    if (debugOn && (frames % 20 === 0 || frames < 3)) {
      const gl = engine._gl;
      const glError = gl ? gl.getError() : 0;
      renderDebug(
        `fps ${engine.getFps().toFixed(0)}  frame ${frames}  draws ${engine._drawCalls.current}`
        + `  tris ${Math.round(scene.getActiveIndices() / 3)}\n`
        + `shadows ${look.shadows.quality} taps ${look.shadows.taps} region ${look.shadows.region} m`
        + `  casters ${look.shadows.map?.renderList?.length ?? 0}  glError ${glError}`,
      );
    }
  });
  window.addEventListener('resize', () => engine.resize());

  (window as unknown as { __lab: unknown }).__lab = { engine, scene, look, camera };
}

main().catch((e) => report('main', String(e)));
