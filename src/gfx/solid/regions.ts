import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Paint, SolidMesh } from './SolidMesh';
import { facingFrame } from './extrude';
import type { Facing } from './extrude';
import { toV3 } from './math';
import type { Vec2, Vec3 } from './math';
import { dedupeRing, signedArea, triangulate } from './triangulate';

/**
 * Region paint: crisp colour boundaries that do NOT follow the mesh's own
 * faces — a constant-width stripe over a tapering shell, a number roundel on
 * a door, a wave swirl along a flank, a two-tone split at a waistline, or a
 * cut-out (paint `null` deletes the region: window and cockpit openings).
 *
 * The triangles are split exactly along the region's boundary; the new
 * vertices get interpolated colour / AO / wind and — the important part —
 * the surface's EXISTING shading normals, so a stripe across a smooth glossy
 * body leaves no mark in the highlight. Splits are conforming: every
 * triangle that shares a cut edge is split at the same point, so a closed
 * mesh stays closed.
 *
 *   paintStripe(m, { axis: 'x', min: -0.12, max: 0.12, only: (_c, n) => n.y > 0.2 }, CREAM);  // centre stripe on top
 *   paintDecal(m, { outline: circleRing(0.22, 24), facing: '+x', at: [0, 0.75, 0.3] }, WHITE); // door roundel
 *   paintWhere(m, { inside: (p) => p.y - 0.9 }, UPPER);                                       // everything above y = 0.9
 *
 * Call these BEFORE `thicken` (which then gives a cut-out its rim) and
 * before `bakeAO`. `displace` afterwards re-derives normals from geometry.
 */

export interface RegionOptions {
  /** Only triangles from this index on (see `SolidMesh.mark`). */
  from?: number;
  /**
   * Restrict the region to some faces — `(centroid, faceNormal) => boolean`
   * on the ORIGINAL triangles, e.g. `(_c, n) => n.y > 0.3` for "the top
   * surface only", or a bounding test to keep a stripe off the far end.
   * Scratch vectors — do not keep them.
   */
  only?: (centroid: Vector3, faceNormal: Vector3) => boolean;
}

type Side = (x: number, y: number, z: number) => number;
type Active = (P: number[], offset: number, centroid: Vector3, normal: Vector3) => boolean;

interface CutPoint {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Parameter from the edge's LOWER vertex id to its higher one. */
  t: number;
}

/**
 * A vertex closer to the boundary than this (meters) counts as ON it, and no
 * cut point is ever placed nearer than `KEEP` to an edge's end. Both sit
 * above the mesh's weld tolerance (0.01 mm): a cut point that welded onto an
 * existing vertex would leave a zero-width sliver whose edges pair up with
 * nothing — a crack as far as every later operation (thicken, the audit) is
 * concerned.
 */
const SNAP = 3e-5;
const KEEP = 2e-5;

/**
 * One cutting session over the triangles of a mesh from `from` on. Regions
 * are convex intersections of half-spaces `side(p) >= 0`, clipped one side
 * at a time; `region()` may be called repeatedly (the pieces of a concave
 * decal), then `finish()` writes the result back.
 */
class RegionCutter {
  private readonly m: SolidMesh;
  private readonly from: number;
  private readonly P: number[];
  private readonly C: number[];
  private readonly N: number[];
  private readonly S: number[];
  private readonly A: number[];
  private readonly W: number[];
  /** Vertex id per corner: welded ids, then fresh ids for cut points. */
  private readonly V: number[];
  /** 1 while a triangle is inside every side processed so far. */
  private inn: number[] = [];
  private readonly painted: number[] = [];
  private nextId: number;
  private readonly c = new Vector3();
  private readonly n = new Vector3();

  constructor(m: SolidMesh, from: number) {
    this.m = m;
    this.from = from;
    // Weld ids first (cached by the mesh), then pin the normals: pinning does
    // not move anything, so the ids stay valid.
    const D = m.computeNormals();
    m.freezeNormals(from);
    const raw = m.rawBuffers();
    this.P = raw.positions.slice(from * 9);
    this.C = raw.colors.slice(from * 9);
    this.N = raw.normals.slice(from * 9);
    this.S = raw.surface.slice(from * 4);
    this.A = raw.ao.slice(from * 3);
    this.W = raw.wind.slice(from * 3);
    this.V = Array.from(D.weld.subarray(from * 3));
    this.nextId = D.weldCount;
    for (let t = 0, T = this.count; t < T; t++) this.painted.push(0);
  }

