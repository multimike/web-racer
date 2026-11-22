import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import { toRGB } from './color';
import type { RGB } from './color';
import { DEG, mirroring, rotation, toV3, translation } from './math';
import type { Vec2, Vec3 } from './math';
import { triangulate } from './triangulate';

/**
 * SolidMesh — the geometry accumulator every car, prop and building is
 * authored with. It is a triangle soup with a PAINT per face; smooth or
 * faceted normals, vertex welding and the index buffer are all worked out
 * when the mesh is finalized, so authoring code never manages vertices,
 * normals or indices.
 *
 * OUTPUT VERTEX FORMAT (see the art brief):
 *   position (3)   meters
 *   normal   (3)   smooth or faceted per face, from the paint's crease angle
 *   color    (4)   rgb = base colour (sRGB 0..1), a = EMISSIVE amount (0 lit,
 *                  1 full glow) — NOT opacity
 *   uv       (2)   x = gloss 0..1, y = metal 0..1
 *   uv2      (2)   x = baked ambient occlusion (1 = open), y = wind weight
 *
 * WINDING — the one rule: a triangle (a, b, c) faces the direction of
 * (b − a) × (c − a) (plain coordinate cross product). That must point OUT of
 * the solid. Quads, fans and polygons follow the same rule in their listed
 * order. (In Babylon's left-handed view such a face LOOKS clockwise from
 * outside; do not reason about clockwise, use the cross product — or the
 * shape helpers, which all get it right for you.) The index buffer is emitted
 * reversed because Babylon's default front face is the opposite order; that
 * is handled in `toVertexData`, never by authors.
 *
 * PAINT = colour + gloss + metal + emissive + `smooth`, the crease angle in
 * degrees: an EDGE whose two faces differ by less than it is smooth, a
 * sharper edge stays crisp. 0 = faceted (rocks, foliage), 180 = always
 * smooth, default 40 (rounded forms smooth, box edges and roof ridges
 * crisp). Faces are matched by POSITION, not by paint, so two faces with
 * different colours on the same smooth surface still shade as one surface —
 * the colour boundary is crisp, the shading is unbroken. Parts that merely
 * touch (no shared edge) never smooth into each other. Weights are face area
 * × corner angle, so a large flat panel next to a small bevel stays visually
 * flat (the "weighted normals" trick that makes bevelled toy edges read
 * properly).
 *
 * EXPLICIT NORMALS. Normals are normally derived from geometry as above, but
 * a corner can also carry a PINNED normal. Two things use that: shape
 * helpers that know their exact surface (roundedBox, cylinder / frustum,
 * sphere — their flat faces come out exactly flat and their rounding exactly
 * round at any segment count), and every operation that re-triangulates an
 * existing surface (`tessellate`, the region paints in regions.ts), which
 * pins the surface's normals first and interpolates them onto the new
 * vertices so the split leaves no mark in the shading. Pinned normals follow
 * transforms and mirrors; `displace` and a change of crease angle drop them.
 * A pinned corner still BLENDS with unpinned faces welded on later (a
 * mirrored half, a neighbouring part), by voting with its pinned vector in
 * the smoothing group — so seams stay smooth. Authors never deal with any of
 * this; it is why "tessellate for AO" and "paint a stripe" are free.
 *
 * Geometry never needs a Babylon Scene until `build()`.
 *
 * WORKED EXAMPLE — a rounded-edge toy house in ~20 lines:
 *
 *   import { SolidMesh, paint, roundedBox, extrudePolygon, cylinder, box } from '../../gfx/solid';
 *
 *   const WALL = paint('#F4E3C4', { gloss: 0.15 });           // cream plaster
 *   const ROOF = paint('#F16B59', { gloss: 0.35 });           // coral tiles
 *   const TRIM = paint('#AD6338');                            // timber
 *   const GLOW = paint('#FFD9A0', { emissive: 0.8 });         // lit window
 *
 *   const m = new SolidMesh();
 *   // walls: 4 × 2.4 × 3 m, standing on y = 0, 8 cm rounded edges
 *   roundedBox(m, { size: [4, 2.4, 3], radius: 0.08, at: [0, 1.2, 0] }, WALL);
 *   // roof: a gable triangle in XY extruded 3.4 m along z, bevelled eaves
 *   extrudePolygon(m, {
 *     outline: [[-2.3, 2.3], [2.3, 2.3], [0, 4.0]],
 *     depth: 3.4, bevel: 0.05, bevelBack: true, at: [0, 0, -1.7],
 *   }, ROOF);
 *   // door slab and a glowing window, proud of the front wall (front = −z)
 *   box(m, { size: [0.9, 1.9, 0.08], at: [-0.9, 0.95, -1.52] }, TRIM);
 *   box(m, { size: [0.9, 0.9, 0.06], at: [0.9, 1.4, -1.52] }, GLOW);
 *   // chimney between two points
 *   cylinder(m, { from: [1.2, 3.0, 0.6], to: [1.2, 4.3, 0.6], radius: 0.22, sides: 10, bevel: 0.04 }, WALL);
 *   // warm tops / cool undersides are a colour post-pass, not separate faces
 *   m.recolor((_p, n, c) => (n.y > 0.5 ? [c[0] * 1.06, c[1] * 1.04, c[2]] : c));
 *   return m;   // an asset builder stops here: the assembler bakes the AO
 *   // (stand-alone use: bakeAO(m, { ground: true }); m.build('house', scene);)
 */

// ---------------------------------------------------------------------------
// Paint

/** Face material. Create with `paint()`; treat as immutable. */
export interface Paint {
  /** Base colour, sRGB 0..1. */
  readonly color: RGB;
  /** 0 chalk-matte … 1 glossy toy paint. */
  readonly gloss: number;
  /** 0 dielectric … 1 brushed/chrome metal look. */
  readonly metal: number;
  /** 0 lit normally … 1 full glow (lamps, emissive trims). */
  readonly emissive: number;
  /**
   * Crease angle in DEGREES. 0 = faceted (every face flat); N = smooth across
   * edges whose two face normals differ by less than N°; 180 = always smooth.
   * On an edge between faces with different values the SMALLER one applies.
   */
  readonly smooth: number;
}

export interface PaintOptions {
  color?: string | RGB;
  gloss?: number;
  metal?: number;
  emissive?: number;
  smooth?: number;
}

/**
 * Crease angle used when a paint does not say. 40° keeps the edges that
 * should read as edges crisp — roof ridges and eaves, octagonal plans, box
 * corners — while anything tessellated at 10+ segments per turn is smooth.
 * Round helpers called with FEWER segments (an 8-sided tube, a one-segment
 * chamfer) raise the angle for their own faces just enough to stay smooth —
 * see `soften` — so low-poly round parts never come out accidentally faceted.
 */
export const DEFAULT_SMOOTH = 40;

/**
 * Return `p` with its crease angle raised (never lowered) so that a round
 * surface tessellated in steps of `stepDeg` degrees between neighbouring
 * faces still shades smooth. A faceted paint (smooth 0) is returned
 * unchanged — faceted stays faceted — and the result is capped at 80° so
 * right-angle edges (caps, mitre kinks) always stay crisp. The round shape
 * helpers apply this to their own faces; use it in custom shape code that
 * builds a curve from a few segments.
 */
export function soften(p: Paint, stepDeg: number): Paint {
  if (p.smooth <= 0) return p;
  const need = Math.min(stepDeg * 1.15 + 2, 80);
  return need > p.smooth ? { ...p, smooth: need } : p;
}

