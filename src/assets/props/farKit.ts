import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, adjustOklch, paint, rng } from '../../gfx/solid';
import type { Paint, RGB, Vec3 } from '../../gfx/solid';
import type { Fit } from './nature';

/**
 * FAR-TIER KIT — the few shapes the designed far models (`PropAsset.buildFar`)
 * are made of. The diorama view draws ONLY the far tier, from 100–120 m: a
 * tree is 30–60 px tall there and a facet of a metre is ~9 px. So a far model
 * is a small, closed, flat-shaded toy of the near model — the same layout,
 * the same palette tones, the same lean and turn — and not a crumpled copy of
 * it. Everything here is closed (back faces are culled in the far shader: a
 * one-sided card would vanish from below) and emits outward windings.
 *
 * Shapes and their exact triangle counts (budgets are 6–72 per model):
 *  - `farStick`  n-sided tapered prism along a polyline, 2n per segment, no
 *                caps (the foot is under the ground, the top inside a crown);
 *  - `farBlob`   a faceted lump: apex, `rings` rings of n points and a flat
 *                (or pointed) underside — 1 ring: 2n, 2 rings: 4n;
 *  - `farStar`   a low rosette of n points round a raised heart, closed by
 *                the ground it sits on — 2n (see the note there).
 */

const DEG = Math.PI / 180;

/** Emit triangle (a, b, c) facing away from `inside`. */
export function outTri(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, inside: Vector3, p: Paint | ((n: Vector3, c: Vector3) => Paint)): void {
  const n = Vector3.Cross(b.subtract(a), c.subtract(a));
  if (n.lengthSquared() < 1e-14) return;
  const centre = a.add(b).add(c).scaleInPlace(1 / 3);
  if (Vector3.Dot(n, centre.subtract(inside)) < 0) {
    const t = b;
    b = c;
    c = t;
    n.scaleInPlace(-1);
  }
  m.tri(a, b, c, typeof p === 'function' ? p(n.normalize(), centre) : p);
}

/** Emit triangle (a, b, c) facing along `dir` (for surfaces that are not
 * around one centre, like the top of a rosette). */
export function dirTri(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, dir: Vector3, p: Paint | ((n: Vector3, c: Vector3) => Paint)): void {
  const n = Vector3.Cross(b.subtract(a), c.subtract(a));
  if (n.lengthSquared() < 1e-14) return;
  if (Vector3.Dot(n, dir) < 0) {
    const t = b;
    b = c;
    c = t;
    n.scaleInPlace(-1);
  }
  const centre = a.add(b).add(c).scaleInPlace(1 / 3);
  m.tri(a, b, c, typeof p === 'function' ? p(n.normalize(), centre) : p);
}

const v3 = (p: Vec3): Vector3 => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2]));

/**
 * A round trunk / pole: `sides`-sided rings at every path point (radius per
 * point), quads between them. The rings are framed by a parallel-transported
 * side vector so a bent trunk does not twist; `startDeg` turns the first
 * corner. No caps. 2 × sides triangles per segment.
 */
export function farStick(
  m: SolidMesh,
  o: { path: readonly Vec3[]; radius: readonly number[]; sides: number; startDeg?: number; capTop?: boolean },
  p: Paint | ((n: Vector3, c: Vector3) => Paint),
): void {
  const path = o.path.map(v3);
  const n = o.sides;
  const tangents = path.map((_, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    return b.subtract(a).normalize();
  });
  let side = Math.abs(tangents[0].y) < 0.9 ? Vector3.Cross(tangents[0], Vector3.Up()).normalize() : new Vector3(1, 0, 0);
  const rings: Vector3[][] = [];
  const a0 = (o.startDeg ?? 0) * DEG;
  path.forEach((c, i) => {
    const t = tangents[i];
    // Transport: remove the tangent component and renormalise.
    side = side.subtract(t.scale(Vector3.Dot(side, t))).normalize();
    const other = Vector3.Cross(t, side).normalize();
    const r = o.radius[Math.min(i, o.radius.length - 1)];
    const ring: Vector3[] = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      ring.push(c.add(side.scale(Math.cos(a) * r)).add(other.scale(Math.sin(a) * r)));
    }
    rings.push(ring);
  });
  for (let i = 0; i < path.length - 1; i++) {
    const axisMid = path[i].add(path[i + 1]).scale(0.5);
    for (let k = 0; k < n; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % n], c = rings[i + 1][(k + 1) % n], d = rings[i + 1][k];
      // Inside reference: the axis point level with the quad.
      outTri(m, a, b, c, axisMid, p);
      outTri(m, a, c, d, axisMid, p);
    }
  }
  if (o.capTop) {
    const top = rings[rings.length - 1];
    const t = tangents[tangents.length - 1];
    for (let k = 1; k < n - 1; k++) dirTri(m, top[0], top[k], top[k + 1], t, p);
  }
}

