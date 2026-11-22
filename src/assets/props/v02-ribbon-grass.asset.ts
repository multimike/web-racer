import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEG, SolidMesh, adjustOklch, loopNormal, mixOklab, paint } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FOLIAGE } from '../palette';
import type { PropAsset } from '../types';
import { farTuft } from './farKit';
import { FOLIAGE_AMP, fitSize, sway, variant } from './nature';
import type { Variant } from './nature';

/**
 * V02 RIBBON GRASS — a fountain of broad, keeled ribbon blades from one tight
 * root: fresh green at the foot running out to yellow tips
 * (vegetation/design-sheet.png, second column).
 *
 * Parts list, measured off the sheet (front = looking toward +z, yaw 0):
 *  - twelve blades, every one a broad STRAP: 14–15.5 cm across, full width
 *    from a fifth of the way up to 70 %, still half width just before a
 *    short blunt point, a low crease down the middle. Never thinner — "do
 *    not substitute many hair-thin blades";
 *  - five TALL blades leaving the root at 70–80° and arching over evenly,
 *    the highest 0.65 m — the big curl to the upper left is the sheet's
 *    signature;
 *  - four ARCHING blades in the gaps, leaving at 52–60°, rising to mid
 *    height and coming down again at the edge of the 0.85 m footprint: with
 *    the tall ones that fills the whole dome, no empty band between tiers;
 *  - three SHORT blades filling the foot.
 * Every blade sweeps 10–16° sideways along its length and leans its face
 * 16–26° toward that side: from above the clump is a loose pinwheel of
 * sickles (the sheet's top view), never a starburst of needles. All roots
 * start under the ground inside a 10 cm circle.
 *
 * A blade here is a thin closed SOLID, not a two-sided card (`ribbon`): a
 * ridged top over a flat underside, 6 triangles a segment where a folded
 * card costs 8 — which pays for six segments on the long blades. Joints are
 * placed by EQUAL BEND (see `stations`), so the bend is a curve, not elbows.
 *
 * Variants: the HABIT changes (fountain / upright tussock / lax and wide /
 * windswept to one side, still covering three quarters of the compass), the
 * blade count (11–13), each blade's length, lift, bend, sweep and turn —
 * and the colour mood, plus how far the yellow runs down the blades.
 */

const ID = 'v02-ribbon-grass';
const SIZE = { x: 0.85, y: 0.65, z: 0.75 };
const BUDGET = 350;
const SKIRT = 0.05;

interface Blade {
  /** Compass heading, degrees (0 = +z, 90 = +x). */
  yaw: number;
  length: number;
  /** Elevation at the root, degrees. */
  lift: number;
  /** Total bend from root to tip, degrees. */
  droop: number;
  /** Where the bend sits: 1.5 = an even arch, 2.5 = a straight blade that
   * curls over at the top. */
  bias: number;
  /** Widest width, meters. */
  width: number;
  /** Distance of the root from the middle of the clump. */
  out: number;
  /** Turn about its own length at the root, degrees: a blade shows its face
   * a little to the side it sweeps toward, so the clump is a loose pinwheel
   * and no blade is edge-on to every camera round it. */
  roll: number;
  /** Further turn about its own length from root to tip, degrees. */
  twist: number;
  /** Heading change from root to tip, degrees: the sideways sweep that
   * makes a blade a sickle in plan, not a needle. */
  drift: number;
  segments: number;
}

