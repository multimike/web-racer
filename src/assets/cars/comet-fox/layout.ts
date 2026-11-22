import { mixOklab, paint, toRGB } from '../../../gfx/solid';
import type { Paint, RGB } from '../../../gfx/solid';
import type { CarSpec } from '../../types';
import type { P3 } from '../parts';

/**
 * COMET FOX — the hard points every part of the car is hung from, and the
 * paints of one livery. Shared by the shell, the frame and the turbine so
 * that a tube always ends on the panel it carries.
 *
 * Axes: game (x, y, z) = design doc (X, Z, Y); origin on the ground under
 * the wheelbase centre, nose +z.
 */

// Straight from design-documents/buggy-design-pack/comet-fox/model-spec.json
// (tire RADIUS = diameter / 2).
export const SPEC: CarSpec = {
  length: 3.7,
  width: 2.05,
  height: 1.87,
  wheelbase: 2.55,
  frontTrack: 1.59,
  rearTrack: 1.57,
  frontTireRadius: 0.36,
  rearTireRadius: 0.51,
  frontTireWidth: 0.32,
  rearTireWidth: 0.48,
  groundClearance: 0.28,
};

export const AXLE_F = SPEC.wheelbase / 2;
export const AXLE_R = -SPEC.wheelbase / 2;
/** Front overhang 0.64 m: the nose tip. */
export const NOSE_TIP = AXLE_F + 0.64;
/** Rear overhang 0.51 m — exactly the rear tire's radius, so NOTHING on the
 * body may reach further back than this (the nozzle stops just short). */
export const TAIL = AXLE_R - 0.51;
export const FLOOR = SPEC.groundClearance;
/** Cage tube radius (spec: 55 mm diameter). */
export const TUBE = 0.0275;

// --- cockpit -----------------------------------------------------------------

/** Hip point. As low as the seat shell allows over the floor pan: the cage
 * roof has to clear the big toy helmet and still leave the fin its height. */
export const SEAT: P3 = [0, 0.45, -0.15];
export const RECLINE = 16;
export const WHEEL: P3 = [0, 0.78, 0.29];
/** Where the column leaves the scuttle under the dashboard. */
export const COLUMN_FROM: P3 = [0, 0.728, 0.455];
export const WHEEL_RADIUS = 0.16;
export const PEDALS: P3 = [0, 0.31, 0.47];

// --- frame nodes (right side, x > 0) ------------------------------------------

/** Roof tube centre height. */
export const ROOF_Y = 1.41;
/** Main hoop station. */
export const HOOP_Z = -0.6;
/** Belt rail: front node under the nose's rear corner, the kink where the
 * side panel begins, and the rear node at the panel's top rear corner. */
export const BELT_FRONT: P3 = [0.4, 0.8, 0.55];
export const BELT_MID: P3 = [0.44, 0.845, 0.06];
export const BELT_REAR: P3 = [0.44, 0.94, -0.8];
/** Lower rail: nose-frame node, the two cockpit corners, the tail node. */
export const SILL_FRONT: P3 = [0.3, 0.35, 0.86];
export const SILL_A: P3 = [0.49, 0.34, 0.42];
export const SILL_B: P3 = [0.49, 0.34, -0.62];
export const SILL_REAR: P3 = [0.2, 0.36, -1.04];

// --- turbine -----------------------------------------------------------------

/** Axis height of the longitudinal main housing, and its stations along z. */
export const TURBINE_Y = 1.2;
export const TURBINE_FRONT = -0.74;
export const TURBINE_EXIT = TAIL + 0.025;
/** Barrel radius (the two bright rings stand 12 mm proud of it). */
export const TURBINE_R = 0.245;
/** Lateral intake / generator covers: station, glow radius, lip face x. */
export const INTAKE_Z = -0.94;
export const INTAKE_R = 0.16;
export const INTAKE_X = 0.31;
/** Outer radius of the nozzle's exit lip: the cone converges to ~63 % of
 * the barrel, as in the sheet's side view. */
export const NOZZLE_R = 0.155;
/** Rear rotor inside the nozzle. */
export const ROTOR_Z = -1.62;
export const ROTOR_R = 0.115;

// --- liveries ----------------------------------------------------------------

export interface Livery {
  name: string;
  /** Shell paint: nose, side panels, fin. */
  body: RGB | string;
  /** Chevron, fox emblem, fin swoosh. */
  graphic: RGB | string;
  /** Tube frame, rim rings. */
  cage: RGB | string;
  /** Turbine light, lamps, visor. */
  glow: RGB | string;
  /** Coil springs, harness, seat inserts. */
  spring: RGB | string;
  /** Deep colour of the rotor blades behind the glow. */
  rotor: RGB | string;
  /** Driver's race suit. */
  suit: RGB | string;
}

export interface Paints {
  BODY: Paint;
  GRAPHIC: Paint;
  CAGE: Paint;
  GLOW: Paint;
  /** Softer glow for broad faces (blades, lenses seen face-on). */
  GLOW_SOFT: Paint;
  ROTOR: Paint;
  /** Lamp lens: the glow colour deepened, half lit — the bright core sits in it. */
  LENS: Paint;
  SPRING: Paint;
}

export function paintsOf(l: Livery): Paints {
  return {
    BODY: paint(l.body, { gloss: 0.72, smooth: 42 }),
    GRAPHIC: paint(l.graphic, { gloss: 0.7, smooth: 42 }),
    CAGE: paint(l.cage, { gloss: 0.62 }),
    GLOW: paint(l.glow, { emissive: 0.9, gloss: 0.9 }),
    GLOW_SOFT: paint(l.glow, { emissive: 0.7, gloss: 0.9 }),
    ROTOR: paint(l.rotor, { emissive: 0.45, gloss: 0.8 }),
    LENS: paint(mixOklab(toRGB(l.glow), toRGB(l.rotor), 0.45), { emissive: 0.55, gloss: 0.95 }),
    SPRING: paint(l.spring, { gloss: 0.7 }),
  };
}
