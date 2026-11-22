import type { MenuGlyphId } from '../../game/contracts/menu';

/**
 * Button glyphs of the menu (spec 1, "Prompt bar"): DualShock face buttons,
 * the D-pad and the L2 / R2 / OPTIONS pills as inline SVG / HTML, and pale
 * keycaps for the keyboard set. Ported from the `face`, `dpad`, `pill` and
 * `key` functions of design-documents/menu-mockups/final.html.
 *
 * Every function returns an HTML string for `innerHTML`; the glyph is
 * decoration (`aria-hidden`): the button around it carries the text label.
 * Sizes come from the menu CSS (`.rmenu-g` …, menuCss.ts).
 */

const INK_DISC = '#0f171f';
const RING = '#dfe7ec';
const CYAN = '#14e8f6';

/** DualShock symbol colours. */
export const PAD_COLOURS = {
  cross: '#8fb8ff',
  circle: '#ff7482',
  triangle: '#49e6b4',
  square: '#f3a3dc',
} as const;

const svg = (body: string): string =>
  `<span class="rmenu-g" aria-hidden="true"><svg viewBox="0 0 40 40" focusable="false">${body}</svg></span>`;

/** A face button: dark disc, pale ring, the symbol inside. */
const face = (symbol: string): string =>
  svg(`<circle cx="20" cy="20" r="17" fill="${INK_DISC}" stroke="${RING}" stroke-width="2.4"/>${symbol}`);

/** The D-pad with the live axis lit cyan. */
const dpad = (lr: boolean, ud: boolean): string =>
  svg(
    `<path d="M15 3h10v12h12v10H25v12H15V25H3V15h12z" fill="${INK_DISC}" stroke="${RING}" stroke-width="2.4" stroke-linejoin="round"/>` +
      (ud ? `<path d="M20 6l4 6h-8zM20 34l4-6h-8z" fill="${CYAN}"/>` : '') +
      (lr ? `<path d="M6 20l6-4v8zM34 20l-6-4v8z" fill="${CYAN}"/>` : ''),
  );

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pill = (text: string, extra = ''): string =>
  `<span class="rmenu-g rmenu-pill${extra ? ' ' + extra : ''}" aria-hidden="true">${escapeHtml(text)}</span>`;

/** A pale keyboard keycap with `text` on it ('A', '←', 'ESC' …). */
export function keycapHtml(text: string): string {
  return `<span class="rmenu-g rmenu-key" aria-hidden="true">${escapeHtml(text)}</span>`;
}

const PAD: Record<string, string> = {
  cross: face(`<path d="M13 13l14 14M27 13L13 27" stroke="${PAD_COLOURS.cross}" stroke-width="3.4" stroke-linecap="round"/>`),
  circle: face(`<circle cx="20" cy="20" r="8" fill="none" stroke="${PAD_COLOURS.circle}" stroke-width="3.2"/>`),
  triangle: face(`<path d="M20 11l9 15H11z" fill="none" stroke="${PAD_COLOURS.triangle}" stroke-width="3.2" stroke-linejoin="round"/>`),
  square: face(`<rect x="12.5" y="12.5" width="15" height="15" rx="1.5" fill="none" stroke="${PAD_COLOURS.square}" stroke-width="3.2"/>`),
  stick: face(
    `<circle cx="20" cy="20" r="9" fill="${RING}"/><text x="20" y="24.5" text-anchor="middle" font-size="12" font-weight="900" font-family="system-ui, sans-serif" fill="${INK_DISC}">L</text>`,
  ),
  'dpad-ud': dpad(false, true),
  'dpad-lr': dpad(true, false),
  l2: pill('L2'),
  r2: pill('R2'),
  options: pill('OPTIONS', 'rmenu-opt'),
};

const KEYS: Record<string, string> = {
  'key-ud': keycapHtml('↑') + keycapHtml('↓'),
  'key-lr': keycapHtml('←') + keycapHtml('→'),
  'key-enter': keycapHtml('ENTER'),
  'key-esc': keycapHtml('ESC'),
  'key-del': keycapHtml('DEL'),
  'key-r': keycapHtml('R'),
};

/** HTML of one glyph (a key glyph may be two keycaps: ↑ ↓, ← →). */
export function glyphHtml(id: MenuGlyphId): string {
  return PAD[id] ?? KEYS[id] ?? keycapHtml('?');
}
