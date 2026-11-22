/**
 * The ground the game shows and drives on (contract src/game/contracts/terrain.ts):
 *   createTerrainSurface(scene, data, options)  terrain chunks + paving + Havok heightfield
 *   createTerrainCollider(scene, data)          the heightfield body alone (works under NullEngine)
 *   createFlatArena(scene)                      the bare `?terrain=flat` arena
 * Review page: /terrain-lab.html (src/lab/terrainLab.ts).
 */
export { createTerrainCollider, createTerrainSurface, TERRAIN_GROUND_MATERIALS } from './terrainSurface';
export { createFlatArena } from './flatArena';
export { buildPaving, kerbAt, KERB_LIP, MARKING_LIFT, PAD_LIFT, RIBBON_LIFT } from './paving';
export type { Paving } from './paving';
export { createTerrainLookMaterial } from './TerrainLookMaterial';
export { createPadMaterial, createRibbonMaterial } from './PavingMaterial';
