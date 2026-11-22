import type { ViewMode } from '../../game/contracts/camera';
import type {
  CreateMenuModel,
  MenuActionRow,
  MenuAside,
  MenuBlip,
  MenuButton,
  MenuCarInfo,
  MenuCarRow,
  MenuChoiceRow,
  MenuCommand,
  MenuControlPart,
  MenuControlsAside,
  MenuDevice,
  MenuDigit,
  MenuEffect,
  MenuFacts,
  MenuGlyphId,
  MenuLinkRow,
  MenuModel,
  MenuModelInit,
  MenuPaint,
  MenuPin,
  MenuPointerAction,
  MenuPrompt,
  MenuRepeat,
  MenuRichText,
  MenuRow,
  MenuRowId,
  MenuScreenId,
  MenuSliderRow,
  MenuSnapshot,
  MenuState,
  MenuStepperRow,
  MenuTag,
  MenuTrackInfo,
  MenuValue,
} from '../../game/contracts/menu';
import type { GameOptions } from '../../game/options';
import { DIFFICULTY_PRESETS } from '../../car/ai/grid';
import { formatLapTime, ordinal } from '../../game/RaceState';
import { randomSeed } from '../../game/menuFlow';

/**
 * The menu's state machine (contract: `MenuModel` in
 * src/game/contracts/menu.ts; spec: design-documents/menu-mockups/SPEC.md
 * sections 2, 3, 4 "How commands are used", 5 and 6). Babylon-free and
 * DOM-free: Node tests import it (tools/node/menu-model-test.ts).
 *
 * - A STACK of screens; each entry remembers its focused row while it is on
 *   the stack. One screen per state root: title (title state), pause
 *   (paused), post (post); race = empty stack.
 * - `running` = the page's options; `staged` holds ONLY world keys (car,
 *   livery, seed, laps, rivals, difficulty, quality) that differ from it.
 * - `update(cmd, facts)`: the model changes its OWN state first, then calls
 *   the host. After a state change (menu opened / closed, screen entered /
 *   left, reload) the rest of that frame's buttons are dropped.
 * - `snapshot()` is pure (no host calls): it rebuilds at most once per
 *   update and keeps the SAME object while nothing visible changed.
 */

// ───────────────────────────── constants ─────────────────────────────

/** Seconds after the last typed digit before the TRACK entry commits. */
export const DIGIT_COMMIT_SECONDS = 1.2;
/** Seconds after the player's finish before the post-race stack appears. */
export const POST_DELAY_SECONDS = 2.5;
export const SEED_MIN = 1;
export const SEED_MAX = 9999;
export const LAPS_MAX = 99;
/** Longest title RACE sub-line kept whole (characters). */
export const SUB_LINE_MAX = 40;

type WorldKey = 'car' | 'livery' | 'seed' | 'laps' | 'rivals' | 'difficulty' | 'quality';
const WORLD_KEYS: readonly WorldKey[] = ['car', 'livery', 'seed', 'laps', 'rivals', 'difficulty', 'quality'];
const SETUP_KEYS: readonly WorldKey[] = ['seed', 'laps', 'rivals', 'difficulty'];

const DIFFICULTIES: readonly { name: string; value: number }[] = [
  { name: 'EASY', value: DIFFICULTY_PRESETS.easy.difficulty },
  { name: 'NORMAL', value: DIFFICULTY_PRESETS.normal.difficulty },
  { name: 'HARD', value: DIFFICULTY_PRESETS.hard.difficulty },
];

const VIEWS: readonly { value: ViewMode; label: string }[] = [
  { value: 'chase', label: 'CHASE' },
  { value: 'high', label: 'HIGH' },
  { value: 'xr', label: 'DIORAMA' },
];

const QUALITIES: readonly { value: GameOptions['quality']; label: string }[] = [
  { value: 'high', label: 'HIGH' },
  { value: 'quest', label: 'QUEST' },
];

const FALLBACK_PAINT: MenuPaint = { name: 'Paint', body: '#aebbc2', accent: '#141e27' };

const NOTE: MenuRichText = [
  { text: 'CHOOSE', strong: true },
  { text: ' puts it on the grid for your next race. The paint shows once the new grid is built.', strong: false },
];

const TIPS: readonly MenuRichText[] = [
  [
    { text: 'Hold ', strong: false },
    { text: 'BRAKE', strong: true },
    { text: ' at a standstill to reverse.', strong: false },
  ],
  [
    { text: 'RESET', strong: true },
    { text: ' puts you back on the road, facing the right way.', strong: false },
  ],
  [{ text: 'Cut a corner and the lap does not count until you rejoin.', strong: false }],
  [
    { text: 'Restart and quit are in the ', strong: false },
    { text: 'PAUSE', strong: true },
    { text: ' menu.', strong: false },
  ],
];

const key = (text: string): MenuControlPart => ({ kind: 'key', text });
const text = (t: string): MenuControlPart => ({ kind: 'text', text: t });
const CONTROLS: MenuControlsAside = {
  kind: 'controls',
  header: ['ACTION', 'GAMEPAD', 'KEYBOARD'],
  rows: [
    { action: 'STEER', gamepad: [{ kind: 'glyph', glyph: 'stick' }, text('LEFT STICK')], keyboard: [key('A'), key('D'), text('OR'), key('←'), key('→')] },
    { action: 'THROTTLE', gamepad: [{ kind: 'glyph', glyph: 'r2' }], keyboard: [key('W'), text('OR'), key('↑')] },
    { action: 'BRAKE / REVERSE', gamepad: [{ kind: 'glyph', glyph: 'l2' }], keyboard: [key('S'), text('OR'), key('↓')] },
    { action: 'RESET CAR', gamepad: [{ kind: 'glyph', glyph: 'circle' }], keyboard: [key('R')] },
    { action: 'CAMERA', gamepad: [{ kind: 'glyph', glyph: 'triangle' }], keyboard: [key('C')] },
    { action: 'PAUSE', gamepad: [{ kind: 'glyph', glyph: 'options' }], keyboard: [key('ESC'), text('OR'), key('P')] },
    { action: 'MUSIC ON / OFF', gamepad: [text('IN THE MENU')], keyboard: [key('M')] },
  ],
};

