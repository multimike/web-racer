import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { SimplifyMesh } from '../../game/contracts/props';
import { ContentHash } from '../../boot/hash';
import { bakeStore, registerStep } from '../../boot/store';
import { HULL_INDICES_VERSION, hullIndices } from '../../gfx/solid/hull';
import type { SolidVertexData } from '../../gfx/solid/SolidMesh';

/**
 * Version of the simplifier. Part of every boot-cache key of a
 * simplification (src/boot/store.ts): BUMP IT WITH ANY CHANGE THAT CAN CHANGE
 * A RESULT (methods, thresholds, constants below), or warm boots keep
 * drawing the old far models until the cache is cleared. The one dependency
 * outside this file whose code shapes a result, `hullIndices`
 * (src/gfx/solid/hull.ts), has its own `HULL_INDICES_VERSION`; both go into
 * the key and the step version (so either bump also deletes the old entries).
 */
export const SIMPLIFY_VERSION = 1;
const SIMPLIFY_STEP_VERSION = SIMPLIFY_VERSION * 1000 + HULL_INDICES_VERSION;
registerStep('simplify', SIMPLIFY_STEP_VERSION);

/**
 * Mesh simplifier for the far tier of the world props and the car LOD 2.
 *
 * Two methods, chosen per mesh:
 *
 *  1. VERTEX CLUSTERING on a uniform grid (Lindstrom-style): every vertex
 *     falls into a cubic cell, a cell becomes one vertex placed at the
 *     minimiser of the cell's area-weighted plane quadric (regularised toward
 *     the cell's mean and clamped into the cell, so sharp corners of walls
 *     and roofs survive), triangles whose corners share a cell vanish. The
 *     cell size is bisected until the result fits `1.15 × target`. Clustering
 *     always shrinks a shape a little (the extreme vertices are averaged with
 *     their neighbours), so the result is stretched per axis back onto the
 *     source's bounding box — the silhouette keeps its size.
 *  2. PARTS (props): the mesh's edge-connected pieces each get a cheap
 *     stand-in that keeps their read — a convex hull for a lump (canopy,
 *     tyre, rock), a prism for a stick (post, rail, trunk), a two-sided card
 *     for a sheet (frond, board, banner), a one-sided decal for a thin piece
 *     printed on a bigger one (chevron, window) — and keep their own colour.
 *     Over budget, the least visible part goes first: dropped when small and
 *     holding no extreme of the bounding box, else merged into a part of its
 *     colour (see `partsMesh`). A far palm is a trunk and its fronds, a far
 *     sign a board with its arrows, a far fence two rails with air between.
 *     When the parts break the bounds, the older COLOURED LUMP HULLS are used
 *     (pieces merged into a few groups, one convex hull each).
 *
 * Both are built. Silhouettes of source and result are rasterised on a
 * 48 × 48 grid over the source's bounds on three planes (x-y, z-y, x-z).
 * Clustering is rejected when it covers less than `MIN_SILHOUETTE` of the
 * source's cells on either vertical plane (thin things: grass blades, fern
 * fronds, palm leaves, fence rails — both faces of a thin panel fall into
 * one cell and the panel vanishes). Big budgets (≥ 200: buildings, car
 * bodies) keep clustering unless the parts match the silhouette clearly
 * better (mean intersection-over-union); small budgets (props) keep the
 * parts unless clustering beats them clearly on IoU minus half the colour
 * error (how far the paint moved) — a 3–6 cell grid averages a sign's
 * arrows and a stack's coloured tyre away.
 *
 * Output is flat-shaded (three vertices per triangle) with area-weighted
 * colour, gloss, metal, emissive, AO and wind per face, indices in the
 * input's (Babylon-reversed) winding. Pure and deterministic.
 */

/** Share of the source silhouette (per vertical plane) clustering must keep. */
export const MIN_SILHOUETTE = 0.5;
/** Bounding box tolerance per axis, fraction of the source extent. */
export const BOUNDS_TOLERANCE = 0.06;
/** Clustering wins near-ties: it keeps the source's colour regions
 * (windows, doors) and its closed shells. */
const IOU_PREFERENCE = 0.05;
/** Budgets below this are props (trees, rocks, dressing): parts first. */
const SMALL_TARGET = 200;
/** Big budgets (buildings, car parts): a clustering that kept ≥ 0.8 of the
 * silhouette wins unless the hulls beat its IoU by this much — hulls of a
 * building's 140+ pieces fill the outline well but read as shards (doors,
 * clock and windows smeared over hull faces). */
const BIG_IOU_PREFERENCE = 0.15;
/** More pieces than this: no parts path (cost), lump hulls instead. */
const MAX_PARTS = 200;
/** Weight of the colour error in the small-budget choice. */
const COLOUR_WEIGHT = 0.5;
/** Smallest triangle budget of one lump hull (8 points) once the budget
 * affords several lumps. */
const MIN_PART_TRIANGLES = 12;
/** A piece whose surface is less than this share of its bounding box's
 * surface is sparse (branches, open frames) and is split before hulling. */
const SPARSE_FILL = 0.22;
const RASTER = 48;

/** 'designed' = the asset's own far model (`PropAsset.buildFar`), not simplified. */
export type SimplifyMethod = 'source' | 'cluster' | 'hull' | 'designed';

export interface SimplifyResult {
  data: SolidVertexData;
  method: SimplifyMethod;
  /** Smallest silhouette ratio of the clustering attempt (1 = untouched). */
  clusterSilhouette: number;
  /** Silhouette ratio of the returned mesh (intersection with the source). */
  silhouette: number;
  /** Mean intersection-over-union of the returned mesh's silhouettes. */
  iou: number;
  /** Largest bounding-box deviation per axis, fraction of the source extent. */
  boundsError: number;
  /** Hull groups (hull method) or grid cells along the longest axis (clustering). */
  detail: number;
  /** Colour error of the clustering and of the hull candidates (small budgets only, else NaN). */
  colourErrors: [number, number];
}

interface Source {
  P: Float32Array;
  I: Uint16Array | Uint32Array;
  T: number;
  V: number;
  min: [number, number, number];
  max: [number, number, number];
  ext: [number, number, number];
  /** Per triangle: area, unit outward normal (reversed-winding rule). */
  area: Float64Array;
  nrm: Float64Array;
  /** Per triangle: averaged attributes [r, g, b, emissive, gloss, metal, ao, wind]. */
  attr: Float32Array;
}

const ATTR = 8;

