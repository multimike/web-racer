/**
 * Procedural engine sound: the sine-layer recipe from sound-lab.html.
 * Two layers (40 + 70 Hz) drone whenever the engine runs, a third (90 Hz)
 * fades in with throttle; the whole stack pitches up with gearbox rpm.
 * Pure Web Audio — nothing here touches Babylon.
 */

interface LayerSpec {
  freq: number;
  level: number;
  /** Gated layer: gain scales with throttle instead of always sounding. */
  throttleGated: boolean;
}

interface LayerNodes {
  spec: LayerSpec;
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

export class EngineSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: LayerNodes[] = [];
  private throttle = 0;
  private rpm = 0;
  private unlock: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;
  private resuming = false;

  /**
   * Browsers only allow audio to start from a user gesture, so arm
   * listeners; the graph is built on the first click or key press. The
   * listeners stay until the context actually runs (a resume that did not
   * take is tried again at the next gesture). `update()` also starts / resumes
   * the context once the page has had user activation by any means
   * (`navigator.userActivation.hasBeenActive`) — whether a gamepad press
   * counts as activation is the browser's call.
   */
  attachUnlock(): void {
    const unlock = () => {
      this.start();
      this.resume(true);
      if (this.ctx?.state === 'running') this.dropUnlock();
    };
    this.unlock = unlock;
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private dropUnlock(): void {
    if (!this.unlock) return;
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    this.unlock = null;
  }

  /** resume() with its rejection handled (a context closed by dispose()
   * before the unlock rejects the pending promise). A gesture always calls
   * it; the per-frame retry waits for the previous attempt to settle. */
  private resume(fromGesture = false): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended' || (this.resuming && !fromGesture)) return;
    this.resuming = true;
    ctx.resume().then(
      () => {
        this.resuming = false;
        if (ctx.state === 'running') this.dropUnlock();
      },
      () => {
        this.resuming = false;
      },
    );
  }

  private start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = MASTER_VOLUME;
    this.master.connect(ctx.destination);

    for (const spec of LAYERS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = spec.freq;
      osc.connect(gain);
      osc.start();
      this.layers.push({ spec, osc, gain });
    }

    // Babylon's render loop (and with it our parameter updates) pauses in a
    // hidden tab while oscillators would keep droning — mute with the tab.
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') ctx.suspend().catch(() => {});
      else this.resume();
    };
    document.addEventListener('visibilitychange', this.onVisibility);

    this.resume();
    this.apply();
  }

  /** Called every frame with the live pedal and gearbox rpm (0..1). */
  update(throttle: number, rpm: number): void {
    this.throttle = throttle;
    this.rpm = rpm;
    // No click or key yet (a gamepad-only session): start as soon as the
    // browser says the page has been activated, and keep retrying a resume
    // that has not taken while the page is visible.
    if (this.unlock && typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive) {
      this.start();
      if (document.visibilityState === 'visible') this.resume();
    }
    this.apply();
  }

  /** Stop the sound and drop every listener. */
  dispose(): void {
    this.dropUnlock();
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    for (const { osc } of this.layers) osc.stop();
    this.layers = [];
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  private apply(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const pitch = PITCH_IDLE + (PITCH_MAX - PITCH_IDLE) * this.rpm;
    for (const { spec, osc, gain } of this.layers) {
      osc.frequency.setTargetAtTime(spec.freq * pitch, t, 0.04);
      const g = spec.throttleGated
        ? spec.level * this.throttle
        : spec.level * (0.55 + 0.45 * this.rpm);
      gain.gain.setTargetAtTime(g, t, 0.06);
    }
  }
}