/**
 * Make a Paint.
 *   paint('#04B9BE', { gloss: 0.8, smooth: 60 })   from a hex string
 *   paint(PALETTE.cream)                            from an RGB tuple
 *   paint(BODY, { color: '#FF6373' })               derive from another paint
 * Defaults: gloss 0.3, metal 0, emissive 0, smooth 40°. Pass `smooth: 0` for
 * faceted rock/foliage facets.
 */
export function paint(base: string | RGB | Paint, opts: PaintOptions = {}): Paint {
  const from: Paint | null =
    typeof base === 'object' && !Array.isArray(base) && 'color' in (base as object) ? (base as Paint) : null;
  const color = opts.color !== undefined ? toRGB(opts.color) : from ? from.color : toRGB(base as string | RGB);
  return {
    color,
    gloss: opts.gloss ?? from?.gloss ?? 0.3,
    metal: opts.metal ?? from?.metal ?? 0,
    emissive: opts.emissive ?? from?.emissive ?? 0,
    smooth: opts.smooth ?? from?.smooth ?? DEFAULT_SMOOTH,
  };
}

/** A paint, or a function choosing one per patch; returning null leaves the
 * patch OPEN (a hole). `i` runs along the shape (band / station), `j` around
 * it (segment); see each helper for the exact meaning. */
export type PaintLike = Paint | ((i: number, j: number) => Paint | null);

/** Resolve a PaintLike for patch (i, j). */
export function pickPaint(p: PaintLike, i: number, j: number): Paint | null {
  return typeof p === 'function' ? p(i, j) : p;
}

/**
 * `soften` for a paint OR a paint-choosing function of any arity: the
 * returned value yields softened paints (cached per Paint object, so a
 * function returning the same few paints allocates nothing per face).
 */
export function softenPaint<A extends unknown[]>(
  p: Paint | ((...args: A) => Paint | null),
  stepDeg: number,
): Paint | ((...args: A) => Paint | null) {
  if (typeof p !== 'function') return soften(p, stepDeg);
  const cache = new Map<Paint, Paint>();
  return (...args: A): Paint | null => {
    const q = p(...args);
    if (!q) return null;
    let s = cache.get(q);
    if (!s) {
      s = soften(q, stepDeg);
      cache.set(q, s);
    }
    return s;
  };
}

// ---------------------------------------------------------------------------
// Finalized data

/** Per-corner analysis of a SolidMesh (corner k of triangle t = 3·t + k). */
export interface SolidNormals {
  /** Welded-position id of each corner. */
  weld: Int32Array;
  weldCount: number;
  /** Shading normal of each corner (xyz), unit length. */
  normals: Float32Array;
  /** Unit geometric normal of each triangle (xyz). */
  faceNormals: Float32Array;
  /** Area of each triangle, m². */
  faceAreas: Float32Array;
  /** CSR adjacency: corners of weld id w are
   * cornerList[cornerStart[w] .. cornerStart[w + 1]). */
  cornerStart: Int32Array;
  cornerList: Int32Array;
}

/** Indexed buffers in the brief's vertex format, ready for the GPU. */
export interface SolidVertexData {
  positions: Float32Array;
  normals: Float32Array;
  /** rgba, a = emissive. */
  colors: Float32Array;
  /** [gloss, metal]. */
  uvs: Float32Array;
  /** [ao, wind]. */
  uvs2: Float32Array;
  /** Already in Babylon's (reversed) order. */
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface Bounds {
  min: Vector3;
  max: Vector3;
  size: Vector3;
  center: Vector3;
}

const cx = (p: Vec3): number => (p instanceof Vector3 ? p.x : p[0]);
const cy = (p: Vec3): number => (p instanceof Vector3 ? p.y : p[1]);
const cz = (p: Vec3): number => (p instanceof Vector3 ? p.z : p[2]);

export class SolidMesh {
  /**
   * Positions closer than this (meters) are treated as the same point when
   * normals are smoothed and vertices shared. 0.01 mm: far below any modelled
   * detail, far above float noise from differently-ordered arithmetic.
   */
  weldTolerance = 1e-5;

  // Triangle soup. Per triangle: 9 position floats, 9 colour floats (rgb per
  // corner, so gradients are possible), 4 surface floats (gloss, metal,
  // emissive, smooth), 3 AO and 3 wind floats (per corner).
  private P: number[] = [];
  private C: number[] = [];
  private S: number[] = [];
  private A: number[] = [];
  private W: number[] = [];
  // Optional EXPLICIT shading normals, 9 floats per triangle; (0, 0, 0) =
  // "derive from geometry". Written by the operations that re-triangulate an
  // existing surface (tessellate, the region-paint cuts) so the shading the
  // surface had before the split survives it exactly — see `analyze`.
  private N: number[] = [];

  private version = 0;
  private normalsCache: { version: number; data: SolidNormals } | null = null;

  /** Number of triangles accumulated so far. */
  get triangleCount(): number {
    return this.S.length / 4;
  }

  /**
   * Current triangle count, for use as the `from` argument of the bulk
   * operations — "everything added after this point":
   *   const s = m.mark(); cylinder(m, …); m.rotate('z', 90, s);
   */
  mark(): number {
    return this.triangleCount;
  }

  // -------------------------------------------------------------------------
  // Authoring

  /**
   * Add a triangle facing (b − a) × (c − a). `colors` optionally overrides
   * the paint colour per corner [a, b, c] for gradients. Degenerate (zero
   * area) triangles are silently dropped, so collapsed rings and poles need
   * no special-casing in shape code. `normals` (rarely needed) pins an
   * explicit shading normal per corner instead of deriving it from the
   * geometry — for shape code that knows the exact surface normal.
   */
  tri(a: Vec3, b: Vec3, c: Vec3, p: Paint, colors?: readonly RGB[], normals?: readonly Vec3[]): this {
    const before = this.triangleCount;
    this.put(
      cx(a), cy(a), cz(a),
      cx(b), cy(b), cz(b),
      cx(c), cy(c), cz(c),
      p,
      colors ? colors[0] : p.color,
      colors ? colors[1] : p.color,
      colors ? colors[2] : p.color,
    );
    if (normals && this.triangleCount > before) this.pin(before, normals[0], normals[1], normals[2]);
    return this;
  }

  /**
   * Add a quad a→b→c→d (same facing rule as `tri`, using a, b, c). Split
   * along its SHORTER diagonal, which is the better choice for the slightly
   * non-planar quads lofts and revolves produce. `colors` = per corner
   * [a, b, c, d].
   */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, p: Paint, colors?: readonly RGB[], normals?: readonly Vec3[]): this {
    const ax = cx(a), ay = cy(a), az = cz(a);
    const bx = cx(b), by = cy(b), bz = cz(b);
    const ccx = cx(c), ccy = cy(c), ccz = cz(c);
    const dx = cx(d), dy = cy(d), dz = cz(d);
    const ca = colors ? colors[0] : p.color;
    const cb = colors ? colors[1] : p.color;
    const cc = colors ? colors[2] : p.color;
    const cd = colors ? colors[3] : p.color;
    const ac = (ccx - ax) ** 2 + (ccy - ay) ** 2 + (ccz - az) ** 2;
    const bd = (dx - bx) ** 2 + (dy - by) ** 2 + (dz - bz) ** 2;
    // The small bias keeps regular grids on one consistent diagonal instead
    // of flickering between the two on float noise.
    if (ac <= bd * (1 + 1e-6)) {
      let t = this.triangleCount;
      this.put(ax, ay, az, bx, by, bz, ccx, ccy, ccz, p, ca, cb, cc);
      if (normals && this.triangleCount > t) this.pin(t, normals[0], normals[1], normals[2]);
      t = this.triangleCount;
      this.put(ax, ay, az, ccx, ccy, ccz, dx, dy, dz, p, ca, cc, cd);
      if (normals && this.triangleCount > t) this.pin(t, normals[0], normals[2], normals[3]);
    } else {
      let t = this.triangleCount;
      this.put(ax, ay, az, bx, by, bz, dx, dy, dz, p, ca, cb, cd);
      if (normals && this.triangleCount > t) this.pin(t, normals[0], normals[1], normals[3]);
      t = this.triangleCount;
      this.put(bx, by, bz, ccx, ccy, ccz, dx, dy, dz, p, cb, cc, cd);
      if (normals && this.triangleCount > t) this.pin(t, normals[1], normals[2], normals[3]);
    }
    return this;
  }

