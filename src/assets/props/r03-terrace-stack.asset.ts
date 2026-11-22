import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, paint, rng, scaling } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import { Polytope, fitPoint, fitSize, rockChunk, stonePaint, stoneTones, variant } from './nature';
import type { Fit, MoundRing, StoneShade, StoneTones, Variant } from './nature';

/**
 * R03 TERRACE STACK — a wide, low outcrop of three ledges that rise like
 * fanned coins from the front-left to the back-right, with a big slate
 * boulder against the front-right (large-rocks/design-sheet.png, right).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - three LEDGES, each a rounded six- or seven-sided slab with a near-level
 *    cream top, a third, two thirds and the whole of the height. Each stands
 *    on the ground and is sunk into the next, so what shows of a ledge is a
 *    cream crescent and a band of wall two thirds of a meter tall. That band
 *    carries the sheet's flank facets: walls at UNEVEN spacing, each with its
 *    own lean, and between some of them waist planes starting at their own
 *    heights — trapezoids and triangles of unequal size, never a pattern;
 *  - the cream is the three tops and those of their bevels that stay near
 *    level; the steeper bevels are the pale band under each rim;
 *  - the BOULDER: an angular slate mass two thirds of the height, nine big
 *    facets under a 38° top, run in under the mid and top ledges at the
 *    front-right so the plan is one compact outcrop. No cream: the ledges
 *    own it;
 *  - the back (the sheet draws none): the top ledge's back walls spread
 *    toward the ground and break at about 1.2 m into a pale sloping
 *    shoulder, and a slate block 1.4 m tall stands straight behind it — so
 *    from behind the outcrop is a stair too, not a two-meter drum.
 *
 * Variants keep the three steps and vary the rest: the direction the stair
 * climbs in, how far the coins are fanned and whether the top one is swung
 * aside, each ledge's size, height, side count, facets and tilt, where the
 * boulder sits, and a stronger colour mood than the stone default (told
 * apart at a distance). Odd seeds are the mirror image.
 */

const ID = 'r03-terrace-stack';
const SIZE = { x: 4.2, y: 2.1, z: 3.0 };
// Four meters across: on a 5° slope the ground drops a third of a meter
// under it.
const SKIRT = 0.16;
const DEG = Math.PI / 180;
// Measured by the lab with the buried skirt: 1.98 + 0.16 = 2.14 m.
const FIT = { x: 4.2, y: 1.98, z: 3.0 };
// What shows of a ledge above the one below.
const BAND = 0.66;
const BUDGET = 300;

// Five big facets round the foot and four above: an angular mass with
// big pentagonal faces, not a gumdrop of concentric rings.
const BOULDER_RINGS: MoundRing[] = [
  { count: 5, pitch: 14, at: 0 },
  { count: 4, pitch: 40, at: 0.48 },
];
const BACK_RINGS: MoundRing[] = [
  { count: 6, pitch: 15, at: 0 },
  { count: 5, pitch: 40, at: 0.55 },
];

type V3 = [number, number, number];

interface Ledge {
  /** Centre of the footprint. */
  at: [number, number];
  /** Half extents of the footprint, and the height of the top. */
  rx: number;
  rz: number;
  height: number;
  /** Extra lean of the walls facing the back, degrees: the taller the
   * ledge, the more its back spreads (a sheer 2 m drum is a tree stump). */
  flare: number;
}

interface Lump {
  at: V3;
  radii: V3;
}

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  mirror: number;
  ledges: Ledge[];
  boulders: Lump[];
}

/** Unit normal of a plane tilted `tilt` degrees from level, falling toward
 * compass direction `toward`. */
function tilted(tilt: number, toward: number): Vector3 {
  const t = tilt * DEG;
  const a = toward * DEG;
  return new Vector3(Math.sin(a) * Math.sin(t), Math.cos(t), Math.cos(a) * Math.sin(t));
}

/** Where a ray from the ledge's axis toward compass `az` at height `y`
 * leaves the solid, as a distance along that direction. */
function reachAt(p: Polytope, az: number, y: number): number {
  const d = new Vector3(Math.sin(az * DEG), 0, Math.cos(az * DEG));
  try {
    const q = p.surface([0, y, 0], d);
    return q.x * d.x + q.z * d.z;
  } catch {
    return 0;
  }
}

/**
 * `Polytope.clip` restricted to real corners — where the faces that meet
 * turn at least 40° against each other. At the start of a waist plane (a
 * few degrees off the wall under it) the mean normal is the wall's own, and
 * a "clip" there shaves the whole wall off. Rim corners are fair game: a
 * clip across the cream's edge is one of the sheet's broken corners.
 */
