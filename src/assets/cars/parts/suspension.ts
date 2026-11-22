import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, cylinder, filletPath, paint, quadFacing, revolve, roundedBox, sphere, sweep, triFacing, tube } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import type { CarLink, CarSpec, WheelIndex } from '../../types';
import { CHROME, GUNMETAL, RUBBER, STEEL, asPaint } from './common';
import type { Color, P3 } from './common';
import { hubLayout } from './hub';
import type { HubLayout, HubSize } from './hub';
import { wheelLayout } from './wheel';
import type { WheelLayout } from './wheel';

/**
 * SUSPENSION — double wishbones, coil-overs, tie rods and half-shafts for all
 * four corners as `CarLink[]`, plus the body-side mounts they hang from.
 *
 * Every link mesh hangs from its origin down −Y (see `CarLink` in types.ts):
 *  - each wishbone LEG is its own 'stretch' link from its own body pivot to
 *    the ball joint. (One link per arm would yaw as a whole when the wheel
 *    steers — the ball joint orbits the wheel centre — and drag its body-side
 *    bushings through their mounts. Two legs each turn about a pivot that
 *    never moves; the bushings themselves are part of the MOUNTS.)
 *  - a coil-over is three links on the same two anchors: damper body
 *    ('fromBody'), damper rod ('fromHub') and the spring with both its
 *    perches ('stretch'). A tie rod / toe link is a telescoping pair too, so
 *    its adjuster keeps its size at full lock. Lengths are SOLVED here from
 *    the anchors so every pair obeys the telescoping rule over the whole
 *    travel (bump +0.10 … droop −0.12, and ±32° steer on the front axle); an
 *    impossible anchor pair throws with the numbers.
 *
 * THE COIL-OVER GOES THROUGH THE UPPER WISHBONE, as on a real long-travel
 * buggy: the two upper legs are bent into a wide mouth around the spring.
 * How wide is solved per axle from the spring's swept path over the whole
 * travel (`CLEARANCE` between the coil and every tube); anchors that leave no
 * room throw. `suspensionReport` returns the solved clearances.
 *
 * Meshes are shared left/right (and the assembler instances them), so they
 * are symmetric in local X; anything one-sided (the damper's reservoir) sits
 * on local −Z, which the assembler keeps pointing backward on both sides.
 *
 * The hub-side anchors come from `hubLayout` — build the hubs with the same
 * sizes (or let `buildRunningGear` build both) and the joints meet.
 */

export interface AxleMounts {
  /**
   * Body-side points, given for the RIGHT side of the car in model space
   * ([x, y, z], x > 0); the left side is mirrored. Every one has a default
   * derived from the spec — pass the ones your shell needs elsewhere.
   */
  /** Pivot of the lower wishbone (midway between its two legs). */
  lowerPivot?: P3;
  /** Pivot of the upper wishbone. */
  upperPivot?: P3;
  /** Top eye of the coil-over. */
  damperTop?: P3;
  /** Inner end of the tie rod (front) / toe link (rear). `false` = none.
   * Default: front axle yes, rear axle none. */
  tieRod?: P3 | false;
  /** Inner end of a drive half-shaft. `true` = a default differential
   * position; default none. */
  halfShaft?: P3 | boolean;
  /** Fore-aft distance between the two legs of each wishbone at the body
   * (default 0.38 m). */
  armSpread?: number;
  /**
   * Lower eye of the coil-over in the HUB frame of the right wheel (origin at
   * the wheel centre, inboard = −x). Default: on the upright just above the
   * lower ball joint (`hubLayout`). On an axle with a half-shaft the shaft
   * is in the way: the rear foot then moves 10 cm + the spring's radius
   * BEHIND the axle line and inboard of the tire (give that axle's
   * `damperTop` the same z), a front one onto the top of the upright. Give
   * `buildHub` the same point (`suspensionAnchors(…)[1 or 3].hubPoints
   * .damperFoot`), or use `buildRunningGear`.
   */
  damperFoot?: P3;
  /** Outer radius of this axle's coil springs (default 17 % of the tire
   * radius). */
  coilRadius?: number;
  /** Wheel size overrides (rimRatio, tieRodZ …) if the wheels on this axle
   * were not built with the defaults. Radius and width come from the spec. */
  wheel?: Partial<HubSize>;
}

export interface SuspensionOptions {
  front?: AxleMounts;
  rear?: AxleMounts;
  /** 'tubular' (default): round tube legs. 'flat': stamped flat-bar legs. */
  arms?: 'tubular' | 'flat';
  /** Wishbone tube radius (default 0.021; Riot Ram ~0.028, Neon Wasp ~0.017). */
  armRadius?: number;
  /** Wishbone colour (default gunmetal). Riot Ram's are orange. */
  armColor?: Color;
  /** Coil spring colour — the car's suspension accent. */
  springColor?: Color;
  /** Damper body colour (default gunmetal). */
  damperColor?: Color;
  /** Small remote reservoir on each damper body (default true). */
  reservoir?: boolean;
  /** Spring coils (default: from the spring's length, 4–8). */
  springTurns?: number;
  /** Spring wire radius as a fraction of the coil's outer radius (default
   * 0.24 — fat toy wire). */
  springWire?: number;
  /** Travel the links must cover, meters / degrees (defaults: the lab's
   * and the game's: bump 0.10, droop 0.12, steer 32). */
  travel?: { bump?: number; droop?: number; steer?: number };
}

/** Everything one corner hangs from, in car model space (hub points at the
 * static pose). Use it to run frame tubes and brackets to the right places. */
export interface CornerAnchors {
  wheel: WheelIndex;
  /** −1 left, +1 right. */
  side: -1 | 1;
  /** Hub centre at rest. */
  hub: P3;
  lowerPivot: P3;
  upperPivot: P3;
  /** The two leg pivots of each wishbone (rear, front). */
  lowerLegs: [P3, P3];
  upperLegs: [P3, P3];
  damperTop: P3;
  tieRod: P3 | null;
  halfShaft: P3 | null;
  /** Hub-side points in the HUB frame (x already signed for this side). */
  hubPoints: HubLayout;
  armSpread: number;
  /** The wheel on this corner, as the hub and the suspension see it. */
  tire: WheelLayout;
}

interface Travel {
  bump: number;
  droop: number;
  steer: number;
}

const travelOf = (options: SuspensionOptions): Travel => ({ bump: options.travel?.bump ?? 0.1, droop: options.travel?.droop ?? 0.12, steer: options.travel?.steer ?? 32 });

