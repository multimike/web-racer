import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  blob,
  box,
  compose,
  cylinder,
  extrudePolygon,
  frame,
  frustum,
  icosphere,
  polygonFacing,
  quadFacing,
  revolve,
  rng,
  rotation,
  roundedBox,
  roundedRectRing,
  soften,
  sphere,
  translation,
} from '../../../gfx/solid';
import type { Paint, SolidMesh, Vec2 } from '../../../gfx/solid';
import { facadePoint, toFacade } from './facade';
import type { Facade } from './facade';
import type { BuildingPaints } from './paints';
import { bracket } from './roofs';
import { beam, plankPanel } from './shapes';
import { kneeBrace } from './walls';

/**
 * Everything the sheets hang on or stand beside a building: awnings,
 * pergolas, railings, balconies, steps and stairs, lamps, signs, and the
 * small dressing (barrels, crates, planters).
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Awning

export interface AwningOptions {
  on: Facade;
  /** Centre along the wall and height of the top edge at the wall. */
  u: number;
  v: number;
  width: number;
  projection?: number;
  drop?: number;
  /** Number of stripes — odd, so both ends get the first colour (default 9). */
  stripes?: number;
  /** Height of the scalloped valance hanging from the front edge (0 = none). */
  valance?: number;
  /** Stripe paints (default scheme accent + cream canvas). */
  paints?: readonly [Paint, Paint];
  /** Curved timber brackets under it (default 2; 0 = none). */
  brackets?: number;
}

/**
 * Striped canvas awning with a scalloped valance (B08's shop front). The
 * stripes are separate strips of geometry, never a texture.
 *   awning(m, { on: F.front, u: 0, v: 3.0, width: 7.4, projection: 1.3, drop: 0.6 }, P);
 */
export function awning(m: SolidMesh, o: AwningOptions, P: BuildingPaints): void {
  const start = m.mark();
  const pr = o.projection ?? 1.2;
  const drop = o.drop ?? 0.5;
  const n = Math.max(1, Math.round(o.stripes ?? 9));
  const vh = o.valance ?? 0.24;
  const [A, B] = o.paints ?? [P.accent, P.fabric];
  const t = 0.05;
  const len = Math.hypot(pr, drop);
  const tv = (t * len) / pr; // vertical thickness
  const sw = o.width / n;
  const x0 = o.u - o.width / 2;
  const zw = -0.04; // buried in the wall
  const yAt = (z: number): number => o.v - (drop * z) / pr;
  const up = V(0, pr, drop);
  for (let i = 0; i < n; i++) {
    const p = i % 2 ? B : A;
    const a = x0 + i * sw;
    const b = a + sw;
    quadFacing(m, V(a, yAt(zw), zw), V(b, yAt(zw), zw), V(b, yAt(pr), pr), V(a, yAt(pr), pr), up, p);
    quadFacing(m, V(a, yAt(zw) - tv, zw), V(b, yAt(zw) - tv, zw), V(b, yAt(pr - t) - tv, pr - t), V(a, yAt(pr - t) - tv, pr - t), up.scale(-1), p);
    // Valance tab: straight drop, then a half-round scallop.
    const yT = yAt(pr);
    const rad = Math.min(sw / 2, Math.max(0.02, vh));
    const yM = yT - Math.max(vh, tv + 0.01) + (vh > 0 ? rad : 0);
    const outline: [number, number][] = [[a, yT], [a, yM]];
    if (vh > 0) {
      const steps = 4;
      for (let k = 1; k < steps; k++) {
        const ang = Math.PI + (k / steps) * Math.PI;
        outline.push([(a + b) / 2 + Math.cos(ang) * rad, yM + Math.sin(ang) * rad]);
      }
    }
    outline.push([b, yM], [b, yT]);
    polygonFacing(m, outline.map(([x, y]) => V(x, y, pr)), V(0, 0, 1), p);
    polygonFacing(m, outline.map(([x, y]) => V(x, y, pr - t)), V(0, 0, -1), p);
    for (let k = 1; k + 2 < outline.length; k++) {
      const [ax, ay] = outline[k];
      const [bx, by] = outline[k + 1];
      quadFacing(m, V(ax, ay, pr), V(bx, by, pr), V(bx, by, pr - t), V(ax, ay, pr - t), V((ax + bx) / 2 - (a + b) / 2, (ay + by) / 2 - yM - 0.001, 0), p);
    }
    // Close the two free ends of the whole awning.
    for (const [x, sx] of [[a, -1], [b, 1]] as const) {
      if ((sx < 0 && i > 0) || (sx > 0 && i < n - 1)) continue;
      quadFacing(m, V(x, yAt(zw), zw), V(x, yAt(pr), pr), V(x, yAt(pr - t) - tv, pr - t), V(x, yAt(zw) - tv, zw), V(sx, 0, 0), p);
      quadFacing(m, V(x, yT, pr), V(x, yM, pr), V(x, yM, pr - t), V(x, yT, pr - t), V(sx, 0, 0), p);
    }
  }
  toFacade(m, start, o.on);
  const count = o.brackets ?? 2;
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    const bu = o.u - o.width / 2 + 0.25 + f * (o.width - 0.5);
    bracket(m, { on: o.on, u: bu, v: yAt(pr * 0.75) - tv + 0.02, projection: pr * 0.75, drop: Math.min(0.7, pr * 0.6), thickness: 0.12 }, P.timber);
  }
}

