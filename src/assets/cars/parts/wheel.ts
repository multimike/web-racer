import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, circleRing, cylinder, darken, extrudePolygon, loft, paint, quadFacing, revolve, roundedRectRing, sphere, sweep } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { CHARCOAL, RUBBER, STEEL, asPaint } from './common';
import type { Color } from './common';

/**
 * WHEELS — chunky off-road toy tires with real 3D tread, and deep-dish rims.
 *
 * Everything here is modelled with the axle on +Y (what `revolve` makes,
 * outboard = +Y) and turned onto +X at the very end, so the public builders
 * return the wheel convention of `CarGeometry`: around the wheel centre, axle
 * along X, detailed OUTBOARD face on +X. Build ONE right-hand wheel per axle;
 * the assembler mirrors it for the left side (which also mirrors a
 * directional tread, as on a real car).
 *
 * `wheelLayout` is the single source of the wheel's inner dimensions — the
 * hub (hub.ts) and the suspension (suspension.ts) read the same numbers, so
 * the brake sits inside the rim's inboard cavity and nothing collides.
 */

// ---------------------------------------------------------------------------
// Layout shared with the hub and the suspension

export interface WheelSize {
  /** Outer tire radius over the lugs (CarSpec.frontTireRadius / rearTireRadius). */
  radius: number;
  /** Overall tire width (CarSpec.frontTireWidth / rearTireWidth). */
  width: number;
  /** Rim (bead) radius as a fraction of the tire radius. Default 0.56 — the
   * design sheets' fat-sidewall look; 0.62 reads sportier, 0.5 more balloon. */
  rimRatio?: number;
  /** Depth of the rim dish: how far the spoke face sits inboard of the rim's
   * outer ring, meters. Default 30 % of the width. The brake behind the web
   * caps it at about 40 % of the half width — on these fat tires the default
   * is already at that cap, so in practice the option makes a dish SHALLOWER. */
  dish?: number;
  /** Height of the tread lugs, meters. Default 6 % of the radius (18–32 mm). */
  lugHeight?: number;
}

/** Resolved wheel dimensions. `y` values are along the axle, outboard +. */
export interface WheelLayout {
  radius: number;
  width: number;
  lugHeight: number;
  /** Carcass radius at the crown (under the lugs). */
  crownRadius: number;
  /** Half width of the carcass at its widest point. */
  sideY: number;
  /** Radius where the carcass is widest. */
  equatorRadius: number;
  /** Bead: where the tire meets the rim. */
  beadRadius: number;
  beadY: number;
  dish: number;
  /** Outboard face of the rim's centre web (the dish floor). */
  floorY: number;
  /** Inboard face of the web = floor of the inboard cavity the brake sits in. */
  cavityY: number;
  /** Inner radius of that cavity. */
  cavityRadius: number;
}

/** Inboard end of the wheel's spinning centre boss, along the axle. The hub's
 * bearing carrier disappears into it; FIXED so the hub never depends on the
 * rim's dish. */
export const WHEEL_BOSS_END = -0.03;
export const WHEEL_BOSS_RADIUS = 0.075;

/** How far the shoulder lugs stand proud of the sidewall at its widest:
 * most of their height, so a lug reads as one chunky block from the crown
 * round to the sidewall instead of fading into a rib. */
const sideLug = (lugHeight: number): number => Math.max(0.012, lugHeight * 0.62);

/** Resolve a wheel's inner dimensions (see `WheelLayout`). */
export function wheelLayout(o: WheelSize): WheelLayout {
  const radius = o.radius;
  const width = o.width;
  if (!(radius > 0.1) || !(width > 0.1)) throw new Error(`wheelLayout: radius ${radius} / width ${width} is not a wheel`);
  const lugHeight = o.lugHeight ?? Math.min(0.032, Math.max(0.018, radius * 0.06));
  const crownRadius = radius - lugHeight;
  // Part of the spec width is kept for what stands proud of the sidewall
  // (shoulder lugs, lettering), so the wheel still measures the spec width.
  const sideY = width / 2 - sideLug(lugHeight);
  const beadRadius = radius * (o.rimRatio ?? 0.56);
  const beadY = sideY * 0.8;
  const equatorRadius = beadRadius + (crownRadius - beadRadius) * 0.42;
  // The web must stay outboard of the wheel centre plane: the brake disc and
  // caliper live just inboard of it.
  const dish = Math.max(0.03, Math.min(o.dish ?? width * 0.3, beadY - 0.035));
  const floorY = beadY - dish;
  return {
    radius,
    width,
    lugHeight,
    crownRadius,
    sideY,
    equatorRadius,
    beadRadius,
    beadY,
    dish,
    floorY,
    cavityY: floorY - 0.035,
    cavityRadius: beadRadius - 0.03,
  };
}

