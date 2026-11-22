import { wrap } from './core';

/**
 * Toroidal stone layouts for the paved materials.
 *
 * `scatterStones` + `rasterStones` build an irregular flagstone field: sites
 * with individual radii are dart-thrown onto the torus (big stones first,
 * fillers into the gaps), each gets its POWER-diagram cell (a Voronoi cell
 * whose borders are pushed toward the smaller neighbour, so a big stone
 * keeps its size), and every cell is rasterized as an inset polygon with
 * rounded corners. Working per cell — clip a polygon, then walk only its
 * bounding box against its 5-8 edges — is ~10x cheaper than the usual
 * per-pixel 3x3 Voronoi search, which is what keeps cobblestones inside the
 * load-time budget.
 *
 * `stoneIdMap` packs "which stone is this texel part of" into a second RGBA8
 * buffer; the shader (`groundStones`) uses it to give every stone of every
 * REPEAT of the tile its own tone, so the colour mosaic never repeats.
 */

export interface StoneSite {
  /** Centre, pixels. */
  x: number;
  y: number;
  /** Intended radius, pixels. */
  r: number;
}

export interface StoneClass {
  /** Radius range, pixels. */
  minRadius: number;
  maxRadius: number;
  /** Dart throws for this class; a throw is kept when it does not crowd an
   * existing stone. More throws = tighter packing of that class. */
  attempts: number;
}

/**
 * Dart throwing with per-stone radii on a w x h torus. `spacing` scales the
 * required centre distance (ri + rj): < 1 lets neighbours squeeze each other
 * into flat-sided polygons, 1 leaves them nearly round.
 */
export function scatterStones(w: number, h: number, classes: StoneClass[], spacing: number, rand: () => number): StoneSite[] {
  const sites: StoneSite[] = [];
  for (const c of classes) {
    for (let a = 0; a < c.attempts; a++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = c.minRadius + (c.maxRadius - c.minRadius) * rand();
      let free = true;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        let dx = Math.abs(s.x - x);
        let dy = Math.abs(s.y - y);
        if (dx > w * 0.5) dx = w - dx;
        if (dy > h * 0.5) dy = h - dy;
        const min = (s.r + r) * spacing;
        if (dx * dx + dy * dy < min * min) {
          free = false;
          break;
        }
      }
      if (free) sites.push({ x, y, r });
    }
  }
  return sites;
}

export interface StoneRaster {
  /** Joint half-width: every cell is shrunk by this much, pixels. */
  inset: number;
  /** Corner radius as a fraction of the stone's own radius. */
  rounding: number;
  /** Optional domain warp, pixels per pixel: the layout is read at
   * (x + warpX, y + warpY). Bows the cells' straight edges and shifts their
   * corners; a joint bends with it and keeps its width. */
  warpX?: Float32Array;
  warpY?: Float32Array;
  /** Upper bound of |warpX|, |warpY|, pixels (required with a warp). */
  maxWarp?: number;
}

export interface StoneField {
  /** Per pixel: index of the stone it is nearest to — every pixel has one,
   * joints included, which the id map needs (see `stoneIdMap`). -1 only if
   * no stone's cell came near, which a closed layout does not produce. */
  owner: Int32Array;
  /** Per pixel: distance INSIDE that stone's rounded outline, pixels (0 on
   * the edge, growing toward the middle, negative in the joint). */
  inside: Float32Array;
}

/** Clip a convex polygon (flat x, y lists) by the half-plane n . p <= c. */
function clipHalfPlane(px: number[], py: number[], nx: number, ny: number, c: number): [number[], number[]] {
  const qx: number[] = [];
  const qy: number[] = [];
  for (let k = 0; k < px.length; k++) {
    const k2 = (k + 1) % px.length;
    const da = px[k] * nx + py[k] * ny - c;
    const db = px[k2] * nx + py[k2] * ny - c;
    if (da <= 0) {
      qx.push(px[k]);
      qy.push(py[k]);
    }
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      qx.push(px[k] + (px[k2] - px[k]) * t);
      qy.push(py[k] + (py[k2] - py[k]) * t);
    }
  }
  return [qx, qy];
}

/**
 * Rasterize every stone into a per-pixel (owner, inside-distance) field.
 * Returned as buffers rather than through a per-pixel callback: the caller
 * then shades all pixels in one tight loop (a callback per pixel cost more
 * than the geometry itself).
 *
 * A stone is its cell moved in by (inset + corner radius) — the CORE, again
 * a convex polygon, found by clipping — grown back by the corner radius.
 * Measuring the exact distance to the core is what makes the outline right
 * for any corner radius: the short edges of a cell vanish from the core, and
 * a shortcut through "the two nearest edge lines" then cuts notches into
 * the corners.
 */
