import type { RacePhase } from '../RaceState';
import type { GameOptions } from '../options';
import type { ViewMode } from './camera';

/**
 * CONTRACT — the game menu (title, car, race setup, settings, controls,
 * pause, confirm, post-race). The binding spec is
 * design-documents/menu-mockups/SPEC.md; the picture is final.html beside it.
 * Implemented in:
 *   src/ui/menu/MenuModel.ts   `createMenuModel` — Babylon-free, DOM-free state
 *                              machine (importable from Node): screen stack,
 *                              focus, running / staged, `update`, `snapshot`
 *   src/ui/menu/MenuView.ts    `createMenuView` — DOM renderer of a
 *                              `MenuSnapshot` (+ menuCss.ts, glyphs.ts);
 *                              pointer events go back as `MenuPointerAction`s
 *   src/input/MenuInput.ts     `createMenuInput` — keyboard + pads + pushed
 *                              pointer actions → one `MenuCommand` per frame
 *   src/game/menuFlow.ts       `MenuFlowModule` — reload, storage, seeds, pips
 *   src/scene/createScene.ts   implements `MenuHost`, builds `MenuFacts`,
 *                              exposes `GameMenu` as `game.menu`
 *
 * MODEL (spec 2). Every screen is ONE ordered vertical list of rows with
 * exactly one focused row (never a disabled one). Kinds: 'action' (select
 * does something), 'link' (opens a screen), 'choice' (segmented), 'stepper',
 * 'slider' (pips), 'car' (car screen). Focus wraps vertically; values never
 * wrap (except TRACK's stepper and `select` on a choice). A screen keeps its
 * focus while on the stack; title opens on RACE, pause on RESUME, post on
 * RACE AGAIN, confirm on KEEP RACING.
 *   LIVE values apply at once through the host: camera view, music volume.
 *   WORLD values (car + livery, seed, laps, rivals, difficulty, quality) are
 *   STAGED: `running` = this page's parsed GameOptions, `staged` holds ONLY
 *   keys that differ from `running` (set back → key deleted). Staged values
 *   survive Back, show in yellow, and apply only through a "go racing" row
 *   (RACE, START RACE, NEXT TRACK) = exactly one reload. Square (Delete /
 *   Backspace) undoes the focused row's staged value; on the title root, all.
 *   Change count: car + livery = one ("CAR"), then TRACK, LAPS, RIVALS,
 *   DIFFICULTY, QUALITY.
 *
 * SCREENS (spec 3): title (RACE, CAR, RACE SETUP, SETTINGS, CONTROLS; aside
 * NEXT RACE plate; sound chip while audio is locked) · car (four rows in
 * CAR_DESIGNS order; up / down browse, left / right paint, Cross = CHOOSE
 * stages car + livery and pops to the title, Circle = back unchanged; the
 * camera follows the highlighted design via `previewCar`) · setup (TRACK
 * stepper 1 … 9999 wrapping, Triangle = random 1 … 1100 never running /
 * current / BAD_SEEDS, digits typed commit after 1.2 s, on Enter or on
 * leaving the row; LAPS ENDLESS(0), 1 … 99 no wrap; RIVALS 0–3; DIFFICULTY
 * EASY / NORMAL / HARD; START RACE) · settings (CAMERA live, MUSIC live,
 * QUALITY staged — not focusable when opened from pause) · controls
 * (read-only) · pause (RESUME, RESTART RACE, CAMERA, MUSIC, SETTINGS,
 * CONTROLS, QUIT TO TITLE) · confirm (only while `phase === 'racing'`, for
 * RESTART / QUIT; KEEP RACING first) · post (no band; appears 2.5 s after the
 * player's finish; RACE AGAIN, NEXT TRACK, CHANGE CAR, TITLE).
 *
 * INPUT (spec 4). One focus model for all devices; DOM focus follows the
 * model. `MenuInput.poll` runs EVERY frame (also during the race). Repeat
 * 350 ms then 110 ms ('fast' rows: 40 ms after 1.5 s held); stick fires at
 * |axis| ≥ 0.55, re-arms < 0.3; a pad's first poll only primes it; the
 * release guard (`MenuEffect` 'guard') swallows everything held until it is
 * released once. Handling by state: race → `pause` / `escape` opens pause
 * (countdown / racing only), all else ignored · paused → `pause` resumes from
 * any depth, `back` one level up (root: resume) · title side → `back` one
 * level up, nothing on the root, `pause` ignored · post → `back` = TITLE,
 * `pause` ignored · value rows: left / right change, `select` steps a choice
 * (wraps), does nothing on stepper / slider; `right` does nothing on action /
 * link rows. While any menu is open driving is gated to zero and
 * `GameActions` reset / camera / restart are discarded (the host does this).
 *
 * STATES (spec 5): `MenuState` 'title' | 'race' | 'paused' | 'post'.
 *   BOOT → `boot('race' | 'title')` once the loading panel is gone.
 *   TITLE: world live, race HELD, HUD hidden. RACE (nothing staged) →
 *   `host.startRace()`; staged → `host.reload(staged)`.
 *   race → PAUSED by `pause` / `escape` / `autoPause`; RESUME →
 *   `host.resume()`; RESTART RACE → (confirm) `host.restartRace()`;
 *   QUIT TO TITLE → (confirm) `host.enterTitle(false)`.
 *   race (phase finished, `finishedFor ≥ 2.5`) → POST via `host.enterPost()`:
 *   RACE AGAIN → `host.restartRace()`, NEXT TRACK → `host.reload({ ...staged,
 *   seed: running.seed % 9999 + 1 })`, CHANGE CAR → `host.enterTitle(true)`,
 *   TITLE → `host.enterTitle(false)`.
 *   The model changes its OWN state first, then calls the host; the host only
 *   does the game side. The model never calls the host from `snapshot()`.
 *
 * RELOAD (spec 6): world values apply only by reloading; the host's
 * `reload(overrides)` adds the current `view` and `music`, sets the one-shot
 * `sessionStorage['web-racer.menu.next'] = 'race'` and assigns
 * `optionsToQuery(options, …)` to `location.search`. The flag is read AND
 * removed by `game.menu.boot()`; without it the page lands on the title.
 *
 * TEXT: every string in a `MenuSnapshot` is FINAL display text (upper-cased
 * where the spec writes CAPS, numbers formatted); the view renders it as is.
 * Colours are CSS hex strings `#rrggbb`.
 *
 * Types only.
 */

