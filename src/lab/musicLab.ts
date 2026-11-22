/**
 * Music lab (`/music-lab.html`): the race music with mood buttons, part
 * mutes and an engine drone to judge the balance by ear — and, with
 * `?report=1`, a headless measurement (contract: src/game/contracts/report.ts):
 *
 *   1. the whole score parses (every bar 16 steps, every note and chord);
 *   2. a scripted race rendered OFFLINE, driven on a 1/60 s clock exactly as
 *      the game drives it (`setMood` + `tick` per frame): idle 0–6 s,
 *      countdown 6–9 s, race 9–81 s (the 72 s loop once), final lap from 81 s,
 *      first place at 104 s, until 118 s;
 *   3. timing checks from the scheduled-note log: GO kick and blips on the
 *      countdown seconds (±1 ms), the final-lap lift within a bar, the sting
 *      within a beat; a countdown first seen 1.2 s before GO and a restart
 *      mid-race land on GO too;
 *   4. levels: sample peak BEFORE the hub's limiter, BS.1770 loudness
 *      (K-weighted, gated; LUFS) of the race and of each section and stem,
 *      and the engine drone rendered from `engineLayers` on a scripted rpm.
 *
 *   PHYSLAB_PAGE=music-lab.html tools/physlab.sh "report=1" out.json
 *   `&wav=music` / `&wav=mix` (music + engine) also puts the render into the
 *   report as base64 (`wav`): `node tools/node/report-wav.mjs out.json out.wav`.
 */
import { createLimiter } from '../audio/AudioHub';
import { engineLayers } from '../audio/EngineSound';
import { MUSIC_LEVEL } from '../audio/gameAudio';
import { LOOKAHEAD, MusicPlayer, type MusicEvent, type MusicMood } from '../audio/music/MusicPlayer';
import { noteToMidi, parseChord, parseHeld, parseHits } from '../audio/music/notes';
import { BAR_SECONDS, PARTS, PHRASES, STEP_SECONDS, type Part, type Phrase } from '../audio/music/song';

const SR = 44100;
const FRAME = 1 / 60;
const BEAT = STEP_SECONDS * 4;

interface Cue {
  at: number;
  mood: MusicMood;
  /** Countdown: seconds from `at` to GO. */
  goIn?: number;
}

const RACE_SCRIPT: Cue[] = [
  { at: 0, mood: 'idle' },
  { at: 6, mood: 'countdown', goIn: 3 },
  { at: 9, mood: 'race' },
  { at: 81, mood: 'final' },
  { at: 104, mood: 'finishWin' },
];
const RACE_END = 118;

const SECTIONS: { name: string; from: number; to: number }[] = [
  { name: 'idle', from: 0, to: 6 },
  { name: 'countdown', from: 6, to: 9 },
  { name: 'verse', from: 9, to: 21 },
  { name: 'chorus', from: 21, to: 33 },
  { name: 'verse2', from: 33, to: 45 },
  { name: 'chorus2', from: 45, to: 57 },
  { name: 'bridge', from: 57, to: 69 },
  { name: 'chorus2b', from: 69, to: 81 },
  { name: 'final', from: 82.5, to: 104 },
  { name: 'finish', from: 104, to: 118 },
];

const STEMS: Record<string, Part[]> = {
  drums: ['kick', 'snare', 'hat', 'ohat', 'crash', 'tom'],
  bass: ['bass'],
  arp: ['arp'],
  chords: ['pad', 'stab'],
  melody: ['lead', 'pluck'],
  fx: ['fx'],
};

// ───────────────────────────── offline render ─────────────────────────────

/** Drive a player on the game's frame clock through a script. */
function drive(player: MusicPlayer, script: Cue[], end: number): void {
  let ci = 0;
  let cur: Cue | null = null;
  for (let f = 0; f * FRAME < end; f++) {
    const t = f * FRAME;
    while (ci < script.length && script[ci].at <= t + 1e-9) cur = script[ci++];
    if (cur) player.setMood(cur.mood, t, cur.at + (cur.goIn ?? 0));
    player.tick(t);
  }
}

/** Scripted engine: idle until GO, then rpm swinging through the gears. */
function engineAt(t: number): { throttle: number; rpm: number } {
  if (t < 9) return { throttle: 0, rpm: 0.08 };
  if (t >= 104) return { throttle: 0, rpm: Math.max(0.08, 0.5 - (t - 104) * 0.05) };
  const s = Math.sin((2 * Math.PI * (t - 9)) / 6.5);
  return { throttle: s > -0.6 ? 1 : 0.3, rpm: Math.min(1, Math.max(0.2, 0.62 + 0.3 * s)) };
}

