import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  box,
  compose,
  cylinder,
  extrudePolygon,
  frame,
  paint,
  polygonFacing,
  quadFacing,
  rotation,
  roundedBox,
  roundedRectRing,
  shade,
  soften,
  sweep,
  translation,
  triFacing,
} from '../../../gfx/solid';
import type { Paint, SolidMesh, Vec2 } from '../../../gfx/solid';
import { BUILDING } from '../../palette';
import { toFacade } from './facade';
import type { Facade } from './facade';
import type { BuildingPaints } from './paints';
import { chamferRing, rib } from './shapes';

/**
 * Roofs. Every roof builder returns a `RoofInfo`, which is how the rest of
 * the building finds the roof: `rise` for the gable walls under it,
 * `heightAt` / `tiltAt` to stand a chimney or lay a solar panel on it.
 *
 * Shared conventions:
 *  - `eave` is the WALL TOP: the height at which the roof's underside meets
 *    the outer wall face. Overhangs continue the slope outward from there.
 *  - Roofs are solid slabs with real thickness and a closed underside
 *    (painted `soffit`), because jumps and low chase cameras see under them.
 *  - Coverings are geometry: broad standing seams (the delivered sheets) or
 *    tile rows.
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const RAD = Math.PI / 180;

export interface RoofInfo {
  /** Highest point of the finished roof. */
  top: number;
  /** Rise of the underside above the eave line — the gable height for
   * `wallBox({ gable: { rise } })` / `wallPanel({ gable })`. */
  rise: number;
  /** Pitch in degrees. */
  pitch: number;
  /** Height of the roof's top surface above plan point (x, z). */
  heightAt(x: number, z: number): number;
  /** `rot` that leans an upright part square onto the surface at (x, z). */
  tiltAt(x: number, z: number): [number, number, number];
}

type Covering = 'seams' | 'tiles' | 'plain';

const SEAM = { width: 0.085, topWidth: 0.05, height: 0.055 };
/** How far the apex boss of a gable roof stands above the slab's own apex. */
const BOSS_CROWN = 0.2;
/** A roof slab gets a column of vertices this far inside each gable end,
 * clear of the bargeboard's contact shadow. */
const END_CLEAR = 0.38;

