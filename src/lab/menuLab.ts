/**
 * Menu lab (menu-lab.html): the game menu's DOM view (src/ui/menu/MenuView.ts)
 * over the mockup's backdrop pictures, without the 3D game — every screen
 * pinned by URL, to compare with design-documents/menu-mockups/final-*.png.
 *
 *   src=     model (default): the REAL MenuModel (pinned with `pin()`, the
 *            variants below as running / staged options and facts) with the
 *            real car data (assets, handling presets, rigs) and real track
 *            outlines; live, the real MenuInput drives it (keys, pads,
 *            pointer) and a host that only logs (a reload logs its query).
 *            mock: snapshots built here by hand with the mockup's texts.
 *
 *   screen=  title | car | setup | settings | controls | pause | confirm | post
 *   state=   comma list of variants:
 *              staged     staged world values (title RACE / setup / next plate)
 *              kb         keyboard prompts (keycaps) instead of DualShock glyphs
 *              countdown  pause during the 3-2-1 (STARTING GRID)
 *              paused     settings / controls opened from the pause menu
 *              restart    confirm asks about RESTART RACE (default QUIT)
 *              first      post: first place (gold medal)
 *              chosen     car: a staged car (CHOSEN tag) other than the running one
 *              entry      setup: digits being typed on TRACK
 *              endless    laps = ENDLESS
 *              skill      difficulty 0.60 (no preset: SKILL 0.60 caption)
 *              unlock     title: the CLICK OR PRESS A KEY FOR SOUND chip
 *              long       worst-case texts (long sub-lines, 4-digit seeds)
 *   focus=   index of the focused row
 *   bg=      picture (default: the mockup's game frame for the screen) | color | none
 *   stage=   WxH — draw into a box of that size instead of the window
 *   shot=1   no motion (screenshots)
 *   report=1 acceptance check 4 of the spec: for every screen and variant at
 *            1600×900, 1024×768, 900×600, 800×500 (the spec's minimum) and
 *            620×900 — no row text overflows its row, nothing in the band
 *            crosses the band's right edge, band content and plates stay
 *            inside the window, plates clear the band, every text ≥ 13 px
 *            (tags / glyph caps / sticker sub-line ≥ 11 px), text inside its
 *            plate (`plateTextPx`, gated in the worst-case texts too: TRACK
 *            9999 with a real best lap), no sticker or car tag over other
 *            text (`overlayTextPx`).
 *            Both sources are measured (ids `layout.…` mock, `layout.model.…`).
 *            physlab protocol (#status, #result, title done / error).
 *   ui=0     hide the lab panel
 *
 * Live (no shot): the view's pointer actions and the arrow keys drive a tiny
 * mock (focus, choices, steppers, pips), enough to see focus motion, patches
 * and the prompts' clicks; the panel logs every pointer action.
 */
import { createMenuView } from '../ui/menu/MenuView';
import type { MenuViewHandle } from '../ui/menu/MenuView';
import type {
  MenuAside,
  MenuButton,
  MenuCarRow,
  MenuControlPart,
  MenuGlyphId,
  MenuPadGlyph,
  MenuPaint,
  MenuPointerAction,
  MenuPrompt,
  MenuRichText,
  MenuRow,
  MenuScreenId,
  MenuSnapshot,
  MenuTag,
  MenuTrackInfo,
  MenuValue,
} from '../game/contracts/menu';
import type { LabReport } from '../game/contracts/report';
import type { MenuCarInfo, MenuCommand, MenuFacts, MenuHost, MenuModel } from '../game/contracts/menu';
import { parseGameOptions, optionsToQuery } from '../game/options';
import type { GameOptions } from '../game/options';
import { createMenuInput } from '../input/MenuInput';
import { generateTerrain } from '../terrain/generateTerrain';
import { menuCars } from '../ui/menu/menuCars';
import { createMenuModel } from '../ui/menu/MenuModel';
import { trackInfoOf } from '../ui/menu/trackPreview';
import { Hud } from '../ui/Hud';
import type { HudSnapshot } from '../game/RaceState';

const params = new URLSearchParams(location.search);
const fatal = document.getElementById('fatal') as HTMLElement;
window.addEventListener('error', (e) => (fatal.textContent += `${e.message}\n`));
window.addEventListener('unhandledrejection', (e) => (fatal.textContent += `${String(e.reason)}\n`));

const SCREENS: readonly MenuScreenId[] = ['title', 'car', 'setup', 'settings', 'controls', 'pause', 'confirm', 'post'];
const screenParam = params.get('screen') as MenuScreenId | null;
const screen: MenuScreenId = screenParam && SCREENS.includes(screenParam) ? screenParam : 'title';
const flags = new Set((params.get('state') ?? '').split(',').filter(Boolean));
const shot = params.get('shot') === '1';
const report = params.get('report') === '1';
if (params.get('ui') === '0' || shot || report) document.body.classList.add('bare');

// ───────────────────────── mock data (the mockup's numbers) ─────────────────────────

/** Real outlines from src/terrain/track.ts (every 4th point; x right, svg y =
 * −z; start line at the origin heading up), as final.html carries them. */
const OUTLINES: Record<number, { lengthM: number; d: string }> = {
  16: {
    lengthM: 593,
    d: 'M0 0L0 -48L1 -52L4 -55L7 -57L11 -59L15 -59L19 -59L23 -60L27 -60L31 -59L34 -58L38 -56L40 -53L42 -49L43 -45L45 -42L46 -38L47 -34L49 -30L50 -26L51 -23L53 -19L54 -15L55 -11L56 -7L57 -4L57 0L57 4L56 8L56 12L55 16L54 20L53 24L52 28L51 32L50 36L49 39L47 43L44 46L41 48L37 50L34 51L30 52L26 53L22 54L18 55L14 56L10 57L6 58L3 59L-1 60L-5 61L-9 62L-13 62L-17 62L-21 62L-25 61L-29 61L-33 60L-37 59L-41 59L-45 58L-48 56L-52 54L-55 51L-57 48L-58 44L-59 40L-59 36L-59 32L-59 28L-60 24L-60 20L-60 16L-60 12L-60 8L-60 4L-61 0L-61 -28L-60 -32L-60 -44L-59 -48L-59 -52L-57 -55L-55 -58L-51 -60L-47 -61L-43 -61L-39 -61L-35 -59L-32 -57L-30 -54L-29 -50L-28 -46L-28 18L-27 22L-27 30L-25 34L-23 37L-19 39L-15 39L-11 39L-7 38L-4 36L-2 33L0 29L0 25Z',
  },
  27: {
    lengthM: 544,
    d: 'M0 0L0 -48L2 -52L4 -55L8 -57L11 -58L15 -58L19 -58L23 -57L26 -54L28 -51L30 -47L30 -43L30 -27L31 -23L32 -20L35 -17L39 -15L42 -13L46 -11L49 -9L53 -7L56 -5L58 -1L59 2L59 6L59 18L58 22L58 34L57 38L56 42L54 45L51 48L48 51L44 53L41 54L37 54L33 55L29 56L25 56L21 57L17 58L13 59L9 59L5 60L1 61L-3 61L-19 61L-23 60L-27 59L-31 58L-35 58L-38 57L-42 56L-46 55L-49 52L-52 50L-55 46L-56 43L-57 39L-57 31L-58 27L-58 15L-59 11L-59 -9L-58 -13L-58 -17L-57 -21L-57 -25L-56 -29L-54 -32L-51 -35L-47 -36L-43 -36L-39 -35L-36 -33L-34 -29L-32 -26L-30 -22L-29 -19L-28 -15L-28 13L-29 17L-29 29L-27 33L-25 36L-22 38L-18 39L-14 39L-10 39L-6 38L-3 35L-1 32L0 28L0 24Z',
  },
};
const trackInfo = (seed: number): MenuTrackInfo | null => {
  const o = OUTLINES[seed];
  return o ? { seed, lengthM: o.lengthM, outline: o.d } : null;
};

