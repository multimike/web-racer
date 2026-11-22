import { formatLapTime, ordinal } from '../game/RaceState';
import type { FinishSummary, HudSnapshot } from '../game/RaceState';

/**
 * Race HUD as a DOM overlay, in the style of the gameplay-vision images:
 * dark, rounded, slightly translucent slanted slate panels with bold white
 * italic numerals — position (or lap timer) top left, lap top right, speed
 * over a cyan segmented bar bottom right — plus the centre-screen countdown,
 * WRONG WAY warning, lap flash and finish summary.
 *
 * It is a pure renderer of `HudSnapshot`: no timing, no game rules. All of
 * that lives in `game/RaceState.ts`, so a world-space panel in WebXR (where
 * DOM overlays do not exist) can paint the same snapshot.
 *
 * Layout is in `em`, with 1 em = 1/94.1 of the overlay height: the numbers in
 * the stylesheet are therefore pixels of the 1672×941 vision images divided
 * by ten, and the HUD scales with the window like the 3D view behind it.
 */

export interface HudInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface HudOptions {
  /** Element the overlay is appended to. Default `document.body` (the
   * overlay is then `position: fixed`; inside any other parent it is
   * `position: absolute` and that parent must be positioned). */
  parent?: HTMLElement;
  /** Size multiplier on top of the height-based scale. Default 1. */
  scale?: number;
  /** Segments of the bar under the speed readout. Default 5. */
  segments?: number;
  /** Explicit tick positions on the bar, 0..1 of its length — overrides
   * `segments`. `[0.375, 0.56]` reproduces the two ticks painted in the
   * vision images exactly; `[]` gives a plain bar. */
  barTicks?: readonly number[];
  /** What the big top-left panel shows. 'auto' (default): the position, or
   * the lap timer while there is only one car ("1 / 1" says nothing).
   * 'position' / 'timer' force one — 'position' is the vision's panel 1:1
   * even when racing alone. */
  topLeft?: 'auto' | 'position' | 'timer';
  /** The slim chips under the top panels (best lap under the timer, running
   * lap time under the lap counter). Default true; false leaves exactly the
   * three panels of the vision images. */
  chips?: boolean;
  /** Extra margins in CSS px, e.g. to clear dev overlays. */
  insets?: Partial<HudInsets>;
  /** Extra shift of ONLY the top-right lap panel, CSS px to the left / down —
   * the dev tuning panel sits in that corner. */
  lapPanelShift?: { x?: number; y?: number };
  /** Label after the speed. Default "km/h". */
  speedUnit?: string;
  /** Height of the countdown digit's centre, 0..1 from the top of the HUD
   * area. Default 0.5 (the screen centre, as the vision's HUD has none). The
   * game puts it in the upper third: centred, it covers the player's car on
   * the grid. */
  countdownY?: number;
  /** Horizontal place of the digit's centre, 0..1 from the left. Default 0.5. */
  countdownX?: number;
  /** Size of the countdown digit, × the default. Default 1. */
  countdownScale?: number;
  /** Pin the digit to the 3D picture of a camera that keeps its VERTICAL fov
   * at and above this aspect and its HORIZONTAL fov below it (the game's
   * chase rule, followVerticalFov): `countdownX / Y / Scale` are then the
   * values at this aspect and wider, and a narrower HUD area shrinks the
   * digit and its offset from the centre with the picture, so it keeps the
   * same gap between the same things. Default: none (screen-fixed). */
  countdownRefAspect?: number;
  /** Pop / fade animations. Default true; off gives static frames for
   * screenshots and respects the caller's reduced-motion choice. */
  animate?: boolean;
  /** Override the font stack (must provide a bold italic). */
  fontFamily?: string;
  /** Stacking order. Default 5 — below the dev panels (z-index 10), so those
   * stay readable and clickable on top of the HUD. */
  zIndex?: number;
}

const STYLE_ID = 'rhud-style';

// System fonts only (no download): SF Pro on Apple, Segoe UI on Windows,
// Roboto on Android / Quest — all ship a heavy weight with a true italic.
const FONT_STACK =
  'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const CSS = `
