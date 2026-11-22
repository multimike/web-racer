import { Surface, hex, noiseField, resolveOptions, rgb255, smooth, softNoise, stream, wrap } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G03 Meadow Grass — a short stylized grass carpet: a lime base, soft darker
 * tufts, and broad curved blade strokes on top (light strokes on the open
 * turf, dark ones gathered in the tufts). It is the carpet UNDER the 3D
 * grass / flower props, so it stays calm: no single blade is meant to be
 * read from the chase camera, only a soft tuft rhythm.
 */

interface GrassColors {
  deep: RGB;
  lime: RGB;
  tuft: RGB;
  light: RGB[];
  dark: RGB[];
  blades: number;
  /** Opacity of a blade stroke. */
  stroke: number;
  /** How dark the tufts go (0..1 toward the tuft colour). */
  tuftStrength: number;
}

const PALETTES: Record<'vision' | 'pack', GrassColors> = {
  // Vision: sunlit verge reads a yellow lime around (176,167,48) ..
  // (200,190,50), shaded tufts (104,114,51): much yellower and lighter than
  // the pack's jade, and cleaner (fewer, broader strokes).
  vision: {
    deep: rgb255(146, 166, 52),
    lime: rgb255(182, 188, 58),
    tuft: rgb255(108, 142, 48),
    light: [rgb255(198, 202, 68), rgb255(206, 208, 78), rgb255(176, 190, 58)],
    dark: [rgb255(98, 136, 46), rgb255(116, 150, 50), rgb255(88, 128, 50)],
    blades: 2300,
    stroke: 0.42,
    tuftStrength: 0.24,
  },
  pack: {
    deep: hex('#3E7942'),
    lime: hex('#7EA84D'),
    tuft: hex('#3F7F42'),
    light: [hex('#79AC46'), hex('#8AB94D'), hex('#639B43')],
    dark: [hex('#4D883D'), hex('#3F7F42'), hex('#4D883D')],
    blades: 3600,
    stroke: 0.58,
    tuftStrength: 0.22,
  },
};

export const MEADOW_GRASS_TILE_METERS = 4;

interface Sprite {
  w: number;
  h: number;
  /** Offset of the sprite's first pixel from the stamp centre. */
  ox: number;
  oy: number;
  mask: Float32Array;
}

/** One curved, tapered blade stroke. Pre-rendered because a few thousand
 * blades per tile only come in a handful of sizes and directions: stamping a
 * cached mask is ~10x cheaper than evaluating the shape per blade. */
function bladeSprite(length: number, width: number, angle: number, bend: number): Sprite {
  const reach = Math.ceil(length + width) + 1;
  const side = reach * 2 + 1;
  const full = new Float32Array(side * side);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  let x0 = side;
  let x1 = -1;
  let y0 = side;
  let y1 = -1;
  for (let y = 0; y < side; y++) {
    const dy = y - reach;
    for (let x = 0; x < side; x++) {
      const dx = x - reach;
      const along = (dx * ca + dy * sa) / length;
      if (along < -1.1 || along > 1.1) continue;
      // Tapers from a broad base (along = -1) to a point (along = +1).
      const taper = 1 - 0.55 * (along * 0.5 + 0.5);
      const across = (dy * ca - dx * sa) / (width * taper) - bend * (1 - along * along);
      const shape = Math.sqrt(along * along + across * across);
      const m = 1 - smooth(0.62, 1.05, shape);
      if (m <= 0.004) continue;
      full[y * side + x] = m;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { w: 1, h: 1, ox: 0, oy: 0, mask: new Float32Array([1]) };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) mask[y * w + x] = full[(y + y0) * side + x + x0];
  }
  return { w, h, ox: x0 - reach, oy: y0 - reach, mask };
}

