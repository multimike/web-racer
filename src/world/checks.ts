import { BANNER_STAKE_HALF, BANNER_STAKE_X, BUILDING_IDS, CATALOG, GANTRY_HALF_OPENING, GANTRY_PYLON_OFFSET, GANTRY_PYLON_RADIUS, GARAGE_BAY_WIDTH, GARAGE_BAY_X, catalogEntry, natureClass } from './catalog';
import { frontOf, obbOverlap, panelOverlap, pointInPolygon, polygonEdgeDistance, segmentDistance, toLocal, toWorld } from './geom';
import type { Obb } from './geom';
import { DEFAULT_BUDGETS, planWorld } from './planWorld';
import { applyTerrainModifiers, copyHeightfield } from './terrainModifiers';
import { TrackFrame } from './trackFrame';
import type { Lot, NatureBudgets, Placement, WorldPlan, WorldPlanInput } from './types';
import { roadDims } from './village';

/**
 * Self-checks of a world plan. They re-derive everything from the plan and
 * the planner's INPUT (track + unmodified terrain) with brute-force
 * geometry, sharing no placement logic with the planner — a check that
 * reused the planner's own tests would only prove the code agrees with
 * itself.
 */

export interface CheckResult {
  name: string;
  pass: boolean;
  /** The measured number(s), human readable. */
  value: string;
  /** What exactly failed (first few offenders). */
  detail?: string;
  /** A composition goal, not a correctness rule: the planner falls back on
   * purpose where the track leaves no room (garage far from the line, hall
   * and market on separate squares). Shown, but not counted as a failure. */
  advisory?: boolean;
}

/** Hard limit on earthwork per lot, meters (the planner aims below it). */
export const CUT_FILL_LIMIT = 1.5;

const lotObb = (l: Lot): Obb => ({ x: l.x, z: l.z, yaw: l.yaw, hx: l.halfX, hz: l.halfZ });

