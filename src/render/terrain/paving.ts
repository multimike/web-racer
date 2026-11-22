import { Mesh, VertexBuffer, VertexData } from '@babylonjs/core';
import type { Scene, ShaderMaterial } from '@babylonjs/core';
import type { WorldData } from '../../game/contracts/world';
import type { GroundTextureSet } from '../../gfx/ground';
import { triangulate } from '../../gfx/solid/triangulate';
import type { Heightfield } from '../../terrain/Heightfield';
import { TrackFrame } from '../../world/trackFrame';
import type { KerbSection, KerbStyle, PadSurface, SurfacePad } from '../../world/types';
import { createPadMaterial, createRibbonMaterial } from './PavingMaterial';

/**
 * The paving laid over the terrain: road ribbon + kerbs + start line (one
 * mesh) and the pads with their markings (one mesh, absent when the plan has
 * no pads). Everything samples the FINAL heightfield (what the terrain mesh
 * shows), not `track.roadHeights`.
 */

/** Start-line checker square, m: 20 columns across the 10 m road (the
 * columns line up with the road edges at lateral 0) and four rows in the
 * plan's 2 m band. */
const START_LINE_SQUARE = 0.5;
/** Ribbon height over the heightfield, m. */
export const RIBBON_LIFT = 0.03;
/** Pad height over the heightfield, m, per role: a path laid over a
 * forecourt, or a forecourt reaching onto the square, must not z-fight with
 * it, so overlapping pads are stacked a few millimetres apart by role. */
export const PAD_LIFT: Record<SurfacePad['role'], number> = { apron: 0.035, square: 0.035, forecourt: 0.041, path: 0.047 };
/** Pad clearance over the ground guaranteed everywhere inside a piece, m. */
const PAD_COVER = 0.02;
/** Largest cell bound a pad is laid over before its cells are cut finer
 * (padDivision), m: keeps every pad vertex under 0.02 + 0.045 over the ground. */
const PAD_MAX_BOUND = 0.045;
/** Markings over their pad, m. */
export const MARKING_LIFT = 0.03;
/** Kerb lip over the road edge, m. */
export const KERB_LIP: Record<KerbStyle, number> = { rough: 0.05, dressed: 0.07, flush: 0 };
/** The kerb's outer skirt reaches this far below the ground, m (no gap on a slope). */
const SKIRT_DEPTH = 0.1;
const STYLE_CODE: Record<KerbStyle, number> = { rough: 0, dressed: 0.5, flush: 1 };
const SURFACE_CODE: Record<PadSurface, number> = { asphalt: 0, paver: 0.5, cobble: 1 };

/** The kerb section covering arc length `s` on `side` (+1 left, −1 right);
 * the plan guarantees exactly one. */
export function kerbAt(frame: TrackFrame, kerbs: readonly KerbSection[], s: number, side: 1 | -1): KerbSection | null {
  for (const k of kerbs) if (k.side === side && frame.inRange(s, k.s0, k.s1)) return k;
  return null;
}

/** Bilinear sample of WorldData.shade (AO, baked sun) at a world point. */
function sampleShade(data: WorldData, x: number, z: number, out: number[], o: number): void {
  const hf = data.heightfield;
  const n = hf.n;
  const half = hf.size / 2;
  const fx = Math.min(Math.max((x + half) / hf.step, 0), n - 1.001);
  const fz = Math.min(Math.max((z + half) / hf.step, 0), n - 1.001);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const sh = data.shade;
  for (let c = 0; c < 2; c++) {
    const a = sh[(z0 * n + x0) * 3 + c];
    const b = sh[(z0 * n + x0 + 1) * 3 + c];
    const d = sh[((z0 + 1) * n + x0) * 3 + c];
    const e = sh[((z0 + 1) * n + x0 + 1) * 3 + c];
    out[o + c] = (a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz;
  }
}

function pushNormal(hf: Heightfield, x: number, z: number, out: number[]): void {
  const e = hf.step;
  const dhdx = (hf.getHeight(x + e, z) - hf.getHeight(x - e, z)) / (2 * e);
  const dhdz = (hf.getHeight(x, z + e) - hf.getHeight(x, z - e)) / (2 * e);
  const inv = 1 / Math.hypot(dhdx, 1, dhdz);
  out.push(-dhdx * inv, inv, -dhdz * inv);
}

class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly shade: number[] = [];
  readonly indices: number[] = [];
  private readonly data: WorldData;

  constructor(data: WorldData) {
    this.data = data;
  }

  get count(): number {
    return this.positions.length / 3;
  }

  /** A vertex; normal = the heightfield's unless given. */
  vertex(x: number, y: number, z: number, color: [number, number, number, number], uv?: [number, number], normal?: [number, number, number]): number {
    this.positions.push(x, y, z);
    if (normal) this.normals.push(normal[0], normal[1], normal[2]);
    else pushNormal(this.data.heightfield, x, z, this.normals);
    if (uv) this.uvs.push(uv[0], uv[1]);
    this.colors.push(color[0], color[1], color[2], color[3]);
    const o = this.shade.length;
    this.shade.push(0, 0);
    sampleShade(this.data, x, z, this.shade, o);
    return this.count - 1;
  }

  build(name: string, scene: Scene, material: ShaderMaterial): Mesh {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    if (this.uvs.length) vd.uvs = this.uvs;
    vd.colors = this.colors;
    vd.indices = this.count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices);
    vd.applyToMesh(mesh, false);
    mesh.setVerticesBuffer(new VertexBuffer(scene.getEngine(), new Float32Array(this.shade), 'shade', false, false, 2));
    mesh.material = material;
    // The 4-float colour is data (kind / surface / paint), not opacity.
    mesh.hasVertexAlpha = false;
    mesh.applyFog = false;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}

