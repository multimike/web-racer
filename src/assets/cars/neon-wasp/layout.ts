import { hex, mix, paint } from '../../../gfx/solid';
import type { Paint, RGB } from '../../../gfx/solid';
import { BUILDING, FOLIAGE, NEON_WASP } from '../../palette';
import type { CarSpec } from '../../types';
import { columnAxis } from '../parts';
import type { P3, SuspensionOptions } from '../parts';

/**
 * NEON WASP — hard points, liveries and paints shared by the car's modules.
 *
 * Everything is in car model space: origin on the ground under the wheelbase
 * centre, +x right, +y up, +z nose. Points are given for the RIGHT side
 * (x > 0); every module mirrors them itself.
 */

// design-documents/buggy-design-pack/neon-wasp/model-spec.json, converted
// game (x, y, z) = doc (X, Z, Y); tire radius = diameter / 2.
export const SPEC: CarSpec = {
  length: 3.25,
  width: 1.95, // front track + front tire width: the widest axle over the tires
  height: 1.72, // the fin tips
  wheelbase: 2.2,
  frontTrack: 1.61,
  rearTrack: 1.55,
  frontTireRadius: 0.37,
  rearTireRadius: 0.41,
  frontTireWidth: 0.34,
  rearTireWidth: 0.4,
  groundClearance: 0.3,
};

export const AXLE_F = SPEC.wheelbase / 2;
export const AXLE_R = -SPEC.wheelbase / 2;
/** Front overhang 0.64 m: the nose tip. Rear overhang 0.41 m is exactly the
 * rear tire's radius, so NOTHING on the body may reach behind the tires. */
export const NOSE_TIP_Z = AXLE_F + 0.64;
export const TAIL_Z = AXLE_R - 0.41;
/** Underside of the floor pan = the spec's ground clearance. */
export const FLOOR = SPEC.groundClearance;
/** Cage tube radius. The spec's cage_tube_diameter is 0.055, but both
 * sheets draw the frame at about 0.08 (12 % of the front tire's diameter):
 * at 0.055 the frame reads as wire, not as the chunky toy tube of the
 * concept, which has priority on visible styling. */
export const TUBE = 0.037;

// ---------------------------------------------------------------------------
// Frame nodes (right side). The tube frame IS this car's body: the yellow
// shells only dress it, so every shell and every suspension mount is hung
// from one of these.

/** Lower rail: narrow under the nose and the motor, wide round the cockpit. */
export const RAIL_Y = FLOOR + 0.045;
/** Where the front clip's four rails stop running parallel and converge into
 * the nose shell, and where the rear clip ends in its hoop. */
export const CLIP_FRONT_Z = 1.31;
export const REAR_HOOP_Z = -1.33;
export const N = {
  /** Lower rail, front to rear. */
  lowFront: [0.115, RAIL_Y, CLIP_FRONT_Z],
  lowNeck: [0.115, RAIL_Y, 0.84],
  lowDoorFront: [0.46, RAIL_Y, 0.58],
  lowDoorRear: [0.46, RAIL_Y, -0.36],
  lowWaist: [0.16, RAIL_Y, -0.82],
  lowRear: [0.16, RAIL_Y, REAR_HOOP_Z],
  /** Upper rails of the two narrow clips: the upper wishbones pivot on them. */
  upFront: [0.205, 0.54, CLIP_FRONT_Z],
  upNeck: [0.205, 0.54, 0.86],
  upWaist: [0.19, 0.56, -0.84],
  upRear: [0.19, 0.56, REAR_HOOP_Z],
  /** Door bar (shoulder rail), front to rear. It runs on forward past the
   * cowl into a horn beside the hood: the front coil-overs hang from it. */
  hornTip: [0.321, 0.848, 1.165],
  doorFront: [0.345, 0.835, 0.98],
  aFoot: [0.48, 0.81, 0.6],
  doorWide: [0.54, 0.8, -0.05],
  doorRear: [0.46, 0.84, -0.5],
  /** Roof corners. With the A-pillar feet at ±0.48 the pillars lean in
   * about 18° in front view: the broad trapezoid of the sheet. */
  roofFront: [0.28, 1.43, 0.02],
  roofRear: [0.28, 1.43, -0.58],
  /** Rear node: the roof stay, the rear shock tower and the booster cradle meet here. */
  rearNode: [0.36, 1.08, -0.78],
  /** Top corner of the rear hoop. */
  hoopTop: [0.27, 0.99, REAR_HOOP_Z],
} as const satisfies Record<string, P3>;
/** The two steel ball joints on each lower rail: the uprights stand on them
 * and the pods' lower corners bolt to them (z of each). */
