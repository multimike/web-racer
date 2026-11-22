import type { Vehicle } from '../car/Vehicle';
import type { AudioHub } from './AudioHub';
import { EngineSound } from './EngineSound';

/** Engine note at standstill, as a share of the redline rpm. */
const IDLE_RPM = 0.08;
/** Mute / unmute ramp (the pause menu), s. */
const MUTE_RAMP = 0.08;

/** The handle `attachEngineSound` returns. */
export interface EngineSoundHandle {
  /** Once per frame (also while paused: the note then holds, muted). */
  update(): void;
  /** Silence the engine (the pause menu) or bring it back, 80 ms ramps. */
  setMuted(on: boolean): void;
  dispose(): void;
}

/**
 * The player's engine sound (sine layers, see EngineSound / sound-lab.html)
 * driven by any `Vehicle` model: pedal = the active pedal (the brake while
 * reversing), rpm = |driven rim speed| / top speed, so wheelspin and an
 * airborne throttle blip rev the engine. Audio starts with the shared hub
 * (first click or key press, browser autoplay rule). Call `update` once per
 * frame.
 *
 * Mute: the engine is wired into the hub's bus through a gain of its own
 * (the engine sees a view of the hub whose `onStart` hands it that gain
 * instead of the bus; everything else — `running`, the context — is the
 * hub's own).
 */
export function attachEngineSound(vehicle: Vehicle, hub: AudioHub): EngineSoundHandle {
  let muted = false;
  let ctx: AudioContext | null = null;
  let gate: GainNode | null = null;
  // A view of the hub: the prototype chain reads the hub's live state.
  const tap: AudioHub = Object.create(hub);
  tap.onStart = (listener) =>
    hub.onStart((c, output) => {
      ctx = c;
      gate = c.createGain();
      gate.gain.value = muted ? 0 : 1;
      gate.connect(output);
      listener(c, gate);
    });
  const sound = new EngineSound(tap);
  return {
    update(): void {
      const v = vehicle.visual;
      const pedal = v.reversing ? v.brake : v.throttle;
      const top = vehicle.topSpeed > 0 ? vehicle.topSpeed : 1;
      const rpm = Math.max(Math.min(Math.abs(vehicle.drivenRimSpeed) / top, 1), IDLE_RPM);
      sound.update(pedal, rpm);
    },
    setMuted(on: boolean): void {
      if (on === muted) return;
      muted = on;
      if (!ctx || !gate) return;
      const g = gate.gain;
      const t = ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 0 : 1, t + MUTE_RAMP);
    },
    dispose(): void {
      sound.dispose();
      gate?.disconnect();
      gate = null;
      ctx = null;
    },
  };
}
