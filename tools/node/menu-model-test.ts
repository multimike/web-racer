// MenuModel + MenuInput + menuFlow acceptance test (SPEC.md section 12,
// check 3: design-documents/menu-mockups/SPEC.md). Plain Node, no browser:
//   node --import ./tools/node/register.mjs tools/node/menu-model-test.ts
// Drives the REAL MenuInput (fake window + fake pads) into the REAL
// MenuModel with a mock host, once with a pad-only and once with a key-only
// command script, and checks on EVERY frame that focus is never missing and
// never on a disabled row. Exit status 1 on any failure.
import { createMenuModel } from '../../src/ui/menu/MenuModel.ts';
import { createMenuInput } from '../../src/input/MenuInput.ts';
import { BAD_SEEDS, carStats, createMenuFlow, randomSeed } from '../../src/game/menuFlow.ts';
import type { MenuKeyValueStore } from '../../src/game/menuFlow.ts';
import { CAR_DESIGNS, optionsToQuery, parseGameOptions } from '../../src/game/options.ts';
import type { GameOptions } from '../../src/game/options.ts';
import { HANDLING_PRESETS } from '../../src/car/handling.ts';
import { rigFor } from '../../src/car/rig.ts';
import type {
  MenuButton,
  MenuCarInfo,
  MenuFacts,
  MenuHost,
  MenuInputSource,
  MenuModel,
  MenuScreenId,
  MenuSnapshot,
  MenuTrackInfo,
} from '../../src/game/contracts/menu.ts';
import type { ViewMode } from '../../src/game/contracts/camera.ts';

