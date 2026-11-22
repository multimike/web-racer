import type { CarSpec } from '../assets/types';

/**
 * VehicleRig — the physics description of one car design, derived from the
 * same `CarSpec` the graphics are built from. EVERY vehicle model (legacy
 * rigid wheels, raycast, hybrids, ...) consumes this one structure, so two
 * models driven side by side are guaranteed to be the same car: same wheel
 * positions, same per-axle tire sizes, same masses, CoM and inertia.
 *
 * RIG SPACE (identical to `CarGeometry` model space, so graphics can be hung
 * on a rig without conversion): +x right, +y up, +z forward. Origin on the
 * GROUND under the wheelbase centre with the car at static ride height.
 *
 * Wheel order everywhere: 0 FL, 1 FR, 2 RL, 3 RR (left = −x).
 */

export interface RigBox {
  /** Box centre in rig space, m. */
  center: [number, number, number];
  /** Full extents x (width), y (height), z (length), m. */
  size: [number, number, number];
}

export interface RigAxle {
  /** Axle position along the car, rig space (+ = toward the nose), m. */
  z: number;
  /** Wheel centre to wheel centre, m. */
  track: number;
  tireRadius: number;
  tireWidth: number;
  /** Unsprung mass per corner (tire + rim + hub + upright + brake), kg. */
  wheelMass: number;
  /** Wheel spin inertia about the axle, kg·m². */
  wheelSpinInertia: number;
  /** SPRUNG mass resting on one wheel of this axle at rest, kg. */
  sprungCornerMass: number;
  /** Wheel-rate spring, N/m (per wheel). */
  springRate: number;
  /** Wheel-rate damper, N·s/m (per wheel). */
  damperRate: number;
  /** Static spring compression under `gravity`, m. */
  staticSag: number;
  /** Travel from static ride height to the bump stop / to full droop, m. */
  bumpTravel: number;
  droopTravel: number;
}

export interface RigWheel {
  index: 0 | 1 | 2 | 3;
  axle: 'front' | 'rear';
  side: -1 | 1;
  /** Wheel centre at static ride height, rig space, m (y = tire radius). */
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  mass: number;
  steered: boolean;
  driven: boolean;
}

export interface VehicleRig {
  /** 'reef-rocket' | 'riot-ram' | 'comet-fox' | 'neon-wasp' | 'rb01' | custom. */
  id: string;
  spec: CarSpec;
  wheelbase: number;
  front: RigAxle;
  rear: RigAxle;
  /** FL, FR, RL, RR. */
  wheels: [RigWheel, RigWheel, RigWheel, RigWheel];
  /** Sprung (chassis) mass and all-in mass, kg. */
  sprungMass: number;
  totalMass: number;
  /** Share of the SPRUNG mass carried by the front axle (0..1). */
  frontWeightFraction: number;
  /** Sprung-mass centre of mass, rig space, m. */
  com: [number, number, number];
  /** Sprung-mass principal inertia about its CoM, kg·m²:
   * [about x = pitch, about y = yaw, about z = roll].
   * NOTE for Havok bodies: `PhysicsBody.setMassProperties({ inertia })`
   * wants inertia PER UNIT MASS (divide these by `sprungMass`). */
  inertia: [number, number, number];
  /** Chassis collision hull (floor pan up to the beltline). */
  hull: RigBox;
  /** Roll cage volume above the hull — what the car lands on when inverted. */
  cage: RigBox;
  /** Gravity magnitude the static numbers (sag) were computed for, m/s². */
  gravity: number;
}

export interface RigOptions {
  /** Scene gravity magnitude. The game runs 25 m/s² on purpose. */
  gravity?: number;
  /** Override the all-in mass estimate (kg); wheels keep their own estimate. */
  totalMass?: number;
  /** Share of sprung mass on the front axle. Default 0.46: rear-engined
   * buggy layout (driver ahead of the engine, engine over the rear axle). */
  frontWeightFraction?: number;
  /** Sprung CoM height above the ground, m. Default clearance + 0.20. */
  comHeight?: number;
  /** Undamped ride frequency, Hz (front, rear). */
  rideFrequency?: [number, number];
  /** Damping ratio (fraction of critical) at the wheel. */
  dampingRatio?: number;
  drivenAxles?: 'rear' | 'front' | 'all';
}

/** Scene gravity the game uses (owner's "snappier" feel choice). */
export const GAME_GRAVITY = 25;