function clipCorners(p: Polytope, count: number, size: number, seed: number, above: number): void {
  const r = rng(seed, 'clipCorners');
  interface Corner {
    at: Vector3;
    n: Vector3;
    normals: Vector3[];
    skip: boolean;
  }
  const corners: Corner[] = [];
  for (const f of p.faces) {
    for (const q of f.points) {
      let c = corners.find((k) => Vector3.DistanceSquared(k.at, q) < 1e-10);
      if (!c) {
        c = { at: q, n: new Vector3(), normals: [], skip: false };
        corners.push(c);
      }
      c.n.addInPlace(f.normal);
      c.normals.push(f.normal);
      if (f.tag === 'base' || f.tag === 'inner') c.skip = true;
    }
  }
  const sharp = (c: Corner): boolean => c.normals.some((a) => c.normals.some((b) => Vector3.Dot(a, b) < Math.cos(40 * DEG)));
  const picked: Corner[] = [];
  for (const c of r.shuffle(corners.filter((k) => !k.skip && k.at.y > above && sharp(k)))) {
    if (picked.length >= count) break;
    if (picked.some((k) => Vector3.Distance(k.at, c.at) < size * 3)) continue;
    picked.push(c);
  }
  for (const c of picked) {
    const n = c.n.clone().normalize();
    try {
      p.cut(n, c.at.subtract(n.scale(size * r.range(0.7, 1.2))), 'clip');
    } catch {
      /* a clip larger than the piece: skip it */
    }
  }
  p.tidy();
}

/**
 * One ledge: a slab standing on the ground under a near-level cream top
 * with bevelled edges. Its flanks are the sheet's unequal facets, not a
 * pattern: `sides` foot walls at uneven spacing, each with its own lean,
 * and between some of them a waist plane that starts at its own height in
 * the visible band and leans further in — so the band shows trapezoids
 * where a wall runs up to the rim and triangles where a waist plane takes
 * over, in no repeating order. Walls facing `backAz` (± 70°) lean `flare`
 * further: the tall ledge's back spreads into a foot instead of standing
 * as a two-meter drum.
 */
function ledge(v: Variant, l: Ledge, sides: number, seed: number, clips: number, backAz: number): Polytope {
  const p = Polytope.block(l.height + 0.5, SKIRT);
  const spin = v.range(14, 0, 360);
  // Uneven spacing: each gap drawn between half and one and a half steps.
  const gaps: number[] = [];
  for (let i = 0; i < sides; i++) gaps.push(v.r.range(0.55, 1.45));
  const total = gaps.reduce((a, b) => a + b, 0);
  let acc = 0;
  const azs: number[] = [];
  for (const g of gaps) {
    azs.push(spin + (acc / total) * 360);
    acc += g;
  }
  const back = (az: number): number => Math.max(0, Math.cos((az - backAz) * DEG) - 0.55) / 0.45;
  // The footprint ellipse is the outline at the middle of the visible band
  // (what the top view shows); below that the walls spread on down.
  const mid = l.height - BAND / 2;
  for (const az of azs) {
    const sx = Math.sin(az * DEG);
    const sz = Math.cos(az * DEG);
    // Footprint radius this way.
    const rho = (l.rx * l.rz) / Math.hypot(l.rz * sx, l.rx * sz);
    // Short ledges may lean more; a tall one leaning 10° from mid-band
    // would spread half a meter at the ground.
    const lean = (l.height < 1 ? v.r.range(6, 14) : v.r.range(3, 9)) + l.flare * back(az);
    p.wall(az, rho * v.r.range(0.94, 1), lean, mid, 'flank');
  }
  // Waist planes between the walls, at their own heights in the band.
  const bandLow = Math.max(0.12, l.height - BAND);
  for (let i = 0; i < azs.length; i++) {
    // The low ledge is the one seen whole from the front: it gets most.
    if (!v.r.chance(l.height < 1 ? 0.9 : 0.5)) continue;
    const next = i + 1 < azs.length ? azs[i + 1] : azs[0] + 360;
    const az = azs[i] + (next - azs[i]) * v.r.range(0.35, 0.65);
    const y = bandLow + (l.height - bandLow) * v.r.range(0.15, 0.6);
    const reach = reachAt(p, az, y);
    if (reach > 0.2) p.wall(az, reach * 0.985, v.r.range(16, 28) + l.flare * back(az) * 0.5, y, 'shoulder');
  }
  // A tall ledge's back breaks at about 1.2 m into upper planes that lean
  // well in: from behind it is a lower wall under a pale sloping shoulder,
  // not a two-meter drum.
  if (l.height > 1.5) {
    for (const turn of [-24, 26]) {
      const az = backAz + turn + v.r.range(-6, 6);
      const y = v.r.range(1.05, 1.35);
      const reach = reachAt(p, az, y);
      if (reach > 0.2) p.wall(az, reach * 0.99, v.r.range(20, 27), y, 'shoulder');
    }
  }
  p.cut(tilted(v.num(2.5, 1.5), v.range(200, 0, 360)), [0, l.height, 0], 'top');
  const br = v.r.fork('bevel');
  try {
    p.bevel('top', () => (br.chance(0.3) ? 0 : br.range(0.06, 0.2)));
  } catch {
    /* a bevel wider than the top: the rest are in, the slab is whole */
  }
  if (clips) clipCorners(p, clips, 0.22, seed, 0.3);
  return p.move([l.at[0], 0, l.at[1]]);
}

