import { SolidMesh, cylinder, darken, hex, loft, mix, paint, ringXY, roundedBox, roundedRectRing, sphere, tube } from '../../gfx/solid';
import type { RGB } from '../../gfx/solid';
import { BUILDING, FOLIAGE, REEF_ROCKET } from '../palette';
import type { CarAsset, CarGeometry, CarSpec } from '../types';
import {
  CHARCOAL,
  CHROME,
  GUNMETAL,
  STEEL,
  addBolt,
  addCageTube,
  addDashboard,
  addPedals,
  addSteeringColumn,
  buildDriver,
  buildRim,
  buildRunningGear,
  buildSteeringWheel,
  buildTire,
  columnAxis,
  fanSpinner,
} from './parts';
import type { P3, RunningGear, SuspensionOptions, TreadPattern } from './parts';
import { ROTOR_SETBACK, addFanDrum, buildReefRotor } from './reef-rocket/fans';
import { COCKPIT, addFenders, addHood, addTub, cabinFloor, hullSide, hullTop } from './reef-rocket/shell';
import type { ShellPaints } from './reef-rocket/shell';
import { LAMP_BEZEL, LAMP_LENS, addFrontFenders } from './reef-rocket/front';
import { addReefBashPlate, addReefTailLamp } from './reef-rocket/hardware';
import { addReefSeat } from './reef-rocket/seat';

/**
 * REEF ROCKET — the rounded turquoise beach buggy with the twin fan drums.
 *
 * Sheet:  design-documents/buggy-design-pack/reef-rocket/turnaround.png
 * Brief:  design-documents/buggy-design-pack/reef-rocket/modeling-brief.txt
 *
 * The shell (hood, tub, fenders, lamp pods, graphics) is in
 * `reef-rocket/shell.ts`, the fan drums in `reef-rocket/fans.ts`; this file
 * holds the spec, the hard points, the liveries, and everything bolted on.
 *
 * Review:  /asset-lab.html?asset=reef-rocket&view=hero&yaw=215&pitch=18
 */

const SPEC: CarSpec = {
  length: 3.35, // front overhang 0.65 + wheelbase 2.2 + rear overhang 0.5
  width: 2.05,
  height: 1.95, // top of the fan drums
  wheelbase: 2.2,
  frontTrack: 1.69,
  rearTrack: 1.61,
  frontTireRadius: 0.38,
  rearTireRadius: 0.47,
  frontTireWidth: 0.36,
  rearTireWidth: 0.44,
  groundClearance: 0.32,
};

const AXLE_F = SPEC.wheelbase / 2;
const AXLE_R = -SPEC.wheelbase / 2;
/** The spec's overhangs differ: the bumper is the front extreme, the tail of
 * the tub the rear one. */
const FRONT_END = AXLE_F + 0.65;

// ---------------------------------------------------------------------------
// Hard points

/** Hip point. The seat stands on a riser: this toy sits high in its tub. */
const SEAT: P3 = [0, 0.6, -0.36];
const RECLINE = 14;
const DRIVER_SCALE = 1.08;
const WHEEL: P3 = [0, 0.99, 0.1];
/** The column leaves the cockpit's front wall under the dashboard. */
const COLUMN_FROM: P3 = [0, 0.8, COCKPIT.front - 0.004];
const WHEEL_AXIS = columnAxis(COLUMN_FROM, WHEEL);
const WHEEL_RADIUS = 0.19;
const PEDALS: P3 = [0, 0.375, 0.36];

/** Cage tube radius. The spec says Ø 60 mm; the sheet draws the cage about
 * half as fat again, and at toy scale the fat tube is what reads. */
const TUBE = 0.038;
const ROOF_Y = 1.71;
const ROOF_X = 0.415;

/** Fan drums: axis height puts the drum's top on the spec height. The rotor
 * is 70 % of the drum's radius, which leaves the fat rolled lips the sheet
 * draws round a dark fan face. */
const FAN = { x: 0.275, y: 1.7, z: -1.11, rotor: 0.172, outer: 0.245, length: 0.46 };

