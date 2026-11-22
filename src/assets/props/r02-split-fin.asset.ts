import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, rng, scaling } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import { Polytope, emitRock, fitPoint, fitSize, rockChunk, stoneTones, variant } from './nature';
import type { Fit, MoundRing, Variant } from './nature';

/**
 * R02 SPLIT FIN — a tall, narrow wedge of rock, split from the top down to
 * mid-height by an off-centre notch, standing on one solid base with an
 * angular block merged into its front-right foot
 * (large-rocks/design-sheet.png, middle).
 *
 * Parts list (front of the sheet = looking toward +z), measured off the
 * sheet's FRONT / SIDE / TOP views:
 *  - the fin: a WEDGE. Seen from the side the back stands sheer (three
 *    facets turned against each other) and the front rakes back (9° from
 *    the ground, 14° above the waist), so the top is a ridge 0.4 m deep
 *    along the back edge. Seen from the front the left outline is the cream
 *    slope, leaning in some 20°, and the right one 3–5°: the tips span under
 *    half the base. The walls are broken by lean changes at staggered
 *    heights and their corners clipped — unequal facets, not one plane from
 *    the ground to the tip;
 *  - the CREAM: the slope down the left outline, from the left prong's tip
 *    to a fifth of the height (two facets with a bend), plus a cream facet
 *    across the left prong's upper front and the prongs' caps. About a
 *    quarter of the front view and of the plan;
 *  - the notch: a V right through the fin from front to back, opening
 *    upward, its bottom line just under half height and right of the
 *    middle. Below that line the stone is ONE piece (the two sides share
 *    every wall plane);
 *  - two prongs: the right one the summit, the left a little lower, each
 *    with a cream cap and a cream chamfer toward the back, so the fin shows
 *    its caps from behind as well;
 *  - the back and right (shadow side): three back facets turned against
 *    each other and a pale shoulder band from about 60 % of the height;
 *  - the foot block: an angular slate mass 45 % of the width and 30 % of
 *    the height, sunk deep into the front-right corner. Its top stays
 *    lavender.
 *
 * Variants keep the species (tall wedge, cream slope, one notch from the
 * top) and vary the rest: every wall turned and moved, the slope's direction
 * and steepness, where the notch sits, how deep it goes and how wide it
 * opens, which prong is the taller (never by more than a third of a meter:
 * it stays one fin), the lean of the whole fin, the foot block (swung round
 * the front-right, sometimes a small second one). Odd seeds are the mirror
 * image.
 */

const ID = 'r02-split-fin';
const SIZE = { x: 2.3, y: 4.2, z: 1.5 };
const SKIRT = 0.14;
const DEG = Math.PI / 180;
// The drawing is far broader for its height than the brief's box (width :
// height 0.9 against 0.55). Like R01, the build spends the size tolerance on
// leaning toward the drawing: 6 % wider and deeper, and 4.0 m of VISIBLE
// height (4.14 m with the buried skirt, as the lab measures it).
const FIT = { x: 2.44, y: 4.0, z: 1.59 };
const HEIGHT = 4.0;
// The left prong's tip, where the cream slope starts, and the ridge line
// along the back where the prongs' caps sit (fin frame, before the notch).
const TIP_X = -0.1;
const RIDGE_Z = 0.34;
const BUDGET = 300;

type V3 = [number, number, number];

