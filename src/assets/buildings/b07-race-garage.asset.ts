import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, extrudePolygon, frame, hex, loft, mix, paint, quadFacing, ringXZ, roundedBox, roundedRectRing, shade, soften, sphere, torus } from '../../gfx/solid';
import type { Paint, RGB, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import {
  beam,
  boxFacades,
  door,
  emblem,
  finishBuilding,
  frameRing,
  openingRing,
  rib,
  schemePaints,
  stoneBlock,
  stoneCourse,
  toFacade,
  variantPaints,
  variation,
  wallPanel,
  withPaints,
} from './parts';
import type { BuildingPaints, Facade, Opening } from './parts';

/**
 * B07 — Race Garage. Two-bay cobalt garage under a silver barrel roof, held
 * between two orange arch frames (leg · bolted knuckle · arch) that stand on
 * cream blocks and lavender corner stones; cream bay surrounds with rolled-up
 * orange shutters, cyan strip lamps sitting on the surround heads, a big
 * cream spanner under a cream arch band, a teal personnel door with a warm
 * bulkhead lamp on the right wall, two louvre vents at the back, one solar
 * panel on the crown.
 *
 * Sheet scheme: COASTAL slot (the blue-walled one), overridden with the
 * sheet's own cobalt walls, silver roof and orange frames / shutters — the
 * style guide keeps "brighter cobalt / orange mainly for the garage". 'warm'
 * (cream walls, coral roof) takes the guide's TEAL frames for every trim
 * piece (cream trim on cream plaster vanishes); 'sunny' (mustard walls, teal
 * roof, coral frames) builds with the guide's colours.
 *
 * MAIN BODY 9.0 (x) × 7.0 (z) m, crown of the arch frames at 4.8 m.
 * OVERALL ≈ 9.72 × 7.88 m over the corner stones, 5.3 m to the top edge of
 * the propped solar panel — inside the brief's 10 × 8 m envelope, as is
 * every seed's dressing.
 *
 * ROOF — THE BRIEF'S RESOLUTION. The sheet draws the barrel three ways; the
 * brief fixes its axis along the depth (+z here): front and rear are the
 * arched ends, the side eaves are straight. The profile is a CIRCULAR
 * segment (the sheet's end arch keeps curving right over the crown) 9.12 m
 * wide, springing at 3.55 m at about 28° and cresting at 4.68 m, under the
 * 4.8 m arch frames. Seams are hoops parallel to the arch frames, as in the
 * sheet's top view.
 *
 * BAYS. Centres x = ±2.1, 3.2 m wide (brief). The framed opening is 2.8 m
 * high and the rolled shutter hangs 0.48 m into it, so the clear height is
 * 2.32 m, not the brief's 3.0 m: brief and sheet conflict here, and this
 * follows the SHEET (it draws a ≈ 2.7 m opening, ≈ 2.1 m clear), because a
 * 3 m opening leaves no room under a 4.8 m crown for the strip lamps, the
 * spanner and the cream arch the sheet stacks over the bays. `BAY_TOP` and
 * `SHUTTER_DROP` are the numbers to change; the colliders follow them.
 * Widest buggy 2.25 m wide × 2 m high: 0.47 m to spare each side, 0.32 m
 * overhead. The interior is one closed, charcoal-lined room 7.6 × 6.1 m
 * (brief: 6 m clear depth) with a warm strip lamp on the back wall of each
 * bay, and the colliders leave both bays drivable.
 *
 * Opening schedule (brief): front = two bays; right wall = personnel door
 * (1.0 × 2.2 m, at floor level — the plinth is cut for it); rear = two high
 * vents; left = plain.
 *
 * Seeds (the game instantiates 0 – 2): 0 = the sheet. 1 = left bay shut, no
 * solar panel, a red roller cabinet and a tyre stack at the back of the open
 * right bay. 2 = solar panel on the rear half, yellow bollards at the bay
 * piers, the roller cabinet in the left bay. Door colour cycles with the
 * scheme (`variantPaints`); vent and lamp sizes shift a few centimeters. All
 * dressing stays inside the 10 × 8 m lot envelope.
 */

const W = 9.0;
const D = 7.0;
const PLINTH = 0.5;
/** Wall thickness = depth of the bay reveals. */
const T = 0.3;

// Roof profile: a circular segment through the spring line and the crown.
const SPRING = 3.55;
const ROOF_TOP = 4.68;
const ROOF_A = W / 2 + 0.06;
const ROOF_RISE = ROOF_TOP - SPRING;
const ROOF_R = (ROOF_A * ROOF_A + ROOF_RISE * ROOF_RISE) / (2 * ROOF_RISE);
/** Height of the circle's centre (far below ground). */
const ROOF_CY = ROOF_TOP - ROOF_R;
const ROOF_HALF_ANGLE = Math.asin(ROOF_A / ROOF_R);
/** Profile segments, evenly spaced on the circle (4° apart: the hoops'
 * silhouette stays round even in close-up). */
const ROOF_SEGS = 14;
/** The arch frames stand this far above the roof skin (crown at 4.8 m)… */
const FRAME_RISE = 0.12;
/** …and reach this far below it: a 0.48 m flat strap, as on the sheet. */
const FRAME_IN = 0.36;
/** Frame: how far its face stands out of the end wall, how far it reaches
 * back over the roof. */
const FRAME_PROUD = 0.22;
const FRAME_BACK = 0.35;

// Cream belt at the eaves (and straight across the back), centred on the knuckles.
const BELT_Y = 3.38;
const BELT_H = 0.36;

/** Width of the cream arch over the spanner. */
const ARCH_W = 0.24;

// Bays.
const BAY_X = 2.1;
const BAY_W = 3.2;
const BAY_TOP = 2.8;
const SHUTTER_DROP = 0.48;
const SURROUND = 0.232;
const SURROUND_PROUD = 0.14;
/** Top of the bay surrounds' heads. */
const SURROUND_TOP = BAY_TOP - 0.012 + SURROUND;

// Corner assemblies: stone, cream block, leg, knuckle (per corner, mirrored).
/** Inner face of the legs: 0.16 m of blue wall shows between them and the
 * bay surrounds (outer edge 3.92), as on the sheet. */
const LEG_IN = 4.08;
/** Outer faces of a leg under the knuckle and at its foot (0.22 m splay). */
const LEG_TOP_X = W / 2 + 0.04;
const LEG_FOOT_X = LEG_TOP_X + 0.22;
const KNUCKLE: readonly [number, number] = [2.95, 3.8];
/** Knuckle's outer face (it is wider than the strap it clamps). */
const KNUCKLE_X = W / 2 + 0.22;
const BASE_TOP = 0.85;

/** z of the room's back liner (6.1 m behind the front wall's inner face). */
const BACK_LINER = D / 2 - 0.6;

/** Half-width of the lined room (bay jambs at 3.7, corner legs from 4.01). */
const ROOM_X = 3.82;

/** Personnel door on the right wall (u < 0 = toward the front). */
const DOOR: Opening = { u: -1.7, v: 0.05, w: 1.0, h: 2.2, round: 0.12 };

const ORANGE: RGB = hex('#F2842A');
const BOLLARD_YELLOW: RGB = hex('#F2C230');
const WHITE: RGB = [1, 1, 1];

function choices(seed: number) {
  const v = variation(seed, 'b07');
  return {
    v,
    /** Which bay has its shutter down (0 = none). */
    shut: v.cycle([0, -1, 0] as const),
    solar: v.cycle(['front', 'none', 'back'] as const),
    /** Stores at the back of a bay (the vision's garage keeps a red roller
     * cabinet and tyres in each): which bay, and whether tyres come with it.
     * Everything stays inside the walls — the lot envelope is only 12 cm
     * wider than the corner stones. */
    chest: v.cycle([0, 1, -1] as const),
    tyres: v.cycle([false, true, false] as const),
    bollards: v.cycle([false, false, true] as const),
    ventW: 1.7 + v.shift('ventW', 0.08),
    lampW: 0.95 + v.shift('lampW', 0.08),
  };
}

/**
 * The sheet's spanner, unit length: two round open-end heads on a 0.11
 * handle, both jaws opening straight outward — mirror symmetric, as drawn.
 * Each head is a 9 + 9 segment arc with a round-bottomed slot. The kit's
 * `EMBLEMS.wrench` is drawn for signboards; at 2.3 m its five-chord heads
 * show as octagons.
 */
const WRENCH: Vec2[] = ((): Vec2[] => {
  const R = 0.16;
  const cx = 0.5 - R;
  const hh = 0.055;
  const slot = 0.055;
  const b = Math.asin(hh / R);
  const a = Math.asin(slot / R);
  const head: Vec2[] = [];
  const arc = (from: number, to: number, n: number): void => {
    for (let i = 0; i <= n; i++) {
      const t = from + ((to - from) * i) / n;
      head.push([cx + Math.cos(t) * R, Math.sin(t) * R]);
    }
  };
  // Right head, counter-clockwise from the handle's underside: lower jaw,
  // round slot floor (centred a little right of the head's centre), upper jaw.
  arc(Math.PI + b, 2 * Math.PI - a, 9);
  const floorX = cx + 0.03;
  const jawX = cx + Math.cos(a) * R;
  for (let i = 0; i <= 4; i++) {
    const t = -Math.PI / 2 - (i / 4) * Math.PI;
    head.push([Math.min(jawX - 0.004, floorX + Math.cos(t) * slot), Math.sin(t) * slot]);
  }
  arc(a, Math.PI - b, 9);
  return [...head, ...head.map(([x, y]): Vec2 => [-x, y]).reverse()];
})();

// ---------------------------------------------------------------------------
// Roof profile

interface Station {
  /** Point on the roof skin in the front elevation (x, y) and its outward unit normal. */
  p: Vec2;
  n: Vec2;
}

/** The roof skin's profile from the right spring over the crown to the left. */
function roofStations(): Station[] {
  const out: Station[] = [];
  for (let i = 0; i <= ROOF_SEGS; i++) {
    const t = ROOF_HALF_ANGLE * (1 - (2 * i) / ROOF_SEGS);
    const n: Vec2 = [Math.sin(t), Math.cos(t)];
    out.push({ p: [ROOF_R * n[0], ROOF_CY + ROOF_R * n[1]], n });
  }
  return out;
}

/** Height of the roof skin above plan x. */
function roofY(x: number): number {
  return Math.abs(x) >= ROOF_A ? SPRING : ROOF_CY + Math.sqrt(ROOF_R * ROOF_R - x * x);
}

/** Half-width of the roof skin at height y (for the stacked colliders). */
function roofHalfAt(y: number): number {
  return y <= SPRING ? ROOF_A : Math.sqrt(Math.max(0, ROOF_R * ROOF_R - (y - ROOF_CY) ** 2));
}

const offset = (s: Station, d: number): Vec2 => [s.p[0] + s.n[0] * d, s.p[1] + s.n[1] * d];

// ---------------------------------------------------------------------------
// Band: an open section swept along a path lying on a facade

interface BandOptions {
  on: Facade;
  /** Centreline in the facade's (u, v), travelling COUNTER-CLOCKWISE as seen
   * (right foot → head → left foot): the band's outer side is then on the
   * right of the direction of travel, which is where +a of the section goes. */
  path: readonly Vec2[];
  /** Open section, (a, w): a = meters outward across the band, w = out of
   * the wall. One for the whole band or one per path station. */
  section: readonly Vec2[] | ((i: number) => readonly Vec2[]);
}

/**
 * A moulding that follows a line on a wall — bay surrounds, the cream arch,
 * the arch frames. Mitred at every station, open where it is buried (the
 * section's two ends), so it spends triangles on visible faces only. With a
 * softened paint the chamfers of the section shade as rounded edges.
 */
function band(m: SolidMesh, o: BandOptions, p: Paint): void {
  const start = m.mark();
  const n = o.path.length;
  // Right-hand normal of each segment, then the mitre at each station.
  const seg: Vec2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = o.path[i + 1][0] - o.path[i][0];
    const dy = o.path[i + 1][1] - o.path[i][1];
    const l = Math.hypot(dx, dy) || 1;
    seg.push([dy / l, -dx / l]);
  }
  const mitre: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = seg[Math.max(0, i - 1)];
    const b = seg[Math.min(n - 2, i)];
    const mx = a[0] + b[0];
    const my = a[1] + b[1];
    const l = Math.hypot(mx, my) || 1;
    const k = 1 / Math.max(0.5, (mx * a[0] + my * a[1]) / l);
    mitre.push([(mx / l) * k, (my / l) * k]);
  }
  const section = (i: number): readonly Vec2[] => (typeof o.section === 'function' ? o.section(i) : o.section);
  const at = (i: number, q: Vec2): Vector3 => new Vector3(o.path[i][0] + mitre[i][0] * q[0], o.path[i][1] + mitre[i][1] * q[0], q[1]);
  for (let i = 0; i + 1 < n; i++) {
    const s0 = section(i);
    const s1 = section(i + 1);
    let ca = 0;
    let cw = 0;
    for (const q of s0) {
      ca += q[0] / s0.length;
      cw += q[1] / s0.length;
    }
    for (let j = 0; j + 1 < s0.length; j++) {
      // Outward in the section plane = away from the section's centroid.
      let na = s0[j + 1][1] - s0[j][1];
      let nw = -(s0[j + 1][0] - s0[j][0]);
      if (na * ((s0[j][0] + s0[j + 1][0]) / 2 - ca) + nw * ((s0[j][1] + s0[j + 1][1]) / 2 - cw) < 0) {
        na = -na;
        nw = -nw;
      }
      const nu = seg[i][0];
      const nv = seg[i][1];
      quadFacing(m, at(i, s0[j]), at(i, s0[j + 1]), at(i + 1, s1[j + 1]), at(i + 1, s1[j]), new Vector3(nu * na, nv * na, nw), p);
    }
  }
  toFacade(m, start, o.on);
}

