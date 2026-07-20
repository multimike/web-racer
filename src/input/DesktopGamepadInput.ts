import type { CarIntent, InputProvider } from './types';
import { ZERO_INTENT } from './types';
import { applyDeadzone, clamp } from './deadzone';

/**
 * Reads a plain (non-XR) gamepad via the Gamepad API, e.g. a DualShock 4
 * connected over Bluetooth/USB. Uses the "standard" mapping Chrome/Firefox/
 * Safari expose for the DS4: left stick = axes 0/1, right stick = axes 2/3.
 *
 * Trigger driving scheme: left stick steers, right trigger (R2) is the
 * accelerator, left trigger (L2) is the brake (and reverse, once stopped —
 * the vehicle decides which). Triggers are buttons 6/7 with an analog
 * `.value` in the "standard" Gamepad API mapping.
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
    // Triggers rest at 0 and are already unidirectional — just squelch the
    // tiny at-rest noise some pads report instead of stick-style rescaling.
    const throttle = this.triggerValue(pad.buttons[7]);
    const brake = this.triggerValue(pad.buttons[6]);

    return {
      throttle: clamp(throttle, 0, 1),
      steering: clamp(steering, -1, 1),
      brake: clamp(brake, 0, 1),
    };
  }

  private triggerValue(button: GamepadButton | undefined): number {
    const v = button?.value ?? (button?.pressed ? 1 : 0);
    return v < 0.02 ? 0 : v;
  }
}