export interface FarBlobOptions {
  at: Vec3;
  radii: Vec3 | number;
  /** Points per ring (3–8). */
  sides: number;
  /** 1 ring: a faceted gem (2n triangles); 2 rings: a rounder lump (4n). */
  rings?: 1 | 2;
  /** Underside: a flat-ish point this fraction of the vertical radius below
   * the centre (default 0.75). The umbrella look of a canopy mass. */
  flat?: number;
  /** Corner irregularity, 0..1 (default 0.5). */
  jitter?: number;
  seed: number;
  /** Turn about y, degrees. */
  yaw?: number;
}

/**
 * One foliage mass. The rings sit high (the widest ring a little under the
 * centre, the upper one at 0.55 of the height and narrower), so from above
 * it reads as a dome, not a pyramid; the underside is a shallow cone, so
 * from below it reads flat. Corners jitter in angle, radius and height from
 * `seed`, so two blobs of one tree never look stamped.
 */
export function farBlob(m: SolidMesh, o: FarBlobOptions, p: Paint | ((n: Vector3, c: Vector3) => Paint)): void {
  const c = v3(o.at);
  const R = typeof o.radii === 'number' ? new Vector3(o.radii, o.radii, o.radii) : v3(o.radii);
  const n = Math.max(3, Math.round(o.sides));
  const rings = o.rings ?? 1;
  const J = o.jitter ?? 0.5;
  const r = rng(o.seed, 'farBlob');
  const yaw = (o.yaw ?? r.range(0, 360)) * DEG;
  const ring = (y: number, scale: number, offset: number): Vector3[] => {
    const out: Vector3[] = [];
    for (let k = 0; k < n; k++) {
      const a = yaw + ((k + offset + (r.next() - 0.5) * 0.45 * J) / n) * Math.PI * 2;
      const s = scale * (1 + (r.next() - 0.5) * 0.3 * J);
      out.push(new Vector3(c.x + Math.sin(a) * R.x * s, c.y + R.y * (y + (r.next() - 0.5) * 0.16 * J), c.z + Math.cos(a) * R.z * s));
    }
    return out;
  };
  // The widest ring's points reach the ellipsoid's equator at radius 1; a
  // polygon inscribed there loses cos(π/n) of the width across its flats —
  // push it out by half of that so the mass keeps its size.
  const fill = 1 + (1 / Math.cos(Math.PI / n) - 1) * 0.5;
  const apex = new Vector3(c.x + (r.next() - 0.5) * 0.2 * J * R.x, c.y + R.y * (1 - 0.06 * r.next() * J), c.z + (r.next() - 0.5) * 0.2 * J * R.z);
  const bottom = new Vector3(c.x, c.y - R.y * (o.flat ?? 0.75), c.z);
  const wide = ring(-0.12, fill, 0);
  const lists: Vector3[][] = rings === 2 ? [ring(0.55, fill * 0.78, 0.5), wide] : [wide];
  const inside = c.clone();
  // Top fan.
  const first = lists[0];
  for (let k = 0; k < n; k++) outTri(m, apex, first[k], first[(k + 1) % n], inside, p);
  // Band between two rings (offset by half a step: a zig-zag of triangles).
  if (lists.length === 2) {
    const [u, w] = lists;
    for (let k = 0; k < n; k++) {
      outTri(m, u[k], w[k], w[(k + 1) % n], inside, p);
      outTri(m, u[k], w[(k + 1) % n], u[(k + 1) % n], inside, p);
    }
  }
  // Underside.
  const last = lists[lists.length - 1];
  for (let k = 0; k < n; k++) outTri(m, bottom, last[(k + 1) % n], last[k], inside, p);
}

