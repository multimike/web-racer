import { SolidMesh } from '../../gfx/solid';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  canopy,
  chimney,
  cornerPosts,
  door,
  finishBuilding,
  gableFraming,
  gableRoof,
  gableRoofInfo,
  planter,
  schemePaints,
  steps,
  stonePlinth,
  variantPaints,
  variation,
  wallBox,
  wallLantern,
  windowUnit,
} from './parts';
import type { Opening } from './parts';

/**
 * B04 — Gable Cottage. Sheet scheme: WARM (cream plaster, coral seamed roof,
 * teal door / frames / shutters); it also builds as 'coastal' and 'sunny'.
 *
 * MAIN BODY 6.0 (x) × 5.0 (z) m, walls to the 2.8 m eave. The gable ends
 * face front (−z) and back, so the ridge runs along z (the brief's +Y).
 * Stone plinth to 0.5 m; the door threshold stands on it.
 * OVERALL 6.75 × 5.41 × 6.21 m with eaves, bargeboards, chimney, canopy and
 * steps (x ±3.37, z −3.36 … 2.85) — inside the brief's 6.8 × 6.3 m
 * placement envelope.
 *
 * HEIGHT — THE SHEET WINS OVER THE BRIEF. The brief says "eave 2.8, ridge
 * 4.5, total 4.5"; every view of the sheet (and both gameplay-vision images)
 * draws a 36° roof whose apex boss stands 2.5 m above the eave. A roof held
 * to 4.5 m is 29° at most and reads as a different, squatter house, so the
 * eave keeps the brief's 2.8 m and the roof takes the sheet's pitch: apex
 * boss at 5.35 m, chimney cap at 5.41 m (+20 % on the brief's total). Note
 * that src/world/catalog.ts still lists the brief's 4.5 m. `ROOF_TOP` is the
 * one number to change (to 4.6) if the brief's height must be met instead;
 * tie beam, canopy and colliders follow it.
 *
 * FRONT, as on the sheet: the tie beam sits 0.62 m above the eave line with
 * the boarded truss above it and plaster below; the door canopy hangs from
 * its underside between two corbels.
 *
 * Opening schedule (brief): front = centred door + a shuttered window each
 * side; each side wall = one window in a full cream surround (the sheet's
 * main image); rear = two small shuttered windows. The door is 1.08 × 1.95 m,
 * not the nominal 1.0 × 2.2: threshold on the plinth and canopy above it
 * leave no more under a 2.8 m eave.
 *
 * Seeds: 0 = the sheet. The game instantiates 0 – 2, so the choices that
 * show at a glance CYCLE (door / shutter colours, open or closed front
 * shutters, seams or tiles, chimney slope, door pots, a lantern on a front
 * corner post; side shutters and flower boxes on seeds 3 – 4) and only the
 * small ones roll (a lit window, a few centimeters of window width, ridge
 * and chimney height). 5 480 triangles for seed 0, at most 5 840 for any
 * seed 0 – 5.
 */

const W = 6.0;
const D = 5.0;
const EAVE = 2.8;
const PLINTH = 0.5;
const STEP_TREAD = 0.4;
const STEP_WIDTH = 1.7;
/** Finished height of the roof (top of the apex boss). */
const ROOF_TOP = 5.35;
/** The tie beam sits this far above the eave line, as on the sheet: plaster
 * below it (where the door canopy hangs), boarded gable above. */
const TIE_RAISE = 0.62;
const TIE_SIZE = 0.34;
const POST = 0.36;
/** Chimney: plan position on the right-hand slope (mirrored by some seeds),
 * stack section, height above the roof surface at its centre. */
const CHIMNEY: readonly [number, number] = [1.4, 1.45];
const CHIMNEY_SIZE = 0.85;
const CHIMNEY_HEIGHT = 1.28;

const DOOR: Opening = { u: 0, v: PLINTH, w: 1.08, h: 1.95, round: 0.12 };

/**
 * Secondary choices of one variant (seed 0 = the sheet). Shared by `build`
 * and `colliders`, so whatever stands on the ground also blocks.
 */
