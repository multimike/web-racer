import { SUN_DIR } from '../../terrain/generateTerrain';

/**
 * The world's backdrop as plain data (Babylon-free, deterministic per seed):
 * three rings of low faceted hills beyond the terrain rim — what closes the
 * vision's first image instead of a pine wall under a flat band of sky. The
 * clouds are the look's sky dome's (this module has no faceted puffs of
 * its own: two cloud styles in one sky).
 *
 * Every number is authored as an ELEVATION ANGLE seen from the world centre,
 * because what matters is where a crest sits in the chase frame:
 *  - the pine rim (terrain rim + tree tops) stands at about 5–9° from the
 *    start grid and up to ~19° from corners near the rim (measured);
 *  - the chase camera's frame top is at about +10.6° (pitch −12.3°, vertical
 *    fov 0.8 rad).
 * So the crests climb from ~5° (nearest ring) to ~10.4° (farthest): above
 * the rim from the grid and across the infield, layered like the vision's
 * hills, and still leaving a strip of sky with clouds at the top of the frame
 * (first pictures with crests up to 12.6° filled the frame to its top edge).
 * The two nearer rings carry a band of dark rounded tree clumps on their
 * crest (scalloped silhouette, like the vision's wooded ridges), and the
 * slope rows are staggered and jittered in azimuth so the facets do not line
 * up into vertical panel seams.
 *
 * Geometry stays OUTSIDE the 200 × 200 m terrain square: its corner is
 * 141.4 m from the centre and the nearest hill foot ~142 m (ring radius 185
 * − 8 m wobble − 35 m foot), so on the diagonal the margin is under a metre —
 * but the foot is 14 m BELOW y = 0, under the terrain rim, so it can never
 * intersect the ground or show under it. Everything is within ~390 m of the centre: inside the follow cameras'
 * 600 m far plane from anywhere a car can be (cars are put back beyond
 * ~97 m from the centre).
 *
 * Shading is BAKED per facet (the sun direction is the world's fixed
 * SUN_DIR): a lit / shade two-tone with seeded meadow, forest and rock
 * patches. The vertex alpha carries the aerial-perspective amount the
 * material mixes toward the horizon colour (lighter and bluer per ring) —
 * the backdrop is NOT fogged by the scene's EXP2 fog, which at these
 * distances would erase it completely.
 */

export interface BackdropGeometry {
  /** xyz per vertex (flat shaded: three own vertices per triangle). */
  positions: Float32Array;
  /** rgba per vertex: rgb = display-space colour, a = aerial amount 0..1. */
  colors: Float32Array;
  triangles: number;
  /** Of them, the crest tree clumps. */
  treeTriangles: number;
}

interface Ring {
  /** Crest radius from the world centre, m. */
  radius: number;
  /** Crest elevation range seen from the centre (y = 0), degrees. */
  elevMin: number;
  elevMax: number;
  segments: number;
  /** Aerial perspective at the crest / at the foot. */
  aerial: number;
  aerialFoot: number;
  /** Lit / shade colours (display space) and patch colours. */
  lit: RGB;
  shade: RGB;
  meadow: RGB;
  forest: RGB;
  rock: RGB;
  /** Crest tree clumps: share of the crest that is wooded (0 = none) and
   * their dark / lit colours. */
  woods: number;
  tree: RGB;
  treeLit: RGB;
}

type RGB = [number, number, number];

/** Rows of a ring's front slope: (fraction of the way from the foot to the
 * crest radius, fraction of the crest height). The foot is 35 m in front of
 * the crest and 14 m BELOW y = 0 (under the terrain rim, which stands 8–18 m
 * above the road). The back slope is never seen from inside the world. */
const ROWS: readonly (readonly [number, number])[] = [
  [0, -14],
  [0.35, 0.22],
  [0.6, 0.52],
  [0.8, 0.78],
  [0.93, 0.94],
  [1, 1],
];
const FOOT_IN = 35;

