import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, soften } from './SolidMesh';
import type { Paint } from './SolidMesh';
import type { RGB } from './color';
import { DEG, frame } from './math';
import type { Placement, Vec2 } from './math';
import { place, quadFacing } from './primitives';
import { dedupeRing, offsetRing, signedArea, triangulate } from './triangulate';

/**
 * Flat-outline solids: `extrudePolygon` (plates, emblems, gable walls, window
 * frames — any 2D outline with holes given depth and an optional edge bevel)
 * and `thicken` (turn an open surface into a shell with real thickness).
 */

/** Which way an outline-based shape's FRONT points; see `ExtrudeOptions.facing`. */
export type Facing = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/**
 * Frame for "the outline is drawn as seen from the front": maps outline x
 * (the viewer's right), outline y (the viewer's up) and the extrusion
 * direction (toward the viewer) into model axes for a front facing `facing`.
 * Every one of these is a MIRROR (determinant −1): the world is left-handed,
 * while "x right, y up, z toward me" is right-handed — which is exactly why
 * an un-mirrored outline reads back to front.
 */
export function facingFrame(facing: Facing): Matrix {
  switch (facing) {
    case '+z': return frame([0, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1]);
    case '-z': return frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1]);
    case '+x': return frame([0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0]);
    case '-x': return frame([0, 0, 0], [0, 0, -1], [0, 1, 0], [-1, 0, 0]);
    // Seen from above with the car's nose / the model's +z at the top of the
    // drawing (the lab's Top view), and from below turned over about x.
    case '+y': return frame([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
    case '-y': return frame([0, 0, 0], [1, 0, 0], [0, 0, -1], [0, -1, 0]);
  }
}

export interface ExtrudeOptions extends Placement {
  /**
   * Outer outline as [x, y] points. Either winding; must not self-intersect.
   * WITHOUT `facing` the points are plain local coordinates: x → local +x,
   * y → local +y, front face toward local +z. NOTE that this reads MIRRORED
   * when you look at the front face (the world is left-handed) — fine for
   * symmetric shapes, wrong for letters, numbers, logos, arrows and for
   * hole positions. For anything asymmetric draw the outline as you want to
   * SEE it and set `facing`.
   */
  outline: readonly Vec2[];
  /**
   * The outline is drawn AS SEEN FROM THE FRONT (x = the viewer's right,
   * y = up) and the front face points this way in the model: '-z' for a
   * sign on a building's street front, '+x' / '-x' for a car's right / left
   * side, '+z' for its nose, '+y' for a decal lying on a roof or bonnet
   * (drawn as in a top view: model +z up the page). The solid grows from the
   * local origin toward the front. `rot` / `at` are applied afterwards.
   *   extrudePolygon(m, { outline: LETTER_F, depth: 0.04, facing: '-z', at: [0, 2.6, -1.5] }, SIGN);
   */
  facing?: Facing;
  /** Holes (windows, cut-outs), each a ring strictly inside the outline. */
  holes?: readonly (readonly Vec2[])[];
  /**
   * Thickness along local +Z: the solid spans z = 0 (BACK, facing −z) to
   * z = depth (FRONT, facing +z). With `centered` it spans ±depth/2.
   */
  depth: number;
  centered?: boolean;
  /**
   * Round / chamfer the FRONT rim by this many meters (the front face shrinks
   * by it, holes grow by it). Keep it below a THIRD of the narrowest feature
   * of the outline — offsets are mitred, not clipped, and a rounded bevel
   * also insets a narrow flat ring inside the rim.
   */
  bevel?: number;
  /** 1 = flat chamfer with crisp edges (default), 2+ = a rounded edge that
   * shades soft (its crease angle is raised for its own strips, like every
   * other round helper). */
  bevelSegments?: number;
  /** Bevel the back rim too (free-standing plates). Default false: the back
   * usually sits against another surface. */
  bevelBack?: boolean;
  /** Emit the front / back faces (default true). `back: false` saves
   * triangles for anything mounted flush on a surface. */
  front?: boolean;
  back?: boolean;
  /** Paint overrides for the front / back faces (sides and bevels use the
   * main paint). */
  frontPaint?: Paint;
  backPaint?: Paint;
}

