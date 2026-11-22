import { SolidMesh, box, cylinder, extrudePolygon, jitterColor, paint, rng, roundedBox } from '../../gfx/solid';
import type { RGB } from '../../gfx/solid';
import { BUILDING, CAR_COMMON, COMET_FOX } from '../palette';
import type { PropAsset } from '../types';
import { IRON, TRACK } from './dressing-track-parts';

/**
 * The red roller tool chest standing in the garage bays of the vision: a
 * glossy cabinet on four casters, a stack of drawers with bright pull bars
 * on the front (−z), a push handle on one end and a rubber mat on top with a
 * few things left lying on it. Seeds change the paint, the drawer split,
 * which drawer has been left open and what is on top.
 */

const W = 1.1;
const D = 0.56;
const BODY_Y0 = 0.17; // casters below
const BODY_H = 0.86;

function build(seed: number): SolidMesh {
  const r = rng(seed, 'tool-chest');
  const hero = seed === 0;
  const base: RGB = [COMET_FOX.bodyVermilion, BUILDING.cobalt, COMET_FOX.bodyVermilion, BUILDING.mustard][seed % 4];
  const BODY = paint(hero ? base : jitterColor(r, base, { hue: 4, lightness: 0.03 }), { gloss: 0.75 });
  const METAL = paint(CAR_COMMON.metal, { gloss: 0.7, metal: 0.9 });
  const RUBBER = paint(CAR_COMMON.rubber, { gloss: 0.2 });
  const CREAM = paint(BUILDING.cream, { gloss: 0.4 });

  const m = new SolidMesh();
  const top = BODY_Y0 + BODY_H;
  roundedBox(m, { min: [-W / 2, BODY_Y0, -D / 2], max: [W / 2, top, D / 2], radius: 0.05, segments: 1 }, BODY);
  // Rubber work mat let into the top.
  box(m, { min: [-W / 2 + 0.07, top - 0.02, -D / 2 + 0.07], max: [W / 2 - 0.07, top + 0.012, D / 2 - 0.07], faces: { ny: null } }, RUBBER);

  // Drawer fronts: thin chamfered plates standing proud of the body, each
  // with a pull bar. Rows get taller toward the bottom, as on a real chest.
  // (Hidden faces are left out throughout: the budget is 400 triangles.)
  const rows = seed % 2 === 0 ? [0.13, 0.13, 0.19, 0.25] : [0.2, 0.11, 0.11, 0.28];
  const openRow = hero ? -1 : r.int(0, rows.length - 1);
  const gap = 0.028;
  const fw = W - 0.12;
  let y = top - 0.075;
  rows.forEach((h, i) => {
    const pull = i === openRow ? r.range(0.06, 0.1) : 0;
    const z = -D / 2 - pull;
    if (pull > 0) {
      // The drawer box itself, so the open drawer is not a floating plate.
      box(m, { min: [-fw / 2 + 0.03, y - h + 0.015, z], max: [fw / 2 - 0.03, y - 0.03, -D / 2 + 0.03], faces: { pz: null, nz: null } }, IRON);
    }
    extrudePolygon(
      m,
      { outline: [[-fw / 2, -h / 2], [fw / 2, -h / 2], [fw / 2, h / 2], [-fw / 2, h / 2]], depth: 0.04, bevel: 0.014, back: false, facing: '-z', at: [0, y - h / 2, z + 0.018] },
      BODY,
    );
    box(m, { min: [-fw / 2 + 0.1, y - h / 2 - 0.016, z - 0.052], max: [fw / 2 - 0.1, y - h / 2 + 0.016, z - 0.018], faces: { pz: null } }, METAL);
    y -= h + gap;
  });

  // Push handle on the +x end.
  for (const sz of [-1, 1]) {
    box(m, { min: [W / 2 - 0.02, top - 0.2, sz * 0.19 - 0.02], max: [W / 2 + 0.085, top - 0.16, sz * 0.19 + 0.02], faces: { nx: null, px: null } }, METAL);
  }
  cylinder(m, { from: [W / 2 + 0.085, top - 0.18, -0.24], to: [W / 2 + 0.085, top - 0.18, 0.24], radius: 0.026, sides: 6 }, METAL);

  // Casters: a fork plate and a wheel under each corner.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (W / 2 - 0.13);
      const cz = sz * (D / 2 - 0.11);
      box(m, { min: [cx - 0.06, 0.12, cz - 0.05], max: [cx + 0.06, BODY_Y0 + 0.02, cz + 0.05], faces: { py: null } }, IRON);
      cylinder(m, { from: [cx - 0.04, 0.075, cz], to: [cx + 0.04, 0.075, cz], radius: 0.09, sides: 6 }, RUBBER);
    }
  }

  // Left lying on the mat.
  const clutter = hero ? 0 : seed % 3;
  if (clutter !== 1) {
    // A small parts tray with a spray can in it.
    const tx = hero ? -0.22 : r.range(-0.3, -0.1);
    box(m, { size: [0.36, 0.07, 0.24], at: [tx, top + 0.04, 0.02], rot: [0, hero ? 8 : r.range(-20, 20), 0], faces: { ny: null } }, CREAM);
    cylinder(m, { from: [tx + 0.05, top + 0.06, 0.03], to: [tx + 0.05, top + 0.27, 0.03], radius: 0.05, sides: 6, caps: 'top' }, paint(TRACK.teal, { gloss: 0.6 }));
  }
  if (clutter !== 2) {
    // A wrench: bar and jaw block, lying flat.
    const s = m.mark();
    box(m, { size: [0.34, 0.022, 0.045], at: [0, 0, 0], faces: { ny: null } }, METAL);
    box(m, { size: [0.09, 0.024, 0.1], at: [0.19, 0, 0], faces: { ny: null } }, METAL);
    m.rotate('y', hero ? -25 : r.range(-60, 60), s);
    m.translate([hero ? 0.24 : r.range(0.12, 0.3), top + 0.022, hero ? -0.04 : r.range(-0.08, 0.08)], s);
  }
  if (!hero) m.rotate('y', r.range(-3, 3));
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd20-tool-chest',
  name: 'Garage tool chest',
  category: 'dressing',
  size: { x: 1.22, y: 1.3, z: 0.62 },
  variants: 4,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders: () => [{ shape: 'box', center: [0, 0.52, 0], half: [W / 2, 0.52, D / 2] }],
  build,
};

export default asset;
