import type { RGB } from '../../../gfx/solid';
import type { CarSpec } from '../../types';
import { columnAxis } from '../parts';
import type { P3, SuspensionOptions } from '../parts';

/**
 * RIOT RAM — dimensions and hard points. Everything is hung from these.
 * Spec straight from design-documents/buggy-design-pack/riot-ram/
 * model-spec.json (game (x, y, z) = doc (X, Z, Y), tire radius = Ø / 2).
 */
export const SPEC: CarSpec = {
  length: 3.5,
  width: 2.25, // track 1.79 + tire width 0.46
  height: 1.98, // top of the roof light
  wheelbase: 2.3,
  frontTrack: 1.79,
  rearTrack: 1.79,
  frontTireRadius: 0.5,
  rearTireRadius: 0.5,
  frontTireWidth: 0.46,
  rearTireWidth: 0.46,
  groundClearance: 0.4,
};

export const AXLE_F = SPEC.wheelbase / 2;
export const AXLE_R = -SPEC.wheelbase / 2;
/** Underside of the floor pan. */
export const FLOOR = SPEC.groundClearance;
/** Cage tube radius (spec: cage_tube_diameter 0.075). */
export const TUBE = 0.0375;

// --- cockpit ----------------------------------------------------------------

/** Hip point. The tub is deep (sill at 1.12): the seat stands on a riser so
 * the driver's shoulders clear the sill and the helmet sits just under the
 * roof rails (helmet top = hip + 0.92). */
export const SEAT: P3 = [0, 0.78, -0.2];
export const RECLINE = 12;
/** Steering wheel pivot, 0.44 m ahead of and 0.37 m above the hip point:
 * its rim shows over the cowl in the side view, as on the sheet. */
export const WHEEL: P3 = [0, 1.15, 0.24];
/** Where the column leaves the firewall (the hood's rear face, z = 0.46). */
export const COLUMN_FROM: P3 = [0, 1.035, 0.46];
export const WHEEL_AXIS = columnAxis(COLUMN_FROM, WHEEL);
export const WHEEL_RADIUS = 0.18;
/** Floor point between the pedals. */
export const PEDALS: P3 = [0, FLOOR + 0.03, 0.37];

// --- suspension -------------------------------------------------------------

/**
 * Front coil-overs: standing on TOP of the uprights, up to a cobalt tower
 * brace that spans the open gap between the hood's side and the fender's
 * inner edge — where the sheet shows the lime springs, beside the nose with
 * their silver top eyes in plain view. They stand almost upright: the tire is
 * 0.46 m wide, so a top any further outboard than x = 0.51 meets the tire's
 * inner shoulder at full lock in full bump (the solver's clearance check).
 */
export const DAMPER_F: P3 = [0.51, 1.3, AXLE_F];
export const FOOT_F: P3 = [-0.345, 0.235, 0];
/**
 * Rear: driven axle. The coil-over's foot stands behind the half-shaft
 * (0.185 m behind the axle line) on a stub arm RAISED to 0.2 above the axle;
 * the top eye hangs from a clamp bracket between the rear cage stay and the
 * fender, straight above the foot — upright, as in the sheet's rear view,
 * outboard of the narrowed tail-lamp pods.
 */
export const REAR_COIL_Z = AXLE_R - 0.185;
export const DAMPER_R: P3 = [0.55, 1.3, REAR_COIL_Z];
/** Rear coil-over foot in the right wheel's hub frame (inboard −x). */
const FOOT_R: P3 = [-(SPEC.rearTireWidth / 2 + 0.085 + 0.014), 0.2, -0.185];

export const SUSPENSION: SuspensionOptions = {
  front: { damperTop: DAMPER_F, damperFoot: FOOT_F },
  rear: { damperTop: DAMPER_R, damperFoot: FOOT_R, halfShaft: [0.25, 0.5, AXLE_R] },
  armRadius: 0.032,
  springTurns: 6,
  springWire: 0.26,
  // The sheet's coil-overs are plain: no remote reservoirs.
  reservoir: false,
};

// --- cage nodes (right side) --------------------------------------------------

/** A-pillar foot, sunk in the cowl corner. */
export const A_FOOT: P3 = [0.59, 1.2, 0.53];
/** A-pillar top / front roof corner. */
export const A_TOP: P3 = [0.42, 1.8, 0.02];
/** B-pillar top on the roof rail. */
export const B_TOP: P3 = [0.42, 1.8, -0.64];
/** B-pillar foot on the sill's rear end. */
export const B_FOOT: P3 = [0.68, 1.08, -0.7];
/** Rear roof corner. */
export const R_TOP: P3 = [0.42, 1.8, -1.0];
/** Waist node beside the rear fender's inner edge: rear stay, waist rail and
 * diagonal meet here, clamped to the fender and carrying the rear
 * coil-over's top bracket. Inboard of the fender (x ≤ 0.5) so the tube
 * never runs into the panel; the waist rail clears the fender's front slope. */
export const WAIST_Y = 1.44;
export const S_NODE: P3 = [0.45, WAIST_Y, -1.27];
/** Rear bumper cross-member: the car's rear extreme. */
export const TAIL: P3 = [0.27, 0.62, -(SPEC.length / 2) + TUBE + 0.002];

// --- liveries -----------------------------------------------------------------

export interface RamLivery {
  name: string;
  /** Hood, door frames, cage. */
  body: RGB;
  /** Fenders, side panels, scoop, cage clamps, wishbones, rim rings. */
  panel: RGB;
  /** Stripes. */
  stripe: RGB;
  /** Coil springs, calipers, tow hook. */
  spring: RGB;
  /** Side-panel stripes: [z of the lower front corner, width] each; they
   * lean back at the top. */
  sideStripes: readonly (readonly [number, number])[];
  /** Hood stripes: [x at the nose, width] each; they run back toward the
   * car's left. */
  hoodStripes: readonly (readonly [number, number])[];
  /** Driver. */
  helmet: RGB;
  helmetStripe: RGB;
  suit: RGB;
  trim: RGB;
}
