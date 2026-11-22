import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { blob, box, cylinder, frustum, quadFacing, rng, roundedBox, soften, sphere } from '../../../gfx/solid';
import type { Paint, SolidMesh } from '../../../gfx/solid';
import { toFacade } from './facade';
import type { Facade } from './facade';
import type { BuildingPaints } from './paints';
import { frameRing, pillow, plankPanel } from './shapes';
import { frameSegments, openingRing } from './walls';
import type { Opening } from './walls';

/**
 * Windows, shutters, doors and vents. Everything here FILLS an `Opening`
 * that `wallPanel` / `wallBox` cut: the glass or the door leaf sits at the
 * back of the reveal and is larger than the hole, so an opening is always
 * closed and the camera never sees into the building.
 */

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Frame ring + mullion bars + glass, set `recess` behind the wall face. */
function glazing(
  m: SolidMesh,
  op: Opening,
  o: { recess: number; frame: number; mullions: readonly [number, number]; framePaint: Paint; glass: Paint },
): void {
  const { u, v, w, h } = op;
  const zb = -o.recess;
  // Glass larger than the hole: its rim is buried in the wall.
  quadFacing(m, V(u - w / 2 - 0.03, v - 0.03, zb), V(u + w / 2 + 0.03, v - 0.03, zb), V(u + w / 2 + 0.03, v + h + 0.03, zb), V(u - w / 2 - 0.03, v + h + 0.03, zb), V(0, 0, 1), o.glass);
  const fd = Math.min(0.065, o.recess * 0.6);
  if (o.frame > 0) {
    // Grown 12 mm past the hole so its outer sides are buried, not coplanar
    // with the reveal.
    const segs = frameSegments(op.round ?? 0);
    frameRing(m, { inner: openingRing(op, -o.frame, 0, segs, true), outer: openingRing(op, 0.012, 0, segs, true), z0: zb, z1: zb + fd, bevel: 0.012 }, o.framePaint);
  }
  const [cols, rows] = o.mullions;
  const bar = o.frame > 0 ? o.frame * 0.72 : 0.05;
  // Bars sit a few mm behind the frame's face (and each other) so no two
  // front faces share a plane where they cross.
  for (let i = 1; i < cols; i++) {
    const x = u - w / 2 + (w * i) / cols;
    box(m, { min: [x - bar / 2, v + 0.01, zb], max: [x + bar / 2, v + h - 0.01, zb + fd - 0.008], faces: { nz: null, py: null, ny: null } }, o.framePaint);
  }
  for (let j = 1; j < rows; j++) {
    const y = v + (h * j) / rows;
    box(m, { min: [u - w / 2 + 0.01, y - bar / 2, zb], max: [u + w / 2 - 0.01, y + bar / 2, zb + fd - 0.014], faces: { nz: null, px: null, nx: null } }, o.framePaint);
  }
}

// ---------------------------------------------------------------------------
// Shutters

export interface ShutterOptions {
  on: Facade;
  /** The window opening the leaf belongs to. */
  opening: Opening;
  /** Which side of the window it hangs on: −1 = viewer's left, +1 = right. */
  side: 1 | -1;
  /** 'open' = folded flat against the wall beside the window; 'closed' =
   * covering its half of the window. */
  state?: 'open' | 'closed';
  planks?: number;
}

/**
 * One shutter leaf: boarded panel with two iron strap hinges. Each leaf is a
 * separate optional piece (brief) — `windowUnit({ shutters })` places the
 * usual pair.
 */
export function shutter(m: SolidMesh, o: ShutterOptions, P: BuildingPaints): void {
  const start = m.mark();
  const { u, v, w, h } = o.opening;
  const closed = o.state === 'closed';
  const leaf = w / 2 + 0.03;
  // Inner edge = the edge nearest the window centre when closed, the hinge
  // edge when open.
  const hinge = u + o.side * (w / 2 + 0.035);
  const x0 = closed ? (o.side < 0 ? u - leaf : u + 0.004) : o.side < 0 ? hinge - leaf : hinge;
  const x1 = x0 + leaf - (closed ? 0.004 : 0);
  const y0 = v + 0.025;
  const y1 = v + h + 0.02;
  const z1 = closed ? 0.05 : 0.06;
  plankPanel(m, { x0, x1, y0, y1, z0: 0, z1, planks: o.planks ?? 2, groove: 0.014 }, P.shutter);
  // Straps start at the hinge edge and run 60 % across the leaf.
  const strap = (x1 - x0) * 0.6;
  const hx = closed ? (o.side < 0 ? x0 : x1) : o.side < 0 ? x1 : x0;
  const dir = closed ? -o.side : o.side;
  for (const fy of [0.2, 0.8]) {
    const y = y0 + (y1 - y0) * fy;
    const a = hx - dir * 0.01;
    const b = hx + dir * strap;
    box(m, { min: [Math.min(a, b), y - 0.028, z1 - 0.004], max: [Math.max(a, b), y + 0.028, z1 + 0.014], faces: { nz: null } }, P.iron);
  }
  toFacade(m, start, o.on);
}

