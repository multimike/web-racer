/**
 * Shape helpers for SolidMesh — everything an asset is assembled from. This
 * file is the single import point; the implementations live next to it
 * (primitives.ts, sweep.ts, extrude.ts, regions.ts, hull.ts, rings.ts,
 * paths.ts).
 *
 * CONVENTIONS SHARED BY EVERY HELPER
 *  - Signature: `shape(m, options, paint)` — appends into the SolidMesh `m`.
 *    `options` is ONE object with named fields (no positional numbers to get
 *    wrong); `paint` comes last.
 *  - Units are meters, angles are DEGREES.
 *  - Axes: +x right, +y up, +z forward. Shapes with an axis (cylinder, cone,
 *    capsule, revolve, sphere poles, torus axis, helix) use local +Y.
 *  - Shapes are CENTRED on their local origin unless documented otherwise
 *    (extrudePolygon grows from z = 0 to z = depth).
 *  - Placement: every options object accepts
 *        rot: [degX, degY, degZ]   rotate about the local origin, X then Y then Z
 *        at:  [x, y, z] | Matrix   then move (or apply a full matrix)
 *    and the +Y-axis shapes also accept `from` / `to` end points instead.
 *    Useful rotations: +Y → +X is rot [0, 0, -90]; +Y → +Z is rot [90, 0, 0];
 *    +Z → +X is rot [0, 90, 0]; +Z → −Z (face the street) is rot [0, 180, 0].
 *  - Every helper emits OUTWARD-facing triangles; mirrored placements are
 *    fixed up automatically. You never handle winding.
 *  - Smooth vs faceted is decided by the PAINT (`smooth` crease angle), not
 *    by the helper: the same `icosphere` is a smooth ball with the default
 *    paint and a faceted rock with `paint(c, { smooth: 0 })`. Round helpers
 *    (cylinder, cone, sphere, capsule, torus, revolve, tube, roundedBox,
 *    bevels) keep their ROUND direction smooth even at low segment counts by
 *    raising the crease angle of their own faces as needed (`soften`); their
 *    caps and right-angle edges stay crisp. `loft`, `sweep`, `extrudePolygon`
 *    and `Cage` follow the paint's angle exactly: section corners sharper
 *    than it are crisp feature lines, gentler ones are smooth.
 *  - Paint argument: a `Paint`, or a function returning a Paint per patch
 *    (null = leave that patch open). Primitives pass (band, segment); sweeps
 *    and lofts pass (u, v, i, j) — see each helper.
 *  - Resolution options (`segments`, `sides`, `rings`…) default to counts
 *    that suit a ~1 m object viewed from the diorama camera; raise them on
 *    hero car parts, lower them on scatter props (budgets are in the brief).
 *    For car close-ups with glossy paint: tubes 14–16 sides, lofts 28–32
 *    points around, wheels 32–48 segments — a glossy highlight shows every
 *    facet of the SILHOUETTE even where the shading is smooth.
 *  - Anything ASYMMETRIC drawn as a flat outline (letters, numbers, logos,
 *    arrows, a window off to one side) must say which way it faces:
 *    `facing: '-z' | '+z' | '+x' | '-x' | '+y' | '-y'` on `extrudePolygon`
 *    and `paintDecal`, with the outline drawn as SEEN from that side (x =
 *    the viewer's right, y = up). Without it an outline is raw local
 *    coordinates and reads mirrored from its front (left-handed world).
 *  - Crisp colour regions that do not follow the faces — stripes, roundels,
 *    swirls, two-tone splits, cut-outs — are `paintStripe` / `paintDecal` /
 *    `paintWhere` (regions.ts): they split the triangles along the boundary
 *    and leave the shading untouched.
 *  - A loft that ends in a POINT pinches its highlight into a starburst;
 *    end on a small ring (5–10 % of the body's width) plus `caps` instead.
 *  - To post-process only what a helper just added, bracket it:
 *        const s = m.mark();  cylinder(m, …);  m.rotate('x', 20, s);
 *
 * WORKED EXAMPLE — a toy house with rounded edges, built from four helpers:
 *
 *   import { SolidMesh, paint, roundedBox, extrudePolygon, cylinder, tube, roundedRectRing, paintStripe } from '../../gfx/solid';
 *   import { BUILDING } from '../palette';
 *
 *   export function buildHouse(): SolidMesh {
 *     const WALL = paint(BUILDING.cream, { gloss: 0.15 });
 *     const ROOF = paint(BUILDING.coral, { gloss: 0.4 });
 *     const TRIM = paint(BUILDING.timber);
 *     const LAMP = paint('#FFD9A0', { emissive: 0.8 });
 *     const m = new SolidMesh();
 *     roundedBox(m, { size: [4, 2.4, 3], radius: 0.1, segments: 2, at: [0, 1.2, 0] }, WALL);
 *     paintStripe(m, { axis: 'y', max: 0.45 }, paint(BUILDING.stone));   // plinth band round the base
 *     extrudePolygon(m, {                                    // gable roof prism along z
 *       outline: [[-2.3, 2.3], [2.3, 2.3], [0, 4.0]],
 *       depth: 3.5, centered: true, bevel: 0.06, bevelBack: true,
 *     }, ROOF);
 *     extrudePolygon(m, {                                    // window frame on the street front (−z)
 *       outline: roundedRectRing(1.0, 1.1, 0.1), holes: [roundedRectRing(0.8, 0.9, 0.06)],
 *       depth: 0.08, bevel: 0.02, bevelSegments: 2, back: false, facing: '-z', at: [0.9, 1.4, -1.5],
 *     }, TRIM);
 *     roundedBox(m, { size: [0.8, 0.9, 0.04], radius: 0.01, segments: 1, at: [0.9, 1.4, -1.5] }, LAMP);
 *     cylinder(m, { from: [1.2, 3.0, 0.5], to: [1.2, 4.4, 0.5], radius: 0.22, sides: 10, bevel: 0.05 }, WALL);
 *     tube(m, { path: [[-2.05, 0, -1.55], [-2.05, 2.5, -1.55], [-1.2, 2.9, -1.55]], radius: 0.04, fillet: 0.2 }, TRIM);
 *     return m;                                              // the assembler refines + bakes the AO
 *   }
 */

