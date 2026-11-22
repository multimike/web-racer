import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  box,
  compose,
  mixOklab,
  paint,
  polygonFacing,
  quadFacing,
  rng,
  roundedBox,
  roundedRectRing,
  scaling,
  shade,
  soften,
  sweep,
  translation,
  triFacing,
} from '../../../gfx/solid';
import type { Paint, RGB, SolidMesh, Vec2 } from '../../../gfx/solid';
import { STONE } from '../../palette';
import { boxFacades, toFacade } from './facade';
import type { BoxFacades, Facade } from './facade';
import type { BuildingPaints } from './paints';
import { beam, chamferRing, rib } from './shapes';

/**
 * Walls, plinth and structural timber.
 */

// ---------------------------------------------------------------------------
// Openings and wall panels

/**
 * A door or window opening in facade space. Declare it ONCE and hand the
 * same object to `wallPanel` / `wallBox` (which cuts the hole) and to
 * `windowUnit` / `door` (which fills it) — that is what keeps frames and
 * reveals lined up.
 */
export interface Opening {
  /** Centre, meters to the viewer's right of the facade centre. */
  u: number;
  /** Bottom edge (sill / threshold), meters above the ground. */
  v: number;
  /** Clear width and height. */
  w: number;
  h: number;
  /** Radius of the two TOP corners (0 = square; w / 2 = a round arch). */
  round?: number;
  /** Round the bottom corners too (the sheets' pill-shaped windows). */
  roundAll?: boolean;
}

/**
 * Outline of an opening in facade (u, v), grown outward by `grow` meters
 * (negative shrinks). `minRadius` rounds every corner that the opening
 * itself leaves square — for surrounds and frames, which are never sharp.
 * `uniform` = every corner gets exactly `cornerSegments` + 1 points, square
 * ones included (as coincident points): two rings of one opening made that
 * way match point for point, which is what `frameRing` needs.
 */
export function openingRing(o: Opening, grow = 0, minRadius = 0, cornerSegments?: number, uniform = false): Vec2[] {
  const w = o.w + grow * 2;
  const h = o.h + grow * 2;
  const cu = o.u;
  const cv = o.v + o.h / 2;
  const lim = Math.min(w, h) / 2;
  const own = o.round ? Math.max(0, o.round + grow) : 0;
  const top = Math.min(Math.max(own, minRadius), lim);
  const bottom = Math.min(Math.max(o.roundAll ? own : 0, minRadius), lim);
  const out: Vec2[] = [];
  // Corner at (x, y) whose arc starts at angle a0 (counter-clockwise ring).
  const corner = (x: number, y: number, a0: number, r: number): void => {
    if (r < 1e-6 && !uniform) {
      out.push([x, y]);
      return;
    }
    const sx = a0 === 0 || a0 === 270 ? 1 : -1;
    const sy = a0 === 0 || a0 === 90 ? 1 : -1;
    // One step per 9 cm of arc, at least two: small corner radii stay cheap,
    // the big ones (pill windows, arched doors) come out round. These rings
    // are the cream surrounds, seen edge on.
    const n = cornerSegments ?? Math.max(r > 0.1 ? 3 : 2, Math.ceil((r * Math.PI) / 2 / 0.09));
    for (let i = 0; i <= n; i++) {
      const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
      out.push([x - sx * r + Math.cos(a) * r, y - sy * r + Math.sin(a) * r]);
    }
  };
  corner(cu + w / 2, cv + h / 2, 0, top);
  corner(cu - w / 2, cv + h / 2, 90, top);
  corner(cu - w / 2, cv - h / 2, 180, bottom);
  corner(cu + w / 2, cv - h / 2, 270, bottom);
  return out;
}

/** Corner steps for a frame whose LARGEST corner radius is `r`: one per
 * 8.5 cm of arc, 2 – 6 (the 0.25 m corner of a door surround gets 5 — these
 * are the cream outlines the eye follows). */
export function frameSegments(r: number): number {
  return Math.max(2, Math.min(6, Math.round((r * Math.PI) / 2 / 0.085)));
}

export interface WallPanelOptions {
  on: Facade;
  /** Panel width and the u of its centre (default 0). */
  width: number;
  u?: number;
  /** Bottom edge — start it ~0.1 m BELOW the plinth top so the two overlap. */
  bottom: number;
  /** Top edge: one height, or [at the left end, at the right end] for the
   * side walls under a mono-pitch roof. */
  top: number | readonly [number, number];
  /** Gable peak above `top`: its rise, or { rise, peak: u of the apex }. */
  gable?: number | { rise: number; peak?: number };
  /** Any other top line (an arched barrel end): facade (u, v) points from
   * the RIGHT end to the left end, replacing `top` / `gable`. */
  topProfile?: readonly Vec2[];
  /** Wall thickness = depth of the window and door reveals (default 0.25). */
  thickness?: number;
  /** Openings to cut. They must lie inside the panel and below its top line;
   * one that reaches the panel's bottom edge is open to the floor (a bay). */
  openings?: readonly Opening[];
  /** Paint of everything above `top` (timber-boarded gable). */
  gablePaint?: Paint;
  /** Height at which `gablePaint` starts, if not at `top` — the sheets'
   * cottage gables are plaster up to a raised tie beam and boarded above it. */
  gableFrom?: number;
  /** Largest cell of the wall's own grid (default 0.9 m). */
  grid?: number;
  /** Height above `bottom` of the grid's first row (default 0.14 = just
   * above the plinth the wall stands in; 0 = none). The bottom edge itself
   * is buried and bakes black: without this row that black is smeared up
   * the first whole cell of the wall. */
  foot?: number;
  /** Close the top edge too — for a wall that ends in the open (default
   * false: the top is buried in a roof). */
  capTop?: boolean;
  /** The two end faces across the wall's thickness (default true). A panel
   * that runs into a rounded corner skin leaves them out. */
  ends?: boolean;
  /** Board joints: thin raised battens a shade darker than the wall, laid
   * round the openings — weatherboard ('horizontal') or board-and-batten
   * ('vertical'). `pitch` = board width. */
  boards?: { direction: 'horizontal' | 'vertical'; pitch: number; paint?: Paint };
}

/** The wall buries its top this far in the roof, so no light shows at the junction. */
const TOP_LAP = 0.02;

/** Sorted, de-duplicated grid lines with extra ones wherever a gap exceeds `maxGap`. */
function gridLines(values: readonly number[], maxGap: number): number[] {
  const sorted = [...values].sort((x, y) => x - y);
  const lines: number[] = [];
  for (const x of sorted) if (!lines.length || x - lines[lines.length - 1] > 1e-5) lines.push(x);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i + 1 === lines.length) break;
    const gap = lines[i + 1] - lines[i];
    const n = Math.ceil(gap / maxGap - 1e-6);
    for (let k = 1; k < n; k++) out.push(lines[i] + (gap * k) / n);
  }
  return out;
}

/** One rounded corner of a hole. Local frame: a runs from the corner point
 * along the hole's edge toward its middle, b from the corner point along the
 * other edge; the arc is a(θ) = r − r·sin θ, b(θ) = r − r·cos θ, θ = 0 … 90°. */
interface HoleCorner {
  cu: number;
  cv: number;
  sa: 1 | -1;
  sb: 1 | -1;
  r: number;
  thetas: number[];
}

interface Hole {
  l: number;
  r: number;
  b: number;
  t: number;
  corners: HoleCorner[];
}

/**
 * One wall as a plate with real holes: the reveals of every opening are the
 * plate's own thickness. Outer surface on the facade plane (w = 0), body
 * behind it, no back face (the inside of a building is never seen — windows
 * and doors close their own openings). The top is lapped 2 cm past the
 * nominal line into the roof.
 *   const WIN: Opening = { u: -1.8, v: 1.1, w: 0.9, h: 1.0 };
 *   wallPanel(m, { on: F.front, width: 6, bottom: 0.35, top: 2.8, gable: 1.5, openings: [DOOR, WIN] }, P.wall);
 *   windowUnit(m, { on: F.front, opening: WIN }, P);
 *
 * WHY A GRID and not one `extrudePolygon` with holes: baked AO lives on
 * vertices. A plate with holes triangulates into long slivers whose every
 * vertex sits on an edge or a hole rim — all contact-dark, so the whole wall
 * bakes grey; and splitting those slivers afterwards costs ten times the
 * triangles. The face is therefore laid out as rectangular cells on lines
 * through every opening edge plus filler lines, which gives the bake evenly
 * spread interior vertices for ~250 triangles a wall, with every edge shared
 * exactly (no T-junctions for the assembler's refinement to open).
 */
