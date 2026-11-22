import { hash01 } from './RivalDriver';
import type { RivalTrack } from './RaceLine';

/**
 * Starting grid and field composition for a race with AI rivals.
 * Uses only the track polyline (no scene, no terrain, no vehicles).
 */

export interface GridPose {
  /** 0 = pole. */
  slot: number;
  row: number;
  /** −1 = left column, +1 = right column. */
  column: -1 | 1;
  /** Point on the road surface under the car's wheelbase centre — pass it
   * to `Vehicle.reset` (replace y with the terrain height if you have one:
   * `y` here is the track's smoothed road height). */
  x: number;
  y: number;
  z: number;
  /** Heading along the track at that point, rad. */
  yaw: number;
  /** Arc position relative to the start line, m (negative = behind it). */
  s: number;
  /** Offset from the centreline, m (+ = right). */
  lateral: number;
}

export interface GridOptions {
  /** Distance between two cars of the same column, m. Default 8. */
  rowSpacing?: number;
  /** Pole's wheelbase centre this far behind the line, m. Default 4. */
  firstRowBehind?: number;
  /** How far the right column sits behind the left, as a share of
   * rowSpacing (0 = side by side, 0.5 = classic stagger). Default 0.5. */
  stagger?: number;
  /** Column offset from the centreline as a share of the half-width.
   * Default 0.45; never closer than `edgeMargin` to the road edge. */
  lateralFraction?: number;
  /** Min distance from a column's centre to the road edge, m. Default 1.5. */
  edgeMargin?: number;
}

/**
 * 2 × N/2 staggered grid behind the start line (track point 0), following
 * the road if it bends there. Slot 0 is pole (left column, front); odd
 * slots are the right column, half a row further back.
 */
export function gridPoses(track: RivalTrack, count: number, options: GridOptions = {}): GridPose[] {
  const n = track.count;
  const rowSpacing = options.rowSpacing ?? 8;
  const first = options.firstRowBehind ?? 4;
  const stagger = options.stagger ?? 0.5;
  const half = track.halfWidth;
  const lateral = Math.max(0, Math.min(half * (options.lateralFraction ?? 0.45), half - (options.edgeMargin ?? 1.5)));
  const px = (i: number) => track.points[(((i % n) + n) % n) * 2];
  const pz = (i: number) => track.points[(((i % n) + n) % n) * 2 + 1];

  const poses: GridPose[] = [];
  for (let slot = 0; slot < count; slot++) {
    const row = Math.floor(slot / 2);
    const column: -1 | 1 = slot % 2 === 0 ? -1 : 1;
    const behind = first + row * rowSpacing + (column === 1 ? stagger * rowSpacing : 0);
    // Walk backward from the line along the polyline.
    let i = 0;
    let left = behind;
    let x = px(0);
    let z = pz(0);
    for (let guard = 0; guard < n; guard++) {
      const ax = px(i - 1);
      const az = pz(i - 1);
      const seg = Math.hypot(px(i) - ax, pz(i) - az);
      if (seg >= left && seg > 0) {
        const t = left / seg;
        x = px(i) + (ax - px(i)) * t;
        z = pz(i) + (az - pz(i)) * t;
        break;
      }
      left -= seg;
      i--;
    }
    // Heading from a chord across a few metres (single segments are noisy).
    const span = 3;
    let tx = px(i + span) - px(i - 1 - span);
    let tz = pz(i + span) - pz(i - 1 - span);
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const j = (((i - 1) % n) + n) % n;
    poses.push({
      slot,
      row,
      column,
      x: x + column * lateral * tz,
      y: track.roadHeights ? track.roadHeights[j] : 0,
      z: z - column * lateral * tx,
      yaw: Math.atan2(tx, tz),
      s: -behind,
      lateral: column * lateral,
    });
  }
  return poses;
}

// ---------------------------------------------------------------------------

/** The four car designs of the game (src/car/rig.ts CAR_SPECS). */
export const RACE_CAR_IDS: readonly string[] = ['reef-rocket', 'neon-wasp', 'riot-ram', 'comet-fox'];

export interface FieldEntry {
  /** Unique within the race: 'player' or 'rival-1'… */
  id: string;
  /** Car design (rig + handling preset). */
  carId: string;
  /** 0..1; null for the player. */
  skill: number | null;
  /** Driver personality seed; 0 for the player. */
  seed: number;
  /** Grid slot (index into gridPoses). */
  slot: number;
  isPlayer: boolean;
}

export interface FieldOptions {
  /** The player's car design; null/undefined = an all-AI field. */
  playerCarId?: string | null;
  /** Number of AI cars. Default 3 (four cars on the grid with the player). */
  rivals?: number;
  /** 0..1 centre of the rivals' skills. Default 0.6. */
  difficulty?: number;
  /** Half the range of skills around the difficulty. Default 0.2, so the
   * default field is skill 0.4 / 0.6 / 0.8. */
  spread?: number;
  /** Changes who gets which car, skill and personality. Default 1. */
  seed?: number;
  /** Car designs to hand out. Default: the four game cars. */
  designs?: readonly string[];
  /** Where the player starts: 'back' (default — the gameplay vision's
   * "4 / 4" start), 'front', or a slot index. */
  playerSlot?: 'back' | 'front' | number;
  /** 'reverse' (default): the quickest rival starts furthest back, so the
   * field mixes instead of stringing out. 'pace': quickest in front. */
  rivalOrder?: 'reverse' | 'pace';
}

