import type { ViewMode } from './contracts/camera';
import type { MenuCarStats, MenuFlowModule } from './contracts/menu';
import type { GameOptions } from './options';
import { VIEW_MODES, optionsToQuery } from './options';
import { HANDLING_PRESETS } from '../car/handling';
import { rigFor } from '../car/rig';

/**
 * The menu's page-level plumbing (contract: `MenuFlowModule` in
 * src/game/contracts/menu.ts; spec: design-documents/menu-mockups/SPEC.md
 * sections 6, 9 and 10). Babylon-free and DOM-free: every storage and
 * `location` access goes through a `MenuFlowEnv`, so Node tests build their
 * own with `createMenuFlow(env)`; the named exports below use the browser's.
 *
 * Every storage access is in try / catch (private mode, blocked storage,
 * embedded webviews throw on ACCESS): a failed read = the default, a failed
 * write is ignored.
 *
 *   web-racer.menu.next          sessionStorage  'race'  one-shot landing flag
 *   web-racer.view               localStorage    chase | high | xr
 *   web-racer.musicVolume        localStorage    0 … 1, one decimal
 *   web-racer.bestLap.hills2-<s> localStorage    seconds (RaceState writes it)
 */

/** The part of `Storage` the menu uses. */
export interface MenuKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MenuFlowEnv {
  /** `localStorage`, or null (may throw: it is called inside try). */
  local(): MenuKeyValueStore | null;
  /** `sessionStorage`, or null (may throw). */
  session(): MenuKeyValueStore | null;
  /** `location.search = search` (search starts with '?'). */
  assignSearch(search: string): void;
}

export const MENU_NEXT_KEY = 'web-racer.menu.next';
export const VIEW_KEY = 'web-racer.view';
export const MUSIC_VOLUME_KEY = 'web-racer.musicVolume';
export const BEST_LAP_PREFIX = 'web-racer.bestLap.hills2-';

/** Seeds that fail a planner check (CLAUDE.md, known defects: 5038). */
export const BAD_SEEDS: readonly number[] = [5038];

/** RANDOM TRACK draws from 1 … RANDOM_SEED_MAX (the seeds with a village
 * guarantee, ≥ 12 lots on 1 … 1100). */
export const RANDOM_SEED_MAX = 1100;

/** The browser's storages and location (each access guarded by the caller). */
export const browserMenuEnv: MenuFlowEnv = {
  local: () => (globalThis as { localStorage?: MenuKeyValueStore }).localStorage ?? null,
  session: () => (globalThis as { sessionStorage?: MenuKeyValueStore }).sessionStorage ?? null,
  assignSearch: (search) => {
    const loc = (globalThis as { location?: { search: string } }).location;
    if (loc) loc.search = search;
  },
};

function read(store: () => MenuKeyValueStore | null, key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: () => MenuKeyValueStore | null, key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* quota or privacy mode: not persisted */
  }
}

function remove(store: () => MenuKeyValueStore | null, key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** Uniform in 1 … 1100 by `random` (uniform [0, 1)), never in `exclude` or
 * `BAD_SEEDS`. One draw, no rejection loop: the allowed seeds are counted and
 * the draw indexes them. Falls back to 1 … 1100 without `exclude` if that
 * would leave nothing (cannot happen with a short list). */
export function randomSeed(exclude: readonly number[], random: () => number): number {
  const banned = new Set<number>([...BAD_SEEDS, ...exclude]);
  let allowed = 0;
  for (let s = 1; s <= RANDOM_SEED_MAX; s++) if (!banned.has(s)) allowed++;
  if (allowed === 0) return 1;
  const r = random();
  const pick = Math.min(allowed - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * allowed)));
  let i = 0;
  for (let s = 1; s <= RANDOM_SEED_MAX; s++) {
    if (banned.has(s)) continue;
    if (i === pick) return s;
    i++;
  }
  return 1;
}

