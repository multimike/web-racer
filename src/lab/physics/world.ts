import {
  Color3,
  HavokPlugin,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { AbstractEngine } from '@babylonjs/core';
import { generateTerrain } from '../../terrain/generateTerrain';
import { createTerrainCollider, createTerrainSurface } from '../../render/terrain';
import { createLook } from '../../gfx/look/lighting';
import type { WorldData } from '../../game/contracts/world';
import type { Heightfield } from '../../terrain/Heightfield';
import type { Track } from '../../terrain/track';

/**
 * Physics-only test worlds for the lab. Every maneuver case gets a FRESH
 * scene + Havok world, so results never depend on what ran before.
 *
 * Surfaces: the flat plane and the hills heightfield use friction 2.0 — with
 * Havok's default MINIMUM friction combine the TIRE's own coefficient is what
 * governs grip (same as the game's hills terrain). Ramps/kerbs use 1.0 like
 * the game's ramps.
 */

/** The game's gravity (createScene.ts) — the owner's feel choice, kept. */
export const LAB_GRAVITY = 25;

export type Obstacle =
  /** Tilted slab, entry edge flush with the ground at (x, z), rising along `yaw`. */
  | { type: 'ramp'; x: number; z: number; yaw?: number; angleDeg: number; width?: number; length?: number; baseY?: number }
  /** Sinusoidal ripple strip starting at (x, z), running +z. */
  | { type: 'washboard'; x: number; z: number; width?: number; length?: number; wavelength?: number; height?: number }
  /** Square-edged box lying on the ground. */
  | { type: 'kerb'; x: number; z: number; width?: number; depth?: number; height?: number }
  /** Half-buried static sphere. */
  | { type: 'boulder'; x: number; z: number; radius?: number; centerY?: number };

export interface WorldSpec {
  kind: 'flat' | 'hills';
  /** Terrain seed for 'hills'. */
  seed?: number;
  obstacles?: Obstacle[];
  /** hills only: put two jump ramps on the road (the game has none any more).
   * Unused option: no maneuver sets it today. */
  roadRamps?: boolean;
}

export interface LabWorld {
  scene: Scene;
  spec: WorldSpec;
  gravity: number;
  /** Ground height under (x, z) ignoring obstacles; exact for flat/hills. */
  groundHeight(x: number, z: number): number;
  /** True when groundHeight is the whole truth (no obstacle nearby matters). */
  track: Track | null;
  heightfield: Heightfield | null;
  /** 'flat', or 'createTerrainCollider' (the game's own heightfield body). */
  terrainSource: string;
  dispose(): void;
}

export const RAMP_WIDTH = 6;
export const RAMP_LENGTH = 10;

/**
 * `generateTerrain` plans the whole world (about 0.2 s) and the lab builds a
 * fresh world for every case, so the data is kept per seed. Every case still
 * gets its own scene, Havok world and collider body. The data is treated as
 * read-only; the one known writer, `maneuvers/race.ts` (`&raceHalfWidth=`
 * sets `track.halfWidth`), is handed a per-world shallow copy of the Track
 * (see buildWorld), so it cannot leak into later cases. The map never evicts:
 * about 5.9 MB per seed (~47 MB at the default `raceSeeds=8`).
 */
const WORLD_DATA = new Map<number, WorldData>();

function worldData(seed: number): WorldData {
  let data = WORLD_DATA.get(seed);
  if (!data) {
    data = generateTerrain(seed);
    WORLD_DATA.set(seed, data);
  }
  return data;
}

export function buildWorld(
  engine: AbstractEngine,
  havok: unknown,
  spec: WorldSpec,
  visible: boolean,
): LabWorld {
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -LAB_GRAVITY, 0), new HavokPlugin(true, havok));
  if (visible) {
    const light = new HemisphericLight('labLight', new Vector3(0.3, 1, -0.2), scene);
    light.intensity = 1.1;
    light.groundColor = new Color3(0.35, 0.35, 0.4);
  }

  let track: Track | null = null;
  let heightfield: Heightfield | null = null;
  let terrainSource = 'flat';

  if (spec.kind === 'flat') {
    // Top face at y = 0. Big enough for a 14 s full-throttle launch run.
    const ground = MeshBuilder.CreateBox('labGround', { width: 3000, height: 2, depth: 3000 }, scene);
    ground.position.y = -1;
    ground.isVisible = false;
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, friction: 2.0, restitution: 0 }, scene);
    if (visible) addGrid(scene);
  } else {
    const data = worldData(spec.seed ?? 1);
    // The game's own collider: same heights, same friction 2.0. It is the
    // only terrain call on the headless path (NullEngine: no meshes, no
    // shaders); watch mode adds the game's surface, without a second body.
    createTerrainCollider(scene, data);
    if (visible) {
      // The look runtime would otherwise be created lazily with syncScene on
      // and repaint the lab's dark clearColor / fog every frame.
      createLook(scene, { syncScene: false });
      createTerrainSurface(scene, data, { physics: false, groundTextureSize: 256 });
    }
    // Shallow copy: a maneuver may override scalar fields (race.ts widens
    // halfWidth) without writing into the cached, shared WorldData.
    track = { ...data.track };
    heightfield = data.heightfield;
    terrainSource = 'createTerrainCollider';
    if (spec.roadRamps && track) {
      for (const [fraction, angleDeg] of [[0.35, 12], [0.7, 18]] as const) {
        const i = Math.floor(fraction * track.count) % track.count;
        buildRamp(scene, {
          type: 'ramp',
          x: track.points[i * 2],
          z: track.points[i * 2 + 1],
          baseY: track.roadHeights[i],
          yaw: Math.atan2(track.tangents[i * 2], track.tangents[i * 2 + 1]),
          angleDeg,
        }, visible);
      }
    }
  }

  for (const obstacle of spec.obstacles ?? []) {
    switch (obstacle.type) {
      case 'ramp':
        buildRamp(scene, obstacle, visible);
        break;
      case 'washboard':
        buildWashboard(scene, obstacle, visible);
        break;
      case 'kerb': {
        const w = obstacle.width ?? 1.2;
        const d = obstacle.depth ?? 0.4;
        const h = obstacle.height ?? 0.15;
        const kerb = MeshBuilder.CreateBox('labKerb', { width: w, height: h, depth: d }, scene);
        kerb.position.set(obstacle.x, h / 2, obstacle.z);
        paint(kerb, visible, new Color3(0.8, 0.2, 0.2));
        new PhysicsAggregate(kerb, PhysicsShapeType.BOX, { mass: 0, friction: 1.0, restitution: 0 }, scene);
        break;
      }
      case 'boulder': {
        const r = obstacle.radius ?? 0.5;
        const boulder = MeshBuilder.CreateSphere('labBoulder', { diameter: r * 2, segments: 8 }, scene);
        boulder.position.set(obstacle.x, obstacle.centerY ?? r * 0.4, obstacle.z);
        paint(boulder, visible, new Color3(0.5, 0.5, 0.5));
        new PhysicsAggregate(boulder, PhysicsShapeType.SPHERE, { mass: 0, friction: 1.0, restitution: 0 }, scene);
        break;
      }
    }
  }

  const hf = heightfield;
  return {
    scene,
    spec,
    gravity: LAB_GRAVITY,
    groundHeight: hf ? (x, z) => hf.getHeight(x, z) : () => 0,
    track,
    heightfield,
    terrainSource,
    dispose: () => scene.dispose(),
  };
}

