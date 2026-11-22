import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { softenPaint } from './SolidMesh';
import type { Paint, SolidMesh } from './SolidMesh';
import { DEG, anyPerpendicular, toV3, toV3s } from './math';
import type { Placement, Vec2, Vec3 } from './math';
import { catmullRomPoint, filletPath, rotateBetween } from './paths';
import { loopNormal, place, polygonFacing } from './primitives';
import { circleRing, resampleRing3 } from './rings';
import { signedArea } from './triangulate';

/**
 * Swept and lofted surfaces: `tube` (round bar along a path, with automatic
 * corner fillets), `sweep` (any 2D section along a path) and `loft` (skin
 * through a list of cross-section rings).
 */

/**
 * Paint for swept / lofted surfaces: one Paint, or
 * `(u, v, i, j) => Paint | null` evaluated per quad patch at its centre:
 * u = 0..1 ALONG the path / loft (start → end), v = 0..1 AROUND the section
 * (from the ring's first point, in ring order); i, j = the patch's integer
 * indices along / around. Return null to leave the patch open (window and
 * cockpit cut-outs).
 */
export type PatchPaint = Paint | ((u: number, v: number, i: number, j: number) => Paint | null);

function patchPaint(p: PatchPaint, u: number, v: number, i: number, j: number): Paint | null {
  return typeof p === 'function' ? p(u, v, i, j) : p;
}

/** Skin consecutive rings (all the same point count). `outward` tells which
 * side faces out: +1 when ring order × travel direction is already outward. */
