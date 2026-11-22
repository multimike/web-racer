import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, compose, cylinder, mixOklab, toRGB, extrudePolygon, frame, loft, paint, paintDecal, ringXY, roundedBox, translation, tube } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { CHARCOAL, GUNMETAL, addBolt } from '../parts';
import type { P3 } from '../parts';
import { BELT_MID, NOSE_TIP, RECLINE, SEAT, SILL_A, TUBE } from './layout';
import type { Paints } from './layout';

/**
 * COMET FOX shell: the arrowhead nose, the two flank panels with the fox
 * emblem, the dorsal fin and its saddle. Everything is glossy toy paint with
 * thick, soft edges; the graphics are region paint, so the highlights run
 * over them unbroken.
 */

// ---------------------------------------------------------------------------
// Sections

interface Corner {
  p: Vec2;
  /** Fillet radius (clamped to what the two edges leave room for). */
  r: number;
  /** Arc segments; 0 = a plain vertex. The count is fixed per corner so
   * every station of a loft has the same number of points. */
  n: number;
}

/** Closed polygon with a round fillet at each corner and a FIXED point
 * count, so that stations of different size loft point for point. */
export function roundedSection(corners: readonly Corner[]): Vec2[] {
  const out: Vec2[] = [];
  const N = corners.length;
  for (let i = 0; i < N; i++) {
    const c = corners[i];
    if (c.n <= 0) {
      out.push(c.p);
      continue;
    }
    const a = corners[(i + N - 1) % N].p;
    const b = corners[(i + 1) % N].p;
    const ux = a[0] - c.p[0];
    const uy = a[1] - c.p[1];
    const vx = b[0] - c.p[0];
    const vy = b[1] - c.p[1];
    const la = Math.hypot(ux, uy);
    const lb = Math.hypot(vx, vy);
    const bx = ux / (la || 1) + vx / (lb || 1);
    const by = uy / (la || 1) + vy / (lb || 1);
    const bl = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9 || bl < 1e-6) {
      for (let k = 0; k <= c.n; k++) out.push(c.p);
      continue;
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (la * lb))));
    const t = Math.tan(theta / 2);
    const d = Math.min(c.r / t, la * 0.45, lb * 0.45);
    const r = d * t;
    const dist = r / Math.sin(theta / 2);
    const cx = c.p[0] + (bx / bl) * dist;
    const cy = c.p[1] + (by / bl) * dist;
    const a0 = Math.atan2(c.p[1] + (uy / la) * d - cy, c.p[0] + (ux / la) * d - cx);
    const a1 = Math.atan2(c.p[1] + (vy / lb) * d - cy, c.p[0] + (vx / lb) * d - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    for (let k = 0; k <= c.n; k++) {
      const ang = a0 + (da * k) / c.n;
      out.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nose

/**
 * One station of the nose. The section is a deep wedge: a crowned deck, a
 * crisp chamfer, the upper flank (the face the eye sits in) tucking in
 * toward its foot, then a step IN to the recessed intake face, a step back
 * out to the red lower lip, and a flat underside.
 *   z, half-width of the deck edge, crown height, deck-edge height, foot of
 *   the upper flank, top of the lip, underside, flank tuck, intake recess.
 * Behind the intake the recess shrinks to a hair, so the same faces become
 * the flush red cheek the wishbones come out of.
 */
type NoseStation = [z: number, w: number, yc: number, ye: number, yf: number, yl: number, yb: number, tuck: number, step: number];

/**
 * Side profile: the deck climbs steeply out of a low knife tip and rides
 * just over the front tires at the axle, then flattens back to the cockpit —
 * the sheet's convex wedge. Plan: an arrowhead widening to the A-pillars.
 */
const NOSE: NoseStation[] = [
  [NOSE_TIP - 0.004, 0.014, 0.338, 0.336, 0.32, 0.294, 0.282, 0.002, 0.002],
  [1.85, 0.058, 0.405, 0.395, 0.326, 0.294, 0.28, 0.005, 0.014],
  [1.74, 0.122, 0.505, 0.49, 0.352, 0.3, 0.282, 0.01, 0.026],
  [1.6, 0.182, 0.612, 0.592, 0.4, 0.312, 0.288, 0.014, 0.032],
  // Front face of the post that closes the intake.
  [1.47, 0.218, 0.69, 0.666, 0.45, 0.33, 0.3, 0.018, 0.034],
  // Cheek: the recess is gone.
  [1.43, 0.228, 0.712, 0.688, 0.466, 0.335, 0.302, 0.02, 0.003],
  [1.275, 0.268, 0.778, 0.75, 0.52, 0.352, 0.31, 0.024, 0.003],
  [1.1, 0.318, 0.83, 0.798, 0.58, 0.41, 0.36, 0.028, 0.003],
  [0.95, 0.368, 0.868, 0.832, 0.64, 0.5, 0.455, 0.03, 0.003],
  [0.78, 0.418, 0.902, 0.86, 0.7, 0.615, 0.575, 0.03, 0.003],
  [0.62, 0.45, 0.925, 0.876, 0.74, 0.7, 0.672, 0.026, 0.003],
  [0.45, 0.48, 0.945, 0.888, 0.768, 0.72, 0.69, 0.026, 0.003],
  // A broad chamfer round the rear end (the loft breaks sharply at the
  // station above, so this one only bevels the rim).
  [0.426, 0.456, 0.93, 0.866, 0.784, 0.735, 0.708, 0.02, 0.003],
];

/** Stations where the intake ends (the post's front face) and the cheek begins. */
const POST_FRONT = NOSE.findIndex((st) => st[0] === 1.47);
const POST_BACK = POST_FRONT + 1;

/** Points per section corner (fillet arcs have n + 1), right half incl. the
 * two centre points — fixed so every station lofts point for point. */
const CORNER_POINTS = [1, 1, 1, 2, 2, 2, 2, 2, 3, 1];
/** Index of the corner at the foot of the upper flank. */
const FLANK_FOOT = 4;
const RING_POINTS = 2 * CORNER_POINTS.reduce((a, b) => a + b, 0) - 2;
/** Section edges of the recess on the right side: the ledge under the
 * flank, both inner fillets and the recessed face between them. */
const RECESS_FIRST = CORNER_POINTS.slice(0, FLANK_FOOT + 1).reduce((a, b) => a + b, 0) - 1;
const RECESS_LAST = RECESS_FIRST + 3;

function noseRing(s: NoseStation): Vec2[] {
  const [, w, yc, ye, yf, yl, yb, tuck, step] = s;
  const k = Math.min(1, w / 0.16);
  const xo = w - tuck;
  const xi = xo - step;
  const half: Corner[] = [
    { p: [0, yc], r: 0, n: 0 },
    // Two points across the deck, on a gentle dome: even quads for the AO
    // bake (one crown-to-edge sliver shades blotchy) and a softer highlight.
    { p: [w * 0.36, yc - (yc - ye) * 0.18], r: 0, n: 0 },
    { p: [w * 0.7, yc - (yc - ye) * 0.52], r: 0, n: 0 },
    // A crisp chamfer between deck and flank, not a soft roll.
    { p: [w, ye], r: 0.024 * k, n: 1 },
    { p: [xo, yf], r: 0.008 * k, n: 1 },
    { p: [xi, yf - 0.012], r: 0.005 * k, n: 1 },
    { p: [xi, yl + 0.012], r: 0.005 * k, n: 1 },
    { p: [xo, yl], r: 0.008 * k, n: 1 },
    { p: [xo - 0.014 * k, yb], r: 0.018 * k, n: 2 },
    { p: [0, yb], r: 0, n: 0 },
  ];
  const full = [...half, ...half.slice(1, half.length - 1).reverse().map((c) => ({ ...c, p: [-c.p[0], c.p[1]] as Vec2 }))];
  return roundedSection(full);
}

interface NoseSection {
  w: number;
  yc: number;
  ye: number;
  yf: number;
  yl: number;
  yb: number;
  tuck: number;
  step: number;
}

function noseAt(z: number): NoseSection {
  let i = 0;
  while (i + 2 < NOSE.length && NOSE[i + 1][0] > z) i++;
  const a = NOSE[i];
  const b = NOSE[i + 1];
  const t = Math.max(0, Math.min(1, (a[0] - z) / (a[0] - b[0])));
  const at = (k: number): number => a[k] + (b[k] - a[k]) * t;
  return { w: at(1), yc: at(2), ye: at(3), yf: at(4), yl: at(5), yb: at(6), tuck: at(7), step: at(8) };
}

/** Height of the nose's top surface at (|x|, z) — for parts that sit on it. */
export function noseTop(x: number, z: number): number {
  const n = noseAt(z);
  return n.yc + (n.ye - n.yc) * Math.min(1, Math.abs(x) / n.w);
}

/** Underside of the nose at z — the frame's tubes end above it. */
export function noseBottom(z: number): number {
  return noseAt(z).yb;
}

/** The white chevron: an arrowhead whose two arms run back along the edges
 * and thin to a point. Top view, [x, z]. */
const CHEVRON: Vec2[] = [
  [0, 1.862],
  [0.39, 0.7],
  [0.276, 0.662],
  [0, 1.482],
  [-0.276, 0.662],
  [-0.39, 0.7],
];

/** The dark bonnet panel inside the chevron. */
const BONNET: Vec2[] = [
  [0, 1.1],
  [0.225, 0.8],
  [0.275, 0.3],
  [-0.275, 0.3],
  [-0.225, 0.8],
];

/** Eye in the side view, [z, y]: a blade with its point toward the nose tip,
 * along the foot of the upper flank — and the dark surround it is let into. */
const EYE: Vec2[] = [
  [1.85, 0.345],
  [1.545, 0.585],
  [1.555, 0.47],
  [1.72, 0.37],
];
/** The bright core of the lens. */
const EYE_CORE: Vec2[] = [
  [1.79, 0.37],
  [1.59, 0.545],
  [1.598, 0.49],
  [1.71, 0.392],
];
const EYE_SURROUND: Vec2[] = [
  [1.885, 0.33],
  [1.51, 0.615],
  [1.522, 0.455],
  [1.72, 0.352],
];

export function addNose(m: SolidMesh, P: Paints): void {
  // The nose's own crease angle is tighter than the shell's: the chamfer's
  // two ~45° edges must stay crisp lines.
  const BODY = paint(P.BODY, { smooth: 30 });
  const GRAPHIC = paint(P.GRAPHIC, { smooth: 30 });
  const DARK = paint(CHARCOAL, { gloss: 0.5, smooth: 42 });
  const GRILLE = paint('#24242B', { gloss: 0.3, smooth: 30 });
  const SLAT = paint('#4A4C56', { gloss: 0.5, metal: 0.5 });
  const s = m.mark();
  const spans = NOSE.length - 1;
  const recess = (j: number): boolean => (j >= RECESS_FIRST && j <= RECESS_LAST) || (RING_POINTS - 1 - j >= RECESS_FIRST && RING_POINTS - 1 - j <= RECESS_LAST);
  loft(
    m,
    { rings: NOSE.map((st) => ringXY(noseRing(st), st[0])), subdivisions: 3, sharp: [POST_FRONT, POST_BACK, NOSE.length - 2], caps: true },
    (u, _v, _i, j) => (recess(j) && u < POST_FRONT / spans - 1e-6 ? GRILLE : BODY),
  );
  const top = (_c: unknown, n: { y: number }): boolean => n.y > 0.55;
  paintDecal(m, { outline: CHEVRON, facing: '+y', only: top, from: s }, GRAPHIC);
  paintDecal(m, { outline: BONNET, facing: '+y', only: top, from: s }, DARK);
  // Eyes: a dark surround painted into the upper flank, and in it a raised
  // lens. The flank is close to a plane between the stations, so the lens
  // is a flat bevelled plate laid on that plane.
  for (const side of [1, -1]) {
    const flank = (c: { y: number; z: number }, n: { x: number; y: number }): boolean => n.x * side > 0.25 && n.y < 0.6 && c.y > noseAt(c.z).yf - 0.004;
    paintDecal(m, { outline: EYE_SURROUND.map(([z, y]) => [side * z, y] as Vec2), facing: side > 0 ? '+x' : '-x', only: flank, from: s }, GRILLE);
  }
  // Three points on the upper flank (a quarter of the way down from the
  // chamfer, and at its foot) span the lens plane.
  const onFace = (z: number, f: number): Vector3 => {
    const n = noseAt(z);
    return new Vector3(n.w - n.tuck * f, n.ye - 0.02 + (n.yf + 0.004 - (n.ye - 0.02)) * f, z);
  };
  const A = onFace(1.54, 0.25);
  const B = onFace(1.54, 1);
  const C = onFace(1.82, 0.25);
  let nrm = Vector3.Cross(B.subtract(A), C.subtract(A)).normalize();
  if (nrm.x < 0) nrm = nrm.scale(-1);
  const ex = C.subtract(A).normalize();
  const ey = Vector3.Cross(nrm, ex).normalize();
  if (ey.y < 0) ey.scaleInPlace(-1);
  const onFlank = ([z, y]: Vec2): Vec2 => {
    const x = A.x - (nrm.y * (y - A.y) + nrm.z * (z - A.z)) / nrm.x;
    const d = new Vector3(x, y, z).subtract(A);
    return [Vector3.Dot(d, ex), Vector3.Dot(d, ey)];
  };
  const lens = m.mark();
  // The flank bows out past the chord plane between the stations, so the
  // lens stands on a thicker plate to clear it everywhere.
  extrudePolygon(m, { outline: EYE.map(onFlank), depth: 0.02, bevel: 0.006, bevelSegments: 2, back: false, at: compose(translation(0, 0, -0.005), frame(A, ex, ey, nrm)) }, P.LENS);
  extrudePolygon(m, { outline: EYE_CORE.map(onFlank), depth: 0.006, bevel: 0.003, back: false, at: compose(translation(0, 0, 0.0125), frame(A, ex, ey, nrm)) }, paint(mixOklab(P.GLOW.color, toRGB('#FFFFFF'), 0.3), { emissive: 0.9, gloss: 0.9 }));
  m.mirrorCopy('x', lens);

  // Intake slats: chunky dark blades across the recess, raked back, their
  // backs sunk into the recessed face and their ends into the two ledges.
  const slats = m.mark();
  for (let k = 0; k < 6; k++) {
    const z = 1.505 + k * 0.05;
    const n = noseAt(z);
    const xi = n.w - n.tuck - n.step;
    const y0 = n.yl + 0.006;
    const y1 = n.yf - 0.006;
    if (y1 - y0 < 0.02) continue;
    roundedBox(m, { size: [0.028, (y1 - y0) / Math.cos((22 * Math.PI) / 180), 0.016], radius: 0.004, segments: 1, rot: [-22, 0, 0], at: [xi + 0.002, (y0 + y1) / 2, z] }, SLAT);
  }
  m.mirrorCopy('x', slats);

  // Dome bolts along the rear of each edge, where the bonnet is screwed to
  // the frame.
  for (const side of [-1, 1]) {
    for (const z of [0.56, 0.78, 1.0]) {
      const x = noseAt(z).w - 0.045;
      addBolt(m, { at: [side * x, noseTop(x, z) - 0.001, z], normal: [0, 1, 0.3], radius: 0.014, style: 'button' });
    }
  }

  // Three louvres in the point of the bonnet panel.
  for (const [z, half] of [[0.84, 0.145], [0.91, 0.1], [0.98, 0.055]] as const) {
    roundedBox(m, { size: [half * 2, 0.02, 0.03], radius: 0.008, segments: 1, rot: [12, 0, 0], at: [0, noseTop(0, z) + 0.001, z] }, GUNMETAL);
  }

  // Instrument cowl: a dark hump on the bonnet ahead of the steering wheel.
  roundedBox(m, { size: [0.4, 0.085, 0.3], radius: 0.035, segments: 3, rot: [8, 0, 0], at: [0, noseTop(0, 0.6) - 0.004, 0.6] }, DARK);
  // Two glowing gauge faces let into the cowl's rear face, toward the driver.
  const yc = noseTop(0, 0.6) - 0.004;
  const tilt = (8 * Math.PI) / 180;
  for (const x of [-0.085, 0.085]) {
    // Local point (x, -0.004, -0.15) on the cowl, turned about X.
    const c: P3 = [x, yc - 0.004 * Math.cos(tilt) + 0.15 * Math.sin(tilt), 0.6 - 0.004 * Math.sin(tilt) - 0.15 * Math.cos(tilt)];
    const n: P3 = [0, Math.sin(tilt), -Math.cos(tilt)];
    const at = (d: number): P3 => [c[0] + n[0] * d, c[1] + n[1] * d, c[2] + n[2] * d];
    cylinder(m, { from: at(-0.01), to: at(0.006), radius: 0.036, sides: 16, bevel: { top: 0.004 }, bevelSegments: 1 }, GUNMETAL);
    cylinder(m, { from: at(0), to: at(0.0085), radius: 0.027, sides: 16, caps: 'top' }, P.GLOW_SOFT);
  }
}

/**
 * Front coil-over top mounts: the library's clevis stands on the frame's
 * outrigger just above the nose's edge, so all the shell needs is a low
 * gunmetal pad where that tube comes through — a bracket bolted to the
 * edge, not a tower: the arrow outline of the hood stays clean.
 */
export function addShockEars(m: SolidMesh, top: P3): void {
  const [x, y, z] = top;
  const edge = noseAt(z);
  const s = m.mark();
  const PAD = paint(GUNMETAL, { gloss: 0.5 });
  const y1 = y - 0.03;
  roundedBox(m, { min: [edge.w - 0.07, edge.ye - 0.05, z - 0.07], max: [x + 0.02, y1, z + 0.07], radius: 0.018, segments: 2 }, PAD);
  for (const dz of [-0.045, 0.045]) addBolt(m, { at: [edge.w - 0.045, y1 - 0.001, z + dz], normal: [0, 1, 0], radius: 0.011, style: 'button' });
  m.mirrorCopy('x', s);
}

// ---------------------------------------------------------------------------
// Flank panels

/**
 * Outline from corner points with an optional bow per edge: the edge from a
 * point to the next bulges by `bow` × its length (positive = to the LEFT of
 * the direction of travel — inward on a counter-clockwise outline), sampled
 * as a parabola. The corners themselves stay sharp: flame tips and ear tips.
 */
function bowed(points: readonly (readonly [number, number, number?])[], steps = 4): Vec2[] {
  const out: Vec2[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay, bow] = points[i];
    const [bx, by] = points[(i + 1) % n];
    out.push([ax, ay]);
    if (!bow) continue;
    const dx = bx - ax;
    const dy = by - ay;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const h = 4 * t * (1 - t) * bow;
      out.push([ax + dx * t - dy * h, ay + dy * t + dx * h]);
    }
  }
  return out;
}

