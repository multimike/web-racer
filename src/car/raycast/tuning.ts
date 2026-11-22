import type { DriverParams } from '../DriverModel';
import type { TuningParam } from '../Vehicle';

/**
 * Tuning of the 'raycast' vehicle model (RaycastVehicle.ts).
 *
 * Everything is expressed in units that do not depend on the car: fractions
 * of the car's weight ("g" = the SCENE gravity, 25 m/s² in the game), ratios
 * of critical damping, multiples of the spring rate, degrees, metres. The
 * model turns them into newtons and newton-metres from the `VehicleRig`
 * (mass, wheelbase, track, per-axle tire radius, CoM), so ONE tuning object
 * drives REEF ROCKET, RIOT RAM and COMET FOX.
 *
 * Entries marked ASSIST are deliberately non-physical helpers. Each one is
 * bounded and has a documented OFF value, so the owner can A/B it live
 * (`?tune=key:value` in the physics lab, `car.setTuning(key, value)` in the
 * console).
 */
export interface RaycastTuning {
  // ------------------------------------------------------------------ tires
  /** Reference grip coefficient μ of the car: what `Vehicle.nominalGrip`
   * declares, what drivers/AI plan with and what the lab normalises
   * against. The TIRE peak coefficient of an axle at its static load is
   * grip × the axle's scale below. */
  grip: number;
  /** Per-axle multipliers on μ (tire peak / declared grip). Both are above
   * 1 so that the car as a whole reaches ≈ 0.9 × grip × g on a skidpad after
   * load-sensitivity and combined-slip losses. The rear tires are wider on
   * every design: ~5 % more rear grip is what makes the car push
   * (understeer) at the limit instead of spinning, and weathervane out of a
   * slide. */
  frontGripScale: number;
  rearGripScale: number;
  /** Load sensitivity: fraction of μ lost per 100 % of extra wheel load
   * (real tires: 0.1-0.2). Makes lateral load transfer cost grip, so the
   * anti-roll split below actually tunes the balance. */
  loadSensitivity: number;
  /** Slip angle of peak side force, degrees (front / rear). Large values =
   * a wide, forgiving peak; rear < front keeps the rear the stiffer axle. */
  peakSlipAngleFront: number;
  peakSlipAngleRear: number;
  /** Slip ratio of peak longitudinal force (0.1-0.2). */
  peakSlipRatio: number;
  /** Share of peak grip left when the tire is sliding outright (front /
   * rear). 1 = no falloff. The falloff past the peak is what makes a slide
   * "let go"; keeping it mild keeps slides catchable. */
  slideGripFront: number;
  slideGripRear: number;
  /** Grip burned off by a driven tire that is spinning under power WHILE it
   * slides sideways, 0..1: its friction limit is multiplied by
   * (1 − value × spin × side), spin ramping from the peak slip ratio to 4×
   * it, side from 0.5× to 1.5× the peak slip angle. A plain friction circle
   * only trades side force for thrust, so a held slide always accelerates
   * out of itself; with this, power in a slide costs total grip and a drift
   * can sit at a steady speed. Straight-line traction is untouched.
   * ASSIST-ish feel knob (loose-surface tires do this to a degree). 0 = pure
   * friction circle.
   * It is a LOW-SPEED effect — donuts and hairpin power slides: it is in
   * full below `wheelspinGripLossSpeed` m/s and gone 4 m/s above it. (At
   * drift speeds the motor spins the tires harder the slower the car goes,
   * so a deep drift that lost a little speed lost grip and thrust with it
   * and wound itself down into a donut. There `powerSlideLoss` is the
   * throttle's hold on the rear and `slideScrub` sets the speed.) */
  wheelspinGripLoss: number;
  wheelspinGripLossSpeed: number;
  /** ASSIST — throttle-proportional rear grip loss in a slide, 0..0.9: once
   * a REAR tire is past its peak slip angle (ramping in over the next
   * `powerSlideSpan` × the peak angle) its friction limit is multiplied by
   * (1 − powerSlideLoss × throttle'), throttle' running 0..1 from
   * `powerSlideFrom` to full throttle. Unlike `wheelspinGripLoss` it does not
   * need the motor to actually spin the tire, so the throttle keeps its hold
   * on the slide angle at any speed: more throttle = looser rear = more
   * angle, lift = the rear grips and the car straightens. Below the peak
   * slip angle (all grip driving, including the limit) it does nothing.
   * 0 = off. */
  powerSlideLoss: number;
  powerSlideFrom: number;
  /** THE STICK SETS HOW DEEP. Rear slip angle (degrees) up to which
   * `powerSlideLoss` acts in full: `powerSlideMinAngle` with the stick
   * centred or against the turn, rising in proportion to `powerSlideMaxAngle`
   * with the stick fully INTO it. Past that angle the rear gets its grip
   * back over the next `powerSlideFade` degrees, foot down or not.
   * A drift therefore settles ON that fade, where a deeper slide means MORE
   * rear grip — a stable angle for every stick position: about 10-14° of
   * body slip at a quarter stick, 15-21° at half, 20-26° at three quarters,
   * 26-28° at full stick (lab, 60-100 % throttle). It is also why a held
   * throttle cannot open a slide into a spin, and why centring the stick
   * ends a drift: the rear grips again from `powerSlideMinAngle` on.
   * (Before this the loss did not depend on the stick: only the front
   * wheels set the angle, the rear's grip FELL with the angle between 8 and
   * 16°, and no drift shallower than ~15° was stable.) */
  powerSlideMaxAngle: number;
  powerSlideMinAngle: number;
  powerSlideFade: number;
  /** Seconds the rear takes to get its full grip back after the throttle is
   * lifted from full (the grip loss follows the throttle up at once, and
   * comes back down at powerSlideLoss / this per second). With 0 the grip is
   * back within one sub-step and a lift snaps the slide shut in 0.2 s; with
   * ~0.5 the driver feels the rear come back. A latched catch (opposite
   * lock, see `catchLatch`) does not wait for it. */
  slideGripRecovery: number;
  /** Width of the ramp over which `powerSlideLoss` comes in, in multiples
   * of the rear peak slip angle (1 = fully in at twice the peak angle).
   * Wider = the rear lets go more gradually: shallow drifts (10-15 deg) are
   * stable instead of running on to the deep one. */
  powerSlideSpan: number;
  /** POWER-OVER TRAIT, 0..1 — per car, see handling.ts. When the FRONT
   * tires are already past their peak slip angle (the driver is asking for
   * more turn than the car has: it pushes) and the throttle is above
   * `powerOverFrom`, the rear starts to let go this far BELOW its own peak
   * slip angle (1 = from zero slip at full throttle). 0 = the car just
   * pushes wide under power until something else (a lift, a flick, the
   * brake, a slow corner with real wheelspin) gets the tail out. Above
   * ~0.5 flooring it with plenty of lock in a fast corner steps the tail
   * out, the more the higher. A deliberate, frame-rate independent trait —
   * it does not depend on the motor spinning the tires for an instant. */
  powerOver: number;
  powerOverFrom: number;
  /** SLIDE SCRUB — extra drag while the rear slides, as deceleration =
   * slideScrub · v² (1/m, like aeroDrag), fading in between 8 and 18 deg of
   * rear slip. A drift is a slow way round a corner: without it a held
   * part-throttle drift keeps accelerating to the motor's limit (lab: 15 →
   * 22 m/s, radius 27 m — too wide for the road). With it a held drift
   * settles at a speed where the car stays on a medium bend. 0 = off.
   * It is proportional to the THROTTLE (it only takes away the thrust that
   * would otherwise run the drift up to the motor's limit: lifting never
   * adds braking) and eases off to the share `slideScrubDeep` between 17
   * and 29° of rear slip — a deep slide already drags itself down, the rear
   * side force pointing further and further backward.
   * Lab, after 10 s at fixed inputs: half stick 16-19 m/s on a 13-17 m
   * radius, three-quarter stick 13-17 m/s on 9-19 m, full stick at full
   * throttle 12-15 m/s on 10-15 m. */
  slideScrub: number;
  slideScrubDeep: number;
  /** Tire relaxation lengths, m (sideways / longitudinal): distance rolled
   * before the force follows a slip change. They also set the tire's
   * spring at rest — that spring is what holds the car on a slope with the
   * brake on, and how far it rocks back after braking to a stop. */
  relaxationLength: number;
  relaxationLengthLong: number;
  /** Damping ratio of the tire spring at standstill (kills the rocking on
   * the tire springs when stopping); fades out by `lowSpeedFade` m/s. */
  lowSpeedDamping: number;
  lowSpeedFade: number;
  /** Rolling resistance coefficient (force / wheel load). */
  rollingResistance: number;

