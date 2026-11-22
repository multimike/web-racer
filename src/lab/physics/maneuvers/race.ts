import { MeshBuilder, PhysicsAggregate, PhysicsMotionType, PhysicsShapeType, Quaternion, Vector3 } from '@babylonjs/core';
import type { PhysicsEngineV2, TransformNode } from '@babylonjs/core';
import type { CarIntent, InputProvider } from '../../../input/types';
import type { Vehicle } from '../../../car/Vehicle';
import { createVehicle } from '../../../car/createVehicle';
import { DriverModel, PathPlan, planOptions } from '../../../car/DriverModel';
import type { DriverParams } from '../../../car/DriverModel';
import { RivalDriver } from '../../../car/ai/RivalDriver';
import type { RivalParams } from '../../../car/ai/RivalDriver';
import { RivalField } from '../../../car/ai/RivalField';
import type { CarTracker } from '../../../car/ai/CarTracker';
import { DIFFICULTY_PRESETS, RACE_CAR_IDS, buildField, gridPoses } from '../../../car/ai/grid';
import type { GridPose } from '../../../car/ai/grid';
import type { Track } from '../../../terrain/track';
import type { MetricValue } from '../types';
import { DEG, RAD, round } from '../sim';
import type { LabEnv, Sim } from '../sim';
import { buildWorld } from '../world';
import type { LabWorld } from '../world';
import { Report, mean } from './common';
import type { ManeuverDef } from './common';

/**
 * r. race — AI rivals (src/car/ai) racing each other and a "player proxy" on
 * the hills track, plus one scenario per behaviour the rival driver claims.
 *
 * The standard Sim holds ONE car, so this file brings its own small
 * multi-car stepper (RaceSim). It keeps the Sim's rules: a fresh world per
 * case, manual fixed steps in the game's order (drivers decide → every
 * vehicle.update(dt) → physics step), no wall clock in any result except the
 * `cpu.*` summary numbers, no Math.random.
 *
 * Cases
 *   race.s<seed>       four rivals, the four car designs, skill 0.3 / 0.5 /
 *                      0.7 / 0.9 with the SLOWEST on pole and the quickest
 *                      last, 3 laps. Finished cars keep circulating slowly
 *                      (moving traffic for the others). Judged on finishing,
 *                      rescues, pile-ups, contacts, excursions — and on
 *                      whether skill or the grid decides (pole-sitter wins,
 *                      best lap in traffic by skill).
 *   proxy.s<seed>      the suite's car (?car=) driven by the plain careful
 *                      DriverModel (centreline, no racecraft, starts last)
 *                      against three rivals of the other designs, rubber
 *                      band on. `proxyNoBand` = same, band off.
 *   proxyEasy / proxyQuick / proxyHard / proxyQuickEasy / proxyQuickHard
 *                      the careful (CAREFUL) and the quick (QUICK) stand-in
 *                      against the game's three difficulty settings
 *                      (DIFFICULTY_PRESETS easy / normal / hard, each with
 *                      its own rubber band; PROXY_TIERS): where the rubber
 *                      band and the difficulty settings are judged.
 *                      Stand-ins launch in their grid lane and lift for a
 *                      car straight ahead while launching (launchEyes).
 *   solo.k30/60/90     one rival alone in the suite's car: lap time by skill.
 *   duel.k<a>k<b>.*    a quicker rival behind a slower one, same car: does it
 *                      get by, how long does it take, how clean is it; and
 *                      two EQUAL rivals nose to tail (no squabbling).
 *   knock.*            one rival thrown off its line at speed: gathers the
 *                      car up without weaving or leaving the road.
 *   s.*                scenarios: parked car on the line, slower car ahead,
 *                      side by side, two wrecks with a gap on the start
 *                      straight (blockedRoad), the same two in the first
 *                      bend (blockedBend: through or ask for a rescue), the
 *                      road shut by three (blockedShut: ask), something
 *                      solid on the road, started off the road, started
 *                      facing backward (also at 30 and 120 Hz:
 *                      race.wrongWayRates), started on its roof.
 *   s.fastBehind.*     a much faster car (lab driver holding the centreline
 *                      or 1.5 m to either side, ignores the rival; also the
 *                      quick stand-in) closing at 8-10 m/s from 30 m
 *                      behind the rival (on its own line), met on the start
 *                      straight and at the turn-in of the tightest bend, 14
 *                      runs; plus two FOLLOWERS (close from 30 m, then only
 *                      follow) the rival must let go of (s.fastBehind.follow).
 *
 *   Race gates added on the 590 m track (2026-11): race.noCrawl
 *   (no crawling on the line with nothing standing in the way),
 *   race.paceInTraffic (skill shows as best lap and place in the race),
 *   proxyEasy / proxyQuick .contacts and .impact.
 *
 * URL parameters read here (so the lab page needs no change):
 *   &raceSeeds=N    terrain seeds for race / proxy / solo / duel (default 8:
 *                   seed, seed+1, …; duels use the first 6; every stand-in
 *                   pair runs on all of them, noBand only for proxy)
 *   &raceHz=30,60,90  ALSO run the four-rival race at these frame rates
 *                   (default: only the suite's dt)
 *   &raceLaps=N     laps (default 3)
 *   &raceFocus=id   watch mode: car the camera follows
 *   &rival=k:v,...  RivalParams overrides for every rival (racecraft tuning;
 *                   fastCarRule takes hold / yield / off)
 *   &raceLaunch=swerve  the stand-ins aim for the centreline at once from
 *                   their grid slot (the old launch); =lane: they hold
 *                   their grid lane (3 s, or until a corner is within 45 m,
 *                   then a 1.5 s blend) and do NOT look ahead — the brief's
 *                   stand-in; default (=eyes): the same lane hold plus the
 *                   launch eyes (RaceSim.launchEyes, first LAUNCH_EYES s)
 *   &raceBand=0.08  rubber band strength of the proxy races (default 0.04;
 *                   the field clamps it to 0.08)
 *   &raceHalfWidth=5  tell the drivers the road is that wide (experiment)
 *   &raceOnly=race,proxy,solo,duel,knock,s  &raceScenario=name
 *   &preset=easy:d:s:b,...  difficulty / spread / rubber band of a setting
 *                   for this run (tuning DIFFICULTY_PRESETS)
 *   &raceTiers=proxyEasy,proxyQuick  only these stand-in pairs (the
 *                   difficulty.* gates then do not run)
 *   &raceTrace=<case id>   development: run a subset / keep a 10 Hz trace
 */

const LAPS_DEFAULT = 3;
/** Speed below which a car counts as standing, m/s. */
const SLOW = 0.7;
/** race.noCrawl: below this a racing rival is crawling, m/s … */
const CRAWL = 4;
/** … and it counts as racing once it has gone faster than this. */
const CRAWL_RACING = 8;
/** A duel is given this many laps of the slower car. */
const DUEL_LAPS = 4;
/** Steps of per-car history kept (0.5 s at up to 250 Hz). */
const HIST = 128;
/** A stand-in is OUT OF CONTROL in the 0.5 s before a contact when it slides
 * more than this … */
const WILD_SLIP = 20 * RAD;
/** … or yaws faster than SPIN_RATE x what its grip can turn its velocity
 * (mu·g / v): rotating faster than the tires can carry the car round. */
const SPIN_RATE = 1.3;
/** Outer wheels of a rival's PLANNED path at most this far from the
 * centreline, m: the game's fences stand at 7.3 m (race.maxLateral). */
const MAX_PLAN_LATERAL = 6.3;
/** The game's fences, m from the centreline (race.maxLateral, driven). */
const FENCE_LATERAL = 7.3;
/** Stand-in launch: seconds after lights out its eyes stay on (lane hold 3 s
 * + blend 1.5 s), and the first LAUNCH_SPAN s whose contacts are reported
 * apart as launch contacts (info: they are still in the gated counts). */
const LAUNCH_EYES = 4.5;
const LAUNCH_SPAN = 3;
/** The opening of a stand-in race: the first OPENING_SPAN s after lights
 * out, long enough to contain the first corner and the end of the eyes
 * (counted over 3 s the launch read "0 contacts" while the contacts had
 * only moved to 4.5-6 s). Reported apart, info only. */
const OPENING_SPAN = 6;
/** s.blockedBend / s.blockedShut: a rescue must be asked for within this
 * many seconds of lights out when the rival does not get through, s. */
const BLOCKED_ASK = 40;

/** Is there a corner within `ahead` m of plan point `from`: the plan's speed
 * drops below 0.85 x its speed at `from`? */
function cornerWithin(plan: PathPlan, from: number, ahead: number): boolean {
  const v0 = plan.speed[from];
  let i = from;
  for (let d = 0; d < ahead && d < plan.length; ) {
    const j = i + 1 >= plan.count ? (plan.closed ? 0 : i) : i + 1;
    if (j === i) break;
    d += Math.hypot(plan.points[2 * j] - plan.points[2 * i], plan.points[2 * j + 1] - plan.points[2 * i + 1]);
    i = j;
    if (plan.speed[i] < 0.85 * v0) return true;
  }
  return false;
}

const CAREFUL: Partial<DriverParams> = {
  // The hill-lap 'fast' style: leaves margin everywhere, half throttle.
  cornerGrip: 0.5, brakeGrip: 0.4, accelGrip: 0.4, maxThrottle: 0.5, speedKp: 0.15, speedKi: 0.1, reactionDelay: 0.15,
};

/** A tidier stand-in: a player who has learned the track (still no
 * racecraft: it follows the middle of the road and ignores the others). */
const QUICK: Partial<DriverParams> = {
  cornerGrip: 0.7, brakeGrip: 0.55, accelGrip: 0.6, maxThrottle: 0.85, reactionDelay: 0.15,
};

/** The much faster car of s.fastBehind: the quick stand-in with a quicker
 * eye (0.1 s instead of 0.15), so that at 20-25 m/s it holds the line it is
 * given (the centreline or 1.5 m to either side) more closely: the quick
 * stand-in itself swings up to 1.6 m off it there (a longer look ahead cuts
 * the bends more). How far off it got is reported as `closerMaxOffLine`. */
const FAST_CLOSER: Partial<DriverParams> = { ...QUICK, reactionDelay: 0.1 };

interface ProxyTier {
  /** Case id prefix. */
  tag: string;
  title: string;
  driver: Partial<DriverParams>;
  /** The game's difficulty setting the three rivals are built with
   * (DIFFICULTY_PRESETS: buildField difficulty / spread, rubber band). */
  preset: keyof typeof DIFFICULTY_PRESETS;
}

/** Who the rubber band and the difficulty settings are judged against: the
 * two stand-ins against the three settings of the game. */
const PROXY_TIERS: ProxyTier[] = [
  { tag: 'proxy', title: 'careful player, normal field', driver: CAREFUL, preset: 'normal' },
  { tag: 'proxyEasy', title: 'careful player, easy field', driver: CAREFUL, preset: 'easy' },
  { tag: 'proxyQuick', title: 'quick player, normal field', driver: QUICK, preset: 'normal' },
  { tag: 'proxyHard', title: 'careful player, hard field', driver: CAREFUL, preset: 'hard' },
  { tag: 'proxyQuickEasy', title: 'quick player, easy field', driver: QUICK, preset: 'easy' },
  { tag: 'proxyQuickHard', title: 'quick player, hard field', driver: QUICK, preset: 'hard' },
];

function urlNumber(name: string, fallback: number): number {
  const text = typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null;
  const value = text === null ? NaN : Number(text);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function urlList(name: string): number[] {
  const text = typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null;
  if (!text) return [];
  return text.split(',').map(Number).filter((v) => Number.isFinite(v) && v > 0);
}

function urlText(name: string): string | null {
  return typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null;
}

/** &raceLaunch=swerve|lane|eyes — how the stand-ins launch (header). */
function launchMode(): 'swerve' | 'lane' | 'eyes' {
  const v = urlText('raceLaunch');
  return v === 'swerve' || v === 'lane' ? v : 'eyes';
}

/** &rival=key:value,... — RivalParams overrides for EVERY rival (tuning the
 * racecraft from the URL, like &tune= for the car and &driver= for the lab
 * driver). */
function rivalOverrides(): Partial<RivalParams> {
  const out: Record<string, number | string> = {};
  for (const pair of (urlText('rival') ?? '').split(',')) {
    const [key, value] = pair.split(':');
    // (the one text-valued key: &rival=fastCarRule:hold|yield|off)
    if (key === 'fastCarRule' && (value === 'hold' || value === 'yield' || value === 'off')) out[key] = value;
    else if (key && Number.isFinite(Number(value))) out[key] = Number(value);
  }
  return out as Partial<RivalParams>;
}

/** &preset=easy:0.3:0.15:0.06,hard:0.8:0.1:0.08 — difficulty / spread /
 * rubber band of a setting for this run (tuning DIFFICULTY_PRESETS). */
function presetOf(name: keyof typeof DIFFICULTY_PRESETS): { difficulty: number; spread: number; rubberBand: number } {
  for (const part of (urlText('preset') ?? '').split(',')) {
    const [key, d, sp, b] = part.split(':');
    if (key === name && [d, sp, b].every((v) => Number.isFinite(Number(v)))) return { difficulty: Number(d), spread: Number(sp), rubberBand: Number(b) };
  }
  return DIFFICULTY_PRESETS[name];
}

class PlainInput implements InputProvider {
  readonly name = 'lab-race';
  readonly intent: CarIntent = { throttle: 0, steering: 0, brake: 0 };
  isActive(): boolean {
    return true;
  }
  poll(): CarIntent {
    return this.intent;
  }
}

type CarKind = 'rival' | 'proxy' | 'parked';

interface CarSetup {
  id: string;
  carId: string;
  kind: CarKind;
  skill?: number;
  seed?: number;
  params?: Partial<RivalParams>;
  /** proxy only: DriverModel style. */
  driver?: Partial<DriverParams>;
  /** proxy only: drive a line this far right of the centreline, m (0 = the
   * centreline). */
  pathOffset?: number;
  /** rival only: starts from a grid slot (gridPoses) — keeps the default
   * RivalParams.launchHold (0 = off; `&rival=launchHold:3`
   * turns the lane hold on for grid starts only). Any other start (the scenarios, the
   * duels, knock) is not a grid: launchHold 0 (the hold shifted s.slowCar's timing so that the slow car, its
   * hold over, turned in on the passing car on two seeds). */
  grid?: boolean;
  /** proxy only: launch like a player — hold the grid slot's lane for the
   * first 3 s (or until a corner is within 45 m), then blend onto the path
   * over 1.5 s (DriverModel.launchInLane); lift for a car straight ahead
   * during the launch (RaceSim.launchEyes). */
  launchInLane?: boolean;
  /** proxy only, with launchInLane: also the launch eyes (default true;
   * &raceLaunch=lane turns them off). */
  launchEyes?: boolean;
}

interface RaceCar {
  id: string;
  carId: string;
  kind: CarKind;
  skill: number | null;
  vehicle: Vehicle;
  tracker: CarTracker;
  driver: RivalDriver | null;
  proxy: DriverModel | null;
  /** The path the proxy follows. */
  plan: PathPlan | null;
  input: PlainInput | null;
  restHeight: number;
  // --- results
  lapTimes: number[];
  lapStart: number;
  finished: boolean;
  finishTime: number | null;
  rescues: number;
  rescueReasons: string[];
  forcedRescues: number;
  lastRescueAt: number;
  slowTime: number;
  slowRun: number;
  maxSlowRun: number;
  offRoadTime: number;
  /** Time with the car's SIDE beyond the road edge, and how far at most. */
  sideOffTime: number;
  maxOverEdge: number;
  /** How far the car's CENTRE was beyond the road edge at most, m. */
  maxCentreOff: number;
  raceTime: number;
  distance: number;
  maxSpeed: number;
  maxTilt: number;
  contactUntil: number;
  maxContactLift: number;
  maxContactTilt: number;
  minGripTrust: number;
  /** proxy only */
  tiltTime: number;
  /** Racing (rivals): reached CRAWL_RACING since the start / the last
   * respawn; seconds below CRAWL while racing; the longest standstill that
   * was NOT behind a standing car. */
  racing: boolean;
  crawlTime: number;
  freeStandRun: number;
  maxFreeStand: number;
  launchInLane: boolean;
  launchEyes: boolean;
  /** race.maxLateral: the car has had all four wheels on the road. */
  seenOnRoad: boolean;
  /** Ring of the last HIST steps (race clock, |slip|, |yaw rate| over the
   * spin rate, sideways speed across the road): who was out of control and
   * who moved toward whom before a contact. */
  histT: Float64Array;
  histBeta: Float64Array;
  histSpin: Float64Array;
  histLat: Float64Array;
  histHead: number;
}

interface PairState {
  a: number;
  b: number;
  touching: boolean;
  lastTouch: number;
  /** −1: a behind b, +1: a ahead, 0: undecided. */
  order: number;
  cleanCross: boolean;
}

/** The closed polyline [x0, z0, x1, z1, ...] moved `offset` m to the right
 * of travel (0 = the same points). */
function offsetLine(points: ArrayLike<number>, offset: number): ArrayLike<number> {
  if (offset === 0) return points;
  const n = points.length / 2;
  const out = new Float32Array(points.length);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const tx = points[2 * b] - points[2 * a];
    const tz = points[2 * b + 1] - points[2 * a + 1];
    const len = Math.hypot(tx, tz) || 1;
    // right of travel = (tz, -tx) / len (as trackPose)
    out[2 * i] = points[2 * i] + (offset * tz) / len;
    out[2 * i + 1] = points[2 * i + 1] - (offset * tx) / len;
  }
  return out;
}

