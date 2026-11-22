import { ArcRotateCamera, Effect, Engine, Mesh, MeshBuilder, RawTexture, Scene, ShaderMaterial, Texture, Vector3, Vector4, VertexBuffer, VertexData } from '@babylonjs/core';
import type { GroundPalette, GroundTile } from '../gfx/ground/core';
import {
  GROUND_MATERIALS,
  GROUND_MATERIAL_IDS,
  PACK_MATERIAL_IDS,
  bindGroundLayer,
  createGroundLayer,
  createGroundTextures,
  groundLayerSamplers,
  groundLayerUniforms,
  registerGroundShader,
} from '../gfx/ground';
import type { GroundLayer, GroundMaterialId } from '../gfx/ground';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, createLook } from '../gfx/look/lighting';
import type { LookRuntime, ShadowQuality } from '../gfx/look/lighting';
import { createToyMaterial } from '../gfx/look/ToyMaterial';

/**
 * Ground lab (ground-lab.html) — the bench for the generated ground
 * materials (src/gfx/ground) and the honest side-by-side against the
 * downloaded ground-material-pack they are meant to replace.
 *
 * URL parameters
 *   mode=grid    (default) flat, UNLIT comparison, same world scale in every cell:
 *                row 1 the pack's basecolor, row 2 generated with the pack's
 *                colours, row 3 generated with the vision colours (shipping).
 *                  mat=<id>        one material large instead of the overview
 *                  meters=<m>      world size shown per cell (overview 8, single 4)
 *                  show=height     the height channel instead of the albedo
 *   mode=lit     strips of every material under the real look lighting, with
 *                kerb strips between them and a few shadow casters
 *   mode=far     a 200 m plane of ONE material (mat=<id>) to judge repetition
 *                (cam=top&dist=60 is the view the repeat is MEASURED on:
 *                51 m across, autocorrelation at the tile period)
 *   mode=road    a curving road like the vision: dirt -> cobblestone with
 *                stones breaking through, kerbs, grass verge with gravel
 *                patches, asphalt apron with painted lines
 *   source=generated|pack   lit / far / road: the generated tiles, or the
 *                pack's own maps (basecolor + height) through the SAME shader
 *                (CAVEAT: the pack is authored for its normal / AO / ORM maps,
 *                which this path does not use — its relief comes from its
 *                height map, low-passed like the generated one. So a lit
 *                pack shot judges its COLOUR and PATTERN fairly, not the
 *                best lighting the pack could have. And its cobblestone has
 *                no stone id map, so it gets groundTinted, not groundStones.)
 *   palette=vision|pack     colours of the generated tiles (default vision)
 *   size=<px>    generated tile size (default 512);  packSize=<px> (default 1024)
 *   cobbleSize=<px>  size of the cobblestone tile alone (3D modes)
 *   cobbleMeters=<m> world size of the cobblestone tile (default 6; try 12 with cobbleSize=1024)
 *   seed=<n>     world seed for the generators
 *   cam=chase|elevated|diorama|top   camera preset;  mat=<id> also aims the
 *                lit camera at that material's strip
 *   yaw, pitch (deg), dist, tx, ty, tz, fov   override the preset
 *   antitile=0   one tap per layer (shows the raw repeat, and stone layouts
 *                in the plain tone they are built in)
 *   streak=<0..1> tire-streak amount of the road dirt (default 0.6);
 *                streaks=0 samples the lit dirt strip like terrain instead
 *   village=<m>  road mode: distance along the road where the paving starts
 *   macro=<0..1> tonal drift of the slow fields (default 0.1);  bump=<x>  relief multiplier
 *   unlit=1      albedo only, in the 3D views
 *   shadows=off|1024|2048   view=1..7 (look debug views)
 *   ui=0         hide the overlay
 *   <any LookConfig key>=<number | r,g,b>
 */

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Overlay: headless screenshots have no console, so errors must be IN the
// picture — also with ui=0.

const debugEl = document.getElementById('debug') as HTMLPreElement;
if (params.get('ui') === '0') document.body.classList.add('noui');
const problems: string[] = [];
let infoText = '';
function renderDebug(): void {
  debugEl.innerHTML = '';
  debugEl.classList.toggle('haserr', problems.length > 0);
  if (infoText && !document.body.classList.contains('noui')) debugEl.append(infoText + (problems.length ? '\n' : ''));
  for (const p of problems) {
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = p + '\n';
    debugEl.append(span);
  }
}
function report(kind: string, message: string): void {
  if (problems.length > 10) return;
  problems.push(`${kind}: ${message.slice(0, 700)}`);
  renderDebug();
}
function info(text: string): void {
  infoText = text;
  renderDebug();
}
window.addEventListener('error', (e) => report('error', e.message));
window.addEventListener('unhandledrejection', (e) => report('rejection', String(e.reason)));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  report('console.error', args.map(String).join(' '));
  consoleError(...args);
};

// ---------------------------------------------------------------------------
// Shared options

const SIZE = num('size', 512);
const PACK_SIZE = num('packSize', 1024);
const PALETTE: GroundPalette = params.get('palette') === 'pack' ? 'pack' : 'vision';
const SEED = params.has('seed') ? num('seed', 0) : undefined;
const SOURCE: 'generated' | 'pack' = params.get('source') === 'pack' ? 'pack' : 'generated';
const isId = (v: string | null): v is GroundMaterialId => v !== null && (GROUND_MATERIAL_IDS as readonly string[]).includes(v);
// tools/shot.sh runs headless Chrome on a VIRTUAL clock: performance.now()
// there is not wall time (shots have printed "0 ms" and "fps Infinity").
const HEADLESS = /HeadlessChrome/.test(navigator.userAgent);
const CLOCK_NOTE = HEADLESS ? ' [headless virtual clock: NOT a measurement]' : '';

// ---------------------------------------------------------------------------
// The pack, loaded as tiles of the same shape the generators produce

