/**
 * Adaptive race music: a look-ahead sequencer over the score in `song.ts`,
 * playing the synth voices of `instruments.ts` into a small mixer.
 *
 * TIME: the caller passes the audio clock to `tick(now)` often (every frame
 * and a 50 ms timer in the game; a scripted clock in the music lab's
 * offline render). Every bar whose downbeat falls before `now + LOOKAHEAD`
 * is scheduled in one go, so the scheduled future is at most one bar.
 *
 * MOODS (`setMood`) pick a program of the score:
 *   countdown  HARD CUT: a new segment whose two-bar count-in ends exactly on
 *              `goAt` (a later call with a `goAt` 0.2 s off re-aligns it);
 *              it runs straight on into the race program.
 *   race, final, idle  SOFT: from the next unscheduled bar (≤ ~1.7 s); the
 *              final program opens with its one-bar lift.
 *   finishWin, finish  HARD CUT on the next beat: the sting, then idle.
 *   A race after a finish (restart with no countdown) is a hard cut too.
 * A hard cut fades the old segment's gates out in ~30 ms; its notes already
 * scheduled play on into the muted gates.
 *
 * MIX: voice → segment gate (per part) → part bus (level, pan) → mix, plus
 * sends to a dotted-eighth delay and a convolution reverb; the pad bus is
 * pumped by the kick. mix → 28 Hz high-pass → glue compressor → volume →
 * the output the caller gave.
 */
import { BAR_SECONDS, KEY_PC, PARTS, PHRASES, PROGRAMS, STEP_SECONDS, type Part, type Phrase, type ProgramId } from './song';
import { bassNote, diatonicShift, ladder, noteToMidi, parseChord, parseHeld, parseHits, voicing, type Chord } from './notes';
import * as voice from './instruments';

export type MusicMood = ProgramId;

/** How far ahead of `now` a bar's downbeat gets scheduled, s. */
export const LOOKAHEAD = 0.2;
const BEAT = STEP_SECONDS * 4;

const LEVEL: Readonly<Record<Part, number>> = {
  kick: 0.7,
  snare: 0.45,
  hat: 0.3,
  ohat: 0.2,
  crash: 0.24,
  tom: 0.42,
  bass: 0.24,
  arp: 0.32,
  pad: 0.13,
  stab: 0.16,
  lead: 0.25,
  pluck: 0.27,
  fx: 0.11,
};
const PAN: Partial<Record<Part, number>> = { hat: 0.3, ohat: -0.25, stab: 0.2, pluck: -0.12, tom: -0.15 };
const DELAY_SEND: Partial<Record<Part, number>> = { arp: 0.22, lead: 0.2, pluck: 0.26, fx: 0.12 };
const REVERB_SEND: Partial<Record<Part, number>> = {
  snare: 0.12,
  tom: 0.12,
  arp: 0.16,
  pad: 0.35,
  stab: 0.22,
  lead: 0.24,
  pluck: 0.22,
  fx: 0.3,
};

/** Root ranges (MIDI, an octave up from here) per pitched part. */
const BASS_LO = 40; // E2
const ARP_LO = 57; // A3
const PAD_LO = 55; // G3
const STAB_LO = 67; // G4

export interface MusicEvent {
  t: number;
  part: Part;
  midi?: number;
  phrase: string;
  bar: number;
}

export interface MusicPlayerOptions {
  /** Only these parts are scheduled (the lab's stem renders). */
  stems?: ReadonlySet<Part>;
  /** Every scheduled note, for the lab's timing checks. */
  log?: (e: MusicEvent) => void;
}

interface Segment {
  t0: number;
  nextBar: number;
  gates: Map<Part, GainNode>;
  program: ProgramId;
  queue: string[];
  loopIndex: number;
  phrase: Phrase | null;
  phraseBar: number;
  phraseStart: number;
  transpose: number;
  /** Set once the segment has been cut: when its gates close. */
  cutAt: number;
}

export class MusicPlayer {
  private readonly ctx: BaseAudioContext;
  private readonly kit: voice.Kit;
  private readonly opts: MusicPlayerOptions;
  private readonly master: GainNode;
  private readonly buses = new Map<Part, GainNode>();
  private readonly pump: GainNode;
  private readonly nodes: AudioNode[] = [];
  private seg: Segment | null = null;
  private dead: Segment[] = [];
  private moodValue: MusicMood | null = null;
  private now = 0;
  private volumeValue = 1;