/** Oriented-rectangle overlap test (separating axes), footprints grown by `grow`. */
function footprintsOverlap(a: CarTracker, b: CarTracker, grow: number): boolean {
  const ax = Math.sin(a.yaw), az = Math.cos(a.yaw);
  const bx = Math.sin(b.yaw), bz = Math.cos(b.yaw);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const al = a.halfLength + grow, aw = a.halfWidth + grow;
  const bl = b.halfLength + grow, bw = b.halfWidth + grow;
  // axes: a forward, a right, b forward, b right
  const axes = [ax, az, az, -ax, bx, bz, bz, -bx];
  for (let k = 0; k < 4; k++) {
    const ux = axes[k * 2];
    const uz = axes[k * 2 + 1];
    const ra = al * Math.abs(ax * ux + az * uz) + aw * Math.abs(az * ux - ax * uz);
    const rb = bl * Math.abs(bx * ux + bz * uz) + bw * Math.abs(bz * ux - bx * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}

/** Shortest distance between two cars' footprints, m (0 = touching; to
 * 1 cm, up to 6 m): beside or behind, whichever way they stand. */
function clearance(a: CarTracker, b: CarTracker): number {
  if (footprintsOverlap(a, b, 0)) return 0;
  if (!footprintsOverlap(a, b, 3)) return 6;
  let lo = 0;
  let hi = 3;
  for (let k = 0; k < 9; k++) {
    const mid = 0.5 * (lo + hi);
    if (footprintsOverlap(a, b, mid)) hi = mid;
    else lo = mid;
  }
  return lo + hi;
}

interface RaceOptions {
  laps: number;
  rubberBand: number;
  /** Finished rivals keep circulating at cooldown pace. */
  cooldown: boolean;
}

/** Several cars in one fresh physics world, advanced by manual fixed steps. */
class RaceSim {
  readonly env: LabEnv;
  readonly world: LabWorld;
  readonly track: Track;
  readonly field: RivalField;
  readonly cars: RaceCar[] = [];
  readonly dt: number;
  readonly options: RaceOptions;
  time = 0;
  /** Race clock (0 at lights out). */
  raceClock = 0;
  started = false;
  steps = 0;
  // --- whole-race results
  contacts = 0;
  rearEnds = 0;
  maxRearImpact = 0;
  contactTime = 0;
  maxImpactSpeed = 0;
  /** The hardest contact with / without an out-of-control car in it. */
  maxImpactWild = 0;
  maxImpactTame = 0;
  /** Contacts the player stand-in was in, and of those the ones where it was
   * itself out of control in the 0.5 s before (WILD_SLIP / SPIN_RATE); the
   * hardest contact of the race with the stand-in in control / out of it. */
  proxyContacts = 0;
  proxyWildContacts = 0;
  maxImpactInControl = 0;
  maxImpactProxyWild = 0;
  /** Stand-in contacts (in control) where the RIVAL moved toward the other
   * car faster than the stand-in did (mean over the 0.3 s before, > 0.3 m/s). */
  rivalAtFault = 0;
  /** Stand-in contacts in the first LAUNCH_SPAN s (info; still counted in
   * the gated figures) and after the stand-in had finished (its race is
   * over: NOT counted in the in-control figures — a stand-in that has taken
   * the flag at 24 m/s into the winner cooling down at 8 m/s is no rival's
   * doing); seconds the launching stand-in lifted for a car ahead. */
  proxyLaunchContacts = 0;
  proxyOpeningContacts = 0;
  maxImpactOpening = 0;
  rivalOpeningContacts = 0;
  proxyAfterFlag = 0;
  maxImpactAfterFlag = 0;
  launchLiftTime = 0;
  /** Contacts between two rivals. */
  rivalContacts = 0;
  /** race.maxLateral: furthest a rival's planned path put its outer wheels
   * from the centreline, and where its outer wheels really went, m. */
  maxPlanLateral = 0;
  maxOuterLateral = 0;
  maxOuterAny = 0;
  overtakes = 0;
  pileRun = 0;
  maxPileUp = 0;
  thinkMs = 0;
  thinkCalls = 0;
  stepMs = 0;
  /** Wall time of RivalField.addRival (racing line + speed plan), ms. */
  setupMs = 0;
  setups = 0;
  readonly log: string[] = [];
  /** 10 Hz debug trace of every car (only with &raceTrace=<case id prefix>). */
  trace: string[] | null = null;
  private traceNext = 0;

  private pe: PhysicsEngineV2;
  private dynamicNodes: TransformNode[] = [];
  private pairs: PairState[] = [];
  private frameDebt = 0;
  private focus: RaceCar | null = null;
  private facade: Record<string, unknown> | null = null;

  constructor(env: LabEnv, seed: number, dt: number, options: Partial<RaceOptions> = {}) {
    this.env = env;
    this.dt = dt;
    this.options = { laps: LAPS_DEFAULT, rubberBand: 0, cooldown: true, ...options };
    this.world = buildWorld(env.engine, env.havok, { kind: 'hills', seed }, env.watch);
    const scene = this.world.scene;
    scene.physicsEnabled = false;
    this.pe = scene.getPhysicsEngine() as PhysicsEngineV2;
    this.track = this.world.track!;
    // Experiment: tell the drivers the road is wider than it was carved
    // (the terrain is NOT rebuilt: the extra width is the carved shoulder).
    const widen = urlNumber('raceHalfWidth', 0);
    if (widen > 0) this.track.halfWidth = widen;
    this.field = new RivalField(this.track, { rubberBand: this.options.rubberBand });
  }

  /** Create a car on the ground at a pose (not yet racing). */
  addCar(setup: CarSetup, pose: { x: number; z: number; yaw: number }): RaceCar {
    const scene = this.world.scene;
    const env = this.env;
    let driver: RivalDriver | null = null;
    let input: PlainInput | null = null;
    if (setup.kind === 'rival') {
      driver = new RivalDriver({
        skill: setup.skill ?? 0.6, seed: setup.seed ?? 1, params: { ...(setup.grid ? {} : { launchHold: 0 }), ...setup.params, ...rivalOverrides() }, gravity: this.world.gravity,
      });
    } else {
      input = new PlainInput();
    }
    const vehicle = createVehicle(scene, driver ?? input!, {
      model: env.model, carId: setup.carId, handling: env.handling, tune: env.tune,
    });
    vehicle.reset(new Vector3(pose.x, this.world.groundHeight(pose.x, pose.z), pose.z), pose.yaw);
    vehicle.chassisMesh.computeWorldMatrix(true);
    const t0 = performance.now();
    const tracker = driver
      ? this.field.addRival(setup.id, vehicle, driver)
      : this.field.addCar(setup.id, vehicle, setup.kind === 'proxy');
    if (driver) {
      this.setupMs += performance.now() - t0;
      this.setups++;
    }
    let proxy: DriverModel | null = null;
    let plan: PathPlan | null = null;
    if (setup.kind === 'proxy') {
      proxy = new DriverModel(
        {
          wheelbase: vehicle.wheelbase,
          maxSteerAngle: vehicle.maxSteerAngle,
          grip: vehicle.nominalGrip,
          gravity: this.world.gravity,
          topSpeed: vehicle.topSpeed,
          stickForSteerAngle: vehicle.stickForSteerAngle ? (angle) => vehicle.stickForSteerAngle!(angle) : undefined,
        },
        { ...vehicle.driverHints, ...(setup.driver ?? CAREFUL), ...env.driverTune },
      );
      plan = new PathPlan(offsetLine(this.track.points, setup.pathOffset ?? 0), planOptions(proxy.car, proxy.params, true));
    }
    const car: RaceCar = {
      id: setup.id, carId: setup.carId, kind: setup.kind, skill: setup.skill ?? null,
      vehicle, tracker, driver, proxy, plan, input, restHeight: 0,
      lapTimes: [], lapStart: 0, finished: false, finishTime: null,
      rescues: 0, rescueReasons: [], forcedRescues: 0, lastRescueAt: -1e9,
      slowTime: 0, slowRun: 0, maxSlowRun: 0, offRoadTime: 0, sideOffTime: 0, maxOverEdge: 0, maxCentreOff: 0, raceTime: 0, distance: 0, maxSpeed: 0, maxTilt: 0,
      contactUntil: -1, maxContactLift: 0, maxContactTilt: 0, minGripTrust: 1, tiltTime: 0,
      racing: false, crawlTime: 0, freeStandRun: 0, maxFreeStand: 0,
      launchInLane: setup.launchInLane === true, launchEyes: setup.launchInLane === true && setup.launchEyes !== false, seenOnRoad: false,
      histT: new Float64Array(HIST).fill(-1e9), histBeta: new Float64Array(HIST), histSpin: new Float64Array(HIST), histLat: new Float64Array(HIST), histHead: 0,
    };
    this.cars.push(car);
    return car;
  }

  /** Call once after the last addCar. */
  ready(): void {
    const scene = this.world.scene;
    this.dynamicNodes = [];
    for (const node of scene.transformNodes.concat(scene.meshes)) {
      if (node.physicsBody && node.physicsBody.getMotionType() === PhysicsMotionType.DYNAMIC) this.dynamicNodes.push(node);
    }
    this.pairs = [];
    for (let a = 0; a < this.cars.length; a++) {
      for (let b = a + 1; b < this.cars.length; b++) {
        this.pairs.push({ a, b, touching: false, lastTouch: -1e9, order: 0, cleanCross: false });
        this.pairs.push({ a: b, b: a, touching: false, lastTouch: -1e9, order: 0, cleanCross: false });
      }
    }
    if (this.env.watch && this.env.onSim) {
      const want = urlText('raceFocus');
      this.focus = this.cars.find((c) => c.id === want) ?? this.cars.find((c) => c.kind === 'proxy') ?? this.cars[this.cars.length - 1];
      // The page's watch hooks expect a single-car Sim: hand them a stand-in.
      this.facade = {
        world: this.world, vehicle: this.focus.vehicle, time: 0,
        tel: { speed: 0, beta: 0, steering: 0, throttle: 0, brake: 0 },
      };
      this.env.onSim(this.facade as unknown as Sim);
    }
  }

  /** Lights out. */
  start(): void {
    for (const car of this.cars) {
      car.restHeight = car.tracker.y - this.world.groundHeight(car.tracker.x, car.tracker.z);
      car.lapStart = this.time;
      if (car.proxy && car.plan) {
        car.proxy.prime(car.input!.intent);
        car.proxy.followPath(car.plan);
        // (3 s, not "or 15 m/s": the quick stand-in is at 15 m/s 0.8 s after
        // lights out, and leaving its lane then was the old swerve one second
        // later; a corner within 45 m ends the hold early — see step())
        if (car.launchInLane) car.proxy.launchInLane(car.tracker.lateral, 3, Infinity, 1.5);
      }
    }
    this.field.start();
    this.started = true;
    this.raceClock = 0;
    for (const p of this.pairs) p.order = this.relative(p) < 0 ? -1 : 1;
  }

  private relative(p: PairState): number {
    const a = this.cars[p.a].tracker;
    const b = this.cars[p.b].tracker;
    return this.field.geo.arcDelta(b.progress, a.progress);
  }

  /** Is a STANDING car (< 1 m/s) in this car's way: ahead within 12 m of
   * daylight, overlapping its lane? (a standstill behind one is waiting,
   * not crawling) */
  private standingAhead(car: RaceCar): boolean {
    const geo = this.field.geo;
    const t = car.tracker;
    for (const other of this.cars) {
      if (other === car) continue;
      const o = other.tracker;
      if (o.speed >= 1) continue;
      const ds = geo.arcDelta(t.s, o.s);
      if (ds <= 0 || ds > t.halfLength + o.halfLength + 12) continue;
      if (Math.abs(o.lateral - t.lateral) < t.halfWidth + o.halfWidth + 1) return true;
    }
    return false;
  }

  private syncMatrices(): void {
    for (const node of this.dynamicNodes) node.computeWorldMatrix(true);
  }

  private respawn(car: RaceCar): void {
    const pose = this.field.rescuePose(car.id);
    car.vehicle.reset(new Vector3(pose.x, this.world.groundHeight(pose.x, pose.z), pose.z), pose.yaw);
    car.vehicle.chassisMesh.computeWorldMatrix(true);
    this.field.respawned(car.id);
    car.lastRescueAt = this.time;
    car.slowRun = 0;
    car.tiltTime = 0;
    car.racing = false;
    car.freeStandRun = 0;
    if (car.proxy && car.plan) {
      car.input!.intent.throttle = 0;
      car.input!.intent.brake = 0;
      car.input!.intent.steering = 0;
      car.proxy.prime(car.input!.intent);
      car.proxy.followPath(car.plan);
    }
    for (const p of this.pairs) {
      if (this.cars[p.a] === car || this.cars[p.b] === car) {
        p.order = 0;
        p.cleanCross = false;
      }
    }
  }

  step(): void {
    const dt = this.dt;
    const scene = this.world.scene;
    this.syncMatrices();

    let t0 = performance.now();
    this.field.update(dt);
    this.thinkMs += performance.now() - t0;
    this.thinkCalls += this.field.rivals.length;

    for (const car of this.cars) {
      if (car.proxy && this.started) {
        const t = car.tracker;
        // A player launching in its lane turns onto the line for the first
        // corner: a corner within 45 m ends the lane hold.
        if (car.launchInLane && car.plan && car.proxy.holdingLaunchLane && car.proxy.lastPathIndex >= 0 && cornerWithin(car.plan, car.proxy.lastPathIndex, 45)) {
          car.proxy.endLaunchHold();
        }
        const intent = car.proxy.update({ x: t.x, z: t.z, yaw: t.yaw, vx: t.vx, vz: t.vz, yawRate: t.yawRate }, dt);
        car.input!.intent.throttle = intent.throttle;
        car.input!.intent.steering = intent.steering;
        car.input!.intent.brake = intent.brake;
        if (car.launchEyes && this.raceClock < LAUNCH_EYES) this.launchEyes(car);
      }
    }
    t0 = performance.now();
    for (const car of this.cars) car.vehicle.update(dt);
    scene.onBeforePhysicsObservable.notifyObservers(scene);
    this.pe._step(dt);
    scene.onAfterPhysicsObservable.notifyObservers(scene);
    this.stepMs += performance.now() - t0;

    this.time += dt;
    this.steps++;
    this.env.totals.steps++;
    this.env.totals.simSeconds += dt;
    this.syncMatrices();
    if (this.started) {
      this.raceClock += dt;
      this.measure(dt);
    }
  }

  private measure(dt: number): void {
    const geo = this.field.geo;
    const L = geo.length;
    const half = this.track.halfWidth;
    const laps = this.options.laps;
    // Trackers were refreshed at the START of this step; refresh them so the
    // measurements see the state after it (the next field.update does it
    // again — refreshing twice is harmless).
    for (const car of this.cars) car.tracker.refresh();

    let slowNear = 0;
    for (const car of this.cars) {
      const t = car.tracker;
      const h = car.histHead = (car.histHead + 1) % HIST;
      car.histT[h] = this.raceClock;
      car.histBeta[h] = t.speed > 3 ? Math.abs(t.beta) : 0;
      car.histSpin[h] = Math.abs(t.yawRate) / ((car.vehicle.nominalGrip * this.world.gravity) / Math.max(t.speed, 4));
      car.histLat[h] = t.lateralSpeed;
      if (car.driver && car.driver.mode === 'race' && this.raceClock > 0.5) {
        const plan = Math.abs(car.driver.lastTargetLateral) + t.halfWidth;
        if (plan > this.maxPlanLateral) this.maxPlanLateral = plan;
        // Driven: where its outer wheels really went — once the car has been
        // on the road (s.offRoad starts it 10 m out), while it points along
        // the road (within 30 deg: turning round, s.wrongWay, swings the car
        // across the road — 6.4-6.5 m at 30 Hz — and is no path), and not
        // within 2 s of a contact or a rescue (a car pushed sideways is not
        // following a plan); `maxOuterAny` = with all of those (info).
        const outer = Math.abs(t.lateral) + t.halfWidth;
        if (outer < this.track.halfWidth) car.seenOnRoad = true;
        if (car.seenOnRoad) {
          if (outer > this.maxOuterAny) this.maxOuterAny = outer;
          if (Math.abs(t.headingError) < 30 * RAD && this.time > car.contactUntil + 1 && this.time - car.lastRescueAt > 2 && outer > this.maxOuterLateral) this.maxOuterLateral = outer;
        }
      }
      const quat = car.vehicle.chassisMesh.rotationQuaternion;
      const tilt = quat ? Math.acos(Math.max(-1, Math.min(1, t.upY))) : 0;
      if (tilt > car.maxTilt) car.maxTilt = tilt;
      if (car.kind === 'parked') continue;
      if (t.speed > car.maxSpeed) car.maxSpeed = t.speed;
      if (car.driver && car.driver.gripTrust < car.minGripTrust) car.minGripTrust = car.driver.gripTrust;

      if (!car.finished) {
        car.raceTime += dt;
        car.distance += t.speed * dt;
        if (Math.abs(t.lateral) > half) car.offRoadTime += dt;
        const over = Math.abs(t.lateral) + t.halfWidth - half;
        if (over > 0) car.sideOffTime += dt;
        if (over > car.maxOverEdge && this.raceClock > 2) car.maxOverEdge = over;
        if (Math.abs(t.lateral) - half > car.maxCentreOff && this.raceClock > 2) car.maxCentreOff = Math.abs(t.lateral) - half;
        const slow = t.speed < SLOW && this.raceClock > 1.5;
        if (slow) {
          car.slowTime += dt;
          car.slowRun += dt;
          if (car.slowRun > car.maxSlowRun) car.maxSlowRun = car.slowRun;
        } else {
          car.slowRun = 0;
        }
        if (car.driver) {
          // Crawling on the racing line (race.noCrawl): only once the car is
          // RACING — the launch and the run-up after a respawn are not crawls.
          if (t.speed > CRAWL_RACING && this.time - car.lastRescueAt > 4) car.racing = true;
          if (car.racing && t.speed < CRAWL) car.crawlTime += dt;
          if (car.racing && t.speed < SLOW && !this.standingAhead(car)) {
            car.freeStandRun += dt;
            if (car.freeStandRun > car.maxFreeStand) car.maxFreeStand = car.freeStandRun;
          } else {
            car.freeStandRun = 0;
          }
        }
        while (t.progress >= (car.lapTimes.length + 1) * L) {
          car.lapTimes.push(this.time - car.lapStart);
          car.lapStart = this.time;
        }
        if (car.lapTimes.length >= laps) {
          car.finished = true;
          car.finishTime = this.raceClock;
          if (car.driver) {
            if (this.options.cooldown) car.driver.cooldown = true;
            else car.driver.hold();
          }
        }
      }
      // Standing on or beside the road with another standing car close by.
      if (t.speed < 1 && Math.abs(t.lateral) < half + 2 && this.raceClock > 3) {
        for (const other of this.cars) {
          if (other === car || other.kind === 'parked') continue;
          const o = other.tracker;
          if (o.speed < 1 && Math.hypot(o.x - t.x, o.z - t.z) < 9) {
            slowNear++;
            break;
          }
        }
      }
      if (this.time < car.contactUntil) {
        const lift = t.y - this.world.groundHeight(t.x, t.z) - car.restHeight;
        if (lift > car.maxContactLift) car.maxContactLift = lift;
        if (tilt > car.maxContactTilt) car.maxContactTilt = tilt;
      }

      // Rescue: the driver asks; the lab respawns at once.
      if (car.driver?.rescue) {
        car.rescues++;
        car.rescueReasons.push(`${car.driver.rescue}@${this.raceClock.toFixed(1)}`);
        if (this.log.length < 40) {
          this.log.push(`t=${this.raceClock.toFixed(1)} ${car.id} rescue '${car.driver.rescue}' at s=${t.s.toFixed(0)} lat=${t.lateral.toFixed(1)} up=${t.upY.toFixed(2)}`);
        }
        this.respawn(car);
      } else if (car.driver && car.slowRun > 25) {
        // Safety net: a rival that neither moves nor asks is PERMANENTLY stuck.
        car.forcedRescues++;
        if (this.log.length < 40) this.log.push(`t=${this.raceClock.toFixed(1)} ${car.id} FORCED rescue (mode ${car.driver.mode}) s=${t.s.toFixed(0)} lat=${t.lateral.toFixed(1)}`);
        this.respawn(car);
      } else if (car.proxy) {
        // The player stand-in gets what the game would give the player.
        car.tiltTime = tilt > 75 * RAD ? car.tiltTime + dt : 0;
        if (car.tiltTime > 1 || car.slowRun > 2.5 || t.distance > half + 25) {
          car.rescues++;
          car.rescueReasons.push(`${car.tiltTime > 1 ? 'flipped' : car.slowRun > 2.5 ? 'stuck' : 'lost'}@${this.raceClock.toFixed(1)}`);
          this.respawn(car);
        }
      }
    }
    if (this.trace && this.raceClock + 1e-9 >= this.traceNext) {
      this.traceNext += 0.1;
      let line = `t=${this.raceClock.toFixed(1)}`;
      for (const car of this.cars) {
        const t = car.tracker;
        const d = car.driver;
        const i = car.vehicle.visual;
        line += ` | ${car.id} s=${t.s.toFixed(1)} lat=${t.lateral.toFixed(2)} v=${t.speed.toFixed(1)} he=${(t.headingError * DEG).toFixed(0)} up=${t.upY.toFixed(2)}`;
        line += ` thr=${i.throttle.toFixed(2)} brk=${i.brake.toFixed(2)} st=${i.steerInput.toFixed(2)}`;
        if (d) {
          line += ` ${d.mode}${car.vehicle.isReversing ? '(R)' : ''} tgt=${d.lastTargetSpeed.toFixed(1)} cap=${Number.isFinite(d.lastTrafficCap) ? d.lastTrafficCap.toFixed(1) : '-'}`;
          line += ` want=${d.lastTargetLateral.toFixed(2)} pass=${d.passSide} trust=${d.gripTrust.toFixed(2)}`;
          line += ` edge=${d.lastEdge.toFixed(3)} apex=${d.apexSide}@${Number.isFinite(d.apexDist) ? d.apexDist.toFixed(0) : '-'} yl=${d.yielding ? 1 : 0}`;
        }
      }
      this.trace.push(line);
    }
    this.pileRun = slowNear >= 2 ? this.pileRun + dt : 0;
    if (this.pileRun > this.maxPileUp) this.maxPileUp = this.pileRun;

    // Car-to-car contact (footprints touching) and overtakes.
    for (const p of this.pairs) {
      const A = this.cars[p.a];
      const B = this.cars[p.b];
      const a = A.tracker;
      const b = B.tracker;
      if (p.a < p.b) {
        const touch = Math.hypot(b.x - a.x, b.z - a.z) < a.halfLength + b.halfLength + 0.5 && footprintsOverlap(a, b, 0.03);
        if (touch) {
          this.contactTime += dt;
          A.contactUntil = this.time + 1;
          B.contactUntil = this.time + 1;
          if (!p.touching && this.time - p.lastTouch > 0.5) {
            this.contacts++;
            // Approach speed along the line between the two centres.
            const sep = Math.hypot(b.x - a.x, b.z - a.z) || 1;
            const impact = Math.max(0, ((a.vx - b.vx) * (b.x - a.x) + (a.vz - b.vz) * (b.z - a.z)) / sep);
            if (impact > this.maxImpactSpeed) this.maxImpactSpeed = impact;
            // (with a car in it that was out of control — sliding > 20 deg or
            // pointing > 25 deg off the road: counted apart as well)
            const wild = (t: CarTracker) => t.speed > 5 && (Math.abs(t.beta) > 20 * RAD || Math.abs(t.headingError) > 25 * RAD);
            if (wild(a) || wild(b)) {
              if (impact > this.maxImpactWild) this.maxImpactWild = impact;
            } else if (impact > this.maxImpactTame) this.maxImpactTame = impact;
            // With the player stand-in in it: was the stand-in itself out of
            // control (no rival holding its lane avoids that), and who moved
            // toward whom?
            const P = A.proxy ? A : B.proxy ? B : null;
            let proxyWild = false;
            const afterFlag = P !== null && P.finished;
            let tag = afterFlag ? ' [after flag]' : '';
            if (afterFlag) {
              this.proxyAfterFlag++;
            } else if (P) {
              this.proxyContacts++;
              if (this.raceClock < LAUNCH_SPAN) this.proxyLaunchContacts++;
              if (this.raceClock < OPENING_SPAN) {
                this.proxyOpeningContacts++;
                if (impact > this.maxImpactOpening) this.maxImpactOpening = impact;
              }
              proxyWild = this.histMax(P, P.histBeta, 0.5) > WILD_SLIP || this.histMax(P, P.histSpin, 0.5) > SPIN_RATE;
              if (proxyWild) {
                this.proxyWildContacts++;
                tag = ' [stand-in wild]';
              }
              const R = P === A ? B : A;
              if (!proxyWild && R.driver) {
                const side = Math.sign(P.tracker.lateral - R.tracker.lateral);
                const rTo = side * this.histMean(R, R.histLat, 0.3);
                const pTo = -side * this.histMean(P, P.histLat, 0.3);
                if (rTo > 0.3 && rTo > pTo) {
                  this.rivalAtFault++;
                  tag = ' [rival moved in]';
                }
              }
            } else if (A.driver && B.driver) {
              this.rivalContacts++;
              if (this.raceClock < OPENING_SPAN) this.rivalOpeningContacts++;
            }
            if (afterFlag) {
              if (impact > this.maxImpactAfterFlag) this.maxImpactAfterFlag = impact;
            } else if (proxyWild) {
              if (impact > this.maxImpactProxyWild) this.maxImpactProxyWild = impact;
            } else if (impact > this.maxImpactInControl) this.maxImpactInControl = impact;
            // Rear-end (one behind the other) or side (alongside)?
            const along = geo.arcDelta(a.s, b.s);
            const across = b.lateral - a.lateral;
            const kind = Math.abs(across) < 0.6 * (a.halfWidth + b.halfWidth) ? 'rear' : Math.abs(along) < 0.6 * (a.halfLength + b.halfLength) ? 'side' : 'corner';
            if (kind === 'rear') this.rearEnds++;
            if (kind === 'rear' && impact > this.maxRearImpact) this.maxRearImpact = impact;
            if (this.log.length < 40) {
              const st = (c: RaceCar) => (c.driver ? `p${c.driver.passSide}${c.driver.yielding ? 'y' : ''}` : c.kind);
              this.log.push(
                `t=${this.raceClock.toFixed(1)} ${kind} contact ${A.id}/${B.id} closing ${impact.toFixed(1)} at s=${a.s.toFixed(0)}: ` +
                `ds=${along.toFixed(1)} dlat=${across.toFixed(1)} v=${a.speed.toFixed(0)}/${b.speed.toFixed(0)} lat=${a.lateral.toFixed(1)}/${b.lateral.toFixed(1)} ` +
                `he=${(a.headingError * DEG).toFixed(0)}/${(b.headingError * DEG).toFixed(0)} ${st(A)}/${st(B)}${tag}`,
              );
            }
          }
          p.lastTouch = this.time;
        }
        p.touching = touch;
      }
      // Overtake: A comes from behind B and gets clear ahead while B is
      // racing (not standing, not just respawned, not finished).
      if (A.kind === 'parked' || A.finished) continue;
      const rel = geo.arcDelta(b.progress, a.progress);
      const clear = a.halfLength + b.halfLength + 0.5;
      const bRacing = B.kind !== 'parked' && !B.finished && b.speed > 3 && this.time - B.lastRescueAt > 4;
      if (rel < -1) {
        p.order = -1;
        p.cleanCross = false;
      } else if (p.order === -1 && rel > 0 && !p.cleanCross) {
        p.cleanCross = bRacing && Math.abs(rel) < 3;
        if (!p.cleanCross) p.order = 0;
      } else if (p.order === -1 && p.cleanCross && rel > clear) {
        this.overtakes++;
        p.order = 1;
        p.cleanCross = false;
        if (this.log.length < 40) this.log.push(`t=${this.raceClock.toFixed(1)} ${A.id} passed ${B.id} at s=${a.s.toFixed(0)}`);
      } else if (rel > clear) {
        p.order = 1;
      }
    }
  }

  /**
   * The launching stand-in's eyes (LAUNCH_EYES s after lights out, while it
   * holds and leaves its grid lane): a player who floors it from the back of
   * the grid sees the car straight ahead of it in its own lane and lifts —
   * it does not drive into it. Off the throttle while the bumper gap is
   * shorter than 1.2 s of closing + 1.5 m, on the brake below 0.6 s + 1 m.
   * (Only the launch: after it the stand-ins ignore the others, as before.)
   */
  private launchEyes(car: RaceCar): void {
    const geo = this.field.geo;
    const t = car.tracker;
    const intent = car.input!.intent;
    for (const other of this.cars) {
      if (other === car) continue;
      const o = other.tracker;
      const ds = geo.arcDelta(t.s, o.s);
      if (ds <= 0 || ds > 40) continue;
      // (its own lane only: also looking 0.6 s ahead into the lane it merges
      // into — tried — raised the stand-in contacts on three
      // of four probe files and kept it off the throttle 2.2-2.9 s)
      if (Math.abs(o.lateral - t.lateral) > t.halfWidth + o.halfWidth + 0.4) continue;
      const gap = ds - t.halfLength - o.halfLength;
      const closing = t.speedAlong - o.speedAlong;
      if (closing <= 0) continue;
      if (gap < 1.2 * closing + 1.5) {
        intent.throttle = 0;
        if (gap < 0.6 * closing + 1 && t.speed > 2) intent.brake = Math.max(intent.brake, 0.6);
        this.launchLiftTime += this.dt;
        return;
      }
    }
  }

  /** Largest / mean value of a car's history over the last `span` s. */
  private histMax(car: RaceCar, values: Float64Array, span: number): number {
    let best = 0;
    for (let k = 0; k < HIST; k++) if (car.histT[k] >= this.raceClock - span - 1e-9 && values[k] > best) best = values[k];
    return best;
  }
  private histMean(car: RaceCar, values: Float64Array, span: number): number {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < HIST; k++) {
      if (car.histT[k] >= this.raceClock - span - 1e-9) {
        sum += values[k];
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  /** Step until `until` returns true or `seconds` have passed. Resolves to
   * true when stopped by `until`. */
  async run(seconds: number, until?: () => boolean): Promise<boolean> {
    const n = Math.max(1, Math.round(seconds / this.dt));
    for (let i = 0; i < n; i++) {
      this.step();
      if (until && until()) return true;
      if (this.env.watch && this.env.onFrame && this.facade && this.focus) {
        this.frameDebt += this.dt;
        if (this.frameDebt >= 1 / 60) {
          this.frameDebt -= 1 / 60;
          const t = this.focus.tracker;
          const intent = this.focus.vehicle.visual;
          this.facade.time = this.time;
          this.facade.tel = { speed: t.speed, beta: t.beta, steering: intent.steerInput, throttle: intent.throttle, brake: intent.brake };
          await this.env.onFrame(this.facade as unknown as Sim);
        }
      }
    }
    return false;
  }

  get allFinished(): boolean {
    for (const car of this.cars) if (car.kind !== 'parked' && !car.finished) return false;
    return true;
  }

  /** Flat metrics: whole race + one block per car (prefix = car id). */
  metrics(): Record<string, MetricValue> {
    const m: Record<string, MetricValue> = {
      terrain: this.world.terrainSource,
      trackLength: this.field.geo.length,
      halfWidth: this.track.halfWidth,
      raceTime: this.raceClock,
      allFinished: this.allFinished,
      contacts: this.contacts,
      rearEnds: this.rearEnds,
      maxRearImpact: this.maxRearImpact,
      contactTime: this.contactTime,
      maxImpactSpeed: this.maxImpactSpeed, maxImpactWild: this.maxImpactWild, maxImpactTame: this.maxImpactTame,
      proxyContacts: this.proxyContacts, proxyWildContacts: this.proxyWildContacts,
      contactsInControl: this.contacts - this.proxyWildContacts - this.proxyAfterFlag,
      proxyLaunchContacts: this.proxyLaunchContacts, proxyOpeningContacts: this.proxyOpeningContacts, maxImpactOpening: this.maxImpactOpening,
      rivalOpeningContacts: this.rivalOpeningContacts, proxyAfterFlag: this.proxyAfterFlag, maxImpactAfterFlag: this.maxImpactAfterFlag,
      launchLiftTime: this.launchLiftTime,
      maxImpactInControl: this.maxImpactInControl, maxImpactProxyWild: this.maxImpactProxyWild,
      rivalAtFault: this.rivalAtFault, rivalContacts: this.rivalContacts,
      maxPlanLateral: this.maxPlanLateral, maxOuterLateral: this.maxOuterLateral, maxOuterAny: this.maxOuterAny,
      overtakes: this.overtakes,
      maxPileUp: this.maxPileUp,
    };
    let rescues = 0;
    let forced = 0;
    let racers = 0;
    let lift = 0;
    let tilt = 0;
    let off = 0;
    let slow = 0;
    let time = 0;
    let maxSlowRun = 0;
    let crawl = 0;
    let rivals = 0;
    let freeStand = 0;
    for (const car of this.cars) {
      if (car.kind === 'parked') continue;
      racers++;
      if (car.driver) {
        rivals++;
        crawl += car.crawlTime;
        freeStand = Math.max(freeStand, car.maxFreeStand);
      }
      rescues += car.rescues;
      forced += car.forcedRescues;
      lift = Math.max(lift, car.maxContactLift);
      tilt = Math.max(tilt, car.maxContactTilt);
      off += car.offRoadTime;
      slow += car.slowTime;
      time += car.raceTime;
      maxSlowRun = Math.max(maxSlowRun, car.maxSlowRun);
      const k = car.id;
      m[`${k}.car`] = car.carId;
      m[`${k}.skill`] = car.skill;
      m[`${k}.finished`] = car.finished;
      m[`${k}.finishTime`] = car.finishTime;
      m[`${k}.position`] = this.field.positionOf(car.id);
      m[`${k}.laps`] = car.lapTimes.map((t) => t.toFixed(2)).join(' / ');
      m[`${k}.bestLap`] = car.lapTimes.length ? Math.min(...car.lapTimes) : null;
      m[`${k}.rescues`] = car.rescues + car.forcedRescues;
      m[`${k}.rescueLog`] = car.rescueReasons.join(' ');
      m[`${k}.stuckTime`] = car.slowTime;
      m[`${k}.offRoadPct`] = car.raceTime > 0 ? (100 * car.offRoadTime) / car.raceTime : 0;
      m[`${k}.sideOffPct`] = car.raceTime > 0 ? (100 * car.sideOffTime) / car.raceTime : 0;
      m[`${k}.maxOverEdge`] = car.maxOverEdge;
      m[`${k}.maxCentreOff`] = car.maxCentreOff;
      m[`${k}.maxSpeed`] = car.maxSpeed;
      m[`${k}.maxTiltDeg`] = car.maxTilt * DEG;
      if (car.driver) {
        m[`${k}.minGripTrust`] = car.minGripTrust;
        m[`${k}.reverses`] = car.driver.stats.reverses + car.driver.stats.turnarounds;
        m[`${k}.mistakes`] = car.driver.stats.mistakes;
        m[`${k}.sideFlips`] = car.driver.stats.sideFlips;
        m[`${k}.letBys`] = car.driver.stats.letBys;
        m[`${k}.passAborts`] = car.driver.stats.passAborts;
        m[`${k}.crawlTime`] = car.crawlTime;
        m[`${k}.fastTime`] = car.driver.stats.fastTime;
        m[`${k}.fastCornerTime`] = car.driver.stats.fastCornerTime;
        m[`${k}.maxFreeStandstill`] = car.maxFreeStand;
      }
    }
    m.crawlPerRival = rivals > 0 ? crawl / rivals : 0;
    m.maxFreeStandstill = freeStand;
    m.racers = racers;
    m.rescues = rescues;
    m.forcedRescues = forced;
    m.rescuesPerCar = racers > 0 ? (rescues + forced) / racers : 0;
    m.maxContactLift = lift;
    m.maxContactTiltDeg = tilt * DEG;
    m.offRoadPct = time > 0 ? (100 * off) / time : 0;
    m.stuckTime = slow;
    m.maxStandstill = maxSlowRun;
    m.log = this.log.join(' | ');
    return m;
  }

  dispose(): void {
    for (const car of this.cars) car.vehicle.dispose();
    this.world.dispose();
  }
}

function roundMetrics(raw: Record<string, MetricValue>): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const [key, value] of Object.entries(raw)) out[key] = typeof value === 'number' ? round(value, 3) : value;
  return out;
}

interface CpuTotals {
  thinkMs: number;
  thinkCalls: number;
  stepMs: number;
  carSteps: number;
  setupMs: number;
  setups: number;
  /** race.maxLateral over every case (and the case it was in). */
  maxPlanLateral: number;
  maxPlanAt: string;
  maxOuterLateral: number;
  maxOuterAt: string;
  maxOuterAny: number;
  maxOuterAnyAt: string;
}

/** Run one case in a fresh world; always disposes. */
async function withRace(
  env: LabEnv,
  id: string,
  seed: number,
  dt: number,
  options: Partial<RaceOptions>,
  cpu: CpuTotals,
  body: (race: RaceSim) => Promise<Record<string, MetricValue>>,
): Promise<Record<string, MetricValue>> {
  const race = new RaceSim(env, seed, dt, options);
  const traced = urlText('raceTrace');
  if (traced && id.startsWith(traced)) race.trace = [];
  try {
    const raw = await body(race);
    if (race.trace) {
      raw.trace = race.trace.join('\n');
      // The first rival's line: index, centre curvature, line offset, line
      // curvature, planned speed (every 2nd point).
      const rival = race.field.rivals[0];
      const line = rival?.driver.raceLine;
      if (line) {
        const rows: string[] = [];
        for (let i = 0; i < line.geo.n; i += 2) {
          rows.push(`${i} kc=${line.geo.curvature[i].toFixed(4)} off=${line.offset[i].toFixed(2)} kl=${line.curvature[i].toFixed(4)} v=${line.speed[i].toFixed(1)} h=${line.geo.height[i].toFixed(2)} hv=${line.geo.vcurv[i].toFixed(4)}`);
        }
        raw.lineProfile = rows.join('\n');
      }
    }
    cpu.thinkMs += race.thinkMs;
    cpu.thinkCalls += race.thinkCalls;
    cpu.stepMs += race.stepMs;
    cpu.carSteps += race.steps * race.cars.length;
    cpu.setupMs += race.setupMs;
    cpu.setups += race.setups;
    if (race.maxPlanLateral > cpu.maxPlanLateral) {
      cpu.maxPlanLateral = race.maxPlanLateral;
      cpu.maxPlanAt = id;
    }
    if (race.maxOuterAny > cpu.maxOuterAny) {
      cpu.maxOuterAny = race.maxOuterAny;
      cpu.maxOuterAnyAt = id;
    }
    if (race.maxOuterLateral > cpu.maxOuterLateral) {
      cpu.maxOuterLateral = race.maxOuterLateral;
      cpu.maxOuterAt = id;
    }
    return roundMetrics({ seed, hz: Math.round(1 / dt), ...raw });
  } finally {
    race.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Grid → settle → lights out → run to the flag (or the time limit). */
async function runToFlag(race: RaceSim, setups: CarSetup[], grid: GridPose[]): Promise<void> {
  setups.forEach((setup, i) => race.addCar(setup, grid[i]));
  race.ready();
  await race.run(0.6);
  race.start();
  const limit = race.options.laps * (race.field.geo.length / 4) + 30;
  await race.run(limit, () => race.allFinished);
}

// ------------------------------------------------------------------ cases

function fourRivals(seed: number): CarSetup[] {
  // Slowest on pole, quickest last: the field has to pass to sort itself.
  return [0.3, 0.5, 0.7, 0.9].map((skill, i) => ({
    id: `r${Math.round(skill * 100)}`,
    carId: RACE_CAR_IDS[(i + seed) % RACE_CAR_IDS.length],
    kind: 'rival' as const,
    skill,
    seed: seed * 100 + i,
    grid: true,
  }));
}

async function rivalRace(env: LabEnv, id: string, seed: number, dt: number, laps: number, cpu: CpuTotals) {
  return withRace(env, id, seed, dt, { laps }, cpu, async (race) => {
    await runToFlag(race, fourRivals(seed), gridPoses(race.track, 4));
    return race.metrics();
  });
}

async function proxyRace(env: LabEnv, id: string, seed: number, dt: number, laps: number, band: number, tier: ProxyTier, cpu: CpuTotals) {
  return withRace(env, id, seed, dt, { laps, rubberBand: band }, cpu, async (race) => {
    const preset = presetOf(tier.preset);
    const entries = buildField({ playerCarId: env.carId, rivals: 3, difficulty: preset.difficulty, spread: preset.spread, seed });
    const setups: CarSetup[] = entries.map((e) => e.isPlayer
      ? { id: 'player', carId: e.carId, kind: 'proxy' as const, driver: tier.driver, launchInLane: launchMode() !== 'swerve', launchEyes: launchMode() === 'eyes' }
      : { id: e.id, carId: e.carId, kind: 'rival' as const, skill: e.skill!, seed: e.seed, grid: true });
    const grid = gridPoses(race.track, entries.length);
    // Largest gap between the player and any rival, sampled each second.
    let maxGap = 0;
    let gapSum = 0;
    let gapN = 0;
    let maxPace = 0;
    let paceSum = 0;
    let paceN = 0;
    setups.forEach((setup, i) => race.addCar(setup, grid[entries[i].slot]));
    race.ready();
    await race.run(0.6);
    race.start();
    const player = race.cars.find((c) => c.kind === 'proxy')!;
    const limit = laps * (race.field.geo.length / 4) + 30;
    let next = 1;
    await race.run(limit, () => {
      for (const r of race.field.rivals) {
        maxPace = Math.max(maxPace, Math.abs(r.driver.pace));
        paceSum += Math.abs(r.driver.pace);
        paceN++;
      }
      if (race.raceClock >= next && !player.finished) {
        next += 1;
        for (const c of race.cars) {
          if (c === player || c.finished) continue;
          const gap = Math.abs(c.tracker.progress - player.tracker.progress);
          maxGap = Math.max(maxGap, gap);
          gapSum += gap;
          gapN++;
        }
      }
      return race.allFinished;
    });
    const m = race.metrics();
    const times = race.cars.map((c) => c.finishTime).filter((t): t is number => t !== null);
    return {
      ...m,
      band,
      maxPaceAsked: maxPace,
      meanPaceAsked: paceN > 0 ? paceSum / paceN : 0,
      playerPosition: race.field.positionOf('player'),
      playerFinishTime: player.finishTime,
      winnerTime: times.length > 0 ? Math.min(...times) : null,
      maxGapToPlayer: maxGap,
      meanGapToPlayer: gapN > 0 ? gapSum / gapN : 0,
      finishSpread: times.length > 1 ? Math.max(...times) - Math.min(...times) : null,
    };
  });
}

async function soloLaps(env: LabEnv, caseId: string, seed: number, dt: number, laps: number, skill: number, cpu: CpuTotals) {
  return withRace(env, caseId, seed, dt, { laps, cooldown: false }, cpu, async (race) => {
    const id = `k${Math.round(skill * 100)}`;
    await runToFlag(race, [{ id, carId: env.carId, kind: 'rival', skill, seed: seed * 100 + 7 }], gridPoses(race.track, 1, { lateralFraction: 0 }));
    const m = race.metrics();
    const car = race.cars[0];
    // Flying laps only (lap 1 has the standing start).
    const flying = car.lapTimes.slice(1);
    return {
      ...m, skill, flyingLap: flying.length ? mean(flying) : null, lapsDone: car.lapTimes.length,
      sideOffPct: (100 * car.sideOffTime) / Math.max(car.raceTime, 1e-3), maxOverEdge: car.maxOverEdge,
    };
  });
}

/**
 * Two rivals in the suite's car, the slower one `ahead` metres in front of
 * the quicker one at the start: how long until the quicker one is past and
 * clear? (the skill gap is the ONLY difference between the two)
 */
async function duel(env: LabEnv, caseId: string, seed: number, dt: number, leadSkill: number, chaseSkill: number, cpu: CpuTotals) {
  return withRace(env, caseId, seed, dt, { laps: 99, cooldown: false }, cpu, async (race) => {
    const lead = race.addCar({ id: 'lead', carId: env.carId, kind: 'rival', skill: leadSkill, seed: seed * 100 + 1 }, trackPose(race, 4));
    const chase = race.addCar({ id: 'chase', carId: env.carId, kind: 'rival', skill: chaseSkill, seed: seed * 100 + 2 }, trackPose(race, -6));
    race.ready();
    await race.run(0.6);
    race.start();
    const L = race.field.geo.length;
    let behindTime = 0;
    const passed = await race.run(DUEL_LAPS * (L / 14), () => {
      const gap = lead.tracker.progress - chase.tracker.progress;
      if (gap > 0 && gap < 12) behindTime += race.dt;
      return (race.overtakes > 0 && gap < -8) || lead.tracker.progress > DUEL_LAPS * L;
    });
    const done = passed && chase.tracker.progress > lead.tracker.progress;
    return {
      passed: done, timeToPass: done ? race.raceClock : null, lapsToPass: done ? chase.tracker.progress / L : null,
      secondsStuckBehind: behindTime, contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed,
      rescues: lead.rescues + chase.rescues, sideFlips: chase.driver!.stats.sideFlips,
      chaseOffRoadPct: (100 * chase.offRoadTime) / Math.max(chase.raceTime, 1e-3),
      trackLength: L, log: race.log.join(' | '),
    };
  });
}

// -------------------------------------------------------------- scenarios

/** Pose on the track at arc distance `s` after the line, `lateral` m to the right. */
function trackPose(race: RaceSim, s: number, lateral = 0, yawOffset = 0): { x: number; z: number; yaw: number; index: number } {
  const geo = race.field.geo;
  const index = geo.indexAhead(0, ((s % geo.length) + geo.length) % geo.length);
  return {
    x: geo.px[index] + lateral * geo.tz[index],
    z: geo.pz[index] - lateral * geo.tx[index],
    yaw: Math.atan2(geo.tx[index], geo.tz[index]) + yawOffset,
    index,
  };
}

/** Start of the straightest `span` metres of the track (arc length). */
function straightestStretch(race: RaceSim, span: number): number {
  const geo = race.field.geo;
  let best = 0;
  let bestWorst = Infinity;
  for (let i = 0; i < geo.n; i += 2) {
    let worst = 0;
    let k = i;
    for (let d = 0; d < span; d += geo.seg[k], k = k + 1 === geo.n ? 0 : k + 1) worst = Math.max(worst, Math.abs(geo.curvature[k]));
    if (worst < bestWorst) {
      bestWorst = worst;
      best = i;
    }
  }
  return geo.s[best];
}

/**
 * Knocked off line at speed: one rival alone, thrown `offset` m to the side
 * with its nose `yawDeg` off the road direction at `speed` m/s on the
 * straightest part of the track (what a nudge from another car leaves it
 * with). It has to gather the car up without weaving or leaving the road.
 */
async function knocked(race: RaceSim, skill: number, speed: number, offset: number, yawDeg: number): Promise<Record<string, MetricValue>> {
  const s0 = straightestStretch(race, 70);
  const pose = trackPose(race, s0, offset, yawDeg * RAD);
  const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill, seed: 81 }, pose);
  race.ready();
  await race.run(0.4);
  race.start();
  hero.vehicle.setMotion(new Vector3(Math.sin(pose.yaw) * speed, 0, Math.cos(pose.yaw) * speed), 0);
  const half = race.track.halfWidth;
  let swings = 0;
  let side = 0;
  let worstError = 0;
  let maxOver = -Infinity;
  let settledAt: number | null = null;
  let calm = 0;
  let maxHeading = 0;
  await race.run(5, () => {
    const t = hero.tracker;
    const error = t.lateral - hero.driver!.lastTargetLateral;
    // A swing = the car crossing its target line with more than 0.4 m to
    // spare on the other side.
    const now = error > 0.4 ? 1 : error < -0.4 ? -1 : 0;
    if (now !== 0 && now !== side && settledAt === null) {
      if (side !== 0) swings++;
      side = now;
    }
    if (race.raceClock > 0.3) worstError = Math.max(worstError, Math.abs(error));
    maxOver = Math.max(maxOver, Math.abs(t.lateral) + t.halfWidth - half);
    maxHeading = Math.max(maxHeading, Math.abs(t.headingError));
    calm = Math.abs(error) < 0.5 && Math.abs(t.headingError) < 0.25 ? calm + race.dt : 0;
    if (settledAt === null && calm > 0.6) settledAt = race.raceClock - 0.6;
    return false;
  });
  return {
    skill, speed, offset, yawDeg, settleTime: settledAt, swings, maxOverEdge: maxOver, maxHeadingDeg: maxHeading * DEG,
    offRoadPct: (100 * hero.offRoadTime) / Math.max(hero.raceTime, 1e-3), rescues: hero.rescues, upright: hero.tracker.upY > 0.8,
  };
}

/** The longest stretch of the track with no bend tighter than 150 m radius
 * (on these tracks: the start straight, 68-72 m): its start and length. */
function longestStraight(race: RaceSim): { start: number; length: number } {
  const geo = race.field.geo;
  const flat = (i: number) => Math.abs(geo.curvature[i]) < 1 / 150;
  // start the scan at a bent point, so a run never wraps unseen
  let k0 = 0;
  while (k0 < geo.n && flat(k0)) k0++;
  let best = { start: 0, length: 0 };
  let runStart = -1;
  let runLen = 0;
  for (let j = 1; j <= geo.n; j++) {
    const i = (k0 + j) % geo.n;
    if (flat(i)) {
      if (runStart < 0) {
        runStart = i;
        runLen = 0;
      }
      runLen += geo.seg[i];
      if (runLen > best.length) best = { start: geo.s[runStart], length: runLen };
    } else {
      runStart = -1;
    }
  }
  return best;
}

/** Entry of the tightest bend of the track: where |curvature| first goes
 * over half its peak on the way into it. */
function tightestBendEntry(race: RaceSim): number {
  const geo = race.field.geo;
  let peak = 0;
  let at = 0;
  for (let i = 0; i < geo.n; i++) {
    if (Math.abs(geo.curvature[i]) > peak) {
      peak = Math.abs(geo.curvature[i]);
      at = i;
    }
  }
  let i = at;
  for (let d = 0; d < 80 && Math.abs(geo.curvature[i]) > 0.5 * peak; d += geo.seg[i]) i = i === 0 ? geo.n - 1 : i - 1;
  return geo.s[i];
}

/** One closing car of s.fastBehind. */
interface FastCloser {
  /** The line it holds, m right of the centreline. */
  line: number;
  /** 'tidy' = FAST_CLOSER, 'quick' = the proxy races' quick stand-in. */
  style: 'tidy' | 'quick';
  /** A FOLLOWER: closes at `closing` from 30 m back like the others, and
   * once its bumper is FOLLOW_AT m from the rival's it only holds the
   * rival's starting speed (it follows rather than passes; the rule must
   * let it go). */
  follow?: boolean;
}

/** s.fastBehind follower: bumper gap at which it stops closing, m. */
const FOLLOW_AT = 8;

/**
 * A much faster car arriving from behind: one rival (racing pace capped at
 * 60 % of the car's top speed, so there is something to catch) on ITS OWN
 * racing line, and 30 m behind it a stand-in (lab driver, ignores the
 * rival) holding a stated line — the centreline or 1.5 m to either side —
 * whose plan is capped at the rival's speed + `closing`, set going at that
 * speed or at its own plan's speed there if lower (a car set going faster
 * than its plan brakes and swerves in the first second: the closers did,
 * by up to 0.7 m, and the rival judged the side from that):
 *  · 'straight': timed so that the closer gets to the rival in the middle
 *    of the longest straight (the start straight; the old "straightest
 *    100 m" held a bend of 19-28 m radius);
 *  · 'corner': timed so that the closer gets to the rival at the turn-in of
 *    the tightest bend, the rival told that any bend
 *    that slows its plan by 2 % is a corner (cornerZone 0.98: at 60 % pace
 *    no bend on these tracks is slower than the default zone, and the
 *    corner branch of the rule never ran).
 * The rival must hold its line and speed and, on a straight, move to the
 * side the other car is not on: no contact.
 * A run only counts as passed when the closer got by: clear ahead of the
 * rival (bumpers 4 m apart) BY ARC from where both started (not by
 * `progress`, which reads a lap short for a car first seen in the second
 * half of the lap), more than 1 s in, within 20 s.
 */
async function fastBehind(race: RaceSim, where: 'straight' | 'corner', skill: number, closing: number, how: FastCloser): Promise<Record<string, MetricValue>> {
  const back = 30;
  const geo0 = race.field.geo;
  const straight = longestStraight(race);
  const hero = race.addCar({
    id: 'hero', carId: race.env.carId, kind: 'rival', skill, seed: 95 + Math.round(skill * 10),
    params: where === 'corner' ? { topSpeedUse: 0.6, cornerZone: 0.98 } : { topSpeedUse: 0.6 },
  }, trackPose(race, 0));
  let sHero: number;
  if (where === 'straight') {
    // (60 % of the car's top speed is what the rival's capped plan holds on
    // a straight; its real speed is known only once it has a plan)
    sHero = straight.start + 0.5 * straight.length - 0.6 * hero.vehicle.topSpeed * (back / closing);
  } else {
    // (timed so that the closer gets to it at the turn-in)
    sHero = tightestBendEntry(race) - 0.6 * hero.vehicle.topSpeed * (back / closing) * 0.8;
  }
  sHero = ((sHero % geo0.length) + geo0.length) % geo0.length;
  const pose0 = trackPose(race, sHero);
  // On its own line (it was put on the centreline before, 2.2-3.4 m off its
  // line, and was still moving across at up to 5 m/s when the closer came).
  const lineAt = hero.driver!.raceLine!.offset[pose0.index];
  const heroPose = trackPose(race, sHero, lineAt);
  hero.vehicle.reset(new Vector3(heroPose.x, race.world.groundHeight(heroPose.x, heroPose.z), heroPose.z), heroPose.yaw);
  hero.vehicle.chassisMesh.computeWorldMatrix(true);
  // (its tracker had its first fix where the car was added)
  hero.tracker.relocate();
  const closerPose = trackPose(race, sHero - back, how.line);
  const closerCar = RACE_CAR_IDS.find((id) => id !== race.env.carId) ?? race.env.carId;
  const closer = race.addCar({
    id: 'closer', carId: closerCar, kind: 'proxy', driver: how.style === 'quick' ? QUICK : FAST_CLOSER, pathOffset: how.line,
  }, closerPose);
  race.ready();
  await race.run(0.6);
  // (the hero's plan exists once it has thought: the settle steps did that)
  const heroLine = hero.driver!.raceLine!;
  const vHero = Math.max(6, heroLine.speed[heroPose.index]);
  const vCloser = vHero + closing;
  const closerLine = offsetLine(race.track.points, how.line);
  const capPlan = (top: number) => {
    closer.proxy!.params.maxSpeed = top;
    closer.plan = new PathPlan(closerLine, planOptions(closer.proxy!.car, closer.proxy!.params, true));
  };
  capPlan(vCloser);
  // its plan's speed where it starts (nearest plan point)
  let near = 0;
  let nearD = Infinity;
  for (let i = 0; i < closer.plan!.count; i++) {
    const d = Math.hypot(closer.plan!.points[2 * i] - closerPose.x, closer.plan!.points[2 * i + 1] - closerPose.z);
    if (d < nearD) {
      nearD = d;
      near = i;
    }
  }
  // (the lowest its plan asks for in the next 25 m: the lab driver brakes
  // for what is coming a little ahead of its plan)
  let vStart = vCloser;
  for (let i = near, d = 0; d < 25; d += 1, i = (i + 1) % closer.plan!.count) vStart = Math.min(vStart, closer.plan!.speed[i]);
  race.start();
  hero.vehicle.setMotion(new Vector3(Math.sin(heroPose.yaw) * vHero, 0, Math.cos(heroPose.yaw) * vHero), 0);
  closer.vehicle.setMotion(new Vector3(Math.sin(closerPose.yaw) * vStart, 0, Math.cos(closerPose.yaw) * vStart), 0);
  const geo = race.field.geo;
  const h0 = hero.tracker.s;
  const c0 = closer.tracker.s;
  // Arc distance of the closer ahead of the hero, from where both started
  // (not from `progress`: a first fix in the second half of the lap reads
  // negative there and would end the run at once).
  let hRun = 0;
  let cRun = 0;
  let hLast = h0;
  let cLast = c0;
  const startGap = geo.arcDelta(h0, c0);
  let minSpeed = Infinity;
  let minPlanRatio = Infinity;
  let minDist = Infinity;
  let metAt: number | null = null;
  let metCurv = 0;
  let shift = 0;
  let weave = 0;
  let behindTime = 0;
  let offLineTime = 0;
  let followFrom: number | null = null;
  let fastAtFollow = 0;
  let maxClosing = 0;
  let fastWhileFollowing = 0;
  let fastLast = 0;
  const along = (t: CarTracker) => t.speedAlong / Math.min(1.5, Math.max(0.5, 1 - geo.curvature[t.index] * t.lateral));
  const passed = await race.run(20, () => {
    const h = hero.tracker;
    const c = closer.tracker;
    hRun += geo.arcDelta(hLast, h.s);
    cRun += geo.arcDelta(cLast, c.s);
    hLast = h.s;
    cLast = c.s;
    const ahead = startGap + cRun - hRun;
    const bumpers = -ahead - (h.halfLength + c.halfLength);
    if (how.follow && followFrom === null && bumpers < FOLLOW_AT) {
      // From here on it only follows.
      followFrom = race.raceClock;
      fastAtFollow = hero.driver!.stats.fastTime;
      capPlan(vHero);
      closer.proxy!.followPath(closer.plan!);
    }
    if (bumpers > 0 && bumpers < 25) maxClosing = Math.max(maxClosing, c.speedAlong - h.speedAlong);
    // (the follower: time the rival spends out of its way while it is NOT
    // gaining along the road — a follower on the inside of a bend that the
    // rival goes round on the outside does gain, and is not counted)
    const fastNow = hero.driver!.stats.fastTime;
    if (followFrom !== null && fastNow > fastLast && along(c) - along(h) < 2) fastWhileFollowing += fastNow - fastLast;
    fastLast = fastNow;
    if (ahead < 5) {
      minSpeed = Math.min(minSpeed, h.speed);
      minPlanRatio = Math.min(minPlanRatio, h.speed / Math.max(heroLine.speed[h.index], 1));
      weave = Math.max(weave, Math.abs(c.lateral - how.line));
      if (Math.abs(h.lateral - heroLine.offset[h.index]) > 1) offLineTime += race.dt;
    }
    if (ahead < -(h.halfLength + c.halfLength)) behindTime += race.dt;
    shift = Math.max(shift, Math.abs(h.lateral - heroLine.offset[h.index]));
    const dist = Math.hypot(h.x - c.x, h.z - c.z);
    minDist = Math.min(minDist, dist);
    if (metAt === null && bumpers < 2 && race.raceClock > 0.2) {
      metAt = race.raceClock;
      metCurv = Math.abs(geo.curvature[h.index]);
    }
    return !how.follow && race.raceClock > 1 && ahead > h.halfLength + c.halfLength + 4;
  });
  const stats = hero.driver!.stats;
  return {
    where, skill, closing, line: how.line, closer: how.style, follow: how.follow === true,
    heroSpeed: vHero, closerStartSpeed: vStart, maxClosingSeen: maxClosing, passed, met: metAt !== null, timeToPass: passed ? race.raceClock : null,
    metRadius: metAt === null ? null : metCurv > 1e-4 ? 1 / metCurv : 9999, straightLength: straight.length,
    contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed,
    heroMinSpeed: minSpeed, heroMinPlanRatio: minPlanRatio, heroOffLineTime: offLineTime,
    heroMaxOffLine: shift, minCentreDistance: minDist, rescues: hero.rescues + closer.rescues, closerMaxOffLine: weave,
    heroFastTime: stats.fastTime, heroFastCornerTime: stats.fastCornerTime, heroFastSwaps: stats.fastSwaps, closerBehindTime: behindTime,
    heroFastAfterFollow: followFrom === null ? null : stats.fastTime - fastAtFollow, heroFastBeforeFollow: followFrom === null ? null : fastAtFollow,
    heroFastWhileFollowing: followFrom === null ? null : fastWhileFollowing,
    heroLetBys: stats.letBys,
    log: race.log.join(' | '),
  };
}

/** Pose on the centreline at arc `s` (interpolated between points), `lateral`
 * m to the right, and the centreline's heading and curvature there. */
function centrePose(race: RaceSim, s: number, lateral: number): { x: number; z: number; heading: number; curvature: number; index: number } {
  const geo = race.field.geo;
  const L = geo.length;
  const u = ((s % L) + L) % L;
  let i = geo.indexAhead(0, u);
  // (indexAhead returns the point at or before u: walk to the bracket)
  while (geo.s[i] > u && i > 0) i--;
  const j = i + 1 === geo.n ? 0 : i + 1;
  const f = Math.max(0, Math.min(1, (u - geo.s[i]) / Math.max(geo.seg[i], 1e-3)));
  const tx = geo.tx[i] + (geo.tx[j] - geo.tx[i]) * f;
  const tz = geo.tz[i] + (geo.tz[j] - geo.tz[i]) * f;
  const len = Math.hypot(tx, tz) || 1;
  const x = geo.px[i] + (geo.px[j] - geo.px[i]) * f + (lateral * tz) / len;
  const z = geo.pz[i] + (geo.pz[j] - geo.pz[i]) * f - (lateral * tx) / len;
  return { x, z, heading: Math.atan2(tx, tz), curvature: geo.curvature[i] + (geo.curvature[j] - geo.curvature[i]) * f, index: i };
}

/**
 * A car out of control AHEAD: a stand-in held in a 30 deg drift through the
 * tightest bend (a puppet: re-posed every step on the centreline at a steady
 * speed, its body turned 30 deg into the bend, its velocity along the road —
 * a held drift as a player would hold it, sliding across nothing), with a
 * rival DRIFT_BEHIND (10) m behind, the drifter at DRIFT_PACE of the rival's
 * plan. (The builder's 14 m left the rival outside the rule's 12 m on some
 * seeds — nothing to test there; from 10 m the rule acts in every run.) The
 * out-of-control rule must still fire (RivalParams.wildSlip): the rival
 * keeps DRIFT_CLEAR of daylight to the drifter's footprint and ends up
 * behind it, no contact. "Drops back" is judged on the footprint gap, not on
 * the bumper gap along the road: in about a third of the runs the rival is
 * partly ALONGSIDE the drifter (bumper gap down to -3.3 m, daylight from
 * 0.43 m) while it drifts, before it falls 6-9 m back. DRIFT_CLEAR has
 * 3 cm of margin on unseen seed 2 (0.43 m) — a thin gate.
 * (`slip` is the drift angle, deg.)
 */
/** s.driftAhead: the rival starts this far behind the drifter (centre to
 * centre, m), and the drifter goes at this share of the rival's plan. */
const DRIFT_BEHIND = 10;
const DRIFT_PACE = 0.95;
/** s.driftAhead: least daylight between the two footprints while it
 * drifts, m, and least time the out-of-control rule must act, s. Measured
 * on seeds 1, 6, 13, 41, 66, 77 x reef-rocket /
 * comet-fox (24 runs): rule on — daylight 0.93-6 m, rule acting 0.53-1.92 s,
 * no contact; rule off (&rival=wildSlip:9) — rule 0 s in every run, daylight
 * 0-0.25 m on four of the six seeds (two contacts), 1.15-6 m on the other
 * two; the acceptance files then showed riot-ram seed 25 at 0.53 m with the
 * rule on. Thresholds between the two: 0.4 m, 0.25 s. */
const DRIFT_CLEAR = 0.4;
const DRIFT_RULE_TIME = 0.25;

async function driftAhead(race: RaceSim, slip: number): Promise<Record<string, MetricValue>> {
  const geo = race.field.geo;
  const entry = tightestBendEntry(race);
  const start = entry - 25;
  const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 77 }, trackPose(race, start - DRIFT_BEHIND));
  const line = hero.driver!.raceLine!;
  const first = centrePose(race, start, 0);
  const drifter = race.addCar({ id: 'drifter', carId: RACE_CAR_IDS.find((id) => id !== race.env.carId) ?? race.env.carId, kind: 'parked' }, { x: first.x, z: first.z, yaw: first.heading });
  // On its line, settled.
  const heroPose = trackPose(race, start - DRIFT_BEHIND, line.offset[trackPose(race, start - DRIFT_BEHIND).index]);
  hero.vehicle.reset(new Vector3(heroPose.x, race.world.groundHeight(heroPose.x, heroPose.z), heroPose.z), heroPose.yaw);
  hero.vehicle.chassisMesh.computeWorldMatrix(true);
  hero.tracker.relocate();
  race.ready();
  await race.run(0.6);
  // Its speed: DRIFT_PACE of the rival's own plan where the drifter is (so
  // the rival has no reason to pass it; what it does about the slide is the
  // test). (95 % from 14 m back: on some seeds the rival never came within
  // 12 m and the rule had nothing to act on; from 10 m
  // back it is within 12 m on every seed; at 90 % it went on to pass the
  // drifter alongside, which is a pass, not a drop-back.)
  const planAt = (s: number) => Math.max(6, DRIFT_PACE * line.speed[centrePose(race, s, 0).index]);
  let v = planAt(start);
  race.start();
  hero.vehicle.setMotion(new Vector3(Math.sin(heroPose.yaw) * v, 0, Math.cos(heroPose.yaw) * v), 0);
  const peak = (() => {
    let m = 0;
    for (let d = 0, k = geo.indexAhead(0, ((entry % geo.length) + geo.length) % geo.length); d < 60; d += geo.seg[k], k = k + 1 === geo.n ? 0 : k + 1) m = Math.max(m, Math.abs(geo.curvature[k]));
    return m;
  })();
  let sD = start;
  let drifting = 0;
  let slipNow = 0;
  let minGap = Infinity;
  let minClear = Infinity;
  let heroMaxAbove = -Infinity;
  let driftTime = 0;
  let gapIn: number | null = null;
  let gapOut = 0;
  const place = () => {
    const pose = centrePose(race, sD, 0);
    const k = pose.curvature;
    // (drift from the bend's entry while it is at least a third of its peak)
    const inBend = sD >= entry && Math.abs(k) > peak / 3;
    if (inBend) drifting = 1;
    else if (drifting > 0 && sD > entry) drifting = Math.max(0, drifting - race.dt / 0.5);
    slipNow = slip * RAD * drifting;
    // nose INTO the bend (oversteer attitude): turning right = yaw further right
    const yaw = pose.heading + Math.sign(k || 1) * slipNow;
    drifter.vehicle.reset(new Vector3(pose.x, race.world.groundHeight(pose.x, pose.z), pose.z), yaw);
    drifter.vehicle.setMotion(new Vector3(Math.sin(pose.heading) * v, 0, Math.cos(pose.heading) * v), v * k);
    drifter.vehicle.chassisMesh.computeWorldMatrix(true);
  };
  place();
  await race.run(10, () => {
    sD += v * race.dt;
    v = planAt(sD);
    place();
    const h = hero.tracker;
    const d = drifter.tracker;
    if (slipNow > 10 * RAD) {
      driftTime += race.dt;
      const gap = geo.arcDelta(h.s, d.s) - h.halfLength - d.halfLength;
      minGap = Math.min(minGap, gap);
      minClear = Math.min(minClear, clearance(h, d));
      if (gapIn === null) gapIn = gap;
      gapOut = gap;
      heroMaxAbove = Math.max(heroMaxAbove, h.speedAlong - v);
    }
    return sD > entry + 120;
  });
  const stats = hero.driver!.stats;
  return {
    slipDeg: slip, speed: v, driftTime, contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed,
    heroWildTime: stats.wildTime, minBumperGapWhileDrifting: Number.isFinite(minGap) ? minGap : null,
    minClearanceWhileDrifting: Number.isFinite(minClear) ? minClear : null,
    gapAtDriftStart: gapIn, gapAtDriftEnd: gapOut,
    heroMaxSpeedAboveDrifter: Number.isFinite(heroMaxAbove) ? heroMaxAbove : null, rescues: hero.rescues, log: race.log.join(' | '),
  };
}

