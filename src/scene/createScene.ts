import { Engine, Scene, Vector3, HemisphericLight, FollowCamera, ArcRotateCamera, HavokPlugin } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { createRaycastCar } from '../car/createRaycastCar';
import { RigidWheelVehicle } from '../car/RigidWheelVehicle';
import { buildEnvironment } from './environment';
import type { TerrainMode } from './environment';
import type { Vehicle } from '../car/Vehicle';
import type { InputProvider } from '../input/types';

export type VehicleMode = 'raycast' | 'rigid';
export type ViewMode = 'chase' | 'xr';
export type { TerrainMode };

// XR diorama simulation: the plan is a ~4 m table-scale render of the 200 m
// physics world (scale 0.02). A viewer with eyes 1.7 m above the floor is
// geometrically equivalent to a camera 1.7/0.02 = 85 m up in world units —
// same image, no scene-graph or physics changes needed.
const DIORAMA_SIZE = 4;
const XR_EYE_HEIGHT = 1.7;

export interface GameScene {
  engine: Engine;
  scene: Scene;
  car: Vehicle;
  mode: VehicleMode;
  terrain: TerrainMode;
  view: ViewMode;
}

export async function createScene(
  canvas: HTMLCanvasElement,
  input: InputProvider,
  mode: VehicleMode,
  terrain: TerrainMode,
  seed: number,
  view: ViewMode,
): Promise<GameScene> {
  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  const havokInstance = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havokInstance));

  new HemisphericLight('sun', new Vector3(0.3, 1, 0.2), scene);

  buildEnvironment(scene, terrain, seed);

  const car: Vehicle = mode === 'rigid'
    ? new RigidWheelVehicle(scene, input)
    : createRaycastCar(scene, input);

  if (view === 'xr') {
    // Standing viewer: eye 85 world-m up (= 1.7 m at diorama scale), looking
    // down at 45° at the terrain center, from the -z side so the spawned car
    // (heading +z) is seen from behind. Orbit/zoom enabled to "walk around
    // the table"; the default pose is the reference view.
    const eyeY = XR_EYE_HEIGHT / (DIORAMA_SIZE / 200);
    const camera = new ArcRotateCamera(
      'xrSimCam',
      -Math.PI / 2,      // alpha: camera on -z side
      Math.PI / 4,       // beta: 45° from vertical = 45° look-down angle
      eyeY * Math.SQRT2, // radius so camera height = eyeY at beta 45°
      Vector3.Zero(),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.maxZ = 1000;
    camera.wheelPrecision = 1;
    scene.activeCamera = camera;
  } else {
    const camera = new FollowCamera('chaseCam', car.chassisMesh.position.add(new Vector3(0, 6, -12)), scene);
    camera.lockedTarget = car.chassisMesh;
    camera.radius = 12;
    camera.heightOffset = 6;
    camera.rotationOffset = 180;
    camera.cameraAcceleration = 0.05;
    camera.maxCameraSpeed = 20;
    scene.activeCamera = camera;
  }

  engine.runRenderLoop(() => {
    // Clamp so a frame hitch (tab switch, GC pause, headset hiccup) can't
    // teleport/tunnel the car through geometry in one oversized step.
    const dt = Math.min(engine.getDeltaTime() / 1000, 1 / 30);
    car.update(dt);
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  return { engine, scene, car, mode, terrain, view };
}
