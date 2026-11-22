import { Quaternion, Vector3 } from '@babylonjs/core';
import type { HavokPlugin } from '@babylonjs/core';
import type { Vehicle } from '../car/Vehicle';
import { isOutOfWorld, needsRescue } from '../car/createVehicle';
import type { RivalDriver, RivalField, GridPose } from '../car/ai';
import type { InputProvider } from '../input/types';
import { ZERO_INTENT } from '../input/types';
import type { Track } from '../terrain/track';
import type { Hud } from '../ui/Hud';
import type { GameActions } from './contracts/camera';
import type { GameCar } from './contracts/car';
import type { GroundQuery, Vec3Like } from './contracts/world';
import type { GameOptions } from './options';
import { RaceState, memoryBestLapStorage, respawnPose, webBestLapStorage } from './RaceState';
import type { BestLapStorage } from './RaceState';
import type { CarSample, RaceEvent } from './RaceState';

/**
 * One race on the hills track: the cars, the rivals' field, the
 * race rules (`RaceState`), the HUD and every respawn. No Babylon rendering in
 * here — the game calls, per frame:
 *
 *   session.beforePhysics(dt, actions)   restart?, field.update(dt), every vehicle.update(dt)
 *   scene.render()                       Havok steps dt
 *   session.afterPhysics(dt)             (from onAfterPhysicsObservable, after car.syncVisual)
 *                                        samples → race.update → finish / go events,
 *                                        respawns, HUD
 *
 * A car is moved ONLY through `car.place` (= `Vehicle.reset`).
 *
 * Respawn rules: `race.snapshot(id).needsReset`, `needsRescue(vehicle, dt)`,
 * `isOutOfWorld(vehicle, 97, lowest road − 25)`, a rival driver's `rescue`,
 * or the player's reset button while racing (remembered until it is done) →
 * `pose = race.respawn(id)`, shifted 2.4 m sideways when another car is
 * within 5 m of it — to the side with more room, or the other side if the
 * first one's footprint overlaps a car (both overlap: wait 0.5 s and try
 * again) → `car.place` → `field.respawned` → `onRespawn(id)` (the game snaps
 * its camera for the player).
 *
 * HOLD and MENU LOCK (the game menu, design-documents/menu-mockups/SPEC.md
 * 5 / 7): `setHeld(true)` freezes the race where it stands — `afterPhysics`
 * hands `race.update` a dt of 0, so the countdown does not move, input stays
 * locked and the field stays held (no GO), while the respawn rules keep
 * working with the real dt. The title screen holds a fresh grid this way; a
 * session built with `held: true` (a menu page) starts held, so the 3-2-1
 * never runs under the loading panel. `menuLocked` gates the player's input
 * to zero on top of `race.inputLocked` (title, pause, the post-race stack).
 * Neither is ever set on a page without the menu: its races are unchanged.
 *
 * Best laps are stored in the browser only for a human driving the stock
 * car (no autopilot, no `?tune=`, the primary vehicle model); any other run
 * keeps them in memory for the session.
 */

export interface RaceSessionDeps {
  /** Cars come in through `addCar` (the player's car needs `gate` first). */
  cars: GameCar[];
  playerId: string;
  track: Track;
  ground: GroundQuery;
  options: GameOptions;
  field: RivalField;
  /** Drivers by car id: every rival, and the player's autopilot if any. */
  drivers: Map<string, RivalDriver>;
  hud: Hud | null;
  onRespawn?: (id: string) => void;
  /** After a restart put every car back on the grid (the game snaps its camera). */
  onRestart?: () => void;
  /** Asked before a best lap is written to web storage: false once the car
   * is no longer stock (a tuning slider moved). Default: always true. */
  canStoreBest?: () => boolean;
  /** Start held (`setHeld(true)`): a page with the game menu. Default false. */
  held?: boolean;
}

/** Why a car was put back on the road (counted per car). */
export type RespawnCause = 'flipped' | 'fell' | 'stranded' | 'shortcut' | 'rescue' | 'outOfWorld' | 'driver' | 'manual';