/** Repeatable 0 … 1 value for a tile (row, column). */
const tileHash = (k: number, i: number): number => {
  const x = Math.sin(k * 127.1 + i * 311.7 + 1.3) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Tiles on a slope: wedge rows that step down toward the eave, each row cut
 * into single tiles half a tile out of step with the row above, every tile
 * its own tone. At village distances that tonal break — not a hairline
 * groove — is what makes a roof read as tiles rather than as lapped boards,
 * and it costs two triangles a tile (the lip is one face per row).
 * `at(s, h, z)` = point `s` meters down the slope, `h` above the surface.
 */
function tileRows(m: SolidMesh, length: number, z0: number, z1: number, at: (s: number, h: number, z: number) => Vector3, out: Vector3, p: Paint): void {
  const rows = Math.max(2, Math.round(length / 0.52));
  const cols = Math.max(1, Math.round((z1 - z0) / 0.56));
  const w = (z1 - z0) / cols;
  const lip = 0.055;
  const down = at(1, 0, 0).subtract(at(0, 0, 0));
  const lipPaint = paint(p, { color: shade(p.color, 0.86) });
  for (let k = 0; k < rows; k++) {
    const sa = (k / rows) * length;
    const sb = ((k + 1) / rows) * length;
    // Tile edges of this row; odd rows start with a half tile.
    const edges: number[] = [z0];
    for (let i = k % 2 ? 0.5 : 1; i < cols; i++) edges.push(z0 + i * w);
    edges.push(z1);
    for (let i = 0; i + 1 < edges.length; i++) {
      const tone = paint(p, { color: shade(p.color, 0.9 + 0.17 * tileHash(k, i)) });
      quadFacing(m, at(sa, -0.004, edges[i]), at(sa, -0.004, edges[i + 1]), at(sb, lip, edges[i + 1]), at(sb, lip, edges[i]), out, tone);
    }
    const u0 = at(sa, -0.004, z0), u1 = at(sa, -0.004, z1);
    const l0 = at(sb, lip, z0), l1 = at(sb, lip, z1);
    const b0 = at(sb, -0.004, z0), b1 = at(sb, -0.004, z1);
    quadFacing(m, l0, l1, b1, b0, down, lipPaint);
    triFacing(m, u0, l0, b0, V(0, 0, -1), p);
    triFacing(m, u1, l1, b1, V(0, 0, 1), p);
  }
}

// ---------------------------------------------------------------------------
// Gable roof

export interface GableRoofOptions {
  /** Body size ACROSS the ridge (wall face to wall face) and ALONG it. */
  span: number;
  length: number;
  /** Which way the ridge runs (default 'z': gable ends front and back). */
  ridge?: 'z' | 'x';
  cx?: number;
  cz?: number;
  /** Wall top. */
  eave: number;
  /** Give ONE of: `rise` of the underside above the eave, or `top` = the
   * finished height of the whole roof (the brief's "ridge" height). */
  rise?: number;
  top?: number;
  /** Horizontal overhangs. `eave` = past the side walls (default 0.3);
   * `gable` = from the gable wall to the OUTER face of the bargeboard
   * (default 0.3), or [−z / −x end, +z / +x end]. */
  overhang?: number | { eave?: number; gable?: number | readonly [number, number] };
  /** Slab thickness (default 0.14). */
  thickness?: number;
  covering?: Covering;
  /** Seam spacing (default 0.9 m — the sheets' "broad seams"). */
  seamPitch?: number;
  ridgeCap?: boolean;
  /** Thick cream boards on the gable ends with a round-topped boss over
   * their mitre at the apex (default true); `depth` across the slope
   * (default slab + 0.3 = 0.44), `thickness` along the ridge (default 0.3). */
  bargeboards?: boolean | { depth?: number; thickness?: number };
  /** Cream fascia boards along the two eaves (default false: the sheets'
   * cottages show the roof's own edge there). */
  eaveBoards?: boolean;
  paint?: Paint;
  trimPaint?: Paint;
  soffit?: Paint;
}

/** Radius of a gable roof's ridge roll. */
const RIDGE_ROLL = 0.1;

/**
 * The numbers of a gable roof WITHOUT building it — the same `RoofInfo`
 * `gableRoof` returns, for an asset's `colliders()` (which must follow the
 * slopes but has no mesh at hand).
 *   const roof = gableRoofInfo({ span: 6, length: 5, eave: 2.8, top: 5.35 });
 *   roof.heightAt(2.3, 0)   // roof surface 2.3 m off the ridge
 */
export function gableRoofInfo(o: GableRoofOptions): RoofInfo {
  const half = o.span / 2;
  const t = o.thickness ?? 0.14;
  // What stands above the slab's own apex: the apex boss, else the ridge roll.
  const crown = (o.bargeboards ?? true) ? BOSS_CROWN : (o.ridgeCap ?? true) ? RIDGE_ROLL - 0.03 : 0;
  let rise = o.rise ?? 0;
  if (o.rise === undefined) {
    if (o.top === undefined) throw new Error('gableRoof: give rise or top');
    rise = Math.max(0.05, o.top - o.eave - t - crown);
    for (let i = 0; i < 12; i++) rise = Math.max(0.05, o.top - o.eave - crown - (t * Math.hypot(half, rise)) / half);
  }
  const tan = rise / half;
  const pitch = Math.atan2(rise, half) / RAD;
  const apex = o.eave + rise + (t * Math.hypot(half, rise)) / half;
  const alongX = o.ridge === 'x';
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const across = (x: number, z: number): number => (alongX ? z - cz : x - cx);
  return {
    top: apex + crown,
    rise,
    pitch,
    heightAt: (x, z) => apex - Math.abs(across(x, z)) * tan,
    tiltAt: (x, z) => {
      const s = Math.sign(across(x, z)) || 1;
      return alongX ? [pitch * s, 0, 0] : [0, 0, -pitch * s];
    },
  };
}

/**
 * Gable roof: a mitred slab with overhangs, standing seams, ridge roll,
 * bargeboards and apex blocks.
 *   const roof = gableRoof(m, { span: 6, length: 5, eave: 2.8, top: 4.5 }, P);
 *   wallBox(m, { …, top: 2.8, gable: { ridge: 'z', rise: roof.rise } }, P.wall);
 */
export function gableRoof(m: SolidMesh, o: GableRoofOptions, P: BuildingPaints): RoofInfo {
  const start = m.mark();
  const info = gableRoofInfo(o);
  const half = o.span / 2;
  const t = o.thickness ?? 0.14;
  const boards = o.bargeboards ?? true;
  const ridgeCap = o.ridgeCap ?? true;
  const capR = RIDGE_ROLL;
  const rise = info.rise;
  const pitch = info.pitch;
  const len = Math.hypot(half, rise);
  const c = half / len;
  const sn = rise / len;
  const tan = rise / half;
  const oh = o.overhang;
  const oe = typeof oh === 'number' ? oh : (oh?.eave ?? 0.3);
  const og = typeof oh === 'number' ? oh : (oh?.gable ?? 0.3);
  const [ogA, ogB] = typeof og === 'number' ? [og, og] : og;
  const bd = (typeof boards === 'object' ? boards.depth : undefined) ?? t + 0.3;
  const bt = (typeof boards === 'object' ? boards.thickness : undefined) ?? 0.3;
  const lap = 0.07;
  const roofPaint = soften(o.paint ?? P.roof, 45);
  const trim = o.trimPaint ?? P.trim;
  const soffit = o.soffit ?? P.timberDark;

  // Cross-section, right-hand slope: dir runs down the slope, n is its normal.
  const apexB: Vec2 = [0, o.eave + rise];
  const apexT: Vec2 = [0, o.eave + rise + t / c];
  const Eb: Vec2 = [half + oe, o.eave - oe * tan];
  const Et: Vec2 = [Eb[0] + t * sn, Eb[1] + t * c];
  const ch = Math.min(t * 0.3, 0.05);
  const right: Vec2[] = [
    [Eb[0] - c * ch, Eb[1] + sn * ch],
    [Eb[0] + sn * ch, Eb[1] + c * ch],
    [Et[0] - sn * ch, Et[1] - c * ch],
    [Et[0] - c * ch, Et[1] + sn * ch],
  ];
  // An extra station on each top line, just clear of the ridge roll, and
  // columns along the ridge below: baked AO lives on vertices, and a slope
  // that is one quad from the buried ridge to the eave (and from one
  // bargeboard to the other) fades to grey over its whole area.
  const topEnd = right[3];
  const slopeLen = Math.hypot(topEnd[0], apexT[1] - topEnd[1]);
  const onTop = (d: number): Vec2 => [d * c, apexT[1] - d * sn];
  const clear = Math.min(0.34, slopeLen * 0.2);
  const mirror = (pts: readonly Vec2[]): Vec2[] => pts.map(([x, y]): Vec2 => [-x, y]).reverse();
  const outline: Vec2[] = [apexB, ...right, onTop(clear), apexT, [-onTop(clear)[0], onTop(clear)[1]], ...mirror(right)];
  // The slab stops a little short of the bargeboards' outer faces.
  const zOutA = -o.length / 2 - ogA;
  const zOutB = o.length / 2 + ogB;
  const zA = boards ? zOutA + bt - lap : zOutA;
  const zB = boards ? zOutB - bt + lap : zOutB;
  const slab = m.mark();
  const steps: number[] = [];
  const inner = zB - zA - 2 * END_CLEAR;
  if (inner > 0.4) {
    const n = Math.ceil(inner / 2.7);
    steps.push(END_CLEAR, ...Array.from({ length: n }, () => inner / n), END_CLEAR);
  } else {
    steps.push(zB - zA);
  }
  // Each piece starts at the very number the last one ended on (z + depth,
  // not a station list recomputed another way): a last-bit difference between
  // the two rings of a joint is a hairline of sky along it.
  let z = zA;
  steps.forEach((depth, i) => {
    extrudePolygon(m, { outline, depth, at: [0, 0, z], back: i === 0, front: i + 1 === steps.length }, roofPaint);
    z = depth + z;
  });
  // Only the two underside planes — the eave noses stay roof-coloured.
  m.repaint((_c, n) => (n.y < 0 && Math.abs(n.y + c) < 0.04 && Math.abs(Math.abs(n.x) - sn) < 0.04 ? soffit : undefined), slab);

  // Covering.
  const covering = o.covering ?? 'seams';
  const z0 = boards ? zOutA + bt : zA;
  const z1 = boards ? zOutB - bt : zB;
  for (const s of [1, -1]) {
    const nrm = V(s * sn, c, 0);
    if (covering === 'seams') {
      const count = Math.max(1, Math.round((z1 - z0) / (o.seamPitch ?? 0.9)));
      for (let i = 0; i < count; i++) {
        const z = z0 + ((i + 0.5) / count) * (z1 - z0);
        rib(m, V(s * 0.06 * c, apexT[1] - 0.06 * sn, z), V(s * topEnd[0], topEnd[1], z), nrm, { ...SEAM, breakAt: clear - 0.06 }, roofPaint);
      }
    } else if (covering === 'tiles') {
      const at = (d: number, h: number, z: number): Vector3 => V(s * (d * c + h * sn), apexT[1] - d * sn + h * c, z);
      tileRows(m, slopeLen, zA + 0.01, zB - 0.01, at, nrm, roofPaint);
    }
  }
  if (ridgeCap) cylinder(m, { from: [0, apexT[1] - 0.03, zA + 0.03], to: [0, apexT[1] - 0.03, zB - 0.03], radius: capR, sides: 8 }, roofPaint);

  if (boards) {
    // Proud of the seams (5.5 cm), so no roof colour shows over the boards
    // in the front elevation.
    const lift = 0.065;
    const s1 = Et[0] / c + 0.1;
    const mid = s1 / 2;
    for (const zc of [zOutA + bt / 2, zOutB - bt / 2]) {
      for (const s of [1, -1]) {
        // Centre of the board: half-way down the slope, hung so that its top
        // stands `lift` above the roof surface.
        const x = mid * c + (lift - bd / 2) * sn;
        const y = apexT[1] - mid * sn + (lift - bd / 2) * c;
        roundedBox(m, { size: [s1, bd, bt], radius: Math.min(0.07, bt * 0.35), segments: 2, rot: [0, 0, -pitch * s], at: [s * x, y, zc] }, trim);
      }
      // Apex boss: the sheets' round-topped block over the mitre — a half
      // ellipse above, a V below that follows the boards. Thicker than the
      // boards, so it stands proud of them front and back.
      const rx = bd * 0.88;
      const ry = rx * 0.82;
      const boss: Vec2[] = [];
      for (let i = 0; i <= 12; i++) boss.push([rx * Math.cos((i * Math.PI) / 12), ry * Math.sin((i * Math.PI) / 12)]);
      boss.push([-rx, -0.07], [0, -0.07 - rx * tan], [rx, -0.07]);
      extrudePolygon(m, { outline: boss, depth: bt + 0.1, centered: true, bevel: 0.06, bevelSegments: 2, bevelBack: true, at: [0, apexT[1] + BOSS_CROWN - ry, zc] }, soften(trim, 46));
    }
  }
  if (o.eaveBoards) {
    for (const s of [1, -1]) {
      roundedBox(
        m,
        { size: [0.12, t + 0.14, zB - zA - 0.02], radius: 0.04, segments: 1, rot: [0, 0, -pitch * s], at: [s * (Eb[0] + sn * (t / 2 - 0.03) + c * 0.02), Eb[1] + c * (t / 2 - 0.03) - sn * 0.02, (zA + zB) / 2] },
        trim,
      );
    }
  }

  m.transform(compose(rotation('y', o.ridge === 'x' ? 90 : 0), translation(o.cx ?? 0, 0, o.cz ?? 0)), start);
  return info;
}

// ---------------------------------------------------------------------------
// Shed (mono-pitch) roof

export interface ShedRoofOptions {
  /** Body size in x and z. */
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  /** Wall-top heights at the low and the high wall. */
  low: number;
  high: number;
  /** Direction the roof falls (toward the LOW wall). */
  fall: '+x' | '-x' | '+z' | '-z';
  /** Horizontal overhangs (default 0.3 everywhere). */
  overhang?: number | { low?: number; high?: number; sides?: number };
  thickness?: number;
  covering?: Covering;
  seamPitch?: number;
  /** Cream boards down the two raking edges (default false). */
  edgeBoards?: boolean;
  paint?: Paint;
  trimPaint?: Paint;
  soffit?: Paint;
}

/**
 * Mono-pitch roof: one thick slab with rounded noses, seams running with
 * the fall. Side walls under it: `wallPanel({ top: [leftHeight, rightHeight] })`.
 *   shedRoof(m, { width: 5, depth: 4, low: 2.6, high: 3.4, fall: '+x' }, P);
 */
export function shedRoof(m: SolidMesh, o: ShedRoofOptions, P: BuildingPaints): RoofInfo {
  const start = m.mark();
  const alongX = o.fall === '+x' || o.fall === '-x';
  const S = alongX ? o.width : o.depth;
  const C = alongX ? o.depth : o.width;
  const t = o.thickness ?? 0.16;
  const rise = o.high - o.low;
  const len = Math.hypot(S, rise);
  const c = S / len;
  const sn = rise / len;
  const tan = rise / S;
  const pitch = Math.atan2(rise, S) / RAD;
  const oh = o.overhang;
  const oLow = typeof oh === 'number' ? oh : (oh?.low ?? 0.3);
  const oHigh = typeof oh === 'number' ? oh : (oh?.high ?? 0.3);
  const oSide = typeof oh === 'number' ? oh : (oh?.sides ?? 0.3);
  const roofPaint = soften(o.paint ?? P.roof, 45);
  const soffit = o.soffit ?? o.paint ?? P.roof;
  // Canonical: falls toward +x.
  const Lb: Vec2 = [S / 2 + oLow, o.low - oLow * tan];
  const Hb: Vec2 = [-S / 2 - oHigh, o.high + oHigh * tan];
  const Lt: Vec2 = [Lb[0] + t * sn, Lb[1] + t * c];
  const Ht: Vec2 = [Hb[0] + t * sn, Hb[1] + t * c];
  const ch = Math.min(t * 0.3, 0.05);
  const outline: Vec2[] = [
    [Hb[0] + c * ch, Hb[1] - sn * ch],
    [Lb[0] - c * ch, Lb[1] + sn * ch],
    [Lb[0] + sn * ch, Lb[1] + c * ch],
    [Lt[0] - sn * ch, Lt[1] - c * ch],
    [Lt[0] - c * ch, Lt[1] + sn * ch],
    [Ht[0] + c * ch, Ht[1] - sn * ch],
    [Ht[0] - sn * ch, Ht[1] - c * ch],
    [Hb[0] + sn * ch, Hb[1] + c * ch],
  ];
  const bt = 0.18;
  const lap = 0.06;
  const zOut = C / 2 + oSide;
  const zEnd = o.edgeBoards ? zOut - bt + lap : zOut;
  const slab = m.mark();
  extrudePolygon(m, { outline, depth: zEnd * 2, bevel: o.edgeBoards ? 0 : 0.03, bevelBack: true, at: [0, 0, -zEnd] }, roofPaint);
  m.repaint((_c, n) => (n.y < 0 && Math.abs(n.y + c) < 0.04 && Math.abs(n.x + sn) < 0.04 ? soffit : undefined), slab);
  const nrm = V(sn, c, 0);
  const hi = outline[5];
  const lo = outline[4];
  const covering = o.covering ?? 'seams';
  const zIn = o.edgeBoards ? zOut - bt : zEnd - 0.04;
  if (covering === 'seams') {
    const count = Math.max(1, Math.round((zIn * 2) / (o.seamPitch ?? 0.78)));
    for (let i = 0; i < count; i++) {
      const z = -zIn + ((i + 0.5) / count) * zIn * 2;
      rib(m, V(hi[0], hi[1], z), V(lo[0], lo[1], z), nrm, { ...SEAM, capStart: true }, roofPaint);
    }
  } else if (covering === 'tiles') {
    const at = (d: number, h: number, z: number): Vector3 => V(hi[0] + d * c + h * sn, hi[1] - d * sn + h * c, z);
    tileRows(m, Math.hypot(lo[0] - hi[0], lo[1] - hi[1]), -zIn, zIn, at, nrm, roofPaint);
  }
  if (o.edgeBoards) {
    const bd = t + 0.16;
    const lift = 0.04;
    const s0 = -0.08;
    const s1 = (Lt[0] - Ht[0]) / c + 0.08;
    const mid = (s0 + s1) / 2;
    for (const zc of [-zOut + bt / 2, zOut - bt / 2]) {
      roundedBox(
        m,
        { size: [s1 - s0, bd, bt], radius: Math.min(0.06, bt * 0.35), segments: 2, rot: [0, 0, -pitch], at: [Ht[0] + mid * c + (lift - bd / 2) * sn, Ht[1] - mid * sn + (lift - bd / 2) * c, zc] },
        o.trimPaint ?? P.trim,
      );
    }
  }
  const turn = o.fall === '+x' ? 0 : o.fall === '-x' ? 180 : o.fall === '+z' ? -90 : 90;
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  m.transform(compose(rotation('y', turn), translation(cx, 0, cz)), start);
  const sign = o.fall === '+x' || o.fall === '+z' ? 1 : -1;
  const along = (x: number, z: number): number => sign * (alongX ? x - cx : z - cz);
  return {
    top: Ht[1] + (o.edgeBoards ? 0.05 : 0),
    rise,
    pitch,
    heightAt: (x, z) => (o.high + o.low) / 2 - along(x, z) * tan + t / c,
    tiltAt: () => (alongX ? [0, 0, -pitch * sign] : [pitch * sign, 0, 0]),
  };
}

// ---------------------------------------------------------------------------
// Hip / pyramid roof

export interface HipRoofOptions {
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  /** Wall top. */
  eave: number;
  /** Give ONE of: `rise` of the ridge above the eave line, or `top` = the
   * finished height including the finial. */
  rise?: number;
  top?: number;
  overhang?: number;
  /** Height of the roof's edge band (default 0.16). */
  thickness?: number;
  /** Ridge length along the longer side. Default = the difference between
   * the sides (equal pitch all round); 0 = a pyramid. */
  ridgeLength?: number;
  covering?: 'seams' | 'plain';
  seamPitch?: number;
  /** Round rolls down the hips and along the ridge (default true). */
  hipCaps?: boolean;
  /** Block on the apex (default: on a pyramid, `ridgeLength` under 0.3 m;
   * a longer ridge gets its roll instead). */
  finial?: boolean | { size?: number; height?: number; paint?: Paint };
  paint?: Paint;
  /** Paint of the hip / ridge rolls (default the roof's). */
  capPaint?: Paint;
  /** Paint of the edge band (default the roof's; cream = a built-in fascia). */
  edgePaint?: Paint;
  soffit?: Paint;
}

/**
 * Hipped or pyramid roof: closed solid with an edge band, seams on every
 * face running with the fall, hip rolls and an apex block.
 *   hipRoof(m, { width: 5, depth: 4, eave: 5.4, top: 6.5, capPaint: P.roof }, P);
 */
export function hipRoof(m: SolidMesh, o: HipRoofOptions, P: BuildingPaints): RoofInfo {
  const start = m.mark();
  const ov = o.overhang ?? 0.3;
  const t = o.thickness ?? 0.16;
  // Canonical: the longer side (and the ridge) along x.
  const swap = o.depth > o.width;
  const W = swap ? o.depth : o.width;
  const D = swap ? o.width : o.depth;
  const a = W / 2 + ov;
  const b = D / 2 + ov;
  const rl = Math.max(0, Math.min((o.ridgeLength ?? W - D) / 2, a - 0.25));
  const fin = o.finial ?? rl < 0.15;
  const finH = fin ? ((typeof fin === 'object' ? fin.height : undefined) ?? 0.2) : 0;
  const finS = (typeof fin === 'object' ? fin.size : undefined) ?? 0.5;
  const finL = Math.max(finS, rl * 2 + 0.3); // long enough to sit over a short ridge
  const hipCaps = o.hipCaps ?? true;
  const crown = fin ? finH * 0.75 : hipCaps ? 0.06 : 0;
  const y0 = o.eave - 0.03;
  const y1 = y0 + t;
  const yR = o.rise !== undefined ? o.eave + o.rise : (o.top ?? o.eave + 1) - crown;
  const roofPaint = o.paint ?? P.roof;
  const capPaint = o.capPaint ?? roofPaint;
  const corner = (sx: number, sz: number, y = y1): Vector3 => V(sx * a, y, sz * b);
  const R = (sx: number): Vector3 => V(sx * rl, yR, 0);

  const faces: { eave: [Vector3, Vector3]; top: [Vector3, Vector3]; out: Vector3 }[] = [];
  for (const sz of [1, -1]) faces.push({ eave: [corner(-1, sz), corner(1, sz)], top: [R(-1), R(1)], out: V(0, 0.6, sz) });
  for (const sx of [1, -1]) faces.push({ eave: [corner(sx, -1), corner(sx, 1)], top: [R(sx), R(sx)], out: V(sx, 0.6, 0) });
  const pitchRow = o.seamPitch ?? 0.78;
  for (const f of faces) {
    const [p0, p1] = f.eave;
    const [q0, q1] = f.top;
    const pts = Vector3.DistanceSquared(q0, q1) < 1e-10 ? [p0, p1, q0] : [p0, p1, q1, q0];
    polygonFacing(m, pts, f.out, roofPaint);
    if ((o.covering ?? 'seams') !== 'seams') continue;
    const e = p1.subtract(p0);
    const Le = e.length();
    e.scaleInPlace(1 / Le);
    let nrm = Vector3.Cross(e, q0.subtract(p0)).normalize();
    if (nrm.y < 0) nrm = nrm.scale(-1);
    let g = Vector3.Cross(nrm, e).normalize();
    if (g.y < 0) g = g.scale(-1);
    const H = Vector3.Dot(q0.subtract(p0), g);
    const u0 = Vector3.Dot(q0.subtract(p0), e);
    const u1 = Vector3.Dot(q1.subtract(p0), e);
    const count = Math.max(1, Math.round(Le / pitchRow));
    for (let i = 0; i < count; i++) {
      const u = ((i + 0.5) / count) * Le;
      const vmax = u < u0 ? (H * u) / u0 : u > u1 ? (H * (Le - u)) / (Le - u1) : H;
      if (vmax < 0.3) continue;
      const foot = p0.add(e.scale(u));
      rib(m, foot.add(g.scale(vmax - 0.04)), foot.add(g.scale(0.02)), nrm, SEAM, roofPaint);
    }
  }
  // Edge band and closed underside.
  const edge = o.edgePaint ?? roofPaint;
  const ring: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = ring[k];
    const [bx, bz] = ring[(k + 1) % 4];
    quadFacing(m, corner(ax, az, y0), corner(bx, bz, y0), corner(bx, bz, y1), corner(ax, az, y1), V(ax + bx, 0, az + bz), edge);
  }
  polygonFacing(m, ring.map(([sx, sz]) => corner(sx, sz, y0)), V(0, -1, 0), o.soffit ?? edge);
  if (hipCaps) {
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        const from = corner(sx, sz).add(V(-sx * 0.04, 0.01, -sz * 0.04));
        cylinder(m, { from, to: R(sx), radius: 0.075, sides: 6 }, capPaint);
      }
    }
    if (rl > 0.01) cylinder(m, { from: R(-1).add(V(-0.05, 0, 0)), to: R(1).add(V(0.05, 0, 0)), radius: 0.085, sides: 8 }, capPaint);
  }
  if (fin) {
    const fp = (typeof fin === 'object' ? fin.paint : undefined) ?? P.trim;
    roundedBox(m, { size: [finL, finH * 1.5, finS], radius: Math.min(0.07, finH * 0.4), segments: 2, at: [0, yR, 0] }, fp);
  }
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  m.transform(compose(rotation('y', swap ? 90 : 0), translation(cx, 0, cz)), start);
  const slopeZ = (yR - y1) / b;
  const slopeX = (yR - y1) / Math.max(1e-6, a - rl);
  // Model (x, z) → canonical distances along the ridge axis (X) and across it (Z).
  const canon = (x: number, z: number): [number, number] => (swap ? [z - cz, x - cx] : [x - cx, z - cz]);
  return {
    top: yR + crown,
    rise: yR - o.eave,
    pitch: Math.atan(slopeZ) / RAD,
    heightAt: (x, z) => {
      const [X, Z] = canon(x, z);
      return Math.min(yR, y1 + (b - Math.abs(Z)) * slopeZ, y1 + (a - Math.abs(X)) * slopeX);
    },
    tiltAt: (x, z) => {
      const [X, Z] = canon(x, z);
      const onZ = (b - Math.abs(Z)) * slopeZ < (a - Math.abs(X)) * slopeX;
      const deg = Math.atan(onZ ? slopeZ : slopeX) / RAD;
      // Which MODEL axis the face falls along.
      const fallsAlongModelZ = onZ !== swap;
      const s = Math.sign(fallsAlongModelZ ? z - cz : x - cx) || 1;
      return fallsAlongModelZ ? [deg * s, 0, 0] : [0, 0, -deg * s];
    },
  };
}

