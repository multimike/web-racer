import { ArcRotateCamera, UniversalCamera, Vector3 } from '@babylonjs/core';
import { moveFollowMark } from './followed';
import type { Camera, Scene } from '@babylonjs/core';
import type { Vehicle } from '../../car/Vehicle';
import { LOOK_VIEWS } from '../../gfx/look/lighting';
import type { CameraRig, CameraRigOptions, CameraTuning, CreateCameraRig, ViewLook, ViewMode } from '../contracts/camera';

/**
 * Something the HIGH camera must not look through: an upright box on the
 * ground (the start gantry's beam and banner), in world metres. `yaw` turns
 * the box's local +z (its depth axis, along the road) like a car's heading.
 */
export interface CameraOccluder {
  x: number;
  z: number;
  yaw: number;
  /** Half the span across the road, m. */
  halfWidth: number;
  /** Half the depth along the road, m. */
  halfDepth: number;
  /** World y of the box's upper edge (the sight line must clear it; its
   * lower edge never matters to a camera above the car). */
  top: number;
}

/** The contract's options plus the game's occluders (the high camera eases
 * toward overhead while the car passes under one; see FollowMode.liftNeed). */
export interface GameCameraRigOptions extends CameraRigOptions {
  occluders?: readonly CameraOccluder[];
}

/**
 * The game's cameras (contract: src/game/contracts/camera.ts).
 *
 *  chase  low and close behind the car — the gameplay vision's first image
 *         (the car, tire to tire, about a third of the frame wide).
 *  high   elevated follow — the vision's second image (the car about a
 *         tenth of the frame wide).
 *  xr     the desktop preview of the XR diorama: eye 85 m up and 85 m back
 *         from the world centre, looking 45° down (= a 1.7 m viewer at a 4 m
 *         table, world scale 1/50), orbit / zoom with the mouse.
 *
 * chase and high are plain `UniversalCamera`s with NO input attached: `update`
 * writes position and rotation from the chassis pose the physics step just
 * produced, so they never lag a frame behind the car. Heading follows a target
 * yaw with a first-order lag, `yaw += wrap(target − yaw)·(1 − e^(−dt/τ))`;
 * the target is the chassis yaw pulled halfway toward the direction of travel
 * above 4 m/s (at most ±35°), so in a drift the camera shows the car's side
 * and still looks down the road. The car's height is smoothed (heightTau) so
 * bumps do not shake the frame; the eye never goes below the ground +
 * `minClearance`.
 *
 * Every mode is a self-contained controller (camera, enter / leave, update,
 * snap) in `modes`, so a fourth one — the WebXR camera under a ×50 rig node —
 * can be added without touching these three. Nothing here is parented to a
 * scaled node and the world is never scaled (CLAUDE.md, XR diorama).
 *
 * Framing that does not depend on the car or the window:
 *  - chase `distance` is the distance for the reference car (reef-rocket);
 *    for another design the eye moves so the car's widest axle (tire to tire)
 *    projects as wide as reef-rocket's rear axle does (riot-ram is 10 %
 *    wider and sat 37 % of the frame wide at the same distance).
 *  - `fov` is the vertical field of view at 16:9 and wider. A narrower window
 *    keeps the 16:9 HORIZONTAL field of view instead (the vertical one opens
 *    up, capped), so the car stays about a third of the width in a 4:3 or
 *    square window instead of filling it.
 *  - the speed terms (`speedDistance`, `speedFov`) follow a smoothed speed
 *    (SPEED_TAU), so a crash does not jump the camera in one frame.
 *
 * MENU OFFSET (`setLateralOffset`): in chase and high the eye AND the look-at
 * point slide `m` metres to the camera's left, so the car stands right of the
 * menu band; the shift eases with LATERAL_TAU (0.35 s), `snap()` settles it,
 * it survives `setMode` / `setSubject` and xr ignores it. The shadow / detail
 * `focus` stays on the car. 0 (the race) is the plain rig, bit for bit.
 *
 * No allocations in `update`.
 */

/** Plain numbers, live-tweakable from the console; the terrain and props
 * labs pose their still cameras from the same object. */