// ---------------------------------------------------------------------------
// Tire

/**
 * Tread patterns (all directional patterns mirror correctly on the left
 * wheels). All of them cover about three quarters of the crown — fat lugs,
 * narrow grooves — and their shoulder lugs run on down the sidewall:
 *  - 'block'   two staggered rows of big angled blocks + alternately long
 *              and short shoulder lugs — the all-round beach-buggy tire;
 *  - 'chevron' V bars sweeping from the centre down over the shoulder
 *              (tractor / paddle look);
 *  - 'bar'     wide transverse bars reaching past the centre line from
 *              alternate sides, a filler block between them on each shoulder
 *              — the heavy mud-terrain tire;
 *  - 'knobby'  six rows of small square knobs — light front / racing tire.
 */
export type TreadStyle = 'block' | 'chevron' | 'bar' | 'knobby';

/**
 * One raised bar of a tread pattern, as its centre line in TREAD SPACE:
 * `path` points are [around, across] — around in pitch fractions (0…1 = one
 * repeat), across in units of the crown→equator arc (0 = centre line, ±1 =
 * the tire's widest point, beyond = down the sidewall; negative = inboard).
 */
export interface TreadBar {
  /** Half the bar's width, as a fraction of the pitch. */
  halfWidth: number;
  path: Vec2[];
}

/** A tread pattern of your own: `pitch` = length of one repeat round the
 * tire in meters (the count is rounded to fit), `bars` = what one repeat
 * holds. Bars must not overlap each other. */
export interface TreadPattern {
  pitch: number;
  bars: TreadBar[];
}

/** The stock patterns behind `TreadStyle` — copy one and edit it. */
export const TREAD_PATTERNS: Record<TreadStyle, TreadPattern> = {
  block: {
    pitch: 0.17,
    bars: [
      // Crown: two rows leaning into a shallow V, a narrow zigzag groove
      // between them.
      { halfWidth: 0.37, path: [[0.34, -0.52], [0.2, -0.1]] },
      { halfWidth: 0.37, path: [[0.84, 0.52], [0.7, 0.1]] },
      // Shoulders: in the gaps of the crown rows, alternately short and long.
      { halfWidth: 0.36, path: [[0.8, -0.66], [0.84, -1.12]] },
      { halfWidth: 0.36, path: [[0.3, 0.66], [0.34, 1.3]] },
    ],
  },
  chevron: {
    pitch: 0.16,
    bars: [
      { halfWidth: 0.27, path: [[0, -0.05], [0.5, -0.62], [0.56, -0.86], [0.56, -1.12]] },
      { halfWidth: 0.27, path: [[0.5, 0.05], [1.0, 0.62], [1.06, 0.86], [1.06, 1.25]] },
    ],
  },
  bar: {
    pitch: 0.21,
    bars: [
      { halfWidth: 0.2, path: [[0.25, -1.12], [0.25, -0.55], [0.34, 0.2]] },
      { halfWidth: 0.2, path: [[0.75, 1.25], [0.75, 0.55], [0.84, -0.2]] },
      { halfWidth: 0.2, path: [[0.75, -1.05], [0.75, -0.62]] },
      { halfWidth: 0.2, path: [[0.25, 1.05], [0.25, 0.62]] },
    ],
  },
  knobby: {
    pitch: 0.14,
    bars: [
      { halfWidth: 0.35, path: [[0.25, -0.36], [0.25, -0.04]] },
      { halfWidth: 0.35, path: [[0.75, 0.04], [0.75, 0.36]] },
      { halfWidth: 0.35, path: [[0.75, -0.76], [0.75, -0.44]] },
      { halfWidth: 0.35, path: [[0.25, 0.44], [0.25, 0.76]] },
      { halfWidth: 0.33, path: [[0.25, -1.1], [0.25, -0.84]] },
      { halfWidth: 0.33, path: [[0.75, 0.84], [0.75, 1.16]] },
    ],
  },
};