/** Vertices per ribbon row: 7 road stations + 6 per kerb side (inner lip
 * bottom, inner lip top, top inner, top outer, skirt top, skirt bottom),
 * left side first. Exported for the lab's checks. */
export const ROAD_STATIONS = 7;
export const ROW = ROAD_STATIONS + 12;

/** Road surface clearance the fit guarantees at its probes, m. */
const COVER = 0.012;
/** Highest a road vertex may be lifted over the heightfield by the fit, m. */
const MAX_LIFT = 0.08;
/** Kerb top clearance over the ground the fit guarantees, m (rough /
 * dressed; their lip puts them far above this almost everywhere). */
const KERB_COVER = 0.015;
/** Pads are cut away under the road and the kerbs (padRoadHoles), so a pad
 * meets a kerb only along the kerb's outer edge; there every kerb top (any
 * style) stands at least this much over the pad, and the kerb's outer skirt
 * closes the step. A flush kerb is otherwise level with the road edge (lip
 * 0): it is never stacked over a pad, so no depth offset decides between
 * the two at any distance. */
const KERB_OVER_PAD = 0.008;
/** Kerb width is tapered over this many track points either side of a
 * rough ↔ dressed change (a 0.4 → 0.6 m jump inside one row reads as a jog). */
const KERB_TAPER = 3;
/** Barycentric probe points per triangle for the pad floor (the ground is
 * handled exactly, see groundShortfall): the order-8 lattice, 45 points.
 * The lab's checks sample a DIFFERENT lattice (order 7: only the corners
 * are shared). */
const PROBES: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) out.push([i / N, j / N, (N - i - j) / N]);
  return out;
})();

/** The worst point a fit found in one triangle: shortfall (m) and where. */
interface Shortfall {
  need: number;
  x: number;
  z: number;
}

/** Barycentric weights of (x, z) in triangle a b c (xz), into `out`;
 * false for a degenerate triangle. */
function bary(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, x: number, z: number, out: number[]): boolean {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return false;
  out[0] = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  out[1] = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  out[2] = 1 - out[0] - out[1];
  return true;
}

/**
 * The EXACT largest shortfall of a flat triangle under ground + c over its
 * whole area (not at probe points: a lattice misses creases, the lab once
 * read 8.9 mm where 3.7 mm was true). Inside one heightfield cell the ground
 * minus a plane is h(x, z) = bilinear, whose only second derivative is the
 * mixed one: a saddle, never an interior maximum. So the maximum over the
 * triangle cut to the cells lies on the pieces' edges, and along an edge it
 * is a quadratic in the edge parameter: its ends, or its vertex.
 */
function groundShortfall(hf: Heightfield, tx: readonly number[], tz: readonly number[], ty: readonly number[], c: number, worst: Shortfall): void {
  // The triangle's plane y = p0 + px·x + pz·z.
  const d = (tz[1] - tz[2]) * (tx[0] - tx[2]) + (tx[2] - tx[1]) * (tz[0] - tz[2]);
  if (Math.abs(d) < 1e-12) return;
  const px = (ty[0] * (tz[1] - tz[2]) + ty[1] * (tz[2] - tz[0]) + ty[2] * (tz[0] - tz[1])) / d;
  const pz = (ty[0] * (tx[2] - tx[1]) + ty[1] * (tx[0] - tx[2]) + ty[2] * (tx[1] - tx[0])) / d;
  const p0 = ty[0] - px * tx[0] - pz * tz[0];
  const f = (x: number, z: number): number => hf.getHeight(x, z) + c - (p0 + px * x + pz * z);
  const note = (v: number, x: number, z: number): void => {
    if (v > worst.need) {
      worst.need = v;
      worst.x = x;
      worst.z = z;
    }
  };
  clipToCells(hf, [[tx[0], tz[0]], [tx[1], tz[1]], [tx[2], tz[2]]], 1, (piece) => {
    for (let i = 0; i < piece.length; i++) {
      const p = piece[i];
      const q = piece[(i + 1) % piece.length];
      const f0 = f(p[0], p[1]);
      const f1 = f(q[0], q[1]);
      const fm = f((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      note(f0, p[0], p[1]);
      const A = 2 * f0 + 2 * f1 - 4 * fm;
      const B = f1 - f0 - A;
      if (A < -1e-12) {
        const t = -B / (2 * A);
        if (t > 0 && t < 1) note(A * t * t + B * t + f0, p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]));
      }
    }
  });
}

/** Height query over the pad mesh (surface and paint): a kerb's top must
 * stay over any pad it meets. 1 m buckets of triangles. */
class PadFloor {
  private readonly pos: readonly number[];
  private readonly idx: readonly number[];
  private readonly buckets = new Map<number, number[]>();