function skin(
  m: SolidMesh,
  rings: Vector3[][],
  closedRing: boolean,
  loop: boolean,
  flip: boolean,
  p: PatchPaint,
  us?: number[],
): void {
  const count = rings.length;
  const n = rings[0].length;
  const spans = loop ? count : count - 1;
  const around = closedRing ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const A = rings[i];
    const B = rings[(i + 1) % count];
    // `us` = lengthwise parameter of each ring (plus a final 1 for a loop).
    const u = us ? (us[i] + us[i + 1]) / 2 : (i + 0.5) / spans;
    for (let j = 0; j < around; j++) {
      const fp = patchPaint(p, u, (j + 0.5) / around, i, j);
      if (!fp) continue;
      const k = (j + 1) % n;
      if (flip) m.quad(A[j], B[j], B[k], A[k], fp);
      else m.quad(A[j], A[k], B[k], B[j], fp);
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep / tube

export interface SweepOptions extends Placement {
  /** Path points (≥ 2). */
  path: readonly Vec3[];
  /**
   * Cross-section as a 2D ring (see rings.ts), in meters. Its x axis is laid
   * along the path frame's NORMAL (the `up` direction), its y axis along the
   * binormal. Winding does not matter (normalised internally).
   * A FUNCTION `(t, i) => ring` gives a different section at every path
   * point (t = 0..1 by arc length, i = point index after filleting) — a
   * fender whose lip grows, a bumper that tapers and changes shape. Every
   * ring it returns must have the same point count, start at the same clock
   * position and run the same way round (the rings.ts generators do).
   */
  section: readonly Vec2[] | ((t: number, i: number) => readonly Vec2[]);
  /**
   * false = the section is an OPEN polyline: the sweep is a strip (fender,
   * trim band, ribbon), not a tube, and gets no caps. It faces to the RIGHT
   * of the section's drawing direction (section x drawn right, y up) — the
   * side that would be "outside" if the polyline were part of a
   * counter-clockwise ring. `flip` turns it over; `thicken` gives it body.
   */
  closedSection?: boolean;
  /** Reverse the facing (inside surfaces, or an open strip the wrong way). */
  flip?: boolean;
  /** Round the path's corners with this radius (meters) before sweeping, so
   * bends are smooth arcs instead of mitered kinks. 0 = keep the kinks. */
  fillet?: number;
  /** Segments per fillet arc (default: one per 15° of bend). */
  filletSegments?: number;
  /** Close the path into a loop (no caps). */
  closed?: boolean;
  /** Flat end caps on an open path (default true). */
  caps?: boolean;
  capPaint?: Paint;
  /** Section scale along the path: a number, per-ORIGINAL-path-point values
   * (interpolated by arc length), or a function of t = 0..1 along the path.
   * Scale and twist are sampled AT THE PATH POINTS only — a straight run
   * needs intermediate points to show them (`linePath(a, b, 12)`). */
  scale?: number | readonly number[] | ((t: number) => number);
  /** Twist of the section about the path in DEGREES as a function of t. */
  twist?: (t: number) => number;
  /** Direction the section's x axis should point at the start (projected
   * perpendicular to the path). Default: a deterministic perpendicular. */
  up?: Vec3;
}

/**
 * Sweep a 2D section along a 3D path with twist-free (parallel-transported)
 * frames and true mitre joints (the section is sheared onto the bisector
 * plane at every bend, so thickness is constant through corners).
 *   sweep(m, { path: railPts, section: roundedRectRing(0.08, 0.04, 0.01, 2), up: [0, 1, 0] }, RAIL);
 */
export function sweep(m: SolidMesh, o: SweepOptions, p: PatchPaint): void {
  const start = m.mark();
  const closed = o.closed ?? false;
  const original = toV3s(o.path);
  let path = o.fillet && o.fillet > 0 ? filletPath(original, o.fillet, { segments: o.filletSegments, closed }) : original;
  if (!(o.fillet && o.fillet > 0) && original.length > 2) {
    // A mitre joint stretches the section by 1 / cos(bend / 2): past ~120°
    // that is a spike shooting out of the corner. Hairpins get a small
    // automatic bend instead (about the section's own radius), which is what
    // a bent bar does anyway; gentler corners keep their true mitre.
    let reach = 0;
    const probe = typeof o.section === 'function' ? o.section(0.5, 0) : o.section;
    for (const q of probe) reach = Math.max(reach, Math.hypot(q[0], q[1]));
    const sc = o.scale;
    reach *= sc === undefined ? 1 : typeof sc === 'number' ? sc : typeof sc === 'function' ? sc(0.5) : Math.max(...sc);
    if (reach > 1e-9) path = filletPath(original, reach, { segments: 4, closed, minBendDeg: 120 });
  }
  // Zero-length steps have no direction; drop them.
  path = path.filter((q, i) => i === 0 || Vector3.DistanceSquared(q, path[i - 1]) > 1e-16);
  if (closed && path.length > 2 && Vector3.DistanceSquared(path[0], path[path.length - 1]) < 1e-16) path.pop();
  const n = path.length;
  if (n < 2) return;

  const closedSection = o.closedSection ?? true;
  // Closed sections are normalised to counter-clockwise; an open one keeps
  // its drawing direction (that is what decides its facing).
  const normalise = (ring: readonly Vec2[]): Vec2[] => {
    const r = ring.map((q) => [q[0], q[1]] as const);
    return closedSection && signedArea(r) < 0 ? r.reverse() : r;
  };
  const sectionFn = typeof o.section === 'function' ? o.section : null;
  const fixedSection = sectionFn ? null : normalise(o.section as readonly Vec2[]);
  let sectionCount = fixedSection ? fixedSection.length : -1;

  // Arc-length parameter of every path point.
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Vector3.Distance(path[i - 1], path[i]));
  const total = closed ? cum[n - 1] + Vector3.Distance(path[n - 1], path[0]) : cum[n - 1];
  const tAt = (i: number): number => (total > 0 ? cum[i] / total : 0);
  const scaleAt = scaleFunction(o.scale, original, closed);

  const segCount = closed ? n : n - 1;
  const dirs: Vector3[] = [];
  for (let i = 0; i < segCount; i++) dirs.push(path[(i + 1) % n].subtract(path[i]).normalize());
  const dIn = (i: number): Vector3 => (closed ? dirs[(i + n - 1) % n] : dirs[Math.max(i - 1, 0)]);
  const dOut = (i: number): Vector3 => (closed ? dirs[i] : dirs[Math.min(i, segCount - 1)]);

  // Parallel transport: normal[i] is perpendicular to dIn(i).
  const normals: Vector3[] = [];
  let nrm: Vector3 | null = null;
  if (o.up) {
    const h = toV3(o.up);
    const proj = h.subtract(dIn(0).scale(Vector3.Dot(h, dIn(0))));
    if (proj.lengthSquared() > 1e-12) nrm = proj.normalize();
  }
  if (!nrm) nrm = anyPerpendicular(dIn(0));
  normals.push(nrm);
  for (let i = 1; i < n; i++) {
    let next = rotateBetween(normals[i - 1], dIn(i - 1), dIn(i));
    next = next.subtract(dIn(i).scale(Vector3.Dot(next, dIn(i)))).normalize();
    normals.push(next);
  }
  // A closed loop generally comes back rotated by some angle (holonomy);
  // spread that angle over the loop so the last ring meets the first.
  let closure = 0;
  if (closed) {
    let back = rotateBetween(normals[n - 1], dIn(n - 1), dIn(0));
    back = back.subtract(dIn(0).scale(Vector3.Dot(back, dIn(0)))).normalize();
    const b0 = Vector3.Cross(normals[0], dIn(0));
    closure = Math.atan2(Vector3.Dot(back, b0), Vector3.Dot(back, normals[0]));
  }

  const rings: Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const t = tAt(i);
    const d = dIn(i);
    const twist = (o.twist ? o.twist(t) * DEG : 0) - (closed ? (closure * i) / n : 0);
    const nr = normals[i];
    const bi = Vector3.Cross(nr, d);
    const cosT = Math.cos(twist);
    const sinT = Math.sin(twist);
    // Mitre plane normal = bisector of the incoming and outgoing directions.
    const mitre = d.add(dOut(i));
    if (mitre.lengthSquared() < 1e-9) mitre.copyFrom(d);
    mitre.normalize();
    // Clamped so a hairpin cannot stretch the section to infinity.
    const denom = Math.max(Vector3.Dot(d, mitre), 0.35);
    const s = scaleAt(t);
    const section = fixedSection ?? normalise(sectionFn!(t, i));
    if (sectionCount < 0) sectionCount = section.length;
    if (section.length !== sectionCount) {
      throw new Error(`sweep: the section function returned ${section.length} points at t = ${t.toFixed(3)}, ${sectionCount} before — every section needs the same count`);
    }
    const ring: Vector3[] = [];
    for (const q of section) {
      const sx = (q[0] * cosT - q[1] * sinT) * s;
      const sy = (q[0] * sinT + q[1] * cosT) * s;
      const ox = nr.x * sx + bi.x * sy;
      const oy = nr.y * sx + bi.y * sy;
      const oz = nr.z * sx + bi.z * sy;
      // Slide along the incoming direction onto the mitre plane.
      const k = -(ox * mitre.x + oy * mitre.y + oz * mitre.z) / denom;
      ring.push(new Vector3(path[i].x + ox + d.x * k, path[i].y + oy + d.y * k, path[i].z + oz + d.z * k));
    }
    rings.push(ring);
  }
  // Section CCW in (normal, binormal) with binormal = normal × tangent: the
  // quad (A[j], A[j+1], B[j+1], B[j]) then faces INWARD, so skin flipped.
  skin(m, rings, closedSection, closed, !(o.flip ?? false), p);
  if (!closed && closedSection && (o.caps ?? true)) {
    const cp = o.capPaint ?? patchPaint(p, 0, 0, 0, 0);
    const cp2 = o.capPaint ?? patchPaint(p, 1, 0, segCount - 1, 0);
    if (cp) polygonFacing(m, rings[0], dirs[0].scale(-1), cp);
    if (cp2) polygonFacing(m, rings[n - 1], dirs[segCount - 1], cp2);
  }
  place(m, start, o);
}