export function wallPanel(m: SolidMesh, o: WallPanelOptions, p: Paint): void {
  const start = m.mark();
  const cu = o.u ?? 0;
  const hw = o.width / 2;
  const uL = cu - hw;
  const uR = cu + hw;
  const t = o.thickness ?? 0.25;
  const cell = o.grid ?? 0.9;
  const [topL, topR] = typeof o.top === 'number' ? [o.top, o.top] : o.top;

  // Top line, left to right.
  let profile: Vec2[];
  if (o.topProfile) {
    profile = [...o.topProfile].sort((x, y) => x[0] - y[0]);
  } else {
    profile = [[uL, topL]];
    if (o.gable !== undefined) {
      const g = typeof o.gable === 'number' ? { rise: o.gable, peak: cu } : { rise: o.gable.rise, peak: o.gable.peak ?? cu };
      profile.push([g.peak, Math.max(topL, topR) + g.rise]);
    }
    profile.push([uR, topR]);
  }
  const topAt = (u: number): number => {
    for (let i = 0; i + 1 < profile.length; i++) {
      const [u0, v0] = profile[i];
      const [u1, v1] = profile[i + 1];
      if (u <= u1 + 1e-9) return v0 + ((v1 - v0) * (u - u0)) / Math.max(1e-9, u1 - u0) + TOP_LAP;
    }
    return profile[profile.length - 1][1] + TOP_LAP;
  };
  const gableFrom = o.gablePaint ? (o.gableFrom ?? Math.min(profile[0][1], profile[profile.length - 1][1])) : Infinity;

  // Holes and the grid lines they need.
  const us: number[] = [uL, uR, ...profile.map((q) => q[0])];
  const vs: number[] = [o.bottom];
  const foot = o.foot ?? 0.14;
  if (foot > 0 && Math.min(topL, topR) - o.bottom > foot + 0.3) vs.push(o.bottom + foot);
  if (o.gablePaint) vs.push(gableFrom);
  const holes: Hole[] = (o.openings ?? []).map((op) => {
    const l = op.u - op.w / 2;
    const r = op.u + op.w / 2;
    const b = Math.max(op.v, o.bottom);
    const tp = op.v + op.h;
    const rad = Math.min(Math.max(0, op.round ?? 0), op.w / 2, (tp - b) / 2);
    const radB = op.roundAll && op.v > o.bottom + 1e-6 ? rad : 0;
    us.push(l, r);
    vs.push(b, tp);
    const corners: HoleCorner[] = [];
    if (rad > 1e-6) {
      us.push(l + rad, r - rad);
      vs.push(tp - rad);
      corners.push({ cu: l, cv: tp, sa: 1, sb: -1, r: rad, thetas: [] }, { cu: r, cv: tp, sa: -1, sb: -1, r: rad, thetas: [] });
    }
    if (radB > 1e-6) {
      vs.push(b + radB);
      corners.push({ cu: l, cv: b, sa: 1, sb: 1, r: radB, thetas: [] }, { cu: r, cv: b, sa: -1, sb: 1, r: radB, thetas: [] });
    }
    return { l, r, b, t: tp, corners };
  });
  const U = gridLines(us.filter((x) => x >= uL - 1e-9 && x <= uR + 1e-9), cell);
  const topMax = Math.max(...U.map(topAt));
  const V = gridLines(vs.filter((y) => y >= o.bottom - 1e-9 && y < topMax - 1e-6), cell);
  // Rows continue up into a gable at the same pitch.
  while (V[V.length - 1] + cell < topMax - 0.05) V.push(V[V.length - 1] + cell);

  // Arc vertices of every rounded corner: broken wherever a grid line
  // crosses the arc, then stepped ≤ 22.5° / ≤ 0.16 m — one list per corner, so
  // the cells on both sides of a line and the reveal all use the same points.
  for (const h of holes) {
    for (const c of h.corners) {
      const breaks = [0, Math.PI / 2];
      for (const u of U) {
        const a = c.sa * (u - c.cu);
        if (a > 1e-6 && a < c.r - 1e-6) breaks.push(Math.asin((c.r - a) / c.r));
      }
      for (const v of V) {
        const b = c.sb * (v - c.cv);
        if (b > 1e-6 && b < c.r - 1e-6) breaks.push(Math.acos((c.r - b) / c.r));
      }
      breaks.sort((x, y) => x - y);
      const step = Math.min(Math.PI / 8, 0.16 / c.r);
      for (let i = 0; i < breaks.length; i++) {
        if (i > 0 && breaks[i] - breaks[i - 1] < 1e-6) continue;
        if (i > 0) {
          const from = c.thetas[c.thetas.length - 1];
          const n = Math.ceil((breaks[i] - from) / step - 1e-6);
          for (let k = 1; k < n; k++) c.thetas.push(from + ((breaks[i] - from) * k) / n);
        }
        c.thetas.push(breaks[i]);
      }
    }
  }
  const arcPoint = (c: HoleCorner, theta: number): Vector3 =>
    new Vector3(c.cu + c.sa * (c.r - c.r * Math.sin(theta)), c.cv + c.sb * (c.r - c.r * Math.cos(theta)), 0);
  const front = new Vector3(0, 0, 1);
  const paintAt = (v: number): Paint => (v > gableFrom - 1e-6 ? (o.gablePaint as Paint) : p);
  const P3 = (u: number, v: number, w = 0): Vector3 => new Vector3(u, v, w);

  /** A rectangular cell of the face: whole, cut by a rounded corner, or inside a hole. */
  const rectCell = (u0: number, u1: number, v0: number, v1: number): void => {
    const uc = (u0 + u1) / 2;
    const vc = (v0 + v1) / 2;
    const cp = paintAt(vc);
    for (const h of holes) {
      if (uc < h.l || uc > h.r || vc < h.b || vc > h.t) continue;
      for (const c of h.corners) {
        const ac = c.sa * (uc - c.cu);
        const bc = c.sb * (vc - c.cv);
        if (ac < 0 || ac > c.r || bc < 0 || bc > c.r) continue;
        // Cell in the corner's local frame.
        const a0 = Math.min(c.sa * (u0 - c.cu), c.sa * (u1 - c.cu));
        const a1 = Math.max(c.sa * (u0 - c.cu), c.sa * (u1 - c.cu));
        const b0 = Math.min(c.sb * (v0 - c.cv), c.sb * (v1 - c.cv));
        const b1 = Math.max(c.sb * (v0 - c.cv), c.sb * (v1 - c.cv));
        const unit = (x: number): number => Math.min(1, Math.max(-1, x));
        const th1 = Math.max(Math.acos(unit((c.r - b0) / c.r)), Math.asin(unit((c.r - a1) / c.r)));
        const th2 = Math.min(Math.acos(unit((c.r - b1) / c.r)), Math.asin(unit((c.r - a0) / c.r)));
        const local = (a: number, b: number): Vector3 => P3(c.cu + c.sa * a, c.cv + c.sb * b);
        if (th2 - th1 < 1e-6) {
          // The arc misses the cell: it is all wall or all hole.
          if ((ac - c.r) ** 2 + (bc - c.r) ** 2 >= c.r * c.r) quadFacing(m, P3(u0, v0), P3(u1, v0), P3(u1, v1), P3(u0, v1), front, cp);
          return;
        }
        // Fan from the cell corner nearest the hole's corner point: every
        // other boundary point of "cell minus disc" is visible from it.
        const pts: Vector3[] = [];
        const arcA = (b: number): number => c.r - Math.sqrt(Math.max(0, c.r * c.r - (c.r - b) ** 2));
        if (arcA(b0) > a1 + 1e-7) pts.push(local(a1, b0));
        for (const th of c.thetas) if (th > th1 - 1e-7 && th < th2 + 1e-7) pts.push(arcPoint(c, th));
        if (arcA(b1) > a0 + 1e-7) pts.push(local(a0, b1));
        const F = local(a0, b0);
        for (let i = 0; i + 1 < pts.length; i++) triFacing(m, F, pts[i], pts[i + 1], front, cp);
        return;
      }
      return; // inside the hole proper
    }
    quadFacing(m, P3(u0, v0), P3(u1, v0), P3(u1, v1), P3(u0, v1), front, cp);
  };

  for (let i = 0; i + 1 < U.length; i++) {
    const uA = U[i];
    const uB = U[i + 1];
    const tA = topAt(uA);
    const tB = topAt(uB);
    // Rows that lie below BOTH ends of the column's top line make plain cells.
    let common = 0;
    while (common < V.length && V[common] < Math.min(tA, tB) - 1e-6) common++;
    for (let k = 0; k + 1 < common; k++) rectCell(uA, uB, V[k], V[k + 1]);
    // Above them, the column runs out under the sloping top: the two sides
    // carry every row below their own top (so the neighbouring column
    // matches vertex for vertex), zipped into quads, the taller side fanned.
    const base = common - 1;
    const sideA = [V[base], ...V.slice(common).filter((v) => v < tA - 1e-6), tA];
    const sideB = [V[base], ...V.slice(common).filter((v) => v < tB - 1e-6), tB];
    const shared = Math.min(sideA.length, sideB.length);
    for (let k = 0; k + 1 < shared; k++) {
      quadFacing(m, P3(uA, sideA[k]), P3(uB, sideB[k]), P3(uB, sideB[k + 1]), P3(uA, sideA[k + 1]), front, paintAt((sideA[k] + sideB[k + 1]) / 2));
    }
    for (let k = shared - 1; k + 1 < sideA.length; k++) triFacing(m, P3(uB, sideB[shared - 1]), P3(uA, sideA[k]), P3(uA, sideA[k + 1]), front, paintAt(sideA[k]));
    for (let k = shared - 1; k + 1 < sideB.length; k++) triFacing(m, P3(uA, sideA[shared - 1]), P3(uB, sideB[k]), P3(uB, sideB[k + 1]), front, paintAt(sideB[k]));
    if (o.capTop) quadFacing(m, P3(uA, tA), P3(uB, tB), P3(uB, tB, -t), P3(uA, tA, -t), new Vector3(0, 1, 0), paintAt(tA));
  }

  // Panel ends.
  for (const [u, dir] of (o.ends ?? true) ? ([[uL, -1], [uR, 1]] as const) : []) {
    const top = topAt(u);
    const rows = [...V.filter((v) => v < top - 1e-6), top];
    for (let k = 0; k + 1 < rows.length; k++) {
      quadFacing(m, P3(u, rows[k]), P3(u, rows[k + 1]), P3(u, rows[k + 1], -t), P3(u, rows[k], -t), new Vector3(dir, 0, 0), paintAt((rows[k] + rows[k + 1]) / 2));
    }
  }

  // Reveals: walk each hole's rim through the same points the cells used.
  for (const h of holes) {
    const rim: Vector3[] = [];
    const corner = (cuu: number, cvv: number): HoleCorner | undefined => h.corners.find((c) => c.cu === cuu && c.cv === cvv);
    const between = (lines: number[], from: number, to: number): number[] => {
      const inside = lines.filter((x) => x > Math.min(from, to) + 1e-6 && x < Math.max(from, to) - 1e-6);
      return from < to ? inside : inside.reverse();
    };
    const arc = (c: HoleCorner | undefined, ascending: boolean, at: Vector3): void => {
      if (!c) {
        rim.push(at);
        return;
      }
      const th = ascending ? c.thetas : [...c.thetas].reverse();
      for (const x of th) rim.push(arcPoint(c, x));
    };
    const bl = corner(h.l, h.b), br = corner(h.r, h.b), tr = corner(h.r, h.t), tl = corner(h.l, h.t);
    const rb = bl ? bl.r : 0;
    const rt = tl ? tl.r : 0;
    for (const u of between(U, h.l + rb, h.r - rb)) rim.push(P3(u, h.b));
    arc(br, true, P3(h.r, h.b));
    for (const v of between(V, h.b + rb, h.t - rt)) rim.push(P3(h.r, v));
    arc(tr, false, P3(h.r, h.t));
    for (const u of between(U, h.r - rt, h.l + rt)) rim.push(P3(u, h.t));
    arc(tl, true, P3(h.l, h.t));
    for (const v of between(V, h.t - rt, h.b + rb)) rim.push(P3(h.l, v));
    arc(bl, false, P3(h.l, h.b));
    const centre = P3((h.l + h.r) / 2, (h.b + h.t) / 2);
    const rp = soften(p, 30);
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i];
      const b = rim[(i + 1) % rim.length];
      if (Vector3.DistanceSquared(a, b) < 1e-12) continue;
      // An opening that reaches the panel's bottom edge has no sill reveal.
      if (h.b <= o.bottom + 1e-6 && Math.abs(a.y - h.b) < 1e-6 && Math.abs(b.y - h.b) < 1e-6) continue;
      quadFacing(m, a, b, P3(b.x, b.y, -t), P3(a.x, a.y, -t), centre.subtract(a.add(b).scale(0.5)), rp);
    }
  }

  // Board joints. Real (if shallow) geometry: a painted line would have to be
  // split into every cell it crosses, at ten times the triangles.
  if (o.boards) {
    const bp = o.boards.paint ?? paint(p, { color: shade(p.color, 0.84) });
    const shape = { width: 0.04, topWidth: 0.022, height: 0.012, capStart: true, capEnd: true };
    const clear = 0.16; // stops short of sills and surrounds
    /** [from, to] minus every blocked span. */
    const open = (from: number, to: number, blocked: [number, number][]): [number, number][] => {
      let spans: [number, number][] = [[from, to]];
      for (const [b0, b1] of blocked) {
        spans = spans.flatMap(([s0, s1]): [number, number][] => {
          if (b1 <= s0 || b0 >= s1) return [[s0, s1]];
          const out: [number, number][] = [];
          if (b0 > s0) out.push([s0, b0]);
          if (b1 < s1) out.push([b1, s1]);
          return out;
        });
      }
      return spans.filter(([s0, s1]) => s1 - s0 > 0.12);
    };
    if (o.boards.direction === 'vertical') {
      const count = Math.max(1, Math.round(o.width / o.boards.pitch));
      for (let i = 1; i < count; i++) {
        const u = uL + (o.width * i) / count;
        const blocked = holes.filter((h) => u > h.l - clear && u < h.r + clear).map((h): [number, number] => [h.b - clear, h.t + clear]);
        for (const [v0, v1] of open(o.bottom, topAt(u) - TOP_LAP, blocked)) rib(m, P3(u, v0), P3(u, v1), front, shape, bp);
      }
    } else {
      const count = Math.max(1, Math.round((topMax - o.bottom) / o.boards.pitch));
      const step = (topMax - o.bottom) / count;
      for (let j = 1; j < count; j++) {
        const v = o.bottom + j * step;
        // Where the wall is at least this tall.
        const tall: [number, number][] = [];
        for (let i = 0; i + 1 < profile.length; i++) {
          const [u0, v0] = profile[i];
          const [u1, v1] = profile[i + 1];
          const hi0 = v0 >= v;
          const hi1 = v1 >= v;
          if (!hi0 && !hi1) continue;
          const cross = u0 + ((u1 - u0) * (v - v0)) / (v1 - v0 || 1);
          const span: [number, number] = [hi0 ? u0 : cross, hi1 ? u1 : cross];
          const last = tall[tall.length - 1];
          if (last && Math.abs(last[1] - span[0]) < 1e-6) last[1] = span[1];
          else tall.push(span);
        }
        const blocked = holes.filter((h) => v > h.b - clear && v < h.t + clear).map((h): [number, number] => [h.l - clear, h.r + clear]);
        for (const [t0, t1] of tall) for (const [a, b] of open(t0, t1, blocked)) rib(m, P3(a, v), P3(b, v), front, shape, bp);
      }
    }
  }
  toFacade(m, start, o.on);
}