// ---------------------------------------------------------------------------
// Pergola

export interface PergolaOptions {
  /** Centre of the footprint (x, z) and the level it stands on. */
  at: readonly [number, number];
  base: number;
  /** Footprint between post centres (x, z) and height to the rafter tops. */
  size: readonly [number, number];
  height: number;
  /** Rafters across the top (default from the width, ~0.45 m apart). */
  rafters?: number;
  /** Which way the rafters run (default 'z'; the two carrier beams then run along x). */
  rafterAxis?: 'x' | 'z';
  /** How far beams and rafters sail past the posts (default 0.28). */
  overhang?: number;
  postSize?: number;
  braces?: boolean;
  paint?: Paint;
}

/** Timber pergola (B05's roof terrace; any garden corner): four posts, two
 * carrier beams, a row of rafters with sailing ends, knee braces. */
export function pergola(m: SolidMesh, o: PergolaOptions, P: BuildingPaints): void {
  const start = m.mark();
  const p = o.paint ?? P.timber;
  const ps = o.postSize ?? 0.18;
  const oh = o.overhang ?? 0.28;
  const alongX = o.rafterAxis === 'x';
  // Canonical: carriers along x, rafters along z.
  const [sx, sz] = alongX ? [o.size[1], o.size[0]] : o.size;
  const rafterH = 0.16;
  const carrierH = 0.2;
  const yTop = o.base + o.height;
  const yCarrier = yTop - rafterH * 0.75 - carrierH / 2;
  for (const ix of [1, -1]) {
    for (const iz of [1, -1]) {
      const x = (ix * sx) / 2;
      const z = (iz * sz) / 2;
      beam(m, { from: [x, o.base - 0.03, z], to: [x, yCarrier + carrierH * 0.3, z], size: ps, side: [0, 0, 1], caps: 'start' }, p);
      if (o.braces ?? true) kneeBrace(m, { at: [x, yCarrier - carrierH * 0.2, z], along: [-ix, 0, 0], reach: Math.min(0.5, sx * 0.22), size: ps * 0.62 }, p);
    }
  }
  for (const iz of [1, -1]) {
    beam(m, { from: [-sx / 2 - oh, yCarrier, (iz * sz) / 2], to: [sx / 2 + oh, yCarrier, (iz * sz) / 2], size: [ps * 0.8, carrierH], side: [0, 1, 0], segments: 2 }, p);
  }
  const count = o.rafters ?? Math.max(3, Math.round(sx / 0.45) + 1);
  for (let i = 0; i < count; i++) {
    const x = -sx / 2 - oh * 0.6 + (i / (count - 1)) * (sx + oh * 1.2);
    // Thin, in the open, both ends free: a plain four-sided bar in one piece.
    beam(m, { from: [x, yTop - rafterH / 2, -sz / 2 - oh], to: [x, yTop - rafterH / 2, sz / 2 + oh], size: [0.1, rafterH], side: [0, 1, 0], chamfer: 0, segments: 1 }, p);
  }
  m.transform(compose(rotation('y', alongX ? 90 : 0), translation(o.at[0], 0, o.at[1])), start);
}

// ---------------------------------------------------------------------------
// Railing and balcony

export interface RailingOptions {
  /** Plan polyline (x, z) the railing follows; posts stand on every vertex. */
  path: readonly (readonly [number, number])[];
  /** Level it stands on, and its height (R01: 1.0 m). */
  base: number;
  height?: number;
  /**
   * 'rails'     chunky posts with caps + two round metal rails (B05 roof deck)
   * 'balusters' posts, top and bottom rail, a row of square balusters (B06 balcony)
   * 'boards'    posts with caps + two flat boards (B03 porch)
   */
  style?: 'rails' | 'balusters' | 'boards';
  /** Longest gap between posts before an extra one is added (default 1.6). */
  spacing?: number;
  postSize?: number;
  /** Leave out the first / last post where the run dies into a wall. */
  skipEnds?: 'start' | 'end' | 'both';
  postPaint?: Paint;
  railPaint?: Paint;
  capPaint?: Paint;
}

/**
 * A railing along a plan polyline.
 *   railing(m, { path: [[-2.3, -2.3], [2.3, -2.3], [2.3, 2.3]], base: 2.9, style: 'rails' }, P);
 */