export const POD_JOINT_Z = [0.56, -0.33] as const;

// ---------------------------------------------------------------------------
// Cockpit

/** Hip point: centre of the seat cushion's top surface. */
export const SEAT: P3 = [0, 0.475, -0.24];
export const RECLINE = 14;
export const DRIVER_SCALE = 0.94;
/** Steering wheel pivot, and where the column leaves the dashboard. */
export const WHEEL: P3 = [0, 0.82, 0.22];
export const COLUMN_FROM: P3 = [0, 0.73, 0.5];
export const WHEEL_AXIS = columnAxis(COLUMN_FROM, WHEEL);
export const WHEEL_RADIUS = 0.155;
export const PEDALS: P3 = [0, FLOOR + 0.03, 0.42];
export const DASH: P3 = [0, 0.765, 0.5];

// ---------------------------------------------------------------------------
// Boosters: two jets side by side over the motor, nozzles facing backward.

/** The sheet's rear view draws the two cans touching, each about 0.3 m
 * across: 0.25 m cans 1 cm apart. */
export const BOOSTER_X = 0.131;
export const BOOSTER_Y = 1.2;
export const BOOSTER_RADIUS = 0.125;
/** Front dome tip … nozzle mouth. The mouth stops 14 cm short of the tail so
 * the glowing jet cone behind it still ends inside the rear overhang. */
export const BOOSTER_FRONT_Z = -0.86;
export const BOOSTER_MOUTH_Z = TAIL_Z + 0.14;
/** Glowing turbine just inside each nozzle lip (the spinner's pivot). */
export const TURBINE_Z = BOOSTER_MOUTH_Z + 0.03;
export const TURBINE_RADIUS = 0.1;

// ---------------------------------------------------------------------------
// Suspension anchors on this frame.

/**
 * FRONT: the library's coil-over foot is on the upright, and with tires this
 * fat the spring only clears the tire at full lock if its top stays on the
 * axle line and well inboard (scanned: x ≤ 0.34 at z = axle).
 * REAR: driven axle. The half-shaft runs on the axle line, so the coil-over
 * stands on a stub arm 17 cm AHEAD of it, as on the sheet, and leans forward
 * to the rear node.
 */
export const HALF_SHAFT: P3 = [0.2, SPEC.rearTireRadius - 0.02, AXLE_R];

export const SUSPENSION: SuspensionOptions = {
  // Wishbones as chunky as the cage, as both sheets draw them.
  armRadius: 0.028,
  // Fat wire, the turns nearly touching, as the sheet draws them.
  springTurns: 6,
  springWire: 0.31,
  // The sheet's dampers are dark bodies with steel ends, no reservoirs.
  reservoir: false,
  front: {
    lowerPivot: [0.165, RAIL_Y + 0.005, AXLE_F],
    upperPivot: [0.255, 0.54, AXLE_F],
    damperTop: [0.335, 0.79, AXLE_F],
  },
  rear: {
    lowerPivot: [0.22, RAIL_Y + 0.005, AXLE_R],
    upperPivot: [0.25, 0.56, AXLE_R],
    // Leaning in at the top, as in the sheet's rear view.
    damperTop: [0.35, 1.04, -0.8],
    damperFoot: [-0.284, -0.023, 0.17],
    halfShaft: HALF_SHAFT,
  },
};

