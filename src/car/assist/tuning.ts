import type { TuningParam } from '../Vehicle';
import type { VehicleRig } from '../rig';

/**
 * Tuning of the 'assist' vehicle model (AssistedRigidVehicle).
 *
 * Everything that is a FORCE is expressed per unit of car weight ("…G":
 * 1.0 = a force equal to the weight of the whole car under scene gravity),
 * so one tuning object fits every rig: torques are derived from it with the
 * rig's mass and that axle's tire radius. Angles are degrees, times seconds,
 * speeds m/s.
 *
 * What is REAL and what is an ASSIST is marked on every block. Every assist
 * has an on/off (0 = off) and a bound, so it can be A/B-ed live
 * (`?tune=key:value` in the physics lab, `setTuning` in the game).
 */
export interface AssistTuning {
  // --- Tires ---------------------------------------------------------------
  /** REAL. Peak friction coefficient of the tire model — the grip the car is
   * declared to have (`Vehicle.nominalGrip`). */
  tireGrip: number;
  /** REAL. Havok friction on the wheel colliders. This is the force an
   * outright SLIDING tire delivers (Coulomb), i.e. the sliding grip. */
  contactFriction: number;
  /** REAL (tire model). Slip angle at which the front / rear tires peak, deg.
   * Slip ratio peaks at tan() of it, so combined slip is isotropic like
   * Coulomb. Front > rear = understeer below the limit. */
  peakSlipFrontDeg: number;
  peakSlipRearDeg: number;

  /** REAL (tire model). Share of peak grip the tire model keeps when sliding
   * outright (it sets how much side force the friction-circle cut leaves a
   * spinning wheel). */
  slideGripShare: number;

  /** EXPERIMENT. Width of the wheel COLLIDER as a share of the tire width
   * (a flat cylinder that leans touches down on one edge). Measured at 0.5:
   * frame-rate checks 9/9 and a cleaner boulder strike, but the 14 s
   * hands-off launch drifts 1-5° and the drift driver loses three of four
   * initiations — so it stays at 1 (full width). */
  treadWidthShare: number;
  /** SOLVER AID. Factor on the wheels' rotational inertia ACROSS the axle
   * (not the spin inertia). 1 = a real wheel; larger values let Havok hold
   * the steering and camber locks rigid at speed. */
  wheelInertiaScale: number;

  // --- Grip assist: lateral force per axle, tire model vs MEASURED contact
  /** ASSIST gain for both corrections below, 0 = off (pure Havok friction),
   * 1 = correct the whole measured difference. */
  gripAssist: number;
  /** ADD: most lateral force that may be added per axle where the contact
   * delivers LESS than the tire model, as a share of that axle's mu·N.
   * Default 0 = off: with the steering held rigid the contact does not fall
   * short any more (30-120 Hz), and at 0.7 this correction cost 1.5 points
   * and two frame-rate checks on the default rig. */
  gripAssistMax: number;
  /** CUT (friction circle): most lateral force that may be removed per axle
   * where a spinning or locked wheel keeps MORE side force than the tire
   * model allows, as a share of mu·N. Only while steering or sliding. This
   * is what makes power oversteer possible (off: drift score 16 / 100). */
  gripAssistCut: number;
  /** Low-pass on the measured contact force, s. */
  gripAssistTau: number;
  /** The assist fades in between this speed and twice this speed, m/s. */
  gripAssistMinSpeed: number;
  /** Height the assist force is applied at: 0 = at the ground (what a real
   * tire does — full body roll), 1 = at CoM height (no roll moment). */
  gripAssistHeight: number;

  // --- Drivetrain ----------------------------------------------------------
  /** REAL. Peak thrust at full throttle / car weight (rear wheels together). */
  driveG: number;
  /** REAL. Rim speed the drivetrain tops out at, m/s. */
  maxSpeed: number;
  reverseSpeedFactor: number;
  /** REAL. Engine braking with the throttle closed / car weight. */
  engineBrakeG: number;
  /** ASSIST (traction control). Wheelspin the driven wheels are allowed at
   * FULL throttle: rim speed may exceed ground speed by
   * `driveSlipBase + driveSlipRatio · speed` (never above maxSpeed). The
   * slip ratio sets how far the tail steps out on power: with friction-
   * circle tires the steady drift angle is ≈ atan(ratio · q/√(1−q²)) with
   * q² = 1/(1 + 1.85·ratio) — about 27° at 0.5 and 33° at 0.75. */
  driveSlipBase: number;
  driveSlipRatio: number;
  /** Shape of slip allowance vs throttle: allowance ∝ throttle^curve.
   * > 1 keeps part throttle hooked up and puts the slide at the end of the
   * trigger travel. */
  driveSlipCurve: number;
  /** ASSIST. Brake/weight applied by itself below walking pace with no pedal
   * pressed; once stopped (also with the brake held) the wheel motors hold
   * the wheels' ANGLE until throttle or reverse — the car stays put on a
   * slope. 0 = off. */
  idleHoldG: number;

