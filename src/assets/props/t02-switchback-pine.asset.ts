import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, adjustOklch, bezierPath, loopNormal, mixOklab, paint, rng } from '../../gfx/solid';
import type { Paint } from '../../gfx/solid';
import { BARK, FOLIAGE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { applyFit, farStick, outTri } from './farKit';
import { barkPaint, barkTones, fitSize, foliageColor, foliageTones, limb, shadeBark, sway, variant } from './nature';
import type { BarkTones, Fit, FoliageTones, LimbFacet, Variant } from './nature';

/**
 * T02 SWITCHBACK PINE — a tall, tapered, gently windswept conifer: four
 * staggered tiers of thick plank-like boughs round a narrow cinnamon trunk
 * that shows between the tiers, under a hooked tip (trees/design-sheet.png,
 * middle).
 *
 * Parts list, measured off the sheet and laid into the brief's box (3.3 wide
 * × 7 tall × 3 deep; the drawing is half again as squat as the box, so the
 * build leans on the size tolerance: about 7 % wider and deeper and 4 %
 * lower):
 *  - trunk: 0.36 m radius at the waist, six flutes, five buttress toes. It
 *    zig-zags — alternately left and right of the tiers' common axis at each
 *    rim — so in every gap a DIAGONAL run of cinnamon trunk shows on one side
 *    under the upper tier's hem: the "switchback";
 *  - tiers: rims at about 25 / 45 / 63 / 80 % of the height, radii 1 : 0.8 :
 *    0.6 : 0.42. Each tier's top runs on up INSIDE the tier above (the
 *    sheet's tiers are stacked truncated cones, not umbrellas): the
 *    silhouette never pinches to the bare trunk. A tier is NOT a cone with a
 *    zig-zag hem: it is a ring of separate thick slabs ("boughs", eight on
 *    the lowest tier, six on the top one). Down to a shared, irregular knee
 *    ring they are the facets of one lopsided pyramid; below it each is a
 *    plank that flattens toward a blunt end with clipped corners (the
 *    concave pagoda profile of the sheet) at its own length, pitch and roll,
 *    so neighbours part and overlap like shingles. Under them a ring of
 *    fewer, broader, darker planks shows through the gaps and below the hem
 *    (never reaching past the bough above it), and a closed core with a
 *    tucked-up belly fills the pyramid, so a low camera sees a shaded mass
 *    and not the inside of an umbrella;
 *  - windswept: every rim plane is TILTED, windward hem low and lee hem
 *    high (about 11° on the lowest tier, the azimuth staggered ±25° tier by
 *    tier); lee boughs are longer, windward ones shorter, and every tier
 *    rides a little downwind of the axis;
 *  - tip: a concave six-sided spire hooked downwind, still rising at its
 *    point; the top tier's boughs are its hem (a witch's hat).
 * Colour runs from a deep blue-green jade skirt to a fresh, luminous green
 * crown. Built with the wind blowing toward +x, then turned: the hero leans
 * toward compass 60°, which is "to the right" in the lab's default view as in
 * the sheet's main view.
 *
 * Variants are the same species re-grown in another habit (`HABITS`, cycled
 * by seed so neighbouring seeds never share one): a slim five-tier spire, a
 * broad low-skirted tree, a hard-blown one, a ragged one with missing under
 * boughs — each with its counts, lean, hook and droop drawn again, then
 * turned and maybe mirrored.
 */

const ID = 't02-switchback-pine';
const SIZE = { x: 3.3, y: 7, z: 3 };
// What `fitSize` aims for: its height is above ground, the roots' skirt
// (0.1 m) comes on top of it in the lab's measurement. The sheet's tree is
// far squatter than the box (W/H 0.75 vs 0.47): use the tolerance toward it.
const FIT = { x: 3.55, y: 6.6, z: 3.22 };
const SKIRT = 0.1;
const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);

/** The habit a tree grows in. Numbers are for a 6.9 m tree. */
interface Habit {
  tiers: number;
  /** Width and height factors on the fitted box. */
  wide: number;
  tall: number;
  /** Height of the lowest rim: the bare trunk. */
  bare: number;
  /** Radius of the lowest and of the top tier. */
  bottom: number;
  top: number;
  /** > 1 keeps the upper tiers wide (a column), < 1 shrinks them fast. */
  taper: number;
  /** How far the top of the axis stands downwind of its foot. */
  lean: number;
  /** How far the trunk swings off the axis at each rim (the switchback). */
  kink: number;
  /** How far the tip hooks downwind. */
  hook: number;
  /** Windswept asymmetry: lee boughs this fraction longer and lifted. */
  wind: number;
  /** Tilt of the rim planes: rise per meter of radius toward the lee. */
  tilt: number;
  /** How far the bough ends hang under the rim, fraction of tier height. */
  droop: number;
  /** Boughs in the upper ring of the lowest tier. */
  boughs: number;
  /** Chance that a plank of the under ring is missing. */
  ragged: number;
}