// ---------------------------------------------------------------------------
// Liveries. A livery swaps colours only — never the shape.

export interface Livery {
  name: string;
  /** Shell colour: nose, pods, fins. */
  body: RGB;
  /** Tube frame and wishbones. */
  cage: RGB;
  /** Rim rings, coil springs, calipers. */
  accent: RGB;
  /** Everything that glows: head lamps, roof bar, booster slots and jets. */
  glow: RGB;
  /** Speed stripes on pods and fins. */
  stripe: RGB;
  /** Roof-lamp housing and booster end caps. */
  dark: RGB;
  /** Glow in the shell paint (default 0.06). */
  shellGlow?: number;
}

export const LIVERIES: Livery[] = [
  // 0 — the design sheet.
  // The body yellow is pushed a little greener than the spec's #E9EF00,
  // and glows a little more than the other liveries: under the warm sun
  // and the cool shade tint it otherwise drifts to olive on every face
  // turned away from the sun, where the sheet keeps it neon on all sides.
  { name: 'Neon Wasp', body: hex('#E6F400'), shellGlow: 0.13, cage: NEON_WASP.cageViolet, accent: NEON_WASP.accentCyan, glow: NEON_WASP.accentCyan, stripe: NEON_WASP.cageViolet, dark: hex('#2E2A6E') },
  // 1 — coral shell on a cobalt frame, cream stripes.
  { name: 'Coral Hornet', body: BUILDING.coral, cage: BUILDING.cobalt, accent: BUILDING.cyanLight, glow: BUILDING.cyanLight, stripe: BUILDING.cream, dark: hex('#22306E') },
  // 2 — cream shell on a jade frame, ochre wheels, warm jets.
  { name: 'Jade Mantis', body: BUILDING.cream, cage: FOLIAGE.jade, accent: BUILDING.mustard, glow: hex('#FFB52E'), stripe: FOLIAGE.jade, dark: hex('#0F5A4A') },
  // 3 — turquoise shell on a lavender frame, lime accents.
  { name: 'Lagoon Moth', body: BUILDING.turquoise, cage: hex('#A58BE0'), accent: FOLIAGE.highlight, glow: FOLIAGE.highlight, stripe: BUILDING.cream, dark: hex('#4A3F8C') },
];

export interface Paints {
  BODY: Paint;
  /** Underside / inner skin of the shells: the same colour, less shine. */
  BODY_IN: Paint;
  CAGE: Paint;
  STRIPE: Paint;
  ACCENT: Paint;
  GLOW: Paint;
  GLOW_SOFT: Paint;
  /** Hot core of a lamp — small faces only. */
  GLOW_CORE: Paint;
  DARK: Paint;
}

export function paintsOf(l: Livery): Paints {
  return {
    // A trace of glow keeps the shells luminous in shade: the "neon".
    BODY: paint(l.body, { gloss: 0.88, emissive: l.shellGlow ?? 0.06, smooth: 50 }),
    BODY_IN: paint(l.body, { gloss: 0.55, emissive: (l.shellGlow ?? 0.06) * 0.8, smooth: 50 }),
    CAGE: paint(l.cage, { gloss: 0.62 }),
    STRIPE: paint(l.stripe, { gloss: 0.85, smooth: 50 }),
    ACCENT: paint(l.accent, { gloss: 0.85, emissive: 0.12 }),
    GLOW: paint(l.glow, { emissive: 0.85, gloss: 0.9 }),
    GLOW_SOFT: paint(l.glow, { emissive: 0.55, gloss: 0.9 }),
    GLOW_CORE: paint(mix(l.glow, [1, 1, 1], 0.6), { emissive: 0.95, gloss: 0.9 }),
    DARK: paint(l.dark, { gloss: 0.6 }),
  };
}