/** White of the pack's height maps, meters (its README). */
const PACK_RELIEF: Record<string, number> = {
  'rally-dirt': 0.035,
  'sunlit-sand': 0.025,
  'meadow-grass': 0.025,
  'lavender-gravel': 0.055,
  'worn-asphalt': 0.006,
  'village-cobblestone': 0.04,
};
const PACK_TILE_METERS = 4;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

function imagePixels(img: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * A pack material as a GroundTile: its basecolor (the pack's own 2048 px
 * PNG, scaled to `px`) in rgb and its height map in alpha — so the pack runs
 * through exactly the shader path of the generated tiles and the only
 * difference in a source=pack screenshot is the texture content.
 *
 * The pack is reference material and is NOT in git (148 MB): the dev server
 * serves it straight from design-documents/ when it is on disk. `null` when
 * it is not — the lab then shows the generated materials only.
 */
async function loadPackTile(id: GroundMaterialId, px: number, withHeight: boolean): Promise<GroundTile | null> {
  let color: HTMLImageElement;
  try {
    color = await loadImage(`/design-documents/ground-material-pack/${id}/basecolor.png`);
  } catch {
    return null;
  }
  const rgba = imagePixels(color, px, px);
  const pixels = new Uint8Array(rgba.length);
  pixels.set(rgba);
  if (withHeight) {
    const height = imagePixels(await loadImage(`/design-documents/ground-material-pack/${id}/height.png`), px, px);
    const z = new Float32Array(px * px);
    for (let i = 0; i < z.length; i++) z[i] = height[i * 4];
    // The generated tiles low-pass their height (Surface.smoothHeight)
    // because the lighting normal comes from derivatives of the magnified
    // height and a raw one staircases. The pack gets the same blur in WORLD
    // units: one pass spreads ~1 texel, the generated texel is 4 m / SIZE.
    const passes = Math.max(1, Math.round(((px / SIZE) * (4 / PACK_TILE_METERS)) ** 2));
    for (let k = 0; k < passes; k++) binomialBlur(z, px);
    for (let i = 0; i < z.length; i++) pixels[i * 4 + 3] = Math.round(z[i]);
  }
  const mean: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    mean[0] += pixels[i];
    mean[1] += pixels[i + 1];
    mean[2] += pixels[i + 2];
    mean[3] += pixels[i + 3];
  }
  for (let k = 0; k < 4; k++) mean[k] /= px * px * 255;
  return { id, width: px, height: px, pixels, mean, tileMeters: [PACK_TILE_METERS, PACK_TILE_METERS], reliefMeters: PACK_RELIEF[id] };
}

/** Wrapped 1-4-6-4-1 blur each way, in place (the filter of
 * Surface.smoothHeight). */
function binomialBlur(z: Float32Array, n: number): void {
  const t = new Float32Array(n * n);
  const m = n - 1; // n is a power of two
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      t[row + x] =
        0.0625 * (z[row + ((x - 2) & m)] + z[row + ((x + 2) & m)]) + 0.25 * (z[row + ((x - 1) & m)] + z[row + ((x + 1) & m)]) + 0.375 * z[row + x];
    }
  }
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const u1 = ((y - 1) & m) * n;
    const u2 = ((y - 2) & m) * n;
    const d1 = ((y + 1) & m) * n;
    const d2 = ((y + 2) & m) * n;
    for (let x = 0; x < n; x++) z[row + x] = 0.0625 * (t[u2 + x] + t[d2 + x]) + 0.25 * (t[u1 + x] + t[d1 + x]) + 0.375 * t[row + x];
  }
}

// ---------------------------------------------------------------------------
// mode=grid — flat, unlit, 2D canvas (no WebGL involved: what you see is the
// texel data)

function tileCanvas(tile: GroundTile, channel: 'albedo' | 'height'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = tile.width;
  c.height = tile.height;
  const ctx = c.getContext('2d')!;
  const image = ctx.createImageData(tile.width, tile.height);
  const src = tile.pixels;
  const dst = image.data;
  for (let i = 0; i < src.length; i += 4) {
    if (channel === 'height') {
      dst[i] = dst[i + 1] = dst[i + 2] = src[i + 3];
    } else {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
    }
    dst[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return c;
}

/** Halve until within 2x of the target: a single big drawImage downscale
 * has no mip chain and would sparkle, flattering neither side. */
function shrinkTo(source: HTMLCanvasElement, targetW: number): HTMLCanvasElement {
  let cur = source;
  while (cur.width / 2 >= targetW && cur.width > 8) {
    const next = document.createElement('canvas');
    next.width = cur.width >> 1;
    next.height = Math.max(1, cur.height >> 1);
    const ctx = next.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  return cur;
}

/** Draw `meters` x `meters` of a repeating tile into a square cell. */
function drawPatch(ctx: CanvasRenderingContext2D, tile: GroundTile, channel: 'albedo' | 'height', x: number, y: number, cell: number, meters: number): void {
  // Whole-pixel tile size and positions: a tile drawn at a fractional
  // position gets a blended edge, which reads as a seam that is not there.
  const tw = Math.max(1, Math.round((tile.tileMeters[0] / meters) * cell));
  const th = Math.max(1, Math.round((tile.tileMeters[1] / meters) * cell));
  const img = shrinkTo(tileCanvas(tile, channel), tw);
  // Resample ONE tile to its on-screen size, then repeat it as a pattern.
  const one = document.createElement('canvas');
  one.width = tw;
  one.height = th;
  const octx = one.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';
  // Draw the 3x3 neighbourhood so the resampling filter wraps at the edges.
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) octx.drawImage(img, i * tw, j * th, tw, th);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ctx.createPattern(one, 'repeat')!;
  ctx.fillRect(0, 0, cell, cell);
  ctx.restore();
}

function meanLabel(tile: GroundTile): string {
  return `mean ${tile.mean.slice(0, 3).map((v) => Math.round(v * 255)).join(',')}`;
}

const gridTiles = new Map<string, { tile: GroundTile | null; ms: number }>();
let gridRun = 0;

async function runGrid(): Promise<void> {
  document.body.classList.add('grid');
  await drawGrid();
  // Headless Chrome settles its viewport after the first layout; a bitmap
  // drawn for the old size would be stretched by CSS, so redraw (tiles are
  // cached, only the layout is redone).
  let pending = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => void drawGrid());
  });
}