/** One difficulty setting of the game (`?difficulty=easy|normal|hard`):
 * `difficulty` / `spread` go to buildField, `rubberBand` to RivalField. */
export interface DifficultyPreset {
  difficulty: number;
  spread: number;
  rubberBand: number;
}

/**
 * The game's three difficulty settings, chosen by measurement in the physics
 * lab (maneuver 'race', gates difficulty.easy / .normal / .hard): with the
 * player stand-ins of the lab (a careful driver, and a quick one that knows
 * the track — neither uses racecraft) —
 *  · easy: the careful driver finishes in the top two in at least half its
 *    races, on every car;
 *  · normal: the quick driver wins more than half of its races but not all;
 *    the careful one is not last in at least half;
 *  · hard: a rival beats the quick driver in at least 2 races of 8.
 */
// (re-measured after the rivals' launch lane
// hold went back to off (RivalParams.launchHold 0) — stand-ins hold their
// grid lane for up to 3 s and lift for the car ahead in it. Judged on four
// cars x THREE seed sets (1-8 and 41-48, plus 9-16 that were not used in
// earlier rounds), 8 races each, the gate per file:
// easy 0.2 / 0.2 — careful stand-in top two in 7-8 of 8 on all 12 files.
// normal 0.46 / 0.3 — quick stand-in wins 5-8 of 8 on every file (reef-rocket
// 5 / 5 / 6: no margin), beaten at least once on 4 / 4 / 3 cars, careful
// never last. Knife edge: 0.42 — beaten on only 2 cars on seeds 9-16 and
// 41-48 (comet-fox / neon-wasp win 7-8 of 8); 0.50 — reef-rocket and
// neon-wasp quick stand-ins win 1 of 8 on seeds 1-8 and 9-16.
// hard 0.72 / 0.2 — comet-fox is beaten in 5 / 5 / 2 of 8 (0.65: 2 / 3 / 1,
// 0.68: 4 / 3 / 0; an 8 % band: 0.65 — 1 / 1 / 2, 0.7 — 2 / 2 / 3), and at
// that strength the reef-rocket quick stand-in wins 1 / 0 / 1 of 8. Car
// balance: in solo laps (suite solo.k60, seeds 1-8) comet-fox is ~3.2 % and
// riot-ram ~1.7 % quicker than reef-rocket / neon-wasp, and a player's
// rivals drive the other designs, so one hard setting is either beatable on
// reef-rocket or a challenge on comet-fox, not both — the owner's call.
// Band at the field's default 4 % in all three.)
export const DIFFICULTY_PRESETS: { readonly easy: DifficultyPreset; readonly normal: DifficultyPreset; readonly hard: DifficultyPreset } = {
  easy: { difficulty: 0.2, spread: 0.2, rubberBand: 0.04 },
  normal: { difficulty: 0.46, spread: 0.3, rubberBand: 0.04 },
  hard: { difficulty: 0.72, spread: 0.2, rubberBand: 0.04 },
};

/**
 * Who races: one entry per car with its design, skill, personality seed and
 * grid slot. Rivals get the designs the player did not pick first (then the
 * list repeats), skills spread evenly around `difficulty`, and seeds derived
 * from `seed` — all deterministic.
 */
export function buildField(options: FieldOptions = {}): FieldEntry[] {
  const seed = options.seed ?? 1;
  const count = Math.max(0, Math.floor(options.rivals ?? 3));
  const difficulty = Math.min(1, Math.max(0, options.difficulty ?? 0.6));
  const spread = options.spread ?? 0.2;
  const designs = [...(options.designs ?? RACE_CAR_IDS)];
  const player = options.playerCarId ?? null;
  const total = count + (player ? 1 : 0);

  // Seeded shuffle of the designs, the player's own design last in line.
  const pool = designs
    .map((carId, i) => ({ carId, key: hash01(seed, 31 + i) + (carId === player ? 10 : 0) }))
    .sort((a, b) => a.key - b.key)
    .map((d) => d.carId);

  const rivals: Array<{ carId: string; skill: number; seed: number }> = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    rivals.push({
      carId: pool[i % pool.length],
      skill: Math.min(1, Math.max(0, difficulty + spread * (1 - 2 * t))),
      seed: 1 + Math.floor(hash01(seed, 91 + i) * 1e6),
    });
  }
  // rivals[] is quickest first; grid order as asked.
  const ordered = (options.rivalOrder ?? 'reverse') === 'reverse' ? [...rivals].reverse() : rivals;

  let playerSlot = -1;
  if (player) {
    const want = options.playerSlot ?? 'back';
    playerSlot = want === 'back' ? total - 1 : want === 'front' ? 0 : Math.min(total - 1, Math.max(0, Math.floor(want)));
  }
  const entries: FieldEntry[] = [];
  let next = 0;
  for (let slot = 0; slot < total; slot++) {
    if (slot === playerSlot) {
      entries.push({ id: 'player', carId: player!, skill: null, seed: 0, slot, isPlayer: true });
    } else {
      const r = ordered[next++];
      entries.push({ id: `rival-${next}`, carId: r.carId, skill: r.skill, seed: r.seed, slot, isPlayer: false });
    }
  }
  return entries;
}
