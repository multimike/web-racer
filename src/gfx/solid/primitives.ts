import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { pickPaint, soften, softenPaint } from './SolidMesh';
import type { Paint, PaintLike, SolidMesh } from './SolidMesh';
import { DEG, aim, placementMatrix, toV3 } from './math';
import type { Placement, Vec2, Vec3 } from './math';
import { filletProfile } from './paths';

/**
 * Primitive solids: box, roundedBox, revolve, cylinder / cone / frustum,
 * sphere, icosphere, capsule, torus. See shapes.ts for the conventions they
 * all share (re-exported from there).
 */

// ---------------------------------------------------------------------------
// Internal helpers (also used by the other shape files)

/** Newell normal of a point loop (not normalised). */
export function loopNormal(points: readonly Vector3[]): Vector3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return new Vector3(nx, ny, nz);
}

/**
 * Emit a quad that is guaranteed to face `dir`, whatever order the corners
 * were listed in (a→b→c→d must still be a loop). Lets shape code state the
 * outward direction instead of reasoning about winding case by case.
 */
export function quadFacing(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, d: Vector3, dir: Vector3, p: Paint): void {
  if (Vector3.Dot(loopNormal([a, b, c, d]), dir) >= 0) m.quad(a, b, c, d, p);
  else m.quad(a, d, c, b, p);
}

/** Emit a triangle guaranteed to face `dir`. */
export function triFacing(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, dir: Vector3, p: Paint): void {
  if (Vector3.Dot(loopNormal([a, b, c]), dir) >= 0) m.tri(a, b, c, p);
  else m.tri(a, c, b, p);
}

/** Emit a planar polygon (any shape) guaranteed to face `dir`. */
export function polygonFacing(m: SolidMesh, points: readonly Vector3[], dir: Vector3, p: Paint): void {
  if (Vector3.Dot(loopNormal(points), dir) >= 0) m.polygon(points, p);
  else m.polygon([...points].reverse(), p);
}

/** Apply a shape's Placement to everything it added since `start`. */
export function place(m: SolidMesh, start: number, placement: Placement | undefined): void {
  const mat = placementMatrix(placement);
  if (mat) m.transform(mat, start);
}

/** Endpoints alternative for +Y-axis shapes. */
export interface AxisSpan {
  /**
   * Lay the shape between two points instead of using `height` + `at`/`rot`:
   * the shape's −Y end sits at `from`, its +Y end at `to`. When given,
   * `height`, `at` and `rot` are ignored.
   */
  from?: Vec3;
  to?: Vec3;
}

function spanPlacement(o: AxisSpan & Placement & { height?: number }, what: string): { height: number; mat: Matrix | null } {
  if (o.from !== undefined && o.to !== undefined) {
    const a = toV3(o.from);
    const b = toV3(o.to);
    return { height: Vector3.Distance(a, b), mat: aim(a, b, true) };
  }
  if (o.height === undefined) throw new Error(`${what}: give either height or from + to`);
  return { height: o.height, mat: placementMatrix(o) };
}

// ---------------------------------------------------------------------------
// Box

/** Per-face paint overrides for box / roundedBox flat faces. `null` omits
 * the face (an open box). Keys: p = plus, n = minus, then the axis. */
export interface BoxFaces {
  px?: Paint | null;
  nx?: Paint | null;
  py?: Paint | null;
  ny?: Paint | null;
  pz?: Paint | null;
  nz?: Paint | null;
}

export interface BoxOptions extends Placement {
  /** Full extents [x, y, z] (or one number for a cube), centred on the local
   * origin. Alternatively give `min` and `max` corners. */
  size?: Vec3 | number;
  min?: Vec3;
  max?: Vec3;
  /** Paint overrides per face; null leaves that face open. */
  faces?: BoxFaces;
}

const FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

function boxExtents(o: { size?: Vec3 | number; min?: Vec3; max?: Vec3 }, what: string): { c: Vector3; h: Vector3 } {
  if (o.min !== undefined && o.max !== undefined) {
    const a = toV3(o.min);
    const b = toV3(o.max);
    return {
      c: a.add(b).scale(0.5),
      h: new Vector3(Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, Math.abs(b.z - a.z) / 2),
    };
  }
  if (o.size === undefined) throw new Error(`${what}: give either size or min + max`);
  const s = typeof o.size === 'number' ? new Vector3(o.size, o.size, o.size) : toV3(o.size);
  return { c: Vector3.Zero(), h: new Vector3(Math.abs(s.x) / 2, Math.abs(s.y) / 2, Math.abs(s.z) / 2) };
}

/**
 * Axis-aligned box, 12 triangles, faces outward. Centred on the local origin
 * (`size`) or spanning `min`..`max`; then placed by `rot` / `at`.
 *   box(m, { size: [2, 1, 3], at: [0, 0.5, 0] }, WALL);
 *   box(m, { min: [-1, 0, -1], max: [1, 2.4, 1], faces: { ny: null, py: ROOF } }, WALL);
 */
