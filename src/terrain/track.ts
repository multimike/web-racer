import { mulberry32 } from './noise';
import type { Heightfield } from './Heightfield';
import { TRACK_RULES, measureTrack, trackViolations } from './trackRules';

/** Closed racing loop as a dense, evenly spaced polyline. The layout itself is
 * only used at generation time — carving, planning and spawn all work from
 * this sampled form. */
export interface Track {
  /** Polyline points, ~1 m apart, [x0,z0, x1,z1, ...]. Closed: last connects to first. */
  points: Float32Array;
  /** Unit tangents per point, same layout. */
  tangents: Float32Array;
  /** Smoothed road height per point (world y of the carved surface). */
  roadHeights: Float32Array;
  count: number;
  /** Drivable half-width in meters (flat part; blend shoulder extends beyond). */
  halfWidth: number;
  shoulder: number;
  /** Per-heightfield-sample distance to the road centerline; filled by the
   * carve pass and reused by the splat pass (Infinity beyond the shoulder). */
  sampleRoadDist?: Float32Array;
}

type P = [number, number];

/** Which layout a track was built from (for the world lab and the report). */
export interface TrackLayoutInfo {
  family: string;
  mirrored: boolean;
  /** 1-based attempt that passed; 0 = the fixed fallback layout. */
  attempt: number;
}

/** Layout of the most recent generateTrack call (diagnostics only: nothing
 * reads it back, so it cannot make two generations differ). */
export const lastTrackLayout: TrackLayoutInfo = { family: '', mirrored: false, attempt: 0 };

const MAX_ATTEMPTS = 60;

/**
 * Seeded loop that obeys TRACK_RULES. Every layout is a closed polygon whose
 * corners are replaced by tangent arcs of their own radius, resampled to
 * 1 m. All layouts share the SPINE: the start straight on x = 0 from the
 * bottom joint (z ≈ −39) to the first corner (z ≈ 57), so point 0 is the
 * world origin heading +z with 40 m of straight ahead and 20 m behind. The
 * loop has to use both halves of the 128 m square to reach 450 m, so one
 * half carries a "lobe" (the side the first corner turns to) and the other
 * a "return" that doubles back down an inner leg to the bottom joint. The
 * families differ in those two halves; the mirror swaps them.
 *
 * Candidates are measured with the planner's own TrackFrame and rejected
 * until one passes every rule (sub-seed per attempt); after MAX_ATTEMPTS a
 * fixed, hand-checked layout ends the search.
 */
export function generateTrack(seed: number, hf: Heightfield): Track {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rand = mulberry32(seed * 7919 + 17 + attempt * 104729);
    const family = FAMILIES[Math.floor(rand() * FAMILIES.length) % FAMILIES.length];
    const mirror = rand() < 0.5;
    const jit = (a: number): number => (rand() * 2 - 1) * a;
    const rad = (lo: number, hi: number): number => lo + rand() * (hi - lo);
    const layout = family.build(jit, rad);
    const track = buildTrack(layout, mirror, hf);
    if (!track) continue;
    if (trackViolations(measureTrack(track, hf.size)).length === 0) {
      lastTrackLayout.family = family.name;
      lastTrackLayout.mirrored = mirror;
      lastTrackLayout.attempt = attempt + 1;
      return track;
    }
  }
  // Fallback: the lobe-and-hairpin family at its nominal values. NOT
  // validated here (the world-sweep has no fallback test either); it was
  // checked by hand with `trackViolations` on the terrain of seeds 1–220
  // and was valid on every one.
  const track = buildTrack(FAMILIES[0].build(() => 0, (lo, hi) => (lo + hi) / 2), false, hf)!;
  lastTrackLayout.family = FAMILIES[0].name;
  lastTrackLayout.mirrored = false;
  lastTrackLayout.attempt = 0;
  return track;
}

