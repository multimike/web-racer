import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, hex, paint, quadFacing, revolve, thicken } from '../../gfx/solid';
import type { Paint, RGB, Vec2 } from '../../gfx/solid';

/**
 * Shared parts of the track-side dressing (d01…d06, d20+): the race colours
 * that are not in the design-pack palette, checkered cloth that flutters,
 * and a chunky tire.
 */

/** Race-day colours sampled from the gameplay-vision images. */
export const TRACK = {
  /** Checkered flags and fence banners: a slightly deeper teal than the
   * house turquoise, so white squares read on it in full sun. */
  teal: hex('#16A3A6'),
  /** The warm white of the checker squares (never pure white). */
  white: hex('#FBF4E4'),
  /** Chevron board face. */
  navy: hex('#232F63'),
  /** Chevron arrows. */
  chevron: hex('#FFC52B'),
  /** Garage bollards: a touch more orange than the building mustard. */
  bollard: hex('#F5B21E'),
  /** Poles, sign legs, lamp hoods: warm dark iron, not black. */
  iron: hex('#54464C'),
  /** Flag-pole finial ball: dark bronze, as on the vision's poles. */
  bronze: hex('#9C6A3C'),
  /** Warm lamp glass. Much deeper than the amber it should glow: emission
   * adds light on top of the albedo and washes it toward yellow-white. */
  lamp: hex('#FF7F1E'),
  /** The darker amber of a lamp's bezel / glass edge. */
  lampRim: hex('#C2601C'),
  /** Kerb and plinth stone joints, shaded cream. */
  creamShade: hex('#D9C3A6'),
} as const satisfies Record<string, RGB>;

export const IRON = paint(TRACK.iron, { gloss: 0.35 });
/** Warm, never white, never full emissive on a broad face. */
export const LAMP = paint(TRACK.lamp, { gloss: 0.5, emissive: 0.5 });
/** Unlit amber around a lamp, so it reads as glass in a housing. */
export const LAMP_RIM = paint(TRACK.lampRim, { gloss: 0.55 });

type V3 = readonly [number, number, number];

export interface ClothOptions {
  /** Corner where the fixed edge starts (s = 0, t = 0). */
  origin: V3;
  /** Unit direction of the columns (s) and of the rows (t), and the unit
   * normal the waves move along. */
  u: V3;
  v: V3;
  n: V3;
  cols: number;
  rows: number;
  /** Cell size along u and along v, meters. */
  cell: readonly [number, number];
  /** Individual column widths / row heights, when the cells are not all the
   * same (a narrow margin round a checker). They override `cell`. */
  colSizes?: readonly number[];
  rowSizes?: readonly number[];
  /** Grid points per cell along u / v (default 1). Colour boundaries stay on
   * cell edges; more points only smooth the waves. */
  subU?: number;
  subV?: number;
  /** Static pose: offset along `n` in meters at (s, t) in 0..1. */
  wave?: (s: number, t: number) => number;
  /** Static pose: how far the point hangs down (−y), meters. */
  droop?: (s: number, t: number) => number;
  /** Static pose: how far the point is drawn back toward the fixed edge
   * (−u), meters — cloth that sags or folds does not get longer. */
  slack?: (s: number, t: number) => number;
  /** Paint of a cell. */
  paint: (col: number, row: number) => Paint;
  thickness?: number;
  /** Wind weight at (s, t): 0 on the fixed edge, 1 on the free edge. */
  wind: (s: number, t: number) => number;
}

/**
 * A rectangle of cloth as a grid of cells, each cell one paint (checkers are
 * simply the cell pattern — crisp, no textures), given real thickness so it
 * is a closed shell that looks right from both sides and casts a shadow.
 * Wind weights are written from (s, t), recovered from the vertex position:
 * thicken resets them, and `setWind` only sees positions.
 */
