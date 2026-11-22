import { SolidMesh, compose, cylinder, loft, paint, ringXZ, rotation, roundedBox, roundedRectRing, sweep, translation, tube } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { STEEL } from '../parts';
import type { P3 } from '../parts';

/**
 * Reef Rocket's bucket seat — a local variant of the shared `addSeat`, whose
 * back is a crescent loft with a hip flare, a waist and shoulder wings (a
 * zig-zag outline up close) and whose cushion is painted by face normal (a
 * stair-stepped edge). The sheet draws a soft padded toy bucket instead: a
 * smooth cream shell, a coral pad standing proud of it, and two fat round
 * bolsters. Every colour boundary here is a separate soft part, so it is
 * clean at any distance.
 *
 * Same frame and hip point as `addSeat` (the driver is posed for it): the
 * back's cushion face sits BACK_FACE ahead of the back's own origin, which is
 * reclined and placed 0.235 behind the hip point.
 */

const BACK_FACE = 0.118;

export interface ReefSeatOptions {
  at: P3;
  width: number;
  backHeight: number;
  recline: number;
  shell: Paint;
  cushion: Paint;
  bolster: Paint;
  harness: Paint;
}

export function addReefSeat(m: SolidMesh, o: ReefSeatOptions): void {
  const w = o.width;
  const H = o.backHeight;
  const s = new SolidMesh();

  // --- base: shell tray, cushion, and round hip bolsters (nose tipped up 5°)
  roundedBox(s, { size: [w, 0.12, 0.48], radius: 0.05, segments: 2, rot: [-5, 0, 0], at: [0, -0.08, 0.12] }, o.shell);
  roundedBox(s, { size: [w - 0.17, 0.07, 0.43], radius: 0.032, segments: 2, rot: [-5, 0, 0], at: [0, -0.034, 0.13] }, o.cushion);
  for (const side of [-1, 1]) {
    tube(s, { path: [[side * (w / 2 - 0.05), -0.02, -0.08], [side * (w / 2 - 0.052), 0.0, 0.12], [side * (w / 2 - 0.05), -0.012, 0.32]], radius: 0.05, sides: 12, caps: 'round' }, o.bolster);
  }

  // --- back, built upright facing +z with its base on the local origin -----
  const b = new SolidMesh();
  // Shell: smooth horizontal rounded-rect sections, widest at the shoulders,
  // rounding over into a soft head bolster at the top.
  const D = 0.12;
  const zc = BACK_FACE - 0.012 - D / 2;
  const shell: [number, number, number][] = [
    // [height fraction, width, depth scale]
    [0.0, w * 0.96, 1],
    [0.3, w * 0.98, 1],
    [0.62, w * 1.06, 1],
    [0.86, w * 1.02, 1],
    [0.97, w * 0.84, 0.92],
    [1.02, w * 0.6, 0.7],
  ];
  loft(b, { rings: shell.map(([f, W, d]) => ringXZ(roundedRectRing(W, D * d, 0.05 * d, 3), f * H, 0, zc)), subdivisions: 3, caps: true }, o.shell);
  // Pad: a soft coral slab standing a few centimetres proud of the shell,
  // between the bolsters.
  const pad: [number, number][] = [
    [0.04, w - 0.2],
    [0.35, w - 0.2],
    [0.66, w - 0.16],
    [0.88, w - 0.2],
    [0.94, w - 0.34],
  ];
  loft(b, { rings: pad.map(([f, W]) => ringXZ(roundedRectRing(W, 0.06, 0.026, 3), f * H, 0, BACK_FACE - 0.02)), subdivisions: 3, caps: true }, o.cushion);
  // Side bolsters up the back: fat round rolls along the shell's front edge,
  // swelling at the ribs and at the shoulders.
  for (const side of [-1, 1]) {
    const x = (f: number): number => side * (w * (f > 0.5 ? 0.5 + 0.06 * Math.min(1, (f - 0.5) / 0.12) : 0.48) - 0.05);
    const path: P3[] = [0.04, 0.2, 0.4, 0.56, 0.7, 0.82].map((f) => [x(f), f * H, BACK_FACE - 0.005]);
    tube(b, { path, radius: (t: number) => 0.046 + 0.012 * Math.sin(Math.PI * t), sides: 12, caps: 'round' }, o.bolster);
  }
  s.append(b, compose(rotation('x', -o.recline), translation(0, -0.04, -0.235)));

  // --- 4-point harness lying on the seat ---------------------------------
  const strap: Vec2[] = [[-0.006, -0.025], [0.006, -0.025], [0.006, 0.025], [-0.006, 0.025]];
  const onBack = (x: number, y: number, z = 0.01): P3 => {
    const a = (-o.recline * Math.PI) / 180;
    const zz = BACK_FACE + z + 0.012;
    return [x, y * Math.cos(a) - zz * Math.sin(a) - 0.04, y * Math.sin(a) + zz * Math.cos(a) - 0.235];
  };
  for (const side of [-1, 1]) {
    sweep(s, { path: [onBack(side * w * 0.15, H * 0.97, -0.03), onBack(side * w * 0.15, H * 0.86), onBack(side * w * 0.13, H * 0.2), [side * 0.03, 0.03, 0.02]], section: strap, fillet: 0.04, filletSegments: 1, up: [0, 0, 1], caps: false }, o.harness);
    roundedBox(s, { size: [0.064, 0.036, 0.024], radius: 0.006, segments: 1, at: onBack(side * w * 0.142, H * 0.5, 0.016), rot: [-o.recline, 0, 0] }, STEEL);
    sweep(s, { path: [[side * (w / 2 - 0.09), 0.0, -0.03], [side * (w / 2 - 0.16), 0.03, 0.0], [side * 0.03, 0.03, 0.03]], section: strap, fillet: 0.03, filletSegments: 1, up: [0, 1, 0], caps: false }, o.harness);
  }
  cylinder(s, { from: [0, 0.012, 0.03], to: [0, 0.046, 0.022], radius: 0.042, sides: 16, bevel: { top: 0.006 }, bevelSegments: 1 }, STEEL);
  cylinder(s, { from: [0, 0.04, 0.023], to: [0, 0.053, 0.02], radius: 0.02, sides: 12, caps: 'top' }, paint('#E23A30', { gloss: 0.7 }));
  m.append(s, o.at);
}
