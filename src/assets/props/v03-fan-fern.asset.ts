import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, adjustOklch, loopNormal, mixOklab, paint } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FOLIAGE } from '../palette';
import type { PropAsset } from '../types';
import { farTuft } from './farKit';
import { FOLIAGE_AMP, fitSize, sway, variant } from './nature';
import type { Variant } from './nature';

/**
 * V03 FAN FERN — a spreading rosette of six arching fronds, each a light
 * rachis carrying five pairs of blunt, forward-swept leaflets, rising from a
 * dark tuft of stalks (vegetation/design-sheet.png, third column).
 *
 * Parts list, measured off the sheet (front = looking toward +z; the sheet's
 * lower drawing is an elevated view, so the plan here is a true radial one,
 * as the brief asks):
 *  - the heart: a dark-green tuft about 0.17 m across and 0.2 m high where
 *    the stalks gather — from above it closes the middle of the rosette;
 *  - six fronds from it, 0.74–1.0 m along the curve. Two stand tall (back
 *    left and back right, tips at 0.85 m), two arch out to the left and right
 *    (the 1.25 m width), two come forward and arch down to half height;
 *  - a frond: LANCEOLATE, 0.42–0.46 m across at its widest (45 % of its
 *    length, a little before the middle), under half that at the first
 *    pair, a quarter at the last, ending in a pointed end leaflet 1.5
 *    pitches long. Leaflet pairs 10–13 cm apart;
 *  - a leaflet: a blunt tongue about twice as long as it is wide, joined to
 *    the rachis over the whole pitch and swept half a pitch toward the tip,
 *    the pair lifted into a shallow V. The notch to the next leaflet is a
 *    slit that opens only toward the ends: a frond reads as ONE notched
 *    blade, not a ladder of plates;
 *  - the rachis: a light lime strip about 3 cm wide from the stalk to the
 *    end leaflet — the sheet's signature line on every frond.
 *
 * WHERE THE TRIANGLES GO (350): a leaflet is one quad on top and one under
 * it, sharing the rim corners (8 a pair); the rachis strip is 2 a pitch; the
 * end leaflet 3; the stalk a 3-sided spike; the heart a 7-sided cone. Six
 * fronds of five pairs + heart = 343.
 *
 * Variants: five or six fronds, re-drawn in length, lift, bend and roll; a
 * rosette that stands up like a shuttlecock, one that lies open and low, and
 * a lopsided one with a gap on one side; broader or slimmer fronds (a
 * five-frond fern gets a sixth pair on each); and the colour mood.
 */

const ID = 'v03-fan-fern';
const SIZE = { x: 1.25, y: 0.85, z: 1.1 };
const BUDGET = 350;
const SKIRT = 0.05;

interface Frond {
  /** Compass heading, degrees (0 = +z, 90 = +x). */
  yaw: number;
  /** Along the curve, above ground. */
  length: number;
  /** Elevation at the root, degrees. */
  lift: number;
  /** Total bend from root to tip, degrees. */
  droop: number;
  /** Where the bend sits: 1.5 = an even arch, 2.2 = a straight frond that
   * bows over toward its tip. */
  bias: number;
  /** Widest width over the leaflet ends. */
  width: number;
  /** Leaflet pairs. */
  pairs: number;
  /** Roll about the midrib, degrees (shows the frond's face or its edge). */
  roll: number;
}

