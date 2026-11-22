import { SolidMesh, box, jitterColor, paint, revolve, rng, sphere } from '../../gfx/solid';
import type { Paint, RGB, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { PropAsset } from '../types';
import { IRON, TRACK, cloth } from './dressing-track-parts';
import { farCheckerCard, farStick } from './farKit';

/**
 * Race flag from the vision: a dark iron pole about as tall as a one-storey
 * shop, on a bell foot, with a bronze ball on top and a near-square teal
 * flag — white checkers inside a narrow teal margin — that hangs slack: the
 * fly end sags and swings in toward the pole. The flag flies toward +x; its
 * hoist is pinned (wind 0) and the fly edge flutters (wind 1). Seeds change
 * the flag colour, the pattern and the pole height.
 */

const POLE_TOP = 4.0;
const POLE_R = 0.085;
const FOOT_R = 0.21;
const MARGIN = 0.1;
const CHECK = 0.3;
const CHECKS = 4;
const FLAG = MARGIN * 2 + CHECK * CHECKS; // 1.4 m square
const HOIST_X = POLE_R + 0.01;

/** The seed's first draws — pole height and flag colour — shared by the
 * near model (which goes on drawing from `r`) and the far one, so both get
 * the very same colour. */
function head(seed: number): { r: ReturnType<typeof rng>; top: number; field: RGB } {
  const r = rng(seed, 'flag-pole');
  const hero = seed === 0;
  const top = hero ? POLE_TOP : POLE_TOP * r.range(0.88, 1.1);
  const field = hero ? TRACK.teal : jitterColor(r, [TRACK.teal, BUILDING.coral, TRACK.teal, BUILDING.cobalt][seed % 4], { hue: 4, lightness: 0.02 });
  return { r, top, field };
}

function build(seed: number): SolidMesh {
  const { r, top, field } = head(seed);
  const hero = seed === 0;
  // Seeds alternate between the vision's margin flag and a full checker.
  const margin = hero || seed % 2 === 0;
  const phase = hero ? 0 : seed % 2;

  const FIELD = paint(field, { gloss: 0.25 });
  const WHITE = paint(TRACK.white, { gloss: 0.25 });
  const BALL = paint(TRACK.bronze, { gloss: 0.7, metal: 0.5 });

  const m = new SolidMesh();

  // Pole: bell foot with a 5 cm skirt, a collar, a slightly tapering shaft.
  // Open on top — the ball covers it.
  const profile: Vec2[] = [
    [FOOT_R, -0.05],
    [FOOT_R, 0.06],
    [0.16, 0.12],
    [0.12, 0.4],
    [0.12, 0.47],
    [POLE_R, 0.52],
    [POLE_R * 0.8, top],
  ];
  revolve(m, { profile, segments: 8 }, IRON);
  sphere(m, { radius: 0.115, segments: 8, rings: 5, at: [0, top + 0.07, 0] }, BALL);

  // Flag. Hoist edge just outside the pole; two iron ties hold it.
  const flagTop = top - 0.14;
  const sizes = margin ? [MARGIN, ...Array<number>(CHECKS).fill(CHECK), MARGIN] : Array<number>(CHECKS + 1).fill(FLAG / (CHECKS + 1));
  const last = sizes.length - 1;
  const phase0 = hero ? 0.5 : r.range(0, 6.28);
  const amp = hero ? 0.19 : r.range(0.15, 0.22);
  const sag = hero ? 0.4 : r.range(0.3, 0.48);
  cloth(m, {
    origin: [HOIST_X, flagTop, 0],
    u: [1, 0, 0],
    v: [0, -1, 0],
    n: [0, 0, 1],
    cols: sizes.length,
    rows: sizes.length,
    cell: [CHECK, CHECK],
    colSizes: sizes,
    rowSizes: sizes,
    // Folds that grow toward the fly edge, sheared down the cloth so they
    // run diagonally like a real flag's.
    wave: (s, t) => amp * Math.pow(s, 0.8) * Math.sin(s * 6.8 + t * 1.9 + phase0),
    // Hanging slack: the top edge falls away from the hoist and the whole
    // fly end swings in under it, more so toward the bottom.
    droop: (s, t) => sag * Math.pow(s, 1.4) + 0.05 * s * t,
    slack: (s, t) => (0.38 * sag + 0.12 * t) * s * s + 0.75 * amp * s,
    paint: (col, row): Paint => {
      if (margin && (col === 0 || col === last || row === 0 || row === last)) return FIELD;
      return (col + row + phase) % 2 === 0 ? WHITE : FIELD;
    },
    thickness: 0.012,
    // The slack pulls the fly edge in to s ≈ 0.8 of the flat width.
    wind: (s) => s * 1.25,
  });
  for (const y of [flagTop - 0.06, flagTop - FLAG + 0.06]) {
    box(m, { size: [0.14, 0.05, POLE_R * 2 + 0.03], at: [0.035, y, 0] }, IRON);
  }

  if (!hero) m.rotate('z', r.range(-1.5, 1.5), 0, [0, 0, 0]);
  return m;
}

/**
 * The far model: the pole on its bell foot and the flag as a two-sided card
 * in this seed's own field colour (the near model's very colour, `head`)
 * with its checks printed through — the same checks on both faces, so a
 * flag seen from behind is still a checkered flag: 2 × 2 on the quest
 * budget (pole 3-sided, 25 triangles), 3 × 3 on 40 — inside the margin when
 * the near flag has one. Hung a little short of the near flag's full
 * square, as the slack one hangs.
 */
function buildFar(seed: number, _scheme: string | undefined, target: number): SolidMesh {
  const { top: poleTop, field } = head(seed);
  const rich = target >= 36;
  const top = poleTop;
  const flagTop = top - 0.14;
  const margin = seed === 0 || seed % 2 === 0;
  const m = new SolidMesh();
  const POLE = paint(TRACK.iron, { gloss: 0.35, smooth: 0 });
  // Bell foot to a slim pole in two runs (the foot sets the stand's depth).
  // On the quest budget a 3-sided pole, its foot radius chosen so the
  // triangle spans the bell's ±0.21 m in z (one corner toward −x).
  if (rich) farStick(m, { path: [[0, -0.05, 0], [0, 0.47, 0], [0, top, 0]], radius: [FOOT_R, POLE_R * 1.2, POLE_R * 0.8], sides: 4, capTop: true }, POLE);
  else farStick(m, { path: [[0, -0.05, 0], [0, 0.47, 0], [0, top, 0]], radius: [FOOT_R / Math.cos(Math.PI / 6), POLE_R * 1.3, POLE_R * 0.9], sides: 3, startDeg: 180, capTop: true }, POLE);
  farCheckerCard(m, {
    origin: [HOIST_X, flagTop, 0],
    u: [1, 0, 0],
    v: [0, -1, 0],
    n: [0, 0, 1],
    width: FLAG * 0.8,
    height: FLAG * 0.86,
    cols: rich ? 3 : 2,
    rows: rich ? 3 : 2,
    parity: seed === 0 ? 0 : seed % 2,
    margin: margin ? MARGIN : 0,
    back: true,
    field: paint(field, { gloss: 0.25, smooth: 0 }),
    check: paint(TRACK.white, { gloss: 0.25, smooth: 0 }),
  });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd03-flag-pole',
  name: 'Checkered flag pole',
  category: 'dressing',
  size: { x: 1.42, y: 4.24, z: 0.42 },
  variants: 4,
  wind: true,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders: () => [{ shape: 'cylinder', base: [0, 0, 0], height: 2.0, radius: 0.2 }],
  build,
  buildFar,
};

export default asset;
