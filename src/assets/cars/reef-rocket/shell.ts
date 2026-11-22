import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, loft, paint, paintDecal, paintWhere, polygonFacing, quadFacing, roundedRectRing, triFacing, tube } from '../../../gfx/solid';
import type { Paint } from '../../../gfx/solid';
import { denseHalf, mono, offsetHalf, ringOf, scaleHalf, sectionAt, sideXAt, smooth2, topYAt } from './surf';
import type { P2, SectionKey } from './surf';

/**
 * REEF ROCKET — the painted shell: hood, tub, four fenders, headlight pods,
 * and every graphic on them.
 *
 * Model space: origin on the ground under the wheelbase centre, +z nose.
 * All dimensions are worked out from the spec's wheel positions (front axle
 * z = +1.1, r = 0.38; rear axle z = −1.1, r = 0.47), not scaled off the
 * sheet, whose tires are drawn about 10 % larger than the spec's.
 */

export interface ShellPaints {
  body: Paint;
  /** Cream: stripe, fender edging, wave crest, lamp bezels. */
  trim: Paint;
  /** Coral: the wave's body and the fender flashes. */
  accent: Paint;
  /** Inside of the tub. */
  interior: Paint;
  /** Underside of the fenders. */
  under: Paint;
}

// ---------------------------------------------------------------------------
// Hull sections
//
// Ten control points per half section, the same ten roles at every station:
//   0 bottom centre · 1 end of the flat floor · 2 floor corner · 3 keel wall
//   4 lower flank · 5 flare / belt · 6 upper flank · 7 shoulder
//   8 deck (the cockpit is cut out inboard of it) · 9 top centre
// Under the hood the body is a bulb on a narrow keel: the keel carries the
// front suspension pivots (x ≈ 0.23–0.26) and leaves the steered tires room
// (their rear inner corner swings in to x = 0.49 at 32° of lock).

const FLOOR = 0.34;

const HULL_KEYS: SectionKey[] = [
  { z: 1.62, pts: [[0, 0.56], [0.09, 0.56], [0.16, 0.58], [0.2, 0.64], [0.235, 0.71], [0.27, 0.8], [0.265, 0.88], [0.22, 0.935], [0.12, 0.962], [0, 0.968]] },
  { z: 1.5, pts: [[0, 0.4], [0.1, 0.4], [0.17, 0.43], [0.205, 0.53], [0.25, 0.66], [0.3, 0.8], [0.345, 0.915], [0.295, 0.995], [0.16, 1.03], [0, 1.04]] },
  // At the front axle the body is pinched in below its belt: the coil-overs
  // stand there (tops at x = 0.38), and the tires need the room at full lock.
  { z: 1.3, pts: [[0, FLOOR], [0.12, FLOOR], [0.19, 0.37], [0.225, 0.5], [0.265, 0.66], [0.315, 0.82], [0.4, 0.96], [0.36, 1.05], [0.19, 1.087], [0, 1.095]] },
  { z: 1.0, pts: [[0, FLOOR], [0.12, FLOOR], [0.19, 0.37], [0.225, 0.5], [0.27, 0.66], [0.325, 0.82], [0.42, 0.97], [0.38, 1.075], [0.2, 1.12], [0, 1.13]] },
  { z: 0.82, pts: [[0, FLOOR], [0.14, FLOOR], [0.22, 0.37], [0.26, 0.5], [0.32, 0.66], [0.39, 0.82], [0.455, 0.97], [0.41, 1.09], [0.22, 1.145], [0, 1.155]] },
  { z: 0.6, pts: [[0, FLOOR], [0.3, FLOOR], [0.5, 0.36], [0.585, 0.46], [0.625, 0.6], [0.645, 0.76], [0.63, 0.93], [0.575, 1.075], [0.42, 1.135], [0, 1.14]] },
  { z: 0.28, pts: [[0, FLOOR], [0.3, FLOOR], [0.5, 0.36], [0.585, 0.46], [0.625, 0.6], [0.645, 0.74], [0.635, 0.86], [0.59, 0.955], [0.44, 0.99], [0, 0.995]] },
  { z: -0.05, pts: [[0, FLOOR], [0.3, FLOOR], [0.5, 0.36], [0.585, 0.46], [0.625, 0.6], [0.645, 0.75], [0.635, 0.88], [0.59, 0.99], [0.44, 1.03], [0, 1.035]] },
  { z: -0.45, pts: [[0, FLOOR], [0.3, FLOOR], [0.5, 0.36], [0.585, 0.46], [0.625, 0.6], [0.645, 0.77], [0.635, 0.94], [0.585, 1.075], [0.44, 1.12], [0, 1.125]] },
  { z: -0.6, pts: [[0, 0.47], [0.29, 0.47], [0.47, 0.49], [0.565, 0.575], [0.61, 0.69], [0.635, 0.83], [0.625, 0.97], [0.578, 1.09], [0.44, 1.14], [0, 1.145]] },
  // From here back the rear tires (inner face x = 0.585) run beside the body.
  { z: -0.75, pts: [[0, 0.62], [0.26, 0.62], [0.42, 0.64], [0.5, 0.71], [0.54, 0.8], [0.56, 0.9], [0.565, 1.02], [0.54, 1.125], [0.42, 1.165], [0, 1.17]] },
  { z: -1.05, pts: [[0, 0.85], [0.24, 0.85], [0.4, 0.865], [0.49, 0.91], [0.53, 0.97], [0.545, 1.04], [0.535, 1.12], [0.48, 1.195], [0.34, 1.235], [0, 1.245]] },
  // Behind the fans the deck crowns up to the fenders' height, so from
  // behind the tail and the two rear fenders read as one flowing mass, not
  // three lobes with notches between them.
  { z: -1.3, pts: [[0, 0.86], [0.235, 0.86], [0.39, 0.875], [0.48, 0.92], [0.52, 0.98], [0.535, 1.05], [0.53, 1.14], [0.5, 1.235], [0.36, 1.29], [0, 1.3]] },
  { z: -1.5, pts: [[0, 0.87], [0.23, 0.87], [0.38, 0.885], [0.47, 0.93], [0.51, 0.99], [0.525, 1.05], [0.52, 1.13], [0.485, 1.225], [0.34, 1.278], [0, 1.288]] },
];

