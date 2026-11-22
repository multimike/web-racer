import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, clamp, mixOklab, oklabToRgb, paint, rgbToOklab, toV3 } from '../../gfx/solid';
import type { Paint, RGB, Rng } from '../../gfx/solid';
import { BARK } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { applyFit, farStick, outTri } from './farKit';
import { Polytope, barkPaint, barkTones, fitPoint, fitSize, foliageTones, lean, limb, shadeBark, variant } from './nature';
import type { Fit, FoliageTones, LimbFacet, LimbPaint, Variant } from './nature';

/**
 * T03 TURBO PALM — a curved, segmented trunk on a chunky root flare under a
 * broad radial crown of notched fronds (trees/design-sheet.png, right).
 *
 * Parts list, measured off the sheet and laid into the brief's box (4.5 wide
 * × 6 tall × 4.2 deep; the drawing is as wide as it is tall, so in the box
 * the crown keeps the drawing's shape and the TRUNK takes up the extra
 * height):
 *  - trunk: a foot that flares to ~1.8× the trunk width over five broad
 *    faceted wedge toes, and six stacked segments, each a faceted frustum
 *    tapering upward, the next one starting a little wider over a dark collar
 *    band — the ring steps of the sheet. 0.44 m radius above the foot,
 *    0.21 m under the crown. It leaves the ground upright and bends over
 *    more and more: 1 m of lean at the crown;
 *  - crown: ten fronds from one point. Six upper ones — the two big side
 *    fronds and the two toward the viewer rise at 40–46° and arch over ~105°
 *    so their sickle tips point down and out; the two at the back stand up
 *    at 60° and splay into the V of the sheet's skyline — and four lower
 *    ones in the gaps between them that leave level and hang, in the deeper
 *    green of the sheet's back row;
 *  - a frond is a closed solid ~3 m long and 1.3 m wide: a shallow tent over
 *    a raised yellow-lime midrib strip (the sheet's most recognisable line),
 *    the half on the notched side a step darker, a visible edge thickness,
 *    and two or three deep V notches on its TRAILING (lower) edge with teeth
 *    hooked toward the tip; the leading edge stays a clean arc.
 * Front of the sheet = looking toward +z (the lab's yaw 0); the lean goes
 * away from that viewer and a little to the right, as in the sheet's front
 * and side views.
 *
 * Variants are the same palm re-grown: lean and bow of the trunk, its girth
 * and number of segments, the number of fronds (8–10), which two or three
 * of them stand up, how perky or how hanging the crown is, every frond's
 * own length, width, roll, sweep, tone and notch pattern — then the whole
 * palm turned and maybe mirrored. The crown is sized to the box and the
 * trunk gets what is left of the height, so a flat crown comes with a tall
 * trunk.
 */

const ID = 't03-turbo-palm';
const SIZE = { x: 4.5, y: 6, z: 4.2 };
const SKIRT = 0.1;
// What `fitSize` aims for: its height is above ground, the roots' skirt
// comes on top of it in the lab's measurement.
const FIT = { x: 4.5, y: 5.9, z: 4.2 };

// ---------------------------------------------------------------------------
// Fronds

interface FrondSpec {
  /** Compass heading it grows toward, degrees about y (0 = +z, 90 = +x). */
  yaw: number;
  /** Elevation at the root, degrees above level. */
  lift: number;
  /** Total downward bend root → tip, degrees. */
  droop: number;
  /** > 1 keeps the root straight and curls the tip over. */
  bias: number;
  /** Heading change root → tip, degrees (a sideways sweep). */
  sweep: number;
  /** Length along the midrib, meters. */
  length: number;
  /** Widest full width, meters. */
  width: number;
  /** Tip of the blade about its midrib, degrees (positive lifts the +side
   * edge). The notches go on the edge the roll lowers. */
  roll: number;
  /** 0 = the deep green of the lower row … 1 = the sunlit yellow-lime. */
  light: number;
  /** Where the notches sit along the midrib, 0..1. */
  slots: readonly number[];
  /** Notch depth per slot on the trailing (lower) edge, fraction of the half
   * width; 0 = no notch there. */
  cuts: readonly number[];
  /** Shallow notch on the leading edge: [slot index, depth], if any. */
  lead?: readonly [number, number];
}

// How far past the tooth the bottom of a V notch lands, fraction of length.
const CUT = 0.09;
// The tent: how far the edges hang below the midrib, per meter of half
// width — a shallow arch (17°), not a roof: a steeper fold turns every
// foreshortened frond into a kite.
const FOLD = 0.3;

const UPPER_SLOTS = [0.38, 0.56, 0.74];
const LOWER_SLOTS = [0.44, 0.66];

/** Half width of the un-notched outline, 0..1 of the widest: a paddle that
 * is broad from a fifth of its length to two thirds and then closes to a
 * sickle point. */
function outline(t: number): number {
  const belly = 0.4;
  if (t < belly) return 0.42 + 0.58 * Math.sin((t / belly) * Math.PI * 0.5);
  const u = (t - belly) / (1 - belly);
  return Math.pow(Math.max(0, 1 - u * u), 1.2);
}

interface FrondColors {
  /** Top of the blade at the root, over most of its length, at the tip. */
  root: RGB;
  blade: RGB;
  tip: RGB;
  /** The raised midrib strip. */
  rib: RGB;
  /** Top of the blade along its edges. */
  rim: RGB;
  /** The cut edge. */
  edge: RGB;
  under: RGB;
  keel: RGB;
}

