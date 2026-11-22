import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { box, cone, cylinder, extrudePolygon, hash3, hex, mix, paint, quadFacing, revolve, roundedBox } from '../../gfx/solid';
import type { Paint, RGB, SolidMesh, Vec3 } from '../../gfx/solid';
import { BUILDING, FLOWERS, FOLIAGE } from '../palette';

/**
 * Parts shared by the village dressing props (d07 fence … d14 signpost):
 * the timber post with its dark cap, iron bolt heads, and the small plants
 * (flower, grass blade, leaf) that several of them carry. Colours that the
 * shared palette does not hold are measured off the gameplay-vision images
 * and live here, so the eight props stay one family.
 */

// Timber in the vision comes in three tones: cinnamon posts (the palette's
// building timber), lighter orange-tan rails and planks, and pale crate wood.
export const WOOD = {
  post: BUILDING.timber,
  rail: hex('#C97D42'),
  plank: hex('#D69150'),
  pale: hex('#E0A566'),
  barrel: hex('#D98836'),
  dark: hex('#8A4C2E'),
} as const satisfies Record<string, RGB>;

/** Dark warm slate of the fence-post caps, barrel hoops and bolt heads. */
export const IRON = {
  cap: hex('#625B6E'),
  hoop: hex('#77759A'),
  bolt: hex('#4E4856'),
  pole: hex('#5A5360'),
} as const satisfies Record<string, RGB>;

export const CLOTH = {
  teal: hex('#12A9A7'),
  white: hex('#F5EFE0'),
} as const satisfies Record<string, RGB>;

export const FRUIT = {
  apple: hex('#EE4B3F'),
  greenApple: hex('#B4CE3C'),
  orange: hex('#F5931C'),
  lemon: FLOWERS.center,
  leaf: hex('#6CC02B'),
} as const satisfies Record<string, RGB>;

export const SOIL = hex('#6E4A3A');

/** Pale pink of the vision's planter blooms (the palette petal, bleached). */
export const PINK = mix(FLOWERS.petal, [1, 0.9, 0.88], 0.5);

export const timberPaint = (c: RGB, gloss = 0.22): Paint => paint(c, { gloss });
export const ironPaint = (c: RGB = IRON.bolt): Paint => paint(c, { gloss: 0.45, metal: 0.35 });

/** Triangle a-b-c wound so that it faces `dir`, with per-corner colours. */
export function triToward(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, dir: Vector3, p: Paint, colors?: readonly [RGB, RGB, RGB]): void {
  const n = Vector3.Cross(b.subtract(a), c.subtract(a));
  if (Vector3.Dot(n, dir) >= 0) m.tri(a, b, c, p, colors);
  else m.tri(a, c, b, p, colors ? [colors[0], colors[2], colors[1]] : undefined);
}

export interface PostOptions {
  /** Centre of the post on the ground. */
  x: number;
  z?: number;
  /** Height of the timber, ground to the underside of the cap. */
  height: number;
  /** Square section width. */
  width: number;
  post: Paint;
  /** Omit for a bare bevelled top. */
  cap?: Paint;
  /** How far the cap overhangs each side (default 0.025). */
  overhang?: number;
}

/** Height the cap adds on top of a post of the given width. */
export const capHeight = (width: number): number => 0.045 + width * 0.3;

/**
 * Chunky square timber post standing on y = 0 with a 5 cm skirt below, and
 * (optionally) the dark pyramid cap of the vision's fence posts: a collar
 * band wider than the post under a blunt four-sided roof. Returns the y of
 * the very top.
 */
