import type { PropAsset } from '../../types';
import { galleryBuilding } from './gallery';

/**
 * DEV-ONLY lab asset: reference assembly 2 of the building parts kit
 * (see gallery.ts) — boarded shed with shop front and porch. It exists so the asset lab can show and audit the
 * parts no finished building uses yet. Not in the world catalog, never
 * placed by the game; delete it when the real buildings cover its parts.
 */
const asset: PropAsset = {
  kind: 'prop',
  id: 'zz-kit-shed',
  name: 'Kit gallery 2 — boarded shed with shop front and porch',
  category: 'building',
  size: { x: 7.75, y: 3.87, z: 6.68 },
  variants: 1,
  triBudget: 6000,
  reference: { sheet: 'design-documents/building-design-pack/shacks/design-sheet.png' },
  build: () => galleryBuilding(2),
};

export default asset;
