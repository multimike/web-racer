import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, compose, cylinder, extrudePolygon, linePath, paint, paintDecal, paintStripe, rotation, roundedBox, roundedRectRing, shade, sphere, torus, translation, tube } from '../../../gfx/solid';
import type { Paint, Vec2, Vec3 } from '../../../gfx/solid';
import {
  CHARCOAL,
  GUNMETAL,
  LAMP_RED,
  STEEL,
  addCageTube,
  addDashboard,
  addFloorPan,
  addPedals,
  addSeat,
  addSteeringColumn,
  facingAt,
} from '../parts';
import type { P3, RunningGear } from '../parts';
import { A_FOOT, A_TOP, B_FOOT, B_TOP, COLUMN_FROM, DAMPER_R, FLOOR, PEDALS, RECLINE, R_TOP, SEAT, S_NODE, TAIL, TUBE, WAIST_Y, WHEEL } from './layout';
import type { RamLivery } from './layout';
import { lampCell, panelSolid, rivet, roundPoly, taperBox } from './shapes';

/**
 * RIOT RAM — the sprung body. "The broadest and most square of the four":
 * flat bevelled panels on a tube frame. Built from the centre out:
 *
 *   hood + nose    one wedge-shaped panel solid between the front wheels,
 *                  necked in behind the lamp block so the tires can steer
 *   spine          the dark chassis box under hood and motor — every
 *                  wishbone pivot is bolted to it
 *   tub            floor pan, walls, bulkheads; outside it the cobalt door
 *                  frames with the striped orange panels
 *   fenders        four thick orange arches with a down-turned outer lip,
 *                  the front pair standing on the shock towers, the rear
 *                  pair hanging from the cage's waist rails
 *   cage           one continuous perimeter tube (A-pillar, roof rail, rear
 *                  stay, tail bumper) + cross tubes, B-pillars, waist rails
 *   tail           low motor cover with a louvred grille (cooling fan behind
 *                  it), tail lamps clamped on the rear stays
 *
 * Everything symmetric is modelled on the RIGHT (x > 0) in `h` and mirrored;
 * the hood stripes are the one asymmetric graphic and are painted on the
 * whole hood.
 */

interface Paints {
  BODY: Paint;
  PANEL: Paint;
  STRIPE: Paint;
  CAGE: Paint;
  /** Cockpit interior. */
  DARK: Paint;
  /** Moulded motor cover / lamp housings. */
  MOTOR: Paint;
  SLAT: Paint;
  /** Hood scoop: louvres and the intake floor under them. */
  LOUVRE: Paint;
  INTAKE: Paint;
  /** Headlamp bezels: the body colour taken dark. */
  BEZEL: Paint;
  /** Light-bar housing. */
  HOUSING: Paint;
}

/** Warm amber lamps with a brighter centre: saturated enough to stay amber
 * after tone-mapping (the stock LAMP_WARM reads near-white on this car). */
const LAMP_GLOW = paint('#FFB862', { emissive: 0.62, gloss: 0.9 });
const LAMP_HOT = paint('#FFD596', { emissive: 0.85, gloss: 0.9 });

const lerp3 = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mirrorX = (p: P3): P3 => [-p[0], p[1], p[2]];

// ---------------------------------------------------------------------------
// Hood and nose

/** Foot of the nose face, and how far it rakes back per meter of height. It
 * stands 10 cm behind the bash plate, so the plate juts out as a bumper chin
 * in the side view, as on the sheet. */
const NOSE_Z = 1.64;
const NOSE_RAKE = 0.1;

/**
 * Hood cross-sections, nose → cowl: [z, half top flat, top y, half width,
 * shoulder y, lower side y, half bottom, bottom y, rake]. The lamp block
 * (first two) is 1 m wide and reaches down to y 0.7; behind it the section
 * jumps up to a shallow lid no wider than 0.45, because at full lock the
 * front tires swing in to x = 0.45 right there. At the cowl it flares out to
 * the tub's width.
 */
const HOOD: readonly (readonly number[])[] = [
  [NOSE_Z, 0.36, 1.07, 0.5, 1.02, 0.8, 0.3, 0.71, NOSE_RAKE],
  [1.46, 0.38, 1.2, 0.5, 1.125, 0.85, 0.3, 0.74, 0],
  [1.39, 0.33, 1.245, 0.385, 1.175, 1.03, 0.26, 0.96, 0],
  [1.05, 0.33, 1.295, 0.385, 1.23, 1.07, 0.26, 0.98, 0],
  [0.755, 0.415, 1.3125, 0.5025, 1.245, 1.07, 0.33, 0.98, 0],
  [0.46, 0.5, 1.33, 0.62, 1.26, 1.07, 0.4, 0.98, 0],
];

/** z of the nose face on the plane at height y (raked back toward the top). */
const noseZ = (y: number): number => NOSE_Z - NOSE_RAKE * (y - 0.71);
/** Outward normal of the raked nose face. */
const NOSE_N: Vec3 = [0, NOSE_RAKE, 1];

/** Height of the hood's top face at z. */
function hoodTop(z: number): number {
  // Where each station's top edge really is: raked stations lean back.
  const zTop = (s: readonly number[]): number => s[0] - s[8] * (s[2] - s[7]);
  for (let i = 0; i + 1 < HOOD.length; i++) {
    const a = HOOD[i];
    const b = HOOD[i + 1];
    const za = zTop(a);
    const zb = zTop(b);
    if (z <= za && z >= zb) return a[2] + ((b[2] - a[2]) * (za - z)) / (za - zb || 1);
  }
  return z > zTop(HOOD[0]) ? HOOD[0][2] : HOOD[HOOD.length - 1][2];
}