interface Entry {
  car: GameCar;
  driver: RivalDriver | null;
  /** Grid spot: a point on the ground and a heading. */
  grid: { x: number; y: number; z: number; yaw: number };
  /** The player pressed reset while racing; kept until the respawn happens. */
  pendingManual: boolean;
  /** Lap (snapshot.lap) of the last respawn, and respawns within that lap. */
  respawnLap: number;
  respawnsInLap: number;
  sample: CarSample;
  forward: Vector3;
  up: Vector3;
  /** Respawn postponed (both sides taken) until this session time. */
  retryAt: number;
  /** Horizontal distance covered since the race started, m. */
  odometer: number;
  lastX: number;
  lastZ: number;
}

const AXIS_Z = new Vector3(0, 0, 1);
const AXIS_Y = new Vector3(0, 1, 0);
const IDENTITY = Quaternion.Identity();
/** Another car this close to a respawn point (m) moves the point sideways… */
const RESPAWN_CLEAR = 5;
/** …by at most this much (m). */
const RESPAWN_SHIFT = 2.4;
/** Footprint margins when a shifted point is tested against the other cars'
 * footprints (oriented boxes), m: across and along the cars. Two cars 2.05 m
 * wide side by side at 2.4 m clear each other by 0.35 m. */
const FOOTPRINT_MARGIN_SIDE = 0.1;
const FOOTPRINT_MARGIN_END = 0.4;
const RESPAWN_RETRY = 0.5;
const WORLD_HALF = 97;

export class RaceSession {
  readonly race: RaceState;
  readonly field: RivalField;
  readonly playerId: string;
  readonly respawnCounts: Record<string, number> = {};
  /** Per car id: cause → count. */
  readonly respawnCauses: Record<string, Partial<Record<RespawnCause, number>>> = {};
  /** Per car id: the most respawns it had within one lap (storm check). */
  readonly maxRespawnsPerLap: Record<string, number> = {};
  /** Replaceable (the game re-creates the HUD when the dev overlay shows). */
  hud: Hud | null;
  /** A menu is open (title, pause, post-race stack): `gate()` hands the
   * player's car zero input, like `race.inputLocked` does in the 3-2-1. */
  menuLocked = false;

  private readonly entries: Entry[] = [];
  private readonly samples: CarSample[] = [];
  private readonly ground: GroundQuery;
  private readonly drivers: Map<string, RivalDriver>;
  private readonly onRespawn: ((id: string) => void) | null;
  private readonly onRestart: (() => void) | null;
  private readonly killY: number;
  private actions: Readonly<GameActions> | null = null;
  private time = 0;
  private disposed = false;
  private heldValue: boolean;
  private readonly point: Vec3Like = { x: 0, y: 0, z: 0 };

  constructor(deps: RaceSessionDeps) {
    this.field = deps.field;
    this.playerId = deps.playerId;
    this.ground = deps.ground;
    this.drivers = deps.drivers;
    this.hud = deps.hud;
    this.onRespawn = deps.onRespawn ?? null;
    this.onRestart = deps.onRestart ?? null;
    this.heldValue = deps.held === true;
    const heightAt = deps.ground.heightAt;
    const o = deps.options;
    // Only a human on the stock car sets the all-time best lap: an autopilot
    // lap, a `?tune=` car or another vehicle model would overwrite it.
    const stock = !o.autopilot && !o.shot && !o.report && Object.keys(o.tune).length === 0 && o.vehicle === 'raycast';
    this.race = new RaceState(deps.track, {
      laps: o.laps === 0 ? Infinity : o.laps,
      countdownSeconds: o.countdown ? 3 : 0,
      trackKey: 'hills2-' + o.seed,
      storage: stock ? gatedStorage(webBestLapStorage(), deps.canStoreBest ?? (() => true)) : memoryBestLapStorage(),
      playerId: deps.playerId,
      respawn: { heightAt },
      flipSeconds: 4,
      worldHalfExtent: 98,
      resetOnShortcut: o.cuts === 'reset',
      onEvent: (e) => this.handleEvent(e),
    });
    this.killY = this.race.path.minHeight - 25;
    if (deps.cars.length > 0) throw new Error('RaceSession: enter cars with addCar(car, gridPose)');
  }

  /** The player's input must be read through this: zero while the countdown
   * runs and while a menu is open (`menuLocked`). */
  gate(input: InputProvider): InputProvider {
    return {
      name: input.name,
      isActive: () => input.isActive(),
      poll: () => (this.race.inputLocked || this.menuLocked ? ZERO_INTENT : input.poll()),
    };
  }

  /** Is the race held (see the header)? */
  get held(): boolean {
    return this.heldValue;
  }

