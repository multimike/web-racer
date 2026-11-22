import { SolidMesh, darken, jitterColor, mix, paint, rng } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { BUILDING, CAR_COMMON } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { TRACK, tire, tireShoulder } from './dressing-track-parts';
import { dirTri, farPrism, sampleColorOr } from './farKit';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * Corner barrier: a stack of chunky tires, one of them painted. Seeds vary
 * the count (3 or 4), how far the stack has slumped, which tire carries the
 * paint and its colour; one seed has its top tire thrown on askew.
 *
 * Triangle economy (400 for up to four tires at 14+ sides): a covered tire
 * is only its tread and two shoulders — sidewalls and bore are hidden — and
 * each tire is sunk OVERLAP into the one below, which puts every open rim
 * inside its neighbour's solid. That only holds while the sideways slump per
 * tire stays under OVERLAP and all tires share one turn angle (polygon
 * corners that do not line up cross each other in a saw-tooth). The top tire
 * is complete, with a dark floor in its bore.
 */

const R = 0.4;
const BORE = 0.21;
const WIDTH = 0.31;
const OVERLAP = 0.045;
/** The bottom tire stands this deep in the ground. */
const SUNK = 0.03;

interface Plan {
  count: number;
  askew: boolean;
  /** Painted tire, counted from the ground. */
  painted: number;
  segments: number;
}

function plan(seed: number): Plan {
  switch (seed % 4) {
    case 0: return { count: 4, askew: false, painted: 2, segments: 14 };
    case 1: return { count: 3, askew: false, painted: 0, segments: 18 };
    case 2: return { count: 3, askew: true, painted: 2, segments: 14 };
    default: return { count: 4, askew: false, painted: 3, segments: 14 };
  }
}

/** Askew top tire: tilt about x and z, degrees. */
const ASKEW: readonly [number, number] = [4.5, -3.5];

function build(seed: number): SolidMesh {
  const r = rng(seed, 'tire-stack');
  const hero = seed === 0;
  const P = plan(seed);
  const accent = [TRACK.white, BUILDING.coral, BUILDING.turquoise, BUILDING.mustard][seed % 4];
  const slump = hero ? 0.6 : r.range(0.7, 1.3);
  // The cars' rubber, a shade deeper: these have stood out in the weather.
  const base = darken(CAR_COMMON.rubber, 0.1);

  const m = new SolidMesh();
  const FLOOR = paint(darken(base, 0.5), { gloss: 0.05 });
  const turn = r.range(0, 360);
  const dir = r.range(0, Math.PI * 2);

  let x = 0;
  let z = 0;
  let y = WIDTH / 2 - SUNK;
  for (let i = 0; i < P.count; i++) {
    const isPainted = i === P.painted;
    const RUBBER: Paint = isPainted ? paint(accent, { gloss: 0.45 }) : paint(jitterColor(r, base, { lightness: 0.02, hue: 3 }), { gloss: 0.2 });
    const top = i === P.count - 1;
    const askew = top && P.askew;
    const underAskew = P.askew && i === P.count - 2;
    if (i > 0) {
      // Each tire sits a little off the one below, mostly in one direction.
      x += (Math.cos(dir) * 0.014 + r.range(-0.008, 0.008)) * slump;
      z += (Math.sin(dir) * 0.014 + r.range(-0.008, 0.008)) * slump;
      y += WIDTH - OVERLAP;
    }
    if (askew) {
      // Thrown on: a complete tire resting on one edge of the (complete)
      // top of the tire below, clear of it everywhere else.
      const lean = Math.hypot(ASKEW[0], ASKEW[1]) * (Math.PI / 180);
      const rim = R - tireShoulder(R, BORE, WIDTH);
      tire(
        m,
        { at: [x + 0.06, y + OVERLAP + rim * Math.sin(lean) - 0.006, z + 0.05], radius: R, bore: BORE, width: WIDTH, segments: P.segments, turn: turn + 40, tilt: ASKEW },
        RUBBER,
      );
      continue;
    }
    tire(
      m,
      {
        at: [x, y, z],
        radius: R * (hero ? 1 : r.range(0.99, 1.01)),
        bore: BORE,
        width: WIDTH,
        segments: P.segments,
        turn,
        bottom: false,
        top: top || underAskew,
        boreWall: top || underAskew,
        floor: top || underAskew ? FLOOR : undefined,
      },
      RUBBER,
    );
  }
  return m;
}

