import type { Heightfield } from '../terrain/Heightfield';
import { BANNER_STAKE_HALF, BANNER_STAKE_RADIUS, BANNER_STAKE_X, FENCE_PITCH, GANTRY_HALF_OPENING, GANTRY_PYLON_RADIUS, GARAGE_BAY_WIDTH, GARAGE_BAY_X, KERB_MARKER_PITCH, catalogEntry } from './catalog';
import { clamp, panelOverlap, pointInPolygon, r3, toLocal, toWorld, yawFacing } from './geom';
import { BUILT, Occupancy, TAG } from './occupancy';
import { hashSeed, rng } from './rng';
import type { Rng } from './rng';
import type { TrackFrame } from './trackFrame';
import type { Bend, Lot, Placement, Vec2 } from './types';
import { BANNER_FENCE_SETBACK, BANNER_S0, BANNER_S1, OUTLYING_FENCE_REACH } from './village';
import type { Opening, PlanContext, VillageResult } from './village';

/**
 * Track and village dressing: start gantry and flags, chevron boards and
 * tire stacks on the bends, the village fence with its gates, street lamps,
 * apex kerb markers, and the small things composed around each building.
 *
 * Orientation: every dressing asset shows its FRONT to local −z, so a
 * placement is "faced" at what should see it (the road for fences, lamps and
 * benches; oncoming cars for chevrons, signposts and the gantry).
 */

/**
 * Street furniture that is ONE design per world: a village has one kind of
 * lamp and bench, a track one kind of chevron board, bollard and marker. The
 * variant is picked per world seed instead of per instance — it reads as a
 * place that was furnished on purpose, and it is one draw call per asset
 * (and scheme) instead of up to four for a handful of instances each.
 */
const UNIFORM = new Set(['d02-chevron-sign', 'd03-flag-pole', 'd05-bollard', 'd06-kerb-marker', 'd08-street-lamp', 'd13-bench', 'd14-signpost']);

/** Clearance kept between a banner stake and any fence segment's box.
 * (The banner window and the fence setback that makes room for it:
 * BANNER_S0 / BANNER_S1 / BANNER_FENCE_SETBACK in village.ts, which also
 * widens the level verge there.) */
const BANNER_FENCE_GAP = 0.15;
/** Half depth of a fence segment's box. */
const FENCE_HALF_DEPTH = catalogEntry('d07-wood-fence').size[2] / 2;
/** Two fence segments closer than this, centre to centre, are one laid over
 * the other (an outlying lot's run on top of the village run): the later
 * one is left out. Neighbours in a run are a pitch (≥ 2.16 m) apart. */
const FENCE_MIN_SPACING = 1.2;
/** Nor may a panel lie more than this far along on another one standing
 * within FENCE_OVERLAP_ACROSS of its line (the self-check allows 0.2 m
 * within 0.4 m; neighbours in a run overlap by millimetres). */
const FENCE_MAX_OVERLAP = 0.15;
const FENCE_OVERLAP_ACROSS = 0.45;
/** An apron-edge bollard beside a set-back fence run stands at least this
 * far behind the run's line (from the centreline: the line + this), as the
 * outermost one does beside an ordinary run (0.45 m). */
const BOLLARD_FENCE_CLEAR = 0.4;
/** Outer edge of the garage's bay openings, local x. */
const GARAGE_BAY_OUTER = GARAGE_BAY_X + GARAGE_BAY_WIDTH / 2;
/** A tool chest keeps this clear of either bay opening (along the front),
 * a hair over the self-check's 0.3 m. */
const CHEST_BAY_GAP = 0.32;

/** Chord of an offset curve: one fence segment, one kerb block. */
interface Chord {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Arc length of the centreline under the chord's middle. */
  s: number;
}

/**
 * Walk the curve `lateral` meters left of the centreline from s0 over
 * `span` meters of road, in straight chords of exactly `pitch`. Segments
 * that tile (fence, kerb blocks) then meet end to end on any curve.
 */
function walkChords(frame: TrackFrame, s0: number, span: number, lateral: number, pitch: number): { chords: Chord[]; used: number } {
  const chords: Chord[] = [];
  const STEP = 0.2;
  let u = 0;
  let [ax, az] = frame.offset(s0, lateral);
  for (;;) {
    let v = u;
    let prevD = 0;
    let found = false;
    let bx = ax;
    let bz = az;
    while (v < span) {
      const next = Math.min(v + STEP, span);
      [bx, bz] = frame.offset(s0 + next, lateral);
      const d = Math.hypot(bx - ax, bz - az);
      if (d >= pitch) {
        const t = (pitch - prevD) / (d - prevD || 1);
        v = v + (next - v) * t;
        [bx, bz] = frame.offset(s0 + v, lateral);
        found = true;
        break;
      }
      // Inside a hairpin the offset curve folds back on itself and the
      // chord never reaches the pitch: give up on this run.
      if (next - u > pitch * 5) break;
      prevD = d;
      v = next;
    }
    if (!found) break;
    chords.push({ ax, az, bx, bz, s: s0 + (u + v) / 2 });
    u = v;
    ax = bx;
    az = bz;
  }
  return { chords, used: u };
}

export interface DressingResult {
  placements: Placement[];
  /** Fence segment centres, for the planting that follows the fence. */
  fences: { x: number; z: number; yaw: number; side: 1 | -1 }[];
}