export interface TireOptions extends WheelSize {
  /** Tread pattern: a stock one by name (default 'block') or your own. */
  tread?: TreadStyle | TreadPattern;
  /** Pattern repeats around the tire. Default: one per pitch of
   * circumference — 13 to 20 on these cars. */
  lugs?: number;
  /** Raised lettering-like ribs on the outboard sidewall (default true). */
  lettering?: boolean;
  /** Carcass segments around (default 28 — the lugs, not the carcass, draw
   * the tire's silhouette). */
  segments?: number;
  /** Rubber paint (default `RUBBER`: CAR_COMMON.rubber, gloss 0.2). The
   * carcass between the lugs is drawn a shade darker. */
  rubber?: Paint;
}

/** The outboard half of the tire's cross-section as a dense polyline from
 * the crown centre (arc length 0) over the shoulder to the bead. */
interface Section {
  r: number[];
  y: number[];
  cum: number[];
  /** Arc length crown centre → widest point, → bead. */
  equator: number;
  total: number;
}

function buildSection(L: WheelLayout, protector = true): Section {
  const r: number[] = [];
  const y: number[] = [];
  // Crown and shoulder: a superellipse quarter — nearly flat across the
  // tread, then one big round shoulder. That rounded-square section is what
  // makes the tire read "toy balloon" rather than "road car".
  const n = 3.4;
  const UP = 160;
  for (let i = 0; i <= UP; i++) {
    const t = (i / UP) * (Math.PI / 2);
    y.push(L.sideY * Math.pow(Math.sin(t), 2 / n));
    r.push(L.equatorRadius + (L.crownRadius - L.equatorRadius) * Math.pow(Math.cos(t), 2 / n));
  }
  // Lower sidewall: tucks in from the widest point to the bead, with a raised
  // rim-protector ring just above the rim.
  const LOW = 80;
  const ringFrom = L.beadRadius + 0.01;
  const ringTo = L.beadRadius + 0.034;
  for (let i = 1; i <= LOW; i++) {
    const t = i / LOW;
    const rr = L.equatorRadius - (L.equatorRadius - L.beadRadius) * t;
    let yy = L.beadY + (L.sideY - L.beadY) * (1 - t * t);
    if (protector && rr > ringFrom && rr < ringTo) {
      const u = (rr - ringFrom) / (ringTo - ringFrom);
      yy += 0.007 * Math.min(1, Math.min(u, 1 - u) * 4);
    }
    r.push(rr);
    y.push(yy);
  }
  const cum = [0];
  for (let i = 1; i < r.length; i++) cum.push(cum[i - 1] + Math.hypot(r[i] - r[i - 1], y[i] - y[i - 1]));
  return { r, y, cum, equator: cum[UP], total: cum[cum.length - 1] };
}

/** Point and outward normal of the carcass at signed arc distance `d` from
 * the crown centre (negative = inboard half). Returns [r, y, nr, ny]. */
function surfaceAt(S: Section, d: number): [number, number, number, number] {
  const sign = d < 0 ? -1 : 1;
  const a = Math.min(Math.abs(d), S.total);
  let lo = 0;
  let hi = S.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S.cum[mid] <= a) lo = mid;
    else hi = mid;
  }
  const span = S.cum[hi] - S.cum[lo];
  const k = span > 1e-12 ? (a - S.cum[lo]) / span : 0;
  const dr = S.r[hi] - S.r[lo];
  const dy = S.y[hi] - S.y[lo];
  const len = Math.hypot(dr, dy) || 1;
  // Travelling crown → bead, the outside is on the left: normal = (dy, −dr).
  return [S.r[lo] + dr * k, (S.y[lo] + dy * k) * sign, dy / len, (-dr / len) * sign];
}

/** Douglas–Peucker on a [r, y] polyline: flat stretches lose their points,
 * the shoulder keeps them. */