export const CAMERA_TUNING: CameraTuning = {
  chase: {
    // Tuned against the vision's first image (1672 × 941): car tire to tire
    // about a third of the width, its centre ~70 % down the frame, horizon
    // ~27 % from the top (pitch ≈ 14°).
    // Closer than before (5.6 → 5.2) and much weaker speed terms (0.9 /
    // 0.12 → 0.15 / 0.03): at 20 m/s the car shrank to 22 % of the width.
    // Now ≈ 34–35 % at rest, ≈ 31–32 % at racing speed (the drive lab's
    // report measures both). Eye lowered 3.0 → 2.4 and the look-at pulled in
    // (lookUp 0.5, lookAhead 3.5) so the closer car does not sit on the
    // bottom edge: pitch ≈ 12.3°, horizon ≈ 24 % from the top, rear tires
    // ending ≈ 90 % down.
    distance: 5.2,
    height: 2.4,
    lookUp: 0.5,
    lookAhead: 3.5,
    fov: 0.8,
    speedDistance: 0.15,
    speedFov: 0.03,
    yawTau: 0.18,
    heightTau: 0.12,
    minClearance: 0.8,
  },
  // Framed like the vision's second image — the car about 9–10 %
  // of the frame width at 16:9 (11 / 14 / 4 gave about 15 %), centre ~76 %
  // down the frame so there is more road ahead than behind, the same
  // three-quarter pitch (≈ 41° down; it was 42°).
  high: { distance: 17, height: 22.5, lookAhead: 8, fov: 0.7, yawTau: 0.8 },
  xr: { eyeHeight: 85, back: 85, minRadius: 8, maxRadius: 220 },
};

/** Speed above which the travel direction starts to pull the camera, m/s,
 * and the speed by which the pull is complete (a ramp, so it does not pop). */
const DRIFT_PULL_FROM = 4;
const DRIFT_PULL_FULL = 6;
const DRIFT_PULL_MAX = (35 * Math.PI) / 180;
/** The pull fades out between these forward speeds, m/s (reversing: chassis
 * yaw only) — a ramp, so a car spinning through 90° of slip does not make the
 * target jump by 35° when forwardSpeed crosses −1. */
const DRIFT_FWD_ZERO = -1;
const DRIFT_FWD_FULL = 1;
/** Time constant of the speed the zoom / fov terms follow, s. */
const SPEED_TAU = 0.35;
/** Aspect at and above which `fov` is the vertical fov (16:9). */
const REF_ASPECT = 16 / 9;
/** Vertical fov ceiling for very narrow windows, rad. */
const MAX_VFOV = 1.5;
/** Reference car for the chase distance: reef-rocket's rear axle, tire to
 * tire (track 1.61 + tire 0.44) and its distance behind the model origin
 * (half its 2.2 m wheelbase). */
const REF_AXLE_WIDTH = 2.05;
const REF_AXLE_Z = -1.1;
const MODE_ORDER: readonly ViewMode[] = ['chase', 'high', 'xr'];
/** Most the smoothed car height may trail a DESCENDING car, m (finding: at
 * heightTau 0.12 a 3 m/s descent lowered the car 0.36 m in the frame — the
 * rear tires' whole margin at rest). */
const MAX_DROP_LAG = 0.12;
/** xr: lowest eye height above the ground under it, m (zoomed in at the
 * beta limit the eye was 0.96 m above y = 0 — inside a hill). */
const XR_MIN_EYE = 3;
/**
 * xr default pose on top of CAMERA_TUNING.xr (which stays the "1.7 m viewer
 * at a 4 m table" definition the labs pose from): the orbit target sits
 * `targetZ` m toward the viewer from the table centre and the eye `scale`
 * times further out along its 45° line — eye (0, 103.7, −103.7) instead of
 * (0, 85, −85), i.e. the same viewer about 37 cm taller and 37 cm further
 * back (18.7 m each in the world, ÷ 50),
 * looking 40 cm in front of the table centre. With the plain pose 15–22 % of
 * the track (the near leg at z ≈ −62 m) fell below the frame at 16:9;
 * an earlier 1.1 / −22 put the whole road inside the frame but only ~5 px
 * (probe) / ~15 px (picture) from the top and bottom edges. 1.22 / −20: on
 * seeds 1–40 at 16:9 every road edge stays ≥ 60 px from every frame edge
 * (top 63, bottom 60, sides 232) and clear of the xr HUD panels (frame
 * probe); the cars are ~10 % smaller in the frame for it.
 */