/** Section of a flat moulding `width` across and `proud` out of the wall,
 * chamfered on both front edges, sunk 3 cm into the wall. `lip` = how far
 * its inner edge overhangs an opening: the inner face then leans back to the
 * reveal behind it, or the overhang's open back shows from the far jamb. */
function mouldSection(width: number, proud: number, chamfer: number, lip = 0): Vec2[] {
  const h = width / 2;
  return [[-h + (lip ? lip + 0.003 : 0), -0.03], [-h, proud - chamfer], [-h + chamfer, proud], [h - chamfer, proud], [h, proud - chamfer], [h, -0.03]];
}

// ---------------------------------------------------------------------------
// Parts of the garage

/** Silver barrel skin with hoop seams, between the two arch frames. */
function barrelRoof(m: SolidMesh, st: readonly Station[], P: BuildingPaints): void {
  const roofPaint = soften(P.roof, 45);
  // Down behind the eave belts.
  const prof: Station[] = [{ p: [st[0].p[0], SPRING - 0.1], n: [1, 0] }, ...st, { p: [st[st.length - 1].p[0], SPRING - 0.1], n: [-1, 0] }];
  // Stations along the ridge: under the frames, just clear of them (baked
  // AO lives on vertices), and one on the open middle.
  const zEnd = D / 2 - FRAME_BACK + 0.2;
  const zs = [-zEnd, -zEnd + 0.55, 0, zEnd - 0.55, zEnd];
  const P3 = (s: Station, z: number, lift = 0, dz = 0): Vector3 => new Vector3(s.p[0] + s.n[0] * lift, s.p[1] + s.n[1] * lift, z + dz);
  for (let k = 0; k + 1 < zs.length; k++) {
    for (let i = 0; i + 1 < prof.length; i++) {
      const a = prof[i];
      const b = prof[i + 1];
      quadFacing(m, P3(a, zs[k]), P3(b, zs[k]), P3(b, zs[k + 1]), P3(a, zs[k + 1]), new Vector3(a.n[0] + b.n[0], a.n[1] + b.n[1], 0), roofPaint);
    }
  }
  // Hoop seams, one metre apart: a bead with two faces (softened, it shades
  // round) — the trapezoid of the kit's straight seams costs half as much again.
  const seam = { half: 0.05, height: 0.06, sink: 0.006 };
  for (const z of [-2, -1, 0, 1, 2]) {
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i];
      const b = st[i + 1];
      const out = new Vector3(a.n[0] + b.n[0], a.n[1] + b.n[1], 0);
      quadFacing(m, P3(a, z, -seam.sink, -seam.half), P3(b, z, -seam.sink, -seam.half), P3(b, z, seam.height), P3(a, z, seam.height), out.add(new Vector3(0, 0, -1.2)), roofPaint);
      quadFacing(m, P3(a, z, seam.height), P3(b, z, seam.height), P3(b, z, -seam.sink, seam.half), P3(a, z, -seam.sink, seam.half), out.add(new Vector3(0, 0, 1.2)), roofPaint);
    }
  }
}

