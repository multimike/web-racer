import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Effect } from '@babylonjs/core/Materials/effect';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import {
  Cage,
  SolidMesh,
  arcPath,
  bakeAO,
  blob,
  box,
  capsule,
  catmullRomPath,
  circleRing,
  compose,
  cone,
  convexHull,
  cylinder,
  extrudePolygon,
  fbm3,
  filletRing,
  frustum,
  helixPath,
  hex,
  icosphere,
  jitterColor,
  linePath,
  loft,
  mirroring,
  mix,
  noise3,
  paint,
  paintDecal,
  paintStripe,
  paintWhere,
  polygonRing,
  revolve,
  ringXY,
  ringXZ,
  rng,
  rotation,
  roundedBox,
  roundedRectRing,
  scaling,
  sphere,
  superellipseRing,
  sweep,
  thicken,
  torus,
  translation,
  tube,
} from '../gfx/solid';
import type { AOOptions, RGB, Vec2 } from '../gfx/solid';
import { BARK, BUILDING, COMET_FOX, FOLIAGE, NEON_WASP, REEF_ROCKET, RIOT_RAM, STONE } from '../assets/palette';

/**
 * TEMPORARY test page for the solid kit (solid-test.html) — a labelled grid
 * of every shape helper, rendered with a minimal debug shader, plus a
 * numeric audit (watertightness, outward volume, normal agreement) of each
 * case. Not part of the game; delete together with solid-test.html once the
 * asset lab covers the kit.
 *
 * URL: /solid-test.html?yaw=35&pitch=25&zoom=1&cols=5&page=0&per=15
 *        &cells=box,loft-pod        only these cases
 *        &debug=backface|normals|ao|flat|none
 *        &ui=0                      hide labels
 */

// ---------------------------------------------------------------------------
// Catalog

export interface TestCase {
  id: string;
  /** Expect a closed 2-manifold with positive volume. */
  closed: boolean;
  build(m: SolidMesh): void;
  ao?: AOOptions;
  /** Exact volume to compare with, when the shape has one (m³). */
  volume?: number;
}

const TEAL = paint(REEF_ROCKET.bodyTurquoise, { gloss: 0.8 });
const CORAL = paint(REEF_ROCKET.cageCoral, { gloss: 0.6 });
const CREAM = paint(BUILDING.cream, { gloss: 0.2 });
const ROOF = paint(BUILDING.coral, { gloss: 0.4 });
const TIMBER = paint(BUILDING.timber);
const COBALT = paint(RIOT_RAM.bodyCobalt, { gloss: 0.8 });
const YELLOW = paint(NEON_WASP.bodyYellow, { gloss: 0.8 });
const RED = paint(COMET_FOX.bodyVermilion, { gloss: 0.8 });
const RUBBER = paint(REEF_ROCKET.rubber, { gloss: 0.1 });
const METAL = paint(REEF_ROCKET.metal, { gloss: 0.7, metal: 1 });
const ROCK = paint(STONE.base, { smooth: 0, gloss: 0.05 });
const LEAF = paint(FOLIAGE.jade, { smooth: 0, gloss: 0.1 });
const GLOW = paint(BUILDING.cyanLight, { emissive: 1 });

const star = (points: number, r0: number, r1: number): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? r0 : r1;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
};

/** An asymmetric part (an "L" bracket with a cone on one arm) — any mirror
 * or winding mistake is obvious on it. */
function bracket(m: SolidMesh): void {
  extrudePolygon(m, { outline: [[0, 0], [1.2, 0], [1.2, 0.35], [0.35, 0.35], [0.35, 1.0], [0, 1.0]], depth: 0.3, bevel: 0.04 }, TEAL);
  cone(m, { from: [0.9, 0.35, 0.15], to: [0.9, 0.9, 0.15], radius: 0.18, sides: 12 }, CORAL);
  box(m, { size: [0.15, 0.15, 0.15], at: [0.17, 0.8, 0.36] }, YELLOW);
}

