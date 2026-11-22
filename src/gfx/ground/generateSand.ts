import { Surface, hex, resolveOptions, rgb255, softNoise, stream } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G02 Sunlit Sand — golden-cream sand: soft tonal clouds and faint,
 * wandering wind ripples. The ripples live in the HEIGHT (so the sun lights
 * them from wherever it really is) with only a whisper of crest / trough
 * tint in the albedo. They run ACROSS v; the tile must not be rotated.
 */

interface SandColors {
  shade: RGB;
  light: RGB;
}

const PALETTES: Record<'vision' | 'pack', SandColors> = {
  // No sand is visible in the vision images; the pack's golden cream sits in
  // the same family as the kerb and plaster creams there, nudged a little
  // warmer to hold its own next to the orange dirt.
  vision: { shade: rgb255(218, 182, 124), light: rgb255(242, 214, 162) },
  pack: { shade: hex('#D6B779'), light: hex('#EDD5A0') },
};

export const SUNLIT_SAND_TILE_METERS = 4;

export function generateSunlitSand(options?: GroundGenOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 421);
  const colors = PALETTES[palette];
  const s = new Surface(n, n);

  // Nothing broader than ~45 cm, like every other tile: the shader's slow
  // fields supply the large-scale variety.
  const broad = softNoise(n, n, 9, 9, stream(seed, 'broad'));
  const medium = softNoise(n, n, 17, 17, stream(seed, 'medium'));
  const fine = softNoise(n, n, 90, 90, stream(seed, 'fine'));

  // Ripple phase: an integer number of crests across v, bent by periodic
  // NOISE, so the pattern closes on itself at the tile edge. A regular warp
  // (it was a sine across u) shows as a chevron with the warp's period.
  const crests = 11;
  const tau = Math.PI * 2;
  const bendWide = softNoise(n, n, 3, 5, stream(seed, 'bendWide'));
  const bendFine = softNoise(n, n, 9, 14, stream(seed, 'bendFine'));
  // Where the ripples are strong at all: ~1 m fields, several crests each.
  const drifts = softNoise(n, n, 4, 4, stream(seed, 'drifts'));

  // cos() through a table: a trig call per pixel was a third of this
  // material's cost.
  const LUT = 2048;
  const cosLut = new Float32Array(LUT);
  for (let k = 0; k < LUT; k++) cosLut[k] = 0.5 + 0.5 * Math.cos((k / LUT) * tau);

  const { r, g, b, z } = s;
  for (let y = 0, i = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++, i++) {
      // Phase in turns. Up to ~1.5 crests of bend, so crests wander, fork
      // and merge instead of ruling the tile.
      const turns = crests * v + 3.2 * (bendWide[i] - 0.5) + 1.1 * (bendFine[i] - 0.5);
      const c = cosLut[((turns - Math.floor(turns)) * LUT) | 0];
      // Sharper crests, wider troughs: wind ripples, not a sine wave.
      const wave = c * Math.sqrt(c);
      // Ripples fade in and out across the tile instead of combing all of it.
      const strength = 0.2 + 1.5 * (drifts[i] - 0.26);

      const t = 0.5 * broad[i] + 0.34 * medium[i] + 0.16 * fine[i] + 0.09 * strength * (wave - 0.4);
      const k = t < 0 ? 0 : t > 1 ? 1 : t;
      r[i] = colors.shade[0] + (colors.light[0] - colors.shade[0]) * k;
      g[i] = colors.shade[1] + (colors.light[1] - colors.shade[1]) * k;
      b[i] = colors.shade[2] + (colors.light[2] - colors.shade[2]) * k;
      z[i] = 0.2 + 0.36 * (broad[i] - 0.26) + 0.3 * strength * wave + 0.1 * (fine[i] - 0.26);
    }
  }
  return s.toTile('sunlit-sand', [SUNLIT_SAND_TILE_METERS, SUNLIT_SAND_TILE_METERS], 0.025);
}
