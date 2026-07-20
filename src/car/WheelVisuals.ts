import { Mesh, MeshBuilder, StandardMaterial, Color3, TransformNode, Vector3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { RaycastVehicle } from './RaycastVehicle';

/**
 * Cosmetic wheel meshes for a RaycastVehicle. Each wheel is a cylinder under
 * two pivots: an outer one for steering (yaw) and an inner one that carries
 * suspension travel (y) and rolling spin (x). No physics involved.
 */
export class WheelVisuals {
  private steerPivots: TransformNode[] = [];
  private spinPivots: TransformNode[] = [];

  constructor(vehicle: RaycastVehicle, chassis: Mesh, scene: Scene, wheelRadius: number, wheelWidth = 0.5) {
    const wheelMat = new StandardMaterial('wheelMat', scene);
    wheelMat.diffuseColor = new Color3(0.12, 0.12, 0.12);

    vehicle.wheels.forEach((wheel, i) => {
      const steerPivot = new TransformNode(`wheelSteer${i}`, scene);
      steerPivot.parent = chassis;
      steerPivot.position = wheel.config.localPosition.clone();

      const spinPivot = new TransformNode(`wheelSpin${i}`, scene);
      spinPivot.parent = steerPivot;
      spinPivot.position = new Vector3(0, -wheel.suspensionLength, 0);

      const mesh = MeshBuilder.CreateCylinder(
        `wheel${i}`,
        { diameter: wheelRadius * 2, height: wheelWidth, tessellation: 20 },
        scene,
      );
      mesh.rotation.z = Math.PI / 2; // cylinder axis from y to x
      mesh.material = wheelMat;
      mesh.parent = spinPivot;

      this.steerPivots.push(steerPivot);
      this.spinPivots.push(spinPivot);
    });

    this.vehicle = vehicle;
  }

  private vehicle: RaycastVehicle;

  sync(): void {
    this.vehicle.wheels.forEach((wheel, i) => {
      this.steerPivots[i].rotation.y = wheel.config.steered ? this.vehicle.currentSteerAngle : 0;
      this.spinPivots[i].position.y = -wheel.suspensionLength;
      this.spinPivots[i].rotation.x = wheel.spin;
    });
  }
}