/** Paints. The first of each car = the mockup's chips (typed from palette.ts);
 * the other names / colours are lab stand-ins (the game reads CarAsset.paints). */
const paint = (name: string, body: string, accent: string): MenuPaint => ({ name, body, accent });
interface MockCar {
  id: string;
  name: string;
  caption: string;
  paints: MenuPaint[];
}
const CARS: MockCar[] = [
  { id: 'reef-rocket', name: 'REEF ROCKET', caption: 'ALL-ROUNDER · 810 KG', paints: [paint('Reef', '#1cafae', '#f16b59'), paint('Sunset', '#f08a2c', '#3153ba'), paint('Kelp', '#3f8f4a', '#f4e3c4'), paint('Dusk', '#5b4bb0', '#e5ab35')] },
  { id: 'neon-wasp', name: 'NEON WASP', caption: 'AGILE · 730 KG', paints: [paint('Neon', '#e6f400', '#7a3fd0'), paint('Ice', '#bfe9f2', '#2b4fc4'), paint('Ember', '#f12532', '#141e27')] },
  { id: 'riot-ram', name: 'RIOT RAM', caption: 'PLANTED · 973 KG', paints: [paint('Riot', '#3153ba', '#f08a2c'), paint('Moss', '#5f7f2a', '#e6f400'), paint('Chalk', '#f4e3c4', '#d42a3c')] },
  { id: 'comet-fox', name: 'COMET FOX', caption: 'FAST · 892 KG', paints: [paint('Vermilion', '#f12532', '#1fa79b'), paint('Cobalt', '#3153ba', '#e5ab35'), paint('Cream', '#f4e3c4', '#1cafae'), paint('Jade', '#139b68', '#a694e6')] },
];

const kb = flags.has('kb');
const prompt = (pad: MenuPadGlyph, key: MenuGlyphId, label: string, button: MenuButton): MenuPrompt => ({
  glyph: kb ? key : pad,
  label,
  ariaLabel: label.charAt(0) + label.slice(1).toLowerCase(),
  button,
});
const P = {
  move: (): MenuPrompt => prompt('dpad-ud', 'key-ud', 'MOVE', 'down'),
  select: (): MenuPrompt => prompt('cross', 'key-enter', 'SELECT', 'select'),
  back: (label = 'BACK'): MenuPrompt => prompt('circle', 'key-esc', label, 'back'),
  change: (): MenuPrompt => prompt('dpad-lr', 'key-lr', 'CHANGE', 'right'),
  undo: (): MenuPrompt => prompt('square', 'key-del', 'UNDO', 'undo'),
  random: (): MenuPrompt => prompt('triangle', 'key-r', 'RANDOM TRACK', 'random'),
};

const val = (text: string | string[], staged = false, swatch: MenuPaint | null = null): MenuValue => ({
  lines: Array.isArray(text) ? text : [text],
  staged,
  swatch,
});
const tag = (kind: MenuTag['kind'], text: string): MenuTag => ({ kind, text });
const run = (text: string, strong = false): { text: string; strong: boolean } => ({ text, strong });

interface Base {
  id: MenuRow['id'];
  label: string;
  tone?: MenuRow['tone'];
  tags?: MenuTag[];
  disabled?: boolean;
}
const base = (b: Base): Omit<MenuRow, 'kind'> & { focused: boolean } => ({
  id: b.id,
  label: b.label,
  focused: false,
  disabled: b.disabled ?? false,
  tone: b.tone ?? 'normal',
  tags: b.tags ?? [],
});
const action = (b: Base, o: { chevron?: boolean; value?: MenuValue | null; sub?: MenuValue | null } = {}): MenuRow => ({
  ...base(b),
  kind: 'action',
  chevron: o.chevron ?? false,
  value: o.value ?? null,
  sub: o.sub ?? null,
});
const link = (b: Base, value: MenuValue | null = null): MenuRow => ({ ...base(b), kind: 'link', value });
const choice = (b: Base, labels: string[], selected: number | null, o: { arrows?: boolean; caption?: string | null; staged?: boolean } = {}): MenuRow => ({
  ...base(b),
  kind: 'choice',
  display: o.arrows ? 'arrows' : 'segments',
  options: labels.map((l) => ({ value: l.toLowerCase(), label: l })),
  selected,
  caption: o.caption ?? null,
  staged: o.staged ?? false,
});
const stepper = (b: Base, value: number, text: string, o: { min: number; max: number; aria: string; wrap: boolean; staged?: boolean; entry?: string | null }): MenuRow => ({
  ...base(b),
  kind: 'stepper',
  value,
  text: o.entry ?? text,
  entry: o.entry ?? null,
  canDecrease: o.wrap || value > o.min,
  canIncrease: o.wrap || value < o.max,
  min: o.min,
  max: o.max,
  ariaValueText: o.aria,
  repeat: 'fast',
  staged: o.staged ?? false,
});
const slider = (b: Base, value: number, text: string | null): MenuRow => ({
  ...base(b),
  kind: 'slider',
  value,
  text,
  ariaValueText: `${value * 10} percent`,
});

const CONTROL_ROWS: { action: string; gamepad: MenuControlPart[]; keyboard: MenuControlPart[] }[] = [
  { action: 'STEER', gamepad: [{ kind: 'glyph', glyph: 'stick' }, { kind: 'text', text: 'LEFT STICK' }], keyboard: [{ kind: 'key', text: 'A' }, { kind: 'key', text: 'D' }, { kind: 'text', text: 'OR' }, { kind: 'key', text: '←' }, { kind: 'key', text: '→' }] },
  { action: 'THROTTLE', gamepad: [{ kind: 'glyph', glyph: 'r2' }], keyboard: [{ kind: 'key', text: 'W' }, { kind: 'text', text: 'OR' }, { kind: 'key', text: '↑' }] },
  { action: 'BRAKE / REVERSE', gamepad: [{ kind: 'glyph', glyph: 'l2' }], keyboard: [{ kind: 'key', text: 'S' }, { kind: 'text', text: 'OR' }, { kind: 'key', text: '↓' }] },
  { action: 'RESET CAR', gamepad: [{ kind: 'glyph', glyph: 'circle' }], keyboard: [{ kind: 'key', text: 'R' }] },
  { action: 'CAMERA', gamepad: [{ kind: 'glyph', glyph: 'triangle' }], keyboard: [{ kind: 'key', text: 'C' }] },
  { action: 'PAUSE', gamepad: [{ kind: 'glyph', glyph: 'options' }], keyboard: [{ kind: 'key', text: 'ESC' }, { kind: 'text', text: 'OR' }, { kind: 'key', text: 'P' }] },
  { action: 'MUSIC ON / OFF', gamepad: [{ kind: 'text', text: 'IN THE MENU' }], keyboard: [{ kind: 'key', text: 'M' }] },
];
const TIPS: MenuRichText[] = [
  [run('Hold '), run('BRAKE', true), run(' at a standstill to reverse.')],
  [run('RESET', true), run(' puts you back on the road, facing the right way.')],
  [run('Cut a corner and the lap does not count until you rejoin.')],
  [run('Restart and quit are in the '), run('PAUSE', true), run(' menu.')],
];

interface Built {
  rows: MenuRow[];
  focus: number;
  breadcrumb: string | null;
  headline: string[];
  ariaLabel: string;
  say: string | null;
  tips: MenuRichText[];
  help: string[];
  prompts: MenuPrompt[];
  aside: MenuAside | null;
  soundChip: string | null;
  backdrop: MenuSnapshot['backdrop'];
  state: MenuSnapshot['state'];
  stagedCount: number;
}

