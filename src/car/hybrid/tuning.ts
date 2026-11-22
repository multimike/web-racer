import type { TuningParam } from '../Vehicle';
import type { VehicleRig } from '../rig';

/**
 * Every number the hybrid model can be tuned with. Geometry, masses, springs
 * and inertia are NOT here — they come from the `VehicleRig`.
 *
 * Forces are given as multiples of the car's weight ("G" suffix) so one set
 * of values carries over to a heavier or lighter rig unchanged.
 *
 * The defaults are the LOOSE setup: surplus power, a car that steps out on
 * the throttle and can be held there. Measured alternative, the PLANTED
 * setup — rearGrip 1.08, powerSpeed 14, DRIVE_TO_TRACTION 0.92 (driveG ≈
 * 0.80 on REEF ROCKET), diffLock 300: a flat-out lap of the hills goes from
 * ~45 % of the time off the road to ~20 % (4 terrain seeds), and the car can
 * no longer be made to slide on power at all.
 */
export interface HybridTuning {
  // --- tires ---------------------------------------------------------------
  /** Peak tire-road friction coefficient (declared `nominalGrip`). */
  grip: number;
  /** Per-axle multipliers on `grip`. Rear a touch above front = the car
   * pushes (understeers) at the limit on a neutral throttle and a slide
   * straightens itself; equal = neutral. */
  frontGrip: number;
  rearGrip: number;
  /** Longitudinal grip relative to lateral (friction ELLIPSE; 1 = circle). */
  longGrip: number;
  /** Share of peak grip a fully sliding REAR tire keeps (0.6 icy-snappy ..
   * 1 no fall-off at all). High = forgiving, a slide stays catchable. */
  slideGrip: number;
  /** Front tires' sliding grip relative to `slideGrip` (< 1: a car sliding
   * with both axles saturated turns its nose back into the direction of
   * travel — the self-straightening a real car gets from caster). */
  frontSlideScale: number;
  /** How far past the peak (in multiples of the peak slip) grip is halfway
   * down to `slideGrip`. Large = long, progressive breakaway. */
  slideFalloff: number;
  /** Slip angle at peak side force, degrees (6 racy .. 14 loose surface). */
  peakSlipAngleDeg: number;
  /** Side grip holds its peak from the knee (the peak slip angle) out to
   * `plateauWidth` × that angle, and only then starts to fall toward
   * `slideGrip` — the forgiving plateau. (Drive/brake grip falls straight
   * after the peak slip RATIO: spinning or locked wheels grip less.) */
  plateauWidth: number;
  /** OPTIONAL progressive side grip, default 0 = off: across the plateau a
   * tire gains up to this fraction MORE side force than `grip`·N. Measured
   * on the rear (0.25-0.4): slides straighten even faster (hands-off from
   * 35°: 0.50 → 0.25 s) and the car can no longer be drifted. */
  rearPlateauGain: number;
  frontPlateauGain: number;
  /** Rear peak slip angle relative to the front (< 1 = stiffer rear tires:
   * the rear answers first, which is what makes the car understeer mildly
   * and stay stable at speed; understeer gradient ≈
   * (frontAngle/frontGrip − rearAngle/rearGrip) / (1.5·grip·g)). */
  rearSlipAngleScale: number;
  /** Slip ratio at peak drive/brake force. */
  peakSlipRatio: number;
  /** Grip lost per unit of load above the static wheel load (real tires:
   * 0.1-0.2). Makes load transfer cost grip; 0 = pure Coulomb. */
  loadSensitivity: number;
  /** Tire relaxation length, m: distance rolled before side force has built
   * up. Also the low-speed "spring" that holds a parked car. */
  relaxationLength: number;
  /** Longitudinal relaxation length as a fraction of the lateral one. */
  longRelaxationScale: number;
  /** Carcass damping time constant, s (kills tire-spring ringing at rest and
   * wheel-spin shudder; does not change steady-state force). */
  tireDamping: number;
  /** Speed below which slip is measured against this speed instead of the
   * actual one, m/s (keeps the slip definition finite at standstill). */
  lowSpeed: number;
  /** Rolling resistance coefficient (force = this × wheel load). */
  rollingResistance: number;
  /** Wheel loads are capped at this multiple of the static load (landing
   * spikes must not turn into grip spikes). */
  maxLoadFactor: number;
  /** Time constant of the wheel-load low-pass, s (0 = unfiltered). */
  loadFilterTime: number;
  /** A wheel counts as touching when the ground is within radius + this, m. */
  groundTolerance: number;