export function box(m: SolidMesh, o: BoxOptions, p: Paint): void {
  const start = m.mark();
  const { c, h } = boxExtents(o, 'box');
  flatBoxFaces(m, c, h, h, o.faces, p);
  place(m, start, o);
}

/** The six flat faces of a box whose face rectangles span ±inner on their
 * in-plane axes and sit at ±outer along their normal. */
function flatBoxFaces(m: SolidMesh, c: Vector3, outer: Vector3, inner: Vector3, faces: BoxFaces | undefined, p: Paint): void {
  const O = [outer.x, outer.y, outer.z];
  const I = [inner.x, inner.y, inner.z];
  const C = [c.x, c.y, c.z];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (const sign of [1, -1]) {
      const key = FACE_KEYS[axis * 2 + (sign > 0 ? 0 : 1)];
      const fp = faces && key in faces ? faces[key] : p;
      if (!fp) continue;
      const corner = (su: number, sv: number): Vector3 => {
        const q = [0, 0, 0];
        q[axis] = C[axis] + sign * O[axis];
        q[u] = C[u] + su * I[u];
        q[v] = C[v] + sv * I[v];
        return new Vector3(q[0], q[1], q[2]);
      };
      const dir = [0, 0, 0];
      dir[axis] = sign;
      quadFacing(m, corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), new Vector3(dir[0], dir[1], dir[2]), fp);
    }
  }
}

export interface RoundedBoxOptions extends Placement {
  /** Full OUTER extents [x, y, z] (or a number), centred on the local origin;
   * or `min` + `max` corners. The rounding is cut INTO these extents. */
  size?: Vec3 | number;
  min?: Vec3;
  max?: Vec3;
  /** Edge/corner radius in meters, clamped to half the smallest extent. */
  radius: number;
  /**
   * Segments per 90° of rounding. 1 = a plain chamfer (cheapest; with a
   * smooth paint it already shades as a soft edge), 2 = default, 3–4 for
   * hero close-ups. Triangles = 12 + 24·s + 8·s².
   */
  segments?: number;
  /** Paint overrides for the six FLAT faces (the rounding keeps the main
   * paint); null leaves a face open. */
  faces?: BoxFaces;
}

/**
 * Box with truly rounded edges AND corners (quarter-cylinder edges, sphere-
 * octant corners) — the basic "toy block". With any non-faceted paint the
 * rounding shades as one soft surface while the faces stay flat (area-
 * weighted normals; the crease angle is raised internally as needed, even for
 * a one-segment chamfer).
 *   roundedBox(m, { size: [4, 2.4, 3], radius: 0.12, at: [0, 1.2, 0] }, WALL);
 */
