import { SolidMesh, extrudePolygon, jitterColor, mix, paint, revolve, rng } from '../../gfx/solid';
import type { Paint, RGB, Rng, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { IRON, WOOD, bolt, capHeight, ironPaint, timberPaint, timberPost } from './dressing-village-parts';

/**
 * Timber signpost: the fence's chunky capped post grown to head height, with
 * one or two arrow-shaped boards bolted to its street face (−z). Each board
 * is a thick painted plank cut to a point, carrying a raised arrow on BOTH
 * faces — direction by shape alone, no text — so it reads from behind as
 * well (the post crosses the back arrow, as on a real fingerpost).
 *
 * Schemes say where it points, seen from the street: 'left', 'right', or
 * 'both' (two boards, the upper one pointing right, the lower one left).
 *
 * Seeds change the silhouette, not just the paint: the post's height and
 * its top (slate cap · turned ball finial · plain bevelled timber), the
 * boards' cut (swallow-tail or square-sawn), length and depth, and — on the
 * one-way schemes — a second, shorter plaque under the main board.
 */

const POST_W = 0.18;
const POST_H = 2.45;
const TOP = POST_H + capHeight(POST_W);
const BOARD_L = 1.0;
const BOARD_H = 0.3;
const BOARD_T = 0.06;

type Tail = 'swallow' | 'square';

/** Board outline as SEEN from the street, pointing RIGHT: x = viewer's
 * right, y = up. */
function boardOutline(length: number, height: number, tail: Tail): Vec2[] {
  const l = length / 2;
  const h = height / 2;
  const point = height * 0.62;
  const o: Vec2[] = [
    [-l, -h],
    [l - point, -h],
    [l, 0],
    [l - point, h],
    [-l, h],
  ];
  if (tail === 'swallow') o.push([-l + height * 0.3, 0]);
  return o;
}

function arrowOutline(length: number, height: number): Vec2[] {
  const l = length * 0.3;
  const shaft = height * 0.12;
  const head = height * 0.31;
  const neck = l - height * 0.72;
  return [
    [-l, -shaft],
    [neck, -shaft],
    [neck, -head],
    [l, 0],
    [neck, head],
    [neck, shaft],
    [-l, shaft],
  ];
}

const flipX = (o: readonly Vec2[]): Vec2[] => o.map(([x, y]) => [-x, y] as const);

interface BoardOptions {
  dir: 1 | -1;
  y: number;
  length: number;
  height: number;
  tail: Tail;
  color: RGB;
  arrow: Paint;
  bolts: Paint;
  /** Tilt about the post, degrees. */
  tilt: number;
}

function board(m: SolidMesh, o: BoardOptions): void {
  const s = m.mark();
  // Back face 4 mm inside the post's street face: sunk, not touching.
  const zBack = -POST_W / 2 + 0.004;
  const zFront = zBack - BOARD_T;
  const outline = boardOutline(o.length, o.height, o.tail);
  const arrow = arrowOutline(o.length, o.height);
  // The plank is hung a little off-centre, toward its point.
  const x = o.dir * o.length * 0.06;
  extrudePolygon(m, { outline: o.dir > 0 ? outline : flipX(outline), depth: BOARD_T, bevel: 0.016, bevelBack: true, facing: '-z', at: [x, o.y, zBack] }, paint(o.color, { gloss: 0.45 }));
  // Street face.
  extrudePolygon(m, { outline: o.dir > 0 ? arrow : flipX(arrow), depth: 0.02, bevel: 0.007, back: false, facing: '-z', at: [x + o.dir * 0.02, o.y, zFront + 0.006] }, o.arrow);
  // Back face: drawn as seen from behind, where the same direction is the
  // other way round. Its middle disappears into the post.
  extrudePolygon(m, { outline: o.dir > 0 ? flipX(arrow) : arrow, depth: 0.02, bevel: 0.007, back: false, facing: '+z', at: [x + o.dir * 0.02, o.y, zBack - 0.006] }, o.arrow);
  // Two bolts through the board into the post, above and below the arrow.
  for (const dy of [-0.36, 0.36]) bolt(m, [0, o.y + dy * o.height, zFront + 0.002], [0, 0, -1], 0.022, o.bolts);
  if (o.tilt) m.rotate('z', o.tilt, s, [0, o.y, 0]);
}

/** Turned iron finial: a collar that covers the square post, a waist, a ball. */
function ballFinial(m: SolidMesh, y: number, p: Paint): number {
  const collar = (POST_W / 2) * Math.SQRT2 + 0.012;
  revolve(
    m,
    {
      profile: [
        [0, y - 0.005],
        [collar, y - 0.005],
        [collar, y + 0.045],
        [0.06, y + 0.08],
        [0.105, y + 0.165],
        [0.07, y + 0.24],
        [0, y + 0.262],
      ],
      segments: 8,
    },
    p,
  );
  return y + 0.262;
}

function build(seed: number, scheme?: string): SolidMesh {
  const r: Rng = rng(seed, 'd14-signpost', scheme ?? 'right');
  const hero = seed === 0;
  const POST = timberPaint(hero ? WOOD.post : jitterColor(r, WOOD.post, { hue: 5, lightness: 0.05 }));
  const CAP = paint(IRON.cap, { gloss: 0.3 });
  const CREAM = paint(BUILDING.cream, { gloss: 0.35 });
  // Mustard boards carry a dark arrow instead: cream on mustard is weak.
  const DARK = paint(mix(BUILDING.cobalt, IRON.cap, 0.3), { gloss: 0.35 });
  const BOLT = ironPaint();
  const colors: RGB[] = [BUILDING.turquoise, BUILDING.coral, BUILDING.mustard, BUILDING.cobalt];
  const m = new SolidMesh();

  const variant = hero ? 0 : seed % 4;
  const top = (['cap', 'ball', 'plain', 'cap'] as const)[variant];
  // Every top ends at about the same height: a shorter post under the ball.
  const postH = hero ? POST_H : POST_H * r.range(0.93, 1.03) - (top === 'ball' ? 0.17 : 0);
  if (top === 'ball') {
    timberPost(m, { x: 0, height: postH, width: POST_W, post: POST });
    ballFinial(m, postH, paint(IRON.cap, { gloss: 0.45, metal: 0.3 }));
  } else {
    timberPost(m, { x: 0, height: postH + (top === 'plain' ? 0.05 : 0), width: POST_W, post: POST, cap: top === 'cap' ? CAP : undefined, overhang: 0.025 });
  }

  const two = scheme === 'both';
  const dirs: (1 | -1)[] = two ? [1, -1] : scheme === 'left' ? [-1] : [1];
  // One-way posts on every other seed carry a second, shorter plaque.
  const plaque = !two && !hero && variant % 2 === 1;
  if (plaque) dirs.push(dirs[0]);
  const count = dirs.length;
  const tailFor = (k: number): Tail => (hero || (variant + k) % 2 === 0 ? 'swallow' : 'square');
  dirs.forEach((dir, k) => {
    const small = plaque && k === 1;
    const base = colors[(seed + k) % colors.length];
    const height = (small ? 0.23 : BOARD_H) * (hero ? 1 : r.range(0.92, 1.08));
    const yTop = postH - 0.33 - (hero ? 0 : r.range(0, 0.06));
    board(m, {
      dir,
      y: count === 2 ? (k === 0 ? yTop + 0.07 : yTop - 0.31 - (small ? 0 : 0.02)) : yTop,
      length: small ? BOARD_L * 0.72 : hero ? BOARD_L : BOARD_L * r.range(0.86, 1.0),
      height,
      tail: tailFor(k),
      color: hero ? base : jitterColor(r, base, { hue: 5, lightness: 0.04 }),
      arrow: base === BUILDING.mustard ? DARK : CREAM,
      bolts: BOLT,
      tilt: hero ? 0 : r.range(-4, 4),
    });
  });

  if (!hero) {
    m.rotate('z', r.range(-1.5, 1.5));
    m.rotate('x', r.range(-1.5, 1.5));
  }
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'cylinder', base: [0, 0, 0], height: TOP, radius: POST_W * 0.7 }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd14-signpost',
  name: 'Timber signpost',
  category: 'dressing',
  // x: the board, hung 6 cm off-centre toward its point; y includes the
  // 5 cm skirt below ground; z: post cap plus the board and its arrow.
  size: { x: BOARD_L + 0.06, y: TOP + 0.05, z: 0.29 },
  variants: 4,
  schemes: ['right', 'left', 'both'],
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