// ---------------------------------------------------------------------------
// Layout families. Canonical orientation: the first corner turns RIGHT (to
// +x), so the lobe is on the +x half and the return on the −x half. Corner 0
// is the bottom joint onto the spine, corner 1 the first corner; the spine
// edge between them carries the start line. Radii below 22 m are signed
// bends for the planner (chevrons); drawn tight radii start at 11 because
// TrackFrame's blur reads a drawn 10 as about 9.4.

interface Layout {
  pts: P[];
  radii: number[];
}

interface Family {
  name: string;
  build(jit: (a: number) => number, rad: (lo: number, hi: number) => number): Layout;
}

/** Spine ends: bottom joint and first corner. */
const SPINE_BOTTOM = -39;
const SPINE_TOP = 57.5;

const FAMILIES: Family[] = [
  {
    // Right: one big lobe. Left: up the outer edge, squared hairpin at the
    // top, inner leg back down to the joint.
    name: 'lobe + high hairpin',
    build(j, R) {
      const top = SPINE_TOP + j(1);
      return {
        pts: [
          [0, SPINE_BOTTOM + j(0.5)],
          [0, top],
          [40 + j(6), top + 3 + j(1)],
          [60 + j(2), 8 + j(10)],
          [50 + j(5), -50 + j(3)],
          [-4 + j(10), -63 + j(0.5)],
          [-56 + j(3), -55 + j(2)],
          [-61 + j(1.5), 20 + j(8)],
          [-58 + j(2), 60 + j(1.5)],
          [-29 + j(1.5), 60 + j(1.5)],
          [-28 + j(1.5), SPINE_BOTTOM + j(0.5)],
        ],
        radii: [R(11, 12.5), R(12, 14), R(16, 30), R(30, 60), R(16, 26), R(40, 80), R(16, 24), R(40, 80), R(12, 14), R(12, 14), R(11, 13)],
      };
    },
  },
  {
    // Right: squared hairpin straight after the first corner, down an inner
    // leg, then out to the edge. Left: a sweeping return over the top-left.
    name: 'early hairpin + sweeping return',
    build(j, R) {
      const top = SPINE_TOP + j(1);
      return {
        pts: [
          [0, SPINE_BOTTOM + j(0.5)],
          [0, top],
          [29 + j(1.5), top + j(1)],
          [29 + j(1.5), 16 + j(5)],
          [61 + j(1.5), 4 + j(4)],
          [56 + j(4), -50 + j(4)],
          [0 + j(10), -63 + j(0.5)],
          [-54 + j(4), -55 + j(2)],
          [-61 + j(2), 6 + j(10)],
          [-50 + j(5), 56 + j(4)],
          [-28 + j(1.5), 30 + j(8)],
          [-28 + j(1.5), SPINE_BOTTOM + j(0.5)],
        ],
        radii: [R(11, 12.5), R(12, 14), R(12, 14), R(11, 12.5), R(11, 12.5), R(16, 26), R(40, 80), R(16, 26), R(30, 60), R(12, 16), R(20, 40), R(11, 13)],
      };
    },
  },
  {
    // Right: the lobe pinched by a chicane halfway down. Left: a LOW squared
    // hairpin (the top-left quarter stays open country).
    name: 'chicane + low hairpin',
    build(j, R) {
      const top = SPINE_TOP + j(1);
      const cz = j(4);
      return {
        pts: [
          [0, SPINE_BOTTOM + j(0.5)],
          [0, top],
          [44 + j(3), top + 3 + j(1)],
          [61 + j(1.5), 32 + cz + j(3)],
          [42 + j(2), 12 + cz + j(2)],
          [42 + j(2), -12 + cz + j(2)],
          [61 + j(1.5), -32 + cz + j(3)],
          [50 + j(4), -60 + j(1)],
          [-2 + j(10), -63 + j(0.5)],
          [-56 + j(3), -56 + j(2)],
          [-61 + j(1.5), 4 + j(5)],
          [-31 + j(1.5), 4 + j(4)],
          [-29 + j(1.5), SPINE_BOTTOM + j(0.5)],
        ],
        radii: [R(11, 12.5), R(12, 14), R(18, 34), R(14, 20), R(12, 16), R(12, 16), R(14, 20), R(16, 26), R(40, 80), R(16, 24), R(12, 14), R(12, 14), R(11, 13)],
      };
    },
  },
  {
    // Right: a step — out along the top, down a short drop, out to the edge
    // again (right-left-right). Left: long sweeper up the outer edge into a
    // high squared hairpin.
    name: 'step + sweeper hairpin',
    build(j, R) {
      const top = SPINE_TOP + j(1);
      const sx = 38 + j(2);
      return {
        pts: [
          [0, SPINE_BOTTOM + j(0.5)],
          [0, top],
          [sx, top + 2 + j(1)],
          [sx + j(1), 26 + j(4)],
          [61 + j(1.5), 22 + j(4)],
          [58 + j(3), -52 + j(3)],
          [10 + j(10), -63 + j(0.5)],
          [-50 + j(4), -58 + j(2)],
          [-62 + j(1), -20 + j(6)],
          [-57 + j(2), 60 + j(1.5)],
          [-30 + j(1.5), 60 + j(1.5)],
          [-28 + j(1.5), SPINE_BOTTOM + j(0.5)],
        ],
        radii: [R(11, 12.5), R(12, 14), R(12, 15), R(12, 15), R(18, 28), R(16, 26), R(40, 80), R(20, 30), R(40, 90), R(12, 14), R(12, 14), R(11, 13)],
      };
    },
  },
];