// The hero. The sheet's front view looks toward +z (the lab's yaw 0), so the
// two tall fronds lean away from it (back, +z) and show their tops, the
// two forward ones arch toward the viewer (−z). Fronds rise steeply and arch
// over evenly (bias ≈ 1.5), like the sheet's — not straight sticks that curl
// only at the tip. The side pair is rolled a little toward the front: the
// sheet shows their faces, not their edges.
const HERO: Frond[] = [
  { yaw: 336, length: 1.04, lift: 87, droop: 100, bias: 1.8, width: 0.46, pairs: 5, roll: -10 }, // tall, back left
  { yaw: 26, length: 1.0, lift: 86, droop: 104, bias: 1.8, width: 0.45, pairs: 5, roll: 12 }, // tall, back right
  { yaw: 274, length: 0.92, lift: 70, droop: 120, bias: 1.5, width: 0.44, pairs: 5, roll: 16 }, // out to the left
  { yaw: 92, length: 0.94, lift: 68, droop: 122, bias: 1.5, width: 0.44, pairs: 5, roll: -16 }, // out to the right
  { yaw: 210, length: 0.88, lift: 64, droop: 124, bias: 1.4, width: 0.42, pairs: 5, roll: -6 }, // forward left
  { yaw: 152, length: 0.9, lift: 66, droop: 122, bias: 1.4, width: 0.42, pairs: 5, roll: 6 }, // forward right
];

function layout(v: Variant): Frond[] {
  if (v.hero) return HERO;
  const r = v.fork('rosette').r;
  // 0 shuttlecock (everything stands) · 1 open and low · 2 lopsided (a gap
  // on one side, the fronds opposite it longer).
  const habit = (v.seed - 1) % 3;
  // Six fronds of five pairs fill the budget; a five-frond fern buys a
  // sixth pair on every frond instead.
  const count = [r.int(5, 6), 6, r.int(5, 6)][habit];
  const start = r.range(0, 360);
  const gapAt = r.range(0, 360);
  const broad = r.range(0.92, 1.08);
  const fronds: Frond[] = [];
  for (let i = 0; i < count; i++) {
    let yaw = start + ((i + r.range(-0.2, 0.2)) / count) * 360;
    // Every other frond stands taller: two tiers, as on the sheet.
    const tall = i % 2 === 0;
    // Even arches, as the hero: steep at the root, over the top, tips down.
    let lift = tall ? r.range(84, 88) : r.range(64, 72);
    let droop = tall ? r.range(94, 108) : r.range(116, 128);
    let bias = tall ? r.range(1.7, 1.9) : r.range(1.4, 1.5);
    let length = tall ? r.range(0.96, 1.06) : r.range(0.86, 0.94);
    if (habit === 0) {
      // Shuttlecock: everything stands, only the ends nod over.
      lift = tall ? r.range(86, 89) : r.range(76, 81);
      droop = tall ? r.range(72, 86) : r.range(96, 110);
      bias = tall ? 1.9 : 1.7;
      length *= tall ? 0.96 : 1.04;
    } else if (habit === 1) {
      // Open and low: the fronds lie out over the ground.
      lift = tall ? r.range(74, 79) : r.range(56, 62);
      droop = tall ? r.range(108, 120) : r.range(112, 124);
      bias = tall ? 1.6 : 1.4;
      length *= tall ? 1.0 : 0.96;
    } else {
      // Squeeze the headings away from the gap; the far side grows longer.
      const off = ((yaw - gapAt + 540) % 360) - 180;
      yaw = gapAt + 180 + off * 0.68;
      length *= Math.abs(off) < 70 ? 1.06 : 0.92;
    }
    fronds.push({ yaw, length, lift, droop, bias, width: r.range(0.42, 0.46) * broad, pairs: 5, roll: r.range(-14, 14) });
  }
  return fronds;
}

/** Triangles of one frond: per leaflet pair 8 (each leaflet a top and an
 * underside quad) plus 2 for the rib strip over that pitch; 3 for the end
 * leaflet (one top, two underside) and 3 for the stalk. */
const cost = (f: Frond): number => f.pairs * 10 + 6;
/** The heart: a faceted dark cone that plugs the middle of the rosette. */
const CROWN_SIDES = 7;

interface FrondColors {
  /** The rachis strip on top, root and tip end. */
  rib: RGB;
  ribTip: RGB;
  /** Leaflets near the root and near the frond's tip. */
  leaf: RGB;
  leafTip: RGB;
  /** Undersides, root and tip end (the same gradient, a step cooler). */
  under: RGB;
  underTip: RGB;
  /** The fold line under the rachis. */
  underRib: RGB;
  stalk: RGB;
  /** Where the stalk runs into the frond. */
  stalkTop: RGB;
}