  private get count(): number {
    return this.S.length / 4;
  }

  private faceInto(t: number): void {
    const P = this.P;
    const o = t * 9;
    this.c.set((P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 1] + P[o + 4] + P[o + 7]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3);
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    this.n.set(nx / l, ny / l, nz / l);
  }

  /**
   * Mark as painted everything inside ALL `sides` (each ≥ 0 inside) among
   * the triangles `active` accepts. `linear` = every side is a plane (the
   * cut point on an edge is then exact; otherwise it is found by bisection).
   */
  region(sides: readonly Side[], linear: boolean, active: Active | null): void {
    const { P, V } = this;
    const T0 = this.count;
    const inn: number[] = new Array(T0);
    let any = false;
    for (let t = 0; t < T0; t++) {
      let on = this.painted[t] ? 0 : 1;
      if (on && active) {
        this.faceInto(t);
        on = active(P, t * 9, this.c, this.n) ? 1 : 0;
      }
      inn[t] = on;
      if (on) any = true;
    }
    this.inn = inn;
    if (!any) return;

    for (const side of sides) {
      const count0 = this.count;
      // Signed distance per VERTEX ID, so two triangles sharing a vertex
      // always agree on which side it is — the basis of crack-free cuts.
      const dist = new Map<number, number>();
      const dOf = (corner: number): number => {
        const id = V[corner];
        let d = dist.get(id);
        if (d === undefined) {
          d = side(P[corner * 3], P[corner * 3 + 1], P[corner * 3 + 2]);
          if (Math.abs(d) < SNAP) d = 0;
          dist.set(id, d);
        }
        return d;
      };
      const cuts = new Map<number, CutPoint>();
      const K = 67108864; // 2^26 ids per key half
      const touched = new Set<number>();

      // Pass 1: classify the triangles still inside; create one cut point
      // per crossed edge (shared through the map by every triangle on it).
      for (let t = 0; t < count0; t++) {
        if (!inn[t]) continue;
        const d0 = dOf(t * 3), d1 = dOf(t * 3 + 1), d2 = dOf(t * 3 + 2);
        const neg = d0 < 0 || d1 < 0 || d2 < 0;
        const pos = d0 > 0 || d1 > 0 || d2 > 0;
        if (!neg || !pos) {
          inn[t] = pos && !neg ? 1 : 0;
          continue;
        }
        for (let k = 0; k < 3; k++) {
          const ca = t * 3 + k;
          const cb = t * 3 + ((k + 1) % 3);
          const da = dOf(ca), db = dOf(cb);
          if (!(da * db < 0)) continue;
          const ia = V[ca], ib = V[cb];
          const lo = ia < ib ? ca : cb;
          const hi = ia < ib ? cb : ca;
          const key = V[lo] * K + V[hi];
          if (cuts.has(key)) continue;
          const dl = ia < ib ? da : db;
          const dh = ia < ib ? db : da;
          const lx = P[lo * 3], ly = P[lo * 3 + 1], lz = P[lo * 3 + 2];
          const hx = P[hi * 3], hy = P[hi * 3 + 1], hz = P[hi * 3 + 2];
          let tt = dl / (dl - dh);
          if (!linear) {
            // The boundary is curved: bisect along the edge for the true root.
            let a = 0, b = 1;
            for (let i = 0; i < 24; i++) {
              const mid = (a + b) / 2;
              const dm = side(lx + (hx - lx) * mid, ly + (hy - ly) * mid, lz + (hz - lz) * mid);
              if (dm === 0) {
                a = b = mid;
                break;
              }
              if (dm < 0 === dl < 0) a = mid;
              else b = mid;
            }
            tt = (a + b) / 2;
          }
          const len = Math.hypot(hx - lx, hy - ly, hz - lz);
          if (len > KEEP * 3) tt = Math.min(Math.max(tt, KEEP / len), 1 - KEEP / len);
          const id = this.nextId++;
          dist.set(id, 0);
          cuts.set(key, { id, x: lx + (hx - lx) * tt, y: ly + (hy - ly) * tt, z: lz + (hz - lz) * tt, t: tt });
          touched.add(V[lo]);
          touched.add(V[hi]);
        }
      }
      if (cuts.size === 0) continue;

      // Pass 2: split EVERY triangle that owns a cut edge — the ones inside
      // the region and their neighbours outside it alike (the neighbours
      // only receive the points on their edges; nothing propagates further).
      for (let t = 0; t < count0; t++) {
        const v0 = V[t * 3], v1 = V[t * 3 + 1], v2 = V[t * 3 + 2];
        if ((touched.has(v0) ? 1 : 0) + (touched.has(v1) ? 1 : 0) + (touched.has(v2) ? 1 : 0) < 2) continue;
        const e0 = cuts.get(v0 < v1 ? v0 * K + v1 : v1 * K + v0);
        const e1 = cuts.get(v1 < v2 ? v1 * K + v2 : v2 * K + v1);
        const e2 = cuts.get(v2 < v0 ? v2 * K + v0 : v0 * K + v2);
        const mask = (e0 ? 1 : 0) | (e1 ? 2 : 0) | (e2 ? 4 : 0);
        if (mask === 0) continue;
        this.split(t, mask, [e0, e1, e2], side, dOf);
      }
    }
    for (let t = 0, T = this.count; t < T; t++) if (this.inn[t]) this.painted[t] = 1;
  }

