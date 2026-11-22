import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Cage, SolidMesh, paintDecal, toV3 } from '../../../gfx/solid';
import type { Paint, Vec2, Vec3 } from '../../../gfx/solid';

/**
 * Shell-building helpers for the Neon Wasp's yellow panels.
 *
 * The sheet draws every panel as a THICK plate with a fully rounded rim
 * (moulded toy plastic), folded along one or two soft lines. `softPanel`
 * makes exactly that from a small grid of control points: a closed
 * Catmull-Clark slab whose rim rounds itself, with a border loop that sets
 * how tight the corners and the rim are.
 */

export interface SoftPanelOptions {
  /** Outer-skin control points, `grid[row][column]`; every row the same
   * length. Corners are rounded, so the built panel is a little smaller. */
  grid: readonly (readonly Vec3[])[];
  /** Wall thickness: the inner skin is this far behind the outer one. */
  thickness: number;
  /** Any direction pointing roughly out of the outer skin. */
  out: Vec3;
  /** Distance of the border loop from the outline, meters — the plan radius
   * of the corners (default 0.03). */
  round?: number;
  /** Catmull-Clark levels (default 2). */
  levels?: number;
  /** Rows / columns of `grid` that are FOLD lines, and how sharp (crease
   * sharpness, default 1 = a soft fold). */
  foldRows?: readonly number[];
  foldCols?: readonly number[];
  fold?: number;
  /** Paint of the inner skin (default: the outer paint). */
  inner?: Paint;
}

/** Insert a point `d` meters in from each end of a polyline. */
function insetEnds(line: Vector3[], d: number): Vector3[] {
  const n = line.length;
  const a = line[0];
  const b = line[n - 1];
  const stepIn = (from: Vector3, to: Vector3): Vector3 => {
    const len = Vector3.Distance(from, to);
    // Never past 45 % of the first span: the loop must stay between its neighbours.
    return Vector3.Lerp(from, to, Math.min(0.45, d / Math.max(len, 1e-6)));
  };
  return [a, stepIn(a, line[1]), ...line.slice(1, n - 1), stepIn(b, line[n - 2]), b];
}

/**
 * A thick, soft-edged panel (closed shell) appended to `m`. Returns the mark
 * the panel starts at, for region paint.
 */
export function softPanel(m: SolidMesh, o: SoftPanelOptions, p: Paint): number {
  const start = m.mark();
  const round = o.round ?? 0.03;
  // Border loops: first along every row, then along every column.
  const rows = o.grid.map((row) => insetEnds(row.map((q) => toV3(q).clone()), round));
  const C = rows[0].length;
  const cols: Vector3[][] = [];
  for (let c = 0; c < C; c++) cols.push(insetEnds(rows.map((row) => row[c]), round));
  const R = cols[0].length;
  const P = (r: number, c: number): Vector3 => cols[c][r];

  const out = toV3(o.out);
  const cage = new Cage();
  const outer: number[][] = [];
  const inner: number[][] = [];
  for (let r = 0; r < R; r++) {
    outer.push([]);
    inner.push([]);
    for (let c = 0; c < C; c++) {
      const du = P(r, Math.min(c + 1, C - 1)).subtract(P(r, Math.max(c - 1, 0)));
      const dv = P(Math.min(r + 1, R - 1), c).subtract(P(Math.max(r - 1, 0), c));
      const n = Vector3.Cross(du, dv).normalize();
      if (Vector3.Dot(n, out) < 0) n.scaleInPlace(-1);
      outer[r].push(cage.vertex(P(r, c)));
      inner[r].push(cage.vertex(P(r, c).subtract(n.scale(o.thickness))));
    }
  }
  const IN = o.inner ?? p;
  cage.patch(outer, p);
  cage.patch(inner, IN, true);
  for (let c = 0; c + 1 < C; c++) {
    cage.face([outer[0][c], outer[0][c + 1], inner[0][c + 1], inner[0][c]], p);
    cage.face([outer[R - 1][c], outer[R - 1][c + 1], inner[R - 1][c + 1], inner[R - 1][c]], p);
  }
  for (let r = 0; r + 1 < R; r++) {
    cage.face([outer[r][0], outer[r + 1][0], inner[r + 1][0], inner[r][0]], p);
    cage.face([outer[r][C - 1], outer[r + 1][C - 1], inner[r + 1][C - 1], inner[r][C - 1]], p);
  }
  // Folds, given in the ORIGINAL grid's indices (the border loop shifted
  // everything but the first row / column by one).
  const moved = (i: number, count: number): number => (i === 0 ? 0 : i === count - 3 ? count - 1 : i + 1);
  const sharp = o.fold ?? 1;
  for (const r0 of o.foldRows ?? []) {
    const r = moved(r0, R);
    cage.creasePath(outer[r], sharp);
    cage.creasePath(inner[r], sharp);
  }
  for (const c0 of o.foldCols ?? []) {
    const c = moved(c0, C);
    cage.creasePath(outer.map((row) => row[c]), sharp);
    cage.creasePath(inner.map((row) => row[c]), sharp);
  }
  cage.emit(m, { levels: o.levels ?? 2 });
  return start;
}

/**
 * Paint a decal on a FLANK, drawn in car side-view coordinates: outline
 * points are [z, y] in model space. `side` +1 = the right flank (seen from
 * +x), −1 = the left. The kit wants outlines "as seen", and from the right
 * the nose points to the viewer's right, from the left to the viewer's left.
 */
export function flankDecal(m: SolidMesh, outlineZY: readonly Vec2[], side: 1 | -1, from: number, p: Paint | null, maxAngle = 70): void {
  paintDecal(
    m,
    {
      outline: outlineZY.map(([z, y]) => [side * z, y] as Vec2),
      facing: side > 0 ? '+x' : '-x',
      maxAngle,
      from,
    },
    p,
  );
}

/** A slanted bar (parallelogram) in side-view coordinates: from the point
 * `a` to `b` along its centre line, `width` measured along z. */
export function slantBar(a: Vec2, b: Vec2, width: number): Vec2[] {
  const h = width / 2;
  return [
    [a[0] - h, a[1]],
    [a[0] + h, a[1]],
    [b[0] + h, b[1]],
    [b[0] - h, b[1]],
  ];
}