/** Quarter-round corner of a section, `segs` facets, from the point on the
 * first edge to the point on the second (centre = corner − radius inward). */
function roundCorner(out: Vec2[], centre: Vec2, r: number, fromDeg: number, toDeg: number, segs: number): void {
  for (let k = 0; k <= segs; k++) {
    const t = ((fromDeg + ((toDeg - fromDeg) * k) / segs) * Math.PI) / 180;
    out.push([centre[0] + Math.cos(t) * r, centre[1] + Math.sin(t) * r]);
  }
}

/** Section of an arch frame (a across the strap, w out of the wall): a flat
 * strap with flat front and outer faces and 2-facet round bevels on its
 * two street-side edges (a single chamfer on the back edge, over the roof). Its back runs into the roof skin. */
const FRAME_SECTION: Vec2[] = ((): Vec2[] => {
  const b = 0.06;
  const out: Vec2[] = [[-FRAME_IN, -0.03]];
  roundCorner(out, [-FRAME_IN + b, FRAME_PROUD - b], b, 180, 90, 2);
  roundCorner(out, [FRAME_RISE - b, FRAME_PROUD - b], b, 90, 0, 2);
  roundCorner(out, [FRAME_RISE - b, -FRAME_BACK + b], b, 0, -90, 1);
  out.push([-0.04, -FRAME_BACK]);
  return out;
})();

/** One arch frame on an end wall: from knuckle to knuckle over the roof's
 * end. Softened just enough for the 45° bevel facets: the flat faces stay
 * flat (area-weighted normals), only the bevels round. */
function archFrame(m: SolidMesh, on: Facade, st: readonly Station[], p: Paint): void {
  band(m, { on, path: st.map((s) => s.p), section: FRAME_SECTION }, soften(p, 40));
}