function frondColors(tones: FoliageTones, light: number): FrondColors {
  // Upper fronds run from the sheet's mid green (light 0.5) to its sunlit
  // yellow-lime (1); the lower row is a deeper green of the same leaf (the
  // sheet's back fronds), not the palette's shade colour: the shader and the
  // baked occlusion under the crown do the rest.
  const upper = light >= 0.4;
  const blade = light > 0.5 ? mixOklab(tones.mid, tones.top, (light - 0.5) * 2 * 0.9) : mixOklab(tones.under, tones.mid, light * 2);
  const bright = mixOklab(tones.top, [1, 1, 0.55], 0.18);
  return {
    root: mixOklab(blade, tones.under, 0.55),
    blade,
    tip: mixOklab(blade, upper ? tones.top : tones.mid, 0.3),
    rib: upper ? mixOklab(blade, bright, 0.8) : mixOklab(blade, tones.top, 0.55),
    rim: upper ? mixOklab(blade, tones.mid, 0.35) : mixOklab(blade, tones.under, 0.3),
    edge: mixOklab(blade, tones.under, 0.55),
    // Upper fronds are seen from below against the sky, and from behind
    // when the palm stands turned: their undersides are a lit jade, only
    // the keel line deep. The lower row keeps the darker green it hangs in.
    under: upper ? mixOklab(tones.under, tones.mid, 0.62) : mixOklab(tones.under, tones.deep, 0.25),
    keel: upper ? mixOklab(tones.under, tones.deep, 0.3) : mixOklab(tones.under, tones.deep, 0.5),
  };
}

/**
 * One frond as a closed solid: a raised midrib strip with a blade plane
 * sloping off it to each side, a V underside that follows them, and a wall
 * round the edge (the thickness that makes it a toy leaf and not a paper
 * card). 14 triangles a segment.
 *
 * Windings are written out for the frame (tangent, side, normal = tangent ×
 * side) and never tested against a direction: a notch wall is undercut — it
 * faces the tip AND slightly inward — and would fool any such test. Every
 * quad that touches a tooth is split from the midrib side, which stays
 * convex however far the tooth hooks.
 */