  constructor(pos: readonly number[], idx: readonly number[]) {
    this.pos = pos;
    this.idx = idx;
    for (let t = 0; t < idx.length; t += 3) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let e = 0; e < 3; e++) {
        const v = idx[t + e];
        x0 = Math.min(x0, pos[v * 3]);
        x1 = Math.max(x1, pos[v * 3]);
        z0 = Math.min(z0, pos[v * 3 + 2]);
        z1 = Math.max(z1, pos[v * 3 + 2]);
      }
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
        for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
          const k = PadFloor.key(x, z);
          const list = this.buckets.get(k);
          if (list) list.push(t);
          else this.buckets.set(k, [t]);
        }
      }
    }
  }

  private static key(x: number, z: number): number {
    return (x + 1000) * 4096 + z + 1000;
  }

  /** Shortfall of the flat triangle (tx, tz, ty) under the pad + margin: at
   * every pad vertex inside it (the pad is cut along the kerb's outer edge,
   * so they meet there, and the pad is linear between those vertices) and
   * at the probe lattice. */
  shortfall(tx: readonly number[], tz: readonly number[], ty: readonly number[], margin: number, worst: Shortfall): void {
    const w = [0, 0, 0];
    const p = this.pos;
    const x0 = Math.floor(Math.min(tx[0], tx[1], tx[2]));
    const x1 = Math.floor(Math.max(tx[0], tx[1], tx[2]));
    const z0 = Math.floor(Math.min(tz[0], tz[1], tz[2]));
    const z1 = Math.floor(Math.max(tz[0], tz[1], tz[2]));
    const check = (x: number, z: number, h: number): void => {
      if (!bary(tx[0], tz[0], tx[1], tz[1], tx[2], tz[2], x, z, w)) return;
      if (w[0] < -1e-6 || w[1] < -1e-6 || w[2] < -1e-6) return;
      const v = h + margin - (w[0] * ty[0] + w[1] * ty[1] + w[2] * ty[2]);
      if (v > worst.need) {
        worst.need = v;
        worst.x = x;
        worst.z = z;
      }
    };
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (const t of this.buckets.get(PadFloor.key(bx, bz)) ?? []) {
          for (let e = 0; e < 3; e++) {
            const v = this.idx[t + e];
            check(p[v * 3], p[v * 3 + 2], p[v * 3 + 1]);
          }
        }
      }
    }
    for (const q of PROBES) {
      const x = q[0] * tx[0] + q[1] * tx[1] + q[2] * tx[2];
      const z = q[0] * tz[0] + q[1] * tz[1] + q[2] * tz[2];
      const h = this.heightAt(x, z);
      if (h > -Infinity) check(x, z, h);
    }
  }

  /** Highest pad triangle containing (x, z), or −Infinity. */
  heightAt(x: number, z: number): number {
    const p = this.pos;
    const w = [0, 0, 0];
    let best = -Infinity;
    for (const t of this.buckets.get(PadFloor.key(Math.floor(x), Math.floor(z))) ?? []) {
      const a = this.idx[t];
      const b = this.idx[t + 1];
      const c = this.idx[t + 2];
      if (!bary(p[a * 3], p[a * 3 + 2], p[b * 3], p[b * 3 + 2], p[c * 3], p[c * 3 + 2], x, z, w)) continue;
      if (w[0] < -1e-9 || w[1] < -1e-9 || w[2] < -1e-9) continue;
      best = Math.max(best, w[0] * p[a * 3 + 1] + w[1] * p[b * 3 + 1] + w[2] * p[c * 3 + 1]);
    }
    return best;
  }
}

/**
 * Lift a strip grid of vertices — `n` rows (closed loop: row n−1 joins row
 * 0), `m` columns, [row * m + column] — until every point of every triangle
 * is at least `cover[k]` (max over the triangle's corners) above the
 * heightfield (exact, groundShortfall) and, with `floor`, at least
 * `floorMargin` above the pad mesh. The terrain is bilinear between samples
 * and the strip is linear between its vertices: on a crest, or where the
 * carve's flat floor meets the bank inside a span, the ground bulges above
 * the chord. The worst point of a short triangle is raised by exactly its
 * shortfall, lifting only the corners that carry it (barycentric weight ≥
 * 0.15; all three if one is capped at `cap[k]`), so a kerb that is short at
 * its outer edge is not raised at the road edge too. A few passes until
 * nothing moves. Triangles are split as the ribbon is:
 * (r, j) (r+1, j) (r, j+1) / (r, j+1) (r+1, j) (r+1, j+1).
 */