function simplify(points: Vec2[], tolerance: number): Vec2[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = points[a][0];
    const ay = points[a][1];
    const bx = points[b][0] - ax;
    const by = points[b][1] - ay;
    const len = Math.hypot(bx, by) || 1;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * by - (points[i][1] - ay) * bx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A point of a tread bar's centre line in TREAD SPACE: x = meters around the
 * tire (measured at the crown), z = arc distance across from the crown
 * centre (see `surfaceAt`). */
interface TreadPoint {
  x: number;
  z: number;
}

interface BarShape {
  halfWidth: number;
  /** Lug height above the carcass as a function of z. */
  height: (z: number) => number;
  /** Top-edge chamfer and wall draft, meters. */
  chamfer: number;
  draft: number;
  /** Longest station spacing as a function of z (dense over the shoulder). */
  step: (z: number) => number;
}

/**
 * One raised tread bar: a strip following `path` in tread space, with drafted
 * walls and a chamfered top, wrapped onto the carcass by `map`. Its base is
 * sunk below the carcass surface, so there is never a crack under a lug.
 */
function addTreadBar(m: SolidMesh, map: (x: number, z: number, h: number) => Vector3, path: readonly TreadPoint[], s: BarShape, p: Paint): void {
  // Stations: the path, subdivided where the surface curves.
  const c: TreadPoint[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / s.step((a.z + b.z) / 2)));
    for (let k = 1; k <= n; k++) c.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  const n = c.length - 1;
  // Tangent, side normal and mitre factor per station.
  const tx: number[] = [];
  const tz: number[] = [];
  const mitre: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = c[Math.max(i - 1, 0)];
    const b = c[Math.min(i + 1, n)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    tx.push((b.x - a.x) / l);
    tz.push((b.z - a.z) / l);
    if (i === 0 || i === n) {
      mitre.push(1);
    } else {
      const l0 = Math.hypot(c[i].x - a.x, c[i].z - a.z) || 1;
      const cos = ((c[i].x - a.x) / l0) * tx[i] + ((c[i].z - a.z) / l0) * tz[i];
      mitre.push(Math.min(1.6, 1 / Math.max(cos, 0.3)));
    }
  }
  const levels: { off: number; drop: number; base: boolean }[] = [{ off: s.halfWidth, drop: 0, base: true }];
  if (s.chamfer > 0) levels.push({ off: s.halfWidth - s.draft, drop: s.chamfer, base: false });
  levels.push({ off: Math.max(0.002, s.halfWidth - s.draft - s.chamfer), drop: 0, base: false });

  const SINK = 0.006;
  const loops: Vector3[][] = [];
  for (const lv of levels) {
    const left: Vector3[] = [];
    const right: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      // The two ends retract with the walls, so the end faces are drafted
      // and chamfered like the sides.
      const pull = i === 0 ? s.halfWidth - lv.off : i === n ? -(s.halfWidth - lv.off) : 0;
      const cx = c[i].x + tx[i] * pull;
      const cz = c[i].z + tz[i] * pull;
      const ox = -tz[i] * lv.off * mitre[i];
      const oz = tx[i] * lv.off * mitre[i];
      const at = (x: number, z: number): Vector3 => map(x, z, lv.base ? -SINK : s.height(z) - lv.drop);
      left.push(at(cx + ox, cz + oz));
      right.push(at(cx - ox, cz - oz));
    }
    loops.push([...left, ...right.reverse()]);
  }
  const count = 2 * n + 2;
  // A point inside the bar near loop index j, to aim each wall outward.
  const core = (j: number): Vector3 => {
    let x: number;
    let z: number;
    if (j === n) {
      x = c[n].x - tx[n] * s.halfWidth * 2;
      z = c[n].z - tz[n] * s.halfWidth * 2;
    } else if (j === count - 1) {
      x = c[0].x + tx[0] * s.halfWidth * 2;
      z = c[0].z + tz[0] * s.halfWidth * 2;
    } else {
      const i = j < n ? j : count - 2 - j;
      x = (c[i].x + c[i + 1].x) / 2;
      z = (c[i].z + c[i + 1].z) / 2;
    }
    return map(x, z, s.height(z) * 0.3);
  };
  for (let k = 0; k + 1 < loops.length; k++) {
    const A = loops[k];
    const B = loops[k + 1];
    for (let j = 0; j < count; j++) {
      const j1 = (j + 1) % count;
      const mid = A[j].add(A[j1]).addInPlace(B[j]).addInPlace(B[j1]).scaleInPlace(0.25);
      quadFacing(m, A[j], A[j1], B[j1], B[j], mid.subtractInPlace(core(j)), p);
    }
  }
  const top = loops[loops.length - 1];
  for (let i = 0; i < n; i++) {
    const mx = (c[i].x + c[i + 1].x) / 2;
    const mz = (c[i].z + c[i + 1].z) / 2;
    const out = map(mx, mz, 1).subtractInPlace(map(mx, mz, 0));
    quadFacing(m, top[i], top[i + 1], top[count - 2 - i], top[count - 1 - i], out, p);
  }
}

