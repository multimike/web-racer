import type { Track } from '../terrain/track';

/**
 * WORLD PLAN — everything the game needs to dress the 200 × 200 m world,
 * decided up front by `planWorld()` (src/world/planWorld.ts): where the road
 * is cobbled, where the village and each building stand, which terrain must
 * be flattened for them, paved pads, track dressing and every tree, rock and
 * flower. Plain JSON (no typed arrays, no class instances), deterministic for
 * a given (track, heightfield, seed, roadHalfWidth), Babylon-free.
 *
 * COORDINATES: world meters, x right, y up, z forward (the game's axes).
 * `Vec2` is [x, z]. ARC LENGTH `s` runs along the track centreline from the
 * start line (s = 0 at track point 0 = world origin) in the direction of
 * travel (+z at the origin), 0 ≤ s < road.length; ranges that cross the start
 * line are stored with s0 > s1. SIDES are relative to the direction of
 * travel: +1 = left, −1 = right.
 *
 * YAW is Babylon's `rotation.y` in radians: positive turns local +z toward
 * world +x. Assets face their FRONT to local −z (door of a building, the
 * road face of a fence, the printed face of a chevron board), so a
 * placement's front looks along world (−sin yaw, −cos yaw).
 */

export type Vec2 = [number, number];

/** Anything that can report terrain height; `Heightfield` qualifies. */
export interface HeightSampler {
  /** Edge length of the square world, centred on the origin. */
  size: number;
  getHeight(wx: number, wz: number): number;
}

export interface WorldPlanInput {
  track: Track;
  /** Terrain BEFORE the plan's terrain modifiers (road already carved). A
   * `Heightfield` is copied sample for sample; any other sampler is resampled
   * at 256 × 256. */
  heightfield: HeightSampler;
  seed: number;
  /** Drivable half width in meters. Defaults to `track.halfWidth`.
   * The heightfield must be CARVED to this width: the planner treats
   * everything within it as road surface and protects it from the terrain
   * modifiers. On a narrower carve the plan stands on the carve's bank (and
   * says so in `WorldPlan.warnings`). */
  roadHalfWidth?: number;
  /** Optional terrain splat lookup (out = [grass, rock, road, meadow]). When
   * absent the planner derives rock from slope and meadow from the same
   * macro noise the terrain generator uses. */
  splat?: (wx: number, wz: number, out: Float32Array) => void;
  /** Instance budgets; defaults are `DEFAULT_BUDGETS` in planWorld.ts. */
  budgets?: Partial<NatureBudgets>;
}

/** [min, max] instance counts per nature class. */
export interface NatureBudgets {
  trees: [number, number];
  bushes: [number, number];
  lowPlants: [number, number];
  largeRocks: [number, number];
  smallRocks: [number, number];
}

// ---------------------------------------------------------------------------
// Road

export type RoadSurface = 'dirt' | 'cobble';

export interface RoadSection {
  /** Arc-length range; a section that crosses the start line has s0 > s1. */
  s0: number;
  s1: number;
  surface: RoadSurface;
  /** Length of the cross-fade to the neighbouring sections, centred on each
   * end of this section (0 for the default dirt). */
  blend: number;
}

export type KerbStyle =
  /** Rough-cut stones, slightly irregular: the countryside edging. */
  | 'rough'
  /** Wider, clean cream stones: the village edging. */
  | 'dressed'
  /** Dropped kerb, level with the road: where a paved pad joins the road. */
  | 'flush';

export interface KerbSection {
  s0: number;
  s1: number;
  side: 1 | -1;
  width: number;
  style: KerbStyle;
}

export interface RoadPlan {
  /** Centreline length in meters. */
  length: number;
  halfWidth: number;
  sections: RoadSection[];
  kerbs: KerbSection[];
  /** Painted start / finish line across the road at s = 0. `marker` says
   * what stands over it: the d01 gantry (a 'start-gantry' placement in
   * `dressing`), or only flag poles where the gantry's plinths would not
   * clear the road (road wider than its opening, or another stretch of the
   * loop passing too close to the line). */
  startLine: { s: number; x: number; y: number; z: number; yaw: number; halfWidth: number; depth: number; marker: 'gantry' | 'flags' };
  /** Cobble weight 0..1 per track point (sections with their blends already
   * evaluated) — multiply into the road splat channel as is. */
  cobble: number[];
}

/** A bend of the loop whose curvature exceeds the signing threshold. */
export interface Bend {
  s0: number;
  s1: number;
  apexS: number;
  /** Which way the road turns for a car travelling in +s. */
  direction: 'left' | 'right';
  /** Smallest centreline radius in the bend, meters. */
  minRadius: number;
  /** Total heading change, radians. */
  angle: number;
}

// ---------------------------------------------------------------------------
// Village

export type LotRole = 'garage' | 'market' | 'hall' | 'tower' | 'house' | 'shack';

export interface Lot {
  id: number;
  /** Building asset id, e.g. 'b07-race-garage'. */
  asset: string;
  /** Variant seed (0 … variants − 1) and colour scheme for `asset.build`. */
  seed: number;
  scheme: string;
  role: LotRole;
  zone: 'village' | 'outlying';
  /** Building origin (ground contact centre); y = pad height. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Half extents of the placement envelope (stairs, awnings, columns
   * included): local x runs along the street front, local z is depth. */
  halfX: number;
  halfZ: number;
  /** Half extents of the main body. */
  bodyHalfX: number;
  bodyHalfZ: number;
  /** Nearest road point (the one the front looks at) and where it is. */
  s: number;
  side: 1 | -1;
  roadPoint: Vec2;
  /** Distance from the road centreline to the envelope's front edge. */
  setback: number;
  /** Where the door path crosses the fence line; null when a pad joins the
   * lot to the road instead (garage apron, market square). */
  entrance: Vec2 | null;
  /** Deepest cut and highest fill the pad needs against natural ground, m. */
  cut: number;
  fill: number;
}