function addHood(m: SolidMesh, l: RamLivery, P: Paints): void {
  const hood = new SolidMesh();
  const stations = HOOD.map(([z, a, yTop, w, ySh, yLo, b, yBot, rake]) => {
    const at = (x: number, y: number): Vec3 => [x, y, z - rake * (y - yBot)];
    return roundPoly([at(a, yTop), at(w, ySh), at(w, yLo), at(b, yBot), at(-b, yBot), at(-w, yLo), at(-w, ySh), at(-a, yTop)], 0.02, 2);
  });
  // Tight edges: the top, brow and face planes break crisply, as pressed
  // panels do (a broad round here reads as a pillow).
  panelSolid(hood, stations, { edge: 0.02, segs: 2, ends: [0.014, 0] }, P.BODY);
  // The rear face is the firewall the dashboard hangs on.
  hood.repaint((c, n) => (n.z < -0.9 && c.z < 0.47 ? P.DARK : undefined));

  // Panel seams: the nose's centre panel is a separate pressing from the two
  // cheeks — a dark groove line either side of the stripes, down the face.
  // They sit outboard of both stripes, on the fold lines where the nose's
  // outer facets rake back; the seam paint's low crease angle keeps that fold
  // crisp after the rake (see `rakeNose`).
  const SEAM = paint(shade(l.body, 0.45), { gloss: 0.4, smooth: 8 });
  for (const side of [-1, 1]) {
    paintStripe(hood, { axis: 'x', min: side * FOLD - 0.008, max: side * FOLD + 0.008, only: (c) => c.z > 1.15 && c.y > 0.74 }, SEAM);
  }
  // Rake before any decal: displacing drops the pinned normals, and the
  // decals' split slivers only shade right with them pinned.
  rakeNose(hood);

  // Two short bold diagonals on the nose panel, about 30° off the centre
  // line, running back toward the car's left and ending at the lid's front
  // edge (drawn as a top view: x right, model +z up the page).
  const z0 = 1.7;
  const z1 = 1.3;
  const drift = -(z0 - z1) * Math.tan((30 * Math.PI) / 180);
  for (const [x, w] of l.hoodStripes) {
    paintDecal(
      hood,
      {
        outline: [
          [x, z0],
          [x - w, z0],
          [x - w + drift, z1],
          [x + drift, z1],
        ],
        facing: '+y',
        only: (c, n) => n.y > 0.55 && c.z > z1 - 0.02,
      },
      P.STRIPE,
    );
  }
  // The dark band between the headlamps with the slot let into it: painted
  // first, then a real recess (below) is sunk into it.
  paintDecal(hood, { outline: roundedRectRing(0.43, 0.085, 0.02, 2), facing: '+z', at: [0, 0.9, 0], only: (c, n) => n.z > 0.7 && c.z > 1.55 }, paint('#2A2C36', { gloss: 0.35 }));
  // Slot: a dark tray standing 1.5 cm proud of the band with a deeper
  // charcoal recess in its middle — reads as a cut, not a sticker.
  const slot = new SolidMesh();
  extrudePolygon(slot, { outline: roundedRectRing(0.4, 0.07, 0.016, 2), holes: [roundedRectRing(0.36, 0.045, 0.01, 2)], depth: 0.016, bevel: 0.005, bevelSegments: 1, back: false }, paint('#2A2C36', { gloss: 0.4 }));
  box(slot, { min: [-0.185, -0.025, -0.01], max: [0.185, 0.025, 0.004] }, paint('#141519', { gloss: 0.2 }));

  // Hood scoop: two orange cheeks and a bridge round a real intake, built on
  // the hood's own plane (which falls 3.4° toward the nose). The cheeks stay
  // tall at the front, so the intake shows as a dark mouth over a low lip.
  const s = new SolidMesh();
  const cheek: Vec2[] = [
    [-0.28, -0.02],
    [-0.28, 0.06],
    [-0.02, 0.1],
    [0.27, 0.07],
    [0.27, -0.02],
  ];
  const slope = 0.03 / 0.29;
  // Each cheek runs straight for 10 cm, then its outer flank is clipped at
  // both ends and lowered: the scoop is a hexagon in plan, as on the sheet.
  const cheekAt = (x: number, k: number): Vector3[] => roundPoly(cheek.map(([z, y]) => [x, y > 0 ? y * (0.55 + 0.45 * k) : y, -0.04 + (z + 0.04) * k] as Vec3), 0.016, 2);
  panelSolid(s, [cheekAt(0.17, 1), cheekAt(0.27, 1), cheekAt(0.34, 0.6)], { edge: 0.016, segs: 2, ends: [0.006, 0.012] }, P.PANEL);
  s.mirrorCopy('x');
  const bridge: Vec2[] = [
    [-0.274, -0.02],
    [-0.274, 0.054],
    [-0.035, 0.092],
    [-0.035, -0.02],
  ];
  extrudePolygon(s, { outline: bridge, depth: 0.37, bevel: 0.012, bevelSegments: 2, bevelBack: true, facing: '+x', at: [-0.185, 0, 0] }, P.PANEL);
  roundedBox(s, { min: [-0.185, -0.02, 0.2], max: [0.185, 0.022, 0.262], radius: 0.01, segments: 1 }, P.PANEL);
  box(s, { min: [-0.18, -0.02, -0.06], max: [0.18, 0.034, 0.21] }, P.INTAKE);
  for (let k = 0; k < 3; k++) {
    const z = 0.035 + k * 0.066;
    roundedBox(s, { size: [0.37, 0.013, 0.046], radius: 0.005, segments: 1, rot: [15, 0, 0], at: [0, 0.1 - (z + 0.02) * slope - 0.018, z] }, P.LOUVRE);
  }
  const zs = 0.84;
  m.append(s, compose(rotation('x', 3.4), translation(0, hoodTop(zs), zs)));

  m.append(hood);
  m.append(slot, facingAt([0, 0.9, noseZ(0.9) - 0.004], NOSE_N));
  // Brow: a crisp ledge across the face above the lamps, one piece per
  // facet.
  roundedBox(m, { min: [-FOLD_X, -0.02, -0.03], max: [FOLD_X, 0.02, 0.028], radius: 0.009, segments: 1, at: facingAt(onFace(0, 0.985), faceNormal(0)) }, P.BODY);
  for (const side of [-1, 1]) {
    const w = (0.47 - FOLD_X) / Math.cos((RAKE_DEG * Math.PI) / 180);
    const x = side * (FOLD_X + (0.47 - FOLD_X) / 2);
    roundedBox(m, { min: [-w / 2 - 0.012, -0.02, -0.03], max: [w / 2 + 0.012, 0.02, 0.028], radius: 0.009, segments: 1, at: facingAt(onFace(x, 0.985), faceNormal(x)) }, P.BODY);
  }
  // Headlamps and bolts are placed ON the raked facets (aimed along each
  // facet's normal) rather than sheared with them: a shear tilts their
  // little bevels until corner normals face away from their faces.
  for (const side of [-1, 1]) {
    lampCell(m, { at: onFace(side * 0.405, 0.9, 0.027), dir: faceNormal(side * 0.405), width: 0.165, height: 0.105, wall: 0.013, depth: 0.06, bezel: P.BEZEL, glow: LAMP_GLOW, core: LAMP_HOT });
    for (const [x, y] of [
      [0.26, 1.025],
      [0.26, 0.78],
      [0.465, 1.015],
      [0.455, 0.79],
    ]) {
      rivet(m, onFace(side * x, y), faceNormal(side * x), 0.016);
    }
    // On the lamp block's steep sloping top: aimed along that slope's normal
    // so the head sits flush.
    rivet(m, [side * 0.32, hoodTop(1.53), 1.53], [0, 0.73, 0.68], 0.016);
  }
  for (const side of [-1, 1]) rivet(m, [side * 0.25, hoodTop(1.0), 1.0], [0, 1, 0], 0.016);
}

