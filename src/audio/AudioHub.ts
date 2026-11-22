/**
 * The game's ONE AudioContext, shared by the engine sound and the music.
 *
 * Browsers only allow audio to start from a user gesture, so `attachUnlock`
 * arms listeners and the context is created on the first click or key press.
 * The listeners stay until the context actually runs (a resume that did not
 * take is tried again at the next gesture). `poll()` (once per frame) also
 * starts / resumes the context once the page has had user activation by any
 * means (`navigator.userActivation.hasBeenActive`) — whether a gamepad press
 * counts as activation is the browser's call.
 *
 * Babylon's render loop pauses in a hidden tab while scheduled audio would
 * keep playing: the context is suspended with the tab and resumed with it.
 *
 * Graph: every client connects into `output` → limiter → destination. The
 * limiter only acts on peaks (engine + music together); below -3 dBFS it is
 * transparent.
 */
export type AudioStartListener = (ctx: AudioContext, output: AudioNode) => void;

/** The hub's peak limiter (the music lab renders through the same one). */
export function createLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  return limiter;
}

export class AudioHub {
  private ctxValue: AudioContext | null = null;
  private outputValue: GainNode | null = null;
  private listeners: AudioStartListener[] = [];
  private unlock: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;
  private resuming = false;
  private disposed = false;

  get ctx(): AudioContext | null {
    return this.ctxValue;
  }

  /** True once the context exists and is producing sound. */
  get running(): boolean {
    return this.ctxValue?.state === 'running';
  }

  /** Called once with the context and the bus to connect into, when audio
   * starts (at once if it already has). */
  onStart(listener: AudioStartListener): void {
    if (this.ctxValue && this.outputValue) listener(this.ctxValue, this.outputValue);
    else this.listeners.push(listener);
  }

  attachUnlock(): void {
    if (this.unlock || this.disposed) return;
    const unlock = () => {
      this.start();
      this.resume(true);
      if (this.ctxValue?.state === 'running') this.dropUnlock();
    };
    this.unlock = unlock;
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Once per frame: start on user activation by other means (a gamepad), and
   * retry a resume that has not taken while the page is visible. */
  poll(): void {
    if (this.unlock && typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive) {
      this.start();
      if (document.visibilityState === 'visible') this.resume();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.dropUnlock();
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    this.listeners = [];
    this.ctxValue?.close().catch(() => {});
    this.ctxValue = null;
    this.outputValue = null;
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
    const ctx = this.ctxValue;
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
    if (this.ctxValue || this.disposed) return;
    const ctx = new AudioContext();
    this.ctxValue = ctx;

    const limiter = createLimiter(ctx);
    limiter.connect(ctx.destination);
    const output = ctx.createGain();
    output.connect(limiter);
    this.outputValue = output;

    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') ctx.suspend().catch(() => {});
      else this.resume();
    };
    document.addEventListener('visibilitychange', this.onVisibility);

    this.resume();
    const pending = this.listeners;
    this.listeners = [];
    for (const l of pending) l(ctx, output);
  }
}
