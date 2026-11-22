import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, blob, jitterColor, mix, paint, revolve, rng } from '../../gfx/solid';
import type { Paint, RGB, Rng, Vec2 } from '../../gfx/solid';
import { FLOWERS, FOLIAGE, STONE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { IRON, PINK, SMALL_SWAY, SOIL, WOOD, blade, bud, flower, leaf, mound, seatOn, stem } from './dressing-village-parts';

/**
 * Flower planter. Two tubs, both straight from the vision:
 *  - 'stone'  the smooth round lavender pot by the cottage door: a slightly
 *             bulged body under a broad soft rim band, cream on its top plane;
 *  - 'timber' the half-barrel in front of the market stall (orange staves,
 *             slate hoops).
 *
 * Three plantings, chosen by the seed, so a row of planters is not one model
 * repeated: a leafy mound studded with blooms (seed 0, the hero) · a clump of
 * tall flowers among blades · the vision's clipped topiary ball. Seeds also
 * change the flower colours, the tub's tone and proportions, and — timber —
 * whether it has one hoop or two. The planting sways a little (see
 * SMALL_SWAY); the tub is rigid.
 */

const POT_H = 0.5;
const TUB_H = 0.46;
const R_STONE = 0.33;
const R_TIMBER = 0.34;
// Twelve round-shaded segments: enough for a 0.7 m tub, and what leaves
// the budget for a full planting.
const SEGMENTS = 12;

interface Tub {
  /** Radius of the planting bed (inside the rim). */
  inner: number;
  /** Outer radius at the rim. */
  outer: number;
  /** y of the rim top. */
  top: number;
}

function stoneTub(m: SolidMesh, r: number, h: number, base: RGB): Tub {
  // One smooth surface: the crease angle is wide enough that the rim's
  // bevels shade as soft rounding, not as hard rings.
  const BODY = paint(base, { gloss: 0.2, smooth: 65 });
  const BAND = paint(mix(base, STONE.upperFace, 0.22), { gloss: 0.2, smooth: 65 });
  const TOP = paint(mix(STONE.upperFace, base, 0.2), { gloss: 0.2, smooth: 65 });
  const SOILP = paint(SOIL, { gloss: 0.05 });
  const lip = 0.032;
  const inner = r - 0.075;
  const profile: Vec2[] = [
    [r * 0.8, -0.05],
    // Slight belly a third of the way up.
    [r * 0.9, h * 0.36],
    [r - lip, h - 0.13],
    [r, h - 0.1],
    [r, h - 0.03],
    [r - 0.03, h],
    [inner, h],
    // Soil dished toward the middle; the planting covers it.
    [0, h - 0.035],
  ];
  const paints: Paint[] = [BODY, BODY, BAND, BAND, TOP, TOP, SOILP];
  revolve(m, { profile, segments: SEGMENTS }, (band) => paints[band]);
  return { inner, outer: r, top: h };
}

function timberTub(m: SolidMesh, r: number, h: number, wood: RGB, hoop: RGB, hoops: 1 | 2): Tub {
  const STAVE: Paint[] = [paint(wood, { gloss: 0.3 }), paint(mix(wood, WOOD.dark, 0.2), { gloss: 0.3 })];
  const HOOP = paint(hoop, { gloss: 0.5, metal: 0.4 });
  // A barrel sawn through at the belly: widest at the rim.
  const R = (t: number): number => r * (0.82 + 0.18 * (1 - (1 - t) ** 2));
  const proud = 0.013;
  const y = (t: number): number => t * h;
  // As on the barrel, a hoop costs two bands: the stave below it runs
  // straight out into its face, and only the upper shoulder is a step.
  const profile: Vec2[] = [[R(0) - 0.01, -0.05]];
  const kinds: ('stave' | 'hoop')[] = [];
  const hoopAt = (t0: number, t1: number): void => {
    profile.push([R(t0) + proud, y(t0)], [R(t1) + proud, y(t1)], [R(t1) + 0.001, y(t1) + 0.008]);
    kinds.push('stave', 'hoop', 'hoop');
  };
  if (hoops === 2) {
    hoopAt(0.17, 0.29);
    hoopAt(0.68, 0.8);
  } else {
    hoopAt(0.5, 0.66);
  }
  profile.push([r, h]);
  kinds.push('stave');
  // Rim and bed in one dished band of end grain: the planting overflows it.
  profile.push([0, h - 0.025]);
  revolve(m, { profile, segments: SEGMENTS }, (band, seg) => {
    if (band >= kinds.length) return STAVE[1];
    return kinds[band] === 'hoop' ? HOOP : STAVE[seg % 2];
  });
  return { inner: r - 0.045, outer: r, top: h };
}

type Planting = 'blooms' | 'clump' | 'ball';

interface PlantOptions {
  tub: Tub;
  hero: boolean;
  seed: number;
  r: Rng;
  green: RGB;
  colors: readonly RGB[];
  /** The mound overflows the rim (timber) or sits inside it (stone). */
  overflow: boolean;
}

const eyeFor = (petal: RGB): RGB => (petal === FLOWERS.center ? FLOWERS.petal : FLOWERS.center);

/** Leafy dome with blooms seated on it, leaves lying over the rim. */
function plantBlooms(m: SolidMesh, o: PlantOptions): void {
  const { tub, hero, r } = o;
  const mr = o.overflow ? tub.outer - 0.02 : tub.inner + 0.022;
  const mh = hero ? 0.25 : r.range(0.21, 0.28);
  const base = new Vector3(0, tub.top - 0.012, 0);
  const dome = m.mark();
  mound(m, { at: base, radius: mr, height: mh, rings: [6, 9, 11], seed: o.seed * 13 + 5, jitter: 0.35, color: o.green });
  const turn = hero ? 20 : r.range(0, 360);
  // The timber tub's hoops cost it one bloom.
  const count = o.overflow ? 5 : 6;
  // All seats are found before the first bloom is added: the ray must hit
  // the dome only.
  const seats: { at: Vector3; normal: Vector3 }[] = [];
  for (let i = 0; i < count; i++) {
    // One bloom on the crown, the rest in a ring around the shoulder.
    const crown = i === 0;
    const a = ((turn + ((i - 1) * 360) / (count - 1) + (hero ? 0 : r.range(-10, 10))) * Math.PI) / 180;
    const tilt = crown ? 0.12 : (hero ? 0.8 : r.range(0.72, 0.88)) + (i % 2) * 0.1;
    const dir = new Vector3(Math.cos(a) * Math.sin(tilt) * mr, Math.cos(tilt) * mh, Math.sin(a) * Math.sin(tilt) * mr);
    const seat = seatOn(m, dome, base.add(new Vector3(0, 0.02, 0)), dir);
    if (seat) seats.push(seat);
  }
  seats.forEach((seat, i) => {
    const petal = o.colors[i % o.colors.length];
    const radius = (i === 0 ? 0.092 : 0.084) * (hero ? 1 : r.range(0.92, 1.08));
    flower(m, {
      // Lying on its facet, lifted so the petals clear it and only the back
      // cone is sunk in the leaves; turned a little up toward the camera.
      at: seat.at.add(seat.normal.scale(radius * 0.16)),
      facing: seat.normal.add(new Vector3(0, 0.25, 0)),
      radius,
      petal,
      center: eyeFor(petal),
      spin: i * 37,
    });
  });
  // Leaves lying over the rim between the blooms.
  for (let i = 0; i < 3; i++) {
    const a = ((turn + 36 + i * 120 + (hero ? 0 : r.range(-12, 12))) * Math.PI) / 180;
    const root = base.add(new Vector3(Math.cos(a) * mr * 0.7, 0.05, Math.sin(a) * mr * 0.7));
    const reach = tub.outer + (i % 2 ? 0.07 : 0.045);
    const tip = new Vector3(Math.cos(a) * reach, tub.top - (i % 2 ? 0.06 : 0.025), Math.sin(a) * reach);
    leaf(m, root, tip, 0.18, i % 2 ? mix(o.green, FOLIAGE.jade, 0.25) : mix(o.green, FOLIAGE.highlight, 0.2));
  }
}

/** Tall flowers on stems among broad blades, over a low cushion of leaf. */
function plantClump(m: SolidMesh, o: PlantOptions): void {
  const { tub, hero, r } = o;
  const mr = o.overflow ? tub.outer - 0.03 : tub.inner + 0.015;
  const base = new Vector3(0, tub.top - 0.012, 0);
  mound(m, { at: base, radius: mr, height: 0.11, rings: [5, 8], seed: o.seed * 11 + 2, jitter: 0.4, color: mix(o.green, FOLIAGE.jade, 0.2) });
  const turn = hero ? 0 : r.range(0, 360);
  const stems = 4;
  for (let i = 0; i < stems; i++) {
    const a = ((turn + i * (360 / stems) + r.range(-18, 18)) * Math.PI) / 180;
    // The first stands tall in the middle, the others lean out around it.
    const lean = i === 0 ? 0.03 : r.range(0.13, 0.2);
    const rise = i === 0 ? 0.4 : r.range(0.24, 0.33);
    const foot = base.add(new Vector3(Math.cos(a) * lean * 0.3, 0.05, Math.sin(a) * lean * 0.3));
    const head = base.add(new Vector3(Math.cos(a) * lean, rise, Math.sin(a) * lean));
    stem(m, foot, head, 0.013);
    const petal = o.colors[i % o.colors.length];
    flower(m, { at: head, facing: new Vector3(Math.cos(a) * lean * 2.4, 1, Math.sin(a) * lean * 2.4), radius: (i === 0 ? 0.095 : 0.085) * r.range(0.94, 1.06), petal, center: eyeFor(petal), spin: i * 31 });
  }
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const a = ((turn + 40 + i * (360 / blades) + r.range(-12, 12)) * Math.PI) / 180;
    const out = mr * r.range(0.95, 1.2);
    const root = base.add(new Vector3(Math.cos(a) * mr * 0.25, 0.03, Math.sin(a) * mr * 0.25));
    const tip = base.add(new Vector3(Math.cos(a) * out, r.range(0.17, 0.3), Math.sin(a) * out));
    blade(m, { root, tip, width: 0.11, color: i % 2 ? o.green : mix(o.green, FOLIAGE.highlight, 0.25) });
  }
}