function frond(m: SolidMesh, root: Vector3, f: FrondSpec, tones: FoliageTones): void {
  const col = frondColors(tones, f.light);
  const p = paint(col.blade, { gloss: 0.35, smooth: 40 });
  const half = f.width / 2;
  // The notches go on the edge the roll tips down — the sheet's trailing
  // edge — and that half of the blade is the darker one.
  const cutSide = f.roll >= 0 ? -1 : 1;

  // The midrib, integrated in small steps so stations can sit anywhere.
  const N = 32;
  const line: Vector3[] = [root.clone()];
  const dirAt = (t: number): { tan: Vector3; side: Vector3 } => {
    const pitch = (f.lift - f.droop * Math.pow(t, f.bias)) * DEG;
    const h = (f.yaw + f.sweep * t) * DEG;
    return {
      tan: new Vector3(Math.sin(h) * Math.cos(pitch), Math.sin(pitch), Math.cos(h) * Math.cos(pitch)),
      side: new Vector3(Math.cos(h), 0, -Math.sin(h)),
    };
  };
  for (let i = 0; i < N; i++) line.push(line[i].add(dirAt((i + 0.5) / N).tan.scale(f.length / N)));
  const pointAt = (t: number): Vector3 => {
    const x = clamp(t, 0, 1) * N;
    const i = Math.min(N - 1, Math.floor(x));
    return Vector3.Lerp(line[i], line[i + 1], x - i);
  };

  interface Station {
    t: number;
    wl: number;
    wr: number;
    /** The tooth before a cut leans toward the tip by this much, meters. */
    sl: number;
    sr: number;
  }
  const stations: Station[] = [{ t: 0.2, wl: outline(0.2), wr: outline(0.2), sl: 0, sr: 0 }];
  f.slots.forEach((t, i) => {
    const trail = f.cuts[i] ?? 0;
    const lead = f.lead && f.lead[0] === i ? f.lead[1] : 0;
    const dl = cutSide < 0 ? trail : lead;
    const dr = cutSide < 0 ? lead : trail;
    const w = outline(t);
    // A deep tooth hooks a little past the bottom of its cut (15 % of the
    // cut's length) so it reads as a saw tooth pointing at the tip. More is
    // not safe: the top triangle from the rib edge to the hooked tooth flips
    // once hook × (cut width − rib) passes cut length × (tooth width − rib).
    const most = (d: number): number => (d > 0.3 ? 1.15 * CUT : d > 0 ? 0.5 * CUT : 0) * f.length;
    stations.push({ t, wl: w, wr: w, sl: most(dl), sr: most(dr) });
    if (dl > 0 || dr > 0) {
      const w2 = outline(t + CUT);
      stations.push({ t: t + CUT, wl: w2 * (1 - dl), wr: w2 * (1 - dr), sl: 0, sr: 0 });
    }
  });
  // One more before the point, so the tip curls over instead of ending in
  // a flat triangle a fifth of the frond long.
  stations.push({ t: 0.9, wl: outline(0.9), wr: outline(0.9), sl: 0, sr: 0 });

  interface Ring {
    /** Midrib strip edges (left, right), blade edges top and bottom, keel. */
    RL: Vector3;
    RR: Vector3;
    K: Vector3;
    Lt: Vector3;
    Lb: Vector3;
    Rt: Vector3;
    Rb: Vector3;
    /** Blade top at the rib and at the edge, per half; rib; edge wall. */
    inL: RGB;
    outL: RGB;
    inR: RGB;
    outR: RGB;
    rib: RGB;
    edge: RGB;
  }
  const roll = f.roll * DEG;
  const frame = (t: number): { P: Vector3; tan: Vector3; side: Vector3; nrm: Vector3 } => {
    const d = dirAt(t);
    const n0 = Vector3.Cross(d.tan, d.side);
    return {
      P: pointAt(t),
      tan: d.tan,
      side: d.side.scale(Math.cos(roll)).add(n0.scale(Math.sin(roll))),
      nrm: n0.scale(Math.cos(roll)).subtract(d.side.scale(Math.sin(roll))),
    };
  };
  // Thick where the frond is broad, thinner toward the tip.
  const thickAt = (t: number): number => 0.07 * (1 - 0.5 * t);
  // The rib strip: ~11 cm wide at the root, narrowing to the tip, standing
  // a little proud of the blade so it catches its own highlight.
  const ribAt = (t: number): number => 0.055 * (1 - 0.6 * t);
  const ribUp = (t: number): number => 0.02 * (1 - 0.5 * t);
  // Darker root over the first 40 %, then the blade tone out to the tip.
  const topAt = (t: number): RGB => (t < 0.4 ? mixOklab(col.root, col.blade, t / 0.4) : mixOklab(col.blade, col.tip, (t - 0.4) / 0.6));
  const shadeHalf = (c: RGB): RGB => mixOklab(c, col.edge, 0.32);
  const rings: Ring[] = stations.map((s) => {
    const fr = frame(s.t);
    const e = thickAt(s.t);
    const edgePoint = (w: number, sign: number, shift: number): Vector3 =>
      fr.P.add(fr.side.scale(sign * w * half))
        .subtract(fr.nrm.scale(FOLD * w * half))
        .add(fr.tan.scale(shift));
    const Lt = edgePoint(s.wl, -1, s.sl);
    const Rt = edgePoint(s.wr, 1, s.sr);
    const rw = ribAt(s.t);
    const up = fr.nrm.scale(ribUp(s.t));
    const along = topAt(s.t);
    const outer = mixOklab(along, col.rim, 0.6);
    const lightL = cutSide > 0;
    return {
      RL: fr.P.add(fr.side.scale(-rw)).add(up),
      RR: fr.P.add(fr.side.scale(rw)).add(up),
      K: fr.P.subtract(fr.nrm.scale(e)),
      Lt,
      Lb: Lt.subtract(fr.nrm.scale(e)),
      Rt,
      Rb: Rt.subtract(fr.nrm.scale(e)),
      inL: lightL ? along : shadeHalf(along),
      outL: lightL ? outer : shadeHalf(outer),
      inR: lightL ? shadeHalf(along) : along,
      outR: lightL ? shadeHalf(outer) : outer,
      rib: mixOklab(along, col.rib, clamp((s.t - 0.1) / 0.2, 0, 1)),
      edge: mixOklab(along, col.edge, 0.8),
    };
  });

  // Root: the blade grows out of one point inside the crown core (a stalk
  // end there would only be a plank across the middle of the crown).
  const a0 = rings[0];
  m.tri(root, a0.Lt, a0.RL, p, [col.root, a0.outL, a0.inL]);
  m.tri(root, a0.RL, a0.RR, p, [col.root, a0.rib, a0.rib]);
  m.tri(root, a0.RR, a0.Rt, p, [col.root, a0.inR, a0.outR]);
  m.tri(root, a0.Rt, a0.Rb, p, [col.root, a0.edge, a0.edge]);
  m.tri(root, a0.Rb, a0.K, p, [col.keel, col.under, col.keel]);
  m.tri(root, a0.K, a0.Lb, p, [col.keel, col.keel, col.under]);
  m.tri(root, a0.Lb, a0.Lt, p, [col.root, a0.edge, a0.edge]);

  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    // Top and underside are split from the midrib side of `a` to the edge
    // of `b` by hand: behind a hooked tooth the quad is concave at the
    // bottom of the cut, and the other diagonal would fold a triangle over.
    m.tri(a.RL, a.Lt, b.Lt, p, [a.inL, a.outL, b.outL]);
    m.tri(a.RL, b.Lt, b.RL, p, [a.inL, b.outL, b.inL]);
    m.tri(a.RL, b.RL, b.RR, p, [a.rib, b.rib, b.rib]);
    m.tri(a.RL, b.RR, a.RR, p, [a.rib, b.rib, a.rib]);
    m.tri(a.RR, b.RR, b.Rt, p, [a.inR, b.inR, b.outR]);
    m.tri(a.RR, b.Rt, a.Rt, p, [a.inR, b.outR, a.outR]);
    m.tri(a.K, a.Rb, b.Rb, p, [col.keel, col.under, col.under]);
    m.tri(a.K, b.Rb, b.K, p, [col.keel, col.under, col.keel]);
    m.tri(a.K, b.K, b.Lb, p, [col.keel, col.keel, col.under]);
    m.tri(a.K, b.Lb, a.Lb, p, [col.keel, col.under, col.under]);
    m.quad(a.Rt, b.Rt, b.Rb, a.Rb, p, [a.edge, b.edge, b.edge, a.edge]);
    m.quad(a.Lt, a.Lb, b.Lb, b.Lt, p, [a.edge, a.edge, b.edge, b.edge]);
  }

  // Tip: the outline closes to a point that keeps a little thickness.
  const z = rings[rings.length - 1];
  const fr = frame(1);
  const Pt = fr.P.subtract(fr.nrm.scale(FOLD * 0.02));
  const Pb = Pt.subtract(fr.nrm.scale(thickAt(1) * 0.6));
  const tipTop = mixOklab(topAt(1), col.rim, 0.6);
  const tipEdge = mixOklab(tipTop, col.edge, 0.8);
  m.tri(z.RL, z.Lt, Pt, p, [z.inL, z.outL, tipTop]);
  m.tri(z.RL, Pt, z.RR, p, [z.rib, tipTop, z.rib]);
  m.tri(z.RR, Pt, z.Rt, p, [z.inR, tipTop, z.outR]);
  m.quad(z.Rt, Pt, Pb, z.Rb, p, [z.edge, tipEdge, tipEdge, z.edge]);
  m.quad(z.Lt, z.Lb, Pb, Pt, p, [z.edge, z.edge, tipEdge, tipEdge]);
  m.tri(z.K, z.Rb, Pb, p, [col.keel, col.under, col.under]);
  m.tri(z.K, Pb, z.Lb, p, [col.keel, col.under, col.under]);
}