function scaleFunction(
  s: number | readonly number[] | ((t: number) => number) | undefined,
  original: Vector3[],
  closed: boolean,
): (t: number) => number {
  if (s === undefined) return () => 1;
  if (typeof s === 'number') return () => s;
  if (typeof s === 'function') return s;
  // Per-point values keyed by the ORIGINAL polyline's arc length, so they
  // still land where the author put them after fillets added points.
  const cum: number[] = [0];
  for (let i = 1; i < original.length; i++) cum.push(cum[i - 1] + Vector3.Distance(original[i - 1], original[i]));
  let total = cum[cum.length - 1];
  if (closed) total += Vector3.Distance(original[original.length - 1], original[0]);
  return (t: number): number => {
    const d = t * total;
    for (let i = 1; i < cum.length; i++) {
      if (d <= cum[i]) {
        const span = cum[i] - cum[i - 1];
        const k = span > 1e-12 ? (d - cum[i - 1]) / span : 0;
        return (s[i - 1] ?? 1) + ((s[i] ?? 1) - (s[i - 1] ?? 1)) * k;
      }
    }
    if (closed) {
      const span = total - cum[cum.length - 1];
      const k = span > 1e-12 ? (d - cum[cum.length - 1]) / span : 0;
      return (s[cum.length - 1] ?? 1) + ((s[0] ?? 1) - (s[cum.length - 1] ?? 1)) * k;
    }
    return s[s.length - 1] ?? 1;
  };
}