  /** Replace triangle `t` by its fragments (first in place, rest appended). */
  private split(t: number, mask: number, cut: (CutPoint | undefined)[], side: Side, dOf: (corner: number) => number): void {
    const { P, C, N, S, A, W, V, inn, painted } = this;
    // Local vertex table: 0..2 corners, 3 = cut on edge 0-1, 4 = on 1-2,
    // 5 = on 2-0.
    const vp = new Float64Array(18), vc = new Float64Array(18), vn = new Float64Array(18);
    const va = new Float64Array(6), vw = new Float64Array(6), vd = new Float64Array(6);
    const vid = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 3; k++) {
      for (let d = 0; d < 3; d++) {
        vp[k * 3 + d] = P[t * 9 + k * 3 + d];
        vc[k * 3 + d] = C[t * 9 + k * 3 + d];
        vn[k * 3 + d] = N[t * 9 + k * 3 + d];
      }
      va[k] = A[t * 3 + k];
      vw[k] = W[t * 3 + k];
      vid[k] = V[t * 3 + k];
      vd[k] = dOf(t * 3 + k);
    }
    for (let k = 0; k < 3; k++) {
      const cp = cut[k];
      if (!cp) continue;
      const j = (k + 1) % 3;
      // The cut's parameter runs from the lower id; orient it for this edge.
      const f = vid[k] < vid[j] ? cp.t : 1 - cp.t;
      const m = 3 + k;
      vp[m * 3] = cp.x;
      vp[m * 3 + 1] = cp.y;
      vp[m * 3 + 2] = cp.z;
      let nl = 0;
      for (let d = 0; d < 3; d++) {
        vc[m * 3 + d] = vc[k * 3 + d] + (vc[j * 3 + d] - vc[k * 3 + d]) * f;
        vn[m * 3 + d] = vn[k * 3 + d] + (vn[j * 3 + d] - vn[k * 3 + d]) * f;
        nl += vn[m * 3 + d] * vn[m * 3 + d];
      }
      nl = Math.sqrt(nl) || 1;
      for (let d = 0; d < 3; d++) vn[m * 3 + d] /= nl;
      va[m] = va[k] + (va[j] - va[k]) * f;
      vw[m] = vw[k] + (vw[j] - vw[k]) * f;
      vid[m] = cp.id;
      vd[m] = 0;
    }
    const d2 = (a: number, b: number): number => (vp[a * 3] - vp[b * 3]) ** 2 + (vp[a * 3 + 1] - vp[b * 3 + 1]) ** 2 + (vp[a * 3 + 2] - vp[b * 3 + 2]) ** 2;
    const frags: number[] = [];
    if (mask === 7) {
      frags.push(0, 3, 5, 3, 1, 4, 5, 4, 2, 3, 4, 5);
    } else if (mask === 1 || mask === 2 || mask === 4) {
      const r = mask === 1 ? 0 : mask === 2 ? 1 : 2;
      const a = r, b = (r + 1) % 3, c = (r + 2) % 3, mab = 3 + r;
      frags.push(a, mab, c, mab, b, c);
    } else {
      const r = mask === 3 ? 0 : mask === 6 ? 1 : 2;
      const a = r, b = (r + 1) % 3, c = (r + 2) % 3;
      const mab = 3 + r, mbc = 3 + ((r + 1) % 3);
      frags.push(mab, b, mbc);
      // The remaining quad a → mab → mbc → c, on its shorter diagonal.
      if (d2(a, mbc) <= d2(mab, c)) frags.push(a, mab, mbc, a, mbc, c);
      else frags.push(a, mab, c, mab, mbc, c);
    }
    const wasIn = inn[t];
    const wasPainted = painted[t];
    const s0 = S[t * 4], s1 = S[t * 4 + 1], s2 = S[t * 4 + 2], s3 = S[t * 4 + 3];
    for (let f = 0; f < frags.length; f += 3) {
      const first = f === 0;
      const dst = first ? t : this.count;
      let sign = 0;
      for (let k = 0; k < 3 && sign === 0; k++) sign = vd[frags[f + k]];
      if (sign === 0 && wasIn) {
        // All three corners on the boundary (possible on a curved one):
        // decide by the fragment's centre.
        const i0 = frags[f], i1 = frags[f + 1], i2 = frags[f + 2];
        sign = side((vp[i0 * 3] + vp[i1 * 3] + vp[i2 * 3]) / 3, (vp[i0 * 3 + 1] + vp[i1 * 3 + 1] + vp[i2 * 3 + 1]) / 3, (vp[i0 * 3 + 2] + vp[i1 * 3 + 2] + vp[i2 * 3 + 2]) / 3);
      }
      for (let k = 0; k < 3; k++) {
        const i = frags[f + k];
        for (let d = 0; d < 3; d++) {
          P[dst * 9 + k * 3 + d] = vp[i * 3 + d];
          C[dst * 9 + k * 3 + d] = vc[i * 3 + d];
          N[dst * 9 + k * 3 + d] = vn[i * 3 + d];
        }
        A[dst * 3 + k] = va[i];
        W[dst * 3 + k] = vw[i];
        V[dst * 3 + k] = vid[i];
      }
      S[dst * 4] = s0;
      S[dst * 4 + 1] = s1;
      S[dst * 4 + 2] = s2;
      S[dst * 4 + 3] = s3;
      inn[dst] = wasIn && sign > 0 ? 1 : 0;
      painted[dst] = wasPainted;
    }
  }

  /** Apply the paint (null = delete) to everything marked, write back.
   * Returns the number of painted (or removed) triangles. */
  finish(paint: Paint | null): number {
    const { P, C, N, S, A, W, painted } = this;
    const out = { positions: [] as number[], colors: [] as number[], normals: [] as number[], surface: [] as number[], ao: [] as number[], wind: [] as number[] };
    let n = 0;
    for (let t = 0, T = this.count; t < T; t++) {
      const o = t * 9;
      if (painted[t]) {
        n++;
        if (!paint) continue;
      }
      // A cut through (almost exactly) a vertex leaves zero-area fragments.
      const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
      const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-22) continue;
      for (let i = 0; i < 9; i++) {
        out.positions.push(P[o + i]);
        out.normals.push(N[o + i]);
      }
      if (painted[t] && paint) {
        for (let k = 0; k < 3; k++) out.colors.push(paint.color[0], paint.color[1], paint.color[2]);
        out.surface.push(paint.gloss, paint.metal, paint.emissive, paint.smooth);
      } else {
        for (let i = 0; i < 9; i++) out.colors.push(C[o + i]);
        out.surface.push(S[t * 4], S[t * 4 + 1], S[t * 4 + 2], S[t * 4 + 3]);
      }
      out.ao.push(A[t * 3], A[t * 3 + 1], A[t * 3 + 2]);
      out.wind.push(W[t * 3], W[t * 3 + 1], W[t * 3 + 2]);
    }
    this.m.replaceTriangles(this.from, out);
    return n;
  }
}

