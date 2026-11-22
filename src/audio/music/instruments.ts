/**
 * The music's synth voices: each call builds a few Web Audio nodes for ONE
 * note at an exact time and lets them go when the note has ended. Works on
 * any `BaseAudioContext`, so the music lab renders the same voices into an
 * `OfflineAudioContext`. Peak level of a voice at velocity 1 is about 1;
 * the mix levels live on the part buses (`MusicPlayer`).
 *
 * Every random source (noise buffer, reverb impulse) is seeded: a render is
 * the same every time.
 */
import { midiToHz } from './notes';

export interface Kit {
  ctx: BaseAudioContext;
  /** 2 s of seeded white noise (mono). */
  noise: AudioBuffer;
  /** 25 % pulse wave. */
  pulse: PeriodicWave;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createKit(ctx: BaseAudioContext): Kit {
  const rand = mulberry32(0x5eed);
  const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
  // Pulse of duty D: real[n] = 2 / (nπ) · sin(nπD).
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
  const pulse = ctx.createPeriodicWave(real, imag);
  return { ctx, noise, pulse };
}

/** A stereo reverb impulse: decaying seeded noise, brighter at the start. */
export function createReverbImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rand = mulberry32(0xbeef);
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // One-pole low-pass that closes over the tail: early reflections bright.
      const k = 0.85 - 0.7 * t;
      lp += k * (rand() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - t, 2.2) * (i < ctx.sampleRate * 0.008 ? i / (ctx.sampleRate * 0.008) : 1);
    }
  }
  return buf;
}

const SILENT = 0.0001;

/** Let the voice's nodes go once its last source ends. */
function release(src: AudioScheduledSourceNode, out: AudioNode): void {
  src.onended = () => out.disconnect();
}

function noiseSource(kit: Kit, t: number, dur: number): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = kit.noise;
  src.loop = true;
  // A different window of the buffer per hit, from the time itself (seeded).
  src.start(t, (t * 7.31) % 1.5);
  src.stop(t + dur);
  return src;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Percussive gain envelope: attack, exponential decay to silence. */
function pluckEnv(g: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(SILENT, t + attack + decay);
}

/** Held envelope: attack, decay to sustain, hold until `end`, release. */
function heldEnv(g: AudioParam, t: number, end: number, peak: number, attack: number, sustain: number, rel: number): void {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.setTargetAtTime(peak * sustain, t + attack, 0.08);
  // A second target event starts from wherever the first one has got to.
  g.setTargetAtTime(0, Math.max(end, t + attack + 0.01), rel / 3);
}

function panned(ctx: BaseAudioContext, node: AudioNode, dest: AudioNode, pan: number): AudioNode {
  if (pan === 0) {
    node.connect(dest);
    return node;
  }
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  node.connect(p);
  p.connect(dest);
  return p;
}

// ───────────────────────────── drums ─────────────────────────────

export function kick(kit: Kit, dest: AudioNode, t: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(165, t);
  osc.frequency.exponentialRampToValueAtTime(52, t + 0.07);
  osc.frequency.exponentialRampToValueAtTime(44, t + 0.3);
  const g = ctx.createGain();
  pluckEnv(g.gain, t, vel, 0.002, 0.34);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.4);
  // Beater click.
  const click = noiseSource(kit, t, 0.02);
  const cg = ctx.createGain();
  pluckEnv(cg.gain, t, vel * 0.22, 0.001, 0.012);
  click.connect(filter(ctx, 'highpass', 1800)).connect(cg).connect(out);
  release(osc, out);
}

export function snare(kit: Kit, dest: AudioNode, t: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const n = noiseSource(kit, t, 0.25);
  const ng = ctx.createGain();
  pluckEnv(ng.gain, t, vel * 0.85, 0.001, 0.17);
  n.connect(filter(ctx, 'bandpass', 2100, 0.6)).connect(ng).connect(out);
  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(205, t);
  body.frequency.exponentialRampToValueAtTime(165, t + 0.08);
  const bg = ctx.createGain();
  pluckEnv(bg.gain, t, vel * 0.55, 0.001, 0.08);
  body.connect(bg).connect(out);
  body.start(t);
  body.stop(t + 0.12);
  release(n, out);
}

