import { mulberry32 } from '../../terrain/noise';

/**
 * Shared machinery of the ground-material generators. Babylon-free and
 * DOM-free on purpose: everything here is plain typed-array work, so the
 * generators can run on the main thread at load or move to a worker.
 *
 * Every field is TOROIDAL — noise lattices, stamp positions and Voronoi
 * neighbourhoods all wrap — so a tile repeats with no seam and no edge
 * blending. Every random draw comes from a seeded stream (`stream`), never
 * Math.random, so two clients build identical pixels from the same seed.
 */

export type RGB = readonly [number, number, number];

/** 'vision' = colours tuned so the lit result matches the gameplay-vision
 * images under the look lighting (the shipping default); 'pack' = the hex
 * values of the downloaded ground-material-pack, for the honest side-by-side
 * in the ground lab. */
export type GroundPalette = 'vision' | 'pack';

export interface GroundGenOptions {
  /** Pixels along the tile's long side (power of two). Default 512. */
  size?: number;
  seed?: number;
  palette?: GroundPalette;
  /** STONE LAYOUTS ONLY (village-cobblestone default 6, stone-pavers default
   * 4.5; ignored by the others, whose feature sizes are tied to their
   * tile): world size of the tile, meters. The stones keep their size, so a
   * larger tile holds more of them — a plaza seen from above can ask for
   * 12 m at 1024 px: the same texel density and four times as many distinct
   * stones before the OUTLINES repeat (the colours never do). */
  tileMeters?: number;
  /** STONE LAYOUTS ONLY. 'painted' (default): every stone carries its own
   * tone in the albedo — a self-contained picture, for previews and one-tap
   * use, whose colour mosaic repeats with the tile. 'plain': all stones in
   * the family's middle tone, and `groundStones` paints the mosaic, new for
   * every repeat. `createGroundTextures` builds 'plain': a painted mosaic
   * would show through as a grid of blotches in the distance, where the
   * shader can no longer tell the stones apart. */
  stoneTones?: 'painted' | 'plain';
}

/** One generated tile. Albedo and height share a texture so a shader needs a
 * single tap per sample. */
export interface GroundTile {
  id: string;
  /** Pixel size. Square for every material except the kerb strip. */
  width: number;
  height: number;
  /** RGBA8, row-major, row 0 = v 0. rgb = sRGB albedo with NO directional
   * light baked in; a = height (0 = lowest, 255 = highest, linear). */
  pixels: Uint8Array;
  /** Mean of the tile: sRGB albedo 0..1 and height 0..1. The shader's
   * contrast-preserving two-tap blend needs it. */
  mean: [number, number, number, number];
  /** World size one repeat covers, meters: [across u, along v]. */
  tileMeters: [number, number];
  /** World height of a = 255 above a = 0, meters (artistic microrelief). */
  reliefMeters: number;
  /** Stone layouts only (cobblestone, pavers): the stone id map, RGBA8, same
   * size as `pixels` — see `stoneIdMap` in cells.ts. With it the shader's
   * `groundStones` re-tones every stone of every repeat of the tile. */
  stoneIds?: Uint8Array;
  /** Stone layouts only: the tone spread of the material (`stoneToneT`),
   * which `groundStones` paints with. */
  stoneSpread?: number;
}

// ---------------------------------------------------------------------------
// Seeded streams

/** Independent deterministic stream per (seed, label): adding a draw to one
 * feature of a material never shifts the randomness of another. */
export function stream(seed: number, label: string): () => number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x85ebca6b);
    h = (h << 13) | (h >>> 19);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 13;
  return mulberry32(h >>> 0);
}

// ---------------------------------------------------------------------------
// Small math

export function hex(code: string): RGB {
  return [
    parseInt(code.slice(1, 3), 16) / 255,
    parseInt(code.slice(3, 5), 16) / 255,
    parseInt(code.slice(5, 7), 16) / 255,
  ];
}

