import type { Heightfield } from '../terrain/Heightfield';
import { Noise2D } from '../terrain/noise';
import { catalogEntry } from './catalog';
import { clamp, r3, smoothstep, toWorld } from './geom';
import { BUILT, Occupancy, TAG } from './occupancy';
import { hash2, hashSeed } from './rng';
import type { NatureBudgets, Placement } from './types';
import type { DressingResult } from './dressing';
import type { PlanContext, VillageResult } from './village';

/**
 * Nature for the whole world: trees, large rocks, bushes, low plants and
 * small rocks. Replaces the legacy game's pine / rock scatter.
 *
 * METHOD — ranked sampling. Every candidate spot (jittered-grid cell,
 * roadside station, satellite of a tree or a boulder…) gets a probability p
 * from the masks and a stateless hash roll; its key is roll / p. Candidates
 * are then taken in key order until the class reaches its target count.
 * That keeps the PATTERN the masks describe (dense where p is high, empty
 * where it is ~0) while the COUNT lands on the instance budget for every
 * seed — a Quest 3 draw budget must not depend on how much forest noise a
 * seed happens to have. Validity (clear of road, lots, pads, dressing and
 * of each other) is tested when a candidate is taken, best key first.
 */

interface RoadInfo {
  /** Distance to the centreline, Infinity far from any road. */
  d: number;
  side: 1 | -1;
  /** Signed curvature at the nearest road point. */
  k: number;
  /** Outer kerb edge there (village kerbs are wider). */
  edge: number;
  village: boolean;
}

interface Cand {
  x: number;
  z: number;
  key: number;
  asset: string;
  scale: number;
  role: string;
  /** Stateless hash for variant, yaw and tint. */
  h: number;
}

const SMALL_ROCKS = ['s01-pebble', 's02-wedge', 's03-flat-slab', 's04-chip-cluster', 's05-broken-chunk'];
/** Arc length, m, either side of a village end where the kerb is unsure. */
const VILLAGE_END_SLACK = 1.5;