  // ------------------------------------------------------------- drivetrain
  /** Thrust / weight at full throttle from standstill up to a rim speed of
   * `driveFadeSpeed` m/s; from there the thrust falls linearly (electric
   * motor torque line) and would reach zero at `driveFreeSpeed` m/s (which
   * must be above `maxSpeed`). The shape decides WHERE the car can be
   * power-slid: plenty of thrust in slow corners, not enough left to break
   * the rear loose in fast ones. Throttle scales TORQUE, never a target
   * speed. */
  driveAccel: number;
  driveFadeSpeed: number;
  driveFreeSpeed: number;
  /** Rev limiter: rim speed the drivetrain tops out at, m/s (full throttle). */
  maxSpeed: number;
  /** Width of the rev limiter, m/s: torque fades to zero over this band
   * below maxSpeed. */
  limiterBand: number;
  /** ASSIST — wheelspin limiter (a traction control with a generous,
   * throttle-proportional allowance): drive torque fades out as the rim
   * speed of a driven wheel exceeds its ground speed by more than
   * `wheelspinLimit` × throttle (slip ratio). Without it a floored throttle
   * spins the rear tires to the rev limiter in ~0.1 s and ALL rear side
   * grip is gone at once (unreactable). With it the side grip lost follows
   * the trigger: more throttle = more slip = more drift angle. 0 = off. */
  wheelspinLimit: number;
  /** Reverse speed cap as a fraction of maxSpeed. */
  reverseSpeedFactor: number;
  /** Engine/motor drag on the driven wheels with the throttle closed, as
   * deceleration in g; it fades out linearly as the throttle opens to
   * `engineBrakeFade` (no step at the bite point). Gives lift-off rotation. */
  engineBrake: number;
  engineBrakeFade: number;
  /** Rotating inertia of motor + gears reflected to each driven wheel, as a
   * multiple of the wheel's own spin inertia. Slows wheelspin onset so the
   * throttle can be modulated (physical: reflected rotor inertia). */
  drivelineInertia: number;
  /** Differential locking rate of a driven axle, 1/s: how fast a left/right
   * wheel-speed difference is pulled together. 0 = open (equal torque),
   * 60+ ≈ spool. */
  diffLock: number;
  /** Aerodynamic drag: deceleration = aeroDrag · v² (1/m). */
  aeroDrag: number;

  // ------------------------------------------------------------------ brakes
  /** Total brake force / weight at full pedal, in g (above μ = can lock). */
  brakeDecel: number;
  /** Front share of the brake torque (0..1). */
  brakeBias: number;
  /** ASSIST — anti-lock: 1 = brake torque is released as a wheel passes its
   * peak slip (steering stays alive under full brake), 0 = wheels lock. */
  abs: number;
  /** ASSIST — parking brake: with both pedals released below 0.5 m/s all
   * four wheels are braked with this deceleration capacity (g) until a pedal
   * is touched, so the car does not roll away on a slope. 0 = off (rolls
   * like a real car). */
  parkBrake: number;
  /** Seconds the brake must be held at standstill, after braking to a stop,
   * before it turns into reverse — on ground flatter than
   * `autoReverseMaxSlope` only: on a hill the held brake keeps HOLDING the
   * car. 0 = never (release and press again, like an RC speed controller).
   * A brake press that STARTS at standstill is always reverse; a press that
   * starts while the car is moving in ANY direction is always a brake. */
  autoReverseDelay: number;
  /** The same wait when the stop came FROM SPEED — the car was faster than
   * `autoReverseFromSpeed` m/s at some point while this brake press was
   * held (a panic stop, a braking zone overshot to a standstill). Clearly
   * longer than `autoReverseDelay`, so a trigger that is simply kept down
   * after an emergency stop does not shoot the car backward; 0 = it never
   * does, the brake must be released and pressed again. */
  autoReverseDelayFromSpeed: number;
  autoReverseFromSpeed: number;
  /** Seconds over which the reverse thrust comes in when a HELD brake turns
   * into reverse (either wait above). The trigger is still fully down from
   * the stop, so without it the car backs away at full thrust the moment
   * the wait is over (lab: 9-13 m/s backward 0.8 s later). A brake pressed
   * at standstill — a deliberate reverse — is not ramped. 0 = no ramp. */
  autoReverseRamp: number;
  /** Steepest slope (degrees, fore-aft) on which a held brake still turns
   * into reverse after `autoReverseDelay`; steeper than this it keeps
   * HOLDING the car. 0 = no slope test. */
  autoReverseMaxSlope: number;