  constructor(ctx: BaseAudioContext, output: AudioNode, opts: MusicPlayerOptions = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.kit = voice.createKit(ctx);

    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(output);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 8;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.015;
    glue.release.value = 0.18;
    glue.connect(this.master);
    const hp = this.keep(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 28;
    hp.connect(glue);
    const mix = this.keep(ctx.createGain());
    mix.connect(hp);
    this.nodes.push(glue);

    // Dotted-eighth feedback delay.
    const delayIn = this.keep(ctx.createGain());
    const delay = this.keep(ctx.createDelay(1));
    delay.delayTime.value = STEP_SECONDS * 3;
    const fbLp = this.keep(ctx.createBiquadFilter());
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 3200;
    const fb = this.keep(ctx.createGain());
    fb.gain.value = 0.32;
    const delayOut = this.keep(ctx.createGain());
    delayOut.gain.value = 0.5;
    delayIn.connect(delay);
    delay.connect(fbLp).connect(fb).connect(delay);
    fbLp.connect(delayOut).connect(mix);

    // Short room reverb (seeded impulse).
    const reverbIn = this.keep(ctx.createBiquadFilter());
    reverbIn.type = 'highpass';
    reverbIn.frequency.value = 280;
    const conv = this.keep(ctx.createConvolver());
    conv.buffer = voice.createReverbImpulse(ctx, 1.6);
    const reverbOut = this.keep(ctx.createGain());
    reverbOut.gain.value = 0.45;
    reverbIn.connect(conv).connect(reverbOut).connect(mix);

    this.pump = this.keep(ctx.createGain());
    this.pump.connect(mix);
    for (const part of PARTS) {
      const bus = this.keep(ctx.createGain());
      bus.gain.value = LEVEL[part];
      const dest = part === 'pad' ? this.pump : mix;
      const pan = PAN[part];
      if (pan) {
        const p = this.keep(ctx.createStereoPanner());
        p.pan.value = pan;
        bus.connect(p).connect(dest);
      } else bus.connect(dest);
      const ds = DELAY_SEND[part];
      if (ds) {
        const g = this.keep(ctx.createGain());
        g.gain.value = ds;
        bus.connect(g).connect(delayIn);
      }
      const rs = REVERB_SEND[part];
      if (rs) {
        const g = this.keep(ctx.createGain());
        g.gain.value = rs;
        bus.connect(g).connect(reverbIn);
      }
      this.buses.set(part, bus);
    }
  }

  get mood(): MusicMood | null {
    return this.moodValue;
  }

  /** What is playing: program, phrase and bar of the newest scheduled bar. */
  get position(): { program: ProgramId; phrase: string; bar: number } | null {
    const s = this.seg;
    return s && s.phrase ? { program: s.program, phrase: s.phrase.id, bar: s.phraseBar - 1 } : null;
  }

  get volume(): number {
    return this.volumeValue;
  }

  /** 0 … 1, faded over ~0.1 s. */
  set volume(v: number) {
    this.volumeValue = Math.min(Math.max(v, 0), 1);
    this.master.gain.setTargetAtTime(this.volumeValue, this.now, 0.03);
  }

  /** A part's level × `mul` (the lab's solo / mute and mix trims). */
  setPartGain(part: Part, mul: number): void {
    this.buses.get(part)?.gain.setTargetAtTime(LEVEL[part] * mul, this.now, 0.02);
  }

  /**
   * Ask for a mood (call it every frame; repeats are free). `goAt` (audio
   * time of GO) is required for 'countdown'.
   */
  setMood(mood: MusicMood, now: number, goAt?: number): void {
    this.now = Math.max(this.now, now);
    const prev = this.moodValue;
    if (mood === 'countdown') {
      const go = goAt ?? now + 2 * BAR_SECONDS;
      const want = go - 2 * BAR_SECONDS;
      if (prev === 'countdown' && this.seg && Math.abs(this.seg.t0 - want) < 0.2) return;
      this.moodValue = mood;
      this.cutTo('countdown', want);
      return;
    }
    if (mood === prev) return;
    this.moodValue = mood;
    if (!this.seg) {
      this.cutTo(mood, now + 0.05);
      return;
    }
    if (mood === 'finish' || mood === 'finishWin' || (mood === 'race' && (prev === 'finish' || prev === 'finishWin'))) {
      this.cutTo(mood, this.nextBeat(now + 0.03));
      return;
    }
    // The count-in already runs on into the race.
    if (mood === 'race' && prev === 'countdown') return;
    this.switchSoft(mood);
  }

  /** Schedule everything due before `now + LOOKAHEAD`. */
  tick(now: number): void {
    this.now = Math.max(this.now, now);
    const s = this.seg;
    if (s) {
      while (s.t0 + s.nextBar * BAR_SECONDS < this.now + LOOKAHEAD) this.scheduleBar(s);
    }
    // Live only: in an offline render a disconnect would act on the whole
    // timeline, not from now on.
    if (this.dead.length && !(this.ctx instanceof OfflineAudioContext)) {
      this.dead = this.dead.filter((d) => {
        if (this.now < d.cutAt + 3) return true;
        for (const g of d.gates.values()) g.disconnect();
        return false;
      });
    }
  }

  dispose(): void {
    for (const s of [...this.dead, ...(this.seg ? [this.seg] : [])]) for (const g of s.gates.values()) g.disconnect();
    for (const n of this.nodes) n.disconnect();
    this.master.disconnect();
    this.seg = null;
    this.dead = [];
  }

  // ───────────────────────────── internals ─────────────────────────────

  private keep<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private nextBeat(t: number): number {
    const s = this.seg;
    if (!s) return t;
    return s.t0 + Math.ceil((t - s.t0) / BEAT - 1e-6) * BEAT;
  }

  private cutTo(program: ProgramId, t0: number): void {
    const old = this.seg;
    if (old) {
      const at = Math.max(this.now, Math.min(t0, this.now + LOOKAHEAD + BAR_SECONDS));
      for (const g of old.gates.values()) g.gain.setTargetAtTime(0, at, 0.01);
      old.cutAt = at;
      this.dead.push(old);
    }
    this.seg = {
      t0,
      nextBar: 0,
      gates: new Map(),
      program,
      queue: [...PROGRAMS[program].intro],
      loopIndex: 0,
      phrase: null,
      phraseBar: 0,
      phraseStart: t0,
      transpose: PROGRAMS[program].transpose,
      cutAt: Infinity,
    };
    this.tick(this.now);
  }

  private switchSoft(program: ProgramId): void {
    const s = this.seg!;
    s.program = program;
    s.queue = [...PROGRAMS[program].intro];
    s.loopIndex = 0;
    s.phrase = null;
  }

  private nextPhrase(s: Segment): Phrase {
    for (;;) {
      const prog = PROGRAMS[s.program];
      const id = s.queue.shift();
      if (id) {
        s.transpose = prog.transpose;
        return PHRASES[id];
      }
      if (prog.then) {
        s.program = prog.then;
        s.queue = [...PROGRAMS[prog.then].intro];
        s.loopIndex = 0;
        continue;
      }
      s.transpose = prog.transpose;
      return PHRASES[prog.loop[s.loopIndex++ % prog.loop.length]];
    }
  }

  private gate(s: Segment, part: Part): GainNode {
    let g = s.gates.get(part);
    if (!g) {
      g = this.ctx.createGain();
      g.connect(this.buses.get(part)!);
      s.gates.set(part, g);
    }
    return g;
  }

  private wants(part: Part): boolean {
    return !this.opts.stems || this.opts.stems.has(part);
  }

  private scheduleBar(s: Segment): void {
    const barStart = s.t0 + s.nextBar * BAR_SECONDS;
    s.nextBar++;
    if (!s.phrase || s.phraseBar >= s.phrase.chords.length) {
      s.phrase = this.nextPhrase(s);
      s.phraseBar = 0;
      s.phraseStart = barStart;
    }
    const ph = s.phrase;
    const bar = s.phraseBar++;
    const tr = s.transpose;
    const chord = parseChord(ph.chords[bar], tr);
    const keyPc = (KEY_PC + tr) % 12;
    const now = this.now;
    const at = (step: number) => barStart + step * STEP_SECONDS;
    const log = (t: number, part: Part, midi?: number) => this.opts.log?.({ t, part, midi, phrase: ph.id, bar });
    const pat = (part: keyof Phrase['parts']): string | null => {
      const list = ph.parts[part];
      return list && list.length && this.wants(part) ? list[bar % list.length] : null;
    };

    // Drums.
    for (const part of ['kick', 'snare', 'hat', 'ohat', 'crash', 'tom'] as const) {
      const p = pat(part);
      if (!p) continue;
      const dest = this.gate(s, part);
      for (const h of parseHits(p, 'drum')) {
        const t = at(h.step);
        if (t < now) continue;
        log(t, part);
        if (part === 'kick') {
          voice.kick(this.kit, dest, t, h.vel);
          this.pump.gain.setTargetAtTime(0.5, t, 0.004);
          this.pump.gain.setTargetAtTime(1, t + 0.03, 0.075);
        } else if (part === 'snare') voice.snare(this.kit, dest, t, h.vel);
        else if (part === 'hat') voice.hat(this.kit, dest, t, h.vel, false);
        else if (part === 'ohat') voice.hat(this.kit, dest, t, h.vel, true);
        else if (part === 'crash') voice.crash(this.kit, dest, t, h.vel);
        else voice.tom(this.kit, dest, t, h.vel, h.key);
      }
    }

    // Bass.
    const bp = pat('bass');
    if (bp) {
      const dest = this.gate(s, 'bass');
      for (const n of parseHeld(bp, 'bass')) {
        const t = at(n.step);
        if (t < now) continue;
        const midi = bassNote(n.key, chord, BASS_LO);
        log(t, 'bass', midi);
        voice.bass(this.kit, dest, t, midi, n.len * STEP_SECONDS * 0.92, 1);
      }
    }

    // Arpeggio: alternating sides.
    const ap = pat('arp');
    if (ap) {
      const dest = this.gate(s, 'arp');
      const lad = ladder(chord, ARP_LO);
      for (const h of parseHits(ap, 'arp')) {
        const t = at(h.step);
        if (t < now) continue;
        const midi = lad[Number(h.key)];
        log(t, 'arp', midi);
        voice.arp(this.kit, dest, t, midi, h.step % 4 === 0 ? 1 : 0.78, h.step % 2 === 0 ? -0.35 : 0.35);
      }
    }

    // Chords.
    this.chordPart(s, 'pad', pat('pad'), chord, at, now, log);
    this.chordPart(s, 'stab', pat('stab'), chord, at, now, log);

    // Melodies (+ harmony voice).
    for (const part of ['lead', 'pluck'] as const) {
      const p = pat(part);
      if (!p) continue;
      const dest = this.gate(s, part);
      for (const n of parseHeld(p, 'melody')) {
        const t = at(n.step);
        if (t < now) continue;
        const midi = noteToMidi(n.key) + tr;
        const dur = n.len * STEP_SECONDS;
        const play = (m: number, vel: number) => {
          log(t, part, m);
          if (part === 'lead') voice.lead(this.kit, dest, t, m, dur, vel);
          else voice.pluck(this.kit, dest, t, m, dur, vel);
        };
        play(midi, 1);
        if (ph.harmony) play(diatonicShift(midi, ph.harmony, keyPc), 0.62);
        if (ph.harmonyOctave) play(midi + ph.harmonyOctave, 0.55);
      }
    }

    // Riser over the phrase's last bars; one-off hits.
    if (this.wants('fx') && ph.riserBars && bar === ph.chords.length - ph.riserBars) {
      let t = barStart;
      let dur = ph.riserBars * BAR_SECONDS;
      if (t < now) {
        dur -= now - t;
        t = now;
      }
      if (dur > 0.2) {
        log(t, 'fx');
        voice.riser(this.kit, this.gate(s, 'fx'), t, dur, 1);
      }
    }
    if (ph.hits) {
      const last = bar === ph.chords.length - 1;
      const from = bar * BAR_SECONDS;
      for (const h of ph.hits) {
        if (h.at < from || (!last && h.at >= from + BAR_SECONDS)) continue;
        const t = s.phraseStart + h.at;
        if (t < now) continue;
        if (h.kind === 'crash') {
          if (!this.wants('crash')) continue;
          log(t, 'crash');
          voice.crash(this.kit, this.gate(s, 'crash'), t, h.vel);
        } else {
          if (!this.wants('fx')) continue;
          const midi = noteToMidi(h.note ?? 'A5') + tr;
          log(t, 'fx', midi);
          voice.blip(this.kit, this.gate(s, 'fx'), t, midi, h.len ?? 0.12, h.vel);
        }
      }
    }
  }

  private chordPart(
    s: Segment,
    part: 'pad' | 'stab',
    p: string | null,
    chord: Chord,
    at: (step: number) => number,
    now: number,
    log: (t: number, part: Part, midi?: number) => void,
  ): void {
    if (!p) return;
    const dest = this.gate(s, part);
    const notes = voicing(chord, part === 'pad' ? PAD_LO : STAB_LO);
    for (const n of parseHeld(p, 'chord')) {
      const t = at(n.step);
      if (t < now) continue;
      log(t, part, notes[0]);
      const dur = n.len * STEP_SECONDS;
      if (part === 'pad') voice.pad(this.kit, dest, t, notes, dur, 1);
      else voice.stab(this.kit, dest, t, notes, dur, 1);
    }
  }
}
