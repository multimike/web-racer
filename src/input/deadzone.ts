/** Rescales a stick axis so |value| < threshold reads as 0, without a jump past the threshold. */
export function applyDeadzone(value: number, threshold = 0.12): number {
  const abs = Math.abs(value);
  if (abs < threshold) return 0;
  return Math.sign(value) * ((abs - threshold) / (1 - threshold));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
