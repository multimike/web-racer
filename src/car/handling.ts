import type { Vehicle } from './Vehicle';
import type { RaycastTuning } from './raycast/tuning';

/**
 * HANDLING PERSONALITIES — one preset per car design, for the PRIMARY vehicle
 * model ('raycast'). The rig already makes the cars different (mass,
 * wheelbase, track, tire sizes, CoM height, inertia); a preset adds the
 * character on top as MODEST multipliers on the model's default tuning
 * (`scale`) plus the odd absolute value (`set`). Every preset is measured in
 * the physics lab with the same suite and the same target bands as the
 * default car:
 *
 *   tools/physlab.sh "model=raycast&car=neon-wasp" out.json          (preset on)
 *   tools/physlab.sh "model=raycast&car=neon-wasp&handling=0" …      (preset off)
 *
 * `createVehicle()` applies the preset of the car id it builds, unless told
 * not to (`handling: false`). Anything here can still be overridden live
 * through `vehicle.setTuning(key, value)` / the tuning panel.
 *
 * What the multipliers do, in driving terms:
 *   minTurnRadius      > 1 = wider turning circle, calmer steering
 *   steerRate          how fast the road wheels follow the stick
 *   yawInertiaScale    > 1 = slower to start AND to stop rotating
 *   frontGripScale /   balance: more rear = planted, pushes at the limit;
 *   rearGripScale      less rear = the tail comes round sooner
 *   driveAccel         shove out of corners (and how easily power breaks the
 *                      rear loose at low speed)
 *   maxSpeed / driveFreeSpeed   top speed (scaled together)
 *   powerSlideLoss     how much the throttle loosens a sliding rear = how
 *                      deep and how easily it drifts
 *   counterSteerSlipPower   how hard the car is fed into a slide with the
 *                      stick held into the corner
 *   slideYawDamping    > 1 = slides open more slowly (more time to react)
 *   powerOver          (set) the POWER-OVER TRAIT: does the tail step out
 *                      when the driver floors it with plenty of lock in a
 *                      fast corner, or does the car just push wide?
 *
 * POWER-OVER, car by car (lab maneuver `powerOver`: steady 0.375 mu*g corner,
 * then half a stick more lock and the foot flat; peak slide angle at 12 / 15
 * / 18 m/s, identical to 0.3 deg at 30 / 60 / 72 / 90 / 120 Hz):
 *   reef-rocket   28 / 26 /  0 deg   steps out up to ~16 m/s, 15 deg after 0.6 s
 *   neon-wasp     28 / 26 /  0 deg   the same, but quicker: 15 deg after 0.45 s
 *   comet-fox     28 / 27 /  0 deg   mostly by its own rear-heavy thrust
 *   riot-ram       1 /  0 /  0 deg   never at speed: it pushes. Its tail only
 *                                    comes out on a flick, a brake tap, in a
 *                                    hairpin (9 m/s) or from rest (donut).
 * Above ~17 m/s no car steps out on power alone (the motor is past its
 * torque plateau); a lift-flick or a brake tap still starts a slide there.
 * The bands are declared in each preset (`powerOver`) and checked by the lab.
 */
export interface HandlingPreset {
  /** Short name for menus. */
  label: string;
  /** One line for the car-select screen. */
  description: string;
  /** Multipliers on DEFAULT tuning values of the primary model. */
  scale: Partial<Record<keyof RaycastTuning, number>>;
  /** Absolute values (applied after `scale`). */
  set?: Partial<RaycastTuning>;
  /**
   * POWER-OVER TRAIT, declared: how far the tail steps out (peak slide angle,
   * degrees, as [min, max]) when the driver floors it and adds half a stick
   * of lock in a steady 0.375 mu*g corner at 12 / 15 / 18 m/s. The physics
   * lab measures exactly this (maneuver `powerOver`) and fails the check
   * `powerOver.asDeclared` when a car leaves its band — so the trait cannot
   * drift away from what is written here. Set by `powerOver` in `scale`/`set`
   * (see raycast/tuning.ts).
   */
  powerOver?: { v12: [number, number]; v15: [number, number]; v18: [number, number] };
}