// Walls round the foot of the fin, in the fin's own frame: [compass (0 =
// back, 90 = right, 180 = front, 270 = left), reach from the centre at the
// ground, lean in from vertical]. The back stands sheer as three facets
// turned against each other; the left leans in hard (the wedge seen from
// the front), the front rakes back (the wedge seen from the side).
const WALLS: readonly (readonly [number, number, number])[] = [
  [180, 0.84, 9],
  [152, 0.92, 6],
  [208, 0.96, 10],
  [238, 1.1, 7],
  [268, 1.14, 6],
  [302, 0.98, 6],
  [326, 0.76, 2],
  [356, 0.66, 2.5],
  [24, 0.7, 1.5],
  [52, 0.84, 4],
  [92, 0.96, 2.5],
  [124, 0.94, 4],
];
// Lean breaks: [compass, height, new lean]. Each plane starts just inside
// the surface at that height, so the wall below it is one facet and the
// plane above another — at staggered heights round the fin, as the sheet's
// facets are. The ones on the back half are the pale shoulder band.
const BREAKS: readonly (readonly [number, number, number, string])[] = [
  [184, 1.8, 14, 'flank'],
  [204, 1.0, 13, 'flank'],
  [318, 1.3, 4, 'flank'],
  [16, 1.6, 3.5, 'flank'],
  [306, 2.4, 7, 'shoulder'],
  [342, 2.8, 7, 'shoulder'],
  [22, 3.0, 6, 'shoulder'],
  [70, 2.1, 4, 'flank'],
  [104, 3.0, 5, 'shoulder'],
  [134, 1.6, 6, 'flank'],
];
// Where the fin stands: the foot block takes the front-right corner of the
// box, so the fin sits a little back and to the left.
const FIN_AT: V3 = [-0.06, 0, 0.06];
// A few big facets: the block is a broken-off mass, not a pebble.
const FOOT_RINGS: MoundRing[] = [
  { count: 6, pitch: 12, at: 0 },
  { count: 4, pitch: 34, at: 0.45 },
];

interface Lump {
  at: V3;
  radii: V3;
}

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  mirror: number;
  /** Unfitted, unmirrored: how far the fin's top is sheared off its foot
   * per meter of height [x, z], and the foot blocks. */
  lean: [number, number];
  feet: Lump[];
}

/** Unit normal of a plane tilted `tilt` degrees from level, falling toward
 * compass direction `toward`. */
function tilted(tilt: number, toward: number): Vector3 {
  const t = tilt * DEG;
  const a = toward * DEG;
  return new Vector3(Math.sin(a) * Math.sin(t), Math.cos(t), Math.cos(a) * Math.sin(t));
}

/** `cut` that leaves the solid alone if the plane would remove all of it:
 * a seeded variant must never fail to build. */
function carve(p: Polytope, n: Vector3, through: Vector3, tag: string): void {
  try {
    p.cut(n, through, tag);
  } catch {
    /* the plane misses: leave it out */
  }
}

/** Where a ray from the fin's axis toward compass `az` at height `y` leaves
 * the solid, as a distance along that direction. */
function reachAt(p: Polytope, az: number, y: number): number {
  const d = new Vector3(Math.sin(az * DEG), 0, Math.cos(az * DEG));
  try {
    const q = p.surface([0, y, 0.05], d);
    return q.x * d.x + q.z * d.z;
  } catch {
    return 0;
  }
}

/**
 * `Polytope.clip` for the fin: clips up to `count` corners between the
 * heights `above` and `below`, but never one that touches a cream plane, the
 * notch or the ground — a clip in the cream leaves a lavender hole in it.
 */
function clipFlanks(p: Polytope, count: number, size: number, seed: number, above: number, below: number): void {
  const r = rng(seed, 'clipFlanks');
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
      if (f.tag === 'top' || f.tag === 'rim' || f.tag === 'base' || f.tag === 'groove' || f.tag === 'inner') c.skip = true;
    }
  }
  // Only real corners: where the faces meeting turn at least 40° against
  // each other. On a lean break (two planes a few degrees apart) the mean
  // normal is the wall's own, and the "clip" shaves the whole wall off.
  const sharp = (c: Corner): boolean => c.normals.some((a) => c.normals.some((b) => Vector3.Dot(a, b) < Math.cos(40 * DEG)));
  const picked: Corner[] = [];
  for (const c of r.shuffle(corners.filter((k) => !k.skip && k.at.y > above && k.at.y < below && sharp(k)))) {
    if (picked.length >= count) break;
    if (picked.some((k) => Vector3.Distance(k.at, c.at) < size * 3)) continue;
    picked.push(c);
  }
  for (const c of picked) {
    const n = c.n.clone().normalize();
    carve(p, n, c.at.subtract(n.scale(size * r.range(0.7, 1.2))), 'clip');
  }
  p.tidy();
}

