import { parseGameOptions } from './game/options';
import type { GameOptions } from './game/options';
import { createGame, errorText, pageErrors, writeFatal } from './scene/createScene';
import { createLoadingScreen, removeStaticLoadingScreen } from './ui/LoadingScreen';

/**
 * Game page: parse the URL (src/game/options.ts) → loading screen →
 * createGame (src/scene/createScene.ts). Dev builds expose the game as
 * `window.__game` for console poking.
 */

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;

/** A URL the parser rejects (a malformed `tune=` entry) stops the boot with
 * its message, like a boot error; the page mode (shot / report) is still read
 * from the rest of the URL so the message goes where that mode shows it. */
function parse(): { options: GameOptions; error: unknown } {
  try {
    return { options: parseGameOptions(location.search), error: null };
  } catch (e) {
    const p = new URLSearchParams(location.search);
    p.delete('tune');
    return { options: parseGameOptions(`?${p.toString()}`), error: e };
  }
}
const { options, error: optionsError } = parse();

window.addEventListener('error', (e) => pageErrors.push(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => pageErrors.push(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));

// Shot pages show only the game frame.
const loading = options.shot ? null : createLoadingScreen();
if (options.shot) removeStaticLoadingScreen();
const status = document.getElementById('status');

const started = optionsError
  ? Promise.reject(optionsError)
  : createGame(canvas, options, (fraction, label) => {
      loading?.set(fraction, label);
      if (status && options.report) status.textContent = `boot ${(fraction * 100).toFixed(0)} % ${label}`;
    });

started
  .then((game) => {
    // Gone once the first frame of the running game is on screen. With the
    // game menu the race has been HELD under the panel: `menu.boot()` opens
    // the title (or, after a menu reload, starts the 3-2-1). Without it the
    // 3-2-1 has been running under the fading panel: start it again once the
    // panel is gone, so the countdown's "3" is seen in full (a restart: every
    // car is still on its grid spot, input is locked). Report and shot pages
    // keep their timing; a ?spot= page too (restart would put the player
    // back on the grid).
    const live = !options.report && !options.shot;
    const restartCountdown = (): void => {
      const s = game.session;
      if (live && options.countdown && options.spot === null && s && s.race.phase === 'countdown') s.restart();
    };
    const afterPanel = (): void => (game.menu ? game.menu.boot() : restartCountdown());
    if (loading) requestAnimationFrame(() => requestAnimationFrame(() => loading.remove(afterPanel)));
    if (import.meta.env.DEV) (window as unknown as { __game: typeof game }).__game = game;
  })
  .catch((e: unknown) => {
    const message = errorText(e);
    if (options.report) {
      writeFatal(e);
      return;
    }
    if (loading) loading.fail(message);
    else if (status) {
      status.hidden = false;
      status.dataset.error = '1';
      status.textContent = `error: ${message}`;
    }
    console.error(e);
  });
