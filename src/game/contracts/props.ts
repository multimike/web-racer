import type { Mesh, PhysicsBody, Scene } from '@babylonjs/core';
import type { SolidVertexData } from '../../gfx/solid/SolidMesh';
import type { PropClass } from './quality';
import type { WorldData } from './world';

/**
 * CONTRACT — everything the world plan places: buildings, track dressing,
 * trees, rocks, plants (implemented in src/render/scatter/,
 * consumed by the game and the labs).
 *
 * TWO TIERS, both thin instances:
 *   NEAR  full asset meshes, one thin-instance mesh per (asset, variant,
 *         scheme); holds only the placements within `nearRadius` of the view
 *         focus, rewritten when the focus has moved `refreshStep` meters.
 *   FAR   the asset's designed far model (`PropAsset.buildFar`), else its
 *         near mesh simplified (`simplifyMesh`) — of the SAME variant the
 *         near tier draws; one thin-instance mesh per (asset, variant,
 *         scheme) holding ALL its placements, static; its vertex shader
 *         drops the instances inside the ring, so the two tiers are an exact
 *         partition and nothing is drawn twice. The buildings (all
 *         different) share ONE merged far mesh, and the far dressing (fence
 *         segments, banners, tyre stacks … of every variant) another, each
 *         with a per-vertex origin for the same ring test. The start gantry
 *         and every dressing asset with a single placement have no far twin
 *         (always near).
 * Colliders: static compound bodies built from `PropAsset.colliders(seed)`.
 *
 * Types only.
 */

/** Simplify one mesh to about `targetTriangles` (never more than 1.15 × it,
 * never fewer than 4), keeping the vertex layout, colours and overall shape.
 * Pure, deterministic. `simplifyMesh` in src/render/scatter/simplify.ts. */
export type SimplifyMesh = (data: SolidVertexData, targetTriangles: number) => SolidVertexData;

export interface WorldPropsOptions {
  /** Radius of the near tier around the focus, m. Default 46. */
  nearRadius?: number;
  /** Near radius for buildings, m. Default 90. */
  buildingRadius?: number;
  /** The focus must move this far before the near tier is rewritten, m. Default 6. */
  refreshStep?: number;
  /** Near-tier variants per asset id, by class. Defaults: tree 4, bush 3,
   * lowPlant 2, largeRock 3, smallRock 2, dressing 4, building 3.
   * Measured on real plans (seeds 1, 7, 23 of the prototype tracks): with
   * these defaults 99-103 near meshes exist (21 buildings, 40 dressing, 42
   * nature) and 76-79 of them hold instances at a typical focus (max 95). */
  variantLimit?: Partial<Record<PropClass, number>>;
  /** Far-tier triangle targets, by class: the budget a designed far model
   * is built to (`buildFar`'s `targetTriangles`) or a simplified one is
   * reduced to.
   * Defaults: tree 72, bush 24, lowPlant 12, largeRock 36, smallRock 8,
   * dressing 40, building 900 (a few buildings get a factor on top:
   * FAR_BUILDING_FACTOR in src/render/scatter/worldProps.ts). */
  farTriangles?: Partial<Record<PropClass, number>>;
  /** Share of collider-less scatter that is drawn, 0..1. Default 1. */
  scatterDensity?: number;
  /** Classes whose near tier casts sun shadows. Default: tree, largeRock,
   * dressing, building. */
  shadowCasters?: readonly PropClass[];
  /** Build the static collider bodies. Default true. */
  colliders?: boolean;
  /** Called while assets are prepared (0..1), so a loading screen can move. */
  onProgress?: (fraction: number, label: string) => void;
}

/** What `WorldProps.update` needs to know about the view. */
export interface PropsView {
  /** Centre of the near ring on the ground plane. Any point may be given:
   * the player's car, a point ahead of it along the view direction (puts
   * the full meshes where the camera looks), or in xr the orbit target. */
  x: number;
  z: number;
  /** Near radius for this frame, m (0 = everything from the far tier). */
  nearRadius: number;
  buildingRadius: number;
  /** Draw the far tier of the small classes (lowPlant, smallRock) too. They
   * are invisible from a car's eye height beyond the near radius; the
   * diorama view wants them. */
  farDetail: boolean;
  /** Which tier casts sun shadows — EXCLUSIVE, never both (the shadow pass
   * does not know the ring, so a caster in both tiers would be drawn twice):
   * true  = the far tier of tree, largeRock and the merged buildings mesh
   *         casts and the near tier does not (diorama view: the shadow map
   *         covers the whole world, also while the camera is zoomed in);
   * false = only the near tier casts (car views). */
  farShadows: boolean;
}

export interface WorldPropsStats {
  /** Placements in the plan / actually drawn after `scatterDensity`. */
  placements: number;
  drawn: number;
  /** Thin-instance meshes that exist (near, far) — the upper bound of draw
   * calls; and how many were enabled with instances after the last update
   * (= draw calls of the main pass for that tier). */
  nearBatches: number;
  farBatches: number;
  nearActive: number;
  farActive: number;
  /** Instances and triangles the last update put in each tier. */
  nearInstances: number;
  nearTriangles: number;
  farInstances: number;
  farTriangles: number;
  /** Meshes currently registered as sun-shadow casters, and their triangles. */
  casterMeshes: number;
  casterTriangles: number;
  /** Collider child shapes and static bodies. */
  colliderShapes: number;
  colliderBodies: number;
  /** Per asset id: [full triangles, far-tier triangles, placements]. */
  perAsset: Record<string, [number, number, number]>;
  /** Milliseconds: asset preparation (build + AO), simplification, GPU
   * meshes + buffers, colliders. */
  prepareMs: number;
  simplifyMs: number;
  meshMs: number;
  colliderMs: number;
  /** Near-tier rewrites so far and the cost of the last one, ms. */
  refreshes: number;
  lastRefreshMs: number;
}

export interface WorldProps {
  /** Call once per frame before rendering. Cheap when the focus has not
   * moved `refreshStep` and the radii are unchanged. */
  update(view: PropsView): void;
  readonly stats: WorldPropsStats;
  readonly nearMeshes: readonly Mesh[];
  readonly farMeshes: readonly Mesh[];
  readonly colliderBodies: readonly PhysicsBody[];
  dispose(): void;
}

/** `createWorldProps` (src/render/scatter/worldProps.ts). Async: assets are
 * loaded through the registry and prepared in slices. */
export type CreateWorldProps = (scene: Scene, data: WorldData, options?: WorldPropsOptions) => Promise<WorldProps>;