export interface TubeOptions extends Placement {
  /** Centre-line points (≥ 2). */
  path: readonly Vec3[];
  /** Tube radius in meters: a number, one value per ORIGINAL path point
   * (interpolated by arc length), or a function of t = 0..1 along the path.
   * Sampled at the path points: give a tapering straight tube a few
   * intermediate points (`linePath(a, b, 6)`). */
  radius: number | readonly number[] | ((t: number) => number);
  /** Segments around (default 8). */
  sides?: number;
  /** Corner radius for automatic bends (meters, measured at the centre line;
   * reduced automatically where segments are too short). Default 0 = mitred. */
  fillet?: number;
  /** Segments per fillet arc (default: one per 15° of bend). */
  filletSegments?: number;
  /** Close the path into a loop. */
  closed?: boolean;
  /**
   * End treatment on an open path: true (default) = flat caps, false = open,
   * 'round' = hemispherical ends that extend PAST the path ends by the
   * radius.
   */
  caps?: boolean | 'round';
  capPaint?: Paint;
}

/**
 * Round bar along a 3D path: roll cages, handrails, wishbones, pipes, stems,
 * coil springs (`helixPath`), cables. Twist-free frames; `fillet` turns the
 * polyline's corners into smooth bends.
 *   // a roll hoop from four points, 6 cm radius bends:
 *   tube(m, { path: [[-0.6, 0, 0], [-0.55, 1.1, 0], [0.55, 1.1, 0], [0.6, 0, 0]], radius: 0.03, fillet: 0.25 }, CAGE);
 *   // a tapering branch:
 *   tube(m, { path: catmullRomPath(pts, 6), radius: (t) => 0.12 * (1 - 0.7 * t), sides: 6 }, BARK);
 */