/** Tire with the axle on +Y — internal; `buildTire` turns it onto X. */
function tireY(m: SolidMesh, o: TireOptions): void {
  const L = wheelLayout(o);
  const S = buildSection(L);
  const rubber = o.rubber ?? RUBBER;
  // Grooves a shade darker than the lugs: the tread reads at a distance
  // without waiting for the AO bake. Lug edges stay crisp (their chamfers
  // are real faces), while a lug that bends over the shoulder shades round.
  const CARCASS = paint(rubber, { color: darken(rubber.color, 0.16) });
  const LUG = paint(rubber, { smooth: 24 });
  const segments = Math.max(16, Math.round(o.segments ?? 28));

  // Carcass: one closed revolve, inboard bead → crown → outboard bead, the
  // bore closing it (hidden inside the rim).
  // The inboard half is never seen close: no protector ring, coarser.
  const plain = buildSection(L, false);
  const inner = simplify(plain.r.map((r, i) => [r, plain.y[i]] as Vec2), 0.008);
  const outer = simplify(S.r.map((r, i) => [r, S.y[i]] as Vec2), 0.003);
  const profile: Vec2[] = [];
  for (let i = inner.length - 1; i > 0; i--) profile.push([inner[i][0], -inner[i][1]]);
  for (const q of outer) profile.push(q);
  revolve(m, { profile, closed: true, segments }, CARCASS);

  // Tread.
  const style = typeof o.tread === 'object' ? o.tread : TREAD_PATTERNS[o.tread ?? 'block'];
  const N = Math.max(8, Math.round(o.lugs ?? (2 * Math.PI * L.radius) / style.pitch));
  const pitch = (2 * Math.PI * L.crownRadius) / N;
  const map = (x: number, z: number, h: number): Vector3 => {
    const [r, y, nr, ny] = surfaceAt(S, z);
    const a = x / L.crownRadius;
    const rr = r + nr * h;
    return new Vector3(rr * Math.cos(a), y + ny * h, rr * Math.sin(a));
  };
  const shoulder = S.equator * 0.55;
  const sideHeight = sideLug(L.lugHeight);
  const lug: Omit<BarShape, 'halfWidth'> = {
    // Full height across the tread, easing over the shoulder to the side
    // height it keeps down the sidewall (which is what holds the tire inside
    // its spec width), then running out into the wall.
    height: (z) => {
      const a = Math.abs(z);
      if (a <= shoulder) return L.lugHeight;
      const t = Math.min(1, (a - shoulder) / (S.equator - shoulder));
      const h = L.lugHeight + (sideHeight - L.lugHeight) * t * t * (3 - 2 * t);
      if (a <= S.equator) return h;
      const out = Math.min(1, (a - S.equator) / (S.equator * 0.34));
      return sideHeight * (1 - 0.55 * out * out);
    },
    chamfer: Math.min(0.007, L.lugHeight * 0.3),
    draft: 0.005,
    step: (z) => (Math.abs(z) < S.equator * 0.5 ? 1 : 0.06),
  };
  for (let k = 0; k < N; k++) {
    for (const bar of style.bars) {
      const path = bar.path.map(([fx, fz]) => ({ x: (k + fx) * pitch, z: fz * S.equator }));
      // The inboard shoulder is only ever seen from under the car: coarser
      // stations and no chamfer there.
      const hidden = bar.path.every(([, fz]) => fz < -0.4);
      addTreadBar(m, map, path, { ...lug, halfWidth: bar.halfWidth * pitch, chamfer: hidden ? 0 : lug.chamfer, draft: hidden ? 0.009 : lug.draft, step: hidden ? (z) => lug.step(z) * 1.8 : lug.step }, LUG);
    }
  }

  // Sidewall "lettering": three groups of raised ticks and a dash on the
  // outboard wall, below the shoulder lugs — reads as moulded branding
  // without spelling anything.
  if (o.lettering ?? true) {
    const band = S.total - S.equator;
    const zc = S.equator + band * 0.62;
    const rib: BarShape = { halfWidth: 0.008, height: () => 0.005, chamfer: 0, draft: 0.0025, step: () => 0.05 };
    const around = 2 * Math.PI * L.crownRadius;
    for (let g = 0; g < 3; g++) {
      const x0 = (g / 3) * around;
      for (let i = 0; i < 4; i++) {
        const x = x0 + i * 0.04;
        addTreadBar(m, map, [{ x, z: zc - band * 0.13 }, { x, z: zc + band * 0.13 }], rib, CARCASS);
      }
      addTreadBar(m, map, [{ x: x0 + 0.21, z: zc }, { x: x0 + 0.21 + around * 0.1, z: zc }], { ...rib, halfWidth: 0.011 }, CARCASS);
    }
  }
}