/** The fin before the notch: walls, lean breaks and the cream slope. */
function finBlank(v: Variant, spare: number, lumpSeed: number): { fin: Polytope; slopeTo: number } {
  const vm = v.fork('fin');
  const fin = Polytope.block(HEIGHT + 0.4, SKIRT);
  for (const [az, reach, lean] of WALLS) fin.wall(az + vm.num(0, 7), reach * vm.num(1, 0.05), lean + vm.num(0, 2));
  for (const [az0, y0, lean, tag] of BREAKS) {
    const az = az0 + vm.num(0, 10);
    const y = y0 + vm.num(0, 0.25);
    const reach = reachAt(fin, az, y);
    if (reach > 0.2) fin.wall(az, reach * 0.985, lean + vm.num(0, 3), y, tag);
  }

  // The cream slope IS the fin's left outline seen from the front: planes
  // that replace the left-front walls from the left prong's tip down. In
  // profile it is a line from the tip to where it leaves the outline (a
  // fifth of the height up the left foot), bent once outward at 60 %: two
  // facets, the upper one shallower (the solid is convex), the lower turned
  // a little toward the front. Each is placed by where it meets the walls
  // (`reachAt`), so the slope keeps its size whatever the walls did. On a
  // fin this narrow a slope much shallower than ~65° would only shave the
  // tip: the cream gets its area from running the whole height instead.
  const slopeTo = vm.range(246, 234, 256);
  const along = (az: number): Vector3 => new Vector3(Math.sin(az * DEG), 0, Math.cos(az * DEG));
  const tip = new Vector3(TIP_X + vm.num(0, 0.05), HEIGHT, RIDGE_Z);
  const exitY = HEIGHT * vm.num(0.22, 0.03);
  const midY = HEIGHT * vm.num(0.6, 0.03);
  const dU = along(slopeTo + 6);
  const dL = along(slopeTo - 10);
  const proj = (q: Vector3, d: Vector3): number => q.x * d.x + q.z * d.z;
  // The straight line from the tip to the exit, then the bend.
  const runAll = reachAt(fin, slopeTo, exitY) - proj(tip, along(slopeTo));
  const run = runAll * ((HEIGHT - midY) / (HEIGHT - exitY)) + vm.num(0.1, 0.03);
  const mid = new Vector3(tip.x + dU.x * run, midY, tip.z + dU.z * run);
  const upper = Math.atan2(HEIGHT - midY, run) / DEG;
  const lowerRun = reachAt(fin, slopeTo - 10, exitY) - proj(mid, dL);
  const lower = Math.max(upper + 6, Math.atan2(midY - exitY, Math.max(lowerRun, 0.05)) / DEG);
  carve(fin, tilted(upper, slopeTo + 6), tip, 'top');
  carve(fin, tilted(lower, slopeTo - 10), mid, 'top');
  // The left prong's upper front is cream too: a facet from the tip down
  // the front to well over half the height, so the cream reads from the
  // front and not only from the left.
  const dF = along(slopeTo - 42);
  const frontRun = reachAt(fin, slopeTo - 42, HEIGHT * vm.num(0.58, 0.03)) - proj(tip, dF);
  carve(fin, tilted(Math.atan2(HEIGHT * 0.42, Math.max(frontRun, 0.1)) / DEG, slopeTo - 42), tip, 'top');
  // Clipped corners, on the walls only (never on the cream).
  if (spare < 2) clipFlanks(fin, spare ? 3 : 6, vm.num(0.2, 0.03), lumpSeed, 0.5, HEIGHT * 0.78);
  return { fin, slopeTo };
}

