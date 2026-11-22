import { ContentHash } from '../../boot/hash';
import { bakeStore, registerStep } from '../../boot/store';
import type { SolidMesh } from './SolidMesh';

/**
 * Version of the bake below. It is part of every boot-cache key of a bake
 * (src/boot/store.ts): BUMP IT WITH ANY CHANGE THAT CAN CHANGE A BAKED VALUE
 * (the ray pattern, the weights, the smoothing, the buried-vertex rule …),
 * or warm boots keep showing the old shading until the cache is cleared.
 */
export const AO_BAKE_VERSION = 1;
registerStep('ao', AO_BAKE_VERSION);

/**
 * Per-vertex ambient-occlusion bake into uv2.x (1 = open sky, 0 = buried).
 *
 * For every distinct (position, shading normal) on the mesh a cosine-weighted
 * fan of rays is traced against the mesh's own triangles (a BVH makes that
 * ~1 µs per ray) and, optionally, a ground plane, so parts darken where they
 * meet each other and where the asset meets the ground. Distance-weighted:
 * a nearby occluder counts fully, one at `maxDistance` not at all.
 *
 * AO lives on VERTICES, so it can only vary as finely as the mesh: a wall
 * made of two triangles gets one gradient corner to corner (and a visible
 * diagonal). Big faces therefore need `m.tessellate(…)` before the bake —
 * which no longer costs anything in shading (the normals are pinned). The
 * asset assembler does exactly that automatically for buildings, dressing
 * and car bodies, so ASSET BUILDERS CALL NEITHER; this matters only for a
 * builder that bakes itself, and for stand-alone use.
 *
 * Interpenetrating parts are the normal way to join things and are handled:
 * a vertex that ends up INSIDE another closed part cannot be sampled where
 * it is (every ray would start inside the other solid), so each face using
 * it is sampled where that face EMERGES from the other part instead — the
 * contact line — and the face darkens toward the joint as it should. A
 * vertex below the ground plane (the recommended skirt) is sampled at the
 * ground line in the same spirit. Both sides of every triangle occlude.
 * Occlusion only reaches `maxDistance`, so a cavity wider than that (a
 * cockpit tub, a room) stays bright inside — raise `maxDistance` to about
 * the cavity's size if it should darken.
 *
 * Call it LAST, after all geometry, region paints, `thicken`, `displace` and
 * transforms (scaling afterwards is fine; adding geometry afterwards is not
 * shaded). Faceted (`smooth: 0`) faces get a value at each of their own
 * corners, i.e. a gradient across every facet — which reads well on rocks
 * and canopies; there is no per-face mode.
 */

export interface AOOptions {
  /** Rays per sample point (default 16). 8 = fastest, a little blotchy (the
   * smoothing pass hides most of it); 32–48 = hero quality. Cost is linear. */
  rays?: number;
  /** Occluders farther than this (meters) are ignored. Default 20 % of the
   * largest bounding-box side — "contact" scale for the asset's own size.
   * Shorter = tighter, darker creases and a faster bake. */
  maxDistance?: number;
  /** 0..1+: how dark full occlusion gets (default 1). */
  strength?: number;
  /** Lower clamp of the result (default 0.1) — nothing bakes to pure black;
   * the style wants cool soft shadows, never ink. */
  floor?: number;
  /** Add an infinite ground plane as an occluder: true = at y 0 (assets
   * stand on y = 0), or a height. Default false. */
  ground?: boolean | number;
  /** Neighbour-averaging passes over the result (default 1) — removes ray
   * noise without crossing hard edges. */
  smoothPasses?: number;
  /** Rotates the ray pattern (default 1). */
  seed?: number;
  /** Stop after 8 probe rays when all of them escape (default true; ~2×
   * faster on typical models, identical on occluded areas). */
  adaptive?: boolean;
  /**
   * Bake only the triangles [first, end) — the WHOLE mesh still occludes.
   * For a mesh assembled just for the bake (a car body with its wheels put
   * in place as occluders): nothing is spent on the parts whose result
   * would be thrown away. Corners outside the range keep their AO.
   */
  only?: readonly [number, number];
}