/**
 * Fox head in profile, facing +u (the car's nose), [u, v, bow] in meters
 * around the emblem's centre, counter-clockwise from the snout tip: a long
 * snout, two upright ears, the swept comet-tail flames behind the head, a
 * jagged three-point ruff under the cheek, and the mouth notch under the
 * snout.
 */
const FOX: Vec2[] = bowed([
  [0.25, -0.06, -0.02],
  [0.08, 0.035, 0],
  // Two ears side by side, swept back.
  [-0.03, 0.165, 0.03],
  [-0.04, 0.07, 0],
  [-0.15, 0.15, 0.03],
  [-0.12, 0.04, 0],
  // Comet-tail flames streaming off the back of the head.
  [-0.29, 0.03, 0.03],
  [-0.13, -0.02, 0],
  [-0.25, -0.085, 0.03],
  [-0.1, -0.06, 0],
  // Jagged ruff under the cheek.
  [-0.06, -0.14, 0],
  [-0.01, -0.085, 0],
  [0.045, -0.13, 0],
  [0.11, -0.088, 0],
  // Lower jaw, and the mouth notch between it and the snout.
  [0.19, -0.083, 0],
  [0.155, -0.069, 0],
]);
/** Slit eye, narrowing toward the snout. */
const FOX_EYE: Vec2[] = bowed([
  [0.045, 0.0, -0.08],
  [0.145, -0.02, 0.08],
  [0.07, 0.018, 0.06],
]);
/** Emblem scale (u, v): fills about two thirds of the panel's height. */
const FOX_SCALE: Vec2 = [0.86, 0.86];