// ---------------------------------------------------------------------------

/** Layout → resampled closed polyline through the origin heading +z, with
 * tangents and road heights. null if the fillets do not fit. */
function buildTrack(layout: Layout, mirror: boolean, hf: Heightfield): Track | null {
  const pts = mirror ? layout.pts.map(([x, z]): P => [-x, z]) : layout.pts;
  const arcs = filletLoop(pts, layout.radii);
  if (!arcs) return null;
  // Corner 0 is the bottom joint, corner 1 the first corner: the spine edge
  // runs from the end of arc 0 to the start of arc 1 and crosses z = 0 on
  // x = 0. Start the loop exactly at the origin.
  const a0 = arcs[0];
  const a1 = arcs[1];
  const from = a0[a0.length - 1];
  const to = a1[0];
  if (!(from[1] < 0 && to[1] > 0) || Math.abs(from[0]) > 1e-9 || Math.abs(to[0]) > 1e-9) return null;
  const loop: P[] = [[0, 0]];
  for (let c = 1; c < arcs.length; c++) for (const p of arcs[c]) loop.push(p);
  for (const p of a0) loop.push(p);
  const res = resampleClosed(loop, TRACK_RULES.pointSpacing);
  const n = res.length;
  const points = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    points[i * 2] = res[i][0];
    points[i * 2 + 1] = res[i][1];
  }
  // Tangents: central differences on the closed polyline.
  const tangents = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const dx = points[b * 2] - points[a * 2];
    const dz = points[b * 2 + 1] - points[a * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    tangents[i * 2] = dx / len;
    tangents[i * 2 + 1] = dz / len;
  }
  const roadHeights = roadProfile(points, n, hf);
  return { points, tangents, roadHeights, count: n, halfWidth: TRACK_RULES.halfWidth, shoulder: TRACK_RULES.shoulder };
}

/** Closed polygon → one arc (dense points, ≤ 0.5 m apart) per corner, each a
 * tangent arc of the corner's radius. Where two neighbouring arcs would
 * overlap on their shared edge both shrink in proportion (their radius
 * drops — the rule check then rejects a too-tight result). */
