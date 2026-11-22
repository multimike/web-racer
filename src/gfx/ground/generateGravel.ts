import { Surface, hex, resolveOptions, rgb255, softNoise, stampPebble, stream } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G04 Lavender Gravel — small lavender, slate and cream stones bedded in a
 * muted earth matrix; the loose-stone version of the rock props' palette.
 * Each stone is a tiny faceted polygon with a flat-ish top and a baked
 * contact ring, so the bed reads as separate pebbles rather than noise.
 */

interface GravelColors {
  matrix0: RGB;
  matrix1: RGB;
  stones: RGB[];
}

const PALETTES: Record<'vision' | 'pack', GravelColors> = {
  // Vision rocks are far more saturated than the pack's grey-lavender:
  // sunlit top planes (190,170,187), bodies around (135,107,150).
  vision: {
    matrix0: rgb255(164, 138, 136),
    matrix1: rgb255(190, 162, 150),
    stones: [
      rgb255(160, 148, 196),
      rgb255(134, 126, 178),
      rgb255(186, 172, 208),
      rgb255(232, 204, 176),
      rgb255(220, 190, 162),
      rgb255(140, 138, 172),
    ],
  },
  pack: {
    matrix0: hex('#8C827B'),
    matrix1: hex('#A29B90'),
    stones: [hex('#A09AB5'), hex('#8C88A1'), hex('#B6AEC3'), hex('#C7BBA8'), hex('#C5B9A1'), hex('#8F91A6')],
  },
};

export const LAVENDER_GRAVEL_TILE_METERS = 4;

export function generateLavenderGravel(options?: GroundGenOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 683);
  const colors = PALETTES[palette];
  const s = new Surface(n, n);

  const medium = softNoise(n, n, 12, 12, stream(seed, 'medium'));
  const fine = softNoise(n, n, 80, 80, stream(seed, 'fine'));
  const { r, g, b, z } = s;
  for (let i = 0; i < r.length; i++) {
    const t = (medium[i] - 0.26) / 0.48;
    r[i] = colors.matrix0[0] + (colors.matrix1[0] - colors.matrix0[0]) * t;
    g[i] = colors.matrix0[1] + (colors.matrix1[1] - colors.matrix0[1]) * t;
    b[i] = colors.matrix0[2] + (colors.matrix1[2] - colors.matrix0[2]) * t;
    z[i] = 0.1 + 0.16 * t + 0.08 * (fine[i] - 0.26);
  }

  // Small stones first, big ones last, so the big ones sit on top.
  const rand = stream(seed, 'stones');
  const px = n / (LAVENDER_GRAVEL_TILE_METERS * 100);
  const count = 2300;
  const radii = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const u = rand();
    radii[k] = (1.5 + 3.6 * u * u) * px;
  }
  radii.sort();
  for (let k = 0; k < count; k++) {
    const radius = radii[k];
    const color = colors.stones[(rand() * colors.stones.length) | 0];
    const tone = 0.94 + rand() * 0.12;
    stampPebble(s, rand() * n, rand() * n, radius, rand, [color[0] * tone, color[1] * tone, color[2] * tone], {
      opacity: 0.96,
      level: 0.42 + 0.3 * (radius / (5.1 * px)),
      dome: 0.28,
      ringPx: Math.max(1, radius * 0.45),
      ring: 0.16,
    });
  }
  return s.toTile('lavender-gravel', [LAVENDER_GRAVEL_TILE_METERS, LAVENDER_GRAVEL_TILE_METERS], 0.045);
}
