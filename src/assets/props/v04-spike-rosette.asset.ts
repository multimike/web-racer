import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, adjustOklch, clamp, loopNormal, mixOklab, paint } from '../../gfx/solid';
import type { Paint, RGB, Rng } from '../../gfx/solid';
import { FOLIAGE } from '../palette';
import type { PropAsset } from '../types';
import { farTuft } from './farKit';
import { FOLIAGE_AMP, fitSize, lean, succulentTones, sway, variant } from './nature';
import type { Variant } from './nature';

/**
 * V04 SPIKE ROSETTE — a dense blue-green succulent: thick ovate leaves with
 * a thin lime rim along both edges, standing in three tiers round a low
 * heart (vegetation/design-sheet.png, fourth column).
 *
 * Parts list, measured off the sheet (front = looking toward +z):
 *  - nine leaves, each a BROAD lens-shaped solid 38–42 cm across at its belly
 *    (four tenths of the way out), 0.55–0.78 m long, already 0.6 of that
 *    width at the root (the leaves overlap from the base: no ground shows in
 *    the middle seen from above) and ending in a blunt rounded point about
 *    an eighth of the width across;
 *  - top: a broad, slightly domed teal plane; a thin lime rim, a tenth of
 *    the width, runs along both edges and round the point; underside: flat,
 *    the same teal a step deeper;
 *  - INNER tier, two leaves: nearly upright, the taller one (up left on the
 *    sheet) is the 0.75 m summit;
 *  - MIDDLE tier, four leaves at 50–65°: the long one to the right rises
 *    straight, the one to the left arches over to level, the one toward the
 *    viewer curls right over and shows its whole top;
 *  - OUTER tier, three leaves lying low, tips on the way back to the ground —
 *    they make the 1.15 × 1.1 m footprint;
 *  - heart: no bud on the sheet, the middle is the nested young leaves; a
 *    low teal cone under the leaf roots only closes it from below.
 * Younger (inner) leaves are a step lighter, the outer ones the deep teal of
 * the palette.
 *
 * A leaf is ONE closed solid (`succulentLeaf`), root open under the ground:
 * 8 triangles a segment and 2 for the blunt end, 3–5 segments by how far it
 * bends (at most ~25° a segment). The rim is a chamfer of its own, so the
 * lime is a crisp band; the paint is smooth (crease 55°), so plateau and
 * chamfer shade as one rounded top and the segments as one arch.
 *
 * Variants change the HABIT — open rosette (the design, re-grown) / upright
 * agave / flat star / lax with tips curled to the ground — the leaf count
 * (7–10, set round the stem by the golden angle like a real rosette) and
 * leaf breadth, and the colour FORM: blue with a thin pale edge / jade with
 * a broad lime edge / soft mint with a cream-lime edge / deep sea-green
 * with a yellow edge, each shifted by the seed's mood.
 */

const ID = 'v04-spike-rosette';
const SIZE = { x: 1.15, y: 0.75, z: 1.1 };
const BUDGET = 350;
const SKIRT = 0.06;
const CORE_TRIS = 6;

interface Leaf {
  /** 0 inner (upright) · 1 middle · 2 outer (low). */
  tier: number;
  /** Compass heading, degrees (0 = +z, 90 = +x). */
  yaw: number;
  length: number;
  /** Elevation at the root, degrees. */
  lift: number;
  /** Total bend from root to tip, degrees. */
  droop: number;
  /** Widest width, meters. */
  width: number;
  /** Turn about its own length, degrees (so no two leaves present the same
   * plane to the light). */
  roll: number;
  /** 3–5, decided by `segment` from the budget. */
  segments: number;
}