export function tube(m: SolidMesh, o: TubeOptions, pIn: PatchPaint): void {
  const sides = Math.max(3, Math.round(o.sides ?? 8));
  // A tube is round whatever its side count (unless the paint is faceted).
  const p = softenPaint(pIn, 360 / sides);
  const closed = o.closed ?? false;
  if (o.caps !== 'round' || closed) {
    sweep(
      m,
      {
        path: o.path,
        section: circleRing(1, sides),
        scale: o.radius,
        fillet: o.fillet,
        filletSegments: o.filletSegments,
        closed,
        caps: o.caps !== false,
        capPaint: o.capPaint,
        at: o.at,
        rot: o.rot,
      },
      p,
    );
    return;
  }
  // Round ends: extend the (filleted) path past both ends with a few rings
  // whose radius follows a quarter circle down to a point.
  const original = toV3s(o.path);
  const path = o.fillet && o.fillet > 0 ? filletPath(original, o.fillet, { segments: o.filletSegments }) : original;
  if (path.length < 2) return;
  const radiusAt = scaleFunction(o.radius, original, false);
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Vector3.Distance(path[i - 1], path[i]));
  const total = cum[cum.length - 1] || 1;
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const steps = Math.max(2, Math.round(sides / 3));
  const r0 = radiusAt(0);
  const r1 = radiusAt(1);
  const d0 = path[0].subtract(path[1]).normalize();
  const d1 = path[path.length - 1].subtract(path[path.length - 2]).normalize();
  for (let k = steps; k >= 1; k--) {
    const a = (k / steps) * 90 * DEG;
    pts.push(path[0].add(d0.scale(Math.sin(a) * r0)));
    radii.push(k === steps ? 0 : Math.cos(a) * r0);
  }
  for (let i = 0; i < path.length; i++) {
    pts.push(path[i]);
    radii.push(radiusAt(cum[i] / total));
  }
  for (let k = 1; k <= steps; k++) {
    const a = (k / steps) * 90 * DEG;
    pts.push(path[path.length - 1].add(d1.scale(Math.sin(a) * r1)));
    radii.push(k === steps ? 0 : Math.cos(a) * r1);
  }
  // Index-keyed radii (a function of t would be re-parameterised by the
  // extended path's length and miss the ring positions).
  const start = m.mark();
  sweepIndexed(m, pts, radii, sides, p);
  place(m, start, o);
}

/** Minimal circular sweep with one radius per path point (no mitre shear —
 * used for the round-capped tube, whose path is already filleted). */
function sweepIndexed(m: SolidMesh, path: Vector3[], radii: number[], sides: number, p: PatchPaint): void {
  const n = path.length;
  const rings: Vector3[][] = [];
  let prevT: Vector3 | null = null;
  let nrm: Vector3 | null = null;
  for (let i = 0; i < n; i++) {
    const t = path[Math.min(i + 1, n - 1)].subtract(path[Math.max(i - 1, 0)]).normalize();
    nrm = nrm && prevT ? rotateBetween(nrm, prevT, t) : anyPerpendicular(t);
    nrm = nrm.subtract(t.scale(Vector3.Dot(nrm, t))).normalize();
    prevT = t;
    const bi = Vector3.Cross(nrm, t);
    const ring: Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const c = Math.cos(a) * radii[i];
      const sn = Math.sin(a) * radii[i];
      ring.push(new Vector3(path[i].x + nrm.x * c + bi.x * sn, path[i].y + nrm.y * c + bi.y * sn, path[i].z + nrm.z * c + bi.z * sn));
    }
    rings.push(ring);
  }
  skin(m, rings, true, false, true, p);
}

// ---------------------------------------------------------------------------
// Loft

