/**
 * THE SCORE — "Table Top Rally", the race theme. Bright toy synth-pop in
 * A major at 160 BPM: one bar = 1.5 s, so the 3 s countdown is exactly two
 * bars and GO lands on a downbeat.
 *
 * A PROGRAM is what plays in one mood: `intro` phrases once, then `loop`
 * forever (`then` hands over to another program after the intro instead).
 * A PHRASE is a run of bars: a chord per bar and a pattern per bar per part
 * (a part with fewer patterns than bars cycles them). Formats: `notes.ts`.
 *
 *   idle       loading / free run before the race: pad, soft arp, light beat
 *   countdown  two-bar count-in ending on GO, blips on the countdown seconds,
 *              then the race program (no gap: the music is already there)
 *   race       verse · chorus · verse 2 · chorus 2 · bridge · chorus 2 (72 s)
 *   final      one-bar lift, then the choruses a whole tone up (B major)
 *   finishWin / finish   a two-bar sting (first place / any other), then idle
 */

export const BPM = 160;
export const STEP_SECONDS = 60 / BPM / 4;
export const BAR_SECONDS = STEP_SECONDS * 16;
/** Pitch class of the home key (A). */
export const KEY_PC = 9;

export type DrumPart = 'kick' | 'snare' | 'hat' | 'ohat' | 'crash' | 'tom';
export type PitchedPart = 'bass' | 'arp' | 'pad' | 'stab' | 'lead' | 'pluck';
export type PatternPart = DrumPart | PitchedPart;
/** Every mix bus. `fx` carries the riser and the countdown blips. */
export type Part = PatternPart | 'fx';
export const PARTS: readonly Part[] = ['kick', 'snare', 'hat', 'ohat', 'crash', 'tom', 'bass', 'arp', 'pad', 'stab', 'lead', 'pluck', 'fx'];

export interface PhraseHit {
  /** Seconds from the start of the phrase (may be at its very end). */
  at: number;
  kind: 'blip' | 'crash';
  note?: string;
  len?: number;
  vel: number;
}

export interface Phrase {
  id: string;
  chords: string[];
  parts: Partial<Record<PatternPart, string[]>>;
  /** Noise riser over the last n bars. */
  riserBars?: number;
  /** A second voice on the melody parts, in diatonic steps (−2 = a third
   * below) or, with `harmonyOctave`, an octave (−12 / 12). */
  harmony?: number;
  harmonyOctave?: number;
  hits?: PhraseHit[];
}

export interface Program {
  intro: string[];
  loop: string[];
  /** Program to continue with after the intro (instead of `loop`). */
  then?: ProgramId;
  /** Semitones on everything (chords and melody). */
  transpose: number;
}

export type ProgramId = 'idle' | 'countdown' | 'race' | 'final' | 'finishWin' | 'finish';

const r16 = '................';

// ── drums ──
const FOUR = 'X...x...X...x...';
const FOUR_PUSH = 'X...x...X...x.x.';
const BACKBEAT = '....X.......X...';
const BACKBEAT_FILL = '....X.......X.oo';
const HAT8 = 'x.o.x.o.x.o.x.o.';
const HAT16 = 'xoxoxoxoxoxoxoxo';
const HAT_CHORUS = 'xo.oxo.oxo.oxo.o';
const OHAT_OFF = '..x...x...x...x.';
const CRASH1 = 'X...............';

// ── bass ──
const BASS_VERSE = 'R . R . O . R . R . R . O . R .';
const BASS_VERSE_TURN = 'R . R . O . R . R . 5 . O . 5 .';
const BASS_CHORUS = 'R . R R O . R . R . R R O . 5 3';
const BASS_LONG = 'R - - - - - - - - - - - R - 5 -';

// ── arp ──
const ARP_3 = '0240240240240243';
const ARP_UPDOWN = '0123432101234321';
const ARP_8 = '0.2.4.2.3.2.4.2.';

const VERSE_RIFF = [
  'E5 . E5 . C#5 . E5 - - . F#5 - E5 - C#5 -',
  'B4 - - - . . . . G#4 - B4 - E5 - - -',
  'C#5 . C#5 . A4 . C#5 - - . E5 - C#5 - A4 -',
  'F#4 - - - . . . . A4 - D5 - F#5 - - -',
  'E5 . E5 . C#5 . E5 - - . F#5 - E5 - C#5 -',
  'B4 - - - . . . . G#4 - B4 - E5 - - -',
  'F#5 . F#5 . D5 . F#5 - - . A5 - F#5 - D5 -',
  'E5 - - - D5 - - - B4 - - - G#4 - B4 -',
];