  /** Store explicit shading normals for the corners of triangle `t`. */
  private pin(t: number, n0: Vec3, n1: Vec3, n2: Vec3): void {
    const N = this.N;
    const src = [n0, n1, n2];
    for (let k = 0; k < 3; k++) {
      const n = src[k];
      const x = cx(n), y = cy(n), z = cz(n);
      const l = Math.hypot(x, y, z);
      if (l < 1e-12) continue;
      N[t * 9 + k * 3] = x / l;
      N[t * 9 + k * 3 + 1] = y / l;
      N[t * 9 + k * 3 + 2] = z / l;
    }
  }

  /**
   * Pin explicit shading normals from a function of position (kit code that
   * knows a shape's exact surface normal — a rounded box, say). `fn` returns
   * the normal for a corner, or nothing to leave it derived from geometry.
   * Faceted faces (paint `smooth: 0`) ignore explicit normals.
   */
  setNormals(fn: (position: Vector3, faceNormal: Vector3) => Vec3 | null | undefined | void, from = 0): this {
    const P = this.P, N = this.N;
    const pos = new Vector3();
    const nrm = new Vector3();
    for (let t = from, T = this.triangleCount; t < T; t++) {
      this.faceNormalInto(t, nrm);
      for (let k = 0; k < 3; k++) {
        const i = t * 9 + k * 3;
        pos.set(P[i], P[i + 1], P[i + 2]);
        const n = fn(pos, nrm);
        if (!n) continue;
        const x = cx(n), y = cy(n), z = cz(n);
        const l = Math.hypot(x, y, z);
        if (l < 1e-12) continue;
        N[i] = x / l;
        N[i + 1] = y / l;
        N[i + 2] = z / l;
      }
    }
    this.version++;
    return this;
  }

  /**
   * Convex polygon as a triangle fan from points[0]. Facing rule as `tri`
   * (points[0], points[1], points[2]). Use `polygon` if it may be concave.
   */
  fan(points: readonly Vec3[], p: Paint, colors?: readonly RGB[]): this {
    for (let i = 1; i < points.length - 1; i++) {
      this.tri(points[0], points[i], points[i + 1], p, colors ? [colors[0], colors[i], colors[i + 1]] : undefined);
    }
    return this;
  }