function userFilter(o: RegionOptions): Active | null {
  const only = o.only;
  return only ? (_P, _o, c, n) => only(c, n) : null;
}

export interface PaintWhereOptions extends RegionOptions {
  /**
   * Signed function of position: POSITIVE inside the region, negative
   * outside, zero on the boundary — ideally a distance in meters, e.g.
   * `(p) => p.y - 0.9` (above y = 0.9) or `(p) => 0.3 - Math.hypot(p.x, p.z)`
   * (inside a 0.3 m column). The cut follows the zero line exactly along
   * every triangle edge it crosses, so a curved boundary is as smooth as the
   * mesh is fine — and a feature narrower than a triangle can be missed
   * (both ends of every edge outside): use `paintStripe` / `paintDecal`,
   * which cut true planes, or `tessellate` first.
   * `p` is a scratch vector — do not keep it.
   */
  inside: (p: Vector3) => number;
}

/**
 * Split the surface along `inside(p) = 0` and paint the inside part (`null`
 * removes it instead). Returns the number of triangles painted.
 *   paintWhere(m, { inside: (p) => p.y - 0.9 }, ROOF_COLOUR);
 */
export function paintWhere(m: SolidMesh, o: PaintWhereOptions, paint: Paint | null): number {
  const from = o.from ?? 0;
  if (m.triangleCount <= from) return 0;
  const p = new Vector3();
  const cutter = new RegionCutter(m, from);
  cutter.region([(x, y, z) => o.inside(p.set(x, y, z))], false, userFilter(o));
  return cutter.finish(paint);
}