/**
 * Extrude a 2D outline (with optional holes) into a plate. Say which way
 * its front points with `facing` and draw the outline as you want to see it
 * from there; then move it with `at`. Curved outlines shade smooth, corners
 * stay crisp (paint's crease angle).
 *   // window frame on a street front (−z): 1.0 × 1.2 m with a 0.8 × 1.0
 *   // opening, 6 cm proud of the wall at z = −1.5, soft front edge
 *   extrudePolygon(m, {
 *     outline: roundedRectRing(1.0, 1.2, 0.08),
 *     holes: [roundedRectRing(0.8, 1.0, 0.04)],
 *     depth: 0.06, bevel: 0.015, bevelSegments: 2, back: false, facing: '-z', at: [0, 1.4, -1.5],
 *   }, TRIM);
 *   // emblem on a car's right-hand door: facing '+x'
 * Without `facing` the solid spans local z = 0 (back) … depth (front, +z) in
 * raw local coordinates — see the mirror warning on `outline`.
 */
export function extrudePolygon(m: SolidMesh, o: ExtrudeOptions, p: Paint): void {
  const start = m.mark();
  let outline = dedupeRing(o.outline);
  if (outline.length < 3) return;
  if (signedArea(outline) < 0) outline = outline.reverse();
  // Holes clockwise: then "left of travel" is material for every ring, and
  // one offset / one side-wall rule serves outline and holes alike.
  const holes = (o.holes ?? [])
    .map((h) => dedupeRing(h))
    .filter((h) => h.length >= 3)
    .map((h) => (signedArea(h) > 0 ? h.reverse() : h));
  const rings = [outline, ...holes];

  const depth = Math.abs(o.depth);
  const z0 = o.centered ? -depth / 2 : 0;
  const bevelBack = o.bevelBack ?? false;
  const bevel = Math.max(0, Math.min(o.bevel ?? 0, bevelBack ? depth / 2 : depth));
  const segs = Math.max(1, Math.round(o.bevelSegments ?? 1));

  // Levels from back to front: each an inset and a height.
  const levels: { inset: number; z: number }[] = [];
  if (bevel > 1e-9 && bevelBack) {
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * 90 * DEG;
      levels.push({ inset: bevel * (1 - Math.sin(a)), z: z0 + bevel * (1 - Math.cos(a)) });
    }
  } else {
    levels.push({ inset: 0, z: z0 });
  }
  if (bevel > 1e-9) {
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * 90 * DEG;
      levels.push({ inset: bevel * (1 - Math.cos(a)), z: z0 + depth - bevel + bevel * Math.sin(a) });
    }
  } else {
    levels.push({ inset: 0, z: z0 + depth });
  }
  // A rounded bevel is a curve built from `segs` strips: let its own faces
  // shade smooth (a one-segment chamfer stays whatever the paint says, which
  // by default is two crisp edges).
  const sp = bevel > 1e-9 && segs > 1 ? soften(p, 90 / segs) : p;
  const frontPaint = o.frontPaint ?? p;
  const backPaint = o.backPaint ?? p;
  // Where the bevel shades smooth INTO a cap, the rim vertices carry a tilted
  // normal. Triangulating the cap straight from the rim would interpolate
  // that tilt across whole cap triangles — streaks radiating over the flat
  // face. A narrow flat ring just inside the rim confines the blend to
  // itself; the cap proper then starts from vertices that are exactly flat.
  // (The strip next to a cap is tilted half a bevel step, 45° / segs, off it.)
  const blends = (cap: Paint): boolean => bevel > 1e-9 && 45 / segs < Math.min(cap.smooth, sp.smooth);
  const ringW = bevel * 0.6;
  const frontRing = (o.front ?? true) && blends(frontPaint);
  const backRing = (o.back ?? true) && bevelBack && blends(backPaint);
  if (backRing) levels.unshift({ inset: bevel + ringW, z: z0 });
  if (frontRing) levels.push({ inset: bevel + ringW, z: z0 + depth });
  const ringsAt = levels.map((l) => rings.map((r) => (l.inset > 1e-9 ? offsetRing(r, l.inset) : r)));

  // Side walls and bevel strips. For a ring with material on its left, the
  // quad (P_i, P_i+1) low → high faces right of travel = out of the material.
  for (let l = 0; l + 1 < levels.length; l++) {
    const za = levels[l].z;
    const zb = levels[l + 1].z;
    if (Math.abs(zb - za) < 1e-12 && Math.abs(levels[l].inset - levels[l + 1].inset) < 1e-12) continue;
    // The flat rings belong to their cap; everything between is wall / bevel.
    const lp = backRing && l === 0 ? backPaint : frontRing && l === levels.length - 2 ? frontPaint : sp;
    for (let r = 0; r < rings.length; r++) {
      const A = ringsAt[l][r];
      const B = ringsAt[l + 1][r];
      for (let i = 0, n = A.length; i < n; i++) {
        const j = (i + 1) % n;
        m.quad(
          [A[i][0], A[i][1], za],
          [A[j][0], A[j][1], za],
          [B[j][0], B[j][1], zb],
          [B[i][0], B[i][1], zb],
          lp,
        );
      }
    }
  }

  const capAt = (level: number, front: boolean, cp: Paint): void => {
    const lr = ringsAt[level];
    const z = levels[level].z;
    const { points, triangles } = triangulate(lr[0], lr.slice(1));
    for (let i = 0; i < triangles.length; i += 3) {
      const a = points[triangles[i]];
      const b = points[triangles[i + 1]];
      const c = points[triangles[i + 2]];
      // Triangulation is CCW in XY = facing +z; reverse for the back.
      if (front) m.tri([a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z], cp);
      else m.tri([a[0], a[1], z], [c[0], c[1], z], [b[0], b[1], z], cp);
    }
  };
  if (o.front ?? true) capAt(levels.length - 1, true, frontPaint);
  if (o.back ?? true) capAt(0, false, backPaint);
  if (o.facing) m.transform(facingFrame(o.facing), start);
  place(m, start, o);
}

