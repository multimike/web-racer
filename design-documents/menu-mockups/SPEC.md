# Web Racer menu system: implementation spec

Status: design final, nothing built. Reference mockup: `design-documents/menu-mockups/final.html`
(static HTML + CSS, open through the dev server). Read `CLAUDE.md` first; file names below are from this repo.
The working tree carries uncommitted music work in `gameAudio.ts`, `GameActions.ts`, `options.ts`,
`createScene.ts`, `contracts/camera.ts`: build on the working tree, not on HEAD.

## 0. What it is

A DOM overlay over the live 3D canvas with five jobs: title / main menu, car choice, race setup, pause,
post-race actions (plus settings, a controls sheet and one confirm prompt). No WebXR session exists yet; section 12
says what carries over.

Concept "arcade showroom": one slanted slate **band** (the HUD plate angle, skewX −10°) leans in from the left
edge with a yellow + cyan racing stripe. Everything you navigate lives in the band; the rest of the screen stays
the live, untinted toy world. Free **plates** on the right (the HUD plate) only display.

Three colour rules, used everywhere and never mixed:

| colour | meaning |
|---|---|
| YELLOW `#ffe14a` | where you are: the focused row is one solid yellow plate with ink text. Also "this is new / will change the world" in small tags and stickers (the HUD's record colour). |
| CYAN `#14e8f6` | what is set: current values, selected segment, captions. Never a focus fill. |
| RED-PINK `#ff8e98` (text) | destructive row (QUIT TO TITLE). `#d42a3c` stays the HUD's WRONG WAY colour. |

Mockup screens (all shot at 1600×900 with `tools/shot.sh`):

| `?screen=` | picture |
|---|---|
| `title` | `final-title.png`, `final-title-small.png` (900×600), `final-title-portrait.png` (620×900), `final-title-staged-kb.png` (`&staged=1&prompts=kb`) |
| `car` | `final-car.png`, `final-car-small.png` |
| `setup` | `final-setup.png`, `final-setup-small.png` |
| `settings` | `final-settings.png` |
| `controls` | `final-controls.png` |
| `pause` | `final-pause.png` |
| `confirm` | `final-confirm.png` |
| `post` | `final-post.png`, `final-post-portrait.png` (700×900) |

Mockup helpers in the same folder: `arcade-clean-chase.png`, `native-backdrop-race.png`, `final-bg-comet.png`
(real game frames without HUD), `arcade-frame.html` (makes such frames). `&prompts=kb` shows keycaps,
`&staged=1` the title with staged changes.

## 1. Visual tokens

Take the CSS from `final.html` (class names get the prefix `rmenu-`). The numbers that matter:

**Unit.** `--u = min(1.0627cqh, 0.68cqw)` on the menu stage (container-type size, like `.rhud`): the HUD's
1/94.1 of the height, capped by the width so band + plates fit down to 3:2. The mockup writes it as `rem` on
`<html>`; in the game do NOT touch `html`: replace `Nrem` by `calc(N * var(--u))` (or set `font-size: var(--u)`
on the stage and give sizes in `em` on leaf elements only, as `Hud.ts` does). Below aspect 5:4 the unit is
`min(1.0627cqh, 1.5cqw)` and the right-hand plates are dropped (section 3.9). The post-race pieces use the
HUD's own unit `min(1.0627cqh, 1.5625cqw)` so they line up with the finish panel.

**Colours.** slate `#141e27`, ink `#0b141c`, rim `#aebbc2`, cyan `#14e8f6`, yellow `#ffe14a`, pink `#ff8e98`,
cream `#fff6dc`, cobalt `#2b4fc4`, body text white, secondary text `#e9edef` / `#cfd8dd`. These repeat the
constants in `Hud.ts`; copy them into the menu CSS with a comment naming `Hud.ts` (do not refactor `Hud.ts`).

**Type.** The HUD stack (`system-ui, -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue",
Arial, sans-serif`), italic, 900 (800 for captions), `tabular-nums`, HUD drop shadow
`0.035em 0.055em 0 rgba(8,14,20,.6), 0 0.09em 0.22em rgba(8,14,20,.35)`.

| element | size (u) | notes |
|---|---|---|
| logo RACER | 11.6 | white, `-webkit-text-stroke: 0.11em ink; paint-order: stroke fill`, shadow cyan then ink |
| logo WEB | 4.4 | yellow, letter-spacing 0.34em |
| screen headline | 6.4 (PAUSED / QUIT? 9.2) | same sticker treatment, stroke 0.09em |
| primary row label (RACE) | 6.2 | |
| row label | 3.1 (pause 2.9) | letter-spacing 0.03em |
| stepper number | 3.4 | |
| segment text | 2.3 | |
| caption `--cap` | `max(2.05u, 13px)` | row values, sub-lines, breadcrumb, help line, prompts, chips. Nothing smaller except tags `max(1.5u, 11px)` |

**Band.** `left: -12u; width: 68u` (setup / settings 78u, pause / confirm 59u), full height,
`transform: skewX(-10deg); transform-origin: 0 100%`, background
`linear-gradient(90deg, rgba(20,30,39,.97), rgba(20,30,39,.95) 60%, rgba(20,30,39,.9))`,
`border-right: 1u solid yellow`, `box-shadow: 1u 0 0 rgba(11,20,28,.55), 1.5u 0 0 cyan, 3u 0 3u rgba(11,20,28,.35)`.
Children sit at `left: 16u` and inherit the skew, so rows step left down the slant by themselves; every text
node is counter-skewed (`.t { display:inline-block; transform: skewX(10deg) }`). The band is nearly opaque on
purpose: cars behind it are hidden, not ghosted.

**Row.** Height 6.2u (pause 5.9u, car rows 8.8u, RACE 11.4u, START RACE 8u), gap 1u, radius 1.3u, fill
`rgba(174,187,194,.13)`, rim `0.18u solid rgba(174,187,194,.55)`, padding `0 2.2u 0 2.6u`. Label left, value
right (cyan caption or a widget).

**Focus (one look for every kind of row).** Background yellow, `border: 0.34u solid #fff`, all text and widgets
ink, no text shadow, `transform: translateX(2.6u)`, `box-shadow: 0.7u 0.7u 0 rgba(8,14,20,.6)`, and a yellow
triangle (2.2 × 2.8u) in the gutter 4.2u left of the row. Colour, shape and position all change, so focus does
not depend on colour vision. Optional: scale pulse 1 → 1.015, 1.2 s, off under reduced motion.

**Value widgets** (inside a row, right-aligned):

| widget | unfocused | in the focused (yellow) row |
|---|---|---|
| segmented (`.seg`) | options white at 62 %, the set one cyan text + `0.2u` cyan outline + `rgba(20,232,246,.14)` fill | options ink at 62 %, the set one an ink-filled pill with white text |
| stepper (`.step`) | cyan value, arrows at 40 % | ink value, full-size ink arrows |
| pips (`.pips`, 10 skewed cells 1 × 2.1u) | on = cyan, off = rim at 30 % | on = ink, off = ink at 22 % |
| tag WAS n (`.tag.was`) | yellow fill, ink text | ink fill, yellow text |
| tag ON THE GRID (`.tag.live`) | cyan outline + text on slate | ink outline + text |

**Plate** (right side, display only): the HUD plate: slate, rim `max(1px, 0.18u)`, opacity 0.88, radius 1.8u,
skewX −10° as a `::before`, upright content. Tall plates ("sheets": car spec, track ticket, controls) use the
finish panel's skewX −4° and radius 2.2u.

**Sticker** (consequences only): yellow, `0.3u` white rim, rotate 5°, hard shadow, 2.2u text + 1.5u sub-line.
**Badge** (car class): cyan, white rim, rotate 4° + skew. **Chips**: skewed slim plates as in the HUD.

**Prompt bar.** Bottom of the band (`left: 15.6u; bottom: 3.4u`), at most 4 prompts, caption size,
letter-spacing 0.07em. Glyphs are inline SVG (functions `face`, `dpad`, `pill`, `key` at the bottom of
`final.html`): face buttons as discs `#0f171f` with a `#dfe7ec` ring and the symbol in its DualShock colour
(cross `#8fb8ff`, circle `#ff7482`, triangle `#49e6b4`, square `#f3a3dc`), a D-pad with the live axis lit
cyan, pills for L2 / R2 / OPTIONS, pale keycaps for the keyboard set. Above it (`bottom: 9.6u`) the **help
line**: one short sentence for the focused row, `#cfd8dd`, `aria-live="polite"`.

**Backdrop.** Title-side screens: no tint, no blur, no filter (the world is the hero). Pause / confirm: a flat
`rgba(11,20,28,.38)` div over the canvas, plus `canvas.style.filter = 'saturate(.72)'` on the `high` preset
only (not on `quest`). Post-race: `rgba(11,20,28,.16)`. Never `backdrop-filter`.

**Motion** (all off with `prefers-reduced-motion: reduce` and with the view's `animate: false`): band slides in
from the left 220 ms ease-out, out 180 ms; rows fade up with a 30 ms stagger; focus plate transform 90 ms;
stickers pop (scale 1.15 → 1, 200 ms); post-race stack fades in 250 ms.

## 2. Model: screens, rows, staging

Every screen is ONE ordered vertical list of rows with exactly one focused row. Row kinds:
`action` (select does something), `link` (opens a screen), `choice` (segmented), `stepper`, `slider` (pips),
and non-focusable display content. Focus wraps vertically; values do not wrap. A screen remembers its focus
while it is on the stack; title opens on RACE, pause on RESUME, post on RACE AGAIN, confirm on the safe row.

**Live values** apply while you change them: camera view, music volume.
**World values** need a new world: car, livery, seed, laps, rivals, difficulty, quality. They are STAGED:
`running` = the parsed `GameOptions` of this page, `staged` = `Partial<GameOptions>` holding only keys that
differ from `running` (set a key back to the running value → delete it). Staged values survive Back and are
shown everywhere in yellow; nothing is applied until a "go racing" row is selected (section 6). Square (kbd
Delete / Backspace) undoes: on a row, that row's staged value; on the title root, all of them. There is
exactly one reload per race however many things changed, and no "discard?" question anywhere.

Change count for labels: car + livery count as one ("CAR"), then TRACK, LAPS, RIVALS, DIFFICULTY, QUALITY.

## 3. Screens

Values in CAPS are literal labels. `{}` = computed.

### 3.1 Title (`final-title.png`; staged: `final-title-staged-kb.png`)

Band 68u. Logo block at top 5u: WEB, RACER, chequer ribbon 37 × 2u, tagline TOY BUGGY GRAND PRIX.
Menu at top 35u, width 48.5u:

| row | kind | value shown | help line |
|---|---|---|---|
| RACE (primary, double chevron) | action | sub-line `TRACK {seed} · {n LAPS \| 1 LAP \| ENDLESS} · {n RIVALS \| 1 RIVAL \| NO RIVALS} · {EASY \| NORMAL \| HARD \| SKILL 0.60}`; with staged world values: `TRACK {seed} · {laps} · NEW WORLD` | "Start the race on this track." / staged: "Builds track {seed}, then starts the race." (no seed change: "Builds the new grid, then starts the race.") |
| CAR | link | paint swatch (two-tone dot: body / cage colour) + car name; yellow when staged | "Choose your buggy and its paint." |
| RACE SETUP | link | `TRACK {seed}`; staged: tag `{n} NEW` + yellow value | "Track, laps, rivals and difficulty." |
| SETTINGS | link | `{CHASE \| HIGH \| DIORAMA} CAM` | "Camera, music and quality." |
| CONTROLS | link | none | "Keyboard and gamepad buttons." |

Prompts: D-pad MOVE, Cross SELECT, and Square UNDO only while something is staged. Circle does nothing here.

Right, bottom (plate `next`, 62 × 16.6u, `right 4.5u; bottom 3.6u`): track outline 13.5u square, kicker NEXT
RACE, `TRACK {seed}` 4.6u, caption `{length} M · {laps}`, and BEST LAP `{m:ss.cc}` in yellow from
`localStorage['web-racer.bestLap.hills2-' + seed]` (seconds as text; show `– : – –` when absent). With a staged
seed the title turns yellow, the caption reads `NEW · {laps}`, and the outline is the staged seed's (section 9,
track preview) or a dashed ring until it is known.

Top right: a chip `CLICK OR PRESS A KEY FOR SOUND` only while the AudioContext is still suspended (a pad press
is no user activation). Not drawn in the mockup; same chip style as `.chip`, `right 4.6u; top 3.4u`.

The race HUD is hidden. Camera: section 7.

### 3.2 Car (`final-car.png`)

Band 68u. Breadcrumb `TITLE / CAR`, headline PICK YOUR / BUGGY. List at top 23u, width 48u, four rows 8.8u
(`CAR_DESIGNS` order): two-tone paint chip (6.2 × 5.2u, body 58 % / cage 42 % of the livery being browsed for
that car), name 3u, caption `{HANDLING_PRESETS[id].label} · {rigFor(id) mass} KG`:

REEF ROCKET · ALL-ROUNDER · 810 KG, NEON WASP · AGILE · 730 KG, RIOT RAM · PLANTED · 973 KG, COMET FOX · FAST · 892 KG.

Tags on the row's top-right edge: `ON THE GRID` (cyan outline) on the running car; `CHOSEN` (yellow fill) on a
staged car that differs from it.

Input: up / down = car (focus only browses), left / right = that car's paint (0 … liveries − 1, no wrap),
Cross = CHOOSE: stage `car` + `livery` (or clear them if equal to running) and go back to the title. Circle =
back without changing what is staged. Opening the screen focuses the staged car if any, else the running one,
with its staged / running livery. Prompts: D-pad (up/down) CAR, D-pad (left/right) PAINT, Cross CHOOSE,
Circle BACK. Help: "Left and right change the paint."

Right side (display only, hidden below 5:4):
- Name sticker top right (`right 7u; top 3.6u`, rotate −2.4°): car name 8.4u, white with ink stroke and
  yellow + ink shadow; under it the class badge (`HANDLING_PRESETS[id].label`).
- Spec sheet (`right 3.6u; top 21u; 37 × 66u`, skew −4°): `HANDLING_PRESETS[id].description`; four 5-pip
  meters; PAINT `{i+1} / {n}`, the paint chips (selected = cyan double ring), the paint's name; a note:
  "**CHOOSE** puts it on the grid for your next race. The paint shows once the new grid is built."

Pips (1 … 5, from real data only; `s` = `HANDLING_PRESETS[id].scale`, missing = 1; `clamp(round(x), 1, 5)`):

| meter | formula | reef / wasp / ram / fox |
|---|---|---|
| SPEED | 3 + (s.maxSpeed − 1) × 25 | 3 / 3 / 3 / 5 |
| GRIP | 3 + (s.grip × s.rearGripScale − 1) × 27 | 3 / 2 / 5 / 4 |
| AGILITY | 3 + (s.steerRate / (s.minTurnRadius × s.yawInertiaScale) − 1) × 5.5 | 3 / 5 / 1 / 2 |
| WEIGHT | 3 + (mass − 810) / 80 | 3 / 2 / 5 / 4 |

Live preview: while this screen is open the camera follows the highlighted design's car on the grid if one is
there (`rig.setSubject(thatCar.vehicle); rig.snap()`), else stays on the player. With the default 3 rivals all
four designs are on the grid. Paint is not previewed in 3D. On leaving: `rig.setSubject(player.vehicle)`.

Paint data must come from the assets (section 9, `CarAsset.paints`), never from constants in the menu.

### 3.3 Race setup (`final-setup.png`)

Band 78u. Breadcrumb `TITLE / RACE SETUP`, headline RACE SETUP. List at top 20.6u, width 57u:

| row | kind | values | notes / help |
|---|---|---|---|
| TRACK | stepper | seed 1 … 9999, ±1, wraps | Triangle (kbd R) = RANDOM TRACK: uniform in 1 … 1100, not the running or current value, never a seed in `BAD_SEEDS = [5038]`. Digits on the keyboard type a number (up to 4 digits, committed after 1.2 s without a key, on Enter, or on leaving the row; 0 / empty = no change). Held left / right: repeat 110 ms, after 1.5 s 40 ms. Help: "Every number is its own track and village." |
| LAPS | stepper | ENDLESS, 1, 2 … 99 (ENDLESS = `laps: 0`, one step below 1; no wrap) | Help: "1 to 99 laps. One step below 1 is ENDLESS." |
| RIVALS | choice | 0 1 2 3 | Help: "How many AI buggies start with you." |
| DIFFICULTY | choice | EASY NORMAL HARD = `DIFFICULTY_PRESETS` (`difficulty` 0.2 / 0.46 / 0.72) | a numeric running value that is no preset selects none and shows the caption `SKILL 0.60` after the label. Help: "How quick the rivals are." |
| START RACE (2.2u gap above, yellow rim and label, 8u high) | action | right: `{n} CHANGE(S)` / `LOADS A NEW WORLD`; nothing staged: no caption | same action as the title's RACE. Help: "Go racing." |

A staged row shows the tag `WAS {running value}` after its label. Prompts (max 4, MOVE is dropped first):
D-pad MOVE, D-pad CHANGE, Triangle RANDOM TRACK (TRACK row only), Square UNDO (staged row only), Circle BACK.

Right (sheet `ticket`, `right 5.5u; top 9u; 52 × 72u`): kicker TRACK PREVIEW, `TRACK {seed}` 6.2u, the outline
41u square (rim / asphalt-dark / cyan dashed centre line, white start line, yellow chevron + car dot; drawing
code in `final.html`), chips `{length} M`, `{laps} LAPS · {km} KM` (hidden for ENDLESS), `BEST {m:ss.cc}` or
`NO BEST LAP YET`. When the seed differs from the running one: sticker `NEW TRACK / BUILT WHEN YOU START`.

### 3.4 Settings (`final-settings.png`)

Band 78u, same list geometry as setup.

| row | kind | values | applies | help |
|---|---|---|---|---|
| CAMERA | choice | CHASE HIGH DIORAMA = `chase` / `high` / `xr` | live: `host.setView(mode)` | "Changes at once: look past the menu." |
| MUSIC | slider | 0 … 10 pips = volume 0 … 1 in tenths, number after the pips (`OFF` at 0) | live: `host.setMusicVolume(v)` | "Music volume. 0 is off." |
| QUALITY | choice | HIGH QUEST | staged (tag `WAS HIGH`) | "Applies when the next race loads." |

Opened from PAUSE the breadcrumb reads `PAUSED / SETTINGS` and QUALITY is not focusable (`.row.dim`, help:
"Change quality from the title screen."). Prompts: D-pad MOVE, D-pad CHANGE, Square UNDO (staged row), Circle BACK.

### 3.5 Controls (`final-controls.png`)

Read-only. Band 68u with four tips (cyan bullet, 2.3u):
"Hold **BRAKE** at a standstill to reverse." / "**RESET** puts you back on the road, facing the right way." /
"Cut a corner and the lap does not count until you rejoin." / "Restart and quit are in the **PAUSE** menu."
Sheet on the right (`right 5u; top 11u; 82 × 66u`), grid `1.25fr 1fr 1fr`, rows 6.9u:

| ACTION | GAMEPAD | KEYBOARD |
|---|---|---|
| STEER | left stick | A D or ← → |
| THROTTLE | R2 | W or ↑ |
| BRAKE / REVERSE | L2 | S or ↓ |
| RESET CAR | Circle | R |
| CAMERA | Triangle | C |
| PAUSE | OPTIONS | ESC or P |
| MUSIC ON / OFF | in the menu | M |

Below 5:4 the sheet moves into the band under the headline as two-line rows and the tips are dropped.
Prompt: Circle BACK.

### 3.6 Pause (`final-pause.png`)

Tint (+ desaturation on `high`). Band 59u. Breadcrumb `LAP {lap} / {laps} · {place} OF {count}` (endless:
`LAP {lap}`; alone: no place; during the 3-2-1: `STARTING GRID`), headline PAUSED 9.2u. List at top 24u,
width 39u, rows 5.9u:

| row | kind | behaviour | help |
|---|---|---|---|
| RESUME | action | close, race continues | "Carry on where you left off." (in the 3-2-1: "The countdown starts again.") |
| RESTART RACE | action | confirm (section 3.7), then `session.restart()` | "Back to the grid, same track." |
| CAMERA | choice shown as `◂ CHASE ▸` | live, the frozen frame is redrawn from the new view | "Changes the view at once." |
| MUSIC | slider (pips) | live | "Music volume." |
| SETTINGS | link | 3.4 | |
| CONTROLS | link | 3.5 | |
| QUIT TO TITLE (pink) | action | confirm, then title | "Ends this race." |

Prompts: Cross SELECT, OPTIONS RESUME. The race HUD is hidden while paused (the breadcrumb repeats lap and
place). Clicking the world does nothing.

### 3.7 Confirm (`final-confirm.png`)

Only where a race in progress is lost: RESTART RACE and QUIT TO TITLE while `race.phase === 'racing'`
(skipped during the countdown). No extra layer: the pause band's content is replaced.

Breadcrumb `PAUSED / QUIT TO TITLE`, headline `QUIT?` (`RESTART?`), then 2.3u text, width 38u:
"This race ends here: lap {lap} of {laps}, running {place}. Your best lap on Track {seed} is kept."
(RESTART: "This race starts again from the grid: lap {lap} of {laps}, running {place}.")
Two rows 7.4u at top 44u: `KEEP RACING` (focused by default) and the pink destructive row (`QUIT TO TITLE` /
`RESTART RACE`). Circle / Esc = KEEP RACING. Prompts: D-pad MOVE, Cross SELECT, Circle BACK.

### 3.8 Post-race (`final-post.png`)

No band. The race HUD stays exactly as it is (position plate, lap plate, the finish panel: untouched, not
moved, not restyled). The menu adds, in a stage with the HUD's unit (`em` below = HUD em):

- Medal: 17em disc at `left: calc(50% − 35.5em); top: calc(50% − 25em)`, cobalt radial fill, 1em cream ring,
  rotate −9°, `{place}` 7em yellow with ink stroke + ordinal superscript, caption PLACE. First place (or racing
  alone): disc `#f2b824` → `#d99a12`, digits ink. No medal in endless mode (no finish) and below 5:4.
- Action stack: `left: calc(50% + 28.5em); top: 50%; width: 34em; transform: translateY(-50%) skewX(-10deg)`
  (both pieces are centred on the same line as the finish panel, so no measuring of the panel is needed and a
  re-created `Hud` does not matter). Rows 7.4em (first 9.6em), slate 0.88 with the pale rim, label 3.1em
  (first 4.3em), cyan caption under it:

| row | caption | action |
|---|---|---|
| RACE AGAIN (focused) | `TRACK {seed} · SAME GRID` | `session.restart()`, state race (no reload). Staged values are kept for later. |
| NEXT TRACK | `TRACK {seed+1} · NEW WORLD` | reload with `seed: running.seed % 9999 + 1` plus everything staged, lands in the race |
| CHANGE CAR | swatch + car name | go to the title state, with the CAR screen open on top |
| TITLE | `MAIN MENU` | go to the title state |

- Prompts as a centred pill at `bottom: 3.2u`: D-pad MOVE, Cross SELECT, Circle TITLE.

Appears 2.5 s after the player's `snapshot.finish` first becomes non-null (the sting and the panel land first)
and accepts input only once every menu button has been released. Rivals keep driving; nothing freezes; pause is
not available. Up / down move (left / right do the same in the 2 × 2 layout below 5:4).

### 3.9 Small and narrow windows

- ≥ 5:4: one layout, everything scales with `--u` (`final-title-small.png`, `final-setup-small.png`,
  `final-car-small.png` at 900×600: captions are 13 px).
- < 5:4 (`final-title-portrait.png`, `final-post-portrait.png`): unit `min(1.0627cqh, 1.5cqw)`; all right-hand
  plates (`.aside`: next-race, name sticker, spec sheet, ticket, medal) are hidden; band 68u (78u). The car
  rows then carry everything needed (paint chip, name, class, weight; paint name replaces the help line while
  left / right is used); setup works unchanged without the ticket. Post-race: the stack becomes a 2 × 2 grid
  60em wide at `bottom: 10em`, focus without the sideways shift.
- Minimum supported window 800 × 500.

## 4. Input

One focus model for all devices; the DOM focus follows the model, never the other way round.

`src/input/MenuInput.ts` produces one `MenuCommand` per frame (all booleans edge-triggered, with repeat where
noted):

| command | keyboard (`KeyboardEvent.code`) | gamepad (standard mapping, every pad from `connectedPads()`) |
|---|---|---|
| `up` / `down` (repeat) | ArrowUp, KeyW / ArrowDown, KeyS | buttons 12 / 13, left stick Y (axis 1) |
| `left` / `right` (repeat) | ArrowLeft, KeyA / ArrowRight, KeyD | buttons 14 / 15, left stick X (axis 0) |
| `select` | Enter, NumpadEnter, Space | 0 (Cross) |
| `back` | Escape | 1 (Circle) |
| `escape` | Escape (set together with `back`) | none |
| `pause` | KeyP | 9 (Options) |
| `undo` | Delete, Backspace | 2 (Square) |
| `random` | KeyR | 3 (Triangle) |
| `digit: 0…9 \| null` | Digit0–9, Numpad0–9 | none |
| `device` | `'keyboard'` | `'gamepad'` (pointer events set `'pointer'`) |

- Repeat: first after 350 ms, then every 110 ms (TRACK and LAPS: 40 ms after 1.5 s held). Keyboard uses the
  same timer from keydown / keyup state; `e.repeat` events are ignored.
- Stick: fires at |axis| ≥ 0.55, re-arms below 0.3; the dominant axis wins.
- The poll that first sees a pad only primes its state (the rule in `GameActions.ts`), so the waking press does
  nothing.
- Release guard: when a menu opens or closes, every key / button that is down is ignored until it has been
  released once (Circle-as-back never resets the car, Options never re-opens the pause, a held Cross does not
  select on the next screen). The same guard starts when the post-race stack appears.
- Keys with Ctrl / Cmd / Alt are browser shortcuts: ignored. While a menu is open, `preventDefault()` on the
  handled keys (arrows and Space would scroll). Keys typed in a form control (the dev tuning panel) are ignored.
- `MenuInput.poll()` runs EVERY frame, also during the race, so pad edges are never stale.

How commands are used:

| state | handling |
|---|---|
| race (no menu), `race.phase` countdown or racing | `pause` or `escape` → open pause. Everything else ignored. |
| paused | `pause` → resume from any depth. `back` → one level up; on the pause root → resume. |
| title side | `back` → one level up; nothing on the title root. `pause` ignored. |
| post | `back` → TITLE row's action. `pause` ignored. |
| value rows | `left` / `right` change; `select` on a `choice` steps to the next option (wraps), on a `stepper` / `slider` does nothing. On `action` / `link` rows `right` does nothing. |

Pointer: rows are real `<button>`s (`pointer-events: auto`; the overlay root is `none`). A `pointermove` that
really moved (> 2 px) over a row moves focus there; a resting cursor never does. Click = select; clicking a
segment sets it; clicking the left / right third of a stepper or a pip sets / steps it; clicking a paint chip
selects that paint; each prompt in the bar is clickable and sends its command. The cursor is hidden
(`cursor: none` on the overlay) after 2 s of keyboard / pad use and returns on movement.
Prompts follow `device`: pad → glyphs, keyboard or pointer → keycaps (↑ ↓, ← →, ENTER, ESC, DEL, R).

**What is suppressed while any menu is open (title, sub-screens, pause, post stack visible):**
- Driving: `RaceSession.gate()` returns `ZERO_INTENT` (new `menuLocked` flag beside `race.inputLocked`), so
  W A S D, arrows, sticks and triggers never reach the vehicle.
- `GameActions`: `actions.poll()` is still called every frame (latched keys and pad edges are consumed), but
  `reset`, `camera` and `restart` are discarded; `music` (M), `tuning` (T) and `dev` (H) still work.
- After the finish, before the stack appears (2.5 s), driving and R / C behave as today.

`GameActions.ts` changes: pad button 9 no longer maps to `restart` (it is the pause button, read by
`MenuInput`); Enter / NumpadEnter fire `restart` only when the game runs without the menu (`menu=0`, see 8) or
with `dev=1`. No new field in the `GameActions` contract.

## 5. State machine

```
BOOT ──loading panel gone──► TITLE ⇄ CAR | SETUP | SETTINGS | CONTROLS
                               │ RACE / START RACE
             nothing staged ───┤──► COUNTDOWN ──GO──► RACING ──player finishes──► FINISHED ─2.5 s─► POST
             staged ──► reload ┘        ▲  │              │                                          │
                (lands in COUNTDOWN)    │  └─Esc/P/Options┴──► PAUSED ⇄ SETTINGS | CONTROLS | CONFIRM │
                                        │                        │ resume / restart / quit            │
                                        └── RACE AGAIN ──────────┼────────────────────────────────────┤
TITLE ◄── QUIT TO TITLE, TITLE, CHANGE CAR (+ CAR screen) ◄──────┴────────────────────────────────────┤
reload (seed + 1, lands in COUNTDOWN) ◄── NEXT TRACK ─────────────────────────────────────────────────┘
```

Menu states (`menu.state`): `'title' | 'race' | 'paused' | 'post'`; the screen stack lives inside the model.

**BOOT → TITLE.** With the menu on, the session is HELD from its creation (the 3-2-1 never runs under the
loading panel). When the panel is gone `main.ts` calls `game.menu.boot()`: if the one-shot flag says race
(section 6) → `startRace()`, else the title opens (band slides in), focus on RACE.

**TITLE (world live, race held).** The frame loop runs normally: cars sit on the grid, rivals held
(`field.hold()`), player input zero, wind / sky / idle engine alive. `session.setHeld(true)` makes
`afterPhysics` call `race.update(0, samples)`: with dt 0 `countdownLeft` does not move and `inputLocked` stays
true (checked in `RaceState.update`), respawn rules keep working (`needsRescue` is still called with the real
dt). HUD hidden. Music mood `idle`.

**RACE (startRace).** Nothing staged: close the menu, `host.setView(view)` back on the player with lateral
offset 0, `session.setHeld(false)`, `session.restart()` (pushes poses into Havok, restarts drivers: race 1 is
the same race as today's), show the HUD, state `race`. Staged: reload (section 6).

**PAUSE.** From COUNTDOWN or RACING only, by `pause` / `escape`, and automatically when the page is hidden
(`visibilitychange`), the window loses focus (`blur`) or the last-used pad disconnects. Semantics: section 7.
RESUME while racing: continue at once, no second countdown. RESUME during the 3-2-1: `session.restart()` (a fresh countdown; nobody has moved, and the
count-in music is scheduled on the audio clock and cannot be frozen mid-bar).
Note: triggers are analogue driving input, not menu buttons; a throttle held through RESUME drives at once.
That is intended (it is what a pause does).

**RESTART RACE** (after confirm): `session.restart()`, close. **QUIT TO TITLE** (after confirm), **TITLE**,
**CHANGE CAR**: `enterTitle()` = `session.restart()` + `session.setHeld(true)` + hide HUD + title camera +
state `title` (no reload: same world).

**POST.** Section 3.8. `RACE AGAIN` = `session.restart()`.

**No menu at all** (today's behaviour, bit for bit): `options.shot`, `options.report`, `options.autopilot`,
`options.spot !== null`, `!options.countdown` (RaceState then starts in `racing`, a held title cannot exist),
`options.terrain === 'flat'`, or `?menu=0`. Then nothing of this spec is created: no `MenuInput`, no overlay,
no storage reads, and Enter / pad Options keep today's instant restart (section 4, `GameActions`). Labs are
untouched.

## 6. Reload paths

World values apply only by reloading the page:

```ts
function reloadWith(overrides: Partial<GameOptions>): void {
  try { sessionStorage.setItem('web-racer.menu.next', 'race'); } catch { /* lands on the title */ }
  location.search = optionsToQuery(options, { ...staged, ...overrides, view: rig.mode, music: musicVolume });
}
```

- `optionsToQuery` already returns the leading `?`: assign it to `location.search` (never prepend another `?`).
  It keeps `dev`, `perf`, `tune`, `vehicle`, `quality`, `cuts`, `dpr` … and drops defaults, so links stay short.
- Parameters written by the menu: `seed`, `car`, `livery`, `laps`, `rivals`, `difficulty`, `quality`, plus the
  current `view` and `music` so the reloaded page keeps what the player hears and sees.
- Landing rule: ONE rule. Every reload the menu causes comes from a "go racing" row (RACE, START RACE, NEXT
  TRACK), so the page comes back straight into the 3-2-1; the loading screen is the transition. The page knows
  through the one-shot `sessionStorage['web-racer.menu.next'] === 'race'`, read AND removed in `menu.boot()`.
  No flag (first visit, shared link, manual refresh, private mode without storage) → title. It is not a URL
  parameter, so a shared link never skips the title.
- Wording: `NEW WORLD` / `LOADS A NEW WORLD`. Never a number of seconds (≈3 s warm, 5.8 s cold on the dev
  Mac, unmeasured on a Quest).
- Callers: title RACE and setup START RACE with staged values → `reloadWith({})`; NEXT TRACK →
  `reloadWith({ seed: options.seed % 9999 + 1 })`.

## 7. Pause semantics and the frame loop

What STOPS while paused: Havok, every `vehicle.update`, rivals (`RivalField.update`), the race clock and
countdown, respawn / rescue timers, HUD updates, the camera rig, the props ring, dust, wind and clouds, the
`DprGovernor` sampling, engine sound (muted). What KEEPS running: the menu overlay, `MenuInput`, `actions.poll`
(discarded), the music scheduler (mood `idle`, ducked to 60 %), and the page itself.

Mechanism (`createScene.ts`, `frame(dt)`): do not render. The WebGL canvas keeps the last presented frame.

```ts
const frame = (dt: number): void => {
  frameDt = dt;
  const a = actions.poll();
  const menuState = menu ? menu.update(menuInput.poll(performance.now())) : 'race';
  if (menuState === 'paused') {
    sound?.update(session.race, session.playerId, 'paused');   // the after-physics observer does not run
    if (pausedRedraw) { pausedRedraw = false; redrawPaused(); }
    return;                                                    // no watchDpr, no beforePhysics, no scene.render
  }
  watchDpr();
  const acts = menuState === 'race' ? a : withoutDriving(a);   // reset / camera / restart cleared
  …today's frame, with `acts`…
};
const redrawPaused = (): void => {                             // one still frame, nothing simulated
  scene.physicsEnabled = false;
  rig.update(0); updatePropsView(0); look.shadows.setFocus(rig.look.followCar ? rig.focus : ORIGIN);
  scene.render();
  scene.physicsEnabled = true;
};
```

- `engine.runRenderLoop(() => frame(beginPhysicsFrame(scene)))` is unchanged: `beginPhysicsFrame` is still
  called every frame and its dt thrown away while paused; it clamps the first dt after RESUME to 1/20 s.
- `pausedRedraw = true` when: the camera view changed in the pause menu; `onResize` fired (`engine.resize()`
  clears the canvas: generalise the existing shot-mode branch); the page became visible again.
- Entering pause: `session.menuLocked = true`, hide HUD, tint on, `sound.setPaused(true)`. Leaving: the
  reverse, start the release guard.
- `sound.update(…)` MUST be called on paused frames: otherwise `gameAudio`'s 50 ms timer keeps driving the
  last countdown `goAt`.
- A redraw advances particle and wind time by one engine frame; that is accepted.
- Verify once on the target browsers that the frame really stays (section 11); if a browser blanks an undrawn
  canvas, fall back to `redrawPaused()` every paused frame (same picture, costs a frame).

Title and post run the normal frame; only `acts` and the session gate differ.

**Camera.** `CameraRig` already has `setMode` and `setSubject`. Add `setLateralOffset(m: number)` to the
contract (`contracts/camera.ts`) and the rig: in `chase` and `high`, eye AND look-at point are moved `m` metres
to the camera's left (so the subject stands right of the band), eased with a 0.35 s time constant; ignored in
`xr`. Title-side screens use 2.2 m (`chase`) / 4 m (`high`); the race uses 0. `host.setView(mode)` =
`rig.setMode(mode)` + what the C key does today (`ringDirX = ringDirZ = 0; applyViewLook();
devOverlay?.setView; refreshHud()`), stores the view (section 10), and while paused sets `pausedRedraw`.
C / Triangle do not cycle the camera while a menu is open.

**Audio** (`gameAudio.ts`): `update(race, playerId, menu: 'title' | 'paused' | 'post' | null)`;
`moodFor` returns `idle` for `title` and `paused`, today's logic otherwise (the finish sting already falls into
`idle`). New: `setMusicVolume(v)` (0 … 1; replaces the constant `level`; create the `MusicPlayer` lazily the
first time the volume is above 0, so a page booted with `?music=0` can turn music on), `musicVolume` getter,
`setPaused(on)` (music gain × 0.6, engine muted through a new `setMuted(on)` on the handle of
`attachEngineSound`, 80 ms ramps), `readonly unlocked: boolean` (AudioContext running) for the title chip.
M keeps toggling mute (`web-racer.music`) everywhere. Optional last step: three UI blips through `AudioHub`
(focus tick, select, back).

## 8. Integration, file by file

New files:

| file | content |
|---|---|
| `src/game/contracts/menu.ts` | TYPES ONLY: `MenuCommand`, `MenuSnapshot` (screen id, breadcrumb, headline, rows with kind / label / value / tags / focused / disabled, help, prompts, aside data), `MenuEffect`, `MenuHost { startRace(); resume(); restartRace(); enterTitle(openCar?: boolean); setView(mode); setMusicVolume(v); previewCar(id \| null); reload(overrides) }`. Header comment = this spec's sections 2–6 in short. |
| `src/ui/menu/MenuModel.ts` | Babylon-free, DOM-free state machine: screen stack, focus, `running` / `staged`, `update(cmd, facts)` → calls `MenuHost`, `snapshot()`. `facts` = plain data from the game per frame (race phase, lap, laps, place, count, finished-since seconds, audio unlocked, pads connected). Importable from Node. |
| `src/ui/menu/MenuView.ts`, `menuCss.ts`, `glyphs.ts` | DOM renderer of `MenuSnapshot` (style id `rmenu-style`, root `.rmenu`, `position: fixed; inset: 0; z-index: 6` — above the HUD (5), below the dev panels (10) and the loading screen (20)). Rebuild a screen's DOM on screen change, patch on focus / value change. Options `{ parent?, animate?, insets? }` like `Hud`. Pointer events → commands for the model. |
| `src/input/MenuInput.ts` | Section 4. |
| `src/game/menuFlow.ts` | `reloadWith`, the one-shot flag, stored view / volume (section 10), `randomSeed`, `BAD_SEEDS`, `carStats(id)` (pips), best-lap read for a seed. Babylon-free. |
| `menu-lab.html`, `src/lab/menuLab.ts` | Lab page like hud-lab: `?screen=` pins any screen on a backdrop colour or picture with a mock host, `state=` variants (`staged`, `kb`, `countdown`), `shot=1` (no animation), `report=1` following the physlab protocol (`data:,` favicon, `#status`, `#result`, title `done` / `error`). |

Changed files:

- `src/game/options.ts`: `menu: boolean` (default `true`, `flag(p.get('menu'), true)`), written by
  `optionsToQuery` only as `menu=0`. Export `menuEnabled(o) = o.menu && !o.shot && !o.report && !o.autopilot
  && o.spot === null && o.countdown && o.terrain === 'hills'`. NO `localStorage` in `parseGameOptions` /
  `defaultGameOptions` (tool pages and `optionsToQuery` share them).
- `src/input/GameActions.ts`: section 4 (`createGameActions({ enterRestarts, padRestarts })`, both true when
  the menu is off; with the menu on `enterRestarts = options.dev`, `padRestarts = false`). Update its header.
- `src/game/RaceSession.ts`: `setHeld(on)` (`afterPhysics` passes `on ? 0 : dt` to `race.update`; `begin()`
  keeps `field.hold()`); `menuLocked: boolean` used by `gate()` (`race.inputLocked || menuLocked`). When
  constructed for a menu page it starts held. `RaceState.ts` is NOT changed.
- `src/scene/createScene.ts`: decide `menuOn = menuEnabled(options) && session !== null`. Before the rig and
  `createGameAudio`: start view / volume = URL parameter if present, else stored value, else option default
  (only when `menuOn`). Create `MenuInput`, `MenuModel`, `MenuView` after the HUD; implement `MenuHost`;
  `session.setHeld(true)` and hide the HUD before the warm-up frames; frame loop and resize as in section 7;
  keep `hudHidden` in a local and re-apply it after every `new Hud(o)` in `refreshHud` (the HUD is re-created
  on view changes); auto-pause listeners; `game.menu` on the `Game` interface (`{ boot(), state, model }`);
  dispose everything in `game.dispose`. The HUD's own API (`show()` / `hide()`) is enough: `Hud.ts` is not
  changed.
- `src/main.ts`: `loading.remove(() => (game.menu ? game.menu.boot() : restartCountdown()))`.
- `src/audio/gameAudio.ts`, `src/audio/carAudio.ts`: section 7.
- `src/game/camera/CameraRig.ts`, `src/game/contracts/camera.ts`: `setLateralOffset`.
- `src/assets/types.ts` + the four car assets: `CarAsset.paints: readonly { name: string; body: RGB;
  accent: RGB }[]` (length = `liveries`; `accent` = the cage colour). reef-rocket's liveries get names (Reef,
  Sunset, Kelp, Dusk — today only comments); riot-ram's "Riot (design sheet)" is shown as RIOT. The menu loads
  the four car assets through the registry at boot (they are loaded for the grid anyway with 3 rivals).
- `CLAUDE.md`: URL table (`menu`), keys (Esc / P / Options = pause; Enter restarts only with `dev=1` or
  `menu=0`), architecture (`src/ui/menu/`, `MenuInput`), labs (`menu-lab.html`), remove "pause menu" from the
  deferred list, new storage keys, and the pending decisions of section 13.

Track preview (title plate, setup ticket): the RUNNING world's outline comes free from `game.data` (the track
polyline, every 4th point, x → right, −z → down, start line at the origin heading up; viewBox ±72 m). A STAGED
seed needs `generateTerrain(seed).track` (`generateTrack` needs the heightfield; ~0.2 s): compute it 300 ms
after the last seed change through the existing bake worker pool (`src/boot/`) or, with `workers=0`, in a
`setTimeout`, cache per seed in a `Map`; until it arrives draw a dashed ring and no length chip. This is the
last build step and may ship later without changing the layout.