// ───────────────────────────── input ─────────────────────────────

/** Last device used: chooses the prompt glyphs (pad → DualShock glyphs,
 * keyboard / pointer → keycaps) and the cursor hiding. */
export type MenuDevice = 'keyboard' | 'gamepad' | 'pointer';

export type MenuDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** The menu's buttons; also what a clicked prompt sends. */
export type MenuButton = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'pause' | 'undo' | 'random';

/**
 * One frame of menu input (`MenuInputSource.poll`). Every boolean is
 * EDGE-triggered (true for one poll), `up` / `down` / `left` / `right` also
 * fire on repeat. Bindings (spec 4):
 *   up / down       ArrowUp, KeyW / ArrowDown, KeyS · pad 12 / 13, axis 1
 *   left / right    ArrowLeft, KeyA / ArrowRight, KeyD · pad 14 / 15, axis 0
 *   select          Enter, NumpadEnter, Space · pad 0 (Cross)
 *   back            Escape · pad 1 (Circle)
 *   escape          Escape only (set together with `back`)
 *   pause           KeyP · pad 9 (Options)
 *   undo            Delete, Backspace · pad 2 (Square)
 *   random          KeyR · pad 3 (Triangle)
 *   digit           Digit0–9, Numpad0–9
 * Keys with Ctrl / Cmd / Alt and keys typed in a form control are ignored.
 * Pointer actions pushed by the view since the last poll arrive in `pointer`
 * (in order) and set `device` to 'pointer' (a 'focus' with `via: 'tab'`
 * sets 'keyboard').
 */
export interface MenuCommand {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  select: boolean;
  back: boolean;
  escape: boolean;
  pause: boolean;
  undo: boolean;
  random: boolean;
  /** A digit key went down this poll (no repeat), else null. */
  digit: MenuDigit | null;
  /** Sticky: the device of the most recent input ('keyboard' until anything
   * else is used). */
  device: MenuDevice;
  /** Edge: since the last poll the page was hidden, the window lost focus,
   * or the last-used pad disconnected. The model pauses on it like on
   * `pause` (in state 'race', phase countdown / racing only). */
  autoPause: boolean;
  /** Pointer / DOM-focus actions from the view since the last poll, oldest
   * first; empty most frames. */
  pointer: readonly MenuPointerAction[];
}

/**
 * What the view reports from pointer and DOM-focus events (spec 4,
 * "Pointer"). The view never changes state itself: it pushes these into
 * `MenuInputSource.push` (through `MenuViewOptions.onPointer`).
 */