const pip = (x: number): number => Math.min(5, Math.max(1, Math.round(x)));

/**
 * Stat pips 1 … 5 (spec 3.2), from real data only: `s` =
 * `HANDLING_PRESETS[id].scale` (missing factor = 1), mass = `rigFor(id)`'s
 * all-in mass. An unknown id gets 3 everywhere (no preset, no rig).
 *   SPEED   3 + (s.maxSpeed − 1) × 25
 *   GRIP    3 + (s.grip × s.rearGripScale − 1) × 27
 *   AGILITY 3 + (s.steerRate / (s.minTurnRadius × s.yawInertiaScale) − 1) × 5.5
 *   WEIGHT  3 + (mass − 810) / 80
 */
export function carStats(carId: string): MenuCarStats {
  const s: Readonly<Record<string, number | undefined>> = HANDLING_PRESETS[carId]?.scale ?? {};
  const f = (k: string): number => s[k] ?? 1;
  let mass = 810;
  try {
    mass = rigFor(carId).totalMass;
  } catch {
    /* unknown design: neutral weight */
  }
  return {
    speed: pip(3 + (f('maxSpeed') - 1) * 25),
    grip: pip(3 + (f('grip') * f('rearGripScale') - 1) * 27),
    agility: pip(3 + (f('steerRate') / (f('minTurnRadius') * f('yawInertiaScale')) - 1) * 5.5),
    weight: pip(3 + (mass - 810) / 80),
  };
}

/** The menu's flow functions over `env` (tests pass their own). */
export function createMenuFlow(env: MenuFlowEnv = browserMenuEnv): MenuFlowModule {
  const local = (): MenuKeyValueStore | null => env.local();
  const session = (): MenuKeyValueStore | null => env.session();
  return {
    BAD_SEEDS,
    randomSeed,
    carStats,
    bestLapFor(seed: number): number | null {
      const raw = read(local, BEST_LAP_PREFIX + seed);
      const v = raw === null ? NaN : Number.parseFloat(raw);
      return Number.isFinite(v) && v > 0 ? v : null;
    },
    reloadWith(options: GameOptions, overrides: Partial<GameOptions>): void {
      // Flag first: if the write fails the reloaded page lands on the title.
      write(session, MENU_NEXT_KEY, 'race');
      // optionsToQuery returns the leading '?': assign it as is.
      env.assignSearch(optionsToQuery(options, overrides));
    },
    takeMenuNext(): 'race' | 'title' {
      const raw = read(session, MENU_NEXT_KEY);
      remove(session, MENU_NEXT_KEY);
      return raw === 'race' ? 'race' : 'title';
    },
    storedView(): ViewMode | null {
      const raw = read(local, VIEW_KEY);
      return raw !== null && (VIEW_MODES as readonly string[]).includes(raw) ? (raw as ViewMode) : null;
    },
    storeView(mode: ViewMode): void {
      write(local, VIEW_KEY, mode);
    },
    storedMusicVolume(): number | null {
      const raw = read(local, MUSIC_VOLUME_KEY);
      if (raw === null || raw.trim() === '') return null;
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 10) / 10 : null;
    },
    storeMusicVolume(v: number): void {
      if (!Number.isFinite(v)) return;
      write(local, MUSIC_VOLUME_KEY, String(Math.round(Math.min(1, Math.max(0, v)) * 10) / 10));
    },
  };
}

/** The browser's menu flow (localStorage, sessionStorage, location). */
export const menuFlow: MenuFlowModule = createMenuFlow(browserMenuEnv);

export const bestLapFor = menuFlow.bestLapFor;
export const reloadWith = menuFlow.reloadWith;
export const takeMenuNext = menuFlow.takeMenuNext;
export const storedView = menuFlow.storedView;
export const storeView = menuFlow.storeView;
export const storedMusicVolume = menuFlow.storedMusicVolume;
export const storeMusicVolume = menuFlow.storeMusicVolume;