export const HANDLING_PRESETS: Record<string, HandlingPreset> = {
  // The reference car: every default was tuned on it (powerOver 0.8).
  'reef-rocket': {
    label: 'All-rounder',
    description: 'Friendly and predictable: turns in willingly, slides progressively, forgives late hands.',
    scale: {},
    powerOver: { v12: [20, 35], v15: [20, 35], v18: [0, 6] },
  },
  // Lightest car, shortest tires: darts into corners, tail comes round early
  // and deep, gathers up quickly because there is little of it to stop.
  // powerOver 0.5: with its looser rear that is already enough to step out
  // at 15 m/s at every frame rate (0.9 made the attacking lap ragged).
  // Catch latch from 9 deg (fully at 10) instead of 7 (fully at 10): the
  // first swing of its pendulum flick (0.25 s opposite stick at half
  // throttle, then full lock and throttle) reaches 8.4-9.2 deg of rear slip
  // (measured over 30-120 Hz), and the default latch took that for a slide
  // being caught — the tail never came out (lab lateCatch,
  // flick.v<8|10>.half: 3-9 deg peak; now 32 deg, held 28). THIN MARGIN:
  // the swing itself reaches 8.4-9.2, so the latch is up to ~65 % armed
  // during the flick that now works; the 10 deg catches need it fully armed
  // at 10 (9 with span 3 broke them at 12 m/s). Every imposed 10-50 deg
  // catch still latches (lateCatch.staysCaught 0 of 28 at 30 / 60 / 90 /
  // 120 Hz). Gated: lateCatch.flick.halfThrottle (8 and 10 m/s at >= 60 Hz;
  // at 30 Hz only 8 m/s works, with the latch off as well: the car).
  // (8.5 -> 9: at 10 m/s the first swing is 8.50-8.53 deg at
  // 60-120 Hz — no margin at 8.5, 0.47 deg at 9; at 8 m/s it reaches
  // 9.04-9.16 and the flick still holds 28.6 deg; staysCaught 0 of 28 at
  // 30 / 60 / 90 / 120 Hz, far side at most 8.5 deg.)
  'neon-wasp': {
    label: 'Agile',
    description: 'Light and darty. The tail steps out early and far - quick hands rewarded.',
    scale: {
      minTurnRadius: 0.9,
      steerRate: 1.15,
      yawInertiaScale: 0.9,
      rearGripScale: 0.975,
      powerSlideLoss: 1.15,
    },
    set: { powerOver: 0.5, catchLatchAngle: 9, catchLatchSpan: 1 },
    powerOver: { v12: [20, 35], v15: [20, 35], v18: [0, 6] },
  },
  // Heaviest car on the biggest, equal-size tires: most grip, least drama.
  // Needs a deliberate hand to rotate (a lift-flick takes ~1.6 s to reach
  // 15 deg against ~1.1 s on REEF ROCKET). The slide assists are left at
  // their defaults: damping them further made the flick fail at some frame
  // rates (lab: 7 deg peak at 30 / 90 / 120 Hz).
  // powerOver 0.3: not enough to step out in a steady corner (1 deg at
  // 12 m/s; 0.5 would), but it lets a flick or a brake tap get the tail out
  // (without it both stalled at 4-6 deg). wheelspinGripLossSpeed 11: with
  // its grip the donut from rest otherwise runs out to a 13 m circle.
  'riot-ram': {
    label: 'Planted',
    description: 'Heavy, grippy and calm. Hard to unsettle, slow to rotate, shrugs off rough ground.',
    scale: {
      grip: 1.06,
      minTurnRadius: 1.1,
      steerRate: 0.9,
      yawInertiaScale: 1.2,
      rearGripScale: 1.013,
    },
    set: { powerOver: 0.3, wheelspinGripLossSpeed: 11 },
    powerOver: { v12: [0, 6], v15: [0, 6], v18: [0, 6] },
  },
  // Long wheelbase, narrow fronts, huge rears: the fast one. Stable at speed,
  // strong traction out of corners, wants to be set up early for a turn.
  // powerOver 0.4: its own thrust already takes the rear to its peak when
  // floored at 12-15 m/s, but only just — with 0 it stepped out at four frame
  // rates and stopped at 6 deg at the fifth. 0.4 makes it the same at all.
  'comet-fox': {
    label: 'Fast',
    description: 'Long, stable and the quickest in a straight line. Huge traction; set it up early for corners.',
    scale: {
      maxSpeed: 1.08,
      driveFreeSpeed: 1.08,
      driveFadeSpeed: 1.08,
      driveAccel: 1.05,
      minTurnRadius: 1.12,
      yawInertiaScale: 1.1,
      rearGripScale: 1.03,
      powerSlideLoss: 0.9,
    },
    set: { powerOver: 0.4 },
    powerOver: { v12: [20, 35], v15: [20, 35], v18: [0, 6] },
  },
};

/** Model the presets are written for. */
export const HANDLING_MODEL = 'raycast';

/** Preset for a car id, or undefined (unknown ids drive on the defaults). */
export function handlingFor(carId: string): HandlingPreset | undefined {
  return HANDLING_PRESETS[carId];
}

/**
 * Apply a preset to a vehicle of the primary model. Multipliers act on the
 * values the vehicle has NOW, so call it once, right after construction.
 * Returns the keys that were changed (unknown keys are skipped, so a preset
 * can never break a model that lacks a knob).
 */
export function applyHandling(vehicle: Vehicle, preset: HandlingPreset): string[] {
  const changed: string[] = [];
  for (const [key, factor] of Object.entries(preset.scale)) {
    const base = vehicle.getTuning(key);
    if (base === undefined || factor === undefined) continue;
    if (vehicle.setTuning(key, base * factor)) changed.push(key);
  }
  for (const [key, value] of Object.entries(preset.set ?? {})) {
    if (typeof value === 'number' && vehicle.setTuning(key, value)) changed.push(key);
  }
  return changed;
}