// ---------------------------------------------------------------------------
// Root flare

/**
 * The sheet's palm foot: broad faceted WEDGE toes — wide on the ground,
 * narrowing to a flat ridge — that leave the trunk high in a concave sweep
 * and end in a blunt nose. `rootFlare` in nature.ts builds the oak's thin
 * buttress fins; a palm's toes are chunkier and need only three stations.
 * 20 triangles a toe, closed (back inside the trunk, sole under ground).
 */
function wedgeToes(
  m: SolidMesh,
  o: { radius: number; toes: number; reach: number; height: number; startDeg: number; seed: number; jitter: () => number },
  p: LimbPaint,
): void {
  const R = o.radius;
  // [distance from the axis in trunk radii (reach for the last), ridge
  // height as a fraction of `height`, half width of the ridge, half width
  // on the ground — widths in trunk radii].
  const stations: readonly (readonly [number, number, number, number])[] = [
    [0.1, 1.0, 0.24, 0.5],
    [1.2, 0.42, 0.26, 0.56],
    [-1, 0.0, 0.18, 0.4],
  ];
  const down = new Vector3(0, -SKIRT, 0);
  const tri = (a: Vector3, b: Vector3, c: Vector3, out: Vector3, fp: Paint): void => {
    const n = Vector3.Cross(b.subtract(a), c.subtract(a));
    if (Vector3.Dot(n, out) >= 0) m.tri(a, b, c, fp);
    else m.tri(a, c, b, fp);
  };
  const face = (q: Vector3[], out: Vector3, limbSeed: number, side: number, band: number): void => {
    const center = q.reduce((s, v) => s.add(v), new Vector3()).scale(1 / q.length);
    const n = Vector3.Cross(q[2].subtract(q[0]), q[3].subtract(q[1]));
    if (Vector3.Dot(n, out) < 0) n.scaleInPlace(-1);
    n.normalize();
    const fp = typeof p === 'function' ? p({ limb: limbSeed, side, band, t: band / 2, normal: n, center }) : p;
    tri(q[0], q[1], q[2], out, fp);
    tri(q[0], q[2], q[3], out, fp);
  };
  for (let i = 0; i < o.toes; i++) {
    const a = (o.startDeg + (i + o.jitter() * 0.4) * (360 / o.toes)) * DEG;
    const dir = new Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new Vector3(dir.z, 0, -dir.x);
    const reach = o.reach * (1 + o.jitter() * 0.18);
    const h = o.height * (1 + o.jitter() * 0.15);
    const wide = 1 + o.jitter() * 0.15;
    const rows = stations.map(([d, y, top, foot], k) => {
      const c = dir.scale(d < 0 ? reach : d * R);
      // The nose stands a hand's width proud of the ground, not a knife.
      const ry = k === stations.length - 1 ? 0.06 : h * y;
      return [
        c.add(side.scale(-foot * R * wide)).add(down),
        c.add(side.scale(-top * R * wide)).add(new Vector3(0, ry, 0)),
        c.add(side.scale(top * R * wide)).add(new Vector3(0, ry, 0)),
        c.add(side.scale(foot * R * wide)).add(down),
      ];
    });
    const limbSeed = o.seed * 31 + i;
    face([rows[0][3], rows[0][2], rows[0][1], rows[0][0]], dir.scale(-1), limbSeed, 3, 0);
    const last = rows[rows.length - 1];
    face(last, dir, limbSeed, 3, 2);
    for (let k = 0; k < rows.length - 1; k++) {
      const mid = dir.scale((stations[k][0] * R + (k + 1 === rows.length - 1 ? reach : stations[k + 1][0] * R)) / 2).add(down);
      for (let j = 0; j < 3; j++) {
        const q = [rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]];
        const c = q.reduce((s, v) => s.add(v), new Vector3()).scale(0.25);
        face(q, c.subtract(mid), limbSeed, j, k);
      }
      face([rows[k][0], rows[k][3], rows[k + 1][3], rows[k + 1][0]], new Vector3(0, -1, 0), limbSeed, 3, k);
    }
  }
}

// ---------------------------------------------------------------------------
// Layout

// Hero rolls: the side fronds turn their top face toward the front viewer,
// as on the sheet — gently, or the palm turned round shows all undersides.
const facing = (yaw: number, by: number): number => -by * Math.sin(yaw * DEG);

