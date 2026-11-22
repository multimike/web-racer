import type { Heightfield } from '../terrain/Heightfield';
import { GANTRY_HALF_OPENING, GANTRY_PYLON_OFFSET, GANTRY_PYLON_RADIUS, WALL_PITCH, catalogEntry } from './catalog';
import { clamp, obbCorners, obbDistance, obbOverlap, pointInPolygon, polygonEdgeDistance, r3, segmentDistance, smoothstep, toLocal, toWorld, yawAlong, yawFacing } from './geom';
import type { Obb } from './geom';
import { hashSeed } from './rng';
import type { Rng } from './rng';
import type { TrackFrame } from './trackFrame';
import type { Bend, Lot, LotRole, PadFalloff, PadMarking, SurfacePad, TerrainModifier, Vec2, VillagePlan } from './types';

/**
 * Village layout: pick the stretch of road, seat the anchor buildings
 * (garage at the start line, village hall + market on a shared square,
 * water tower behind the roofs), fill both sides of the street with houses
 * and shacks, drop a few outlying shacks around the rest of the loop, then
 * derive what the terrain and the road need from that: flatten pads,
 * levelled verges, paved pads and paths, retaining walls.
 *
 * Everything is "propose, measure, reject": a lot is only accepted where its
 * rectangle clears every part of the loop, every other lot, the world edge
 * and the cut / fill limit — so the same code holds for any track the
 * generator comes up with, including 4 m hairpins and pinched loops.
 */

/** Lateral distances from the centreline that everything else is laid out
 * against. */
export interface RoadDims {
  hw: number;
  kerbRough: number;
  kerbDressed: number;
  /** Outer edge of the kerb, countryside and village. */
  edgeRough: number;
  edgeDressed: number;
  /** Clear run-off beyond the kerb: nothing solid stands inside it. */
  runoff: number;
  /** Fence line through the village and in front of outlying lots. */
  fence: number;
  fenceOut: number;
}

export function roadDims(hw: number): RoadDims {
  const kerbRough = 0.4;
  // The start gantry was built for a 12 m road: the dressed kerb has to fit
  // between its plinths, so it narrows if the road itself is wider than 5 m.
  const kerbDressed = clamp(GANTRY_HALF_OPENING - 0.05 - hw, 0.4, 0.6);
  const runoff = 1.5;
  return {
    hw,
    kerbRough,
    kerbDressed,
    edgeRough: hw + kerbRough,
    edgeDressed: hw + kerbDressed,
    runoff,
    // 25 cm beyond the run-off: the posts are 12 cm thick each way, and on
    // the outside of a hairpin the middle of a straight 2.4 m segment sits
    // 6 cm nearer the road than its ends.
    fence: hw + kerbDressed + runoff + 0.25,
    // Same line out of town: a lot near the village end may have part of its
    // fence in front of dressed kerb, and one line keeps both clear.
    fenceOut: hw + kerbDressed + runoff + 0.25,
  };
}

/** What marks the start line, decided before anything is laid out. */
export interface StartMarker {
  kind: 'gantry' | 'flags';
  /** Where the gantry's two plinths stand (or would have stood). */
  pylons: Vec2[];
  yaw: number;
  /** Smallest distance from a plinth's face to ANY centreline point. */
  clearance: number;
  /** Why there is no gantry (kind 'flags'). */
  reason?: string;
}

/** A plinth face nearer than this to the drivable road means no gantry. */
export const GANTRY_ROAD_CLEARANCE = 0.3;
/** Road tangent vs spawn heading at the start line, radians: beyond this
 * (about 8°, a bend of under 4 m radius) there is no gantry. */
const GANTRY_MAX_SKEW = 0.14;

/**
 * Gantry or flags? The gantry is one fixed 14.5 m asset: it only stands where
 * the road and its kerb fit between the plinths AND neither plinth comes
 * near any other piece of the loop (a start line on a hairpin has the
 * returning leg right beside it). Otherwise flag poles mark the line.
 */
export function planStartMarker(frame: TrackFrame, dims: RoadDims): StartMarker {
  const p = frame.at(0);
  const pylons = ([1, -1] as const).map((side) => frame.offset(0, side * GANTRY_PYLON_OFFSET));
  let clearance = Infinity;
  for (const [x, z] of pylons) clearance = Math.min(clearance, frame.nearest(x, z).dist - GANTRY_PYLON_RADIUS);
  // Square to the road's tangent at the line. The cars spawn along the
  // first SEGMENT of the polyline instead (the track generator lays that
  // one on +z); in a bend the two differ by half the turn the road makes in
  // that meter. A few degrees pass for square from either point of view —
  // more means the line sits on a hairpin, where no 14.5 m gantry can be
  // square to both the road and the grid.
  const dx = frame.px[1] - frame.px[0];
  const dz = frame.pz[1] - frame.pz[0];
  const skew = Math.abs(Math.atan2(p.tx * dz - p.tz * dx, p.tx * dx + p.tz * dz));
  const marker: StartMarker = { kind: 'gantry', pylons, yaw: yawAlong(p.tx, p.tz), clearance };
  if (GANTRY_HALF_OPENING < dims.edgeDressed - 0.01) {
    marker.kind = 'flags';
    marker.reason = `road + kerb half width ${dims.edgeDressed.toFixed(2)} m exceeds the gantry opening ${GANTRY_HALF_OPENING.toFixed(2)} m`;
  } else if (clearance < dims.hw + GANTRY_ROAD_CLEARANCE) {
    marker.kind = 'flags';
    marker.reason = `a gantry plinth would stand ${(clearance - dims.hw).toFixed(2)} m from the road edge (the start line is on a hairpin, or another leg of the loop passes beside it)`;
  } else if (skew > GANTRY_MAX_SKEW) {
    marker.kind = 'flags';
    marker.reason = `the start line is on a hairpin: the road there is ${((skew * 180) / Math.PI).toFixed(0)}° off the grid's heading`;
  }
  return marker;
}

export interface PlanContext {
  frame: TrackFrame;
  /** Terrain before modifiers. */
  base: Heightfield;
  seed: number;
  dims: RoadDims;
  /** Lots stay inside ±limit: beyond it the bowl rim climbs. */
  limit: number;
  start: StartMarker;
  /** Signed bends of the loop (chevrons stand on their outside). */
  bends: readonly Bend[];
}

/** A stretch of fence line / kerb that must stay open on one side. */
export interface Opening {
  side: 1 | -1;
  s0: number;
  s1: number;
  kind: 'gate' | 'pad';
  /** For kind 'pad': which pad joins the road here. */
  pad?: 'apron' | 'square';
}

export interface WallSegment {
  x: number;
  z: number;
  yaw: number;
  lot: number;
}

export interface VillageResult {
  village: VillagePlan;
  lots: Lot[];
  modifiers: TerrainModifier[];
  pads: SurfacePad[];
  openings: Opening[];
  walls: WallSegment[];
}

/** Lots may need at most this much cut or fill (self-check allows 1.5). */
const MAX_CUT_FILL = 1.25;
/** Flatten pads reach this far beyond the envelope. */
export const PAD_MARGIN = 0.6;
const LOT_GAP = 2.4;
const SLOT_W = 6.8;
const SLOT_D = 6.8;
/** Envelope width shared by the three shacks. */
const SHACK_W = 4.8;
const APRON_DEPTH = 7.0;
/** Most a run-off strip or an outlying verge may move the ground: they are
 * conveniences, not worth a cutting. (Lots have MAX_CUT_FILL.) */