export type WallName = 'front' | 'back' | 'left' | 'right';

export interface WallBoxOptions {
  /** Outer size of the body: x and z. */
  width: number;
  depth: number;
  /** Centre of the footprint (default the origin). */
  cx?: number;
  cz?: number;
  bottom: number;
  /** Wall top = the eave line. */
  top: number;
  thickness?: number;
  openings?: Partial<Record<WallName, readonly Opening[]>>;
  /** Gable walls under a pitched roof: which way the RIDGE runs and how far
   * the peak rises above `top` (use the roof's `rise`). */
  gable?: { ridge: 'z' | 'x'; rise: number };
  gablePaint?: Paint;
  /** Height at which `gablePaint` starts (default the wall top). */
  gableFrom?: number;
  /** Round the four plan corners (the sheets' soft plaster shells). The
   * corners then need no posts or quoins. */
  cornerRadius?: number;
  /** Board joints on all four walls — see `WallPanelOptions.boards`. */
  boards?: WallPanelOptions['boards'];
  /** Largest wall cell (default 0.9 m); 1.2 saves a quarter of the wall's
   * triangles on a big two-storey body. */
  grid?: number;
}

/**
 * The four walls of a box body in one call; returns its facades for mounting
 * everything else.
 *   const F = wallBox(m, { width: 6, depth: 5, bottom: 0.35, top: 2.8,
 *     gable: { ridge: 'z', rise: roof.rise }, openings: { front: [DOOR, W1, W2], left: [W3] } }, P.wall);
 */