export const BACKDROP_RINGS: readonly Ring[] = [
  {
    radius: 185,
    elevMin: 5.2,
    elevMax: 8.6,
    segments: 96,
    aerial: 0.22,
    aerialFoot: 0.34,
    lit: [0.5, 0.7, 0.3],
    shade: [0.24, 0.46, 0.36],
    meadow: [0.66, 0.76, 0.34],
    forest: [0.2, 0.42, 0.28],
    rock: [0.6, 0.56, 0.7],
    woods: 0.6,
    tree: [0.1, 0.27, 0.2],
    treeLit: [0.2, 0.4, 0.22],
  },
  {
    radius: 265,
    elevMin: 6.8,
    elevMax: 9.6,
    segments: 108,
    aerial: 0.32,
    aerialFoot: 0.42,
    lit: [0.47, 0.66, 0.36],
    shade: [0.27, 0.46, 0.44],
    meadow: [0.6, 0.72, 0.4],
    forest: [0.24, 0.44, 0.36],
    rock: [0.58, 0.56, 0.72],
    woods: 0.5,
    tree: [0.15, 0.31, 0.3],
    treeLit: [0.24, 0.42, 0.32],
  },
  {
    radius: 365,
    elevMin: 8,
    elevMax: 10.4,
    segments: 120,
    // Less haze and a deeper, greener tone (was aerial 0.6 / 0.68,
    // lit 0.46,0.62,0.46; the middle ring 0.44 / 0.54, the nearest 0.26 /
    // 0.38): the farthest ring was close to the sky colour.
    aerial: 0.38,
    aerialFoot: 0.48,
    lit: [0.42, 0.6, 0.4],
    shade: [0.27, 0.42, 0.5],
    meadow: [0.54, 0.68, 0.44],
    forest: [0.24, 0.42, 0.42],
    rock: [0.56, 0.58, 0.74],
    woods: 0,
    tree: [0, 0, 0],
    treeLit: [0, 0, 0],
  },
];

/** Azimuth offset of each slope row, in segments (staggered rows: no
 * vertical seams), and the seeded jitter on top of it (inner rows only). */
const ROW_OFFSET: readonly number[] = [0, 0.5, 0.1, 0.6, 0.25, 0];
const AZ_JITTER = 0.22;
/** Per-triangle value jitter (± share) — facets read as broken ground. */
const FACET_JITTER = 0.09;
/** Field patches on the slopes (the vision's hills are a patchwork of
 * lighter and darker fields): blocks of FIELD_LEN segments (2–4, per row)
 * on the middle rows, a share lighter (mown / yellow-green) and a share
 * darker (hedged / wooded), value × FIELD_LIGHT / FIELD_DARK. Darker
 * fields go a deeper GREEN, not bluer: × 0.58 with extra blue came out of
 * the haze as slate slabs that read as roofing. */
const FIELD_LIGHT = 1.35;
const FIELD_DARK = 0.7;
const FIELD_LIGHT_SHARE = 0.24;
const FIELD_DARK_SHARE = 0.22;

/** Deterministic hash of three integers → 0..1 (point jitter that closes the
 * ring: segment `segs` hashes like segment 0). */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth periodic function of the azimuth in 0..1: a few seeded sines
 * (wavelengths of 1/2 … 1/11 of the circle), so a ring closes seamlessly. */
function periodic(rand: () => number, terms: number, minK: number, maxK: number): (theta: number) => number {
  const k: number[] = [];
  const amp: number[] = [];
  const phase: number[] = [];
  let sum = 0;
  for (let i = 0; i < terms; i++) {
    k.push(minK + Math.floor(rand() * (maxK - minK + 1)));
    const a = 1 / (1 + i * 0.6);
    amp.push(a);
    phase.push(rand() * Math.PI * 2);
    sum += a;
  }
  return (theta) => {
    let v = 0;
    for (let i = 0; i < terms; i++) v += amp[i] * Math.sin(k[i] * theta + phase[i]);
    return 0.5 + (0.5 * v) / sum;
  };
}

/** Crest height of ring `index` at azimuth `theta` (rad), m above y = 0 —
 * exported for the probes that check the crests against the pine rim. */