function fitStrip(hf: Heightfield, n: number, m: number, X: Float64Array, Z: Float64Array, Y: Float64Array, cover: Float64Array, cap: Float64Array, floor: PadFloor | null = null, floorMargin = 0): void {
  const tri = [0, 0, 0];
  const tx = [0, 0, 0];
  const tz = [0, 0, 0];
  const ty = [0, 0, 0];
  const w = [0, 0, 0];
  const worst: Shortfall = { need: 0, x: 0, z: 0 };
  // Pass in which each vertex last moved: after the first pass only the
  // triangles with a corner moved since the previous pass are looked at.
  const movedIn = new Int32Array(n * m).fill(-1);
  let pass = 0;
  const lift = (): boolean => {
    if (pass > 0 && movedIn[tri[0]] < pass - 1 && movedIn[tri[1]] < pass - 1 && movedIn[tri[2]] < pass - 1) return false;
    let moved = false;
    for (let iter = 0; iter < 6; iter++) {
      for (let e = 0; e < 3; e++) {
        tx[e] = X[tri[e]];
        tz[e] = Z[tri[e]];
        ty[e] = Y[tri[e]];
      }
      worst.need = 0;
      groundShortfall(hf, tx, tz, ty, Math.max(cover[tri[0]], cover[tri[1]], cover[tri[2]]), worst);
      if (floor) floor.shortfall(tx, tz, ty, floorMargin, worst);
      if (worst.need <= 1e-5) return moved;
      if (!bary(tx[0], tz[0], tx[1], tz[1], tx[2], tz[2], worst.x, worst.z, w)) return moved;
      let sum = 0;
      for (let e = 0; e < 3; e++) if (w[e] >= 0.15) sum += w[e];
      const amount = worst.need / sum + 1e-6;
      let capped = false;
      let any = false;
      for (let e = 0; e < 3; e++) {
        if (w[e] < 0.15) continue;
        const k = tri[e];
        const y = Math.min(Y[k] + amount, cap[k]);
        if (y < Y[k] + amount - 1e-9) capped = true;
        if (y > Y[k] + 1e-7) {
          Y[k] = y;
          movedIn[k] = pass;
          any = true;
        }
      }
      if (capped) {
        for (const k of tri) {
          const y = Math.min(Y[k] + worst.need, cap[k]);
          if (y > Y[k] + 1e-7) {
            Y[k] = y;
            movedIn[k] = pass;
            any = true;
          }
        }
      }
      if (!any) return moved;
      moved = true;
    }
    return moved;
  };
  for (pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let r = 0; r < n; r++) {
      const r1 = (r + 1) % n;
      for (let j = 0; j + 1 < m; j++) {
        tri[0] = r * m + j;
        tri[1] = r1 * m + j;
        tri[2] = r * m + j + 1;
        if (lift()) moved = true;
        tri[0] = r * m + j + 1;
        tri[1] = r1 * m + j;
        tri[2] = r1 * m + j + 1;
        if (lift()) moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Road vertex heights, [point * 7 + station]: the heightfield +
 * RIBBON_LIFT, then fitted (fitStrip) so no span dips toward the ground. */
function fitRoadHeights(hf: Heightfield, frame: TrackFrame, lat: readonly number[]): Float64Array {
  const n = frame.n;
  const m = lat.length;
  const X = new Float64Array(n * m);
  const Z = new Float64Array(n * m);
  const Y = new Float64Array(n * m);
  const cover = new Float64Array(n * m).fill(COVER);
  const cap = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    const lx = -frame.tz[i];
    const lz = frame.tx[i];
    for (let j = 0; j < m; j++) {
      const k = i * m + j;
      X[k] = frame.px[i] + lx * lat[j];
      Z[k] = frame.pz[i] + lz * lat[j];
      const g = hf.getHeight(X[k], Z[k]);
      Y[k] = g + RIBBON_LIFT;
      cap[k] = g + MAX_LIFT;
    }
  }
  fitStrip(hf, n, m, X, Z, Y, cover, cap);
  return Y;
}

// ---------------------------------------------------------------------------
// Pad heights. Pads are cut along the heightfield's cells, so every piece
// lies inside ONE bilinear cell. There the ground's only departure from a
// plane is its twist τ = h00 − h10 − h01 + h11, and a flat triangle through
// three points of the cell's bilinear surface stays within |τ| / 4 of it
// (linear-interpolation error of a quadratic with Hessian ±τ over a region
// whose enclosing circle has radius ≤ √2 / 2 cells). Let b(p) be the
// largest |τ| / 4 of the cells a vertex touches (a function of position
// alone, so pieces of two cells agree on a shared vertex). The role's lift
// already covers a sag of up to lift − PAD_COVER; only the rest is added:
// vertex y = ground + lift + max(0, b − (lift − PAD_COVER)). Every piece
// then clears the ground by at least PAD_COVER EVERYWHERE, not only at its
// vertices, and a vertex stands at most max(lift, PAD_COVER + b) over it.

/** |τ| / 4 of cell (cx, cz), clamped into the field. */
function cellBound(hf: Heightfield, cx: number, cz: number): number {
  const x = Math.min(Math.max(cx, 0), hf.n - 2);
  const z = Math.min(Math.max(cz, 0), hf.n - 2);
  return Math.abs(hf.at(x, z) - hf.at(x + 1, z) - hf.at(x, z + 1) + hf.at(x + 1, z + 1)) / 4;
}

/** The largest bound among the cells the point touches (1, 2 or 4). With
 * `div` > 1 the cells are the heightfield cells cut `div` × `div`: the
 * bilinear surface restricted to such a sub-cell has 1 / div² of the twist. */
export function padBound(hf: Heightfield, x: number, z: number, div = 1): number {
  const half = hf.size / 2;
  const fx = ((x + half) / hf.step) * div;
  const fz = ((z + half) / hf.step) * div;
  const e = 1e-6;
  let b = 0;
  for (let sx = Math.floor(fx - e); sx <= Math.floor(fx + e); sx++) {
    for (let sz = Math.floor(fz - e); sz <= Math.floor(fz + e); sz++) b = Math.max(b, cellBound(hf, Math.floor(sx / div), Math.floor(sz / div)));
  }
  return b / (div * div);
}

/** Sub-division of the cell grid a pad is cut along: the smallest of 1 … 4
 * that keeps every bound under the pad's box at most PAD_MAX_BOUND, so a
 * pad over a sharp crease (a cell twisting 0.3 m, seed 16) gets smaller
 * pieces instead of a tall lift. One `div` per pad: no T-junctions. */
function padDivision(hf: Heightfield, poly: readonly (readonly number[])[]): number {
  const half = hf.size / 2;
  let worst = 0;
  const xs = poly.map((q) => q[0]);
  const zs = poly.map((q) => q[1]);
  const cx0 = Math.floor((Math.min(...xs) + half) / hf.step);
  const cx1 = Math.floor((Math.max(...xs) + half) / hf.step);
  const cz0 = Math.floor((Math.min(...zs) + half) / hf.step);
  const cz1 = Math.floor((Math.max(...zs) + half) / hf.step);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) worst = Math.max(worst, cellBound(hf, cx, cz));
  for (let div = 1; div < 4; div++) if (worst / (div * div) <= PAD_MAX_BOUND) return div;
  return 4;
}

type P2 = readonly [number, number];

/** Clip a convex polygon to one side of an axis line (axis 0 = x, 1 = z):
 * keep where sign·(p[axis] − at) ≥ 0. The crossing is computed from the
 * edge's endpoints in a canonical order, so the two triangles sharing an
 * edge produce bit-identical points on it. */
function clipAxis(poly: P2[], axis: 0 | 1, at: number, sign: 1 | -1): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = sign * (p[axis] - at);
    const dq = sign * (q[axis] - at);
    if (dp >= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const swap = p[0] > q[0] || (p[0] === q[0] && p[1] > q[1]);
      const a = swap ? q : p;
      const c = swap ? p : q;
      const t = (at - a[axis]) / (c[axis] - a[axis]);
      const other = a[1 - axis] + t * (c[1 - axis] - a[1 - axis]);
      out.push(axis === 0 ? [at, other] : [other, at]);
    }
  }
  return out;
}