export function roundedBox(m: SolidMesh, o: RoundedBoxOptions, pIn: Paint): void {
  const start = m.mark();
  const { c, h } = boxExtents(o, 'roundedBox');
  const r = Math.max(0, Math.min(o.radius, h.x, h.y, h.z));
  if (r <= 1e-9) {
    flatBoxFaces(m, c, h, h, o.faces, pIn);
    place(m, start, o);
    return;
  }
  const n = Math.max(1, Math.round(o.segments ?? 2));
  // The steepest neighbour angle inside the rounding: 90°/n between strips,
  // and for a single chamfer the corner facet sits 54.7° off the flat faces.
  const step = n === 1 ? 50.5 : 90 / n;
  const p = soften(pIn, step);
  const faces: BoxFaces | undefined = o.faces && { ...o.faces };
  if (faces) for (const k of FACE_KEYS) if (faces[k]) faces[k] = soften(faces[k] as Paint, step);
  const inner = new Vector3(h.x - r, h.y - r, h.z - r);
  flatBoxFaces(m, c, h, inner, faces, p);

  const I = [inner.x, inner.y, inner.z];
  const C = [c.x, c.y, c.z];
  const vec = (q: number[]): Vector3 => new Vector3(q[0], q[1], q[2]);

  // 12 edges: a quarter cylinder along axis a, at each sign pair of (b, c).
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const cAxis = (a + 2) % 3;
    for (const sb of [1, -1]) {
      for (const sc of [1, -1]) {
        for (let k = 0; k < n; k++) {
          const t0 = (k / n) * 90 * DEG;
          const t1 = ((k + 1) / n) * 90 * DEG;
          const pt = (t: number, sa: number): Vector3 => {
            const q = [0, 0, 0];
            q[a] = C[a] + sa * I[a];
            q[b] = C[b] + sb * (I[b] + r * Math.cos(t));
            q[cAxis] = C[cAxis] + sc * (I[cAxis] + r * Math.sin(t));
            return vec(q);
          };
          const mid = (t0 + t1) / 2;
          const d = [0, 0, 0];
          d[b] = sb * Math.cos(mid);
          d[cAxis] = sc * Math.sin(mid);
          quadFacing(m, pt(t0, -1), pt(t0, 1), pt(t1, 1), pt(t1, -1), vec(d), p);
        }
      }
    }
  }

  // 8 corners: a sphere octant as a triangular grid. Row k sits at polar
  // angle k/n·90° from the y axis and holds k + 1 points; its two boundary
  // meridians and its equator are sampled at exactly the edge strips' angles,
  // so everything welds.
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const rows: Vector3[][] = [];
        for (let k = 0; k <= n; k++) {
          const theta = (k / n) * 90 * DEG;
          const row: Vector3[] = [];
          for (let j = 0; j <= k; j++) {
            const phi = k === 0 ? 0 : (j / k) * 90 * DEG;
            row.push(
              new Vector3(
                c.x + sx * (inner.x + r * Math.sin(theta) * Math.cos(phi)),
                c.y + sy * (inner.y + r * Math.cos(theta)),
                c.z + sz * (inner.z + r * Math.sin(theta) * Math.sin(phi)),
              ),
            );
          }
          rows.push(row);
        }
        const out = new Vector3(sx, sy, sz);
        for (let k = 0; k < n; k++) {
          for (let j = 0; j <= k; j++) {
            triFacing(m, rows[k][j], rows[k + 1][j], rows[k + 1][j + 1], out, p);
            if (j < k) triFacing(m, rows[k][j], rows[k + 1][j + 1], rows[k][j + 1], out, p);
          }
        }
      }
    }
  }
  // The exact normal of a rounded box is known everywhere: straight out from
  // the nearest point of the inner box. Pinning it makes the six faces
  // PERFECTLY flat right up to where the rounding starts (averaged normals
  // leave them a degree or two of tilt at the corners, which a glossy
  // highlight shows as a soft bulge), and the rounding exactly round at any
  // segment count.
  if (p.smooth > 0) {
    const nrm = new Vector3();
    m.setNormals((q) => {
      nrm.set(
        q.x - Math.min(Math.max(q.x, c.x - inner.x), c.x + inner.x),
        q.y - Math.min(Math.max(q.y, c.y - inner.y), c.y + inner.y),
        q.z - Math.min(Math.max(q.z, c.z - inner.z), c.z + inner.z),
      );
      return nrm;
    }, start);
  }
  place(m, start, o);
}

// ---------------------------------------------------------------------------
// Revolve

export interface RevolveOptions extends Placement {
  /**
   * Profile as [radius, y] points, revolved about the local +Y axis.
   * ORIENTATION: the surface faces to the RIGHT of the direction of travel
   * along the profile when radius is drawn to the right and y up. So list an
   * outer wall BOTTOM → TOP (ascending y), a top cap from the rim inward to
   * the axis, a bottom cap from the axis outward — i.e. walk the solid's
   * silhouette counter-clockwise. A bore (inner wall facing the axis) runs
   * top → bottom. Points with radius 0 form poles / cap centres.
   */
  profile: readonly Vec2[];
  /** Segments around the swept arc (default 24). */
  segments?: number;
  /** Swept angle in DEGREES (default 360 = full turn). */
  arc?: number;
  /** Where the sweep starts, DEGREES: 0 = +x, 90 = +z (default 0). */
  arcStart?: number;
  /** Connect the last profile point back to the first (torus-like solids). */
  closed?: boolean;
  /** For arc < 360: close the two cut faces with the profile's own outline
   * (default true; the profile should then outline a closed area). */
  caps?: boolean;
  /** Paint of those cut faces (default: the main paint at band 0). */
  capPaint?: Paint;
  /**
   * Per-SEGMENT radius multiplier: `radiusScale(pointIndex, segment)` scales
   * profile point `pointIndex` for the whole of segment `segment`. Where two
   * neighbouring segments differ a radial step wall is added automatically,
   * so alternating 1 / 1.08 on the tread points of a tire profile gives
   * square-shouldered lugs, and a gear is one call. Give the scaled points
   * their own slanted shoulder (see the tire example in the test page): where
   * a scaled point and its unscaled profile neighbour lie on the same radial
   * line (a perfectly flat gear face), the step wall has zero area and the
   * faces meet in a T-junction — closed to the eye, but not edge-to-edge.
   * Lugs that step in OPPOSITE directions within one band (staggered left /
   * right rows meeting at the tread centre) get a correctly split wall, but
   * a cleaner mesh comes from an unscaled centre-groove point between rows.
   */
  radiusScale?: (pointIndex: number, segment: number) => number;
  /**
   * true (default): the surface is ROUND about the axis and shades smooth
   * there however few segments it has. false: the segments are real flat
   * sides — a hex nut, an octagonal post — and stay crisp wherever the
   * paint's crease angle says so (default paint: up to 8 sides).
   */
  round?: boolean;
}