function readSource(d: SolidVertexData): Source {
  const P = d.positions;
  const I = d.indices;
  const T = d.triangleCount;
  const V = d.vertexCount;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < T * 3; t++) {
    const v = I[t] * 3;
    for (let k = 0; k < 3; k++) {
      const x = P[v + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  if (T === 0) {
    min.fill(0);
    max.fill(0);
  }
  const ext: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const area = new Float64Array(T);
  const nrm = new Float64Array(T * 3);
  const attr = new Float32Array(T * ATTR);
  const C = d.colors, U = d.uvs, U2 = d.uvs2;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    // Indices are stored reversed: (i0, i1, i2) faces (p2 − p0) × (p1 − p0).
    const ux = P[c * 3] - P[a * 3], uy = P[c * 3 + 1] - P[a * 3 + 1], uz = P[c * 3 + 2] - P[a * 3 + 2];
    const vx = P[b * 3] - P[a * 3], vy = P[b * 3 + 1] - P[a * 3 + 1], vz = P[b * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[t] = l / 2;
    if (l > 0) {
      nrm[t * 3] = nx / l;
      nrm[t * 3 + 1] = ny / l;
      nrm[t * 3 + 2] = nz / l;
    }
    const o = t * ATTR;
    for (const v of [a, b, c]) {
      attr[o] += C[v * 4] / 3;
      attr[o + 1] += C[v * 4 + 1] / 3;
      attr[o + 2] += C[v * 4 + 2] / 3;
      attr[o + 3] += C[v * 4 + 3] / 3;
      attr[o + 4] += U[v * 2] / 3;
      attr[o + 5] += U[v * 2 + 1] / 3;
      attr[o + 6] += U2[v * 2] / 3;
      attr[o + 7] += U2[v * 2 + 1] / 3;
    }
  }
  return { P, I, T, V, min, max, ext, area, nrm, attr };
}

// ---------------------------------------------------------------------------
// Output: flat-shaded triangles with per-face attributes

interface Faces {
  /** 9 floats per face: p0, p1, p2 in the reversed winding. */
  pos: number[];
  /** ATTR floats per face. */
  attr: number[];
}

/** Drop zero-area faces (a hull over nearly coplanar points can leave
 * slivers): the result must have no degenerate triangles. */
function dropDegenerate(f: Faces): Faces {
  const T = f.pos.length / 9;
  let big = 0;
  for (let i = 0; i < f.pos.length; i++) big = Math.max(big, Math.abs(f.pos[i]));
  const minArea = Math.max(1e-9, 1e-9 * big * big);
  const pos: number[] = [];
  const attr: number[] = [];
  for (let t = 0; t < T; t++) {
    const p = t * 9;
    const ux = f.pos[p + 6] - f.pos[p], uy = f.pos[p + 7] - f.pos[p + 1], uz = f.pos[p + 8] - f.pos[p + 2];
    const vx = f.pos[p + 3] - f.pos[p], vy = f.pos[p + 4] - f.pos[p + 1], vz = f.pos[p + 5] - f.pos[p + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(ar > minArea)) continue;
    for (let k = 0; k < 9; k++) pos.push(f.pos[p + k]);
    for (let k = 0; k < ATTR; k++) attr.push(f.attr[t * ATTR + k]);
  }
  return { pos, attr };
}

function buildData(faces: Faces): SolidVertexData {
  const f = dropDegenerate(faces);
  const T = f.pos.length / 9;
  const V = T * 3;
  const positions = new Float32Array(V * 3);
  const normals = new Float32Array(V * 3);
  const colors = new Float32Array(V * 4);
  const uvs = new Float32Array(V * 2);
  const uvs2 = new Float32Array(V * 2);
  const indices = V > 65535 ? new Uint32Array(V) : new Uint16Array(V);
  for (let t = 0; t < T; t++) {
    const p = t * 9;
    const ux = f.pos[p + 6] - f.pos[p], uy = f.pos[p + 7] - f.pos[p + 1], uz = f.pos[p + 8] - f.pos[p + 2];
    const vx = f.pos[p + 3] - f.pos[p], vy = f.pos[p + 4] - f.pos[p + 1], vz = f.pos[p + 5] - f.pos[p + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const a = t * ATTR;
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k;
      positions[v * 3] = f.pos[p + k * 3];
      positions[v * 3 + 1] = f.pos[p + k * 3 + 1];
      positions[v * 3 + 2] = f.pos[p + k * 3 + 2];
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      colors[v * 4] = f.attr[a];
      colors[v * 4 + 1] = f.attr[a + 1];
      colors[v * 4 + 2] = f.attr[a + 2];
      colors[v * 4 + 3] = f.attr[a + 3];
      uvs[v * 2] = f.attr[a + 4];
      uvs[v * 2 + 1] = f.attr[a + 5];
      uvs2[v * 2] = f.attr[a + 6];
      uvs2[v * 2 + 1] = f.attr[a + 7];
      indices[v] = v;
    }
  }
  return { positions, normals, colors, uvs, uvs2, indices, vertexCount: V, triangleCount: T };
}

function copyData(d: SolidVertexData): SolidVertexData {
  return {
    positions: d.positions.slice(),
    normals: d.normals.slice(),
    colors: d.colors.slice(),
    uvs: d.uvs.slice(),
    uvs2: d.uvs2.slice(),
    indices: d.indices.slice(),
    vertexCount: d.vertexCount,
    triangleCount: d.triangleCount,
  };
}

// ---------------------------------------------------------------------------
// Clustering

/** Cluster ids per vertex for a grid of `cells` along the longest axis. */
function clusterIds(src: Source, cells: number): { ids: Int32Array; count: number; cellOf: number[]; size: number } {
  const size = Math.max(src.ext[0], src.ext[1], src.ext[2], 1e-6) / cells;
  const nx = Math.floor(src.ext[0] / size) + 1;
  const ny = Math.floor(src.ext[1] / size) + 1;
  const ids = new Int32Array(src.V).fill(-1);
  const map = new Map<number, number>();
  const cellOf: number[] = [];
  const P = src.P;
  for (let v = 0; v < src.V; v++) {
    const ix = Math.min(Math.floor((P[v * 3] - src.min[0]) / size), nx - 1);
    const iy = Math.min(Math.floor((P[v * 3 + 1] - src.min[1]) / size), ny - 1);
    const iz = Math.floor((P[v * 3 + 2] - src.min[2]) / size);
    const key = ix + nx * (iy + ny * iz);
    let id = map.get(key);
    if (id === undefined) {
      id = cellOf.length / 3;
      map.set(key, id);
      cellOf.push(ix, iy, iz);
    }
    ids[v] = id;
  }
  return { ids, count: cellOf.length / 3, cellOf, size };
}

/** Surviving cluster triangles: deduplicated triples (orientation kept) and
 * the output index of every source triangle (−1 = collapsed). */
function clusterTriangles(src: Source, ids: Int32Array, count: number): { tris: number[]; srcTo: Int32Array } {
  const I = src.I;
  const seen = new Map<number, number>();
  const tris: number[] = [];
  const srcTo = new Int32Array(src.T).fill(-1);
  const K = count + 1;
  for (let t = 0; t < src.T; t++) {
    let a = ids[I[t * 3]], b = ids[I[t * 3 + 1]], c = ids[I[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    // Rotate the smallest id first: keeps the orientation, makes the key unique.
    if (b < a && b < c) [a, b, c] = [b, c, a];
    else if (c < a && c < b) [a, b, c] = [c, a, b];
    const key = (a * K + b) * K + c;
    let o = seen.get(key);
    if (o === undefined) {
      o = tris.length / 3;
      seen.set(key, o);
      tris.push(a, b, c);
    }
    srcTo[t] = o;
  }
  return { tris, srcTo };
}

function clusterMesh(src: Source, cells: number): Faces | null {
  const { ids, count, cellOf, size } = clusterIds(src, cells);
  const { tris, srcTo } = clusterTriangles(src, ids, count);
  if (tris.length === 0) return null;

  // Area-weighted plane quadrics per cluster, plus the plain vertex mean.
  const Q = new Float64Array(count * 10); // a00 a01 a02 a11 a12 a22 b0 b1 b2 (c unused)
  const mean = new Float64Array(count * 4);
  const P = src.P, I = src.I;
  for (let v = 0; v < src.V; v++) {
    const c = ids[v];
    mean[c * 4] += P[v * 3];
    mean[c * 4 + 1] += P[v * 3 + 1];
    mean[c * 4 + 2] += P[v * 3 + 2];
    mean[c * 4 + 3]++;
  }
  for (let t = 0; t < src.T; t++) {
    const w = src.area[t];
    if (!(w > 0)) continue;
    const nx = src.nrm[t * 3], ny = src.nrm[t * 3 + 1], nz = src.nrm[t * 3 + 2];
    const p0 = I[t * 3] * 3;
    const d = -(nx * P[p0] + ny * P[p0 + 1] + nz * P[p0 + 2]);
    for (let k = 0; k < 3; k++) {
      const q = ids[I[t * 3 + k]] * 10;
      Q[q] += w * nx * nx;
      Q[q + 1] += w * nx * ny;
      Q[q + 2] += w * nx * nz;
      Q[q + 3] += w * ny * ny;
      Q[q + 4] += w * ny * nz;
      Q[q + 5] += w * nz * nz;
      Q[q + 6] += w * d * nx;
      Q[q + 7] += w * d * ny;
      Q[q + 8] += w * d * nz;
    }
  }
  const rep = new Float64Array(count * 3);
  for (let c = 0; c < count; c++) {
    const n = mean[c * 4 + 3] || 1;
    const mx = mean[c * 4] / n, my = mean[c * 4 + 1] / n, mz = mean[c * 4 + 2] / n;
    const q = c * 10;
    const tr = Q[q] + Q[q + 3] + Q[q + 5];
    // Minimise Q(x) + λ|x − mean|²: (A + λI) x = λ·mean − b.
    const lam = tr * 0.01 + 1e-12;
    const a00 = Q[q] + lam, a01 = Q[q + 1], a02 = Q[q + 2], a11 = Q[q + 3] + lam, a12 = Q[q + 4], a22 = Q[q + 5] + lam;
    const r0 = lam * mx - Q[q + 6], r1 = lam * my - Q[q + 7], r2 = lam * mz - Q[q + 8];
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    let x = mx, y = my, z = mz;
    if (Math.abs(det) > 1e-30) {
      const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
      x = (c00 * r0 + c01 * r1 + c02 * r2) / det;
      y = (c01 * r0 + c11 * r1 + c12 * r2) / det;
      z = (c02 * r0 + c12 * r1 + c22 * r2) / det;
      if (!Number.isFinite(x + y + z)) {
        x = mx; y = my; z = mz;
      }
    }
    // Clamp into the cell: the minimiser of a nearly flat quadric can run far.
    const lx = src.min[0] + cellOf[c * 3] * size, ly = src.min[1] + cellOf[c * 3 + 1] * size, lz = src.min[2] + cellOf[c * 3 + 2] * size;
    rep[c * 3] = Math.min(Math.max(x, lx), lx + size);
    rep[c * 3 + 1] = Math.min(Math.max(y, ly), ly + size);
    rep[c * 3 + 2] = Math.min(Math.max(z, lz), lz + size);
  }

  // Stretch back onto the source bounds, per axis.
  const omin = [Infinity, Infinity, Infinity], omax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    const c = tris[i];
    for (let k = 0; k < 3; k++) {
      omin[k] = Math.min(omin[k], rep[c * 3 + k]);
      omax[k] = Math.max(omax[k], rep[c * 3 + k]);
    }
  }
  const scale = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    const oe = omax[k] - omin[k];
    scale[k] = oe > 1e-9 ? Math.min(src.ext[k] / oe, 2) : 0;
  }
  for (let c = 0; c < count; c++) {
    for (let k = 0; k < 3; k++) {
      rep[c * 3 + k] = scale[k] > 0 ? src.min[k] + (rep[c * 3 + k] - omin[k]) * scale[k] : src.min[k] + src.ext[k] / 2;
    }
  }

  // Per output face: area-weighted attributes of the source faces it came from.
  const F = tris.length / 3;
  const acc = new Float64Array(F * (ATTR + 1));
  for (let t = 0; t < src.T; t++) {
    const o = srcTo[t];
    if (o < 0) continue;
    const w = src.area[t] + 1e-12;
    const a = o * (ATTR + 1);
    for (let k = 0; k < ATTR; k++) acc[a + k] += src.attr[t * ATTR + k] * w;
    acc[a + ATTR] += w;
  }
  const pos: number[] = [];
  const attr: number[] = [];
  const minArea = 1e-10 * Math.max(src.ext[0], src.ext[1], src.ext[2]) ** 2;
  for (let f = 0; f < F; f++) {
    const a = tris[f * 3] * 3, b = tris[f * 3 + 1] * 3, c = tris[f * 3 + 2] * 3;
    const ux = rep[c] - rep[a], uy = rep[c + 1] - rep[a + 1], uz = rep[c + 2] - rep[a + 2];
    const vx = rep[b] - rep[a], vy = rep[b + 1] - rep[a + 1], vz = rep[b + 2] - rep[a + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(ar > minArea)) continue;
    pos.push(rep[a], rep[a + 1], rep[a + 2], rep[b], rep[b + 1], rep[b + 2], rep[c], rep[c + 1], rep[c + 2]);
    const w = acc[f * (ATTR + 1) + ATTR];
    for (let k = 0; k < ATTR; k++) attr.push(acc[f * (ATTR + 1) + k] / w);
  }
  return { pos, attr };
}

/** Bisection over the grid resolution, then the grid whose triangle count
 * is closest to the TARGET (never above `limit` = 1.15 × target). */
function bestClustering(src: Source, target: number, limit: number): { faces: Faces; cells: number } | null {
  let lo = 1;
  let hi = 600;
  // Triangle count grows (roughly) with the resolution; bisect on the count
  // of surviving triangles, which is cheap, then build the winner once.
  const countAt = (cells: number): number => {
    const { ids, count } = clusterIds(src, cells);
    return clusterTriangles(src, ids, count).tris.length / 3;
  };
  let bestCells = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (countAt(mid) <= target) {
      bestCells = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // The count is not monotonic in the resolution: look around the boundary
  // for the grid that lands closest to the target within the limit.
  let bestCount = bestCells > 0 ? countAt(bestCells) : -1;
  let bestMiss = bestCount < 0 ? Infinity : Math.abs(bestCount - target);
  for (let c = Math.max(1, bestCells - 6); c <= bestCells + 6; c++) {
    if (c === bestCells) continue;
    const n = countAt(c);
    const miss = Math.abs(n - target);
    if (n >= 4 && n <= limit && (miss < bestMiss || (miss === bestMiss && n > bestCount))) {
      bestCount = n;
      bestMiss = miss;
      bestCells = c;
    }
  }
  if (bestCells > 0) {
    const faces = clusterMesh(src, bestCells);
    if (faces) return { faces, cells: bestCells };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hull fallback

const DIRECTIONS: number[][] = (() => {
  const d: number[][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) d.push([x, y, z]);
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        const v = [0, 0, 0];
        v[a] = sa;
        v[b] = sb;
        d.push(v);
      }
    }
  }
  // Fibonacci sphere for anything finer.
  const n = 96;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    d.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  return d.map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
})();

interface Group {
  tris: number[];
  min: number[];
  max: number[];
  area: number;
}

/** Connected pieces of the mesh (by welded position). */
function components(src: Source): Group[] {
  const P = src.P, I = src.I;
  const parent = new Int32Array(src.V);
  for (let i = 0; i < src.V; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // Vertices split for shading still share a position: weld them.
  const q = 1e4;
  const at = new Map<string, number>();
  for (let v = 0; v < src.V; v++) {
    const key = `${Math.round(P[v * 3] * q)},${Math.round(P[v * 3 + 1] * q)},${Math.round(P[v * 3 + 2] * q)}`;
    const w = at.get(key);
    if (w === undefined) at.set(key, v);
    else union(v, w);
  }
  for (let t = 0; t < src.T; t++) {
    union(I[t * 3], I[t * 3 + 1]);
    union(I[t * 3], I[t * 3 + 2]);
  }
  const byRoot = new Map<number, Group>();
  for (let t = 0; t < src.T; t++) {
    const r = find(I[t * 3]);
    let g = byRoot.get(r);
    if (!g) {
      g = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], area: 0 };
      byRoot.set(r, g);
    }
    g.tris.push(t);
    g.area += src.area[t];
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        g.min[a] = Math.min(g.min[a], P[v + a]);
        g.max[a] = Math.max(g.max[a], P[v + a]);
      }
    }
  }
  return [...byRoot.values()];
}

function boxMeasure(min: number[], max: number[]): number {
  // Sum of the extents: grows for any added length, also for flat or thin boxes.
  return max[0] - min[0] + (max[1] - min[1]) + (max[2] - min[2]);
}