/** A point and a frame on a frond's centre line at t = 0 (root) … 1 (tip). */
interface Station {
  at: Vector3;
  tan: Vector3;
  side: Vector3;
  up: Vector3;
}

/** The centre line: leaves the root at `lift`, bends over by `droop`. */
function midrib(f: Frond): (t: number) => Station {
  const yaw = f.yaw * DEG;
  const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const level = new Vector3(dir.z, 0, -dir.x);
  const total = f.length + SKIRT;
  const STEPS = 40;
  const pts: Vector3[] = [new Vector3(dir.x * 0.03, -SKIRT, dir.z * 0.03)];
  const pitchAt = (t: number): number => (f.lift - f.droop * Math.pow(t, f.bias)) * DEG;
  for (let i = 0; i < STEPS; i++) {
    const pitch = pitchAt((i + 0.5) / STEPS);
    pts.push(pts[i].add(dir.scale((Math.cos(pitch) * total) / STEPS)).add(new Vector3(0, (Math.sin(pitch) * total) / STEPS, 0)));
  }
  const roll = f.roll * DEG;
  return (t) => {
    const x = Math.min(Math.max(t, 0), 1) * STEPS;
    const i = Math.min(STEPS - 1, Math.floor(x));
    const pitch = pitchAt(Math.min(Math.max(t, 0), 1));
    const tan = dir.scale(Math.cos(pitch)).add(new Vector3(0, Math.sin(pitch), 0));
    const up0 = Vector3.Cross(tan, level);
    return {
      at: Vector3.Lerp(pts[i], pts[i + 1], x - i),
      tan,
      side: level.scale(Math.cos(roll)).add(up0.scale(Math.sin(roll))),
      up: up0.scale(Math.cos(roll)).subtract(level.scale(Math.sin(roll))),
    };
  };
}

// Where the leaflets start along the frond (the rest below is bare stalk,
// mostly inside the heart).
const STALK = 0.2;
/** The end leaflet is this many pitches long. */
const END = 1.5;
/** Tilt of the leaflets out of the frond's plane, degrees. NEGATIVE: the
 * leaflets fall away from the rachis like the sheet's, which curl down at
 * their ends — the frond is a low tent with the light rachis on its ridge,
 * and an arching frond shows its top to a viewer beside it. */
const DIHEDRAL = -9;
/** How far a leaflet's outer edge sits toward the frond's tip from its root
 * edge, in pitches (≈ 12° of sweep), and how long that outer edge is. */
const SWEEP = 0.35;
const OUTER = 0.84;
/** Half width of the rachis strip, meters (the sheet's light midrib reads at
 * about 3 cm across). */
const RIB = 0.014;
/** The rachis strip stands this far over the centre line, the fold line of
 * the underside as far under it: a 4 mm lens that closes at every leaflet
 * rim (top and underside share the rim corners — no slit to see sky through). */
const LENS = 0.002;

/** Half width of the frond at u = 0 (first pair) … 1 (last pair), as a
 * fraction of the widest: lanceolate, like the sheet — narrow at the base,
 * widest a little before the middle, a third at the last pair. */
function envelope(u: number): number {
  return u < 0.4 ? 0.5 + 0.5 * Math.sin((u / 0.4) * Math.PI * 0.5) : 1 - 0.55 * Math.pow((u - 0.4) / 0.6, 1.7);
}

/**
 * One frond as a continuous NOTCHED blade. Each leaflet is a quad whose root
 * edge spans the whole pitch along the rachis (so neighbours share their
 * root corners: no gaps at the rachis) and whose outer edge, 0.8 of a pitch
 * long, sits half a pitch further toward the tip — a blunt tongue swept
 * forward, with a narrow slit-like notch to the next one that opens only
 * near the ends. Down the middle runs the rachis: a light strip of its own,
 * so it is a crisp line, not a colour smear across the leaflets.
 */