/**
 * `emitRock` with ONE underside for the whole stack. Five chunks stand side
 * by side here, each with a foot of up to fourteen sides: their own buried
 * bases would be a tenth of the triangle budget spent 16 cm under the
 * ground. The chunks all end at the same depth, so their open feet are
 * closed by a single plate there — the convex hull of the footprints (it
 * reaches past the walls in the notches between chunks, facing down, under
 * the ground).
 */
function emitStack(m: SolidMesh, chunks: readonly Polytope[], tones: StoneTones, shade: (index: number) => StoneShade): void {
  let height = 0;
  for (const c of chunks) height = Math.max(height, c.bounds().max.y);
  const foot: Vector3[] = [];
  chunks.forEach((c, i) => {
    const paintFace = stonePaint(tones, { height, ...shade(i) });
    c.emit(
      m,
      (f) => {
        if (f.tag !== 'base') return paintFace(f);
        foot.push(...f.points);
        return null;
      },
      chunks,
    );
  });
  // Monotone-chain hull in plan, counter-clockwise seen from below.
  const pts = [...foot].sort((a, b) => a.x - b.x || a.z - b.z);
  const turn = (o: Vector3, a: Vector3, b: Vector3): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const half = (list: Vector3[]): Vector3[] => {
    const h: Vector3[] = [];
    for (const q of list) {
      while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], q) <= 1e-9) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  const hull = [...half(pts), ...half(pts.reverse())];
  if (hull.length < 3) return;
  // (b − a) × (c − a) must point down.
  if (Vector3.Cross(hull[1].subtract(hull[0]), hull[2].subtract(hull[0])).y > 0) hull.reverse();
  m.fan(hull, paint(tones.low, { gloss: 0.08, smooth: 0 }));
}