/** One screen as the model would describe it, in the mockup's state. */
function build(s: MenuScreenId, f: Set<string>): Built {
  const staged = f.has('staged');
  const long = f.has('long');
  const fromPause = f.has('paused');
  const runSeed = long ? 1100 : 16;
  const stSeed = long ? 9999 : 27;
  const out: Built = {
    rows: [], focus: 0, breadcrumb: null, headline: [], ariaLabel: '', say: null, tips: [], help: [], prompts: [],
    aside: null, soundChip: null, backdrop: 'none', state: 'title', stagedCount: staged ? 2 : 0,
  };
  const reef = CARS[0];
  switch (s) {
    case 'title': {
      const laps = f.has('endless') ? 'ENDLESS' : long ? '99 LAPS' : '3 LAPS';
      const diff = f.has('skill') || long ? 'SKILL 0.60' : 'NORMAL';
      const sub = staged ? `TRACK ${stSeed} · ${long ? '99 LAPS' : '5 LAPS'} · NEW WORLD` : `TRACK ${runSeed} · ${laps} · ${long ? 'NO RIVALS' : '3 RIVALS'} · ${diff}`;
      out.rows = [
        action({ id: 'race', label: 'RACE', tone: 'primary' }, { chevron: true, sub: val(sub) }),
        link({ id: 'car', label: 'CAR' }, val(long ? 'COMET FOX' : reef.name, f.has('chosen'), (long ? CARS[3] : reef).paints[0])),
        link({ id: 'setup', label: 'RACE SETUP', tags: staged ? [tag('new', long ? '5 NEW' : '2 NEW')] : [] }, val(`TRACK ${staged ? stSeed : runSeed}`, staged)),
        link({ id: 'settings', label: 'SETTINGS' }, val(long ? 'DIORAMA CAM' : 'CHASE CAM')),
        link({ id: 'controls', label: 'CONTROLS' }),
      ];
      out.ariaLabel = 'WEB RACER';
      out.help = ['Start the race on this track.', staged ? `Builds track ${stSeed}, then starts the race.` : 'Start the race on this track.', 'Choose your buggy and its paint.', 'Track, laps, rivals and difficulty.', 'Camera, music and quality.', 'Keyboard and gamepad buttons.'];
      if (staged) out.help[0] = out.help[1];
      out.prompts = [P.move(), P.select(), ...(staged ? [P.undo()] : [])];
      out.aside = {
        kind: 'next',
        title: `TRACK ${staged ? stSeed : runSeed}`,
        staged,
        caption: staged ? `NEW · ${long ? '99 LAPS' : '5 LAPS'}` : `${trackInfo(runSeed)?.lengthM ?? 612} M · ${laps}`,
        bestLabel: 'BEST LAP',
        best: staged ? '– : – –' : '0:31.42',
        track: trackInfo(staged ? stSeed : runSeed),
      };
      if (f.has('unlock')) out.soundChip = 'CLICK OR PRESS A KEY FOR SOUND';
      break;
    }
    case 'car': {
      const chosen = f.has('chosen');
      out.breadcrumb = 'TITLE / CAR';
      out.headline = ['PICK YOUR', 'BUGGY'];
      out.ariaLabel = 'PICK YOUR BUGGY';
      out.rows = CARS.map((c, i): MenuCarRow => ({
        ...base({
          id: `car:${c.id}`,
          label: c.name,
          tags: [...(i === 0 ? [tag('live', 'ON THE GRID')] : []), ...(chosen && i === 2 ? [tag('chosen', 'CHOSEN')] : [])],
        }),
        kind: 'car',
        carId: c.id,
        name: c.name,
        caption: c.caption,
        paint: c.paints[0],
        paintIndex: 0,
        paintCount: c.paints.length,
      }));
      out.focus = 3;
      out.help = CARS.map(() => 'Left and right change the paint.');
      out.prompts = [prompt('dpad-ud', 'key-ud', 'CAR', 'down'), prompt('dpad-lr', 'key-lr', 'PAINT', 'right'), prompt('cross', 'key-enter', 'CHOOSE', 'select'), P.back()];
      const fox = CARS[3];
      out.aside = {
        kind: 'car',
        name: fox.name,
        badge: 'FAST',
        description: 'Long, stable and the quickest in a straight line. Huge traction; set it up early for corners.',
        stats: [
          { label: 'SPEED', value: 5, max: 5 },
          { label: 'GRIP', value: 4, max: 5 },
          { label: 'AGILITY', value: 2, max: 5 },
          { label: 'WEIGHT', value: 4, max: 5 },
        ],
        paintLabel: 'PAINT',
        paintPosition: `1 / ${fox.paints.length}`,
        paints: fox.paints,
        paintIndex: 0,
        paintName: 'VERMILION',
        note: [run('CHOOSE', true), run(' puts it on the grid for your next race. The paint shows once the new grid is built.')],
      };
      out.stagedCount = chosen ? 1 : 0;
      break;
    }
    case 'setup': {
      const entry = f.has('entry') ? '27' : null;
      const endless = f.has('endless');
      const skill = f.has('skill');
      out.breadcrumb = 'TITLE / RACE SETUP';
      out.headline = ['RACE SETUP'];
      out.ariaLabel = 'RACE SETUP';
      out.rows = [
        stepper({ id: 'track', label: 'TRACK', tags: [tag('was', `WAS ${runSeed}`)] }, stSeed, String(stSeed), { min: 1, max: 9999, aria: `Track ${stSeed}`, wrap: true, staged: true, entry: entry ? `${entry.slice(0, 1)}` : null }),
        stepper({ id: 'laps', label: 'LAPS', tags: [tag('was', 'WAS 3')] }, endless ? 0 : long ? 99 : 5, endless ? 'ENDLESS' : long ? '99' : '5', { min: 0, max: 99, aria: endless ? 'Endless' : '5 laps', wrap: false, staged: true }),
        choice({ id: 'rivals', label: 'RIVALS', tags: long ? [tag('was', 'WAS 3')] : [] }, ['0', '1', '2', '3'], long ? 0 : 3),
        choice({ id: 'difficulty', label: 'DIFFICULTY', tags: long ? [tag('was', 'WAS 0.60')] : [] }, ['EASY', 'NORMAL', 'HARD'], skill ? null : long ? 2 : 1, { caption: skill ? 'SKILL 0.60' : null }),
        action({ id: 'start', label: 'START RACE', tone: 'go' }, { value: val([long ? '5 CHANGES' : '2 CHANGES', 'LOADS A NEW WORLD']) }),
      ];
      out.focus = 1;
      out.help = ['Every number is its own track and village.', '1 to 99 laps. One step below 1 is ENDLESS.', 'How many AI buggies start with you.', 'How quick the rivals are.', 'Go racing.'];
      out.prompts = [P.move(), P.change(), P.undo(), P.back()];
      const t = trackInfo(stSeed);
      const lapsN = endless ? 0 : long ? 99 : 5;
      out.aside = {
        kind: 'ticket',
        kicker: 'TRACK PREVIEW',
        title: `TRACK ${stSeed}`,
        track: t,
        chips: [
          ...(t ? [`${t.lengthM} M`] : []),
          ...(t && lapsN ? [`${lapsN} LAPS · ${((t.lengthM * lapsN) / 1000).toFixed(1)} KM`] : []),
          'NO BEST LAP YET',
        ],
        sticker: { text: 'NEW TRACK', sub: 'BUILT WHEN YOU START' },
      };
      out.stagedCount = 2;
      break;
    }
    case 'settings': {
      out.breadcrumb = fromPause ? 'PAUSED / SETTINGS' : 'TITLE / SETTINGS';
      out.headline = ['SETTINGS'];
      out.ariaLabel = 'SETTINGS';
      out.rows = [
        choice({ id: 'camera', label: 'CAMERA' }, ['CHASE', 'HIGH', 'DIORAMA'], 0),
        slider({ id: 'music', label: 'MUSIC' }, 7, '7'),
        choice({ id: 'quality', label: 'QUALITY', disabled: fromPause, tags: staged ? [tag('was', 'WAS HIGH')] : [] }, ['HIGH', 'QUEST'], staged ? 1 : 0, { staged }),
      ];
      out.help = ['Changes at once: look past the menu.', 'Music volume. 0 is off.', fromPause ? 'Change quality from the title screen.' : 'Applies when the next race loads.'];
      out.prompts = [P.move(), P.change(), P.back()];
      if (fromPause) {
        out.backdrop = 'pause';
        out.state = 'paused';
      }
      break;
    }
    case 'controls': {
      out.breadcrumb = fromPause ? 'PAUSED / CONTROLS' : 'TITLE / CONTROLS';
      out.headline = ['CONTROLS'];
      out.ariaLabel = 'CONTROLS';
      out.tips = TIPS;
      out.focus = -1;
      out.help = [''];
      out.prompts = [P.back()];
      out.aside = { kind: 'controls', header: ['ACTION', 'GAMEPAD', 'KEYBOARD'], rows: CONTROL_ROWS };
      if (fromPause) {
        out.backdrop = 'pause';
        out.state = 'paused';
      }
      break;
    }
    case 'pause': {
      const countdown = f.has('countdown');
      out.breadcrumb = countdown ? 'STARTING GRID' : f.has('endless') ? 'LAP 12' : 'LAP 2 / 3 · 2ND OF 4';
      out.headline = ['PAUSED'];
      out.ariaLabel = 'PAUSED';
      out.rows = [
        action({ id: 'resume', label: 'RESUME' }, { chevron: true }),
        action({ id: 'restart', label: 'RESTART RACE' }),
        choice({ id: 'camera', label: 'CAMERA' }, ['CHASE', 'HIGH', 'DIORAMA'], long ? 2 : 0, { arrows: true }),
        slider({ id: 'music', label: 'MUSIC' }, 7, null),
        link({ id: 'settings', label: 'SETTINGS' }),
        link({ id: 'controls', label: 'CONTROLS' }),
        action({ id: 'quit', label: 'QUIT TO TITLE', tone: 'danger' }),
      ];
      out.help = [countdown ? 'The countdown starts again.' : 'Carry on where you left off.', 'Back to the grid, same track.', 'Changes the view at once.', 'Music volume.', '', '', 'Ends this race.'];
      out.prompts = [P.select(), prompt('options', 'key-esc', 'RESUME', 'pause')];
      out.backdrop = 'pause';
      out.state = 'paused';
      break;
    }
    case 'confirm': {
      const restart = f.has('restart');
      out.breadcrumb = restart ? 'PAUSED / RESTART RACE' : 'PAUSED / QUIT TO TITLE';
      out.headline = [restart ? 'RESTART?' : 'QUIT?'];
      out.ariaLabel = out.headline[0];
      out.say = restart
        ? 'This race starts again from the grid: lap 2 of 3, running 2nd.'
        : `This race ends here: lap 2 of 3, running 2nd. Your best lap on Track ${runSeed} is kept.`;
      out.rows = [
        action({ id: 'keep', label: 'KEEP RACING' }, { chevron: true }),
        action({ id: 'confirm', label: restart ? 'RESTART RACE' : 'QUIT TO TITLE', tone: 'danger' }),
      ];
      out.help = ['', ''];
      out.prompts = [P.move(), P.select(), P.back()];
      out.backdrop = 'pause';
      out.state = 'paused';
      break;
    }
    case 'post': {
      const first = f.has('first');
      out.ariaLabel = 'RACE FINISHED';
      out.rows = [
        action({ id: 'again', label: 'RACE AGAIN', tone: 'primary' }, { sub: val(`TRACK ${runSeed} · SAME GRID`) }),
        action({ id: 'next', label: 'NEXT TRACK' }, { sub: val(`TRACK ${runSeed + 1} · NEW WORLD`) }),
        action({ id: 'changeCar', label: 'CHANGE CAR' }, { sub: val(long ? 'COMET FOX' : reef.name, false, reef.paints[0]) }),
        action({ id: 'title', label: 'TITLE' }, { sub: val('MAIN MENU') }),
      ];
      out.help = ['', '', '', ''];
      out.prompts = [P.move(), P.select(), P.back('TITLE')];
      out.aside = { kind: 'medal', place: first ? 1 : 2, ordinal: first ? 'ST' : 'ND', caption: 'PLACE', gold: first };
      out.backdrop = 'post';
      out.state = 'post';
      break;
    }
  }
  if (s === 'title' || s === 'car' || s === 'setup') out.stagedCount = staged ? out.stagedCount : out.stagedCount;
  return out;
}

