/** Game-level driving intent, decoupled from any specific input device. */
export interface CarIntent {
  /** -1 (full reverse) .. 1 (full forward) */
  throttle: number;
  /** -1 (full left) .. 1 (full right) */
  steering: number;
}

export const ZERO_INTENT: CarIntent = { throttle: 0, steering: 0 };

export interface InputProvider {
  readonly name: string;
  /** Whether this provider currently has a live device to read from. */
  isActive(): boolean;
  poll(): CarIntent;
}
