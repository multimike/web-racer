import { SolidMesh, box, cylinder, paint, revolve, roundedBox, sphere, tube } from '../../../gfx/solid';
import { GUNMETAL, STEEL, asPaint } from './common';
import type { Color, P3 } from './common';
import { WHEEL_BOSS_END, wheelLayout } from './wheel';
import type { WheelSize } from './wheel';

/**
 * HUBS — the non-spinning assembly behind each wheel: bearing carrier,
 * slotted brake disc, caliper, upright with its two ball joints, steering arm
 * and the foot the coil-over stands on.
 *
 * HUB FRAME (as `CarGeometry.hubFront` / `hubRear`): origin at the wheel
 * centre, x = axle toward the car's right, y up, z forward; authored for a
 * RIGHT wheel, so inboard is −x. The assembler mirrors it for the left side
 * and steers it with the wheel.
 *
 * The disc and caliper sit inside the rim's inboard cavity (see
 * `wheelLayout`), the upright just inboard of them.
 *
 * WHY THE COIL-OVER STANDS ON THE UPRIGHT, not on the lower wishbone as on a
 * real car: a `CarLink` has one anchor on the body and one in the hub frame,
 * so a damper whose foot rode on a wishbone would drift off it with every
 * bump and steer. The foot is a clevis cast into the upright instead, right
 * above the lower ball joint — it reads as "on the end of the lower arm" and
 * never leaves its mount. The upper wishbone is built around the spring
 * (suspension.ts).
 */

export interface HubSize extends WheelSize {
  /** Fore-aft position of the tie-rod eye on the steering arm, hub frame.
   * Negative = behind the axle (default −0.34 × radius). */
  tieRodZ?: number;
  /** OUTER radius of the coil spring that stands on this hub (default 17 %
   * of the tire radius, 60–90 mm — the fat springs of the design sheets). */
  coilRadius?: number;
  /**
   * Lower eye of the coil-over in the hub frame of a RIGHT wheel (inboard =
   * −x). Default: on the upright's inboard face just above the lower ball
   * joint. Move it when your car needs the coil-over elsewhere — e.g. `z`
   * −0.15 to stand it behind a half-shaft, or `y` above the upper ball joint
   * for a short coil-over on top of the arms. Give the hub and the
   * suspension the SAME value (`buildRunningGear` does that for you).
   */
  damperFoot?: P3;
}

/**
 * Where the suspension meets a hub, in the hub frame of a RIGHT wheel
 * (inboard = −x). `buildSuspension` mirrors x for the left side; `buildHub`
 * draws its joints at exactly these points.
 */
export interface HubLayout {
  upperJoint: P3;
  lowerJoint: P3;
  /** Tie-rod (front) / toe-link (rear) eye. */
  tieRod: P3;
  /** Lower eye of the coil-over. */
  damperFoot: P3;
  /** Outer end of a drive half-shaft. */
  axle: P3;
  discRadius: number;
  /** Outer radius of the coil spring (see `HubSize.coilRadius`). */
  coilRadius: number;
}

const UPRIGHT_X = -0.112;

/** Outer radius of the coil spring for a wheel size (see `HubSize.coilRadius`). */
export function coilRadiusFor(o: HubSize): number {
  return o.coilRadius ?? Math.min(0.09, Math.max(0.06, o.radius * 0.17));
}

/** Resolve the hub's hard points for a wheel size (see `HubLayout`). */
export function hubLayout(o: HubSize): HubLayout {
  const L = wheelLayout(o);
  // Ball joints as far apart as the rim's cavity allows.
  const yj = Math.min(o.radius * 0.3, L.cavityRadius - 0.05);
  const tz = o.tieRodZ ?? -o.radius * 0.34;
  const coil = coilRadiusFor(o);
  return {
    upperJoint: [UPRIGHT_X, yj, 0],
    lowerJoint: [UPRIGHT_X, -yj, 0],
    tieRod: [UPRIGHT_X, -yj * 0.55, tz],
    // On the upright's inboard face, just above the lower ball joint — as
    // close to the wheel centre as it can be, because that is the axis the
    // assembler steers the hub about: every centimetre further inboard is a
    // centimetre more the foot swings fore-aft at full lock.
    damperFoot: o.damperFoot ?? [UPRIGHT_X - 0.07, -yj + 0.1, 0],
    axle: [-0.15, 0, 0],
    discRadius: L.beadRadius - 0.055,
    coilRadius: coil,
  };
}

export interface HubOptions extends HubSize {
  /** Caliper colour — a small accent that shows through the rim from behind. */
  caliper?: Color;
  /** Draw the steering / toe arm to `tieRod` (default true; pass false on an
   * axle without a tie rod or toe link). */
  steeringArm?: boolean;
  /** Draw the coil-over foot (default true; false on an axle without
   * coil-overs). Its POSITION is `damperFoot` of `HubSize`. */
  foot?: boolean;
}

