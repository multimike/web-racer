import type {
  MenuAside,
  MenuButton,
  MenuCarAside,
  MenuControlPart,
  MenuControlsAside,
  MenuInsets,
  MenuMedalAside,
  MenuNextRaceAside,
  MenuPaint,
  MenuPointerAction,
  MenuPrompt,
  MenuRichText,
  MenuRow,
  MenuRowId,
  MenuScreenId,
  MenuSnapshot,
  MenuTag,
  MenuTicketAside,
  MenuTrackInfo,
  MenuValue,
  MenuView,
  MenuViewOptions,
} from '../../game/contracts/menu';
import { glyphHtml, keycapHtml } from './glyphs';
import { injectMenuCss } from './menuCss';

/**
 * DOM renderer of a `MenuSnapshot` (spec sections 1, 3, 3.9, 11; the picture
 * is design-documents/menu-mockups/final.html). A pure view: it never changes
 * menu state. Pointer clicks, pointer moves over rows and Tab focus go back
 * through `options.onPointer` as `MenuPointerAction`s; the keyboard and pads
 * are read by `MenuInput` on the window.
 *
 * DOM: `.rmenu` (fixed overlay, z-index 6, container for the unit) → tint →
 * `.rmenu-stage` (insets, unit, type) → the slanted BAND with logo / heading,
 * the row list, help line and prompt bar (every screen but post), the
 * right-hand ASIDE plates, the sound chip, and for post the HUD-unit medal +
 * action stack + a floating prompt pill.
 *
 * UPDATES: `render(snapshot)` is a no-op for the object drawn last. A new
 * `serial` (or a different row / aside structure) rebuilds the screen; any
 * other change patches: the focus class moves (so the 90 ms focus transform
 * can play), rows whose data changed are refilled, heading / help / prompts /
 * aside are replaced when their text changed.
 *
 * ACCESSIBILITY: root `role="dialog" aria-modal="true" aria-label`; the list
 * `role="group"`; action / link / car rows are `<button>`s, choice rows
 * `role="radiogroup"` with `role="radio"` segments, steppers / sliders (and
 * the pause CAMERA `◂ CHASE ▸`) `role="slider"`; roving tabindex with DOM
 * focus following the model's focus; the help line is `aria-live`; glyphs
 * are `aria-hidden` and every prompt is a labelled button. Enter / Space on a
 * focused row do NOT click it natively (MenuInput already turns them into
 * `select`): the keydown default is prevented inside the overlay.
 */

export interface MenuViewExtras {
  /** The HUD's own size multiplier (`HudOptions.scale`, XR_HUD_SCALE in the
   * xr view): the post-race medal and stack use the HUD unit × this so they
   * stay lined up with the finish panel. Default 1. */
  hudScale?: number;
}

export interface MenuViewHandle extends MenuView {
  /** See `MenuViewExtras.hudScale` (the HUD is re-created on view changes). */
  setHudScale(scale: number): void;
  setInsets(insets: Partial<MenuInsets>): void;
}

const LOGO_WEB = 'WEB';
const LOGO_RACER = 'RACER';
const LOGO_TAGLINE = 'TOY BUGGY GRAND PRIX';
const NEXT_KICKER = 'NEXT RACE';
/** Fit pass floor: captions never go under the spec's 13 CSS px. */
const MIN_CAPTION_PX = 13;
/** A row may overflow its padding box by this much (into its 0.18u rim)
 * before the fit pass steps in: headless Chrome sets the mockup's own
 * 900×600 DIFFICULTY row a hair wider than the box. */
const FIT_TOLERANCE_PX = 1.5;

type Tag = keyof HTMLElementTagNameMap;

function el<K extends Tag>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

/** Counter-skewed text span (`.t` of the mockup). */
const tspan = (cls: string, parent: Element, text?: string): HTMLSpanElement => el('span', `rmenu-t ${cls}`.trim(), parent, text);

const arrow = (parent: Element, left: boolean, extra = ''): HTMLElement =>
  el('i', `rmenu-ar${left ? ' rmenu-left' : ''}${extra ? ' ' + extra : ''}`, parent);

const twoTone = (p: MenuPaint, angle: number, split: number): string =>
  `linear-gradient(${angle}deg, ${p.body} ${split}%, ${p.accent} ${split}%)`;

/** Breadcrumb spacing of the mockup: a separator between words gets two
 * spaces a side ('TITLE  /  CAR', 'LAP 2 / 3  ·  2ND OF 4'). */
const crumbText = (text: string): string =>
  text.replace(/(?<!\d) \/ (?!\d)/g, '  /  ').replace(/ · /g, '  ·  ');

/** Left of `e` in `ancestor`'s padding box, transform-free (offset chain);
 * null when `e` is not laid out inside it. */
function offsetIn(e: HTMLElement, ancestor: HTMLElement): number | null {
  let x = 0;
  let n: HTMLElement | null = e;
  while (n && n !== ancestor) {
    x += n.offsetLeft;
    const p = n.offsetParent as HTMLElement | null;
    if (!p || (p !== ancestor && !ancestor.contains(p))) return null;
    if (p !== ancestor) x += p.clientLeft;
    n = p;
  }
  return n === ancestor ? x : null;
}

/** How far the widest descendant of `box` sticks out of its padding box on
 * the right (≤ 0: fits), ignoring transforms (skew, focus shift). */
function overflowIn(box: HTMLElement): number {
  let worst = -Infinity;
  box.querySelectorAll('*').forEach((e) => {
    if (!(e instanceof HTMLElement) || e.offsetParent === null) return;
    const x = offsetIn(e, box);
    if (x !== null) worst = Math.max(worst, x + e.offsetWidth - box.clientWidth);
  });
  return worst;
}

