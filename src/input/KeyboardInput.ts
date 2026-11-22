import type { CarIntent, InputProvider } from './types';
import { clamp } from './deadzone';

/**
 * WASD / arrow-key fallback, handy for quick tweaks without a controller in hand.
 *
 * A key released while the page does not have focus never sends its keyup,
 * so every held key is dropped when the window loses focus (Cmd+Tab, a click
 * in DevTools) or the page is hidden — otherwise the car would drive on by
 * itself. macOS sends no keyup either for keys released while Cmd is down:
 * the keyup of Meta drops every key too. `dispose()` removes the listeners.
 */
export class KeyboardInput implements InputProvider {
  readonly name = 'keyboard';
  private keysDown = new Set<string>();
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keysDown.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta') this.keysDown.clear();
    else this.keysDown.delete(e.code);
  };
  private readonly onBlur = (): void => {
    this.keysDown.clear();
  };
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.keysDown.clear();
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Remove the listeners (the provider reads nothing afterwards). */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.keysDown.clear();
  }

  private isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keysDown.has(c));
  }

  isActive(): boolean {
    return true;
  }

  poll(): CarIntent {
    const forward = this.isDown('KeyW', 'ArrowUp') ? 1 : 0;
    // S/Down is the brake pedal; the vehicle turns it into reverse at standstill.
    const brake = this.isDown('KeyS', 'ArrowDown') ? 1 : 0;
    const left = this.isDown('KeyA', 'ArrowLeft') ? 1 : 0;
    const right = this.isDown('KeyD', 'ArrowRight') ? 1 : 0;

    return {
      throttle: forward,
      steering: clamp(right - left, -1, 1),
      brake,
    };
  }
}