export interface LoftOptions extends Placement {
  /**
   * Cross-section stations in order, each a ring of 3D points (use `ringXY`,
   * `ringXZ` or `placeRing` on the 2D generators in rings.ts). Point j of one
   * ring connects to point j of the next, so all rings should start at the
   * same "clock position" and run the same way round — the generators
   * guarantee that. A ring whose points all coincide is a TIP (nose cone
   * point). Which way the rings wind does not matter: the surface is
   * oriented to face AWAY from the loft's own axis automatically (set `flip`
   * for an inside surface).
   */
  rings: readonly (readonly Vec3[])[];
  /**
   * Smooth subdivision: number of skin spans generated between consecutive
   * stations by Catmull-Rom interpolation THROUGH the stations (default 4).
   * 1 = straight ruled surface between stations (walls, tapered boxes).
   */
  subdivisions?: number;
  /** Resample every station to this many points around (by arc length from
   * its first point) — required when stations have different point counts. */
  around?: number;
  /** Station indices where the lengthwise curve has a hard break (a crisp
   * shoulder line) instead of flowing smoothly through. */
  sharp?: readonly number[];
  /** Each ring is a closed loop (default true). false = an open strip (a
   * fender, a ribbon). An open strip cannot be auto-oriented: it faces along
   * (direction along the ring) × (direction of travel between stations), a
   * plain cross product — set `flip` if that turns out to be the back. */
  closedRing?: boolean;
  /** Connect the last station back to the first (a ring-shaped loft). */
  loop?: boolean;
  /** Flat caps on the first / last station (default false). */
  caps?: boolean | 'start' | 'end';
  capPaint?: Paint;
  /** Reverse the facing (inside surfaces; or to fix an open strip). */
  flip?: boolean;
}

/**
 * Skin a smooth shell through a few cross-section stations — the workhorse
 * for car bodies, pods, fenders, trunks, roofs. Give 4–8 stations, get a
 * smooth surface. Paint function `(u, v, i, j)`: u along the loft 0..1,
 * v around the ring 0..1 from the ring's first point; null = open patch.
 *   // a 3 m pod along z: point → squircle → squircle → small tail
 *   const sec = (w: number, h: number) => superellipseRing(w / 2, h / 2, 3.2, 20);
 *   loft(m, {
 *     rings: [
 *       ringXY(sec(0.02, 0.02), 1.5, 0, 0.45),
 *       ringXY(sec(0.9, 0.5), 0.9, 0, 0.5),
 *       ringXY(sec(1.2, 0.7), -0.2, 0, 0.55),
 *       ringXY(sec(0.7, 0.45), -1.5, 0, 0.6),
 *     ],
 *     caps: true,
 *   }, (u, v) => (v > 0.5 ? BELLY : BODY));      // v > 0.5 = lower half (y < 0)
 */