const escapeAttr = (s: string): string => s.replace(/[^-\w .,MLHVZCSQTAmlhvzcsqta]/g, '');

/** The track outline of the title plate and the setup ticket (drawing code of
 * final.html): ink edge, rim, asphalt, cyan dashed centre line, white start
 * line, yellow chevron and car dot. Unknown track: a dashed ring. */
function mapSvg(track: MenuTrackInfo | null): string {
  const head = '<svg class="rmenu-map" viewBox="-72 -72 144 144" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  if (!track) {
    return (
      head +
      '<circle r="50" stroke="#0b141c" stroke-width="5"/>' +
      '<circle r="50" stroke="#aebbc2" stroke-width="2.4" stroke-dasharray="6 7" opacity="0.8"/>' +
      '</svg>'
    );
  }
  const d = escapeAttr(track.outline);
  return (
    head +
    `<path d="${d}" stroke="#0b141c" stroke-width="13"/>` +
    `<path d="${d}" stroke="#aebbc2" stroke-width="9.6"/>` +
    `<path d="${d}" stroke="#141e27" stroke-width="7"/>` +
    `<path d="${d}" stroke="#14e8f6" stroke-width="1.2" stroke-dasharray="3.5 4.5"/>` +
    '<path d="M-6 0H6" stroke="#fff" stroke-width="3" stroke-linecap="butt"/>' +
    '<path d="M-3.4 -9L0 -14L3.4 -9" stroke="#ffe14a" stroke-width="2.2"/>' +
    '<circle cx="0" cy="9" r="3.4" fill="#ffe14a" stroke="#0b141c" stroke-width="1.3"/>' +
    '</svg>'
  );
}

function richText(parent: Element, runs: MenuRichText): void {
  for (const run of runs) {
    if (run.strong) el('b', '', parent, run.text);
    else parent.appendChild(document.createTextNode(run.text));
  }
}

const bandClass = (screen: MenuScreenId): string =>
  screen === 'setup' || screen === 'settings' ? ' rmenu-wide' : screen === 'pause' || screen === 'confirm' ? ' rmenu-slim' : screen === 'car' ? ' rmenu-carband' : '';

const listClass = (screen: MenuScreenId): string => {
  switch (screen) {
    case 'title':
      return 'rmenu-titlelist';
    case 'car':
      return 'rmenu-cars';
    case 'setup':
    case 'settings':
      return 'rmenu-fields';
    case 'pause':
      return 'rmenu-pause-list';
    case 'confirm':
      return 'rmenu-confirm-list';
    default:
      return '';
  }
};

/** What forces a rebuild instead of a patch. */
const structureKey = (s: MenuSnapshot): string =>
  `${s.screen}|${s.rows.map((r) => `${r.id}:${r.kind}`).join(',')}|${s.aside?.kind ?? '-'}|${s.tips.length}`;

const rowSig = (r: MenuRow): string => JSON.stringify({ ...r, focused: false });

interface RowSlot {
  el: HTMLElement;
  sig: string;
  row: MenuRow;
}