export const CASES: TestCase[] = [
  {
    // The worked example from the SolidMesh.ts header, verbatim.
    id: 'doc-example-solidmesh',
    closed: true,
    ao: { ground: true },
    build: (m) => {
      const WALL = paint('#F4E3C4', { gloss: 0.15 });
      const ROOFP = paint('#F16B59', { gloss: 0.35 });
      const TRIM = paint('#AD6338');
      const GLOWP = paint('#44DDE8', { emissive: 0.9 });
      roundedBox(m, { size: [4, 2.4, 3], radius: 0.08, at: [0, 1.2, 0] }, WALL);
      extrudePolygon(m, { outline: [[-2.3, 2.3], [2.3, 2.3], [0, 4.0]], depth: 3.4, bevel: 0.05, bevelBack: true, at: [0, 0, -1.7] }, ROOFP);
      box(m, { size: [0.9, 1.9, 0.08], at: [-0.9, 0.95, -1.52] }, TRIM);
      box(m, { size: [0.9, 0.9, 0.06], at: [0.9, 1.4, -1.52] }, GLOWP);
      cylinder(m, { from: [1.2, 3.0, 0.6], to: [1.2, 4.3, 0.6], radius: 0.22, sides: 10, bevel: 0.04 }, WALL);
      m.recolor((_p, n, c) => (n.y > 0.5 ? [c[0] * 1.06, c[1] * 1.04, c[2]] : c));
    },
  },
  {
    // The worked example from the shapes.ts header, verbatim.
    id: 'doc-example-shapes',
    closed: false, // the window frame is deliberately built without a back face
    ao: { ground: true },
    build: (m) => {
      const WALL = paint(BUILDING.cream, { gloss: 0.15 });
      const ROOFP = paint(BUILDING.coral, { gloss: 0.4 });
      const TRIM = paint(BUILDING.timber);
      const LAMP = paint(BUILDING.cyanLight, { emissive: 1 });
      roundedBox(m, { size: [4, 2.4, 3], radius: 0.1, segments: 2, at: [0, 1.2, 0] }, WALL);
      extrudePolygon(m, { outline: [[-2.3, 2.3], [2.3, 2.3], [0, 4.0]], depth: 3.5, centered: true, bevel: 0.06, bevelBack: true }, ROOFP);
      extrudePolygon(
        m,
        { outline: roundedRectRing(1.0, 1.1, 0.1), holes: [roundedRectRing(0.8, 0.9, 0.06)], depth: 0.08, bevel: 0.02, back: false, rot: [0, 180, 0], at: [0.9, 1.4, -1.5] },
        TRIM,
      );
      roundedBox(m, { size: [0.8, 0.9, 0.04], radius: 0.01, segments: 1, at: [0.9, 1.4, -1.5] }, LAMP);
      cylinder(m, { from: [1.2, 3.0, 0.5], to: [1.2, 4.4, 0.5], radius: 0.22, sides: 10, bevel: 0.05 }, WALL);
      tube(m, { path: [[-2.05, 0, -1.55], [-2.05, 2.5, -1.55], [-1.2, 2.9, -1.55]], radius: 0.04, fillet: 0.2 }, TRIM);
    },
  },
  {
    // The loft example from sweep.ts and the cage example from subdivide.ts.
    id: 'doc-example-loft-cage',
    closed: true,
    build: (m) => {
      const BODY = TEAL;
      const BELLY = paint(REEF_ROCKET.trimCream, { gloss: 0.6 });
      const sec = (w: number, h: number): Vec2[] => superellipseRing(w / 2, h / 2, 3.2, 20);
      loft(
        m,
        { rings: [ringXY(sec(0.02, 0.02), 1.5, 0, 0.45), ringXY(sec(0.9, 0.5), 0.9, 0, 0.5), ringXY(sec(1.2, 0.7), -0.2, 0, 0.55), ringXY(sec(0.7, 0.45), -1.5, 0, 0.6)], caps: true },
        (_u, v) => (v > 0.5 ? BELLY : BODY),
      );
      const c = new Cage();
      const v = c.vertices([
        [-0.5, 0, -1], [0.5, 0, -1], [0.5, 0, 1], [-0.5, 0, 1],
        [-0.6, 0.5, -1.2], [0.6, 0.5, -1.2], [0.6, 0.5, 1.2], [-0.6, 0.5, 1.2],
      ]);
      c.face([v[0], v[1], v[2], v[3]], BELLY);
      c.face([v[7], v[6], v[5], v[4]], BODY);
      c.face([v[4], v[5], v[1], v[0]], BODY);
      c.face([v[5], v[6], v[2], v[1]], BODY);
      c.face([v[6], v[7], v[3], v[2]], BODY);
      c.face([v[7], v[4], v[0], v[3]], BODY);
      c.creaseLoop([v[0], v[1], v[2], v[3]]);
      c.emit(m, { levels: 2, at: [1.8, 0.2, 0] });
    },
  },
  { id: 'box', closed: true, volume: 2 * 1 * 1.5, build: (m) => box(m, { size: [2, 1, 1.5] }, CREAM) },
  {
    id: 'box-open-faces',
    closed: false,
    build: (m) => box(m, { min: [-1, 0, -0.7], max: [1, 1.2, 0.7], faces: { py: null, pz: ROOF, px: COBALT } }, CREAM),
  },
  { id: 'roundedBox-seg1', closed: true, build: (m) => roundedBox(m, { size: [2, 1.2, 1.5], radius: 0.25, segments: 1 }, TEAL) },
  { id: 'roundedBox-seg2', closed: true, build: (m) => roundedBox(m, { size: [2, 1.2, 1.5], radius: 0.25 }, TEAL) },
  {
    id: 'roundedBox-seg4-faces',
    closed: true,
    build: (m) => roundedBox(m, { size: [2, 1.2, 1.5], radius: 0.3, segments: 4, faces: { py: CORAL, pz: YELLOW } }, CREAM),
  },
  { id: 'roundedBox-pill', closed: true, build: (m) => roundedBox(m, { size: [2, 0.8, 0.8], radius: 0.4, segments: 3 }, COBALT) },
  { id: 'cylinder', closed: true, volume: Math.PI * 0.6 * 0.6 * 1.6 * (Math.sin(Math.PI / 12) / (Math.PI / 12)) * Math.cos(Math.PI / 12), build: (m) => cylinder(m, { radius: 0.6, height: 1.6, sides: 12 }, CREAM) },
  { id: 'cylinder-bevel', closed: true, build: (m) => cylinder(m, { radius: 0.7, height: 1.2, sides: 24, bevel: 0.15, bevelSegments: 3, capPaint: CORAL }, TEAL) },
  { id: 'cylinder-from-to', closed: true, build: (m) => cylinder(m, { from: [-0.8, -0.6, 0.3], to: [0.7, 0.8, -0.4], radius: 0.25, sides: 10, bevel: 0.06 }, METAL) },
  { id: 'cylinder-arc270', closed: true, build: (m) => cylinder(m, { radius: 0.8, height: 1, sides: 18, arc: 270, arcStart: 30, capPaint: YELLOW }, COBALT) },
  { id: 'cylinder-open-tube', closed: false, build: (m) => cylinder(m, { radius: 0.6, height: 1.4, sides: 16, caps: false }, CORAL) },
  { id: 'cone', closed: true, build: (m) => cone(m, { radius: 0.7, height: 1.6, sides: 16 }, ROOF) },
  { id: 'frustum-bevel', closed: true, build: (m) => frustum(m, { radiusBottom: 0.8, radiusTop: 0.45, height: 1.3, sides: 20, bevel: { top: 0.12, bottom: 0.2 } }, TIMBER) },
  { id: 'sphere', closed: true, build: (m) => sphere(m, { radius: 0.9, segments: 20 }, TEAL) },
  {
    id: 'sphere-two-colours-smooth',
    closed: true,
    // Different paints on one smooth surface: crisp colour edge, continuous shading.
    build: (m) => sphere(m, { radius: 0.9, segments: 20 }, (band, seg) => ((band + (seg >> 2)) % 2 ? RED : paint(COMET_FOX.stripeWhite, { gloss: 0.8 }))),
  },
  { id: 'ellipsoid', closed: true, build: (m) => sphere(m, { radii: [1.1, 0.5, 0.75], segments: 18 }, YELLOW) },
  { id: 'dome', closed: true, build: (m) => sphere(m, { radius: 0.9, latitude: [0, 90], capPaint: CORAL }, CREAM) },
  { id: 'sphere-band-open', closed: false, build: (m) => sphere(m, { radius: 0.9, latitude: [-40, 50], caps: false }, COBALT) },
  { id: 'icosphere-smooth', closed: true, build: (m) => icosphere(m, { radius: 0.9, subdivisions: 2 }, CORAL) },
  {
    id: 'icosphere-rock',
    closed: true,
    build: (m) => {
      icosphere(m, { radii: [1.1, 0.75, 0.9], subdivisions: 1 }, ROCK);
      m.displace((p) => (noise3(p.x * 1.6, p.y * 1.6, p.z * 1.6, 3) - 0.5) * 0.5);
      // Warm cream tops, cool shadow undersides — a recolor pass on face normals.
      m.recolor((_p, n, c) => (n.y > 0.55 ? STONE.upperFace : n.y < -0.2 ? mix(c, STONE.shadow, 0.7) : c));
    },
  },
  { id: 'capsule', closed: true, build: (m) => capsule(m, { radius: 0.4, height: 1.8 }, YELLOW) },
  { id: 'capsule-from-to', closed: true, build: (m) => capsule(m, { from: [-0.8, -0.5, 0], to: [0.8, 0.6, 0.5], radius: 0.25, sides: 10, rings: 3 }, RED) },
  { id: 'torus', closed: true, volume: undefined, build: (m) => torus(m, { radius: 0.75, tube: 0.25, segments: 28, sides: 12 }, CORAL) },
  { id: 'torus-arc-arch', closed: true, build: (m) => torus(m, { radius: 0.8, tube: 0.15, arc: 180, rot: [-90, 0, 0], at: [0, -0.4, 0] }, TIMBER) },
  {
    id: 'revolve-wheel-lugs',
    closed: true,
    ao: { rays: 8 },
    build: (m) => {
      // Tire: profile walked counter-clockwise (bottom → outer wall → top),
      // tread points 2..5 scaled per segment for square lugs; rim inside.
      const tire: Vec2[] = [[0.42, -0.3], [0.62, -0.3], [0.8, -0.24], [0.84, -0.12], [0.84, 0.12], [0.8, 0.24], [0.62, 0.3], [0.42, 0.3]];
      revolve(
        m,
        {
          profile: tire,
          closed: true,
          segments: 36,
          radiusScale: (pt, seg) => (pt >= 2 && pt <= 5 && seg % 3 !== 0 ? 1.07 : 1),
          rot: [0, 0, -90],
        },
        RUBBER,
      );
      revolve(m, { profile: [[0, -0.2], [0.3, -0.2], [0.42, -0.26], [0.42, 0.26], [0.3, 0.12], [0, 0.16]], segments: 24, rot: [0, 0, -90] }, METAL);
    },
  },
  {
    id: 'revolve-vase-open',
    closed: false,
    build: (m) => {
      const s = m.mark();
      revolve(m, { profile: [[0, -0.9], [0.5, -0.9], [0.75, -0.3], [0.4, 0.4], [0.55, 0.9]], segments: 20 }, (band) => (band === 2 ? CORAL : CREAM));
      thicken(m, { thickness: 0.06, from: s, innerPaint: COBALT });
    },
  },
  {
    id: 'revolve-arc-gear',
    closed: true,
    build: (m) =>
      revolve(
        m,
        {
          profile: [[0.3, -0.2], [0.7, -0.2], [0.8, -0.12], [0.8, 0.12], [0.7, 0.2], [0.3, 0.2]],
          closed: true,
          segments: 20,
          arc: 250,
          radiusScale: (pt, seg) => ((pt === 2 || pt === 3) && seg % 2 === 0 ? 1.18 : 1),
          capPaint: YELLOW,
        },
        METAL,
      ),
  },
  {
    id: 'tube-roll-hoop-fillet',
    closed: true,
    build: (m) => {
      tube(m, { path: [[-0.9, -0.8, 0], [-0.8, 0.7, 0], [0.8, 0.7, 0], [0.9, -0.8, 0]], radius: 0.07, sides: 10, fillet: 0.35 }, CORAL);
      // Same polyline without fillet for comparison: mitred kinks.
      tube(m, { path: [[-0.9, -0.8, 0.6], [-0.8, 0.7, 0.6], [0.8, 0.7, 0.6], [0.9, -0.8, 0.6]], radius: 0.07, sides: 10 }, METAL);
    },
  },
  {
    id: 'tube-3d-bends',
    closed: true,
    build: (m) =>
      tube(m, { path: [[-0.9, -0.7, -0.6], [-0.9, 0.6, -0.6], [0.2, 0.6, -0.6], [0.2, 0.6, 0.7], [0.9, -0.2, 0.7]], radius: 0.09, sides: 12, fillet: 0.3, caps: 'round' }, TEAL),
  },
  {
    id: 'tube-taper-branch',
    closed: true,
    build: (m) =>
      tube(
        m,
        { path: catmullRomPath([[-0.8, -0.9, 0], [-0.3, -0.2, 0.2], [0.1, 0.1, -0.2], [0.7, 0.9, 0.1]], 6), radius: (t) => 0.22 * (1 - 0.75 * t), sides: 7 },
        paint(BARK.base, { smooth: 0 }),
      ),
  },
  {
    id: 'tube-closed-loop',
    closed: true,
    build: (m) =>
      tube(m, { path: [[-0.9, -0.6, -0.5], [0.9, -0.6, -0.5], [0.9, 0.6, 0.5], [-0.9, 0.6, 0.5]], radius: 0.08, sides: 10, fillet: 0.3, closed: true }, YELLOW),
  },
  {
    id: 'tube-helix-spring',
    closed: true,
    build: (m) => tube(m, { path: helixPath({ radius: 0.45, yFrom: -0.9, yTo: 0.9, turns: 6, samplesPerTurn: 14 }), radius: 0.06, sides: 8 }, paint(RIOT_RAM.springsLime, { gloss: 0.7 })),
  },
  {
    id: 'sweep-rail-twist',
    closed: true,
    build: (m) => {
      sweep(m, { path: arcPath({ radius: 0.9, from: 200, to: -20, plane: 'xy', segments: 16 }), section: roundedRectRing(0.3, 0.12, 0.04, 2), up: [0, 0, 1] }, COBALT);
      sweep(m, { path: linePath([-0.9, -0.9, 0], [0.9, -0.9, 0], 16), section: polygonRing(4, 0.14, 45), twist: (t) => t * 180, up: [0, 1, 0] }, CORAL);
    },
  },
  {
    id: 'loft-pod',
    closed: true,
    build: (m) => {
      const sec = (w: number, h: number): Vec2[] => superellipseRing(w / 2, h / 2, 3.2, 20);
      loft(
        m,
        {
          rings: [ringXY(sec(0, 0), 1.2, 0, -0.1), ringXY(sec(0.8, 0.45), 0.75, 0, -0.05), ringXY(sec(1.15, 0.7), -0.2, 0, 0), ringXY(sec(0.7, 0.5), -1.2, 0, 0.1)],
          caps: 'end',
          capPaint: METAL,
        },
        (_u, v) => (v > 0.5 ? paint(REEF_ROCKET.trimCream, { gloss: 0.6 }) : TEAL),
      );
    },
  },
  {
    id: 'loft-ruled-tower',
    closed: true,
    build: (m) =>
      loft(m, { rings: [ringXZ(roundedRectRing(1.4, 1.4, 0.15, 3), -0.9), ringXZ(roundedRectRing(1.1, 1.1, 0.3, 3), 0.3), ringXZ(circleRing(0.35, 20), 0.9)], subdivisions: 1, caps: true }, CREAM),
  },
  {
    id: 'loft-mixed-sections-sharp',
    closed: true,
    build: (m) =>
      loft(
        m,
        {
          rings: [
            ringXZ(circleRing(0.5, 24), -0.9),
            ringXZ(circleRing(0.75, 24), -0.3),
            ringXZ(roundedRectRing(1.3, 1.0, 0.2, 5), 0.2),
            ringXZ(roundedRectRing(1.0, 0.7, 0.2, 5), 0.9),
          ],
          around: 24,
          sharp: [2],
          caps: true,
          capPaint: CORAL,
        },
        YELLOW,
      ),
  },
  {
    id: 'loft-cutout-thicken',
    closed: true,
    ao: {},
    build: (m) => {
      const s = m.mark();
      const sec = (w: number, h: number): Vec2[] => superellipseRing(w / 2, h / 2, 2.6, 24);
      loft(
        m,
        { rings: [ringXY(sec(0.9, 0.7), 1.0), ringXY(sec(1.4, 1.0), 0.3), ringXY(sec(1.4, 1.0), -0.4), ringXY(sec(0.8, 0.6), -1.0)], subdivisions: 3 },
        // A cockpit opening: null patches on top, mid-length.
        (u, v) => (u > 0.3 && u < 0.72 && v > 0.1 && v < 0.4 ? null : RED),
      );
      thicken(m, { thickness: 0.05, from: s, innerPaint: paint(COMET_FOX.rubber) });
    },
  },
  {
    id: 'loft-open-strip-fender',
    closed: true,
    build: (m) => {
      const s = m.mark();
      const arc = (r: number, z: number, w: number): Vector3[] => arcPath({ radius: r, from: 10, to: 170, plane: 'zy', segments: 12 }).map((p) => new Vector3(w, p.y - 0.4, p.z + z));
      loft(m, { rings: [arc(0.8, 0, -0.4), arc(0.95, 0, 0), arc(0.8, 0, 0.4)], closedRing: false, subdivisions: 3, flip: true }, COBALT);
      thicken(m, { thickness: 0.05, from: s });
    },
  },
  {
    id: 'extrude-gable-bevel',
    closed: true,
    build: (m) => extrudePolygon(m, { outline: [[-1, -0.6], [1, -0.6], [1, 0.2], [0, 0.9], [-1, 0.2]], depth: 0.8, centered: true, bevel: 0.08, bevelSegments: 2, bevelBack: true }, CREAM),
  },
  {
    id: 'extrude-frame-holes',
    closed: true,
    build: (m) =>
      extrudePolygon(
        m,
        {
          outline: roundedRectRing(2, 1.5, 0.2),
          holes: [roundedRectRing(0.6, 0.9, 0.08).map((p) => [p[0] - 0.5, p[1]] as const), circleRing(0.27, 16).map((p) => [p[0] + 0.5, p[1] + 0.3] as const), polygonRing(3, 0.18, 90).map((p) => [p[0] + 0.5, p[1] - 0.45] as const)],
          depth: 0.25,
          bevel: 0.04,
          bevelBack: true,
          frontPaint: CORAL,
        },
        TIMBER,
      ),
  },
  {
    id: 'extrude-star-emblem',
    closed: true,
    build: (m) => {
      extrudePolygon(m, { outline: star(5, 0.9, 0.4), depth: 0.2, bevel: 0.08, frontPaint: YELLOW }, paint(NEON_WASP.cageViolet));
      // Mounted flush on a body facing +x: no back face needed (open by design).
      extrudePolygon(m, { outline: filletRing([[-0.4, -0.25], [0.4, -0.25], [0.4, 0.25], [-0.4, 0.25]], 0.1), depth: 0.06, bevel: 0.02, rot: [0, 90, 0], at: [1.0, 0, 0] }, GLOW);
    },
  },
  {
    id: 'thicken-bowl',
    closed: true,
    build: (m) => {
      const s = m.mark();
      sphere(m, { radius: 0.9, latitude: [-90, 0], caps: false, segments: 20 }, CORAL);
      thicken(m, { thickness: 0.08, from: s, innerPaint: CREAM, rimPaint: METAL });
    },
  },
  {
    id: 'convexHull',
    closed: true,
    build: (m) => {
      const r = rng(4, 'hull');
      const pts = Array.from({ length: 40 }, () => r.inSphere().multiplyByFloats(1, 0.7, 0.85));
      convexHull(m, { points: pts }, (_i, f) => paint(jitterColor(r.fork(f), STONE.midSlate, { lightness: 0.05, hue: 6 }), { smooth: 0 }));
    },
  },
  {
    id: 'blob-rocks',
    closed: true,
    build: (m) => {
      blob(m, { radii: [0.7, 0.55, 0.6], points: 16, seed: 3, flatBelow: -0.3, at: [-0.5, 0, 0] }, ROCK);
      blob(m, { radius: 0.4, points: 10, seed: 9, jitter: 0.6, at: [0.6, -0.1, 0.3] }, paint(STONE.shadow, { smooth: 0 }));
      m.recolor((_p, n, c) => (n.y > 0.6 ? STONE.upperFace : c));
    },
  },
  {
    id: 'blob-tree',
    closed: true,
    ao: { ground: -1 },
    build: (m) => {
      tube(m, { path: [[0, -1, 0], [0.05, -0.3, 0], [0, 0.2, 0]], radius: [0.16, 0.12, 0.08], sides: 6 }, paint(BARK.base, { smooth: 0 }));
      const r = rng(1, 'tree');
      for (let i = 0; i < 5; i++) {
        const s = m.mark();
        blob(m, { radius: r.range(0.35, 0.55), points: 14, seed: i + 1, at: [r.range(-0.45, 0.45), r.range(0.1, 0.7), r.range(-0.4, 0.4)] }, LEAF);
        const tint = jitterColor(r, FOLIAGE.jade, { hue: 14, lightness: 0.06 });
        m.recolor((_p, n) => (n.y > 0.4 ? mix(tint, FOLIAGE.lime, 0.6) : n.y < -0.3 ? FOLIAGE.deepTeal : tint), s);
      }
      m.setWind((p) => Math.max(0, Math.min(1, (p.y + 0.2) / 1.2)));
    },
  },
  {
    id: 'cage-cube-levels',
    closed: true,
    build: (m) => {
      const mk = (): Cage => {
        const c = new Cage();
        const v = c.vertices([[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]].map((p) => [p[0] * 0.5, p[1] * 0.5, p[2] * 0.5] as const));
        c.face([v[3], v[2], v[1], v[0]], CORAL);
        c.face([v[4], v[5], v[6], v[7]], TEAL);
        c.face([v[0], v[1], v[5], v[4]], TEAL);
        c.face([v[1], v[2], v[6], v[5]], TEAL);
        c.face([v[2], v[3], v[7], v[6]], TEAL);
        c.face([v[3], v[0], v[4], v[7]], TEAL);
        return c;
      };
      mk().emit(m, { levels: 0, at: [-1.2, 0, 0] });
      mk().emit(m, { levels: 1 });
      mk().emit(m, { levels: 3, at: [1.2, 0, 0] });
    },
  },
  {
    id: 'cage-creases',
    closed: true,
    build: (m) => {
      const mk = (sharp: number): Cage => {
        const c = new Cage();
        const v = c.vertices([[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]);
        c.face([v[3], v[2], v[1], v[0]], CORAL);
        c.face([v[4], v[5], v[6], v[7]], YELLOW);
        c.face([v[0], v[1], v[5], v[4]], COBALT);
        c.face([v[1], v[2], v[6], v[5]], COBALT);
        c.face([v[2], v[3], v[7], v[6]], COBALT);
        c.face([v[3], v[0], v[4], v[7]], COBALT);
        c.creaseLoop([v[0], v[1], v[2], v[3]], sharp);
        return c;
      };
      mk(Infinity).emit(m, { levels: 3, at: [-0.7, 0, 0] }); // hard bottom rim, soft top
      mk(1.5).emit(m, { levels: 3, at: [0.7, 0, 0] }); // semi-sharp: tight rounded rim
    },
  },
  {
    id: 'cage-mirrored-fender-pod',
    closed: true,
    build: (m) => {
      // Right half of a bulbous pod, 3 × 3 control rings, mirrored across x.
      const c = new Cage();
      const zs = [-1.1, -0.4, 0.4, 1.1];
      const prof: [number, number][] = [[0, -0.35], [0.55, -0.3], [0.75, 0.1], [0.45, 0.45], [0, 0.5]];
      const grid = zs.map((z, zi) => {
        const k = zi === 0 || zi === zs.length - 1 ? 0.55 : 1;
        return prof.map(([x, y]) => c.vertex([x * k, y * k + (zi === 0 ? 0.05 : 0), z]));
      });
      c.patch(grid, RED, true);
      // End caps: fan quads onto a centre vertex on the mirror plane.
      const endFan = (row: number[], z: number, flip: boolean): void => {
        const centre = c.vertex([0, 0.05, z]);
        for (let i = 0; i + 2 < row.length; i += 2) {
          const f = [row[i], row[i + 1], row[i + 2], centre];
          c.face(flip ? f.slice().reverse() : f, paint(COMET_FOX.stripeWhite, { gloss: 0.8 }));
        }
      };
      endFan(grid[0], -1.25, false);
      endFan(grid[zs.length - 1], 1.25, true);
      c.mirror('x');
      c.emit(m);
    },
  },
  {
    id: 'mirror-copy',
    closed: true,
    build: (m) => {
      const part = new SolidMesh();
      bracket(part);
      m.append(part, [0.15, -0.5, 0]);
      m.mirrorCopy('x');
    },
  },
  {
    id: 'mirror-matrix-append',
    closed: true,
    build: (m) => {
      const part = new SolidMesh();
      bracket(part);
      // Mirror + rotate + non-uniform scale through append's matrix.
      m.append(part, compose(mirroring('z'), scaling(0.8, 1.2, 1), rotation('y', 35), translation(-0.9, -0.6, 0)));
      m.append(part, compose(scaling(-0.7, 0.7, 0.7), translation(1.2, -0.6, 0.5)));
    },
  },
  {
    id: 'scale-nonuniform-normals',
    closed: true,
    build: (m) => {
      sphere(m, { radius: 0.5, segments: 20 }, TEAL);
      m.scale([2, 0.5, 1]);
      const s = m.mark();
      roundedBox(m, { size: [0.6, 0.6, 0.6], radius: 0.12 }, CORAL);
      m.scale([1, 2.2, 0.6], s).rotate('z', 30, s).translate([0, 0.2, 0.9], s);
    },
  },
  {
    id: 'smooth-angles',
    closed: true,
    // The same 8-sided cylinder with crease angle 0 / 50 (default) / 180.
    build: (m) => {
      cylinder(m, { radius: 0.4, height: 1.4, sides: 8, at: [-1, 0, 0] }, paint(BUILDING.turquoise, { smooth: 0 }));
      cylinder(m, { radius: 0.4, height: 1.4, sides: 8, at: [0, 0, 0] }, paint(BUILDING.turquoise));
      cylinder(m, { radius: 0.4, height: 1.4, sides: 8, at: [1, 0, 0] }, paint(BUILDING.turquoise, { smooth: 180 }));
    },
  },
  {
    id: 'corner-colours-polygon',
    closed: false,
    build: (m) => {
      const a: RGB = hex('#F12532');
      const b: RGB = hex('#E9EF00');
      const c: RGB = hex('#244BCC');
      m.tri([-1, -0.9, 0], [-0.1, -0.9, 0], [-0.55, -0.1, 0], CREAM, [a, b, c]);
      m.quad([0.1, -0.9, 0], [1, -0.9, 0], [1, -0.1, 0], [0.1, -0.1, 0], CREAM, [a, b, c, b]);
      // Concave polygon (an arrow), ear-clipped.
      m.polygon([[-0.9, 0.3, 0], [0.2, 0.3, 0], [0.2, 0.1, 0], [0.9, 0.55, 0], [0.2, 1.0, 0], [0.2, 0.8, 0], [-0.9, 0.8, 0], [-0.6, 0.55, 0]], CORAL);
      m.flip(); // authored facing +z; the grid is viewed from −z
    },
  },
  {
    id: 'ao-house-ground',
    closed: true,
    ao: { ground: -0.9 },
    build: (m) => {
      const s = m.mark();
      roundedBox(m, { size: [1.6, 1.0, 1.2], radius: 0.06, at: [0, -0.4, 0] }, CREAM);
      m.tessellate(0.3, s);
      extrudePolygon(m, { outline: [[-0.95, 0.05], [0.95, 0.05], [0, 0.8]], depth: 1.5, centered: true, bevel: 0.04, bevelBack: true }, ROOF);
      box(m, { size: [0.35, 0.6, 0.08], at: [-0.3, -0.6, -0.62] }, TIMBER);
      box(m, { size: [0.3, 0.3, 0.06], at: [0.35, -0.3, -0.62] }, GLOW);
      cylinder(m, { from: [0.45, 0.2, 0.2], to: [0.45, 0.85, 0.2], radius: 0.12, sides: 10, bevel: 0.03 }, CREAM);
      box(m, { size: [0.5, 0.5, 0.5], at: [1.05, -0.65, 0.2] }, TIMBER);
    },
  },
  {
    id: 'ao-parts-contact',
    closed: true,
    ao: {},
    build: (m) => {
      sphere(m, { radius: 0.55, at: [-0.45, 0, 0], segments: 24 }, TEAL);
      sphere(m, { radius: 0.55, at: [0.45, 0, 0], segments: 24 }, CREAM);
      torus(m, { radius: 0.9, tube: 0.12, at: [0, -0.35, 0], segments: 32 }, CORAL);
      const s = m.mark();
      box(m, { size: [2.4, 0.1, 1.8], at: [0, -0.6, 0] }, CREAM);
      m.tessellate(0.2, s);
    },
  },
  {
    id: 'noise-displace-recolor',
    closed: true,
    build: (m) => {
      icosphere(m, { radius: 0.9, subdivisions: 3 }, paint(FOLIAGE.jade, { smooth: 180 }));
      m.displace((p) => (fbm3(p.x * 2, p.y * 2, p.z * 2, 3, 5) - 0.5) * 0.5);
      m.recolor((p) => mix(FOLIAGE.deepTeal, FOLIAGE.highlight, Math.max(0, Math.min(1, (p.y + 0.9) / 1.8))));
    },
  },
  // --- regression cases for the review fixes -----------------------------
  {
    // Door + windows at different heights: later hole bridges cross earlier
    // ones unless the bridge picks the right copy of a doubled edge.
    id: 'fix-wall-door-windows',
    closed: true,
    build: (m) =>
      extrudePolygon(
        m,
        {
          outline: [[-1.5, -1], [1.5, -1], [1.5, 1], [-1.5, 1]],
          holes: [
            [[-1.1, -0.8], [-0.5, -0.8], [-0.5, 0.5], [-1.1, 0.5]],
            roundedRectRing(0.7, 0.6, 0.06, 2).map((q) => [q[0] + 0.6, q[1] + 0.35] as const),
            roundedRectRing(0.5, 0.4, 0.06, 2).map((q) => [q[0] + 0.7, q[1] - 0.55] as const),
          ],
          depth: 0.25,
          bevel: 0.04,
          bevelSegments: 2,
          bevelBack: true,
          facing: '-z',
        },
        CREAM,
      ),
  },
  {
    // A loft whose last stations double back (recessed lens): the cap must
    // face out of the recess, not into the solid.
    id: 'fix-loft-recessed-cap',
    closed: true,
    build: (m) => {
      const sec = circleRing(1, 20);
      const ring = (k: number, z: number): Vector3[] => ringXY(sec.map((q) => [q[0] * k, q[1] * k] as const), z);
      loft(m, { rings: [ring(0.5, -0.9), ring(0.8, 0.5), ring(0.6, 0.5), ring(0.6, 0.15)], sharp: [1, 2], caps: true, capPaint: GLOW }, TEAL);
    },
  },
  {
    // Asymmetric outline drawn as seen from the front, on four sides of a
    // block: the F must read correctly from each side.
    id: 'fix-facing-letter-F',
    closed: false,
    build: (m) => {
      box(m, { size: [1.4, 1.4, 1.4] }, CREAM);
      const F: Vec2[] = [[-0.25, -0.4], [-0.05, -0.4], [-0.05, -0.05], [0.2, -0.05], [0.2, 0.12], [-0.05, 0.12], [-0.05, 0.23], [0.3, 0.23], [0.3, 0.4], [-0.25, 0.4]];
      extrudePolygon(m, { outline: F, depth: 0.06, bevel: 0.015, back: false, facing: '-z', at: [0, 0, -0.7] }, CORAL);
      extrudePolygon(m, { outline: F, depth: 0.06, bevel: 0.015, back: false, facing: '+x', at: [0.7, 0, 0] }, COBALT);
      extrudePolygon(m, { outline: F, depth: 0.06, bevel: 0.015, back: false, facing: '+z', at: [0, 0, 0.7] }, YELLOW);
      extrudePolygon(m, { outline: F, depth: 0.06, bevel: 0.015, back: false, facing: '-x', at: [-0.7, 0, 0] }, RED);
      extrudePolygon(m, { outline: F, depth: 0.06, bevel: 0.015, back: false, facing: '+y', at: [0, 0.7, 0] }, TIMBER);
    },
  },
  {
    // Region paint on a glossy tapering shell: constant-width stripe, door
    // roundel, concave swirl. Must stay closed and leave the shading alone.
    id: 'fix-stripe-decals',
    closed: true,
    build: (m) => {
      const sec = (w: number, h: number): Vec2[] => superellipseRing(w / 2, h / 2, 3.2, 24);
      loft(m, { rings: [ringXY(sec(0.3, 0.2), 1.2), ringXY(sec(1.1, 0.6), 0.6), ringXY(sec(1.3, 0.8), -0.3), ringXY(sec(0.7, 0.5), -1.2)], caps: true }, TEAL);
      paintStripe(m, { axis: 'x', min: -0.1, max: 0.1, only: (_c, n) => n.y > 0.15 }, CREAM);
      paintDecal(m, { outline: circleRing(0.2, 20), facing: '+x', at: [0, 0, -0.25] }, CREAM);
      paintDecal(m, { outline: [[-0.45, -0.08], [-0.05, -0.2], [0.4, -0.05], [0.42, 0.1], [0.05, -0.04], [-0.12, 0.2], [-0.45, 0.06]], facing: '-x', at: [0, 0, -0.1] }, CORAL);
    },
  },
  {
    // Cut-out (paint null) + thicken: an opening with a real rim.
    id: 'fix-cutout-thicken',
    closed: true,
    build: (m) => {
      sphere(m, { radius: 0.9, segments: 24, latitude: [0, 90], caps: false }, COBALT);
      paintWhere(m, { inside: (q) => 0.35 - Math.hypot(q.x, q.z - 0.45) }, null);
      thicken(m, { thickness: 0.05, rimPaint: CREAM });
    },
  },
  {
    // Tessellation must not change shading: left half tessellated, right not.
    id: 'fix-tessellate-shading',
    closed: true,
    build: (m) => {
      roundedBox(m, { size: [0.9, 1.2, 0.9], radius: 0.12, at: [-0.55, 0, 0] }, TEAL);
      m.tessellate(0.15);
      roundedBox(m, { size: [0.9, 1.2, 0.9], radius: 0.12, at: [0.55, 0, 0] }, TEAL);
    },
  },
  {
    // Hex nuts (round: false) on a bevelled disc, half cylinder with caps.
    id: 'fix-hex-arc',
    closed: true,
    build: (m) => {
      cylinder(m, { radius: 0.7, height: 0.25, bevel: 0.05, sides: 32, at: [0, -0.4, 0] }, METAL);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        cylinder(m, { radius: 0.09, height: 0.1, sides: 6, round: false, bevel: 0.015, at: [Math.cos(a) * 0.42, -0.24, Math.sin(a) * 0.42] }, CORAL);
      }
      cylinder(m, { radius: 0.45, height: 0.9, arc: 180, arcStart: 180, sides: 16, bevel: 0.04, at: [0, 0.45, 0.2] }, CREAM);
    },
  },
  {
    // Sweep with a section that changes along the path + open strip + hairpin.
    id: 'fix-sweep-varying',
    closed: false,
    build: (m) => {
      sweep(m, { path: arcPath({ radius: 0.8, from: 0, to: 180, plane: 'zy' }), section: (t) => roundedRectRing(0.25 + 0.3 * t, 0.08, 0.03, 2), up: [1, 0, 0] }, TEAL);
      const s = m.mark();
      sweep(m, { path: arcPath({ radius: 1.0, from: 20, to: 160, plane: 'zy' }), section: [[-0.25, -0.03], [-0.15, 0.03], [0.15, 0.03], [0.25, -0.03]], closedSection: false, up: [1, 0, 0], flip: true }, CORAL);
      thicken(m, { thickness: 0.03, from: s });
      tube(m, { path: [[-0.9, 0, -0.9], [-0.9, 0.9, -0.9], [-0.86, 0, -0.75]], radius: 0.04, sides: 12 }, METAL);
    },
  },
  {
    // Staggered left / right lugs: the step walls cross inside one band.
    id: 'fix-staggered-lugs',
    closed: false,
    build: (m) => {
      const R = 0.8;
      revolve(
        m,
        {
          profile: [[0, -0.3], [R - 0.12, -0.3], [R - 0.04, -0.26], [R, -0.22], [R, -0.015], [R, 0.015], [R, 0.22], [R - 0.04, 0.26], [R - 0.12, 0.3], [0, 0.3]],
          segments: 28,
          radiusScale: (b, seg) => (((b === 3 || b === 4) && seg % 2 === 0) || ((b === 5 || b === 6) && seg % 2 === 1) ? 1.07 : 1),
          rot: [0, 0, -90],
        },
        RUBBER,
      );
    },
  },
  {
    // AO at joints: a box resting on a slab at the same height, one sunk in,
    // a post with a below-ground skirt — all must darken toward the contact.
    id: 'fix-ao-contacts',
    closed: false,
    ao: { ground: -0.3 },
    build: (m) => {
      box(m, { min: [-1.3, -0.3, -0.9], max: [1.3, -0.2, 0.9] }, CREAM);
      box(m, { min: [-1.0, -0.2, -0.3], max: [-0.4, 0.4, 0.3] }, TEAL);
      box(m, { min: [-0.2, -0.25, -0.3], max: [0.4, 0.4, 0.3] }, CORAL);
      cylinder(m, { from: [0.9, -0.4, 0], to: [0.9, 0.7, 0], radius: 0.18, sides: 14 }, TIMBER);
      m.tessellate(0.18);
    },
  },
];

