import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, adjustOklch, mixOklab, paint, rng } from '../../gfx/solid';
import { BARK, FOLIAGE } from '../palette';
import type { PropAsset } from '../types';
import { farBlob, groupMasses } from './farKit';
import { Polytope, barkPaint, barkTones, faceCenter, fitSize, foliageColor, foliageTones, limb, shadeFoliage, sway, variant } from './nature';
import type { FoliageTones, Variant } from './nature';

/**
 * V01 PUFF BUSH — a low, lopsided mound of five round faceted foliage puffs
 * on a fan of short cinnamon stems (vegetation/design-sheet.png, left).
 *
 * Parts list, measured off the sheet's front view at 175 px per meter (front
 * of the sheet = looking toward +z, the lab's yaw 0):
 *  - five principal puffs, each a ROUND faceted ball 0.75–0.95 m across (no
 *    flat undersides: this is a bush, not an umbrella): the top one over the
 *    middle and a little to the left, the big one on the right at two thirds
 *    of the height, a smaller one on the left, one low in front that hides
 *    most of the stems, one behind. Neighbours overlap by a third;
 *  - two small DARKER puffs on the ground line at the outside (the
 *    sheet's "optional silhouette accents"): they close the gap under the big
 *    puffs, so a low chase camera never sees daylight under the bush, and
 *    they are what gives the mound its jade foot;
 *  - three stems fanning from one root right of the middle, in front, into
 *    the front, right and top puffs — visible under the front puff only.
 * 350 triangles buy about a hundred facets, and only because none of them
 * is spent inside the mound (see `emitPuffs`): the principal puffs get
 * 13–22 each (most to the top, right and front ones the sheet shows),
 * crowded a little onto their outer side, the accents 7–9.
 *
 * Variants re-grow the mound: three to five puffs in the ring round a top
 * puff that may sit high (a dome), low and off to one side (a lopsided
 * spreader) or be missing (a low cushion); sizes and heights drawn again;
 * then the whole bush turned, maybe mirrored, and scaled UNIFORMLY to the
 * design's volume (see `habitSize`). Every puff is tipped 15–22° so none
 * has a level roof.
 */

const ID = 'v01-puff-bush';
const SIZE = { x: 1.8, y: 1.3, z: 1.5 };
const SKIRT = 0.07;
const BUDGET = 350;
// The facet search stops a few triangles short of the limit.
const SPEND = BUDGET - 4;

type V3 = [number, number, number];

interface Puff {
  at: V3;
  radii: V3;
  /** Carving planes: this puff's SHARE of the budget (the counts are scaled
   * together until the bush comes to 350 triangles). */
  facets: number;
  /** A small dark puff on the ground line. */
  accent?: boolean;
}

// The hero, sheet front view: x right, y up, z away from the viewer.
// Facet SHARES: the three puffs the sheet's front view is made of (top,
// right, front) get the most, the back puff — half hidden from every side —
// and the small accents the fewest.
const HERO: Puff[] = [
  { at: [-0.05, 0.9, 0.1], radii: [0.48, 0.4, 0.46], facets: 22 }, // top
  { at: [0.46, 0.66, 0.02], radii: [0.45, 0.39, 0.44], facets: 22 }, // right, the big one
  { at: [-0.5, 0.58, 0.02], radii: [0.4, 0.35, 0.4], facets: 17 }, // left
  { at: [-0.22, 0.46, -0.36], radii: [0.43, 0.36, 0.4], facets: 21 }, // front, low
  { at: [0.08, 0.54, 0.46], radii: [0.44, 0.38, 0.38], facets: 13 }, // back
  { at: [0.57, 0.19, -0.3], radii: [0.29, 0.29, 0.29], facets: 9, accent: true }, // front right
  { at: [-0.6, 0.17, -0.2], radii: [0.25, 0.25, 0.24], facets: 8, accent: true }, // front left
];
// Where the stems leave the ground — in the window between the front puff
// and the front-right accent — and where each one ends (inside a puff).
const HERO_ROOT: V3 = [0.12, 0, -0.3];
const HERO_STEMS: V3[] = [
  [-0.12, 0.42, -0.3],
  [0.1, 0.62, 0.0],
  [0.42, 0.5, -0.04],
];