function boxVolume(min: number[], max: number[]): number {
  return (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
}

function mergeGroups(groups: Group[], maxGroups: number): Group[] {
  const gs = groups.slice();
  while (gs.length > maxGroups) {
    // Smallest piece (by area) joins the group whose box grows least.
    let si = 0;
    for (let i = 1; i < gs.length; i++) if (gs[i].area < gs[si].area) si = i;
    const s = gs[si];
    let bi = -1;
    let bestGrow = Infinity;
    for (let i = 0; i < gs.length; i++) {
      if (i === si) continue;
      const g = gs[i];
      const mn = [Math.min(g.min[0], s.min[0]), Math.min(g.min[1], s.min[1]), Math.min(g.min[2], s.min[2])];
      const mx = [Math.max(g.max[0], s.max[0]), Math.max(g.max[1], s.max[1]), Math.max(g.max[2], s.max[2])];
      // Volume the hull would gain (branches disappear into the canopy lump
      // beside them instead of fattening the trunk), extents as tie-break
      // for flat pieces.
      const grow = boxVolume(mn, mx) - boxVolume(g.min, g.max) + 1e-3 * (boxMeasure(mn, mx) - boxMeasure(g.min, g.max));
      if (grow < bestGrow) {
        bestGrow = grow;
        bi = i;
      }
    }
    const g = gs[bi];
    for (const t of s.tris) g.tris.push(t);
    g.area += s.area;
    for (let a = 0; a < 3; a++) {
      g.min[a] = Math.min(g.min[a], s.min[a]);
      g.max[a] = Math.max(g.max[a], s.max[a]);
    }
    gs.splice(si, 1);
  }
  return gs;
}

/** A flat piece (a banner, a leaf card) has no hull: draw the convex outline
 * of its extreme points as a polygon, both faces, coloured by the source
 * faces that look the same way. The six axis extremes come first, so the
 * bounds stay exact. */
function flatPiece(src: Source, g: Group, verts: number[], pick: (k: number) => Vector3[], budget: number, out: Faces): void {
  let nx = 0, ny = 0, nz = 0;
  for (const t of g.tris) {
    nx += src.nrm[t * 3] * src.area[t];
    ny += src.nrm[t * 3 + 1] * src.area[t];
    nz += src.nrm[t * 3 + 2] * src.area[t];
  }
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-12) {
    // Two-sided card with cancelling normals: take a face's own normal.
    const t = g.tris[0];
    nx = src.nrm[t * 3]; ny = src.nrm[t * 3 + 1]; nz = src.nrm[t * 3 + 2];
  } else {
    nx /= nl; ny /= nl; nz /= nl;
  }
  if (verts.length < 3 || Math.hypot(nx, ny, nz) < 0.5) return;
  // Polygon of m points = 2 (m − 2) triangles for both faces.
  const m = Math.max(3, Math.min(Math.max(6, Math.floor(budget / 4) + 2), Math.floor(budget / 2) + 2));
  const pts = pick(m);
  if (pts.length < 3) return;
  // In-plane basis, points ordered by angle round their centroid.
  const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * ax[2] - nz * ax[1], uy = nz * ax[0] - nx * ax[2], uz = nx * ax[1] - ny * ax[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) {
    cx += p.x / pts.length;
    cy += p.y / pts.length;
    cz += p.z / pts.length;
  }
  const ang = pts.map((p) => Math.atan2((p.x - cx) * vx + (p.y - cy) * vy + (p.z - cz) * vz, (p.x - cx) * ux + (p.y - cy) * uy + (p.z - cz) * uz));
  const order = pts.map((_, i) => i).sort((a, b) => ang[a] - ang[b] || a - b);
  const ring = order.map((i) => pts[i]);
  // Side colours: source faces looking along +n / −n.
  const side = [new Float64Array(ATTR + 1), new Float64Array(ATTR + 1)];
  for (const t of g.tris) {
    const d = src.nrm[t * 3] * nx + src.nrm[t * 3 + 1] * ny + src.nrm[t * 3 + 2] * nz;
    const acc = side[d >= 0 ? 0 : 1];
    const w = src.area[t] + 1e-12;
    for (let k = 0; k < ATTR; k++) acc[k] += src.attr[t * ATTR + k] * w;
    acc[ATTR] += w;
  }
  for (let sd = 0; sd < 2; sd++) {
    const acc = side[sd][ATTR] > 0 ? side[sd] : side[1 - sd];
    const w = acc[ATTR] || 1;
    for (let i = 1; i + 1 < ring.length; i++) {
      const A = ring[0], B = ring[i], C = ring[i + 1];
      // Ring runs counter-clockwise about +n: (A, B, C) faces +n, stored
      // reversed (A, C, B); the back face is the other way round.
      if (sd === 0) out.pos.push(A.x, A.y, A.z, C.x, C.y, C.z, B.x, B.y, B.z);
      else out.pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
      for (let k = 0; k < ATTR; k++) out.attr.push(acc[k] / w);
    }
  }
}

/** Hull of one group with at most `budget` triangles, faces appended to `out`. */
function groupHull(src: Source, g: Group, budget: number, out: Faces): void {
  const P = src.P, I = src.I;
  const verts: number[] = [];
  const seenV = new Set<number>();
  for (const t of g.tris) {
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      if (!seenV.has(v)) {
        seenV.add(v);
        verts.push(v);
      }
    }
  }
  const pick = (k: number): Vector3[] => {
    const pts: Vector3[] = [];
    const used = new Set<string>();
    for (const d of DIRECTIONS) {
      if (pts.length >= k) break;
      let best = -1;
      let bestDot = -Infinity;
      for (const v of verts) {
        const s = P[v * 3] * d[0] + P[v * 3 + 1] * d[1] + P[v * 3 + 2] * d[2];
        if (s > bestDot) {
          bestDot = s;
          best = v;
        }
      }
      const key = `${P[best * 3].toFixed(5)},${P[best * 3 + 1].toFixed(5)},${P[best * 3 + 2].toFixed(5)}`;
      if (used.has(key)) continue;
      used.add(key);
      pts.push(new Vector3(P[best * 3], P[best * 3 + 1], P[best * 3 + 2]));
    }
    return pts;
  };
  // A convex hull of k points has at most 2k − 4 triangles. Start from the
  // six axis extremes (exact bounds), then add, one at a time, the vertex
  // farthest OUTSIDE the current hull: the points spread over the shape
  // instead of piling up on a few fixed directions (a blob stays round
  // instead of turning into an octahedron).
  const k = Math.max(4, Math.floor(budget / 2) + 2);
  const pts = pick(Math.min(k, 6));
  // A flat top (a boulder's cream cap, a slab) keeps a top TRIANGLE instead
  // of the single highest point — with one apex every flat-topped rock is a
  // pyramid. Only when the plateau (vertices within 20 % of the height of the
  // top) spans a triangle whose shortest side is 15 % of the piece's width,
  // and the budget takes the two extra points (2k − 4 triangles).
  if (pts.length + 2 <= k) {
    const yTop = g.max[1], h = g.max[1] - g.min[1];
    const plateau = verts.filter((v) => P[v * 3 + 1] >= yTop - 0.2 * h);
    const topI = pts.findIndex((q) => q.y >= yTop - 1e-9);
    if (plateau.length >= 3 && topI >= 0) {
      const t0 = pts[topI];
      const far = (from: { x: number; z: number }[]): number => {
        let best = -1;
        let bestD = -1;
        for (const v of plateau) {
          let d = Infinity;
          for (const f of from) d = Math.min(d, Math.hypot(P[v * 3] - f.x, P[v * 3 + 2] - f.z));
          if (d > bestD) {
            bestD = d;
            best = v;
          }
        }
        return best;
      };
      const v1 = far([t0]);
      const p1 = { x: P[v1 * 3], z: P[v1 * 3 + 2] };
      const v2 = far([t0, p1]);
      const width = Math.max(g.max[0] - g.min[0], g.max[2] - g.min[2]);
      const spread = Math.min(Math.hypot(p1.x - t0.x, p1.z - t0.z), Math.hypot(P[v2 * 3] - t0.x, P[v2 * 3 + 2] - t0.z), Math.hypot(P[v2 * 3] - p1.x, P[v2 * 3 + 2] - p1.z));
      if (spread >= 0.15 * width) {
        pts.push(new Vector3(P[v1 * 3], P[v1 * 3 + 1], P[v1 * 3 + 2]), new Vector3(P[v2 * 3], P[v2 * 3 + 1], P[v2 * 3 + 2]));
      }
    }
  }
  let idx = hullIndices(pts);
  while (idx.length > 0 && pts.length < k) {
    const H = idx.length / 3;
    const planes = new Float64Array(H * 4);
    for (let h = 0; h < H; h++) {
      const A = pts[idx[h * 3]], B = pts[idx[h * 3 + 1]], C = pts[idx[h * 3 + 2]];
      const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
      const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      planes[h * 4] = nx;
      planes[h * 4 + 1] = ny;
      planes[h * 4 + 2] = nz;
      planes[h * 4 + 3] = nx * A.x + ny * A.y + nz * A.z;
    }
    let best = -1;
    let bestOut = 1e-6 * Math.max(boxMeasure(g.min, g.max), 1e-3);
    for (const v of verts) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let out = -Infinity;
      for (let h = 0; h < H; h++) out = Math.max(out, planes[h * 4] * x + planes[h * 4 + 1] * y + planes[h * 4 + 2] * z - planes[h * 4 + 3]);
      if (out > bestOut) {
        bestOut = out;
        best = v;
      }
    }
    if (best < 0) break; // every vertex is inside: the hull is exact
    pts.push(new Vector3(P[best * 3], P[best * 3 + 1], P[best * 3 + 2]));
    const next = hullIndices(pts);
    if (next.length / 3 > budget) {
      pts.pop();
      break;
    }
    idx = next;
  }
  if (idx.length === 0) {
    flatPiece(src, g, verts, pick, budget, out);
    return;
  }
  emitHull(src, g.tris, pts, idx, out);
}

/** Append the hull faces `idx` over `pts`; every source face of `tris` lends
 * its colour to the nearest hull face plane (among the faces that look the
 * same way), area-weighted. */
function emitHull(src: Source, tris: readonly number[], pts: Vector3[], idx: number[], out: Faces): void {
  const P = src.P, I = src.I;
  // Colour: every source face goes to the nearest hull face plane (among the
  // faces that look the same way), area-weighted.
  const H = idx.length / 3;
  const fn = new Float64Array(H * 4);
  for (let h = 0; h < H; h++) {
    const A = pts[idx[h * 3]], B = pts[idx[h * 3 + 1]], C = pts[idx[h * 3 + 2]];
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    fn[h * 4] = nx;
    fn[h * 4 + 1] = ny;
    fn[h * 4 + 2] = nz;
    fn[h * 4 + 3] = nx * A.x + ny * A.y + nz * A.z;
  }
  const acc = new Float64Array(H * (ATTR + 1));
  const all = new Float64Array(ATTR + 1);
  for (const t of tris) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const sn = [src.nrm[t * 3], src.nrm[t * 3 + 1], src.nrm[t * 3 + 2]];
    let best = -1;
    let bestD = Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (let h = 0; h < H; h++) {
        const dot = fn[h * 4] * sn[0] + fn[h * 4 + 1] * sn[1] + fn[h * 4 + 2] * sn[2];
        if (pass === 0 && dot < -0.2) continue;
        const dist = Math.abs(fn[h * 4 + 3] - (fn[h * 4] * cx + fn[h * 4 + 1] * cy + fn[h * 4 + 2] * cz));
        if (dist < bestD) {
          bestD = dist;
          best = h;
        }
      }
    }
    const w = src.area[t] + 1e-12;
    for (let k2 = 0; k2 < ATTR; k2++) {
      acc[best * (ATTR + 1) + k2] += src.attr[t * ATTR + k2] * w;
      all[k2] += src.attr[t * ATTR + k2] * w;
    }
    acc[best * (ATTR + 1) + ATTR] += w;
    all[ATTR] += w;
  }
  for (let h = 0; h < H; h++) {
    // hullIndices faces (b − a) × (c − a) outward; store reversed (a, c, b).
    const A = pts[idx[h * 3]], B = pts[idx[h * 3 + 1]], C = pts[idx[h * 3 + 2]];
    out.pos.push(A.x, A.y, A.z, C.x, C.y, C.z, B.x, B.y, B.z);
    const w = acc[h * (ATTR + 1) + ATTR];
    const s = w > 0 ? acc : all;
    const o = w > 0 ? h * (ATTR + 1) : 0;
    const ww = w > 0 ? w : all[ATTR] || 1;
    for (let k2 = 0; k2 < ATTR; k2++) out.attr.push(s[o + k2] / ww);
  }
}