/** A corner: lavender stone, cream block, tapering leg, bolted knuckle. */
function cornerLeg(m: SolidMesh, sx: 1 | -1, sz: 1 | -1, o: { frame: Paint; seed: number }, P: BuildingPaints): void {
  const start = m.mark();
  // Built for the back-right corner (+x, +z), then mirrored into place.
  const x0 = LEG_IN;
  const z0 = D / 2 - FRAME_BACK;
  const xTop = LEG_TOP_X;
  const zTop = D / 2 + FRAME_PROUD;
  const xFoot = LEG_FOOT_X;
  const zFoot = zTop + 0.1;
  const y0 = BASE_TOP - 0.05;
  const y1 = KNUCKLE[0] + 0.05;
  const ring = (y: number): Vector3[] => {
    const f = (y - y0) / (y1 - y0);
    const xo = xFoot + (xTop - xFoot) * f;
    const zo = zFoot + (zTop - zFoot) * f;
    const zi = z0 - 0.06 * (1 - f);
    return ringXZ(roundedRectRing(xo - x0, zo - zi, 0.09, 2), y, (xo + x0) / 2, (zo + zi) / 2);
  };
  // A ring in the open as well as the two buried ends: AO lives on vertices.
  loft(m, { rings: [y0, y0 + 0.35, y1].map(ring), subdivisions: 1 }, soften(o.frame, 30));
  const kx0 = x0 - 0.07;
  const kz0 = z0 - 0.08;
  const kz1 = zTop + 0.1;
  roundedBox(m, { min: [kx0, KNUCKLE[0], kz0], max: [KNUCKLE_X, KNUCKLE[1], kz1], radius: 0.1, segments: 1 }, o.frame);
  // Domed rivet heads on the knuckle's two outer faces.
  const yb = (KNUCKLE[0] + KNUCKLE[1]) / 2;
  const rivet = (at: [number, number, number], rot: [number, number, number]): void => {
    sphere(m, { radii: [0.12, 0.075, 0.12], segments: 12, rings: 2, latitude: [0, 90], caps: false, rot, at }, P.metal);
  };
  rivet([(kx0 + KNUCKLE_X) / 2, yb, kz1 - 0.01], [90, 0, 0]);
  rivet([KNUCKLE_X - 0.01, yb, (kz0 + kz1) / 2], [0, 0, -90]);
  // Cream block and corner stone.
  roundedBox(m, { min: [x0 - 0.05, PLINTH - 0.03, z0 - 0.12], max: [xFoot + 0.06, BASE_TOP, zFoot + 0.08], radius: 0.07, segments: 1 }, P.trim);
  const sw = xFoot + 0.1 - (x0 - 0.07);
  const sd = zFoot + 0.12 - (z0 - 0.16);
  stoneBlock(m, { at: [(xFoot + 0.1 + x0 - 0.07) / 2, (zFoot + 0.12 + z0 - 0.16) / 2], size: [sw, PLINTH + (o.seed % 2 ? 0.02 : 0), sd] }, (sx * sz > 0) === (o.seed % 2 === 0) ? P.stone : P.stoneLight);
  if (sx < 0) m.mirror('x', start);
  if (sz < 0) m.mirror('z', start);
}

/** Cream surround of a bay: two legs to the ground and a round-shouldered head. */
function baySurround(m: SolidMesh, on: Facade, u: number, P: BuildingPaints): void {
  const hx = BAY_W / 2 - 0.012 + SURROUND / 2;
  const yT = BAY_TOP - 0.012 + SURROUND / 2;
  const r = 0.2;
  const path: Vec2[] = [[u + hx, -0.1], [u + hx, 0.75]];
  for (let k = 0; k <= 3; k++) {
    const a = (k / 3) * (Math.PI / 2);
    path.push([u + hx - r + Math.cos(a) * r, yT - r + Math.sin(a) * r]);
  }
  path.push([u + BAY_W / 6, yT], [u - BAY_W / 6, yT]);
  for (let k = 0; k <= 3; k++) {
    const a = Math.PI / 2 + (k / 3) * (Math.PI / 2);
    path.push([u - hx + r + Math.cos(a) * r, yT - r + Math.sin(a) * r]);
  }
  path.push([u - hx, 0.75], [u - hx, -0.1]);
  band(m, { on, path, section: mouldSection(SURROUND, SURROUND_PROUD, 0.045, 0.012) }, soften(P.trim, 50));
}

/**
 * Roller shutter in a bay, in the reveal just behind the wall face: `drop`
 * meters of curtain hanging from the head — broad convex slats (three when
 * rolled up, as on the sheet) — ending in a bottom bar of the same orange.
 * Closed behind (a bay can be driven into).
 */
function shutter(m: SolidMesh, on: Facade, u: number, drop: number, slatPaint: Paint): void {
  const start = m.mark();
  const top = BAY_TOP + 0.02;
  const bottom = BAY_TOP - drop;
  const barH = 0.09;
  const wValley = -0.065;
  const wRidge = -0.03;
  const slats = drop > 1 ? Math.max(1, Math.round((top - bottom - barH) / 0.32)) : 3;
  const pitch = (top - bottom - barH) / slats;
  // Profile (w, v) from the head down: each slat a half-sine bulge.
  const prof: Vec2[] = [[wValley, top]];
  for (let i = 0; i < slats; i++) {
    for (const f of [0.2, 0.5, 0.8, 1]) prof.push([wValley + (wRidge - wValley) * Math.sin(Math.PI * f), top - (i + f) * pitch]);
  }
  const u0 = u - BAY_W / 2 - 0.02;
  const u1 = u + BAY_W / 2 + 0.02;
  const spans = 1;
  const P3 = (k: number, q: Vec2): Vector3 => new Vector3(u0 + ((u1 - u0) * k) / spans, q[1], q[0]);
  const slat = soften(slatPaint, 40);
  for (let k = 0; k < spans; k++) {
    for (let j = 0; j + 1 < prof.length; j++) {
      const out = new Vector3(0, prof[j + 1][0] - prof[j][0], prof[j][1] - prof[j + 1][1]);
      quadFacing(m, P3(k, prof[j]), P3(k + 1, prof[j]), P3(k + 1, prof[j + 1]), P3(k, prof[j + 1]), out, slat);
    }
  }
  // Bottom bar, and the curtain's back.
  roundedBox(m, { min: [u0, bottom, -0.1], max: [u1, bottom + barH + 0.01, -0.018], radius: 0.03, segments: 1, faces: { px: null, nx: null } }, slatPaint);
  quadFacing(m, new Vector3(u0, bottom + 0.02, -0.088), new Vector3(u1, bottom + 0.02, -0.088), new Vector3(u1, top, -0.088), new Vector3(u0, top, -0.088), new Vector3(0, 0, -1), slatPaint);
  toFacade(m, start, on);
}

/** A rounded wall lamp mounted `standoff` out from the wall face: a casing
 * with 3-segment round corners, a glowing lens, optionally a cross mullion.
 * (The kit's `wallLamp` has 2-segment corners and always a bar; its casing
 * cannot stand clear of a moulding it overlaps.) */