function addEngine(ctx: BaseAudioContext, dest: AudioNode, end: number): void {
  const first = engineLayers(0, 0.08);
  const nodes = first.map((l) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = l.freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(dest);
    osc.start(0);
    osc.stop(end);
    return { osc, g };
  });
  for (let t = 0; t < end; t += 0.05) {
    const { throttle, rpm } = engineAt(t);
    engineLayers(throttle, rpm).forEach((l, i) => {
      nodes[i].osc.frequency.setTargetAtTime(l.freq, t, 0.04);
      nodes[i].g.gain.setTargetAtTime(l.gain, t, 0.06);
    });
  }
}

interface RenderOptions {
  script: Cue[];
  end: number;
  stems?: Part[];
  /** Music in the render (default true). */
  music?: boolean;
  engine?: boolean;
  /** Through the hub's limiter, as the game plays it. */
  limiter?: boolean;
  log?: (e: MusicEvent) => void;
}

async function render(o: RenderOptions): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(o.end * SR), SR);
  const sum = ctx.createGain();
  if (o.limiter) sum.connect(createLimiter(ctx)).connect(ctx.destination);
  else sum.connect(ctx.destination);
  if (o.music !== false) {
    const bus = ctx.createGain();
    bus.gain.value = MUSIC_LEVEL;
    bus.connect(sum);
    const player = new MusicPlayer(ctx, bus, { stems: o.stems ? new Set(o.stems) : undefined, log: o.log });
    drive(player, o.script, o.end);
  }
  if (o.engine) addEngine(ctx, sum, o.end);
  return ctx.startRendering();
}

/** Scheduled-note log of a script, no audio rendered. */
function eventsOf(script: Cue[], end: number): MusicEvent[] {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const out: MusicEvent[] = [];
  const player = new MusicPlayer(ctx, ctx.destination, { log: (e) => out.push(e) });
  drive(player, script, end);
  player.dispose();
  return out;
}

// ───────────────────────────── analysis ─────────────────────────────

interface Biquad {
  b: [number, number, number];
  a: [number, number];
}

/** BS.1770 K-weighting for any sample rate (shelf + RLB high-pass). */
function kWeighting(fs: number): Biquad[] {
  const shelf = (() => {
    const G = 3.999843853973347;
    const f0 = 1681.974450955533;
    const Q = 0.7071752369554196;
    const A = Math.pow(10, G / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const c = Math.cos(w0);
    const sa = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 - (A - 1) * c + sa;
    return {
      b: [(A * (A + 1 + (A - 1) * c + sa)) / a0, (-2 * A * (A - 1 + (A + 1) * c)) / a0, (A * (A + 1 + (A - 1) * c - sa)) / a0],
      a: [(2 * (A - 1 - (A + 1) * c)) / a0, (A + 1 - (A - 1) * c - sa) / a0],
    } as Biquad;
  })();
  const hp = (() => {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const w0 = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const c = Math.cos(w0);
    const a0 = 1 + alpha;
    return { b: [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], a: [(-2 * c) / a0, (1 - alpha) / a0] } as Biquad;
  })();
  return [shelf, hp];
}

function filterChannel(x: Float32Array, stages: Biquad[]): Float32Array {
  let cur = x;
  for (const { b, a } of stages) {
    const y = new Float32Array(cur.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < cur.length; i++) {
      const v = cur[i];
      const o = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      y[i] = o;
    }
    cur = y;
  }
  return cur;
}

interface Analysis {
  peak: number;
  finite: boolean;
  /** K-weighted squares, summed over channels, per sample. */
  power: Float64Array;
}

function analyse(buf: AudioBuffer): Analysis {
  const stages = kWeighting(buf.sampleRate);
  const power = new Float64Array(buf.length);
  let peak = 0;
  let finite = true;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) finite = false;
      else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const k = filterChannel(d, stages);
    for (let i = 0; i < k.length; i++) power[i] += k[i] * k[i];
  }
  return { peak, finite, power };
}