/** Box surface area of a group. */
function boxArea(g: Group): number {
  const x = g.max[0] - g.min[0], y = g.max[1] - g.min[1], z = g.max[2] - g.min[2];
  return 2 * (x * y + y * z + z * x);
}

/** Split a sparse, branching or long piece (a trunk with its boughs) in two at the
 * median of its faces along its longest axis, recursively: its hull would
 * otherwise be a solid wedge filling all the air between the branches. */
function splitSparse(src: Source, g: Group, depth: number, out: Group[], sparseOnly = false): void {
  const fill = g.area / Math.max(boxArea(g), 1e-12);
  const e = [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]].sort((a, b) => b - a);
  // Long pieces too (a trunk running up into its fork): the hull of the
  // whole would be as thick as the fork is wide. (The parts path has sticks
  // for long pieces and only splits sparse ones.)
  const long = e[0] > 2.5 * e[1] && (!sparseOnly || fill < 0.5);
  if (depth >= 3 || g.tris.length < 24 || (fill > SPARSE_FILL && !long)) {
    out.push(g);
    return;
  }
  const ext = [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]];
  const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
  const P = src.P, I = src.I;
  const centre = (t: number): number => (P[I[t * 3] * 3 + axis] + P[I[t * 3 + 1] * 3 + axis] + P[I[t * 3 + 2] * 3 + axis]) / 3;
  const sorted = g.tris.slice().sort((a, b) => centre(a) - centre(b) || a - b);
  const half = sorted.length >> 1;
  for (const part of [sorted.slice(0, half), sorted.slice(half)]) {
    const h: Group = { tris: part, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], area: 0 };
    for (const t of part) {
      h.area += src.area[t];
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          h.min[a] = Math.min(h.min[a], P[v + a]);
          h.max[a] = Math.max(h.max[a], P[v + a]);
        }
      }
    }
    splitSparse(src, h, depth + 1, out, sparseOnly);
  }
}

// ---------------------------------------------------------------------------
// Parts: one cheap stand-in per visible part

/**
 * The mesh's parts are its EDGE-connected pieces (fronds that only touch at
 * the crown point are separate; sparse lattices are split at their median).
 * Each part is classified by its principal extents and gets the cheapest
 * stand-in that keeps its read:
 *   blob  — a convex hull of extreme vertices (canopy lump, tyre, rock),
 *   stick — a triangular prism / tetrahedron along its axis (post, rail, trunk),
 *   sheet — a two-sided polygon in its plane (frond, board, banner),
 *   decal — a ONE-sided polygon a hair in front of its face (a printed
 *           chevron, a window, a clock face): only its own colour shows.
 * When the minimum cost of all stand-ins exceeds the budget, the least
 * visible part goes first: dropped when it is small and holds no extreme of
 * the bounding box (roots, branches inside the canopy, the stand behind a
 * sign), otherwise merged into a part of its own colour whose box grows
 * little, and only as a last resort into the part whose box grows least.
 * Spare budget refines the most visible parts. The result keeps colour
 * regions as separate faces instead of averaging them over a hull face.
 */

type PartKind = 'blob' | 'stick' | 'sheet' | 'decal';

interface Part extends Group {
  kind: PartKind;
  /** Principal axes, longest extent first, and the extents along them. */
  axes: number[][];
  lo: number[];
  hi: number[];
  /** Area-weighted mean attributes and mean (unnormalised / area) normal. */
  attr: Float64Array;
  normal: number[];
  coherence: number;
  /** Owns one of the six extremes of the whole mesh. */
  extreme: boolean;
  cost: number;
  /** Decals: +1 shows the +e3 face, −1 the −e3 face. */
  face: number;
  /** Thin along e3 (a card, a printed face). */
  thin: boolean;
  /** Sticks: the e1 range drawn (cut back inside the canopy), lo / hi by default. */
  span?: [number, number];
}

/** Eigenvectors of a symmetric 3 × 3 matrix (Jacobi), columns of the result. */
function eigen3(a: number[][]): number[][] {
  const A = a.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]);
}

function partVerts(src: Source, tris: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = src.I[t * 3 + k];
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

function analysePart(src: Source, g: Group, merged = false): Part {
  const P = src.P, I = src.I;
  // Area-weighted covariance of the face centroids (plus corners, so a
  // single big face still has a spread).
  let w = 0;
  const m = [0, 0, 0];
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const attr = new Float64Array(ATTR);
  const normal = [0, 0, 0];
  let volume = 0;
  const add = (x: number, y: number, z: number, wt: number): void => {
    w += wt;
    m[0] += x * wt; m[1] += y * wt; m[2] += z * wt;
    const p = [x, y, z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += p[i] * p[j] * wt;
  };
  for (const t of g.tris) {
    const a = src.area[t] + 1e-12;
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k] * 3;
      add(P[v], P[v + 1], P[v + 2], a / 3);
    }
    for (let k = 0; k < ATTR; k++) attr[k] += src.attr[t * ATTR + k] * a;
    normal[0] += src.nrm[t * 3] * a;
    normal[1] += src.nrm[t * 3 + 1] * a;
    normal[2] += src.nrm[t * 3 + 2] * a;
    const v0 = I[t * 3] * 3;
    volume += ((P[v0] * src.nrm[t * 3] + P[v0 + 1] * src.nrm[t * 3 + 1] + P[v0 + 2] * src.nrm[t * 3 + 2]) * src.area[t]) / 3;
  }
  const area = Math.max(g.area, 1e-12);
  for (let k = 0; k < ATTR; k++) attr[k] /= area + 1e-12 * g.tris.length;
  const mean = m.map((x) => x / w);
  const cov = C.map((r, i) => r.map((x, j) => x / w - mean[i] * mean[j]));
  const ev = eigen3(cov);
  const verts = partVerts(src, g.tris);
  // Snap to the world axes when the main axis is (nearly) one: most parts
  // are modelled axis-aligned, and a post with a square section has no
  // stable principal axes across it (the stand-in would lose its corners).
  {
    let main = 0;
    let bestVar = -Infinity;
    for (let a = 0; a < 3; a++) {
      const v = cov[0][0] * ev[a][0] * ev[a][0] + cov[1][1] * ev[a][1] * ev[a][1] + cov[2][2] * ev[a][2] * ev[a][2] + 2 * (cov[0][1] * ev[a][0] * ev[a][1] + cov[0][2] * ev[a][0] * ev[a][2] + cov[1][2] * ev[a][1] * ev[a][2]);
      if (v > bestVar) {
        bestVar = v;
        main = a;
      }
    }
    // Every axis whose spread is distinct must be near a world axis (a
    // leaning board is not snapped; a square post's two equal axes are).
    const aligned = (e: number[]): boolean => Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])) > 0.985;
    let others = true;
    for (let a = 0; a < 3; a++) if (a !== main && !aligned(ev[a])) others = false;
    const thin = ev.map((e) => cov[0][0] * e[0] * e[0] + cov[1][1] * e[1] * e[1] + cov[2][2] * e[2] * e[2] + 2 * (cov[0][1] * e[0] * e[1] + cov[0][2] * e[0] * e[2] + cov[1][2] * e[1] * e[2]));
    const rest = [0, 1, 2].filter((a) => a !== main);
    const similar = Math.abs(thin[rest[0]] - thin[rest[1]]) < 0.25 * Math.max(thin[rest[0]], thin[rest[1]], 1e-12);
    if (aligned(ev[main]) && (others || similar)) {
      for (let a = 0; a < 3; a++) ev[a] = [0, 0, 0];
      ev[0][0] = 1;
      ev[1][1] = 1;
      ev[2][2] = 1;
    }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      const d = P[v * 3] * ev[a][0] + P[v * 3 + 1] * ev[a][1] + P[v * 3 + 2] * ev[a][2];
      lo[a] = Math.min(lo[a], d);
      hi[a] = Math.max(hi[a], d);
    }
  }
  const order = [0, 1, 2].sort((x, y) => hi[y] - lo[y] - (hi[x] - lo[x]) || x - y);
  const axes = order.map((i) => ev[i]);
  // Right-handed: e3 = e1 × e2 (sheets wind about it).
  const [e1, e2] = axes;
  axes[2] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const L = order.map((i) => lo[i]);
  const H = order.map((i) => hi[i]);
  if (axes[2][0] * ev[order[2]][0] + axes[2][1] * ev[order[2]][1] + axes[2][2] * ev[order[2]][2] < 0) {
    const t = -L[2];
    L[2] = -H[2];
    H[2] = t;
  }
  const ext = [H[0] - L[0], H[1] - L[1], H[2] - L[2]];
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  const coherence = nl / area;
  // Mean thickness of a closed piece: 2 V / A (a frond arching out of its
  // plane is still a thin blade; a tyre is not).
  const thickness = (2 * Math.abs(volume)) / area;
  let kind: PartKind = 'blob';
  if (ext[2] <= 0.2 * ext[1]) kind = coherence > 0.85 && ext[2] <= 0.1 * ext[1] ? 'decal' : 'sheet';
  else if (ext[1] <= 0.3 * ext[0]) kind = 'stick';
  // (A merge of several pieces — a clump of blades — is a lump, not a leaf,
  // unless the pieces lie in one plane: a leg on its foot.)
  // Only an elongated thin piece (a frond): a thin round shell (a pine
  // tier, a parasol) keeps its volume as a lump.
  else if (!merged && thickness <= 0.08 * ext[1] && ext[1] <= 0.7 * ext[0]) kind = 'sheet';
  else if (merged && ext[2] <= 0.45 * ext[1] && ext[1] <= 0.7 * ext[0]) kind = 'sheet';
  return {
    tris: g.tris,
    min: g.min,
    max: g.max,
    area: g.area,
    kind,
    axes,
    lo: L,
    hi: H,
    attr,
    normal: nl > 0 ? normal.map((x) => x / nl) : [0, 1, 0],
    coherence,
    extreme: false,
    cost: 0,
    face: normal[0] * axes[2][0] + normal[1] * axes[2][1] + normal[2] * axes[2][2] >= 0 ? 1 : -1,
    thin: ext[2] <= 0.1 * ext[1],
  };
}

/** A thin piece lying on a bigger part (a printed chevron on its board, a
 * window on its wall) shows one face only — the one away from what backs
 * it. Free thin pieces (banners, leaves) stay two-sided. */
function markDecals(src: Source, parts: Part[]): void {
  const pad = 0.02 * Math.max(src.ext[0], src.ext[1], src.ext[2], 1e-6);
  for (const p of parts) {
    if (!p.thin || p.kind === 'blob' || p.kind === 'stick') continue;
    for (const q of parts) {
      if (q === p || q.area <= p.area) continue;
      let inside = true;
      for (let a = 0; a < 3; a++) if (p.min[a] < q.min[a] - pad || p.max[a] > q.max[a] + pad) inside = false;
      if (!inside) continue;
      const qc = [0, 1, 2].map((a) => (q.min[a] + q.max[a]) / 2);
      const pc = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) / 2);
      const e3 = p.axes[2];
      const away = (pc[0] - qc[0]) * e3[0] + (pc[1] - qc[1]) * e3[1] + (pc[2] - qc[2]) * e3[2];
      p.kind = 'decal';
      if (Math.abs(away) > 1e-9) p.face = away > 0 ? 1 : -1;
      break;
    }
  }
}