export function backdropCrest(seed: number, index: number): (theta: number) => { radius: number; height: number } {
  const ring = BACKDROP_RINGS[index];
  const rand = mulberry32(((seed * 2654435761) ^ (index * 40503 + 17)) >>> 0);
  const shape = periodic(rand, 6, 2, 11);
  const wobble = periodic(rand, 3, 3, 9);
  return (theta) => {
    // Peakier than the raw sum: broad shoulders, a few clear summits.
    const s = shape(theta);
    const e = ring.elevMin + (ring.elevMax - ring.elevMin) * s * s * (3 - 2 * s);
    const radius = ring.radius + 16 * (wobble(theta) - 0.5);
    return { radius, height: radius * Math.tan((e * Math.PI) / 180) };
  };
}

class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  tri(a: number[], b: number[], c: number[], rgb: RGB, aerial: [number, number, number]): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    // Clamped: field patches and facet jitter can lift a light colour past 1.
    const r = Math.min(1, Math.max(0, rgb[0])), g = Math.min(1, Math.max(0, rgb[1])), bl = Math.min(1, Math.max(0, rgb[2]));
    for (let i = 0; i < 3; i++) this.col.push(r, g, bl, aerial[i]);
  }
}

function faceNormal(a: number[], b: number[], c: number[]): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Two-tone sun shading of one facet (normal toward the viewer side). */
function shadeFacet(n: [number, number, number], lit: RGB, shade: RGB): RGB {
  const ndl = n[0] * SUN_DIR.x + n[1] * SUN_DIR.y + n[2] * SUN_DIR.z;
  return mixRGB(shade, lit, smooth(0.05, 0.4, ndl));
}

