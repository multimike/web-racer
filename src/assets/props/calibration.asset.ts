import {
  SolidMesh,
  bakeAO,
  box,
  cone,
  cylinder,
  icosphere,
  jitterColor,
  mix,
  noise3,
  paint,
  rng,
  roundedBox,
  sphere,
} from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import {
  BARK,
  BUILDING,
  CAR_COMMON,
  COMET_FOX,
  FLOWERS,
  FOLIAGE,
  NEON_WASP,
  REEF_ROCKET,
  RIOT_RAM,
  STONE,
  SUCCULENT,
} from '../palette';
import type { ColliderSpec, PropAsset } from '../types';

/**
 * Look-calibration board — not a game prop but the permanent reference for
 * tuning the toy shader and the lighting (asset lab: `?asset=calibration`).
 * Everything on it has a known answer:
 *
 *   back left    1 m reference cube (scale; crisp bevel highlight)
 *   front left   axis gizmo, arrows 1 m long: X red (+x right), Y green (up),
 *                Z blue (+z = the nose of a car / the BACK of a building)
 *   back row     gloss ramp: five turquoise spheres, gloss 0 → 1, metal 0
 *   middle row   metal ramp: five grey spheres, metal 0 → 1 at gloss 0.7
 *   front row    emissive ramp: five lamps, emissive 0 → 1
 *   right        faceted rock (flat shading, cream top planes; the only part
 *                that changes with the seed) and a small table — its shadow
 *                and the darkening under it are the shadow / AO check
 *   front        every palette colour as a tile: environment row, building
 *                row + four neutrals (white, light, 18 % grey, dark), car row
 *
 * The board bakes its own AO (tight 0.7 m reach, tessellated slab): the
 * default bake in assemble.ts scales its reach with the 7 m board and would
 * smear every contact shadow across it. Assets that bake themselves are left
 * untouched by the assembler — this file is the example of that path.
 */

const SLAB_W = 7.0;
const SLAB_D = 3.6;
const TOP = 0.08; // slab top = the "floor" everything stands on

const NEUTRAL = paint([0.72, 0.72, 0.72], { gloss: 0.1 });
const BASE_DARK = paint([0.16, 0.16, 0.18], { gloss: 0.2 });

/** x of column `i` of the five-sample ramps. */
const rampX = (i: number): number => -1.4 + i * 0.75;

function axisArrow(m: SolidMesh, origin: [number, number, number], dir: [number, number, number], color: RGB): void {
  const p = paint(color, { gloss: 0.5 });
  const at = (t: number): [number, number, number] => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  cylinder(m, { from: origin, to: at(0.8), radius: 0.03, sides: 12 }, p);
  cone(m, { from: at(0.8), to: at(1.0), radius: 0.075, sides: 16 }, p);
}

function swatchRow(m: SolidMesh, z: number, paints: readonly Paint[]): void {
  paints.forEach((p, i) => {
    roundedBox(m, { size: [0.26, 0.05, 0.26], radius: 0.015, segments: 1, at: [-1.85 + 0.13 + i * 0.3, TOP + 0.025, z] }, p);
  });
}

