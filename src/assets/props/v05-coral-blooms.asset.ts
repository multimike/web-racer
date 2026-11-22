import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, adjustOklch, anyPerpendicular, clamp, hex, loopNormal, mixOklab, paint, quadraticBezierPath } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FLOWERS, FOLIAGE } from '../palette';
import type { PropAsset } from '../types';
import { farTuft } from './farKit';
import { FLOWER_AMP, FOLIAGE_AMP, fitPoint, fitSize, limb, variant } from './nature';
import type { Variant } from './nature';

/**
 * V05 CORAL BLOOMS — three bold coral flowers on stout green stems over a
 * mound of broad arching leaves (vegetation/design-sheet.png, last column).
 *
 * Parts list, measured off the sheet (front = looking toward +z):
 *  - three flower heads at staggered heights, each SIX round, puffy petals
 *    round a raised yellow button (the brief's resolution of the drawing's
 *    five). The big one stands in the middle, 0.38 m across, centre 0.4 m
 *    up; the two smaller ones (0.29 and 0.31 m) hang out left and right at
 *    0.25 m. The heads are huge for the plant: together as wide as the
 *    whole clump;
 *  - a petal is a soft pillow: an almost round outline (seven corners, the
 *    widest a little past the middle), a deep notch where it meets its
 *    neighbours, and a domed top about a quarter of the flower's radius
 *    high, so from the side it is a cushion, not a wafer;
 *  - the heads look up AND out: the sheet's front view shows them face-on,
 *    its top view too. Each head is tipped 34–42° off vertical, away from
 *    the middle and toward the front;
 *  - stems ~5 cm thick, one to each head, in a single bend from the root;
 *  - leaves: four broad ovate ones (23–25 cm across, 0.4–0.42 m long)
 *    leaving the root at about 70° and arching right over until the tips
 *    touch the ground — a mound that makes the 0.8 × 0.65 m footprint.
 *
 * Costs: a petal 12 triangles (7 on the dome, 5 under), a button 6, a stem
 * of two bands 16; a leaf 15. Three six-petal heads and four leaves = 342.
 * Petals, leaves, stems and the button are smooth toy shapes with crisp
 * outlines. The whole head gets ONE wind weight (the one of its centre):
 * "bend stems gently; keep each flower head coherent".
 *
 * Variants: the HABIT changes — trio (the design, re-grown) / a tall pair
 * with a bud / a posy of three small five-petalled heads and a bud / a spray
 * leaning to one side — with it the head sizes, stem heights and the
 * leaves; and the colour form: coral, pink, orange, deep red-coral or soft
 * peach petals, with the leaf green shifted by the seed's mood. Every habit
 * keeps the design's front (the heads look toward −z), and no two heads may
 * cut into each other (`separate`).
 */

const ID = 'v05-coral-blooms';
const SIZE = { x: 0.8, y: 0.55, z: 0.65 };
const BUDGET = 350;
const SKIRT = 0.05;
// Not in the palette: the orange a flower's yellow button deepens to.
const BUTTON_ORANGE = hex('#FFA92E');

interface Head {
  /** Centre of the flower. */
  at: [number, number, number];
  /** Tip of its axis off vertical, degrees, toward compass `toward`. */
  tilt: number;
  toward: number;
  /** Petal tip radius. */
  radius: number;
  petals: number;
  spin: number;
  /** A closed bud instead of an open flower (`radius` = its length). */
  bud?: boolean;
}

interface Leaf {
  /** Compass heading, degrees (0 = +z, 90 = +x). */
  yaw: number;
  length: number;
  /** Elevation at the root, degrees. */
  lift: number;
  /** Total bend from root to tip, degrees. */
  droop: number;
  /** Widest width, meters. */
  width: number;
  /** Turn about its own length, degrees. */
  roll: number;
}

