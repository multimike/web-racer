import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { pickPaint } from './SolidMesh';
import type { PaintLike, SolidMesh } from './SolidMesh';
import { toV3, toV3s } from './math';
import type { Placement, Vec3 } from './math';
import { place } from './primitives';
import { mulberry32 } from '../../terrain/noise';

/**
 * Version of `hullIndices`. The far-model / car-lite simplifier
 * (src/render/scatter/simplify.ts) folds it into its boot-cache key and step
 * version: BUMP IT WITH ANY CHANGE TO `hullIndices` THAT CAN CHANGE A RESULT,
 * or warm boots keep drawing the old far models until the cache is cleared.
 */
export const HULL_INDICES_VERSION = 1;

/**
 * Convex hulls: the fastest route to good faceted boulders, crystals and
 * foliage blobs — scatter a handful of points, wrap them, paint with
 * `smooth: 0`.
 */

/**
 * Convex hull of a point set as index triples into `points`, each triangle
 * facing outward ((b − a) × (c − a) rule). Incremental algorithm, fine for
 * the tens-to-hundreds of points assets use. Returns [] for fewer than four
 * points or a flat (coplanar) set.
 */
export function hullIndices(points: readonly Vector3[]): number[] {
  const n = points.length;
  if (n < 4) return [];
  let lo = points[0].clone();
  let hi = points[0].clone();
  for (const q of points) {
    lo = Vector3.Minimize(lo, q);
    hi = Vector3.Maximize(hi, q);
  }
  const diag = Vector3.Distance(lo, hi);
  if (diag < 1e-12) return [];
  const eps = diag * 1e-9;

  // Initial tetrahedron from extreme points.
  let i0 = 0;
  let i1 = 0;
  const ext = hi.subtract(lo);
  const axis = ext.x >= ext.y && ext.x >= ext.z ? 'x' : ext.y >= ext.z ? 'y' : 'z';
  for (let i = 1; i < n; i++) {
    if (points[i][axis] < points[i0][axis]) i0 = i;
    if (points[i][axis] > points[i1][axis]) i1 = i;
  }
  if (i0 === i1) return [];
  const d01 = points[i1].subtract(points[i0]).normalize();
  let i2 = -1;
  let best = eps;
  for (let i = 0; i < n; i++) {
    const v = points[i].subtract(points[i0]);
    const dist = v.subtract(d01.scale(Vector3.Dot(v, d01))).length();
    if (dist > best) {
      best = dist;
      i2 = i;
    }
  }
  if (i2 < 0) return [];
  const n012 = Vector3.Cross(points[i1].subtract(points[i0]), points[i2].subtract(points[i0])).normalize();
  let i3 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(Vector3.Dot(points[i].subtract(points[i0]), n012));
    if (dist > best) {
      best = dist;
      i3 = i;
    }
  }
  if (i3 < 0) return [];

  const fa: number[] = [], fb: number[] = [], fc: number[] = [];
  const fnx: number[] = [], fny: number[] = [], fnz: number[] = [], fd: number[] = [];
  const alive: boolean[] = [];
  const addFace = (a: number, b: number, c: number): void => {
    const A = points[a], B = points[b], C = points[c];
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    fa.push(a); fb.push(b); fc.push(c);
    fnx.push(nx); fny.push(ny); fnz.push(nz);
    fd.push(nx * A.x + ny * A.y + nz * A.z);
    alive.push(true);
  };
  const centre = points[i0].add(points[i1]).add(points[i2]).add(points[i3]).scale(0.25);
  const addOriented = (a: number, b: number, c: number): void => {
    const nrm = Vector3.Cross(points[b].subtract(points[a]), points[c].subtract(points[a]));
    if (Vector3.Dot(nrm, points[a].subtract(centre)) >= 0) addFace(a, b, c);
    else addFace(a, c, b);
  };
  addOriented(i0, i1, i2);
  addOriented(i0, i1, i3);
  addOriented(i0, i2, i3);
  addOriented(i1, i2, i3);

  const used = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const q = points[i];
    const visible: number[] = [];
    for (let f = 0; f < fa.length; f++) {
      if (alive[f] && fnx[f] * q.x + fny[f] * q.y + fnz[f] * q.z - fd[f] > eps) visible.push(f);
    }
    if (visible.length === 0) continue;
    // Horizon = edges of the visible region whose twin is not visible.
    const edges = new Set<number>();
    for (const f of visible) {
      edges.add(fa[f] * n + fb[f]);
      edges.add(fb[f] * n + fc[f]);
      edges.add(fc[f] * n + fa[f]);
    }
    const horizon: [number, number][] = [];
    for (const f of visible) {
      const tri = [fa[f], fb[f], fc[f]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        if (!edges.has(b * n + a)) horizon.push([a, b]);
      }
      alive[f] = false;
    }
    for (const [a, b] of horizon) addFace(a, b, i);
  }
  const out: number[] = [];
  for (let f = 0; f < fa.length; f++) if (alive[f]) out.push(fa[f], fb[f], fc[f]);
  return out;
}

