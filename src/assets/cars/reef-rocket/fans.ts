import { SolidMesh, box, cylinder, paint, revolve, sphere } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { GUNMETAL, STEEL, buildFanRotor } from '../parts';
import type { Color, P3 } from '../parts';

/**
 * Reef Rocket's fan drums. A local variant of the shared `addFanDuct`: the
 * sheet draws a long fat barrel — cream, with a broad coral band round the
 * outlet, fat rolled lips and a DARK bore, so each fan face reads as a dark
 * turbine disc with a glowing hub in a cream ring — where the shared duct is
 * a short aerofoil ring with a plain motor pod.
 */

export interface FanDrumOptions {
  /** Centre of the drum. The flow runs along −z (out of the back). */
  at: P3;
  /** Rotor radius; the drum's bore is 1 cm larger. */
  rotor: number;
  /** Outer radius of the drum (its widest point, on the coral band). */
  outer: number;
  length: number;
  shell: Paint;
  band: Paint;
  glow: Paint;
}

/** Where the rotor's pivot sits behind the drum's centre. */
export const ROTOR_SETBACK = 0.09;

/** The bore: dark, so the blades and the glowing hub read against it. */
const BORE = paint('#2B2C33', { gloss: 0.3 });

export function addFanDrum(m: SolidMesh, o: FanDrumOptions): void {
  const s = new SolidMesh();
  const ri = o.rotor + 0.01;
  const ro = o.outer;
  const h = o.length / 2;
  // Lathed about +Y with +Y = the FRONT (inlet); turned onto +Z at the end.
  // Both lips are full half-rounds over a wall 5 cm thick (fat toy lips);
  // the barrel between them bellies out to the full outer radius on the
  // coral band, so the outline is a soft barrel, not a straight can.
  const rl = ro - 0.01; // outer edge of the lips
  const lr = (rl - ri) / 2;
  const rm = (rl + ri) / 2;
  const bandTop = -h + o.length * 0.4;
  const arc = (yc: number, from: number, to: number, n: number): Vec2[] => {
    const out: Vec2[] = [];
    for (let k = 0; k <= n; k++) {
      const a = ((from + ((to - from) * k) / n) * Math.PI) / 180;
      out.push([rm + lr * Math.cos(a), yc + lr * Math.sin(a)]);
    }
    return out;
  };
  // Walked counter-clockwise: up the outside from the band's lower edge,
  // over the inlet lip, down the bore, round the outlet lip, back out.
  const profile: Vec2[] = [
    [rl + 0.004, -h + lr + 0.002], //  0 band, lower edge (4 mm proud of the lip)
    [ro - 0.001, -h + lr + 0.045], //  1
    [ro, bandTop - 0.004], //          2 band, upper edge
    [ro - 0.004, bandTop + 0.004], //  3 step back to the cream barrel
    [ro - 0.003, bandTop + 0.06], //   4
    [rl + 0.004, h - lr - 0.045], //   5
    ...arc(h - lr, 0, 180, 6), //      6–12 inlet lip, outside → bore
    ...arc(-h + lr, 180, 360, 6), //  13–19 outlet lip, bore → outside
  ];
  // Band i runs from profile point i to i + 1: 0–2 coral band and its step,
  // 3–11 cream barrel and inlet lip, 12 the bore, 13–18 the cream outlet
  // lip, 19 the little step back out onto the band. Six steps per lip and
  // 36 around: the glossy lips are the first thing a close camera sees.
  revolve(s, { profile, closed: true, segments: 36 }, (band) => (band <= 2 || band >= 19 ? o.band : band === 12 ? BORE : o.shell));
  // Motor pod in the inlet on three stator vanes. Its nose cone glows; the
  // stub shaft from the cage enters through a steel collar at its tip.
  const pr = o.rotor * 0.36;
  const tip = h * 0.88;
  revolve(s, { profile: [[0, 0.0], [pr, 0.0], [pr, h * 0.5], [pr * 0.9, h * 0.66], [pr * 0.62, h * 0.8], [pr * 0.3, tip], [0, tip]], segments: 14 }, (band) => (band >= 3 ? o.glow : GUNMETAL));
  cylinder(s, { from: [0, tip - 0.02, 0], to: [0, tip + 0.012, 0], radius: 0.03, sides: 12, bevel: { top: 0.006 } }, STEEL);
  for (let k = 0; k < 3; k++) {
    const st = s.mark();
    box(s, { min: [pr * 0.7, h * 0.12, -0.012], max: [ri + 0.008, h * 0.42, 0.012] }, GUNMETAL);
    s.rotate('y', k * 120 + 90, st);
  }
  // A glowing ring let into the bore just ahead of the rotor: the drum
  // lights up inside when the fans run.
  // (An inward-facing wall: walked top to bottom.)
  revolve(s, { profile: [[ri + 0.004, 0.0], [ri - 0.008, -0.008], [ri - 0.008, -0.022], [ri + 0.004, -0.03]], segments: 24 }, o.glow);
  s.rotate('x', 90);
  s.translate(o.at);
  m.append(s);
}

/**
 * The rotor: the shared fan rotor with more blades (a dense dark disc, as on
 * the sheet) and a big glowing hub cap on its back — the bright eye the
 * chase camera sees in each fan.
 */
export function buildReefRotor(radius: number, glow: Color): SolidMesh {
  const rotor = buildFanRotor({ radius, blades: 11, glow });
  // Swallows the shared cap (radius 0.16 R); its base matches the hub's
  // radius where it sits, so there is no open rim.
  sphere(rotor, { radii: [radius * 0.27, radius * 0.17, radius * 0.27], segments: 16, rings: 4, latitude: [0, 90], caps: false, rot: [-90, 0, 0], at: [0, 0, -radius * 0.105] }, paint(glow, { emissive: 0.8, gloss: 0.9 }));
  return rotor;
}