// The hero, sheet front view: the viewer stands at yaw 180, so 270 is the
// sheet's left and −z is toward the viewer.
const HERO_HEADS: Head[] = [
  { at: [-0.02, 0.4, 0.03], tilt: 32, toward: 184, radius: 0.19, petals: 6, spin: 30 }, // the big one, middle
  { at: [-0.25, 0.25, -0.08], tilt: 40, toward: 220, radius: 0.145, petals: 6, spin: 8 }, // left
  { at: [0.21, 0.255, -0.06], tilt: 40, toward: 144, radius: 0.155, petals: 6, spin: 22 }, // right
];
const HERO_LEAVES: Leaf[] = [
  { yaw: 214, length: 0.4, lift: 74, droop: 156, width: 0.25, roll: 6 }, // front left, tip at the ground
  { yaw: 148, length: 0.41, lift: 72, droop: 150, width: 0.25, roll: -6 }, // front right
  { yaw: 286, length: 0.42, lift: 70, droop: 140, width: 0.23, roll: -5 }, // left, behind the left head
  { yaw: 60, length: 0.42, lift: 70, droop: 138, width: 0.23, roll: 5 }, // back right
];

interface Plan {
  heads: Head[];
  leaves: Leaf[];
  /** Sides of the stems' section. */
  stemSides: number;
  /** The habit's own proportions, as factors on the design's box. */
  box: [number, number, number];
}

const axisOf = (h: Head): Vector3 => {
  const t = h.tilt * DEG;
  return new Vector3(Math.sin(h.toward * DEG) * Math.sin(t), Math.cos(t), Math.cos(h.toward * DEG) * Math.sin(t));
};

/** Push heads apart (sideways) until no two are closer than the sum of
 * their radii — unless one sits ≥ 12 cm further along the other's axis,
 * i.e. clearly above its face, which a spray is allowed to do. */
