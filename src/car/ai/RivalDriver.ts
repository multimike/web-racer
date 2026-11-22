import type { CarIntent, InputProvider } from '../../input/types';
import type { Vehicle } from '../Vehicle';
import { ActuationLimiter } from '../DriverModel';
import { GAME_GRAVITY } from '../rig';
import type { CarTracker } from './CarTracker';
import { RaceLine } from './RaceLine';
import type { TrackGeometry } from './RaceLine';

/**
 * RivalDriver — an AI racing driver. It is an `InputProvider`: the car it
 * drives polls it exactly like the player's gamepad, so a rival has the
 * same car, the same physics and the same pedals as the player. Nothing is
 * faked on the vehicle side.
 *
 *   const driver = new RivalDriver({ skill: 0.6, seed: 7 });
 *   const car = createVehicle(scene, driver, { carId: 'riot-ram' });
 *   field.addRival('riot', car, driver);       // RivalField (RivalField.ts)
 *   …each frame: field.update(dt); car.update(dt); physics step
 *
 * Measured in the physics lab (maneuver 'race', src/lab/physics/maneuvers/
 * race.ts): tools/physlab.sh "model=raycast&suite=race" out.json — four-car
 * races over 8 terrain seeds, a player stand-in with the rubber band, lap
 * time by skill, and one scenario per behaviour listed below.
 *
 * WHAT IT DOES
 *  - Racing line: a minimum-bending line inside the part of the road this
 *    driver is willing to use (RaceLine.ts), plus a small seeded wander.
 *  - Speed: corner speed from the line's curvature and the car's OWN grip
 *    and top speed (read from the Vehicle every frame, so a retuned or
 *    different car needs no change), braking points from a backward pass,
 *    crests and slopes included. Throttle is squeezed back on as the
 *    cornering load comes off.
 *  - Closed loop: pure pursuit + cross-track term for the line, PI on speed,
 *    countersteer + lift when the car slides (the lab driver's proven catch),
 *    and a learned `gripTrust` — every time the car runs wide of its own line
 *    or leaves the road the driver plans a little less grip for a while, and
 *    wins it back by lapping cleanly. No number here is fitted to a tire
 *    model.
 *  - Trouble: brake out of a spin, turn round when pointing the wrong way,
 *    back out when stuck against something, rejoin the road at reduced speed
 *    when off it, and ask for a rescue (`rescue` becomes non-null) when it is
 *    on its roof, lost, or cannot get going.
 *  - Racecraft (traffic()):
 *      · FOLLOWING: behind a car in its lane the driver holds a headway
 *        (`followGap` at 20 m/s, less at corner speed) with a plain gain on
 *        the gap, never faster than can still be braked off ("lift rather
 *        than ram"); a car that is braking is assumed to go on braking.
 *      · HOW QUICK IS THE OTHER? Every car's apex speeds and flat-out speed
 *        are compared with this driver's own plan at the same spot
 *        (`lastEdge`). Only a car SEEN to be slower by `passEdge` is gone
 *        for; equal cars follow each other.
 *      · ATTACK: down the INSIDE of the next corner, started from a settled
 *        car while the one ahead is still `attackLead` s from turning in;
 *        the passing side is chosen once and kept. A car so much slower
 *        that the pass is finished before the corner (and anything that is
 *        hardly moving) is passed on either side. A try that does not come
 *        off is followed by a pause (`attackPatience`).
 *      · PRESSURE: a driver that wants by sits closer (`pressFollow`); the
 *        one ahead notices a car on its tail (`pressGap`, `pressTime`),
 *        keeps to the outside of the next corner and lifts a little — and
 *        it lifts for a faster car that comes up beside its tail. How much
 *        is `defend` (0 = waves everybody by, 1 = never lifts): on a
 *        twisty road that is what lets the quick cars come through.
 *        The tracker says so out loud (`CarTracker.givingWayTo`).
 *      · ALONGSIDE: the car behind keeps clear of the other (and of where
 *        it is drifting to), the car in front holds its lane — it neither
 *        moves over on the other nor gets pushed off its line. Lane limits
 *        hold the car where it IS at once and steer it like walls.
 *      · CORNERS: with a slow corner coming the field goes single file — a
 *        car without a real overlap tucks in behind (the inside lane of a
 *        hairpin is tighter than the car can turn), and of two that are
 *        abreast the one on the outside gives way.
 *      · FOLLOWING never asks for less than the slower of (my plan here,
 *        the car ahead's speed less `followFloorMargin`): only a car that
 *        is standing in the way brings a rival to a halt.
 *      · A MUCH FASTER car closing from behind (`fastCloseSpeed` on the
 *        closing speed smoothed over `fastSmooth`, seen from
 *        `fastSightRange`): no lift, no move across its path; within
 *        `fastCloseRange` to the side it is not on (`fastClear` of
 *        daylight), judged from the line it holds (`fastLatSmooth`). The
 *        other side only if its own has no room AND the move over is done
 *        `fastCrossTime` s before it arrives. Let go once it stops gaining
 *        along the road (`fastLetGo`, `fastArc`) or has sat behind for
 *        `fastHoldMax` s. A car OUT OF CONTROL nearby (spinning, or askew —
 *        sliding, or pointing off the road AND off a racing line — while
 *        moving across the road: `wildSpin`, `wildSlip`, `wildHeading`,
 *        `wildDrift`): keep clear of its sweep; drop back only if it is
 *        ahead.
 *      · no moving across the bows of a faster car coming up from behind;
 *        racing another car is done ON the road (`edgeMargin`); only an
 *        obstacle is worth a wheel on the shoulder (`shoulderUse`);
 *      · stuck behind cars that block the whole road: back off, then go
 *        round over the shoulder at walking pace (never with the outer
 *        wheels beyond `maxLateral`); no way round: ask for a rescue
 *        (4 failed reverses within 30 s, or no progress).
 *      · LIGHTS OUT from a grid slot: optionally keep the slot's lane for
 *        `launchHold` s (or until a corner is within 45 m), then blend onto
 *        the line over `launchBlend` s. Default OFF (0): measured, the hold
 *        cost more contacts with a player-like car than it saved.
 *      · after the flag (`cooldown`) the car rolls off gently and keeps to
 *        the right.
 *  - Character: `skill` 0..1 sets corner speed, braking, reaction time, how
 *    much road is used and how often a small mistake happens; `seed` gives
 *    each rival its own line bias, wander, following distance and mistakes.
 *    Everything is a pure function of (skill, seed, what the car did), so a
 *    race replays identically for the same seeds.
 *
 * Conventions as everywhere: yaw 0 = +z, positive yaw / steering / lateral
 * offset = RIGHT.
 */

export type RivalMode = 'grid' | 'race' | 'reverse' | 'rescue';
/** What a rival does about a much faster car closing from behind (see
 * RivalParams.fastCarRule). */
export type FastCarRule = 'hold' | 'yield' | 'off';
export type RivalRescueReason = 'flipped' | 'stuck' | 'lost';

export interface RivalParams {
  /** 0 (novice) .. 1 (ace). */
  skill: number;
  seed: number;

  // --- pace (fractions of the car's declared mu·g / top speed)
  /** Lateral acceleration planned in corners. */
  cornerGrip: number;
  /** Deceleration planned into corners. */
  brakeGrip: number;
  /** Ceiling for cornerGrip / brakeGrip whatever the rubber band asks. */
  maxCornerGrip: number;
  maxBrakeGrip: number;
  /** Share of the car's top speed used on straights. */
  topSpeedUse: number;
  maxThrottle: number;
  maxBrake: number;
  /** How much throttle is held back while the tires are busy cornering. */
  exitCaution: number;
  /** Share of the throttle taken away at full steering lock (fading in
   * from 35 % stick). */
  lockCaution: number;

  // --- hands and feet
  reactionDelay: number;
  steerTime: number;
  pedalTime: number;
  /**
   * Speed-loop gain, dimensionless: pedal per (speed error ÷ the speed the
   * car gains at full pedal during the driver's own loop time). 0.5 = half
   * the gain at which the loop would start to hunt. The pedal gains follow
   * from the car's MEASURED acceleration, so a stronger or weaker drivetrain
   * needs no retune.
   */
  speedLoopGain: number;
  /** Integral time of the throttle, s. */
  speedIntegralTime: number;
  brakeDeadband: number;
  lookBase: number;
  lookTime: number;
  lookMin: number;
  lookMax: number;
  /** Cross-track trim: rad of wheel angle per metre the car will be off its
   * line `pathLead` seconds from now (at 10 m/s; less above, see drive()). */
  pathKp: number;
  pathLead: number;
  catchBetaStart: number;
  catchBetaFull: number;
  counterGain: number;
  yawDamp: number;

  // --- line
  /** Distance kept between the car's side and the road edge, m. */
  lineMargin: number;
  /** 0..1 share of the ideal line used. */
  lineUse: number;
  /** Constant sideways preference, m. */
  lineBias: number;
  /** Amplitude of the slow lateral wander, m. */
  wander: number;

  // --- mistakes
  /** Probability of a mistake per `mistakeSector` metres. */
  mistakeRate: number;
  /** Relative overspeed of a "braked too late" mistake. */
  mistakeSize: number;
  mistakeSector: number;

  // --- racecraft
  /** Bumper gap held behind a car that is not being passed, m. */
  followGap: number;
  /** Bumper gap kept while pulling out to pass, m. */
  passGap: number;
  /** Side clearance aimed for while passing / held side by side, m —
   * `passClear` round a car that is hardly moving (an obstacle: widened to
   * 0.9-1.1 m for the 10 m road, s.parked), `passClearMoving` beside a
   * moving rival (kept at the 7 m road's 0.5-0.8 m: the wider value held a
   * quicker rival behind a slower one for a lap longer in duel.k50k80 —
   * 1.9 instead of 0.9-1.0 laps on seed 5 on three cars). */
  passClear: number;
  passClearMoving: number;
  /** Side clearance while squeezing past a blockage at walking pace (the
   * shoulder use is capped by `maxLateral`: two wrecks at ±2.6 m leave
   * 2.65 m to the 6.3 m line for a 2.1 m car), m. */
  squeezeClear: number;
  sideClear: number;
  /** Room left before moving back in front of a passed car, m. */
  cutInGap: number;
  /** Lights out: keep the grid slot's lateral for `launchHold` s (or until
   * a corner is within 45 m), then blend onto the line over `launchBlend` s.
   * Two grid columns that both head for the racing line at once converge in
   * the first second, the car behind lifts for the other column and the one
   * behind IT (a player launching straight) runs into it (measured: 49 of 171 quick stand-in contacts were such rear-ends in the
   * first 3 s). 0 = off (aim for the line at once) — the DEFAULT.
   * A/B on the same code (stand-in races with the
   * launch eyes, proxyEasy + proxyQuick, 4 cars x seeds 1-8 / 41-48 = 128
   * races; race-41 = 48 rival races at 30/60/90 Hz):
   *   launchHold          3            1.5        0.75       0
   *   stand-in contacts   287          310        347        217
   *   … in the first 6 s  123          112        101        49
   *   hardest of those    10.3         8.4        8.7        7.8 m/s
   *   rival-at-fault/race 1.27/0.67    1.41/0.71  1.42/0.88  1.11/0.46 (Easy/Quick)
   *   rival-rival, those  75           65         70         92
   *   race-41 contacts    38           39         41         45
   *   hardest in control  9.3/10.3     9.2/12.8   11.2/15.3  11.0/13.9 (one race in 64;
   *                       the >10 m/s hits at 0 come 10-66 s in, not at
   *                       the launch)
   * Also on seeds 9-16 (12 files): 0.75 was worst (508 stand-in contacts
   * against 448 at 3 and 341 at 0). The hold ends at the first corner
   * after 1.1-1.9 s on most seeds, so 1.5 and 3 read nearly the same; the
   * columns then converge INTO the first corner with the player between
   * them. Fewest contacts overall: 0. */
  launchHold: number;
  launchBlend: number;
  /** A car closing on me (> 1 m/s) from less than this far behind (bumper
   * gap, m) and off to one side: I do not move toward its side. 0 = off
   * (the default: at 6 m it measured MORE stand-in contacts; kept as an owner tuning key, `&rival=closeBehindGap:6` —
   * switched off it costs one comparison per nearby car per step). */
  closeBehindGap: number;
  /**
   * How much quicker than the car ahead this driver must have SEEN itself to
   * be before it attacks, as a share of pace (0.03 = the other was 3 %
   * slower than my own plan wherever it held a steady speed). Low = attacks
   * anything, high = only obvious backmarkers.
   */
  passEdge: number;
  /** Bumper gap inside which an attack is started, m. */
  attackRange: number;
  /** An attack is started only while the car ahead is still `attackLead`
   * seconds (plus the time my move sideways takes) from turning in; it
   * turns in `turnInDistance` m before the apex. */
  turnInDistance: number;
  attackLead: number;
  /** Seconds to wait after an attack that did not come off (twice that
   * from the second failure on the same car on). */
  attackPatience: number;
  /** Sideways speed of a deliberate move out of line, m/s. */
  laneRateSwerve: number;
  /** Following: closing speed allowed per metre of room behind the car
   * ahead (and speed taken off per metre too close), 1/s. */
  followGain: number;
  /** Seconds of the car ahead's future that are anticipated when following
   * it (it will brake where the road makes it brake). 0 = follow what it
   * does now; larger = brake with it rather than behind it. */
  followLead: number;
  /**
   * Traffic never asks for less than the slower of (my own plan here, the
   * speed of the car it is following minus this margin), m/s — a car that is
   * moving is followed, not stopped for; only a car that is itself standing
   * in the way brings me to a halt.
   */
  followFloorMargin: number;
  /** How much of the inside-lane gap correction is applied when following
   * (1 = all: the bumper gap along the centreline shortened by the lane's
   * tighter arc; 0 = the plain centreline gap) — in full only behind a car
   * going through the bend well below my own plan there: below
   * `insideGapPace` − 0.15 of my line's speed where it is, none above
   * `insideGapPace`. (Behind a car near my own pace the correction held a
   * quicker rival 2 m further back in every bend, where a pass is set up:
   * duel.k50k80 took 1.2-1.9 laps instead of 0.9; s.slowCar — a car at a
   * third of the grip ahead — is what needs it.) Always in full behind a
   * car no rival drives (the player). */
  insideGapShrink: number;
  insideGapPace: number;
  /**
   * What to do about a much FASTER car closing from behind (detected as
   * below):
   *  · 'hold': from the moment it is seen until it is past, has
   *    stopped gaining (`fastLetGo`) or has sat behind for `fastHoldMax` s:
   *    no lateral move toward or across its side — the current offset from
   *    the centreline is kept, and only a move back to my line AWAY from its
   *    side is allowed (at the normal lane rate); no lift; the corner at the
   *    speed the held offset allows. Never across the road. Predictable: a
   *    car that holds still is one a player can drive round.
   *  · 'yield' (default): move to the side it is not on (`fastClear`, `fastLaneRate`,
   *    the other side only with time to spare: `fastCrossTime`).
   *  · 'off': no special behaviour.
   * (A/B re-run with launchHold 0, presets easy
   * 0.2 / normal 0.42 — 128 stand-in races (proxyEasy + proxyQuick, 4 cars
   * x seeds 1-8 / 41-48), 672 s.fastBehind runs (48 files), 48 rival races
   * (race-41 at 60/30/90 Hz):            yield      hold       off
   *   stand-in races, in-control contacts  307        206        212
   *     per race Easy / Quick              2.56/2.24  1.56/1.66  1.56/1.75
   *     rival-at-fault per race            1.11/0.46  0.32/0.17  0.63/0.21
   *     hardest in control, m/s            11.0/13.9  10.7/14.7  10.7/9.7
   *   s.fastBehind runs that touch         11         274        378
   *     of them above 4 m/s; hardest       5; 7.9     168; 9.0   342; 9.9
   *   race-41 contacts                     45         42         38
   *   in-control contacts, all three sets  363        522        628
   * 'yield' by contacts (the brief's rule) — all of the difference is
   * s.fastBehind, whose closer drives through whatever is in its lane; in
   * the races with a player-like car 'hold' and 'off' have a third fewer
   * contacts and pass the rival-at-fault gate that 'yield' fails. Earlier
   * tables, on earlier presets and launches, pointed the same way.)
   */
  fastCarRule: FastCarRule;
  /**
   * A car closing from behind faster than `fastCloseSpeed` m/s within
   * `fastCloseRange` m (bumper to bumper) is a much FASTER car (a player
   * flat out, a rival on a flying lap): I hold my line and my speed (no
   * lift, no move across its path) and, on a straight, move to the side it
   * is not on, `fastClear` m of daylight from its line, `fastLaneRate`
   * times as quick as a normal lane change.
   */
  fastCloseSpeed: number;
  fastCloseRange: number;
  fastClear: number;
  fastLaneRate: number;
  /** Seconds a car seen closing that fast still counts as fast while it is
   * behind me (it followed me through a corner and will come by on the
   * exit) — but only while it is still GAINING: a car that has closed
   * less than `fastHoldClosing` m/s for `fastLetGo` s is following, not
   * passing, and is let go (then the ordinary rules apply: pressure,
   * let-by, attack). */
  fastMemory: number;
  fastHoldClosing: number;
  fastLetGo: number;
  /** Time constant the closing speed is smoothed with before it is
   * compared with `fastCloseSpeed`, s: two equal cars nose to tail see
   * 6+ m/s of closing for a few tenths of a second whenever the leader
   * brakes first — that is not a much faster car. */
  fastSmooth: number;
  /** The same two for a car NOT driven by a rival (the player, a remote
   * car); -1 = as for a rival (the default: one rule for every car).
   * TRADE-OFF measured in the lab: 0 / 0.6 (the
   * quick, unsmoothed reading for the player) cuts proxyQuick contacts to
   * 2.0-3.75 per race (seeds 1-4 + 9-12, four cars; 3.5-5.5 with the
   * default) but makes s.fastBehind touch in 1-2 of 14 runs at 6-9 m/s on
   * most files (default: 1 of 112 runs, 3 m/s) and holds a rival out of the
   * way of a player that only follows for 3-9 s. A design decision, open to
   * the owner; try `&rival=fastSmoothOther:0,fastAccelLookOther:0.6`. */
  fastSmoothOther: number;
  fastAccelLookOther: number;
  /** Seconds of the closing car's extra acceleration counted into its
   * closing speed (a car flooring it out of a corner behind me is fast
   * before its speed says so). 0 = speed difference only. */
  fastAccelLook: number;
  /** Room kept inside the lane limit while moving over for it, m. */
  fastEdgeKeep: number;
  /** The other side of a fast car's line, when mine has no room: taken
   * only if the move over is done `fastCrossTime` s before the car gets to
   * me (never across its bows), judged from where it holds its line —
   * its lateral smoothed over `fastLatSmooth` s, not one frame of a car
   * that is still swerving — and looked for from `fastSightRange` m back
   * (from 20 m at 8 m/s of closing there is no time left to go across). */
  fastCrossTime: number;
  fastLatSmooth: number;
  fastSightRange: number;
  /** A fast car that has been near and behind me this long without coming by is
   * not much faster (it gains on the straights and loses it again in the
   * bends): let go of it until it has been out of sight, s. */
  fastHoldMax: number;
  /** 1: whether a fast car still gains on me (`fastLetGo`) is judged in
   * centreline metres per second (lane length allowed for: a follower on the
   * outside of a bend that drops back read as still closing, and the rival
   * stayed out of its way for 3.4-4.4 s after it stopped closing); 0: plain
   * speed difference. (Arming the rule on that reading too doubled the
   * contacts in s.fastBehind: a closer on the outside of a bend read as not
   * closing and was met unprepared on the straight after it.) */
  fastArc: number;
  /** A car is OUT OF CONTROL at speed when it slides more than `wildSpin`
   * rad (past any held drift), or slides more than `wildSlip` rad / points
   * more than `wildHeading` rad off the road AND off my racing line there
   * (a leader driving its line out of a tight bend points 20-26 deg off the
   * road) AND moves across the road
   * faster than `wildDrift` m/s (a held drift follows the road; a spin
   * leaves it). A car beside it keeps 1.5 m of extra room from where it
   * is AND from where it is sliding to (`wildLook` s ahead); a car behind
   * it drops back to `wildDrop` m/s below its speed. A car it is beside
   * and behind does NOT lift (braking there puts it in the way). */
  wildSlip: number;
  wildHeading: number;
  wildSpin: number;
  wildDrift: number;
  wildLook: number;
  wildDrop: number;
  /** Distance kept between the car's side and the road edge in traffic, m. */
  edgeMargin: number;
  /** How far over the road edge the car's side may go to get round an
   * OBSTACLE (a parked or crawling car, a blockage), m. */
  shoulderUse: number;
  /** Furthest from the centreline the car's OUTER wheels may ever be planned,
   * m, whatever is in the way (the game's fences and trees stand 7.3 m from
   * the centreline; before this cap, squeezing round a blocked road planned
   * them at 7.3 m). */
  maxLateral: number;
  /** Lateral rates of the lane limits: closing in on a constraint / letting
   * it go, m/s. Low = calm, no weaving. */
  laneRateApply: number;
  laneRateRelax: number;
  /** Seconds of closing speed the driver looks ahead for traffic. */
  trafficTime: number;
  /**
   * A stretch counts as a slow CORNER when the plan drops below this share
   * of the straight-line speed within the next ~45 m. At its turn-in a car
   * that is not properly alongside drops back behind the one ahead instead
   * of going in two abreast. Default 0.5 (bold driver) .. 0.7 (careful).
   */
  cornerZone: number;
  /** A corner this many seconds ahead (or nearer) is being TURNED INTO: two
   * abreast, the car on the outside gives way unless it is clear in front. */
  turnInTime: number;
  /** A corner this many seconds ahead (or nearer) is COMING: a pass is now
   * started only down its inside. */
  cornerAheadTime: number;
  /** How much slower than the car on the inside the one giving way goes, m/s. */
  yieldLift: number;
  /**
   * 0..1: how hard this driver makes it for a car that attacks it. A car
   * that comes up beside its tail going faster is ATTACKING; the driver
   * answers by lifting `(1 − defend) × cedeLift` of its speed until the
   * other is through (1 = never lifts for anybody, 0 = waves everybody by).
   * On a twisty road a pass between equal cars only comes
   * off if the car ahead gives a little — this is THE knob for how much
   * the field (and the player) can overtake. Default 0.3 (novice) .. 0.8
   * (ace).
   */
  defend: number;
  cedeLift: number;
  /**
   * Pressure: a car sitting within `pressGap` metres of the tail (at 20
   * m/s; closer at lower speed) is tailgating — a quicker rival does that on
   * purpose, a content follower stays further back. After `pressTime`
   * seconds of it the driver lets the car by: keeps to the outside of the
   * next corner and lifts (as above) for up to `letByTime` seconds, then
   * not again for `letByRest` seconds. With `defend` 1 it never does.
   */
  pressGap: number;
  pressTime: number;
  /** Bumper gap (at 20 m/s) this driver itself sits at behind a car it
   * wants to get by — must be smaller than the others' `pressGap`. */
  pressFollow: number;
  letByTime: number;
  letByRest: number;
  /** Speed difference allowed while going by another car: base, m/s, plus
   * this much per metre of daylight between the two (a parked car with half
   * a metre to spare is passed at ~9 m/s, with 1.5 m at any speed). */
  passSpeedBase: number;
  passSpeedPerMetre: number;
  /** Margin, s, on top of the time the move over takes, before the car
   * starts to move out for something that is hardly moving. */
  obstacleLead: number;
  /** How far ahead the other car's sideways movement is anticipated, s. */
  sideAnticipation: number;
  /** Lane limits as walls: steering (rad per metre) against the car being
   * carried past a limit within `wallTime` seconds by its sideways motion. */
  wallGain: number;
  wallTime: number;

