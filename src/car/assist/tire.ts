/**
 * Tire model of the 'assist' vehicle: an isotropic friction-circle law with a
 * peak, the same family as the physics lab's reference car.
 *
 *   slip vector  s = (rim speed − ground speed along the wheel, −sideways speed)
 *   normalised   rho = |s| / (reference speed · peakSlip)
 *   force        mu · N · shape(rho), pointing along s
 *
 * `shape` rises to exactly 1 at rho = 1 (the peak: slip angle = peak slip
 * angle with no wheelspin) and settles to `slideShare` when the tire slides
 * outright. Because the direction is that of the slip VELOCITY, a spinning
 * or locked wheel loses side force exactly the way a Coulomb contact does —
 * which is what keeps this model and Havok's friction in agreement about
 * what a sliding tire should deliver.
 */
export class TireCurve {
  private share = 0.9;

  /** Set the sliding-grip share (0..1). */
  configure(slideShare: number): void {
    this.share = Math.min(1, Math.max(0.3, slideShare));
  }

  /**
   * Force share of mu·N at normalised slip rho ≥ 0:
   *   rising branch  1 − (1 − rho)²       (initial slope 2 → cornering
   *                                        stiffness 2·mu·N / peak slip)
   *   past the peak  share + (1 − share) / (1 + ((rho − 1) / 1.5)²)
   * Both branches meet at rho = 1 with value 1 and zero slope.
   */
  shape(rho: number): number {
    if (rho <= 0) return 0;
    if (rho <= 1) return 1 - (1 - rho) * (1 - rho);
    const x = (rho - 1) / 1.5;
    return this.share + (1 - this.share) / (1 + x * x);
  }

  /** Inverse of `shape` on the rising branch: the normalised slip (0..1)
   * at which the tire delivers `share` (0..1) of its peak force. */
  slipFor(share: number): number {
    if (share <= 0) return 0;
    if (share >= 1) return 1;
    return 1 - Math.sqrt(1 - share);
  }
}

/** Smooth 0..1 ramp between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