  // ---------------------------------------------------------------- steering
  /** Turning radius of the rear-axle centre at full lock, m (bicycle model:
   * full lock = atan(wheelbase / radius)). */
  minTurnRadius: number;
  /** How fast the road wheels chase the stick, rad/s. */
  steerRate: number;
  /** ASSIST — speed-sensitive lock. Full stick asks for a lateral
   * acceleration of `steerGripMargin` × μ·g (kinematically, v²·tanδ/L) plus
   * `steerSlipReserve` degrees of extra angle; below the speed where that
   * exceeds full lock, full lock applies. Keeps the whole stick travel
   * useful at speed. 0 = off: fixed-angle steering at any speed. */
  steerGripMargin: number;
  steerSlipReserve: number;
  /** ASSIST — slide steering ("gyro"), 0..1 blend. While the REAR axle is
   * sliding (its slip angle past `counterSteerStart` degrees, fully active
   * 6° later, held for `counterSteerRelease` s after it hooks up again) the
   * stick stops being an absolute wheel angle and sets the FRONT SLIP ANGLE
   * instead — where the wheels point relative to the direction the front
   * axle is actually travelling:
   *  - stick centred: `counterSteerNeutral` × the feed angle below (0 = the
   *    wheels simply follow the slide, like a steering wheel you let go of);
   *  - stick INTO the turn: up to `counterSteerSlip` degrees inside the
   *    direction of travel with the throttle closed, rising to
   *    `counterSteerSlipPower` degrees by `counterSteerPowerFull` throttle
   *    (off the throttle = straighten, on it = you feed the slide);
   *  - stick AGAINST the turn: a countersteer of up to `counterSteerCap`
   *    degrees past the direction of travel that is UNWOUND as the slide
   *    closes at the pace the stick asks for (`slideCatchRate`) — held
   *    blindly it slams the slide shut and through to the other side: a
   *    tire gives ~85 % of its side force at 40 % of its peak slip angle;
   *  - in every case `counterSteerAngleGain` degrees are taken off per degree
   *    of rear slip, so each stick position settles at its own slide angle.
   * How to drift with it: get the tail out (flick, brake tap, lift, or power
   * in a slow corner), then keep steering where you want to go and stay on
   * the throttle; ease either one and the car straightens.
   * Plain cornering (rear gripping) is untouched. 0 = off: raw steering. */
  counterSteerAssist: number;
  counterSteerStart: number;
  counterSteerSlip: number;
  counterSteerSlipPower: number;
  /** Largest countersteer (degrees past the direction of travel) the slide
   * steering uses. Small on purpose: 4° is ~85 % of the front tires' side
   * force, and the servo unwinds it as the slide closes. 0 is NOT "off":
   * it is read as the default 4 (the panel's slider starts at 1). */
  counterSteerCap: number;
  counterSteerRelease: number;
  /** Share (0..1) of the feed angle the wheels keep with the stick CENTRED
   * during a slide. 0 = pure caster: hands off the stick, the front wheels
   * follow the slide and the car straightens. It is the offset of the whole
   * into-the-turn half of the stick: more = deeper for the same stick. */
  counterSteerNeutral: number;
  /** Throttle from which the centre-stick feed above fades in (it is fully
   * there half a trigger further on). Below it a centred stick is pure
   * caster: lift to part throttle, let go of the stick, and the car
   * straightens (lab: stick centred at 20-39 % throttle, 25° slide: under
   * 5° in 0.3-0.5 s). */
  counterSteerNeutralFrom: number;
  /** WHO IS HOLDING THE SLIDE. The centre-stick feed above and the
   * throttle's hold on a closing slide (`slideHoldThrottle`) only apply to a
   * slide the driver FEEDS: stick into the turn (a quarter stick = fully)
   * with the foot down. `slideFeedMemory` is how long (s) that lasts after
   * the stick has left the turn — the thumb may wander through the centre
   * without the drift collapsing, but a stick that stays centred ends it
   * even with the trigger down.
   * `slideHoldUnfed` (0..1) is the share of both that a slide gets which
   * nobody feeds — the car was bumped by a rival, clipped a rock, or stepped
   * out with the stick centred. 0 (default) = it closes like a hands-off
   * slide whatever the throttle does: a player who is knocked sideways and
   * just keeps the trigger down keeps his heading (lab maneuver `bumped`:
   * 15-40° slides at 8-18 m/s, floored, stick centred: straight in 0.5-0.6 s
   * on average, heading changed by 4-5° on average and 18° at worst; one
   * wheel onto a rock with the foot down: 17-22° off course after 6 s). 1 =
   * as the drift round had it: the throttle alone keeps any slide open, and
   * that car is turned round 80-230° in 1-3 s (the rock: 60-210°).
   * `classicDrift` 1 implies 1. */
  slideFeedMemory: number;
  slideHoldUnfed: number;
  /** Opposite stick (0..1) at which the throttle's HOLD on a slide is gone
   * (see `slideHoldThrottle`): a little opposite lock on the throttle only
   * trims the slide, this much or more ends it whatever the foot does. */
  counterSteerHoldStick: number;
  /** Yaw-rate gyro on the front wheels, degrees of steer per rad/s: a slide
   * that OPENS is steered against, one that closes faster than the stick
   * and throttle allow (`slideCloseRate`) is steered back in. This is the
   * part of the closing-speed limit the front TIRES do; the yaw governor
   * (`slideYawDamping`) does the rest. 0 = off. */
  counterSteerRate: number;
  /** Degrees of feed angle taken off per degree of rear slip angle (the
   * "gyro gain"): the deeper the slide, the more the wheels are turned back
   * toward — and with the stick centred, past — the direction of travel.
   * This is what gives every stick position its own slide angle. 0 = off. */
  counterSteerAngleGain: number;
  /** Throttle at which the on-power feed angle (`counterSteerSlipPower`) is
   * fully available (linear from 0). */
  counterSteerPowerFull: number;
  /** Lag of the slide steering, s: the window follows the direction of
   * travel this much late. While a slide closes, the wheels therefore stay
   * a little further out than the direction of travel — a measured,
   * automatic countersteer that swings the nose back onto the line instead
   * of letting the line swing round to the nose. 0 = none. */
  counterSteerLag: number;
  /** Extra lock available to countersteer (assist + stick) beyond the
   * stick-only lock, as a multiple of full lock (≥ 1). */
  counterSteerLock: number;

  // -------------------------------------------------------------- suspension
  /** Multiplier on the rig's spring rates (the rig gives 2.5 Hz). */
  springScale: number;
  /** Damper, fraction of critical, compression / extension. */
  dampingBump: number;
  dampingRebound: number;
  /** Digressive compression damping: above `damperKneeSpeed` (m/s) the
   * compression damper only adds `damperKneeRatio` of its low-speed rate
   * (a blow-off valve: kerbs do not kick the chassis). */
  damperKneeSpeed: number;
  damperKneeRatio: number;
  /** Position-sensitive compression damping (hydraulic bump stop): over the
   * last `bumpZone` fraction of the bump travel an extra `bumpZoneDamping` ×
   * the compression rate ramps in — soaks up jump landings. */
  bumpZone: number;
  bumpZoneDamping: number;
  /** Bump-stop spring, multiple of the spring rate, past the bump travel. */
  bumpStopRate: number;
  /** Anti-roll bar rate per axle as a multiple of that axle's spring rate.
   * More front than rear = understeer balance, and a planted rear. */
  antiRollFront: number;
  antiRollRear: number;
  /** Cap on one wheel's suspension force, multiple of its static load. */
  maxSuspensionForce: number;
  /** ASSIST — height above the ground at which the tires' SIDE forces are
   * applied, as a fraction of the CoM height. 0 = at the contact patch
   * (physical: full body roll and full lateral load transfer). 0.3 = 30 %
   * less roll moment from cornering/sliding — a fake anti-roll that cannot
   * be had from springs, and the main defence against tripping over a bank
   * or kerb when sliding sideways. Longitudinal forces stay at the patch
   * (dive, squat and traction under load transfer are untouched). */
  tireForceHeight: number;
  /** How much of the fore-aft push of a contact normal that leans along the
   * wheel's heading (the face of a kerb, a washboard ripple, a boulder
   * flank) is passed on to the chassis. 1 = physical rigid wheel; lower =
   * the balloon tire envelops the edge instead of being punched back by
   * it. ASSIST when < 1. (Steady slopes are not affected: there the car is
   * pitched with the ground and the normal does not lean.) */
  obstacleDrag: number;

