import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, catmullRomPath, mixOklab, paint } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import { applyFit, farBlob, farStick } from './farKit';
import { alongPath, barkPaint, barkTones, bough, canopy, climb, fitSize, foliageTones, limb, pathClearance, rootFlare, shadeBark, shadeFoliage, sway, variant } from './nature';
import type { CanopyBlob, Fit, Variant } from './nature';

/**
 * T01 RALLY OAK — a broad umbrella canopy of faceted masses over a stout,
 * gently leaning trunk with a root flare (trees/design-sheet.png, left).
 *
 * Parts list, measured off the sheet and laid into the brief's box (4.8 wide
 * × 5.5 tall × 4.5 deep; the drawing is a third squatter than the box, so the
 * build leans on the size tolerance: 3 % wider and, with the buried roots
 * counted, exactly the brief's height):
 *  - trunk: 0.42 m radius at the waist, fluted, leaning to the right in a
 *    shallow S to a fork at 1.45 m;
 *  - root flare: five buttress toes reaching 1.1 m from the centre;
 *  - a Y of three structural limbs. Left and right leave the trunk under the
 *    fork and sweep out and up in one arc each, a good meter of them in
 *    clear air under the foliage; the third is the trunk's continuation
 *    into the crown. Thinner boughs fork off them to the other masses —
 *    never level (a level branch is a beam), and none for a mass that hangs
 *    low between two carried ones;
 *  - canopy: the trunk leans right and the canopy rides further right still.
 *    Six masses in a ring with flat undersides at 2.4–2.9 m, overlapping by
 *    a third, and two crown masses staggered in height over the middle (a
 *    bumpy skyline, not one dome): 5 m wide over 2.9 m tall — the umbrella.
 * Front of the sheet = looking toward +z (the lab's yaw 0).
 *
 * Variants are the same tree re-grown: ring masses moved, resized and one of
 * the four smaller ones possibly missing, the second crown mass optional,
 * fork height, lean and girth drawn again — then the whole tree turned and
 * maybe mirrored, so no two seeds show the same side. Every draw must pass
 * the umbrella test (`umbrella`) or it is drawn again.
 */

const ID = 't01-rally-oak';
const SIZE = { x: 4.8, y: 5.5, z: 4.5 };
// What `fitSize` aims for: its height is above ground, the roots' skirt
// (0.1 m) comes on top of it in the lab's measurement.
const FIT = { x: 4.95, y: 5.4, z: 4.6 };
const SKIRT = 0.1;

interface Mass {
  at: [number, number, number];
  radii: [number, number, number];
  facets: number;
  /** Carried by a structural limb from the fork (else by a bough, or by its
   * neighbours). */
  main?: boolean;
}

// The hero's canopy, sheet front view (x right, z away from the viewer,
// origin = the foot of the trunk).
const CROWN: Mass[] = [
  { at: [0.55, 4.35, 0.05], radii: [1.55, 0.98, 1.4], facets: 40 }, // the top, right of the foot
  { at: [-0.6, 4.2, 0.65], radii: [1.15, 0.85, 1.1], facets: 26 }, // its lower neighbour behind on the left
];
const RING: Mass[] = [
  { at: [-0.95, 3.1, -0.35], radii: [0.95, 0.72, 1.0], facets: 28, main: true }, // left
  { at: [1.45, 3.35, -0.95], radii: [1.3, 0.8, 1.15], facets: 36, main: true }, // right, toward the viewer
  { at: [2.0, 3.55, 0.6], radii: [1.0, 0.78, 1.0], facets: 26 }, // right, behind
  { at: [2.35, 2.95, -0.25], radii: [0.75, 0.62, 0.8], facets: 22 }, // far right, low
  { at: [0.0, 3.3, 1.45], radii: [1.15, 0.78, 0.95], facets: 26 }, // back
  { at: [-0.2, 3.0, -1.3], radii: [0.9, 0.66, 0.85], facets: 24 }, // front left, low
];
// Underside of a mass: `canopy` cuts it flat this far below the centre.
const FLAT = 0.82;

