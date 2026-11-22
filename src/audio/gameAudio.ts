/**
 * Everything the game hears: one `AudioHub` (context + autoplay unlock), the
 * player's engine sound and the adaptive race music (`music/`).
 *
 * The music follows the PLAYER's race: countdown → count-in that lands on GO
 * (blips on the countdown seconds), racing → race theme, last lap of a race
 * of 2+ laps → final-lap lift and key change, player finished → sting (first
 * place, or racing alone, gets the fanfare) then the calm loop. The flat
 * arena (no race) plays the race theme. `M` toggles the music; the choice is
 * remembered per browser (`localStorage` key `web-racer.music`).
 *
 * The game menu (design-documents/menu-mockups/SPEC.md, 7): the title and the
 * pause menu play the calm `idle` loop (`update(…, menu)`); the MUSIC row sets
 * the volume (`setMusicVolume`, the player is created the first time it is
 * above 0, so a page booted with `?music=0` can still turn music on); the
 * pause ducks the music to 60 % and mutes the engine (`setPaused`, 80 ms
 * ramps); `unlocked` tells the title whether to show the sound chip.
 */
import type { Vehicle } from '../car/Vehicle';
import type { RaceState } from '../game/RaceState';
import { AudioHub } from './AudioHub';
import { attachEngineSound } from './carAudio';
import { MusicPlayer, type MusicMood } from './music/MusicPlayer';

/** Music level into the hub, at volume 1 (measured: music-lab report). The
 * game's default volume is 0.7 (`options.ts`), ≈ 3 dB under this. */
export const MUSIC_LEVEL = 0.31;
const STORAGE_KEY = 'web-racer.music';
/** The scheduler's own clock: frames stop in a hidden tab, and a slow frame
 * must not starve the look-ahead. */
const TICK_MS = 50;
/** Music level while the pause menu is open, × MUSIC_LEVEL, and the ramp, s. */
const PAUSE_DUCK = 0.6;
const PAUSE_RAMP = 0.08;

export interface GameAudioOptions {
  /** Music volume 0 … 1 (0 = off; `?music=`, or the menu's stored volume). */
  music: number;
}

/** Which menu is open, as the music sees it (null: none, the race). */
export type MenuAudioState = 'title' | 'paused' | 'post' | null;

export interface GameAudio {
  /** Once per frame, after the race has updated (`race` null = no race),
   * also on paused frames (the scheduler would otherwise keep driving the
   * last countdown's GO). `menu`: the title and the pause play `idle`. */
  update(race: RaceState | null, playerId: string, menu?: MenuAudioState): void;
  toggleMusic(): void;
  /** Not muted (M) and the volume above 0. */
  readonly musicOn: boolean;
  /** Music volume 0 … 1 (the menu's MUSIC row). */
  setMusicVolume(v: number): void;
  readonly musicVolume: number;
  /** The pause menu: music × 0.6, engine muted (80 ms ramps); false undoes it. */
  setPaused(on: boolean): void;
  /** The AudioContext runs (false: the title shows its sound chip). */
  readonly unlocked: boolean;
  dispose(): void;
}

function storedOn(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function store(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private mode: not remembered */
  }
}

export function moodFor(race: RaceState | null, playerId: string, menu: MenuAudioState = null): { mood: MusicMood; goIn: number } {
  if (menu === 'title' || menu === 'paused') return { mood: 'idle', goIn: 0 };
  if (!race) return { mood: 'race', goIn: 0 };
  const snap = race.snapshot(playerId);
  if (snap.finish) return { mood: snap.position === 1 || snap.count === 1 ? 'finishWin' : 'finish', goIn: 0 };
  if (race.phase === 'countdown') return { mood: 'countdown', goIn: race.countdownRemaining };
  if (Number.isFinite(snap.laps) && snap.laps > 1 && snap.lap >= snap.laps) return { mood: 'final', goIn: 0 };
  return { mood: 'race', goIn: 0 };
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

export function createGameAudio(vehicle: Vehicle, opts: GameAudioOptions): GameAudio {
  const hub = new AudioHub();
  hub.attachUnlock();
  const engine = attachEngineSound(vehicle, hub);
  let volume = clamp01(opts.music);
  let on = storedOn();
  let paused = false;
  let music: MusicPlayer | null = null;
  let bus: GainNode | null = null;
  let ctx: AudioContext | null = null;
  let output: AudioNode | null = null;
  let timer = 0;
  let last: { mood: MusicMood; goIn: number } | null = null;
  let lastAt = 0;

  const apply = (): void => {
    if (music) music.volume = on ? volume : 0;
  };
  /** The pause duck on the music bus, ramped over PAUSE_RAMP. */
  const applyDuck = (): void => {
    if (!bus || !ctx) return;
    const g = bus.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(MUSIC_LEVEL * (paused ? PAUSE_DUCK : 1), t + PAUSE_RAMP);
  };
  /** Mood as of now: a countdown's GO moves with the audio clock between
   * frames. Output latency is subtracted so the blips are HEARD on the
   * digits. */
  const drive = (): void => {
    if (!music || !ctx || !last || !hub.running) return;
    const now = ctx.currentTime;
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    const goAt = lastAt + last.goIn - latency;
    music.setMood(last.mood, now, goAt);
    music.tick(now);
  };
  /** The player is built the first time audio runs with a volume above 0. */
  const ensureMusic = (): void => {
    if (music || !ctx || !output || volume <= 0) return;
    bus = ctx.createGain();
    bus.gain.value = MUSIC_LEVEL * (paused ? PAUSE_DUCK : 1);
    bus.connect(output);
    music = new MusicPlayer(ctx, bus);
    apply();
    timer = window.setInterval(drive, TICK_MS);
  };

  hub.onStart((c, out) => {
    ctx = c;
    output = out;
    ensureMusic();
  });

  return {
    update(race, playerId, menu = null): void {
      hub.poll();
      engine.update();
      if (!ctx) return;
      last = moodFor(race, playerId, menu);
      lastAt = ctx.currentTime;
      drive();
    },
    toggleMusic(): void {
      if (volume <= 0) return;
      on = !on;
      store(on);
      apply();
    },
    get musicOn(): boolean {
      return on && volume > 0;
    },
    setMusicVolume(v: number): void {
      volume = clamp01(v);
      // A deliberate volume change (the menu's MUSIC row) undoes the M mute:
      // the row shows the EFFECTIVE level, so it reads OFF while muted.
      if (volume > 0 && !on) {
        on = true;
        store(true);
      }
      ensureMusic();
      apply();
    },
    get musicVolume(): number {
      return volume;
    },
    setPaused(next: boolean): void {
      if (next === paused) return;
      paused = next;
      applyDuck();
      engine.setMuted(next);
    },
    get unlocked(): boolean {
      return hub.running;
    },
    dispose(): void {
      window.clearInterval(timer);
      music?.dispose();
      music = null;
      bus?.disconnect();
      bus = null;
      engine.dispose();
      hub.dispose();
    },
  };
}
