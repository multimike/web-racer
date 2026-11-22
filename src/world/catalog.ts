/**
 * Static table of every asset the planner places. The planner must not
 * import the asset builders (they pull in the geometry kit and Babylon), so
 * what it needs to know about each one — footprint, how much room it blocks,
 * how many variants and which schemes exist — is repeated here from the
 * design packs (design-documents/…/asset-manifest.json) and the asset
 * files. world-lab.html cross-checks this table against the live asset
 * registry and lists every mismatch.
 */

export type CatalogCategory = 'building' | 'tree' | 'vegetation' | 'large-rock' | 'small-rock' | 'dressing';

export interface CatalogEntry {
  id: string;
  category: CatalogCategory;
  /** Design bounding box, meters: x = width, y = height, z = depth. */
  size: [number, number, number];
  /** Buildings: main body width × depth. Everything else: width × depth of
   * the ground footprint. */
  footprint: [number, number];
  /** Buildings only: placement envelope width × depth (stairs, stilts,
   * awnings, balcony columns included). */
  envelope?: [number, number];
  /** Radius of the solid part a car can hit, at scale 1 (0 = no collider:
   * drive-through scatter). For a tree this is the trunk, not the canopy. */
  collisionRadius: number;
  /** Radius the planner keeps free of OTHER props around it (canopy / body). */
  spreadRadius: number;
  /** Number of variant seeds the game instantiates. */
  variants: number;
  schemes?: readonly string[];
}

const BUILDING_SCHEMES = ['warm', 'coastal', 'sunny'] as const;

function building(id: string, body: [number, number], height: number, envelope: [number, number]): CatalogEntry {
  return {
    id,
    category: 'building',
    size: [body[0], height, body[1]],
    footprint: body,
    envelope,
    collisionRadius: Math.hypot(body[0], body[1]) / 2,
    spreadRadius: Math.hypot(envelope[0], envelope[1]) / 2,
    variants: 3,
    schemes: BUILDING_SCHEMES,
  };
}

function prop(
  id: string,
  category: CatalogCategory,
  size: [number, number, number],
  collisionRadius: number,
  spreadRadius: number,
  variants: number,
  schemes?: readonly string[],
): CatalogEntry {
  return { id, category, size, footprint: [size[0], size[2]], collisionRadius, spreadRadius, variants, schemes };
}

export const CATALOG: readonly CatalogEntry[] = [
  // Buildings (building-design-pack/asset-manifest.json).
  building('b01-sunshack', [4, 3], 3.3, [4.8, 4.6]),
  building('b02-workshop-shed', [4, 3.5], 3.3, [4.8, 4.2]),
  building('b03-stilt-hut', [4, 4], 4.6, [4.8, 6.8]),
  building('b04-gable-cottage', [6, 5], 4.5, [6.8, 6.3]),
  building('b05-terrace-house', [5, 5], 4.5, [5.8, 6.8]),
  building('b06-corner-house', [5, 4], 6.5, [5.8, 5.8]),
  building('b07-race-garage', [9, 7], 4.8, [10, 8]),
  building('b08-market-hall', [8, 5], 4.2, [8.8, 6.8]),
  building('b09-water-tower', [4, 4], 8, [5, 5]),
  building('b10-village-hall', [8, 6], 7.5, [9, 8]),

  // Trees (environment-design-pack). Collision = trunk; spread = canopy.
  prop('t01-rally-oak', 'tree', [4.8, 5.5, 4.5], 0.45, 2.3, 5),
  prop('t02-switchback-pine', 'tree', [3.3, 7, 3], 0.35, 1.6, 5),
  prop('t03-turbo-palm', 'tree', [4.5, 6, 4.2], 0.3, 2.0, 5),

  // Low plants: no colliders, a car drives through them.
  prop('v01-puff-bush', 'vegetation', [1.8, 1.3, 1.5], 0, 0.85, 5),
  prop('v02-ribbon-grass', 'vegetation', [0.85, 0.65, 0.75], 0, 0.4, 5),
  prop('v03-fan-fern', 'vegetation', [1.25, 0.85, 1.1], 0, 0.55, 5),
  prop('v04-spike-rosette', 'vegetation', [1.15, 0.75, 1.1], 0, 0.55, 5),
  prop('v05-coral-blooms', 'vegetation', [0.8, 0.55, 0.65], 0, 0.38, 5),

  // Large rocks: deliberate landmarks, solid.
  prop('r01-shoulder-boulder', 'large-rock', [3.2, 2.4, 2.6], 1.45, 1.6, 4),
  prop('r02-split-fin', 'large-rock', [2.3, 4.2, 1.5], 1.0, 1.2, 4),
  prop('r03-terrace-stack', 'large-rock', [4.2, 2.1, 3], 1.8, 2.1, 4),

  // Small rocks: non-blocking scatter.
  prop('s01-pebble', 'small-rock', [0.3, 0.16, 0.24], 0, 0.15, 4),
  prop('s02-wedge', 'small-rock', [0.55, 0.32, 0.35], 0, 0.28, 4),
  prop('s03-flat-slab', 'small-rock', [0.9, 0.18, 0.6], 0, 0.45, 4),
  prop('s04-chip-cluster', 'small-rock', [0.75, 0.22, 0.65], 0, 0.38, 4),
  prop('s05-broken-chunk', 'small-rock', [0.65, 0.5, 0.5], 0, 0.33, 4),

  // Dressing, as built (src/assets/props/d*.asset.ts).
  prop('d01-start-gantry', 'dressing', [14.5, 7.15, 2.0], 0.8, 0.8, 4),
  prop('d02-chevron-sign', 'dressing', [2.2, 1.25, 0.58], 1.1, 1.2, 4, ['left', 'right']),
  prop('d03-flag-pole', 'dressing', [1.5, 4.24, 0.42], 0.2, 0.35, 4),
  prop('d04-tire-stack', 'dressing', [0.82, 1.07, 0.82], 0.41, 0.45, 4),
  prop('d05-bollard', 'dressing', [0.31, 1.0, 0.31], 0.14, 0.25, 4),
  prop('d06-kerb-marker', 'dressing', [1.6, 0.25, 0.46], 0, 0.8, 4, ['coral', 'teal']),
  prop('d07-wood-fence', 'dressing', [2.4, 1.1, 0.25], 1.2, 1.2, 4, ['plain', 'banner']),
  prop('d08-street-lamp', 'dressing', [0.42, 3.47, 0.96], 0.14, 0.3, 4),
  prop('d09-barrel', 'dressing', [0.74, 0.91, 0.72], 0.37, 0.42, 4),
  prop('d10-crate', 'dressing', [0.94, 0.7, 0.64], 0.5, 0.55, 4),
  prop('d11-flower-planter', 'dressing', [0.79, 0.86, 0.77], 0.4, 0.5, 4, ['stone', 'timber']),
  prop('d12-stone-wall', 'dressing', [3.0, 1.16, 0.64], 1.5, 1.5, 4),
  prop('d13-bench', 'dressing', [1.7, 1.0, 0.72], 0.85, 0.9, 4),
  prop('d14-signpost', 'dressing', [1.0, 2.6, 0.25], 0.12, 0.5, 4, ['right', 'left', 'both']),
  // Collider: the cabinet box (1.1 × 0.56).
  prop('d20-tool-chest', 'dressing', [1.22, 1.3, 0.62], 0.6, 0.65, 4),
  // Collider: two stakes (r 0.09) 1.86 m apart; long and thin like a fence.
  prop('d21-checker-banner', 'dressing', [2.05, 1.44, 0.24], 1.0, 1.05, 4),
  // Collider: the whole stand (1.66 × 0.78).
  prop('d30-produce-stand', 'dressing', [1.684, 1.11, 0.804], 0.85, 0.9, 4),
];

