import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, compose, extrudePolygon, loft, loopNormal, paint, quadFacing, revolve, rotation, roundedBox, roundedRectRing, toV3 } from '../../../gfx/solid';
import type { Paint, PatchPaint, Vec3 } from '../../../gfx/solid';
import { STEEL, aimZ } from '../parts';

/**
 * Riot Ram's own shape helpers. The car is drawn as "clean manufactured
 * panels with bevelled edges": flat faces, chunky, every edge a broad soft
 * round. The kit's `loft` gives either a spline (inflated, no flat faces) or
 * a ruled surface (flat faces, razor edges between stations); `panelSolid`
 * is the third thing — flat faces between stations with a ROUNDED edge at
 * every station and every section corner.
 */

/**
 * Round the corner A–P–B with an arc of `radius`: ALWAYS `segs + 1` points,
 * whatever the corner looks like (straight, zero-length, too short for the
 * radius). The constant count is the whole point — sections rounded with it
 * loft to each other point for point, where `filletRing` drops or merges
 * points on degenerate corners.
 */
function roundCorner(A: Vector3, P: Vector3, B: Vector3, radius: number, segs: number): Vector3[] {
  const out: Vector3[] = [];
  const u = A.subtract(P);
  const v = B.subtract(P);
  const lu = u.length();
  const lv = v.length();
  if (lu < 1e-7 || lv < 1e-7 || radius <= 0) {
    for (let k = 0; k <= segs; k++) out.push(P.clone());
    return out;
  }
  u.scaleInPlace(1 / lu);
  v.scaleInPlace(1 / lv);
  const theta = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(u, v)))); // interior angle
  const bend = Math.PI - theta;
  // Each corner may use a little under half of either leg.
  const reach = Math.min(lu, lv) * 0.46;
  if (bend < 2e-3 || theta < 2e-3) {
    // Straight through (or a hairpin): spread the points along the legs so
    // neighbouring rings never collapse onto each other.
    const d = Math.min(radius, reach) * (theta < 2e-3 ? 0 : 1);
    for (let k = 0; k <= segs; k++) {
      const t = (k / segs) * 2 - 1;
      out.push(P.add((t < 0 ? u : v).scale(Math.abs(t) * d)));
    }
    return out;
  }
  const tanHalf = Math.tan(theta / 2);
  const d = Math.min(radius / tanHalf, reach);
  const r = d * tanHalf;
  const bis = u.add(v).normalize();
  const C = P.add(bis.scale(r / Math.sin(theta / 2)));
  const a = P.add(u.scale(d)).subtract(C);
  const b = P.add(v.scale(d)).subtract(C);
  const sinO = Math.sin(bend);
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const ka = Math.sin((1 - t) * bend) / sinO;
    const kb = Math.sin(t * bend) / sinO;
    out.push(new Vector3(C.x + a.x * ka + b.x * kb, C.y + a.y * ka + b.y * kb, C.z + a.z * ka + b.z * kb));
  }
  return out;
}

/** A closed polygon (3D corner points) with every corner rounded:
 * corners × (segs + 1) points, in corner order. */
export function roundPoly(corners: readonly Vec3[], radius: number, segs = 3): Vector3[] {
  const p = corners.map((q) => toV3(q).clone());
  const n = p.length;
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) out.push(...roundCorner(p[(i + n - 1) % n], p[i], p[(i + 1) % n], radius, segs));
  return out;
}

/** An open polyline with its interior corners rounded (ends kept). */
function roundOpen(p: Vector3[], radius: number, segs: number): Vector3[] {
  const out: Vector3[] = [p[0]];
  for (let i = 1; i + 1 < p.length; i++) out.push(...roundCorner(p[i - 1], p[i], p[i + 1], radius, segs));
  out.push(p[p.length - 1]);
  return out;
}

/** Move every point of a planar ring `e` meters into the ring, along its own
 * in-plane normal (so concave sections — a fender arch — inset correctly). */
