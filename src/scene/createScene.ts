import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  FollowCamera,
  HavokPlugin,
  HemisphericLight,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { RigidWheelVehicle } from '../car/RigidWheelVehicle';
import { buildEnvironment } from './environment';
import type { TerrainMode } from './environment';
import { SUN_DIR } from '../terrain/generateTerrain';
import type { Heightfield } from '../terrain/Heightfield';
import type { Vehicle } from '../car/Vehicle';
import type { InputProvider } from '../input/types';

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
  terrain: TerrainMode;
  view: ViewMode;
}

export async function createScene(
  canvas: HTMLCanvasElement,
  input: InputProvider,
  terrain: TerrainMode,
  seed: number,
  view: ViewMode,
): Promise<GameScene> {
  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  const havokInstance = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havokInstance));

  // Sky + fog: warm light blue backdrop the rim melts into instead of black
  // void. Standard materials use scene fog; the terrain shader reads the same
  // color/density (set these BEFORE buildEnvironment creates the material).
  scene.clearColor = new Color4(0.72, 0.83, 0.94, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.76, 0.85, 0.94);
  scene.fogDensity = 0.0035;

  // Warm directional sun (shared with the terrain's baked shading) + cool
  // hemispheric fill so cars/props read with the same light language.
  const sun = new DirectionalLight('sun', new Vector3(-SUN_DIR.x, -SUN_DIR.y, -SUN_DIR.z), scene);
  sun.diffuse = new Color3(1.0, 0.93, 0.78);
  sun.intensity = 1.0;
  const fill = new HemisphericLight('fill', Vector3.Up(), scene);
  fill.diffuse = new Color3(0.42, 0.50, 0.62);
  fill.groundColor = new Color3(0.30, 0.28, 0.22);
  fill.intensity = 0.9;

  const builtTerrain = buildEnvironment(scene, terrain, seed);

  const car: Vehicle = new RigidWheelVehicle(scene, input);

  const shadow = createBlobShadow(scene);

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
    camera.radius = 50;
    camera.heightOffset = 20;
    camera.rotationOffset = 180;
    camera.cameraAcceleration = 0.02;
    camera.maxCameraSpeed = 20;
    scene.activeCamera = camera;
  }

  engine.runRenderLoop(() => {
    // Clamp so a frame hitch (tab switch, GC pause, headset hiccup) can't
    // teleport/tunnel the car through geometry in one oversized step.
    const dt = Math.min(engine.getDeltaTime() / 1000, 1 / 30);
    car.update(dt);
    updateBlobShadow(shadow, car, builtTerrain?.heightfield ?? null);
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  return { engine, scene, car, terrain, view };
}

/** Soft dark disc that follows the car at ground height — grounds the car
 * visually for a fraction of a shadow map's cost (Quest-friendly). */
function createBlobShadow(scene: Scene) {
  const mesh = MeshBuilder.CreateGround('carShadow', { width: 3.4, height: 4.2 }, scene);
  const tex = new DynamicTexture('carShadowTex', 128, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.6, '#999999');
  grad.addColorStop(1, '#000000');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  tex.update();
  // Luminance-as-alpha: white center = opaque shadow, black edge = invisible.
  tex.getAlphaFromRGB = true;

  const mat = new StandardMaterial('carShadowMat', scene);
  mat.opacityTexture = tex;
  mat.diffuseColor = Color3.Black();
  mat.emissiveColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.alpha = 0.32;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.rotationQuaternion = Quaternion.Identity();
  return mesh;
}

function updateBlobShadow(
  shadow: ReturnType<typeof createBlobShadow>,
  car: Vehicle,
  hf: Heightfield | null,
): void {
  const p = car.chassisMesh.position;
  const groundY = hf ? hf.getHeight(p.x, p.z) : 0;
  // Slightly above the surface to avoid z-fighting; fades nothing at this scale.
  shadow.position.set(p.x, groundY + 0.08, p.z);
  if (hf) {
    // Tilt to the local surface so the blob hugs slopes instead of clipping.
    const n = hf.getNormal(p.x, p.z);
    const q = shadow.rotationQuaternion!;
    // Quaternion rotating +Y onto n: axis = up × n, angle = acos(n.y).
    const ax = -n.z;
    const az = n.x;
    const axisLen = Math.hypot(ax, az);
    if (axisLen > 1e-6) {
      const angle = Math.acos(Math.min(Math.max(n.y, -1), 1));
      const s = Math.sin(angle / 2) / axisLen;
      q.set(ax * s, 0, az * s, Math.cos(angle / 2));
    } else {
      q.set(0, 0, 0, 1);
    }
  }
}