/**
 * Upright + slotted brake disc + caliper for one axle, in the hub frame of a
 * RIGHT wheel (inboard toward −x). Pass the SAME size options as the wheel
 * it sits behind. About 560 triangles.
 *   hubFront: buildHub({ radius: spec.frontTireRadius, width: spec.frontTireWidth, caliper: accent })
 */
export function buildHub(o: HubOptions): SolidMesh {
  const m = new SolidMesh();
  const H = hubLayout(o);
  const CALIPER = asPaint(o.caliper, paint('#FF6373', { gloss: 0.8 }), { gloss: 0.8 });
  const DARK = paint(GUNMETAL, { color: '#33343C' });
  const rd = H.discRadius;
  const yj = H.upperJoint[1];

  // Bearing carrier: runs into the wheel's spinning centre boss, so the two
  // never show a gap however the rim is dished.
  cylinder(m, { from: [-0.118, 0, 0], to: [WHEEL_BOSS_END + 0.018, 0, 0], radius: 0.055, sides: 10, caps: 'bottom' }, GUNMETAL);

  // Brake disc, lathed about the axle: dark hat, bright friction ring. It
  // starts inside the carrier, so it needs no bore.
  revolve(
    m,
    {
      profile: [
        [0.04, -0.074],
        [rd * 0.5, -0.074],
        [rd * 0.56, -0.064],
        [rd - 0.004, -0.064],
        [rd, -0.06],
        [rd, -0.044],
        [rd - 0.004, -0.04],
        [0.04, -0.04],
      ],
      segments: 18,
      rot: [0, 0, -90],
    },
    (band) => (band <= 1 ? DARK : STEEL),
  );
  // Swept slots on the inboard friction face — the face you see from behind
  // the car. Dark bars sunk into the plate, so it reads as a brake, not a lid.
  const slots = 8;
  for (let k = 0; k < slots; k++) {
    const s = m.mark();
    box(m, { size: [0.006, rd * 0.36, 0.011], rot: [24, 0, 0], at: [-0.064, rd * 0.78, 0] }, DARK);
    m.rotate('x', (k * 360) / slots + 12, s);
  }

  // Caliper, straddling the disc's rim up and behind the axle.
  const cs = m.mark();
  roundedBox(m, { size: [0.074, 0.08, 0.14], radius: 0.016, segments: 1, at: [-0.053, rd - 0.022, 0] }, CALIPER);
  for (const z of [-0.04, 0.04]) {
    cylinder(m, { from: [-0.088, rd - 0.02, z], to: [-0.098, rd - 0.02, z], radius: 0.012, sides: 6, round: false, caps: 'top' }, STEEL);
  }
  m.rotate('x', -42, cs);

  // Upright: a forged bar between the two ball joints, thickest at the axle.
  tube(m, { path: [[UPRIGHT_X, -yj, 0], [UPRIGHT_X + 0.014, 0, 0], [UPRIGHT_X, yj, 0]], radius: [0.027, 0.044, 0.027], sides: 7, caps: true }, GUNMETAL);

  if (o.steeringArm ?? true) {
    const t = H.tieRod;
    tube(m, { path: [[UPRIGHT_X + 0.005, t[1] + 0.012, 0], [t[0], t[1], t[2] * 0.6], t], radius: [0.03, 0.022, 0.018], sides: 6, caps: true }, GUNMETAL);
    sphere(m, { radius: 0.024, segments: 6, rings: 4, at: t }, GUNMETAL);
  }

  if (o.foot ?? true) {
    // The coil-over's clevis is cast into the upright, so it steers with the
    // wheel and the damper's lower eye never leaves its mount. A foot that
    // was moved off the upright (to stand the coil-over beside a half-shaft)
    // gets a stub arm out to it.
    const f = H.damperFoot;
    const y0 = Math.max(-yj + 0.03, Math.min(yj - 0.03, f[1]));
    const root: P3 = [UPRIGHT_X, y0, 0];
    const back: P3 = [f[0] + 0.042, f[1], f[2]];
    if (Math.hypot(back[0] - root[0], back[1] - root[1], back[2] - root[2]) > 0.03) {
      tube(m, { path: [root, back], radius: [0.03, 0.026], sides: 7 }, GUNMETAL);
    }
    // Back plate and two ears straddling the damper's eye.
    roundedBox(m, { min: [f[0] + 0.03, f[1] - 0.036, f[2] - 0.045], max: [f[0] + 0.054, f[1] + 0.036, f[2] + 0.045], radius: 0.006, segments: 1 }, GUNMETAL);
    for (const z of [-0.036, 0.036]) {
      roundedBox(m, { size: [0.08, 0.066, 0.016], radius: 0.006, segments: 1, at: [f[0] + 0.008, f[1], f[2] + z] }, GUNMETAL);
    }
    cylinder(m, { from: [f[0], f[1], f[2] - 0.052], to: [f[0], f[1], f[2] + 0.052], radius: 0.011, sides: 6, round: false }, STEEL);
  }
  return m;
}
