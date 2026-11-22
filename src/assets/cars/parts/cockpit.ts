import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, compose, cylinder, loft, paint, paintDecal, rotation, roundedBox, roundedRectRing, sphere, sweep, torus, translation, tube } from '../../../gfx/solid';
import type { Vec2 } from '../../../gfx/solid';
import { CHARCOAL, CHROME, FABRIC, GUNMETAL, RUBBER, STEEL, asPaint } from './common';
import type { Color, P3 } from './common';

/**
 * COCKPIT — bucket seat with harness, steering wheel and column, dashboard,
 * pedals, floor pan. The `add…` helpers append to the car's BODY mesh in
 * model space (+x right, +y up, +z nose); `buildSteeringWheel` returns the
 * separate, turning part for `CarGeometry.steeringWheel`.
 *
 * Everything is positioned from two points the car modeller chooses:
 *   SEAT  — the hip point: centre of the seat cushion's top surface, where
 *           the driver sits (`addSeat({ at })`, `buildDriver({ seat })`);
 *   WHEEL — the steering wheel's pivot, with the column axis pointing up the
 *           column TOWARD the driver.
 * A comfortable toy layout: wheel pivot 0.38–0.50 m ahead of the hip point
 * and 0.28–0.38 m above it, column axis about [0, 0.3, −0.95]; pedals
 * 0.55–0.72 m ahead of the hip point on the floor. `buildDriver` throws if
 * its limbs cannot reach what you chose.
 */

// ---------------------------------------------------------------------------
// Seat

export interface SeatOptions {
  /** Hip point: centre of the cushion's top surface, model space. */
  at: P3;
  /** Width of the base (default 0.5). The shoulder wings stand 4–5 cm wider
   * each side, so the driver's shoulders sit between them. */
  width?: number;
  /** Height of the back above the cushion (default 0.62: its top reaches the
   * driver's neck, so most of the helmet shows above it from behind — the
   * chase camera's view. 0.8 = a full-height racing seat that hides it). */
  backHeight?: number;
  /** Backward lean of the back, degrees (default 12). Give the driver the
   * same value. */
  recline?: number;
  /** Hard outer shell (default charcoal). */
  shell?: Color;
  /** Cushions (default matte black fabric). */
  cushion?: Color;
  /** Centre inserts, the panel on the back of the shell, the harness — the
   * seat's colour accent. */
  accent?: Color;
  /** 4-point harness lying on the seat: strap colour, or false for none. It
   * stays under a driver (who wears their own straps, see `buildDriver`) and
   * shows when the car is parked empty. Default: the accent colour. */
  harness?: Color | false;
}

/** The seat back's cross-section at each height, as fractions of the back
 * height: half-width, how far the sides wrap forward, shell thickness on the
 * centre line. Hip flare, waist, shoulder wings, neck. */
const BACK_STATIONS: [number, number, number, number][] = [
  [0.0, 0.2, 0.07, 0.07],
  [0.2, 0.238, 0.1, 0.085],
  [0.42, 0.208, 0.07, 0.09],
  [0.68, 0.295, 0.11, 0.085],
  [0.84, 0.262, 0.08, 0.07],
  [0.94, 0.18, 0.035, 0.055],
  [1.0, 0.14, 0.015, 0.045],
];

/** Where the back's cushion face sits ahead of the back's own origin. */
const BACK_FACE = 0.118;

/** One cross-section of the seat back, seen from above: a crescent — convex
 * shell behind, concave cushion in front, the two wings wrapping forward. */
function backRing(y: number, W: number, D: number, T: number, e: number): Vector3[] {
  const n = 8;
  const out: Vector3[] = [];
  for (let j = 0; j <= n; j++) {
    const a = -Math.PI / 2 + (Math.PI * j) / n;
    out.push(new Vector3(W * Math.sin(a), y, BACK_FACE + D - (D + T) * Math.pow(Math.cos(a), 0.6)));
  }
  out.push(new Vector3(W - e * 0.5, y, BACK_FACE + D + e * 0.4));
  for (let j = n; j >= 0; j--) {
    const a = -Math.PI / 2 + (Math.PI * j) / n;
    out.push(new Vector3((W - e) * Math.sin(a), y, BACK_FACE + D * (1 - Math.pow(Math.cos(a), 0.5))));
  }
  out.push(new Vector3(-(W - e * 0.5), y, BACK_FACE + D + e * 0.4));
  return out;
}

