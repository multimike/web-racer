import {
  Effect,
  Mesh,
  PhysicsAggregate,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeMesh,
  PhysicsShapeType,
  Quaternion,
  ShaderMaterial,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { toyMaterial } from '../../assets/assemble';
import { BUILDING, STONE } from '../../assets/palette';
import type { FlatArena, CreateFlatArena } from '../../game/contracts/terrain';
import type { GroundQuery, Vec3Like } from '../../game/contracts/world';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, getLook, registerLookShaders } from '../../gfx/look/lighting';
import { SolidMesh, box, paint } from '../../gfx/solid';
import { groundVertexShader } from './TerrainLookMaterial';

/**
 * `?terrain=flat`: the legacy game's test arena (it lived in the deleted
 * src/scene/environment.ts), same dimensions and friction values, in the
 * new look — a look-matte checker
 * floor (contact receiver, so cars get their pools), toy-material walls,
 * ramps and wavy road that cast sun shadows.
 */

const HALF = 100;
const CHECKER = 'renderArenaChecker';

const CHECKER_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  #include<lookLighting>
  // Box-filtered 4 m checker: no staircase, no shimmer at a grazing angle.
  float checker(vec2 p) {
    vec2 w = max(fwidth(p), vec2(1e-4));
    vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
    return 0.5 - 0.5 * i.x * i.y;
  }
  void main() {
    float c = checker(vWorldPos.xz / 4.0);
    // The legacy arena's two greens (#3a7a40 / #1e4a23), sRGB.
    vec3 srgb = mix(vec3(0.227, 0.478, 0.251), vec3(0.118, 0.29, 0.137), c);
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), normalize(vNormal), vWorldPos, 1.0, 1.0);
  }