export function checkWorldPlan(plan: WorldPlan, input: WorldPlanInput): CheckResult[] {
  const results: CheckResult[] = [];
  const hw = plan.road.halfWidth;
  const dims = roadDims(hw);
  const frame = new TrackFrame(input.track, plan.worldSize);
  const base = copyHeightfield(input.heightfield);
  const budgets: NatureBudgets = { ...DEFAULT_BUDGETS, ...input.budgets };
  const vs0 = plan.village.s0;
  const inVillage = (s: number): boolean => frame.wrap(s - vs0) <= plan.village.length;
  const kerbAt = (s: number): number => (inVillage(s) ? dims.kerbDressed : dims.kerbRough);
  const add = (name: string, pass: boolean, value: string, offenders: string[] = [], advisory = false): void => {
    const r: CheckResult = { name, pass, value, detail: offenders.length ? offenders.slice(0, 4).join('; ') + (offenders.length > 4 ? ` … +${offenders.length - 4}` : '') : undefined };
    if (advisory) r.advisory = true;
    results.push(r);
  };
  /** Solid footprint of a dressing placement as discs [x, z, r]: long thin
   * things as a row along their width, the gantry as its two plinths. */
  const discsOf = (p: Placement): [number, number, number][] => {
    const e = catalogEntry(p.asset);
    if (e.collisionRadius <= 0) return [];
    if (p.role === 'start-gantry') {
      return [-GANTRY_PYLON_OFFSET, GANTRY_PYLON_OFFSET].map((lx): [number, number, number] => [...toWorld(p.x, p.z, p.yaw, lx, 0), GANTRY_PYLON_RADIUS]);
    }
    if (e.size[0] > 1.2 && e.collisionRadius > 0.6) {
      const half = (e.size[0] * p.scale) / 2;
      const r = Math.max(0.12, e.size[2] / 2) * p.scale;
      const n = Math.max(2, Math.ceil(half / r));
      const out: [number, number, number][] = [];
      for (let i = 0; i <= n; i++) out.push([...toWorld(p.x, p.z, p.yaw, -half + r + ((2 * half - 2 * r) * i) / n, 0), r]);
      return out;
    }
    return [[p.x, p.z, e.collisionRadius * p.scale]];
  };
  const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : String(v));

  // 0. The terrain is carved to the road width the plan was made for:
  // just inside the planned road edge the ground is at the road's height.
  {
    const lat = hw - 0.25;
    const off: number[] = [];
    for (let i = 0; i < frame.n; i++) {
      for (const side of [1, -1]) {
        const x = frame.px[i] - frame.tz[i] * side * lat;
        const z = frame.pz[i] + frame.tx[i] * side * lat;
        const hit = frame.nearest(x, z);
        // Another leg of the loop is nearer: its height applies, not this one's.
        if (hit.dist < lat - 0.2) continue;
        off.push(Math.abs(base.getHeight(x, z) - frame.h[i]));
      }
    }
    off.sort((a, b) => a - b);
    // 9 probes in 10: where two legs pinch together at different heights a
    // few are honestly off. (A 5 m plan on the 3.5 m carve reads ≥ 0.2 m.)
    const p90 = off.length ? off[Math.floor(off.length * 0.9)] : 0;
    add(`terrain carved to the planned road width (≤ 0.1 m off at ${fmt(lat)} m)`, p90 <= 0.1, `${fmt(p90)} m off`, p90 <= 0.1 ? [] : [`re-carve the heightfield to half width ${hw} (track.halfWidth is ${input.track.halfWidth})`]);
  }

  // 1. Every building of the pack is in the world.
  {
    const present = new Set(plan.lots.map((l) => l.asset));
    const missing = BUILDING_IDS.filter((id) => !present.has(id));
    add('all ten buildings present', missing.length === 0, `${present.size}/10`, missing);
  }

  // 2. Building counts.
  {
    const v = plan.lots.filter((l) => l.zone === 'village').length;
    const o = plan.lots.length - v;
    add('village 12–18 buildings', v >= 12 && v <= 18, String(v));
    add('outlying 3–6 buildings', o >= 3 && o <= 6, String(o));
  }

  // 3. Repeats differ in (seed, scheme).
  {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const l of plan.lots) {
      const k = `${l.asset}/${l.seed}/${l.scheme}`;
      if (seen.has(k)) dup.push(k);
      seen.add(k);
    }
    add('repeated buildings differ in seed or scheme', dup.length === 0, `${seen.size} looks`, dup);
  }

  // 4. Lot envelopes do not overlap.
  {
    const bad: string[] = [];
    for (let i = 0; i < plan.lots.length; i++) {
      for (let j = i + 1; j < plan.lots.length; j++) {
        if (obbOverlap(lotObb(plan.lots[i]), lotObb(plan.lots[j]), 0)) bad.push(`#${i}×#${j}`);
      }
    }
    add('no lot overlaps a lot', bad.length === 0, `${bad.length} overlaps`, bad);
  }

  // 5. Lot envelopes stay out of the road + kerb + run-off of EVERY part of
  // the loop. Brute force: every centreline sample against every rectangle.
  {
    let min = Infinity;
    const bad: string[] = [];
    const need = dims.edgeDressed + dims.runoff;
    for (const l of plan.lots) {
      const c = Math.cos(l.yaw);
      const s = Math.sin(l.yaw);
      let d = Infinity;
      for (let i = 0; i < frame.n; i++) {
        const j = (i + 1) % frame.n;
        for (let t = 0; t < 1; t += 0.25) {
          const dx = frame.px[i] + (frame.px[j] - frame.px[i]) * t - l.x;
          const dz = frame.pz[i] + (frame.pz[j] - frame.pz[i]) * t - l.z;
          const lx = Math.abs(dx * c - dz * s) - l.halfX;
          const lz = Math.abs(dx * s + dz * c) - l.halfZ;
          d = Math.min(d, Math.hypot(Math.max(lx, 0), Math.max(lz, 0)));
        }
      }
      if (d < min) min = d;
      if (d < need - 0.02) bad.push(`#${l.id} ${l.asset} ${fmt(d)} m`);
    }
    add(`lots clear of road corridor (≥ ${fmt(need)} m from centreline)`, bad.length === 0, `min ${fmt(min)} m`, bad);
  }

  // 6. Fronts look at the nearest road point.
  {
    const bad: string[] = [];
    let worst = 1;
    for (const l of plan.lots) {
      const hit = frame.nearest(l.x, l.z);
      const p = frame.at(hit.s);
      const [fx, fz] = frontOf(l.yaw);
      const dot = (fx * (p.x - l.x) + fz * (p.z - l.z)) / (hit.dist || 1);
      worst = Math.min(worst, dot);
      if (dot < 0.995) bad.push(`#${l.id} cos ${fmt(dot)}`);
    }
    add('lot fronts face the nearest road point', bad.length === 0, `min cos ${worst.toFixed(4)}`, bad);
  }

  // 7. Cut / fill of every flatten pad against natural ground.
  {
    let worst = 0;
    const bad: string[] = [];
    for (const m of plan.terrainModifiers) {
      if (m.kind !== 'flatten') continue;
      let cut = 0;
      let fill = 0;
      for (let lz = -m.halfZ; lz <= m.halfZ + 1e-6; lz += 0.5) {
        for (let lx = -m.halfX; lx <= m.halfX + 1e-6; lx += 0.5) {
          const [wx, wz] = toWorld(m.x, m.z, m.yaw, lx, lz);
          const h = base.getHeight(wx, wz);
          cut = Math.max(cut, h - m.height);
          fill = Math.max(fill, m.height - h);
        }
      }
      const w = Math.max(cut, fill);
      worst = Math.max(worst, w);
      if (w > CUT_FILL_LIMIT) bad.push(`#${m.lot} cut ${fmt(cut)} fill ${fmt(fill)}`);
    }
    add(`cut / fill ≤ ${CUT_FILL_LIMIT} m per lot`, bad.length === 0, `max ${fmt(worst)} m`, bad);
  }

  // 8. Paved pads stay off the carriageway and off other lots.
  {
    const bad: string[] = [];
    plan.pads.forEach((pad, i) => {
      for (const [x, z] of pad.polygon) {
        const d = frame.nearest(x, z).dist;
        if (d < hw - 0.05) bad.push(`pad ${i} (${pad.role}) vertex ${fmt(d)} m from centreline`);
      }
      const sharers = pad.role === 'square' ? [plan.village.hallLot, plan.village.marketLot] : [];
      for (const l of plan.lots) {
        if (l.id === pad.lot || sharers.includes(l.id)) continue;
        const corners = lotCorners(l);
        if (pad.polygon.some(([x, z]) => pointInPolygon(corners, x, z))) bad.push(`pad ${i} (${pad.role}) enters lot #${l.id}`);
        // And the other way round: a lot standing on the paving (its
        // outline sampled every half meter, and its centre).
        let on = pointInPolygon(pad.polygon, l.x, l.z);
        for (let c = 0; c < 4 && !on; c++) {
          const [ax, az] = corners[c];
          const [bx, bz] = corners[(c + 1) % 4];
          const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5);
          for (let k = 0; k < n && !on; k++) on = pointInPolygon(pad.polygon, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
        }
        if (on) bad.push(`lot #${l.id} stands on pad ${i} (${pad.role})`);
      }
    });
    add('pads off the road and off other lots', bad.length === 0, `${plan.pads.length} pads`, bad);
  }

  // 9. Dressing: nothing on the road or its kerb; nothing solid in the
  // run-off; nothing solid on a door path; only yard furniture on pads.
  {
    const onRoad: string[] = [];
    const inRunoff: string[] = [];
    const onPath: string[] = [];
    let minEdge = Infinity;
    for (const p of plan.dressing) {
      const e = catalogEntry(p.asset);
      if (p.role === 'start-gantry') {
        const hit = frame.nearest(p.x, p.z);
        if (hit.dist > 0.05 || GANTRY_HALF_OPENING < hw + kerbAt(hit.s) - 0.01) onRoad.push(`gantry opening ${GANTRY_HALF_OPENING} < ${fmt(hw + kerbAt(hit.s))}`);
        continue;
      }
      // Long items: test both ends and the middle of their length.
      // (A flag pole is 2 m "wide" only because of its cloth: thin things
      // with a small collider are points.)
      const long = e.size[0] > 1.2 && (e.collisionRadius > 0.6 || e.collisionRadius === 0);
      const half = long ? (e.size[0] * p.scale) / 2 - 0.1 : 0;
      const thick = long ? Math.min(e.size[2] / 2, 0.15) : Math.min(e.collisionRadius, 0.45);
      let d = Infinity;
      let s = 0;
      for (const lx of half > 0 ? [-half, 0, half] : [0]) {
        const [wx, wz] = toWorld(p.x, p.z, p.yaw, lx, 0);
        const hit = frame.nearest(wx, wz);
        if (hit.dist < d) {
          d = hit.dist;
          s = hit.s;
        }
      }
      const edge = hw + kerbAt(s);
      const clear = d - thick - edge;
      if (clear < -0.02) onRoad.push(`${p.asset} (${p.role}) ${fmt(clear)} m`);
      if (e.collisionRadius > 0) {
        minEdge = Math.min(minEdge, clear);
        if (clear < dims.runoff - 0.05) inRunoff.push(`${p.asset} (${p.role}) ${fmt(clear)} m`);
      }
      if (e.collisionRadius > 0) {
        for (const pad of plan.pads) {
          if (!pointInPolygon(pad.polygon, p.x, p.z)) continue;
          const deep = polygonEdgeDistance(pad.polygon, p.x, p.z);
          if (pad.role === 'path' && deep > 0.05) onPath.push(`${p.asset} on path of lot #${pad.lot}`);
          // Chevrons may front a square (as in the vision) but never the garage doors.
          const barred = pad.role === 'apron' ? ['fence', 'chevron', 'bend-tires', 'retaining-wall'] : ['fence', 'bend-tires', 'retaining-wall'];
          if (pad.joinsRoad && deep > 0.6 && barred.includes(p.role)) onPath.push(`${p.asset} (${p.role}) on ${pad.role}`);
          if (p.role === 'street-lamp' || (p.role === 'fence' && deep > 0.15)) onPath.push(`${p.asset} (${p.role}) on ${pad.role} of lot #${pad.lot}`);
        }
      }
    }
    add('dressing off road and kerbs', onRoad.length === 0, `${plan.dressing.length} items`, onRoad);
    add(`solid dressing outside ${dims.runoff} m run-off`, inRunoff.length === 0, `min ${fmt(minEdge)} m beyond kerb`, inRunoff);
    add('entrances and pads not blocked', onPath.length === 0, `${onPath.length} blockers`, onPath);
  }

  // 9b. The start line: marked, and what marks it stands clear of the road
  // (every leg of the loop), of paving, and of every door path.
  {
    const bad: string[] = [];
    const gantry = plan.dressing.find((p) => p.role === 'start-gantry');
    const flags = plan.dressing.filter((p) => p.role === 'start-flag').length;
    let clear = Infinity;
    if (plan.road.startLine.marker === 'gantry') {
      if (!gantry) bad.push('marker says gantry, none placed');
      else {
        for (const [x, z, r] of discsOf(gantry)) {
          const d = frame.nearest(x, z).dist - r - hw;
          clear = Math.min(clear, d);
          if (d < 0.3 - 0.01) bad.push(`plinth ${fmt(d)} m from the road edge`);
          for (const pad of plan.pads) {
            if (pointInPolygon(pad.polygon, x, z) || polygonEdgeDistance(pad.polygon, x, z) < r) bad.push(`plinth on the ${pad.role} of lot #${pad.lot}`);
          }
        }
      }
    } else {
      if (gantry) bad.push('marker says flags, a gantry is placed');
      if (flags === 0) bad.push('no gantry and no flag at the start line');
    }
    // The line itself is not paved over by an apron or a square.
    for (const o of plan.road.kerbs) {
      if (o.style === 'flush' && frame.wrap(0 - (o.s0 - 1)) <= frame.wrap(o.s1 - o.s0) + 2) bad.push(`flush kerb (a pad) across the start line, side ${o.side}`);
    }
    add('start line: marked, marker clear of road / pads', bad.length === 0, plan.road.startLine.marker === 'gantry' ? `gantry, plinths ${fmt(clear)} m off the road` : `flags only (${flags})`, bad);
  }

  // 9c. Door paths: from every fenced lot's door to the road edge nothing
  // solid stands within half a meter of the path's axis — fence ends,
  // lamps, boards, the gantry's plinths.
  {
    const bad: string[] = [];
    let min = Infinity;
    const solids: { x: number; z: number; r: number; p: Placement }[] = [];
    for (const p of plan.dressing) for (const [x, z, r] of discsOf(p)) solids.push({ x, z, r, p });
    for (const l of plan.lots) {
      if (!l.entrance) continue;
      const [ax, az] = toWorld(l.x, l.z, l.yaw, 0, -l.halfZ);
      const dist = Math.hypot(l.x - l.roadPoint[0], l.z - l.roadPoint[1]) || 1;
      const bx = l.roadPoint[0] + ((l.x - l.roadPoint[0]) / dist) * hw;
      const bz = l.roadPoint[1] + ((l.z - l.roadPoint[1]) / dist) * hw;
      for (const sd of solids) {
        const d = segmentDistance(ax, az, bx, bz, sd.x, sd.z) - sd.r;
        if (d < min) min = d;
        if (d < 0.5) bad.push(`#${l.id}: ${sd.p.asset} (${sd.p.role}) ${fmt(d)} m from the path axis`);
      }
    }
    add('door paths clear to the road (≥ 0.5 m either side)', bad.length === 0, `min ${fmt(min)} m`, bad);
  }

  // 9d. Kerbs: every half meter of both sides belongs to exactly one
  // section; flush where a pad joins the road and nowhere else.
  {
    const bad: string[] = [];
    for (const side of [1, -1] as const) {
      let gaps = 0;
      let doubles = 0;
      for (let s = 0.25; s < frame.length; s += 0.5) {
        let n = 0;
        for (const kb of plan.road.kerbs) if (kb.side === side && frame.inRange(s, kb.s0, kb.s1)) n++;
        if (n === 0) gaps++;
        // (A sample exactly on a joint belongs to both neighbours.)
        if (n > 2) doubles++;
        else if (n === 2 && !plan.road.kerbs.some((kb) => kb.side === side && (Math.abs(frame.delta(kb.s0, s)) < 0.3 || Math.abs(frame.delta(kb.s1, s)) < 0.3))) doubles++;
      }
      if (gaps) bad.push(`side ${side}: ${gaps * 0.5} m without kerb`);
      if (doubles) bad.push(`side ${side}: ${doubles * 0.5} m covered twice`);
    }
    const flush = plan.road.kerbs.filter((kb) => kb.style === 'flush');
    const joined = plan.pads.filter((pad) => pad.joinsRoad);
    if (flush.length < joined.length) bad.push(`${joined.length} pads join the road, ${flush.length} flush kerbs`);
    for (const kb of flush) {
      const span = frame.wrap(kb.s1 - kb.s0);
      const mid = kb.s0 + span / 2;
      // Paving behind it, a meter in from the road edge, along most of its
      // length (its ends overshoot the pad by design, and on the inside of
      // a hairpin the pad's edge cuts the corner).
      let fronted = 0;
      let probes = 0;
      for (let u = 1; u <= span - 1; u += 0.5, probes++) {
        const [x, z] = frame.offset(kb.s0 + u, kb.side * (hw + 1));
        if (joined.some((pad) => pointInPolygon(pad.polygon, x, z))) fronted++;
      }
      if (fronted < probes * 0.6) bad.push(`flush kerb at s=${fmt(frame.wrap(mid))} side ${kb.side} fronts no pad`);
      const want = inVillage(mid) ? dims.kerbDressed : dims.kerbRough;
      if (Math.abs(kb.width - want) > 1e-6) bad.push(`flush kerb at s=${fmt(frame.wrap(mid))} is ${kb.width} m wide, its surroundings ${want} m`);
    }
    add('kerbs cover both sides exactly once', bad.length === 0, `${plan.road.kerbs.length} sections, ${flush.length} flush`, bad);
  }

  // 9e. Composition goals (advisory): the garage by the start line, the
  // hall and the market on one square.
  {
    const garage = plan.lots[plan.village.garageLot];
    const hall = plan.lots[plan.village.hallLot];
    const market = plan.lots[plan.village.marketLot];
    if (garage) {
      const ds = Math.abs(frame.delta(0, garage.s));
      add('garage within 30 m of the start line', ds <= 30, `${fmt(ds)} m, ${garage.side === -1 ? 'right' : 'left'}`, [], true);
    }
    if (hall && market) {
      const squares = plan.pads.filter((pad) => pad.role === 'square').length;
      const d = Math.hypot(hall.x - market.x, hall.z - market.z);
      add('hall and market share one square', squares === 1 && hall.side === market.side, `${squares} square${squares === 1 ? '' : 's'}, ${fmt(d)} m apart`, [], true);
    }
  }

  // 10. Fence: present on both sides, gates open, banners every 3rd–4th.
  {
    const fence = plan.dressing.filter((p) => p.role === 'fence');
    const banners = fence.filter((p) => p.scheme === 'banner').length;
    const ratio = banners / Math.max(1, fence.length);
    const blocked: string[] = [];
    for (const l of plan.lots) {
      if (!l.entrance) continue;
      for (const f of fence) {
        // A 2.4 m segment within 1.15 m of the gate centre crosses the path.
        if (Math.hypot(f.x - l.entrance[0], f.z - l.entrance[1]) < 1.15) blocked.push(`gate of #${l.id}`);
      }
    }
    const sides = new Set(fence.map((f) => frame.nearest(f.x, f.z).side));
    add('fence on both sides, banner every 3rd–4th', sides.size === 2 && ratio > 0.2 && ratio < 0.4, `${fence.length} segments, ${(ratio * 100).toFixed(0)} % banner`);
    add('every gate open', blocked.length === 0, `${plan.lots.filter((l) => l.entrance).length} gates`, blocked);
  }

  // 10b. Checker banners against the fence: each stake (d21: two stakes
  // 1.86 m apart, 0.19 m square under their caps) at least 0.15 m from
  // every fence segment's box (pitch × scale, plus the capped post's 0.1 m
  // overhang, × the catalog depth), and no banner cloth in front of a panel
  // that hangs its own banner cloth.
  {
    const banners = plan.dressing.filter((p) => p.asset === 'd21-checker-banner');
    const fence = plan.dressing.filter((p) => p.role === 'fence');
    const STAKE_X = BANNER_STAKE_X;
    const STAKE_HALF = BANNER_STAKE_HALF;
    const clothHalf = catalogEntry('d21-checker-banner').size[0] / 2;
    const fenceE = catalogEntry('d07-wood-fence');
    const bad: string[] = [];
    let minGap = Infinity;
    for (const b of banners) {
      const at = frame.nearest(b.x, b.z).s;
      for (const f of fence) {
        if (Math.hypot(f.x - b.x, f.z - b.z) > fenceE.size[0] * f.scale + clothHalf + 1) continue;
        const span = (fenceE.size[0] / 2) * f.scale;
        for (const sx of [-STAKE_X, STAKE_X]) {
          const [px, pz] = toWorld(b.x, b.z, b.yaw, sx, 0);
          const [lx, lz] = toLocal(f.x, f.z, f.yaw, px, pz);
          const gap = Math.hypot(Math.max(Math.abs(lx) - span - 0.1, 0), Math.max(Math.abs(lz) - fenceE.size[2] / 2, 0)) - STAKE_HALF;
          minGap = Math.min(minGap, gap);
          if (gap < 0.15) bad.push(`banner at s=${fmt(at)}: stake ${fmt(gap)} m from a fence segment`);
        }
        if (f.scheme === 'banner') {
          const [la, za] = toLocal(f.x, f.z, f.yaw, ...toWorld(b.x, b.z, b.yaw, -clothHalf, 0));
          const [lb, zb] = toLocal(f.x, f.z, f.yaw, ...toWorld(b.x, b.z, b.yaw, clothHalf, 0));
          const overlap = Math.min(Math.max(la, lb), span) - Math.max(Math.min(la, lb), -span);
          if (overlap > 0 && Math.min(Math.abs(za), Math.abs(zb)) < 1) bad.push(`banner at s=${fmt(at)} in front of a banner panel (${fmt(overlap)} m)`);
        }
      }
    }
    add('checker banners: stakes ≥ 0.15 m off the fence, none before a banner panel', bad.length === 0, banners.length ? `${banners.length} banners, stakes ≥ ${fmt(minGap)} m off` : 'no banners', bad);
  }

  // 10d. One fence row: no two fence segments within 1.2 m centre to centre
  // (neighbours in a run are a pitch, ≥ 2.16 m, apart; two runs laid over
  // each other, or 0.25 m apart where only one is set back, come closer).
  {
    const fence = plan.dressing.filter((p) => p.role === 'fence');
    const bad: string[] = [];
    let min = Infinity;
    for (let i = 0; i < fence.length; i++) {
      for (let j = i + 1; j < fence.length; j++) {
        const d = Math.hypot(fence[i].x - fence[j].x, fence[i].z - fence[j].z);
        min = Math.min(min, d);
        if (d < 1.2) bad.push(`fence segments ${fmt(d)} m apart at s=${fmt(frame.nearest(fence[i].x, fence[i].z).s)}`);
      }
    }
    add('fence: one row, segments ≥ 1.2 m apart', bad.length === 0, fence.length ? `${fence.length} segments, closest ${fmt(min)} m` : 'no fence', bad);
  }

  // 10e. One fence row, along too: no fence panel (catalog length × its
  // scale) lies more than 0.2 m along on another panel standing within
  // 0.4 m of its line. Centres half a pitch apart pass 10d and still put
  // half a panel on its neighbour; neighbours in a run overlap by mm.
  {
    const fence = plan.dressing.filter((p) => p.role === 'fence');
    const len = catalogEntry('d07-wood-fence').size[0];
    const bad: string[] = [];
    let worst = -Infinity;
    for (let i = 0; i < fence.length; i++) {
      const a = fence[i];
      for (let j = i + 1; j < fence.length; j++) {
        const b = fence[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) > len * 1.5) continue;
        const o = panelOverlap(a.x, a.z, a.yaw, (len * a.scale) / 2, b.x, b.z, b.yaw, (len * b.scale) / 2);
        if (o.across >= 0.4) continue;
        worst = Math.max(worst, o.along);
        if (o.along > 0.2) bad.push(`fence panels overlap ${fmt(o.along)} m along (${fmt(o.across)} m across) at s=${fmt(frame.nearest(a.x, a.z).s)}`);
      }
    }
    add('fence: no panel lies on another (overlap along ≤ 0.2 m)', bad.length === 0, fence.length ? `${fence.length} segments, largest overlap ${fmt(Math.max(worst, 0))} m` : 'no fence', bad);
  }

  // 10c. Tool chests (d20) at the race garage: at least one, and none in
  // front of a bay: the cabinet (catalog footprint, as placed) at least
  // 0.3 m along the front from either bay opening (GARAGE_BAY_X ±
  // GARAGE_BAY_WIDTH / 2) wherever any of it stands ahead of the façade.
  {
    const e = catalogEntry('d20-tool-chest');
    const bays: [number, number][] = [
      [-GARAGE_BAY_X - GARAGE_BAY_WIDTH / 2, -GARAGE_BAY_X + GARAGE_BAY_WIDTH / 2],
      [GARAGE_BAY_X - GARAGE_BAY_WIDTH / 2, GARAGE_BAY_X + GARAGE_BAY_WIDTH / 2],
    ];
    const bad: string[] = [];
    let min = Infinity;
    let count = 0;
    for (const lot of plan.lots) {
      if (lot.asset !== 'b07-race-garage') continue;
      const chests = plan.dressing.filter((p) => p.asset === 'd20-tool-chest' && p.lot === lot.id);
      count += chests.length;
      if (chests.length === 0) bad.push(`garage #${lot.id} has no tool chest`);
      for (const c of chests) {
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([a, b]) => toLocal(lot.x, lot.z, lot.yaw, ...toWorld(c.x, c.z, c.yaw, (a * e.size[0] * c.scale) / 2, (b * e.size[2] * c.scale) / 2)));
        const x0 = Math.min(...corners.map((q) => q[0]));
        const x1 = Math.max(...corners.map((q) => q[0]));
        const z0 = Math.min(...corners.map((q) => q[1]));
        if (z0 >= -lot.bodyHalfZ) continue;
        for (const [b0, b1] of bays) {
          const gap = Math.max(b0 - x1, x0 - b1);
          min = Math.min(min, gap);
          if (gap < 0.3) bad.push(`chest at garage-local x ${fmt((x0 + x1) / 2)}: ${fmt(gap)} m from a bay`);
        }
      }
    }
    add('tool chests at the garage, ≥ 0.3 m clear of its bays', bad.length === 0, `${count} chests, ${fmt(min)} m from a bay`, bad);
  }

  // 11. Street lamps: one per 16–20 m of village road, on both sides.
  {
    const lamps = plan.dressing.filter((p) => p.role === 'street-lamp');
    const per = plan.village.length / Math.max(1, lamps.length);
    const sides = new Set(lamps.map((f) => frame.nearest(f.x, f.z).side));
    add('street lamps every 16–20 m, both sides', per >= 15 && per <= 24 && sides.size === 2, `${lamps.length} lamps, one per ${fmt(per)} m`);
  }

  // 12. Chevrons: 2–4 per bend, on the outside, facing the traffic,
  // arrows pointing the way the road turns.
  {
    const boards = plan.dressing.filter((p) => p.role === 'chevron');
    const perBend = plan.bends.map(() => 0);
    const bad: string[] = [];
    for (const b of boards) {
      const hit = frame.nearest(b.x, b.z);
      // A board belongs to the bend it stands beside, or whose approach
      // (up to 7 m before the entry) or exit (3 m) it stands on.
      const bi = plan.bends.findIndex((bend) => frame.wrap(hit.s - (bend.s0 - 7)) <= frame.wrap(bend.s1 - bend.s0) + 10);
      if (bi < 0) {
        bad.push(`board at s=${fmt(hit.s)} belongs to no bend`);
        continue;
      }
      perBend[bi]++;
      const bend = plan.bends[bi];
      const outside = bend.direction === 'left' ? -1 : 1;
      if (hit.side !== outside) bad.push(`board at s=${fmt(hit.s)} on the inside`);
      if (b.scheme !== bend.direction) bad.push(`board at s=${fmt(hit.s)} points ${b.scheme}, bend turns ${bend.direction}`);
      const [fx, fz] = frontOf(b.yaw);
      const p = frame.at(hit.s);
      // Faces the traffic: a car 8 m and 16 m short of the board is on the
      // printed side of it, and the board is turned against the direction
      // of travel where it stands (not merely parallel to the road).
      for (const back of [8, 16]) {
        const car = frame.at(hit.s - back);
        if (fx * (car.x - b.x) + fz * (car.z - b.z) <= 0) bad.push(`board at s=${fmt(hit.s)} shows its back to a car ${back} m before it`);
      }
      if (fx * -p.tx + fz * -p.tz <= 0.05) bad.push(`board at s=${fmt(hit.s)} not turned toward traffic`);
      // And toward the road, not the field.
      if (fx * (p.x - b.x) + fz * (p.z - b.z) <= 0) bad.push(`board at s=${fmt(hit.s)} faces the field`);
    }
    perBend.forEach((n, i) => {
      if (n < 2 || n > 4) bad.push(`bend ${i} (R ${fmt(plan.bends[i].minRadius)}) has ${n}`);
    });
    add('chevrons: 2–4 per bend, outside, facing traffic', bad.length === 0, `${boards.length} boards on ${plan.bends.length} bends`, bad);
  }

  // 12b. Trees frame the village street (the vision has roughly twenty
  // within 12 m of the road per 100 m; an empty street is a defect).
  {
    let n = 0;
    for (const p of plan.nature) {
      if (natureClass(p.asset) !== 'trees' || frame.fastDist(p.x, p.z) > hw + 12) continue;
      const hit = frame.nearest(p.x, p.z);
      if (hit.dist <= hw + 12 && inVillage(hit.s)) n++;
    }
    const per = (n / plan.village.length) * 100;
    add('trees frame the village street (≥ 10 per 100 m within 12 m)', per >= 10, `${per.toFixed(1)} per 100 m`);
  }

  // 13. Instance budgets.
  {
    const s = plan.stats;
    const rows: [string, number, [number, number]][] = [
      ['trees', s.trees, budgets.trees],
      ['bushes', s.bushes, budgets.bushes],
      ['low plants', s.lowPlants, budgets.lowPlants],
      ['large rocks', s.largeRocks, budgets.largeRocks],
      ['small rocks', s.smallRocks, budgets.smallRocks],
    ];
    for (const [name, n, [lo, hi]] of rows) add(`${name} within ${lo}–${hi}`, n >= lo && n <= hi, String(n));
  }

  // 14. Nature clearances.
  {
    const onRoad: string[] = [];
    const tooClose: string[] = [];
    const inLot: string[] = [];
    let minSolid = Infinity;
    const corners = plan.lots.map(lotCorners);
    for (const p of plan.nature) {
      const e = catalogEntry(p.asset);
      const d = frame.fastDist(p.x, p.z);
      if (d < 20) {
        const hit = frame.nearest(p.x, p.z);
        const edge = hw + kerbAt(hit.s);
        if (hit.dist < edge - 0.02) onRoad.push(`${p.asset} ${fmt(hit.dist - edge)} m`);
        if (e.collisionRadius > 0) {
          const clear = hit.dist - e.collisionRadius * p.scale - edge;
          minSolid = Math.min(minSolid, clear);
          if (clear < 2.5 - 0.1) tooClose.push(`${p.asset} ${fmt(clear)} m`);
        }
      }
      for (let i = 0; i < corners.length; i++) {
        if (Math.abs(p.x - plan.lots[i].x) > 12 || Math.abs(p.z - plan.lots[i].z) > 12) continue;
        if (pointInPolygon(corners[i], p.x, p.z)) inLot.push(`${p.asset} in lot #${i}`);
      }
      for (const pad of plan.pads) {
        if (Math.abs(p.x - pad.polygon[0][0]) > 30 || Math.abs(p.z - pad.polygon[0][1]) > 30) continue;
        if (pointInPolygon(pad.polygon, p.x, p.z)) inLot.push(`${p.asset} on ${pad.role} of #${pad.lot}`);
      }
    }
    add('nature off road and kerbs', onRoad.length === 0, `${plan.nature.length} items`, onRoad);
    add('trees and large rocks ≥ 2.5 m beyond the kerb', tooClose.length === 0, `min ${fmt(minSolid)} m`, tooClose);
    add('nothing growing inside lots or on pads', inLot.length === 0, `${inLot.length} intruders`, inLot);
  }

  // 15. Placement heights match the terrain after the modifiers, applied
  // here from scratch to a fresh copy of the input.
  {
    const ground = copyHeightfield(input.heightfield);
    applyTerrainModifiers(ground, plan.terrainModifiers, input.track, { roadHalfWidth: hw });
    let worst = 0;
    const all: Placement[] = [...plan.dressing.filter((p) => p.role !== 'start-gantry'), ...plan.nature];
    for (const p of all) worst = Math.max(worst, Math.abs(p.y - ground.getHeight(p.x, p.z)));
    // And the pads really are level where the buildings stand.
    let padErr = 0;
    for (const l of plan.lots) {
      for (const [lx, lz] of [
        [0, 0],
        [l.halfX, l.halfZ],
        [-l.halfX, l.halfZ],
        [l.halfX, -l.halfZ],
        [-l.halfX, -l.halfZ],
      ]) {
        const [wx, wz] = toWorld(l.x, l.z, l.yaw, lx, lz);
        padErr = Math.max(padErr, Math.abs(ground.getHeight(wx, wz) - l.y));
      }
    }
    add('placement y = modified terrain', worst < 0.002, `max error ${(worst * 1000).toFixed(1)} mm`);
    add('pads level under every building', padErr < 0.05, `max error ${(padErr * 1000).toFixed(0)} mm`);
  }

  // 16. Every placement is well-formed against the catalog.
  {
    const bad: string[] = [];
    const known = new Set(CATALOG.map((e) => e.id));
    const visit = (asset: string, seed: number, scheme: string | undefined, scale: number, nums: number[]): void => {
      if (!known.has(asset)) {
        bad.push(`unknown asset ${asset}`);
        return;
      }
      const e = catalogEntry(asset);
      if (!Number.isInteger(seed) || seed < 0 || seed >= e.variants) bad.push(`${asset} seed ${seed}`);
      if (scheme !== undefined && !(e.schemes ?? []).includes(scheme)) bad.push(`${asset} scheme ${scheme}`);
      const tree = e.category === 'tree';
      if (scale < (tree ? 0.75 : 0.7) || scale > (tree ? 1.35 : 1.25)) bad.push(`${asset} scale ${scale}`);
      if (nums.some((v) => !Number.isFinite(v))) bad.push(`${asset} has a non-finite number`);
    };
    for (const l of plan.lots) visit(l.asset, l.seed, l.scheme, 1, [l.x, l.y, l.z, l.yaw]);
    for (const p of [...plan.dressing, ...plan.nature]) {
      visit(p.asset, p.seed, p.scheme, p.scale, [p.x, p.y, p.z, p.yaw, ...p.tint]);
      if (Math.max(Math.abs(p.x), Math.abs(p.z)) > plan.worldSize / 2) bad.push(`${p.asset} outside the world at ${fmt(p.x)}, ${fmt(p.z)}`);
    }
    const classes = plan.nature.filter((p) => natureClass(p.asset) === null).length;
    if (classes > 0) bad.push(`${classes} nature placements of a non-nature asset`);
    add('placements well-formed (ids, seeds, schemes, scales)', bad.length === 0, `${plan.lots.length + plan.dressing.length + plan.nature.length} placements`, bad);
  }

  return results;
}