export function rgb255(r: number, g: number, b: number): RGB {
  return [r / 255, g / 255, b / 255];
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Positive modulo for wrapping pixel indices. */
export function wrap(i: number, n: number): number {
  const m = i % n;
  return m < 0 ? m + n : m;
}

// ---------------------------------------------------------------------------
// Surface: the float working buffers of one tile

export class Surface {
  readonly w: number;
  readonly h: number;
  /** sRGB albedo 0..1 (mixing happens in sRGB, like the palette authoring). */
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  /** Height 0..1. */
  readonly z: Float32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.r = new Float32Array(w * h);
    this.g = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
    this.z = new Float32Array(w * h);
  }

  /** Blend a colour over pixel i with opacity k. */
  tint(i: number, c: RGB, k: number): void {
    this.r[i] += (c[0] - this.r[i]) * k;
    this.g[i] += (c[1] - this.g[i]) * k;
    this.b[i] += (c[2] - this.b[i]) * k;
  }

  /**
   * Low-pass the height (binomial 1-4-6-4-1, wrapped, each way).
   * The shader derives its lighting normal from screen-space derivatives of
   * the bilinearly magnified height; a height edge only a texel or two wide
   * then lights up as a staircase along every diagonal. The filter spreads
   * each edge over ~5 texels, which bilinear filtering can carry cleanly.
   * The albedo stays sharp.
   */
  smoothHeight(): void {
    const { w, h, z } = this;
    if (w < 4 || h < 4) return;
    const t = new Float32Array(w * h);
    // 1-4-6-4-1 (= two passes of 1-2-1) horizontally z -> t, then vertically
    // t -> z; both walk memory row by row.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < 2; x++) {
        // The two wrapped columns at each end.
        for (const c of [x, w - 1 - x]) {
          t[row + c] =
            0.0625 * (z[row + wrap(c - 2, w)] + z[row + wrap(c + 2, w)]) +
            0.25 * (z[row + wrap(c - 1, w)] + z[row + wrap(c + 1, w)]) +
            0.375 * z[row + c];
        }
      }
      for (let i = row + 2, end = row + w - 2; i < end; i++) {
        t[i] = 0.0625 * (z[i - 2] + z[i + 2]) + 0.25 * (z[i - 1] + z[i + 1]) + 0.375 * z[i];
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const u1 = wrap(y - 1, h) * w - row;
      const u2 = wrap(y - 2, h) * w - row;
      const d1 = wrap(y + 1, h) * w - row;
      const d2 = wrap(y + 2, h) * w - row;
      for (let i = row, end = row + w; i < end; i++) {
        z[i] = 0.0625 * (t[i + u2] + t[i + d2]) + 0.25 * (t[i + u1] + t[i + d1]) + 0.375 * t[i];
      }
    }
  }

  /** Pack into the RGBA8 tile (after `smoothHeight`). Heights are clamped,
   * NOT renormalized: each generator authors 0..1 against its own
   * `reliefMeters`, so the relief of a material does not change with the
   * seed. */
  toTile(id: string, tileMeters: [number, number], reliefMeters: number): GroundTile {
    this.smoothHeight();
    const n = this.w * this.h;
    // A clamped view does the 0..255 clamp and the rounding on store.
    const bytes = new Uint8ClampedArray(n * 4);
    const { r, g, b, z } = this;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sz = 0;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      bytes[o] = r[i] * 255;
      bytes[o + 1] = g[i] * 255;
      bytes[o + 2] = b[i] * 255;
      bytes[o + 3] = z[i] * 255;
      sr += r[i];
      sg += g[i];
      sb += b[i];
      sz += z[i];
    }
    const pixels = new Uint8Array(bytes.buffer);
    return {
      id,
      width: this.w,
      height: this.h,
      pixels,
      mean: [clamp01(sr / n), clamp01(sg / n), clamp01(sb / n), clamp01(sz / n)],
      tileMeters,
      reliefMeters,
    };
  }
}

// ---------------------------------------------------------------------------
// Periodic noise

/**
 * Smooth periodic noise: a `cx` x `cy` lattice of random values evaluated
 * with a separable cubic B-spline. Chosen over Perlin / bilinear value noise
 * because (a) the B-spline kernel is close to a Gaussian, so the field is
 * nearly isotropic — no square lattice cells showing through, which is what
 * the pack's v1.1 notes complain about — (b) it is C2, so heights made from
 * it give clean normals, and (c) the separable evaluation costs 8 multiply-
 * adds per pixel whatever the frequency (~1 ms at 512 px).
 *
 * Returns a STANDARDIZED field (mean 0, standard deviation 1) — or, with
 * `softSpread` > 0, the bounded 0..1 field `soften` would make of it.
 * Different `cx` / `cy` give stretched noise (tire streaks, kerb grain).
 */