/** Prompt kinds → glyph (pad, keyboard), button sent on click, aria label. */
const PROMPTS = {
  move: { pad: 'dpad-ud', key: 'key-ud', button: 'down', label: 'MOVE', aria: 'Move' },
  car: { pad: 'dpad-ud', key: 'key-ud', button: 'down', label: 'CAR', aria: 'Next car' },
  change: { pad: 'dpad-lr', key: 'key-lr', button: 'right', label: 'CHANGE', aria: 'Change' },
  paint: { pad: 'dpad-lr', key: 'key-lr', button: 'right', label: 'PAINT', aria: 'Next paint' },
  select: { pad: 'cross', key: 'key-enter', button: 'select', label: 'SELECT', aria: 'Select' },
  choose: { pad: 'cross', key: 'key-enter', button: 'select', label: 'CHOOSE', aria: 'Choose' },
  back: { pad: 'circle', key: 'key-esc', button: 'back', label: 'BACK', aria: 'Back' },
  title: { pad: 'circle', key: 'key-esc', button: 'back', label: 'TITLE', aria: 'Title' },
  undo: { pad: 'square', key: 'key-del', button: 'undo', label: 'UNDO', aria: 'Undo' },
  random: { pad: 'triangle', key: 'key-r', button: 'random', label: 'RANDOM TRACK', aria: 'Random track' },
  resume: { pad: 'options', key: 'key-esc', button: 'pause', label: 'RESUME', aria: 'Resume' },
} as const satisfies Record<string, { pad: MenuGlyphId; key: MenuGlyphId; button: MenuButton; label: string; aria: string }>;
type PromptKind = keyof typeof PROMPTS;

// ───────────────────────────── text helpers ─────────────────────────────

export function lapsText(laps: number): string {
  if (laps <= 0) return 'ENDLESS';
  return laps === 1 ? '1 LAP' : `${laps} LAPS`;
}

export function rivalsText(rivals: number): string {
  if (rivals <= 0) return 'NO RIVALS';
  return rivals === 1 ? '1 RIVAL' : `${rivals} RIVALS`;
}

/** EASY / NORMAL / HARD, or 'SKILL 0.60' for a numeric value no preset has. */
export function difficultyText(difficulty: number): string {
  const preset = DIFFICULTIES.find((d) => d.value === difficulty);
  return preset ? preset.name : `SKILL ${difficulty.toFixed(2)}`;
}

function viewLabel(mode: ViewMode): string {
  return VIEWS.find((v) => v.value === mode)?.label ?? mode.toUpperCase();
}