const CHORUS_LEAD = [
  'F#5 - - - E5 - F#5 - A5 - - - F#5 - E5 -',
  'E5 - - - D5 - E5 - G#5 - - - B5 - - -',
  'C#6 - - - B5 - A5 - G#5 - - - E5 - - -',
  'F#5 - - - - - - - E5 - F#5 - A5 - C#6 -',
  'D6 - - - C#6 - B5 - A5 - - - F#5 - A5 -',
  'B5 - - - A5 - G#5 - E5 - - - G#5 - B5 -',
  'A5 - - - - - - - - - . . E5 - A5 -',
  'C#6 - - - B5 - - - A5 - - - - - . .',
];

const BRIDGE_LEAD = [
  'A5 - - - - - - - - - - - G#5 - - -',
  'F#5 - - - - - - - - - - - - - - -',
  'E5 - - - - - - - C#5 - - - E5 - - -',
  'B4 - - - - - - - - - - - - - - -',
  'C#6 - - - - - - - B5 - - - A5 - - -',
  'A5 - - - - - - - F#5 - - - A5 - - -',
  'B5 - - - - - - - - - - - - - - -',
  'G#5 - - - - - - - . . . . . . . .',
];

const VERSE_CHORDS = ['A', 'E', 'F#m', 'D', 'A', 'E', 'D', 'E'];
const CHORUS_CHORDS = ['D', 'E', 'C#m', 'F#m', 'D', 'E', 'A', 'A'];
const BRIDGE_CHORDS = ['F#m', 'D', 'A', 'E', 'F#m', 'D', 'E', 'E'];
const IDLE_CHORDS = ['A', 'G', 'D', 'A', 'A', 'G', 'D', 'E'];

const verse: Phrase = {
  id: 'verse',
  chords: VERSE_CHORDS,
  parts: {
    kick: [FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR_PUSH],
    snare: [BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT_FILL],
    hat: [HAT8],
    bass: [BASS_VERSE, BASS_VERSE, BASS_VERSE, BASS_VERSE, BASS_VERSE, BASS_VERSE, BASS_VERSE, BASS_VERSE_TURN],
    arp: [ARP_3],
    pad: ['x---------------'],
    pluck: VERSE_RIFF,
  },
};

const verse2: Phrase = {
  ...verse,
  id: 'verse2',
  harmony: -2,
  parts: {
    ...verse.parts,
    hat: [HAT16],
    crash: [CRASH1, r16, r16, r16, r16, r16, r16, r16],
  },
};

const chorus: Phrase = {
  id: 'chorus',
  chords: CHORUS_CHORDS,
  parts: {
    kick: [FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR_PUSH],
    snare: [BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT_FILL],
    hat: [HAT_CHORUS],
    ohat: [OHAT_OFF],
    crash: [CRASH1, r16, r16, r16, CRASH1, r16, r16, r16],
    bass: [BASS_CHORUS],
    arp: [ARP_UPDOWN],
    pad: ['x---------------'],
    stab: ['..x...x...x...x.'],
    lead: CHORUS_LEAD,
  },
};

const chorus2: Phrase = { ...chorus, id: 'chorus2', harmony: -2 };

const bridge: Phrase = {
  id: 'bridge',
  chords: BRIDGE_CHORDS,
  riserBars: 2,
  parts: {
    kick: ['X.......x.......', 'X.......x.......', 'X.......x.......', 'X.......x.......', 'X.......x.......', 'X.......x.......', FOUR, FOUR],
    snare: ['........X.......', '........X.......', '........X.......', '........X.......', '........X.......', '........X.......', 'x...x...x.x.x.x.', 'ooooooooxxxxXXXX'],
    hat: ['o.o.o.o.o.o.o.o.'],
    bass: [BASS_LONG],
    arp: [ARP_8],
    pad: ['x---------------'],
    lead: BRIDGE_LEAD,
  },
};

const idle: Phrase = {
  id: 'idle',
  chords: IDLE_CHORDS,
  parts: {
    kick: ['x.......x.......'],
    hat: ['..o...o...o...o.'],
    bass: ['R - - - - - - - R - - - - - - -'],
    arp: [ARP_8],
    pad: ['x---------------'],
    pluck: [
      '. . . . . . . . . . . . . . . .',
      '. . . . . . . . . . . . . . . .',
      '. . . . . . . . . . . . . . . .',
      'E5 - C#5 - A4 - - - - - - - - - - -',
      '. . . . . . . . . . . . . . . .',
      '. . . . . . . . . . . . . . . .',
      '. . . . . . . . . . . . . . . .',
      'B4 - G#4 - E4 - - - - - - - - - - -',
    ],
  },
};