export function wallBox(m: SolidMesh, o: WallBoxOptions, p: Paint): BoxFacades {
  const F = boxFacades(o.width, o.depth, o.cx ?? 0, o.cz ?? 0);
  const t = o.thickness ?? 0.25;
  const r = Math.max(0, Math.min(o.cornerRadius ?? 0, o.width / 2 - 0.05, o.depth / 2 - 0.05));
  // The side walls run BETWEEN the front and back plates and overlap them by
  // a centimeter: an exact butt joint is a T-junction once the assembler
  // refines the faces for AO, and that shows the sky through hairline cracks.
  const lap = 0.01;
  const frontWidth = o.width - 2 * r;
  const sideWidth = r > 0 ? o.depth - 2 * r : o.depth - 2 * t + 2 * lap;
  const panel = (name: WallName, width: number, gabled: boolean): void => {
    wallPanel(
      m,
      {
        on: F[name],
        width,
        bottom: o.bottom,
        top: o.top,
        thickness: t,
        openings: o.openings?.[name],
        gable: gabled && o.gable ? o.gable.rise * (width / (width + 2 * r)) : undefined,
        gablePaint: gabled ? o.gablePaint : undefined,
        gableFrom: gabled ? o.gableFrom : undefined,
        // Under a corner skin an end face is hidden — except for the 2 cm by
        // which it would stand up through a flat roof's deck.
        ends: r <= 0,
        boards: o.boards,
        grid: o.grid,
      },
      p,
    );
  };
  const ridgeZ = o.gable?.ridge !== 'x';
  if (ridgeZ || !o.gable) {
    panel('front', frontWidth, true);
    panel('back', frontWidth, true);
    panel('left', sideWidth, false);
    panel('right', sideWidth, false);
  } else {
    // Ridge along x: the gables are the left / right walls, which then span
    // the full depth while front and back fit between them.
    panel('left', o.depth - 2 * r, true);
    panel('right', o.depth - 2 * r, true);
    const fb = r > 0 ? frontWidth : o.width - 2 * t + 2 * lap;
    panel('front', fb, false);
    panel('back', fb, false);
  }
  if (r > 0) {
    // Quarter-round corner skins, from tangent line to tangent line, with
    // their normals pinned radial so the curve leaves the flat wall without a
    // seam. Rows differ from wall to wall, so skin and panel cannot share
    // vertices along the tangent lines; a narrow strip TUCKED 1.5 cm behind
    // each panel backs the joint instead. (Letting the curve itself overrun
    // the tangent puts it a fraction of a millimeter behind the panel — a
    // dashed z-fighting line down every corner.)
    const cx = o.cx ?? 0;
    const cz = o.cz ?? 0;
    const steps = 5;
    const rows = Math.max(1, Math.ceil((o.top - o.bottom) / 0.75));
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        const s0 = m.mark();
        const ox = cx + sx * (o.width / 2 - r);
        const oz = cz + sz * (o.depth / 2 - r);
        // Plan points: tuck behind the ±x wall, the arc, tuck behind the ±z wall.
        const plan: [number, number][] = [[ox + sx * (r - 0.015), oz - sz * 0.05]];
        for (let k = 0; k <= steps; k++) {
          const a = (k / steps) * (Math.PI / 2);
          plan.push([ox + sx * Math.cos(a) * r, oz + sz * Math.sin(a) * r]);
        }
        plan.push([ox - sx * 0.05, oz + sz * (r - 0.015)]);
        for (let k = 0; k + 1 < plan.length; k++) {
          const [x0, z0] = plan[k];
          const [x1, z1] = plan[k + 1];
          const out = new Vector3((x0 + x1) / 2 - ox, 0, (z0 + z1) / 2 - oz);
          for (let j = 0; j < rows; j++) {
            const y0 = o.bottom + ((o.top + 0.02 - o.bottom) * j) / rows;
            const y1 = o.bottom + ((o.top + 0.02 - o.bottom) * (j + 1)) / rows;
            quadFacing(m, new Vector3(x0, y0, z0), new Vector3(x1, y0, z1), new Vector3(x1, y1, z1), new Vector3(x0, y1, z0), out, p);
          }
        }
        m.setNormals((q) => new Vector3(q.x - ox, 0, q.z - oz), s0);
      }
    }
  }
  return F;
}

// ---------------------------------------------------------------------------
// Stone plinth

/** Gap between the outlines of neighbouring plinth stones — the dark line at
 * the bottom of the V their bevels make. */
const STONE_JOINT = 0.03;
/** Width of a stone's edge bevel on its face, and how far it falls back. */
const STONE_BEVEL = 0.05;
const STONE_BEVEL_DEPTH = 0.055;
/** The dark backing stands this far in FRONT of the bevels' rims: every rim
 * is sunk in it, so a joint never shows an open edge or the back of a face. */
const STONE_RIM_SINK = 0.006;
/** Tilt of a bevel's rim normal out of the wall plane: the bevel shades as a
 * quarter round from the flat face to (almost) the joint direction. */
const RIM_TILT = (20 * Math.PI) / 180;
/** The backing's top sits this far below the stones' crowns: in the notch
 * between two of them it is what shows (a dark joint, not the plaster
 * behind), and the slot it leaves under their ledges is too thin to see
 * into. That is why every stone of a course is crowned at the same height. */
const CORE_DROP = 0.004;

/** The three colours of one stone: its face, its sunlit top planes and the
 * edges that turn into a joint. Painted, not lit: the sheets draw the plinth
 * with lighter tops and dark joints whatever the sun does, and at 5 cm these
 * bevels are too small for the shader to do it on its own. */
interface StoneTones {
  face: RGB;
  top: RGB;
  joint: RGB;
}

function stoneTones(p: Paint, P: BuildingPaints): StoneTones {
  return { face: p.color, top: mixOklab(p.color, STONE.upperFace, 0.26), joint: mixOklab(p.color, P.stoneDark.color, 0.7) };
}

/** A quad with pinned corner normals and colours, wound to face `dir`. */
function shadedQuad(m: SolidMesh, q: readonly [Vector3, Vector3, Vector3, Vector3], dir: Vector3, p: Paint, colors: readonly [RGB, RGB, RGB, RGB], normals: readonly [Vector3, Vector3, Vector3, Vector3]): void {
  const n = Vector3.Cross(q[1].subtract(q[0]), q[2].subtract(q[0])).add(Vector3.Cross(q[2].subtract(q[0]), q[3].subtract(q[0])));
  if (Vector3.Dot(n, dir) >= 0) m.quad(q[0], q[1], q[2], q[3], p, colors, normals);
  else m.quad(q[0], q[3], q[2], q[1], p, [colors[0], colors[3], colors[2], colors[1]], [normals[0], normals[3], normals[2], normals[1]]);
}

interface FaceStone {
  /** Outline in facade (u, v), counter-clockwise: bottom-left, bottom-right,
   * top-right, top-left. Any convex quad — leaning joints make trapezoids. */
  outline: readonly [Vec2, Vec2, Vec2, Vec2];
  /** w of the flat face and of the rim its bevels fall back to. */
  face: number;
  rim: number;
  /** Which edges are bevelled: bottom, right, top, left (the bottom edge of
   * a ground stone is under the ground and runs straight down). */
  bevels: readonly [boolean, boolean, boolean, boolean];
  /** Top course: close the top with a ledge running back to this w. */
  ledge?: number;
  /** How far each face corner is knocked back (outline order). One dented
   * corner breaks the face into two flat facets along the other diagonal. */
  dent: readonly [number, number, number, number];
}

/**
 * One dressed plinth stone lying on a facade: a FLAT face (pinned normals —
 * a smooth paint would otherwise smear the bevels into it and the block
 * shades like a cushion), a bevel on every exposed edge whose normals turn
 * from the face to the joint, lighter top planes, darker joint edges. No
 * back and no sides: its rim is sunk in the dark backing behind it.
 * 8 – 12 triangles.
 */