`;

function checkerMaterial(scene: Scene): ShaderMaterial {
  if (!Effect.ShadersStore[`${CHECKER}VertexShader`]) {
    registerLookShaders();
    Effect.ShadersStore[`${CHECKER}VertexShader`] = groundVertexShader('', '', '');
    Effect.ShadersStore[`${CHECKER}FragmentShader`] = CHECKER_FRAGMENT;
  }
  const mat = new ShaderMaterial('arenaChecker', scene, CHECKER, {
    attributes: ['position', 'normal'],
    uniforms: ['world', 'viewProjection', ...LOOK_UNIFORMS],
    samplers: [...LOOK_SAMPLERS],
  });
  getLook(scene).register(mat, { contact: true });
  return mat;
}

function toyMesh(name: string, m: SolidMesh, scene: Scene): Mesh {
  const mesh = m.build(name, scene);
  mesh.material = toyMaterial(scene);
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false;
  mesh.isPickable = false;
  getLook(scene).shadows.addCaster(mesh);
  return mesh;
}

/** The wavy road's surface height, m: peaks 0.4 m every 5 m, flush at both
 * ends of the 40 m strip (zLocal −20 … 20). */
function wavyHeight(zLocal: number): number {
  return 0.2 * (1 - Math.cos((2 * Math.PI * (zLocal + 20)) / 5));
}

export const createFlatArena: CreateFlatArena = (scene: Scene): FlatArena => {
  const meshes: Mesh[] = [];
  const aggregates: PhysicsAggregate[] = [];
  const bodies: PhysicsBody[] = [];
  const nodes: TransformNode[] = [];
  const physics = scene.isPhysicsEnabled();

  // Floor: one quad, drawn by the checker shader; physics is a static 1 m
  // thick box whose top face is y = 0.
  const floor = new Mesh('arenaFloor', scene);
  const fd = new VertexData();
  fd.positions = [-HALF, 0, -HALF, HALF, 0, -HALF, HALF, 0, HALF, -HALF, 0, HALF];
  fd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  fd.indices = [0, 2, 1, 0, 3, 2];
  fd.applyToMesh(floor, false);
  const floorMat = checkerMaterial(scene);
  floorMat.backFaceCulling = false;
  floor.material = floorMat;
  floor.applyFog = false;
  floor.isPickable = false;
  floor.freezeWorldMatrix();
  meshes.push(floor);
  if (physics) {
    const node = new TransformNode('arenaFloorBody', scene);
    const shape = new PhysicsShapeBox(new Vector3(0, -0.5, 0), Quaternion.Identity(), new Vector3(2 * HALF, 1, 2 * HALF), scene);
    shape.material = { friction: 1.0, restitution: 0 };
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
    body.shape = shape;
    nodes.push(node);
    bodies.push(body);
  }

  // Walls 201 × 2 × 1 m, centred 1 m up at ±100.
  const wallPaint = paint(BUILDING.stone, { gloss: 0.12 });
  const walls: { x: number; z: number; rotY: number }[] = [
    { x: 0, z: -HALF, rotY: 0 },
    { x: 0, z: HALF, rotY: 0 },
    { x: -HALF, z: 0, rotY: Math.PI / 2 },
    { x: HALF, z: 0, rotY: Math.PI / 2 },
  ];
  walls.forEach((w, i) => {
    const m = new SolidMesh();
    box(m, { size: [201, 2, 1] }, wallPaint);
    const mesh = toyMesh(`arenaWall${i}`, m, scene);
    mesh.position.set(w.x, 1, w.z);
    mesh.rotationQuaternion = Quaternion.RotationAxis(Vector3.UpReadOnly, w.rotY);
    meshes.push(mesh);
    if (physics) aggregates.push(new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene));
  });

  // Ramps 6 × 0.5 × 10 m; ENTRY EDGE at the given point, rising toward +z,
  // top face flush with the floor at the entry edge (legacy construction).
  const rampPaints = [paint(BUILDING.mustard, { gloss: 0.15 }), paint(BUILDING.apricot, { gloss: 0.15 }), paint(BUILDING.coral, { gloss: 0.15 })];
  const ramps: { x: number; deg: number }[] = [
    { x: 0, deg: 12 },
    { x: 10, deg: 18 },
    { x: 20, deg: 25 },
  ];
  ramps.forEach((r, i) => {
    const width = 6;
    const thickness = 0.5;
    const length = 10;
    const angle = (r.deg * Math.PI) / 180;
    const m = new SolidMesh();
    box(m, { size: [width, thickness, length] }, rampPaints[i]);
    const mesh = toyMesh(`arenaRamp${r.deg}`, m, scene);
    mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, -angle, 0);
    mesh.position.set(r.x, (length / 2) * Math.sin(angle) - (thickness / 2) * Math.cos(angle), 25 + (length / 2) * Math.cos(angle));
    meshes.push(mesh);
    if (physics) aggregates.push(new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 1.0 }, scene));
  });

  // Wavy road 8 × 40 m centred at (−10, 0, 20), 80 rows along z. The drawn
  // mesh adds side skirts down to the floor (the strip stands up to 0.4 m
  // proud); the collider is the top surface only, as before.
  const W = 8;
  const L = 40;
  const ROWS = 80;
  const COLS = 8;
  const wavyPaint = paint(STONE.midSlate, { gloss: 0.1, smooth: 180 });
  const skirtPaint = paint(STONE.midSlate, { gloss: 0.1, smooth: 0 });
  const top = new SolidMesh();
  for (let r = 0; r < ROWS; r++) {
    const z0 = -L / 2 + (L * r) / ROWS;
    const z1 = -L / 2 + (L * (r + 1)) / ROWS;
    const y0 = wavyHeight(z0);
    const y1 = wavyHeight(z1);
    for (let c = 0; c < COLS; c++) {
      const x0 = -W / 2 + (W * c) / COLS;
      const x1 = -W / 2 + (W * (c + 1)) / COLS;
      top.quad([x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0], wavyPaint);
    }
  }
  const drawn = top.clone();
  for (let r = 0; r < ROWS; r++) {
    const z0 = -L / 2 + (L * r) / ROWS;
    const z1 = -L / 2 + (L * (r + 1)) / ROWS;
    const y0 = wavyHeight(z0);
    const y1 = wavyHeight(z1);
    // Outward faces on −x and +x; a triangle where the strip meets the
    // floor (no degenerate faces).
    for (const sx of [-1, 1]) {
      const x = (sx * W) / 2;
      const flip = sx > 0;
      const quad: [number, number, number][] = [[x, 0, z0], [x, 0, z1], [x, y1, z1], [x, y0, z0]].filter(
        (_p, i) => !((i === 2 && y1 < 1e-6) || (i === 3 && y0 < 1e-6)),
      ) as [number, number, number][];
      if (flip) quad.reverse();
      if (quad.length === 4) drawn.quad(quad[0], quad[1], quad[2], quad[3], skirtPaint);
      else if (quad.length === 3) drawn.tri(quad[0], quad[1], quad[2], skirtPaint);
    }
  }
  const wavy = toyMesh('arenaWavyRoad', drawn, scene);
  wavy.position.set(-10, 0, 20);
  wavy.freezeWorldMatrix();
  meshes.push(wavy);
  if (physics) {
    const surface = top.build('arenaWavyCollider', scene);
    surface.position.set(-10, 0, 20);
    surface.isVisible = false;
    surface.isPickable = false;
    surface.computeWorldMatrix(true);
    const shape = new PhysicsShapeMesh(surface, scene);
    shape.material = { friction: 1.0, restitution: 0 };
    const body = new PhysicsBody(surface, PhysicsMotionType.STATIC, false, scene);
    body.shape = shape;
    bodies.push(body);
    nodes.push(surface);
  }
  for (const m of meshes) m.freezeWorldMatrix();

  const heightAt = (_x: number, _z: number): number => 0;
  const normalAt = (_x: number, _z: number, out: Vec3Like): Vec3Like => {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  };
  const surfaceAt = (_x: number, _z: number, out: Float32Array): void => {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
  };
  const pavedAt = (_x: number, _z: number): number => 0;
  const ground: GroundQuery = { heightAt, normalAt, surfaceAt, pavedAt, halfExtent: HALF };

  let disposed = false;
  return {
    ground,
    spawn: { x: 0, y: 0, z: 0, yaw: 0 },
    meshes,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const a of aggregates) a.dispose();
      for (const b of bodies) {
        b.shape?.dispose();
        b.dispose();
      }
      for (const m of meshes) m.dispose();
      for (const n of nodes) n.dispose();
      floorMat.dispose();
    },
  };
};