/**
 * Surface of revolution about the local +Y axis (lathe). The paint may be a
 * function `(band, segment) => Paint | null`: band i is the strip between
 * profile points i and i + 1; null leaves a patch open.
 *   // a bevelled wheel rim, axis along +Y:
 *   revolve(m, { profile: [[0, -0.1], [0.3, -0.1], [0.34, -0.06], [0.34, 0.06], [0.3, 0.1], [0, 0.1]], segments: 24 }, RIM);
 * For an axle along X add `rot: [0, 0, -90]` (+Y → +X).
 * Shading: always smooth AROUND the axis (unless the paint is faceted);
 * corners of the profile are crisp or smooth by the paint's crease angle.
 * The optional 4th argument is for wrappers whose profile is itself a coarse
 * arc (degrees between neighbouring profile segments); the 5th lets a
 * wrapper that knows its exact surface (sphere, bevelled cylinder) pin the
 * true normal — as [radial, y] — at the start / end of each band.
 */
export function revolve(
  m: SolidMesh,
  o: RevolveOptions,
  pIn: PaintLike,
  profileStepDeg = 0,
  bandNormals?: (band: number, end: 0 | 1) => Vec2 | null,
): void {
  const start = m.mark();
  const prof = o.profile;
  const nb = prof.length;
  if (nb < 2) return;
  const n = Math.max(2, Math.round(o.segments ?? 24));
  const arc = Math.min(Math.abs(o.arc ?? 360), 360);
  // Around the axis the surface is round by definition: keep it smooth even
  // at low segment counts. (`profileStepDeg` lets the sphere / torus / bevel
  // wrappers say the same about their profile's own arc steps.)
  const p = softenPaint(pIn, Math.max((o.round ?? true) ? arc / n : 0, profileStepDeg));
  const full = arc >= 360 - 1e-9;
  const a0 = (o.arcStart ?? 0) * DEG;
  const scale = o.radiusScale;
  const cos: number[] = [];
  const sin: number[] = [];
  for (let s = 0; s <= n; s++) {
    // Reuse the first angle for the closing column so the seam is bit-exact.
    const a = full && s === n ? a0 : a0 + (arc * DEG * s) / n;
    cos.push(Math.cos(a));
    sin.push(Math.sin(a));
  }
  const pt = (b: number, s: number, seg: number): Vector3 => {
    const r = prof[b][0] * (scale ? scale(b, seg) : 1);
    return new Vector3(r * cos[s], prof[b][1], r * sin[s]);
  };
  const bands = o.closed ? nb : nb - 1;
  // Exact normals only for a plain round surface: lugs and flat-sided prisms
  // are not the surface the wrapper described.
  const pinNormals = !!bandNormals && !scale && (o.round ?? true);
  for (let b = 0; b < bands; b++) {
    const b1 = (b + 1) % nb;
    for (let s = 0; s < n; s++) {
      const fp = pickPaint(p, b, s);
      if (!fp) continue;
      const n0 = pinNormals ? bandNormals!(b, 0) : null;
      const n1 = pinNormals ? bandNormals!(b, 1) : null;
      if (n0 && n1) {
        m.quad(pt(b, s, s), pt(b1, s, s), pt(b1, s + 1, s), pt(b, s + 1, s), fp, undefined, [
          [n0[0] * cos[s], n0[1], n0[0] * sin[s]],
          [n1[0] * cos[s], n1[1], n1[0] * sin[s]],
          [n1[0] * cos[s + 1], n1[1], n1[0] * sin[s + 1]],
          [n0[0] * cos[s + 1], n0[1], n0[0] * sin[s + 1]],
        ]);
      } else {
        m.quad(pt(b, s, s), pt(b1, s, s), pt(b1, s + 1, s), pt(b, s + 1, s), fp);
      }
    }
  }
  if (scale) {
    // Radial step walls between neighbouring segments of different radius.
    for (let s = full ? 0 : 1; s < n; s++) {
      const prev = (s + n - 1) % n;
      const tangent = new Vector3(-sin[s], 0, cos[s]);
      for (let b = 0; b < bands; b++) {
        const b1 = (b + 1) % nb;
        const d0 = scale(b, s) - scale(b, prev);
        const d1 = scale(b1, s) - scale(b1, prev);
        if (Math.abs(d0) < 1e-9 && Math.abs(d1) < 1e-9) continue;
        const e0 = d0 * prof[b][0];
        const e1 = d1 * prof[b1][0];
        if (e0 * e1 < -1e-18) {
          // The two segments CROSS inside this band (staggered lugs): the
          // wall is a bow-tie, each half exposed toward its own lower
          // side. As one quad half of it would face backward.
          const k = e0 / (e0 - e1);
          const x = Vector3.Lerp(pt(b, s, prev), pt(b1, s, prev), k);
          const fa = pickPaint(p, b, e0 > 0 ? s : prev);
          const fb = pickPaint(p, b, e1 > 0 ? s : prev);
          if (fa) triFacing(m, pt(b, s, prev), x, pt(b, s, s), tangent.scale(e0 > 0 ? -1 : 1), fa);
          if (fb) triFacing(m, pt(b1, s, prev), x, pt(b1, s, s), tangent.scale(e1 > 0 ? -1 : 1), fb);
          continue;
        }
        // The wall is exposed toward the LOWER segment.
        const rise = e0 + e1;
        const fp = pickPaint(p, b, rise > 0 ? s : prev);
        if (!fp) continue;
        quadFacing(m, pt(b, s, prev), pt(b1, s, prev), pt(b1, s, s), pt(b, s, s), tangent.scale(rise > 0 ? -1 : 1), fp);
      }
    }
  }
  if (!full && (o.caps ?? true) && nb >= 3) {
    const capPaint = o.capPaint ?? pickPaint(p, 0, 0);
    if (capPaint) {
      const outline = (s: number, seg: number): Vector3[] => prof.map((_, b) => pt(b, s, seg));
      polygonFacing(m, outline(0, 0), new Vector3(sin[0], 0, -cos[0]), capPaint);
      polygonFacing(m, outline(n, n - 1), new Vector3(-sin[n], 0, cos[n]), capPaint);
    }
  }
  place(m, start, o);
}