export function timberPost(m: SolidMesh, o: PostOptions): number {
  const z = o.z ?? 0;
  const w = o.width;
  roundedBox(
    m,
    // The cap hides the top face; without a cap it stays.
    { min: [o.x - w / 2, -0.05, z - w / 2], max: [o.x + w / 2, o.height + (o.cap ? 0.02 : 0), z + w / 2], radius: w * 0.13, segments: 1, faces: { ny: null, ...(o.cap ? { py: null } : {}) } },
    o.post,
  );
  if (!o.cap) return o.height;
  const half = w / 2 + (o.overhang ?? 0.025);
  // revolve with 4 flat segments = a square in plan; its "radius" is the
  // half-diagonal, and arcStart 45 turns the flats onto the axes.
  const r = half * Math.SQRT2;
  const band = 0.045;
  const roof = w * 0.3;
  revolve(
    m,
    {
      profile: [
        [0, o.height],
        [r, o.height],
        [r, o.height + band],
        [r * 0.5, o.height + band + roof],
        [0, o.height + band + roof],
      ],
      segments: 4,
      arcStart: 45,
      round: false,
      at: [o.x, 0, z],
    },
    o.cap,
  );
  return o.height + band + roof;
}

/** Iron bolt head: a low six-sided stud pointing along `dir` (unit axis
 * vector), its base sunk 5 mm into the surface at `at`. A blunt cone rather
 * than a capped cylinder: 6 triangles instead of 16, and at 5 cm across it
 * shades as the same domed rivet. */
export function bolt(m: SolidMesh, at: Vec3, dir: Vec3, radius = 0.024, p: Paint = ironPaint()): void {
  const a = at instanceof Vector3 ? at : new Vector3(at[0], at[1], at[2]);
  const d = dir instanceof Vector3 ? dir : new Vector3(dir[0], dir[1], dir[2]);
  cone(m, { from: a.subtract(d.scale(0.005)), to: a.add(d.scale(radius * 0.75)), radius, sides: 6, caps: false }, p);
}

/**
 * Wind weight for SMALL things. The look's sway amplitude is set for tree
 * crowns (about 0.3 m at weight 1), and it moves along a fixed WORLD
 * direction whichever way the prop is turned — so a 30 cm flower or a cloth
 * hanging against a rail needs a weight that keeps its travel to a few
 * centimetres, or it swings clean through whatever it stands next to.
 */
export const SMALL_SWAY = 0.14;

export interface FlowerOptions {
  /** Centre of the bloom. */
  at: Vector3;
  /** Direction the bloom faces (need not be unit). */
  facing: Vector3;
  radius: number;
  petal: RGB;
  center?: RGB;
  petals?: number;
  /** Rotation of the petal ring about its own axis, degrees. */
  spin?: number;
}