function filletLoop(pts: P[], radii: number[]): P[][] | null {
  const n = pts.length;
  const ux: number[] = [];
  const uz: number[] = [];
  const len: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) return null;
    len.push(l);
    ux.push((b[0] - a[0]) / l);
    uz.push((b[1] - a[1]) / l);
  }
  // Corner i sits between edge i−1 (incoming) and edge i (outgoing).
  const theta: number[] = [];
  const tan: number[] = [];
  for (let i = 0; i < n; i++) {
    const e1 = (i + n - 1) % n;
    const cross = ux[e1] * uz[i] - uz[e1] * ux[i];
    const dot = ux[e1] * ux[i] + uz[e1] * uz[i];
    const th = Math.atan2(cross, dot);
    if (Math.abs(th) > 2.6) return null; // a near-reversal cannot be filleted sanely
    theta.push(th);
    tan.push(radii[i] * Math.tan(Math.abs(th) / 2));
  }
  const scale = new Array<number>(n).fill(1);
  for (let e = 0; e < n; e++) {
    const a = e;
    const b = (e + 1) % n;
    const need = tan[a] + tan[b];
    const room = 0.98 * len[e];
    if (need > room) {
      const f = room / need;
      scale[a] = Math.min(scale[a], f);
      scale[b] = Math.min(scale[b], f);
    }
  }
  const arcs: P[][] = [];
  for (let i = 0; i < n; i++) {
    const b = pts[i];
    const e1 = (i + n - 1) % n;
    const th = theta[i];
    if (Math.abs(th) < 1e-4) {
      arcs.push([b]);
      continue;
    }
    const t = tan[i] * scale[i];
    const r = t / Math.tan(Math.abs(th) / 2);
    const sx = b[0] - ux[e1] * t;
    const sz = b[1] - uz[e1] * t;
    // Centre on the inside of the turn: left normal of the incoming edge is
    // (−uz, ux); a positive (counter-clockwise) turn bends toward it.
    const s = Math.sign(th);
    const cx = sx - uz[e1] * s * r;
    const cz = sz + ux[e1] * s * r;
    const start = Math.atan2(sz - cz, sx - cx);
    const steps = Math.max(2, Math.ceil((Math.abs(th) * r) / 0.5));
    const arc: P[] = [];
    for (let k = 0; k <= steps; k++) {
      const ang = start + (th * k) / steps;
      arc.push([cx + Math.cos(ang) * r, cz + Math.sin(ang) * r]);
    }
    // Snap the ends onto the polygon edges exactly (the spine end must sit on x = 0).
    arc[0] = [sx, sz];
    arc[steps] = [b[0] + ux[i] * t, b[1] + uz[i] * t];
    arcs.push(arc);
  }
  return arcs;
}

