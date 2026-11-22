/**
 * Stylesheet of the game menu (MenuView.ts), ported from the reference
 * mockup design-documents/menu-mockups/final.html (spec 1). Class names get
 * the prefix `rmenu-`.
 *
 * UNIT. The mockup writes sizes in `rem` with `html { font-size: min(1.0627vh,
 * 0.68vw) }`. The game must not touch `html`, so sizes are written here as
 * `Nu` and turned into `calc(N * var(--u))` when the sheet is built; `--u` is
 * set on `.rmenu-stage` from container units of `.rmenu` (container-type
 * size, like `.rhud`), so the menu follows its own box (labs embed it in a
 * sized div). Below aspect 5:4 the unit is width-capped harder and the
 * right-hand plates (`.rmenu-aside`) drop out (spec 3.9). The post-race
 * pieces use the HUD's own unit in `em` so they line up with its finish
 * panel.
 *
 * COLOURS repeat the constants of src/ui/Hud.ts (slate, rim, cyan, the
 * yellow record colour, the drop shadow) — keep them in step by hand.
 */

export const MENU_STYLE_ID = 'rmenu-style';

/** `12u` → `calc(12 * var(--u))`; `-1.5u` → `calc(-1.5 * var(--u))`. */
const units = (css: string): string =>
  css.replace(/(?<![\w#.-])(-?(?:\d+\.?\d*|\.\d+))u\b/g, (_m, n: string) => `calc(${n} * var(--u))`);

const SOURCE = `
/* ───────── root, stage, unit ───────── */
.rmenu {
  position: absolute; inset: 0; overflow: hidden; z-index: 6;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  container-type: size;
  --rmenu-in-t: 0px; --rmenu-in-r: 0px; --rmenu-in-b: 0px; --rmenu-in-l: 0px;
  --rmenu-hud-scale: 1;
}
.rmenu.rmenu-fixed { position: fixed; }
.rmenu[hidden] { display: none; }
.rmenu.rmenu-nocursor { pointer-events: auto; cursor: none; }
.rmenu.rmenu-nocursor * { cursor: none !important; }
.rmenu-tint { position: absolute; inset: 0; display: none; }
.rmenu-tint.rmenu-pause { display: block; background: rgba(11, 20, 28, 0.38); }
.rmenu-tint.rmenu-post { display: block; background: rgba(11, 20, 28, 0.16); }
.rmenu-stage {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + var(--rmenu-in-t));
  right: calc(env(safe-area-inset-right, 0px) + var(--rmenu-in-r));
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--rmenu-in-b));
  left: calc(env(safe-area-inset-left, 0px) + var(--rmenu-in-l));
  /* 1u = the HUD's 1/94.1 of the height, capped by the width so band +
     plates fit down to 3:2. */
  --u: min(1.0627cqh, 0.68cqw);
  /* the smallest caption: never under 13 CSS px */
  --cap: max(2.05u, 13px);
  /* below ~600 px of height that floor outgrows the unit: the default band,
     the title rows and the car spec sheet widen with it (21 ≈ the title
     row's text width in u / 2.05), so RACE's sub-line and the sheet's notes
     still fit at 800 × 500; 0 from ~640 px of height up */
  --grow: calc((var(--cap) - 2.05u) * 21);
  /* Hud.ts colours */
  --slate: #141e27; --ink: #0b141c; --rim: #aebbc2; --cyan: #14e8f6; --yellow: #ffe14a;
  --pink: #ff8e98; --cream: #fff6dc; --cobalt: #2b4fc4;
  --skew: -10deg; --unskew: 10deg;
  /* 1em = 1u, as the mockup's html: line boxes get the same strut */
  font-size: 1u;
  font-family: system-ui, -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-weight: 900; font-style: italic; line-height: 1; white-space: nowrap; color: #fff;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  -webkit-font-smoothing: antialiased;
  text-shadow: 0.035em 0.055em 0 rgba(8, 14, 20, 0.6), 0 0.09em 0.22em rgba(8, 14, 20, 0.35);
}
@container (max-aspect-ratio: 5/4) {
  .rmenu-stage { --u: min(1.0627cqh, 1.5cqw); }
}
.rmenu-t { display: inline-block; transform: skewX(var(--unskew)); }

/* ───────── the band: one slanted slate slab from the left edge ───────── */
.rmenu-band {
  position: absolute; top: 0; bottom: 0; left: -12u; width: calc(68u + var(--grow)); box-sizing: border-box;
  transform: skewX(var(--skew)); transform-origin: 0 100%;
  background: linear-gradient(90deg, rgba(20, 30, 39, 0.97), rgba(20, 30, 39, 0.95) 60%, rgba(20, 30, 39, 0.9));
  border-right: 1u solid var(--yellow);
  box-shadow: 1u 0 0 rgba(11, 20, 28, 0.55), 1.5u 0 0 var(--cyan), 3u 0 3u rgba(11, 20, 28, 0.35);
  pointer-events: auto;
  --cap: max(2.05u, 13px);
  font-size: 1u;
}
.rmenu-band.rmenu-wide { width: 78u; }
.rmenu-band.rmenu-slim { width: 59u; }
.rmenu-band > * { position: absolute; left: 16u; }

/* ───────── logo ───────── */
.rmenu-logo { top: 5u; }
.rmenu-logo .rmenu-web { font-size: 4.4u; letter-spacing: 0.34em; color: var(--yellow); margin-left: 0.5u; }
.rmenu-logo .rmenu-racer {
  display: block; font-size: 11.6u; letter-spacing: -0.01em; margin-top: 0.3u; color: #fff;
  -webkit-text-stroke: 0.11em var(--ink); paint-order: stroke fill;
  text-shadow: 0.055em 0.06em 0 var(--cyan), 0.1em 0.11em 0 var(--ink);
}
.rmenu-checker {
  width: 37u; height: 2u; margin-top: 1.3u; border-radius: 0.3u;
  background: conic-gradient(#fff 25%, var(--ink) 0 50%, #fff 0 75%, var(--ink) 0) 0 0 / 2u 2u;
  box-shadow: 0.35u 0.35u 0 rgba(8, 14, 20, 0.5);
}
.rmenu-tagline { font-size: var(--cap); letter-spacing: 0.3em; margin-top: 1.4u; color: #e9edef; font-weight: 800; }

/* ───────── heading of the sub screens ───────── */
.rmenu-head { top: 5.2u; }
.rmenu-crumb { font-size: var(--cap); letter-spacing: 0.2em; color: var(--cyan); font-weight: 800; }
.rmenu-head .rmenu-h {
  display: block; font-size: 6.4u; margin-top: 0.9u;
  -webkit-text-stroke: 0.09em var(--ink); paint-order: stroke fill;
  text-shadow: 0.05em 0.06em 0 var(--cyan), 0.09em 0.1em 0 var(--ink);
}
.rmenu-head.rmenu-big .rmenu-h { font-size: 9.2u; }
.rmenu-head .rmenu-say {
  display: block; font-size: max(2.3u, 13px); font-weight: 800; line-height: 1.4; margin-top: 1.6u; color: #e9edef;
  white-space: normal; width: 38u;
}

/* ───────── rows ───────── */
.rmenu-list { margin: 0; padding: 0; width: 41u; }
/* 48.3u (final.html: 48.5u) keeps the focused RACE plate inside the band's yellow edge */
.rmenu-titlelist { top: 35u; width: calc(48.3u + var(--grow)); }
.rmenu-row {
  -webkit-appearance: none; appearance: none; font: inherit; color: inherit; letter-spacing: inherit;
  text-shadow: inherit; text-align: left; line-height: inherit; outline: none; cursor: pointer;
  pointer-events: auto; width: 100%; margin: 0 0 1u 0;
  position: relative; height: 6.2u; box-sizing: border-box;
  display: flex; align-items: center; justify-content: space-between; gap: 1.2u; padding: 0 2.2u 0 2.6u;
  border-radius: 1.3u; background: rgba(174, 187, 194, 0.13);
  border: 0.18u solid rgba(174, 187, 194, 0.55);
}
.rmenu-row .rmenu-l { font-size: 3.1u; letter-spacing: 0.03em; }
.rmenu-row .rmenu-v {
  font-size: var(--cap); letter-spacing: 0.07em; color: var(--cyan); font-weight: 800;
  display: inline-flex; align-items: center; gap: 0.9u; margin-left: auto;
}
.rmenu-row .rmenu-cap { font-size: var(--cap); letter-spacing: 0.07em; color: var(--cyan); font-weight: 800; }
/* label + caption + tags; a row whose text does not fit stacks them (MenuView fit pass) */
.rmenu-lab { display: inline-flex; align-items: center; gap: 1.2u; flex: none; }
.rmenu-row.rmenu-stack .rmenu-lab { flex-direction: column; align-items: flex-start; justify-content: center; gap: 0.35u; }
.rmenu-row.rmenu-stack .rmenu-lab .rmenu-tag { padding-top: 0.25u; padding-bottom: 0.25u; }
/* last resort before smaller type: less padding, tighter spacing */
.rmenu-row.rmenu-snug { padding-left: 1.7u; padding-right: 1.2u; }
.rmenu-row.rmenu-snug [data-fit] { letter-spacing: 0; word-spacing: -0.08em; }
.rmenu-row .rmenu-staged { color: var(--yellow); }
.rmenu-row.rmenu-primary { height: 11.4u; border-radius: 1.8u; margin-bottom: 1.4u; }
.rmenu-row.rmenu-primary { flex-direction: column; align-items: stretch; justify-content: center; gap: 0.8u; }
.rmenu-row.rmenu-primary .rmenu-top { display: flex; align-items: center; justify-content: space-between; }
.rmenu-row.rmenu-primary .rmenu-l { font-size: 6.2u; }
.rmenu-row .rmenu-sub { font-size: var(--cap); letter-spacing: 0.02em; font-weight: 800; color: var(--cyan); display: inline-flex; align-items: center; gap: 0.9u; }
.rmenu-row.rmenu-primary .rmenu-sub { align-self: flex-start; }
.rmenu-row.rmenu-danger .rmenu-l { color: var(--pink); }
.rmenu-row.rmenu-dim { opacity: 0.45; cursor: default; }
.rmenu-row.rmenu-go { border-color: var(--yellow); height: 8u; margin-top: 2.2u; }
.rmenu-row.rmenu-go .rmenu-l { color: var(--yellow); font-size: 3.7u; }
.rmenu-row.rmenu-go .rmenu-v { color: #fff; }
.rmenu-row .rmenu-lines { display: block; text-align: right; line-height: 1.35; }
.rmenu-row .rmenu-lines > span { display: block; }
/* FOCUS: the one look, on every kind of row */
.rmenu-row.rmenu-focus {
  background: var(--yellow); border: 0.34u solid #fff; color: var(--ink); text-shadow: none;
  transform: translateX(2.6u);
  box-shadow: 0.7u 0.7u 0 rgba(8, 14, 20, 0.6);
}
.rmenu-row.rmenu-focus .rmenu-l, .rmenu-row.rmenu-focus .rmenu-v, .rmenu-row.rmenu-focus .rmenu-sub,
.rmenu-row.rmenu-focus .rmenu-cap, .rmenu-row.rmenu-focus .rmenu-staged { color: var(--ink); }
.rmenu-row.rmenu-focus::before {
  content: ''; position: absolute; left: -4.2u; top: 50%; width: 2.2u; height: 2.8u; margin-top: -1.4u;
  background: var(--yellow); clip-path: polygon(0 0, 100% 50%, 0 100%); filter: drop-shadow(0.3u 0.3u 0 rgba(8, 14, 20, 0.6));
}
@media (forced-colors: active) { .rmenu-row:focus { outline: 3px solid Highlight; } }
.rmenu-ar { display: inline-block; width: 1.3u; height: 1.8u; background: currentColor; clip-path: polygon(0 0, 100% 50%, 0 100%); flex: none; }
.rmenu-ar.rmenu-left { clip-path: polygon(100% 0, 0 50%, 100% 100%); }
.rmenu-ar.rmenu-arbig { width: 2.6u; height: 3.6u; }
.rmenu-chev { display: inline-flex; gap: 0.5u; }

/* value widgets inside a row (as in final.html, ".rmenu-row .rmenu-v" wins over the
   widgets' own gap / colour: segments and arrows sit 0.9u apart, stepper arrows are cyan) */
.rmenu-seg { display: inline-flex; gap: 0.5u; }
.rmenu-seg b {
  font-size: max(2.3u, 13px); letter-spacing: 0.04em; padding: 0.7u 0.95u; border-radius: 0.9u;
  border: 0.2u solid transparent; color: rgba(255, 255, 255, 0.62); font-weight: 900;
}
.rmenu-seg b.rmenu-sel { color: var(--cyan); border-color: var(--cyan); background: rgba(20, 232, 246, 0.14); }
.rmenu-row.rmenu-focus .rmenu-seg b { color: rgba(11, 20, 28, 0.62); }
.rmenu-row.rmenu-focus .rmenu-seg b.rmenu-sel { color: #fff; background: var(--ink); border-color: var(--ink); }
.rmenu-step { display: inline-flex; align-items: center; gap: 1.4u; color: #fff; }
.rmenu-step b { font-size: 3.4u; min-width: 5.6u; text-align: center; color: var(--cyan); }
.rmenu-step b.rmenu-word { font-size: max(2.4u, 13px); min-width: 0; }
.rmenu-step b.rmenu-entry { text-decoration: underline; text-decoration-thickness: 0.08em; text-underline-offset: 0.12em; }
.rmenu-step .rmenu-ar { opacity: 0.4; }
.rmenu-step .rmenu-ar.rmenu-off { opacity: 0.12; }
.rmenu-row.rmenu-focus .rmenu-step { color: var(--ink); }
.rmenu-row.rmenu-focus .rmenu-step b { color: var(--ink); }
.rmenu-row.rmenu-focus .rmenu-step .rmenu-ar { opacity: 1; width: 1.7u; height: 2.4u; }
.rmenu-row.rmenu-focus .rmenu-step .rmenu-ar.rmenu-off { opacity: 0.25; }
.rmenu-pips { display: inline-flex; gap: 0.34u; }
.rmenu-pips i { width: 1u; height: 2.1u; border-radius: 0.25u; background: rgba(174, 187, 194, 0.3); transform: skewX(var(--skew)); }
.rmenu-pips i.rmenu-on { background: var(--cyan); }
.rmenu-row.rmenu-focus .rmenu-pips i { background: rgba(11, 20, 28, 0.22); }
.rmenu-row.rmenu-focus .rmenu-pips i.rmenu-on { background: var(--ink); }
.rmenu-row .rmenu-num { font-size: 2.6u; min-width: 3.4u; text-align: right; font-weight: 900; }
.rmenu-tag {
  font-size: max(1.5u, 11px); letter-spacing: 0.08em; padding: 0.4u 0.8u; border-radius: 0.5u;
  font-weight: 900; font-style: italic; text-shadow: none; flex: none;
}
.rmenu-tag.rmenu-was, .rmenu-tag.rmenu-new, .rmenu-tag.rmenu-chosen { background: var(--yellow); color: var(--ink); }
.rmenu-row.rmenu-focus .rmenu-tag.rmenu-was, .rmenu-row.rmenu-focus .rmenu-tag.rmenu-new { background: var(--ink); color: var(--yellow); }
.rmenu-tag.rmenu-live { border: 0.16u solid var(--cyan); color: var(--cyan); }
.rmenu-row.rmenu-focus .rmenu-tag.rmenu-live { border-color: var(--ink); color: var(--ink); }
.rmenu-swatch {
  display: inline-block; width: 1.7u; height: 1.7u; border-radius: 50%;
  border: 0.16u solid #fff; flex: none;
}

/* ───────── help line + prompts ───────── */
.rmenu-band > .rmenu-help {
  top: auto; bottom: 9.6u; left: 17u; font-size: var(--cap); font-weight: 800; font-style: italic;
  letter-spacing: 0.03em; color: #cfd8dd;
}
.rmenu-hints { display: flex; gap: 2.1u; align-items: center; font-size: var(--cap); letter-spacing: 0.07em; font-weight: 800; }
.rmenu-band > .rmenu-hints { top: auto; bottom: 3.4u; left: 15.6u; }
.rmenu-hints.rmenu-tight { gap: 1.3u; letter-spacing: 0.04em; }
.rmenu-hints.rmenu-tight .rmenu-prompt { gap: 0.6u; }
.rmenu-prompt {
  -webkit-appearance: none; appearance: none; background: none; border: 0; padding: 0; margin: 0;
  font: inherit; color: inherit; letter-spacing: inherit; text-shadow: inherit; line-height: inherit;
  display: inline-flex; align-items: center; gap: 0.8u; cursor: pointer; pointer-events: auto; outline: none;
}
.rmenu-g { display: inline-flex; flex: none; }
.rmenu-g svg { width: 3.5u; height: 3.5u; display: block; }
.rmenu-g.rmenu-pill, .rmenu-g.rmenu-key {
  box-sizing: border-box; height: 3.1u; min-width: 3.4u; padding: 0 0.9u; align-items: center; justify-content: center;
  border-radius: 0.9u 0.9u 0.55u 0.55u; background: #0f171f; box-shadow: inset 0 0 0 0.2u #dfe7ec;
  font-size: max(1.6u, 11px); font-style: normal; font-weight: 900; letter-spacing: 0.04em; color: #fff; text-shadow: none;
}
.rmenu-g.rmenu-pill.rmenu-opt { border-radius: 1.6u; font-size: max(1.3u, 11px); }
.rmenu-g.rmenu-key { border-radius: 0.6u; background: #eef3f6; color: #16212b; box-shadow: inset 0 -0.32u 0 #b9c5cd; padding-bottom: 0.25u; }
.rmenu-g + .rmenu-g { margin-left: -0.3u; }

/* ───────── free plates on the right: the HUD plate ───────── */
.rmenu-plate { position: absolute; }
.rmenu-plate::before {
  content: ''; position: absolute; inset: 0; transform: skewX(var(--skew)); border-radius: 1.8u;
  background: var(--slate); border: max(1px, 0.18u) solid var(--rim); opacity: 0.88;
}
.rmenu-plate.rmenu-sheet::before { transform: skewX(-4deg); border-radius: 2.2u; }
.rmenu-plate > * { position: relative; }
.rmenu-kicker { font-size: var(--cap); letter-spacing: 0.2em; color: var(--cyan); font-weight: 800; }
.rmenu-chips { display: flex; gap: 0.9u; }
.rmenu-chip {
  font-size: var(--cap); letter-spacing: 0.06em; padding: 0.7u 1.3u; border-radius: 0.8u;
  background: rgba(174, 187, 194, 0.18); border: 0.14u solid rgba(174, 187, 194, 0.5); transform: skewX(var(--skew));
}
.rmenu-chip > b { display: inline-block; transform: skewX(var(--unskew)); font-weight: 800; }
.rmenu-sticker {
  position: absolute; font-size: max(2.2u, 13px); letter-spacing: 0.06em; line-height: 1.25; text-align: center;
  padding: 1.1u 1.9u; border-radius: 1.1u; background: var(--yellow); color: var(--ink); text-shadow: none;
  border: 0.3u solid #fff; transform: rotate(5deg); box-shadow: 0.5u 0.6u 0 rgba(8, 14, 20, 0.6);
}
.rmenu-sticker small { display: block; font-size: max(1.5u, 11px); letter-spacing: 0.1em; font-weight: 800; }
svg.rmenu-map { display: block; overflow: visible; }

/* title: next-race plate */
.rmenu-next { right: 4.5u; bottom: 3.6u; width: 62u; height: 16.6u; }
.rmenu-next .rmenu-in {
  display: grid; grid-template-columns: 13.5u minmax(0, 1fr) auto; column-gap: 2u; align-items: center; height: 100%;
  padding: 0 4.4u 0 4.6u; box-sizing: border-box;
}
.rmenu-next svg.rmenu-map { width: 13.5u; height: 13.5u; }
.rmenu-next .rmenu-big { font-size: 4.6u; margin-top: 0.8u; }
.rmenu-next .rmenu-len { font-size: var(--cap); letter-spacing: 0.1em; font-weight: 800; margin-top: 0.9u; color: #e9edef; }
.rmenu-next .rmenu-best { text-align: right; }
.rmenu-next .rmenu-best b { display: block; font-size: 3.4u; color: var(--yellow); margin-top: 0.8u; }
.rmenu-next .rmenu-best b.rmenu-none { color: #e9edef; }
.rmenu-next .rmenu-big.rmenu-new { color: var(--yellow); }
.rmenu-unlock { position: absolute; right: 4.6u; top: 3.4u; }
.rmenu-unlock .rmenu-chip { display: block; background: rgba(20, 30, 39, 0.82); }

/* ───────── CAR ───────── */
.rmenu-cars { top: 23u; width: 48u; }
.rmenu-row.rmenu-car-row { height: 8.8u; justify-content: flex-start; padding-left: 1.8u; gap: 1.8u; }
.rmenu-paintchip {
  width: 6.2u; height: 5.2u; border-radius: 0.9u; border: 0.26u solid rgba(255, 255, 255, 0.85);
  box-sizing: border-box; flex: none;
}
.rmenu-car-row .rmenu-n { font-size: 3u; display: block; }
.rmenu-car-row .rmenu-s { font-size: var(--cap); letter-spacing: 0.1em; color: var(--cyan); display: block; margin-top: 0.75u; font-weight: 800; }
.rmenu-row.rmenu-car-row.rmenu-focus .rmenu-s { color: #33414c; }
/* anchored by the bottom: a tag at its 11 px floor grows upward, not over the name */
.rmenu-car-row .rmenu-tags { position: absolute; right: 1.6u; bottom: calc(100% - 1.1u); display: flex; gap: 0.6u; }
.rmenu-car-row .rmenu-tag.rmenu-live { background: var(--slate); }
.rmenu-row.rmenu-car-row.rmenu-focus .rmenu-tag.rmenu-live { background: var(--yellow); }
.rmenu-row.rmenu-car-row.rmenu-focus .rmenu-paintchip { border-color: var(--ink); }
.rmenu-namecard { position: absolute; right: 7u; top: 3.6u; text-align: right; transform: rotate(-2.4deg); z-index: 2; }
.rmenu-namecard .rmenu-name {
  font-size: 8.4u; -webkit-text-stroke: 0.1em var(--ink); paint-order: stroke fill;
  text-shadow: 0.05em 0.06em 0 var(--yellow), 0.09em 0.1em 0 var(--ink);
}
.rmenu-badge {
  display: inline-block; font-size: max(2.3u, 13px); letter-spacing: 0.08em; padding: 0.9u 1.8u; border-radius: 1u;
  background: var(--cyan); color: var(--ink); text-shadow: none; transform: rotate(4deg) skewX(var(--skew));
  box-shadow: 0.5u 0.5u 0 rgba(8, 14, 20, 0.55); border: 0.28u solid #fff; margin-top: 0.6u;
}
.rmenu-badge b { display: inline-block; transform: skewX(var(--unskew)); }
/* min-height, not height: at the 13 px floor (small windows) the note needs more room */
.rmenu-spec { right: 3.6u; top: 21u; width: calc(37u + var(--grow)); min-height: 66u; }
.rmenu-spec .rmenu-in { padding: 3u 3u 2u 3.4u; }
.rmenu-spec .rmenu-desc { font-size: max(2.2u, 13px); font-weight: 800; line-height: 1.38; white-space: normal; color: #e9edef; }
.rmenu-stats { margin-top: 2.6u; border-top: 0.16u solid rgba(174, 187, 194, 0.5); padding-top: 2.2u; }
.rmenu-stat {
  display: flex; align-items: center; justify-content: space-between; font-size: var(--cap);
  letter-spacing: 0.1em; margin-bottom: 1.5u; font-weight: 800;
}
.rmenu-stat .rmenu-pips i { width: 2.7u; height: 1.8u; }
.rmenu-paint { margin-top: 1.2u; border-top: 0.16u solid rgba(174, 187, 194, 0.5); padding-top: 2.2u; }
.rmenu-paint .rmenu-kicker { display: flex; justify-content: space-between; }
.rmenu-paint .rmenu-kicker b { color: #fff; font-weight: 900; }
.rmenu-paints { display: flex; gap: 1u; margin-top: 1.4u; align-items: center; justify-content: space-between; }
.rmenu-paints i.rmenu-p {
  width: 5.6u; height: 4.4u; border-radius: 0.9u; transform: skewX(var(--skew));
  border: 0.26u solid rgba(255, 255, 255, 0.55); box-sizing: border-box; pointer-events: auto; cursor: pointer; flex: none;
}
.rmenu-paints i.rmenu-p.rmenu-sel { border: 0.4u solid var(--cyan); box-shadow: 0 0 0 0.3u var(--ink), 0 0 0 0.52u var(--cyan); }
.rmenu-paints .rmenu-ar { color: #fff; opacity: 0.8; pointer-events: auto; cursor: pointer; }
.rmenu-paints .rmenu-ar.rmenu-off { opacity: 0.2; }
.rmenu-pname { font-size: 2.8u; margin-top: 1.4u; text-align: center; }
.rmenu-spec .rmenu-note {
  font-size: var(--cap); font-weight: 800; letter-spacing: 0.06em; line-height: 1.4; white-space: normal;
  color: #cfd8dd; margin-top: 2.4u;
}
.rmenu-spec .rmenu-note b, .rmenu-tips b { color: var(--yellow); font-weight: 900; }

/* ───────── SETUP / SETTINGS ───────── */
.rmenu-fields { top: 20.6u; width: 57u; }
.rmenu-ticket { right: 5.5u; top: 9u; width: 52u; height: 72u; }
.rmenu-ticket .rmenu-in { padding: 3.4u 3.6u 0 6.4u; }
.rmenu-ticket .rmenu-big { font-size: 6.2u; margin-top: 1u; }
.rmenu-ticket .rmenu-big.rmenu-new { color: var(--yellow); }
.rmenu-ticket svg.rmenu-map { width: 41u; height: 41u; margin: 1.4u 0 0 -0.6u; }
.rmenu-ticket .rmenu-chips { margin-top: 1.8u; margin-left: -1.6u; flex-wrap: wrap; width: 44u; }
/* anchored by the bottom, above the kicker's line: a sticker grown by the 11 px
   floor of its sub-line grows upward and cannot cover TRACK PREVIEW */
.rmenu-ticket .rmenu-sticker { right: -1.6u; bottom: calc(100% - 3.2u); }

/* ───────── CONTROLS ───────── */
.rmenu-tips { top: 21.5u; width: 42u; margin: 0; padding: 0; list-style: none; }
.rmenu-tips li {
  font-size: max(2.3u, 13px); font-weight: 800; line-height: 1.36; white-space: normal; color: #e9edef;
  margin-bottom: 2.2u; padding-left: 3.2u; position: relative;
}
.rmenu-tips li::before {
  content: ''; position: absolute; left: 0; top: 0.7u; width: 1.4u; height: 1.8u; background: var(--cyan);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}
.rmenu-tips li > .rmenu-t { display: block; }
.rmenu-sheetc { right: 5u; top: 11u; width: 82u; height: 66u; }
.rmenu-sheetc .rmenu-in { padding: 3.2u 4.4u 0 6.6u; }
.rmenu-ctl {
  display: grid; grid-template-columns: 1.25fr 1fr 1fr; align-items: center; height: 6.9u;
  border-top: 0.14u solid rgba(174, 187, 194, 0.32); font-size: 2.8u;
}
.rmenu-ctl.rmenu-hd { height: 4.6u; border-top: 0; }
.rmenu-ctl.rmenu-hd span { font-size: var(--cap); letter-spacing: 0.2em; color: var(--cyan); font-weight: 800; }
.rmenu-ctl > span { display: inline-flex; align-items: center; gap: 0.7u; }
.rmenu-ctl small, .rmenu-ctlb small { font-size: var(--cap); font-weight: 800; letter-spacing: 0.06em; opacity: 0.75; margin-left: 0.5u; }
.rmenu-ctl small:first-child, .rmenu-ctlb small:first-child { margin-left: 0; }
.rmenu-ctl .rmenu-g svg { width: 4.2u; height: 4.2u; }
.rmenu-ctl .rmenu-g.rmenu-pill, .rmenu-ctl .rmenu-g.rmenu-key { height: 3.8u; min-width: 4u; font-size: max(1.9u, 12px); }
.rmenu-ctl .rmenu-g.rmenu-pill.rmenu-opt { font-size: max(1.5u, 11px); }
.rmenu-ctl .rmenu-g + .rmenu-g, .rmenu-ctlb .rmenu-g + .rmenu-g { margin-left: 0; }
/* below 5:4 the sheet moves into the band as two-line rows */
.rmenu-ctlb { top: 20.4u; width: 48u; display: none; }
.rmenu-ctlb-row { height: 8.2u; box-sizing: border-box; padding-top: 1.1u; border-top: 0.14u solid rgba(174, 187, 194, 0.32); }
.rmenu-ctlb-row:first-child { border-top: 0; }
.rmenu-ctlb-row .rmenu-a { display: block; font-size: 2.5u; }
.rmenu-ctlb-row .rmenu-k { display: flex; align-items: center; gap: 0.7u; margin-top: 0.8u; }
.rmenu-ctlb-row .rmenu-sep { width: 0.16u; height: 2.6u; background: rgba(174, 187, 194, 0.45); margin: 0 1u; flex: none; }
.rmenu-ctlb .rmenu-g svg { width: 3.3u; height: 3.3u; }

/* ───────── PAUSE / CONFIRM ───────── */
.rmenu-pause-list { top: 24u; width: 39u; }
.rmenu-pause-list .rmenu-row { height: 5.9u; margin-bottom: 0.9u; }
.rmenu-pause-list .rmenu-row .rmenu-l { font-size: 2.9u; }
.rmenu-confirm-list { top: 44u; width: 39u; }
.rmenu-confirm-list .rmenu-row { height: 7.4u; }

/* ───────── POST: medal + action stack in the HUD's own unit (em) ───────── */
.rmenu-post {
  position: absolute; inset: 0;
  font-size: calc(min(1.0627cqh, 1.5625cqw) * var(--rmenu-hud-scale));
}
.rmenu-medal {
  position: absolute; left: calc(50% - 35.5em); top: calc(50% - 25em); width: 17em; height: 17em; border-radius: 50%;
  background: radial-gradient(circle at 50% 42%, #3d66de, var(--cobalt) 70%); border: 1em solid var(--cream);
  box-shadow: 0 0 0 0.36em var(--ink), 0.7em 0.9em 0 rgba(8, 14, 20, 0.55); transform: rotate(-9deg);
  display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;
}
.rmenu-medal b {
  font-size: 7em; color: var(--yellow); -webkit-text-stroke: 0.09em var(--ink); paint-order: stroke fill;
  text-shadow: 0.05em 0.06em 0 var(--ink);
}
.rmenu-medal b sup { font-size: 0.42em; vertical-align: 0.9em; margin-left: 0.05em; }
.rmenu-medal span { font-size: max(1.7em, 13px); letter-spacing: 0.18em; margin-top: 0.2em; }
.rmenu-medal.rmenu-gold { background: radial-gradient(circle at 50% 42%, #f2b824, #d99a12 70%); }
.rmenu-medal.rmenu-gold b { color: var(--ink); -webkit-text-stroke: 0; text-shadow: 0.05em 0.06em 0 rgba(255, 246, 220, 0.55); }
.rmenu-medal.rmenu-gold span { color: var(--ink); text-shadow: none; }
.rmenu-actions {
  position: absolute; left: min(calc(50% + 28.5em), calc(100% - 41em)); top: 50%; width: 34em; margin: 0; padding: 0;
  transform: translateY(-50%) skewX(var(--skew));
}
.rmenu-actions .rmenu-row {
  font-size: 1em; height: 7.4em; margin: 0 0 1.1em 0; border-radius: 1.3em; border-width: 0.18em;
  padding: 0 2em 0 2.4em; background: rgba(20, 30, 39, 0.88); border-color: var(--rim);
  flex-direction: column; align-items: flex-start; justify-content: center; gap: 0;
}
.rmenu-actions .rmenu-row .rmenu-l { font-size: 3.1em; }
.rmenu-actions .rmenu-row .rmenu-sub { font-size: max(1.85em, 13px); margin: 0.6em 0 0; letter-spacing: 0.07em; gap: 0.5em; }
.rmenu-actions .rmenu-row .rmenu-swatch { width: 0.92em; height: 0.92em; border-width: 0.09em; }
/* the fit pass's snug step for post rows (a 13 px caption in a small window) */
.rmenu-actions .rmenu-row.rmenu-snug { padding-left: 1.7em; padding-right: 1.2em; }
.rmenu-actions .rmenu-row.rmenu-snug .rmenu-sub { letter-spacing: 0; word-spacing: -0.08em; }
.rmenu-actions .rmenu-row.rmenu-primary { height: 9.6em; }
.rmenu-actions .rmenu-row.rmenu-primary .rmenu-l { font-size: 4.3em; }
.rmenu-actions .rmenu-row.rmenu-focus {
  background: var(--yellow); border: 0.34em solid #fff; transform: translateX(2.2em); box-shadow: 0.7em 0.7em 0 rgba(8, 14, 20, 0.6);
}
.rmenu-actions .rmenu-row.rmenu-focus::before { left: -4em; width: 2.2em; height: 2.8em; margin-top: -1.4em; filter: drop-shadow(0.3em 0.3em 0 rgba(8, 14, 20, 0.6)); }
.rmenu-float-hints { position: absolute; left: 0; right: 0; bottom: 3.2u; display: flex; justify-content: center; }
.rmenu-float-hints .rmenu-hints { padding: 1u 2.4u; border-radius: 1.2u; background: rgba(20, 30, 39, 0.86); pointer-events: auto; }

/* ───────── narrow / portrait: the band is the page, right-hand plates drop out ───────── */
/* controls: below 5:3 the 82u sheet would run under the band — the sheet
   moves into the band as two-line rows (and the tips drop) */
@container (max-aspect-ratio: 5/3) {
  .rmenu-sheetc { display: none !important; }
  .rmenu-tips { display: none; }
  .rmenu-ctlb { display: block; }
}
@container (max-aspect-ratio: 5/4) {
  .rmenu-aside { display: none !important; }
  .rmenu-band.rmenu-slim { width: 68u; }
  /* the 78u band of setup / settings: a smaller unit keeps its rows on screen
     in portrait windows (the slant pushes the upper rows right) */
  .rmenu-band.rmenu-wide { --u: min(1.0627cqh, 1.2cqw); --cap: max(2.05u, 13px); }
  /* the car rows: the top (focused, shifted) row sat ~9 px past a 620 px
     window's edge at 1.5cqw */
  .rmenu-band.rmenu-carband { --u: min(1.0627cqh, 1.4cqw); --cap: max(2.05u, 13px); }
  /* the sound chip: top of the band, above the logo */
  .rmenu-unlock { right: auto; left: 20u; top: 1.2u; }
  .rmenu-tips { display: none; }
  .rmenu-ctlb { display: block; }
  .rmenu-actions {
    left: 50%; top: auto; bottom: 10em; width: 60em; margin-left: -30em; transform: skewX(var(--skew));
    display: grid; grid-template-columns: 1fr 1fr; gap: 1em;
  }
  .rmenu-actions .rmenu-row.rmenu-focus { transform: none; }
  .rmenu-actions .rmenu-row, .rmenu-actions .rmenu-row.rmenu-primary { height: 8em; margin: 0; }
  .rmenu-actions .rmenu-row.rmenu-primary .rmenu-l { font-size: 3.1em; }
}

/* ───────── motion (root class rmenu-anim; never under reduced motion) ───────── */
@keyframes rmenu-band-in { from { transform: translateX(-100%) skewX(var(--skew)); } to { transform: skewX(var(--skew)); } }
@keyframes rmenu-band-out { from { transform: skewX(var(--skew)); } to { transform: translateX(-105%) skewX(var(--skew)); } }
@keyframes rmenu-row-in { from { opacity: 0; translate: 0 1.2u; } to { opacity: 1; translate: 0 0; } }
@keyframes rmenu-pop { from { scale: 1.15; } to { scale: 1; } }
@keyframes rmenu-fade { from { opacity: 0; } to { opacity: 1; } }
.rmenu-anim .rmenu-band { transition: width 180ms ease-out; }
.rmenu-anim .rmenu-band.rmenu-in { animation: rmenu-band-in 220ms ease-out both; }
.rmenu-anim .rmenu-band.rmenu-out { animation: rmenu-band-out 180ms ease-in both; }
.rmenu-anim .rmenu-fresh .rmenu-row { animation: rmenu-row-in 200ms ease-out both; animation-delay: calc(var(--rmenu-i, 0) * 30ms); }
.rmenu-anim .rmenu-row { transition: transform 90ms ease-out; }
.rmenu-anim .rmenu-sticker { animation: rmenu-pop 200ms ease-out both; }
.rmenu-anim .rmenu-post.rmenu-fresh, .rmenu-anim .rmenu-float-hints.rmenu-fresh { animation: rmenu-fade 250ms ease-out both; }
.rmenu-anim .rmenu-aside.rmenu-fresh { animation: rmenu-fade 220ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .rmenu *, .rmenu *::before { animation: none !important; transition: none !important; }
}
`;

/** The finished stylesheet text. */
export const MENU_CSS = units(SOURCE);

/** Put the menu stylesheet into the document once. */
export function injectMenuCss(doc: Document = document): void {
  if (doc.getElementById(MENU_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = MENU_STYLE_ID;
  style.textContent = MENU_CSS;
  doc.head.appendChild(style);
}