// The hero's crown, sheet front view: yaw 270 = toward the left of the
// sheet, 180 = toward the viewer.
const HERO_FRONDS: FrondSpec[] = [
  // Upper row: the two big side fronds, the two upright ones at the back,
  // the two that arch toward the viewer.
  { yaw: 262, lift: 48, droop: 116, bias: 1.0, sweep: 10, length: 3.1, width: 1.3, roll: facing(262, 12), light: 1.0, slots: UPPER_SLOTS, cuts: [0.72, 0.7, 0.62] },
  { yaw: 82, lift: 46, droop: 114, bias: 1.0, sweep: -10, length: 3.05, width: 1.3, roll: facing(82, 12), light: 0.72, slots: UPPER_SLOTS, cuts: [0.7, 0.72, 0.6], lead: [1, 0.2] },
  { yaw: 306, lift: 74, droop: 122, bias: 1.8, sweep: -6, length: 3.3, width: 1.04, roll: facing(306, 10), light: 0.55, slots: UPPER_SLOTS, cuts: [0.68, 0, 0.66] },
  { yaw: 44, lift: 76, droop: 124, bias: 1.9, sweep: 6, length: 3.35, width: 1.04, roll: facing(44, 10), light: 0.72, slots: UPPER_SLOTS, cuts: [0, 0.72, 0.64], lead: [0, 0.2] },
  { yaw: 208, lift: 44, droop: 112, bias: 1.0, sweep: -8, length: 2.9, width: 1.32, roll: facing(208, 10), light: 1.0, slots: UPPER_SLOTS, cuts: [0.7, 0.7, 0.62] },
  { yaw: 142, lift: 46, droop: 114, bias: 1.0, sweep: 8, length: 2.85, width: 1.28, roll: facing(142, 10), light: 0.5, slots: UPPER_SLOTS, cuts: [0.72, 0.66, 0] },
  // Lower row, in the gaps of the upper one.
  { yaw: 290, lift: -10, droop: 72, bias: 1.1, sweep: 0, length: 3.2, width: 1.15, roll: facing(290, 10), light: 0.18, slots: LOWER_SLOTS, cuts: [0.7, 0.62] },
  { yaw: 112, lift: -12, droop: 70, bias: 1.1, sweep: 0, length: 3.2, width: 1.15, roll: facing(112, 10), light: 0.12, slots: LOWER_SLOTS, cuts: [0.68, 0.64] },
  { yaw: 234, lift: -8, droop: 72, bias: 1.1, sweep: 0, length: 3.05, width: 1.1, roll: -8, light: 0.22, slots: LOWER_SLOTS, cuts: [0.66, 0.7] },
  { yaw: 356, lift: -8, droop: 74, bias: 1.1, sweep: 0, length: 3.15, width: 1.1, roll: 6, light: 0.12, slots: LOWER_SLOTS, cuts: [0.7, 0.6] },
];

interface Layout {
  /** Lean: compass direction and how far the crown point stands off. */
  leanTo: number;
  leanBy: number;
  /** Sideways bow of the trunk at mid height (an S seen from the front). */
  bow: number;
  /** Trunk radius above the foot and under the crown. */
  girth: number;
  girthTop: number;
  /** Segments above the foot. */
  segments: number;
  toes: number;
  fronds: FrondSpec[];
}

/** Trailing-edge cuts for a frond with `n` slots: deep V notches, at most
 * one slot left whole. */
function drawCuts(r: Rng, n: number): number[] {
  const cuts = Array.from({ length: n }, () => r.range(0.62, 0.74));
  if (n > 2 && r.chance(0.4)) cuts[r.int(0, n - 1)] = 0;
  return cuts;
}