const VERGE_EARTHWORK = 1.2;
/** Half width of a gate opening, measured along the fence line. */
const GATE_HALF = 1.15;
/** An outlying lot's fence runs this far along the road either side of its gate. */
export const OUTLYING_FENCE_REACH = 8.6;
/** Arc-length window of the checkered banners along the start straight
 * (dressing places them; the verge below is widened over it). */
export const BANNER_S0 = -18;
export const BANNER_S1 = 38;
/**
 * Fence runs that reach into the banner window (± 3 m) stand this much
 * farther from the road. The banner cannot come nearer the road (its stakes
 * would be in the run-off), and the fence's front face (posts ±0.1 m, bolt
 * heads, the catalog's ±0.125 m) is only 0.125 m behind the run-off line: a
 * banner between the two leaves its stakes touching the posts. 0.25 m opens
 * the gap to ≥ 0.15 m. Whole runs move, so the step falls at a gate or a
 * pad, where the fence is open anyway.
 */
export const BANNER_FENCE_SETBACK = 0.25;
const SCHEMES = ['warm', 'coastal', 'sunny'] as const;

interface Fit {
  obb: Obb;
  s: number;
  side: 1 | -1;
  /** Nearest road point and distance from the centre to it. */
  rx: number;
  rz: number;
  dist: number;
  roadH: number;
  target: number;
  cut: number;
  fill: number;
}

interface HeightMode {
  /** Level with the road (aprons, squares) instead of following the ground. */
  flush: boolean;
  /** How far below / above the road the pad may sit when not flush. */
  lift: [number, number];
}

const FLUSH_MODE: HeightMode = { flush: true, lift: [0, 0] };
/** Second-row and outlying lots: far enough back to sit on their own level. */
const FREE_MODE: HeightMode = { flush: false, lift: [-0.5, 1.2] };
/** The verge is level with the road out to this far behind the fence line;
 * a pad's front blend must not reach nearer, or the fence stands on a bank. */
const VERGE_BEHIND_FENCE = 0.3;

/** Length of the blend between the level verge and a pad whose envelope
 * front is `yard` meters behind the fence line. Out of town the yards are
 * deep and the blend may be long. */
function frontSkirt(yard: number, zone: 'village' | 'outlying'): number {
  return clamp(yard - PAD_MARGIN - VERGE_BEHIND_FENCE, 0.6, zone === 'village' ? 2.6 : 5);
}

/**
 * How far a fenced lot's pad may leave the road's height: tied to the room
 * there is to blend it in, so the door path never has to climb a bank
 * between gate and door (a quarter of the blend length: about 20° at its
 * steepest). Street-front houses therefore sit at street level on a low
 * plinth; an outlying shack 5 m or more back may stand a good meter up.
 */
function yardMode(yard: number, zone: 'village' | 'outlying'): HeightMode {
  const skirt = frontSkirt(yard, zone);
  const [down, up] = zone === 'village' ? [0.3, 0.55] : [0.5, 1.2];
  return { flush: false, lift: [-Math.min(down, 0.05 + 0.2 * skirt), Math.min(up, 0.05 + 0.25 * skirt)] };
}

/** Smallest distance between two rectangles that do not overlap. */
function rectGap(a: Obb, b: Obb): number {
  let best = Infinity;
  for (const [x, z] of obbCorners(a)) best = Math.min(best, obbDistance(b, x, z));
  for (const [x, z] of obbCorners(b)) best = Math.min(best, obbDistance(a, x, z));
  return best;
}

/** The part of a lot the road-side geometry is derived from; `Lot` fits. */
interface Front {
  x: number;
  z: number;
  yaw: number;
  halfX: number;
  halfZ: number;
  s: number;
  side: 1 | -1;
}

/** A pad between building fronts and the road edge, before it is a pad. */
interface JoinShape {
  polygon: Vec2[];
  /** Arc range of road edge it takes up, upstream → downstream. */
  sA: number;
  sB: number;
  side: 1 | -1;
}

function padStats(base: Heightfield, obb: Obb): { mean: number; min: number; max: number } {
  const N = 6;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const hx = obb.hx + PAD_MARGIN;
  const hz = obb.hz + PAD_MARGIN;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const [wx, wz] = toWorld(obb.x, obb.z, obb.yaw, -hx + (2 * hx * ix) / N, -hz + (2 * hz * iz) / N);
      const h = base.getHeight(wx, wz);
      sum += h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { mean: sum / ((N + 1) * (N + 1)), min, max };
}

