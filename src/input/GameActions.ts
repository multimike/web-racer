import type { CreateGameActions, GameActions, GameActionSource } from '../game/contracts/camera';
import { connectedPads } from './pads';

/**
 * The non-driving buttons (contract: src/game/contracts/camera.ts).
 *
 * EDGE-triggered: a field is true for exactly the one `poll()` in which its
 * key or button went down. Keyboard presses arrive as events and are latched
 * until the next poll, so a tap shorter than a frame is never lost; the
 * gamepad has no events and is sampled in `poll()` (pressed false → true)
 * on every connected standard pad (src/input/pads.ts).
 *
 *   key  R      / pad 1 (Circle / B)        reset
 *   key  C      / pad 3 (Triangle / Y)      camera
 *   key  Enter  / pad 9 (Options / Start)   restart (see below)
 *   key  T                                  tuning panel
 *   key  H                                  dev overlay
 *   key  M                                  music on / off
 *
 * RESTART and the game menu (design-documents/menu-mockups/SPEC.md, 4):
 * `createGameActions()` with no options is the page without a menu — Enter
 * and pad Options restart at once, as they always did. A page WITH the menu
 * passes `{ enterRestarts: options.dev, padRestarts: false }`: pad 9 is then
 * the pause button (read by MenuInput, never a restart here) and Enter
 * restarts only on a dev page. While a menu is open the game discards
 * `reset` / `camera` / `restart` itself; `poll()` still runs every frame so
 * latched keys and pad edges never go stale.
 *
 * Auto-repeat is ignored, and so is every key typed while a form control has
 * focus (the tuning panel's sliders swallow every keydown and take the
 * mouse only; driving keys in KeyboardInput are never filtered). Keys held
 * with Ctrl / Cmd / Alt are browser shortcuts (Cmd+R reload, Ctrl+C copy,
 * Cmd+T new tab), never actions. Enter on a focused button or link activates
 * that element, so it does not also restart the race.
 */

type ActionName = keyof GameActions;

const KEYS: Readonly<Record<string, ActionName>> = {
  KeyR: 'reset',
  KeyC: 'camera',
  Enter: 'restart',
  NumpadEnter: 'restart',
  KeyT: 'tuning',
  KeyH: 'dev',
  KeyM: 'music',
};

/** Standard-mapping button index → action. */
const PAD_BUTTONS: readonly (readonly [number, ActionName])[] = [
  [1, 'reset'],
  [3, 'camera'],
  [9, 'restart'],
];

/** What may restart the race (both default to true: the page without a menu). */
export interface GameActionsOptions {
  /** Enter / NumpadEnter fire `restart`. Menu pages: only with `?dev=1`. */
  enterRestarts?: boolean;
  /** Pad button 9 (Options / Start) fires `restart`. Menu pages: false (it
   * is the pause button there). */
  padRestarts?: boolean;
}

function isFormControl(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Elements Enter activates by itself. */
function isActivatable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY';
}

function clear(a: GameActions): void {
  a.reset = false;
  a.camera = false;
  a.restart = false;
  a.tuning = false;
  a.dev = false;
  a.music = false;
}

export function createGameActions(opts: GameActionsOptions = {}): GameActionSource {
  const enterRestarts = opts.enterRestarts ?? true;
  const padRestarts = opts.padRestarts ?? true;
  const latched: GameActions = { reset: false, camera: false, restart: false, tuning: false, dev: false, music: false };
  const out: GameActions = { reset: false, camera: false, restart: false, tuning: false, dev: false, music: false };
  // Per pad (`Gamepad.index`): previous `pressed` state per watched button
  // (index into PAD_BUTTONS). A pad not seen last poll is new: its first
  // poll only primes the state (see poll()).
  const padWas = new Map<number, boolean[]>();
  const seenNow = new Set<number>();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isFormControl(e.target) || isFormControl(document.activeElement)) return;
    const action = KEYS[e.code];
    if (action === 'restart' && (!enterRestarts || isActivatable(e.target) || isActivatable(document.activeElement))) return;
    if (action) latched[action] = true;
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    poll(): Readonly<GameActions> {
      out.reset = latched.reset;
      out.camera = latched.camera;
      out.restart = latched.restart;
      out.tuning = latched.tuning;
      out.dev = latched.dev;
      out.music = latched.music;
      clear(latched);

      // Every connected standard pad (src/input/pads.ts): a button fires
      // when it goes down on ANY of them. Browsers reveal a pad to the page
      // only after its first button press: the poll that first sees a pad
      // only primes its previous state, so the waking press never fires its
      // action (Circle would reset the car, Options restart the race).
      seenNow.clear();
      for (const pad of connectedPads()) {
        seenNow.add(pad.index);
        let was = padWas.get(pad.index);
        const fresh = was === undefined;
        if (!was) {
          was = PAD_BUTTONS.map(() => false);
          padWas.set(pad.index, was);
        }
        for (let i = 0; i < PAD_BUTTONS.length; i++) {
          const pressed = pad.buttons[PAD_BUTTONS[i][0]]?.pressed ?? false;
          const action = PAD_BUTTONS[i][1];
          if (pressed && !was[i] && !fresh && (action !== 'restart' || padRestarts)) out[action] = true;
          was[i] = pressed;
        }
      }
      for (const index of padWas.keys()) if (!seenNow.has(index)) padWas.delete(index);
      return out;
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}

// Still callable as the contract's zero-argument factory.
createGameActions satisfies CreateGameActions;