.rhud {
  position: absolute; inset: 0; overflow: hidden;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  /* cqh/cqw below resolve against this box, so the HUD follows its own
     container rather than the browser window when it is embedded. */
  container-type: size;
  --rhud-scale: 1;
  --rhud-in-t: 0px; --rhud-in-r: 0px; --rhud-in-b: 0px; --rhud-in-l: 0px;
  --rhud-lap-x: 0px; --rhud-lap-y: 0px;
  --rhud-slate: #141e27;
  --rhud-rim: #aebbc2;
  --rhud-cyan: #14e8f6;
  --rhud-skew: -10deg;
  /* Glyphs are widened a touch: the vision's lettering is an extended face. */
  --rhud-wide: 1.08;
  --rhud-alpha: 0.73;
}
.rhud.rhud-fixed { position: fixed; }
.rhud[hidden] { display: none; }
.rhud-stage {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + var(--rhud-in-t));
  right: calc(env(safe-area-inset-right, 0px) + var(--rhud-in-r));
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--rhud-in-b));
  left: calc(env(safe-area-inset-left, 0px) + var(--rhud-in-l));
  /* 1em = 10px at 941px height; the width term only bites on portrait
     windows, where three panels would no longer fit side by side. */
  font-size: calc(min(1.0627vh, 1.5625vw) * var(--rhud-scale));
  font-size: calc(min(1.0627cqh, 1.5625cqw) * var(--rhud-scale));
  font-family: var(--rhud-font);
  font-weight: 800; font-style: italic; line-height: 1; white-space: nowrap;
  /* Fixed-width digits: a changing number must not shove its neighbours. */
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  color: #fff;
  -webkit-font-smoothing: antialiased;
  /* First layer: a pale lip on the lower-left edge — the slight bevel of the
     vision's painted glyphs — then the dark drop shadow under it. */
  text-shadow: -0.02em 0.03em 0 #8d98a0, 0.035em 0.055em 0 rgba(8, 14, 20, 0.6), 0 0.09em 0.22em rgba(8, 14, 20, 0.35);
}
.rhud-stage > div { position: absolute; contain: layout style; }
.rhud-x { display: inline-block; transform: scaleX(var(--rhud-wide)); }
/* Invisible leading digits: "9 / 12" keeps the width of "10 / 12", so the
   slash and the total do not jump when the number gains a digit. */
.rhud-pad { visibility: hidden; }

/* Slanted slate plate. Opaque colours under ONE group opacity, so the rim
   and the fill never double up where shapes overlap (the speed panel is
   three overlapping pieces). */
.rhud-plate {
  position: absolute; inset: 0; box-sizing: border-box;
  transform: skewX(var(--rhud-skew));
  border-radius: 1.6em;
  background: var(--rhud-slate);
  border: max(1px, 0.16em) solid var(--rhud-rim);
  opacity: var(--rhud-alpha);
}
/* "4 / 4": the font's own slash towers over the digits; the vision's is a
   short stroke, so it is set smaller and re-centred on the cap height. */
.rhud-slash { display: inline-block; font-size: 0.8em; font-weight: 700; margin: 0 0.26em; position: relative; top: -0.07em; }
.rhud-slash[hidden] { display: none; }