function separate(heads: Head[]): void {
  const reach = (h: Head): number => (h.bud ? h.radius * 0.4 : h.radius);
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        const a = heads[i];
        const b = heads[j];
        const d = new Vector3(b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]);
        const need = reach(a) + reach(b);
        const dist = d.length();
        if (dist >= need) continue;
        if (Math.abs(Vector3.Dot(d, axisOf(a))) >= 0.12 || Math.abs(Vector3.Dot(d, axisOf(b))) >= 0.12) continue;
        const flat = new Vector3(d.x, 0, d.z);
        const dir = flat.length() > 1e-4 ? flat.normalize() : new Vector3(1, 0, 0);
        const push = (need - dist) * 0.5 + 0.004;
        a.at = [a.at[0] - dir.x * push, a.at[1], a.at[2] - dir.z * push];
        b.at = [b.at[0] + dir.x * push, b.at[1], b.at[2] + dir.z * push];
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function layout(v: Variant): Plan {
  if (v.hero) return { heads: HERO_HEADS, leaves: HERO_LEAVES, stemSides: 4, box: [1, 1, 1] };
  const r = v.fork('clump').r;
  // Habits and colour forms (`FORMS`) both come in fours: every fourth seed
  // the habit skips one, so the pairs do not repeat.
  const habit = (v.seed - 1 + Math.floor((v.seed - 1) / 4)) % 4;
  // The design's front is −z (compass 180): every habit keeps its faces
  // that way, so the clump has a front like the hero.
  const front = 180 + r.range(-30, 30);
  const heads: Head[] = [];
  const head = (az: number, out: number, y: number, radius: number, petals: number, tilt: number, toward: number): void => {
    heads.push({ at: [Math.sin(az * DEG) * out, y * 0.93, Math.cos(az * DEG) * out], tilt, toward, radius, petals, spin: r.range(0, 60) });
  };
  const bud = (az: number, out: number, y: number): void => {
    heads.push({ at: [Math.sin(az * DEG) * out, y, Math.cos(az * DEG) * out], tilt: r.range(8, 18), toward: az, radius: r.range(0.1, 0.12), petals: 0, spin: 0, bud: true });
  };
  let box: [number, number, number] = [1, 1, 1];
  let maxLeaves = 4;
  if (habit === 0) {
    // Trio: one tall head a little behind the middle, two lower ones out
    // left and right, all looking out over the front.
    head(front + 180 + r.range(-40, 40), r.range(0, 0.05), r.range(0.4, 0.45), r.range(0.175, 0.195), 6, r.range(30, 40), front + r.range(-12, 12));
    const gap = r.range(64, 84);
    const left = front + gap;
    const right = front - r.range(64, 84);
    head(left, r.range(0.22, 0.27), r.range(0.24, 0.3), r.range(0.135, 0.16), 6, r.range(36, 44), left - r.range(22, 38));
    head(right, r.range(0.22, 0.27), r.range(0.25, 0.32), r.range(0.135, 0.16), 6, r.range(36, 44), right + r.range(22, 38));
  } else if (habit === 1) {
    // Tall pair and a bud: two big heads on long stems looking apart, a bud
    // coming up behind them.
    const a = front - r.range(45, 70);
    const b = front + r.range(45, 70);
    head(a, r.range(0.1, 0.15), r.range(0.44, 0.48), r.range(0.185, 0.2), 6, r.range(34, 44), a);
    head(b, r.range(0.15, 0.2), r.range(0.3, 0.36), r.range(0.165, 0.185), 6, r.range(40, 50), b);
    bud(front + 180 + r.range(-30, 30), 0.1, r.range(0.36, 0.42));
    box = [0.92, 1.1, 0.96];
    maxLeaves = 6;
  } else if (habit === 2) {
    // Posy: three small five-petalled heads close together, looking up,
    // and a bud.
    head(front + 180 + r.range(-30, 30), r.range(0, 0.05), r.range(0.34, 0.38), r.range(0.13, 0.15), 5, r.range(10, 20), front);
    const left = front + r.range(50, 80);
    const right = front - r.range(50, 80);
    head(left, r.range(0.17, 0.22), r.range(0.2, 0.28), r.range(0.12, 0.14), 5, r.range(28, 38), left);
    head(right, r.range(0.17, 0.22), r.range(0.2, 0.28), r.range(0.12, 0.14), 5, r.range(28, 38), right);
    bud(front + 180 + r.sign() * r.range(50, 80), 0.15, r.range(0.28, 0.33));
    box = [0.84, 0.8, 0.9];
    maxLeaves = 5;
  } else {
    // Spray: three heads leaning the same way, one above the other.
    const lean = front + r.range(-25, 25);
    const spread = r.range(40, 55);
    head(lean - spread, r.range(0.26, 0.3), r.range(0.2, 0.25), r.range(0.14, 0.16), 6, r.range(36, 44), lean - spread * 0.4);
    head(lean + spread, r.range(0.2, 0.24), r.range(0.3, 0.36), r.range(0.15, 0.17), 6, r.range(30, 38), lean + spread * 0.4);
    head(lean + 180 + r.range(-20, 20), r.range(0.04, 0.08), r.range(0.42, 0.47), r.range(0.165, 0.185), 6, r.range(24, 32), lean);
    box = [1, 1.04, 1];
  }
  separate(heads);
  // Leaves take what the heads leave of the budget, spread evenly round the
  // plant whatever their number; with five or more, the last one stands up
  // among the stems.
  const spent = heads.reduce((sum, h) => sum + headCost(h, 4), 0);
  const leafCount = Math.min(maxLeaves, Math.floor((BUDGET - spent) / LEAF_TRIS));
  const low = leafCount >= 5 ? leafCount - 1 : leafCount;
  const leaves: Leaf[] = [];
  const turn = front + 180 / low + r.range(-20, 20);
  for (let k = 0; k < leafCount; k++) {
    const upright = k >= low;
    leaves.push({
      yaw: upright ? front + 180 + r.range(-40, 40) : turn + ((k + r.range(-0.15, 0.15)) / low) * 360,
      length: upright ? r.range(0.3, 0.34) : r.range(0.38, 0.43),
      lift: upright ? r.range(72, 80) : r.range(68, 76),
      droop: upright ? r.range(44, 64) : r.range(134, 158),
      width: upright ? r.range(0.15, 0.17) : r.range(0.21, 0.25),
      roll: r.sign() * r.range(4, 9),
    });
  }
  return { heads, leaves, stemSides: 4, box };
}

const LEAF_TRIS = 15;
const BUD_TRIS = 10;
/** A head with its stem of two bands (see `bloom`, `bud`). */
const headCost = (h: Head, stemSides: number): number => stemSides * 4 + (h.bud ? BUD_TRIS : h.petals * 13);

interface BloomColors {
  petal: RGB;
  /** The petal's root, in the throat of the flower. */
  deep: RGB;
  /** Petal underside. */
  under: RGB;
  center: RGB;
}