function faceStone(m: SolidMesh, s: FaceStone, p: Paint, tones: StoneTones): void {
  const O = s.outline;
  // Inward unit normal of edge k (corner k → k + 1) and its bevel width.
  const inward: Vec2[] = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = O[k];
    const [bx, by] = O[(k + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    inward.push([-(by - ay) / len, (bx - ax) / len]);
  }
  // A small stone gets a narrower bevel: one wider than a third of its
  // shortest edge folds the face over.
  const edgeLength = (k: number): number => Math.hypot(O[(k + 1) % 4][0] - O[k][0], O[(k + 1) % 4][1] - O[k][1]);
  const bevel = Math.min(STONE_BEVEL, 0.3 * Math.min(edgeLength(0), edgeLength(1), edgeLength(2), edgeLength(3)));
  const width = (k: number): number => (s.bevels[k] ? bevel : 0);
  const front: Vector3[] = [];
  const rim: Vector3[] = [];
  const rimNormal: Vector3[] = [];
  for (let k = 0; k < 4; k++) {
    // Face corner k = where the offset lines of edges k − 1 and k cross.
    const j = (k + 3) % 4;
    const a = inward[j];
    const b = inward[k];
    const c = a[0] * b[0] + a[1] * b[1];
    const den = Math.max(1e-6, 1 - c * c);
    const sa = (width(j) - c * width(k)) / den;
    const sb = (width(k) - c * width(j)) / den;
    front.push(new Vector3(O[k][0] + sa * a[0] + sb * b[0], O[k][1] + sa * a[1] + sb * b[1], s.face - s.dent[k]));
    rim.push(new Vector3(O[k][0], O[k][1], s.rim));
    // Rim normal: outward across the bevelled edges that meet here.
    const ox = -(s.bevels[j] ? a[0] : 0) - (s.bevels[k] ? b[0] : 0);
    const oy = -(s.bevels[j] ? a[1] : 0) - (s.bevels[k] ? b[1] : 0);
    const ol = Math.hypot(ox, oy) || 1;
    rimNormal.push(new Vector3((ox / ol) * Math.cos(RIM_TILT), (oy / ol) * Math.cos(RIM_TILT), Math.sin(RIM_TILT)));
  }
  // The face gets a little of the top tone toward its upper edge.
  const faceColor = [tones.face, tones.face, mixOklab(tones.face, tones.top, 0.35), mixOklab(tones.face, tones.top, 0.35)];
  const flat = (i: number, j: number, k: number): void => {
    const n = Vector3.Cross(front[j].subtract(front[i]), front[k].subtract(front[i]));
    m.tri(front[i], front[j], front[k], p, [faceColor[i], faceColor[j], faceColor[k]], [n, n, n]);
  };
  // Split on the diagonal that does NOT pass through the dented corner.
  const dented = s.dent.findIndex((d) => d > 1e-6);
  if (dented === 0 || dented === 2) {
    flat(1, 2, 3);
    flat(3, 0, 1);
  } else {
    flat(0, 1, 2);
    flat(0, 2, 3);
  }
  const faceNormal = new Vector3(0, 0, 1);
  for (let k = 0; k < 4; k++) {
    if (!s.bevels[k]) continue;
    const j = (k + 1) % 4;
    const edge = k === 2 ? tones.top : tones.joint;
    shadedQuad(m, [rim[k], rim[j], front[j], front[k]], new Vector3(-inward[k][0], -inward[k][1], 1), p, [edge, edge, faceColor[j], faceColor[k]], [rimNormal[k], rimNormal[j], faceNormal, faceNormal]);
  }
  if (s.ledge !== undefined) {
    const tl = rim[3];
    const tr = rim[2];
    quadFacing(m, tl, tr, new Vector3(tr.x, tr.y, s.ledge), new Vector3(tl.x, tl.y, s.ledge), new Vector3(0, 1, 0), paint(p, { color: tones.top, smooth: 0 }));
  }
}

export interface StoneCourseOptions {
  on: Facade;
  /** Run of the course along the facade. */
  u0: number;
  u1: number;
  /** Bottom (default −0.1: the skirt that hides sloping ground) and top. */
  bottom?: number;
  top: number;
  /** How far the stone faces stand out of the facade plane (default 0.12). */
  proud?: number;
  /** Shortest / longest stone (default 0.42 … 1.05 m; a long building can
   * save triangles with 0.7 … 1.4). */
  blockLength?: readonly [number, number];
  /** Chance that a long stone (over 0.78 m) is split into two courses
   * (default 0.62; shorter ones split a third as often — about a third of
   * all stones end up split). 0 = one course throughout. */
  split?: number;
  /** The dark plate behind the stones (default true). `stonePlinth` leaves
   * it out: its core does the job for all four sides. */
  backing?: boolean;
  seed?: number;
}

/**
 * One straight run of plinth masonry as the sheets draw it: stones of very
 * different lengths, joints leaning 5 – 12° either way, about a third of
 * them split into a tall and a low course (the low one sometimes cut in two
 * again), flat faces with the odd knocked-back corner, three stone tones.
 * Roughly 18 triangles a metre.
 */
export function stoneCourse(m: SolidMesh, o: StoneCourseOptions, P: BuildingPaints): void {
  const start = m.mark();
  const r = rng(o.seed ?? 0, 'course', o.on.facing, Math.round(o.u0 * 100));
  const bottom = o.bottom ?? -0.1;
  const top = o.top;
  const proud = o.proud ?? 0.12;
  const [lmin, lmax] = o.blockLength ?? [0.42, 1.05];
  const run = o.u1 - o.u0;
  if (run < 0.05) return;
  const rim = proud - STONE_BEVEL_DEPTH;
  const H = top - bottom;
  const count = Math.max(1, Math.round(run / ((lmin + lmax) / 2)));
  const raw = Array.from({ length: count }, () => r.range(lmin, lmax));
  const scale = run / raw.reduce((a, b) => a + b, 0);
  const lengths = raw.map((l) => l * scale);
  const tones = [P.stone, P.stone, P.stoneLight, paint(P.stone, { color: shade(P.stone.color, 0.9) })].map((p) => ({ p, t: stoneTones(p, P) }));
  // A joint line: u at the course's bottom and how far its top leans right.
  interface Joint {
    u: number;
    lean: number;
    gap: number;
  }
  const lean = (room: number): number => r.sign() * Math.min(Math.tan((r.range(5, 12) * Math.PI) / 180) * H, room * 0.22);
  const joints: Joint[] = [{ u: o.u0, lean: 0, gap: 0 }];
  for (let i = 1; i < count; i++) joints.push({ u: joints[i - 1].u + lengths[i - 1], lean: lean(Math.min(lengths[i - 1], lengths[i])), gap: STONE_JOINT / 2 });
  joints.push({ u: o.u1, lean: 0, gap: 0 });
  const at = (j: Joint, v: number): number => j.u + (j.lean * (v - bottom)) / H;
  /** A stone between two joints and two (possibly tilted) bed lines. */
  const stone = (L: Joint, R: Joint, v0: readonly [number, number], v1: readonly [number, number], ground: boolean, crown: boolean): void => {
    const tone = r.pick(tones);
    const dent: [number, number, number, number] = [0, 0, 0, 0];
    if (r.chance(0.6)) dent[r.int(0, 3)] = r.range(0.02, 0.036);
    faceStone(
      m,
      {
        outline: [
          [at(L, v0[0]) + L.gap, v0[0]],
          [at(R, v0[1]) - R.gap, v0[1]],
          [at(R, v1[1]) - R.gap, v1[1]],
          [at(L, v1[0]) + L.gap, v1[0]],
        ],
        face: proud + r.range(-0.012, 0.014),
        rim,
        bevels: [!ground, true, true, true],
        ledge: crown ? -0.02 : undefined,
        dent,
      },
      tone.p,
      tone.t,
    );
  };
  const half = STONE_JOINT / 2;
  for (let i = 0; i < count; i++) {
    const L = joints[i];
    const R = joints[i + 1];
    const len = lengths[i];
    const crownV = top;
    // Long stones are the ones that get broken up: a metre of plain face is
    // what makes a plinth read as cast blocks.
    const share = o.split ?? 0.62;
    if (len < 0.5 || !r.chance(len > 0.78 ? share : share * 0.35)) {
      stone(L, R, [bottom, bottom], [crownV, crownV], true, true);
      continue;
    }
    // Bed joint at 0.6 or 0.4 of the height above the ground, a touch tilted.
    const bed = top * (r.chance(0.5) ? r.range(0.56, 0.63) : r.range(0.37, 0.44));
    const tilt = r.range(-0.025, 0.025);
    const bedL = bed + tilt;
    const bedR = bed - tilt;
    const lowBig = bed > top / 2;
    // The lower of the two is cut again when the slot is long.
    const cut = len > 0.8 && r.chance(0.6) ? { u: L.u + len * r.range(0.4, 0.6), lean: lean(len * 0.45), gap: half } : undefined;
    const lower = (A: Joint, B: Joint, vA: number, vB: number): void => stone(A, B, [bottom, bottom], [vA - half, vB - half], true, false);
    const upper = (A: Joint, B: Joint, vA: number, vB: number): void => stone(A, B, [vA + half, vB + half], [crownV, crownV], false, true);
    if (cut) {
      const bedC = bedL + ((bedR - bedL) * (cut.u - L.u)) / len;
      if (lowBig) {
        lower(L, R, bedL, bedR);
        upper(L, cut, bedL, bedC);
        upper(cut, R, bedC, bedR);
      } else {
        lower(L, cut, bedL, bedC);
        lower(cut, R, bedC, bedR);
        upper(L, R, bedL, bedR);
      }
    } else {
      lower(L, R, bedL, bedR);
      upper(L, R, bedL, bedR);
    }
  }
  if (o.backing ?? true) {
    const w = rim + STONE_RIM_SINK;
    const y = top - CORE_DROP;
    quadFacing(m, new Vector3(o.u0, bottom, w), new Vector3(o.u1, bottom, w), new Vector3(o.u1, y, w), new Vector3(o.u0, y, w), new Vector3(0, 0, 1), P.stoneDark);
    quadFacing(m, new Vector3(o.u0, y, w), new Vector3(o.u1, y, w), new Vector3(o.u1, y, -0.02), new Vector3(o.u0, y, -0.02), new Vector3(0, 1, 0), P.stoneDark);
  }
  toFacade(m, start, o.on);
}

/**
 * The big stone wrapping a plan corner of the plinth: two flat faces, a
 * rounded arris between them, bevelled top and joint ends, a closed top.
 * `at` = the body's outer corner, `out` = which way is outward, `legs` = how
 * far the stone runs back along the x and the z wall. 30 triangles.
 */
function plinthCorner(
  m: SolidMesh,
  o: { at: readonly [number, number]; out: readonly [number, number]; legs: readonly [number, number]; face: number; rim: number; bottom: number; top: number; closeTo?: number },
  p: Paint,
  tones: StoneTones,
): void {
  const start = m.mark();
  // Canonical corner space: the walls are the planes x = 0 and z = 0, outward
  // is +x and +z; mirrored into place at the end.
  const e = o.face;
  const rimW = o.rim;
  const bd = e - rimW;
  const b = STONE_BEVEL;
  const ar = bd + 0.07;
  const [lx, lz] = o.legs;
  const y0 = o.bottom;
  const yT = o.top;
  const yH = yT - b;
  const c = Math.SQRT1_2;
  // Stations round the stone in plan: on the face, on the top rim, normal.
  const st: { f: Vec2; t: Vec2; n: Vec2 }[] = [
    { f: [e, -lz + b], t: [rimW, -lz], n: [1, 0] },
    { f: [e, e - ar], t: [rimW, e - ar], n: [1, 0] },
    { f: [e - ar + ar * c, e - ar + ar * c], t: [e - ar + (ar - bd) * c, e - ar + (ar - bd) * c], n: [c, c] },
    { f: [e - ar, e], t: [e - ar, rimW], n: [0, 1] },
    { f: [-lx + b, e], t: [-lx, rimW], n: [0, 1] },
  ];
  const F = (i: number, y: number): Vector3 => new Vector3(st[i].f[0], y, st[i].f[1]);
  const T = (i: number, y: number): Vector3 => new Vector3(st[i].t[0], y, st[i].t[1]);
  const N = (i: number): Vector3 => new Vector3(st[i].n[0], 0, st[i].n[1]);
  const up = new Vector3(0, 1, 0);
  const cosT = Math.cos(RIM_TILT);
  const sinT = Math.sin(RIM_TILT);
  const upper = mixOklab(tones.face, tones.top, 0.35);
  for (let i = 0; i < 4; i++) {
    const j = i + 1;
    shadedQuad(m, [F(i, y0), F(j, y0), F(j, yH), F(i, yH)], N(i).add(N(j)), p, [tones.face, tones.face, upper, upper], [N(i), N(j), N(j), N(i)]);
    // Top bevel: from the face's normal to (almost) straight up.
    const ri = N(i).scale(sinT).add(up.scale(cosT));
    const rj = N(j).scale(sinT).add(up.scale(cosT));
    shadedQuad(m, [F(i, yH), F(j, yH), T(j, yT), T(i, yT)], N(i).add(N(j)).add(up), p, [upper, upper, tones.top, tones.top], [N(i), N(j), rj, ri]);
  }
  // Joint ends: mitred into the top bevel at the rim's corner.
  for (const [i, jx, jz] of [[0, 0, -1], [4, -1, 0]] as const) {
    const joint = new Vector3(jx, 0, jz);
    const low = joint.scale(cosT).add(N(i).scale(sinT));
    const high = joint.add(up).normalize().scale(cosT).add(N(i).scale(sinT));
    shadedQuad(m, [F(i, y0), T(i, y0), T(i, yT), F(i, yH)], N(i).add(joint), p, [tones.face, tones.joint, tones.joint, upper], [N(i), low, high, N(i)]);
  }
  const cap = [T(0, yT), T(1, yT), T(2, yT), T(3, yT), T(4, yT), new Vector3(-lx, yT, -0.02), new Vector3(-0.02, yT, -0.02), new Vector3(-0.02, yT, -lz)];
  const capPaint = paint(p, { color: tones.top, smooth: 0 });
  polygonFacing(m, cap, up, capPaint);
  // The cap may stand above the courses' backing: close the two ends of the
  // slot under it, or the joints beside the stone look in under the cap.
  if (o.closeTo !== undefined && o.closeTo < yT - 1e-4) {
    quadFacing(m, T(0, yT), new Vector3(-0.02, yT, -lz), new Vector3(-0.02, o.closeTo, -lz), T(0, o.closeTo), new Vector3(0, 0, -1), capPaint);
    quadFacing(m, T(4, yT), new Vector3(-lx, yT, -0.02), new Vector3(-lx, o.closeTo, -0.02), T(4, o.closeTo), new Vector3(-1, 0, 0), capPaint);
  }
  m.transform(compose(scaling(o.out[0], 1, o.out[1]), translation(o.at[0], 0, o.at[1])), start);
}

export interface StonePlinthOptions {
  /** Outer size of the BODY the plinth carries (the wall faces). */
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  /** Top of the plinth (default 0.5 — the sheets draw it half a metre high)
   * and depth of the skirt below y = 0. */
  top?: number;
  skirt?: number;
  proud?: number;
  seed?: number;
  /** Shortest / longest stone (default 0.42 … 1.05 m). */
  blockLength?: readonly [number, number];
  /** Chance that a long stone is split into two courses (default 0.62,
   * see `StoneCourseOptions.split`). */
  split?: number;
}

/**
 * The lavender stone foundation of a box body: a dark core, irregular
 * masonry on every side (`stoneCourse`) and a bigger stone wrapping each
 * corner. It reaches `skirt` (10 cm) below the ground so a building never
 * floats on a slope. Start the walls 0.1 m below `top`.
 *   stonePlinth(m, { width: 6, depth: 5, seed }, P);
 * About 22 triangles a metre of wall: 480 for a 6 × 5 m cottage.
 */
export function stonePlinth(m: SolidMesh, o: StonePlinthOptions, P: BuildingPaints): void {
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const top = o.top ?? 0.5;
  const skirt = o.skirt ?? 0.1;
  const proud = o.proud ?? 0.12;
  const seed = o.seed ?? 0;
  const F = boxFacades(o.width, o.depth, cx, cz);
  const r = rng(seed, 'plinth');
  // Core: what shows at the bottom of the joints. Every stone's rim is sunk
  // in its faces, and its top stays BELOW every stone's top, or it reads as
  // a dark frame round the masonry.
  const rim = proud - STONE_BEVEL_DEPTH;
  const core = rim + STONE_RIM_SINK;
  box(
    m,
    {
      min: [cx - o.width / 2 - core, -skirt, cz - o.depth / 2 - core],
      max: [cx + o.width / 2 + core, top - CORE_DROP, cz + o.depth / 2 + core],
      faces: { ny: null },
    },
    P.stoneDark,
  );
  // One plate under everything: the stones have no undersides of their own,
  // and a building tipped on a slope or seen from below must stay closed.
  const g = proud + 0.06;
  quadFacing(
    m,
    new Vector3(cx - o.width / 2 - g, -skirt, cz - o.depth / 2 - g),
    new Vector3(cx + o.width / 2 + g, -skirt, cz - o.depth / 2 - g),
    new Vector3(cx + o.width / 2 + g, -skirt, cz + o.depth / 2 + g),
    new Vector3(cx - o.width / 2 - g, -skirt, cz + o.depth / 2 + g),
    new Vector3(0, -1, 0),
    P.stoneDark,
  );
  // Corner stones wrap both faces and stand a touch prouder than the courses.
  const cornerLen: Record<string, [number, number]> = {};
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const lx = r.range(0.4, 0.66);
      const lz = r.range(0.4, 0.66);
      cornerLen[`${sx},${sz}`] = [lx, lz];
      const p = r.chance(0.5) ? P.stone : P.stoneLight;
      plinthCorner(
        m,
        { at: [cx + (sx * o.width) / 2, cz + (sz * o.depth) / 2], out: [sx, sz], legs: [lx, lz], face: proud + 0.025, rim, bottom: -skirt, top: top + r.range(0, 0.02), closeTo: top - CORE_DROP - 0.01 },
        p,
        stoneTones(p, P),
      );
    }
  }
  const course = (name: WallName, half: number, left: number, right: number): void => {
    stoneCourse(
      m,
      { on: F[name], u0: -half + left + STONE_JOINT, u1: half - right - STONE_JOINT, bottom: -skirt, top, proud, blockLength: o.blockLength, split: o.split, backing: false, seed },
      P,
    );
  };
  // Viewer's left / right corner of each facade, as (sx, sz) keys.
  course('front', o.width / 2, cornerLen['-1,-1'][0], cornerLen['1,-1'][0]);
  course('back', o.width / 2, cornerLen['1,1'][0], cornerLen['-1,1'][0]);
  course('right', o.depth / 2, cornerLen['1,-1'][1], cornerLen['1,1'][1]);
  course('left', o.depth / 2, cornerLen['-1,1'][1], cornerLen['-1,-1'][1]);
}