/** x of the folds between the nose's centre panel and its outer facets. */
const FOLD = 0.3;
/** How far the outer facets rake back in plan. */
const RAKE_DEG = 18;

/**
 * Shear the lamp block's outer thirds back so the nose reads as the sheet's
 * three facets (headlamps on the angled outer ones). A shear, not a model
 * of three panels: everything ahead of z 1.5 outboard of the fold moves back
 * in proportion to its distance from it, lamps and bolts included, so the
 * parts stay seated on their facet.
 */
const RAKE_K = Math.tan((RAKE_DEG * Math.PI) / 180);
const FOLD_X = FOLD + 0.008;
function rakeNose(m: SolidMesh): void {
  m.displace((p): Vec3 => {
    const ax = Math.abs(p.x);
    // Full rake on the face, fading out over the block's flank so no point
    // is ever carried back past one behind it.
    const f = Math.min(1, Math.max(0, (p.z - 1.46) / 0.12));
    return ax > FOLD_X ? [p.x, p.y, p.z - (ax - FOLD_X) * RAKE_K * f] : [p.x, p.y, p.z];
  });
}

/** A point on the (raked) nose face at (x, y), `out` meters proud of it. */
function onFace(x: number, y: number, out = 0): P3 {
  const n = faceNormal(x);
  const z = noseZ(y) - Math.max(0, Math.abs(x) - FOLD_X) * RAKE_K;
  return [x + n[0] * out, y + n[1] * out, z + n[2] * out];
}

/** Outward normal of the nose face at x: the centre panel's, or an outer
 * facet's, turned out by the rake. */
function faceNormal(x: number): P3 {
  const a = Math.abs(x) > FOLD_X ? (Math.sign(x) * RAKE_DEG * Math.PI) / 180 : 0;
  const l = Math.hypot(NOSE_RAKE, 1);
  return [Math.sin(a) / l, NOSE_RAKE / l, Math.cos(a) / l];
}

// ---------------------------------------------------------------------------
// Chassis: spine, tub, cockpit