  // ------------------------------------------------------------------ assists
  /** ASSIST — air stabiliser: with all four wheels off the ground, pitch
   * and roll rates decay at this rate (1/s). Stops the nose-dive a short car
   * gets leaving a ramp lip at 25 m/s² gravity. 0 = off (ballistic). */
  airDamping: number;
  /** ASSIST — air levelling: with all four wheels off the ground the car is
   * turned toward level (roll AND pitch, about the shortest axis) with an
   * angular acceleration of `airLevel` × tilt (1/s² per radian, tilt counted
   * up to 70°), bounded by `airMaxAccel` rad/s². Together with `airDamping`
   * it is an over-damped return with a time constant of airDamping /
   * airLevel seconds: a car thrown into a roll by a half-on ramp or a rock
   * comes down on its wheels instead of on its side. 0 = off (the car keeps
   * the attitude it took off with). */
  airLevel: number;
  airMaxAccel: number;
  /** ASSIST — yaw rate decays at this rate (1/s) while all four wheels are
   * off the ground. A car kicked into a spin by a rock or another car would
   * otherwise keep turning for its whole flight (lab: one wheel on a 0.7 m
   * rock at 25 m/s = 156° of heading before it lands). 0 = off. */
  airYawDamping: number;
  /** Share (0..1) of the three air assists above that already acts with ONE
   * wheel still loaded; with two it is the square of this, from three
   * wheels up nothing. So they fade in as the wheels leave the ground
   * instead of switching on with the last one — a car pivoting on one wheel
   * after a hit is steadied too. 0 = only with all four wheels in the air. */
  airPartial: number;
  /** ASSIST — tip guard. Tire SIDE forces act at the contact patch, below
   * the centre of mass: once the car is leaning on two wheels they lever it
   * further over (it "trips": sideways into a kerb, yawed after a rock
   * strike, landing with roll). As the car's roll relative to the ground
   * under a wheel grows from `tipGuardStart` to `tipGuardFull` degrees, the
   * point where that wheel's side force is applied is raised from
   * `tireForceHeight` to the height of the centre of mass, where it cannot
   * roll the car: the car slides instead of tripping and gravity brings it
   * back down. `tipGuardLead` (s) looks ahead along the roll rate so a fast
   * roll is caught early. Ordinary cornering rolls 3-5° and never reaches
   * it. tipGuardStart 0 = off. */
  tipGuardStart: number;
  tipGuardFull: number;
  tipGuardLead: number;
  /** ASSIST — self-righting. A car that has come to rest off its wheels
   * (tilted more than `selfRightTilt` degrees, fewer than two wheels
   * loaded, slower than 2.5 m/s) for `selfRightDelay` seconds is rolled
   * back onto them: an angular-velocity servo about the shortest axis to
   * upright, aiming at `selfRightRate` rad/s (less as it nears upright),
   * with a torque of at most `selfRightTorque` × weight × half the
   * wheelbase. It ramps in over 0.3 s and lets go below 30° of tilt or once
   * three wheels carry load — gravity and the suspension do the rest.
   * selfRightDelay 0 = off (the game must respawn: see needsRescue). */
  selfRightDelay: number;
  selfRightTilt: number;
  selfRightRate: number;
  selfRightTorque: number;
  /** ASSIST — unstick. A car that sits (slower than 3 m/s, less than 60°
   * of tilt) with at most two wheels — or no DRIVEN wheel — carrying load
   * is stranded: high-centred on a rock with its wheels in the air, or
   * leaning on one. After `unstickDelay` seconds of that, the pedal the
   * player holds pushes the whole car along its nose (throttle) or tail
   * (reverse), horizontally, with `unstickAccel` × its weight × the pedal —
   * as if the spinning tires had found something to bite on. It fades out
   * as the car gets moving (gone at 3 m/s) and is off the moment three
   * wheels with a driven one among them carry load again. It must beat the
   * hull's friction on the rock (`hullFriction`, 0.3). 0 = off: such a car
   * stays where it is until the game respawns it (needsRescue reports it). */
  unstickAccel: number;
  unstickDelay: number;
  /** ASSIST — yaw governor ("gyro"): while the REAR-axle slip angle is past
   * `slideAssistStart` degrees, a yaw acceleration of `slideYawDamping` ×
   * (rate the direction of travel turns at − yaw rate) is applied, capped at
   * `slideYawDampingMax` rad/s². In words: it resists the slip angle
   * CHANGING. A slide that is opening is always resisted (it develops at a
   * pace a human can react to instead of snapping). A slide that is closing
   * is resisted by the fraction `slideCloseDamping` + (throttle −
   * `slideHoldFrom`) × `slideHoldThrottle` (clamped to 0..1) — less with
   * the stick against the turn (`counterSteerHoldStick`): on the throttle
   * the slide lingers and can be ridden. On top of that a closing slide is
   * never allowed to close faster than the closing-speed limit below
   * (`slideCloseRate` …), and it stays under the governor's control for
   * `counterSteerRelease` s after the rear has hooked up, i.e. through zero
   * slip. 0 = off. */
  slideYawDamping: number;
  slideYawDampingMax: number;
  slideHoldThrottle: number;
  slideHoldFrom: number;
  slideCloseDamping: number;
  slideAssistStart: number;
  /** THE CLOSING-SPEED LIMIT — how fast a slide may close, degrees of
   * slide angle per second, by what the driver is doing with it:
   *  - `slideHoldRate`  while he HOLDS it (stick into the turn AND foot
   *    down): a held drift follows the stick to a shallower angle at a pace
   *    a slow thumb can stay ahead of;
   *  - `slideCloseRate` when he LETS GO of a drift he was holding (lifts,
   *    centres the stick): the rear comes back progressively — lab: 25° in
   *    0.45-0.6 s, 55-70 % of the angle still there after 0.25 s, no swing
   *    past straight (it was 0.2 s and gone before);
   *  - `slideFreeRate`  for a slide nobody was holding (knocked sideways by
   *    a rock or a rival, a slide that was never fed): straightened at
   *    once, as before;
   *  - `slideCatchRate` at full opposite lock, whatever the throttle; in
   *    between in proportion to the opposite stick.
   * Over the last degrees the limit tapers to zero with the time constant
   * `slideCloseTau` (s), so the car arrives at zero slip without the yaw
   * rate that would swing it through to the other side.
   * Who enforces it: (1) the REAR TIRES — from half the limit up they give
   * up grip, down to the share `slideCloseGrip` at the limit (1 = off):
   * the rear "comes back" instead of hooking up in one go, and because it
   * then pushes less the car is not hauled round toward where the nose
   * points while the slide closes; (2) the front wheels (the countersteer
   * servo, `counterSteerRate`); (3) the yaw governor with up to
   * `slideCloseMax` rad/s² for what is left. Very large rates = no limit
   * (slides snap shut). */
  slideCloseRate: number;
  slideFreeRate: number;
  slideCatchRate: number;
  slideHoldRate: number;
  slideCloseMax: number;
  slideCloseGrip: number;
  slideCloseTau: number;
  /** ASSIST — catch latch, 0..1 (0 = off). A slide deeper than
   * `catchLatchAngle` that is being caught — or was, up to `catchMemory`
   * seconds ago — with more than a quarter of opposite stick arms it; it
   * stays armed for as long as the stick is kept on that side, and while it
   * is armed the throttle does not loosen the rear (`powerSlideLoss`,
   * `powerOver`). So "full opposite lock and keep the foot down" ends the
   * slide and stays ended — the car then turns the way the stick points on
   * gripping rear tires — instead of swinging into a drift the other way
   * that the same stick and throttle would hold. The latch lets go 0.25 s
   * after the stick has left the side it was armed on (centred, or over to
   * the other side); a brake TAP (pedal edge past 0.1, lock toward the new
   * side) once the rear has gripped again for `catchBrakeHooked` s drops it
   * (`catchBrakeForget`). A flick (a short, shallow swing the other way
   * first) does not arm it, and neither does opposite lock out of a drift
   * the driver was HOLDING (`catchLinkHeld`: that is a linked drift). Lab:
   * 35° slide at 15 m/s, floored, full opposite lock held — it used to swing
   * through to 30° the other way and stay there; now straight 0.2-0.4 s
   * after the stick moves, 2-9° past. */
  catchLatch: number;
  /** Seconds a slide still counts for the catch latch after the rear has
   * hooked up again. A slide that nobody feeds closes by itself in 0.3-0.6 s
   * — often before a late thumb gets to the opposite lock. Within this time
   * "full opposite lock + floor it" is still read as catching THAT slide
   * (latched: the rear keeps its grip) and not as a new power-over the other
   * way (lab maneuver `lateCatch`: lift, then full opposite lock + floor
   * 0.25 / 0.4 s later, 10-50° slides at 12-18 m/s: 0 of 28 end in a slide
   * the other way; with 0 it was 20 of 28 on three of the four cars).
   * 0 = only while the rear is actually sliding (as the drift round had
   * it). The price of a long memory, for a slide nobody fed (measured
   * 2026-11-22 before `catchLinkHeld` / `catchBrakeForget` existed, when it
   * applied to every slide): a let-go slide takes 0.8-1.0 s to close with
   * the foot down, this memory adds 0.6 s, and any stick past a quarter the
   * other way inside that time arms the latch, which then holds for as long
   * as the stick stays there — a drift the other way needed the stick
   * centred for 1.3 s or more first. A held drift is exempt now
   * (`catchLinkHeld`) and a brake tap on a hooked-up car clears the memory
   * (`catchBrakeForget`); after a caught skid, throttle-only, the price
   * stands. */
  catchMemory: number;
  /** How deep (rear slip angle, degrees) a slide must have been for opposite
   * lock to arm the catch latch: not at all below `catchLatchAngle`, fully
   * `catchLatchSpan` degrees deeper. Lower = even a small twitch followed by
   * full opposite lock and throttle is treated as a catch (no power-over the
   * other way); higher = more room for a flick (a deliberate swing the other
   * way first) to start a drift. */
  catchLatchAngle: number;
  catchLatchSpan: number;
  /** LINKING, 0..1 (0 = off). How far a slide the driver was HOLDING (stick
   * into the turn with the foot down — a drift, not a skid) is exempt from
   * the catch latch: opposite lock out of it is the way into a drift the
   * other way (an S-bend), so it does not arm the latch. "Holding" = fed
   * (stick into the turn, foot down, frame by frame — the seconds the
   * driver fed it, not the seconds since he first did) for at least
   * `catchLinkTime` seconds of that slide: a rear that steps
   * out for a moment in a hard corner (the rivals, the lab drivers, hands
   * slow to leave an unexpected slide) is not a drift. Slides nobody fed —
   * the car stepped out, was knocked, the driver lifted — latch as before.
   * Lab `driftLink` / `overHeldCatch` (2026-11-22, 60 Hz; angles and
   * times at the REAR AXLE): a held right drift (rear axle 28-29° at
   * 15-16 m/s), then full left lock + floor — before: no left drift on any car
   * (latch armed, the car circles on gripping tires); with 1: see the
   * comment at the default value. */
  catchLinkHeld: number;
  catchLinkTime: number;
  /** LINKING, 0/1. A brake TAP — the pedal going down past 0.1 — with more
   * than half lock toward the new side (the old slide's opposite-lock side)
   * on a car whose rear has been hooked up for `catchBrakeHooked` seconds
   * forgets the remembered slide and lets go of the catch latch: a brake tap
   * with lock on starts a slide (the brake-tap entry), it does not catch
   * one. A brake used during the catch, or still down when the rear hooks
   * up, does not count (round 1 had it level-triggered with no wait: a catch
   * with a brake stab, or lift + opposite lock + brake then floor it, ended
   * 25-30° the other way on all four cars).
   * Lab `driftLink.afterCatch.brake`: a 35° slide caught with full opposite
   * lock at 30 % throttle, then 1.5 s later a 0.3 s brake tap with the lock
   * still on — before: no slide on any car; with 1: see the default value.
   * A brake-tap link out of a HELD drift does not need this knob
   * (`catchLinkHeld` covers it). */
  catchBrakeForget: number;
  catchBrakeHooked: number;
  /** DRIFT STYLE, 0..1 — the one trade between two ways of holding a slide.
   *  0 (default) = "gyro" style, as an RC drift car: the stick INTO the
   *    corner holds the slide and sets its angle (a quarter stick = a
   *    shallow 10-14°), a centred stick lets it close in 0.4-1.5 s even with
   *    the foot down, any opposite lock ends it.
   *  1 = "classic" style: the THROTTLE alone holds a slide (stick centred:
   *    13-20° from 60 % throttle up), a little opposite lock trims it (15 %
   *    opposite: 18-19°, 30 %: ~16°), more than ~40 % opposite or a lift
   *    ends it. The price: a quarter stick into the turn is already 22-24°,
   *    and a slide no longer ends just because the stick is centred while
   *    the foot is down.
   *  Either way full opposite lock ends the slide (the catch latch) and a
   *  centred stick below 40 % throttle straightens the car in under 0.5 s.
   *  It moves `powerSlideMinAngle` toward 14° and `counterSteerNeutral`
   *  toward 1. */
  classicDrift: number;
  /** ASSIST LEVEL, 0..1 — one knob for the two stabilisers, the yaw
   * governor (`slideYawDamping` …) and the slide steering
   * (`counterSteerAssist`). 1 = as tuned. It works in two stages:
   *  - 1 → 0.5: the governor's damping of opening and held slides weakens
   *    in proportion and every closing-speed limit gets faster (limit ÷
   *    level): slides open and close quicker, the slide steering — and with
   *    it the drift map — stays whole;
   *  - 0.5 → 0: the slide steering fades out as well (blend 2 × level).
   *    0 = the raw car: you countersteer yourself, slides open and close
   *    at the tires' own pace, it spins under power.
   * (The limits are never enforced "half strength" and the steering is not
   * half-blended in the upper stage: both only stretch the time the tires
   * haul the car round while a slide lingers — measured: 21 m of road used
   * to catch a 35° slide instead of 1.6 m.)
   * Lab, reef-rocket, 35° slide at 15 m/s, 0.25 s driver: level 1 / 0.75 /
   * 0.5 / 0.25 / 0 = straight in 1.08 / 1.05 / 1.02 / 1.07 / 0.95 s with 0
   * overshoots, using 1.6 / 3.1 / 5.4 / 17.8 / 12.0 m of road; a lifted
   * drift closes in 0.45 / 0.37 / 0.30 / 0.43 / 0.17 s; the drift window
   * (15 fixed-input cells) holds 15 / 15 / 15 / 4 / 1. */
  assistLevel: number;

