import type { Vec2 } from './math';

/**
 * 2D polygon utilities: signed area, ear-clip triangulation with holes, and
 * miter offsetting. Pure arithmetic on `[x, y]` tuples. "CCW" always means
 * counter-clockwise with x to the right and y up, i.e. POSITIVE signed area.
 */

/** Shoelace area: positive for a counter-clockwise ring. */
export function signedArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Drop consecutive duplicate points (and a closing point equal to the first).
 * Generators such as a zero-radius rounded rectangle emit them, and they
 * would otherwise make zero-length edges that break ear tests and miters.
 */
export function dedupeRing(ring: readonly Vec2[], eps = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) <= eps && Math.abs(q[1] - p[1]) <= eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
    else break;
  }
  return out;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  // Inclusive of the edges: a vertex sitting ON a candidate ear's edge still
  // blocks it, otherwise the ear would slice through a touching feature.
  const e = -1e-12;
  return cross(a, b, p) >= e && cross(b, c, p) >= e && cross(c, a, p) >= e;
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
}

/**
 * Splice one hole into the outer index loop with a two-way bridge (Eberly's
 * method): from the hole's right-most vertex shoot a ray toward +x, take the
 * nearest outer edge it hits, and connect to a vertex on that edge that is
 * mutually visible.
 */