export interface AOStats {
  /** Distinct (position, normal) sample points. */
  samples: number;
  /** Samples found inside another solid part (sampled at the contact line
   * instead, see above). */
  buried: number;
  /** Rays actually traced. */
  rays: number;
  /** Wall time including the BVH build, milliseconds. */
  ms: number;
}

// ---------------------------------------------------------------------------
// BVH over the triangle soup: binned surface-area-heuristic splits, flat
// typed arrays, iterative front-to-back closest-hit traversal.

const BINS = 12;

class TriBVH {
  private readonly tri: Float32Array; // per ordered triangle: v0, e1, e2
  private readonly bounds: Float32Array; // per node: min xyz, max xyz
  private readonly left: Int32Array; // child index, or −1 for a leaf
  private readonly right: Int32Array;
  private readonly first: Int32Array; // leaf: first ordered triangle
  private readonly count: Int32Array;
  private readonly stack = new Int32Array(128);
  private readonly stackT = new Float64Array(128);
  /** After `closestHit` found a hit: true if it struck the triangle's BACK. */
  hitBack = false;

  constructor(P: readonly number[], T: number) {
    const cx = new Float32Array(T), cy = new Float32Array(T), cz = new Float32Array(T);
    const tb = new Float32Array(T * 6);
    for (let t = 0; t < T; t++) {
      const o = t * 9;
      const x0 = Math.min(P[o], P[o + 3], P[o + 6]), x1 = Math.max(P[o], P[o + 3], P[o + 6]);
      const y0 = Math.min(P[o + 1], P[o + 4], P[o + 7]), y1 = Math.max(P[o + 1], P[o + 4], P[o + 7]);
      const z0 = Math.min(P[o + 2], P[o + 5], P[o + 8]), z1 = Math.max(P[o + 2], P[o + 5], P[o + 8]);
      tb[t * 6] = x0; tb[t * 6 + 1] = y0; tb[t * 6 + 2] = z0;
      tb[t * 6 + 3] = x1; tb[t * 6 + 4] = y1; tb[t * 6 + 5] = z1;
      cx[t] = (x0 + x1) / 2; cy[t] = (y0 + y1) / 2; cz[t] = (z0 + z1) / 2;
    }
    const order = new Int32Array(T);
    for (let t = 0; t < T; t++) order[t] = t;
    const maxNodes = Math.max(1, 2 * T);
    const bounds = new Float32Array(maxNodes * 6);
    const left = new Int32Array(maxNodes).fill(-1);
    const right = new Int32Array(maxNodes).fill(-1);
    const first = new Int32Array(maxNodes);
    const count = new Int32Array(maxNodes);
    let nodes = 0;
    const cen = [cx, cy, cz];
    const binCount = new Int32Array(BINS);
    const binBox = new Float32Array(BINS * 6);
    const rightArea = new Float32Array(BINS);
    const halfArea = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      return dx * dy + dy * dz + dz * dx;
    };

