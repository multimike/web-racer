import { Color3, Effect, Mesh, ShaderMaterial, Vector3, VertexData } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import type { LookConfig } from './lighting';

/**
 * Sky dome + a handful of puffy clouds, one mesh, one draw call.
 *
 * Everything is authored as DIRECTIONS (unit-ish vectors around the origin)
 * and projected from the camera position, so the sky is infinitely far: it
 * does not move when the camera does, has no stereo parallax in XR and is
 * immune to the camera far plane. Colours are display-space and never fogged;
 * the horizon colour IS the fog colour, so distant fogged geometry dissolves
 * into the dome without a seam.
 *
 * Clouds are real geometry (clusters of smooth spheres with flat bottoms)
 * rather than sprites: they shade consistently with the sun, look the same
 * from the chase camera and from the diorama view, and cost few triangles
 * with a trivial fragment shader instead of a full-screen noise evaluation.
 * (~20k triangles: 16 clouds of 8 x 12 puffs.)
 */

const SHADER = 'lookSky';

/** World-unit radius the directions are projected at. Only has to dwarf the
 * camera's stereo baseline (3.2 m when the XR rig is scaled ×50). */
const SKY_RADIUS = 5000;

function registerSkyShader(): void {
  if (Effect.ShadersStore[`${SHADER}VertexShader`]) return;
  Effect.ShadersStore[`${SHADER}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    uniform mat4 viewProjection;
    #ifdef MULTIVIEW
    uniform mat4 viewProjectionR;
    #endif
    uniform vec3 cameraPosition;
    varying vec3 vDir;
    varying vec3 vNormal;
    varying vec4 vColor;
    void main() {
      vDir = position;
      vNormal = normal;
      vColor = color;
      vec4 wp = vec4(cameraPosition + position * ${SKY_RADIUS.toFixed(1)}, 1.0);
      #ifdef MULTIVIEW
      vec4 clip = gl_ViewID_OVR == 0u ? viewProjection * wp : viewProjectionR * wp;
      #else
      vec4 clip = viewProjection * wp;
      #endif
      // Depth is assigned, not projected: the dome sits a hair inside the far
      // plane and clouds get a thin slice just in front of it, ordered by
      // their authored distance so the spheres of a cloud occlude each other
      // correctly. The slice starts at NDC 0.9999 (window depth 0.99995) =
      // beyond 20 000× the near plane, i.e. behind every real object.
      float d = clamp(length(position), 0.0, 1.0);
      clip.z = clip.w * mix(0.9999, 0.999999, d);
      gl_Position = clip;
    }
  `;
  Effect.ShadersStore[`${SHADER}FragmentShader`] = `
    precision highp float;
    varying vec3 vDir;
    varying vec3 vNormal;
    varying vec4 vColor;
    uniform vec3 skyZenith;
    uniform vec3 skyHorizon;
    uniform vec3 skySunDir;
    uniform vec3 skySunGlow;
    uniform vec3 skyCloudLight;
    uniform vec3 skyCloudShade;
    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y, 0.0, 1.0);
      // Fast rise off the horizon, slow approach to the zenith: a pale band
      // hugging the hills under a big field of clean blue. (Final review
      // round: fourth power, was cubic — the 4-10 degrees the chase camera
      // sees over the hills are a clearer blue, so white cloud tops read
      // against them as in the vision; the horizon itself is still the fog
      // colour.)
      float h1 = 1.0 - h;
      float t = 1.0 - h1 * h1 * h1 * h1;
      vec3 sky = mix(skyHorizon, skyZenith, t);
      float sd = max(dot(d, skySunDir), 0.0);
      float sd4 = sd * sd * sd * sd;
      float halo = sd4 * sd4;
      halo *= halo;
      sky += skySunGlow * (smoothstep(0.9993, 0.9997, sd) * 2.0 + halo * halo * 0.6 + halo * 0.12);

      vec3 col = sky;
      if (vColor.a > 0.5) {
        vec3 n = normalize(vNormal);
        float lit = smoothstep(-0.5, 0.75, dot(n, skySunDir));
        float up = n.y * 0.5 + 0.5;
        // Sunlit warm white on top, cool lavender-blue belly.
        vec3 cloud = mix(skyCloudShade, skyCloudLight, clamp(lit * 0.65 + up * 0.5, 0.0, 1.0));
        cloud *= vColor.rgb;
        // Aerial perspective: low clouds sink a little into the horizon haze
        // (was 0.55 at the horizon: the low clouds the chase camera sees
        // were washed out to nothing).
        col = mix(skyHorizon, cloud, 0.8 + 0.2 * smoothstep(0.02, 0.2, d.y));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;
}

export class SkyDome {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly zenith = new Color3();
  private readonly horizon = new Color3();
  private readonly glow = new Color3();
  private readonly cloudLight = new Color3();
  private readonly cloudShade = new Color3();
  private readonly sunDir = new Vector3();

  constructor(scene: Scene, seed = 7) {
    registerSkyShader();
    const mat = new ShaderMaterial('lookSky', scene, SHADER, {
      attributes: ['position', 'normal', 'color'],
      uniforms: [
        'viewProjection',
        'cameraPosition',
        'skyZenith',
        'skyHorizon',
        'skySunDir',
        'skySunGlow',
        'skyCloudLight',
        'skyCloudShade',
      ],
      // Not an alpha test at all — the flag only moves the sky into Babylon's
      // alpha-test queue, which is drawn AFTER all opaque meshes. The sky is
      // then depth-rejected wherever the world covers it, instead of being
      // shaded full-screen first and overdrawn.
      needAlphaTesting: true,
    });
    // The dome is seen from inside and cloud winding does not matter.
    mat.backFaceCulling = false;
    this.material = mat;

    const mesh = new Mesh('lookSky', scene);
    buildSkyGeometry(seed).applyToMesh(mesh);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.hasVertexAlpha = false;
    // Positions are directions, so the bounding box is meaningless.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    this.mesh = mesh;
  }

  update(config: LookConfig, sunDir: Vector3): void {
    const m = this.material;
    this.zenith.set(config.zenithColor[0], config.zenithColor[1], config.zenithColor[2]);
    this.horizon.set(config.fogColor[0], config.fogColor[1], config.fogColor[2]);
    this.glow.set(
      config.sunColor[0] * config.sunGlow,
      config.sunColor[1] * config.sunGlow,
      config.sunColor[2] * config.sunGlow,
    );
    this.cloudLight.set(config.cloudLight[0], config.cloudLight[1], config.cloudLight[2]);
    this.cloudShade.set(config.cloudShade[0], config.cloudShade[1], config.cloudShade[2]);
    this.sunDir.copyFrom(sunDir);
    m.setColor3('skyZenith', this.zenith);
    m.setColor3('skyHorizon', this.horizon);
    m.setColor3('skySunGlow', this.glow);
    m.setColor3('skyCloudLight', this.cloudLight);
    m.setColor3('skyCloudShade', this.cloudShade);
    m.setVector3('skySunDir', this.sunDir);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometry

interface Buffers {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

function buildSkyGeometry(seed: number): VertexData {
  const b: Buffers = { positions: [], normals: [], colors: [], indices: [] };
  addDome(b);
  const rand = mulberry32(seed);

  // A ring of clouds low in the sky. Azimuth slots are jittered, not random,
  // so there is always one in view and never a pile-up. Elevation: the chase
  // camera (pitch ~12 deg down, vertical fov ~46 deg) sees sky only from the
  // hill tops (~3-5 deg) to ~10 deg, and the high and xr cameras see none, so
  // the bases sit at 3.5-8 deg and the cumulus towers up into the frame top.
  // Bases used to be 4-19 deg, i.e. half the clouds above
  // every chase frame and the rest washed into the horizon haze — no cloud in
  // any chase shot. 16 clouds of lighter puffs cost fewer triangles than the
  // 14 before (~20k against ~23k: the diorama counts the sky too).
  const count = 16;
  for (let i = 0; i < count; i++) {
    const az = ((i + 0.15 + rand() * 0.7) / count) * Math.PI * 2;
    const el = 0.06 + rand() * 0.08;
    const dist = 0.55 + rand() * 0.35;
    const size = 0.035 + rand() * 0.03;
    addCloud(b, az, el, dist, size, rand);
  }

  const data = new VertexData();
  data.positions = b.positions;
  data.normals = b.normals;
  data.colors = b.colors;
  data.indices = b.indices;
  return data;
}

/** Unit dome, length(position) = 1 → farthest depth slot; colour alpha 0 =
 * "sky" in the fragment shader. Extends below the horizon so a camera above
 * the world edge still sees horizon colour instead of the clear colour. */
function addDome(b: Buffers): void {
  const rings = 12;
  const segs = 24;
  const base = b.positions.length / 3;
  for (let r = 0; r <= rings; r++) {
    const phi = -0.5 * Math.PI + (r / rings) * Math.PI;
    for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const x = Math.cos(phi) * Math.cos(th);
      const y = Math.sin(phi);
      const z = Math.cos(phi) * Math.sin(th);
      b.positions.push(x, y, z);
      b.normals.push(-x, -y, -z);
      b.colors.push(1, 1, 1, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const i0 = base + r * (segs + 1) + s;
      const i1 = i0 + 1;
      const i2 = i0 + segs + 1;
      const i3 = i2 + 1;
      b.indices.push(i0, i1, i2, i1, i3, i2);
    }
  }
}

/** One cumulus: a row of overlapping spheres, biggest in the middle, all cut
 * flat at a common base — the classic cartoon cloud silhouette. Built in a
 * local frame (x = along the cloud, y = up, z = toward the viewer) and placed
 * on the dome at (azimuth, elevation, distance). */
function addCloud(
  b: Buffers,
  az: number,
  el: number,
  dist: number,
  size: number,
  rand: () => number,
): void {
  const cx = Math.cos(el) * Math.cos(az) * dist;
  const cy = Math.sin(el) * dist;
  const cz = Math.cos(el) * Math.sin(az) * dist;
  // Tangent frame at that point of the dome; y stays world-up so cloud
  // bases are level with the horizon.
  const tx = -Math.sin(az);
  const tz = Math.cos(az);
  const ix = -Math.cos(az);
  const iz = -Math.sin(az);

  const puffs = 5 + Math.floor(rand() * 4);
  const tone = 0.96 + rand() * 0.04;
  const s = size * dist;
  for (let p = 0; p < puffs; p++) {
    const k = p / (puffs - 1) - 0.5; // −0.5 … 0.5 along the cloud
    const bulge = 1 - Math.abs(k) * 1.6;
    // Alternate big and small puffs so the top edge is a lumpy cumulus
    // outline rather than an even row of domes.
    const radius = s * (0.3 + 0.55 * bulge * (p % 2 === 0 ? 1 : 0.72) + rand() * 0.16);
    const lx = k * s * 3.4 + (rand() - 0.5) * s * 0.35;
    const ly = radius * (0.25 + rand() * 0.4);
    const lz = (rand() - 0.5) * s * 0.9;
    addPuff(b, radius, tone, (x, y, z) => [
      cx + tx * (lx + x) + ix * (lz + z),
      cy + Math.max(ly + y, 0),
      cz + tz * (lx + x) + iz * (lz + z),
    ], (x, y, z, flat) => (flat
      ? [0, -1, 0]
      : [tx * x + ix * z, y, tz * x + iz * z]));
  }
}

function addPuff(
  b: Buffers,
  radius: number,
  tone: number,
  place: (x: number, y: number, z: number) => [number, number, number],
  orient: (x: number, y: number, z: number, flat: boolean) => [number, number, number],
): void {
  const rings = 8;
  const segs = 12;
  const base = b.positions.length / 3;
  for (let r = 0; r <= rings; r++) {
    const phi = -0.5 * Math.PI + (r / rings) * Math.PI;
    for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const nx = Math.cos(phi) * Math.cos(th);
      const ny = Math.sin(phi);
      const nz = Math.cos(phi) * Math.sin(th);
      const pos = place(nx * radius, ny * radius, nz * radius);
      // Vertices pushed up onto the base plane get a straight-down normal so
      // the belly shades as one flat cool underside.
      const flat = ny < 0 && pos[1] <= place(0, -radius, 0)[1] + 1e-6;
      const nrm = orient(nx, ny, nz, flat);
      b.positions.push(pos[0], pos[1], pos[2]);
      b.normals.push(nrm[0], nrm[1], nrm[2]);
      b.colors.push(tone, tone, tone, 1);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const i0 = base + r * (segs + 1) + s;
      const i1 = i0 + 1;
      const i2 = i0 + segs + 1;
      const i3 = i2 + 1;
      b.indices.push(i0, i1, i2, i1, i3, i2);
    }
  }
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