/**
 * A low rosette: `points` tips round a raised heart with low valleys
 * between them — 2 × points triangles of top surface. Its underside is the
 * ground: a plant stands on it with its tips at or under ground height (set
 * `tipY` ≤ 0.05), so from any camera above the ground there is no gap to see
 * through. `lift` raises every second tip (a fern's arching fronds).
 */
export function farStar(
  m: SolidMesh,
  o: { at?: Vec3; points: number; radius: number | number[]; heart: number; tipY?: number | number[]; valley?: number; valleyY?: number; startDeg?: number },
  p: Paint | ((n: Vector3, c: Vector3) => Paint),
): void {
  const c = o.at ? v3(o.at) : new Vector3();
  const n = o.points;
  const heart = new Vector3(c.x, c.y + o.heart, c.z);
  const a0 = (o.startDeg ?? 0) * DEG;
  const tips: Vector3[] = [];
  const vals: Vector3[] = [];
  for (let k = 0; k < n; k++) {
    const R = Array.isArray(o.radius) ? o.radius[k % o.radius.length] : o.radius;
    const ty = Array.isArray(o.tipY) ? o.tipY[k % o.tipY.length] : (o.tipY ?? 0.02);
    const a = a0 + (k / n) * Math.PI * 2;
    tips.push(new Vector3(c.x + Math.sin(a) * R, c.y + ty, c.z + Math.cos(a) * R));
    const b = a + Math.PI / n;
    const Rn = Array.isArray(o.radius) ? Math.min(R, o.radius[(k + 1) % o.radius.length]) : R;
    vals.push(new Vector3(c.x + Math.sin(b) * Rn * (o.valley ?? 0.45), c.y + (o.valleyY ?? 0.01), c.z + Math.cos(b) * Rn * (o.valley ?? 0.45)));
  }
  const up = new Vector3(0, 1, 0);
  for (let k = 0; k < n; k++) {
    // Each lobe: heart → tip → valley, and the valley before → tip.
    const prev = vals[(k + n - 1) % n];
    dirTri(m, heart, prev, tips[k], up, p);
    dirTri(m, heart, tips[k], vals[k], up, p);
  }
}

/**
 * A low plant's far model read off its own near model: a rosette (`farStar`)
 * whose `n` tips point where the plant reaches furthest in each of n sectors
 * round its foot, its heart as high as the plant, every lobe painted the
 * area-weighted colour of the plant's upward faces in that sector — so a
 * fern stays a fern-green star, a succulent a teal one, grass a lime one,
 * each variant in its own tones. A plant with a non-green accent (flowers:
 * red over green, by area at least 3 %) gets a small cap in the accent's
 * colour at the accent's centre, sunk into the star (3 triangles, its open
 * base inside the mound). Tips and valleys sit 5 cm under the ground, so on
 * a slope the downhill tips still meet it.
 * Triangles: 2n (+3 with an accent cap) — n = ⌊(target − cap) / 2⌋, ≥ 3;
 * below 9 triangles the accent colours whole lobes instead of a cap.
 */