  // --- drivetrain ------------------------------------------------------------
  /** Peak thrust / weight at full throttle. Per car this defaults to
   * `DRIVE_TO_TRACTION` × the straight-line traction limit of the driven
   * axle (see tractionLimitG). Above 1× the tires spin at full throttle
   * (launch with wheelspin, power slides); below 1× the car hooks up and
   * cannot be steered on the throttle. */
  driveG: number;
  /** Rim speed above which thrust falls off as powerSpeed / rimSpeed, m/s —
   * the engine's power limit. Below it the car has full `driveG` (power
   * slides in slow corners); above it there is progressively less torque to
   * break the rear loose, and wheelspin limits itself instead of running
   * away to the rev limiter. 0 = flat torque all the way. */
  powerSpeed: number;
  /** Rim speed the drivetrain tops out at, m/s. */
  topSpeed: number;
  /** Reverse speed cap as a fraction of topSpeed. */
  reverseSpeedFactor: number;
  /** Fraction of topSpeed over which thrust tapers to zero (rev limiter). */
  revTaper: number;
  /** Differential of a driven axle, as a viscous coupling between its two
   * wheels, N·m per rad/s of speed difference: `diffPreload` always, plus
   * `diffLock` × throttle. 0 / 0 = each wheel on its own (an unloaded
   * inside wheel spins up alone and the loaded outside one never breaks
   * loose — no power slide); ~2000 under power is close to a spool. */
  diffPreload: number;
  diffLock: number;
  /** Engine braking / weight on the driven wheels with the throttle shut. */
  engineBrakeG: number;
  /** Throttle travel over which engine braking fades to nothing. Wide =
   * thrust is a smooth function of the pedal around zero (a narrow fade is a
   * steep spot in the pedal that a speed-holding foot hunts around). */
  engineBrakeFade: number;

  // --- brakes ---------------------------------------------------------------
  /** Peak brake force / weight, all four wheels, at full pedal. */
  brakeG: number;
  /** Front share of the brake force (0.5-0.8). */
  brakeBias: number;
  /** ASSIST — anti-lock: 0 = off, 1 = full release when a wheel locks. */
  absStrength: number;
  /** Wheel slip (0 rolling .. 1 locked) where the anti-lock starts to act. */
  absSlip: number;
  /** Slip range over which it goes from nothing to full release. */
  absBand: number;
  /** Forward speed below which a fresh brake press means reverse, m/s. */
  reverseEngageSpeed: number;
  /** Seconds a brake press that stopped the car must be held before it turns
   * into reverse. 0 = never (release and press again; the brake then holds
   * the car on a slope). 0.01 ≈ the legacy "immediately". */
  reverseHoldDelay: number;
  /** ASSIST — parking hold: with no pedal pressed below `autoHoldSpeed` the
   * brakes come on with this force / wheel load (0 = off, car rolls freely). */
  autoHold: number;
  autoHoldSpeed: number;

  // --- steering --------------------------------------------------------------
  /** Turning radius at full lock, m, at the rear-axle centre. */
  minTurnRadius: number;
  /** How fast the steering angle chases the stick, rad/s. */
  steerResponse: number;
  /** ASSIST — lock shrinks with speed: lock / (1 + speed × this). 0 = off. */
  steerSpeedFalloff: number;

  // --- chassis ---------------------------------------------------------------
  /** Sprung CoM height above the ground and position ahead of the wheelbase
   * centre, m (defaults from the rig). */
  comHeight: number;
  comForward: number;
  /** Multiplier on the rig's yaw inertia estimate (1 = the rig's mass box).
   * The yaw acceleration of a sliding car is tire force × lever / yaw
   * inertia; at the game's gravity of 25 m/s² the tire forces are 2.5×
   * Earth's, so a slide builds and collapses 2.5× faster than the same car
   * would on Earth — faster than thumbs. A larger value slows every yaw
   * transient (slide onset, snap-back, also turn-in) without changing any
   * steady-state grip number. */
  yawInertiaScale: number;
  /** Aerodynamic drag, N per (m/s)². */
  aeroDrag: number;
  /** Friction of the chassis hull / roll cage against the world. */
  bodyFriction: number;
  /** Share of drive/brake torque reaction applied to the chassis (1 = real:
   * throttle lifts the nose in the air, brakes drop it; 0 = none). */
  torqueReaction: number;
  /** 1: chassis velocity is taken from the pose change over the last step;
   * 0: from the velocity Havok stores on the body. */
  poseVelocity: number;