function addRing(b: Builder, seed: number, index: number): void {
  const ring = BACKDROP_RINGS[index];
  const crest = backdropCrest(seed, index);
  const rand = mulberry32(((seed * 7919) ^ (index * 104729 + 3)) >>> 0);
  // Patches: smooth in azimuth, so meadows and forests are contiguous areas
  // across several facets rather than per-facet confetti.
  const meadowField = periodic(rand, 4, 5, 17);
  const forestField = periodic(rand, 4, 6, 19);
  const segs = ring.segments;
  const rows = ROWS.length;
  // Grid of points: [seg][row] = [x, y, z].
  const grid: number[][][] = [];
  for (let s = 0; s <= segs; s++) {
    const col: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const [f, h] = ROWS[r];
      // Staggered, jittered azimuth (crest row exact: the tree band sits on
      // it); hashed per point so the ring closes.
      const inner = r > 0 && r < rows - 1;
      const sk = s % segs;
      const az = sk + ROW_OFFSET[r] + (inner ? (hash01(seed, index * 16 + r, sk) - 0.5) * 2 * AZ_JITTER : 0);
      const theta = (az / segs) * Math.PI * 2;
      const c = crest(theta);
      const rad = c.radius - FOOT_IN * (1 - f);
      // Small seeded height jitter inside the slope (not on the crest or the
      // foot) breaks the rows into irregular facets.
      const j = inner ? (hash01(seed + 1, index * 16 + r, sk) - 0.5) * 0.08 : 0;
      const y = r === 0 ? h : c.height * (h + j);
      col.push([Math.sin(theta) * rad, y, Math.cos(theta) * rad]);
    }
    grid.push(col);
  }
  for (let s = 0; s < segs; s++) {
    const theta = ((s + 0.5) / segs) * Math.PI * 2;
    const meadow = meadowField(theta);
    const forest = forestField(theta);
    for (let r = 0; r < rows - 1; r++) {
      const a = grid[s][r], bb = grid[s + 1][r], c = grid[s + 1][r + 1], d = grid[s][r + 1];
      const upper = (r + 1) / (rows - 1);
      // Patch colour of this quad: meadow (lighter), forest (darker), the odd
      // lavender rock near the crest.
      let lit = ring.lit;
      let shade = ring.shade;
      const pick = rand();
      if (upper > 0.7 && pick < 0.07) {
        lit = ring.rock;
        shade = mixRGB(ring.rock, ring.shade, 0.45);
      } else if (meadow > 0.62 + 0.1 * (pick - 0.5)) {
        lit = ring.meadow;
        shade = mixRGB(ring.meadow, ring.shade, 0.55);
      } else if (forest > 0.6 + 0.1 * (pick - 0.5)) {
        lit = ring.forest;
        shade = mixRGB(ring.forest, ring.shade, 0.5);
      }
      // Field patch of this quad's block (middle rows only: the foot is
      // hidden, the crest carries the woods).
      if (r >= 1 && r <= rows - 3) {
        const len = 2 + Math.floor(hash01(seed + 5, index * 16 + r, 0) * 3);
        const block = Math.floor((s + Math.floor(hash01(seed + 6, index * 16 + r, 1) * len)) / len);
        const f = hash01(seed + 7, index * 4096 + block, r);
        const m = f < FIELD_LIGHT_SHARE ? FIELD_LIGHT : f > 1 - FIELD_DARK_SHARE ? FIELD_DARK : 1;
        if (m !== 1) {
          // Lighter fields also go a touch yellow, darker ones a deeper green.
          lit = m > 1 ? [Math.min(1, lit[0] * m * 1.06), Math.min(1, lit[1] * m), lit[2] * m * 0.85] : [lit[0] * m * 0.85, lit[1] * m, lit[2] * m * 0.8];
          shade = m > 1 ? [shade[0] * m * 1.04, shade[1] * m, shade[2] * m * 0.9] : [shade[0] * m * 0.88, shade[1] * m, shade[2] * m * 0.85];
        }
      }
      const af = (y: number, maxY: number): number => ring.aerialFoot + (ring.aerial - ring.aerialFoot) * Math.min(1, Math.max(0, y / Math.max(1, maxY)));
      const maxY = Math.max(c[1], d[1]);
      // Two triangles, wound so the face points toward the world centre
      // (Babylon's default orientation is clockwise-front: see the header of src/gfx/solid/SolidMesh.ts).
      for (const [p, q, w] of [[a, d, c], [a, c, bb]] as const) {
        const n = faceNormal(p, q, w);
        // Normal toward the centre for the shading (the winding is chosen
        // for Babylon's front face, which may be the opposite sense).
        const toward = n[0] * -p[0] + n[2] * -p[2] > 0 ? n : ([-n[0], -n[1], -n[2]] as [number, number, number]);
        const k = 1 + (hash01(seed + 2, index * 4096 + s, r * 2 + (p === a && q === d ? 0 : 1)) - 0.5) * 2 * FACET_JITTER;
        const base = shadeFacet(toward, lit, shade);
        const rgb: RGB = [base[0] * k, base[1] * k, base[2] * k];
        b.tri(p as number[], q as number[], w as number[], rgb, [af(p[1], maxY), af(q[1], maxY), af(w[1], maxY)]);
      }
    }
  }
  if (ring.woods > 0) addCrestTrees(b, seed, index, grid.map((col) => col[rows - 1]));
}

/** Crest woods (an even row of equal half-discs read as a hedge). A clump's width is CLUMP_WIDTH × half a crest segment (±40 %),
 * its height a share of its width; the next clump starts CLUMP_STEP of the
 * width further on (overlaps of different depth); now and then a GAP of
 * open crest; outside the woods, the odd LONE tree (narrow, tall). */
const CLUMP_WIDTH: readonly [number, number] = [0.6, 1.4];
const CLUMP_RISE: readonly [number, number] = [0.3, 0.6];
const CLUMP_STEP: readonly [number, number] = [0.55, 0.95];
const CLUMP_GAP = 0.1;
const LONE_TREES = 0.05;
/** Arc points per clump (a rounded top: CLUMP_ARC triangles). */
const CLUMP_ARC = 4;
const LONE_ARC = 3;

/**
 * Dark rounded tree clumps standing on a ring's crest line where its seeded
 * woods field is on: each a fan of triangles over a half-ellipse of seeded
 * width and height, walked along the crest with seeded overlaps and gaps, so
 * the wooded skyline is irregular like the vision's hills; single trees dot
 * the open crest. Shaded lit / dark by the side the sun is on, with the
 * ring's crest aerial amount.
 */