export const XR_PREVIEW = { targetZ: -20, scale: 1.22 };
/** Vertical fov of the diorama preview camera at 16:9 (Babylon's default). */
const XR_FOV = 0.8;
/**
 * High camera under the start gantry.
 *
 * From any camera behind and above the car, the sight line to a car that has
 * just passed under the beam crosses the beam's height band (its height at
 * the gantry plane rises continuously from the car's to the eye's), so no
 * pose avoids the gantry altogether; and while the car is UNDER the truss,
 * what lies on top of it covers a strip of it from any height (about a
 * quarter of the car even straight from above). What a pose can change is
 * HOW LONG and HOW MUCH: the steeper the sight line, the shorter the stretch.
 *
 * The first version went almost overhead (distance × 0.28, height × 1.12,
 * look target unchanged): the car slid to the bottom edge, the view turned
 * top-down (+21° pitch) for ~2.6 s per pass and every race in the high view
 * opened with the move. Measured trade-off (lab replica, 4 m car,
 * the gantry's real truss / banner / medallion boxes, road ahead ≥ 30 m):
 *
 *   pitch change   car centre hidden   most of the car covered
 *      0° (none)        2.8 m               75 %
 *     +9° (this)        1.9 m               58 %
 *    +21° (old)         1.1 m               50 %
 *
 * So the lift is now moderate — distance × LIFT_DISTANCE, height ×
 * LIFT_HEIGHT, which keeps the car's size within 2 % — and the PITCH follows
 * the car: the car stays at the plain pose's place in the frame, eased to
 * LIFT_FRAME (its centre at 79 % of the height, tail ~9 % clear of the
 * bottom edge), so ~31 m of road stays ahead. The lift is a smooth function
 * of the car's POSITION (ramp in from LIFT_FROM to LIFT_FULL m before the
 * plane, held while the plain pose's sight line to the car's tail still
 * crosses the gantry, ramp out over LIFT_OUT m), lightly smoothed in time:
 * at 20 m/s it lasts ~1.5 s and the pitch moves at most ~23°/s. The grid
 * slots stand 4, 8, 12 and 16 m behind the gantry and the player takes the
 * last one: with three rivals the player's slot (16 m) is outside the ramp
 * and a race starts in the plain pose; with two, one or no rival it starts
 * partly lifted (lift 0.06 / 0.44 / 0.86 — a good picture too, the car
 * whole and the gantry ahead) and eases back within about a second of GO.
 */
const LIFT_DISTANCE = 0.75;
const LIFT_HEIGHT = 1.15;
/** Car centre's place in the frame at full lift, 0..1 from the top. */
const LIFT_FRAME = 0.79;
/** Ramp in: starts this far before the gantry plane, full this close, m. */
const LIFT_FROM = 14;
const LIFT_FULL = 1;
/** Ramp out after the plain pose is clear again, m of car travel. */
const LIFT_OUT = 10;
/** Time smoothing of the lift (both ways), s. */
const LIFT_TAU = 0.12;
/** Car half length for the "tail still behind the gantry" test, m, and the
 * height of the car point the framing keeps in place, m. */
const LIFT_TAIL = 2;
const LIFT_CAR_Y = 1;
/** Time constant of the menu's lateral offset, s (contracts/camera.ts). */
const LATERAL_TAU = 0.35;

/**
 * The vertical fov the chase / high rig really uses for a tuning `fov` in a
 * window of this aspect (width / height): `fov` at 16:9 and wider; narrower
 * windows keep the 16:9 HORIZONTAL fov (vertical capped at 1.5 rad). Still
 * cameras posed from CAMERA_TUNING (terrain / props labs) should set
 * `camera.fov = followVerticalFov(CAMERA_TUNING.chase.fov, aspect)` so their
 * pictures and frame costs are the game's at every window shape.
 */
export function followVerticalFov(fov: number, aspect: number): number {
  return aspect > 0 && aspect < REF_ASPECT ? Math.min(2 * Math.atan(Math.tan(fov / 2) * (REF_ASPECT / aspect)), MAX_VFOV) : fov;
}

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = (a + Math.PI) % twoPi;
  if (a < 0) a += twoPi;
  return a - Math.PI;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