export function railing(m: SolidMesh, o: RailingOptions, P: BuildingPaints): void {
  const style = o.style ?? 'rails';
  const h = o.height ?? 1.0;
  const ps = o.postSize ?? (style === 'balusters' ? 0.13 : 0.15);
  const postPaint = o.postPaint ?? (style === 'rails' ? P.trim : style === 'boards' ? P.timber : P.frame);
  const railPaint = o.railPaint ?? (style === 'rails' ? P.metal : style === 'boards' ? P.trim : P.frame);
  const pts = o.path;
  const posts: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.ceil(len / (o.spacing ?? 1.6) - 1e-6));
    for (let k = 0; k < bays; k++) posts.push([ax + ((bx - ax) * k) / bays, az + ((bz - az) * k) / bays]);
    // A closed loop comes back to its first post: do not stand a second one in it.
    const closes = Math.hypot(bx - pts[0][0], bz - pts[0][1]) < 1e-6;
    if (i === pts.length - 2 && !closes) posts.push([bx, bz]);
    // Rails span the whole segment; posts are simply threaded onto them.
    const A = (y: number): [number, number, number] => [ax, o.base + y, az];
    const B = (y: number): [number, number, number] => [bx, o.base + y, bz];
    if (style === 'rails') {
      for (const f of [0.52, 0.86]) cylinder(m, { from: A(h * f), to: B(h * f), radius: 0.032, sides: 6, caps: false }, railPaint);
    } else if (style === 'boards') {
      for (const f of [0.42, 0.78]) beam(m, { from: A(h * f), to: B(h * f), size: [0.05, 0.15], side: [0, 1, 0], caps: false }, railPaint);
    } else {
      beam(m, { from: A(h - 0.045), to: B(h - 0.045), size: [0.15, 0.09], side: [0, 1, 0], caps: false, segments: 1 }, railPaint);
      beam(m, { from: A(0.13), to: B(0.13), size: [0.09, 0.07], side: [0, 1, 0], caps: false, chamfer: 0, segments: 1 }, railPaint);
      // The sheets' balusters are toy-chunky: 7.5 cm square, a hand apart.
      const count = Math.max(1, Math.round(len / 0.26) - 1);
      for (let k = 1; k <= count; k++) {
        const f = k / (count + 1);
        const x = ax + (bx - ax) * f;
        const z = az + (bz - az) * f;
        beam(m, { from: [x, o.base + 0.13, z], to: [x, o.base + h - 0.05, z], size: 0.075, chamfer: 0, side: [bx - ax, 0, bz - az], caps: false }, railPaint);
      }
    }
  }
  posts.forEach(([x, z], i) => {
    if ((i === 0 && (o.skipEnds === 'start' || o.skipEnds === 'both')) || (i === posts.length - 1 && (o.skipEnds === 'end' || o.skipEnds === 'both'))) return;
    const top = o.base + h + (style === 'balusters' ? 0.04 : 0.02);
    // A post standing on the ground gets a closed foot (sloping ground can
    // show it); one on a deck or balcony is sunk into it.
    const foot = o.base < 0.3;
    beam(m, { from: [x, o.base - (foot ? 0.1 : 0.04), z], to: [x, top, z], size: ps, side: [0, 0, 1], caps: style === 'balusters' ? (foot ? true : 'end') : foot ? 'start' : false }, postPaint);
    if (style !== 'balusters') {
      beam(m, { from: [x, top - 0.03, z], to: [x, top + 0.07, z], size: ps + 0.06, chamfer: 0.025, side: [0, 0, 1] }, o.capPaint ?? P.trim);
    }
  });
}

export interface BalconyOptions {
  on: Facade;
  /** Centre along the wall and the height of the deck's top surface. */
  u: number;
  v: number;
  width: number;
  projection?: number;
  /** Deck slab thickness (default 0.2 — the brief asks for a solid underside). */
  thickness?: number;
  /** Curved brackets under the deck (default 2). */
  brackets?: number;
  /** Railing round the three open sides (default 'balusters'; false = none). */
  rail?: RailingOptions['style'] | false;
  railHeight?: number;
  deckPaint?: Paint;
  bracketPaint?: Paint;
}

/** A projecting balcony: solid rounded deck, timber brackets, railing on the
 * three open sides (B06). */
export function balcony(m: SolidMesh, o: BalconyOptions, P: BuildingPaints): void {
  const start = m.mark();
  const pr = o.projection ?? 0.9;
  const t = o.thickness ?? 0.2;
  roundedBox(m, { min: [o.u - o.width / 2, o.v - t, -0.06], max: [o.u + o.width / 2, o.v, pr], radius: Math.min(0.06, t * 0.35), segments: 1, faces: { nz: null } }, o.deckPaint ?? P.trim);
  toFacade(m, start, o.on);
  const count = o.brackets ?? 2;
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    bracket(m, { on: o.on, u: o.u - o.width / 2 + 0.22 + f * (o.width - 0.44), v: o.v - t + 0.03, projection: pr * 0.8, drop: Math.min(0.6, pr * 0.7) }, o.bracketPaint ?? P.timber);
  }
  const rail = o.rail ?? 'balusters';
  if (rail) {
    const inset = 0.09;
    const corner = (su: number, w: number): [number, number] => {
      const q = facadePoint(o.on, o.u + su * (o.width / 2 - inset), 0, w);
      return [q.x, q.z];
    };
    railing(m, { path: [corner(-1, 0.02), corner(-1, pr - inset), corner(1, pr - inset), corner(1, 0.02)], base: o.v, height: o.railHeight ?? 0.95, style: rail, skipEnds: 'both' }, P);
  }
}

