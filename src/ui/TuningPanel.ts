import type { Observer } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import { tuningSchema } from '../car/createVehicle';
import type { TuningControl } from '../car/createVehicle';
import type { Vehicle } from '../car/Vehicle';
import type { InputProvider } from '../input/types';

/**
 * Dev tuning panel (top right, hidden by default; T or `?dev=1`): one slider
 * per control of `tuningSchema(vehicle)` — whatever model is running — in a
 * collapsible section per group, plus throttle / brake bars fed from the
 * player's input. "copy changed" puts `{ key: value }` of every slider moved
 * from its starting value on the clipboard: values found by feel-testing are
 * copied into the model's tuning file by hand (they live only in this page
 * otherwise).
 */
export interface TuningPanelHandle {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** Distance from the top of the window, CSS px (below the dev strip while it shows). */
  setTop(px: number): void;
  /** Sticky: true once any slider has left its starting value in this
   * session (the race then stops storing all-time best laps). */
  readonly touched: boolean;
  dispose(): void;
}

const CSS = `
.wr-tune {
  position: fixed; right: 10px; z-index: 10; width: 240px;
  max-height: calc(100vh - var(--wr-tune-top, 10px) - 10px); top: var(--wr-tune-top, 10px);
  overflow-y: auto; color: #fff; font: 12px ui-monospace, Menlo, monospace;
  background: rgba(0, 0, 0, 0.6); padding: 8px 10px; border-radius: 6px; user-select: none; box-sizing: border-box;
}
.wr-tune[hidden] { display: none; }
.wr-tune-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.wr-tune-head b { font-size: 13px; }
.wr-tune-sub { color: #8cf; }
.wr-tune details { margin-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 4px; }
.wr-tune summary { cursor: pointer; color: #fc8; }
.wr-tune-row { margin-top: 5px; }
.wr-tune-cap { display: flex; justify-content: space-between; }
.wr-tune-cap .wr-moved { color: #fc8; }
.wr-tune input[type=range] { width: 100%; margin: 2px 0 0; }
.wr-tune-bar { height: 8px; background: rgba(255, 255, 255, 0.15); border-radius: 3px; overflow: hidden; }
.wr-tune-bar > div { height: 100%; width: 0%; }
.wr-tune button { margin-top: 8px; width: 100%; font: inherit; cursor: pointer; }
.wr-tune-note { color: #aaa; margin-top: 4px; min-height: 1em; }
`;