/** Segments per control span: the flank and the shoulder carry the glossy
 * highlight, the floor (only seen from below, past the tires) does not. */
const AROUND = [1, 1, 2, 2, 3, 3, 3, 2, 2];

const hullCtrl = sectionAt(HULL_KEYS);

/** The hood's bonnet is the car's biggest highlight: more segments over its
 * top than the tub (whose top is cut away) needs. */
const AROUND_HOOD = [1, 2, 2, 2, 2, 3, 3, 4, 4];

/** Dense right-half outline of the body at station z. */
export function hullHalf(z: number, around: readonly number[] = AROUND): P2[] {
  return denseHalf(hullCtrl(z), around);
}
/** Height of the body's upper surface at (x, z). */
export function hullTop(x: number, z: number): number {
  return topYAt(hullHalf(z), Math.abs(x));
}
/** Half-width of the body at height y, station z. */
export function hullSide(y: number, z: number): number {
  return sideXAt(hullHalf(z), y);
}

/** The hood is its own panel, standing this much proud of the tub. */
const PANEL_STEP = 0.007;
/** Where the hood ends and the tub begins (the scuttle seam). */
export const SCUTTLE_Z = 0.785;
/** Half-width of the cream centre stripe. */
const STRIPE = 0.165;
/** The cockpit opening, plan view: half-width, front and rear edge. */
export const COCKPIT = { halfWidth: 0.42, front: 0.6, rear: -1.02, corner: 0.15 };

const NOSE_Z = 1.62;
const NOSE_LEN = 0.05;
const TAIL_Z = -1.47;
const TAIL_LEN = 0.095;