/** One free-standing chunky stone block (stilt pads, steps, loose blocks):
 * a chamfered box reaching `skirt` below y = 0. */
export function stoneBlock(m: SolidMesh, o: { at: readonly [number, number]; size: readonly [number, number, number]; skirt?: number; rotY?: number }, p: Paint): void {
  const skirt = o.skirt ?? 0.1;
  roundedBox(
    m,
    {
      size: [o.size[0], o.size[1] + skirt, o.size[2]],
      radius: Math.min(0.07, o.size[1] * 0.25),
      segments: 1,
      rot: [0, o.rotY ?? 0, 0],
      at: [o.at[0], (o.size[1] - skirt) / 2, o.at[1]],
    },
    p,
  );
}

// ---------------------------------------------------------------------------
// Posts, pilasters, quoins, bands

export interface PostOptions {
  /** Plan position (x, z) of the post's centre. */
  at: readonly [number, number];
  bottom: number;
  top: number;
  /** Section: one number or [x, z]. */
  size: number | readonly [number, number];
  /** Edge rounding (default 15 % of the section). */
  radius?: number;
  /** Wider block at the foot / head: its height and how far it outgrows the
   * post on every side. Paint defaults to the post's. */
  base?: { height: number; grow?: number; paint?: Paint };
  cap?: { height: number; grow?: number; paint?: Paint };
}