Build order: (1) `contracts/menu.ts`, `MenuModel`, `MenuInput`, `menu-lab` with title + pause; (2) title hold,
`boot()`, RACE without staging; (3) pause (the only frame-loop change) + confirm; (4) post-race stack;
(5) setup + staging + reload flag; (6) settings, stored view / volume, audio changes; (7) car screen with
`CarAsset.paints`, camera follow, lateral offset; (8) controls sheet, narrow layouts, motion; (9) track preview,
UI blips.

## 9. Data sources (no invented numbers)

| shown | source |
|---|---|
| car order, ids | `CAR_DESIGNS` (`options.ts`) |
| car name, livery count, paints | car assets via the registry (`name`, `liveries`, new `paints`) |
| class label, description, stat pips | `HANDLING_PRESETS` (`src/car/handling.ts`), formulas in 3.2 |
| mass | `rigFor(id)` (`src/car/rig.ts`) |
| difficulty names | `DIFFICULTY_PRESETS` (`src/car/ai/grid.ts`) |
| lap / place / phase | `race.snapshot(playerId)`, `race.phase` |
| best lap of a seed | `localStorage['web-racer.bestLap.hills2-' + seed]` (read only; `formatLapTime`) |
| track length, outline | `game.data` track (running) / `generateTerrain(seed).track` (staged) |