export function planNature(
  ctx: PlanContext,
  ground: Heightfield,
  v: VillageResult,
  dressing: DressingResult,
  occ: Occupancy,
  budgets: NatureBudgets,
  splat: ((wx: number, wz: number, out: Float32Array) => void) | undefined,
): Placement[] {
  const { frame, dims, seed } = ctx;
  const half = ground.size / 2;
  const out: Placement[] = [];
  const forestNoise = new Noise2D(seed + 202);
  const macroNoise = new Noise2D(seed + 101);
  const patchNoise = new Noise2D(seed + 404);
  const splatOut = new Float32Array(4);
  const vs0 = v.village.s0;
  const vlen = v.village.length;
  let roadMean = 0;
  for (let i = 0; i < frame.n; i++) roadMean += frame.h[i] / frame.n;

  // One scratch record: every caller reads the result before asking again,
  // and tens of thousands of these per plan are worth not allocating.
  const info: RoadInfo = { d: Infinity, side: 1, k: 0, edge: dims.edgeRough, village: false };
  const inVillage = (u: number): boolean => frame.wrap(u - vs0) <= vlen;
  const road = (x: number, z: number): RoadInfo => {
    const d = frame.fastDist(x, z);
    info.d = d;
    if (d === Infinity) {
      info.side = 1;
      info.k = 0;
      info.edge = dims.edgeRough;
      info.village = false;
      return info;
    }
    const idx = frame.fastIndex(x, z);
    const s = frame.s[idx];
    info.village = inVillage(s);
    info.side = frame.sideAt(idx, x, z);
    info.k = frame.curv[idx];
    info.edge = info.village ? dims.edgeDressed : dims.edgeRough;
    // fastIndex is the point nearest the 1 m cell's centre, which can lie on
    // the other side of a village end than the exact nearest point: within
    // VILLAGE_END_SLACK of an end, clear the wider of the two kerbs.
    if (inVillage(s - VILLAGE_END_SLACK) !== inVillage(s + VILLAGE_END_SLACK)) info.edge = Math.max(dims.edgeDressed, dims.edgeRough);
    return info;
  };
  const slope = (x: number, z: number): number => {
    const e = 1;
    return Math.hypot(ground.getHeight(x + e, z) - ground.getHeight(x - e, z), ground.getHeight(x, z + e) - ground.getHeight(x, z - e)) / (2 * e);
  };
  const rockyAt = (x: number, z: number, sl: number): number => {
    if (splat) {
      splat(x, z, splatOut);
      return splatOut[1];
    }
    return smoothstep(0.5, 0.9, sl);
  };
  // Same macro noise the terrain generator paints its meadow splat with, so
  // meadow plants stand on meadow colour without the planner needing the splat.
  const meadowAt = (x: number, z: number): number => {
    if (splat) {
      splat(x, z, splatOut);
      return splatOut[3];
    }
    return smoothstep(0.15, 0.45, macroNoise.fbm(x / 40 + 31, z / 40 - 17, 3));
  };
  /** Extra clearance on the INSIDE of a bend so the exit stays visible. */
  const sight = (r: RoadInfo): number => (r.k * r.side > 0 ? 6 * smoothstep(1 / 30, 1 / 9, Math.abs(r.k)) : 0);
  const rimOf = (x: number, z: number): number => smoothstep(58, 70, Math.max(Math.abs(x), Math.abs(z)));

  const emit = (c: Cand): void => {
    const e = catalogEntry(c.asset);
    const u1 = ((c.h >>> 8) & 0xff) / 255;
    const u2 = ((c.h >>> 16) & 0xff) / 255;
    const b = 1 + 0.09 * (2 * u1 - 1);
    const w = 0.05 * (2 * u2 - 1);
    const p: Placement = {
      asset: c.asset,
      seed: c.h % e.variants,
      x: r3(c.x),
      y: r3(ground.getHeight(c.x, c.z)),
      z: r3(c.z),
      yaw: r3(((c.h >>> 3) % 6283) / 1000),
      scale: r3(c.scale),
      tint: [r3(b * (1 + w)), r3(b), r3(b * (1 - w))],
      role: c.role,
    };
    // Beyond the road distance field's reach = more than 30 m from any road.
    if ((e.category === 'tree' || e.category === 'large-rock') && frame.fastDist(c.x, c.z) === Infinity) p.backdrop = true;
    out.push(p);
  };
  /**
   * Take candidates best key first (ties: generation order) until `target`
   * are accepted. Keys are bucketed and each bucket is sorted only when the
   * walk reaches it — the same order as one big sort, but most candidates
   * (the hopeless tail) are never sorted at all.
   */
  const take = (cands: Cand[], target: number, maxKey: number, accept: (c: Cand) => boolean): Cand[] => {
    const B = 2048;
    const head = new Int32Array(B).fill(-1);
    const next = new Int32Array(cands.length);
    // Reverse insertion leaves every bucket's list in generation order.
    for (let i = cands.length - 1; i >= 0; i--) {
      const key = cands[i].key;
      if (!(key <= maxKey)) continue;
      const b = Math.min(B - 1, Math.floor((key / maxKey) * B));
      next[i] = head[b];
      head[b] = i;
    }
    const taken: Cand[] = [];
    const bucket: number[] = [];
    for (let b = 0; b < B && taken.length < target; b++) {
      bucket.length = 0;
      for (let i = head[b]; i >= 0; i = next[i]) bucket.push(i);
      if (bucket.length > 1) bucket.sort((p, q) => cands[p].key - cands[q].key || p - q);
      for (const i of bucket) {
        if (taken.length >= target) break;
        const c = cands[i];
        // (Satellites of a tree or a boulder at the world's edge can land
        // beyond it.)
        if (Math.abs(c.x) > half - 0.5 || Math.abs(c.z) > half - 0.5) continue;
        if (!accept(c)) continue;
        taken.push(c);
        emit(c);
      }
    }
    return taken;
  };
  /** Jittered grid over the world; `fn` gets the point, a roll and a hash. */
  const grid = (cell: number, channel: number, fn: (x: number, z: number, roll: number, h: number) => void): void => {
    const margin = 2.5;
    const cells = Math.floor((ground.size - margin * 2) / cell);
    for (let cz = 0; cz < cells; cz++) {
      for (let cx = 0; cx < cells; cx++) {
        const x = -half + margin + (cx + 0.08 + 0.84 * hash2(cx, cz, channel, seed)) * cell;
        const z = -half + margin + (cz + 0.08 + 0.84 * hash2(cx, cz, channel + 1, seed)) * cell;
        fn(x, z, hash2(cx, cz, channel + 2, seed), hashSeed(seed, channel, cx, cz));
      }
    }
  };
  const u01 = (h: number, shift: number): number => ((h >>> shift) & 0x3ff) / 1023;

  // =======================================================================
  // LARGE ROCKS — first, so trees leave them room.
  const rockTarget = Math.round((budgets.largeRocks[0] + budgets.largeRocks[1]) / 2);
  const rockOk = (c: Cand): boolean => {
    const e = catalogEntry(c.asset);
    const rr = e.collisionRadius * c.scale;
    const r = road(c.x, c.z);
    if (r.d < r.edge + 2.5 + rr + sight(r)) return false;
    // Through the village the fence is the road's edge: boulders sit behind it.
    if (r.village && r.d < dims.fence + 0.6 + rr) return false;
    if (occ.lotDistance(c.x, c.z) < rr + 0.6) return false;
    if (occ.onPad(c.x, c.z, rr * 0.8)) return false;
    if (occ.solids.hits(c.x, c.z, rr, 0.3, BUILT | TAG.reserved)) return false;
    if (occ.solids.hits(c.x, c.z, e.spreadRadius * c.scale * 0.8, 0, TAG.rock | TAG.tree)) return false;
    occ.solids.add(c.x, c.z, e.spreadRadius * c.scale * 0.8, TAG.rock);
    return true;
  };
  const rockAsset = (u: number): string => (u < 0.58 ? 'r01-shoulder-boulder' : u < 0.85 ? 'r03-terrace-stack' : 'r02-split-fin');
  const rocks: Cand[] = [];
  {
    // Shoulder boulders: stations along both sides of the whole loop, one to
    // three rocks each, as close as the clearance rules allow — the lavender
    // boulders that frame the vision's road.
    const shoulder: Cand[] = [];
    for (const side of [-1, 1] as const) {
      let s = 3 + 7 * hash2(side, 0, 50, seed);
      let station = 0;
      while (s < frame.length - 2) {
        const h = hashSeed(seed, 'shoulder', side, station);
        const p = frame.at(s);
        const village = frame.wrap(s - vs0) <= vlen;
        const edge = village ? dims.edgeDressed : dims.edgeRough;
        const inside = p.k * side > 0 ? smoothstep(1 / 30, 1 / 9, Math.abs(p.k)) : 0;
        const n = u01(h, 0) < 0.34 ? 2 : u01(h, 0) < 0.48 ? 3 : 1;
        for (let i = 0; i < n; i++) {
          const hi = hashSeed(h, i);
          const asset = rockAsset(u01(hi, 0));
          const scale = (i === 0 ? 0.92 : 0.72) + 0.26 * u01(hi, 10);
          const rr = catalogEntry(asset).collisionRadius * scale;
          const base = village ? dims.fence + 0.7 + rr : edge + 2.55 + rr;
          const lat = base + 6 * inside + (i === 0 ? 3.2 * u01(hi, 20) ** 2 : 0.4 + 3.4 * u01(hi, 20));
          const ds = i === 0 ? 0 : (i === 1 ? 1 : -1) * (2.2 + 1.4 * u01(hi, 4));
          // In the village most stations face a house: slide the boulder
          // along the fence into the gap beside it (front-yard corners and
          // the spaces between lots are where the vision keeps its rocks).
          let x = 0;
          let z = 0;
          for (const slide of village ? [0, 2.5, -2.5, 5, -5, 7.5, -7.5] : [0]) {
            const q = frame.at(s + ds + slide);
            x = q.x - q.tz * side * lat;
            z = q.z + q.tx * side * lat;
            if (occ.lotDistance(x, z) >= rr + 0.6 && !occ.onPad(x, z, rr * 0.8)) break;
          }
          shoulder.push({
            x,
            z,
            // Stations on the inside of a tight bend come last (sight line).
            key: (station + i * 0.01) * 1e-4 + inside,
            asset,
            scale,
            role: 'shoulder-rock',
            h: hi,
          });
        }
        s += 3.5 + 3.5 * u01(h, 12);
        station++;
      }
    }
    rocks.push(...take(shoulder, Math.round(rockTarget * 0.55), 0.55, rockOk));

    const field: Cand[] = [];
    const cluster = new Noise2D(seed + 303);
    grid(5.5, 10, (x, z, roll, h) => {
      const sl = slope(x, z);
      const rim = rimOf(x, z);
      let p = 0.03 + 0.85 * rockyAt(x, z, sl) + 0.3 * smoothstep(0.42, 0.7, cluster.fbm(x / 18, z / 18, 2)) + 0.2 * smoothstep(0.3, 0.6, sl);
      // The bowl's outer slope is mostly forest; a few crags show through.
      p *= 1 - 0.5 * rim;
      const r = road(x, z);
      if (r.d < 14) p += 0.12;
      field.push({ x, z, key: roll / p, asset: rockAsset(u01(h, 0)), scale: 0.82 + 0.4 * u01(h, 10) * u01(h, 20), role: 'field-rock', h });
    });
    rocks.push(...take(field, rockTarget - rocks.length, 12, rockOk));
  }

  // =======================================================================
  // TREES
  const treeTarget = Math.round((budgets.trees[0] + budgets.trees[1]) / 2);
  const species = new Noise2D(seed + 505);
  const treeCands: Cand[] = [];
  const treeScale = (asset: string, h: number, rim: number): number =>
    asset === 't02-switchback-pine' ? 0.8 + 0.42 * u01(h, 10) + 0.12 * rim : 0.82 + 0.4 * u01(h, 10);
  // --- Trees placed on purpose, before the forest gets its share. The
  // vision's street is FRAMED by trees: an oak or a palm in the gaps between
  // the houses just behind the fence, a palm beside the market stall, oaks
  // where the cobbles begin. Their keys are far below any forest key, so
  // they are taken first; the street row is thinned by its own spacing rule
  // (STREET_SPACING) rather than by the canopy test, or it would be a hedge.
  {
    const market = v.lots[v.village.marketLot];
    if (market) {
      [-1, 1].forEach((sx, i) => {
        const [x, z] = toWorld(market.x, market.z, market.yaw, sx * (market.halfX + 1.7), -market.halfZ + 1.2);
        const h = hashSeed(seed, 'market-palm', i);
        treeCands.push({ x, z, key: 1e-7 * (1 + i), asset: 't03-turbo-palm', scale: treeScale('t03-turbo-palm', h, 0), role: 'street-tree', h });
      });
    }
    let n = 0;
    for (const u of [-3.5, vlen + 3.5]) {
      for (const side of [-1, 1] as const) {
        const h = hashSeed(seed, 'gate-oak', n++);
        const [x, z] = frame.offset(vs0 + u, side * (dims.fenceOut + 2.4 + 1.5 * u01(h, 0)));
        treeCands.push({ x, z, key: 1e-6 * n, asset: 't01-rally-oak', scale: treeScale('t01-rally-oak', h, 0), role: 'street-tree', h });
      }
    }
    for (const side of [-1, 1] as const) {
      let station = 0;
      for (let u = 1.5; u < vlen - 1; u += 2.2, station++) {
        const h = hashSeed(seed, 'street-tree', side, station);
        const pick = u01(h, 0);
        const asset = pick < 0.5 ? 't01-rally-oak' : pick < 0.82 ? 't03-turbo-palm' : 't02-switchback-pine';
        // From as close behind the fence as a trunk may stand to 4 m back.
        const lat = dims.fence + 1.35 + 3.4 * u01(h, 20) ** 1.5;
        const [x, z] = frame.offset(vs0 + u + 1.6 * (u01(h, 4) - 0.5), side * lat);
        treeCands.push({ x, z, key: 1e-4 * (1 + u01(h, 12)), asset, scale: treeScale(asset, h, 0), role: 'street-tree', h });
      }
    }
  }
  const streetTrees: [number, number][] = [];
  const STREET_SPACING = 6.5;
  grid(3.2, 20, (x, z, roll, h) => {
    const sl = slope(x, z);
    if (sl > 0.8) return;
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const rim = rimOf(x, z);
    const vz = occ.builtUp(x, z);
    const F = forestNoise.fbm(x / 34, z / 34, 3);
    const meadow = meadowAt(x, z);
    let p = 0.85 * smoothstep(0.1, 0.32, F) * (1 - 0.7 * meadow);
    // Dense ring that hides the bowl rim; thinner on its far, unseen slope.
    // (The ring is what the tree budget mostly goes to; it gives a little
    // back so the village can have its groves.)
    p = Math.max(p, 0.74 * rim * (edge > 88 ? 0.5 : 1));
    // In and around the village: groves in the gaps and behind the roofs,
    // not wall-to-wall forest.
    p = Math.max(p * (1 - 0.9 * vz), 0.24 * vz);
    const r = road(x, z);
    // Trees framing the road in open country.
    if (r.d < r.edge + 14 && !r.village) p = Math.max(p, 0.14);
    p *= 1 - 0.8 * rockyAt(x, z, sl);
    const hgt = ground.getHeight(x, z);
    const S = species.fbm(x / 45, z / 45, 2);
    let asset: string;
    if (vz > 0.3) {
      // The vision's village: broad oaks, a few palms, the odd pine behind a roof.
      asset = u01(h, 0) < 0.55 ? 't01-rally-oak' : u01(h, 0) < 0.83 ? 't03-turbo-palm' : 't02-switchback-pine';
    } else if (1.6 * rim + (hgt - roadMean) / 3.5 + 0.8 * S + sl > 0.3) {
      asset = 't02-switchback-pine';
    } else {
      asset = u01(h, 0) < (meadow > 0.4 ? 0.7 : 0.9) ? 't01-rally-oak' : 't03-turbo-palm';
    }
    if (asset !== 't02-switchback-pine' && sl > 0.6) return;
    treeCands.push({ x, z, key: roll / Math.max(p, 0.015), asset, scale: treeScale(asset, h, rim), role: vz > 0.3 ? 'village-tree' : rim > 0.5 ? 'rim-tree' : 'tree', h });
  });
  const trees = take(treeCands, treeTarget, 3, (c) => {
    const e = catalogEntry(c.asset);
    const r = road(c.x, c.z);
    if (r.d < r.edge + 2.5 + e.collisionRadius * c.scale + sight(r)) return false;
    if (r.village && r.d < dims.fence + 0.9) return false;
    const street = c.role === 'street-tree';
    // Among the houses a canopy may reach over a yard and a roof's edge, as
    // the vision's oaks do; out of town trees keep their distance.
    const inTown = street || c.role === 'village-tree';
    if (occ.lotDistance(c.x, c.z) < (inTown ? Math.max(e.collisionRadius + 0.9, e.spreadRadius * c.scale * 0.6) : e.spreadRadius * 0.8)) return false;
    if (occ.onPad(c.x, c.z, 0.8)) return false;
    if (occ.solids.hits(c.x, c.z, e.collisionRadius + 0.5, 0, BUILT | TAG.reserved)) return false;
    // No canopy over a chevron board: from the diorama's high viewpoint it
    // would hide the board the bend is signed with.
    if (occ.solids.hits(c.x, c.z, e.spreadRadius * c.scale, 0.3, TAG.sign)) return false;
    const spread = e.spreadRadius * c.scale * 0.62;
    if (occ.solids.hits(c.x, c.z, spread, 0, TAG.tree | TAG.rock)) return false;
    if (street) {
      for (const [sx, sz] of streetTrees) if (Math.hypot(sx - c.x, sz - c.z) < STREET_SPACING) return false;
      streetTrees.push([c.x, c.z]);
    }
    occ.solids.add(c.x, c.z, spread, TAG.tree);
    return true;
  });

  // How wooded is it here: tree count in the 3 × 3 block of 6 m cells.
  const DCELL = 6;
  const dn = Math.ceil(ground.size / DCELL);
  const treeCount = new Uint8Array(dn * dn);
  for (const t of trees) {
    const cx = clamp(Math.floor((t.x + half) / DCELL), 0, dn - 1);
    const cz = clamp(Math.floor((t.z + half) / DCELL), 0, dn - 1);
    treeCount[cz * dn + cx]++;
  }
  const wooded = (x: number, z: number): number => {
    const cx = clamp(Math.floor((x + half) / DCELL), 0, dn - 1);
    const cz = clamp(Math.floor((z + half) / DCELL), 0, dn - 1);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix >= 0 && iz >= 0 && ix < dn && iz < dn) n += treeCount[iz * dn + ix];
      }
    }
    return n;
  };

  // =======================================================================
  // BUSHES — tree-line edges, along fences, round houses and boulders.
  const bushTarget = Math.round((budgets.bushes[0] + budgets.bushes[1]) / 2);
  const bushCands: Cand[] = [];
  const BUSH = 'v01-puff-bush';
  trees.forEach((t, i) => {
    // Edge of the wood = few neighbours. Deep forest gets next to none.
    const n = wooded(t.x, t.z);
    const edgeness = 1 - smoothstep(4, 11, n);
    const spread = catalogEntry(t.asset).spreadRadius * t.scale;
    for (let k = 0; k < 2; k++) {
      const h = hashSeed(seed, 'bush', i, k);
      const a = u01(h, 0) * Math.PI * 2;
      const d = spread * (0.7 + 0.6 * u01(h, 10));
      const p = 0.06 + 0.55 * edgeness * (k === 0 ? 1 : 0.5);
      bushCands.push({ x: t.x + Math.sin(a) * d, z: t.z + Math.cos(a) * d, key: u01(h, 20) / p, asset: BUSH, scale: 0.85 + 0.3 * u01(h, 5), role: 'treeline-bush', h });
    }
  });
  dressing.fences.forEach((f, i) => {
    const h = hashSeed(seed, 'fence-bush', i);
    if (u01(h, 0) > 0.42) return;
    // Behind the fence (local +z is the field side), a little off its line.
    const [x, z] = toWorld(f.x, f.z, f.yaw, (u01(h, 10) - 0.5) * 1.6, 0.85 + 0.5 * u01(h, 20));
    bushCands.push({ x, z, key: 0.3 * u01(h, 4), asset: BUSH, scale: 0.8 + 0.3 * u01(h, 14), role: 'fence-bush', h });
  });
  for (const lot of v.lots) {
    for (let k = 0; k < 6; k++) {
      const h = hashSeed(seed, 'lot-bush', lot.id, k);
      // Sides and back of the envelope, never the front (door, path).
      const sideways = k < 4;
      const lx = sideways ? (k % 2 === 0 ? -1 : 1) * (lot.halfX + 0.75) : (u01(h, 0) * 2 - 1) * lot.halfX;
      const lz = sideways ? (u01(h, 0) * 1.6 - 0.6) * lot.halfZ : lot.halfZ + 0.8;
      const [x, z] = toWorld(lot.x, lot.z, lot.yaw, lx, lz);
      bushCands.push({ x, z, key: 0.25 + 0.6 * u01(h, 10), asset: BUSH, scale: 0.8 + 0.35 * u01(h, 20), role: 'yard-bush', h });
    }
  }
  rocks.forEach((rk, i) => {
    const h = hashSeed(seed, 'rock-bush', i);
    const a = u01(h, 0) * Math.PI * 2;
    const d = catalogEntry(rk.asset).collisionRadius * rk.scale + 0.7;
    bushCands.push({ x: rk.x + Math.sin(a) * d, z: rk.z + Math.cos(a) * d, key: u01(h, 10) / 0.3, asset: BUSH, scale: 0.75 + 0.3 * u01(h, 20), role: 'rock-bush', h });
  });
  grid(6, 30, (x, z, roll, h) => {
    const p = (0.1 + 0.25 * meadowAt(x, z)) * (1 - 0.6 * rimOf(x, z));
    bushCands.push({ x, z, key: roll / p, asset: BUSH, scale: 0.8 + 0.35 * u01(h, 10), role: 'bush', h });
  });
  take(bushCands, bushTarget, 20, (c) => {
    const r = road(c.x, c.z);
    // No collider, but chest-high: out of the run-off and off the sight line.
    if (r.d < r.edge + 1.3 + 0.5 * sight(r)) return false;
    if (slope(c.x, c.z) > 0.7) return false;
    if (occ.lotDistance(c.x, c.z) < 0.5 || occ.onPad(c.x, c.z, 0.5)) return false;
    if (occ.solids.hits(c.x, c.z, 0.55, 0, BUILT | TAG.reserved | TAG.rock)) return false;
    // A bush is as tall as a chevron board: none beside one, where it
    // would stand between the board and the cars it warns.
    if (occ.solids.hits(c.x, c.z, 0.55, 1.6, TAG.sign)) return false;
    if (occ.solids.hits(c.x, c.z, 0.6, 0, TAG.bush)) return false;
    occ.solids.add(c.x, c.z, 0.6, TAG.bush);
    return true;
  });

  // =======================================================================
  // LOW PLANTS — ferns under trees, ribbon grass and rosettes in meadows,
  // coral blooms in drifts along the verges and round the houses.
  const lowTarget = Math.round((budgets.lowPlants[0] + budgets.lowPlants[1]) / 2);
  const lowOk = (c: Cand): boolean => {
    const r = road(c.x, c.z);
    if (r.d < r.edge + 0.3) return false;
    if (occ.lotDistance(c.x, c.z) < 0.25 || occ.onPad(c.x, c.z, 0.25)) return false;
    if (occ.solids.hits(c.x, c.z, 0.12, 0, BUILT | TAG.rock)) return false;
    const rr = catalogEntry(c.asset).spreadRadius * c.scale * 0.75;
    if (occ.solids.hits(c.x, c.z, rr, 0, TAG.low)) return false;
    if (slope(c.x, c.z) > 0.8) return false;
    occ.solids.add(c.x, c.z, rr, TAG.low);
    return true;
  };

  const fernCands: Cand[] = [];
  trees.forEach((t, i) => {
    const far = rimOf(t.x, t.z) > 0.9 ? 0.35 : 1;
    const dens = smoothstep(1, 6, wooded(t.x, t.z));
    for (let k = 0; k < 2; k++) {
      const h = hashSeed(seed, 'fern', i, k);
      const a = u01(h, 0) * Math.PI * 2;
      const d = (0.55 + 1.2 * u01(h, 10)) * t.scale;
      const p = far * (0.25 + 0.75 * dens) * (k === 0 ? 1 : 0.6);
      fernCands.push({ x: t.x + Math.sin(a) * d, z: t.z + Math.cos(a) * d, key: u01(h, 20) / p, asset: 'v03-fan-fern', scale: 0.86 + 0.3 * u01(h, 5), role: 'fern', h });
    }
  });
  take(fernCands, Math.round(lowTarget * 0.22), 6, lowOk);

  const bloomCands: Cand[] = [];
  const BLOOM = 'v05-coral-blooms';
  const bloomTarget = Math.round(lowTarget * 0.36);
  // Verge drifts: rows of stations beside the road, switched on and off by
  // a patch noise so the flowers come in loose drifts with grass between —
  // not as two unbroken coral lines along the kerbs. The verge takes a
  // capped share (VERGE_BLOOMS_PER_M of road, both sides together); the rest
  // of the flower budget goes to fence feet, boulders, yards and meadows.
  const VERGE_BLOOMS_PER_M = 1.25;
  const vergeCands: Cand[] = [];
  for (const side of [-1, 1] as const) {
    let station = 0;
    for (let s = 0; s < frame.length; s += 1.05, station++) {
      const p = frame.at(s);
      const village = frame.wrap(s - vs0) <= vlen;
      const edge = village ? dims.edgeDressed : dims.edgeRough;
      const rows = village ? [0.42, 1.05, 2.45, 3.2] : [0.42, 1.1, 1.85, 2.65, 3.5];
      rows.forEach((row, j) => {
        const h = hashSeed(seed, 'verge', side, station, j);
        // Jitter as wide as the row and station pitch, or the drifts show
        // the lattice they were sampled on.
        const lat = edge + Math.max(0.36, row + 0.7 * (u01(h, 0) - 0.5));
        const x = p.x - p.tz * side * lat + 1.0 * (u01(h, 10) - 0.5) * p.tx;
        const z = p.z + p.tx * side * lat + 1.0 * (u01(h, 20) - 0.5) * p.tz;
        // A narrow threshold on a slow noise: a drift is clearly on or
        // clearly off, some 8–15 m at a time.
        const drift = smoothstep(0.1, 0.26, patchNoise.fbm(x / 10, z / 10, 2));
        const prob = (village ? 0.015 + 0.985 * drift : drift) * (1 - 0.14 * j);
        if (prob > 0.02) vergeCands.push({ x, z, key: u01(h, 5) / prob, asset: BLOOM, scale: 0.86 + 0.3 * u01(h, 15), role: 'verge-blooms', h });
      });
    }
  }
  const vergeTaken = take(vergeCands, Math.min(Math.round(frame.length * VERGE_BLOOMS_PER_M), Math.round(bloomTarget * 0.4)), 1.6, lowOk).length;
  for (const lot of v.lots) {
    // Flower beds against the walls and either side of the door path.
    const dist = lot.setback + lot.halfZ;
    for (let k = 0; k < 22; k++) {
      const h = hashSeed(seed, 'lot-bloom', lot.id, k);
      let lx: number;
      let lz: number;
      if (k < 8) {
        lx = (k % 2 === 0 ? -1 : 1) * (1.0 + 0.5 * u01(h, 0));
        lz = -(lot.halfZ + 1.4 + (dist - lot.halfZ - dims.hw - 3) * u01(h, 10));
      } else if (k < 15) {
        lx = (u01(h, 0) * 2 - 1) * (lot.halfX + 0.5);
        lz = -(lot.halfZ + 0.35 + 0.5 * u01(h, 10));
      } else {
        lx = (k % 2 === 0 ? -1 : 1) * (lot.halfX + 0.35 + 0.5 * u01(h, 0));
        lz = (u01(h, 10) * 2 - 1) * lot.halfZ;
      }
      const [x, z] = toWorld(lot.x, lot.z, lot.yaw, lx, lz);
      bloomCands.push({ x, z, key: 0.15 + 0.5 * u01(h, 20), asset: BLOOM, scale: 0.86 + 0.3 * u01(h, 5), role: 'yard-blooms', h });
    }
  }
  dressing.fences.forEach((f, i) => {
    for (let k = 0; k < 2; k++) {
      const h = hashSeed(seed, 'fence-bloom', i, k);
      if (u01(h, 0) > 0.55) continue;
      // Either side of the fence, at a post foot.
      const [x, z] = toWorld(f.x, f.z, f.yaw, (u01(h, 10) - 0.5) * 2.2, (k === 0 ? -1 : 1) * (0.5 + 0.25 * u01(h, 20)));
      bloomCands.push({ x, z, key: 0.2 + 0.5 * u01(h, 4), asset: BLOOM, scale: 0.86 + 0.28 * u01(h, 14), role: 'fence-blooms', h });
    }
  });
  rocks.forEach((rk, i) => {
    if (rk.role !== 'shoulder-rock') return;
    for (let k = 0; k < 3; k++) {
      const h = hashSeed(seed, 'rock-bloom', i, k);
      const a = u01(h, 0) * Math.PI * 2;
      const d = catalogEntry(rk.asset).collisionRadius * rk.scale + 0.35 + 0.6 * u01(h, 10);
      bloomCands.push({ x: rk.x + Math.sin(a) * d, z: rk.z + Math.cos(a) * d, key: 0.3 + u01(h, 20), asset: BLOOM, scale: 0.86 + 0.28 * u01(h, 5), role: 'rock-blooms', h });
    }
  });
  grid(3.2, 40, (x, z, roll, h) => {
    const p = 0.45 * meadowAt(x, z) * smoothstep(0.1, 0.4, patchNoise.fbm(x / 7 + 9, z / 7 - 4, 2)) * (1 - rimOf(x, z));
    if (p > 0.02) bloomCands.push({ x, z, key: roll / p, asset: BLOOM, scale: 0.86 + 0.3 * u01(h, 10), role: 'meadow-blooms', h });
  });
  const bloomsTaken = vergeTaken + take(bloomCands, bloomTarget - vergeTaken, 5, lowOk).length;

  const grassCands: Cand[] = [];
  grid(2.6, 50, (x, z, roll, h) => {
    const r = road(x, z);
    const verge = r.d < r.edge + 5 ? 0.3 : 0;
    const p = (0.1 + 0.55 * meadowAt(x, z) + verge) * (1 - 0.75 * smoothstep(1, 6, wooded(x, z))) * (1 - 0.7 * rimOf(x, z));
    grassCands.push({ x, z, key: roll / p, asset: 'v02-ribbon-grass', scale: 0.86 + 0.3 * u01(h, 10), role: 'grass', h });
  });
  // What the flowers left of their share (thinned verges, a world with few
  // meadows) goes to the grass, so the low-plant count stays on its budget
  // — and it is grass that belongs between the flower drifts.
  take(grassCands, Math.round(lowTarget * 0.3) + (bloomTarget - bloomsTaken), 12, lowOk);

  const rosetteCands: Cand[] = [];
  grid(4.2, 60, (x, z, roll, h) => {
    const sl = slope(x, z);
    const p = (0.03 + 0.4 * meadowAt(x, z) + 0.25 * smoothstep(0.25, 0.5, sl)) * (1 - 0.8 * smoothstep(1, 6, wooded(x, z))) * (1 - 0.6 * rimOf(x, z));
    rosetteCands.push({ x, z, key: roll / p, asset: 'v04-spike-rosette', scale: 0.86 + 0.3 * u01(h, 10), role: 'rosette', h });
  });
  take(rosetteCands, Math.round(lowTarget * 0.12), 20, lowOk);

  // =======================================================================
  // SMALL ROCKS — road edge, round boulders, rocky slopes.
  const smallTarget = Math.round((budgets.smallRocks[0] + budgets.smallRocks[1]) / 2);
  const smallCands: Cand[] = [];
  const smallAsset = (u: number, chunky: boolean): string => {
    const t = chunky ? 0.35 + 0.65 * u : u;
    return SMALL_ROCKS[t < 0.3 ? 0 : t < 0.55 ? 1 : t < 0.7 ? 2 : t < 0.85 ? 3 : 4];
  };
  for (const side of [-1, 1] as const) {
    let station = 0;
    for (let s = 0; s < frame.length; s += 0.9, station++) {
      const h = hashSeed(seed, 'edge-stone', side, station);
      const p = frame.at(s);
      const village = frame.wrap(s - vs0) <= vlen;
      const edge = village ? dims.edgeDressed : dims.edgeRough;
      const lat = edge + 0.22 + 2.0 * u01(h, 0) ** 2;
      // The village keeps a tidy verge.
      const prob = (0.35 + 0.4 * smoothstep(-0.2, 0.3, patchNoise.sample(s / 6, side * 7.3))) * (village ? 0.35 : 1);
      smallCands.push({ x: p.x - p.tz * side * lat, z: p.z + p.tx * side * lat, key: u01(h, 10) / prob, asset: smallAsset(u01(h, 20), false), scale: 0.85 + 0.3 * u01(h, 5), role: 'edge-stone', h });
    }
  }
  rocks.forEach((rk, i) => {
    for (let k = 0; k < 4; k++) {
      const h = hashSeed(seed, 'rock-stone', i, k);
      const a = u01(h, 0) * Math.PI * 2;
      const d = catalogEntry(rk.asset).collisionRadius * rk.scale * (0.95 + 0.7 * u01(h, 10));
      smallCands.push({ x: rk.x + Math.sin(a) * d, z: rk.z + Math.cos(a) * d, key: u01(h, 20) / (k < 2 ? 0.7 : 0.4), asset: smallAsset(u01(h, 5), true), scale: 0.85 + 0.3 * u01(h, 15), role: 'boulder-stone', h });
    }
  });
  grid(5, 70, (x, z, roll, h) => {
    const sl = slope(x, z);
    const p = (0.04 + 0.5 * rockyAt(x, z, sl) + 0.2 * smoothstep(0.3, 0.6, sl)) * (1 - 0.6 * rimOf(x, z));
    smallCands.push({ x, z, key: roll / p, asset: smallAsset(u01(h, 0), true), scale: 0.85 + 0.3 * u01(h, 10), role: 'slope-stone', h });
  });
  take(smallCands, smallTarget, 25, (c) => {
    const r = road(c.x, c.z);
    if (r.d < r.edge + 0.15) return false;
    if (occ.lotDistance(c.x, c.z) < 0.2 || occ.onPad(c.x, c.z, 0.15)) return false;
    if (occ.solids.hits(c.x, c.z, 0.1, 0, BUILT)) return false;
    // Pebbles may lie among the flowers, just not in the middle of a clump.
    const rr = catalogEntry(c.asset).spreadRadius * c.scale * 0.5;
    if (occ.solids.hits(c.x, c.z, rr, -0.12, TAG.low)) return false;
    occ.solids.add(c.x, c.z, rr, TAG.low);
    return true;
  });

  return out;
}