/** Panel corners in the side view, [z, y]: top front, bottom front, bottom
 * rear, top rear — a parallelogram leaning forward whose bottom edge climbs
 * toward the rear, leaving open frame under it as on the sheet. */
const PANEL: Vec2[] = [
  [0.33, 0.905],
  [0.5, 0.52],
  [-0.42, 0.6],
  [-0.745, 0.978],
];
const PANEL_THICKNESS = 0.032;
/** The panel lies on the frame's side plane, leaning in at the top with it
 * — so its face catches the sky and shows in the top view, as on the
 * sheet. (Leaning OUT would turn the face toward the ground and darken it,
 * and stand its top off the belt rail.) Its inner face lies 3 mm inside
 * the tubes' outer surface, so they bed into it instead of touching along
 * a line. */
const panelLean = (): { x0: number; y0: number; deg: number } => {
  const dx = SILL_A[0] - BELT_MID[0];
  const dy = BELT_MID[1] - SILL_A[1];
  return { x0: SILL_A[0] + TUBE - 0.003, y0: SILL_A[1], deg: (Math.atan2(dx, dy) * 180) / Math.PI };
};

export function addFlankPanels(m: SolidMesh, P: Paints): void {
  const s = m.mark();
  const { x0, y0, deg } = panelLean();
  // Drawn as seen from the right side: the world is left-handed, so the
  // viewer's right is the car's nose (+z).
  extrudePolygon(m, { outline: PANEL.map(([z, y]) => [z, y - y0] as Vec2), depth: PANEL_THICKNESS, bevel: 0.011, bevelSegments: 2, bevelBack: true, facing: '+x', at: [x0, y0, 0] }, P.BODY);
  // The emblem is a badge standing 4 mm proud of the panel (a region-paint
  // decal this intricate would shred the flat face into slivers), its eye a
  // hole through to the paint.
  const [ku, kv] = FOX_SCALE;
  extrudePolygon(
    m,
    {
      outline: FOX.map(([u, v]) => [u * ku, v * kv] as Vec2),
      holes: [FOX_EYE.map(([u, v]) => [u * ku, v * kv] as Vec2)],
      depth: 0.0055,
      bevel: 0.002,
      back: false,
      facing: '+x',
      at: [x0 + PANEL_THICKNESS - 0.0015, 0.765, -0.08],
    },
    P.GRAPHIC,
  );
  // Four dome bolts in the corners.
  const inset = 0.08;
  const cz = (PANEL[0][0] + PANEL[1][0] + PANEL[2][0] + PANEL[3][0]) / 4;
  const cy = (PANEL[0][1] + PANEL[1][1] + PANEL[2][1] + PANEL[3][1]) / 4;
  for (const [z, y] of PANEL) {
    const d = Math.hypot(cz - z, cy - y);
    addBolt(m, { at: [x0 + PANEL_THICKNESS - 0.001, y + ((cy - y) / d) * inset, z + ((cz - z) / d) * inset], normal: [1, 0, 0], radius: 0.016, style: 'button' });
  }
  m.rotate('z', deg, s, [x0, y0, 0]);
  m.mirrorCopy('x', s);
}

