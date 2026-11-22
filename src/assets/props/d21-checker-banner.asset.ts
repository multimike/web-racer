import { SolidMesh, box, frustum, jitterColor, paint, rng, roundedBox } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { BUILDING, STONE } from '../palette';
import type { PropAsset } from '../types';
import { TRACK, cloth } from './dressing-track-parts';
import { farCheckerCard, farPrism } from './farKit';

/**
 * The teal checkered banners that hang along the fences in the vision, as a
 * free-standing piece: two timber stakes with slate caps, a rail between
 * them and a cloth with white checkers inside a teal margin. Set it just in
 * front of a fence line, or on its own along a verge. The cloth is pinned
 * along the rail (wind 0) and its lower edge is free (wind 1). Seeds change
 * the cloth colour, the checker layout, the billow and how the stakes lean.
 */

const HALF = 0.93; // stake centre lines
const RAIL_Y = 1.17;
const CELL = 0.2;
const COLS = 8;
const ROWS = 5;

/** The seed's first draws — cloth and timber colours — shared by the near
 * model (which goes on drawing from `r`) and the far one. */
function head(seed: number): { r: ReturnType<typeof rng>; field: RGB; timber: RGB } {
  const r = rng(seed, 'checker-banner');
  const hero = seed === 0;
  const base: RGB = [TRACK.teal, BUILDING.coral, TRACK.teal, BUILDING.cobalt][seed % 4];
  const field = hero ? base : jitterColor(r, base, { hue: 4, lightness: 0.02 });
  const timber = hero ? BUILDING.timber : jitterColor(r, BUILDING.timber, { hue: 4, lightness: 0.04 });
  return { r, field, timber };
}

function build(seed: number): SolidMesh {
  const { r, field, timber } = head(seed);
  const hero = seed === 0;
  const FIELD = paint(field, { gloss: 0.25 });
  const WHITE = paint(TRACK.white, { gloss: 0.25 });
  const TIMBER = paint(timber, { gloss: 0.2 });
  const CAP = paint(STONE.shadow, { gloss: 0.3 });
  const ROPE = paint(BUILDING.cream, { gloss: 0.1 });

  const m = new SolidMesh();

  for (const sx of [-1, 1]) {
    const s = m.mark();
    const top = hero ? 1.3 : 1.3 + r.range(-0.05, 0.06);
    roundedBox(m, { min: [-0.075, -0.05, -0.075], max: [0.075, top, 0.075], radius: 0.022, segments: 1, faces: { ny: null } }, TIMBER);
    frustum(m, { radiusBottom: 0.095 * Math.SQRT2, radiusTop: 0.04 * Math.SQRT2, from: [0, top - 0.02, 0], to: [0, top + 0.09, 0], sides: 4, round: false, arcStart: 45 }, CAP);
    // Stakes driven in by hand never stand quite true.
    if (!hero) m.rotate('z', r.range(-2.5, 2.5), s, [0, 0, 0]);
    m.translate([sx * HALF, 0, 0], s);
  }
  // A touch longer than the stake spacing, so a leaning stake still holds it.
  box(m, { size: [HALF * 2 + 0.04, 0.075, 0.06], at: [0, RAIL_Y, 0] }, TIMBER);

  const billow = hero ? 0.07 : r.range(0.04, 0.09) * r.sign();
  const phase = hero ? 0.6 : r.range(0, 6.28);
  const offset = seed % 2; // which squares are white
  const full = !hero && seed % 4 === 3; // one seed is checkered edge to edge
  cloth(m, {
    origin: [(-COLS * CELL) / 2, RAIL_Y + 0.02, -0.045],
    u: [1, 0, 0],
    v: [0, -1, 0],
    n: [0, 0, -1],
    cols: COLS,
    rows: ROWS,
    cell: [CELL, CELL],
    // Belly out between the stakes, more toward the free lower edge, with a
    // small ripple on top.
    wave: (s, t) => t * (billow * Math.sin(Math.PI * s) + 0.025 * Math.sin(s * 11 + phase)),
    paint: (col, row): Paint => {
      if (!full && (col === 0 || col === COLS - 1 || row === 0 || row === ROWS - 1)) return FIELD;
      return (col + row + offset) % 2 === 0 ? WHITE : FIELD;
    },
    thickness: 0.03,
    wind: (_s, t) => t,
  });
  // Rope ties at the upper corners, wrapped round the rail.
  for (const sx of [-1, 1]) {
    box(m, { size: [0.045, 0.12, 0.105], at: [sx * (COLS * CELL * 0.5 - 0.07), RAIL_Y + 0.005, -0.012] }, ROPE);
  }
  return m;
}

