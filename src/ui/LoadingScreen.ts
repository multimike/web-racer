/**
 * Boot loading screen: a centred panel with a progress bar and the current
 * step, over the (still empty) canvas. Driven by `createGame`'s `onProgress`;
 * the game removes it when the first frame has been presented.
 *
 * index.html carries the same panel as static markup (`#wr-loading`, with
 * this CSS inline as `#wr-loading-style`), so it shows while the script —
 * 5 MB in a production build — is still downloading; this module ADOPTS that
 * element when it exists and builds an identical one otherwise.
 */
export interface LoadingScreen {
  set(fraction: number, label: string): void;
  /** Show an error instead of the progress (a failed boot). */
  fail(message: string): void;
  /** Fade out (0.35 s), then drop the element; `onGone` runs once it is gone. */
  remove(onGone?: () => void): void;
}

const CSS = `
.wr-loading {
  position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 40%, #a9d3f0 0%, #7fb4dc 60%, #5f97c4 100%);
  font: 600 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #10202c;
  transition: opacity 0.35s ease;
}
.wr-loading.wr-out { opacity: 0; pointer-events: none; }
.wr-loading-panel {
  width: min(420px, 80vw); padding: 22px 26px 20px; border-radius: 14px;
  background: rgba(20, 30, 39, 0.82); color: #eef6fa; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}
.wr-loading-title { font: italic 800 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.04em; margin-bottom: 14px; }
.wr-loading-track { height: 10px; border-radius: 5px; background: rgba(255, 255, 255, 0.14); overflow: hidden; }
.wr-loading-fill { height: 100%; width: 0%; background: #14e8f6; border-radius: 5px; transition: width 0.15s linear; }
.wr-loading-label { margin-top: 10px; font-weight: 500; font-size: 13px; opacity: 0.8; min-height: 1.2em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-loading-error { margin-top: 10px; font: 12px ui-monospace, Menlo, monospace; color: #ffb4a8; white-space: pre-wrap; max-height: 50vh; overflow: auto; }
`;

export function createLoadingScreen(parent: HTMLElement = document.body): LoadingScreen {
  if (!document.getElementById('wr-loading-style')) {
    const style = document.createElement('style');
    style.id = 'wr-loading-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const adopted = adoptStatic();
  const { root, panel, title, track, fill, label } = adopted ?? build(parent);

  let removed = false;
  return {
    set(fraction: number, text: string): void {
      const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
      fill.style.width = `${(f * 100).toFixed(1)}%`;
      label.textContent = text;
    },
    fail(message: string): void {
      title.textContent = 'COULD NOT START';
      track.remove();
      label.textContent = '';
      const err = document.createElement('div');
      err.className = 'wr-loading-error';
      err.textContent = message;
      panel.appendChild(err);
    },
    remove(onGone?: () => void): void {
      if (removed) return;
      removed = true;
      root.classList.add('wr-out');
      setTimeout(() => {
        root.remove();
        onGone?.();
      }, 400);
    },
  };
}

interface Parts {
  root: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
  label: HTMLElement;
}

/** The static panel of index.html, if it is there and complete. */
function adoptStatic(): Parts | null {
  const root = document.getElementById('wr-loading');
  if (!root) return null;
  const q = (cls: string): HTMLElement | null => root.querySelector<HTMLElement>(`.${cls}`);
  const panel = q('wr-loading-panel');
  const title = q('wr-loading-title');
  const track = q('wr-loading-track');
  const fill = q('wr-loading-fill');
  const label = q('wr-loading-label');
  if (!panel || !title || !track || !fill || !label) {
    root.remove();
    return null;
  }
  return { root, panel, title, track, fill, label };
}

function build(parent: HTMLElement): Parts {
  const root = document.createElement('div');
  root.className = 'wr-loading';
  const panel = document.createElement('div');
  panel.className = 'wr-loading-panel';
  const title = document.createElement('div');
  title.className = 'wr-loading-title';
  title.textContent = 'WEB RACER';
  const track = document.createElement('div');
  track.className = 'wr-loading-track';
  const fill = document.createElement('div');
  fill.className = 'wr-loading-fill';
  track.appendChild(fill);
  const label = document.createElement('div');
  label.className = 'wr-loading-label';
  label.textContent = 'starting…';
  panel.append(title, track, label);
  root.appendChild(panel);
  parent.appendChild(root);
  return { root, panel, title, track, fill, label };
}

/** Shot pages show only the game frame: drop the static panel. */
export function removeStaticLoadingScreen(): void {
  document.getElementById('wr-loading')?.remove();
}