function insetRing(ring: Vector3[], e: number): Vector3[] {
  const N = loopNormal(ring).normalize();
  const n = ring.length;
  return ring.map((q, j) => {
    const t = ring[(j + 1) % n].subtract(ring[(j + n - 1) % n]);
    const inward = Vector3.Cross(N, t);
    const l = inward.length();
    return l > 1e-9 ? q.add(inward.scale(e / l)) : q.clone();
  });
}

export interface PanelSolidOptions {
  /** Radius of the rounded edge at every station (default 0.025). */
  edge?: number;
  /** Segments of each rounded edge (default 3). */
  segs?: number;
  /** Soft bevel round the two end faces: [start, end] meters (0 = a crisp
   * flat cap, for an end that is sunk into another part). */
  ends?: readonly [number, number];
  /** Paint of the two end faces (default: the skin's). */
  capPaint?: Paint;
  /**
   * The section is a bent STRIP of constant thickness — an arch, a channel —
   * whose corners were listed outer skin first, then the inner skin back
   * again. Its end faces are then closed as a band between the two skins
   * (point j to point n − 1 − j) instead of being triangulated as a general
   * polygon, which gets a deeply concave, thin outline wrong.
   */
  strip?: boolean;
}

/**
 * A solid skinned through section rings (same point count each — use
 * `roundPoly`): FLAT between stations, with a rounded edge at every station
 * and round the end faces. Each ring point's own path through the stations
 * is filleted, so the edges come out round whatever angle the panels meet at.
 */
export function panelSolid(m: SolidMesh, stations: readonly (readonly Vec3[])[], o: PanelSolidOptions, p: PatchPaint): void {
  const edge = o.edge ?? 0.025;
  const segs = o.segs ?? 3;
  let st = stations.map((r) => r.map((q) => toV3(q).clone()));
  const n = st[0].length;
  const [e0, e1] = o.ends ?? [0, 0];
  // An end bevel: the end ring is inset (the flat cap), and a shoulder ring
  // is put where the skin starts turning in toward it.
  const shoulder = (end: Vector3[], next: Vector3[], e: number): Vector3[] =>
    end.map((q, j) => {
      const d = next[j].subtract(q);
      const l = d.length();
      return l > 1e-9 ? q.add(d.scale(Math.min(e, l * 0.45) / l)) : q.clone();
    });
  // A strip's end face is thinned toward its own centre line (each point
  // toward its partner on the other skin): that can never fold over itself
  // at the strip's thin rounded ends, as a general inset does.
  const thin = (ring: Vector3[], e: number): Vector3[] =>
    ring.map((q, j) => {
      const d = ring[n - 1 - j].subtract(q);
      const l = d.length();
      return l > 1e-9 ? q.add(d.scale(Math.min(e, l * 0.3) / l)) : q.clone();
    });
  const rim = o.strip ? thin : insetRing;
  if (e0 > 0) st = [rim(st[0], e0), shoulder(st[0], st[1], e0), ...st.slice(1)];
  if (e1 > 0) {
    const last = st.length - 1;
    st = [...st.slice(0, last), shoulder(st[last], st[last - 1], e1), rim(st[last], e1)];
  }
  const paths: Vector3[][] = [];
  for (let j = 0; j < n; j++) paths.push(roundOpen(st.map((r) => r[j]), edge, segs));
  const rings: Vector3[][] = [];
  for (let k = 0; k < paths[0].length; k++) rings.push(paths.map((path) => path[k]));
  if (!o.strip) {
    loft(m, { rings, subdivisions: 1, caps: true, capPaint: o.capPaint }, p);
    return;
  }
  loft(m, { rings, subdivisions: 1 }, p);
  const capPaint = o.capPaint ?? (typeof p === 'function' ? p(0, 0, 0, 0) : p);
  if (!capPaint) return;
  const centre = (r: Vector3[]): Vector3 => r.reduce((c, q) => c.addInPlace(q), Vector3.Zero()).scaleInPlace(1 / r.length);
  const cap = (ring: Vector3[], neighbour: Vector3[]): void => {
    const out = centre(ring).subtract(centre(neighbour));
    for (let j = 0; j + 1 < n / 2; j++) quadFacing(m, ring[j], ring[j + 1], ring[n - 2 - j], ring[n - 1 - j], out, capPaint);
  };
  cap(rings[0], rings[1]);
  cap(rings[rings.length - 1], rings[rings.length - 2]);
}