  /**
   * Hold the race where it stands (true) or let it run again (false). Held,
   * `afterPhysics` advances the race by 0 s: a countdown does not move and
   * never reaches GO, so the rivals stay held and the player's input stays
   * locked. Physics, vehicles and respawns go on as usual. The menu holds a
   * fresh grid (`restart()` then `setHeld(true)`) and releases it before
   * `restart()` starts the race.
   */
  setHeld(on: boolean): void {
    this.heldValue = on;
  }

  /**
   * Put a car on its grid spot and enter it in the field and the race. The
   * car is placed BEFORE the field sees it (the field locates a car when it
   * is added).
   */
  addCar(car: GameCar, pose: GridPose): void {
    const y = this.ground.heightAt(pose.x, pose.z);
    car.place({ x: pose.x, y, z: pose.z }, pose.yaw);
    this.register(car, { x: pose.x, y, z: pose.z, yaw: pose.yaw }, pose.s);
  }

  /** After the last car: hold the field for the countdown, or start it now. */
  begin(): void {
    this.field.hold();
    if (this.race.phase === 'racing') this.field.start();
  }

  /** Shot mode: put a car on the road centre at arc length `s` (wrapped). */
  placeAt(id: string, s: number): void {
    const e = this.entry(id);
    if (!e) return;
    const pose = respawnPose(this.race.path, this.race.path.wrap(s), { heightAt: this.ground.heightAt });
    e.car.place(pose.ground, pose.yaw);
    this.field.respawned(id);
    this.race.resync(id);
    e.lastX = pose.ground.x;
    e.lastZ = pose.ground.z;
  }