/** Triangle cost ladders of each stand-in. */
function minCost(p: Part, alone: boolean, limit: number, total: number): number {
  switch (p.kind) {
    case 'decal':
      return 2;
    case 'sheet':
    case 'stick':
      return 4;
    default:
      // A lone small blob: a 6-triangle pyramid keeps all six extremes. A
      // small part of a bigger whole (a post cap) may be a tetrahedron.
      if (alone) return limit < 8 ? (limit >= 6 ? 6 : 4) : 8;
      return p.area < 0.06 * total ? 4 : 8;
  }
}
function maxCost(p: Part, limit: number): number {
  switch (p.kind) {
    case 'decal':
      return 6;
    case 'sheet':
      return 12;
    case 'stick':
      return 8;
    default:
      return Math.min(limit, 96);
  }
}
function nextCost(p: Part): number {
  switch (p.kind) {
    case 'decal':
      return p.cost + 2;
    case 'sheet':
      return p.cost + 4;
    case 'stick':
      return 8;
    default:
      return p.cost < 8 ? 8 : p.cost + 2;
  }
}

function mergeInto(src: Source, a: Part, b: Part): Part {
  const tris = a.tris.concat(b.tris);
  const g: Group = {
    tris,
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    area: a.area + b.area,
  };
  return analysePart(src, g, true);
}

function colourDistance(a: Part, b: Part): number {
  return Math.hypot(a.attr[0] - b.attr[0], a.attr[1] - b.attr[1], a.attr[2] - b.attr[2]) + Math.abs(a.attr[3] - b.attr[3]);
}

/** Bounds of all parts but `skip`. */
function boundsWithout(parts: Part[], skip: number): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  parts.forEach((p, i) => {
    if (i === skip) return;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p.min[a]);
      max[a] = Math.max(max[a], p.max[a]);
    }
  });
  return { min, max };
}

/** How much a part is seen: its area, raised when its colour (or glow)
 * stands out from the mesh's mean — a yellow chevron on a navy board, a lit
 * lantern, a red tyre in a grey stack. */
function importance(p: Part, mean: Float64Array): number {
  const d = Math.hypot(p.attr[0] - mean[0], p.attr[1] - mean[1], p.attr[2] - mean[2]) + Math.abs(p.attr[3] - mean[3]);
  return p.area * (1 + 6 * d);
}

function reduceParts(src: Source, parts: Part[], limit: number, costOf: (p: Part) => number, force: boolean): void {
  const total = parts.reduce((n, p) => n + p.area, 0) || 1;
  const mean = new Float64Array(ATTR);
  for (const p of parts) for (let k = 0; k < ATTR; k++) mean[k] += (p.attr[k] * p.area) / total;
  const big = Math.max(src.ext[0], src.ext[1], src.ext[2], 1e-6);
  const pad = 0.02 * big;
  const vol = (l: number[], h: number[]): number => (h[0] - l[0] + 1e-3 * big) * (h[1] - l[1] + 1e-3 * big) * (h[2] - l[2] + 1e-3 * big);
  const sum = (): number => parts.reduce((n, p) => n + costOf(p), 0);
  const inside = (s: Part, q: Part): boolean => {
    for (let a = 0; a < 3; a++) if (s.min[a] < q.min[a] - pad || s.max[a] > q.max[a] + pad) return false;
    return true;
  };
  // A merge must not swallow a part of another colour (two grey tyres
  // around the cream one): no such part wholly inside the merged box.
  const swallows = (s: Part, g: Part): boolean => {
    for (const o of parts) {
      if (o === s || o === g || colourDistance(o, s) < 0.25) continue;
      let inBox = true;
      for (let a = 0; a < 3; a++) {
        if (o.min[a] < Math.min(s.min[a], g.min[a]) - pad || o.max[a] > Math.max(s.max[a], g.max[a]) + pad) inBox = false;
      }
      if (inBox) return true;
    }
    return false;
  };
  const touching = (s: Part, q: Part): boolean => {
    let gap = 0;
    for (let a = 0; a < 3; a++) gap = Math.max(gap, q.min[a] - s.max[a], s.min[a] - q.max[a]);
    return gap <= pad;
  };
  while (parts.length > 1 && sum() > limit) {
    // Every part's cheapest way out, priced by what the eye loses:
    //  - dropping a small part that holds no extreme of the whole (roots,
    //    branches inside the canopy, the stand behind a sign): a quarter of
    //    its importance;
    //  - a decal into the part it is printed on when their colours match
    //    (the host's face colour keeps it): a third;
    //  - (last pass only) a part into a touching part of its colour (a foot
    //    into its leg): half;
    //  - merging into a part of its colour whose box grows little: all of it;
    //  - (last pass only) merging into the touching part that grows least,
    //    whatever its colour: twice.
    let best = Infinity;
    let bs = -1;
    let bInto = -1; // −1: drop
    for (let si = 0; si < parts.length; si++) {
      const s = parts[si];
      const imp = importance(s, mean);
      if (imp * 0.25 >= best) continue;
      let anyI = -1, anyGrow = Infinity;
      for (let i = 0; i < parts.length; i++) {
        if (i === si) continue;
        const g = parts[i];
        const alike = colourDistance(g, s) < 0.25 && !swallows(s, g);
        let loss = Infinity;
        if (alike && s.kind === 'decal' && g.area > s.area && inside(s, g)) loss = imp * 0.33;
        // Decals stay apart (three chevrons are not one yellow band).
        else if (s.kind === 'decal' && g.kind === 'decal') loss = Infinity;
        else if (alike && force && touching(s, g)) loss = imp * 0.5;
        else if (alike) {
          const mn = [0, 1, 2].map((a) => Math.min(g.min[a], s.min[a]));
          const mx = [0, 1, 2].map((a) => Math.max(g.max[a], s.max[a]));
          if (vol(mn, mx) / (vol(s.min, s.max) + vol(g.min, g.max)) < 1.35) loss = imp;
        }
        if (loss < best) {
          best = loss;
          bs = si;
          bInto = i;
        }
        // Never into a decal: a printed face swallowing a leg is no face.
        if (force && g.kind !== 'decal') {
          const mn = [0, 1, 2].map((a) => Math.min(g.min[a], s.min[a]));
          const mx = [0, 1, 2].map((a) => Math.max(g.max[a], s.max[a]));
          const grow = vol(mn, mx) - vol(g.min, g.max) + (touching(s, g) ? 0 : 1e6 * big * big * big);
          if (grow < anyGrow) {
            anyGrow = grow;
            anyI = i;
          }
        }
      }
      if (imp < 0.06 * total && imp * 0.25 < best) {
        const b = boundsWithout(parts, si);
        let keeps = true;
        for (let a = 0; a < 3; a++) {
          const tol = 0.025 * Math.max(src.ext[a], 0.02 * big);
          if (b.min[a] > src.min[a] + tol || b.max[a] < src.max[a] - tol) keeps = false;
        }
        if (keeps) {
          best = imp * 0.25;
          bs = si;
          bInto = -1;
        }
      }
      // A decal is never forced into anything (it would paint its host).
      // Forcing a strong colour into another (a yellow arrow into its navy
      // board) costs more the further apart the colours are.
      const forced = anyI >= 0 ? imp * 2 * (1 + 4 * Math.max(0, colourDistance(s, parts[anyI]) - 0.25)) : Infinity;
      if (force && anyI >= 0 && s.kind !== 'decal' && forced < best) {
        best = forced;
        bs = si;
        bInto = anyI;
      }
    }
    if (bs < 0) return;
    const s = parts[bs];
    if (bInto >= 0) {
      const host = parts[bInto];
      const merged = mergeInto(src, host, s);
      // A decal printed on a card, or a part inside the card's box (a rail
      // behind a sign), leaves it a card.
      if (host.kind !== 'blob' && merged.kind === 'blob' && (s.kind === 'decal' || inside(s, host))) merged.kind = host.kind;
      parts[bInto] = merged;
    }
    parts.splice(bs, 1);
  }
}

/** Extent along e2 / e3 (indices 1, 2) of the points where a part's edges
 * cross three planes across e1 at 35, 50 and 65 % of its length: its
 * section along the middle. Empty (lo > hi) when no edge crosses. */
function midBox(src: Source, p: Part): { lo: number[]; hi: number[] } {
  const P = src.P, I = src.I;
  const [e1, e2, e3] = p.axes;
  const L = p.hi[0] - p.lo[0];
  const dot = (v: number, e: number[]): number => P[v * 3] * e[0] + P[v * 3 + 1] * e[1] + P[v * 3 + 2] * e[2];
  const midB = { lo: [0, Infinity, Infinity], hi: [0, -Infinity, -Infinity] };
  for (const f of [0.35, 0.5, 0.65]) {
    const c = p.lo[0] + f * L;
    for (const t of p.tris) {
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
        const da = dot(a, e1) - c, db = dot(b, e1) - c;
        if ((da > 0 && db > 0) || (da < 0 && db < 0) || da === db) continue;
        const s = da / (da - db);
        for (const [ax, e] of [[1, e2], [2, e3]] as const) {
          const x = dot(a, e) + (dot(b, e) - dot(a, e)) * s;
          midB.lo[ax] = Math.min(midB.lo[ax], x);
          midB.hi[ax] = Math.max(midB.hi[ax], x);
        }
      }
    }
  }
  return midB;
}

/** A slender piece with a wide foot or crown (a palm or oak trunk on its
 * root flare): long against its middle section. Its hull would be a tent as
 * wide as the roots; as a stick it keeps the trunk's width. */
function slender(src: Source, p: Part): boolean {
  const b = midBox(src, p);
  const L = p.hi[0] - p.lo[0];
  return b.hi[1] > b.lo[1] && b.hi[2] > b.lo[2] && b.hi[1] - b.lo[1] <= 0.4 * L && b.hi[2] - b.lo[2] <= 0.4 * L;
}

/** A stick end buried in a bigger part of another colour (a trunk running up
 * through the canopy tiers) is cut back to just inside the first such part
 * it enters: the stand-ins of the tiers are hulls that do not hide a trunk
 * the way the source's tiers do. Never an end that holds an extreme of the
 * whole mesh, never the whole stick. Sets `p.span`. */
function clipStick(src: Source, p: Part, parts: Part[]): void {
  const [e1, e2, e3] = p.axes;
  const b = midBox(src, p);
  const c2 = b.hi[1] > b.lo[1] ? (b.lo[1] + b.hi[1]) / 2 : (p.lo[1] + p.hi[1]) / 2;
  const c3 = b.hi[2] > b.lo[2] ? (b.lo[2] + b.hi[2]) / 2 : (p.lo[2] + p.hi[2]) / 2;
  const at = (a: number): number[] => [0, 1, 2].map((k) => e1[k] * a + e2[k] * c2 + e3[k] * c3);
  const hosts = parts.filter((q) => q !== p && q.kind === 'blob' && q.area > p.area && colourDistance(p, q) >= 0.25);
  if (hosts.length === 0) return;
  const inBox = (x: number[], q: Part): boolean => x[0] >= q.min[0] && x[0] <= q.max[0] && x[1] >= q.min[1] && x[1] <= q.max[1] && x[2] >= q.min[2] && x[2] <= q.max[2];
  const L = p.hi[0] - p.lo[0];
  const span: [number, number] = [p.lo[0], p.hi[0]];
  const tol = [0, 1, 2].map((k) => 0.025 * Math.max(src.ext[k], 1e-6));
  const STEPS = 40;
  for (const end of [0, 1]) {
    const a0 = end === 0 ? p.lo[0] : p.hi[0];
    const x0 = at(a0);
    let extreme = false;
    for (let k = 0; k < 3; k++) if (Math.abs(e1[k]) > 0.5 && (x0[k] <= src.min[k] + tol[k] || x0[k] >= src.max[k] - tol[k])) extreme = true;
    if (extreme) continue;
    const dir = end === 0 ? 1 : -1;
    let host: Part | null = null;
    let exit = -1;
    for (let i = 0; i <= STEPS; i++) {
      const x = at(a0 + (dir * i * L) / STEPS);
      const q = hosts.find((h) => inBox(x, h)) ?? null;
      if (!q) {
        exit = i;
        break;
      }
      host = q;
    }
    if (exit <= 0 || !host) continue;
    // `host` is the part the stick leaves through: stop 30 % of its depth
    // along the stick inside it.
    const depth = Math.abs((host.max[0] - host.min[0]) * e1[0]) + Math.abs((host.max[1] - host.min[1]) * e1[1]) + Math.abs((host.max[2] - host.min[2]) * e1[2]);
    const boundary = a0 + (dir * exit * L) / STEPS;
    const cut = boundary - dir * Math.min(0.3 * depth, Math.abs(boundary - a0));
    span[end] = cut;
  }
  if (span[1] - span[0] > 0.05 * L) p.span = span;
}

