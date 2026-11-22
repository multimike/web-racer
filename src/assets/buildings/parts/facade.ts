import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Matrix } from '@babylonjs/core/Maths/math.vector';
import { compose, facingFrame, translation } from '../../../gfx/solid';
import type { SolidMesh } from '../../../gfx/solid';

/**
 * FACADE SPACE — how everything that hangs on a wall is placed.
 *
 * A `Facade` is one outer wall plane of a building. Parts mounted on it
 * (wall panels, windows, doors, lamps, signs, awnings, balconies) are given
 * in the wall's own elevation drawing, exactly as the design sheets and the
 * briefs' opening schedules describe them:
 *
 *   u   meters to the VIEWER'S RIGHT of the facade centre, standing outside
 *       and looking at the wall
 *   v   meters above the ground (model y — not above the plinth)
 *   w   meters OUT of the wall toward the viewer (0 = the wall surface,
 *       negative = sunk into the wall / reveal)
 *
 * So "front: one window either side of the door" is u = ±1.8 on the front
 * facade, and it is still u = ±1.8 when the same line is used on the back
 * facade (where the viewer's right happens to be model −x).
 *
 * The four facades of a box body (`boxFacades(width, depth)`):
 *   front   faces −z (the street / door side)      viewer's right = +x
 *   back    faces +z                               viewer's right = −x
 *   right   faces +x (right in the FRONT view)     viewer's right = +z
 *   left    faces −x                               viewer's right = −z
 */

export type WallFacing = '-z' | '+z' | '+x' | '-x';

export interface Facade {
  facing: WallFacing;
  /** Distance of the wall surface from the model origin along `facing`. */
  plane: number;
  /** Model coordinate of the facade's u = 0 line along the wall (x for ±z
   * facades, z for ±x facades). Default 0. */
  center?: number;
}

/** Facade space (u, v, w) → model space. A MIRROR (like the kit's
 * `facingFrame`), which `SolidMesh.transform` handles: winding stays outward. */
export function facadeMatrix(f: Facade): Matrix {
  const c = f.center ?? 0;
  const t =
    f.facing === '-z' ? translation(c, 0, -f.plane)
    : f.facing === '+z' ? translation(c, 0, f.plane)
    : f.facing === '+x' ? translation(f.plane, 0, c)
    : translation(-f.plane, 0, c);
  return compose(facingFrame(f.facing), t);
}

/** Move everything added since `start` from facade space onto the facade. */
export function toFacade(m: SolidMesh, start: number, f: Facade): void {
  m.transform(facadeMatrix(f), start);
}

/** A facade-space point in model space. */
export function facadePoint(f: Facade, u: number, v: number, w = 0): Vector3 {
  return Vector3.TransformCoordinates(new Vector3(u, v, w), facadeMatrix(f));
}

/** The same facade moved `w` meters outward (a porch front, a second skin). */
export function offsetFacade(f: Facade, w: number, shiftU = 0): Facade {
  // u runs along +x on the front and +z on the right facade, the other way on back / left.
  const sign = f.facing === '-z' || f.facing === '+x' ? 1 : -1;
  return { facing: f.facing, plane: f.plane + w, center: (f.center ?? 0) + sign * shiftU };
}

export interface BoxFacades {
  front: Facade;
  back: Facade;
  left: Facade;
  right: Facade;
}

/** The four facades of a `width` (x) × `depth` (z) box centred on (cx, cz). */
export function boxFacades(width: number, depth: number, cx = 0, cz = 0): BoxFacades {
  return {
    front: { facing: '-z', plane: depth / 2 - cz, center: cx },
    back: { facing: '+z', plane: depth / 2 + cz, center: cx },
    right: { facing: '+x', plane: width / 2 + cx, center: cz },
    left: { facing: '-x', plane: width / 2 - cx, center: cz },
  };
}