/** The vision's clipped bush: one big faceted ball, wider than the bed. */
function plantBall(m: SolidMesh, o: PlantOptions): void {
  const { tub, r } = o;
  const rb = tub.inner + (o.overflow ? 0.05 : 0.07);
  const ry = rb * r.range(0.84, 0.94);
  const sink = 0.5;
  const cy = tub.top - 0.015 + ry * sink;
  const s = m.mark();
  blob(m, { radii: [rb, ry, rb], points: 30, seed: o.seed * 17 + 9, jitter: 0.22, flatBelow: -ry * sink, at: [0, cy, 0] }, paint(o.green, { gloss: 0.2, smooth: 0 }));
  // The flat cut lies on the soil: nobody sees it.
  m.repaint((c, n) => (n.y < -0.9 && c.y < tub.top ? null : undefined), s);
  m.recolor((_p, n, c) => (n.y > 0.7 ? mix(c, FOLIAGE.highlight, 0.45) : n.y < 0.1 ? mix(c, FOLIAGE.jade, 0.35) : c), s);
  // A few small blooms scattered over it.
  const turn = r.range(0, 360);
  for (let i = 0; i < 6; i++) {
    const a = ((turn + i * 137.5) * Math.PI) / 180;
    const tilt = 0.35 + (i % 3) * 0.33;
    const dir = new Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const petal = o.colors[i % o.colors.length];
    bud(m, new Vector3(dir.x * rb * 0.93, cy + dir.y * ry * 0.93, dir.z * rb * 0.93), dir, 0.05, petal, eyeFor(petal));
  }
}