## 10. Persistence

All access in `try / catch` (private mode, blocked storage): a failed read = default, a failed write is ignored.

| key | store | value | written | read |
|---|---|---|---|---|
| `web-racer.menu.next` | sessionStorage | `'race'` | just before a menu reload | once in `menu.boot()`, then removed |
| `web-racer.view` | localStorage | `chase` \| `high` \| `xr` | when the view changes (menu, C, Triangle) on a menu page | at boot when the URL has no `view` |
| `web-racer.musicVolume` | localStorage | `0` … `1` (one decimal) | when the MUSIC row changes | at boot when the URL has no `music` |
| `web-racer.music` (exists) | localStorage | `0` / `1` mute | M | unchanged |
| `web-racer.bestLap.hills2-<seed>` (exists) | localStorage | seconds | `RaceState` | menu reads only |

URL parameters always win over stored values. Car, seed, laps, rivals, difficulty and quality live ONLY in the
URL (shareable, bookmarkable). Pages without the menu (shot, report, labs, `menu=0`) read and write none of
the new keys.

## 11. Accessibility

- Root: `role="dialog" aria-modal="true" aria-label="{headline}"`; the list `role="group"`.
- Action / link rows are `<button type="button">`. Segmented rows: `role="radiogroup"` with `role="radio"
  aria-checked` children. Steppers and the music row: `role="slider"` with `aria-valuemin / max / now` and
  `aria-valuetext` ("5 laps", "Endless", "Track 27", "70 percent"). Disabled rows: `aria-disabled="true"`.