/** Cross-sections of a stick at its two ends: centre and half extents along
 * e2 / e3 (indices 1, 2; index 0 unused). Normally both are the section
 * along its MIDDLE — where the part's edges cross three planes across e1 at
 * 35, 50 and 65 % of its length — not its bounding box: a trunk's root
 * flare, a pole's foot plate or a lamp's arm would otherwise turn the whole
 * stick into a slab. An end whose last 12 % holds an extreme of the whole
 * mesh that the middle section would lose keeps that end's own extent (a
 * tapered prism: the bounds hold). The box where no edge crosses. */
function stickSections(src: Source, p: Part): { mid: number[]; rad: number[] }[] {
  const P = src.P;
  const [e1, e2, e3] = p.axes;
  const L = p.hi[0] - p.lo[0];
  const dot = (v: number, e: number[]): number => P[v * 3] * e[0] + P[v * 3 + 1] * e[1] + P[v * 3 + 2] * e[2];
  const midB = midBox(src, p);
  const sec = (b: { lo: number[]; hi: number[] }): { mid: number[]; rad: number[] } => {
    const mid = [0, (p.lo[1] + p.hi[1]) / 2, (p.lo[2] + p.hi[2]) / 2];
    const rad = [0, (p.hi[1] - p.lo[1]) / 2, (p.hi[2] - p.lo[2]) / 2];
    for (const ax of [1, 2]) {
      if (!(b.hi[ax] > b.lo[ax])) continue;
      mid[ax] = (b.lo[ax] + b.hi[ax]) / 2;
      rad[ax] = Math.min(rad[ax], (b.hi[ax] - b.lo[ax]) / 2);
    }
    return { mid, rad };
  };
  const middle = sec(midB);
  const verts = partVerts(src, p.tris);
  const tol = [0, 1, 2].map((k) => 0.025 * Math.max(src.ext[k], 1e-6));
  return [0, 1].map((end) => {
    // Mesh extremes ACROSS the stick held by the end region's vertices (along
    // it the length keeps them): the section grows just enough, on just that
    // side, to reach each of them.
    const b = { lo: midB.lo.slice(), hi: midB.hi.slice() };
    let holds = false;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(e1[k]) > 0.9) continue;
      for (const sgn of [-1, 1]) {
        let best = -1;
        let bestV = -Infinity;
        for (const v of verts) {
          const d = dot(v, e1);
          if (end === 0 ? d > p.lo[0] + 0.12 * L : d < p.hi[0] - 0.12 * L) continue;
          const x = sgn * P[v * 3 + k];
          if (x > bestV) {
            bestV = x;
            best = v;
          }
        }
        if (best < 0) continue;
        const reach = sgn > 0 ? src.max[k] - tol[k] : -(src.min[k] + tol[k]);
        if (bestV < reach) continue;
        holds = true;
        for (const [ax, e] of [[1, e2], [2, e3]] as const) {
          const x = dot(best, e);
          b.lo[ax] = Math.min(b.lo[ax], x);
          b.hi[ax] = Math.max(b.hi[ax], x);
        }
      }
    }
    return holds ? sec(b) : middle;
  });
}

/** Stand-in of one part with `cost` triangles, appended to `out`. */
function emitPart(src: Source, p: Part, cost: number, alone: boolean, out: Faces): void {
  const P = src.P;
  const [e1, e2, e3] = p.axes;
  const at = (a: number, b: number, c: number): Vector3 =>
    new Vector3(e1[0] * a + e2[0] * b + e3[0] * c, e1[1] * a + e2[1] * b + e3[1] * c, e1[2] * a + e2[2] * b + e3[2] * c);
  const mid = [0, 1, 2].map((k) => (p.lo[k] + p.hi[k]) / 2);
  if (p.kind === 'stick') {
    // Cross-section: the part's section along its middle, not its bounding
    // box — a trunk's root flare, a pole's foot plate or a lamp's arm would
    // otherwise turn the whole stick into a slab (a far pine striped with
    // trunk between its tiers, a quest lamp as a plank).
    const [s0, s1] = stickSections(src, p);
    const [a0, a1] = p.span ?? [p.lo[0], p.hi[0]];
    // Prism: a triangle with two corners on the +e2 side's corners and its
    // apex mid −e2, so the cross-section spans the section's width both
    // ways. Tetrahedron: full width along e2 at one end, along e3 at the
    // other.
    const tri = (a: number, s: { mid: number[]; rad: number[] }): Vector3[] => [
      at(a, s.mid[1] + s.rad[1], s.mid[2] + s.rad[2]), at(a, s.mid[1] + s.rad[1], s.mid[2] - s.rad[2]), at(a, s.mid[1] - s.rad[1], s.mid[2]),
    ];
    const pts: Vector3[] = cost >= 8
      ? [...tri(a0, s0), ...tri(a1, s1)]
      : [at(a0, s0.mid[1] + s0.rad[1], s0.mid[2]), at(a0, s0.mid[1] - s0.rad[1], s0.mid[2]), at(a1, s1.mid[1], s1.mid[2] + s1.rad[2]), at(a1, s1.mid[1], s1.mid[2] - s1.rad[2])];
    const idx = hullIndices(pts);
    if (idx.length > 0) {
      emitHull(src, p.tris, pts, idx, out);
      return;
    }
  }
  if (p.kind === 'sheet' || p.kind === 'decal') {
    const verts = partVerts(src, p.tris);
    const single = p.kind === 'decal';
    const towardEdge = [0, 1, 2].reduce((n, a) => n + ((p.min[a] + p.max[a]) / 2 - (src.min[a] + src.max[a]) / 2) * e3[a], 0);
    const outer = towardEdge >= 0 ? p.hi[2] : p.lo[2];
    // A polygon of m points: m − 2 triangles per face shown.
    const m = single ? cost + 2 : cost / 2 + 2;
    // Candidates: the extreme vertex along 4m in-plane directions (axes and
    // diagonals: a leaf's tip and a board's corners both get in), then the
    // point whose removal costs the least polygon area goes, until m are
    // left — never one that holds an extreme of the whole mesh.
    const cand: { v: number; a: number; b: number; ang: number; keep: boolean }[] = [];
    const used = new Set<number>();
    const n = 4 * m;
    const tolX = [0, 1, 2].map((k) => 1e-4 * Math.max(src.ext[k], 1e-6));
    for (let j = 0; j < n; j++) {
      const ang = (2 * Math.PI * j) / n;
      const du = Math.cos(ang), dv = Math.sin(ang);
      let best = -1;
      let bestDot = -Infinity;
      for (const v of verts) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        const s = (x * e1[0] + y * e1[1] + z * e1[2]) * du + (x * e2[0] + y * e2[1] + z * e2[2]) * dv;
        if (s > bestDot + 1e-12) {
          bestDot = s;
          best = v;
        }
      }
      if (used.has(best)) continue;
      used.add(best);
      const x = P[best * 3], y = P[best * 3 + 1], z = P[best * 3 + 2];
      const a = x * e1[0] + y * e1[1] + z * e1[2], b = x * e2[0] + y * e2[1] + z * e2[2];
      let keep = false;
      for (let k = 0; k < 3; k++) if (P[best * 3 + k] <= src.min[k] + tolX[k] || P[best * 3 + k] >= src.max[k] - tolX[k]) keep = true;
      cand.push({ v: best, a, b, ang: Math.atan2(b - mid[1], a - mid[0]), keep });
    }
    cand.sort((x, y) => x.ang - y.ang || x.v - y.v);
    const tri2 = (p0: { a: number; b: number }, p1: { a: number; b: number }, p2: { a: number; b: number }): number =>
      Math.abs((p1.a - p0.a) * (p2.b - p0.b) - (p2.a - p0.a) * (p1.b - p0.b));
    while (cand.length > m) {
      let wi = -1;
      let wArea = Infinity;
      for (let i = 0; i < cand.length; i++) {
        if (cand[i].keep && cand.filter((c) => !c.keep).length > 0) continue;
        const ar = tri2(cand[(i + cand.length - 1) % cand.length], cand[i], cand[(i + 1) % cand.length]);
        if (ar < wArea) {
          wArea = ar;
          wi = i;
        }
      }
      if (wi < 0) break;
      cand.splice(wi, 1);
    }
    const ring: Vector3[] = [];
    for (const cnd of cand) {
      const x = P[cnd.v * 3], y = P[cnd.v * 3 + 1], z = P[cnd.v * 3 + 2];
      const thin = p.hi[2] - p.lo[2] <= 0.2 * (p.hi[1] - p.lo[1]);
      let c = x * e3[0] + y * e3[1] + z * e3[2];
      if (thin) {
        // A decal sits a hair in front of the surface it is printed on (on
        // the side its faces look to); a two-sided card lies on its outer
        // face (the side toward the edge of the whole mesh): the bounds hold.
        const eps = 0.0015 * Math.max(src.ext[0], src.ext[1], src.ext[2]);
        c = single ? (p.face > 0 ? p.hi[2] + eps : p.lo[2] - eps) : outer;
      }
      ring.push(at(cnd.a, cnd.b, c));
    }
    if (ring.length >= 3) {
      const facing = p.face > 0 ? 0 : 1;
      const side = [new Float64Array(ATTR + 1), new Float64Array(ATTR + 1)];
      for (const t of p.tris) {
        const d = src.nrm[t * 3] * e3[0] + src.nrm[t * 3 + 1] * e3[1] + src.nrm[t * 3 + 2] * e3[2];
        const acc = side[d >= 0 ? 0 : 1];
        const w = src.area[t] + 1e-12;
        for (let k = 0; k < ATTR; k++) acc[k] += src.attr[t * ATTR + k] * w;
        acc[ATTR] += w;
      }
      for (let sd = 0; sd < 2; sd++) {
        if (single && sd !== facing) continue;
        const acc = single ? null : side[sd][ATTR] > 0 ? side[sd] : side[1 - sd];
        for (let i = 1; i + 1 < ring.length; i++) {
          const A = ring[0], B = ring[i], C = ring[i + 1];
          // The ring runs counter-clockwise about +e3: (A, B, C) faces +e3,
          // stored reversed (A, C, B); the back face the other way round.
          if (sd === 0) out.pos.push(A.x, A.y, A.z, C.x, C.y, C.z, B.x, B.y, B.z);
          else out.pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
          if (acc) for (let k = 0; k < ATTR; k++) out.attr.push(acc[k] / (acc[ATTR] || 1));
          else for (let k = 0; k < ATTR; k++) out.attr.push(p.attr[k]);
        }
      }
      return;
    }
  }
  // Blob (and any stand-in that degenerated).
  if (alone && cost < 8 && cost >= 6) {
    // Pyramid: the four horizontal extremes dropped to the lowest point, and
    // the top — all six extremes in six triangles (a pebble on the ground).
    const verts = partVerts(src, p.tris);
    const ext = (k: number, s: number): number => {
      let best = verts[0];
      for (const v of verts) if (P[v * 3 + k] * s > P[best * 3 + k] * s) best = v;
      return best;
    };
    const ymin = p.min[1];
    const pts: Vector3[] = [];
    for (const [k, s] of [[0, 1], [0, -1], [2, 1], [2, -1]] as const) {
      const v = ext(k, s);
      pts.push(new Vector3(P[v * 3], ymin, P[v * 3 + 2]));
    }
    const top = ext(1, 1);
    pts.push(new Vector3(P[top * 3], P[top * 3 + 1], P[top * 3 + 2]));
    const idx = hullIndices(pts);
    if (idx.length > 0 && idx.length / 3 <= cost) {
      emitHull(src, p.tris, pts, idx, out);
      return;
    }
  }
  groupHull(src, p, Math.max(4, cost), out);
}