/** Orthonormal frame around `facing`: [axis, side, forward]. */
function bloomFrame(facing: Vector3): [Vector3, Vector3, Vector3] {
  const axis = facing.normalizeToNew();
  const side = Vector3.Cross(axis, Math.abs(axis.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
  return [axis, side, Vector3.Cross(axis, side)];
}

/**
 * The vision's flower: five BLUNT rounded petals (each a trapezoid with a
 * flat tip, not a star point) cupped around a raised yellow eye about a
 * third of the bloom across, petals paling toward the eye. The underside is
 * a shallow cone on exactly the same outline, so the bloom is a closed
 * solid from every side — seen from behind it is a bloom, not a hole.
 * Triangles: 6 × petals (30 for five).
 */
export function flower(m: SolidMesh, o: FlowerOptions): void {
  const n = o.petals ?? 5;
  const [axis, side, fwd] = bloomFrame(o.facing);
  const PETAL = paint(o.petal, { gloss: 0.25, smooth: 0 });
  const EYE = paint(o.center ?? FLOWERS.center, { gloss: 0.35, smooth: 0 });
  const pale = mix(o.petal, [1, 0.95, 0.88], 0.45);
  // The back of the petals is PALER than the face: it is nearly always in
  // shade, and a deeper tone there turns a bloom seen from behind into a
  // dark blot on the leaves.
  const eye = o.center ?? FLOWERS.center;
  const eyeFoot = mix(eye, pale, 0.7);
  const under = mix(o.petal, [1, 0.93, 0.86], 0.3);
  const underTip = mix(o.petal, [1, 0.93, 0.86], 0.12);
  const R = o.radius;
  const at = (deg: number, r: number, lift: number): Vector3 => {
    const a = ((o.spin ?? 0) + deg) * (Math.PI / 180);
    return o.at.add(side.scale(Math.cos(a) * r)).add(fwd.scale(Math.sin(a) * r)).add(axis.scale(lift));
  };
  const pitch = 360 / n;
  // Broad tips and shallow notches: the petals all but touch, so the bloom
  // reads as one scalloped disc, not as a pinwheel of separate blades.
  const tipHalf = pitch * 0.4;
  // Outline, three points per petal: the notch before it and its two tip
  // corners. Tips lift into a shallow cup.
  const notch: Vector3[] = [];
  const tipA: Vector3[] = [];
  const tipB: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    notch.push(at(i * pitch - pitch / 2, R * 0.5, 0));
    tipA.push(at(i * pitch - tipHalf, R, R * 0.2));
    tipB.push(at(i * pitch + tipHalf, R, R * 0.2));
  }
  const top = o.at.add(axis.scale(R * 0.26));
  const back = o.at.subtract(axis.scale(R * 0.3));
  const down = axis.scale(-1);
  for (let i = 0; i < n; i++) {
    const n0 = notch[i];
    const n1 = notch[(i + 1) % n];
    // Petal: planar trapezoid notch → tip corner → tip corner → notch.
    triToward(m, n0, tipA[i], tipB[i], axis, PETAL, [pale, o.petal, o.petal]);
    triToward(m, n0, tipB[i], n1, axis, PETAL, [pale, o.petal, pale]);
    // Eye: a blunt pyramid standing on the ring of notches, its foot
    // running into the petal colour so the yellow stays a third of the bloom.
    triToward(m, top, n0, n1, axis, EYE, [eye, eyeFoot, eyeFoot]);
    // Underside on exactly the same outline: a cheaper cone from tip to tip
    // would span the gaps between the petals and show its inside from above.
    triToward(m, back, n0, tipA[i], down, PETAL, [under, under, underTip]);
    triToward(m, back, tipA[i], tipB[i], down, PETAL, [under, underTip, underTip]);
    triToward(m, back, tipB[i], n1, down, PETAL, [under, underTip, under]);
  }
}

/**
 * A small bloom seen from across the street: a low five-sided cone, petal
 * colour at the rim running to the eye colour at the tip. Meant to sit ON
 * foliage with its open base sunk into it. 5 triangles.
 */
export function bud(m: SolidMesh, at: Vector3, facing: Vector3, radius: number, petal: RGB, center: RGB = FLOWERS.center): void {
  const [axis, side, fwd] = bloomFrame(facing);
  const P = paint(petal, { gloss: 0.25, smooth: 0 });
  const tip = at.add(axis.scale(radius * 0.55));
  const ring: Vector3[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + radius * 40;
    ring.push(at.add(side.scale(Math.cos(a) * radius)).add(fwd.scale(Math.sin(a) * radius)).subtract(axis.scale(radius * 0.25)));
  }
  const eye = mix(center, petal, 0.15);
  for (let i = 0; i < 5; i++) triToward(m, tip, ring[i], ring[(i + 1) % 5], ring[i].add(ring[(i + 1) % 5]).scale(0.5).subtract(at).add(axis.scale(radius)), P, [eye, petal, petal]);
}

/**
 * The cheapest leaf that is still a closed solid: a sliver tetrahedron.
 * Seen from above it is a leaf folded along its midrib (root → tip), the
 * two edge points hanging `width / 2` to either side and a little below.
 * 4 triangles.
 */
export function leaf(m: SolidMesh, root: Vector3, tip: Vector3, width: number, color: RGB, tipColor?: RGB): void {
  const P = paint(color, { gloss: 0.2, smooth: 0 });
  const dir = tip.subtract(root);
  const len = dir.length();
  const d = dir.scale(1 / len);
  let side = Vector3.Cross(d, new Vector3(0, 1, 0));
  if (side.lengthSquared() < 1e-6) side = new Vector3(1, 0, 0);
  side.normalize();
  const up = Vector3.Cross(side, d).normalize();
  const mid = root.add(dir.scale(0.45)).subtract(up.scale(len * 0.12));
  const l = mid.add(side.scale(width / 2));
  const r = mid.subtract(side.scale(width / 2));
  const tc = tipColor ?? mix(color, FOLIAGE.highlight, 0.5);
  const dark = mix(color, FOLIAGE.jade, 0.35);
  triToward(m, root, l, tip, up.add(side), P, [dark, color, tc]);
  triToward(m, root, tip, r, up.subtract(side), P, [dark, tc, color]);
  const below = up.scale(-1);
  triToward(m, root, r, l, below.subtract(d), P, [dark, dark, dark]);
  triToward(m, tip, l, r, below.add(d), P, [color, dark, dark]);
}

export interface MoundOptions {
  /** Centre of the base. */
  at: Vec3;
  radius: number;
  height: number;
  /** Points per ring from the top ring down to the base ring, e.g. [5, 8]. */
  rings: readonly number[];
  seed: number;
  /** 0 = regular dome … 1 = very lumpy (default 0.5). */
  jitter?: number;
  color: RGB;
}

/**
 * Faceted foliage dome with an exact triangle count: an apex, then rings of
 * the given point counts down to the base, every point nudged by seeded
 * noise so no two facets match. Open underneath — it is planted on a tub.
 * Upward facets are tinted toward the sunlit highlight green, the skirt
 * toward jade, as on the vision's bushes.
 * Triangles: rings[0] + Σ (rings[i] + rings[i + 1]).
 */
export function mound(m: SolidMesh, o: MoundOptions): void {
  const c = o.at instanceof Vector3 ? o.at : new Vector3(o.at[0], o.at[1], o.at[2]);
  const j = o.jitter ?? 0.5;
  const P = paint(o.color, { gloss: 0.2, smooth: 0 });
  const n = o.rings.length;
  const rings: Vector3[][] = [];
  const angles: number[][] = [];
  o.rings.forEach((count, k) => {
    // Rings spaced evenly in latitude over the dome.
    // (The top ring sits a little low, so the crown is broad, not a tent.)
    const lat = ((90 * (n - 1 - k)) / n) * (k === 0 ? 0.8 : 1) * (Math.PI / 180);
    const turn = hash3(k * 7.3, o.seed, 1.7, 91) * Math.PI * 2;
    const pts: Vector3[] = [];
    const as: number[] = [];
    for (let i = 0; i < count; i++) {
      const base = k === n - 1;
      const a = turn + ((i + (hash3(i, k, o.seed, 17) - 0.5) * j * 0.6) / count) * Math.PI * 2;
      // The base ring keeps its radius and height: it has to sit on the tub.
      const rr = o.radius * Math.cos(lat) * (base ? 1 : 1 - hash3(i, k, o.seed, 29) * 0.22 * j);
      const y = o.height * Math.sin(lat) * (base ? 1 : 1 - (hash3(i, k, o.seed, 43) - 0.3) * 0.3 * j);
      as.push(a);
      pts.push(c.add(new Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr)));
    }
    rings.push(pts);
    angles.push(as);
  });
  const apex = c.add(new Vector3((hash3(o.seed, 3, 5, 7) - 0.5) * o.radius * 0.3 * j, o.height, (hash3(o.seed, 9, 2, 7) - 0.5) * o.radius * 0.3 * j));
  const start = m.mark();
  const out = (a: Vector3, b: Vector3, d: Vector3): void => {
    // Wind each facet away from the dome's centre.
    const mid = a.add(b).add(d).scale(1 / 3).subtract(c);
    triToward(m, a, b, d, mid, P);
  };
  const top = rings[0];
  for (let i = 0; i < top.length; i++) out(apex, top[i], top[(i + 1) % top.length]);
  for (let k = 0; k + 1 < n; k++) {
    // Zip two rings of different counts together, always advancing the one
    // whose next point comes first in angle.
    const A = rings[k];
    const B = rings[k + 1];
    const aA = angles[k];
    const aB = angles[k + 1];
    // Start B at the point nearest in angle to A[0].
    let b0 = 0;
    let best = Infinity;
    const wrap = (x: number): number => Math.atan2(Math.sin(x), Math.cos(x));
    for (let i = 0; i < B.length; i++) {
      const dlt = Math.abs(wrap(aB[i] - aA[0]));
      if (dlt < best) {
        best = dlt;
        b0 = i;
      }
    }
    let ia = 0;
    let ib = 0;
    while (ia < A.length || ib < B.length) {
      const a = A[ia % A.length];
      const b = B[(b0 + ib) % B.length];
      const nextA = (ia + 1) / A.length;
      const nextB = (ib + 1) / B.length;
      if (ib >= B.length || (ia < A.length && nextA <= nextB)) {
        out(a, A[(ia + 1) % A.length], b);
        ia++;
      } else {
        out(a, B[(b0 + ib + 1) % B.length], b);
        ib++;
      }
    }
  }
  m.recolor((_p, nrm, col) => (nrm.y > 0.7 ? mix(col, FOLIAGE.highlight, 0.4) : nrm.y < 0.35 ? mix(col, FOLIAGE.jade, 0.35) : col), start);
}