/** Cut a triangle along the heightfield's cell lines (each cell cut
 * `div` × `div`); `emit` gets each
 * convex piece (in the triangle's winding) with 3+ corners. */
function clipToCells(hf: Heightfield, tri: readonly P2[], div: number, emit: (piece: P2[]) => void): void {
  const half = hf.size / 2;
  const step = hf.step / div;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of tri) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]);
    z1 = Math.max(z1, p[1]);
  }
  const cx0 = Math.floor((x0 + half) / step);
  const cx1 = Math.floor((x1 + half) / step);
  const cz0 = Math.floor((z0 + half) / step);
  const cz1 = Math.floor((z1 + half) / step);
  for (let cx = cx0; cx <= cx1; cx++) {
    const gx0 = -half + cx * step;
    const gx1 = -half + (cx + 1) * step;
    const col: P2[] = clipAxis(clipAxis([...tri], 0, gx0, 1), 0, gx1, -1);
    if (col.length < 3) continue;
    for (let cz = cz0; cz <= cz1; cz++) {
      const gz0 = -half + cz * step;
      const gz1 = -half + (cz + 1) * step;
      const piece = clipAxis(clipAxis(col, 1, gz0, 1), 1, gz1, -1);
      if (piece.length < 3) continue;
      let area = 0;
      for (let i = 0; i < piece.length; i++) {
        const p = piece[i];
        const q = piece[(i + 1) % piece.length];
        area += p[0] * q[1] - q[0] * p[1];
      }
      if (Math.abs(area) < 1e-8) continue;
      emit(piece);
    }
  }
}

interface KerbSide {
  /** [point * 2 + (0 inner, 1 outer)] top-edge vertices. */
  X: Float64Array;
  Z: Float64Array;
  Y: Float64Array;
  /** Per point: (tapered) width and style. */
  width: Float64Array;
  style: KerbStyle[];
}

/**
 * Kerb plan-view layout for both sides ([0] left, [1] right): top-edge x / z
 * and style; Y is filled by fitKerbs. Width comes from the plan's section,
 * tapered over ±KERB_TAPER points where it changes.
 */
function layoutKerbs(frame: TrackFrame, sections: readonly KerbSection[], hw: number): [KerbSide, KerbSide] {
  const n = frame.n;
  const out: KerbSide[] = [];
  for (const side of [1, -1] as const) {
    const raw = new Float64Array(n);
    const style: KerbStyle[] = [];
    for (let i = 0; i < n; i++) {
      const k = kerbAt(frame, sections, frame.s[i], side);
      raw[i] = k?.width ?? 0.4;
      style.push(k?.style ?? 'rough');
    }
    const width = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -KERB_TAPER; d <= KERB_TAPER; d++) sum += raw[(i + d + n) % n];
      width[i] = sum / (2 * KERB_TAPER + 1);
    }
    const X = new Float64Array(n * 2);
    const Z = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const lx = -frame.tz[i];
      const lz = frame.tx[i];
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        const l = (hw + (e === 0 ? 0 : width[i])) * side;
        X[k] = frame.px[i] + lx * l;
        Z[k] = frame.pz[i] + lz * l;
      }
    }
    out.push({ X, Z, Y: new Float64Array(n * 2), width, style });
  }
  return [out[0], out[1]];
}

/**
 * Kerb top heights. Top level with the road edge + the style's lip (flush:
 * 0, a dropped kerb); where the bank already rises above that at the outer
 * edge the top follows it (a level top would be buried). Then fitStrip, so
 * no kerb top dips under the ground between its vertices, nor under a pad
 * it meets (KERB_OVER_PAD at the outer edge).
 */
function fitKerbs(hf: Heightfield, kerbs: [KerbSide, KerbSide], roadY: Float64Array, floor: PadFloor | null): void {
  for (let s = 0; s < 2; s++) {
    const { X, Z, Y, style } = kerbs[s];
    const n = style.length;
    const cover = new Float64Array(n * 2).fill(KERB_COVER);
    const cap = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const edgeY = roadY[i * ROAD_STATIONS + (s === 0 ? ROAD_STATIONS - 1 : 0)];
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        const g = hf.getHeight(X[k], Z[k]);
        Y[k] = e === 0 ? edgeY + KERB_LIP[style[i]] : Math.max(Y[k - 1], g + RIBBON_LIFT);
        cap[k] = g + 0.5;
      }
    }
    fitStrip(hf, n, 2, X, Z, Y, cover, cap, floor, KERB_OVER_PAD);
  }
}

/** The plan-view footprint of the road and both kerbs as triangles, per
 * row and side: centreline → kerb outer edge. Pads are cut away under it. */
