import type { ViewMode } from './contracts/camera';
import type { QualityName } from './contracts/quality';
import type { ShadowQuality } from '../gfx/look/lighting';
// grid.ts directly (not the ai index): it is Babylon-free, so this parser
// stays importable from plain Node.
import { DIFFICULTY_PRESETS } from '../car/ai/grid';
import type { DifficultyPreset } from '../car/ai/grid';

/**
 * The game page's URL parameters (table in CLAUDE.md). Every value is validated and
 * a bad or missing one falls back to its default — except `tune`: an entry
 * that is not `key:number` makes parseGameOptions throw, and a key the
 * vehicle model does not have stops the boot in createVehicle — both with a
 * message (a silently ignored tuning value would make an A/B
 * comparison meaningless). `optionsToQuery` writes the options back (only
 * what differs from the defaults) for the dev overlay's A/B links.
 */
export interface GameOptions {
  seed: number;
  terrain: 'hills' | 'flat';
  view: ViewMode;
  /** The PLAYER's vehicle model; rivals always run 'raycast'. */
  vehicle: string;
  car: string;
  livery: number;
  /** 0 = endless free run. */
  laps: number;
  rivals: number;
  /** 0..1, centre of the rivals' skill. */
  difficulty: number;
  quality: QualityName;
  /** null = the preset's shadow map. */
  shadows: ShadowQuality | null;
  tune: Record<string, number>;
  cuts: 'flash' | 'reset';
  countdown: boolean;
  autopilot: boolean;
  dev: boolean;
  perf: boolean;
  shot: boolean;
  /** Shot mode: seconds simulated before the picture. */
  at: number;
  /** The player's arc position on the track, m, or 'village' (null = the
   * grid). Honoured in every mode, used by shot pages. */
  spot: number | 'village' | null;
  report: boolean;
  /** Report mode: simulated seconds at most. */
  seconds: number;
  /** Report mode: boot like the live page (parallel shader compile, then
   * whenReadyAsync) instead of compiling synchronously — to measure the live
   * boot. `?liveboot=1`. */
  liveBoot: boolean;
  /** Render resolution in device pixels per CSS pixel, forced (`?dpr=`,
   * 0.25–4); null = the preset's rule (quality.renderRatio). */
  dpr: number | null;
  /** Far hills behind the terrain rim (`?backdrop=0` turns them
   * off, to measure what they cost). */
  backdrop: boolean;
}

export const VEHICLE_MODELS: readonly string[] = ['raycast', 'assist', 'hybrid', 'rigid'];
export const CAR_DESIGNS: readonly string[] = ['reef-rocket', 'neon-wasp', 'riot-ram', 'comet-fox'];
export const VIEW_MODES: readonly ViewMode[] = ['chase', 'high', 'xr'];

/**
 * Default world: seed 16, chosen by measurement for the vision's first
 * picture. A Node probe over seeds 1–300 put the chase camera on
 * the player's grid slot and scored the buildings 25–70 m ahead inside the
 * frame that the gantry's pillars, its banner and the verge trees leave in
 * view; the five best were shot on `high` and `quest`. Seed 16 ('lobe + high
 * hairpin', 14 buildings in the infield) opens like vision 1: the market
 * hall on the left beyond the gantry, the race garage with its wrench sign
 * 26 m ahead on the right, the water tower and the clock tower behind, hills
 * and clouds over the rim. (Seed 6, the old default, has its garage beside /
 * behind the grid; seed 205 shows the garage too but no market.) World sweep:
 * every rule passes.
 */
export const DEFAULT_SEED = 16;

/** `?difficulty=easy|normal|hard`: the measured presets. */
export const DIFFICULTY_NAMES: Readonly<Record<string, DifficultyPreset>> = DIFFICULTY_PRESETS;

/** Difficulty, skill spread and rubber band for `options.difficulty`: the
 * named preset with that difficulty, or a numeric `?difficulty=` with the
 * 'normal' preset's spread and rubber band. */
export function difficultyPreset(options: Pick<GameOptions, 'difficulty'>): DifficultyPreset {
  for (const preset of Object.values(DIFFICULTY_PRESETS)) if (preset.difficulty === options.difficulty) return preset;
  return { ...DIFFICULTY_PRESETS.normal, difficulty: options.difficulty };
}