export function planDressing(
  ctx: PlanContext,
  ground: Heightfield,
  v: VillageResult,
  bends: readonly Bend[],
  occ: Occupancy,
  rand: Rng,
  windYaw: number,
): DressingResult {
  const { frame, dims } = ctx;
  const out: Placement[] = [];
  const vs0 = v.village.s0;
  const vlen = v.village.length;
  const inVillage = (s: number): boolean => frame.wrap(s - vs0) <= vlen;
  /** Outer kerb edge around arc length s: the wider village kerb as soon as
   * the village is within `reach`, so nothing placed near its ends is
   * measured against the narrow kerb while standing beside the wide one. */
  const edgeAt = (s: number, reach = 4): number => (inVillage(s) || inVillage(s - reach) || inVillage(s + reach) ? dims.edgeDressed : dims.edgeRough);

  /** True if s lies within `margin` of an opening on that side that `match` accepts. */
  const isOpen = (side: 1 | -1, s: number, margin: number, match: (o: Opening) => boolean = () => true): boolean => {
    for (const o of v.openings) {
      if (o.side !== side || !match(o)) continue;
      const span = frame.wrap(o.s1 - o.s0);
      const d = frame.wrap(s - (o.s0 - margin));
      if (d <= span + 2 * margin) return true;
    }
    return false;
  };
  const isGate = (o: Opening): boolean => o.kind === 'gate';
  const isPad = (o: Opening): boolean => o.kind === 'pad';

  interface PutOptions {
    scheme?: string;
    lot?: number;
    /** Circles registered along local x for long, thin things. */
    long?: boolean;
    /** Do not register as an obstacle (flat things a car may run over). */
    ghost?: boolean;
    y?: number;
    seed?: number;
    scale?: number;
    tag?: number;
  }
  const put = (asset: string, x: number, z: number, yaw: number, role: string, o: PutOptions = {}): void => {
    const e = catalogEntry(asset);
    const h = hashSeed(ctx.seed, asset, Math.round(x * 20), Math.round(z * 20));
    const b = 0.96 + 0.08 * ((h >>> 8) & 0xff) / 255;
    const w = 0.03 * (((h >>> 16) & 0xff) / 255 - 0.5);
    const p: Placement = {
      asset,
      seed: o.seed ?? (UNIFORM.has(asset) ? hashSeed(ctx.seed, asset) : h) % e.variants,
      x: r3(x),
      y: r3(o.y ?? ground.getHeight(x, z)),
      z: r3(z),
      yaw: r3(yaw),
      scale: r3(o.scale ?? 1),
      tint: [r3(b * (1 + w)), r3(b), r3(b * (1 - w))],
      role,
    };
    if (o.scheme) p.scheme = o.scheme;
    if (o.lot !== undefined) p.lot = o.lot;
    out.push(p);
    if (o.ghost) return;
    if (o.long) {
      // (Catalog length, not the scaled one: the discs are a coarse stand-in
      // across the panel, and reaching a stretched panel's end with them
      // refuses gate planters that clear the real box. What must keep clear
      // of a run's end post tests that itself: the apron bollards.)
      const half = e.size[0] / 2;
      const r = Math.max(0.3, e.size[2] / 2 + 0.1);
      const n = Math.max(2, Math.ceil(e.size[0] / (2 * r)));
      for (let i = 0; i < n; i++) {
        const lx = -half + r + ((2 * half - 2 * r) * i) / (n - 1);
        const [wx, wz] = toWorld(x, z, yaw, lx, 0);
        occ.solids.add(wx, wz, r, o.tag ?? TAG.dressing);
      }
    } else {
      occ.solids.add(x, z, e.spreadRadius, o.tag ?? TAG.dressing);
    }
  };
  /** True if a disc of radius r at the point is free of solids, lots and reserved ground. */
  const free = (x: number, z: number, r: number, gap = 0.1): boolean =>
    !occ.solids.hits(x, z, r, gap, BUILT | TAG.reserved) && occ.lotDistance(x, z) > r * 0.5;
  /** Direction from a point toward its nearest road point. */
  const towardRoad = (x: number, z: number, s: number): Vec2 => {
    const p = frame.at(s);
    const dx = p.x - x;
    const dz = p.z - z;
    const d = Math.hypot(dx, dz) || 1;
    return [dx / d, dz / d];
  };
  /** The two variant seeds an asset may use in this world (an instance
   * takes one of them): enough to break up repetition, at most two draw
   * calls. */
  const seedPair = (asset: string): [number, number] => {
    const nv = catalogEntry(asset).variants;
    const a = hashSeed(ctx.seed, asset, 'pair') % nv;
    return [a, nv > 1 ? (a + 1 + (hashSeed(ctx.seed, asset, 'pair', 2) % (nv - 1))) % nv : a];
  };
  const flagYaw = (x: number, z: number): number => {
    const j = (((hashSeed(ctx.seed, 'flag', Math.round(x), Math.round(z)) & 0xff) / 255) - 0.5) * 0.3;
    // The cloth flies toward local +x: lay +x along the wind.
    return Math.atan2(-Math.cos(windYaw + j), Math.sin(windYaw + j));
  };

  // Gates and door paths stay clear of everything placed from here on.
  for (const lot of v.lots) {
    if (!lot.entrance) continue;
    const dist = lot.setback + lot.halfZ;
    const steps = Math.ceil((dist - lot.halfZ) / 1.2);
    for (let i = 0; i <= steps; i++) {
      const t = lot.halfZ + ((dist - lot.halfZ - dims.hw) * i) / steps;
      const [wx, wz] = toWorld(lot.x, lot.z, lot.yaw, 0, -t);
      occ.solids.add(wx, wz, 0.85, TAG.reserved);
    }
  }

  // --- Start gantry across the road at the start line (where it fits: see
  // planStartMarker), flags beside it.
  if (ctx.start.kind === 'gantry') {
    const p = frame.at(0);
    put('d01-start-gantry', p.x, p.z, ctx.start.yaw, 'start-gantry', { ghost: true, y: p.h, seed: ctx.seed % catalogEntry('d01-start-gantry').variants });
    for (const [gx, gz] of ctx.start.pylons) occ.solids.add(gx, gz, GANTRY_PYLON_RADIUS + 0.2, TAG.dressing);
  }

  // --- Chevron boards: outside of every signed bend, 2–4 per bend, turned
  // a little toward the cars that arrive.
  const CHEVRON_HALF = catalogEntry('d02-chevron-sign').size[0] / 2;
  for (const bend of bends) {
    const dir = bend.direction === 'left' ? 1 : -1;
    const outside = (dir === 1 ? -1 : 1) as 1 | -1;
    const span = frame.wrap(bend.s1 - bend.s0);
    const kMean = bend.angle / Math.max(span, 1);
    // Twist toward the approach: more on shallow bends, where a board lying
    // along the edge would be seen almost edge-on.
    // (Never under 15°: on a hairpin the polyline's tangent is only good to
    // a few degrees, and the board must still clearly face the traffic.)
    // On a hairpin the floor is higher still: the road's direction there
    // changes by 10° and more from one track point to the next, and a board
    // set from one tangent must face the traffic by any of them.
    const twist = clamp(0.5 - bend.angle * 0.25, bend.minRadius < 8 ? 0.4 : 0.26, 0.44);
    const lat = dims.runoff + 0.3 + CHEVRON_HALF * Math.sin(twist);
    const outerArc = span * (1 + kMean * (dims.hw + lat));
    let want = clamp(Math.round(bend.angle / 0.45), 2, 4);
    want = Math.min(want, Math.max(2, Math.floor(outerArc / 3.5)));
    // Every spot a board could stand on, half a meter apart, from the
    // approach (a board before the entry still faces the cars and warns
    // them) to a little past the exit.
    const spots: { u: number; x: number; z: number; yaw: number }[] = [];
    for (let u = -5; u <= span + 1.5; u += 0.5) {
      const s = bend.s0 + u;
      const p = frame.at(s);
      // The road must not turn the OTHER way right here, or the board would
      // stand on the inside of a neighbouring opposite bend.
      if (p.k * dir < -0.012) continue;
      const d = edgeAt(s) + lat;
      const x = p.x - p.tz * outside * d;
      const z = p.z + p.tx * outside * d;
      // Gates and the garage apron stay open; a board may stand on the road
      // edge of a square (as in the vision, where they front the houses).
      if (isOpen(outside, s, 0.2, (o) => o.pad === 'apron')) continue;
      if (frame.fastDist(x, z) < d - 0.1 || occ.lotDistance(x, z) < 0.8) continue;
      // Beside a hairpin another piece of road can be the nearer one; the
      // board must belong to THIS stretch.
      const hit = frame.nearest(x, z);
      if (Math.abs(frame.delta(s, hit.s)) > 2.5) continue;
      // Front = toward the road (straight at its nearest point), rotated by
      // `twist` against the direction of travel to meet the traffic.
      const q = frame.at(hit.s);
      const nx = (q.x - x) / hit.dist;
      const nz = (q.z - z) / hit.dist;
      const c = Math.cos(twist);
      const sn = Math.sin(twist);
      const yaw = yawFacing(nx * c - q.tx * sn, nz * c - q.tz * sn);
      // The board itself (three discs along its width) must clear what is
      // built and must not stand across a gate or a door path. Measured on
      // the board, not along the centreline: on the outside of a bend the
      // gates are much farther apart than their arc lengths suggest.
      let clear = true;
      for (const lx of [-CHEVRON_HALF + 0.35, 0, CHEVRON_HALF - 0.35]) {
        const [bx, bz] = toWorld(x, z, yaw, lx, 0);
        if (occ.solids.hits(bx, bz, 0.4, 0.1, BUILT) || occ.solids.hits(bx, bz, 0.4, 0, TAG.reserved)) clear = false;
      }
      if (!clear) continue;
      spots.push({ u, x, z, yaw });
    }
    const chosen: typeof spots = [];
    const spaced = (sp: (typeof spots)[number]): boolean => chosen.every((c) => Math.hypot(c.x - sp.x, c.z - sp.z) >= 2 * CHEVRON_HALF + 0.5);
    const pick = (target: number, reach: number): void => {
      let best: (typeof spots)[number] | null = null;
      for (const sp of spots) {
        if (Math.abs(sp.u - target) > reach || !spaced(sp)) continue;
        if (!best || Math.abs(sp.u - target) < Math.abs(best.u - target)) best = sp;
      }
      if (best) chosen.push(best);
    };
    // Boards sit from the first third of the bend to its exit: that is
    // where a car that fails to turn would leave the road.
    const from = span * 0.25;
    const to = span * 0.98;
    for (let i = 0; i < want; i++) pick(from + ((to - from) * (i + 0.5)) / want, Math.max(1.5, (to - from) / want / 2));
    // A bend whose outside is mostly gates still gets its two boards,
    // wherever there is room for them.
    while (chosen.length < 2) {
      const before = chosen.length;
      pick((from + to) / 2, span + 6);
      if (chosen.length === before) break;
    }
    chosen.sort((p, q) => p.u - q.u);
    for (const sp of chosen) put('d02-chevron-sign', sp.x, sp.z, sp.yaw, 'chevron', { scheme: bend.direction, long: true, tag: TAG.dressing | TAG.sign });
  }

  // --- Tire stacks: outside of the tightest bends, between the boards,
  // from the apex to the exit.
  for (const bend of bends) {
    if (bend.minRadius > 12) continue;
    const dir = bend.direction === 'left' ? 1 : -1;
    const outside = (dir === 1 ? -1 : 1) as 1 | -1;
    const span = frame.wrap(bend.s1 - bend.s0);
    const uApex = frame.wrap(bend.apexS - bend.s0);
    let count = 0;
    let u = Math.max(0, uApex - 3);
    while (u <= span + 1 && count < 7) {
      const s = bend.s0 + u;
      const p = frame.at(s);
      const d = edgeAt(s) + dims.runoff + 0.5;
      const x = p.x - p.tz * outside * d;
      const z = p.z + p.tx * outside * d;
      const step = 0.98 / (1 + Math.abs(p.k) * d);
      if (!isOpen(outside, s, 0.6) && free(x, z, 0.45, 0.08) && !occ.onPad(x, z, 0.3) && frame.fastDist(x, z) > d - 0.05) {
        put('d04-tire-stack', x, z, (hashSeed(ctx.seed, 'tire', count, Math.round(s)) % 628) / 100, 'bend-tires');
        count++;
      }
      u += step;
    }
  }

  // --- Fence. Village: both sides, the whole cobbled stretch, open at
  // gates and where a pad joins the road. Outlying lots: a short run either
  // side of their gate.
  let bannerIn = rand.int(1, 3);
  /** Every fence segment as laid (the banners test their stakes against it;
   * the result's `fences` is this list without the last two fields). */
  const fenceSegs: { x: number; z: number; yaw: number; side: 1 | -1; scale: number; banner: boolean }[] = [];
  /** Every fence run as laid: arc range, side, and the line it stands on. */
  const fenceRuns: { s0: number; span: number; side: 1 | -1; lateral: number }[] = [];
  const nearBannerWindow = (s0: number, span: number): boolean => {
    for (let u = 0; u <= span + 0.5; u += 1) {
      const d = frame.delta(0, s0 + Math.min(u, span));
      if (d >= BANNER_S0 - 3 && d <= BANNER_S1 + 3) return true;
    }
    return false;
  };
  const fenceRun = (s0: number, span: number, side: 1 | -1, fenceLine: number): void => {
    if (span < FENCE_PITCH * 0.9) return;
    const lateral = nearBannerWindow(s0, span) ? fenceLine + BANNER_FENCE_SETBACK : fenceLine;
    let laid = false;
    // Fit whole segments to the run: a few percent of uniform scale closes
    // the run exactly (gates stay gate-wide). Where the run is too short for
    // that, unscaled segments are centred in it.
    let runLength = 0;
    {
      let [px, pz] = frame.offset(s0, side * lateral);
      for (let u = 0.25; u <= span + 1e-6; u += 0.25) {
        const [qx, qz] = frame.offset(s0 + u, side * lateral);
        runLength += Math.hypot(qx - px, qz - pz);
        px = qx;
        pz = qz;
      }
    }
    const n = Math.round(runLength / FENCE_PITCH);
    let scale = n > 0 ? runLength / (n * FENCE_PITCH) : 0;
    let chords: Chord[];
    if (scale >= 0.9 && scale <= 1.12) {
      // Chords are a hair shorter than the arc they span, hence the slack.
      chords = walkChords(frame, s0, span + 0.4, side * lateral, FENCE_PITCH * scale * 0.998).chords.slice(0, n);
    } else {
      scale = 1;
      const dry = walkChords(frame, s0, span, side * lateral, FENCE_PITCH);
      const lead = (span - dry.used) / 2;
      chords = walkChords(frame, s0 + lead, span - lead, side * lateral, FENCE_PITCH).chords;
    }
    for (const c of chords) {
      const mx = (c.ax + c.bx) / 2;
      const mz = (c.az + c.bz) / 2;
      // Pinched by a hairpin or by another part of the loop: leave it out.
      if (frame.fastDist(mx, mz) < lateral - 0.1 || frame.fastDist(c.ax, c.az) < lateral - 0.1 || frame.fastDist(c.bx, c.bz) < lateral - 0.1) continue;
      // The segment itself (five discs along it) against what already
      // stands on the fence line: boards and tire stacks on a bend's outside.
      let blocked = false;
      for (let i = 0; i <= 4 && !blocked; i++) blocked = occ.solids.hits(c.ax + ((c.bx - c.ax) * i) / 4, c.az + ((c.bz - c.az) * i) / 4, 0.3, 0.12, TAG.dressing);
      if (blocked) continue;
      if (occ.lotDistance(mx, mz) < 1.2) continue;
      // Never across paving: a forecourt or a door path that reaches the
      // fence line where the gate arithmetic did not expect it.
      if (occ.onPad(mx, mz, 0.15) || occ.onPad(c.ax, c.az, 0.05) || occ.onPad(c.bx, c.bz, 0.05)) continue;
      // Already fenced: an outlying lot whose gate lies inside the village
      // stretch would lay its own run over the village run (a doubled row,
      // or two rows 0.25 m apart where only one of them is set back).
      if (fenceSegs.some((f) => Math.hypot(f.x - mx, f.z - mz) < FENCE_MIN_SPACING)) continue;
      // Face = the chord's normal on the road side.
      let nx = -(c.bz - c.az);
      let nz = c.bx - c.ax;
      const [tx, tz] = towardRoad(mx, mz, c.s);
      if (nx * tx + nz * tz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const yaw = yawFacing(nx, nz);
      // ... and half a pitch along: centres more than 1.2 m apart, but one
      // panel lying half on the other (same line, or the set-back one).
      const half = (FENCE_PITCH * scale) / 2;
      if (
        fenceSegs.some((f) => {
          const o = panelOverlap(f.x, f.z, f.yaw, (FENCE_PITCH * f.scale) / 2, mx, mz, yaw, half);
          return o.along > FENCE_MAX_OVERLAP && o.across < FENCE_OVERLAP_ACROSS;
        })
      )
        continue;
      const banner = --bannerIn <= 0;
      if (banner) bannerIn = rand.int(3, 4);
      put('d07-wood-fence', mx, mz, yaw, 'fence', { scheme: banner ? 'banner' : 'plain', long: true, scale, tag: TAG.fence });
      fenceSegs.push({ x: mx, z: mz, yaw, side, scale, banner });
      laid = true;
    }
    if (laid) fenceRuns.push({ s0, span, side, lateral });
  };
  /**
   * The line the fence really stands on at arc length s on that side: the
   * lateral of the laid run nearest to s (within `reach` of its ends), else
   * `base`. Dressing that is placed relative to the fence (gate planters,
   * apron bollards, lamps, signposts) follows a run that was set back for
   * the banners instead of colliding with it.
   */
  const fenceLineAt = (s: number, side: 1 | -1, base: number, reach = 3): number => {
    let best = Infinity;
    let line = base;
    for (const r of fenceRuns) {
      if (r.side !== side) continue;
      const u = frame.wrap(s - r.s0);
      const d = u <= r.span ? 0 : Math.min(u - r.span, frame.length - u);
      if (d <= reach && d < best) {
        best = d;
        line = r.lateral;
      }
    }
    return line;
  };
  /** Fence over [u0, u1] (meters from sBase) minus the openings on that side. */
  const fenceBetween = (sBase: number, u0: number, u1: number, side: 1 | -1, lateral: number): void => {
    const cuts: [number, number][] = [];
    for (const o of v.openings) {
      if (o.side !== side) continue;
      const a = frame.delta(sBase, o.s0);
      const b = a + frame.wrap(o.s1 - o.s0);
      if (b > u0 && a < u1) cuts.push([a, b]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    let u = u0;
    for (const [a, b] of cuts) {
      if (a > u) fenceRun(sBase + u, a - u, side, lateral);
      u = Math.max(u, b);
    }
    if (u1 > u) fenceRun(sBase + u, u1 - u, side, lateral);
  };
  const vMid = vs0 + vlen / 2;
  for (const side of [-1, 1] as const) fenceBetween(vMid, -vlen / 2 + 1.5, vlen / 2 - 1.5, side, dims.fence);
  for (const lot of v.lots) {
    if (lot.zone !== 'outlying' || !lot.entrance) continue;
    fenceBetween(lot.s, -OUTLYING_FENCE_REACH, OUTLYING_FENCE_REACH, lot.side, dims.fenceOut);
  }

  // --- Flags beside the gantry (after the chevrons: a board that warns of
  // a bend at the start line matters more than a flag; and after the fence,
  // so the pole can stand right behind it).
  {
    /** Largest height step across a pole's base (r 0.2) at the point. */
    const baseStep = (x: number, z: number): number => {
      const hs = [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].map(([dx, dz]) => ground.getHeight(x + dx, z + dz));
      return Math.max(...hs) - Math.min(...hs);
    };
    const POLE_R = catalogEntry('d03-flag-pole').collisionRadius;
    /** A flag pole at (ds, lateral) if it is free there and, with `maxStep`,
     * only on ground at most that uneven under its base. Against the fence
     * only the pole counts (the cloth flies high above the rails). */
    const flag = (ds: number, lateral: number, maxStep = Infinity): boolean => {
      const [fx, fz] = frame.offset(ds, lateral);
      if (occ.solids.hits(fx, fz, 0.35, 0.1, TAG.dressing | TAG.sign | TAG.reserved) || occ.lotDistance(fx, fz) <= 0.175) return false;
      if (occ.solids.hits(fx, fz, POLE_R, 0, TAG.fence)) return false;
      // Off the paving, and a step clear of it: the garage lines its
      // apron's edge with bollards right after this.
      if (occ.onPad(fx, fz, 0.75) || frame.fastDist(fx, fz) <= dims.edgeDressed + dims.runoff + 0.3) return false;
      if (baseStep(fx, fz) > maxStep) return false;
      put('d03-flag-pole', fx, fz, flagYaw(fx, fz), 'start-flag');
      return true;
    };
    /** The first of the spots on level ground, else the first free one. */
    const FLAT = 0.05;
    const flagAt = (spots: number[], lateral: number): boolean => spots.some((ds) => flag(ds, lateral, FLAT)) || spots.some((ds) => flag(ds, lateral));
    // Just behind the fence: on the levelled verge (a pole on the bank
    // beyond it would lean). The fence at the line is set back for the
    // banners (fenceRun), so the pole stands as far behind the set-back
    // line as needed to clear its posts — where it stood before the
    // setback, 0.8 m behind the nominal line: the yard of a house beside the
    // start line may already blend up toward its floor farther back. A spot
    // a little along the line where the ground is level wins over the
    // nominal one.
    const lateral = Math.max(dims.fence + BANNER_FENCE_SETBACK + 0.55, GANTRY_HALF_OPENING + 0.8);
    for (const side of [1, -1] as const) {
      if (ctx.start.kind === 'gantry') {
        for (const ds of [-2.6, 2.6]) flagAt([1, 0.8, 1.3, 0.65, 1.5].map((k) => ds * k), side * lateral);
      } else {
        // No gantry: a pole on the line itself each side and a second one a
        // little way down the grid.
        const onLine = flagAt([0, 0.9, -0.9, 1.8, -1.8], side * lateral);
        if (onLine) flagAt([-3.4, -2.8, -4.0], side * lateral);
      }
    }
  }

  // --- Street lamps: every 16–20 m, alternating sides, just behind the
  // fence line with the arm over the verge.
  {
    let side = (rand.chance(0.5) ? 1 : -1) as 1 | -1;
    let u = 5 + rand.range(0, 4);
    const LAMP_R = catalogEntry('d08-street-lamp').collisionRadius;
    const tryLamp = (uu: number, sd: 1 | -1): boolean => {
      const s = vs0 + clamp(uu, 2, vlen - 2);
      if (isOpen(sd, s, 1.0, isGate)) return false;
      // Just behind the fence; a step farther back where the fence chord
      // bulges toward it (inside of a bend).
      // (Behind the line the fence really stands on: set back on the start
      // straight.)
      const line = fenceLineAt(s, sd, dims.fence);
      for (const back of [0.55, 0.85, 1.15]) {
        const d = line + back;
        const [x, z] = frame.offset(s, sd * d);
        if (frame.fastDist(x, z) < d - 0.1) return false;
        // It must belong to THIS stretch of road: beside a hairpin another
        // leg can be the nearer one, and the lamp would face that instead.
        const hit = frame.nearest(x, z);
        if (hit.side !== sd || Math.abs(frame.delta(s, hit.s)) > 2.5) return false;
        // Tucked against the fence: only other dressing and gates are in its way.
        if (occ.solids.hits(x, z, 0.3, 0.25, TAG.dressing | TAG.reserved) || occ.lotDistance(x, z) < 0.3) return false;
        // Never on paving (apron, square, forecourt): a lamp there stands in
        // the way of whatever the paving is for.
        if (occ.onPad(x, z, 0.35)) return false;
        if (occ.solids.hits(x, z, LAMP_R, 0.1, TAG.fence)) continue;
        const q = frame.at(hit.s);
        put('d08-street-lamp', x, z, yawFacing((q.x - x) / hit.dist, (q.z - z) / hit.dist), 'street-lamp');
        return true;
      }
      return false;
    };
    while (u < vlen - 4) {
      // Preferred side first; a hairpin's inside or a wide square can rule
      // it out, then the lamp crosses the road rather than go missing.
      let done = false;
      for (const sd of [side, -side as 1 | -1]) {
        for (const off of [0, 1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6, 7.5, -7.5]) {
          if (tryLamp(u + off, sd)) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      side = -side as 1 | -1;
      u += rand.range(16, 20);
    }
  }

  // --- Checkered banners along the start straight, from the grid to the
  // first corner, in front of the fence (as they hang in the vision). Their
  // stakes stand just outside the run-off line; the fence there is set back
  // (BANNER_FENCE_SETBACK) so they stay clear of its posts. Only where a
  // fence segment stands behind, and never in front of a banner panel.
  {
    const asset = 'd21-checker-banner';
    const BANNER_HALF = catalogEntry(asset).size[0] / 2;
    const seeds = seedPair(asset);
    const cands: { s: number; side: 1 | -1; x: number; z: number; yaw: number }[] = [];
    for (const side of [1, -1] as const) {
      for (let s = BANNER_S0; s <= BANNER_S1; s += 0.6) {
        const lat = edgeAt(s) + dims.runoff + BANNER_STAKE_RADIUS;
        const p = frame.at(s);
        const x = p.x - p.tz * side * lat;
        const z = p.z + p.tx * side * lat;
        if (frame.fastDist(x, z) < lat - 0.05) continue;
        const hit = frame.nearest(x, z);
        if (hit.side !== side || Math.abs(frame.delta(s, hit.s)) > 1) continue;
        const yaw = yawFacing(p.tz * side, -p.tx * side);
        // A fence segment right behind the whole cloth.
        const behind = (lx: number): boolean => {
          const [bx, bz] = toWorld(x, z, yaw, lx, 0);
          return fenceSegs.some((f) => f.side === side && Math.hypot(f.x - bx, f.z - bz) < FENCE_PITCH / 2 + 0.6);
        };
        if (!behind(-BANNER_HALF + 0.2) || !behind(BANNER_HALF - 0.2)) continue;
        // Never in front of a panel that hangs its own banner cloth (two
        // cloths 4 cm apart), and the stakes clear of every segment's box.
        const [ax, az] = toWorld(x, z, yaw, -BANNER_HALF, 0);
        const [bx, bz] = toWorld(x, z, yaw, BANNER_HALF, 0);
        let fenceOk = true;
        for (const f of fenceSegs) {
          if (f.side !== side || Math.hypot(f.x - x, f.z - z) > FENCE_PITCH + BANNER_HALF + 1) continue;
          const half = (FENCE_PITCH / 2) * f.scale;
          if (f.banner) {
            const [la, za] = toLocal(f.x, f.z, f.yaw, ax, az);
            const [lb, zb] = toLocal(f.x, f.z, f.yaw, bx, bz);
            if (Math.min(la, lb) < half + 0.3 && Math.max(la, lb) > -half - 0.3 && Math.min(Math.abs(za), Math.abs(zb)) < 1.2) fenceOk = false;
          }
          for (const sx of [-BANNER_STAKE_X, BANNER_STAKE_X]) {
            const [px, pz] = toWorld(x, z, yaw, sx, 0);
            const [lx, lz] = toLocal(f.x, f.z, f.yaw, px, pz);
            const gap = Math.hypot(Math.max(Math.abs(lx) - half - 0.1, 0), Math.max(Math.abs(lz) - FENCE_HALF_DEPTH, 0)) - BANNER_STAKE_HALF;
            if (gap < BANNER_FENCE_GAP + 0.02) fenceOk = false;
          }
          if (!fenceOk) break;
        }
        if (!fenceOk) continue;
        let clear = !occ.onPad(x, z, 0.3);
        for (const lx of [-BANNER_HALF + 0.3, 0, BANNER_HALF - 0.3]) {
          const [bx, bz] = toWorld(x, z, yaw, lx, 0);
          if (occ.solids.hits(bx, bz, 0.3, 0.1, TAG.dressing | TAG.reserved | TAG.sign) || occ.lotDistance(bx, bz) < 0.5) clear = false;
        }
        if (clear) cands.push({ s, side, x, z, yaw });
      }
    }
    // Every other fence panel or so: alternate sides from the line outward,
    // 4–8 in all where the fence allows.
    const chosen: typeof cands = [];
    const spaced = (c: (typeof cands)[number]): boolean => chosen.every((o) => o.side !== c.side || Math.abs(o.s - c.s) >= 2 * BANNER_HALF + 2.6);
    for (const target of [6, 10, 2, 16, 22, -6, 28, -12, 34, -16]) {
      for (const side of [-1, 1] as const) {
        if (chosen.length >= 8) break;
        let best: (typeof cands)[number] | null = null;
        for (const c of cands) {
          if (c.side !== side || Math.abs(c.s - target) > 2.4 || !spaced(c)) continue;
          if (!best || Math.abs(c.s - target) < Math.abs(best.s - target)) best = c;
        }
        if (best) chosen.push(best);
      }
    }
    chosen.sort((a, b) => a.side - b.side || a.s - b.s);
    chosen.forEach((c, i) => put(asset, c.x, c.z, c.yaw, 'start-banner', { long: true, seed: seeds[i % 2] }));
  }

  // --- Apex kerb markers: a chain of low blocks hugging the kerb on the
  // inside of each bend.
  bends.forEach((bend, bi) => {
    const dir = bend.direction === 'left' ? 1 : -1;
    const inside = dir as 1 | -1;
    const lat = edgeAt(bend.apexS, frame.wrap(bend.s1 - bend.s0) + 6) + 0.3;
    const innerR = bend.minRadius - lat;
    // Tighter than this the inside edge is a point, not a curve to follow.
    if (innerR < 3) return;
    const span = frame.wrap(bend.s1 - bend.s0);
    const innerArc = span * (1 - (bend.angle / Math.max(span, 1)) * lat);
    const count = clamp(Math.round(innerArc / KERB_MARKER_PITCH), 3, 6);
    const need = (count * KERB_MARKER_PITCH * bend.minRadius) / innerR;
    const { chords } = walkChords(frame, bend.apexS - need / 2, need * 1.5, inside * lat, KERB_MARKER_PITCH);
    chords.slice(0, count).forEach((c, i) => {
      const mx = (c.ax + c.bx) / 2;
      const mz = (c.az + c.bz) / 2;
      if (isOpen(inside, c.s, 0.4, isPad) || frame.fastDist(mx, mz) < lat - 0.25) return;
      const [tx, tz] = towardRoad(mx, mz, c.s);
      let nx = -(c.bz - c.az);
      let nz = c.bx - c.ax;
      if (nx * tx + nz * tz < 0) {
        nx = -nx;
        nz = -nz;
      }
      put('d06-kerb-marker', mx, mz, yawFacing(nx, nz), 'apex-kerb', { scheme: (i + bi) % 2 === 0 ? 'coral' : 'teal', ghost: true });
    });
  });

  // --- Retaining walls decided with the pads.
  // Never on a square or an apron that joins the road (seed 47 after a
  // road-profile change: two segments of a lot's retaining
  // wall stood on the village square).
  for (const w of v.walls) {
    if (v.pads.some((pad) => pad.joinsRoad && pointInPolygon(pad.polygon, w.x, w.z))) continue;
    if (!occ.solids.hits(w.x, w.z, 1.2, 0, BUILT)) put('d12-stone-wall', w.x, w.z, w.yaw, 'retaining-wall', { lot: w.lot, long: true });
  }

  // --- Around the buildings.
  for (const lot of v.lots) composeLot(lot);

  function composeLot(lot: Lot): void {
    const r = rng(ctx.seed, 'yard', lot.id);
    const dist = lot.setback + lot.halfZ;
    // The line this lot's own fence run stands on (set back on the start
    // straight): the gate dressing is placed from it.
    const baseLine = lot.zone === 'village' ? dims.fence : dims.fenceOut;
    const fenceLine = fenceLineAt(lot.s, lot.side, baseLine);
    const edge = lot.zone === 'village' ? dims.edgeDressed : dims.edgeRough;
    const hx = lot.halfX;
    const hz = lot.halfZ;
    /** Place in lot-local coordinates; `face` = local direction the front looks. */
    const at = (asset: string, lx: number, lz: number, role: string, face: Vec2 = [0, -1], radius?: number, long = false, scheme?: string, seed?: number): boolean => {
      const [x, z] = toWorld(lot.x, lot.z, lot.yaw, lx, lz);
      const e = catalogEntry(asset);
      const rr = radius ?? e.spreadRadius;
      if (occ.solids.hits(x, z, rr, 0.08, BUILT | TAG.reserved)) return false;
      // Never in the run-off, whatever the lot's shape on a curve.
      if (frame.fastDist(x, z) < dims.edgeDressed + dims.runoff + Math.min(e.collisionRadius, 0.5) + 0.05) return false;
      const [fx, fz] = toWorld(0, 0, lot.yaw, face[0], face[1]);
      put(asset, x, z, yawFacing(fx, fz), role, { lot: lot.id, long, scheme, seed });
      return true;
    };
    const spin = (): Vec2 => {
      const a = r.range(0, Math.PI * 2);
      return [Math.sin(a), Math.cos(a)];
    };
    const sgn = r.chance(0.5) ? 1 : -1;

    // A building whose front stands close behind the fence gets a tire
    // stack at the corner the traffic reaches first.
    if (lot.role !== 'garage' && lot.role !== 'tower' && lot.setback - baseLine < 2.6) {
      const t = frame.at(lot.s);
      const upstream = Math.cos(lot.yaw) * -t.tx - Math.sin(lot.yaw) * -t.tz > 0 ? 1 : -1;
      at('d04-tire-stack', upstream * (hx + 0.55), -hz - 0.1, 'corner-tires', spin());
      if (r.chance(0.5)) at('d04-tire-stack', upstream * (hx + 0.55), -hz + 0.85, 'corner-tires', spin());
    }

    switch (lot.role) {
      case 'garage': {
        // Bollards guard the door pillars, then line both edges of the
        // apron down to the run-off.
        for (const x of [-4.35, -0.3, 0.3, 4.35]) at('d05-bollard', x, -hz - 0.35, 'door-bollard', spin());
        const reach = dist - edge - dims.runoff - 0.3;
        for (const sx of [-1, 1]) {
          // The last one stands beside the end of the fence run at the
          // apron's edge; where that run is set back (start straight), it
          // steps back with it rather than go missing.
          const [ex, ez] = toWorld(lot.x, lot.z, lot.yaw, sx * (hx + 1.1), -(dist - baseLine));
          const shift = fenceLineAt(frame.nearest(ex, ez).s, lot.side, baseLine) - baseLine;
          for (let t = hz + 1.4; t <= reach; t += 1.7) {
            // Beside a set-back run the outermost one keeps the clearance
            // it has from an ordinary run (it stands BOLLARD_FENCE_CLEAR
            // behind the line its run stands on), so it does not touch the
            // run's end post.
            let tt = t;
            if (shift > 0) {
              const [bx, bz] = toWorld(lot.x, lot.z, lot.yaw, sx * (hx + 1.1), -t);
              if (frame.fastDist(bx, bz) < baseLine + shift + BOLLARD_FENCE_CLEAR) tt = t - shift;
            }
            if (!at('d05-bollard', sx * (hx + 1.1), -tt, 'apron-bollard', spin()) && shift > 0 && tt === t) at('d05-bollard', sx * (hx + 1.1), -(t - shift), 'apron-bollard', spin());
          }
        }
        at('d04-tire-stack', sgn * (hx + 0.75), -hz + 1.6, 'garage-tires', spin());
        at('d04-tire-stack', sgn * (hx + 0.75), -hz + 2.55, 'garage-tires', spin());
        at('d04-tire-stack', sgn * (hx + 1.6), -hz + 2.1, 'garage-tires', spin());
        at('d09-barrel', -sgn * (hx + 0.7), -hz + 1.5, 'garage-stores', spin());
        at('d09-barrel', -sgn * (hx + 0.7), -hz + 2.35, 'garage-stores', spin());
        at('d10-crate', -sgn * (hx + 0.85), -hz + 3.5, 'garage-stores', [r.range(-0.3, 0.3), -1]);
        at('d10-crate', -sgn * (hx + 1.9), -hz + 2.9, 'garage-stores', [r.range(-0.3, 0.3), -1]);
        const [fx, fz] = toWorld(lot.x, lot.z, lot.yaw, sgn * (hx + 2.3), -hz - 1.2);
        if (free(fx, fz, 0.35) && frame.fastDist(fx, fz) > edge + dims.runoff + 0.3) put('d03-flag-pole', fx, fz, flagYaw(fx, fz), 'garage-flag', { lot: lot.id });
        // Tool chests: on the apron beside the building, by a door corner,
        // fronts to the road; one, or one either side.
        {
          const chest = catalogEntry('d20-tool-chest');
          const seeds = seedPair('d20-tool-chest');
          const want = r.chance(0.5) ? 2 : 1;
          const cx = chest.size[0] / 2;
          const cz = chest.size[2] / 2;
          let placed = 0;
          // Just inside the apron's side edge, clear of the door-pillar
          // bollard and between the bollards that line the edge.
          for (const [sx, lz] of [[-sgn, -hz - 1.3], [sgn, -hz - 1.3], [-sgn, -hz - 2.3], [sgn, -hz - 2.3]] as [number, number][]) {
            if (placed >= want) break;
            const lx = sx * (hx - 0.25);
            if (Math.abs(lx) - cx < GARAGE_BAY_OUTER + CHEST_BAY_GAP) continue;
            // The whole cabinet on the apron (asphalt, not the verge beside it).
            const onApron = [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => {
              const [wx, wz] = toWorld(lot.x, lot.z, lot.yaw, lx + a * cx, lz + b * cz);
              return occ.onPad(wx, wz);
            });
            if (onApron && at('d20-tool-chest', lx, lz, 'garage-tools', [0, -1], undefined, false, undefined, seeds[placed])) placed++;
          }
          // Never a garage without one: a little further in from the side
          // edge (the apron narrows toward the road, and on some seeds its
          // edge cuts the corner of the spots above), or deeper on the apron,
          // tried only when the four spots above failed. Never in front of a
          // bay: the cabinet keeps CHEST_BAY_GAP clear of both openings.
          for (const [sx, lz, inset] of [[-sgn, -hz - 1.3, 0.35], [sgn, -hz - 1.3, 0.35], [-sgn, -hz - 3.3, 0.25], [sgn, -hz - 3.3, 0.25], [-sgn, -hz - 2.3, 0.35], [sgn, -hz - 2.3, 0.35]] as [number, number, number][]) {
            if (placed > 0) break;
            const lx = sx * (hx - inset);
            if (Math.abs(lx) - cx < GARAGE_BAY_OUTER + CHEST_BAY_GAP) continue;
            const onApron = [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => {
              const [wx, wz] = toWorld(lot.x, lot.z, lot.yaw, lx + a * cx, lz + b * cz);
              return occ.onPad(wx, wz);
            });
            if (onApron && at('d20-tool-chest', lx, lz, 'garage-tools', [0, -1], undefined, false, undefined, seeds[0])) placed++;
          }
        }
        break;
      }
      case 'market': {
        // The produce stand first, right of the doorway facing the street
        // (the crates and barrels that no longer fit there give way to it).
        const standSeeds = seedPair('d30-produce-stand');
        let stands = 0;
        const stand = (lx: number, lz: number): void => {
          if (stands < 2 && at('d30-produce-stand', lx, lz, 'market-produce', [0, -1], undefined, false, undefined, standSeeds[stands])) stands++;
        };
        stand(2.9, -hz - 0.8);
        // Produce out front, either side of the doorway.
        at('d10-crate', -3.55, -hz - 0.65, 'market-goods', [r.range(-0.2, 0.2), -1]);
        at('d10-crate', -2.5, -hz - 0.75, 'market-goods', [r.range(-0.2, 0.2), -1]);
        at('d10-crate', 2.45, -hz - 0.7, 'market-goods', [r.range(-0.2, 0.2), -1]);
        at('d10-crate', -3.0, -hz - 1.75, 'market-goods', [r.range(-0.4, 0.4), -1]);
        at('d09-barrel', -1.55, -hz - 0.55, 'market-goods', spin());
        at('d09-barrel', 3.45, -hz - 0.6, 'market-goods', spin());
        at('d09-barrel', 4.05, -hz - 1.35, 'market-goods', spin());
        at('d11-flower-planter', -hx - 0.3, -hz - 2.6, 'square-planter', [0, -1], undefined, false, 'stone');
        at('d11-flower-planter', hx + 0.3, -hz - 2.6, 'square-planter', [0, -1], undefined, false, 'stone');
        at('d13-bench', sgn * 1.9, -hz - 2.9, 'square-bench', [0, 1], undefined, true);
        // A second stand out on the square in front of the goods, where the
        // bench and the square's edge leave room for it.
        stand(-sgn * 1.75, -hz - 2.05);
        stand(sgn * 1.75, -hz - 2.05);
        break;
      }
      case 'hall': {
        for (const x of [-3.5, -1.7, 1.7, 3.5]) at('d11-flower-planter', x, -hz - 0.5, 'hall-planter', [0, -1], undefined, false, 'stone');
        at('d13-bench', -2.6, -hz - 1.7, 'square-bench', [0, -1], undefined, true);
        at('d13-bench', 2.6, -hz - 1.7, 'square-bench', [0, -1], undefined, true);
        for (const sx of [-1, 1]) {
          const [fx, fz] = toWorld(lot.x, lot.z, lot.yaw, sx * (hx + 0.7), -hz - 0.8);
          if (free(fx, fz, 0.35) && frame.fastDist(fx, fz) > edge + dims.runoff + 0.3) put('d03-flag-pole', fx, fz, flagYaw(fx, fz), 'hall-flag', { lot: lot.id });
        }
        break;
      }
      case 'tower': {
        at('d09-barrel', sgn * (lot.bodyHalfX + 0.5), -lot.bodyHalfZ - 0.3, 'tower-stores', spin());
        at('d10-crate', -sgn * (lot.bodyHalfX + 0.4), -lot.bodyHalfZ - 0.5, 'tower-stores', [r.range(-0.4, 0.4), -1]);
        break;
      }
      case 'house': {
        const landing = Math.min(lot.bodyHalfX * 1.5, 3.8) / 2;
        // Yard depth from the nominal line (the planter pair needs 2.3 m
        // there); a set-back fence leaves 0.25 m less, which a planter
        // 0.85 m behind it (reaching 1.35 m) still clears.
        const yard = dist - baseLine - hz;
        if (r.chance(0.7)) {
          at('d11-flower-planter', -(landing + 0.5), -hz - 0.45, 'door-planter', [0, -1], undefined, false, 'timber');
          if (r.chance(0.6)) at('d11-flower-planter', landing + 0.5, -hz - 0.45, 'door-planter', [0, -1], undefined, false, 'timber');
        }
        if (yard > 2.3 && r.chance(0.55)) {
          const tg = dist - fenceLine - 0.85;
          at('d11-flower-planter', 1.45, -tg, 'gate-planter', [0, -1], undefined, false, 'timber');
          if (r.chance(0.5)) at('d11-flower-planter', -1.45, -tg, 'gate-planter', [0, -1], undefined, false, 'timber');
        }
        if (r.chance(0.45) && hx > landing + 2.2) at('d13-bench', sgn * (landing + 1.55), -hz - 0.5, 'yard-bench', [0, -1], undefined, true);
        if (r.chance(0.35)) at('d09-barrel', -sgn * (hx + 0.45), r.range(-0.5, hz * 0.6), 'yard-barrel', spin());
        break;
      }
      case 'shack': {
        const bx = lot.bodyHalfX;
        at('d09-barrel', sgn * (bx + 0.25), -hz - 0.45, 'shack-stores', spin());
        if (r.chance(0.7)) at('d10-crate', sgn * (bx + 1.15), -hz - 0.55, 'shack-stores', [r.range(-0.4, 0.4), -1]);
        if (lot.asset === 'b02-workshop-shed') {
          at('d04-tire-stack', -sgn * (bx + 0.35), -hz - 0.45, 'shack-stores', spin());
          at('d10-crate', -sgn * (bx + 0.5), hz * 0.2, 'shack-stores', [r.range(-0.4, 0.4), -1]);
        } else if (r.chance(0.4)) {
          at('d11-flower-planter', -sgn * (bx - 0.4), -hz - 0.45, 'door-planter', [0, -1], undefined, false, 'timber');
        }
        if (lot.zone === 'outlying' && lot.entrance && r.chance(0.7)) {
          at('d14-signpost', 1.55, -(dist - fenceLine - 0.7), 'lot-signpost', [0, -1], undefined, false, r.chance(0.5) ? 'left' : 'right');
        }
        break;
      }
    }
  }

  // --- Along the road-side edge of the squares: planters on the run-off
  // line, so the square reads as a place and not as more road.
  for (const pad of v.pads) {
    if (pad.role !== 'square') continue;
    const o = v.openings.find((op) => op.kind === 'pad' && v.lots[pad.lot].side === op.side && frame.inRange(v.lots[pad.lot].s, op.s0, op.s1));
    if (!o) continue;
    const span = frame.wrap(o.s1 - o.s0);
    const n = Math.max(2, Math.round(span / 4.5));
    for (let i = 0; i <= n; i++) {
      const s = o.s0 + 1.2 + ((span - 2.4) * i) / n;
      const d = dims.edgeDressed + dims.runoff + 0.6;
      const [x, z] = frame.offset(s, o.side * d);
      if (!free(x, z, 0.6, 0.1) || frame.fastDist(x, z) < d - 0.3) continue;
      const [fx, fz] = towardRoad(x, z, s);
      put('d11-flower-planter', x, z, yawFacing(fx, fz), 'square-edge-planter', { lot: pad.lot, scheme: 'stone' });
    }
  }

  // --- Signposts where the cobbles begin and end, facing arriving cars.
  for (const [u, side] of [
    [-5, -1],
    [vlen + 5, 1],
  ] as [number, 1 | -1][]) {
    const s = vs0 + u;
    const p = frame.at(s);
    const d = dims.fenceOut + 0.3;
    const x = p.x - p.tz * side * d;
    const z = p.z + p.tx * side * d;
    if (free(x, z, 0.4, 0.2) && frame.fastDist(x, z) > d - 0.3) put('d14-signpost', x, z, yawFacing(-p.tx, -p.tz), 'village-signpost', { scheme: 'both' });
  }

  return { placements: out, fences: fenceSegs.map(({ x, z, yaw, side }) => ({ x, z, yaw, side })) };
}
