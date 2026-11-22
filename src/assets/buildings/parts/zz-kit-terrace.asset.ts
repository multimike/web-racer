import type { PropAsset } from '../../types';
import { galleryBuilding } from './gallery';

/**
 * DEV-ONLY lab asset: reference assembly 1 of the building parts kit
 * (see gallery.ts) — rounded flat-roof terrace with pergola and stair. It exists so the asset lab can show and audit the
 * parts no finished building uses yet. Not in the world catalog, never
 * placed by the game; delete it when the real buildings cover its parts.
 */
const asset: PropAsset = {
  kind: 'prop',
  id: 'zz-kit-terrace',
  name: 'Kit gallery 1 — rounded flat-roof terrace with pergola and stair',
  category: 'building',
  size: { x: 5.36, y: 4.8, z: 6.8 },
  variants: 1,
  triBudget: 6000,
  reference: { sheet: 'design-documents/building-design-pack/houses/design-sheet.png' },
  build: () => galleryBuilding(1),
};

export default asset;