let version = 0;
let serial = 0;

/** A full snapshot with row `focus` focused. */
function snapshotOf(b: Built, focus: number, s: MenuScreenId, newScreen: boolean): MenuSnapshot {
  if (newScreen) serial++;
  const f = b.rows.length ? Math.max(0, Math.min(b.rows.length - 1, focus)) : -1;
  let fi = f;
  if (fi >= 0 && b.rows[fi].disabled) fi = b.rows.findIndex((r) => !r.disabled);
  const rows = b.rows.map((r, i) => (i === fi ? { ...r, focused: true } : { ...r, focused: false }) as MenuRow);
  const focused = rows[fi];
  return {
    version: ++version,
    serial,
    state: b.state,
    screen: s,
    rows,
    focus: fi,
    breadcrumb: b.breadcrumb,
    headline: b.headline,
    ariaLabel: b.ariaLabel,
    say: b.say,
    tips: b.tips,
    help: fi >= 0 ? b.help[fi] ?? '' : b.help[0] ?? '',
    prompts: b.prompts,
    aside: b.aside,
    soundChip: b.soundChip,
    backdrop: b.backdrop,
    repeat: focused && focused.kind === 'stepper' ? focused.repeat : 'normal',
    device: kb ? 'keyboard' : 'gamepad',
    stagedCount: b.stagedCount,
  };
}

// ───────────────────────── backdrop + post HUD ─────────────────────────

const PICS = '/design-documents/menu-mockups/';
interface Backdrop {
  pic: string;
  style: string;
  filter?: string;
  /** No title-camera offset: the frame centred (post-race). */
  plain?: boolean;
}
function backdropFor(s: MenuScreenId, f: Set<string>): Backdrop {
  const pausePic: Backdrop = { pic: 'native-backdrop-race.png', style: 'right:-8%;bottom:-8%;left:6%', filter: 'saturate(.72)' };
  if (f.has('paused') && (s === 'settings' || s === 'controls')) return pausePic;
  switch (s) {
    case 'car':
      return { pic: 'final-bg-comet.png', style: 'right:-6%;bottom:-6%;left:9%' };
    case 'setup':
    case 'settings':
      return { pic: 'arcade-clean-chase.png', style: 'right:-24%;bottom:-24%' };
    case 'pause':
    case 'confirm':
      return pausePic;
    case 'post':
      return { pic: 'native-backdrop-race.png', style: '', plain: true };
    default:
      return { pic: 'arcade-clean-chase.png', style: '' };
  }
}

function paintBackdrop(stage: HTMLElement, s: MenuScreenId, f: Set<string>): void {
  const mode = params.get('bg') ?? 'picture';
  if (mode === 'none') return;
  const bg = document.createElement('div');
  if (mode === 'color') {
    bg.className = 'bg color';
  } else {
    const b = backdropFor(s, f);
    // as final.html: the plain frame under the shifted one (shows where the
    // shifted copy starts right of the left edge)
    const under = document.createElement('div');
    under.className = 'bg';
    under.style.backgroundImage = `url(${PICS}${b.pic})`;
    if (b.filter) under.style.filter = b.filter;
    stage.appendChild(under);
    bg.className = b.plain ? 'bg' : 'bg shift';
    bg.style.cssText = b.style;
    bg.style.backgroundImage = `url(${PICS}${b.pic})`;
    if (b.filter) bg.style.filter = b.filter;
  }
  stage.appendChild(bg);
}

/** Post-race: the REAL race HUD with a finished snapshot (as final-post.png). */
function postHud(stage: HTMLElement, first: boolean): Hud {
  const hud = new Hud({ parent: stage, animate: !shot });
  const laps = [33.1, 31.07, 32.76];
  const snap: HudSnapshot = {
    phase: 'finished',
    countdown: null,
    inputLocked: false,
    raceTime: 98.27,
    speedKmh: 0,
    bar: 0,
    lap: 3,
    laps: 3,
    lapTime: 32.76,
    lastLap: 32.76,
    bestLap: 31.07,
    position: first ? 1 : 2,
    count: 4,
    wrongWay: false,
    offTrack: false,
    lapProgress: 0,
    needsReset: null,
    flash: null,
    finish: { totalTime: 98.27, lapTimes: laps, bestLapIndex: 1, position: first ? 1 : 2, count: 4, bestLap: 31.07, newRecord: true },
  };
  hud.update(snap);
  return hud;
}

