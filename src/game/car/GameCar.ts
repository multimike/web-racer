import { Vector3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { carContact, instantiateCar } from '../../assets/assemble';
import type { CarInstance } from '../../assets/assemble';
import { loadAsset } from '../../assets/registry';
import { createVehicle } from '../../car/createVehicle';
import type { Vehicle } from '../../car/Vehicle';
import type { ContactOccluder } from '../../gfx/look/lighting';
import type { InputProvider } from '../../input/types';
import type { CarLodLevel, CreateGameCar, GameCar, GameCarOptions } from '../contracts/car';
import type { Vec3Like } from '../contracts/world';
import { isFollowedByCamera } from '../camera/followed';
import { CarLod } from './CarLod';

/**
 * One car of the game (contract: src/game/contracts/car.ts): a physics
 * `Vehicle` of any model wearing one of the procedural car designs.
 *
 *   const car = await createGameCar(scene, input, { id: 'player', carId: 'reef-rocket' });
 *   car.place(ground, yaw);
 *   // per frame:
 *   car.vehicle.update(dt);                  // before the physics step
 *   scene.render();                          // steps Havok …
 *   car.syncVisual(dt, rig.eye);             // … in onAfterPhysicsObservable
 *
 * The bodywork hangs off `vehicle.visual.root` (model space, parented to the
 * physics chassis), so it follows the chassis with no code and no lag;
 * `syncVisual` only poses what moves relative to it — hubs, links, spinners,
 * the steering wheel — and picks the level of detail.
 *
 * LOD is by distance from `cameraPosition`, EXCEPT for the car a chase /
 * high camera rig is following (src/game/camera/followed.ts): that one
 * always shows level 0. The high camera sits ~18 m from its subject, past
 * the 14 m LOD 0 distance (8 m on `quest`), and the followed car's
 * suspension is what the player looks at. `lodOverride` still wins.
 */

const DEFAULT_LOD_DISTANCES: [number, number] = [14, 45];
const DEFAULT_LITE_RATIO = 0.12;

class GameCarImpl implements GameCar {
  readonly id: string;
  readonly carId: string;
  readonly livery: number;
  readonly vehicle: Vehicle;
  readonly instance: CarInstance;
  readonly contact: ContactOccluder = { x: 0, z: 0, yaw: 0, halfX: 0, halfZ: 0, y: 0 };
  readonly lodState: CarLod;
  private disposed = false;

  constructor(id: string, carId: string, livery: number, vehicle: Vehicle, instance: CarInstance, lod: CarLod) {
    this.id = id;
    this.carId = carId;
    this.livery = livery;
    this.vehicle = vehicle;
    this.instance = instance;
    this.lodState = lod;
    carContact(instance, this.contact);
  }

  get lod(): CarLodLevel {
    return this.lodState.level;
  }

  get lodOverride(): CarLodLevel | null {
    return this.lodState.override;
  }

  set lodOverride(level: CarLodLevel | null) {
    this.lodState.override = level;
  }

  get triangles(): number {
    return this.lodState.triangles;
  }

  get fullTriangles(): number {
    return this.lodState.trianglesAt[0];
  }

  syncVisual(dt: number, cameraPosition: Vec3Like): void {
    const visual = this.vehicle.visual;
    const inst = this.instance;
    const wheels = visual.wheels;
    for (let i = 0; i < 4 && i < wheels.length; i++) {
      const w = wheels[i];
      inst.setHubTransform(i, w.position, w.rotation, w.spinAngle);
    }
    const p = this.vehicle.chassisMesh.position;
    const level = this.lodState.choose(
      isFollowedByCamera(this.vehicle) ? 0 : Math.hypot(cameraPosition.x - p.x, cameraPosition.y - p.y, cameraPosition.z - p.z),
    );
    if (level === 0) {
      inst.update(dt, visual.throttle, visual.steerAngle);
    } else if (this.lodState.showsLite) {
      // Lite meshes only: spinners are hidden, nothing to advance.
      this.lodState.syncLite();
    } else {
      // Links, uprights and the steering wheel are hidden: no posing.
      inst.advanceSpinners(dt, visual.throttle);
    }
    carContact(inst, this.contact);
  }

  place(ground: Vec3Like, yaw: number): void {
    this.vehicle.reset(new Vector3(ground.x, ground.y, ground.z), yaw);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lodState.dispose();
    this.instance.dispose();
    this.vehicle.dispose();
  }
}

export const createGameCar: CreateGameCar = async (scene: Scene, input: InputProvider, options: GameCarOptions): Promise<GameCar> => {
  const asset = await loadAsset(options.carId);
  if (asset.kind !== 'car') {
    throw new Error(`createGameCar: asset '${options.carId}' is a ${asset.kind}, not a car`);
  }
  const vehicle = createVehicle(scene, input, { model: options.model, carId: options.carId, tune: options.tune });
  try {
    const n = Math.max(1, asset.liveries);
    const livery = (((options.livery ?? 0) % n) + n) % n;
    // Casters are the LOD's business (body, driver, wheels only).
    const instance = instantiateCar(scene, asset, livery, { castShadows: false });
    instance.root.parent = vehicle.visual.root;
    const lod = new CarLod(scene, instance, {
      lodDistances: options.lodDistances ?? DEFAULT_LOD_DISTANCES,
      simplify: options.simplify,
      liteRatio: options.liteRatio ?? DEFAULT_LITE_RATIO,
      castShadows: options.castShadows ?? true,
    });
    return new GameCarImpl(options.id, options.carId, livery, vehicle, instance, lod);
  } catch (e) {
    vehicle.dispose();
    throw e;
  }
};
