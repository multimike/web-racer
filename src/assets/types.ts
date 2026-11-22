import type { SolidMesh } from '../gfx/solid/SolidMesh';

/**
 * Asset contract: every car, prop and building in the game is a pure
 * geometry BUILDER (no Babylon scene, no textures, no imported files) that
 * returns `SolidMesh` buffers. The game instantiates them, the asset lab
 * (asset-lab.html) reviews exactly the same builders against the design
 * sheets, and a seed turns one design into any number of variants.
 *
 * AXES (all assets): +x right, +y up, +z forward/front. Meters at real scale.
 * The design documents use +Y forward / +Z up — convert as
 * game (x, y, z) = doc (X, Z, Y).
 *
 * Registration: put the asset in `src/assets/{cars,props,buildings}/` in a
 * file named `<something>.asset.ts` whose default export is the asset. The
 * registry (`src/assets/registry.ts`) discovers them with import.meta.glob —
 * there is no central list to edit.
 */

export type AssetCategory =
  | 'car'
  | 'tree'
  | 'vegetation'
  | 'large-rock'
  | 'small-rock'
  | 'building'
  | 'dressing';

export interface AssetReference {
  /** Repo-relative path of the design sheet / turnaround image. */
  sheet: string;
  /** Repo-relative path of the written brief or spec, if any. */
  brief?: string;
}

/**
 * Simple static collision primitive in asset-local space (same axes).
 * `rotY` turns a box about its own vertical axis, in DEGREES like every
 * authored angle in the kit; positive turns +z toward +x (seen from above
 * with +z up the page: clockwise).
 */
export type ColliderSpec =
  | { shape: 'box'; center: [number, number, number]; half: [number, number, number]; rotY?: number }
  | { shape: 'cylinder'; base: [number, number, number]; height: number; radius: number }
  | { shape: 'sphere'; center: [number, number, number]; radius: number };

// ---------------------------------------------------------------------------
// Props, buildings, track dressing

export interface PropAsset {
  kind: 'prop';
  /** Stable id, e.g. 't01-rally-oak', 'b04-gable-cottage'. */
  id: string;
  name: string;
  category: Exclude<AssetCategory, 'car'>;
  /** Design bounding box in meters: x = width, y = height, z = depth. The
   * built seed-0 mesh must land within ~8 % of this. */
  size: { x: number; y: number; z: number };
  /**
   * How many distinct seeds the game should instantiate (3–6 for scatter
   * props). Seed 0 is the HERO: it reproduces the design sheet as closely as
   * possible. Seeds ≥ 1 vary silhouette / proportions / colour within the
   * design's character, deterministically.
   */
  variants: number;
  /**
   * Named colour schemes (buildings: 'warm' | 'coastal' | 'sunny', see the
   * building style guide). Omit when colour variation is seed-driven only.
   */
  schemes?: string[];
  /**
   * Build one variant. Origin = ground contact center, model stands on y = 0
   * (a small skirt below 0 is fine for sloped ground). Front faces −z for
   * buildings (door side toward the street at −z), irrelevant for scatter.
   * Must be deterministic for a given (seed, scheme) and Babylon-scene-free.
   */
  build(seed: number, scheme?: string): SolidMesh;
  /**
   * Optional DESIGNED far-tier model of the same variant (the diorama view
   * draws only the far tier): the same layout, palette tones, lean, turn and
   * fit as `build(seed, scheme)`, built from a handful of closed, flat-shaded
   * shapes within `targetTriangles` (the preset's far budget; the world props
   * accept up to 1.15 ×). No AO bake (the world props bake it), deterministic,
   * scene-free like `build`. Assets without it get the generic simplifier.
   */
  buildFar?(seed: number, scheme: string | undefined, targetTriangles: number): SolidMesh;
  /** Gameplay collision for this variant; omit for visual-only scatter. */
  colliders?(seed: number): ColliderSpec[];
  /** True if vertices carry wind weights (foliage sway in the shader). */
  wind?: boolean;
  /** Triangle budget for one variant; the lab flags builds over it. */
  triBudget: number;
  reference: AssetReference;
}

// ---------------------------------------------------------------------------
// Cars

/** Static dimensions of a car design, meters, straight from model-spec.json. */
export interface CarSpec {
  length: number;
  /** Overall width over the tires. */
  width: number;
  height: number;
  wheelbase: number;
  /** Wheel center to wheel center across the axle. */
  frontTrack: number;
  rearTrack: number;
  frontTireRadius: number;
  rearTireRadius: number;
  frontTireWidth: number;
  rearTireWidth: number;
  /** Floor pan height above the ground at static ride height. */
  groundClearance: number;
}

/** Wheel order used everywhere: 0 FL, 1 FR, 2 RL, 3 RR (left = −x). */
export type WheelIndex = 0 | 1 | 2 | 3;

