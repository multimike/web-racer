import { Surface, hex, resolveOptions, rgb255, smooth, softNoise, stream, wrap } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G05 Worn Asphalt — cool slate asphalt for the garage apron and service
 * areas: soft repair patches, a fine binder mottle and scattered pale
 * aggregate specks. Almost flat; no lane markings (painted lines are laid
 * over it in the shader, see `groundPaint`).
 */

interface AsphaltColors {
  dark: RGB;
  light: RGB;
  specks: RGB[];
  /** Tonal swing of the patches. */
  contrast: number;
}

const PALETTES: Record<'vision' | 'pack', AsphaltColors> = {
  // Vision apron: sunlit (128,120,145), in shade (89,90,115) — a mid
  // lavender-slate, clearly lighter and more violet than the pack's blue.
  vision: {
    dark: rgb255(110, 108, 138),
    light: rgb255(132, 126, 154),
    specks: [rgb255(160, 158, 182), rgb255(142, 142, 170), rgb255(178, 172, 190)],
    contrast: 1.0,
  },
  pack: {
    dark: hex('#4C5667'),
    light: hex('#5A6475'),
    specks: [hex('#79818D'), hex('#626E80'), hex('#8C929B')],
    contrast: 0.8,
  },
};

export const WORN_ASPHALT_TILE_METERS = 4;

export function generateWornAsphalt(options?: GroundGenOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 829);
  const colors = PALETTES[palette];
  const s = new Surface(n, n);

  const broad = softNoise(n, n, 7, 7, stream(seed, 'broad'));
  const medium = softNoise(n, n, 14, 14, stream(seed, 'medium'));
  const fine = softNoise(n, n, 110, 110, stream(seed, 'fine'));
  const { r, g, b, z } = s;
  for (let i = 0; i < r.length; i++) {
    // Repair patches: plateaus with a soft edge, not a gradient. Barely
    // there — at more than a few percent the ~0.6 m plateaus are the one
    // feature of this tile that reads as a pattern across a parking lot.
    const patches = smooth(0.42, 0.58, broad[i] + 0.35 * (medium[i] - 0.5));
    let t = 0.5 + colors.contrast * (0.09 * (patches - 0.5) + 0.55 * (medium[i] - 0.5) + 0.5 * (fine[i] - 0.5));
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    r[i] = colors.dark[0] + (colors.light[0] - colors.dark[0]) * t;
    g[i] = colors.dark[1] + (colors.light[1] - colors.dark[1]) * t;
    b[i] = colors.dark[2] + (colors.light[2] - colors.dark[2]) * t;
    z[i] = 0.35 + 0.08 * (patches - 0.5) + 0.3 * (medium[i] - 0.5) + 0.7 * (fine[i] - 0.5);
  }

  // Aggregate: at this texel size a speck is 1-2 pixels, so it is written as
  // a tiny 3x3 kernel instead of a shaped stamp.
  const rand = stream(seed, 'specks');
  const count = Math.round(1500 * (n / 512) * (n / 512));
  for (let k = 0; k < count; k++) {
    const cx = (rand() * n) | 0;
    const cy = (rand() * n) | 0;
    const color = colors.specks[(rand() * colors.specks.length) | 0];
    const strength = 0.35 + rand() * 0.5;
    const wide = rand() < 0.3;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const d2 = dx * dx + dy * dy;
        const m = d2 === 0 ? 1 : wide ? (d2 === 1 ? 0.5 : 0.2) : d2 === 1 ? 0.18 : 0;
        if (m === 0) continue;
        const i = wrap(cy + dy, n) * n + wrap(cx + dx, n);
        s.tint(i, color, m * strength);
        z[i] += 0.3 * m * strength;
      }
    }
  }
  return s.toTile('worn-asphalt', [WORN_ASPHALT_TILE_METERS, WORN_ASPHALT_TILE_METERS], 0.008);
}
