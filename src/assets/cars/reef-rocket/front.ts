import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, loft, paint, paintWhere, polygonFacing, roundedBox } from '../../../gfx/solid';
import type { Paint } from '../../../gfx/solid';
import type { ShellPaints } from './shell';
import { mono } from './surf';

/**
 * REEF ROCKET — the front fenders with their headlamps, as ONE closed shell
 * per side, lofted along z.
 *
 * The sheet draws the front fender as a single bulbous teardrop: its crown
 * sits over the axle and falls in one convex curve into the lamp ring, which
 * is simply the fender's open front end. So every station here is the same
 * section family — a dome over a flat underside, with a rolled cream flange
 * round its outer lower edge (the fender edging) — and toward the nose the
 * sections round off into the lamp's oval. No separate pod, no neck, no step.
 *
 * The underside of each section is the wheel arch: in side view it traces
 * the arch over the tire, and behind the tire it drops steeply to the sill,
 * where the cream flange hands over to the wave's crest.
 */

/** Centre of the right headlamp's mouth, and the oval's half-axes. The sheet
 * (front and side) puts it at about this height and draws it 1.4 : 1. */
export const LAMP = { x: 0.635, y: 0.975, z: 1.615, rx: 0.225, ry: 0.158 };

/** Section parameters along z (right fender; the left is mirrored). */
const K = {
  /** Centre line of the dome. */
  cx: mono([[0.58, 0.55], [0.72, 0.6], [0.85, 0.625], [1.0, 0.632], [1.3, 0.634], [LAMP.z, LAMP.x]]),
  /** Half-widths outboard / inboard of the centre line. Inboard the dome
   * sinks into the hood's keel and the tub. */
  wo: mono([[0.58, 0.075], [0.66, 0.11], [0.72, 0.15], [0.8, 0.205], [0.9, 0.25], [1.0, 0.268], [1.2, 0.275], [1.34, 0.272], [1.46, 0.26], [1.53, 0.246], [LAMP.z, LAMP.rx]]),
  wi: mono([[0.58, 0.12], [0.72, 0.18], [0.85, 0.23], [1.0, 0.262], [1.3, 0.262], [1.46, 0.245], [LAMP.z, LAMP.rx]]),
  /** Crown line: highest over the axle, falling both ways. */
  top: mono([[0.58, 1.02], [0.66, 1.1], [0.72, 1.16], [0.78, 1.205], [0.84, 1.236], [0.9, 1.256], [1.0, 1.272], [1.1, 1.276], [1.2, 1.272], [1.28, 1.264], [1.36, 1.248], [1.44, 1.224], [1.51, 1.196], [1.565, 1.168], [LAMP.z, LAMP.y + LAMP.ry]]),
  /**
   * Arch line (the underside / the lip). Over the tire it is an arc of
   * radius ~0.5 about the wheel centre (z 1.1, y 0.38): an even gap that
   * still clears 10 cm of bump. Ahead of the tire it runs down into the
   * bottom of the lamp ring; behind it, steeply down to the sill.
   */
  bot: mono([[0.58, 0.54], [0.62, 0.585], [0.66, 0.635], [0.72, 0.7], [0.78, 0.762], [0.84, 0.81], [0.9, 0.843], [1.0, 0.875], [1.1, 0.886], [1.2, 0.876], [1.28, 0.858], [1.36, 0.836], [1.44, 0.824], [1.52, 0.818], [LAMP.z, LAMP.y - LAMP.ry]]),
  /** How far the rolled cream flange stands outboard of the dome — what
   * makes the edging read from above, as on the sheet's top view. */
  flare: mono([[0.58, 0.012], [0.66, 0.03], [0.75, 0.045], [1.38, 0.045], [1.5, 0.03], [1.585, 0.0]]),
  /** How far the underside hangs below the lip at its INBOARD edge: an
   * inner liner that slopes down toward the keel over the wheel, hiding the
   * damper's top mount, while the lip itself keeps the bump clearance. */
  sag: mono([[0.8, 0], [0.95, 0.1], [1.25, 0.1], [1.4, 0]]),
  /** 0 = fender section, 1 = the lamp's pure oval. */
  blend: mono([[1.42, 0], [1.5, 0.22], [1.56, 0.6], [1.6, 0.92], [LAMP.z, 1]]),
};

/** Height of the cream flange, measured square to the lip. */
const FLANGE = 0.085;

const STATIONS = [0.58, 0.64, 0.7, 0.73, 0.77, 0.81, 0.86, 0.92, 0.99, 1.06, 1.13, 1.2, 1.27, 1.33, 1.39, 1.45, 1.5, 1.545, 1.58, 1.6, LAMP.z];

/** Dome angles, degrees, outboard (0) over the crown to inboard (180). */
const DOME = Array.from({ length: 21 }, (_v, k) => k * 9);
/** Segment ranges of the section (segment j runs from point j to j + 1). */
const FLANGE_SEGS = 6; // 0..5: the cream flange
const DOME_FIRST = 7; // first dome point
const UNDER_FROM = DOME_FIRST + DOME.length; // inboard wall and underside

const spow = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);

/** One section at station z, as (x, y) points: flange, dome, inboard wall,
 * underside — counter-clockwise seen from the front. */