function poses(t: Travel, steered: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const b of [-t.droop, -t.droop / 2, 0, t.bump / 2, t.bump]) {
    for (const a of steered ? [-t.steer, -t.steer * 0.66, -t.steer * 0.33, 0, t.steer * 0.33, t.steer * 0.66, t.steer] : [0]) out.push([b, a]);
  }
  return out;
}

interface CoilDims {
  /** Outer radius of the coil. */
  outer: number;
  wire: number;
  /** Damper body radius. */
  body: number;
  /** Span fractions (0 = top eye) between which the spring and its perches
   * sit. */
  from: number;
  to: number;
}

/** Proportions of a coil-over of rest length `span` round a spring of outer
 * radius `outer`. */
function coilDims(span: number, outer: number, wireFraction: number | undefined): CoilDims {
  const wire = outer * (wireFraction ?? 0.24);
  return { outer, wire, body: outer - 2 * wire - 0.005, from: Math.max(0.17, 0.068 / span), to: 1 - 0.066 / span };
}

/** Radius of the coil-over at span fraction `f`: damper top, spring, rod end. */
const coilRadiusAt = (coil: CoilDims, f: number): number => (f < coil.from ? coil.body + 0.012 : f <= coil.to ? coil.outer + 0.005 : 0.03);

/**
 * Free air between a RIGHT-side coil-over and its own wheel over the travel
 * (negative = they intersect). In the wheel's (x, radius) half-plane the tire
 * and the rim's inboard lip are two corners the coil-over has to stay inboard
 * of — also at full lock, when the wheel turns toward the fixed damper top.
 */
function tireClearance(hub: P3, top: P3, foot: P3, tire: WheelLayout, outer: number, wireFraction: number | undefined, t: Travel, steered: boolean): number {
  const span = Math.hypot(hub[0] + foot[0] - top[0], hub[1] + foot[1] - top[1], hub[2] + foot[2] - top[2]);
  const coil = coilDims(span, outer, wireFraction);
  const F = new Vector3(foot[0], foot[1], foot[2]);
  let worst = Infinity;
  for (const [bump, steer] of poses(t, steered)) {
    // The damper top as the HUB sees it.
    const a = (steer * Math.PI) / 180;
    const d = new Vector3(top[0] - hub[0], top[1] - hub[1] - bump, top[2] - hub[2]);
    const T = new Vector3(d.x * Math.cos(a) - d.z * Math.sin(a), d.y, d.x * Math.sin(a) + d.z * Math.cos(a));
    for (let i = 0; i <= 24; i++) {
      const f = i / 24;
      const p = Vector3.Lerp(T, F, f);
      const r = coilRadiusAt(coil, f);
      const rho = Math.hypot(p.y, p.z);
      if (rho - r > tire.radius) continue;
      const corner = (x0: number, rho0: number): number => Math.hypot(Math.max(0, x0 - p.x), Math.max(0, rho0 - rho)) - r;
      worst = Math.min(worst, corner(-tire.width / 2, tire.beadRadius), corner(-(tire.beadY + 0.012), tire.cavityRadius));
    }
  }
  return worst;
}

/** Body-side and hub-side hard points of all four corners, resolved from the
 * spec and the options exactly as `buildSuspension` uses them. */
