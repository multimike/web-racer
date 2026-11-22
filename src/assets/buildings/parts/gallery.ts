import { SolidMesh } from '../../../gfx/solid';
import { BUILDING } from '../../palette';
import {
  awning,
  balcony,
  barrel,
  crate,
  emblem,
  EMBLEMS,
  pergola,
  planter,
  railing,
  signBoard,
  stairFlight,
  steps,
  wallLamp,
} from './attachments';
import { finishBuilding } from './finish';
import { door, louvreVent, windowUnit } from './openings';
import { schemePaints, withPaints } from './paints';
import { chimney, flatRoof, hipRoof, shedRoof, solarPanel } from './roofs';
import { cornerPosts, kneeBrace, post, quoins, stonePlinth, trimBand, wallBox, wallPanel } from './walls';
import type { Opening } from './walls';

/**
 * REFERENCE ASSEMBLIES — three small buildings that between them use every
 * part the Gable Cottage does not, so the whole kit can be looked at (and
 * its triangle costs measured) without waiting for the real B05 – B10.
 * They are registered as DEV-ONLY lab assets (`zz-kit-*.asset.ts` next to
 * this file; the game's catalog does not list them), so the asset lab audits
 * every part: flipped faces, inside-out shells, budget, `debug=backface`.
 * They are also worked examples of a two-storey body, a rounded flat-roof
 * shell with deck furniture, and a boarded shed with a shop front. Delete a
 * `zz-kit-*` file once the real building that uses its parts exists.
 *
 * PLACING THINGS ABOVE A DOOR. A door surround ends 0.13 m above the
 * opening; a band, parapet or balcony slab starts wherever it starts. What
 * goes between them — a wall lamp, a sign — needs its whole height in that
 * gap, so size the door for it (the houses here use 1.85 / 1.9 m doors for
 * a 0.2 m lamp). And keep brackets off openings: a balcony's brackets stand
 * 0.22 m inside its two ends and reach 0.6 m down the wall.
 */