function section(z: number): [number, number][] {
  const cx = K.cx(z);
  const wo = K.wo(z);
  const wi = K.wi(z);
  const top = K.top(z);
  const bot = K.bot(z);
  const f = K.flare(z);
  const xo = cx + wo;
  const xi = cx - wi;
  // Where the lip drops steeply (behind the tire) a flange of constant
  // HEIGHT would thin out in side view; keep its width square to the lip.
  const slope = (K.bot(z + 0.01) - K.bot(z - 0.01)) / 0.02;
  const fh = Math.min(0.15, FLANGE * Math.sqrt(1 + slope * slope));
  const pts: [number, number][] = [
    [xo - 0.03, bot + 0.002],
    [xo + f * 0.55, bot + 0.004 + fh * 0.04],
    [xo + f * 0.92, bot + fh * 0.3],
    [xo + f, bot + fh * 0.55],
    [xo + f * 0.85, bot + fh * 0.8],
    [xo + f * 0.4, bot + fh * 0.97],
    [xo - 0.004, bot + fh + 0.012],
  ];
  const cyD = Math.min(bot + fh + 0.05, (bot + top) / 2);
  const ht = top - cyD;
  for (const d of DOME) {
    const a = (d * Math.PI) / 180;
    const c = Math.cos(a);
    pts.push([cx + (c >= 0 ? wo : wi) * spow(c, 0.78), cyD + ht * Math.pow(Math.sin(a), 0.8)]);
  }
  // Inboard wall and the underside: enough points that, rounded into the
  // lamp's oval at the nose, the bottom of the ring stays round.
  const sag = K.sag(z);
  pts.push([xi + 0.002, (cyD + bot) / 2 + 0.01 - sag * 0.5], [xi + 0.012, bot + 0.028 - sag], [xi + 0.04, bot + 0.003 - sag]);
  for (const t of [0.2, 0.4, 0.6, 0.8]) pts.push([xi + 0.04 + (xo - 0.03 - xi - 0.04) * t, bot - 0.004 - sag * (1 - t)]);
  return pts;
}

/**
 * The 3D ring at station z. Toward the nose the section is rounded off into
 * the ellipse inscribed in its box, point by point at the same angle (so the
 * flange's dense points stay where they are and simply fold into the lamp
 * ring); `scale` shrinks it about its centre and `zAt` moves it, for the
 * lamp's mouth.
 */
function ring(z: number, scale = 1, zAt = z): Vector3[] {
  const pts = section(z);
  const w = K.blend(z);
  // Centred on the dome's centre line, not the bounding box (the flange
  // makes the box lopsided).
  const cx = K.cx(z);
  const cy = (K.top(z) + K.bot(z)) / 2;
  const rx = (K.wo(z) + K.wi(z)) / 2;
  const ry = (K.top(z) - K.bot(z)) / 2;
  return pts.map(([x, y]) => {
    const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
    const ex = cx + rx * Math.cos(a);
    const ey = cy + ry * Math.sin(a);
    const bx = x + (ex - x) * w;
    const by = y + (ey - y) * w;
    return new Vector3(cx + (bx - cx) * scale, cy + (by - cy) * scale, zAt);
  });
}

/** The lamp's mouth: a fat rolled cream lip turning into a recessed bezel. */
const MOUTH: [number, number][] = [
  // [scale, z offset from the mouth plane]
  [0.96, 0.016],
  [0.88, 0.026],
  [0.79, 0.022],
  [0.73, 0.008],
  [0.71, -0.012],
];

export function addFrontFenders(m: SolidMesh, P: ShellPaints, lens: Paint, bezel: Paint): void {
  const s = m.mark();
  const rings = STATIONS.map((z) => ring(z));
  for (const [k, dz] of MOUTH) rings.push(ring(LAMP.z, k, LAMP.z + dz));
  const cupFrom = STATIONS.indexOf(1.58);
  loft(
    m,
    { rings, subdivisions: 1, caps: 'end', capPaint: bezel },
    (_u, _v, i, j) => {
      if (i >= cupFrom) return P.trim; // the cream cup and the rolled lip
      if (j < FLANGE_SEGS) return P.trim;
      if (j >= UNDER_FROM && STATIONS[i] < 1.48) return P.under;
      return P.body;
    },
  );
  // The tail end, buried in the tub's flank.
  polygonFacing(m, rings[0], new Vector3(0, 0, -1), P.body);
  // The coral brush-stroke on the crown: broad by the lamp, drawn out to a
  // point toward the cockpit, lying along the outboard shoulder.
  paintWhere(
    m,
    {
      from: s,
      only: (c, n) => n.y > 0.3 && c.z < 1.5,
      inside: (p) => {
        const t = (p.z - 0.86) / 0.58;
        if (t <= 0 || t >= 1) return -Math.abs(t - 0.5);
        const half = 0.07 * Math.pow(t, 0.8) * Math.pow(Math.min(1, (1 - t) * 3), 0.6);
        return half - Math.abs(p.x - (0.66 + 0.07 * t * t));
      },
    },
    P.accent,
  );
  // Two flush lenses, rounded bars, in the recessed bezel.
  const bz = LAMP.z - 0.012;
  for (const k of [-1, 1]) {
    roundedBox(m, { size: [0.122, 0.074, 0.03], radius: 0.022, segments: 2, at: [LAMP.x + k * 0.069, LAMP.y, bz + 0.004] }, lens);
  }
  m.mirrorCopy('x', s);
}

/** A warm lens and a lighter bronze-grey bezel, as on the sheet. */
export const LAMP_LENS = paint('#FFD9A0', { emissive: 0.8, gloss: 0.9 });
export const LAMP_BEZEL = paint('#6A5E52', { gloss: 0.45 });
