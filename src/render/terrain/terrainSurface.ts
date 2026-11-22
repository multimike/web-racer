import { Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeHeightField, TransformNode, VertexBuffer, VertexData } from '@babylonjs/core';
import type { Scene, ShaderMaterial } from '@babylonjs/core';
import type { CreateTerrainCollider, CreateTerrainSurface, TerrainSurface, TerrainSurfaceOptions, TerrainSurfaceStats } from '../../game/contracts/terrain';
import type { WorldData } from '../../game/contracts/world';
import { createGroundTextures } from '../../gfx/ground';
import type { GroundMaterialId } from '../../gfx/ground';
import { createGroundQuery } from '../../terrain/groundQuery';
import { buildPaving } from './paving';
import { createTerrainLookMaterial } from './TerrainLookMaterial';

/**
 * The ground of a hills world (contract: src/game/contracts/terrain.ts):
 * terrain chunks in the look, the paving, the Havok heightfield. All static.
 */

/** The seven ground materials the terrain and the paving use (sand is not). */
export const TERRAIN_GROUND_MATERIALS: readonly GroundMaterialId[] = [
  'meadow-grass',
  'lavender-gravel',
  'rally-dirt',
  'village-cobblestone',
  'kerb-stone',
  'worn-asphalt',
  'stone-pavers',
];

/** Havok heightfield body on an invisible node at the origin — no mesh, no
 * material, no vertex buffer, so it works under a NullEngine. The legacy
 * recipe exactly: the shape is CENTRED on the body transform, and
 * `toBabylonHeightFieldData` already holds the transpose the plugin needs. */
export const createTerrainCollider: CreateTerrainCollider = (scene: Scene, data: WorldData): PhysicsBody => {
  const hf = data.heightfield;
  const node = new TransformNode('terrainCollider', scene);
  const shape = new PhysicsShapeHeightField(hf.size, hf.size, hf.n, hf.n, hf.toBabylonHeightFieldData(), scene);
  // Static bodies default to low friction: always set it.
  shape.material = { friction: 2.0, restitution: 0 };
  const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
  body.shape = shape;
  node.freezeWorldMatrix();
  return body;
};

/** Chunk borders in cells: `Math.round(i * cells / chunks)`. */
function borders(cells: number, chunks: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= chunks; i++) out.push(Math.round((i * cells) / chunks));
  return out;
}

/** One terrain chunk: vertices exactly on the heightfield samples of cells
 * [x0, x1] × [z0, z1] (border vertices duplicated between chunks), normals
 * by central differences over the WHOLE field (so borders match), splat
 * weights as `color`, the shade triple as the custom `shade` buffer. */