export function galleryBuilding(which: number): SolidMesh {
  const base = schemePaints('warm');
  const m = new SolidMesh();
  const PL = 0.5;

  if (which === 0) {
    // --- Two storeys, hip roof, balcony (the B06 family) ---------------------
    const P = withPaints(base, { wall: BUILDING.apricot, roof: BUILDING.cobalt });
    const W = 5;
    const D = 4;
    const TOP = 5.4;
    const roof = hipRoof(m, { width: W, depth: D, eave: TOP, top: 6.5, overhang: 0.4, ridgeLength: 0, edgePaint: P.trim }, P);
    stonePlinth(m, { width: W, depth: D, top: PL }, P);
    // The balcony sits over the window, clear of the front door: its left
    // bracket comes down between the two.
    const BALCONY_U = 0.45;
    const DOOR: Opening = { u: -1.5, v: PL, w: 1.0, h: 1.85, round: 0.12 };
    const W0: Opening = { u: 0.65, v: 1.15, w: 0.9, h: 1.0 };
    const BALCONY_DOOR: Opening = { u: BALCONY_U, v: 3.0, w: 1.3, h: 1.9 };
    const side = (v: number): Opening => ({ u: 0, v, w: 0.8, h: 1.0 });
    const F = wallBox(
      m,
      { width: W, depth: D, bottom: PL - 0.1, top: TOP, grid: 1.0, openings: { front: [DOOR, W0, BALCONY_DOOR], left: [side(1.15), side(3.75)], right: [side(1.15), side(3.75)], back: [side(1.15), side(3.75)] } },
      P.wall,
    );
    cornerPosts(m, { width: W, depth: D, bottom: PL - 0.05, top: TOP - 0.1, size: 0.34, corners: ['fl', 'fr'], base: { height: 0.3 } }, P.trim);
    for (const sx of [1, -1] as const) quoins(m, { at: [(sx * W) / 2, D / 2], out: [sx, 1], bottom: PL, top: TOP - 0.2 }, P.trim);
    trimBand(m, { width: W, depth: D, y: 2.85, height: 0.3, proud: 0.1 }, P.trim);
    trimBand(m, { width: W, depth: D, y: TOP - 0.05, height: 0.34, proud: 0.16 }, P.trim);
    door(m, { on: F.front, opening: DOOR }, P);
    door(m, { on: F.front, opening: BALCONY_DOOR, glazed: [2, 3], surround: 0.12, handle: 'none' }, P);
    windowUnit(m, { on: F.front, opening: W0, surround: 0.13 }, P);
    for (const on of [F.left, F.right, F.back]) for (const v of [1.15, 3.75]) windowUnit(m, { on, opening: side(v), surround: 0.13 }, P);
    balcony(m, { on: F.front, u: BALCONY_U, v: 3.0, width: 2.6, projection: 0.9 }, P);
    steps(m, { on: F.front, u: DOOR.u, width: 1.3, top: PL, steps: 2 }, P);
    // Between the door surround (to 2.48) and the band (from 2.7).
    wallLamp(m, { on: F.front, u: DOOR.u, v: 2.59, size: [0.44, 0.2] }, P);
    chimney(m, { at: [1.2, 0.6], roof, size: 0.6, height: 0.8, vent: '+x' }, P);
    return finishBuilding(m);
  }

  if (which === 1) {
    // --- Rounded shell, flat roof with deck furniture (the B05 family) ------
    const P = schemePaints('coastal');
    const W = 5;
    const D = 5;
    const DECK = 3.0;
    const PARAPET = 3.5;
    const R = 0.45;
    const roof = flatRoof(m, { width: W, depth: D, deck: DECK, parapetTop: PARAPET, cornerRadius: R }, P);
    stonePlinth(m, { width: W, depth: D, top: PL, seed: 3 }, P);
    const DOOR: Opening = { u: 1.1, v: PL, w: 1.0, h: 1.9, round: 0.5 };
    const pill = (u: number): Opening => ({ u, v: 1.05, w: 0.45, h: 1.1, round: 0.225, roundAll: true });
    const F = wallBox(m, { width: W, depth: D, bottom: PL - 0.1, top: DECK, cornerRadius: R, openings: { front: [DOOR, pill(-1.5), pill(-0.6)], left: [pill(0)], right: [pill(0)] } }, P.wall);
    door(m, { on: F.front, opening: DOOR, paint: P.accent }, P);
    for (const u of [-1.5, -0.6]) windowUnit(m, { on: F.front, opening: pill(u), surround: 0.14, mullions: [1, 2], frame: 0 }, P);
    for (const on of [F.left, F.right]) windowUnit(m, { on, opening: pill(0), surround: 0.14, mullions: [1, 2], frame: 0 }, P);
    // B05's signature: the glowing pill over the door, in the strip of wall
    // between the door surround (to 2.53) and the parapet band (from 2.75).
    wallLamp(m, { on: F.front, u: DOOR.u, v: 2.64, size: [0.5, 0.2] }, P);
    pergola(m, { at: [-1.1, -0.2], base: roof.heightAt(0, 0), size: [2.0, 2.4], height: 1.7 }, P);
    solarPanel(m, { at: [1.3, DECK, 0.6], tilt: 28, rot: [0, 20, 0] }, P);
    railing(m, { path: [[-2.2, 2.2], [-2.2, -2.2], [2.2, -2.2], [2.2, 2.2], [-0.6, 2.2]], base: PARAPET - 0.02, height: 0.55, style: 'rails' }, P);
    // Up to the parapet's top, where the railing leaves its gap (B05's rear view).
    stairFlight(m, { from: [2.2, 0, D / 2 + 0.6], to: [-1.6, PARAPET, D / 2 + 0.6], width: 1.0, style: 'slab' }, P);
    railing(m, { path: [[2.0, D / 2 + 1.0], [-2.0, D / 2 + 1.0]], base: 0, height: 0.9, style: 'boards', spacing: 4 }, P);
    planter(m, { at: [2.0, -D / 2 - 0.45] }, P);
    return finishBuilding(m);
  }

  // --- Boarded shed with a shop front (B01 / B02 / B08 family) --------------
  const P = schemePaints('sunny');
  const W = 6;
  const D = 4;
  const LOW = 2.6;
  const HIGH = 3.5;
  shedRoof(m, { width: W, depth: D, low: LOW, high: HIGH, fall: '+z', edgeBoards: true }, P);
  stonePlinth(m, { width: W, depth: D, top: 0.35, seed: 5, blockLength: [0.6, 1.3] }, P);
  const BARN: Opening = { u: -1.6, v: 0.35, w: 1.8, h: 2.2 };
  const SERVE: Opening = { u: 1.4, v: 1.1, w: 2.2, h: 1.2 };
  const boards = { direction: 'vertical' as const, pitch: 0.5 };
  // The serving window is cut through BOTH skins — the boarded wall and the
  // cream panel laid over it — or its glass sits behind the wall and the
  // hole shows plain boards.
  const F = wallBox(m, { width: W, depth: D, bottom: 0.25, top: LOW, openings: { front: [BARN, SERVE] }, boards }, P.wall);
  // The front wall is the HIGH one: a panel of its own on top of the box,
  // and the two side walls get their sloping tops the same way.
  // They start exactly where the box's walls really end (2 cm above the
  // nominal eave line, the lap every wall top has): no gap, no doubled face.
  wallPanel(m, { on: F.front, width: W, bottom: LOW + 0.02, top: HIGH, openings: [], boards, foot: 0 }, P.wall);
  for (const on of [F.left, F.right]) {
    const tops: [number, number] = on === F.left ? [LOW, HIGH] : [HIGH, LOW];
    wallPanel(m, { on, width: D - 0.48, bottom: LOW + 0.02, top: tops, boards, ends: false, foot: 0 }, P.wall);
  }
  wallPanel(m, { on: { ...F.front, plane: F.front.plane + 0.012 }, width: 2.6, u: 1.4, bottom: 0.9, top: 2.5, openings: [SERVE] }, P.wallAlt);
  cornerPosts(m, { width: W, depth: D, bottom: 0.3, top: LOW + 0.05, size: 0.3, corners: ['bl', 'br'] }, P.timber);
  for (const sx of [1, -1] as const) quoins(m, { at: [(sx * W) / 2, -D / 2], out: [sx, -1], bottom: 0.35, top: HIGH - 0.1 }, P.trim);
  door(m, { on: F.front, opening: BARN, double: true, planks: 6, hinges: true, handle: 'bar', paint: P.timber }, P);
  windowUnit(m, { on: { ...F.front, plane: F.front.plane + 0.012 }, opening: SERVE, mullions: [1, 1], frame: 0.09, head: false }, P);
  awning(m, { on: F.front, u: 1.4, v: 3.0, width: 3.0, projection: 1.1, drop: 0.5 }, P);
  signBoard(m, { on: F.front, u: -1.6, v: 3.05, size: [1.5, 0.6], emblem: EMBLEMS.arrow }, P);
  signBoard(m, { on: F.right, u: -1.2, v: 2.6, size: [0.7, 0.55], emblem: EMBLEMS.star, hanging: true }, P);
  emblem(m, { on: F.left, u: 0, v: 1.6, size: 1.8, outline: EMBLEMS.wrench, turn: 20 }, P.trim);
  louvreVent(m, { on: F.back, u: 0, v: 1.9, w: 0.8, h: 0.5 }, P);
  // Porch corner on the right: post, brace, a run of board railing, an open stair.
  post(m, { at: [W / 2 + 1.3, -D / 2 + 0.3], bottom: -0.05, top: 2.5, size: 0.2, base: { height: 0.3, paint: P.trim } }, P.timber);
  kneeBrace(m, { at: [W / 2 + 1.3, 2.4, -D / 2 + 0.3], along: [-1, 0, 0] }, P.timber);
  railing(m, { path: [[W / 2 + 1.3, -D / 2 + 0.3], [W / 2 + 1.3, D / 2 - 0.3]], base: 0, height: 1.0, style: 'boards' }, P);
  stairFlight(m, { from: [W / 2 + 0.7, 0, D / 2 + 1.6], to: [W / 2 + 0.7, 1.4, D / 2 - 0.4], width: 0.9, style: 'open' }, P);
  barrel(m, { at: [-W / 2 + 0.2, -D / 2 - 0.5], planted: true }, P);
  barrel(m, { at: [3.6, -D / 2 - 0.5] }, P);
  crate(m, { at: [0.7, -D / 2 - 0.55], produce: P.accent, rotY: 8 }, P);
  crate(m, { at: [1.6, -D / 2 - 0.5], produce: P.foliage, rotY: -6, seed: 2 }, P);
  return finishBuilding(m);
}