- Roving `tabindex`: the model's focused row has `tabindex="0"` and receives `focus({ preventScroll: true })`
  on every focus change; Tab / Shift+Tab are left to the browser and a row that gets DOM focus becomes the
  model's focus.
- The yellow plate is the focus indicator, so `outline: none` on rows, but keep
  `@media (forced-colors: active) { .rmenu-row:focus { outline: 3px solid Highlight } }`.
- Help line `aria-live="polite"`. Glyph SVGs `aria-hidden="true"`; each prompt is a button with a text label
  ("Back", "Select"). The HUD stays `aria-hidden`.
- `prefers-reduced-motion: reduce`: no slide, stagger, pulse or pop; state changes are instant.
- Never colour alone: focus = plate + shift + arrow; staged = `WAS` / `NEW` tags; destructive = wording
  ("QUIT") + position (last) + confirm; selected segment = outline / filled pill.
- Contrast: white on the band ≥ 15:1, ink on yellow ≥ 13:1, cyan captions on slate ≥ 10:1.
- Text never under 13 CSS px (tags 11 px) down to 800 × 500.

## 12. Acceptance checks

Automated (each is a page run through `tools/physlab.sh` + `node tools/node/report-checks.mjs`, or a Node test
with `tools/node/register.mjs`):

1. `npx tsc --noEmit` and `npx vite build` pass.
2. Unchanged tools: `PHYSLAB_PAGE=index.html tools/physlab.sh "autopilot=1&report=1&seconds=130" out.json`
   gives the same checks as before the change; a `shot=1` game picture is pixel-identical before / after
   (`tools/node/pngdiff.mjs`); neither page creates `.rmenu` or reads the new storage keys.