/**
 * Bucket seat: a wrap-around shell with hip bolsters, shoulder wings and a
 * neck-high back, two-colour cushions, a ribbed accent panel on the back of
 * the shell (the side the chase camera sees) and a 4-point harness, appended
 * to `m` with its hip point at `at`. Faces +z. About 1.5k triangles.
 */
export function addSeat(m: SolidMesh, o: SeatOptions): void {
  const w = o.width ?? 0.5;
  const H = o.backHeight ?? 0.62;
  const recline = o.recline ?? 12;
  const SHELL = asPaint(o.shell, CHARCOAL, { gloss: 0.5 });
  const CUSHION = asPaint(o.cushion, FABRIC, { gloss: 0.12 });
  const ACCENT = asPaint(o.accent, paint('#FF6373', { gloss: 0.2 }), { gloss: 0.2 });
  const SLOT = paint('#1B1B20', { gloss: 0.15 });
  const k = w / 0.5;
  const s = new SolidMesh();

  // Base: shell, cushion and the two hip bolsters, nose tipped up 5°.
  roundedBox(s, { size: [w, 0.13, 0.48], radius: 0.045, segments: 1, rot: [-5, 0, 0], at: [0, -0.075, 0.12] }, SHELL);
  roundedBox(s, { size: [w - 0.16, 0.07, 0.42], radius: 0.03, segments: 1, rot: [-5, 0, 0], at: [0, -0.03, 0.13] }, CUSHION);
  roundedBox(s, { size: [w * 0.17, 0.07, 0.34], radius: 0.03, segments: 1, rot: [-5, 0, 0], at: [0, -0.024, 0.15] }, ACCENT);
  for (const side of [-1, 1]) {
    roundedBox(s, { size: [0.085, 0.16, 0.44], radius: 0.04, segments: 2, rot: [-5, 0, 0], at: [side * (w / 2 - 0.04), 0.0, 0.12] }, SHELL);
  }

  // Back: ONE lofted shell, built upright facing +z with its base on the
  // local origin, then reclined and set behind the hip point.
  const b = new SolidMesh();
  const edge = 0.046 * k;
  const rings = BACK_STATIONS.map(([f, W, D, T]) => backRing(f * H, W * k, D * k, T * k, edge));
  // A last, smaller ring rounds the top off instead of ending on a flat cut.
  const [, Wt, Dt, Tt] = BACK_STATIONS[BACK_STATIONS.length - 1];
  rings.push(backRing(H + 0.022, Wt * k * 0.72, Dt * k * 0.6, Tt * k * 0.6, edge * 0.7));
  loft(b, { rings, subdivisions: 2, caps: true }, SHELL);
  // Everything that faces the driver is cushion.
  b.repaint((_c, n) => (n.z > 0.55 ? CUSHION : undefined));
  // Centre insert — narrow, so the shoulder straps lie on dark cushion
  // either side of it — and the two slots the straps come through.
  paintDecal(b, { outline: roundedRectRing(w * 0.17, H * 0.62, 0.03, 3), facing: '+z', at: [0, H * 0.43, 0], only: (_c, n) => n.z > 0.3 }, ACCENT);
  for (const side of [-1, 1]) {
    paintDecal(b, { outline: roundedRectRing(0.07, 0.03, 0.012, 2), facing: '+z', at: [side * w * 0.15, H * 0.84, 0], only: (_c, n) => n.z > 0.3 }, SLOT);
  }
  // The back of the shell: an accent panel between two raised ribs.
  paintDecal(b, { outline: [[-0.1 * k, H * 0.2], [0.1 * k, H * 0.2], [0.135 * k, H * 0.62], [0.1 * k, H * 0.84], [-0.1 * k, H * 0.84], [-0.135 * k, H * 0.62]], facing: '-z', only: (_c, n) => n.z < -0.3 }, ACCENT);
  const shellAt = (x: number, f: number): P3 => {
    // The rear surface where the stations put it (linear between stations —
    // the ribs are sunk deep enough to absorb the loft's rounding).
    let i = 0;
    while (i + 2 < BACK_STATIONS.length && BACK_STATIONS[i + 1][0] < f) i++;
    const [f0, W0, D0, T0] = BACK_STATIONS[i];
    const [f1, W1, D1, T1] = BACK_STATIONS[i + 1];
    const t = Math.min(1, Math.max(0, (f - f0) / (f1 - f0)));
    const W = (W0 + (W1 - W0) * t) * k;
    const D = (D0 + (D1 - D0) * t) * k;
    const T = (T0 + (T1 - T0) * t) * k;
    const c = Math.sqrt(Math.max(0, 1 - (x / W) * (x / W)));
    return [x, f * H, BACK_FACE + D - (D + T) * Math.pow(c, 0.6) + 0.004];
  };
  for (const side of [-1, 1]) {
    tube(b, { path: [0.14, 0.3, 0.5, 0.68, 0.86].map((f) => shellAt(side * (0.15 + (f > 0.6 ? 0.03 : 0) - (f > 0.8 ? 0.05 : 0)) * k, f)), radius: 0.016, sides: 6, fillet: 0.05, caps: 'round' }, SHELL);
  }
  const place = compose(rotation('x', -recline), translation(0, -0.04, -0.235));
  s.append(b, place);

  if (o.harness !== false) {
    const STRAP = asPaint(o.harness, ACCENT, { gloss: 0.25 });
    // Flat webbing: x = thickness (along `up`), y = width.
    const strap: Vec2[] = [[-0.006, -0.025], [0.006, -0.025], [0.006, 0.025], [-0.006, 0.025]];
    // A point `z` in front of the reclined back's cushion face, in seat
    // coordinates.
    const onBack = (x: number, y: number, z = 0.01): P3 => {
      const a = (-recline * Math.PI) / 180;
      const zz = BACK_FACE + z;
      return [x, y * Math.cos(a) - zz * Math.sin(a) - 0.04, y * Math.sin(a) + zz * Math.cos(a) - 0.235];
    };
    for (const side of [-1, 1]) {
      // Shoulder strap: out of its slot, down the back, to the buckle.
      sweep(s, { path: [onBack(side * w * 0.15, H * 0.84, -0.01), onBack(side * w * 0.15, H * 0.74), onBack(side * w * 0.13, H * 0.2), [side * 0.03, 0.03, 0.02]], section: strap, fillet: 0.04, filletSegments: 1, up: [0, 0, 1], caps: false }, STRAP);
      roundedBox(s, { size: [0.064, 0.036, 0.024], radius: 0.006, segments: 1, at: onBack(side * w * 0.142, H * 0.5, 0.016), rot: [-recline, 0, 0] }, STEEL);
      // Lap strap from the hip bolster.
      sweep(s, { path: [[side * (w / 2 - 0.075), 0.0, -0.03], [side * (w / 2 - 0.15), 0.03, 0.0], [side * 0.03, 0.03, 0.03]], section: strap, fillet: 0.03, filletSegments: 1, up: [0, 1, 0], caps: false }, STRAP);
    }
    // Rotary buckle with its red release.
    cylinder(s, { from: [0, 0.012, 0.03], to: [0, 0.046, 0.022], radius: 0.042, sides: 12, bevel: { top: 0.006 }, bevelSegments: 1 }, STEEL);
    cylinder(s, { from: [0, 0.04, 0.023], to: [0, 0.053, 0.02], radius: 0.02, sides: 10, caps: 'top' }, paint('#E23A30', { gloss: 0.7 }));
  }
  m.append(s, o.at);
}