  beforePhysics(dt: number, actions: Readonly<GameActions>): void {
    this.actions = actions;
    if (actions.restart) this.restart();
    this.field.update(dt);
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) entries[i].car.vehicle.update(dt);
  }

  afterPhysics(dt: number): void {
    this.time += dt;
    const entries = this.entries;
    const racing = this.race.phase !== 'countdown';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const v = e.car.vehicle;
      const mesh = v.chassisMesh;
      const q = mesh.rotationQuaternion ?? IDENTITY;
      AXIS_Z.rotateByQuaternionToRef(q, e.forward);
      AXIS_Y.rotateByQuaternionToRef(q, e.up);
      e.sample.speed = v.forwardSpeed;
      const top = v.topSpeed > 0 ? v.topSpeed : 1;
      e.sample.bar = Math.min(1, Math.abs(v.drivenRimSpeed) / top);
      const p = mesh.position;
      if (racing) e.odometer += Math.hypot(p.x - e.lastX, p.z - e.lastZ);
      e.lastX = p.x;
      e.lastZ = p.z;
    }
    this.race.update(this.heldValue ? 0 : dt, this.samples);

    const manual = this.actions?.reset === true && this.race.phase === 'racing';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = e.car.id;
      const v = e.car.vehicle;
      // needsRescue keeps a timer per vehicle: call it every frame, never
      // behind a short-circuit.
      const rescue = needsRescue(v, dt);
      // An edge-triggered press is remembered across a postponed respawn.
      if (manual && id === this.playerId) e.pendingManual = true;
      else if (this.race.phase !== 'racing') e.pendingManual = false;
      if (this.time < e.retryAt) continue;
      const snap = this.race.snapshot(id);
      let cause: RespawnCause | null = null;
      if (snap.needsReset) cause = snap.needsReset;
      else if (rescue) cause = 'rescue';
      else if (isOutOfWorld(v, WORLD_HALF, this.killY)) cause = 'outOfWorld';
      else if (e.driver && e.driver.rescue !== null) cause = 'driver';
      else if (e.pendingManual) cause = 'manual';
      if (cause) this.respawn(e, cause);
    }
    if (this.hud) this.hud.update(this.race.snapshot(this.playerId));
  }

  /** Hand a just-placed car's chassis pose to Havok now (see `restart`). */
  private pushPose(car: GameCar): void {
    const v = car.vehicle;
    (v.chassisMesh.getScene().getPhysicsEngine()?.getPhysicsPlugin() as HavokPlugin | undefined)
      ?.setPhysicsBodyTransformation(v.chassisBody, v.chassisMesh);
  }

  /** Every car back to its grid spot, a new race (and its countdown). */
  restart(): void {
    for (const e of this.entries) {
      e.car.place(e.grid, e.grid.yaw);
      // Vehicle.reset moves the mesh; Havok takes the new pose only at the
      // pre-step of the next render, and vehicle.update runs before that, so
      // the first step after a restart would act on the OLD pose (the race
      // then depends on where the cars were). Push the pose into Havok now.
      this.pushPose(e.car);
      e.retryAt = 0;
      e.pendingManual = false;
      e.respawnLap = -1;
      e.respawnsInLap = 0;
      e.odometer = 0;
      e.lastX = e.grid.x;
      e.lastZ = e.grid.z;
    }
    // Every car, the player too: re-locates each tracker and resets a driver.
    // `relocate` keeps the laps a tracker had counted (it moves progress by
    // the shortest arc), so a car more than half a lap from the grid would
    // start the new race a lap up or down and the rubber band would stay
    // saturated all race: put progress back to its first-fix value (negative
    // metres behind the line, as at boot).
    for (const e of this.entries) {
      const id = e.car.id;
      this.field.respawned(id);
      const t = this.field.tracker(id);
      if (t) t.progress = t.s > t.geo.length / 2 ? t.s - t.geo.length : t.s;
    }
    // Drivers forget the last race (learned drive gain, clocks, speed plan):
    // the new race replays the first one for the same seeds.
    this.field.newRace();
    for (const d of this.drivers.values()) d.cooldown = false;
    // A new race: the report's respawn counters start again too.
    for (const e of this.entries) {
      const id = e.car.id;
      this.respawnCounts[id] = 0;
      this.respawnCauses[id] = {};
      this.maxRespawnsPerLap[id] = 0;
    }
    this.race.restart();
    this.begin();
    this.onRestart?.();
  }

  /** Metres each car covered on the ground since the start (report mode). */
  odometer(id: string): number {
    return this.entry(id)?.odometer ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hud?.dispose();
    this.hud = null;
  }

  // -------------------------------------------------------------------------

  private register(car: GameCar, grid: Entry['grid'], startS: number | null): void {
    const forward = new Vector3(0, 0, 1);
    const up = new Vector3(0, 1, 0);
    const sample: CarSample = { id: car.id, position: car.vehicle.chassisMesh.position, forward, up, speed: 0, bar: 0 };
    const driver = this.drivers.get(car.id) ?? null;
    this.entries.push({
      car, driver, grid, sample, forward, up, retryAt: 0, odometer: 0, lastX: grid.x, lastZ: grid.z,
      pendingManual: false, respawnLap: -1, respawnsInLap: 0,
    });
    this.samples.push(sample);
    this.respawnCounts[car.id] = 0;
    this.respawnCauses[car.id] = {};
    this.maxRespawnsPerLap[car.id] = 0;
    if (driver) this.field.addRival(car.id, car.vehicle, driver);
    else this.field.addCar(car.id, car.vehicle, car.id === this.playerId);
    this.race.addCar(car.id, startS === null ? null : this.race.path.wrap(startS));
  }

  private entry(id: string): Entry | undefined {
    for (const e of this.entries) if (e.car.id === id) return e;
    return undefined;
  }

  private handleEvent(event: RaceEvent): void {
    if (event.type === 'go') {
      this.field.start();
    } else if (event.type === 'finish') {
      const d = this.drivers.get(event.id);
      if (d) d.cooldown = true;
    }
  }

  /** Room round a point: distance to the nearest OTHER car, m. */
  private room(me: Entry, x: number, z: number): number {
    let best = Infinity;
    for (const o of this.entries) {
      if (o === me) continue;
      const p = o.car.vehicle.chassisMesh.position;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Would car `me`, put at (x, z) heading (fx, fz), overlap another car's
   * footprint? Both footprints are oriented boxes (separating-axis test on
   * the four box axes), with small margins.
   */
  private overlapsCar(me: Entry, x: number, z: number, fx: number, fz: number): boolean {
    const mv = me.car.vehicle;
    const aw = halfWidth(mv) + FOOTPRINT_MARGIN_SIDE;
    const al = halfLength(mv) + FOOTPRINT_MARGIN_END;
    for (const o of this.entries) {
      if (o === me) continue;
      const v = o.car.vehicle;
      const mesh = v.chassisMesh;
      const p = mesh.position;
      const q = mesh.rotationQuaternion;
      let gx = q ? 2 * (q.x * q.z + q.y * q.w) : Math.sin(mesh.rotation.y);
      let gz = q ? 1 - 2 * (q.x * q.x + q.y * q.y) : Math.cos(mesh.rotation.y);
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-3) {
        // Standing on its nose or tail: its footprint is small, treat it as
        // aligned with us.
        gx = fx;
        gz = fz;
      } else {
        gx /= gl;
        gz /= gl;
      }
      const bw = halfWidth(v) + FOOTPRINT_MARGIN_SIDE;
      const bl = halfLength(v) + FOOTPRINT_MARGIN_END;
      const dx = p.x - x;
      const dz = p.z - z;
      // Axes: my forward, my right, its forward, its right.
      let separated = false;
      for (let k = 0; k < 4 && !separated; k++) {
        const ux = k === 0 ? fx : k === 1 ? fz : k === 2 ? gx : gz;
        const uz = k === 0 ? fz : k === 1 ? -fx : k === 2 ? gz : -gx;
        const ra = al * Math.abs(fx * ux + fz * uz) + aw * Math.abs(fz * ux - fx * uz);
        const rb = bl * Math.abs(gx * ux + gz * uz) + bw * Math.abs(gz * ux - gx * uz);
        if (Math.abs(dx * ux + dz * uz) > ra + rb) separated = true;
      }
      if (!separated) return true;
    }
    return false;
  }

  private respawn(e: Entry, cause: RespawnCause): void {
    const id = e.car.id;
    // Look first (pure), commit with race.respawn only once a spot is free.
    const look = this.race.respawnPoseFor(id);
    const gx = look.ground.x;
    const gz = look.ground.z;
    let x = gx;
    let z = gz;
    if (this.room(e, gx, gz) < RESPAWN_CLEAR) {
      // Right of the heading (yaw 0 = +z, + = toward +x).
      const fx = look.forward.x;
      const fz = look.forward.z;
      const rx = fz;
      const rz = -fx;
      const xr = gx + rx * RESPAWN_SHIFT, zr = gz + rz * RESPAWN_SHIFT;
      const xl = gx - rx * RESPAWN_SHIFT, zl = gz - rz * RESPAWN_SHIFT;
      // The side with more room first; the other one if the first overlaps a car.
      const rightFirst = this.room(e, xr, zr) >= this.room(e, xl, zl);
      const ax = rightFirst ? xr : xl, az = rightFirst ? zr : zl;
      const bx = rightFirst ? xl : xr, bz = rightFirst ? zl : zr;
      if (!this.overlapsCar(e, ax, az, fx, fz)) {
        x = ax;
        z = az;
      } else if (!this.overlapsCar(e, bx, bz, fx, fz)) {
        x = bx;
        z = bz;
      } else {
        e.retryAt = this.time + RESPAWN_RETRY;
        return;
      }
    }
    const pose = this.race.respawn(id);
    const pt = this.point;
    pt.x = x;
    pt.z = z;
    pt.y = this.ground.heightAt(x, z);
    e.car.place(pt, pose.yaw);
    this.pushPose(e.car);
    this.field.respawned(id);
    e.retryAt = 0;
    e.pendingManual = false;
    e.lastX = x;
    e.lastZ = z;
    this.respawnCounts[id] = (this.respawnCounts[id] ?? 0) + 1;
    const lap = this.race.snapshot(id).lap;
    if (lap !== e.respawnLap) {
      e.respawnLap = lap;
      e.respawnsInLap = 0;
    }
    e.respawnsInLap++;
    if (e.respawnsInLap > (this.maxRespawnsPerLap[id] ?? 0)) this.maxRespawnsPerLap[id] = e.respawnsInLap;
    const causes = this.respawnCauses[id];
    causes[cause] = (causes[cause] ?? 0) + 1;
    this.onRespawn?.(id);
  }
}

/** Half width / half length of a car's footprint, m (rig design size). */
function halfWidth(v: Vehicle): number {
  return (v.rig?.spec?.width ?? 2.1) / 2;
}
function halfLength(v: Vehicle): number {
  return (v.rig?.spec?.length ?? 4.1) / 2;
}

/** Web storage that keeps reading the stored best but writes only while
 * `allowed()` says the car is still the stock one. */
function gatedStorage(inner: BestLapStorage, allowed: () => boolean): BestLapStorage {
  return {
    load: (key) => inner.load(key),
    save: (key, seconds) => {
      if (allowed()) inner.save(key, seconds);
    },
  };
}