/** Wrecks across the road `at` m after the line (null: 8 m before the end of
 * the start straight, as s.blockedRoad), at these laterals: through, or a
 * rescue asked for — whichever comes first, within 45 s. */
async function blockedCase(race: RaceSim, atWanted: number | null, laterals: number[]): Promise<Record<string, MetricValue>> {
  const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 31 }, trackPose(race, -6));
  let at = atWanted ?? 0;
  if (atWanted === null) {
    const st = longestStraight(race);
    const L = race.field.geo.length;
    let end = (st.start + st.length) % L;
    if (end > L / 2) end -= L;
    at = Math.max(25, Math.min(60, end - 8));
  }
  const wreckCars = ['reef-rocket', 'neon-wasp', 'riot-ram'];
  laterals.forEach((lat, k) => race.addCar({ id: `wreck${k}`, carId: wreckCars[k % 3], kind: 'parked' }, trackPose(race, at, lat)));
  race.ready();
  await race.run(0.6);
  race.start();
  let askedAt: number | null = null;
  const passed = await race.run(45, () => {
    if (hero.rescues > 0 && askedAt === null) askedAt = race.raceClock;
    return askedAt !== null || hero.tracker.progress > at + 20;
  }) && askedAt === null;
  return {
    passed, rescueAsked: askedAt !== null, timeToRescue: askedAt, timeToPass: passed ? race.raceClock : null,
    contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed, rescueLog: hero.rescueReasons.join(' '),
    reverses: hero.driver!.stats.reverses, maxStandstill: hero.maxSlowRun, wrecksAt: at, log: race.log.join(' | '),
  };
}

