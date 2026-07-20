import type { CarIntent, InputProvider } from './types';
import { clamp } from './deadzone';

/** WASD / arrow-key fallback, handy for quick tweaks without a controller in hand. */
export class KeyboardInput implements InputProvider {
  readonly name = 'keyboard';
  private keysDown = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => this.keysDown.add(e.code));
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.code));
  }

  private isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keysDown.has(c));
  }

  isActive(): boolean {
    return true;
  }

  poll(): CarIntent {
    const forward = this.isDown('KeyW', 'ArrowUp') ? 1 : 0;
    const back = this.isDown('KeyS', 'ArrowDown') ? 1 : 0;
    const left = this.isDown('KeyA', 'ArrowLeft') ? 1 : 0;
    const right = this.isDown('KeyD', 'ArrowRight') ? 1 : 0;

    return {
      throttle: clamp(forward - back, -1, 1),
      steering: clamp(right - left, -1, 1),
    };
  }
}