function partsMesh(src: Source, target: number): { faces: Faces; groups: number; parts: Part[] } | null {
  const limit = Math.max(4, Math.floor(target));
  const pieces: Group[] = [];
  for (const c of edgeComponents(src)) splitSparse(src, c, 1, pieces, true);
  // Hundreds of pieces (a car body's panels) cost O(n³) per reduction step:
  // those meshes cluster anyway; the caller falls back to the lump hulls.
  if (pieces.length > MAX_PARTS) return null;
  // Below 8 triangles there is room for one stand-in only (a pebble pyramid).
  if (limit < 8 && pieces.length > 1) {
    const all: Group = { tris: [], min: src.min.slice(), max: src.max.slice(), area: 0 };
    for (const g of pieces) {
      for (const t of g.tris) all.tris.push(t);
      all.area += g.area;
    }
    pieces.length = 0;
    pieces.push(all);
  }
  const parts = pieces.map((g) => analysePart(src, g, pieces.length === 1 && limit < 8));
  if (limit < 8 && parts.length === 1) parts[0].kind = 'blob';
  markDecals(src, parts);
  if (limit >= 8 && parts.length > 1) for (const p of parts) if (p.kind === 'blob' && p.tris.length >= 24 && slender(src, p)) p.kind = 'stick';
  // Generous costs first (blobs of 12 when the budget is a tree's), merging
  // only alike parts; then the minimum costs, merging whatever it takes.
  const comfy = limit >= 24 ? 12 : 8;
  const total = parts.reduce((n, p) => n + p.area, 0) || 1;
  reduceParts(src, parts, limit, (p) => (p.kind === 'blob' ? Math.max(comfy, minCost(p, parts.length === 1, limit, total)) : minCost(p, parts.length === 1, limit, total)), false);
  // The last pass may end a little over the target (the contract allows
  // 1.15 ×): a sign keeps its chevrons rather than merging a leg into them.
  reduceParts(src, parts, Math.floor(limit * 1.1), (p) => minCost(p, parts.length === 1, limit, total), true);
  const alone = parts.length === 1;
  for (const p of parts) p.cost = minCost(p, alone, limit, total);
  let spare = limit - parts.reduce((n, p) => n + p.cost, 0);
  if (alone) {
    parts[0].cost = Math.max(parts[0].cost, parts[0].kind === 'blob' ? limit : Math.min(limit, maxCost(parts[0], limit)));
    if (parts[0].kind === 'blob' && limit < 8) parts[0].cost = minCost(parts[0], true, limit, total);
    spare = 0;
  }
  // Spare budget: sticks become prisms first (a tetrahedron reads as a
  // twisted sliver), then the most visible parts, one step each round.
  const byArea = parts.slice().sort((a, b) => b.area - a.area || a.tris[0] - b.tris[0]);
  for (const p of byArea) {
    if (p.kind !== 'stick' || p.cost >= 8 || 8 - p.cost > spare) continue;
    spare -= 8 - p.cost;
    p.cost = 8;
  }
  let grew = true;
  while (spare > 0 && grew) {
    grew = false;
    for (const p of byArea) {
      const n = nextCost(p);
      if (n <= p.cost || n > maxCost(p, limit) || n - p.cost > spare) continue;
      spare -= n - p.cost;
      p.cost = n;
      grew = true;
    }
  }
  const out: Faces = { pos: [], attr: [] };
  if (!alone) for (const p of parts) if (p.kind === 'stick') clipStick(src, p, parts);
  for (const p of parts) emitPart(src, p, p.cost, alone, out);
  return { faces: out, groups: parts.length, parts };
}

/** What the parts path made of a mesh (props lab / tests). */
export function describeParts(data: SolidVertexData, targetTriangles: number): { kind: string; cost: number; tris: number; area: number; colour: number[]; min: number[]; max: number[] }[] {
  const src = readSource(data);
  const r = partsMesh(src, Math.max(4, Math.floor(targetTriangles)));
  if (!r) return [];
  return r.parts.map((p) => ({ kind: p.kind, cost: p.cost, tris: p.tris.length, area: p.area, colour: [p.attr[0], p.attr[1], p.attr[2]], min: p.min, max: p.max }));
}

/** Pieces of triangles that share an EDGE (welded positions). */
function edgeComponents(src: Source): Group[] {
  const P = src.P, I = src.I;
  const q = 1e4;
  const weld = new Int32Array(src.V);
  const at = new Map<string, number>();
  for (let v = 0; v < src.V; v++) {
    const key = `${Math.round(P[v * 3] * q)},${Math.round(P[v * 3 + 1] * q)},${Math.round(P[v * 3 + 2] * q)}`;
    const w = at.get(key);
    if (w === undefined) {
      at.set(key, v);
      weld[v] = v;
    } else weld[v] = w;
  }
  const parent = new Int32Array(src.T);
  for (let t = 0; t < src.T; t++) parent[t] = t;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edges = new Map<number, number>();
  const K = src.V + 1;
  for (let t = 0; t < src.T; t++) {
    if (!(src.area[t] > 0)) continue;
    for (let k = 0; k < 3; k++) {
      const a = weld[I[t * 3 + k]], b = weld[I[t * 3 + ((k + 1) % 3)]];
      const key = a < b ? a * K + b : b * K + a;
      const o = edges.get(key);
      if (o === undefined) edges.set(key, t);
      else {
        const ra = find(o), rb = find(t);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const byRoot = new Map<number, Group>();
  for (let t = 0; t < src.T; t++) {
    if (!(src.area[t] > 0)) continue;
    const r = find(t);
    let g = byRoot.get(r);
    if (!g) {
      g = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], area: 0 };
      byRoot.set(r, g);
    }
    g.tris.push(t);
    g.area += src.area[t];
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        g.min[a] = Math.min(g.min[a], P[v + a]);
        g.max[a] = Math.max(g.max[a], P[v + a]);
      }
    }
  }
  return [...byRoot.values()];
}

/** One hull of the whole mesh with the whole budget. */
function singleHull(src: Source, target: number): { faces: Faces; groups: number } {
  const all: Group = { tris: [], min: src.min.slice(), max: src.max.slice(), area: 0 };
  for (let t = 0; t < src.T; t++) {
    if (!(src.area[t] > 0)) continue;
    all.tris.push(t);
    all.area += src.area[t];
  }
  const out: Faces = { pos: [], attr: [] };
  groupHull(src, all, Math.max(4, Math.floor(target)), out);
  return { faces: out, groups: 1 };
}

function hullMesh(src: Source, target: number): { faces: Faces; groups: number } {
  const limit = Math.max(4, Math.floor(target));
  // Small budgets: few, rounder parts (a bush is one lump); a tree's budget
  // affords a part per canopy lump and a slim trunk.
  // Dressing at ~40 affords a part per post and rail (a fence must keep its
  // gaps, a lamp stay a pole with a head).
  const maxGroups = limit >= 60 ? Math.floor(limit / MIN_PART_TRIANGLES) : limit >= 30 ? Math.floor(limit / 10) : Math.max(1, Math.floor(limit / 20));
  const pieces: Group[] = [];
  if (maxGroups > 1) for (const c of components(src)) splitSparse(src, c, 0, pieces);
  else pieces.push(...components(src));
  const groups = mergeGroups(pieces, maxGroups);
  // Budgets: an equal floor each (≥ 8 keeps all six axis extremes in every
  // hull: exact bounds), the rest by surface area.
  const total = groups.reduce((n, g) => n + g.area, 0) || 1;
  const floorEach = Math.min(MIN_PART_TRIANGLES, Math.floor(limit / groups.length));
  const spare = limit - floorEach * groups.length;
  const out: Faces = { pos: [], attr: [] };
  for (const g of groups) {
    const budget = groups.length === 1 ? limit : floorEach + Math.floor((spare * g.area) / total);
    groupHull(src, g, budget, out);
  }
  return { faces: out, groups: groups.length };
}

// ---------------------------------------------------------------------------
// Measures

/** Covered cells of the projection on (u, v) over the source bounds. */
function raster(P: ArrayLike<number>, I: ArrayLike<number> | null, T: number, src: Source, u: number, v: number): Uint8Array {
  const grid = new Uint8Array(RASTER * RASTER);
  const eu = src.ext[u] || 1e-9, ev = src.ext[v] || 1e-9;
  const gu = (x: number): number => ((x - src.min[u]) / eu) * RASTER;
  const gv = (x: number): number => ((x - src.min[v]) / ev) * RASTER;
  const mark = (a: number, b: number): void => {
    const i = Math.min(Math.max(Math.floor(a), 0), RASTER - 1);
    const j = Math.min(Math.max(Math.floor(b), 0), RASTER - 1);
    grid[j * RASTER + i] = 1;
  };
  for (let t = 0; t < T; t++) {
    const ia = I ? I[t * 3] : t * 3, ib = I ? I[t * 3 + 1] : t * 3 + 1, ic = I ? I[t * 3 + 2] : t * 3 + 2;
    const ax = gu(P[ia * 3 + u]), ay = gv(P[ia * 3 + v]);
    const bx = gu(P[ib * 3 + u]), by = gv(P[ib * 3 + v]);
    const cx = gu(P[ic * 3 + u]), cy = gv(P[ic * 3 + v]);
    // Thin slivers still count where their corners are.
    mark(ax, ay);
    mark(bx, by);
    mark(cx, cy);
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(d) < 1e-12) {
      // Seen edge-on (a flat mesh on its own plane): the edges are lines.
      for (const [x0, y0, x1, y1] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
        const n = Math.min(4 * RASTER, Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1);
        for (let k = 1; k < n; k++) mark(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
      }
      continue;
    }
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(RASTER - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(RASTER - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let j = y0; j <= y1; j++) {
      const py = j + 0.5;
      for (let i = x0; i <= x1; i++) {
        const px = i + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) grid[j * RASTER + i] = 1;
      }
    }
  }
  return grid;
}

const PLANES: [number, number][] = [[0, 1], [2, 1], [0, 2]];

function sourceGrids(src: Source): Uint8Array[] {
  return PLANES.map(([u, v]) => raster(src.P, src.I, src.T, src, u, v));
}

/** Per plane: share of the source's cells the result covers, and the
 * intersection over union of the two silhouettes. Returns the smallest
 * coverage over the two VERTICAL planes and the mean IoU over all three. */
function silhouette(src: Source, srcGrids: Uint8Array[], data: SolidVertexData): { coverage: number; iou: number } {
  let coverage = 1;
  let iouSum = 0;
  PLANES.forEach(([u, v], pi) => {
    const s = srcGrids[pi];
    const r = raster(data.positions, data.indices, data.triangleCount, src, u, v);
    let ns = 0, both = 0, either = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i]) ns++;
      if (s[i] && r[i]) both++;
      if (s[i] || r[i]) either++;
    }
    if (pi < 2 && ns > 0) coverage = Math.min(coverage, both / ns);
    iouSum += either > 0 ? both / either : 1;
  });
  return { coverage, iou: iouSum / PLANES.length };
}

