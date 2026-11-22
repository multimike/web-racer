import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import type { Mesh } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { CarIntent } from '../input/types';
import type { WheelGroundState } from './Vehicle';

/**
 * What a VISUAL car needs from a vehicle model, in one object
 * (`Vehicle.visual`) — the same for every physics model, so graphics never
 * reach into a model's internals (wheel bodies, casts, constraints).
 *
 * MODEL SPACE = the space of `root` = `CarGeometry` model space = rig space:
 * origin on the ground under the wheelbase centre at static ride height,
 * +x right, +y up, +z nose. `root` is parented to the physics chassis, so a
 * body mesh parented to `root` follows the chassis with no per-frame code and
 * no one-frame lag.
 *
 * Typical use (see createVehicle.ts for the full recipe):
 *
 *   const car = instantiateCar(scene, asset);            // src/assets/assemble.ts
 *   car.root.parent = vehicle.visual.root;
 *   scene.onBeforeRenderObservable.add(() => {            // after the physics step
 *     const v = vehicle.visual;
 *     for (let i = 0; i < 4; i++) {
 *       const w = v.wheels[i];
 *       car.setHubTransform(i, w.position, w.rotation, w.spinAngle);
 *     }
 *     car.update(dt, v.throttle, v.steerAngle);           // links, spinners, steering wheel
 *   });
 */
export interface WheelPose {
  /** Hub (wheel) centre, MODEL space. Moves up/down with the suspension. */
  readonly position: Vector3;
  /** NON-SPINNING hub frame, MODEL space: x = axle toward the car's right,
   * y = up, z = forward; it steers with the wheel (yaw by `steerAngle`). */
  readonly rotation: Quaternion;
  /** The same two in WORLD space — only valid after `refreshWorld()`. */
  readonly worldPosition: Vector3;
  readonly worldRotation: Quaternion;
  /** Steer angle of this wheel relative to the chassis, rad (+ = right). */
  steerAngle: number;
  /** Accumulated roll angle about the axle, rad, wrapped to ±π·2
   * (+ = rolling forward). Rotate the wheel mesh about its local +X by it. */
  spinAngle: number;
  /** Spin rate, rad/s (+ = forward) — motion blur, brake glow, sound. */
  spinSpeed: number;
  /** Suspension travel from static ride height, m (+ = compressed). */
  travel: number;
  /** Tire is carrying load. */
  grounded: boolean;
  /** Tire radius, m. */
  radius: number;
}

export interface RestWheel {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class VehicleVisual {
  /** Parent your car model to this (MODEL space, see above). */
  readonly root: TransformNode;
  /** FL, FR, RL, RR. Refreshed by every `Vehicle.update()`. */
  readonly wheels: WheelPose[] = [];
  /** Pedals and stick as the car received them this frame. */
  throttle = 0;
  brake = 0;
  /** −1..1, + = right (the raw stick). */
  steerInput = 0;
  /** Bicycle-model steer angle of the front axle, rad (+ = right): what the
   * road wheels are really doing — drive the steering wheel from this. */
  steerAngle = 0;
  /** The brake trigger is currently acting as reverse throttle. */
  reversing = false;

  private mesh: Mesh;
  private rest: RestWheel[];
  private ox: number;
  private oy: number;
  private oz: number;

  /**
   * @param chassisMesh the physics chassis mesh
   * @param originInMesh where the model-space origin sits in the chassis
   *        mesh's own local coordinates
   * @param rest wheel centres at static ride height, model space
   */
  constructor(scene: Scene, chassisMesh: Mesh, originInMesh: { x: number; y: number; z: number }, rest: readonly RestWheel[]) {
    this.mesh = chassisMesh;
    this.ox = originInMesh.x;
    this.oy = originInMesh.y;
    this.oz = originInMesh.z;
    this.rest = rest.map((w) => ({ x: w.x, y: w.y, z: w.z, radius: w.radius }));
    this.root = new TransformNode('carVisualRoot', scene);
    this.root.parent = chassisMesh;
    this.root.position.set(this.ox, this.oy, this.oz);
    for (const w of this.rest) {
      this.wheels.push({
        position: new Vector3(w.x, w.y, w.z),
        rotation: Quaternion.Identity(),
        worldPosition: new Vector3(w.x, w.y, w.z),
        worldRotation: Quaternion.Identity(),
        steerAngle: 0,
        spinAngle: 0,
        spinSpeed: 0,
        travel: 0,
        grounded: true,
        radius: w.radius,
      });
    }
  }