/** Hood: nose cap, bonnet and the keel under it, as one closed panel. */
export function addHood(m: SolidMesh, P: ShellPaints): void {
  const s = m.mark();
  const rings: Vector3[][] = [];
  const nose = offsetHalf(hullHalf(NOSE_Z, AROUND_HOOD), PANEL_STEP);
  // Elliptical nose cap: a tight ring first (never a point — a point pinches
  // the highlight into a star).
  // Seven rings, so the curvature from bonnet to chin turns over several
  // rings instead of creasing on one.
  for (const a of [84, 72, 60, 48, 36, 24, 12]) {
    const r = (a * Math.PI) / 180;
    rings.push(ringOf(scaleHalf(nose, 0.775, Math.cos(r)), NOSE_Z + NOSE_LEN * Math.sin(r)));
  }
  for (const z of [1.62, 1.58, 1.53, 1.47, 1.4, 1.32, 1.24, 1.15, 1.06, 0.97, 0.88, 0.82, SCUTTLE_Z]) {
    rings.push(ringOf(offsetHalf(hullHalf(z, AROUND_HOOD), PANEL_STEP), z));
  }
  loft(m, { rings, subdivisions: 1, caps: true }, P.body);
  // Centre stripe, over the bonnet and down the nose to the bumper.
  // (Bounded by planes, not by a face filter: a filter ends the stripe on a
  // sawtooth of whole triangles.)
  paintWhere(m, { from: s, inside: (p) => Math.min(STRIPE - Math.abs(p.x), p.y - 0.71) }, P.trim);
}

/** Stations of the tub loft. The cockpit liner and the coaming reuse them,
 * so their top edges follow the deck facet for facet. */
const TUB_STATIONS = [0.8, 0.74, 0.68, 0.62, 0.56, 0.46, 0.36, 0.26, 0.16, 0.06, -0.04, -0.14, -0.24, -0.34, -0.42, -0.5, -0.58, -0.66, -0.75, -0.85, -0.95, -1.06, -1.18, -1.3, -1.4, TAIL_Z];

/** Half-width of the cockpit opening at station z (a rounded rectangle in
 * plan), or −1 outside it. */
function cockpitHalfWidth(z: number): number {
  const { halfWidth: w, front, rear, corner: c } = COCKPIT;
  if (z > front + 1e-9 || z < rear - 1e-9) return -1;
  const d = Math.min(front - z, z - rear);
  if (d >= c) return w;
  return w - c + Math.sqrt(Math.max(c * c - (c - d) * (c - d), 0));
}

/** Stations along the cockpit: its two ends, the corner arcs, and every tub
 * station in between. */
function cockpitStations(): number[] {
  const { front, rear, corner: c } = COCKPIT;
  const out: number[] = [];
  for (const a of [0, 30, 60, 90]) out.push(front - c * (1 - Math.cos((a * Math.PI) / 180)));
  for (const z of TUB_STATIONS) if (z < front - c - 0.02 && z > rear + c + 0.02) out.push(z);
  for (const a of [90, 60, 30, 0]) out.push(rear + c * (1 - Math.cos((a * Math.PI) / 180)));
  return out;
}

/** Floor of the cockpit at station z: just above the tub's own bottom, which
 * sweeps up behind the seat. */
export function cabinFloor(z: number): number {
  return hullHalf(z)[0][1] + 0.035;
}

/**
 * Tub: scuttle, flanks, rear deck and tail as one closed shell; the cockpit
 * is cut out of the deck and lined with a dark inner tub, the cut edge
 * rolled over with a rubber coaming (which is also what gives the opening
 * its thickness).
 */