// `spare` 0 is the full model; each step up leaves clipped corners out —
// see `resolve`. The block at the back is never left out: it is what keeps
// the outcrop from reading as a drum from behind.
function construct(seed: number, spare: number): Built {
  const v = variant(seed, ID);
  // The variants are told apart at a distance by colour as much as by
  // shape: a stronger mood than the stone default.
  const tones = stoneTones(v, {}, 1.6);
  const lumpSeed = seed * 19 + 5;
  const mirror = seed % 2 ? -1 : 1;

  // --- the stair ----------------------------------------------------------
  // The coins are fanned along a line from the low ledge to the top one.
  // The coins are fanned along a line from the low ledge to the top one —
  // or, on some seeds, a bent line (the top coin swung to one side).
  const climbDeg = v.range(58, 32, 80);
  const climb = climbDeg * DEG;
  const fan = v.num(0.82, 0.14);
  const bend = v.range(0, -0.32, 0.32);
  const step = (k: number): [number, number] => [
    -0.78 + Math.sin(climb) * fan * k + Math.cos(climb) * bend * (k === 2 ? 1 : 0),
    -0.45 + Math.cos(climb) * fan * k - Math.sin(climb) * bend * (k === 2 ? 1 : 0),
  ];
  const rise = [v.num(0.68, 0.08), v.num(0.65, 0.08), v.num(0.67, 0.08)];
  const ledges: Ledge[] = [
    { at: step(0), rx: v.num(1.32, 0.14), rz: v.num(1.03, 0.1), height: rise[0], flare: 0 },
    { at: step(1), rx: v.num(1.2, 0.14), rz: v.num(0.98, 0.1), height: rise[0] + rise[1], flare: 3 },
    { at: step(2), rx: v.num(1.2, 0.12), rz: v.num(0.92, 0.09), height: rise[0] + rise[1] + rise[2], flare: 7 },
  ];
  const chunks: Polytope[] = ledges.map((l, k) =>
    ledge(v.fork(`ledge${k}`), l, v.int(k === 0 ? 7 : 6, 6, 7), lumpSeed + 10 + k, Math.max(0, 2 - spare), 18),
  );

  // --- boulders -----------------------------------------------------------
  const top = ledges[2];
  const boulders: Lump[] = [];
  const boulder = (deg: number, dist: number, radii: V3, tilt: number, k: number, rings: MoundRing[], fall: number): void => {
    const at: V3 = [top.at[0] + Math.sin(deg * DEG) * dist, 0, top.at[1] + Math.cos(deg * DEG) * dist];
    boulders.push({ at, radii });
    chunks.push(
      rockChunk({
        radii,
        rings,
        seed: lumpSeed + k,
        top: { tilt, toward: deg + fall },
        rim: [0.07, 0.22],
        clips: Math.max(0, (k === 1 ? 3 : 2) - spare),
        jitter: 0.9,
        dent: 0.8,
        crown: 0.42,
        skirt: SKIRT,
        at,
      }),
    );
  };
  // The boulder runs in UNDER the mid and top ledges (its far half is
  // buried in them): from above, one compact outcrop, not a stack with a
  // round stone beside it.
  boulder(v.range(150, 112, 182), v.num(1.1, 0.08), [v.num(1.05, 0.08), v.num(1.25, 0.12), v.num(0.78, 0.07)], v.num(38, 4), 1, BOULDER_RINGS, v.num(20, 25));
  // Behind the top ledge a low block takes the stump out of its two-meter
  // back wall: seen from behind the outcrop is a stair too. Always there,
  // always behind (the top ledge's back is what it hides).
  const backDeg = 10 + v.range(0, -20, 20);
  const backR: V3 = [v.num(1.0, 0.06), v.num(1.4, 0.08), v.num(0.62, 0.05)];
  // Its top falls off sideways, so its summit stands clear of the ledge.
  boulder(backDeg, top.rz * 0.72 + backR[2] * 1.0, backR, v.num(18, 4), 2, BACK_RINGS, v.pick(90, [90, -90]));

  if (mirror < 0) for (const c of chunks) c.transform(scaling(-1, 1, 1));

  const mesh = new SolidMesh();
  const slate = { side: tones.alt, alt: tones.side };
  emitStack(mesh, chunks, tones, (i) => (i < ledges.length ? { seed: seed + i } : { seed, cream: 0, tones: slate }));
  const fit = fitSize(mesh, v.size(FIT), { exact: true });
  return { mesh, fit, mirror, ledges, boulders };
}

/** The fullest build of this seed that fits the triangle budget (these are
 * instanced by the hundred: the budget is hard, for every seed). */
function resolve(seed: number): Built {
  let built = construct(seed, 0);
  for (let spare = 1; spare <= 3 && built.mesh.triangleCount > BUDGET; spare++) built = construct(seed, spare);
  return built;
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, mirror, ledges, boulders } = resolve(seed);
  const s = fit.scale;
  const at = (p: V3): V3 => fitPoint(fit, [p[0] * mirror, p[1], p[2]]);
  return [
    // A box inside each ledge (0.7 of the radii: the ellipse's inscribed
    // rectangle), from the ground to its top.
    ...ledges.map((l): ColliderSpec => {
      const c = at([l.at[0], 0, l.at[1]]);
      const h = (l.height * s[1]) / 2;
      return { shape: 'box', center: [c[0], h, c[2]], half: [l.rx * s[0] * 0.7, h, l.rz * s[2] * 0.7] };
    }),
    ...boulders.map((b): ColliderSpec => {
      const c = at(b.at);
      const r = Math.min(b.radii[0] * s[0], b.radii[2] * s[2], b.radii[1] * s[1] * 0.62) * 0.86;
      return { shape: 'sphere', center: [c[0], b.radii[1] * s[1] * 0.42, c[2]], radius: r };
    }),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Terrace Stack',
  category: 'large-rock',
  size: SIZE,
  variants: 4,
  build: (seed) => resolve(seed).mesh,
  colliders,
  triBudget: BUDGET,
  reference: {
    sheet: 'design-documents/environment-design-pack/large-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/large-rocks/r03-terrace-stack-brief.txt',
  },
};

export default asset;