type Scenario = (race: RaceSim) => Promise<Record<string, MetricValue>>;

const SCENARIOS: Record<string, Scenario> = {
  /** A car parked on the racing line 60 m after the line: go round, no touch. */
  async parked(race) {
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 11 }, trackPose(race, -6));
    const line = hero.driver!.raceLine!;
    const at = trackPose(race, 60);
    race.addCar({ id: 'parked', carId: 'riot-ram', kind: 'parked' }, trackPose(race, 60, line.offset[at.index]));
    race.ready();
    await race.run(0.6);
    race.start();
    let minGap = Infinity;
    const passed = await race.run(25, () => {
      const p = race.cars[1].tracker;
      const h = hero.tracker;
      minGap = Math.min(minGap, Math.hypot(p.x - h.x, p.z - h.z));
      return h.progress > 60 + 25;
    });
    return { passed, timeToPass: race.raceClock, contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed, minCentreDistance: minGap, rescues: hero.rescues, offRoadPct: (100 * hero.offRoadTime) / Math.max(hero.raceTime, 1e-3) };
  },

  /** A much slower rival 25 m ahead: get past it within a lap, cleanly. */
  async slowCar(race) {
    const slow = race.addCar({
      id: 'slow', carId: 'riot-ram', kind: 'rival', skill: 0.3, seed: 5, params: { topSpeedUse: 0.55, cornerGrip: 0.3 },
    }, trackPose(race, 20));
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.85, seed: 12 }, trackPose(race, -6));
    race.ready();
    await race.run(0.6);
    race.start();
    const passed = await race.run(60, () => race.overtakes > 0 && hero.tracker.progress > slow.tracker.progress + 12);
    return {
      passed, timeToPass: race.raceClock, contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed,
      sideFlips: hero.driver!.stats.sideFlips, rescues: hero.rescues + slow.rescues,
      heroOffRoadPct: (100 * hero.offRoadTime) / Math.max(hero.raceTime, 1e-3),
      log: race.log.join(' | '),
    };
  },

  /** Two equal rivals start side by side and race a lap. */
  async sideBySide(race) {
    const half = race.track.halfWidth;
    const lat = Math.min(0.45 * half, half - 1.5);
    const a = race.addCar({ id: 'left', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 21 }, trackPose(race, -5, -lat));
    const b = race.addCar({ id: 'right', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 22 }, trackPose(race, -5, lat));
    race.ready();
    await race.run(0.6);
    race.start();
    const L = race.field.geo.length;
    let together = 0;
    const done = await race.run(60, () => {
      if (Math.abs(a.tracker.progress - b.tracker.progress) < 3.5) together += race.dt;
      return a.tracker.progress > L && b.tracker.progress > L;
    });
    return {
      lapDone: done, contacts: race.contacts, contactTime: race.contactTime, maxImpactSpeed: race.maxImpactSpeed,
      secondsAlongside: together, rescues: a.rescues + b.rescues,
      offRoadPct: (100 * (a.offRoadTime + b.offRoadTime)) / Math.max(a.raceTime + b.raceTime, 1e-3),
      maxContactLift: Math.max(a.maxContactLift, b.maxContactLift),
      log: race.log.join(' | '),
    };
  },

  /** Two parked cars side by side leave no gap on the road: stop without
   * ramming, then find a way round over the shoulder. */
  async blockedRoad(race) {
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.7, seed: 31 }, trackPose(race, -6));
    // (at +-2.6 m: on the 10 m road the old +-1.25 m left a gap some cars
    // drove through and others stopped for — two scenarios in one)
    // (8 m before the end of the start straight — 33-35 m after the line;
    // at 60 m they stood in the first bend, and since the way round may not
    // put the outer wheels beyond 6.3 m (race.maxLateral) the car has to be
    // placed to 0.3 m in the gap, which is not a test of a blocked road but
    // of walking-pace precision in a bend)
    const st = longestStraight(race);
    const L = race.field.geo.length;
    let end = (st.start + st.length) % L;
    if (end > L / 2) end -= L;
    const at = Math.max(25, Math.min(60, end - 8));
    race.addCar({ id: 'wreckL', carId: 'reef-rocket', kind: 'parked' }, trackPose(race, at, -2.6));
    race.addCar({ id: 'wreckR', carId: 'neon-wasp', kind: 'parked' }, trackPose(race, at, 2.6));
    race.ready();
    await race.run(0.6);
    race.start();
    const passed = await race.run(45, () => hero.tracker.progress > at + 20);
    return {
      passed, timeToPass: race.raceClock, contacts: race.contacts, maxImpactSpeed: race.maxImpactSpeed,
      rescues: hero.rescues, reverses: hero.driver!.stats.reverses, maxStandstill: hero.maxSlowRun, wrecksAt: at,
      log: race.log.join(' | '),
    };
  },

  /** The same two wrecks where s.blockedRoad had them first: 60 m after the
   * line, in the first bend (what a player's crash leaves). Under the 6.3 m
   * cap the way round is the 3.1 m middle gap at walking pace in a bend: the
   * rival must get through OR ask for a rescue, without ramming either. The
   * run ends at the first rescue asked (the lab would respawn it in front of
   * the wrecks again). */
  async blockedBend(race) {
    return blockedCase(race, 60, [-2.6, 2.6]);
  },

  /** The road really shut: three wrecks across the start straight at 0 and
   * ±3.4 m (gaps of 1.3 m between them, 1.85 m to the 6.3 m line for a
   * 2.1 m car). No way through inside the cap: stop without ramming and ask
   * for a rescue. */
  async blockedShut(race) {
    return blockedCase(race, null, [-3.4, 0, 3.4]);
  },

  /** A solid block the driver cannot see, 1.5 m in front of its nose. */
  async obstacle(race) {
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.6, seed: 41 }, trackPose(race, 30));
    const geo = race.field.geo;
    const at = trackPose(race, 30 + hero.tracker.halfLength + 1.5 + 0.5, -0.4);
    const block = MeshBuilder.CreateBox('labRaceBlock', { width: 2.4, height: 1.6, depth: 1 }, race.world.scene);
    block.position.set(at.x, race.world.groundHeight(at.x, at.z) + 0.6, at.z);
    block.rotationQuaternion = Quaternion.FromEulerAngles(0, at.yaw, 0);
    block.isVisible = race.env.watch;
    new PhysicsAggregate(block, PhysicsShapeType.BOX, { mass: 0, friction: 1, restitution: 0 }, race.world.scene);
    race.ready();
    await race.run(0.6);
    race.start();
    const start = hero.tracker.progress;
    const passed = await race.run(30, () => hero.tracker.progress > start + 25);
    return {
      passed, timeToPass: race.raceClock, rescues: hero.rescues, rescueLog: hero.rescueReasons.join(' '),
      reverses: hero.driver!.stats.reverses, trackLength: geo.length,
    };
  },

  /** Started 14 m off the road, pointing away from it. */
  async offRoad(race) {
    const half = race.track.halfWidth;
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.6, seed: 51 }, trackPose(race, 40, half + 10, 0.5));
    race.ready();
    await race.run(0.6);
    race.start();
    let onRoad = 0;
    const back = await race.run(25, () => {
      onRoad = Math.abs(hero.tracker.lateral) < half - 0.5 && hero.tracker.speed > 5 ? onRoad + race.dt : 0;
      return onRoad > 1.5;
    });
    return { rejoined: back, timeToRejoin: race.raceClock - 1.5, rescues: hero.rescues, rescueLog: hero.rescueReasons.join(' '), reverses: hero.driver!.stats.reverses };
  },

  /** Started on the road facing the wrong way. */
  async wrongWay(race) {
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.6, seed: 61 }, trackPose(race, 40, 0, Math.PI));
    race.ready();
    await race.run(0.6);
    race.start();
    const start = hero.tracker.progress;
    const turned = await race.run(25, () => Math.abs(hero.tracker.headingError) < 0.5 && hero.tracker.speed > 5 && hero.tracker.progress > start + 5);
    return {
      turned, timeToTurn: race.raceClock, rescues: hero.rescues, rescueLog: hero.rescueReasons.join(' '),
      turnarounds: hero.driver!.stats.turnarounds, offRoadPct: (100 * hero.offRoadTime) / Math.max(hero.raceTime, 1e-3),
    };
  },

  /**
   * On its roof. The car is HELD there for the first 2.5 s (re-posed every
   * step), because what a car left alone on its roof does is the vehicle
   * model's business (some right themselves when the wheels are driven) —
   * this checks the DRIVER: it must notice, ask for a rescue, and drive on
   * after the respawn.
   */
  async flipped(race) {
    const pose = trackPose(race, 40);
    const hero = race.addCar({ id: 'hero', carId: race.env.carId, kind: 'rival', skill: 0.6, seed: 71 }, pose);
    const mesh = hero.vehicle.chassisMesh;
    const ground = race.world.groundHeight(pose.x, pose.z);
    const roof = Quaternion.RotationYawPitchRoll(pose.yaw, 0, Math.PI);
    race.ready();
    race.start();
    let askedAt: number | null = null;
    const start = hero.tracker.progress;
    const drove = await race.run(25, () => {
      if (askedAt === null && hero.rescues > 0) askedAt = race.raceClock;
      if (askedAt === null && race.raceClock < 2.5) {
        hero.vehicle.reset(new Vector3(pose.x, ground, pose.z), pose.yaw);
        mesh.position.y = ground + 1.4;
        mesh.rotationQuaternion!.copyFrom(roof);
        mesh.computeWorldMatrix(true);
      }
      return hero.rescues > 0 && hero.tracker.progress > start + 30;
    });
    return { asked: askedAt !== null, timeToAsk: askedAt, droveOn: drove, rescues: hero.rescues, rescueLog: hero.rescueReasons.join(' ') };
  },
};