export interface ThickenOptions {
  /** Wall thickness in meters. */
  thickness: number;
  /**
   * Which way the wall grows from the authored surface:
   *  'inside' (default) — the authored surface stays the OUTER skin, the new
   *    skin is offset behind it (against its normals);
   *  'outside' — the authored surface becomes the inner skin;
   *  'both' — half each way.
   */
  side?: 'inside' | 'outside' | 'both';
  /** Paint of the new back skin (default: same as the front, per face). */
  innerPaint?: Paint;
  /** Paint of the rim joining the two skins along open edges (default: the
   * adjacent face's paint). */
  rimPaint?: Paint;
  /** Only thicken triangles from this index on (see `SolidMesh.mark`). */
  from?: number;
}

/**
 * Give an OPEN surface real thickness: adds an offset back skin (facing the
 * other way) and a rim along every open edge. Body panels, fenders, bowls,
 * canopies and leaves authored as single surfaces (an open `loft`, a `sphere`
 * latitude cut with `caps: false`, …) become solid shells that look right
 * from every side. Closed parts of the mesh get a hidden inner copy, so
 * apply it to the open part only (`from`). Baked AO / wind on the affected
 * triangles are reset — thicken first, bake after.
 *   const s = m.mark();
 *   sphere(m, { radius: 0.5, latitude: [-90, 0], caps: false }, BOWL);   // open hemisphere
 *   thicken(m, { thickness: 0.03, from: s });
 */
