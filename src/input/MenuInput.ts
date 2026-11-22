import type {
  CreateMenuInput,
  MenuButton,
  MenuCommand,
  MenuDevice,
  MenuDigit,
  MenuInputOptions,
  MenuInputSource,
  MenuPointerAction,
  MenuRepeat,
} from '../game/contracts/menu';
import { connectedPads } from './pads';

/**
 * Menu input (contract: `MenuInputSource` in src/game/contracts/menu.ts;
 * spec: design-documents/menu-mockups/SPEC.md section 4). Keyboard + every
 * connected pad + actions pushed by the view → ONE `MenuCommand` per
 * `poll(now)`. Call `poll` EVERY frame, also during the race, so pad edges
 * never go stale.
 *
 *   up / down       ArrowUp, KeyW / ArrowDown, KeyS · pad 12 / 13, stick Y (axis 1)
 *   left / right    ArrowLeft, KeyA / ArrowRight, KeyD · pad 14 / 15, stick X (axis 0)
 *   select          Enter, NumpadEnter, Space · pad 0 (Cross)
 *   back (+escape)  Escape (escape only from the key) · pad 1 (Circle)
 *   pause           KeyP · pad 9 (Options)
 *   undo            Delete, Backspace · pad 2 (Square)
 *   random          KeyR · pad 3 (Triangle)
 *   digit           Digit0–9, Numpad0–9 (one per poll, queued)
 *
 * - Edges: a key press is latched until the next poll (a tap shorter than a
 *   frame is never lost); `e.repeat` events are ignored. Pads are sampled.
 * - Repeat (directions): first after 350 ms, then every 110 ms; with the
 *   'fast' profile (`setRepeat`) left / right go to 40 ms after 1.5 s held.
 *   Keyboard and pads share the one timer per direction (held = any source).
 * - Stick: a direction fires at |axis| ≥ 0.55 on the dominant axis and is
 *   held until that axis is back below 0.3.
 * - A pad's first poll only primes its state, and whatever it holds then is
 *   ignored until released (the waking press does nothing).
 * - `guard()`: every key / button / stick direction down right now is
 *   ignored until it has been released once.
 * - Keys with Ctrl / Cmd / Alt and keys typed in a form control are ignored.
 *   While capturing (`setCapturing(true)`), handled keys get
 *   `preventDefault()` on keydown AND keyup (arrows / Space would scroll; a
 *   DOM-focused <button> would also click itself on Enter / Space).
 * - `autoPause` (edge): the page was hidden, the window lost focus, or the
 *   last-used pad disconnected.
 */

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];

type KeyButton = MenuButton | 'escape';

const KEYS: Readonly<Record<string, KeyButton>> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Enter: 'select',
  NumpadEnter: 'select',
  Space: 'select',
  Escape: 'escape',
  KeyP: 'pause',
  Delete: 'undo',
  Backspace: 'undo',
  KeyR: 'random',
};

function digitOf(code: string): MenuDigit | null {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  return m ? (Number(m[1]) as MenuDigit) : null;
}

/** Standard-mapping button index → menu button. */
const PAD_BUTTONS: readonly (readonly [number, MenuButton])[] = [
  [0, 'select'],
  [1, 'back'],
  [2, 'undo'],
  [3, 'random'],
  [9, 'pause'],
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
];

export const MENU_REPEAT = {
  /** ms before the first repeat. */
  delay: 350,
  /** ms between repeats. */
  interval: 110,
  /** 'fast' profile, left / right: interval after `fastAfter` ms held. */
  fastInterval: 40,
  fastAfter: 1500,
  /** Stick: fire at |axis| ≥ fire, re-arm below release. */
  stickFire: 0.55,
  stickRelease: 0.3,
} as const;

interface PadState {
  pressed: boolean[];
  /** Ignored until released (primed or guarded). */
  guarded: boolean[];
  stick: Dir | null;
  stickGuarded: boolean;
}

interface DirState {
  held: boolean;
  since: number;
  nextAt: number;
}

