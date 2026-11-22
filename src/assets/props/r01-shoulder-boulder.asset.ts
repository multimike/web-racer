import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import { Polytope, emitRock, faceShape, fitPoint, fitSize, rockChunk, stoneTones, variant } from './nature';
import type { Fit, MoundRing } from './nature';

/**
 * R01 SHOULDER BOULDER — a squat, broad, asymmetric boulder with one big
 * sloping cream top plane, a shallow groove down its front-left and a lower
 * "shoulder" bulge on the right (large-rocks/design-sheet.png, left).
 *
 * Parts list (front of the sheet = looking toward +z):
 *  - main mass: a WEDGE BLOCK over nine tenths of the width — steep walls
 *    (10–13° off vertical) under a low roof. The broad cream plane falls 24°
 *    from a ridge right of the middle to the left and a little toward the
 *    viewer, so the left wall is only 60 % as tall as the stone; a second,
 *    smaller cream plane falls away behind the ridge. Seen from above the
 *    cream covers half the plan; seen from behind, the tall side is a wall
 *    under a sloping cap with the summit set well in from its edge (with the
 *    summit ON the edge it reads as a tooth — R02's species). The tall walls
 *    are broken by waist planes, the low ones run plain up to the cream;
 *  - groove: a kinked crack from the top plane's front edge diagonally down
 *    to the left, then steeply to the ground, 7 cm deep; the face on its
 *    left is cut 4–5 cm deeper, so the two sides sit at different levels;
 *  - shoulders: mauve bulges under the tall side, half as tall and half
 *    inside the main mass — bulges of the same stone, not rocks leaned on
 *    it: the sheet's on the front-right, a smaller one round the back. Their
 *    tops slope outward and stay lavender: the stone has ONE cream cap.
 * All pieces overlap; buried faces are dropped.
 *
 * Variants keep the wedge (that is the species) and vary through the rest:
 * every wall turned, moved and leaned a little, the slope direction, tilt
 * and ridge drawn again, the groove moved, the shoulders swung round and
 * resized (the back one sometimes missing) — and every odd seed is the
 * mirror image, so half of them slope the other way.
 */

const ID = 'r01-shoulder-boulder';
const SIZE = { x: 3.2, y: 2.4, z: 2.6 };
// The stone is over three meters across: on a 5° slope the ground drops a
// quarter of a meter under it, so the skirt is a deep one.
const SKIRT = 0.16;
const DEG = Math.PI / 180;
// The brief's box is a third taller for its footprint than the drawing
// (height : width 0.75 against 0.58). The build spends the size tolerance on
// leaning toward the drawing: 7 % wider and deeper and, with the buried
// skirt counted as the lab counts it, 7 % lower.
const FIT = { x: 3.42, y: 2.07, z: 2.77 };

// The main mass is AUTHORED, plane by plane (`Polytope.block` + `wall`): a
// rolled mound cannot hold a cream plane over half the plan and a squat
// profile at once on a box this tall.
// Walls round the foot: [compass (0 = back, 90 = right, 180 = front), reach
// from the centre at the ground, lean in from vertical].
const WALLS: readonly (readonly [number, number, number])[] = [
  [183, 1.25, 11],
  [212, 1.34, 12],
  [246, 1.5, 13],
  [281, 1.52, 11],
  [322, 1.36, 11],
  [2, 1.22, 12],
  [38, 1.34, 12],
  [77, 1.5, 10],
  [112, 1.46, 12],
  [150, 1.32, 13],
];
// Waist planes on the TALL side only (back and right), staggered between
// the walls: [compass, where they start as a fraction of the local height of
// the top, lean]. They break the tall walls into a lower and an upper facet.
// The low side keeps plain walls right up to the cream: that is where the
// top plane gets its size.
const WAIST: readonly (readonly [number, number, number])[] = [
  [344, 0.64, 22],
  [20, 0.64, 22],
  [58, 0.62, 21],
  [96, 0.64, 20],
  [132, 0.66, 20],
];
// The shoulders are half the main mass's size: fewer planes.
const SHOULDER_RINGS: MoundRing[] = [
  { count: 7, pitch: 14, at: 0 },
  { count: 6, pitch: 36, at: 0.5 },
];

type V3 = [number, number, number];

interface Lump {
  at: V3;
  radii: V3;
}

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  /** Unfitted centre / radii of the main mass and the compass direction its
   * top falls toward; the shoulders. */
  main: Lump & { slopeTo: number };
  shoulders: Lump[];
}

/** The front-most point of the top plane's outline at plan position x: where
 * a groove coming up the front flank meets the cream. */