// ------------------------------------------------------------------ suite

export const race: ManeuverDef = {
  name: 'race',
  title: 'r. race: AI rivals — four-car races, player proxy with rubber band, skill spread, trouble scenarios',
  async run(env) {
    const report = new Report();
    if (env.model === 'reference') {
      // The lab's planar calibration car has no terrain contact: nothing to race.
      report.summary.skipped = 'model reference is flat-ground only';
      return report.output();
    }
    try {
      await runAll(env, report);
    } catch (err) {
      // A failing check, not a harness error: the rest of the suite (other
      // people's maneuvers) must still produce its result.
      const message = err instanceof Error ? `${err.message} ${(err.stack ?? '').split('\n').slice(0, 4).join(' <- ')}` : String(err);
      report.summary.error = message;
      report.check('race.ran', message, 'every race case runs to the end', false);
    }
    return report.output();
  },
};

async function runAll(env: LabEnv, report: Report): Promise<void> {
    const laps = Math.round(urlNumber('raceLaps', LAPS_DEFAULT));
    const seedCount = Math.round(urlNumber('raceSeeds', 8));
    const seeds = Array.from({ length: seedCount }, (_, i) => env.seed + i);
    const baseHz = Math.round(1 / env.dt);
    const rates = [...new Set([baseHz, ...urlList('raceHz').map(Math.round)])];
    const cpu: CpuTotals = { thinkMs: 0, thinkCalls: 0, stepMs: 0, carSteps: 0, setupMs: 0, setups: 0, maxPlanLateral: 0, maxPlanAt: '', maxOuterLateral: 0, maxOuterAt: '', maxOuterAny: 0, maxOuterAnyAt: '' };
    const add = (id: string, metrics: Record<string, MetricValue>) => {
      report.cases.push({ id, metrics });
      return metrics;
    };
    const n = (v: MetricValue | undefined) => (typeof v === 'number' ? v : 0);
    // Development filters: &raceOnly=race,proxy,solo,s  &raceScenario=name
    const sections = urlText('raceOnly')?.split(',') ?? null;
    const on = (name: string) => !sections || sections.includes(name);
    const onlyScenario = urlText('raceScenario');

    // --- four rivals, every seed, every rate
    for (const hz of on('race') ? rates : []) {
      const dt = hz === baseHz ? env.dt : 1 / hz;
      const tag = hz === baseHz ? 'race' : `race${hz}`;
      const runs: Array<Record<string, MetricValue>> = [];
      for (const seed of seeds) runs.push(add(`${tag}.s${seed}`, await rivalRace(env, `${tag}.s${seed}`, seed, dt, laps, cpu)));
      const finished = runs.filter((m) => m.allFinished === true).length;
      const perCar = mean(runs.map((m) => n(m.rescuesPerCar)));
      const forced = runs.reduce((sum, m) => sum + n(m.forcedRescues), 0);
      const pile = Math.max(...runs.map((m) => n(m.maxPileUp)));
      const lift = Math.max(...runs.map((m) => n(m.maxContactLift)));
      const overtakes = mean(runs.map((m) => n(m.overtakes)));
      const flips = runs.reduce((sum, m) => sum + ['r30', 'r50', 'r70', 'r90'].reduce((s, k) => s + n(m[`${k}.sideFlips`]), 0), 0);
      report.summary[`${tag}.finished`] = `${finished} / ${runs.length}`;
      report.summary[`${tag}.rescuesPerCar`] = round(perCar, 3);
      report.summary[`${tag}.forcedRescues`] = forced;
      report.summary[`${tag}.stuckTimePerCar`] = round(mean(runs.map((m) => n(m.stuckTime) / 4)), 2);
      report.summary[`${tag}.maxStandstill`] = round(Math.max(...runs.map((m) => n(m.maxStandstill))), 2);
      report.summary[`${tag}.offRoadPct`] = round(mean(runs.map((m) => n(m.offRoadPct))), 2);
      report.summary[`${tag}.contactsPerRace`] = round(mean(runs.map((m) => n(m.contacts))), 2);
      report.summary[`${tag}.maxImpactSpeed`] = round(Math.max(...runs.map((m) => n(m.maxImpactSpeed))), 2);
      report.summary[`${tag}.maxContactLift`] = round(lift, 3);
      report.summary[`${tag}.maxContactTiltDeg`] = round(Math.max(...runs.map((m) => n(m.maxContactTiltDeg))), 1);
      report.summary[`${tag}.maxPileUp`] = round(pile, 2);
      report.summary[`${tag}.overtakesPerRace`] = round(overtakes, 2);
      report.summary[`${tag}.sideFlips`] = flips;
      report.summary[`${tag}.winners`] = runs.map((m) => ['r30', 'r50', 'r70', 'r90'].find((k) => m[`${k}.position`] === 1) ?? '?').join(' ');
      report.check(`${tag}.finish`, finished, `all ${runs.length} races: every car finishes ${laps} laps`, finished === runs.length);
      report.check(`${tag}.rescues`, perCar, '<= 1 rescue per car per race on average', perCar <= 1);
      report.check(`${tag}.permanentlyStuck`, forced, '0 cars that neither move nor ask for a rescue', forced === 0);
      report.check(`${tag}.pileUp`, pile, 'no pile-up (2+ cars standing together) longer than 5 s', pile <= 5);
      report.check(`${tag}.overtakes`, overtakes, '>= 1.5 clean passes per race on average (quickest starts last)', overtakes >= 1.5);
      const rear = mean(runs.map((m) => n(m.rearEnds)));
      report.summary[`${tag}.rearEndsPerRace`] = round(rear, 2);
      report.summary[`${tag}.maxRearImpact`] = round(Math.max(...runs.map((m) => n(m.maxRearImpact))), 2);
      report.check(`${tag}.rearEnds`, rear, '<= 1 nose-to-tail hit per race on average ("lift rather than ram")', rear <= 1);
      report.check(`${tag}.weaving`, flips, '0 changes of passing side', flips === 0);
      report.check(`${tag}.contactLift`, lift, 'no car lifted > 0.5 m in a car-to-car contact', lift <= 0.5);
      // --- does skill decide, or the grid? and how clean is it?
      const ids = ['r30', 'r50', 'r70', 'r90'];
      const poleWins = runs.filter((m) => m['r30.position'] === 1).length;
      const meanPos = ids.map((k) => mean(runs.map((m) => n(m[`${k}.position`]))));
      // (a race with no lap finished has no best lap: then the check fails,
      // it does not count as 0 s)
      const noLap = runs.some((m) => ids.some((k) => typeof m[`${k}.bestLap`] !== 'number'));
      const bestLap = ids.map((k) => mean(runs.map((m) => n(m[`${k}.bestLap`]))));
      const lapEdge = (100 * (bestLap[0] - bestLap[3])) / Math.max(bestLap[3], 1e-3);
      const contacts = mean(runs.map((m) => n(m.contacts)));
      const impact = Math.max(...runs.map((m) => n(m.maxImpactSpeed)));
      const sideOff = mean(runs.map((m) => mean(ids.map((k) => n(m[`${k}.sideOffPct`])))));
      let farOff = 0;
      let worstOff = 0;
      for (const m of runs) {
        for (const k of ids) {
          const centre = n(m[`${k}.maxCentreOff`]);
          if (centre > 3) farOff++;
          worstOff = Math.max(worstOff, centre);
        }
      }
      report.summary[`${tag}.poleSitterWins`] = `${poleWins} / ${runs.length}`;
      report.summary[`${tag}.meanPosition.k30.k50.k70.k90`] = meanPos.map((v) => round(v, 2)).join(' / ');
      report.summary[`${tag}.meanBestLap.k30.k50.k70.k90`] = bestLap.map((v) => round(v, 2)).join(' / ');
      report.summary[`${tag}.bestLapEdgePct.k90overK30`] = round(lapEdge, 1);
      report.summary[`${tag}.sideOverEdgePct`] = round(sideOff, 2);
      report.summary[`${tag}.carRacesCentreOver3m`] = farOff;
      report.summary[`${tag}.worstCentreOffRoad`] = round(worstOff, 2);
      report.summary[`${tag}.fastTimePerCarRace`] = round(mean(runs.map((m) => mean(ids.map((k) => n(m[`${k}.fastTime`]))))), 2);
      report.summary[`${tag}.fastCornerTimePerCarRace`] = round(mean(runs.map((m) => mean(ids.map((k) => n(m[`${k}.fastCornerTime`]))))), 2);
      report.summary[`${tag}.letBysPerRace`] = round(mean(runs.map((m) => ids.reduce((sum, k) => sum + n(m[`${k}.letBys`]), 0))), 2);
      report.check(`${tag}.gridDecides`, `${poleWins} / ${runs.length}`, 'the slowest rival, on pole, wins at most 5 races in 8 (before the fixes: 7 in 8)', poleWins * 8 <= runs.length * 5);
      // Skill must show as pace IN TRAFFIC, not only alone: the ace's best
      // race lap against the novice's and the next-best's, and where it ends.
      const paceOk = !noLap && bestLap[3] <= 0.95 * bestLap[0] && bestLap[3] <= 1.01 * bestLap[2] && meanPos[3] < meanPos[0];
      report.check(`${tag}.paceInTraffic`, `best lap k90 ${round(bestLap[3], 2)} s = ${round(bestLap[3] / Math.max(bestLap[0], 1e-3), 3)} x k30, ${round(bestLap[3] / Math.max(bestLap[2], 1e-3), 3)} x k70; place k90 ${round(meanPos[3], 2)} vs k30 ${round(meanPos[0], 2)}`,
        'skill 0.9 rival in the race: mean best lap <= 0.95 x skill 0.3 and <= 1.01 x skill 0.7, mean place better than skill 0.3', paceOk);
      // Crawling on the racing line with nothing standing in the way.
      const crawl = mean(runs.map((m) => n(m.crawlPerRival)));
      const freeStand = Math.max(...runs.map((m) => n(m.maxFreeStandstill)));
      report.summary[`${tag}.crawlPerCar`] = round(crawl, 3);
      report.summary[`${tag}.maxCrawlPerCar`] = round(Math.max(...runs.map((m) => n(m.crawlPerRival))), 3);
      report.summary[`${tag}.maxFreeStandstill`] = round(freeStand, 2);
      report.check(`${tag}.noCrawl`, `${round(crawl, 2)} s per car per race below ${CRAWL} m/s, longest free standstill ${round(freeStand, 2)} s`,
        `racing rivals: mean time below ${CRAWL} m/s <= 0.3 s per car per race, no standstill (< ${SLOW} m/s) longer than 0.5 s that is not behind a standing car (old track: 0.4-2.2 s, 1.12 s)`,
        crawl <= 0.3 && freeStand <= 0.5);
      report.check(`${tag}.contacts`, contacts, '<= 3 car-to-car contacts per race on average (before: 4.7)', contacts <= 3);
      report.check(`${tag}.impact`, impact, 'no contact with a closing speed above 12 m/s', impact <= 12);
      report.check(`${tag}.onRoad`, sideOff, "a car's side over the road edge < 5 % of the time (before: 9.8 %)", sideOff < 5);
      report.check(`${tag}.excursions`, farOff, 'a car centre more than 3 m off the road in at most 1 car-race per 8 races', farOff * 8 <= runs.length);
    }

    // --- player stand-ins + rubber band (suite dt): two stand-ins against
    // the game's three difficulty settings (DIFFICULTY_PRESETS). Each
    // setting brings its own rubber band unless &raceBand= asks for another.
    const bandUrl = urlNumber('raceBand', 0);
    const tierRuns = new Map<string, Array<Record<string, MetricValue>>>();
    // (&raceTiers=proxyEasy,proxyQuick: development filter on the pairs)
    const tierFilter = urlText('raceTiers')?.split(',') ?? null;
    for (const tier of on('proxy') ? PROXY_TIERS : []) {
      if (tierFilter && !tierFilter.includes(tier.tag)) continue;
      const preset = presetOf(tier.preset);
      const band = bandUrl > 0 ? Math.min(bandUrl, 0.5) : preset.rubberBand;
      const proxyRuns: Array<Record<string, MetricValue>> = [];
      const noBandRuns: Array<Record<string, MetricValue>> = [];
      for (const seed of seeds) {
        proxyRuns.push(add(`${tier.tag}.s${seed}`, await proxyRace(env, `${tier.tag}.s${seed}`, seed, env.dt, laps, band, tier, cpu)));
        // (the band's effect is judged on the normal pair only)
        if (tier.tag === 'proxy') noBandRuns.push(add(`${tier.tag}NoBand.s${seed}`, await proxyRace(env, `${tier.tag}NoBand.s${seed}`, seed, env.dt, laps, 0, tier, cpu)));
      }
      const t = tier.tag;
      tierRuns.set(t, proxyRuns);
      const finished = proxyRuns.filter((m) => m.allFinished === true).length;
      const rivalRescues = mean(proxyRuns.map((m) => (n(m.rescues) - n(m['player.rescues'])) / 3));
      const maxPace = Math.max(...proxyRuns.map((m) => n(m.maxPaceAsked)));
      const behind = (runs: Array<Record<string, MetricValue>>) => mean(runs.map((m) => n(m.playerFinishTime) - n(m.winnerTime)));
      report.summary[`${t}.what`] = `${tier.title} (difficulty ${preset.difficulty}, spread ${preset.spread})`;
      report.summary[`${t}.finished`] = `${finished} / ${proxyRuns.length}`;
      report.summary[`${t}.rivalRescuesPerCar`] = round(rivalRescues, 3);
      report.summary[`${t}.playerRescues`] = proxyRuns.reduce((sum, m) => sum + n(m['player.rescues']), 0);
      report.summary[`${t}.playerPositions`] = proxyRuns.map((m) => m.playerPosition).join(' ');
      report.summary[`${t}.meanPlayerPosition`] = round(mean(proxyRuns.map((m) => n(m.playerPosition))), 2);
      report.summary[`${t}.contactsPerRace`] = round(mean(proxyRuns.map((m) => n(m.contacts))), 2);
      report.summary[`${t}.maxImpactSpeed`] = round(Math.max(...proxyRuns.map((m) => n(m.maxImpactSpeed))), 2);
      // (split by whether a car in the contact was out of control — sliding
      // > 20 deg or pointing > 25 deg off the road: information only)
      report.summary[`${t}.maxImpactSpeed.anyWild`] = round(Math.max(...proxyRuns.map((m) => n(m.maxImpactWild))), 2);
      report.summary[`${t}.maxImpactSpeed.noneWild`] = round(Math.max(...proxyRuns.map((m) => n(m.maxImpactTame))), 2);
      report.summary[`${t}.hardestBySeed`] = proxyRuns.map((m) => round(n(m.maxImpactSpeed), 1)).join(' / ');
      report.summary[`${t}.maxContactLift`] = round(Math.max(...proxyRuns.map((m) => n(m.maxContactLift))), 3);
      report.summary[`${t}.maxPileUp`] = round(Math.max(...proxyRuns.map((m) => n(m.maxPileUp))), 2);
      report.summary[`${t}.playerBehindWinner.band`] = round(behind(proxyRuns), 2);
      report.summary[`${t}.finishSpread.band`] = round(mean(proxyRuns.map((m) => n(m.finishSpread))), 2);
      report.summary[`${t}.maxPaceAsked`] = round(maxPace, 4);
      report.summary[`${t}.meanPaceAsked`] = round(mean(proxyRuns.map((m) => n(m.meanPaceAsked))), 4);
      report.summary[`${t}.band`] = band;
      report.check(`${t}.finish`, finished, `all ${proxyRuns.length} races: every car finishes`, finished === proxyRuns.length);
      report.check(`${t}.rescues`, rivalRescues, '<= 1 rescue per rival per race on average', rivalRescues <= 1);
      report.check(`${t}.bandLimit`, maxPace, 'rubber band never asks more than 8 % (default 4 %)', maxPace <= 0.0801);
      if (t === 'proxy') {
        const gapOn = mean(proxyRuns.map((m) => n(m.meanGapToPlayer)));
        const gapOff = mean(noBandRuns.map((m) => n(m.meanGapToPlayer)));
        report.summary[`${t}.playerPositions.noBand`] = noBandRuns.map((m) => m.playerPosition).join(' ');
        report.summary[`${t}.meanGapToPlayer.band`] = round(gapOn, 1);
        report.summary[`${t}.meanGapToPlayer.noBand`] = round(gapOff, 1);
        report.summary[`${t}.playerBehindWinner.noBand`] = round(behind(noBandRuns), 2);
        report.summary[`${t}.finishSpread.noBand`] = round(mean(noBandRuns.map((m) => n(m.finishSpread))), 2);
        report.check(`${t}.bandCloses`, gapOn, 'mean gap to the player with the band not above the gap without it (10 % tolerance: the effect of a 4 % band is ~3 m of ~40)', gapOn < 1.1 * gapOff);
      }
      const pile = Math.max(...proxyRuns.map((m) => n(m.maxPileUp)));
      report.check(`${t}.pileUp`, pile, 'no pile-up longer than 5 s', pile <= 5);
      report.summary[`${t}.crawlPerCar`] = round(mean(proxyRuns.map((m) => n(m.crawlPerRival))), 3);
      report.summary[`${t}.maxFreeStandstill`] = round(Math.max(...proxyRuns.map((m) => n(m.maxFreeStandstill))), 2);
      // Contacts with a player-like car that ignores the others. Hits while
      // the stand-in ITSELF was out of control (slip > 20 deg or yawing
      // faster than its grip can turn it, in the 0.5 s before) are not
      // something a rival holding its lane can avoid: counted apart, not
      // gated (a design decision of the rival work).
      const contactsIn = mean(proxyRuns.map((m) => n(m.contactsInControl)));
      const impactIn = Math.max(...proxyRuns.map((m) => n(m.maxImpactInControl)));
      const wildPer = mean(proxyRuns.map((m) => n(m.proxyWildContacts)));
      const standIn = proxyRuns.reduce((sum, m) => sum + n(m.proxyContacts), 0);
      const standInWild = proxyRuns.reduce((sum, m) => sum + n(m.proxyWildContacts), 0);
      const atFault = mean(proxyRuns.map((m) => n(m.rivalAtFault)));
      report.summary[`${t}.contacts.inControl`] = round(contactsIn, 2);
      report.summary[`${t}.contacts.outOfControl`] = round(wildPer, 2);
      report.summary[`${t}.impact.inControl`] = round(impactIn, 2);
      report.summary[`${t}.impact.outOfControl`] = round(Math.max(...proxyRuns.map((m) => n(m.maxImpactProxyWild))), 2);
      report.summary[`${t}.standInContacts`] = standIn;
      report.summary[`${t}.standInOutOfControlShare`] = standIn > 0 ? round(standInWild / standIn, 3) : 0;
      report.summary[`${t}.rivalAtFaultPerRace`] = round(atFault, 2);
      report.summary[`${t}.rivalRivalContactsPerRace`] = round(mean(proxyRuns.map((m) => n(m.rivalContacts))), 2);
      report.summary[`${t}.standInLaunchContacts`] = `${proxyRuns.reduce((sum, m) => sum + n(m.proxyLaunchContacts), 0)} of ${standIn} in the first ${LAUNCH_SPAN} s (in the gated counts)`;
      report.summary[`${t}.standInOpeningContacts`] = `${proxyRuns.reduce((sum, m) => sum + n(m.proxyOpeningContacts), 0)} of ${standIn} in the first ${OPENING_SPAN} s, hardest ${round(Math.max(...proxyRuns.map((m) => n(m.maxImpactOpening))), 2)} m/s (in the gated counts)`;
      report.summary[`${t}.rivalRivalOpeningContacts`] = proxyRuns.reduce((sum, m) => sum + n(m.rivalOpeningContacts), 0);
      report.summary[`${t}.launchMode`] = launchMode();
      report.summary[`${t}.standInAfterFlag`] = `${proxyRuns.reduce((sum, m) => sum + n(m.proxyAfterFlag), 0)} contacts after the stand-in finished, hardest ${round(Math.max(...proxyRuns.map((m) => n(m.maxImpactAfterFlag))), 2)} m/s (not in the gated counts)`;
      report.summary[`${t}.standInLaunchLiftTime`] = round(mean(proxyRuns.map((m) => n(m.launchLiftTime))), 2);
      report.summary[`${t}.firstFiveSecondContacts`] =proxyRuns.reduce((sum, m) => sum + (String(m.log ?? '').match(/t=[0-4]\.\d contact|t=[0-4]\.\d (rear|side|corner) contact/g)?.length ?? 0), 0);
      if (t === 'proxyEasy' || t === 'proxyQuick') {
        report.check(`${t}.contacts`, contactsIn, '<= 4 car-to-car contacts per race on average with the stand-in in the field (stand-in in control; its own spins are reported apart)', contactsIn <= 4);
        report.check(`${t}.impact`, impactIn, 'no contact above 10 m/s closing speed with the stand-in in the field (stand-in in control)', impactIn <= 10);
        report.check(`${t}.rivalAtFault`, atFault, '<= 1 contact per race in which the RIVAL moved toward the stand-in faster than the stand-in toward it (mean over 0.3 s, > 0.3 m/s)', atFault <= 1);
      }
    }
    // The difficulty settings must mean something: judged on finishing places
    // of the two stand-ins (DIFFICULTY_PRESETS).
    if (on('proxy')) {
      // (with &raceTiers= only the place summaries: the gates need every pair)
      const gate = (id: string, value: MetricValue, target: string, pass: boolean) => {
        if (!tierFilter) report.check(id, value, target, pass);
      };
      const places = (tag: string) => (tierRuns.get(tag) ?? []).map((m) => n(m.playerPosition));
      const count = (list: number[], f: (v: number) => boolean) => list.filter(f).length;
      const easyCareful = places('proxyEasy');
      const normalCareful = places('proxy');
      const normalQuick = places('proxyQuick');
      const hardQuick = places('proxyQuickHard');
      for (const tier of PROXY_TIERS) {
        const list = places(tier.tag);
        report.summary[`difficulty.${tier.preset}.${tier.driver === QUICK ? 'quick' : 'careful'}`] =
          `wins ${count(list, (v) => v === 1)}, top two ${count(list, (v) => v <= 2)}, last ${count(list, (v) => v >= 4)} of ${list.length}; places ${list.join(' ')}`;
      }
      const top2 = count(easyCareful, (v) => v <= 2);
      gate('difficulty.easy', `careful stand-in top two in ${top2} / ${easyCareful.length}`, 'easy: the careful stand-in finishes in the top two in at least half its races', top2 * 2 >= easyCareful.length && easyCareful.length > 0);
      gate('proxyEasy.inTheRace', `${count(easyCareful, (v) => v < 4)} / ${easyCareful.length}`, 'easy field: the careful player is not last in at least half the races', count(easyCareful, (v) => v < 4) * 2 >= easyCareful.length);
      const qWins = count(normalQuick, (v) => v === 1);
      const cNotLast = count(normalCareful, (v) => v < 4);
      gate('difficulty.normal', `quick stand-in wins ${qWins} / ${normalQuick.length}, careful not last ${cNotLast} / ${normalCareful.length}`,
        'normal: the quick stand-in wins more than half its races; the careful one is not last in at least half', qWins * 2 > normalQuick.length && cNotLast * 2 >= normalCareful.length);
      const qBeaten = count(normalQuick, (v) => v > 1);
      gate('proxyQuick.aRace', `${qBeaten} / ${normalQuick.length}`, 'normal: a rival finishes ahead of the quick stand-in in at least 1 race (brief: on at least three of the four cars)', qBeaten >= 1);
      const hBeaten = count(hardQuick, (v) => v > 1);
      gate('difficulty.hard', `a rival beats the quick stand-in in ${hBeaten} / ${hardQuick.length}`, 'hard: a rival beats the quick stand-in in at least 2 races of 8', hBeaten * 4 >= hardQuick.length && hardQuick.length > 0);
    }

    // --- lap time by skill, one rival alone in the suite's car
    if (on('solo')) {
      const skills = [0.3, 0.6, 0.9];
      const laptime: number[][] = skills.map(() => []);
      let rescues = 0;
      let off = 0;
      let sideOff = 0;
      let maxOver = 0;
      let count = 0;
      let ordered = 0;
      for (const seed of seeds) {
        const row: number[] = [];
        for (let k = 0; k < skills.length; k++) {
          const soloId = `solo.k${Math.round(skills[k] * 100)}.s${seed}`;
          const m = add(soloId, await soloLaps(env, soloId, seed, env.dt, laps, skills[k], cpu));
          const lap = typeof m.flyingLap === 'number' ? m.flyingLap : NaN;
          row.push(lap);
          laptime[k].push(lap);
          rescues += n(m.rescues);
          off += n(m.offRoadPct);
          sideOff += n(m.sideOffPct);
          maxOver = Math.max(maxOver, n(m.maxOverEdge));
          count++;
        }
        if (row[0] > row[1] && row[1] > row[2]) ordered++;
      }
      const means = laptime.map((list) => mean(list.filter((v) => Number.isFinite(v))));
      const step1 = (100 * (means[0] - means[1])) / means[1];
      const step2 = (100 * (means[1] - means[2])) / means[2];
      report.summary['solo.flyingLap.k30'] = round(means[0], 2);
      report.summary['solo.flyingLap.k60'] = round(means[1], 2);
      report.summary['solo.flyingLap.k90'] = round(means[2], 2);
      report.summary['solo.stepPct.30to60'] = round(step1, 1);
      report.summary['solo.stepPct.60to90'] = round(step2, 1);
      report.summary['solo.orderedSeeds'] = `${ordered} / ${seeds.length}`;
      report.summary['solo.rescues'] = rescues;
      report.summary['solo.offRoadPct'] = round(off / Math.max(count, 1), 2);
      report.summary['solo.sideOverEdgePct'] = round(sideOff / Math.max(count, 1), 2);
      report.summary['solo.maxOverEdge'] = round(maxOver, 2);
      report.check('solo.skillOrder', `${round(means[0], 2)} / ${round(means[1], 2)} / ${round(means[2], 2)}`,
        'flying lap skill 0.3 > 0.6 > 0.9, each step >= 3 %, ordered on every seed',
        step1 >= 3 && step2 >= 3 && ordered === seeds.length);
      report.check('solo.rescues', rescues, '0 rescues with nobody else on the track', rescues === 0);
      report.check('solo.onRoad', off / Math.max(count, 1), 'car centre off the road < 2 % of the time', off / Math.max(count, 1) < 2);
    }

    // --- duels: a quicker rival behind a slower one, same car (suite dt)
    if (on('duel')) {
      for (const [lead, chase] of [[0.3, 0.9], [0.5, 0.8], [0.6, 0.6]]) {
        const tag = `duel.k${Math.round(lead * 100)}k${Math.round(chase * 100)}`;
        const runs: Array<Record<string, MetricValue>> = [];
        for (const seed of seeds.slice(0, 6)) runs.push(add(`${tag}.s${seed}`, await duel(env, `${tag}.s${seed}`, seed, env.dt, lead, chase, cpu)));
        const done = runs.filter((m) => m.passed === true);
        report.summary[`${tag}.passed`] = `${done.length} / ${runs.length}`;
        report.summary[`${tag}.meanLapsToPass`] = done.length ? round(mean(done.map((m) => n(m.lapsToPass))), 2) : null;
        report.summary[`${tag}.meanSecondsBehind`] = round(mean(runs.map((m) => n(m.secondsStuckBehind))), 2);
        report.summary[`${tag}.contactsPerDuel`] = round(mean(runs.map((m) => n(m.contacts))), 2);
        report.summary[`${tag}.maxImpactSpeed`] = round(Math.max(...runs.map((m) => n(m.maxImpactSpeed))), 2);
        report.summary[`${tag}.rescues`] = runs.reduce((sum, m) => sum + n(m.rescues), 0);
        const contacts = mean(runs.map((m) => n(m.contacts)));
        if (lead === 0.3 && chase === 0.9) {
          report.check(`${tag}.getsBy`, `${done.length} / ${runs.length}`, `a much quicker rival behind a slow one is past within ${DUEL_LAPS} laps in at least half the duels (before the fixes: 2 of 12)`, done.length * 2 >= runs.length);
        }
        if (lead === 0.5 && chase === 0.8) {
          // (baseline before the race gates, seeds 1-6 x four cars: 24 of
          // 24 past, means 0.92-1.01 laps, slowest 1.50; an earlier version read 1.3-1.7
          // laps and 4 of 6 on comet-fox, ungated)
          const slowest = Math.max(...runs.map((m) => (m.passed === true ? n(m.lapsToPass) : Infinity)));
          report.check(`${tag}.getsBy`, `${done.length} / ${runs.length}, slowest ${Number.isFinite(slowest) ? round(slowest, 2) : 'never'} laps`,
            'a quicker rival (skill 0.8) behind a slower one (0.5), same car: past in every duel, each within 1.6 laps (baseline: slowest 1.50)', done.length === runs.length && slowest <= 1.6);
        }
        if (lead === chase) {
          report.check(`${tag}.noSquabble`, contacts, 'two equal rivals nose to tail: at most 1 contact per duel on average', contacts <= 1);
        } else {
          report.check(`${tag}.clean`, contacts, 'at most 1.5 contacts per duel on average', contacts <= 1.5);
        }
      }
    }

    // --- knocked off line at speed (suite dt): does the driver gather it up?
    if (on('knock')) {
      const runs: Array<Record<string, MetricValue>> = [];
      for (const skill of [0.3, 0.6, 0.9]) {
        for (const [speed, offset, yaw] of [[14, 1.2, 12], [20, 1.2, 9], [20, -1.4, -11], [24, 1, 7]]) {
          const id = `knock.k${Math.round(skill * 100)}.v${speed}.y${yaw}`;
          runs.push(add(id, await withRace(env, id, env.seed, env.dt, { laps: 99 }, cpu, (race) => knocked(race, skill, speed, offset, yaw))));
        }
      }
      const settled = runs.filter((m) => typeof m.settleTime === 'number');
      const swings = Math.max(...runs.map((m) => n(m.swings)));
      const over = Math.max(...runs.map((m) => n(m.maxOverEdge)));
      report.summary['knock.settled'] = `${settled.length} / ${runs.length}`;
      report.summary['knock.meanSettleTime'] = settled.length ? round(mean(settled.map((m) => n(m.settleTime))), 2) : null;
      report.summary['knock.worstSettleTime'] = settled.length ? round(Math.max(...settled.map((m) => n(m.settleTime))), 2) : null;
      report.summary['knock.maxSwings'] = swings;
      report.summary['knock.maxOverEdge'] = round(over, 2);
      report.check('knock.settles', `${settled.length} / ${runs.length}`, 'knocked 1-1.4 m off line and 7-12 deg askew (nose pointing further off) at 14-24 m/s: back on line within 5 s, every case', settled.length === runs.length);
      report.check('knock.noWeave', swings, 'at most 3 swings across the line while gathering it up (measured: novice 3, others 0-1)', swings <= 3);
      // (on the old 7 m road the side WILL cross the edge, limit 2.1 m; on the
      // 10 m road it never reached it: worst -0.06 m in the baseline, -0.01 /
      // -0.02 m over 72 files later — limit re-derived: 0.5 m)
      report.check('knock.onRoad', over, "the car's side at most 0.5 m over the road edge (10 m road, measured: never reaches it, worst -0.02 m)", over <= 0.5);
    }

    // --- scenarios (suite seed, suite dt)
    for (const [name, scenario] of on('s') ? Object.entries(SCENARIOS) : []) {
      if (onlyScenario && name !== onlyScenario) continue;
      const m = add(`s.${name}`, await withRace(env, `s.${name}`, env.seed, env.dt, { laps: 99 }, cpu, scenario));
      for (const [key, value] of Object.entries(m)) {
        if (key !== 'log' && key !== 'trace' && key !== 'lineProfile' && key !== 'seed' && key !== 'hz') report.summary[`s.${name}.${key}`] = value;
      }
      if (name === 'wrongWay') {
        // Turning round must not depend on the frame rate: the same case at
        // 30 and 120 Hz as well.
        const times = [n(m.timeToTurn)];
        for (const hz of [30, 120]) {
          if (hz === baseHz) continue;
          const id = `s.wrongWay.hz${hz}`;
          const mm = add(id, await withRace(env, id, env.seed, 1 / hz, { laps: 99 }, cpu, scenario));
          report.summary[`s.wrongWay.hz${hz}.timeToTurn`] = mm.timeToTurn;
          times.push(mm.turned === true ? n(mm.timeToTurn) : Infinity);
        }
        const spread = Math.max(...times) - Math.min(...times);
        report.summary['s.wrongWay.rateSpread'] = Number.isFinite(spread) ? round(spread, 2) : null;
        report.check('race.wrongWayRates', `${times.map((v) => (Number.isFinite(v) ? v.toFixed(2) : 'never')).join(' / ')} s at ${[baseHz, 30, 120].filter((h, i, a) => a.indexOf(h) === i).join(' / ')} Hz`,
          'facing backward: time to turn round and race within 2 s between 30 and 120 Hz', Number.isFinite(spread) && spread <= 2);
      }
    }
    if (on('s') && (!onlyScenario || onlyScenario === 'fastBehind')) {
      // Closers: the tidy lab closer on the centreline and 1.5 m to either
      // side, and the proxy races' quick stand-in on the centreline.
      const VARIANTS: Array<[number, number, FastCloser]> = [
        [0.3, 8, { line: 0, style: 'tidy' }],
        [0.5, 8, { line: 1.5, style: 'tidy' }],
        [0.7, 8, { line: -1.5, style: 'tidy' }],
        [0.9, 8, { line: 0, style: 'tidy' }],
        [0.6, 10, { line: 1.5, style: 'tidy' }],
        [0.6, 10, { line: -1.5, style: 'tidy' }],
        [0.6, 8, { line: 0, style: 'quick' }],
      ];
      const runs: Array<Record<string, MetricValue>> = [];
      const follows: Array<Record<string, MetricValue>> = [];
      const lineTag = (v: number) => (v === 0 ? 'l0' : v > 0 ? `r${v}` : `l${-v}`);
      for (const where of ['straight', 'corner'] as const) {
        for (const [skill, closing, how] of VARIANTS) {
          const id = `s.fastBehind.${where}.k${Math.round(skill * 100)}.c${closing}.${how.style}.${lineTag(how.line)}`;
          runs.push(add(id, await withRace(env, id, env.seed, env.dt, { laps: 99 }, cpu, (race) => fastBehind(race, where, skill, closing, how))));
        }
        const fid = `s.fastBehind.${where}.follow`;
        follows.push(add(fid, await withRace(env, fid, env.seed, env.dt, { laps: 99 }, cpu, (race) => fastBehind(race, where, 0.6, 8, { line: 0, style: 'tidy', follow: true }))));
      }
      const touched = runs.filter((m) => n(m.contacts) > 0).length;
      const impact = Math.max(...runs.map((m) => n(m.maxImpactSpeed)));
      const rescues = runs.reduce((sum, m) => sum + n(m.rescues), 0);
      const unmet = runs.filter((m) => m.passed !== true).length;
      const quick = runs.filter((m) => m.closer === 'quick');
      const corner = runs.filter((m) => m.where === 'corner');
      const ratio = (list: Array<Record<string, MetricValue>>) => Math.min(...list.map((m) => n(m.heroMinPlanRatio)));
      const worst = (list: Array<Record<string, MetricValue>>, key: string) => Math.max(...list.map((m) => n(m[key])));
      report.summary['s.fastBehind.touched'] = `${touched} / ${runs.length}`;
      report.summary['s.fastBehind.passed'] = `${runs.length - unmet} / ${runs.length}`;
      report.summary['s.fastBehind.maxImpactSpeed'] = round(impact, 2);
      report.summary['s.fastBehind.quick.touched'] = `${quick.filter((m) => n(m.contacts) > 0).length} / ${quick.length}`;
      report.summary['s.fastBehind.quick.maxImpactSpeed'] = round(Math.max(...quick.map((m) => n(m.maxImpactSpeed))), 2);
      report.summary['s.fastBehind.heroMinPlanRatio'] = round(ratio(runs), 3);
      report.summary['s.fastBehind.corner.heroMinPlanRatio'] = round(ratio(corner), 3);
      report.summary['s.fastBehind.maxHeroOffLine'] = round(worst(runs, 'heroMaxOffLine'), 2);
      report.summary['s.fastBehind.maxHeroOffLineTime'] = round(worst(runs, 'heroOffLineTime'), 2);
      report.summary['s.fastBehind.corner.maxHeroOffLineTime'] = round(worst(corner, 'heroOffLineTime'), 2);
      report.summary['s.fastBehind.closerMaxOffLine'] = round(worst(runs, 'closerMaxOffLine'), 2);
      report.summary['s.fastBehind.maxHeroFastTime'] = round(worst(runs, 'heroFastTime'), 2);
      report.summary['s.fastBehind.corner.maxHeroFastCornerTime'] = round(worst(corner, 'heroFastCornerTime'), 2);
      report.summary['s.fastBehind.swaps'] = runs.filter((m) => n(m.heroFastSwaps) > 0).length;
      report.summary['s.fastBehind.metInBend'] = `${runs.filter((m) => m.where === 'straight' && typeof m.metRadius === 'number' && m.metRadius < 60).length} of ${runs.length - corner.length} straight runs met the closer in a bend under 60 m radius`;
      const followArmed = follows.every((m) => n(m.heroFastBeforeFollow) > 0.2);
      const followFast = Math.max(...follows.map((m) => n(m.heroFastWhileFollowing)));
      report.summary['s.fastBehind.follow.heroFastBeforeFollow'] = follows.map((m) => round(n(m.heroFastBeforeFollow), 2)).join(' / ');
      report.summary['s.fastBehind.follow.heroFastAfterFollow'] = follows.map((m) => round(n(m.heroFastAfterFollow), 2)).join(' / ');
      report.summary['s.fastBehind.follow.heroFastWhileFollowing'] = follows.map((m) => round(n(m.heroFastWhileFollowing), 2)).join(' / ');
      report.summary['s.fastBehind.follow.contacts'] = follows.map((m) => n(m.contacts)).join(' / ');
      report.check('s.fastBehind', `${touched} of ${runs.length} runs with a contact, hardest ${round(impact, 2)} m/s; ${unmet} runs where it never got by`,
        'a car closing at 8-10 m/s from 30 m behind (ignores the rival; tidy closer on the centreline and 1.5 m either side, the quick stand-in on the centreline), met on the start straight and at the turn-in of the tightest bend: every run ends with the closer past (by arc, > 1 s in), a contact in at most 1 run in 10, never one above 4 m/s, no rescue',
        unmet === 0 && touched * 10 <= runs.length && impact <= 4 && rescues === 0);
      // (regression gates: no baseline exists for these — the scenario is new;
      // limits = worst over 16 files (4 cars x seeds 1, 17,
      // 41, 59 at 60 Hz: 6.70 s, 0.64) with a margin)
      const offCorner = worst(corner, 'heroOffLineTime');
      const cornerRatio = ratio(corner);
      const cornerActs = corner.some((m) => n(m.heroFastCornerTime) > 0.5);
      // (whether the corner branch acts depends on the seed: on tracks whose
      // tightest bend does not slow the 60 %-pace plan by 2 % it cannot —
      // seeds 53 and 59 — so that is reported, not gated)
      report.summary['s.fastBehind.corner.ruleActed'] = `${corner.filter((m) => n(m.heroFastCornerTime) > 0.5).length} / ${corner.length}`;
      report.check('s.fastBehind.corner', `${round(offCorner, 2)} s off its line at most, speed down to ${round(cornerRatio, 3)} x its plan, corner rule ${cornerActs ? 'acted' : 'never acted'}`,
        'into the tightest bend with a much faster car behind: the rival is off its own line by more than 1 m for at most 8 s (rule holds it at most 5 s: fastHoldMax), never below 0.55 x its planned speed',
        offCorner <= 8 && cornerRatio >= 0.55);
      report.check('s.fastBehind.follow', `${round(followFast, 2)} s out of the way while it only followed; armed before: ${followArmed}`,
        'a car that closes fast from 30 m (the rule arms) and then only FOLLOWS at the rival\'s starting speed: the rival keeps out of its way for at most 1.5 s while it is not gaining along the road (fastLetGo 1 s)',
        followArmed && followFast <= 1.5);
    }
    if (on('s') && (!onlyScenario || onlyScenario === 'driftAhead')) {
      // A car holding a 25-35 deg drift through a bend ahead of a rival.
      const runs: Array<Record<string, MetricValue>> = [];
      for (const slip of [25, 35]) {
        const id = `s.driftAhead.slip${slip}`;
        runs.push(add(id, await withRace(env, id, env.seed, env.dt, { laps: 99 }, cpu, (race) => driftAhead(race, slip))));
      }
      const touched = runs.filter((m) => n(m.contacts) > 0).length;
      // (the rival starts 10 m behind — within the rule's 12 m on every
      // seed — so the rule must act in every run)
      const fired = Math.min(...runs.map((m) => n(m.heroWildTime)));
      // (the gap between the two FOOTPRINTS, beside or behind: the bumper gap
      // along the road read 0.3 m — or negative — for a rival 3.6 m to the
      // inside of the drifter with a metre of daylight between them)
      const gap = Math.min(...runs.map((m) => (typeof m.minClearanceWhileDrifting === 'number' ? m.minClearanceWhileDrifting : -1)));
      report.summary['s.driftAhead.minBumperGapAlongRoad'] = round(Math.min(...runs.map((m) => n(m.minBumperGapWhileDrifting))), 2);
      report.summary['s.driftAhead.heroWildTime'] = runs.map((m) => round(n(m.heroWildTime), 2)).join(' / ');
      report.summary['s.driftAhead.minClearance'] = round(gap, 2);
      report.check('s.driftAhead', `${touched} of ${runs.length} runs with a contact; out-of-control rule acted ${runs.map((m) => round(n(m.heroWildTime), 2)).join(' / ')} s; closest ${round(gap, 2)} m`,
        `a stand-in holding a 25 / 35 deg drift through the tightest bend ahead of a rival (at 95 % of the rival's plan, the rival 10 m behind): the rival drops back (its out-of-control rule acts for >= ${DRIFT_RULE_TIME} s in every run; never closer than ${DRIFT_CLEAR} m between the two footprints while it drifts), no contact`,
        touched === 0 && fired >= DRIFT_RULE_TIME && gap >= DRIFT_CLEAR && runs.every((m) => n(m.rescues) === 0));
    }
    const NONE: Record<string, MetricValue> = {};
    const s = (name: string) => report.cases.find((c) => c.id === `s.${name}`)?.metrics ?? NONE;
    const check = report.check.bind(report);
    // (a scenario that was filtered out is not judged)
    report.check = (id, value, target, pass) => {
      if (id.startsWith('s.') && s(id.slice(2)) === NONE) return;
      check(id, value, target, pass);
    };
    report.check('s.parked', `${s('parked').timeToPass} s, ${s('parked').contacts} contacts`, 'parked car on the line: passed without touching it',
      s('parked').passed === true && s('parked').contacts === 0 && s('parked').rescues === 0);
    report.check('s.slowCar', `${s('slowCar').timeToPass} s, ${s('slowCar').contacts} contacts`, 'slower car ahead: passed within 60 s, no contact, no change of side',
      s('slowCar').passed === true && s('slowCar').contacts === 0 && s('slowCar').sideFlips === 0);
    report.check('s.sideBySide', `${s('sideBySide').contacts} contacts, ${s('sideBySide').secondsAlongside} s alongside`, 'two equal cars side by side for a lap: no impact above 3 m/s, nobody rescued',
      s('sideBySide').lapDone === true && n(s('sideBySide').maxImpactSpeed) <= 3 && s('sideBySide').rescues === 0);
    report.check('s.blockedRoad', `${s('blockedRoad').timeToPass} s, impact ${s('blockedRoad').maxImpactSpeed} m/s`, 'two wrecks at +-2.6 m on the start straight (a 3.1 m gap in the middle, none to the 6.3 m line): no ramming (< 2 m/s), gets through within 45 s without a rescue',
      s('blockedRoad').passed === true && n(s('blockedRoad').maxImpactSpeed) < 2 && s('blockedRoad').rescues === 0);
    {
      const b = s('blockedBend');
      report.check('s.blockedBend', `${b.passed === true ? `through in ${b.timeToPass} s` : b.rescueAsked === true ? `rescue asked at ${b.timeToRescue} s` : 'neither in 45 s'}, impact ${b.maxImpactSpeed} m/s`,
        `the same two wrecks in the first bend (60 m): no ramming (< 2 m/s), and through or a rescue asked for within ${BLOCKED_ASK} s`,
        n(b.maxImpactSpeed) < 2 && (b.passed === true || (b.rescueAsked === true && n(b.timeToRescue) <= BLOCKED_ASK)));
      const c = s('blockedShut');
      report.check('s.blockedShut', `${c.passed === true ? `through in ${c.timeToPass} s (?)` : c.rescueAsked === true ? `rescue asked at ${c.timeToRescue} s` : 'no rescue in 45 s'}, impact ${c.maxImpactSpeed} m/s`,
        `three wrecks across the start straight (no gap inside the 6.3 m line): no ramming (< 2 m/s), rescue asked for within ${BLOCKED_ASK} s`,
        n(c.maxImpactSpeed) < 2 && c.passed !== true && c.rescueAsked === true && n(c.timeToRescue) <= BLOCKED_ASK);
    }
    report.check('s.obstacle', `${s('obstacle').timeToPass} s, ${s('obstacle').reverses} reverses`, 'unseen block on the road: backs out and gets round within 30 s without a rescue',
      s('obstacle').passed === true && s('obstacle').rescues === 0);
    report.check('s.offRoad', s('offRoad').timeToRejoin, 'started 10 m off the road: back on it within 12 s without a rescue',
      s('offRoad').rejoined === true && n(s('offRoad').timeToRejoin) < 12 && s('offRoad').rescues === 0);
    report.check('s.wrongWay', s('wrongWay').timeToTurn, 'facing backward: turned round and racing within 12 s without a rescue',
      s('wrongWay').turned === true && n(s('wrongWay').timeToTurn) < 12 && s('wrongWay').rescues === 0);
    report.check('s.flipped', s('flipped').timeToAsk, 'on its roof: asks for a rescue within 3 s, then drives on',
      s('flipped').asked === true && n(s('flipped').timeToAsk) < 3 && s('flipped').droveOn === true);

    report.check = check;

    // --- fences: the game's stand 7.3 m from the centreline
    if (cpu.maxPlanAt !== '') {
      report.summary['race.maxPlanLateral'] = round(cpu.maxPlanLateral, 2);
      report.summary['race.maxPlanLateralCase'] = cpu.maxPlanAt;
      report.summary['race.maxOuterLateral'] = round(cpu.maxOuterLateral, 2);
      report.summary['race.maxOuterLateralCase'] = cpu.maxOuterAt;
      report.summary['race.maxOuterLateral.withContacts'] = round(cpu.maxOuterAny, 2);
      report.summary['race.maxOuterLateral.withContactsCase'] = cpu.maxOuterAnyAt;
      // (the planned figure is held under the cap by construction — the lane
      // limit contains maxLateral; what can fail is where the car really
      // went: its outer wheels, outside 2 s after a contact or a rescue,
      // pointing along the road — gated at the FENCE line: a novice rival's
      // designed mistakes — mistakeRate — run it wide by up to 0.9 m past
      // the 6.3 m plan cap, 7.13 m at most in the stand-in races of fix
      // round 1)
      report.check('race.maxLateral', `planned outer wheels ${round(cpu.maxPlanLateral, 2)} m from the centreline at most (${cpu.maxPlanAt}); driven ${round(cpu.maxOuterLateral, 2)} m (${cpu.maxOuterAt}); with contacts ${round(cpu.maxOuterAny, 2)} m`,
        `every rival, every case of this file (blocked road included): the path it plans never puts its outer wheels further than ${MAX_PLAN_LATERAL} m from the centreline, and where it really drives (pointing along the road, outside 2 s after a contact or a rescue) they never reach the fence line at ${FENCE_LATERAL} m`,
        cpu.maxPlanLateral <= MAX_PLAN_LATERAL + 1e-6 && cpu.maxOuterLateral < FENCE_LATERAL);
    }

    // --- CPU (wall clock: NOT reproducible to the digit, by nature)
    const thinkUs = cpu.thinkCalls > 0 ? (1000 * cpu.thinkMs) / cpu.thinkCalls : 0;
    const stepUs = cpu.carSteps > 0 ? (1000 * cpu.stepMs) / cpu.carSteps : 0;
    report.summary['cpu.rivalMicrosPerFrame'] = round(thinkUs, 2);
    report.summary['cpu.rivalSetupMs'] = cpu.setups > 0 ? round(cpu.setupMs / cpu.setups, 2) : null;
    report.summary['cpu.vehicleStepMicrosPerCarFrame'] = round(stepUs, 2);
    report.summary['cpu.rivalShareOfVehicleStepPct'] = stepUs > 0 ? round((100 * thinkUs) / stepUs, 1) : null;
    // (judged only on a long headless run: the browser clock is coarse, and
    // watch mode spends its time rendering)
    if (cpu.carSteps > 50000 && !env.watch) {
      report.check('cpu.rival', round(thinkUs, 2), 'rival driver < 20 % of the vehicle + physics step per car', stepUs > 0 && thinkUs < 0.2 * stepUs);
    }
}