/*
 * Mass model, with the reasoning behind each number:
 *
 * - Sprung mass = 95 kg per m² of footprint (length × width). Real open-frame
 *   buggies of this size: Ariel Nomad 670 kg at 3.2 × 1.85 m (113 kg/m²),
 *   Polaris RZR XP 1000 ≈ 640 kg dry at 3.03 × 1.63 m (130 kg/m², but that
 *   includes its wheels), VW-pan sand rail 550-650 kg at ~3.4 × 1.8 m
 *   (≈ 100 kg/m² incl. wheels). The design-pack cars carry their width in the
 *   TIRES (2.05 m wide on a ~1.2 m tub), so the tub itself is at the light
 *   end: 95 kg/m² of overall footprint → 650-750 kg sprung.
 * - Wheel (unsprung corner) mass = 420 · r² · w + 8 kg. Tire + rim mass grows
 *   with r² · w (carcass volume): a 30 × 10 UTV wheel (r 0.38, w 0.25) is
 *   ≈ 20 kg, a 37 × 12.5 truck wheel (r 0.47, w 0.32) ≈ 45 kg; the designs'
 *   balloon tires are wider but low-pressure/light-carcass, so the same law
 *   with a slightly lower constant fits. + 8 kg hub/upright/brake.
 *   → REEF ROCKET 30 / 49 kg, RIOT RAM 56 kg, COMET FOX 25 / 60 kg.
 * - All-in: REEF ROCKET ≈ 810 kg, RIOT RAM ≈ 973 kg, COMET FOX ≈ 892 kg —
 *   inside the 700-1000 kg band for a 3.3-3.7 m buggy on oversized tires.
 * - CoM height = ground clearance + 0.20 m (seat pan + engine block height in
 *   a tube frame) → 0.48-0.60 m, static stability factor track/(2h) ≈ 1.5-1.6,
 *   typical for a sport UTV (1.3-1.6 measured by CPSC) and safely above the
 *   tire μ ≈ 1.2, so the car should slide before it rolls on flat ground.
 * - Inertia: solid box with the mass-carrying dimensions (70 % of the width,
 *   85 % of the length, 45 % of the height) → yaw radius of gyration ≈ 0.27 ×
 *   length, in line with measured light-car values (0.25-0.30 × length).
 * - Suspension: 2.5 Hz ride frequency, ζ = 0.45. Far stiffer than a real
 *   buggy's 1.2-1.5 Hz, on purpose: the game runs gravity 25 m/s², and sag =
 *   g / (2πf)² — 2.5 Hz gives the 0.10 m static sag a 1.6 Hz car has on
 *   Earth. (The legacy RB-01 tune sits at 2.57 Hz / ζ 0.43 for that reason.)
 */
const SPRUNG_KG_PER_M2 = 95;

function wheelMassFor(radius: number, width: number): number {
  return 420 * radius * radius * width + 8;
}

/** Build the physics rig for a car design. Pure data, no Babylon. */
export function createRig(id: string, spec: CarSpec, options: RigOptions = {}): VehicleRig {
  const gravity = options.gravity ?? GAME_GRAVITY;
  const L = spec.wheelbase;
  const frontWheelMass = wheelMassFor(spec.frontTireRadius, spec.frontTireWidth);
  const rearWheelMass = wheelMassFor(spec.rearTireRadius, spec.rearTireWidth);
  const unsprung = 2 * (frontWheelMass + rearWheelMass);
  const sprungMass = options.totalMass !== undefined
    ? options.totalMass - unsprung
    : SPRUNG_KG_PER_M2 * spec.length * spec.width;
  const totalMass = sprungMass + unsprung;
  const fwf = options.frontWeightFraction ?? 0.46;
  const comHeight = options.comHeight ?? spec.groundClearance + 0.2;
  const [fFront, fRear] = options.rideFrequency ?? [2.5, 2.5];
  const zeta = options.dampingRatio ?? 0.45;
  const driven = options.drivenAxles ?? 'rear';

  const axle = (
    z: number, track: number, radius: number, width: number,
    wheelMass: number, share: number, freq: number,
  ): RigAxle => {
    const sprungCornerMass = (sprungMass * share) / 2;
    const omega = 2 * Math.PI * freq;
    const springRate = sprungCornerMass * omega * omega;
    return {
      z,
      track,
      tireRadius: radius,
      tireWidth: width,
      wheelMass,
      // Tire mass sits near the tread, hub mass near the centre.
      wheelSpinInertia: 0.6 * wheelMass * radius * radius,
      sprungCornerMass,
      springRate,
      damperRate: 2 * zeta * Math.sqrt(springRate * sprungCornerMass),
      staticSag: (sprungCornerMass * gravity) / springRate,
      // The floor must not ground out before the bump stop.
      bumpTravel: Math.min(0.2, Math.max(0.08, spec.groundClearance - 0.1)),
      droopTravel: 0.15,
    };
  };
  const front = axle(L / 2, spec.frontTrack, spec.frontTireRadius, spec.frontTireWidth, frontWheelMass, fwf, fFront);
  const rear = axle(-L / 2, spec.rearTrack, spec.rearTireRadius, spec.rearTireWidth, rearWheelMass, 1 - fwf, fRear);

  const wheel = (index: 0 | 1 | 2 | 3, a: RigAxle, name: 'front' | 'rear', side: -1 | 1): RigWheel => ({
    index,
    axle: name,
    side,
    x: (side * a.track) / 2,
    y: a.tireRadius,
    z: a.z,
    radius: a.tireRadius,
    width: a.tireWidth,
    mass: a.wheelMass,
    steered: name === 'front',
    driven: driven === 'all' || driven === name,
  });

  // Mass-carrying box → principal inertia of the sprung mass.
  const mw = 0.7 * spec.width;
  const ml = 0.85 * spec.length;
  const mh = 0.45 * spec.height;
  const inertia: [number, number, number] = [
    (sprungMass / 12) * (mh * mh + ml * ml),
    (sprungMass / 12) * (mw * mw + ml * ml),
    (sprungMass / 12) * (mw * mw + mh * mh),
  ];

  // Collision hull: the tub between the tires, floor at ground clearance.
  // Shorter than the bodywork (half of each overhang) so the box corners do
  // not dig into ramp faces the tapered nose would clear.
  const minTrack = Math.min(spec.frontTrack, spec.rearTrack);
  const maxTireW = Math.max(spec.frontTireWidth, spec.rearTireWidth);
  const hullW = Math.max(0.6, minTrack - maxTireW - 0.1);
  const hullL = L + 0.5 * (spec.length - L);
  const hullH = 0.5;
  const hull: RigBox = {
    center: [0, spec.groundClearance + hullH / 2, 0],
    size: [hullW, hullH, hullL],
  };
  const cageBottom = spec.groundClearance + hullH;
  const cageH = Math.max(0.2, spec.height - 0.08 - cageBottom);
  const cage: RigBox = {
    center: [0, cageBottom + cageH / 2, -0.08 * L],
    size: [hullW * 0.85, cageH, L * 0.62],
  };

  return {
    id,
    spec,
    wheelbase: L,
    front,
    rear,
    wheels: [
      wheel(0, front, 'front', -1),
      wheel(1, front, 'front', 1),
      wheel(2, rear, 'rear', -1),
      wheel(3, rear, 'rear', 1),
    ],
    sprungMass,
    totalMass,
    frontWeightFraction: fwf,
    com: [0, comHeight, (fwf - 0.5) * L],
    inertia,
    hull,
    cage,
    gravity,
  };
}