// ---------------------------------------------------------------------------
// Flat roof with parapet

export interface FlatRoofOptions {
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  /** Height of the walkable deck. */
  deck: number;
  /** Top of the parapet (default deck + 0.5). */
  parapetTop?: number;
  /** Parapet thickness (default 0.4) and how far it stands out past the
   * wall faces (default 0.12 — the sheets' fat cream band). What is left
   * (0.28) must cover the wall thickness: the walls lap 2 cm up into the
   * roof, and anything the parapet does not cover shows on the deck. */
  thickness?: number;
  proud?: number;
  /** How far the band hangs below the deck over the wall top (default 0.25). */
  drop?: number;
  /** Plan corner radius, matching `wallBox({ cornerRadius })`. */
  cornerRadius?: number;
  paint?: Paint;
  deckPaint?: Paint;
}

/**
 * Flat roof deck inside a fat rounded parapet band (B05). Returns a RoofInfo
 * whose `heightAt` is the deck — stand pergolas, panels and railings on it.
 */
export function flatRoof(m: SolidMesh, o: FlatRoofOptions, P: BuildingPaints): RoofInfo {
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const top = o.parapetTop ?? o.deck + 0.5;
  const thick = o.thickness ?? 0.4;
  const proud = o.proud ?? 0.12;
  const drop = o.drop ?? 0.25;
  const off = proud - thick / 2;
  const w = o.width + off * 2;
  const d = o.depth + off * 2;
  const cr = o.cornerRadius ? Math.max(0, o.cornerRadius + off) : 0;
  const ring = cr > 0.02 ? roundedRectRing(w, d, cr, 3) : ([[w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2], [w / 2, -d / 2]] as Vec2[]);
  const h = top - (o.deck - drop);
  const yc = (top + o.deck - drop) / 2;
  sweep(
    m,
    { path: ring.map(([x, z]) => V(cx + x, yc, cz + z)), closed: true, section: chamferRing(h, thick, Math.min(thick, h) * 0.24), up: [0, 1, 0] },
    soften(o.paint ?? P.trim, 45),
  );
  // Deck: a plate reaching under the parapet.
  const dw = o.width - 0.1;
  const dd = o.depth - 0.1;
  const deckRing = cr > 0.02 ? roundedRectRing(dw, dd, Math.max(0.02, (o.cornerRadius ?? 0) - 0.05), 3) : ([[dw / 2, dd / 2], [-dw / 2, dd / 2], [-dw / 2, -dd / 2], [dw / 2, -dd / 2]] as Vec2[]);
  extrudePolygon(m, { outline: deckRing, depth: 0.06, back: false, facing: '+y', at: [cx, o.deck - 0.06, cz] }, o.deckPaint ?? paint(shade(BUILDING.cream, 0.86), { gloss: 0.15 }));
  return { top, rise: 0, pitch: 0, heightAt: () => o.deck, tiltAt: () => [0, 0, 0] };
}