export function generateMeadowGrass(options?: GroundGenOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 557);
  const colors = PALETTES[palette];
  const s = new Surface(n, n);

  // Nothing in the tile is larger than ~40 cm: anything broader would be the
  // first thing to show the 4 m repeat on a 200 m field. The broad variety
  // comes from the shader's slow fields (groundMacro).
  const medium = softNoise(n, n, 20, 20, stream(seed, 'medium'));
  // The tuft rhythm: ~25 cm islands, broken up by a second, coarser field
  // so they come in different sizes and spacings. Kept FAINT: evenly
  // spaced dark tufts of one size read as a printed pattern from above
  // (the look-down diorama view) however well the repeat is hidden.
  const clump = noiseField(n, n, 30, 30, stream(seed, 'clump'));
  const gather = noiseField(n, n, 13, 13, stream(seed, 'gather'));

  const { r, g, b, z } = s;
  const tuft = new Float32Array(n * n);
  for (let i = 0; i < r.length; i++) {
    const t = Math.min(1, Math.max(0, 0.5 + 1.5 * (medium[i] - 0.5)));
    // Soft-edged islands where the clump noise runs high.
    const k = smooth(0.3, 1.6, 0.78 * clump[i] + 0.62 * gather[i]);
    tuft[i] = k;
    const m = k * colors.tuftStrength;
    r[i] = colors.deep[0] + (colors.lime[0] - colors.deep[0]) * t;
    g[i] = colors.deep[1] + (colors.lime[1] - colors.deep[1]) * t;
    b[i] = colors.deep[2] + (colors.lime[2] - colors.deep[2]) * t;
    r[i] += (colors.tuft[0] - r[i]) * m;
    g[i] += (colors.tuft[1] - g[i]) * m;
    b[i] += (colors.tuft[2] - b[i]) * m;
    z[i] = 0.2 + 0.35 * (medium[i] - 0.26) + 0.2 * k;
  }

  // Blade sprites: 16 directions x 3 lengths x 2 bends. Sizes in pixels of
  // an n-pixel tile, so a blade is 7-15 cm long whatever the resolution.
  const px = n / (MEADOW_GRASS_TILE_METERS * 100);
  const lengths = [3.6 * px, 5.2 * px, 7.2 * px];
  const sprites: Sprite[] = [];
  const DIRS = 16;
  for (let a = 0; a < DIRS; a++) {
    for (let l = 0; l < lengths.length; l++) {
      for (let c = 0; c < 2; c++) {
        const width = Math.max(1.1, (1.5 + 0.45 * l) * px);
        sprites.push(bladeSprite(lengths[l], width, ((a + 0.5 * c) / DIRS) * Math.PI * 2, c ? 0.55 : -0.55));
      }
    }
  }

  const rand = stream(seed, 'blades');
  for (let k = 0; k < colors.blades; k++) {
    const cx = (rand() * n) | 0;
    const cy = (rand() * n) | 0;
    const sprite = sprites[(rand() * sprites.length) | 0];
    // Dark strokes gather in the tufts, light ones on the open turf.
    const inTuft = tuft[cy * n + cx];
    const tones = rand() < 0.15 + 0.7 * inTuft ? colors.dark : colors.light;
    const tone = tones[(rand() * tones.length) | 0];
    const lift = 0.1 + rand() * 0.08;
    const { w, h, ox, oy, mask } = sprite;
    for (let y = 0; y < h; y++) {
      const row = wrap(cy + oy + y, n) * n;
      const src = y * w;
      for (let x = 0; x < w; x++) {
        const m = mask[src + x];
        if (m === 0) continue;
        const i = row + wrap(cx + ox + x, n);
        const a = m * colors.stroke;
        r[i] += (tone[0] - r[i]) * a;
        g[i] += (tone[1] - g[i]) * a;
        b[i] += (tone[2] - b[i]) * a;
        // A blade only swells the carpet a little: with real relief every
        // stroke lights up as an embossed stamp.
        z[i] += lift * m;
      }
    }
  }
  return s.toTile('meadow-grass', [MEADOW_GRASS_TILE_METERS, MEADOW_GRASS_TILE_METERS], 0.03);
}
