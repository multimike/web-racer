import type { CarIntent, InputProvider } from './types';
import { ZERO_INTENT } from './types';
import { applyDeadzone, clamp } from './deadzone';
import { connectedPads } from './pads';

/**
 * Reads a plain (non-XR) gamepad via the Gamepad API, e.g. a DualShock 4
 * connected over Bluetooth/USB. Uses the "standard" mapping Chrome/Firefox/
 * Safari expose for the DS4: left stick = axes 0/1, right stick = axes 2/3.
 *
 * Trigger driving scheme: left stick steers, right trigger (R2) is the
 * accelerator, left trigger (L2) is the brake (and reverse, once stopped —
 * the vehicle decides which). Triggers are buttons 6/7 with an analog
 * `.value` in the "standard" Gamepad API mapping.
 *
 * Reads EVERY connected standard pad and takes the strongest signal per
 * control (see src/input/pads.ts), so another HID device listed first does
 * not hide the DualShock.
 */
export class DesktopGamepadInput implements InputProvider {
  readonly name = 'gamepad';
  private deadzone: number;

  constructor(deadzone = 0.12) {
    this.deadzone = deadzone;
  }

  isActive(): boolean {
    return connectedPads().length > 0;
  }

  poll(): CarIntent {
    const pads = connectedPads();
    if (pads.length === 0) return ZERO_INTENT;

    // Every connected pad, strongest signal per control (src/input/pads.ts).
    let steering = 0;
    let throttle = 0;
    let brake = 0;
    for (const pad of pads) {
      const s = applyDeadzone(pad.axes[0] ?? 0, this.deadzone);
      if (Math.abs(s) > Math.abs(steering)) steering = s;
      // Triggers rest at 0 and are already unidirectional — just squelch the
      // tiny at-rest noise some pads report instead of stick-style rescaling.
      throttle = Math.max(throttle, this.triggerValue(pad.buttons[7]));
      brake = Math.max(brake, this.triggerValue(pad.buttons[6]));
    }

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
