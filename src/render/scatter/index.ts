/**
 * World props: near / far thin-instance tiers, the mesh
 * simplifier, static compound colliders. Contract: src/game/contracts/props.ts.
 */
export { COLLIDER_VARIANTS, FAR_BUILDING_FACTOR, createWorldProps, farBuildingTarget, inspectWorldProps } from './worldProps';
export type { MergedItem, WorldPropsLabOptions, WorldPropsInternals } from './worldProps';
export { farModel } from './farModel';
export type { FarModel } from './farModel';
export { simplifyMesh, simplifyWithInfo, describeParts, measureFar, MIN_SILHOUETTE, BOUNDS_TOLERANCE } from './simplify';
export type { SimplifyMethod, SimplifyResult } from './simplify';
export { createFarMaterial, ringInside } from './farMaterial';
export type { FarMaterial } from './farMaterial';
export { buildColliders } from './colliders';
export type { BuiltColliders, ColliderDebugShape, ColliderGroup, ColliderItem } from './colliders';