  // --- Brakes --------------------------------------------------------------
  /** REAL. Peak brake force / car weight (all four wheels). */
  brakeG: number;
  /** REAL. Share of the brake force on the front axle. */
  brakeBiasFront: number;
  /** ASSIST (ABS). Slip ratio the brakes hold instead of locking: wheel rim
   * speed is held at (1 − slip) × ground speed. 1 = lock up (no ABS). */
  absSlipFront: number;
  absSlipRear: number;
  /** 0: a brake press that STOPPED the car keeps holding it (release and
   * press again to reverse). 1: legacy — a held brake turns into reverse as
   * soon as the car has stopped. */
  reverseOnHeldBrake: number;

  // --- Steering ------------------------------------------------------------
  /** REAL. Turning radius at full lock (rear-axle centre), m. */
  minTurnRadius: number;
  /** REAL. Steering rack speed, rad/s. */
  steerResponse: number;
  /** SOLVER AID. Rate (1/s) at which the commanded steering limit is trimmed
   * until the hub really sits at the asked angle (Havok's angular limit
   * yields under tire load). 0 = off (legacy: hubs fall short at speed). */
  steerTrimRate: number;
  /** ASSIST. 0..1: grip-shaped steering map (speed-sensitive steering).
   * The stick → steer-angle map leaves room for the front tires' slip
   * angle: at speed the response softens progressively toward the grip
   * limit instead of running into it (see shapedSteer). Computed from
   * TOTAL planar speed. 0 = linear map, full lock at any speed.
   * Default 0: the lab's path-following driver scored 91.2 with it against
   * 96 without (slalom 18 vs 20 m/s, skidpad weave) — it shortens the
   * countersteer too. Worth an A/B on a real thumbstick, where 9° of lock
   * is the whole grip range at 20 m/s. */
  steerShaping: number;
  /** REAL-ish. Steering compliance: degrees the front wheels give way at
   * full front side load (linear in the measured contact force, low-passed
   * by steerComplianceTau seconds). Understeer gradient + softer force
   * transients, like tire slip angle. 0 = rigid. */
  steerCompliance: number;
  steerComplianceTau: number;
  /** ASSIST. Largest slip angle the steering will hold the front tires at,
   * deg (the wheels are never turned further past their direction of
   * travel than this — hands-off in a slide they follow it, like caster).
   * 0 = off (default). Measured at 12: slide caught 8.5 m / 11° off line
   * instead of 9.8 m / 13°, power-slide counter-swing 12° instead of 9°;
   * at 10 the power-over no longer reaches 15°. */
  steerSlipLimitDeg: number;

  // --- Slide assists -------------------------------------------------------
  /** ASSIST. Slide-angle damper: a yaw moment that resists CHANGES of the
   * body slip angle while the car is sliding on the throttle, so a drift
   * neither snaps straight nor spins faster than a human can react. Rate:
   * N·m per rad/s of slip-angle change, per unit of (mass · wheelbase²).
   * 0 = off. */
  slideDamp: number;
  /** Bound of the slide-angle damper: yaw moment / (weight · wheelbase). */
  slideDampMax: number;
  /** Throttle at which the damper starts to get full authority (reaches it
   * 0.25 later), and the share of authority it keeps off the throttle. */
  slideDampThrottle: number;
  slideDampLift: number;
  /** A slide that is still growing is resisted only from this rear slip
   * angle (full resistance at twice it), deg — below it the tail is free
   * to step out. */
  slideDampGrowDeg: number;
  /** Rear slip angle where the damper starts / has full authority, deg. */
  slideDampOnDeg: number;
  slideDampFullDeg: number;
  /** ASSIST. Catch help: yaw moment toward the direction of travel while
   * the driver is off the throttle and countersteering, per rad of body
   * slip, as a share of (weight · wheelbase). 0 = off. */
  catchAssist: number;
  /** Bound of the catch help: yaw moment / (weight · wheelbase). */
  catchAssistMax: number;

  // --- Body control --------------------------------------------------------
  /** REAL. Anti-roll bar rate as a share of that axle's spring rate.
   * Default 0: at 0.5 / 0.3 the attacking hill lap rolled the car once. */
  antiRollFront: number;
  antiRollRear: number;
  /** ASSIST. Time constant with which pitch/roll rotation is damped while
   * the car is in the air (ground carries < 8 % of its weight), s. 0 = off. */
  airDampTime: number;
  /** ASSIST. While airborne, how strongly the car is levelled toward the
   * horizon (pitch and roll), 1/s² per rad. 0 = off. */
  airLevel: number;
  /** Bound of both air assists: angular acceleration, rad/s². */
  airMaxAccel: number;

  /** Developer switch: 1 = append per-frame rows to globalThis.__assistLog. */
  debugLog: number;
}