// ---------------------------------------------------------------------------
// Steering wheel and column

export interface SteeringWheelOptions {
  /** Rim centre-line radius (default 0.16). Give the driver the same. */
  radius?: number;
  /** Rim colour (default charcoal rubber). */
  rim?: Color;
  /** Spoke colour (default brushed steel). */
  spokes?: Color;
  /** 12 o'clock band and horn button — makes the steering angle readable. */
  accent?: Color;
}

/**
 * The steering wheel as its own turning part, authored the way
 * `CarGeometry.steeringWheel` wants it: rim in the local XY plane around the
 * origin, local +Y = top of the wheel, local +Z = up the column toward the
 * driver (the dished hub sits at −Z). The RIM IS A PLAIN TORUS on purpose:
 * the driver's fists are closed around it and stay put while it turns, which
 * only works for a body of revolution — so no thumb grips or flat bottom.
 * About 700 triangles.
 */
export function buildSteeringWheel(o: SteeringWheelOptions = {}): SolidMesh {
  const R = o.radius ?? 0.16;
  const RIM = asPaint(o.rim, paint(CHARCOAL, { gloss: 0.3 }), { gloss: 0.3 });
  const SPOKE = asPaint(o.spokes, STEEL, { gloss: 0.7, metal: 1 });
  const ACCENT = asPaint(o.accent, paint('#FF6373', { gloss: 0.7 }), { gloss: 0.7 });
  const m = new SolidMesh();
  const t = 0.02;
  torus(m, { radius: R, tube: t, segments: 32, sides: 7, rot: [90, 0, 0] }, RIM);
  // 12 o'clock band: a slightly fatter slice of the same torus. (After the
  // rot, torus angle 270° is the top of the wheel.)
  torus(m, { radius: R, tube: t + 0.0025, segments: 3, sides: 7, arc: 16, arcStart: 262, rot: [90, 0, 0] }, ACCENT);
  // Dished hub and three flat spokes at 9, 3 and 6 o'clock.
  const hubZ = -0.045;
  cylinder(m, { from: [0, 0, hubZ - 0.02], to: [0, 0, hubZ + 0.018], radius: 0.05, sides: 14, bevel: { top: 0.008 }, bevelSegments: 1 }, SPOKE);
  sphere(m, { radii: [0.03, 0.012, 0.03], segments: 12, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [0, 0, hubZ + 0.017] }, ACCENT);
  const section: Vec2[] = [[-0.0045, -0.017], [0.0045, -0.017], [0.0045, 0.017], [-0.0045, 0.017]];
  for (const deg of [0, 180, 270]) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    sweep(m, { path: [[c * 0.03, sn * 0.03, hubZ + 0.004], [c * R * 0.55, sn * R * 0.55, hubZ * 0.45], [c * (R - 0.004), sn * (R - 0.004), 0]], section, up: [0, 0, 1], caps: false }, SPOKE);
  }
  return m;
}

