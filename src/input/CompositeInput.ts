import type { CarIntent, InputProvider } from './types';
import { ZERO_INTENT } from './types';

/**
 * Merges several InputProviders into one. Each frame, whichever active
 * provider is producing the strongest signal "wins" — so a gamepad and
 * keyboard can both stay plugged in and you can swap between them mid-game
 * without a mode switch. Ties favor whichever was registered first.
 */
export class CompositeInput implements InputProvider {
  readonly name = 'composite';
  private providers: InputProvider[];

  constructor(providers: InputProvider[]) {
    this.providers = providers;
  }

  isActive(): boolean {
    return this.providers.some((p) => p.isActive());
  }

  poll(): CarIntent {
    let best: CarIntent = ZERO_INTENT;
    let bestMagnitude = -1;

    for (const provider of this.providers) {
      if (!provider.isActive()) continue;
      const intent = provider.poll();
      const magnitude = Math.abs(intent.throttle) + Math.abs(intent.steering);
      if (magnitude > bestMagnitude) {
        bestMagnitude = magnitude;
        best = intent;
      }
    }

    return best;
  }
}