interface Layout {
  puffs: Puff[];
  root: V3;
  /** Where each stem ends: inside a puff. */
  stems: V3[];
  /** Height of this habit against the design's (the box is fitted to it). */
  tall: number;
  mirror: boolean;
  turn: number;
}

function layout(v: Variant): Layout {
  const pose = v.fork('pose');
  const mirror = pose.chance(false, 0.5);
  const turn = pose.range(0, 0, 360);
  if (v.hero) return { puffs: HERO, root: HERO_ROOT, stems: HERO_STEMS, tall: 1, mirror, turn };

  const r = v.fork('mound').r;
  // The habit of this bush: 0 = dome (a big top puff high over the middle of
  // three or four), 1 = lopsided spreader (the top puff lower and well off
  // to the big side), 2 = cushion (no top puff: a ring of low puffs round a
  // broad middle one, a fifth lower than the design).
  const habit = (v.seed - 1) % 3;
  // (Every extra puff thins the facets of all the others: 350 triangles
  // stretch over six or seven balls, not eight.)
  const ringCount = habit === 2 ? r.int(4, 5) : habit === 0 ? r.int(3, 4) : 4;
  const puffs: Puff[] = [];
  const start = r.range(0, 360);
  // Tight enough that the ring closes over the middle puff: a wider ring
  // opens a crater onto the stems from above.
  const ringRadius = habit === 0 ? r.range(0.42, 0.48) : r.range(0.44, 0.5);
  // One side of the ring is the big side: the mound is never symmetric.
  const bigAt = r.range(0, 360);
  const plan = (deg: number, d: number): [number, number] => [Math.sin((deg * Math.PI) / 180) * d, Math.cos((deg * Math.PI) / 180) * d * 0.85];
  const angles: number[] = [];
  for (let i = 0; i < ringCount; i++) {
    const a = start + ((i + r.range(-0.16, 0.16)) / ringCount) * 360;
    angles.push(a);
    const big = 0.5 + 0.5 * Math.cos(((a - bigAt) * Math.PI) / 180);
    const size = 0.35 + 0.09 * big + r.range(-0.025, 0.025);
    const [x, z] = plan(a, ringRadius);
    // Bottoms 6–20 cm over the ground: a bush sits ON the ground (higher,
    // and it is a small tree on show stems).
    puffs.push({
      at: [x, size * 0.86 + 0.06 + 0.14 * big + r.range(0, 0.05), z],
      radii: [size * r.range(1.02, 1.14), size * r.range(0.84, 0.92), size * r.range(1.0, 1.1)],
      facets: 18,
    });
  }
  const [bx, bz] = plan(bigAt, 1);
  if (habit === 0) {
    const s = r.range(0.44, 0.5);
    puffs.unshift({ at: [bx * 0.1, r.range(0.88, 0.96), bz * 0.1], radii: [s, s * 0.82, s * 0.96], facets: 22 });
  } else if (habit === 1) {
    const s = r.range(0.44, 0.48);
    puffs.unshift({ at: [bx * 0.15, r.range(0.7, 0.76), bz * 0.15], radii: [s * 1.08, s * 0.86, s], facets: 22 });
  } else {
    // The cushion's middle: a broad low puff that plugs the hole in the ring.
    const s = r.range(0.42, 0.48);
    // (Not too flat: a squashed ball is a slab with a paving-stone roof.)
    puffs.unshift({ at: [bx * 0.12, r.range(0.62, 0.68), bz * 0.12], radii: [s * 1.04, s * 0.84, s], facets: 22 });
  }
  // Accents on the ground line: each in the gap between two ring puffs,
  // pushed outward just far enough to show and still be sunk into both.
  const gaps = r.shuffle(angles.map((_, i) => i)).slice(0, 2);
  for (const i of gaps) {
    const next = angles[(i + 1) % ringCount] + (i + 1 === ringCount ? 360 : 0);
    const a = (angles[i] + next) / 2 + r.range(-6, 6);
    const s = r.range(0.24, 0.3);
    const [x, z] = plan(a, ringRadius + r.range(0.02, 0.1));
    puffs.push({ at: [x, s * 0.7, z], radii: [s * 1.06, s, s], facets: 8, accent: true });
  }
  // Stems under the three principal puffs nearest the root.
  const [rx, rz] = plan(start + (0.5 / ringCount) * 360, 0.16);
  const root: V3 = [rx, 0, rz];
  const order = puffs
    .map((p, i) => ({ i, d: Math.hypot(p.at[0] - root[0], p.at[2] - root[2]) }))
    .filter((q) => !puffs[q.i].accent)
    .sort((a, b) => a.d - b.d);
  const stems = order.slice(0, 3).map(({ i }): V3 => {
    const p = puffs[i];
    return [p.at[0] * 0.8 + root[0] * 0.2, p.at[1] - p.radii[1] * 0.35, p.at[2] * 0.8 + root[2] * 0.2];
  });
  return { puffs, root, stems, tall: [1.02, 0.9, 0.8][habit], mirror, turn };
}