/**
 * An open flower: `petals` pillow petals round a raised button, looking
 * along `axis`. In flower coordinates (radius in units of R, angle, height
 * over a shallow cone), a petal's outline is
 *
 *   root (0) · notch (0.68, ±half, shared with the neighbour)
 *   · shoulder (0.9, ±0.75 half) · end (1.0, ±0.4 half)
 *
 * — a near-round seven-cornered shape, its rim dropped under the cone so
 * the middle stands up as a dome (apex 0.28 R high at 0.6 R): 7 triangles
 * of top, 5 of underside. Sharing the notch corners means no slit shows
 * between petals from any angle, and the deep notch between the round
 * shoulders is what makes the head read as petals, not a disc. The button
 * is a low cone with smooth normals (reads as a dome) whose foot sits in
 * the petal roots.
 */
function bloom(m: SolidMesh, c: Vector3, axis: Vector3, R: number, petals: number, spin: number, colors: BloomColors): void {
  const u = anyPerpendicular(axis);
  const w = Vector3.Cross(axis, u);
  const half = Math.PI / petals;
  const cup = Math.tan(14 * DEG);
  const TOP = paint(colors.petal, { gloss: 0.4, smooth: 48 });
  const UNDER = paint(colors.under, { gloss: 0.3, smooth: 48 });
  const light = adjustOklch(colors.petal, 0.05, 1, 0);
  // Where two petals meet: a step toward the throat colour, so the notch
  // between them reads from any side, lit or not.
  const seam = mixOklab(colors.petal, colors.deep, 0.5);
  const underDeep = mixOklab(colors.under, colors.deep, 0.4);
  const at = (rho: number, phi: number, h = 0): Vector3 =>
    c
      .add(u.scale(Math.cos(phi) * rho * R))
      .add(w.scale(Math.sin(phi) * rho * R))
      .add(axis.scale((rho * cup + h) * R));
  for (let i = 0; i < petals; i++) {
    const a = spin * DEG + i * half * 2;
    const outline = [
      at(0, a),
      at(0.68, a - half, 0.03),
      at(0.9, a - half * 0.75, -0.03),
      at(1, a - half * 0.4, -0.06),
      at(1, a + half * 0.4, -0.06),
      at(0.9, a + half * 0.75, -0.03),
      at(0.68, a + half, 0.03),
    ];
    // The petals deepen toward the middle of the flower.
    const cols = [colors.deep, seam, colors.petal, colors.petal, colors.petal, colors.petal, seam];
    const apex = at(0.6, a, 0.28);
    const up = axis.add(u.scale(Math.cos(a) * -0.2)).add(w.scale(Math.sin(a) * -0.2));
    for (let k = 0; k < outline.length; k++) {
      const k1 = (k + 1) % outline.length;
      const tri = [apex, outline[k], outline[k1]];
      const col = [light, cols[k], cols[k1]];
      if (Vector3.Dot(loopNormal(tri), up) < 0) {
        tri.reverse();
        col.reverse();
      }
      m.tri(tri[0], tri[1], tri[2], TOP, col);
    }
    // Underside: a fan from the root.
    for (let k = 1; k < outline.length - 1; k++) {
      const tri = [outline[0], outline[k], outline[k + 1]];
      const col = [underDeep, colors.under, colors.under];
      if (Vector3.Dot(loopNormal(tri), up) > 0) {
        tri.reverse();
        col.reverse();
      }
      m.tri(tri[0], tri[1], tri[2], UNDER, col);
    }
  }
  // The button: one corner over each notch, its rim at the height of the
  // petal roots, so the petal domes rise round it and it stands in a cup.
  const BUTTON = paint(colors.center, { gloss: 0.5, smooth: 85 });
  const rimColor = mixOklab(colors.center, BUTTON_ORANGE, 0.35);
  const tip = at(0, 0, 0.38);
  const rim = Array.from({ length: petals }, (_, k) => at(0.28, spin * DEG + (2 * k + 1) * half, 0.07));
  for (let k = 0; k < petals; k++) {
    const tri = [rim[k], rim[(k + 1) % petals], tip];
    const col = [rimColor, rimColor, colors.center];
    if (Vector3.Dot(loopNormal(tri), axis) < 0) {
      tri.reverse();
      col.reverse();
    }
    m.tri(tri[0], tri[1], tri[2], BUTTON, col);
  }
}

/** A closed bud: a five-sided spindle `length` long on `axis`, a green
 * calyx below its widest ring and petal colour above. 10 triangles. */
