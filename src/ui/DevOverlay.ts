import type { GameOptions } from '../game/options';
import { CAR_DESIGNS, VEHICLE_MODELS, VIEW_MODES, optionsToQuery } from '../game/options';

/**
 * Dev overlay: a 34 px strip along the top (hidden by default; H or
 * `?dev=1`) with the current seed / terrain / view / vehicle / car / quality
 * and links that switch ONE parameter and keep the rest (A/B by reload). The
 * HUD moves down by the strip's height while it shows (`insets.top: 34`).
 */
export interface DevOverlayHandle {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** The view the camera is in now (C cycles it without a reload). */
  setView(view: string): void;
  dispose(): void;
}

export const DEV_OVERLAY_HEIGHT = 34;

const CSS = `
.wr-dev {
  position: fixed; top: 0; left: 0; right: 0; height: ${DEV_OVERLAY_HEIGHT}px; z-index: 11; box-sizing: border-box;
  display: flex; align-items: center; gap: 14px; padding: 0 10px; overflow-x: auto; white-space: nowrap;
  color: #fff; font: 12px ui-monospace, Menlo, monospace; background: rgba(0, 0, 0, 0.6);
}
.wr-dev[hidden] { display: none; }
.wr-dev b { color: #fff; }
.wr-dev a { color: #8cf; text-decoration: none; margin-left: 4px; }
.wr-dev a:hover { text-decoration: underline; }
.wr-dev .wr-dev-dim { color: #999; }
`;

export function createDevOverlay(options: GameOptions): DevOverlayHandle {
  if (!document.getElementById('wr-dev-style')) {
    const style = document.createElement('style');
    style.id = 'wr-dev-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'wr-dev';
  root.hidden = true;

  // Links carry dev=1 so the overlay is still there after the reload.
  const link = (text: string, overrides: Partial<GameOptions>): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.textContent = text;
    a.href = optionsToQuery(options, { dev: true, ...overrides });
    return a;
  };
  const item = (label: string, value: string, links: HTMLElement[]): HTMLSpanElement => {
    const span = document.createElement('span');
    span.append(`${label} `);
    const b = document.createElement('b');
    b.textContent = value;
    span.append(b, ...links);
    return span;
  };
  const others = <T extends string>(list: readonly T[], current: T, key: keyof GameOptions): HTMLAnchorElement[] =>
    list.filter((v) => v !== current).map((v) => link(v, { [key]: v } as Partial<GameOptions>));

  root.append(
    item('seed', String(options.seed), [link('−', { seed: Math.max(1, options.seed - 1) }), link('+', { seed: options.seed + 1 })]),
    item('terrain', options.terrain, [link(options.terrain === 'hills' ? 'flat' : 'hills', { terrain: options.terrain === 'hills' ? 'flat' : 'hills' })]),
  );
  const viewSpan = document.createElement('span');
  root.append(viewSpan);
  const renderView = (view: string): void => {
    viewSpan.textContent = '';
    viewSpan.append(item('view', view, others(VIEW_MODES, view as (typeof VIEW_MODES)[number], 'view')));
  };
  renderView(options.view);
  root.append(
    // Tuning keys belong to a model (`grip` is raycast / hybrid only, …): a
    // link to another model drops `tune=`, or the next page would refuse to start.
    item('vehicle', options.vehicle, VEHICLE_MODELS.filter((v) => v !== options.vehicle).map((v) => link(v, { vehicle: v, tune: {} }))),
    item('car', options.car, others(CAR_DESIGNS, options.car, 'car')),
    item('quality', options.quality, [link(options.quality === 'high' ? 'quest' : 'high', { quality: options.quality === 'high' ? 'quest' : 'high' })]),
  );
  const keys = document.createElement('span');
  keys.className = 'wr-dev-dim';
  keys.textContent = 'R reset · C camera · Enter restart · T tuning · H this bar';
  root.append(keys);
  document.body.appendChild(root);

  const handle: DevOverlayHandle = {
    get visible(): boolean {
      return !root.hidden;
    },
    show(): void {
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
    toggle(): void {
      root.hidden = !root.hidden;
    },
    setView(view: string): void {
      renderView(view);
    },
    dispose(): void {
      root.remove();
    },
  };
  return handle;
}