function isFormControl(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

function stickDirOf(x: number, y: number): Dir | null {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (Math.max(ax, ay) < MENU_REPEAT.stickFire) return null;
  if (ay >= ax) return y < 0 ? 'up' : 'down';
  return x < 0 ? 'left' : 'right';
}

/** Is the stick still holding `dir` (hysteresis: down to `stickRelease`)? */
function stickHolds(dir: Dir, x: number, y: number): boolean {
  const r = MENU_REPEAT.stickRelease;
  switch (dir) {
    case 'up':
      return y <= -r;
    case 'down':
      return y >= r;
    case 'left':
      return x <= -r;
    default:
      return x >= r;
  }
}

function axis(pad: Gamepad, i: number): number {
  const v = pad.axes?.[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export const createMenuInput: CreateMenuInput = (options: MenuInputOptions = {}): MenuInputSource => {
  const target: Window | undefined = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  const doc: Document | undefined = (target as { document?: Document } | undefined)?.document;
  const pads = options.pads ?? connectedPads;

  const out: MenuCommand = {
    up: false,
    down: false,
    left: false,
    right: false,
    select: false,
    back: false,
    escape: false,
    pause: false,
    undo: false,
    random: false,
    digit: null,
    device: 'keyboard',
    autoPause: false,
    pointer: [],
  };

  let device: MenuDevice = 'keyboard';
  let capturing = false;
  let repeat: MenuRepeat = 'normal';
  let autoPause = false;
  /** Codes held now (handled codes only). */
  const keysDown = new Set<string>();
  /** Codes held through a guard: ignored until their keyup. */
  const keysGuarded = new Set<string>();
  /** Edges latched since the last poll. */
  const latched = new Set<KeyButton>();
  const digits: MenuDigit[] = [];
  let pointer: MenuPointerAction[] = [];
  const padStates = new Map<number, PadState>();
  const seenNow = new Set<number>();
  let lastPad: number | null = null;
  const dirs: Record<Dir, DirState> = {
    up: { held: false, since: 0, nextAt: 0 },
    down: { held: false, since: 0, nextAt: 0 },
    left: { held: false, since: 0, nextAt: 0 },
    right: { held: false, since: 0, nextAt: 0 },
  };

  const handled = (code: string): boolean => KEYS[code] !== undefined || digitOf(code) !== null;
  const ignoredEvent = (e: KeyboardEvent): boolean =>
    e.ctrlKey || e.metaKey || e.altKey || isFormControl(e.target) || isFormControl(doc?.activeElement ?? null);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (ignoredEvent(e)) return;
    const code = e.code;
    if (!handled(code)) return;
    if (capturing) e.preventDefault();
    if (e.repeat) return;
    device = 'keyboard';
    keysDown.add(code);
    if (keysGuarded.has(code)) return;
    const d = digitOf(code);
    if (d !== null) {
      digits.push(d);
      return;
    }
    latched.add(KEYS[code]);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta') {
      // macOS sends no keyup for keys released while Cmd is down.
      keysDown.clear();
      keysGuarded.clear();
      return;
    }
    keysDown.delete(e.code);
    keysGuarded.delete(e.code);
    if (capturing && handled(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey && !isFormControl(e.target)) e.preventDefault();
  };
  const dropKeys = (): void => {
    keysDown.clear();
    keysGuarded.clear();
  };
  const onBlur = (): void => {
    dropKeys();
    autoPause = true;
  };
  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden') {
      dropKeys();
      autoPause = true;
    }
  };
  target?.addEventListener('keydown', onKeyDown);
  target?.addEventListener('keyup', onKeyUp);
  target?.addEventListener('blur', onBlur);
  doc?.addEventListener('visibilitychange', onVisibility);

  const interval = (d: Dir, heldFor: number): number =>
    repeat === 'fast' && (d === 'left' || d === 'right') && heldFor >= MENU_REPEAT.fastAfter ? MENU_REPEAT.fastInterval : MENU_REPEAT.interval;

  const keyHeld = (d: Dir): boolean => {
    for (const code of keysDown) if (KEYS[code] === d && !keysGuarded.has(code)) return true;
    return false;
  };

  return {
    poll(now: number): Readonly<MenuCommand> {
      const fire: Record<KeyButton, boolean> = {
        up: false,
        down: false,
        left: false,
        right: false,
        select: false,
        back: false,
        escape: false,
        pause: false,
        undo: false,
        random: false,
      };
      for (const b of latched) fire[b] = true;
      latched.clear();
      if (fire.escape) fire.back = true;

      // ── pads: every connected pad, a press on ANY of them counts ──
      const padHeld: Record<Dir, boolean> = { up: false, down: false, left: false, right: false };
      seenNow.clear();
      for (const pad of pads()) {
        seenNow.add(pad.index);
        let st = padStates.get(pad.index);
        const fresh = st === undefined;
        if (!st) {
          st = { pressed: PAD_BUTTONS.map(() => false), guarded: PAD_BUTTONS.map(() => false), stick: null, stickGuarded: false };
          padStates.set(pad.index, st);
        }
        for (let i = 0; i < PAD_BUTTONS.length; i++) {
          const [index, button] = PAD_BUTTONS[i];
          const pressed = pad.buttons[index]?.pressed ?? false;
          if (!pressed) st.guarded[i] = false;
          else if (fresh) st.guarded[i] = true; // the waking press is primed, not fired
          else if (!st.pressed[i] && !st.guarded[i]) {
            fire[button] = true;
            device = 'gamepad';
            lastPad = pad.index;
          }
          st.pressed[i] = pressed;
          if (pressed && !st.guarded[i] && (button === 'up' || button === 'down' || button === 'left' || button === 'right')) padHeld[button] = true;
        }
        const x = axis(pad, 0);
        const y = axis(pad, 1);
        if (st.stick !== null && !stickHolds(st.stick, x, y)) {
          st.stick = null;
          st.stickGuarded = false;
        }
        if (st.stick === null) {
          const d = stickDirOf(x, y);
          if (d !== null) {
            st.stick = d;
            st.stickGuarded = fresh;
            if (!fresh) {
              device = 'gamepad';
              lastPad = pad.index;
            }
          }
        }
        if (st.stick !== null && !st.stickGuarded) padHeld[st.stick] = true;
      }
      for (const index of [...padStates.keys()]) {
        if (seenNow.has(index)) continue;
        padStates.delete(index);
        if (index === lastPad) {
          lastPad = null;
          if (device === 'gamepad') autoPause = true;
        }
      }

      // ── directions: one hold timer per direction over every source ──
      for (const d of DIRS) {
        const st = dirs[d];
        const heldNow = keyHeld(d) || padHeld[d];
        const edge = fire[d] || (heldNow && !st.held);
        if (edge) {
          fire[d] = true;
          st.since = now;
          st.nextAt = now + MENU_REPEAT.delay;
        } else if (heldNow && now >= st.nextAt) {
          fire[d] = true;
          const step = interval(d, now - st.since);
          // After a long frame, do not burst: one repeat, then the rhythm.
          st.nextAt = st.nextAt + step > now ? st.nextAt + step : now + step;
        }
        st.held = heldNow;
      }

      out.up = fire.up;
      out.down = fire.down;
      out.left = fire.left;
      out.right = fire.right;
      out.select = fire.select;
      out.back = fire.back;
      out.escape = fire.escape;
      out.pause = fire.pause;
      out.undo = fire.undo;
      out.random = fire.random;
      out.digit = digits.length > 0 ? (digits.shift() ?? null) : null;
      if (pointer.length > 0) {
        const last = pointer[pointer.length - 1];
        device = last.kind === 'focus' && last.via === 'tab' ? 'keyboard' : 'pointer';
      }
      out.pointer = pointer;
      pointer = [];
      out.device = device;
      out.autoPause = autoPause;
      autoPause = false;
      return out;
    },
    guard(): void {
      for (const code of keysDown) keysGuarded.add(code);
      latched.clear();
      digits.length = 0;
      for (const st of padStates.values()) {
        for (let i = 0; i < st.pressed.length; i++) if (st.pressed[i]) st.guarded[i] = true;
        if (st.stick !== null) st.stickGuarded = true;
      }
      for (const d of DIRS) dirs[d].held = false;
    },
    setRepeat(profile: MenuRepeat): void {
      repeat = profile;
    },
    setCapturing(on: boolean): void {
      capturing = on;
    },
    push(action: MenuPointerAction): void {
      pointer.push(action);
    },
    dispose(): void {
      target?.removeEventListener('keydown', onKeyDown);
      target?.removeEventListener('keyup', onKeyUp);
      target?.removeEventListener('blur', onBlur);
      doc?.removeEventListener('visibilitychange', onVisibility);
      dropKeys();
      padStates.clear();
    },
  };
};