// ---------------------------------------------------------------------------
// Steps and stairs

export interface StepsOptions {
  on: Facade;
  /** Centre along the wall, width of the TOP step, and the level it reaches
   * (the door's threshold). */
  u: number;
  width: number;
  top: number;
  /** Number of steps (default: enough for risers ≤ 0.24 m). */
  steps?: number;
  /** Going of each step (default 0.36). */
  tread?: number;
  /** How much wider each lower step is, per side (default 0.2). */
  flare?: number;
  paint?: Paint;
}

/**
 * Door steps: stacked rounded slabs, each lower one longer and wider (the
 * cream steps of B04 / B10). The lowest reaches 10 cm below the ground.
 * Returns how far the steps reach out of the wall, for the collider.
 */
export function steps(m: SolidMesh, o: StepsOptions, P: BuildingPaints): number {
  const start = m.mark();
  const count = o.steps ?? Math.max(1, Math.ceil(o.top / 0.24));
  const riser = o.top / count;
  const tread = o.tread ?? 0.36;
  const flare = o.flare ?? 0.2;
  for (let i = 0; i < count; i++) {
    const yTop = o.top - i * riser;
    const yBottom = i === count - 1 ? -0.1 : yTop - riser - 0.03;
    const w = o.width / 2 + i * flare;
    roundedBox(m, { min: [o.u - w, yBottom, -0.05], max: [o.u + w, yTop, (i + 1) * tread], radius: Math.min(0.055, riser * 0.3), segments: 1, faces: i === count - 1 ? undefined : { ny: null } }, o.paint ?? P.trim);
  }
  toFacade(m, start, o.on);
  return count * tread;
}

export interface StairFlightOptions {
  /** Centre of the foot (on the ground) and centre of the top edge. */
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  width: number;
  /** Number of risers (default: rise / 0.2). */
  steps?: number;
  /**
   * 'slab'   one solid stepped body with a sloping underside (B05's cream stair)
   * 'ground' the same, filled down to the ground (a stair against a bank)
   * 'open'   two stringers with separate treads (B03's timber stair)
   */
  style?: 'slab' | 'ground' | 'open';
  paint?: Paint;
  treadPaint?: Paint;
}

/**
 * A straight flight between two points.
 *   stairFlight(m, { from: [2.0, 0, 3.1], to: [-2.0, 2.8, 3.1], width: 1.0, style: 'slab' }, P);
 * Add `railing({ path: … })` beside it where the sheet shows one.
 */
export function stairFlight(m: SolidMesh, o: StairFlightOptions, P: BuildingPaints): void {
  const start = m.mark();
  const dx = o.to[0] - o.from[0];
  const dz = o.to[2] - o.from[2];
  const run = Math.hypot(dx, dz);
  const rise = o.to[1] - o.from[1];
  const n = o.steps ?? Math.max(2, Math.round(rise / 0.2));
  const going = run / n;
  const riser = rise / n;
  const style = o.style ?? 'slab';
  const p = o.paint ?? (style === 'open' ? P.timber : P.trim);
  // Built in a side view: x = along the run, y = up, z = across.
  if (style === 'open') {
    const slope = Math.hypot(run, rise);
    // The stringers follow the line 6 cm under the nosings and start where
    // their lower corner is 10 cm underground — no deeper, or the foot of the
    // stair digs a quarter of a meter below the asset's base.
    const sd = 0.26;
    const y0 = -0.1 + (sd / 2) * (run / slope);
    const x0 = ((y0 + 0.06) * run) / rise;
    for (const s of [1, -1]) {
      const z = s * (o.width / 2 - 0.05);
      beam(m, { from: [x0, y0, z], to: [run, rise - 0.06, z], size: [0.08, sd], side: [-rise, run, 0] }, p);
    }
    for (let i = 0; i < n; i++) {
      // Plain boards: fourteen rounded treads would cost more than the house's roof.
      box(m, { min: [i * going + 0.02, (i + 1) * riser - 0.07, -o.width / 2 + 0.06], max: [(i + 1) * going + 0.05, (i + 1) * riser, o.width / 2 - 0.06] }, o.treadPaint ?? p);
    }
  } else {
    const outline: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      outline.push([i * going, i * riser], [i * going, (i + 1) * riser]);
    }
    outline.push([run, rise]);
    if (style === 'ground') {
      outline.push([run, -0.1], [0, -0.1]);
    } else {
      // Sloping underside, a slab's thickness below the nosing line.
      const drop = 0.32;
      outline.push([run, rise - drop - riser], [going, -0.1], [0, -0.1]);
    }
    extrudePolygon(m, { outline, depth: o.width, centered: true, bevel: 0.025, bevelBack: true }, p);
  }
  const ux = dx / run;
  const uz = dz / run;
  m.transform(frame([o.from[0], o.from[1], o.from[2]], [ux, 0, uz], [0, 1, 0], [-uz, 0, ux]), start);
}

