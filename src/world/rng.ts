import { mulberry32 } from '../terrain/noise';

/**
 * Seeded randomness for the world planner. The asset kit has the same idea
 * in `src/gfx/solid/random.ts`, but that module imports Babylon's Vector3 and
 * the planner must stay Babylon-free (worker / headless / server use), so the
 * few helpers needed here are local.
 */

/** Mix numbers / strings into one 32-bit seed (order-sensitive, murmur-style). */
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

  range(min: number, max: number): number {
    return min + (max - min) * this.gen();
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return Math.floor(min + (max - min + 1) * this.gen());
  }

  chance(p: number): boolean {
    return this.gen() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.gen() * items.length))];
  }

  /** Bell-shaped value that never leaves center ± spread. */
  around(center: number, spread: number): number {
    return center + ((this.gen() + this.gen() + this.gen()) / 1.5 - 1) * spread;
  }

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

  /** Independent child stream: draws added in one feature cannot shift
   * another feature's randomness. */
  fork(label: number | string): Rng {
    return new Rng(hashSeed(this.seed, label));
  }
}

export function rng(seed: number, ...labels: (number | string)[]): Rng {
  return new Rng(hashSeed(seed, ...labels));
}

/**
 * Stateless hash of a lattice cell to [0, 1). Jittered-grid scatter uses this
 * instead of a sequential stream so a cell's jitter / acceptance roll depends
 * only on (cell, channel, seed): rejecting or adding candidates elsewhere can
 * never reshuffle the rest of the map.
 */
export function hash2(ix: number, iz: number, channel: number, seed: number): number {
  let h =
    Math.imul(ix | 0, 0x8da6b343) ^
    Math.imul(iz | 0, 0xd8163841) ^
    Math.imul(channel | 0, 0xcb1ab31f) ^
    Math.imul(seed | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
