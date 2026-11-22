import { CircleHash, pointInPolygon, polygonEdgeDistance } from './geom';
import type { Lot, SurfacePad } from './types';

/** Bit tags of the circles in the shared hash. */
export const TAG = {
  dressing: 1,
  /** Fence segments, apart from the rest of the dressing so that a run can
   * test for obstacles without tripping over its own previous segment. */
  fence: 64,
  tree: 2,
  rock: 4,
  bush: 8,
  low: 16,
  /** Kept clear on purpose: gates, door paths. */
  reserved: 32,
  /** Chevron boards, on top of `dressing`: things that must stay VISIBLE,
   * so nothing tall may grow over or in front of them. */
  sign: 128,
} as const;

/** Everything man-made and solid. */
export const BUILT = TAG.dressing | TAG.fence | TAG.sign;

interface LotBox {
  x: number;
  z: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
}

interface PadBox {
  pad: SurfacePad;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * What already stands where: lot envelopes (exact rectangles), paved pads
 * (exact polygons) and every solid thing placed so far (circles). Dressing
 * and nature both place through it, so nothing lands inside a building, on a
 * path, or inside something else.
 */
export class Occupancy {
  readonly solids: CircleHash;
  private readonly lots: LotBox[];
  private readonly pads: PadBox[];
  // Coarse lot-distance field (cell centres): most of the world is far from
  // any lot, and there the exact answer is not needed.
  private static readonly COARSE = 2;
  private readonly coarseN: number;
  private readonly coarse: Float32Array;
  private readonly half: number;
  // How "built-up" a place is, 0..1 on a 4 m grid: 1 beside a building,
  // fading to 0 some 26 m from the nearest one.
  private static readonly ZONE = 4;
  private readonly zoneN: number;
  private readonly zone: Float32Array;

  constructor(lots: readonly Lot[], pads: readonly SurfacePad[], worldSize: number) {
    this.solids = new CircleHash(worldSize);
    this.lots = lots.map((l) => ({ x: l.x, z: l.z, c: Math.cos(l.yaw), s: Math.sin(l.yaw), hx: l.halfX, hz: l.halfZ }));
    this.half = worldSize / 2;
    const cn = Math.ceil(worldSize / Occupancy.COARSE);
    this.coarseN = cn;
    // Only the cells around each lot are measured; the rest of the world
    // simply reads "far".
    this.coarse = new Float32Array(cn * cn).fill(99);
    const C = Occupancy.COARSE;
    for (const l of this.lots) {
      const reach = Math.hypot(l.hx, l.hz) + 9;
      const x0 = Math.max(0, Math.floor((l.x - reach + this.half) / C));
      const x1 = Math.min(cn - 1, Math.floor((l.x + reach + this.half) / C));
      const z0 = Math.max(0, Math.floor((l.z - reach + this.half) / C));
      const z1 = Math.min(cn - 1, Math.floor((l.z + reach + this.half) / C));
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const dx = -this.half + (cx + 0.5) * C - l.x;
          const dz = -this.half + (cz + 0.5) * C - l.z;
          const lx = Math.abs(dx * l.c - dz * l.s) - l.hx;
          const lz = Math.abs(dx * l.s + dz * l.c) - l.hz;
          const d = Math.hypot(lx > 0 ? lx : 0, lz > 0 ? lz : 0);
          if (d < this.coarse[cz * cn + cx]) this.coarse[cz * cn + cx] = d;
        }
      }
    }
    const zn = Math.ceil(worldSize / Occupancy.ZONE) + 1;
    this.zoneN = zn;
    this.zone = new Float32Array(zn * zn);
    const Z = Occupancy.ZONE;
    for (const l of this.lots) {
      const x0 = Math.max(0, Math.floor((l.x - 27 + this.half) / Z));
      const x1 = Math.min(zn - 1, Math.ceil((l.x + 27 + this.half) / Z));
      const z0 = Math.max(0, Math.floor((l.z - 27 + this.half) / Z));
      const z1 = Math.min(zn - 1, Math.ceil((l.z + 27 + this.half) / Z));
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const d = Math.hypot(-this.half + cx * Z - l.x, -this.half + cz * Z - l.z);
          const t = Math.min(1, Math.max(0, (26 - d) / 18));
          const v = t * t * (3 - 2 * t);
          if (v > this.zone[cz * zn + cx]) this.zone[cz * zn + cx] = v;
        }
      }
    }
    this.pads = pads.map((pad) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, z] of pad.polygon) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      return { pad, minX, maxX, minZ, maxZ };
    });
  }

  /**
   * Distance to the nearest lot envelope (0 inside one). Exact within 5 m
   * of a lot; farther out it is the value at the centre of the 2 m cell
   * (off by up to 1.4 m, which only shifts soft density falloffs), and
   * beyond ~9 m simply 99.
   */
  lotDistance(x: number, z: number): number {
    const cn = this.coarseN;
    const cx = Math.min(cn - 1, Math.max(0, Math.floor((x + this.half) / Occupancy.COARSE)));
    const cz = Math.min(cn - 1, Math.max(0, Math.floor((z + this.half) / Occupancy.COARSE)));
    const far = this.coarse[cz * cn + cx];
    return far > 6.5 ? far : this.exactLotDistance(x, z);
  }

  /** 0..1: how much this place belongs to a settlement (bilinear). */
  builtUp(x: number, z: number): number {
    const zn = this.zoneN;
    const fx = Math.min(zn - 1.001, Math.max(0, (x + this.half) / Occupancy.ZONE));
    const fz = Math.min(zn - 1.001, Math.max(0, (z + this.half) / Occupancy.ZONE));
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const i = z0 * zn + x0;
    const g = this.zone;
    return (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - tz) + (g[i + zn] * (1 - tx) + g[i + zn + 1] * tx) * tz;
  }

  private exactLotDistance(x: number, z: number): number {
    let best = Infinity;
    for (const l of this.lots) {
      const dx = x - l.x;
      const dz = z - l.z;
      const lx = Math.abs(dx * l.c - dz * l.s) - l.hx;
      const lz = Math.abs(dx * l.s + dz * l.c) - l.hz;
      const d = Math.hypot(lx > 0 ? lx : 0, lz > 0 ? lz : 0);
      if (d < best) best = d;
    }
    return best;
  }

  /** True if the point is on a paved pad or within `margin` of its edge. */
  onPad(x: number, z: number, margin = 0): boolean {
    for (const p of this.pads) {
      if (x < p.minX - margin || x > p.maxX + margin || z < p.minZ - margin || z > p.maxZ + margin) continue;
      if (pointInPolygon(p.pad.polygon, x, z)) return true;
      if (margin > 0 && polygonEdgeDistance(p.pad.polygon, x, z) < margin) return true;
    }
    return false;
  }
}