/**
 * A rigid part spanning the sprung body and one unsprung hub — wishbone arm,
 * tie rod, damper half, coil spring. The vehicle re-poses it every frame, so
 * suspension travel and steering are visible on the model.
 *
 * The mesh is authored hanging from its origin down −Y:
 *  - 'stretch': UNIT length (y from 0 to −1); the vehicle scales Y to the
 *    current span between the two anchors (springs, simple rods).
 *  - 'fromBody': real length, origin at the BODY anchor, aimed at the hub
 *    anchor, not scaled (damper body, upper half of a telescoping strut).
 *  - 'fromHub': real length, origin at the HUB anchor, aimed at the body
 *    anchor, not scaled (damper rod / lower half).
 *
 * ROLL about the link's own axis (which way a wishbone's flat side faces) is
 * fixed by the assembler at the static pose: the mesh's local +Z points as
 * far FORWARD (model +z) as the link's direction allows — for a link that
 * itself runs within ~37° of fore-aft, local +X points to the car's RIGHT
 * instead. So author a wishbone lying in its local YZ plane (spread along
 * local Z) and it comes out flat; from there the link turns by the smallest
 * rotation that keeps it aimed, and never flips.
 *
 * TELESCOPING DAMPER = a 'fromBody' tube and a 'fromHub' rod on the SAME two
 * anchors. For the pair to stay joined over the whole suspension travel:
 * tube length + rod length ≥ the LONGEST span between the anchors (full
 * droop), and each of them ≤ the SHORTEST span (full bump) or it pokes out
 * past the other's anchor. The lab's "dampers this pose" row checks this at
 * the pose on show — try bump=0.08 and bump=-0.1.
 */
export interface CarLink {
  mesh: SolidMesh;
  wheel: WheelIndex;
  /** Anchor on the sprung body, car model space. */
  bodyAnchor: [number, number, number];
  /**
   * Anchor on the unsprung hub, in the NON-SPINNING hub frame: origin at the
   * wheel center, x = axle direction toward the car's right (+x for all four
   * wheels), y = up, z = forward. The frame steers with the wheel.
   */
  hubAnchor: [number, number, number];
  mode: 'stretch' | 'fromBody' | 'fromHub';
}

/** A part that spins on its own while the car runs (fan rotor, turbine). */
export interface CarSpinner {
  /**
   * Authored around its own origin and ALREADY ORIENTED in model axes: the
   * assembler only moves it to `pivot` and spins it about `axis`, it does
   * not turn the mesh to face the axis. A fan that blows backward is built
   * with its disc in the XY plane (axis along z), not lying flat.
   */
  mesh: SolidMesh;
  /** Pivot in car model space. */
  pivot: [number, number, number];
  /** Unit spin axis in car model space. */
  axis: [number, number, number];
  /** rad/s at idle and at full throttle. */
  idleSpeed: number;
  fullSpeed: number;
}

export interface CarGeometry {
  /**
   * Everything rigidly attached to the sprung chassis: shell, cage, cockpit,
   * driver, lights, static propulsion housings. MODEL SPACE: origin on the
   * GROUND under the wheelbase center at static ride height, +z = nose.
   */
  body: SolidMesh;
  /**
   * Optional driver figure, rigid on the sprung body and in the SAME model
   * space as `body` (so a seated driver is authored exactly where it sits in
   * the car). A separate mesh only so it can be hidden or swapped per
   * player; it counts toward the triangle budget and must stay inside the
   * spec height like everything else. Hands that hold the (separately
   * turning) steering wheel belong here, not on the wheel.
   */
  driver?: SolidMesh;
  /**
   * One front and one rear wheel (tire + rim), authored around the wheel
   * center with the axle along X and the detailed OUTBOARD face on +X. The
   * vehicle mirrors them for the left side and spins them about X.
   */
  wheelFront: SolidMesh;
  wheelRear: SolidMesh;
  /**
   * Optional non-spinning hub assembly per axle (upright, brake disc and
   * caliper), authored in the hub frame for a RIGHT-side wheel with inboard
   * toward −x. Mirrored for the left side. Steers with the wheel.
   */
  hubFront?: SolidMesh;
  hubRear?: SolidMesh;
  /** Suspension / steering members for all four corners. */
  links: CarLink[];
  spinners: CarSpinner[];
  /** Steering wheel authored around its own origin, rim in the local XY
   * plane (local +Z = the column, local +Y = the top of the wheel), plus
   * where it sits and the column direction it turns about. The assembler
   * lays local +Z onto `axis` and keeps +Y uppermost; steering right always
   * carries the top of the wheel toward the car's right, whichever way the
   * axis vector points. */
  steeringWheel?: {
    mesh: SolidMesh;
    pivot: [number, number, number];
    axis: [number, number, number];
  };
}

export interface CarAsset {
  kind: 'car';
  /** 'reef-rocket' | 'neon-wasp' | 'riot-ram' | 'comet-fox' | ... */
  id: string;
  name: string;
  category: 'car';
  spec: CarSpec;
  /** Number of liveries; 0 is the design sheet's own colours. */
  liveries: number;
  /** Build the full car. `livery` recolours paint/accents, never the shape. */
  build(livery?: number): CarGeometry;
  triBudget: number;
  reference: AssetReference;
}

export type Asset = PropAsset | CarAsset;