  // ----------------------------------------------------------------- chassis
  /** Multiplier on the rig's yaw inertia. The game runs 25 m/s² gravity:
   * tire forces are 2.5× those of a real buggy, so with the true inertia
   * everything in yaw (a slide opening, a catch, a tank-slapper) happens
   * 2.5× faster than a driver's reactions were made for. More yaw inertia
   * would buy that time back with plain rigid-body physics — but measured in
   * the lab 1.5-2.5 made the lane change settle in 1.7-2.5 s instead of 1.2
   * and the attacking lap worse, so it stays at 1 (the rig's value) and the
   * slide-only yaw damper does the job instead. Kept as an A/B knob. */
  yawInertiaScale: number;
  /** ASSIST — rotational inertia Havok is told the car has, as a multiple
   * of the real one (all three axes). Havok only uses it to answer HULL
   * contacts (rocks, walls, other cars, the ground when bottoming out or
   * lying on the roof); tire and suspension forces are integrated by the
   * model with the true inertia, so handling is untouched. Above 1 an
   * off-centre hit spins and tips the car less and pushes it bodily more.
   * 1 = physical. */
  impactInertiaScale: number;

  // ------------------------------------------------------------------ solver
  /** Rate of the model's own fixed sub-steps, Hz. The tire and suspension
   * forces are integrated at this rate whatever the frame rate is. */
  substepHz: number;
  /** How the sub-stepped velocity is handed to Havok, which then moves the
   * body by (that velocity) × dt.
   *  0 = the END-of-frame velocity (the classic game integrator). Distances
   *      then carry a known frame-rate term of half a frame of every
   *      velocity change: a stop from 20 m/s is v·dt/2 shorter — 0.33 m at
   *      30 Hz, 0.08 m at 120 Hz (lab: 6.27 … 6.76 m over 20-240 Hz).
   *  1 = the MEAN of the sub-step velocities; the end value is put back
   *      right after the physics step. The pose then follows the sub-steps
   *      exactly (same stop: 6.76 … 6.78 m over 20-240 Hz) — but the pose
   *      loses the half-frame LEAD that the classic scheme gives a driver
   *      in the loop: at 30 Hz the lab driver's lane change settled in 1.7 s
   *      instead of 1.1 s, and the attacking hill laps shifted.
   * Default 0: closed-loop behaviour at low frame rates matters more than
   * a third of a metre of braking distance. A/B knob. */
  meanVelocityHandoff: number;
  /** 1 = time-of-impact clamp: each frame the hull is swept along its
   * travel and, if it would run into a wall, rock, tree or car, only moved
   * up to the contact; Havok then answers the hit from "touching" instead of
   * from deep inside the obstacle, which it resolves along the shortest way
   * out (often upward) — the reason hard hits differed with the frame rate.
   * 0 = off (plain discrete collision). */
  impactSweep: number;
  /** Friction of the chassis hull against the world (it should slide). */
  hullFriction: number;
}