/** Resample a closed polyline to even spacing (the first point is kept). */
function resampleClosed(pts: P[], spacing: number): P[] {
  const n = pts.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    seg.push(l);
    total += l;
  }
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: P[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (i < n - 1 && acc + seg[i] < target) {
      acc += seg[i];
      i++;
    }
    const t = seg[i] === 0 ? 0 : (target - acc) / seg[i];
    const j = (i + 1) % n;
    out.push([pts[i][0] + (pts[j][0] - pts[i][0]) * t, pts[i][1] + (pts[j][1] - pts[i][1]) * t]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Road elevation

/** Low-pass window along the loop (box radius, 3 passes ≈ gaussian σ ≈ 16 m). */
const PROFILE_BLUR = 16;
/** Start zone limiter: the grade target (under the 4 % rule) and how far
 * beyond the zone the ramp eases back into the free profile. */
const START_GRADE_TARGET = 0.035;
const START_EASE = 24;
/** Global grade limiter target (under the 12 % rule). */
const GRADE_TARGET = 0.11;
/** Crease rounding after the limiter: box radius (3 passes) and the fade
 * from the exact start ramp to the rounded profile. */
const CREASE_BLUR = 4;
const CREASE_FADE = 6;
/** The exact ramp is kept this far beyond the 4 % zone's ends. */
const CREASE_INSET = 0.5;

/**
 * Road height per point: terrain along the loop, circularly low-pass
 * filtered; then the start zone (straightBehind behind to straightAhead
 * ahead of the line) replaced by the least-squares straight ramp through the
 * filtered profile, its slope clamped under the start-grade rule, eased back
 * into the profile over START_EASE meters at both ends — the correction is
 * spread over the whole straight instead of stepping at its ends; last a
 * grade limiter round the whole loop.
 */
function roadProfile(points: Float32Array, n: number, hf: Heightfield): Float32Array {
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = hf.getHeight(points[i * 2], points[i * 2 + 1]);
  boxBlurCircular(h, PROFILE_BLUR, 3);

  // Signed arc of point i from the line (points are ~1 m apart).
  const L = n * TRACK_RULES.pointSpacing;
  const sOf = (i: number): number => (i <= n / 2 ? i : i - n) * (L / n);
  const z0 = -TRACK_RULES.straightBehind - 2;
  const z1 = TRACK_RULES.straightAhead + 2;
  let sw = 0;
  let ss = 0;
  let sh = 0;
  let ssh = 0;
  let sss = 0;
  for (let i = 0; i < n; i++) {
    const s = sOf(i);
    if (s < z0 || s > z1) continue;
    sw++;
    ss += s;
    sh += h[i];
    ssh += s * h[i];
    sss += s * s;
  }
  const den = sw * sss - ss * ss;
  let slope = den > 0 ? (sw * ssh - ss * sh) / den : 0;
  slope = Math.max(-START_GRADE_TARGET, Math.min(START_GRADE_TARGET, slope));
  const icept = (sh - slope * ss) / sw;
  for (let i = 0; i < n; i++) {
    const s = sOf(i);
    const out = s < z0 ? z0 - s : s > z1 ? s - z1 : 0;
    if (out >= START_EASE) continue;
    const u = out / START_EASE;
    const w = 1 - u * u * (3 - 2 * u);
    h[i] = h[i] * (1 - w) + (icept + slope * s) * w;
  }

  // Grade limiter: clamp each step against its neighbour, forward and
  // backward round the loop until nothing moves. Leaves already gentle
  // stretches (the start ramp) untouched.
  const maxStep = GRADE_TARGET * (L / n);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let k = 1; k <= n; k++) {
      const i = k % n;
      const p = k - 1;
      const lo = h[p] - maxStep;
      const hi = h[p] + maxStep;
      if (h[i] < lo || h[i] > hi) {
        h[i] = h[i] < lo ? lo : hi;
        moved = true;
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = k;
      const p = (k + 1) % n;
      const lo = h[p] - maxStep;
      const hi = h[p] + maxStep;
      if (h[i] < lo || h[i] > hi) {
        h[i] = h[i] < lo ? lo : hi;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // The clamp leaves a vertical crease where it starts biting (seed 183:
  // the grade jumped 7 % within one metre at the end of the start ease).
  // Round every grade change off over ±~9 m. A convolution with a positive
  // unit-sum kernel never raises the largest step, so the limiter's bound
  // survives; the 4 % zone (+ CREASE_INSET) keeps its exact ramp, and the
  // rounded profile fades in over CREASE_FADE m beyond it. Measured on
  // seeds 1–220: grade change ≤ 1.98 % per metre (was up to 7.2 %), start
  // grade still ≤ 3.5 %, max grade 10.8 %.
  const sm = h.slice();
  boxBlurCircular(sm, CREASE_BLUR, 3);
  const r0 = -TRACK_RULES.straightBehind - CREASE_INSET;
  const r1 = TRACK_RULES.straightAhead + CREASE_INSET;
  for (let i = 0; i < n; i++) {
    const s = sOf(i);
    const out = s < r0 ? r0 - s : s > r1 ? s - r1 : 0;
    const u = Math.min(1, out / CREASE_FADE);
    const wb = u * u * (3 - 2 * u);
    h[i] = h[i] * (1 - wb) + sm[i] * wb;
  }
  return h;
}

/** In-place circular box blur, `passes`× (3 passes ≈ gaussian). */
function boxBlurCircular(data: Float32Array, radius: number, passes: number): void {
  const n = data.length;
  const tmp = new Float32Array(n);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += data[((i % n) + n) % n];
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / w;
      sum -= data[(((i - radius) % n) + n) % n];
      sum += data[((i + radius + 1) % n) % n];
    }
    data.set(tmp);
  }
}