export function farTuft(near: SolidMesh, target: number, o: { heart?: number; valley?: number; gloss?: number } = {}): SolidMesh {
  const P = near.positions;
  const C = near.cornerColors;
  const T = near.triangleCount;
  const b = near.bounds();
  const isAccent = (r: number, g: number): boolean => r > g * 1.05;
  // Faces: centroid, area, normal, colour.
  let total = 0, accentArea = 0;
  const acc = new Vector3();
  const accCol = [0, 0, 0];
  let accTop = -Infinity;
  const faces: { c: Vector3; area: number; ny: number; col: [number, number, number]; accent: boolean }[] = [];
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    const a = new Vector3(P[o9], P[o9 + 1], P[o9 + 2]);
    const bb = new Vector3(P[o9 + 3], P[o9 + 4], P[o9 + 5]);
    const c = new Vector3(P[o9 + 6], P[o9 + 7], P[o9 + 8]);
    const n = Vector3.Cross(bb.subtract(a), c.subtract(a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    const col: [number, number, number] = [(C[o9] + C[o9 + 3] + C[o9 + 6]) / 3, (C[o9 + 1] + C[o9 + 4] + C[o9 + 7]) / 3, (C[o9 + 2] + C[o9 + 5] + C[o9 + 8]) / 3];
    const centre = a.add(bb).add(c).scale(1 / 3);
    const accent = isAccent(col[0], col[1]);
    faces.push({ c: centre, area, ny: n.y / (2 * area), col, accent });
    total += area;
    if (accent) {
      accentArea += area;
      acc.addInPlace(centre.scale(area));
      for (let k = 0; k < 3; k++) accCol[k] += col[k] * area;
      accTop = Math.max(accTop, centre.y);
    }
  }
  const withAccent = accentArea > total * 0.03;
  // Flowers that are a big share of the plant: a low green mound under a
  // broad cap of their colour (the near plant reads as its flowers).
  const showy = accentArea > total * 0.2;
  // A cap needs 3 triangles on top of a star of at least 3 tips: below 9
  // triangles a flowering plant instead paints its accent onto whole lobes
  // (the lobes nearest the flowers, as many as the flowers' share of the
  // area) — the per-kind budget holds (target 8 → 8, not 9).
  const capped = withAccent && Math.floor((target - 3) / 2) >= 3;
  const n = Math.max(3, Math.floor((target - (capped ? 3 : 0)) / 2));
  // Reach per sector: the farthest vertex in it; sectors start at the
  // plant's farthest point, so the longest leaf is a tip.
  let start = 0, far = 0;
  for (let i = 0; i < P.length; i += 3) {
    const d = Math.hypot(P[i], P[i + 2]);
    if (d > far) {
      far = d;
      start = Math.atan2(P[i], P[i + 2]);
    }
  }
  const reach = new Array<number>(n).fill(0);
  const sector = (x: number, z: number): number => {
    const a = Math.atan2(x, z) - start + Math.PI / n;
    return ((Math.floor((a / (Math.PI * 2)) * n) % n) + n) % n;
  };
  for (let i = 0; i < P.length; i += 3) {
    const k = sector(P[i], P[i + 2]);
    reach[k] = Math.max(reach[k], Math.hypot(P[i], P[i + 2]));
  }
  for (let k = 0; k < n; k++) if (reach[k] < far * 0.35) reach[k] = far * 0.35;
  // Lobe colours: upward, non-accent faces per sector (all of them where a
  // sector has none).
  const sums = Array.from({ length: n }, () => [0, 0, 0, 0]);
  const all = [0, 0, 0, 0];
  for (const f of faces) {
    if (f.accent) continue;
    const w = f.area * Math.max(0.05, f.ny);
    const s = sums[sector(f.c.x, f.c.z)];
    for (let k = 0; k < 3; k++) {
      s[k] += f.col[k] * w;
      all[k] += f.col[k] * w;
    }
    s[3] += w;
    all[3] += w;
  }
  const colour = (s: number[]): [number, number, number] => (s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : all[3] > 0 ? [all[0] / all[3], all[1] / all[3], all[2] / all[3]] : [0.4, 0.7, 0.3]);
  const gloss = o.gloss ?? 0.3;
  const m = new SolidMesh();
  const heart = b.max.y * (showy && capped ? 0.5 : (o.heart ?? 0.85));
  const lobes = Array.from({ length: n }, (_, k) => colour(sums[k]));
  if (withAccent && !capped) {
    const at = acc.scale(1 / accentArea);
    const col: [number, number, number] = [accCol[0] / accentArea, accCol[1] / accentArea, accCol[2] / accentArea];
    const share = accentArea / total;
    // A plant that reads as its flowers (showy) shows them on half its lobes.
    const count = Math.max(showy ? Math.ceil(n / 2) : 1, Math.min(n - 1, Math.round(n * share)));
    // Lobes ordered by how close their sector's middle is to the flowers.
    const aim = Math.atan2(at.x, at.z);
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => {
      const d = (k: number): number => {
        const mid = start + (k / n) * Math.PI * 2;
        return Math.abs(Math.atan2(Math.sin(mid - aim), Math.cos(mid - aim)));
      };
      return d(a) - d(b);
    });
    for (let i = 0; i < count; i++) lobes[order[i]] = col;
  }
  farStar(
    m,
    { points: n, radius: reach, heart, tipY: -0.05, valley: o.valley ?? 0.32, valleyY: -0.05, startDeg: (start * 180) / Math.PI },
    (nn, c) => {
      const col = lobes[sector(c.x, c.z)];
      // The lobe's two faces a hair apart, the one nearer the sun lighter.
      return paint(adjustOklch(col, 0.025 * nn.y), { gloss, smooth: 0 });
    },
  );
  if (capped) {
    const at = acc.scale(1 / accentArea);
    const col: [number, number, number] = [accCol[0] / accentArea, accCol[1] / accentArea, accCol[2] / accentArea];
    const r = showy ? far * 0.6 : Math.max(0.08, Math.min(far * 0.45, Math.sqrt(accentArea / Math.PI) * 0.7));
    // On the star's surface over the accent (the star is about a cone from
    // the heart to the tips), a little sunk; its tip above the flowers.
    const d = Math.hypot(at.x, at.z);
    const surface = heart * Math.max(0, 1 - d / far) - 0.03;
    const top = new Vector3(at.x, showy ? b.max.y : Math.min(b.max.y, Math.max(surface + r * 0.9, accTop)), at.z);
    const base: Vector3[] = [0, 1, 2].map((k) => {
      const a = (k / 3) * Math.PI * 2 + start;
      return new Vector3(at.x + Math.sin(a) * r, surface, at.z + Math.cos(a) * r);
    });
    const inside = new Vector3(at.x, surface - 1, at.z);
    const p = paint(col, { gloss: 0.4, smooth: 0 });
    for (let k = 0; k < 3; k++) outTri(m, top, base[k], base[(k + 1) % 3], inside, p);
  }
  return m;
}