// `spare` 0 is the full model; each step up leaves detail out (clipped
// corners, then the second foot block) — see `resolve`.
function construct(seed: number, spare: number): Built {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const lumpSeed = seed * 17 + 3;
  const mirror = seed % 2 ? -1 : 1;

  const { fin, slopeTo } = finBlank(v, spare, lumpSeed);

  // --- the notch ----------------------------------------------------------
  // A V through the whole fin, opening upward. `groove` returns the piece
  // left of it (whose wall plane runs on down through the stone) and the
  // piece right of it; they touch below the bottom line and share every
  // other plane, so the base is one stone.
  const notchX = v.range(0.17, 0.04, 0.26);
  const depthY = HEIGHT * v.range(0.47, 0.42, 0.56);
  const pieces = fin.groove({
    at: [notchX, depthY, 0],
    along: [v.num(0.1, 0.12), v.num(0.04, 0.04), 1],
    out: [v.num(-0.04, 0.03), 1, 0],
    angle: v.num(10, 1.5),
  });
  const left = pieces[0];
  const right = pieces.length > 1 ? pieces[1] : null;

  // Which prong is the summit, and how far the other one ends under it —
  // never so far that the two read as separate pillars.
  const leftTall = v.chance(false, 0.35);
  const drop = v.range(0.3, 0.16, 0.36);
  const topL = leftTall ? HEIGHT + 0.12 : HEIGHT - drop;
  const topR = leftTall ? HEIGHT - drop : HEIGHT + 0.12;
  // Cutting either piece is safe above the notch's bottom line (the left
  // piece's wall plane is emitted whole); every cut here stays above it.
  // Each prong's caps are placed on what is there: the extent of its
  // section a little under its top.
  const crown = (p: Polytope, top: number): { c: Vector3; back: number; right: number } => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of p.faces) {
      for (const q of f.points) {
        if (q.y < top - 0.5) continue;
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        z0 = Math.min(z0, q.z);
        z1 = Math.max(z1, q.z);
      }
    }
    return { c: new Vector3((x0 + x1) / 2, top, (z0 + z1) / 2), back: z1, right: x1 };
  };
  if (right) {
    // The summit: a near-level cream cap, a cream facet beside the notch
    // that carries the slope on, a shoulder falling away to the right and a
    // broad chamfer toward the back.
    const k = crown(right, topR);
    carve(right, tilted(v.num(9, 4), v.num(225, 30)), k.c, 'top');
    carve(right, tilted(v.num(48, 5), slopeTo - v.num(30, 6)), k.c.add(new Vector3(-0.04, -0.04, -0.04)), 'top');
    carve(right, tilted(v.num(46, 5), v.num(86, 10)), new Vector3(k.right - 0.12, topR - 0.1, k.c.z), 'top');
    carve(right, tilted(v.num(44, 4), v.num(6, 10)), new Vector3(k.c.x, topR - 0.06, k.back - 0.26), 'top');
  }
  const kl = crown(left, topL);
  carve(left, tilted(v.num(13, 4), slopeTo), kl.c, 'top');
  carve(left, tilted(v.num(44, 4), v.num(354, 10)), new Vector3(kl.c.x, topL - 0.06, kl.back - 0.26), 'top');
  // Narrow bevels round the cream, a third of the edges crisp.
  const br = v.r.fork('bevel');
  for (const p of [left, right]) {
    if (!p) continue;
    try {
      p.bevel('top', () => (br.chance(0.4) ? 0 : br.range(0.04, 0.08)));
    } catch {
      /* a bevel wider than its facet: the rest are in, the stone is whole */
    }
  }
  left.tidy();
  right?.tidy();
  if (right && spare < 1) clipFlanks(right, 2, 0.22, lumpSeed + 1, depthY + 0.3, topR - 0.5);
  if (spare < 1) clipFlanks(left, 1, 0.22, lumpSeed + 2, depthY + 0.3, topL - 0.5);

  // The whole fin leans a little (a shear: the foot stays where it is).
  const leanDeg = v.num(0, 4);
  const leanTo = v.range(0, 0, 360) * DEG;
  const lean: [number, number] = [Math.tan(leanDeg * DEG) * Math.sin(leanTo), Math.tan(leanDeg * DEG) * Math.cos(leanTo)];
  const finPieces = right ? [left, right] : [left];
  for (const p of finPieces) p.move(FIN_AT);
  if (leanDeg) {
    // x += kx·y, z += kz·y.
    const shear = Matrix.FromValues(1, 0, 0, 0, lean[0], 1, lean[1], 0, 0, 0, 1, 0, 0, 0, 0, 1);
    for (const p of finPieces) p.transform(shear);
  }

  // --- foot blocks --------------------------------------------------------
  const feet: Lump[] = [];
  const chunks: Polytope[] = [...finPieces];
  const foot = (deg: number, dist: number, radii: V3, topTilt: number, k: number, clips: number): void => {
    const at: V3 = [FIN_AT[0] + Math.sin(deg * DEG) * dist, 0, FIN_AT[2] + Math.cos(deg * DEG) * dist];
    feet.push({ at, radii });
    chunks.push(
      rockChunk({
        radii,
        rings: FOOT_RINGS,
        seed: lumpSeed + k,
        jitter: 0.8,
        dent: 0.8,
        top: { tilt: topTilt, toward: deg + v.num(30, 20) },
        rim: [0.08, 0.22],
        clips,
        clipSize: 0.14,
        crown: 0.5,
        skirt: SKIRT,
        at,
      }),
    );
  };
  foot(v.range(140, 120, 158), v.num(0.84, 0.05), [v.num(0.62, 0.05), v.num(1.3, 0.12), v.num(0.52, 0.04)], v.num(40, 4), 1, Math.max(0, 2 - spare));
  if (v.chance(false, 0.3) && spare < 3) foot(v.range(250, 230, 280), v.num(0.82, 0.05), [v.num(0.36, 0.04), v.num(0.6, 0.08), v.num(0.32, 0.04)], v.num(34, 4), 2, 0);

  if (mirror < 0) for (const c of chunks) c.transform(scaling(-1, 1, 1));

  const mesh = new SolidMesh();
  // The foot blocks lean to the slate flank tone and carry no cream.
  const slate = { side: tones.alt, alt: tones.side };
  emitRock(mesh, chunks, tones, (i) => (i < finPieces.length ? { seed } : { seed, cream: 0, tones: slate }));
  const fit = fitSize(mesh, v.size(FIT), { exact: true });
  return { mesh, fit, mirror, lean, feet };
}

