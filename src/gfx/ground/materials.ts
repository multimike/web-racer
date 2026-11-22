import type { GroundGenOptions, GroundTile } from './core';
import { generateWornAsphalt } from './generateAsphalt';
import { generateVillageCobblestone } from './generateCobblestone';
import { generateRallyDirt } from './generateDirt';
import { generateLavenderGravel } from './generateGravel';
import { generateMeadowGrass } from './generateGrass';
import { generateKerbStone } from './generateKerb';
import { generateStonePavers } from './generatePavers';
import { generateSunlitSand } from './generateSand';

/**
 * The ground material catalogue: the six materials of the downloaded
 * ground-material-pack (same ids) plus the two the vision images need.
 */

export const GROUND_MATERIAL_IDS = [
  'rally-dirt',
  'sunlit-sand',
  'meadow-grass',
  'lavender-gravel',
  'worn-asphalt',
  'village-cobblestone',
  'kerb-stone',
  'stone-pavers',
] as const;

export type GroundMaterialId = (typeof GROUND_MATERIAL_IDS)[number];

/** The ids that have a counterpart in design-documents/ground-material-pack
 * (reference material, not in git; only ground-lab reads it). */
export const PACK_MATERIAL_IDS: readonly GroundMaterialId[] = GROUND_MATERIAL_IDS.slice(0, 6);

export interface GroundMaterialDef {
  id: GroundMaterialId;
  name: string;
  generate: (options?: GroundGenOptions) => GroundTile;
  /**
   * How the shader should sample it:
   *  'blend'   `groundSample`: two taps of the tile at shifting offsets,
   *            cross-faded. Grainy materials with no shapes to protect —
   *            the fade is invisible and kills every repeat;
   *  'stones'  `groundStones`: stone layouts. The shapes stay put (a fade
   *            would ghost one stone over another); the id map re-tones
   *            every stone of every repeat;
   *  'single'  `groundTap`: one tap (the kerb strip).
   */
  sampling: 'blend' | 'stones' | 'single';
  /** Sampling argument: `crisp` of groundSample (0 plain cross-fade, 0.5
   * pebbles win over matrix). For 'stones' the tone spread, but the tile's
   * own `stoneSpread` takes precedence (it depends on the palette); unused
   * for 'single'. */
  arg: number;
  /** Multiplier on the physical relief for the lighting normal. The relief
   * of a ground texture seen from 5-50 m is far below what reads on screen;
   * the look is stylized, so each material states how much it exaggerates. */
  bump: number;
}

export const GROUND_MATERIALS: Record<GroundMaterialId, GroundMaterialDef> = {
  'rally-dirt': { id: 'rally-dirt', name: 'Rally Dirt', generate: generateRallyDirt, sampling: 'blend', arg: 0, bump: 1.6 },
  'sunlit-sand': { id: 'sunlit-sand', name: 'Sunlit Sand', generate: generateSunlitSand, sampling: 'blend', arg: 0, bump: 1.6 },
  'meadow-grass': { id: 'meadow-grass', name: 'Meadow Grass', generate: generateMeadowGrass, sampling: 'blend', arg: 0, bump: 1.0 },
  'lavender-gravel': { id: 'lavender-gravel', name: 'Lavender Gravel', generate: generateLavenderGravel, sampling: 'blend', arg: 0.5, bump: 1.2 },
  'worn-asphalt': { id: 'worn-asphalt', name: 'Worn Asphalt', generate: generateWornAsphalt, sampling: 'blend', arg: 0, bump: 2 },
  'village-cobblestone': { id: 'village-cobblestone', name: 'Village Cobblestone', generate: generateVillageCobblestone, sampling: 'stones', arg: 1, bump: 1.2 },
  'kerb-stone': { id: 'kerb-stone', name: 'Kerb Stone', generate: generateKerbStone, sampling: 'single', arg: 0, bump: 1.2 },
  'stone-pavers': { id: 'stone-pavers', name: 'Stone Pavers', generate: generateStonePavers, sampling: 'stones', arg: 0.6, bump: 1.2 },
};

/** Generate one material's tile (Babylon-free; safe in a worker). */
export function generateGroundTile(id: GroundMaterialId, options?: GroundGenOptions): GroundTile {
  return GROUND_MATERIALS[id].generate(options);
}