export function noiseField(w: number, h: number, cx: number, cy: number, rand: () => number, softSpread = 0): Float32Array {
  // More lattice points than half the pixels would alias.
  cx = Math.max(1, Math.min(Math.round(cx), w >> 1));
  cy = Math.max(1, Math.min(Math.round(cy), h >> 1));
  const lattice = new Float32Array(cx * cy);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const [ix, wx] = splineTaps(w, cx);
  const [iy, wy] = splineTaps(h, cy);

  // Horizontal pass: every lattice row resampled to w pixels.
  const rows = new Float32Array(cy * w);
  for (let j = 0; j < cy; j++) {
    const src = j * cx;
    const dst = j * w;
    for (let x = 0, t = 0; x < w; x++, t += 4) {
      rows[dst + x] =
        lattice[src + ix[t]] * wx[t] +
        lattice[src + ix[t + 1]] * wx[t + 1] +
        lattice[src + ix[t + 2]] * wx[t + 2] +
        lattice[src + ix[t + 3]] * wx[t + 3];
    }
  }
  // Vertical pass.
  const out = new Float32Array(w * h);
  let sum = 0;
  let sumSq = 0;
  for (let y = 0, t = 0; y < h; y++, t += 4) {
    const r0 = iy[t] * w;
    const r1 = iy[t + 1] * w;
    const r2 = iy[t + 2] * w;
    const r3 = iy[t + 3] * w;
    const w0 = wy[t];
    const w1 = wy[t + 1];
    const w2 = wy[t + 2];
    const w3 = wy[t + 3];
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      const v = rows[r0 + x] * w0 + rows[r1 + x] * w1 + rows[r2 + x] * w2 + rows[r3 + x] * w3;
      out[dst + x] = v;
      sum += v;
      sumSq += v * v;
    }
  }
  const mean = sum / out.length;
  const sd = Math.sqrt(Math.max(sumSq / out.length - mean * mean, 1e-12));
  const inv = 1 / sd;
  if (softSpread > 0) {
    // Standardize and soften in one pass (see `soften`).
    const k = inv * 0.65;
    for (let i = 0; i < out.length; i++) {
      let x = (out[i] - mean) * k;
      x = x < -3 ? -3 : x > 3 ? 3 : x;
      const x2 = x * x;
      out[i] = 0.5 + (softSpread * x * (27 + x2)) / (27 + 9 * x2);
    }
  } else {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) * inv;
  }
  return out;
}

/** `soften(noiseField(...))` in one pass less: bounded 0..1 noise around 0.5
 * (~0.26..0.74 at the default spread). */
export function softNoise(w: number, h: number, cx: number, cy: number, rand: () => number, spread = 0.24): Float32Array {
  return noiseField(w, h, cx, cy, rand, spread);
}

/** Per output pixel: the 4 wrapped lattice indices and cubic B-spline
 * weights. Sample centres (x + 0.5), so the field is periodic over exactly
 * `n` pixels with no duplicated edge texel. */
function splineTaps(n: number, cells: number): [Int32Array, Float32Array] {
  const idx = new Int32Array(n * 4);
  const wgt = new Float32Array(n * 4);
  for (let x = 0; x < n; x++) {
    const p = ((x + 0.5) * cells) / n;
    const i = Math.floor(p);
    const t = p - i;
    const t2 = t * t;
    const t3 = t2 * t;
    const o = x * 4;
    idx[o] = wrap(i - 1, cells);
    idx[o + 1] = wrap(i, cells);
    idx[o + 2] = wrap(i + 1, cells);
    idx[o + 3] = wrap(i + 2, cells);
    wgt[o] = (1 - 3 * t + 3 * t2 - t3) / 6;
    wgt[o + 1] = (4 - 6 * t2 + 3 * t3) / 6;
    wgt[o + 2] = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
    wgt[o + 3] = t3 / 6;
  }
  return [idx, wgt];
}

/** Standardized noise -> bounded 0..1 around 0.5 (the pack's organic-noise
 * shaping: ~0.26..0.74 at the default spread, soft tails, never clipping).
 * Works IN PLACE and returns the same array. */
export function soften(field: Float32Array, spread = 0.24): Float32Array {
  for (let i = 0; i < field.length; i++) {
    // Pade approximant of tanh, exact to 1 % on the clamped range; a real
    // Math.tanh per pixel was the single largest cost of every material.
    let x = field[i] * 0.65;
    x = x < -3 ? -3 : x > 3 ? 3 : x;
    const x2 = x * x;
    field[i] = 0.5 + (spread * x * (27 + x2)) / (27 + 9 * x2);
  }
  return field;
}

// ---------------------------------------------------------------------------
// Stamps

export interface PebbleStyle {
  /** Opacity of the stone colour over what is below. */
  opacity: number;
  /** Height the flat part of the stone is raised to (0..1). */
  level: number;
  /** Extra dome height at the centre. */
  dome: number;
  /** Width in pixels and strength of the dark contact ring painted just
   * outside the stone (the baked, non-directional part of its shadow). */
  ringPx: number;
  ring: number;
}

/**
 * One small faceted stone: a convex polygon of 5-7 random half-planes
 * clipped by a circle (which rounds the corners), wrapped around the tile
 * edges. Polygonal on purpose — pebbles read as tiny low-poly rocks, the
 * same shape language as the 3D rock props — and it needs no atan2.
 */