// ───────────────────────── report: spec acceptance check 4 ─────────────────────────

interface Check {
  id: string;
  value: number | string | boolean | null;
  target: string;
  pass: boolean;
}

const SIZES: [number, number][] = [
  [1600, 900],
  [1024, 768],
  [900, 600],
  [800, 500],
  [620, 900],
];
const CASES: { screen: MenuScreenId; state: string }[] = [
  { screen: 'title', state: '' },
  { screen: 'title', state: 'staged,unlock' },
  { screen: 'title', state: 'staged,kb' },
  { screen: 'title', state: 'endless' },
  { screen: 'car', state: '' },
  { screen: 'car', state: 'chosen,kb' },
  { screen: 'setup', state: '' },
  { screen: 'setup', state: 'staged' },
  { screen: 'setup', state: 'endless,skill,kb' },
  { screen: 'setup', state: 'entry' },
  { screen: 'settings', state: 'staged' },
  { screen: 'settings', state: 'paused' },
  { screen: 'controls', state: '' },
  { screen: 'controls', state: 'paused,kb' },
  { screen: 'pause', state: '' },
  { screen: 'pause', state: 'countdown,kb' },
  { screen: 'confirm', state: '' },
  { screen: 'confirm', state: 'restart' },
  { screen: 'post', state: '' },
  { screen: 'post', state: 'first' },
];
/** Worst-case texts: measured and reported, not gated (the model may need
 * shorter wording; see the lab report's stats). */
const LONG_CASES: { screen: MenuScreenId; state: string }[] = [
  { screen: 'title', state: 'endless,skill' },
  { screen: 'title', state: 'long' },
  { screen: 'title', state: 'long,staged' },
  { screen: 'setup', state: 'long' },
  { screen: 'pause', state: 'long' },
  { screen: 'post', state: 'long' },
];

const visible = (e: Element): boolean => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
const hasOwnText = (e: Element): boolean => Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');

/** Top of `e` in `ancestor`'s padding box, transform-free (offset chain). */
function offsetTopIn(e: HTMLElement, ancestor: HTMLElement): number | null {
  let y = 0;
  let n: HTMLElement | null = e;
  while (n && n !== ancestor) {
    y += n.offsetTop;
    const p = n.offsetParent as HTMLElement | null;
    if (!p || (p !== ancestor && !ancestor.contains(p))) return null;
    if (p !== ancestor) y += p.clientTop;
    n = p;
  }
  return n === ancestor ? y : null;
}

/** Left of `e` in `ancestor`'s padding box, transform-free (offset chain). */
function offsetIn(e: HTMLElement, ancestor: HTMLElement): number | null {
  let x = 0;
  let n: HTMLElement | null = e;
  while (n && n !== ancestor) {
    x += n.offsetLeft;
    const p = n.offsetParent as HTMLElement | null;
    if (!p) return null;
    if (p !== ancestor && !ancestor.contains(p)) return null;
    // offsetLeft is from the offsetParent's padding edge; add its border to
    // continue the chain from the border box.
    if (p !== ancestor) x += p.clientLeft;
    n = p;
  }
  return n === ancestor ? x : null;
}

const SMALL_OK = '.rmenu-tag, .rmenu-g, .rmenu-sticker small';

interface CaseResult {
  checks: Check[];
  stats: Record<string, number | string | boolean | null>;
}