interface Layout {
  crown: Mass[];
  ring: Mass[];
  /** Fork point of the trunk. */
  fork: Vector3;
  /** Trunk radius at the waist. */
  girth: number;
  toes: number;
  /** The finished tree is mirrored in x (first), then turned about y. */
  mirror: boolean;
  turn: number;
}

/** A broad umbrella, or a totem / a broccoli? Plan extent against canopy
 * height, every sixth of the horizon covered by a mass, and the crown over
 * the middle of the ring. */
function umbrella(crown: readonly Mass[], ring: readonly Mass[]): boolean {
  const all = [...crown, ...ring];
  const lo = Math.min(...all.map((b) => b.at[1] - b.radii[1] * FLAT));
  const hi = Math.max(...all.map((b) => b.at[1] + b.radii[1]));
  for (const ax of [0, 2]) {
    const span = Math.max(...all.map((b) => b.at[ax] + b.radii[ax])) - Math.min(...all.map((b) => b.at[ax] - b.radii[ax]));
    if (span < (hi - lo) * 1.5) return false;
  }
  const cx = ring.reduce((s, b) => s + b.at[0], 0) / ring.length;
  const cz = ring.reduce((s, b) => s + b.at[2], 0) / ring.length;
  if (Math.hypot(crown[0].at[0] - cx, crown[0].at[2] - cz) > 0.55) return false;
  for (let k = 0; k < 6; k++) {
    const a = (k * 60 + 15) * (Math.PI / 180);
    const px = cx + Math.sin(a) * 1.15;
    const pz = cz + Math.cos(a) * 1.15;
    if (!ring.some((b) => ((px - b.at[0]) / b.radii[0]) ** 2 + ((pz - b.at[2]) / b.radii[2]) ** 2 < 1)) return false;
  }
  return true;
}

function layout(v: Variant): Layout {
  const vt = v.fork('trunk');
  const leanTo = vt.num(75, 30) * (Math.PI / 180);
  const leanBy = vt.num(0.4, 0.2);
  const trunk = {
    fork: new Vector3(Math.sin(leanTo) * leanBy, vt.num(1.45, 0.2), Math.cos(leanTo) * leanBy),
    girth: vt.num(0.42, 0.05),
    // Never six: a sixth toe is 34 triangles the canopy needs.
    toes: vt.int(5, 4, 5),
  };
  const pose = v.fork('pose');
  const mirror = pose.chance(false, 0.5);
  const turn = pose.range(0, 0, 360);
  if (v.hero) return { crown: CROWN, ring: RING, ...trunk, mirror, turn };

  // Re-grow the canopy until it is an umbrella; the hero's own is the
  // fallback (it never comes to that in the first few hundred seeds).
  for (let attempt = 0; attempt < 24; attempt++) {
    const vc = v.fork(`canopy${attempt}`);
    const extras = RING.filter((b) => !b.main);
    const kept = vc.r.chance(0.5) ? extras : vc.r.shuffle(extras).slice(0, 3);
    // One size draw for the whole canopy and a small one per mass: a crown
    // grown while the ring shrank is the totem.
    const grow = (b: Mass, own: number): Mass => {
      const s = 1 + (vc.r.next() * 2 - 1) * own;
      return { ...b, radii: [b.radii[0] * s, b.radii[1] * s * vc.r.range(0.92, 1.06), b.radii[2] * s] };
    };
    const spread = vc.r.range(0.92, 1.08);
    const cx = 0.75;
    const cz = -0.1;
    const ring = [...RING.filter((b) => b.main), ...kept].map((b) => {
      const g = grow(b, 0.12);
      return {
        ...g,
        at: [cx + (b.at[0] - cx) * spread + vc.r.range(-0.22, 0.22), b.at[1] + vc.r.range(-0.2, 0.2), cz + (b.at[2] - cz) * spread + vc.r.range(-0.22, 0.22)],
      } as Mass;
    });
    const crown = (vc.r.chance(0.7) ? CROWN : CROWN.slice(0, 1)).map((b, i) => {
      const g = grow(b, 0.08);
      const drift = i === 0 ? 0.25 : 0.35;
      return { ...g, at: [b.at[0] + vc.r.range(-drift, drift), b.at[1] + vc.r.range(-0.18, 0.12), b.at[2] + vc.r.range(-drift, drift)] } as Mass;
    });
    // A crown mass on its own stands on the ring like a ball on a plate:
    // without its neighbour it is lower, flatter and broader.
    if (crown.length === 1) {
      const c = crown[0];
      crown[0] = { ...c, at: [c.at[0], c.at[1] - 0.16, c.at[2]], radii: [c.radii[0] * 1.1, c.radii[1] * 0.86, c.radii[2] * 1.1] };
    }
    if (umbrella(crown, ring)) return { crown, ring, ...trunk, mirror, turn };
  }
  return { crown: CROWN, ring: RING, ...trunk, mirror, turn };
}

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  layout: Layout;
}