/** The checkered banner's stakes: radius of their colliders, m. */
export const BANNER_STAKE_RADIUS = 0.09;
/** Its stake centre lines, ± from the origin along local x
 * (d21-checker-banner.asset.ts: HALF), and a stake's half width as built,
 * slate cap included (a hair over the collider radius). The planner places
 * banners with these and the self-check (10b) measures them with the same
 * numbers: change them here, together with the asset. */
export const BANNER_STAKE_X = 0.93;
export const BANNER_STAKE_HALF = 0.095;

/** Race garage (b07, src/assets/buildings/b07-race-garage.asset.ts): its two
 * bay openings are GARAGE_BAY_WIDTH wide, centred at ±GARAGE_BAY_X along the
 * building's front (local x), so they span 0.5 … 3.7 m either side. */
export const GARAGE_BAY_X = 2.1;
export const GARAGE_BAY_WIDTH = 3.2;

const BY_ID = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.id, e]));

export function catalogEntry(id: string): CatalogEntry {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`world catalog: unknown asset id '${id}'`);
  return e;
}

export const BUILDING_IDS: readonly string[] = CATALOG.filter((e) => e.category === 'building').map((e) => e.id);

/** Start gantry (d01): half distance between the inner faces of its plinths.
 * The road + kerb must fit inside, so the village kerb width is capped by it. */
export const GANTRY_HALF_OPENING = 5.65;
/** Its two plinths: centre offset from the gantry origin along local ±x, and
 * the radius that covers one (they are 1.6 m square). */
export const GANTRY_PYLON_OFFSET = GANTRY_HALF_OPENING + 0.8;
export const GANTRY_PYLON_RADIUS = 0.8;

/** Segment pitches of the tiling dressing assets, meters. */
export const FENCE_PITCH = 2.4;
export const WALL_PITCH = 3.0;
export const KERB_MARKER_PITCH = 1.6;

/** Which budget class a nature asset counts toward. */
export type NatureClass = 'trees' | 'bushes' | 'lowPlants' | 'largeRocks' | 'smallRocks';

export function natureClass(id: string): NatureClass | null {
  const e = BY_ID.get(id);
  if (!e) return null;
  switch (e.category) {
    case 'tree':
      return 'trees';
    case 'large-rock':
      return 'largeRocks';
    case 'small-rock':
      return 'smallRocks';
    case 'vegetation':
      return id === 'v01-puff-bush' ? 'bushes' : 'lowPlants';
    default:
      return null;
  }
}