function frond(m: SolidMesh, f: Frond, c: FrondColors, LEAF: Paint, STEM: Paint): void {
  const rib = midrib(f);
  const n = f.pairs;
  const total = f.length + SKIRT;
  // Along-frond fractions: leaflets from STALK to the end leaflet's base.
  const pitch = (1 - STALK) / (n + END);
  const tOf = (s: number): number => STALK + pitch * s;
  // Fraction along the leafy part (0 at the first pair, 1 at the tip), for
  // the colour gradient.
  const g = (s: number): number => Math.min(1, Math.max(0, s / (n + END)));
  const rise = Math.tan(DIHEDRAL * DEG);
  const face = (pts: Vector3[], cols: RGB[], dir: Vector3, p: Paint = LEAF): void => {
    const ok = Vector3.Dot(loopNormal(pts), dir) >= 0;
    const q = ok ? pts : [...pts].reverse();
    const qc = ok ? cols : [...cols].reverse();
    if (q.length === 3) m.tri(q[0], q[1], q[2], p, qc);
    else m.quad(q[0], q[1], q[2], q[3], p, qc);
  };
  // Top of the strip edge (sign ±1), the fold line under it, and a leaflet
  // corner `reach` out to the side, lifted into the V.
  const strip = (s: number, sign: number): Vector3 => {
    const q = rib(tOf(s));
    return q.at.add(q.side.scale(sign * RIB)).add(q.up.scale(LENS));
  };
  const fold = (s: number): Vector3 => {
    const q = rib(tOf(s));
    return q.at.subtract(q.up.scale(LENS));
  };
  const corner = (s: number, reach: number): Vector3 => {
    const q = rib(tOf(s));
    return q.at.add(q.side.scale(reach)).add(q.up.scale(Math.abs(reach) * rise + LENS));
  };
  const leafAt = (s: number): RGB => mixOklab(c.leaf, c.leafTip, g(s));
  const underAt = (s: number): RGB => mixOklab(c.under, c.underTip, g(s));
  const ribAt = (s: number): RGB => mixOklab(c.rib, c.ribTip, g(s));
  const half = f.width / 2;
  for (let j = 0; j < n; j++) {
    const a = rib(tOf(j));
    const reach = half * envelope(n > 1 ? j / (n - 1) : 0);
    // The rachis strip over this pitch.
    face([strip(j, -1), strip(j, 1), strip(j + 1, 1), strip(j + 1, -1)], [ribAt(j), ribAt(j), ribAt(j + 1), ribAt(j + 1)], a.up);
    for (const sign of [-1, 1]) {
      // The blunt end: the leading corner a little short of the trailing
      // one, so the tongue reads rounded off rather than cut square.
      const near = corner(j + 0.5 + SWEEP - OUTER / 2, sign * reach);
      const far = corner(j + 0.5 + SWEEP + OUTER / 2, sign * reach * 0.93);
      const up = a.up.add(a.side.scale(-sign * rise));
      const tn = j + 0.5 + SWEEP - OUTER / 2;
      const tf = j + 0.5 + SWEEP + OUTER / 2;
      face([strip(j, sign), strip(j + 1, sign), far, near], [leafAt(j), leafAt(j + 1), leafAt(tf), leafAt(tn)], up);
      // Underside: from the fold line out to the SAME rim corners.
      face([fold(j), fold(j + 1), far, near], [c.underRib, c.underRib, underAt(tf), underAt(tn)], up.scale(-1));
    }
  }
  // The end leaflet: a pointed tongue, flat across (no V — its base edge has
  // to carry the end of the rachis strip without a step), folded underneath.
  const endLen = END * pitch * total;
  const tw = Math.min(endLen * 0.26, half * 0.4);
  const base = rib(tOf(n));
  const lift = base.up.scale(LENS);
  const L = base.at.add(base.side.scale(-tw)).add(lift);
  const R = base.at.add(base.side.scale(tw)).add(lift);
  const tip = rib(1).at.add(rib(1).up.scale(LENS * 0.5));
  face([L, R, tip], [leafAt(n), leafAt(n), c.leafTip], base.up);
  face([L, fold(n), tip], [underAt(n), c.underRib, c.underTip], base.up.scale(-1));
  face([fold(n), R, tip], [c.underRib, underAt(n), c.underTip], base.up.scale(-1));
  // Stalk: a three-sided spike from under the ground to a point just under
  // the fold at the first leaflets — one flat on top, the edge underneath.
  const foot = rib(0);
  const point = fold(0.35).subtract(rib(tOf(0.35)).up.scale(0.004));
  const Rs = 0.045;
  const ring = [-150, -30, 90].map((deg) => foot.at.add(foot.side.scale(Math.cos(deg * DEG) * Rs)).subtract(foot.up.scale(Math.sin(deg * DEG) * Rs + Rs * 0.5)));
  const axis = ring[0].add(ring[1]).add(ring[2]).scale(1 / 3);
  for (let k = 0; k < 3; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % 3];
    if (Vector3.Dot(loopNormal([a, b, point]), a.add(b).scale(0.5).subtract(axis)) >= 0) m.tri(a, b, point, STEM, [c.stalk, c.stalk, c.stalkTop]);
    else m.tri(a, point, b, STEM, [c.stalk, c.stalkTop, c.stalk]);
  }
}