/** The fullest build of this seed that fits the triangle budget (these are
 * instanced by the hundred: the budget is hard, for every seed). */
function resolve(seed: number): Built {
  let built = construct(seed, 0);
  for (let spare = 1; spare <= 3 && built.mesh.triangleCount > BUDGET; spare++) built = construct(seed, spare);
  return built;
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, mirror, lean, feet } = resolve(seed);
  const s = fit.scale;
  const at = (p: V3): V3 => fitPoint(fit, [p[0] * mirror, p[1], p[2]]);
  const height = HEIGHT * s[1];
  // Unfitted centres in the fin's frame, carried along its lean.
  const fin = (x: number, y: number, z: number): V3 => at([FIN_AT[0] + x + lean[0] * y, 0, FIN_AT[2] + z + lean[1] * y]);
  const low = fin(-0.1, HEIGHT * 0.22, -0.06);
  const high = fin(0.16, HEIGHT * 0.6, 0.18);
  return [
    // The solid lower part, and the two prongs as one thinner slab (the
    // notch is a hand wide: nothing drives through it).
    { shape: 'box', center: [low[0], height * 0.22, low[2]], half: [0.82 * s[0], height * 0.22, 0.56 * s[2]] },
    { shape: 'box', center: [high[0], height * 0.6, high[2]], half: [0.4 * s[0], height * 0.18, 0.24 * s[2]] },
    ...feet.map((f): ColliderSpec => {
      const c = at(f.at);
      const r = Math.min(f.radii[0] * s[0], f.radii[2] * s[2], f.radii[1] * s[1] * 0.6) * 0.84;
      return { shape: 'sphere', center: [c[0], f.radii[1] * s[1] * 0.42, c[2]], radius: r };
    }),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Split Fin',
  category: 'large-rock',
  size: SIZE,
  variants: 4,
  build: (seed) => resolve(seed).mesh,
  colliders,
  triBudget: BUDGET,
  reference: {
    sheet: 'design-documents/environment-design-pack/large-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/large-rocks/r02-split-fin-brief.txt',
  },
};

export default asset;