  // --- trouble
  /** Speed while the car's centre is off the road, share of top speed. */
  offRoadSpeed: number;
  /** Pushing the throttle and not moving for this long = stuck, s. */
  stuckTime: number;
  /** Standing still for this long for any reason = try something, s. */
  blockedTime: number;
  /** Metres backed up per attempt, and the speed it is done at, m/s. */
  reverseDistance: number;
  reverseSpeed: number;
  /** Speed while feeling the way round an unseen obstacle, share of top speed. */
  dodgeSpeed: number;
  /** Failed attempts (within 30 s) before asking for a rescue. */
  reverseAttempts: number;
  /** No progress for this long = ask for a rescue, s. */
  noProgressTime: number;
  /** Further than this from the road edge = lost, m. */
  lostDistance: number;
  /** Cruising speed after the finish, share of top speed, and how gently
   * the car comes down to it, m/s². It keeps to the right of the road. */
  cooldownSpeed: number;
  cooldownDecel: number;
}

/** A car's speed along the road in centreline metres per second (its
 * speed along the road's direction, scaled by how much shorter or longer its
 * lane is than the centreline where it is). */
function arcSpeed(t: CarTracker, geo: TrackGeometry): number {
  const f = 1 - geo.curvature[t.index] * t.lateral;
  return t.speedAlong / (f < 0.5 ? 0.5 : f > 1.5 ? 1.5 : f);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Stateless integer hash → [0, 1): the same (a, b, c) always gives the same
 * number, in any call order (keeps a race reproducible). */
export function hash01(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The driver a (skill, seed) pair stands for. Skill moves pace, precision
 * and reactions together; the seed adds a personality on top (±a few % of
 * pace style, line preference, how closely it follows, how boldly it
 * passes). `overrides` win over both.
 */
export function rivalParams(skill: number, seed: number, overrides: Partial<RivalParams> = {}): RivalParams {
  const k = clamp(skill, 0, 1);
  const r = (n: number) => hash01(seed, 1000 + n);
  const bold = clamp(0.25 + 0.5 * k + 0.5 * (r(1) - 0.5), 0, 1);
  const params: RivalParams = {
    skill: k,
    seed,
    cornerGrip: 0.5 + 0.3 * k + 0.02 * (r(2) - 0.5),
    brakeGrip: 0.38 + 0.3 * k + 0.04 * (r(3) - 0.5),
    maxCornerGrip: 0.9,
    maxBrakeGrip: 0.85,
    topSpeedUse: 0.9 + 0.1 * k,
    maxThrottle: 0.75 + 0.25 * k,
    maxBrake: 0.8 + 0.2 * k,
    exitCaution: 0.85 - 0.45 * k,
    lockCaution: 0.7,
    reactionDelay: 0.22 - 0.15 * k,
    steerTime: 0.12,
    pedalTime: 0.1,
    speedLoopGain: 0.7,
    speedIntegralTime: 1.5,
    brakeDeadband: 0.4,
    lookBase: 3,
    lookTime: 0.4,
    lookMin: 4,
    lookMax: 16,
    pathKp: 0.03,
    pathLead: 0.3,
    catchBetaStart: (8 * Math.PI) / 180,
    catchBetaFull: (18 * Math.PI) / 180,
    counterGain: 1.2,
    yawDamp: 0.35,
    lineMargin: 0.75 - 0.4 * k,
    lineUse: 0.7 + 0.3 * k,
    lineBias: (r(4) - 0.5) * 0.7 * (1 - 0.5 * k),
    wander: 0.35 * (1 - k),
    mistakeRate: 0.07 * Math.pow(1 - k, 1.5),
    mistakeSize: 0.05 + 0.08 * (1 - k),
    mistakeSector: 30,
    // (re-tuned for the 10 m road — race-41 8 seeds at 60 Hz +
    // duel.k50k80 on seeds 1-6 / 41-46, four cars: 2.8-4.8 m before, 3 m
    // flat with edgeMargin 0.3 cut duels over 1.6 laps from 5 of 48 to 2 and
    // the side over the edge from 1.33 to 0.68 % of the time, contacts 0.75
    // -> 1.25 per race, hardest 3.4 -> 3.7 m/s; 2.5 m doubled the contacts)
    followGap: 2.8 + 0.4 * (1 - bold),
    passGap: 1,
    // (0.5-0.8 on the old 7 m road; a 10 m road has room for a wider berth,
    // and less left a car coming by a parked one slightly in its lane)
    passClear: 0.9 + 0.2 * (1 - bold),
    passClearMoving: 0.5 + 0.3 * (1 - bold),
    squeezeClear: 0.25,
    sideClear: 0.8,
    cutInGap: 1.5 + 2 * (1 - bold),
    launchHold: 0,
    launchBlend: 1.5,
    // (off: measured on seeds 1-8, reef-rocket / comet-fox —
    // 6 m moved proxyEasy.rivalAtFault 1.88 -> 0.75 on one car and 1.63 ->
    // 1.75 on the other, and proxyQuick contacts 2.75 -> 5.88: not adopted)
    closeBehindGap: 0,
    passEdge: 0.02 + 0.03 * (1 - bold),
    attackRange: 8,
    turnInDistance: 9,
    attackLead: 0.4,
    attackPatience: 1.2 + 1.5 * (1 - bold),
    laneRateSwerve: 3.5,
    followGain: 1.5,
    followLead: 0.15 + (0.22 - 0.15 * k),
    followFloorMargin: 1,
    insideGapShrink: 1,
    insideGapPace: 0.75,
    fastCarRule: 'yield',
    fastCloseSpeed: 6,
    fastCloseRange: 20,
    fastClear: 1.4,
    fastLaneRate: 1.6,
    fastMemory: 3,
    fastHoldClosing: 2,
    fastLetGo: 1,
    fastSmooth: 0.5,
    fastSmoothOther: -1,
    fastAccelLookOther: -1,
    fastAccelLook: 0,
    fastEdgeKeep: 0.4,
    fastCrossTime: 2,
    fastLatSmooth: 0.5,
    fastSightRange: 40,
    fastHoldMax: 5,
    fastArc: 1,
    wildSlip: 0.25,
    wildHeading: 0.4,
    wildSpin: 0.7,
    wildDrift: 2,
    wildLook: 0.6,
    wildDrop: 3,
    // (0.15 on the 7 m road; 0.4 kept the side on the road best — 0.18 % —
    // but slowed the duels, 7 of 48 over 1.6 laps; 0.3 with followGap 3)
    edgeMargin: 0.3,
    shoulderUse: 0.3,
    maxLateral: 6.3,
    laneRateApply: 2.5,
    laneRateRelax: 1.2,
    trafficTime: 2,
    cornerZone: 0.7 - 0.2 * bold,
    turnInTime: 0.4,
    cornerAheadTime: 1.3,
    yieldLift: 1.5,
    defend: clamp(0.1 + 0.6 * k + 0.2 * bold, 0, 1),
    cedeLift: 0.22,
    pressGap: 3,
    pressFollow: 1.3,
    pressTime: 0.5 + 4 * clamp(0.1 + 0.6 * k + 0.2 * bold, 0, 1),
    letByTime: 4,
    letByRest: 8,
    passSpeedBase: 3,
    passSpeedPerMetre: 12,
    obstacleLead: 1.2,
    sideAnticipation: 0.4,
    wallGain: 0.06,
    wallTime: 0.35,
    offRoadSpeed: 0.55,
    stuckTime: 0.9,
    blockedTime: 2.5,
    reverseDistance: 3.5,
    reverseSpeed: 3.5,
    dodgeSpeed: 0.3,
    reverseAttempts: 3,
    noProgressTime: 9,
    lostDistance: 30,
    cooldownSpeed: 0.3,
    cooldownDecel: 5,
  };
  return Object.assign(params, overrides);
}

export interface RivalOptions {
  /** 0..1, default 0.6. */
  skill?: number;
  /** Personality / mistake seed, default 1. */
  seed?: number;
  /** Any RivalParams value, overriding what skill and seed give. */
  params?: Partial<RivalParams>;
  /** Scene gravity, m/s². Default: the rig's, else the game's (25). */
  gravity?: number;
}

const DELAY_CAP = 128;
const NO_CARS: readonly CarTracker[] = [];

export class RivalDriver implements InputProvider {
  readonly name = 'rival';
  readonly params: RivalParams;
  /** What the hands and feet are doing right now (what poll() returns). */
  readonly hands: ActuationLimiter;

  mode: RivalMode = 'grid';
  /** Non-null = this car cannot help itself: respawn it (RivalField
   * .rescuePose + Vehicle.reset), then call respawned(). */
  rescue: RivalRescueReason | null = null;
  /** Pace asked by the rubber band, −0.08..+0.08 (0 = the driver's own). */
  pace = 0;
  /** After the finish: keep circulating slowly. */
  cooldown = false;
  /** 0.6..1: how much of the car's declared grip the driver currently
   * believes in (drops when it runs wide, recovers with clean driving). */
  gripTrust = 1;

  // --- read-only telemetry of the last think()
  lastTargetSpeed = 0;
  lastTargetLateral = 0;
  /** Speed limit imposed by traffic, m/s (Infinity = none). */
  lastTrafficCap = Infinity;
  /** 0..1 authority of the slide catch. */
  lastCatch = 0;
  /** −1 / 0 / +1: passing on the left / not passing / on the right. */
  passSide = 0;
  /** Dropping back behind a car alongside because a corner is coming. */
  yielding = false;
  /** Lifting for a car that is attacking (see RivalParams.defend). */
  ceding = false;
  /** How much quicker than the car ahead in its lane this driver has seen
   * itself to be (share of pace; 0 = nobody ahead / no quicker). */
  lastEdge = 0;
  /** Counters since construction (lab metrics). */
  readonly stats = {
    passesStarted: 0, passAborts: 0, sideFlips: 0, reverses: 0, turnarounds: 0, wideEvents: 0, mistakes: 0, replans: 0,
    /** Seconds the speed was set by traffic / spent giving way / spent with a pass on. */
    cappedTime: 0, yieldTime: 0, passTime: 0, cedeTime: 0,
    /** Seconds spent keeping out of the way of a much faster car (and of
     * that, with a corner ahead). */
    fastTime: 0,
    fastCornerTime: 0,
    /** Times it chose the other side of a fast car for lack of room. */
    fastSwaps: 0,
    /** Times a tailgating car was let by. */
    letBys: 0,
    /** Seconds spent dropping back behind a car out of control ahead. */
    wildTime: 0,
  };
  /** Metres to the next real corner (0 = in it, Infinity = none in sight)
   * and the side its inside is on (+1 right, −1 left, 0 = none). */
  cornerDist = Infinity;
  cornerSide = 0;
  /** Metres to the next APEX still ahead (the next low point of the speed
   * plan; Infinity = none within 70 m) and the side its inside is on. */
  apexDist = Infinity;
  apexSide = 0;

  private vehicle: Vehicle | null = null;
  private me: CarTracker | null = null;
  private geo: TrackGeometry | null = null;
  private line: RaceLine | null = null;
  private lineHalfWidth = -1;
  private gravity: number;
  private readonly gravityFixed: boolean;
  private time = 0;
  private paceNow = 0;
  private latAccel = 1;
  private brakeAccel = 1;
  private topUse = 1;

  // delay line (reaction time): ring of timestamped wanted commands
  private readonly dT = new Float64Array(DELAY_CAP);
  private readonly dSteer = new Float64Array(DELAY_CAP);
  private readonly dThr = new Float64Array(DELAY_CAP);
  private readonly dBrk = new Float64Array(DELAY_CAP);
  private dHead = 0;
  private dCount = 0;
  private outSteer = 0;
  private outThr = 0;
  private outBrk = 0;
  private readonly acted: CarIntent = { throttle: 0, steering: 0, brake: 0 };

  private speedIntegral = 0;
  // lane limits (lateral interval the target may use), slewed
  private lo = 0;
  private hi = 0;
  private laneReady = false;
  private passId: string | null = null;
  private passTime = 0;
  private passCooldown = 0;
  private blockedByTraffic = false;
  private desperate = 0;
  private escapeSide = 0;
  private wantHere = 0;
  private tGap = new Float64Array(8);
  private tWid = new Float64Array(8);
  private tShrink = new Float64Array(8);
  private noBrakeUntil = 0;
  /** Deceleration the traffic ahead asks for right now, m/s². */
  private trafficDecel = 0;
  /** Tightest arc the car can hold with a margin, 1/m. */
  private turnLimit = 0.2;
  /** Deceleration of the lane-speed braking curve the car is on, m/s². */
  private laneDecel = 0;
  private apLead = 0;
  private apRoom = 0;
  /** Per car (index in the field's list): its pace as a share of MY plan,
   * seen wherever it held a steady speed. 1 = no quicker, no slower. */
  private seenPace = new Float64Array(8).fill(1);
  private seenApex = new Int32Array(8).fill(-1);
  private launchUntil = 0;
  /** launchHold: the grid slot's lateral, when the hold ends / the blend
   * started (-1 = still holding), and the share of it in the target now. */
  private launchLat = 0;
  private launchHoldEnd = 0;
  private launchBlendFrom = -1;
  private launchShare = 0;
  private launchFresh = false;
  private coolSpeed = Infinity;
  private cedeTo: string | null = null;
  /** Per car: seconds it has been sitting on my tail. */
  private pressure = new Float64Array(8);
  /** Per car: its closing speed on me, smoothed over `fastSmooth` s (a
   * moment of my braking harder than it does is not a much faster car). */
  private closeAvg = new Float64Array(8);
  /** Per car: its lateral, smoothed over `fastLatSmooth` s (NaN = not in
   * sight). */
  private latAvg = new Float64Array(8).fill(NaN);
  /** Cars in the field last frame (see traffic). */
  private seenCount = 0;
  /** The fast car let go of for staying behind too long, and how long the
   * current one has been near and fast (see `fastHoldMax`). */
  private fastDropId: string | null = null;
  private fastHeld = 0;
  /** The car being let by (see RivalParams.pressTime), and until when. */
  private letBy: string | null = null;
  private letByUntil = 0;
  private letByAgain = 0;
  /** −1 / +1: the side kept to while letting a car by. */
  private letBySide = 0;
  /** The much faster car closing from behind I am keeping out of the way
   * of, the side I chose for it (−1 left, +1 right), and until when. */
  private fastId: string | null = null;
  private fastSide = 0;
  private fastUntil = 0;
  private fastSeenUntil = 0;
  /** The car `fastSeenUntil` belongs to, and how long it has not been
   * gaining on me (see RivalParams.fastLetGo). */
  private fastSeenId: string | null = null;
  private fastLag = 0;
  /** Furthest the fast car has come toward my side (its predicted lateral). */
  private fastReach = 0;
  /** Already moved to the other side of this fast car once. */
  private fastCrossed = false;
  /** fastCarRule 'hold': the lateral I may not move past toward the fast car. */
  private fastHoldLat = 0;
  /** A car alongside on my right / left this frame (traffic()). */
  private besideRight = false;
  private besideLeft = false;
  /** The car I have just passed: no lifting for THAT one for a while. */
  private beatenId: string | null = null;
  private beatenUntil = 0;
  /** Attacks on `failId` that did not come off, in a row. */
  private failId: string | null = null;
  private fails = 0;
  /** Going round an obstacle until then: the shoulder may be used. */
  private obstacleUntil = 0;
  private mug = 1;
  // Measured drive strength: forward acceleration per unit throttle, m/s².
  private driveGain = 0;
  private prevVFwd = 0;
  private accLP = 0;
  private thrLP = 0;

  private graceUntil = 0;
  private stillX = 0;
  private stillZ = 0;
  private slowTime = 0;
  private pushTime = 0;
  private flipTime = 0;
  private lostTime = 0;
  private wrongWayTime = 0;
  private wideCooldown = 0;
  private watchTime = 0;
  private watchProgress = 0;
  private lastMistakeSector = -1e9;

  private revPhase = 0;
  private revTime = 0;
  /** The way round from facing backward is still to be chosen (set when a
   * reverse starts and when its second phase starts; see reverse()). */
  private revChoose = false;
  private revMoved = 0;
  private revTurn = false;
  /** K-turn from exactly backward: the way round chosen (see reverse()). */
  private revSide = 0;
  private revFar = false;
  private revAttempts = 0;
  private revAttemptClock = 0;
  // After backing away from something on the road: go round it on this side.
  private dodgeSide = 0;
  private dodgeLat = 0;
  private dodgeS = 0;
  private dodgeAt = -1e9;
  private dodgeUntil = 0;
  /** true = the obstacle is not a car (unseen): keep clear of where it was. */
  private dodgeBlind = false;

  constructor(options: RivalOptions = {}) {
    this.params = rivalParams(options.skill ?? 0.6, options.seed ?? 1, options.params);
    this.hands = new ActuationLimiter(this.params.steerTime, this.params.pedalTime);
    this.gravity = options.gravity ?? GAME_GRAVITY;
    this.gravityFixed = options.gravity !== undefined;
  }

  /** Lane limits in use (lateral interval the target may take), m. */
  get laneLo(): number {
    return this.lo;
  }
  get laneHi(): number {
    return this.hi;
  }

  // ------------------------------------------------------------ wiring

  /** Bind to the car this driver sits in (RivalField.addRival does it). */
  attach(vehicle: Vehicle, tracker: CarTracker): void {
    this.vehicle = vehicle;
    this.me = tracker;
    this.geo = tracker.geo;
    if (!this.gravityFixed && vehicle.rig) this.gravity = vehicle.rig.gravity;
    this.buildLine();
    this.resetState();
  }

  /** The racing line in use (debug drawing, lab). */
  get raceLine(): RaceLine | null {
    return this.line;
  }

  isActive(): boolean {
    return true;
  }

  poll(): CarIntent {
    return this.hands.current;
  }

  /** Lights out. Until then the driver sits on the grid with its feet off. */
  start(): void {
    if (this.mode === 'grid') this.mode = 'race';
    this.graceUntil = this.time + 1.5;
    this.launchUntil = this.time + 1.5;
    const hold = this.params.launchHold;
    this.launchLat = this.me ? this.me.lateral : 0;
    this.launchHoldEnd = this.time + Math.max(0, hold);
    this.launchBlendFrom = -1;
    this.launchShare = hold > 0 && this.me ? 1 : 0;
    this.launchFresh = true;
    this.seenPace.fill(1);
    this.watchTime = 0;
    if (this.me) this.watchProgress = this.me.progress;
  }

  /** Back to the grid state (feet off, waiting for start()). */
  hold(): void {
    this.mode = 'grid';
    this.rescue = null;
    this.resetState();
  }

  /** Call after the car was teleported (Vehicle.reset) — after a rescue or
   * any other respawn. Clears every memory of the trouble it was in. */
  respawned(): void {
    const racing = this.mode !== 'grid';
    this.rescue = null;
    this.resetState();
    this.mode = racing ? 'race' : 'grid';
    this.graceUntil = this.time + 1.5;
  }

  /**
   * A NEW RACE (the game's restart): the driver as `attach` left it — every
   * learned value (drive gain, grip trust, smoothed pace and pedals), every
   * timer, the driver's clock and the line's speed plan go back to their
   * first-race values, so a restarted race replays the first one exactly
   * (same seeds, same physics). Call after the car is back on its grid spot
   * and its tracker re-located; then hold() / start() as at boot.
   */
  newRace(): void {
    this.mode = 'grid';
    this.rescue = null;
    this.pace = 0;
    this.cooldown = false;
    this.gripTrust = 1;
    this.lastTargetSpeed = 0;
    this.lastTargetLateral = 0;
    this.yielding = false;
    this.lastEdge = 0;
    this.cornerDist = Infinity;
    this.cornerSide = 0;
    this.apexDist = Infinity;
    this.apexSide = 0;
    this.time = 0;
    this.paceNow = 0;
    this.latAccel = 1;
    this.brakeAccel = 1;
    this.topUse = 1;
    this.dHead = 0;
    this.dT.fill(0);
    this.dSteer.fill(0);
    this.dThr.fill(0);
    this.dBrk.fill(0);
    this.lo = 0;
    this.hi = 0;
    this.blockedByTraffic = false;
    this.escapeSide = 0;
    this.wantHere = 0;
    this.tGap.fill(0);
    this.tWid.fill(0);
    this.tShrink.fill(0);
    this.noBrakeUntil = 0;
    this.trafficDecel = 0;
    this.turnLimit = 0.2;
    this.laneDecel = 0;
    this.apLead = 0;
    this.apRoom = 0;
    this.launchUntil = 0;
    this.launchLat = 0;
    this.launchHoldEnd = 0;
    this.launchBlendFrom = -1;
    this.launchFresh = false;
    this.coolSpeed = Infinity;
    this.seenCount = 0;
    this.letByUntil = 0;
    this.letBySide = 0;
    this.fastHoldLat = 0;
    this.besideRight = false;
    this.besideLeft = false;
    this.beatenUntil = 0;
    this.mug = 1;
    this.driveGain = 0;
    this.prevVFwd = 0;
    this.accLP = 0;
    this.thrLP = 0;
    this.graceUntil = 0;
    this.stillX = 0;
    this.stillZ = 0;
    this.wideCooldown = 0;
    this.lastMistakeSector = -1e9;
    this.revTime = 0;
    this.revChoose = false;
    this.revMoved = 0;
    this.revTurn = false;
    this.revSide = 0;
    this.revFar = false;
    this.revAttemptClock = 0;
    this.dodgeLat = 0;
    this.dodgeS = 0;
    this.dodgeAt = -1e9;
    this.dodgeBlind = false;
    this.acted.throttle = 0;
    this.acted.steering = 0;
    this.acted.brake = 0;
    // Re-solving the line clears its speed plan (plannedLatAccel = 0): the
    // next think() plans afresh instead of keeping a plan made for a pace
    // within the replan tolerance of the new one.
    this.buildLine();
    this.resetState();
  }

  private resetState(): void {
    this.hands.current.throttle = 0;
    this.hands.current.brake = 0;
    this.hands.current.steering = 0;
    this.dCount = 0;
    this.outSteer = 0;
    this.outThr = 0;
    this.outBrk = 0;
    this.speedIntegral = 0;
    this.laneReady = false;
    this.passId = null;
    this.passSide = 0;
    this.passTime = 0;
    this.passCooldown = 0;
    this.desperate = 0;
    this.launchShare = 0;
    this.slowTime = 0;
    this.pushTime = 0;
    this.flipTime = 0;
    this.lostTime = 0;
    this.wrongWayTime = 0;
    this.watchTime = 0;
    this.watchProgress = this.me ? this.me.progress : 0;
    this.revAttempts = 0;
    this.revPhase = 0;
    this.dodgeSide = 0;
    this.dodgeUntil = 0;
    this.lastCatch = 0;
    this.lastTrafficCap = Infinity;
    this.seenPace.fill(1);
    this.seenApex.fill(-1);
    this.failId = null;
    this.fails = 0;
    this.cedeTo = null;
    this.ceding = false;
    this.beatenId = null;
    this.pressure.fill(0);
    this.closeAvg.fill(0);
    this.latAvg.fill(NaN);
    this.fastDropId = null;
    this.fastHeld = 0;
    this.letBy = null;
    this.letByAgain = 0;
    this.obstacleUntil = 0;
    this.fastId = null;
    this.fastSide = 0;
    this.fastReach = 0;
    this.fastUntil = 0;
    this.fastSeenUntil = 0;
    this.fastSeenId = null;
    this.fastLag = 0;
    this.fastCrossed = false;
  }

  private buildLine(): void {
    const geo = this.geo;
    const me = this.me;
    if (!geo || !me) return;
    const p = this.params;
    const corridor = Math.max(0, geo.halfWidth - me.halfWidth - p.lineMargin);
    const options = { halfCorridor: corridor, use: p.lineUse, bias: p.lineBias };
    if (this.line) this.line.solve(options);
    else this.line = new RaceLine(geo, options);
    this.lineHalfWidth = geo.halfWidth;
  }

  // -------------------------------------------------------------- frame

  /**
   * Decide this frame's stick and pedals. Call once per frame BEFORE
   * `vehicle.update(dt)`, after the trackers were refreshed (RivalField
   * .update does both). `cars` = every car on the track (own tracker
   * included; it is skipped).
   */
  think(dt: number, cars: readonly CarTracker[] = NO_CARS): void {
    const v = this.vehicle;
    const me = this.me;
    const geo = this.geo;
    if (!v || !me || !geo || !(dt > 0)) return;
    this.time += dt;
    if (geo.halfWidth !== this.lineHalfWidth) this.buildLine();
    const line = this.line!;
    const p = this.params;

    // --- budgets from the car as it is NOW (tuning may change live)
    this.paceNow += (clamp(this.pace, -0.08, 0.08) - this.paceNow) * Math.min(1, dt / 1.0);
    const boost = 1 + this.paceNow;
    const mug = Math.max(0.1, v.nominalGrip) * this.gravity;
    const lat = Math.min(p.cornerGrip * boost * boost, p.maxCornerGrip) * this.gripTrust * mug;
    const brk = Math.min(p.brakeGrip * boost * boost, p.maxBrakeGrip) * this.gripTrust * mug;
    const top = Math.min(1, p.topSpeedUse * boost) * v.topSpeed;
    if (
      Math.abs(lat - line.plannedLatAccel) > 0.015 * lat ||
      Math.abs(brk - line.plannedBrakeAccel) > 0.015 * brk ||
      Math.abs(top - line.plannedTopSpeed) > 0.01 * top
    ) {
      line.plan(lat, brk, top, this.gravity);
      this.stats.replans++;
    }
    this.turnLimit = (0.85 * Math.tan(Math.max(v.maxSteerAngle, 0.05))) / Math.max(v.wheelbase, 0.5);
    this.latAccel = lat;
    this.brakeAccel = brk;
    this.topUse = top;
    this.mug = mug;

    // How hard does this car actually pull? (sets the throttle gain)
    const blend = Math.min(1, dt / 0.15);
    this.accLP += ((me.vFwd - this.prevVFwd) / dt - this.accLP) * blend;
    this.thrLP += (this.hands.current.throttle - this.thrLP) * blend;
    this.prevVFwd = me.vFwd;
    if (this.driveGain <= 0) this.driveGain = 0.6 * mug;
    if (this.thrLP > 0.2 && this.hands.current.brake < 0.02 && me.vFwd > 1 && Math.abs(me.beta) < 0.15 && me.upY > 0.9) {
      const seen = this.accLP / this.thrLP;
      // Follow a stronger pull at once (stay stable), a weaker one within a
      // second or two (the pull fades with speed; do not stay timid).
      this.driveGain += (seen - this.driveGain) * Math.min(1, dt / (seen > this.driveGain ? 0.15 : 1.5));
      this.driveGain = clamp(this.driveGain, 0.1 * mug, 1.5 * mug);
    }

    if (this.mode === 'grid') {
      this.direct(0, 0, 0, dt);
      return;
    }
    if (this.mode !== 'rescue') this.checkRescue(dt, me, geo);
    if (this.mode === 'rescue') {
      this.direct(0, 0, 0, dt);
      return;
    }
    if (this.mode === 'reverse') this.reverse(dt, v, me, geo, cars);
    else this.drive(dt, v, me, geo, line, cars);
  }

  // ------------------------------------------------------------ driving

  private drive(dt: number, v: Vehicle, me: CarTracker, geo: TrackGeometry, line: RaceLine, cars: readonly CarTracker[]): void {
    const p = this.params;
    const speed = me.speed;
    const idx = me.index;
    const halfRoad = geo.halfWidth;
    const offRoad = Math.abs(me.lateral) - halfRoad;
    const lock = Math.max(v.maxSteerAngle, 1e-3);

    // Lights out from a grid slot: hold its lane (RivalParams.launchHold).
    // Only a car that really launches from a standstill on the road,
    // pointing down it (a lab scenario that sets a car going, knocks it
    // sideways or starts it off the road has no grid lane to hold).
    if (this.launchShare > 0) {
      const fresh = this.launchFresh;
      this.launchFresh = false;
      if (fresh &&
        (me.speed > 1.5 || Math.abs(me.headingError) > 0.35 || Math.abs(me.lateral) + me.halfWidth > halfRoad)) {
        this.launchShare = 0;
      } else {
        if (this.launchBlendFrom < 0 && (this.time >= this.launchHoldEnd || this.cornerDist < 45)) this.launchBlendFrom = this.time;
        if (this.launchBlendFrom >= 0) this.launchShare = Math.max(0, 1 - (this.time - this.launchBlendFrom) / Math.max(p.launchBlend, 1e-3));
      }
    }
    const cap = this.traffic(dt, me, geo, line, cars);
    this.lastTrafficCap = cap;

    // --- where to aim: a point on the (lane-limited) line ahead
    // Lookahead grows with speed but never spans much of a tight bend: aiming
    // across a hairpin cuts its inside (0.8 × the tightest radius in sight).
    let look = clamp(p.lookBase + p.lookTime * speed, p.lookMin, p.lookMax);
    const tightest = Math.max(
      Math.abs(line.curvature[idx]),
      Math.abs(line.curvature[geo.indexAhead(idx, 0.5 * look)]),
      Math.abs(line.curvature[geo.indexAhead(idx, look)]),
    );
    if (tightest * look > 0.8) look = Math.max(p.lookMin, 0.8 / tightest);
    // Held by a lane limit on the INSIDE of the bend ahead (a car alongside
    // there): the chord to the aim point cuts the bend by look²·κ/8 — toward
    // that car. Keep the cut under 0.3 m (s.sideBySide, seed 66: the car
    // behind cut 1 m into a right-hander beside the other and touched it).
    {
      const kAhead = line.curvature[geo.indexAhead(idx, 0.5 * look)];
      // (only a car ALONGSIDE: shortening the look for any lane limit — a pass
      // under way — slowed duel.k50k80 from 1.2 to 2.9 laps on some seeds)
      const inside = kAhead > 0 ? this.besideRight : this.besideLeft;
      if (inside && Math.abs(kAhead) > 1e-3) look = Math.max(p.lookMin, Math.min(look, Math.sqrt(2.4 / Math.abs(kAhead))));
    }
    const j = geo.indexAhead(idx, look);
    const wantHere = this.lateralAt(idx, me, geo, line);
    const wantAhead = this.lateralAt(j, me, geo, line);
    this.wantHere = wantHere;
    this.lastTargetLateral = wantHere;
    const dx = geo.px[j] + wantAhead * geo.tz[j] - me.x;
    const dz = geo.pz[j] - wantAhead * geo.tx[j] - me.z;
    const sin = Math.sin(me.yaw);
    const cos = Math.cos(me.yaw);
    const latT = dx * cos - dz * sin;
    const dist2 = Math.max(dx * dx + dz * dz, 1e-3);
    // Pure pursuit: the arc through the target point has κ = 2·lat / d².
    const kappa = (2 * latT) / dist2;
    let steer = Math.atan(v.wheelbase * kappa);
    const pathError = me.lateral - wantHere;
    // Beside another car the lane is a wall, not a suggestion: hold it harder.
    const walled = wantHere <= this.lo + 1e-6 || wantHere >= this.hi - 1e-6;
    // Cross-track trim on top of the pursuit. A gain on the error alone
    // makes the car weave (the stick answers late: reaction time + hands),
    // so it works on where the car will be `pathLead` seconds from now, and
    // fades with speed² like the lateral acceleration a wheel angle buys.
    const fade = Math.min(1, 100 / Math.max(speed * speed, 1));
    const errorRate = me.lateralSpeed - (me.speedAlong * (wantAhead - wantHere)) / Math.max(look, 1);
    // (squeezing through a gap at walking pace the trim must actually place
    // the car: at the racing gain a 0.3 m error was never closed before the
    // gap, s.blockedRoad)
    const squeeze = this.desperate > 0 && speed < 5 ? 8 : 1;
    steer -= (walled ? 1.5 : 1) * squeeze * p.pathKp * fade * clamp(pathError + (squeeze > 1 ? 1 : p.pathLead) * errorRate, -4, 4);
    // The lane limits (another car's side, the road edge) are walls: steer
    // away BEFORE the car's sideways motion carries it through one.
    if (speed > 4 && Math.abs(me.headingError) < 1) {
      const soon = me.lateral + me.lateralSpeed * p.wallTime;
      if (soon > this.hi) steer -= p.wallGain * fade * Math.min(soon - this.hi, 3);
      else if (soon < this.lo) steer += p.wallGain * fade * Math.min(this.lo - soon, 3);
    }

    // --- slide catch: past a few degrees of slip, countersteer takes over
    const forward = me.vFwd > 0.5;
    const beta = forward ? me.beta : 0;
    const w = clamp((Math.abs(beta) - p.catchBetaStart) / (p.catchBetaFull - p.catchBetaStart), 0, 1);
    this.lastCatch = w;
    if (w > 0) {
      const rate = me.yawRate - speed * kappa;
      const catchSteer = p.counterGain * beta - p.yawDamp * Math.atan((v.wheelbase * rate) / Math.max(speed, 3));
      steer = steer * (1 - w) + (steer * 0.5 + catchSteer) * w;
    }

    // --- how fast
    const preview = Math.max(1.5, speed * (p.reactionDelay + 0.3));
    const jp = geo.indexAhead(idx, preview);
    let target = Math.min(line.speed[idx], line.speed[jp]);
    target *= this.sectorFactor(me);
    if (target > this.topUse) target = this.topUse;
    // Kept off the planned line (passing, squeezed, leaving room): the
    // bends are tighter there than the plan assumed.
    const laneCap = this.laneSpeed(me, geo, line);
    const onLaneCurve = laneCap < target;
    target = Math.min(target, laneCap);
    // About to put a side over the edge: lift (nobody keeps the foot in
    // while the car is heading for the verge).
    const edgeSoon = Math.abs(me.lateral + me.lateralSpeed * 0.4) + me.halfWidth - halfRoad;
    if (edgeSoon > 0.3 && speed > 6 && me.lateral * me.lateralSpeed > 0 && this.desperate <= 0 && this.time >= this.obstacleUntil) {
      target = Math.min(target, speed - 2 * Math.min(edgeSoon, 2.5));
    }
    if (offRoad > 0.3) {
      // Centre beyond the edge: come back at a speed the rough can take.
      const f = clamp(offRoad / 4, 0, 1);
      target = Math.min(target, (0.8 + (p.offRoadSpeed - 0.8) * f) * this.topUse);
    }
    // Attacked by a quicker car: do not make a fight of it (see `defend`).
    if (this.ceding) target *= 1 - p.cedeLift * (1 - p.defend);
    if (this.cooldown) {
      // After the flag: roll off gently (the cars behind are still racing).
      this.coolSpeed = Math.max(p.cooldownSpeed * v.topSpeed, Math.min(this.coolSpeed, Math.max(speed, target)) - p.cooldownDecel * dt);
      target = Math.min(target, this.coolSpeed);
    } else {
      this.coolSpeed = Infinity;
    }
    if (cap < target) {
      target = cap;
      this.stats.cappedTime += dt;
    }
    // Pointing the wrong way: stop before anything else.
    const wrongWay = Math.abs(me.headingError) > 1.75;
    if (wrongWay) target = 0;
    this.lastTargetSpeed = target;

    let throttle = 0;
    let brake = 0;
    const err = target - me.vFwd;
    const spinning = speed > 3 && Math.abs(me.beta) > 1.3;
    // Pedal gains from what the car does in the time the driver needs to
    // correct: full pedal for an error the car closes in two loop times.
    const loop = p.reactionDelay + p.pedalTime + 0.05;
    const kThrottle = p.speedLoopGain / (this.driveGain * loop);
    const kBrake = p.speedLoopGain / (this.mug * loop);
    if (spinning) {
      // Both feet in: a spinning car is stopped, not driven.
      brake = 1;
      this.speedIntegral = 0;
    } else if (err < -p.brakeDeadband) {
      // Feed-forward: the deceleration the plan (or the car ahead) needs,
      // as a share of what the tires can give; feedback trims the rest.
      const vp = line.speed[jp];
      const planned = me.vFwd > vp ? (me.vFwd * me.vFwd - vp * vp) / (2 * preview) : 0;
      // (a tight lane's braking curve is braked for like the plan's own)
      const need = Math.max(Math.min(planned, this.brakeAccel), cap < me.vFwd ? this.trafficDecel : 0, onLaneCurve && cap >= laneCap ? this.laneDecel : 0);
      brake = clamp(need / this.mug + kBrake * (-err - p.brakeDeadband), 0, p.maxBrake);
      this.speedIntegral = 0;
    } else {
      const iMax = 0.5 / Math.max(kThrottle, 1e-3);
      this.speedIntegral = clamp(this.speedIntegral + err * dt, -0.2 * iMax, iMax);
      // The tires are busy turning: squeeze, do not stamp.
      const usage = Math.abs(me.yawRate * speed) / Math.max(this.latAccel, 1);
      const u = clamp((usage - 0.55) / 0.45, 0, 1);
      // … and with the wheel turned hard the foot stays light: full lock
      // and full throttle is how this car is THROWN into a slide (from a
      // standstill it pivots and leaves the road at 45°).
      const lockUse = clamp((Math.abs(this.hands.current.steering) - 0.35) / 0.65, 0, 1);
      const ceiling = Math.min(1, p.maxThrottle * (1 + 2 * Math.max(0, this.paceNow))) * (1 - p.exitCaution * u * u * (3 - 2 * u)) * (1 - p.lockCaution * lockUse);
      throttle = clamp(kThrottle * (err + this.speedIntegral / p.speedIntegralTime), 0, ceiling) * (1 - 0.8 * w);
    }
    // A brake held at standstill turns into reverse: let go once stopped.
    if (speed < 0.6) brake = 0;
    if (me.vFwd < 1 && (this.time < this.noBrakeUntil || (me.vFwd < -0.5 && !spinning))) {
      // Rolling backward (just backed out, or on a slope): the throttle
      // stops that, the brake pedal would be taken as "reverse".
      brake = 0;
      if (target > 0.5) throttle = Math.max(throttle, 0.5);
    }

    // --- learn how much grip there really is
    this.wideCooldown -= dt;
    const kLine = line.curvature[idx];
    const limit = this.laneLimit(me, geo);
    const free = this.lo <= -limit + 0.05 && this.hi >= limit - 0.05;
    if (this.wideCooldown <= 0 && this.time > this.graceUntil && speed > 6) {
      const outside = kLine > 0 ? -pathError : pathError;
      // (a wheel over the edge counts as running wide too)
      const overEdge = Math.abs(me.lateral) + me.halfWidth - halfRoad;
      const ranWide = free && ((Math.abs(kLine) > 1 / 80 && outside > 0.9) || overEdge > 0.2);
      const left = free && offRoad > 0.2;
      if (ranWide || left) {
        this.gripTrust = Math.max(0.6, this.gripTrust * (left ? 0.94 : 0.965));
        this.wideCooldown = left ? 3 : 1.5;
        this.stats.wideEvents++;
      }
    }
    if (offRoad < 0 && speed > 8 && this.gripTrust < 1) this.gripTrust = Math.min(1, this.gripTrust + 0.004 * dt);

    // --- stuck / wrong way
    if (this.time <= this.graceUntil) {
      this.stillX = me.x;
      this.stillZ = me.z;
    } else {
      // "Not getting anywhere" = has not moved 0.6 m from where the clock
      // started (speed alone is fooled by a car shuddering against a wall).
      const moved = Math.hypot(me.x - this.stillX, me.z - this.stillZ);
      if (moved > 0.6) {
        this.stillX = me.x;
        this.stillZ = me.z;
        this.slowTime = 0;
        this.pushTime = 0;
      } else {
        this.slowTime += dt;
        if (throttle > 0.3) this.pushTime += dt;
      }
      this.wrongWayTime = wrongWay && speed < 4 ? this.wrongWayTime + dt : 0;
      if (this.desperate > 0) this.desperate -= dt;
      if (this.wrongWayTime > 0.4) {
        this.startReverse(true);
      } else if (this.pushTime > p.stuckTime) {
        this.startReverse(false);
      } else if (this.slowTime > p.blockedTime && !this.blockedByTraffic) {
        this.startReverse(false);
      } else if (this.slowTime > 1.2 * p.blockedTime && this.blockedByTraffic) {
        // Waiting behind a car that is not going anywhere: back off and
        // go round it, over the shoulder if need be.
        this.desperate = 10;
        this.passCooldown = 0;
        this.startReverse(false, this.escapeSide);
      }
      if (this.mode !== 'race') {
        this.direct(0, 0, 0, dt);
        return;
      }
    }

    this.act(v, steer, lock, throttle, brake, dt);
  }

  /** Target lateral position at centreline point i: the line, plus the
   * driver's slow wander, inside the current lane limits. */
  private lateralAt(i: number, me: CarTracker, geo: TrackGeometry, line: RaceLine): number {
    const p = this.params;
    let want = line.offset[i];
    if (p.wander > 0) {
      let ds = geo.s[i] - me.s;
      if (ds < -geo.length / 2) ds += geo.length;
      const sU = me.progress + ds;
      const ph = p.seed * 0.7;
      want += p.wander * 0.625 * (Math.sin(sU * 0.1185 + ph) + 0.6 * Math.sin(sU * 0.273 + 2.1 * ph));
      want = clamp(want, -line.halfCorridor, line.halfCorridor);
    }
    if (this.launchShare > 0) want += (this.launchLat - want) * this.launchShare;
    return want < this.lo ? this.lo : want > this.hi ? this.hi : want;
  }

  /** Furthest the car's centre may go from the centreline for racecraft. */
  private laneLimit(me: CarTracker, geo: TrackGeometry): number {
    const p = this.params;
    // Racing another car is done ON the road; only an obstacle (a parked or
    // crawling car, a blockage) is worth a wheel on the shoulder.
    const extra = this.desperate > 0 ? p.shoulderUse + 2 : this.time < this.obstacleUntil ? p.shoulderUse : -p.edgeMargin;
    return Math.max(0.2, Math.min(geo.halfWidth + extra, p.maxLateral) - me.halfWidth);
  }

  /**
   * Highest speed right now that still makes every bend ahead on the path
   * the car will ACTUALLY drive. Where the lane limits hold the car off its
   * racing line the path is a lane parallel to the centreline — a tighter
   * arc than the line the plan was made for (the inside lane of a hairpin
   * has half the radius of the racing line through it). Scanned over the
   * whole braking distance, so a tight lane is braked for in time and not
   * found out at its apex. Infinity while the car is free to take its line.
   */
  private laneSpeed(me: CarTracker, geo: TrackGeometry, line: RaceLine): number {
    const lo = this.lo;
    const hi = this.hi;
    const wide = line.halfCorridor;
    this.laneDecel = 0;
    if (lo <= -wide && hi >= wide) return Infinity;
    const n = geo.n;
    const lat = this.latAccel;
    const brake = 1.4 * this.brakeAccel;
    const v = me.speed;
    const reach = Math.min(80, 6 + (v * v) / brake);
    const kMax = this.turnLimit;
    let best = Infinity;
    let bestAt = 0;
    let i = me.index;
    for (let d = 0; d < reach; ) {
      const raw = line.offset[i];
      const held = raw < lo ? lo : raw > hi ? hi : raw;
      const off = Math.abs(held - raw);
      if (off > 0.2) {
        const kc = geo.curvature[i];
        let kLane = Math.abs(kc / Math.max(0.3, 1 - kc * held));
        // (a lane tighter than the car can turn is not driven at any real
        // speed: the car has to be nearly stopped to get round it)
        if (kLane > kMax) kLane *= (kLane / kMax) * (kLane / kMax);
        const kLine = Math.abs(line.curvature[i]);
        if (kLane > kLine) {
          // (blended in over the first metre off the line)
          const k = kLine + (kLane - kLine) * Math.min(1, (off - 0.2) / 0.8);
          const vv = lat / Math.max(k, 1e-4) + brake * d;
          if (vv < best) {
            best = vv;
            bestAt = d;
          }
        }
      }
      d += geo.seg[i];
      i = i + 1 === n ? 0 : i + 1;
    }
    this.laneDecel = bestAt > 0.5 ? 0.5 * brake : 0;
    return best === Infinity ? Infinity : Math.sqrt(best);
  }

  /** Seeded mistakes: now and then a corner is entered too fast (braked
   * late) or a lift happens where none was needed. */
  private sectorFactor(me: CarTracker): number {
    const p = this.params;
    if (p.mistakeRate <= 0) return 1;
    const sector = Math.floor(me.progress / p.mistakeSector);
    const roll = hash01(p.seed, sector, 77);
    if (roll >= p.mistakeRate) return 1;
    if (sector !== this.lastMistakeSector) {
      this.lastMistakeSector = sector;
      this.stats.mistakes++;
    }
    const kind = hash01(p.seed, sector, 78);
    const size = p.mistakeSize * (0.5 + hash01(p.seed, sector, 79));
    return kind < 0.6 ? 1 + size : 1 - 1.5 * size;
  }

  // ---------------------------------------------------------- racecraft

  /**
   * Where the next real corner is: `cornerDist` = metres to the first point
   * ahead where the plan drops below `cornerZone` × the straight-line speed
   * (0 = in it, Infinity = none within 45 m), `cornerSide` = which side its
   * inside is on (+1 right, −1 left).
   */
  private scanCorner(me: CarTracker, geo: TrackGeometry, line: RaceLine): void {
    const threshold = this.params.cornerZone * this.topUse;
    const n = geo.n;
    let i = me.index;
    let d = 0;
    this.cornerDist = Infinity;
    this.cornerSide = 0;
    while (d < 45) {
      if (line.speed[i] < threshold) {
        this.cornerDist = d;
        break;
      }
      d += geo.seg[i];
      i = i + 1 === n ? 0 : i + 1;
    }
    if (this.cornerDist === Infinity) return;
    // Its inside: the way the road turns at the slowest point (already in
    // the corner: the slowest point still to come within a few metres).
    const window = this.cornerDist === 0 ? 8 : 25;
    let slowest = line.speed[i];
    let at = i;
    for (let dd = 0; dd < window; ) {
      dd += geo.seg[i];
      i = i + 1 === n ? 0 : i + 1;
      if (line.speed[i] < slowest) {
        slowest = line.speed[i];
        at = i;
      }
    }
    this.cornerSide = geo.curvature[at] > 0 ? 1 : -1;
  }

  /**
   * The next apex still ahead: the next low point of the speed plan that is
   * a real corner (below 85 % of the straight-line speed) and at least 3 m
   * away — past the apex of a bend, the NEXT bend is the one that counts.
   * `apexSide` = the side its inside is on.
   */
  private scanApex(me: CarTracker, geo: TrackGeometry, line: RaceLine): void {
    const threshold = 0.85 * this.topUse;
    const n = geo.n;
    const speed = line.speed;
    let i = me.index;
    let low = Infinity;
    let at = -1;
    let atD = 0;
    this.apexDist = Infinity;
    this.apexSide = 0;
    for (let d = 0; d < 70; ) {
      const v = speed[i];
      if (v < low) {
        if (low - v > 1e-3 || at >= 0) {
          at = i;
          atD = d;
        }
        low = v;
      } else if (v > low + 0.5) {
        if (at >= 0 && atD >= 3 && low < threshold) break;
        low = v;
        at = -1;
      }
      d += geo.seg[i];
      i = i + 1 === n ? 0 : i + 1;
    }
    if (at < 0 || atD < 3 || low >= threshold) return;
    this.apexDist = atD;
    this.apexSide = line.curvature[at] > 0 ? 1 : -1;
  }

  /**
   * Look at the other cars: narrows the lane limits [lo, hi] (pass side,
   * car alongside) and returns the speed that is still safe behind a car in
   * the way (Infinity = no limit).
   *
   * THE RULES (the same for every car, so two rivals always agree on who
   * does what; a human in the mix gets the same room a rival would):
   *
   *  ALONGSIDE — a car with a lane of its own next to mine whose length
   *  overlaps mine (or that is only just behind / ahead):
   *    · the car whose nose is behind keeps `sideClear` away from the other;
   *    · the car in front never moves TOWARD the other and, once the other's
   *      nose is past its tail, gives up half of the room that is missing
   *      (it "leaves a car's width") — on a road four to five cars wide
   *      (half width 5 m) that is what keeps two abreast clean;
   *    · at the turn-in of a real corner the car on the INSIDE keeps going
   *      and the car on the outside lifts unless it is half a length clear
   *      in front (the inside line is ~5 m shorter round a 90° bend: the car
   *      on it comes out ahead anyway, so the other tucks in behind it).
   *
   *  AHEAD in my lane — a block: the nearest car plus any car abreast of it
   *  that leaves no gap. It is followed ("lift rather than ram") or passed
   *  on ONE side, chosen once and kept:
   *    · on a straight on either side (the one with room, the one I am on,
   *      the inside of the next bend);
   *    · with a corner coming only down the INSIDE (out-braking). The
   *      leader that sees a car coming up its inside does not turn in on it
   *      (first rule), so the move works without anybody being hit;
   *    · a car that is hardly moving is an obstacle: passed anywhere, the
   *      move over made only when it is close (the racing line is kept
   *      through the bends before it).
   *
   *  A car right BEHIND me in my own lane is its driver's business, not
   *  mine: I keep my line.
   */
  private traffic(dt: number, me: CarTracker, geo: TrackGeometry, line: RaceLine, cars: readonly CarTracker[]): number {
    const p = this.params;
    const L = geo.length;
    const halfRoad = geo.halfWidth;
    const limit = this.laneLimit(me, geo);
    let wantLo = -limit;
    let wantHi = limit;
    let cap = Infinity;
    this.blockedByTraffic = false;
    this.trafficDecel = 0;
    this.yielding = false;
    this.besideRight = false;
    this.besideLeft = false;
    if (this.passCooldown > 0) this.passCooldown -= dt;
    const meOnRoad = Math.abs(me.lateral) < halfRoad;
    const count = cars.length;
    this.scanCorner(me, geo, line);
    this.scanApex(me, geo, line);
    // Lights out: for a moment every car ahead is standing — a grid, not a
    // row of obstacles to swerve round.
    const launching = this.time < this.launchUntil;
    // "Turn-in": the corner is less than half a second away (or we are in
    // it). "Coming": close enough that a pass started now ends in it.
    const turnIn = this.cornerDist < Math.max(5, p.turnInTime * me.speed);
    const cornerAhead = this.cornerDist < Math.max(18, p.cornerAheadTime * me.speed);
    const inside = this.cornerSide;
    if (this.tGap.length < count) {
      this.tGap = new Float64Array(count + 4);
      this.tWid = new Float64Array(count + 4);
      this.tShrink = new Float64Array(count + 4);
    }
    // (a car taken out of the field shifts the places of those after it:
    // what I remembered per place belongs to somebody else now)
    if (count < this.seenCount) {
      this.seenPace.fill(1);
      this.seenApex.fill(-1);
      this.pressure.fill(0);
      this.closeAvg.fill(0);
      this.latAvg.fill(NaN);
    }
    this.seenCount = count;
    if (this.seenPace.length < count) {
      this.seenPace = new Float64Array(count + 4).fill(1);
      this.seenApex = new Int32Array(count + 4).fill(-1);
      this.pressure = new Float64Array(count + 4);
      this.closeAvg = new Float64Array(count + 4);
      this.latAvg = new Float64Array(count + 4).fill(NaN);
    }
    const pressure = this.pressure;
    let pressed = -1;
    let letBySeen = false;
    const pace = this.seenPace;
    const tGap = this.tGap;
    const tWid = this.tWid;
    const tShrink = this.tShrink;
    let nearest = -1;
    let nearGap = Infinity;
    let file = -1;
    let fileGap = Infinity;
    let anyAhead = false;
    let besideSpeed = Infinity;
    let passAlongside = false;
    /** Gap to the nearest car ahead that is moving across into my lane. */
    let crossGap = Infinity;
    /** Where the car I am passing is (ds; NaN = out of sight). */
    let passRel = NaN;
    let attacker: string | null = null;
    /** The nearest much faster car closing from behind (index, bumper gap,
     * combined half widths). */
    let fastC = -1;
    let fastGap = Infinity;
    let fastWid = 0;
    let fastNear = false;

    const myArc = arcSpeed(me, geo);
    for (let c = 0; c < count; c++) {
      tWid[c] = -1;
      const o = cars[c];
      if (o === me || !o.active) continue;
      let ds = o.s - me.s;
      if (ds > L / 2) ds -= L;
      else if (ds <= -L / 2) ds += L;
      // (behind: as far back as a much faster car is looked for)
      if (ds > 70 || ds < -Math.max(15, p.fastSightRange + 8)) {
        // (out of sight: what I knew of it is stale when it comes back)
        this.closeAvg[c] = 0;
        this.latAvg[c] = NaN;
        if (o.id === this.fastDropId) this.fastDropId = null;
        continue;
      }
      // Arc length is measured on the CENTRELINE: two cars in the inside
      // lane of a tight bend are closer than that by (1 − κ·lateral) — a
      // follower 1.5 m off the bumper on paper touches it there (s.slowCar:
      // hugging the inside of R ≈ 11 m at 3.8 m from the centre).
      const kMid = geo.curvature[ds >= 0 ? geo.indexAhead(me.index, 0.5 * ds) : geo.indexAhead(o.index, -0.5 * ds)];
      // (only ever shortened: on the outside the real gap is longer, and
      // counting on that has a car cut back in on what it goes round)
      const slowIn = !o.driven ? 1 : clamp((p.insideGapPace - o.speedAlong / Math.max(line.speed[o.index], 1)) / 0.15, 0, 1);
      const shrink = o.speedAlong < 3 ? 0 : slowIn * p.insideGapShrink * Math.max(0, ds) * (1 - clamp(1 - kMid * 0.5 * (o.lateral + me.lateral), 0.4, 1));
      if (o.id === this.passId) passRel = ds;
      // How quick is it? Its speed at each apex against the lowest speed
      // of MY plan around that spot, and its speed flat out against mine.
      if (o.apexSerial !== this.seenApex[c]) {
        const first = this.seenApex[c] < 0;
        this.seenApex[c] = o.apexSerial;
        if (!first && !launching && o.apexSpeed > 4) {
          let mine = Infinity;
          let k = geo.wrapIndex(o.apexIndex - Math.round(6 / geo.meanStep));
          for (let d = 0; d < 12; d += geo.seg[k], k = k + 1 === geo.n ? 0 : k + 1) if (line.speed[k] < mine) mine = line.speed[k];
          if (mine < 0.9 * this.topUse) pace[c] += 0.6 * (clamp(o.apexSpeed / Math.max(mine, 1), 0.3, 1.3) - pace[c]);
        }
      } else if (!launching && o.unsteady < 0.1 * this.mug && line.speed[o.index] >= this.topUse - 0.05 && o.speedAlong > 4) {
        pace[c] += (clamp(o.speedAlong / this.topUse, 0.3, 1.3) - pace[c]) * Math.min(1, dt / 1.0);
      }
      // A car well off the road is not in the way of one that is on it.
      if (meOnRoad && Math.abs(o.lateral) - o.halfWidth > halfRoad + 1.5) continue;
      // A car at an angle — to the road, or to me — takes more room than
      // its width.
      // (squeezing past a blockage at walking pace the car lines itself up
      // as it goes: only the other's own angle counts — my angle while I
      // turn toward the gap read the gap as shut, s.blockedRoad)
      const cross = this.desperate > 0 && o.speed < 1 ? Math.abs(Math.sin(o.headingError))
        : Math.max(Math.abs(Math.sin(o.headingError)), Math.abs(Math.sin(o.headingError - me.headingError)));
      const widSum = me.halfWidth + o.halfWidth + (o.halfLength - o.halfWidth) * cross;
      const lenSum = me.halfLength + o.halfLength - (o.halfLength - o.halfWidth) * cross;
      const dLat = o.lateral - me.lateral;
      const absLat = Math.abs(dLat);
      const gap = ds - lenSum;
      // Daylight between the two cars' sides (negative = their widths overlap).
      const sep = absLat - widSum;
      // A much faster car coming up from behind (its nose not yet past my
      // middle): see RivalParams.fastCloseSpeed. Not an attacker to lift
      // for, not a tailgater to let by — a car to keep out of the way of.
      // (its closing speed a moment from now: a car flooring it out of a
      // corner behind me is fast before its speed says so; once seen, it
      // stays "fast" for `fastMemory` s while it is still behind me — it
      // sat on my tail through the corner and WILL come by on the exit)
      // (and it stops being "fast" once it no longer gains on me: a car
      // that sits behind me is following, not passing — fastLetGo)
      // (along the road, in metres of centreline per second: in a bend the
      // car in the inside lane covers more road than its speed says, and a
      // plain speed difference read a follower that was dropping back on the
      // outside as still closing — the rival held off its line for seconds)
      const closingNow = o.speedAlong - me.speedAlong;
      const closingArc = p.fastArc > 0 ? arcSpeed(o, geo) - myArc : closingNow;
      const other = !o.driven;
      const look = other && p.fastAccelLookOther >= 0 ? p.fastAccelLookOther : p.fastAccelLook;
      const smooth = other && p.fastSmoothOther >= 0 ? p.fastSmoothOther : p.fastSmooth;
      const closingSoon = closingNow + Math.max(0, o.accelAlong - Math.max(0, me.accelAlong)) * look;
      const closeAvg = this.closeAvg;
      closeAvg[c] += (closingSoon - closeAvg[c]) * (smooth > 0 ? Math.min(1, dt / smooth) : 1);
      const latAvg = this.latAvg;
      latAvg[c] = Number.isFinite(latAvg[c]) ? latAvg[c] + (o.lateral - latAvg[c]) * Math.min(1, dt / p.fastLatSmooth) : o.lateral;
      // (in sight: the side is decided, a move across its line made only
      // now if at all; near: out of its way)
      const sighted = ds <= 0.25 * lenSum && o.speedAlong > 3 && -ds - lenSum < p.fastSightRange && o.id !== this.fastDropId;
      const near = sighted && -ds - lenSum < p.fastCloseRange;
      const seenFast = sighted && closeAvg[c] > p.fastCloseSpeed;
      // (whether it still gains is judged along the road: behind me on the
      // outside of a bend it can be quicker and still drop back)
      if (o.id === this.fastSeenId) this.fastLag = closingArc < p.fastHoldClosing ? this.fastLag + dt : 0;
      if (seenFast && (o.id === this.fastSeenId || this.fastSeenId === null || this.time >= this.fastSeenUntil)) {
        if (o.id !== this.fastSeenId) {
          this.fastLag = 0;
          this.fastHeld = 0;
        }
        this.fastSeenId = o.id;
        this.fastSeenUntil = this.time + p.fastMemory;
      }
      // (a car let go stays let go until it gains on me again — a burst of
      // its acceleration alone does not re-arm the rule)
      const letGo = o.id === this.fastSeenId && this.fastLag >= p.fastLetGo;
      const remembered = o.id === this.fastSeenId && this.time < this.fastSeenUntil;
      const fast = p.fastCarRule !== 'off' && sighted && !letGo && (seenFast || remembered);
      if (fast && near && o.id === this.fastSeenId) this.fastHeld += dt;
      if (fast && this.fastHeld > p.fastHoldMax && o.id === this.fastSeenId) {
        // Behind me all this time and never by: following, after all.
        this.fastDropId = o.id;
        this.fastSeenId = null;
        continue;
      }
      if (fast && -ds - lenSum < fastGap) {
        fastGap = -ds - lenSum;
        fastC = c;
        fastWid = widSum;
        fastNear = near;
      }
      // A car OUT OF CONTROL — sliding far past anything a driver holds, or
      // pointing well off the road — ahead of me or beside me: drop back
      // behind it and keep clear of the side it is on. (The player stand-in
      // that spins in a fast bend hit cars beside it at 15-18 m/s.)
      // (a held drift follows the road and is not "wild": wildDrift)
      // (pointing off the road counts only when it also points off a racing
      // line there — MY line where it is: a leader driving its own line out
      // of a tight bend points 20-26 deg off the road's direction at 7-9 m/s
      // across it, and was taken for a car out of control at exactly the
      // place a pass is made; duel.k50k80 took 1.3-1.7 laps instead of 0.9)
      let askew = Math.abs(o.beta) > p.wildSlip;
      if (!askew && Math.abs(o.headingError) > p.wildHeading) {
        const kA = o.index < 2 ? o.index + geo.n - 2 : o.index - 2;
        const kB = o.index + 2 >= geo.n ? o.index + 2 - geo.n : o.index + 2;
        const run = geo.seg[kA] + geo.seg[o.index > 0 ? o.index - 1 : geo.n - 1] + geo.seg[o.index] + geo.seg[o.index + 1 === geo.n ? 0 : o.index + 1];
        const lineAngle = Math.atan2(line.offset[kB] - line.offset[kA], Math.max(run, 0.5));
        askew = Math.abs(o.headingError - lineAngle) > p.wildHeading;
      }
      const wild = o.speed > 5 && (Math.abs(o.beta) > p.wildSpin || (askew && Math.abs(o.lateralSpeed) > p.wildDrift));
      // (a car AHEAD that slides past `wildSlip` is dropped back from even
      // while it holds the slide along the road: it may not hold it — the
      // sideways-speed condition only spares the car beside a held drift
      // the extra berth; s.driftAhead)
      const wildAhead = wild || (o.speed > 5 && ds > 0 && Math.abs(o.beta) > p.wildSlip);
      if (wildAhead && ds > -lenSum && gap < 12 && sep < 3) {
        // Ahead of my middle: drop back behind it. Beside and behind my
        // middle: no lift (braking would leave me where it is going).
        if (ds > 0) {
          const drop = Math.max(0, o.speedAlong - p.wildDrop);
          if (drop < cap) cap = drop;
          if (drop < me.speedAlong) this.stats.wildTime += dt;
        }
      }
      if (wild && ds > -lenSum && gap < 12 && sep < 3) {
        // Clear of where it is and of where it is sliding to.
        const clear = widSum + 1.5;
        const to = o.lateral + clamp(o.lateralSpeed, -8, 8) * p.wildLook;
        if (dLat > 0) wantHi = Math.min(wantHi, Math.max(-limit, Math.min(o.lateral, to) - clear));
        else wantLo = Math.max(wantLo, Math.min(limit, Math.max(o.lateral, to) + clear));
      }
      // It has a lane of its own next to mine (a hand's width of overlap
      // still counts: that is a car alongside that came too close).
      const beside = sep > -0.25;

      // A car coming up fast from behind is "alongside" earlier: do not
      // move across its bows (covers rejoining the road in front of it).
      const overtaken = Math.max(0, o.speedAlong - me.speedAlong);
      if (beside && gap < 0.8 && ds > -(lenSum + p.cutInGap + overtaken)) {
        // ALONGSIDE (or only just past): keep to my side of it.
        if (o.id === this.passId) passAlongside = true;
        // Its nose is behind mine and it is coming: an attack. (the car
        // already being let by stays "the attacker" until it is through or
        // gone; the car I have just passed myself does not count)
        if (
          !launching && !fast && ds <= 0.25 * lenSum && o.speedAlong > 3 &&
          (o.id === this.cedeTo || o.id === this.letBy || (o.speedAlong > me.speedAlong + 0.3 && !(o.id === this.beatenId && this.time < this.beatenUntil)))
        ) {
          attacker = o.id;
        }
        if (o.id === this.letBy) letBySeen = ds <= 0.25 * lenSum;
        if (dLat > 0) this.besideRight = true;
        else this.besideLeft = true;
        // (squeezing past a standing car: the squeeze clearance — the full
        // side clearance shut a 3.1 m gap between two wrecks, s.blockedRoad)
        const need = widSum + (this.desperate > 0 && o.speed < 1 ? p.squeezeClear : p.sideClear);
        if (dLat > 0) {
          // (where the other will be once its sideways motion is stopped /
          // where I will be once mine is: a car drifting toward the other
          // steers back at once)
          const oLat = o.lateral + Math.min(0, o.lateralSpeed) * p.sideAnticipation;
          let mine = oLat - need;
          if (ds <= 0) {
            const hold = Math.max(-limit, me.lateral - Math.max(0, me.lateralSpeed) * p.sideAnticipation);
            mine = ds > -lenSum ? Math.min(hold, Math.max(-limit, (me.lateral + oLat - need) / 2)) : Math.max(mine, hold);
          }
          wantHi = Math.min(wantHi, mine);
        } else {
          const oLat = o.lateral + Math.max(0, o.lateralSpeed) * p.sideAnticipation;
          let mine = oLat + need;
          if (ds <= 0) {
            const hold = Math.min(limit, me.lateral - Math.min(0, me.lateralSpeed) * p.sideAnticipation);
            mine = ds > -lenSum ? Math.max(hold, Math.min(limit, (me.lateral + oLat + need) / 2)) : Math.min(mine, hold);
          }
          wantLo = Math.max(wantLo, mine);
        }
        if (turnIn && inside !== 0 && o.speedAlong > 2 && inside * dLat > 0 && ds > -0.5 * lenSum) {
          // Two abreast into a corner and I am on the outside without being
          // clear in front: the corner is his. Lift and tuck in behind.
          cap = Math.min(cap, Math.max(0, o.speedAlong - p.yieldLift));
          this.yielding = true;
        }
        if (ds > -0.3 * lenSum && o.speedAlong < besideSpeed) besideSpeed = o.speedAlong;
        if (ds > 0 && sep < 0.3) {
          // Its tail is beside my nose with a hand's width between us: do
          // not push through, gain on it only as fast as the gap opens.
          cap = Math.min(cap, o.speedAlong + (sep < 0 ? -0.5 : 0.5));
        } else if (ds > -0.3 * lenSum && sep < 1.5) {
          // Going by with little room to spare: not at any speed.
          cap = Math.min(cap, o.speedAlong + p.passSpeedBase + p.passSpeedPerMetre * sep);
        }
        continue;
      }
      // Behind me (in my own lane, or further back in another): not mine
      // to avoid. But one that sits on my tail is asking to be let by.
      if (ds <= 0) {
        const behind = -ds - lenSum;
        if (o.id === this.letBy) letBySeen = behind < 12;
        if (fast) continue;
        // … except that I do not move across the bows of a car closing on me
        // from just behind and off to one side: my lateral is held on its
        // side. (Stand-in races: 1-2 contacts per race in which the RIVAL
        // moved toward the player — most of them at 2 s after lights out, a
        // slow rival leaving its grid slot for its line in front of the
        // stand-in coming up beside it.)
        if (p.closeBehindGap > 0 && behind < p.closeBehindGap && o.speedAlong - me.speedAlong > 1 && o.speedAlong > 3 && absLat > 0.3 && absLat < widSum + 1.5) {
          if (dLat > 0) wantHi = Math.min(wantHi, Math.max(-limit, me.lateral));
          else wantLo = Math.max(wantLo, Math.min(limit, me.lateral));
        }
        if (!launching && behind < p.pressGap * clamp(me.speed / 20, 0.75, 1.15) && absLat < 0.8 * widSum && o.speedAlong > 3) {
          pressure[c] += dt;
          if (pressed < 0 || pressure[c] > pressure[pressed]) pressed = c;
        } else if (pressure[c] > 0) {
          pressure[c] = Math.max(0, pressure[c] - 0.5 * dt);
        }
        continue;
      }
      if (pressure[c] > 0) pressure[c] = 0;
      // (the real bumper gap is shorter by `shrink` in an inside lane: only
      // the FOLLOWING speed is worked out from that — see approach())
      tShrink[c] = shrink;
      const gapA = gap;
      const closing = me.speedAlong - o.speedAlong;
      let horizon = p.followGap + 4 + Math.max(0, closing) * p.trafficTime;
      if (o.id === this.passId) horizon *= 1.5;
      if (this.desperate > 0) horizon += 15;
      if (gapA > horizon) continue;
      // Ahead, within sight: part of the picture (it may close the gap
      // beside the car I am about to pass) …
      tGap[c] = gapA;
      tWid[c] = widSum;
      // … and, at the turn-in, the car to file in behind whatever lane it
      // is in — unless it is hardly moving (that one gets passed) or it is
      // making room for me. (My nose is still behind its tail here: two
      // abreast into a slow corner only works with a real overlap — the
      // inside lane of a hairpin is tighter than the car can turn.)
      if (
        turnIn && gapA < fileGap && o.speedAlong > 0.4 * line.speed[o.index] &&
        !(beside && gapA < p.cutInGap + Math.max(0, closing) && o.givingWayTo === me.id)
      ) {
        fileGap = gapA;
        file = c;
      }
      anyAhead = true;
      const reach = widSum + 0.2;
      // Where will it be when I get there? A car moving across toward my
      // lane (turning in for the corner, coming back from the edge) is in
      // my way before it is in front of me.
      const arrive = closing > 0.5 ? Math.min(gapA / closing, 0.8) : 0.8;
      const soonLat = o.lateral + o.lateralSpeed * arrive - (me.lateral + Math.min(Math.abs(me.lateralSpeed), 1.5) * Math.sign(me.lateralSpeed) * arrive);
      const crossing = gapA < 12 && Math.abs(soonLat) < reach && o.lateralSpeed * dLat < 0;
      // (the car being passed stays the reference until it is alongside,
      // even once I am clear of it sideways — or the lane would be let go
      // in the last metres before it)
      // … or sits on the line I am about to take (my line where IT is: the
      // car hugging the apex I am turning in for).
      const there = line.offset[o.index];
      const onMyLine = gapA < 25 && Math.abs(o.lateral - (there < this.lo ? this.lo : there > this.hi ? this.hi : there)) < reach;
      // A car that is (nearly) standing with little daylight beside my
      // path: go by it at the speed that daylight allows, braked for from
      // here — also when it is not "in my lane" (going round a wreck on the
      // outside of a bend, a car that floors it there sags into it).
      if (o.speedAlong < 3 && gapA < 15 && sep < 1.5) {
        const by = Math.max(0, o.speedAlong) + p.passSpeedBase + p.passSpeedPerMetre * Math.max(0, sep);
        cap = Math.min(cap, Math.sqrt(by * by + 1.4 * this.brakeAccel * Math.max(0, gapA)));
      }
      if (absLat >= reach && Math.abs(o.lateral - this.wantHere) >= reach && o.id !== this.passId && !crossing && !onMyLine) continue;
      if (crossing && gapA < crossGap) crossGap = gapA;
      // … and in my lane (or the lane I am heading for): a blocker.
      if (gapA < nearGap) {
        nearGap = gapA;
        nearest = c;
      }
    }

    let passSeen = passAlongside;
    this.lastEdge = nearest >= 0 ? 1 - pace[nearest] : 0;
    if (nearest >= 0) {
      const o = cars[nearest];
      // Hardly moving: an obstacle, not a rival.
      const crawling = !launching && o.speedAlong < 0.4 * line.speed[o.index];
      // Zone my centre must stay out of to clear the block (more room round
      // something standing than beside a car that races).
      const clearHere = this.clearFor(o, launching, line);
      let a = o.lateral - tWid[nearest] - clearHere;
      let b = o.lateral + tWid[nearest] + clearHere;
      for (let round = 0; round < 2; round++) {
        for (let c = 0; c < count; c++) {
          if (c === nearest || tWid[c] < 0 || tGap[c] - nearGap > 8) continue;
          const cc = this.clearFor(cars[c], launching, line);
          const ia = cars[c].lateral - tWid[c] - cc;
          const ib = cars[c].lateral + tWid[c] + cc;
          if (ia < b && ib > a) {
            if (ia < a) a = ia;
            if (ib > b) b = ib;
          }
        }
      }
      const slack = clearHere - 0.2;
      // (a car that is coming across into my lane counts as in it already:
      // brake for it now, not when its side is in front of my nose)
      const inLane = (me.lateral > a + slack && me.lateral < b - slack) || crossGap <= nearGap + 1e-6;
      const okR = b <= limit + 0.3;
      const okL = a >= -limit - 0.3;
      const closing = me.speedAlong - o.speedAlong;
      let side = 0;
      if (this.passId === o.id && this.passSide !== 0) {
        side = this.passSide;
        if (inLane && !(side > 0 ? okR : okL)) {
          // The door closed: fall in behind, and no second thoughts for a
          // moment (no diving to the other side straight away).
          side = 0;
          this.failedAttack();
        }
      } else if (crawling || this.desperate > 0) {
        // An obstacle: round it where there is room (already clear of it
        // to one side: stay there).
        if (!inLane) side = me.lateral >= (a + b) / 2 ? 1 : -1;
        else if (this.passCooldown <= 0) side = this.chooseSide(a, b, okR, okL, limit, me, 0);
      } else if (!launching && this.passCooldown <= 0 && nearGap < p.attackRange + clamp(closing, 0, 2) && 1 - pace[nearest] > p.passEdge) {
        // A rival I have SEEN to be slower than me, close enough to go for.
        //  · So much slower that I am past and clear before it turns in for
        //    the next corner: on either side, like an obstacle.
        //  · Else only down the inside of the next corner (that is where a
        //    pass is finished on a twisty road — the inside car has the
        //    shorter way round and the other may not turn in on it), and
        //    only if I can show it my nose in time. No room there yet (it
        //    has not moved out for the corner): wait behind it, do not try
        //    the outside.
        const edge = 1 - pace[nearest];
        const gain = edge * Math.min(line.speed[me.index], this.topUse);
        const clearBy = nearGap + me.halfLength + o.halfLength + p.cutInGap;
        const here = !inLane ? (me.lateral >= (a + b) / 2 ? 1 : -1) : 0;
        if (this.timeToTurnIn(o, me) * gain > clearBy) {
          side = here !== 0 ? here : this.chooseSide(a, b, okR, okL, limit, me, 0);
        } else if (!turnIn) {
          const must = this.apexSide !== 0 ? this.apexSide : cornerAhead ? inside : 0;
          const want = here !== 0 ? (must === 0 || must === here ? here : 0) : this.chooseSide(a, b, okR, okL, limit, me, must);
          // (not while the car is on its way to the other side of the road:
          // a pass starts from a settled car, or it ends on the verge)
          if (want !== 0 && me.lateralSpeed * want > -2 && this.canReach(o, want > 0 ? b - me.lateral : me.lateral - a, me)) side = want;
        }
      }
      if (side !== 0) {
        if (this.passId !== o.id || this.passSide !== side) {
          if (this.passId === o.id && this.passSide === -side) this.stats.sideFlips++;
          else this.stats.passesStarted++;
          this.passId = o.id;
          this.passSide = side;
          this.passTime = 0;
          // Pull out from where the car IS: the lane limit on the far side
          // starts at the car, not at the other edge of the road (it would
          // take a second to come across, and the corner is a second away).
          if (side > 0) this.lo = Math.max(this.lo, Math.min(me.lateral, b, limit));
          else this.hi = Math.min(this.hi, Math.max(me.lateral, a, -limit));
        }
        passSeen = true;
        if (crawling || this.desperate > 0) this.obstacleUntil = this.time + 1;
        // An obstacle still far off: the side is decided, the move over
        // waits until it takes about as long as getting there does.
        const over = Math.max(0, side > 0 ? b - me.lateral : me.lateral - a);
        const early = crawling && this.desperate <= 0 && nearGap > Math.max(0, closing) * (over / p.laneRateApply + p.obstacleLead) + 6;
        if (!early) {
          if (side > 0) wantLo = Math.max(wantLo, Math.min(b, limit));
          else wantHi = Math.min(wantHi, Math.max(a, -limit));
          if (this.desperate > 0) {
            // Squeezing through: the gap on that side ends at the next car
            // (or at the lane limit — `maxLateral`). A narrow one is driven
            // down its MIDDLE: aimed at its near edge the car arrived 0.3 m
            // off and stood with its nose in it (s.blockedRoad).
            let far = side > 0 ? limit : -limit;
            for (let c = 0; c < count; c++) {
              if (tWid[c] < 0 || tGap[c] - nearGap > 8 || c === nearest) continue;
              const cc = this.clearFor(cars[c], launching, line);
              const edge = side > 0 ? cars[c].lateral - tWid[c] - cc : cars[c].lateral + tWid[c] + cc;
              if (side > 0 ? edge >= b - 1e-6 && edge < far : edge <= a + 1e-6 && edge > far) far = edge;
            }
            const near = side > 0 ? b : a;
            if (Math.abs(far - near) < 1.2) {
              const mid = (far + near) / 2;
              wantLo = Math.max(wantLo, mid - 0.05);
              wantHi = Math.min(wantHi, mid + 0.05);
              // … slowly, and only once lined up for it: at the dodge speed
              // (7 m/s) the car came in 0.3 m off and 16 deg askew and hit
              // the wreck at 5-7 m/s.
              const off = Math.abs(me.lateral - mid) - 0.5 * Math.abs(far - near);
              cap = Math.min(cap, off > 0 && nearGap < 3 ? 0.8 : 1.5 + 0.3 * Math.max(0, nearGap));
            }
          }
        }
      }
      if (inLane || side === 0) {
        // Behind it in its lane — or beside its lane with no business going
        // by: never faster than can be braked off before the gap is gone
        // ("lift rather than ram"); the car slots in behind.
        // (a car I have seen to be slower gets me on its tail: that is how
        // its driver knows I want by)
        const pressing = !crawling && !launching && 1 - pace[nearest] > p.passEdge;
        let allowed = this.approach(o, nearGap - this.tShrink[nearest], side !== 0 ? p.passGap : pressing ? p.pressFollow : p.followGap, me, geo, line);
        if (side !== 0 && this.apRoom > 0) {
          // Pulling out takes time: close no faster than the gap lasts
          // while the car moves over.
          const over = side > 0 ? b - me.lateral : me.lateral - a;
          allowed = Math.min(allowed, this.apLead + this.apRoom / Math.max(0.3, over / p.laneRateApply));
        }
        // Squeezing past a blockage: keep rolling at walking pace while
        // there is any gap at all (a standing car cannot move sideways).
        if (this.desperate > 0 && side !== 0 && nearGap > 0.4) allowed = Math.max(allowed, 1.5);
        if (allowed < cap) cap = allowed < 0 ? 0 : allowed;
        if (allowed < 1) this.blockedByTraffic = true;
        if (o.speedAlong < besideSpeed) besideSpeed = o.speedAlong;
      } else if (side !== 0) {
        // Clear of it sideways and coming up on it: arrive no faster than
        // the room beside it allows (braked for from here, not found out
        // when the noses are level).
        const sepNow = Math.abs(o.lateral - me.lateral) - tWid[nearest];
        if (sepNow < 1.5) {
          const by = o.speedAlong + p.passSpeedBase + p.passSpeedPerMetre * Math.max(0, sepNow);
          cap = Math.min(cap, Math.sqrt(by * by + 1.4 * this.brakeAccel * Math.max(0, nearGap)));
        }
      }
      // Which way round if it comes to backing off and using the shoulder.
      // (the side the car is already on; dead centre: the roomier one)
      const off = me.lateral - (a + b) / 2;
      this.escapeSide = Math.abs(off) > 0.3 ? (off > 0 ? 1 : -1) : limit - b >= a + limit ? 1 : -1;
    }

    if (file >= 0 && file !== nearest) {
      const allowed = this.approach(cars[file], fileGap - this.tShrink[file], p.followGap, me, geo, line);
      if (allowed < cap) {
        cap = allowed < 0 ? 0 : allowed;
        this.yielding = true;
      }
    }
    if (file >= 0 && cars[file].id === this.passId && this.desperate <= 0) {
      // The corner is here and I am not alongside: the attack is over. Fall
      // in behind and think again after the corner.
      this.failedAttack();
      passSeen = false;
    }

    // A much faster car closing from behind, rule 'hold': stay where I am on
    // its side — only a move back to my line AWAY from it (lane limit at my
    // own lateral on its side, ratcheted outward as I move away).
    if (fastC >= 0 && p.fastCarRule === 'hold') {
      const o = cars[fastC];
      const held = Number.isFinite(this.latAvg[fastC]) ? this.latAvg[fastC] : o.lateral;
      if (this.fastId !== o.id) {
        this.fastId = o.id;
        const d = held - me.lateral;
        // (right behind me: the side with more room)
        this.fastSide = d > 0.3 ? -1 : d < -0.3 ? 1 : limit - me.lateral >= me.lateral + limit ? 1 : -1;
        this.fastHoldLat = me.lateral;
      }
      this.fastHoldLat = this.fastSide > 0 ? Math.max(this.fastHoldLat, me.lateral) : Math.min(this.fastHoldLat, me.lateral);
      this.fastUntil = this.time + 0.5;
      if (fastNear) {
        this.stats.fastTime += dt;
        if (cornerAhead) this.stats.fastCornerTime += dt;
      }
      const at = clamp(this.fastHoldLat, -limit, limit);
      if (this.fastSide > 0) wantLo = Math.max(wantLo, at);
      else wantHi = Math.min(wantHi, at);
    } else if (fastC >= 0) {
      // Rule 'yield': never move across its path; on a straight, get to the
      // side it is not on (chosen once per car).
      const o = cars[fastC];
      const need = fastWid + p.fastClear;
      // (where it will be in a moment — only a moment, and its sideways
      // speed bounded: a car weaving behind me must not make me cross over)
      const closingNow = Math.max(o.speedAlong - me.speedAlong, 0.5);
      const reach = clamp(fastGap / Math.max(closingNow, 1), 0, 0.5);
      const oLat = o.lateral + clamp(o.lateralSpeed, -3, 3) * reach;
      // The line it holds: its lateral smoothed (one frame of a car that is
      // still swerving decided the side before: rival pinned at the edge on
      // its side and hit at 7-10 m/s, or sent across its bows).
      const held = Number.isFinite(this.latAvg[fastC]) ? this.latAvg[fastC] : o.lateral;
      // (not all the way to the edge: a car moving over briskly runs on a
      // little past its lane limit, and that must not put a wheel off)
      const room = Math.max(0.2, limit - p.fastEdgeKeep);
      if (this.fastId !== o.id) {
        this.fastId = o.id;
        const d = held - me.lateral;
        // (right behind me: the side with more room beside its line)
        this.fastSide = d > 0.3 ? -1 : d < -0.3 ? 1 : room - held >= held + room ? 1 : -1;
        this.fastReach = held;
        this.fastCrossed = false;
      }
      // No room on my side of its line and room on the other: the other
      // side — but only while the move over is done `fastCrossTime` s
      // before it gets to me (from where I am, at the quick lane rate),
      // once per car, and never with a corner coming.
      const spaceMine = this.fastSide < 0 ? held - need + room : room - (held + need);
      const spaceOther = this.fastSide < 0 ? room - (held + need) : held - need + room;
      if (!this.fastCrossed && !cornerAhead && spaceMine < 0 && spaceOther >= 0 && spaceOther > spaceMine + 1) {
        const target = this.fastSide < 0 ? held + need : held - need;
        const cross = Math.abs(target - me.lateral) / (p.fastLaneRate * p.laneRateApply);
        if (fastGap / closingNow - 1.3 * cross >= p.fastCrossTime) {
          this.fastSide = -this.fastSide;
          this.fastReach = held;
          this.fastCrossed = true;
          this.stats.fastSwaps++;
        }
      }
      this.fastUntil = this.time + 0.5;
      // Still well back (in sight, not yet near): nothing to do unless I am
      // on my way across to the other side.
      if (fastNear || this.fastCrossed) {
        this.stats.fastTime += dt;
        if (cornerAhead) this.stats.fastCornerTime += dt;
        // (with a corner coming the side is the one I am on — never across)
        // (but a move to the other side already under way is finished: turned
        // back half way it ends on the fast car's line)
        if (cornerAhead && !this.fastCrossed && this.fastSide * (me.lateral - oLat) < 0 && Math.abs(me.lateral - oLat) > 0.3) {
          this.fastSide = me.lateral > oLat ? 1 : -1;
          this.fastReach = oLat;
        }
        // (kept from the furthest it has come toward my side: a car weaving
        // behind me swings back, and the room it left is not mine to take)
        this.fastReach = this.fastSide < 0 ? Math.min(this.fastReach, oLat) : Math.max(this.fastReach, oLat);
        // (no room to spare on my side: the whole lane, edge keep or not)
        const use = (this.fastSide < 0 ? this.fastReach - need < -room : this.fastReach + need > room) ? limit : room;
        if (this.fastSide < 0) wantHi = Math.min(wantHi, Math.max(-use, this.fastReach - need));
        else wantLo = Math.max(wantLo, Math.min(use, this.fastReach + need));
      }
    } else if (this.time > this.fastUntil) {
      this.fastId = null;
    }

    // Tailgated for long enough: let it by. Keep to the outside of the next
    // corner (the side I am on if none is in sight) and lift.
    if (this.letBy !== null && (!letBySeen || this.time > this.letByUntil)) {
      this.letBy = null;
      this.letByAgain = this.time + p.letByRest;
    }
    if (
      this.letBy === null && pressed >= 0 && p.defend < 1 && pressure[pressed] > p.pressTime && this.time > this.letByAgain &&
      !(cars[pressed].id === this.beatenId && this.time < this.beatenUntil) && this.passId === null && this.desperate <= 0 && !this.cooldown
    ) {
      this.letBy = cars[pressed].id;
      this.letByUntil = this.time + p.letByTime;
      this.letBySide = this.apexSide !== 0 ? -this.apexSide : me.lateral >= 0 ? 1 : -1;
      pressure[pressed] = 0;
      this.stats.letBys++;
    }
    // Finished: out of the way, on the right.
    if (this.cooldown && this.desperate <= 0) wantLo = Math.max(wantLo, Math.min(limit, 0.5 * me.halfWidth + 0.3));
    if (this.letBy !== null) {
      const keep = Math.min(limit, 0.5 * me.halfWidth + 0.3);
      if (this.letBySide > 0) wantLo = Math.max(wantLo, keep);
      else wantHi = Math.min(wantHi, -keep);
    }
    this.cedeTo = attacker;
    this.ceding = (attacker !== null || this.letBy !== null) && p.defend < 1;
    // (said out loud, so the other driver knows the door is open)
    me.givingWayTo = this.ceding ? (this.letBy ?? attacker) : null;
    if (!passSeen && this.passId !== null && passRel < 0) {
      // The car I was passing is behind me: done. It gets no gift back.
      this.beatenId = this.passId;
      this.beatenUntil = this.time + 8;
      this.failId = null;
      this.fails = 0;
    }
    if (passSeen) {
      this.passTime += dt;
      this.stats.passTime += dt;
      if (this.passTime > 12) {
        // Not getting by: give it a rest (and do not sit beside it forever).
        this.passId = null;
        this.passSide = 0;
        this.passCooldown = 3;
      }
    } else {
      this.passId = null;
      this.passSide = 0;
    }
    if (this.yielding) this.stats.yieldTime += dt;
    if (this.ceding) this.stats.cedeTime += dt;
    // Feeling the way round a blockage: gingerly.
    if (this.desperate > 0 && (anyAhead || besideSpeed < Infinity)) cap = Math.min(cap, p.dodgeSpeed * this.topUse);
    if (this.dodgeSide !== 0 && this.time < this.dodgeUntil && geo.arcDelta(this.dodgeS, me.s) > me.halfLength + 6) {
      this.dodgeUntil = 0;
    }
    if (this.dodgeSide !== 0 && this.time < this.dodgeUntil) {
      // Going round whatever stopped us (see startReverse), gingerly.
      this.obstacleUntil = this.time + 1;
      cap = Math.min(cap, p.dodgeSpeed * this.topUse);
      const width = 2 * me.halfWidth + 0.4;
      if (this.dodgeSide > 0) wantLo = Math.max(wantLo, Math.min(limit, this.dodgeLat + width));
      else wantHi = Math.min(wantHi, Math.max(-limit, this.dodgeLat - width));
    }
    if (wantLo > wantHi) {
      // No room on either side: sit between them and drop back.
      const mid = clamp((wantLo + wantHi) / 2, -limit, limit);
      wantLo = mid;
      wantHi = mid;
      if (besideSpeed < Infinity) cap = Math.min(cap, Math.max(0, besideSpeed - 0.5));
    }
    if (!this.laneReady) {
      // First look after a start / respawn: no easing in.
      this.lo = wantLo;
      this.hi = wantHi;
      this.laneReady = true;
    }
    // (the rates are for stability at speed; at manoeuvring pace the lane
    // may move as fast as the car can follow)
    // (out of the way of a much faster car: briskly)
    const quick = me.speed < 8 ? 4 : fastC >= 0 && p.fastCarRule === 'yield' ? p.fastLaneRate : 1;
    const up = quick * p.laneRateApply * dt;
    const down = quick * p.laneRateRelax * dt;
    // A limit never lags behind the car itself: a new constraint on one
    // side holds the car where it IS at once ("do not move toward it") and
    // only the rest of the way is eased in.
    if (wantLo > this.lo) this.lo = Math.max(this.lo, Math.min(wantLo, me.lateral));
    if (wantHi < this.hi) this.hi = Math.min(this.hi, Math.max(wantHi, me.lateral));
    this.lo += clamp(wantLo - this.lo, -down, up);
    this.hi += clamp(wantHi - this.hi, -up, down);
    if (this.lo < -limit) this.lo = -limit;
    if (this.hi > limit) this.hi = limit;
    if (this.lo > this.hi) this.lo = this.hi = (this.lo + this.hi) / 2;
    return cap;
  }

  /**
   * Speed at which car `o`, `gap` metres ahead (bumper to bumper, may be
   * negative when it is alongside), can still be followed with `margin`
   * metres to spare — "lift rather than ram".
   *
   * The car ahead is about to do what the ROAD makes it do: it will brake
   * for the corner it is coming to. Its speed over the next second is read
   * off my own plan, scaled by how its pace compares with that plan right
   * now (never assumed slower than 3/4 of the plan: a car below it on a
   * straight still takes the corner at ITS speed) — so I am already slowing
   * when it starts to, instead of finding out from its bumper.
   */
  private approach(o: CarTracker, gap: number, margin: number, me: CarTracker, geo: TrackGeometry, line: RaceLine): number {
    const p = this.params;
    const react = p.reactionDelay + p.pedalTime;
    // The gap is a matter of speed (a headway): `margin` metres at 20 m/s,
    // three quarters of it nose to tail through a hairpin.
    const want = margin * clamp(me.speed / 20, 0.75, 1.15);
    // What it will be doing by the time my feet have answered: a car that
    // is braking goes on braking, and it brakes where the road makes it.
    const itsBraking = clamp(-o.accelAlong, 0, this.mug);
    const ratio = clamp(o.speedAlong / Math.max(line.speed[o.index], 1), 0.75, 1.2);
    const soon = geo.indexAhead(o.index, Math.max(1, p.followLead * o.speedAlong));
    const lead = Math.max(0, Math.min(o.speedAlong - itsBraking * react, ratio * line.speed[soon]));
    const closing = me.speedAlong - lead;
    const room = gap - want - Math.max(0, closing) * react;
    // While it brakes I only gain on it by what I can brake HARDER.
    const spare = Math.max(this.brakeAccel - itsBraking, 0.25 * this.brakeAccel);
    if (closing > 0) {
      const need = room > 0.5 ? (closing * closing) / (2 * room) : 2 * closing;
      this.trafficDecel = Math.max(this.trafficDecel, Math.min(need + 0.5 * itsBraking, this.mug));
    }
    this.apLead = lead;
    this.apRoom = room;
    // Its speed, plus a closing speed in proportion to the room there is
    // (never more than can still be braked off in it); too close: ease
    // back, not with a stab at the brake. A plain gain on the gap, because
    // anything steeper near zero makes the follower pump its pedals.
    const allowed = lead + (room > 0 ? Math.min(p.followGain * room, Math.sqrt(spare * room)) : Math.max(p.followGain * room, -2));
    // … but never below the slower of my own plan here and what the car
    // ahead is doing NOW less a small margin: anticipating its braking must
    // not turn into stopping behind a car that is still moving (on the old
    // loop the cars crawled at 0-3 m/s into corners with a car near). A car
    // standing in the way gives a floor of zero.
    const floor = Math.min(line.speed[me.index], o.speedAlong - p.followFloorMargin);
    return allowed > floor ? allowed : floor;
  }

  /** Side clearance for passing this car: round an obstacle (a car hardly
   * moving, or any car while squeezing past a blockage) `passClear`, beside
   * a car that races `passClearMoving`. */
  private clearFor(t: CarTracker, launching: boolean, line: RaceLine): number {
    const p = this.params;
    // (a car no rival drives — the player — gets the wider room too: it does
    // not race with racecraft, and the narrower value raised the contacts
    // with the careful stand-in in proxyEasy from 1.5-3.5 to 2.25-5.25 per
    // race)
    // (squeezing past a blockage: the tight clearance only round a car that
    // is itself standing — one that moves, the player's included, keeps
    // its normal room)
    if (this.desperate > 0 && t.speed < 1) return p.squeezeClear;
    return !t.driven || (!launching && t.speedAlong < 0.4 * line.speed[t.index]) ? p.passClear : p.passClearMoving;
  }

  /** An attack did not come off: back in line, and wait before the next. */
  private failedAttack(): void {
    if (this.passId !== this.failId) {
      this.failId = this.passId;
      this.fails = 0;
    }
    this.fails = Math.min(this.fails + 1, 2);
    this.passCooldown = this.params.attackPatience * (1 << (this.fails - 1));
    this.passId = null;
    this.passSide = 0;
    this.stats.passAborts++;
  }

  /** Seconds until car `o` (ahead of me) turns in for the next corner
   * (0 = it is doing so; Infinity = no corner in sight). */
  private timeToTurnIn(o: CarTracker, me: CarTracker): number {
    if (this.apexDist === Infinity) return Infinity;
    let ahead = o.s - me.s;
    if (ahead < 0) ahead += this.geo!.length;
    const run = this.apexDist - ahead - this.params.turnInDistance;
    return run <= 0 ? 0 : run / Math.max(o.speedAlong, 3);
  }

  /**
   * Is an attack on car `o` worth starting? It turns in for the next corner
   * about `turnInDistance` before the apex. By then I must have moved
   * `over` metres sideways, out of its tracks, with `attackLead` seconds to
   * spare for drawing up to its tail in clear air (the car ahead leaves the
   * door open for a car that shows its nose beside its tail — see the
   * ALONGSIDE rule in traffic()). A try that does not come off costs a few
   * tenths; after each one on the same car the driver waits longer before
   * the next (`attackPatience`).
   */
  private canReach(o: CarTracker, over: number, me: CarTracker): boolean {
    if (this.apexDist === Infinity) return true;
    const p = this.params;
    return this.timeToTurnIn(o, me) > Math.max(0, over) / p.laneRateSwerve + p.attackLead;
  }

  /**
   * Which side to pass a block occupying [a, b] on. `must` ≠ 0: only that
   * side will do (the inside of the corner that is coming) — 0 if there is
   * no room there. Otherwise: the side there is room, else the side we are
   * already on, else the inside of the next bend, else the roomier one.
   */
  private chooseSide(a: number, b: number, okR: boolean, okL: boolean, limit: number, me: CarTracker, must: number): number {
    if (must !== 0) return (must > 0 ? okR : okL) ? must : 0;
    if (!okR && !okL) return 0;
    if (okR !== okL) return okR ? 1 : -1;
    const off = me.lateral - (a + b) / 2;
    if (Math.abs(off) > 0.6) return off > 0 ? 1 : -1;
    if (this.cornerSide !== 0) return this.cornerSide;
    return limit - b >= a + limit ? 1 : -1;
  }

  // ------------------------------------------------------------ trouble

  /**
   * @param turn  true = the car points the wrong way (K-turn)
   * @param around  non-zero = back off a long way first (going round
   *                traffic that is known to block the road)
   */
  private startReverse(turn: boolean, around = 0): void {
    const window = this.time - this.revAttemptClock;
    // (attempts counted over 30 s: over 20 s a car wedged in a gap between
    // two wrecks in a bend, backing out every 7-8 s, never reached the 4th
    // attempt and stood there 25-45 s without asking — s.blockedBend)
    if (window > 30) this.revAttempts = 0;
    if (this.revAttempts === 0) this.revAttemptClock = this.time;
    this.revAttempts++;
    if (this.revAttempts > this.params.reverseAttempts) {
      this.ask('stuck');
      return;
    }
    this.mode = 'reverse';
    this.revPhase = 0;
    this.revTime = 0;
    this.revChoose = true;
    this.revMoved = 0;
    this.revTurn = turn;
    this.revSide = 0;
    // Stuck ON the road while pointing along it: there is something in the
    // way that the driver cannot see (a rock, a wreck). Go round it — first
    // on the side with more road, the other side on the next attempt.
    const me = this.me;
    const geo = this.geo;
    this.dodgeBlind = false;
    this.revFar = around !== 0;
    if (around !== 0) {
      // Known traffic: back off a long way, straight; the lane logic then
      // has the room to take the car round (see traffic()).
      this.dodgeSide = 0;
    } else if (!turn && me && geo && Math.abs(me.lateral) < geo.halfWidth + 1) {
      // Same thing as last time (stuck again within a few metres)? Then the
      // side tried was wrong: take the other. A new obstacle: the side with
      // more road.
      const again = this.dodgeSide !== 0 && this.time - this.dodgeAt < 20 && Math.abs(geo.arcDelta(this.dodgeS, me.s)) < 10;
      if (again) {
        this.dodgeSide = -this.dodgeSide;
        this.desperate = 8;
      } else {
        this.dodgeSide = me.lateral > 0 ? -1 : 1;
        this.dodgeLat = me.lateral;
        this.dodgeS = me.s;
      }
      this.dodgeAt = this.time;
      this.dodgeBlind = true;
    } else {
      this.dodgeSide = 0;
    }
    this.slowTime = 0;
    this.pushTime = 0;
    this.wrongWayTime = 0;
    this.speedIntegral = 0;
    this.dCount = 0;
    if (turn) this.stats.turnarounds++;
    else this.stats.reverses++;
  }

  /**
   * Back out. Phase 0: feet off until the car stands (a brake press that
   * starts at standstill is what selects reverse). Phase 1: reverse with the
   * stick turned so the nose swings toward the road direction.
   */
  private reverse(dt: number, v: Vehicle, me: CarTracker, geo: TrackGeometry, cars: readonly CarTracker[]): void {
    const p = this.params;
    this.revTime += dt;
    // Where should the nose end up: along the track, leaning toward the
    // road when off to one side.
    const toRoad = clamp(-me.lateral / Math.max(geo.halfWidth, 1), -1, 1) * 0.6;
    let turn = toRoad - me.headingError;
    if (turn > Math.PI) turn -= 2 * Math.PI;
    else if (turn < -Math.PI) turn += 2 * Math.PI;
    // Pointing (almost) exactly backward the two ways round are equally
    // long, and which one the sign of ±180° picks is numerical noise — it
    // differed between frame rates (lab s.wrongWay: 5.8 s at 30 / 60 Hz,
    // 10.3 s at 120 Hz, the other way round ending off the road). Decide
    // it from the road instead (off-centre: by the side the car is on;
    // centred: by the way the road bends ahead — the way round that turned
    // every car in one go on seeds 1-59, 5.4-5.9 s at 30-120 Hz; the other
    // one put the long cars on the bank, 10 s and a rescue).
    // (chosen on the FIRST step of each phase — by a flag, not a time
    // window: a "revTime < 0.05" window is never open at a 1/20 s step)
    if (Math.abs(turn) > 2.6 && this.revChoose && this.revTurn) {
      const k = geo.curvature[geo.indexAhead(me.index, 6)];
      this.revSide = Math.abs(me.lateral) > 0.5 ? (me.lateral > 0 ? 1 : -1) : k >= 0 ? -1 : 1;
    }
    this.revChoose = false;
    if (this.revTurn && this.revSide !== 0 && Math.abs(turn) > 2.6) turn = this.revSide * Math.abs(turn);
    // Going round something: swing the nose to the chosen side instead.
    if (this.dodgeSide !== 0) turn = this.dodgeSide * 0.5 - me.headingError;
    // Backing off from traffic: straight back along the road.
    else if (this.revFar) turn = -me.headingError;
    // Reversing with the stick LEFT swings the nose RIGHT.
    const stick = -clamp(turn / 0.35, -1, 1);

    if (this.revPhase === 0) {
      const moving = me.speed > 0.8;
      this.direct(stick, 0, moving && me.vFwd > 0 ? 0.6 : 0, dt);
      if (!moving && this.hands.current.brake < 0.02 && this.revTime > 0.15) {
        this.revPhase = 1;
        this.revTime = 0;
        this.revChoose = true;
      } else if (this.revTime > 2.5) {
        this.endReverse();
      }
      return;
    }

    // Back up at a walking-plus pace, not flat out.
    const backSpeed = Math.max(0, -me.vFwd);
    this.direct(stick, 0, clamp(0.3 + 0.5 * (p.reverseSpeed - backSpeed), 0.05, 1), dt);
    if (me.vFwd < 0) this.revMoved += -me.vFwd * dt;
    if (this.revTime > 0.5 && !v.isReversing && me.speed < 0.3) {
      // The press was taken as a brake (the car was still rolling): again.
      this.revPhase = 0;
      this.revTime = 0;
      return;
    }
    // Something behind? Do not back into it.
    let blockedBehind = this.revTime > 1 && me.speed < 0.25;
    for (let c = 0; c < cars.length && !blockedBehind; c++) {
      const o = cars[c];
      if (o === me || !o.active) continue;
      const dx = o.x - me.x;
      const dz = o.z - me.z;
      const back = -(dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw));
      const side = Math.abs(dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw));
      if (back > 0 && back < me.halfLength + o.halfLength + 1 && side < me.halfWidth + o.halfLength) blockedBehind = true;
    }
    const aligned = Math.abs(turn) < 0.9;
    const need = this.revFar ? 3 * p.reverseDistance : this.dodgeSide !== 0 ? 1.6 * p.reverseDistance : p.reverseDistance;
    const done = this.revTurn
      ? (aligned && this.revMoved > 1) || this.revMoved > 9 || this.revTime > 4
      : this.revMoved >= need || this.revTime > (this.revFar ? 6 : 3.5);
    // Backing out at an angle carries the car across the road: stop at the
    // `maxLateral` line (s.obstacle: a car backing out round an unseen block
    // at 30 deg put its outer wheels 7.6 m out — past the game's fences).
    // (only from inside it: a car that starts the reverse further out, off
    // the road, is not held there)
    const outer = Math.abs(me.lateral) + me.halfWidth;
    // (stopped 1 m inside it: the stop and the forward swing that follows
    // carry the car another 0.5-0.8 m out)
    const atEdge = outer > this.params.maxLateral - 1 && outer < this.params.maxLateral + 1 && me.lateral * me.lateralSpeed > 0;
    if (done || blockedBehind || atEdge) this.endReverse();
  }

  private endReverse(): void {
    this.mode = 'race';
    this.graceUntil = this.time + 1.2;
    this.dodgeUntil = this.dodgeSide !== 0 && this.dodgeBlind ? this.time + 6 : 0;
    // The lane limits apply at once (no easing in at walking pace).
    this.laneReady = false;
    // Feet: off the brake (it means reverse while rolling back), on the gas.
    this.noBrakeUntil = this.time + 1.5;
    this.slowTime = 0;
    this.pushTime = 0;
    this.wrongWayTime = 0;
    this.speedIntegral = 0;
    this.dCount = 0;
    this.outSteer = 0;
    this.outThr = 0;
    this.outBrk = 0;
  }

  private checkRescue(dt: number, me: CarTracker, geo: TrackGeometry): void {
    const p = this.params;
    this.flipTime = me.upY < 0.3 ? this.flipTime + dt : 0;
    if ((this.flipTime > 1.2 && me.speed < 2) || this.flipTime > 3) {
      this.ask('flipped');
      return;
    }
    const far = me.distance > geo.halfWidth + p.lostDistance || me.y < geo.height[me.index] - 25 || !Number.isFinite(me.x + me.y + me.z);
    this.lostTime = far ? this.lostTime + dt : 0;
    if (this.lostTime > 0.5) {
      this.ask('lost');
      return;
    }
    if (this.time < this.graceUntil) return;
    if (me.progress - this.watchProgress > 4) {
      this.watchProgress = me.progress;
      this.watchTime = 0;
    } else {
      this.watchTime += dt;
      // (waiting behind traffic, backing off and feeling the way round a
      // blockage all take their time: that is not being stuck)
      const patient = this.blockedByTraffic || this.desperate > 0 || this.mode === 'reverse' || this.time < this.dodgeUntil;
      // (squeezing past a blockage — `desperate` — gets less: 2.5 x left a
      // car wedged between two wrecks in a bend standing for 25 s and asking
      // only 41-45 s after it got there, s.blockedBend)
      const wait = this.desperate > 0 ? 1.8 : patient ? 2.5 : 1;
      if (this.watchTime > wait * p.noProgressTime) this.ask('stuck');
    }
  }

  private ask(reason: RivalRescueReason): void {
    this.rescue = reason;
    this.mode = 'rescue';
  }

  // ----------------------------------------------------------- actuation

  /** Wanted wheel angle and pedals → reaction delay → stick → rate limits. */
  private act(v: Vehicle, steerAngle: number, lock: number, throttle: number, brake: number, dt: number): void {
    const delay = this.params.reactionDelay;
    const angle = clamp(steerAngle, -3 * lock, 3 * lock);
    if (delay > 0) {
      // push
      if (this.dCount === DELAY_CAP) {
        this.dHead = (this.dHead + 1) % DELAY_CAP;
        this.dCount--;
      }
      const tail = (this.dHead + this.dCount) % DELAY_CAP;
      this.dT[tail] = this.time;
      this.dSteer[tail] = angle;
      this.dThr[tail] = throttle;
      this.dBrk[tail] = brake;
      this.dCount++;
      // sample at (now − delay), linearly interpolated (rate independent)
      const at = this.time - delay;
      while (this.dCount > 1 && this.dT[(this.dHead + 1) % DELAY_CAP] <= at + 1e-9) {
        this.dHead = (this.dHead + 1) % DELAY_CAP;
        this.dCount--;
      }
      const a = this.dHead;
      if (this.dT[a] <= at + 1e-9) {
        const b = this.dCount > 1 ? (a + 1) % DELAY_CAP : a;
        const span = this.dT[b] - this.dT[a];
        const f = span > 0 ? clamp((at - this.dT[a]) / span, 0, 1) : 0;
        this.outSteer = this.dSteer[a] + (this.dSteer[b] - this.dSteer[a]) * f;
        this.outThr = this.dThr[a] + (this.dThr[b] - this.dThr[a]) * f;
        this.outBrk = this.dBrk[a] + (this.dBrk[b] - this.dBrk[a]) * f;
      }
    } else {
      this.outSteer = angle;
      this.outThr = throttle;
      this.outBrk = brake;
    }
    const act = this.acted;
    // The decision is late; the hands know the car (a model that maps the
    // stick differently in a slide says which stick gives the wanted angle).
    act.steering = clamp(v.stickForSteerAngle ? v.stickForSteerAngle(this.outSteer) : this.outSteer / lock, -1, 1);
    act.throttle = this.outThr;
    // The delayed brake must not hold the car at a standstill either.
    act.brake = this.me && this.me.speed < 0.6 ? 0 : this.outBrk;
    this.hands.apply(act, dt);
  }

  /** Commands that skip the reaction delay (grid, backing out, rescue). */
  private direct(stick: number, throttle: number, brake: number, dt: number): void {
    const act = this.acted;
    act.steering = stick;
    act.throttle = throttle;
    act.brake = brake;
    this.hands.apply(act, dt);
  }
}