export const DEFAULT_ASSIST_TUNING: AssistTuning = {
  tireGrip: 1.2,
  contactFriction: 1.2,
  peakSlipFrontDeg: 8,
  peakSlipRearDeg: 5.5,
  slideGripShare: 0.9,
  treadWidthShare: 1,
  wheelInertiaScale: 4,

  gripAssist: 1,
  gripAssistMax: 0,
  gripAssistCut: 0.7,
  gripAssistTau: 0.05,
  gripAssistMinSpeed: 2,
  gripAssistHeight: 0,

  driveG: 1.1,
  maxSpeed: 25,
  reverseSpeedFactor: 0.5,
  engineBrakeG: 0.12,
  driveSlipBase: 1.5,
  driveSlipRatio: 0.75,
  driveSlipCurve: 1,
  idleHoldG: 0.4,

  brakeG: 1.6,
  brakeBiasFront: 0.6,
  absSlipFront: 0.15,
  absSlipRear: 0.1,
  reverseOnHeldBrake: 0,

  minTurnRadius: 5,
  steerResponse: 12,
  steerTrimRate: 10,
  steerShaping: 0,
  steerCompliance: 5,
  steerComplianceTau: 0.12,
  steerSlipLimitDeg: 0,

  slideDamp: 6,
  slideDampMax: 0.25,
  slideDampThrottle: 0.3,
  slideDampLift: 0.3,
  slideDampGrowDeg: 12,
  slideDampOnDeg: 6,
  slideDampFullDeg: 12,
  catchAssist: 0.5,
  catchAssistMax: 0.15,

  antiRollFront: 0,
  antiRollRear: 0,
  airDampTime: 0.08,
  airLevel: 60,
  airMaxAccel: 60,

  debugLog: 0,
};

/** Per-car tuning. All forces are weight-relative, so the defaults carry
 * over; this is the place for per-design exceptions. */
export function assistTuningForRig(_rig: VehicleRig): AssistTuning {
  return { ...DEFAULT_ASSIST_TUNING };
}

export const ASSIST_TUNING_PARAMS: TuningParam[] = [
  { key: 'tireGrip', label: 'tire grip (peak mu)', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'contactFriction', label: 'sliding grip (contact mu)', min: 0.3, max: 2.5, step: 0.05 },
  { key: 'peakSlipFrontDeg', label: 'peak slip front (deg)', min: 2, max: 16, step: 0.5 },
  { key: 'peakSlipRearDeg', label: 'peak slip rear (deg)', min: 2, max: 16, step: 0.5 },
  { key: 'gripAssist', label: 'grip assist (0 = off)', min: 0, max: 1, step: 0.05 },
  { key: 'gripAssistMax', label: 'grip assist bound', min: 0, max: 1, step: 0.05 },
  { key: 'driveG', label: 'thrust / weight', min: 0.2, max: 2, step: 0.05 },
  { key: 'maxSpeed', label: 'max speed', min: 5, max: 40, step: 1 },
  { key: 'engineBrakeG', label: 'engine brake / weight', min: 0, max: 0.5, step: 0.01 },
  { key: 'driveSlipRatio', label: 'power slide (wheelspin ratio)', min: 0, max: 1.5, step: 0.05 },
  { key: 'driveSlipCurve', label: 'slide vs throttle curve', min: 0.5, max: 4, step: 0.1 },
  { key: 'brakeG', label: 'brake / weight', min: 0.4, max: 3, step: 0.05 },
  { key: 'brakeBiasFront', label: 'brake bias front', min: 0.3, max: 0.9, step: 0.02 },
  { key: 'absSlipFront', label: 'ABS slip front (1 = off)', min: 0.05, max: 1, step: 0.05 },
  { key: 'absSlipRear', label: 'ABS slip rear (1 = off)', min: 0.05, max: 1, step: 0.05 },
  { key: 'minTurnRadius', label: 'turn radius (m)', min: 2, max: 12, step: 0.25 },
  { key: 'steerResponse', label: 'steer response', min: 1, max: 30, step: 0.5 },
  { key: 'steerShaping', label: 'grip-shaped steering (0 = off)', min: 0, max: 1, step: 0.05 },
  { key: 'steerCompliance', label: 'steering compliance (deg)', min: 0, max: 12, step: 0.5 },
  { key: 'steerSlipLimitDeg', label: 'front slip limit (0 = off)', min: 0, max: 30, step: 1 },
  { key: 'slideDamp', label: 'slide-angle damper (0 = off)', min: 0, max: 12, step: 0.25 },
  { key: 'slideDampLift', label: 'slide damper off-throttle share', min: 0, max: 1, step: 0.05 },
  { key: 'catchAssist', label: 'catch help (0 = off)', min: 0, max: 2, step: 0.05 },
  { key: 'antiRollFront', label: 'anti-roll front', min: 0, max: 2, step: 0.05 },
  { key: 'antiRollRear', label: 'anti-roll rear', min: 0, max: 2, step: 0.05 },
  { key: 'airDampTime', label: 'air damping time (0 = off)', min: 0, max: 1, step: 0.01 },
  { key: 'airLevel', label: 'air levelling', min: 0, max: 60, step: 1 },
];