// ---------------------------------------------------------------------------
// Numeric audit — shared by the page labels and the Node check script.

export interface Audit {
  triangles: number;
  vertices: number;
  /** Edges not shared by exactly two oppositely-wound triangles. */
  openEdges: number;
  /** Signed volume by the divergence theorem (positive = outward-facing). */
  volume: number;
  /** Corners whose shading normal points away from their face normal. */
  badNormals: number;
  /** Non-finite numbers anywhere in the output buffers. */
  nan: number;
  bounds: [number, number, number];
  aoMin: number;
}

export function audit(m: SolidMesh): Audit {
  const N = m.computeNormals();
  const P = m.positions;
  const T = m.triangleCount;
  const edges = new Map<number, number>();
  const K = N.weldCount + 1;
  let volume = 0;
  let badNormals = 0;
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    volume +=
      (P[o] * (P[o + 4] * P[o + 8] - P[o + 5] * P[o + 7]) -
        P[o + 1] * (P[o + 3] * P[o + 8] - P[o + 5] * P[o + 6]) +
        P[o + 2] * (P[o + 3] * P[o + 7] - P[o + 4] * P[o + 6])) /
      6;
    for (let k = 0; k < 3; k++) {
      const a = N.weld[t * 3 + k];
      const b = N.weld[t * 3 + ((k + 1) % 3)];
      edges.set(a * K + b, (edges.get(a * K + b) ?? 0) + 1);
      const c = t * 3 + k;
      const d = N.normals[c * 3] * N.faceNormals[t * 3] + N.normals[c * 3 + 1] * N.faceNormals[t * 3 + 1] + N.normals[c * 3 + 2] * N.faceNormals[t * 3 + 2];
      if (!(d > 0.05)) badNormals++;
    }
  }
  let openEdges = 0;
  for (const [key, count] of edges) {
    const a = Math.floor(key / K);
    const b = key % K;
    if (count !== 1 || (edges.get(b * K + a) ?? 0) !== 1) openEdges++;
  }
  const d = m.toVertexData();
  let nan = 0;
  for (const arr of [d.positions, d.normals, d.colors, d.uvs, d.uvs2]) for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nan++;
  let aoMin = 1;
  for (let i = 0; i < d.uvs2.length; i += 2) aoMin = Math.min(aoMin, d.uvs2[i]);
  const b = m.bounds().size;
  return { triangles: T, vertices: d.vertexCount, openEdges, volume, badNormals, nan, bounds: [b.x, b.y, b.z], aoMin };
}