// ---------------------------------------------------------------------------
// Flower box

export interface FlowerBoxOptions {
  on: Facade;
  /** Centre, top of the box, and its length. */
  u: number;
  v: number;
  width: number;
  seed?: number;
  /** Box paint (default timber). */
  paint?: Paint;
}

/** A planter trough hung on the wall, with faceted foliage and a few
 * flowers — under a window sill (`windowUnit({ flowerBox })` places it). It
 * has no feet: do not stand it on the ground, use `planter` there. */
export function flowerBox(m: SolidMesh, o: FlowerBoxOptions, P: BuildingPaints): void {
  const start = m.mark();
  const r = rng(o.seed ?? 0, 'flowerbox', Math.round(o.u * 100));
  const depth = 0.26;
  roundedBox(m, { min: [o.u - o.width / 2, o.v - 0.24, -0.02], max: [o.u + o.width / 2, o.v, depth], radius: 0.035, segments: 1 }, o.paint ?? P.timber);
  const clumps = Math.max(2, Math.round(o.width / 0.36));
  for (let i = 0; i < clumps; i++) {
    const x = o.u - o.width / 2 + ((i + 0.5) / clumps) * o.width + r.range(-0.03, 0.03);
    const rad = r.range(0.13, 0.17);
    blob(m, { radii: [rad * 1.15, rad * 0.9, rad], points: 9, seed: r.int(1, 9999), jitter: 0.3, at: [x, o.v + rad * 0.35, depth * 0.5 + r.range(-0.02, 0.03)] }, r.chance(0.5) ? P.foliage : P.foliageLight);
    if (r.chance(0.75)) {
      const fp = r.chance(0.7) ? P.flower : P.flowerCenter;
      // An octahedron: at 5 cm nobody counts a flower's facets.
      sphere(m, { radius: 0.055, segments: 4, rings: 2, at: [x + r.range(-0.08, 0.08), o.v + rad * 1.05, depth * 0.5 + r.range(0.02, 0.1)] }, fp);
    }
  }
  toFacade(m, start, o.on);
}

// ---------------------------------------------------------------------------
// Window

export interface WindowOptions {
  on: Facade;
  opening: Opening;
  /** Glass depth behind the wall face (default 0.13). */
  recess?: number;
  /** Frame width (default 0.075; 0 = glass only). */
  frame?: number;
  /** Panes across and up (default 2 × 2; [1, 2] = one horizontal bar). */
  mullions?: readonly [number, number];
  /** Projecting sill block below and lintel block above (default both true;
   * ignored when `surround` is set, and no lintel on a rounded opening). */
  sill?: boolean;
  head?: boolean;
  /** Width of a thick surround framing the whole opening on the wall face —
   * the B05 / B06 / B10 window style. Rounded like the opening. */
  surround?: number;
  surroundPaint?: Paint;
  framePaint?: Paint;
  /** A pair of shutters (default 'none'). */
  shutters?: 'none' | 'open' | 'closed';
  /** Planter trough under the sill. */
  flowerBox?: boolean;
  /** Warm lit glass (evening variant, or the odd lived-in window). Amber is
   * close to the 'sunny' scheme's mustard wall: give such a window a frame
   * or a surround, which is what separates the two. */
  lit?: boolean;
  seed?: number;
}

/**
 * A complete window in its opening: dark glossy glass at the back of the
 * reveal, frame and mullions in front of it, cream sill and lintel (or a
 * full surround) on the wall face, optional shutters and flower box.
 *   windowUnit(m, { on: F.front, opening: W1, shutters: 'open' }, P);
 *   windowUnit(m, { on: F.left, opening: PILL, surround: 0.14, mullions: [1, 2], frame: 0 }, P);   // B05 pill
 */