function addChassis(m: SolidMesh, h: SolidMesh, l: RamLivery, P: Paints): void {
  // The spine under the hood and under the motor: wishbone pivots, steering
  // rack ends and the differential stubs are all sunk into its flanks.
  roundedBox(m, { min: [-0.235, FLOOR + 0.01, 0.5], max: [0.235, 1.0, 1.6], radius: 0.03, segments: 1 }, GUNMETAL);
  roundedBox(m, { min: [-0.235, FLOOR + 0.01, -1.64], max: [0.235, 0.84, -0.7], radius: 0.03, segments: 1 }, GUNMETAL);

  // Tub: the floor pan's underside is the car's ground clearance.
  addFloorPan(m, { min: [-0.62, -0.76], max: [0.62, 0.56], y: FLOOR });
  roundedBox(h, { min: [0.575, FLOOR + 0.02, -0.72], max: [0.645, 1.1, 0.53], radius: 0.02, segments: 1 }, P.DARK);
  roundedBox(m, { min: [-0.6, FLOOR + 0.02, 0.5], max: [0.6, 1.02, 0.56], radius: 0.015, segments: 1 }, P.DARK);
  roundedBox(m, { min: [-0.6, FLOOR + 0.02, -0.78], max: [0.6, 1.06, -0.7], radius: 0.02, segments: 1 }, P.DARK);
  // Seat riser and the two side consoles that fill the wide tub.
  roundedBox(m, { min: [-0.24, FLOOR + 0.02, -0.47], max: [0.24, SEAT[1] - 0.125, 0.07], radius: 0.03, segments: 1 }, P.DARK);
  roundedBox(h, { min: [0.35, FLOOR + 0.02, -0.69], max: [0.59, 0.78, 0.3], radius: 0.05, segments: 2 }, P.DARK);

  // Door frame: one thick cobalt plate per side — sill rail on top, post at
  // the cowl, a rear edge raked forward so the rear tire clears it.
  const frame: Vec2[] = [
    [0.54, 0.56],
    [0.54, 1.29],
    [0.42, 1.29],
    [0.38, 1.12],
    [-0.72, 1.12],
    [-0.72, 1.02],
    [-0.46, 0.56],
  ];
  extrudePolygon(h, { outline: frame, depth: 0.09, bevel: 0.024, bevelSegments: 3, facing: '+x', at: [0.645, 0, 0] }, P.BODY);
  // The orange side panel, standing 2 cm proud of the frame.
  const panelStart = h.mark();
  const panel: Vec2[] = [
    [0.44, 0.66],
    [0.42, 1.02],
    [-0.63, 1.02],
    [-0.43, 0.66],
  ];
  extrudePolygon(h, { outline: panel, depth: 0.03, bevel: 0.012, bevelSegments: 2, back: false, facing: '+x', at: [0.725, 0, 0] }, P.PANEL);
  // Paired stripes leaning back at the top (mirrored with the panel, so they
  // lean back on both flanks).
  const lean = -0.64;
  for (const [z, w] of l.sideStripes) {
    const y0 = 0.62;
    const y1 = 1.06;
    const at = (zz: number, y: number): Vec2 => [zz + (y - 0.66) * lean, y];
    paintDecal(h, { outline: [at(z, y0), at(z - w, y0), at(z - w, y1), at(z, y1)], facing: '+x', from: panelStart, only: (_c, n) => n.x > 0.9 }, P.STRIPE);
  }
  for (const [z, y] of [
    [0.385, 0.71],
    [0.37, 0.97],
    [0.1, 0.97],
    [-0.555, 0.97],
    [-0.41, 0.71],
  ]) {
    rivet(h, [0.755, y, z], [1, 0, 0]);
  }
  for (const z of [0.22, -0.2, -0.6]) rivet(h, [0.69, 1.12, z], [0, 1, 0]);
  rivet(h, [0.735, 1.19, 0.48], [1, 0, 0]);

  // Rock slider under each door: a bare tube from the tub's front corner to
  // its rear corner.
  tube(
    h,
    {
      path: [
        [0.52, 0.485, 0.47],
        [0.7, 0.485, 0.37],
        [0.7, 0.485, -0.4],
        [0.52, 0.485, -0.53],
      ],
      radius: 0.036,
      fillet: 0.08,
      sides: 10,
    },
    GUNMETAL,
  );

  // Cockpit.
  addPipedSeat(m, l);
  addDashboard(m, { at: [0, 1.17, 0.4], accent: l.panel });
  addSteeringColumn(m, { from: COLUMN_FROM, to: WHEEL });
  addPedals(m, { at: PEDALS });
}

/**
 * The stock bucket seat with the sheet's orange piping: the front rims of
 * the shoulder wings, the top of the headrest and a band along the outer
 * edge of each hip bolster. The seat is built at the origin so its back can
 * be un-reclined to find those faces in the back's own frame (see addSeat:
 * back placed by rotation('x', −recline) then translation(0, −0.04, −0.235);
 * its cushion face sits 0.118 ahead of the back's origin).
 */
/** Full-height bucket: its headrest tops out at about 1.6 m, behind the
 * driver's helmet, and fills the middle of the cage from front and rear. */
const SEAT_BACK = 0.86;

function addPipedSeat(m: SolidMesh, l: RamLivery): void {
  const seat = new SolidMesh();
  addSeat(seat, { at: [0, 0, 0], recline: RECLINE, accent: l.panel, backHeight: SEAT_BACK });
  const PIPE = paint(l.panel, { gloss: 0.35 });
  const a = (RECLINE * Math.PI) / 180;
  const unrecline = (y: number, z: number): [number, number] => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  seat.repaint((c, n) => {
    const [y, z] = unrecline(c.y + 0.04, c.z + 0.235);
    const [ny, nz] = unrecline(n.y, n.z);
    if (y < 0.05) return undefined;
    if (z > 0.118 + 0.055 && nz > 0.5 && Math.abs(c.x) > 0.12) return PIPE;
    if (y > SEAT_BACK - 0.02 && ny > 0.6) return PIPE;
    return undefined;
  });
  for (const side of [-1, 1]) {
    paintStripe(seat, { axis: 'x', min: side > 0 ? 0.222 : -0.248, max: side > 0 ? 0.248 : -0.222, only: (c, n) => n.y > 0.6 && c.y > 0.04 && c.y < 0.12 && c.z > -0.15 }, PIPE);
  }
  m.append(seat, translation(...SEAT));
}