function pillLamp(
  m: SolidMesh,
  o: { on: Facade; u: number; v: number; size: readonly [number, number]; casing: Paint; lens: Paint; standoff?: number; mullion?: boolean },
): void {
  const start = m.mark();
  const [w, h] = o.size;
  const z = -0.02 + (o.standoff ?? 0);
  extrudePolygon(m, { outline: roundedRectRing(w, h, h / 2, 3), depth: 0.1, bevel: 0.03, back: false, at: [o.u, o.v, z] }, soften(o.casing, 45));
  const rim = Math.min(0.07, h * 0.22);
  const lw = w - rim * 2;
  const lh = h - rim * 2;
  extrudePolygon(m, { outline: roundedRectRing(lw, lh, lh / 2, 2), depth: 0.05, bevel: Math.min(0.025, lh * 0.3), back: false, at: [o.u, o.v, z + 0.075] }, soften(o.lens, 45));
  if (o.mullion) {
    const bar = 0.04;
    box(m, { min: [o.u - bar / 2, o.v - lh / 2, z + 0.1], max: [o.u + bar / 2, o.v + lh / 2, z + 0.145], faces: { nz: null } }, o.casing);
    box(m, { min: [o.u - lw / 2 + 0.02, o.v - bar / 2, z + 0.1], max: [o.u + lw / 2 - 0.02, o.v + bar / 2, z + 0.145], faces: { nz: null } }, o.casing);
  }
  toFacade(m, start, o.on);
}

/** A slatted wall vent in a fat rounded frame (the sheet's rear vents:
 * ≈ 0.15 m frame with well-rounded corners; the kit's `louvreVent` frame is
 * 0.1 m with 2-segment corners). Mounted on the wall face. */
function vent(m: SolidMesh, o: { on: Facade; u: number; v: number; w: number; h: number; slats: number }, P: BuildingPaints, framePaint: Paint): void {
  const start = m.mark();
  const op: Opening = { u: o.u, v: o.v - o.h / 2, w: o.w, h: o.h, round: 0.12, roundAll: true };
  const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  quadFacing(m, V(o.u - o.w / 2, op.v, 0.006), V(o.u + o.w / 2, op.v, 0.006), V(o.u + o.w / 2, op.v + o.h, 0.006), V(o.u - o.w / 2, op.v + o.h, 0.006), V(0, 0, 1), P.iron);
  for (let i = 0; i < o.slats; i++) {
    const y = op.v + ((i + 0.5) / o.slats) * o.h;
    const t = (o.h / o.slats) * 0.28;
    box(m, { min: [o.u - o.w / 2, y - t, 0.006], max: [o.u + o.w / 2, y + t, 0.045], faces: { nz: null, px: null, nx: null } }, paint(P.metal, { gloss: 0.45, metal: 0.2 }));
  }
  frameRing(m, { inner: openingRing(op, -0.01, 0, 3, true), outer: openingRing(op, 0.15, 0, 3, true), z0: -0.02, z1: 0.08, bevel: 0.035 }, soften(framePaint, 45));
  toFacade(m, start, o.on);
}

/** The sheet's chunky solar panel: a 0.1 m cream slab with a broad border
 * and round corners, eight saturated blue cells, propped toward the street
 * on a cream wedge that sinks into the roof. */
function solar(m: SolidMesh, at: readonly [number, number, number], cream: Paint): void {
  const start = m.mark();
  const w = 2.0;
  const d = 1.3;
  const th = 0.1;
  const tilt = 13;
  roundedBox(m, { min: [-w / 2, 0, -d / 2], max: [w / 2, th, d / 2], radius: 0.05, segments: 1 }, cream);
  const border = 0.12;
  const gap = 0.045;
  const cells = paint(BUILDING.solar, { gloss: 0.35 });
  const cw = (w - border * 2 + gap) / 4;
  const cd = (d - border * 2 + gap) / 2;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      const x0 = -w / 2 + border + i * cw;
      const z0 = -d / 2 + border + j * cd;
      box(m, { min: [x0, th - 0.02, z0], max: [x0 + cw - gap, th + 0.025, z0 + cd - gap], faces: { ny: null } }, cells);
    }
  }
  m.rotate('x', -tilt, start, [0, 0, -d / 2]);
  const rise = Math.sin((tilt * Math.PI) / 180) * d;
  const run = Math.cos((tilt * Math.PI) / 180) * d;
  extrudePolygon(
    m,
    { outline: [[0.1, -0.22], [run - 0.1, -0.22], [run - 0.1, rise - 0.02], [0.1, 0.02]], depth: w * 0.75, centered: true, bevel: 0.03, bevelBack: true, at: frame([0, 0, -d / 2], [0, 0, 1], [0, 1, 0], [1, 0, 0]) },
    soften(cream, 45),
  );
  m.translate([at[0], at[1], at[2]], start);
}

const LINER_FRONT: RGB = [0.24, 0.25, 0.31];
const LINER_BACK: RGB = [0.16, 0.17, 0.22];
const FLOOR_FRONT: RGB = hex('#8A8C98');
const FLOOR_BACK: RGB = hex('#50525E');

/**
 * The room behind the bays: floor, three walls, ceiling and the back of the
 * front wall, all facing inward, darkening toward the back to charcoal (never
 * black). Dark by PAINT: the sun does not know it is indoors. Liner quads
 * are about a metre across, so the baked AO interpolates without wedges.
 */