  /**
   * Planar polygon of any shape (convex or concave, no self-intersection),
   * ear-clipped. It faces along its Newell normal — for a convex polygon that
   * is the same direction `tri(points[0], points[1], points[2])` would face.
   */
  polygon(points: readonly Vec3[], p: Paint, colors?: readonly RGB[]): this {
    const n = points.length;
    if (n < 3) return this;
    if (n === 3) return this.tri(points[0], points[1], points[2], p, colors);
    // Newell normal: robust for concave and slightly non-planar outlines.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      nx += (cy(a) - cy(b)) * (cz(a) + cz(b));
      ny += (cz(a) - cz(b)) * (cx(a) + cx(b));
      nz += (cx(a) - cx(b)) * (cy(a) + cy(b));
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-14) return this;
    nx /= len; ny /= len; nz /= len;
    // In-plane basis with u × v = n, so a ring that is CCW in (u, v) faces n.
    let ux: number, uy: number, uz: number;
    if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) { ux = 0; uy = -nz; uz = ny; }
    else if (Math.abs(ny) <= Math.abs(nz)) { ux = nz; uy = 0; uz = -nx; }
    else { ux = -ny; uy = nx; uz = 0; }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const flat: Vec2[] = points.map((q) => [
      cx(q) * ux + cy(q) * uy + cz(q) * uz,
      cx(q) * vx + cy(q) * vy + cz(q) * vz,
    ]);
    const { triangles } = triangulate(flat);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      this.tri(points[a], points[b], points[c], p, colors ? [colors[a], colors[b], colors[c]] : undefined);
    }
    return this;
  }

  private put(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx_: number, cy_: number, cz_: number,
    p: Paint, ca: RGB, cb: RGB, cc: RGB,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx_ - ax, vy = cy_ - ay, vz = cz_ - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // Zero-area slivers (collapsed loft rings, revolve poles) would carry a
    // garbage normal = a black facet. 1e-11 is a 3 µm-sided triangle.
    const area2 = nx * nx + ny * ny + nz * nz;
    if (area2 < 1e-22) return;
    // NaN fails every comparison, so it would sail past the test above and
    // poison the vertex buffer (the whole mesh then vanishes on some GPUs).
    // One bad shape parameter should fail loudly, with a stack.
    if (!(area2 < Infinity)) {
      throw new Error('SolidMesh: non-finite vertex position (NaN / Infinity) — check the options of the shape being added');
    }
    this.P.push(ax, ay, az, bx, by, bz, cx_, cy_, cz_);
    this.N.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    this.C.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    this.S.push(p.gloss, p.metal, p.emissive, p.smooth);
    this.A.push(1, 1, 1);
    this.W.push(0, 0, 0);
    this.version++;
  }

  // -------------------------------------------------------------------------
  // Post passes (all take an optional `from` = first triangle, see `mark`)

  /**
   * Recolour every face corner: `fn(position, faceNormal, colour)` returns
   * the new colour (or nothing to keep it). Called once per triangle corner,
   * so gradients along position work across a face. The FACE normal (unit,
   * geometric) is passed, which is what "warm tops, cool undersides" and
   * "moss on upward faces" want. `position` and `faceNormal` are scratch
   * vectors reused between calls — read them, do not keep them.
   */
  recolor(fn: (position: Vector3, faceNormal: Vector3, color: RGB) => RGB | null | undefined | void, from = 0): this {
    const P = this.P, C = this.C;
    const pos = new Vector3();
    const nrm = new Vector3();
    for (let t = from, T = this.triangleCount; t < T; t++) {
      const o = t * 9;
      this.faceNormalInto(t, nrm);
      for (let k = 0; k < 3; k++) {
        const i = o + k * 3;
        pos.set(P[i], P[i + 1], P[i + 2]);
        const out = fn(pos, nrm, [C[i], C[i + 1], C[i + 2]]);
        if (out) {
          C[i] = out[0];
          C[i + 1] = out[1];
          C[i + 2] = out[2];
        }
      }
    }
    this.version++;
    return this;
  }

  /**
   * Set the wind weight (uv2.y; 0 rigid … 1 sways fully) per corner, as a
   * constant or `fn(position, faceNormal)`. Make it a function of POSITION
   * only (e.g. height above the trunk) so welded corners agree and the
   * foliage does not tear when it sways.
   */
  setWind(w: number | ((position: Vector3, faceNormal: Vector3) => number), from = 0): this {
    this.setCornerScalar(this.W, w, from);
    return this;
  }

  /**
   * Set ambient occlusion (uv2.x; 1 open … 0 fully occluded) per corner by
   * hand, as a constant or `fn(position, faceNormal)`. `bakeAO` (ao.ts)
   * overwrites this with a computed bake.
   */
  setAO(ao: number | ((position: Vector3, faceNormal: Vector3) => number), from = 0): this {
    this.setCornerScalar(this.A, ao, from);
    return this;
  }

  private setCornerScalar(
    target: number[],
    value: number | ((position: Vector3, faceNormal: Vector3) => number),
    from: number,
  ): void {
    const P = this.P;
    const pos = new Vector3();
    const nrm = new Vector3();
    for (let t = from, T = this.triangleCount; t < T; t++) {
      if (typeof value === 'number') {
        target[t * 3] = target[t * 3 + 1] = target[t * 3 + 2] = value;
        continue;
      }
      this.faceNormalInto(t, nrm);
      for (let k = 0; k < 3; k++) {
        const i = t * 9 + k * 3;
        pos.set(P[i], P[i + 1], P[i + 2]);
        target[t * 3 + k] = value(pos, nrm);
      }
    }
    this.version++;
  }

  /** Overwrite surface attributes (any of gloss / metal / emissive / smooth)
   * on existing faces, keeping their colours. */
  setSurface(s: { gloss?: number; metal?: number; emissive?: number; smooth?: number }, from = 0): this {
    const S = this.S;
    for (let t = from, T = this.triangleCount; t < T; t++) {
      if (s.gloss !== undefined) S[t * 4] = s.gloss;
      if (s.metal !== undefined) S[t * 4 + 1] = s.metal;
      if (s.emissive !== undefined) S[t * 4 + 2] = s.emissive;
      if (s.smooth !== undefined) S[t * 4 + 3] = s.smooth;
    }
    // A new crease angle must re-derive the shading from geometry.
    if (s.smooth !== undefined) this.clearNormals(from);
    this.version++;
    return this;
  }

  /**
   * Choose a paint PER FACE after the fact: `fn(centroid, faceNormal, paint)`
   * returns the new Paint (colour and surface replace the face's own), null
   * to DELETE the face, or nothing to keep it. For decisions that follow the
   * mesh's own faces — "every upward facet moss green", "delete the faces
   * under the floor". For a crisp colour boundary that does NOT follow the
   * faces, use `paintWhere` / `paintStripe` / `paintDecal` (regions.ts).
   * Scratch vectors — do not keep them.
   */
  repaint(fn: (centroid: Vector3, faceNormal: Vector3, paint: Paint) => Paint | null | undefined | void, from = 0): this {
    const P = this.P, C = this.C, S = this.S;
    const pos = new Vector3();
    const nrm = new Vector3();
    const drop: number[] = [];
    let crease = false;
    for (let t = from, T = this.triangleCount; t < T; t++) {
      const o = t * 9;
      pos.set((P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 1] + P[o + 4] + P[o + 7]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3);
      this.faceNormalInto(t, nrm);
      const p = fn(pos, nrm, this.trianglePaint(t));
      if (p === null) {
        drop.push(t);
        continue;
      }
      if (!p) continue;
      for (let k = 0; k < 9; k += 3) {
        C[o + k] = p.color[0];
        C[o + k + 1] = p.color[1];
        C[o + k + 2] = p.color[2];
      }
      S[t * 4] = p.gloss;
      S[t * 4 + 1] = p.metal;
      S[t * 4 + 2] = p.emissive;
      if (S[t * 4 + 3] !== p.smooth) {
        S[t * 4 + 3] = p.smooth;
        crease = true;
      }
    }
    if (drop.length) {
      // Compact in one pass (a splice per face would be quadratic).
      const gone = new Set(drop);
      const keep = (src: number[], per: number): number[] => {
        const out: number[] = [];
        for (let t = 0, T = src.length / per; t < T; t++) {
          if (gone.has(t)) continue;
          for (let i = 0; i < per; i++) out.push(src[t * per + i]);
        }
        return out;
      };
      this.P = keep(this.P, 9);
      this.C = keep(this.C, 9);
      this.N = keep(this.N, 9);
      this.S = keep(this.S, 4);
      this.A = keep(this.A, 3);
      this.W = keep(this.W, 3);
    }
    if (crease) this.clearNormals(from);
    this.version++;
    return this;
  }

  /** Drop explicit shading normals (they are re-derived from geometry). */
  private clearNormals(from: number): void {
    const N = this.N;
    for (let i = from * 9, n = N.length; i < n; i++) N[i] = 0;
  }

  /**
   * Pin the CURRENT shading normals of every corner from `from` on as
   * explicit normals. Operations that split triangles call this first and
   * then interpolate, which is what keeps a smooth surface (and the soft
   * blend at a bevel) looking exactly the same after the split.
   */
  freezeNormals(from = 0): this {
    const D = this.computeNormals();
    const N = this.N;
    for (let i = from * 9, n = N.length; i < n; i++) N[i] = D.normals[i];
    this.version++;
    return this;
  }

  /**
   * Move vertices: `fn(position, vertexNormal)` returns either a new position
   * or a NUMBER = distance to push along the vertex normal. It is evaluated
   * ONCE per welded position and the result written to every corner there,
   * so a displaced surface can never crack open. `vertexNormal` is the
   * all-faces average at that position (ignores crease angles). Scratch
   * vectors — do not keep them. Typical use: lumpy rocks and foliage blobs:
   *   icosphere(m, { radius: 1, subdivisions: 2 }, ROCK);
   *   m.displace((p) => (noise3(p.x * 2, p.y * 2, p.z * 2) - 0.5) * 0.3);
   */
  displace(fn: (position: Vector3, vertexNormal: Vector3) => Vec3 | number, from = 0): this {
    const N = this.analyze(true);
    const P = this.P;
    const done = new Uint8Array(N.weldCount);
    const out = new Float64Array(N.weldCount * 3);
    const pos = new Vector3();
    const nrm = new Vector3();
    for (let c = from * 3, n = this.triangleCount * 3; c < n; c++) {
      const w = N.weld[c];
      if (!done[w]) {
        done[w] = 1;
        pos.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
        nrm.set(N.normals[c * 3], N.normals[c * 3 + 1], N.normals[c * 3 + 2]);
        const px = pos.x, py = pos.y, pz = pos.z;
        const nx = nrm.x, ny = nrm.y, nz = nrm.z;
        const r = fn(pos, nrm);
        if (typeof r === 'number') {
          out[w * 3] = px + nx * r;
          out[w * 3 + 1] = py + ny * r;
          out[w * 3 + 2] = pz + nz * r;
        } else {
          out[w * 3] = cx(r);
          out[w * 3 + 1] = cy(r);
          out[w * 3 + 2] = cz(r);
        }
      }
      P[c * 3] = out[w * 3];
      P[c * 3 + 1] = out[w * 3 + 1];
      P[c * 3 + 2] = out[w * 3 + 2];
    }
    // The surface changed shape: pinned normals no longer describe it.
    this.clearNormals(from);
    this.version++;
    return this;
  }

  /**
   * Split every edge longer than `maxEdge` (meters) at its midpoint until
   * none is left, interpolating colour / AO / wind. Shape is unchanged; use
   * it to give big flat faces enough vertices for per-vertex effects — baked
   * AO contact gradients on walls, `recolor` height gradients, wind bending,
   * `displace`. The decision is per edge, so neighbouring triangles always
   * split a shared edge together (no cracks). SHADING IS UNCHANGED: the
   * normals the surface has now are pinned and interpolated onto the new
   * vertices, so a tessellated wall still has its soft bevel edge and a
   * tessellated coarse sphere is exactly as smooth as before. (`displace`
   * afterwards re-derives them, as it must.)
   */
  tessellate(maxEdge: number, from = 0): this {
    if (!(maxEdge > 0)) throw new Error('tessellate: maxEdge must be a positive length');
    const max2 = maxEdge * maxEdge;
    if (this.triangleCount <= from) return this;
    this.freezeNormals(from);
    for (let pass = 0; pass < 12; pass++) {
      const P = this.P, C = this.C, S = this.S, A = this.A, W = this.W, N = this.N;
      const T = this.triangleCount;
      const nP = P.slice(0, from * 9), nC = C.slice(0, from * 9), nS = S.slice(0, from * 4);
      const nA = A.slice(0, from * 3), nW = W.slice(0, from * 3), nN = N.slice(0, from * 9);
      let split = false;
      // Local vertex table per triangle: 0..2 corners, 3 = mid(0,1),
      // 4 = mid(1,2), 5 = mid(2,0).
      const vp = new Float64Array(18), vc = new Float64Array(18), va = new Float64Array(6), vw = new Float64Array(6);
      const vn = new Float64Array(18);
      for (let t = from; t < T; t++) {
        for (let k = 0; k < 3; k++) {
          for (let d = 0; d < 3; d++) {
            vp[k * 3 + d] = P[t * 9 + k * 3 + d];
            vc[k * 3 + d] = C[t * 9 + k * 3 + d];
            vn[k * 3 + d] = N[t * 9 + k * 3 + d];
          }
          va[k] = A[t * 3 + k];
          vw[k] = W[t * 3 + k];
        }
        let mask = 0;
        for (let k = 0; k < 3; k++) {
          const j = (k + 1) % 3;
          const d2 = (vp[j * 3] - vp[k * 3]) ** 2 + (vp[j * 3 + 1] - vp[k * 3 + 1]) ** 2 + (vp[j * 3 + 2] - vp[k * 3 + 2]) ** 2;
          if (d2 > max2) {
            mask |= 1 << k;
            for (let d = 0; d < 3; d++) {
              // (a + b) / 2 is bit-identical from either side of the edge.
              vp[(3 + k) * 3 + d] = (vp[k * 3 + d] + vp[j * 3 + d]) / 2;
              vc[(3 + k) * 3 + d] = (vc[k * 3 + d] + vc[j * 3 + d]) / 2;
              vn[(3 + k) * 3 + d] = vn[k * 3 + d] + vn[j * 3 + d];
            }
            const nl = Math.hypot(vn[(3 + k) * 3], vn[(3 + k) * 3 + 1], vn[(3 + k) * 3 + 2]) || 1;
            for (let d = 0; d < 3; d++) vn[(3 + k) * 3 + d] /= nl;
            va[3 + k] = (va[k] + va[j]) / 2;
            vw[3 + k] = (vw[k] + vw[j]) / 2;
          }
        }
        const emit = (i0: number, i1: number, i2: number): void => {
          for (const i of [i0, i1, i2]) {
            nP.push(vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]);
            nC.push(vc[i * 3], vc[i * 3 + 1], vc[i * 3 + 2]);
            nN.push(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]);
            nA.push(va[i]);
            nW.push(vw[i]);
          }
          nS.push(S[t * 4], S[t * 4 + 1], S[t * 4 + 2], S[t * 4 + 3]);
        };
        if (mask === 0) {
          emit(0, 1, 2);
          continue;
        }
        split = true;
        if (mask === 7) {
          emit(0, 3, 5); emit(3, 1, 4); emit(5, 4, 2); emit(3, 4, 5);
        } else {
          // Rotate so the pattern is described once: r = first split edge.
          const one = mask === 1 || mask === 2 || mask === 4;
          const r = one ? (mask === 1 ? 0 : mask === 2 ? 1 : 2) : mask === 3 ? 0 : mask === 6 ? 1 : 2;
          const a = r, b = (r + 1) % 3, c = (r + 2) % 3;
          const mab = 3 + r, mbc = 3 + ((r + 1) % 3);
          if (one) {
            emit(a, mab, c); emit(mab, b, c);
          } else {
            emit(mab, b, mbc); emit(a, mab, mbc); emit(a, mbc, c);
          }
        }
      }
      this.P = nP; this.C = nC; this.S = nS; this.A = nA; this.W = nW; this.N = nN;
      this.version++;
      if (!split) break;
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Transforms

  /**
   * Transform positions by a matrix. Mirroring matrices (negative
   * determinant) automatically reverse the winding so faces keep pointing
   * outward; normals are derived from geometry at finalize, so non-uniform
   * scale needs no special care either.
   */
  transform(m: Matrix, from = 0): this {
    const a = m.m;
    const P = this.P;
    for (let i = from * 9, n = P.length; i < n; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      P[i] = x * a[0] + y * a[4] + z * a[8] + a[12];
      P[i + 1] = x * a[1] + y * a[5] + z * a[9] + a[13];
      P[i + 2] = x * a[2] + y * a[6] + z * a[10] + a[14];
    }
    const det =
      a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) + a[2] * (a[4] * a[9] - a[5] * a[8]);
    // Explicit normals go through the inverse transpose = cofactor matrix
    // (its columns are the cross products of the matrix's axis rows), times
    // the determinant's sign so a mirror keeps them pointing outward.
    const N = this.N;
    const sg = det < 0 ? -1 : 1;
    const c0x = (a[5] * a[10] - a[6] * a[9]) * sg, c0y = (a[6] * a[8] - a[4] * a[10]) * sg, c0z = (a[4] * a[9] - a[5] * a[8]) * sg;
    const c1x = (a[9] * a[2] - a[10] * a[1]) * sg, c1y = (a[10] * a[0] - a[8] * a[2]) * sg, c1z = (a[8] * a[1] - a[9] * a[0]) * sg;
    const c2x = (a[1] * a[6] - a[2] * a[5]) * sg, c2y = (a[2] * a[4] - a[0] * a[6]) * sg, c2z = (a[0] * a[5] - a[1] * a[4]) * sg;
    for (let i = from * 9, n = N.length; i < n; i += 3) {
      const x = N[i], y = N[i + 1], z = N[i + 2];
      if (x === 0 && y === 0 && z === 0) continue;
      const tx = x * c0x + y * c1x + z * c2x;
      const ty = x * c0y + y * c1y + z * c2y;
      const tz = x * c0z + y * c1z + z * c2z;
      const l = Math.hypot(tx, ty, tz) || 1;
      N[i] = tx / l;
      N[i + 1] = ty / l;
      N[i + 2] = tz / l;
    }
    if (det < 0) this.reverseWinding(from);
    this.version++;
    return this;
  }

  /** Move by a vector. */
  translate(offset: Vec3, from = 0): this {
    return this.transform(translation(offset), from);
  }

  /** Rotate by `deg` DEGREES about 'x' | 'y' | 'z' or an axis vector, through
   * `pivot` (default origin). Sense: about Y, positive turns +z toward +x. */
  rotate(axis: 'x' | 'y' | 'z' | Vec3, deg: number, from = 0, pivot?: Vec3): this {
    const r = rotation(axis, deg);
    if (!pivot) return this.transform(r, from);
    const p = toV3(pivot);
    return this.transform(translation(-p.x, -p.y, -p.z).multiply(r).multiply(translation(p)), from);
  }

  /** Scale about the origin: a number (uniform) or [sx, sy, sz]. Negative
   * components mirror (winding is fixed up automatically). */
  scale(s: number | Vec3, from = 0): this {
    const v = typeof s === 'number' ? [s, s, s] : [cx(s), cy(s), cz(s)];
    return this.transform(Matrix.Scaling(v[0], v[1], v[2]), from);
  }

  /** Mirror IN PLACE across the plane through the origin perpendicular to
   * `axis` (e.g. 'x' turns a right-hand part into a left-hand part). */
  mirror(axis: 'x' | 'y' | 'z', from = 0): this {
    return this.transform(mirroring(axis), from);
  }

  /**
   * Append a mirrored COPY of the triangles from `from` on — model one half,
   * call `mirrorCopy('x')`, get the symmetric whole. Vertices on the mirror
   * plane weld, so a smooth surface stays smooth across the seam (do not
   * build faces lying IN the mirror plane, they would be doubled).
   */
  mirrorCopy(axis: 'x' | 'y' | 'z', from = 0): this {
    const start = this.triangleCount;
    appendArray(this.P, this.P.slice(from * 9, start * 9));
    appendArray(this.C, this.C.slice(from * 9, start * 9));
    appendArray(this.S, this.S.slice(from * 4, start * 4));
    appendArray(this.A, this.A.slice(from * 3, start * 3));
    appendArray(this.W, this.W.slice(from * 3, start * 3));
    appendArray(this.N, this.N.slice(from * 9, start * 9));
    return this.mirror(axis, start);
  }

  /** Reverse the facing of triangles (turn a surface inside-out). */
  flip(from = 0): this {
    const N = this.N;
    for (let i = from * 9, n = N.length; i < n; i++) N[i] = -N[i];
    return this.reverseWinding(from);
  }

  /** Swap corners b and c of every triangle (winding only; explicit normals
   * keep their direction — a mirror has already reflected them). */
  private reverseWinding(from: number): this {
    const P = this.P, C = this.C, A = this.A, W = this.W, N = this.N;
    for (let t = from, T = this.triangleCount; t < T; t++) {
      const o = t * 9;
      for (let d = 0; d < 3; d++) {
        let tmp = P[o + 3 + d];
        P[o + 3 + d] = P[o + 6 + d];
        P[o + 6 + d] = tmp;
        tmp = C[o + 3 + d];
        C[o + 3 + d] = C[o + 6 + d];
        C[o + 6 + d] = tmp;
        tmp = N[o + 3 + d];
        N[o + 3 + d] = N[o + 6 + d];
        N[o + 6 + d] = tmp;
      }
      let tmp = A[t * 3 + 1];
      A[t * 3 + 1] = A[t * 3 + 2];
      A[t * 3 + 2] = tmp;
      tmp = W[t * 3 + 1];
      W[t * 3 + 1] = W[t * 3 + 2];
      W[t * 3 + 2] = tmp;
    }
    this.version++;
    return this;
  }

  /**
   * Append another SolidMesh's triangles, optionally placed by a matrix or a
   * translation. `other` is not modified (and may be this mesh itself: a
   * second copy). Mirroring matrices are handled.
   */
  append(other: SolidMesh, placement?: Matrix | Vec3): this {
    const start = this.triangleCount;
    // Appending a mesh to itself (a second, moved copy) must read a snapshot:
    // the arrays grow while they are being copied.
    if (other === this) other = this.clone();
    // Chunked pushes: spreading a 500k-element array overflows the stack.
    appendArray(this.P, other.P);
    appendArray(this.C, other.C);
    appendArray(this.S, other.S);
    appendArray(this.A, other.A);
    appendArray(this.W, other.W);
    appendArray(this.N, other.N);
    this.version++;
    if (placement) this.transform(placement instanceof Matrix ? placement : translation(placement), start);
    return this;
  }

  /** Independent deep copy. */
  clone(): SolidMesh {
    const m = new SolidMesh();
    m.weldTolerance = this.weldTolerance;
    m.P = this.P.slice();
    m.C = this.C.slice();
    m.S = this.S.slice();
    m.A = this.A.slice();
    m.W = this.W.slice();
    m.N = this.N.slice();
    return m;
  }

  /** Remove all triangles from `from` on (default: everything). */
  truncate(from = 0): this {
    this.P.length = from * 9;
    this.C.length = from * 9;
    this.S.length = from * 4;
    this.A.length = from * 3;
    this.W.length = from * 3;
    this.N.length = from * 9;
    this.version++;
    return this;
  }

  /** @internal Raw buffers for kit code that rewrites triangles wholesale
   * (regions.ts). Per triangle: positions 9, colors 9, normals 9 (explicit,
   * 0 = unset), surface 4 (gloss, metal, emissive, smooth), ao 3, wind 3. */
  rawBuffers(): { positions: number[]; colors: number[]; normals: number[]; surface: number[]; ao: number[]; wind: number[] } {
    return { positions: this.P, colors: this.C, normals: this.N, surface: this.S, ao: this.A, wind: this.W };
  }

  /** @internal Replace every triangle from `from` on with the given buffers
   * (same layout as `rawBuffers`). */
  replaceTriangles(
    from: number,
    b: { positions: number[]; colors: number[]; normals: number[]; surface: number[]; ao: number[]; wind: number[] },
  ): this {
    this.truncate(from);
    appendArray(this.P, b.positions);
    appendArray(this.C, b.colors);
    appendArray(this.N, b.normals);
    appendArray(this.S, b.surface);
    appendArray(this.A, b.ao);
    appendArray(this.W, b.wind);
    this.version++;
    return this;
  }

  // -------------------------------------------------------------------------
  // Queries

  /** Axis-aligned bounds of the triangles from `from` on. An empty mesh
   * returns zero-size bounds at the origin. */
  bounds(from = 0): Bounds {
    const P = this.P;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = from * 9, n = P.length; i < n; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (x0 === Infinity) x0 = y0 = z0 = x1 = y1 = z1 = 0;
    const min = new Vector3(x0, y0, z0);
    const max = new Vector3(x1, y1, z1);
    return { min, max, size: max.subtract(min), center: min.add(max).scale(0.5) };
  }

  /** Raw triangle positions, 9 floats per triangle (a, b, c in authoring
   * order — NOT index-reversed). Read-only view for bakes and measurements. */
  get positions(): readonly number[] {
    return this.P;
  }

  /** Raw per-corner colours, 9 floats per triangle. Read-only view. */
  get cornerColors(): readonly number[] {
    return this.C;
  }

  /** Surface of triangle `t` as a Paint (colour = its first corner's). */
  trianglePaint(t: number): Paint {
    const S = this.S, C = this.C;
    return {
      color: [C[t * 9], C[t * 9 + 1], C[t * 9 + 2]],
      gloss: S[t * 4],
      metal: S[t * 4 + 1],
      emissive: S[t * 4 + 2],
      smooth: S[t * 4 + 3],
    };
  }

  /** Explicit per-corner shading normals, 9 floats per triangle; (0, 0, 0)
   * where the normal is derived from geometry. Read-only view. */
  get cornerNormals(): readonly number[] {
    return this.N;
  }

  /** Per-corner AO values, 3 per triangle. Writable through `writeAO`. */
  get cornerAO(): readonly number[] {
    return this.A;
  }

  /** Bulk-assign per-corner AO (3 values per triangle) — used by `bakeAO`. */
  writeAO(values: ArrayLike<number>): this {
    const A = this.A;
    const n = Math.min(A.length, values.length);
    for (let i = 0; i < n; i++) A[i] = values[i];
    // AO feeds nothing the normals are computed from: a normals analysis
    // that was current stays current (it is the costly half of
    // `toVertexData`, which every bake is followed by).
    const cached = this.normalsCache !== null && this.normalsCache.version === this.version;
    this.version++;
    if (cached) this.normalsCache!.version = this.version;
    return this;
  }

  /**
   * Weld positions and compute per-corner shading normals from the paints'
   * crease angles (cached until the mesh changes). Exposed for bakes and
   * analysis; `toVertexData` calls it for you.
   */
  computeNormals(): SolidNormals {
    if (this.normalsCache && this.normalsCache.version === this.version) return this.normalsCache.data;
    const data = this.analyze(false);
    this.normalsCache = { version: this.version, data };
    return data;
  }

  private faceNormalInto(t: number, out: Vector3): void {
    const P = this.P;
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.set(nx / l, ny / l, nz / l);
  }

  /** Weld + normals. `allSmooth` ignores crease angles (used by displace). */
  private analyze(allSmooth: boolean): SolidNormals {
    const P = this.P, S = this.S, EN = this.N;
    const T = this.triangleCount;
    const NC = T * 3;
    const tol = this.weldTolerance;

    // --- weld by position: spatial hash, cell = 4·tol, probing the
    // neighbouring cell on any axis where the point lies within tol of the
    // cell wall, so two points closer than tol always find each other.
    const weld = new Int32Array(NC);
    const cell = tol * 4;
    const inv = 1 / cell;
    const edge = tol / cell;
    const heads = new Map<number, number>();
    const next: number[] = [];
    const wx: number[] = [], wy: number[] = [], wz: number[] = [];
    const tol2 = tol * tol;
    const key = (ix: number, iy: number, iz: number): number =>
      (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
    for (let c = 0; c < NC; c++) {
      const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
      const gx = x * inv, gy = y * inv, gz = z * inv;
      const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
      const fx = gx - ix, fy = gy - iy, fz = gz - iz;
      const dx = fx < edge ? -1 : fx > 1 - edge ? 1 : 0;
      const dy = fy < edge ? -1 : fy > 1 - edge ? 1 : 0;
      const dz = fz < edge ? -1 : fz > 1 - edge ? 1 : 0;
      let found = -1;
      for (let a = 0; a < 2 && found < 0; a++) {
        if (a === 1 && dx === 0) break;
        for (let b = 0; b < 2 && found < 0; b++) {
          if (b === 1 && dy === 0) break;
          for (let d = 0; d < 2 && found < 0; d++) {
            if (d === 1 && dz === 0) break;
            let w = heads.get(key(ix + a * dx, iy + b * dy, iz + d * dz));
            while (w !== undefined && w >= 0) {
              const ex = wx[w] - x, ey = wy[w] - y, ez = wz[w] - z;
              if (ex * ex + ey * ey + ez * ez <= tol2) {
                found = w;
                break;
              }
              w = next[w];
            }
          }
        }
      }
      if (found < 0) {
        found = wx.length;
        wx.push(x); wy.push(y); wz.push(z);
        const k = key(ix, iy, iz);
        const head = heads.get(k);
        next.push(head === undefined ? -1 : head);
        heads.set(k, found);
      }
      weld[c] = found;
    }
    const weldCount = wx.length;

    // --- face normals, areas, corner weights (area × corner angle)
    const faceNormals = new Float32Array(T * 3);
    const faceAreas = new Float32Array(T);
    const weight = new Float64Array(NC);
    for (let t = 0; t < T; t++) {
      const o = t * 9;
      const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
      const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1e-30;
      faceNormals[t * 3] = nx / len;
      faceNormals[t * 3 + 1] = ny / len;
      faceNormals[t * 3 + 2] = nz / len;
      const area = len / 2;
      faceAreas[t] = area;
      for (let k = 0; k < 3; k++) {
        const i = o + k * 3, j = o + ((k + 1) % 3) * 3, h = o + ((k + 2) % 3) * 3;
        const ex = P[j] - P[i], ey = P[j + 1] - P[i + 1], ez = P[j + 2] - P[i + 2];
        const gx = P[h] - P[i], gy = P[h + 1] - P[i + 1], gz = P[h + 2] - P[i + 2];
        // |e × g| = 2·area for every corner, so the angle needs only the dot.
        weight[t * 3 + k] = area * Math.atan2(len, ex * gx + ey * gy + ez * gz);
      }
    }

    // --- adjacency (CSR): corners at each welded position
    const cornerStart = new Int32Array(weldCount + 1);
    for (let c = 0; c < NC; c++) cornerStart[weld[c] + 1]++;
    for (let w = 0; w < weldCount; w++) cornerStart[w + 1] += cornerStart[w];
    const fill = cornerStart.slice(0, weldCount);
    const cornerList = new Int32Array(NC);
    for (let c = 0; c < NC; c++) cornerList[fill[weld[c]]++] = c;

    // --- per-corner normals. An EDGE is smooth when the two faces sharing it
    // differ by less than the crease angle; around each welded vertex the
    // faces connected through smooth edges form a group that shares one
    // averaged normal (the classic smoothing-group fan). Being transitive is
    // what makes a coarse sphere shade as ONE surface: diagonal neighbours can
    // exceed the crease angle and must still be included.
    const cosThr = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const s = allSmooth ? 180 : S[t * 4 + 3];
      // −2 for "always smooth" so float error on opposite faces cannot split it.
      cosThr[t] = s <= 0 ? 2 : s >= 180 ? -2 : Math.cos(s * DEG);
    }
    const normals = new Float32Array(NC * 3);
    let maxValence = 0;
    for (let w = 0; w < weldCount; w++) maxValence = Math.max(maxValence, cornerStart[w + 1] - cornerStart[w]);
    const group = new Int32Array(maxValence);
    const otherA = new Int32Array(maxValence);
    const otherB = new Int32Array(maxValence);
    const find = (i: number): number => {
      while (group[i] !== i) {
        group[i] = group[group[i]];
        i = group[i];
      }
      return i;
    };
    for (let w = 0; w < weldCount; w++) {
      const s0 = cornerStart[w], s1 = cornerStart[w + 1];
      const k = s1 - s0;
      if (allSmooth) {
        // One normal per position, whatever the creases (used by displace).
        let sx = 0, sy = 0, sz = 0;
        for (let i = s0; i < s1; i++) {
          const c = cornerList[i];
          const t = (c / 3) | 0;
          sx += faceNormals[t * 3] * weight[c];
          sy += faceNormals[t * 3 + 1] * weight[c];
          sz += faceNormals[t * 3 + 2] * weight[c];
        }
        const l = Math.hypot(sx, sy, sz);
        for (let i = s0; i < s1; i++) {
          const c = cornerList[i];
          const t = (c / 3) | 0;
          normals[c * 3] = l > 1e-12 ? sx / l : faceNormals[t * 3];
          normals[c * 3 + 1] = l > 1e-12 ? sy / l : faceNormals[t * 3 + 1];
          normals[c * 3 + 2] = l > 1e-12 ? sz / l : faceNormals[t * 3 + 2];
        }
        continue;
      }
      for (let i = 0; i < k; i++) {
        const c = cornerList[s0 + i];
        const t3 = ((c / 3) | 0) * 3;
        const r = c - t3;
        group[i] = i;
        otherA[i] = weld[t3 + ((r + 1) % 3)];
        otherB[i] = weld[t3 + ((r + 2) % 3)];
      }
      for (let i = 0; i < k; i++) {
        const ti = (cornerList[s0 + i] / 3) | 0;
        if (cosThr[ti] > 1) continue; // faceted: never joins a group
        for (let j = i + 1; j < k; j++) {
          // Sharing a second welded vertex = sharing an edge at this vertex.
          if (otherA[i] !== otherA[j] && otherA[i] !== otherB[j] && otherB[i] !== otherA[j] && otherB[i] !== otherB[j]) continue;
          const tj = (cornerList[s0 + j] / 3) | 0;
          const thr = cosThr[ti] > cosThr[tj] ? cosThr[ti] : cosThr[tj];
          const d =
            faceNormals[ti * 3] * faceNormals[tj * 3] +
            faceNormals[ti * 3 + 1] * faceNormals[tj * 3 + 1] +
            faceNormals[ti * 3 + 2] * faceNormals[tj * 3 + 2];
          if (d < thr - 1e-6) continue;
          const a = find(i), b = find(j);
          if (a !== b) group[a] = b;
        }
      }
      for (let i = 0; i < k; i++) {
        const c = cornerList[s0 + i];
        const t = (c / 3) | 0;
        const fx = faceNormals[t * 3], fy = faceNormals[t * 3 + 1], fz = faceNormals[t * 3 + 2];
        let nx = fx, ny = fy, nz = fz;
        if (cosThr[t] <= 1) {
          const g = find(i);
          let sx = 0, sy = 0, sz = 0;
          for (let j = 0; j < k; j++) {
            if (find(j) !== g) continue;
            const c2 = cornerList[s0 + j];
            const t2 = (c2 / 3) | 0;
            const gx = faceNormals[t2 * 3], gy = faceNormals[t2 * 3 + 1], gz = faceNormals[t2 * 3 + 2];
            // Within a group, still ignore faces turned more than 90° away
            // from this one: the tip of a sharp cone then shades like the
            // cone's flank instead of pointing straight along the axis.
            if (fx * gx + fy * gy + fz * gz < -0.01) continue;
            const wgt = weight[c2];
            // A corner with an EXPLICIT normal votes with that normal
            // instead of its face normal. Corners pinned together by a split
            // all carry the same vector, so the vote returns it unchanged —
            // the surface shades as before the split whatever the new
            // triangles' areas — while geometry welded on later (a mirrored
            // half, a neighbouring part) still blends in across the seam.
            const ex = EN[c2 * 3], ey = EN[c2 * 3 + 1], ez = EN[c2 * 3 + 2];
            if (ex !== 0 || ey !== 0 || ez !== 0) {
              sx += ex * wgt; sy += ey * wgt; sz += ez * wgt;
              continue;
            }
            sx += gx * wgt; sy += gy * wgt; sz += gz * wgt;
          }
          const l = Math.hypot(sx, sy, sz);
          if (l > 1e-12) {
            nx = sx / l; ny = sy / l; nz = sz / l;
          }
        }
        normals[c * 3] = nx;
        normals[c * 3 + 1] = ny;
        normals[c * 3 + 2] = nz;
      }
    }
    return { weld, weldCount, normals, faceNormals, faceAreas, cornerStart, cornerList };
  }

  // -------------------------------------------------------------------------
  // Output

  /**
   * Finalize into indexed buffers: computes normals, shares vertices wherever
   * position + normal + all attributes agree, and emits the index buffer in
   * Babylon's (reversed) order.
   */
  toVertexData(): SolidVertexData {
    const N = this.computeNormals();
    const P = this.P, C = this.C, S = this.S, A = this.A, W = this.W;
    const T = this.triangleCount;
    const NC = T * 3;
    const pos: number[] = [], nrm: number[] = [], col: number[] = [], uv: number[] = [], uv2: number[] = [];
    const head = new Int32Array(N.weldCount).fill(-1);
    const next: number[] = [];
    const vertexOf = new Int32Array(NC);
    const E = 1e-4;
    for (let c = 0; c < NC; c++) {
      const t = (c / 3) | 0;
      const nx = N.normals[c * 3], ny = N.normals[c * 3 + 1], nz = N.normals[c * 3 + 2];
      const r = C[c * 3], g = C[c * 3 + 1], b = C[c * 3 + 2];
      const gloss = S[t * 4], metal = S[t * 4 + 1], emissive = S[t * 4 + 2];
      const ao = A[c], wind = W[c];
      const w = N.weld[c];
      let v = head[w];
      while (v >= 0) {
        if (
          Math.abs(nrm[v * 3] - nx) < E && Math.abs(nrm[v * 3 + 1] - ny) < E && Math.abs(nrm[v * 3 + 2] - nz) < E &&
          Math.abs(col[v * 4] - r) < E && Math.abs(col[v * 4 + 1] - g) < E && Math.abs(col[v * 4 + 2] - b) < E &&
          Math.abs(col[v * 4 + 3] - emissive) < E &&
          Math.abs(uv[v * 2] - gloss) < E && Math.abs(uv[v * 2 + 1] - metal) < E &&
          Math.abs(uv2[v * 2] - ao) < E && Math.abs(uv2[v * 2 + 1] - wind) < E
        ) {
          break;
        }
        v = next[v];
      }
      if (v < 0) {
        v = next.length;
        // The corner's own position, not the weld representative: welding is
        // for normals; keeping exact positions means nothing ever shifts.
        pos.push(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
        nrm.push(nx, ny, nz);
        col.push(r, g, b, emissive);
        uv.push(gloss, metal);
        uv2.push(ao, wind);
        next.push(head[w]);
        head[w] = v;
      }
      vertexOf[c] = v;
    }
    const vertexCount = next.length;
    const indices = vertexCount > 65535 ? new Uint32Array(NC) : new Uint16Array(NC);
    for (let t = 0; t < T; t++) {
      // Babylon's default side orientation treats the REVERSE of the authoring
      // order as the front face — without this flip every asset renders
      // inside-out (dark interiors showing). Normals above stay geometric.
      indices[t * 3] = vertexOf[t * 3];
      indices[t * 3 + 1] = vertexOf[t * 3 + 2];
      indices[t * 3 + 2] = vertexOf[t * 3 + 1];
    }
    return {
      positions: new Float32Array(pos),
      normals: new Float32Array(nrm),
      colors: new Float32Array(col),
      uvs: new Float32Array(uv),
      uvs2: new Float32Array(uv2),
      indices,
      vertexCount,
      triangleCount: T,
    };
  }

  /** `toVertexData()` wrapped in a Babylon VertexData (positions, normals,
   * colors, uvs, uvs2, indices). */
  toBabylonVertexData(): VertexData {
    const d = this.toVertexData();
    const data = new VertexData();
    data.positions = d.positions;
    data.normals = d.normals;
    data.colors = d.colors;
    data.uvs = d.uvs;
    data.uvs2 = d.uvs2;
    data.indices = d.indices;
    return data;
  }

  /**
   * Create the Babylon Mesh (no material assigned — the look system does
   * that). This is the only method that needs a Scene.
   */
  build(name: string, scene: Scene): Mesh {
    const mesh = new Mesh(name, scene);
    this.toBabylonVertexData().applyToMesh(mesh);
    // A 4-component colour buffer makes Babylon assume vertex ALPHA, which
    // moves the mesh into the transparent pass with depth writes off — later
    // triangles then smear over earlier ones. Alpha here is the emissive
    // amount, never opacity, so the mesh must stay opaque.
    mesh.hasVertexAlpha = false;
    return mesh;
  }
}

function appendArray(target: number[], source: readonly number[]): void {
  const CHUNK = 8192;
  // Length read once: `source` may be `target` itself.
  for (let i = 0, n = source.length; i < n; i += CHUNK) {
    target.push(...source.slice(i, Math.min(i + CHUNK, n)));
  }
}