    const build = (start: number, end: number): number => {
      const node = nodes++;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let mx0 = Infinity, my0 = Infinity, mz0 = Infinity, mx1 = -Infinity, my1 = -Infinity, mz1 = -Infinity;
      for (let i = start; i < end; i++) {
        const t = order[i];
        if (tb[t * 6] < x0) x0 = tb[t * 6];
        if (tb[t * 6 + 1] < y0) y0 = tb[t * 6 + 1];
        if (tb[t * 6 + 2] < z0) z0 = tb[t * 6 + 2];
        if (tb[t * 6 + 3] > x1) x1 = tb[t * 6 + 3];
        if (tb[t * 6 + 4] > y1) y1 = tb[t * 6 + 4];
        if (tb[t * 6 + 5] > z1) z1 = tb[t * 6 + 5];
        if (cx[t] < mx0) mx0 = cx[t];
        if (cx[t] > mx1) mx1 = cx[t];
        if (cy[t] < my0) my0 = cy[t];
        if (cy[t] > my1) my1 = cy[t];
        if (cz[t] < mz0) mz0 = cz[t];
        if (cz[t] > mz1) mz1 = cz[t];
      }
      const b = node * 6;
      bounds[b] = x0; bounds[b + 1] = y0; bounds[b + 2] = z0;
      bounds[b + 3] = x1; bounds[b + 4] = y1; bounds[b + 5] = z1;
      const n = end - start;
      if (n <= 4) {
        first[node] = start;
        count[node] = n;
        return node;
      }
      const ex = mx1 - mx0, ey = my1 - my0, ez = mz1 - mz0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const c = cen[axis];
      const lo = axis === 0 ? mx0 : axis === 1 ? my0 : mz0;
      const extent = axis === 0 ? ex : axis === 1 ? ey : ez;
      let mid = (start + end) >> 1;
      if (extent > 1e-9) {
        // Binned SAH along the longest centroid axis.
        const k = (BINS * (1 - 1e-6)) / extent;
        binCount.fill(0);
        for (let i = 0; i < BINS; i++) {
          binBox[i * 6] = binBox[i * 6 + 1] = binBox[i * 6 + 2] = Infinity;
          binBox[i * 6 + 3] = binBox[i * 6 + 4] = binBox[i * 6 + 5] = -Infinity;
        }
        for (let i = start; i < end; i++) {
          const t = order[i];
          const bi = ((c[t] - lo) * k) | 0;
          binCount[bi]++;
          for (let d = 0; d < 3; d++) {
            if (tb[t * 6 + d] < binBox[bi * 6 + d]) binBox[bi * 6 + d] = tb[t * 6 + d];
            if (tb[t * 6 + 3 + d] > binBox[bi * 6 + 3 + d]) binBox[bi * 6 + 3 + d] = tb[t * 6 + 3 + d];
          }
        }
        let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
        let rc = 0;
        for (let i = BINS - 1; i > 0; i--) {
          if (binCount[i]) {
            rx0 = Math.min(rx0, binBox[i * 6]); ry0 = Math.min(ry0, binBox[i * 6 + 1]); rz0 = Math.min(rz0, binBox[i * 6 + 2]);
            rx1 = Math.max(rx1, binBox[i * 6 + 3]); ry1 = Math.max(ry1, binBox[i * 6 + 4]); rz1 = Math.max(rz1, binBox[i * 6 + 5]);
          }
          rc += binCount[i];
          rightArea[i] = rc ? halfArea(rx0, ry0, rz0, rx1, ry1, rz1) * rc : 0;
        }
        let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
        let lc = 0;
        let bestCost = Infinity;
        let bestBin = -1;
        for (let i = 0; i < BINS - 1; i++) {
          if (binCount[i]) {
            lx0 = Math.min(lx0, binBox[i * 6]); ly0 = Math.min(ly0, binBox[i * 6 + 1]); lz0 = Math.min(lz0, binBox[i * 6 + 2]);
            lx1 = Math.max(lx1, binBox[i * 6 + 3]); ly1 = Math.max(ly1, binBox[i * 6 + 4]); lz1 = Math.max(lz1, binBox[i * 6 + 5]);
          }
          lc += binCount[i];
          if (lc === 0 || lc === n) continue;
          const cost = halfArea(lx0, ly0, lz0, lx1, ly1, lz1) * lc + rightArea[i + 1];
          if (cost < bestCost) {
            bestCost = cost;
            bestBin = i;
          }
        }
        if (bestBin >= 0) {
          let i = start;
          let j = end - 1;
          while (i <= j) {
            if ((((c[order[i]] - lo) * k) | 0) <= bestBin) i++;
            else {
              const tmp = order[i];
              order[i] = order[j];
              order[j] = tmp;
              j--;
            }
          }
          if (i > start && i < end) mid = i;
        }
      }
      left[node] = build(start, mid);
      right[node] = build(mid, end);
      return node;
    };
    if (T > 0) build(0, T);