function interior(m: SolidMesh): void {
  const start = m.mark();
  // The side liners stand inside the corner legs' feet (stone, cream block
  // and leg reach in to x = 3.88): at the wall's own inner face those would
  // poke into the room's corners.
  const xr = ROOM_X;
  // 2 cm INSIDE the front wall's thickness (the panel has no back face): a
  // liner standing behind the wall shows its back past the jambs' rear edges.
  const zf = -D / 2 + T - 0.02;
  const zb = BACK_LINER;
  const yf = 0.04;
  const yc = 3.3;
  const wall = paint(LINER_FRONT, { gloss: 0.15 });
  const floor = paint(FLOOR_FRONT, { gloss: 0.3 });
  const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  // Floor: out to a lip in front of the wall face, across the bays only
  // (the piers' stones and the surround legs stand in it).
  const xs = [-xr, -2.1, -0.3, 0.3, 2.1, xr];
  const zs = [-D / 2 - 0.06, zf, -1.9, -0.4, 1.3, zb];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let k = 0; k + 1 < zs.length; k++) quadFacing(m, V(xs[i], yf, zs[k]), V(xs[i + 1], yf, zs[k]), V(xs[i + 1], yf, zs[k + 1]), V(xs[i], yf, zs[k + 1]), V(0, 1, 0), floor);
    quadFacing(m, V(xs[i], -0.1, zs[0]), V(xs[i + 1], -0.1, zs[0]), V(xs[i + 1], yf, zs[0]), V(xs[i], yf, zs[0]), V(0, 0, -1), floor);
  }
  const wz = [zf, -1.6, 0, 1.4, zb];
  const wy = [yf, 1.1, 2.2, yc];
  for (const s of [1, -1]) {
    for (let k = 0; k + 1 < wz.length; k++) {
      for (let j = 0; j + 1 < wy.length; j++) quadFacing(m, V(s * xr, wy[j], wz[k]), V(s * xr, wy[j], wz[k + 1]), V(s * xr, wy[j + 1], wz[k + 1]), V(s * xr, wy[j + 1], wz[k]), V(-s, 0, 0), wall);
    }
  }
  const wx = [-xr, -2.1, -1.05, 0, 1.05, 2.1, xr];
  for (let i = 0; i + 1 < wx.length; i++) {
    for (let j = 0; j + 1 < wy.length; j++) quadFacing(m, V(wx[i], wy[j], zb), V(wx[i + 1], wy[j], zb), V(wx[i + 1], wy[j + 1], zb), V(wx[i], wy[j + 1], zb), V(0, 0, -1), wall);
    for (let k = 0; k + 1 < wz.length; k++) quadFacing(m, V(wx[i], yc, wz[k]), V(wx[i + 1], yc, wz[k]), V(wx[i + 1], yc, wz[k + 1]), V(wx[i], yc, wz[k + 1]), V(0, -1, 0), wall);
  }
  // Back of the front wall: the three piers and the lintel over the bays.
  const bay0 = BAY_X - BAY_W / 2;
  const bay1 = BAY_X + BAY_W / 2;
  const piers: [number, number][] = [[-xr, -bay1], [-bay0, bay0], [bay1, xr]];
  for (const [a, b] of piers) quadFacing(m, V(a, yf, zf), V(b, yf, zf), V(b, BAY_TOP, zf), V(a, BAY_TOP, zf), V(0, 0, 1), wall);
  quadFacing(m, V(-xr, BAY_TOP, zf), V(xr, BAY_TOP, zf), V(xr, yc, zf), V(-xr, yc, zf), V(0, 0, 1), wall);
  // Depth gradient.
  m.recolor((p, n, c) => {
    const f = Math.min(1, Math.max(0, (p.z - zf) / (zb - zf)));
    const k = f * f * (3 - 2 * f);
    if (n.y > 0.5) return mix(FLOOR_FRONT, FLOOR_BACK, Math.min(1, Math.max(0, (p.z + D / 2 + 0.06) / 4.2)));
    if (Math.abs(n.z) > 0.5 && n.z < 0 && p.y < yf + 0.001 && p.z < -D / 2) return c;
    return mix(LINER_FRONT, LINER_BACK, n.y < -0.5 ? Math.max(k, 0.5) : k);
  }, start);
  // Shallow panel seams on the back wall (between the bays and either side
  // of each bay's lamp), a shade lighter than the liner.
  const seam = paint(mix(LINER_BACK, [0.45, 0.47, 0.55], 0.3), { gloss: 0.2 });
  for (const x of [-3.05, -1.15, 0, 1.15, 3.05]) box(m, { min: [x - 0.03, yf, zb - 0.025], max: [x + 0.03, yc, zb + 0.01], faces: { pz: null, py: null, ny: null } }, seam);
}

/** A stack of buggy tyres: chunky matte tori, each a little off the one below. */
function tyreStack(m: SolidMesh, at: readonly [number, number], count: number, seed: number): void {
  const r = variation(seed + 1, 'b07-tyres').rng('stack');
  const rubber = paint([0.2, 0.2, 0.23], { gloss: 0.2 });
  const tubeR = 0.15;
  for (let i = 0; i < count; i++) {
    const x = at[0] + (i ? r.range(-0.05, 0.05) : 0);
    const z = at[1] + (i ? r.range(-0.05, 0.05) : 0);
    torus(m, { radius: 0.3, tube: tubeR, segments: 9, sides: 4, tubeScaleY: 0.85, at: [x, tubeR * 0.85 + 0.02 + i * tubeR * 1.62, z] }, rubber);
  }
}

/** Stores stand against the back wall of a bay: the roller cabinet toward
 * the outer wall, the tyres toward the middle pier (|x|, mirrored by bay). */
const STORES_Z = D / 2 - 0.6 - 0.3;
const CHEST_X = 2.9;
const TYRES_X = 1.35;

/** A red roller cabinet (the vision's garage has one in each bay). */
function toolChest(m: SolidMesh, at: readonly [number, number], P: BuildingPaints): void {
  const red = paint(BUILDING.coral, { color: hex('#D8372F'), gloss: 0.5 });
  roundedBox(m, { min: [at[0] - 0.5, 0.03, at[1] - 0.26], max: [at[0] + 0.5, 0.95, at[1] + 0.26], radius: 0.04, segments: 1 }, red);
  for (const y of [0.3, 0.52, 0.74]) box(m, { min: [at[0] - 0.3, y - 0.025, at[1] - 0.29], max: [at[0] + 0.3, y + 0.025, at[1] - 0.25], faces: { pz: null } }, P.metal);
}

/** Plan positions of the bollards in front of the three bay piers. */
const BOLLARDS: readonly (readonly [number, number])[] = [
  [0, -D / 2 - 0.38],
  [-3.74, -D / 2 - 0.38],
  [3.74, -D / 2 - 0.38],
];

function bollard(m: SolidMesh, at: readonly [number, number], P: BuildingPaints): void {
  const yellow = paint(BOLLARD_YELLOW, { gloss: 0.45 });
  roundedBox(m, { min: [at[0] - 0.09, -0.1, at[1] - 0.09], max: [at[0] + 0.09, 0.82, at[1] + 0.09], radius: 0.07, segments: 1 }, yellow);
  box(m, { min: [at[0] - 0.095, 0.5, at[1] - 0.095], max: [at[0] + 0.095, 0.62, at[1] + 0.095], faces: { py: null, ny: null } }, P.iron);
}

// ---------------------------------------------------------------------------