export function rasterStones(w: number, h: number, sites: StoneSite[], opts: StoneRaster): StoneField {
  const owner = new Int32Array(w * h).fill(-1);
  const inside = new Float32Array(w * h).fill(-1e9);
  const count = sites.length;
  const NEAR = 20;
  const near = new Int32Array(NEAR);
  const nearKey = new Float64Array(NEAR);
  const MAX_EDGES = 32;
  // Per core edge: start x, y, direction x, y (unit), length, outward normal x, y.
  const edge = new Float64Array(MAX_EDGES * 7);
  const { warpX, warpY } = opts;
  const reach = Math.ceil(warpX && warpY ? (opts.maxWarp ?? 0) : 0) + 1;

  for (let i = 0; i < count; i++) {
    const a = sites[i];
    // The NEAR neighbours by power distance (the ones whose border can
    // reach this cell), kept sorted by insertion.
    let m = 0;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      const dx = wrapDelta(sites[j].x - a.x, w);
      const dy = wrapDelta(sites[j].y - a.y, h);
      const key = dx * dx + dy * dy - sites[j].r * sites[j].r;
      if (m === NEAR && key >= nearKey[NEAR - 1]) continue;
      let k = m < NEAR ? m++ : NEAR - 1;
      while (k > 0 && nearKey[k - 1] > key) {
        nearKey[k] = nearKey[k - 1];
        near[k] = near[k - 1];
        k--;
      }
      nearKey[k] = key;
      near[k] = j;
    }

    // The cell: a generous box clipped by each neighbour's border.
    const big = Math.max(w, h) * 0.5;
    let px = [-big, big, big, -big];
    let py = [-big, -big, big, big];
    for (let q = 0; q < m && px.length >= 3; q++) {
      const j = near[q];
      const dx = wrapDelta(sites[j].x - a.x, w);
      const dy = wrapDelta(sites[j].y - a.y, h);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // Power-diagram border: the bisector shifted toward the smaller stone.
      const c = (len * len + a.r * a.r - sites[j].r * sites[j].r) / (2 * len);
      [px, py] = clipHalfPlane(px, py, dx / len, dy / len, c);
    }
    if (px.length < 3) continue;

    // The core. A cell too small for the wanted corner radius gets a
    // smaller one rather than no stone.
    let rr = Math.max(0.5, a.r * opts.rounding);
    let cx: number[] = [];
    let cy: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++, rr *= 0.5) {
      cx = px;
      cy = py;
      for (let k = 0; k < px.length && cx.length >= 3; k++) {
        const k2 = (k + 1) % px.length;
        const ex = px[k2] - px[k];
        const ey = py[k2] - py[k];
        const len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        // The cell is counter-clockwise (the box was): outward = (ey, -ex).
        const nx = ey / len;
        const ny = -ex / len;
        [cx, cy] = clipHalfPlane(cx, cy, nx, ny, px[k] * nx + py[k] * ny - opts.inset - rr);
      }
      if (cx.length >= 3) break;
    }
    if (cx.length < 3) continue;
    let edges = 0;
    for (let k = 0; k < cx.length && edges < MAX_EDGES; k++) {
      const k2 = (k + 1) % cx.length;
      const ex = cx[k2] - cx[k];
      const ey = cy[k2] - cy[k];
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      const o = edges * 7;
      edge[o] = cx[k];
      edge[o + 1] = cy[k];
      edge[o + 2] = ex / len;
      edge[o + 3] = ey / len;
      edge[o + 4] = len;
      edge[o + 5] = ey / len;
      edge[o + 6] = -ex / len;
      edges++;
    }
    if (edges < 3) continue;

    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < py.length; k++) {
      if (py[k] < y0) y0 = py[k];
      if (py[k] > y1) y1 = py[k];
    }
    const iy0 = Math.floor(a.y + y0) - reach;
    const iy1 = Math.ceil(a.y + y1) + reach;
    for (let y = iy0; y <= iy1; y++) {
      const ly = y + 0.5 - a.y;
      const row = wrap(y, h) * w;
      // Span of the cell over the scanlines a warped pixel of this row can
      // read (the cell is convex, so that is its span at the two extreme
      // rows and at any vertex between them): walking the whole bounding
      // box would spend half its time outside the polygon.
      const ya = ly - reach;
      const yb = ly + reach;
      let sx0 = Infinity;
      let sx1 = -Infinity;
      for (let k = 0; k < px.length; k++) {
        const k2 = (k + 1) % px.length;
        if (py[k] >= ya && py[k] <= yb) {
          if (px[k] < sx0) sx0 = px[k];
          if (px[k] > sx1) sx1 = px[k];
        }
        for (let side = 0; side < 2; side++) {
          const yl = side ? yb : ya;
          const da = py[k] - yl;
          const db = py[k2] - yl;
          if (da * db > 0 || da === db) continue;
          const xi = px[k] + ((px[k2] - px[k]) * da) / (da - db);
          if (xi < sx0) sx0 = xi;
          if (xi > sx1) sx1 = xi;
        }
      }
      if (sx1 < sx0) continue;
      const xa = Math.floor(a.x + sx0) - reach;
      const xb = Math.ceil(a.x + sx1) + reach;
      for (let x = xa; x <= xb; x++) {
        const p = row + wrap(x, w);
        // Already inside another stone's outline: it cannot be inside this
        // one too (the joint lies between them).
        if (inside[p] > 0) continue;
        let qx = x + 0.5 - a.x;
        let qy = ly;
        if (warpX && warpY) {
          qx += warpX[p];
          qy += warpY[p];
        }
        // Signed distance to the core: inside, the nearest edge LINE;
        // outside, the nearest edge SEGMENT (which rounds the corners).
        let line = -1e9;
        for (let k = 0; k < edges; k++) {
          const o = k * 7;
          const e = (qx - edge[o]) * edge[o + 5] + (qy - edge[o + 1]) * edge[o + 6];
          if (e > line) line = e;
        }
        let dist = line;
        if (line > 0) {
          let best = 1e18;
          for (let k = 0; k < edges; k++) {
            const o = k * 7;
            const rx = qx - edge[o];
            const ry = qy - edge[o + 1];
            let t = rx * edge[o + 2] + ry * edge[o + 3];
            t = t < 0 ? 0 : t > edge[o + 4] ? edge[o + 4] : t;
            const ox = rx - edge[o + 2] * t;
            const oy = ry - edge[o + 3] * t;
            const d2 = ox * ox + oy * oy;
            if (d2 < best) best = d2;
          }
          dist = Math.sqrt(best);
        }
        const d = rr - dist;
        // Several stones visit a joint pixel; the nearest keeps it.
        if (d > inside[p]) {
          inside[p] = d;
          owner[p] = i;
        }
      }
    }
  }
  return { owner, inside };
}