export type MenuPointerAction =
  /** A `pointermove` that really moved (> 2 px) over a row (`via:
   * 'pointer'`), or a row received DOM focus by Tab / Shift+Tab (`via:
   * 'tab'`): the model focuses that row (ignored when disabled). */
  | { kind: 'focus'; row: MenuRowId; via: 'pointer' | 'tab' }
  /** Click on a row (outside its widget's parts): focus it, then `select`. */
  | { kind: 'activate'; row: MenuRowId }
  /** Click on a part that names a value: focus the row, then set it.
   * `value` = option index (choice), pip count 1 … 10 (slider; a click on
   * pip i, 0-based, sends i + 1), paint index (car row, or a paint chip on
   * the car sheet, which sends the FOCUSED car row's id). */
  | { kind: 'set'; row: MenuRowId; value: number }
  /** Click on the left / right third of a stepper, or the paint arrows of
   * the car sheet: focus the row, then step like left / right. */
  | { kind: 'step'; row: MenuRowId; delta: -1 | 1 }
  /** A clicked prompt in the prompt bar: acts like that button's edge. */
  | { kind: 'button'; button: MenuButton };

/** Key repeat profile for the focused row: 'fast' (TRACK, LAPS) switches
 * from 110 ms to 40 ms after 1.5 s held. */
export type MenuRepeat = 'normal' | 'fast';

/** `createMenuInput` (src/input/MenuInput.ts). */
export interface MenuInputSource {
  /** Call EXACTLY once per frame, also during the race (pad edges never go
   * stale). `now` = `performance.now()`, ms. The returned object is reused
   * (and its `pointer` array is a fresh, possibly empty array per poll). */
  poll(now: number): Readonly<MenuCommand>;
  /** Start the release guard: every key / button down right now is ignored
   * until it has been released once. */
  guard(): void;
  /** Repeat profile for `left` / `right` (from `MenuSnapshot.repeat`). */
  setRepeat(profile: MenuRepeat): void;
  /** true while any menu is open (state !== 'race'): handled keys get
   * `preventDefault()` (arrows and Space would scroll). Default false. */
  setCapturing(on: boolean): void;
  /** Queue a view action for the next poll. */
  push(action: MenuPointerAction): void;
  dispose(): void;
}

export interface MenuInputOptions {
  /** Where key / blur / visibility listeners go. Default `window`. */
  target?: Window;
  /** Pad source. Default `connectedPads()` (src/input/pads.ts). */
  pads?: () => readonly Gamepad[];
}

export type CreateMenuInput = (options?: MenuInputOptions) => MenuInputSource;

// ───────────────────────────── game → model ─────────────────────────────

/**
 * Plain data from the game, built by the host side every frame and passed
 * to `MenuModel.update`. Values during the title hold are those of the held
 * race (phase 'countdown', lap 1 …).
 */
export interface MenuFacts {
  /** Monotonic clock, SECONDS (performance.now() / 1000): digit-entry commit
   * (1.2 s) and any model timing. */
  time: number;
  /** `race.phase` (the RaceState's, not the snapshot's). */
  phase: RacePhase;
  /** Player's current lap, 1-based. */
  lap: number;
  /** Laps of the race; 0 = endless (the HUD snapshot's Infinity → 0). */
  laps: number;
  /** Player's position, 1 = leading. */
  place: number;
  /** Cars in the race (1 = racing alone: no place shown). */
  count: number;
  /** Seconds since the player's `snapshot.finish` first became non-null;
   * null while not finished (also right after a restart). */
  finishedFor: number | null;
  /** The player's finishing position, null while not finished. */
  finishPlace: number | null;
  /** The player's best lap on the RUNNING track (storage ∪ this session,
   * `snapshot.bestLap`), s. */
  bestLap: number | null;
  /** The camera view the rig is in now (C during the race changes it). */
  view: ViewMode;
  /** Music volume 0 … 1 as the audio has it now. */
  musicVolume: number;
  /** AudioContext running (false: the title shows the sound chip). */
  audioUnlocked: boolean;
  /** At least one standard-mapped pad is connected. */
  padConnected: boolean;
  /** Viewport aspect below 5:4 (the narrow layouts of spec 3.9): post-race
   * left / right move like up / down; the car screen's help line shows the
   * paint name while left / right is used. */
  narrow: boolean;
}

// ───────────────────────────── model → game ─────────────────────────────

/**
 * The game side of every menu decision, implemented in createScene.ts. The
 * model has ALREADY changed its own state when it calls one of these.
 */
