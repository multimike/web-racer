import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, cylinder, extrudePolygon, filletRing, frame, paintStripe, roundedBox, toV3, tube } from '../../../gfx/solid';
import type { Paint, Vec2, Vec3 } from '../../../gfx/solid';
import { GUNMETAL, STEEL, addBolt } from '../parts';
import type { P3 } from '../parts';
import { N } from './layout';
import type { Paints } from './layout';
import { flankDecal, slantBar, softPanel } from './shell';

/**
 * SIDE PODS and TAIL FINS — the wasp's wing cases: thick folded plates
 * standing off the tube frame on short bolted struts. Built for the right
 * side and mirrored; the speed stripes lean back on both flanks.
 */

/** Pod outer skin, right side: rows bottom edge → fold → top edge, columns
 * front → apex → rear. In plan the pod is the sheet's kite: straight runs
 * from a pointed front to ONE outward apex a little behind the middle, and
 * straight back to a pointed rear — the fold row and the apex column are
 * creases, so the corners stay crisp and the runs stay straight. Above the
 * fold a broad top chamfer carries the slashes; below it the main face
 * falls back in to the lower rail, steep enough to read as a plate standing
 * between the cage and the tires in the front view. */
const POD: Vec3[][] = [
  [
    [0.54, 0.41, 0.6],
    [0.545, 0.4, 0.0],
    [0.54, 0.405, -0.31],
  ],
  [
    [0.6, 0.57, 0.44],
    [0.67, 0.66, -0.03],
    [0.625, 0.75, -0.46],
  ],
  [
    [0.565, 0.7, 0.32],
    [0.585, 0.78, -0.1],
    [0.545, 0.86, -0.53],
  ],
];

/** Fin outline in side view [z, y]: bottom edge front → rear, top edge front
 * → rear (leading edge swept back, tip at the top rear). */
const FIN_BOTTOM: Vec2[] = [
  [-0.75, 1.3],
  [-1.24, 1.37],
];
const FIN_TOP: Vec2[] = [
  [-1.0, 1.59],
  [-1.455, 1.722],
];
/** The fin's plane: root line at this x, leaning out and toed out. */
const FIN_X = 0.305;
const FIN_LEAN = Math.tan((9 * Math.PI) / 180);
const FIN_TOE = Math.tan((6 * Math.PI) / 180);
const finPoint = ([z, y]: Vec2): P3 => [FIN_X + (y - 1.3) * FIN_LEAN + (-0.75 - z) * FIN_TOE, y, z];

/**
 * The two slashes on a pod's top chamfer. Each is a parallelogram in the
 * chamfer's own frame — u along the fold toward the rear, w across the
 * chamfer from the fold toward the top edge — cut by exact planes: first the
 * slanted pair of sides as a stripe, then everything outside the w band
 * painted back. A projected decal on this steep, narrow face smeared the
 * bars into pointed shards.
 */
function slashes(m: SolidMesh, from: number, stripe: Paint, body: Paint): void {
  const [, F, T] = POD;
  const v = (a: Vec3): Vector3 => toV3(a).clone();
  const U = v(F[1]).subtract(v(F[0])).normalize();
  // Fold and top edge at the slashes' station.
  const z = 0.2;
  const at = (a: Vec3, b: Vec3): Vector3 => Vector3.Lerp(v(a), v(b), (v(a).z - z) / (v(a).z - v(b).z));
  const O = at(F[0], F[1]);
  const across = at(T[0], T[1]).subtract(O);
  const n = Vector3.Cross(U, across).normalize();
  if (n.y < 0) n.scaleInPlace(-1);
  const W = Vector3.Cross(n, U).normalize();
  if (Vector3.Dot(W, across) < 0) W.scaleInPlace(-1);
  const band = Vector3.Dot(across, W);
  const local = (c: Vector3): [number, number] => {
    const d = c.subtract(O);
    return [Vector3.Dot(d, U), Vector3.Dot(d, W)];
  };
  const onChamfer = (c: Vector3, fn: Vector3): boolean => {
    if (Vector3.Dot(fn, n) < 0.75) return false;
    const [u, w] = local(c);
    return u > -0.2 && u < 0.25 && w > -0.03 && w < band + 0.03;
  };
  // A stripe between lo ≤ (p − O)·a ≤ hi, for any axis a.
  const stripeAlong = (a: Vector3, lo: number, hi: number | undefined, p: Paint): void => {
    const l = a.length();
    const o = Vector3.Dot(O, a);
    paintStripe(m, { axis: [a.x, a.y, a.z], min: (lo + o) / l, max: hi === undefined ? undefined : (hi + o) / l, only: onChamfer, from }, p);
  };
  // Leaning back toward the top edge, like the stripes on the pod's face.
  const k = 0.75;
  const side = U.subtract(W.scale(k));
  for (const c of [-0.06, 0.02]) stripeAlong(side, c, c + 0.045, stripe);
  const w0 = band * 0.2;
  const w1 = band * 0.78;
  stripeAlong(W.scale(-1), -w0, undefined, body);
  stripeAlong(W, w1, undefined, body);
}

