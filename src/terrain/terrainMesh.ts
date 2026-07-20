import {
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeHeightField,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import { generateTerrain, TERRAIN_SIZE } from './generateTerrain';
import type { TerrainData } from './generateTerrain';
import { createTerrainMaterial } from './TerrainMaterial';

export interface Terrain extends TerrainData {
  mesh: Mesh;
}

/** Build the terrain: one frozen mesh (single draw call, no textures) plus a
 * native Havok HEIGHTFIELD body sharing the same transform, so render and
 * physics can't drift apart. */
export function createTerrain(scene: Scene, seed: number): Terrain {
  const data = generateTerrain(seed);
  const hf = data.heightfield;
  const n = hf.n;
  let t0 = performance.now();

  // Geometry centered on the origin: the Havok heightfield shape is CENTERED
  // on the body transform (verified numerically below — corner-anchored
  // geometry produced 4 m mean error and rays missing 3/4 of the field), so
  // centered vertices + mesh at origin keeps render and physics aligned.
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 4);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const v = iz * n + ix;
      positions[v * 3] = -TERRAIN_SIZE / 2 + ix * hf.step;
      positions[v * 3 + 1] = hf.at(ix, iz);
      positions[v * 3 + 2] = -TERRAIN_SIZE / 2 + iz * hf.step;
      // Central differences (clamped at edges) — smoother than per-face
      // accumulation and O(n²) instead of O(triangles).
      const x0 = Math.max(ix - 1, 0);
      const x1 = Math.min(ix + 1, n - 1);
      const z0 = Math.max(iz - 1, 0);
      const z1 = Math.min(iz + 1, n - 1);
      const dhdx = (hf.at(x1, iz) - hf.at(x0, iz)) / ((x1 - x0) * hf.step);
      const dhdz = (hf.at(ix, z1) - hf.at(ix, z0)) / ((z1 - z0) * hf.step);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      normals[v * 3] = -dhdx * inv;
      normals[v * 3 + 1] = inv;
      normals[v * 3 + 2] = -dhdz * inv;
    }
  }
  colors.set(data.splat);

  // 32-bit indices (n² = 65536 vertices exceeds 16-bit range).
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const v00 = iz * n + ix;
      const v10 = v00 + 1;
      const v01 = v00 + n;
      const v11 = v01 + 1;
      indices[k++] = v00;
      indices[k++] = v10;
      indices[k++] = v11;
      indices[k++] = v00;
      indices[k++] = v11;
      indices[k++] = v01;
    }
  }

  const mesh = new Mesh('terrain', scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.colors = colors;
  vertexData.indices = indices;
  vertexData.applyToMesh(mesh, false);
  mesh.setVerticesBuffer(new VertexBuffer(scene.getEngine(), data.ao, 'ao', false, false, 1));
  mesh.material = createTerrainMaterial(scene);
  mesh.position.set(0, 0, 0);
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true; // always on screen — skip frustum test
  data.timings.mesh = performance.now() - t0;

  t0 = performance.now();
  const shape = new PhysicsShapeHeightField(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    n,
    n,
    hf.toBabylonHeightFieldData(),
    scene,
  );
  shape.material = { friction: 1.0, restitution: 0 };
  const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
  body.shape = shape;
  data.timings.physics = performance.now() - t0;
  mesh.freezeWorldMatrix();

  if (import.meta.env.DEV) {
    verifyPhysicsAlignment(scene, data);
    const timings = Object.entries(data.timings)
      .map(([name, ms]) => `${name} ${ms.toFixed(1)}`)
      .join(', ');
    console.log(`[terrain] generation timings (ms): ${timings}`);
  }

  return { ...data, mesh };
}

/** Numeric ground truth for the heightfield layout/orientation guesswork:
 * physics-raycast straight down at random points and compare against the
 * analytic heightfield. An axis flip or corner-offset mistake shows up as
 * meter-scale error; agreement should be within one triangle's sag. */
function verifyPhysicsAlignment(scene: Scene, data: TerrainData): void {
  const engine = scene.getPhysicsEngine();
  if (!engine || !('raycast' in engine)) return;
  const hf = data.heightfield;
  const half = hf.size / 2 - 2;
  let maxErr = 0;
  let sumErr = 0;
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const wx = (Math.random() * 2 - 1) * half;
    const wz = (Math.random() * 2 - 1) * half;
    // Skip near spawn so we don't hit the car instead of the ground.
    if (Math.abs(wx) < 6 && Math.abs(wz) < 6) continue;
    const result = engine.raycast(new Vector3(wx, 60, wz), new Vector3(wx, -60, wz));
    if (!result.hasHit) continue;
    const err = Math.abs(result.hitPointWorld.y - hf.getHeight(wx, wz));
    maxErr = Math.max(maxErr, err);
    sumErr += err;
    hits++;
  }
  const mean = hits ? sumErr / hits : NaN;
  const verdict = hits > 150 && maxErr < 0.25 ? 'OK' : 'MISALIGNED?';
  console.log(
    `[terrain] physics vs heightmap: ${verdict} (${hits} hits, mean err ${mean.toFixed(3)} m, max ${maxErr.toFixed(3)} m)`,
  );
}