export function thicken(m: SolidMesh, o: ThickenOptions): void {
  const from = o.from ?? 0;
  const T = m.triangleCount;
  if (T <= from) return;
  const N = m.computeNormals();
  const P = m.positions;
  const C = m.cornerColors;
  const W = N.weldCount;

  // Offset direction per welded position: area × angle weighted mean of the
  // adjacent corners' SHADING normals (within the thickened range), then
  // lengthened by 1 / cos so the wall keeps its thickness across creases.
  // Shading rather than face normals: on a smooth surface they vary evenly
  // from vertex to vertex, where face normals jump by the facet angle — and
  // along a cut edge (few faces per vertex) that jump is enough to push
  // neighbouring vertices of a small triangle past each other and turn the
  // inner skin inside-out there. At a crease the two agree.
  const vn = new Float64Array(W * 3);
  for (let t = from; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const i = t * 9 + k * 3;
      const j = t * 9 + ((k + 1) % 3) * 3;
      const h = t * 9 + ((k + 2) % 3) * 3;
      const ex = P[j] - P[i], ey = P[j + 1] - P[i + 1], ez = P[j + 2] - P[i + 2];
      const gx = P[h] - P[i], gy = P[h + 1] - P[i + 1], gz = P[h + 2] - P[i + 2];
      const wgt = N.faceAreas[t] * Math.atan2(2 * N.faceAreas[t], ex * gx + ey * gy + ez * gz);
      const w = N.weld[t * 3 + k];
      const c = t * 3 + k;
      vn[w * 3] += N.normals[c * 3] * wgt;
      vn[w * 3 + 1] += N.normals[c * 3 + 1] * wgt;
      vn[w * 3 + 2] += N.normals[c * 3 + 2] * wgt;
    }
  }
  for (let w = 0; w < W; w++) {
    const l = Math.hypot(vn[w * 3], vn[w * 3 + 1], vn[w * 3 + 2]) || 1;
    vn[w * 3] /= l;
    vn[w * 3 + 1] /= l;
    vn[w * 3 + 2] /= l;
  }
  const stretchSum = new Float64Array(W);
  const stretchCount = new Float64Array(W);
  for (let t = from; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const w = N.weld[t * 3 + k];
      stretchSum[w] +=
        vn[w * 3] * N.faceNormals[t * 3] + vn[w * 3 + 1] * N.faceNormals[t * 3 + 1] + vn[w * 3 + 2] * N.faceNormals[t * 3 + 2];
      stretchCount[w]++;
    }
  }

  const side = o.side ?? 'inside';
  const tOut = side === 'outside' ? o.thickness : side === 'both' ? o.thickness / 2 : 0;
  const tIn = side === 'inside' ? o.thickness : side === 'both' ? o.thickness / 2 : 0;
  const corner = (c: number, dist: number): Vector3 => {
    const w = N.weld[c];
    // Capped at 2× so a knife-edge crease cannot spike.
    const cos = stretchCount[w] > 0 ? Math.max(stretchSum[w] / stretchCount[w], 0.5) : 1;
    const d = dist / cos;
    return new Vector3(P[c * 3] + vn[w * 3] * d, P[c * 3 + 1] + vn[w * 3 + 1] * d, P[c * 3 + 2] + vn[w * 3 + 2] * d);
  };
  const color = (c: number): RGB => [C[c * 3], C[c * 3 + 1], C[c * 3 + 2]];
  // Pinned normals (a tessellated or region-painted surface) carry over to
  // both skins, so a cut-out shell shades exactly like the uncut surface.
  const EN = m.cornerNormals;
  const pinned = (c: number, sign: number): [number, number, number] => [EN[c * 3] * sign, EN[c * 3 + 1] * sign, EN[c * 3 + 2] * sign];

  // Directed edges present in the range; an edge without its reverse is open.
  const edges = new Set<number>();
  for (let t = from; t < T; t++) {
    for (let k = 0; k < 3; k++) edges.add(N.weld[t * 3 + k] * W + N.weld[t * 3 + ((k + 1) % 3)]);
  }

  const out = new SolidMesh();
  out.weldTolerance = m.weldTolerance;
  for (let t = from; t < T; t++) {
    const fp = m.trianglePaint(t);
    const c0 = t * 3, c1 = t * 3 + 1, c2 = t * 3 + 2;
    const a = corner(c0, tOut), b = corner(c1, tOut), c = corner(c2, tOut);
    const ai = corner(c0, -tIn), bi = corner(c1, -tIn), ci = corner(c2, -tIn);
    out.tri(a, b, c, fp, [color(c0), color(c1), color(c2)], [pinned(c0, 1), pinned(c1, 1), pinned(c2, 1)]);
    const ip = o.innerPaint ?? fp;
    out.tri(ai, ci, bi, ip, o.innerPaint ? undefined : [color(c0), color(c2), color(c1)], [pinned(c0, -1), pinned(c2, -1), pinned(c1, -1)]);
    const outer = [a, b, c];
    const inner = [ai, bi, ci];
    for (let k = 0; k < 3; k++) {
      const k1 = (k + 1) % 3;
      const k2 = (k + 2) % 3;
      if (edges.has(N.weld[t * 3 + k1] * W + N.weld[t * 3 + k])) continue;
      // Rim faces away from the triangle it borders.
      const mid = outer[k].add(outer[k1]).scale(0.5);
      quadFacing(out, outer[k], outer[k1], inner[k1], inner[k], mid.subtract(outer[k2]), o.rimPaint ?? fp);
    }
  }
  m.truncate(from);
  m.append(out);
}
