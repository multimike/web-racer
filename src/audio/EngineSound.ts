/**
 * Procedural engine sound: the sine-layer recipe from sound-lab.html.
 * Two layers (40 + 70 Hz) drone whenever the engine runs, a third (90 Hz)
 * fades in with throttle; the whole stack pitches up with gearbox rpm.
 * Pure Web Audio — nothing here touches Babylon. The context (and the
 * autoplay unlock) belongs to the shared `AudioHub`; the layers are built
 * when the hub starts.
 */
import type { AudioHub } from './AudioHub';

interface LayerSpec {
  freq: number;
  level: number;
  /** Gated layer: gain scales with throttle instead of always sounding. */
  throttleGated: boolean;
}

interface LayerNodes {
  osc: OscillatorNode;
  gain: GainNode;
}

const LAYERS: LayerSpec[] = [
  { freq: 40, level: 0.8, throttleGated: false },
  { freq: 70, level: 0.6, throttleGated: false },
  { freq: 90, level: 0.7, throttleGated: true },
];

/** Pitch multiplier at idle rpm / at redline. 2.6 pushed the layer stack into
 * uncomfortable beating at top speed; 2.2 keeps the sweep without the edge. */
const PITCH_IDLE = 0.85;
const PITCH_MAX = 2.2;
const MASTER_VOLUME = 0.1;

/** Frequency and gain (master volume included) of each layer for a pedal
 * and rpm (0..1) — what `update` steers towards; the music lab renders the
 * engine from it to judge the music against it. */
export function engineLayers(throttle: number, rpm: number): { freq: number; gain: number }[] {
  const pitch = PITCH_IDLE + (PITCH_MAX - PITCH_IDLE) * rpm;
  return LAYERS.map((spec) => ({
    freq: spec.freq * pitch,
    gain: MASTER_VOLUME * (spec.throttleGated ? spec.level * throttle : spec.level * (0.55 + 0.45 * rpm)),
  }));
}

export class EngineSound {
  private readonly hub: AudioHub;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: LayerNodes[] = [];
  private throttle = 0;
  private rpm = 0;

  constructor(hub: AudioHub) {
    this.hub = hub;
    hub.onStart((ctx, output) => this.build(ctx, output));
  }

  private build(ctx: AudioContext, output: AudioNode): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(output);
    for (const spec of LAYERS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = spec.freq;
      osc.connect(gain);
      osc.start();
      this.layers.push({ osc, gain });
    }
    this.apply();
  }

  /** Called every frame with the live pedal and gearbox rpm (0..1). */
  update(throttle: number, rpm: number): void {
    this.throttle = throttle;
    this.rpm = rpm;
    this.apply();
  }

  /** Stop the layers (the hub owns and closes the context). */
  dispose(): void {
    for (const { osc } of this.layers) osc.stop();
    this.layers = [];
    this.master?.disconnect();
    this.master = null;
    this.ctx = null;
  }

  private apply(): void {
    if (!this.ctx || !this.hub.running) return;
    const t = this.ctx.currentTime;
    const want = engineLayers(this.throttle, this.rpm);
    this.layers.forEach(({ osc, gain }, i) => {
      osc.frequency.setTargetAtTime(want[i].freq, t, 0.04);
      gain.gain.setTargetAtTime(want[i].gain, t, 0.06);
    });
  }
}