const HERO: Habit = { tiers: 4, wide: 1, tall: 1, bare: 1.75, bottom: 1.72, top: 0.74, taper: 0.95, lean: 0.42, kink: 0.42, hook: 0.42, wind: 0.18, tilt: 0.18, droop: 0.16, boughs: 8, ragged: 0 };
const HABITS: readonly Habit[] = [
  // slim spire — the one habit with five tiers
  { tiers: 5, wide: 0.88, tall: 1.06, bare: 1.55, bottom: 1.55, top: 0.62, taper: 1.2, lean: 0.22, kink: 0.3, hook: 0.3, wind: 0.14, tilt: 0.13, droop: 0.14, boughs: 7, ragged: 0.1 },
  // broad, low skirt
  { tiers: 4, wide: 1.08, tall: 0.92, bare: 1.35, bottom: 1.9, top: 0.62, taper: 0.8, lean: 0.3, kink: 0.42, hook: 0.35, wind: 0.2, tilt: 0.16, droop: 0.18, boughs: 9, ragged: 0 },
  // hard-blown
  { tiers: 4, wide: 1.04, tall: 1.0, bare: 1.9, bottom: 1.62, top: 0.72, taper: 1.05, lean: 0.62, kink: 0.32, hook: 0.5, wind: 0.26, tilt: 0.24, droop: 0.06, boughs: 7, ragged: 0.15 },
  // ragged
  { tiers: 4, wide: 0.96, tall: 1.02, bare: 1.7, bottom: 1.72, top: 0.6, taper: 0.95, lean: 0.35, kink: 0.46, hook: 0.42, wind: 0.22, tilt: 0.2, droop: 0.2, boughs: 7, ragged: 0.25 },
];

interface Tier {
  /** Height of the rim plane. */
  rim: number;
  /** Height where the boughs leave the axis: up inside the next tier. */
  apex: number;
  radius: number;
  boughs: number;
  /** 0 = lowest tier … 1 = top. */
  t: number;
}

interface Layout {
  habit: Habit;
  tiers: Tier[];
  /** The tiers' common axis at height y (leaning downwind, wind toward +x). */
  axis: (y: number) => Vector3;
  /** Trunk centre line, foot → foot of the spire. */
  trunk: Vector3[];
  /** Trunk radius at each trunk point. */
  trunkRadius: number[];
  tipY: number;
  girth: number;
  toes: number;
  mirror: boolean;
  turn: number;
}

function layout(v: Variant): Layout {
  let h = HERO;
  if (!v.hero) {
    const base = HABITS[(Math.abs(Math.trunc(v.seed)) - 1) % HABITS.length];
    const r = v.fork('habit').r;
    const w = (x: number, by: number): number => x * (1 + (r.next() * 2 - 1) * by);
    h = {
      ...base,
      bare: w(base.bare, 0.08),
      bottom: w(base.bottom, 0.06),
      top: w(base.top, 0.1),
      lean: w(base.lean, 0.3),
      kink: w(base.kink, 0.2),
      hook: w(base.hook, 0.25),
      wind: w(base.wind, 0.2),
      tilt: w(base.tilt, 0.2),
      droop: w(base.droop, 0.25),
    };
  }
  const tipY = 6.9;
  const K = h.tiers;
  // Rims: the gaps shrink a tenth per tier; the top tier (rim to tip) is as
  // tall as a gap and a quarter.
  const topHeight = 1.35 * Math.pow(4 / K, 0.7);
  const gaps: number[] = [];
  for (let k = 0; k < K - 1; k++) gaps.push(1 - 0.1 * k);
  const total = gaps.reduce((s, g) => s + g, 0);
  const span = tipY - topHeight - h.bare;
  const vt = v.fork('tiers');
  const tiers: Tier[] = [];
  let y = h.bare;
  for (let k = 0; k < K; k++) {
    const t = K > 1 ? k / (K - 1) : 1;
    const radius = (h.bottom - (h.bottom - h.top) * Math.pow(t, h.taper)) * (k > 0 && k < K - 1 ? vt.num(1, 0.07) : 1);
    tiers.push({ rim: y, apex: 0, radius, boughs: Math.max(5, Math.round(h.boughs - 2 * Math.pow(t, 1.5) + (k > 0 ? vt.num(0, 0.6) : 0))), t });
    if (k < K - 1) y += (span * gaps[k]) / total + (k < K - 2 ? vt.num(0, 0.08) : 0);
  }
  // The budget is hard and a five-tier tree with full rings would break it:
  // thin the fullest ring until the tree fits. Per tier: 26 triangles a
  // bough (24 + 2 of the core), 20 a plank of the under ring; trunk, roots
  // and spire take 320.
  const cost = (): number => tiers.reduce((sum, tier, k) => sum + tier.boughs * 26 + (k < K - 1 ? underCount(tier.boughs) * 20 : 0), 320);
  while (cost() > 1385) tiers.reduce((a, b) => (b.boughs > a.boughs ? b : a)).boughs--;
  // A tier's top runs on up into the next tier, a sixth of a gap past its
  // rim: hidden by that tier's hem and core, it fills the waist, so the tree
  // is one jagged tapered mass and not a stack of umbrellas on a pole.
  tiers.forEach((tier, k) => (tier.apex = k < K - 1 ? tiers[k + 1].rim + (tiers[k + 1].rim - tier.rim) * 0.18 : tipY));

  const top = tiers[K - 1].rim + (tipY - tiers[K - 1].rim) * 0.3;
  const axis = (yy: number): Vector3 => new Vector3(h.lean * Math.pow(Math.min(1, Math.max(0, yy / top)), 1.5), yy, 0);
  // Trunk: straight up the axis to the lowest rim, then forward (−z, the
  // sheet's view side) and alternately left and right — its elbows sit in
  // the WINDOWS, a third of a gap under each upper rim, where the lower
  // tier's top has fallen away below the upper hem — back on the axis at the
  // spire's foot. Straight runs between: from the front the trunk zig-zags
  // through the tiers in clean diagonals; it never sticks out past a hem
  // (the windward hems are short) and is never a pole seen all round.
  const g = v.fork('trunk').num(0.36, 0.04);
  const swing = v.fork('swing');
  const first = swing.chance(true, 0.5) ? 1 : -1;
  const trunk: Vector3[] = [axis(-SKIRT), axis(h.bare * 0.45), axis(tiers[0].rim)];
  for (let k = 0; k < K - 1; k++) {
    // Never further out than two fifths of the tier above reaches, or the
    // elbow pokes out past a small upper tier's hem or through its top.
    const kink = Math.min(h.kink, tiers[k + 1].radius * 0.4);
    const s = (k % 2 ? -1 : 1) * first;
    trunk.push(axis(tiers[k + 1].rim - (tiers[k + 1].rim - tiers[k].rim) * 0.3).add(new Vector3(s * kink * 0.55, 0, -kink * 0.75)));
  }
  trunk.push(axis(top));
  // Radius by height: a flared foot, a waist, then a steady taper.
  const trunkRadius = trunk.map((q) => {
    const f = Math.max(0, q.y) / top;
    return g * (f < 0.1 ? 1.55 - 0.55 * (f / 0.1) : 1 - 0.62 * ((f - 0.1) / 0.9));
  });

  const vp = v.fork('pose');
  return {
    habit: h,
    tiers,
    axis,
    trunk,
    trunkRadius,
    tipY,
    girth: g,
    toes: v.fork('trunk').int(5, 4, 5),
    mirror: vp.chance(false, 0.5),
    // The model's +x (downwind) to compass 60°.
    turn: vp.range(-30, 0, 360),
  };
}

