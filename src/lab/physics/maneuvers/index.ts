import type { ManeuverDef } from './common';
import { brake, launch, standstill } from './straight';
import { driftInitiate, driftSustain, slideRecovery } from './sliding';
import { brakeTurn, laneChange, rollover, skidpad, slalom, stepSteer } from './cornering';
import { hillLap, jump, rough } from './terrain';
import { frameRate } from './frameRate';
import { visual } from './visual';
import { carContact, obstacle, pedals, rateRobust, selfRight } from './robust';

/**
 * THE MANEUVER SUITE, in report order (?suite=all runs every one; a subset
 * is ?suite=launch,brake,...). Letters follow the original brief.
 *
 *   a launch         0 → top speed, hands off          straight.ts
 *   b brake          20 → 0, hands off                 straight.ts
 *   c skidpad        R 10/20/35 m, quasi-static sweep  cornering.ts
 *   d stepSteer      50/100 % stick at 10/15/20 m/s    cornering.ts
 *   e laneChange     double, 15 and 20 m/s             cornering.ts
 *   f slalom         18 m cones, rising speed          cornering.ts
 *   g driftInitiate  power-over, flick, brake-tap      sliding.ts
 *   h driftSustain   hold 25°, + open-loop window      sliding.ts
 *   i slideRecovery  imposed 20/35/50°, power slide    sliding.ts
 *   j jump           12/18/25° ramps                   terrain.ts
 *   k rough          washboard, kerb, boulder          terrain.ts
 *   l rollover       fishhook vs static threshold      cornering.ts
 *   m hillLap        2 laps, fast / aggressive driver  terrain.ts
 *   n frameRate      30/60/72/90/120 Hz spread         frameRate.ts
 *   o standstill     rest, creep, full lock, slope     straight.ts
 *   p brakeTurn      (extra) brake while cornering     cornering.ts
 *   q visual         hub poses handed to graphics      visual.ts
 *   r obstacle       one wheel on a dome / rock, half  robust.ts
 *                    ramps, sideways into a kerb
 *   s selfRight      on roof / side, rescue, respawn   robust.ts
 *   t carContact     against each of the four designs  robust.ts
 *   u pedals         panic stop vs hold-to-reverse     robust.ts
 *   v rateRobust     frame rate, no driver in the loop robust.ts
 *   w slideCatch     full opposite lock held on power; lift   drift.ts
 *   x driftHold      who can hold a drift, and where          drift.ts
 *   y powerOver      the per-car power-over trait; donut      drift.ts
 *   z assist         assistLevel 0.5 / 0                      drift.ts
 *     bumped         knocked sideways / onto a rock with the  skid.ts
 *                    stick centred and the trigger HELD
 *     lateCatch      lift, THEN opposite lock + full throttle skid.ts
 *     stuck          centre hit on a game-sized rock: drives  skid.ts
 *                    off it, or needsRescue fires
 *     driftLink      a held drift, then one the other way:    linking.ts
 *                    throttle, brake tap, brake tap after a
 *                    caught slide
 *     overHeldCatch  full opposite lock + floor never let go  linking.ts
 *                    of: no spin, no tank-slapper
 *   (r onward carry no scorecard weight: pass / fail checks only;
 *    'race' — the AI rivals — is appended below as well)
 *
 * HOW TO ADD A MANEUVER
 *  1. Write a `ManeuverDef` (common.ts). In `run(env)`, build one FRESH world
 *     per case with `runCase(env, id, worldSpec, async (sim) => {...})`:
 *       sim.place({ x, z, yaw, speed, beta, yawRate })   teleport (+ motion)
 *       sim.useScript([{ t, steering, throttle, brake }]) human-ramped inputs
 *       sim.useDriver(sim.makeDriver({...}))              closed-loop driver
 *       await sim.run(seconds, (tel) => stopEarly)        fixed-step advance
 *     Read `sim.tel` (pose, speed, beta, yaw rate, accelerations, wheels
 *     off) and `sim.track` (running maxima) and return plain numbers.
 *  2. Judge them: `report.check(id, value, 'target band text', pass)`.
 *  3. Add the def to MANEUVERS below.
 *  4. Give it a line in scorecard.ts (a maneuver without one is still run,
 *     listed and counted in the pass/fail checks, but does not move the
 *     weighted score).
 * Rules that keep results trustworthy: never share a Sim between cases,
 * never read the wall clock, never use Math.random, and derive every target
 * from `sim.mug` (declared mu × scene gravity) rather than from a constant.
 */
export const MANEUVERS: ManeuverDef[] = [
  launch,
  brake,
  skidpad,
  stepSteer,
  laneChange,
  slalom,
  driftInitiate,
  driftSustain,
  slideRecovery,
  jump,
  rough,
  rollover,
  hillLap,
  frameRate,
  standstill,
  brakeTurn,
  visual,
  obstacle,
  selfRight,
  carContact,
  pedals,
  rateRobust,
];
import { race } from './race'; MANEUVERS.push(race); // r race: AI rivals (race.ts) - appended here so the list above stays conflict-free
import { DRIFT_MANEUVERS } from './drift'; MANEUVERS.push(...DRIFT_MANEUVERS); // w-z drift feel (drift.ts) - appended like race, so the list above stays conflict-free
import { SKID_MANEUVERS } from './skid'; MANEUVERS.push(...SKID_MANEUVERS); // bumped / lateCatch / stuck: "a skid is always catchable" (skid.ts) - appended like race
import { LINK_MANEUVERS } from './linking'; MANEUVERS.push(...LINK_MANEUVERS); // driftLink / overHeldCatch: linked drifts vs an over-held catch (linking.ts) - appended like race