export interface PaintStripeOptions extends RegionOptions {
  /** Direction the band is measured along: 'x' | 'y' | 'z' or any vector. */
  axis: 'x' | 'y' | 'z' | Vec3;
  /** The band covers min ≤ (position · axis) ≤ max, in meters. Leave one out
   * for a half-space ("everything above the waistline"). */
  min?: number;
  max?: number;
}

/**
 * Paint a band between two parallel planes — a constant-width stripe however
 * the surface under it tapers or curves. Use `only` to keep it to one side
 * of the model (`(_c, n) => n.y > 0` = the top).
 *   paintStripe(m, { axis: 'x', min: -0.1, max: 0.1, only: (_c, n) => n.y > 0.2 }, STRIPE);
 */
export function paintStripe(m: SolidMesh, o: PaintStripeOptions, paint: Paint | null): number {
  const from = o.from ?? 0;
  if (m.triangleCount <= from) return 0;
  const a = o.axis === 'x' ? new Vector3(1, 0, 0) : o.axis === 'y' ? new Vector3(0, 1, 0) : o.axis === 'z' ? new Vector3(0, 0, 1) : toV3(o.axis).clone();
  a.normalize();
  const sides: Side[] = [];
  const min = o.min, max = o.max;
  if (min !== undefined) sides.push((x, y, z) => x * a.x + y * a.y + z * a.z - min);
  if (max !== undefined) sides.push((x, y, z) => max - (x * a.x + y * a.y + z * a.z));
  if (sides.length === 0) return 0;
  const cutter = new RegionCutter(m, from);
  cutter.region(sides, true, userFilter(o));
  return cutter.finish(paint);
}

export interface PaintDecalOptions extends RegionOptions {
  /**
   * The decal's outline as [x, y] points in meters, drawn AS SEEN when
   * looking at the surface from its front (x = the viewer's right, y = up).
   * Any simple polygon; convex outlines (roundels, bands, shields) cut
   * cleanest, concave ones (swirls, letters, arrows) are cut piece by piece.
   */
  outline: readonly Vec2[];
  /**
   * Which way the decal faces — the side of the model it is projected onto:
   * '+x' a car's right flank, '-x' its left, '+y' bonnet / roof (drawn as a
   * top view, model +z up the page), '+z' the nose, '-z' a building's street
   * front. Same convention as `extrudePolygon`'s `facing`.
   */
  facing: Facing;
  /** Model-space point the outline's origin lands on (its coordinate along
   * the facing axis is ignored — the decal is projected straight through). */
  at?: Vec3;
  /** Only faces turned at most this many DEGREES away from `facing` take
   * the decal (default 80 — it wraps round the shoulders but never prints
   * on the far side of the body). */
  maxAngle?: number;
  /** Only faces whose centre lies within [min, max] meters along the facing
   * axis (model coordinates) — to hit the outer skin but not a part behind. */
  depth?: readonly [number, number];
}