function build(seed: number, scheme?: string): SolidMesh {
  const c = choices(seed);
  const v = c.v;
  const base = schemePaints(scheme, 'coastal');
  const sheet =
    base.scheme === 'coastal'
      ? withPaints(base, { wall: BUILDING.cobalt, roof: paint(BUILDING.roofMetal, { gloss: 0.6, metal: 0.3 }), roofAlt: ORANGE, accent: ORANGE, door: BUILDING.turquoise })
      : base.scheme === 'warm'
        ? withPaints(base, { trim: BUILDING.turquoise })
        : base;
  const P = variantPaints(sheet, v);
  /** Arch frames, legs and knuckles: painted metal. */
  const FRAME = paint(P.roofAlt, { gloss: 0.42 });
  // The rolled shutter sits in the reveal's shade: a touch lighter than the
  // frames so it still reads as the same orange.
  const SHUTTER = paint(mix(P.accent.color, WHITE, 0.1), { gloss: 0.45 });
  const m = new SolidMesh();
  const F = boxFacades(W, D);
  const st = roofStations();

  // a. Roof.
  barrelRoof(m, st, P);

  // b. Plinth: a stone under each corner leg (below), courses between them,
  // cut for the bays and the personnel door, one stone under the middle pier.
  const course = (on: Facade, u0: number, u1: number): void => stoneCourse(m, { on, u0, u1, top: PLINTH, blockLength: [0.75, 1.45], split: 0.4, seed }, P);
  const sideRun = D / 2 - FRAME_BACK - 0.14;
  course(F.back, -(LEG_IN - 0.05), LEG_IN - 0.05);
  course(F.left, -sideRun, sideRun);
  course(F.right, -sideRun, DOOR.u - DOOR.w / 2 - 0.11);
  course(F.right, DOOR.u + DOOR.w / 2 + 0.11, sideRun);
  stoneBlock(m, { at: [0, -D / 2], size: [BAY_X * 2 - BAY_W - 2 * SURROUND + 0.07, PLINTH, 0.24] }, P.stone);

  // c. Walls. The end walls follow the roof (10 cm inside its skin); the bays
  // are openings that reach the panel's foot.
  const bay = (side: 1 | -1): Opening => ({ u: side * BAY_X, v: -0.1, w: BAY_W, h: BAY_TOP + 0.1 });
  // Their top line hides behind the arch frame (0.36 m of it below the
  // skin), so it follows the roof in a few long chords only.
  const wallTop = st.filter((_s, i) => i % 2 === 0).map((s, i, all): Vec2 => (i === 0 ? [W / 2, SPRING] : i === all.length - 1 ? [-W / 2, SPRING] : offset(s, -0.1)));
  wallPanel(m, { on: F.front, width: W, bottom: -0.1, top: SPRING, topProfile: wallTop, thickness: T, openings: [bay(-1), bay(1)], foot: PLINTH + 0.24, grid: 1.0 }, P.wall);
  // The sheet's rear shows silver roof above a straight cream belt: with the
  // barrel turned as the brief wants, that part is end wall, clad in roof metal.
  wallPanel(m, { on: F.back, width: W, bottom: PLINTH - 0.1, top: SPRING, topProfile: wallTop, thickness: T, grid: 1.0, gablePaint: P.roof, gableFrom: BELT_Y }, P.wall);
  for (const u of [-2.8, -1.4, 0, 1.4, 2.8]) {
    const s0 = m.mark();
    rib(m, [u, BELT_Y + BELT_H / 2 - 0.02, 0], [u, roofY(u) - FRAME_IN + 0.03, 0], [0, 0, 1], { width: 0.09, topWidth: 0.05, height: 0.045, capEnd: false }, P.roof);
    toFacade(m, s0, F.back);
  }
  wallPanel(m, { on: F.left, width: D - 2 * T + 0.02, bottom: PLINTH - 0.1, top: SPRING, thickness: T, grid: 1.0, ends: false }, P.wall);
  wallPanel(m, { on: F.right, width: D - 2 * T + 0.02, bottom: -0.1, top: SPRING, thickness: T, grid: 1.0, ends: false, openings: [DOOR], foot: PLINTH + 0.24 }, P.wall);
  interior(m);
  // A warm strip lamp on the back wall of each bay: the one sign of life in
  // the dark room (the vision's bays glow from inside).
  for (const s of [1, -1]) {
    box(m, { min: [s * BAY_X - 0.8, 2.1, BACK_LINER - 0.07], max: [s * BAY_X + 0.8, 2.32, BACK_LINER + 0.02], faces: { pz: null } }, P.iron);
    box(m, { min: [s * BAY_X - 0.72, 2.15, BACK_LINER - 0.1], max: [s * BAY_X + 0.72, 2.27, BACK_LINER - 0.05], faces: { pz: null } }, P.lamp);
  }

  // d. Arch frames and corner legs.
  archFrame(m, F.front, st, FRAME);
  archFrame(m, F.back, st, FRAME);
  for (const sx of [1, -1] as const) for (const sz of [1, -1] as const) cornerLeg(m, sx, sz, { frame: FRAME, seed }, P);

  // e. Cream belt: along both eaves and straight across the back, from
  // knuckle to knuckle; on the front it is the arch over the spanner.
  for (const s of [1, -1]) {
    const x = s * (W / 2 + 0.05);
    beam(m, { from: [x, BELT_Y, -D / 2 + FRAME_BACK - 0.05], to: [x, BELT_Y, D / 2 - FRAME_BACK + 0.05], size: [BELT_H, 0.22], side: [s, 0, 0], chamfer: 0.05, caps: false, back: false, segments: 4 }, P.trim);
  }
  beam(m, { from: [-LEG_IN, BELT_Y, D / 2 + 0.05], to: [LEG_IN, BELT_Y, D / 2 + 0.05], size: [BELT_H, 0.22], side: [0, 0, 1], chamfer: 0.05, caps: false, back: false, segments: 6 }, P.trim);
  // Front: the cream arch runs CONCENTRIC under the orange frame (its top
  // edge 3 cm up under the strap), from knuckle to knuckle. The sheet's
  // silver crescent between the two is the roof's side seen in its rotated
  // barrel; turned as the brief wants, it would be a sliver widest at the
  // shoulders — the inverse of the drawing — so the arch takes its place.
  const archR = ROOF_R - FRAME_IN - ARCH_W / 2 + 0.03;
  const archEnd = 4.12;
  const archPath: Vec2[] = [];
  for (let i = 0; i <= 12; i++) {
    const u = archEnd * (1 - (2 * i) / 12);
    archPath.push([u, ROOF_CY + Math.sqrt(archR * archR - u * u)]);
  }
  band(m, { on: F.front, path: archPath, section: mouldSection(ARCH_W, 0.12, 0.05) }, soften(P.trim, 50));

  // f. Openings.
  for (const side of [1, -1] as const) {
    baySurround(m, F.front, side * BAY_X, P);
    shutter(m, F.front, side * BAY_X, c.shut === side ? BAY_TOP - 0.05 : SHUTTER_DROP, SHUTTER);
  }
  door(m, { on: F.right, opening: DOOR }, P);
  for (const s of [1, -1]) vent(m, { on: F.back, u: s * 1.9, v: 2.3, w: c.ventW, h: 0.75, slats: 4 }, P, soften(P.trim, 45));

  // g. Attachments.
  // Strip lamps sit ON the surround heads (their casing stands clear of the
  // moulding's face): teal casing, near-white cyan glow.
  const stripCasing = paint(BUILDING.turquoise, { gloss: 0.5 });
  const stripLens = paint(mix(BUILDING.cyanLight, WHITE, 0.55), { emissive: 0.8, gloss: 0.5 });
  for (const s of [1, -1]) pillLamp(m, { on: F.front, u: s * BAY_X, v: SURROUND_TOP + 0.085, size: [c.lampW, 0.27], casing: stripCasing, lens: stripLens, standoff: 0.08 });
  // Centred in the blue field: ≈ 0.17 m clear of the surround heads below and
  // of the cream arch above.
  emblem(m, { on: F.front, u: 0, v: 3.55, size: 2.3, outline: WRENCH, depth: 0.1 }, P.trim);
  pillLamp(m, { on: F.right, u: DOOR.u, v: 2.8, size: [0.85, 0.4], casing: paint(BUILDING.apricot, { gloss: 0.45 }), lens: P.lamp, mullion: true });
  // Pressed slots in the side panels (two by the door, two on the plain wall).
  const slot = paint(shade(P.wall.color, 0.72), { gloss: 0.2 });
  for (const [on, us] of [[F.right, [1.25, 1.8]], [F.left, [-1.8, -1.25]]] as const) {
    for (const u of us) {
      const s0 = m.mark();
      extrudePolygon(m, { outline: roundedRectRing(0.16, 0.95, 0.08, 2), depth: 0.016, back: false, at: [u, 1.82, -0.01] }, soften(slot, 45));
      toFacade(m, s0, on);
    }
  }
  if (c.solar !== 'none') solar(m, [0, ROOF_TOP + 0.13, c.solar === 'front' ? -1.6 : 1.5], paint(BUILDING.cream, { gloss: 0.35 }));

  // h. Dressing.
  if (c.chest) toolChest(m, [c.chest * CHEST_X, STORES_Z], P);
  if (c.tyres) tyreStack(m, [c.chest * TYRES_X, STORES_Z - 0.2], 3, seed);
  if (c.bollards) for (const at of BOLLARDS) bollard(m, at, P);
  return finishBuilding(m);
}