    const tri = new Float32Array(T * 9);
    for (let i = 0; i < T; i++) {
      const o = order[i] * 9;
      tri[i * 9] = P[o]; tri[i * 9 + 1] = P[o + 1]; tri[i * 9 + 2] = P[o + 2];
      tri[i * 9 + 3] = P[o + 3] - P[o]; tri[i * 9 + 4] = P[o + 4] - P[o + 1]; tri[i * 9 + 5] = P[o + 5] - P[o + 2];
      tri[i * 9 + 6] = P[o + 6] - P[o]; tri[i * 9 + 7] = P[o + 7] - P[o + 1]; tri[i * 9 + 8] = P[o + 8] - P[o + 2];
    }
    this.tri = tri;
    this.bounds = bounds;
    this.left = left;
    this.right = right;
    this.first = first;
    this.count = count;
  }

  /**
   * Distance to the nearest triangle hit (either side) along the ray within
   * (tMin, tMax), or tMax if nothing is hit. Stops early once a hit closer
   * than `tEnough` is known (the caller cannot tell such hits apart anyway).
   * `tMin` may be slightly negative to catch a surface the origin lies
   * exactly ON (returned as a hit at distance ≥ 0).
   */
  closestHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, tEnough: number, tMin = 0): number {
    const { tri, bounds, left, right, first, count, stack, stackT } = this;
    const ix = 1 / (dx === 0 ? 1e-30 : dx);
    const iy = 1 / (dy === 0 ? 1e-30 : dy);
    const iz = 1 / (dz === 0 ? 1e-30 : dz);
    let best = tMax;
    let sp = 0;
    stack[sp] = 0;
    stackT[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      if (stackT[sp] >= best) continue;
      const l = left[node];
      if (l >= 0) {
        // Slab-test both children; visit the nearer first so `best` shrinks
        // early and culls the farther one.
        const r = right[node];
        let tl = Infinity;
        let tr = Infinity;
        // (Written out twice on purpose: this is the bake's hot loop.)
        let b = l * 6;
        let t0 = (bounds[b] - ox) * ix;
        let t1 = (bounds[b + 3] - ox) * ix;
        let tmin = t0 < t1 ? t0 : t1;
        let tmax = t0 < t1 ? t1 : t0;
        t0 = (bounds[b + 1] - oy) * iy;
        t1 = (bounds[b + 4] - oy) * iy;
        let lo = t0 < t1 ? t0 : t1;
        let hi = t0 < t1 ? t1 : t0;
        if (lo > tmin) tmin = lo;
        if (hi < tmax) tmax = hi;
        t0 = (bounds[b + 2] - oz) * iz;
        t1 = (bounds[b + 5] - oz) * iz;
        lo = t0 < t1 ? t0 : t1;
        hi = t0 < t1 ? t1 : t0;
        if (lo > tmin) tmin = lo;
        if (hi < tmax) tmax = hi;
        if (tmax >= 0 && tmin <= tmax && tmin < best) tl = tmin;
        b = r * 6;
        t0 = (bounds[b] - ox) * ix;
        t1 = (bounds[b + 3] - ox) * ix;
        tmin = t0 < t1 ? t0 : t1;
        tmax = t0 < t1 ? t1 : t0;
        t0 = (bounds[b + 1] - oy) * iy;
        t1 = (bounds[b + 4] - oy) * iy;
        lo = t0 < t1 ? t0 : t1;
        hi = t0 < t1 ? t1 : t0;
        if (lo > tmin) tmin = lo;
        if (hi < tmax) tmax = hi;
        t0 = (bounds[b + 2] - oz) * iz;
        t1 = (bounds[b + 5] - oz) * iz;
        lo = t0 < t1 ? t0 : t1;
        hi = t0 < t1 ? t1 : t0;
        if (lo > tmin) tmin = lo;
        if (hi < tmax) tmax = hi;
        if (tmax >= 0 && tmin <= tmax && tmin < best) tr = tmin;
        if (tl <= tr) {
          if (tr < Infinity) { stack[sp] = r; stackT[sp++] = tr; }
          if (tl < Infinity) { stack[sp] = l; stackT[sp++] = tl; }
        } else {
          if (tl < Infinity) { stack[sp] = l; stackT[sp++] = tl; }
          stack[sp] = r; stackT[sp++] = tr;
        }
        continue;
      }
      for (let i = first[node], e = i + count[node]; i < e; i++) {
        const o = i * 9;
        // Möller–Trumbore, both sides.
        const e1x = tri[o + 3], e1y = tri[o + 4], e1z = tri[o + 5];
        const e2x = tri[o + 6], e2y = tri[o + 7], e2z = tri[o + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tri[o], sy = oy - tri[o + 1], sz = oz - tri[o + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin && t < best) {
          best = t > 0 ? t : 0;
          // det = −(direction · face normal): negative = hit from behind.
          this.hitBack = det < 0;
        }
      }
      if (best < tEnough) break;
    }
    return best;
  }
}