/** Area-weighted colour of the near model's triangles that `pick` accepts
 * (centroid, unit normal) — how a far model of dressing takes the near
 * model's own seeded paints without replaying its random stream. */
export function sampleColor(near: SolidMesh, pick: (c: Vector3, n: Vector3) => boolean): RGB | null {
  const P = near.positions;
  const C = near.cornerColors;
  const sum = [0, 0, 0];
  let w = 0;
  for (let t = 0; t < near.triangleCount; t++) {
    const o = t * 9;
    const a = new Vector3(P[o], P[o + 1], P[o + 2]);
    const b = new Vector3(P[o + 3], P[o + 4], P[o + 5]);
    const c = new Vector3(P[o + 6], P[o + 7], P[o + 8]);
    const n = Vector3.Cross(b.subtract(a), c.subtract(a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    const centre = a.add(b).add(c).scale(1 / 3);
    if (!pick(centre, n.scale(1 / (2 * area)))) continue;
    for (let k = 0; k < 3; k++) sum[k] += ((C[o + k] + C[o + 3 + k] + C[o + 6 + k]) / 3) * area;
    w += area;
  }
  return w > 0 ? [sum[0] / w, sum[1] / w, sum[2] / w] : null;
}

/** `sampleColor`, or `fallback` with a console warning naming what was not
 * found — a far model must never change colour silently. */
export function sampleColorOr(near: SolidMesh, pick: (c: Vector3, n: Vector3) => boolean, fallback: RGB, what: string): RGB {
  const c = sampleColor(near, pick);
  if (c) return c;
  console.warn(`[props] far model: no near faces for ${what} — fallback colour used`);
  return fallback;
}

/**
 * Upright prism: `sides` corners of radius `radius` (`halfWidth` for a
 * square post: the corner radius is set so the flats are that far out) from
 * `y0` to `y1` round `at`; optional flat top (`top` paint, n − 2 triangles)
 * or pyramid cap (`cap`: height and paint, n triangles). 2n side triangles.
 */
export function farPrism(
  m: SolidMesh,
  o: { at: Vec3; y0: number; y1: number; sides: number; radius?: number; halfWidth?: number; startDeg?: number; top?: Paint; cap?: { height: number; paint: Paint; halfWidth?: number } },
  p: Paint,
): void {
  const c = v3(o.at);
  const n = o.sides;
  const R = o.radius ?? (o.halfWidth ?? 0.1) / Math.cos(Math.PI / n);
  const a0 = ((o.startDeg ?? (n === 4 ? 45 : 0)) * Math.PI) / 180;
  const ring = (y: number): Vector3[] => Array.from({ length: n }, (_, k) => new Vector3(c.x + Math.sin(a0 + (k / n) * Math.PI * 2) * R, y, c.z + Math.cos(a0 + (k / n) * Math.PI * 2) * R));
  const lo = ring(o.y0);
  const hi = ring(o.y1);
  const axis = new Vector3(c.x, (o.y0 + o.y1) / 2, c.z);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    outTri(m, lo[k], lo[k1], hi[k1], axis, p);
    outTri(m, lo[k], hi[k1], hi[k], axis, p);
  }
  const up = new Vector3(0, 1, 0);
  if (o.cap) {
    const apex = new Vector3(c.x, o.y1 + o.cap.height, c.z);
    // An overhanging cap (`cap.halfWidth` wider than the prism) sits on its
    // own ring; its underside stays open (it is under the eaves).
    const base = o.cap.halfWidth === undefined ? hi : ring(o.y1).map((q) => new Vector3(c.x + (q.x - c.x) * (o.cap!.halfWidth! / (R * Math.cos(Math.PI / n))), q.y, c.z + (q.z - c.z) * (o.cap!.halfWidth! / (R * Math.cos(Math.PI / n)))));
    for (let k = 0; k < n; k++) outTri(m, apex, base[k], base[(k + 1) % n], axis, o.cap.paint);
  } else if (o.top) {
    for (let k = 1; k < n - 1; k++) dirTri(m, hi[0], hi[k], hi[k + 1], up, o.top);
  }
}

/** A box between two corners, faces optional (null = left open). */
export function farBox(m: SolidMesh, min: Vec3, max: Vec3, p: Paint, open: { bottom?: boolean; ends?: boolean; top?: boolean } = {}): void {
  const a = v3(min);
  const b = v3(max);
  const c = a.add(b).scale(0.5);
  const P = (x: number, y: number, z: number): Vector3 => new Vector3(x ? b.x : a.x, y ? b.y : a.y, z ? b.z : a.z);
  const quad = (q: Vector3[]): void => {
    outTri(m, q[0], q[1], q[2], c, p);
    outTri(m, q[0], q[2], q[3], c, p);
  };
  if (!open.top) quad([P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)]);
  quad([P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)]); // −z
  quad([P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)]); // +z
  if (!open.bottom) quad([P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)]);
  if (!open.ends) {
    quad([P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)]);
    quad([P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)]);
  }
}