export function addPodsAndFins(m: SolidMesh, P: Paints): void {
  const { BODY, BODY_IN, STRIPE } = P;
  const half = new SolidMesh();

  // --- pod -----------------------------------------------------------------
  const pod = softPanel(half, { grid: POD, thickness: 0.04, out: [1, 0.3, 0], round: 0.04, levels: 1, foldRows: [1], foldCols: [1], fold: 3, inner: BODY_IN }, BODY);
  // Two speed stripes on the main face, leaning back.
  const lean = 0.15;
  for (const z of [0.0, -0.15]) {
    flankDecal(half, slantBar([z, 0.455], [z - lean, 0.67], 0.1), 1, pod, STRIPE, 55);
  }
  // … and a double slash on the top chamfer near the front, as the sheet's
  // top view shows: two clean parallelograms, cut by exact planes in the
  // chamfer's own frame (u along the fold, w across the chamfer) so their
  // edges stay parallel however steeply the chamfer is tilted.
  slashes(half, pod, STRIPE, BODY);

  // --- fin -----------------------------------------------------------------
  // A flat plate with crisp, slightly softened edges and clipped corners —
  // extruded, so both faces are exactly flat (no pillow shading). Drawn in
  // the fin's own plane: u = distance back along −z, v = height; the affine
  // frame carries the lean and the toe-out of `finPoint`.
  const fin = half.mark();
  const U = new Vector3(FIN_TOE, 0, -1);
  const V = new Vector3(FIN_LEAN, 1, 0);
  const finFrame = frame(finPoint([0, 0]), U, V, Vector3.Cross(U, V).normalize());
  const finOutline: Vec2[] = [...FIN_BOTTOM, FIN_TOP[1], FIN_TOP[0]].map(([z, y]) => [-z, y] as Vec2);
  const plate = new SolidMesh();
  extrudePolygon(plate, { outline: filletRing(finOutline, 0.014, 2), depth: 0.042, centered: true, bevel: 0.009, bevelSegments: 2, bevelBack: true }, BODY);
  // Split the two broad faces into a fine grid: the AO bake is per vertex,
  // and a fan of long triangles shows as a diagonal shadow across the fin.
  plate.tessellate(0.2);
  half.append(plate, finFrame);
  // Two stripes under the top edge, on both faces.
  for (const drop of [0.07, 0.135]) {
    // Stops short of the trailing edge: run into the rounded rim, a stripe
    // wraps round it and shows as a stray fleck from behind.
    const a: Vec2 = [-1.13, 1.631 - drop];
    const b: Vec2 = [-1.375, 1.701 - drop];
    const bar: Vec2[] = [
      [a[0], a[1] - 0.02],
      [b[0], b[1] - 0.02],
      [b[0], b[1] + 0.02],
      [a[0], a[1] + 0.02],
    ];
    flankDecal(half, bar, 1, fin, STRIPE, 60);
    flankDecal(half, bar, -1, fin, STRIPE, 60);
  }

  // --- pod stand-offs: short struts from the frame, a bolt head outside ----
  const strut = (from: P3, to: P3): void => {
    cylinder(half, { from, to, radius: 0.02, sides: 8 }, GUNMETAL);
  };
  // Top edge, off the door bar.
  strut([0.505, 0.805, 0.2], [0.566, 0.728, 0.2]);
  strut([0.47, 0.835, -0.42], [0.552, 0.838, -0.42]);
  addBolt(half, { at: [0.576, 0.733, 0.2], normal: [0.5, 0.85, 0], radius: 0.014 });
  addBolt(half, { at: [0.561, 0.852, -0.42], normal: [0.5, 0.85, 0], radius: 0.014 });
  // Lower corners, on the steel ball joints of the rail.
  for (const z of [0.5, -0.24]) addBolt(half, { at: [0.551, 0.437, z], normal: [0.89, -0.46, 0], radius: 0.014 });

  // --- fin pylons ------------------------------------------------------------
  const PYLON = GUNMETAL;
  const root = (z: number): P3 => {
    // On the fin's bottom edge, a little way up into the plate.
    const t = (-0.75 - z) / (1.24 - 0.75);
    const y = 1.3 + t * 0.07 + 0.03;
    return [finPoint([z, y])[0] - 0.02, y, z];
  };
  tube(half, { path: [[0.325, 1.27, -0.68], root(-0.84)], radius: 0.022, sides: 8, caps: true }, PYLON);
  tube(half, { path: [N.rearNode, root(-1.02)], radius: 0.022, sides: 8, caps: true }, PYLON);
  // A short brace from the upper longeron, behind the boosters' shoulders:
  // each fin stands on its own three legs, no bar ties the pair together.
  tube(half, { path: [[0.316, 1.03, -1.12], root(-1.16)], radius: 0.02, sides: 8, caps: true }, PYLON);
  // A foot plate under the fin's root, bolted through.
  roundedBox(half, { size: [0.03, 0.07, 0.3], radius: 0.01, segments: 1, at: [root(-0.93)[0] - 0.012, 1.345, -0.93], rot: [-6, 6, 0] }, PYLON);
  for (const z of [-0.84, -1.02]) addBolt(half, { at: [finPoint([z, 1.36])[0] + 0.022, 1.36, z], normal: [1, 0, 0], radius: 0.012 }, STEEL);

  half.mirrorCopy('x');
  m.append(half);
}