// ---------------------------------------------------------------------------
// Chimney, solar panel, door canopy

export interface ChimneyOptions {
  /** Plan position (x, z) of the stack's centre. */
  at: readonly [number, number];
  /** The roof it stands on. */
  roof: RoofInfo;
  /** Height of the stack above the roof surface at its centre (default 1.0). */
  height?: number;
  /** Stack section (default 0.8 — the sheets' chimneys are stout). */
  size?: number | readonly [number, number];
  /** Recessed vent slot under the cap, on the face toward −z (front) / the
   * given facing (default '-z'; false = none). */
  vent?: '-z' | '+z' | '+x' | '-x' | false;
  /** Sloped collar where the stack meets the roof (default true). */
  flashing?: boolean;
  paint?: Paint;
  capPaint?: Paint;
}

const VENT_SLAT = paint('#6E7480', { gloss: 0.2 });

/** Stout plastered stack with a wide pillowy cap, a dark recessed vent slot
 * with two grey slats, and a chunky collar lying on the roof slope. */
export function chimney(m: SolidMesh, o: ChimneyOptions, P: BuildingPaints): void {
  const [x, z] = o.at;
  const [sx, sz] = typeof o.size === 'number' ? [o.size, o.size] : (o.size ?? [0.8, 0.8]);
  const yRoof = o.roof.heightAt(x, z);
  const top = yRoof + (o.height ?? 1.0);
  const stack = o.paint ?? P.trim;
  const capPaint = o.capPaint ?? P.roof;
  const vent = o.vent ?? '-z';
  const r = 0.065;
  const y0 = yRoof - 0.5;
  const y1 = top - 0.08;
  const ventFace = vent === '-z' ? 'nz' : vent === '+z' ? 'pz' : vent === '+x' ? 'px' : vent === '-x' ? 'nx' : undefined;
  roundedBox(
    m,
    { min: [x - sx / 2, y0, z - sz / 2], max: [x + sx / 2, y1, z + sz / 2], radius: r, segments: 2, faces: { ny: null, ...(ventFace ? { [ventFace]: null } : {}) } },
    stack,
  );
  const over = 0.11;
  roundedBox(m, { min: [x - sx / 2 - over, top - 0.3, z - sz / 2 - over], max: [x + sx / 2 + over, top, z + sz / 2 + over], radius: 0.12, segments: 3 }, capPaint);
  if (o.flashing ?? true) {
    // Tall enough that the roof seams run INTO its upslope and downslope
    // faces rather than out through a chamfer.
    roundedBox(m, { size: [sx + 0.22, 0.24, sz + 0.22], radius: 0.06, segments: 1, rot: o.roof.tiltAt(x, z), at: [x, yRoof + 0.03, z] }, capPaint);
  }
  if (vent && ventFace) {
    // The vent face is rebuilt as a frame of cells round a real recess.
    const start = m.mark();
    const f: Facade =
      vent === '-z' ? { facing: '-z', plane: sz / 2 - z, center: x }
      : vent === '+z' ? { facing: '+z', plane: sz / 2 + z, center: x }
      : vent === '+x' ? { facing: '+x', plane: sx / 2 + x, center: z }
      : { facing: '-x', plane: sx / 2 - x, center: z };
    const fw = vent === '-z' || vent === '+z' ? sx : sz;
    const us = [-fw / 2 + r, -fw * 0.26, fw * 0.26, fw / 2 - r];
    const vs = [y0 + r, top - 0.62, top - 0.44, y1 - r];
    const front = V(0, 0, 1);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 1 && j === 1) continue;
        quadFacing(m, V(us[i], vs[j], 0), V(us[i + 1], vs[j], 0), V(us[i + 1], vs[j + 1], 0), V(us[i], vs[j + 1], 0), front, stack);
      }
    }
    const depth = 0.09;
    const [l, rr, b, tp] = [us[1], us[2], vs[1], vs[2]];
    quadFacing(m, V(l, b, 0), V(rr, b, 0), V(rr, b, -depth), V(l, b, -depth), V(0, 1, 0), P.iron);
    quadFacing(m, V(l, tp, 0), V(rr, tp, 0), V(rr, tp, -depth), V(l, tp, -depth), V(0, -1, 0), P.iron);
    quadFacing(m, V(l, b, 0), V(l, tp, 0), V(l, tp, -depth), V(l, b, -depth), V(1, 0, 0), P.iron);
    quadFacing(m, V(rr, b, 0), V(rr, tp, 0), V(rr, tp, -depth), V(rr, b, -depth), V(-1, 0, 0), P.iron);
    quadFacing(m, V(l, b, -depth), V(rr, b, -depth), V(rr, tp, -depth), V(l, tp, -depth), front, P.iron);
    // Two subdued slats, set back in the slot: a bright bar reads as a minus
    // sign on the stack from across the village.
    for (const f of [0.3, 0.7]) {
      const mid = b + (tp - b) * f;
      box(m, { min: [l - 0.01, mid - 0.016, -depth], max: [rr + 0.01, mid + 0.016, -0.03], faces: { nz: null, px: null, nx: null } }, VENT_SLAT);
    }
    toFacade(m, start, f);
  }
}