// ---------------------------------------------------------------------------
// Dorsal fin

/**
 * Uniform Catmull-Rom through a closed outline, run by run: the listed
 * corner indices stay sharp vertices, every run between two corners becomes
 * one smooth curve with up to `k` samples per span (so the long sweeps of
 * the fin and its graphic show no polyline corners in close-up). Short
 * spans get fewer: an edge shorter than the extrusion's bevel inset at a
 * sharp corner would turn the bevel inside out.
 */
function smoothOutline(pts: readonly Vec2[], corners: readonly number[], k: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % corners.length];
    const run: Vec2[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      run.push(pts[i]);
      if (i === b) break;
    }
    if (run.length === 2) {
      out.push(run[0]);
      continue;
    }
    const at = (i: number): Vec2 => {
      if (i < 0) return [2 * run[0][0] - run[1][0], 2 * run[0][1] - run[1][1]];
      if (i >= run.length) {
        const l = run.length - 1;
        return [2 * run[l][0] - run[l - 1][0], 2 * run[l][1] - run[l - 1][1]];
      }
      return run[i];
    };
    for (let i = 0; i < run.length - 1; i++) {
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const steps = Math.max(1, Math.min(k, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.065)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const f = (q: 0 | 1): number => 0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * t3);
        out.push([f(0), f(1)]);
      }
    }
  }
  return out;
}