async function drawGrid(): Promise<void> {
  const run = ++gridRun;
  const canvas = document.getElementById('grid') as HTMLCanvasElement;
  // Size the bitmap from the laid-out element: a canvas stretched by CSS
  // would show the cells at the wrong aspect and resample every texel.
  const box = canvas.getBoundingClientRect();
  const W = (canvas.width = Math.round(box.width));
  const H = (canvas.height = Math.round(box.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1d2530';
  ctx.fillRect(0, 0, W, H);
  const channel = params.get('show') === 'height' ? 'height' : 'albedo';
  const single = params.get('mat');
  const ids: GroundMaterialId[] = isId(single) ? [single] : [...GROUND_MATERIAL_IDS];
  const meters = num('meters', isId(single) ? 4 : 8);
  const ui = params.get('ui') !== '0';

  const rows: { label: string; tile: (id: GroundMaterialId) => Promise<GroundTile | null> | GroundTile | null }[] = [
    {
      label: `PACK  (design-documents, scaled to ${PACK_SIZE} px, 4 m tile; blank = pack not on disk)`,
      tile: (id) => (PACK_MATERIAL_IDS.includes(id) ? loadPackTile(id, PACK_SIZE, channel === 'height') : null),
    },
    { label: `GENERATED  pack colours  (${SIZE} px)`, tile: (id) => GROUND_MATERIALS[id].generate({ size: SIZE, seed: SEED, palette: 'pack' }) },
    { label: `GENERATED  vision colours = shipping  (${SIZE} px)`, tile: (id) => GROUND_MATERIALS[id].generate({ size: SIZE, seed: SEED, palette: 'vision' }) },
  ];

  const pad = 8;
  const head = ui ? 44 : 0;
  const rowHead = ui ? 18 : 0;
  // Single material: the three versions side by side; overview: one column
  // per material, one row per version.
  const cols = isId(single) ? rows.length : ids.length;
  const lines = isId(single) ? 1 : rows.length;
  const cell = Math.floor(Math.min((W - pad * (cols + 1)) / cols, (H - head - (rowHead + pad) * lines - pad) / lines));
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';

  let totalMs = 0;
  const timings: string[] = [];
  for (let c = 0; c < ids.length; c++) {
    const id = ids[c];
    for (let r = 0; r < rows.length; r++) {
      const col = isId(single) ? r : c;
      const line = isId(single) ? 0 : r;
      const x = pad + col * (cell + pad);
      const y = head + line * (cell + rowHead + pad) + rowHead;
      const key = `${r}:${id}`;
      if (!gridTiles.has(key)) {
        const t0 = performance.now();
        const made = await rows[r].tile(id);
        gridTiles.set(key, { tile: made, ms: performance.now() - t0 });
      }
      // A newer draw (resize) has taken over the canvas.
      if (run !== gridRun) return;
      const { tile, ms } = gridTiles.get(key)!;
      if (r === 2) {
        totalMs += ms;
        timings.push(`${id} ${ms.toFixed(0)}`);
      }
      if (!tile) {
        ctx.fillStyle = '#2a3442';
        ctx.fillRect(x, y, cell, cell);
        ctx.fillStyle = '#8fa0b4';
        ctx.fillText('not in the pack', x + 8, y + 8);
        continue;
      }
      drawPatch(ctx, tile, channel, x, y, cell, meters);
      if (ui) {
        ctx.fillStyle = '#e8eef5';
        const what = isId(single) ? rows[r].label : r === 0 ? GROUND_MATERIALS[id].name : '';
        ctx.fillText(`${what}  ${meanLabel(tile)}`.trim(), x, y - rowHead + 2, cell);
      }
    }
  }
  if (ui) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '13px ui-monospace, Menlo, monospace';
    const title = isId(single)
      ? `${GROUND_MATERIALS[single].name} — ${meters} m x ${meters} m per panel, unlit ${channel}`
      : `Ground materials — every cell shows ${meters} m x ${meters} m, unlit ${channel}.  Rows: ${rows.map((r) => r.label.split('  ')[0] + ' ' + (r.label.split('  ')[1] ?? '')).join('  |  ')}`;
    ctx.fillText(title, pad, 6, W - pad * 2);
    ctx.fillStyle = '#9fb2c8';
    ctx.fillText(`generation, vision row: ${totalMs.toFixed(0)} ms wall${CLOCK_NOTE}  (${timings.join(', ')})`, pad, 24, W - pad * 2);
  }
}

// ---------------------------------------------------------------------------
// 3D modes

const VERTEX = `
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  uniform mat4 world;
  uniform mat4 viewProjection;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUV;
  void main() {
    vec4 wp = world * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
    vUV = uv;
    gl_Position = viewProjection * wp;
  }
`;

/** One layer on a mesh: the simplest complete use of the chunk. */
const STRIP_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUV;
  uniform sampler2D gATex;
  uniform sampler2D gAIds;
  uniform vec4 gAMean;
  uniform vec4 gAInfo;
  // No semicolons in comments on uniform lines: Babylon's shader processor
  // splits declarations on them and the rest of the comment becomes code.
  // labOpts: x sampling (0 one tap, 1 two-tap blend, 2 streaked, 3 tinted, 4 stones), y macro amount,
  //          z uv source (1 mesh uv in meters, 0 world xz), w 1 = unlit
  // labCavity: x lo, y hi, z strength, w 1 = painted parking boxes
  uniform vec4 labOpts;
  uniform vec4 labCavity;
  uniform float labStreak;
  #include<lookLighting>
  #include<groundLayers>
  void main() {
    vec2 pos = labOpts.z > 0.5 ? vUV : vWorldPos.xz;
    vec2 uv = pos * gAInfo.xy;
    vec3 vary = groundVary(vWorldPos.xz);
    vec4 s;
    if (labOpts.x < 0.5) s = groundTap(gATex, uv);
    else if (labOpts.x < 1.5) s = groundSample(gATex, uv, vary.x, gAMean, gAInfo.w);
    else if (labOpts.x < 2.5) s = groundStreaked(gATex, uv, vary.x, gAMean, labStreak);
    else if (labOpts.x < 3.5) s = groundTinted(gATex, uv, gAMean, gAInfo.w);
    else s = groundStones(gATex, gAIds, pos, gAInfo);
    vec3 srgb = groundMacro(s.rgb, vary, labOpts.y);
    if (labCavity.w > 0.5) {
      // Parking boxes: 0.16 m lines on a 5 m x 7 m grid.
      vec2 g = abs(fract(vWorldPos.xz / vec2(5.0, 7.0)) - 0.5) * vec2(5.0, 7.0);
      float line = 1.0 - smoothstep(0.07, 0.09, min(g.x, g.y));
      srgb = groundPaint(srgb, s.a, line, vec3(0.93, 0.76, 0.2));
    }
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * gAInfo.z);
    float ao = mix(1.0, groundCavity(s.a, labCavity.x, labCavity.y), labCavity.z);
    if (labOpts.w > 0.5) { gl_FragColor = vec4(srgb, 1.0); return; }
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, ao, 1.0);
  }
