import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, jitterColor, mix, paint, revolve, rng } from '../../gfx/solid';
import type { Paint, RGB, Vec2 } from '../../gfx/solid';
import { FLOWERS, FOLIAGE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { FRUIT, IRON, PINK, WOOD, bud, flower, fruit, leaf, mound, seatOn } from './dressing-village-parts';

/**
 * Timber barrel of the vision's market stall: round bulged orange staves
 * (every other stave a shade apart, so the planks read without a single
 * seam line) under two thin dark hoops.
 *
 * Every barrel in the vision is a PLANTER — a leafy mound that hides the rim,
 * studded with coral blooms — so that is the hero. Seeds: 0 planted (coral)
 * · 1 closed, recessed lid · 2 planted (yellow or pink) · 3 heaped with
 * fruit; beyond that the kinds repeat with other proportions and tones.
 * Nothing sways: the planting is a stubby rigid clump, so the asset carries
 * no wind.
 */

const HEIGHT = 0.86;
const R_BELLY = 0.37;
const R_END = 0.3;
const SEGMENTS = 14;
const MOUND = 0.19;

/** Outer radius of the stave surface at height t = 0..1 (parabolic belly). */
const staveR = (t: number, belly: number, end: number): number => end + (belly - end) * (1 - (2 * t - 1) ** 2);

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd09-barrel');
  const hero = seed === 0;
  const kind = (['plant', 'lid', 'plant', 'fruit'] as const)[hero ? 0 : seed % 4];
  const h = hero ? HEIGHT : HEIGHT * r.range(0.9, 1.05);
  const belly = hero ? R_BELLY : R_BELLY * r.range(0.93, 1.04);
  const end = R_END * (belly / R_BELLY);
  const wood: RGB = hero ? WOOD.barrel : jitterColor(r, r.pick([WOOD.barrel, WOOD.barrel, WOOD.plank, WOOD.rail]), { hue: 5, lightness: 0.04 });
  const hoopBase = mix(IRON.hoop, IRON.cap, 0.6);
  const hoop: RGB = hero ? hoopBase : jitterColor(r, hoopBase, { hue: 10, lightness: 0.04 });
  const STAVE: Paint[] = [paint(wood, { gloss: 0.3 }), paint(mix(wood, WOOD.dark, 0.2), { gloss: 0.3 })];
  const HOOP = paint(hoop, { gloss: 0.5, metal: 0.4 });
  const LID = paint(mix(wood, WOOD.pale, 0.45), { gloss: 0.2 });
  const m = new SolidMesh();

  const proud = 0.013;
  const R = (t: number): number => staveR(t, belly, end);
  const y = (t: number): number => t * h;
  // Thin hoops (5.5 cm), each proud of the staves. A hoop costs two bands,
  // not three: the stave band on its far side from the belly runs straight
  // into the hoop's face, so only the shoulder toward the belly is a step.
  const w = 0.055 / h;
  const lo = 0.14;
  const hi = 0.86;
  const profile: Vec2[] = [
    [R(0) - 0.012, -0.05],
    [R(lo) + proud, y(lo)],
    [R(lo + w) + proud, y(lo + w)],
    [R(lo + w) + 0.001, y(lo + w) + 0.008],
    [R(0.5), y(0.5)],
    [R(hi - w) + 0.001, y(hi - w) - 0.008],
    [R(hi - w) + proud, y(hi - w)],
    [R(hi) + proud, y(hi)],
    [R(1), h],
  ];
  const isHoop = [false, true, true, false, false, true, true, false];
  const rim = R(1) - 0.042;
  const lidY = h - 0.045;
  // What closes the mouth, band by band after the staves and hoops.
  const fruitColors: RGB[] = kind !== 'fruit' ? [] : r.chance(0.5) ? [FRUIT.apple, FRUIT.apple, FRUIT.greenApple] : [FRUIT.orange, FRUIT.orange, FRUIT.lemon];
  const mouth: Paint[] = [];
  if (kind === 'plant') {
    // The planting overflows the rim and hides it: one dished band.
    profile.push([0, h - 0.03]);
    mouth.push(STAVE[1]);
  } else if (kind === 'lid') {
    // Rim and the wall of the recess are end grain, a shade darker.
    profile.push([rim, h], [rim, lidY], [0, lidY]);
    mouth.push(STAVE[1], STAVE[1], LID);
  } else {
    // Rim, then a dark bed just under it for the fruit to lie on, so no gap
    // between them shows the inside of the barrel.
    profile.push([rim, h], [0, h - 0.02]);
    mouth.push(STAVE[1], paint(mix(fruitColors[0], [0.2, 0.08, 0.08], 0.65), { gloss: 0.1 }));
  }
  revolve(m, { profile, segments: SEGMENTS }, (band, seg) => {
    if (band < isHoop.length) return isHoop[band] ? HOOP : STAVE[seg % 2];
    return mouth[band - isHoop.length];
  });

  if (kind === 'plant') {
    // Leafy mound filling the mouth, leaves spilling over the rim.
    const GREEN = mix(FOLIAGE.lime, FLOWERS.stem, hero ? 0.25 : r.range(0.15, 0.35));
    const mr = R(1) + 0.006;
    const mh = hero ? MOUND : MOUND * r.range(0.85, 1.1);
    const base = new Vector3(0, h - 0.015, 0);
    const dome = m.mark();
    mound(m, { at: base, radius: mr, height: mh, rings: [6, 9], seed: seed * 13 + 3, jitter: 0.4, color: GREEN });
    const palettes: RGB[][] = [[FLOWERS.petal], [FLOWERS.center, FLOWERS.center, FLOWERS.petal], [PINK, FLOWERS.petal]];
    const colors = hero ? palettes[0] : palettes[r.int(1, 2)];
    const turn = hero ? 250 : r.range(0, 360);
    // Where the dome's own facets put a bloom at azimuth a, tilted from the
    // vertical (found before any bloom is added: the ray must hit leaf only).
    const origin = base.add(new Vector3(0, 0.02, 0));
    const seat = (aDeg: number, tilt: number): { at: Vector3; normal: Vector3 } => {
      const a = (aDeg * Math.PI) / 180;
      const dir = new Vector3(Math.cos(a) * Math.sin(tilt) * mr, Math.cos(tilt) * mh, Math.sin(a) * Math.sin(tilt) * mr);
      return seatOn(m, dome, origin, dir) ?? { at: origin.add(dir), normal: dir.normalizeToNew() };
    };
    // One bloom on the crown, three round the shoulder, a bud in one gap.
    const blooms = [seat(turn, 0.15), ...[0, 1, 2].map((i) => seat(turn + 30 + i * 120 + (hero ? 0 : r.range(-12, 12)), (hero ? 0.82 : r.range(0.74, 0.9)) + (i % 2) * 0.08))];
    const buds = [seat(turn + 90, 1.0)];
    blooms.forEach((s, i) => {
      const petal = colors[i % colors.length];
      const radius = (i === 0 ? 0.092 : 0.086) * (hero ? 1 : r.range(0.92, 1.08));
      flower(m, { at: s.at.add(s.normal.scale(radius * 0.16)), facing: s.normal.add(new Vector3(0, 0.25, 0)), radius, petal, center: petal === FLOWERS.center ? FLOWERS.petal : FLOWERS.center, spin: i * 37 });
    });
    buds.forEach((s, i) => {
      const petal = colors[(i + 1) % colors.length];
      bud(m, s.at.add(s.normal.scale(0.012)), s.normal, 0.05, petal, petal === FLOWERS.center ? FLOWERS.petal : FLOWERS.center);
    });
    // Leaves hanging over the rim.
    for (let i = 0; i < 3; i++) {
      const a = ((turn - 20 + i * 120 + (hero ? 0 : r.range(-15, 15))) * Math.PI) / 180;
      const root = base.add(new Vector3(Math.cos(a) * mr * 0.75, 0.035, Math.sin(a) * mr * 0.75));
      const reach = R(1) + (i % 2 ? 0.11 : 0.085);
      const tip = new Vector3(Math.cos(a) * reach, h - (i % 2 ? 0.08 : 0.03), Math.sin(a) * reach);
      leaf(m, root, tip, 0.2, i % 2 ? mix(GREEN, FOLIAGE.jade, 0.25) : mix(GREEN, FOLIAGE.highlight, 0.2));
    }
  } else if (kind === 'fruit') {
    // Fruit heaped over the rim: a ring of six with two riding on top.
    const fr = 0.082;
    const turn = r.range(0, 360);
    const put = (x: number, yy: number, z: number): void => {
      fruit(m, [x, yy, z], { radius: fr * r.range(0.95, 1.05), color: jitterColor(r, r.weighted(fruitColors, [5, 5, 3]), { hue: 4, lightness: 0.03 }), yaw: r.range(0, 360), sides: 5, full: true });
    };
    for (let i = 0; i < 6; i++) {
      const a = ((turn + i * 60) * Math.PI) / 180;
      put(Math.cos(a) * (rim - fr * 0.8), h + fr * 0.05 + r.range(-0.008, 0.008), Math.sin(a) * (rim - fr * 0.8));
    }
    // Two riding in the hollow of the ring, close enough to close it.
    for (let i = 0; i < 2; i++) {
      const a = ((turn + 30 + i * 180) * Math.PI) / 180;
      put(Math.cos(a) * fr * 0.55, h + fr * (0.5 + i * 0.08), Math.sin(a) * fr * 0.55);
    }
  }
  if (!hero) m.rotate('y', r.range(0, 360));
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'cylinder', base: [0, 0, 0], height: HEIGHT, radius: R_BELLY }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd09-barrel',
  name: 'Timber barrel',
  category: 'dressing',
  // y: the 5 cm skirt below ground, the barrel, and the hero's planting.
  size: { x: R_BELLY * 2, y: HEIGHT + 0.05 + MOUND + 0.02, z: R_BELLY * 2 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