/**
 * Where the ray from `origin` along `dir` leaves the geometry added since
 * `from` (its OUTERMOST hit), with that facet's outward normal. For seating
 * a bloom on a faceted mound: the facets lie well inside the mound's nominal
 * dome and tilt every which way, so a bloom placed by formula ends up half
 * buried in one facet and floating over the next.
 */
export function seatOn(m: SolidMesh, from: number, origin: Vector3, dir: Vector3): { at: Vector3; normal: Vector3 } | null {
  const P = m.positions;
  const d = dir.normalizeToNew();
  let best = -1;
  let normal: Vector3 | null = null;
  for (let t = from; t < m.triangleCount; t++) {
    const i = t * 9;
    const a = new Vector3(P[i], P[i + 1], P[i + 2]);
    const e1 = new Vector3(P[i + 3] - a.x, P[i + 4] - a.y, P[i + 5] - a.z);
    const e2 = new Vector3(P[i + 6] - a.x, P[i + 7] - a.y, P[i + 8] - a.z);
    const h = Vector3.Cross(d, e2);
    const det = Vector3.Dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = origin.subtract(a);
    const u = Vector3.Dot(s, h) / det;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const q = Vector3.Cross(s, e1);
    const v = Vector3.Dot(d, q) / det;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const dist = Vector3.Dot(e2, q) / det;
    if (dist > best) {
      best = dist;
      normal = Vector3.Cross(e1, e2).normalize();
    }
  }
  if (!normal) return null;
  if (Vector3.Dot(normal, d) < 0) normal.scaleInPlace(-1);
  return { at: origin.add(d.scale(best)), normal };
}