function build(seed: number, scheme?: string): SolidMesh {
  const timber = scheme === 'timber';
  const r = rng(seed, 'd11-flower-planter', timber ? 'timber' : 'stone');
  const hero = seed === 0;
  const m = new SolidMesh();
  const kinds: Planting[] = ['blooms', 'clump', 'ball', 'blooms'];
  const kind = kinds[hero ? 0 : seed % 4];
  // The ball stands tall on its own: it gets the lower tubs.
  const tallest = kind === 'ball' ? 1.0 : 1.14;
  let tub: Tub;
  if (timber) {
    const h = hero ? TUB_H : TUB_H * r.range(0.84, tallest);
    const wood = hero ? WOOD.barrel : jitterColor(r, r.pick([WOOD.barrel, WOOD.plank, WOOD.rail]), { hue: 5, lightness: 0.04 });
    const hoop = mix(IRON.hoop, IRON.cap, 0.6);
    // Low tubs get a single broad hoop round the middle.
    tub = timberTub(m, R_TIMBER * (hero ? 1 : r.range(0.9, 1.05)), h, wood, hero ? hoop : jitterColor(r, hoop, { hue: 10, lightness: 0.04 }), hero || seed % 2 === 0 ? 2 : 1);
  } else {
    const h = hero ? POT_H : POT_H * r.range(0.84, tallest);
    const base = hero ? STONE.base : jitterColor(r, r.pick([STONE.base, STONE.midSlate, mix(STONE.base, STONE.upperFace, 0.25)]), { hue: 8, lightness: 0.04 });
    tub = stoneTub(m, R_STONE * (hero ? 1 : r.range(0.9, 1.08)), h, base);
  }

  const plant = m.mark();
  const palettes: RGB[][] = [[FLOWERS.petal], [FLOWERS.center, FLOWERS.center, FLOWERS.petal], [FLOWERS.petal, PINK], [PINK, FLOWERS.petal, FLOWERS.center]];
  const o: PlantOptions = {
    tub,
    hero,
    seed,
    r,
    green: mix(FOLIAGE.lime, FLOWERS.stem, hero ? 0.25 : r.range(0.1, 0.38)),
    // The stall's barrels carry pale pink blooms, the cottage pots coral.
    colors: hero ? (timber ? [PINK, FLOWERS.petal] : palettes[0]) : palettes[(seed + (timber ? 1 : 0)) % 4],
    overflow: timber,
  };
  if (kind === 'blooms') plantBlooms(m, o);
  else if (kind === 'clump') plantClump(m, o);
  else plantBall(m, o);
  m.setWind((p) => Math.min(1, Math.max(0, (p.y - tub.top) / 0.4)) * SMALL_SWAY, plant);
  if (!hero) m.rotate('y', r.range(0, 360));
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'cylinder', base: [0, 0, 0], height: POT_H, radius: R_TIMBER }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd11-flower-planter',
  name: 'Flower planter',
  category: 'dressing',
  // The hero stone pot with its mound of blooms; y includes the 5 cm skirt.
  size: { x: 0.74, y: 0.82, z: 0.69 },
  variants: 4,
  schemes: ['stone', 'timber'],
  build,
  colliders,
  wind: true,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-elevated-camera.png' },
};

export default asset;