function stackHeight(P: Plan): number {
  return P.count * WIDTH - (P.count - 1) * OVERLAP - SUNK + (P.askew ? OVERLAP + 0.04 : 0);
}

function colliders(seed: number): ColliderSpec[] {
  return [{ shape: 'cylinder', base: [0, 0, 0], height: stackHeight(plan(seed)), radius: R + 0.02 }];
}

/**
 * The far model: the stack as one upright prism in bands — one band per run
 * of same-coloured tyres, each in the colour read off those tyres of this
 * very stack (the painted one keeps its white, coral, teal or mustard), the
 * top in the top tyre's colour with the dark bore on it. Square on the quest
 * budget (3 runs = 26 triangles, bore mixed into the lid), hexagonal on 40.
 */
function buildFar(seed: number, _scheme: string | undefined, target: number): SolidMesh {
  const near = build(seed);
  const P = plan(seed);
  const sides = target >= 36 ? 6 : 4;
  const height = stackHeight(P);
  const bands: { y0: number; y1: number; color: RGB }[] = [];
  for (let i = 0; i < P.count; i++) {
    const y0 = i === 0 ? -SUNK : WIDTH / 2 - SUNK + i * (WIDTH - OVERLAP) - (WIDTH - OVERLAP) / 2;
    const y1 = i === P.count - 1 ? height : WIDTH / 2 - SUNK + i * (WIDTH - OVERLAP) + (WIDTH - OVERLAP) / 2;
    const mid = (y0 + y1) / 2;
    const color = sampleColorOr(near, (c, n) => Math.abs(c.y - mid) < (y1 - y0) * 0.3 && Math.hypot(n.x, n.z) > 0.7 && Math.hypot(c.x, c.z) > R * 0.7, CAR_COMMON.rubber, `tire stack ${seed}, tyre ${i}`);
    const last = bands[bands.length - 1];
    if (last && Math.hypot(last.color[0] - color[0], last.color[1] - color[1], last.color[2] - color[2]) < 0.06) last.y1 = y1;
    else bands.push({ y0, y1, color });
  }
  const m = new SolidMesh();
  // The top: the top tyre's own colour (its ring is most of what shows from
  // above — a painted top tyre stays white, coral, teal or mustard) with the
  // dark bore as a square of the bore's area a hair above it on 40 (when
  // the limit has the 2 triangles); on quest — no triangle to spare world-
  // wide — the lid is the ring and bore mixed by area (the bore is 28 % of
  // the disc).
  const BORE_DARK = darken(CAR_COMMON.rubber, 0.5);
  const sideTris = bands.length * 2 * sides;
  const lidTris = sides - 2;
  const withBore = target >= 36 && sideTris + lidTris + 2 <= Math.floor(1.15 * target);
  const topColor = bands[bands.length - 1].color;
  const lid = withBore ? topColor : mix(topColor, BORE_DARK, (BORE / R) ** 2);
  bands.forEach((b, k) => {
    const topBand = k === bands.length - 1;
    // The tyre's outer face is round: a polygon a little outside the flats.
    farPrism(m, { at: [0, 0, 0], y0: b.y0, y1: b.y1, sides, radius: R * 1.02, startDeg: 15 * k, ...(topBand ? { top: paint(lid, { gloss: 0.3, smooth: 0 }) } : {}) }, paint(b.color, { gloss: 0.3, smooth: 0 }));
  });
  if (withBore) {
    const h = (BORE * Math.sqrt(Math.PI)) / 2;
    const y = height + 0.005;
    const q = [new Vector3(-h, y, -h), new Vector3(h, y, -h), new Vector3(h, y, h), new Vector3(-h, y, h)];
    const up = new Vector3(0, 1, 0);
    const F = paint(BORE_DARK, { gloss: 0.05, smooth: 0 });
    dirTri(m, q[0], q[1], q[2], up, F);
    dirTri(m, q[0], q[2], q[3], up, F);
  }
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd04-tire-stack',
  name: 'Tire stack barrier',
  category: 'dressing',
  size: { x: 0.82, y: 1.07, z: 0.82 },
  variants: 4,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders,
  build,
  buildFar,
};

export default asset;