function choices(seed: number) {
  const v = variation(seed, 'b04');
  // The game instantiates seeds 0 – 2 (world catalog), so what should be
  // seen there cycles instead of rolling: 1 = tiles, coral door, a pot;
  // 2 = closed shutters, chimney on the left slope, lantern, two pots.
  // Side shutters and flower boxes cost 200 – 220 triangles a pair and fit
  // the budget only on seeds 3 and 4, which today only the lab shows.
  const potCount = v.cycle([0, 1, 2, 0, 1, 0] as const);
  const potSide = v.flip('potSide');
  return {
    v,
    frontShutters: v.cycle(['open', 'open', 'closed'] as const),
    sideShutters: v.cycle([false, false, false, true, false, false] as const),
    chimneySide: v.cycle([1, 1, -1] as const),
    covering: v.cycle(['seams', 'tiles', 'seams', 'seams'] as const),
    winW: 0.72 + v.shift('winW', 0.04),
    flowerBoxes: v.cycle([false, false, false, false, true, false] as const),
    lantern: v.cycle([0, 0, 1, -1, 0, 1] as const),
    // Pots beside the door steps, as plan positions (x, z).
    pots: Array.from({ length: potCount }, (_, i): [number, number] => [(i === 0 ? potSide : -potSide) * 1.5, -D / 2 - 0.42]),
  };
}

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const P = variantPaints(schemePaints(scheme, 'warm'), v);
  const m = new SolidMesh();

  // a. Roof — its rise sets the gable walls.
  const roof = gableRoof(m, { span: W, length: D, eave: EAVE, top: ROOF_TOP + v.shift('ridge', 0.1), overhang: { eave: 0.2, gable: [0.4, 0.3] }, covering: c.covering }, P);

  // b. Plinth.
  stonePlinth(m, { width: W, depth: D, top: PLINTH, seed }, P);

  // c. Walls with their openings.
  const frontWin = (side: 1 | -1): Opening => ({ u: side * 1.9, v: 1.2, w: c.winW, h: 0.9 });
  const sideWin: Opening = { u: 0, v: 1.15, w: 0.85, h: 1.0 };
  const rearWin = (side: 1 | -1): Opening => ({ u: side * 1.25, v: 1.3, w: 0.7, h: 0.8 });
  const tieY = EAVE + TIE_RAISE;
  const F = wallBox(
    m,
    {
      width: W,
      depth: D,
      bottom: PLINTH - 0.1,
      top: EAVE,
      gable: { ridge: 'z', rise: roof.rise },
      gablePaint: P.timberDark,
      gableFrom: tieY,
      openings: { front: [DOOR, frontWin(-1), frontWin(1)], left: [sideWin], right: [sideWin], back: [rearWin(-1), rearWin(1)] },
    },
    P.wall,
  );

  // d + e. Timber frame: corner posts, a truss in each gable, wall plates under the eaves.
  cornerPosts(m, { width: W, depth: D, bottom: PLINTH - 0.05, top: EAVE + 0.05, size: POST }, P.timber);
  const framing = { width: W - 0.3, base: EAVE, rise: roof.rise * ((W - 0.3) / W), size: 0.27, tieRaise: TIE_RAISE, tieSize: TIE_SIZE, strutAngle: 42 };
  for (const on of [F.front, F.back]) gableFraming(m, { on, ...framing }, P.timber);
  for (const s of [1, -1]) {
    // Wall plate: 4.5 cm proud, so it dies into the corner posts (6 cm proud).
    const x = s * (W / 2 - 0.035);
    beam(m, { from: [x, EAVE - 0.14, -D / 2 + 0.1], to: [x, EAVE - 0.14, D / 2 - 0.1], size: [0.28, 0.16], side: [s, 0, 0], caps: false, back: false, segments: 3 }, P.timber);
  }

  // f. Openings.
  door(m, { on: F.front, opening: DOOR }, P);
  for (const side of [1, -1] as const) {
    windowUnit(m, { on: F.front, opening: frontWin(side), shutters: c.frontShutters, flowerBox: c.flowerBoxes, seed: seed * 2 + (side > 0 ? 1 : 0) }, P);
    windowUnit(m, { on: F.back, opening: rearWin(side), shutters: 'open' }, P);
  }
  // Side windows as on the sheet's main image: a full cream surround, no
  // shutters (the side inset's shuttered version is a variant).
  const sideShutters = c.sideShutters ? 'open' : 'none';
  windowUnit(m, { on: F.left, opening: sideWin, surround: 0.13, shutters: sideShutters, lit: v.chance('litLeft', 0.3, false) }, P);
  windowUnit(m, { on: F.right, opening: sideWin, surround: 0.13, shutters: sideShutters }, P);

  // g. Attachments. The canopy hangs from the underside of the raised tie beam.
  canopy(m, { on: F.front, u: 0, v: tieY - TIE_SIZE / 2 + 0.01, width: 2.25, projection: 0.8, drop: 0.6 }, P);
  steps(m, { on: F.front, u: 0, width: STEP_WIDTH, top: PLINTH, steps: 2, tread: STEP_TREAD }, P);
  chimney(m, { at: [c.chimneySide * CHIMNEY[0], CHIMNEY[1]], roof, size: CHIMNEY_SIZE, height: CHIMNEY_HEIGHT + v.shift('chimneyH', 0.08) }, P);
  // On the face of a front corner post — clear of canopy, brackets and shutters.
  if (c.lantern) wallLantern(m, { on: F.front, u: c.lantern * (W / 2 - POST / 2 + 0.06), v: 2.42, reach: 0.38, proud: 0.06 }, P);

  // h. Dressing.
  c.pots.forEach((at, i) => planter(m, { at, seed: seed * 7 + i, paint: i === 0 ? P.accent : P.trim }, P));
  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const stepsOut = 2 * STEP_TREAD;
  const wallTop = EAVE + 0.1;
  const roof = gableRoofInfo({ span: W, length: D, eave: EAVE, top: ROOF_TOP });
  // The slopes as four stacked boxes, each topping out at the roof's height
  // 0.4 m inside its own edge: the stairs then stray at most 0.3 m above or
  // below the surface a car lands on. (A box cannot roll, only turn in plan.)
  const roofStep = (halfWidth: number): ColliderSpec => {
    const top = roof.heightAt(Math.max(0, halfWidth - 0.4), 0);
    return { shape: 'box', center: [0, (wallTop + top) / 2, -0.05], half: [halfWidth, (top - wallTop) / 2, D / 2 + 0.35] };
  };
  const chimneyBase = roof.heightAt(CHIMNEY[0], 0) - 0.3;
  const chimneyTop = roof.heightAt(CHIMNEY[0], 0) + CHIMNEY_HEIGHT;
  return [
    // Walls, including the plinth's proud blocks.
    { shape: 'box', center: [0, wallTop / 2, 0], half: [W / 2 + 0.15, wallTop / 2, D / 2 + 0.15] },
    ...[2.7, 1.9, 1.1, 0.4].map(roofStep),
    { shape: 'box', center: [c.chimneySide * CHIMNEY[0], (chimneyBase + chimneyTop) / 2, CHIMNEY[1]], half: [CHIMNEY_SIZE / 2 + 0.1, (chimneyTop - chimneyBase) / 2, CHIMNEY_SIZE / 2 + 0.1] },
    // Door steps on the street side (lower step: 2.1 m wide, 0.8 m out).
    { shape: 'box', center: [0, PLINTH / 2, -D / 2 - stepsOut / 2], half: [STEP_WIDTH / 2 + 0.2, PLINTH / 2, stepsOut / 2] },
    // Door pots of this variant.
    ...c.pots.map(([x, z]): ColliderSpec => ({ shape: 'cylinder', base: [x, 0, z], height: 0.45, radius: 0.28 })),
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b04-gable-cottage',
  name: 'B04 Gable Cottage',
  category: 'building',
  size: { x: 6.75, y: 5.5, z: 6.2 },
  variants: 3,
  schemes: ['warm', 'coastal', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/houses/design-sheet.png',
    brief: 'design-documents/building-design-pack/houses/b04-gable-cottage-brief.txt',
  },
  build,
  colliders,
};

export default asset;