interface ModeController {
  readonly camera: Camera;
  readonly look: ViewLook;
  enter(): void;
  leave(): void;
  /** Refresh the camera and write `eye` / `focus`. */
  update(dt: number, eye: Vector3, focus: Vector3): void;
  snap(eye: Vector3, focus: Vector3): void;
  dispose(): void;
}

interface FollowSettings {
  /** Adjust the distance to the subject's width (chase). */
  normalizeWidth: boolean;
  distance(speedFactor: number): number;
  height: number;
  lookUp: number;
  lookAhead: number;
  fov(speedFactor: number): number;
  yawTau: number;
  heightTau: number;
  minClearance: number;
  /** Ease toward overhead under occluders (high only). */
  avoidOccluders: boolean;
}

/** chase / high: a follow camera on the subject's chassis. */
class FollowMode implements ModeController {
  readonly camera: UniversalCamera;
  readonly look: ViewLook;
  private readonly settings: () => FollowSettings;
  private readonly subject: () => Vehicle | null;
  private readonly heightAt: ((x: number, z: number) => number) | undefined;
  private readonly lateral: () => number;
  private yaw = 0;
  private baseY = 0;
  private speedK = 0;
  private started = false;
  private readonly vel = new Vector3();
  /** Subject axles (tire-to-tire width, model z) for the width normalisation;
   * refreshed when the subject changes. */
  private axleOf: Vehicle | null = null;
  private frontW = REF_AXLE_WIDTH;
  private rearW = REF_AXLE_WIDTH;
  private halfBase = -REF_AXLE_Z;
  /** Occluders the eye eases over, and the eased lift 0..1. */
  occluders: readonly CameraOccluder[] = [];
  private lift = 0;

  constructor(
    name: string,
    scene: Scene,
    settings: () => FollowSettings,
    subject: () => Vehicle | null,
    heightAt: ((x: number, z: number) => number) | undefined,
    lateral: () => number,
  ) {
    this.camera = new UniversalCamera(name, new Vector3(0, 3, -5.6), scene);
    this.camera.minZ = 0.3;
    this.camera.maxZ = 600;
    // Orientation is written as Euler angles in pose(); a quaternion would win.
    this.camera.rotationQuaternion = null;
    this.look = { ...LOOK_VIEWS.chase };
    this.settings = settings;
    this.subject = subject;
    this.heightAt = heightAt;
    this.lateral = lateral;
  }

  enter(): void {
    // Coming from another mode: the follow state is stale — start settled.
    this.started = false;
  }

  leave(): void {}

  update(dt: number, eye: Vector3, focus: Vector3): void {
    this.pose(dt, !this.started, eye, focus);
  }

  snap(eye: Vector3, focus: Vector3): void {
    this.pose(0, true, eye, focus);
  }

  dispose(): void {
    this.camera.dispose();
  }

