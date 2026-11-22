import type { Vehicle } from '../Vehicle';
import { CarTracker } from './CarTracker';
import { TrackGeometry } from './RaceLine';
import type { RivalTrack } from './RaceLine';
import type { RivalDriver } from './RivalDriver';

/**
 * RivalField — every car of a race as seen by the rival drivers: one
 * `CarTracker` per car (rivals AND the player), the shared track geometry,
 * race order, the rubber band and rescue poses.
 *
 * PER FRAME, in this order:
 *
 *   field.update(dt);                      // 1. trackers read the cars as the
 *                                          //    last physics step left them,
 *                                          //    then every rival decides
 *   for (const car of cars) car.update(dt) // 2. vehicles poll their input
 *   …physics step (scene.render())…        // 3.
 *
 * and wherever the game handles respawns (after the step is fine):
 *
 *   for (const d of field.rivals) if (d.driver.rescue) {
 *     const pose = field.rescuePose(d.tracker.id);
 *     d.tracker.vehicle.reset(new Vector3(pose.x, heightAt(pose.x, pose.z), pose.z), pose.yaw);
 *     field.respawned(d.tracker.id);
 *   }
 *
 * RACE ORDER: `field.standings()` (leader first) / `field.positionOf(id)`
 * (1-based) sort by `CarTracker.progress` (metres raced, laps included). It
 * is a plain "who is further round" order — laps, finishing and shortcut
 * rules belong to the game's RaceState, which can be fed the same cars.
 *
 * RUBBER BAND: with a player set, a rival ahead of the player eases off and
 * a rival behind pushes harder, by at most `rubberBand` (default 4 %, hard
 * limit 8 %) once the gap exceeds `rubberBandDeadZone`, fully at
 * `rubberBandRange`. It only changes how hard the DRIVER tries (planned
 * grip, top-speed share, throttle ceiling); the car is never altered, so a
 * rival that is already at the car's limit gains nothing from it.
 */
export interface RivalFieldOptions {
  /** Max pace change toward the player, 0..0.08. Default 0.04. 0 = off. */
  rubberBand?: number;
  /** Gap to the player below which nothing happens, m. Default 8. */
  rubberBandDeadZone?: number;
  /** Gap at which the full band applies, m. Default 60. */
  rubberBandRange?: number;
}

export interface RescuePose {
  /** Point on the road centre (take y from the terrain if you have it). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Arc length of the pose. */
  s: number;
}

export interface FieldRival {
  readonly tracker: CarTracker;
  readonly driver: RivalDriver;
}

export const MAX_RUBBER_BAND = 0.08;

export class RivalField {
  readonly geo: TrackGeometry;
  /** Every car, in the order it was added. */
  readonly cars: CarTracker[] = [];
  /** The AI-driven subset. */
  readonly rivals: FieldRival[] = [];
  rubberBand: number;
  rubberBandDeadZone: number;
  rubberBandRange: number;

  private player: CarTracker | null = null;
  private readonly order: CarTracker[] = [];
  private readonly pose: RescuePose = { x: 0, y: 0, z: 0, yaw: 0, s: 0 };

  constructor(track: RivalTrack, options: RivalFieldOptions = {}) {
    this.geo = new TrackGeometry(track);
    this.rubberBand = options.rubberBand ?? 0.04;
    this.rubberBandDeadZone = options.rubberBandDeadZone ?? 8;
    this.rubberBandRange = options.rubberBandRange ?? 60;
  }

  /** Add an AI car. The driver must be the vehicle's InputProvider. */
  addRival(id: string, vehicle: Vehicle, driver: RivalDriver): CarTracker {
    const tracker = this.add(id, vehicle);
    tracker.driven = true;
    driver.attach(vehicle, tracker);
    this.rivals.push({ tracker, driver });
    return tracker;
  }

  /** Add a car the rivals must race around but do not drive (the player, a
   * remote player). `player: true` makes it the rubber-band reference. */
  addCar(id: string, vehicle: Vehicle, player = false): CarTracker {
    const tracker = this.add(id, vehicle);
    if (player) this.player = tracker;
    return tracker;
  }