export interface BladeOptions {
  /** Root on the ground / soil. */
  root: Vector3;
  /** Tip position. */
  tip: Vector3;
  /** Width at the widest point (a third of the way up). */
  width: number;
  color: RGB;
  /** Lighter tip colour (default: palette highlight). */
  tipColor?: RGB;
}

/**
 * One broad leaf / grass blade: a thin closed diamond from root to tip —
 * a raised midrib on top, a shallow keel underneath, the two skins sharing
 * the outline. 8 triangles. The fold is what catches the light (a flat card
 * would shade as one tone), and because the skins are apart everywhere but
 * the rim, neither side ever shows the other's back.
 */
export function blade(m: SolidMesh, o: BladeOptions): void {
  const P = paint(o.color, { gloss: 0.2, smooth: 0 });
  const dir = o.tip.subtract(o.root);
  const len = dir.length();
  const d = dir.scale(1 / len);
  let side = Vector3.Cross(d, new Vector3(0, 1, 0));
  if (side.lengthSquared() < 1e-6) side = new Vector3(1, 0, 0);
  side.normalize();
  const up = Vector3.Cross(side, d).normalize();
  const waist = o.root.add(dir.scale(0.4));
  const ridge = waist.add(up.scale(len * 0.1));
  const keel = waist.subtract(up.scale(len * 0.05));
  const l = o.root.add(dir.scale(0.38)).add(side.scale(o.width / 2));
  const r = o.root.add(dir.scale(0.38)).subtract(side.scale(o.width / 2));
  const tipC = o.tipColor ?? mix(o.color, FOLIAGE.highlight, 0.5);
  const dark = mix(o.color, FOLIAGE.jade, 0.35);
  // Upper side (two faces meeting on the midrib), then the underside.
  triToward(m, o.root, l, ridge, up.add(side), P, [dark, o.color, o.color]);
  triToward(m, l, o.tip, ridge, up.add(side), P, [o.color, tipC, o.color]);
  triToward(m, o.root, ridge, r, up.subtract(side), P, [dark, o.color, o.color]);
  triToward(m, ridge, o.tip, r, up.subtract(side), P, [o.color, tipC, o.color]);
  const below = up.scale(-1);
  triToward(m, o.root, l, keel, below.add(side), P, [dark, dark, dark]);
  triToward(m, l, o.tip, keel, below.add(side), P, [dark, o.color, dark]);
  triToward(m, o.root, keel, r, below.subtract(side), P, [dark, dark, dark]);
  triToward(m, keel, o.tip, r, below.subtract(side), P, [dark, o.color, dark]);
}