export function cloth(m: SolidMesh, o: ClothOptions): void {
  const subU = o.subU ?? 1;
  const subV = o.subV ?? 1;
  const nu = o.cols * subU;
  const nv = o.rows * subV;
  // Running edge positions of the grid lines, so cells may differ in size.
  const edges = (count: number, sub: number, size: number, sizes?: readonly number[]): number[] => {
    const out = [0];
    for (let c = 0; c < count; c++) {
      const w = sizes ? sizes[c] : size;
      const from = out[out.length - 1];
      for (let k = 1; k <= sub; k++) out.push(from + (w * k) / sub);
    }
    return out;
  };
  const us = edges(o.cols, subU, o.cell[0], o.colSizes);
  const vs = edges(o.rows, subV, o.cell[1], o.rowSizes);
  const W = us[nu];
  const H = vs[nv];
  const O = new Vector3(...o.origin);
  const U = new Vector3(...o.u);
  const V = new Vector3(...o.v);
  const N = new Vector3(...o.n);
  const at = (i: number, j: number): Vector3 => {
    const s = us[i] / W;
    const t = vs[j] / H;
    const p = O.add(U.scale(us[i] - (o.slack ? o.slack(s, t) : 0))).addInPlace(V.scale(vs[j]));
    if (o.wave) p.addInPlace(N.scale(o.wave(s, t)));
    if (o.droop) p.y -= o.droop(s, t);
    return p;
  };
  const start = m.mark();
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const p = o.paint(Math.floor(i / subU), Math.floor(j / subV));
      quadFacing(m, at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1), N, p);
    }
  }
  thicken(m, { thickness: o.thickness ?? 0.025, side: 'both', from: start });
  m.setWind((p) => {
    const d = p.subtract(O);
    const s = Math.min(1, Math.max(0, Vector3.Dot(d, U) / W));
    const t = Math.min(1, Math.max(0, Vector3.Dot(d, V) / H));
    return Math.min(1, Math.max(0, o.wind(s, t)));
  }, start);
}

/** Checker rule shared by flags and banners: `a` where col + row is even. */
export function checker(a: Paint, b: Paint, phase = 0): (col: number, row: number) => Paint {
  return (col, row) => ((col + row + phase) % 2 === 0 ? a : b);
}

export interface TireOptions {
  /** Centre of the tire. */
  at: V3;
  /** Outer radius, bore radius and width (along the axle), meters. */
  radius: number;
  bore: number;
  width: number;
  segments: number;
  /** Tilt in degrees about x and z, and a turn about its own axle first. */
  tilt?: readonly [number, number];
  turn?: number;
  /** Which of the faces that a stack hides are built: the sidewall facing
   * down, the sidewall facing up, the bore. All default to true. */
  bottom?: boolean;
  top?: boolean;
  boreWall?: boolean;
  /** Close the bore with a dark floor part-way down, so one cannot look
   * through a stack whose lower tires carry no bore wall. */
  floor?: Paint;
}

/**
 * A chunky tire lying flat (axle along +Y): tread wall, two broad shoulders,
 * sidewalls and bore; 12 triangles per segment complete, 6 with both
 * sidewalls and the bore left out. The shoulders are 45° chamfers that SHADE
 * round (the paint's crease angle is opened past 45°), so the tire reads as
 * an inflated ring at three bands.
 *
 * Stacking with the hidden faces left out: sink the upper tire into the
 * lower one by `overlap` and keep its sideways offset under that — then each
 * open rim lies inside the other tire's solid and nothing shows.
 */
export function tire(m: SolidMesh, o: TireOptions, rubberIn: Paint): void {
  const R = o.radius;
  const r = o.bore;
  const h = o.width / 2;
  const c = tireShoulder(o.radius, o.bore, o.width);
  const rubber = paint(rubberIn, { smooth: 55 });
  // Walked counter-clockwise (radius right, y up): bottom sidewall outward,
  // shoulder, tread up, shoulder, top sidewall inward, bore down.
  const profile: Vec2[] = [
    [r, -h],
    [R - c, -h],
    [R, -h + c],
    [R, h - c],
    [R - c, h],
    [r, h],
  ];
  const skip = [!(o.bottom ?? true), false, false, false, !(o.top ?? true), !(o.boreWall ?? true)];
  const start = m.mark();
  revolve(m, { profile, closed: true, segments: o.segments }, (band) => (skip[band] ? null : rubber));
  if (o.floor) {
    // One quad is enough: its corners end inside the hollow of the tire,
    // where only the bore can show them.
    const y = -h * 0.5;
    const e = r * 1.04;
    quadFacing(m, new Vector3(-e, y, -e), new Vector3(e, y, -e), new Vector3(e, y, e), new Vector3(-e, y, e), new Vector3(0, 1, 0), o.floor);
  }
  if (o.turn) m.rotate('y', o.turn, start);
  if (o.tilt) {
    m.rotate('x', o.tilt[0], start);
    m.rotate('z', o.tilt[1], start);
  }
  m.translate([o.at[0], o.at[1], o.at[2]], start);
}

/** Width of a tire's shoulder chamfer (its radial and axial extent). */
export function tireShoulder(radius: number, bore: number, width: number): number {
  return Math.min(width * 0.3, (radius - bore) * 0.45);
}