/**
 * Project a flat outline onto the surface and paint what it covers — number
 * roundels, flank swirls, checker patches, logos. Painted, not raised: for a
 * raised emblem use `extrudePolygon` with the same `facing`.
 *   paintDecal(m, { outline: circleRing(0.22, 24), facing: '+x', at: [0, 0.75, 0.3] }, WHITE);
 */
export function paintDecal(m: SolidMesh, o: PaintDecalOptions, paint: Paint | null): number {
  const from = o.from ?? 0;
  if (m.triangleCount <= from) return 0;
  let outline = dedupeRing(o.outline);
  if (outline.length < 3) return 0;
  if (signedArea(outline) < 0) outline = outline.reverse();

  const F = facingFrame(o.facing).m;
  const X = new Vector3(F[0], F[1], F[2]);
  const Y = new Vector3(F[4], F[5], F[6]);
  const Z = new Vector3(F[8], F[9], F[10]);
  const at = o.at ? toV3(o.at) : Vector3.Zero();
  const u0 = Vector3.Dot(at, X);
  const v0 = Vector3.Dot(at, Y);
  const cosMax = Math.cos(((o.maxAngle ?? 80) * Math.PI) / 180);
  const only = o.only;
  const depth = o.depth;

  // Convex pieces: the outline itself if it is convex, else its triangles.
  const n = outline.length;
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    const a = outline[i], b = outline[(i + 1) % n], c = outline[(i + 2) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-12) convex = false;
  }
  const pieces: Vec2[][] = [];
  if (convex) pieces.push(outline);
  else {
    const { points, triangles } = triangulate(outline);
    for (let i = 0; i < triangles.length; i += 3) pieces.push([points[triangles[i]], points[triangles[i + 1]], points[triangles[i + 2]]]);
  }

  const cutter = new RegionCutter(m, from);
  for (const piece of pieces) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of piece) {
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const sides: Side[] = [];
    for (let i = 0; i < piece.length; i++) {
      const a = piece[i];
      const b = piece[(i + 1) % piece.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-12) continue;
      // Inside = left of the edge a → b (the piece is counter-clockwise).
      const nx = -ey / len, ny = ex / len;
      const k = nx * (u0 + a[0]) + ny * (v0 + a[1]);
      const px = X.x * nx + Y.x * ny, py = X.y * nx + Y.y * ny, pz = X.z * nx + Y.z * ny;
      sides.push((x, y, z) => x * px + y * py + z * pz - k);
    }
    const active: Active = (P, off, c, nrm) => {
      if (nrm.x * Z.x + nrm.y * Z.y + nrm.z * Z.z < cosMax) return false;
      if (depth) {
        const d = c.x * Z.x + c.y * Z.y + c.z * Z.z;
        if (d < depth[0] || d > depth[1]) return false;
      }
      // Cheap reject: the triangle's projection misses the piece's box.
      let tx0 = Infinity, tx1 = -Infinity, ty0 = Infinity, ty1 = -Infinity;
      for (let i = 0; i < 9; i += 3) {
        const u = P[off + i] * X.x + P[off + i + 1] * X.y + P[off + i + 2] * X.z - u0;
        const v = P[off + i] * Y.x + P[off + i + 1] * Y.y + P[off + i + 2] * Y.z - v0;
        if (u < tx0) tx0 = u;
        if (u > tx1) tx1 = u;
        if (v < ty0) ty0 = v;
        if (v > ty1) ty1 = v;
      }
      if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1) return false;
      return only ? only(c, nrm) : true;
    };
    cutter.region(sides, true, active);
  }
  return cutter.finish(paint);
}
