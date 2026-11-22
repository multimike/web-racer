import type { MenuCarInfo, MenuPaint } from '../../game/contracts/menu';
import { carStats } from '../../game/menuFlow';
import { CAR_DESIGNS } from '../../game/options';
import { loadAsset } from '../../assets/registry';
import { HANDLING_PRESETS } from '../../car/handling';
import { rigFor } from '../../car/rig';
import type { RGB } from '../../gfx/solid/color';

/** sRGB 0 … 1 → CSS '#rrggbb'. */
export const hex = (c: RGB): string => '#' + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');

/** The car screen's data, in CAR_DESIGNS order, from the car assets (name,
 * paints), HANDLING_PRESETS (class, description), the rig (mass) and the
 * stat pips (menuFlow.carStats). A car without `paints` gets one neutral
 * chip per livery. */
export async function menuCars(): Promise<MenuCarInfo[]> {
  const out: MenuCarInfo[] = [];
  for (const id of CAR_DESIGNS) {
    const asset = await loadAsset(id);
    if (asset.kind !== 'car') continue;
    const paints: MenuPaint[] = asset.paints?.length
      ? asset.paints.map((p) => ({ name: p.name, body: hex(p.body), accent: hex(p.accent) }))
      : Array.from({ length: Math.max(1, asset.liveries) }, (_, i) => ({ name: `Paint ${i + 1}`, body: '#aebbc2', accent: '#141e27' }));
    const preset = HANDLING_PRESETS[id];
    out.push({
      id,
      name: asset.name,
      classLabel: preset?.label ?? '',
      description: preset?.description ?? '',
      massKg: Math.round(rigFor(id).totalMass),
      stats: carStats(id),
      paints,
    });
  }
  return out;
}