/** The heart of the rosette: a faceted cone of dark stalk green, so the
 * middle is a dense tuft from above instead of a funnel onto the ground. */
function crown(m: SolidMesh, radius: number, height: number, p: Paint, base: RGB, top: RGB): void {
  const apex = new Vector3(0, height, 0);
  for (let k = 0; k < CROWN_SIDES; k++) {
    const a0 = ((k + 0.5) / CROWN_SIDES) * 360 * DEG;
    const a1 = ((k + 1.5) / CROWN_SIDES) * 360 * DEG;
    const A = new Vector3(Math.sin(a0) * radius, -SKIRT, Math.cos(a0) * radius);
    const B = new Vector3(Math.sin(a1) * radius, -SKIRT, Math.cos(a1) * radius);
    const out = A.add(B).scale(0.5);
    out.y = 0;
    if (Vector3.Dot(loopNormal([A, B, apex]), out) >= 0) m.tri(A, B, apex, p, [base, base, top]);
    else m.tri(A, apex, B, p, [base, top, base]);
  }
}

/**
 * The box a variant is fitted to. A habit has its own proportions (a lax
 * clump is wide and low, an upright one narrow and tall) and stretching it
 * onto the design's box would undo exactly that: so the natural box is
 * scaled UNIFORMLY to the volume of `target`, and only an axis that would
 * leave the lab's size band for variants (30 %, skirt included) is brought
 * back to its edge.
 */
function habitSize(m: SolidMesh, target: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const b = m.bounds();
  const natural = { x: b.max.x - b.min.x, y: b.max.y, z: b.max.z - b.min.z };
  const s = Math.cbrt((target.x / natural.x) * (target.y / natural.y) * (target.z / natural.z));
  const within = (n: number, design: number, most: number): number => Math.min(Math.max(n * s, design * 0.78), design * most);
  return { x: within(natural.x, SIZE.x, 1.22), y: within(natural.y, SIZE.y, 1.15), z: within(natural.z, SIZE.z, 1.22) };
}