// The hero, sheet front view: the viewer stands at yaw 180, so 270 is the
// sheet's left.
const HERO: Leaf[] = [
  { tier: 0, yaw: 318, length: 0.76, lift: 76, droop: 26, width: 0.35, roll: -8, segments: 3 }, // the summit, up left
  { tier: 0, yaw: 52, length: 0.68, lift: 72, droop: 24, width: 0.34, roll: 10, segments: 3 }, // its partner behind, right of centre
  { tier: 1, yaw: 92, length: 0.66, lift: 52, droop: 30, width: 0.4, roll: 10, segments: 3 }, // long, rising to the right
  { tier: 1, yaw: 256, length: 0.66, lift: 64, droop: 76, width: 0.4, roll: -8, segments: 3 }, // arching over to the left
  { tier: 1, yaw: 172, length: 0.54, lift: 64, droop: 118, width: 0.4, roll: 10, segments: 3 }, // curling over toward the viewer
  { tier: 1, yaw: 4, length: 0.62, lift: 54, droop: 46, width: 0.39, roll: -6, segments: 3 }, // the back
  { tier: 2, yaw: 296, length: 0.55, lift: 32, droop: 50, width: 0.4, roll: 6, segments: 3 }, // low left
  { tier: 2, yaw: 128, length: 0.58, lift: 32, droop: 56, width: 0.41, roll: -10, segments: 3 }, // low right
  { tier: 2, yaw: 214, length: 0.53, lift: 38, droop: 88, width: 0.41, roll: -6, segments: 3 }, // forward left, tip at the ground
];

interface Habit {
  /** Leaves per tier, [lo, hi] each. */
  count: [[number, number], [number, number], [number, number]];
  lift: [[number, number], [number, number], [number, number]];
  droop: [[number, number], [number, number], [number, number]];
  length: [[number, number], [number, number], [number, number]];
  width: [number, number];
  /** The habit's own proportions, as factors on the design's box. */
  box: [number, number, number];
}

const HABITS: Habit[] = [
  // Open rosette: the design, re-grown.
  {
    count: [[2, 2], [3, 4], [3, 3]],
    lift: [[68, 78], [50, 64], [28, 38]],
    droop: [[16, 30], [28, 110], [44, 88]],
    length: [[0.68, 0.78], [0.56, 0.68], [0.52, 0.58]],
    width: [0.38, 0.42],
    box: [1, 1, 1],
  },
  // Upright agave: everything stands, leaves longer and a little narrower —
  // still the same chunky leaf, blunt and broad.
  {
    count: [[3, 3], [3, 4], [2, 3]],
    lift: [[70, 76], [58, 66], [40, 48]],
    droop: [[14, 26], [20, 36], [26, 44]],
    length: [[0.78, 0.86], [0.7, 0.78], [0.54, 0.6]],
    width: [0.32, 0.36],
    box: [0.86, 1.12, 0.86],
  },
  // Flat star: a low wheel of broad leaves round a short tuft.
  {
    count: [[2, 2], [3, 3], [4, 4]],
    lift: [[62, 72], [34, 42], [14, 20]],
    droop: [[18, 30], [26, 42], [22, 38]],
    length: [[0.54, 0.6], [0.54, 0.6], [0.52, 0.58]],
    width: [0.39, 0.44],
    box: [1.12, 0.7, 1.12],
  },
  // Lax: every leaf arches over and brings its tip back down.
  {
    count: [[2, 2], [3, 3], [3, 4]],
    lift: [[72, 80], [58, 68], [36, 44]],
    droop: [[64, 88], [100, 126], [86, 106]],
    length: [[0.74, 0.82], [0.68, 0.76], [0.52, 0.6]],
    width: [0.35, 0.39],
    box: [0.98, 0.8, 0.98],
  },
];