// ---------------------------------------------------------------------------
// Lamps

export interface WallLampOptions {
  on: Facade;
  u: number;
  v: number;
  /** Casing size (default L01: 0.5 × 0.28 m; taller than wide = a vertical lamp). */
  size?: readonly [number, number];
  /** Lens paint (default the warm lamp; `P.lampCool` for the garage strips). */
  lens?: Paint;
  /** Cage bar across the lens (default true). */
  cage?: boolean;
  casing?: Paint;
}

/** L01 — the village's rounded bulkhead lamp: chunky cream casing, glowing
 * pill lens, one cage bar. Emissive lives on the lens only.
 * It stands 0.1 m proud of the wall, a trim band 0.1 – 0.16 and a parapet
 * band 0.12: a lamp that overlaps one is swallowed by it. Keep
 * `v + height / 2` BELOW the underside of any `trimBand`, `flatRoof` band or
 * balcony slab above it (and `v − height / 2` above the door surround). */
export function wallLamp(m: SolidMesh, o: WallLampOptions, P: BuildingPaints): void {
  const start = m.mark();
  const [w, h] = o.size ?? [0.5, 0.28];
  const r = Math.min(w, h) / 2;
  const casing = o.casing ?? P.trim;
  extrudePolygon(m, { outline: roundedRectRing(w, h, r, 2), depth: 0.1, bevel: Math.min(0.03, r * 0.5), back: false, at: [o.u, o.v, -0.02] }, soften(casing, 45));
  // The casing's rim narrows on a small lamp, so the lens stays a lens; its
  // bevel stays under a third of its height (a larger one folds the face).
  const rim = Math.min(0.06, Math.min(w, h) * 0.22);
  const lw = w - rim * 2;
  const lh = h - rim * 2;
  extrudePolygon(m, { outline: roundedRectRing(lw, lh, Math.min(lw, lh) / 2, 2), depth: 0.05, bevel: Math.min(0.03, Math.min(lw, lh) * 0.3), back: false, at: [o.u, o.v, 0.075] }, soften(o.lens ?? P.lamp, 45));
  if (o.cage ?? true) {
    const vertical = w >= h;
    const bar = 0.035;
    if (vertical) box(m, { min: [o.u - bar / 2, o.v - h / 2 + 0.03, 0.07], max: [o.u + bar / 2, o.v + h / 2 - 0.03, 0.14], faces: { nz: null } }, casing);
    else box(m, { min: [o.u - w / 2 + 0.03, o.v - bar / 2, 0.07], max: [o.u + w / 2 - 0.03, o.v + bar / 2, 0.14], faces: { nz: null } }, casing);
  }
  toFacade(m, start, o.on);
}

export interface LanternOptions {
  /** The point it hangs from (top of its ring). */
  at: readonly [number, number, number];
  /** Body width (default 0.24). */
  size?: number;
}

/** A hanging lantern: iron cap and base, glowing four-sided body. Hang it
 * from a beam end, a pergola, or `wallLantern`'s arm. */
export function lantern(m: SolidMesh, o: LanternOptions, P: BuildingPaints): void {
  const start = m.mark();
  const s = o.size ?? 0.24;
  const r = s * 0.7;
  // Hanging down from the origin.
  cylinder(m, { from: [0, -0.1, 0], to: [0, 0.01, 0], radius: 0.018, sides: 5, caps: false }, P.iron);
  frustum(m, { radiusBottom: r * 1.15, radiusTop: r * 0.35, from: [0, -0.1 - s * 0.45, 0], to: [0, -0.1, 0], sides: 4, round: false }, P.iron);
  frustum(m, { radiusBottom: r * 0.72, radiusTop: r * 0.95, from: [0, -0.1 - s * 1.5, 0], to: [0, -0.1 - s * 0.42, 0], sides: 4, round: false, caps: false }, P.lamp);
  frustum(m, { radiusBottom: r * 0.6, radiusTop: r * 0.9, from: [0, -0.1 - s * 1.72, 0], to: [0, -0.1 - s * 1.46, 0], sides: 4, round: false }, P.iron);
  m.transform(compose(rotation('y', 45), translation(o.at[0], o.at[1], o.at[2])), start);
}