export function hat(kit: Kit, dest: AudioNode, t: number, vel: number, open: boolean): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const decay = open ? 0.2 : 0.035;
  const n = noiseSource(kit, t, decay + 0.05);
  const g = ctx.createGain();
  pluckEnv(g.gain, t, vel * 0.6, 0.001, decay);
  n.connect(filter(ctx, 'highpass', open ? 6500 : 7800)).connect(g).connect(out);
  release(n, out);
}

export function crash(kit: Kit, dest: AudioNode, t: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const n = noiseSource(kit, t, 1.8);
  const f = filter(ctx, 'highpass', 5000);
  f.frequency.setValueAtTime(5000, t);
  f.frequency.exponentialRampToValueAtTime(2800, t + 1.4);
  const g = ctx.createGain();
  pluckEnv(g.gain, t, vel * 0.55, 0.002, 1.6);
  n.connect(f).connect(g).connect(out);
  release(n, out);
}

const TOM_HZ: Readonly<Record<string, number>> = { H: 196, M: 147, L: 110 };

export function tom(kit: Kit, dest: AudioNode, t: number, vel: number, key: string): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const hz = TOM_HZ[key] ?? 147;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(hz * 1.45, t);
  osc.frequency.exponentialRampToValueAtTime(hz, t + 0.06);
  const g = ctx.createGain();
  pluckEnv(g.gain, t, vel * 0.9, 0.002, 0.22);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
  release(osc, out);
}

// ───────────────────────────── pitched ─────────────────────────────

/** Plucky synth bass: filtered saw + sine sub an octave down. */
export function bass(kit: Kit, dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = kit;
  const hz = midiToHz(midi);
  const out = ctx.createGain();
  out.connect(dest);
  const end = t + dur;
  heldEnv(out.gain, t, end - 0.02, vel, 0.004, 0.62, 0.05);
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = hz;
  const lp = filter(ctx, 'lowpass', 400, 5);
  lp.frequency.setValueAtTime(2400, t);
  lp.frequency.setTargetAtTime(460, t + 0.005, 0.05);
  const sg = ctx.createGain();
  sg.gain.value = 0.6;
  saw.connect(lp).connect(sg).connect(out);
  const sub = ctx.createOscillator();
  sub.frequency.value = hz / 2;
  const subG = ctx.createGain();
  subG.gain.value = 0.4;
  sub.connect(subG).connect(out);
  for (const o of [saw, sub]) {
    o.start(t);
    o.stop(end + 0.15);
  }
  release(sub, out);
}

/** Short 25 % pulse pluck — the arpeggio. */
export function arp(kit: Kit, dest: AudioNode, t: number, midi: number, vel: number, pan: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  panned(ctx, out, dest, pan);
  pluckEnv(out.gain, t, vel, 0.002, 0.16);
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(kit.pulse);
  osc.frequency.value = midiToHz(midi);
  const lp = filter(ctx, 'lowpass', 1500, 2);
  lp.frequency.setValueAtTime(5200, t);
  lp.frequency.setTargetAtTime(1300, t + 0.002, 0.05);
  osc.connect(lp).connect(out);
  osc.start(t);
  osc.stop(t + 0.22);
  release(osc, out);
}

/** Bell-ish square + triangle octave pluck — the verse riff. */
export function pluck(kit: Kit, dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = kit;
  const hz = midiToHz(midi);
  const out = ctx.createGain();
  out.connect(dest);
  const end = t + Math.max(dur, 0.08);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(vel, t + 0.003);
  out.gain.setTargetAtTime(vel * 0.35, t + 0.003, 0.09);
  out.gain.setTargetAtTime(0, end, 0.03);
  const sq = ctx.createOscillator();
  sq.type = 'square';
  sq.frequency.value = hz;
  const lp = filter(ctx, 'lowpass', 2000, 1);
  lp.frequency.setValueAtTime(4800, t);
  lp.frequency.setTargetAtTime(1800, t + 0.003, 0.12);
  const sqG = ctx.createGain();
  sqG.gain.value = 0.42;
  sq.connect(lp).connect(sqG).connect(out);
  const tri = ctx.createOscillator();
  tri.type = 'triangle';
  tri.frequency.value = hz * 2;
  const triG = ctx.createGain();
  triG.gain.value = 0.5;
  tri.connect(triG).connect(out);
  for (const o of [sq, tri]) {
    o.start(t);
    o.stop(end + 0.15);
  }
  release(tri, out);
}