function buildChunk(scene: Scene, data: WorldData, x0: number, x1: number, z0: number, z1: number, material: ShaderMaterial, name: string): Mesh {
  const hf = data.heightfield;
  const n = hf.n;
  const half = hf.size / 2;
  const nx = x1 - x0 + 1;
  const nz = z1 - z0 + 1;
  const count = nx * nz;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  const shade = new Float32Array(count * 3);
  let v = 0;
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      positions[v * 3] = -half + ix * hf.step;
      positions[v * 3 + 1] = hf.at(ix, iz);
      positions[v * 3 + 2] = -half + iz * hf.step;
      const xa = Math.max(ix - 1, 0);
      const xb = Math.min(ix + 1, n - 1);
      const za = Math.max(iz - 1, 0);
      const zb = Math.min(iz + 1, n - 1);
      const dhdx = (hf.at(xb, iz) - hf.at(xa, iz)) / ((xb - xa) * hf.step);
      const dhdz = (hf.at(ix, zb) - hf.at(ix, za)) / ((zb - za) * hf.step);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      normals[v * 3] = -dhdx * inv;
      normals[v * 3 + 1] = inv;
      normals[v * 3 + 2] = -dhdz * inv;
      const src = iz * n + ix;
      for (let c = 0; c < 4; c++) colors[v * 4 + c] = data.splat[src * 4 + c];
      for (let c = 0; c < 3; c++) shade[v * 3 + c] = data.shade[src * 3 + c];
      v++;
    }
  }
  const cells = (nx - 1) * (nz - 1);
  const indices = count > 65535 ? new Uint32Array(cells * 6) : new Uint16Array(cells * 6);
  let k = 0;
  for (let jz = 0; jz < nz - 1; jz++) {
    for (let jx = 0; jx < nx - 1; jx++) {
      // The legacy builder's order: v00, v10, v11 / v00, v11, v01.
      const v00 = jz * nx + jx;
      const v10 = v00 + 1;
      const v01 = v00 + nx;
      const v11 = v01 + 1;
      indices[k++] = v00;
      indices[k++] = v10;
      indices[k++] = v11;
      indices[k++] = v00;
      indices[k++] = v11;
      indices[k++] = v01;
    }
  }
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.colors = colors;
  vd.indices = indices;
  vd.applyToMesh(mesh, false);
  mesh.setVerticesBuffer(new VertexBuffer(scene.getEngine(), shade, 'shade', false, false, 3));
  mesh.material = material;
  // `color` = splat weights: never the transparent pass.
  mesh.hasVertexAlpha = false;
  // Fog is done in the look shader; Babylon would inject its own.
  mesh.applyFog = false;
  mesh.isPickable = false;
  // NOT alwaysSelectAsActiveMesh: the frustum must cull chunks.
  mesh.freezeWorldMatrix();
  return mesh;
}

export const createTerrainSurface: CreateTerrainSurface = (scene: Scene, data: WorldData, options: TerrainSurfaceOptions = {}): TerrainSurface => {
  const hf = data.heightfield;
  // 1 … 16 per side (NaN / Infinity fall back to 4): past 16 a chunk is
  // under 16 cells and the draw calls buy nothing; past 255 chunks are empty.
  const rawChunks = Math.floor(options.chunks ?? 4);
  const chunks = Number.isFinite(rawChunks) ? Math.min(16, Math.max(1, rawChunks)) : 4;

  let t0 = performance.now();
  const groundTextures = createGroundTextures(scene, {
    size: options.groundTextureSize ?? 512,
    anisotropy: options.anisotropy ?? 8,
    materials: TERRAIN_GROUND_MATERIALS,
  });
  const textureMs = performance.now() - t0;

  t0 = performance.now();
  const terrainMat = createTerrainLookMaterial(scene, groundTextures);
  const cells = hf.n - 1;
  const cut = borders(cells, chunks);
  const terrain: Mesh[] = [];
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      terrain.push(buildChunk(scene, data, cut[cx], cut[cx + 1], cut[cz], cut[cz + 1], terrainMat, `terrain.${cx}.${cz}`));
    }
  }
  const meshMs = performance.now() - t0;

  t0 = performance.now();
  const paving = options.paving === false ? null : buildPaving(scene, data, groundTextures);
  const pavingMs = performance.now() - t0;

  t0 = performance.now();
  const body = options.physics === false ? null : createTerrainCollider(scene, data);
  const physicsMs = performance.now() - t0;

  let terrainTriangles = 0;
  for (const m of terrain) terrainTriangles += m.getTotalIndices() / 3;
  const pavingMeshes = paving?.meshes ?? [];
  const stats: TerrainSurfaceStats = {
    terrainTriangles,
    pavingTriangles: paving?.triangles ?? 0,
    meshes: terrain.length + pavingMeshes.length,
    textureMs,
    meshMs,
    pavingMs,
    physicsMs,
  };

  let disposed = false;
  return {
    terrain,
    paving: pavingMeshes,
    body,
    groundTextures,
    ground: createGroundQuery(data),
    stats,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const m of terrain) m.dispose();
      for (const m of pavingMeshes) m.dispose();
      terrainMat.dispose();
      for (const m of paving?.materials ?? []) m.dispose();
      groundTextures.dispose();
      if (body) {
        const node = body.transformNode;
        body.shape?.dispose();
        body.dispose();
        node.dispose();
      }
    },
  };
};