// ---------------------------------------------------------------------------
// Fenders and shock towers

/** One station of a fender: [z, top height, x of the inner edge, x of the
 * outer edge, lip depth below the top]. */
type FenderStation = readonly [number, number, number, number, number];

/** Plate thickness and lip wall of the fenders. */
const FENDER_T = 0.07;
const LIP_W = 0.055;

/**
 * A toy fender: a folded orange PLATE swept fore-aft through `stations`.
 * Its front-view section is a thin slab from the inner edge out to a broad
 * bevel and a short down-turned outer lip, the inner edge chamfered down
 * toward the body. Inner and outer edges move per station, so the plan is
 * the sheet's hexagon (raked ends, an inner edge that angles in toward the
 * cowl); stations with a lower top give the side profile. The underside
 * is painted a shade darker, so from low angles it reads as a plate with
 * depth rather than a block.
 */
function fender(h: SolidMesh, stations: readonly FenderStation[], p: Paint, under: Paint): void {
  const ring = ([z, y, xi, xo, lip]: FenderStation): Vector3[] =>
    roundPoly(
      [
        [xi + 0.03, y, z],
        [xo - 0.05, y - 0.018, z],
        [xo, y - 0.06, z],
        [xo - 0.008, y - lip, z],
        [xo - LIP_W, y - lip, z],
        [xo - LIP_W, y - FENDER_T - 0.01, z],
        [xi, y - FENDER_T, z],
        [xi - 0.006, y - 0.03, z],
      ],
      0.014,
      2,
    );
  const s = h.mark();
  // (Every station keeps ≥ 5 cm of lip below the plate: a shorter lip wall
  // collapses its rounded corners and folds the end bevel.)
  panelSolid(h, stations.map(ring), { edge: 0.025, segs: 2, ends: [0.01, 0.01] }, p);
  h.repaint((_c, n) => (n.y < -0.6 ? under : undefined), s);
}

function addFenders(h: SolidMesh, l: RamLivery, P: Paints): void {
  const UNDER = paint(shade(l.panel, 0.62), { gloss: 0.5 });
  // Front: a hexagon over the rear half of the tire, its root landing on the
  // A-pillar's clamp block at the cowl and its inner edge angling out to
  // x 0.6 at the front — leaving cobalt hood shoulder and the coil-over in
  // the open between them.
  fender(
    h,
    [
      [0.56, 1.215, 0.5, 0.86, 0.125],
      [0.75, 1.37, 0.53, 0.96, 0.155],
      [1.17, 1.37, 0.6, 0.96, 0.155],
      [1.37, 1.245, 0.62, 0.88, 0.125],
    ],
    P.PANEL,
    UNDER,
  );
  // Rear: a longer drooping tail past the lamp pods; inner edge out at 0.55
  // (0.6 over the coil-over), chamfered down toward the body.
  fender(
    h,
    [
      [-0.745, 1.15, 0.55, 0.88, 0.125],
      [-0.93, 1.36, 0.55, 0.97, 0.155],
      [-1.2, 1.36, 0.6, 0.97, 0.155],
      [-1.4, 1.36, 0.6, 0.97, 0.155],
      [-1.6, 1.2, 0.62, 0.88, 0.125],
    ],
    P.PANEL,
    UNDER,
  );
  // Rivets: three along each lip's face, two on each plate's top corners.
  for (const z of [0.86, 1.0, 1.14]) rivet(h, [0.955, 1.255, z], [1, 0, 0]);
  for (const z of [-0.98, -1.16, -1.34]) rivet(h, [0.965, 1.245, z], [1, 0, 0]);
  for (const [x, z] of [
    [0.9, 0.8],
    [0.9, 1.13],
    [0.66, 1.13],
    [0.9, -0.98],
    [0.9, -1.36],
  ]) {
    rivet(h, [x, z > 0 ? 1.368 : 1.358, z], [0, 1, 0], 0.016);
  }

  // Front shock tower: a cobalt post rising out of the hood's flank and a
  // brace bar across the open gap to the fender's inner edge; the coil-over's
  // top eye hangs under the bar, in plain view beside the nose.
  roundedBox(h, { min: [0.33, 1.2, 1.11], max: [0.405, 1.405, 1.19], radius: 0.018, segments: 2 }, P.BODY);
  roundedBox(h, { min: [0.35, 1.37, 1.115], max: [0.64, 1.41, 1.185], radius: 0.016, segments: 2 }, P.BODY);
  for (const x of [0.375, 0.6]) rivet(h, [x, 1.41, 1.15], [0, 1, 0], 0.014);

  // Gusset tying the rear fender's front root to the top-rear corner of the
  // orange side panel, past the B-pillar's foot.
  const gusset: Vec2[] = [
    [-0.6, 0.99],
    [-0.6, 1.035],
    [-0.8, 1.2],
    [-0.87, 1.2],
    [-0.87, 1.12],
    [-0.73, 0.99],
  ];
  extrudePolygon(h, { outline: gusset, depth: 0.045, bevel: 0.012, bevelSegments: 2, bevelBack: true, facing: '+x', at: [0.725, 0, 0] }, P.PANEL);
  rivet(h, [0.77, 1.06, -0.72], [1, 0, 0]);
}