export function addTub(m: SolidMesh, P: ShellPaints, rim: Paint): void {
  const s = m.mark();
  const rings: Vector3[][] = [];
  for (const z of TUB_STATIONS) rings.push(ringOf(hullHalf(z), z));
  const tail = hullHalf(TAIL_Z);
  for (const a of [28, 52, 72, 86]) {
    const r = (a * Math.PI) / 180;
    // cos^0.6: a broad flat stern with rounded edges, not a pointed egg.
    rings.push(ringOf(scaleHalf(tail, 1.05, Math.pow(Math.cos(r), 0.6)), TAIL_Z - TAIL_LEN * Math.sin(r)));
  }
  loft(m, { rings, subdivisions: 1, caps: true }, P.body);
  // The stripe runs on from the hood over the scuttle to the cockpit's edge,
  // picks up again behind the cockpit and runs over the tail.
  // Over the tail it narrows a little (the sheet's rear view) and runs down
  // the whole height of the tail lobe.
  const stripeHalf = (z: number): number => STRIPE - 0.035 * Math.min(1, Math.max(0, (-1.1 - z) / 0.3));
  paintWhere(m, { from: s, only: (_c, n) => n.y > -0.75, inside: (p) => Math.min(stripeHalf(p.z) - Math.abs(p.x), Math.max(COCKPIT.rear + 0.2 - p.z, p.z - COCKPIT.front), p.y - 0.865) }, P.trim);
  // Behind the seat the tub's bottom sweeps up to the deck. Seen from behind
  // (the chase camera) the sheet shows open dark space there, with the frame
  // and the transaxle in it — not a painted belly — so that rising underside
  // is dark.
  // (Kept off the flanks, which the side view shows in body colour.)
  paintWhere(m, { from: s, only: (_c, n) => (n.z < -0.25 || n.y < -0.5) && Math.abs(n.x) < 0.75, inside: (p) => Math.min(0.845 - p.y, -0.42 - p.z, 0.5 - Math.abs(p.x)) }, P.interior);
  // Cockpit opening, cut straight down through the deck.
  const len = COCKPIT.front - COCKPIT.rear;
  paintDecal(
    m,
    {
      outline: roundedRectRing(COCKPIT.halfWidth * 2, len, COCKPIT.corner, 6),
      facing: '+y',
      at: [0, 0, (COCKPIT.front + COCKPIT.rear) / 2],
      from: s,
      only: (_c, n) => n.y > 0.3,
    },
    null,
  );
  for (const side of [-1, 1] as const) addWave(m, s, side, P);

  // Liner: a trough of U sections from the cut edge down to the floor.
  const zs = cockpitStations();
  const section = (z: number): Vector3[] => {
    const hw = cockpitHalfWidth(z);
    const top = hullTop(hw, z) - 0.004;
    const fl = cabinFloor(z);
    const right: P2[] = [
      [hw, top],
      [hw - 0.004, top - 0.07],
      [hw - 0.014, fl + 0.11],
      [hw - 0.06, fl + 0.018],
      [hw - 0.15, fl],
    ];
    const out = right.map(([x, y]) => new Vector3(-x, y, z));
    out.push(new Vector3(0, fl, z));
    for (let i = right.length - 1; i >= 0; i--) out.push(new Vector3(right[i][0], right[i][1], z));
    return out;
  };
  const troughs = zs.map(section);
  loft(m, { rings: troughs, subdivisions: 1, closedRing: false }, P.interior);
  polygonFacing(m, troughs[0], new Vector3(0, 0, -1), P.interior);
  polygonFacing(m, troughs[troughs.length - 1], new Vector3(0, 0, 1), P.interior);

  // Coaming along the cut edge.
  const edge: Vector3[] = [];
  const lip = (x: number, z: number): Vector3 => new Vector3(x, hullTop(Math.abs(x), z) + 0.002, z);
  for (const z of zs) edge.push(lip(cockpitHalfWidth(z), z));
  for (let i = zs.length - 1; i >= 0; i--) edge.push(lip(-cockpitHalfWidth(zs[i]), zs[i]));
  tube(m, { path: edge, radius: 0.027, sides: 7, closed: true }, rim);
}

// ---------------------------------------------------------------------------
// The wave on the flanks
//
// Authored in the side plane as (z, y). Both flanks get the SAME (z, y)
// drawing — the wave rises toward the tail and curls there on either side —
// which is how the sheet's top view shows it, and a wave has no handedness
// to get wrong.

const CURL = { z: -0.28, y: 0.81, r0: 0.135, r1: 0.03, turns: 400 };
/** Centre line of the cream crest, front (low) to the top of the curl. */
const WAVE_LINE: P2[] = smooth2(
  [
    [0.62, 0.585],
    [0.5, 0.6],
    [0.36, 0.64],
    [0.19, 0.745],
    [0.01, 0.87],
    [-0.14, 0.93],
    [-0.22, 0.943],
    [CURL.z, CURL.y + CURL.r0],
  ],
  4,
);
const waveY = mono(WAVE_LINE.map(([z, y]) => [z, y] as P2));
/** Top of the lower sill, where the coral field starts. */
const SILL_LINE = 0.48;

/** The cream crest: the rising band, then the spiral of the curl. Centre
 * line and half-width at each point. */