export function windowUnit(m: SolidMesh, o: WindowOptions, P: BuildingPaints): void {
  const start = m.mark();
  const op = o.opening;
  const { u, v, w, h } = op;
  const closed = o.shutters === 'closed';
  const recess = o.recess ?? 0.13;
  glazing(m, op, {
    recess,
    // Behind closed shutters only the glass is kept (it still seals the hole).
    frame: closed ? 0 : (o.frame ?? 0.075),
    mullions: closed ? [1, 1] : (o.mullions ?? [2, 2]),
    framePaint: o.framePaint ?? P.frame,
    glass: o.lit ? P.glassLit : P.glass,
  });
  if (o.surround !== undefined && o.surround > 0) {
    // One chamfer step, softened: reads as a rounded edge at half the triangles.
    const outerR = Math.max((op.round ?? 0) + o.surround, Math.min(0.08, o.surround * 0.6));
    const segs = frameSegments(outerR);
    frameRing(
      m,
      { inner: openingRing(op, -0.012, 0.02, segs, true), outer: openingRing(op, o.surround, Math.min(0.08, o.surround * 0.6), segs, true), z0: -0.03, z1: 0.07, bevel: 0.03 },
      soften(o.surroundPaint ?? P.trim, 45),
    );
  } else {
    // Sill: reaches into the reveal with its top 15 mm above the reveal's
    // floor, so the two never share a plane.
    const block = soften(P.trim, 45);
    if (o.sill ?? true) pillow(m, { x0: u - w / 2 - 0.13, x1: u + w / 2 + 0.13, y0: v - 0.2, y1: v + 0.015, z0: -0.07, z1: 0.16, chamfer: 0.05 }, block);
    if ((o.head ?? true) && !op.round) pillow(m, { x0: u - w / 2 - 0.13, x1: u + w / 2 + 0.13, y0: v + h + 0.03, y1: v + h + 0.21, z0: -0.04, z1: 0.11, chamfer: 0.045 }, block);
  }
  toFacade(m, start, o.on);
  if (o.shutters === 'open' || o.shutters === 'closed') {
    shutter(m, { on: o.on, opening: op, side: -1, state: o.shutters }, P);
    shutter(m, { on: o.on, opening: op, side: 1, state: o.shutters }, P);
  }
  // Hung just under the sill's top, in front of the sill block.
  if (o.flowerBox) flowerBox(m, { on: o.on, u, v: v - 0.06, width: w + 0.34, seed: o.seed }, P);
}

// ---------------------------------------------------------------------------
// Door

export interface DoorOptions {
  on: Facade;
  opening: Opening;
  /** Depth of the leaf behind the wall face (default 0.1). */
  recess?: number;
  /** Boards per door (default 4; a double door splits them over two leaves). */
  planks?: number;
  /** Two leaves meeting in the middle (D02 / D03). */
  double?: boolean;
  /** Width of the surround on the wall face (default 0.13; 0 = none). */
  surround?: number;
  surroundPaint?: Paint;
  /** Leaf paint (default the scheme's door colour). */
  paint?: Paint;
  /** Round knob (default), vertical bar pulls, or none. */
  handle?: 'knob' | 'bar' | 'none';
  /** Knob side on a single door: +1 = viewer's right (default), −1 = left. */
  handleSide?: 1 | -1;
  /** Iron strap hinges across the boards (shed and shack doors). */
  hinges?: boolean;
  /** A glazed door instead of boards: panes across and up. */
  glazed?: readonly [number, number];
}

/**
 * A door in its opening: boarded leaf with V-grooves at the back of the
 * reveal, thick rounded surround on the wall face, oversized handle.
 *   const DOOR: Opening = { u: 0, v: 0.45, w: 1.0, h: 1.95, round: 0.12 };
 *   door(m, { on: F.front, opening: DOOR }, P);
 *   door(m, { on: F.front, opening: BARN, double: true, planks: 6, hinges: true, handle: 'bar' }, P);
 */