/** How far a puff reaches from its centre in unit direction `d`. */
function reach(p: Puff, d: Vector3): number {
  return Math.hypot(p.radii[0] * d.x, p.radii[1] * d.y, p.radii[2] * d.z);
}

// How far each puff of an overlapping pair runs on past the plane where the
// two would meet: they stay sunk into each other by twice this.
const SINK = 0.075;

/**
 * The puffs as one cluster: faceted lumps, one flat tone per facet — warm
 * top / cooler underside over the height of the whole bush, the accents in
 * their own deeper set — and facets that look into a neighbour pulled toward
 * the crease tone.
 *
 * WHERE THE TRIANGLES GO. Round puffs overlapping by a third bury a quarter
 * of their facets in each other, and the budget is 350. So each puff of an
 * overlapping pair is first cut flat just beyond the plane where the two
 * surfaces cross (the radical plane of the two balls): the dome it had inside
 * its neighbour becomes ONE face, which lies inside the neighbour and is
 * dropped by `emit`. The solids stay closed and still interpenetrate by
 * 2 × SINK, so the crease between two puffs looks exactly as before — but
 * every facet that is paid for is one that is seen. `lump(i)` hands over
 * puff i as a fresh uncut solid.
 */
function emitPuffs(m: SolidMesh, puffs: readonly Puff[], tones: FoliageTones, low: FoliageTones, seed: number, lump: (index: number) => Polytope): void {
  const solids = puffs.map((_, i) => lump(i));
  puffs.forEach((a, i) => {
    puffs.forEach((b, j) => {
      if (i === j) return;
      const d = new Vector3(b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]);
      const D = d.length();
      d.scaleInPlace(1 / D);
      const ra = reach(a, d);
      const rb = reach(b, d);
      if (D >= ra + rb - 2 * SINK) return;
      // Radical plane of the two balls, measured from a's centre; never cut
      // nearer the centre than a third of the radius (one puff deep inside
      // another keeps its shape and simply loses its buried faces).
      const cut = (D * D + ra * ra - rb * rb) / (2 * D) + SINK;
      if (cut < ra * 0.34 || cut > ra) return;
      try {
        solids[i].cut(d, [a.at[0] + d.x * cut, a.at[1] + d.y * cut, a.at[2] + d.z * cut], 'join');
      } catch {
        /* the plane misses this lump: nothing to save */
      }
    });
  });
  let yHigh = 0;
  for (const s of solids) yHigh = Math.max(yHigh, s.bounds().max.y);
  const surface = { gloss: 0.2, smooth: 0 };
  solids.forEach((s, i) => {
    const set = puffs[i].accent ? low : tones;
    const others = solids.filter((q) => q !== s);
    s.emit(
      m,
      (face) => {
        const c = faceCenter(face);
        // `emit` drops a face that lies inside ONE neighbour; in the middle
        // of the mound most buried faces lie inside two or three together.
        // Sampled densely for facets this size (corners, edge midpoints,
        // centre and the points between): all covered = never seen.
        const n = face.points.length;
        const samples = [c];
        for (let k = 0; k < n; k++) {
          const q = face.points[k];
          samples.push(q, Vector3.Lerp(q, face.points[(k + 1) % n], 0.5), Vector3.Lerp(q, c, 0.5));
        }
        if (samples.every((q) => others.some((o) => o.contains(q, 0.004)))) return null;
        let closed = 0;
        for (const k of [0.3, 0.65, 1]) {
          const probe = c.add(face.normal.scale(0.3 * k));
          if (others.some((q) => q.contains(probe))) closed += k === 0.3 ? 0.5 : 0.25;
        }
        return paint(foliageColor(set, face.normal, c, { yLow: 0.1, yHigh, seed, crease: closed }), surface);
      },
      solids,
    );
  });
}