  private pose(dt: number, snap: boolean, eye: Vector3, focus: Vector3): void {
    const v = this.subject();
    if (!v) return; // no subject: keep the last pose
    const s = this.settings();
    const mesh = v.chassisMesh;
    const q = mesh.rotationQuaternion;
    mesh.computeWorldMatrix(true);
    const root = v.visual.root;
    root.computeWorldMatrix(true);
    // Model origin = the ground under the wheelbase centre (visual.ts).
    const base = root.getAbsolutePosition();
    const cx = base.x;
    const cz = base.z;
    if (!Number.isFinite(cx + base.y + cz)) return;

    // Chassis heading: world direction of its +z (yaw 0 = +z, + toward +x).
    let chassisYaw = this.yaw;
    if (q) {
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      if (fx * fx + fz * fz > 1e-6) chassisYaw = Math.atan2(fx, fz);
    }
    let target = chassisYaw;
    v.chassisBody.getLinearVelocityToRef(this.vel);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (v.forwardSpeed > DRIFT_FWD_ZERO && speed > DRIFT_PULL_FROM) {
      const travel = Math.atan2(this.vel.x, this.vel.z);
      const pull = clamp(0.5 * wrapAngle(travel - chassisYaw), -DRIFT_PULL_MAX, DRIFT_PULL_MAX);
      const w = clamp((speed - DRIFT_PULL_FROM) / (DRIFT_PULL_FULL - DRIFT_PULL_FROM), 0, 1);
      const wf = clamp((v.forwardSpeed - DRIFT_FWD_ZERO) / (DRIFT_FWD_FULL - DRIFT_FWD_ZERO), 0, 1);
      target += pull * w * wf;
    }

    const top = v.topSpeed > 0 ? v.topSpeed : 1;
    const kRaw = clamp(Math.abs(v.forwardSpeed) / top, 0, 1);
    if (snap) {
      this.yaw = target;
      this.baseY = base.y;
      this.speedK = kRaw;
      this.started = true;
    } else if (dt > 0) {
      this.yaw = wrapAngle(this.yaw + wrapAngle(target - this.yaw) * (1 - Math.exp(-dt / s.yawTau)));
      this.baseY += (base.y - this.baseY) * (1 - Math.exp(-dt / s.heightTau));
      this.speedK += (kRaw - this.speedK) * (1 - Math.exp(-dt / SPEED_TAU));
    }
    // A car going down (a steep descent, a landing) must not sink out of the
    // bottom of the frame through the smoothing lag: the smoothed height
    // trails the car by at most MAX_DROP_LAG (bumps stay smoothed; a car
    // going UP only moves toward the frame centre, so that side is free).
    if (this.baseY > base.y + MAX_DROP_LAG) this.baseY = base.y + MAX_DROP_LAG;

    const k = this.speedK;
    let dist = s.distance(k);
    if (s.normalizeWidth) dist += this.widthOffset(v, s.distance(0));
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    let height = s.height;
    let u = 0;
    if (s.avoidOccluders && this.occluders.length > 0) {
      // Need from the PLAIN pose (lift 0), so the decision does not feed back.
      let need = 0;
      for (const o of this.occluders) {
        need = Math.max(need, liftNeed(o, cx, base.y, cz, cx - sy * dist, this.baseY + s.height - base.y, cz - cy * dist));
      }
      if (snap) this.lift = need;
      else if (dt > 0) this.lift += (need - this.lift) * (1 - Math.exp(-dt / LIFT_TAU));
      u = this.lift < 1e-4 ? 0 : this.lift;
      dist *= 1 - (1 - LIFT_DISTANCE) * u;
      height *= 1 + (LIFT_HEIGHT - 1) * u;
    } else {
      this.lift = 0;
    }
    // Menu offset: eye and look-at slide to the camera's left, (−cos, +sin)
    // of the yaw (right of a heading (sin, cos) is (cos, −sin)).
    const side = this.lateral();
    const ox = -cy * side;
    const oz = sy * side;
    const ex = cx - sy * dist + ox;
    const ez = cz - cy * dist + oz;
    let ey = this.baseY + height;
    if (this.heightAt) ey = Math.max(ey, this.heightAt(ex, ez) + s.minClearance);
    const tx = cx + sy * s.lookAhead + ox;
    const ty = this.baseY + s.lookUp;
    const tz = cz + cy * s.lookAhead + oz;
    // `fov` is vertical at 16:9 and wider; a narrower window keeps the 16:9
    // horizontal fov (see the header).
    const fov = s.fov(k);
    const cam = this.camera;
    const aspect = cam.getEngine().getAspectRatio(cam);
    const vfov = followVerticalFov(fov, aspect);
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    let pitch = Math.atan2(-dy, Math.hypot(dx, dz));
    if (u > 0) {
      // Keep the car where the plain pose has it, eased toward LIFT_FRAME:
      // pitch = the car's depression − its offset below the view axis.
      const plainDist = s.distance(k);
      const plainH = s.height;
      const off0 = Math.atan2(plainH - LIFT_CAR_Y, plainDist) - Math.atan2(plainH - s.lookUp, plainDist + s.lookAhead);
      const off1 = Math.atan(Math.tan(vfov / 2) * (2 * LIFT_FRAME - 1));
      pitch = Math.atan2(ey - (this.baseY + LIFT_CAR_Y), dist) - (off0 + (off1 - off0) * u);
    }

    cam.position.set(ex, ey, ez);
    cam.rotation.set(pitch, Math.atan2(dx, dz), 0);
    cam.fov = vfov;

    eye.set(ex, ey, ez);
    focus.set(cx, base.y, cz);
  }