  private add(id: string, vehicle: Vehicle): CarTracker {
    if (this.cars.some((c) => c.id === id)) throw new Error(`RivalField: duplicate car id '${id}'`);
    const tracker = new CarTracker(id, vehicle, this.geo);
    tracker.refresh();
    this.cars.push(tracker);
    this.order.push(tracker);
    return tracker;
  }

  remove(id: string): void {
    const drop = (list: CarTracker[]) => {
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) list.splice(i, 1);
    };
    drop(this.cars);
    drop(this.order);
    const r = this.rivals.findIndex((d) => d.tracker.id === id);
    if (r >= 0) this.rivals.splice(r, 1);
    if (this.player?.id === id) this.player = null;
  }

  tracker(id: string): CarTracker | undefined {
    for (const c of this.cars) if (c.id === id) return c;
    return undefined;
  }

  driver(id: string): RivalDriver | undefined {
    for (const d of this.rivals) if (d.tracker.id === id) return d.driver;
    return undefined;
  }

  /** Lights out for every rival. */
  start(): void {
    for (const d of this.rivals) d.driver.start();
  }

  /** A new race (restart): every driver forgets what it learned in the last
   * one (RivalDriver.newRace). Call once the cars are back on the grid and
   * re-located, before hold() / start(). */
  newRace(): void {
    for (const d of this.rivals) d.driver.newRace();
  }

  /** Everyone back to "waiting on the grid" (feet off). */
  hold(): void {
    for (const d of this.rivals) d.driver.hold();
  }

  /** See the class comment for where this goes in the frame. */
  update(dt: number): void {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) cars[i].refresh(dt);
    const player = this.player;
    const band = Math.min(Math.max(this.rubberBand, 0), MAX_RUBBER_BAND);
    const rivals = this.rivals;
    for (let i = 0; i < rivals.length; i++) {
      const d = rivals[i];
      let pace = 0;
      if (player && band > 0) {
        // + = this rival is ahead of the player → ease off.
        const gap = d.tracker.progress - player.progress;
        const beyond = Math.abs(gap) - this.rubberBandDeadZone;
        if (beyond > 0) {
          const span = Math.max(1, this.rubberBandRange - this.rubberBandDeadZone);
          pace = -Math.sign(gap) * band * Math.min(1, beyond / span);
        }
      }
      d.driver.pace = pace;
      d.driver.think(dt, cars);
    }
  }

  /** Cars in race order, leader first (the array is reused — do not keep). */
  standings(): readonly CarTracker[] {
    const order = this.order;
    // Insertion sort: 4–8 cars, almost always already sorted.
    for (let i = 1; i < order.length; i++) {
      const c = order[i];
      let j = i - 1;
      while (j >= 0 && order[j].progress < c.progress) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = c;
    }
    return order;
  }

  /** 1-based race position, 0 for an unknown id. */
  positionOf(id: string): number {
    const order = this.standings();
    for (let i = 0; i < order.length; i++) if (order[i].id === id) return i + 1;
    return 0;
  }

  /**
   * Where to put a car that asked for a rescue: on the road centre a little
   * behind where it is now, moved further back until no other car is within
   * `clear` metres. The returned object is reused.
   */
  rescuePose(id: string, backoff = 3, clear = 7): RescuePose {
    const geo = this.geo;
    const me = this.tracker(id);
    const pose = this.pose;
    let index = me ? me.index : 0;
    index = geo.wrapIndex(index - Math.round(backoff / geo.meanStep));
    const step = Math.max(1, Math.round(clear / geo.meanStep));
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = geo.px[index];
      const z = geo.pz[index];
      let free = true;
      for (const o of this.cars) {
        if (o === me || !o.active) continue;
        if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < clear * clear) {
          free = false;
          break;
        }
      }
      if (free) break;
      index = geo.wrapIndex(index - step);
    }
    pose.x = geo.px[index];
    pose.z = geo.pz[index];
    pose.y = geo.height[index];
    pose.yaw = Math.atan2(geo.tx[index], geo.tz[index]);
    pose.s = geo.s[index];
    return pose;
  }

  /** Tell the field a car was teleported (after Vehicle.reset). */
  respawned(id: string): void {
    const tracker = this.tracker(id);
    if (!tracker) return;
    tracker.relocate();
    tracker.refresh();
    this.driver(id)?.respawned();
  }
}
