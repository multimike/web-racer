import {
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeConvexHull,
  PhysicsShapeCylinder,
  Quaternion,
  ShapeCastResult,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import type { HavokPlugin, Observer, PhysicsEngineV2 } from '@babylonjs/core';
import type { IPhysicsShapeCastQuery } from '@babylonjs/core/Physics/physicsShapeCastQuery';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import type { TuningParam, Vehicle, WheelGroundState } from './Vehicle';
import type { VehicleRig } from './rig';
import { VehicleVisual } from './visual';
import type { DriverParams } from './DriverModel';
import { DEFAULT_RAYCAST_TUNING, RAYCAST_DRIVER_HINTS, RAYCAST_TUNING_PARAMS } from './raycast/tuning';
import type { RaycastTuning } from './raycast/tuning';

export type { RaycastTuning } from './raycast/tuning';
export { DEFAULT_RAYCAST_TUNING } from './raycast/tuning';

/**
 * RAYCAST vehicle model — one rigid body, four "virtual" wheels.
 *
 * WHAT IS SIMULATED (physics)
 *  - Chassis: ONE Havok dynamic body carrying the whole car's mass (sprung +
 *    wheels), CoM and inertia from the VehicleRig. Its collider is a convex
 *    hull around tub, roll cage and the upper part of the four tires, so
 *    walls, boulders and the ground (when bottoming out or upside down) are
 *    handled by Havok. It never touches the ground in normal driving.
 *    Between 0.45 and 0.8 m above the ground the hull is a BUMPER BAND with
 *    vertical faces all round, at the same height on every car: two cars
 *    always meet face to face (no nose that wedges under the other car).
 *  - Wheels: not bodies. Each frame a tire-sized CYLINDER is shape-cast down
 *    the suspension axis (so kerbs, ramp lips and boulders are rolled over
 *    like a wheel would, not stepped onto like a ray would). The cast gives
 *    the suspension compression and the contact normal. It starts above the
 *    bump stop (an obstacle taller than the suspension can swallow counts as
 *    "fully compressed" = the capped suspension force, instead of swallowing
 *    the cast) and never takes another car for ground.
 *  - Suspension: spring + digressive/position-sensitive damper + bump stop +
 *    anti-roll bars; the resulting wheel load acts along the contact normal
 *    at the contact patch.
 *  - Tires: explicit forces from a transient (relaxation-length) brush model
 *    with combined slip: a 2D tread deflection per wheel follows the contact
 *    slip velocity; force = μ·N·f(|deflection|) with a Magic-Formula shaped
 *    f that peaks at a wide slip angle and falls off mildly. At standstill
 *    the deflection is a plain spring, so the car is held on a slope by real
 *    static friction instead of creeping. Longitudinal and lateral share one
 *    friction circle: wheelspin and lockup cost side grip (power oversteer,
 *    locked-wheel plowing) with no extra rules. Load sensitivity makes
 *    lateral load transfer cost grip.
 *  - Wheel spin: each wheel has inertia (plus reflected driveline inertia on
 *    the driven axle), drive torque (flat, then a falling electric-motor
 *    line, rev limiter), brake / engine-brake / rolling friction torques and
 *    a limited-slip coupling across the driven axle; integrated implicitly
 *    in the tire stiffness so it is stable at any slip.
 *
 * WHAT IS FAKE (assists — every one is bounded and has an OFF value in
 * raycast/tuning.ts, where each is explained)
 *   slideYawDamping     yaw governor while the REAR AXLE slides ("gyro"):
 *                       slides open at a pace a human can react to and
 *                       linger on the throttle
 *   slideCloseRate …    THE CLOSING-SPEED LIMIT: how fast a slide may close
 *                       depends on what the driver does with it — slowly
 *                       while he holds it, progressively when he lets go of
 *                       a drift (the rear tires give up grip while it
 *                       closes: slideCloseGrip), at once when nobody was
 *                       holding it, fast with opposite lock; tapering to
 *                       nothing at zero slip so it does not swing through
 *   counterSteerAssist  slide steering: while the rear slides the stick sets
 *                       the FRONT SLIP ANGLE (into the turn = feed the slide,
 *                       centred = wheels follow it, against = a countersteer
 *                       that is unwound as the slide closes) instead of a
 *                       wheel angle
 *   powerSlideLoss      a rear tire past its peak slip angle gives up grip in
 *                       proportion to the throttle — up to a slip angle the
 *                       STICK sets (powerSlideMinAngle … MaxAngle): every
 *                       stick position has its own stable slide angle
 *   powerOver           per-car trait: the rear lets go early when the
 *                       front is already pushing and the foot is flat
 *   catchLatch          opposite lock that caught a deep slide keeps the
 *                       throttle from loosening the rear until the stick has
 *                       been centred: the slide cannot flip into a drift the
 *                       other way — except out of a drift the driver was
 *                       holding (catchLinkHeld) or after a brake tap on a
 *                       hooked-up car (catchBrakeForget): linked drifts
 *   slideScrub          a held drift scrubs speed (stays on a medium bend)
 *   assistLevel         one 0..1 knob scaling slide steering + yaw governor
 *   classicDrift        0 = stick-led ("gyro") drift, 1 = throttle-led
 *   wheelspinLimit      drive torque fades past a throttle-proportional slip
 *   wheelspinGripLoss   a spinning AND sliding driven tire loses total grip
 *   tireForceHeight     side forces applied above the patch (less roll)
 *   airDamping          pitch/roll rates decay while airborne
 *   airLevel            in flight the car is turned wheels-down
 *   airYawDamping       a spin decays while the wheels are off the ground
 *                       (all three fade in as the wheels leave: airPartial)
 *   tipGuard*           as the car leans on its tires their side force is
 *                       applied higher, up to CoM height: it slides instead
 *                       of tripping over a kerb, a rock or its own grip
 *   selfRight*          a car lying on its side or roof rolls itself back
 *   unstickAccel        a car high-centred on a rock (no driven wheel on
 *                       the ground) is pushed off it by the pedal held
 *   impactInertiaScale  Havok is told a larger rotational inertia: an
 *                       off-centre hull hit spins / tips the car less
 *   abs, parkBrake      anti-lock brakes; parking brake at rest
 *
 * PEDALS: throttle commands TORQUE. The brake trigger is a brake whenever
 * the car is moving (any direction), reverse when pressed at standstill, and
 * turns into reverse when HELD at standstill on level ground — after
 * autoReverseDelay if the press began on a crawling car, after the clearly
 * longer autoReverseDelayFromSpeed if it stopped the car from speed (a
 * panic stop), and then easing in over autoReverseRamp; on a slope it keeps
 * holding the car. A brake that is down
 * when the car is respawned only brakes until it has been released once.
 *   obstacleDrag        softens the fore-aft punch of kerb faces / ripples
 *
 * HOW IT IS INTEGRATED (frame-rate independence)
 *  The force model runs at its own fixed rate (`substepHz`, 360 Hz: 6
 *  sub-steps at 60 Hz, 5 at 72, 4 at 90, 3 at 120, 12 at 30). Inside
 *  update() the chassis velocity, a copy of the chassis orientation, the
 *  suspension travel, the tread deflections and the wheel spins are advanced
 *  through those sub-steps against the contact planes found by the casts;
 *  the resulting velocity is handed to Havok, which integrates the pose and
 *  resolves hull collisions. Gravity for this body is applied here too (its
 *  Havok gravity factor is 0) so the sub-steps see it. Things decided once
 *  per frame (steering, the casts) are compensated for the frame length
 *  where it matters (see counterSteerLag).
 *
 * Conventions: see Vehicle.ts (yaw 0 = +z, positive yaw/steer = right,
 * wheel order FL FR RL RR). Vector algebra is done on plain numbers — there
 * are no allocations in update().
 */

const NONE = 0;
const BRAKE = 1;
const REVERSE = 2;

/** Extra cast distance above the bump stop (bump-stop spring works here). */
const STOP_MARGIN = 0.1;
/** Extra cast distance below full droop: sees the ground coming so a
 * landing that happens inside a frame is caught by the sub-steps. */
const LOOKAHEAD = 0.45;
/** Contact normals leaning more than acos(MIN_CONTACT_UP) away from the
 * suspension axis are walls, not ground: left to the hull collider. */
const MIN_CONTACT_UP = 0.3;

/** How far the hull's wheel guards stand proud of the tires, m. */
const GUARD_MARGIN = 0.03;
/** The casts start this far ABOVE the bump stop, so an obstacle that stands
 * taller than the suspension can swallow (a rock, a ledge, a wheel that is
 * already bottomed out on landing) is still found — as "fully compressed",
 * i.e. the capped suspension force. A cast that starts inside geometry
 * reports nothing at all: without the headroom such a wheel was treated as
 * hanging in the air and the corner dropped onto the hull. */
const CAST_HEADROOM = 0.35;
/** BUMPER BAND: on every car the hull has vertical faces all the way round
 * between these two heights above the ground (rig space, m). Two cars that
 * touch therefore always meet face to face at the same height, whatever
 * their tire sizes — no wedge that could ride up the other car. */
/** The hull is only swept for an impact when it travels further than this
 * in the frame, m (below it Havok's own contact margin is enough). */
const SWEEP_MIN_TRAVEL = 0.12;
const BAND_BOTTOM = 0.45;
const BAND_TOP = 0.8;
/** Chassis bodies of all raycast cars. A wheel cast that reports one of
 * them is discarded: a wheel never treats another car as ground (the cast
 * would lift this car without pushing the other one down — that was how
 * cars climbed and stacked on each other). Hull against hull is ordinary
 * rigid-body contact, which conserves momentum. (Havok's shape casts take
 * no collision filter — tried: a collide mask on the cast shape is ignored —
 * so the hit is filtered here; for the frame or two in which two hulls
 * overlap in a hard hit that wheel simply carries no load.) */
const carBodies = new WeakSet<PhysicsBody>();

const DEG = Math.PI / 180;
/** Closing speed a slide is always allowed, however small it has become
 * (rad/s): the taper of the closing-speed limit ends here, so the last
 * degrees do not take forever. */
const CLOSE_MIN = 6 * Math.PI / 180;
/** The yaw governor holds the closing-speed limit this many times more
 * firmly than it damps an opening slide. */
const CLOSE_STIFFNESS = 4;

/** Written before the zero velocities in `reset()`. Havok ignores a velocity
 * write only a hair from the body's current one: a car settled on the grid
 * kept ~1e-7 rad/s through a plain zero write, so race 1 after a long title
 * hold differed from race 1 after a short one. A clearly different value
 * first makes the zero write always land. */
const RESET_KICK = new Vector3(1, 1, 1);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Box as 8 corner points appended to a position list (rig space). */
function pushBox(
  positions: number[], indices: number[],
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): void {
  const base = positions.length / 3;
  for (let i = 0; i < 8; i++) {
    positions.push(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0);
  }
  const quads = [0, 1, 3, 2, 4, 6, 7, 5, 0, 4, 5, 1, 2, 3, 7, 6, 0, 2, 6, 4, 1, 5, 7, 3];
  for (let f = 0; f < 6; f++) {
    const a = base + quads[f * 4];
    const b = base + quads[f * 4 + 1];
    const c = base + quads[f * 4 + 2];
    const d = base + quads[f * 4 + 3];
    indices.push(a, b, c, a, c, d);
  }
}

export class RaycastVehicle implements Vehicle {
  readonly modelName = 'raycast';
  readonly rig: VehicleRig;
  readonly tuningParams: readonly TuningParam[] = RAYCAST_TUNING_PARAMS;
  /** The drift on this model is held with the throttle well open and the
   * front wheels a few degrees inside the direction of travel (the slide
   * steering does the countersteering). */
  readonly driverHints: Partial<DriverParams> = RAYCAST_DRIVER_HINTS;
  readonly chassisMesh: Mesh;
  readonly chassisBody: PhysicsBody;
  readonly wheelStates: WheelGroundState[] = [];
  readonly visual: VehicleVisual;
  /** Live tuning. Mutating a field directly works for everything that is
   * read per frame; call `applyTuning()` afterwards (or use setTuning) so
   * derived constants (spring rates, torques, tire curve) are refreshed. */
  readonly tuning: RaycastTuning;
  /** Per-wheel suspension travel relative to static ride height, m
   * (+ = compressed), for visuals. FL, FR, RL, RR. */
  readonly suspensionTravel = new Float64Array(4);
  /** Per-wheel accumulated roll angle, rad, for visuals. */
  readonly wheelRotation = new Float64Array(4);
  /** Per-wheel tire load, N (0 = airborne). */
  readonly wheelLoad = new Float64Array(4);
  /** Lab telemetry of the last update(), for traces (never read by the
   * model itself): [0] slide-steering blend 0..1, [1] rear-axle slip angle
   * (rad, signed like beta), [2] direction the front axle travels (rad),
   * [3] rear grip multiplier left by the slide assists (mean of both rear
   * tires, last sub-step), [4] yaw governor acceleration (rad/s², last
   * sub-step), [5] rear tread side deflection / peak, [6] rear tread
   * longitudinal deflection / peak (> 1 = spinning), [7] catch latch 0..1,
   * [8] hold demand 0..1, [9] rear grip left by the closing-speed limit. */
  readonly debug = new Float64Array(10);

  private input: InputProvider;
  private plugin: HavokPlugin;
  private hullShape: PhysicsShapeConvexHull;
  private castShapes: PhysicsShapeCylinder[] = [];
  private castQuery: IPhysicsShapeCastQuery;
  private castIn = new ShapeCastResult();
  private castHit = new ShapeCastResult();
  private sweepQuery: IPhysicsShapeCastQuery;
  private tmpO = new Vector3();
  private steerQuat = new Quaternion();
  private tmpV = new Vector3();
  private tmpW = new Vector3();
  private preStepFrames = 0;
  /** End-of-frame velocity minus the mean velocity handed to Havok. */
  private carryV = new Float64Array(3);
  private carryW = new Float64Array(3);
  private carryPending = false;
  private scene: Scene;
  private afterPhysicsObserver: Observer<Scene> | null = null;

  // --- rigid-body constants (whole car)
  private mass: number;
  /** Mesh origin height above the ground at static ride height. */
  private originY: number;
  /** CoM in mesh-local coordinates. */
  private comY: number;
  private comZ: number;
  /** Principal inertia about the CoM, kg·m²: x = pitch, y = yaw, z = roll. */
  private inertiaX: number;
  private inertiaY: number;
  private inertiaZ: number;
  /** Yaw inertia of the rig before tuning.yawInertiaScale. */
  private rigInertiaY: number;
  private appliedInertiaY = -1;
  private appliedImpact = -1;
  private gravity: number;
  private comHeight: number;

  // --- per-wheel constants (index 0..3)
  /** Static wheel centre relative to the CoM, chassis axes. */
  private bx = new Float64Array(4);
  private by = new Float64Array(4);
  private bz = new Float64Array(4);
  private rad = new Float64Array(4);
  private steered = [false, false, false, false];
  private driven = [false, false, false, false];
  private isFront = [true, true, false, false];
  private bump = new Float64Array(4);
  private droop = new Float64Array(4);
  private castTop = new Float64Array(4);
  private castLen = new Float64Array(4);
  private springK = new Float64Array(4);
  private springX0 = new Float64Array(4);
  private dampB = new Float64Array(4);
  private dampR = new Float64Array(4);
  private arbK = new Float64Array(4);
  private staticLoad = new Float64Array(4);
  private maxForce = new Float64Array(4);
  private spinInertia = new Float64Array(4);
  private mu = new Float64Array(4);
  private peakY = new Float64Array(4);
  private curveB = new Float64Array(4);
  private curveC = new Float64Array(4);
  private tireDamp = new Float64Array(4);
  private brakeTorque = new Float64Array(4);
  private driveTorque = new Float64Array(4);
  private engineBrakeTorque = new Float64Array(4);
  private parkTorque = new Float64Array(4);
  private drivenCount = 2;

  // --- per-wheel state
  private comp = new Float64Array(4);
  private hit = new Uint8Array(4);
  private nx = new Float64Array(4);
  private ny = new Float64Array(4);
  private nz = new Float64Array(4);
  private spin = new Float64Array(4);
  private defX = new Float64Array(4);
  private defY = new Float64Array(4);
  private steerCos = new Float64Array(4);
  private steerSin = new Float64Array(4);
  private wheelSteer = new Float64Array(4);
  private slipOut = new Float64Array(4);
  private rollOut = new Float64Array(4);

  // --- driver state
  private steerAngle = 0;
  private stickLock = 0;
  private brakeMode = NONE;
  private standTime = 0;
  /** Highest speed seen during the current brake press, m/s. */
  private brakeFromSpeed = 0;
  /** Set by reset(): the brake pedal has not been released since. */
  private brakeLatched = false;
  private reverseIntent = false;
  /** 0..1 share of the reverse thrust available: a brake that turned into
   * reverse by being HELD eases in (tuning.autoReverseRamp). */
  private reverseRamp = 1;
  /** Seconds the car has been stranded (see tuning.unstickAccel). */
  private strandTime = 0;
  // Slide-steering map of the last update (see stickForSteerAngle).
  private mapBlend = 0;
  private mapTravel = 0;
  private mapSide = 1;
  private mapBase = 0;
  private mapKeep = 0;
  private mapOver = 0;
  private mapTrim = 0;
  private mapThrHold = 0;
  private mapRearSlip = 0;
  private mapClosing = 0;
  private mapCloseLimit = 0;
  private mapHold = 0;
  private mapHeld = 0;
  /** 0..1: the driver was holding the current slide a moment ago. */
  private held = 0;
  /** 0..1: the driver is FEEDING the current slide right now (stick into
   * the turn, foot down) or was a moment ago (tuning.slideFeedMemory). */
  private fed = 0;
  private mapFed = 0;
  private slideHold = 0;
  /** d(rear slip angle)/dt, rad/s, mean over the last frame's sub-steps. */
  private slipRate = 0;
  /** Catch latch 0..1 and the stick side it was armed on (tuning.catchLatch). */
  private latch = 0;
  private latchStick = 1;
  /** The slide the catch latch remembers: the side the rear went to (+1 /
   * -1, as `mapSide`), how deep it got (rad) and for how many more seconds
   * it counts as "just now" once the rear has hooked up again
   * (tuning.catchMemory). */
  private catchSide = 1;
  private catchPeak = 0;
  private catchTime = 0;
  /** For how many seconds of that slide the driver was FEEDING it (stick
   * into the turn, foot down, in that frame), s (tuning.catchLinkHeld). */
  private catchHeld = 0;
  /** Seconds since the rear hooked up (0 while it slides) and last frame's
   * brake, for the brake-tap edge (tuning.catchBrakeForget). */
  private hookedTime = 0;
  private brakePrev = 0;
  /** Deepest rear slip angle of the slide in progress, rad. */
  private slidePeak = 0;
  /** Rear grip loss currently applied (lags the throttle on the way down). */
  private lossState = 0;
  /** Rear grip left by the closing-speed limit (tuning.slideCloseGrip). */
  private closeGrip = 1;
  private parked = false;
  // Self-righting (see tuning.selfRightDelay).
  private stuckTime = 0;
  private righting = false;
  private rightTime = 0;
  private rightBlend = 0;
  private travelPrev = 0;
  private travelValid = false;
  private _forwardSpeed = 0;
  private _reversing = false;
  private _drivenRimSpeed = 0;

  constructor(scene: Scene, input: InputProvider, rig: VehicleRig, tuning?: Partial<RaycastTuning>) {
    this.input = input;
    this.rig = rig;
    this.scene = scene;
    this.tuning = { ...DEFAULT_RAYCAST_TUNING, ...tuning };
    const engine = scene.getPhysicsEngine() as PhysicsEngineV2 | null;
    if (!engine) throw new Error('RaycastVehicle needs a physics-enabled scene');
    this.plugin = engine.getPhysicsPlugin() as HavokPlugin;
    this.gravity = engine.gravity.length() || 9.81;

    // --- whole-car mass properties: sprung mass + the four wheels (they are
    // not bodies here, so the chassis body carries them).
    let mass = rig.sprungMass;
    let my = rig.sprungMass * rig.com[1];
    let mz = rig.sprungMass * rig.com[2];
    for (const w of rig.wheels) {
      mass += w.mass;
      my += w.mass * w.y;
      mz += w.mass * w.z;
    }
    const cy = my / mass;
    const cz = mz / mass;
    const sy = rig.com[1] - cy;
    const sz = rig.com[2] - cz;
    let ix = rig.inertia[0] + rig.sprungMass * (sy * sy + sz * sz);
    let iy = rig.inertia[1] + rig.sprungMass * sz * sz;
    let iz = rig.inertia[2] + rig.sprungMass * sy * sy;
    for (const w of rig.wheels) {
      const dy = w.y - cy;
      const dz = w.z - cz;
      ix += w.mass * (dy * dy + dz * dz);
      iy += w.mass * (w.x * w.x + dz * dz);
      iz += w.mass * (w.x * w.x + dy * dy);
    }
    this.mass = mass;
    this.inertiaX = ix;
    this.inertiaY = iy;
    this.inertiaZ = iz;
    this.rigInertiaY = iy;
    this.comHeight = cy;
    this.originY = rig.hull.center[1];
    this.comY = cy - this.originY;
    this.comZ = cz;

    for (let i = 0; i < 4; i++) {
      const w = rig.wheels[i];
      const axle = w.axle === 'front' ? rig.front : rig.rear;
      this.bx[i] = w.x;
      this.by[i] = w.y - cy;
      this.bz[i] = w.z - cz;
      this.rad[i] = w.radius;
      this.steered[i] = w.steered;
      this.driven[i] = w.driven;
      this.isFront[i] = w.axle === 'front';
      this.bump[i] = axle.bumpTravel;
      this.droop[i] = axle.droopTravel;
      this.castTop[i] = axle.bumpTravel + STOP_MARGIN;
      this.castLen[i] = this.castTop[i] + axle.droopTravel + LOOKAHEAD;
      this.steerCos[i] = 1;
      this.wheelStates.push({
        position: new Vector3(w.x, w.y, w.z),
        velocity: new Vector3(),
        rollSpeed: 0,
        slipSpeed: 0,
        grounded: false,
        steerAngle: 0,
        spinSpeed: 0,
        radius: w.radius,
      });
    }
    this.drivenCount = Math.max(1, rig.wheels.filter((w) => w.driven).length);

    // --- collision hull (see class comment). Rig space → mesh space is a
    // shift by originY.
    const positions: number[] = [];
    const indices: number[] = [];
    const oy = this.originY;
    const [hw, hh, hl] = rig.hull.size;
    const hy0 = rig.hull.center[1] - hh / 2 - oy;
    const hy1 = rig.hull.center[1] + hh / 2 - oy;
    const hz = rig.hull.center[2];
    // Flat floor between the axles; nose and tail swept up (approach angle).
    pushBox(positions, indices, -hw / 2, hw / 2, hy0, hy1, hz - 0.42 * rig.wheelbase, hz + 0.42 * rig.wheelbase);
    pushBox(positions, indices, -hw / 2, hw / 2, hy0 + 0.14, hy1, hz - hl / 2, hz + hl / 2);
    const [cw, ch, cl] = rig.cage.size;
    pushBox(
      positions, indices,
      rig.cage.center[0] - cw / 2, rig.cage.center[0] + cw / 2,
      rig.cage.center[1] - ch / 2 - oy, rig.cage.center[1] + ch / 2 - oy,
      rig.cage.center[2] - cl / 2, rig.cage.center[2] + cl / 2,
    );
    // Wheel guards: the upper part of each tire (below it the shape cast is
    // the wheel). The lower box of each is the car's share of the BUMPER
    // BAND (same two heights on every car, see BAND_BOTTOM); the upper one
    // covers the crown of a tire taller than the band. They reach a hair
    // further out than the tire itself (fore, aft and to the side), so a
    // wall always meets the hull before it can swallow the cast cylinder.
    // The convex hull around all eight boxes makes the band continuous
    // along the sides and across nose and tail.
    for (const w of rig.wheels) {
      const x0 = w.x - w.width / 2 - GUARD_MARGIN;
      const x1 = w.x + w.width / 2 + GUARD_MARGIN;
      const reach = w.radius + GUARD_MARGIN;
      // Never below the old guard floor of a small wheel's hub, never so
      // high that the band misses the wheel altogether.
      const y0 = Math.min(BAND_BOTTOM, w.y + 0.25 * w.radius) - oy;
      const y1 = Math.max(BAND_TOP, y0 + oy + 0.1) - oy;
      pushBox(positions, indices, x0, x1, y0, y1, w.z - reach, w.z + reach);
      const crown = w.y + 0.93 * w.radius - oy;
      if (crown > y1) pushBox(positions, indices, x0, x1, y1, crown, w.z - 0.4 * w.radius, w.z + 0.4 * w.radius);
    }
    const mesh = new Mesh('raycastCar', scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);
    mesh.position.set(0, this.originY + 0.02, 0);
    mesh.rotationQuaternion = Quaternion.Identity();
    mesh.isVisible = false;
    this.chassisMesh = mesh;

    this.hullShape = new PhysicsShapeConvexHull(mesh, scene);
    this.hullShape.material = { friction: this.tuning.hullFriction, restitution: 0 };
    const body = new PhysicsBody(mesh, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = this.hullShape;
    // All external forces on this body come from update(): no engine
    // damping, and gravity is integrated in the sub-steps.
    body.setLinearDamping(0);
    body.setAngularDamping(0);
    body.setGravityFactor(0);
    this.chassisBody = body;
    this.appliedInertiaY = -1;
    carBodies.add(body);

    // One cast shape per axle (front and rear tires differ).
    for (const axle of [rig.front, rig.rear]) {
      this.castShapes.push(new PhysicsShapeCylinder(
        new Vector3(-axle.tireWidth / 2, 0, 0),
        new Vector3(axle.tireWidth / 2, 0, 0),
        axle.tireRadius,
        scene,
      ));
    }
    this.castQuery = {
      shape: this.castShapes[0],
      rotation: new Quaternion(),
      startPosition: new Vector3(),
      endPosition: new Vector3(),
      shouldHitTriggers: false,
      ignoreBody: body,
    };

    this.sweepQuery = {
      shape: this.hullShape,
      rotation: new Quaternion(),
      startPosition: new Vector3(),
      endPosition: new Vector3(),
      shouldHitTriggers: false,
      ignoreBody: body,
    };
    this.afterPhysicsObserver = scene.onAfterPhysicsObservable.add(() => this.afterPhysics());
    this.applyTuning();
    this.stickLock = this.fullLock();
    this.visual = new VehicleVisual(scene, mesh, { x: 0, y: -this.originY, z: 0 }, rig.wheels);
  }

  // ------------------------------------------------------------- tuning

  /** Recompute everything derived from `tuning` and the rig. */
  applyTuning(): void {
    const t = this.tuning;
    const rig = this.rig;
    const g = this.gravity;
    const weight = this.mass * g;
    const L = rig.wheelbase;
    // Static wheel loads from the whole-car CoM.
    const a = rig.front.z - this.comZ;
    const b = this.comZ - rig.rear.z;
    for (let i = 0; i < 4; i++) {
      const front = this.isFront[i];
      const axle = front ? rig.front : rig.rear;
      const load = (weight * (front ? b : a)) / L / 2;
      const cornerMass = load / g;
      this.staticLoad[i] = load;
      // Keep the rig's ride frequency for the mass this wheel really carries.
      const k = axle.springRate * (cornerMass / axle.sprungCornerMass) * t.springScale;
      this.springK[i] = k;
      this.springX0[i] = load / k;
      const critical = 2 * Math.sqrt(k * cornerMass);
      this.dampB[i] = t.dampingBump * critical;
      this.dampR[i] = t.dampingRebound * critical;
      this.arbK[i] = (front ? t.antiRollFront : t.antiRollRear) * k;
      this.maxForce[i] = t.maxSuspensionForce * load;
      this.spinInertia[i] = axle.wheelSpinInertia * (1 + (this.driven[i] ? t.drivelineInertia : 0));
      this.mu[i] = t.grip * (front ? t.frontGripScale : t.rearGripScale);
      const peak = Math.tan(clamp(front ? t.peakSlipAngleFront : t.peakSlipAngleRear, 1, 40) * DEG);
      this.peakY[i] = peak;
      // f(rho) = sin(C·atan(B·rho)): peak 1 at rho = 1, → slideGrip at infinity.
      const slide = clamp(front ? t.slideGripFront : t.slideGripRear, 0.3, 0.995);
      const C = 2 - (2 / Math.PI) * Math.asin(slide);
      const B = Math.tan(Math.PI / (2 * C));
      this.curveC[i] = C;
      this.curveB[i] = B;
      // Standstill tire damping per newton of load: 2·zeta·sqrt(k_tire·m)
      // with k_tire = mu·N·B·C / (sigma·peak) and m = N / g.
      this.tireDamp[i] =
        2 * t.lowSpeedDamping * Math.sqrt((this.mu[i] * B * C) / (Math.max(t.relaxationLength, 0.05) * peak * g));
      const r = this.rad[i];
      this.brakeTorque[i] = ((t.brakeDecel * weight * (front ? t.brakeBias : 1 - t.brakeBias)) / 2) * r;
      this.driveTorque[i] = this.driven[i] ? ((t.driveAccel * weight) / this.drivenCount) * r : 0;
      this.engineBrakeTorque[i] = this.driven[i] ? ((t.engineBrake * weight) / this.drivenCount) * r : 0;
      this.parkTorque[i] = ((t.parkBrake * weight) / 4) * r;
    }
    this.hullShape.material = { friction: t.hullFriction, restitution: 0 };
    // Mass properties (only pushed when they change: it wakes the body).
    const yaw = this.rigInertiaY * clamp(t.yawInertiaScale, 0.25, 8);
    // What HAVOK is told (it only uses it to answer hull contacts — every
    // other force is integrated here, with the true values): see
    // tuning.impactInertiaScale.
    const impact = clamp(t.impactInertiaScale, 0.5, 10);
    if (yaw !== this.appliedInertiaY || impact !== this.appliedImpact) {
      this.appliedInertiaY = yaw;
      this.appliedImpact = impact;
      this.inertiaY = yaw;
      // GOTCHA: Havok wants inertia PER UNIT MASS (see rig.ts).
      const k = impact / this.mass;
      this.chassisBody.setMassProperties({
        mass: this.mass,
        centerOfMass: new Vector3(0, this.comY, this.comZ),
        inertia: new Vector3(this.inertiaX * k, yaw * k, this.inertiaZ * k),
        inertiaOrientation: Quaternion.Identity(),
      });
    }
  }

  getTuning(key: string): number | undefined {
    const value = (this.tuning as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  }

  setTuning(key: string, value: number): boolean {
    if (this.getTuning(key) === undefined || !Number.isFinite(value)) return false;
    (this.tuning as unknown as Record<string, number>)[key] = value;
    this.applyTuning();
    return true;
  }

  // ---------------------------------------------------------- interface

  get forwardSpeed(): number {
    return this._forwardSpeed;
  }
  get drivenRimSpeed(): number {
    return this._drivenRimSpeed;
  }
  get isReversing(): boolean {
    return this._reversing;
  }
  get currentSteerAngle(): number {
    return this.steerAngle;
  }
  get maxSteerAngle(): number {
    return this.stickLock;
  }
  get wheelbase(): number {
    return this.rig.wheelbase;
  }
  get topSpeed(): number {
    return this.tuning.maxSpeed;
  }
  get nominalGrip(): number {
    return this.tuning.grip;
  }

  /**
   * Inverse of the steering map of the last update(): the stick that points
   * the front wheels at `angle`. Outside a slide that is angle / lock; in a
   * slide the stick sets the front slip angle instead (see update()), and
   * this hands an AI driver the stick that still gets it the wheel angle it
   * asked for (as far as the slide-steering window allows).
   */
  stickForSteerAngle(angle: number): number {
    const lock = Math.max(this.stickLock, 1e-3);
    const w = this.mapBlend;
    if (w <= 0) return clamp(angle / lock, -1, 1);
    // out(stick) = (1 - w)·lock·stick + w·(travel - side·feed(stick)) rises
    // monotonically with the stick: bisection.
    const closeLimit = this.mapCloseLimit;
    const hold = this.mapHold;
    let lo = -1, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = 0.5 * (lo + hi);
      const out = (1 - w) * lock * mid + w * (this.mapTravel - this.mapSide * this.slideFeed(mid));
      if (out < angle) lo = mid;
      else hi = mid;
    }
    this.mapCloseLimit = closeLimit;
    this.mapHold = hold;
    return 0.5 * (lo + hi);
  }

  /**
   * SLIDE STEERING MAP of the current frame: the front slip angle (rad, + =
   * wheels INSIDE the direction the front axle travels = feeding the slide)
   * asked for at a stick position. Also leaves the fastest closing speed the
   * stick allows and what it leaves of the throttle's hold in `mapCloseLimit`
   * / `mapHold`.
   *
   *  - Into the turn / centred: `base … keep` minus the gyro trim (see
   *    update()).
   *  - Where that comes out NEGATIVE (stick against the turn, or a slide
   *    deeper than the stick asks for) it is a countersteer — and a
   *    countersteer is not held blindly: it is a RATE SERVO. The slide may
   *    close at `allowed` rad/s (from the stick and the throttle: slow on a
   *    lift, fast with opposite lock, not at all while the driver holds the
   *    slide; tapering to nothing as the angle runs out). The countersteer is
   *    in full while the slide is not closing and is unwound as the closing
   *    speed reaches `allowed`, exactly as a driver unwinds the lock while
   *    the car comes back. A tire gives ~85 % of its side force at 40 % of
   *    its peak slip angle, so a countersteer that is simply held slams the
   *    slide shut and through to the other side.
   *  - Closing FASTER than allowed (the rear tires alone do that after a
   *    lift) steers the wheels back in, `counterSteerRate` degrees per rad/s;
   *    opening is steered against at the same rate (the yaw-rate gyro of an
   *    RC drift car).
   */
  private slideFeed(stick: number): number {
    const t = this.tuning;
    const into = -stick * this.mapSide;
    const opposite = into < 0 ? -into : 0;
    // (the throttle only HOLDS a slide the driver is feeding: see `fed`)
    const hold = this.mapThrHold * this.mapFed * clamp(1 - opposite / Math.max(t.counterSteerHoldStick, 0.05), 0, 1);
    // Closing-speed limit, by what the driver is doing with the slide:
    //  - HOLDING it (stick into the turn AND foot down): `slideHoldRate` —
    //    a held drift follows the stick to a shallower angle at a pace a
    //    slow thumb can stay ahead of;
    //  - LETTING GO of a drift he was holding (`mapHeld`, kept until the
    //    slide has closed): `slideCloseRate` — the rear comes back
    //    progressively;
    //  - NOT holding it at all (knocked sideways by a rock or a rival, a
    //    slide that was never fed): `slideFreeRate` — straightened at once;
    //  - AGAINST the turn: up to `slideCatchRate`, in proportion.
    const holding = this.mapThrHold * clamp(into / 0.25, 0, 1);
    const released = t.slideFreeRate + (Math.min(t.slideCloseRate, t.slideFreeRate) - t.slideFreeRate) * this.mapHeld;
    // (ASSIST LEVEL: at half the level every one of these limits is twice
    // as fast, at 0 there is none — the limit is never enforced "half
    // strength", which would only stretch the time the tires haul the car
    // round while the slide lingers.)
    const closeLimit = ((released + (t.slideCatchRate - released) * opposite - (released - Math.min(t.slideHoldRate, released)) * holding) * DEG) /
      Math.max(clamp(t.assistLevel, 0, 1), 0.05);
    this.mapCloseLimit = closeLimit;
    this.mapHold = hold;
    // What the front wheels work toward: no closing at all while the driver
    // feeds the slide, the limit otherwise.
    const allowed = Math.min((1 - holding) * closeLimit, this.mapRearSlip / Math.max(t.slideCloseTau, 0.02) + CLOSE_MIN);
    const base = this.mapBase, keep = this.mapKeep, over = this.mapOver;
    let feed = (into >= 0 ? base + (keep - base) * into : base + (base + over) * into) - this.mapTrim;
    const closing = this.mapClosing;
    if (feed < 0) feed = Math.max(feed, -over) * clamp((allowed - closing) / Math.max(allowed, 0.25), 0, 1);
    // The yaw-rate gyro belongs to a drift the driver is (or was) holding;
    // a car knocked sideways by a rock comes down with a yaw rate the tires
    // have not made, and steering after that only disturbs the landing.
    const gyro = t.counterSteerRate * DEG * this.mapHeld;
    const excess = closing - allowed;
    if (excess > 0) feed += gyro * excess;
    else if (closing < 0) feed += gyro * closing;
    return clamp(feed, -over, keep + 6 * DEG);
  }

  /** Full mechanical lock (bicycle angle), rad. */
  private fullLock(): number {
    const halfTrack = this.rig.front.track / 2;
    return Math.atan(this.rig.wheelbase / Math.max(this.tuning.minTurnRadius, halfTrack + 0.1));
  }

  // -------------------------------------------------------------- update

  update(dt: number): void {
    if (!(dt > 0)) return;
    const t = this.tuning;
    const body = this.chassisBody;
    const mesh = this.chassisMesh;
    if (this.preStepFrames > 0 && --this.preStepFrames === 0) body.disablePreStep = true;

    const q = mesh.rotationQuaternion;
    const pos = mesh.position;
    if (!q || !Number.isFinite(pos.x + pos.y + pos.z + q.x + q.y + q.z + q.w)) return;

    // Chassis axes in world space (rows of the rotation matrix).
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    let Rx = 1 - 2 * (qy * qy + qz * qz), Ry = 2 * (qx * qy + qz * qw), Rz = 2 * (qx * qz - qy * qw);
    let Ux = 2 * (qx * qy - qz * qw), Uy = 1 - 2 * (qx * qx + qz * qz), Uz = 2 * (qy * qz + qx * qw);
    let Fx = 2 * (qx * qz + qy * qw), Fy = 2 * (qy * qz - qx * qw), Fz = 1 - 2 * (qx * qx + qy * qy);

    // Frame-start copies (the sub-steps rotate the working set).
    const R0x = Rx, R0y = Ry, R0z = Rz, U0x = Ux, U0y = Uy, U0z = Uz, F0x = Fx, F0y = Fy, F0z = Fz;

    body.getLinearVelocityToRef(this.tmpV);
    body.getAngularVelocityToRef(this.tmpW);
    // Normally zero here: afterPhysics() has already put the carry back
    // (see the hand-off at the end of update()). It is only still pending if
    // the physics engine did not step since the last update().
    let vx = this.tmpV.x + this.carryV[0], vy = this.tmpV.y + this.carryV[1], vz = this.tmpV.z + this.carryV[2];
    let wx = this.tmpW.x + this.carryW[0], wy = this.tmpW.y + this.carryW[1], wz = this.tmpW.z + this.carryW[2];
    if (!Number.isFinite(vx + vy + vz)) vx = vy = vz = 0;
    if (!Number.isFinite(wx + wy + wz)) wx = wy = wz = 0;

    // CoM in world space.
    const cmx = pos.x + Ux * this.comY + Fx * this.comZ;
    const cmy = pos.y + Uy * this.comY + Fy * this.comZ;
    const cmz = pos.z + Uz * this.comY + Fz * this.comZ;

    const vFwd = vx * Fx + vy * Fy + vz * Fz;
    const vLat = vx * Rx + vy * Ry + vz * Rz;
    const planar = Math.hypot(vFwd, vLat);
    this._forwardSpeed = vFwd;

    // ---------------------------------------------------------- driver
    const intent = this.input.poll();
    const throttle = clamp(intent.throttle || 0, 0, 1);
    const brakePedal = clamp(intent.brake || 0, 0, 1);
    const stick = clamp(intent.steering || 0, -1, 1);

    // Brake / reverse. A press that starts at (near) standstill is reverse; a
    // press that starts while the car is MOVING — in any direction: forward,
    // sideways in a slide, or rolling backward after a spin / down a slope —
    // is a brake and stays one until released, so it can hold the car on a
    // slope. The one exception: backward motion the player asked for (he was
    // reversing and re-presses the trigger) keeps reversing. Held at
    // standstill on level ground it turns into reverse after
    // `autoReverseDelay` (see tuning).
    if (throttle > 0.02 || vFwd > 0.5) this.reverseIntent = false;
    if (brakePedal <= 0.02) {
      this.brakeMode = NONE;
      this.standTime = 0;
      this.brakeFromSpeed = 0;
      this.brakeLatched = false;
    } else if (this.brakeMode === NONE) {
      const still = planar < 1 && Math.abs(vFwd) < 0.5;
      // A brake that was already down when the car was respawned is the
      // press from before the respawn, not a new one: it brakes (and holds)
      // until it has been let go of once.
      const wantsReverse = throttle <= 0.02 && !this.brakeLatched && (still || (this.reverseIntent && vFwd < 0.5));
      this.brakeMode = wantsReverse ? REVERSE : BRAKE;
      this.standTime = 0;
      this.brakeFromSpeed = 0;
      // A press that IS a reverse command gets the thrust at once.
      this.reverseRamp = 1;
    }
    if (this.brakeMode === BRAKE) {
      // Fastest the car has been during THIS press: a stop that came from
      // speed (a panic stop, the end of a braking zone) is not a wish to
      // back up — it waits `autoReverseDelayFromSpeed` instead (0 = for a
      // release and a new press). A press on a car that was already
      // crawling keeps the short `autoReverseDelay`.
      if (planar > this.brakeFromSpeed) this.brakeFromSpeed = planar;
      const delay = this.brakeFromSpeed > t.autoReverseFromSpeed ? t.autoReverseDelayFromSpeed : t.autoReverseDelay;
      // Level enough to mean "back up", not "hold me on this hill".
      const level = t.autoReverseMaxSlope <= 0 || Math.abs(Fy) < Math.sin(t.autoReverseMaxSlope * DEG);
      this.standTime = planar < 0.4 && throttle <= 0.02 && level && !this.brakeLatched ? this.standTime + dt : 0;
      if (delay > 0 && this.standTime > delay) {
        this.brakeMode = REVERSE;
        // ... a brake that was only HELD eases into it (the trigger is
        // still fully down from the stop: without the ramp the car shot
        // backward at full thrust the moment the wait was over).
        this.reverseRamp = t.autoReverseRamp > 0 ? 0 : 1;
      }
    } else if (this.brakeMode === REVERSE && (vFwd > 1.5 || throttle > 0.02)) {
      this.brakeMode = BRAKE;
    }
    if (this.brakeMode === REVERSE) this.reverseIntent = true;
    const reversing = this.brakeMode === REVERSE;
    const braking = this.brakeMode === BRAKE;
    this._reversing = reversing;
    // Signed drive command; the brake cuts the drive (as the legacy model).
    if (reversing && this.reverseRamp < 1) this.reverseRamp = Math.min(1, this.reverseRamp + dt / Math.max(t.autoReverseRamp, 0.02));
    const drive = reversing ? -brakePedal * this.reverseRamp : braking ? 0 : throttle;
    const brake = braking ? brakePedal : 0;
    const driveAbs = Math.abs(drive);
    const driveDir = drive < 0 ? -1 : 1;
    const rimCap = drive < 0 ? t.maxSpeed * t.reverseSpeedFactor : t.maxSpeed;
    // ASSIST: wheelspin allowance (slip ratio) the drive torque fades out at.
    let spinAllow = t.wheelspinLimit > 0 ? Math.max(0.04, t.wheelspinLimit * driveAbs) : 0;
    // Engine drag fades in as the throttle closes (no step at the bite point).
    const ebFade = Math.max(t.engineBrakeFade, 0.02);
    const engineBrake = driveAbs < ebFade && !braking ? 1 - driveAbs / ebFade : 0;
    // Parking brake: engages below 0.5 m/s with the pedals released and
    // then holds until a pedal is touched (or the car is knocked past 2 m/s).
    if (t.parkBrake <= 0 || driveAbs >= 0.02 || braking || planar > 2) this.parked = false;
    else if (planar < 0.5) this.parked = true;
    const park = this.parked ? 1 : 0;

    // ------------------------------------------------------------ steering
    const L = this.rig.wheelbase;
    const lock = this.fullLock();
    let stickLock = lock;
    if (t.steerGripMargin > 0) {
      const v2 = Math.max(vx * vx + vy * vy + vz * vz, 1);
      stickLock = Math.min(lock, Math.atan((t.steerGripMargin * t.grip * this.gravity * L) / v2) + t.steerSlipReserve * DEG);
    }
    this.stickLock = stickLock;
    let target = stick * stickLock;
    let limit = lock;
    // ------------------------------------------------- slide state (frame)
    // Shared by the slide steering, the yaw governor (sub-steps), the catch
    // latch and the slide scrub. ASSIST LEVEL scales the two stabilisers —
    // slide steering and yaw governor — together (tuning.assistLevel).
    // ASSIST LEVEL in two stages: from 1 down to 0.5 the yaw governor
    // weakens and the closing-speed limits get faster (slides open and
    // close quicker) while the slide steering stays whole; from 0.5 down
    // to 0 the slide steering fades out as well. (A half-blended slide
    // steering is not "half the help": with the stick held into the turn
    // the plain half alone saturates the front tires.)
    const assist = clamp(t.assistLevel, 0, 1);
    const steerAssist = clamp(t.counterSteerAssist, 0, 1) * clamp(2 * assist, 0, 1);
    const classic = clamp(t.classicDrift, 0, 1);
    const driveFwd = drive > 0 ? drive : 0;
    // HOLD DEMAND of the throttle, 0..1: with the foot down a slide is meant
    // to be ridden (it may not close by itself), off it the slide is meant
    // to end.
    const thrHold = clamp(t.slideCloseDamping + (driveFwd - t.slideHoldFrom) * t.slideHoldThrottle, 0, 1);
    // Fastest the slide angle may CLOSE this frame, rad/s, and how much of
    // the throttle's hold the stick leaves (see slideFeed).
    let closeLimit = (Math.max(t.slideFreeRate, 0) * DEG) / Math.max(assist, 0.05);
    let holdDemand = thrHold;
    let scrubWeight = 0;
    let slideMemory = 0;
    // Stick into the turn of the current slide, -1..1 (0 with no slide).
    let slideInto = 0;
    // The rear axle is past the slide threshold on this very frame.
    let slidingNow = false;
    // (Up to fully sideways exactly as before; from there to ~107 deg of slip
    // the assists fade out — see `facing` below — instead of cutting out on
    // the frame the forward speed changes sign.)
    if (planar > 2 && (vFwd > -0.3 * planar || this.slideHold > 0)) {
      // Direction the front axle is travelling relative to the nose, and the
      // slip angle of the (unsteered) rear axle: the rear sliding is what
      // tells a slide from a plain corner.
      const yawRate = wx * Ux + wy * Uy + wz * Uz;
      const ahead = Math.max(vFwd, 1);
      const travelNow = Math.atan2(vLat + yawRate * (this.rig.front.z - this.comZ), ahead);
      // The window follows the direction of travel with a small lag
      // (tuning.counterSteerLag): while a slide closes the wheels stay a
      // touch further out than the travel direction = a measured
      // countersteer. The half frame the steer angle is held for is taken
      // out, so the lag is the same at any frame rate.
      const travelRate = this.travelValid ? clamp((travelNow - this.travelPrev) / dt, -8, 8) : 0;
      this.travelPrev = travelNow;
      this.travelValid = true;
      const travel = travelNow - travelRate * (t.counterSteerLag - 0.5 * dt);
      const rearSigned = Math.atan2(vLat + yawRate * (this.rig.rear.z - this.comZ), ahead);
      const rearSlip = Math.abs(rearSigned);
      const start = t.counterSteerStart * DEG;
      // 1 while the car still travels nose-first (any slide up to 90 deg),
      // fading to 0 by ~107 deg of slip: past that it is a spin, and the
      // stick is a plain wheel angle again.
      const facing = clamp(1 + vFwd / (0.3 * planar), 0, 1);
      const moving = clamp((planar - 2) / 3, 0, 1) * facing;
      const now = clamp((rearSlip - start) / (6 * DEG), 0, 1) * moving;
      // Held for a moment after the rear hooks up again, so the assists do
      // not hand a full opposite lock back to the tires at the worst time —
      // and the yaw governor is still there as the slide passes through zero.
      this.slideHold = Math.max(now, this.slideHold - dt / Math.max(t.counterSteerRelease, 0.02));
      const sliding = this.slideHold;
      slideMemory = sliding;
      // Slide scrub (tuning.slideScrub): in from 8 to 14 deg of rear slip;
      // a DEEP slide already drags itself down (the rear side force points
      // further and further backward), so the scrub eases off again there.
      scrubWeight = clamp((rearSlip - 8 * DEG) / (6 * DEG), 0, 1) * (1 - clamp(1 - t.slideScrubDeep, 0, 1) * clamp((rearSlip - 17 * DEG) / (12 * DEG), 0, 1)) * moving;
      // SLIDE STEERING ("gyro"). While the rear slides the stick no longer
      // sets an absolute wheel angle: it sets the FRONT SLIP ANGLE, i.e. where
      // the wheels point relative to the direction the front axle travels.
      //   stick centred          -> `neutral` share of the feed angle (0 = the
      //                             wheels simply follow the slide: caster)
      //   stick INTO the turn    -> up to `keep` degrees inside the direction
      //                             of travel = feed the slide (small with the
      //                             throttle closed, large on power)
      //   stick AGAINST the turn -> a countersteer of up to `over` degrees
      //                             past it that is unwound as the slide
      //                             closes at the pace the stick asks for
      // No dead zone and no reversal anywhere on the stick; see slideFeed().
      const onPower = clamp(driveFwd / Math.max(t.counterSteerPowerFull, 0.05), 0, 1);
      const keep = (t.counterSteerSlip + (t.counterSteerSlipPower - t.counterSteerSlip) * onPower) * DEG;
      const over = (t.counterSteerCap > 0 ? t.counterSteerCap : 4) * DEG;
      // The feed left at a CENTRED stick only comes in with the throttle
      // well open: below `counterSteerNeutralFrom` hands off = caster; it
      // is all there half a trigger further on.
      // (tuning.classicDrift moves it toward the full feed: the throttle
      // alone then holds a slide)
      const neutral = t.counterSteerNeutral + (1 - t.counterSteerNeutral) * classic;
      // Which way the car slides is read at the REAR axle. (The direction
      // the FRONT axle travels says nothing about it in a tight, slow turn:
      // there it points into the turn by the steer angle itself, and a stick
      // held into a donut was taken for opposite lock.)
      const side = rearSigned < 0 ? -1 : 1;
      // FED: the throttle only holds a slide open that the driver FEEDS with
      // the stick (a quarter stick into the turn = fully), or fed until a
      // moment ago (`slideFeedMemory`: the thumb may pass through the centre).
      // A slide nobody feeds — the car was bumped, hit a rock, or the driver
      // has let go of the stick — gets neither the centre-stick feed angle
      // nor the governor's hold, however far the trigger is down: it closes
      // like a hands-off slide. (Before this a centred stick with the foot
      // flat kept 60 % of the feed angle and the full hold: a car knocked
      // sideways at 8-14 m/s with the trigger down kept rotating for 1-3 s
      // and ended up pointing 90-180 deg off its course.)
      this.fed = Math.max(sliding * thrHold * clamp((-stick * side) / 0.25, 0, 1), this.fed - dt / Math.max(t.slideFeedMemory, 0.02));
      const fed = Math.max(this.fed, classic, clamp(t.slideHoldUnfed, 0, 1));
      const base = keep * clamp(neutral, 0, 1) * clamp((driveFwd - t.counterSteerNeutralFrom) / 0.5, 0, 1) * fed;
      // The deeper the slide, the less it is fed (`counterSteerAngleGain`
      // degrees of feed taken off per degree of rear slip): every stick
      // position then has its own slide angle instead of a knife edge
      // between "straightens" and "spins".
      const trim = Math.min(t.counterSteerAngleGain * rearSlip, 12 * DEG);
      // Remembered for slideFeed() / stickForSteerAngle().
      this.mapTravel = travel;
      this.mapSide = side;
      this.mapBase = base;
      this.mapKeep = keep;
      this.mapOver = over;
      this.mapTrim = trim;
      this.mapThrHold = thrHold;
      this.mapFed = fed;
      // "This slide is a drift the driver was holding": set while he feeds
      // it (stick into the turn, foot down) and kept until the slide has
      // closed.
      const feedNow = sliding * thrHold * clamp((-stick * side) / 0.25, 0, 1);
      this.held = Math.max(feedNow, this.held - (sliding > 0.5 ? 0 : dt / 0.3));
      this.mapHeld = this.held;
      this.mapRearSlip = rearSlip;
      // How fast the slide angle is closing (+) or opening (-), rad/s: the
      // mean over the last frame's sub-steps (see the yaw governor).
      this.mapClosing = -this.slipRate * (rearSigned < 0 ? -1 : 1);
      slideInto = -stick * side;
      const feed = this.slideFeed(stick);
      closeLimit = this.mapCloseLimit;
      holdDemand = this.mapHold;
      const capped = travel - side * feed;
      const blend = steerAssist * sliding;
      target += (capped - target) * blend;
      this.mapBlend = blend;
      if (blend > 0) limit = lock * Math.max(1, t.counterSteerLock);
      // CATCH LATCH (tuning.catchLatch): a deep slide that is being caught
      // with a good share of opposite lock arms it (unless it was a drift
      // the driver held: catchLinkHeld); it stays armed for as long as the
      // stick is kept on that side.
      // (how deep this slide has been at its deepest: a slide that was 20
      // deg when the driver went for the opposite lock is latched even if it
      // is down to 8 by the time the stick gets there)
      this.slidePeak = sliding > 0 ? Math.max(this.slidePeak, rearSlip) : 0;
      // ... and it is remembered for `catchMemory` seconds after the rear
      // has hooked up again (a slide to the other side is a new slide).
      if (now > 0) {
        slidingNow = true;
        if (side !== this.catchSide) {
          this.catchSide = side;
          this.catchPeak = 0;
          this.catchHeld = 0;
        }
        if (rearSlip > this.catchPeak) this.catchPeak = rearSlip;
        // (only frames the driver feeds NOW count: `held` stays up until the
        // slide closes, so one frame of stick-in + throttle at the start of a
        // skid would otherwise run this clock for the whole slide)
        if (feedNow > 0.5) this.catchHeld += dt;
        this.catchTime = Math.max(t.catchMemory, 0);
      }
      this.debug[0] = blend;
      this.debug[1] = rearSigned;
      this.debug[2] = travelNow;
    } else {
      this.travelValid = false;
      this.slideHold = 0;
      this.slidePeak = 0;
      this.held = 0;
      this.fed = 0;
      this.mapBlend = 0;
      this.debug[0] = 0;
      this.debug[1] = 0;
      this.debug[2] = 0;
    }
    // CATCH LATCH, arming. Opposite lock against a slide that is still there
    // OR that closed by itself a moment ago: a driver who lifts when the
    // tail steps out and then goes for full opposite lock and the throttle
    // together finds the slide already gone — without the memory that input
    // was simply "full lock + floor it" on a straight car, i.e. the
    // power-over trait, and the car settled into a slide the OTHER way (lab:
    // 30 of 42 such catches on three of the four cars).
    if (!slidingNow && this.catchTime > 0) {
      this.catchTime -= dt;
      if (this.catchTime <= 0) {
        this.catchPeak = 0;
        this.catchHeld = 0;
      }
    }
    // LINKING (tuning.catchBrakeForget): a brake TAP (the pedal going down
    // past 0.1 in this frame) with more than half lock toward the new side
    // (the old slide's opposite-lock side) on a car whose rear has been
    // hooked up for `catchBrakeHooked` s forgets the old slide and lets go
    // of the latch — a brake tap with lock on is how a slide is STARTED.
    // (A brake used DURING the catch, or still down when the rear hooks up,
    // is part of the catch: it must not free the latch.)
    this.hookedTime = slidingNow ? 0 : this.hookedTime + dt;
    const brakeTap = brake > 0.1 && this.brakePrev <= 0.1;
    this.brakePrev = brake;
    if (t.catchBrakeForget > 0 && brakeTap && this.hookedTime >= t.catchBrakeHooked && stick * this.catchSide > 0.6) {
      this.catchTime = 0;
      this.catchPeak = 0;
      this.catchHeld = 0;
      this.latch = 0;
    }
    if (t.catchLatch > 0 && steerAssist > 0 && this.catchPeak > 0) {
      const opposite = stick * this.catchSide;
      const recent = slidingNow ? slideMemory : clamp(this.catchTime / 0.1, 0, 1);
      // LINKING (tuning.catchLinkHeld): opposite lock out of a drift the
      // driver was HOLDING (fed for catchLinkTime s of it) is the way into
      // the next one, not a catch.
      const link = this.catchHeld >= t.catchLinkTime ? clamp(t.catchLinkHeld, 0, 1) : 0;
      const arm = (1 - link) * recent * clamp((opposite - 0.25) / 0.35, 0, 1) * clamp((this.catchPeak - t.catchLatchAngle * DEG) / (Math.max(t.catchLatchSpan, 0.5) * DEG), 0, 1);
      if (arm > this.latch) {
        this.latch = arm;
        this.latchStick = stick < 0 ? -1 : 1;
      }
    }
    // The latch lets go once the stick has left the side it was armed on.
    if (this.latch > 0 && stick * this.latchStick < 0.25) this.latch = Math.max(0, this.latch - dt / 0.25);
    const latch = clamp(this.latch * t.catchLatch, 0, 1);
    // ... and while it is armed the wheelspin allowance shrinks to the peak
    // slip ratio: at low speed the motor could otherwise spin the rear loose
    // on its own, latch or not.
    if (latch > 0) spinAllow = Math.max(t.wheelspinLimit > 0 ? 0.04 : 0, spinAllow + (Math.max(t.peakSlipRatio, 0.02) * 1.2 - spinAllow) * latch);
    this.debug[7] = latch;
    this.debug[8] = thrHold;
    target = clamp(target, -limit, limit);
    const maxStep = t.steerRate * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxStep, maxStep);
    // Ackermann: both front wheels aim at the turn centre of the bicycle angle.
    const tanSteer = Math.tan(this.steerAngle);
    for (let i = 0; i < 4; i++) {
      const angle = this.steered[i] ? Math.atan((L * tanSteer) / (L - this.bx[i] * tanSteer)) : 0;
      this.wheelSteer[i] = angle;
      this.steerCos[i] = Math.cos(angle);
      this.steerSin[i] = Math.sin(angle);
    }

    // ------------------------------------------------------------- casts
    const query = this.castQuery;
    for (let i = 0; i < 4; i++) {
      const lx = this.bx[i];
      const ly = this.by[i] + this.castTop[i] + CAST_HEADROOM;
      const lz = this.bz[i];
      const sx = cmx + Rx * lx + Ux * ly + Fx * lz;
      const sy = cmy + Ry * lx + Uy * ly + Fy * lz;
      const sz = cmz + Rz * lx + Uz * ly + Fz * lz;
      const len = this.castLen[i] + CAST_HEADROOM;
      query.shape = this.castShapes[this.isFront[i] ? 0 : 1];
      query.startPosition.set(sx, sy, sz);
      query.endPosition.set(sx - Ux * len, sy - Uy * len, sz - Uz * len);
      const half = this.wheelSteer[i] * 0.5;
      this.steerQuat.set(0, Math.sin(half), 0, Math.cos(half));
      q.multiplyToRef(this.steerQuat, query.rotation);
      this.plugin.shapeCast(query, this.castIn, this.castHit);
      let hit = 0;
      if (this.castHit.hasHit && !(this.castHit.body && carBodies.has(this.castHit.body))) {
        const n = this.castHit.hitNormal;
        let ax = n.x, ay = n.y, az = n.z;
        const nl = Math.hypot(ax, ay, az);
        if (nl > 0.5 && Number.isFinite(nl)) {
          ax /= nl; ay /= nl; az /= nl;
          let up = ax * Ux + ay * Uy + az * Uz;
          if (up < 0) {
            ax = -ax; ay = -ay; az = -az; up = -up;
          }
          if (up >= MIN_CONTACT_UP) {
            hit = 1;
            this.nx[i] = ax;
            this.ny[i] = ay;
            this.nz[i] = az;
            // Above the bump stop = fully compressed (see CAST_HEADROOM).
            this.comp[i] = Math.min(this.castTop[i] + CAST_HEADROOM - this.castHit.hitFraction * len, this.castTop[i]);
          }
        }
      }
      this.hit[i] = hit;
      if (!hit) this.comp[i] = -this.droop[i] - LOOKAHEAD;
    }

    // ---------------------------------------------------------- sub-steps
    const steps = clamp(Math.round(dt * t.substepHz), 1, 40);
    const h = dt / steps;
    const relax = h / Math.max(t.relaxationLength, 0.05);
    const relaxX = h / Math.max(t.relaxationLengthLong, 0.03);
    const elasticBlend = 1 - Math.exp(-h / 0.03);
    const mass = this.mass;
    const grav = this.gravity;
    const diffBlend = t.diffLock > 0 ? 1 - Math.exp(-t.diffLock * h) : 0;
    const airBlend = t.airDamping > 0 ? 1 - Math.exp(-t.airDamping * h) : 0;
    const kneeV = t.damperKneeSpeed;
    const kneeRatio = t.damperKneeRatio;
    const peakX = Math.max(t.peakSlipRatio, 0.02);
    const fadeV = Math.max(t.lowSpeedFade, 0.1);
    const forceLever = t.tireForceHeight * this.comHeight;
    const absOn = t.abs > 0.5 && planar > 2.5;
    const slideStart = t.slideAssistStart * DEG;
    const rearArm = this.rig.rear.z - this.comZ;
    // (a LOW-SPEED effect: it fades out over the 4 m/s above
    // wheelspinGripLossSpeed. At drift speeds the motor spins the tires
    // harder the slower the car goes, so with it a deep drift that lost a
    // little speed lost grip and thrust with it and wound itself down into
    // a donut; there the throttle's hold on the rear is powerSlideLoss.)
    const burnLoss = driveAbs > 0.02
      ? clamp(t.wheelspinGripLoss, 0, 0.9) * (1 - latch) * clamp((t.wheelspinGripLossSpeed + 4 - planar) / 4, 0, 1)
      : 0;
    // THE STICK SETS HOW DEEP: the rear slip angle up to which the throttle
    // loosens the rear runs from `powerSlideMinAngle` (stick centred or
    // against the turn) to `powerSlideMaxAngle` (stick fully into it); past
    // it the rear gets its grip back over `powerSlideFade` degrees. A drift
    // therefore settles ON that fade, where a deeper slide means MORE rear
    // grip — a stable angle for every stick position, shallow ones included.
    // (tuning.classicDrift raises the centre-stick end toward 14 deg: a
    // shallow drift on the throttle alone)
    const slideMin = t.powerSlideMinAngle + Math.max(14 - t.powerSlideMinAngle, 0) * classic;
    const slideTop = clamp(slideMin + (t.powerSlideMaxAngle - slideMin) * clamp(slideInto, 0, 1), 1, 80);
    const slideMaxTan = Math.tan(clamp(slideTop + Math.max(t.powerSlideFade, 1), 3, 85) * DEG);
    const slideFadeTan = Math.max(slideMaxTan - Math.tan(slideTop * DEG), 0.02);
    // The loss follows the throttle up at once, but comes back DOWN at a
    // limited pace (tuning.slideGripRecovery): after a lift the rear regains
    // its grip progressively instead of in one sub-step.
    // (a latched catch gives the rear its grip back: see tuning.catchLatch)
    const lossMax = clamp(t.powerSlideLoss, 0, 0.9);
    const lossWanted = drive > 0.02 ? lossMax * clamp((drive - t.powerSlideFrom) / Math.max(1 - t.powerSlideFrom, 0.05), 0, 1) : 0;
    this.lossState = Math.max(lossWanted, this.lossState - (t.slideGripRecovery > 0 ? (lossMax * dt) / t.slideGripRecovery : 1));
    const slideLoss = this.lossState * (1 - latch);
    const slideSpan = Math.max(t.powerSlideSpan, 0.2);
    // POWER-OVER (tuning.powerOver): how far below its peak slip angle a rear
    // tire starts to let go when the FRONT tires are already past theirs and
    // the foot is (nearly) flat.
    const powerOver = drive > 0.02 ? clamp(t.powerOver, 0, 1) * clamp((drive - t.powerOverFrom) / Math.max(1 - t.powerOverFrom, 0.05), 0, 1) * (1 - latch) : 0;
    // ASSIST: yaw governor (see tuning.slideYawDamping), scaled by assistLevel.
    // (ASSIST LEVEL scales the damping of opening and held slides; the
    // closing-speed limit keeps its firmness and gets faster instead — see
    // slideFeed.)
    const govOn = assist > 0 && t.slideYawDamping > 0;
    const govGain = Math.max(t.slideYawDamping, 0);
    const govMax = Math.max(t.slideYawDampingMax, 0) * assist;
    const govCloseMax = Math.max(t.slideCloseMax, t.slideYawDampingMax, 0);
    const closeTaper = 1 / Math.max(t.slideCloseTau, 0.02);
    // SLIDE SCRUB (tuning.slideScrub): extra drag while the rear slides.
    const scrub = Math.max(t.slideScrub, 0) * scrubWeight * driveFwd;
    let slipRateSum = 0;
    const freeSpeed = Math.max(t.driveFreeSpeed, t.maxSpeed + 1);
    const fadeSpan = Math.max(freeSpeed - Math.max(t.driveFadeSpeed, 0), 1);
    const limiterBand = Math.max(t.limiterBand, 0.2);
    // ASSIST: tip guard (see tuning.tipGuardStart).
    const tipOn = t.tipGuardStart > 0;
    const tipSin0 = Math.sin(clamp(t.tipGuardStart, 0, 60) * DEG);
    const tipSpan = Math.max(Math.sin(clamp(t.tipGuardFull, 1, 80) * DEG) - tipSin0, 0.02);
    const tipLead = Math.max(t.tipGuardLead, 0);
    // ASSIST: air levelling, air yaw damping, self-righting.
    const airLevel = Math.max(t.airLevel, 0);
    const airMax = Math.max(t.airMaxAccel, 0);
    const yawAirBlend = t.airYawDamping > 0 ? 1 - Math.exp(-t.airYawDamping * h) : 0;
    const airShare1 = clamp(t.airPartial, 0, 1);
    const airShare2 = airShare1 * airShare1;
    // Levelling is for a car in FLIGHT: one lying still on its roof or side
    // also has no wheel on the ground, and is left to the self-righting.
    const flight = clamp((Math.hypot(vx, vy, vz) - 1) / 2, 0, 1);
    const rightBlend = this.updateSelfRighting(dt, Uy, Math.hypot(vx, vy, vz), Math.hypot(wx, wy, wz));
    const rightTorque = t.selfRightTorque * mass * grav * 0.5 * this.rig.wheelbase;
    // ASSIST: unstick (see tuning.unstickAccel). Stranded = (almost) at rest,
    // roughly upright, with at most two wheels — or no driven wheel —
    // carrying load: high-centred on a rock, or leaning on one.
    let loadedAll = 0, loadedDriven = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheelLoad[i] > 0.02 * this.staticLoad[i]) {
        loadedAll++;
        if (this.driven[i]) loadedDriven++;
      }
    }
    const speed3 = Math.hypot(vx, vy, vz);
    const stranded = t.unstickAccel > 0 && (loadedAll <= 2 || loadedDriven === 0) && speed3 < 3 && Uy > 0.5 && !this.righting;
    // (counted down, not cleared, when a wheel touches for a moment: a car
    // rocking on its belly would otherwise wait out the delay again and again)
    this.strandTime = stranded ? Math.min(this.strandTime + dt, t.unstickDelay + 0.3) : Math.max(0, this.strandTime - 2 * dt);
    let unstickX = 0, unstickZ = 0;
    if (stranded && driveAbs > 0.02) {
      const fl = Math.hypot(Fx, Fz);
      if (fl > 0.2) {
        // Pushed bodily along the nose (reverse: the tail), horizontally,
        // by the pedal the player is holding; fades out as the car moves.
        const push = t.unstickAccel * mass * grav * drive * clamp((this.strandTime - t.unstickDelay) / 0.3, 0, 1) * clamp((3 - speed3) / 1.5, 0, 1);
        unstickX = (Fx / fl) * push;
        unstickZ = (Fz / fl) * push;
      }
    }
    let rimSum = 0;
    let sumVx = 0, sumVy = 0, sumVz = 0, sumWx = 0, sumWy = 0, sumWz = 0;

    let dbgGrip = 1, dbgYaw = 0;
    // PROGRESSIVE REAR (tuning.slideCloseGrip): grip the rear tires are left
    // with while the slide closes at (nearly) the speed it is allowed to.
    const closeGripMin = govOn ? clamp(t.slideCloseGrip, 0.05, 1) : 1;
    // (low-passed over ~30 ms: the closing speed it is derived from contains
    // the lateral acceleration, i.e. the very force it scales)
    let closeGrip = this.closeGrip;
    const closeGripBlend = 1 - Math.exp(-h / 0.03);
    let closeGripWanted = 1;
    for (let step = 0; step < steps; step++) {
      let forceX = unstickX, forceY = -mass * grav, forceZ = unstickZ;
      let torqueX = 0, torqueY = 0, torqueZ = 0;
      let contacts = 0;

      for (let i = 0; i < 4; i++) {
        const r = this.rad[i];
        let omega = this.spin[i];
        let load = 0;
        let fLong = 0, fLat = 0;
        let txx = 0, txy = 0, txz = 0, tyx = 0, tyy = 0, tyz = 0;
        let rcx = 0, rcy = 0, rcz = 0;
        let gainG = 0;
        let ncx = 0, ncy = 0, ncz = 0;
        let contact = false;

        if (this.hit[i]) {
          const ax = this.nx[i], ay = this.ny[i], az = this.nz[i];
          let d = this.comp[i];
          const droop = this.droop[i];
          const travel = d < -droop ? -droop : d;
          // Wheel centre relative to the CoM.
          const lx = this.bx[i];
          const ly = this.by[i] + travel;
          const lz = this.bz[i];
          const rwx = Rx * lx + Ux * ly + Fx * lz;
          const rwy = Ry * lx + Uy * ly + Fy * lz;
          const rwz = Rz * lx + Uz * ly + Fz * lz;
          // Velocity of the chassis at the wheel centre.
          const pwx = vx + wy * rwz - wz * rwy;
          const pwy = vy + wz * rwx - wx * rwz;
          const pwz = vz + wx * rwy - wy * rwx;
          let up = ax * Ux + ay * Uy + az * Uz;
          if (up < 0.2) up = 0.2;
          // The wheel stays on the contact plane: travel rate along the axis.
          const rate = -(pwx * ax + pwy * ay + pwz * az) / up;
          if (step > 0) {
            d += rate * h;
            if (d > this.castTop[i]) d = this.castTop[i];
            this.comp[i] = d;
          }
          if (d > -droop) {
            contact = true;
            // --- suspension force along the axis
            const k = this.springK[i];
            const x = this.springX0[i] + d;
            let fs = x > 0 ? k * x : 0;
            const bump = this.bump[i];
            if (d > bump) fs += t.bumpStopRate * k * (d - bump);
            if (rate > 0) {
              const cb = this.dampB[i];
              fs += rate > kneeV ? cb * (kneeV + (rate - kneeV) * kneeRatio) : cb * rate;
              const zone = bump * (1 - t.bumpZone);
              if (d > zone && t.bumpZone > 0) {
                fs += cb * t.bumpZoneDamping * rate * Math.min(1, (d - zone) / (bump - zone));
              }
            } else {
              fs += this.dampR[i] * rate;
            }
            // Anti-roll bar: couples the two wheels of the axle.
            const j = i ^ 1;
            const other = this.hit[j] ? clamp(this.comp[j], -this.droop[j], this.bump[j]) : -this.droop[j];
            fs += this.arbK[i] * (clamp(d, -droop, bump) - other);
            fs = clamp(fs, 0, this.maxForce[i]);
            load = Math.min(fs / up, this.maxForce[i]);
          }
          if (load > 0) {
            // --- contact frame
            rcx = rwx - ax * r;
            rcy = rwy - ay * r;
            rcz = rwz - az * r;
            const pcx = vx + wy * (rwz - az * r) - wz * (rwy - ay * r);
            const pcy = vy + wz * (rwx - ax * r) - wx * (rwz - az * r);
            const pcz = vz + wx * (rwy - ay * r) - wy * (rwx - ax * r);
            const cs = this.steerCos[i], sn = this.steerSin[i];
            let hx = Fx * cs + Rx * sn, hy = Fy * cs + Ry * sn, hz = Fz * cs + Rz * sn;
            const hd = hx * ax + hy * ay + hz * az;
            hx -= ax * hd; hy -= ay * hd; hz -= az * hd;
            const hl = Math.hypot(hx, hy, hz);
            if (hl > 1e-4) {
              txx = hx / hl; txy = hy / hl; txz = hz / hl;
              tyx = ay * txz - az * txy;
              tyy = az * txx - ax * txz;
              tyz = ax * txy - ay * txx;
              const vLong = pcx * txx + pcy * txy + pcz * txz;
              const vSide = pcx * tyx + pcy * tyy + pcz * tyz;
              // --- tread deflection (normalised: slip ratio / tan slip angle)
              const rim = omega * r;
              const sLong = rim - vLong;
              const sSide = -vSide;
              const slipSpeed = Math.hypot(sLong, sSide);
              const conv = Math.max(Math.abs(vLong), Math.abs(rim), slipSpeed);
              const invX = 1 / (1 + conv * relaxX);
              const invY = 1 / (1 + conv * relax);
              const gain = relaxX * invX;
              let dx = (this.defX[i] + sLong * relaxX) * invX;
              let dy = (this.defY[i] + sSide * relax) * invY;
              const peakY = this.peakY[i];
              if (conv < fadeV) {
                // Near standstill the state is a real tread deflection, and a
                // tread cannot stay stretched past the point where it lets
                // go: without this a car braked (or slid) to a stop keeps the
                // "slip" it stopped with and is flung back by it.
                const stretch = Math.hypot(dx / peakX, dy / peakY);
                if (stretch > 1) {
                  const settle = 1 + (1 / stretch - 1) * (1 - conv / fadeV) * elasticBlend;
                  dx *= settle;
                  dy *= settle;
                }
              }
              // --- force from the deflection (combined slip, one circle)
              const loadRatio = load / this.staticLoad[i];
              let muN = this.mu[i] * clamp(1 - t.loadSensitivity * (loadRatio - 1), 0.6, 1.25) * load;
              if (burnLoss > 0 && this.driven[i]) {
                // Driven tire spinning AND sliding sideways: grip burns off
                // (see tuning.wheelspinGripLoss). Uses last sub-step's state.
                const spinning = clamp((this.defX[i] * driveDir / peakX - 1) / 3, 0, 1);
                const sideways = clamp(Math.abs(this.defY[i]) / peakY - 0.5, 0, 1);
                muN *= 1 - burnLoss * spinning * sideways;
              }
              if (closeGrip < 1 && !this.isFront[i]) muN *= closeGrip;
              if (slideLoss > 0 && !this.isFront[i]) {
                // ASSIST: rear tire past its peak slip angle with the throttle
                // open gives up grip in proportion to the throttle, whether
                // or not the motor can really spin it at this speed (see
                // tuning.powerSlideLoss). This is the throttle's handle on
                // the slide angle.
                // ... and gets it back once the slide is deeper than any
                // drift (powerSlideMaxAngle): a foot held down cannot keep
                // opening a slide into a spin.
                const side = Math.abs(this.defY[i]);
                let onset = 1;
                if (powerOver > 0) {
                  // Front tires past their peak (the car is being asked for
                  // more turn than it has): the rear lets go earlier.
                  const front = 0.5 * (Math.abs(this.defY[0]) / this.peakY[0] + Math.abs(this.defY[1]) / this.peakY[1]);
                  onset -= powerOver * clamp((front - 1) / 0.6, 0, 1);
                }
                const past = clamp((side / peakY - onset) / slideSpan, 0, 1);
                const deep = clamp((slideMaxTan - side) / slideFadeTan, 0, 1);
                muN *= 1 - slideLoss * past * deep;
                dbgGrip = i === 2 ? 1 - slideLoss * past * deep : 0.5 * (dbgGrip + 1 - slideLoss * past * deep);
              }
              const B = this.curveB[i], C = this.curveC[i];
              const ux = dx / peakX;
              const uy = dy / peakY;
              const rho = Math.hypot(ux, uy);
              let fOverRho = B * C;
              let slope = B * C;
              if (rho > 1e-6) {
                const at = Math.atan(B * rho);
                fOverRho = Math.sin(C * at) / rho;
                slope = (Math.cos(C * at) * C * B) / (1 + B * B * rho * rho);
                if (slope < 0) slope = 0;
              }
              fLong = muN * fOverRho * ux;
              fLat = muN * fOverRho * uy;
              // Standstill damping of the tire spring.
              const damp = this.tireDamp[i] * load * clamp(1 - conv / fadeV, 0, 1);
              fLong += damp * sLong;
              fLat += damp * sSide;
              // Stiffness of fLong against rim speed, for the implicit spin step.
              const share = rho > 1e-6 ? (ux * ux) / (rho * rho) : 0;
              gainG = (muN * (slope * share + fOverRho * (1 - share)) / peakX) * gain + damp;
              let mag = Math.hypot(fLong, fLat);
              if (mag > muN) {
                fLong *= muN / mag;
                fLat *= muN / mag;
              }
              // --- wheel spin: drive, then friction-type torques (which can
              // stop a wheel but never reverse it), implicit in gainG.
              const inertia = this.spinInertia[i] + h * gainG * r * r;
              let torque = -r * fLong;
              if (this.driven[i] && driveAbs > 0) {
                const along = rim * driveDir;
                const line = (freeSpeed - along) / fadeSpan;
                let limiter = clamp((rimCap - along) / limiterBand, 0, 1);
                if (spinAllow > 0) {
                  // Wheelspin limiter: torque fades as the rim outruns the
                  // ground by more than the allowed slip (see tuning).
                  const ground = Math.max(vLong * driveDir, 3);
                  const excess = spinAllow * ground;
                  limiter *= clamp((ground + excess - along) / (0.35 * excess + 0.25), 0, 1);
                }
                torque += driveDir * driveAbs * this.driveTorque[i] * clamp(line, 0, 1) * limiter;
              }
              let next = omega + (h * torque) / inertia;
              let friction = t.rollingResistance * load * r + engineBrake * this.engineBrakeTorque[i] + park * this.parkTorque[i];
              if (brake > 0) {
                let release = 1;
                if (absOn) {
                  // Anti-lock: let go as braking slip passes the peak.
                  // (sign of travel: works rolling backward too)
                  const slipN = (vLong < 0 ? dx : -dx) / peakX;
                  release = clamp((1.7 - slipN) / 0.7, 0, 1);
                }
                friction += brake * this.brakeTorque[i] * release;
              }
              const stop = (h * friction) / inertia;
              next = Math.abs(next) <= stop ? 0 : next - Math.sign(next) * stop;
              const dOmega = next - omega;
              fLong += gainG * r * dOmega;
              dx += r * dOmega * gain;
              mag = Math.hypot(fLong, fLat);
              if (mag > muN) {
                fLong *= muN / mag;
                fLat *= muN / mag;
              }
              omega = next;
              this.defX[i] = dx;
              this.defY[i] = dy;
              this.slipOut[i] = slipSpeed;
              this.rollOut[i] = Math.abs(vLong);
              // Backward lean of the contact normal (kerb face): optionally
              // softened, see tuning.obstacleDrag.
              ncx = ax; ncy = ay; ncz = az;
              if (t.obstacleDrag < 1) {
                // hd = how far the normal leans along the wheel's heading
                // (the heading before it was projected into the contact plane).
                const cut = hd * (1 - t.obstacleDrag);
                ncx -= (Fx * cs + Rx * sn) * cut;
                ncy -= (Fy * cs + Ry * sn) * cut;
                ncz -= (Fz * cs + Rz * sn) * cut;
              }
            } else {
              load = 0;
            }
          }
        }

        if (load > 0) {
          contacts++;
          // Normal + longitudinal force act at the contact patch.
          const fx = ncx * load + txx * fLong;
          const fy = ncy * load + txy * fLong;
          const fz = ncz * load + txz * fLong;
          // The side force acts `forceLever` above it (tuning.tireForceHeight)
          // — and, as the car leans on its tires, up to the height of the
          // centre of mass, where it cannot trip the car (tuning.tipGuardStart).
          const sx = tyx * fLat, sy = tyy * fLat, sz = tyz * fLat;
          const gx = this.nx[i], gy = this.ny[i], gz = this.nz[i];
          let lever = forceLever;
          if (tipOn) {
            // sin(roll relative to the ground under this wheel) and its rate.
            const lean = Rx * gx + Ry * gy + Rz * gz;
            const leanRate = (wy * Rz - wz * Ry) * gx + (wz * Rx - wx * Rz) * gy + (wx * Ry - wy * Rx) * gz;
            const hazard = (Math.abs(lean + leanRate * tipLead) - tipSin0) / tipSpan;
            if (hazard > 0) {
              const full = -(rcx * gx + rcy * gy + rcz * gz);
              if (full > lever) lever += (full - lever) * (hazard < 1 ? hazard : 1);
            }
          }
          const qx = rcx + gx * lever;
          const qy = rcy + gy * lever;
          const qz = rcz + gz * lever;
          forceX += fx + sx; forceY += fy + sy; forceZ += fz + sz;
          torqueX += rcy * fz - rcz * fy + qy * sz - qz * sy;
          torqueY += rcz * fx - rcx * fz + qz * sx - qx * sz;
          torqueZ += rcx * fy - rcy * fx + qx * sy - qy * sx;
        } else {
          // Wheel in the air (or unloaded): spins freely on drive / brakes.
          const inertia = this.spinInertia[i];
          let torque = 0;
          if (this.driven[i] && driveAbs > 0) {
            const along = omega * r * driveDir;
            const line = (freeSpeed - along) / fadeSpan;
            const limiter = clamp((rimCap - along) / limiterBand, 0, 1);
            torque = driveDir * driveAbs * this.driveTorque[i] * clamp(line, 0, 1) * limiter;
          }
          let next = omega + (h * torque) / inertia;
          const friction = 0.002 * this.staticLoad[i] * r + engineBrake * this.engineBrakeTorque[i] +
            brake * this.brakeTorque[i] + park * this.parkTorque[i];
          const stop = (h * friction) / inertia;
          next = Math.abs(next) <= stop ? 0 : next - Math.sign(next) * stop;
          omega = next;
          // The tread relaxes.
          const decay = 1 / (1 + Math.max(Math.abs(omega * r), 1) * relax);
          this.defX[i] *= decay;
          this.defY[i] *= decay;
          if (!contact) {
            this.slipOut[i] = 0;
            this.rollOut[i] = 0;
          }
        }
        this.spin[i] = omega;
        this.wheelLoad[i] = load;
      }

      // Limited-slip coupling across each driven axle.
      if (diffBlend > 0) {
        for (let a = 0; a < 4; a += 2) {
          if (!this.driven[a] || !this.driven[a + 1]) continue;
          const ia = this.spinInertia[a], ib = this.spinInertia[a + 1];
          const mean = (this.spin[a] * ia + this.spin[a + 1] * ib) / (ia + ib);
          this.spin[a] += (mean - this.spin[a]) * diffBlend;
          this.spin[a + 1] += (mean - this.spin[a + 1]) * diffBlend;
        }
      }

      // Aerodynamic drag.
      if (t.aeroDrag > 0 || scrub > 0) {
        const speed = Math.hypot(vx, vy, vz);
        const drag = (t.aeroDrag + scrub) * speed * mass;
        forceX -= drag * vx; forceY -= drag * vy; forceZ -= drag * vz;
      }

      // ASSIST: yaw governor in a slide (see tuning.slideYawDamping).
      if (contacts >= 2) {
        const f = vx * Fx + vy * Fy + vz * Fz;
        const s = vx * Rx + vy * Ry + vz * Rz;
        const v2 = f * f + s * s;
        // Fades in between 2 and 4 m/s (no step at a threshold speed).
        if (v2 > 4) {
          // "Sliding" is judged at the REAR AXLE: the body slip angle at the
          // CoM is ~10 deg in any tight low-speed turn (pure kinematics), and
          // a damper keyed to that fights ordinary turn-in / turn-out — which
          // is what kept an over-held opposite lock weaving for seconds.
          const yawNow = wx * Ux + wy * Uy + wz * Uz;
          const slip = Math.atan2(s + yawNow * rearArm, Math.abs(f));
          const beta = Math.abs(slip);
          // Rate at which the direction of travel is turning (about up).
          const ax = forceX / mass, az = forceZ / mass, ay = forceY / mass;
          const aF = ax * Fx + ay * Fy + az * Fz;
          const aS = ax * Rx + ay * Ry + az * Rz;
          const courseRate = (aS * f - aF * s) / v2;
          // d(beta)/dt = courseRate − yawRate (beta = course − heading).
          const dir = f >= 0 ? 1 : -1;
          const betaRate = dir * (courseRate - yawNow);
          slipRateSum += betaRate;
          // For a CLOSING slide it is still there for a moment after the rear
          // has hooked up (slideMemory): the slide passes through zero under
          // its control. An opening one is only resisted once the rear is
          // clearly past its peak, as before — a flick or a brake tap must
          // be able to get the tail out.
          const fade = v2 < 16 ? (Math.sqrt(v2) - 2) / 2 : 1;
          const opening = clamp((beta - slideStart) / (8 * DEG), 0, 1);
          const weight = (betaRate * slip > 0 ? opening : Math.max(opening, slideMemory)) * fade;
          if (weight > 0 && govOn) {
            // Rate of the slide ANGLE: + = opening.
            //  - An OPENING slide is always resisted: it develops at a pace
            //    a human can react to.
            //  - A CLOSING one is resisted in proportion to the driver's
            //    hold demand (foot down, stick not against the turn): the
            //    slide lingers and can be ridden; the tires still push it
            //    shut through that damping if nothing feeds it.
            //  - ... and, whatever the hold, it may not close faster than
            //    `limit` rad/s — what the stick asks for this frame (slow on
            //    a lift, fast with opposite lock), tapering off as the angle
            //    runs out so the car arrives at zero slip without the yaw
            //    rate that would carry it through to the other side. That
            //    limit is held firmly (CLOSE_STIFFNESS x the gain): a soft
            //    one lets the rear tires, which push a lifted slide shut
            //    with ~25 rad/s², run far past it.
            const sign = slip < 0 ? -1 : 1;
            const rate = betaRate * sign;
            const limit = Math.min(closeLimit, beta * closeTaper + CLOSE_MIN);
            // The limit is kept first of all by the REAR TIRES themselves:
            // from half the allowed closing speed up they give up grip, down
            // to `slideCloseGrip` at the limit — the rear "comes back"
            // progressively instead of hooking up in one go, and because it
            // then pushes less the car is not hauled round toward where the
            // nose points while the slide closes. (Used in the next
            // sub-step; the torque below is what is left to do.)
            closeGripWanted = -rate > 0.5 * limit ? 1 - (1 - closeGripMin) * weight * clamp((-rate - 0.5 * limit) / (0.5 * limit), 0, 1) : 1;
            const error = rate > 0 ? rate * assist : holdDemand * rate * assist + (rate < -limit ? (rate + limit) * CLOSE_STIFFNESS : 0);
            if (error !== 0) {
              // (an opening slide is resisted with at most slideYawDampingMax,
              // the closing-speed limit is held with up to slideCloseMax)
              const cap = rate > 0 ? govMax : govCloseMax;
              const accel = clamp(govGain * error * sign * dir * weight, -cap, cap);
              const m = accel * this.inertiaY;
              dbgYaw = accel;
              torqueX += Ux * m; torqueY += Uy * m; torqueZ += Uz * m;
            }
          }
        }
      }

      closeGrip += (closeGripWanted - closeGrip) * closeGripBlend;
      closeGripWanted = 1;

      // --- integrate the chassis velocity
      const invM = h / mass;
      vx += forceX * invM;
      vy += forceY * invM;
      vz += forceZ * invM;
      const tr = (torqueX * Rx + torqueY * Ry + torqueZ * Rz) / this.inertiaX;
      const tu = (torqueX * Ux + torqueY * Uy + torqueZ * Uz) / this.inertiaY;
      const tf = (torqueX * Fx + torqueY * Fy + torqueZ * Fz) / this.inertiaZ;
      wx += (Rx * tr + Ux * tu + Fx * tf) * h;
      wy += (Ry * tr + Uy * tu + Fy * tf) * h;
      wz += (Rz * tr + Uz * tu + Fz * tf) * h;

      // ASSISTS that act on a car (partly) off the ground. `air` is how
      // airborne it is: 1 with no wheel loaded, less with one or two, 0 from
      // three up — a ramp rather than a switch at the last wheel leaving.
      const air = contacts === 0 ? 1 : contacts === 1 ? airShare1 : contacts === 2 ? airShare2 : 0;
      if (air > 0 || rightBlend > 0) {
        // Shortest axis to upright: U x worldUp. Past 90 deg a share of the
        // roll axis is mixed in (toward the side the car already leans to),
        // so the axis stays defined through the fully inverted pose.
        let ex = -Uz, ey = 0, ez = Ux;
        if (Uy < 0) {
          const s = (Ry < 0 ? -0.3 : 0.3) * Uy;
          ex += Fx * s; ey += Fy * s; ez += Fz * s;
        }
        const el = Math.hypot(ex, ey, ez);
        if (el > 1e-4) {
          ex /= el; ey /= el; ez /= el;
          const tilt = Math.atan2(Math.hypot(Ux, Uz), Uy);
          let accel = 0;
          if (rightBlend > 0) {
            // ASSIST: self-righting — a bounded angular-velocity servo.
            const rate = wx * ex + wy * ey + wz * ez;
            const want = t.selfRightRate * clamp((tilt - 0.35) / 0.7, 0.2, 1);
            const er = ex * Rx + ey * Ry + ez * Rz;
            const eu = ex * Ux + ey * Uy + ez * Uz;
            const ef = ex * Fx + ey * Fy + ez * Fz;
            const limit = rightTorque / (this.inertiaX * er * er + this.inertiaY * eu * eu + this.inertiaZ * ef * ef);
            accel = clamp((want - rate) * 15, -limit, limit) * rightBlend;
          } else if (airLevel > 0) {
            // ASSIST: air levelling (see tuning.airLevel).
            accel = Math.min(airLevel * Math.min(tilt, 1.2), airMax) * air * flight;
          }
          wx += ex * accel * h; wy += ey * accel * h; wz += ez * accel * h;
        }
        // ASSIST: air stabiliser — pitch/roll rates decay while airborne
        // (not while the car is being rolled back onto its wheels).
        const keep = airBlend * air * (1 - rightBlend);
        if (keep > 0) {
          const pr = (wx * Rx + wy * Ry + wz * Rz) * keep;
          const rr = (wx * Fx + wy * Fy + wz * Fz) * keep;
          wx -= Rx * pr + Fx * rr;
          wy -= Ry * pr + Fy * rr;
          wz -= Rz * pr + Fz * rr;
        }
        // ASSIST: ... and so does a spin (see tuning.airYawDamping).
        if (yawAirBlend > 0 && air > 0) {
          const yr = (wx * Ux + wy * Uy + wz * Uz) * yawAirBlend * air;
          wx -= Ux * yr; wy -= Uy * yr; wz -= Uz * yr;
        }
      }

      // --- carry the orientation copy along (first order, re-orthonormalised)
      const ex = wx * h, ey = wy * h, ez = wz * h;
      const nRx = Rx + ey * Rz - ez * Ry, nRy = Ry + ez * Rx - ex * Rz, nRz = Rz + ex * Ry - ey * Rx;
      const nUx = Ux + ey * Uz - ez * Uy, nUy = Uy + ez * Ux - ex * Uz, nUz = Uz + ex * Uy - ey * Ux;
      const rl = 1 / Math.hypot(nRx, nRy, nRz);
      Rx = nRx * rl; Ry = nRy * rl; Rz = nRz * rl;
      const ud = nUx * Rx + nUy * Ry + nUz * Rz;
      const oUx = nUx - Rx * ud, oUy = nUy - Ry * ud, oUz = nUz - Rz * ud;
      const ul = 1 / Math.hypot(oUx, oUy, oUz);
      Ux = oUx * ul; Uy = oUy * ul; Uz = oUz * ul;
      Fx = Ry * Uz - Rz * Uy;
      Fy = Rz * Ux - Rx * Uz;
      Fz = Rx * Uy - Ry * Ux;

      sumVx += vx; sumVy += vy; sumVz += vz;
      sumWx += wx; sumWy += wy; sumWz += wz;
      rimSum += this.driven[2] || this.driven[3]
        ? (this.spin[2] * this.rad[2] + this.spin[3] * this.rad[3]) / 2
        : (this.spin[0] * this.rad[0] + this.spin[1] * this.rad[1]) / 2;
    }

    if (Number.isFinite(vx + vy + vz + wx + wy + wz)) {
      // HAND-OFF. Havok moves the body by (velocity it is given) x dt. Given
      // the end-of-frame velocity, the pose lags the sub-stepped motion by
      // half a frame of every acceleration (braking 20 -> 0 came out 0.5 m
      // shorter at 20 Hz than at 240 Hz: v·dt/2). Given the MEAN of the
      // sub-step velocities it lands exactly where the sub-steps went, at
      // any frame rate. The difference to the end velocity is put back
      // right after the physics step (afterPhysics), so everything that
      // reads the body's velocity — telemetry, camera, AI — still sees the
      // true end-of-frame value, plus whatever a hull contact did to it.
      if (t.meanVelocityHandoff > 0.5) {
        const inv = 1 / steps;
        this.tmpV.set(sumVx * inv, sumVy * inv, sumVz * inv);
        this.tmpW.set(sumWx * inv, sumWy * inv, sumWz * inv);
        this.carryV[0] = vx - this.tmpV.x; this.carryV[1] = vy - this.tmpV.y; this.carryV[2] = vz - this.tmpV.z;
        this.carryW[0] = wx - this.tmpW.x; this.carryW[1] = wy - this.tmpW.y; this.carryW[2] = wz - this.tmpW.z;
        this.carryPending = true;
      } else {
        this.tmpV.set(vx, vy, vz);
        this.tmpW.set(wx, wy, wz);
        this.clearCarry();
      }
      this.sweepHull(dt, q);
      body.setLinearVelocity(this.tmpV);
      body.setAngularVelocity(this.tmpW);
    } else {
      // Should be unreachable; never hand Havok a NaN.
      this.spin.fill(0);
      this.defX.fill(0);
      this.defY.fill(0);
      this.clearCarry();
    }
    this._drivenRimSpeed = rimSum / steps;
    this.slipRate = slipRateSum / steps;
    this.closeGrip = closeGrip;
    this.debug[9] = closeGrip;
    this.debug[3] = dbgGrip;
    this.debug[4] = dbgYaw;
    this.debug[5] = 0.5 * (this.defY[2] / this.peakY[2] + this.defY[3] / this.peakY[3]);
    this.debug[6] = 0.5 * (this.defX[2] + this.defX[3]) / Math.max(t.peakSlipRatio, 0.02);

    // ------------------------------------------------- wheel telemetry
    // Poses use the frame-start chassis pose (what is on screen this frame).
    for (let i = 0; i < 4; i++) {
      const state = this.wheelStates[i];
      const travel = clamp(this.comp[i], -this.droop[i], this.castTop[i]);
      this.suspensionTravel[i] = travel;
      const lx = this.bx[i], ly = this.by[i] + travel, lz = this.bz[i];
      const ox = R0x * lx + U0x * ly + F0x * lz;
      const oy = R0y * lx + U0y * ly + F0y * lz;
      const oz = R0z * lx + U0z * ly + F0z * lz;
      state.position.set(cmx + ox, cmy + oy, cmz + oz);
      state.velocity.set(
        vx + wy * oz - wz * oy,
        vy + wz * ox - wx * oz,
        vz + wx * oy - wy * ox,
      );
      state.grounded = this.wheelLoad[i] > 0.02 * this.staticLoad[i];
      state.steerAngle = this.wheelSteer[i];
      state.spinSpeed = this.spin[i];
      state.rollSpeed = state.grounded ? this.rollOut[i] : Math.abs(this.spin[i] * this.rad[i]);
      state.slipSpeed = state.grounded ? this.slipOut[i] : 0;
      this.wheelRotation[i] = (this.wheelRotation[i] + this.spin[i] * dt) % (2 * Math.PI);
    }
    this.visual.capture(this.wheelStates, dt, intent, this.currentSteerAngle, this.isReversing);
  }

  /**
   * Self-righting state machine, once per frame (see tuning.selfRightDelay).
   * Returns the 0..1 strength of the righting servo for this frame.
   * @param upY world-up component of the chassis up axis (cos of the tilt)
   */
  private updateSelfRighting(dt: number, upY: number, speed: number, spin: number): number {
    const t = this.tuning;
    let loaded = 0;
    for (let i = 0; i < 4; i++) if (this.wheelLoad[i] > 0.02 * this.staticLoad[i]) loaded++;
    if (!this.righting) {
      // Resting off the wheels: tilted, (almost) no wheel carrying, slow.
      const stuck = t.selfRightDelay > 0 && upY < Math.cos(clamp(t.selfRightTilt, 20, 170) * DEG) &&
        loaded < 2 && speed < 2.5 && spin < 3;
      this.stuckTime = stuck ? this.stuckTime + dt : 0;
      if (stuck && this.stuckTime >= t.selfRightDelay) {
        this.righting = true;
        this.rightTime = 0;
      }
    } else {
      this.rightTime += dt;
      // Done (wheels under the car again), knocked away, or no way up from
      // here: let go and start over.
      if (t.selfRightDelay <= 0 || upY > 0.866 || loaded >= 3 || speed > 10 || this.rightTime > 4) {
        this.righting = false;
        this.stuckTime = 0;
      }
    }
    this.rightBlend = clamp(this.rightBlend + (this.righting ? dt / 0.3 : -dt / 0.15), 0, 1);
    return this.rightBlend;
  }

  /** True while the self-righting assist is turning the car back onto its
   * wheels (the game can hold a "rescue" prompt back for that long). */
  get isSelfRighting(): boolean {
    return this.righting;
  }

  /**
   * TIME-OF-IMPACT CLAMP (tuning.impactSweep). Havok collides at discrete
   * steps: at 20 m/s and 30 Hz the hull is 0.67 m inside a wall, a rock or
   * another car before the contact is even seen, and the solver then pushes
   * it out along whatever direction is shortest — often UP (lab: a T-bone at
   * 30 Hz lifted the struck car 0.48 m; the same hit at 60 Hz: 0.02 m).
   * So the hull is swept along this frame's travel first; if it would run
   * into something steep, the body is only moved up to the contact this
   * frame (it is handed a scaled-down velocity; the rest goes into the
   * carry and is back on the body right after the step). Next frame Havok
   * finds the two touching, with the full approach speed, and answers the
   * hit the same way at any frame rate.
   * Works on `this.tmpV`, the velocity about to be handed to Havok.
   */
  private sweepHull(dt: number, rotation: Quaternion): void {
    if (this.tuning.impactSweep < 0.5) return;
    const v = this.tmpV;
    const travel = Math.hypot(v.x, v.y, v.z) * dt;
    if (travel < SWEEP_MIN_TRAVEL) return;
    const query = this.sweepQuery;
    const pos = this.chassisMesh.position;
    query.rotation.copyFrom(rotation);
    query.startPosition.copyFrom(pos);
    query.endPosition.set(pos.x + v.x * dt, pos.y + v.y * dt, pos.z + v.z * dt);
    this.plugin.shapeCast(query, this.castIn, this.castHit);
    const hit = this.castHit;
    if (!hit.hasHit) return;
    const f0 = hit.hitFraction;
    // 0 = already touching (Havok has that contact); 1 = nothing in reach.
    if (!(f0 > 0.02 && f0 < 1)) return;
    const n = hit.hitNormal;
    const nl = Math.hypot(n.x, n.y, n.z);
    // Only walls, rocks, trees, cars: ground and ramps are the wheels' job
    // (a straight sweep does not know the suspension will lift the hull).
    if (!(nl > 0.5) || Math.abs(n.y) > 0.6 * nl) return;
    // The other body may be moving too: time of impact from the closing speed.
    let fraction = f0;
    const other = hit.body;
    if (other && other.getMotionType() === PhysicsMotionType.DYNAMIC) {
      other.getLinearVelocityToRef(this.tmpO);
      const along = (this.tmpO.x * v.x + this.tmpO.y * v.y + this.tmpO.z * v.z) * dt * dt / travel;
      const closing = travel - along;
      if (closing <= 1e-4) return;
      fraction = (f0 * travel) / closing;
      if (fraction >= 1) return;
    }
    // Not worth it for a graze of a few centimetres.
    if ((1 - fraction) * travel < 0.04) return;
    const keep = 1 - fraction;
    this.carryV[0] += v.x * keep; this.carryV[1] += v.y * keep; this.carryV[2] += v.z * keep;
    this.carryPending = true;
    v.set(v.x * fraction, v.y * fraction, v.z * fraction);
  }

  private clearCarry(): void {
    this.carryV.fill(0);
    this.carryW.fill(0);
    this.carryPending = false;
  }

  /**
   * Right after the physics step: Havok has moved the body with the mean
   * velocity of the frame; give the body its end-of-frame velocity back
   * (plus whatever a hull contact changed in the step).
   */
  private afterPhysics(): void {
    if (!this.carryPending) return;
    const body = this.chassisBody;
    body.getLinearVelocityToRef(this.tmpV);
    body.getAngularVelocityToRef(this.tmpW);
    const c = this.carryV, d = this.carryW;
    if (Number.isFinite(this.tmpV.x + this.tmpV.y + this.tmpV.z + this.tmpW.x + this.tmpW.y + this.tmpW.z)) {
      this.tmpV.set(this.tmpV.x + c[0], this.tmpV.y + c[1], this.tmpV.z + c[2]);
      this.tmpW.set(this.tmpW.x + d[0], this.tmpW.y + d[1], this.tmpW.z + d[2]);
      body.setLinearVelocity(this.tmpV);
      body.setAngularVelocity(this.tmpW);
    }
    this.clearCarry();
  }

  // ------------------------------------------------------ reset / motion

  reset(groundPoint: Vector3, yaw: number): void {
    const mesh = this.chassisMesh;
    mesh.position.set(groundPoint.x, groundPoint.y + this.originY, groundPoint.z);
    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
    Quaternion.FromEulerAnglesToRef(0, yaw, 0, mesh.rotationQuaternion);
    mesh.computeWorldMatrix(true);
    const body = this.chassisBody;
    body.disablePreStep = false;
    body.setLinearVelocity(RESET_KICK);
    body.setAngularVelocity(RESET_KICK);
    body.setLinearVelocity(Vector3.ZeroReadOnly);
    body.setAngularVelocity(Vector3.ZeroReadOnly);
    this.preStepFrames = 2;
    this.clearCarry();
    this.spin.fill(0);
    this.defX.fill(0);
    this.defY.fill(0);
    this.comp.fill(0);
    this.hit.fill(0);
    this.wheelLoad.fill(0);
    this.steerAngle = 0;
    this.brakeMode = NONE;
    this.standTime = 0;
    this.brakeFromSpeed = 0;
    this.brakeLatched = true;
    this.reverseIntent = false;
    this.reverseRamp = 1;
    this.strandTime = 0;
    this.slideHold = 0;
    this.mapBlend = 0;
    this.slipRate = 0;
    this.latch = 0;
    this.catchPeak = 0;
    this.catchTime = 0;
    this.catchHeld = 0;
    this.hookedTime = 0;
    this.brakePrev = 0;
    this.slidePeak = 0;
    this.lossState = 0;
    this.closeGrip = 1;
    this.held = 0;
    this.fed = 0;
    this.parked = false;
    this.stuckTime = 0;
    this.righting = false;
    this.rightTime = 0;
    this.rightBlend = 0;
    this.travelValid = false;
    this._forwardSpeed = 0;
    this._drivenRimSpeed = 0;
    this._reversing = false;
    this.visual.reset();
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    for (let i = 0; i < 4; i++) {
      const w = this.rig.wheels[i];
      const state = this.wheelStates[i];
      state.position.set(
        groundPoint.x + w.x * cos + w.z * sin,
        groundPoint.y + w.y,
        groundPoint.z - w.x * sin + w.z * cos,
      );
      state.velocity.setAll(0);
      state.grounded = true;
      state.rollSpeed = 0;
      state.slipSpeed = 0;
      state.steerAngle = 0;
      state.spinSpeed = 0;
      this.wheelSteer[i] = 0;
      this.steerCos[i] = 1;
      this.steerSin[i] = 0;
    }
  }

  setMotion(velocity: Vector3, yawRate: number): void {
    const mesh = this.chassisMesh;
    mesh.computeWorldMatrix(true);
    const fwd = mesh.forward;
    const up = mesh.up;
    // CoM relative to the mesh origin, world space.
    const rx = up.x * this.comY + fwd.x * this.comZ;
    const rz = up.z * this.comY + fwd.z * this.comZ;
    // v_point = v + ω × r with ω = (0, yawRate, 0).
    this.chassisBody.setLinearVelocity(new Vector3(velocity.x + yawRate * rz, velocity.y, velocity.z - yawRate * rx));
    this.chassisBody.setAngularVelocity(new Vector3(0, yawRate, 0));
    this.clearCarry();
    const forward = velocity.x * fwd.x + velocity.y * fwd.y + velocity.z * fwd.z;
    for (let i = 0; i < 4; i++) {
      // Rolling without slip for the forward component (incl. the yaw arm).
      this.spin[i] = (forward - yawRate * this.bx[i]) / this.rad[i];
      this.defX[i] = 0;
      this.defY[i] = 0;
      this.wheelStates[i].spinSpeed = this.spin[i];
    }
    this._forwardSpeed = forward;
    // An imposed slide: bring the slide-steering map up to date so that
    // stickForSteerAngle() is right before the first update().
    const t = this.tuning;
    const right = mesh.right;
    const lateral = velocity.x * right.x + velocity.y * right.y + velocity.z * right.z;
    const planar = Math.hypot(forward, lateral);
    this.mapBlend = 0;
    this.slideHold = 0;
    this.slipRate = 0;
    this.latch = 0;
    this.catchPeak = 0;
    this.catchTime = 0;
    this.catchHeld = 0;
    this.hookedTime = 0;
    this.brakePrev = 0;
    this.slidePeak = 0;
    this.lossState = 0;
    this.closeGrip = 1;
    this.held = 0;
    this.fed = 0;
    this.travelValid = false;
    const steerAssist = clamp(t.counterSteerAssist, 0, 1) * clamp(2 * t.assistLevel, 0, 1);
    if (planar > 2 && forward > 0) {
      const ahead = Math.max(forward, 1);
      const travel = Math.atan2(lateral + yawRate * (this.rig.front.z - this.comZ), ahead);
      const rearSlip = Math.abs(Math.atan2(lateral + yawRate * (this.rig.rear.z - this.comZ), ahead));
      const sliding = clamp((rearSlip - t.counterSteerStart * DEG) / (6 * DEG), 0, 1) * clamp((planar - 2) / 3, 0, 1);
      this.slideHold = sliding;
      this.travelPrev = travel;
      this.travelValid = true;
      // (the map of a driver who is on the throttle: see update())
      this.mapBlend = steerAssist * sliding;
      this.mapTravel = travel;
      this.mapSide = lateral + yawRate * (this.rig.rear.z - this.comZ) < 0 ? -1 : 1;
      this.mapKeep = t.counterSteerSlipPower * DEG;
      // (nobody has fed this slide yet: no centre-stick feed, see `fed`)
      this.mapFed = Math.max(clamp(t.classicDrift, 0, 1), clamp(t.slideHoldUnfed, 0, 1));
      this.mapBase = this.mapKeep * clamp(t.counterSteerNeutral, 0, 1) * this.mapFed;
      this.mapOver = (t.counterSteerCap > 0 ? t.counterSteerCap : 4) * DEG;
      this.mapTrim = Math.min(t.counterSteerAngleGain * rearSlip, 12 * DEG);
      this.mapThrHold = 1;
      this.mapHeld = 0;
      this.mapRearSlip = rearSlip;
      this.mapClosing = 0;
    }
  }

  dispose(): void {
    if (this.afterPhysicsObserver) this.scene.onAfterPhysicsObservable.remove(this.afterPhysicsObserver);
    this.afterPhysicsObserver = null;
    this.chassisBody.dispose();
    this.hullShape.dispose();
    for (const shape of this.castShapes) shape.dispose();
    this.chassisMesh.dispose();
  }
}