/**
 * The box a variant is fitted to. Stretching a re-grown mound onto the
 * design's box per axis squashes its balls into slabs (a narrow dome pulled
 * out to 1.8 m wide is a stack of plates): so the natural box is scaled
 * UNIFORMLY to the volume of `target`, and only an axis that would leave the
 * lab's 30 % band for variants is brought back inside it.
 */
function habitSize(m: SolidMesh, target: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const b = m.bounds();
  const natural = { x: b.max.x - b.min.x, y: b.max.y, z: b.max.z - b.min.z };
  const s = Math.cbrt((target.x / natural.x) * (target.y / natural.y) * (target.z / natural.z));
  const within = (n: number, design: number): number => Math.min(Math.max(n * s, design * 0.8), design * 1.2);
  return { x: within(natural.x, SIZE.x), y: within(natural.y, SIZE.y), z: within(natural.z, SIZE.z) };
}

function bushTones(v: Variant): FoliageTones {
  // Undersides a step lighter than a tree's: a bush is seen from above and
  // its lower facets are half of what shows. Flanks and undersides lean a
  // few degrees cool: lime turned away from the warm sun reads olive, the
  // sheet's shade side is a saturated mid green.
  return foliageTones(v, {
    top: adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.highlight, 0.55), 0, 1, 3),
    mid: adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.36), 0.01, 1.06, 3),
    under: adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.5), 0.035, 1.14, 5),
  });
}

/**
 * The far model: the mound's puffs merged into one faceted ball, two with
 * 24+ triangles (k-means on the puff centres; each the box of its puffs), reaching
 * the ground, in this seed's tones, mirrored and turned like the near bush.
 * The world props fit it onto the near model's box (`fitSize` here depends on
 * the near mesh's own bounds).
 */
function constructFar(seed: number, target: number): SolidMesh {
  const v = variant(seed, ID);
  const L = layout(v);
  const tones = bushTones(v);
  const m = new SolidMesh();
  // Two-ring lumps (4n triangles): a faceted ball. One ring of the same
  // count is a bipyramid, and a bush of bipyramids is a pile of tents.
  const groups = groupMasses(L.puffs.map((p) => ({ at: p.at, radii: p.radii, bottom: Math.min(p.at[1] - p.radii[1], -SKIRT) })), target >= 24 ? 2 : 1, 0.95);
  const sides = Math.max(3, Math.floor(target / groups.length / 4));
  groups.forEach((g, i) => {
    farBlob(m, { at: g.at, radii: g.radii, sides, rings: 2, flat: (g.at.y - g.bottom) / g.radii.y, seed: seed * 13 + i, jitter: 0.4 }, paint(tones.mid, { gloss: 0.2, smooth: 0 }));
  });
  // One far facet is a whole puff's top: temper the yellow-lime as the oak does.
  shadeFoliage(m, { ...tones, top: mixOklab(tones.top, tones.mid, 0.35) }, { yLow: 0.1, yHigh: m.bounds().max.y, seed });
  if (L.mirror) m.mirror('x');
  if (L.turn) m.rotate('y', L.turn);
  return m;
}