function bridgeHole(pts: readonly Vec2[], outer: number[], hole: number[]): number[] {
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (pts[hole[i]][0] > pts[hole[hi]][0]) hi = i;
  const M = pts[hole[hi]];

  let bestX = Infinity;
  let bestEdge = -1;
  for (let i = 0, n = outer.length; i < n; i++) {
    const a = pts[outer[i]];
    const b = pts[outer[(i + 1) % n]];
    // Only edges crossing the ray's line UPWARD: the loop is counter-
    // clockwise, so those are the ones whose interior (left) side faces the
    // ray's origin. A bridge to an earlier hole is in the loop twice, once
    // in each direction; taking the downward copy would splice this hole in
    // at the wrong visit of the shared vertex and the two bridges would
    // cross (overlapping, inside-out cap triangles on any wall with a door
    // and a window at different heights).
    if (!(a[1] <= M[1] && b[1] > M[1])) continue;
    const x = a[0] + ((M[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    if (x >= M[0] - 1e-12 && x < bestX) {
      bestX = x;
      bestEdge = i;
    }
  }
  let target: number;
  if (bestEdge < 0) {
    // Hole outside the outline (bad input): bridge to the nearest vertex so
    // the result is still a single loop.
    target = 0;
    let bd = Infinity;
    for (let i = 0; i < outer.length; i++) {
      const p = pts[outer[i]];
      const d = (p[0] - M[0]) ** 2 + (p[1] - M[1]) ** 2;
      if (d < bd) {
        bd = d;
        target = i;
      }
    }
  } else {
    const n = outer.length;
    const ia = bestEdge;
    const ib = (bestEdge + 1) % n;
    target = pts[outer[ia]][0] > pts[outer[ib]][0] ? ia : ib;
    const P = pts[outer[target]];
    const I: Vec2 = [bestX, M[1]];
    // A reflex outer vertex inside triangle (M, I, P) hides P from M; the one
    // making the smallest angle with the ray is visible instead.
    let bestTan = Infinity;
    let bestDist = Infinity;
    const cand = target;
    for (let i = 0; i < n; i++) {
      if (i === cand) continue;
      const q = pts[outer[i]];
      if (samePoint(q, P)) continue;
      if (q[0] < M[0]) continue;
      const inside = M[1] < P[1] ? pointInTriangle(q, M, I, P) : pointInTriangle(q, M, P, I);
      if (!inside) continue;
      const prev = pts[outer[(i + n - 1) % n]];
      const next = pts[outer[(i + 1) % n]];
      if (cross(prev, q, next) >= 0) continue; // convex vertex cannot occlude
      const dx = q[0] - M[0];
      const t = Math.abs(q[1] - M[1]) / Math.max(dx, 1e-12);
      const d = dx * dx + (q[1] - M[1]) ** 2;
      if (t < bestTan - 1e-12 || (Math.abs(t - bestTan) <= 1e-12 && d < bestDist)) {
        bestTan = t;
        bestDist = d;
        target = i;
      }
    }
  }

  const out: number[] = [];
  for (let i = 0; i <= target; i++) out.push(outer[i]);
  for (let k = 0; k <= hole.length; k++) out.push(hole[(hi + k) % hole.length]);
  for (let i = target; i < outer.length; i++) out.push(outer[i]);
  return out;
}

function earClip(pts: readonly Vec2[], loop: number[]): number[] {
  const tris: number[] = [];
  const poly = loop.slice();
  let guard = poly.length * poly.length + 16;
  while (poly.length > 3 && guard-- > 0) {
    const n = poly.length;
    let clipped = false;
    let fallback = -1;
    let fallbackCross = -Infinity;
    let flattest = -1;
    let flattestCross = Infinity;
    for (let i = 0; i < n; i++) {
      const ia = poly[(i + n - 1) % n];
      const ib = poly[i];
      const ic = poly[(i + 1) % n];
      const a = pts[ia];
      const b = pts[ib];
      const c = pts[ic];
      const cr = cross(a, b, c);
      if (cr > fallbackCross) {
        fallbackCross = cr;
        fallback = i;
      }
      if (Math.abs(cr) < flattestCross) {
        flattestCross = Math.abs(cr);
        flattest = i;
      }
      // Reflex OR collinear: not an ear. A vertex lying on a straight edge is
      // deliberately kept — it becomes the corner of a later ear, so the
      // triangulation uses every outline vertex and stays crack-free against
      // the side walls that also use it (no T-junctions).
      if (cr <= 1e-14) continue;
      let ear = true;
      for (let k = 0; k < n; k++) {
        const ik = poly[k];
        if (ik === ia || ik === ib || ik === ic) continue;
        const p = pts[ik];
        // Bridge duplicates share coordinates with a corner; they are not
        // obstacles.
        if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) continue;
        if (pointInTriangle(p, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(ia, ib, ic);
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      const n2 = poly.length;
      if (flattest >= 0 && flattestCross <= 1e-14) {
        // Only collinear / duplicate vertices block progress (the remainder
        // has collapsed to a line): drop one without a triangle.
        poly.splice(flattest, 1);
      } else {
        // Numerically stuck (self-touching input): cut the most convex corner
        // anyway so the routine always terminates with full coverage.
        const i = Math.max(fallback, 0);
        tris.push(poly[(i + n2 - 1) % n2], poly[i], poly[(i + 1) % n2]);
        poly.splice(i, 1);
      }
    }
  }
  if (poly.length === 3 && Math.abs(cross(pts[poly[0]], pts[poly[1]], pts[poly[2]])) > 1e-14) tris.push(poly[0], poly[1], poly[2]);
  return tris;
}

export interface Triangulation {
  /** All input points: the outline first, then each hole, in input order. */
  points: Vec2[];
  /** Index triples into `points`, every triangle counter-clockwise. */
  triangles: number[];
}

/**
 * Triangulate a simple polygon with optional holes (ear clipping, then
 * Delaunay edge flips so the triangles are as fat as the outline allows).
 * Input rings may be wound either way (they are normalised internally) and
 * must not self-intersect; holes must lie inside the outline and not touch
 * each other. Output triangles are always CCW (positive area) and use every
 * outline vertex, so the result is crack-free against side walls.
 */
export function triangulate(outline: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): Triangulation {
  const points: Vec2[] = [];
  const ringIndices = (ring: readonly Vec2[], wantCCW: boolean): number[] => {
    const base = points.length;
    const idx: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      points.push(ring[i]);
      // Skip consecutive duplicates in the index loop (points stay, so the
      // caller's indexing by input order is preserved).
      const prev = idx.length ? points[idx[idx.length - 1]] : null;
      if (prev && samePoint(prev, ring[i])) continue;
      idx.push(base + i);
    }
    while (idx.length > 1 && samePoint(points[idx[0]], points[idx[idx.length - 1]])) idx.pop();
    const area = signedArea(idx.map((i) => points[i]));
    if (area > 0 !== wantCCW) idx.reverse();
    return idx;
  };

  let loop = ringIndices(outline, true);
  const holeLoops = holes.map((h) => ringIndices(h, false)).filter((h) => h.length >= 3);
  // Right-most hole first, so each bridge lands on outline that is already
  // final (a later hole can bridge to an earlier hole through the loop).
  holeLoops.sort((a, b) => {
    const ax = Math.max(...a.map((i) => points[i][0]));
    const bx = Math.max(...b.map((i) => points[i][0]));
    return bx - ax;
  });
  // Outline and hole edges are fixed; everything else the ear clipper made
  // (bridges included) may be re-arranged by the Delaunay pass.
  const fixed = new Set<number>();
  const K = points.length + 1;
  const pin = (ring: number[]): void => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      fixed.add(a < b ? a * K + b : b * K + a);
    }
  };
  pin(loop);
  for (const h of holeLoops) pin(h);
  for (const h of holeLoops) loop = bridgeHole(points, loop, h);
  if (loop.length < 3) return { points, triangles: [] };
  const triangles = earClip(points, loop);
  delaunayFlips(points, triangles, fixed, K);
  return { points, triangles };
}

/**
 * Lawson edge flips: turns the ear clipper's output — long slivers fanning
 * from whichever corner it started at — into the constrained Delaunay
 * triangulation (the one with the fattest triangles the fixed outline
 * allows). It matters because per-vertex effects are interpolated across
 * these triangles: slivers smear a bevel's normals and baked AO in streaks
 * right across a flat wall.
 */
function delaunayFlips(pts: readonly Vec2[], tris: number[], fixed: Set<number>, K: number): void {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < tris.length; i++) {
    const p = pts[tris[i]];
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const span2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  // Strictly inside by a margin: four cocircular points (every rectangle)
  // must not flip back and forth for ever.
  const inEps = 1e-9 * span2 * span2;
  const areaEps = 1e-12 * span2;
  const T = tris.length / 3;
  const edgeOwner = new Map<number, number>();
  const dirty = new Uint8Array(T);
  for (let pass = 0, maxPass = 8 * T + 8; pass < maxPass; pass++) {
    edgeOwner.clear();
    dirty.fill(0);
    let flipped = false;
    for (let t = 0; t < T; t++) {
      for (let e = 0; e < 3 && !dirty[t]; e++) {
        const a = tris[t * 3 + e];
        const b = tris[t * 3 + ((e + 1) % 3)];
        const k = a < b ? a * K + b : b * K + a;
        if (fixed.has(k)) continue;
        const other = edgeOwner.get(k);
        if (other === undefined) {
          edgeOwner.set(k, t * 3 + e);
          continue;
        }
        const t2 = (other / 3) | 0;
        if (dirty[t2] || t2 === t) continue;
        const c = tris[t * 3 + ((e + 2) % 3)];
        const d = tris[t2 * 3 + (((other % 3) + 2) % 3)];
        const A = pts[a], B = pts[b], C = pts[c], D = pts[d];
        const ax = A[0] - D[0], ay = A[1] - D[1];
        const bx = B[0] - D[0], by = B[1] - D[1];
        const cx = C[0] - D[0], cy = C[1] - D[1];
        const det =
          (ax * ax + ay * ay) * (bx * cy - by * cx) -
          (bx * bx + by * by) * (ax * cy - ay * cx) +
          (cx * cx + cy * cy) * (ax * by - ay * bx);
        if (det <= inEps) continue;
        // The quad a → d → b → c must be strictly convex for the other
        // diagonal to lie inside it.
        if (cross(A, D, C) <= areaEps || cross(D, B, C) <= areaEps) continue;
        tris[t * 3] = a; tris[t * 3 + 1] = d; tris[t * 3 + 2] = c;
        tris[t2 * 3] = d; tris[t2 * 3 + 1] = b; tris[t2 * 3 + 2] = c;
        dirty[t] = dirty[t2] = 1;
        flipped = true;
      }
    }
    if (!flipped) break;
  }
}

/**
 * Offset a ring toward its LEFT side by `distance` (miter joins, miter length
 * capped at 3× so needle corners cannot shoot off). For a CCW ring left is
 * INWARD — a positive distance shrinks it; for a CW ring (a hole) left is
 * outward of the hole, i.e. into the material — the same call insets both
 * correctly. Negative distances grow a CCW ring. Vertex count is preserved,
 * so the result can be stitched to the input point-for-point. No
 * self-intersection clean-up: keep `distance` below the narrowest feature.
 */
export function offsetRing(ring: readonly Vec2[], distance: number): Vec2[] {
  const n = ring.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    // Skip over duplicate neighbours so a zero-length edge does not produce a
    // garbage direction.
    let a = ring[(i + n - 1) % n];
    for (let k = 2; k < n && samePoint(a, p); k++) a = ring[(i + n - k) % n];
    let b = ring[(i + 1) % n];
    for (let k = 2; k < n && samePoint(b, p); k++) b = ring[(i + k) % n];
    let d0x = p[0] - a[0];
    let d0y = p[1] - a[1];
    let d1x = b[0] - p[0];
    let d1y = b[1] - p[1];
    const l0 = Math.hypot(d0x, d0y) || 1;
    const l1 = Math.hypot(d1x, d1y) || 1;
    d0x /= l0;
    d0y /= l0;
    d1x /= l1;
    d1y /= l1;
    // Left normals of the two edges.
    const n0x = -d0y;
    const n0y = d0x;
    const n1x = -d1y;
    const n1y = d1x;
    const k = 1 + n0x * n1x + n0y * n1y;
    const s = distance / Math.max(k, 2 / 9); // |miter| = d·sqrt(2/k) ≤ 3d
    out.push([p[0] + (n0x + n1x) * s, p[1] + (n0y + n1y) * s]);
  }
  return out;
}