function roadFootprint(frame: TrackFrame, kerbs: [KerbSide, KerbSide]): { tri: P2[]; box: [number, number, number, number] }[] {
  const out: { tri: P2[]; box: [number, number, number, number] }[] = [];
  const n = frame.n;
  for (const ks of kerbs) {
    for (let r = 0; r < n; r++) {
      const r1 = (r + 1) % n;
      const c0: P2 = [frame.px[r], frame.pz[r]];
      const c1: P2 = [frame.px[r1], frame.pz[r1]];
      const o0: P2 = [ks.X[r * 2 + 1], ks.Z[r * 2 + 1]];
      const o1: P2 = [ks.X[r1 * 2 + 1], ks.Z[r1 * 2 + 1]];
      for (const tri of [[c0, o0, o1], [c0, o1, c1]] as P2[][]) {
        const xs = tri.map((p) => p[0]);
        const zs = tri.map((p) => p[1]);
        out.push({ tri, box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] });
      }
    }
  }
  return out;
}

/** Lateral offsets of the road stations, m (+ = left of travel). */
function roadStations(hw: number): number[] {
  return [-hw, -(hw - 0.8), -hw / 2, 0, hw / 2, hw - 0.8, hw];
}

function buildRibbon(scene: Scene, data: WorldData, frame: TrackFrame, material: ShaderMaterial, Y: Float64Array, kerbs: [KerbSide, KerbSide]): Mesh {
  const hf = data.heightfield;
  const road = data.plan.road;
  const hw = road.halfWidth;
  const n = frame.n;
  const b = new Builder(data);
  const lat = roadStations(hw);
  // One row per track point PLUS a closing row repeating point 0 with
  // uv.y = length: otherwise the last quad interpolates the arc length from
  // ~590 back to 0. The texture seam then lies at s = 0, under the line.
  for (let r = 0; r <= n; r++) {
    const i = r % n;
    const s = frame.s[r];
    const px = frame.px[i];
    const pz = frame.pz[i];
    // LEFT of travel is (−tz, tx).
    const lx = -frame.tz[i];
    const lz = frame.tx[i];
    const cobble = road.cobble[i] ?? 0;
    for (let j = 0; j < lat.length; j++) {
      const x = px + lx * lat[j];
      const z = pz + lz * lat[j];
      b.vertex(x, Y[i * ROAD_STATIONS + j], z, [0, cobble, 0, 0], [lat[j], s]);
    }
    for (const side of [1, -1] as const) {
      const ks = kerbs[side > 0 ? 0 : 1];
      const code = STYLE_CODE[ks.style[i]];
      const ix = ks.X[i * 2];
      const iz = ks.Z[i * 2];
      const ox = ks.X[i * 2 + 1];
      const oz = ks.Z[i * 2 + 1];
      // The lip starts where the road surface ends (station 6 left, 0 right).
      const edgeY = Y[i * ROAD_STATIONS + (side > 0 ? ROAD_STATIONS - 1 : 0)];
      const top = ks.Y[i * 2];
      const outerTop = ks.Y[i * 2 + 1];
      const outerGround = hf.getHeight(ox, oz);
      const skirtBottom = Math.min(outerTop, outerGround) - SKIRT_DEPTH;
      const inward: [number, number, number] = [-lx * side, 0, -lz * side];
      const outward: [number, number, number] = [lx * side, 0, lz * side];
      const latIn = hw * side;
      const latOut = (hw + ks.width[i]) * side;
      // Inner lip face (toward the road), top, outer skirt.
      b.vertex(ix, edgeY, iz, [1, cobble, code, 0], [latIn, s], inward);
      b.vertex(ix, top, iz, [1, cobble, code, 0], [latIn, s], inward);
      b.vertex(ix, top, iz, [1, cobble, code, 0], [latIn, s]);
      b.vertex(ox, outerTop, oz, [1, cobble, code, 1], [latOut, s]);
      b.vertex(ox, outerTop, oz, [1, cobble, code, 1], [latOut, s], outward);
      b.vertex(ox, skirtBottom, oz, [1, cobble, code, 1], [latOut, s], outward);
    }
  }
  const strip = (a: number, c: number, r: number): void => {
    const a0 = r * ROW + a;
    const c0 = r * ROW + c;
    const a1 = a0 + ROW;
    const c1 = c0 + ROW;
    b.indices.push(a0, a1, c0, c0, a1, c1);
  };
  for (let r = 0; r < n; r++) {
    for (let j = 0; j + 1 < ROAD_STATIONS; j++) strip(j, j + 1, r);
    for (let side = 0; side < 2; side++) {
      const o = ROAD_STATIONS + side * 6;
      strip(o, o + 1, r);
      strip(o + 2, o + 3, r);
      strip(o + 4, o + 5, r);
    }
  }
  return b.build('pavingRibbon', scene, material);
}

/** Lay triangles over the ground cut along the heightfield cells (see
 * "Pad heights" above): vertex y = ground + lift + the extra for `base`
 * (the pad's own lift; markings pass their pad's). Vertices are
 * welded by position within one call, so pieces share their corners.
 *
 * No T-junctions: cutting a hole peels a piece along the whole line of each
 * hole edge, which ends on an edge of a neighbouring piece that was not cut
 * (measured: about 62 such points per world, gaps up to 21 mm). So all
 * pieces are collected first; then every welded vertex that lies inside an
 * edge of another piece is inserted into that piece's outline, and the
 * piece is fanned from a corner whose two edges took no insert (or, if
 * every edge took one, from a vertex at its centroid). */