export interface SolarPanelOptions {
  /** Centre of the panel's underside. */
  at: readonly [number, number, number];
  /** Long side × short side (default S01: 1.2 × 0.8 m). */
  size?: readonly [number, number];
  /** Orientation: `roof.tiltAt(x, z)` to lie on a slope. */
  rot?: readonly [number, number, number];
  /** Cells along the long and the short side (default 4 × 3). */
  cells?: readonly [number, number];
  /** On a flat roof: prop the panel up by this many degrees on a wedge
   * stand, facing −z before `rot` is applied. */
  tilt?: number;
}

/** Small roof solar panel: pale frame, dark-blue glossy cells with bevelled
 * edges (never emissive). Lies on a slope via `rot`, or stands on a wedge. */
export function solarPanel(m: SolidMesh, o: SolarPanelOptions, P: BuildingPaints): void {
  const start = m.mark();
  const [w, d] = o.size ?? [1.2, 0.8];
  const [cols, rows] = o.cells ?? [4, 3];
  const th = 0.07;
  const framePaint = paint(BUILDING.roofMetal, { color: shade(BUILDING.cream, 0.95), gloss: 0.4 });
  // Built facing local +y, long side along x.
  roundedBox(m, { min: [-w / 2, 0, -d / 2], max: [w / 2, th, d / 2], radius: 0.025, segments: 1 }, framePaint);
  const margin = 0.06;
  const gap = 0.025;
  const cw = (w - margin * 2 + gap) / cols;
  const cd = (d - margin * 2 + gap) / rows;
  const bev = 0.012;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x0 = -w / 2 + margin + i * cw;
      const z0 = -d / 2 + margin + j * cd;
      const x1 = x0 + cw - gap;
      const z1 = z0 + cd - gap;
      const lo = [V(x0, th - 0.003, z0), V(x1, th - 0.003, z0), V(x1, th - 0.003, z1), V(x0, th - 0.003, z1)];
      const hi = [V(x0 + bev, th + bev, z0 + bev), V(x1 - bev, th + bev, z0 + bev), V(x1 - bev, th + bev, z1 - bev), V(x0 + bev, th + bev, z1 - bev)];
      quadFacing(m, hi[0], hi[1], hi[2], hi[3], V(0, 1, 0), P.solar);
      const out = [V(0, 1, -1), V(1, 1, 0), V(0, 1, 1), V(-1, 1, 0)];
      for (let k = 0; k < 4; k++) quadFacing(m, lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k], out[k], P.solar);
    }
  }
  if (o.tilt) {
    // Tip about the front (−z) edge, then slide a wedge under it.
    m.rotate('x', -o.tilt, start, [0, 0, -d / 2]);
    const rise = Math.sin(o.tilt * RAD) * d;
    const run = Math.cos(o.tilt * RAD) * d;
    extrudePolygon(
      m,
      { outline: [[0.02, -0.02], [run - 0.02, -0.02], [run - 0.02, rise - 0.03]], depth: w * 0.84, centered: true, bevel: 0.015, bevelBack: true, at: frame([0, 0, -d / 2], [0, 0, 1], [0, 1, 0], [1, 0, 0]) },
      P.iron,
    );
    m.translate([0, 0.02, 0], start);
  }
  const r = o.rot ?? [0, 0, 0];
  m.transform(compose(rotation('x', r[0]), rotation('y', r[1]), rotation('z', r[2]), translation(o.at[0], o.at[1], o.at[2])), start);
}