export interface ConvexHullOptions extends Placement {
  /** The point cloud, in the shape's local space (≥ 4 non-coplanar points).
   * Interior points are simply ignored, so over-scattering is safe. */
  points: readonly Vec3[];
}

/**
 * Append the convex hull of a point cloud. Paint function: (0, faceIndex) —
 * vary the paint per facet for hand-painted variation.
 *   convexHull(m, { points: [[0,0,0],[1,0,0.2],[0.4,0,1],[0.5,0.9,0.4],[0.2,0.5,0.1]] }, paint(STONE.base, { smooth: 0 }));
 */
export function convexHull(m: SolidMesh, o: ConvexHullOptions, p: PaintLike): void {
  const start = m.mark();
  const pts = o.points.map(toV3);
  const idx = hullIndices(pts);
  for (let i = 0; i < idx.length; i += 3) {
    const fp = pickPaint(p, 0, i / 3);
    if (fp) m.tri(pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]], fp);
  }
  place(m, start, o);
}

export interface BlobOptions extends Placement {
  /** Overall radius, or per-axis radii [x, y, z]. */
  radius?: number;
  radii?: Vec3;
  /** Number of hull points ≈ facet count / 2 (default 24 → ~44 triangles;
   * 10–14 for small rocks, 30–60 for canopy blobs). */
  points?: number;
  /** Seed for the irregularity (same seed = same blob). */
  seed?: number;
  /** 0 = regular geodesic-looking ball, 1 = very lumpy (default 0.35). */
  jitter?: number;
  /** Slice everything below this local y off flat (boulders sitting on the
   * ground): the hull is clipped by adding the cut ring. Default: none. */
  flatBelow?: number;
}

/**
 * A faceted convex lump: points spread evenly over an ellipsoid (Fibonacci
 * spiral), pushed in/out and sideways by seeded jitter, then hulled. Even
 * spread gives the "medium-size planes" look of the style guide instead of
 * the sliver facets random points make. Use a `smooth: 0` paint. Paint
 * function: (0, faceIndex).
 *   blob(m, { radii: [1.4, 0.9, 1.1], points: 18, seed: 7, flatBelow: -0.3, at: [0, 0.3, 0] }, ROCK);
 */
export function blob(m: SolidMesh, o: BlobOptions, p: PaintLike): void {
  const rand = mulberry32((o.seed ?? 1) * 2654435761);
  const count = Math.max(4, Math.round(o.points ?? 24));
  const jitter = o.jitter ?? 0.35;
  const r = o.radii ? toV3(o.radii) : new Vector3(o.radius ?? 1, o.radius ?? 1, o.radius ?? 1);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spin = rand() * Math.PI * 2;
  const pts: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const a = spin + i * golden;
    const d = new Vector3(Math.cos(a) * ring, y, Math.sin(a) * ring);
    // Sideways nudge about one point spacing, radial pull inward only (the
    // hull would hide outward-then-inward noise anyway).
    const spacing = 2 / Math.sqrt(count);
    d.x += (rand() - 0.5) * spacing * jitter;
    d.y += (rand() - 0.5) * spacing * jitter;
    d.z += (rand() - 0.5) * spacing * jitter;
    d.normalize();
    const k = 1 - rand() * 0.45 * jitter;
    pts.push(new Vector3(d.x * r.x * k, d.y * r.y * k, d.z * r.z * k));
  }
  let hullPts = pts;
  if (o.flatBelow !== undefined) {
    // Clip the hull with the plane y = flatBelow: keep points above, add the
    // intersections of every hull edge that crosses it.
    const cut = o.flatBelow;
    const idx = hullIndices(pts);
    const kept = pts.filter((q) => q.y >= cut);
    for (let i = 0; i < idx.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = pts[idx[i + k]];
        const b = pts[idx[i + ((k + 1) % 3)]];
        if (a.y >= cut === b.y >= cut) continue;
        const t = (cut - a.y) / (b.y - a.y);
        kept.push(new Vector3(a.x + (b.x - a.x) * t, cut, a.z + (b.z - a.z) * t));
      }
    }
    hullPts = kept;
  }
  convexHull(m, { points: toV3s(hullPts), at: o.at, rot: o.rot }, p);
}