// The hero. The sheet's front view looks toward +z (the lab's yaw 0): 270 is
// the viewer's left, 180 comes toward the viewer. Blades leave at every
// elevation from 50° to 80° and arch over evenly, so the clump is one full
// fan (a dome of blades), not an upright sheaf over a low ring. The numbers
// are real: the clump comes out of them close to the design's box, and
// `fitSize` only trims the rest.
const HERO: Blade[] = [
  // tall, all round
  { yaw: 284, length: 0.84, lift: 79, droop: 146, bias: 1.7, width: 0.155, out: 0.03, roll: 26, twist: 12, drift: -16, segments: 6 }, // the big curl to the left
  { yaw: 334, length: 0.82, lift: 80, droop: 112, bias: 1.8, width: 0.15, out: 0.028, roll: 20, twist: -10, drift: 14, segments: 6 },
  { yaw: 26, length: 0.84, lift: 80, droop: 106, bias: 1.8, width: 0.155, out: 0.028, roll: -20, twist: 12, drift: -12, segments: 6 }, // the tallest
  { yaw: 82, length: 0.82, lift: 76, droop: 140, bias: 1.7, width: 0.155, out: 0.03, roll: -26, twist: -12, drift: 16, segments: 6 }, // curls over to the right
  { yaw: 198, length: 0.74, lift: 70, droop: 126, bias: 1.7, width: 0.15, out: 0.032, roll: -22, twist: 10, drift: -12, segments: 6 }, // arches toward the viewer, left
  // arching, in the gaps
  { yaw: 246, length: 0.66, lift: 58, droop: 124, bias: 1.6, width: 0.14, out: 0.045, roll: 22, twist: -12, drift: 14, segments: 6 },
  { yaw: 146, length: 0.68, lift: 60, droop: 120, bias: 1.6, width: 0.14, out: 0.045, roll: 24, twist: -12, drift: 14, segments: 6 }, // front right
  { yaw: 308, length: 0.62, lift: 54, droop: 116, bias: 1.6, width: 0.138, out: 0.045, roll: -20, twist: 10, drift: -12, segments: 6 },
  { yaw: 54, length: 0.62, lift: 54, droop: 114, bias: 1.6, width: 0.138, out: 0.045, roll: 20, twist: -10, drift: 12, segments: 6 },
  // short, filling the foot
  { yaw: 172, length: 0.38, lift: 48, droop: 84, bias: 1.5, width: 0.12, out: 0.05, roll: -16, twist: 8, drift: -10, segments: 3 },
  { yaw: 106, length: 0.36, lift: 46, droop: 80, bias: 1.5, width: 0.12, out: 0.05, roll: 16, twist: -8, drift: 10, segments: 3 },
  { yaw: 4, length: 0.38, lift: 48, droop: 82, bias: 1.5, width: 0.12, out: 0.05, roll: -16, twist: 8, drift: -10, segments: 3 },
];

/** Triangles of one blade (see `ribbon`): 6 a segment, 3 for the tip. */
const cost = (b: Blade): number => (b.segments - 1) * 6 + 3;

function layout(v: Variant): Blade[] {
  if (v.hero) return HERO;
  const r = v.fork('clump').r;
  // 0 fountain (the design, re-drawn) · 1 upright tussock · 2 lax and wide ·
  // 3 windswept.
  const habit = (v.seed - 1) % 4;
  const tall = [5, 6, 4, 5][habit];
  const arching = [4, 3, 5, 4][habit];
  const wind = r.range(0, 360);
  const blades: Blade[] = [];
  const start = r.range(0, 360);
  const count = tall + arching;
  for (let i = 0; i < count; i++) {
    const inner = i < tall;
    const ring = inner ? tall : arching;
    const k = inner ? i : i - tall;
    let yaw = start + (inner ? 0 : 180 / ring) + ((k + r.range(-0.22, 0.22)) / ring) * 360;
    let lift = inner ? r.range(72, 80) : r.range(50, 60);
    let droop = inner ? r.range(108, 150) : r.range(112, 124);
    let bias = inner ? r.range(1.7, 1.8) : r.range(1.55, 1.65);
    let length = inner ? r.range(0.78, 0.86) : r.range(0.6, 0.68);
    if (habit === 1) {
      // Tussock: everything stands up and only the tips nod.
      lift = inner ? r.range(80, 85) : r.range(66, 72);
      droop = inner ? r.range(80, 105) : r.range(100, 112);
      bias = inner ? 1.9 : 1.7;
      length *= inner ? 0.94 : 1.06;
    } else if (habit === 2) {
      // Lax: blades fall outward and lie low; the footprint is the feature.
      lift = inner ? r.range(68, 74) : r.range(44, 50);
      droop = inner ? r.range(130, 150) : r.range(100, 112);
      bias = inner ? 1.6 : 1.5;
      length *= inner ? 1.04 : 1.0;
    } else if (habit === 3) {
      // Windswept: every blade is turned part of the way downwind and the
      // downwind ones bend further — but the clump still covers most of the
      // compass (a quarter turn squeezed out of it, not half).
      const off = ((yaw - wind + 540) % 360) - 180;
      yaw = wind + off * 0.78;
      lift += Math.abs(off) > 90 ? 4 : -4;
      droop += Math.abs(off) > 90 ? -10 : 12;
    }
    const drift = r.sign() * r.range(10, 18);
    blades.push({
      yaw,
      length,
      lift,
      droop,
      bias,
      width: (inner ? 0.152 : 0.14) * r.range(0.94, 1.06),
      out: inner ? r.range(0.026, 0.034) : r.range(0.04, 0.05),
      roll: Math.sign(drift) * r.range(16, 26),
      twist: -Math.sign(drift) * r.range(6, 14),
      drift,
      segments: 6,
    });
  }
  // What the budget still allows goes into short blades round the foot: a
  // full tuft, not a spider. The windswept clump puts them upwind.
  let spent = blades.reduce((sum, b) => sum + cost(b), 0);
  for (let i = 0; i < 4 && spent + 15 <= BUDGET; i++) {
    const drift = r.sign() * r.range(8, 12);
    blades.push({
      yaw: habit === 3 ? wind + 180 + (i - 1) * 50 + r.range(-12, 12) : start + 60 + i * 97 + r.range(-20, 20),
      length: r.range(0.34, 0.4),
      lift: r.range(46, 54),
      droop: r.range(78, 88),
      bias: 1.5,
      width: 0.12 * r.range(0.94, 1.06),
      out: r.range(0.045, 0.052),
      roll: Math.sign(drift) * r.range(10, 18),
      twist: -Math.sign(drift) * r.range(4, 10),
      drift,
      segments: 3,
    });
    spent += 15;
  }
  return blades;
}