function crestRibbon(): { pts: P2[]; hw: number[] } {
  const pts: P2[] = [];
  const hw: number[] = [];
  const n = WAVE_LINE.length;
  // Stop short of the curl: a ribbon whose centre-line points sit closer
  // together than its width folds over itself on the inside of a bend.
  for (let i = 0; i < n - 1; i++) {
    if (Math.hypot(WAVE_LINE[i][0] - CURL.z, WAVE_LINE[i][1] - CURL.y - CURL.r0) < 0.04) break;
    pts.push(WAVE_LINE[i]);
    hw.push(0.032 + 0.018 * Math.min(1, (i / (n - 1)) * 1.6));
  }
  const steps = 42;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    // Seen from the left the wave breaks toward the tail: the spiral leaves
    // the crest heading −z and winds on in the same sense.
    const a = ((90 + CURL.turns * f) * Math.PI) / 180;
    const r = CURL.r0 + (CURL.r1 - CURL.r0) * f;
    pts.push([CURL.z + r * Math.cos(a), CURL.y + r * Math.sin(a)]);
    // A line, not a snail: the turquoise hollow between the turns is what
    // makes it read as a curl.
    hw.push(0.04 - 0.029 * f);
  }
  return { pts, hw };
}

/** How far the appliqué stands off the paint (6 mm: clear of depth
 * precision at the diorama camera's distance). */
const LIFT = 0.006;

/**
 * A ribbon of varying width along a (z, y) polyline, laid ON one flank as a
 * thin raised appliqué that follows the panel's curve. (Painted into the
 * panel instead, the curl costs twenty times the triangles: each of its
 * forty-odd outline edges cuts as a whole plane through the flank's big
 * faces.) Three points across, so it hugs the barrel of the flank; its edge
 * walls run back into the panel.
 */
function addRibbon(m: SolidMesh, side: 1 | -1, pts: readonly P2[], hw: readonly number[], p: Paint): void {
  const n = pts.length;
  const skin = (q: P2, lift: number): Vector3 => new Vector3(side * (hullSide(q[1], q[0]) + lift), q[1], q[0]);
  const rows: { top: Vector3[]; base: Vector3[]; out: Vector3 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, n - 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Unit normal of the centre line in the side plane.
    const nz = -(b[1] - a[1]) / l;
    const ny = (b[0] - a[0]) / l;
    const L: P2 = [pts[i][0] + nz * hw[i], pts[i][1] + ny * hw[i]];
    const R: P2 = [pts[i][0] - nz * hw[i], pts[i][1] - ny * hw[i]];
    rows.push({ top: [skin(L, LIFT), skin(pts[i], LIFT), skin(R, LIFT)], base: [skin(L, -0.012), skin(R, -0.012)], out: new Vector3(0, ny, nz) });
  }
  const X = new Vector3(side, 0, 0);
  const WALL = paint(p, { smooth: 0 });
  for (let i = 0; i + 1 < n; i++) {
    const A = rows[i];
    const B = rows[i + 1];
    quadFacing(m, A.top[0], B.top[0], B.top[1], A.top[1], X, p);
    quadFacing(m, A.top[1], B.top[1], B.top[2], A.top[2], X, p);
    quadFacing(m, A.top[0], B.top[0], B.base[0], A.base[0], A.out.add(B.out), WALL);
    quadFacing(m, A.top[2], B.top[2], B.base[1], A.base[1], A.out.add(B.out).scale(-1), WALL);
  }
  // Square ends.
  for (const [row, next] of [[rows[0], rows[1]], [rows[n - 1], rows[n - 2]]]) {
    const away = row.top[1].subtract(next.top[1]);
    quadFacing(m, row.top[0], row.top[2], row.base[1], row.base[0], away, WALL);
  }
}

/** A round appliqué patch on one flank, a little lower than the ribbons so
 * that a ribbon can cross it. */