function addCrestTrees(b: Builder, seed: number, index: number, crestPts: number[][]): void {
  const ring = BACKDROP_RINGS[index];
  const rand = mulberry32(((seed * 6007) ^ (index * 92821 + 11)) >>> 0);
  const woods = periodic(rand, 4, 4, 15);
  const segs = crestPts.length - 1;
  const air: [number, number, number] = [ring.aerial, ring.aerial, ring.aerial];
  const at = (u: number): number[] => {
    const w = ((u % segs) + segs) % segs;
    const i = Math.floor(w);
    const t = w - i;
    const A = crestPts[i];
    const B = crestPts[i + 1];
    return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
  };
  const clump = (u0: number, u1: number, riseShare: number, arcN: number, n: number): void => {
    const p0 = at(u0);
    const p1 = at(u1);
    const w = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
    const rise = w * riseShare;
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
    const arc: number[][] = [];
    for (let i = 0; i <= arcN; i++) {
      const a = Math.PI * (i / arcN);
      const u = 0.5 - 0.5 * Math.cos(a); // 0 → 1 along the base
      const x = mid[0] + (p0[0] - mid[0]) * (1 - 2 * u);
      const z = mid[2] + (p0[2] - mid[2]) * (1 - 2 * u);
      arc.push([x, mid[1] + Math.sin(a) * rise - (i === 0 || i === arcN ? rise * 0.25 : 0), z]);
    }
    // Sun side: the clump's sunward half is a little lighter.
    const sunAlong = (p1[0] - p0[0]) * SUN_DIR.x + (p1[2] - p0[2]) * SUN_DIR.z;
    for (let i = 0; i < arcN; i++) {
      const half = i < arcN / 2 ? -1 : 1; // toward p0 / toward p1
      const lit = half * sunAlong > 0 ? 0.55 : 0.1;
      const k = 1 + (hash01(seed + 4, index * 65536 + n, i) - 0.5) * 2 * FACET_JITTER;
      const base = mixRGB(ring.tree, ring.treeLit, lit);
      b.tri(mid, arc[i], arc[i + 1], [base[0] * k, base[1] * k, base[2] * k], air);
    }
  };
  let u = 0;
  let n = 0;
  while (u < segs) {
    const h = (k: number): number => hash01(seed + 3, index * 65536 + n, k);
    const width = 0.5 * (CLUMP_WIDTH[0] + (CLUMP_WIDTH[1] - CLUMP_WIDTH[0]) * h(0));
    const inWoods = woods(((u + width / 2) / segs) * Math.PI * 2) <= ring.woods;
    if (inWoods) {
      if (h(1) < CLUMP_GAP) {
        u += width * (0.6 + h(2));
      } else {
        clump(u, u + width, CLUMP_RISE[0] + (CLUMP_RISE[1] - CLUMP_RISE[0]) * h(3), CLUMP_ARC, n);
        u += width * (CLUMP_STEP[0] + (CLUMP_STEP[1] - CLUMP_STEP[0]) * h(4));
      }
    } else {
      if (h(1) < LONE_TREES) clump(u, u + width * 0.4, 0.9 + 0.5 * h(3), LONE_ARC, n);
      u += width;
    }
    n++;
  }
}

/** The whole backdrop for a world seed. */
export function buildBackdrop(seed: number): BackdropGeometry {
  const b = new Builder();
  let treeTriangles = 0;
  for (let i = 0; i < BACKDROP_RINGS.length; i++) {
    const before = b.pos.length / 9;
    addRing(b, seed, i);
    const segs = BACKDROP_RINGS[i].segments;
    treeTriangles += b.pos.length / 9 - before - segs * (ROWS.length - 1) * 2;
  }
  return {
    positions: new Float32Array(b.pos),
    colors: new Float32Array(b.col),
    triangles: b.pos.length / 9,
    treeTriangles,
  };
}