function bud(m: SolidMesh, base: Vector3, axis: Vector3, length: number, calyx: RGB, colors: BloomColors): void {
  const u = anyPerpendicular(axis);
  const w = Vector3.Cross(axis, u);
  const LOW = paint(calyx, { gloss: 0.3, smooth: 0 });
  const HIGH = paint(colors.petal, { gloss: 0.35, smooth: 0 });
  const ring = Array.from({ length: 5 }, (_, k) => {
    const a = (k / 5) * Math.PI * 2;
    return base
      .add(axis.scale(length * 0.36))
      .add(u.scale(Math.cos(a) * length * 0.3))
      .add(w.scale(Math.sin(a) * length * 0.3));
  });
  const tip = base.add(axis.scale(length));
  for (let k = 0; k < 5; k++) {
    const k1 = (k + 1) % 5;
    const mid = ring[k].add(ring[k1]).scale(0.5).subtract(base.add(axis.scale(length * 0.36)));
    const low = [base, ring[k], ring[k1]];
    if (Vector3.Dot(loopNormal(low), mid.subtract(axis)) < 0) low.reverse();
    m.tri(low[0], low[1], low[2], LOW);
    const high = [ring[k], ring[k1], tip];
    const col = [colors.deep, colors.deep, colors.petal];
    if (Vector3.Dot(loopNormal(high), mid.add(axis)) < 0) {
      high.reverse();
      col.reverse();
    }
    m.tri(high[0], high[1], high[2], HIGH, col);
  }
}

// Stations along a leaf: the belly, then a shorter last segment for the
// rounded point.
const STATIONS = [0, 0.3, 0.68, 1];

/** Leaf outline at t = 0 (root) … 1 (tip), as a fraction of the widest
 * width: a short stalk, widest at 0.4, a full round shoulder, a point. */
function outline(t: number): number {
  if (t >= 1) return 0;
  if (t < 0.4) return 0.32 + 0.68 * Math.sin((t / 0.4) * Math.PI * 0.5);
  return Math.pow(Math.cos(((t - 0.4) / 0.6) * Math.PI * 0.5), 0.55);
}

/** The centre line of a leaf: leaves the root at `lift` and bends over by
 * `droop`, sampled at `STATIONS` (integrated in fine steps). */
function arch(from: Vector3, l: Leaf, length: number): Vector3[] {
  const yaw = l.yaw * DEG;
  const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const STEPS = 48;
  const out: Vector3[] = [];
  let at = from.clone();
  let next = 0;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    while (next < STATIONS.length && STATIONS[next] <= t + 1e-9) {
      out.push(at.clone());
      next++;
    }
    const pitch = (l.lift - l.droop * Math.pow(t + 0.5 / STEPS, 1.1)) * DEG;
    at = at.add(dir.scale((Math.cos(pitch) * length) / STEPS)).add(new Vector3(0, (Math.sin(pitch) * length) / STEPS, 0));
  }
  return out;
}

/**
 * One broad leaf as a thin closed solid along `path`: a gently ridged top
 * (two planes meeting on a raised midrib — under the smooth paint a soft
 * convex leaf with a lighter centre line) over a flat underside, ending in a
 * point. 6 triangles a segment, 3 for the last; the root is open (under the
 * ground).
 */