function layout(v: Variant): Layout {
  const vt = v.fork('trunk');
  const girth = vt.num(0.44, 0.05);
  const trunk = {
    leanTo: 35,
    leanBy: vt.range(1.0, 0.45, 1.35),
    bow: vt.range(0, -0.28, 0.28),
    girth,
    girthTop: girth * vt.num(0.48, 0.05),
    segments: vt.int(6, 5, 7),
    toes: vt.int(5, 4, 5),
  };
  if (v.hero) return { ...trunk, fronds: HERO_FRONDS };

  const vc = v.fork('crown');
  const r = vc.r;
  // One character for the whole crown: perky or hanging, slim or broad.
  const perk = r.range(-7, 7);
  const broad = r.range(0.9, 1.08);
  const upper = r.int(5, 6);
  const lower = r.int(3, 4);
  // Two or three fronds stand up and make the skyline, next to each other
  // or one apart — never one alone (a flag) and never none (an umbrella).
  const first = r.int(0, upper - 1);
  const tallOnes = new Set([first, (first + r.int(1, 2)) % upper]);
  if (r.chance(0.35)) tallOnes.add((first + 3) % upper);
  // Every crown spans the sheet's range of top tones, mid green to
  // yellow-lime, dealt out round the crown in a random order.
  const lights = r.shuffle(Array.from({ length: upper }, (_, i) => 0.48 + (0.52 * i) / (upper - 1)));
  const fronds: FrondSpec[] = [];
  const start = r.range(0, 360);
  const yaws: number[] = [];
  for (let i = 0; i < upper; i++) {
    const tall = tallOnes.has(i);
    const yaw = start + (i + r.range(-0.2, 0.2)) * (360 / upper);
    yaws.push(yaw);
    fronds.push({
      yaw,
      lift: Math.min(78, (tall ? r.range(70, 77) : r.range(42, 50)) + perk),
      droop: tall ? r.range(116, 126) : r.range(108, 120),
      bias: tall ? r.range(1.6, 1.95) : r.range(0.95, 1.1),
      sweep: r.range(-12, 12),
      length: tall ? r.range(3.15, 3.35) : r.range(2.8, 3.15),
      width: r.range(1.2, 1.34) * broad * (tall ? 0.8 : 1),
      roll: r.range(-14, 14),
      light: clamp(lights[i] + r.range(-0.04, 0.04), 0.45, 1),
      slots: UPPER_SLOTS,
      cuts: drawCuts(r, 3),
      lead: r.chance(0.4) ? [r.int(0, 2), 0.2] : undefined,
    });
  }
  // The lower row hangs in the widest gaps of the upper one, so from above
  // its darker tips show between the upper fronds and the plan reads as a
  // full radial crown instead of a five-point star.
  const gaps = yaws
    .map((y, i) => {
      const next = i + 1 < upper ? yaws[i + 1] : yaws[0] + 360;
      return { mid: (y + next) / 2, size: next - y };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, lower);
  for (const g of gaps) {
    fronds.push({
      yaw: g.mid + r.range(-6, 6),
      lift: r.range(-14, -6) + perk * 0.5,
      droop: r.range(66, 78),
      bias: 1.1,
      sweep: r.range(-8, 8),
      length: r.range(3.0, 3.3),
      width: r.range(1.05, 1.18) * broad,
      roll: r.range(-12, 12),
      light: r.range(0.08, 0.25),
      slots: LOWER_SLOTS,
      cuts: drawCuts(r, 2),
    });
  }
  // The whole palm turned and maybe mirrored, so no two seeds show the same
  // side. Done on the numbers, not on the mesh, so the crown can be sized
  // against the design's box in the frame it will stand in.
  const pose = v.fork('pose');
  const flip = pose.r.chance(0.5) ? -1 : 1;
  return turned(
    {
      ...trunk,
      leanTo: trunk.leanTo * flip,
      bow: trunk.bow * flip,
      fronds: fronds.map((f) => ({ ...f, yaw: f.yaw * flip, sweep: f.sweep * flip, roll: f.roll * flip })),
    },
    pose.r.range(0, 360),
  );
}

function turned(L: Layout, by: number): Layout {
  return { ...L, leanTo: L.leanTo + by, fronds: L.fronds.map((f) => ({ ...f, yaw: f.yaw + by })) };
}

/** Centre line of the trunk, s = 0 on the ground … 1 at the crown point: it
 * leaves the ground upright and bends over further the higher it gets. */
function trunkPoint(L: Layout, height: number, s: number): Vector3 {
  const a = L.leanTo * DEG;
  const along = L.leanBy * (0.28 * s + 0.72 * s * s);
  const across = L.bow * Math.sin(Math.PI * s);
  return new Vector3(Math.sin(a) * along + Math.cos(a) * across, s * height, Math.cos(a) * along - Math.sin(a) * across);
}

// ---------------------------------------------------------------------------
// Colour

/**
 * Hold a variant's foliage tone at the hero's chroma and no more than a
 * hair lighter: the cool, pale moods otherwise turn the crown pastel mint,
 * which is not in the sheet's swatch row (deep teal, jade, green, lime,
 * yellow-lime). Hue and deeper/darker shifts pass through.
 */
function holdChroma(c: RGB, hero: RGB): RGB {
  const [L, a, b] = rgbToOklab(c);
  const [Lh, ah, bh] = rgbToOklab(hero);
  const C = Math.hypot(a, b);
  const Ch = Math.hypot(ah, bh);
  const k = C < Ch * 0.95 ? (Ch * 0.95) / Math.max(C, 1e-6) : 1;
  return oklabToRgb(Math.min(L, Lh + 0.025), a * k, b * k);
}

// The sheet's trunk is a light cinnamon with a warm sun side (#DD753F lit),
// lighter and more orange than the palette's base bark under this lighting.
const HERO_BARK = {
  base: mixOklab(BARK.base, BARK.highlight, 0.3),
  light: mixOklab(BARK.base, BARK.highlight, 0.78),
  dark: mixOklab(BARK.base, BARK.shadow, 0.45),
};

// ---------------------------------------------------------------------------
// Build

interface Built {
  mesh: SolidMesh;
  fit: Fit;
  layout: Layout;
  /** Height of the crown point, before the fit. */
  height: number;
  /** What the far model needs to grow the same crown: the fronds' scale
   * and where they start (before the fit), and the tones. */
  grow: number;
  heart: Vector3;
  leaves: FoliageTones;
  bark: ReturnType<typeof barkTones>;
}

// The fronds grow from a point this far above the end of the trunk.
const HEART = 0.1;

function construct(seed: number): Built {
  const v = variant(seed, ID);
  let L = layout(v);
  // Bark gets a stronger mood than the default: at the default strength the
  // five trunks are indistinguishable.
  const bark = barkTones(v, HERO_BARK, 1.8);
  const heroLeaves = foliageTones(variant(0, ID));
  const raw = foliageTones(v);
  const leaves: FoliageTones = v.hero
    ? raw
    : { top: holdChroma(raw.top, heroLeaves.top), mid: holdChroma(raw.mid, heroLeaves.mid), under: holdChroma(raw.under, heroLeaves.under), deep: raw.deep };
  const target = v.size(FIT, 0.1, 0.04);
  const g = L.girth;

  // Crown first, about its own origin: the fronds, tipped half as far as the
  // trunk leans, then sized so their plan fills the design's box. What the
  // crown leaves of the height is the trunk's — a flat crown gets a tall
  // trunk, a perky one a short trunk — and `fitSize` has only a few percent
  // left to correct.
  const grown = (lay: Layout): { crown: SolidMesh; wide: number; deep: number; rise: number } => {
    const crown = new SolidMesh();
    for (const f of lay.fronds) frond(crown, new Vector3(), f, leaves);
    lean(crown, (0.45 * Math.atan((lay.leanBy * 1.72) / 3.9)) / DEG, lay.leanTo);
    const b = crown.bounds();
    return { crown, wide: b.max.x - b.min.x, deep: b.max.z - b.min.z, rise: b.max.y };
  };
  let C = grown(L);
  if (!v.hero) {
    // A crown of five fronds is no circle: of six ways to stand (the design
    // is the same palm from any side) take the one whose plan is nearest
    // the box's, instead of squeezing a long crown into it afterwards.
    const off = (c: { wide: number; deep: number }): number => Math.abs(Math.log((c.wide / c.deep) * (target.z / target.x)));
    for (let k = 1; k < 6; k++) {
      const other = turned(L, k * 30);
      const c = grown(other);
      if (off(c) < off(C) - 1e-9) {
        L = other;
        C = c;
      }
    }
  }
  const crown = C.crown;
  // Sized for a plan 10 % over the box: `fitSize` then narrows the whole
  // palm by that much (invisible on an organic shape), which buys the crown
  // the height the sheet gives it — fronds sized exactly to the box leave a
  // squat crown on a pole.
  const grow = clamp(Math.sqrt(((target.x * 1.1) / C.wide) * ((target.z * 1.1) / C.deep)), 0.8, 1.3);
  crown.scale(grow);
  const height = clamp(target.y - C.rise * grow - HEART, 3.3, 4.8);

  // Trunk. The foot flares out to the ground; above it the segments get
  // shorter toward the crown. Each joint is two path points a collar's
  // height apart: the segment below ends thin, the one above starts wide,
  // and the short band between them — facing down and out — is the dark
  // ring.
  const m = new SolidMesh();
  const at = (s: number): Vector3 => trunkPoint(L, height, s);
  const foot = 0.8 / height;
  const joints: number[] = [foot];
  {
    const weights = Array.from({ length: L.segments }, (_, i) => 1 - (0.5 * i) / Math.max(1, L.segments - 1));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let s = foot;
    for (let i = 0; i < L.segments - 1; i++) {
      s += (weights[i] / total) * (1 - foot);
      joints.push(s);
    }
  }
  const radiusAt = (s: number): number => g + (L.girthTop - g) * Math.pow(clamp((s - foot) / (1 - foot), 0, 1), 0.9);
  const STEP = 0.085;
  const COLLAR = 0.11;
  // The foot itself flares (1.7× at the ground, 1.25× a knee's height up)
  // before the toes break out of it.
  const path: Vector3[] = [new Vector3(0, -SKIRT, 0), at(0.3 / height)];
  const radius: number[] = [g * 1.7, g * 1.22];
  for (const s of joints) {
    const tan = at(s + 0.02).subtract(at(s - 0.02)).normalize();
    path.push(at(s).subtract(tan.scale(COLLAR / 2)), at(s).add(tan.scale(COLLAR / 2)));
    radius.push(radiusAt(s) * (1 - STEP), radiusAt(s) * (1 + STEP));
  }
  path.push(at(1));
  radius.push(L.girthTop * (1 - STEP));
  const WOOD = barkPaint(bark, { seed });
  const RING = paint(bark.dark, { gloss: 0.1, smooth: 16 });
  // Bands: foot flare, foot, then collar, segment, collar, … — the collars
  // are bands 2, 4, 6, …
  const trunkPaint = (f: LimbFacet) => (f.side >= 0 && f.band >= 2 && f.band % 2 === 0 ? RING : WOOD(f));
  limb(m, { path, radius, sides: 7, rough: 0.1, levelBase: true, capBase: true, capTip: false, seed: seed * 7 + 1 }, trunkPaint);
  const tr = v.fork('toes').r;
  wedgeToes(
    m,
    { radius: g * 1.15, toes: L.toes, reach: g * 2.35, height: 0.72, startDeg: v.range(15, 0, 360), seed: seed * 7 + 2, jitter: () => (v.hero ? 0 : tr.range(-1, 1)) },
    WOOD,
  );

  // Crown core: the knot the fronds grow from; the trunk ends inside it.
  // Small and in the fronds' root tone, so from above the fronds meet in a
  // point instead of round a dark ball.
  const up = at(1).subtract(at(0.94)).normalize();
  const heart = at(1).add(up.scale(HEART));
  const coreTone = frondColors(leaves, 0.7).root;
  Polytope.lump({ radii: [0.28, 0.22, 0.28], facets: 12, seed: seed * 7 + 3, jitter: 0.5 })
    .move(at(1).add(up.scale(0.04)))
    .emit(m, paint(coreTone, { gloss: 0.2, smooth: 0 }));

  const frondsFrom = m.mark();
  m.append(crown, heart);
  const fit = fitSize(m, target, { recenter: false });

  // Wind: the trunk and the crown attachments stand still, a frond bends
  // along its length — weight by distance from the crown point.
  const c = toV3(fitPoint(fit, [heart.x, heart.y, heart.z]));
  m.setWind((p) => Math.pow(clamp((Vector3.Distance(p, c) - 0.35) / 2.2, 0, 1), 1.4), frondsFrom);
  const built = { mesh: m, fit, layout: L, height, grow, heart, leaves, bark };
  layouts.set(seed, { fit, layout: L, height, grow, heart, leaves, bark });
  return built;
}

/** The last construction's values per seed (no mesh): the far model of a
 * seed is built right after its near model in the world props. */
const layouts = new Map<number, Omit<Built, 'mesh'>>();

/**
 * Far frond: the same midrib (lift, droop, sweep, length) as `frond`,
 * reduced to a closed arched blade of 6 triangles — root, a rib point at the
 * crest (33 %), the two blade edges at 60 % (lowered by the same tent fold)
 * and the tip; the underside is the plane through root, edges and tip.
 * From above it reads as the sheet's arching paddle, from below as its
 * deeper underside, never as a hole.
 */
function farFrond(m: SolidMesh, f: FrondSpec, tones: FoliageTones, widen = 1): void {
  const col = frondColors(tones, f.light);
  const N = 16;
  const pts: Vector3[] = [new Vector3()];
  const dirAt = (t: number): { tan: Vector3; side: Vector3 } => {
    const pitch = (f.lift - f.droop * Math.pow(t, f.bias)) * DEG;
    const h = (f.yaw + f.sweep * t) * DEG;
    return {
      tan: new Vector3(Math.sin(h) * Math.cos(pitch), Math.sin(pitch), Math.cos(h) * Math.cos(pitch)),
      side: new Vector3(Math.cos(h), 0, -Math.sin(h)),
    };
  };
  for (let i = 0; i < N; i++) pts.push(pts[i].add(dirAt((i + 0.5) / N).tan.scale(f.length / N)));
  const at = (t: number): Vector3 => {
    const x = clamp(t, 0, 1) * N;
    const i = Math.min(N - 1, Math.floor(x));
    return Vector3.Lerp(pts[i], pts[i + 1], x - i);
  };
  // The rib point at the crest of the arch (a third of the way out), the
  // blade's corners past it (60 %, where the near frond is still broad and
  // already falling), so the paddle droops toward its tip as on the sheet.
  // A kite shows less leaf than the near outline: a third more width.
  const M = at(0.33);
  const te = 0.6;
  const d = dirAt(te);
  const nrm = Vector3.Cross(d.tan, d.side).normalize();
  const E = at(te);
  const half = (f.width / 2) * outline(te) * 1.35 * widen;
  const L = E.subtract(d.side.scale(half)).subtract(nrm.scale(FOLD * half));
  const R = E.add(d.side.scale(half)).subtract(nrm.scale(FOLD * half));
  const root = pts[0];
  const tip = pts[N];
  // The notched (trailing) half a step darker, as on the near frond.
  const lightL = f.roll < 0;
  const blade = paint(col.blade, { gloss: 0.35, smooth: 0 });
  const shaded = paint(mixOklab(col.blade, col.edge, 0.32), { gloss: 0.35, smooth: 0 });
  const under = paint(col.under, { gloss: 0.35, smooth: 0 });
  const inside = Vector3.Lerp(Vector3.Lerp(L, R, 0.5), Vector3.Lerp(root, tip, 0.5), 0.5).subtract(nrm.scale(0.01));
  outTri(m, root, M, L, inside, lightL ? blade : shaded);
  outTri(m, M, tip, L, inside, lightL ? blade : shaded);
  outTri(m, root, R, M, inside, lightL ? shaded : blade);
  outTri(m, M, R, tip, inside, lightL ? shaded : blade);
  outTri(m, root, L, R, inside, under);
  outTri(m, L, tip, R, inside, under);
}

/**
 * The far model: the same palm — trunk through the same curve (bend and
 * lean), the crown's fronds with this seed's yaw, lift, droop and length,
 * leaned and sized exactly as the near crown, the same fit. Upper fronds
 * first; a frond the budget cannot buy is one of the low back row, and the
 * fronds that are bought grow broader to make up its leaf.
 */
function constructFar(seed: number, target: number): SolidMesh {
  const B = layouts.get(seed) ?? construct(seed);
  const L = B.layout;
  const m = new SolidMesh();
  const rich = target >= 60;
  const g = L.girth;
  const at = (s: number): Vector3 => trunkPoint(L, B.height, s);
  const stations = rich ? [0, 0.12, 0.55, 1] : [0, 0.5, 1];
  const path = stations.map((s) => (s === 0 ? new Vector3(0, -SKIRT, 0) : at(s)));
  const radius = stations.map((s) => (s === 0 ? g * 1.25 : s < 0.2 ? g * 1.0 : g + (L.girthTop - g) * s));
  farStick(m, { path, radius, sides: rich ? 5 : 4 }, paint(B.bark.base, { gloss: 0.1, smooth: 16 }));
  shadeBark(m, B.bark, { seed });
  const crown = new SolidMesh();
  // Upper (lit) fronds first, then the lower row by length.
  const order = [...L.fronds].sort((a, b) => (b.lift > 20 ? 1 : 0) - (a.lift > 20 ? 1 : 0) || b.length - a.length);
  const room = Math.max(1, Math.floor((target - m.triangleCount) / 6));
  // Fewer fronds than the near crown (quest: 5 of 8–10): each one broader,
  // so the crown keeps its leaf area — by the square root of what is
  // missing, at most 1.3 ×.
  const widen = Math.min(1.3, Math.sqrt(L.fronds.length / Math.min(room, L.fronds.length)));
  for (const f of order.slice(0, room)) farFrond(crown, f, B.leaves, widen);
  lean(crown, (0.45 * Math.atan((L.leanBy * 1.72) / 3.9)) / DEG, L.leanTo);
  crown.scale(B.grow);
  m.append(crown, B.heart);
  applyFit(m, B.fit);
  return m;
}

function colliders(seed: number): ColliderSpec[] {
  const { fit, layout: L, height } = construct(seed);
  // Two stacked cylinders following the lean: the lower one is what a car on
  // the ground meets, the upper one catches a jump. A low wide one under
  // them for the root toes.
  const at = (s: number): [number, number, number] => {
    const p = trunkPoint(L, height, s);
    return fitPoint(fit, [p.x, p.y, p.z]);
  };
  const lo = at(0.22);
  const hi = at(0.75);
  const top = at(1)[1];
  return [
    { shape: 'cylinder', base: [0, 0, 0], height: 0.4, radius: L.girth * 1.9 * fit.scale[0] },
    { shape: 'cylinder', base: [lo[0], 0, lo[2]], height: top * 0.5, radius: L.girth * 1.15 },
    { shape: 'cylinder', base: [hi[0], top * 0.5, hi[2]], height: top * 0.5, radius: L.girth * 0.9 },
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Turbo Palm',
  category: 'tree',
  size: SIZE,
  variants: 5,
  build: (seed) => construct(seed).mesh,
  buildFar: (seed, _scheme, target) => constructFar(seed, target),
  colliders,
  wind: true,
  triBudget: 1400,
  reference: {
    sheet: 'design-documents/environment-design-pack/trees/design-sheet.png',
    brief: 'design-documents/environment-design-pack/trees/t03-turbo-palm-brief.txt',
  },
};

export default asset;