/** Planks in a tier's under ring: fewer and broader than the boughs above. */
function underCount(boughs: number): number {
  return Math.max(4, boughs - 2);
}

/** Point of a polyline (rising in y) at height y. */
function atHeight(line: readonly Vector3[], y: number): Vector3 {
  for (let i = 1; i < line.length; i++) {
    if (y <= line[i].y || i === line.length - 1) {
      const a = line[i - 1];
      const b = line[i];
      const t = (y - a.y) / Math.max(1e-9, b.y - a.y);
      return new Vector3(a.x + (b.x - a.x) * t, y, a.z + (b.z - a.z) * t);
    }
  }
  return line[0].clone();
}

interface BoughShape {
  /** Where the bough leaves the axis (top face), or null for a plank that
   * starts at the knee with a plain back (inside the tier's core). */
  c0: Vector3 | null;
  /** The two top corners at the knee — shared with the neighbours. */
  kl: Vector3;
  kr: Vector3;
  /** Centre of the end's top edge. */
  c2: Vector3;
  /** Half width at the end. */
  w2: number;
  /** Thickness at the knee and at the end. */
  th1: number;
  th2: number;
  /** One end corner up, the other down, as a fraction of the half width. */
  roll: number;
  /** One end corner ahead of the other, as a fraction of the half width. */
  skew: number;
  /** The end's two outer corners are cut off at 45°, this fraction of the
   * half width each way: from above a chunky clipped tip, not a sawn card. */
  clip: number;
}

/**
 * One bough: a thick slab that leaves the axis as a wedge, bends at the knee
 * and ends in a blunt cut with clipped corners — closed all round (the wedge
 * starts in a vertical edge inside the trunk), so a ring of them is solid
 * from any camera. 24 triangles; 20 for a plank from the knee.
 */