// ---------------------------------------------------------------------------
// Cylinder family

export interface FrustumOptions extends Placement, AxisSpan {
  /** Radius at the −Y end and at the +Y end. */
  radiusBottom: number;
  radiusTop: number;
  /** Length along +Y; the shape is CENTRED on the local origin (y from
   * −height/2 to +height/2). Or use `from` + `to`. */
  height?: number;
  /** Segments around (default 16). */
  sides?: number;
  /** Which ends get a flat cap (default true = both). */
  caps?: boolean | 'top' | 'bottom';
  /** Round the rim where a cap meets the side: radius in meters (a number
   * for both ends, or per end). Needs the cap to exist. */
  bevel?: number | { top?: number; bottom?: number };
  /** Segments of that rounding (default 2; 1 = chamfer). */
  bevelSegments?: number;
  /** Paint for the flat cap discs (default: the main paint). */
  capPaint?: Paint;
  /** Partial sweep in DEGREES and its start (0 = +x, 90 = +z). The two flat
   * cut faces are closed with the full section whenever the shape has an end
   * cap; with `caps: false` it is an open curved panel and they are left
   * open too. Default 360. */
  arc?: number;
  arcStart?: number;
  /** false = `sides` are real flat faces (hex bolt, octagonal post) that stay
   * crisp, instead of a round surface. Bevels stay soft. Default true. */
  round?: boolean;
}

/**
 * Truncated cone along +Y. Paint as a function receives (i, segment) with
 * i = −1 on the bottom cap, 0 on the side (and bevels), +1 on the top cap.
 *   frustum(m, { radiusBottom: 0.5, radiusTop: 0.3, height: 1.2, bevel: 0.05 }, POT);
 */