// ---------------------------------------------------------------------------
// Roll cage

function addCage(m: SolidMesh, h: SolidMesh, P: Paints): void {
  const r = TUBE;
  // One continuous perimeter tube: A-pillar, roof rail, rear stay, down to
  // the tail bumper and back up the other side.
  const right: P3[] = [A_FOOT, A_TOP, R_TOP, S_NODE, TAIL];
  addCageTube(m, { path: [...right, ...right.map(mirrorX).reverse()], radius: r, fillet: 0.12, sides: 12, collars: 'none' }, P.CAGE);
  // Straight tubes get intermediate rings: with vertices only at their two
  // (buried) ends the AO bake would shade a whole tube from its ends alone,
  // and B-pillars and harness bar came out black along their full length.
  const line = (a: P3, b: P3): Vector3[] => linePath(a, b, Math.max(2, Math.round(Vector3.Distance(new Vector3(...a), new Vector3(...b)) / 0.25)));
  // Cross tubes.
  addCageTube(m, { path: line(mirrorX(A_TOP), A_TOP), radius: r, sides: 14 }, P.CAGE);
  addCageTube(m, { path: line(mirrorX(R_TOP), R_TOP), radius: r, sides: 12, collars: 'none' }, P.CAGE);
  // B-pillar from the sill up to the roof rail; at waist height it carries
  // the harness bar and the waist rail back to the rear stay.
  const waist = lerp3(B_FOOT, B_TOP, (WAIST_Y - B_FOOT[1]) / (B_TOP[1] - B_FOOT[1]));
  addCageTube(h, { path: line(B_FOOT, B_TOP), radius: r, sides: 12, collars: 'none' }, P.CAGE);
  addCageTube(m, { path: line(mirrorX(waist), waist), radius: r, sides: 12, collars: 'none' }, P.CAGE);
  addCageTube(h, { path: line(waist, S_NODE), radius: r, sides: 12, collars: 'none' }, P.CAGE);
  // Diagonal that triangulates the rear bay.
  addCageTube(h, { path: line(B_TOP, S_NODE), radius: r * 0.9, sides: 12, collars: 'none' }, P.CAGE);
  // Joint nodes only a little fatter than the tube: a weld, not a ball.
  for (const node of [B_TOP, waist, S_NODE]) sphere(h, { radius: r * 1.18, segments: 12, rings: 6, at: node }, P.CAGE);

  // Orange clamps: a sleeve and a foot block where each A-pillar leaves the
  // cowl, and a bent sleeve wrapping each rear roof corner.
  const up = new Vector3(A_TOP[0] - A_FOOT[0], A_TOP[1] - A_FOOT[1], A_TOP[2] - A_FOOT[2]).normalize();
  const along = (d: number): P3 => [A_FOOT[0] + up.x * d, A_FOOT[1] + up.y * d, A_FOOT[2] + up.z * d];
  tube(h, { path: [along(0.06), along(0.3)], radius: r + 0.016, sides: 12 }, P.PANEL);
  taperBox(h, { y: [1.2, 1.36], bottom: [0.49, 0.675, 0.4, 0.57], top: [0.505, 0.655, 0.415, 0.55], corner: 0.03, edge: 0.02 }, P.PANEL);
  rivet(h, [0.668, 1.3, 0.485], [1, 0.1, 0]);
  const stay = new Vector3(S_NODE[0] - R_TOP[0], S_NODE[1] - R_TOP[1], S_NODE[2] - R_TOP[2]).normalize();
  tube(
    h,
    {
      // The forward leg stops short of where the rear-bay diagonal leaves
      // the roof rail, so the diagonal never pierces the sleeve.
      path: [[R_TOP[0], R_TOP[1], R_TOP[2] + 0.13], R_TOP, [R_TOP[0] + stay.x * 0.2, R_TOP[1] + stay.y * 0.2, R_TOP[2] + stay.z * 0.2]],
      radius: r + 0.016,
      fillet: 0.12,
      sides: 12,
    },
    P.PANEL,
  );
  rivet(h, [R_TOP[0] + r + 0.014, R_TOP[1], R_TOP[2] + 0.08], [1, 0, 0]);
  rivet(h, [R_TOP[0] + stay.x * 0.14 + r + 0.014, R_TOP[1] + stay.y * 0.14, R_TOP[2] + stay.z * 0.14], [1, 0, 0]);

  // Where the rear stay passes the fender's inner edge: an orange clamp
  // sleeve on the tube and a bolted tab out to the fender, which also
  // carries the rear coil-over's top eye (the eye hangs under it).
  const down = new Vector3(TAIL[0] - S_NODE[0], TAIL[1] - S_NODE[1], TAIL[2] - S_NODE[2]).normalize();
  const onStay = (d: number): P3 => [S_NODE[0] + down.x * d, S_NODE[1] + down.y * d, S_NODE[2] + down.z * d];
  const c = onStay(0.12);
  tube(h, { path: [onStay(0.05), onStay(0.2)], radius: r + 0.016, sides: 12 }, P.PANEL);
  roundedBox(h, { min: [c[0], 1.33, DAMPER_R[2] - 0.045], max: [0.65, 1.375, DAMPER_R[2] + 0.045], radius: 0.014, segments: 2 }, P.PANEL);
  for (const x of [0.5, 0.6]) rivet(h, [x, 1.375, DAMPER_R[2]], [0, 1, 0], 0.014);

  // Roof light: three warm cells in one housing, sitting on the header.
  const y = A_TOP[1] + 0.095;
  const z = A_TOP[2] + 0.04;
  // Dark housing (what makes the cells pop on the sheet), cobalt end caps.
  roundedBox(m, { min: [-0.36, y - 0.078, z - 0.05], max: [0.36, y + 0.078, z + 0.055], radius: 0.028, segments: 2 }, P.HOUSING);
  for (const side of [-1, 1]) {
    roundedBox(m, { min: [side > 0 ? 0.345 : -0.39, y - 0.086, z - 0.058], max: [side > 0 ? 0.39 : -0.345, y + 0.086, z + 0.063], radius: 0.022, segments: 2 }, P.BODY);
  }
  for (let k = -1; k <= 1; k++) {
    lampCell(m, { at: [k * 0.226, y, z + 0.072], dir: [0, 0, 1], width: 0.206, height: 0.116, wall: 0.016, depth: 0.04, bezel: CHARCOAL, glow: LAMP_GLOW, core: LAMP_HOT });
  }
}