  /** Extra distance that makes this subject's widest axle project like the
   * reference car's rear axle at `base` m: projected width ∝ W / (d + z) for
   * an axle of width W at model z (the eye is d behind the model origin). */
  private widthOffset(v: Vehicle, base: number): number {
    if (v !== this.axleOf) {
      this.axleOf = v;
      const rig = v.rig;
      if (rig) {
        this.frontW = rig.spec.frontTrack + rig.spec.frontTireWidth;
        this.rearW = rig.spec.rearTrack + rig.spec.rearTireWidth;
        this.halfBase = rig.wheelbase / 2;
      } else {
        this.frontW = this.rearW = REF_AXLE_WIDTH;
        this.halfBase = -REF_AXLE_Z;
      }
    }
    const depth = base + REF_AXLE_Z;
    if (!(depth > 0.5)) return 0;
    const share = REF_AXLE_WIDTH / depth; // reference width per metre of depth
    const need = Math.max(this.rearW / share + this.halfBase, this.frontW / share - this.halfBase);
    return need - base;
  }
}

const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * How much lift (0..1) the high camera needs for one occluder, as a smooth
 * function of the car's place (px, py = its base height, pz) — so at a steady speed the camera
 * moves smoothly in time — from the plain pose's eye (ex, ez) and its height
 * above the car `eh`:
 *  - eye and car on the same side of the occluder's plane, the car nearer to
 *    it (approaching): smoothstep from LIFT_FROM to LIFT_FULL m;
 *  - the plane between them (the car has passed): 1 while the plain pose's
 *    sight line to the car's TAIL (LIFT_TAIL behind, 0.3 m up) crosses the
 *    plane below the box's top, then a smoothstep back to 0 over LIFT_OUT m;
 *  - a car beside the box (outside its span + 2 m): 0.
 */
function liftNeed(o: CameraOccluder, px: number, py: number, pz: number, ex: number, eh: number, ez: number): number {
  const s = Math.sin(o.yaw);
  const c = Math.cos(o.yaw);
  const carX = (px - o.x) * c - (pz - o.z) * s;
  const carZ = (px - o.x) * s + (pz - o.z) * c;
  const eyeZ = (ex - o.x) * s + (ez - o.z) * c;
  if (Math.abs(carX) > o.halfWidth + 2) return 0;
  const dCar = Math.abs(carZ);
  // Before the plane (or on it): approaching.
  if (carZ * eyeZ > 0 || dCar <= o.halfDepth) {
    if (carZ * eyeZ > 0 && dCar >= Math.abs(eyeZ)) return 0; // the box is behind the eye
    if (dCar <= o.halfDepth) return 1;
    return smoothstep((LIFT_FROM - dCar) / (LIFT_FROM - LIFT_FULL));
  }
  // Past it: where does the plain sight line to the tail clear the box top?
  // Its height at the plane rises with the tail's distance past the plane.
  const back = dCar + Math.abs(eyeZ); // eye-to-car horizontal distance along the road
  const tailDepth = back - LIFT_TAIL;
  if (!(tailDepth > 0.5)) return 1;
  const topAboveTail = o.top - (py + 0.3); // box top above the tail point
  const clearAt = LIFT_TAIL + (topAboveTail * tailDepth) / Math.max(eh - 0.3, 0.5);
  if (dCar <= clearAt) return 1;
  return 1 - smoothstep((dCar - clearAt) / LIFT_OUT);
}

/** xr: the diorama preview, an orbit camera around the world centre. */
class OrbitMode implements ModeController {
  readonly camera: ArcRotateCamera;
  readonly look: ViewLook;
  private readonly canvas: HTMLCanvasElement;
  private readonly heightAt: ((x: number, z: number) => number) | undefined;
  private attached = false;