export function frustum(m: SolidMesh, o: FrustumOptions, p: PaintLike): void {
  const start = m.mark();
  const { height, mat } = spanPlacement(o, 'frustum');
  const hh = height / 2;
  const rb = Math.max(0, o.radiusBottom);
  const rt = Math.max(0, o.radiusTop);
  const caps = o.caps ?? true;
  const capB = (caps === true || caps === 'bottom') && rb > 1e-9;
  const capT = (caps === true || caps === 'top') && rt > 1e-9;
  const side = Math.hypot(rt - rb, height);
  const bev = o.bevel ?? 0;
  const bevB = capB ? Math.min(typeof bev === 'number' ? bev : (bev.bottom ?? 0), rb, side / 2) : 0;
  const bevT = capT ? Math.min(typeof bev === 'number' ? bev : (bev.top ?? 0), rt, side / 2) : 0;
  const segs = Math.max(1, Math.round(o.bevelSegments ?? 2));

  const prof: Vec2[] = [];
  const kind: number[] = []; // per band: −1 bottom cap, 0 side, +1 top cap
  // Exact normal [radial, y] at each profile point as the SIDE / BEVEL sees
  // it: the cone's own normal along the side, turning through the bevel arc
  // until it meets the cap's.
  const pn: Vec2[] = [];
  const sl = Math.hypot(height, rb - rt) || 1;
  const sideN: Vec2 = [height / sl, (rb - rt) / sl];
  const turn = (from: Vec2, to: Vec2, k: number): Vec2 => {
    const a0 = Math.atan2(from[1], from[0]);
    let da = Math.atan2(to[1], to[0]) - a0;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    return [Math.cos(a0 + da * k), Math.sin(a0 + da * k)];
  };
  const B: Vec2 = [rb, -hh];
  const Tp: Vec2 = [rt, hh];
  if (capB) {
    prof.push([0, -hh]);
    kind.push(-1);
    pn.push([0, -1]);
  }
  if (bevB > 1e-9) {
    const arc = filletProfile([[0, -hh], B, Tp], bevB, segs).slice(1, -1);
    arc.forEach((q, i) => {
      prof.push(q);
      kind.push(0);
      pn.push(turn([0, -1], sideN, arc.length > 1 ? i / (arc.length - 1) : 1));
    });
  } else {
    prof.push(B);
    kind.push(0);
    pn.push(sideN);
  }
  if (bevT > 1e-9) {
    const arc = filletProfile([B, Tp, [0, hh]], bevT, segs).slice(1, -1);
    arc.forEach((q, i) => {
      prof.push(q);
      kind.push(0);
      pn.push(turn(sideN, [0, 1], arc.length > 1 ? i / (arc.length - 1) : 0));
    });
  } else {
    prof.push(Tp);
    kind.push(0);
    pn.push(sideN);
  }
  if (capT) {
    kind[prof.length - 1] = 1;
    prof.push([0, hh]);
    pn.push([0, 1]);
  }
  const capPaint = o.capPaint;
  // A bevel is meant to read as a soft rim: its arc steps (45° either side of
  // a single chamfer) count as curvature.
  const bevelStep = bevB > 1e-9 || bevT > 1e-9 ? (segs === 1 ? 45 : 90 / segs) : 0;
  const band: PaintLike = (b, seg) => (kind[b] !== 0 && capPaint ? capPaint : pickPaint(p, kind[b], seg));
  // The cut faces of a partial sweep are built here, from the FULL section
  // (axis to rim), not by revolve from the profile: with only one cap the
  // profile outlines half the section, with none it outlines nothing.
  revolve(
    m,
    { profile: prof, segments: o.sides ?? 16, arc: o.arc, arcStart: o.arcStart, caps: false, round: o.round },
    band,
    bevelStep,
    // Caps are exactly flat; side and bevel bands take the turning normal.
    // (A degenerate cone tip keeps derived normals: there is no one normal.)
    (b, end) => (kind[b] < 0 ? [0, -1] : kind[b] > 0 ? [0, 1] : rb > 1e-9 && rt > 1e-9 ? pn[b + end] : null),
  );
  const arc = Math.min(Math.abs(o.arc ?? 360), 360);
  if (arc < 360 - 1e-9 && (capB || capT)) {
    const section: Vec2[] = [...prof];
    if (!capT) section.push([0, hh]);
    if (!capB) section.unshift([0, -hh]);
    const cutPaint = capPaint ?? pickPaint(p, 0, 0);
    if (cutPaint) {
      const a0 = (o.arcStart ?? 0) * DEG;
      const a1 = a0 + arc * DEG;
      const face = (a: number, sign: number): void => {
        const c = Math.cos(a), s = Math.sin(a);
        polygonFacing(m, section.map((q) => new Vector3(q[0] * c, q[1], q[0] * s)), new Vector3(s * sign, 0, -c * sign), cutPaint);
      };
      face(a0, 1);
      face(a1, -1);
    }
  }
  if (mat) m.transform(mat, start);
}

export interface CylinderOptions extends Omit<FrustumOptions, 'radiusBottom' | 'radiusTop'> {
  radius: number;
}

/**
 * Cylinder along +Y, centred on the local origin — or between two points:
 *   cylinder(m, { radius: 0.5, height: 2, at: [0, 1, 0] }, P);
 *   cylinder(m, { from: [0, 0, 0], to: [1, 2, 0], radius: 0.05, sides: 8 }, STEEL);
 *   cylinder(m, { radius: 0.4, height: 0.3, bevel: 0.05, rot: [0, 0, 90] }, P);   // axis along x
 *   cylinder(m, { radius: 0.03, height: 0.02, sides: 6, round: false, bevel: 0.004 }, STEEL);  // hex nut
 * Options as `frustum` (sides, caps, bevel, capPaint, arc, round).
 */
export function cylinder(m: SolidMesh, o: CylinderOptions, p: PaintLike): void {
  frustum(m, { ...o, radiusBottom: o.radius, radiusTop: o.radius }, p);
}

export interface ConeOptions extends Omit<FrustumOptions, 'radiusBottom' | 'radiusTop'> {
  /** Base radius (at the −Y end / at `from`); the apex is at +Y / `to`. */
  radius: number;
}