export interface MenuHost {
  /** RACE / START RACE with nothing staged, and `boot('race')`: close the
   * menu, `setView(view)` back on the player with lateral offset 0,
   * `session.setHeld(false)`, `session.menuLocked = false`,
   * `session.restart()`, show the HUD, music mood from the race. */
  startRace(): void;
  /** Entering PAUSED: `session.menuLocked = true`, hide the HUD,
   * `canvas.style.filter = 'saturate(.72)'` on the `high` preset only,
   * `sound.setPaused(true)`; the frame loop stops simulating (spec 7). */
  pause(): void;
  /** RESUME (button, `pause` from any depth, `back` on the pause root): the
   * reverse of `pause()`. While racing the race continues at once; during
   * the 3-2-1 (`race.phase === 'countdown'`) `session.restart()` (a fresh
   * countdown). */
  resume(): void;
  /** RESTART RACE (from pause, after confirm while racing) and RACE AGAIN
   * (post): `session.restart()`, close whatever is open (undo `pause()` /
   * `enterPost()`), HUD shown, back on the player, offset 0. */
  restartRace(): void;
  /** QUIT TO TITLE, TITLE, CHANGE CAR (openCar true: the model has the CAR
   * screen on top of the title) and `boot('title')`: `session.restart()` +
   * `session.setHeld(true)` + `session.menuLocked = true` + hide HUD + undo
   * any pause styling + title camera (lateral offset 2.2 m chase / 4 m high,
   * on the player) + music mood idle. No reload: same world. */
  enterTitle(openCar: boolean): void;
  /** The post-race stack appears: `session.menuLocked = true` (driving and
   * R / C / restart gated). The HUD stays exactly as it is. */
  enterPost(): void;
  /** Live CAMERA row: `rig.setMode(mode)` + what C does today, store the
   * view (`web-racer.view`), keep the current lateral offset of the state,
   * and while paused ask for one redraw of the frozen frame. */
  setView(mode: ViewMode): void;
  /** Live MUSIC row: `audio.setMusicVolume(v)` (0 … 1 in tenths) and store
   * it (`web-racer.musicVolume`). */
  setMusicVolume(v: number): void;
  /** Car screen: follow the grid car of design `carId` if one is on the grid
   * (`rig.setSubject(car.vehicle); rig.snap()`), else stay on the player.
   * null = back to the player (on leaving the car screen). */
  previewCar(carId: string | null): void;
  /** A "go racing" row with staged values, or NEXT TRACK. `overrides` =
   * everything staged plus the row's own extras (NEXT TRACK: `seed`). The
   * host adds `view` + `music`, sets the one-shot flag, assigns
   * `location.search` (menuFlow `reloadWith`). Nothing after it matters. */
  reload(overrides: Partial<GameOptions>): void;
}

/** Things an `update` asks for that are not game actions; read from
 * `MenuModel.effects` after each update. */
export type MenuEffect =
  /** Call `MenuInputSource.guard()`: a menu opened or closed, or the post
   * stack appeared. */
  | { kind: 'guard' }
  /** Optional UI sound (spec 7, last step): focus moved, a row was selected
   * / a value changed, a screen was left. The host may ignore it. */
  | { kind: 'blip'; sound: MenuBlip };

export type MenuBlip = 'focus' | 'select' | 'back';

export type MenuState = 'title' | 'race' | 'paused' | 'post';

// ───────────────────────────── data into the model ─────────────────────────────

/** One paint (livery) of a car design, from `CarAsset.paints`. */
export interface MenuPaint {
  /** Source name, e.g. 'Reef', 'Vermilion' (the snapshot upper-cases it). */
  name: string;
  /** Body colour, CSS '#rrggbb' (58 % of the two-tone chip). */
  body: string;
  /** Cage / accent colour, CSS '#rrggbb' (42 %). */
  accent: string;
}

/** Stat pips 1 … 5 (menuFlow `carStats`, formulas in spec 3.2). */
export interface MenuCarStats {
  speed: number;
  grip: number;
  agility: number;
  weight: number;
}

/**
 * One car design for the car screen, built by the host side in
 * `CAR_DESIGNS` order from: the car asset (`name`, `paints`; `paints.length`
 * = `liveries`), `HANDLING_PRESETS[id]` (`label`, `description`),
 * `rigFor(id).mass` and `carStats(id)`. Strings are source text; the model
 * upper-cases names and labels for display.
 */
export interface MenuCarInfo {
  id: string;
  /** 'Reef Rocket'. */
  name: string;
  /** `HANDLING_PRESETS[id].label`, 'All-rounder'. */
  classLabel: string;
  /** `HANDLING_PRESETS[id].description` (shown as written). */
  description: string;
  /** All-in mass, kg, rounded. */
  massKg: number;
  stats: MenuCarStats;
  /** At least one entry. */
  paints: readonly MenuPaint[];
}

/** A track as the menu draws it (title plate, setup ticket). */
export interface MenuTrackInfo {
  seed: number;
  /** Loop length, m. */
  lengthM: number;
  /** SVG path data in a `viewBox="-72 -72 144 144"`: the track polyline,
   * every 4th point, x → right, −z → down (svg y = −z), the start line at the
   * origin heading up, closed with 'Z'. */
  outline: string;
}

/** Track previews by seed. The running seed is always known; a staged seed
 * is computed in the background (spec 8, "Track preview"). */
export interface MenuTrackSource {
  /** Cheap (a map lookup); called on every update while a seed is shown.
   * Returns null until known; for an unknown seed it may start the
   * computation (debounced 300 ms after the last request of a new seed). The
   * model rebuilds its snapshot when the returned object changes. */
  get(seed: number): MenuTrackInfo | null;
}