function addPatch(m: SolidMesh, side: 1 | -1, cz: number, cy: number, radius: number, p: Paint): void {
  const sectors = 40;
  const lift = LIFT - 0.003;
  const skin = (z: number, y: number, l: number): Vector3 => new Vector3(side * (hullSide(y, z) + l), y, z);
  const X = new Vector3(side, 0, 0);
  const WALL = paint(p, { smooth: 0 });
  const centre = skin(cz, cy, lift);
  const at = (k: number, f: number, l: number): Vector3 => {
    const a = (k / sectors) * Math.PI * 2;
    return skin(cz + radius * f * Math.cos(a), cy + radius * f * Math.sin(a), l);
  };
  for (let k = 0; k < sectors; k++) {
    triFacing(m, centre, at(k, 0.5, lift), at(k + 1, 0.5, lift), X, p);
    quadFacing(m, at(k, 0.5, lift), at(k + 1, 0.5, lift), at(k + 1, 1, lift), at(k, 1, lift), X, p);
    const a = ((k + 0.5) / sectors) * Math.PI * 2;
    quadFacing(m, at(k, 1, lift), at(k + 1, 1, lift), at(k + 1, 1, -0.012), at(k, 1, -0.012), new Vector3(0, Math.sin(a), Math.cos(a)), WALL);
  }
}

function addWave(m: SolidMesh, from: number, side: 1 | -1, P: ShellPaints): void {
  const outer = (c: Vector3, n: Vector3): boolean => c.x * side > 0.4 && n.x * side > 0.2;
  // Coral field, painted into the panel: everything between the sill line
  // and the crest. It ends at the curl, as on the sheet: behind the curl's
  // centre it fills only the curl's disc and, below it, the wedge in front
  // of a line slanting from the sill up to the curl's rear (the flank from
  // there to the rear arch stays body colour).
  const ra = CURL.r0 + 0.012;
  const rear0: P2 = [CURL.z + 0.01, SILL_LINE];
  const rear1: P2 = [CURL.z - ra, CURL.y + 0.02];
  const rl = Math.hypot(rear1[0] - rear0[0], rear1[1] - rear0[1]);
  paintWhere(
    m,
    {
      from,
      only: outer,
      inside: (p) => {
        const top = p.z > CURL.z ? waveY(p.z) - p.y : Math.max(CURL.y - p.y, ra - Math.hypot(p.z - CURL.z, p.y - CURL.y));
        // Signed distance to the slanted rear edge, positive toward the nose.
        const line = ((p.z - rear0[0]) * (rear1[1] - rear0[1]) - (p.y - rear0[1]) * (rear1[0] - rear0[0])) / rl;
        return Math.min(p.y - SILL_LINE, top, 0.66 - p.z, line);
      },
    },
    P.accent,
  );
  // The hollow of the curl, in body colour over the coral: where the crest
  // does not cover its edge, it is the round inner wall of the breaking wave.
  addPatch(m, side, CURL.z, CURL.y, 0.115, P.body);
  const crest = crestRibbon();
  addRibbon(m, side, crest.pts, crest.hw, P.trim);
  // The foam wavelet inside the coral: one curved crescent, a long thin
  // tail low toward the nose, rising to a crest and dropping short at the
  // back — the sheet's little breaking wave, not a zigzag.
  const foam = smooth2([[0.17, 0.548], [0.06, 0.583], [-0.03, 0.628], [-0.09, 0.663], [-0.135, 0.652], [-0.17, 0.622], [-0.19, 0.594]], 3);
  const fn = foam.length - 1;
  addRibbon(m, side, foam, foam.map((_q, i) => {
    const t = i / fn;
    // Widest a little behind the middle, needle-thin at both tips.
    return 0.0025 + 0.021 * Math.pow(Math.sin(Math.PI * Math.min(1, t / 0.62) * 0.5), 1.4) * Math.min(1, (1 - t) / 0.3);
  }), P.trim);
}

// ---------------------------------------------------------------------------
// Fenders