export interface ColumnOptions {
  /** Where the column leaves the dashboard / bulkhead. */
  from: P3;
  /** The steering wheel's pivot. */
  to: P3;
  /** Column tube radius (default 0.024). */
  radius?: number;
  /** Indicator-style stalk on the column (default true). */
  stalk?: boolean;
}

/**
 * Steering column from the dashboard to the wheel pivot, appended to the body
 * mesh `m`: tube, a rubber gaiter at the dash end and a stalk. It ends inside
 * the wheel's hub, so the joint is hidden at any steering angle.
 *   const axis = columnAxis(COLUMN_FROM, WHEEL_PIVOT);   // for CarGeometry.steeringWheel
 */
export function addSteeringColumn(m: SolidMesh, o: ColumnOptions): void {
  const r = o.radius ?? 0.024;
  const a = columnAxis(o.from, o.to);
  const len = Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1], o.to[2] - o.from[2]);
  const at = (d: number): P3 => [o.from[0] + a[0] * d, o.from[1] + a[1] * d, o.from[2] + a[2] * d];
  cylinder(m, { from: at(-0.03), to: at(len - 0.05), radius: r, sides: 10 }, GUNMETAL);
  cylinder(m, { from: at(len - 0.11), to: at(len - 0.055), radius: r + 0.012, sides: 10, bevel: 0.006, bevelSegments: 1 }, STEEL);
  // Gaiter: three shrinking rubber rings where the column meets the dash.
  for (let i = 0; i < 3; i++) {
    cylinder(m, { from: at(i * 0.03 - 0.01), to: at(i * 0.03 + 0.022), radius: r + 0.03 - i * 0.008, sides: 8, bevel: { top: 0.007 }, bevelSegments: 1, caps: 'top' }, RUBBER);
  }
  if (o.stalk ?? true) {
    const p = at(len - 0.085);
    tube(m, { path: [p, [p[0] + 0.11, p[1] + 0.012, p[2]]], radius: [0.009, 0.007], sides: 6, caps: 'round' }, CHARCOAL);
  }
}

/** Unit direction from the dashboard end of the column to the wheel pivot —
 * the `axis` of `CarGeometry.steeringWheel`. */