/** Build one case exactly as the page does. */
export function buildCase(c: TestCase): SolidMesh {
  const m = new SolidMesh();
  c.build(m);
  if (c.ao) bakeAO(m, c.ao);
  return m;
}

// ---------------------------------------------------------------------------
// Page

function createDebugMaterial(scene: Scene, mode: string): ShaderMaterial {
  Effect.ShadersStore['solidDebugVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    attribute vec2 uv;
    attribute vec2 uv2;
    uniform mat4 world;
    uniform mat4 viewProjection;
    varying vec3 vNormal;
    varying vec4 vColor;
    varying vec2 vSurf;
    varying vec2 vBake;
    varying vec3 vWorld;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorld = wp.xyz;
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      vColor = color;
      vSurf = uv;
      vBake = uv2;
      gl_Position = viewProjection * wp;
    }
  `;
  Effect.ShadersStore['solidDebugFragmentShader'] = `
    precision highp float;
    varying vec3 vNormal;
    varying vec4 vColor;
    varying vec2 vSurf;
    varying vec2 vBake;
    varying vec3 vWorld;
    uniform vec3 lightDir;
    uniform vec3 eye;
    uniform float mode;
    void main() {
      vec3 n = normalize(vNormal);
      if (mode > 0.5 && mode < 1.5) {
        // backface: anything seen from behind is magenta
        if (!gl_FrontFacing) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
      }
      if (mode > 1.5 && mode < 2.5) { gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); return; }
      if (mode > 2.5 && mode < 3.5) { gl_FragColor = vec4(vec3(vBake.x), 1.0); return; }
      if (mode > 4.5 && mode < 5.5) { gl_FragColor = vec4(vBake.y, vSurf.x, vSurf.y, 1.0); return; }
      float ndl = dot(n, lightDir);
      float wrap = ndl * 0.5 + 0.5;
      // Cool ambient, warm key: enough to judge smoothing, bevels and AO.
      vec3 lit = mix(vec3(0.34, 0.36, 0.52), vec3(1.08, 1.02, 0.92), wrap * wrap);
      vec3 base = vColor.rgb;
      vec3 col = base * lit * (mode > 3.5 && mode < 4.5 ? 1.0 : vBake.x);
      vec3 v = normalize(eye - vWorld);
      vec3 h = normalize(v + lightDir);
      float spec = pow(max(dot(n, h), 0.0), mix(8.0, 90.0, vSurf.x)) * vSurf.x * 0.6;
      col += spec * mix(vec3(1.0), base, vSurf.y);
      col = mix(col, base, vColor.a);
      gl_FragColor = vec4(col, 1.0);
    }
  `;
  const mat = new ShaderMaterial('solidDebug', scene, { vertex: 'solidDebug', fragment: 'solidDebug' }, {
    attributes: ['position', 'normal', 'color', 'uv', 'uv2'],
    uniforms: ['world', 'viewProjection', 'lightDir', 'eye', 'mode'],
  });
  const modes: Record<string, number> = { none: 0, backface: 1, normals: 2, ao: 3, flat: 4, attrs: 5 };
  mat.setFloat('mode', modes[mode] ?? 0);
  mat.setVector3('lightDir', new Vector3(-0.45, 0.75, -0.5).normalize());
  mat.backFaceCulling = mode !== 'backface';
  return mat;
}

function startPage(): void {
  const params = new URLSearchParams(location.search);
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(params.get(key) ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const labelLayer = document.getElementById('labels') as HTMLDivElement;
  const summary = document.getElementById('summary') as HTMLDivElement;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.86, 0.9, 0.95, 1);
  const mode = params.get('debug') ?? 'none';
  const material = createDebugMaterial(scene, mode);

  const filter = params.get('cells');
  let cases = filter ? CASES.filter((c) => filter.split(',').some((f) => c.id === f || c.id.startsWith(f))) : CASES;
  const per = num('per', 15);
  const page = num('page', -1);
  if (page >= 0) cases = cases.slice(page * per, page * per + per);
  const cols = Math.max(1, Math.min(num('cols', 5), cases.length));
  const rows = Math.ceil(cases.length / cols);
  const yaw = num('yaw', 30);
  const pitch = num('pitch', 28);
  const zoom = num('zoom', 1);
  const CELL = 3.3;
  // Rows recede into the screen; at a shallow pitch they must sit further
  // apart or the cases overlap each other in the picture.
  const ROW = Math.max(CELL, 3.1 / Math.max(Math.sin(Math.abs(pitch) * (Math.PI / 180)), 0.2));

  const labels: { el: HTMLDivElement; at: Vector3 }[] = [];
  let failures = 0;
  const lines: string[] = [];
  cases.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const origin = new Vector3((col - (cols - 1) / 2) * CELL, 0, ((rows - 1) / 2 - row) * ROW);
    let text = c.id;
    let bad = false;
    try {
      const t0 = performance.now();
      const m = buildCase(c);
      const ms = performance.now() - t0;
      const a = audit(m);
      // Fit every case into its cell so one camera frames them all.
      const b = m.bounds();
      const fit = 2.3 / Math.max(b.size.x, b.size.y, b.size.z, 1e-6);
      const mesh = m.build(c.id, scene);
      mesh.material = material;
      mesh.scaling.setAll(fit);
      mesh.position.copyFrom(origin.subtract(b.center.scale(fit)));
      const closedOk = c.closed ? a.openEdges === 0 && a.volume > 0 : true;
      const volOk = c.volume === undefined || Math.abs(a.volume - c.volume) < c.volume * 1e-6;
      bad = !closedOk || !volOk || a.badNormals > 0 || a.nan > 0;
      text = `${c.id}\n${a.triangles}t ${a.vertices}v ${ms.toFixed(0)}ms${c.closed ? (closedOk ? ' closed' : ` OPEN:${a.openEdges}`) : ' open'}${a.badNormals ? ` badN:${a.badNormals}` : ''}${a.nan ? ` NaN:${a.nan}` : ''}${volOk ? '' : ' VOL'}`;
    } catch (err) {
      bad = true;
      text = `${c.id}\nERROR ${(err as Error).message}`;
      console.error(c.id, err);
    }
    if (bad) failures++;
    lines.push(text.replace('\n', ' — '));
    const el = document.createElement('div');
    el.className = bad ? 'label bad' : 'label';
    el.textContent = text;
    labelLayer.appendChild(el);
    labels.push({ el, at: origin.add(new Vector3(0, -1.55, 0)) });
  });
  summary.textContent = `${cases.length} cases, ${failures} failing — debug=${mode}`;
  if (params.get('ui') === '0') {
    labelLayer.style.display = 'none';
    summary.style.display = 'none';
  }
  (window as unknown as { __solidTest: unknown }).__solidTest = { lines, failures };

  // Babylon ArcRotate: alpha about +Y from +x, beta from the +y pole. Yaw 0
  // looks from −z toward +z (front view of the grid), positive yaw orbits the
  // camera toward +x.
  const camera = new ArcRotateCamera('cam', (-90 + yaw) * (Math.PI / 180), (90 - pitch) * (Math.PI / 180), 60, Vector3.Zero(), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 400;
  camera.attachControl(canvas, true);
  const fitOrtho = (): void => {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    // Half extents of the grid as seen by the (yawed, pitched) ortho camera.
    const yr = Math.abs(yaw) * (Math.PI / 180);
    const pr = Math.abs(pitch) * (Math.PI / 180);
    const gx = (cols * CELL) / 2;
    const gz = (rows * ROW) / 2;
    const halfW = gx * Math.abs(Math.cos(yr)) + gz * Math.abs(Math.sin(yr)) + 0.8;
    const halfH = (gx * Math.abs(Math.sin(yr)) + gz * Math.abs(Math.cos(yr))) * Math.sin(pr) + 1.6 * Math.cos(pr) + 0.8;
    const half = Math.max(halfH, halfW / aspect) / zoom;
    camera.orthoTop = half;
    camera.orthoBottom = -half;
    camera.orthoLeft = -half * aspect;
    camera.orthoRight = half * aspect;
  };
  fitOrtho();
  window.addEventListener('resize', () => {
    engine.resize();
    fitOrtho();
  });

  engine.runRenderLoop(() => {
    material.setVector3('eye', camera.position);
    scene.render();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const vp = camera.viewport.toGlobal(w, h);
    const transform = scene.getTransformMatrix();
    const cssScale = canvas.clientWidth / w;
    for (const l of labels) {
      const p = Vector3.Project(l.at, Matrix.IdentityReadOnly, transform, vp);
      l.el.style.left = `${p.x * cssScale}px`;
      l.el.style.top = `${p.y * cssScale}px`;
    }
  });
}

if (typeof document !== 'undefined' && document.getElementById('view')) startPage();
