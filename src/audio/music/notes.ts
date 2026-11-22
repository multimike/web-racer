/**
 * Music notation helpers for the procedural score (`song.ts`): note names,
 * chords, voicings and the 16-step bar patterns. Pure functions, no Web
 * Audio — the music lab validates every pattern of the song with them.
 *
 * PATTERN FORMATS (one bar = 16 sixteenth-note steps; `|` and spaces between
 * single-character steps are ignored):
 *   drums   16 characters: `X` accent (1.0), `x` normal (0.72), `o` ghost (0.42),
 *           `.` rest. Toms use `H` / `M` / `L` (high / mid / low).
 *   arp     16 characters: `0`…`8` = index into the chord's ladder (root,
 *           third, fifth, root + 12, …), `.` rest.
 *   chord   16 characters (pad, stab): `x` starts the chord, `-` holds it,
 *           `.` rest.
 *   bass    16 space-separated tokens: `R` root, `3` third, `5` fifth, `7`
 *           seventh (minor 7th unless the chord says maj7), `O` octave up,
 *           `-` hold, `.` rest.
 *   melody  16 space-separated tokens: a note name (`C#5`), `-` hold, `.` rest.
 */

const PITCH: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'A4' → 69, 'C#5' → 73, 'Bb3' → 58. Throws on anything else. */
export function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note "${name}"`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PITCH[m[1]] + acc;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export interface Chord {
  /** Pitch class of the root, 0 = C. */
  root: number;
  /** Semitones above the root, ascending, root (0) first. */
  tones: number[];
}

const QUALITY: Readonly<Record<string, number[]>> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
};

/** 'F#m' → { root: 6, tones: [0, 3, 7] }, transposed by `transpose` semitones. */
export function parseChord(name: string, transpose = 0): Chord {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name);
  const tones = m ? QUALITY[m[3]] : undefined;
  if (!m || !tones) throw new Error(`bad chord "${name}"`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return { root: (((PITCH[m[1]] + acc + transpose) % 12) + 12) % 12, tones };
}

/** The lowest MIDI note with pitch class `pc` at or above `lo`. */
export function placeAbove(pc: number, lo: number): number {
  return lo + ((((pc - lo) % 12) + 12) % 12);
}

/** Triad (plus seventh) in close position inside [lo, lo + 12): smooth voice
 * leading between neighbouring chords for free. */
export function voicing(chord: Chord, lo: number): number[] {
  return chord.tones.map((t) => placeAbove((chord.root + t) % 12, lo)).sort((a, b) => a - b);
}

/** Arpeggio ladder: chord tones from the root (placed in [lo, lo + 12))
 * upwards through three octaves. Seventh chords use their triad. */
export function ladder(chord: Chord, lo: number): number[] {
  const root = placeAbove(chord.root, lo);
  const triad = chord.tones.slice(0, 3);
  const out: number[] = [];
  for (let o = 0; o < 3; o++) for (const t of triad) out.push(root + t + 12 * o);
  return out;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** `midi` moved by `steps` scale degrees of the major key on `keyPc` (−2 = a
 * diatonic third below). A note outside the scale moves a minor third per
 * two degrees. */
export function diatonicShift(midi: number, steps: number, keyPc: number): number {
  const rel = (((midi - keyPc) % 12) + 12) % 12;
  const deg = MAJOR.indexOf(rel);
  if (deg < 0) return midi + Math.round((steps * 3) / 2);
  const octave = Math.floor((midi - keyPc - rel) / 12);
  const target = deg + steps;
  const tOct = Math.floor(target / 7);
  const tDeg = ((target % 7) + 7) % 7;
  return keyPc + 12 * (octave + tOct) + MAJOR[tDeg];
}

// ───────────────────────────── bar patterns ─────────────────────────────

export const STEPS = 16;

export interface Hit {
  step: number;
  vel: number;
  /** Drums: the character (tom pitch); arp: ladder index. */
  key: string;
}

export interface Held {
  step: number;
  /** Length in steps (a held note runs through its `-` tokens). */
  len: number;
  /** Melody: MIDI note; bass: the degree token; chord: 'x'. */
  key: string;
}

function chars(pattern: string): string[] {
  return pattern.replace(/[|\s]/g, '').split('');
}

const DRUM_VEL: Readonly<Record<string, number>> = { X: 1, x: 0.72, o: 0.42, H: 0.8, M: 0.8, L: 0.85 };

/** Drum / arp pattern → hits. Throws on a wrong length or character. */
export function parseHits(pattern: string, kind: 'drum' | 'arp'): Hit[] {
  const c = chars(pattern);
  if (c.length !== STEPS) throw new Error(`pattern "${pattern}" has ${c.length} steps, not ${STEPS}`);
  const out: Hit[] = [];
  c.forEach((ch, step) => {
    if (ch === '.') return;
    if (kind === 'drum') {
      const vel = DRUM_VEL[ch];
      if (vel === undefined) throw new Error(`bad drum step "${ch}" in "${pattern}"`);
      out.push({ step, vel, key: ch });
    } else {
      if (!/^[0-8]$/.test(ch)) throw new Error(`bad arp step "${ch}" in "${pattern}"`);
      out.push({ step, vel: 1, key: ch });
    }
  });
  return out;
}

/** Token pattern (bass / melody / chord) → held notes. */
export function parseHeld(pattern: string, kind: 'chord' | 'bass' | 'melody'): Held[] {
  const tokens = kind === 'chord' ? chars(pattern) : pattern.trim().split(/\s+/).filter((t) => t !== '|');
  if (tokens.length !== STEPS) throw new Error(`pattern "${pattern}" has ${tokens.length} steps, not ${STEPS}`);
  const out: Held[] = [];
  let open: Held | null = null;
  tokens.forEach((tok, step) => {
    if (tok === '-') {
      if (!open) throw new Error(`hold with nothing to hold in "${pattern}"`);
      open.len++;
      return;
    }
    open = null;
    if (tok === '.') return;
    if (kind === 'chord' && tok !== 'x') throw new Error(`bad chord step "${tok}" in "${pattern}"`);
    if (kind === 'bass' && !/^[R357O]$/.test(tok)) throw new Error(`bad bass step "${tok}" in "${pattern}"`);
    if (kind === 'melody') noteToMidi(tok);
    open = { step, len: 1, key: tok };
    out.push(open);
  });
  return out;
}

/** Bass degree token → MIDI note, root placed in [lo, lo + 12). */
export function bassNote(token: string, chord: Chord, lo: number): number {
  const root = placeAbove(chord.root, lo);
  const third = chord.tones[1];
  switch (token) {
    case 'R':
      return root;
    case '3':
      return root + third;
    case '5':
      return root + 7;
    case '7':
      return root + (chord.tones[3] ?? 10);
    case 'O':
      return root + 12;
    default:
      throw new Error(`bad bass token "${token}"`);
  }
}
