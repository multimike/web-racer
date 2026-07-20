/** Square heightfield: N×N samples over a size×size world area centered on the
 * origin. This is the single source of truth for terrain height — the render
 * mesh, the Havok heightfield shape, and (later) static-asset placement all
 * read from it. Internal layout: heights[z * n + x], sample (x, z) at world
 * (-half + x·step, -half + z·step). */
export class Heightfield {
  readonly n: number;
  readonly size: number;
  readonly step: number;
  readonly heights: Float32Array;

  constructor(n: number, size: number) {
    this.n = n;
    this.size = size;
    this.step = size / (n - 1);
    this.heights = new Float32Array(n * n);
  }

  at(x: number, z: number): number {
    return this.heights[z * this.n + x];
  }

  set(x: number, z: number, h: number): void {
    this.heights[z * this.n + x] = h;
  }

  /** World-space height, bilinearly interpolated. Clamps outside the field. */
  getHeight(wx: number, wz: number): number {
    const half = this.size / 2;
    const fx = clamp((wx + half) / this.step, 0, this.n - 1.001);
    const fz = clamp((wz + half) / this.step, 0, this.n - 1.001);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = this.at(x0, z0);
    const h10 = this.at(x0 + 1, z0);
    const h01 = this.at(x0, z0 + 1);
    const h11 = this.at(x0 + 1, z0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** World-space surface normal from central differences (unit length). */
  getNormal(wx: number, wz: number): { x: number; y: number; z: number } {
    const e = this.step;
    const dhdx = (this.getHeight(wx + e, wz) - this.getHeight(wx - e, wz)) / (2 * e);
    const dhdz = (this.getHeight(wx, wz + e) - this.getHeight(wx, wz - e)) / (2 * e);
    const len = Math.hypot(dhdx, 1, dhdz);
    return { x: -dhdx / len, y: 1 / len, z: -dhdz / len };
  }

  /** Grid-space slope magnitude (rise over run) at sample (x, z). */
  slopeAt(x: number, z: number): number {
    const n = this.n;
    const x0 = Math.max(x - 1, 0);
    const x1 = Math.min(x + 1, n - 1);
    const z0 = Math.max(z - 1, 0);
    const z1 = Math.min(z + 1, n - 1);
    const dhdx = (this.at(x1, z) - this.at(x0, z)) / ((x1 - x0) * this.step);
    const dhdz = (this.at(x, z1) - this.at(x, z0)) / ((z1 - z0) * this.step);
    return Math.hypot(dhdx, dhdz);
  }

  /** Repack into the layout the Babylon Havok plugin expects for HEIGHTFIELD
   * shapes. The plugin docs say data[(nX - 1 - x) * nZ + z], but feeding that
   * produced a physics field that was the TRANSPOSE of the render mesh —
   * verified by raycast-probing all mirror/transpose hypotheses (mean error
   * 0.036 m for transpose vs ~1 m for the rest). Hence `at(z, x)` here. */
  toBabylonHeightFieldData(): Float32Array {
    const n = this.n;
    const out = new Float32Array(n * n);
    for (let x = 0; x < n; x++) {
      for (let z = 0; z < n; z++) {
        out[(n - 1 - x) * n + z] = this.at(z, x);
      }
    }
    return out;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