interface FenderShape {
  /** Wheel centre in the side plane and the radius of the arch lip. */
  zc: number;
  yc: number;
  R: number;
  /** Arch angle of the two ends, degrees: 0 = straight ahead of the axle,
   * 90 = over the top, 180 = straight behind. */
  phi: [number, number];
  steps: number;
  /** Widest point, inner edge (sunk into the body) and crown height, as
   * functions of the arch angle. */
  xo: (phi: number) => number;
  xi: (phi: number) => number;
  crown: (phi: number) => number;
  /** Fore-aft offset of the lip from its circle (a tip swept forward to
   * meet the body). */
  lead?: (phi: number) => number;
  /** Upward offset of the lip from its circle (an end that climbs up into
   * the part it grows out of). */
  lift?: (phi: number) => number;
  /** A flash of accent colour on the crown: signed distance, positive
   * inside. */
  flash?: (p: Vector3) => number;
  /** How far the skirt tucks back in below its widest point, degrees. */
  tuck: number;
  /** Section fullness: 1 = an ellipse, below 1 = squarer, more inflated. */
  fullness: number;
  across: number;
  /** The cream edging: how many rib rows up from the lip it covers (it
   * follows the section round, so it wraps onto the top of the fender and
   * reads from above, as on the sheet's top view)… */
  bandRows: number;
  /** … and how far the lip rolls out beyond the fender's skin: a flange
   * that stands proud in plan view. */
  flare: number;
  /** Radius of the rolled bead along the lip, and its end caps (flat where
   * the ends are buried in the pod or the flank). */
  bead: number;
  beadCaps: true | 'round';
}

/**
 * One fender (the RIGHT one; mirror for the left): a shell arched over the
 * wheel, every rib a fat inflated curve from the arch lip outboard, over the
 * crown, down into the body. The lip is a circle about the wheel centre, so
 * the gap to the tire is even all the way round.
 */
function addFender(m: SolidMesh, f: FenderShape, P: ShellPaints): void {
  const s = m.mark();
  const S = f.steps;
  const A = f.across;
  if (S % 2 || A % 2) throw new Error('addFender: steps and across must be even (the inner skin uses every second point)');
  const G: Vector3[][] = [];
  const wall: number[] = [];
  const tuck = (f.tuck * Math.PI) / 180;
  const pw = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), f.fullness);
  for (let k = 0; k <= S; k++) {
    const phi = f.phi[0] + ((f.phi[1] - f.phi[0]) * k) / S;
    const a = (phi * Math.PI) / 180;
    const z = f.zc + f.R * Math.cos(a) + (f.lead ? f.lead(phi) : 0);
    const lipY = f.yc + f.R * Math.sin(a) + (f.lift ? f.lift(phi) : 0);
    const xo = f.xo(phi);
    const xi = f.xi(phi);
    const xm = (xo + xi) / 2;
    const rx = (xo - xi) / 2;
    const drop = Math.pow(Math.sin(tuck), f.fullness);
    const ry = Math.max(f.crown(phi) - lipY, 0.04) / (1 + drop);
    const y0 = lipY + ry * drop;
    const rib: Vector3[] = [];
    for (let j = 0; j <= A; j++) {
      const t = -tuck + ((Math.PI + tuck) * j) / A;
      // The lowest rows roll outward into the flared lip.
      const out = j === 0 ? f.flare : j === 1 ? f.flare * 0.55 : 0;
      rib.push(new Vector3(xm + rx * pw(Math.cos(t)) + out, y0 + ry * pw(Math.sin(t)), z));
    }
    G.push(rib);
    // Where the section is rolled down nearly flat (the tail of the rear
    // fender), a full-thickness wall would fold through itself.
    wall.push(Math.min(0.028, ry * 0.3));
  }
  // Outward normal at every grid point. The grid is regular, so (along the
  // arch) × (along the rib) points to the same side of the surface
  // everywhere: decide which side ONCE, on the crown, where "out" is plainly
  // up. (Deciding per point by "away from the wheel" goes wrong on the
  // rolled-down tail, which faces back and down.)
  const raw = (i: number, j: number): Vector3 => {
    const du = G[Math.min(i + 1, S)][j].subtract(G[Math.max(i - 1, 0)][j]);
    const dv = G[i][Math.min(j + 1, A)].subtract(G[i][Math.max(j - 1, 0)]);
    return Vector3.Cross(du, dv).normalize();
  };
  const sign = raw(S / 2, A / 2).y > 0 ? 1 : -1;
  const N: Vector3[][] = G.map((rib, i) => rib.map((_p, j) => raw(i, j).scale(sign)));
  // Outer skin.
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < A; j++) quadFacing(m, G[i][j], G[i + 1][j], G[i + 1][j + 1], G[i][j + 1], N[i][j].add(N[i + 1][j + 1]), j < f.bandRows ? P.trim : P.body);
  }
  if (f.flash) paintWhere(m, { from: s, only: (_c, n) => n.y > 0.25, inside: f.flash }, P.accent);

  // Inner skin: the same surface up to 28 mm in, at half the resolution (it is
  // only ever seen in the shade of the arch), and a rim that stitches the
  // two together point for point so the shell is closed.
  const Q = G.map((rib, i) => rib.map((p, j) => p.subtract(N[i][j].scale(wall[i]))));
  for (let i = 0; i < S; i += 2) {
    for (let j = 0; j < A; j += 2) quadFacing(m, Q[i][j], Q[i + 2][j], Q[i + 2][j + 2], Q[i][j + 2], N[i + 1][j + 1].scale(-1), P.under);
  }
  const RIM = paint(P.trim, { smooth: 0 });
  const rim = (o0: Vector3, o1: Vector3, o2: Vector3, q0: Vector3, q2: Vector3, away: Vector3): void => {
    triFacing(m, o0, o1, q0, away, RIM);
    triFacing(m, o1, q2, q0, away, RIM);
    triFacing(m, o1, o2, q2, away, RIM);
  };
  for (let i = 0; i < S; i += 2) {
    rim(G[i][0], G[i + 1][0], G[i + 2][0], Q[i][0], Q[i + 2][0], G[i + 1][0].subtract(G[i + 1][1]));
    rim(G[i][A], G[i + 1][A], G[i + 2][A], Q[i][A], Q[i + 2][A], G[i + 1][A].subtract(G[i + 1][A - 1]));
  }
  for (let j = 0; j < A; j += 2) {
    rim(G[0][j], G[0][j + 1], G[0][j + 2], Q[0][j], Q[0][j + 2], G[0][j + 1].subtract(G[1][j + 1]));
    rim(G[S][j], G[S][j + 1], G[S][j + 2], Q[S][j], Q[S][j + 2], G[S][j + 1].subtract(G[S - 1][j + 1]));
  }
  // Rolled cream bead along the arch lip: the sheet's fat toy edging, and
  // what keeps the 28 mm shell from reading as cut sheet metal up close.
  // Centred in the wall and fatter than it, so it stands proud both sides;
  // raised a little off the lip line, so what it costs in tire clearance
  // is only what hangs below the lip.
  const bead: Vector3[] = [];
  for (let i = 0; i <= S; i += 2) bead.push(G[i][0].add(Q[i][0]).scale(0.5).addInPlaceFromFloats(0, f.bead * 0.35, 0));
  tube(m, { path: bead, radius: f.bead, sides: 7, caps: f.beadCaps }, paint(P.trim, { smooth: 70 }));
}