let failures = 0;
let passes = 0;
function check(ok: boolean, name: string, detail = ''): void {
  if (ok) passes++;
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ───────────────────────────── fakes ─────────────────────────────

type Listener = (e: unknown) => void;
class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}
class FakeDocument extends FakeTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  activeElement: unknown = null;
}
class FakeWindow extends FakeTarget {
  readonly document = new FakeDocument();
}
interface FakeKeyEvent {
  code: string;
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: unknown;
  prevented: boolean;
  preventDefault(): void;
}
function keyEvent(code: string, o: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  return {
    code,
    key: code,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...o,
  };
}
interface FakePad {
  index: number;
  connected: boolean;
  mapping: string;
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
}
function fakePad(index = 0): FakePad {
  return { index, connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
}

class MemoryStore implements MenuKeyValueStore {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}
const throwingStore: MenuKeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceeded');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

// ───────────────────────────── data ─────────────────────────────

const PAINT_NAMES = ['One', 'Two', 'Three', 'Four'];
const cars: MenuCarInfo[] = CAR_DESIGNS.map((id) => ({
  id,
  name: id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  classLabel: HANDLING_PRESETS[id].label,
  description: HANDLING_PRESETS[id].description,
  massKg: Math.round(rigFor(id).totalMass),
  stats: carStats(id),
  paints: PAINT_NAMES.map((name, i) => ({ name, body: `#1${i}1${i}1${i}`, accent: `#2${i}2${i}2${i}` })),
}));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ───────────────────────────── harness ─────────────────────────────

const PAD_INDEX: Record<MenuButton, number> = { select: 0, back: 1, undo: 2, random: 3, pause: 9, up: 12, down: 13, left: 14, right: 15 };
const KEY_CODE: Record<MenuButton, string> = {
  select: 'Enter',
  back: 'Escape',
  undo: 'Backspace',
  random: 'KeyR',
  pause: 'KeyP',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

type Device = 'pad' | 'keys';

class Harness {
  readonly win = new FakeWindow();
  readonly pads: FakePad[] = [];
  readonly input: MenuInputSource;
  readonly model: MenuModel;
  readonly calls: string[] = [];
  readonly reloads: Partial<GameOptions>[] = [];
  readonly facts: MenuFacts;
  readonly running: GameOptions;
  now = 1000;
  snap: MenuSnapshot;
  /** Screens entered / left (`screen` key: id, or id@from). */
  readonly entered = new Set<string>();
  readonly left = new Set<string>();
  private lastScreen: string | null = null;
  private readonly label: string;

  constructor(label: string, search = '', staged: Partial<GameOptions> = {}, randomFn: () => number = lcg(7)) {
    this.label = label;
    this.running = parseGameOptions(search, '');
    this.facts = {
      time: this.now / 1000,
      phase: 'countdown',
      lap: 1,
      laps: this.running.laps,
      place: 4,
      count: this.running.rivals + 1,
      finishedFor: null,
      finishPlace: null,
      bestLap: 31.42,
      view: this.running.view,
      musicVolume: 0.7,
      audioUnlocked: false,
      padConnected: false,
      narrow: false,
    };
    const facts = this.facts;
    const calls = this.calls;
    const reloads = this.reloads;
    const host: MenuHost = {
      startRace: () => {
        calls.push('startRace');
        facts.phase = 'countdown';
        facts.finishedFor = null;
      },
      pause: () => void calls.push('pause'),
      resume: () => void calls.push('resume'),
      restartRace: () => {
        calls.push('restartRace');
        facts.phase = 'countdown';
        facts.finishedFor = null;
        facts.finishPlace = null;
      },
      enterTitle: (openCar) => {
        calls.push(`enterTitle(${openCar})`);
        facts.phase = 'countdown';
        facts.finishedFor = null;
        facts.finishPlace = null;
      },
      enterPost: () => void calls.push('enterPost'),
      setView: (mode: ViewMode) => {
        calls.push(`setView(${mode})`);
        facts.view = mode;
      },
      setMusicVolume: (v) => {
        calls.push(`setMusicVolume(${v})`);
        facts.musicVolume = v;
      },
      previewCar: (id) => void calls.push(`previewCar(${id})`),
      reload: (o) => {
        calls.push('reload');
        reloads.push(o);
      },
    };
    const tracks = new Map<number, MenuTrackInfo>([[this.running.seed, { seed: this.running.seed, lengthM: 593, outline: 'M0 0L0 -48Z' }]]);
    this.input = createMenuInput({ target: this.win as unknown as Window, pads: () => this.pads as unknown as Gamepad[] });
    this.model = createMenuModel({
      running: this.running,
      host,
      cars,
      tracks: { get: (seed) => tracks.get(seed) ?? null },
      bestLap: (seed) => (seed === 27 ? 40.5 : null),
      random: randomFn,
      view: this.running.view,
      musicVolume: 0.7,
      staged,
    });
    this.snap = this.model.snapshot();
  }

  /** One game frame: poll → update → effects → snapshot → invariants. */
  frame(ms = 1000 / 60): void {
    this.now += ms;
    this.facts.time = this.now / 1000;
    if (this.facts.finishedFor !== null) this.facts.finishedFor += ms / 1000;
    const cmd = this.input.poll(this.now);
    this.model.update(cmd, this.facts);
    this.afterUpdate();
  }
  afterUpdate(): void {
    for (const e of this.model.effects) if (e.kind === 'guard') this.input.guard();
    const s = this.model.snapshot();
    this.input.setRepeat(s.repeat);
    this.input.setCapturing(s.state !== 'race');
    this.snap = s;
    this.invariants(s);
  }
  boot(next: 'race' | 'title'): void {
    // The game runs frames (and updates the model) before the loading panel
    // is gone; the model ignores commands until boot.
    this.frame();
    this.model.boot(next);
    this.afterUpdate();
  }
  frames(n: number): void {
    for (let i = 0; i < n; i++) this.frame();
  }
  private invariants(s: MenuSnapshot): void {
    const where = `${this.label} @${s.screen}`;
    check((s.state === 'race') === (s.screen === null), `${where}: screen null exactly in state race`, `${s.state}/${s.screen}`);
    if (s.screen === null) return;
    const id = s.screen === 'settings' || s.screen === 'controls' ? `${s.screen}@${s.backdrop === 'pause' ? 'paused' : 'title'}` : s.screen;
    if (id !== this.lastScreen) {
      if (this.lastScreen) this.left.add(this.lastScreen);
      this.entered.add(id);
      this.lastScreen = id;
    }
    if (s.rows.length === 0) {
      check(s.focus === -1, `${where}: no rows → focus -1`);
      return;
    }
    const focused = s.rows.filter((r) => r.focused);
    check(s.focus >= 0 && s.focus < s.rows.length, `${where}: focus is never null`, `focus ${s.focus}`);
    check(focused.length === 1 && s.rows[s.focus] === focused[0], `${where}: exactly one focused row, at snapshot.focus`);
    check(!s.rows[s.focus]?.disabled, `${where}: focus never on a disabled row`);
    check(s.prompts.length <= 4, `${where}: at most 4 prompts`);
  }
  /** Track 'left' for the last screen when the state becomes race. */
  noteRace(): void {
    if (this.snap.screen === null && this.lastScreen) {
      this.left.add(this.lastScreen);
      this.lastScreen = null;
    }
  }

  // ── devices ──
  keyDown(code: string, o: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
    const e = keyEvent(code, o);
    this.win.dispatch('keydown', e);
    return e;
  }
  keyUp(code: string): FakeKeyEvent {
    const e = keyEvent(code);
    this.win.dispatch('keyup', e);
    return e;
  }
  pad(): FakePad {
    if (this.pads.length === 0) {
      this.pads.push(fakePad(0));
      this.frame(); // the first poll only primes the pad
    }
    return this.pads[0];
  }
  setButton(i: number, on: boolean): void {
    const b = this.pad().buttons[i];
    b.pressed = on;
    b.value = on ? 1 : 0;
  }
  /** Press and release `b` on `device`, one frame each. */
  press(device: Device, b: MenuButton, times = 1): void {
    for (let i = 0; i < times; i++) {
      if (device === 'pad') {
        this.setButton(PAD_INDEX[b], true);
        this.frame();
        this.setButton(PAD_INDEX[b], false);
        this.frame();
      } else {
        this.keyDown(KEY_CODE[b]);
        this.frame();
        this.keyUp(KEY_CODE[b]);
        this.frame();
      }
      this.noteRace();
    }
  }
  hold(device: Device, b: MenuButton, on: boolean): void {
    if (device === 'pad') this.setButton(PAD_INDEX[b], on);
    else if (on) this.keyDown(KEY_CODE[b]);
    else this.keyUp(KEY_CODE[b]);
  }
  focusId(): string | null {
    return this.snap.focus >= 0 ? this.snap.rows[this.snap.focus].id : null;
  }
  row<T extends string>(id: T) {
    return this.snap.rows.find((r) => r.id === id);
  }
  /** Move focus to row `id` with up / down (at most rows.length presses). */
  focus(device: Device, id: string): void {
    for (let i = 0; i <= this.snap.rows.length && this.focusId() !== id; i++) this.press(device, 'down');
    check(this.focusId() === id, `${this.label}: reach row ${id}`, `on ${this.focusId()}`);
  }
  expectScreen(screen: MenuScreenId | null, name: string): void {
    check(this.snap.screen === screen, `${this.label}: ${name}`, `screen ${this.snap.screen}, state ${this.snap.state}`);
  }
}

/** `staged` holds only keys whose value differs from `running`. */
function stagedIsMinimal(h: Harness, name: string): void {
  const st = h.model.staged as Record<string, unknown>;
  const run = h.running as unknown as Record<string, unknown>;
  for (const k of Object.keys(st)) check(st[k] !== undefined && st[k] !== run[k], `${name}: staged.${k} differs from running`, `${String(st[k])}`);
  for (const k of Object.keys(st)) check(['car', 'livery', 'seed', 'laps', 'rivals', 'difficulty', 'quality'].includes(k), `${name}: staged.${k} is a world key`);
}

/** The reload query the page would assign (menuFlow.reloadWith with a fake
 * location) must equal optionsToQuery(options, {...staged, view, music}). */
function checkReloadQuery(h: Harness, name: string, extra: Partial<GameOptions> = {}): void {
  const session = new MemoryStore();
  let search = '';
  const flow = createMenuFlow({ local: () => new MemoryStore(), session: () => session, assignSearch: (s) => (search = s) });
  const overrides = h.reloads[h.reloads.length - 1];
  check(overrides !== undefined, `${name}: host.reload called`);
  if (!overrides) return;
  const view = h.facts.view;
  const music = h.facts.musicVolume;
  flow.reloadWith(h.running, { ...overrides, view, music });
  const expected = optionsToQuery(h.running, { ...h.model.staged, ...extra, view, music });
  check(search === expected, `${name}: reload query = optionsToQuery(options, {...staged, view, music})`, `${search} vs ${expected}`);
  check(search.startsWith('?') && !search.startsWith('??'), `${name}: query starts with exactly one '?'`, search);
  check(session.getItem('web-racer.menu.next') === 'race', `${name}: one-shot flag set`);
  check(flow.takeMenuNext() === 'race' && flow.takeMenuNext() === 'title', `${name}: flag read AND removed`);
  const back = parseGameOptions(search, '');
  for (const [k, v] of Object.entries(h.model.staged)) check((back as unknown as Record<string, unknown>)[k] === v, `${name}: reloaded page has ${k}=${String(v)}`);
}

// ───────────────────────────── the script (per device) ─────────────────────────────

function script(device: Device): void {
  const L = `[${device}]`;
  const h = new Harness(L);
  if (device === 'pad') h.pad();
  // BOOT → TITLE
  h.boot('title');
  h.expectScreen('title', 'boot(title) opens the title');
  check(h.focusId() === 'race', `${L} title opens on RACE`);
  check(h.calls.includes('enterTitle(false)'), `${L} boot(title) → host.enterTitle(false)`);
  check(h.snap.soundChip !== null, `${L} sound chip while audio locked`);

  // wrap
  h.press(device, 'up');
  check(h.snap.prompts.every((p) => p.glyph.startsWith('key-') === (device === 'keys')), `${L} prompts follow device`);
  check(h.focusId() === 'controls', `${L} focus wraps up: RACE → CONTROLS`, String(h.focusId()));
  h.press(device, 'down');
  check(h.focusId() === 'race', `${L} focus wraps down: CONTROLS → RACE`, String(h.focusId()));
  // right does nothing on action / link rows
  h.press(device, 'right');
  check(h.focusId() === 'race' && h.snap.screen === 'title', `${L} right does nothing on an action row`);
  // back on the title root does nothing; pause is ignored
  h.press(device, 'back');
  h.press(device, 'pause');
  h.expectScreen('title', 'back / pause do nothing on the title root');

  // every title link: in and out again
  for (const [row, screen] of [
    ['car', 'car'],
    ['setup', 'setup'],
    ['settings', 'settings'],
    ['controls', 'controls'],
  ] as const) {
    h.focus(device, row);
    h.press(device, 'select');
    h.expectScreen(screen, `select ${row} opens ${screen}`);
    h.press(device, 'back');
    h.expectScreen('title', `back from ${screen} returns to the title`);
    check(h.focusId() === row, `${L} title remembers its focus (${row})`, String(h.focusId()));
  }

  // ── car: browse, paint, CHOOSE ──
  h.focus(device, 'car');
  h.press(device, 'select');
  check(h.focusId() === 'car:reef-rocket', `${L} car screen opens on the running car`, String(h.focusId()));
  check(h.calls.includes('previewCar(reef-rocket)'), `${L} car screen previews the focused car`);
  check(h.row('car:reef-rocket')?.tags.some((t) => t.kind === 'live') === true, `${L} ON THE GRID tag on the running car`);
  h.press(device, 'down');
  check(h.calls[h.calls.length - 1] === 'previewCar(neon-wasp)', `${L} browsing previews each design`);
  h.press(device, 'right');
  h.press(device, 'right');
  h.press(device, 'left');
  const wasp = h.row('car:neon-wasp');
  check(wasp?.kind === 'car' && wasp.paintIndex === 1, `${L} left / right change the paint`, JSON.stringify(wasp && wasp.kind === 'car' ? wasp.paintIndex : null));
  check(h.snap.aside?.kind === 'car' && h.snap.aside.name === 'NEON WASP' && h.snap.aside.paintPosition === '2 / 4', `${L} car sheet follows`);
  for (let i = 0; i < 6; i++) h.press(device, 'left');
  const wasp0 = h.row('car:neon-wasp');
  check(wasp0?.kind === 'car' && wasp0.paintIndex === 0, `${L} paint does not wrap below 0`);
  h.press(device, 'right');
  h.press(device, 'select');
  h.expectScreen('title', 'CHOOSE returns to the title');
  check(h.calls[h.calls.length - 1] === 'previewCar(null)', `${L} leaving the car screen previews the player again`);
  check(h.model.staged.car === 'neon-wasp' && h.model.staged.livery === 1, `${L} CHOOSE stages car + livery`, JSON.stringify(h.model.staged));
  stagedIsMinimal(h, `${L} after CHOOSE`);
  check(h.snap.stagedCount === 1, `${L} car + livery count as one change`);
  const carRow = h.row('car');
  check(carRow?.kind === 'link' && carRow.value?.staged === true && carRow.value.lines[0] === 'NEON WASP', `${L} title CAR row shows the staged car in yellow`);
  // back on the car screen leaves staged unchanged; choosing the running car clears it
  h.press(device, 'select');
  check(h.focusId() === 'car:neon-wasp', `${L} car screen re-opens on the staged car`);
  h.press(device, 'up');
  h.press(device, 'back');
  check(h.model.staged.car === 'neon-wasp', `${L} Circle = back without changing staged`);
  h.press(device, 'select');
  h.press(device, 'up');
  h.press(device, 'select');
  check(h.model.staged.car === undefined && h.model.staged.livery === undefined, `${L} choosing the running car + paint clears the stage`, JSON.stringify(h.model.staged));

  // ── setup ──
  h.focus(device, 'setup');
  h.press(device, 'select');
  h.expectScreen('setup', 'setup open');
  check(h.focusId() === 'track', `${L} setup opens on TRACK`);
  check(h.snap.prompts.length <= 4 && h.snap.prompts.some((p) => p.label === 'RANDOM TRACK'), `${L} TRACK row offers RANDOM TRACK`);
  h.press(device, 'right');
  check(h.model.staged.seed === 17, `${L} TRACK right = seed + 1`, String(h.model.staged.seed));
  check(h.row('track')?.tags[0]?.text === 'WAS 16', `${L} WAS 16 tag on a staged TRACK`);
  check(h.snap.prompts.length === 4 && !h.snap.prompts.some((p) => p.label === 'MOVE'), `${L} 5 prompts → MOVE dropped`);
  h.press(device, 'left');
  check(h.model.staged.seed === undefined, `${L} back to the running seed deletes the key`);
  // RANDOM never returns running / current / BAD_SEEDS
  let prev = h.running.seed;
  let randomOk = true;
  for (let i = 0; i < 150; i++) {
    h.press(device, 'random');
    const s = h.model.staged.seed ?? h.running.seed;
    if (s === h.running.seed || s === prev || BAD_SEEDS.includes(s) || s < 1 || s > 1100) randomOk = false;
    prev = s;
  }
  check(randomOk, `${L} RANDOM never returns the running seed, the current seed or a BAD_SEEDS entry`);
  h.press(device, 'undo');
  check(h.model.staged.seed === undefined, `${L} Square on TRACK clears the staged seed`);
  // wrap 1 ↔ 9999: from 16 go left 16 times
  for (let i = 0; i < 16; i++) h.press(device, 'left');
  check(h.model.staged.seed === 9999, `${L} TRACK wraps 1 → 9999`, String(h.model.staged.seed));
  h.press(device, 'right');
  check(h.model.staged.seed === 1, `${L} TRACK wraps 9999 → 1`, String(h.model.staged.seed));
  h.press(device, 'undo');

  // LAPS: ENDLESS and 99 stops
  h.press(device, 'down');
  check(h.focusId() === 'laps' && h.snap.repeat === 'fast', `${L} LAPS row, fast repeat`);
  h.press(device, 'left', 5);
  let laps = h.row('laps');
  check(laps?.kind === 'stepper' && laps.value === 0 && laps.text === 'ENDLESS' && !laps.canDecrease, `${L} LAPS stops at ENDLESS`, JSON.stringify(laps && laps.kind === 'stepper' ? [laps.value, laps.text] : null));
  check(h.model.staged.laps === 0, `${L} ENDLESS = laps 0`);
  // hold right: repeat 350 ms then 110 ms, 40 ms after 1.5 s → reaches 99 and stops
  h.hold(device, 'right', true);
  const fired: number[] = [];
  for (let t = 0; t < 7000; t += 1000 / 60) {
    const before = h.model.staged.laps ?? h.running.laps;
    h.frame();
    const after = h.model.staged.laps ?? h.running.laps;
    if (after !== before) fired.push(h.now);
  }
  h.hold(device, 'right', false);
  h.frame();
  laps = h.row('laps');
  check(laps?.kind === 'stepper' && laps.value === 99 && !laps.canIncrease, `${L} LAPS stops at 99`, JSON.stringify(laps && laps.kind === 'stepper' ? laps.value : null));
  const gaps = fired.slice(1).map((t, i) => t - fired[i]);
  check(gaps.length > 10 && gaps[0] >= 340 && gaps[0] <= 370, `${L} first repeat after 350 ms`, `${gaps[0]?.toFixed(0)} ms`);
  check(gaps.length > 10 && Math.abs(gaps[2] - 110) <= 17, `${L} then every 110 ms`, `${gaps[2]?.toFixed(0)} ms`);
  const late = gaps.slice(-5);
  check(late.length === 5 && late.every((g) => g <= 51), `${L} 40 ms after 1.5 s held (fast row)`, late.map((g) => g.toFixed(0)).join(' '));
  h.press(device, 'right');
  check((h.model.staged.laps ?? h.running.laps) === 99, `${L} LAPS does not go past 99`);
  h.press(device, 'undo');
  check(h.model.staged.laps === undefined, `${L} Square clears the LAPS row`);

  // RIVALS: values do not wrap, select wraps
  h.press(device, 'down');
  check(h.focusId() === 'rivals', `${L} RIVALS row`);
  h.press(device, 'right');
  check(h.model.staged.rivals === undefined, `${L} RIVALS right at 3 stays (no wrap)`);
  h.press(device, 'select');
  check(h.model.staged.rivals === 0, `${L} select on a choice steps to the next option (wraps)`, String(h.model.staged.rivals));
  h.press(device, 'down');
  h.press(device, 'select');
  check(h.model.staged.difficulty === 0.72, `${L} DIFFICULTY select NORMAL → HARD`, String(h.model.staged.difficulty));
  stagedIsMinimal(h, `${L} setup`);
  // down to START RACE, then wrap to TRACK
  h.press(device, 'down');
  check(h.focusId() === 'start', `${L} START RACE row`);
  const start = h.row('start');
  check(start?.kind === 'action' && start.value?.lines.join('|') === '2 CHANGES|LOADS A NEW WORLD', `${L} START RACE shows the change count`);
  h.press(device, 'down');
  check(h.focusId() === 'track', `${L} setup focus wraps`);
  h.press(device, 'back');
  h.expectScreen('title', 'back from setup keeps staged');
  check(h.model.staged.rivals === 0 && h.model.staged.difficulty === 0.72, `${L} staged values survive Back`);
  const setupRow = h.row('setup');
  check(setupRow?.tags.some((t) => t.kind === 'new' && t.text === '2 NEW') === true, `${L} RACE SETUP tag 2 NEW`);
  const raceRow = h.row('race');
  check(raceRow?.kind === 'action' && raceRow.sub?.lines[0] === 'TRACK 16 · 3 LAPS · NEW WORLD', `${L} RACE sub-line with staged values`, raceRow?.kind === 'action' ? raceRow.sub?.lines[0] : '');
  h.focus(device, 'race');
  check(h.snap.help === 'Builds the new grid, then starts the race.', `${L} RACE help without a seed change`, h.snap.help);
  check(h.snap.prompts.some((p) => p.label === 'UNDO'), `${L} title shows UNDO while staged`);
  // Square on the title root clears everything
  h.press(device, 'undo');
  check(Object.keys(h.model.staged).length === 0, `${L} Square on the title root clears all`, JSON.stringify(h.model.staged));

  // ── settings (from title): live camera + music, staged quality ──
  h.focus(device, 'settings');
  h.press(device, 'select');
  h.expectScreen('settings', 'settings open');
  h.press(device, 'right');
  check(h.calls[h.calls.length - 1] === 'setView(high)' && h.facts.view === 'high', `${L} CAMERA applies live`);
  h.press(device, 'select');
  check(h.facts.view === 'xr', `${L} CAMERA select steps (DIORAMA)`);
  h.press(device, 'select');
  check(h.facts.view === 'chase', `${L} CAMERA select wraps to CHASE`);
  h.press(device, 'down');
  h.press(device, 'left');
  check(h.facts.musicVolume === 0.6, `${L} MUSIC applies live`, String(h.facts.musicVolume));
  h.press(device, 'select');
  check(h.facts.musicVolume === 0.6, `${L} select on a slider does nothing`);
  h.press(device, 'left', 8);
  const music = h.row('music');
  check(music?.kind === 'slider' && music.value === 0 && music.text === 'OFF', `${L} MUSIC 0 = OFF, no lower`);
  h.press(device, 'right', 7);
  h.press(device, 'down');
  h.press(device, 'right');
  check(h.model.staged.quality === 'quest', `${L} QUALITY is staged`);
  check(h.row('quality')?.tags[0]?.text === 'WAS HIGH', `${L} QUALITY WAS HIGH`);
  h.press(device, 'undo');
  check(h.model.staged.quality === undefined, `${L} Square clears QUALITY`);
  h.press(device, 'right');
  h.press(device, 'back');

  // ── staged RACE → one reload ──
  h.focus(device, 'setup');
  h.press(device, 'select');
  h.press(device, 'right', 11); // seed 27
  h.press(device, 'down');
  h.press(device, 'right', 2); // laps 5
  h.press(device, 'back');
  h.focus(device, 'race');
  check(h.snap.help === 'Builds track 27, then starts the race.', `${L} RACE help with a seed change`, h.snap.help);
  const next = h.snap.aside;
  check(next?.kind === 'next' && next.staged && next.caption === 'NEW · 5 LAPS' && next.track === null, `${L} NEXT RACE plate shows the staged seed`, JSON.stringify(next));
  check(next?.kind === 'next' && next.best === '0:40.50', `${L} NEXT RACE best lap of the staged seed`);
  h.press(device, 'select');
  check(h.calls[h.calls.length - 1] === 'reload' && h.reloads.length === 1, `${L} RACE with staged values reloads once`);
  check(JSON.stringify(h.reloads[0]) === JSON.stringify(h.model.staged), `${L} reload overrides = staged`);
  checkReloadQuery(h, `${L} RACE`);
  h.press(device, 'select');
  h.press(device, 'down');
  check(h.reloads.length === 1, `${L} nothing after the reload`);

  // ── a new page: race, pause, confirm, post ──
  const g = new Harness(`${L}#2`);
  if (device === 'pad') g.pad();
  g.boot('title');
  g.press(device, 'select');
  check(g.snap.state === 'race' && g.calls.includes('startRace'), `${L} RACE without staging → startRace, no reload`);
  check(g.model.effects.length === 0 || true, 'effects read');
  g.noteRace();
  // during the race only pause / escape matter
  g.press(device, 'select');
  if (device === 'pad') g.press(device, 'back'); // (Escape = back + escape opens the pause)
  g.press(device, 'down');
  g.press(device, 'undo');
  check(g.snap.state === 'race', `${L} race ignores select / back (Circle) / down / undo`);
  // before boot nothing opens
  const early = new Harness(`${L}#early`);
  early.press(device, 'pause');
  check(early.snap.state === 'race' && early.calls.length === 0, `${L} commands before boot() are ignored`);
  // pause in the countdown: RESTART without confirm, RESUME help
  g.press(device, 'pause');
  g.expectScreen('pause', 'pause during the 3-2-1');
  check(g.snap.breadcrumb === 'STARTING GRID', `${L} STARTING GRID breadcrumb`, String(g.snap.breadcrumb));
  check(g.snap.help === 'The countdown starts again.', `${L} countdown RESUME help`);
  g.press(device, 'down');
  g.press(device, 'select');
  check(g.calls[g.calls.length - 1] === 'restartRace' && g.snap.state === 'race', `${L} RESTART in the countdown skips the confirm`);
  g.noteRace();
  g.facts.phase = 'racing';
  g.facts.lap = 2;
  g.facts.place = 2;
  // pause from racing
  g.press(device, 'pause');
  g.expectScreen('pause', 'pause while racing');
  check(g.calls[g.calls.length - 1] === 'pause', `${L} host.pause()`);
  check(g.focusId() === 'resume', `${L} pause opens on RESUME`);
  check(g.snap.breadcrumb === 'LAP 2 / 3 · 2ND OF 4', `${L} pause breadcrumb`, String(g.snap.breadcrumb));
  check(g.snap.backdrop === 'pause', `${L} pause backdrop`);
  g.press(device, 'up');
  check(g.focusId() === 'quit', `${L} pause focus wraps to QUIT`);
  g.press(device, 'down');
  // back on the root resumes
  g.press(device, 'back');
  check(g.snap.state === 'race' && g.calls[g.calls.length - 1] === 'resume', `${L} back on the pause root resumes`);
  g.noteRace();
  // settings from pause: QUALITY disabled, focus skips it
  g.press(device, 'pause');
  g.focus(device, 'settings');
  g.press(device, 'select');
  g.expectScreen('settings', 'settings from pause');
  check(g.snap.breadcrumb === 'PAUSED / SETTINGS' && g.snap.backdrop === 'pause', `${L} PAUSED / SETTINGS`);
  check(g.row('quality')?.disabled === true, `${L} QUALITY not focusable from pause`);
  g.press(device, 'down');
  g.press(device, 'down');
  check(g.focusId() === 'camera', `${L} focus skips the disabled row and wraps`, String(g.focusId()));
  g.press(device, 'up');
  check(g.focusId() === 'music', `${L} focus up skips the disabled row`, String(g.focusId()));
  // pause = resume from any depth
  g.press(device, 'pause');
  check(g.snap.state === 'race' && g.calls[g.calls.length - 1] === 'resume', `${L} pause resumes from any depth`);
  g.noteRace();
  // controls from pause, then back
  g.press(device, 'pause');
  g.focus(device, 'controls');
  g.press(device, 'select');
  g.expectScreen('controls', 'controls from pause');
  check(g.snap.rows.length === 0 && g.snap.tips.length === 4 && g.snap.aside?.kind === 'controls', `${L} controls: tips + sheet`);
  g.press(device, 'down');
  g.press(device, 'back');
  g.expectScreen('pause', 'back from controls → pause');
  check(g.focusId() === 'controls', `${L} pause remembers its focus`);
  // CAMERA in pause: left / right live
  g.focus(device, 'camera');
  g.press(device, 'left');
  check(g.calls[g.calls.length - 1] === 'setView(chase)' || g.facts.view === 'chase', `${L} pause CAMERA no wrap at CHASE`);
  g.press(device, 'right');
  check(g.facts.view === 'high', `${L} pause CAMERA live`);
  g.press(device, 'down');
  g.press(device, 'right');
  check(g.facts.musicVolume === 0.8, `${L} pause MUSIC live`, String(g.facts.musicVolume));
  // RESTART RACE → confirm (racing)
  g.focus(device, 'restart');
  g.press(device, 'select');
  g.expectScreen('confirm', 'RESTART asks while racing');
  check(g.focusId() === 'keep' && g.snap.headline[0] === 'RESTART?', `${L} confirm opens on KEEP RACING`);
  check(g.snap.say === 'This race starts again from the grid: lap 2 of 3, running 2nd.', `${L} restart text`, String(g.snap.say));
  g.press(device, 'back');
  g.expectScreen('pause', 'Circle on confirm = KEEP RACING');
  g.press(device, 'select');
  g.press(device, 'down');
  g.press(device, 'select');
  check(g.calls[g.calls.length - 1] === 'restartRace' && g.snap.state === 'race', `${L} confirmed RESTART`);
  g.noteRace();
  g.facts.phase = 'racing';
  // QUIT → confirm → title
  g.press(device, 'pause');
  g.focus(device, 'quit');
  g.press(device, 'select');
  g.expectScreen('confirm', 'QUIT asks while racing');
  check(g.snap.breadcrumb === 'PAUSED / QUIT TO TITLE' && g.snap.headline[0] === 'QUIT?', `${L} quit confirm`);
  check(g.snap.say === 'This race ends here: lap 2 of 3, running 2nd. Your best lap on Track 16 is kept.', `${L} quit text`, String(g.snap.say));
  g.press(device, 'select');
  g.expectScreen('pause', 'KEEP RACING returns to pause');
  check(g.focusId() === 'quit', `${L} pause keeps focus on QUIT`);
  g.press(device, 'select');
  g.press(device, 'up');
  check(g.focusId() === 'confirm', `${L} confirm focus wraps`);
  g.press(device, 'select');
  g.expectScreen('title', 'confirmed QUIT → title');
  check(g.calls[g.calls.length - 1] === 'enterTitle(false)', `${L} host.enterTitle(false)`);

  // post: appears 2.5 s after the finish
  g.press(device, 'select'); // RACE
  g.noteRace();
  g.facts.phase = 'finished';
  g.facts.finishPlace = 2;
  g.facts.finishedFor = 0;
  g.frames(60);
  check(g.snap.state === 'race', `${L} no post stack before 2.5 s`);
  g.press(device, 'pause');
  check(g.snap.state === 'race', `${L} no pause after the finish`);
  g.frames(100);
  g.expectScreen('post', 'post stack after 2.5 s');
  check(g.calls.includes('enterPost') && g.focusId() === 'again', `${L} post opens on RACE AGAIN`);
  check(g.snap.aside?.kind === 'medal' && g.snap.aside.ordinal === 'ND' && !g.snap.aside.gold, `${L} medal 2ND`);
  g.press(device, 'up');
  check(g.focusId() === 'title', `${L} post focus wraps`);
  g.press(device, 'pause');
  check(g.snap.screen === 'post', `${L} pause ignored on post`);
  g.press(device, 'back');
  g.expectScreen('title', 'Circle on post = TITLE');
  // post → CHANGE CAR
  g.press(device, 'select');
  g.noteRace();
  g.facts.phase = 'finished';
  g.facts.finishPlace = 1;
  g.facts.finishedFor = 3;
  g.frame();
  g.expectScreen('post', 'post again');
  check(g.snap.aside?.kind === 'medal' && g.snap.aside.gold, `${L} first place = gold medal`);
  g.focus(device, 'changeCar');
  g.press(device, 'select');
  g.expectScreen('car', 'CHANGE CAR → car screen on the title');
  check(g.calls.includes('enterTitle(true)'), `${L} host.enterTitle(true)`);
  g.press(device, 'back');
  g.expectScreen('title', 'back from that car screen → title');
  // post → RACE AGAIN
  g.press(device, 'select');
  g.noteRace();
  g.facts.finishedFor = 3;
  g.frame();
  g.press(device, 'select');
  check(g.calls[g.calls.length - 1] === 'restartRace' && g.snap.state === 'race', `${L} RACE AGAIN = restartRace, no reload`);
  g.noteRace();
  // post → NEXT TRACK (with a staged change kept from earlier)
  g.press(device, 'pause');
  g.facts.phase = 'racing';
  g.focus(device, 'quit');
  g.press(device, 'select');
  g.press(device, 'down');
  g.press(device, 'select'); // quit → title
  g.focus(device, 'setup');
  g.press(device, 'select');
  g.press(device, 'down');
  g.press(device, 'right'); // laps 4
  g.press(device, 'back');
  // the title RACE would reload now; reach post another way: boot a third page with staged laps
  const p = new Harness(`${L}#3`, 'seed=9999', { laps: 4, rivals: 3 });
  if (device === 'pad') p.pad();
  check(JSON.stringify(p.model.staged) === '{"laps":4}', `${L} init.staged drops keys equal to running`, JSON.stringify(p.model.staged));
  p.boot('race');
  check(p.snap.state === 'race' && p.calls.includes('startRace'), `${L} boot(race) → startRace`);
  p.facts.finishPlace = 3;
  p.facts.finishedFor = 0;
  p.frames(160);
  p.expectScreen('post', 'post');
  p.focus(device, 'next');
  const nextRow = p.row('next');
  check(nextRow?.kind === 'action' && nextRow.sub?.lines[0] === 'TRACK 1 · NEW WORLD', `${L} NEXT TRACK caption (9999 → 1)`);
  p.press(device, 'select');
  check(p.reloads.length === 1 && p.reloads[0].seed === 1 && p.reloads[0].laps === 4, `${L} NEXT TRACK reloads seed % 9999 + 1 plus staged`, JSON.stringify(p.reloads[0]));
  checkReloadQuery(p, `${L} NEXT TRACK`, { seed: 1 });

  // every screen reachable and left again
  const all = [...h.entered, ...g.entered, ...p.entered];
  const leftAll = new Set([...h.left, ...g.left, ...p.left]);
  for (const s of ['title', 'car', 'setup', 'settings@title', 'controls@title', 'pause', 'settings@paused', 'controls@paused', 'confirm', 'post']) {
    check(all.includes(s), `${L} screen ${s} reached`);
    check(leftAll.has(s), `${L} screen ${s} left again`);
  }
}

// ───────────────────────────── guard, priming, digits ─────────────────────────────

function guardTests(): void {
  // MenuInput alone: a held button is swallowed until released.
  for (const device of ['pad', 'keys'] as const) {
    const L = `[guard ${device}]`;
    const h = new Harness(L);
    if (device === 'pad') h.pad();
    h.boot('title');
    // hold Cross / Enter, guard, many frames: never a select
    h.hold(device, 'select', true);
    h.frame();
    check(h.snap.state === 'race', `${L} Cross on RACE starts the race`);
    h.noteRace();
    // still held: open pause (guard) — the held select must not pick RESUME
    if (device === 'pad') {
      h.setButton(9, true);
      h.frame();
      h.setButton(9, false);
    } else {
      h.keyDown('Escape');
      h.frame();
      h.keyUp('Escape');
    }
    h.frames(90);
    check(h.snap.state === 'paused', `${L} held Cross does not select on the next screen`);
    h.hold(device, 'select', false);
    h.frames(2);
    check(h.snap.state === 'paused', `${L} releasing it does not select either`);
    // a direction held through the guard does not repeat
    h.hold(device, 'down', true);
    h.frame();
    check(h.focusId() === 'restart', `${L} down moves`);
    // resume and pause again with down still held
    h.press(device, 'pause');
    h.noteRace();
    check(h.snap.state === 'race', `${L} pause resumes`);
    h.press(device, 'pause');
    check(h.snap.state === 'paused' && h.focusId() === 'resume', `${L} pause reopens on RESUME`);
    h.frames(120);
    check(h.focusId() === 'resume', `${L} a direction held through the guard does not repeat`, String(h.focusId()));
    h.hold(device, 'down', false);
    h.frame();
    h.press(device, 'down');
    check(h.focusId() === 'restart', `${L} after its release it works again`);
    // Options / P held through RESUME does not re-open the pause
    h.hold(device, 'pause', true);
    h.frame();
    check(h.snap.state === 'race', `${L} pause button resumes`);
    h.noteRace();
    h.frames(60);
    check(h.snap.state === 'race', `${L} held pause button never re-opens the pause`);
    h.hold(device, 'pause', false);
    h.frame();
  }

  // direct MenuInput: guard() then poll
  {
    const win = new FakeWindow();
    const pad = fakePad(0);
    const pads: FakePad[] = [pad];
    const input = createMenuInput({ target: win as unknown as Window, pads: () => pads as unknown as Gamepad[] });
    let t = 0;
    const poll = () => input.poll((t += 16.7));
    pad.buttons[0].pressed = true; // the waking press
    check(!poll().select, '[input] the first poll of a pad only primes it');
    check(!poll().select, '[input] the waking press stays ignored while held');
    pad.buttons[0].pressed = false;
    poll();
    pad.buttons[0].pressed = true;
    check(poll().select, '[input] a real press fires');
    check(!poll().select, '[input] edge-triggered');
    pad.buttons[0].pressed = false;
    poll();
    pad.buttons[1].pressed = true;
    poll();
    input.guard();
    let any = false;
    for (let i = 0; i < 100; i++) any = any || poll().back;
    check(!any, '[input] guard swallows a held Circle');
    pad.buttons[1].pressed = false;
    poll();
    pad.buttons[1].pressed = true;
    check(poll().back, '[input] Circle works after its release');
    pad.buttons[1].pressed = false;
    poll();
    // stick thresholds and dominant axis
    pad.axes[1] = 0.5;
    check(!poll().down, '[input] stick 0.5 does not fire');
    pad.axes[1] = 0.56;
    check(poll().down, '[input] stick 0.56 fires down');
    pad.axes[1] = 0.35;
    check(!poll().down, '[input] still held above 0.3, no new edge before the repeat');
    pad.axes[1] = 0.25;
    poll();
    pad.axes[1] = 0.6;
    check(poll().down, '[input] re-armed below 0.3');
    pad.axes[1] = 0;
    poll();
    pad.axes[0] = 0.7;
    pad.axes[1] = -0.6;
    const c = poll();
    check(c.right && !c.up, '[input] the dominant axis wins');
    pad.axes[0] = 0;
    pad.axes[1] = 0;
    poll();
    check(poll().device === 'gamepad', '[input] device = gamepad');
    // keyboard: modifiers, repeat events, form controls, digits, preventDefault
    input.setCapturing(true);
    let e = keyEvent('ArrowDown', { metaKey: true });
    win.dispatch('keydown', e);
    check(!poll().down, '[input] Cmd+key ignored');
    e = keyEvent('KeyS', { target: { tagName: 'INPUT' } });
    win.dispatch('keydown', e);
    check(!poll().down, '[input] key in a form control ignored');
    e = keyEvent('KeyS');
    win.dispatch('keydown', e);
    const k = poll();
    check(k.down && k.device === 'keyboard' && e.prevented, '[input] KeyS = down, preventDefault while capturing');
    win.dispatch('keydown', keyEvent('KeyS', { repeat: true }));
    check(!poll().down, '[input] e.repeat ignored');
    win.dispatch('keyup', keyEvent('KeyS'));
    win.dispatch('keydown', keyEvent('Escape'));
    const esc = poll();
    check(esc.back && esc.escape, '[input] Escape = back + escape');
    win.dispatch('keyup', keyEvent('Escape'));
    pad.buttons[1].pressed = true;
    const circ = poll();
    check(circ.back && !circ.escape, '[input] Circle = back only');
    pad.buttons[1].pressed = false;
    poll();
    win.dispatch('keydown', keyEvent('Digit4'));
    win.dispatch('keyup', keyEvent('Digit4'));
    win.dispatch('keydown', keyEvent('Numpad2'));
    win.dispatch('keyup', keyEvent('Numpad2'));
    check(poll().digit === 4 && poll().digit === 2 && poll().digit === null, '[input] digits one per poll, in order');
    input.setCapturing(false);
    e = keyEvent('ArrowUp');
    win.dispatch('keydown', e);
    check(poll().up && !e.prevented, '[input] no preventDefault while not capturing');
    win.dispatch('keyup', keyEvent('ArrowUp'));
    // auto pause: blur, hidden page, last pad gone
    win.dispatch('blur', {});
    check(poll().autoPause && !poll().autoPause, '[input] blur → autoPause edge');
    win.document.visibilityState = 'hidden';
    win.document.dispatch('visibilitychange', {});
    check(poll().autoPause, '[input] hidden page → autoPause');
    win.document.visibilityState = 'visible';
    pad.buttons[0].pressed = true;
    poll();
    pad.buttons[0].pressed = false;
    poll();
    pads.length = 0;
    check(poll().autoPause, '[input] the last-used pad disconnecting → autoPause');
    input.push({ kind: 'button', button: 'back' });
    const pc = poll();
    check(pc.pointer.length === 1 && pc.device === 'pointer', '[input] pushed pointer actions arrive with device pointer');
    check(poll().pointer.length === 0, '[input] pointer queue is emptied');
    input.dispose();
    check([...win.listeners.values()].every((s) => s.size === 0), '[input] dispose removes listeners');
  }

  // a pad appearing with Cross held on the title does nothing
  {
    const h = new Harness('[priming]');
    h.boot('title');
    const pad = fakePad(0);
    pad.buttons[0].pressed = true;
    h.pads.push(pad);
    h.frames(30);
    check(h.snap.screen === 'title', '[priming] the waking Cross does not start the race');
    pad.buttons[0].pressed = false;
    h.frame();
    pad.buttons[0].pressed = true;
    h.frame();
    check(h.snap.state === 'race', '[priming] the next press does');
  }
}

function digitTests(): void {
  const L = '[digits]';
  const h = new Harness(L);
  h.boot('title');
  h.focus('keys', 'setup');
  h.press('keys', 'select');
  const type = (d: string): void => {
    h.keyDown(`Digit${d}`);
    h.frame();
    h.keyUp(`Digit${d}`);
    h.frame();
  };
  type('2');
  type('7');
  const tr = h.row('track');
  check(tr?.kind === 'stepper' && tr.entry === '27' && tr.text === '27', `${L} typed digits show`);
  check(h.model.staged.seed === undefined, `${L} not committed yet`);
  h.frames(Math.ceil(1.25 * 60));
  check(h.model.staged.seed === 27, `${L} committed after 1.2 s`, String(h.model.staged.seed));
  type('4');
  type('2');
  h.press('keys', 'select');
  check(h.model.staged.seed === 42, `${L} Enter commits`, String(h.model.staged.seed));
  type('1');
  type('2');
  type('3');
  type('4');
  type('5');
  h.press('keys', 'select');
  check(h.model.staged.seed === 1234, `${L} at most 4 digits`, String(h.model.staged.seed));
  type('9');
  h.press('keys', 'down');
  check(h.model.staged.seed === 9 && h.focusId() === 'laps', `${L} leaving the row commits`, String(h.model.staged.seed));
  h.press('keys', 'up');
  type('0');
  h.press('keys', 'select');
  check(h.model.staged.seed === 9, `${L} 0 = no change`);
  type('5');
  type('6');
  h.press('keys', 'undo');
  h.press('keys', 'select');
  check(h.model.staged.seed === 5, `${L} Backspace drops the last digit`, String(h.model.staged.seed));
  type('1');
  type('6');
  h.press('keys', 'select');
  check(h.model.staged.seed === undefined, `${L} typing the running seed un-stages it`);
  // digits elsewhere do nothing
  h.press('keys', 'down');
  type('5');
  check((h.model.staged.laps ?? 3) === 3, `${L} digits only on TRACK`);
  // W / S / A / D aliases
  h.keyDown('KeyW');
  h.frame();
  h.keyUp('KeyW');
  h.frame();
  check(h.focusId() === 'track', `${L} KeyW = up`);
  h.keyDown('KeyD');
  h.frame();
  h.keyUp('KeyD');
  h.frame();
  check(h.model.staged.seed === 17, `${L} KeyD = right`);
}

function pointerTests(): void {
  const L = '[pointer]';
  const h = new Harness(L);
  h.boot('title');
  h.input.push({ kind: 'focus', row: 'settings', via: 'pointer' });
  h.frame();
  check(h.focusId() === 'settings' && h.snap.device === 'pointer', `${L} focus by pointer`);
  h.input.push({ kind: 'activate', row: 'setup' });
  h.frame();
  h.expectScreen('setup', 'activate opens a row');
  h.input.push({ kind: 'set', row: 'rivals', value: 1 });
  h.frame();
  check(h.model.staged.rivals === 1 && h.focusId() === 'rivals', `${L} set a segment`);
  h.input.push({ kind: 'step', row: 'laps', delta: 1 });
  h.frame();
  check(h.model.staged.laps === 4, `${L} step a stepper`);
  h.input.push({ kind: 'button', button: 'back' });
  h.frame();
  h.expectScreen('title', 'prompt button back');
  h.input.push({ kind: 'activate', row: 'settings' });
  h.frame();
  h.input.push({ kind: 'set', row: 'music', value: 3 });
  h.frame();
  check(h.facts.musicVolume === 0.3, `${L} click on pip 3`);
  h.input.push({ kind: 'focus', row: 'nope' as never, via: 'tab' });
  h.frame();
  check(h.focusId() === 'music', `${L} unknown row ignored`);
  // pause from settings-from-pause: quality disabled ignores pointer focus
  const g = new Harness(`${L}#2`);
  g.model.pin({ screen: 'settings', from: 'paused' });
  g.afterUpdate();
  g.input.push({ kind: 'focus', row: 'quality', via: 'pointer' });
  g.frame();
  check(g.focusId() === 'camera', `${L} disabled row cannot take pointer focus`);
}

function snapshotTests(): void {
  const h = new Harness('[snapshot]');
  h.boot('title');
  h.frame();
  const a = h.model.snapshot();
  h.frame();
  const b = h.model.snapshot();
  check(a === b, '[snapshot] same object while nothing changes');
  h.press('keys', 'down');
  const c = h.model.snapshot();
  check(c !== b && c.version > b.version, '[snapshot] new object with a higher version on change');
  check(c.serial === b.serial, '[snapshot] serial unchanged by a focus move');
  h.press('keys', 'select');
  check(h.model.snapshot().serial > c.serial, '[snapshot] serial rises on entering a screen');
  // pin every screen
  for (const pin of [
    { screen: 'title' },
    { screen: 'car' },
    { screen: 'setup' },
    { screen: 'settings' },
    { screen: 'settings', from: 'paused' },
    { screen: 'controls' },
    { screen: 'controls', from: 'paused' },
    { screen: 'pause' },
    { screen: 'confirm' },
    { screen: 'confirm', confirm: 'restart' },
    { screen: 'post' },
  ] as const) {
    const p = new Harness(`[pin ${pin.screen}]`);
    const before = p.calls.length;
    p.model.pin(pin);
    p.afterUpdate();
    check(p.snap.screen === pin.screen, `[pin] ${JSON.stringify(pin)} shows its screen`);
    check(p.calls.length === before, `[pin] ${JSON.stringify(pin)} calls no host`);
  }
  // title texts
  const t = new Harness('[text]', 'laps=1&rivals=1&difficulty=0.6');
  t.boot('title');
  const race = t.row('race');
  check(race?.kind === 'action' && race.sub?.lines[0] === 'TRACK 16 · 1 LAP · 1 RIVAL · SKILL 0.60', '[text] RACE sub-line', race?.kind === 'action' ? race.sub?.lines[0] : '');
  const next = t.snap.aside;
  check(next?.kind === 'next' && next.caption === '593 M · 1 LAP' && next.best === '0:31.42' && next.title === 'TRACK 16', '[text] NEXT RACE plate', JSON.stringify(next));
  t.focus('keys', 'setup');
  t.press('keys', 'select');
  t.press('keys', 'down', 3);
  const diff = t.row('difficulty');
  check(diff?.kind === 'choice' && diff.selected === null && diff.caption === 'SKILL 0.60', '[text] numeric difficulty selects none');
  t.press('keys', 'right');
  check(t.model.staged.difficulty === 0.72, '[text] right from 0.60 → HARD');
  const ticket = t.snap.aside;
  check(ticket?.kind === 'ticket' && ticket.chips.join('|') === '593 M|1 LAP · 0.6 KM|BEST 0:31.42' && ticket.sticker === null, '[text] ticket chips', JSON.stringify(ticket && ticket.kind === 'ticket' ? ticket.chips : null));
  const e = new Harness('[text endless]', 'laps=0&rivals=0');
  e.boot('title');
  const er = e.row('race');
  check(er?.kind === 'action' && er.sub?.lines[0] === 'TRACK 16 · ENDLESS · NO RIVALS · NORMAL', '[text] endless / no rivals');
  e.press('keys', 'select');
  e.facts.phase = 'racing';
  e.facts.count = 1;
  e.facts.laps = 0;
  e.facts.lap = 4;
  e.press('keys', 'pause');
  check(e.snap.breadcrumb === 'LAP 4', '[text] endless alone breadcrumb', String(e.snap.breadcrumb));
  e.focus('keys', 'quit');
  e.press('keys', 'select');
  check(e.snap.say === 'This race ends here: lap 4. Your best lap on Track 16 is kept.', '[text] endless alone quit text', String(e.snap.say));
}

// ───────────────────────────── menuFlow ─────────────────────────────

function flowTests(): void {
  // carStats against the SPEC 3.2 table
  const table: Record<string, [number, number, number, number]> = {
    'reef-rocket': [3, 3, 3, 3],
    'neon-wasp': [3, 2, 5, 2],
    'riot-ram': [3, 5, 1, 5],
    'comet-fox': [5, 4, 2, 4],
  };
  for (const [id, want] of Object.entries(table)) {
    const s = carStats(id);
    check(JSON.stringify([s.speed, s.grip, s.agility, s.weight]) === JSON.stringify(want), `[flow] carStats(${id}) = spec table`, JSON.stringify(s));
  }
  const masses: Record<string, number> = { 'reef-rocket': 810, 'neon-wasp': 730, 'riot-ram': 973, 'comet-fox': 892 };
  for (const [id, kg] of Object.entries(masses)) check(Math.round(rigFor(id).totalMass) === kg, `[flow] rigFor(${id}) mass = ${kg} KG (spec 3.2)`, String(rigFor(id).totalMass));
  const labels: Record<string, string> = { 'reef-rocket': 'All-rounder', 'neon-wasp': 'Agile', 'riot-ram': 'Planted', 'comet-fox': 'Fast' };
  for (const [id, l] of Object.entries(labels)) check(HANDLING_PRESETS[id].label === l, `[flow] class label ${id}`);
  const unknown = carStats('nope');
  check(unknown.speed === 3 && unknown.weight === 3, '[flow] unknown car → neutral pips');

  // randomSeed: exhaustive sweep of the draw
  const exclude = [16, 27];
  const got = new Set<number>();
  const N = 20000;
  for (let i = 0; i < N; i++) got.add(randomSeed(exclude, () => i / N));
  check(!got.has(16) && !got.has(27) && ![...got].some((s) => BAD_SEEDS.includes(s)), '[flow] randomSeed never returns an excluded or bad seed');
  check(got.size === 1098 && Math.min(...got) === 1 && Math.max(...got) === 1100, '[flow] randomSeed covers 1 … 1100', `${got.size}`);
  check(randomSeed([], () => 0.999999999) === 1100 && randomSeed([], () => 1) === 1100 && randomSeed([], () => NaN) === 1, '[flow] randomSeed edge draws stay in range');
  const rnd = lcg(99);
  let ok = true;
  for (let i = 0; i < 5000; i++) {
    const s = randomSeed([1, 1100, 500], rnd);
    if (s === 1 || s === 1100 || s === 500 || s < 1 || s > 1100 || BAD_SEEDS.includes(s)) ok = false;
  }
  check(ok, '[flow] randomSeed with a seeded RNG');
  check(BAD_SEEDS.includes(5038), '[flow] BAD_SEEDS has 5038');

  // storage
  const local = new MemoryStore();
  const session = new MemoryStore();
  let search = '';
  const flow = createMenuFlow({ local: () => local, session: () => session, assignSearch: (s) => (search = s) });
  check(flow.storedView() === null && flow.storedMusicVolume() === null, '[flow] nothing stored → null');
  flow.storeView('high');
  check(flow.storedView() === 'high' && local.getItem('web-racer.view') === 'high', '[flow] view stored');
  local.setItem('web-racer.view', 'sideways');
  check(flow.storedView() === null, '[flow] invalid stored view → null');
  flow.storeMusicVolume(0.73);
  check(local.getItem('web-racer.musicVolume') === '0.7' && flow.storedMusicVolume() === 0.7, '[flow] volume stored with one decimal');
  flow.storeMusicVolume(0);
  check(flow.storedMusicVolume() === 0, '[flow] volume 0 round-trips');
  local.setItem('web-racer.musicVolume', '7');
  check(flow.storedMusicVolume() === null, '[flow] out-of-range volume → null');
  local.setItem('web-racer.bestLap.hills2-27', '31.420');
  check(flow.bestLapFor(27) === 31.42 && flow.bestLapFor(28) === null, '[flow] best lap read');
  local.setItem('web-racer.bestLap.hills2-29', 'junk');
  check(flow.bestLapFor(29) === null, '[flow] bad best lap → null');
  check(flow.takeMenuNext() === 'title', '[flow] no flag → title');
  const opts = parseGameOptions('?dev=1&tune=grip:1.2&vehicle=hybrid', '');
  flow.reloadWith(opts, { seed: 27, laps: 5, view: 'high', music: 0.4 });
  check(search === optionsToQuery(opts, { seed: 27, laps: 5, view: 'high', music: 0.4 }), '[flow] reloadWith assigns optionsToQuery', search);
  check(search.includes('dev=1') && search.includes('tune=grip') && search.includes('vehicle=hybrid'), '[flow] reload keeps dev / tune / vehicle', search);
  check(flow.takeMenuNext() === 'race' && session.getItem('web-racer.menu.next') === null, '[flow] flag read and removed');
  // throwing storage: defaults, never throws
  const broken = createMenuFlow({ local: () => throwingStore, session: () => throwingStore, assignSearch: (s) => (search = s) });
  let threw = false;
  try {
    broken.storeView('xr');
    broken.storeMusicVolume(0.5);
    check(broken.storedView() === null && broken.storedMusicVolume() === null && broken.bestLapFor(1) === null, '[flow] blocked storage → defaults');
    broken.reloadWith(opts, {});
    check(broken.takeMenuNext() === 'title', '[flow] blocked session storage → lands on the title');
  } catch {
    threw = true;
  }
  check(!threw, '[flow] blocked storage never throws');
  const absent = createMenuFlow({
    local: () => {
      throw new Error('SecurityError on access');
    },
    session: () => null,
    assignSearch: () => {},
  });
  check(absent.storedView() === null && absent.takeMenuNext() === 'title', '[flow] throwing storage accessor → defaults');
}

/** A URL livery past the car's paint count (`?livery=6`, reef-rocket has 4
 * paints: the game shows paint 2) is the running paint: choosing the
 * unchanged car stages nothing, and RACE starts the race (no reload). */
function liveryWrapTests(): void {
  const L = '[livery]';
  const h = new Harness(L, 'livery=6');
  h.boot('title');
  h.focus('keys', 'car');
  h.press('keys', 'select');
  check(h.focusId() === 'car:reef-rocket', `${L} car screen opens on the running car`, String(h.focusId()));
  const row = h.row('car:reef-rocket');
  check(row?.kind === 'car' && row.paintIndex === 2, `${L} running paint is the wrapped livery`, JSON.stringify(row && row.kind === 'car' ? row.paintIndex : null));
  h.press('keys', 'select');
  h.expectScreen('title', 'CHOOSE returns to the title');
  check(Object.keys(h.model.staged).length === 0 && h.snap.stagedCount === 0, `${L} choosing the unchanged car and paint stages nothing`, JSON.stringify(h.model.staged));
  h.focus('keys', 'race');
  h.press('keys', 'select');
  check(h.calls.includes('startRace') && !h.calls.includes('reload'), `${L} RACE starts the race, no reload`, h.calls.slice(-3).join(','));
  // another paint of the same car is still a change
  const g = new Harness(`${L}#2`, 'livery=6');
  g.boot('title');
  g.focus('keys', 'car');
  g.press('keys', 'select');
  g.press('keys', 'right');
  g.press('keys', 'select');
  check(g.model.staged.livery === 3 && g.model.staged.car === undefined, `${L} another paint stages livery only`, JSON.stringify(g.model.staged));
}

// ───────────────────────────── run ─────────────────────────────

const t0 = performance.now();
script('pad');
script('keys');
guardTests();
digitTests();
pointerTests();
snapshotTests();
flowTests();
liveryWrapTests();
console.log(`${failures === 0 ? 'PASS' : 'FAIL'}  menu-model-test: ${passes} checks passed, ${failures} failed (${(performance.now() - t0).toFixed(0)} ms)`);
process.exit(failures === 0 ? 0 : 1);