/** Lead: two detuned saws + a square an octave down, delayed vibrato. */
export function lead(kit: Kit, dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = kit;
  const hz = midiToHz(midi);
  const out = ctx.createGain();
  out.connect(dest);
  const end = t + dur - 0.015;
  heldEnv(out.gain, t, end, vel, 0.012, 0.72, 0.1);
  const lp = filter(ctx, 'lowpass', 3000, 1.2);
  lp.frequency.setValueAtTime(1800, t);
  lp.frequency.linearRampToValueAtTime(4600, t + 0.06);
  lp.connect(out);
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.6;
  const vibDepth = ctx.createGain();
  // Cents of vibrato, faded in after 0.18 s (only long notes get any).
  vibDepth.gain.setValueAtTime(0, t);
  vibDepth.gain.setValueAtTime(0, t + 0.18);
  vibDepth.gain.linearRampToValueAtTime(14, t + 0.45);
  vib.connect(vibDepth);
  const voices: [OscillatorType, number, number, number][] = [
    ['sawtooth', 1, -7, 0.34],
    ['sawtooth', 1, 7, 0.34],
    ['square', 0.5, 0, 0.18],
  ];
  const oscs: OscillatorNode[] = [vib];
  for (const [type, mul, cents, level] of voices) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz * mul;
    o.detune.value = cents;
    vibDepth.connect(o.detune);
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(lp);
    oscs.push(o);
  }
  for (const o of oscs) {
    o.start(t);
    o.stop(end + 0.35);
  }
  release(oscs[1], out);
}

/** Soft pad chord: detuned saw pair per note through a low-pass. */
export function pad(kit: Kit, dest: AudioNode, t: number, notes: number[], dur: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const end = t + dur;
  heldEnv(out.gain, t, end, vel, 0.22, 0.85, 0.45);
  const lp = filter(ctx, 'lowpass', 1300, 0.8);
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.linearRampToValueAtTime(1700, t + dur * 0.6);
  lp.connect(out);
  const oscs: OscillatorNode[] = [];
  const each = 0.5 / notes.length;
  for (const m of notes) {
    for (const cents of [-11, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToHz(m);
      o.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = each;
      o.connect(g).connect(lp);
      oscs.push(o);
    }
  }
  for (const o of oscs) {
    o.start(t);
    o.stop(end + 1);
  }
  release(oscs[0], out);
}

/** Short chord stab (offbeat chorus chords, the finish sting). */
export function stab(kit: Kit, dest: AudioNode, t: number, notes: number[], dur: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  const decay = Math.max(0.16, Math.min(dur, 1.6));
  pluckEnv(out.gain, t, vel, 0.003, decay);
  const lp = filter(ctx, 'lowpass', 1000, 1.5);
  lp.frequency.setValueAtTime(4200, t);
  lp.frequency.setTargetAtTime(1000, t + 0.003, 0.07);
  lp.connect(out);
  const oscs: OscillatorNode[] = [];
  const each = 0.6 / notes.length;
  for (const m of notes) {
    const o = ctx.createOscillator();
    o.setPeriodicWave(kit.pulse);
    o.frequency.value = midiToHz(m);
    const g = ctx.createGain();
    g.gain.value = each;
    o.connect(g).connect(lp);
    oscs.push(o);
  }
  for (const o of oscs) {
    o.start(t);
    o.stop(t + decay + 0.1);
  }
  release(oscs[0], out);
}

// ───────────────────────────── effects ─────────────────────────────

/** Countdown blip: a clean square beep. */
export function blip(kit: Kit, dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  heldEnv(out.gain, t, t + dur, vel, 0.003, 0.9, 0.06);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = midiToHz(midi);
  const lp = filter(ctx, 'lowpass', 3500, 0.7);
  o.connect(lp).connect(out);
  o.start(t);
  o.stop(t + dur + 0.2);
  release(o, out);
}

/** Noise sweep rising over `dur` seconds into the next downbeat. */
export function riser(kit: Kit, dest: AudioNode, t: number, dur: number, vel: number): void {
  const { ctx } = kit;
  const out = ctx.createGain();
  out.connect(dest);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(vel * 0.15, t + dur * 0.5);
  out.gain.linearRampToValueAtTime(vel * 0.6, t + dur - 0.01);
  out.gain.linearRampToValueAtTime(0, t + dur);
  const n = noiseSource(kit, t, dur + 0.02);
  const bp = filter(ctx, 'bandpass', 400, 2.5);
  bp.frequency.setValueAtTime(350, t);
  bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
  n.connect(bp).connect(out);
  release(n, out);
}