export function stampPebble(
  s: Surface,
  cx: number,
  cy: number,
  radius: number,
  rand: () => number,
  color: RGB,
  style: PebbleStyle,
): void {
  const sides = 5 + ((rand() * 3) | 0);
  const nx = new Float32Array(sides);
  const ny = new Float32Array(sides);
  const nd = new Float32Array(sides);
  const phase = rand() * Math.PI * 2;
  for (let k = 0; k < sides; k++) {
    const a = phase + ((k + (rand() - 0.5) * 0.7) / sides) * Math.PI * 2;
    nx[k] = Math.cos(a);
    ny[k] = Math.sin(a);
    nd[k] = radius * (0.72 + rand() * 0.3);
  }
  const reach = radius + style.ringPx + 1;
  const reach2 = (radius + style.ringPx) * (radius + style.ringPx);
  const x0 = Math.floor(cx - reach);
  const x1 = Math.ceil(cx + reach);
  const y0 = Math.floor(cy - reach);
  const y1 = Math.ceil(cy + reach);
  const { w, h, r, g, b, z } = s;
  // Sub-pixel stones still need a visible core: at least ~0.8 px of edge.
  const aa = Math.min(1.2, radius * 0.6);
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - cy;
    const row = wrap(y, h) * w;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - cx;
      const r2 = px * px + py * py;
      if (r2 >= reach2) continue;
      let d = Math.sqrt(r2) - radius;
      for (let k = 0; k < sides; k++) {
        const e = px * nx[k] + py * ny[k] - nd[k];
        if (e > d) d = e;
      }
      if (d >= style.ringPx) continue;
      const i = row + wrap(x, w);
      if (d > 0) {
        // Contact ring: darkens the ground the stone sits on.
        const k = 1 - style.ring * (1 - d / style.ringPx);
        r[i] *= k;
        g[i] *= k;
        b[i] *= k;
        if (d >= aa * 0.5) continue;
      }
      const m = clamp01(0.5 - d / aa);
      const k = m * style.opacity;
      r[i] += (color[0] - r[i]) * k;
      g[i] += (color[1] - g[i]) * k;
      b[i] += (color[2] - b[i]) * k;
      const top = style.level + style.dome * clamp01(-d / radius);
      if (top > z[i]) z[i] += (top - z[i]) * m;
    }
  }
}

// ---------------------------------------------------------------------------
// Stone tones
//
// A paved material paints every stone in ONE colour taken from a one-
// parameter family: tone(t) = cool * (1 + (STONE_WARM - 1) * t), t = 0 the
// coolest (lavender) and t = 1 the warmest (cream-pink) stone. The shader
// knows the same family (GROUND_STONE_WARM in groundShader.ts — keep the two
// in step), reads the t a stone was painted with from the id map and
// multiplies by tone(t') / tone(t) for a t' of its own choosing. That is
// what lets one 6 m tile pave a whole square without its colour mosaic
// repeating, and it needs no palette uniforms.

/** warm / cool, per channel (sRGB albedo). The vision's stones lie on one
 * line, LIT: lavender (195,151,164) - dusty pink (220,170,168) - cream
 * (241,192,175) — mostly a step in brightness, hardly one in hue. Under the
 * look lighting (which compresses the bright end) this albedo ratio lands
 * on it. */
export const STONE_WARM: RGB = [1.47, 1.37, 1.045];

/**
 * Tone parameter from two uniform randoms: `family` picks the cool or the
 * warm half (so a caller can make the halves gather in drifts), `within`
 * the tone inside it — nearly a continuum, with a small gap at the middle
 * so neighbours of different families still read as two colours. `spread`
 * 0..1 scales the whole range around t = 0.5. GLSL twin: groundStoneT.
 */
export function stoneToneT(family: number, within: number, spread: number): number {
  return 0.5 + 0.5 * spread * (family < 0.5 ? -1 : 1) * (0.15 + 0.85 * within);
}

/** Colour of tone t, given the colour `mid` of t = 0.5. */
export function stoneTone(mid: RGB, t: number): [number, number, number] {
  return [
    (mid[0] * (1 + (STONE_WARM[0] - 1) * t)) / (1 + (STONE_WARM[0] - 1) * 0.5),
    (mid[1] * (1 + (STONE_WARM[1] - 1) * t)) / (1 + (STONE_WARM[1] - 1) * 0.5),
    (mid[2] * (1 + (STONE_WARM[2] - 1) * t)) / (1 + (STONE_WARM[2] - 1) * 0.5),
  ];
}

/** Resolve the optional generator arguments. */
export function resolveOptions(options: GroundGenOptions | undefined, defaultSeed: number): Required<Pick<GroundGenOptions, 'size' | 'seed' | 'palette'>> {
  const size = options?.size ?? 512;
  if (size < 32 || (size & (size - 1)) !== 0) throw new Error(`ground tile size must be a power of two >= 32, got ${size}`);
  return { size, seed: options?.seed ?? defaultSeed, palette: options?.palette ?? 'vision' };
}