export interface BracketOptions {
  on: Facade;
  /** Position of the bracket's top inside corner on the wall. */
  u: number;
  v: number;
  /** How far it reaches out of the wall and down it. */
  projection: number;
  drop: number;
  /** Width along the wall (default 0.14). */
  thickness?: number;
  /** A bearing block on top, a little wider than the bracket (the sheets'
   * canopy corbels have one). It is part of `drop`. Default false. */
  cap?: boolean;
}

/**
 * A solid curved bracket: flat top, concave underside — the sheets' chunky
 * supports under canopies, awnings and balconies.
 */
export function bracket(m: SolidMesh, o: BracketOptions, p: Paint): void {
  const start = m.mark();
  const pr = o.projection;
  const th = o.thickness ?? 0.14;
  const capH = o.cap ? Math.min(0.08, o.drop * 0.2) : 0;
  const dr = o.drop - capH;
  const nose = Math.min(0.11, dr * 0.3);
  const foot = Math.min(0.11, pr * 0.3);
  // Side view: x = out of the wall, y = up. Concave quarter-ellipse between
  // the nose under the tip and the foot on the wall.
  const outline: Vec2[] = [[-0.05, 0], [pr, 0], [pr, -nose]];
  const steps = 4;
  for (let i = 1; i < steps; i++) {
    const a = (i / steps) * 90 * RAD;
    outline.push([pr - (pr - foot) * Math.sin(a), -dr + (dr - nose) * Math.cos(a)]);
  }
  outline.push([foot, -dr], [-0.05, -dr]);
  const side = (y: number): ReturnType<typeof frame> => frame([o.u, o.v + y, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0]);
  extrudePolygon(m, { outline, depth: th, centered: true, bevel: Math.min(0.02, th * 0.2), bevelBack: true, at: side(-capH) }, p);
  if (capH > 0) {
    // Sunk 1 cm into the bracket's top so the two never share a plane.
    extrudePolygon(m, { outline: [[-0.05, -capH - 0.01], [pr + 0.03, -capH - 0.01], [pr + 0.03, 0], [-0.05, 0]], depth: th + 0.07, centered: true, bevel: 0.015, bevelBack: true, at: side(0) }, p);
  }
  toFacade(m, start, o.on);
}