3. `MenuModel` Node test, pad-only and key-only command scripts: every screen is reachable and left again;
   focus is never null and never on a disabled row; wrap works; `staged` holds only differing keys; Square
   clears; the reload query equals `optionsToQuery(options, {...staged, view, music})`; RANDOM never returns the
   running seed or a `BAD_SEEDS` entry; LAPS stops at ENDLESS and 99; the release guard swallows a held button.
4. `menu-lab.html?report=1`: for every screen, no row label or caption overflows its row
   (`scrollWidth <= clientWidth`), nothing in the band crosses its right edge, at 1600×900, 900×600 and
   620×900; computed font size ≥ 13 px (tags ≥ 11 px).
5. Pause determinism (report mode, new option `pausetest=<s>`): run the race, at `<s>` simulated seconds call
   the pause path for 120 frames, resume, finish; the final report (positions, lap times, odometers) equals the
   run without the pause.
6. Title hold: 600 held frames, then `startRace()`: race 1 equals the race of a `menu=0` page (same report
   values); no car respawned and `race.countdownRemaining` stayed 3 during the hold.

Screenshots (`tools/shot.sh "/menu-lab.html?screen=<s>&shot=1" …`), compared by eye with the `final-*.png` of
section 0: all eight screens at 1600×900; title, car, setup at 900×600; title and post at portrait.