function construct(seed: number): SolidMesh {
  const v = variant(seed, ID);
  let fronds = layout(v);
  // Hold the budget whatever was drawn: first trim the longest fronds to
  // five pairs, then drop fronds.
  const room = BUDGET - CROWN_SIDES;
  const total = (list: readonly Frond[]): number => list.reduce((sum, f) => sum + cost(f), 0);
  for (let pass = 0; pass < 12 && total(fronds) > room; pass++) {
    const most = Math.max(...fronds.map((f) => f.pairs));
    if (most <= 5) break;
    const i = fronds.findIndex((f) => f.pairs === most);
    fronds = fronds.map((f, k) => (k === i ? { ...f, pairs: f.pairs - 1 } : f));
  }
  while (total(fronds) > room) fronds = fronds.slice(0, -1);
  // …and what is left over buys leaflet pairs for the longest fronds.
  for (const f of [...fronds].sort((a, b) => b.length - a.length)) {
    if (f.pairs < 7 && total(fronds) + 10 <= room) fronds = fronds.map((g) => (g === f ? { ...g, pairs: g.pairs + 1 } : g));
  }

  // The fern is the pack's plain MID green, between the bush's lime and the
  // pine's jade (the sheet's third-from-right swatch), with a light lime
  // rachis and lime-leaning frond ends that lift it off a green lawn.
  const green = adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.66), 0.02, 1.14);
  const leaf = v.tint(green, FOLIAGE_AMP);
  const leafTip = v.tint(mixOklab(green, FOLIAGE.lime, 0.5), FOLIAGE_AMP);
  const rib = v.tint(mixOklab(FOLIAGE.lime, FOLIAGE.highlight, 0.35), FOLIAGE_AMP);
  const ribTip = v.tint(mixOklab(FOLIAGE.lime, FOLIAGE.highlight, 0.6), FOLIAGE_AMP);
  // Undersides only ever see the ground's bounce light: their albedo is the
  // top's gradient a few degrees cooler and a little LIGHTER, so the back of
  // a frond lands on a saturated mid green, not a dark shingle.
  // (Cooler as well: the warm sun never reaches them and the cool fill
  // turns a yellow-leaning green olive.)
  const under = v.tint(adjustOklch(mixOklab(green, FOLIAGE.jade, 0.25), 0.07, 1.2, 6), FOLIAGE_AMP);
  const underTip = v.tint(adjustOklch(mixOklab(green, FOLIAGE.lime, 0.25), 0.07, 1.16, 4), FOLIAGE_AMP);
  // The fold under the rachis: a lighter line of the same cool green (a lime
  // fold would smear the shade side toward olive).
  const underRib = v.tint(adjustOklch(mixOklab(green, FOLIAGE.lime, 0.3), 0.08, 1.12, 2), FOLIAGE_AMP);
  // Stalks and heart: darker than the leaf (the sheet's tuft of stems).
  const stalk = v.tint(adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.8), -0.02, 1.08), FOLIAGE_AMP);
  // Smooth toy leaves: the shallow fold at the midrib (2 × DIHEDRAL) and the
  // joints along the frond are under the crease angle, so a frond shades as
  // one softly troughed surface with notches cut into it.
  const LEAF = paint(leaf, { gloss: 0.3, smooth: 40 });
  const STEM = paint(stalk, { gloss: 0.25, smooth: 0 });
  const cr = v.r.fork('colour');

  const m = new SolidMesh();
  crown(m, 0.095, v.num(0.21, 0.03), STEM, stalk, mixOklab(stalk, green, 0.4));
  for (const f of fronds) {
    // Each frond its own small step in value and hue, so they separate.
    const k = cr.range(-1, 1);
    const own = (c: RGB): RGB => adjustOklch(c, k * 0.02, 1, k * 3);
    frond(
      m,
      f,
      { rib: own(rib), ribTip: own(ribTip), leaf: own(leaf), leafTip: own(leafTip), under: own(under), underTip: own(underTip), underRib: own(underRib), stalk, stalkTop: own(mixOklab(stalk, leaf, 0.6)) },
      LEAF,
      STEM,
    );
  }
  fitSize(m, v.hero ? SIZE : habitSize(m, v.size(SIZE, 0.1, 0.08)));
  // Root-pinned: the crown hardly moves, the frond ends nod.
  sway(m, { from: 0.1, power: 1.6 });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Fan Fern',
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
    brief: 'design-documents/environment-design-pack/vegetation/v03-fan-fern-brief.txt',
  },
};

export default asset;