  // --- assists (all non-physical, all 0 = off) --------------------------------
  /** In-air pitch/roll rate damping, 1/s, once airborne for
   * `airStabilityDelay` seconds. */
  airStability: number;
  airStabilityDelay: number;
  /** Tire forces act this fraction of the way up from the ground to the CoM
   * (0 = at the contact patch = real; 1 = no body roll or pitch at all). */
  rollAssist: number;
  /** Countersteer assist: share of the REAR slip angle (beyond
   * `slideAssistStartDeg`) that is added to the front wheels' steer angle,
   * toward the slide, up to `slideAssistMaxDeg`. Stands in for the caster
   * self-centring a thumbstick cannot feel. */
  slideAssist: number;
  slideAssistStartDeg: number;
  slideAssistMaxDeg: number;
}

/** Defaults, independent of the car (see hybridTuningForRig). */
export const DEFAULT_HYBRID_TUNING: HybridTuning = {
  grip: 1.2,
  frontGrip: 1.0,
  rearGrip: 1.04,
  longGrip: 1.0,
  slideGrip: 0.9,
  frontSlideScale: 1.0,
  slideFalloff: 3,
  peakSlipAngleDeg: 7,
  rearPlateauGain: 0,
  frontPlateauGain: 0,
  plateauWidth: 4,
  rearSlipAngleScale: 0.8,
  peakSlipRatio: 0.14,
  loadSensitivity: 0.1,
  relaxationLength: 0.3,
  longRelaxationScale: 0.25,
  tireDamping: 0.012,
  lowSpeed: 2.5,
  rollingResistance: 0.015,
  maxLoadFactor: 3.5,
  loadFilterTime: 0.03,
  groundTolerance: 0.06,

  driveG: 1.0,
  powerSpeed: 16,
  topSpeed: 25,
  reverseSpeedFactor: 0.5,
  revTaper: 0.08,
  diffPreload: 0,
  diffLock: 250,
  engineBrakeG: 0.1,
  engineBrakeFade: 0.5,

  brakeG: 1.5,
  brakeBias: 0.62,
  absStrength: 1,
  absSlip: 0.2,
  absBand: 0.15,
  reverseEngageSpeed: 0.5,
  reverseHoldDelay: 0,
  autoHold: 0,
  autoHoldSpeed: 0.4,

  minTurnRadius: 5,
  steerResponse: 12,
  steerSpeedFalloff: 0,

  comHeight: 0.5,
  comForward: 0,
  yawInertiaScale: 1,
  aeroDrag: 0.6,
  bodyFriction: 0.3,
  torqueReaction: 1,
  poseVelocity: 1,

  airStability: 8,
  airStabilityDelay: 0.05,
  rollAssist: 0,
  slideAssist: 0,
  slideAssistStartDeg: 6,
  slideAssistMaxDeg: 18,
};

/** Default thrust as a multiple of the straight-line traction limit:
 * 19 % more than the rear tires can put down, up to `powerSpeed`. */
export const DRIVE_TO_TRACTION = 1.19;

/**
 * Largest thrust / weight the driven axle can put down in a straight line on
 * level ground, load transfer included: x = mu·(share + x·h/L) for rear
 * drive → x = mu·share / (1 − mu·h/L)  (front drive: + in the denominator,
 * all-wheel drive: mu).
 */
export function tractionLimitG(rig: VehicleRig, mu: number): number {
  let mass = rig.sprungMass;
  let momentZ = rig.sprungMass * rig.com[2];
  let momentY = rig.sprungMass * rig.com[1];
  for (const w of rig.wheels) {
    mass += w.mass;
    momentZ += w.mass * w.z;
    momentY += w.mass * w.y;
  }
  const comZ = momentZ / mass;
  const h = momentY / mass;
  const L = rig.wheelbase;
  const rearShare = (rig.front.z - comZ) / L;
  const rearDriven = rig.wheels[2].driven;
  const frontDriven = rig.wheels[0].driven;
  if (rearDriven && frontDriven) return mu;
  if (rearDriven) return (mu * rearShare) / Math.max(0.2, 1 - (mu * h) / L);
  return (mu * (1 - rearShare)) / (1 + (mu * h) / L);
}