function measureCase(screenId: MenuScreenId, state: string, w: number, h: number, gate: boolean, src: Source = 'mock'): CaseResult {
  const holder = document.getElementById('stage') as HTMLElement;
  holder.className = 'sized';
  holder.style.width = `${w}px`;
  holder.style.height = `${h}px`;
  holder.textContent = '';
  const f = new Set(state.split(',').filter(Boolean));
  const view = createMenuView({ parent: holder, animate: false, onPointer: () => undefined });
  if (src === 'model') view.render(modelSnapshot(screenId, f, w, h, null));
  else {
    const b = build(screenId, f);
    view.render(snapshotOf(b, b.focus, screenId, true));
  }
  const root = view.root;
  const key = `${src === 'model' ? 'model.' : ''}${w}x${h}.${screenId}${state ? '+' + state.replace(/,/g, '+') : ''}`;
  const checks: Check[] = [];
  const stats: CaseResult['stats'] = {};
  const add = (id: string, value: number | string | boolean | null, target: string, pass: boolean): void => {
    if (gate) checks.push({ id: `layout.${key}.${id}`, value, target, pass });
    else stats[`long.${key}.${id}`] = `${value} (${pass ? 'ok' : 'FAIL'}, ${target})`;
  };
  const holderRect = holder.getBoundingClientRect();

  // 0 — which rows the view had to fit (stack / snug / smaller captions),
  // and by how much they overflowed before (reported, not gated)
  root.querySelectorAll<HTMLElement>('.rmenu-row').forEach((row) => {
    const shrunk = Array.from(row.querySelectorAll<HTMLElement>('[data-fit]')).some((f) => f.style.fontSize !== '');
    const how = [row.classList.contains('rmenu-stack') ? 'stack' : '', row.classList.contains('rmenu-snug') ? 'snug' : '', shrunk ? 'shrink' : ''].filter(Boolean);
    if (!how.length) return;
    const keep = row.className;
    const sizes = Array.from(row.querySelectorAll<HTMLElement>('[data-fit]')).map((f) => f.style.fontSize);
    row.classList.remove('rmenu-stack', 'rmenu-snug');
    row.querySelectorAll<HTMLElement>('[data-fit]').forEach((f) => (f.style.fontSize = ''));
    let raw = -Infinity;
    row.querySelectorAll<HTMLElement>('*').forEach((e) => {
      const x = offsetIn(e, row);
      if (x !== null && e.offsetParent !== null) raw = Math.max(raw, x + e.offsetWidth - row.clientWidth);
    });
    row.className = keep;
    row.querySelectorAll<HTMLElement>('[data-fit]').forEach((f, i) => (f.style.fontSize = sizes[i]));
    stats[`fit.${key}.${row.dataset.row}`] = `${how.join('+')} (overflow before ${Math.round(raw * 10) / 10} px)`;
  });

  // 1 — row content inside its row (padding box; offsets, so the skew and
  // the counter-skew of the text do not count)
  let rowWorst = -Infinity;
  let rowWhat = '';
  root.querySelectorAll<HTMLElement>('.rmenu-row').forEach((row) => {
    if (!visible(row)) return;
    row.querySelectorAll<HTMLElement>('*').forEach((e) => {
      if (!(e instanceof HTMLElement) || !visible(e)) return;
      const x = offsetIn(e, row);
      if (x === null) return;
      const over = Math.max(-x, x + e.offsetWidth - row.clientWidth);
      if (over > rowWorst) {
        rowWorst = over;
        rowWhat = `${row.dataset.row} ${e.className || e.tagName}`;
      }
    });
  });
  if (rowWorst > -Infinity) add('rowOverflowPx', Math.round(rowWorst * 10) / 10, `<= 1.5, into the rim at most (${rowWhat})`, rowWorst <= 1.5);

  // 2 — nothing in the band crosses its right edge (band coordinates)
  const band = root.querySelector<HTMLElement>('.rmenu-band');
  if (band) {
    let worst = -Infinity;
    let what = '';
    band.querySelectorAll<HTMLElement>('*').forEach((e) => {
      if (!(e instanceof HTMLElement) || !visible(e)) return;
      const isRow = e.classList.contains('rmenu-row');
      if (!isRow && !hasOwnText(e) && !e.classList.contains('rmenu-hints')) return;
      const x = offsetIn(e, band);
      if (x === null) return;
      let right = x + e.offsetWidth;
      const row = e.closest<HTMLElement>('.rmenu-row');
      if (row) {
        const m = new DOMMatrixReadOnly(getComputedStyle(row).transform === 'none' ? undefined : getComputedStyle(row).transform);
        right += m.m41;
      }
      const over = right - band.clientWidth;
      if (over > worst) {
        worst = over;
        what = (row?.dataset.row ?? '') + ' ' + (e.className || e.tagName);
      }
    });
    add('bandEdgePx', Math.round(worst * 10) / 10, `<= 0 (${what.trim()})`, worst <= 0);

    // band content on screen (the band itself runs off the window on purpose)
    let off = -Infinity;
    let offWhat = '';
    band.querySelectorAll<HTMLElement>('.rmenu-row, .rmenu-hints, .rmenu-help, .rmenu-head > *, .rmenu-logo > *, .rmenu-tips li, .rmenu-ctlb-row').forEach((e) => {
      if (!visible(e)) return;
      const r = e.getBoundingClientRect();
      const o = Math.max(r.right - holderRect.right, holderRect.left - r.left, r.bottom - holderRect.bottom, holderRect.top - r.top);
      if (o > off) {
        off = o;
        offWhat = e.dataset.row ?? e.className;
      }
    });
    if (off > -Infinity) add('bandInWindowPx', Math.round(off * 10) / 10, `<= 0 (${offWhat})`, off <= 0);
  }

  // 3 — plates inside the window and clear of the band (with its stripes)
  // (below 5:4 the sound chip sits at the top of the band on purpose)
  const narrow = w / h < 1.25;
  const asides = Array.from(root.querySelectorAll<HTMLElement>(`.rmenu-aside, .rmenu-actions, .rmenu-float-hints .rmenu-hints${narrow ? '' : ', .rmenu-unlock'}`)).filter(visible);
  if (asides.length) {
    let off = -Infinity;
    let clear = Infinity;
    let clearWhat = '';
    let bandRect: DOMRect | null = null;
    let stripe = 0;
    if (band) {
      bandRect = band.getBoundingClientRect();
      stripe = Number.parseFloat(getComputedStyle(band).borderRightWidth) * 1.5;
    }
    const tan10 = Math.tan((10 * Math.PI) / 180);
    for (const a of asides) {
      const r = a.getBoundingClientRect();
      off = Math.max(off, r.right - holderRect.right, holderRect.left - r.left, r.bottom - holderRect.bottom, holderRect.top - r.top);
      if (bandRect) {
        const skew = a.classList.contains('rmenu-sheet') ? Math.tan((4 * Math.PI) / 180) : a.classList.contains('rmenu-plate') ? tan10 : 0;
        // band's outer edge (incl. the cyan stripe) at height y
        const edge = (y: number): number => bandRect!.right + stripe - (y - bandRect!.top) * tan10;
        const topLeft = r.left + (skew * r.height) / 2;
        const botLeft = r.left - (skew * r.height) / 2;
        const gap = Math.min(topLeft - edge(r.top), botLeft - edge(r.bottom));
        if (gap < clear) {
          clear = gap;
          clearWhat = a.className.split(' ').slice(0, 3).join(' ');
        }
      }
    }
    add('platesInWindowPx', Math.round(off * 10) / 10, '<= 0', off <= 0);
    if (clear < Infinity) add('platesClearBandPx', Math.round(clear * 10) / 10, `>= 0 (${clearWhat})`, clear >= 0);
  }

  // 4 — minimum font size
  let minText = Infinity;
  let minSmall = Infinity;
  let minWhat = '';
  root.querySelectorAll<HTMLElement>('*').forEach((e) => {
    if (!(e instanceof HTMLElement) || !hasOwnText(e) || !visible(e)) return;
    const px = Number.parseFloat(getComputedStyle(e).fontSize);
    if (e.closest(SMALL_OK)) minSmall = Math.min(minSmall, px);
    else if (px < minText) {
      minText = px;
      minWhat = e.className || e.tagName;
    }
  });
  if (minText < Infinity) add('fontMinPx', Math.round(minText * 100) / 100, `>= 13 (${minWhat})`, minText >= 12.99);
  if (minSmall < Infinity) add('fontMinSmallPx', Math.round(minSmall * 100) / 100, '>= 11 (tags, glyph caps)', minSmall >= 10.99);

  // 5 — text inside its plate (transform-free box; the sticker hangs off the
  // ticket on purpose). Gated in the worst-case texts too (4-digit tracks).
  const gated = (id: string, value: number, target: string, pass: boolean): void => {
    checks.push({ id: `layout.${key}.${id}`, value, target, pass });
  };
  let plateWorst = -Infinity;
  let plateWhat = '';
  root.querySelectorAll<HTMLElement>('.rmenu-plate').forEach((plate) => {
    if (!visible(plate)) return;
    plate.querySelectorAll<HTMLElement>('*').forEach((e) => {
      if (!(e instanceof HTMLElement) || !hasOwnText(e) || !visible(e) || e.closest('.rmenu-sticker')) return;
      const x = offsetIn(e, plate);
      const y = offsetTopIn(e, plate);
      if (x === null || y === null) return;
      const over = Math.max(-x, x + e.offsetWidth - plate.clientWidth, -y, y + e.offsetHeight - plate.clientHeight);
      if (over > plateWorst) {
        plateWorst = over;
        plateWhat = `${plate.className.split(' ').slice(0, 4).join(' ')}: ${e.className || e.tagName} '${(e.textContent ?? '').slice(0, 24)}'`;
      }
    });
  });
  if (plateWorst > -Infinity) gated('plateTextPx', Math.round(plateWorst * 10) / 10, `<= 1.5 (${plateWhat})`, plateWorst <= 1.5);

  // 6 — no sticker / car-row tag over other text: glyph boxes (ranges) of
  // every other text node, sampled on a grid, against the overlay's own box
  // turned by its own rotation (the sticker's 5°).
  let overlayWorst = 0;
  let overlayWhat = '';
  const range = document.createRange();
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? '').trim()) texts.push(n as Text);
  root.querySelectorAll<HTMLElement>('.rmenu-sticker, .rmenu-car-row .rmenu-tags').forEach((o) => {
    if (!visible(o)) return;
    const b = o.getBoundingClientRect();
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const tf = getComputedStyle(o).transform;
    const m = new DOMMatrixReadOnly(tf === 'none' ? undefined : tf);
    const th = Math.atan2(m.b, m.a);
    const c = Math.cos(-th);
    const s = Math.sin(-th);
    const hw = o.offsetWidth / 2;
    const hh = o.offsetHeight / 2;
    const inside = (px: number, py: number): boolean => {
      const dx = px - cx;
      const dy = py - cy;
      return Math.abs(dx * c - dy * s) < hw && Math.abs(dx * s + dy * c) < hh;
    };
    for (const t of texts) {
      if (o.contains(t) || !visible(t.parentElement as Element)) continue;
      range.selectNodeContents(t);
      for (const r of Array.from(range.getClientRects())) {
        // inset the glyph box a little: line boxes are taller than the ink
        const x0 = r.left + 1;
        const x1 = r.right - 1;
        const y0 = r.top + r.height * 0.2;
        const y1 = r.bottom - r.height * 0.2;
        if (x1 <= x0 || y1 <= y0) continue;
        let hits = 0;
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) if (inside(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * j) / 4)) hits++;
        const depth = hits ? ((x1 - x0) * hits) / 45 : 0;
        if (depth > overlayWorst) {
          overlayWorst = depth;
          overlayWhat = `${o.className.split(' ')[0]} over '${(t.textContent ?? '').trim().slice(0, 24)}'`;
        }
      }
    }
  });
  gated('overlayTextPx', Math.round(overlayWorst * 10) / 10, `0 (${overlayWhat || 'no overlap'})`, overlayWorst === 0);

  view.dispose();
  holder.textContent = '';
  return { checks, stats };
}