/** For labs and tests: put the model straight into the state that shows
 * `screen`, WITHOUT host calls. Title-side screens get the title under them;
 * 'settings' / 'controls' with `from: 'paused'` get the pause under them;
 * 'confirm' asks about `confirm` (default 'quit'); 'post' shows the stack
 * at once. */
export interface MenuPin {
  screen: MenuScreenId;
  from?: 'title' | 'paused';
  confirm?: 'quit' | 'restart';
}

export interface MenuModelInit {
  /** This page's parsed options. */
  running: Readonly<GameOptions>;
  host: MenuHost;
  /** `CAR_DESIGNS` order. */
  cars: readonly MenuCarInfo[];
  tracks: MenuTrackSource;
  /** Stored best lap of any seed, s (menuFlow `bestLapFor`); the running
   * seed's comes from `MenuFacts.bestLap` instead. */
  bestLap: (seed: number) => number | null;
  /** Uniform [0, 1) for RANDOM TRACK (Math.random in the game; seeded in
   * tests). */
  random: () => number;
  /** Starting live values (URL > stored > default, decided by the host). */
  view: ViewMode;
  musicVolume: number;
  /** Labs only: start with these staged (keys equal to `running` are
   * dropped). Default {}. */
  staged?: Partial<GameOptions>;
}

/** `createMenuModel` (src/ui/menu/MenuModel.ts). */
export interface MenuModel {
  readonly state: MenuState;
  readonly running: Readonly<GameOptions>;
  /** Only keys that differ from `running`. */
  readonly staged: Readonly<Partial<GameOptions>>;
  /** Effects of the LAST `update` / `boot` call (cleared at the start of
   * each). */
  readonly effects: readonly MenuEffect[];
  /** Once, when the loading panel is gone. 'race' → `host.startRace()`,
   * state 'race'; 'title' → `host.enterTitle(false)`, title root focused on
   * RACE. */
  boot(next: 'race' | 'title'): void;
  /** Call once per frame with this frame's command and facts, BEFORE the
   * simulation. Returns the state after it. */
  update(command: Readonly<MenuCommand>, facts: Readonly<MenuFacts>): MenuState;
  /** The current picture. The SAME object until something visible changes,
   * then a new one with a higher `version` (compare by identity). Pure: no
   * host calls. */
  snapshot(): MenuSnapshot;
  /** Labs and tests (see `MenuPin`). */
  pin(pin: MenuPin): void;
}

export type CreateMenuModel = (init: MenuModelInit) => MenuModel;

// ───────────────────────────── snapshot (model → view) ─────────────────────────────

export type MenuScreenId = 'title' | 'car' | 'setup' | 'settings' | 'controls' | 'pause' | 'confirm' | 'post';

/** Row ids, unique within a screen. `car:<design id>` on the car screen. */
export type MenuRowId =
  // title
  | 'race' | 'car' | 'setup' | 'settings' | 'controls'
  // car
  | `car:${string}`
  // setup
  | 'track' | 'laps' | 'rivals' | 'difficulty' | 'start'
  // settings (and pause: 'camera', 'music', 'settings', 'controls')
  | 'camera' | 'music' | 'quality'
  // pause
  | 'resume' | 'restart' | 'quit'
  // confirm
  | 'keep' | 'confirm'
  // post
  | 'again' | 'next' | 'changeCar' | 'title';

/** Glyph ids for prompts and the controls sheet (glyphs.ts draws them; spec
 * 1 "Prompt bar"). Pad glyphs are DualShock inline SVGs; key glyphs are
 * pale keycaps: 'key-ud' = ↑ ↓, 'key-lr' = ← →, 'key-enter' = ENTER,
 * 'key-esc' = ESC, 'key-del' = DEL, 'key-r' = R. */
export type MenuPadGlyph = 'cross' | 'circle' | 'triangle' | 'square' | 'dpad-ud' | 'dpad-lr' | 'options' | 'l2' | 'r2' | 'stick';
export type MenuKeyGlyph = 'key-ud' | 'key-lr' | 'key-enter' | 'key-esc' | 'key-del' | 'key-r';
export type MenuGlyphId = MenuPadGlyph | MenuKeyGlyph;

/** One prompt of the bar (at most 4). The model resolves the glyph for the
 * current device: pad → pad glyph, keyboard / pointer → key glyph (pause
 * RESUME on the keyboard = 'key-esc'). */
export interface MenuPrompt {
  glyph: MenuGlyphId;
  /** 'MOVE', 'SELECT', 'BACK' … */
  label: string;
  /** Button text for assistive tech: 'Move', 'Select', 'Back' … */
  ariaLabel: string;
  /** What a click sends (MOVE → 'down', CHANGE / PAINT → 'right'). */
  button: MenuButton;
}