// ---------------------------------------------------------------------------
// Tail: motor cover, grille, lamps, hitch

/** Pivot of the cooling fan behind the rear grille. */
export const FAN: P3 = [0, 1.02, -1.512];
export const FAN_RADIUS = 0.115;

function addTail(m: SolidMesh, h: SolidMesh, l: RamLivery, P: Paints): void {
  // Motor cover, kept below the waist rails so the cage outline stays clear.
  roundedBox(m, { min: [-0.265, 0.8, -1.47], max: [0.265, 1.25, -0.86], radius: 0.05, segments: 2 }, P.MOTOR);
  // Airbox behind the seat, with a filler cap on each flank.
  taperBox(m, { y: [1.2, 1.43], bottom: [-0.2, 0.2, -1.14, -0.8], top: [-0.165, 0.165, -1.11, -0.83], corner: 0.04, edge: 0.03 }, P.MOTOR);
  cylinder(h, { from: [0.17, 1.32, -0.97], to: [0.212, 1.32, -0.97], radius: 0.06, sides: 12, bevel: { top: 0.012 }, bevelSegments: 1, caps: 'top' }, CHARCOAL);
  cylinder(h, { from: [0.2, 1.32, -0.97], to: [0.222, 1.32, -0.97], radius: 0.03, sides: 8, bevel: { top: 0.006 }, bevelSegments: 1, caps: 'top' }, STEEL);
  // Cooling ribs on the deck.
  for (let k = -1; k <= 1; k++) roundedBox(m, { size: [0.04, 0.03, 0.2], radius: 0.01, segments: 1, at: [k * 0.1, 1.25, -1.31] }, P.SLAT);
  for (const side of [-1, 1]) rivet(m, [side * 0.22, 1.25, -0.93], [0, 1, 0], 0.013);

  // Rear grille: a frame with a real opening, four louvres across it, the
  // cooling fan (a spinner) turning behind them.
  extrudePolygon(m, { outline: roundedRectRing(0.46, 0.37, 0.05, 3), holes: [roundedRectRing(0.33, 0.25, 0.03, 3)], depth: 0.1, bevel: 0.014, bevelSegments: 2, back: false, facing: '-z', at: [0, 1.02, -1.47] }, P.MOTOR);
  box(m, { min: [-0.175, 0.89, -1.478], max: [0.175, 1.15, -1.46] }, paint('#1E1F26', { gloss: 0.25 }));
  for (let k = 0; k < 4; k++) {
    roundedBox(m, { size: [0.35, 0.014, 0.04], radius: 0.005, segments: 1, rot: [-28, 0, 0], at: [0, 0.935 + k * 0.057, -1.553] }, P.SLAT);
  }

  // Tail lamps: chunky pods either side of the grille, clamped on the rear
  // stays that pass through them; narrow enough that the upright coil-overs
  // stand clear outboard of them in the rear view.
  roundedBox(h, { min: [0.24, 0.9, -1.6], max: [0.465, 1.115, -1.42], radius: 0.035, segments: 2 }, P.MOTOR);
  lampCell(h, { at: [0.3525, 1.0075, -1.622], dir: [0, 0, -1], width: 0.175, height: 0.145, depth: 0.04, bezel: CHARCOAL, glow: LAMP_RED, core: paint('#FF7A5A', { emissive: 0.9, gloss: 0.9 }) });

  // Hitch plate under the tail bumper, with a tow hook.
  roundedBox(m, { min: [-0.15, 0.425, -1.7], max: [0.15, 0.6, -1.62], radius: 0.014, segments: 1 }, STEEL);
  // Tow shackle: a D-ring hanging from a lug on the plate.
  roundedBox(m, { size: [0.03, 0.05, 0.04], radius: 0.01, segments: 1, at: [0, 0.515, -1.705] }, STEEL);
  torus(m, { radius: 0.034, tube: 0.011, segments: 12, sides: 6, rot: [0, 0, 90], at: [0, 0.482, -1.7] }, paint(l.spring, { gloss: 0.7 }));
  // Finned differential cover on the spine's rear face, above the bumper.
  for (let k = 0; k < 3; k++) roundedBox(m, { size: [0.36, 0.026, 0.03], radius: 0.008, segments: 1, at: [0, 0.675 + k * 0.05, -1.642] }, P.SLAT);
  for (const side of [-1, 1]) rivet(m, [side * 0.11, 0.55, -1.7], [0, 0, -1], 0.014);
}