function wrapDelta(d: number, n: number): number {
  if (d > n * 0.5) return d - n;
  if (d < -n * 0.5) return d + n;
  return d;
}

/** Bytes of one texel of a stone id map (see `stoneIdMap`). */
export const STONE_ID_NONE = 255;

/**
 * The stone id map of a tile, RGBA8, read by the shader with texelFetch
 * (never filtered):
 *   r, g  the stone's centre in 1/256ths of the tile — together with the
 *         repeat it sits in, a unique key per stone INSTANCE, and the place
 *         the shader evaluates per-stone noise at;
 *   b     the tone parameter the stone was painted with in the albedo
 *         (0..255 = t 0..1), so the shader can divide it out again;
 *   a     which neighbouring repeat the stone's centre lies in, as
 *         (dx + 1) + 3 * (dy + 1) — a stone that straddles the tile edge
 *         must hash to ONE tone on both sides of it. 255 = no stone.
 *
 * `centre` gives stone k's centre in pixels (any real number; it is wrapped
 * here), `tone` its t.
 */
export function stoneIdMap(w: number, h: number, owner: Int32Array, centreX: ArrayLike<number>, centreY: ArrayLike<number>, tone: ArrayLike<number>): Uint8Array {
  const count = tone.length;
  const cx = new Float64Array(count);
  const cy = new Float64Array(count);
  const bytes = new Uint8Array(count * 3);
  for (let k = 0; k < count; k++) {
    cx[k] = wrap(centreX[k], w);
    cy[k] = wrap(centreY[k], h);
    bytes[k * 3] = Math.min(255, Math.floor((cx[k] / w) * 256));
    bytes[k * 3 + 1] = Math.min(255, Math.floor((cy[k] / h) * 256));
    bytes[k * 3 + 2] = Math.round(Math.min(1, Math.max(0, tone[k])) * 255);
  }
  const out = new Uint8Array(w * h * 4);
  const halfW = w * 0.5;
  const halfH = h * 0.5;
  for (let y = 0, p = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, o += 4) {
      const k = owner[p];
      if (k < 0) {
        out[o + 3] = STONE_ID_NONE;
        continue;
      }
      // A pixel more than half a tile from the stone's centre is that
      // stone seen across the tile edge: its centre is one repeat over.
      const ox = x + 0.5 - cx[k];
      const oy = y + 0.5 - cy[k];
      const dx = ox > halfW ? -1 : ox < -halfW ? 1 : 0;
      const dy = oy > halfH ? -1 : oy < -halfH ? 1 : 0;
      out[o] = bytes[k * 3];
      out[o + 1] = bytes[k * 3 + 1];
      out[o + 2] = bytes[k * 3 + 2];
      out[o + 3] = dx + 1 + 3 * (dy + 1);
    }
  }
  return out;
}

/** Distance INSIDE a rounded rectangle centred on the origin (positive
 * inside, 0 on the outline). `hx`, `hy` = half sizes, `r` = corner radius. */
export function roundRectInside(px: number, py: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const outside = Math.sqrt(ox * ox + oy * oy);
  const inside = Math.min(Math.max(qx, qy), 0);
  return r - outside - inside;
}

/** Split `total` pixels into runs of random length in [min, max], scaled so
 * they close exactly on the tile edge. */
export function splitRun(total: number, min: number, max: number, rand: () => number): number[] {
  const runs: number[] = [];
  let sum = 0;
  while (sum < total - min * 0.5) {
    const len = min + (max - min) * rand();
    runs.push(len);
    sum += len;
  }
  const k = total / sum;
  return runs.map((len) => len * k);
}