/** Small label on a row. 'was' (`WAS 16`) and 'new' (`2 NEW`) and 'chosen'
 * (`CHOSEN`): yellow fill, ink text; 'live' (`ON THE GRID`): cyan outline.
 * On setup / settings / title rows the tags sit after the label; on car rows
 * at the row's top-right edge. */
export interface MenuTag {
  kind: 'was' | 'new' | 'chosen' | 'live';
  text: string;
}

/** A value or caption on a row. */
export interface MenuValue {
  /** One entry per line (START RACE: '2 CHANGES', 'LOADS A NEW WORLD'). */
  lines: readonly string[];
  /** Staged: drawn yellow instead of cyan. */
  staged: boolean;
  /** Two-tone paint dot before the text (title CAR, post CHANGE CAR). */
  swatch: MenuPaint | null;
}

/** Bold-able text run (tips, notes). */
export interface MenuTextRun {
  text: string;
  strong: boolean;
}
export type MenuRichText = readonly MenuTextRun[];

export interface MenuRowBase {
  id: MenuRowId;
  label: string;
  focused: boolean;
  /** Not focusable, drawn dim (`.row.dim`, `aria-disabled`). */
  disabled: boolean;
  /** 'primary' = title RACE / post RACE AGAIN (big row, label 6.2u / 4.3em);
   * 'go' = START RACE (yellow rim + label, 8u, 2.2u gap above); 'danger' =
   * pink label (QUIT TO TITLE, confirm's destructive row). */
  tone: 'normal' | 'primary' | 'go' | 'danger';
  tags: readonly MenuTag[];
}

/** Select does something. `chevron`: the double chevron on the right
 * (title RACE big, pause RESUME and KEEP RACING small — size by `tone`). */
export interface MenuActionRow extends MenuRowBase {
  kind: 'action';
  chevron: boolean;
  /** Right-aligned value (START RACE's change count). */
  value: MenuValue | null;
  /** Line under the label (title RACE, the post rows). */
  sub: MenuValue | null;
}

/** Opens a screen. */
export interface MenuLinkRow extends MenuRowBase {
  kind: 'link';
  value: MenuValue | null;
}

/** Segmented value. */
export interface MenuChoiceRow extends MenuRowBase {
  kind: 'choice';
  /** 'segments' (setup / settings) or 'arrows' = `◂ CHASE ▸` (pause CAMERA:
   * only the selected label between arrows). */
  display: 'segments' | 'arrows';
  options: readonly { value: string; label: string }[];
  /** Index into `options`; null = none matches (a numeric difficulty that
   * is no preset). */
  selected: number | null;
  /** Caption after the label when `selected` is null: 'SKILL 0.60'. */
  caption: string | null;
  staged: boolean;
}

/** Number stepper ◂ n ▸ (TRACK, LAPS). */
export interface MenuStepperRow extends MenuRowBase {
  kind: 'stepper';
  /** Current value: the seed, or the laps (0 = ENDLESS). */
  value: number;
  /** Shown: '27', '5', 'ENDLESS' (or the digits being typed). */
  text: string;
  /** Digits typed and not yet committed, else null (`text` shows them). */
  entry: string | null;
  /** Arrow states: false draws that arrow dimmed (LAPS at ENDLESS / 99;
   * TRACK wraps, both true). */
  canDecrease: boolean;
  canIncrease: boolean;
  /** aria-valuemin / max and aria-valuetext ('Track 27', '5 laps', 'Endless'). */
  min: number;
  max: number;
  ariaValueText: string;
  repeat: MenuRepeat;
  staged: boolean;
}

/** Ten skewed pips (MUSIC). */
export interface MenuSliderRow extends MenuRowBase {
  kind: 'slider';
  /** Pips lit, 0 … 10 (volume in tenths). */
  value: number;
  /** Number after the pips: '7', 'OFF' at 0; null = no number (pause). */
  text: string | null;
  /** '70 percent'. */
  ariaValueText: string;
}

/** A car on the car screen. Up / down browse, left / right paint. */
export interface MenuCarRow extends MenuRowBase {
  kind: 'car';
  carId: string;
  /** 'REEF ROCKET'. */
  name: string;
  /** 'ALL-ROUNDER · 810 KG'. */
  caption: string;
  /** The paint being browsed for this car (its staged / running livery
   * until left / right is used). */
  paint: MenuPaint;
  paintIndex: number;
  paintCount: number;
}

export type MenuRow = MenuActionRow | MenuLinkRow | MenuChoiceRow | MenuStepperRow | MenuSliderRow | MenuCarRow;