function bough(m: SolidMesh, o: BoughShape, color: (normal: Vector3, center: Vector3) => Paint): void {
  const c1 = o.kl.add(o.kr).scale(0.5);
  const side = o.kr.subtract(o.kl).normalize();
  const d1 = o.c2.subtract(c1).normalize();
  const upward = (d: Vector3, across: Vector3): Vector3 => {
    const n = Vector3.Cross(across, d).normalize();
    return n.y < 0 ? n.scale(-1) : n;
  };
  // The end is cut square to the plank, whichever way the plank fans out.
  const flat = new Vector3(d1.x, 0, d1.z).normalize();
  let across = new Vector3(flat.z, 0, -flat.x);
  if (Vector3.Dot(across, side) < 0) across = across.scale(-1);
  const n1 = upward(d1, across);
  const nk = o.c0 ? upward(c1.subtract(o.c0).normalize(), side).add(n1).normalize() : n1;
  const tl1 = o.kl;
  const tr1 = o.kr;
  const bl1 = tl1.subtract(nk.scale(o.th1));
  const br1 = tr1.subtract(nk.scale(o.th1));
  const tl2 = o.c2.subtract(across.scale(o.w2)).add(UP.scale(o.roll * o.w2)).add(d1.scale(o.skew * o.w2));
  const tr2 = o.c2.add(across.scale(o.w2)).subtract(UP.scale(o.roll * o.w2)).subtract(d1.scale(o.skew * o.w2));
  // Clipped corners: one point back along the side, one in along the end.
  const c = o.clip * o.w2;
  const tla = tl2.subtract(d1.scale(c));
  const tlb = tl2.add(across.scale(c));
  const tra = tr2.subtract(d1.scale(c));
  const trb = tr2.subtract(across.scale(c));
  const below = (q: Vector3): Vector3 => q.subtract(n1.scale(o.th2));
  const [bla, blb, bra, brb] = [tla, tlb, tra, trb].map(below);
  const face = (pts: Vector3[], inside: Vector3): void => {
    const n = loopNormal(pts);
    if (n.lengthSquared() < 1e-20) return;
    n.normalize();
    const cc = pts.reduce((acc, q) => acc.addInPlace(q), new Vector3()).scaleInPlace(1 / pts.length);
    if (Vector3.Dot(n, cc.subtract(inside)) < 0) {
      pts = [...pts].reverse();
      n.scaleInPlace(-1);
    }
    // A plank that fans sideways or rolls has twisted faces. Split a quad
    // along the diagonal that stands proud of the other: the fold is then a
    // ridge down the bough, never a dent across it.
    if (pts.length === 4 && Vector3.Dot(pts[1].add(pts[3]).subtract(pts[0]).subtract(pts[2]), n) > 0) pts = [pts[1], pts[2], pts[3], pts[0]];
    m.fan(pts, color(n, cc));
  };
  const in1 = c1.add(o.c2).scale(0.5).subtract(n1.scale((o.th1 + o.th2) * 0.25));
  if (o.c0) {
    // Inner band: the wedge from the axis to the knee.
    const at = o.c0;
    const ab = o.c0.subtract(UP.scale(o.th1 * 1.5));
    const in0 = o.c0.scale(0.3).add(c1.scale(0.7)).subtract(nk.scale(o.th1 * 0.5));
    face([at, tl1, tr1], in0);
    face([ab, bl1, br1], in0);
    face([at, ab, bl1, tl1], in0);
    face([at, ab, br1, tr1], in0);
  } else face([tl1, tr1, br1, bl1], in1);
  // Outer band: the plank. The hexagons are fanned from the knee corner,
  // so every triangle spans the plank's length (no slivers at the tip).
  face([tl1, tr1, tra, trb, tlb, tla], in1);
  face([bl1, br1, bra, brb, blb, bla], in1);
  face([tl1, bl1, bla, tla], in1);
  face([tr1, br1, bra, tra], in1);
  face([tla, tlb, blb, bla], in1);
  face([tra, trb, brb, bra], in1);
  face([tlb, trb, brb, blb], in1);
}

/** A smooth, seeded wobble round a ring (shared by every bough that uses
 * the same corner, so knee rings stay closed): ≈ ±1. */
function wobble(phase: readonly number[]): (az: number) => number {
  return (az) => 0.65 * Math.sin(2 * az + phase[0]) + 0.35 * Math.sin(3 * az + phase[1]);
}

/**
 * The buttress toes — `rootFlare` of nature.ts with this species' section:
 * the sheet's pine toes are broad at the ground and taper to a thin ridge
 * up the trunk, so each dies INTO a trunk flute instead of ending in a flat
 * ledge where its back meets the trunk. Stations: [fraction of the toe's
 * length, ridge height (fraction of `height`), half width of the back, half
 * width at the ground], widths in trunk radii; the first is on the axis.
 */
const TOE: readonly (readonly [number, number, number, number])[] = [
  [0.02, 1.2, 0.02, 0.1],
  [0.42, 0.78, 0.12, 0.36],
  [0.64, 0.36, 0.2, 0.46],
  [0.87, 0.13, 0.18, 0.4],
  [1.0, 0, 0.1, 0.26],
];