/** Smallest distance from any track point to the rectangle. */
function roadClearance(frame: TrackFrame, obb: Obb): number {
  const c = Math.cos(obb.yaw);
  const s = Math.sin(obb.yaw);
  let best = Infinity;
  for (let i = 0; i < frame.n; i++) {
    const dx = frame.px[i] - obb.x;
    const dz = frame.pz[i] - obb.z;
    const lx = Math.abs(dx * c - dz * s) - obb.hx;
    const lz = Math.abs(dx * s + dz * c) - obb.hz;
    const d = Math.hypot(lx > 0 ? lx : 0, lz > 0 ? lz : 0);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Try a w × d rectangle whose FRONT edge is `front` meters from the
 * centreline at arc length s on `side`. Null if it does not fit.
 */
function fitLot(
  ctx: PlanContext,
  s: number,
  side: 1 | -1,
  front: number,
  w: number,
  d: number,
  mode: HeightMode,
  placed: readonly Obb[],
  maxCutFill = MAX_CUT_FILL,
): Fit | null {
  const { frame, base, dims } = ctx;
  const D = front + d / 2;
  const [cx, cz] = frame.offset(s, side * D);
  if (Math.abs(cx) > ctx.limit || Math.abs(cz) > ctx.limit) return null;
  // Cheap reject first: on the inside of a tight bend (or where another
  // part of the loop passes) the offset point is nearer to the road than it
  // was meant to be.
  if (frame.fastDist(cx, cz) < D - 1) return null;
  const hit = frame.nearest(cx, cz);
  if (hit.dist < D - 0.6 || hit.side !== side) return null;
  const rp = frame.at(hit.s);
  const fx = (rp.x - cx) / hit.dist;
  const fz = (rp.z - cz) / hit.dist;
  const obb: Obb = { x: cx, z: cz, yaw: yawFacing(fx, fz), hx: w / 2, hz: d / 2 };
  for (const [x, z] of obbCorners(obb, PAD_MARGIN)) {
    if (Math.abs(x) > ctx.limit || Math.abs(z) > ctx.limit) return null;
  }
  // The whole-loop scan is only needed when the road can be within reach.
  const need = dims.edgeDressed + dims.runoff;
  if (frame.fastDist(cx, cz) < need + Math.hypot(w, d) / 2 + 0.5 && roadClearance(frame, obb) < need) return null;
  for (const o of placed) if (obbOverlap(obb, o, LOT_GAP)) return null;
  const st = padStats(base, obb);
  const target = mode.flush ? rp.h : rp.h + clamp(st.mean - rp.h, mode.lift[0], mode.lift[1]);
  const cut = Math.max(0, st.max - target);
  const fill = Math.max(0, target - st.min);
  if (cut > maxCutFill || fill > maxCutFill) return null;
  return { obb, s: hit.s, side, rx: rp.x, rz: rp.z, dist: hit.dist, roadH: rp.h, target, cut, fill };
}

/** How much of the approach has the point roughly straight ahead: 0..1. */
function visibility(frame: TrackFrame, x: number, z: number, s: number): number {
  let seen = 0;
  let total = 0;
  for (let a = 10; a <= 62; a += 4) {
    const p = frame.at(s - a);
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.hypot(dx, dz);
    total++;
    if (d < 6 || d > 80) continue;
    if ((dx * p.tx + dz * p.tz) / d > 0.96) seen++;
  }
  return seen / total;
}

/** Score a candidate village stretch: flat road, gentle bends, room on both sides. */
function scoreStretch(ctx: PlanContext, s0: number, len: number): number {
  const { frame, base, dims } = ctx;
  let sum = 0;
  let count = 0;
  for (let u = 0; u <= len; u += 3) {
    const p = frame.at(s0 + u);
    const q = frame.at(s0 + u + 3);
    const grade = Math.abs(q.h - p.h) / 3;
    const bend = smoothstep(1 / 16, 1 / 6, Math.abs(p.k));
    let room = 0;
    for (const side of [1, -1] as const) {
      for (const [D, tol] of [
        [dims.hw + 9, 1.2],
        [dims.hw + 16, 1.9],
      ]) {
        const x = p.x - p.tz * side * D;
        const z = p.z + p.tx * side * D;
        if (Math.abs(x) > ctx.limit || Math.abs(z) > ctx.limit) continue;
        if (frame.fastDist(x, z) < D - 1.2) continue;
        if (Math.abs(base.getHeight(x, z) - p.h) > tol) continue;
        room += 0.25;
      }
    }
    sum += room * (1 - 0.55 * bend) * (1 - 0.5 * smoothstep(0.03, 0.12, grade));
    count++;
  }
  return sum / count;
}

function chooseStretch(ctx: PlanContext): { s0: number; len: number; score: number } {
  const L = ctx.frame.length;
  // The brief asks for 120–180 m of village; today's loops are only
  // 195–285 m long, so the village takes about half of the lap and the rest
  // stays countryside. A longer loop automatically gets the full length.
  const lens = [0.5, 0.44, 0.56].map((f) => clamp(f * L, 90, 170));
  let best = { s0: -40, len: lens[0], score: -1 };
  for (const len of lens) {
    // The start line sits in the first half of the stretch: cars leave the
    // grid THROUGH the village rather than out of its last house.
    for (let before = 24; before <= len * 0.5; before += 4) {
      const score = scoreStretch(ctx, -before, len) + 0.0004 * len;
      if (score > best.score) best = { s0: -before, len, score };
    }
  }
  return best;
}

interface Slot {
  fit: Fit;
  u: number;
  side: 1 | -1;
  fringe: boolean;
  /** Too narrow for a house: shacks only. */
  narrow: boolean;
  /** Second row, behind the street-front lots: no gate of its own. */
  back: boolean;
  asset: string;
  role: LotRole;
}

export function planVillage(ctx: PlanContext, rand: Rng): VillageResult {
  const { frame, base, dims } = ctx;
  /** How much farther back the fence in front of a lot centred at s (half
   * width hx) stands: BANNER_FENCE_SETBACK on the start straight (dressing
   * sets those runs back for the banners), else 0. The lot's front blend
   * ends that much farther back. (The lift the lot was fitted with stays
   * measured from the nominal line: measuring it from the set-back line
   * too cost seed 526 its twelfth village building.) */
  const startSetback = (s: number, hx: number): number => {
    const d = frame.delta(0, s);
    return d >= BANNER_S0 - 4 - hx && d <= BANNER_S1 + 4 + hx ? BANNER_FENCE_SETBACK : 0;
  };
  const stretch = chooseStretch(ctx);
  const vs0 = stretch.s0;
  const len = stretch.len;
  /** Arc position relative to the village start, 0 … len inside it. */
  const uOf = (s: number): number => frame.wrap(s - vs0);

  const placed: Obb[] = [];
  const lots: Lot[] = [];
  const modifiers: TerrainModifier[] = [];
  const pads: SurfacePad[] = [];
  const openings: Opening[] = [];
  const walls: WallSegment[] = [];
  const usedLooks = new Map<string, number>();
  const villageScheme = rand.int(0, 2);
  /** Ground that will be paved up to the road edge (apron, squares): no
   * other lot may stand on it. */
  const keepClear: Vec2[][] = [];

  // --- The start line comes first: the ground the gantry's plinths (or the
  // flag poles) stand on is taken before any lot is dealt, on both sides.
  for (const [px, pz] of ctx.start.pylons) placed.push({ x: px, z: pz, yaw: ctx.start.yaw, hx: 1, hz: 1 });
  /** A lot's door path (front centre → road) must pass the plinths with room
   * to spare: plinth + half a path + a good stride of air. */
  const pathClear = (fit: Fit): boolean => {
    const fx = (fit.rx - fit.obb.x) / fit.dist;
    const fz = (fit.rz - fit.obb.z) / fit.dist;
    for (const [px, pz] of ctx.start.pylons) {
      if (segmentDistance(fit.obb.x + fx * fit.obb.hz, fit.obb.z + fz * fit.obb.hz, fit.rx, fit.rz, px, pz) < GANTRY_PYLON_RADIUS + 2.4) return false;
    }
    return true;
  };

  /** Next unused (seed, scheme) pair of an asset, so repeats never match:
   * the sequence walks all variants × schemes before it repeats, changing
   * both the seed and the scheme at every step. The variant sequence starts
   * at a hash of the WORLD seed and the asset (a constant shift, so the walk
   * still visits every pair): a building the village holds once (garage,
   * market hall, water tower, village hall) would otherwise always be
   * variant 0, and its modelled variants would appear in no world. */
  const nextLook = (asset: string): { seed: number; scheme: string } => {
    const e = catalogEntry(asset);
    const k = usedLooks.get(asset) ?? 0;
    usedLooks.set(asset, k + 1);
    const base = villageScheme + Number(asset.slice(1, 3));
    const shift = (hashSeed(ctx.seed, 'look', asset) >>> 0) % e.variants;
    return { seed: (k + shift) % e.variants, scheme: SCHEMES[(base + k + Math.floor(k / e.variants)) % SCHEMES.length] };
  };

  const addLot = (
    fit: Fit,
    asset: string,
    role: LotRole,
    zone: 'village' | 'outlying',
    opts: { fenced: boolean; slotDepth?: number },
  ): Lot => {
    const e = catalogEntry(asset);
    const [envW, envD] = e.envelope!;
    // A slot is deeper than most envelopes: slide the building forward so
    // its front edge sits on the slot's front edge.
    const slide = opts.slotDepth !== undefined ? (opts.slotDepth - envD) / 2 : 0;
    const fx = (fit.rx - fit.obb.x) / fit.dist;
    const fz = (fit.rz - fit.obb.z) / fit.dist;
    const x = fit.obb.x + fx * slide;
    const z = fit.obb.z + fz * slide;
    const dist = fit.dist - slide;
    const obb: Obb = { x, z, yaw: fit.obb.yaw, hx: envW / 2, hz: envD / 2 };
    const st = padStats(base, obb);
    const look = nextLook(asset);
    const fenceLine = zone === 'village' ? dims.fence : dims.fenceOut;
    const gate = dist - fenceLine;
    const lot: Lot = {
      id: lots.length,
      asset,
      seed: look.seed,
      scheme: look.scheme,
      role,
      zone,
      x: r3(x),
      y: r3(fit.target),
      z: r3(z),
      yaw: r3(fit.obb.yaw),
      halfX: envW / 2,
      halfZ: envD / 2,
      bodyHalfX: e.footprint[0] / 2,
      bodyHalfZ: e.footprint[1] / 2,
      s: r3(fit.s),
      side: fit.side,
      roadPoint: [r3(fit.rx), r3(fit.rz)],
      setback: r3(dist - envD / 2),
      entrance: opts.fenced ? [r3(x + fx * gate), r3(z + fz * gate)] : null,
      cut: r3(Math.max(0, st.max - fit.target)),
      fill: r3(Math.max(0, fit.target - st.min)),
    };
    lots.push(lot);
    placed.push(obb);
    return lot;
  };

  /** Rectangle between a lot's front and the road, kept free of other lots. */
  const reserveFront = (fit: Fit, w: number, d: number): void => {
    const fx = (fit.rx - fit.obb.x) / fit.dist;
    const fz = (fit.rz - fit.obb.z) / fit.dist;
    const depth = fit.dist - d / 2 - dims.hw;
    placed.push({
      x: fit.obb.x + fx * (d / 2 + depth / 2),
      z: fit.obb.z + fz * (d / 2 + depth / 2),
      yaw: fit.obb.yaw,
      hx: w / 2 + 1,
      hz: depth / 2,
    });
  };

  // --- Geometry of a pad that joins building fronts to the road edge. Built
  // from candidates too, so a garage or a square is only ACCEPTED where its
  // pad is legal — not found to be illegal after the fact.
  const frontOfFit = (fit: Fit): Front => ({ x: fit.obb.x, z: fit.obb.z, yaw: fit.obb.yaw, halfX: fit.obb.hx, halfZ: fit.obb.hz, s: fit.s, side: fit.side });
  const frontCorners = (lot: Front): { up: Vec2; down: Vec2; sUp: number; sDown: number } => {
    const a = toWorld(lot.x, lot.z, lot.yaw, -lot.halfX - 0.8, -lot.halfZ);
    const b = toWorld(lot.x, lot.z, lot.yaw, lot.halfX + 0.8, -lot.halfZ);
    const ha = frame.nearest(a[0], a[1]);
    const hb = frame.nearest(b[0], b[1]);
    return frame.delta(lot.s, ha.s) <= frame.delta(lot.s, hb.s) ? { up: a, down: b, sUp: ha.s, sDown: hb.s } : { up: b, down: a, sUp: hb.s, sDown: ha.s };
  };
  /** Points along the road edge on `side` from s0 forward to s1. */
  const roadEdge = (s0: number, s1: number, side: 1 | -1): Vec2[] => {
    const span = frame.wrap(s1 - s0);
    const steps = Math.max(2, Math.ceil(span / 1.5));
    const out: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const [x, z] = frame.offset(s0 + (span * i) / steps, side * dims.hw);
      // Inside a tight bend the edge line folds back over the road: those
      // points are left out and the pad's edge cuts straight across.
      if (i > 0 && i < steps && frame.fastDist(x, z) < dims.hw - 0.03) continue;
      out.push([r3(x), r3(z)]);
    }
    return out;
  };
  const round2 = (p: Vec2): Vec2 => [r3(p[0]), r3(p[1])];
  const joinShape = (group: readonly Front[]): JoinShape => {
    const ordered = group.slice().sort((a, b) => frame.delta(group[0].s, a.s) - frame.delta(group[0].s, b.s));
    const corners = ordered.map(frontCorners);
    const sA = corners[0].sUp;
    const sB = corners[corners.length - 1].sDown;
    const side = ordered[0].side;
    const polygon = roadEdge(sA, sB, side);
    for (let i = corners.length - 1; i >= 0; i--) polygon.push(round2(corners[i].down), round2(corners[i].up));
    return { polygon, sA, sB, side };
  };
  /** A join pad must leave the start line alone: not straddle it (with a
   * little air either side) and not have a gantry plinth on or beside it. */
  const offStartLine = (shape: JoinShape): boolean => {
    const AIR = 1.5;
    if (frame.wrap(0 - (shape.sA - AIR)) <= frame.wrap(shape.sB - shape.sA) + 2 * AIR) return false;
    for (const [px, pz] of ctx.start.pylons) {
      if (pointInPolygon(shape.polygon, px, pz) || polygonEdgeDistance(shape.polygon, px, pz) < GANTRY_PYLON_RADIUS + 0.6) return false;
    }
    return true;
  };
  /** True if the rectangle (grown by `grow`) and the polygon share ground. */
  const onPolygon = (obb: Obb, polygon: readonly Vec2[], grow: number): boolean => {
    const big: Obb = { ...obb, hx: obb.hx + grow, hz: obb.hz + grow };
    for (const [x, z] of polygon) if (obbDistance(big, x, z) === 0) return true;
    // Its outline, a point per meter: catches a rectangle lying across a
    // polygon none of whose vertices it contains.
    const c = obbCorners(big);
    for (let i = 0; i < 4; i++) {
      const [ax, az] = c[i];
      const [bx, bz] = c[(i + 1) % 4];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      for (let k = 0; k < n; k++) {
        if (pointInPolygon(polygon, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)) return true;
      }
    }
    return pointInPolygon(polygon, obb.x, obb.z);
  };
  const offPads = (obb: Obb): boolean => keepClear.every((poly) => !onPolygon(obb, poly, 0.6));

  // --- Race garage: beside the grid, close behind the start line (or just
  // past it), its apron clear of the line and of the gantry.
  const GARAGE = catalogEntry('b07-race-garage').envelope!;
  const garageFront = dims.edgeDressed + APRON_DEPTH;
  const findGarage = (): Fit | null => {
    let best: Fit | null = null;
    let bestCost = Infinity;
    const consider = (s: number, side: 1 | -1, penalty: number, limit: number, anywhere = false): void => {
      if (penalty >= bestCost) return;
      const fit = fitLot(ctx, s, side, garageFront, GARAGE[0], GARAGE[1], FLUSH_MODE, placed, limit);
      if (!fit) return;
      // The lot must front the stretch it was offered for: between two legs
      // of the loop the offset point can be claimed by the OTHER leg (seed
      // 24: a candidate at s = 11 became a garage at s = 115, far from the
      // line, and outbid every honest candidate near it).
      if (Math.abs(frame.delta(s, fit.s)) > 4) return;
      // On the cobbles, unless nothing in the village will take it.
      if (!anywhere && uOf(fit.s) > len) return;
      const cost = Math.max(fit.cut, fit.fill) + penalty;
      if (cost >= bestCost) return;
      // Measured on the apron itself: on the inside of a bend its front
      // corners reach much farther along the road than the lot's own arc
      // position suggests.
      if (!offStartLine(joinShape([frontOfFit(fit)]))) return;
      bestCost = cost;
      best = fit;
    };
    // Preferred: just behind the line, on the right like the vision.
    for (let s = -8; s >= -24; s -= 1) {
      for (const side of [-1, 1] as const) consider(s, side, 0.03 * Math.abs(s + 11) + (side === 1 ? 0.12 : 0), 0.9);
    }
    if (best) return best;
    // Then within sight of the line either way, with more earthwork allowed.
    for (let a = 8; a <= 28; a += 1) {
      for (const s of [-a, a]) {
        for (const side of [-1, 1] as const) consider(s, side, 0.03 * a + (s > 0 ? 0.15 : 0) + (side === 1 ? 0.12 : 0), MAX_CUT_FILL);
      }
    }
    if (best) return best;
    // Then anywhere in the village, then anywhere on the loop.
    for (let u = 8; u <= len - 8; u += 1.5) {
      for (const side of [-1, 1] as const) consider(vs0 + u, side, 0.02 * Math.abs(frame.delta(-10, vs0 + u)), MAX_CUT_FILL);
    }
    if (best) return best;
    for (let s = 0; s < frame.length; s += 1.5) {
      for (const side of [-1, 1] as const) consider(s, side, 0.01 * Math.abs(frame.delta(-10, s)), MAX_CUT_FILL, true);
    }
    return best;
  };
  const garageFit = findGarage();

  // Collected first, turned into lots in a fixed order below.
  const anchors: { fit: Fit; asset: string; role: LotRole }[] = [];
  if (garageFit) {
    placed.push(garageFit.obb);
    reserveFront(garageFit, GARAGE[0], GARAGE[1]);
    keepClear.push(joinShape([frontOfFit(garageFit)]).polygon);
    anchors.push({ fit: garageFit, asset: 'b07-race-garage', role: 'garage' });
  }

  // --- Village hall + market hall on one square. The hall goes where the
  // road points at it (outside of a bend, end of a straight); the market
  // stands beside it, a little closer to the road.
  const HALL = catalogEntry('b10-village-hall').envelope!;
  const MARKET = catalogEntry('b08-market-hall').envelope!;
  const hallFront = dims.fence + 4.6;
  const marketFront = dims.fence + 3.4;
  let hallFit: Fit | null = null;
  let marketFit: Fit | null = null;
  let sharedSquare = false;
  {
    /** The square in front of these buildings is legal ground. */
    const squareOk = (fits: Fit[]): boolean => {
      const shape = joinShape(fits.map(frontOfFit));
      if (!offStartLine(shape)) return false;
      // Nothing already standing (the garage, its apron) may be on it.
      for (const o of placed) if (!fits.some((f) => f.obb === o) && onPolygon(o, shape.polygon, 0)) return false;
      return true;
    };
    const cands: { fit: Fit; score: number }[] = [];
    const g = garageFit;
    for (let u = 12; u <= len - 12; u += 2.5) {
      for (const side of [1, -1] as const) {
        const fit = fitLot(ctx, vs0 + u, side, hallFront, HALL[0], HALL[1], FLUSH_MODE, placed);
        if (!fit || !offPads(fit.obb) || !squareOk([fit])) continue;
        const vis = visibility(frame, fit.obb.x, fit.obb.z, fit.s);
        const nearGarage = g !== null && g.side === side && Math.abs(frame.delta(g.s, fit.s)) < 34 ? 0.35 : 0;
        const score = 1.3 * vis - 0.45 * Math.max(fit.cut, fit.fill) - 0.5 * Math.abs(u / len - 0.58) - nearGarage;
        cands.push({ fit, score });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.fit.s - b.fit.s);
    // Beside = the two envelopes within a few meters of each other, however
    // far apart that puts them along the centreline (on the outside of a bend
    // it is less arc than on a straight, on the inside more).
    const SQUARE_GAP = 6.5;
    for (const c of cands.slice(0, 40)) {
      const withHall = [...placed, c.fit.obb];
      let bestM: Fit | null = null;
      for (const dir of [1, -1]) {
        for (let off = 7.5; off <= 19 && !bestM; off += 0.75) {
          const fit = fitLot(ctx, c.fit.s + dir * off, c.fit.side, marketFront, MARKET[0], MARKET[1], FLUSH_MODE, withHall);
          if (!fit || Math.abs(fit.target - c.fit.target) > 0.8 || !offPads(fit.obb)) continue;
          const gap = rectGap(fit.obb, c.fit.obb);
          // Farther out the gap only grows: no need to walk on.
          if (gap > SQUARE_GAP) break;
          if (squareOk([c.fit, fit])) bestM = fit;
        }
        if (bestM) break;
      }
      if (bestM) {
        hallFit = c.fit;
        marketFit = bestM;
        sharedSquare = true;
        break;
      }
    }
    // No pair anywhere: seat them separately, each with its own forecourt.
    if (!hallFit && cands.length > 0) hallFit = cands[0].fit;
    if (hallFit && !marketFit) {
      const h: Fit = hallFit;
      const withHall = [...placed, h.obb];
      const hallSquare = joinShape([frontOfFit(h)]).polygon;
      // As near to the hall as the ground allows.
      let bestD = Infinity;
      for (let u = 10; u <= len - 10; u += 2) {
        for (const side of [1, -1] as const) {
          const d = Math.abs(frame.delta(h.s, vs0 + u)) + (side === h.side ? 0 : 12);
          if (d >= bestD) continue;
          const fit = fitLot(ctx, vs0 + u, side, marketFront, MARKET[0], MARKET[1], FLUSH_MODE, withHall);
          if (!fit || !offPads(fit.obb) || onPolygon(fit.obb, hallSquare, 0.6) || !squareOk([fit])) continue;
          // Its own square must not run across the hall either.
          if (onPolygon(h.obb, joinShape([frontOfFit(fit)]).polygon, 0.6)) continue;
          bestD = d;
          marketFit = fit;
        }
      }
    }
  }
  if (hallFit) {
    const h: Fit = hallFit;
    placed.push(h.obb);
    reserveFront(h, HALL[0], HALL[1]);
    anchors.push({ fit: h, asset: 'b10-village-hall', role: 'hall' });
  }
  if (marketFit) {
    const m: Fit = marketFit;
    placed.push(m.obb);
    reserveFront(m, MARKET[0], MARKET[1]);
    anchors.push({ fit: m, asset: 'b08-market-hall', role: 'market' });
  }
  if (hallFit && marketFit && sharedSquare) keepClear.push(joinShape([frontOfFit(hallFit), frontOfFit(marketFit)]).polygon);
  else {
    if (hallFit) keepClear.push(joinShape([frontOfFit(hallFit)]).polygon);
    if (marketFit) keepClear.push(joinShape([frontOfFit(marketFit)]).polygon);
  }

  // --- Water tower: second row, behind where the houses will stand, close
  // to the hall and where the approach looks at it. May sit on a rise.
  const TOWER = catalogEntry('b09-water-tower').envelope!;
  let towerFit: Fit | null = null;
  {
    let bestScore = -Infinity;
    const h: Fit | null = hallFit;
    for (const front of [dims.fence + 14, dims.fence + 18]) {
      for (let u = 6; u <= len - 6; u += 3) {
        for (const side of [1, -1] as const) {
          const fit = fitLot(ctx, vs0 + u, side, front, TOWER[0], TOWER[1], { flush: false, lift: [-0.3, 1.6] }, placed);
          if (!fit || !offPads(fit.obb)) continue;
          const vis = visibility(frame, fit.obb.x, fit.obb.z, fit.s);
          const toHall = h ? Math.hypot(fit.obb.x - h.obb.x, fit.obb.z - h.obb.z) : 0;
          const score = vis + 0.12 * (fit.target - fit.roadH) - 0.012 * toHall - 0.3 * Math.max(fit.cut, fit.fill);
          if (score > bestScore) {
            bestScore = score;
            towerFit = fit;
          }
        }
      }
    }
    if (towerFit) {
      placed.push(towerFit.obb);
      anchors.push({ fit: towerFit, asset: 'b09-water-tower', role: 'tower' });
    }
  }

  // --- Street slots: one generic slot size, so any house or shack fits any
  // slot and the "every building appears" guarantee is a matter of dealing
  // the right cards, not of finding special ground.
  const targetTotal = clamp(Math.round(len / 8), 14, 17);
  const fillTarget = targetTotal - anchors.length;
  const freeFrontage = 2 * len - 54;
  const gapBase = clamp(freeFrontage / fillTarget - SLOT_W, LOT_GAP, 14);
  const slots: Slot[] = [];
  const walk = (gap: number, jitter: boolean, slotW: number, back = 0): void => {
    for (const side of [-1, 1] as const) {
      let u = 4 + slotW / 2 + (jitter ? rand.range(0, 6) : 0);
      while (u < len - 4 - slotW / 2) {
        const yard = back > 0 ? back : jitter ? rand.range(1.6, 4.4) : 2.6;
        const fit = fitLot(ctx, vs0 + u, side, dims.fence + yard, slotW, SLOT_D, back > 0 ? FREE_MODE : yardMode(yard, 'village'), placed);
        // The lot's road point must lie inside the village so its gate
        // lands in the village fence; its gate and path must be usable.
        if (fit && uOf(fit.s) <= len && offPads(fit.obb) && (back > 0 || pathClear(fit))) {
          const uu = uOf(fit.s);
          slots.push({ fit, u: uu, side, fringe: uu < len * 0.2 || uu > len * 0.8, narrow: slotW < SLOT_W, back: back > 0, asset: '', role: 'house' });
          placed.push(fit.obb);
          u += slotW + gap * (jitter ? rand.pick([0.4, 0.75, 1, 1.25, 1.6]) : 1);
        } else {
          u += 1.5;
        }
      }
    }
  };
  walk(gapBase, true, SLOT_W);
  // Short of the target (a tight loop leaves little room on its inside):
  // a second, close-packed pass takes whatever gaps are left, and a third
  // squeezes shack-wide slots into what remains.
  if (slots.length < fillTarget) walk(LOT_GAP, false, SLOT_W);
  if (slots.length < fillTarget) walk(LOT_GAP, false, SHACK_W);
  // Still under a dozen buildings (steep or pinched ground along the
  // street): a back row behind the front lots gives the village its depth.
  for (const [yard, w] of [
    [12.5, SLOT_W],
    [12.5, SHACK_W],
    [17, SLOT_W],
  ]) {
    if (anchors.length + slots.length < 12) walk(LOT_GAP + 2, false, w, yard);
  }
  // Still short (seeds 526 and 760: a steep street where most slots need
  // more than MAX_CUT_FILL, or one crowded by the anchors; 621: hall and
  // market went out of town): other back-row depths, packed closer. These
  // passes run only below a dozen, so every other village is untouched.
  for (const yard of [9, 15, 20, 22]) {
    for (const w of [SHACK_W, SLOT_W]) {
      if (anchors.length + slots.length < 12) walk(LOT_GAP, false, w, yard);
    }
  }
  // Too many: drop the ones that need the most earthwork.
  while (slots.length > fillTarget) {
    let worst = 0;
    for (let i = 1; i < slots.length; i++) {
      const a = Math.max(slots[i].fit.cut, slots[i].fit.fill);
      const b = Math.max(slots[worst].fit.cut, slots[worst].fit.fill);
      if (a > b) worst = i;
    }
    placed.splice(placed.indexOf(slots[worst].fit.obb), 1);
    slots.splice(worst, 1);
  }

  // Deal buildings: shacks on the fringe, houses in the core, at least one
  // of each when there are six slots; whatever does not get a slot is
  // handed to the outlying lots below.
  const SHACKS = ['b01-sunshack', 'b02-workshop-shed', 'b03-stilt-hut'];
  const HOUSES = ['b04-gable-cottage', 'b05-terrace-house', 'b06-corner-house'];
  slots.sort((a, b) => a.u - b.u || a.side - b.side);
  {
    const order = slots.map((_, i) => i);
    // Fringe-most first for shacks.
    const byFringe = order.slice().sort((a, b) => Math.abs(slots[b].u / len - 0.5) - Math.abs(slots[a].u / len - 0.5) || a - b);
    const shackSlots = slots.filter((sl) => sl.fringe).length;
    const wantShacks = clamp(shackSlots, Math.min(3, Math.floor(slots.length / 2)), Math.max(3, Math.round(slots.length * 0.42)));
    const isShack = new Set<number>(order.filter((i) => slots[i].narrow));
    for (const i of byFringe) {
      if (isShack.size >= wantShacks) break;
      isShack.add(i);
    }
    const shackDeck = rand.shuffle(SHACKS);
    // Corner houses are tall: sparingly, at most two, and next to the
    // tightest part of the street where they mark the corner.
    const houseIdx = order.filter((i) => !isShack.has(i));
    const cornerRank = houseIdx
      .slice()
      .sort((a, b) => Math.abs(frame.at(slots[b].fit.s).k) - Math.abs(frame.at(slots[a].fit.s).k) || a - b);
    const corner = new Set<number>(cornerRank.slice(0, houseIdx.length >= 6 ? 2 : houseIdx.length >= 3 ? 1 : 0));
    const plain = rand.chance(0.5) ? ['b04-gable-cottage', 'b05-terrace-house'] : ['b05-terrace-house', 'b04-gable-cottage'];
    let ks = 0;
    let kh = 0;
    for (const i of order) {
      if (isShack.has(i)) {
        slots[i].asset = shackDeck[ks++ % shackDeck.length];
        slots[i].role = 'shack';
      } else if (corner.has(i)) {
        slots[i].asset = 'b06-corner-house';
      } else {
        slots[i].asset = plain[kh++ % 2];
      }
    }
  }

  // Lots in a stable order: anchors, then the street from its start.
  for (const a of anchors) addLot(a.fit, a.asset, a.role, 'village', { fenced: false });
  for (const sl of slots) addLot(sl.fit, sl.asset, sl.role, 'village', { fenced: !sl.back, slotDepth: SLOT_D });
  const lotOf = (role: LotRole): number => lots.find((l) => l.role === role)?.id ?? -1;

  // --- Outlying lots around the rest of the loop. Buildings the village
  // had no slot for go first, so all ten always exist.
  const present = new Set(lots.map((l) => l.asset));
  const missing = [...SHACKS, ...HOUSES, 'b07-race-garage', 'b08-market-hall', 'b09-water-tower', 'b10-village-hall'].filter((id) => !present.has(id));
  const rest = frame.length - len;
  const wantOut = clamp(Math.max(3 + rand.int(0, 2), missing.length), 3, Math.max(3, Math.min(6, Math.floor(rest / 14))));
  const outDeck = [...missing, ...rand.shuffle(['b03-stilt-hut', 'b01-sunshack', 'b04-gable-cottage', 'b02-workshop-shed', 'b01-sunshack', 'b03-stilt-hut'])];
  const outFits: Fit[] = [];
  const tryOutlier = (sMid: number, window: number, asset: string): boolean => {
    const [w, d] = catalogEntry(asset).envelope!;
    const role = roleOf(asset);
    const fenced = role === 'house' || role === 'shack';
    let best: Fit | null = null;
    let bestCost = Infinity;
    for (let ds = -window; ds <= window; ds += 2) {
      const s = sMid + ds;
      // Stay clear of the village ends so the lot reads as "out of town".
      const u = uOf(s);
      if (u < len + 8 || u > frame.length - 8) continue;
      for (const side of [-1, 1] as const) {
        for (const yard of [5.5, 8.5, 12]) {
          const fit = fitLot(ctx, s, side, dims.fenceOut + yard, w, d, fenced ? yardMode(yard, 'outlying') : FREE_MODE, placed);
          if (!fit || !offPads(fit.obb) || (fenced && !pathClear(fit))) continue;
          // Inside of a bend: keep the sight line open, prefer the outside.
          const k = frame.at(fit.s).k;
          const inside = k * side > 0 ? smoothstep(1 / 30, 1 / 10, Math.abs(k)) : 0;
          const cost = Math.max(fit.cut, fit.fill) + 0.8 * inside + 0.02 * yard + 0.01 * Math.abs(ds);
          if (cost < bestCost) {
            bestCost = cost;
            best = fit;
          }
        }
      }
    }
    if (!best) return false;
    outFits.push(best);
    addLot(best, asset, role, 'outlying', { fenced });
    return true;
  };
  {
    let k = 0;
    for (let i = 0; i < wantOut; i++) {
      const sMid = vs0 + len + ((i + 0.5) * rest) / wantOut;
      if (tryOutlier(sMid, rest / wantOut / 2, outDeck[k % outDeck.length])) k++;
    }
    // Fewer than three (or a must-have still unplaced): sweep the whole
    // countryside for any spot that works.
    for (let s = vs0 + len + 10; s < vs0 + frame.length - 10 && (outFits.length < 3 || k < missing.length); s += 6) {
      if (tryOutlier(s, 3, outDeck[k % outDeck.length])) k++;
    }
  }

  // ---------------------------------------------------------------------
  // Terrain modifiers, pads, openings, retaining walls.

  // Outside of every signed bend: a level run-off strip. A car that runs
  // wide gets flat ground before the boards and tire stacks, and those
  // stand upright instead of on the carve's bank. First in the list, so
  // the village verge and every pad applied later override it.
  for (const bend of ctx.bends) {
    modifiers.push({
      kind: 'corridor',
      s0: r3(frame.wrap(bend.s0 - 6)),
      s1: r3(frame.wrap(bend.s1 + 3)),
      side: bend.direction === 'left' ? -1 : 1,
      outer: r3(dims.edgeDressed + dims.runoff + 1.2),
      falloff: 3.5,
      taper: 5,
      limit: VERGE_EARTHWORK,
    });
  }

  // Village verge: level from the kerb to just behind the fence line so
  // fence, lamps and gates stand on ground that follows the road.
  // It starts and ends VERGE_LEAD outside the village and fades in over
  // that distance, so it is at full strength under the first and the last
  // fence segment.
  const VERGE_LEAD = 8;
  // Along the start straight the fence is set back for the banners and the
  // start flags stand behind it (dressing): the level verge is as much
  // wider there, so flags and fence stand on ground that follows the road.
  // Full width over the window the set-back runs reach into, fading in over
  // 4 m either end. Where the village verge covers that window (every seed
  // 1–1100: the village starts at least 24 m before the line and runs on
  // past s = 86) it is the verge's OWN band that widens: a second corridor
  // on top would blend the same skirt twice, and the bank behind the fence
  // came out steep enough for the splat to paint a rock stripe along it.
  const bannerLead = 3 + 4;
  const bannerA = BANNER_S0 - bannerLead;
  const bannerB = BANNER_S1 + bannerLead;
  const bannerInVerge = frame.delta(vs0, bannerA) >= -VERGE_LEAD / 2 && frame.delta(bannerB, vs0 + len) >= -VERGE_LEAD / 2;
  modifiers.push({
    kind: 'corridor',
    s0: r3(frame.wrap(vs0 - VERGE_LEAD)),
    s1: r3(frame.wrap(vs0 + len + VERGE_LEAD)),
    side: 0,
    outer: r3(dims.fence + 0.9),
    // A long skirt: where the village meets a hillside the bank must stay
    // a grassy slope, not turn into a cliff behind the fence.
    falloff: 5,
    taper: VERGE_LEAD,
    ...(bannerInVerge ? { widen: { s0: r3(frame.wrap(bannerA)), s1: r3(frame.wrap(bannerB)), by: BANNER_FENCE_SETBACK, taper: 4 } } : {}),
  });
  // Otherwise (the start line near a village end): a corridor of its own
  // over the window, as wide as the widened verge.
  if (!bannerInVerge) {
    const lead = bannerLead;
    modifiers.push({
      kind: 'corridor',
      s0: r3(frame.wrap(BANNER_S0 - lead)),
      s1: r3(frame.wrap(BANNER_S1 + lead)),
      side: 0,
      outer: r3(Math.max(dims.fence, dims.fenceOut) + BANNER_FENCE_SETBACK + 0.9),
      falloff: 4,
      taper: 4,
      limit: VERGE_EARTHWORK,
    });
  }
  // The same for the short fence in front of each outlying lot.
  for (const lot of lots) {
    if (lot.zone !== 'outlying' || !lot.entrance) continue;
    modifiers.push({
      kind: 'corridor',
      s0: r3(frame.wrap(lot.s - OUTLYING_FENCE_REACH - 3)),
      s1: r3(frame.wrap(lot.s + OUTLYING_FENCE_REACH + 3)),
      side: lot.side,
      outer: r3(dims.fenceOut + 0.9),
      falloff: 4,
      taper: 4,
      limit: VERGE_EARTHWORK,
    });
  }

  const local = (lot: Lot, lx: number, lz: number): Vec2 => round2(toWorld(lot.x, lot.z, lot.yaw, lx, lz));

  const joinPad = (group: Lot[], surface: 'asphalt' | 'cobble', role: 'apron' | 'square', markings: PadMarking[]): void => {
    const shape = joinShape(group);
    const first = group.reduce((a, b) => (frame.delta(group[0].s, b.s) < frame.delta(group[0].s, a.s) ? b : a));
    pads.push({ surface, role, polygon: shape.polygon, y: r3(frame.at(first.s).h), lot: first.id, joinsRoad: true, markings });
    openings.push({ side: shape.side, s0: r3(frame.wrap(shape.sA - 0.4)), s1: r3(frame.wrap(shape.sB + 0.4)), kind: 'pad', pad: role });
    modifiers.push({
      kind: 'corridor',
      s0: r3(frame.wrap(shape.sA - 1)),
      s1: r3(frame.wrap(shape.sB + 1)),
      side: shape.side,
      outer: r3(Math.max(...group.map((l) => l.setback)) + 0.4),
      falloff: 3.5,
      taper: 3,
    });
  };

  const garage = lots.find((l) => l.role === 'garage');
  if (garage) {
    // Two bays in front of the two doors: a U of yellow line each, open
    // toward its door, as painted on the vision's apron.
    const markings: PadMarking[] = [];
    for (const cx of [-2.25, 2.25]) {
      const z0 = -garage.halfZ - 0.7;
      const z1 = -garage.halfZ - 5.0;
      markings.push({ a: local(garage, cx - 1.75, z0), b: local(garage, cx - 1.75, z1), width: 0.14, color: 'yellow' });
      markings.push({ a: local(garage, cx + 1.75, z0), b: local(garage, cx + 1.75, z1), width: 0.14, color: 'yellow' });
      markings.push({ a: local(garage, cx - 1.75, z1), b: local(garage, cx + 1.75, z1), width: 0.14, color: 'yellow' });
    }
    joinPad([garage], 'asphalt', 'apron', markings);
  }
  const hall = lots.find((l) => l.role === 'hall');
  const market = lots.find((l) => l.role === 'market');
  if (hall && market && sharedSquare) joinPad([hall, market], 'cobble', 'square', []);
  else {
    if (hall) joinPad([hall], 'cobble', 'square', []);
    if (market) joinPad([market], 'cobble', 'square', []);
  }

  for (const lot of lots) {
    const fenceLine = lot.zone === 'village' ? dims.fence : dims.fenceOut;
    const edge = lot.zone === 'village' ? dims.edgeDressed : dims.edgeRough;
    const dist = lot.setback + lot.halfZ;

    // Uphill edges get a retaining wall and a short, steep blend behind it;
    // open edges ease back into the hillside.
    const hx = lot.halfX + PAD_MARGIN;
    const hz = lot.halfZ + PAD_MARGIN;
    const rise = (ax: number, az: number, bx: number, bz: number): number => {
      let sum = 0;
      for (let i = 0; i <= 4; i++) {
        const [wx, wz] = toWorld(lot.x, lot.z, lot.yaw, ax + ((bx - ax) * i) / 4, az + ((bz - az) * i) / 4);
        sum += base.getHeight(wx, wz) - lot.y;
      }
      return sum / 5;
    };
    const OUT = 1.6;
    // A fenced lot's front blend ends behind the fence line (the verge in
    // front of it is levelled to the road); a lot on a pad that joins the
    // road is level with it anyway and may blend right up to the road edge.
    // On the start straight the fence in front of the lot stands
    // BANNER_FENCE_SETBACK farther back (dressing): the blend ends as much
    // farther back, so the fence keeps level ground under it and the start
    // flags behind it stand where they stood before the setback.
    const setBack = lot.entrance ? startSetback(lot.s, lot.halfX) : 0;
    const front = lot.entrance ? frontSkirt(lot.setback - fenceLine - setBack, lot.zone) : clamp(lot.setback - PAD_MARGIN - dims.hw - 0.3, 1, 2.6);
    const falloff: PadFalloff = { front, back: 2.8, left: 2.8, right: 2.8 };
    // A blend skirt must end before the neighbour's building, or the pad
    // applied second would tilt the first one's floor.
    for (const other of lots) {
      if (other === lot) continue;
      for (const [ox, oz] of [...obbCorners({ x: other.x, z: other.z, yaw: other.yaw, hx: other.halfX, hz: other.halfZ }), [other.x, other.z] as Vec2]) {
        const [lx, lz] = toLocal(lot.x, lot.z, lot.yaw, ox, oz);
        const dx = Math.abs(lx) - hx;
        const dz = Math.abs(lz) - hz;
        // The corner lies off one edge: that edge's skirt is the one to shorten.
        if (dx > 0 && dx >= dz && dz < 3) {
          if (lx > 0) falloff.right = clamp(dx - 0.15, 0.6, falloff.right);
          else falloff.left = clamp(dx - 0.15, 0.6, falloff.left);
        } else if (dz > 0 && dx < 3) {
          if (lz > 0) falloff.back = clamp(dz - 0.15, 0.6, falloff.back);
          else falloff.front = clamp(dz - 0.15, 0.6, falloff.front);
        }
      }
    }
    const WALL_RISE = 0.55;
    /** Wall segments centred on the edge a → b (lot-local), their face
     * (local −z of the segment) looking along (faceX, faceZ) into the lot. */
    const wallRun = (ax: number, az: number, bx: number, bz: number, faceX: number, faceZ: number): void => {
      const length = Math.hypot(bx - ax, bz - az);
      const count = Math.max(1, Math.round(length / WALL_PITCH));
      const [fwx, fwz] = toWorld(0, 0, lot.yaw, faceX, faceZ);
      const yaw = yawFacing(fwx, fwz);
      for (let i = 0; i < count; i++) {
        const along = ((i - (count - 1) / 2) * WALL_PITCH) / length;
        const [wx, wz] = toWorld(lot.x, lot.z, lot.yaw, (ax + bx) / 2 + (bx - ax) * along, (az + bz) / 2 + (bz - az) * along);
        // A segment that would poke into the run-off is left out.
        if (frame.fastDist(wx, wz) < edge + dims.runoff + 1.6) continue;
        walls.push({ x: r3(wx), z: r3(wz), yaw: r3(yaw), lot: lot.id });
      }
    };
    if (rise(-hx, hz + OUT, hx, hz + OUT) > WALL_RISE) {
      falloff.back = Math.min(falloff.back, 1.3);
      wallRun(-hx, hz + 0.3, hx, hz + 0.3, 0, -1);
    }
    if (rise(-hx - OUT, -hz * 0.4, -hx - OUT, hz) > WALL_RISE) {
      falloff.left = Math.min(falloff.left, 1.3);
      wallRun(-hx - 0.3, -hz * 0.2, -hx - 0.3, hz, 1, 0);
    }
    if (rise(hx + OUT, -hz * 0.4, hx + OUT, hz) > WALL_RISE) {
      falloff.right = Math.min(falloff.right, 1.3);
      wallRun(hx + 0.3, -hz * 0.2, hx + 0.3, hz, -1, 0);
    }
    modifiers.push({
      kind: 'flatten',
      x: lot.x,
      z: lot.z,
      yaw: lot.yaw,
      halfX: r3(hx),
      halfZ: r3(hz),
      height: lot.y,
      falloff,
      lot: lot.id,
    });

    if (lot.entrance) {
      // Stone-paver landing across the front, and a path from it through
      // the gate to the verge. Outlying lots have no kerb to stop at, so
      // their path runs on to the road edge.
      const landingW = Math.min(lot.bodyHalfX * 1.5, 3.8);
      pads.push({
        surface: 'paver',
        role: 'forecourt',
        polygon: [local(lot, -landingW / 2, -lot.halfZ + 0.2), local(lot, landingW / 2, -lot.halfZ + 0.2), local(lot, landingW / 2, -lot.halfZ - 1.3), local(lot, -landingW / 2, -lot.halfZ - 1.3)],
        y: lot.y,
        lot: lot.id,
        joinsRoad: false,
        markings: [],
      });
      const reach = lot.zone === 'village' ? dist - fenceLine + 0.5 : dist - edge - 0.1;
      pads.push({
        surface: 'paver',
        role: 'path',
        polygon: [local(lot, -0.7, -lot.halfZ - 1.2), local(lot, 0.7, -lot.halfZ - 1.2), local(lot, 0.7, -reach), local(lot, -0.7, -reach)],
        y: lot.y,
        lot: lot.id,
        joinsRoad: false,
        markings: [],
      });
      // The gate is GATE_HALF wide either side of the path AT THE FENCE
      // LINE. That line is shorter than the centreline on the inside of a
      // bend and longer on the outside, so the opening is sized in arc
      // length to come out right where the fence actually runs.
      const lineScale = 1 - frame.at(lot.s).k * lot.side * fenceLine;
      const half = clamp(GATE_HALF / Math.max(lineScale, 0.3), 0.7, 3.4);
      openings.push({ side: lot.side, s0: r3(frame.wrap(lot.s - half)), s1: r3(frame.wrap(lot.s + half)), kind: 'gate' });
    }
  }

  let cx = 0;
  let cz = 0;
  const vl = lots.filter((l) => l.zone === 'village');
  for (const l of vl) {
    cx += l.x / vl.length;
    cz += l.z / vl.length;
  }
  let radius = 0;
  for (const l of vl) radius = Math.max(radius, Math.hypot(l.x - cx, l.z - cz) + 6);

  return {
    village: {
      s0: r3(frame.wrap(vs0)),
      s1: r3(frame.wrap(vs0 + len)),
      length: r3(len),
      center: [r3(cx), r3(cz)],
      radius: r3(radius),
      garageLot: lotOf('garage'),
      hallLot: lotOf('hall'),
      marketLot: lotOf('market'),
      towerLot: lotOf('tower'),
      score: r3(stretch.score),
    },
    lots,
    modifiers,
    pads,
    openings,
    walls,
  };
}

function roleOf(asset: string): LotRole {
  switch (asset) {
    case 'b07-race-garage':
      return 'garage';
    case 'b08-market-hall':
      return 'market';
    case 'b09-water-tower':
      return 'tower';
    case 'b10-village-hall':
      return 'hall';
    case 'b04-gable-cottage':
    case 'b05-terrace-house':
    case 'b06-corner-house':
      return 'house';
    default:
      return 'shack';
  }
}