function frontRim(rock: Polytope, x: number): Vector3 {
  let top: Polytope['faces'][number] | null = null;
  let area = 0;
  for (const f of rock.faces) {
    if (f.tag !== 'top') continue;
    const a = faceShape(f).area;
    if (a > area) {
      area = a;
      top = f;
    }
  }
  if (!top) throw new Error('frontRim: the rock has no top plane');
  let best: Vector3 | null = null;
  const n = top.points.length;
  for (let i = 0; i < n; i++) {
    const p = top.points[i];
    const q = top.points[(i + 1) % n];
    if ((p.x - x) * (q.x - x) > 0 || p.x === q.x) continue;
    const hit = Vector3.Lerp(p, q, (x - p.x) / (q.x - p.x));
    if (!best || hit.z < best.z) best = hit;
  }
  // x lies outside the plane: its nearest corner will do.
  if (!best) for (const p of top.points) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  return best!.clone();
}

function construct(seed: number): Built {
  const v = variant(seed, ID);
  const tones = stoneTones(v);
  const lumpSeed = seed * 13 + 4;
  // Odd seeds are mirrored: half the stones in a field slope the other way.
  const mirror = seed % 2 ? -1 : 1;
  // Compass directions (0 = +z, 90 = +x) mirror with the stone.
  const compass = (deg: number): number => (mirror > 0 ? deg : 360 - deg);
  const from = (c: V3, deg: number, dist: number): V3 => [c[0] + Math.sin(deg * (Math.PI / 180)) * dist, 0, c[2] + Math.cos(deg * (Math.PI / 180)) * dist];

  // Main mass. The top is a low ROOF: the broad cream plane falls from a
  // ridge right of the middle to the left and a little toward the viewer; a
  // second, smaller cream plane falls away behind the ridge to the right. So
  // the tall side is a wall under a sloping cap, not a cliff with the summit
  // on its edge — which is what makes a wedge read as a tooth from behind.
  const vm = v.fork('main');
  const slopeTo = compass(vm.range(250, 225, 268));
  const tilt = vm.num(24, 3);
  const backTilt = vm.num(25, 4);
  const HEIGHT = 2.2;
  const ridge = [vm.num(0.48, 0.12) * mirror, vm.num(0.28, 0.12)];
  const plane = (deg: number, toward: number): Vector3 => new Vector3(Math.sin(toward * DEG) * Math.sin(deg * DEG), Math.cos(deg * DEG), Math.cos(toward * DEG) * Math.sin(deg * DEG));
  // Height of one roof plane over plan point (x, z).
  const under = (deg: number, toward: number, x: number, z: number): number =>
    HEIGHT - Math.tan(deg * DEG) * ((x - ridge[0]) * Math.sin(toward * DEG) + (z - ridge[1]) * Math.cos(toward * DEG));
  const roof = (x: number, z: number): number => Math.min(HEIGHT, under(tilt, slopeTo, x, z), under(backTilt, slopeTo + 180, x, z));
  const walls = WALLS.map(([az, reach, lean]) => [compass(az + vm.num(0, 8)), reach * vm.num(1, 0.07), lean + vm.num(0, 3)]);
  // Footprint radius toward a compass direction.
  const foot = (az: number): number => {
    let r = Infinity;
    for (const [wa, reach] of walls) {
      const c = Math.cos((az - wa) * DEG);
      if (c > 0.2) r = Math.min(r, reach / c);
    }
    return r;
  };
  const main = Polytope.block(HEIGHT + 0.6, SKIRT);
  for (const [az, reach, lean] of walls) main.wall(az, reach, lean);
  for (const [waistAz, start, lean] of WAIST) {
    const az = compass(waistAz + vm.num(0, 8));
    const rho = foot(az);
    const y = roof(Math.sin(az * DEG) * rho * 0.8, Math.cos(az * DEG) * rho * 0.8) * (start + vm.num(0, 0.06));
    main.wall(az, rho - Math.tan(12 * DEG) * y, lean + vm.num(0, 4), y);
  }
  main.cut(plane(tilt, slopeTo), [ridge[0], HEIGHT, ridge[1]], 'top');
  main.cut(plane(backTilt, slopeTo + 180), [ridge[0], HEIGHT, ridge[1]], 'crest');
  // Broad bevels round the cream, a third of the edges left crisp.
  const br = vm.r.fork('bevel');
  main.bevel('top', () => (br.chance(0.3) ? 0 : br.range(0.08, 0.3)));
  main.clip({ count: 9, size: 0.13, seed: lumpSeed, above: 0.45 });
  const mainAt: V3 = [-0.12 * mirror, 0, 0];
  main.move(mainAt);
  const mb = main.bounds();
  const mainR: V3 = [(mb.max.x - mb.min.x) / 2, mb.max.y, (mb.max.z - mb.min.z) / 2];

  // The groove: from the front edge of the top plane diagonally down and to
  // the left to a kink, then steeply to the ground. Its bottom line runs
  // 13 cm under the flank; the top end comes up to the surface at the
  // cream's edge, so the groove notches that edge and no more.
  const gx = mainAt[0] + v.num(-0.15, 0.2) * mirror;
  const depth = v.num(0.07, 0.01);
  const rim = frontRim(main, gx);
  // The point `depth` under the front flank at plan position x, height y.
  const front = (x: number, y: number): Vector3 => main.surface([x, y, mainAt[2]], [0, 0, -1], depth);
  const kinkX = gx - v.num(0.68, 0.08) * mirror;
  const a = rim.add(new Vector3(mainAt[0], 0.6, mainAt[2]).subtract(rim).normalize().scale(0.04));
  const b = front(kinkX, rim.y - v.num(0.74, 0.06));
  const c = front(kinkX - v.num(0.14, 0.06) * mirror, -SKIRT * 0.6);
  const mainPieces = main.crack({
    path: [a, b, c],
    out: [-0.5 * mirror, 0.4, -1],
    slab: [-mirror, -0.5, 0.2],
    angle: v.num(68, 6),
    skew: 6,
    step: v.num(0.045, 0.008),
  });

  // Shoulders: bulges of the same stone under the tall side of the wedge,
  // which would otherwise stand there as one bare wall — the big one on the
  // front-right (the sheet's), usually a smaller one round the back. Their
  // tops slope down and away from the main mass, and stay lavender: the
  // stone has ONE cream cap.
  const shoulders: Lump[] = [];
  const chunks: Polytope[] = [...mainPieces];
  const shoulder = (deg: number, dist: number, radii: V3, tilt: number, k: number): void => {
    const at = from(mainAt, deg, dist);
    shoulders.push({ at, radii });
    chunks.push(
      rockChunk({
        radii,
        rings: SHOULDER_RINGS,
        seed: lumpSeed + k,
        top: { tilt, toward: deg + v.num(6 * mirror, 16) },
        rim: [0.08, 0.22],
        clips: 3,
        crown: 0.3,
        skirt: SKIRT,
        at,
      }),
    );
  };
  shoulder(compass(v.range(108, 88, 135)), v.num(1.0, 0.06), [v.num(1.05, 0.08), v.num(1.3, 0.12), v.num(1.0, 0.08)], v.num(34, 4), 1);
  if (v.chance(true, 0.65)) shoulder(compass(v.range(32, 15, 55)), v.num(0.86, 0.06), [v.num(0.8, 0.07), v.num(1.0, 0.1), v.num(0.78, 0.07)], v.num(30, 4), 2);

  const mesh = new SolidMesh();
  // The shoulders lean to the mauve flank tone, as on the sheet.
  const mauve = { side: tones.warm, alt: tones.side };
  // The cream cap rolls over its edges: the main mass's bevels and chamfers
  // within 45° of level are cream too (the sheet's cap is five facets).
  emitRock(mesh, chunks, tones, (i) => (i < mainPieces.length ? { seed, topAbove: 0.7 } : { seed, cream: 0, tones: mauve }));
  const fit = fitSize(mesh, v.size(FIT), { exact: true });
  return { mesh, fit, main: { at: mainAt, radii: mainR, slopeTo }, shoulders };
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, main, shoulders } = construct(seed);
  const s = fit.scale;
  // Primitives inside the stone (the groove is decoration). `radii` of a
  // chunk is [half width, HEIGHT, half depth]. The two boxes are turned to
  // the wedge (local +z = down the slope):
  //  - a low one under the low end of the top plane;
  //  - a tall one under the summit;
  //  - a sphere in each shoulder.
  const height = main.radii[1] * s[1];
  const r = (main.radii[0] * s[0] + main.radii[2] * s[2]) / 2;
  const down = main.slopeTo * (Math.PI / 180);
  const along = (d: number): V3 => fitPoint(fit, [main.at[0] + Math.sin(down) * d, 0, main.at[2] + Math.cos(down) * d]);
  const low = along(main.radii[0] * 0.4);
  const high = along(-main.radii[0] * 0.22);
  return [
    { shape: 'box', center: [low[0], height * 0.24, low[2]], half: [r * 0.56, height * 0.24, r * 0.3], rotY: main.slopeTo },
    { shape: 'box', center: [high[0], height * 0.38, high[2]], half: [r * 0.6, height * 0.38, r * 0.34], rotY: main.slopeTo },
    ...shoulders.map((sh): ColliderSpec => {
      const c = fitPoint(fit, sh.at);
      const sr = Math.min(sh.radii[0] * s[0], sh.radii[2] * s[2], sh.radii[1] * s[1] * 0.6) * 0.84;
      return { shape: 'sphere', center: [c[0], sh.radii[1] * s[1] * 0.42, c[2]], radius: sr };
    }),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Shoulder Boulder',
  category: 'large-rock',
  size: SIZE,
  variants: 4,
  build: (seed) => construct(seed).mesh,
  colliders,
  triBudget: 300,
  reference: {
    sheet: 'design-documents/environment-design-pack/large-rocks/design-sheet.png',
    brief: 'design-documents/environment-design-pack/large-rocks/r01-shoulder-boulder-brief.txt',
  },
};

export default asset;