By hand, on the live page (keyboard, then DualShock):
- Title appears after loading, world alive behind it, no countdown running, music idle; RACE starts a full
  3-2-1 in step with the music.
- Options / Esc / P pause mid-race: the picture freezes (cars, dust, clouds), engine silent, music calm;
  RESUME continues without a jump in position, lap time or camera; resize while paused keeps a picture;
  CAMERA in pause shows the new view of the frozen race.
- Circle used as Back never resets the car; Options never restarts; holding Cross through a screen change
  selects nothing.
- Setup: change track + laps, Back, title shows them in yellow; RACE reloads once and lands in the countdown
  on the new track; a browser refresh then lands on the title.
- NEXT TRACK loads seed + 1 into the countdown; RACE AGAIN restarts without a reload; QUIT asks, default KEEP
  RACING.
- Car screen: the camera hops to each design on the grid; CHOOSE + RACE gives that car and paint.
- Tab hidden mid-race → paused on return. Pad-only start shows the sound chip until a key or click.
- `?menu=0`, `?shot=1`, `?report=1`, `?autopilot=1`, `?spot=…`, `?countdown=0`, `?terrain=flat`: no menu,
  behaviour as before.

## 13. XR carry-over, risks, open decisions

Carries over to a world-space panel: `MenuModel` / `MenuSnapshot` / `MenuCommand` unchanged (thumbstick =
D-pad, trigger = Cross, B = Circle, menu button = Options, controller ray = pointer); the three colour rules;
row, segment, stepper, pip, tag, sticker and prompt components; one list per screen with at most 7 rows and no
hover-only affordance. Does not carry over: the DOM view (rebuild as quads or a canvas texture; the band becomes
a free-standing slanted board beside the table), the canvas tint / saturate, `cursor` handling.