export function suspensionAnchors(spec: CarSpec, options: SuspensionOptions = {}): CornerAnchors[] {
  const out: CornerAnchors[] = [];
  const travel = travelOf(options);
  for (const wheel of [0, 1, 2, 3] as WheelIndex[]) {
    const isFront = wheel < 2;
    const side = wheel % 2 === 0 ? -1 : 1;
    const o = (isFront ? options.front : options.rear) ?? {};
    const radius = isFront ? spec.frontTireRadius : spec.rearTireRadius;
    const width = isFront ? spec.frontTireWidth : spec.rearTireWidth;
    const hx = (isFront ? spec.frontTrack : spec.rearTrack) / 2;
    const z = (isFront ? 1 : -1) * (spec.wheelbase / 2);
    const size: HubSize = { ...o.wheel, radius, width };
    if (o.coilRadius !== undefined) size.coilRadius = o.coilRadius;
    const tire = wheelLayout(size);
    let H = hubLayout(size);
    if (o.damperFoot) {
      H = hubLayout({ ...size, damperFoot: o.damperFoot });
    } else if (o.halfShaft && !size.damperFoot) {
      const f = H.damperFoot;
      // A half-shaft and its boot run right where the foot is, so the foot
      // moves inboard of the tire on a stub arm. Unsteered axle: behind the
      // shaft, so the coil-over stands beside the wishbones where the chase
      // camera sees it. Steered axle: that far inboard the foot swings a
      // long way at full lock, so there it goes up above both arms, where
      // there is nothing to hit (a shorter coil-over — give it a tall tower).
      H = hubLayout({ ...size, damperFoot: isFront ? [-(width / 2 + H.coilRadius + 0.014), H.upperJoint[1] + 0.075, 0] : [-(width / 2 + H.coilRadius + 0.014), f[1], -(H.coilRadius + 0.1)] });
    }

    // Defaults: half-metre arms sloping down to the hub, the upper one a
    // little shorter; the coil-over leaning in to a point above the arms.
    const lower: P3 = o.lowerPivot ?? [Math.min(0.3, Math.max(0.16, hx + H.lowerJoint[0] - 0.5)), spec.groundClearance + 0.05, z];
    const upper: P3 = o.upperPivot ?? [lower[0] + 0.03, lower[1] + 0.19, lower[2]];
    let top: P3;
    if (o.damperTop) {
      top = o.damperTop;
    } else {
      // Above the arms, leaning inboard — by as much as the tire needs to
      // pass the spring at full lock and full droop (fat tires need more).
      top = [hx + H.damperFoot[0] - 0.2, Math.max(radius + (isFront ? 0.46 : 0.5), radius + H.damperFoot[1] + 0.42), z + H.damperFoot[2]];
      while (top[0] > 0.2 && tireClearance([hx, radius, z], top, H.damperFoot, tire, H.coilRadius, options.springWire, travel, isFront) < 0.012) top = [top[0] - 0.02, top[1], top[2]];
    }
    let tie: P3 | null = null;
    if (o.tieRod) tie = o.tieRod;
    else if (o.tieRod === undefined && isFront) tie = [lower[0] - 0.02, lower[1] + 0.06, z + H.tieRod[2]];
    let shaft: P3 | null = null;
    if (o.halfShaft === true) shaft = [0.13, radius - 0.02, z];
    else if (o.halfShaft) shaft = o.halfShaft;

    const spread = o.armSpread ?? 0.38;
    const mirror = (p: P3): P3 => [side * p[0], p[1], p[2]];
    const legs = (p: P3): [P3, P3] => [
      [side * p[0], p[1], p[2] - spread / 2],
      [side * p[0], p[1], p[2] + spread / 2],
    ];
    out.push({
      wheel,
      side,
      hub: [side * hx, radius, z],
      lowerPivot: mirror(lower),
      upperPivot: mirror(upper),
      lowerLegs: legs(lower),
      upperLegs: legs(upper),
      damperTop: mirror(top),
      tieRod: tie && mirror(tie),
      halfShaft: shaft && mirror(shaft),
      hubPoints: {
        upperJoint: mirror(H.upperJoint),
        lowerJoint: mirror(H.lowerJoint),
        tieRod: mirror(H.tieRod),
        damperFoot: mirror(H.damperFoot),
        axle: mirror(H.axle),
        discRadius: H.discRadius,
        coilRadius: H.coilRadius,
      },
      armSpread: spread,
      tire,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link kinematics — the same maths as the assembler (`CarInstance.linkRest` /
// `updateLinks`), so shapes can be solved here against the poses the game
// will actually put them in.

const V = (p: P3): Vector3 => new Vector3(p[0], p[1], p[2]);
const AX = new Vector3(1, 0, 0);
const AZ = new Vector3(0, 0, 1);

interface LinkFrame {
  origin: Vector3;
  x: Vector3;
  y: Vector3;
  z: Vector3;
  span: number;
}

/** A link's frame at the static pose: −Y on the hub anchor, +Z as far
 * forward as that allows (links running fore-aft: +X to the right). */
function restFrame(body: Vector3, hub: Vector3): LinkFrame {
  const d = hub.subtract(body);
  const span = d.length();
  const y = d.scale(-1 / span);
  let x: Vector3;
  let z: Vector3;
  if (Math.abs(y.z) < 0.8) {
    z = AZ.subtract(y.scale(y.z)).normalize();
    x = Vector3.Cross(y, z);
  } else {
    x = AX.subtract(y.scale(y.x)).normalize();
    z = Vector3.Cross(x, y);
  }
  return { origin: body, x, y, z, span };
}

/** The same link with its hub anchor moved: the smallest rotation that keeps
 * it aimed. */
function movedFrame(rest: LinkFrame, hub: Vector3): LinkFrame {
  const d = hub.subtract(rest.origin);
  const span = d.length();
  const dir = d.scale(1 / span);
  const dir0 = rest.y.scale(-1);
  const v = Vector3.Cross(dir0, dir);
  const c = Vector3.Dot(dir0, dir);
  const k = c > -0.999999 ? 1 / (1 + c) : 0;
  const turn = (u: Vector3): Vector3 => u.scale(c).add(Vector3.Cross(v, u)).add(v.scale(Vector3.Dot(v, u) * k));
  return { origin: rest.origin, x: turn(rest.x), y: dir.scale(-1), z: turn(rest.z), span };
}

const toLocal = (f: LinkFrame, p: Vector3): Vector3 => {
  const d = p.subtract(f.origin);
  return new Vector3(Vector3.Dot(d, f.x), Vector3.Dot(d, f.y), Vector3.Dot(d, f.z));
};

/** A point of a 'stretch' link (local, real length at rest) in the world for
 * a moved frame: Y is scaled with the span. */
const stretchPoint = (f: LinkFrame, restSpan: number, l: Vector3): Vector3 =>
  f.origin
    .add(f.x.scale(l.x))
    .add(f.y.scale((l.y * f.span) / restSpan))
    .add(f.z.scale(l.z));

/** A hub-frame point in model space with the hub raised by `bump` and
 * steered by `steerDeg` (positive = nose to the right, as the assembler). */
function hubPointAt(hub: P3, p: P3, bump: number, steerDeg: number): Vector3 {
  const a = (steerDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Vector3(hub[0] + p[0] * c + p[2] * s, hub[1] + bump + p[1], hub[2] - p[0] * s + p[2] * c);
}

/** Shortest distance between two segments. */
function segmentDistance(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  const d1 = q1.subtract(p1);
  const d2 = q2.subtract(p2);
  const r = p1.subtract(p2);
  const a = d1.lengthSquared();
  const e = d2.lengthSquared();
  const f = Vector3.Dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) return r.length();
  if (a <= 1e-12) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = Vector3.Dot(d1, r);
    if (e <= 1e-12) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = Vector3.Dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return p1.add(d1.scale(s)).subtract(p2.add(d2.scale(t))).length();
}

// ---------------------------------------------------------------------------
// One axle, solved

/** Radius of a wishbone's ball-joint cup, in tube radii. */
const CUP = 1.55;

/** Free air kept between the coil-over and every tube around it, over the
 * whole travel. */
const CLEARANCE = 0.006;

/** A stretch link's centre line at rest, in its own local frame (real
 * length), with the frame it was authored in. */
interface Strut {
  rest: LinkFrame;
  hubAnchor: P3;
  /** Local polyline, origin → (0, −span, 0). */
  line: Vector3[];
  radius: number;
  /** Radius of the ball joint on the hub end, if it carries one. */
  tip?: number;
}

interface AxleSolution {
  corner: CornerAnchors;
  coil: CoilDims;
  /** Rest span of the coil-over and the common length of body and rod. */
  span: number;
  damperLength: number;
  lowerLegs: [Strut, Strut];
  upperLegs: [Strut, Strut];
  /** Half-length of each telescoping tie-rod half, or 0. */
  tieLength: number;
  /** Smallest free air to the coil-over over the travel, meters. */
  clearance: { upperLegs: number; lowerLegs: number; tieRod: number | null; halfShaft: number | null; tire: number };
  /** How far the upper legs' mouth was opened: 0 = straight legs. */
  mouth: number;
}

/** Shortest distance from point `p` to segment a–b. */
function pointSegmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const d = b.subtract(a);
  const l2 = d.lengthSquared();
  const k = l2 > 1e-12 ? Math.min(1, Math.max(0, Vector3.Dot(p.subtract(a), d) / l2)) : 0;
  return p.subtract(a.add(d.scale(k))).length();
}

/** Free air between the coil-over and a set of tubes over the travel
 * (negative = they intersect). */
function coilClearance(c: CornerAnchors, coil: CoilDims, struts: readonly Strut[], t: Travel, steered: boolean): number {
  const top = V(c.damperTop);
  let worst = Infinity;
  const SLIM = 0.03;
  for (const [bump, steer] of poses(t, steered)) {
    const foot = hubPointAt(c.hub, c.hubPoints.damperFoot, bump, steer);
    const at = (f: number): Vector3 => Vector3.Lerp(top, foot, f);
    const axis = foot.subtract(top);
    const span = axis.length();
    axis.scaleInPlace(1 / span);
    // Three zones down the coil-over: damper top, spring + perches, rod end.
    // The spring is a flat-ended cylinder, far fatter than its neighbours: a
    // capsule would stick out past the perches by its own radius, so the
    // capsule is pulled in at both ends and the perch rims are probed as
    // rings of points instead.
    const rs = coilRadiusAt(coil, coil.from);
    const pull = (rs - SLIM) / span;
    const zones: [Vector3, Vector3, number][] = [
      [at(0), at(coil.from), coilRadiusAt(coil, 0)],
      [at(coil.from + pull), at(coil.to - pull), rs],
      [at(coil.to), at(1), coilRadiusAt(coil, 1)],
    ];
    const u = Vector3.Cross(axis, Math.abs(axis.x) < 0.9 ? AX : AZ).normalize();
    const w = Vector3.Cross(axis, u);
    const rims: Vector3[] = [];
    for (const f of [coil.from, coil.to]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        rims.push(at(f).add(u.scale(Math.cos(a) * rs)).add(w.scale(Math.sin(a) * rs)));
      }
    }
    for (const s of struts) {
      const f = movedFrame(s.rest, hubPointAt(c.hub, s.hubAnchor, bump, steer));
      const pts = s.line.map((l) => stretchPoint(f, s.rest.span, l));
      for (let i = 0; i + 1 < pts.length; i++) {
        for (const [a, b, r] of zones) worst = Math.min(worst, segmentDistance(pts[i], pts[i + 1], a, b) - r - s.radius);
        for (const q of rims) worst = Math.min(worst, pointSegmentDistance(q, pts[i], pts[i + 1]) - s.radius);
      }
      if (s.tip) {
        // The ball joint on its end is fatter than the tube.
        const j = pts[pts.length - 1];
        for (const [a, b, r] of zones) worst = Math.min(worst, pointSegmentDistance(j, a, b) - r - s.tip);
        for (const q of rims) worst = Math.min(worst, q.subtract(j).length() - s.tip);
      }
    }
  }
  return worst;
}

/** One wishbone leg: from its body pivot out to the ball joint, optionally
 * bent out to `mouth` meters from the arm's centre line at `reach` of the
 * arm's length (0 = straight). */
function legStrut(pivot: P3, mid: P3, other: P3, hub: P3, joint: P3, radius: number, mouth: number, reach: number): Strut {
  const body = V(pivot);
  const j = hubPointAt(hub, joint, 0, 0);
  const rest = restFrame(body, j);
  const line = [new Vector3(0, 0, 0)];
  if (mouth > 0) {
    // In the arm's own plane: `w` along the pivot axis toward this leg, `o`
    // straight out to the ball joint.
    const m = V(mid);
    const w = body.subtract(V(other)).normalize();
    const out = j.subtract(m);
    const o = out.subtract(w.scale(Vector3.Dot(out, w)));
    const L = o.length();
    o.scaleInPlace(1 / L);
    const elbow = m.add(o.scale(L * reach)).add(w.scale(mouth));
    line.push(toLocal(rest, elbow));
  }
  line.push(new Vector3(0, -rest.span, 0));
  // The bend is rounded HERE, not by the tube helper, so the clearance is
  // solved on the centre line that is actually built.
  return { rest, hubAnchor: joint, line: line.length > 2 ? filletPath(line, 0.07, { segments: 5 }) : line, radius, tip: radius * CUP };
}

function solveAxle(options: SuspensionOptions, axle: 0 | 1, corners: CornerAnchors[]): AxleSolution {
  const c = corners[axle === 0 ? 1 : 3];
  const name = axle === 0 ? 'front' : 'rear';
  const steered = axle === 0;
  const t = travelOf(options);
  const armR = options.armRadius ?? 0.021;
  const dist = (a: Vector3, b: Vector3): number => a.subtract(b).length();

  // Damper: scan the travel envelope for the shortest and longest span
  // between its two eyes. Body and rod are the same length L: each must fit
  // the shortest span, together they must still overlap at the longest.
  const top = V(c.damperTop);
  let shortest = Infinity;
  let longest = 0;
  for (const [b, a] of poses(t, steered)) {
    const span = dist(top, hubPointAt(c.hub, c.hubPoints.damperFoot, b, a));
    shortest = Math.min(shortest, span);
    longest = Math.max(longest, span);
  }
  const damperLength = shortest - 0.012;
  if (2 * damperLength < longest + 0.03) {
    throw new Error(
      `buildSuspension: ${name} coil-over cannot telescope — span ${shortest.toFixed(3)} … ${longest.toFixed(3)} m over the travel, ` +
        `but the longest may be at most twice the shortest. Raise damperTop (now y = ${c.damperTop[1].toFixed(2)}) or move it inboard.`,
    );
  }
  const span = dist(top, hubPointAt(c.hub, c.hubPoints.damperFoot, 0, 0));
  const outer = c.hubPoints.coilRadius;
  const coil = coilDims(span, outer, options.springWire);

  const lowerLegs = c.lowerLegs.map((p, i) => legStrut(p, c.lowerPivot, c.lowerLegs[1 - i], c.hub, c.hubPoints.lowerJoint, armR, 0, 0)) as [Strut, Strut];
  const lowerClear = coilClearance(c, coil, lowerLegs, t, steered);

  // Upper legs: straight if the coil-over leaves them alone, otherwise the
  // least bent pair that clears it.
  const h = c.armSpread / 2;
  const upper = (i: number, mouth: number, reach: number): Strut => legStrut(c.upperLegs[i], c.upperPivot, c.upperLegs[1 - i], c.hub, c.hubPoints.upperJoint, armR, mouth, reach);
  const bent: [number, number][] = [];
  // Least bent first: how far the elbow stands off the straight leg —
  // outward (a mouth round the spring) or inward (a Y whose stem the
  // coil-over passes beside).
  const off = ([mouth, reach]: [number, number]): number => Math.abs(mouth - h * (1 - reach));
  for (let mouth = 0.03; mouth <= h + 0.081; mouth += 0.01) for (const reach of [0.34, 0.42, 0.5, 0.58, 0.66, 0.74, 0.8, 0.85, 0.9]) if (off([mouth, reach]) > 0.015) bent.push([mouth, reach]);
  bent.sort((a, b) => off(a) - off(b) || a[1] - b[1]);
  const tries: [number, number][] = [[0, 0], ...bent];
  // Tried least bent first. The first pair with full clearance wins; if
  // none has it, the least bent pair within a millimetre of the best does.
  const tried: { legs: [Strut, Strut]; clear: number; mouth: number }[] = [];
  for (const [mouth, reach] of tries) {
    const legs: [Strut, Strut] = [upper(0, mouth, reach), upper(1, mouth, reach)];
    const clear = coilClearance(c, coil, legs, t, steered);
    tried.push({ legs, clear, mouth });
    if (clear >= CLEARANCE) break;
  }
  const most = Math.max(...tried.map((q) => q.clear));
  const best = tried.find((q) => q.clear >= Math.min(CLEARANCE, most - 0.001))!;
  if (best.clear < 0) {
    throw new Error(
      `buildSuspension: the ${name} coil-over (outer radius ${outer.toFixed(3)} m) cuts through the upper wishbone by ${(-best.clear * 1000).toFixed(0)} mm ` +
        `whatever its shape. Widen armSpread (now ${c.armSpread.toFixed(2)}), move damperTop (z ${c.damperTop[2].toFixed(2)}; the foot is at z ${(c.hub[2] + c.hubPoints.damperFoot[2]).toFixed(2)}) or damperFoot, or reduce coilRadius.`,
    );
  }
  const tireClear = tireClearance(c.hub, c.damperTop, c.hubPoints.damperFoot, c.tire, outer, options.springWire, t, steered);
  if (tireClear < 0) {
    throw new Error(
      `buildSuspension: the ${name} coil-over runs into its own tire by ${(-tireClear * 1000).toFixed(0)} mm — lean it further inboard (damperTop x, now ${Math.abs(c.damperTop[0]).toFixed(2)}), ` +
        `move damperFoot inboard (hub frame x, now ${(c.side * c.hubPoints.damperFoot[0]).toFixed(3)}) or reduce coilRadius.`,
    );
  }
  if (lowerClear < 0) {
    throw new Error(`buildSuspension: the ${name} coil-over cuts through the lower wishbone by ${(-lowerClear * 1000).toFixed(0)} mm — raise damperFoot (hub frame y, now ${c.hubPoints.damperFoot[1].toFixed(3)}).`);
  }

  // Tie rod / toe link: a telescoping pair like the damper.
  let tieLength = 0;
  let tieClear: number | null = null;
  if (c.tieRod) {
    const inner = V(c.tieRod);
    let lo = Infinity;
    let hi = 0;
    for (const [b, a] of poses(t, steered)) {
      const s = dist(inner, hubPointAt(c.hub, c.hubPoints.tieRod, b, a));
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    tieLength = lo - 0.008;
    if (2 * tieLength < hi + 0.05) throw new Error(`buildSuspension: ${name} tie rod cannot telescope (${lo.toFixed(3)} … ${hi.toFixed(3)} m) — move its inner end outboard.`);
    const rest = restFrame(inner, hubPointAt(c.hub, c.hubPoints.tieRod, 0, 0));
    tieClear = coilClearance(c, coil, [{ rest, hubAnchor: c.hubPoints.tieRod, line: [new Vector3(0, 0, 0), new Vector3(0, -rest.span, 0)], radius: 0.02 }], t, steered);
    if (tieClear < 0) throw new Error(`buildSuspension: the ${name} tie rod runs through the coil-over (${(-tieClear * 1000).toFixed(0)} mm) — move it fore-aft (wheel.tieRodZ / tieRod) or move damperFoot.`);
  }
  let shaftClear: number | null = null;
  if (c.halfShaft) {
    const rest = restFrame(V(c.halfShaft), hubPointAt(c.hub, c.hubPoints.axle, 0, 0));
    // The shaft, and the fat CV boot on its hub end.
    const shaft: Strut[] = [
      { rest, hubAnchor: c.hubPoints.axle, line: [new Vector3(0, 0, 0), new Vector3(0, -rest.span, 0)], radius: 0.022 },
      { rest, hubAnchor: c.hubPoints.axle, line: [new Vector3(0, -rest.span + 0.13, 0), new Vector3(0, -rest.span + 0.02, 0)], radius: 0.05 },
    ];
    shaftClear = coilClearance(c, coil, shaft, t, steered);
    if (shaftClear < 0) throw new Error(`buildSuspension: the ${name} half-shaft runs through the coil-over (${(-shaftClear * 1000).toFixed(0)} mm) — give damperFoot a z offset of at least ${(outer + 0.07).toFixed(2)} m, or raise it above the boot (hub frame y ≥ 0.1).`);
  }

  return {
    corner: c,
    coil,
    span,
    damperLength,
    lowerLegs,
    upperLegs: best.legs,
    tieLength,
    clearance: { upperLegs: best.clear, lowerLegs: lowerClear, tieRod: tieClear, halfShaft: shaftClear, tire: tireClear },
    mouth: best.mouth,
  };
}

export interface AxleReport {
  /** Smallest free air between the coil-over and each neighbour over the
   * whole travel, meters (null = the axle has no such part). */
  clearance: { upperLegs: number; lowerLegs: number; tieRod: number | null; halfShaft: number | null; tire: number };
  /** Half-width the upper wishbone's mouth was opened to (0 = straight legs). */
  mouth: number;
  coilRadius: number;
  /** Coil-over span at rest and the solved length of its two halves. */
  span: number;
  damperLength: number;
}

/** What `buildSuspension` solved for these anchors: clearances around the
 * coil-overs over the whole travel, mouth width, damper lengths. Throws like
 * `buildSuspension` if the anchors cannot work. */
export function suspensionReport(spec: CarSpec, options: SuspensionOptions = {}): { front: AxleReport; rear: AxleReport } {
  const corners = suspensionAnchors(spec, options);
  const one = (axle: 0 | 1): AxleReport => {
    const s = solveAxle(options, axle, corners);
    return { clearance: s.clearance, mouth: s.mouth, coilRadius: s.coil.outer, span: s.span, damperLength: s.damperLength };
  };
  return { front: one(0), rear: one(1) };
}

// ---------------------------------------------------------------------------
// Link meshes

/** Squash a link mesh built at its real length (origin at the body end,
 * hanging down −Y to −length) to the unit length a 'stretch' link needs.
 * The contract (and the lab) allow a stretch mesh to overshoot its two ends
 * by 4 % of its length at most — joint balls are therefore centred a little
 * INSIDE the span, see `over`. */
function toUnit(m: SolidMesh, length: number): SolidMesh {
  return m.scale([1, 1 / length, 1]);
}

/** How far a joint may stand past the end of a stretch link of `length`. */
const over = (length: number): number => Math.min(0.02, length * 0.03);

/**
 * One wishbone leg along `strut.line`. Its body end is a plain tube end: the
 * pivot bushing it disappears into belongs to the mount (so it never moves).
 * `cup` adds the ball-joint cup on the hub end — one leg of each arm carries
 * it, the other ends inside it. `gusset` (a local point on the sister leg)
 * adds the web between the two legs at the ball joint.
 */
function buildLeg(strut: Strut, style: 'tubular' | 'flat', ARM: Paint, cup: boolean, gusset: Vector3 | null): SolidMesh {
  const m = new SolidMesh();
  const len = strut.rest.span;
  const r = strut.radius;
  const ov = over(len);
  const path = strut.line.map((p) => p.clone());
  // Stop short of the joint: the cup covers the end.
  path[path.length - 1] = new Vector3(0, -len + 0.012, 0);
  if (style === 'flat') {
    // Flat bar: thin across the arm's plane (local X), wide in it.
    const t = r * 0.62;
    const w = r * 1.5;
    const section: Vec2[] = [[-t, -w + t * 0.5], [-t * 0.5, -w], [t * 0.5, -w], [t, -w + t * 0.5], [t, w - t * 0.5], [t * 0.5, w], [-t * 0.5, w], [-t, w - t * 0.5]];
    sweep(m, { path, section, up: [1, 0, 0] }, ARM);
  } else {
    tube(m, { path, radius: r, sides: 9 }, ARM);
  }
  if (gusset) {
    // A plate between this leg and its sister, sunk into both tubes.
    const a = new Vector3(0, -len * 0.72, 0);
    const tip = new Vector3(0, -len + 0.03, 0);
    const t = 0.006;
    const px = new Vector3(t, 0, 0);
    const front = [a.add(px), gusset.add(px), tip.add(px)];
    const back = [a.subtract(px), gusset.subtract(px), tip.subtract(px)];
    triFacing(m, front[0], front[1], front[2], AX, ARM);
    triFacing(m, back[0], back[1], back[2], AX.scale(-1), ARM);
    const centre = a.add(gusset).add(tip).scale(1 / 3);
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      quadFacing(m, front[i], front[j], back[j], back[i], front[i].add(front[j]).scale(0.5).subtract(centre), ARM);
    }
  }
  if (cup) sphere(m, { radius: r * CUP, segments: 10, rings: 5, at: [0, -len - ov + r * CUP, 0] }, STEEL);
  return toUnit(m, len);
}

/** Tie rod, body half ('fromBody'): inner ball end, rod and the hex adjuster
 * sleeve the hub half slides into. */
function buildTieSleeve(length: number): SolidMesh {
  const m = new SolidMesh();
  sphere(m, { radius: 0.026, segments: 8, rings: 4, at: [0, 0, 0] }, GUNMETAL);
  cylinder(m, { from: [0, -length + 0.1, 0], to: [0, -0.01, 0], radius: 0.013, sides: 7, caps: false }, STEEL);
  cylinder(m, { from: [0, -length, 0], to: [0, -length + 0.11, 0], radius: 0.02, sides: 6, round: false, bevel: 0.004, bevelSegments: 1 }, GUNMETAL);
  return m;
}

/** Tie rod, hub half ('fromHub'): outer ball end, lock nut and the threaded
 * rod that slides in the sleeve. */
function buildTieRod(length: number): SolidMesh {
  const m = new SolidMesh();
  sphere(m, { radius: 0.026, segments: 8, rings: 4, at: [0, 0, 0] }, GUNMETAL);
  cylinder(m, { from: [0, -0.06, 0], to: [0, -0.02, 0], radius: 0.017, sides: 6, round: false }, STEEL);
  cylinder(m, { from: [0, -length, 0], to: [0, -0.01, 0], radius: 0.011, sides: 7, caps: false }, STEEL);
  return m;
}

function buildHalfShaft(length: number): SolidMesh {
  const m = new SolidMesh();
  cylinder(m, { from: [0, -0.05, 0], to: [0, -length + 0.05, 0], radius: 0.02, sides: 8, caps: false }, STEEL);
  // Ribbed rubber CV boots at both ends.
  const boot = (y0: number, dir: number): void => {
    const prof: Vec2[] = [[0, 0]];
    const ribs = 3;
    for (let i = 0; i <= ribs * 2; i++) {
      const t = i / (ribs * 2);
      prof.push([(0.06 - 0.03 * t) * (i % 2 === 0 ? 1 : 0.78), 0.012 + t * 0.12]);
    }
    prof.push([0, 0.135]);
    const s = m.mark();
    revolve(m, { profile: prof, segments: 8 }, RUBBER);
    if (dir < 0) m.mirror('y', s);
    m.translate([0, y0, 0], s);
  };
  boot(-length, 1);
  boot(0, -1);
  return toUnit(m, length);
}

/** Spring coil with both perches, built at the rest span and squashed to a
 * unit 'stretch' link. The perches travel with the ends of the spring, so
 * the coil always sits between them. */
function buildSpring(span: number, coil: CoilDims, turnsOption: number | undefined, SPRING: Paint): SolidMesh {
  const m = new SolidMesh();
  const perch = 0.02;
  const yTop = -span * coil.from - perch;
  const yBottom = -span * coil.to + perch;
  const wire = coil.wire;
  const centre = coil.outer - wire;
  // Perches: a flanged collar the last coil sits on.
  for (const [a, b, dir] of [[yTop + perch, yTop, -1], [yBottom, yBottom - perch, 1]] as const) {
    cylinder(m, { from: [0, b, 0], to: [0, a, 0], radius: coil.outer + 0.005, sides: 16, bevel: 0.005, bevelSegments: 1 }, STEEL);
    // …and a collar inside the last coil that keeps it centred.
    const lo = dir < 0 ? b - wire - 0.012 : a - 0.004;
    cylinder(m, { from: [0, lo, 0], to: [0, lo + wire + 0.016, 0], radius: centre - wire - 0.002, sides: 8, caps: false }, STEEL);
  }
  // A 'stretch' mesh must span the whole unit length (the lab checks it):
  // a thin core from eye to eye, hidden inside the damper body and its rod.
  cylinder(m, { from: [0, -span, 0], to: [0, 0, 0], radius: 0.008, sides: 3, caps: false }, STEEL);

  // The coil. Closed ends: the first and last three quarters of a turn lie
  // almost flat on the perches, as a real spring is ground — and the wire's
  // ends dive into the perches, so no open end ever shows.
  const y0 = yTop - wire * 0.55;
  const y1 = yBottom + wire * 0.55;
  const length = y0 - y1;
  const turns = turnsOption ?? Math.max(4, Math.min(8, Math.round(length / (wire * 4.1)) + 1));
  const perTurn = 12;
  const steps = Math.round(turns * perTurn);
  const flat = 0.75 / turns;
  const weight = (u: number): number => {
    const e = Math.min(u, 1 - u) / flat;
    return e >= 1 ? 1 : 0.12 + 0.88 * e * e * (3 - 2 * e);
  };
  const cum = [0];
  for (let i = 1; i <= steps; i++) cum.push(cum[i - 1] + weight((i - 0.5) / steps));
  const path: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * Math.PI * 2;
    path.push(new Vector3(Math.cos(a) * centre, y1 + (length * cum[i]) / cum[steps], Math.sin(a) * centre));
  }
  tube(m, { path, radius: wire, sides: 7, caps: true }, SPRING);
  return toUnit(m, span);
}

/** Damper body: hangs from the body-side eye down −Y, `length` long. The
 * reservoir rides on local −Z (rearward on both sides of the car). */
function buildDamperBody(length: number, coil: CoilDims, BODY: Paint, reservoir: boolean): SolidMesh {
  const m = new SolidMesh();
  const r = coil.body;
  // Top eye, bolt axis fore-aft.
  cylinder(m, { from: [0, 0, -0.03], to: [0, 0, 0.03], radius: 0.03, sides: 10 }, STEEL);
  cylinder(m, { from: [0, -0.066, 0], to: [0, -0.012, 0], radius: r + 0.007, sides: 12, bevel: { top: 0.008 }, bevelSegments: 1 }, STEEL);
  cylinder(m, { from: [0, -length, 0], to: [0, -0.05, 0], radius: r, sides: 12, caps: 'bottom' }, BODY);
  if (reservoir) {
    // Remote reservoir: a bright canister with domed ends beside the spring,
    // hung from a bridge ABOVE the top perch (which travels with the spring).
    const z = -(coil.outer + 0.038);
    const len = Math.min(0.15, length * 0.36);
    const rr = 0.024;
    revolve(
      m,
      {
        profile: [
          [0, -len],
          [rr * 0.6, -len],
          [rr, -len + rr * 0.5],
          [rr, -rr * 0.5],
          [rr * 0.6, 0],
          [0, 0],
        ],
        segments: 10,
        at: [0, -0.02, z],
      },
      (band) => (band === 0 || band === 4 ? BODY : CHROME),
    );
    cylinder(m, { from: [0, -0.02 - len * 0.5 - 0.014, z], to: [0, -0.02 - len * 0.5 + 0.014, z], radius: rr + 0.004, sides: 10 }, BODY);
    roundedBox(m, { min: [-0.013, -0.058, z], max: [0.013, -0.03, 0], radius: 0.006, segments: 1 }, STEEL);
  }
  return m;
}

/** Damper rod: hangs from the HUB-side eye down −Y (the assembler aims −Y at
 * the body), `length` long: eye, rod end, bump stop, chrome shaft. */
function buildDamperRod(length: number): SolidMesh {
  const m = new SolidMesh();
  cylinder(m, { from: [0, 0, -0.022], to: [0, 0, 0.022], radius: 0.027, sides: 10 }, STEEL);
  cylinder(m, { from: [0, -0.07, 0], to: [0, -0.015, 0], radius: 0.021, sides: 8 }, GUNMETAL);
  cylinder(m, { from: [0, -0.1, 0], to: [0, -0.07, 0], radius: 0.026, sides: 8, bevel: 0.006, bevelSegments: 1 }, RUBBER);
  cylinder(m, { from: [0, -length, 0], to: [0, -0.09, 0], radius: 0.0125, sides: 8, caps: 'bottom' }, CHROME);
  return m;
}

/**
 * All suspension and steering members of a car as `CarLink[]`, ready for
 * `CarGeometry.links`.
 *   links: buildSuspension(SPEC, {
 *     springColor: REEF_ROCKET.cageCoral,
 *     front: { damperTop: [0.36, 0.86, 1.1] },      // RIGHT-side point; mirrored
 *     rear:  { damperTop: [0.42, 1.02, -1.1], halfShaft: true },
 *   })
 * Per corner: two lower and two upper wishbone legs, coil spring, damper
 * body, damper rod, plus a two-part tie rod (front) and optionally a toe link
 * / half-shaft. About 2.1k triangles per corner, of which the spring is 1.2k.
 *
 * Put matching brackets on the body with `addSuspensionMounts` (the wishbone
 * pivot bushings are part of them), or read the points from
 * `suspensionAnchors`.
 */
export function buildSuspension(spec: CarSpec, options: SuspensionOptions = {}): CarLink[] {
  const ARM = asPaint(options.armColor, GUNMETAL, { gloss: 0.6 });
  const SPRING = asPaint(options.springColor, paint('#FF6373', { gloss: 0.75, smooth: 60 }), { gloss: 0.75, smooth: 60 });
  const BODY = asPaint(options.damperColor, GUNMETAL, { gloss: 0.6 });
  const style = options.arms ?? 'tubular';
  const corners = suspensionAnchors(spec, options);

  // One mesh per axle and link type, shared by the left and right corner.
  const perAxle = ([0, 1] as const).map((axle) => {
    const s = solveAxle(options, axle, corners);
    const c = s.corner;
    const restAt = (p: P3): Vector3 => hubPointAt(c.hub, p, 0, 0);
    // The front leg of each arm carries the cup; straight arms get a gusset.
    const arm = (legs: [Strut, Strut]): [SolidMesh, SolidMesh] => {
      const straight = legs[1].line.length === 2;
      const sister = legs[0];
      const onSister = stretchPoint(sister.rest, sister.rest.span, new Vector3(0, -sister.rest.span * 0.72, 0));
      return [buildLeg(legs[0], style, ARM, false, null), buildLeg(legs[1], style, ARM, true, straight ? toLocal(legs[1].rest, onSister) : null)];
    };
    return {
      lower: arm(s.lowerLegs),
      upper: arm(s.upperLegs),
      spring: buildSpring(s.span, s.coil, options.springTurns, SPRING),
      body: buildDamperBody(s.damperLength, s.coil, BODY, options.reservoir ?? true),
      rod: buildDamperRod(s.damperLength),
      tie: c.tieRod ? ([buildTieSleeve(s.tieLength), buildTieRod(s.tieLength)] as const) : null,
      shaft: c.halfShaft ? buildHalfShaft(V(c.halfShaft).subtract(restAt(c.hubPoints.axle)).length()) : null,
    };
  });

  const links: CarLink[] = [];
  for (const c of corners) {
    const parts = perAxle[c.wheel < 2 ? 0 : 1];
    const add = (mesh: SolidMesh, mode: CarLink['mode'], bodyAnchor: P3, hubAnchor: P3): void => {
      links.push({ mesh, wheel: c.wheel, mode, bodyAnchor, hubAnchor });
    };
    for (const i of [0, 1]) {
      add(parts.lower[i], 'stretch', c.lowerLegs[i], c.hubPoints.lowerJoint);
      add(parts.upper[i], 'stretch', c.upperLegs[i], c.hubPoints.upperJoint);
    }
    if (parts.tie && c.tieRod) {
      add(parts.tie[0], 'fromBody', c.tieRod, c.hubPoints.tieRod);
      add(parts.tie[1], 'fromHub', c.tieRod, c.hubPoints.tieRod);
    }
    add(parts.spring, 'stretch', c.damperTop, c.hubPoints.damperFoot);
    add(parts.body, 'fromBody', c.damperTop, c.hubPoints.damperFoot);
    add(parts.rod, 'fromHub', c.damperTop, c.hubPoints.damperFoot);
    if (parts.shaft && c.halfShaft) add(parts.shaft, 'stretch', c.halfShaft, c.hubPoints.axle);
  }
  return links;
}

export interface MountOptions {
  /** Bracket colour (default gunmetal). */
  color?: Color;
  /** Through-bolts on the brackets (default true; ~20 triangles each). */
  bolts?: boolean;
  /** Wishbone tube radius, if `buildSuspension` was given one. */
  armRadius?: number;
}

/**
 * Brackets on the sprung body for everything `buildSuspension` hangs from it:
 * for each wishbone a pivot rail with two clevises and the bushing each leg
 * turns in, a clevis for each coil-over top, a rack end for each tie rod and
 * a stub for each half-shaft. Appended to the BODY mesh `m` in model space.
 * They are deliberately chunky and reach 9 cm inboard of each anchor, so a
 * shell or frame rail that passes anywhere near swallows them and nothing
 * floats.
 */
export function addSuspensionMounts(m: SolidMesh, spec: CarSpec, options: SuspensionOptions = {}, mount: MountOptions = {}): void {
  const P = asPaint(mount.color, GUNMETAL, { gloss: 0.55 });
  const bolts = mount.bolts ?? true;
  const br = (mount.armRadius ?? options.armRadius ?? 0.021) * 1.32;
  // Plain boxes for the ears: there are sixteen clevises on a car, mostly in
  // the shadow of the body — the rounded rails and the bushings carry the look.
  const ear = (x0: number, x1: number, y: number, h: number, z: number): void => {
    box(m, { min: [Math.min(x0, x1), y - h, z - 0.008], max: [Math.max(x0, x1), y + h, z + 0.008] }, P);
  };
  for (const c of suspensionAnchors(spec, options)) {
    const s = c.side;
    for (const legs of [c.lowerLegs, c.upperLegs]) {
      const [a, b] = legs;
      // Pivot rail behind both legs of the wishbone.
      const x0 = a[0] - s * 0.095;
      const x1 = a[0] - s * 0.05;
      roundedBox(m, { min: [Math.min(x0, x1), a[1] - 0.034, a[2] - 0.062], max: [Math.max(x0, x1), a[1] + 0.034, b[2] + 0.062], radius: 0.012, segments: 1 }, P);
      for (const leg of legs) {
        // The bushing the leg's tube disappears into: a barrel about the
        // pivot axis, so the leg can swing in it without anything showing.
        cylinder(m, { from: [leg[0], leg[1], leg[2] - 0.031], to: [leg[0], leg[1], leg[2] + 0.031], radius: br, sides: 10, caps: false }, STEEL);
        // Clevis ears either side of it, reaching back into the rail.
        for (const z of [-0.04, 0.04]) ear(leg[0] - s * 0.07, leg[0] + s * (br + 0.006), leg[1], br + 0.006, leg[2] + z);
        if (bolts) cylinder(m, { from: [leg[0], leg[1], leg[2] - 0.06], to: [leg[0], leg[1], leg[2] + 0.06], radius: 0.012, sides: 6, round: false }, STEEL);
      }
    }
    const t = c.damperTop;
    for (const z of [-0.042, 0.042]) ear(t[0] - s * 0.047, t[0] + s * 0.023, t[1] + 0.012, 0.045, t[2] + z);
    roundedBox(m, { size: [0.075, 0.03, 0.1], radius: 0.008, segments: 1, at: [t[0] - s * 0.012, t[1] + 0.058, t[2]] }, P);
    if (bolts) cylinder(m, { from: [t[0], t[1], t[2] - 0.058], to: [t[0], t[1], t[2] + 0.058], radius: 0.012, sides: 6, round: false }, STEEL);
    if (c.tieRod) {
      const r = c.tieRod;
      cylinder(m, { from: [r[0] - s * 0.11, r[1], r[2]], to: [r[0] - s * 0.005, r[1], r[2]], radius: 0.03, sides: 8, bevel: 0.008, bevelSegments: 1 }, P);
    }
    if (c.halfShaft) {
      const h = c.halfShaft;
      cylinder(m, { from: [h[0] - s * 0.1, h[1], h[2]], to: [h[0], h[1], h[2]], radius: 0.07, sides: 12, bevel: 0.012, bevelSegments: 1 }, P);
    }
  }
}