  /**
   * Called by the model at the end of its update(): turn the per-wheel
   * ground states (world space, taken at the same instant as the chassis
   * pose) into model-space hub poses. No allocations.
   */
  capture(states: readonly WheelGroundState[], dt: number, intent: CarIntent, steerAngle: number, reversing: boolean): void {
    this.throttle = intent.throttle > 0 ? Math.min(intent.throttle, 1) : 0;
    this.brake = intent.brake > 0 ? Math.min(intent.brake, 1) : 0;
    this.steerInput = Number.isFinite(intent.steering) ? Math.max(-1, Math.min(1, intent.steering)) : 0;
    this.steerAngle = steerAngle;
    this.reversing = reversing;
    const p = this.mesh.position;
    const q = this.mesh.rotationQuaternion;
    if (!q) return;
    // Inverse rotation of the chassis (conjugate quaternion) on plain numbers.
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    for (let i = 0; i < this.wheels.length && i < states.length; i++) {
      const s = states[i];
      const w = this.wheels[i];
      const dx = s.position.x - p.x, dy = s.position.y - p.y, dz = s.position.z - p.z;
      if (Number.isFinite(dx + dy + dz)) {
        // v' = v + 2·q.xyz × (q.xyz × v + q.w·v)
        const cx = qy * dz - qz * dy + qw * dx;
        const cy = qz * dx - qx * dz + qw * dy;
        const cz = qx * dy - qy * dx + qw * dz;
        const lx = dx + 2 * (qy * cz - qz * cy);
        const ly = dy + 2 * (qz * cx - qx * cz);
        const lz = dz + 2 * (qx * cy - qy * cx);
        w.position.set(lx - this.ox, ly - this.oy, lz - this.oz);
      }
      w.travel = w.position.y - this.rest[i].y;
      w.steerAngle = s.steerAngle;
      const half = s.steerAngle * 0.5;
      w.rotation.set(0, Math.sin(half), 0, Math.cos(half));
      w.spinSpeed = s.spinSpeed;
      if (Number.isFinite(s.spinSpeed) && dt > 0) {
        w.spinAngle = (w.spinAngle + s.spinSpeed * dt) % (2 * Math.PI);
      }
      w.grounded = s.grounded;
    }
  }

  /**
   * Fill `worldPosition` / `worldRotation` of every wheel from the chassis
   * pose as it is NOW. Call it after the physics step (e.g. in
   * scene.onBeforeRenderObservable) if you need world-space hubs — skid
   * marks, particles, a camera. Not needed when the wheels are children of
   * `root`.
   */
  refreshWorld(): void {
    const m = this.root.computeWorldMatrix(true);
    const q = this.mesh.rotationQuaternion;
    for (const w of this.wheels) {
      Vector3.TransformCoordinatesToRef(w.position, m, w.worldPosition);
      if (q) q.multiplyToRef(w.rotation, w.worldRotation);
    }
  }

  /** Back to the static pose (the model calls this from reset()). */
  reset(): void {
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const r = this.rest[i];
      w.position.set(r.x, r.y, r.z);
      w.rotation.set(0, 0, 0, 1);
      w.steerAngle = 0;
      w.spinAngle = 0;
      w.spinSpeed = 0;
      w.travel = 0;
      w.grounded = true;
    }
    this.throttle = 0;
    this.brake = 0;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.reversing = false;
  }

  dispose(): void {
    this.root.dispose();
  }
}