/** Side view [z, y]: a steep leading edge rising out of the hoop to the
 * knee, a long top edge sweeping back to the tip, a hollow trailing edge. */
const FIN_POINTS: Vec2[] = [
  [-0.615, 1.42],
  [-0.66, 1.5],
  [-0.745, 1.59],
  [-0.87, 1.68],
  [-1.03, 1.75],
  [-1.22, 1.8],
  [-1.42, 1.835],
  [-1.62, 1.857],
  [-1.775, 1.868],
  [-1.748, 1.8],
  // Trailing edge: a concave shark-fin curve.
  [-1.62, 1.728],
  [-1.52, 1.65],
  [-1.45, 1.56],
  [-1.412, 1.48],
  [-1.4, 1.42],
];
const FIN = smoothOutline(FIN_POINTS, [0, 8, 9, 14], 3);
/** Fin thickness at the root and at the tip: a tapering blade. */
const FIN_ROOT = 0.12;
const FIN_TIP = 0.04;

/** The sheet's bold slanted "F": a stem parallel to the leading edge from
 * the root up, a long upper arm under the top edge to near the tip, a
 * shorter lower arm, both with raked blunt ends. */
const SWOOSH = smoothOutline(
  [
    [-0.7, 1.45],
    [-0.8, 1.585],
    [-0.95, 1.705],
    [-1.08, 1.76],
    [-1.22, 1.776],
    [-1.42, 1.805],
    [-1.62, 1.826],
    [-1.71, 1.834],
    [-1.665, 1.768],
    [-1.42, 1.74],
    [-1.22, 1.712],
    [-1.08, 1.69],
    [-1.04, 1.645],
    [-1.25, 1.648],
    [-1.42, 1.662],
    [-1.475, 1.666],
    [-1.425, 1.6],
    [-1.25, 1.584],
    [-1.07, 1.562],
    [-0.98, 1.52],
    [-0.9, 1.45],
  ],
  [0, 7, 8, 11, 12, 15, 16, 20],
  3,
);