/** Closest point on triangle (a, b, c) to p: squared distance. */
function pointTriDist2(px: number, py: number, pz: number, T: ArrayLike<number>, o: number): number {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number): number => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(apx - abx * v, apy - aby * v, apz - abz * v);
  }
  const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(apx - acx * w, apy - acy * w, apz - acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(px - (T[o + 3] + (T[o + 6] - T[o + 3]) * w), py - (T[o + 4] + (T[o + 7] - T[o + 4]) * w), pz - (T[o + 5] + (T[o + 8] - T[o + 5]) * w));
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

/** Colour error: every source face (area-weighted) against the colour of
 * the result face nearest to its centroid — how much of the paint moved.
 * Only for small results (props): O(source × result). */
function colourError(src: Source, data: SolidVertexData): number {
  const T = data.triangleCount;
  const tri = new Float64Array(T * 9);
  const col = new Float64Array(T * 4);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = data.indices[t * 3 + k];
      tri[t * 9 + k * 3] = data.positions[v * 3];
      tri[t * 9 + k * 3 + 1] = data.positions[v * 3 + 1];
      tri[t * 9 + k * 3 + 2] = data.positions[v * 3 + 2];
      for (let c = 0; c < 4; c++) col[t * 4 + c] += data.colors[v * 4 + c] / 3;
    }
  }
  let err = 0, wsum = 0;
  for (let s = 0; s < src.T; s++) {
    const w = src.area[s];
    if (!(w > 0)) continue;
    const a = src.I[s * 3] * 3, b = src.I[s * 3 + 1] * 3, c = src.I[s * 3 + 2] * 3;
    const px = (src.P[a] + src.P[b] + src.P[c]) / 3, py = (src.P[a + 1] + src.P[b + 1] + src.P[c + 1]) / 3, pz = (src.P[a + 2] + src.P[b + 2] + src.P[c + 2]) / 3;
    let best = 0, bestD = Infinity;
    for (let t = 0; t < T; t++) {
      const d = pointTriDist2(px, py, pz, tri, t * 9);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const o = s * ATTR;
    err += w * (Math.hypot(src.attr[o] - col[best * 4], src.attr[o + 1] - col[best * 4 + 1], src.attr[o + 2] - col[best * 4 + 2]) + Math.abs(src.attr[o + 3] - col[best * 4 + 3]));
    wsum += w;
  }
  return wsum > 0 ? err / wsum : 0;
}

function boundsError(src: Source, data: SolidVertexData): number {
  const P = data.positions;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], P[i + k]);
      mx[k] = Math.max(mx[k], P[i + k]);
    }
  }
  const big = Math.max(src.ext[0], src.ext[1], src.ext[2]);
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const e = Math.max(src.ext[k], 0.02 * big, 1e-6);
    worst = Math.max(worst, Math.abs(mn[k] - src.min[k]) / e, Math.abs(mx[k] - src.max[k]) / e);
  }
  return worst;
}

function valid(data: SolidVertexData, limit: number): boolean {
  if (data.triangleCount < 4 || data.triangleCount > limit) return false;
  for (let i = 0; i < data.positions.length; i++) if (!Number.isFinite(data.positions[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------

/** `simplifyMesh` with what it did (for the props lab). Both methods are
 * built; clustering is kept when it holds `MIN_SILHOUETTE` of the source's
 * silhouette and matches it at least as well as the hulls do (mean
 * intersection-over-union on the x-y, z-y and x-z planes). */
export function simplifyWithInfo(data: SolidVertexData, targetTriangles: number): SimplifyResult {
  if (!bakeStore.enabled) return simplifyFresh(data, targetTriangles);
  // Boot cache: the result is a pure function of the source buffers and the
  // target, so their content hash is the key.
  const th = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const key = new ContentHash()
    .str('simplify')
    .num(SIMPLIFY_STEP_VERSION)
    .f32(data.positions).f32(data.normals).f32(data.colors).f32(data.uvs).f32(data.uvs2)
    .str(data.indices instanceof Uint32Array ? 'u32' : 'u16').i32(data.indices)
    .num(data.vertexCount).num(data.triangleCount).num(targetTriangles)
    .digest();
  bakeStore.hashMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - th;
  const hit = bakeStore.get(key);
  if (hit) {
    const r = decodeResult(hit);
    if (r) return r;
  }
  const r = simplifyFresh(data, targetTriangles);
  bakeStore.put(key, 'simplify', encodeResult(r));
  return r;
}

const METHODS: readonly SimplifyMethod[] = ['source', 'cluster', 'hull', 'designed'];
const HEADER = 12; // float64s

/** [header f64 × 12][positions, normals, colors, uvs, uvs2 as f32][indices u16 | u32, padded to 4]. */
function encodeResult(r: SimplifyResult): ArrayBuffer {
  const d = r.data;
  const V = d.vertexCount;
  const wide = d.indices instanceof Uint32Array;
  const floats = V * 14;
  const idxBytes = d.indices.length * (wide ? 4 : 2);
  const buf = new ArrayBuffer(HEADER * 8 + floats * 4 + ((idxBytes + 3) & ~3));
  const h = new Float64Array(buf, 0, HEADER);
  h.set([METHODS.indexOf(r.method), r.clusterSilhouette, r.silhouette, r.iou, r.boundsError, r.detail, r.colourErrors[0], r.colourErrors[1], V, d.triangleCount, wide ? 32 : 16, d.indices.length]);
  const f = new Float32Array(buf, HEADER * 8, floats);
  let o = 0;
  for (const a of [d.positions, d.normals, d.colors, d.uvs, d.uvs2]) {
    f.set(a, o);
    o += a.length;
  }
  const at = HEADER * 8 + floats * 4;
  if (wide) new Uint32Array(buf, at, d.indices.length).set(d.indices);
  else new Uint16Array(buf, at, d.indices.length).set(d.indices);
  return buf;
}

/** Fresh arrays (never views of the stored buffer); null if malformed. */
function decodeResult(buf: ArrayBuffer): SimplifyResult | null {
  if (buf.byteLength < HEADER * 8) return null;
  const h = new Float64Array(buf, 0, HEADER);
  const V = h[8], nIdx = h[11], wide = h[10] === 32;
  const floats = V * 14;
  const at = HEADER * 8 + floats * 4;
  if (!(METHODS[h[0]] !== undefined) || buf.byteLength < at + nIdx * (wide ? 4 : 2)) return null;
  const f = new Float32Array(buf, HEADER * 8, floats);
  let o = 0;
  const take = (n: number): Float32Array => {
    const a = f.slice(o, o + n);
    o += n;
    return a;
  };
  const positions = take(V * 3), normals = take(V * 3), colors = take(V * 4), uvs = take(V * 2), uvs2 = take(V * 2);
  const indices = wide ? new Uint32Array(buf.slice(at, at + nIdx * 4)) : new Uint16Array(buf.slice(at, at + nIdx * 2));
  return {
    data: { positions, normals, colors, uvs, uvs2, indices, vertexCount: V, triangleCount: h[9] },
    method: METHODS[h[0]],
    clusterSilhouette: h[1],
    silhouette: h[2],
    iou: h[3],
    boundsError: h[4],
    detail: h[5],
    colourErrors: [h[6], h[7]],
  };
}

function simplifyFresh(data: SolidVertexData, targetTriangles: number): SimplifyResult {
  const target = Math.max(4, Math.floor(targetTriangles));
  const limit = Math.floor(1.15 * target);
  const src = readSource(data);
  if (src.T <= limit) {
    return { data: copyData(data), method: 'source', clusterSilhouette: 1, silhouette: 1, iou: 1, boundsError: 0, detail: 0, colourErrors: [0, 0] };
  }
  const grids = sourceGrids(src);

  // Parts first; the older lump hulls when the parts break the bounds.
  const parts = partsMesh(src, target);
  // Several lumps of one colour family (a boulder's lobes): nothing thin for
  // a grid to fill or colour regions for it to average — clustering, or one
  // hull over the whole budget, keeps a rock's flat top and cap where an
  // 8-point hull per lobe is a pyramid. (A single piece keeps the usual
  // rule: its colour regions — a bollard's stripes — are inside it.)
  const lumpsOnly = parts !== null && parts.parts.length > 1 && parts.parts.every((p) => p.kind === 'blob' && colourDistance(p, parts.parts[0]) < 0.25);
  let hull: { faces: Faces; groups: number } = parts ?? { faces: { pos: [], attr: [] }, groups: 0 };
  let hullData = buildData(hull.faces);
  let hullOk = parts !== null && valid(hullData, limit) && boundsError(src, hullData) <= BOUNDS_TOLERANCE;
  if (!hullOk) {
    const lump = hullMesh(src, target);
    const lumpData = buildData(lump.faces);
    if (valid(lumpData, limit)) {
      hull = lump;
      hullData = lumpData;
      hullOk = true;
    }
  }
  let hs = silhouette(src, grids, hullData);
  if (lumpsOnly && hullOk && hull.groups > 1) {
    // One-colour lumps: one hull over the whole budget (14 points at 24
    // triangles instead of 8 per lobe) keeps the top blunt; taken unless it
    // loses silhouette.
    const one = singleHull(src, target);
    const oneData = buildData(one.faces);
    if (valid(oneData, limit) && boundsError(src, oneData) <= BOUNDS_TOLERANCE) {
      const os = silhouette(src, grids, oneData);
      if (os.iou >= hs.iou - 0.03) {
        hull = one;
        hullData = oneData;
        hs = os;
      }
    }
  }

  let clusterSil = 0;
  const ce: [number, number] = [NaN, NaN];
  const cl = bestClustering(src, target, limit);
  if (cl) {
    const out = buildData(cl.faces);
    const cs = silhouette(src, grids, out);
    clusterSil = cs.coverage;
    const be = boundsError(src, out);
    const usable = valid(out, limit) && cs.coverage >= MIN_SILHOUETTE && be <= BOUNDS_TOLERANCE;
    // The tie margin only for a clustering that kept the shape well. Small
    // budgets (props) are the other way round: a 3–6 cell grid averages the
    // colour regions away and fills the air between fronds and rails, so
    // there clustering has to beat the parts clearly.
    // Their score subtracts half the colour error (paint that moved).
    const small = target < SMALL_TARGET;
    let cScore = cs.iou, hScore = hs.iou;
    if (small && hullOk) {
      ce[0] = colourError(src, out);
      ce[1] = colourError(src, hullData);
      cScore -= COLOUR_WEIGHT * ce[0];
      hScore -= COLOUR_WEIGHT * ce[1];
    }
    const margin = small ? (lumpsOnly ? IOU_PREFERENCE : -IOU_PREFERENCE) : cs.coverage >= 0.8 ? BIG_IOU_PREFERENCE : 0;
    if (usable && (!hullOk || ((!small || lumpsOnly || cs.coverage >= 0.7) && cScore >= hScore - margin))) {
      return { data: out, method: 'cluster', clusterSilhouette: cs.coverage, silhouette: cs.coverage, iou: cs.iou, boundsError: be, detail: cl.cells, colourErrors: ce };
    }
  }
  return {
    data: hullData,
    method: 'hull',
    clusterSilhouette: clusterSil,
    silhouette: hs.coverage,
    iou: hs.iou,
    boundsError: boundsError(src, hullData),
    detail: hull.groups,
    colourErrors: ce,
  };
}

export const simplifyMesh: SimplifyMesh = (data, targetTriangles) => simplifyWithInfo(data, targetTriangles).data;

/**
 * The simplifier's own quality numbers for a far mesh that did NOT come from
 * it (a designed far model, `PropAsset.buildFar`): silhouette coverage and
 * IoU against the source on the three planes, the bounds error, and whether
 * it is a usable far mesh within `limit` triangles.
 */
export function measureFar(source: SolidVertexData, far: SolidVertexData, limit: number): { silhouette: number; iou: number; boundsError: number; valid: boolean } {
  const src = readSource(source);
  const s = silhouette(src, sourceGrids(src), far);
  return { silhouette: s.coverage, iou: s.iou, boundsError: boundsError(src, far), valid: valid(far, limit) };
}
