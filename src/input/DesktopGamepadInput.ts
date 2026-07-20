import type { CarIntent, InputProvider } from './types';
import { ZERO_INTENT } from './types';
import { applyDeadzone, clamp } from './deadzone';

/**
 * Reads a plain (non-XR) gamepad via the Gamepad API, e.g. a DualShock 4
 * connected over Bluetooth/USB. Uses the "standard" mapping Chrome/Firefox/
 * Safari expose for the DS4: left stick = axes 0/1, right stick = axes 2/3.
 *
 * Dual-stick RC scheme: left stick steers, right stick throttles (push up to
 * go forward, pull down to reverse) — mirrors a real RC transmitter more than
 * a single-stick car game does, and matches the two-thumbstick layout we'll
 * reuse for XR motion controllers later.
 */
export class DesktopGamepadInput implements InputProvider {
  readonly name = 'gamepad';
  private deadzone: number;

  constructor(deadzone = 0.12) {
    this.deadzone = deadzone;
  }

  private getPad(): Gamepad | null {
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (pad) return pad;
    }
    return null;
  }

  isActive(): boolean {
    return this.getPad() !== null;
  }

  poll(): CarIntent {
    const pad = this.getPad();
    if (!pad) return ZERO_INTENT;

    const steering = applyDeadzone(pad.axes[0] ?? 0, this.deadzone);
    // Stick Y is positive-down on the Gamepad API; invert so "up" is forward.
    const throttle = applyDeadzone(-(pad.axes[3] ?? 0), this.deadzone);

    return {
      throttle: clamp(throttle, -1, 1),
      steering: clamp(steering, -1, 1),
    };
  }
}