function layOnGround(b: Builder, hf: Heightfield, tris: readonly (readonly P2[])[], lift: number, color: [number, number, number, number], holes: readonly (readonly P2[])[], base: number, div: number): void {
  const weld = new Map<string, number>();
  const vx: number[] = [];
  const vz: number[] = [];
  const vertexAt = (p: P2): number => {
    const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    let v = weld.get(key);
    if (v === undefined) {
      const extra = Math.max(0, padBound(hf, p[0], p[1], div) - (base - PAD_COVER));
      v = b.vertex(p[0], hf.getHeight(p[0], p[1]) + lift + extra, p[1], color);
      weld.set(key, v);
      vx[v] = p[0];
      vz[v] = p[1];
    }
    return v;
  };
  const pieces: number[][] = [];
  for (const tri of tris) {
    clipToCells(hf, tri, div, (piece) => {
      let parts = [piece];
      for (const hole of holes) {
        const next: P2[][] = [];
        for (const p of parts) next.push(...subtractTriangle(p, hole));
        parts = next;
      }
      for (const p of parts) {
        const ids: number[] = [];
        for (const q of p) {
          const v = vertexAt(q);
          if (ids[ids.length - 1] !== v && ids[0] !== v) ids.push(v);
        }
        if (ids.length >= 3) pieces.push(ids);
      }
    });
  }
  // Vertex grid for the edge lookups (0.25 m buckets).
  const G = 0.25;
  const grid = new Map<number, number[]>();
  const gkey = (gx: number, gz: number): number => (gx + 4000) * 8192 + gz + 4000;
  for (const v of weld.values()) {
    const k = gkey(Math.floor(vx[v] / G), Math.floor(vz[v] / G));
    const list = grid.get(k);
    if (list) list.push(v);
    else grid.set(k, [v]);
  }
  // Along the edge: 0.01 mm from either end (the weld's resolution); off
  // it: 0.1 mm (cut points of nearly parallel lines wander that far).
  const EPS = 1e-5;
  const ON_EDGE = 1e-4;
  const area2 = (a: number, c: number, d: number): number => (vx[c] - vx[a]) * (vz[d] - vz[a]) - (vz[c] - vz[a]) * (vx[d] - vx[a]);
  for (const ids of pieces) {
    const ring: number[] = [];
    const cornerAt: number[] = [];
    const clean: boolean[] = [];
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const c = ids[(i + 1) % ids.length];
      cornerAt.push(ring.length);
      ring.push(a);
      const ex = vx[c] - vx[a];
      const ez = vz[c] - vz[a];
      const len2 = ex * ex + ez * ez;
      const on: [number, number][] = [];
      if (len2 > 1e-12) {
        const len = Math.sqrt(len2);
        for (let gx = Math.floor((Math.min(vx[a], vx[c]) - ON_EDGE) / G); gx <= Math.floor((Math.max(vx[a], vx[c]) + ON_EDGE) / G); gx++) {
          for (let gz = Math.floor((Math.min(vz[a], vz[c]) - ON_EDGE) / G); gz <= Math.floor((Math.max(vz[a], vz[c]) + ON_EDGE) / G); gz++) {
            for (const v of grid.get(gkey(gx, gz)) ?? []) {
              if (v === a || v === c) continue;
              const t = ((vx[v] - vx[a]) * ex + (vz[v] - vz[a]) * ez) / len2;
              if (t * len < EPS || (1 - t) * len < EPS) continue;
              if (Math.abs((vx[v] - vx[a]) * ez - (vz[v] - vz[a]) * ex) / len > ON_EDGE) continue;
              on.push([t, v]);
            }
          }
        }
      }
      on.sort((p, q) => p[0] - q[0]);
      for (const [, v] of on) ring.push(v);
      clean.push(on.length === 0);
    }
    const m = ring.length;
    const fan = (origin: number, around: number[]): void => {
      for (let i = 0; i + 1 < around.length; i++) {
        const p = around[i];
        const q = around[i + 1];
        if (p === origin || q === origin || Math.abs(area2(origin, p, q)) < 1e-12) continue;
        b.indices.push(origin, p, q);
      }
    };
    if (m === ids.length) {
      fan(ring[0], ring.slice(1));
      continue;
    }
    // A corner whose incoming and outgoing edges are both clean.
    let start = -1;
    for (let i = 0; i < ids.length && start < 0; i++) if (clean[i] && clean[(i + ids.length - 1) % ids.length]) start = cornerAt[i];
    if (start >= 0) {
      const around: number[] = [];
      for (let i = 1; i < m; i++) around.push(ring[(start + i) % m]);
      fan(ring[start], around);
    } else {
      let cx = 0;
      let cz = 0;
      for (const v of ids) {
        cx += vx[v];
        cz += vz[v];
      }
      const c = vertexAt([cx / ids.length, cz / ids.length]);
      fan(c, [...ring, ring[0]]);
    }
  }
}

function polyArea(poly: readonly P2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area / 2;
}

/** Clip a convex polygon to one side of the line a → c: keep where
 * sign · cross(c − a, p − a) ≥ 0. Crossings from canonically ordered
 * endpoints, as in clipAxis. */
function clipLine(poly: readonly P2[], a: P2, c: P2, sign: number): P2[] {
  const side = (p: P2): number => sign * ((c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]));
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = side(p);
    const dq = side(q);
    if (dp >= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const swap = p[0] > q[0] || (p[0] === q[0] && p[1] > q[1]);
      const u = swap ? q : p;
      const w = swap ? p : q;
      const du = side(u);
      const t = du / (du - side(w));
      out.push([u[0] + t * (w[0] - u[0]), u[1] + t * (w[1] - u[1])]);
    }
  }
  return out;
}

/** A convex piece minus a triangle, as convex pieces: peel off the part
 * outside each edge in turn; what is left at the end lies inside and is
 * dropped. */