/** Cone along +Y: base at −height/2 (or `from`), apex at +height/2 (or `to`). */
export function cone(m: SolidMesh, o: ConeOptions, p: PaintLike): void {
  frustum(m, { ...o, radiusBottom: o.radius, radiusTop: 0 }, p);
}

// ---------------------------------------------------------------------------
// Sphere family

export interface SphereOptions extends Placement {
  /** Uniform radius, or … */
  radius?: number;
  /** … per-axis radii [x, y, z] for an ellipsoid. */
  radii?: Vec3;
  /** Segments around the Y axis (default 16). */
  segments?: number;
  /** Latitude bands pole to pole (default segments / 2). */
  rings?: number;
  /** Keep only a latitude range in DEGREES, −90 (south pole) … +90 (north
   * pole): [0, 90] is a dome, [−90, 30] a bowl-cut. */
  latitude?: readonly [number, number];
  /** Close the flat cut(s) of a latitude range (default true). */
  caps?: boolean;
  capPaint?: Paint;
}

/**
 * UV sphere / ellipsoid / dome, poles on the Y axis, centred on the local
 * origin. Paint function: (latitude band from the south, segment).
 *   sphere(m, { radius: 0.5, at: [0, 0.5, 0] }, P);
 *   sphere(m, { radii: [1, 0.6, 1.4], segments: 20 }, P);
 *   sphere(m, { radius: 1, latitude: [0, 90] }, P);            // dome with a flat base
 */
export function sphere(m: SolidMesh, o: SphereOptions, p: PaintLike): void {
  const start = m.mark();
  const segments = Math.max(3, Math.round(o.segments ?? 16));
  const lat0 = Math.max(-90, o.latitude ? o.latitude[0] : -90);
  const lat1 = Math.min(90, o.latitude ? o.latitude[1] : 90);
  const fullRings = Math.max(2, Math.round(o.rings ?? segments / 2));
  const rings = Math.max(1, Math.round((fullRings * (lat1 - lat0)) / 180));
  const prof: Vec2[] = [];
  const caps = o.caps ?? true;
  let offset = 0;
  const cutBottom = lat0 > -90 + 1e-6;
  const cutTop = lat1 < 90 - 1e-6;
  if (cutBottom && caps) {
    prof.push([0, Math.sin(lat0 * DEG)]);
    offset = 1;
  }
  for (let i = 0; i <= rings; i++) {
    const lat = (lat0 + ((lat1 - lat0) * i) / rings) * DEG;
    // Exact zero radius at the poles so the pole is one welded point.
    const pole = (i === 0 && !cutBottom) || (i === rings && !cutTop);
    prof.push([pole ? 0 : Math.cos(lat), Math.sin(lat)]);
  }
  if (cutTop && caps) prof.push([0, Math.sin(lat1 * DEG)]);
  const lastBand = prof.length - 2;
  revolve(
    m,
    { profile: prof, segments },
    (band, seg) => {
      const isCap = (offset === 1 && band === 0) || (cutTop && caps && band === lastBand);
      if (isCap) return o.capPaint ?? pickPaint(p, Math.max(0, Math.min(rings - 1, band - offset)), seg);
      return pickPaint(p, band - offset, seg);
    },
    (lat1 - lat0) / rings,
    // A sphere's normal is its position; the flat cuts are flat. (Pinned on
    // the UNIT sphere — the scale below carries normals correctly onto an
    // ellipsoid.)
    (band, end) => {
      if (offset === 1 && band === 0) return [0, -1];
      if (cutTop && caps && band === lastBand) return [0, 1];
      const lat = (lat0 + ((lat1 - lat0) * (band - offset + end)) / rings) * DEG;
      return [Math.cos(lat), Math.sin(lat)];
    },
  );
  const r = o.radii ? toV3(o.radii) : new Vector3(o.radius ?? 1, o.radius ?? 1, o.radius ?? 1);
  m.transform(Matrix.Scaling(r.x, r.y, r.z), start);
  place(m, start, o);
}

export interface IcosphereOptions extends Placement {
  radius?: number;
  /** Per-axis radii [x, y, z] instead of `radius`. */
  radii?: Vec3;
  /** 0 = icosahedron (20 tris), 1 = 80, 2 = 320, 3 = 1280, 4 = 5120. */
  subdivisions?: number;
}

/**
 * Geodesic sphere: evenly sized triangles with no poles — the right base for
 * faceted rocks and foliage blobs (paint with `smooth: 0`, then
 * `m.displace(...)`), and for smooth balls without pole pinching. Paint
 * function: (0, faceIndex).
 *   const s = m.mark();
 *   icosphere(m, { radii: [1.2, 0.8, 1], subdivisions: 1 }, paint(STONE, { smooth: 0 }));
 *   m.displace((q) => (noise3(q.x * 1.7, q.y * 1.7, q.z * 1.7) - 0.5) * 0.35, s);
 */