Risks:
- Pause by not rendering depends on the browser keeping the last frame; checked by hand (section 12), with the
  redraw-every-frame fallback ready. A lost WebGL context while paused shows a blank canvas (no context-loss
  handler exists in the game at all).
- Title hold leans on `race.update(0)` and on rival / respawn code tolerating minutes of idle frames on the
  grid; boot placement does not push poses into Havok (known defect) — check 6 covers the first, watch for
  cars creeping on sloped grids.
- Input overlap (W A S D / arrows / stick both drive and navigate; Circle = reset and back; Options changed
  meaning): the session gate, the discarded `GameActions` and the release guard must all be in place before the
  title ships.
- The staged model shows the OLD car on the grid while the title row names the new one (yellow). If that
  confuses in a feel test, the alternative is a reload back to the title on CHOOSE (one more landing value for
  the flag).
- Car preview only works for designs on the grid (rivals = 3) and never shows the paint; a rendered portrait
  (RenderTargetTexture, cached like the bakes) is a later step.
- Random and typed seeds outside 1–1100 have no village guarantee; heavy seeds thin their scatter on `quest`.
- `-webkit-text-stroke` + `paint-order` on HTML text: fine in Chrome, Safari and the Quest browser; older
  Firefox paints the stroke over the fill (thinner letters, still legible).
- A pad press cannot unlock audio: a pad-only player has a silent title until a key or click (chip explains).
- Mockup limits: static pictures, no animation; the below-5:4 controls layout, the first-place medal and the
  sound chip are specified but not drawn; mock lap times and the best lap are illustrative; paint chip colours
  in the mockup were typed from `palette.ts` by hand.

Owner decisions to confirm in a feel test: yellow focus (cyan stays "what is set"); Options = pause instead of
instant restart; resume during the 3-2-1 restarts the countdown; NEXT TRACK = seed + 1 (not random); title
camera offset 2.2 m; whether the last setup should also be remembered across visits (today: URL only).