export function addFin(m: SolidMesh, P: Paints): void {
  const s = m.mark();
  extrudePolygon(m, { outline: FIN, depth: FIN_ROOT, centered: true, bevel: 0.018, bevelSegments: 2, bevelBack: true, facing: '+x' }, P.BODY);
  // The F is a thin badge on each flank, not region paint: projected onto
  // the fin's long ear-cut slivers a curve this long would split them into
  // thousands of triangles. It is laid on the untapered slab, so the taper
  // below carries it along onto the flank (standing 4.5 mm proud at the
  // root, 1.5 mm at the tip).
  for (const side of [1, -1]) {
    extrudePolygon(
      m,
      {
        outline: side > 0 ? SWOOSH : SWOOSH.map(([z, y]) => [-z, y] as Vec2),
        depth: 0.006,
        back: false,
        facing: side > 0 ? '+x' : '-x',
        at: [side * (FIN_ROOT / 2 - 0.0015), 0, 0],
      },
      P.GRAPHIC,
    );
  }
  // Taper the slab into a blade: thickness falls linearly with height, so
  // each flank stays an exact plane.
  const [y0, y1] = [FIN_POINTS[0][1], 1.868];
  m.displace((p) => {
    const t = Math.max(0, Math.min(1, (p.y - y0) / (y1 - y0)));
    return [p.x * ((FIN_ROOT + (FIN_TIP - FIN_ROOT) * t) / FIN_ROOT), p.y, p.z];
  }, s);
  // Saddle: the fairing the fin grows out of, from INSIDE the hoop's top
  // bar back over the turbine — nothing pokes forward under the roof.
  const sec = (w: number, h: number): Vec2[] =>
    roundedSection([
      { p: [w, 0], r: h * 0.45, n: 3 },
      { p: [w * 0.5, h], r: h * 0.5, n: 3 },
      { p: [-w * 0.5, h], r: h * 0.5, n: 3 },
      { p: [-w, 0], r: h * 0.45, n: 3 },
    ]);
  loft(
    m,
    {
      rings: [
        ringXY(sec(0.05, 0.03), -0.59, 0, 1.39),
        ringXY(sec(0.14, 0.06), -0.66, 0, 1.385),
        ringXY(sec(0.16, 0.07), -0.86, 0, 1.39),
        ringXY(sec(0.12, 0.07), -1.15, 0, 1.4),
        ringXY(sec(0.06, 0.06), -1.4, 0, 1.4),
        ringXY(sec(0.02, 0.03), -1.46, 0, 1.405),
      ],
      subdivisions: 3,
      caps: true,
    },
    P.BODY,
  );
  // Two dark cooling slots in the saddle either side of the fin's root.
  for (const side of [-1, 1]) {
    roundedBox(m, { size: [0.03, 0.012, 0.16], radius: 0.005, segments: 1, at: [side * 0.085, 1.452, -0.8] }, paint('#1C1C22', { gloss: 0.2 }));
  }
}