export function defaultGameOptions(userAgent = ''): GameOptions {
  return {
    seed: DEFAULT_SEED,
    terrain: 'hills',
    // On a Quest the diorama view (the budgeted shipping view); an explicit
    // `?view=` always wins.
    view: isQuestAgent(userAgent) ? 'xr' : 'chase',
    vehicle: 'raycast',
    car: 'reef-rocket',
    livery: 0,
    laps: 3,
    rivals: 3,
    difficulty: DIFFICULTY_PRESETS.normal.difficulty,
    quality: isQuestAgent(userAgent) ? 'quest' : 'high',
    shadows: null,
    tune: {},
    cuts: 'flash',
    countdown: true,
    autopilot: false,
    dev: false,
    perf: false,
    shot: false,
    at: 1,
    spot: null,
    report: false,
    seconds: 90,
    liveBoot: false,
    dpr: null,
    backdrop: true,
  };
}

function int(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  const r = Math.round(v);
  return r < lo || r > hi ? fallback : r;
}

function real(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

function oneOf<T extends string>(raw: string | null, list: readonly T[], fallback: T): T {
  return raw !== null && (list as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function flag(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  if (raw === '1' || raw === 'true' || raw === '') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

/** `key:value,key:value` → record. An entry that is not `key:number` (no
 * key, `=` instead of `:`, an empty or non-numeric value, `;` as separator,
 * a decimal comma) THROWS — the boot stops with the message, exactly like
 * an unknown key does in createVehicle: a silently dropped entry would boot
 * a stock car the A/B believes is tuned. Empty entries (a trailing comma)
 * are skipped. */
function parseTune(raw: string | null): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!raw) return out;
  for (const part of raw.split(',')) {
    if (part.trim() === '') continue;
    const i = part.indexOf(':');
    const key = i > 0 ? part.slice(0, i).trim() : '';
    const rawValue = i > 0 ? part.slice(i + 1).trim() : '';
    const value = Number(rawValue);
    if (!/^[A-Za-z_$][\w$]*$/.test(key) || rawValue === '' || !Number.isFinite(value)) {
      throw new Error(`tune entry '${part}' in tune='${raw}' is not key:number (write tune=key:value,key:value, e.g. tune=grip:1.3,maxSpeed:22)`);
    }
    out[key] = value;
  }
  return out;
}

/** Quest browser user agent (the `quest` preset and the diorama view by default). */
export function isQuestAgent(userAgent: string): boolean {
  return /OculusBrowser|Quest/i.test(userAgent);
}

export function parseGameOptions(search: string, userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): GameOptions {
  const p = new URLSearchParams(search);
  const d = defaultGameOptions(userAgent);
  const shadowsRaw = p.get('shadows');
  const difficultyRaw = p.get('difficulty');
  const spotRaw = p.get('spot');
  let spot: GameOptions['spot'] = null;
  if (spotRaw === 'village') spot = 'village';
  else if (spotRaw !== null && spotRaw.trim() !== '' && Number.isFinite(Number(spotRaw))) spot = Number(spotRaw);
  return {
    seed: int(p.get('seed'), 1, 2 ** 31 - 1, d.seed),
    terrain: oneOf(p.get('terrain'), ['hills', 'flat'] as const, d.terrain),
    view: oneOf(p.get('view'), VIEW_MODES, d.view),
    vehicle: oneOf(p.get('vehicle'), VEHICLE_MODELS, d.vehicle),
    car: oneOf(p.get('car'), CAR_DESIGNS, d.car),
    livery: int(p.get('livery'), 0, 99, d.livery),
    laps: int(p.get('laps'), 0, 99, d.laps),
    rivals: int(p.get('rivals'), 0, 3, d.rivals),
    difficulty:
      difficultyRaw !== null && Object.hasOwn(DIFFICULTY_NAMES, difficultyRaw)
        ? DIFFICULTY_NAMES[difficultyRaw].difficulty
        : real(difficultyRaw, 0, 1, d.difficulty),
    quality: oneOf(p.get('quality'), ['high', 'quest'] as const, d.quality),
    shadows: shadowsRaw === 'off' ? 'off' : shadowsRaw === '1024' ? 1024 : shadowsRaw === '2048' ? 2048 : null,
    tune: parseTune(p.getAll('tune').join(',')),
    cuts: oneOf(p.get('cuts'), ['flash', 'reset'] as const, d.cuts),
    countdown: flag(p.get('countdown'), d.countdown),
    autopilot: flag(p.get('autopilot'), d.autopilot),
    dev: flag(p.get('dev'), d.dev),
    perf: flag(p.get('perf'), d.perf),
    shot: flag(p.get('shot'), d.shot),
    at: real(p.get('at'), 0, 600, d.at),
    spot,
    report: flag(p.get('report'), d.report),
    seconds: real(p.get('seconds'), 1, 3600, d.seconds),
    liveBoot: flag(p.get('liveboot'), d.liveBoot),
    dpr: p.get('dpr') === null ? d.dpr : real(p.get('dpr'), 0.25, 4, NaN) || d.dpr,
    backdrop: flag(p.get('backdrop'), d.backdrop),
  };
}

/** Query string (with the leading `?`) for `options` with `overrides`
 * applied; parameters equal to the defaults (of this device: `quality`) are
 * left out. */
export function optionsToQuery(options: GameOptions, overrides: Partial<GameOptions> = {}): string {
  const o: GameOptions = { ...options, ...overrides };
  const d = defaultGameOptions(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const p = new URLSearchParams();
  const put = (key: string, value: string, def: string): void => {
    if (value !== def) p.set(key, value);
  };
  put('seed', String(o.seed), String(d.seed));
  put('terrain', o.terrain, d.terrain);
  put('view', o.view, d.view);
  put('vehicle', o.vehicle, d.vehicle);
  put('car', o.car, d.car);
  put('livery', String(o.livery), String(d.livery));
  put('laps', String(o.laps), String(d.laps));
  put('rivals', String(o.rivals), String(d.rivals));
  put('difficulty', String(o.difficulty), String(d.difficulty));
  put('quality', o.quality, d.quality);
  if (o.shadows !== null) p.set('shadows', String(o.shadows));
  const tune = Object.entries(o.tune).map(([k, v]) => `${k}:${v}`).join(',');
  if (tune) p.set('tune', tune);
  put('cuts', o.cuts, d.cuts);
  if (!o.countdown) p.set('countdown', '0');
  if (o.autopilot) p.set('autopilot', '1');
  if (o.dev) p.set('dev', '1');
  if (o.perf) p.set('perf', '1');
  if (o.spot !== null) p.set('spot', String(o.spot));
  if (o.dpr !== null) p.set('dpr', String(o.dpr));
  if (!o.backdrop) p.set('backdrop', '0');
  if (o.shot) {
    p.set('shot', '1');
    p.set('at', String(o.at));
  }
  if (o.report) {
    p.set('report', '1');
    p.set('seconds', String(o.seconds));
    if (o.liveBoot) p.set('liveboot', '1');
  }
  const s = p.toString();
  return s ? `?${s}` : '?';
}

/**
 * Livery per grid entry: the player's `?livery=` as asked; every rival wears
 * livery 0 of its own design (the design sheet's colours) unless that design
 * and livery are already on the grid — then the LATER slot takes the next
 * free livery of its design, so no two cars look alike. The player's pair is
 * taken first (whatever its slot). `counts`: liveries per car design.
 */
export function assignLiveries(
  entries: readonly { id: string; carId: string; isPlayer: boolean; slot: number }[],
  playerLivery: number,
  counts: Readonly<Record<string, number>>,
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<string>();
  const n = (carId: string): number => Math.max(1, counts[carId] ?? 1);
  for (const e of entries) {
    if (!e.isPlayer) continue;
    const l = ((playerLivery % n(e.carId)) + n(e.carId)) % n(e.carId);
    out.set(e.id, l);
    taken.add(`${e.carId}#${l}`);
  }
  const rivals = entries.filter((e) => !e.isPlayer).sort((a, b) => a.slot - b.slot);
  for (const e of rivals) {
    let l = 0;
    // Every livery of the design taken: fall back to 0 (still a valid paint).
    while (taken.has(`${e.carId}#${l}`) && l < n(e.carId)) l++;
    if (l >= n(e.carId)) l = 0;
    out.set(e.id, l);
    taken.add(`${e.carId}#${l}`);
  }
  return out;
}