function leafSolid(m: SolidMesh, path: readonly Vector3[], widths: readonly number[], roll: number, ridge: number, top: RGB[], rib: RGB[], under: RGB[], p: Paint): void {
  const n = path.length;
  const chord = path[n - 1].subtract(path[0]);
  const side0 = Vector3.Cross(new Vector3(0, 1, 0), chord).normalize();
  const a = roll * DEG;
  const wMax = Math.max(...widths) / 2;
  const st = path.map((q, k) => {
    const tan = path[Math.min(n - 1, k + 1)].subtract(path[Math.max(0, k - 1)]).normalize();
    let side = side0.subtract(tan.scale(Vector3.Dot(side0, tan))).normalize();
    let up = Vector3.Cross(tan, side);
    [side, up] = [side.scale(Math.cos(a)).add(up.scale(Math.sin(a))), up.scale(Math.cos(a)).subtract(side.scale(Math.sin(a)))];
    const w = widths[k] / 2;
    // The midrib keeps some height toward the point: a thick leaf, not a
    // card that thins to nothing.
    const rise = ridge * Math.max(w, wMax * 0.35);
    return { L: q.subtract(side.scale(w)), R: q.add(side.scale(w)), T: q.add(up.scale(k === n - 1 ? 0 : rise)), up, side };
  });
  const face = (pts: Vector3[], cols: RGB[], dir: Vector3): void => {
    if (Vector3.Dot(loopNormal(pts), dir) < 0) {
      pts.reverse();
      cols.reverse();
    }
    if (pts.length === 3) m.tri(pts[0], pts[1], pts[2], p, cols);
    else m.quad(pts[0], pts[1], pts[2], pts[3], p, cols);
  };
  for (let k = 0; k < n - 1; k++) {
    const i = st[k];
    const j = st[k + 1];
    const left = i.up.subtract(i.side.scale(0.4));
    const right = i.up.add(i.side.scale(0.4));
    const down = i.up.scale(-1);
    if (k === n - 2) {
      face([i.L, i.T, j.T], [top[k], rib[k], top[k + 1]], left);
      face([i.T, i.R, j.T], [rib[k], top[k], top[k + 1]], right);
      face([i.L, i.R, j.T], [under[k], under[k], under[k + 1]], down);
    } else {
      face([i.L, i.T, j.T, j.L], [top[k], rib[k], rib[k + 1], top[k + 1]], left);
      face([i.T, i.R, j.R, j.T], [rib[k], top[k], top[k + 1], rib[k + 1]], right);
      face([i.L, i.R, j.R, j.L], [under[k], under[k], under[k + 1], under[k + 1]], down);
    }
  }
}

/** A colour form of the species: the petal colour as a shift of the
 * palette's coral (OKLCH hue in degrees, + = toward orange; lightness;
 * chroma factor), and how orange the button is. */
interface Form {
  hue: number;
  light: number;
  chroma: number;
  button: number;
}

const FORMS: Form[] = [
  { hue: 0, light: 0, chroma: 1, button: 0 }, // the design: coral
  { hue: -22, light: 0.01, chroma: 1.04, button: 0 }, // pink
  { hue: 26, light: 0.05, chroma: 1.06, button: 0.5 }, // orange
  { hue: 4, light: -0.06, chroma: 1.1, button: 0.2 }, // deep red-coral
  { hue: -8, light: 0.08, chroma: 0.75, button: 0.35 }, // soft peach
];