export interface VillagePlan {
  /** Cobbled stretch of road, arc length (s0 > s1: it crosses the start line). */
  s0: number;
  s1: number;
  length: number;
  /** Rough centre and radius of the built-up area, for cameras and audio. */
  center: Vec2;
  radius: number;
  /** Lot ids by role. */
  garageLot: number;
  hallLot: number;
  marketLot: number;
  towerLot: number;
  /** Selection score of the chosen stretch (0..1, higher = flatter, straighter, roomier). */
  score: number;
}

// ---------------------------------------------------------------------------
// Terrain

/** Blend widths of a flatten pad, per edge (front = local −z). */
export interface PadFalloff {
  front: number;
  back: number;
  left: number;
  right: number;
}

export type TerrainModifier =
  | {
      /** Level an oriented rectangle to `height`; outside it the terrain
       * eases back to natural ground over the per-edge falloff. */
      kind: 'flatten';
      x: number;
      z: number;
      yaw: number;
      halfX: number;
      halfZ: number;
      height: number;
      falloff: PadFalloff;
      lot: number;
    }
  | {
      /** Level a band beside the road to the road's own elevation (it
       * follows the road's gradient): village verges, aprons, squares.
       * Applies on `side` only (0 = both) out to the lateral distance
       * `outer` from the centreline, easing out over `falloff` beyond it
       * and over `taper` meters at both ends of the range. Where two
       * stretches of road are about equally near (inside of a bend, two
       * legs of the loop side by side) height and membership are blended
       * between them — applyTerrainModifiers is the definition; use it. */
      kind: 'corridor';
      s0: number;
      s1: number;
      side: 1 | -1 | 0;
      outer: number;
      falloff: number;
      taper: number;
      /** Most the ground may be moved, meters (absent = as far as it takes).
       * Where levelling would need more, the ground moves by this much and
       * keeps the rest of its slope: a softened bank instead of a deep cut. */
      limit?: number;
      /** Optional: over the arc range [s0, s1] (fading in and out over
       * `taper` meters) the band reaches `by` meters farther than `outer`.
       * One corridor with a locally wider band, instead of a second
       * corridor on top: two corridors blend the same skirt twice and
       * steepen the bank behind it. */
      widen?: { s0: number; s1: number; by: number; taper: number };
    };

export type PadSurface = 'asphalt' | 'paver' | 'cobble';
export type PadRole = 'apron' | 'square' | 'forecourt' | 'path';

export interface PadMarking {
  a: Vec2;
  b: Vec2;
  width: number;
  color: 'yellow' | 'white';
}

export interface SurfacePad {
  surface: PadSurface;
  role: PadRole;
  /** Simple polygon in world XZ. */
  polygon: Vec2[];
  /** Nominal height (the terrain under it is levelled by a modifier). */
  y: number;
  lot: number;
  /** True when the pad joins the road (kerb is flush along it, no fence). */
  joinsRoad: boolean;
  markings: PadMarking[];
}

// ---------------------------------------------------------------------------
// Placements

export interface Placement {
  /** Asset id from the catalog (src/world/catalog.ts). */
  asset: string;
  /** Variant seed, 0 … variants − 1. */
  seed: number;
  scheme?: string;
  x: number;
  /** Ground height at (x, z) on the terrain AFTER the plan's modifiers. */
  y: number;
  z: number;
  yaw: number;
  /** Uniform scale. */
  scale: number;
  /** Per-instance colour multiplier, around 1. */
  tint: [number, number, number];
  /** Why it is there ('fence', 'chevron', 'shoulder-rock', 'verge-blooms' …). */
  role: string;
  /** Lot it belongs to, when it was composed around a building. */
  lot?: number;
  /** Set on trees and large rocks more than 30 m from every part of the
   * road: no car (and no chase camera) ever gets near them, so the
   * integrator may draw them from a low-detail mesh or an impostor. They
   * are most of the tree budget (the ring that hides the bowl rim). */
  backdrop?: true;
}

export interface PlanStats {
  buildings: number;
  villageBuildings: number;
  outlyingBuildings: number;
  dressing: number;
  trees: number;
  bushes: number;
  lowPlants: number;
  largeRocks: number;
  smallRocks: number;
  /** Trees + large rocks flagged `backdrop` (candidates for a cheap LOD). */
  backdrop: number;
  /** Distinct (asset, seed, scheme) among dressing and nature: the number
   * of thin-instance batches (draw calls) the props need. */
  batches: number;
  /** Instance count per asset id (lots, dressing and nature together). */
  perAsset: Record<string, number>;
}

export interface WorldPlan {
  version: 1;
  seed: number;
  worldSize: number;
  road: RoadPlan;
  bends: Bend[];
  village: VillagePlan;
  lots: Lot[];
  terrainModifiers: TerrainModifier[];
  pads: SurfacePad[];
  dressing: Placement[];
  nature: Placement[];
  /** Direction the wind blows toward, yaw radians (flags are aligned to it). */
  windYaw: number;
  /** Things the integrator must know about this plan (empty when all is
   * well): the terrain not being carved to the planned road width, the
   * start gantry left out. Deterministic like the rest of the plan. */
  warnings: string[];
  stats: PlanStats;
}
