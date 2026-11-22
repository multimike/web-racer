import { SolidMesh, paint, revolve, roundedBox, tube } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import type { CarSpinner } from '../../types';
import { GUNMETAL, STEEL, buildFanRotor, fanSpinner } from '../parts';
import { BOOSTER_FRONT_Z, BOOSTER_MOUTH_Z, BOOSTER_RADIUS, BOOSTER_X, BOOSTER_Y, TURBINE_RADIUS, TURBINE_Z } from './layout';
import type { Livery, Paints } from './layout';
import { paintsOf } from './layout';

/**
 * BOOSTERS — the two compact jets over the motor box, as the sheet draws
 * them: a stubby dark can with a domed nose, thin steel clamp bands, one
 * glowing slot ring, and a short straight cyan lip. The mouth glows edge to
 * edge — a soft-glowing throat round a glowing turbine (the CarSpinner) and
 * a short jet cone — so from the chase camera the pair reads as two bright
 * cyan discs, not as two dark holes.
 */

const LENGTH = BOOSTER_FRONT_Z - BOOSTER_MOUTH_Z;
/** Can colour: dark gunmetal, a step lighter than the motor box under it. */
const CAN_HEX = '#3B3D48';

/** One booster about its own axis, nose at the local origin, nozzle mouth at
 * z = −LENGTH. */
function buildBooster(P: Paints): SolidMesh {
  const { GLOW, GLOW_SOFT } = P;
  const R = BOOSTER_RADIUS;
  const L = LENGTH;
  const CAN = paint(CAN_HEX, { gloss: 0.6, metal: 0.55 });
  const DOME = paint(CAN_HEX, { gloss: 0.7, metal: 0.4, smooth: 60 });
  // The lip glows a little: it must stay cyan from the chase camera, where
  // it faces away from the sun.
  const LIP = paint(P.ACCENT, { emissive: 0.25, gloss: 0.85 });
  const s = new SolidMesh();
  // Lathed about local +Y (y = distance back from the nose), then laid down.
  // Each point carries the paint of the band that STARTS at it.
  const pts: [number, number, Paint][] = [
    [0, 0, DOME],
    [R * 0.42, 0.008, DOME],
    [R * 0.72, 0.03, DOME],
    [R * 0.9, 0.062, DOME],
    [R * 0.95, 0.088, CAN],
    // front clamp band
    [R * 0.95, 0.1, STEEL],
    [R * 1.035, 0.106, STEEL],
    [R * 1.035, 0.13, STEEL],
    [R * 0.95, 0.136, CAN],
    // the can, with one recessed glowing slot ring two thirds of the way back
    [R * 0.95, L * 0.56, CAN],
    [R * 0.88, L * 0.565, GLOW],
    [R * 0.88, L * 0.64, CAN],
    [R * 0.95, L * 0.645, CAN],
    // rear clamp band
    [R * 0.95, L * 0.79, STEEL],
    [R * 1.035, L * 0.795, STEEL],
    [R * 1.035, L * 0.84, STEEL],
    [R * 0.97, L * 0.845, LIP],
    // the straight cyan lip, rounded over at the mouth
    [R * 1.0, L * 0.86, LIP],
    [R * 1.0, L * 0.975, LIP],
    [R * 0.985, L - 0.002, LIP],
    [R * 0.94, L, GLOW_SOFT],
    // down the glowing throat to the flame holder
    [R * 0.88, L - 0.012, GLOW_SOFT],
    [R * 0.84, L - 0.07, GLOW],
    [R * 0.4, L - 0.08, GLOW],
    [0, L - 0.085, GLOW],
  ];
  const profile: Vec2[] = pts.map(([r, y]) => [r, y]);
  revolve(s, { profile, segments: 24 }, (band) => pts[Math.min(band, pts.length - 1)][2]);
  // +Y (toward the nozzle) → −Z.
  s.rotate('x', -90);
  return s;
}

export function addBoosters(m: SolidMesh, P: Paints): void {
  const one = buildBooster(P);
  const CABLE = paint('#2A2A31', { gloss: 0.35 });
  const R = BOOSTER_RADIUS;
  for (const sx of [-1, 1]) {
    m.append(one, [sx * BOOSTER_X, BOOSTER_Y, BOOSTER_FRONT_Z]);
    // Saddles: on the booster cradle tube and on the rear hoop's top tube,
    // each rising into the can's belly.
    for (const [z, tubeY] of [
      [-1.05, 1.036],
      [-1.33, 0.99],
    ] as const) {
      roundedBox(m, { min: [sx * BOOSTER_X - 0.055, tubeY - 0.012, z - 0.035], max: [sx * BOOSTER_X + 0.055, BOOSTER_Y - R * 0.8, z + 0.035], radius: 0.012, segments: 1 }, GUNMETAL);
    }
    // Power lead: a fat cable from the booster's nose down into the motor box.
    tube(
      m,
      {
        path: [
          [sx * (BOOSTER_X - 0.02), BOOSTER_Y - R * 0.55, BOOSTER_FRONT_Z - 0.06],
          [sx * 0.1, 0.98, BOOSTER_FRONT_Z + 0.02],
          [sx * 0.075, 0.79, -0.85],
        ],
        radius: 0.019,
        sides: 6,
        fillet: 0.07,
        caps: false,
      },
      CABLE,
    );
  }
}

/** The two glowing turbines, one in each nozzle, counter-rotating, each with
 * its short jet cone (axisymmetric, so it looks still while the vanes turn). */
export function boosterSpinners(l: Livery): CarSpinner[] {
  const P = paintsOf(l);
  return [-1, 1].map((sx) => {
    const rotor = buildFanRotor({ radius: TURBINE_RADIUS, blades: 6, blade: P.GLOW_SOFT, hub: P.GLOW_CORE, glow: P.GLOW });
    // Jet cone out of the hub toward the rear (−Z), ending inside the tail.
    // A soft teardrop, not a spike: full at the hub, rounded tip.
    const r = TURBINE_RADIUS;
    revolve(rotor, { profile: [[r * 0.42, 0], [r * 0.55, 0.025], [r * 0.5, 0.06], [r * 0.3, 0.11], [r * 0.12, 0.145], [0, 0.155]], segments: 16, rot: [-90, 0, 0] }, P.GLOW);
    const sp = fanSpinner(rotor, [sx * BOOSTER_X, BOOSTER_Y, TURBINE_Z], [0, 0, -1], { idle: 10, full: 90 });
    return sx < 0 ? { ...sp, idleSpeed: -sp.idleSpeed, fullSpeed: -sp.fullSpeed } : sp;
  });
}