/** Coil-over tops: on brackets on the body's flank, under the fenders.
 * Chunky toy hardware, as on the sheet: fat arms in light metal, fat coils
 * (the arms' legs are spread wider so the fat front coil passes between
 * them). */
const SUSPENSION: SuspensionOptions = {
  front: { damperTop: [0.38, 0.84, AXLE_F], coilRadius: 0.062, armSpread: 0.42 },
  rear: { damperTop: [0.36, 0.83, AXLE_R], coilRadius: 0.07, armSpread: 0.42 },
  armRadius: 0.026,
  armColor: paint('#9EA2AA', { gloss: 0.6, metal: 0.7 }),
};

/** Balloon tires with ordered V lugs (the sheet and the concept): two
 * staggered rows sweeping out from the centre line, ending AT the shoulder —
 * no bars down the sidewall, which would draw a cog in side view. */
const TREAD: TreadPattern = {
  pitch: 0.18,
  bars: [
    { halfWidth: 0.3, path: [[0, -0.06], [0.4, -0.62], [0.46, -1.02]] },
    { halfWidth: 0.3, path: [[0.5, 0.06], [0.9, 0.62], [0.96, 1.02]] },
  ],
};

// ---------------------------------------------------------------------------
// Liveries: colours only, never shape.

interface Livery {
  /** Shown in the game menu's paint picker. */
  name: string;
  body: RGB;
  cage: RGB;
  trim: RGB;
  /** The wave's body and the fender flashes. */
  accent: RGB;
  glow: RGB;
  seat: RGB;
}

const LAVENDER = hex('#9C8FE0');

const LIVERIES: Livery[] = [
  // 0 — the sheet.
  { name: 'Reef', body: REEF_ROCKET.bodyTurquoise, cage: REEF_ROCKET.cageCoral, trim: REEF_ROCKET.trimCream, accent: REEF_ROCKET.cageCoral, glow: REEF_ROCKET.emissionCyan, seat: REEF_ROCKET.cageCoral },
  // 1 — "Sunset": coral shell, cobalt cage, turquoise wave.
  { name: 'Sunset', body: REEF_ROCKET.cageCoral, cage: BUILDING.cobalt, trim: REEF_ROCKET.trimCream, accent: REEF_ROCKET.bodyTurquoise, glow: REEF_ROCKET.emissionCyan, seat: BUILDING.cobalt },
  // 2 — "Kelp": jade shell, ochre cage, lime wave.
  { name: 'Kelp', body: FOLIAGE.jade, cage: BUILDING.mustard, trim: REEF_ROCKET.trimCream, accent: FOLIAGE.lime, glow: FOLIAGE.highlight, seat: BUILDING.mustard },
  // 3 — "Dusk": lavender shell, cobalt cage, ochre wave.
  { name: 'Dusk', body: LAVENDER, cage: BUILDING.cobalt, trim: REEF_ROCKET.trimCream, accent: BUILDING.mustard, glow: REEF_ROCKET.emissionCyan, seat: BUILDING.coral },
];

// ---------------------------------------------------------------------------
// Body

