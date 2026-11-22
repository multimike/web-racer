import type { PropAsset } from '../../types';
import { galleryBuilding } from './gallery';

/**
 * DEV-ONLY lab asset: reference assembly 0 of the building parts kit
 * (see gallery.ts) — two-storey hip-roof house with balcony. It exists so the asset lab can show and audit the
 * parts no finished building uses yet. Not in the world catalog, never
 * placed by the game; delete it when the real buildings cover its parts.
 */
const asset: PropAsset = {
  kind: 'prop',
  id: 'zz-kit-two-storey',
  name: 'Kit gallery 0 — two-storey hip-roof house with balcony',
  category: 'building',
  size: { x: 5.82, y: 6.91, z: 5.32 },
  variants: 1,
  triBudget: 6000,
  reference: { sheet: 'design-documents/building-design-pack/houses/design-sheet.png' },
  build: () => galleryBuilding(0),
};

export default asset;