/** A thin three-sided stem from `a` to `b` (6 triangles, no caps). */
export function stem(m: SolidMesh, a: Vector3, b: Vector3, radius: number, color: RGB = FLOWERS.stem): void {
  cylinder(m, { from: a, to: b, radius, sides: 3, caps: false }, paint(color, { gloss: 0.2 }));
}

export interface FruitOptions {
  radius: number;
  color: RGB;
  /** Turns the outline so neighbours do not line up, degrees. */
  yaw?: number;
  /** Sides around (default 6). */
  sides?: number;
  /**
   * false (default): only the CAP above ~12° latitude — a fruit packed in a
   * layer, its lower half hidden by its neighbours and the container
   * (`sides` triangles). true: down to just below the equator, for a fruit
   * riding on top of the heap (3 × `sides` triangles).
   */
  full?: boolean;
  /**
   * Latitude of a cap's rim, degrees (default 12). A cap is a pyramid: at 12°
   * it is steep and reads as a cone unless its flanks are hidden. Around 30°
   * it is a shallow dome for packing rim to rim in a layer — many small
   * fruit tops, the gaps between them shade.
   */
  capLat?: number;
}

/**
 * One piece of fruit: a low-poly dome that SHADES as a ball. Every corner
 * carries the true sphere normal, so six triangles read as a round, glossy
 * apple; the vertex colours add the pale shoulder and darker flank of toy
 * fruit. Open underneath — it always sits in a heap.
 */
export function fruit(m: SolidMesh, at: Vec3, o: FruitOptions): void {
  const c = at instanceof Vector3 ? at : new Vector3(at[0], at[1], at[2]);
  const n = o.sides ?? 6;
  const R = o.radius;
  const P = paint(o.color, { gloss: 0.6, smooth: 180 });
  const light = mix(o.color, [1, 0.96, 0.85], 0.2);
  const dark = mix(o.color, [0.35, 0.1, 0.12], 0.22);
  const yaw = ((o.yaw ?? 0) * Math.PI) / 180;
  const ringAt = (latDeg: number, phase: number): { p: Vector3[]; n: Vector3[] } => {
    const lat = (latDeg * Math.PI) / 180;
    const p: Vector3[] = [];
    const nn: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = yaw + ((i + phase) / n) * Math.PI * 2;
      const dir = new Vector3(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat));
      nn.push(dir);
      p.push(c.add(dir.scale(R)));
    }
    return { p, n: nn };
  };
  const up = new Vector3(0, 1, 0);
  const apex = c.add(up.scale(R));
  const r1 = ringAt(o.full ? 42 : (o.capLat ?? 12), 0);
  const c1 = o.full ? o.color : mix(o.color, dark, 0.6);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Wound for +y up: apex, next, this.
    m.tri(apex, r1.p[j], r1.p[i], P, [light, c1, c1], [up, r1.n[j], r1.n[i]]);
  }
  if (!o.full) return;
  const r2 = ringAt(-10, 0.5);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.tri(r1.p[i], r1.p[j], r2.p[i], P, [o.color, o.color, dark], [r1.n[i], r1.n[j], r2.n[i]]);
    m.tri(r2.p[i], r1.p[j], r2.p[j], P, [dark, o.color, dark], [r2.n[i], r1.n[j], r2.n[j]]);
  }
}