export interface WallLanternOptions {
  on: Facade;
  u: number;
  /** Height of the arm. */
  v: number;
  /** How far the arm reaches out of the wall (default 0.45). */
  reach?: number;
  size?: number;
  /** Mounted on something that stands this far out of the wall (a corner
   * post, a pilaster): the arm starts from that face. Default 0. */
  proud?: number;
}

/** A lantern on a short iron wall arm (beside a door, on a shop front). */
export function wallLantern(m: SolidMesh, o: WallLanternOptions, P: BuildingPaints): void {
  const w0 = (o.proud ?? 0) - 0.03;
  const reach = (o.proud ?? 0) + (o.reach ?? 0.45);
  const a = facadePoint(o.on, o.u, o.v, w0);
  const b = facadePoint(o.on, o.u, o.v, reach);
  const c = facadePoint(o.on, o.u, o.v - 0.28, w0);
  const side = facadePoint(o.on, o.u + 1, o.v, 0).subtract(facadePoint(o.on, o.u, o.v, 0));
  beam(m, { from: a, to: b, size: 0.05, side }, P.iron);
  beam(m, { from: c, to: facadePoint(o.on, o.u, o.v - 0.02, w0 + (reach - w0) * 0.7), size: 0.04, side }, P.iron);
  const tip = facadePoint(o.on, o.u, o.v - 0.02, reach - 0.06);
  lantern(m, { at: [tip.x, tip.y, tip.z], size: o.size }, P);
}

// ---------------------------------------------------------------------------
// Signs and emblems

/**
 * Emblem outlines, drawn as SEEN from the front in a box about 1 unit wide
 * centred on the origin (x right, y up). `emblem` scales them.
 */
export const EMBLEMS = {
  /** Double open-ended spanner, lying flat (the garage's sign). */
  wrench: ((): Vec2[] => {
    const R = 0.17;
    const hh = 0.07;
    const cx = 0.33;
    const a = Math.asin(hh / R);
    const slot = 0.15;
    const pts: Vec2[] = [];
    const arc = (c: number, from: number, to: number): void => {
      const n = 5;
      for (let i = 0; i <= n; i++) {
        const t = from + ((to - from) * i) / n;
        pts.push([c + Math.cos(t) * R, Math.sin(t) * R]);
      }
    };
    // Right head: under the jaw, the slot, over the jaw; then the left head.
    arc(cx, Math.PI + a, 2 * Math.PI - a);
    pts.push([cx + Math.cos(a) * R - slot, -hh], [cx + Math.cos(a) * R - slot, hh]);
    arc(cx, a, Math.PI - a);
    arc(-cx, a, Math.PI - a);
    pts.push([-cx - Math.cos(a) * R + slot, hh], [-cx - Math.cos(a) * R + slot, -hh]);
    arc(-cx, Math.PI + a, 2 * Math.PI - a);
    return pts;
  })(),
  /** Five-pointed star. */
  star: Array.from({ length: 10 }, (_, i): Vec2 => {
    const r = i % 2 ? 0.2 : 0.5;
    const t = Math.PI / 2 + (i * Math.PI) / 5;
    return [Math.cos(t) * r, Math.sin(t) * r];
  }),
  /** Plain disc. */
  disc: Array.from({ length: 16 }, (_, i): Vec2 => [Math.cos((i * Math.PI) / 8) * 0.5, Math.sin((i * Math.PI) / 8) * 0.5]),
  /** Chevron arrow pointing right. */
  arrow: [[-0.5, -0.14], [0.05, -0.14], [0.05, -0.36], [0.5, 0], [0.05, 0.36], [0.05, 0.14], [-0.5, 0.14]] as Vec2[],
} as const;

export interface EmblemOptions {
  on: Facade;
  u: number;
  v: number;
  /** Width of the emblem (its outline is 1 unit wide). */
  size: number;
  outline: readonly Vec2[];
  /** Relief height (default 0.07). */
  depth?: number;
  /** Turn in the wall plane, degrees counter-clockwise as seen. */
  turn?: number;
}

/** A raised emblem straight on a wall — thin bevelled geometry, never a
 * texture (the big cream wrench on the garage front). */
export function emblem(m: SolidMesh, o: EmblemOptions, p: Paint): void {
  const start = m.mark();
  const t = (o.turn ?? 0) * RAD;
  const outline = o.outline.map(([x, y]): Vec2 => [(x * Math.cos(t) - y * Math.sin(t)) * o.size, (x * Math.sin(t) + y * Math.cos(t)) * o.size]);
  const depth = o.depth ?? 0.07;
  extrudePolygon(m, { outline, depth: depth + 0.02, bevel: Math.min(0.025, depth * 0.4), back: false, at: [o.u, o.v, -0.02] }, soften(p, 45));
  toFacade(m, start, o.on);
}