function buildBody(l: Livery, gear: RunningGear): SolidMesh {
  const BODY = paint(l.body, { gloss: 0.88, smooth: 60 });
  const TRIM = paint(l.trim, { gloss: 0.8, smooth: 60 });
  const ACCENT = paint(l.accent, { gloss: 0.85, smooth: 60 });
  const CAGE = paint(l.cage, { gloss: 0.7 });
  const INTERIOR = paint('#33343C', { gloss: 0.3, smooth: 60 });
  const UNDER = paint(darken(l.body, 0.45), { gloss: 0.3, smooth: 60 });
  const P: ShellPaints = { body: BODY, trim: TRIM, accent: ACCENT, interior: INTERIOR, under: UNDER };
  const m = new SolidMesh();

  // --- shell ---------------------------------------------------------------
  addTub(m, P, paint('#2B2C33', { gloss: 0.4 }));
  addHood(m, P);
  addFenders(m, P);
  addFrontFenders(m, P, LAMP_LENS, LAMP_BEZEL);

  // --- undertray and chassis -------------------------------------------------
  // The skid plates are the lowest sprung faces: exactly the spec clearance.
  const floor = SPEC.groundClearance;
  roundedBox(m, { min: [-0.43, floor, -0.44], max: [0.43, floor + 0.03, 0.64], radius: 0.012, segments: 1 }, GUNMETAL);
  roundedBox(m, { min: [-0.16, floor, 0.6], max: [0.16, floor + 0.03, 1.44], radius: 0.012, segments: 1 }, GUNMETAL);
  // Rear transaxle case: carries the rear wishbone pivots.
  roundedBox(m, { min: [-0.155, floor + 0.01, -1.42], max: [0.155, 0.64, -0.6], radius: 0.05, segments: 2 }, GUNMETAL);
  for (const s of [-1, 1]) {
    // V braces from the tail down to the case: the light-grey frame V of
    // the sheet's rear view.
    tube(m, { path: [[s * 0.3, 0.9, -1.28], [s * 0.1, 0.6, -1.4]], radius: 0.03, sides: 10 }, STEEL);
    tube(m, { path: [[s * 0.42, 0.86, -0.9], [s * 0.12, 0.6, -0.8]], radius: 0.03, sides: 10 }, STEEL);
  }
  addReefBashPlate(m, { at: [0, 0.5, -1.45], normal: [0, -0.15, -1], width: 0.36, height: 0.15, holes: 3 });
  gear.addMounts(m, { bolts: false });

  // --- nose: bumper hoop, grille, bash plate ---------------------------------
  const bz = FRONT_END - 0.035;
  addCageTube(
    m,
    { path: [[-0.2, 0.45, 1.4], [-0.36, 0.45, 1.56], [-0.36, 0.45, bz], [-0.36, 0.67, bz], [0.36, 0.67, bz], [0.36, 0.45, bz], [0.36, 0.45, 1.56], [0.2, 0.45, 1.4]], radius: 0.034, fillet: 0.09, sides: 12, collars: 'none' },
    paint(l.trim, { gloss: 0.75 }),
  );
  // Chin: the grille's housing is part of the painted nose, a soft lofted
  // pod whose top sinks into the hood's keel; only the panel let into its
  // face is dark.
  const chin = (z: number, w: number, h: number, cy: number): ReturnType<typeof ringXY> => ringXY(roundedRectRing(w, h, Math.min(0.1, h * 0.42), 3), z, 0, cy);
  loft(m, { rings: [chin(1.4, 0.5, 0.24, 0.53), chin(1.5, 0.6, 0.31, 0.505), chin(1.6, 0.6, 0.32, 0.505), chin(1.638, 0.575, 0.3, 0.505), chin(1.652, 0.53, 0.27, 0.505)], subdivisions: 1, caps: true }, BODY);
  roundedBox(m, { min: [-0.22, 0.4, 1.625], max: [0.22, 0.615, 1.66], radius: 0.014, segments: 1 }, CHARCOAL);
  for (let k = -3; k < 3; k++) roundedBox(m, { min: [(k + 0.5) * 0.064 - 0.013, 0.43, 1.645], max: [(k + 0.5) * 0.064 + 0.013, 0.6, 1.672], radius: 0.006, segments: 1 }, GUNMETAL);
  addReefBashPlate(m, { at: [0, 0.415, 1.705], normal: [0, -0.2, 1], width: 0.58, height: 0.17, holes: 3 });

  // --- cockpit ---------------------------------------------------------------
  roundedBox(m, { min: [-0.3, cabinFloor(0) - 0.01, SEAT[2] - 0.2], max: [0.3, SEAT[1] - 0.12, SEAT[2] + 0.32], radius: 0.03, segments: 1 }, CHARCOAL);
  addReefSeat(m, { at: SEAT, recline: RECLINE, width: 0.56, backHeight: 0.85, shell: paint(l.trim, { gloss: 0.55, smooth: 60 }), cushion: paint(l.seat, { gloss: 0.25, smooth: 60 }), bolster: paint(darken(l.seat, 0.12), { gloss: 0.25, smooth: 60 }), harness: paint('#34343C', { gloss: 0.25 }) });
  addDashboard(m, { at: [0, 1.02, COCKPIT.front - 0.06], accent: l.cage });
  addSteeringColumn(m, { from: COLUMN_FROM, to: WHEEL });
  addPedals(m, { at: PEDALS });
  // Power unit behind the seat, filling the back of the opening.
  roundedBox(m, { min: [-0.36, 0.6, COCKPIT.rear - 0.03], max: [0.36, 1.06, -0.76], radius: 0.05, segments: 2 }, CHARCOAL);
  for (const s of [-1, 1]) {
    cylinder(m, { from: [s * 0.06, 1.1, -0.88], to: [s * 0.32, 1.1, -0.88], radius: 0.065, sides: 14, bevel: 0.015 }, CAGE);
    cylinder(m, { from: [s * 0.32, 1.1, -0.88], to: [s * 0.345, 1.1, -0.88], radius: 0.04, sides: 10 }, STEEL);
  }

  // --- cage ------------------------------------------------------------------
  const r = TUBE;
  const footA: P3 = [0.5, hullTop(0.5, 0.63) - 0.05, 0.63];
  // The rear stays splay outboard on their way down to the rear fender
  // crowns, so they pass under the outer edge of the fan drums: that lets
  // the drums sit right behind the roof's rear bend, as on the sheet.
  const footR: P3 = [0.6, 1.24, -1.08];
  for (const s of [-1, 1]) {
    // A-pillar, roof rail and rear stay in one bent tube.
    addCageTube(m, { path: [[s * footA[0], footA[1], footA[2]], [s * ROOF_X, ROOF_Y, 0.12], [s * ROOF_X, ROOF_Y, -0.76], [s * footR[0], footR[1], footR[2]]], radius: r, fillet: 0.16, sides: 12, collars: 'none' }, CAGE);
    // B-pillar down to the tub's shoulder.
    const by = hullTop(0.565, -0.46) - 0.05;
    addCageTube(m, { path: [[s * ROOF_X, ROOF_Y, -0.52], [s * 0.565, by, -0.46]], radius: r * 0.9, sides: 10, collars: 'start', joinRadius: r }, CAGE);
  }
  addCageTube(m, { path: [[-ROOF_X, ROOF_Y, 0.0], [ROOF_X, ROOF_Y, 0.0]], radius: r, sides: 12 }, CAGE);
  addCageTube(m, { path: [[-ROOF_X, ROOF_Y, -0.66], [ROOF_X, ROOF_Y, -0.66]], radius: r, sides: 12 }, CAGE);
  // Fan cradle: a low hoop across the rear deck.
  const cradleZ = -1.22;
  const cradleY = FAN.y - FAN.outer - 0.03 - 0.005;
  addCageTube(m, { path: [[-0.37, 1.17, cradleZ], [-0.37, cradleY, cradleZ], [0.37, cradleY, cradleZ], [0.37, 1.17, cradleZ]], radius: 0.03, fillet: 0.09, sides: 12, collars: 'none' }, CAGE);

  // --- fans ------------------------------------------------------------------
  const GLOW = paint(l.glow, { emissive: 0.8, gloss: 0.9 });
  for (const s of [-1, 1]) {
    addFanDrum(m, { at: [s * FAN.x, FAN.y, FAN.z], rotor: FAN.rotor, outer: FAN.outer, length: FAN.length, shell: paint(l.trim, { gloss: 0.85, smooth: 60 }), band: paint(l.cage, { gloss: 0.85, smooth: 60 }), glow: GLOW });
    // Stub shaft from the rear header into the motor pod's nose collar (as
    // on the sheet's side view), and the saddle the drum rests in on the
    // cradle.
    cylinder(m, { from: [s * FAN.x, ROOF_Y - 0.005, -0.66], to: [s * FAN.x, FAN.y, FAN.z + FAN.length * 0.3], radius: 0.032, sides: 14, bevel: 0.006 }, STEEL);
    roundedBox(m, { size: [0.12, 0.06, 0.09], radius: 0.015, segments: 1, at: [s * FAN.x, cradleY + 0.03, cradleZ] }, CAGE);
  }

  // --- lamps and dressing ------------------------------------------------------
  for (const s of [-1, 1]) {
    // Inside the turquoise tail panel, either side of the stripe.
    addReefTailLamp(m, { at: [s * 0.36, 1.06, -1.552], radius: 0.07, dir: [s * 0.3, 0, -1] });
    // Hood pins.
    const hy = hullTop(0.3, 1.25);
    sphere(m, { radii: [0.028, 0.02, 0.028], segments: 10, rings: 5, at: [s * 0.3, hy + 0.006, 1.25] }, CAGE);
    // Sill bolts.
    for (const z of [0.4, -0.2]) addBolt(m, { at: [s * hullSide(0.41, z), 0.41, z], normal: [s, -0.3, 0], radius: 0.014, style: 'button' }, CHROME);
    // Panel bolts high on the flank, where the sheet shows them.
    for (const [z, y] of [[0.5, 1.0], [-0.5, 1.02], [-0.56, 1.02]]) addBolt(m, { at: [s * hullSide(y, z), y, z], normal: [s, 0.35, 0], radius: 0.012, style: 'hex' }, CHROME);
  }
  return m;
}