function construct(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const plan = layout(v);
  const leaves = plan.leaves;

  const look = v.fork('look');
  const form = v.hero ? FORMS[0] : FORMS[1 + ((seed - 1) % (FORMS.length - 1))];
  const petal = v.tint(adjustOklch(FLOWERS.petal, form.light, form.chroma, form.hue), FLOWER_AMP, 0.35);
  const colors: BloomColors = {
    petal,
    deep: adjustOklch(petal, -0.08, 1.08, -7),
    // A hue step toward pink and a little PALER: the back of a flower is in
    // its own shade already (palette.ts).
    under: adjustOklch(petal, 0.1, 0.9, -5),
    center: mixOklab(FLOWERS.center, BUTTON_ORANGE, form.button),
  };
  // The sheet's stems are a mid green, a step lighter than the palette's
  // stem colour reads in shade; its leaves a fresher, lighter green still.
  const stemGreen = v.tint(mixOklab(FLOWERS.stem, FOLIAGE.lime, 0.15), FOLIAGE_AMP);
  const leafGreen = v.tint(mixOklab(FLOWERS.stem, FOLIAGE.lime, 0.32), FOLIAGE_AMP);
  const leafTip = v.tint(mixOklab(FLOWERS.stem, FOLIAGE.lime, 0.55), FOLIAGE_AMP);
  const leafUnder = adjustOklch(mixOklab(leafGreen, FOLIAGE.jade, 0.3), 0.01, 1, 0);
  const STEM = paint(stemGreen, { gloss: 0.35, smooth: 100 });
  const LEAF = paint(leafGreen, { gloss: 0.4, smooth: 60 });

  const m = new SolidMesh();
  leaves.forEach((l) => {
    const a = l.yaw * DEG;
    const path = arch(new Vector3(Math.sin(a) * 0.04, -SKIRT, Math.cos(a) * 0.04), l, l.length + SKIRT);
    // Each leaf its own small step in value and hue, so neighbours separate.
    const k = look.r.range(-1, 1);
    const own = (c: RGB): RGB => adjustOklch(c, k * 0.02, 1, k * 3);
    const top = STATIONS.map((t) => own(mixOklab(leafGreen, leafTip, Math.pow(t, 1.2))));
    leafSolid(
      m,
      path,
      STATIONS.map((t) => l.width * outline(t)),
      l.roll,
      0.28,
      top,
      // The midrib: a lighter line.
      top.map((c) => mixOklab(c, leafTip, 0.5)),
      top.map((c) => mixOklab(own(leafUnder), c, 0.25)),
      LEAF,
    );
  });
  // Stems: one bend from the root, arriving in the back of the head along
  // its axis. All stems first, then the heads: see the wind weights below.
  const heads = plan.heads.map((h) => ({ h, c: new Vector3(h.at[0], h.at[1], h.at[2]), axis: axisOf(h) }));
  // What is left of the budget buys a third band for the longest stems: on
  // a tall stem the one joint of two bands is an elbow.
  let spare = BUDGET - plan.heads.reduce((sum, h) => sum + headCost(h, plan.stemSides), leaves.length * LEAF_TRIS);
  const third = new Set<number>();
  for (const i of heads.map((_, k) => k).sort((p, q) => heads[q].c.y - heads[p].c.y)) {
    if (spare < plan.stemSides * 2) break;
    third.add(i);
    spare -= plan.stemSides * 2;
  }
  heads.forEach(({ h, c, axis }, i) => {
    const out = Math.hypot(c.x, c.z) || 1;
    const root = new Vector3((c.x / out) * 0.025, -SKIRT, (c.z / out) * 0.025);
    // The stem ends inside the button (whose foot is in the petal roots):
    // nothing of its open end shows from behind or below.
    const neck = h.bud ? c : c.add(axis.scale(h.radius * 0.08));
    const reach = Vector3.Distance(root, neck);
    // Joints sit toward the head, where the bend is.
    const bend = quadraticBezierPath(root, neck.subtract(axis.scale(reach * 0.45)), neck, 20);
    const path = third.has(i) ? [bend[0], bend[9], bend[15], bend[20]] : [bend[0], bend[12], bend[20]];
    limb(m, { path, radius: [0.026, 0.023, 0.02], sides: plan.stemSides, rough: 0, seed: seed * 7 + i, capTip: false }, STEM);
  });
  const marks = heads.map(({ h, c, axis }) => {
    const from = m.mark();
    if (h.bud) bud(m, c.subtract(axis.scale(0.01)), axis, h.radius, stemGreen, colors);
    else bloom(m, c, axis, h.radius, h.petals, h.spin, colors);
    return { from, at: h.at };
  });

  // Size: the habit's box times one draw for the whole plant; the footprint
  // keeps the proportions it grew with and is scaled as a whole to the box's
  // area. Only the hero is put on the design's box exactly.
  const k = v.hero ? 1 : look.r.range(0.93, 1.07);
  const want = (axis: number, size: number): number => size * plan.box[axis] * k;
  const grown = m.bounds();
  const gx = grown.max.x - grown.min.x;
  const gz = grown.max.z - grown.min.z;
  const plane = v.hero ? 1 : Math.sqrt((want(0, SIZE.x) * want(2, SIZE.z)) / (gx * gz));
  const fit = fitSize(m, {
    x: v.hero ? SIZE.x : clamp(gx * plane, SIZE.x * 0.76, SIZE.x * 1.24),
    y: clamp(want(1, SIZE.y), SIZE.y * 0.76, SIZE.y * 1.16),
    z: v.hero ? SIZE.z : clamp(gz * plane, SIZE.z * 0.76, SIZE.z * 1.24),
  });

  // Wind: stems and leaves bend with height; every head then takes the
  // weight of its own centre, whole, so it nods on its stem without
  // shearing. (`setWind(w, from)` runs to the end of the mesh: in build
  // order, each head overwrites the ones before it only on its own part.)
  const top = m.bounds().max.y;
  const weight = (y: number): number => 0.16 * Math.pow(clamp((y - 0.04) / (top - 0.04), 0, 1), 1.5);
  m.setWind((p) => weight(p.y));
  for (const mark of marks) m.setWind(weight(fitPoint(fit, mark.at)[1]), mark.from);
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Coral Blooms',
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
    brief: 'design-documents/environment-design-pack/vegetation/v05-coral-blooms-brief.txt',
  },
};

export default asset;
