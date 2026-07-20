import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  DynamicTexture,
  PhysicsAggregate,
  PhysicsShapeType,
  Quaternion,
  Texture,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';

/** Static world: checkered ground (motion reference), walls, ramps, and a wavy road. */
export function buildEnvironment(scene: Scene): void {
  buildGround(scene);
  buildWalls(scene);
  // Three ramps ahead of spawn, increasing steepness left to right.
  buildRamp(scene, new Vector3(0, 0, 25), 12);
  buildRamp(scene, new Vector3(10, 0, 25), 18);
  buildRamp(scene, new Vector3(20, 0, 25), 25);
  buildWavyRoad(scene, new Vector3(-10, 0, 20));
}

function buildWalls(scene: Scene): void {
  const mat = new StandardMaterial('wallMat', scene);
  mat.diffuseColor = new Color3(0.5, 0.4, 0.35);
  mat.specularColor = Color3.Black();

  const walls: Array<{ pos: Vector3; rotY: number }> = [
    { pos: new Vector3(0, 1, -100), rotY: 0 },
    { pos: new Vector3(0, 1, 100), rotY: 0 },
    { pos: new Vector3(-100, 1, 0), rotY: Math.PI / 2 },
    { pos: new Vector3(100, 1, 0), rotY: Math.PI / 2 },
  ];
  walls.forEach(({ pos, rotY }, i) => {
    const wall = MeshBuilder.CreateBox(`wall${i}`, { width: 201, height: 2, depth: 1 }, scene);
    wall.position = pos;
    wall.rotationQuaternion = Quaternion.RotationAxis(Vector3.UpReadOnly, rotY);
    wall.material = mat;
    new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  });
}

function buildGround(scene: Scene): void {
  const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene);
  const groundMat = new StandardMaterial('groundMat', scene);

  // 2×2 checker, tiled 25× over 200 m → 4 m squares: cheap, strong speed cue.
  const tex = new DynamicTexture('checkerTex', 256, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = '#3a7a40';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#1e4a23';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillRect(128, 128, 128, 128);
  tex.update();
  tex.uScale = 25;
  tex.vScale = 25;
  // DynamicTexture defaults to CLAMP — with uScale > 1 that samples a single
  // edge texel everywhere past the first tile, hiding the pattern entirely.
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;

  groundMat.diffuseTexture = tex;
  groundMat.specularColor = Color3.Black();
  ground.material = groundMat;
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, friction: 1.0 }, scene);
}

function buildRamp(scene: Scene, position: Vector3, angleDeg: number): void {
  const width = 6;
  const thickness = 0.5;
  const length = 10;
  const angle = (angleDeg * Math.PI) / 180;

  const ramp = MeshBuilder.CreateBox(`ramp${angleDeg}`, { width, height: thickness, depth: length }, scene);
  // Lift the far (+z) end; sink so the top face meets the ground flush at the
  // entry edge — no lip to bump over.
  ramp.rotationQuaternion = Quaternion.RotationAxis(Vector3.RightReadOnly, -angle);
  ramp.position = position.add(
    new Vector3(0, (length / 2) * Math.sin(angle) - (thickness / 2) * Math.cos(angle), 0),
  );

  const mat = new StandardMaterial(`rampMat${angleDeg}`, scene);
  mat.diffuseColor = new Color3(0.75, 0.45, 0.15);
  mat.specularColor = Color3.Black();
  ramp.material = mat;

  new PhysicsAggregate(ramp, PhysicsShapeType.BOX, { mass: 0, friction: 1.0 }, scene);
}

function buildWavyRoad(scene: Scene, position: Vector3): void {
  const width = 8;
  const length = 40;
  const bumpHeight = 0.2; // peak-to-trough 2× this
  const wavelength = 5; // must divide length so the strip meets the ground flush at both ends

  const road = MeshBuilder.CreateGround(
    'wavyRoad',
    { width, height: length, subdivisionsX: 8, subdivisions: 80, updatable: true },
    scene,
  );
  const positions = road.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 2];
    positions[i + 1] = bumpHeight * (1 - Math.cos((2 * Math.PI * (z + length / 2)) / wavelength));
  }
  road.updateVerticesData(VertexBuffer.PositionKind, positions);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, road.getIndices(), normals);
  road.updateVerticesData(VertexBuffer.NormalKind, normals);
  road.position = position;

  const mat = new StandardMaterial('wavyRoadMat', scene);
  mat.diffuseColor = new Color3(0.45, 0.45, 0.5);
  mat.specularColor = Color3.Black();
  road.material = mat;

  new PhysicsAggregate(road, PhysicsShapeType.MESH, { mass: 0, friction: 1.0 }, scene);
}