/**
 * An upright with softly rounded edges: timber corner post, porch post (P01,
 * 0.2 m), cream pilaster. Optional base and cap blocks.
 *   post(m, { at: [-2.2, -3.1], bottom: 0.3, top: 2.6, size: 0.2, base: { height: 0.3, paint: P.trim } }, P.timber);
 */
export function post(m: SolidMesh, o: PostOptions, p: Paint): void {
  const [sx, sz] = typeof o.size === 'number' ? [o.size, o.size] : o.size;
  const radius = o.radius ?? Math.min(sx, sz) * 0.15;
  roundedBox(m, { min: [o.at[0] - sx / 2, o.bottom, o.at[1] - sz / 2], max: [o.at[0] + sx / 2, o.top, o.at[1] + sz / 2], radius, segments: 1 }, p);
  const block = (y0: number, y1: number, grow: number, bp: Paint): void => {
    roundedBox(
      m,
      { min: [o.at[0] - sx / 2 - grow, y0, o.at[1] - sz / 2 - grow], max: [o.at[0] + sx / 2 + grow, y1, o.at[1] + sz / 2 + grow], radius: Math.min(radius * 1.3, (y1 - y0) * 0.3), segments: 1 },
      bp,
    );
  };
  // Blocks overlap the shaft's end by 2 cm so no faces coincide.
  if (o.base) block(o.bottom - 0.02, o.bottom + o.base.height, o.base.grow ?? 0.05, o.base.paint ?? p);
  if (o.cap) block(o.top - o.cap.height, o.top + 0.02, o.cap.grow ?? 0.05, o.cap.paint ?? p);
}

export type CornerName = 'fl' | 'fr' | 'bl' | 'br';

export interface CornerPostsOptions {
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  bottom: number;
  top: number;
  /** Section of each post (default 0.36 — the sheets' posts and pilasters
   * are a good third of a meter wide). */
  size?: number;
  /** How far the post stands out of both wall faces (default 0.06). */
  proud?: number;
  /** Which corners (default all four): f / b = front / back, l / r as in the front view. */
  corners?: readonly CornerName[];
  base?: PostOptions['base'];
  cap?: PostOptions['cap'];
}

/** Posts wrapping the corners of a box body — B04's timber frame, or the
 * cream pilasters of the bigger houses with `base` / `cap`. */
export function cornerPosts(m: SolidMesh, o: CornerPostsOptions, p: Paint): void {
  const size = o.size ?? 0.36;
  const proud = o.proud ?? 0.06;
  const inset = size / 2 - proud;
  for (const c of o.corners ?? (['fl', 'fr', 'bl', 'br'] as const)) {
    const sx = c[1] === 'r' ? 1 : -1;
    const sz = c[0] === 'b' ? 1 : -1;
    post(
      m,
      { at: [(o.cx ?? 0) + sx * (o.width / 2 - inset), (o.cz ?? 0) + sz * (o.depth / 2 - inset)], bottom: o.bottom, top: o.top, size, base: o.base, cap: o.cap },
      p,
    );
  }
}

/**
 * A quoin block wrapping a plan corner: the two outer faces, the chamfered
 * arris between them and a chamfer round the top — 23 triangles against the
 * 44 of a `roundedBox`, with the same soft shading. `at` = the body's
 * outer corner, `out` = which way is outward, `legs` = how far the stone
 * runs back along the x and the z wall.
 */
function quoinBlock(
  m: SolidMesh,
  o: { at: readonly [number, number]; out: readonly [number, number]; legs: readonly [number, number]; proud: number; bottom: number; top: number; chamfer?: number; closeBottom?: boolean },
  p: Paint,
): void {
  const c = o.chamfer ?? 0.09;
  const arris = c * 1.2;
  const k = c * (Math.SQRT2 - 1);
  const [lx, lz] = o.legs;
  const e = o.proud;
  // Plan ring in corner space (x, z outward positive), base and inset top.
  const base: [number, number][] = [[-lx, -lz], [e, -lz], [e, e - arris], [e - arris, e], [-lx, e]];
  const inset: [number, number][] = [[-lx + c, -lz + c], [e - c, -lz + c], [e - c, e - arris - k], [e - arris - k, e - c], [-lx + c, e - c]];
  const W = ([x, z]: readonly [number, number], y: number): Vector3 => new Vector3(o.at[0] + o.out[0] * x, y, o.at[1] + o.out[1] * z);
  const centre = W([(e - lx) / 2, (e - lz) / 2], 0);
  const n = base.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mid = W([(base[i][0] + base[j][0]) / 2, (base[i][1] + base[j][1]) / 2], 0);
    const outward = mid.subtract(centre);
    quadFacing(m, W(base[i], o.bottom), W(base[j], o.bottom), W(base[j], o.top - c), W(base[i], o.top - c), outward, p);
    quadFacing(m, W(base[i], o.top - c), W(base[j], o.top - c), W(inset[j], o.top), W(inset[i], o.top), outward.add(new Vector3(0, outward.length(), 0)), p);
  }
  polygonFacing(m, inset.map((q) => W(q, o.top)), new Vector3(0, 1, 0), p);
  if (o.closeBottom) polygonFacing(m, base.map((q) => W(q, o.bottom)), new Vector3(0, -1, 0), p);
}

export interface QuoinsOptions {
  /** The body's outer corner in plan (x, z) and which way is outward. */
  at: readonly [number, number];
  out: readonly [1 | -1, 1 | -1];
  bottom: number;
  top: number;
  /** Course height (default 0.34), long and short leg of the blocks. */
  course?: number;
  long?: number;
  short?: number;
  proud?: number;
}

/** Corner quoins: chunky blocks stacked up a corner, long and short legs
 * alternating between the two faces (about 180 triangles for a storey). */
export function quoins(m: SolidMesh, o: QuoinsOptions, p: Paint): void {
  const course = o.course ?? 0.34;
  const long = o.long ?? 0.5;
  const short = o.short ?? 0.3;
  const proud = o.proud ?? 0.05;
  const count = Math.max(1, Math.round((o.top - o.bottom) / course));
  const h = (o.top - o.bottom) / count;
  const sp = soften(p, 60);
  for (let i = 0; i < count; i++) {
    const y0 = o.bottom + i * h;
    // Each block's top chamfer against the next block's flat foot is the
    // joint. The feet are closed: quoins above eye level are seen from below.
    quoinBlock(m, { at: o.at, out: o.out, legs: i % 2 ? [long, short] : [short, long], proud, bottom: y0, top: y0 + h - 0.012, chamfer: 0.035, closeBottom: true }, sp);
  }
}