  constructor(scene: Scene, canvas: HTMLCanvasElement, heightAt: ((x: number, z: number) => number) | undefined) {
    const t = CAMERA_TUNING.xr;
    // Camera on the −z side (alpha −π/2) so a car on the start line (heading
    // +z) is seen from behind; beta from the vertical. Eye and target as
    // XR_PREVIEW says (the eye on the 45° line, the target nearer the viewer).
    const eyeH = t.eyeHeight * XR_PREVIEW.scale;
    const eyeBack = t.back * XR_PREVIEW.scale + XR_PREVIEW.targetZ;
    const cam = new ArcRotateCamera(
      'xrPreviewCam',
      -Math.PI / 2,
      Math.atan2(eyeBack, eyeH),
      Math.hypot(eyeBack, eyeH),
      new Vector3(0, 0, XR_PREVIEW.targetZ),
      scene,
    );
    cam.fov = XR_FOV;
    cam.minZ = 0.5;
    cam.maxZ = 1000;
    cam.wheelPrecision = 1;
    cam.lowerRadiusLimit = t.minRadius;
    cam.upperRadiusLimit = t.maxRadius;
    // Stay above the table: never orbit down to or below the ground plane.
    cam.upperBetaLimit = Math.PI / 2 - 0.12;
    // The arrow keys drive the car; they must not also orbit the camera.
    cam.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    // Panning slides the orbit target over the ground plane (Babylon's
    // default pans in the view plane and lifts the target — and `focus`,
    // which the contract puts on the ground — into the air), and not off the
    // table.
    cam.mapPanning = true;
    cam.panningDistanceLimit = 150;
    this.camera = cam;
    this.canvas = canvas;
    this.heightAt = heightAt;
    this.look = { ...LOOK_VIEWS.diorama };
  }

  enter(): void {
    if (!this.attached) {
      this.camera.attachControl(this.canvas, true);
      this.attached = true;
    }
  }

  leave(): void {
    if (this.attached) {
      this.camera.detachControl();
      this.attached = false;
    }
  }

  update(_dt: number, eye: Vector3, focus: Vector3): void {
    const c = this.camera;
    const t = c.target;
    // Like the follow cameras: a window narrower than 16:9 keeps the 16:9
    // horizontal fov, so the table does not lose its sides in a 4:3 window.
    c.fov = followVerticalFov(XR_FOV, c.getEngine().getAspectRatio(c));
    // Keep the eye XR_MIN_EYE above the ground under it (zoomed in near the
    // beta limit it went below a hilltop): open beta up just enough.
    let sb = Math.sin(c.beta);
    const gx = t.x + c.radius * Math.cos(c.alpha) * sb;
    const gz = t.z + c.radius * Math.sin(c.alpha) * sb;
    const floor = (this.heightAt ? this.heightAt(gx, gz) : 0) + XR_MIN_EYE - t.y;
    if (c.radius > 0 && c.radius * Math.cos(c.beta) < floor) {
      // Never straight down (an ArcRotateCamera at beta ≈ 0 degenerates):
      // if opening beta is not enough, back off along the ray instead.
      const minBeta = 0.05;
      if (floor / c.radius >= Math.cos(minBeta)) {
        c.beta = minBeta;
        c.radius = floor / Math.cos(minBeta);
      } else {
        c.beta = Math.acos(clamp(floor / c.radius, 0, 1));
      }
      sb = Math.sin(c.beta);
    }
    eye.set(t.x + c.radius * Math.cos(c.alpha) * sb, t.y + c.radius * Math.cos(c.beta), t.z + c.radius * Math.sin(c.alpha) * sb);
    focus.set(t.x, t.y, t.z);
  }

  snap(eye: Vector3, focus: Vector3): void {
    this.update(0, eye, focus);
  }

  dispose(): void {
    this.leave();
    this.camera.dispose();
  }
}

class Rig implements CameraRig {
  readonly eye = new Vector3();
  readonly focus = new Vector3();
  private current: ViewMode;
  private subject: Vehicle | null = null;
  /** The vehicle this rig marks as followed (see followed.ts). */
  private marked: Vehicle | null = null;
  private readonly scene: Scene;
  private readonly modes: Record<ViewMode, ModeController>;
  /** Menu offset: wanted and eased value, m (see the header). */
  private lateralTarget = 0;
  private lateralNow = 0;