function colliders(seed: number): ColliderSpec[] {
  const c = choices(seed);
  const clear = BAY_TOP - SHUTTER_DROP;
  const xSide = ROOM_X;
  const xOut = LEG_FOOT_X + 0.1;
  const zOut = D / 2 + 0.42;
  const pierZ = (zOut + D / 2 - T) / 2;
  const zRoof = D / 2 + FRAME_PROUD;
  // Everything above the bays' clear height — lintel, shutters, roof — as
  // three stacked boxes that follow the barrel.
  const y1 = 3.75;
  const y2 = 4.25;
  const out: ColliderSpec[] = [
    // Side walls with the corner stones, and the back wall.
    ...[1, -1].map((s): ColliderSpec => ({ shape: 'box', center: [(s * (xSide + xOut)) / 2, clear / 2, 0], half: [(xOut - xSide) / 2, clear / 2, zOut] })),
    { shape: 'box', center: [0, clear / 2, (D / 2 - 0.6 + D / 2 + 0.15) / 2], half: [xSide, clear / 2, 0.375] },
    // Bay piers: the two outer ones (leg, stone, surround) and the middle one.
    ...[1, -1].map((s): ColliderSpec => ({ shape: 'box', center: [(s * (BAY_X + BAY_W / 2 + xSide)) / 2, clear / 2, -pierZ], half: [(xSide - BAY_X - BAY_W / 2) / 2, clear / 2, (zOut - D / 2 + T) / 2] })),
    { shape: 'box', center: [0, clear / 2, -D / 2 + (T - SURROUND_PROUD) / 2], half: [BAY_X - BAY_W / 2, clear / 2, (T + SURROUND_PROUD) / 2] },
    { shape: 'box', center: [0, (clear + y1) / 2, 0], half: [KNUCKLE_X, (y1 - clear) / 2, zRoof] },
    { shape: 'box', center: [0, (y1 + y2) / 2, 0], half: [roofHalfAt(y1), (y2 - y1) / 2, zRoof] },
    { shape: 'box', center: [0, (y2 + ROOF_TOP) / 2, 0], half: [roofHalfAt(y2), (ROOF_TOP - y2) / 2, zRoof] },
  ];
  if (c.shut !== 0) out.push({ shape: 'box', center: [c.shut * BAY_X, clear / 2, -D / 2 + T / 2], half: [BAY_W / 2, clear / 2, T / 2] });
  if (c.chest) out.push({ shape: 'box', center: [c.chest * CHEST_X, 0.48, STORES_Z], half: [0.5, 0.48, 0.28] });
  if (c.tyres) out.push({ shape: 'cylinder', base: [c.chest * TYRES_X, 0, STORES_Z - 0.2], height: 0.78, radius: 0.49 });
  if (c.bollards) for (const [x, z] of BOLLARDS) out.push({ shape: 'cylinder', base: [x, 0, z], height: 0.82, radius: 0.11 });
  return out;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'b07-race-garage',
  name: 'B07 Race Garage',
  category: 'building',
  size: { x: 9.72, y: 5.3, z: 7.88 },
  variants: 3,
  schemes: ['coastal', 'warm', 'sunny'],
  triBudget: 6000,
  reference: {
    sheet: 'design-documents/building-design-pack/village-services/design-sheet.png',
    brief: 'design-documents/building-design-pack/village-services/b07-race-garage-brief.txt',
  },
  build,
  colliders,
};

export default asset;
