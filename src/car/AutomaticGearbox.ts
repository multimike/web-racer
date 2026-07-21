/**
 * Virtual automatic gearbox (ratio count = GEAR_TOPS.length). The physics
 * drivetrain is a plain velocity motor and knows nothing about gears — this
 * exists to give the engine SOUND an rpm curve that rises and drops through
 * shifts, and the GUI a gear to display. Fed from vehicle state every frame.
 */

/** Per-gear top speed as a fraction of tuning.maxSpeed (gear hits rpm 1.0 there). */
// Three wide ratios: each upshift drops rpm to ~0.5, a clearly audible fall.
const GEAR_TOPS = [0.35, 0.65, 1.0];
const UPSHIFT_RPM = 0.85;
const DOWNSHIFT_RPM = 0.35;
/** Min time between shifts so rpm noise can't make the box hunt. */
const SHIFT_COOLDOWN = 0.4;
/**
 * Torque-interrupt window after an upshift: the SOUND's throttle is cut so
 * the gated layer drops out and rpm audibly falls before pulling again. The
 * car accelerates gear-1-to-top in ~2 s, so without this the rpm re-climbs
 * faster than the shift drop can be heard.
 */
const SHIFT_CUT_TIME = 0.25;
/** Engine inertia: rpm chases its target with this time constant, s. */
const RPM_TAU = 0.15;
const IDLE_RPM = 0.08;
/** Torque-converter slip: flooring it from a stop revs to this rpm. */
const STALL_REV_RPM = 0.45;

export class AutomaticGearbox {
  /** Current forward gear 1..4 (also the ratio used in reverse). */
  gear = 1;
  reverse = false;
  /** Normalized engine speed, 0 = idle .. 1 = redline. Smoothed. */
  rpm = IDLE_RPM;
  private cooldown = 0;
  private shiftTimer = 0;

  /** True during the post-upshift torque interrupt — cut the sound's throttle. */
  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Number of forward gears (for the GUI's chip row). */
  get gearCount(): number {
    return GEAR_TOPS.length;
  }

  /** "R" or the current forward gear — what the GUI shows. */
  get label(): string {
    return this.reverse ? 'R' : String(this.gear);
  }

  /**
   * @param pedal      the active drive pedal 0..1 (throttle, or brake while reversing)
   * @param reversing  vehicle is in its reverse-drive state
   * @param maxSpeed   tuning.maxSpeed, read live so slider tweaks retune the box
   */
  update(dt: number, forwardSpeed: number, pedal: number, reversing: boolean, maxSpeed: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const speed = Math.abs(forwardSpeed);
    // Stay in R while actually rolling backward, even after the pedal lifts.
    this.reverse = reversing || forwardSpeed < -0.5;

    if (this.reverse) {
      this.gear = 1;
    } else if (this.cooldown === 0) {
      const r = speed / (GEAR_TOPS[this.gear - 1] * maxSpeed);
      if (r > UPSHIFT_RPM && this.gear < GEAR_TOPS.length) {
        this.gear += 1;
        this.cooldown = SHIFT_COOLDOWN;
        this.shiftTimer = SHIFT_CUT_TIME;
      } else if (r < DOWNSHIFT_RPM && this.gear > 1) {
        this.gear -= 1;
        this.cooldown = SHIFT_COOLDOWN;
      }
    }

    const top = GEAR_TOPS[this.gear - 1] * maxSpeed;
    let target = Math.min(speed / top, 1);
    if (this.gear === 1) {
      // Converter slip: revving against a stopped/slow car still makes noise.
      target = Math.max(target, pedal * STALL_REV_RPM);
    }
    target = Math.max(target, IDLE_RPM);

    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / RPM_TAU));
  }
}