`;

/** Terrain: three layers mixed by weights — the pattern of the terrain
 * snippet in src/gfx/ground/index.ts, with lab-made masks standing in for
 * the splat weights the real terrain carries per vertex. */
const TERRAIN_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  uniform sampler2D gGrassTex;
  uniform vec4 gGrassMean;
  uniform vec4 gGrassInfo;
  uniform sampler2D gGravelTex;
  uniform vec4 gGravelMean;
  uniform vec4 gGravelInfo;
  uniform sampler2D gDirtTex;
  uniform vec4 gDirtMean;
  uniform vec4 gDirtInfo;
  uniform vec4 labOpts;
  #include<lookLighting>
  #include<groundLayers>
  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 vary = groundVary(xz);
    vec2 dx = dFdx(xz);
    vec2 dy = dFdy(xz);
    // Lab-only masks (the game feeds its splat weights here instead).
    float mGravel = smoothstep(0.66, 0.8, groundNoise(xz * 0.05 + 31.0));
    float mDirt = smoothstep(0.7, 0.84, groundNoise(xz * 0.07 + 77.0)) * (1.0 - mGravel);
    vec4 w = vec4(1.0 - mGravel - mDirt, mGravel, mDirt, 0.0);
    // Sample only the layers present here: most pixels are one layer, so
    // this is 2 taps, not 6.
    vec4 sGrass = vec4(0.0);
    vec4 sGravel = vec4(0.0);
    vec4 sDirt = vec4(0.0);
    if (w.x > 0.004) sGrass = groundSampleGrad(gGrassTex, xz * gGrassInfo.xy, dx * gGrassInfo.xy, dy * gGrassInfo.xy, vary.x, gGrassMean, gGrassInfo.w);
    if (w.y > 0.004) sGravel = groundSampleGrad(gGravelTex, xz * gGravelInfo.xy, dx * gGravelInfo.xy, dy * gGravelInfo.xy, vary.x, gGravelMean, gGravelInfo.w);
    if (w.z > 0.004) sDirt = groundSampleGrad(gDirtTex, xz * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, gDirtInfo.w);
    w = groundWeights(w, vec4(sGrass.a, sGravel.a, sDirt.a, 0.0), 0.2);
    vec4 s = w.x * sGrass + w.y * sGravel + w.z * sDirt;
    float bump = dot(w.xyz, vec3(gGrassInfo.z, gGravelInfo.z, gDirtInfo.z));
    vec3 srgb = groundMacro(s.rgb, vary, labOpts.y);
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
    if (labOpts.w > 0.5) { gl_FragColor = vec4(srgb, 1.0); return; }
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, groundCavity(s.a, 0.1, 0.5), 1.0);
  }
`;

/** Road ribbon: uv.x = meters from the centreline (signed), uv.y = meters
 * along it. Dirt with streaks -> cobblestone, stones breaking through
 * top-first; a kerb strip on both edges. */