function construct(seed: number): Built {
  const v = variant(seed, ID);
  const L = layout(v);
  const bark = barkTones(v);
  const leaves = foliageTones(v);
  const WOOD = barkPaint(bark, { seed });
  const m = new SolidMesh();
  const g = L.girth;
  // A limb ends inside the mass it carries, a little under its centre: the
  // bough comes in through the flat underside well away from the edge.
  const seat = (b: Mass): Vector3 => new Vector3(b.at[0], b.at[1] - b.radii[1] * 0.3, b.at[2]);

  // Trunk: from under the ground, bowing a little AGAINST the lean before it
  // swings over to the fork (the sheet's S-curve), then on into the crown as
  // the central limb.
  const crownSeat = seat(L.crown[0]);
  const trunk = [new Vector3(0, -SKIRT, 0), new Vector3(-L.fork.x * 0.3, L.fork.y * 0.45, -L.fork.z * 0.3), L.fork];
  const central = [L.fork, Vector3.Lerp(L.fork, crownSeat, 0.5), crownSeat];
  limb(
    m,
    {
      path: [...trunk, central[1], central[2]],
      radius: [g * 1.35, g * 1.0, g * 1.0, g * 0.66, g * 0.34],
      sides: 6,
      curve: 2,
      levelBase: true,
      capBase: true,
      capTip: false,
      seed: seed * 7 + 1,
    },
    WOOD,
  );
  rootFlare(m, { radius: g, toes: L.toes, skirt: SKIRT, seed: seed * 7 + 2, startDeg: v.range(20, 0, 360) }, WOOD);

  // Structural limbs: each starts ON the trunk's axis under the fork, at
  // half the trunk's girth (so no corner of it breaks the trunk's surface
  // before the limb itself does), leaves along the trunk leaning toward its
  // mass, and arrives heading up and out.
  const axis = L.fork.subtract(trunk[1]).normalize();
  const carriers: Vector3[][] = [catmullRomPath(central, 3)];
  const carried: Mass[] = [L.crown[0]];
  L.ring.forEach((b, i) => {
    if (!b.main) return;
    const end = seat(b);
    const out = new Vector3(end.x - L.fork.x, 0, end.z - L.fork.z).normalize();
    const path = bough(L.fork.subtract(axis.scale(0.42)), end, { leave: axis.scale(0.8).add(out.scale(0.6)), arrive: 46, segments: 5 });
    limb(m, { path, radius: [g * 0.52, g * 0.62, g * 0.58, g * 0.5, g * 0.4, g * 0.28], sides: 6, capTip: false, seed: seed * 7 + 10 + i }, WOOD);
    carriers.push(path);
    carried.push(b);
  });

  // Boughs for the other masses, off whichever limb reaches the mass at a
  // climb of 30° or more without doubling back or crossing the trunk. High
  // on a limb first; a mass that hangs between carried neighbours gets none
  // rather than one from down at the fork.
  const trunkLine = catmullRomPath(trunk, 3);
  const overlaps = (a: Mass, b: Mass): boolean => Math.hypot(a.at[0] - b.at[0], a.at[2] - b.at[2]) < (a.radii[0] + b.radii[0]) * 0.72 && Math.abs(a.at[1] - b.at[1]) < a.radii[1] + b.radii[1];
  const branch = (b: Mass, i: number): void => {
    const end = seat(b);
    const pick = (stations: readonly number[]): Vector3[] | null => {
      let best: Vector3[] | null = null;
      let bestLength = Infinity;
      for (const carrier of carriers) {
        for (const at of stations) {
          const { point, dir } = alongPath(carrier, at);
          const chord = end.subtract(point);
          const length = chord.length();
          if (length < 0.4 || climb(point, end) < 0.6) continue;
          const toward = chord.scale(1 / length);
          if (Vector3.Dot(toward, dir) < 0.2) continue;
          const path = bough(alongPath(carrier, at - 0.07).point, end, { leave: dir.scale(0.6).add(toward.scale(0.4)), arrive: 50, segments: 4, bow: 0.26 });
          if (pathClearance(path, trunkLine, 0.3) < g * 1.1) continue;
          if (length < bestLength) {
            bestLength = length;
            best = path;
          }
        }
      }
      return best;
    };
    const path = pick([0.6, 0.45]) ?? (carried.some((o) => overlaps(o, b)) ? null : pick([0.3, 0.14]));
    if (!path) return;
    limb(m, { path, radius: [g * 0.2, g * 0.3, g * 0.27, g * 0.22, g * 0.16], sides: 5, capTip: false, seed: seed * 7 + 20 + i }, WOOD);
    carried.push(b);
  };
  L.crown.slice(1).forEach((b, i) => branch(b, i));
  L.ring.forEach((b, i) => {
    if (!b.main) branch(b, 4 + i);
  });

  const blobs: CanopyBlob[] = [...L.crown, ...L.ring].map((b, i) => ({
    ...b,
    // The hero spends the budget to the last fifty triangles; a re-grown
    // canopy can cost more (more of it showing), so it gets a little less.
    facets: v.hero ? b.facets : Math.round(b.facets * 0.94),
    flat: FLAT,
    yaw: v.hero ? i * 47 : v.r.range(0, 360),
    // Tip each mass a little: a row of dead-level tops reads as stacked boxes.
    tilt: v.hero ? [8, -10, -12, 10, 14, -9, 12, -10][i % 8] : v.r.range(-13, 13),
  }));
  canopy(m, { blobs, seed }, leaves);

  if (L.mirror) m.mirror('x');
  if (L.turn) m.rotate('y', L.turn);
  const fit = fitSize(m, v.size(FIT, 0.1, 0.04), { recenter: false });
  // Rigid up to the fork; the whole crown rides the wind.
  sway(m, { from: 1.0, power: 1.4 });
  const built = { mesh: m, fit, layout: L };
  layouts.set(seed, { fit, layout: L });
  return built;
}