/** Title, bottom right: NEXT RACE plate. */
export interface MenuNextRaceAside {
  kind: 'next';
  /** 'TRACK 16'. */
  title: string;
  /** Title drawn yellow (a staged seed). */
  staged: boolean;
  /** '593 M · 3 LAPS', 'ENDLESS' laps as '593 M · ENDLESS'; staged seed:
   * 'NEW · 5 LAPS'. */
  caption: string;
  /** 'BEST LAP'. */
  bestLabel: string;
  /** '0:31.42' (`formatLapTime`) or '– : – –'. */
  best: string;
  /** null = not known yet: draw a dashed ring. */
  track: MenuTrackInfo | null;
}

/** Car screen, right side: name sticker + spec sheet. */
export interface MenuCarAside {
  kind: 'car';
  /** Focused design: 'COMET FOX'. */
  name: string;
  /** Class badge: 'FAST'. */
  badge: string;
  description: string;
  /** SPEED, GRIP, AGILITY, WEIGHT, each 1 … 5 of 5 pips. */
  stats: readonly { label: string; value: number; max: number }[];
  /** 'PAINT'. */
  paintLabel: string;
  /** '1 / 4'. */
  paintPosition: string;
  paints: readonly MenuPaint[];
  /** Index into `paints` (cyan double ring). */
  paintIndex: number;
  /** 'VERMILION'. */
  paintName: string;
  /** '**CHOOSE** puts it on the grid for your next race. The paint shows
   * once the new grid is built.' */
  note: MenuRichText;
}

/** Setup, right side: track ticket. */
export interface MenuTicketAside {
  kind: 'ticket';
  /** 'TRACK PREVIEW'. */
  kicker: string;
  /** 'TRACK 27'. */
  title: string;
  /** null = not known yet: dashed ring, and no length chip. */
  track: MenuTrackInfo | null;
  /** In order: '544 M' (when known), '5 LAPS · 2.7 KM' (not for ENDLESS or
   * an unknown length), 'BEST 0:31.42' or 'NO BEST LAP YET'. */
  chips: readonly string[];
  /** Seed differs from the running one: 'NEW TRACK' / 'BUILT WHEN YOU START'. */
  sticker: { text: string; sub: string } | null;
}

/** One cell part of the controls sheet. */
export type MenuControlPart =
  | { kind: 'glyph'; glyph: MenuPadGlyph }
  | { kind: 'key'; text: string }
  /** Small caption: 'LEFT STICK', 'OR', 'IN THE MENU'. */
  | { kind: 'text'; text: string };

/** Controls, right side (below 5:4: in the band as two-line rows). */
export interface MenuControlsAside {
  kind: 'controls';
  /** 'ACTION', 'GAMEPAD', 'KEYBOARD'. */
  header: readonly [string, string, string];
  rows: readonly { action: string; gamepad: readonly MenuControlPart[]; keyboard: readonly MenuControlPart[] }[];
}

/** Post-race medal (hidden below 5:4 by the view). */
export interface MenuMedalAside {
  kind: 'medal';
  place: number;
  /** Superscript: 'ST', 'ND', 'RD', 'TH'. */
  ordinal: string;
  /** 'PLACE'. */
  caption: string;
  /** First place or racing alone: gold disc, ink digits. */
  gold: boolean;
}

export type MenuAside = MenuNextRaceAside | MenuCarAside | MenuTicketAside | MenuControlsAside | MenuMedalAside;

/**
 * Everything the view draws, as plain data. Immutable: a new object for
 * every visible change (`version` rises); rebuild the screen's DOM when
 * `serial` changes, patch otherwise.
 */
export interface MenuSnapshot {
  /** Rises with every new snapshot object. */
  version: number;
  /** Rises every time a screen is entered (also re-entering the same id). */
  serial: number;
  state: MenuState;
  /** null = nothing drawn: state 'race' (also while the player has
   * finished but the post stack has not appeared yet). Every other state has
   * a screen ('post' = the action stack). */
  screen: MenuScreenId | null;
  /** Rows of the screen, top to bottom; empty for 'controls' and null
   * screens. */
  rows: readonly MenuRow[];
  /** Index into `rows` of the focused row; -1 when `rows` is empty. */
  focus: number;
  /** 'TITLE / CAR', 'PAUSED / SETTINGS', 'LAP 2 / 3 · 2ND OF 4',
   * 'STARTING GRID'; null on the title root and post. */
  breadcrumb: string | null;
  /** Headline lines: ['PICK YOUR', 'BUGGY'], ['PAUSED'], ['QUIT?']; empty on
   * the title (logo) and post. */
  headline: readonly string[];
  /** Root `aria-label`: the headline as one line; 'WEB RACER' on the title,
   * 'RACE FINISHED' on post. */
  ariaLabel: string;
  /** Confirm text ('This race ends here: lap 2 of 3, running 2nd. …'), else
   * null. */
  say: string | null;
  /** Controls tips (cyan bullets), else empty. */
  tips: readonly MenuRichText[];
  /** Help line for the focused row ('' = none). On the narrow car screen,
   * the paint name while left / right is in use. */
  help: string;
  /** At most 4, in bar order. */
  prompts: readonly MenuPrompt[];
  /** Right-hand plate(s) of the screen, null when it has none. */
  aside: MenuAside | null;
  /** 'CLICK OR PRESS A KEY FOR SOUND' on the title root while audio is
   * locked, else null. */
  soundChip: string | null;
  /** Over the canvas: 'none' (title side), 'pause' (pause / confirm, and
   * settings / controls opened from pause: rgba(11,20,28,.38)), 'post'
   * (rgba(11,20,28,.16)). */
  backdrop: 'none' | 'pause' | 'post';
  /** Repeat profile of the focused row (`MenuInputSource.setRepeat`). */
  repeat: MenuRepeat;
  /** Last-used device (prompts are already resolved for it; the view hides
   * the cursor after 2 s of non-pointer use). */
  device: MenuDevice;
  /** Number of staged changes (car + livery = 1). */
  stagedCount: number;
}