const count: Phrase = {
  id: 'count',
  chords: ['A', 'E'],
  riserBars: 2,
  parts: {
    kick: [FOUR, 'X...x...X.x.X.x.'],
    snare: [r16, 'o.o.o.o.xxxxXXXX'],
    hat: ['x.x.x.x.x.x.x.x.', HAT16],
    bass: ['R . R . R . R . R . R . R . R .', 'R R R R R R R R R R R R R R R R'],
  },
  // The countdown digits are 1 s apart (2 2/3 beats): blips on the clock,
  // GO on the downbeat after the phrase.
  hits: [
    { at: 0, kind: 'blip', note: 'A5', len: 0.14, vel: 1 },
    { at: 1, kind: 'blip', note: 'A5', len: 0.14, vel: 1 },
    { at: 2, kind: 'blip', note: 'A5', len: 0.14, vel: 1 },
    { at: 3, kind: 'blip', note: 'A6', len: 0.45, vel: 1 },
    { at: 3, kind: 'crash', vel: 1 },
  ],
};

const lift: Phrase = {
  id: 'lift',
  chords: ['E'],
  riserBars: 1,
  parts: {
    kick: ['X...............'],
    snare: ['....x...xxxxXXXX'],
    tom: ['H.H.M.M.L.L.....'],
    bass: ['R - - - - - - - . . . . . . . .'],
    pad: ['x-------........'],
  },
  hits: [{ at: BAR_SECONDS, kind: 'crash', vel: 1 }],
};

const chorusF: Phrase = {
  ...chorus,
  id: 'chorusF',
  harmonyOctave: -12,
  parts: { ...chorus.parts, hat: [HAT16] },
};
const chorusF2: Phrase = { ...chorus, id: 'chorusF2', harmony: -2, parts: { ...chorus.parts, hat: [HAT16] } };
const bridgeF: Phrase = {
  ...bridge,
  id: 'bridgeF',
  parts: {
    ...bridge.parts,
    kick: [FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR, FOUR],
    snare: [BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, BACKBEAT, 'x...x...x.x.x.x.', 'ooooooooxxxxXXXX'],
    hat: [HAT8],
    arp: [ARP_3],
    bass: [BASS_VERSE],
  },
};

const stingWin: Phrase = {
  id: 'stingWin',
  chords: ['A', 'A'],
  parts: {
    kick: ['X.....X.X.......', r16],
    snare: ['......X.X.......', r16],
    crash: [CRASH1, r16],
    tom: ['L.M.H...........', r16],
    bass: ['R . . . . . R . R - - - - - - -', 'R - - - - - - - - - - - - - - -'],
    arp: ['01234567........', r16],
    pad: ['x---------------', 'x---------------'],
    stab: ['x.....x.x-------', r16],
    lead: ['A4 . C#5 . E5 . A5 . A5 - - - - - - -', 'C#6 - - - - - - - - - - - - - - -'],
  },
  harmony: -2,
};

const sting: Phrase = {
  id: 'sting',
  chords: ['D', 'E', 'A', 'A'],
  parts: {
    kick: ['X.......X.......', 'X.......X.......', 'X...............', r16],
    snare: [BACKBEAT, BACKBEAT, r16, r16],
    hat: [HAT8, HAT8, r16, r16],
    bass: ['R - - - - - - - R - - - - - - -', 'R - - - - - - - R - - - - - - -', 'R - - - - - - - - - - - - - - -', r16.split('').join(' ')],
    pad: ['x---------------'],
    pluck: [
      'F#5 - - - E5 - - - D5 - - - E5 - - -',
      'E5 - - - D5 - - - B4 - - - D5 - - -',
      'C#5 - - - - - - - - - - - - - - -',
      '. . . . . . . . . . . . . . . .',
    ],
  },
};

export const PHRASES: Readonly<Record<string, Phrase>> = Object.fromEntries(
  [verse, verse2, chorus, chorus2, bridge, idle, count, lift, chorusF, chorusF2, bridgeF, stingWin, sting].map((p) => [p.id, p]),
);

export const PROGRAMS: Readonly<Record<ProgramId, Program>> = {
  idle: { intro: [], loop: ['idle'], transpose: 0 },
  countdown: { intro: ['count'], loop: [], then: 'race', transpose: 0 },
  race: { intro: [], loop: ['verse', 'chorus', 'verse2', 'chorus2', 'bridge', 'chorus2'], transpose: 0 },
  final: { intro: ['lift'], loop: ['chorusF', 'chorusF2', 'bridgeF', 'chorusF2'], transpose: 2 },
  finishWin: { intro: ['stingWin'], loop: [], then: 'idle', transpose: 0 },
  finish: { intro: ['sting'], loop: [], then: 'idle', transpose: 0 },
};