/** Tuning for one car: the defaults plus what depends on its geometry. */
export function hybridTuningForRig(rig: VehicleRig): HybridTuning {
  const d = DEFAULT_HYBRID_TUNING;
  return {
    ...d,
    comHeight: rig.com[1],
    comForward: rig.com[2],
    driveG: DRIVE_TO_TRACTION * tractionLimitG(rig, d.grip * d.rearGrip * d.longGrip),
  };
}

export const HYBRID_TUNING_PARAMS: TuningParam[] = [
  { key: 'grip', label: 'tire grip (peak mu)', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'frontGrip', label: 'front grip x', min: 0.6, max: 1.4, step: 0.01 },
  { key: 'rearGrip', label: 'rear grip x', min: 0.6, max: 1.4, step: 0.01 },
  { key: 'slideGrip', label: 'sliding grip share', min: 0.5, max: 1, step: 0.01 },
  { key: 'frontSlideScale', label: 'front sliding grip x', min: 0.6, max: 1.1, step: 0.01 },
  { key: 'slideFalloff', label: 'breakaway width', min: 0.2, max: 10, step: 0.1 },
  { key: 'peakSlipAngleDeg', label: 'peak slip angle (deg)', min: 3, max: 20, step: 0.5 },
  { key: 'peakSlipRatio', label: 'peak slip ratio', min: 0.04, max: 0.4, step: 0.01 },
  { key: 'loadSensitivity', label: 'load sensitivity', min: 0, max: 0.4, step: 0.01 },
  { key: 'rearSlipAngleScale', label: 'rear slip angle x', min: 0.5, max: 1.2, step: 0.01 },
  { key: 'driveG', label: 'thrust / weight', min: 0.2, max: 2, step: 0.05 },
  { key: 'powerSpeed', label: 'power knee (m/s, 0 = off)', min: 0, max: 30, step: 1 },
  { key: 'diffLock', label: 'diff lock under power', min: 0, max: 3000, step: 50 },
  { key: 'topSpeed', label: 'top speed (m/s)', min: 5, max: 40, step: 1 },
  { key: 'engineBrakeG', label: 'engine brake / weight', min: 0, max: 0.5, step: 0.01 },
  { key: 'brakeG', label: 'brake / weight', min: 0.3, max: 3, step: 0.05 },
  { key: 'brakeBias', label: 'brake bias (front)', min: 0.3, max: 0.9, step: 0.01 },
  { key: 'absStrength', label: 'ABS (0 = off)', min: 0, max: 1, step: 0.05 },
  { key: 'minTurnRadius', label: 'turn radius (m)', min: 2, max: 12, step: 0.25 },
  { key: 'steerResponse', label: 'steer response (rad/s)', min: 1, max: 30, step: 0.5 },
  { key: 'steerSpeedFalloff', label: 'steer speed falloff', min: 0, max: 0.2, step: 0.005 },
  { key: 'comHeight', label: 'CoM height (m)', min: 0.1, max: 1.2, step: 0.01 },
  { key: 'comForward', label: 'CoM fwd/back (m)', min: -0.8, max: 0.8, step: 0.02 },
  { key: 'yawInertiaScale', label: 'yaw inertia x', min: 0.5, max: 5, step: 0.1 },
  { key: 'torqueReaction', label: 'torque reaction', min: 0, max: 1, step: 0.05 },
  { key: 'airStability', label: 'air stability (0 = off)', min: 0, max: 20, step: 0.5 },
  { key: 'rollAssist', label: 'roll assist (0 = off)', min: 0, max: 1, step: 0.05 },
  { key: 'slideAssist', label: 'countersteer assist (0 = off)', min: 0, max: 1.5, step: 0.05 },
  { key: 'reverseHoldDelay', label: 'hold-to-reverse (s, 0 = re-press)', min: 0, max: 2, step: 0.05 },
  { key: 'autoHold', label: 'parking hold (0 = off)', min: 0, max: 1, step: 0.05 },
];
