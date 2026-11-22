import { Surface, hex, noiseField, resolveOptions, rgb255, soften, softNoise, stampPebble, stream } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G01 Rally Dirt — warm compacted ochre dirt: soft tonal patches under a
 * fine, crisp grain, sparse pale pebbles with a baked contact ring.
 *
 * Isotropic by default so it can be projected onto the terrain by world XZ.
 * The vision's tire streaks belong to the ROAD (they follow the driving
 * direction through every bend), so the road-ribbon shader adds them
 * (`groundStreaked`); `streaks` > 0 bakes streaks along v into the tile
 * instead, for a ribbon that wants them for one tap.
 */

export interface DirtOptions extends GroundGenOptions {
  /** 0 = isotropic (default), 1 = clear streaks running along v. */
  streaks?: number;
}

interface DirtColors {
  dark: RGB;
  light: RGB;
  /** How far the broad patches swing between dark and light. */
  contrast: number;
  pebbles: RGB[];
}

const PALETTES: Record<'vision' | 'pack', DirtColors> = {
  // Vision: lit dirt reads (208,128,81) .. (241,157,97) — oranger and with
  // far more tonal play than the pack's almost flat tan.
  vision: {
    dark: rgb255(214, 138, 92),
    light: rgb255(252, 178, 122),
    contrast: 1.0,
    pebbles: [rgb255(250, 216, 172), rgb255(236, 192, 150), rgb255(176, 124, 100)],
  },
  pack: {
    dark: hex('#AF7B46'),
    light: hex('#C49457'),
    contrast: 0.55,
    pebbles: [hex('#C7AA7F'), hex('#B49165'), hex('#D4B887')],
  },
};

export const RALLY_DIRT_TILE_METERS = 4;

export function generateRallyDirt(options?: DirtOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 317);
  const streaks = options?.streaks ?? 0;
  const colors = PALETTES[palette];
  const s = new Surface(n, n);

  // No tile-sized features (they would show the repeat): the largest patches
  // are ~50 cm; broader variety comes from the shader's slow fields.
  const broad = softNoise(n, n, 8, 8, stream(seed, 'broad'));
  const medium = softNoise(n, n, 21, 21, stream(seed, 'medium'));
  const fine = softNoise(n, n, 72, 72, stream(seed, 'fine'));
  // ~2.5 cm grain: without it the surface is all soft cloud and reads out
  // of focus from the chase camera.
  const grain = softNoise(n, n, 168, 168, stream(seed, 'grain'));
  // Stretched 30:1 along v: thin brushed lines, not bands.
  const streak = streaks > 0 ? soften(noiseField(n, n, 60, 2, stream(seed, 'streak'))) : null;

  const { r, g, b, z } = s;
  const k = colors.contrast;
  for (let i = 0; i < r.length; i++) {
    let t = 0.5 + k * (0.4 * (broad[i] - 0.5) + 0.65 * (medium[i] - 0.5) + 0.45 * (fine[i] - 0.5) + 0.95 * (grain[i] - 0.5));
    if (streak) t += streaks * 0.9 * (streak[i] - 0.5);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    r[i] = colors.dark[0] + (colors.light[0] - colors.dark[0]) * t;
    g[i] = colors.dark[1] + (colors.light[1] - colors.dark[1]) * t;
    b[i] = colors.dark[2] + (colors.light[2] - colors.dark[2]) * t;
    // Compacted ground: low soft clumps, light patches are the high, dry ones.
    z[i] = 0.3 + 0.45 * (medium[i] - 0.26) + 0.22 * (fine[i] - 0.26) + 0.3 * (grain[i] - 0.5) + (streak ? streaks * 0.2 * (streak[i] - 0.5) : 0);
  }

  // Pebbles: 1-3 cm, a couple of hundred per tile. Radii are in pixels of an
  // n-pixel tile so the physical size does not change with resolution.
  const rand = stream(seed, 'pebbles');
  const px = n / (RALLY_DIRT_TILE_METERS * 100); // pixels per centimeter
  const count = 190;
  for (let p = 0; p < count; p++) {
    const big = rand() < 0.22;
    const radius = (big ? 1.7 + rand() * 1.5 : 0.8 + rand() * 0.9) * px;
    stampPebble(s, rand() * n, rand() * n, radius, rand, colors.pebbles[(rand() * colors.pebbles.length) | 0], {
      opacity: 0.92,
      level: 0.62,
      dome: 0.3,
      ringPx: Math.max(1, radius * 0.6),
      ring: 0.1,
    });
  }
  return s.toTile('rally-dirt', [RALLY_DIRT_TILE_METERS, RALLY_DIRT_TILE_METERS], 0.03);
}