/** Van der Corput radical inverse — Halton(2, 3) gives a ray pattern whose
 * every PREFIX is evenly spread, which the adaptive probe below relies on. */
function radicalInverse(i: number, base: number): number {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * Bake ambient occlusion into the mesh's per-corner AO (→ uv2.x), replacing
 * any previous values. Returns timing / sample statistics.
 *   bakeAO(m, { ground: true });                       // props, buildings
 *   bakeAO(m, { rays: 8, maxDistance: 0.4 });          // quick, tight contact shading
 */
export function bakeAO(m: SolidMesh, o: AOOptions = {}): AOStats {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const T = m.triangleCount;
  if (T === 0) return { samples: 0, buried: 0, rays: 0, ms: 0 };
  const P = m.positions;
  const N = m.computeNormals();
  const NC = T * 3;
  const rays = Math.max(1, Math.round(o.rays ?? 16));
  const size = m.bounds().size;
  const extent = Math.max(size.x, size.y, size.z, 1e-6);
  const maxD = o.maxDistance ?? extent * 0.2;
  const strength = o.strength ?? 1;
  const floor = o.floor ?? 0.1;
  const ground = o.ground === true ? 0 : typeof o.ground === 'number' ? o.ground : null;
  // Start rays a hair off the surface so they cannot hit their own face.
  const bias = Math.max(extent * 2e-4, 1e-5);
  const rangeA = Math.max(0, Math.min(T, o.only ? o.only[0] : 0)) * 3;
  const rangeB = Math.max(0, Math.min(T, o.only ? o.only[1] : T)) * 3;
  const passes = Math.max(0, Math.round(o.smoothPasses ?? 1));

  // --- boot cache (off unless the game enabled it): the result depends on
  // exactly the positions, the shading normals, the weld (all derived from
  // the mesh) and the options, so their content hash is the key. Only the
  // baked range is stored; corners outside it keep their AO as below.
  let cacheKey: string | null = null;
  if (bakeStore.enabled) {
    const th = typeof performance !== 'undefined' ? performance.now() : Date.now();
    cacheKey = new ContentHash()
      .str('ao')
      .num(AO_BAKE_VERSION)
      .f64(P)
      .f32(N.normals)
      .i32(N.weld)
      .num(rays).num(maxD).num(strength).num(floor).num(ground ?? NaN).num(passes)
      .num(o.seed ?? 1).num(o.adaptive === false ? 0 : 1).num(rangeA).num(rangeB)
      .digest();
    bakeStore.hashMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - th;
    const hit = bakeStore.get(cacheKey);
    if (hit && hit.byteLength === (rangeB - rangeA + 3) * 4) {
      const v = new Float32Array(hit);
      const prev = m.cornerAO;
      const out = new Float32Array(NC);
      for (let c = 0; c < NC; c++) out[c] = c < rangeA || c >= rangeB ? prev[c] : v[3 + c - rangeA];
      m.writeAO(out);
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return { samples: v[0], buried: v[1], rays: v[2], ms: t1 - t0 };
    }
  }

  const bvh = new TriBVH(P, T);
  // A hit in the nearest tenth of the range is already ~full occlusion;
  // looking for an even nearer one is wasted work.
  const tEnough = maxD * 0.1;

  // --- sample points: one per distinct shading normal at each welded
  // position. Corners that shade together (a smooth surface) share a sample.
  const sampleOf = new Int32Array(NC).fill(-1);
  const sPos: number[] = [];
  const sNrm: number[] = [];
  const sFaceStart: number[] = [];
  const sFaces: number[] = [];
  {
    const local: number[] = [];
    const localFaces: number[][] = [];
    for (let w = 0; w < N.weldCount; w++) {
      local.length = 0;
      localFaces.length = 0;
      for (let i = N.cornerStart[w]; i < N.cornerStart[w + 1]; i++) {
        const c = N.cornerList[i];
        if (c < rangeA || c >= rangeB) continue;
        const nx = N.normals[c * 3], ny = N.normals[c * 3 + 1], nz = N.normals[c * 3 + 2];
        let found = -1;
        for (let k = 0; k < local.length; k++) {
          const s = local[k];
          if (sNrm[s * 3] * nx + sNrm[s * 3 + 1] * ny + sNrm[s * 3 + 2] * nz > 0.9995) {
            found = k;
            break;
          }
        }
        if (found < 0) {
          found = local.length;
          local.push(sPos.length / 3);
          localFaces.push([]);
          sPos.push(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
          sNrm.push(nx, ny, nz);
        }
        localFaces[found].push((c / 3) | 0);
        sampleOf[c] = local[found];
      }
      for (let k = 0; k < local.length; k++) {
        sFaceStart.push(sFaces.length);
        for (const f of localFaces[k]) sFaces.push(f);
      }
    }
    sFaceStart.push(sFaces.length);
  }
  const S = sPos.length / 3;
  const samplePos = new Float64Array(sPos);
  const sampleNrm = new Float64Array(sNrm);
  const faceStart = new Int32Array(sFaceStart);
  const faceList = new Int32Array(sFaces);

  // --- ray pattern: cosine-weighted hemisphere (Hammersley), local +z = normal
  const lx = new Float64Array(rays), ly = new Float64Array(rays), lz = new Float64Array(rays);
  for (let i = 0; i < rays; i++) {
    const u = radicalInverse(i + 1, 2);
    const a = 2 * Math.PI * radicalInverse(i + 1, 3);
    const r = Math.sqrt(u);
    lx[i] = r * Math.cos(a);
    ly[i] = r * Math.sin(a);
    lz[i] = Math.sqrt(Math.max(0, 1 - u));
  }

  const ao = new Float32Array(S);
  const SIN60 = Math.sqrt(3) / 2;
  let buried = 0;
  const probe = o.adaptive === false ? rays : Math.min(rays, 8);
  let traced = 0;
  const fn = N.faceNormals;
  let h = ((o.seed ?? 1) * 0x9e3779b9) >>> 0;
  const isBuried = new Uint8Array(S);

  // Results of the last `fan` call.
  let fanHits = 0;
  let fanBack = 0;
  let fanSpin = 0;
  let b1x = 0, b1y = 0, b1z = 0, b2x = 0, b2y = 0, b2z = 0;
  /**
   * Trace the ray fan around normal (nx, ny, nz) from point (px, py, pz) and
   * return the occluded fraction 0..1. Rays that dip below any of the faces
   * faceList[f0..f1) — or below the single face `own` when f0 = f1 — count
   * as open (see below).
   */
  const fan = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, f0: number, f1: number, own: number): number => {
    const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
    // A point at or under the ground plane (the skirt every prop is told to
    // have) would see no ground at all — the plane is above it — and bake
    // fully open, brightening the wall TOWARD its contact line. It stands
    // for the ground line of the face it belongs to: test the ground from
    // just above the plane.
    const gy = ground !== null && oy < ground + bias ? ground + bias : oy;
    // Orthonormal basis around the normal (Duff et al.), spun by a per-sample
    // angle so neighbouring vertices do not share ray directions (shared
    // directions would show as banding).
    const sign = nz >= 0 ? 1 : -1;
    const ka = -1 / (sign + nz);
    const kb = nx * ny * ka;
    b1x = 1 + sign * nx * nx * ka; b1y = sign * kb; b1z = -sign * nx;
    b2x = kb; b2y = sign + ny * ny * ka; b2z = -ny;
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    const spin = (h / 4294967296) * Math.PI * 2;
    fanSpin = spin;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    let occ = 0;
    let used = rays;
    fanHits = 0;
    fanBack = 0;
    for (let i = 0; i < rays; i++) {
      // Adaptive probe: when the first few (evenly spread) rays all escape,
      // the point is open — most of a model's surface is — and the rest of
      // the fan would only confirm it.
      if (i === probe && occ === 0) {
        used = probe;
        break;
      }
      const rx = lx[i] * cs - ly[i] * sn;
      const ry = lx[i] * sn + ly[i] * cs;
      const dx = b1x * rx + b2x * ry + nx * lz[i];
      const dy = b1y * rx + b2y * ry + ny * lz[i];
      const dz = b1z * rx + b2z * ry + nz * lz[i];
      // A smooth normal's hemisphere dips below the flat faces around it;
      // such rays would hit the sample's own faces at once and darken every
      // convex edge of a coarse mesh. They see open space on the true
      // (curved) surface, so they count as open.
      let below = false;
      if (f1 > f0) {
        for (let f = f0; f < f1; f++) {
          const t = faceList[f];
          if (dx * fn[t * 3] + dy * fn[t * 3 + 1] + dz * fn[t * 3 + 2] < 1e-3) {
            below = true;
            break;
          }
        }
      } else if (own >= 0) {
        below = dx * fn[own * 3] + dy * fn[own * 3 + 1] + dz * fn[own * 3 + 2] < 1e-3;
      }
      if (below) continue;
      let tHit = maxD;
      if (ground !== null && dy < -1e-9) {
        const tg = (ground - gy) / dy;
        if (tg >= 0 && tg < tHit) tHit = tg;
      }
      if (tHit > tEnough) {
        // Half a bias of negative reach: a part RESTING on another (a box
        // on a slab at the same height — the commonest joint of all) has its
        // base vertices exactly in the other part's surface plane, where a
        // strict t > 0 misses that surface and the ray sails on through the
        // solid. Its own faces are a full bias behind the origin, out of
        // reach.
        const tMesh = bvh.closestHit(ox, oy, oz, dx, dy, dz, tHit, tEnough, -bias * 0.5);
        if (tMesh < tHit) {
          tHit = tMesh;
          fanHits++;
          if (bvh.hitBack) fanBack++;
        }
      }
      traced++;
      if (tHit < maxD) occ += 1 - tHit / maxD;
    }
    return occ / used;
  };

  for (let s = 0; s < S; s++) {
    const nx = sampleNrm[s * 3], ny = sampleNrm[s * 3 + 1], nz = sampleNrm[s * 3 + 2];
    const px = samplePos[s * 3], py = samplePos[s * 3 + 1], pz = samplePos[s * 3 + 2];
    const occ = fan(px, py, pz, nx, ny, nz, faceStart[s], faceStart[s + 1], -1);
    // Buried vertices. Parts are routinely pushed INTO each other (a wall up
    // into its roof, a tube into a body), which leaves vertices inside a
    // neighbouring solid: every ray then hits that solid from the inside.
    // When most hits were back faces, test properly: four LONG rays — the
    // normal and three more tilted 60° around it, so none dives back into
    // the vertex's own surface. Inside a closed solid they all exit through
    // a back face; a vertex merely resting on another part sees at most half
    // of them do so.
    if (fanBack > 0 && fanBack * 2 >= fanHits) {
      const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
      let inside = 0;
      for (let k = 0; k < 4; k++) {
        let tx = nx, ty = ny, tz = nz;
        if (k > 0) {
          const a = fanSpin + (k * 2 * Math.PI) / 3;
          const ca = Math.cos(a) * SIN60, sa = Math.sin(a) * SIN60;
          tx = nx * 0.5 + b1x * ca + b2x * sa;
          ty = ny * 0.5 + b1y * ca + b2y * sa;
          tz = nz * 0.5 + b1z * ca + b2z * sa;
        }
        if (bvh.closestHit(ox, oy, oz, tx, ty, tz, Infinity, 0) < Infinity && bvh.hitBack) inside++;
        traced++;
      }
      if (inside >= 3) {
        isBuried[s] = 1;
        buried++;
        ao[s] = 1; // replaced below
        continue;
      }
    }
    ao[s] = 1 - occ * strength;
  }

  // --- buried corners: a value at the vertex itself would be meaningless
  // (black from inside the other solid) and "open" is wrong too — it is
  // interpolated across the visible part of every face using the vertex and
  // BRIGHTENS it toward the joint. What is visible of such a face starts
  // where its edges come out of the other solid, so that is where it is
  // sampled: walk each edge from the buried corner, find the exit (the
  // first surface hit from inside), bake there with the face's own normal.
  // AO is stored per corner, so every face gets its own value.
  const cornerOverride = buried > 0 ? new Float32Array(NC).fill(-1) : null;
  if (cornerOverride) {
    const sum = new Float32Array(S);
    const cnt = new Float32Array(S);
    for (let c = rangeA; c < rangeB; c++) {
      const s = sampleOf[c];
      if (s < 0 || !isBuried[s]) continue;
      const t = (c / 3) | 0;
      const px = P[c * 3], py = P[c * 3 + 1], pz = P[c * 3 + 2];
      const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2];
      let acc = 0;
      let got = 0;
      for (let k = 1; k < 3; k++) {
        const q = t * 3 + ((c - t * 3 + k) % 3);
        const sq = sampleOf[q];
        if (sq >= 0 && isBuried[sq]) continue; // the whole edge is hidden
        let dx = P[q * 3] - px, dy = P[q * 3 + 1] - py, dz = P[q * 3 + 2] - pz;
        const len = Math.hypot(dx, dy, dz);
        if (len < bias * 4) continue;
        dx /= len; dy /= len; dz /= len;
        // Lifted a hair off the face so the ray cannot graze its neighbours.
        const ox = px + fx * bias, oy = py + fy * bias, oz = pz + fz * bias;
        const te = bvh.closestHit(ox, oy, oz, dx, dy, dz, len, 0);
        traced++;
        if (!(te < len) || !bvh.hitBack) continue;
        const step = Math.min(te + bias * 8, len);
        acc += 1 - fan(px + dx * step, py + dy * step, pz + dz * step, fx, fy, fz, 0, 0, t) * strength;
        got++;
      }
      if (got > 0) {
        const v = acc / got;
        cornerOverride[c] = v;
        sum[s] += v;
        cnt[s]++;
      }
    }
    // The sample's own value only feeds the smoothing of its neighbours.
    for (let s = 0; s < S; s++) if (isBuried[s]) ao[s] = cnt[s] > 0 ? sum[s] / cnt[s] : 1;
  }

  // --- smoothing: average each sample with the samples it shares triangles
  // with. Samples across a hard edge are different samples and never share
  // a triangle corner, so creases stay crisp. A neighbour counts less the
  // farther away it is and not at all beyond the occlusion range: without
  // that, the dark foot of a 2 m wall made of two triangles would bleed all
  // the way up to its top edge.
  if (passes > 0) {
    const sum = new Float32Array(S);
    const wsum = new Float32Array(S);
    const cnt = new Float32Array(S);
    for (let pass = 0; pass < passes; pass++) {
      sum.fill(0);
      wsum.fill(0);
      cnt.fill(0);
      for (let c = rangeA; c < rangeB; c++) {
        const t3 = ((c / 3) | 0) * 3;
        const d = t3 + ((c - t3 + 1) % 3);
        const a = sampleOf[c], b = sampleOf[d];
        const len = Math.hypot(P[c * 3] - P[d * 3], P[c * 3 + 1] - P[d * 3 + 1], P[c * 3 + 2] - P[d * 3 + 2]);
        const w = len >= maxD ? 0 : 1 - len / maxD;
        sum[a] += ao[b] * w;
        sum[b] += ao[a] * w;
        wsum[a] += w;
        wsum[b] += w;
        cnt[a]++;
        cnt[b]++;
      }
      // With every neighbour close by this is the plain half-and-half blend.
      for (let s = 0; s < S; s++) if (cnt[s] > 0) ao[s] = (ao[s] * cnt[s] + sum[s]) / (cnt[s] + wsum[s]);
    }
  }

  const prev = m.cornerAO;
  const out = new Float32Array(NC);
  for (let c = 0; c < NC; c++) {
    if (c < rangeA || c >= rangeB) {
      out[c] = prev[c];
      continue;
    }
    let v = ao[sampleOf[c]];
    // A buried corner: its own contact-line value, eased toward the
    // smoothed neighbourhood like everything else.
    if (cornerOverride && cornerOverride[c] >= 0) v = passes > 0 ? (cornerOverride[c] + v) / 2 : cornerOverride[c];
    out[c] = v < floor ? floor : v > 1 ? 1 : v;
  }
  m.writeAO(out);
  if (cacheKey !== null) {
    const rec = new Float32Array(rangeB - rangeA + 3);
    rec[0] = S;
    rec[1] = buried;
    rec[2] = traced;
    rec.set(out.subarray(rangeA, rangeB), 3);
    bakeStore.put(cacheKey, 'ao', rec.buffer);
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { samples: S, buried, rays: traced, ms: t1 - t0 };
}
