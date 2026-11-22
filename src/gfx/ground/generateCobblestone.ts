import { rasterStones, scatterStones, stoneIdMap } from './cells';
import { Surface, hex, resolveOptions, rgb255, smooth, softNoise, stoneTone, stoneToneT, stream, wrap } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * G06 Village Cobblestone — the village road of the vision images:
 * irregular flagstones of about 0.3-0.5 m, convex with rounded corners and
 * flat tops, in lavender and cream / dusty-pink tones, a few small fillers
 * wedged between them, darker joints. No rows and no grain direction, so the
 * tile can be laid along a curving road ribbon or projected by world XZ.
 *
 * Stone size follows the pack (4 m tile, about a dozen stones across: ~0.3 m)
 * and the vision's village road (a stone about half a tyre wide); final
 * review round: the stones were 0.5-0.9 m, twice that. The tile stays 6 m so
 * the outline repeat is long and holds ~200 stones. Per stone: one flat tone, a
 * soft mottle, a slightly lighter middle and a darker foot where it meets
 * the joint.
 *
 * The tile is deliberately free of LANDMARKS (no fused slabs, no odd sizes,
 * no single extreme tone): the outline of a field of similar convex stones
 * is very hard to recognise a second time, a peanut-shaped slab is spotted
 * in every repeat. The colour mosaic — the other thing a repeat is spotted
 * by — is painted per repeat by the shader from the id map (`groundStones`;
 * see GroundGenOptions.stoneTones).
 */

interface CobbleColors {
  joint0: RGB;
  joint1: RGB;
  /** Stone colour of tone t = 0.5 (see `stoneTone`). */
  mid: RGB;
  /** Tone spread: 1 = the full lavender .. cream range. */
  spread: number;
}

const PALETTES: Record<'vision' | 'pack', CobbleColors> = {
  // Vision, sunlit stones: lavender (195,151,164), dusty pink (220,170,168),
  // cream (241,192,175); joints (163,125,132). `mid` puts tone 0 at
  // (171,144,173) and tone 1 at (251,198,181).
  vision: {
    joint0: rgb255(150, 116, 130),
    joint1: rgb255(174, 136, 146),
    mid: rgb255(211, 171, 177),
    spread: 1,
  },
  // Pack: #A5A1AF .. #C8BBA7, i.e. half the brightness range around its
  // mean. (Its warm stones are also a little yellower, which the one-
  // parameter family does not follow.)
  pack: {
    joint0: hex('#8D8780'),
    joint1: hex('#A29A8E'),
    mid: rgb255(183, 174, 171),
    spread: 0.5,
  },
};

export const VILLAGE_COBBLESTONE_TILE_METERS = 6;