function decimalsFor(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

export function createTuningPanel(scene: Scene, vehicle: Vehicle, input: InputProvider): TuningPanelHandle {
  if (!document.getElementById('wr-tune-style')) {
    const style = document.createElement('style');
    style.id = 'wr-tune-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const panel = document.createElement('div');
  panel.className = 'wr-tune';
  panel.hidden = true;

  const head = document.createElement('div');
  head.className = 'wr-tune-head';
  const title = document.createElement('b');
  title.textContent = 'tuning';
  const sub = document.createElement('span');
  sub.className = 'wr-tune-sub';
  sub.textContent = `${vehicle.modelName} · ${vehicle.rig?.id ?? '?'}`;
  head.append(title, sub);
  panel.appendChild(head);

  const throttleBar = makeBar(panel, 'throttle', '#4c4');
  const brakeBar = makeBar(panel, 'brake', '#d44');

  const controls = tuningSchema(vehicle);
  const start = new Map<string, number>();
  const sections = new Map<string, HTMLElement>();
  for (const c of controls) {
    start.set(c.key, c.value);
    const group = c.group || 'general';
    let body = sections.get(group);
    if (!body) {
      const details = document.createElement('details');
      details.open = sections.size === 0;
      const summary = document.createElement('summary');
      summary.textContent = group;
      details.appendChild(summary);
      panel.appendChild(details);
      body = details;
      sections.set(group, body);
    }
    body.appendChild(makeSlider(c, start.get(c.key) ?? c.value));
  }
  if (controls.length === 0) {
    const none = document.createElement('div');
    none.className = 'wr-tune-note';
    none.textContent = 'this model declares no tuning parameters';
    panel.appendChild(none);
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'copy changed';
  const note = document.createElement('div');
  note.className = 'wr-tune-note';
  copy.addEventListener('click', () => {
    const changed: Record<string, number> = {};
    for (const c of controls) {
      const v = c.get();
      if (v !== start.get(c.key)) changed[c.key] = v;
    }
    const text = JSON.stringify(changed, null, 2);
    const n = Object.keys(changed).length;
    const done = (ok: boolean): void => {
      note.textContent = ok ? `copied ${n} value${n === 1 ? '' : 's'}` : 'clipboard blocked — see the console';
      if (!ok) console.info(`[tuning] changed values:\n${text}`);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  });
  panel.append(copy, note);
  // Hand the keyboard back after every mouse interaction: a focused slider,
  // button or section header makes GameActions ignore R / C / Enter / T / H
  // (it skips keys while a form control has focus). Driving keys never
  // depended on focus.
  const releaseFocus = (): void => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && panel.contains(el)) el.blur();
  };
  panel.addEventListener('pointerup', () => setTimeout(releaseFocus, 0));
  panel.addEventListener('change', releaseFocus);
  document.body.appendChild(panel);

  // Slider input bubbles here after the slider's own handler set the value.
  let touched = false;
  panel.addEventListener('input', () => {
    if (!touched) touched = controls.some((c) => c.get() !== start.get(c.key));
  });

  let observer: Observer<Scene> | null = null;
  const startBars = (): void => {
    if (observer) return;
    observer = scene.onBeforeRenderObservable.add(() => {
      // Providers are plain state reads: a second poll per frame is free.
      const intent = input.poll();
      throttleBar.style.width = `${(intent.throttle * 100).toFixed(0)}%`;
      brakeBar.style.width = `${(intent.brake * 100).toFixed(0)}%`;
    });
  };
  const stopBars = (): void => {
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
  };

  const handle: TuningPanelHandle = {
    get visible(): boolean {
      return !panel.hidden;
    },
    get touched(): boolean {
      return touched;
    },
    show(): void {
      panel.hidden = false;
      startBars();
    },
    hide(): void {
      panel.hidden = true;
      stopBars();
      // A focused slider would otherwise keep eating arrow keys.
      releaseFocus();
    },
    setTop(px: number): void {
      panel.style.setProperty('--wr-tune-top', `${px}px`);
    },
    toggle(): void {
      if (panel.hidden) handle.show();
      else handle.hide();
    },
    dispose(): void {
      stopBars();
      panel.remove();
    },
  };
  return handle;
}

/** `v` with `decimals` places, or more (up to 5, trailing zeros dropped) when
 * that would round it: the label shows the value the car HAS, which can be
 * off the slider's step grid (handling presets, `?tune=`). */
function formatValue(v: number, decimals: number): string {
  const short = v.toFixed(decimals);
  if (Math.abs(Number(short) - v) < 1e-9) return short;
  return String(Number(v.toFixed(5)));
}

function makeSlider(c: TuningControl, startValue: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wr-tune-row';
  if (c.hint) row.title = c.hint;
  const caption = document.createElement('div');
  caption.className = 'wr-tune-cap';
  const name = document.createElement('span');
  name.textContent = c.label;
  const value = document.createElement('span');
  value.style.color = '#8cf';
  caption.append(name, value);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(c.min);
  slider.max = String(c.max);
  slider.step = String(c.step);
  slider.value = String(c.get());
  const decimals = decimalsFor(c.step);
  // The label and the "moved" mark read the vehicle's live value, not the
  // range input's (which snaps to min + k × step).
  const show = (): void => {
    const live = c.get();
    value.textContent = formatValue(live, decimals);
    name.classList.toggle('wr-moved', live !== startValue);
  };
  show();
  slider.addEventListener('input', () => {
    c.onChange(Number(slider.value));
    show();
  });
  // Keep the driving keys (A / D, arrows) from moving the slider that has focus.
  slider.addEventListener('keydown', (e) => e.preventDefault());
  row.append(caption, slider);
  return row;
}

function makeBar(panel: HTMLElement, label: string, color: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wr-tune-row';
  const name = document.createElement('div');
  name.textContent = label;
  const track = document.createElement('div');
  track.className = 'wr-tune-bar';
  const fill = document.createElement('div');
  fill.style.background = color;
  track.appendChild(fill);
  row.append(name, track);
  panel.appendChild(row);
  return fill;
}
