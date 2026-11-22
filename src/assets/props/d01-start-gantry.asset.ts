import {
  SolidMesh,
  box,
  cylinder,
  extrudePolygon,
  frustum,
  jitterColor,
  mix,
  paint,
  rng,
  roundedBox,
  roundedRectRing,
  sphere,
} from '../../gfx/solid';
import type { Paint, RGB, Vec2 } from '../../gfx/solid';
import { BUILDING, STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { IRON, LAMP, LAMP_RIM, TRACK, checker, cloth } from './dressing-track-parts';

/**
 * Start / finish gantry over a 12 m road, in the village's own materials:
 * two chunky plaster pylons on coursed lavender stone plinths, with cream
 * collars, a raised panel on every face and a cap carrying a warm lamp ball;
 * a cream-and-timber truss between them; a teal/white checkered banner
 * hanging under the truss on short ties (it flutters: top edge pinned,
 * bottom edge free); a crest roundel, five start lights and two emblem
 * boards on the truss, modelled on both faces because cars pass under it;
 * and a hanging iron lantern on the front and back of each pylon.
 *
 * The road runs along z, the gantry spans x. CLEAR OPENING: 11.3 m between
 * the plinths, 3.4 m under the banner's lower edge at rest — about two cars
 * high. Overall about 7 m: as tall as the village hall, under the water
 * tower.
 *
 * Triangle budget: this is the one landmark of the track (a single instance
 * per world), so it is budgeted like a building, not like scatter dressing.
 */

const CLEAR_W = 11.3; // between the plinths
const PLINTH = 1.6; // plinth footprint, square
const PLINTH_TOP = 0.72;
const PEDESTAL = 1.36;
const PEDESTAL_TOP = 1.9;
const SHAFT = 1.1;
const PYLON_X = CLEAR_W / 2 + PLINTH / 2; // pylon centre line
const CLEAR_H = 3.4; // lower edge of the banner
const SQUARE = 0.45; // banner checker
const ROWS = 2;
const COLS = 22;
/** The banner hangs this far under the truss, so its top row is clear of
 * the chord's shadow and contact shading. */
const HANG = 0.22;
const TRUSS_Y0 = CLEAR_H + ROWS * SQUARE + HANG; // underside of the bottom chord
const CHORD = 0.22;
const WEB = 0.66;
const TRUSS_D = 0.42; // chord depth along the road
const TRUSS_Y1 = TRUSS_Y0 + CHORD + WEB + CHORD;
const SHAFT_TOP = TRUSS_Y1 + 0.24;
const SPAN = PYLON_X * 2 - SHAFT; // between the shafts' inner faces
const PANELS = 10;
const PANEL_T = 0.035; // shaft panel relief
const LANTERN_Y = 3.05; // centre of the lantern glass
const LANTERN_OUT = 0.2; // lantern axis off the shaft panel
const CAP_Y = SHAFT_TOP + 0.17;

function star(outer: number, inner: number, points = 5): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 === 0 ? outer : inner;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

/** Emblems as SEEN from the front (x right, y up), about 0.5 m tall. */
const BOLT: Vec2[] = [
  [0.17, 0.31],
  [-0.27, -0.08],
  [-0.03, -0.08],
  [-0.17, -0.31],
  [0.27, 0.08],
  [0.03, 0.08],
];
/** A slanted racing stripe, leaning forward. */
const SPEED_BAR = (dx: number, hh: number): Vec2[] => [
  [dx - 0.16, -hh],
  [dx + 0.03, -hh],
  [dx + 0.16, hh],
  [dx - 0.03, hh],
];
const DOUBLE_CHEVRON = (dx: number): Vec2[] => [
  [dx - 0.13, 0],
  [dx + 0.03, 0.22],
  [dx + 0.16, 0.22],
  [dx, 0],
  [dx + 0.16, -0.22],
  [dx + 0.03, -0.22],
];

interface Scheme {
  shaft: RGB;
  cap: RGB;
  boardL: RGB;
  boardR: RGB;
  crest: RGB;
}

const SCHEMES: Scheme[] = [
  { shaft: BUILDING.turquoise, cap: BUILDING.coral, boardL: BUILDING.cobalt, boardR: BUILDING.coral, crest: BUILDING.cobalt },
  { shaft: BUILDING.cobalt, cap: BUILDING.mustard, boardL: BUILDING.coral, boardR: BUILDING.turquoise, crest: BUILDING.coral },
  { shaft: BUILDING.coral, cap: BUILDING.turquoise, boardL: BUILDING.turquoise, boardR: BUILDING.cobalt, crest: BUILDING.turquoise },
  { shaft: BUILDING.mustard, cap: BUILDING.cobalt, boardL: BUILDING.cobalt, boardR: BUILDING.coral, crest: BUILDING.cobalt },
];

/** A flat emblem on both faces of something `depth` thick, readable from
 * either side (each face gets the outline as seen from its own front). */
function emblemBothSides(m: SolidMesh, outline: Vec2[], x: number, y: number, halfDepth: number, p: Paint): void {
  extrudePolygon(m, { outline, depth: 0.03, back: false, facing: '-z', at: [x, y, -halfDepth] }, p);
  extrudePolygon(m, { outline, depth: 0.03, back: false, facing: '+z', at: [x, y, halfDepth] }, p);
}

/** Square pyramid frustum standing on y0 (kit frusta take the half DIAGONAL). */
function pyramid(m: SolidMesh, x: number, z: number, y0: number, y1: number, half0: number, half1: number, p: Paint, caps: boolean | 'top' | 'bottom' = true): void {
  frustum(m, { radiusBottom: half0 * Math.SQRT2, radiusTop: half1 * Math.SQRT2, from: [x, y0, z], to: [x, y1, z], sides: 4, round: false, arcStart: 45, caps }, p);
}

/**
 * Hanging lantern as on the vision's shop fronts: iron wall plate and arm,
 * pitched hood, amber glass between four corner bars, a small base. `sz` is
 * the side of the pylon it hangs on, `wall` the surface it is fixed to.
 */
function lantern(m: SolidMesh, x: number, wall: number, sz: number): void {
  const zc = wall + sz * LANTERN_OUT;
  const y = LANTERN_Y;
  const g = 0.15; // half width of the glass
  const gh = 0.2; // half height of the glass
  // Wall plate (its hidden back face left out) and the arm out to the hook.
  const hidden: 'pz' | 'nz' = sz > 0 ? 'nz' : 'pz';
  box(m, { min: [x - 0.09, y + 0.3, Math.min(wall, wall + sz * 0.04)], max: [x + 0.09, y + 0.66, Math.max(wall, wall + sz * 0.04)], faces: { [hidden]: null } }, IRON);
  box(m, { min: [x - 0.035, y + 0.5, Math.min(wall, zc + sz * 0.05)], max: [x + 0.035, y + 0.57, Math.max(wall, zc + sz * 0.05)], faces: { [hidden]: null } }, IRON);
  box(m, { min: [x - 0.025, y + gh + 0.16, zc - 0.025], max: [x + 0.025, y + 0.52, zc + 0.025], faces: { py: null, ny: null } }, IRON);
  // Hood, overhanging the glass.
  pyramid(m, x, zc, y + gh - 0.01, y + gh + 0.19, g + 0.07, 0.05, IRON);
  // Glass: four panes, top and bottom are inside the hood and the base.
  box(m, { size: [g * 2, gh * 2, g * 2], at: [x, y, zc], faces: { py: null, ny: null } }, LAMP);
  for (const cx of [-1, 1]) {
    for (const cz of [-1, 1]) {
      box(m, { size: [0.04, gh * 2, 0.04], at: [x + cx * g, y, zc + cz * g], faces: { py: null, ny: null } }, IRON);
    }
  }
  // Base: an upside-down pyramid stub.
  pyramid(m, x, zc, y - gh - 0.09, y - gh + 0.01, 0.07, g + 0.04, IRON);
}

function build(seed: number): SolidMesh {
  const r = rng(seed, 'start-gantry');
  const hero = seed === 0;
  const S = SCHEMES[seed % SCHEMES.length];
  const tint = (c: RGB): RGB => (hero ? c : jitterColor(r, c, { hue: 3, lightness: 0.02 }));

  const shaft = tint(S.shaft);
  const PLASTER = paint(shaft, { gloss: 0.3 });
  const PANEL = paint(mix(shaft, BUILDING.cream, 0.36), { gloss: 0.3 });
  const CREAM = paint(BUILDING.cream, { gloss: 0.35 });
  const CAP = paint(tint(S.cap), { gloss: 0.5 });
  const TIMBER = paint(BUILDING.timber, { gloss: 0.25 });
  // A ball of glass: deep orange, so its glow lands on amber, not lemon.
  const GLOBE = paint(TRACK.lamp, { gloss: 0.6, emissive: 0.55 });
  const TEAL = paint(TRACK.teal, { gloss: 0.25 });
  const WHITE = paint(TRACK.white, { gloss: 0.25 });
  const MORTAR = paint(STONE.shadow, { gloss: 0.05 });

  const m = new SolidMesh();

  // --- pylons -----------------------------------------------------------
  // Three tiers, each narrower than the one below: stone plinth, a stout
  // pedestal, the shaft. Every joint is hidden under a cream collar.
  for (const sx of [-1, 1]) {
    const x = sx * PYLON_X;

    // Plinth: two courses of two cut stones each, the joints turned 90°
    // from course to course, round a dark core that shows in the joints.
    const hp = PLINTH / 2;
    box(m, { min: [x - hp + 0.07, -0.05, -hp + 0.07], max: [x + hp - 0.07, PLINTH_TOP - 0.04, hp - 0.07], faces: { ny: null } }, MORTAR);
    const J = 0.014; // half a joint
    const yMid = 0.345;
    const cutA = (hero ? 0.16 : r.range(-0.2, 0.2)) * sx; // lower course, split across x
    const cutB = hero ? -0.12 : r.range(-0.2, 0.2); // upper course, split across z
    const stone = (min: [number, number, number], max: [number, number, number], k: number, top: boolean): void => {
      const c = jitterColor(r.fork(`stone${sx}${k}`), [STONE.base, STONE.midSlate, STONE.midSlate, STONE.base][k], { lightness: 0.025, hue: 3 });
      // Faceted like the rocks; the top course's upper faces catch the sun.
      const p = paint(c, { gloss: 0.08, smooth: 0 });
      const lit = paint(mix(c, STONE.upperFace, 0.45), { gloss: 0.08, smooth: 0 });
      roundedBox(m, { min, max, radius: 0.085, segments: 1, faces: { ny: null, py: top ? lit : p } }, p);
    };
    stone([x - hp, -0.05, -hp], [x + cutA - J, yMid - J, hp], 0, false);
    stone([x + cutA + J, -0.05, -hp], [x + hp, yMid - J, hp], 1, false);
    stone([x - hp, yMid + J, -hp], [x + hp, PLINTH_TOP, cutB - J], 2, true);
    stone([x - hp, yMid + J, cutB + J], [x + hp, PLINTH_TOP, hp], 3, true);

    const tier = (w: number, y0: number, y1: number, radius: number): void => {
      roundedBox(m, { min: [x - w / 2, y0, -w / 2], max: [x + w / 2, y1, w / 2], radius, segments: 2, faces: { ny: null, py: null } }, PLASTER);
    };
    const collar = (y: number, h: number, w: number): void => {
      roundedBox(m, { size: [w, h, w], radius: 0.08, segments: 2, at: [x, y, 0] }, CREAM);
    };
    tier(PEDESTAL, PLINTH_TOP - 0.12, PEDESTAL_TOP, 0.1);
    tier(SHAFT, PEDESTAL_TOP - 0.1, SHAFT_TOP, 0.09);
    collar(PEDESTAL_TOP, 0.28, PEDESTAL + 0.2);
    const midCollar = TRUSS_Y0 - 0.32;
    collar(midCollar, 0.2, SHAFT + 0.16);
    collar(SHAFT_TOP + 0.04, 0.3, SHAFT + 0.36);

    // A raised, lighter panel on each face of the shaft between the collars.
    const p0 = PEDESTAL_TOP + 0.28;
    const p1 = midCollar - 0.24;
    const panel = roundedRectRing(SHAFT - 0.36, p1 - p0, 0.13, 2);
    const pc = (p0 + p1) / 2;
    const hs = SHAFT / 2;
    extrudePolygon(m, { outline: panel, depth: PANEL_T, back: false, facing: '-z', at: [x, pc, -hs] }, PANEL);
    extrudePolygon(m, { outline: panel, depth: PANEL_T, back: false, facing: '+z', at: [x, pc, hs] }, PANEL);
    extrudePolygon(m, { outline: panel, depth: PANEL_T, back: false, facing: '-x', at: [x - hs, pc, 0] }, PANEL);
    extrudePolygon(m, { outline: panel, depth: PANEL_T, back: false, facing: '+x', at: [x + hs, pc, 0] }, PANEL);
    for (const sz of [-1, 1]) lantern(m, x, sz * (hs + PANEL_T), sz);

    // Cap (its shape is the seed's silhouette change), iron neck, lamp ball.
    const hc = (SHAFT + 0.22) / 2;
    let neck = CAP_Y;
    switch (seed % 4) {
      case 1: // low dome
        sphere(m, { radii: [hc, 0.5, hc], segments: 14, rings: 10, latitude: [0, 90], caps: false, at: [x, CAP_Y, 0] }, CAP);
        neck += 0.48;
        break;
      case 2: // steep spire
        pyramid(m, x, 0, CAP_Y, CAP_Y + 0.95, hc, 0.13, CAP, 'top');
        neck += 0.95;
        break;
      case 3: // stepped
        roundedBox(m, { min: [x - hc + 0.05, CAP_Y - 0.02, -hc + 0.05], max: [x + hc - 0.05, CAP_Y + 0.2, hc - 0.05], radius: 0.05, segments: 1, faces: { ny: null } }, CAP);
        pyramid(m, x, 0, CAP_Y + 0.2, CAP_Y + 0.56, hc - 0.2, 0.16, CAP, 'top');
        neck += 0.56;
        break;
      default: // pyramid
        pyramid(m, x, 0, CAP_Y, CAP_Y + 0.55, hc, 0.16, CAP, 'top');
        neck += 0.55;
    }
    cylinder(m, { from: [x, neck - 0.05, 0], to: [x, neck + 0.12, 0], radius: 0.115, sides: 10, caps: false }, IRON);
    cylinder(m, { from: [x, neck + 0.08, 0], to: [x, neck + 0.14, 0], radius: 0.15, sides: 10, bevel: 0.02, bevelSegments: 1 }, LAMP_RIM);
    sphere(m, { radius: 0.23, segments: 12, rings: 7, at: [x, neck + 0.31, 0] }, GLOBE);
  }

  // --- truss ------------------------------------------------------------
  const chordLen = SPAN + 0.3; // ends sunk into the shafts
  for (const y of [TRUSS_Y0 + CHORD / 2, TRUSS_Y1 - CHORD / 2]) {
    roundedBox(m, { size: [chordLen, CHORD, TRUSS_D], radius: 0.055, segments: 2, at: [0, y, 0], faces: { px: null, nx: null } }, CREAM);
  }
  const webY = TRUSS_Y0 + CHORD + WEB / 2;
  const pw = SPAN / PANELS;
  const diagLen = Math.hypot(pw, WEB) + 0.05;
  const diagDeg = (Math.atan2(WEB, pw) * 180) / Math.PI;
  for (let i = 1; i < PANELS; i++) {
    box(m, { size: [0.15, WEB + 0.08, 0.28], at: [-SPAN / 2 + i * pw, webY, 0], faces: { py: null, ny: null } }, TIMBER);
  }
  for (let i = 0; i < PANELS; i++) {
    // Zig-zag that mirrors about the centre. Thinner than the posts so the
    // two never share a face plane.
    const up = i < PANELS / 2 ? i % 2 === 0 : i % 2 === 1;
    box(m, { size: [diagLen, 0.12, 0.19], rot: [0, 0, up ? diagDeg : -diagDeg], at: [-SPAN / 2 + (i + 0.5) * pw, webY, 0], }, TIMBER);
  }

  // --- start lights: five warm lamps in an iron housing on each face of
  // the bottom chord, under the crest ------------------------------------
  const lightY = TRUSS_Y0 + CHORD / 2;
  for (const sz of [-1, 1]) {
    const face = sz * (TRUSS_D / 2 + 0.09);
    // Closed all round: it is taller than the chord, so its back shows
    // above and below the chord's rounded edges.
    roundedBox(m, { min: [-1.1, lightY - 0.17, Math.min(face, face - sz * 0.13)], max: [1.1, lightY + 0.17, Math.max(face, face - sz * 0.13)], radius: 0.04, segments: 1 }, IRON);
    for (let i = -2; i <= 2; i++) {
      // A shallow glass dome with a darker amber bezel: the cut of a sphere
      // whose pole points out of the housing.
      const R = 0.135;
      const cut = 36;
      sphere(
        m,
        { radius: R, segments: 12, rings: 7, latitude: [cut, 90], caps: false, rot: [sz * 90, 0, 0], at: [i * 0.41, lightY, face - sz * R * Math.sin((cut * Math.PI) / 180)] },
        (band) => (band === 0 ? LAMP_RIM : LAMP),
      );
    }
  }

  // --- checkered banner under the truss ----------------------------------
  const ripple = hero ? 0 : r.range(0, 6.28);
  const bannerTop = TRUSS_Y0 - HANG;
  cloth(m, {
    origin: [(-COLS * SQUARE) / 2, bannerTop, 0],
    u: [1, 0, 0],
    v: [0, -1, 0],
    n: [0, 0, -1],
    cols: COLS,
    rows: ROWS,
    cell: [SQUARE, SQUARE],
    // Long ripples only: anything shorter than four squares would alias on
    // a grid of one point per square and zig-zag the hem.
    wave: (s, t) => t * (0.065 * Math.sin(s * 17 + ripple) + 0.025 * Math.sin(s * 29 + 1.3 + ripple)),
    paint: checker(TEAL, WHITE, seed % 2),
    thickness: 0.03,
    wind: (_s, t) => t,
  });
  // The banner's top hem is laced to an iron rail that hangs from the chord
  // on short straps.
  const railY = bannerTop + 0.01;
  cylinder(m, { from: [(-COLS * SQUARE) / 2 - 0.12, railY, 0], to: [(COLS * SQUARE) / 2 + 0.12, railY, 0], radius: 0.035, sides: 6 }, IRON);
  for (let i = -3; i <= 3; i++) {
    box(m, { min: [i * 1.6 - 0.04, railY - 0.02, -0.05], max: [i * 1.6 + 0.04, TRUSS_Y0 + 0.04, 0.05], faces: { py: null, ny: null } }, IRON);
  }

  // --- crest and emblem boards (both faces) ------------------------------
  const crestY = TRUSS_Y1 + 0.02;
  const crestZ = TRUSS_D / 2 + 0.08;
  cylinder(m, { from: [0, crestY, -crestZ], to: [0, crestY, crestZ], radius: 0.86, sides: 30, bevel: 0.055, bevelSegments: 2 }, CREAM);
  cylinder(m, { from: [0, crestY, -crestZ - 0.02], to: [0, crestY, crestZ + 0.02], radius: 0.68, sides: 30 }, paint(tint(S.crest), { gloss: 0.45 }));
  emblemBothSides(m, star(0.54, 0.24), 0, crestY - 0.015, crestZ + 0.02, paint(TRACK.chevron, { gloss: 0.55 }));

  const boardY = webY;
  const boardZ = TRUSS_D / 2 + 0.05;
  const boards: { x: number; color: RGB; emblem: Vec2[][]; ink: RGB }[] = [
    { x: -3.0, color: S.boardL, emblem: [BOLT], ink: TRACK.chevron },
    { x: 3.0, color: S.boardR, emblem: [SPEED_BAR(-0.34, 0.22), SPEED_BAR(0, 0.27), SPEED_BAR(0.34, 0.22)], ink: BUILDING.cream },
  ];
  if (seed % 2 === 1) boards[1].emblem = [DOUBLE_CHEVRON(-0.17), DOUBLE_CHEVRON(0.13)];
  if (seed % 4 >= 2) boards[0].emblem = [star(0.28, 0.125)];
  for (const b of boards) {
    roundedBox(m, { size: [2.3, 0.9, boardZ * 2], radius: 0.09, segments: 2, at: [b.x, boardY, 0] }, CREAM);
    extrudePolygon(m, { outline: roundedRectRing(2.06, 0.66, 0.07, 2), depth: boardZ * 2 + 0.036, centered: true, at: [b.x, boardY, 0] }, paint(tint(b.color), { gloss: 0.45 }));
    for (const e of b.emblem) emblemBothSides(m, e, b.x, boardY, boardZ + 0.018, paint(b.ink, { gloss: 0.5 }));
  }
  return m;
}

function colliders(): ColliderSpec[] {
  const half = SHAFT_TOP / 2;
  return [
    { shape: 'box', center: [-PYLON_X, half, 0], half: [PLINTH / 2, half, PLINTH / 2] },
    { shape: 'box', center: [PYLON_X, half, 0], half: [PLINTH / 2, half, PLINTH / 2] },
    { shape: 'box', center: [0, (TRUSS_Y0 + TRUSS_Y1) / 2, 0], half: [SPAN / 2, (TRUSS_Y1 - TRUSS_Y0) / 2, TRUSS_D / 2 + 0.1] },
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd01-start-gantry',
  name: 'Start / finish gantry',
  category: 'dressing',
  // Depth is over the lanterns; the plinths are 1.6 m square.
  size: { x: PYLON_X * 2 + PLINTH, y: 7.15, z: 2.0 },
  variants: 4,
  wind: true,
  triBudget: 5000,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders,
  build,
};

export default asset;