function roots(
  m: SolidMesh,
  o: { radius: number; toes: number; reach: number; height: number; skirt: number; startDeg: number; seed: number },
  p: (facet: LimbFacet) => Paint,
): void {
  const r = rng(o.seed, 'roots');
  const R = o.radius;
  const down = new Vector3(0, -o.skirt, 0);
  const emit = (q: Vector3[], out: Vector3, fp: Paint): void => {
    for (const [a, b, c] of [
      [q[0], q[1], q[2]],
      [q[0], q[2], q[3]],
    ]) {
      if (Vector3.Dot(loopNormal([a, b, c]), out) >= 0) m.tri(a, b, c, fp);
      else m.tri(a, c, b, fp);
    }
  };
  for (let i = 0; i < o.toes; i++) {
    const a = (o.startDeg + (i + (r.next() - 0.5) * 0.45) * (360 / o.toes)) * DEG;
    const dir = new Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new Vector3(dir.z, 0, -dir.x);
    const len = o.reach * r.range(0.84, 1.08);
    const hh = o.height * r.range(0.85, 1.1);
    const wide = r.range(0.9, 1.15);
    // A slight sideways curl, so the toes do not radiate like spokes.
    const curl = r.range(-0.22, 0.22) * R;
    const rows = TOE.map(([s, y, back, foot], k) => {
      const c = dir.scale(len * s).add(side.scale(curl * s * s));
      const top = new Vector3(0, k === TOE.length - 1 ? -o.skirt : hh * y, 0);
      return [c.add(side.scale(-R * foot * wide)).add(down), c.add(side.scale(-R * back * wide)).add(top), c.add(side.scale(R * back * wide)).add(top), c.add(side.scale(R * foot * wide)).add(down)];
    });
    const id = o.seed * 31 + i;
    const facet = (sideIdx: number, band: number, normal: Vector3, center: Vector3): Paint => p({ limb: id, side: sideIdx, band, t: (band + 0.5) / (rows.length - 1), normal, center });
    // The inner end, inside the trunk: closed, so the toe is a solid.
    const back = dir.scale(-1);
    const q0 = [rows[0][0], rows[0][1], rows[0][2], rows[0][3]];
    emit(q0, back, facet(3, 0, back, rows[0][1].add(rows[0][3]).scale(0.5)));
    for (let k = 0; k < rows.length - 1; k++) {
      const inside = dir.scale(len * (TOE[k][0] + TOE[k + 1][0]) * 0.5).add(down);
      for (let j = 0; j < 3; j++) {
        const q = [rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]];
        const center = q[0].add(q[1]).add(q[2]).add(q[3]).scale(0.25);
        const out = center.subtract(inside);
        const n = loopNormal(q);
        if (n.lengthSquared() < 1e-20) continue;
        n.normalize();
        if (Vector3.Dot(n, out) < 0) n.scaleInPlace(-1);
        emit(q, out, facet(j, k, n, center));
      }
      // The sole, so a toe over a dip in the ground is not hollow.
      const sole = [rows[k][0], rows[k][3], rows[k + 1][3], rows[k + 1][0]];
      emit(sole, new Vector3(0, -1, 0), facet(3, k, new Vector3(0, -1, 0), sole[0].add(sole[2]).scale(0.5)));
    }
  }
}

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  layout: Layout;
}

/** The pine's bark and its foliage tones by tier height (0 = lowest tier
 * … 1 = the spire), optionally sunk toward the deep tone (under ring). */
function pineTones(v: Variant): { bark: BarkTones; tonesAt: (t: number, sink?: number) => FoliageTones } {
  // Sun-side trunk facets in the sheet's cinnamon (#c76539), not a rust red:
  // lift the base toward the highlight and keep the dark a light step.
  const bark = barkTones(v, {
    base: mixOklab(BARK.base, BARK.highlight, 0.25),
    light: BARK.highlight,
    dark: mixOklab(BARK.base, BARK.shadow, 0.3),
  });
  // The pine is the jade tree of the set: deep blue-green jade at the skirt,
  // rising to a luminous fresh green at the tip — never the oak's
  // yellow-lime. How far the top brightens is drawn per tree.
  const fresh = v.fork('tone').num(0.62, 0.08);
  const low = foliageTones(
    v,
    {
      top: FOLIAGE.jade,
      mid: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.2),
      under: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.45),
      deep: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.62),
    },
    1.4,
  );
  const high = foliageTones(
    v,
    {
      top: adjustOklch(mixOklab(FOLIAGE.jade, FOLIAGE.lime, fresh), 0.05),
      mid: mixOklab(FOLIAGE.jade, FOLIAGE.lime, 0.35),
      under: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.08),
      deep: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.4),
    },
    1.4,
  );
  const tonesAt = (t: number, sink = 0): FoliageTones => {
    const f = Math.pow(t, 0.8);
    const mixed = { top: mixOklab(low.top, high.top, f), mid: mixOklab(low.mid, high.mid, f), under: mixOklab(low.under, high.under, f), deep: mixOklab(low.deep, high.deep, f) };
    // The under ring sits in the upper ring's shade: a step toward the deep
    // tone, top faces most (they are what shows through the gaps).
    return sink ? { ...mixed, top: mixOklab(mixed.top, mixed.deep, sink), mid: mixOklab(mixed.mid, mixed.deep, sink * 0.7) } : mixed;
  };
  return { bark, tonesAt };
}