// ---------------------------------------------------------------------------
// Nose: bash plate, chin grille

function addNose(m: SolidMesh, h: SolidMesh, P: Paints): void {
  // Chin grille on the spine's front, between the two struts that carry the
  // bash plate.
  roundedBox(m, { min: [-0.26, 0.5, 1.56], max: [0.26, 0.75, 1.645], radius: 0.015, segments: 1 }, P.DARK);
  for (let k = 0; k < 4; k++) roundedBox(m, { size: [0.48, 0.022, 0.02], radius: 0.006, segments: 1, at: [0, 0.57 + k * 0.045, 1.648] }, P.SLAT);
  // Two cobalt struts splaying out from under the lamp block to the outer
  // thirds of the bash plate: an A-frame round the grille.
  taperBox(h, { y: [0.585, 0.77], bottom: [0.27, 0.35, 1.635, 1.705], top: [0.13, 0.21, 1.56, 1.62], corner: 0.018, edge: 0.015 }, P.BODY);
  // Lower mounting stub, behind the solid web between two cut-outs and
  // sunk into the plate's back.
  cylinder(h, { from: [0.2, 0.48, 1.58], to: [0.2, 0.48, 1.7], radius: 0.026, sides: 8 }, GUNMETAL);

  // Bash plate: a solid chamfered skid plate with FOUR equal trapezoid
  // cut-outs in a row (the brief overrules the turnaround's three) and
  // broad solid ends, two bolts each.
  const plate = new SolidMesh();
  const H = 0.125;
  const outline: Vec2[] = [
    [-0.54, H],
    [0.54, H],
    [0.575, H - 0.035],
    [0.575, 0.02],
    [0.47, -H],
    [-0.47, -H],
    [-0.575, 0.02],
    [-0.575, H - 0.035],
  ];
  // Drawn for the right half and mirrored (which also flips the winding,
  // as the triangulator wants for the left-hand holes).
  // (Webs of 6 cm between the holes: the bevel grows every hole by 2 cm on
  // the front face, and holes that meet there fold the cap.)
  const cut = (cx: number, dy: number): Vec2[] => [
    [cx - 0.07, 0.045 + dy],
    [cx + 0.07, 0.045 + dy],
    [cx + 0.047, -0.04 + dy],
    [cx - 0.047, -0.04 + dy],
  ];
  const flip = (ring: Vec2[]): Vec2[] => ring.map(([x, y]) => [-x, y] as const);
  const holes = [cut(0.1, 0), cut(0.3, 0.002)];
  const t = 0.05;
  const METAL = paint('#9CA0A9', { gloss: 0.5, metal: 0.6 });
  extrudePolygon(plate, { outline, holes: [...holes, ...[cut(0.1, 0.001), cut(0.3, 0.003)].map(flip)], depth: t, bevel: 0.012, bevelSegments: 2, bevelBack: true }, METAL);
  plate.translate([0, 0, -t]);
  // A top flange folded back toward the car: the plate has a visible top
  // face and depth, like a bumper.
  roundedBox(plate, { min: [-0.52, H - 0.032, -t - 0.085], max: [0.52, H, -t + 0.01], radius: 0.012, segments: 2 }, METAL);
  for (const side of [-1, 1]) {
    rivet(plate, [side * 0.46, 0.06, 0], [0, 0, 1], 0.018);
    rivet(plate, [side * 0.45, -0.055, 0], [0, 0, 1], 0.018);
  }
  m.append(plate, facingAt([0, 0.52, 1.728], [0, 0.22, 1]));
}

// ---------------------------------------------------------------------------

export function buildBody(l: RamLivery, gear: RunningGear): SolidMesh {
  const P: Paints = {
    BODY: paint(l.body, { gloss: 0.88 }),
    PANEL: paint(l.panel, { gloss: 0.88 }),
    STRIPE: paint(l.stripe, { gloss: 0.8 }),
    CAGE: paint(l.body, { gloss: 0.78 }),
    DARK: paint('#3C3E48', { gloss: 0.32 }),
    // Mid-dark grey, lighter than the seat, so louvres and bevels catch light.
    MOTOR: paint('#5C5F6B', { gloss: 0.38 }),
    SLAT: paint('#757886', { gloss: 0.5, metal: 0.4 }),
    LOUVRE: paint('#2A2B33', { gloss: 0.45 }),
    INTAKE: paint('#18191E', { gloss: 0.2 }),
    BEZEL: paint(shade(l.body, 0.35), { gloss: 0.6 }),
    HOUSING: paint('#2B2D36', { gloss: 0.55 }),
  };
  const m = new SolidMesh();
  const h = new SolidMesh();
  addHood(m, l, P);
  addChassis(m, h, l, P);
  addFenders(h, l, P);
  addCage(m, h, P);
  addTail(m, h, l, P);
  addNose(m, h, P);
  h.mirrorCopy('x');
  m.append(h);
  gear.addMounts(m);
  return m;
}