/**
 * Where the stations sit along a blade (fractions of its length): placed by
 * EQUAL BEND, so every joint turns the blade by about the same angle and it
 * reads as one continuous arc (equal lengths put nearly all of a tip-heavy
 * bend into the last two joints: elbows). Blended a third of the way back
 * toward equal lengths, so the straight root segment is not absurdly long.
 * The last station before the tip sits at 94 %: a short blunt point, the
 * blade still at half width just before it.
 */
function stations(b: Blade): number[] {
  const n = b.segments - 1;
  const out = [0];
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    out.push(0.94 * (0.68 * Math.pow(u, 1 / b.bias) + 0.32 * u));
  }
  out.push(1);
  return out;
}

/** Ribbon outline at t = 0 (root) … 1 (tip), as a fraction of the widest
 * width: a STRAP — half at the root, full by a fifth of the way up, still
 * 87 % at 70 %, half just before the blunt tip. */
function outline(t: number): number {
  if (t >= 1) return 0;
  if (t < 0.2) return 0.55 + 0.45 * Math.sin((t / 0.2) * Math.PI * 0.5);
  if (t < 0.7) return 1 - 0.13 * ((t - 0.2) / 0.5) ** 2;
  return 0.87 - 0.37 * Math.min(1, (t - 0.7) / 0.24) ** 1.4;
}

interface RibbonColors {
  /** Top surface, root → tip, one per station. */
  top: RGB[];
  /** The ridge line. */
  rib: RGB[];
  under: RGB[];
}

/**
 * One blade as a thin closed solid along `path`: a ridged top (two planes
 * meeting on a raised centre line) over a flat underside, ending in a point.
 * The section is turned about the path by `roll` at the root, plus `twist`
 * more by the tip.
 * 6 triangles a segment, 3 for the last. The root end is left open: it is
 * under the ground.
 */