/** The last fit + layout per seed (pure values): the far model of a seed is
 * built right after its near model in the world props, and re-running the
 * whole near construction for two numbers is a third of the far build. */
const layouts = new Map<number, Omit<Built, 'mesh'>>();
const layoutOf = (seed: number): Omit<Built, 'mesh'> => layouts.get(seed) ?? construct(seed);

/**
 * The far model (the diorama view draws only this): the same tree from the
 * same layout — trunk to the fork with its lean, the umbrella canopy as a
 * broad faceted lens for the ring of masses with the crown mass(es) on it
 * (each the box of the masses it stands for), flat underside at the ring's
 * own height, the bark and leaf tones of this seed,
 * then the near model's mirror, turn and fit. With 60+ triangles the trunk
 * kinks at the fork and runs on into the crown as the central limb and the
 * masses get four corners a ring; below that the trunk is one straight
 * leaning prism into the crown and the masses three.
 */
function constructFar(seed: number, target: number): SolidMesh {
  const { fit, layout: L } = layoutOf(seed);
  const v = variant(seed, ID);
  const bark = barkTones(v);
  const leaves = foliageTones(v);
  const m = new SolidMesh();
  const g = L.girth;
  const rich = target >= 60;
  const crownSeat = new Vector3(L.crown[0].at[0], L.crown[0].at[1] - L.crown[0].radii[1] * 0.3, L.crown[0].at[2]);
  const WOOD = paint(bark.base, { gloss: 0.1, smooth: 16 });
  const foot = new Vector3(0, -SKIRT, 0);
  if (rich) {
    farStick(m, { path: [foot, L.fork, Vector3.Lerp(L.fork, crownSeat, 0.7)], radius: [g * 1.35, g * 0.9, g * 0.45], sides: 5 }, WOOD);
  } else {
    farStick(m, { path: [foot, Vector3.Lerp(L.fork, crownSeat, 0.55)], radius: [g * 1.35, g * 0.62], sides: 5 }, WOOD);
  }
  shadeBark(m, bark, { seed });

  // Canopy: the ring of masses as ONE broad lumpy lens — the umbrella —
  // and the crown mass(es) riding on it, as on the sheet: a bumpy skyline
  // over a flat underside. (Two or three merged masses side by side are
  // slabs — boxes of masses next to each other are much wider than tall —
  // and read as stacked plates.)
  const fromCanopy = m.mark();
  const box = (list: readonly Mass[], across: number): { at: Vector3; radii: Vector3; bottom: number } => {
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const b of list) {
      lo.minimizeInPlaceFromFloats(b.at[0] - b.radii[0], b.at[1] - b.radii[1] * FLAT, b.at[2] - b.radii[2]);
      hi.maximizeInPlaceFromFloats(b.at[0] + b.radii[0], b.at[1] + b.radii[1], b.at[2] + b.radii[2]);
    }
    // The union of overlapping ellipsoids fills its box less than one
    // ellipsoid would: a little inside the box across.
    return { at: lo.add(hi).scale(0.5), radii: hi.subtract(lo).scale(0.5).multiplyByFloats(across, 1, across), bottom: lo.y };
  };
  const crowns = rich && L.crown.length > 1 ? L.crown.map((b) => box([b], 1)) : [box(L.crown, 0.95)];
  const crownSides = rich && crowns.length > 1 ? 3 : 4;
  const ringSides = Math.max(4, Math.floor((target - m.triangleCount - crowns.length * crownSides * 4) / 4));
  const ring = box(L.ring, 0.92);
  const masses = [...crowns.map((q) => ({ ...q, sides: crownSides })), { ...ring, sides: ringSides }];
  masses.forEach((q, i) => {
    const flat = (q.at.y - q.bottom) / q.radii.y;
    farBlob(m, { at: q.at, radii: q.radii, sides: q.sides, rings: 2, flat, seed: seed * 13 + i, jitter: 0.7 }, paint(leaves.mid, { gloss: 0.2, smooth: 0 }));
  });
  const cb = m.bounds(fromCanopy);
  // A far facet is a whole mass's top: the sheet's yellow-lime is the sunlit
  // edge of a mass, so the far top tone sits a third of the way to the flank.
  shadeFoliage(m, { ...leaves, top: mixOklab(leaves.top, leaves.mid, 0.35) }, { from: fromCanopy, yLow: cb.min.y, yHigh: cb.max.y, seed });

  if (L.mirror) m.mirror('x');
  if (L.turn) m.rotate('y', L.turn);
  applyFit(m, fit);
  return m;
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, layout: L } = construct(seed);
  // One trunk cylinder up to the fork, centred between root and fork so the
  // lean stays inside it. The canopy does not block.
  const x = L.fork.x * 0.4 * (L.mirror ? -1 : 1);
  const z = L.fork.z * 0.4;
  const a = L.turn * (Math.PI / 180);
  return [
    {
      shape: 'cylinder',
      base: [(x * Math.cos(a) + z * Math.sin(a)) * fit.scale[0], 0, (-x * Math.sin(a) + z * Math.cos(a)) * fit.scale[2]],
      height: (L.fork.y + 0.4) * fit.scale[1],
      radius: L.girth * 1.25,
    },
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Rally Oak',
  category: 'tree',
  size: SIZE,
  variants: 5,
  build: (seed) => construct(seed).mesh,
  buildFar: (seed, _scheme, target) => constructFar(seed, target),
  colliders,
  wind: true,
  triBudget: 1400,
  reference: {
    sheet: 'design-documents/environment-design-pack/trees/design-sheet.png',
    brief: 'design-documents/environment-design-pack/trees/t01-rally-oak-brief.txt',
  },
};

export default asset;