/**
 * A tire on its own. Wheel convention: around the wheel centre, axle along
 * X, outboard +X. Its bore (radius `wheelLayout().beadRadius`) is closed, so
 * it is a valid solid without a rim.
 */
export function buildTire(o: TireOptions): SolidMesh {
  const m = new SolidMesh();
  tireY(m, o);
  return m.rotate('z', -90);
}

// ---------------------------------------------------------------------------
// Rim

/**
 * Rim centres — all share the coloured outer ring, the deep dish, the centre
 * boss with lug nuts and cap, and a closed inboard side with the brake
 * cavity:
 *  - 'spoke'    thick tapered spokes (5 by default; set `spokes`);
 *  - 'split'    pairs of flat blades (5 pairs by default) — light racing rim;
 *  - 'beadlock' wide ring with a circle of bolts, solid disc with round
 *               windows — the heavy truck rim;
 *  - 'turbine'  swept vanes on a disc (9 by default) — aero / fan look.
 */
export type RimStyle = 'spoke' | 'split' | 'beadlock' | 'turbine';

export interface RimOptions extends WheelSize {
  /** Centre design (default 'spoke'). */
  rim?: RimStyle;
  /** Spoke / spoke-pair / window / vane count (default 5 / 5 / 6 / 9). */
  spokes?: number;
  /** Colour of the outer ring — the car's wheel accent. Glossy toy plastic. */
  ring?: Color;
  /** Colour of the barrel: the wall from the ring down to the dish floor
   * (default: the ring colour, as on the design sheets — a deep coloured
   * bowl; pass a dark colour for a thin ring over a black barrel). */
  barrel?: Color;
  /** Colour of spokes and centre boss (default mid-grey cast metal — light
   * enough to stand off the dark dish floor behind it). */
  centre?: Color;
  /** Colour of the dish floor behind the spokes (default near-black). */
  floor?: Color;
  /** Colour of the centre cap (default: the ring colour). */
  cap?: Color;
  /** Width of the coloured ring face as a fraction of the rim radius
   * (default 0.26; 'beadlock' 0.3). */
  ringWidth?: number;
  /** Segments around the visible outboard side (default 36). */
  segments?: number;
}