async function runReport(): Promise<void> {
  const status = document.getElementById('status') as HTMLElement;
  const result = document.getElementById('result') as HTMLElement;
  const out: LabReport = {
    page: 'menu-lab.html',
    query: location.search,
    totals: { simSeconds: 0 },
    scorecard: { text: '' },
    errors: [],
    stats: {},
    checks: [],
  };
  try {
    status.textContent = 'measuring…';
    // Both sources: the hand-built mock snapshots (the mockup's exact texts)
    // and the REAL MenuModel's snapshots of the same states (real car data,
    // real track outlines and the model's own wording).
    await loadModelData();
    for (const src of ['mock', 'model'] as const) {
      for (const [w, h] of SIZES) {
        for (const c of CASES) {
          const r = measureCase(c.screen, c.state, w, h, true, src);
          out.checks.push(...r.checks);
          Object.assign(out.stats, r.stats);
        }
        for (const c of LONG_CASES) Object.assign(out.stats, measureCase(c.screen, c.state, w, h, false, src).stats);
      }
    }
    const failed = out.checks.filter((c) => !c.pass);
    out.stats.cases = 2 * CASES.length * SIZES.length;
    out.stats.checks = out.checks.length;
    out.stats.failed = failed.length;
    const longFails = Object.entries(out.stats).filter(([k, v]) => k.startsWith('long.') && String(v).includes('FAIL'));
    out.scorecard.text = [
      `menu layout: ${out.checks.length - failed.length} / ${out.checks.length} checks pass (${CASES.length} cases × ${SIZES.length} sizes × mock + model)`,
      ...failed.map((c) => `  FAIL ${c.id} = ${c.value} (target ${c.target})`),
      `worst-case texts (not gated): ${longFails.length} failing measurements`,
      ...longFails.map(([k, v]) => `  ${k} = ${v}`),
    ].join('\n');
    result.textContent = JSON.stringify(out);
    status.textContent = '';
    document.title = 'done';
  } catch (err) {
    out.fatal = String(err instanceof Error ? err.stack ?? err.message : err);
    result.textContent = JSON.stringify(out);
    document.title = 'error';
  }
}

// ───────────────────────── the REAL model (src=model, the default) ─────────────────────────

type Source = 'mock' | 'model';
/** `src=model` (default): snapshots of the real MenuModel (src/ui/menu/MenuModel.ts)
 * with the real car data (assets, handling presets, rigs) and real track
 * outlines; `src=mock`: the hand-built snapshots above (the mockup's texts). */
const source: Source = params.get('src') === 'mock' ? 'mock' : 'model';

let modelCars: MenuCarInfo[] = [];
const modelTracks = new Map<number, MenuTrackInfo>();
async function loadModelData(): Promise<void> {
  if (modelCars.length === 0) modelCars = await menuCars();
}
/** Real outlines (generateTerrain, ~0.2 s per seed, cached). */
const modelTrack = (seed: number): MenuTrackInfo => {
  let t = modelTracks.get(seed);
  if (!t) {
    t = trackInfoOf(seed, generateTerrain(seed).track);
    modelTracks.set(seed, t);
  }
  return t;
};

/** The page options a variant runs with (`long`: worst-case texts). */
function runningFor(f: Set<string>): GameOptions {
  const q = new URLSearchParams();
  if (f.has('long')) {
    q.set('seed', '1100');
    q.set('laps', '99');
    q.set('rivals', '0');
  }
  if (f.has('endless')) q.set('laps', '0');
  if (f.has('skill') || f.has('long')) q.set('difficulty', '0.6');
  return parseGameOptions(`?${q}`, '');
}

function stagedFor(f: Set<string>): Partial<GameOptions> | undefined {
  const st: Partial<GameOptions> = {};
  if (f.has('staged')) {
    st.seed = f.has('long') ? 9999 : 27;
    st.laps = f.has('long') ? 98 : 5;
  }
  if (f.has('chosen')) st.car = 'comet-fox';
  return Object.keys(st).length ? st : undefined;
}

function factsFor(s: MenuScreenId, f: Set<string>, running: GameOptions, w: number, h: number): MenuFacts {
  const titleSide = (s === 'title' || s === 'car' || s === 'setup' || s === 'settings' || s === 'controls') && !f.has('paused');
  return {
    time: performance.now() / 1000,
    phase: titleSide || f.has('countdown') ? 'countdown' : 'racing',
    lap: f.has('countdown') ? 1 : 2,
    laps: running.laps,
    place: 2,
    count: running.rivals + 1,
    finishedFor: s === 'post' ? 3 : null,
    finishPlace: s === 'post' ? (f.has('first') ? 1 : 2) : null,
    // a real time even in the worst-case texts: wider than the placeholder
    bestLap: 31.42,
    view: 'chase',
    musicVolume: 0.7,
    audioUnlocked: !f.has('unlock'),
    padConnected: !f.has('kb'),
    narrow: w < h * 1.25,
  };
}

const idleCommand = (f: Set<string>): MenuCommand => ({
  up: false, down: false, left: false, right: false, select: false, back: false, escape: false, pause: false,
  undo: false, random: false, digit: null, device: f.has('kb') ? 'keyboard' : 'gamepad', autoPause: false, pointer: [],
});

function makeModel(f: Set<string>, host: MenuHost): { model: MenuModel; running: GameOptions } {
  const running = runningFor(f);
  let r = 0x2545f491;
  const model = createMenuModel({
    running,
    host,
    cars: modelCars,
    tracks: { get: modelTrack },
    // the worst-case texts carry a real best lap (wider than the placeholder)
    bestLap: () => (f.has('long') ? 31.42 : null),
    random: () => {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
      return r / 4294967296;
    },
    view: 'chase',
    musicVolume: 0.7,
    staged: stagedFor(f),
  });
  return { model, running };
}

const silentHost: MenuHost = {
  startRace: () => undefined, pause: () => undefined, resume: () => undefined, restartRace: () => undefined,
  enterTitle: () => undefined, enterPost: () => undefined, setView: () => undefined, setMusicVolume: () => undefined,
  previewCar: () => undefined, reload: () => undefined,
};

/** The model pinned on `s` in variant `f`, as the game would draw it at a
 * w × h stage (`focusIndex`: focus that row, as a Tab would). */
function pinnedModel(s: MenuScreenId, f: Set<string>, w: number, h: number, host: MenuHost, focusIndex: number | null): { model: MenuModel; facts: MenuFacts; running: GameOptions } {
  const { model, running } = makeModel(f, host);
  model.pin({ screen: s, from: f.has('paused') ? 'paused' : 'title', confirm: f.has('restart') ? 'restart' : 'quit' });
  const facts = factsFor(s, f, running, w, h);
  const cmd = idleCommand(f);
  model.update(cmd, facts);
  if (f.has('entry') && s === 'setup') {
    model.update({ ...cmd, digit: 2 }, facts);
    model.update({ ...cmd, digit: 7 }, facts);
  }
  if (focusIndex !== null) {
    const row = model.snapshot().rows[focusIndex];
    if (row) model.update({ ...cmd, pointer: [{ kind: 'focus', row: row.id, via: 'tab' }] }, facts);
  }
  return { model, facts, running };
}

function modelSnapshot(s: MenuScreenId, f: Set<string>, w: number, h: number, focusIndex: number | null): MenuSnapshot {
  return pinnedModel(s, f, w, h, silentHost, focusIndex).model.snapshot();
}

/** Live page on the real model: keyboard and pads through the real
 * MenuInput, pointer actions from the view, a host that only logs (RACE /
 * RESUME close the menu: Esc or P opens the pause again; a "go racing" row
 * with staged values logs the reload query instead of reloading). */
