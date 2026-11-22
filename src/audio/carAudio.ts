import type { Vehicle } from '../car/Vehicle';
import { EngineSound } from './EngineSound';

/** Engine note at standstill, as a share of the redline rpm. */
const IDLE_RPM = 0.08;

/**
 * The player's engine sound (sine layers, see EngineSound / sound-lab.html)
 * driven by any `Vehicle` model: pedal = the active pedal (the brake while
 * reversing), rpm = |driven rim speed| / top speed, so wheelspin and an
 * airborne throttle blip rev the engine. Audio starts on the first click or
 * key press (browser autoplay rule). Call `update` once per frame.
 */
export function attachEngineSound(vehicle: Vehicle): { update(): void; dispose(): void } {
  const sound = new EngineSound();
  sound.attachUnlock();
  return {
    update(): void {
      const v = vehicle.visual;
      const pedal = v.reversing ? v.brake : v.throttle;
      const top = vehicle.topSpeed > 0 ? vehicle.topSpeed : 1;
      const rpm = Math.max(Math.min(Math.abs(vehicle.drivenRimSpeed) / top, 1), IDLE_RPM);
      sound.update(pedal, rpm);
    },
    dispose(): void {
      sound.dispose();
    },
  };
}
