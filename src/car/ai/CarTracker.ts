import { Vector3 } from '@babylonjs/core';
import type { Vehicle } from '../Vehicle';
import type { TrackGeometry, TrackProjection } from './RaceLine';

/**
 * Where one car is, in world and in TRACK coordinates — refreshed once per
 * frame (`refresh()`), read by the rival drivers (their own car and the
 * traffic around it) and by anything that wants race positions.
 *
 * Works for any car: AI rival, the player, a remote player. It only reads
 * the public `Vehicle` surface (chassis transform + body velocities) and
 * never allocates after construction.
 */
export class CarTracker {
  readonly id: string;
  readonly vehicle: Vehicle;
  readonly geo: TrackGeometry;
  /** Footprint, m (from the rig's design dimensions). */
  readonly halfWidth: number;
  readonly halfLength: number;
  /** false = not part of the traffic (waiting for a respawn, retired…). */
  active = true;
  /**
   * Id of the car this one is making room for right now (lifting, keeping
   * to one side), or null. Written by whoever drives the car — a
   * RivalDriver does; for a human-driven car leave it null (or set it from
   * a "let them by" input). A rival beside its tail reads it to know the
   * door is open.
   */
  givingWayTo: string | null = null;
  /** true = driven by a RivalDriver (set by RivalField.addRival); false =
   * a player / remote car the rivals cannot read the mind of. */
  driven = false;

  // --- world
  x = 0;
  y = 0;
  z = 0;
  /** Heading, rad (yaw 0 = +z, positive = right). */
  yaw = 0;
  /** y of the chassis up axis: 1 upright, 0 on its side, −1 on the roof. */
  upY = 1;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Planar speed, m/s. */
  speed = 0;
  /** Along the nose / toward the car's right, m/s. */
  vFwd = 0;
  vLat = 0;
  /** Body slip angle, rad (0 below walking pace). */
  beta = 0;
  /** rad/s, + = turning right. */
  yawRate = 0;

  // --- track
  /** Nearest centreline point. */
  index = 0;
  /** Arc length from the start line, 0..length. */
  s = 0;
  /** Signed offset from the centreline, m (+ = right of travel). */
  lateral = 0;
  /** Distance to the centreline, m. */
  distance = 0;
  /** Heading relative to the track direction, rad (0 = along it). */
  headingError = 0;
  /** Velocity component along the track direction, m/s. */
  speedAlong = 0;
  /** Velocity component across the track, m/s (+ = moving right). */
  lateralSpeed = 0;
  /**
   * Unwrapped distance raced, m: whole laps × track length + s. Negative on
   * the grid (behind the line). Race positions = sort by this.
   */
  progress = 0;
  /** Rate of change of `speedAlong`, m/s² (lightly smoothed; needs `dt`
   * passed to refresh()). */
  accelAlong = 0;
  /** Smoothed |acceleration along the track|, m/s²: low = the car has been
   * holding a steady speed for a moment (mid-corner, flat out), high = it
   * is braking or accelerating. */
  unsteady = 0;
  /**
   * The car's last APEX: the latest low point of its speed along the track
   * (confirmed once it has picked up 0.7 m/s again), where it was, and a
   * counter that goes up by one per apex. What a driver behind reads a
   * rival's cornering pace from.
   */
  apexSpeed = 0;
  apexIndex = 0;
  apexSerial = 0;

  private located = false;
  private prevAlong = 0;
  private prevValid = false;
  private extreme = 0;
  private extremeIndex = 0;
  /** −1 = looking for the next low of the speed trace, +1 = the next high. */
  private seeking = 0;
  private readonly lin = new Vector3();
  private readonly ang = new Vector3();
  private readonly hit: TrackProjection = { index: 0, s: 0, lateral: 0, distance: 0 };

  constructor(id: string, vehicle: Vehicle, geo: TrackGeometry) {
    this.id = id;
    this.vehicle = vehicle;
    this.geo = geo;
    const spec = vehicle.rig?.spec;
    this.halfWidth = (spec?.width ?? 2.1) / 2;
    this.halfLength = (spec?.length ?? 4.1) / 2;
  }

  /** Whole laps completed (0 until the line is crossed the first time
   * after the start counts as lap 0 → 1 at progress = length). */
  get lapsCompleted(): number {
    return Math.max(0, Math.floor(this.progress / this.geo.length));
  }