async function liveModel(): Promise<void> {
  await loadModelData();
  const holder = document.getElementById('stage') as HTMLElement;
  const size = /^(\d+)x(\d+)$/.exec(params.get('stage') ?? '');
  if (size) {
    holder.className = 'sized';
    holder.style.width = `${size[1]}px`;
    holder.style.height = `${size[2]}px`;
  }
  paintBackdrop(holder, screen, flags);
  if (screen === 'post') postHud(holder, flags.has('first'));
  const logEl = document.getElementById('log') as HTMLElement;
  const log = (text: string): void => {
    logEl.textContent = `${text}\n${logEl.textContent ?? ''}`.slice(0, 2000);
  };
  const w = size ? Number(size[1]) : innerWidth;
  const h = size ? Number(size[2]) : innerHeight;
  let facts: MenuFacts | null = null;
  const host: MenuHost = {
    startRace: () => {
      log('host.startRace()  (Esc / P: pause)');
      if (facts) facts.phase = 'racing';
    },
    pause: () => log('host.pause()'),
    resume: () => log('host.resume()'),
    restartRace: () => {
      log('host.restartRace()');
      if (facts) {
        facts.phase = 'countdown';
        facts.finishedFor = null;
        facts.finishPlace = null;
      }
    },
    enterTitle: (openCar) => log(`host.enterTitle(${openCar})`),
    enterPost: () => log('host.enterPost()'),
    setView: (mode) => {
      log(`host.setView(${mode})`);
      if (facts) facts.view = mode;
    },
    setMusicVolume: (v) => {
      log(`host.setMusicVolume(${v})`);
      if (facts) facts.musicVolume = v;
    },
    previewCar: (id) => log(`host.previewCar(${id})`),
    reload: (o) => log(`host.reload → ${optionsToQuery(running, { ...o, view: facts?.view ?? 'chase', music: facts?.musicVolume ?? 0.7 })}`),
  };
  const focusParam = Number.parseInt(params.get('focus') ?? '', 10);
  const pinned = pinnedModel(screen, flags, w, h, host, Number.isFinite(focusParam) ? focusParam : null);
  const model = pinned.model;
  const running = pinned.running;
  facts = pinned.facts;
  const input = createMenuInput();
  const view = createMenuView({ parent: size ? holder : undefined, animate: !shot, onPointer: (a) => {
    log(JSON.stringify(a));
    input.push(a);
  } });
  const draw = (): void => {
    const snap = model.snapshot();
    input.setRepeat(snap.repeat);
    input.setCapturing(snap.state !== 'race');
    view.render(snap);
  };
  draw();
  if (shot) return;
  const tick = (): void => {
    const now = performance.now();
    if (facts) {
      facts.time = now / 1000;
      facts.narrow = (size ? w : innerWidth) < (size ? h : innerHeight) * 1.25;
      model.update(input.poll(now), facts);
      for (const e of model.effects) {
        if (e.kind === 'guard') input.guard();
        else log(`blip ${e.sound}`);
      }
    }
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  log('REAL model: keys / pad / pointer drive it; the host only logs');
}

// ───────────────────────── page ─────────────────────────

function links(): void {
  const nav = document.getElementById('links') as HTMLElement;
  for (const s of SCREENS) {
    const a = document.createElement('a');
    const q = new URLSearchParams(location.search);
    q.set('screen', s);
    q.delete('focus');
    a.href = `?${q}`;
    a.textContent = s;
    nav.appendChild(a);
  }
  for (const st of ['staged', 'kb', 'paused', 'countdown', 'restart', 'first', 'chosen', 'entry', 'endless', 'skill', 'unlock', 'long']) {
    const a = document.createElement('a');
    const q = new URLSearchParams(location.search);
    const set = new Set(flags);
    if (set.has(st)) set.delete(st);
    else set.add(st);
    q.set('state', [...set].join(','));
    a.href = `?${q}`;
    a.textContent = (flags.has(st) ? '−' : '+') + st;
    nav.appendChild(a);
  }
}

function live(): void {
  const holder = document.getElementById('stage') as HTMLElement;
  const size = /^(\d+)x(\d+)$/.exec(params.get('stage') ?? '');
  if (size) {
    holder.className = 'sized';
    holder.style.width = `${size[1]}px`;
    holder.style.height = `${size[2]}px`;
  }
  paintBackdrop(holder, screen, flags);
  if (screen === 'post') postHud(holder, flags.has('first'));
  const logEl = document.getElementById('log') as HTMLElement;
  const log = (text: string): void => {
    logEl.textContent = `${text}\n${logEl.textContent ?? ''}`.slice(0, 2000);
  };

  let built = build(screen, flags);
  const focusParam = Number.parseInt(params.get('focus') ?? '', 10);
  let focus = Number.isFinite(focusParam) ? focusParam : built.focus;
  let view: MenuViewHandle | null = null;
  const redraw = (newScreen = false): void => view?.render(snapshotOf(built, focus, screen, newScreen));
  const rowIndex = (id: string): number => built.rows.findIndex((r) => r.id === id);
  const replaceRow = (i: number, r: MenuRow): void => {
    built = { ...built, rows: built.rows.map((x, j) => (j === i ? r : x)) };
  };
  const change = (i: number, delta: number, absolute: number | null): void => {
    const r = built.rows[i];
    if (!r) return;
    if (r.kind === 'choice' && r.selected !== null) {
      const n = absolute ?? Math.max(0, Math.min(r.options.length - 1, r.selected + delta));
      replaceRow(i, { ...r, selected: n });
    } else if (r.kind === 'stepper') {
      const v = absolute ?? r.value + delta;
      const nv = r.max === 9999 ? ((v - 1 + 9999) % 9999) + 1 : Math.max(r.min, Math.min(r.max, v));
      const text = r.id === 'laps' && nv === 0 ? 'ENDLESS' : String(nv);
      replaceRow(i, { ...r, value: nv, text, canDecrease: r.max === 9999 || nv > r.min, canIncrease: r.max === 9999 || nv < r.max });
    } else if (r.kind === 'slider') {
      const nv = Math.max(0, Math.min(10, absolute ?? r.value + delta));
      replaceRow(i, { ...r, value: nv, text: r.text === null ? null : nv === 0 ? 'OFF' : String(nv), ariaValueText: `${nv * 10} percent` });
    } else if (r.kind === 'car') {
      const car = CARS.find((c) => c.id === r.carId);
      if (!car) return;
      const pi = Math.max(0, Math.min(car.paints.length - 1, absolute ?? r.paintIndex + delta));
      replaceRow(i, { ...r, paintIndex: pi, paint: car.paints[pi] });
    }
  };
  const move = (d: number): void => {
    const n = built.rows.length;
    if (!n) return;
    let i = focus;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!built.rows[i].disabled) break;
    }
    focus = i;
  };
  const onPointer = (a: MenuPointerAction): void => {
    log(JSON.stringify(a));
    if (a.kind === 'focus') focus = Math.max(0, rowIndex(a.row));
    else if (a.kind === 'activate') focus = Math.max(0, rowIndex(a.row));
    else if (a.kind === 'set') {
      focus = Math.max(0, rowIndex(a.row));
      change(focus, 0, a.value);
    } else if (a.kind === 'step') {
      focus = Math.max(0, rowIndex(a.row));
      change(focus, a.delta, null);
    } else if (a.kind === 'button') {
      if (a.button === 'down') move(1);
      else if (a.button === 'right') change(focus, 1, null);
    }
    redraw();
  };
  view = createMenuView({ parent: size ? holder : undefined, animate: !shot, onPointer });
  redraw(true);
  if (!shot) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') move(e.code === 'ArrowDown' ? 1 : -1);
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') change(focus, e.code === 'ArrowRight' ? 1 : -1, null);
      else if (e.code === 'KeyX') {
        // replay the screen entry (band slide + row fade-up)
        view?.render({ ...snapshotOf(built, focus, screen, false), screen: null, version: ++version });
        window.setTimeout(() => redraw(true), 400);
        return;
      } else return;
      e.preventDefault();
      redraw();
    });
    log('arrows: focus / change · X: replay entry · click rows, segments, pips, prompts');
  }
}

links();
if (report) void runReport();
else if (source === 'model') void liveModel().catch((e: unknown) => (fatal.textContent += `${e instanceof Error ? e.stack ?? e.message : String(e)}\n`));
else live();