function subtractTriangle(piece: P2[], hole: readonly P2[]): P2[][] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of piece) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]);
    z1 = Math.max(z1, p[1]);
  }
  if (hole.every((p) => p[0] <= x0) || hole.every((p) => p[0] >= x1) || hole.every((p) => p[1] <= z0) || hole.every((p) => p[1] >= z1)) return [piece];
  const orient = Math.sign(polyArea(hole));
  if (orient === 0) return [piece];
  const out: P2[][] = [];
  let rest: P2[] = piece;
  for (let e = 0; e < 3; e++) {
    const a = hole[e];
    const c = hole[(e + 1) % 3];
    const outside = clipLine(rest, a, c, -orient);
    if (outside.length >= 3 && Math.abs(polyArea(outside)) > 1e-8) out.push(outside);
    rest = clipLine(rest, a, c, orient);
    if (rest.length < 3 || Math.abs(polyArea(rest)) <= 1e-8) return out;
  }
  return out;
}

function padTriangles(pad: SurfacePad): P2[][] {
  const tri = triangulate(pad.polygon);
  const P = tri.points;
  const T = tri.triangles;
  const out: P2[][] = [];
  for (let t = 0; t < T.length; t += 3) out.push([P[T[t]], P[T[t + 1]], P[T[t + 2]]] as P2[]);
  return out;
}

/** One pad: its polygon triangulated, then laid on the ground cell by cell,
 * minus `holes` (the triangles of pads laid over it: a path across a
 * forecourt — two surfaces a few mm apart z-fight wherever the ground
 * twists); the markings (quads a → b) the same way, MARKING_LIFT over it. */
function addPad(b: Builder, data: WorldData, pad: SurfacePad, holes: readonly (readonly P2[])[], roadHoles: readonly (readonly P2[])[]): void {
  const hf = data.heightfield;
  const lift = PAD_LIFT[pad.role];
  const div = padDivision(hf, pad.polygon);
  layOnGround(b, hf, padTriangles(pad), lift, [SURFACE_CODE[pad.surface], 0, 0, 0], [...roadHoles, ...holes], lift, div);
  for (const m of pad.markings) {
    const dx = m.b[0] - m.a[0];
    const dz = m.b[1] - m.a[1];
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-3)) continue;
    const nx = (-dz / len) * (m.width / 2);
    const nz = (dx / len) * (m.width / 2);
    const a1: P2 = [m.a[0] + nx, m.a[1] + nz];
    const a2: P2 = [m.a[0] - nx, m.a[1] - nz];
    const b1: P2 = [m.b[0] + nx, m.b[1] + nz];
    const b2: P2 = [m.b[0] - nx, m.b[1] - nz];
    const paint: [number, number, number, number] = [SURFACE_CODE[pad.surface], 1, m.color === 'white' ? 1 : 0, 0];
    layOnGround(b, hf, [[a1, b1, a2], [a2, b1, b2]], lift + MARKING_LIFT, paint, roadHoles, lift, div);
  }
}

export interface Paving {
  /** [ribbon] or [ribbon, pads]. */
  meshes: Mesh[];
  materials: ShaderMaterial[];
  triangles: number;
}

/** Build the road ribbon (+ kerbs + start line) and the pads. */
export function buildPaving(scene: Scene, data: WorldData, ground: GroundTextureSet): Paving {
  const frame = new TrackFrame(data.track, data.heightfield.size);
  const road = data.plan.road;
  const hf = data.heightfield;
  const ribbonMat = createRibbonMaterial(scene, ground, { length: frame.length, lineDepth: road.startLine.depth, square: START_LINE_SQUARE });
  const roadY = fitRoadHeights(hf, frame, roadStations(road.halfWidth));
  const kerbs = layoutKerbs(frame, road.kerbs, road.halfWidth);
  // Pads first: they are cut away under the road and kerbs, and the kerb
  // tops are then fitted over whatever pad edge they meet.
  let padMesh: Mesh | null = null;
  let padMat: ShaderMaterial | null = null;
  let floor: PadFloor | null = null;
  if (data.plan.pads.length > 0) {
    padMat = createPadMaterial(scene, ground);
    const b = new Builder(data);
    const pads = data.plan.pads;
    const tris = pads.map(padTriangles);
    const footprint = roadFootprint(frame, kerbs);
    const box = pads.map((p) => {
      const xs = p.polygon.map((q) => q[0]);
      const zs = p.polygon.map((q) => q[1]);
      return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    });
    for (let i = 0; i < pads.length; i++) {
      const [a0, a1, b0, b1] = box[i];
      // Pads laid OVER this one (higher lift, boxes overlapping) cut it out.
      const holes: P2[][] = [];
      for (let j = 0; j < pads.length; j++) {
        if (j === i || PAD_LIFT[pads[j].role] <= PAD_LIFT[pads[i].role]) continue;
        const [c0, c1, d0, d1] = box[j];
        if (c0 >= a1 || c1 <= a0 || d0 >= b1 || d1 <= b0) continue;
        holes.push(...tris[j]);
      }
      // ... and so do the road and its kerbs.
      const roadHoles: P2[][] = [];
      for (const f of footprint) {
        const [c0, c1, d0, d1] = f.box;
        if (c0 >= a1 || c1 <= a0 || d0 >= b1 || d1 <= b0) continue;
        roadHoles.push(f.tri);
      }
      addPad(b, data, pads[i], holes, roadHoles);
    }
    floor = new PadFloor(b.positions, b.indices);
    padMesh = b.build('pavingPads', scene, padMat);
  }
  fitKerbs(hf, kerbs, roadY, floor);
  const meshes: Mesh[] = [buildRibbon(scene, data, frame, ribbonMat, roadY, kerbs)];
  const materials: ShaderMaterial[] = [ribbonMat];
  if (padMesh && padMat) {
    meshes.push(padMesh);
    materials.push(padMat);
  }
  let triangles = 0;
  for (const m of meshes) triangles += m.getTotalIndices() / 3;
  return { meshes, materials, triangles };
}