function construct(seed: number): SolidMesh {
  const v = variant(seed, ID);
  const L = layout(v);
  const tones = bushTones(v);
  // The ground-line puffs: one step down the same ladder (the principal
  // puffs' flank green on top, a jade-leaning green below).
  const low = foliageTones(v, {
    top: mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.36),
    mid: adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.56), 0, 1.08),
    under: adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.7), 0, 1.08),
  });
  // The stems stand in the bush's own shade: a step up the bark ladder.
  const WOOD = barkPaint(barkTones(v, { base: mixOklab(BARK.base, BARK.highlight, 0.3), dark: BARK.base }), { seed });
  const m = new SolidMesh();

  // Stems: from one root under the ground into the puffs they carry, each
  // ending a little under its puff's centre.
  L.stems.forEach((end, i) => {
    const to = new Vector3(...end);
    // The feet stand side by side, square to the fan.
    const side = new Vector3(to.z - L.root[2], 0, -(to.x - L.root[0])).normalize().scale(0.03);
    const from = new Vector3(L.root[0], -SKIRT, L.root[2]).add(side.scale(i - 1));
    limb(m, { path: [from, to], radius: [0.07, 0.045], sides: 4, rough: 0.3, capTip: false, levelBase: true, seed: seed * 7 + i }, WOOD);
  });

  // The uncut puffs, carved once per (puff, facet count): the budget search
  // below asks for the same ones again and again.
  const middle = new Vector3();
  const mains = L.puffs.filter((p) => !p.accent);
  for (const p of mains) middle.addInPlace(new Vector3(...p.at));
  middle.scaleInPlace(1 / mains.length);
  const carved = new Map<number, Polytope>();
  const lump = (i: number, facets: number): Polytope => {
    const key = i * 1000 + facets;
    let solid = carved.get(key);
    if (!solid) {
      const p = L.puffs[i];
      // Facets go where they are seen: up and away from the middle of the
      // mound (accents show their outer flank more than their top).
      const away = new Vector3(p.at[0] - middle.x, 0, p.at[2] - middle.z).scale(1 / Math.max(p.radii[0], p.radii[2]));
      const focus = away.add(new Vector3(0, p.accent ? 0.35 : 0.7, 0));
      // Very low jitter and dent: a puff is a ROUND ball of EVEN facets (the
      // sheet's are near-regular pentagons and hexagons), not a cut gem or a
      // boulder with a few big planes.
      solid = Polytope.lump({ radii: p.radii, facets, seed: seed * 131 + i * 17 + 5, jitter: 0.15, dent: 0, focus, bias: 0.42 });
      // The spiral of carving planes always starts at the pole, which leaves
      // a LEVEL facet on top of every puff — a hat-box roof, read as a cut
      // boulder. Tipping each ball 15–22° about a horizontal axis puts an
      // edge or a slanted facet there instead.
      const tr = rng(seed, ID, 'tilt', i);
      const az = tr.range(0, 360) * DEG;
      solid.turn([Math.cos(az), 0, Math.sin(az)], tr.range(15, 22)).move(p.at);
      // What reaches under the ground is cut off level and left open there
      // ('inner' faces are never emitted): no triangles where nobody looks.
      if (solid.bounds().min.y < -SKIRT) solid.cut([0, -1, 0], [0, -SKIRT, 0], 'inner');
      carved.set(key, solid);
    }
    return solid.clone();
  };

  // Spend the budget to the last few triangles, whatever the layout buried: scale
  // every puff's facet count (`Puff.facets` is its share) down until the
  // bush fits, then hand the remainder back one facet at a time.
  const stems = m.mark();
  const build = (facets: readonly number[]): number => {
    m.truncate(stems);
    emitPuffs(m, L.puffs, tones, low, seed, (i) => lump(i, facets[i]));
    return m.triangleCount;
  };
  let facets: number[] = [];
  for (let detail = 1.5; detail > 0.5; detail -= 0.04) {
    facets = L.puffs.map((p) => Math.max(8, Math.round(p.facets * detail)));
    if (build(facets) <= SPEND) break;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < facets.length; i++) {
      const more = facets.map((f, k) => (k === i ? f + 1 : f));
      if (build(more) <= SPEND) facets = more;
    }
  }
  build(facets);

  if (L.mirror) m.mirror('x');
  if (L.turn) m.rotate('y', L.turn);
  const size = v.size(SIZE, 0.08, 0.06);
  fitSize(m, v.hero ? size : habitSize(m, { ...size, y: size.y * L.tall }));
  // The foot stays put, the puffs nod.
  sway(m, { from: 0.15, power: 1.3 });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Puff Bush',
  category: 'vegetation',
  size: SIZE,
  variants: 5,
  build: construct,
  buildFar: (seed, _scheme, target) => constructFar(seed, target),
  wind: true,
  triBudget: BUDGET,
  reference: {
    sheet: 'design-documents/environment-design-pack/vegetation/design-sheet.png',
    brief: 'design-documents/environment-design-pack/vegetation/v01-puff-bush-brief.txt',
  },
};

export default asset;
