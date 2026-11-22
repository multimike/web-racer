import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { mulberry32 } from '../../terrain/noise';
import { adjustOklch } from './color';
import type { RGB } from './color';

/**
 * Seeded randomness for asset variants. Everything is deterministic for a
 * given seed (multiplayer and the asset lab rely on that): never call
 * Math.random() in an asset.
 *
 *   const r = rng(seed, 't01-rally-oak');          // one stream per asset + seed
 *   const lean = r.around(0, 6);                   // degrees, bell-shaped, within ±6
 *   const leaf = jitterColor(r, FOLIAGE.jade, { hue: 8, lightness: 0.04, chroma: 0.1 });
 *   const branch = r.fork('branches');             // independent sub-stream
 */

/** Mix any numbers / strings into one 32-bit seed (order-sensitive). */
export function hashSeed(...parts: (number | string)[]): number {
  let h = 0x9e3779b9;
  const mixIn = (k: number): void => {
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  };
  for (const part of parts) {
    if (typeof part === 'number') {
      mixIn(part | 0);
      mixIn(Math.floor((part - Math.floor(part)) * 4294967296) | 0);
    } else {
      for (let i = 0; i < part.length; i++) mixIn(part.charCodeAt(i));
    }
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Seeded random stream (mulberry32 underneath). */
export class Rng {
  private readonly gen: () => number;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.gen = mulberry32(this.seed);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.gen();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.gen();
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return Math.floor(min + (max - min + 1) * this.gen());
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.gen() < p;
  }

  /** +1 or −1. */
  sign(): 1 | -1 {
    return this.gen() < 0.5 ? -1 : 1;
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.gen() * items.length))];
  }

  /** One element with relative weights (same length as items). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let x = this.gen() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i];
      if (x < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.gen() * (i + 1));
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /** Normal distribution (Box–Muller) — unbounded; see `around` for a
   * bounded bell. */
  gauss(mean = 0, sd = 1): number {
    const u = Math.max(this.gen(), 1e-12);
    const v = this.gen();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Bell-shaped value centred on `center` that NEVER leaves
   * center ± spread (mean of three uniforms) — the safe "gaussian-ish" knob
   * for proportions: most variants near the design, none broken.
   */
  around(center: number, spread: number): number {
    return center + ((this.gen() + this.gen() + this.gen()) / 1.5 - 1) * spread;
  }

  /** Uniform unit vector. */
  onSphere(): Vector3 {
    const y = this.gen() * 2 - 1;
    const a = this.gen() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  }

  /** Uniform point inside the unit sphere. */
  inSphere(): Vector3 {
    return this.onSphere().scaleInPlace(Math.cbrt(this.gen()));
  }

  /**
   * Independent child stream named by `label`. Adding or removing draws in
   * one part of an asset then cannot shift the randomness of another part —
   * fork one stream per feature (trunk, canopy, colours…).
   */
  fork(label: number | string): Rng {
    return new Rng(hashSeed(this.seed, label));
  }
}

/** Create a stream from a seed plus any labels (asset id, part name):
 * `rng(seed, 'r02-split-boulder')`. Small consecutive seeds (0, 1, 2…) give
 * unrelated streams. */
export function rng(seed: number, ...labels: (number | string)[]): Rng {
  return new Rng(hashSeed(seed, ...labels));
}

export interface ColorJitter {
  /** Max hue shift, ± DEGREES (5–12 keeps a colour inside its family). */
  hue?: number;
  /** Max lightness shift, ± on a 0..1 perceptual scale (0.03–0.08 typical). */
  lightness?: number;
  /** Max colourfulness change, ± fraction (0.1 = ±10 %). */
  chroma?: number;
}

/**
 * Seeded colour variation in OKLCH — perceptually even, so the same numbers
 * give the same visible amount of variation on any palette colour and the
 * result stays recognisably "that" colour. Draws are bell-shaped (`around`).
 *   const c = jitterColor(r, FOLIAGE.jade, { hue: 8, lightness: 0.05, chroma: 0.1 });
 */
export function jitterColor(r: Rng, color: RGB, j: ColorJitter): RGB {
  return adjustOklch(
    color,
    r.around(0, j.lightness ?? 0),
    1 + r.around(0, j.chroma ?? 0),
    r.around(0, j.hue ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Stateless spatial noise — for `displace` and `recolor`, where the value
// must depend on POSITION only so welded vertices agree.

/** Hash of an integer lattice point (+ seed) to 0..1. */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(seed | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth value noise, 0..1, feature size 1 unit: scale the inputs to choose
 * the lump size (`noise3(p.x * 2, p.y * 2, p.z * 2)` = 0.5 m lumps).
 */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz, seed), hash3(ix + 1, iy, iz, seed), ux), l(hash3(ix, iy + 1, iz, seed), hash3(ix + 1, iy + 1, iz, seed), ux), uy),
    l(
      l(hash3(ix, iy, iz + 1, seed), hash3(ix + 1, iy, iz + 1, seed), ux),
      l(hash3(ix, iy + 1, iz + 1, seed), hash3(ix + 1, iy + 1, iz + 1, seed), ux),
      uy,
    ),
    uz,
  );
}

/** Fractal sum of `noise3` octaves, 0..1 (each octave doubles the frequency
 * and halves the amplitude). */
export function fbm3(x: number, y: number, z: number, octaves = 3, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise3(x, y, z, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2;
    y *= 2;
    z *= 2;
  }
  return sum / norm;
}