const ROAD_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUV;
  uniform sampler2D gDirtTex;
  uniform vec4 gDirtMean;
  uniform vec4 gDirtInfo;
  uniform sampler2D gCobbleTex;
  uniform sampler2D gCobbleIds;
  uniform vec4 gCobbleMean;
  uniform vec4 gCobbleInfo;
  uniform sampler2D gKerbTex;
  uniform vec4 gKerbMean;
  uniform vec4 gKerbInfo;
  uniform vec4 labOpts;
  // roadShape: x half width of the driving surface, y kerb width,
  //            z v where the village paving starts, w length of the transition
  uniform vec4 roadShape;
  uniform vec4 roadShape2;
  #include<lookLighting>
  #include<groundLayers>
  void main() {
    vec3 vary = groundVary(vWorldPos.xz);
    float across = abs(vUV.x);
    // Derivatives once, outside the branch; the Grad samplers take them.
    vec2 dx = dFdx(vUV);
    vec2 dy = dFdy(vUV);
    // Kerb | road border, filtered: 0 on the road, 1 on the kerb, and in
    // the one pixel between both sides are sampled.
    float kerb = groundEdge(across - roadShape.x);
    vec4 sKerb = vec4(0.0);
    vec4 sRoad = vec4(0.0);
    float bumpRoad = 0.0;
    float aoRoad = 1.0;
    if (kerb > 0.0) {
      // u runs from the road side (0) to the verge side (1); the two sides
      // get different v offsets so their joints do not mirror.
      vec2 kscale = vec2(1.0 / roadShape.y, gKerbInfo.y);
      vec2 kuv = vec2((across - roadShape.x) * kscale.x, vUV.y * kscale.y + step(0.0, vUV.x) * 0.37);
      sKerb = groundTapGrad(gKerbTex, kuv, dx * kscale, dy * kscale);
    }
    if (kerb < 1.0) {
      // 0 = dirt road, 1 = village paving, along a wobbly front instead
      // of a ruled line. groundBlend only mixes for t in 0.28 .. 0.72 (with
      // these height ranges and soft = 0.07), so outside it one of the two
      // surfaces is not sampled at all.
      float t = clamp((vUV.y - roadShape.z) / roadShape.w + (groundNoise(vUV * 0.35) - 0.5) * 0.5, 0.0, 1.0);
      vec4 dirt = vec4(0.0, 0.0, 0.0, 0.5);
      vec4 cobble = vec4(0.0);
      if (t < 0.72) dirt = groundStreakedGrad(gDirtTex, vUV * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, roadShape2.x);
      if (t > 0.28) {
        // Lab switch (roadShape2.y): 1 stones, 2 tinted (the pack's tile has no id map), 0 one tap.
        if (roadShape2.y > 1.5) cobble = groundTintedGrad(gCobbleTex, vUV * gCobbleInfo.xy, dx * gCobbleInfo.xy, dy * gCobbleInfo.xy, gCobbleMean, gCobbleInfo.w);
        else if (roadShape2.y > 0.5) cobble = groundStonesGrad(gCobbleTex, gCobbleIds, vUV, dx, dy, gCobbleInfo);
        else cobble = groundTapGrad(gCobbleTex, vUV * gCobbleInfo.xy, dx * gCobbleInfo.xy, dy * gCobbleInfo.xy);
      }
      // Stones break through the dirt top-first.
      float w = groundBlend(dirt.a * 0.6 + 0.2, cobble.a, t, 0.07);
      sRoad = mix(dirt, cobble, w);
      bumpRoad = mix(gDirtInfo.z, gCobbleInfo.z, w);
      aoRoad = mix(1.0, groundCavity(sRoad.a, 0.08, 0.5), w);
    }
    vec4 s = mix(sRoad, sKerb, kerb);
    float bump = mix(bumpRoad, gKerbInfo.z, kerb);
    float ao = mix(aoRoad, groundCavity(sKerb.a, 0.08, 0.5), kerb);
    vec3 srgb = groundMacro(s.rgb, vary, labOpts.y);
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
    if (labOpts.w > 0.5) { gl_FragColor = vec4(srgb, 1.0); return; }
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, ao, 1.0);
  }