function construct(seed: number): Built {
  const v = variant(seed, ID);
  const L = layout(v);
  const h = L.habit;
  const { bark, tonesAt } = pineTones(v);
  const WOOD = barkPaint(bark, { seed });
  // The cell scatter is per facet centre; on these big flat planks the
  // default reads as a few odd specks, so keep it small.
  const leaf = (tones: FoliageTones) => (normal: Vector3, center: Vector3): Paint => paint(foliageColor(tones, normal, center, { seed, scatter: 0.014 }), { gloss: 0.2, smooth: 0 });

  const m = new SolidMesh();
  const g = L.girth;
  const K = L.tiers.length;

  // Trunk and roots.
  limb(m, { path: L.trunk, radius: L.trunkRadius, sides: 6, levelBase: true, capBase: true, capTip: false, seed: seed * 7 + 1 }, WOOD);
  roots(m, { radius: g * 1.5, toes: L.toes, skirt: SKIRT, reach: g * 2.8, height: g * 2.3, seed: seed * 7 + 2, startDeg: v.range(35, 0, 360) }, WOOD);

  // Tiers, lowest first.
  const vb = v.fork('boughs');
  L.tiers.forEach((tier, k) => {
    const isTop = k === K - 1;
    const height = (isTop ? tier.rim + (L.tipY - tier.rim) * 0.62 : tier.apex) - tier.rim;
    const apexY = tier.rim + height;
    const apex = L.axis(apexY);
    // The rim rides downwind of the axis, alternately left and right of it.
    const centre = L.axis(tier.rim).add(new Vector3(tier.radius * h.wind * 0.6, 0, tier.radius * 0.08 * (k % 2 ? -1 : 1)));
    const n = tier.boughs;
    const step = Math.PI / n;
    const spin = (v.hero ? [20, 52, 8, 40, 30][k % 5] : vb.r.range(0, 360)) * DEG;
    const thick = 0.25 - 0.07 * tier.t;
    // The rim plane tilts up toward the lee, its azimuth staggered tier by
    // tier so the tiers do not stack like plates.
    const tiltAz = (k % 2 ? 25 : -25) * DEG;
    const tiltDir = new Vector3(Math.cos(tiltAz), 0, Math.sin(tiltAz));
    const tiltY = (u: Vector3): number => tier.radius * h.tilt * Vector3.Dot(u, tiltDir);
    // The knee: two fifths of the way out, three fifths of the way down —
    // steep off the axis, then flaring. All boughs of a ring share ONE knee
    // ring (irregular in radius and height, so the cap is no regular
    // pyramid); they part and go their own way only below it.
    const fr = isTop ? 0.46 : 0.42;
    const fy = isTop ? 0.52 : 0.6;
    const lift = (lee: number): number => height * 0.12 * h.wind * lee;
    const wr = wobble([vb.r.range(0, 6.3), vb.r.range(0, 6.3)]);
    const wy = wobble([vb.r.range(0, 6.3), vb.r.range(0, 6.3)]);
    const kneeAt = (az: number, sink: number, grow = 1): Vector3 => {
      const u = new Vector3(Math.sin(az), 0, Math.cos(az));
      const q = Vector3.Lerp(apex, centre, fr).add(u.scale((tier.radius * fr * grow * (1 + h.wind * 0.5 * u.x) * (1 + 0.1 * wr(az))) / Math.cos(step)));
      q.y = apexY - height * fy + (lift(u.x) + tiltY(u)) * fr - sink + height * 0.06 * wy(az);
      return q;
    };
    const upper: { a: number; reach: number }[] = [];
    for (const under of [false, true]) {
      // The top tier is the spire's hem: one ring.
      if (under && isTop) continue;
      const tones = leaf(tonesAt(tier.t, under ? 0.22 : 0));
      const sink = under ? thick : 0;
      const count = under ? underCount(n) : n;
      const half = Math.PI / count;
      let missed = false;
      for (let i = 0; i < count; i++) {
        const a = spin + (i * 2 + (under ? 0.7 : 0)) * half;
        const turnBy = vb.r.range(-0.3, 0.3) * half;
        const reachBy = vb.r.range(0.86, 1.06) * (under ? vb.r.range(0.92, 1.0) : 1);
        const droop = vb.r.range(0, 1);
        const w = vb.r.range(0.74, 0.88);
        const roll = vb.r.range(-0.14, 0.14);
        const skew = vb.r.range(-0.2, 0.2);
        // A ragged tree loses under planks, but never two side by side: a
        // double gap opens the hem onto the core.
        const drop: boolean = under && !v.hero && !missed && i < count - 1 && vb.r.chance(h.ragged);
        missed = drop;
        if (drop) continue;
        const az = a + turnBy;
        const u = new Vector3(Math.sin(az), 0, Math.cos(az));
        // +1 on the lee side, −1 into the wind.
        const lee = u.x;
        let reach = tier.radius * (1 + h.wind * 0.8 * lee) * reachBy;
        if (under) {
          // Never past the boughs above it at that azimuth: an under plank
          // that sticks out is a shelf, not a lower layer.
          let near = Infinity;
          for (const b of upper) {
            const d = Math.abs(((az - b.a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
            if (d < 2.2 * Math.PI / n) near = Math.min(near, b.reach);
          }
          if (near < Infinity) reach = Math.min(reach, near * 0.88);
        } else upper.push({ a: az, reach });
        const c2 = centre.add(u.scale(reach));
        c2.y = tier.rim + lift(lee) + tiltY(u) - height * (0.04 + h.droop * droop + (under ? 0.08 : 0));
        const kl = kneeAt(a - half, sink, under ? 0.98 : 1);
        const kr = kneeAt(a + half, sink, under ? 0.98 : 1);
        // Every plank still falls at least 23° from its knee: a long lee
        // bough on a tilted rim otherwise goes level and reads as a shelf.
        const k1 = kl.add(kr).scale(0.5);
        c2.y = Math.min(c2.y, k1.y - 0.42 * Math.hypot(c2.x - k1.x, c2.z - k1.z));
        bough(
          m,
          {
            c0: under ? null : apex,
            kl,
            kr,
            c2,
            w2: reach * Math.tan(half * (under ? 0.72 : w)),
            th1: thick * 1.2,
            th2: thick,
            roll,
            skew,
            clip: under ? 0.3 : 0.28,
          },
          tones,
        );
      }
    }
    // The core: a squat closed lump under the pyramid that the under ring's
    // planks start in, with a belly tucked up toward the trunk — from a low
    // camera the tier is a shaded mass, not the inside of an umbrella. It is
    // a little wider than the knee ring, so the mass under each rim reads
    // about a third of the tier's width.
    const belly = leaf(tonesAt(tier.t, 0.3));
    const sink = isTop ? thick * 1.05 : thick * 1.75;
    const ring: Vector3[] = [];
    for (let i = 0; i < n; i++) ring.push(kneeAt(spin + (i * 2 + 1) * step, sink, isTop ? 0.96 : 1.16));
    const crown = apex.subtract(UP.scale(0.12));
    const navel = Vector3.Lerp(apex, centre, fr);
    navel.y = apexY - height * fy - sink + height * 0.12;
    const middle = Vector3.Lerp(crown, navel, 0.5);
    for (let i = 0; i < n; i++) {
      for (const pole of [crown, navel]) {
        let pts = [pole, ring[i], ring[(i + 1) % n]];
        const c = pts[0].add(pts[1]).add(pts[2]).scale(1 / 3);
        if (Vector3.Dot(loopNormal(pts), c.subtract(middle)) < 0) pts = [pts[0], pts[2], pts[1]];
        m.fan(pts, belly(loopNormal(pts).normalize(), c));
      }
    }
  });

  // The spire: concave, six-sided, hooked downwind but still RISING at its
  // point (a flat hook reads as a beak or a gnome's hat), its foot inside
  // the top tier's boughs.
  const top = L.tiers[K - 1];
  const foot = L.trunk[L.trunk.length - 1];
  const rise = L.tipY - foot.y;
  const hook = Math.min(h.hook, top.radius * 0.8, rise * 0.5);
  const spire = bezierPath(
    foot,
    foot.add(new Vector3(-hook * 0.12, rise * 0.4, 0)),
    foot.add(new Vector3(hook * 0.45, rise * 0.72, hook * 0.05)),
    foot.add(new Vector3(hook, rise, hook * 0.15)),
    4,
  );
  const spireTones = leaf(tonesAt(1));
  limb(
    m,
    { path: spire, radius: (t) => top.radius * 0.5 * Math.pow(1 - t, 1.25), sides: 6, rough: 0.2, capTip: false, capBase: true, seed: seed * 7 + 3 },
    (f) => spireTones(f.normal, f.center),
  );

  if (L.mirror) m.mirror('z');
  if (L.turn) m.rotate('y', L.turn);
  const size = v.size(FIT, 0.08, 0.03);
  const fit = fitSize(m, { x: size.x * h.wide, y: size.y * h.tall, z: size.z * h.wide }, { recenter: false });
  // Rigid up to the lowest boughs; the upper tiers ride the wind
  // progressively more.
  sway(m, { from: L.tiers[0].rim * 0.7 * fit.scale[1], power: 1.5 });
  const built = { mesh: m, fit, layout: L };
  layouts.set(seed, { fit, layout: L });
  return built;
}

/** The last fit + layout per seed (pure values): the far model of a seed is
 * built right after its near model in the world props, and re-running the
 * whole near construction for two numbers is a third of the far build. */
const layouts = new Map<number, Omit<Built, 'mesh'>>();
const layoutOf = (seed: number): Omit<Built, 'mesh'> => layouts.get(seed) ?? construct(seed);

/**
 * The far model: the same tree's tiers — each a closed, lopsided skirt of
 * `n` boughs (a cone from the tier's apex to a rim of alternately long and
 * short bough ends, windswept and tilted like the near rim, closed under by
 * a shallow cone to the axis) in the tier's own tones, the top tier carried
 * up to the hooked tip — over the bare trunk's run to the lowest rim. Same
 * axis, lean, mirror, turn and fit as the near tree. Triangles: trunk 2·s,
 * tiers 2·n each (the upper half of the tiers 2·(n − 1)).
 */
function constructFar(seed: number, target: number): SolidMesh {
  const { fit, layout: L } = layoutOf(seed);
  const v = variant(seed, ID);
  const h = L.habit;
  const { bark, tonesAt } = pineTones(v);
  const m = new SolidMesh();
  const K = L.tiers.length;
  const sides = target >= 60 ? 5 : 4;
  // Trunk: foot to a little inside the lowest tier, where it shows.
  const into = L.tiers[0].rim + (L.tiers[Math.min(1, K - 1)].rim - L.tiers[0].rim) * 0.4;
  farStick(m, { path: [L.axis(-SKIRT), L.axis(into)], radius: [L.girth * 1.35, L.girth * 0.8], sides }, paint(bark.base, { gloss: 0.1, smooth: 16 }));
  shadeBark(m, bark, { seed });
  const n = Math.max(4, Math.floor((target - m.triangleCount) / K / 2));
  // The upper half of the tiers are the small ones: one bough fewer each
  // (while that leaves 4). 1,200+ pines a world — on quest this is 4
  // triangles a pine (≈ 5k a world) that pay for the far buildings.
  const boughs = (k: number): number => (k >= K / 2 && n >= 5 ? n - 1 : n);
  const top = L.tiers[K - 1];
  const hook = Math.min(h.hook, top.radius * 0.8);
  const spin = rng(seed, ID, 'far').range(0, 360) * DEG;
  L.tiers.forEach((tier, k) => {
    const isTop = k === K - 1;
    const height = (isTop ? L.tipY : tier.apex) - tier.rim;
    const apex = isTop ? L.axis(L.tipY).add(new Vector3(hook, 0, hook * 0.15)) : L.axis(tier.rim + height * 0.85);
    const centre = L.axis(tier.rim).add(new Vector3(tier.radius * h.wind * 0.6, 0, tier.radius * 0.08 * (k % 2 ? -1 : 1)));
    const tiltAz = (k % 2 ? 25 : -25) * DEG;
    const tiltDir = new Vector3(Math.cos(tiltAz), 0, Math.sin(tiltAz));
    const rim: Vector3[] = [];
    const n = boughs(k);
    for (let i = 0; i < n; i++) {
      const az = spin + k * 0.7 + (i / n) * Math.PI * 2;
      const u = new Vector3(Math.sin(az), 0, Math.cos(az));
      const long = i % 2 === 0 ? 1.06 : 0.9;
      const reach = tier.radius * (1 + h.wind * 0.8 * u.x) * long;
      const q = centre.add(u.scale(reach));
      q.y = tier.rim + tier.radius * h.tilt * Vector3.Dot(u, tiltDir) - height * (0.04 + h.droop * 0.5) * long;
      rim.push(q);
    }
    // Under the skirt: a shallow cone up to the axis, a fifth of the tier's
    // height over the rim — the shaded mass a low camera sees.
    const navel = L.axis(tier.rim + height * 0.2);
    const inside = Vector3.Lerp(navel, apex, 0.3);
    const tones = tonesAt(tier.t);
    const belly = tonesAt(tier.t, 0.3);
    for (let i = 0; i < n; i++) {
      const a = rim[i], b = rim[(i + 1) % n];
      outTri(m, apex, a, b, inside, (nn, c) => paint(foliageColor(tones, nn, c, { seed, scatter: 0.014 }), { gloss: 0.2, smooth: 0 }));
      outTri(m, navel, b, a, inside, (nn, c) => paint(foliageColor(belly, nn, c, { seed, scatter: 0.014 }), { gloss: 0.2, smooth: 0 }));
    }
  });
  if (L.mirror) m.mirror('z');
  if (L.turn) m.rotate('y', L.turn);
  applyFit(m, fit);
  return m;
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, layout: L } = construct(seed);
  // One trunk cylinder up into the second tier, centred on the trunk's
  // middle there so the swing stays inside it. The boughs do not block.
  const height = L.tiers[Math.min(1, L.tiers.length - 1)].rim;
  const mid = atHeight(L.trunk, height * 0.5);
  const x = mid.x;
  const z = mid.z * (L.mirror ? -1 : 1);
  const a = L.turn * DEG;
  return [
    {
      shape: 'cylinder',
      base: [(x * Math.cos(a) + z * Math.sin(a)) * fit.scale[0], 0, (-x * Math.sin(a) + z * Math.cos(a)) * fit.scale[2]],
      height: height * fit.scale[1],
      radius: L.girth * 1.2,
    },
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Switchback Pine',
  category: 'tree',
  size: SIZE,
  variants: 5,
  build: (seed) => construct(seed).mesh,
  buildFar: (seed, _scheme, target) => constructFar(seed, target),
  colliders,
  wind: true,
  triBudget: 1400,
  reference: {
    sheet: 'design-documents/environment-design-pack/trees/design-sheet.png',
    brief: 'design-documents/environment-design-pack/trees/t02-switchback-pine-brief.txt',
  },
};

export default asset;