/* ── top left: position, or the lap timer when racing alone ── */
.rhud-tl { left: 2.6em; top: 2.2em; width: 18.4em; height: 10em; }
.rhud-tl-big { position: absolute; left: 0.25em; right: 0; top: 0.72em; text-align: center; }
.rhud-tl-big > span { font-size: 5.9em; }
.rhud-tl-label { position: absolute; left: 0; right: 0.75em; top: 6.6em; text-align: center; color: #e9edef; }
.rhud-tl-label > span { font-size: 2.05em; letter-spacing: 0.06em; }
/* Two-digit fields ("10 / 12") get a smaller size rather than a panel that
   changes width mid-race. */
.rhud-tl-wide .rhud-tl-big { top: 1.5em; }
/* The margin takes half a digit off the left of the centred group: one- and
   two-digit positions then sit a quarter digit either side of the middle
   instead of the common one-digit case hanging half a digit to the right. */
.rhud-tl-wide .rhud-tl-big > span { font-size: 4.3em; margin-left: -0.3em; }
/* The lap timer is seven glyphs where the position is three: wider plate. */
.rhud-solo .rhud-tl { width: 22.6em; }
.rhud-solo .rhud-tl-big { top: 1.2em; }
.rhud-solo .rhud-tl-big > span { font-size: 4.7em; }
/* Ten minutes and more is an eighth glyph ("10:00.00"): smaller type, same
   plate — reachable by simply idling on a lap. */
.rhud-solo.rhud-time-long .rhud-tl-big { top: 1.55em; }
.rhud-solo.rhud-time-long .rhud-tl-big > span { font-size: 4em; }

/* ── top right: lap ── */
.rhud-tr {
  right: calc(1.68em + var(--rhud-lap-x)); top: calc(3.1em + var(--rhud-lap-y));
  width: 18.55em; height: 5.4em;
}
.rhud-tr .rhud-plate { border-radius: 1.5em; }
.rhud-tr-row { position: absolute; left: 0; right: 0; top: 0.98em; text-align: center; }
.rhud-tr-word { font-size: 2.95em; margin-right: 0.3em; }
.rhud-tr-num { font-size: 3.4em; }
.rhud-tr-wide .rhud-tr-row { top: 1.3em; }
.rhud-tr-wide .rhud-tr-word { font-size: 2.4em; margin-right: 0.3em; }
.rhud-tr-wide .rhud-tr-num { font-size: 2.75em; }
.rhud-tr-wide .rhud-tr-row > span { margin-left: -0.8em; }

/* ── slim chips under the top panels: best lap / running lap time ── */
.rhud-chip { height: 3.5em; width: 16.6em; display: none; }
.rhud-chip .rhud-plate { border-radius: 1.1em; }
.rhud-chip-row { position: absolute; left: 0; right: 0; top: 0.78em; text-align: center; }
.rhud-chip-row > span { font-size: 1.95em; }
.rhud-chip-row b { font-weight: inherit; opacity: 0.66; margin-right: 0.5em; letter-spacing: 0.04em; }
/* Offsets continue the slanted edge of the panel above. */
.rhud-chip-l { left: 1.45em; top: 13.1em; }
.rhud-chip-r { right: calc(2.75em + var(--rhud-lap-x)); top: calc(9.4em + var(--rhud-lap-y)); width: 12.4em; }
.rhud-chip.rhud-on { display: block; }
.rhud-best-long .rhud-chip-l .rhud-chip-row, .rhud-time-long .rhud-chip-r .rhud-chip-row { top: 0.9em; }
.rhud-best-long .rhud-chip-l .rhud-chip-row > span, .rhud-time-long .rhud-chip-r .rhud-chip-row > span { font-size: 1.7em; }

/* ── bottom right: speed + bar ── */
.rhud-speed { right: 1.8em; bottom: 3.1em; width: 31.4em; height: 11.8em; }
.rhud-speed-plate {
  position: absolute; left: 1.04em; right: 1.04em; top: 0; bottom: 0;
  transform: skewX(var(--rhud-skew)); opacity: var(--rhud-alpha);
  /* stepped outline: tab (number) on top of a wider body (bar) */
  --b: max(1px, 0.16em); --r: 2em; --rc: 1.7em; --a: 8.4em; --h: 5.5em;
}
.rhud-speed-plate > i { position: absolute; display: block; }
.rhud-sp-rim { background: var(--rhud-rim); }
.rhud-sp-fill { background: var(--rhud-slate); }
.rhud-sp-body.rhud-sp-rim { left: 0; right: 0; top: var(--h); bottom: 0; border-radius: var(--r) 0 var(--r) var(--r); }
.rhud-sp-tab.rhud-sp-rim { left: var(--a); right: 0; top: 0; height: calc(var(--h) + var(--r)); border-radius: var(--r) var(--r) 0 0; }
/* Concave fillet where tab meets body: a square whose corner is cut away by
   a circle, i.e. everything OUTSIDE the circle is painted. */
.rhud-sp-fillet.rhud-sp-rim {
  /* +1px: overlap the neighbours, or the skew leaves hairline seams */
  left: calc(var(--a) - var(--rc)); top: calc(var(--h) - var(--rc));
  width: calc(var(--rc) + 1px); height: calc(var(--rc) + 1px);
  background: radial-gradient(circle at 0 0, transparent calc(var(--rc) - 0.5px), var(--rhud-rim) calc(var(--rc) + 0.5px));
}
.rhud-sp-body.rhud-sp-fill {
  left: var(--b); right: var(--b); top: calc(var(--h) + var(--b)); bottom: var(--b);
  border-radius: calc(var(--r) - var(--b)) 0 calc(var(--r) - var(--b)) calc(var(--r) - var(--b));
}
.rhud-sp-tab.rhud-sp-fill {
  left: calc(var(--a) + var(--b)); right: var(--b); top: var(--b); height: calc(var(--h) + var(--r));
  border-radius: calc(var(--r) - var(--b)) calc(var(--r) - var(--b)) 0 0;
}
.rhud-sp-fillet.rhud-sp-fill {
  left: calc(var(--a) - var(--rc)); top: calc(var(--h) - var(--rc));
  width: calc(var(--rc) + var(--b) + 1px); height: calc(var(--rc) + var(--b) + 1px);
  background: radial-gradient(circle at 0 0, transparent calc(var(--rc) + var(--b) - 0.5px), var(--rhud-slate) calc(var(--rc) + var(--b) + 0.5px));
}
.rhud-speed-row {
  position: absolute; right: 2.75em; top: 0.5em;
  display: flex; align-items: baseline; justify-content: flex-end;
  transform: scaleX(var(--rhud-wide)); transform-origin: 100% 50%;
}
.rhud-speed-num { font-size: 6em; text-align: right; display: inline-block; transform-origin: 100% 50%; }
/* Three digits would poke out of the tab: squeeze them instead of letting
   the panel change size. */
.rhud-speed-3 .rhud-speed-num { transform: scaleX(0.76); margin-left: -0.5em; }
.rhud-speed-unit { font-size: 2.55em; margin-left: 0.42em; position: relative; top: -0.16em; }

.rhud-bar {
  position: absolute; left: 2.5em; top: 7.3em; width: 25.1em; height: 3.1em; box-sizing: border-box;
  transform: skewX(var(--rhud-skew));
  border-radius: 0.85em; padding: 0.26em;
  background: linear-gradient(#a8b3b9, #7f8b92);
  box-shadow: 0 0.1em 0.3em rgba(0, 0, 0, 0.35);
}
.rhud-bar-track {
  position: relative; height: 100%; overflow: hidden;
  border-radius: 0.6em; background: #20272c;
  box-shadow: inset 0 0.12em 0.3em rgba(0, 0, 0, 0.6);
}
.rhud-bar-fill {
  position: absolute; inset: 0; --v: 0; --slant: 0.7em;
  background: linear-gradient(#3df1fb, var(--rhud-cyan) 40%, #0fdcec);
  /* The value moves a clip edge instead of a width: paint only, no layout,
     and the segment ticks underneath stay put while the fill sweeps. */
  clip-path: polygon(
    0 0,
    calc(var(--v) * (100% + var(--slant))) 0,
    calc(var(--v) * (100% + var(--slant)) - var(--slant)) 100%,
    0 100%);
}
.rhud-bar-ticks { position: absolute; inset: 14% 0; transform: skewX(-12deg); }
/* One soft glint per tick, like the painted bar — not a hard hairline. */
.rhud-bar-ticks > i {
  position: absolute; top: 0; bottom: 0; width: 0.24em; margin-left: -0.12em;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.85) 45%, rgba(255, 255, 255, 0.85) 55%, transparent);
}

/* ── centre: warning + flash ── */
.rhud-center {
  left: 0; right: 0; top: 15.5%;
  display: flex; flex-direction: column; align-items: center; gap: 1.6em;
}
.rhud-wrong { position: relative; padding: 1.25em 3.6em 1.15em; display: none; }
.rhud-wrong .rhud-plate { background: #d42a3c; border-color: #ffd0cf; opacity: 0.92; border-radius: 1.4em; }
.rhud-wrong > span { position: relative; font-size: 4.2em; letter-spacing: 0.03em; }
.rhud-wrong.rhud-on { display: block; }
.rhud-anim .rhud-wrong.rhud-on { animation: rhud-blink 0.9s steps(1, end) infinite; }
@keyframes rhud-blink { 0% { opacity: 1; } 62% { opacity: 0.25; } 100% { opacity: 1; } }

.rhud-flash { text-align: center; opacity: 0; }
.rhud-anim .rhud-flash { transition: opacity 0.35s ease-out; }
.rhud-flash.rhud-on { opacity: 1; }
.rhud-flash-text { font-size: 5.6em; letter-spacing: 0.02em; }
.rhud-flash-sub { font-size: 3.5em; margin-top: 0.32em; color: var(--rhud-cyan); }
.rhud-flash-best .rhud-flash-text { color: #ffe14a; }
.rhud-flash-text, .rhud-flash-sub, .rhud-count > span {
  /* Free-floating text over the scene needs its own contrast: a slate
     outline drawn UNDER the fill (paint-order), so the glyphs keep their
     weight; where paint-order is not applied to text the stroke merely
     thins them a little. */
  -webkit-text-stroke: 0.14em #0e161d; paint-order: stroke fill;
  text-shadow: 0 0.09em 0.16em rgba(8, 14, 20, 0.5);
}
.rhud-count > span { -webkit-text-stroke-width: 0.07em; }

/* ── centre: countdown ── */
.rhud-count { left: var(--rhud-count-x, 50%); width: 0; top: var(--rhud-count-y, 50%); display: none; }
.rhud-count.rhud-on { display: flex; justify-content: center; }
.rhud-count > span { display: inline-block; flex: none; font-size: calc(24em * var(--rhud-count-s, 1)); font-weight: 900; margin-top: -0.62em; }
.rhud-count-go > span { color: var(--rhud-cyan); font-size: calc(20em * var(--rhud-count-s, 1)); }

/* ── centre: finish summary ── */
.rhud-finish { left: 50%; top: 50%; width: 46em; margin-left: -23em; transform: translateY(-50%); display: none; }
.rhud-finish.rhud-on { display: block; }
.rhud-finish .rhud-plate { opacity: 0.88; border-radius: 2.2em; transform: skewX(-4deg); }
.rhud-finish-body { position: relative; padding: 2.6em 4.2em 2.8em; text-align: center; }
.rhud-finish-title { font-size: 7em; font-weight: 900; letter-spacing: 0.03em; }
.rhud-finish-place { font-size: 3em; margin-top: 0.45em; color: #ffe14a; }
.rhud-finish-total { font-size: 4.6em; margin-top: 0.5em; }
.rhud-finish-total b, .rhud-finish-row b { font-weight: inherit; opacity: 0.62; margin-right: 0.6em; letter-spacing: 0.04em; }
.rhud-finish-laps { margin: 1.5em auto 0; width: 30em; border-top: max(1px, 0.14em) solid rgba(174, 187, 194, 0.5); padding-top: 1.1em; }
.rhud-finish-row { font-size: 2.6em; display: flex; justify-content: space-between; margin-top: 0.34em; }
.rhud-finish-row.rhud-best { color: var(--rhud-cyan); }
.rhud-finish-record { font-size: 2.3em; margin-top: 0.9em; opacity: 0.9; }
.rhud-finish-record.rhud-new { color: #ffe14a; opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .rhud-anim .rhud-wrong.rhud-on { animation: none; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

/** A text node that is only written when its string actually changes. */
class TextCell {
  private readonly node: Text;
  private last: string;

  constructor(parent: HTMLElement, initial = '') {
    this.node = document.createTextNode(initial);
    this.last = initial;
    parent.appendChild(this.node);
  }

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.data = value;
  }
}

/** A CSS class that is only toggled when its state actually changes. */
class Flag {
  private readonly node: HTMLElement;
  private readonly name: string;
  private on = false;

  constructor(node: HTMLElement, name: string) {
    this.node = node;
    this.name = name;
  }

  set(on: boolean): boolean {
    if (on === this.on) return false;
    this.on = on;
    this.node.classList.toggle(this.name, on);
    return true;
  }
}

// The bar is quantised before it reaches the DOM: sub-pixel changes of an
// analog value would otherwise restyle the fill every single frame.
const BAR_STEPS = 400;
// From here the m:ss.cc readout has an eighth glyph.
const TEN_MINUTES_CS = 60000;

export class Hud {
  /** The overlay element (already attached). */
  readonly root: HTMLDivElement;

  private readonly animate: boolean;
  private readonly countdown: { x: number; y: number; scale: number; refAspect: number };
  private onResize: (() => void) | null = null;
  private readonly topLeft: 'auto' | 'position' | 'timer';
  private readonly chips: boolean;

  private readonly solo: Flag;
  private readonly timeLong: Flag;
  private readonly bestLong: Flag;
  private readonly bigPad: TextCell;
  private readonly bigText: TextCell;
  private readonly bigSlash: HTMLElement;
  private readonly bigTotal: TextCell;
  private readonly bigWide: Flag;
  private readonly labelText: TextCell;
  private readonly bestChip: Flag;
  private readonly bestText: TextCell;
  private readonly timeChip: Flag;
  private readonly timeText: TextCell;
  private readonly lapPad: TextCell;
  private readonly lapText: TextCell;
  private readonly lapSlash: HTMLElement;
  private readonly lapTotal: TextCell;
  private readonly lapWide: Flag;
  private readonly speedText: TextCell;
  private readonly speedWide: Flag;
  private readonly barFill: HTMLElement;
  private readonly wrong: Flag;
  private readonly flashEl: HTMLElement;
  private readonly flashOn: Flag;
  private readonly flashBest: Flag;
  private readonly flashText: TextCell;
  private readonly flashSub: TextCell;
  private readonly countEl: HTMLElement;
  private readonly countSpan: HTMLElement;
  private readonly countOn: Flag;
  private readonly countGo: Flag;
  private readonly countText: TextCell;
  private readonly finishEl: HTMLElement;
  private readonly finishBody: HTMLElement;
  private readonly finishOn: Flag;

  // Last painted values. Numbers are compared before any string is built.
  private lastSolo: boolean | null = null;
  private lastTimeCs = -1;
  private lastBestCs = -2;
  private lastPosition = -1;
  private lastCount = -1;
  private lastLap = -1;
  private lastLaps = -1;
  private lastSpeed = -1;
  private lastBar = -1;
  private lastCountdown: number | null | undefined = undefined;
  private lastFlashSeq = -1;
  /** The object last looked at (identity fast path)… */
  private lastFinishRef: FinishSummary | null = null;
  /** …and a private copy of what the card currently shows. */
  private shownFinish: FinishSummary | null = null;

  constructor(options: HudOptions = {}) {
    injectStyle();
    const parent = options.parent ?? document.body;
    this.animate = options.animate ?? true;
    this.topLeft = options.topLeft ?? 'auto';
    this.chips = options.chips ?? true;

    const root = el('div', 'rhud', parent);
    this.root = root;
    if (parent === document.body) root.classList.add('rhud-fixed');
    if (this.animate) root.classList.add('rhud-anim');
    root.setAttribute('aria-hidden', 'true');
    root.style.zIndex = String(options.zIndex ?? 5);
    root.style.setProperty('--rhud-font', options.fontFamily ?? FONT_STACK);
    if (options.scale !== undefined) root.style.setProperty('--rhud-scale', String(options.scale));
    const insets = options.insets;
    if (insets) {
      if (insets.top) root.style.setProperty('--rhud-in-t', `${insets.top}px`);
      if (insets.right) root.style.setProperty('--rhud-in-r', `${insets.right}px`);
      if (insets.bottom) root.style.setProperty('--rhud-in-b', `${insets.bottom}px`);
      if (insets.left) root.style.setProperty('--rhud-in-l', `${insets.left}px`);
    }
    this.countdown = {
      x: options.countdownX ?? 0.5,
      y: options.countdownY ?? 0.5,
      scale: options.countdownScale ?? 1,
      refAspect: options.countdownRefAspect ?? 0,
    };
    this.placeCountdown();
    if (this.countdown.refAspect > 0) {
      this.onResize = (): void => this.placeCountdown();
      window.addEventListener('resize', this.onResize);
    }
    if (options.lapPanelShift?.x) root.style.setProperty('--rhud-lap-x', `${options.lapPanelShift.x}px`);
    if (options.lapPanelShift?.y) root.style.setProperty('--rhud-lap-y', `${options.lapPanelShift.y}px`);

    const stage = el('div', 'rhud-stage', root);
    this.solo = new Flag(stage, 'rhud-solo');
    this.timeLong = new Flag(stage, 'rhud-time-long');
    this.bestLong = new Flag(stage, 'rhud-best-long');

    // top left
    const tl = el('div', 'rhud-tl', stage);
    el('div', 'rhud-plate', tl);
    const big = el('span', 'rhud-x', el('div', 'rhud-tl-big', tl));
    this.bigPad = new TextCell(el('span', 'rhud-pad', big));
    this.bigText = new TextCell(big);
    this.bigSlash = el('span', 'rhud-slash', big, '/');
    this.bigTotal = new TextCell(big);
    this.bigWide = new Flag(tl, 'rhud-tl-wide');
    this.labelText = new TextCell(el('span', 'rhud-x', el('div', 'rhud-tl-label', tl)));

    const chipL = el('div', 'rhud-chip rhud-chip-l', stage);
    el('div', 'rhud-plate', chipL);
    const chipLSpan = el('span', 'rhud-x', el('div', 'rhud-chip-row', chipL));
    el('b', '', chipLSpan, 'BEST');
    this.bestText = new TextCell(chipLSpan);
    this.bestChip = new Flag(chipL, 'rhud-on');

    // top right
    const tr = el('div', 'rhud-tr', stage);
    el('div', 'rhud-plate', tr);
    const trRow = el('span', 'rhud-x', el('div', 'rhud-tr-row', tr));
    // The padding digits go in FRONT of the word: "LAP 9 / 12" then reads
    // without a hole, the slash and total still never move, and the word
    // shifts exactly once in a race (lap 9 → 10) instead.
    this.lapPad = new TextCell(el('span', 'rhud-tr-num rhud-pad', trRow));
    el('span', 'rhud-tr-word', trRow, 'LAP');
    const lapNum = el('span', 'rhud-tr-num', trRow);
    this.lapText = new TextCell(lapNum);
    this.lapSlash = el('span', 'rhud-slash', lapNum, '/');
    this.lapTotal = new TextCell(lapNum);
    this.lapWide = new Flag(tr, 'rhud-tr-wide');

    const chipR = el('div', 'rhud-chip rhud-chip-r', stage);
    el('div', 'rhud-plate', chipR);
    this.timeText = new TextCell(el('span', 'rhud-x', el('div', 'rhud-chip-row', chipR)));
    this.timeChip = new Flag(chipR, 'rhud-on');

    // bottom right
    const speed = el('div', 'rhud-speed', stage);
    const plate = el('div', 'rhud-speed-plate', speed);
    for (const layer of ['rim', 'fill']) {
      for (const piece of ['body', 'tab', 'fillet']) el('i', `rhud-sp-${piece} rhud-sp-${layer}`, plate);
    }
    const row = el('div', 'rhud-speed-row', speed);
    this.speedText = new TextCell(el('span', 'rhud-speed-num', row), '0');
    el('span', 'rhud-speed-unit', row, options.speedUnit ?? 'km/h');
    this.speedWide = new Flag(speed, 'rhud-speed-3');
    const bar = el('div', 'rhud-bar', speed);
    const track = el('div', 'rhud-bar-track', bar);
    this.barFill = el('div', 'rhud-bar-fill', track);
    const ticks = el('div', 'rhud-bar-ticks', this.barFill);
    let marks = options.barTicks;
    if (!marks) {
      const segments = Math.max(1, Math.round(options.segments ?? 5));
      const even: number[] = [];
      for (let i = 1; i < segments; i++) even.push(i / segments);
      marks = even;
    }
    for (const at of marks) {
      if (at > 0 && at < 1) el('i', '', ticks).style.left = `${at * 100}%`;
    }

    // centre
    const center = el('div', 'rhud-center', stage);
    const wrong = el('div', 'rhud-wrong', center);
    el('div', 'rhud-plate', wrong);
    el('span', 'rhud-x', wrong, 'WRONG WAY');
    this.wrong = new Flag(wrong, 'rhud-on');
    this.flashEl = el('div', 'rhud-flash', center);
    this.flashOn = new Flag(this.flashEl, 'rhud-on');
    this.flashBest = new Flag(this.flashEl, 'rhud-flash-best');
    this.flashText = new TextCell(el('span', 'rhud-x', el('div', 'rhud-flash-text', this.flashEl)));
    this.flashSub = new TextCell(el('span', 'rhud-x', el('div', 'rhud-flash-sub', this.flashEl)));

    this.countEl = el('div', 'rhud-count', stage);
    this.countSpan = el('span', '', this.countEl);
    this.countText = new TextCell(this.countSpan);
    this.countOn = new Flag(this.countEl, 'rhud-on');
    this.countGo = new Flag(this.countEl, 'rhud-count-go');

    this.finishEl = el('div', 'rhud-finish', stage);
    el('div', 'rhud-plate', this.finishEl);
    this.finishBody = el('div', 'rhud-finish-body', this.finishEl);
    this.finishOn = new Flag(this.finishEl, 'rhud-on');
  }

  /** Paint one frame. Cheap to call every frame: the DOM is only touched for
   * values that changed since the previous call. */
  update(s: HudSnapshot): void {
    // With a single car "1 / 1" says nothing — the big panel shows the lap
    // timer instead and the best lap hangs under it.
    const solo = this.topLeft === 'auto' ? s.count <= 1 : this.topLeft === 'timer';
    if (solo !== this.lastSolo) {
      this.lastSolo = solo;
      this.solo.set(solo);
      this.labelText.set(solo ? 'LAP TIME' : 'POSITION');
      this.bigSlash.hidden = solo;
      if (solo) {
        this.bigPad.set('');
        this.bigTotal.set('');
        this.bigWide.set(false);
      }
      // The big number changes meaning: force both variants to repaint.
      this.lastTimeCs = -1;
      this.lastPosition = -1;
    }

    const timeCs = Math.floor(s.lapTime * 100 + 1e-6);
    if (timeCs !== this.lastTimeCs) {
      this.lastTimeCs = timeCs;
      (solo ? this.bigText : this.timeText).set(formatLapTime(s.lapTime));
      this.timeLong.set(timeCs >= TEN_MINUTES_CS);
    }
    if (solo) {
      const bestCs = s.bestLap === null ? -1 : Math.floor(s.bestLap * 100 + 1e-6);
      if (bestCs !== this.lastBestCs) {
        this.lastBestCs = bestCs;
        if (s.bestLap !== null) this.bestText.set(formatLapTime(s.bestLap));
        this.bestLong.set(bestCs >= TEN_MINUTES_CS);
      }
      this.bestChip.set(this.chips && s.bestLap !== null);
      this.timeChip.set(false);
    } else {
      if (s.position !== this.lastPosition || s.count !== this.lastCount) {
        this.lastPosition = s.position;
        const position = String(s.position);
        const count = String(s.count);
        this.bigPad.set(padFor(position, count));
        this.bigText.set(position);
        this.bigTotal.set(count);
        this.bigWide.set(s.count >= 10);
      }
      this.bestChip.set(false);
      this.timeChip.set(this.chips);
    }
    this.lastCount = s.count;

    if (s.lap !== this.lastLap || s.laps !== this.lastLaps) {
      this.lastLap = s.lap;
      this.lastLaps = s.laps;
      // An endless run has no total: just "LAP 7".
      const endless = !Number.isFinite(s.laps);
      const lap = String(s.lap);
      const laps = endless ? '' : String(s.laps);
      this.lapPad.set(padFor(lap, laps));
      this.lapText.set(lap);
      this.lapTotal.set(laps);
      this.lapSlash.hidden = endless;
      this.lapWide.set(!endless && s.laps >= 10);
    }

    if (s.speedKmh !== this.lastSpeed) {
      this.lastSpeed = s.speedKmh;
      this.speedText.set(String(s.speedKmh));
      this.speedWide.set(s.speedKmh >= 100);
    }

    // `> 0` first: it also turns a NaN into an empty bar instead of a value
    // that never equals the last one painted.
    const bar = Math.round((s.bar > 0 ? (s.bar < 1 ? s.bar : 1) : 0) * BAR_STEPS);
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      this.barFill.style.setProperty('--v', String(bar / BAR_STEPS));
    }

    if (s.countdown !== this.lastCountdown) {
      this.lastCountdown = s.countdown;
      this.countOn.set(s.countdown !== null);
      if (s.countdown !== null) {
        this.countGo.set(s.countdown === 0);
        this.countText.set(s.countdown === 0 ? 'GO!' : String(s.countdown));
        // A digit pinned into a tight gap of the picture (chase: between the
        // banner and the rival ahead) grows IN, never past its final size —
        // a 1.5× / 1.9× pop covered both for the first frames.
        const tight = this.countdown.refAspect > 0;
        this.pop(this.countSpan, s.countdown === 0 ? (tight ? 0.7 : 1.9) : tight ? 0.6 : 1.5, s.countdown === 0 ? 1000 : 900);
      }
    }

    this.wrong.set(s.wrongWay && s.phase === 'racing');

    const flash = s.phase === 'finished' ? null : s.flash;
    if (flash) {
      if (flash.seq !== this.lastFlashSeq) {
        this.lastFlashSeq = flash.seq;
        this.flashText.set(flash.text);
        this.flashSub.set(flash.sub);
        this.flashBest.set(flash.kind === 'best-lap');
        this.pop(this.flashEl, 1.25, 320);
      }
      this.flashOn.set(true);
    } else {
      this.flashOn.set(false);
    }

    // Identity first (RaceState keeps one summary object per finish), then
    // content: a snapshot that arrives as a fresh copy every frame — over the
    // network, through structuredClone, from an XR mirror — must not rebuild
    // the card and restart its animation 60 times a second.
    if (s.finish !== this.lastFinishRef) {
      this.lastFinishRef = s.finish;
      if (!sameFinish(s.finish, this.shownFinish)) {
        this.shownFinish = s.finish ? { ...s.finish, lapTimes: s.finish.lapTimes.slice() } : null;
        if (s.finish) this.buildFinish(s.finish);
        this.finishOn.set(s.finish !== null);
        if (s.finish) this.pop(this.finishEl, 1.08, 380, 'translateY(-50%) ');
      }
    }
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  dispose(): void {
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  /** Writes the digit's place (see HudOptions.countdownRefAspect). */
  private placeCountdown(): void {
    const c = this.countdown;
    let k = 1;
    if (c.refAspect > 0) {
      const w = this.root.clientWidth || window.innerWidth;
      const h = this.root.clientHeight || window.innerHeight;
      if (w > 0 && h > 0) k = Math.min(1, w / h / c.refAspect);
    }
    const st = this.root.style;
    st.setProperty('--rhud-count-y', `${(Math.min(1, Math.max(0, 0.5 + (c.y - 0.5) * k)) * 100).toFixed(2)}%`);
    st.setProperty('--rhud-count-x', `${(Math.min(1, Math.max(0, 0.5 + (c.x - 0.5) * k)) * 100).toFixed(2)}%`);
    st.setProperty('--rhud-count-s', String(Math.max(0.1, c.scale * k)));
  }

  /** Scale-in emphasis. Web Animations run on the compositor and need no
   * class juggling to restart; where they are missing the element just
   * appears. */
  private pop(node: HTMLElement, from: number, ms: number, prefix = ''): void {
    if (!this.animate || typeof node.animate !== 'function') return;
    node.animate(
      [
        { transform: `${prefix}scale(${from})`, opacity: 0.2 },
        { transform: `${prefix}scale(1)`, opacity: 1 },
      ],
      { duration: ms, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' },
    );
  }

  private buildFinish(f: FinishSummary): void {
    const body = this.finishBody;
    body.textContent = '';
    el('span', 'rhud-x', el('div', 'rhud-finish-title', body), 'FINISH');
    if (f.count > 1) {
      el('span', 'rhud-x', el('div', 'rhud-finish-place', body), `${ordinal(f.position).toUpperCase()} OF ${f.count}`);
    }
    const total = el('span', 'rhud-x', el('div', 'rhud-finish-total', body));
    el('b', '', total, 'TIME');
    total.appendChild(document.createTextNode(formatLapTime(f.totalTime)));

    const list = el('div', 'rhud-finish-laps', body);
    // A long race would outgrow the card: show the tail, where the finish is.
    const first = Math.max(0, f.lapTimes.length - 6);
    for (let i = first; i < f.lapTimes.length; i++) {
      const rowEl = el('div', i === f.bestLapIndex ? 'rhud-finish-row rhud-best' : 'rhud-finish-row', list);
      el('b', '', rowEl, `LAP ${i + 1}`);
      el('span', '', rowEl, formatLapTime(f.lapTimes[i]));
    }
    if (f.bestLap !== null) {
      el(
        'span',
        'rhud-x',
        el('div', f.newRecord ? 'rhud-finish-record rhud-new' : 'rhud-finish-record', body),
        f.newRecord ? `NEW RECORD  ${formatLapTime(f.bestLap)}` : `TRACK BEST  ${formatLapTime(f.bestLap)}`,
      );
    }
  }
}

/** Invisible digits that bring `value` up to the width of `total`. */
function padFor(value: string, total: string): string {
  return value.length < total.length ? '0'.repeat(total.length - value.length) : '';
}

function sameFinish(a: FinishSummary | null, b: FinishSummary | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.totalTime !== b.totalTime ||
    a.position !== b.position ||
    a.count !== b.count ||
    a.bestLap !== b.bestLap ||
    a.newRecord !== b.newRecord ||
    a.bestLapIndex !== b.bestLapIndex ||
    a.lapTimes.length !== b.lapTimes.length
  ) {
    return false;
  }
  for (let i = 0; i < a.lapTimes.length; i++) if (a.lapTimes[i] !== b.lapTimes[i]) return false;
  return true;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
