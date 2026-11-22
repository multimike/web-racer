/**
 * Contracts — the TYPE-ONLY seams between the game's modules. Nothing in this folder contains logic or values;
 * importing from it can never create an import cycle (use `import type`).
 *
 *   world.ts    WorldData (the generated world as data), GroundQuery
 *   terrain.ts  TerrainSurface, terrain collider, FlatArena, SpawnPose
 *   props.ts    WorldProps (near / far thin-instance tiers, colliders), SimplifyMesh
 *   car.ts      GameCar (vehicle + visual + LOD), DustGround
 *   camera.ts   CameraRig, ViewMode, GameActions
 *   quality.ts  QualitySettings (every performance knob, one object)
 *   report.ts   LabReport / FrameStats and the headless report protocol
 */
export type * from './world';
export type * from './terrain';
export type * from './props';
export type * from './car';
export type * from './camera';
export type * from './quality';
export type * from './report';
