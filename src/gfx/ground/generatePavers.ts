import { roundRectInside, splitRun, stoneIdMap } from './cells';
import { Surface, resolveOptions, rgb255, smooth, softNoise, stoneTone, stoneToneT, stream, wrap } from './core';
import type { GroundGenOptions, GroundTile, RGB } from './core';

/**
 * Stone pavers — small rectangular slabs for village paths and house
 * forecourts (the grey-lavender slabs in front of the garage and the cream
 * ones under the fruit stall in the vision images). Courses of varying
 * height run along u; each course is cut into slabs of varying length with
 * its own start offset, so no joint lines up across more than two courses.
 * Flat tops, rounded corners, thin joints — the quiet, man-made counterpart
 * of the irregular village cobblestone. Like it, the slabs are toned from
 * the one-parameter stone family and come with an id map, so the shader
 * re-tones them per repeat (`groundStones`).
 */

const COLORS: { mid: RGB; spread: number; joint0: RGB; joint1: RGB } = {
  // Vision forecourt slabs, sunlit: (190,170,187) lavender-grey,
  // (224,177,179) pink, with cream ones near the houses. At spread 0.6 the
  // family runs from (168,156,177) to (212,188,185) around this middle.
  mid: rgb255(190, 172, 181),
  spread: 0.6,
  joint0: rgb255(112, 96, 116),
  joint1: rgb255(134, 112, 126),
};

export const STONE_PAVERS_TILE_METERS = 4.5;

export function generateStonePavers(options?: GroundGenOptions): GroundTile {
  const { size: n, seed } = resolveOptions(options, 1307);
  const meters = options?.tileMeters ?? STONE_PAVERS_TILE_METERS;
  const painted = options?.stoneTones !== 'plain';
  const s = new Surface(n, n);
  const px = n / meters;

  const wear = softNoise(n, n, Math.round(meters / 0.32), Math.round(meters / 0.32), stream(seed, 'wear'));
  const detail = softNoise(n, n, Math.round(meters / 0.064), Math.round(meters / 0.064), stream(seed, 'detail'));

  const { r, g, b, z } = s;
  for (let i = 0; i < r.length; i++) {
    const t = (detail[i] - 0.26) / 0.48;
    r[i] = COLORS.joint0[0] + (COLORS.joint1[0] - COLORS.joint0[0]) * t;
    g[i] = COLORS.joint0[1] + (COLORS.joint1[1] - COLORS.joint0[1]) * t;
    b[i] = COLORS.joint0[2] + (COLORS.joint1[2] - COLORS.joint0[2]) * t;
    z[i] = 0.05 + 0.08 * t;
  }

  const rand = stream(seed, 'slabs');
  const courses = splitRun(n, 0.3 * px, 0.46 * px, rand);
  const joint = 0.008 * px;
  const corner = 0.03 * px;
  const shoulder = 0.03 * px;
  const owner = new Int32Array(n * n).fill(-1);
  const centreX: number[] = [];
  const centreY: number[] = [];
  const toneT: number[] = [];
  let y0 = 0;
  for (const courseH of courses) {
    const slabs = splitRun(n, 0.34 * px, 0.74 * px, rand);
    let x0 = rand() * n;
    for (const len of slabs) {
      const drawn = stoneToneT(rand(), rand(), COLORS.spread);
      const t = painted ? drawn : 0.5;
      const base = stoneTone(COLORS.mid, t);
      const value = 0.96 + rand() * 0.08;
      const top = 0.76 + rand() * 0.16;
      const cx = x0 + len * 0.5;
      const cy = y0 + courseH * 0.5;
      const hx = len * 0.5 - joint;
      const hy = courseH * 0.5 - joint;
      const slab = toneT.length;
      centreX.push(cx);
      centreY.push(cy);
      toneT.push(t);
      for (let y = Math.floor(y0); y <= Math.ceil(y0 + courseH); y++) {
        const row = wrap(y, n) * n;
        for (let x = Math.floor(x0); x <= Math.ceil(x0 + len); x++) {
          const i = row + wrap(x, n);
          // The slab's whole rectangle, joint included, goes into the id
          // map; a pixel on a shared border goes to whichever slab comes last.
          if (Math.abs(x + 0.5 - cx) <= len * 0.5 && Math.abs(y + 0.5 - cy) <= courseH * 0.5) owner[i] = slab;
          const d = roundRectInside(x + 0.5 - cx, y + 0.5 - cy, hx, hy, corner);
          if (d <= 0) continue;
          const m = d >= 1.2 ? 1 : d / 1.2;
          const sh = smooth(0, shoulder, d);
          const shade = (0.87 + 0.13 * sh) * (0.95 + 0.1 * wear[i]) * value;
          r[i] += (base[0] * shade - r[i]) * m;
          g[i] += (base[1] * shade - g[i]) * m;
          b[i] += (base[2] * shade - b[i]) * m;
          const zt = 0.15 + (top - 0.15) * sh + 0.04 * (wear[i] - 0.5) + 0.02 * (detail[i] - 0.5);
          z[i] += (zt - z[i]) * m;
        }
      }
      x0 += len;
    }
    y0 += courseH;
  }
  const tile = s.toTile('stone-pavers', [meters, meters], 0.03);
  tile.stoneIds = stoneIdMap(n, n, owner, centreX, centreY, toneT);
  tile.stoneSpread = COLORS.spread;
  return tile;
}