function paint(mesh: Mesh, visible: boolean, color: Color3): void {
  mesh.isVisible = visible;
  if (!visible) return;
  const mat = new StandardMaterial(`${mesh.name}Mat`, mesh.getScene());
  mat.diffuseColor = color;
  mat.specularColor = Color3.Black();
  mesh.material = mat;
}

/** Same construction as the flat arena's ramps (render/terrain/flatArena.ts): 0.5 m slab,
 * entry edge flush with the ground, friction 1.0. */
function buildRamp(scene: Scene, o: Extract<Obstacle, { type: 'ramp' }>, visible: boolean): void {
  const width = o.width ?? RAMP_WIDTH;
  const length = o.length ?? RAMP_LENGTH;
  const thickness = 0.5;
  const yaw = o.yaw ?? 0;
  const angle = (o.angleDeg * Math.PI) / 180;
  const ramp = MeshBuilder.CreateBox(`labRamp${o.angleDeg}`, { width, height: thickness, depth: length }, scene);
  ramp.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, -angle, 0);
  const along = (length / 2) * Math.cos(angle);
  ramp.position.set(
    o.x + Math.sin(yaw) * along,
    (o.baseY ?? 0) + (length / 2) * Math.sin(angle) - (thickness / 2) * Math.cos(angle),
    o.z + Math.cos(yaw) * along,
  );
  paint(ramp, visible, new Color3(0.75, 0.45, 0.15));
  new PhysicsAggregate(ramp, PhysicsShapeType.BOX, { mass: 0, friction: 1.0, restitution: 0 }, scene);
}

function buildWashboard(scene: Scene, o: Extract<Obstacle, { type: 'washboard' }>, visible: boolean): void {
  const width = o.width ?? 8;
  const wavelength = o.wavelength ?? 1.5;
  // Whole number of waves so both ends meet the ground flush.
  const length = Math.round((o.length ?? 30) / wavelength) * wavelength;
  const height = o.height ?? 0.08;
  const strip = MeshBuilder.CreateGround(
    'labWashboard',
    { width, height: length, subdivisionsX: 4, subdivisionsY: Math.round((length / wavelength) * 12), updatable: true },
    scene,
  );
  const positions = strip.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 2] + length / 2;
    positions[i + 1] = (height / 2) * (1 - Math.cos((2 * Math.PI * z) / wavelength));
  }
  strip.updateVerticesData(VertexBuffer.PositionKind, positions);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, strip.getIndices(), normals);
  strip.updateVerticesData(VertexBuffer.NormalKind, normals);
  strip.position.set(o.x, 0, o.z + length / 2);
  paint(strip, visible, new Color3(0.45, 0.45, 0.55));
  new PhysicsAggregate(strip, PhysicsShapeType.MESH, { mass: 0, friction: 1.0, restitution: 0 }, scene);
}

/** 10 m reference grid for ?watch=1 so motion over the flat plane is visible. */
function addGrid(scene: Scene): void {
  const lines: Vector3[][] = [];
  const half = 300;
  for (let i = -half; i <= half; i += 10) {
    lines.push([new Vector3(i, 0.01, -half), new Vector3(i, 0.01, half)]);
    lines.push([new Vector3(-half, 0.01, i), new Vector3(half, 0.01, i)]);
  }
  const grid = MeshBuilder.CreateLineSystem('labGrid', { lines }, scene);
  grid.color = new Color3(0.3, 0.45, 0.35);
  grid.isPickable = false;
}