export function door(m: SolidMesh, o: DoorOptions, P: BuildingPaints): void {
  const start = m.mark();
  const op = o.opening;
  const { u, v, w, h } = op;
  const recess = o.recess ?? 0.1;
  const zf = -recess;
  const leafPaint = o.paint ?? P.door;
  if (o.glazed) {
    glazing(m, op, { recess: recess + 0.03, frame: 0.1, mullions: o.glazed, framePaint: leafPaint, glass: P.glass });
  } else {
    // The leaf is 2 cm larger than the hole all round (its rim is buried, no
    // light leaks past it), but its board FACES end inside the hole — clear
    // of the rounded head corners too — so every face vertex bakes in the open.
    const inside = Math.max(0.014, Math.min(op.round ?? 0, 0.25) * 0.3 + 0.006);
    plankPanel(
      m,
      { x0: u - w / 2 - 0.02, x1: u + w / 2 + 0.02, y0: v - 0.02, y1: v + h + 0.02, z0: zf - 0.05, z1: zf, planks: o.planks ?? 4, groove: 0.016, edge: 0.02 + inside, rim: false },
      leafPaint,
    );
  }
  const sw = o.surround ?? 0.13;
  if (sw > 0) {
    // Rounded at the head, square at the foot (it stands on the step); the
    // ring's lower bar doubles as the threshold. One chamfer step, softened:
    // reads as a rounded edge at half the triangles.
    const foot: Opening = { u, v: v - 0.03, w, h: h + 0.03, round: Math.max(op.round ?? 0, 0.02) };
    const segs = frameSegments((foot.round ?? 0) + sw);
    frameRing(
      m,
      { inner: openingRing({ ...op, round: Math.max(op.round ?? 0, 0.03) }, -0.012, 0, segs, true), outer: openingRing(foot, sw, 0, segs, true), z0: -0.03, z1: 0.08, bevel: 0.035 },
      soften(o.surroundPaint ?? P.trim, 45),
    );
  }
  const handle = o.handle ?? 'knob';
  const zh = o.glazed ? zf + 0.035 : zf;
  if (handle === 'knob') {
    // Oversized on purpose (style guide: "oversized readable handles").
    const sides: number[] = o.double ? [-1, 1] : [o.handleSide ?? 1];
    for (const s of sides) {
      const x = o.double ? u + s * 0.14 : u + s * (w / 2 - 0.2);
      const y = v + h * 0.44;
      // Backplate (rose), neck, knob.
      frustum(m, { from: [x, y, zh - 0.01], to: [x, y, zh + 0.022], radiusBottom: 0.12, radiusTop: 0.1, sides: 12, caps: 'top' }, P.metal);
      cylinder(m, { from: [x, y, zh + 0.01], to: [x, y, zh + 0.06], radius: 0.042, sides: 6, caps: false }, P.metal);
      sphere(m, { radius: 0.09, segments: 12, rings: 6, at: [x, y, zh + 0.1] }, P.metal);
    }
  } else if (handle === 'bar') {
    const sides: number[] = o.double ? [-1, 1] : [o.handleSide ?? 1];
    for (const s of sides) {
      const x = o.double ? u + s * 0.1 : u + s * (w / 2 - 0.16);
      const y = v + h * 0.47;
      roundedBox(m, { min: [x - 0.025, y - 0.2, zh - 0.01], max: [x + 0.025, y + 0.2, zh + 0.07], radius: 0.02, segments: 1 }, P.iron);
    }
  }
  if (o.hinges && !o.glazed) {
    const sides: number[] = o.double ? [-1, 1] : [-(o.handleSide ?? 1)];
    for (const s of sides) {
      for (const fy of [0.16, 0.84]) {
        const y = v + h * fy;
        const a = u + s * (w / 2 + 0.01);
        const b = u + s * (w / 2 - Math.min(0.34, w * 0.3));
        box(m, { min: [Math.min(a, b), y - 0.04, zf - 0.004], max: [Math.max(a, b), y + 0.04, zf + 0.016], faces: { nz: null } }, P.iron);
      }
    }
  }
  toFacade(m, start, o.on);
}

// ---------------------------------------------------------------------------
// Louvre vent

export interface VentOptions {
  on: Facade;
  /** Centre and size of the slatted field. */
  u: number;
  v: number;
  w: number;
  h: number;
  slats?: number;
}

/** A slatted wall vent with a rounded cream surround (rear walls of the
 * shed, garage and market hall). Mounted on the wall face — no opening needed. */
export function louvreVent(m: SolidMesh, o: VentOptions, P: BuildingPaints): void {
  const start = m.mark();
  const op: Opening = { u: o.u, v: o.v - o.h / 2, w: o.w, h: o.h, round: Math.min(o.w, o.h) * 0.2, roundAll: true };
  // Dark backing a few mm proud of the wall, so it never fights the wall face.
  quadFacing(m, V(o.u - o.w / 2, op.v, 0.006), V(o.u + o.w / 2, op.v, 0.006), V(o.u + o.w / 2, op.v + o.h, 0.006), V(o.u - o.w / 2, op.v + o.h, 0.006), V(0, 0, 1), P.iron);
  const n = Math.max(2, o.slats ?? 3);
  for (let i = 0; i < n; i++) {
    const y = op.v + ((i + 0.5) / n) * o.h;
    const t = (o.h / n) * 0.3;
    // Slat ends run into the surround (their end faces are left out).
    box(m, { min: [o.u - o.w / 2, y - t, 0.006], max: [o.u + o.w / 2, y + t, 0.04], faces: { nz: null, px: null, nx: null } }, P.trim);
  }
  frameRing(m, { inner: openingRing(op, -0.01, 0, 2, true), outer: openingRing(op, 0.09, 0, 2, true), z0: -0.02, z1: 0.065, bevel: 0.025 }, soften(P.trim, 45));
  toFacade(m, start, o.on);
}