const REAR_FENDER: FenderShape = {
  zc: -1.1,
  yc: 0.47,
  // Tire 0.47 + bump 0.10 + what the bead hangs below the lip + ~1 cm.
  R: 0.605,
  phi: [12, 136],
  steps: 26,
  // The front tip sweeps forward along the flank, as on the sheet.
  lead: mono([[12, 0.13], [26, 0.07], [45, 0]]),
  xo: mono([[12, 0.6], [20, 0.665], [30, 0.74], [45, 0.84], [65, 0.93], [95, 0.955], [120, 0.93], [136, 0.9]]),
  // (At the tail the inner edge dives well inside the stern, which is
  // rounding away there.)
  xi: mono([[12, 0.42], [100, 0.42], [136, 0.33]]),
  // The tail of the fender rolls down onto its own lip (a duck tail), so
  // from behind it shows a rounded back, not an open tunnel.
  crown: mono([[12, 0.98], [20, 1.06], [30, 1.14], [45, 1.22], [65, 1.29], [95, 1.3], [116, 1.23], [128, 1.12], [136, 0.99]]),
  // ... and the tail's lip climbs a little, so the rolled-down end tucks
  // into the stern instead of hanging below it as a point.
  lift: mono([[118, 0], [136, 0.05]]),
  tuck: 5,
  fullness: 0.8,
  across: 12,
  bandRows: 2,
  flare: 0.04,
  bead: 0.026,
  beadCaps: 'round',
};

export function addFenders(m: SolidMesh, P: ShellPaints): void {
  const s = m.mark();
  addFender(m, REAR_FENDER, P);
  m.mirrorCopy('x', s);
}