`;

function registerLabShaders(): void {
  registerGroundShader();
  Effect.ShadersStore['groundLabStripVertexShader'] = VERTEX;
  Effect.ShadersStore['groundLabStripFragmentShader'] = STRIP_FRAGMENT;
  Effect.ShadersStore['groundLabTerrainVertexShader'] = VERTEX;
  Effect.ShadersStore['groundLabTerrainFragmentShader'] = TERRAIN_FRAGMENT;
  Effect.ShadersStore['groundLabRoadVertexShader'] = VERTEX;
  Effect.ShadersStore['groundLabRoadFragmentShader'] = ROAD_FRAGMENT;
}

interface Lab {
  scene: Scene;
  look: LookRuntime;
  layers: Record<GroundMaterialId, GroundLayer>;
  notes: string[];
}

const MACRO = num('macro', 0.1);
const BUMP = num('bump', 1);
const ANTITILE = params.get('antitile') !== '0';
const UNLIT = params.get('unlit') === '1' ? 1 : 0;
const STREAK = num('streak', 0.6);

function labMaterial(lab: Lab, shader: 'groundLabStrip' | 'groundLabTerrain' | 'groundLabRoad', prefixes: string[], extra: string[]): ShaderMaterial {
  const mat = new ShaderMaterial(shader, lab.scene, shader, {
    attributes: ['position', 'normal', 'uv'],
    uniforms: ['world', 'viewProjection', 'labOpts', ...extra, ...LOOK_UNIFORMS, ...groundLayerUniforms(...prefixes)],
    samplers: [...LOOK_SAMPLERS, ...groundLayerSamplers(...prefixes)],
  });
  lab.look.register(mat, { contact: false });
  return mat;
}

let noIds: RawTexture | null = null;

function bind(mat: ShaderMaterial, prefix: string, layer: GroundLayer): void {
  bindGroundLayer(mat, prefix, layer, { bump: layer.bump * BUMP });
  // The lab's one strip shader declares an id sampler for every material;
  // a layer without ids gets a 1-texel "no stone" map so no unit is left
  // unbound. (A game shader only declares <prefix>Ids for stone layers.)
  if (!layer.idTexture) {
    noIds ??= RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, mat.getScene(), false, false, Texture.NEAREST_SAMPLINGMODE);
    mat.setTexture(`${prefix}Ids`, noIds);
  }
}

/** Cavity (joint AO) thresholds per material family: only the paved ones
 * have joints worth occluding. */
function cavityOf(layer: GroundLayer): Vector4 {
  return layer.sampling === 'blend' ? new Vector4(0.1, 0.5, 0.5, 0) : new Vector4(0.08, 0.5, 1, 0);
}

function stripMaterial(lab: Lab, layer: GroundLayer, opts: { meshUv?: boolean; streaked?: boolean; paint?: boolean } = {}): ShaderMaterial {
  const mat = labMaterial(lab, 'groundLabStrip', ['gA'], ['labCavity', 'labStreak']);
  bind(mat, 'gA', layer);
  const sampling = !ANTITILE || layer.sampling === 'single' ? 0 : opts.streaked ? 2 : layer.sampling === 'tinted' ? 3 : layer.sampling === 'stones' ? 4 : 1;
  mat.setFloat('labStreak', STREAK);
  mat.setVector4('labOpts', new Vector4(sampling, MACRO, opts.meshUv ? 1 : 0, UNLIT));
  const cav = cavityOf(layer);
  cav.w = opts.paint ? 1 : 0;
  mat.setVector4('labCavity', cav);
  return mat;
}

/** Flat quad in the XZ plane with uv in METERS (u across from x0, v = z). */
function quad(scene: Scene, name: string, x0: number, x1: number, z0: number, z1: number, y = 0): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  data.uvs = [0, z0, x1 - x0, z0, x1 - x0, z1, 0, z1];
  data.indices = [0, 1, 2, 0, 2, 3];
  data.applyToMesh(mesh);
  mesh.applyFog = false;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

type RGB = [number, number, number];

/** Fill the SolidMesh vertex format (toy material) on a MeshBuilder mesh. */
function toyPaint(mesh: Mesh, color: RGB, gloss: number): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  const uv = new Float32Array(count * 2);
  const uv2 = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    colors.set([color[0], color[1], color[2], 0], i * 4);
    uv[i * 2] = gloss;
    uv2[i * 2] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
  mesh.setVerticesData(VertexBuffer.UVKind, uv, false, 2);
  mesh.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2);
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false;
  return mesh;
}

function addCasters(lab: Lab, spots: { x: number; z: number; kind: 'box' | 'ball' | 'post'; size: number; color: RGB }[]): void {
  const toy = createToyMaterial(lab.scene);
  for (const [i, s] of spots.entries()) {
    let mesh: Mesh;
    if (s.kind === 'box') {
      mesh = MeshBuilder.CreateBox(`box${i}`, { size: s.size }, lab.scene);
      mesh.position.set(s.x, s.size / 2, s.z);
      mesh.rotation.y = 0.5 + i;
    } else if (s.kind === 'ball') {
      mesh = MeshBuilder.CreateSphere(`ball${i}`, { diameter: s.size, segments: 20 }, lab.scene);
      mesh.position.set(s.x, s.size / 2, s.z);
    } else {
      mesh = MeshBuilder.CreateCylinder(`post${i}`, { diameter: 0.5, height: s.size, tessellation: 16 }, lab.scene);
      mesh.position.set(s.x, s.size / 2, s.z);
    }
    toyPaint(mesh, s.color, 0.5);
    mesh.material = toy;
    lab.look.shadows.addCaster(mesh);
  }
}

const CREAM: RGB = [0.96, 0.89, 0.77];
const CORAL: RGB = [0.95, 0.42, 0.35];
const TURQ: RGB = [0.11, 0.69, 0.68];
const LIME: RGB = [0.61, 0.85, 0.09];
const COBALT: RGB = [0.19, 0.33, 0.73];

interface Shot {
  yaw: number;
  pitch: number;
  dist: number;
  target: [number, number, number];
  fov?: number;
}

function makeCamera(scene: Scene, canvas: HTMLCanvasElement, shot: Shot): ArcRotateCamera {
  const yaw = (num('yaw', shot.yaw) * Math.PI) / 180;
  const pitch = (num('pitch', shot.pitch) * Math.PI) / 180;
  // yaw 0 looks along +z; positive yaw orbits the camera to the right.
  const camera = new ArcRotateCamera(
    'labCam',
    -Math.PI / 2 - yaw,
    Math.PI / 2 - pitch,
    num('dist', shot.dist),
    new Vector3(num('tx', shot.target[0]), num('ty', shot.target[1]), num('tz', shot.target[2])),
    scene,
  );
  camera.fov = (num('fov', shot.fov ?? 46) * Math.PI) / 180;
  camera.minZ = 0.2;
  camera.maxZ = 3000;
  camera.wheelPrecision = 12;
  camera.lowerRadiusLimit = 1;
  camera.attachControl(canvas, true);
  return camera;
}

// --- mode=lit ---------------------------------------------------------------

const STRIP_ORDER: GroundMaterialId[] = [
  'meadow-grass',
  'rally-dirt',
  'village-cobblestone',
  'stone-pavers',
  'worn-asphalt',
  'lavender-gravel',
  'sunlit-sand',
];
const STRIP_WIDTH = 8;
const KERB_WIDTH = 0.4;
const STRIP_PITCH = STRIP_WIDTH + KERB_WIDTH;
const stripX = (i: number): number => (i - (STRIP_ORDER.length - 1) / 2) * STRIP_PITCH;

function buildLit(lab: Lab, canvas: HTMLCanvasElement): void {
  const z0 = -30;
  const z1 = 90;
  STRIP_ORDER.forEach((id, i) => {
    const cx = stripX(i);
    const mesh = quad(lab.scene, id, cx - STRIP_WIDTH / 2, cx + STRIP_WIDTH / 2, z0, z1);
    // The dirt strip is a road here: streaks along z, like a ribbon's v.
    mesh.material = stripMaterial(lab, lab.layers[id], { paint: id === 'worn-asphalt', streaked: id === 'rally-dirt' && params.get('streaks') !== '0', meshUv: id === 'rally-dirt' });
    if (i > 0) {
      const kerb = quad(lab.scene, `kerb${i}`, cx - STRIP_WIDTH / 2 - KERB_WIDTH, cx - STRIP_WIDTH / 2, z0, z1);
      kerb.material = stripMaterial(lab, lab.layers['kerb-stone'], { meshUv: true });
    }
  });
  // Grass all around, so the horizon is not a void.
  const around = quad(lab.scene, 'around', -300, 300, -300, 300, -0.02);
  around.material = stripMaterial(lab, lab.layers['meadow-grass']);

  const palette = [CREAM, CORAL, TURQ, LIME, COBALT];
  const spots: Parameters<typeof addCasters>[1] = [];
  STRIP_ORDER.forEach((_id, i) => {
    const cx = stripX(i);
    spots.push({ x: cx - 2.6, z: 3.5, kind: 'box', size: 1.6, color: palette[i % 5] });
    spots.push({ x: cx - 2.2, z: 12, kind: 'ball', size: 2.0, color: palette[(i + 2) % 5] });
    spots.push({ x: cx - 3.2, z: 24, kind: 'post', size: 5, color: palette[(i + 3) % 5] });
  });
  addCasters(lab, spots);

  const focus = isId(params.get('mat')) ? Math.max(0, STRIP_ORDER.indexOf(params.get('mat') as GroundMaterialId)) : 2;
  const fx = stripX(focus);
  const shots: Record<string, Shot> = {
    // Vision image 1: a low camera a few meters behind the car.
    chase: { yaw: 0, pitch: 14, dist: 7.5, target: [fx, 0.9, 0] },
    // Vision image 2: looking ~50 degrees down from ~20 m.
    elevated: { yaw: 0, pitch: 50, dist: 30, target: [fx, 0, 8] },
    all: { yaw: 0, pitch: 55, dist: 62, target: [0, 0, 14] },
    close: { yaw: 0, pitch: 35, dist: 3.2, target: [fx, 0, 0] },
    top: { yaw: 0, pitch: 89, dist: 14, target: [fx, 0, 0] },
  };
  makeCamera(lab.scene, canvas, shots[params.get('cam') ?? 'chase'] ?? shots.chase);
  lab.look.shadows.setFocus(new Vector3(fx, 0, 14));
}

// --- mode=far ---------------------------------------------------------------

function buildFar(lab: Lab, canvas: HTMLCanvasElement): void {
  const id = isId(params.get('mat')) ? (params.get('mat') as GroundMaterialId) : 'meadow-grass';
  const plane = quad(lab.scene, 'far', -100, 100, -100, 100);
  plane.material = stripMaterial(lab, lab.layers[id]);
  const how = { blend: 'groundSample (2 taps, shifting offsets)', stones: 'groundStones (1 tap + id fetch, per-stone tones)', tinted: 'groundTinted (2 taps, no id map)', single: 'ONE tap' };
  lab.notes.push(`200 m x 200 m of ${id}, ${ANTITILE ? how[lab.layers[id].sampling] : 'ONE tap (raw repeat)'}`);
  addCasters(lab, [
    { x: -3, z: -78, kind: 'box', size: 1.6, color: CORAL },
    { x: 4, z: -60, kind: 'ball', size: 2, color: TURQ },
    { x: -14, z: -20, kind: 'post', size: 6, color: CREAM },
    { x: 20, z: 20, kind: 'box', size: 4, color: CREAM },
  ]);
  const shots: Record<string, Shot> = {
    chase: { yaw: 0, pitch: 12, dist: 7.5, target: [0, 0.9, -84] },
    elevated: { yaw: 0, pitch: 50, dist: 34, target: [0, 0, -40] },
    // The game's ?view=xr framing: the whole table from (0, 85, -85).
    diorama: { yaw: 0, pitch: 45, dist: 120, target: [0, 0, 0] },
    top: { yaw: 0, pitch: 89, dist: 110, target: [0, 0, 0] },
  };
  const cam = params.get('cam') ?? 'chase';
  makeCamera(lab.scene, canvas, shots[cam] ?? shots.chase);
  lab.look.shadows.setFocus(cam === 'chase' ? new Vector3(0, 0, -64) : new Vector3(0, 0, -10));
}

// --- mode=road --------------------------------------------------------------

const ROAD_HALF = 3.5;

function roadCentre(v: number): [number, number] {
  // An S like the elevated vision image.
  return [11 * Math.sin(v / 19) + 3 * Math.sin(v / 7.5 + 1), v];
}

function buildRoad(lab: Lab, canvas: HTMLCanvasElement): void {
  const { scene } = lab;
  const terrain = quad(scene, 'terrain', -200, 200, -200, 200);
  const tmat = labMaterial(lab, 'groundLabTerrain', ['gGrass', 'gGravel', 'gDirt'], []);
  bind(tmat, 'gGrass', lab.layers['meadow-grass']);
  bind(tmat, 'gGravel', lab.layers['lavender-gravel']);
  bind(tmat, 'gDirt', lab.layers['rally-dirt']);
  tmat.setVector4('labOpts', new Vector4(1, MACRO, 0, UNLIT));
  terrain.material = tmat;

  // Ribbon: a row of 4 vertices... two is enough: uv.x carries the signed
  // distance from the centreline, so kerb and surface share one mesh.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const edge = ROAD_HALF + KERB_WIDTH;
  const v0 = -70;
  const v1 = 110;
  const step = 0.5;
  let along = v0;
  let prev = roadCentre(v0);
  for (let k = 0, v = v0; v <= v1; k++, v += step) {
    const c = roadCentre(v);
    const a = roadCentre(v - 0.05);
    const b = roadCentre(v + 0.05);
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const len = Math.hypot(tx, tz);
    // Left of the direction of travel is -x when heading +z.
    const nx = tz / len;
    const nz = -tx / len;
    along += Math.hypot(c[0] - prev[0], c[1] - prev[1]);
    prev = c;
    positions.push(c[0] - nx * edge, 0.02, c[1] - nz * edge, c[0] + nx * edge, 0.02, c[1] + nz * edge);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(-edge, along, edge, along);
    if (k > 0) {
      const i = k * 2;
      indices.push(i - 2, i, i - 1, i - 1, i, i + 1);
    }
  }
  const ribbon = new Mesh('road', scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  data.applyToMesh(ribbon);
  ribbon.applyFog = false;
  ribbon.alwaysSelectAsActiveMesh = true;
  const rmat = labMaterial(lab, 'groundLabRoad', ['gDirt', 'gCobble', 'gKerb'], ['roadShape', 'roadShape2']);
  bind(rmat, 'gDirt', lab.layers['rally-dirt']);
  bind(rmat, 'gCobble', lab.layers['village-cobblestone']);
  bind(rmat, 'gKerb', lab.layers['kerb-stone']);
  rmat.setVector4('labOpts', new Vector4(1, MACRO, 1, UNLIT));
  rmat.setVector4('roadShape', new Vector4(ROAD_HALF, KERB_WIDTH, num('village', 12), 9));
  const cobbleMode = !ANTITILE ? 0 : lab.layers['village-cobblestone'].sampling === 'stones' ? 1 : 2;
  rmat.setVector4('roadShape2', new Vector4(STREAK, cobbleMode, 0, 0));
  rmat.backFaceCulling = false;
  ribbon.material = rmat;

  // Garage apron with parking boxes, and a paved forecourt.
  const apron = quad(scene, 'apron', 15, 35, 22, 43, 0.012);
  apron.material = stripMaterial(lab, lab.layers['worn-asphalt'], { paint: true });
  const court = quad(scene, 'court', -22, -12, 26, 36, 0.012);
  court.material = stripMaterial(lab, lab.layers['stone-pavers']);

  addCasters(lab, [
    { x: -9, z: 2, kind: 'ball', size: 3.2, color: LIME },
    { x: -9, z: 2, kind: 'post', size: 2.4, color: [0.72, 0.38, 0.2] },
    { x: 9.5, z: 20, kind: 'box', size: 5, color: CREAM },
    { x: -17, z: 40, kind: 'box', size: 6, color: TURQ },
    { x: 1.2, z: -3.2, kind: 'box', size: 1.5, color: CORAL },
    { x: 5, z: 33, kind: 'box', size: 1.5, color: COBALT },
    { x: 12, z: 48, kind: 'ball', size: 4, color: LIME },
    { x: 24, z: 46, kind: 'box', size: 7, color: COBALT },
  ]);

  const shots: Record<string, Shot> = {
    chase: { yaw: -4, pitch: 13, dist: 8, target: [1, 0.9, -3] },
    elevated: { yaw: 12, pitch: 50, dist: 40, target: [3, 0, 22] },
    diorama: { yaw: 0, pitch: 45, dist: 120, target: [0, 0, 20] },
    entry: { yaw: 0, pitch: 40, dist: 12, target: [2, 0, 10] },
    top: { yaw: 0, pitch: 89, dist: 60, target: [3, 0, 22] },
  };
  const cam = params.get('cam') ?? 'chase';
  makeCamera(scene, canvas, shots[cam] ?? shots.chase);
  lab.look.shadows.setFocus(new Vector3(3, 0, cam === 'chase' ? 12 : 22));
}

async function run3d(mode: string): Promise<void> {
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  // Compile shaders synchronously: headless screenshots run on a virtual
  // clock that expires long before an async (parallel) compile reports back.
  engine.getCaps().parallelShaderCompile = undefined;
  const scene = new Scene(engine);
  registerLabShaders();

  const shadowParam = params.get('shadows') ?? '2048';
  const shadowQuality: ShadowQuality = shadowParam === 'off' ? 'off' : shadowParam === '1024' ? 1024 : 2048;
  const wide = mode === 'far' || params.get('cam') === 'diorama' || params.get('cam') === 'all';
  const look = createLook(scene, {
    shadowQuality,
    shadowRegion: num('region', wide ? 210 : 90),
    sky: params.get('sky') !== '0',
    config: wide ? { fogDensity: 0.0013 } : {},
  });
  const cfg = look.config as unknown as Record<string, unknown>;
  for (const [key, raw] of params) {
    if (!(key in cfg)) continue;
    const values = raw.split(',').map(Number);
    if (values.some((v) => !Number.isFinite(v))) continue;
    const current = cfg[key];
    if (typeof current === 'number') cfg[key] = values[0];
    else if (Array.isArray(current)) cfg[key] = values;
  }
  look.debugView = num('view', 0);

  // Generated set (always: kerb and pavers have no pack counterpart).
  const ground = createGroundTextures(scene, {
    size: SIZE,
    seed: SEED,
    palette: PALETTE,
    sizes: { 'village-cobblestone': num('cobbleSize', SIZE) },
    tileMeters: params.has('cobbleMeters') ? { 'village-cobblestone': num('cobbleMeters', 6) } : undefined,
  });
  console.log(ground.summary);
  const layers = { ...ground.layers };
  const notes: string[] = [`generated ${SIZE} px (${PALETTE}): ${ground.generationMs.toFixed(0)} ms + upload ${ground.uploadMs.toFixed(0)} ms${CLOCK_NOTE}`];
  if (SOURCE === 'pack') {
    for (const id of PACK_MATERIAL_IDS) {
      const def = GROUND_MATERIALS[id];
      const tile = await loadPackTile(id, PACK_SIZE, true);
      if (!tile) {
        notes.push(`pack material ${id} is not on disk (design-documents/ground-material-pack is not in git): generated tile shown`);
        continue;
      }
      // Same sampling function and argument as the generated tile of the
      // same material: the texture content is the only difference.
      layers[id] = createGroundLayer(scene, tile, { name: `${def.name} (pack)`, bump: def.bump, arg: def.arg, sampling: def.sampling });
    }
    notes.push(`SOURCE = PACK ${PACK_SIZE} px basecolor + low-passed height for: ${PACK_MATERIAL_IDS.join(', ')} (kerb-stone and stone-pavers are generated: not in the pack)`);
    notes.push('caveat: the pack\'s normal / AO / ORM maps are not used here, so this judges its colour and pattern, not its best lighting');
  }

  const lab: Lab = { scene, look, layers, notes };
  if (mode === 'far') buildFar(lab, canvas);
  else if (mode === 'road') buildRoad(lab, canvas);
  else buildLit(lab, canvas);

  let frames = 0;
  engine.runRenderLoop(() => {
    scene.render();
    frames++;
    if (frames === 4) {
      // A ShaderMaterial that fails to compile just does not draw; say so.
      for (const mesh of scene.meshes) {
        const mat = mesh.material;
        if (!(mat instanceof ShaderMaterial) || mat.isReady(mesh)) continue;
        const effect = mesh.subMeshes?.[0]?.effect ?? mat.getEffect();
        report('material not ready', `${mesh.name} / ${mat.name}: ${effect?.getCompilationError() || 'no compile error reported'}`);
      }
    }
    if (frames === 2 || frames % 30 === 0) {
      const fps = HEADLESS ? '' : `  fps ${engine.getFps().toFixed(0)}`;
      info(`mode=${mode} source=${SOURCE} cam=${params.get('cam') ?? 'chase'}${fps}\n${notes.join('\n')}`);
    }
  });
  window.addEventListener('resize', () => engine.resize());
  (window as unknown as { __lab: unknown }).__lab = { engine, scene, look, ground, layers };
}

const mode = params.get('mode') ?? 'grid';
(mode === 'grid' ? runGrid() : run3d(mode)).catch((e) => report('main', String(e)));