export function createMenuView(options: MenuViewOptions & MenuViewExtras): MenuViewHandle {
  injectMenuCss();
  const parent = options.parent ?? document.body;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = (options.animate ?? true) && !reduced;

  const root = el('div', 'rmenu' + (options.parent ? '' : ' rmenu-fixed') + (animate ? ' rmenu-anim' : ''));
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const tint = el('div', 'rmenu-tint', root);
  const stage = el('div', 'rmenu-stage', root);
  parent.appendChild(root);

  const help = el('div', 'rmenu-t rmenu-help');
  help.setAttribute('aria-live', 'polite');

  let last: MenuSnapshot | null = null;
  let band: HTMLElement | null = null;
  let head: HTMLElement | null = null;
  let headSig = '';
  let hints: HTMLElement | null = null;
  let hintsSig = '';
  let tips: HTMLElement | null = null;
  let tipsSig = '';
  let asideEls: HTMLElement[] = [];
  let asideSig = '';
  let chip: HTMLElement | null = null;
  let chipText = '';
  let post: HTMLElement | null = null;
  let rows: RowSlot[] = [];
  let shownFocus = -1;
  let hideTimer = 0;
  let cursorTimer = 0;
  let programmaticFocus = false;
  let mouseDownAt = -1e9;
  let pendingPointerRow: MenuRowId | null = null;
  let lastPX = Number.NaN;
  let lastPY = Number.NaN;
  let travel = 0;

  const send = (a: MenuPointerAction): void => options.onPointer(a);

  const setInsets = (insets: Partial<MenuInsets>): void => {
    root.style.setProperty('--rmenu-in-t', `${insets.top ?? 0}px`);
    root.style.setProperty('--rmenu-in-r', `${insets.right ?? 0}px`);
    root.style.setProperty('--rmenu-in-b', `${insets.bottom ?? 0}px`);
    root.style.setProperty('--rmenu-in-l', `${insets.left ?? 0}px`);
  };
  if (options.insets) setInsets(options.insets);
  const setHudScale = (scale: number): void => root.style.setProperty('--rmenu-hud-scale', String(scale));
  if (options.hudScale !== undefined) setHudScale(options.hudScale);

  // ───────── small builders ─────────

  const tagsInto = (parent: Element, tags: readonly MenuTag[]): void => {
    for (const t of tags) tspan(`rmenu-tag rmenu-${t.kind}`, parent, t.text);
  };

  /** Label, then the caption (SKILL 0.60) and tags (WAS 16) after it. */
  const labelInto = (parent: Element, label: string, tags: readonly MenuTag[], caption: string | null = null): void => {
    const g = el('span', 'rmenu-lab', parent);
    tspan('rmenu-l', g, label);
    if (caption) tspan('rmenu-cap', g, caption);
    tagsInto(g, tags);
  };

  const valueInto = (parent: Element, v: MenuValue, cls: string): HTMLElement => {
    const multi = v.lines.length > 1;
    const span = tspan(`${cls}${v.staged ? ' rmenu-staged' : ''}${multi ? ' rmenu-lines' : ''}`, parent);
    span.dataset.fit = '1';
    if (v.swatch) {
      const sw = el('i', 'rmenu-swatch', span);
      sw.style.background = twoTone(v.swatch, 115, 50);
    }
    if (multi) for (const line of v.lines) el('span', '', span, line);
    else span.appendChild(document.createTextNode(v.lines[0] ?? ''));
    return span;
  };

  const promptsInto = (parent: Element, prompts: readonly MenuPrompt[]): void => {
    for (const p of prompts) {
      const b = el('button', 'rmenu-prompt', parent);
      b.type = 'button';
      b.tabIndex = -1;
      b.dataset.button = p.button;
      b.setAttribute('aria-label', p.ariaLabel);
      b.insertAdjacentHTML('beforeend', glyphHtml(p.glyph));
      el('span', '', b, p.label);
    }
  };

  const controlPartsInto = (parent: Element, parts: readonly MenuControlPart[]): void => {
    for (const part of parts) {
      if (part.kind === 'glyph') parent.insertAdjacentHTML('beforeend', glyphHtml(part.glyph));
      else if (part.kind === 'key') parent.insertAdjacentHTML('beforeend', keycapHtml(part.text));
      else el('small', '', parent, part.text);
    }
  };

  // ───────── rows ─────────

  const rowTag = (r: MenuRow): 'button' | 'div' => (r.kind === 'choice' || r.kind === 'stepper' || r.kind === 'slider' ? 'div' : 'button');

  /** Classes + ARIA + content of one row (focus class excluded). */
  const fillRow = (node: HTMLElement, r: MenuRow, screen: MenuScreenId): void => {
    const isPost = screen === 'post';
    let cls = 'rmenu-row';
    if (r.kind === 'car') cls += ' rmenu-car-row';
    if (r.tone === 'primary') cls += ' rmenu-primary';
    else if (r.tone === 'go') cls += ' rmenu-go';
    else if (r.tone === 'danger') cls += ' rmenu-danger';
    if (r.disabled) cls += ' rmenu-dim';
    if (r.focused && !r.disabled) cls += ' rmenu-focus';
    node.className = cls;
    node.dataset.row = r.id;
    node.textContent = '';
    for (const a of ['role', 'aria-checked', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-label']) node.removeAttribute(a);
    if (r.disabled) node.setAttribute('aria-disabled', 'true');
    else node.removeAttribute('aria-disabled');

    switch (r.kind) {
      case 'action': {
        if (isPost) {
          tspan('rmenu-l', node, r.label);
          if (r.sub) valueInto(node, r.sub, 'rmenu-sub');
          break;
        }
        if (r.tone === 'primary') {
          const top = el('span', 'rmenu-top', node);
          tspan('rmenu-l', top, r.label);
          if (r.chevron) {
            const ch = tspan('rmenu-v rmenu-chev', top);
            arrow(ch, false, 'rmenu-arbig');
            arrow(ch, false, 'rmenu-arbig');
          }
          if (r.sub) valueInto(node, r.sub, 'rmenu-sub');
          break;
        }
        labelInto(node, r.label, r.tags);
        if (r.value) valueInto(node, r.value, 'rmenu-v');
        if (r.chevron) {
          const ch = tspan('rmenu-v rmenu-chev', node);
          arrow(ch, false);
          arrow(ch, false);
        }
        break;
      }
      case 'link': {
        labelInto(node, r.label, r.tags);
        if (r.value) valueInto(node, r.value, 'rmenu-v');
        break;
      }
      case 'choice': {
        node.setAttribute('aria-label', r.label);
        labelInto(node, r.label, r.tags, r.selected === null ? r.caption : null);
        if (r.display === 'arrows') {
          node.setAttribute('role', 'slider');
          node.setAttribute('aria-valuemin', '0');
          node.setAttribute('aria-valuemax', String(Math.max(0, r.options.length - 1)));
          node.setAttribute('aria-valuenow', String(r.selected ?? 0));
          const cur = r.selected === null ? null : r.options[r.selected];
          node.setAttribute('aria-valuetext', cur ? cur.label : r.caption ?? '');
          const w = tspan('rmenu-v rmenu-step', node);
          w.dataset.widget = 'arrows';
          arrow(w, true);
          el('b', 'rmenu-word', w, cur ? cur.label : r.caption ?? '');
          arrow(w, false);
        } else {
          node.setAttribute('role', 'radiogroup');
          const w = tspan('rmenu-v rmenu-seg', node);
          r.options.forEach((o, i) => {
            const b = el('b', i === r.selected ? 'rmenu-sel' : '', w, o.label);
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', i === r.selected ? 'true' : 'false');
            b.dataset.opt = String(i);
            b.dataset.fit = '1';
          });
        }
        break;
      }
      case 'stepper': {
        node.setAttribute('role', 'slider');
        node.setAttribute('aria-label', r.label);
        node.setAttribute('aria-valuemin', String(r.min));
        node.setAttribute('aria-valuemax', String(r.max));
        node.setAttribute('aria-valuenow', String(r.value));
        node.setAttribute('aria-valuetext', r.ariaValueText);
        labelInto(node, r.label, r.tags);
        const w = tspan('rmenu-v rmenu-step', node);
        w.dataset.widget = 'stepper';
        arrow(w, true, r.canDecrease ? '' : 'rmenu-off');
        const word = r.entry === null && /[^\d]/.test(r.text);
        el('b', (word ? 'rmenu-word' : '') + (r.entry !== null ? ' rmenu-entry' : ''), w, r.text);
        arrow(w, false, r.canIncrease ? '' : 'rmenu-off');
        break;
      }
      case 'slider': {
        node.setAttribute('role', 'slider');
        node.setAttribute('aria-label', r.label);
        node.setAttribute('aria-valuemin', '0');
        node.setAttribute('aria-valuemax', '10');
        node.setAttribute('aria-valuenow', String(r.value));
        node.setAttribute('aria-valuetext', r.ariaValueText);
        labelInto(node, r.label, r.tags);
        const w = tspan('rmenu-v', node);
        const pips = el('span', 'rmenu-pips', w);
        for (let i = 0; i < 10; i++) {
          const pip = el('i', i < r.value ? 'rmenu-on' : '', pips);
          pip.dataset.pip = String(i);
        }
        if (r.text !== null) el('b', 'rmenu-num', w, r.text);
        break;
      }
      case 'car': {
        const chipEl = el('i', 'rmenu-paintchip', node);
        chipEl.style.background = twoTone(r.paint, 100, 58);
        const txt = tspan('', node);
        el('span', 'rmenu-n', txt, r.name);
        el('span', 'rmenu-s', txt, r.caption);
        if (r.tags.length) tagsInto(el('span', 'rmenu-tags', node), r.tags);
        break;
      }
    }
  };

  const buildRows = (list: HTMLElement, s: MenuSnapshot, screen: MenuScreenId): void => {
    rows = s.rows.map((r, i) => {
      const node = el(rowTag(r), '', list);
      if (node instanceof HTMLButtonElement) node.type = 'button';
      node.style.setProperty('--rmenu-i', String(i));
      fillRow(node, r, screen);
      node.tabIndex = r.focused && !r.disabled ? 0 : -1;
      return { el: node, sig: rowSig(r), row: r };
    });
  };

  /** When the model's text does not fit a row (a long sub-line, a WAS tag
   * beside segments …): first stack label / caption / tags, then less
   * padding and tighter letter / word spacing, then smaller captions (never
   * under 13 px). Measured transform-free. */
  const fitRow = (node: HTMLElement): void => {
    node.classList.remove('rmenu-stack', 'rmenu-snug');
    const fits = node.querySelectorAll<HTMLElement>('[data-fit]');
    fits.forEach((f) => (f.style.fontSize = ''));
    if (overflowIn(node) <= FIT_TOLERANCE_PX) return;
    const lab = node.querySelector('.rmenu-lab');
    if (lab && lab.children.length > 1) {
      node.classList.add('rmenu-stack');
      if (overflowIn(node) <= FIT_TOLERANCE_PX) return;
    }
    node.classList.add('rmenu-snug');
    if (overflowIn(node) <= FIT_TOLERANCE_PX || !fits.length) return;
    for (let step = 0; step < 12 && overflowIn(node) > FIT_TOLERANCE_PX; step++) {
      let shrunk = false;
      fits.forEach((f) => {
        const px = Number.parseFloat(getComputedStyle(f).fontSize);
        if (px > MIN_CAPTION_PX) {
          f.style.fontSize = `${Math.max(MIN_CAPTION_PX, px * 0.95)}px`;
          shrunk = true;
        }
      });
      if (!shrunk) break;
    }
  };

  /** A headline wider than the band (RESTART? in the slim pause band) is set
   * smaller; the prompt bar closes up. */
  const fitBand = (): void => {
    if (!band) return;
    const room = band.clientWidth;
    const margin = Number.parseFloat(getComputedStyle(band).borderRightWidth) * 2;
    // The breadcrumb at its 13 px floor (small windows: PAUSED / RESTART
    // RACE) closes its letter spacing up rather than run onto the stripes.
    const crumb = head?.querySelector<HTMLElement>('.rmenu-crumb');
    if (crumb) {
      crumb.style.letterSpacing = '';
      for (const spacing of ['0.06em', '0']) {
        const x = offsetIn(crumb, band);
        if (x === null || x + crumb.offsetWidth <= room - margin) break;
        crumb.style.letterSpacing = spacing;
      }
    }
    const h = head?.querySelector<HTMLElement>('.rmenu-h');
    if (h) {
      h.style.fontSize = '';
      const x = offsetIn(h, band);
      if (x !== null && x + h.offsetWidth > room - margin) {
        const px = Number.parseFloat(getComputedStyle(h).fontSize);
        h.style.fontSize = `${(px * (room - margin - x)) / h.offsetWidth}px`;
      }
    }
    if (hints && hints.parentElement === band) {
      hints.classList.remove('rmenu-tight');
      const items = Array.from(hints.children) as HTMLElement[];
      for (const it of items) it.style.display = '';
      const over = (): boolean => {
        const x = offsetIn(hints!, band!);
        return x !== null && x + hints!.offsetWidth > room;
      };
      if (over()) hints.classList.add('rmenu-tight');
      // Still too wide (four keycap prompts in a 68u band): drop prompts from
      // the front — MOVE / CAR first, as the model drops MOVE first when it
      // has more than four — but keep the last two (the action and BACK).
      for (let i = 0; i < items.length - 2 && over(); i++) items[i].style.display = 'none';
    }
  };

  /** The title's NEXT RACE plate: a 4-digit track (TRACK 1100) is wider
   * than the plate's middle column — set it smaller so BEST LAP stays in the
   * plate; a caption still too wide closes its letter spacing up. */
  const fitAsides = (): void => {
    for (const plate of asideEls) {
      if (!plate.classList.contains('rmenu-next')) continue;
      const big = plate.querySelector<HTMLElement>('.rmenu-big');
      const len = plate.querySelector<HTMLElement>('.rmenu-len');
      const col = big?.parentElement;
      if (!big || !col) continue;
      big.style.fontSize = '';
      if (len) len.style.letterSpacing = '';
      const room = col.clientWidth;
      if (room <= 0) continue;
      if (big.scrollWidth > room + FIT_TOLERANCE_PX) {
        const px = Number.parseFloat(getComputedStyle(big).fontSize);
        big.style.fontSize = `${Math.max(MIN_CAPTION_PX, (px * room) / big.scrollWidth)}px`;
      }
      if (len && len.scrollWidth > room + FIT_TOLERANCE_PX) len.style.letterSpacing = '0';
    }
  };

  // ───────── band pieces ─────────

  const buildHead = (s: MenuSnapshot, screen: MenuScreenId): HTMLElement => {
    if (screen === 'title') {
      const logo = el('div', 'rmenu-logo');
      logo.setAttribute('aria-hidden', 'true');
      tspan('rmenu-web', logo, LOGO_WEB);
      tspan('rmenu-racer', logo, LOGO_RACER);
      el('div', 'rmenu-checker', logo);
      tspan('', el('div', 'rmenu-tagline', logo), LOGO_TAGLINE);
      return logo;
    }
    const h = el('div', 'rmenu-head' + (screen === 'pause' || screen === 'confirm' ? ' rmenu-big' : ''));
    if (s.breadcrumb) tspan('rmenu-crumb', h, crumbText(s.breadcrumb));
    if (s.headline.length) {
      const big = tspan('rmenu-h', h);
      big.setAttribute('role', 'heading');
      big.setAttribute('aria-level', '1');
      s.headline.forEach((line, i) => {
        if (i) el('br', '', big);
        big.appendChild(document.createTextNode(line));
      });
    }
    if (s.say) tspan('rmenu-say', h, s.say);
    return h;
  };
  const headKey = (s: MenuSnapshot): string => JSON.stringify([s.screen, s.breadcrumb, s.headline, s.say]);

  const buildTips = (s: MenuSnapshot): HTMLElement => {
    const ul = el('ul', 'rmenu-tips');
    for (const tip of s.tips) richText(tspan('', el('li', '', ul)), tip);
    return ul;
  };

  /** Controls below 5:4: the sheet as two-line rows inside the band (CSS
   * shows it only there). */
  const buildControlsInBand = (a: MenuControlsAside): HTMLElement => {
    const box = el('div', 'rmenu-ctlb');
    for (const r of a.rows) {
      const row = el('div', 'rmenu-ctlb-row', box);
      tspan('rmenu-a', row, r.action);
      const k = tspan('rmenu-k', row);
      controlPartsInto(k, r.gamepad);
      el('i', 'rmenu-sep', k);
      controlPartsInto(k, r.keyboard);
    }
    return box;
  };

  // ───────── asides ─────────

  const buildNext = (a: MenuNextRaceAside): HTMLElement[] => {
    const plate = el('div', 'rmenu-plate rmenu-next rmenu-aside');
    const inner = el('div', 'rmenu-in', plate);
    inner.insertAdjacentHTML('beforeend', mapSvg(a.track));
    const mid = el('div', '', inner);
    el('div', 'rmenu-kicker', mid, NEXT_KICKER);
    el('div', 'rmenu-big' + (a.staged ? ' rmenu-new' : ''), mid, a.title);
    el('div', 'rmenu-len', mid, a.caption);
    const best = el('div', 'rmenu-best', inner);
    el('span', 'rmenu-kicker', best, a.bestLabel);
    el('b', /\d/.test(a.best) ? '' : 'rmenu-none', best, a.best);
    return [plate];
  };

  const buildCar = (a: MenuCarAside): HTMLElement[] => {
    const card = el('div', 'rmenu-namecard rmenu-aside');
    el('div', 'rmenu-name', card, a.name);
    el('b', '', el('div', 'rmenu-badge', card), a.badge);
    const sheet = el('div', 'rmenu-plate rmenu-sheet rmenu-spec rmenu-aside');
    const inner = el('div', 'rmenu-in', sheet);
    el('div', 'rmenu-desc', inner, a.description);
    const stats = el('div', 'rmenu-stats', inner);
    for (const st of a.stats) {
      const row = el('div', 'rmenu-stat', stats);
      el('span', '', row, st.label);
      const pips = el('span', 'rmenu-pips', row);
      for (let i = 0; i < st.max; i++) el('i', i < st.value ? 'rmenu-on' : '', pips);
    }
    const paint = el('div', 'rmenu-paint', inner);
    const kick = el('div', 'rmenu-kicker', paint);
    el('span', '', kick, a.paintLabel);
    el('b', '', kick, a.paintPosition);
    const row = el('div', 'rmenu-paints', paint);
    const prev = arrow(row, true, a.paintIndex > 0 ? '' : 'rmenu-off');
    prev.dataset.pstep = '-1';
    a.paints.forEach((p, i) => {
      const c = el('i', 'rmenu-p' + (i === a.paintIndex ? ' rmenu-sel' : ''), row);
      c.style.background = twoTone(p, 100, 58);
      c.dataset.paint = String(i);
      c.title = p.name;
    });
    const next = arrow(row, false, a.paintIndex < a.paints.length - 1 ? '' : 'rmenu-off');
    next.dataset.pstep = '1';
    el('div', 'rmenu-pname', paint, a.paintName);
    richText(el('div', 'rmenu-note', inner), a.note);
    return [card, sheet];
  };

  const buildTicket = (a: MenuTicketAside, popSticker: boolean): HTMLElement[] => {
    const sheet = el('div', 'rmenu-plate rmenu-sheet rmenu-ticket rmenu-aside');
    const inner = el('div', 'rmenu-in', sheet);
    el('div', 'rmenu-kicker', inner, a.kicker);
    el('div', 'rmenu-big', inner, a.title);
    inner.insertAdjacentHTML('beforeend', mapSvg(a.track));
    const chips = el('div', 'rmenu-chips', inner);
    for (const c of a.chips) el('b', '', el('div', 'rmenu-chip', chips), c);
    if (a.sticker) {
      const st = el('div', 'rmenu-sticker' + (popSticker ? '' : ' rmenu-still'), sheet, a.sticker.text);
      el('small', '', st, a.sticker.sub);
      if (!popSticker) st.style.animation = 'none';
    }
    return [sheet];
  };

  const buildControls = (a: MenuControlsAside): HTMLElement[] => {
    const sheet = el('div', 'rmenu-plate rmenu-sheet rmenu-sheetc rmenu-aside');
    sheet.setAttribute('role', 'table');
    sheet.setAttribute('aria-label', 'Controls');
    const inner = el('div', 'rmenu-in', sheet);
    const hd = el('div', 'rmenu-ctl rmenu-hd', inner);
    hd.setAttribute('role', 'row');
    for (const h of a.header) el('span', '', hd, h).setAttribute('role', 'columnheader');
    for (const r of a.rows) {
      const row = el('div', 'rmenu-ctl', inner);
      row.setAttribute('role', 'row');
      el('span', '', row, r.action).setAttribute('role', 'cell');
      const g = el('span', '', row);
      g.setAttribute('role', 'cell');
      controlPartsInto(g, r.gamepad);
      const k = el('span', '', row);
      k.setAttribute('role', 'cell');
      controlPartsInto(k, r.keyboard);
    }
    return [sheet];
  };

  const buildMedal = (a: MenuMedalAside): HTMLElement => {
    const m = el('div', 'rmenu-medal rmenu-aside' + (a.gold ? ' rmenu-gold' : ''));
    const b = el('b', '', m, String(a.place));
    el('sup', '', b, a.ordinal);
    el('span', '', m, a.caption);
    return m;
  };

  const placeAside = (s: MenuSnapshot, fresh: boolean): void => {
    const sig = JSON.stringify(s.aside);
    if (sig === asideSig && !fresh) return;
    const hadSticker = asideEls.some((e) => e.querySelector('.rmenu-sticker'));
    for (const e of asideEls) e.remove();
    asideEls = [];
    asideSig = sig;
    const a: MenuAside | null = s.aside;
    if (!a) return;
    switch (a.kind) {
      case 'next':
        asideEls = buildNext(a);
        break;
      case 'car':
        asideEls = buildCar(a);
        break;
      case 'ticket':
        asideEls = buildTicket(a, fresh || !hadSticker);
        break;
      case 'controls':
        asideEls = buildControls(a);
        break;
      case 'medal':
        // drawn inside the post container (HUD unit)
        if (post) {
          const m = buildMedal(a);
          post.insertBefore(m, post.firstChild);
          asideEls = [m];
        }
        return;
    }
    for (const e of asideEls) {
      if (fresh) e.classList.add('rmenu-fresh');
      stage.appendChild(e);
    }
    fitAsides();
  };

  const placeChip = (s: MenuSnapshot): void => {
    const text = s.soundChip ?? '';
    if (text === chipText && (chip !== null) === (text !== '')) return;
    chipText = text;
    chip?.remove();
    chip = null;
    if (!text) return;
    chip = el('div', 'rmenu-unlock', stage);
    el('b', '', el('div', 'rmenu-chip', chip), text);
  };

  const placeHints = (s: MenuSnapshot, container: HTMLElement): void => {
    const sig = JSON.stringify(s.prompts);
    if (hints && sig === hintsSig && hints.parentElement === container) return;
    hints?.remove();
    hintsSig = sig;
    hints = el('div', 'rmenu-t rmenu-hints', container);
    hints.setAttribute('role', 'toolbar');
    hints.setAttribute('aria-label', 'Buttons');
    promptsInto(hints, s.prompts);
  };

  // ───────── screen build / patch ─────────

  const clearStage = (): void => {
    stage.textContent = '';
    band = head = hints = tips = post = chip = null;
    headSig = hintsSig = tipsSig = asideSig = chipText = '';
    asideEls = [];
    rows = [];
    shownFocus = -1;
  };

  const build = (s: MenuSnapshot, prev: MenuSnapshot | null): void => {
    const screen = s.screen as MenuScreenId;
    const hadBand = band !== null && !band.classList.contains('rmenu-out') && prev !== null && prev.screen !== null && prev.screen !== 'post';
    clearStage();
    if (screen === 'post') {
      post = el('div', 'rmenu-post rmenu-fresh', stage);
      placeAside(s, true);
      const list = el('div', 'rmenu-actions', post);
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', s.ariaLabel);
      buildRows(list, s, screen);
      const float = el('div', 'rmenu-float-hints rmenu-fresh', stage);
      placeHints(s, float);
    } else {
      band = el('div', 'rmenu-band' + bandClass(screen) + (hadBand ? '' : ' rmenu-in'), stage);
      if (!hadBand) band.addEventListener('animationend', () => band?.classList.remove('rmenu-in'), { once: true });
      head = buildHead(s, screen);
      headSig = headKey(s);
      band.appendChild(head);
      if (s.rows.length) {
        const list = el('div', `rmenu-list ${listClass(screen)} rmenu-fresh`, band);
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', s.ariaLabel);
        buildRows(list, s, screen);
      }
      if (s.tips.length) {
        tips = buildTips(s);
        tipsSig = JSON.stringify(s.tips);
        band.appendChild(tips);
      }
      if (s.aside?.kind === 'controls') band.appendChild(buildControlsInBand(s.aside));
      band.appendChild(help);
      placeHints(s, band);
      placeAside(s, true);
    }
    placeChip(s);
    for (const r of rows) fitRow(r.el);
    fitBand();
  };

  const patch = (s: MenuSnapshot): void => {
    const screen = s.screen as MenuScreenId;
    let bandChanged = false;
    if (band && head && headKey(s) !== headSig) {
      const h = buildHead(s, screen);
      band.replaceChild(h, head);
      head = h;
      headSig = headKey(s);
      bandChanged = true;
    }
    if (band && tips && JSON.stringify(s.tips) !== tipsSig) {
      const t = buildTips(s);
      band.replaceChild(t, tips);
      tips = t;
      tipsSig = JSON.stringify(s.tips);
    }
    s.rows.forEach((r, i) => {
      const slot = rows[i];
      if (!slot) return;
      const sig = rowSig(r);
      if (sig !== slot.sig) {
        fillRow(slot.el, r, screen);
        slot.sig = sig;
        fitRow(slot.el);
      } else {
        slot.el.classList.toggle('rmenu-focus', r.focused && !r.disabled);
      }
      slot.row = r;
      slot.el.tabIndex = r.focused && !r.disabled ? 0 : -1;
    });
    const hintsBefore = hints;
    if (band) placeHints(s, band);
    else if (hints?.parentElement) placeHints(s, hints.parentElement);
    if (bandChanged || hints !== hintsBefore) fitBand();
    placeAside(s, false);
    placeChip(s);
  };

  // ───────── show / hide ─────────

  const hideNow = (): void => {
    root.hidden = true;
    root.classList.remove('rmenu-nocursor');
    clearStage();
  };

  const hide = (): void => {
    window.clearTimeout(hideTimer);
    if (animate && band) {
      band.classList.remove('rmenu-in');
      band.classList.add('rmenu-out');
      for (const e of asideEls) e.style.visibility = 'hidden';
      chip?.remove();
      hideTimer = window.setTimeout(hideNow, 190);
    } else {
      hideNow();
    }
  };

  const syncFocus = (s: MenuSnapshot): void => {
    // Only when the model's focus moved or the screen was rebuilt: a click
    // elsewhere (the dev tuning panel) must not be taken back on every patch.
    if (s.focus === shownFocus) return;
    shownFocus = s.focus;
    const target = rows[s.focus]?.el;
    if (!target || root.hidden) return;
    if (document.activeElement === target) return;
    programmaticFocus = true;
    try {
      target.focus({ preventScroll: true });
    } finally {
      programmaticFocus = false;
    }
  };

  const syncCursor = (s: MenuSnapshot): void => {
    if (s.device === 'pointer') {
      window.clearTimeout(cursorTimer);
      cursorTimer = 0;
      return;
    }
    if (cursorTimer || root.classList.contains('rmenu-nocursor')) return;
    cursorTimer = window.setTimeout(() => {
      cursorTimer = 0;
      if (!root.hidden) root.classList.add('rmenu-nocursor');
    }, 2000);
  };

  const render = (s: MenuSnapshot): void => {
    if (s === last) return;
    const prev = last;
    last = s;
    pendingPointerRow = null;
    if (s.screen === null) {
      if (!root.hidden && !(prev && prev.screen === null)) hide();
      return;
    }
    window.clearTimeout(hideTimer);
    if (root.hidden) {
      clearStage();
      root.hidden = false;
    }
    tint.className = 'rmenu-tint' + (s.backdrop === 'pause' ? ' rmenu-pause' : s.backdrop === 'post' ? ' rmenu-post' : '');
    root.setAttribute('aria-label', s.ariaLabel);
    if (help.textContent !== s.help) help.textContent = s.help;
    const rebuild =
      !prev || prev.screen === null || prev.serial !== s.serial || structureKey(prev) !== structureKey(s) || band?.classList.contains('rmenu-out');
    if (rebuild) build(s, prev && prev.screen !== null ? prev : null);
    else patch(s);
    syncFocus(s);
    syncCursor(s);
  };

  // ───────── pointer / DOM focus → actions ─────────

  const rowOf = (node: Element | null): { el: HTMLElement; row: MenuRow } | null => {
    const r = node?.closest<HTMLElement>('.rmenu-row');
    if (!r || !root.contains(r)) return null;
    const slot = rows.find((x) => x.el === r);
    return slot ? { el: slot.el, row: slot.row } : null;
  };

  const third = (e: MouseEvent, widget: Element): -1 | 0 | 1 => {
    const b = widget.getBoundingClientRect();
    if (b.width <= 0) return 0;
    const f = (e.clientX - b.left) / b.width;
    return f >= 0 && f < 1 / 3 ? -1 : f > 2 / 3 ? 1 : 0;
  };

  const onClick = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    if (!t || !last || last.screen === null) return;
    const prompt = t.closest<HTMLElement>('.rmenu-prompt');
    if (prompt && root.contains(prompt)) {
      e.preventDefault();
      send({ kind: 'button', button: prompt.dataset.button as MenuButton });
      return;
    }
    const focusedRow = last.rows[last.focus];
    const paint = t.closest<HTMLElement>('[data-paint]');
    if (paint && focusedRow && root.contains(paint)) {
      send({ kind: 'set', row: focusedRow.id, value: Number(paint.dataset.paint) });
      return;
    }
    const pstep = t.closest<HTMLElement>('[data-pstep]');
    if (pstep && focusedRow && root.contains(pstep)) {
      send({ kind: 'step', row: focusedRow.id, delta: pstep.dataset.pstep === '-1' ? -1 : 1 });
      return;
    }
    const hit = rowOf(t);
    if (!hit) return;
    e.preventDefault();
    const r = hit.row;
    if (r.disabled) return;
    const opt = t.closest<HTMLElement>('[data-opt]');
    if (opt && r.kind === 'choice') {
      send({ kind: 'set', row: r.id, value: Number(opt.dataset.opt) });
      return;
    }
    const pip = t.closest<HTMLElement>('[data-pip]');
    if (pip && r.kind === 'slider') {
      send({ kind: 'set', row: r.id, value: Number(pip.dataset.pip) + 1 });
      return;
    }
    // Steppers and the ◂ CHASE ▸ choice: a click on the left third of the
    // widget steps down, anywhere right of its middle third (up to the row's
    // edge) steps up; the label area activates (= focus).
    const widget = hit.el.querySelector<HTMLElement>('[data-widget]');
    if (widget && (r.kind === 'stepper' || r.kind === 'choice')) {
      const side = third(e, widget);
      if (side !== 0 && r.kind === 'stepper') {
        send({ kind: 'step', row: r.id, delta: side });
        return;
      }
      if (side !== 0 && r.kind === 'choice' && r.selected !== null) {
        const next = r.selected + side;
        if (next >= 0 && next < r.options.length) send({ kind: 'set', row: r.id, value: next });
        else if (!r.focused) send({ kind: 'focus', row: r.id, via: 'pointer' });
        return;
      }
    }
    send({ kind: 'activate', row: r.id });
  };

  const onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    if (t && (t.closest('.rmenu-row') || t.closest('.rmenu-prompt') || t.closest('[data-paint]') || t.closest('[data-pstep]'))) {
      // The model owns focus: a click must not move DOM focus by itself.
      e.preventDefault();
      mouseDownAt = performance.now();
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const moved = Number.isNaN(lastPX) ? 0 : Math.hypot(e.clientX - lastPX, e.clientY - lastPY);
    lastPX = e.clientX;
    lastPY = e.clientY;
    if (moved <= 0) return;
    travel += moved;
    if (travel <= 2) return;
    travel = 0;
    window.clearTimeout(cursorTimer);
    cursorTimer = 0;
    root.classList.remove('rmenu-nocursor');
    if (root.hidden || !last) return;
    const hit = rowOf(e.target as Element | null);
    if (!hit || hit.row.disabled || hit.row.focused || pendingPointerRow === hit.row.id) return;
    pendingPointerRow = hit.row.id;
    send({ kind: 'focus', row: hit.row.id, via: 'pointer' });
  };

  const onFocusIn = (e: FocusEvent): void => {
    if (programmaticFocus || performance.now() - mouseDownAt < 400) return;
    const hit = rowOf(e.target as Element | null);
    if (!hit || hit.row.disabled || hit.row.focused) return;
    send({ kind: 'focus', row: hit.row.id, via: 'tab' });
  };

  const onKey = (e: KeyboardEvent): void => {
    // Rows and prompts are real buttons: stop the browser's own Enter / Space
    // click — MenuInput already reads those keys as `select`.
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space' || e.key === 'Enter' || e.key === ' ') {
      const t = e.target as Element | null;
      if (t && (t.closest('.rmenu-row') || t.closest('.rmenu-prompt'))) e.preventDefault();
    }
  };

  // Text metrics change when a font finishes loading (a fresh profile loads
  // the system face asynchronously): fit again then.
  const refit = (): void => {
    if (root.hidden || !last || last.screen === null) return;
    for (const r of rows) fitRow(r.el);
    fitBand();
    fitAsides();
  };
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  fonts?.ready.then(refit, () => undefined);
  fonts?.addEventListener('loadingdone', refit);
  // …and when the overlay's box changes size (window resize; headless Chrome
  // resizes just before a screenshot).
  let lastW = -1;
  let lastH = -1;
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const w = root.clientWidth;
          const h = root.clientHeight;
          if (w === lastW && h === lastH) return;
          lastW = w;
          lastH = h;
          refit();
        })
      : null;
  resizeObserver?.observe(root);

  root.addEventListener('click', onClick);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('keydown', onKey);
  root.addEventListener('keyup', onKey);
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  return {
    root,
    render,
    setHudScale,
    setInsets,
    dispose(): void {
      window.clearTimeout(hideTimer);
      window.clearTimeout(cursorTimer);
      window.removeEventListener('pointermove', onPointerMove);
      fonts?.removeEventListener('loadingdone', refit);
      resizeObserver?.disconnect();
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('keyup', onKey);
      root.remove();
      last = null;
      rows = [];
    },
  };
}