export function loft(m: SolidMesh, o: LoftOptions, p: PatchPaint): void {
  const start = m.mark();
  let stations = o.rings.map((r) => toV3s(r));
  if (stations.length < 2) return;
  const closedRing = o.closedRing ?? true;
  if (o.around !== undefined) {
    const count = Math.round(o.around);
    if (!(count >= (closedRing ? 3 : 2))) throw new Error(`loft: 'around' must be at least ${closedRing ? 3 : 2}, got ${o.around}`);
    stations = stations.map((r) => (closedRing ? resampleRing3(r, count) : resampleOpen(r, count)));
  }
  const n = stations[0].length;
  for (const r of stations) {
    if (r.length !== n) throw new Error(`loft: rings have different point counts (${r.length} vs ${n}); set 'around' to resample`);
  }
  const loop = o.loop ?? false;
  const sub = Math.max(1, Math.round(o.subdivisions ?? 4));
  const count = stations.length;
  const sharp = new Set(o.sharp ?? []);

  // Knot interval between stations a and b: sqrt of the mean point distance
  // (centripetal parameterisation, shared by all points of the ring so the
  // interpolated rings stay coherent).
  const knot = (a: Vector3[], b: Vector3[]): number => {
    let d = 0;
    for (let j = 0; j < n; j++) d += Vector3.Distance(a[j], b[j]);
    return Math.sqrt(d / n);
  };
  const stationAt = (i: number): Vector3[] | null => {
    if (loop) return stations[((i % count) + count) % count];
    return i >= 0 && i < count ? stations[i] : null;
  };

  const rings: Vector3[][] = [];
  // Lengthwise parameter of every generated ring: stations are evenly spaced
  // in u, whatever the subdivision of each span.
  const us: number[] = [];
  const spans = loop ? count : count - 1;
  for (let i = 0; i < spans; i++) {
    const r1 = stations[i];
    const r2 = stations[(i + 1) % count];
    // Neighbours for the spline; a sharp station or the end of the loft
    // reflects the span instead (= a natural, straight-leaving end).
    const r0 = sharp.has(i) ? null : stationAt(i - 1);
    const r3 = sharp.has((i + 1) % count) ? null : stationAt(i + 2);
    // A span with no neighbour on either side is a straight ruled surface;
    // subdividing it would only add coplanar triangles.
    const steps = !r0 && !r3 ? 1 : sub;
    for (let k = 0; k < steps; k++) {
      us.push((i + k / steps) / spans);
      if (k === 0) {
        rings.push(r1);
        continue;
      }
      const d12 = knot(r1, r2);
      const d01 = r0 ? knot(r0, r1) : d12;
      const d23 = r3 ? knot(r2, r3) : d12;
      const ring: Vector3[] = [];
      for (let j = 0; j < n; j++) {
        const p1 = r1[j];
        const p2 = r2[j];
        const p0 = r0 ? r0[j] : p1.scale(2).subtract(p2);
        const p3 = r3 ? r3[j] : p2.scale(2).subtract(p1);
        ring.push(catmullRomPoint(p0, p1, p2, p3, d01, d12, d23, k / steps));
      }
      rings.push(ring);
    }
  }
  if (!loop) rings.push(stations[count - 1]);
  us.push(1);

  // Orientation: a closed ring whose Newell normal points ALONG the travel
  // direction skins outward with (A[j], A[j+1], B[j+1], B[j]); otherwise the
  // order must be flipped. Summed over the loft so tips and wobbly stations
  // cannot fool it.
  let along = 0;
  if (closedRing) {
    const centroid = (r: Vector3[]): Vector3 => {
      const c = Vector3.Zero();
      for (const q of r) c.addInPlace(q);
      return c.scaleInPlace(1 / r.length);
    };
    const cs = rings.map(centroid);
    for (let i = 0; i < rings.length; i++) {
      const a = cs[Math.max(i - 1, 0)];
      const b = cs[Math.min(i + 1, rings.length - 1)];
      along += Vector3.Dot(loopNormal(rings[i]), b.subtract(a));
    }
  } else {
    along = 1;
  }
  const flip = along < 0 !== (o.flip ?? false);
  skin(m, rings, closedRing, loop, flip, p, us);

  if (!loop && closedRing && o.caps) {
    const capStart = o.caps === true || o.caps === 'start';
    const capEnd = o.caps === true || o.caps === 'end';
    const last = rings.length - 1;
    // A cap's facing is DERIVED from the skin, never guessed from where the
    // neighbouring ring lies: the skin walks every rim edge in one direction,
    // so the cap must walk it in the other for the two to form one closed
    // surface. (Guessing "away from the neighbour" turns the cap inside-out
    // whenever the loft's last stations double back — a recessed lens, an
    // intake, an exhaust.) With the unflipped skin quad (A[j], A[k], B[k],
    // B[j]) that is the last ring in ring order and the first ring reversed.
    const cap = (ring: Vector3[], reversed: boolean, cp: Paint | null): void => {
      if (!cp || loopNormal(ring).length() < 1e-12) return; // a tip needs no cap
      m.polygon(reversed ? [...ring].reverse() : ring, cp);
    };
    if (capStart) cap(rings[0], !flip, o.capPaint ?? patchPaint(p, 0, 0, 0, 0));
    if (capEnd) cap(rings[last], flip, o.capPaint ?? patchPaint(p, 1, 0, Math.max(last - 1, 0), 0));
  }
  place(m, start, o);
}

/** Resample an OPEN 3D polyline to `count` points, keeping both ends. */
function resampleOpen(points: Vector3[], count: number): Vector3[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Vector3.Distance(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  const out: Vector3[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / (count - 1);
    while (seg < points.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? Math.min(1, Math.max(0, (d - cum[seg]) / span)) : 0;
    out.push(Vector3.Lerp(points[seg], points[seg + 1], t));
  }
  return out;
}