export interface SignBoardOptions {
  on: Facade;
  u: number;
  v: number;
  /** Board width × height. */
  size: readonly [number, number];
  /** Emblem outline on the board (see EMBLEMS), filling ~60 % of it. */
  emblem?: readonly Vec2[];
  /** Hang it square to the wall from an iron arm instead of flat on it. */
  hanging?: boolean;
  paint?: Paint;
  emblemPaint?: Paint;
}

/** A rounded sign board with a cream rim and a raised emblem; flat on the
 * wall or hanging from an arm. */
export function signBoard(m: SolidMesh, o: SignBoardOptions, P: BuildingPaints): void {
  const start = m.mark();
  const [w, h] = o.size;
  const board = o.paint ?? P.accent;
  const cream = o.emblemPaint ?? P.trim;
  const r = Math.min(w, h) * 0.18;
  const t = o.hanging ? 0.08 : 0.07;
  // Cream plate with the coloured panel standing 1.5 cm proud of it — the
  // rim is the plate showing round the panel (a rim ring with a hole costs
  // twice the triangles). Built flat (front +z) around the origin.
  const proud = 0.015;
  if (o.hanging) {
    extrudePolygon(m, { outline: roundedRectRing(w, h, r, 2), depth: t, bevel: 0.02, bevelBack: true, centered: true }, soften(cream, 45));
    for (const side of [0, 180]) {
      extrudePolygon(m, { outline: roundedRectRing(w - 0.12, h - 0.12, Math.max(0.01, r - 0.05), 2), depth: proud + 0.01, back: false, rot: [0, side, 0], at: [0, 0, (side ? -1 : 1) * (t / 2 - 0.01)] }, board);
    }
  } else {
    extrudePolygon(m, { outline: roundedRectRing(w, h, r, 2), depth: t, bevel: 0.02, back: false }, soften(cream, 45));
    extrudePolygon(m, { outline: roundedRectRing(w - 0.12, h - 0.12, Math.max(0.01, r - 0.05), 2), depth: proud + 0.01, back: false, at: [0, 0, t - 0.01] }, board);
  }
  if (o.emblem) {
    const s = Math.min(w, h * 1.6) * 0.62;
    const outline = o.emblem.map(([x, y]): Vec2 => [x * s, y * s]);
    const mirrored = outline.map(([x, y]): Vec2 => [-x, y]);
    if (o.hanging) {
      extrudePolygon(m, { outline, depth: 0.03, bevel: 0.01, back: false, at: [0, 0, t / 2 + proud - 0.005] }, cream);
      // The far face reads the right way round from the other side.
      extrudePolygon(m, { outline: mirrored, depth: 0.03, bevel: 0.01, back: false, rot: [0, 180, 0], at: [0, 0, -t / 2 - proud + 0.005] }, cream);
    } else {
      extrudePolygon(m, { outline, depth: 0.03, bevel: 0.01, back: false, at: [0, 0, t + proud - 0.005] }, cream);
    }
  }
  if (o.hanging) {
    // Turn the board square to the wall and hang it under an arm.
    const reach = w + 0.2;
    m.transform(compose(rotation('y', 90), translation(o.u, o.v - h / 2 - 0.1, reach / 2 + 0.05)), start);
    beam(m, { from: [o.u, o.v, -0.03], to: [o.u, o.v, reach + 0.08], size: 0.05, side: [1, 0, 0] }, P.iron);
    for (const z of [0.18, reach - 0.1]) cylinder(m, { from: [o.u, o.v - 0.14, z], to: [o.u, o.v, z], radius: 0.014, sides: 5, caps: false }, P.iron);
  } else {
    m.translate([o.u, o.v, -0.02], start);
  }
  toFacade(m, start, o.on);
}

// ---------------------------------------------------------------------------
// Dressing: barrel, crate, planter

export interface BarrelOptions {
  /** Plan position (x, z); stands on y = `base` (default 0). */
  at: readonly [number, number];
  base?: number;
  radius?: number;
  height?: number;
  /** Fill the top with foliage and flowers (a barrel planter). */
  planted?: boolean;
  seed?: number;
}

/** Stave barrel with two iron hoops; `planted` turns it into a flower tub. */
export function barrel(m: SolidMesh, o: BarrelOptions, P: BuildingPaints): void {
  const r = o.radius ?? 0.32;
  const h = o.height ?? 0.75;
  const y = o.base ?? 0;
  const profile: Vec2[] = [[0, 0], [r * 0.84, 0], [r * 0.93, h * 0.14], [r * 0.97, h * 0.24], [r, h * 0.5], [r * 0.97, h * 0.76], [r * 0.93, h * 0.86], [r * 0.84, h], [r * 0.7, h], [r * 0.7, h - 0.05], [0, h - 0.05]];
  // Bands 2 and 5 are the hoops.
  revolve(m, { profile, segments: 10, at: [o.at[0], y, o.at[1]] }, (band) => (band === 2 || band === 5 ? P.iron : band >= 8 ? P.timberDark : P.timber));
  if (o.planted) foliageTuft(m, [o.at[0], y + h - 0.02, o.at[1]], r * 0.85, o.seed ?? 0, P);
}