// ---------------------------------------------------------------------------
// Seat piping

/**
 * The sheet's seat is black with a thick cream edge — that outline is what
 * makes it read from above. The library seat has no such option, so the
 * piping is a tube laid along the front rim of its back's wings and the top
 * of its hip bolsters, using the library seat's default proportions (width
 * 0.5, back 0.62) and its placement of the back.
 */
export function addSeatPiping(m: SolidMesh, p: Paint): void {
  const H = 0.62;
  const e = 0.046;
  // [height fraction, half-width, wing wrap] of the library's back stations.
  const st: [number, number, number][] = [[0.04, 0.2, 0.07], [0.2, 0.238, 0.1], [0.42, 0.208, 0.07], [0.68, 0.295, 0.11], [0.84, 0.262, 0.08], [0.94, 0.18, 0.035]];
  const a = (-RECLINE * Math.PI) / 180;
  const onBack = (x: number, y: number, z: number): P3 => [SEAT[0] + x, SEAT[1] + y * Math.cos(a) - z * Math.sin(a) - 0.04, SEAT[2] + y * Math.sin(a) + z * Math.cos(a) - 0.235];
  const side = (sx: number): P3[] => st.map(([f, W, D]) => onBack(sx * (W - e * 0.55), f * H, 0.118 + D + e * 0.3));
  const left = side(-1);
  const right = side(1).reverse();
  const top: P3[] = [onBack(-0.11, H * 1.0, 0.13), onBack(0, H * 1.03, 0.128), onBack(0.11, H * 1.0, 0.13)];
  tube(m, { path: [...left, ...top, ...right], radius: 0.013, sides: 6, fillet: 0.03, caps: 'round' }, p);
  // Hip bolsters: along the top of each, nose tipped up 5° like the base.
  const b = (5 * Math.PI) / 180;
  for (const sx of [-1, 1]) {
    const at = (z: number): P3 => [SEAT[0] + sx * 0.21, SEAT[1] + 0.078 + (z - 0.12) * Math.sin(b), SEAT[2] + z];
    tube(m, { path: [at(-0.07), at(0.32)], radius: 0.013, sides: 6, caps: 'round' }, p);
  }
}