function build(seed: number): SolidMesh {
  const m = new SolidMesh();

  // Slab. Tessellated so the per-vertex AO can draw contact pools under the
  // spheres instead of one gradient across two triangles. No underside: it
  // lies on the ground and would only double the triangle count.
  const slab = m.mark();
  roundedBox(m, { size: [SLAB_W, TOP, SLAB_D], radius: 0.03, segments: 1, at: [0, TOP / 2, 0], faces: { ny: null } }, NEUTRAL);
  m.tessellate(0.33, slab);

  // 1 m cube: the rounding is cut INTO the extents, so it measures exactly 1.
  roundedBox(m, { size: 1, radius: 0.025, segments: 2, at: [-2.7, TOP + 0.5, 0.9] }, paint(BUILDING.cream, { gloss: 0.3 }));

  // Axis gizmo.
  const o: [number, number, number] = [-3.2, TOP + 0.07, -1.5];
  sphere(m, { radius: 0.07, segments: 12, at: o }, paint([0.9, 0.9, 0.9], { gloss: 0.5 }));
  axisArrow(m, o, [1, 0, 0], [0.9, 0.16, 0.14]);
  axisArrow(m, o, [0, 1, 0], [0.2, 0.72, 0.2]);
  axisArrow(m, o, [0, 0, 1], [0.16, 0.36, 0.92]);

  // Gloss and metal ramps.
  const R = 0.28;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    sphere(m, { radius: R, segments: 24, at: [rampX(i), TOP + R, 1.05] }, paint(REEF_ROCKET.bodyTurquoise, { gloss: t }));
    sphere(m, { radius: R, segments: 24, at: [rampX(i), TOP + R, 0.3] }, paint(CAR_COMMON.metal, { gloss: 0.7, metal: t }));
  }

  // Emissive ramp: a lamp dome on a dark base.
  for (let i = 0; i < 5; i++) {
    const at: [number, number, number] = [rampX(i), TOP, -0.45];
    cylinder(m, { radius: 0.2, height: 0.08, sides: 20, bevel: 0.02, at: [at[0], TOP + 0.04, at[2]] }, BASE_DARK);
    sphere(
      m,
      { radius: 0.16, segments: 20, latitude: [0, 90], at: [at[0], TOP + 0.08, at[2]] },
      paint(BUILDING.cyanLight, { gloss: 0.6, emissive: i / 4 }),
    );
  }

  // Faceted rock — the seeded part. Colour is decided per FACE normal: cream
  // sunlit top planes over lavender flanks, as on the environment sheets.
  const r = rng(seed, 'calibration-rock');
  const rockBase = jitterColor(r, STONE.base, { hue: 10, lightness: 0.04, chroma: 0.15 });
  const rock = m.mark();
  icosphere(
    m,
    { radii: [r.around(0.6, 0.1), r.around(0.46, 0.08), r.around(0.52, 0.1)], subdivisions: 1 },
    paint(rockBase, { gloss: 0.05, smooth: 0 }),
  );
  const noiseSeed = r.int(0, 9999);
  m.displace((p) => (noise3(p.x * 2.6, p.y * 2.6, p.z * 2.6, noiseSeed) - 0.5) * 0.3, rock);
  m.rotate('y', r.range(0, 360), rock);
  m.translate([2.75, TOP + 0.3, 0.85], rock);
  // Flatten whatever dips below the slab top into the slab, so the rock sits
  // on the board instead of poking out underneath it.
  m.displace((p) => (p.y < 0.03 ? [p.x, 0.03, p.z] : p), rock);
  m.recolor((_p, n) => {
    if (n.y > 0.6) return STONE.upperFace;
    if (n.y < -0.1) return STONE.shadow;
    return mix(rockBase, STONE.midSlate, n.y * 0.5 + 0.5);
  }, rock);

  // Table: a top on four legs. Its cast shadow and the occlusion under it
  // are easy to judge because the answer is obvious.
  const wood = paint(BUILDING.timber, { gloss: 0.25 });
  roundedBox(m, { size: [0.95, 0.07, 0.95], radius: 0.02, segments: 1, at: [2.75, TOP + 0.5, -0.55] }, wood);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(m, { size: [0.07, 0.47, 0.07], at: [2.75 + sx * 0.38, TOP + 0.235, -0.55 + sz * 0.38] }, wood);
    }
  }

  // Palette tiles, 17 per row.
  const flat = (c: RGB): Paint => paint(c, { gloss: 0.25 });
  const car = (c: RGB): Paint => paint(c, { gloss: 0.85 });
  swatchRow(m, -1.0, [
    ...Object.values(FOLIAGE).map(flat),
    ...Object.values(BARK).map(flat),
    ...Object.values(SUCCULENT).map(flat),
    ...Object.values(FLOWERS).map(flat),
    ...Object.values(STONE).map(flat),
  ]);
  swatchRow(m, -1.3, [
    ...Object.values(BUILDING).map(flat),
    // Neutrals for exposure / tone-curve checks; 0.46 sRGB is 18 % grey.
    flat([0.95, 0.95, 0.95]),
    flat([0.75, 0.75, 0.75]),
    flat([0.46, 0.46, 0.46]),
    flat([0.12, 0.12, 0.12]),
  ]);
  swatchRow(m, -1.6, [
    car(REEF_ROCKET.bodyTurquoise),
    car(REEF_ROCKET.cageCoral),
    car(REEF_ROCKET.trimCream),
    car(REEF_ROCKET.emissionCyan),
    car(NEON_WASP.bodyYellow),
    car(NEON_WASP.cageViolet),
    car(NEON_WASP.accentCyan),
    car(RIOT_RAM.bodyCobalt),
    car(RIOT_RAM.panelsOrange),
    car(RIOT_RAM.springsLime),
    car(RIOT_RAM.stripeWhite),
    car(COMET_FOX.bodyVermilion),
    car(COMET_FOX.stripeWhite),
    car(COMET_FOX.cageTeal),
    car(COMET_FOX.emissionBlue),
    paint(CAR_COMMON.rubber, { gloss: 0.1 }),
    paint(CAR_COMMON.metal, { gloss: 0.7, metal: 1 }),
  ]);

  bakeAO(m, { ground: true, maxDistance: 0.7, rays: 24 });
  return m;
}

/** One collider of each shape, so `?colliders=1` in the lab has something
 * to draw: the slab and the cube as boxes, the table as a cylinder, the rock
 * as a sphere. */
function colliders(): ColliderSpec[] {
  return [
    { shape: 'box', center: [0, TOP / 2, 0], half: [SLAB_W / 2, TOP / 2, SLAB_D / 2] },
    { shape: 'box', center: [-2.7, TOP + 0.5, 0.9], half: [0.5, 0.5, 0.5] },
    { shape: 'cylinder', base: [2.75, TOP, -0.55], height: 0.54, radius: 0.62 },
    { shape: 'sphere', center: [2.75, TOP + 0.3, 0.85], radius: 0.55 },
  ];
}

const calibration: PropAsset = {
  kind: 'prop',
  id: 'calibration',
  name: 'Look calibration board',
  category: 'dressing',
  size: { x: SLAB_W, y: 1.15, z: SLAB_D },
  variants: 3,
  build,
  colliders,
  // A test fixture, far denser than real track dressing.
  triBudget: 20000,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default calibration;