// ---------------------------------------------------------------------------

/**
 * Wheel, built here rather than by `buildRunningGear` so that tire and rim
 * get their own resolution (the shared style has one `segments` for both):
 * the rim's glossy coral lip needs more facets than the lug-drawn tire.
 * Same radius / width / default rim ratio as the gear's hubs, so the hub
 * still meets the rim's boss.
 */
function buildReefWheel(radius: number, width: number, l: Livery): SolidMesh {
  // No sidewall lettering: the sheet's balloon walls are plain.
  const m = buildTire({ radius, width, tread: TREAD, segments: 22, lettering: false });
  // Concept and sheet: a coral lip round a dark dish with chunky dark spokes
  // and a light hub cap — not a deep coral bowl.
  m.append(buildRim({ radius, width, rim: 'spoke', spokes: 6, ring: l.cage, barrel: '#2E2F36', centre: '#484A53', floor: '#222329', cap: '#B6BAC1', ringWidth: 0.18, segments: 32 }));
  return m;
}

function build(livery = 0): CarGeometry {
  const l = LIVERIES[livery % LIVERIES.length];
  const gear = buildRunningGear(SPEC, {
    ...SUSPENSION,
    caliper: l.trim,
    springColor: mix(l.cage, hex('#E0323C'), 0.35),
    springTurns: 4,
    reservoir: false,
  });
  const rotor = buildReefRotor(FAN.rotor, l.glow);
  return {
    body: buildBody(l, gear),
    driver: buildDriver({
      seat: SEAT,
      recline: RECLINE,
      scale: DRIVER_SCALE,
      wheel: { pivot: WHEEL, axis: WHEEL_AXIS, radius: WHEEL_RADIUS },
      feet: PEDALS,
      helmet: l.body,
      stripe: l.cage,
      suit: darken(l.body, 0.35),
      trim: l.trim,
    }),
    wheelFront: buildReefWheel(SPEC.frontTireRadius, SPEC.frontTireWidth, l),
    wheelRear: buildReefWheel(SPEC.rearTireRadius, SPEC.rearTireWidth, l),
    hubFront: gear.hubFront,
    hubRear: gear.hubRear,
    links: gear.links,
    spinners: [-1, 1].map((s) => fanSpinner(rotor, [s * FAN.x, FAN.y, FAN.z - ROTOR_SETBACK])),
    steeringWheel: { mesh: buildSteeringWheel({ radius: WHEEL_RADIUS, accent: l.cage }), pivot: WHEEL, axis: WHEEL_AXIS },
  };
}

const reefRocket: CarAsset = {
  kind: 'car',
  id: 'reef-rocket',
  name: 'Reef Rocket',
  category: 'car',
  spec: SPEC,
  liveries: LIVERIES.length,
  // Swatch: turquoise shell / coral cage on the sheet.
  paints: LIVERIES.map((l) => ({ name: l.name, body: l.body, accent: l.cage })),
  build,
  triBudget: 60000,
  reference: {
    sheet: 'design-documents/buggy-design-pack/reef-rocket/turnaround.png',
    brief: 'design-documents/buggy-design-pack/reef-rocket/modeling-brief.txt',
  },
};

export default reefRocket;