/**
 * A rail seen from far away, in 4 triangles: a ridge along x from `x0` to
 * `x1` — two sloped faces from the bottom edges (z = ±`halfDepth`, y − h) up
 * to one ridge line (z = 0, y + h). From the side it is the rail's full
 * height, from above and along its length it still shows both faces (an
 * open-topped box of the same 4 triangles is two vertical cards: wires from
 * above, nothing edge-on). Bottom and ends open (ends sit in posts).
 */
export function farRidge(m: SolidMesh, x0: number, x1: number, y: number, h: number, halfDepth: number, p: Paint): void {
  const inside = new Vector3((x0 + x1) / 2, y - h, 0);
  for (const s of [-1, 1]) {
    const a = new Vector3(x0, y - h, s * halfDepth);
    const b = new Vector3(x1, y - h, s * halfDepth);
    const c = new Vector3(x1, y + h, 0);
    const d = new Vector3(x0, y + h, 0);
    outTri(m, a, b, c, inside, p);
    outTri(m, a, c, d, inside, p);
  }
}

/**
 * A flag / banner cloth seen from far away: a two-sided card (4 triangles)
 * in the field colour with its checks as squares a hair in front (2 each):
 * a `cols` × `rows` checker over the card inset by `margin` metres, the
 * squares where (col + row + parity) is even. `back` repeats them behind.
 * `origin` = top-left corner seen from the front, `u` = right, `v` = down,
 * `n` = toward the front viewer (all unit).
 */