  constructor(scene: Scene, canvas: HTMLCanvasElement, options: GameCameraRigOptions = {}) {
    this.scene = scene;
    const subject = (): Vehicle | null => this.subject;
    const heightAt = options.heightAt;
    const lateral = (): number => this.lateralNow;
    // Settings are read from CAMERA_TUNING on every update, so console edits
    // take effect at once.
    const chase: FollowSettings = {
      normalizeWidth: true,
      distance: (k) => CAMERA_TUNING.chase.distance + CAMERA_TUNING.chase.speedDistance * k,
      height: 0,
      lookUp: 0,
      lookAhead: 0,
      fov: (k) => CAMERA_TUNING.chase.fov + CAMERA_TUNING.chase.speedFov * k,
      yawTau: 0,
      heightTau: 0,
      minClearance: 0,
      avoidOccluders: false,
    };
    const chaseSettings = (): FollowSettings => {
      const c = CAMERA_TUNING.chase;
      chase.height = c.height;
      chase.lookUp = c.lookUp;
      chase.lookAhead = c.lookAhead;
      chase.yawTau = c.yawTau;
      chase.heightTau = c.heightTau;
      chase.minClearance = c.minClearance;
      return chase;
    };
    const high: FollowSettings = {
      normalizeWidth: false,
      distance: () => CAMERA_TUNING.high.distance,
      height: 0,
      lookUp: 0,
      lookAhead: 0,
      fov: () => CAMERA_TUNING.high.fov,
      yawTau: 0,
      heightTau: 0,
      minClearance: 0,
      avoidOccluders: true,
    };
    const highSettings = (): FollowSettings => {
      const h = CAMERA_TUNING.high;
      high.height = h.height;
      high.lookAhead = h.lookAhead;
      high.yawTau = h.yawTau;
      high.heightTau = CAMERA_TUNING.chase.heightTau;
      high.minClearance = CAMERA_TUNING.chase.minClearance;
      return high;
    };
    const highMode = new FollowMode('highCam', scene, highSettings, subject, heightAt, lateral);
    highMode.occluders = options.occluders ?? [];
    this.modes = {
      chase: new FollowMode('chaseCam', scene, chaseSettings, subject, heightAt, lateral),
      high: highMode,
      xr: new OrbitMode(scene, canvas, heightAt),
    };
    this.current = options.mode ?? 'chase';
    const m = this.modes[this.current];
    m.enter();
    scene.activeCamera = m.camera;
    this.eye.copyFrom(m.camera.position);
  }

  get mode(): ViewMode {
    return this.current;
  }

  get camera(): Camera {
    return this.modes[this.current].camera;
  }

  get focusDistance(): number {
    return Vector3.Distance(this.eye, this.focus);
  }

  get look(): ViewLook {
    return this.modes[this.current].look;
  }

  setSubject(vehicle: Vehicle | null): void {
    this.subject = vehicle;
    this.refreshMark();
  }

  /** chase / high follow the subject: it stays at full detail (GameCar). */
  private refreshMark(): void {
    const next = this.current === 'xr' ? null : this.subject;
    moveFollowMark(this.marked, next);
    this.marked = next;
  }

  setMode(mode: ViewMode): void {
    if (mode === this.current && this.scene.activeCamera === this.modes[mode].camera) return;
    this.modes[this.current].leave();
    this.current = mode;
    const m = this.modes[mode];
    m.enter();
    this.scene.activeCamera = m.camera;
    this.refreshMark();
    m.update(0, this.eye, this.focus);
  }

  cycle(): ViewMode {
    const i = MODE_ORDER.indexOf(this.current);
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length];
    this.setMode(next);
    return next;
  }

  snap(): void {
    this.lateralNow = this.lateralTarget;
    this.modes[this.current].snap(this.eye, this.focus);
  }

  setLateralOffset(m: number): void {
    this.lateralTarget = Number.isFinite(m) ? m : 0;
  }

  update(dt: number): void {
    // Eased in every mode (xr ignores it), so a switch back finds it settled.
    if (this.lateralNow !== this.lateralTarget && dt > 0) {
      this.lateralNow += (this.lateralTarget - this.lateralNow) * (1 - Math.exp(-dt / LATERAL_TAU));
      if (Math.abs(this.lateralTarget - this.lateralNow) < 1e-4) this.lateralNow = this.lateralTarget;
    }
    this.modes[this.current].update(dt, this.eye, this.focus);
  }

  dispose(): void {
    moveFollowMark(this.marked, null);
    this.marked = null;
    for (const mode of MODE_ORDER) this.modes[mode].dispose();
  }
}

export const createCameraRig: CreateCameraRig = (scene: Scene, canvas: HTMLCanvasElement, options?: CameraRigOptions): CameraRig =>
  new Rig(scene, canvas, options);

/** The game's rig: the contract's plus occluders for the high camera. */
export function createGameCameraRig(scene: Scene, canvas: HTMLCanvasElement, options: GameCameraRigOptions): CameraRig {
  return new Rig(scene, canvas, options);
}
