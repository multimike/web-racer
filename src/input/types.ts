/** Game-level driving intent, decoupled from any specific input device. */
export interface CarIntent {
  /** 0 .. 1 (full forward). Reverse comes from holding brake at standstill. */
  throttle: number;
  /** -1 (full left) .. 1 (full right) */
  steering: number;
  /** 0 .. 1. Brakes while moving; acts as reverse throttle once stopped. */
  brake: number;
}

export const ZERO_INTENT: CarIntent = { throttle: 0, steering: 0, brake: 0 };

export interface InputProvider {
  readonly name: string;
  /** Whether this provider currently has a live device to read from. */
  isActive(): boolean;
  poll(): CarIntent;
  /** Optional: remove event listeners (keyboard). */
  dispose?(): void;
}