function ribbon(m: SolidMesh, path: readonly Vector3[], widths: readonly number[], roll: number, twist: number, ridge: number, colors: RibbonColors, p: Paint): void {
  const n = path.length;
  // Sideways = level and square to the way the blade grows AT THIS STATION
  // (blades sweep sideways along their length), so the top looks at the
  // middle of the clump while the blade stands and at the sky once it has
  // arched over. A blade never stands quite vertical (lift < 90°), so its
  // tangent always has a heading.
  const st = path.map((q, k) => {
    const tan = path[Math.min(n - 1, k + 1)].subtract(path[Math.max(0, k - 1)]).normalize();
    let side = Vector3.Cross(new Vector3(0, 1, 0), new Vector3(tan.x, 0, tan.z)).normalize();
    let up = Vector3.Cross(tan, side);
    const a = (roll + twist * (k / (n - 1))) * DEG;
    [side, up] = [side.scale(Math.cos(a)).add(up.scale(Math.sin(a))), up.scale(Math.cos(a)).subtract(side.scale(Math.sin(a)))];
    const w = widths[k] / 2;
    return { L: q.subtract(side.scale(w)), R: q.add(side.scale(w)), T: q.add(up.scale(w * ridge)), up, side };
  });
  const face = (pts: Vector3[], cols: RGB[], dir: Vector3): void => {
    const ok = Vector3.Dot(loopNormal(pts), dir) >= 0;
    const q = ok ? pts : [...pts].reverse();
    const c = ok ? cols : [...cols].reverse();
    if (q.length === 3) m.tri(q[0], q[1], q[2], p, c);
    else m.quad(q[0], q[1], q[2], q[3], p, c);
  };
  for (let k = 0; k < n - 1; k++) {
    const a = st[k];
    const b = st[k + 1];
    const { top, rib, under } = colors;
    const left = a.up.subtract(a.side.scale(0.4));
    const right = a.up.add(a.side.scale(0.4));
    const down = a.up.scale(-1);
    if (k === n - 2) {
      face([a.L, a.T, b.T], [top[k], rib[k], top[k + 1]], left);
      face([a.T, a.R, b.T], [rib[k], top[k], top[k + 1]], right);
      face([a.L, a.R, b.T], [under[k], under[k], under[k + 1]], down);
    } else {
      face([a.L, a.T, b.T, b.L], [top[k], rib[k], rib[k + 1], top[k + 1]], left);
      face([a.T, a.R, b.R, b.T], [rib[k], top[k], top[k + 1], rib[k + 1]], right);
      face([a.L, a.R, b.R, b.L], [under[k], under[k], under[k + 1], under[k + 1]], down);
    }
  }
}

/** The centre line of a blade: leaves the root at `lift`, bends over by
 * `droop` and sweeps sideways by `drift`, sampled at the given fractions of
 * its length. Integrated in fine steps, so the curve does not depend on how
 * many stations it gets. */
function arch(from: Vector3, b: Blade, length: number, stations: readonly number[]): Vector3[] {
  const STEPS = 48;
  const out: Vector3[] = [];
  let at = from.clone();
  let next = 0;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    while (next < stations.length && stations[next] <= t + 1e-9) {
      out.push(at.clone());
      next++;
    }
    const pitch = (b.lift - b.droop * Math.pow(t + 0.5 / STEPS, b.bias)) * DEG;
    const yaw = (b.yaw + b.drift * Math.pow(t + 0.5 / STEPS, 1.3)) * DEG;
    const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    at = at.add(dir.scale((Math.cos(pitch) * length) / STEPS)).add(new Vector3(0, (Math.sin(pitch) * length) / STEPS, 0));
  }
  return out;
}

/**
 * The box a variant is fitted to. A habit has its own proportions (a lax
 * clump is wide and low, an upright one narrow and tall) and stretching it
 * onto the design's box would undo exactly that: so the natural box is
 * scaled UNIFORMLY to the volume of `target`, and only an axis that would
 * leave the lab's size band for variants (30 %, skirt included) is brought
 * back to its edge.
 */
function habitSize(m: SolidMesh, target: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const b = m.bounds();
  const natural = { x: b.max.x - b.min.x, y: b.max.y, z: b.max.z - b.min.z };
  const s = Math.cbrt((target.x / natural.x) * (target.y / natural.y) * (target.z / natural.z));
  const within = (n: number, design: number, most: number): number => Math.min(Math.max(n * s, design * 0.78), design * most);
  return { x: within(natural.x, SIZE.x, 1.22), y: within(natural.y, SIZE.y, 1.15), z: within(natural.z, SIZE.z, 1.22) };
}