export {
  box,
  roundedBox,
  revolve,
  frustum,
  cylinder,
  cone,
  sphere,
  icosphere,
  capsule,
  torus,
  quadFacing,
  triFacing,
  polygonFacing,
  loopNormal,
} from './primitives';
export type {
  AxisSpan,
  BoxFaces,
  BoxOptions,
  RoundedBoxOptions,
  RevolveOptions,
  FrustumOptions,
  CylinderOptions,
  ConeOptions,
  SphereOptions,
  IcosphereOptions,
  CapsuleOptions,
  TorusOptions,
} from './primitives';

export { tube, sweep, loft } from './sweep';
export type { TubeOptions, SweepOptions, LoftOptions, PatchPaint } from './sweep';

export { extrudePolygon, thicken, facingFrame } from './extrude';
export type { ExtrudeOptions, ThickenOptions, Facing } from './extrude';

export { paintWhere, paintStripe, paintDecal } from './regions';
export type { RegionOptions, PaintWhereOptions, PaintStripeOptions, PaintDecalOptions } from './regions';

export { convexHull, hullIndices, blob } from './hull';
export type { BlobOptions, ConvexHullOptions } from './hull';

export {
  circleRing,
  ellipseRing,
  superellipseRing,
  roundedRectRing,
  polygonRing,
  resampleRing,
  resampleRing3,
  scaleRing,
  translateRing,
  ringXY,
  ringXZ,
  placeRing,
  ringOnFrame,
} from './rings';

export {
  pathLength,
  resamplePath,
  linePath,
  bezierPath,
  quadraticBezierPath,
  catmullRomPath,
  catmullRomPoint,
  arcPath,
  helixPath,
  filletPath,
  filletProfile,
  filletRing,
  pathFrames,
  rotateBetween,
} from './paths';
export type { ArcPathOptions, HelixPathOptions, FilletOptions, PathFrame } from './paths';

export { triangulate, offsetRing, signedArea, dedupeRing } from './triangulate';
export type { Triangulation } from './triangulate';