function lotCorners(l: Lot): [number, number][] {
  return [
    toWorld(l.x, l.z, l.yaw, -l.halfX, -l.halfZ),
    toWorld(l.x, l.z, l.yaw, l.halfX, -l.halfZ),
    toWorld(l.x, l.z, l.yaw, l.halfX, l.halfZ),
    toWorld(l.x, l.z, l.yaw, -l.halfX, l.halfZ),
  ];
}

export interface SelfCheckRun {
  plan: WorldPlan;
  checks: CheckResult[];
  /** Planning time of the fastest of four runs, ms. */
  ms: number;
}

/**
 * Plan repeatedly, verify the plans are byte-identical, time it, and run
 * every check. The lab page prints this; a headless sweep calls it per seed.
 */
export function runSelfChecks(input: WorldPlanInput, timeLimitMs = 100): SelfCheckRun {
  const now = (): number => performance.now();
  let t = now();
  const plan = planWorld(input);
  let ms = now() - t;
  t = now();
  const again = planWorld(input);
  ms = Math.min(ms, now() - t);
  // Best of four: one run can be anything on a busy machine or a cold JIT.
  for (let i = 0; i < 2; i++) {
    t = now();
    planWorld(input);
    ms = Math.min(ms, now() - t);
  }
  const a = JSON.stringify(plan);
  const checks = checkWorldPlan(plan, input);
  checks.push({ name: 'same input → byte-identical plan', pass: a === JSON.stringify(again), value: `${(a.length / 1024).toFixed(0)} kB JSON` });
  checks.push({ name: 'plan carries no warnings', pass: plan.warnings.length === 0, value: String(plan.warnings.length), detail: plan.warnings.length ? plan.warnings.join('; ') : undefined, advisory: true });
  checks.push({ name: `planning time < ${timeLimitMs} ms`, pass: ms < timeLimitMs, value: `${ms.toFixed(1)} ms` });
  return { plan, checks, ms };
}

export function formatChecks(checks: readonly CheckResult[]): string {
  const w = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${c.pass ? 'ok  ' : c.advisory ? 'note' : 'FAIL'} ${c.name.padEnd(w)}  ${c.value}${c.detail ? `\n       ${c.detail}` : ''}`).join('\n');
}