export function columnAxis(from: P3, to: P3): P3 {
  const d: P3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

// ---------------------------------------------------------------------------
// Dashboard

export interface DashboardOptions {
  /** Centre of the instrument face, model space. */
  at: P3;
  /** Size of the binnacle: width, height of the face, depth forward
   * (default 0.62 × 0.2 × 0.16). */
  width?: number;
  height?: number;
  depth?: number;
  /** How far the face leans back toward the driver's eyes, degrees (default 20). */
  tilt?: number;
  /** Binnacle colour (default charcoal). */
  panel?: Color;
  /** Instrument face plate (default dark grey). */
  face?: Color;
  /** Needle, start button — the dash's accent. */
  accent?: Color;
  /** Number of round gauges, 1–3 (default 2). */
  gauges?: number;
}

/**
 * A simple instrument binnacle facing the driver (−z): round gauges with
 * bezels and needles, three toggle switches, a start button and two warning
 * lamps. Appended to `m`. About 850 triangles with two gauges.
 */
export function addDashboard(m: SolidMesh, o: DashboardOptions): void {
  const W = o.width ?? 0.62;
  const H = o.height ?? 0.2;
  const D = o.depth ?? 0.16;
  const PANEL = asPaint(o.panel, CHARCOAL, { gloss: 0.45 });
  const FACE = asPaint(o.face, paint('#2A2B32', { gloss: 0.25 }), { gloss: 0.25 });
  const ACCENT = asPaint(o.accent, paint('#FF5A3C', { gloss: 0.7 }), { gloss: 0.7 });
  const DIAL = paint('#F1E7CF', { gloss: 0.35 });
  const s = new SolidMesh();
  // Local frame: the face is the plane z = 0 looking toward −z.
  roundedBox(s, { min: [-W / 2, -H / 2, 0], max: [W / 2, H / 2, D], radius: Math.min(0.045, H * 0.3), segments: 2 }, PANEL);
  roundedBox(s, { size: [W - 0.05, H - 0.05, 0.02], radius: 0.012, segments: 1, at: [0, 0, -0.002] }, FACE);
  const n = Math.max(1, Math.min(3, Math.round(o.gauges ?? 2)));
  const gr = Math.min(H * 0.33, (W * 0.5) / (n + 1) - 0.01);
  // Gauges sit left of centre, the switch bank to their right.
  const span = W * 0.56;
  for (let k = 0; k < n; k++) {
    const x = -W * 0.2 + (n === 1 ? 0 : (k / (n - 1) - 0.5) * (span - 2 * gr - 0.02));
    cylinder(s, { from: [x, 0, 0.005], to: [x, 0, -0.016], radius: gr, sides: 20, caps: 'top' }, DIAL);
    torus(s, { radius: gr, tube: 0.009, segments: 20, sides: 4, rot: [90, 0, 0], at: [x, 0, -0.016] }, CHROME);
    // Eight raised ticks round the dial, from 7 to 5 o'clock.
    for (let i = 0; i < 8; i++) {
      const ts = s.mark();
      box(s, { min: [-0.0035, gr * 0.62, -0.0195], max: [0.0035, gr * 0.86, -0.0155] }, CHARCOAL);
      s.rotate('z', 126 - i * 36, ts);
      s.translate([x, 0, 0], ts);
    }
    const ns = s.mark();
    box(s, { min: [-0.004, -gr * 0.15, -0.0225], max: [0.004, gr * 0.74, -0.0175] }, ACCENT);
    s.rotate('z', 40 - k * 75, ns);
    s.translate([x, 0, 0], ns);
    cylinder(s, { from: [x, 0, -0.016], to: [x, 0, -0.025], radius: gr * 0.16, sides: 8, caps: 'top' }, CHARCOAL);
  }
  const x0 = W * 0.2;
  for (let k = 0; k < 3; k++) {
    const x = x0 + k * 0.045;
    cylinder(s, { from: [x, -H * 0.16, 0], to: [x, -H * 0.16, -0.014], radius: 0.011, sides: 8, caps: 'top' }, STEEL);
    tube(s, { path: [[x, -H * 0.16, -0.012], [x, -H * 0.16 + (k === 1 ? -0.014 : 0.014), -0.04]], radius: [0.005, 0.0065], sides: 6, caps: 'round' }, CHROME);
  }
  cylinder(s, { from: [x0 + 0.045, H * 0.2, 0], to: [x0 + 0.045, H * 0.2, -0.018], radius: 0.02, sides: 12, bevel: { top: 0.005 }, bevelSegments: 1, caps: 'top' }, ACCENT);
  sphere(s, { radius: 0.011, segments: 8, rings: 4, at: [x0 - 0.01, H * 0.2, -0.008] }, paint('#9DFF6A', { emissive: 0.7 }));
  sphere(s, { radius: 0.011, segments: 8, rings: 4, at: [x0 + 0.1, H * 0.2, -0.008] }, paint('#FFB52E', { emissive: 0.7 }));
  s.rotate('x', o.tilt ?? 20);
  m.append(s, o.at);
}

// ---------------------------------------------------------------------------
// Pedals and floor

export interface PedalOptions {
  /** Floor point midway between the pedals, model space. */
  at: P3;
  /** 2 (default: brake + throttle) or 3 pedals. */
  count?: 2 | 3;
  /** Pad colour (default steel). */
  pad?: Color;
}

/** Floor-hinged pedals with ribbed pads tilted toward the driver (who sits at
 * −z of them), appended to `m`. About 130 triangles each. */
export function addPedals(m: SolidMesh, o: PedalOptions): void {
  const PAD = asPaint(o.pad, STEEL, { gloss: 0.7, metal: 1 });
  const n = o.count ?? 2;
  const s = new SolidMesh();
  for (let k = 0; k < n; k++) {
    const x = (k - (n - 1) / 2) * (n === 2 ? 0.21 : 0.14);
    // The right-most pedal is the throttle: tall and narrow.
    const throttle = k === n - 1;
    const w = throttle ? 0.075 : 0.11;
    const h = throttle ? 0.17 : 0.14;
    tube(s, { path: [[x, -0.01, 0.03], [x, 0.11, -0.02]], radius: 0.01, sides: 6 }, GUNMETAL);
    const ps = s.mark();
    roundedBox(s, { size: [w, h, 0.02], radius: 0.008, segments: 1 }, PAD);
    for (let i = 0; i < 3; i++) box(s, { size: [w - 0.014, 0.01, 0.008], at: [0, (i - 1) * h * 0.28, -0.012] }, RUBBER);
    s.rotate('x', 28, ps);
    s.translate([x, 0.13 + (throttle ? 0.02 : 0), -0.03], ps);
  }
  const half = ((n - 1) / 2) * (n === 2 ? 0.21 : 0.14) + 0.07;
  cylinder(s, { from: [-half, 0, 0.03], to: [half, 0, 0.03], radius: 0.012, sides: 6 }, STEEL);
  m.append(s, o.at);
}

export interface FloorPanOptions {
  /** Plan extent: [x, z] corners, model space. */
  min: [number, number];
  max: [number, number];
  /** Height of the UNDERSIDE — the car's ground clearance. */
  y: number;
  /** Plate thickness (default 0.03). */
  thickness?: number;
  /** Raised fore-aft ribs on top (default 4; 0 = plain). */
  ribs?: number;
  color?: Color;
}

/**
 * Floor pan: a plate whose underside is exactly at `y` (make that the spec's
 * ground clearance and the lab's clearance row passes), with pressed ribs on
 * top. Appended to `m`.
 */
export function addFloorPan(m: SolidMesh, o: FloorPanOptions): void {
  const P = asPaint(o.color, GUNMETAL, { gloss: 0.4 });
  const t = o.thickness ?? 0.03;
  roundedBox(m, { min: [o.min[0], o.y, o.min[1]], max: [o.max[0], o.y + t, o.max[1]], radius: Math.min(0.012, t * 0.45), segments: 1 }, P);
  const n = Math.max(0, Math.round(o.ribs ?? 4));
  const w = o.max[0] - o.min[0];
  for (let k = 0; k < n; k++) {
    const x = o.min[0] + ((k + 0.5) / n) * w;
    roundedBox(m, { min: [x - 0.028, o.y + t - 0.004, o.min[1] + 0.05], max: [x + 0.028, o.y + t + 0.01, o.max[1] - 0.05], radius: 0.006, segments: 1 }, P);
  }
}
