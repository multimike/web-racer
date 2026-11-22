import { roundRectInside, splitRun } from './cells';
import { Surface, resolveOptions, rgb255, smooth, softNoise, stream } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * Kerb stone — the band of cream blocks edging the road in the vision
 * images. A STRIP, not a square tile:
 *   u (0..1)  ACROSS the kerb, 0 = road side, 1 = verge side — does not
 *             repeat (clamp it);
 *   v         ALONG the road — repeats every `KERB_TILE_METERS[1]` meters.
 * Laid on a ribbon whose v follows the road, the blocks follow every curve.
 * Block lengths vary (0.24-0.6 m, a few short ones) so the row does not read
 * as a ruler, and both long edges fall away into a bevel, so the kerb has its
 * own lit edge without any geometry.
 *
 * The kerb used to read as straight uniform cream slabs where
 * the vision has irregular hand-set stones. Now each block's end joints are
 * cut a little out of square (a per-joint skew), the corners are rounder,
 * and the tones run from warm cream to a pale lavender-grey with a per-block
 * value step — modest, so the kerb still reads as one cream band.
 */

const COLORS: { blocks: RGB[]; joint: RGB } = {
  // Vision kerb, sunlit: (252,226,209) and (237,193,178).
  blocks: [
    rgb255(252, 230, 212),
    rgb255(244, 214, 198),
    rgb255(255, 236, 216),
    rgb255(238, 204, 192),
    rgb255(250, 224, 200),
    rgb255(230, 214, 214), // pale lavender-grey
    rgb255(246, 220, 190), // warm sand
  ],
  joint: rgb255(138, 108, 118),
};

/** [width across, repeat length along], meters. */
export const KERB_TILE_METERS: [number, number] = [0.4, 4];

export function generateKerbStone(options?: GroundGenOptions): GroundTile {
  const { size: n, seed } = resolveOptions(options, 1201);
  // 1:8 strip: about the same texel size along and across.
  const w = Math.max(16, n >> 3);
  const h = n;
  const s = new Surface(w, h);
  const pxU = w / KERB_TILE_METERS[0];
  const pxV = h / KERB_TILE_METERS[1];

  const wear = softNoise(w, h, 3, 22, stream(seed, 'wear'));
  const grain = softNoise(w, h, 12, 96, stream(seed, 'grain'));

  const rand = stream(seed, 'blocks');
  const lengths = splitRun(h, 0.24 * pxV, 0.6 * pxV, rand);
  // Skew of every joint, meters of v per meter of u: the joint line runs a
  // few centimetres out of square across the 0.4 m kerb. Joint k sits at
  // the START of block k; the last block's end is joint 0 of the next repeat.
  const skew = lengths.map(() => (rand() - 0.5) * 0.28);

  // Joint bed first; the blocks are painted over it.
  const { r, g, b, z } = s;
  for (let i = 0; i < r.length; i++) {
    const t = 0.9 + 0.2 * grain[i];
    r[i] = COLORS.joint[0] * t;
    g[i] = COLORS.joint[1] * t;
    b[i] = COLORS.joint[2] * t;
    z[i] = 0.05;
  }
  const joint = 0.01 * pxV; // half joint width
  const bevel = 0.03; // meters of rounded edge along both long sides
  let v0 = 0;
  for (let k = 0; k < lengths.length; k++) {
    const len = lengths[k];
    const s0 = skew[k];
    const s1 = skew[(k + 1) % lengths.length];
    const base = COLORS.blocks[(rand() * COLORS.blocks.length) | 0];
    const value = 0.9 + rand() * 0.13;
    const top = 0.8 + rand() * 0.14;
    const cy = v0 + len * 0.5;
    // Rows the block can reach with its skewed ends (wrapped below, so the
    // first block's skewed start continues in the last rows of the tile).
    const reach = 0.5 * KERB_TILE_METERS[0] * 0.15 * pxV + 2;
    const y0 = Math.floor(v0 - reach);
    const y1 = Math.ceil(v0 + len + reach);
    for (let y = y0; y <= y1; y++) {
      const yw = ((y % h) + h) % h;
      for (let x = 0; x < w; x++) {
        const i = yw * w + x;
        // Distances in METERS so the corner radius is round in world space
        // although the strip's texels are not square.
        const du = (x + 0.5 - w * 0.5) / pxU;
        // Skewed ends: shift v by the mean skew and stretch the half length
        // by half the difference, both linear in u (a trapezoid block).
        const dv = (y + 0.5 - cy) / pxV - du * 0.5 * (s0 + s1);
        const half = (len * 0.5 - joint) / pxV + du * 0.5 * (s1 - s0);
        const d = roundRectInside(du, dv, KERB_TILE_METERS[0] * 0.5, half, 0.04);
        const m = smooth(0, 0.008, d);
        if (m <= 0) continue;
        const sh = smooth(0, bevel, d);
        const shade = (0.88 + 0.12 * sh) * (0.95 + 0.1 * wear[i]) * (0.985 + 0.03 * grain[i]) * value;
        r[i] += (base[0] * shade - r[i]) * m;
        g[i] += (base[1] * shade - g[i]) * m;
        b[i] += (base[2] * shade - b[i]) * m;
        const zt = 0.12 + (top - 0.12) * sh + 0.05 * (wear[i] - 0.5);
        z[i] += (zt - z[i]) * m;
      }
    }
    v0 += len;
  }
  return s.toTile('kerb-stone', KERB_TILE_METERS, 0.035);
}