// ───────────────────────────── view ─────────────────────────────

export interface MenuInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MenuViewOptions {
  /** Element the overlay is appended to. Default `document.body` (then
   * `position: fixed; inset: 0`; inside another parent `position:
   * absolute`, the parent must be positioned). Root `.rmenu`, z-index 6. */
  parent?: HTMLElement;
  /** Slide / fade / pop motion. Default true; always off under
   * `prefers-reduced-motion: reduce`; labs pass false with `shot=1`. */
  animate?: boolean;
  /** Extra margins in CSS px (dev overlays). */
  insets?: Partial<MenuInsets>;
  /** Receives every pointer / DOM-focus action (the game pushes it into
   * `MenuInputSource.push`; labs may feed a model directly). */
  onPointer: (action: MenuPointerAction) => void;
  /** The HUD's own size multiplier (`HudOptions.scale`: XR_HUD_SCALE in the
   * xr view): the post-race medal and stack use the HUD unit × this so they
   * line up with the finish panel. Default 1. */
  hudScale?: number;
}

/** `createMenuView` (src/ui/menu/MenuView.ts). */
export interface MenuView {
  readonly root: HTMLElement;
  /** Draw `snapshot`. Cheap when it is the object drawn last time. */
  render(snapshot: MenuSnapshot): void;
  /** The HUD was re-created (view or dev-panel change): follow its scale
   * and insets. */
  setHudScale(scale: number): void;
  setInsets(insets: Partial<MenuInsets>): void;
  dispose(): void;
}

export type CreateMenuView = (options: MenuViewOptions) => MenuView;

// ───────────────────────────── game surface ─────────────────────────────

/** `game.menu` (createScene's `Game`), null when the menu is off
 * (`menuEnabled(options)` false). */
export interface GameMenu {
  /** Called by main.ts once the loading panel is gone: reads AND removes the
   * one-shot flag (menuFlow `takeMenuNext`), then `model.boot(…)`. */
  boot(): void;
  readonly state: MenuState;
  readonly model: MenuModel;
}

/** Car stat pips for the four meters (spec 3.2), each 1 … 5. */
export type CarStatsFn = (carId: string) => MenuCarStats;

/**
 * The exports of src/game/menuFlow.ts (Babylon-free; every storage access in
 * try / catch: a failed read = default, a failed write is ignored).
 */
export interface MenuFlowModule {
  /** [5038]: seeds that fail a planner check; RANDOM never returns them. */
  BAD_SEEDS: readonly number[];
  /** Uniform in 1 … 1100 via `random`, never in `exclude` or BAD_SEEDS. */
  randomSeed(exclude: readonly number[], random: () => number): number;
  carStats: CarStatsFn;
  /** `localStorage['web-racer.bestLap.hills2-' + seed]`, s, or null. */
  bestLapFor(seed: number): number | null;
  /** Sets `sessionStorage['web-racer.menu.next'] = 'race'`, then
   * `location.search = optionsToQuery(options, overrides)`. The caller
   * includes `view` and `music` in `overrides`. */
  reloadWith(options: GameOptions, overrides: Partial<GameOptions>): void;
  /** Reads AND removes the one-shot flag: 'race' if it was set, else 'title'. */
  takeMenuNext(): 'race' | 'title';
  /** `localStorage['web-racer.view']`, null when absent or invalid. */
  storedView(): ViewMode | null;
  storeView(mode: ViewMode): void;
  /** `localStorage['web-racer.musicVolume']` (0 … 1), null when absent or
   * invalid. */
  storedMusicVolume(): number | null;
  /** Rounded to one decimal. */
  storeMusicVolume(v: number): void;
}