/**
 * The far model: the two stakes (4-sided with their slate caps from 36
 * triangles, 3-sided and flat-topped below) and the cloth as a two-sided
 * card in this seed's own field colour (`head`: the near model's very
 * colour) with white checks printed through on both faces — 2 × 2 on the
 * quest budget (26 triangles), 4 × 2 on 40. The card hangs from the rail
 * and leans out to the near cloth's billow at its hem, so it fills the near
 * model's depth without fattening the stakes.
 */
function buildFar(seed: number, _scheme: string | undefined, target: number): SolidMesh {
  const near = build(seed);
  const { field, timber } = head(seed);
  const rich = target >= 36;
  let top = 0;
  const P = near.positions;
  // Stake tops, and how far the cloth's hem reaches toward the road (its
  // lowest row, middle half; the road face of its skin).
  let hem = Infinity;
  const hemY = RAIL_Y + 0.02 - ROWS * CELL + 0.12;
  for (let i = 0; i < P.length; i += 3) {
    top = Math.max(top, P[i + 1]);
    if (Math.abs(P[i]) < COLS * CELL * 0.25 && P[i + 1] < hemY && P[i + 1] > 0.05) {
      hem = Math.min(hem, P[i + 2]);
    }
  }
  const clothZ = -0.045;
  const TIMBER = paint(timber, { gloss: 0.2, smooth: 0 });
  const CAP = paint(STONE.shadow, { gloss: 0.3, smooth: 0 });
  const m = new SolidMesh();
  for (const sx of [-1, 1]) {
    if (rich) farPrism(m, { at: [sx * HALF, 0, 0], y0: -0.05, y1: top - 0.11, sides: 4, halfWidth: 0.075, cap: { height: 0.11, paint: CAP, halfWidth: 0.095 } }, TIMBER);
    // 3-sided: a corner outward, the other two spanning the cap's ±0.095 m.
    else farPrism(m, { at: [sx * HALF, 0, 0], y0: -0.05, y1: top, sides: 3, radius: 0.095 / Math.cos(Math.PI / 6), startDeg: sx < 0 ? 270 : 90, top: CAP }, TIMBER);
  }
  const full = seed !== 0 && seed % 4 === 3;
  const height = ROWS * CELL + 0.06;
  const dz = Number.isFinite(hem) ? Math.min(0, hem + 0.006 - clothZ) : 0;
  const len = Math.hypot(height, dz);
  farCheckerCard(m, {
    origin: [(-COLS * CELL) / 2, RAIL_Y + 0.06, clothZ],
    u: [1, 0, 0],
    v: [0, -height / len, dz / len],
    n: [0, -dz / len, -height / len],
    width: COLS * CELL,
    height: len,
    cols: rich ? 4 : 2,
    rows: 2,
    parity: seed % 2,
    margin: full ? 0.02 : CELL,
    back: true,
    field: paint(field, { gloss: 0.25, smooth: 0 }),
    check: paint(TRACK.white, { gloss: 0.25, smooth: 0 }),
  });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd21-checker-banner',
  name: 'Checkered verge banner',
  category: 'dressing',
  size: { x: 2.05, y: 1.44, z: 0.24 },
  variants: 4,
  wind: true,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders: () => [
    { shape: 'cylinder', base: [-HALF, 0, 0], height: 1.3, radius: 0.09 },
    { shape: 'cylinder', base: [HALF, 0, 0], height: 1.3, radius: 0.09 },
  ],
  build,
  buildFar,
};

export default asset;