function construct(seed: number): SolidMesh {
  const v = variant(seed, ID);
  let blades = layout(v);
  // Drop outer blades until the clump is inside the budget (never needed
  // for the hero).
  const total = (list: readonly Blade[]): number => list.reduce((sum, b) => sum + cost(b), 0);
  while (total(blades) > BUDGET) blades = blades.slice(0, -1);

  // Root → tip: a fresh green at the foot, lime through the middle, the
  // palette's yellow highlight at the tip. `run` = how far down the blade
  // the yellow reaches (variants only).
  const run = v.num(0.5, 0.3);
  const foot = v.tint(adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.5), 0, 1.1), FOLIAGE_AMP);
  // A touch of jade in the body green: pure lime turns olive on the half of
  // each blade that faces away from the sun.
  const body = v.tint(adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.12), 0, 1.06), FOLIAGE_AMP);
  const tip = v.tint(mixOklab(FOLIAGE.lime, FOLIAGE.highlight, 0.9), FOLIAGE_AMP, 0.6);
  // The underside only ever sees the ground's bounce light, and lime in shade
  // goes olive: its own albedo, a cooler, greener step toward jade and a
  // little LIGHTER than the top, so the shade side lands on the sheet's
  // saturated mid green.
  const under = v.tint(adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.42), 0.06, 1.14, 4), FOLIAGE_AMP);
  // The heart of the clump: the bottom of every blade a fifth darker and
  // greener (the baked occlusion barely reaches into a clump this open).
  const heart = v.tint(adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.72), -0.08, 1.1), FOLIAGE_AMP);
  const cr = v.r.fork('colour');
  // Smooth across the joints (equal-bend joints turn 20–25°): a blade shades
  // as one curved strap, crisp only along its crease and its edges.
  const LEAF = paint(body, { gloss: 0.35, smooth: 50 });

  const m = new SolidMesh();
  blades.forEach((b) => {
    const a = b.yaw * DEG;
    const stops = stations(b);
    const root = new Vector3(Math.sin(a) * b.out, -SKIRT, Math.cos(a) * b.out);
    // A blade may hang down to the ground but not dive into it: ease the
    // bend until the tip stays clear.
    let path = arch(root, b, b.length + SKIRT, stops);
    for (let droop = b.droop - 6; path[path.length - 1].y < 0.03 && droop > 30; droop -= 6) path = arch(root, { ...b, droop }, b.length + SKIRT, stops);
    // Each blade its own small step in value and hue, so neighbours separate.
    const k = cr.range(-1, 1);
    const own = (c: RGB): RGB => adjustOklch(c, k * 0.022, 1, k * 2.5);
    // Height of a station over the ground, for the darker heart.
    const low = (k2: number): number => 1 - Math.min(1, Math.max(0, path[k2].y / 0.12));
    const top = stops.map((t, k2) => {
      const u = Math.pow(t, 1.75 - run);
      const c = u < 0.5 ? mixOklab(foot, body, u * 2) : mixOklab(body, tip, u * 2 - 1);
      return own(mixOklab(c, heart, 0.8 * low(k2)));
    });
    ribbon(
      m,
      path,
      stops.map((t) => b.width * outline(t)),
      b.roll,
      b.twist,
      // A low ridge: a crease you can see, not a tent that eats the width.
      0.16,
      {
        top,
        // The ridge catches the light: a step toward the tip colour.
        rib: top.map((c) => mixOklab(c, tip, 0.22)),
        under: top.map((c, k2) => own(mixOklab(mixOklab(under, c, 0.25), heart, 0.7 * low(k2)))),
      },
      LEAF,
    );
  });
  fitSize(m, v.hero ? SIZE : habitSize(m, v.size(SIZE, 0.1, 0.08)));
  // Roots pinned, tips free.
  sway(m, { from: 0.04, power: 1.6 });
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: ID,
  name: 'Ribbon Grass',
  category: 'vegetation',
  size: SIZE,
  variants: 5,
  build: construct,
  // Far tier: a rosette read off this very plant (tips where it reaches,
  // lobes in its own colours; flowers as a cap) — see `farTuft`.
  buildFar: (seed, _scheme, target) => farTuft(construct(seed), target),
  wind: true,
  triBudget: BUDGET,
  reference: {
    sheet: 'design-documents/environment-design-pack/vegetation/design-sheet.png',
    brief: 'design-documents/environment-design-pack/vegetation/v02-ribbon-grass-brief.txt',
  },
};

export default asset;