export function generateVillageCobblestone(options?: GroundGenOptions): GroundTile {
  const { size: n, seed, palette } = resolveOptions(options, 947);
  const meters = options?.tileMeters ?? VILLAGE_COBBLESTONE_TILE_METERS;
  const painted = options?.stoneTones !== 'plain';
  const colors = PALETTES[palette];
  const s = new Surface(n, n);
  const px = n / meters; // pixels per meter
  // Noise lattices and dart throws are stated per METER, so a larger tile
  // holds more of the same paving, not a magnified one.
  const cells = (featureMeters: number): number => Math.max(2, Math.round(meters / featureMeters));
  const area = (meters * meters) / 36;

  const wear = softNoise(n, n, cells(0.2), cells(0.2), stream(seed, 'wear'));
  const detail = softNoise(n, n, cells(0.094), cells(0.094), stream(seed, 'detail'));

  // Joint bed everywhere first; stones are painted over it.
  const { r, g, b, z } = s;
  for (let i = 0; i < r.length; i++) {
    const t = (detail[i] - 0.26) / 0.48;
    r[i] = colors.joint0[0] + (colors.joint1[0] - colors.joint0[0]) * t;
    g[i] = colors.joint0[1] + (colors.joint1[1] - colors.joint0[1]) * t;
    b[i] = colors.joint0[2] + (colors.joint1[2] - colors.joint0[2]) * t;
    z[i] = 0.04 + 0.1 * t;
  }

  // Two classes of flagstone and a FEW fillers: the vision's paving is
  // nearly all 0.3-0.5 m stones, with a small one only where three big
  // ones leave a gap. (Radii and throws: the 0.5-0.9 m layout scaled by
  // 0.65, throws by about 1 / 0.65^2 so the packing stays as tight.)
  const sites = scatterStones(
    n,
    n,
    [
      { minRadius: 0.21 * px, maxRadius: 0.29 * px, attempts: Math.round(720 * area) },
      { minRadius: 0.155 * px, maxRadius: 0.2 * px, attempts: Math.round(1180 * area) },
      { minRadius: 0.1 * px, maxRadius: 0.12 * px, attempts: Math.round(520 * area) },
    ],
    0.86,
    stream(seed, 'sites'),
  );
  const count = sites.length;
  // A power-diagram cell is a straight-edged polygon. Reading the layout
  // through a gentle domain warp bows every edge and shifts every corner —
  // hand-cut stone instead of ruled lines — and, unlike moving each outline
  // in or out by a noise, it bends a joint without changing its width.
  const warpX = softNoise(n, n, cells(0.24), cells(0.24), stream(seed, 'warpU'));
  const warpY = softNoise(n, n, cells(0.24), cells(0.24), stream(seed, 'warpV'));
  const maxWarp = 0.03 * px; // softNoise swings +-0.24 about 0.5
  for (let i = 0; i < warpX.length; i++) {
    warpX[i] = ((warpX[i] - 0.5) / 0.24) * maxWarp * 0.8 + ((detail[i] - 0.5) / 0.24) * maxWarp * 0.2;
    warpY[i] = ((warpY[i] - 0.5) / 0.24) * maxWarp;
  }
  const { owner, inside } = rasterStones(n, n, sites, { inset: 0.013 * px, rounding: 0.36, warpX, warpY, maxWarp: maxWarp * 1.05 });

  // Per-stone tone and top level. Lavender and cream gather in loose
  // drifts a few stones wide, as in the vision, instead of salt and pepper.
  const rand = stream(seed, 'stones');
  const drift = softNoise(n, n, cells(1.6), cells(1.6), stream(seed, 'drift'));
  const toneT = new Float32Array(count);
  const tone = new Float32Array(count * 3);
  const level = new Float32Array(count);
  const siteX = new Float32Array(count);
  const siteY = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const site = sites[k];
    siteX[k] = site.x;
    siteY[k] = site.y;
    const lean = drift[wrap(Math.floor(site.y), n) * n + wrap(Math.floor(site.x), n)] - 0.5;
    // The draws are made either way, so 'plain' and 'painted' tiles of one
    // seed differ in nothing but the tones.
    const warm = rand() < 0.5 + 1.5 * lean;
    const drawn = stoneToneT(warm ? 0.75 : 0.25, rand(), colors.spread);
    const t = painted ? drawn : 0.5;
    const c = stoneTone(colors.mid, t);
    const v = 0.97 + rand() * 0.06;
    toneT[k] = t;
    tone[k * 3] = c[0] * v;
    tone[k * 3 + 1] = c[1] * v;
    tone[k * 3 + 2] = c[2] * v;
    level[k] = 0.74 + rand() * 0.2;
  }

  const edgeAA = 1.2;
  const shoulder = 0.025 * px; // the rounded pillow edge
  const crown = 0.12 * px; // how far in the lighter middle starts
  for (let i = 0; i < owner.length; i++) {
    const k = owner[i];
    const d = inside[i];
    if (k < 0 || d <= 0) continue;
    // Soft mottle, and a middle a touch lighter than the rim: the stones of
    // the vision are painted with that slight pillow, not perfectly flat.
    const body = (0.95 + 0.09 * wear[i]) * (0.985 + 0.035 * smooth(shoulder, crown, d));
    if (d >= shoulder) {
      // Flat top (most of the pixels).
      r[i] = tone[k * 3] * body;
      g[i] = tone[k * 3 + 1] * body;
      b[i] = tone[k * 3 + 2] * body;
      z[i] = level[k] + 0.05 * (wear[i] - 0.5) + 0.025 * (detail[i] - 0.5);
      continue;
    }
    const m = d >= edgeAA ? 1 : d / edgeAA;
    const sh = smooth(0, shoulder, d);
    // The foot: darker right at the joint. Non-directional, so no light is
    // baked in.
    const shade = (0.85 + 0.15 * sh) * body;
    r[i] += (tone[k * 3] * shade - r[i]) * m;
    g[i] += (tone[k * 3 + 1] * shade - g[i]) * m;
    b[i] += (tone[k * 3 + 2] * shade - b[i]) * m;
    const top = 0.16 + (level[k] - 0.16) * sh + 0.05 * (wear[i] - 0.5) + 0.025 * (detail[i] - 0.5);
    z[i] += (top - z[i]) * m;
  }

  const tile = s.toTile('village-cobblestone', [meters, meters], 0.04);
  tile.stoneIds = stoneIdMap(n, n, owner, siteX, siteY, toneT);
  tile.stoneSpread = colors.spread;
  return tile;
}
