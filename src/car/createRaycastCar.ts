import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  PhysicsAggregate,
  PhysicsShapeType,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { InputProvider } from '../input/types';
import type { Vehicle } from './Vehicle';
import { RaycastVehicle, DEFAULT_TUNING } from './RaycastVehicle';
import { WheelVisuals } from './WheelVisuals';

/** Builds the raycast-suspension car (red) and wraps it in the Vehicle interface. */
export function createRaycastCar(scene: Scene, input: InputProvider): Vehicle & { impl: RaycastVehicle } {
  const carMesh = MeshBuilder.CreateBox('car', { width: 1.4, height: 0.6, depth: 2.4 }, scene);
  carMesh.position.y = 1.6;
  const carMat = new StandardMaterial('carMat', scene);
  carMat.diffuseColor = new Color3(0.85, 0.15, 0.15);
  carMesh.material = carMat;

  const carAggregate = new PhysicsAggregate(
    carMesh,
    PhysicsShapeType.BOX,
    { mass: 5, friction: 0.5, restitution: 0.1 },
    scene,
  );
  // Low center of mass = resists rollover without faking inertia.
  carAggregate.body.setMassProperties({ mass: 5, centerOfMass: new Vector3(0, -0.15, 0) });
  carAggregate.body.setAngularDamping(0.3);
  carAggregate.body.setLinearDamping(0.05);

  const tuning = DEFAULT_TUNING;
  // Attach points sit above the bottom face (local y -0.3) so rays start
  // inside the chassis; x puts the monster wheels fully outboard with a
  // ~0.1 m gap between wheel inner face and the body side (0.7 half-width).
  const wheelY = -0.2;
  const wheelX = 1.05;
  const wheelZ = 1.0;
  const vehicle = new RaycastVehicle(
    carAggregate.body,
    carMesh,
    input,
    scene,
    [
      { localPosition: new Vector3(-wheelX, wheelY, wheelZ), steered: true, driven: false },
      { localPosition: new Vector3(wheelX, wheelY, wheelZ), steered: true, driven: false },
      { localPosition: new Vector3(-wheelX, wheelY, -wheelZ), steered: false, driven: true },
      { localPosition: new Vector3(wheelX, wheelY, -wheelZ), steered: false, driven: true },
    ],
    tuning,
  );
  const wheelVisuals = new WheelVisuals(vehicle, carMesh, scene, tuning.wheelRadius);

  return {
    chassisMesh: carMesh,
    impl: vehicle,
    update(dt: number): void {
      vehicle.update(dt);
      wheelVisuals.sync();
    },
  };
}