/** A box with broad soft edges whose side walls may lean: `bottom` and `top`
 * are [x0, x1, z0, z1] at heights y0 and y1. Section corners are rounded by
 * `corner`, the top and bottom rims by `edge`. */
export function taperBox(m: SolidMesh, o: { y: readonly [number, number]; bottom: readonly [number, number, number, number]; top: readonly [number, number, number, number]; corner?: number; edge?: number; ends?: readonly [number, number] }, p: Paint): void {
  const ring = (r: readonly [number, number, number, number], y: number): Vector3[] =>
    roundPoly(
      [
        [r[0], y, r[2]],
        [r[1], y, r[2]],
        [r[1], y, r[3]],
        [r[0], y, r[3]],
      ],
      o.corner ?? 0.03,
      2,
    );
  panelSolid(m, [ring(o.bottom, o.y[0]), ring(o.top, o.y[1])], { edge: o.edge ?? 0.02, segs: 2, ends: o.ends ?? [o.edge ?? 0.02, o.edge ?? 0.02] }, p);
}

/** Rivet steel shades as one smooth dome (the stock crease angle would cut
 * a low-poly dome into facets that glint like crystals). */
const RIVET = paint(STEEL, { smooth: 90 });

/** A domed rivet head standing on a surface (sunk 6 mm into it, so it
 * never shows its open base on a gently curved panel). 24
 * triangles — the car carries about fifty of them. */
export function rivet(m: SolidMesh, at: Vec3, normal: Vec3, radius = 0.013, p: Paint = RIVET): void {
  const r = radius;
  revolve(
    m,
    {
      profile: [
        [r, -0.006],
        [r * 0.82, r * 0.46],
        [0, r * 0.76],
      ],
      segments: 8,
      at: compose(rotation('x', 90), aimZ(at, normal)),
    },
    p,
  );
}

export interface LampCellOptions {
  /** Centre of the bezel's front face. */
  at: Vec3;
  /** Where it shines. */
  dir: Vec3;
  /** Outer size of the bezel. */
  width: number;
  height: number;
  /** Bezel wall (default 0.02) and how deep the bezel reaches back from its
   * front face (default 0.05). */
  wall?: number;
  depth?: number;
  bezel: Paint;
  /** Lens glow and the small hot core in its middle. */
  glow: Paint;
  core: Paint;
}

/**
 * One rectangular lamp cell: a bevelled bezel frame with a real opening, a
 * glowing lens set back inside it and a small hot core — the blocky lamps of
 * the sheet (headlamps, the three roof cells, tail lamps).
 */
export function lampCell(m: SolidMesh, o: LampCellOptions): void {
  const t = o.wall ?? 0.02;
  const d = o.depth ?? 0.05;
  const s = new SolidMesh();
  const w = o.width;
  const h = o.height;
  const r = Math.min(w, h) * 0.22;
  // The bevel is inset from both edges of the bezel wall (and a soft bevel
  // adds a flat ring inside it): keep it well under a third of the wall or
  // the front face turns itself inside out and the opening closes.
  extrudePolygon(
    s,
    {
      outline: roundedRectRing(w, h, r, 2),
      holes: [roundedRectRing(w - 2 * t, h - 2 * t, r * 0.6, 2)],
      depth: d,
      bevel: t * 0.3,
      bevelSegments: 1,
      back: false,
      at: [0, 0, -d],
    },
    o.bezel,
  );
  // Lens 16 mm behind the bezel's face, domed by its own rounding, so the
  // bezel throws a lip of shadow on it; the core stands proud of it — small,
  // so the hottest emissive never covers a broad face.
  roundedBox(s, { size: [w - 2 * t + 0.008, h - 2 * t + 0.008, 0.03], radius: 0.012, segments: 1, at: [0, 0, -0.031] }, o.glow);
  roundedBox(s, { size: [(w - 2 * t) * 0.52, (h - 2 * t) * 0.42, 0.014], radius: 0.006, segments: 1, at: [0, 0, -0.019] }, o.core);
  m.append(s, aimZ(o.at, o.dir));
}