  /**
   * Read the pose and velocities, project onto the track.
   * @param dt  frame time; pass it ONCE per frame (RivalField.update does)
   *            so the acceleration estimate advances. A call without it
   *            only re-reads the pose.
   */
  refresh(dt = 0): void {
    const mesh = this.vehicle.chassisMesh;
    const pos = mesh.position;
    this.x = pos.x;
    this.y = pos.y;
    this.z = pos.z;
    const q = mesh.rotationQuaternion;
    let fx: number;
    let fz: number;
    if (q) {
      // Forward and up axes straight from the quaternion (no world-matrix
      // cache involved, so this is right even without a render).
      fx = 2 * (q.x * q.z + q.y * q.w);
      fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      this.upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    } else {
      fx = Math.sin(mesh.rotation.y);
      fz = Math.cos(mesh.rotation.y);
      this.upY = 1;
    }
    if (fx * fx + fz * fz > 1e-6) this.yaw = Math.atan2(fx, fz);
    const body = this.vehicle.chassisBody;
    body.getLinearVelocityToRef(this.lin);
    body.getAngularVelocityToRef(this.ang);
    const vx = Number.isFinite(this.lin.x) ? this.lin.x : 0;
    const vz = Number.isFinite(this.lin.z) ? this.lin.z : 0;
    this.vx = vx;
    this.vy = Number.isFinite(this.lin.y) ? this.lin.y : 0;
    this.vz = vz;
    this.yawRate = Number.isFinite(this.ang.y) ? this.ang.y : 0;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.vFwd = vx * sin + vz * cos;
    this.vLat = vx * cos - vz * sin;
    this.speed = Math.hypot(vx, vz);
    this.beta = this.speed < 1.5 ? 0 : Math.atan2(this.vLat, this.vFwd);

    if (!Number.isFinite(this.x + this.z)) return;
    const geo = this.geo;
    const hit = geo.project(this.x, this.z, this.located ? this.index : -1, this.hit);
    if (this.located) {
      this.progress += geo.arcDelta(this.s, hit.s);
    } else {
      // First fix: a car in the half lap behind the line is on the grid.
      this.progress = hit.s > geo.length / 2 ? hit.s - geo.length : hit.s;
      this.located = true;
    }
    this.index = hit.index;
    this.s = hit.s;
    this.lateral = hit.lateral;
    this.distance = hit.distance;
    const tx = geo.tx[hit.index];
    const tz = geo.tz[hit.index];
    this.speedAlong = vx * tx + vz * tz;
    this.lateralSpeed = vx * tz - vz * tx;
    let err = this.yaw - Math.atan2(tx, tz);
    if (err > Math.PI) err -= 2 * Math.PI;
    else if (err < -Math.PI) err += 2 * Math.PI;
    this.headingError = err;
    if (dt > 0) {
      if (this.prevValid) {
        const raw = (this.speedAlong - this.prevAlong) / dt;
        this.accelAlong += (raw - this.accelAlong) * Math.min(1, dt / 0.08);
        this.unsteady += (Math.abs(raw) - this.unsteady) * Math.min(1, dt / 0.3);
      }
      this.prevAlong = this.speedAlong;
      this.prevValid = true;
      // Lows of the speed trace, with 0.7 m/s of hysteresis.
      const v = this.speedAlong;
      if (this.seeking === 0) {
        this.seeking = -1;
        this.extreme = v;
        this.extremeIndex = this.index;
      } else if (this.seeking < 0) {
        if (v < this.extreme) {
          this.extreme = v;
          this.extremeIndex = this.index;
        } else if (v > this.extreme + 0.7) {
          this.apexSpeed = this.extreme;
          this.apexIndex = this.extremeIndex;
          this.apexSerial++;
          this.seeking = 1;
          this.extreme = v;
        }
      } else if (v > this.extreme) {
        this.extreme = v;
      } else if (v < this.extreme - 0.7) {
        this.seeking = -1;
        this.extreme = v;
        this.extremeIndex = this.index;
      }
    }
  }

  /**
   * Call after the car was TELEPORTED (respawn): re-acquires the track with
   * a whole-loop search. Progress moves by the signed shortest arc between
   * the old and the new position, so a respawn a few metres back costs
   * exactly those metres and keeps the lap count.
   */
  relocate(): void {
    const mesh = this.vehicle.chassisMesh;
    const geo = this.geo;
    const hit = geo.project(mesh.position.x, mesh.position.z, -1, this.hit);
    if (this.located) this.progress += geo.arcDelta(this.s, hit.s);
    else this.progress = hit.s > geo.length / 2 ? hit.s - geo.length : hit.s;
    this.located = true;
    this.index = hit.index;
    this.s = hit.s;
    this.lateral = hit.lateral;
    this.distance = hit.distance;
    this.prevValid = false;
    this.accelAlong = 0;
    this.unsteady = 0;
    this.seeking = 0;
  }
}