/**
 * Design dimensions, meters, straight from
 * design-documents/buggy-design-pack/<id>/model-spec.json ("dimensions"),
 * plus the legacy RB-01 blueprint. Kept here (not imported from the car
 * assets) so physics never depends on a geometry builder being present.
 */
export const CAR_SPECS: Record<string, CarSpec> = {
  'reef-rocket': {
    length: 3.35, width: 2.05, height: 1.95, wheelbase: 2.2,
    frontTrack: 1.69, rearTrack: 1.61,
    frontTireRadius: 0.38, rearTireRadius: 0.47,
    frontTireWidth: 0.36, rearTireWidth: 0.44,
    groundClearance: 0.32,
  },
  'riot-ram': {
    length: 3.5, width: 2.25, height: 1.98, wheelbase: 2.3,
    frontTrack: 1.79, rearTrack: 1.79,
    frontTireRadius: 0.5, rearTireRadius: 0.5,
    frontTireWidth: 0.46, rearTireWidth: 0.46,
    groundClearance: 0.4,
  },
  'comet-fox': {
    length: 3.7, width: 2.05, height: 1.87, wheelbase: 2.55,
    frontTrack: 1.59, rearTrack: 1.57,
    frontTireRadius: 0.36, rearTireRadius: 0.51,
    frontTireWidth: 0.32, rearTireWidth: 0.48,
    groundClearance: 0.28,
  },
  'neon-wasp': {
    length: 3.25, width: 1.95, height: 1.72, wheelbase: 2.2,
    frontTrack: 1.61, rearTrack: 1.55,
    frontTireRadius: 0.37, rearTireRadius: 0.41,
    frontTireWidth: 0.34, rearTireWidth: 0.4,
    groundClearance: 0.3,
  },
  // Legacy "SLICKSTREAM" RB-01 blueprint (what RigidWheelVehicle hardcodes).
  rb01: {
    length: 4.1, width: 2.1, height: 1.6, wheelbase: 2.6,
    frontTrack: 1.68, rearTrack: 1.68,
    frontTireRadius: 0.52, rearTireRadius: 0.52,
    frontTireWidth: 0.42, rearTireWidth: 0.42,
    groundClearance: 0.35,
  },
};

export const DEFAULT_CAR_ID = 'reef-rocket';

/** Rig for a known design id (see CAR_SPECS). Throws on an unknown id. */
export function rigFor(id: string = DEFAULT_CAR_ID, options: RigOptions = {}): VehicleRig {
  const spec = CAR_SPECS[id];
  if (!spec) throw new Error(`unknown car '${id}' (known: ${Object.keys(CAR_SPECS).join(', ')})`);
  return createRig(id, spec, options);
}
