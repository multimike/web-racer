import type { Vec2 } from './types';

/**
 * 2D helpers for the planner, all in the world XZ plane.
 *
 * YAW CONVENTION (the one Babylon's `rotation.y` uses): positive yaw turns
 * local +z toward world +x. So for a yaw ψ
 *   local +z → world ( sin ψ, cos ψ)
 *   local +x → world ( cos ψ, −sin ψ)
 * and an asset's FRONT (local −z, see src/assets/types.ts) points along
 * world (−sin ψ, −cos ψ).
 */

/** Yaw that makes an asset's front (local −z) look along the direction (fx, fz). */
export function yawFacing(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/** Yaw that lays local +z along the direction (dx, dz) (travel direction). */
export function yawAlong(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** World direction of an asset's front (local −z) for a yaw. */
export function frontOf(yaw: number): Vec2 {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** Local (x, z) → world, for a frame at (ox, oz) with the given yaw. */
export function toWorld(ox: number, oz: number, yaw: number, lx: number, lz: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [ox + lx * c + lz * s, oz - lx * s + lz * c];
}

/** World → local (x, z) of a frame at (ox, oz) with the given yaw. */
export function toLocal(ox: number, oz: number, yaw: number, wx: number, wz: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = wx - ox;
  const dz = wz - oz;
  return [dx * c - dz * s, dx * s + dz * c];
}

/**
 * Two thin panels (centre, yaw, half length along local x), seen from the
 * first: how far they overlap along its length (> 0 = overlap, the second
 * projected onto the first's axis) and how far apart they stand across it
 * (the second's centre). Fence panels laid on each other half a pitch
 * apart pass a centre-distance test; this catches them.
 */
export function panelOverlap(
  ax: number, az: number, ayaw: number, ahalf: number,
  bx: number, bz: number, byaw: number, bhalf: number,
): { along: number; across: number } {
  const [lx, lz] = toLocal(ax, az, ayaw, bx, bz);
  return { along: ahalf + bhalf * Math.abs(Math.cos(byaw - ayaw)) - Math.abs(lx), across: Math.abs(lz) };
}

/** Oriented rectangle: centre, yaw, half extents along local x and z. */
export interface Obb {
  x: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
}

export function obbCorners(o: Obb, grow = 0): Vec2[] {
  const hx = o.hx + grow;
  const hz = o.hz + grow;
  return [
    toWorld(o.x, o.z, o.yaw, -hx, -hz),
    toWorld(o.x, o.z, o.yaw, hx, -hz),
    toWorld(o.x, o.z, o.yaw, hx, hz),
    toWorld(o.x, o.z, o.yaw, -hx, hz),
  ];
}

/** Distance from a point to the rectangle (0 inside). */
export function obbDistance(o: Obb, wx: number, wz: number): number {
  const [lx, lz] = toLocal(o.x, o.z, o.yaw, wx, wz);
  const dx = Math.max(Math.abs(lx) - o.hx, 0);
  const dz = Math.max(Math.abs(lz) - o.hz, 0);
  return Math.hypot(dx, dz);
}

/** Separating-axis overlap test; `gap` demands that much air between them. */
export function obbOverlap(a: Obb, b: Obb, gap = 0): boolean {
  const ca = obbCorners(a, gap / 2);
  const cb = obbCorners(b, gap / 2);
  const axes: Vec2[] = [
    [Math.cos(a.yaw), -Math.sin(a.yaw)],
    [Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), -Math.sin(b.yaw)],
    [Math.sin(b.yaw), Math.cos(b.yaw)],
  ];
  for (const [ax, az] of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [x, z] of ca) {
      const p = x * ax + z * az;
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }
    for (const [x, z] of cb) {
      const p = x * ax + z * az;
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }
    if (maxA <= minB || maxB <= minA) return false;
  }
  return true;
}

/** Even-odd point-in-polygon. */
export function pointInPolygon(poly: readonly Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polygon's boundary. */
export function polygonEdgeDistance(poly: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = segmentDistance(poly[j][0], poly[j][1], poly[i][0], poly[i][1], x, z);
    if (d < best) best = d;
  }
  return best;
}

export function segmentDistance(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Round to millimetres: keeps the serialized plan compact and stable. */
export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Uniform grid of circles for "is there something here already" queries.
 * Rectangles are entered as a few circles by the callers that need them;
 * exact rectangle tests are done against the lot list directly.
 *
 * Dense 2 m grid with per-cell linked lists in flat arrays: the planner asks
 * this tens of thousands of times per plan, and a Map of arrays spent more
 * time in the allocator than in the geometry.
 */
export class CircleHash {
  private static readonly CELL = 2;
  private readonly n: number;
  private readonly half: number;
  private readonly head: Int32Array;
  private readonly next: number[] = [];
  private readonly item: number[] = [];
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly rs: number[] = [];
  private readonly tags: number[] = [];

  /** `worldSize`: edge of the square world centred on the origin; circles
   * outside it are clamped into the border cells. */
  constructor(worldSize: number) {
    this.half = worldSize / 2 + 8;
    this.n = Math.ceil((this.half * 2) / CircleHash.CELL);
    this.head = new Int32Array(this.n * this.n).fill(-1);
  }

  private cellOf(v: number): number {
    const c = Math.floor((v + this.half) / CircleHash.CELL);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }

  add(x: number, z: number, r: number, tag = 0): void {
    const id = this.xs.length;
    this.xs.push(x);
    this.zs.push(z);
    this.rs.push(r);
    this.tags.push(tag);
    const x0 = this.cellOf(x - r);
    const x1 = this.cellOf(x + r);
    const z0 = this.cellOf(z - r);
    const z1 = this.cellOf(z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * this.n + cx;
        this.item.push(id);
        this.next.push(this.head[c]);
        this.head[c] = this.item.length - 1;
      }
    }
  }

  /** True if a circle (x, z, r) comes within `gap` of a stored circle whose
   * tag has any bit of `mask`. */
  hits(x: number, z: number, r: number, gap = 0, mask = -1): boolean {
    const reach = r + gap;
    const x0 = this.cellOf(x - reach);
    const x1 = this.cellOf(x + reach);
    const z0 = this.cellOf(z - reach);
    const z1 = this.cellOf(z + reach);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let k = this.head[cz * this.n + cx]; k >= 0; k = this.next[k]) {
          const id = this.item[k];
          if ((this.tags[id] & mask) === 0) continue;
          const dx = this.xs[id] - x;
          const dz = this.zs[id] - z;
          const lim = this.rs[id] + reach;
          if (dx * dx + dz * dz < lim * lim) return true;
        }
      }
    }
    return false;
  }
}