export function farCheckerCard(
  m: SolidMesh,
  o: { origin: Vec3; u: Vec3; v: Vec3; n: Vec3; width: number; height: number; cols: number; rows: number; parity?: number; margin?: number; back?: boolean; field: Paint; check: Paint },
): void {
  const O = v3(o.origin), U = v3(o.u), V = v3(o.v), N = v3(o.n);
  const at = (x: number, y: number, off: number): Vector3 => O.add(U.scale(x)).add(V.scale(y)).add(N.scale(off));
  const card = (off: number, face: Vector3, p: Paint, x0: number, y0: number, x1: number, y1: number): void => {
    const q = [at(x0, y0, off), at(x1, y0, off), at(x1, y1, off), at(x0, y1, off)];
    dirTri(m, q[0], q[1], q[2], face, p);
    dirTri(m, q[0], q[2], q[3], face, p);
  };
  card(0, N, o.field, 0, 0, o.width, o.height);
  card(-0.004, N.scale(-1), o.field, 0, 0, o.width, o.height);
  const mg = o.margin ?? 0;
  const cw = (o.width - 2 * mg) / o.cols;
  const ch = (o.height - 2 * mg) / o.rows;
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      if ((c + r + (o.parity ?? 0)) % 2 !== 0) continue;
      const x0 = mg + c * cw, y0 = mg + r * ch;
      card(0.006, N, o.check, x0, y0, x0 + cw, y0 + ch);
      // The same cell seen through from behind (it is printed through).
      if (o.back) card(-0.01, N.scale(-1), o.check, x0, y0, x0 + cw, y0 + ch);
    }
  }
}

/** An ellipsoidal mass: centre, half extents, and (optionally) the height
 * of its flat underside. */
export interface Mass {
  at: readonly [number, number, number];
  radii: readonly [number, number, number];
  /** Underside y (default at.y − radii.y). */
  bottom?: number;
}

/**
 * Merge masses into `k` groups (k-means on the centres, seeded with the
 * largest mass and then the farthest ones — deterministic) and return each
 * group's box as a mass a little inside it (the union of overlapping
 * ellipsoids fills its box less than one ellipsoid of the same box would
 * overfill it). `shrink` is that factor across (default 0.9).
 */
export function groupMasses(masses: readonly Mass[], k: number, shrink = 0.9): { at: Vector3; radii: Vector3; bottom: number }[] {
  const n = masses.length;
  k = Math.max(1, Math.min(k, n));
  const c = masses.map((q) => new Vector3(q.at[0], q.at[1], q.at[2]));
  const vol = masses.map((q) => q.radii[0] * q.radii[1] * q.radii[2]);
  const centres: Vector3[] = [c[vol.indexOf(Math.max(...vol))].clone()];
  while (centres.length < k) {
    let best = 0, bestD = -1;
    c.forEach((p, i) => {
      const d = Math.min(...centres.map((q) => Vector3.DistanceSquared(p, q)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    centres.push(c[best].clone());
  }
  let assign = new Array<number>(n).fill(0);
  for (let it = 0; it < 8; it++) {
    assign = c.map((p) => {
      let bi = 0, bd = Infinity;
      centres.forEach((q, j) => {
        const d = Vector3.DistanceSquared(p, q);
        if (d < bd) {
          bd = d;
          bi = j;
        }
      });
      return bi;
    });
    centres.forEach((q, j) => {
      const members = c.filter((_, i) => assign[i] === j);
      if (members.length) q.copyFrom(members.reduce((s, p) => s.add(p), new Vector3()).scale(1 / members.length));
    });
  }
  const out: { at: Vector3; radii: Vector3; bottom: number }[] = [];
  for (let j = 0; j < k; j++) {
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    masses.forEach((q, i) => {
      if (assign[i] !== j) return;
      lo.minimizeInPlaceFromFloats(q.at[0] - q.radii[0], q.bottom ?? q.at[1] - q.radii[1], q.at[2] - q.radii[2]);
      hi.maximizeInPlaceFromFloats(q.at[0] + q.radii[0], q.at[1] + q.radii[1], q.at[2] + q.radii[2]);
    });
    if (!Number.isFinite(lo.x)) continue;
    const at = lo.add(hi).scale(0.5);
    out.push({ at, radii: hi.subtract(lo).scale(0.5).multiplyByFloats(shrink, 1, shrink), bottom: lo.y });
  }
  return out;
}

/** The same `fitSize` the near model got, applied to a far model built in
 * the near model's unfitted frame (after its mirror and turn). */
export function applyFit(m: SolidMesh, fit: Fit, from = 0): void {
  if (fit.shift[0] || fit.shift[1] || fit.shift[2]) m.translate(fit.shift, from);
  const s = fit.scale;
  m.displace((q) => [q.x * s[0], q.y > 0 ? q.y * s[1] : q.y, q.z * s[2]], from);
}