export interface TrimBandOptions {
  /** Size of the body the band runs round (its wall faces). */
  width: number;
  depth: number;
  cx?: number;
  cz?: number;
  /** Centre height, band height, and how far it stands out of the walls. */
  y: number;
  height: number;
  proud?: number;
  /** How far it reaches INTO the wall (default 0.06). */
  sink?: number;
  /** Rounding of the band's own section (default 30 % of the smaller side). */
  radius?: number;
  /** Plan corner radius, for bodies built with `cornerRadius`. */
  cornerRadius?: number;
}

/**
 * A continuous moulding round a box body, mitred at the corners: cornice
 * under a hip roof, inter-storey band, parapet coping, plinth cap.
 *   trimBand(m, { width: 5, depth: 4, y: 2.7, height: 0.3, proud: 0.12 }, P.trim);
 */
export function trimBand(m: SolidMesh, o: TrimBandOptions, p: Paint): void {
  const proud = o.proud ?? 0.1;
  const sink = o.sink ?? 0.06;
  const thick = proud + sink;
  // Offset of the band's centreline from the wall face.
  const off = (proud - sink) / 2;
  const radius = o.radius ?? Math.min(o.height, thick) * 0.3;
  const sp = soften(p, 45);
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const cr = o.cornerRadius ? Math.max(0, o.cornerRadius + off) : 0;
  if (cr > 0.02) {
    const ring = roundedRectRing(o.width + off * 2, o.depth + off * 2, cr, 3);
    sweep(m, { path: ring.map(([x, z]) => new Vector3(cx + x, o.y, cz + z)), closed: true, section: chamferRing(o.height, thick, radius * 0.7), up: [0, 1, 0] }, sp);
    return;
  }
  // Square plan: true mitres. A section point (height h, outward offset d)
  // sits at corner ± (half + d) on BOTH axes, which is exactly the mitre.
  // (The kit's sweep rounds 90° path corners, at six times the triangles.)
  const section = roundedRectRing(o.height, thick, radius, 2);
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const at = (k: number, j: number): Vector3 => {
    const [h, d] = section[j];
    const [sx, sz] = corners[k];
    return new Vector3(cx + sx * (o.width / 2 + off + d), o.y + h, cz + sz * (o.depth / 2 + off + d));
  };
  const n = section.length;
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    const mx = corners[k][0] + corners[k1][0];
    const mz = corners[k][1] + corners[k1][1];
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const hm = (section[j][0] + section[j1][0]) / 2;
      const dm = (section[j][1] + section[j1][1]) / 2;
      quadFacing(m, at(k, j), at(k, j1), at(k1, j1), at(k1, j), new Vector3((mx / 2) * dm, hm, (mz / 2) * dm), sp);
    }
  }
}

// ---------------------------------------------------------------------------
// Timber framing

export interface GableFramingOptions {
  on: Facade;
  /** u of the gable's centre (default 0) and its width at the base. */
  u?: number;
  width: number;
  /** Height of the gable's base line (the eave / wall top) and its rise. */
  base: number;
  rise: number;
  /** Timber section seen from the front (default 0.3) and how far it
   * stands out of the wall (default 0.08). */
  size?: number;
  proud?: number;
  /** Members (all default true): horizontal tie beam, king post to the
   * apex, the pair of struts fanning from the king post's foot, and the rake
   * boards that follow the roof. */
  tie?: boolean;
  king?: boolean;
  struts?: boolean;
  rakes?: boolean;
  /** How far ABOVE the base line the tie beam sits (default 0). The sheets'
   * cottages carry it about a third of the way up the gable: plaster below
   * it (room for a door canopy), boarded infill above — pair it with
   * `wallBox({ gableFrom: base + tieRaise })`. King post and struts then
   * stand on the raised beam; the rakes still run down to the eaves. */
  tieRaise?: number;
  /** Angle of the struts from the horizontal, degrees (default 45). */
  strutAngle?: number;
  /** Tie beam depth (default 1.25 × size). */
  tieSize?: number;
}

/**
 * The timber truss drawn in a gable (B01, B04, B08): tie beam, king post,
 * two struts and rake boards, lying on the wall and sunk 5 cm into it. Pair
 * it with `wallPanel({ gablePaint: P.timberDark })` for the boarded infill.
 */
export function gableFraming(m: SolidMesh, o: GableFramingOptions, p: Paint): void {
  const start = m.mark();
  const cu = o.u ?? 0;
  const hw = o.width / 2;
  const s = o.size ?? 0.3;
  const proud = o.proud ?? 0.08;
  const sink = 0.05;
  const zc = (proud - sink) / 2;
  const d = proud + sink;
  // Open-backed (the back third is in the wall) and ringed every ~1 m: both
  // ends of every member are buried in another one, and only vertices in
  // between can bake as open timber.
  const bar = (a: readonly [number, number], b: readonly [number, number], size = s, lift = 0): void => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    beam(m, { from: [a[0], a[1], zc + lift], to: [b[0], b[1], zc + lift], size: [size, d], side: [0, 0, 1], back: false, segments: Math.max(2, Math.round(len / 1.0)) }, p);
  };
  const apex: [number, number] = [cu, o.base + o.rise];
  // Unit vector down the right-hand rake and its inward normal.
  const len = Math.hypot(hw, o.rise);
  const dx = hw / len;
  const dy = -o.rise / len;
  if (o.rakes ?? true) {
    // Shifted half a board INTO the gable so they tuck under the roof; the
    // two meet on the centre line 1 / dx half-boards below the apex.
    for (const side of [1, -1]) {
      const nx = side * dy;
      const ny = -dx;
      bar([cu, apex[1] - s / (2 * dx)], [cu + side * (hw + dx * 0.12) + nx * s * 0.5, o.base + dy * 0.12 + ny * s * 0.5], s, -0.012);
    }
  }
  // The tie beam and what stands on it.
  const raise = Math.max(0, Math.min(o.tieRaise ?? 0, o.rise * 0.6));
  const tieY = o.base + raise;
  const hwT = hw * (1 - raise / o.rise);
  const tieSize = o.tieSize ?? s * 1.25;
  if (o.struts ?? true) {
    // From the king post's foot up to the rake at `strutAngle`.
    const t = Math.tan(((o.strutAngle ?? 45) * Math.PI) / 180);
    // rake: v = tieY + rise' · (1 − x / hwT);  strut: v = tieY + t · x
    const riseT = o.rise - raise;
    const x = (riseT * hwT) / (hwT * t + riseT);
    for (const side of [1, -1]) bar([cu, tieY + s * 0.25], [cu + side * (x + dx * 0.05), tieY + t * x + 0.02], s * 0.85, -0.006);
  }
  // The king post runs up INTO the meeting rakes: stopping short of them
  // leaves a dark notch under the apex.
  if (o.king ?? true) bar([cu, tieY], [cu, apex[1] - s * 0.3], s * 1.1, 0.004);
  if (o.tie ?? true) {
    // A raised tie beam dies into the rakes: its ends stop inside them (any
    // longer and its top corners come out through the roof).
    const reach = raise > 0.01 ? hwT - Math.min(0.15, hwT * 0.1) : hw;
    bar([cu - reach, tieY], [cu + reach, tieY], tieSize, 0.012);
  }
  toFacade(m, start, o.on);
}

export interface KneeBraceOptions {
  /** The inside corner where an upright meets a horizontal member. */
  at: readonly [number, number, number];
  /** Unit direction along the horizontal member, away from the upright. */
  along: readonly [number, number, number];
  /** Leg length of the brace down the post and along the beam (default 0.45). */
  reach?: number;
  size?: number;
}

/** A 45° knee brace in the corner between a post and a beam (porches,
 * pergolas, stilts, canopy brackets). */
export function kneeBrace(m: SolidMesh, o: KneeBraceOptions, p: Paint): void {
  const reach = o.reach ?? 0.45;
  const size = o.size ?? 0.12;
  const [x, y, z] = o.at;
  const [ax, ay, az] = o.along;
  // Overshoot both ends so they bury in the post and the beam.
  const e = size * 0.5;
  beam(
    m,
    {
      from: [x - ax * e, y - reach - e, z - az * e],
      to: [x + ax * (reach + e), y + ay * (reach + e) + e, z + az * (reach + e)],
      size,
      side: [az, 0, -ax],
    },
    p,
  );
}