/** Gated integrated loudness (BS.1770-4) over [from, to) s, LUFS. */
function loudness(a: Analysis, from: number, to: number, fs = SR): number {
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const start = Math.max(0, Math.round(from * fs));
  const stop = Math.min(a.power.length, Math.round(to * fs));
  const blocks: number[] = [];
  for (let i = start; i + block <= stop; i += hop) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += a.power[j];
    blocks.push(s / block);
  }
  const lk = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => lk(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((p, z) => p + z, 0) / abs.length) - 10;
  const gated = abs.filter((z) => lk(z) > rel);
  return lk(gated.reduce((p, z) => p + z, 0) / gated.length);
}

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ───────────────────────────── WAV ─────────────────────────────

function encodeWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, Math.round(v * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ───────────────────────────── report ─────────────────────────────

interface Check {
  id: string;
  value: number | string | boolean;
  target: string;
  pass: boolean;
}

function scoreErrors(): string[] {
  const errors: string[] = [];
  for (const ph of Object.values(PHRASES) as Phrase[]) {
    const bars = ph.chords.length;
    for (const c of ph.chords) {
      try {
        parseChord(c);
      } catch (e) {
        errors.push(`${ph.id}: ${(e as Error).message}`);
      }
    }
    for (const [part, list] of Object.entries(ph.parts)) {
      if (!list) continue;
      if (list.length > bars) errors.push(`${ph.id}.${part}: ${list.length} patterns for ${bars} bars`);
      for (const p of list) {
        try {
          if (part === 'arp') parseHits(p, 'arp');
          else if (part === 'bass') parseHeld(p, 'bass');
          else if (part === 'lead' || part === 'pluck') parseHeld(p, 'melody');
          else if (part === 'pad' || part === 'stab') parseHeld(p, 'chord');
          else parseHits(p, 'drum');
        } catch (e) {
          errors.push(`${ph.id}.${part}: ${(e as Error).message}`);
        }
      }
    }
    for (const h of ph.hits ?? []) {
      try {
        if (h.note) noteToMidi(h.note);
      } catch (e) {
        errors.push(`${ph.id} hit: ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

const first = (ev: MusicEvent[], f: (e: MusicEvent) => boolean) => ev.find(f)?.t ?? NaN;
const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol;

async function report(wav: string | null): Promise<void> {
  const status = document.getElementById('status')!;
  const result = document.getElementById('result')!;
  const started = performance.now();
  const checks: Check[] = [];
  const check = (id: string, value: number | string | boolean, target: string, pass: boolean) =>
    checks.push({ id, value: typeof value === 'number' ? r4(value) : value, target, pass });

  const errors = scoreErrors();
  check('score.parses', errors.length ? errors.slice(0, 3).join('; ') : 'ok', 'every pattern 16 steps, notes and chords valid', errors.length === 0);
  if (errors.length) throw new Error(`score: ${errors[0]}`);

  // Timing on the scheduled-note log (notes scheduled before a hard cut
  // stay in it: they play into the closed gates).
  const ev: MusicEvent[] = [];
  const goKick = (e: MusicEvent, t0: number) => e.part === 'kick' && e.phrase === 'verse' && e.t >= t0 - 0.01;
  status.textContent = 'rendering the race…';
  const mixBuf = await render({ script: RACE_SCRIPT, end: RACE_END, log: (e) => ev.push(e) });
  const go = first(ev, (e) => goKick(e, 8));
  check('timing.goKick', go, '9 s ± 1 ms (first race downbeat on GO)', near(go, 9));
  const blips = ev.filter((e) => e.part === 'fx' && e.midi !== undefined && e.t < 12).map((e) => e.t);
  check('timing.blips', blips.map((t) => r4(t)).join(' '), '6 7 8 9 (countdown seconds, GO)', blips.length === 4 && [6, 7, 8, 9].every((t, i) => near(blips[i], t)));
  const liftAt = first(ev, (e) => e.phrase === 'lift');
  check('timing.finalLift', liftAt - 81, `0 … ${r4(LOOKAHEAD + BAR_SECONDS)} s after the final-lap cue`, liftAt >= 81 && liftAt - 81 <= LOOKAHEAD + BAR_SECONDS + 0.001);
  const finalKey = ev.find((e) => e.phrase === 'chorusF' && e.part === 'lead');
  const finalFirstLead = noteToMidi('F#5') + 2;
  check('timing.finalKeyChange', finalKey?.midi ?? -1, `${finalFirstLead} (chorus lead a whole tone up)`, finalKey?.midi === finalFirstLead);
  const stingAt = first(ev, (e) => e.phrase === 'stingWin');
  check('timing.finishSting', stingAt - 104, `0 … ${r4(BEAT + 0.03)} s after the finish`, stingAt >= 104 && stingAt - 104 <= BEAT + 0.031);


  // A countdown first seen 1.2 s before GO (audio unlocked late).
  const late = eventsOf([{ at: 0, mood: 'idle' }, { at: 5, mood: 'countdown', goIn: 1.2 }, { at: 6.2, mood: 'race' }], 9);
  const lateGo = first(late, (e) => goKick(e, 6));
  const lateBlips = late.filter((e) => e.part === 'fx' && e.midi !== undefined).map((e) => r4(e.t));
  check('timing.lateCountdown', `${r4(lateGo)} | ${lateBlips.join(' ')}`, 'GO 6.2, blips 5.2 6.2 only', near(lateGo, 6.2) && lateBlips.length === 2 && near(lateBlips[0], 5.2) && near(lateBlips[1], 6.2));
  // A restart mid-race.
  const rs = eventsOf([{ at: 0, mood: 'race' }, { at: 40, mood: 'countdown', goIn: 3 }, { at: 43, mood: 'race' }], 46);
  const rsGo = first(rs, (e) => goKick(e, 42));
  const rsCount = rs.filter((e) => e.phrase === 'count' && e.t >= 40 && e.t < 43).length;
  check('timing.restart', `${r4(rsGo)} | ${rsCount} count notes`, 'GO 43, count-in played', near(rsGo, 43) && rsCount > 20);

  // Levels.
  status.textContent = 'measuring…';
  const mix = analyse(mixBuf);
  const raceLufs = loudness(mix, 9, 81);
  check('mix.finite', mix.finite, 'no NaN / Infinity', mix.finite);
  check('mix.peak', r1(db(mix.peak)), '≤ −3 dBFS before the limiter', db(mix.peak) <= -3);
  check('mix.raceLoudness', r1(raceLufs), '−26 … −20 LUFS (race 9–81 s)', raceLufs >= -26 && raceLufs <= -20);
  const sections = Object.fromEntries(SECTIONS.map((s) => [s.name, r1(loudness(mix, s.from, s.to))]));

  const stems: Record<string, number> = {};
  for (const [name, parts] of Object.entries(STEMS)) {
    status.textContent = `stem ${name}…`;
    const b = await render({ script: RACE_SCRIPT, end: 81, stems: parts });
    stems[name] = r1(loudness(analyse(b), name === 'fx' ? 6 : 9, 81));
  }
  const silent = Object.entries(stems).filter(([, v]) => !(v > -50));
  check('stems.audible', silent.length ? silent.map(([k]) => k).join(',') : 'all', 'every stem louder than −50 LUFS', silent.length === 0);

  status.textContent = 'engine…';
  const engBuf = await render({ script: RACE_SCRIPT, end: 81, music: false, engine: true });
  const engLufs = loudness(analyse(engBuf), 9, 81);

  let wavB64: string | undefined;
  if (wav) {
    status.textContent = 'encoding WAV…';
    const b = wav === 'mix' ? await render({ script: RACE_SCRIPT, end: RACE_END, engine: true, limiter: true }) : mixBuf;
    wavB64 = base64(encodeWav(b));
  }

  const failed = checks.filter((c) => !c.pass);
  const lines = [
    `music-lab: ${checks.length - failed.length}/${checks.length} checks pass`,
    `race ${r1(raceLufs)} LUFS, peak ${r1(db(mix.peak))} dBFS, engine ${r1(engLufs)} LUFS (music − engine ${r1(raceLufs - engLufs)} LU)`,
    `sections ${Object.entries(sections).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `stems ${Object.entries(stems).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    ...failed.map((c) => `FAIL ${c.id}: ${c.value} (want ${c.target})`),
  ];
  const out = {
    page: 'music-lab',
    totals: { simSeconds: RACE_END, wallSeconds: r1((performance.now() - started) / 1000) },
    scorecard: { text: lines.join('\n') },
    checks,
    loudness: { race: r1(raceLufs), engine: r1(engLufs), sections, stems },
    peakDb: r1(db(mix.peak)),
    events: ev.length,
    ...(wavB64 ? { wav: wavB64, wavKind: wav } : {}),
  };
  result.textContent = JSON.stringify(out);
  document.title = 'done';
  status.textContent = lines.join('\n');
}

// ───────────────────────────── interactive ─────────────────────────────

function download(buf: AudioBuffer, name: string): void {
  const blob = new Blob([encodeWav(buf) as BlobPart], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function interactive(): void {
  const status = document.getElementById('status')!;
  const pos = document.getElementById('pos')!;
  const startBtn = document.getElementById('start') as HTMLButtonElement;
  const vol = document.getElementById('vol') as HTMLInputElement;
  const engineBtn = document.getElementById('engine') as HTMLButtonElement;
  const rpm = document.getElementById('rpm') as HTMLInputElement;
  const thr = document.getElementById('thr') as HTMLInputElement;
  const moodButtons = [...document.querySelectorAll<HTMLButtonElement>('#moods button')];
  const partsEl = document.getElementById('parts')!;

  let ctx: AudioContext | null = null;
  let player: MusicPlayer | null = null;
  let mood: MusicMood = 'idle';
  let goAt = 0;
  let engine: { osc: OscillatorNode; g: GainNode }[] | null = null;
  let engineOn = false;

  const setMood = (m: MusicMood) => {
    if (!ctx || !player) return;
    mood = m;
    if (m === 'countdown') goAt = ctx.currentTime + 3;
    for (const b of moodButtons) b.classList.toggle('on', b.dataset.mood === m);
  };
  const tick = () => {
    if (!ctx || !player) return;
    const now = ctx.currentTime;
    // As the game does: the race phase follows GO.
    if (mood === 'countdown' && now >= goAt) setMood('race');
    player.setMood(mood, now, goAt - (ctx.outputLatency || ctx.baseLatency || 0));
    player.tick(now);
    if (engine) {
      engineLayers(engineOn ? Number(thr.value) : 0, Number(rpm.value)).forEach((l, i) => {
        engine![i].osc.frequency.setTargetAtTime(l.freq, now, 0.04);
        engine![i].g.gain.setTargetAtTime(engineOn ? l.gain : 0, now, 0.06);
      });
    }
  };

  startBtn.addEventListener('click', () => {
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
      player = null;
      engine = null;
      startBtn.textContent = 'Start audio';
      pos.textContent = 'stopped';
      return;
    }
    ctx = new AudioContext();
    const limiter = createLimiter(ctx);
    limiter.connect(ctx.destination);
    const bus = ctx.createGain();
    bus.gain.value = MUSIC_LEVEL;
    bus.connect(limiter);
    player = new MusicPlayer(ctx, bus);
    player.volume = Number(vol.value);
    engine = engineLayers(0, 0.1).map(() => {
      const osc = ctx!.createOscillator();
      const g = ctx!.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(limiter);
      osc.start();
      return { osc, g };
    });
    startBtn.textContent = 'Stop audio';
    setMood('idle');
    tick();
  });
  for (const b of moodButtons) b.addEventListener('click', () => setMood(b.dataset.mood as MusicMood));
  vol.addEventListener('input', () => {
    if (player) player.volume = Number(vol.value);
  });
  engineBtn.addEventListener('click', () => {
    engineOn = !engineOn;
    engineBtn.textContent = engineOn ? 'Engine on' : 'Engine off';
    engineBtn.classList.toggle('on', engineOn);
  });
  for (const part of PARTS) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = true;
    c.addEventListener('change', () => player?.setPartGain(part, c.checked ? 1 : 0));
    l.append(c, part);
    partsEl.append(l);
  }
  setInterval(tick, 50);
  const show = () => {
    const p = player?.position;
    if (p && ctx) pos.textContent = `${mood} · ${p.program} / ${p.phrase} bar ${p.bar + 1} · ${ctx.currentTime.toFixed(1)} s`;
    requestAnimationFrame(show);
  };
  requestAnimationFrame(show);

  const offline = async (engineToo: boolean) => {
    status.textContent = 'rendering…';
    const t0 = performance.now();
    const b = await render({ script: RACE_SCRIPT, end: RACE_END, engine: engineToo, limiter: true });
    status.textContent = `rendered ${RACE_END} s in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    download(b, engineToo ? 'table-top-rally-with-engine.wav' : 'table-top-rally.wav');
  };
  document.getElementById('wavMusic')!.addEventListener('click', () => void offline(false));
  document.getElementById('wavMix')!.addEventListener('click', () => void offline(true));
}

const params = new URLSearchParams(location.search);
if (params.get('report') === '1') {
  report(params.get('wav')).catch((e: unknown) => {
    const result = document.getElementById('result')!;
    result.textContent = JSON.stringify({ page: 'music-lab', fatal: String((e as Error)?.stack ?? e), totals: { simSeconds: 0 }, scorecard: { text: String(e) }, checks: [] });
    document.title = 'error';
  });
} else {
  interactive();
}