export const DEFAULT_RAYCAST_TUNING: RaycastTuning = {
  grip: 1.2,
  frontGripScale: 1.11,
  rearGripScale: 1.17,
  loadSensitivity: 0.1,
  peakSlipAngleFront: 9,
  peakSlipAngleRear: 8,
  peakSlipRatio: 0.08,
  slideGripFront: 0.88,
  slideGripRear: 0.88,
  wheelspinGripLoss: 0.35,
  wheelspinGripLossSpeed: 9,
  powerSlideLoss: 0.5,
  powerSlideFrom: 0,
  powerSlideMaxAngle: 30,
  powerSlideMinAngle: 2,
  powerSlideFade: 6,
  slideGripRecovery: 0.5,
  powerSlideSpan: 0.6,
  powerOver: 0.8,
  powerOverFrom: 0.6,
  slideScrub: 0.035,
  slideScrubDeep: 0.25,
  relaxationLength: 0.35,
  relaxationLengthLong: 0.15,
  lowSpeedDamping: 0.6,
  lowSpeedFade: 2,
  rollingResistance: 0.02,

  driveAccel: 1.8,
  driveFadeSpeed: 14,
  driveFreeSpeed: 28,
  maxSpeed: 25,
  limiterBand: 2,
  wheelspinLimit: 0.4,
  reverseSpeedFactor: 0.5,
  engineBrake: 0.12,
  engineBrakeFade: 0.1,
  drivelineInertia: 1.5,
  diffLock: 8,
  aeroDrag: 0.0015,

  brakeDecel: 1.5,
  brakeBias: 0.66,
  abs: 1,
  parkBrake: 0.5,
  autoReverseDelay: 0.4,
  autoReverseDelayFromSpeed: 1.2,
  autoReverseFromSpeed: 4,
  autoReverseRamp: 1,
  autoReverseMaxSlope: 6,

  minTurnRadius: 5,
  steerRate: 12,
  steerGripMargin: 0,
  steerSlipReserve: 6,
  counterSteerAssist: 1,
  counterSteerStart: 7,
  counterSteerSlip: 0,
  counterSteerSlipPower: 12,
  counterSteerCap: 4,
  counterSteerRelease: 0.3,
  counterSteerNeutral: 0.6,
  counterSteerNeutralFrom: 0.3,
  slideFeedMemory: 0.4,
  slideHoldUnfed: 0,
  counterSteerHoldStick: 0.5,
  counterSteerRate: 2,
  counterSteerAngleGain: 0.25,
  counterSteerPowerFull: 0.3,
  counterSteerLag: 0.03,
  counterSteerLock: 1.3,

  springScale: 1,
  dampingBump: 0.35,
  dampingRebound: 0.7,
  damperKneeSpeed: 1.5,
  damperKneeRatio: 0.35,
  bumpZone: 0.4,
  bumpZoneDamping: 2,
  bumpStopRate: 6,
  antiRollFront: 0.5,
  antiRollRear: 0.2,
  maxSuspensionForce: 8,
  tireForceHeight: 0.3,
  obstacleDrag: 0.75,

  airDamping: 10,
  airLevel: 40,
  airMaxAccel: 40,
  airYawDamping: 8,
  airPartial: 0.6,
  tipGuardStart: 8,
  tipGuardFull: 22,
  tipGuardLead: 0.1,
  selfRightDelay: 0.6,
  selfRightTilt: 55,
  selfRightRate: 3,
  selfRightTorque: 1.6,
  unstickAccel: 1,
  unstickDelay: 0.5,
  slideYawDamping: 20,
  slideYawDampingMax: 16,
  slideHoldThrottle: 3.3,
  slideHoldFrom: 0.1,
  slideCloseDamping: 0,
  slideAssistStart: 8,
  slideCloseRate: 40,
  slideFreeRate: 120,
  slideCatchRate: 200,
  slideHoldRate: 20,
  slideCloseMax: 32,
  slideCloseGrip: 0.25,
  slideCloseTau: 0.12,
  catchLatch: 1,
  catchMemory: 0.6,
  catchLatchAngle: 7,
  catchLatchSpan: 3,
  // Lab driftLink, 2026-11-22, 60 Hz, a held right drift (rear axle 28-29
  // deg at 15-16 m/s), then full left lock + floor: REAR-AXLE slip 15 deg
  // left 0.53-0.67 s after the stick moves, 0.17-0.27 s after the old slide
  // passes straight, held at 31-32 deg, no swing back (reef-rocket,
  // neon-wasp, comet-fox; riot-ram has no power-over: no left drift, as from
  // a straight). Measured by BODY slip (xdTrace probes, full stick + floor
  // at 15-18 m/s) the same link takes 0.72-0.92 s, a brake-tap link
  // 0.98-1.27 s. Throttle linking needs the trigger fully down (3/4 stick at
  // 80 % links on neon-wasp only: the power-over trait, not the latch). With
  // 0: no left drift on any car. overHeldCatch: full opposite lock + floor held 5 s out of a held
  // drift = ONE change of side into a held 31-33 deg drift, no spin; let go
  // after 0.6 s it is straight 0.37-0.42 s later. Unfed slides latch as
  // before (lateCatch, slideCatch, overHeldCatch.unfed unchanged).
  catchLinkHeld: 1,
  // (0.8 s. Without a minimum, a rival's short corner slide in the game's
  // seed-7 autopilot race counted as held and that race changed — player
  // 89.6 -> 93.65 s; with 0.5 the game races were unchanged but the lab's
  // 0.4 s-reaction driver in slideRecovery, whose hands still point into
  // an imposed slide for ~0.5 s, counted as holding it: b20.driver.r40
  // caught in 1.47 s instead of 1.13. With 0.8 neither moves. The price: a
  // drift fed for less than about 0.7 s (script time) is latched like a
  // skid; neither an immediate brake tap nor centring the stick for up to
  // 1.0 s links out of it — to slide the other way, tap the brake at least
  // 0.5 s after the rear has gripped again with the lock on (not on
  // comet-fox at 26 m/s). In a chain each drift needs that feed again: 2 s
  // per side links three times in a row, 1 s per side once. The lab's held
  // drifts are fed for 2 s.)
  catchLinkTime: 0.8,
  // Lab driftLink.afterCatch.brake (60 Hz): rear-axle slip 15 deg the new
  // way 0.53-0.75 s after the tap on all four cars, held at 31-33 deg; with
  // 0 no slide on any car. overHeldCatch.brakeCatch / brakeStab (a brake
  // used inside the catch) stay caught: 6-9 deg past, as with 0. But a brake
  // EDGE 0.5 s or more after the rear grips, with the lock still on, starts
  // a slide even with the throttle floored: reef-rocket and neon-wasp end in
  // a held 28-29 deg drift the other way after a late stab, or after pumping
  // the brake during the catch (riot-ram and comet-fox at 24-26 m/s do not).
  catchBrakeForget: 1,
  // (0.5 s: the lab's afterCatch tap comes about 1 s after the rear hooked
  // up; a brake held through the catch, or a stab 0.45 s into it, starts
  // before the rear grips and is never an edge after the wait.)
  catchBrakeHooked: 0.5,
  classicDrift: 0,
  assistLevel: 1,

  yawInertiaScale: 1,
  impactInertiaScale: 3,

  substepHz: 360,
  meanVelocityHandoff: 0,
  impactSweep: 1,
  hullFriction: 0.3,
};