function ordinalSuffix(n: number): string {
  return ordinal(n).slice(String(n).length).toUpperCase();
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ───────────────────────────── model ─────────────────────────────

interface Entry {
  id: MenuScreenId;
  /** Focused row; null on screens without rows (controls). */
  focus: MenuRowId | null;
  /** settings / controls: opened from the title or from pause. */
  from: 'title' | 'paused';
  /** confirm: what is being confirmed. */
  confirm: 'quit' | 'restart';
}

type SnapshotBody = Omit<MenuSnapshot, 'version'>;

export const createMenuModel: CreateMenuModel = (init: MenuModelInit): MenuModel => {
  const running: Readonly<GameOptions> = init.running;
  const host = init.host;
  const cars: readonly MenuCarInfo[] = init.cars;

  let state: MenuState = 'race';
  let stack: Entry[] = [];
  const staged: Partial<GameOptions> = {};
  let effects: MenuEffect[] = [];
  let view: ViewMode = init.view;
  let musicVolume = init.musicVolume;
  let device: MenuDevice = 'keyboard';
  let serial = 0;
  let version = 0;
  let reloading = false;
  /** Commands are ignored until `boot()` (the loading panel is still up). */
  let booted = false;
  /** Digits typed on the TRACK row, not yet committed. */
  let entry: string | null = null;
  let entryAt = 0;
  /** Car screen: the paint being browsed per design. */
  const carPaint = new Map<string, number>();
  /** Car screen: left / right used since the focus last moved (narrow help). */
  let paintTouched = false;
  /** Track preview of the shown seed (refreshed in update / pin). */
  let shownTrack: MenuTrackInfo | null = null;
  let shownTrackSeed = -1;
  let facts: MenuFacts = {
    time: 0,
    phase: 'countdown',
    lap: 1,
    laps: running.laps,
    place: running.rivals + 1,
    count: running.rivals + 1,
    finishedFor: null,
    finishPlace: null,
    bestLap: null,
    view: init.view,
    musicVolume: init.musicVolume,
    audioUnlocked: true,
    padConnected: false,
    narrow: false,
  };
  let cached: MenuSnapshot | null = null;
  let cachedKey = '';
  let dirty = true;

  // ── staging ──
  const eff = (): GameOptions => ({ ...running, ...staged }) as GameOptions;
  const isStaged = (k: WorldKey): boolean => Object.hasOwn(staged, k);
  const stage = <K extends WorldKey>(k: K, value: GameOptions[K]): void => {
    if (running[k] === value) delete staged[k];
    else (staged as Record<string, unknown>)[k] = value;
  };
  const unstage = (...keys: WorldKey[]): void => {
    for (const k of keys) delete staged[k];
  };
  const stagedCount = (): number => {
    let n = isStaged('car') || isStaged('livery') ? 1 : 0;
    for (const k of ['seed', 'laps', 'rivals', 'difficulty', 'quality'] as const) if (isStaged(k)) n++;
    return n;
  };
  if (init.staged) {
    for (const k of WORLD_KEYS) {
      const v = init.staged[k];
      if (v !== undefined) stage(k, v as never);
    }
  }

  // ── cars ──
  const carInfo = (id: string): MenuCarInfo | undefined => cars.find((c) => c.id === id);
  const paintsOf = (id: string): readonly MenuPaint[] => {
    const p = carInfo(id)?.paints;
    return p && p.length > 0 ? p : [FALLBACK_PAINT];
  };
  const wrapPaint = (id: string, livery: number): number => {
    const n = paintsOf(id).length;
    return ((Math.round(livery) % n) + n) % n;
  };
  const carName = (id: string): string => (carInfo(id)?.name ?? id).toUpperCase();
  const initCarScreen = (): void => {
    const o = eff();
    carPaint.clear();
    for (const c of cars) {
      const livery = c.id === o.car ? o.livery : c.id === running.car ? running.livery : 0;
      carPaint.set(c.id, wrapPaint(c.id, livery));
    }
    paintTouched = false;
  };
  const carIdOfRow = (row: MenuRowId | null): string | null => (row !== null && row.startsWith('car:') ? row.slice(4) : null);

  // ── stack ──
  const top = (): Entry | undefined => stack[stack.length - 1];
  const defaultFocus = (id: MenuScreenId): MenuRowId | null => {
    switch (id) {
      case 'title':
        return 'race';
      case 'car': {
        const o = eff();
        const c = carInfo(o.car) ?? cars[0];
        return c ? (`car:${c.id}` as MenuRowId) : null;
      }
      case 'setup':
        return 'track';
      case 'settings':
        return 'camera';
      case 'controls':
        return null;
      case 'pause':
        return 'resume';
      case 'confirm':
        return 'keep';
      case 'post':
        return 'again';
    }
  };
  const makeEntry = (id: MenuScreenId, from: 'title' | 'paused' = 'title', confirm: 'quit' | 'restart' = 'quit'): Entry => ({
    id,
    focus: defaultFocus(id),
    from,
    confirm,
  });
  const fixFocus = (e: Entry | undefined): void => {
    if (!e) return;
    const rows = buildRows(e);
    if (rows.length === 0) {
      e.focus = null;
      return;
    }
    const cur = rows.find((r) => r.id === e.focus);
    if (cur && !cur.disabled) return;
    const first = rows.find((r) => !r.disabled);
    e.focus = first ? first.id : null;
  };
  const effect = (e: MenuEffect): void => {
    effects.push(e);
  };
  const blip = (sound: MenuBlip): void => effect({ kind: 'blip', sound });

  // ── digit entry ──
  const commitEntry = (): void => {
    if (entry === null) return;
    const n = entry === '' ? 0 : Number.parseInt(entry, 10);
    entry = null;
    if (Number.isFinite(n) && n >= SEED_MIN) stage('seed', Math.min(SEED_MAX, n));
  };

  // ── track preview ──
  const refreshTrack = (): void => {
    const e = top();
    if (!e || state !== 'title' || (e.id !== 'title' && e.id !== 'setup')) return;
    const seed = eff().seed;
    const t = init.tracks.get(seed);
    shownTrack = t && t.seed === seed ? t : null;
    shownTrackSeed = seed;
  };
  const trackFor = (seed: number): MenuTrackInfo | null => (shownTrackSeed === seed ? shownTrack : null);
  /** Stored best laps of other seeds (they cannot change on this page). */
  const storedBest = new Map<number, number | null>();
  const bestFor = (seed: number): number | null => {
    if (seed === running.seed) return facts.bestLap;
    if (!storedBest.has(seed)) storedBest.set(seed, init.bestLap(seed));
    return storedBest.get(seed) ?? null;
  };

  // ── rows ──
  const value = (lines: readonly string[], isStagedValue: boolean, swatch: MenuPaint | null = null): MenuValue => ({
    lines,
    staged: isStagedValue,
    swatch,
  });
  const base = (id: MenuRowId, label: string, tone: MenuRow['tone'] = 'normal', tags: readonly MenuTag[] = [], disabled = false) => ({
    id,
    label,
    focused: false,
    disabled,
    tone,
    tags,
  });
  const action = (id: MenuRowId, label: string, o: Partial<Pick<MenuActionRow, 'tone' | 'chevron' | 'value' | 'sub' | 'tags'>> = {}): MenuActionRow => ({
    ...base(id, label, o.tone, o.tags),
    kind: 'action',
    chevron: o.chevron ?? false,
    value: o.value ?? null,
    sub: o.sub ?? null,
  });
  const link = (id: MenuRowId, label: string, v: MenuValue | null = null, tags: readonly MenuTag[] = []): MenuLinkRow => ({
    ...base(id, label, 'normal', tags),
    kind: 'link',
    value: v,
  });
  const was = (k: WorldKey, shown: string): readonly MenuTag[] => (isStaged(k) ? [{ kind: 'was', text: `WAS ${shown}` }] : []);
  const cameraRow = (display: MenuChoiceRow['display']): MenuChoiceRow => ({
    ...base('camera', 'CAMERA'),
    kind: 'choice',
    display,
    options: VIEWS.map((v) => ({ value: v.value, label: v.label })),
    selected: Math.max(0, VIEWS.findIndex((v) => v.value === view)),
    caption: null,
    staged: false,
  });
  const musicRow = (withNumber: boolean): MenuSliderRow => {
    const v = clamp(Math.round(musicVolume * 10), 0, 10);
    return {
      ...base('music', 'MUSIC'),
      kind: 'slider',
      value: v,
      text: withNumber ? (v === 0 ? 'OFF' : String(v)) : null,
      ariaValueText: `${v * 10} percent`,
    };
  };

  const buildRows = (e: Entry): MenuRow[] => {
    const o = eff();
    const count = stagedCount();
    switch (e.id) {
      case 'title': {
        const setupNew = SETUP_KEYS.filter(isStaged).length;
        const carStaged = isStaged('car') || isStaged('livery');
        const full = `TRACK ${o.seed} · ${lapsText(o.laps)} · ${rivalsText(o.rivals)} · ${difficultyText(o.difficulty)}`;
        // The sub-line holds about 40 characters at the 13 px floor in a
        // 900 × 600 window (menu-lab report): a longer one (a 4-digit seed
        // with a numeric SKILL) drops the difficulty, which RACE SETUP shows.
        const sub =
          count > 0
            ? `TRACK ${o.seed} · ${lapsText(o.laps)} · NEW WORLD`
            : full.length <= SUB_LINE_MAX
              ? full
              : `TRACK ${o.seed} · ${lapsText(o.laps)} · ${rivalsText(o.rivals)}`;
        return [
          action('race', 'RACE', { tone: 'primary', chevron: true, sub: value([sub], count > 0) }),
          link('car', 'CAR', value([carName(o.car)], carStaged, paintsOf(o.car)[wrapPaint(o.car, o.livery)])),
          link('setup', 'RACE SETUP', value([`TRACK ${o.seed}`], setupNew > 0), setupNew > 0 ? [{ kind: 'new', text: `${setupNew} NEW` }] : []),
          link(
            'settings',
            'SETTINGS',
            value([`${viewLabel(view)} CAM`], false),
            isStaged('quality') ? [{ kind: 'new', text: '1 NEW' }] : [],
          ),
          link('controls', 'CONTROLS'),
        ];
      }
      case 'car': {
        const chosen = isStaged('car') ? o.car : null;
        return cars.map((c): MenuCarRow => {
          const paints = paintsOf(c.id);
          const i = clamp(carPaint.get(c.id) ?? 0, 0, paints.length - 1);
          const tags: MenuTag[] = [];
          if (c.id === running.car) tags.push({ kind: 'live', text: 'ON THE GRID' });
          if (c.id === chosen) tags.push({ kind: 'chosen', text: 'CHOSEN' });
          return {
            ...base(`car:${c.id}`, c.name.toUpperCase(), 'normal', tags),
            kind: 'car',
            carId: c.id,
            name: c.name.toUpperCase(),
            caption: `${c.classLabel.toUpperCase()} · ${Math.round(c.massKg)} KG`,
            paint: paints[i],
            paintIndex: i,
            paintCount: paints.length,
          };
        });
      }
      case 'setup': {
        const seedRow: MenuStepperRow = {
          ...base('track', 'TRACK', 'normal', was('seed', String(running.seed))),
          kind: 'stepper',
          value: o.seed,
          text: entry ?? String(o.seed),
          entry,
          canDecrease: true,
          canIncrease: true,
          min: SEED_MIN,
          max: SEED_MAX,
          ariaValueText: `Track ${entry ?? o.seed}`,
          repeat: 'fast',
          staged: isStaged('seed') || entry !== null,
        };
        const lapsRow: MenuStepperRow = {
          ...base('laps', 'LAPS', 'normal', was('laps', running.laps <= 0 ? 'ENDLESS' : String(running.laps))),
          kind: 'stepper',
          value: o.laps,
          text: o.laps <= 0 ? 'ENDLESS' : String(o.laps),
          entry: null,
          canDecrease: o.laps > 0,
          canIncrease: o.laps < LAPS_MAX,
          min: 0,
          max: LAPS_MAX,
          ariaValueText: o.laps <= 0 ? 'Endless' : o.laps === 1 ? '1 lap' : `${o.laps} laps`,
          repeat: 'fast',
          staged: isStaged('laps'),
        };
        const rivalsRow: MenuChoiceRow = {
          ...base('rivals', 'RIVALS', 'normal', was('rivals', String(running.rivals))),
          kind: 'choice',
          display: 'segments',
          options: [0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n) })),
          selected: o.rivals >= 0 && o.rivals <= 3 ? o.rivals : null,
          caption: null,
          staged: isStaged('rivals'),
        };
        const di = DIFFICULTIES.findIndex((d) => d.value === o.difficulty);
        const difficultyRow: MenuChoiceRow = {
          ...base('difficulty', 'DIFFICULTY', 'normal', was('difficulty', difficultyText(running.difficulty))),
          kind: 'choice',
          display: 'segments',
          options: DIFFICULTIES.map((d) => ({ value: String(d.value), label: d.name })),
          selected: di >= 0 ? di : null,
          caption: di >= 0 ? null : difficultyText(o.difficulty),
          staged: isStaged('difficulty'),
        };
        const start = action('start', 'START RACE', {
          tone: 'go',
          value: count > 0 ? value([count === 1 ? '1 CHANGE' : `${count} CHANGES`, 'LOADS A NEW WORLD'], true) : null,
        });
        return [seedRow, lapsRow, rivalsRow, difficultyRow, start];
      }
      case 'settings': {
        const qi = QUALITIES.findIndex((q) => q.value === o.quality);
        const quality: MenuChoiceRow = {
          ...base('quality', 'QUALITY', 'normal', was('quality', running.quality.toUpperCase()), e.from === 'paused'),
          kind: 'choice',
          display: 'segments',
          options: QUALITIES.map((q) => ({ value: q.value, label: q.label })),
          selected: qi >= 0 ? qi : null,
          caption: null,
          staged: isStaged('quality'),
        };
        return [cameraRow('segments'), musicRow(true), quality];
      }
      case 'controls':
        return [];
      case 'pause':
        return [
          action('resume', 'RESUME', { chevron: true }),
          action('restart', 'RESTART RACE'),
          cameraRow('arrows'),
          musicRow(false),
          link('settings', 'SETTINGS'),
          link('controls', 'CONTROLS'),
          action('quit', 'QUIT TO TITLE', { tone: 'danger' }),
        ];
      case 'confirm':
        return [
          action('keep', 'KEEP RACING', { chevron: true }),
          action('confirm', e.confirm === 'quit' ? 'QUIT TO TITLE' : 'RESTART RACE', { tone: 'danger' }),
        ];
      case 'post': {
        const carStaged = isStaged('car') || isStaged('livery');
        return [
          action('again', 'RACE AGAIN', { tone: 'primary', sub: value([`TRACK ${running.seed} · SAME GRID`], false) }),
          action('next', 'NEXT TRACK', { sub: value([`TRACK ${(running.seed % SEED_MAX) + 1} · NEW WORLD`], false) }),
          action('changeCar', 'CHANGE CAR', { sub: value([carName(o.car)], carStaged, paintsOf(o.car)[wrapPaint(o.car, o.livery)]) }),
          action('title', 'TITLE', { sub: value(['MAIN MENU'], false) }),
        ];
      }
    }
  };

  // ── snapshot ──
  const breadcrumbOf = (e: Entry): string | null => {
    switch (e.id) {
      case 'title':
      case 'post':
        return null;
      case 'car':
        return 'TITLE / CAR';
      case 'setup':
        return 'TITLE / RACE SETUP';
      case 'settings':
        return e.from === 'paused' ? 'PAUSED / SETTINGS' : 'TITLE / SETTINGS';
      case 'controls':
        return e.from === 'paused' ? 'PAUSED / CONTROLS' : 'TITLE / CONTROLS';
      case 'confirm':
        return e.confirm === 'quit' ? 'PAUSED / QUIT TO TITLE' : 'PAUSED / RESTART RACE';
      case 'pause': {
        if (facts.phase === 'countdown') return 'STARTING GRID';
        const lap = facts.laps > 0 ? `LAP ${facts.lap} / ${facts.laps}` : `LAP ${facts.lap}`;
        return facts.count > 1 ? `${lap} · ${ordinal(facts.place).toUpperCase()} OF ${facts.count}` : lap;
      }
    }
  };
  const headlineOf = (e: Entry): readonly string[] => {
    switch (e.id) {
      case 'title':
      case 'post':
        return [];
      case 'car':
        return ['PICK YOUR', 'BUGGY'];
      case 'setup':
        return ['RACE SETUP'];
      case 'settings':
        return ['SETTINGS'];
      case 'controls':
        return ['CONTROLS'];
      case 'pause':
        return ['PAUSED'];
      case 'confirm':
        return [e.confirm === 'quit' ? 'QUIT?' : 'RESTART?'];
    }
  };
  const sayOf = (e: Entry): string | null => {
    if (e.id !== 'confirm') return null;
    const lap = facts.laps > 0 ? `lap ${facts.lap} of ${facts.laps}` : `lap ${facts.lap}`;
    const place = facts.count > 1 ? `, running ${ordinal(facts.place)}` : '';
    return e.confirm === 'quit'
      ? `This race ends here: ${lap}${place}. Your best lap on Track ${running.seed} is kept.`
      : `This race starts again from the grid: ${lap}${place}.`;
  };
  const helpOf = (e: Entry, row: MenuRow | undefined): string => {
    if (!row) return '';
    const o = eff();
    switch (row.id) {
      case 'race':
        if (stagedCount() === 0) return 'Start the race on this track.';
        return o.seed !== running.seed ? `Builds track ${o.seed}, then starts the race.` : 'Builds the new grid, then starts the race.';
      case 'car':
        return 'Choose your buggy and its paint.';
      case 'setup':
        return 'Track, laps, rivals and difficulty.';
      case 'settings':
        return e.id === 'pause' ? 'Camera and music.' : 'Camera, music and quality.';
      case 'controls':
        return 'Keyboard and gamepad buttons.';
      case 'track':
        return 'Every number is its own track and village.';
      case 'laps':
        return '1 to 99 laps. One step below 1 is ENDLESS.';
      case 'rivals':
        return 'How many AI buggies start with you.';
      case 'difficulty':
        return 'How quick the rivals are.';
      case 'start':
        return 'Go racing.';
      case 'camera':
        return e.id === 'pause' ? 'Changes the view at once.' : 'Changes at once: look past the menu.';
      case 'music':
        return e.id === 'pause' ? 'Music volume.' : 'Music volume. 0 is off.';
      case 'quality':
        return row.disabled ? 'Change quality from the title screen.' : 'Applies when the next race loads.';
      case 'resume':
        return facts.phase === 'countdown' ? 'The countdown starts again.' : 'Carry on where you left off.';
      case 'restart':
        return 'Back to the grid, same track.';
      case 'quit':
        return 'Ends this race.';
      default:
        break;
    }
    if (row.kind === 'car') {
      if (facts.narrow && paintTouched) return row.paint.name.toUpperCase();
      return 'Left and right change the paint.';
    }
    return '';
  };
  const prompt = (k: PromptKind): MenuPrompt => {
    const p = PROMPTS[k];
    return { glyph: device === 'gamepad' ? p.pad : p.key, label: p.label, ariaLabel: p.aria, button: p.button };
  };
  const promptsOf = (e: Entry, row: MenuRow | undefined): MenuPrompt[] => {
    let kinds: PromptKind[];
    switch (e.id) {
      case 'title':
        kinds = stagedCount() > 0 ? ['move', 'select', 'undo'] : ['move', 'select'];
        break;
      case 'car':
        kinds = ['car', 'paint', 'choose', 'back'];
        break;
      case 'setup': {
        const valueRow = row !== undefined && row.kind !== 'action' && row.kind !== 'link';
        kinds = ['move', valueRow ? 'change' : 'select'];
        if (row?.id === 'track') kinds.push('random');
        const k = row ? rowKey(row.id) : null;
        if (k !== null && (isStaged(k) || (row?.id === 'track' && entry !== null))) kinds.push('undo');
        kinds.push('back');
        break;
      }
      case 'settings':
        kinds = ['move', 'change'];
        if (row?.id === 'quality' && isStaged('quality')) kinds.push('undo');
        kinds.push('back');
        break;
      case 'controls':
        kinds = ['back'];
        break;
      case 'pause':
        kinds = ['select', 'resume'];
        break;
      case 'confirm':
        kinds = ['move', 'select', 'back'];
        break;
      case 'post':
        kinds = ['move', 'select', 'title'];
        break;
    }
    // At most 4: MOVE is dropped first.
    if (kinds.length > 4) kinds = kinds.filter((k) => k !== 'move');
    return kinds.slice(0, 4).map(prompt);
  };
  const asideOf = (e: Entry, row: MenuRow | undefined): MenuAside | null => {
    const o = eff();
    switch (e.id) {
      case 'title': {
        const seedStaged = isStaged('seed');
        const track = trackFor(o.seed);
        const best = bestFor(o.seed);
        return {
          kind: 'next',
          title: `TRACK ${o.seed}`,
          staged: seedStaged,
          caption: seedStaged
            ? `NEW · ${lapsText(o.laps)}`
            : track
              ? `${Math.round(track.lengthM)} M · ${lapsText(o.laps)}`
              : lapsText(o.laps),
          bestLabel: 'BEST LAP',
          best: best === null ? '– : – –' : formatLapTime(best),
          track,
        };
      }
      case 'car': {
        if (!row || row.kind !== 'car') return null;
        const c = carInfo(row.carId);
        if (!c) return null;
        const paints = paintsOf(c.id);
        return {
          kind: 'car',
          name: c.name.toUpperCase(),
          badge: c.classLabel.toUpperCase(),
          description: c.description,
          stats: [
            { label: 'SPEED', value: c.stats.speed, max: 5 },
            { label: 'GRIP', value: c.stats.grip, max: 5 },
            { label: 'AGILITY', value: c.stats.agility, max: 5 },
            { label: 'WEIGHT', value: c.stats.weight, max: 5 },
          ],
          paintLabel: 'PAINT',
          paintPosition: `${row.paintIndex + 1} / ${paints.length}`,
          paints,
          paintIndex: row.paintIndex,
          paintName: row.paint.name.toUpperCase(),
          note: NOTE,
        };
      }
      case 'setup': {
        const track = trackFor(o.seed);
        const best = bestFor(o.seed);
        const chips: string[] = [];
        if (track) {
          chips.push(`${Math.round(track.lengthM)} M`);
          if (o.laps > 0) chips.push(`${lapsText(o.laps)} · ${((o.laps * track.lengthM) / 1000).toFixed(1)} KM`);
        }
        chips.push(best === null ? 'NO BEST LAP YET' : `BEST ${formatLapTime(best)}`);
        return {
          kind: 'ticket',
          kicker: 'TRACK PREVIEW',
          title: `TRACK ${o.seed}`,
          track,
          chips,
          sticker: o.seed !== running.seed ? { text: 'NEW TRACK', sub: 'BUILT WHEN YOU START' } : null,
        };
      }
      case 'controls':
        return CONTROLS;
      case 'post': {
        if (facts.laps <= 0 || facts.finishPlace === null) return null;
        return {
          kind: 'medal',
          place: facts.finishPlace,
          ordinal: ordinalSuffix(facts.finishPlace),
          caption: 'PLACE',
          gold: facts.finishPlace === 1 || facts.count <= 1,
        };
      }
      default:
        return null;
    }
  };

  const build = (): SnapshotBody => {
    const e = top();
    if (state === 'race' || !e) {
      return {
        serial,
        state,
        screen: null,
        rows: [],
        focus: -1,
        breadcrumb: null,
        headline: [],
        ariaLabel: '',
        say: null,
        tips: [],
        help: '',
        prompts: [],
        aside: null,
        soundChip: null,
        backdrop: 'none',
        repeat: 'normal',
        device,
        stagedCount: stagedCount(),
      };
    }
    const rows = buildRows(e);
    const focus = rows.findIndex((r) => r.id === e.focus && !r.disabled);
    if (focus >= 0) rows[focus] = { ...rows[focus], focused: true };
    const row = focus >= 0 ? rows[focus] : undefined;
    const headline = headlineOf(e);
    const pausedSide = state === 'paused';
    return {
      serial,
      state,
      screen: e.id,
      rows,
      focus,
      breadcrumb: breadcrumbOf(e),
      headline,
      ariaLabel: e.id === 'title' ? 'WEB RACER' : e.id === 'post' ? 'RACE FINISHED' : headline.join(' '),
      say: sayOf(e),
      tips: e.id === 'controls' ? TIPS : [],
      help: helpOf(e, row),
      prompts: promptsOf(e, row),
      aside: asideOf(e, row),
      soundChip: e.id === 'title' && stack.length === 1 && !facts.audioUnlocked ? 'CLICK OR PRESS A KEY FOR SOUND' : null,
      backdrop: state === 'post' ? 'post' : pausedSide ? 'pause' : 'none',
      repeat: row && row.kind === 'stepper' ? (row.repeat as MenuRepeat) : 'normal',
      device,
      stagedCount: stagedCount(),
    };
  };

  // ── transitions (own state first, then the host) ──
  const enter = (e: Entry): void => {
    stack.push(e);
    fixFocus(e);
    serial++;
  };
  const pop = (): void => {
    commitEntry();
    const left = stack.pop();
    serial++;
    fixFocus(top());
    if (left?.id === 'car') host.previewCar(null);
  };
  const openPause = (): void => {
    state = 'paused';
    stack = [];
    enter(makeEntry('pause'));
    effect({ kind: 'guard' });
    host.pause();
  };
  const resume = (): void => {
    commitEntry();
    state = 'race';
    stack = [];
    serial++;
    effect({ kind: 'guard' });
    host.resume();
  };
  const restartRace = (): void => {
    state = 'race';
    stack = [];
    serial++;
    effect({ kind: 'guard' });
    host.restartRace();
  };
  const toTitle = (openCar: boolean): void => {
    commitEntry();
    state = 'title';
    stack = [];
    enter(makeEntry('title'));
    if (openCar) {
      initCarScreen();
      enter(makeEntry('car'));
    }
    effect({ kind: 'guard' });
    host.enterTitle(openCar);
    if (openCar) host.previewCar(carIdOfRow(top()?.focus ?? null));
  };
  const enterPost = (): void => {
    state = 'post';
    stack = [];
    enter(makeEntry('post'));
    effect({ kind: 'guard' });
    host.enterPost();
  };
  const reload = (overrides: Partial<GameOptions>): void => {
    commitEntry();
    reloading = true;
    serial++;
    host.reload(overrides);
  };
  const startRace = (): void => {
    commitEntry();
    if (stagedCount() > 0) {
      reload({ ...staged });
      return;
    }
    state = 'race';
    stack = [];
    serial++;
    effect({ kind: 'guard' });
    host.startRace();
  };
  const push = (id: MenuScreenId, from: 'title' | 'paused' = 'title', confirm: 'quit' | 'restart' = 'quit'): void => {
    commitEntry();
    if (id === 'car') initCarScreen();
    enter(makeEntry(id, from, confirm));
    blip('select');
    if (id === 'car') host.previewCar(carIdOfRow(top()?.focus ?? null));
  };

  // ── focus ──
  const setFocus = (id: MenuRowId): boolean => {
    const e = top();
    if (!e || e.focus === id) return false;
    const row = buildRows(e).find((r) => r.id === id);
    if (!row || row.disabled) return false;
    if (e.focus === 'track') commitEntry();
    e.focus = id;
    paintTouched = false;
    blip('focus');
    const carId = carIdOfRow(id);
    if (carId !== null) host.previewCar(carId);
    return true;
  };
  const moveFocus = (delta: -1 | 1): void => {
    const e = top();
    if (!e) return;
    const rows = buildRows(e);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.id === e.focus);
    for (let step = 1; step <= rows.length; step++) {
      const i = (((at < 0 ? (delta > 0 ? -1 : 0) : at) + delta * step) % rows.length + rows.length) % rows.length;
      if (!rows[i].disabled) {
        setFocus(rows[i].id);
        return;
      }
    }
  };
  const focusedRow = (): MenuRow | undefined => {
    const e = top();
    if (!e) return undefined;
    return buildRows(e).find((r) => r.id === e.focus);
  };

  // ── values ──
  const rowKey = (id: MenuRowId): WorldKey | null => {
    switch (id) {
      case 'track':
        return 'seed';
      case 'laps':
        return 'laps';
      case 'rivals':
        return 'rivals';
      case 'difficulty':
        return 'difficulty';
      case 'quality':
        return 'quality';
      default:
        return null;
    }
  };
  const setView = (mode: ViewMode): void => {
    if (mode === view) return;
    view = mode;
    blip('select');
    host.setView(mode);
  };
  const setMusic = (tenths: number): void => {
    const v = clamp(Math.round(tenths), 0, 10) / 10;
    if (v === Math.round(musicVolume * 10) / 10) return;
    musicVolume = v;
    blip('select');
    host.setMusicVolume(v);
  };
  const applyChoice = (row: MenuChoiceRow, index: number): void => {
    const opt = row.options[index];
    if (!opt || index === row.selected) return;
    switch (row.id) {
      case 'camera':
        setView(opt.value as ViewMode);
        return;
      case 'quality':
        stage('quality', opt.value as GameOptions['quality']);
        break;
      case 'rivals':
        stage('rivals', Number(opt.value));
        break;
      case 'difficulty':
        stage('difficulty', Number(opt.value));
        break;
      default:
        return;
    }
    blip('select');
  };
  const setPaint = (carId: string, index: number): void => {
    const n = paintsOf(carId).length;
    const i = clamp(Math.round(index), 0, n - 1);
    paintTouched = true;
    if ((carPaint.get(carId) ?? 0) === i) return;
    carPaint.set(carId, i);
    blip('select');
  };
  /** left / right on the focused row. */
  const change = (delta: -1 | 1): void => {
    const e = top();
    const row = focusedRow();
    if (!e || !row) return;
    if (e.id === 'post') {
      // Below 5:4 the stack is a 2 × 2 grid: left / right move like up / down.
      if (facts.narrow) moveFocus(delta);
      return;
    }
    switch (row.kind) {
      case 'choice': {
        let i: number;
        if (row.selected !== null) i = row.selected + delta;
        else if (row.id === 'difficulty') {
          // A numeric value no preset has: the next preset in that direction.
          const d = eff().difficulty;
          i = delta > 0 ? DIFFICULTIES.findIndex((p) => p.value > d) : DIFFICULTIES.map((p) => p.value < d).lastIndexOf(true);
        } else i = delta > 0 ? 0 : row.options.length - 1;
        if (i >= 0 && i < row.options.length) applyChoice(row, i);
        return;
      }
      case 'stepper': {
        if (row.id === 'track') {
          commitEntry();
          const s = eff().seed;
          const next = delta > 0 ? (s >= SEED_MAX ? SEED_MIN : s + 1) : s <= SEED_MIN ? SEED_MAX : Math.min(SEED_MAX, s - 1);
          stage('seed', next);
        } else {
          const l = eff().laps;
          const next = clamp(l + delta, 0, LAPS_MAX);
          if (next === l) return;
          stage('laps', next);
        }
        blip('select');
        return;
      }
      case 'slider':
        setMusic(Math.round(musicVolume * 10) + delta);
        return;
      case 'car':
        setPaint(row.carId, row.paintIndex + delta);
        return;
      default:
        return; // action / link: nothing
    }
  };
  const select = (): void => {
    const e = top();
    if (!e) return;
    const row = focusedRow();
    switch (e.id) {
      case 'title':
        if (row?.id === 'race') startRace();
        else if (row?.id === 'car') push('car');
        else if (row?.id === 'setup') push('setup');
        else if (row?.id === 'settings') push('settings', 'title');
        else if (row?.id === 'controls') push('controls', 'title');
        return;
      case 'car': {
        if (!row || row.kind !== 'car') return;
        stage('car', row.carId);
        // The running paint is the WRAPPED URL livery (`?livery=6` on a
        // 4-paint car is paint 2): choosing it again stages nothing.
        if (row.carId === running.car && row.paintIndex === wrapPaint(running.car, running.livery)) unstage('livery');
        else stage('livery', row.paintIndex);
        blip('select');
        pop();
        return;
      }
      case 'setup':
      case 'settings':
        if (!row) return;
        if (row.id === 'start') startRace();
        else if (row.id === 'track') commitEntry();
        else if (row.kind === 'choice') applyChoice(row, row.selected === null ? 0 : (row.selected + 1) % row.options.length);
        return;
      case 'controls':
        return;
      case 'pause':
        if (!row) return;
        if (row.id === 'resume') resume();
        else if (row.id === 'restart') {
          if (facts.phase === 'racing') push('confirm', 'paused', 'restart');
          else restartRace();
        } else if (row.id === 'quit') {
          if (facts.phase === 'racing') push('confirm', 'paused', 'quit');
          else toTitle(false);
        } else if (row.id === 'settings') push('settings', 'paused');
        else if (row.id === 'controls') push('controls', 'paused');
        else if (row.kind === 'choice') applyChoice(row, row.selected === null ? 0 : (row.selected + 1) % row.options.length);
        return;
      case 'confirm':
        if (row?.id === 'keep') {
          blip('back');
          pop();
        } else if (row?.id === 'confirm') {
          if (e.confirm === 'restart') restartRace();
          else toTitle(false);
        }
        return;
      case 'post':
        if (row?.id === 'again') restartRace();
        else if (row?.id === 'next') reload({ ...staged, seed: (running.seed % SEED_MAX) + 1 });
        else if (row?.id === 'changeCar') toTitle(true);
        else if (row?.id === 'title') toTitle(false);
        return;
    }
  };
  const back = (): void => {
    const e = top();
    if (!e) return;
    if (state === 'post') {
      toTitle(false);
      return;
    }
    if (stack.length <= 1) {
      if (state === 'paused') {
        blip('back');
        resume();
      }
      return; // title root: nothing
    }
    blip('back');
    pop();
  };
  const undo = (): void => {
    const e = top();
    if (!e) return;
    if (e.id === 'title' && stack.length === 1 && state === 'title') {
      if (stagedCount() === 0 && entry === null) return;
      for (const k of WORLD_KEYS) delete staged[k];
      entry = null;
      blip('back');
      return;
    }
    const row = focusedRow();
    if (!row) return;
    if (row.id === 'track' && entry !== null) {
      // Backspace / Delete while typing: drop the last digit.
      entry = entry.length > 1 ? entry.slice(0, -1) : null;
      entryAt = facts.time;
      return;
    }
    if (row.kind === 'car') {
      if (!isStaged('car') && !isStaged('livery')) return;
      unstage('car', 'livery');
      initCarScreen();
      blip('back');
      return;
    }
    const k = rowKey(row.id);
    if (k === null || row.disabled || !isStaged(k)) return;
    unstage(k);
    blip('back');
  };
  const random = (): void => {
    const e = top();
    if (!e || e.id !== 'setup' || e.focus !== 'track') return;
    entry = null;
    stage('seed', randomSeed([running.seed, eff().seed], init.random));
    blip('select');
  };
  const digit = (d: MenuDigit): void => {
    const e = top();
    if (!e || e.id !== 'setup' || e.focus !== 'track') return;
    if (entry === null) entry = '';
    if (entry.length < 4) entry += String(d);
    entryAt = facts.time;
  };
  const press = (b: MenuButton): void => {
    switch (b) {
      case 'up':
        moveFocus(-1);
        return;
      case 'down':
        moveFocus(1);
        return;
      case 'left':
        change(-1);
        return;
      case 'right':
        change(1);
        return;
      case 'select':
        select();
        return;
      case 'back':
        back();
        return;
      case 'pause':
        if (state === 'paused') {
          blip('back');
          resume();
        }
        return;
      case 'undo':
        undo();
        return;
      case 'random':
        random();
    }
  };
  const pointerAction = (a: MenuPointerAction): void => {
    if (a.kind === 'button') {
      press(a.button);
      return;
    }
    const e = top();
    if (!e) return;
    const target = buildRows(e).find((r) => r.id === a.row);
    if (!target || target.disabled) return;
    setFocus(a.row);
    if (a.kind === 'focus') return;
    if (a.kind === 'activate') {
      select();
      return;
    }
    if (a.kind === 'step') {
      change(a.delta);
      return;
    }
    // 'set'
    const row = focusedRow();
    if (!row) return;
    if (row.kind === 'choice') applyChoice(row, Math.round(a.value));
    else if (row.kind === 'slider') setMusic(a.value);
    else if (row.kind === 'car') setPaint(row.carId, a.value);
  };

  const canPause = (): boolean => (facts.phase === 'countdown' || facts.phase === 'racing') && facts.finishedFor === null;

  return {
    get state(): MenuState {
      return state;
    },
    running,
    get staged(): Readonly<Partial<GameOptions>> {
      return { ...staged };
    },
    get effects(): readonly MenuEffect[] {
      return effects;
    },
    boot(next: 'race' | 'title'): void {
      effects = [];
      dirty = true;
      booted = true;
      if (next === 'race') {
        state = 'race';
        stack = [];
        serial++;
        effect({ kind: 'guard' });
        host.startRace();
      } else {
        toTitle(false);
      }
      refreshTrack();
    },
    update(command: Readonly<MenuCommand>, f: Readonly<MenuFacts>): MenuState {
      effects = [];
      dirty = true;
      facts = { ...f };
      view = f.view;
      musicVolume = f.musicVolume;
      device = command.device;
      if (reloading || !booted) return state;
      if (entry !== null && f.time - entryAt >= DIGIT_COMMIT_SECONDS) commitEntry();

      if (state === 'race') {
        if ((command.pause || command.escape || command.autoPause) && canPause()) openPause();
        else if (f.finishedFor !== null && f.finishedFor >= POST_DELAY_SECONDS) enterPost();
        refreshTrack();
        return state;
      }

      const state0 = state;
      const serial0 = serial;
      const moved = (): boolean => state !== state0 || serial !== serial0 || reloading;
      const run = (): void => {
        for (const a of command.pointer) {
          pointerAction(a);
          if (moved()) return;
        }
        const order: readonly (readonly [boolean, MenuButton])[] = [
          [command.pause, 'pause'],
          [command.back || command.escape, 'back'],
          [command.undo, 'undo'],
          [command.random, 'random'],
        ];
        for (const [on, b] of order) {
          if (!on) continue;
          press(b);
          if (moved()) return;
        }
        if (command.digit !== null) digit(command.digit);
        const nav: readonly (readonly [boolean, MenuButton])[] = [
          [command.up, 'up'],
          [command.down, 'down'],
          [command.left, 'left'],
          [command.right, 'right'],
          [command.select, 'select'],
        ];
        for (const [on, b] of nav) {
          if (!on) continue;
          press(b);
          if (moved()) return;
        }
      };
      run();
      refreshTrack();
      return state;
    },
    snapshot(): MenuSnapshot {
      if (!dirty && cached) return cached;
      dirty = false;
      const body = build();
      const k = JSON.stringify(body);
      if (cached && k === cachedKey) return cached;
      cachedKey = k;
      version++;
      cached = { ...body, version };
      return cached;
    },
    pin(p: MenuPin): void {
      effects = [];
      dirty = true;
      reloading = false;
      booted = true;
      entry = null;
      const from = p.from ?? 'title';
      stack = [];
      switch (p.screen) {
        case 'title':
        case 'car':
        case 'setup':
          state = 'title';
          enter(makeEntry('title'));
          if (p.screen !== 'title') {
            if (p.screen === 'car') initCarScreen();
            enter(makeEntry(p.screen));
          }
          break;
        case 'settings':
        case 'controls':
          state = from === 'paused' ? 'paused' : 'title';
          enter(makeEntry(from === 'paused' ? 'pause' : 'title'));
          enter(makeEntry(p.screen, from));
          break;
        case 'pause':
          state = 'paused';
          enter(makeEntry('pause'));
          break;
        case 'confirm': {
          const what = p.confirm ?? 'quit';
          state = 'paused';
          const under = makeEntry('pause');
          under.focus = what === 'quit' ? 'quit' : 'restart';
          enter(under);
          enter(makeEntry('confirm', 'paused', what));
          break;
        }
        case 'post':
          state = 'post';
          enter(makeEntry('post'));
          break;
      }
      refreshTrack();
    },
  };
};