/** Smallest heading gap between any two leaves, degrees. */
function minGap(yaws: readonly number[]): number {
  const s = yaws.map((y) => ((y % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = 360 - s[s.length - 1] + s[0];
  for (let i = 1; i < s.length; i++) gap = Math.min(gap, s[i] - s[i - 1]);
  return gap;
}

/** Headings for `n` leaves by the golden angle, inner leaves first — the
 * way a real rosette sets them, so no two tiers stack on one heading and no
 * wide sector stays empty. A little jitter, drawn until no two leaves are
 * closer than 25° (or the best of a dozen draws). */
function phyllotaxis(r: Rng, n: number): number[] {
  const start = r.range(0, 360);
  let best: number[] = [];
  let bestGap = -1;
  for (let attempt = 0; attempt < 12 && bestGap < 25; attempt++) {
    const yaws = Array.from({ length: n }, (_, i) => start + i * 137.5 + r.range(-10, 10));
    const gap = minGap(yaws);
    if (gap > bestGap) {
      best = yaws;
      bestGap = gap;
    }
  }
  return best;
}

function layout(v: Variant): { leaves: Leaf[]; box: [number, number, number] } {
  if (v.hero) return { leaves: segment(HERO.map((l) => ({ ...l }))), box: [1, 1, 1] };
  const r = v.fork('rosette').r;
  // Habits and colour forms (`CULTIVARS`) both come in fours: every fourth
  // seed the habit skips one, so the pairs do not repeat.
  const h = HABITS[(v.seed - 1 + Math.floor((v.seed - 1) / 4)) % HABITS.length];
  const counts = h.count.map(([lo, hi]) => r.int(lo, hi));
  const yaws = phyllotaxis(r, counts[0] + counts[1] + counts[2]);
  const leaves: Leaf[] = [];
  for (let tier = 0; tier < 3; tier++) {
    for (let k = 0; k < counts[tier]; k++) {
      leaves.push({
        tier,
        yaw: yaws[leaves.length],
        length: r.range(h.length[tier][0], h.length[tier][1]),
        lift: r.range(h.lift[tier][0], h.lift[tier][1]),
        droop: r.range(h.droop[tier][0], h.droop[tier][1]),
        width: r.range(h.width[0], h.width[1]) * (tier === 0 ? 0.88 : 1),
        roll: r.sign() * r.range(4, 12),
        segments: 3,
      });
    }
  }
  return { leaves: segment(leaves), box: h.box };
}

/** Triangles of one leaf (see `succulentLeaf`). */
const cost = (l: Leaf): number => l.segments * 8 + 2;

/** Every leaf gets three segments; what is left of the budget buys a fourth
 * and then a fifth for the leaves that bend most (a 110° curl over three
 * segments is a row of elbows). Outer leaves go first if a draw comes out
 * over the budget. */
function segment(all: Leaf[]): Leaf[] {
  let leaves = all;
  for (const l of leaves) l.segments = 3;
  const total = (): number => leaves.reduce((sum, l) => sum + cost(l), CORE_TRIS);
  while (total() > BUDGET) leaves = leaves.slice(0, -1);
  const byBend = [...leaves].sort((p, q) => q.droop - p.droop);
  for (const [segs, minDroop] of [[4, 0], [5, 50]] as const) {
    for (const l of byBend) {
      if (BUDGET - total() < 8) break;
      if (l.droop >= minDroop) l.segments = segs;
    }
  }
  return leaves;
}

/** A colour form of the species: where its teal sits, what its edge is and
 * how wide. Seeds walk through them in order. */
interface Cultivar {
  /** Shift of the leaf colour: OKLCH hue in degrees (+ = bluer), lightness,
   * chroma factor. */
  hue: number;
  light: number;
  chroma: number;
  /** Edge colour: 0 = the lime green of the design … 1 = yellow. */
  yellow: number;
  /** Edge paleness (lightness up, chroma down). */
  pale: number;
  /** Rim width, fraction of the half width. */
  chamfer: number;
  /** How much of the edge colour the leaf tops take on toward the tip. */
  fresh: number;
}

const CULTIVARS: Cultivar[] = [
  { hue: 0, light: 0, chroma: 1, yellow: 0, pale: 0, chamfer: 0.19, fresh: 0.1 }, // the design
  { hue: 18, light: -0.025, chroma: 1.05, yellow: 0.7, pale: 0.3, chamfer: 0.15, fresh: 0.06 }, // blue, a thin pale yellow edge
  { hue: -14, light: 0.03, chroma: 1.06, yellow: 0.1, pale: 0, chamfer: 0.25, fresh: 0.2 }, // jade green, a broad lime edge
  { hue: 8, light: 0.045, chroma: 0.92, yellow: 0.3, pale: 0.35, chamfer: 0.2, fresh: 0.12 }, // soft mint, a cream-lime edge
  { hue: -8, light: -0.06, chroma: 1.1, yellow: 0.6, pale: 0, chamfer: 0.22, fresh: 0.06 }, // deep sea-green, a strong yellow edge
];

// Where the stations sit along a leaf, by segment count.
const STATIONS: Record<number, number[]> = {
  3: [0, 0.36, 0.72, 1],
  4: [0, 0.27, 0.53, 0.78, 1],
  5: [0, 0.21, 0.42, 0.63, 0.83, 1],
};

/** Leaf outline at t = 0 (root) … 1 (tip), as a fraction of the widest
 * width: 0.6 at the root, widest at 0.4, then a convex, almost elliptic
 * taper to a blunt end 0.12 across. */
function outline(t: number): number {
  if (t < 0.4) return 0.6 + 0.4 * Math.sin((t / 0.4) * Math.PI * 0.5);
  const u = clamp((t - 0.4) / 0.6, 0, 1);
  return 0.12 + 0.88 * Math.pow(Math.cos(u * Math.PI * 0.5), 0.8);
}

/** The centre line of a leaf: leaves the root at `lift` and bends over by
 * `droop`, sampled at the given fractions of its length (integrated in fine
 * steps, so the curve does not depend on the station count). */
function arch(from: Vector3, l: Leaf, length: number, stations: readonly number[]): Vector3[] {
  const yaw = l.yaw * DEG;
  const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const STEPS = 60;
  const out: Vector3[] = [];
  let at = from.clone();
  let next = 0;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    while (next < stations.length && stations[next] <= t + 1e-9) {
      out.push(at.clone());
      next++;
    }
    // A power under 1.5 spreads the bend along the leaf: one continuous arch,
    // not a straight blade with a hook at the end.
    const pitch = (l.lift - l.droop * Math.pow(t + 0.5 / STEPS, 1.25)) * DEG;
    at = at.add(dir.scale((Math.cos(pitch) * length) / STEPS)).add(new Vector3(0, (Math.sin(pitch) * length) / STEPS, 0));
  }
  return out;
}

interface LeafColors {
  /** Plateau, root → tip, one per station: the left half a step lighter
   * than the right (the sheet's central fold reads as exactly this). */
  topL: RGB[];
  topR: RGB[];
  /** The rim, both edges and round the point. */
  edge: RGB[];
  under: RGB[];
}

/**
 * One succulent leaf as a closed solid along `path`. Per station, seen
 * along the leaf:
 *
 *        Sl ________ Sr          Sl–Sr  the teal top, a little domed
 *      L ´            ` R        L–Sl, Sr–R  the rim chamfers (lime)
 *        `------------´          L–R  the flat underside
 *
 * 8 triangles a segment, 2 for the blunt end (a lime quad round the point).
 * The root end is left open: it is under the ground.
 */
function succulentLeaf(m: SolidMesh, path: readonly Vector3[], widths: readonly number[], roll: number, chamfer: number, colors: LeafColors, p: Paint): void {
  const n = path.length;
  const wMax = Math.max(...widths) / 2;
  // Sideways = level and square to the way the leaf grows, so the top looks
  // at the middle of the plant while the leaf stands and at the sky once it
  // has bent over.
  const chord = path[n - 1].subtract(path[0]);
  const side0 = Vector3.Cross(new Vector3(0, 1, 0), chord).normalize();
  const a = roll * DEG;
  // Nothing digs deeper than the skirt (a low leaf's root would).
  const floor = (q: Vector3): Vector3 => (q.y < -SKIRT ? new Vector3(q.x, -SKIRT, q.z) : q);
  const st = path.map((q, k) => {
    const tan = path[Math.min(n - 1, k + 1)].subtract(path[Math.max(0, k - 1)]).normalize();
    let side = side0.subtract(tan.scale(Vector3.Dot(side0, tan))).normalize();
    let up = Vector3.Cross(tan, side);
    [side, up] = [side.scale(Math.cos(a)).add(up.scale(Math.sin(a))), up.scale(Math.cos(a)).subtract(side.scale(Math.sin(a)))];
    const w = widths[k] / 2;
    // The rim keeps its width in meters along the leaf and so takes over
    // the narrow point: the lime runs round the end.
    const ch = Math.min(0.42, (chamfer * wMax) / Math.max(w, 1e-4));
    // Thickness: about 3 cm in the belly (a rim chamfer of ~35°), thinning
    // slower than the width so the point stays a chunky end.
    const rise = 0.14 * wMax * Math.pow(w / wMax, 0.5);
    const shoulder = (sign: number): Vector3 => q.add(side.scale(sign * w * (1 - ch))).add(up.scale(rise));
    return {
      L: floor(q.subtract(side.scale(w))),
      R: floor(q.add(side.scale(w))),
      Sl: floor(shoulder(-1)),
      Sr: floor(shoulder(1)),
      up,
      side,
      tan,
    };
  });
  type Station = (typeof st)[number];
  type Rail = 'L' | 'R' | 'Sl' | 'Sr';
  /** One long strip between two rails; `out` = roughly where it faces. */
  const strip = (A: Rail, B: Rail, colA: RGB[], colB: RGB[], out: (q: Station) => Vector3): void => {
    for (let k = 0; k < n - 1; k++) {
      const i = st[k];
      const j = st[k + 1];
      const pts = [i[A], i[B], j[B], j[A]];
      const cols = [colA[k], colB[k], colB[k + 1], colA[k + 1]];
      if (Vector3.Dot(loopNormal(pts), out(i).add(out(j))) < 0) {
        pts.reverse();
        cols.reverse();
      }
      m.quad(pts[0], pts[1], pts[2], pts[3], p, cols);
    }
  };
  const { topL, topR, edge, under } = colors;
  strip('L', 'Sl', edge, edge, (q) => q.up.subtract(q.side));
  strip('Sl', 'Sr', topL, topR, (q) => q.up);
  strip('Sr', 'R', edge, edge, (q) => q.up.add(q.side));
  strip('R', 'L', under, under, (q) => q.up.scale(-1));
  // The blunt end.
  const e = st[n - 1];
  const end = [e.L, e.Sl, e.Sr, e.R];
  if (Vector3.Dot(loopNormal(end), e.tan) < 0) end.reverse();
  const c = edge[n - 1];
  m.quad(end[0], end[1], end[2], end[3], p, [c, c, c, c]);
}

/** The heart under the leaf roots: a low six-sided cone, its foot in the
 * ground. It only closes the middle from below; the young leaves are the
 * centre you see. 6 triangles. */
function core(m: SolidMesh, radius: number, height: number, turn: number, color: RGB): void {
  const p = paint(color, { gloss: 0.35, smooth: 70 });
  const apex = new Vector3(0, height, 0);
  for (let k = 0; k < 6; k++) {
    const a0 = (turn + k * 60) * DEG;
    const a1 = (turn + (k + 1) * 60) * DEG;
    const p0 = new Vector3(Math.sin(a0) * radius, -SKIRT, Math.cos(a0) * radius);
    const p1 = new Vector3(Math.sin(a1) * radius, -SKIRT, Math.cos(a1) * radius);
    // Compass angles run clockwise seen from above: p0 → p1 → apex is
    // counter-clockwise seen from outside.
    m.tri(p0, p1, apex, p);
  }
}

function construct(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const plan = layout(v);
  const leaves = plan.leaves;

  const look = v.fork('look');
  const form = v.hero ? CULTIVARS[0] : CULTIVARS[1 + ((seed - 1) % (CULTIVARS.length - 1))];
  const tones = succulentTones(v);
  const base = adjustOklch(tones.base, form.light, form.chroma, form.hue);
  // Underside: one even teal, a third of the way to the palette's shade
  // tone and a hue step bluer — the shader does the dark (palette.ts).
  const under = adjustOklch(mixOklab(base, adjustOklch(tones.under, form.light, form.chroma, form.hue), 0.6), 0, 1, 8);
  // The palette's edge colour goes lemon under the warm sun; the sheet's
  // rim is a lime GREEN. Half way to the foliage lime and a small hue step
  // holds it there (≈ #B4E61E lit).
  const lime = adjustOklch(mixOklab(tones.edge, v.tint(FOLIAGE.lime, FOLIAGE_AMP), 0.5), 0, 1.04, 4);
  const edge = adjustOklch(mixOklab(lime, FOLIAGE.highlight, form.yellow), form.pale * 0.07, 1 - form.pale * 0.42);
  // Toward the tip the top lightens (and takes a touch of the rim colour);
  // it stays teal right up to the rim.
  const tipTop = adjustOklch(mixOklab(base, edge, form.fresh), 0.035, 1, 0);
  const chamfer = form.chamfer + look.num(0, 0.025);
  const LEAF = paint(base, { gloss: 0.4, smooth: 55 });

  const m = new SolidMesh();
  core(m, 0.13, 0.04, look.range(15, 0, 60), under);
  leaves.forEach((l) => {
    const a = l.yaw * DEG;
    // Upright leaves root in the middle, low ones a little way out.
    const out = [0.02, 0.04, 0.06][l.tier];
    const stations = STATIONS[l.segments];
    const path = arch(new Vector3(Math.sin(a) * out, -SKIRT, Math.cos(a) * out), l, l.length + SKIRT, stations);
    // Young inner leaves are lighter, the outer ones deep teal.
    const age = [0.03, 0.0, -0.025][l.tier] + look.r.range(-0.012, 0.012);
    const own = (c: RGB): RGB => adjustOklch(c, age, 1, -age * 60);
    const topR = stations.map((t) => own(mixOklab(base, tipTop, Math.pow(t, 1.2))));
    succulentLeaf(
      m,
      path,
      stations.map((t) => l.width * outline(t)),
      l.roll,
      chamfer,
      {
        topL: topR.map((c) => adjustOklch(c, 0.025, 1, -3)),
        topR,
        // The rim starts in the leaf's own teal at the root and is pure edge
        // colour from a quarter of the way out.
        edge: stations.map((t) => mixOklab(own(base), edge, clamp(t * 4.5, 0, 1))),
        under: stations.map(() => own(under)),
      },
      LEAF,
    );
  });
  if (!v.hero) lean(m, look.r.range(0, 5), look.r.range(0, 360));
  // Size: the habit's box times one draw for the whole plant. The footprint
  // keeps the proportions it grew with (a plant with one long leaf is longer
  // that way) and is scaled as a whole to the box's area; only the hero is
  // put on the design's box exactly.
  const k = v.hero ? 1 : look.r.range(0.93, 1.07);
  const want = (axis: number, size: number): number => size * plan.box[axis] * k;
  const grown = m.bounds();
  const gx = grown.max.x - grown.min.x;
  const gz = grown.max.z - grown.min.z;
  const plane = v.hero ? 1 : Math.sqrt((want(0, SIZE.x) * want(2, SIZE.z)) / (gx * gz));
  fitSize(m, {
    x: v.hero ? SIZE.x : clamp(gx * plane, SIZE.x * 0.76, SIZE.x * 1.24),
    y: clamp(want(1, SIZE.y), SIZE.y * 0.74, SIZE.y * 1.16),
    z: v.hero ? SIZE.z : clamp(gz * plane, SIZE.z * 0.76, SIZE.z * 1.24),
  });
  // Heavy leaves: a third of what grass of this height would move.
  sway(m, { from: 0.1, max: 0.07, power: 1.6 });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Spike Rosette',
  category: 'vegetation',
  size: SIZE,
  variants: 5,
  build: construct,
  // Far tier: a rosette read off this very plant (tips where it reaches,
  // lobes in its own colours; flowers as a cap) — see `farTuft`.
  buildFar: (seed, _scheme, target) => farTuft(construct(seed), target),
  wind: true,
  triBudget: BUDGET,
  reference: {
    sheet: 'design-documents/environment-design-pack/vegetation/design-sheet.png',
    brief: 'design-documents/environment-design-pack/vegetation/v04-spike-rosette-brief.txt',
  },
};

export default asset;