/** A mound of faceted foliage with a few flowers, for tubs and pots. */
function foliageTuft(m: SolidMesh, at: readonly [number, number, number], radius: number, seed: number, P: BuildingPaints): void {
  const r = rng(seed, 'tuft', Math.round(at[0] * 100), Math.round(at[2] * 100));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + r.range(0, 1);
    const d = i === 0 ? 0 : radius * 0.45;
    const rad = radius * (i === 0 ? 0.85 : 0.6);
    blob(m, { radii: [rad, rad * 0.8, rad], points: 10, seed: r.int(1, 9999), jitter: 0.3, at: [at[0] + Math.cos(a) * d, at[1] + rad * 0.45, at[2] + Math.sin(a) * d] }, i === 0 ? P.foliage : P.foliageLight);
  }
  const flowers = r.int(2, 4);
  for (let i = 0; i < flowers; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = radius * r.range(0.2, 0.7);
    sphere(m, { radius: radius * 0.18, segments: 4, rings: 2, at: [at[0] + Math.cos(a) * d, at[1] + radius * r.range(0.7, 1.0), at[2] + Math.sin(a) * d] }, r.chance(0.7) ? P.flower : P.flowerCenter);
  }
}

export interface CrateOptions {
  at: readonly [number, number];
  base?: number;
  /** x, y, z size (default 0.7 × 0.45 × 0.5). */
  size?: readonly [number, number, number];
  rotY?: number;
  /** Heap of produce showing over the rim, in this paint. */
  produce?: Paint;
  seed?: number;
}

/** Slatted timber crate, optionally heaped with fruit. */
export function crate(m: SolidMesh, o: CrateOptions, P: BuildingPaints): void {
  const start = m.mark();
  const [w, h, d] = o.size ?? [0.7, 0.45, 0.5];
  // Four boarded sides around a dark core.
  for (let k = 0; k < 4; k++) {
    const s = m.mark();
    const span = k % 2 ? d : w;
    const out = k % 2 ? w / 2 : d / 2;
    plankPanel(m, { x0: -span / 2, x1: span / 2, y0: 0, y1: h, z0: out - 0.05, z1: out, planks: 3, horizontal: true, groove: 0.018 }, P.timber);
    m.rotate('y', k * 90, s);
  }
  // The core reaches 3 cm under the boards and is closed below.
  box(m, { min: [-w / 2 + 0.03, -0.03, -d / 2 + 0.03], max: [w / 2 - 0.03, h - 0.06, d / 2 - 0.03] }, P.timberDark);
  // Inner lining from the floor up to the rim: the boards have no back of
  // their own, and any gap under the rim shows their inside.
  const ix = w / 2 - 0.05;
  const iz = d / 2 - 0.05;
  const ring: [number, number][] = [[ix, iz], [-ix, iz], [-ix, -iz], [ix, -iz]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = ring[k];
    const [bx, bz] = ring[(k + 1) % 4];
    quadFacing(m, V(ax, h - 0.07, az), V(bx, h - 0.07, bz), V(bx, h, bz), V(ax, h, az), V(-(ax + bx), 0, -(az + bz)), P.timberDark);
  }
  if (o.produce) {
    const r = rng(o.seed ?? 0, 'crate', Math.round(o.at[0] * 100));
    for (let i = 0; i < 5; i++) {
      icosphere(m, { radius: 0.1, subdivisions: 0, at: [r.range(-w / 2 + 0.14, w / 2 - 0.14), h - 0.05 + r.range(0, 0.05), r.range(-d / 2 + 0.14, d / 2 - 0.14)] }, o.produce);
    }
  }
  m.transform(compose(rotation('y', o.rotY ?? 0), translation(o.at[0], o.base ?? 0, o.at[1])), start);
}

export interface PlanterOptions {
  at: readonly [number, number];
  base?: number;
  /** Pot radius (default 0.26) and height (default 0.42). */
  radius?: number;
  height?: number;
  paint?: Paint;
  seed?: number;
}

/** A chunky round pot with a tuft of faceted foliage and flowers — the
 * vision image stands one beside most doors. */
export function planter(m: SolidMesh, o: PlanterOptions, P: BuildingPaints): void {
  const r = o.radius ?? 0.26;
  const h = o.height ?? 0.42;
  const y = o.base ?? 0;
  frustum(m, { radiusBottom: r * 0.72, radiusTop: r, from: [o.at[0], y - 0.03, o.at[1]], to: [o.at[0], y + h, o.at[1]], sides: 10, bevel: { top: 0.035 } }, o.paint ?? P.accent);
  foliageTuft(m, [o.at[0], y + h - 0.04, o.at[1]], r * 0.95, o.seed ?? 0, P);
}