export interface CanopyOptions {
  on: Facade;
  /** Centre along the wall and height of the canopy's top edge at the wall. */
  u: number;
  v: number;
  width: number;
  /** How far it reaches out and how far the front edge drops. */
  projection?: number;
  drop?: number;
  thickness?: number;
  /** Standing seams between the side boards (default 3). */
  seams?: number;
  /** Thick cream boards down both sides (default true) and their width
   * along the wall (default 0.27). */
  sideBoards?: boolean;
  boardWidth?: number;
  /** Curved timber brackets under both ends (default true), how far they
   * reach down the wall (default 0.6) and their width (default 0.24). */
  brackets?: boolean;
  bracketDrop?: number;
  bracketWidth?: number;
  paint?: Paint;
}

/**
 * The little pent roof over a door (B04's front canopy): seamed slab,
 * cream side boards, timber brackets.
 *   canopy(m, { on: F.front, u: 0, v: 3.1, width: 2.3 }, P);
 */
export function canopy(m: SolidMesh, o: CanopyOptions, P: BuildingPaints): void {
  const start = m.mark();
  const pr = o.projection ?? 0.8;
  const drop = o.drop ?? 0.5;
  const t = o.thickness ?? 0.12;
  const len = Math.hypot(pr, drop);
  const c = pr / len;
  const sn = drop / len;
  const pitch = Math.atan2(drop, pr) / RAD;
  const roofPaint = o.paint ?? P.roof;
  const sink = 0.1;
  // Slab axis: local z runs down the slope after a turn about x.
  const total = len + sink;
  const midS = (len - sink) / 2;
  const centre = (s: number, h: number): [number, number] => [o.v - s * sn + h * c, s * c + h * sn];
  const [my, mz] = centre(midS, -t / 2);
  const boards = o.sideBoards ?? true;
  const bw = o.boardWidth ?? 0.27;
  const slabW = boards ? o.width - bw : o.width;
  roundedBox(m, { size: [slabW, t, total], radius: Math.min(0.035, t * 0.4), segments: 1, rot: [pitch, 0, 0], at: [o.u, my, mz] }, roofPaint);
  const seams = o.seams ?? 3;
  const nrm = V(0, c, sn);
  const inner = slabW - (boards ? bw * 0.5 : 0.1);
  for (let i = 0; i < seams; i++) {
    const x = o.u - inner / 2 + ((i + 0.5) / seams) * inner;
    // Start a hand below the wall line: a seam that runs to the top edge
    // pokes a nub out against whatever is above the canopy.
    const a = centre(0.09, 0);
    const b = centre(len - 0.03, 0);
    rib(m, V(x, a[0], a[1]), V(x, b[0], b[1]), nrm, { width: 0.075, topWidth: 0.045, height: 0.045, capStart: true }, roofPaint);
  }
  if (boards) {
    const bd = t + 0.16;
    const [by, bz] = centre(midS + 0.04, 0.04 - bd / 2);
    for (const s of [1, -1]) {
      roundedBox(m, { size: [bw, bd, total + 0.1], radius: Math.min(0.09, bw * 0.34), segments: 3, rot: [pitch, 0, 0], at: [o.u + s * (o.width / 2 - bw / 2), by, bz] }, P.trim);
    }
  }
  toFacade(m, start, o.on);
  if (o.brackets ?? true) {
    const bwid = o.bracketWidth ?? 0.24;
    const bx = o.width / 2 - Math.max(bw, bwid) / 2 - 0.02;
    const tip = centre(len * 0.78, -t);
    for (const s of [1, -1]) bracket(m, { on: o.on, u: o.u + s * bx, v: tip[0] + 0.03, projection: tip[1], drop: o.bracketDrop ?? 0.6, thickness: bwid, cap: true }, P.timber);
  }
}