/**
 * Crate slat between `a` and `b` (centre line of its inner face): a plank
 * `height` tall and `thickness` deep toward `outward`, its two outer edges
 * chamfered. No end caps and no back face — the ends are buried in corner
 * posts and the back in the crate's liner wall. 10 triangles.
 */
export function slat(m: SolidMesh, a: Vector3, b: Vector3, height: number, thickness: number, outward: Vector3, p: Paint): void {
  const c = Math.min(0.012, thickness * 0.35);
  const hh = height / 2;
  const ring: [number, number][] = [
    [0, -hh],
    [thickness - c, -hh],
    [thickness, -hh + c],
    [thickness, hh - c],
    [thickness - c, hh],
    [0, hh],
  ];
  const up = new Vector3(0, 1, 0);
  const ringAt = (o: Vector3): Vector3[] => ring.map(([t, y]) => o.add(outward.scale(t)).add(up.scale(y)));
  const A = ringAt(a);
  const B = ringAt(b);
  const core = a.add(b).scale(0.5).add(outward.scale(thickness / 2));
  for (let i = 0; i < ring.length - 1; i++) {
    const faceMid = A[i].add(A[i + 1]).add(B[i]).add(B[i + 1]).scale(0.25);
    const n = Vector3.Cross(A[i + 1].subtract(A[i]), B[i].subtract(A[i]));
    if (Vector3.Dot(n, faceMid.subtract(core)) >= 0) m.quad(A[i], A[i + 1], B[i + 1], B[i], p);
    else m.quad(A[i + 1], A[i], B[i], B[i + 1], p);
  }
}

/**
 * Four square corner posts of a crate whose outer faces are at ±halfX,
 * ±halfZ, each with its outer vertical edge chamfered, from `y0` up to
 * `y1`. Open underneath. 13 triangles each.
 */
export function crateCorners(m: SolidMesh, halfX: number, halfZ: number, size: number, y0: number, y1: number, p: Paint): void {
  const ch = size * 0.26;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Outline in top view (x right, model +z up the page).
      const outline: [number, number][] = [
        [sx * (halfX - size), sz * (halfZ - size)],
        [sx * halfX, sz * (halfZ - size)],
        [sx * halfX, sz * (halfZ - ch)],
        [sx * (halfX - ch), sz * halfZ],
        [sx * (halfX - size), sz * halfZ],
      ];
      extrudePolygon(m, { outline, depth: y1 - y0, facing: '+y', back: false, at: [0, y0, 0] }, p);
    }
  }
}

/**
 * Open-topped tray with real wall thickness: outer skin, inner skin and the
 * rim between them, nothing coincident. Spans ±halfX, ±halfZ, y0..y1; the
 * inside floor is at `floorY`. `outerBottom` adds the underside (leave it
 * off when the tray stands on the ground). 26 or 28 triangles.
 */
export function tray(m: SolidMesh, halfX: number, halfZ: number, y0: number, y1: number, floorY: number, wall: number, outer: Paint, inner: Paint, outerBottom = false): void {
  box(m, { min: [-halfX, y0, -halfZ], max: [halfX, y1, halfZ], faces: { py: null, ...(outerBottom ? {} : { ny: null }) } }, outer);
  const s = m.mark();
  box(m, { min: [-halfX + wall, floorY, -halfZ + wall], max: [halfX - wall, y1, halfZ - wall], faces: { py: null } }, inner);
  m.flip(s);
  const up = new Vector3(0, 1, 0);
  const corner = (sx: number, sz: number, inset: number): Vector3 => new Vector3(sx * (halfX - inset), y1, sz * (halfZ - inset));
  const ring: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  ring.forEach(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % 4];
    quadFacing(m, corner(ax, az, 0), corner(bx, bz, 0), corner(bx, bz, wall), corner(ax, az, wall), up, outer);
  });
}