export function icosphere(m: SolidMesh, o: IcosphereOptions, p: PaintLike): void {
  const start = m.mark();
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts = raw.map((q) => new Vector3(q[0], q[1], q[2]).normalize());
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  let tris: Vector3[][] = faces.map((f) => [verts[f[0]], verts[f[1]], verts[f[2]]]);
  const levels = Math.max(0, Math.min(6, Math.round(o.subdivisions ?? 1)));
  // (a + b) / 2 is symmetric in its arguments, so the two triangles sharing
  // an edge compute bit-identical midpoints and the sphere stays welded.
  const mid = (a: Vector3, b: Vector3): Vector3 => new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2).normalize();
  for (let l = 0; l < levels; l++) {
    const next: Vector3[][] = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  // A raw icosahedron's faces are 41.8° apart; one subdivision halves that.
  const soft = softenPaint(p, levels === 0 ? 42 : levels === 1 ? 22 : 0);
  tris.forEach(([a, b, c], i) => {
    const fp = pickPaint(soft, 0, i);
    if (!fp) return;
    // Face outward whatever the table's handedness: compare with the centroid.
    triFacing(m, a, b, c, new Vector3(a.x + b.x + c.x, a.y + b.y + c.y, a.z + b.z + c.z), fp);
  });
  const r = o.radii ? toV3(o.radii) : new Vector3(o.radius ?? 1, o.radius ?? 1, o.radius ?? 1);
  m.transform(Matrix.Scaling(r.x, r.y, r.z), start);
  place(m, start, o);
}

export interface CapsuleOptions extends Placement, AxisSpan {
  radius: number;
  /** TOTAL length tip to tip along +Y (≥ 2·radius), centred on the origin.
   * Or `from` + `to` = the two TIPS. */
  height?: number;
  /** Segments around (default 12). */
  sides?: number;
  /** Bands per hemisphere (default 4). */
  rings?: number;
}

/**
 * Capsule (cylinder with hemispherical ends) along +Y. Paint function:
 * (band from the bottom tip, segment).
 *   capsule(m, { from: [0, 0.2, 0], to: [0.3, 1.1, 0], radius: 0.09 }, LIMB);
 */
export function capsule(m: SolidMesh, o: CapsuleOptions, p: PaintLike): void {
  const start = m.mark();
  const { height, mat } = spanPlacement(o, 'capsule');
  const r = Math.min(o.radius, height / 2);
  const hc = height / 2 - r;
  const rings = Math.max(1, Math.round(o.rings ?? 4));
  const prof: Vec2[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = (-90 + (90 * i) / rings) * DEG;
    prof.push([i === 0 ? 0 : Math.cos(a) * r, -hc + Math.sin(a) * r]);
  }
  for (let i = hc > 1e-9 ? 0 : 1; i <= rings; i++) {
    const a = ((90 * i) / rings) * DEG;
    prof.push([i === rings ? 0 : Math.cos(a) * r, hc + Math.sin(a) * r]);
  }
  revolve(m, { profile: prof, segments: o.sides ?? 12 }, p, 90 / rings);
  if (mat) m.transform(mat, start);
}

export interface TorusOptions extends Placement {
  /** Distance from the torus centre to the centre of the tube. */
  radius: number;
  /** Radius of the tube itself. */
  tube: number;
  /** Segments around the main ring (default 24; counted over `arc`). */
  segments?: number;
  /** Segments around the tube (default 10). */
  sides?: number;
  /** Partial ring: swept DEGREES and start (0 = +x, 90 = +z). Default 360. */
  arc?: number;
  arcStart?: number;
  /** Close the ends of a partial ring (default true). */
  caps?: boolean;
  /** Squash/stretch the tube cross-section along the axis (default 1). */
  tubeScaleY?: number;
}

/**
 * Torus lying in the local XZ plane (axis = +Y), centred on the origin; with
 * `arc` < 360 an elbow / handle / arch. Paint function: (side, segment).
 *   torus(m, { radius: 0.3, tube: 0.04, rot: [90, 0, 0] }, P);        // ring facing ±z
 *   torus(m, { radius: 0.5, tube: 0.06, arc: 180, rot: [-90, 0, 0] }, P); // arch standing up
 */
export function torus(m: SolidMesh, o: TorusOptions, p: PaintLike): void {
  const sides = Math.max(3, Math.round(o.sides ?? 10));
  const prof: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    prof.push([o.radius + Math.cos(a) * o.tube, Math.sin(a) * o.tube * (o.tubeScaleY ?? 1)]);
  }
  revolve(
    m,
    { profile: prof, closed: true, segments: o.segments ?? 24, arc: o.arc, arcStart: o.arcStart, caps: o.caps, at: o.at, rot: o.rot },
    p,
    360 / sides,
  );
}
