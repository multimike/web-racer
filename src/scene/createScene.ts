import { Engine, Scene, Vector3, HemisphericLight, FollowCamera, HavokPlugin } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { createRaycastCar } from '../car/createRaycastCar';
import { RigidWheelVehicle } from '../car/RigidWheelVehicle';
import { buildEnvironment } from './environment';
import type { Vehicle } from '../car/Vehicle';
import type { InputProvider } from '../input/types';

export type VehicleMode = 'raycast' | 'rigid';

export interface GameScene {
  engine: Engine;
  scene: Scene;
  car: Vehicle;
  mode: VehicleMode;
}

export async function createScene(
  canvas: HTMLCanvasElement,
  input: InputProvider,
  mode: VehicleMode,
): Promise<GameScene> {
  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  const havokInstance = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havokInstance));

  new HemisphericLight('sun', new Vector3(0.3, 1, 0.2), scene);

  buildEnvironment(scene);

  const car: Vehicle = mode === 'rigid'
    ? new RigidWheelVehicle(scene, input)
    : createRaycastCar(scene, input);

  const camera = new FollowCamera('chaseCam', car.chassisMesh.position.add(new Vector3(0, 6, -12)), scene);
  camera.lockedTarget = car.chassisMesh;
  camera.radius = 12;
  camera.heightOffset = 6;
  camera.rotationOffset = 180;
  camera.cameraAcceleration = 0.05;
  camera.maxCameraSpeed = 20;
  scene.activeCamera = camera;

  engine.runRenderLoop(() => {
    // Clamp so a frame hitch (tab switch, GC pause, headset hiccup) can't
    // teleport/tunnel the car through geometry in one oversized step.
    const dt = Math.min(engine.getDeltaTime() / 1000, 1 / 30);
    car.update(dt);
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  return { engine, scene, car, mode };
}