/**
 * Sliders for the tuning panel / lab sweeps, grouped, each with a line on
 * what it feels like (every key of RaycastTuning can be read and set through
 * getTuning / setTuning, listed here or not).
 */
export const RAYCAST_TUNING_PARAMS: TuningParam[] = [
  // --- grip
  { group: 'grip', key: 'grip', label: 'tire grip (mu)', min: 0.5, max: 2, step: 0.05,
    hint: 'overall grip: cornering speed, braking and traction together' },
  { group: 'grip', key: 'frontGripScale', label: 'front grip x', min: 0.7, max: 1.6, step: 0.01,
    hint: 'more = sharper turn-in, tail comes round sooner; less = pushes wide' },
  { group: 'grip', key: 'rearGripScale', label: 'rear grip x', min: 0.7, max: 1.6, step: 0.01,
    hint: 'more = planted rear; less = loose, lively tail' },
  { group: 'grip', key: 'peakSlipAngleFront', label: 'front peak slip (deg)', min: 3, max: 16, step: 0.5,
    hint: 'small = crisp, edgy steering; large = soft and forgiving' },
  { group: 'grip', key: 'peakSlipAngleRear', label: 'rear peak slip (deg)', min: 3, max: 16, step: 0.5,
    hint: 'small = rear lets go suddenly; large = lets go gradually' },
  { group: 'grip', key: 'slideGripRear', label: 'rear sliding grip', min: 0.6, max: 0.99, step: 0.01,
    hint: 'grip left once the rear slides: low = slide runs away, high = it scrubs and comes back' },
  // --- drive
  { group: 'drive', key: 'driveAccel', label: 'thrust / weight', min: 0.3, max: 2.5, step: 0.05,
    hint: 'shove off the line and out of slow corners (above ~0.9 it is wheelspin)' },
  { group: 'drive', key: 'driveFadeSpeed', label: 'thrust fade from (m/s)', min: 0, max: 25, step: 1,
    hint: 'speed up to which full thrust is there: higher = power slides at higher speed' },
  { group: 'drive', key: 'maxSpeed', label: 'max speed', min: 5, max: 40, step: 1,
    hint: 'rev limiter (rim speed, m/s)' },
  { group: 'drive', key: 'wheelspinLimit', label: 'wheelspin limit (0=off)', min: 0, max: 1.5, step: 0.05,
    hint: 'how far the rear tires may spin at full throttle: more = wilder launches and slow-corner slides' },
  { group: 'drive', key: 'engineBrake', label: 'engine brake (g)', min: 0, max: 0.5, step: 0.01,
    hint: 'how hard lifting off slows the car and tucks the nose in' },
  { group: 'drive', key: 'diffLock', label: 'diff lock (1/s)', min: 0, max: 80, step: 1,
    hint: 'high = both rear wheels pull together: more traction, more push into corners' },
  // --- brakes
  { group: 'brakes', key: 'brakeDecel', label: 'brake force (g)', min: 0.5, max: 3, step: 0.05,
    hint: 'bite of the brake trigger' },
  { group: 'brakes', key: 'brakeBias', label: 'brake bias front', min: 0.4, max: 0.9, step: 0.01,
    hint: 'less = the tail steps out under braking (trail-brake rotation)' },
  { group: 'brakes', key: 'abs', label: 'ABS (0/1)', min: 0, max: 1, step: 1,
    hint: '0 = wheels lock: longer stops, no steering under full brake' },
  { group: 'brakes', key: 'autoReverseDelay', label: 'hold-to-reverse (s, 0=off)', min: 0, max: 1.5, step: 0.05,
    hint: 'how long a held brake waits at standstill before backing up (level ground only)' },
  { group: 'brakes', key: 'autoReverseDelayFromSpeed', label: 'same after a stop from speed (s, 0=re-press)', min: 0, max: 3, step: 0.1,
    hint: 'after braking to a stop from speed: how long the held brake waits before backing up; 0 = release and press again' },
  { group: 'brakes', key: 'autoReverseRamp', label: 'held brake eases into reverse (s)', min: 0, max: 3, step: 0.1,
    hint: 'how gently the car starts backing up when a held brake turns into reverse; 0 = full thrust at once' },
  // --- steering
  { group: 'steering', key: 'minTurnRadius', label: 'turn radius (m)', min: 2, max: 12, step: 0.25,
    hint: 'full lock: small = nimble and twitchy, large = calm and wide' },
  { group: 'steering', key: 'steerRate', label: 'steer speed (rad/s)', min: 2, max: 20, step: 0.5,
    hint: 'how fast the wheels follow the stick: low = lazy, smooth; high = instant' },
  { group: 'steering', key: 'steerGripMargin', label: 'speed steer cap (0=off)', min: 0, max: 3, step: 0.05,
    hint: 'on = full stick asks for less lock at speed (finer control, less scrub)' },
  // --- slides and drifting (assists)
  { group: 'slide', key: 'assistLevel', label: 'ASSIST LEVEL (0..1)', min: 0, max: 1, step: 0.05,
    hint: '1 = as tuned; down to 0.5 slides open and close quicker (drifts still hold); below 0.5 the slide steering fades too; 0 = the raw car (spins under power)' },
  { group: 'slide', key: 'classicDrift', label: 'drift style (0 gyro .. 1 classic)', min: 0, max: 1, step: 0.1,
    hint: '0 = stick INTO the corner holds the slide; 1 = throttle alone holds it and a little opposite lock trims it' },
  { group: 'slide', key: 'powerSlideLoss', label: 'throttle loosens rear', min: 0, max: 0.8, step: 0.05,
    hint: 'THE drift knob: how much throttle opens a slide. 0 = slides always close under power' },
  { group: 'slide', key: 'powerSlideMaxAngle', label: 'drift depth at full stick (deg)', min: 15, max: 45, step: 1,
    hint: 'the stick sets how deep: slide angle the rear stays loose up to with the stick fully into the corner' },
  { group: 'slide', key: 'powerSlideMinAngle', label: 'drift depth at centre stick (deg)', min: 0, max: 20, step: 1,
    hint: 'low = centring the stick ends a drift; 10+ = the throttle alone holds a shallow one' },
  { group: 'slide', key: 'powerOver', label: 'power-over (0=pushes)', min: 0, max: 1, step: 0.05,
    hint: 'floor it with lots of lock in a fast corner: 0 = it just pushes wide, 0.7+ = the tail steps out' },
  { group: 'slide', key: 'slideScrub', label: 'drift scrub', min: 0, max: 0.08, step: 0.005,
    hint: 'speed a held drift settles at: more = slower and tighter, 0 = it runs up to the motor limit and goes wide' },
  { group: 'slide', key: 'slideCloseRate', label: 'lift: slide closes at (deg/s)', min: 15, max: 200, step: 5,
    hint: 'how fast a drift you were holding comes back when you let go: low = lazy and progressive, high = snaps straight' },
  { group: 'slide', key: 'slideCatchRate', label: 'opposite lock: closes at (deg/s)', min: 60, max: 400, step: 10,
    hint: 'how hard full opposite lock catches a slide: more = sharper, less = calmer' },
  { group: 'slide', key: 'slideCloseGrip', label: 'rear grip while closing', min: 0.1, max: 1, step: 0.05,
    hint: 'low = the rear comes back softly and the car keeps its line; 1 = it hooks up at once and tucks in' },
  { group: 'slide', key: 'counterSteerSlipPower', label: 'slide feed (deg)', min: 0, max: 18, step: 0.5,
    hint: 'how hard the front wheels pull the nose into a slide you are holding: more = tighter, slower drifts' },
  { group: 'slide', key: 'counterSteerAngleGain', label: 'slide self-centring', min: 0, max: 0.6, step: 0.05,
    hint: 'more = the front wheels follow a deepening slide harder (steadier angle)' },
  { group: 'slide', key: 'counterSteerNeutral', label: 'feed at centre stick', min: 0, max: 1, step: 0.05,
    hint: 'offset of the into-the-turn half of the stick: more = deeper for the same stick, and a centred stick lingers on power' },
  { group: 'slide', key: 'counterSteerCap', label: 'countersteer reach (deg)', min: 1, max: 12, step: 0.5,
    hint: 'how far opposite stick turns the wheels past the slide before it is unwound: more = harder catch' },
  { group: 'slide', key: 'catchLatch', label: 'catch latch (0/1)', min: 0, max: 1, step: 1,
    hint: '1 = opposite lock + foot down ends the slide and stays ended; 0 = it can swing into a drift the other way' },
  { group: 'slide', key: 'catchLinkHeld', label: 'link drifts (0..1)', min: 0, max: 1, step: 0.1,
    hint: '1 = opposite lock out of a drift you were holding swings into one the other way (S-bends); 0 = it is latched like any catch' },
  { group: 'slide', key: 'catchLinkTime', label: 'held drift after (s)', min: 0, max: 2, step: 0.05,
    hint: 'how long a slide must have been fed (stick in, foot down) to count as a held drift for linking: less = quicker S-bends, more = only long drifts' },
  { group: 'slide', key: 'catchBrakeForget', label: 'brake tap frees latch (0/1)', min: 0, max: 1, step: 1,
    hint: '1 = a brake tap after a caught slide starts a new one (stick on the new side); 0 = the latch holds until the stick is centred' },
  { group: 'slide', key: 'catchBrakeHooked', label: 'brake tap frees after (s)', min: 0, max: 2, step: 0.05,
    hint: 'how long the rear must have gripped again before a brake tap frees the latch: less = quicker, more = a brake used in the catch never flips it' },
  { group: 'slide', key: 'counterSteerAssist', label: 'slide steering (0/1)', min: 0, max: 1, step: 0.05,
    hint: '0 = raw steering: you countersteer yourself, slides are much harder to hold and catch' },
  { group: 'slide', key: 'slideYawDamping', label: 'slide yaw governor', min: 0, max: 30, step: 1,
    hint: 'more = slides open slowly (time to react); 0 = they snap' },
  { group: 'slide', key: 'slideHoldFrom', label: 'slide hold from throttle', min: 0, max: 0.9, step: 0.05,
    hint: 'throttle above which a slide lingers instead of closing at once' },
  { group: 'slide', key: 'wheelspinGripLoss', label: 'wheelspin grip loss', min: 0, max: 0.8, step: 0.05,
    hint: 'grip burned by really spinning rear tires at low speed: donuts and hairpin power slides' },
  // --- chassis
  { group: 'chassis', key: 'yawInertiaScale', label: 'yaw inertia x', min: 0.5, max: 4, step: 0.1,
    hint: 'more = slower to start and to stop rotating (heavier feel)' },
  { group: 'chassis', key: 'dampingBump', label: 'damping bump', min: 0.1, max: 1.2, step: 0.05,
    hint: 'more = firmer over bumps and landings, less float' },
  { group: 'chassis', key: 'dampingRebound', label: 'damping rebound', min: 0.1, max: 1.5, step: 0.05,
    hint: 'more = the body settles at once after a bump; less = it bounces' },
  { group: 'chassis', key: 'antiRollFront', label: 'anti-roll front', min: 0, max: 2, step: 0.05,
    hint: 'more = flatter, more understeer' },
  { group: 'chassis', key: 'antiRollRear', label: 'anti-roll rear', min: 0, max: 2, step: 0.05,
    hint: 'more = flatter, looser rear' },
  { group: 'chassis', key: 'tireForceHeight', label: 'anti-roll assist', min: 0, max: 0.8, step: 0.05,
    hint: 'more = less body roll and far harder to trip over a kerb while sliding' },
  { group: 'chassis', key: 'airDamping', label: 'air stabiliser (1/s)', min: 0, max: 30, step: 1,
    hint: 'more = lands level off jumps; 0 = ballistic, noses over' },
  { group: 'chassis', key: 'airLevel', label: 'air levelling (0=off)', min: 0, max: 120, step: 5,
    hint: 'how firmly the car turns itself wheels-down in the air; 0 = it keeps the attitude it took off with' },
  { group: 'chassis', key: 'airYawDamping', label: 'air spin damping (1/s)', min: 0, max: 15, step: 0.5,
    hint: 'how fast a spin dies while airborne; 0 = a car knocked into a spin keeps turning until it lands' },
  { group: 'chassis', key: 'impactInertiaScale', label: 'impact inertia x', min: 1, max: 6, step: 0.25,
    hint: 'more = a hit on a rock, wall or rival spins and tips the car less and stops it more; 1 = physical' },
  { group: 'chassis', key: 'tipGuardStart', label: 'tip guard from (deg, 0=off)', min: 0, max: 30, step: 1,
    hint: 'body roll at which side grip stops levering the car over; 0 = it can trip over a kerb or its own tires' },
  { group: 'chassis', key: 'selfRightDelay', label: 'self-righting after (s, 0=off)', min: 0, max: 3, step: 0.1,
    hint: 'how long the car lies on its side or roof before it rolls itself back onto its wheels' },
  { group: 'chassis', key: 'unstickAccel', label: 'unstick push (g, 0=off)', min: 0, max: 1.5, step: 0.05,
    hint: 'how hard the held pedal pushes a car off a rock it is high-centred on; 0 = it stays stuck until respawned' },
  { group: 'chassis', key: 'obstacleDrag', label: 'kerb softness (1=rigid)', min: 0.3, max: 1, step: 0.05,
    hint: 'lower = tires swallow kerbs and ripples instead of being punched back' },
];

/** How DriverModel should drive this model (see Vehicle.driverHints). */
export const RAYCAST_DRIVER_HINTS: Partial<DriverParams> = {
  driftSteerBias: (5 * Math.PI) / 180,
  driftSteerGain: 0.8,
  driftYawDamp: 0.5,
  driftThrottle: 0.7,
  driftThrottleGain: 2.0,
  driftThrottleRate: 0.3,
};
