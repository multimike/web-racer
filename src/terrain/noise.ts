/** Seeded 2D gradient noise + FBM. Deterministic so multiplayer clients can
 * generate identical terrain from a shared seed (no heightmap over the wire). */

/** Cheap seeded PRNG (mulberry32) — good enough for permutation shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD_X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD_Y = [1, 1, -1, -1, 0, 0, 1, -1];

export class Noise2D {
  private perm: Uint8Array;

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Perlin-style gradient noise, roughly in [-1, 1]. */
  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const p = this.perm;
    const aa = p[p[xi & 255] + (yi & 255)] & 7;
    const ba = p[p[(xi + 1) & 255] + (yi & 255)] & 7;
    const ab = p[p[xi & 255] + ((yi + 1) & 255)] & 7;
    const bb = p[p[(xi + 1) & 255] + ((yi + 1) & 255)] & 7;
    const dAA = GRAD_X[aa] * xf + GRAD_Y[aa] * yf;
    const dBA = GRAD_X[ba] * (xf - 1) + GRAD_Y[ba] * yf;
    const dAB = GRAD_X[ab] * xf + GRAD_Y[ab] * (yf - 1);
    const dBB = GRAD_X[bb] * (xf - 1) + GRAD_Y[bb] * (yf - 1);
    const top = dAA + u * (dBA - dAA);
    const bot = dAB + u * (dBB - dAB);
    // 2D gradient noise peaks around ±0.71 — rescale toward a true [-1, 1].
    return (top + v * (bot - top)) * 1.41;
  }

  /** Fractal Brownian motion: `octaves` layers, each `lacunarity`× the
   * frequency and `gain`× the amplitude of the last. Output roughly [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