function rimY(m: SolidMesh, o: RimOptions): void {
  const L = wheelLayout(o);
  const style = o.rim ?? 'spoke';
  const seg = Math.max(12, Math.round(o.segments ?? 36));
  const RING = asPaint(o.ring, paint('#FF6373', { gloss: 0.85, smooth: 50 }), { gloss: 0.85, smooth: 50 });
  const BARREL = asPaint(o.barrel, RING, { gloss: 0.8, smooth: 50 });
  const CENTRE = asPaint(o.centre, paint('#666874', { gloss: 0.6, metal: 0.7 }), { gloss: 0.6, metal: 0.7 });
  const FLOOR = asPaint(o.floor, paint('#26262D', { gloss: 0.35 }), { gloss: 0.35 });
  const CAP = asPaint(o.cap, RING, { gloss: 0.85 });
  const rb = L.beadRadius;
  const yb = L.beadY;
  const ringW = rb * (o.ringWidth ?? (style === 'beadlock' ? 0.3 : 0.26));
  const rIn = rb - ringW;
  // Barrel: tapers in toward the floor.
  const rD = rIn - 0.004 - L.dish * 0.1;
  const yF = L.floorY;

  // Outer ring + barrel. The lip overlaps the tire's bead, so tire and rim
  // sink into each other instead of meeting on one circle. Both edges of the
  // ring face are real quarter-rounds (two bands each), so the soft toy
  // lip is geometry and the smooth shading across it is honest.
  const e = Math.min(0.012, ringW * 0.22);
  const face = yb + 0.016;
  const arc = (cr: number, cy: number, from: number, to: number): Vec2[] =>
    [0, 1, 2].map((k) => {
      const a = ((from + ((to - from) * k) / 2) * Math.PI) / 180;
      return [cr + Math.cos(a) * e, cy + Math.sin(a) * e] as Vec2;
    });
  revolve(
    m,
    {
      profile: [
        [rb + 0.014, yb - 0.025],
        ...arc(rb + 0.014 - e, face - e, 0, 90),
        ...arc(rIn + e, face - e, 90, 180),
        [rD, yF - 0.008],
      ],
      segments: seg,
    },
    (band) => (band >= 6 ? BARREL : RING),
  );
  // Dish floor.
  const rh = Math.max(0.045, rD * 0.3);
  revolve(m, { profile: [[rD + 0.008, yF], [rh - 0.01, yF]], segments: 24 }, FLOOR);

  // Inboard side, coarser: a rolled lip over the tire's inboard bead, the
  // cavity the brake sits in, and the centre boss the hub's bearing carrier
  // runs into.
  const rc = L.cavityRadius;
  const boss = Math.min(WHEEL_BOSS_RADIUS, rc * 0.5);
  revolve(
    m,
    {
      profile: [
        [0, WHEEL_BOSS_END],
        [boss, WHEEL_BOSS_END],
        [boss, L.cavityY],
        [rc, L.cavityY],
        [rc + 0.006, -yb - 0.004],
        [rc + 0.014, -yb - 0.016],
        [rb + 0.006, -yb - 0.016],
        [rb + 0.016, -yb - 0.006],
        [rb + 0.016, -yb + 0.024],
      ],
      segments: Math.max(12, Math.round(seg * 0.45)),
    },
    (band) => (band >= 4 ? BARREL : FLOOR),
  );

  const hubRise = Math.min(L.dish * 0.55, 0.06);
  const yHub = yF + hubRise;
  const n = Math.max(3, Math.round(o.spokes ?? (style === 'turbine' ? 9 : style === 'beadlock' ? 6 : 5)));
  // How far the spokes stand off the floor where they meet the barrel.
  const relief = Math.max(0.03, hubRise * 0.62);

  /** A straight spoke along +X from the boss to the barrel, as a loft of
   * rounded rectangles; then turned to `deg` about the axle. */
  const spoke = (deg: number, w0: number, w1: number, skew = 0): void => {
    const s = m.mark();
    const stations: [number, number, number][] = [
      [rh * 0.6, w0, yHub - 0.004],
      [rh + (rD - rh) * 0.35, w0 + (w1 - w0) * 0.45, yF + relief + (hubRise - relief) * 0.55],
      [rD + 0.004, w1, yF + relief],
    ];
    const bottom = yF - 0.01;
    loft(
      m,
      {
        rings: stations.map(([rho, w, top], i) => {
          const h = top - bottom;
          const ring = roundedRectRing(w, h, Math.min(0.012, w * 0.3, h * 0.3), 1);
          return ring.map(([a, b]) => new Vector3(rho, bottom + h / 2 + b, a + skew * i));
        }),
        subdivisions: 1,
      },
      CENTRE,
    );
    m.rotate('y', deg, s);
  };

  if (style === 'spoke') {
    const w0 = 2 * rh * Math.sin(Math.PI / n) * 0.86;
    for (let k = 0; k < n; k++) spoke((k * 360) / n + 90, w0, w0 * 0.8);
  } else if (style === 'split') {
    // Pairs of flat blades, each as wide as a finger — not wire.
    const w = Math.max(0.03, rD * 0.17);
    const open = 360 / n / 4.6;
    for (let k = 0; k < n; k++) {
      const a = (k * 360) / n + 90;
      spoke(a - open, w, w * 0.92, rD * 0.03);
      spoke(a + open, w, w * 0.92, -rD * 0.03);
    }
  } else if (style === 'turbine') {
    // Swept vanes standing on a raised disc, so there is a face to read
    // even where the vanes leave gaps.
    cylinder(m, { from: [0, yF - 0.004, 0], to: [0, yF + relief * 0.4, 0], radius: rD + 0.004, sides: 28, caps: 'top' }, FLOOR);
    const sweepDeg = 38;
    const bw = Math.max(0.03, rD * 0.15);
    const hi = relief * 0.6 + 0.012;
    for (let k = 0; k < n; k++) {
      const path: Vector3[] = [];
      const STEPS = 5;
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const rho = rh * 0.8 + (rD + 0.002 - rh * 0.8) * t;
        const a = ((k * 360) / n + sweepDeg * t * t) * (Math.PI / 180);
        path.push(new Vector3(rho * Math.cos(a), yF + relief * 0.4 + (hubRise - relief * 0.4) * (1 - t) * 0.5, rho * Math.sin(a)));
      }
      // Section: x = along the axle (up), y = across the vane; chamfered top.
      sweep(m, { path, section: [[-0.02, -bw / 2], [hi * 0.6, -bw / 2], [hi, -bw / 4], [hi, bw / 4], [hi * 0.6, bw / 2], [-0.02, bw / 2]], up: [0, 1, 0], caps: false }, CENTRE);
    }
  } else {
    // Beadlock: a solid plate with round windows, and bolts round the ring.
    const plate = 0.024;
    extrudePolygon(
      m,
      {
        outline: circleRing(rD + 0.004, 28),
        holes: Array.from({ length: n }, (_, k) => {
          const a = ((k + 0.5) / n) * Math.PI * 2;
          const rr = (rh + rD) * 0.53;
          return circleRing(Math.min((rD - rh) * 0.32, rr * Math.sin(Math.PI / n) * 0.72), 18).map(([x, y]) => [x + rr * Math.cos(a), y + rr * Math.sin(a)] as Vec2);
        }),
        depth: plate,
        bevel: 0.005,
        back: false,
        facing: '+y',
        at: [0, yF + relief * 0.3, 0],
      },
      CENTRE,
    );
    // The plate stands off the floor: close the gap round its edge.
    cylinder(m, { from: [0, yF - 0.004, 0], to: [0, yF + relief * 0.3 + 0.002, 0], radius: rD + 0.002, sides: 28, caps: false }, FLOOR);
    const bolts = Math.max(8, Math.round((2 * Math.PI * rb) / 0.11));
    for (let k = 0; k < bolts; k++) {
      const a = ((k + 0.5) / bolts) * Math.PI * 2;
      const rr = rb - ringW * 0.5;
      cylinder(m, { radius: Math.min(0.012, ringW * 0.2), height: 0.014, sides: 6, round: false, caps: 'top', at: [rr * Math.cos(a), face + 0.004, rr * Math.sin(a)] }, STEEL);
    }
  }

  // Centre boss, lug nuts, cap.
  cylinder(m, { from: [0, yF - 0.006, 0], to: [0, yHub, 0], radius: rh, sides: Math.max(16, seg / 2), bevel: { top: Math.min(0.012, rh * 0.25) }, caps: 'top' }, CENTRE);
  const nuts = 5;
  for (let k = 0; k < nuts; k++) {
    const a = ((k + 0.5) / nuts) * Math.PI * 2;
    cylinder(m, { radius: Math.min(0.012, rh * 0.18), height: 0.016, sides: 6, round: false, bevel: 0.0025, bevelSegments: 1, caps: 'top', at: [rh * 0.64 * Math.cos(a), yHub + 0.006, rh * 0.64 * Math.sin(a)] }, STEEL);
  }
  sphere(m, { radii: [rh * 0.36, rh * 0.26, rh * 0.36], segments: 14, latitude: [0, 90], caps: false, at: [0, yHub - 0.001, 0] }, CAP);

  // Valve stem on the ring — the one asymmetric detail, so spin is visible.
  cylinder(m, { from: [rIn + ringW * 0.4, face - 0.008, 0], to: [rIn + ringW * 0.3, face + 0.022, 0], radius: 0.0055, sides: 6, caps: 'top' }, CHARCOAL);
}

/** A rim on its own (wheel convention: axle along X, outboard +X). */
export function buildRim(o: RimOptions): SolidMesh {
  const m = new SolidMesh();
  rimY(m, o);
  return m.rotate('z', -90);
}

// ---------------------------------------------------------------------------
// Wheel

export interface WheelOptions extends TireOptions, RimOptions {}

/**
 * Tire + rim as ONE mesh in the wheel convention of `CarGeometry.wheelFront`
 * / `wheelRear`: around the wheel centre, axle along X, the detailed outboard
 * face on +X. Build one per axle; the assembler mirrors it for the left.
 *   wheelRear: buildWheel({ radius: spec.rearTireRadius, width: spec.rearTireWidth,
 *                           tread: 'block', rim: 'spoke', ring: REEF_ROCKET.cageCoral })
 * About 3.2–3.9k triangles depending on size, tread and rim style.
 */
export function buildWheel(o: WheelOptions): SolidMesh {
  const m = new SolidMesh();
  tireY(m, o);
  rimY(m, o);
  return m.rotate('z', -90);
}
