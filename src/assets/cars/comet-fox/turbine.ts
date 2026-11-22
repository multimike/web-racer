import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, loft, mixOklab, paint, revolve, sphere, toRGB, torus } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import type { CarSpinner } from '../../types';
import { STEEL, addBolt, fanSpinner } from '../parts';
import { INTAKE_R, INTAKE_X, INTAKE_Z, NOZZLE_R, ROTOR_R, ROTOR_Z, TURBINE_EXIT, TURBINE_FRONT, TURBINE_R, TURBINE_Y } from './layout';
import type { Paints } from './layout';

/**
 * COMET FOX turbine, resolved the way the brief asks: ONE longitudinal main
 * housing with a rear-facing rotor in its nozzle, and the blue disc of the
 * side view as a separate LATERAL intake on each flank of the housing.
 * Static parts go into the body; the three rotors are `CarSpinner`s.
 *
 * Three sections as on the sheet: a steel intake lip, a mid-grey barrel
 * between two steel hoops carrying the cyan light strips, and a dark
 * nozzle cone converging to ~63 % of the barrel with a glowing exit ring.
 * Every opening shows a GLOW DISC — white-hot core, cyan, deep blue rim,
 * with rays — behind its rotor: the turbine reads lit even standing still.
 */

const HOUSING = paint('#6E727C', { gloss: 0.62, metal: 0.7 });
const PANEL = paint('#565A64', { gloss: 0.55, metal: 0.6 });
const NOZZLE = paint('#363840', { gloss: 0.55, metal: 0.45 });
const SEAM = paint('#24252C', { gloss: 0.3 });

/** The glow's three colour stops, from the livery's glow and rotor colours. */
function glowPaints(P: Paints): { core: Paint; mid: Paint; rim: Paint; bore: Paint; ray: Paint } {
  const glow = P.GLOW.color;
  const deep = P.ROTOR.color;
  return {
    core: paint(mixOklab(glow, toRGB('#FFFFFF'), 0.72), { emissive: 1, gloss: 0.9 }),
    mid: paint(glow, { emissive: 0.95, gloss: 0.9 }),
    rim: paint(mixOklab(glow, deep, 0.7), { emissive: 0.8, gloss: 0.9 }),
    bore: paint(mixOklab(deep, toRGB('#10162A'), 0.55), { emissive: 0.35, gloss: 0.6 }),
    ray: paint(mixOklab(glow, toRGB('#FFFFFF'), 0.35), { emissive: 0.95, gloss: 0.9 }),
  };
}

/**
 * Flat glow disc facing −Z at the origin: concentric bands (core, mid, rim)
 * with thin raised rays. Built facing −Z so the caller turns it like a fan
 * rotor; the rays stand 3 mm proud so they never share a plane with it.
 */
function glowDisc(m: SolidMesh, P: Paints, radius: number, rays: number): void {
  const G = glowPaints(P);
  const s = m.mark();
  // Profile walked outer → centre on a plane facing +Y, then +Y → −Z.
  revolve(
    m,
    { profile: [[radius, 0], [radius * 0.62, 0], [radius * 0.3, 0], [0, 0]], segments: 24 },
    (band) => (band === 0 ? G.rim : band === 1 ? G.mid : G.core),
  );
  for (let k = 0; k < rays; k++) {
    const st = m.mark();
    const a = radius * 0.26;
    const b = radius * 0.94;
    const w0 = radius * 0.018;
    const w1 = radius * 0.04;
    // A tapering ray lying on the disc: a low wedge, top face toward +Y.
    loft(
      m,
      {
        rings: [a, b].map((x, i) => {
          const w = i === 0 ? w0 : w1;
          return [new Vector3(x, -0.002, -w), new Vector3(x, -0.002, w), new Vector3(x, 0.003, w * 0.6), new Vector3(x, 0.003, -w * 0.6)];
        }),
        subdivisions: 1,
        caps: true,
      },
      k % 2 ? G.ray : G.mid,
    );
    m.rotate('y', (k * 360) / rays, st);
  }
  m.rotate('x', -90, s);
}

export function addTurbine(m: SolidMesh, P: Paints): void {
  const G = glowPaints(P);
  const R = TURBINE_R;
  const ring = R + 0.016;
  const z0 = TURBINE_EXIT;
  const zf = TURBINE_FRONT;
  const coneRoot = -1.43;
  // One solid of revolution about the car's long axis, walked from the floor
  // of the nozzle (behind the rotor) out along the bore, over the exit lip,
  // forward along the outside, over the intake lip and down the intake
  // throat to its floor. Profile [radius, z] with the paint of the band that
  // STARTS at each point.
  const bore = NOZZLE_R - 0.024;
  const profile: [number, number, Paint][] = [
    [0, ROTOR_Z + 0.06, G.bore],
    [bore + 0.012, ROTOR_Z + 0.06, G.bore],
    [bore + 0.004, ROTOR_Z - 0.04, G.bore],
    [bore, z0 + 0.014, G.mid],
    [bore + 0.006, z0, G.mid],
    [NOZZLE_R - 0.004, z0, G.mid],
    [NOZZLE_R, z0 + 0.008, G.mid],
    [NOZZLE_R + 0.002, z0 + 0.024, NOZZLE],
    // The cone: converging straight, so the exit reads sharp in profile.
    [(NOZZLE_R + R) * 0.5, (z0 + coneRoot) * 0.5, NOZZLE],
    [R - 0.014, coneRoot - 0.01, NOZZLE],
    [R - 0.006, coneRoot + 0.004, SEAM],
    [R - 0.004, coneRoot + 0.012, STEEL],
    [ring, coneRoot + 0.02, STEEL],
    [ring, -1.35, STEEL],
    [R, -1.342, HOUSING],
    [R, -1.218, STEEL],
    [ring, -1.21, STEEL],
    [ring, -1.15, STEEL],
    [R, -1.142, HOUSING],
    [R, zf - 0.06, STEEL],
    [R + 0.008, zf - 0.045, STEEL],
    [R + 0.008, zf - 0.03, STEEL],
    [R - 0.01, zf, STEEL],
    [R - 0.034, zf - 0.006, SEAM],
    [R - 0.044, zf - 0.03, SEAM],
    [R - 0.046, zf - 0.1, SEAM],
    [0, zf - 0.1, SEAM],
  ];
  revolve(m, { profile: profile.map(([r, z]) => [r, z] as Vec2), segments: 30, rot: [90, 0, 0], at: [0, TURBINE_Y, 0] }, (band) => profile[band][2]);

  // Panel seams on the barrel (the sheet's dark panelled sections between
  // the strips) and the cyan light strips let into them.
  for (let k = 0; k < 8; k++) {
    const s = m.mark();
    box(m, { size: [0.026, 0.012, 0.1], at: [0, R - 0.003, -1.28] }, P.GLOW);
    box(m, { size: [0.07, 0.008, 0.118], at: [0, R - 0.002, -1.28] }, PANEL);
    m.rotate('z', k * 45 + 22.5, s);
    m.translate([0, TURBINE_Y, 0], s);
  }
  // Short glowing dashes round the root of the nozzle cone, and the clamp
  // lugs of the rear hoop between them.
  for (let k = 0; k < 10; k++) {
    const s = m.mark();
    box(m, { size: [0.026, 0.014, 0.05], at: [0, R - 0.024, -1.48], rot: [-14, 0, 0] }, P.GLOW);
    box(m, { size: [0.05, 0.022, 0.05], at: [0, ring + 0.002, -1.384] }, HOUSING);
    m.rotate('z', k * 36 + 18, s);
    m.translate([0, TURBINE_Y, 0], s);
  }
  // Bolt circle on the front hoop.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    addBolt(m, { at: [Math.cos(a) * (ring - 0.002), TURBINE_Y + Math.sin(a) * (ring - 0.002), -1.18], normal: [Math.cos(a), Math.sin(a), 0], radius: 0.009, style: 'button' });
  }

  // Glow disc deep in the nozzle, just in front of the rear rotor.
  const back = m.mark();
  glowDisc(m, P, bore + 0.006, 14);
  m.translate([0, TURBINE_Y, ROTOR_Z + 0.055], back);

  // Front intake: its own glow disc on the throat's floor, with static guide
  // vanes over it and a glowing nose cone.
  const front = m.mark();
  glowDisc(m, P, R - 0.046, 12);
  m.rotate('y', 180, front);
  m.translate([0, TURBINE_Y, zf - 0.098], front);
  for (let k = 0; k < 10; k++) {
    const s = m.mark();
    box(m, { min: [-0.005, 0.055, zf - 0.1], max: [0.005, R - 0.05, zf - 0.04] }, STEEL);
    m.rotate('y', 28, s, [0, 0.12, zf - 0.07]);
    m.rotate('z', k * 36, s);
    m.translate([0, TURBINE_Y, 0], s);
  }
  sphere(m, { radius: 0.06, segments: 14, rings: 6, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [0, TURBINE_Y, zf - 0.1] }, G.core);
  torus(m, { radius: 0.062, tube: 0.008, segments: 16, sides: 5, rot: [90, 0, 0], at: [0, TURBINE_Y, zf - 0.095] }, STEEL);

  // Lateral intakes: a faired pod standing out of each flank of the barrel,
  // a steel lip, a short throat and a glow disc behind the rotor.
  for (const side of [-1, 1]) {
    const s = m.mark();
    const ri = INTAKE_R;
    const x1 = INTAKE_X;
    revolve(
      m,
      {
        profile: [
          [0, R * 0.55],
          [ri + 0.03, R * 0.55],
          [ri + 0.034, x1 - 0.06],
          [ri + 0.034, x1 - 0.022],
          [ri + 0.022, x1],
          [ri + 0.006, x1 - 0.002],
          [ri, x1 - 0.012],
          [ri - 0.004, x1 - 0.05],
          [0, x1 - 0.05],
        ],
        segments: 30,
        rot: [0, 0, -90],
      },
      (band) => (band <= 1 ? PANEL : band <= 5 ? STEEL : G.bore),
    );
    const d = m.mark();
    glowDisc(m, P, ri - 0.006, 14);
    m.rotate('y', -90, d);
    m.translate([x1 - 0.048, 0, 0], d);
    if (side < 0) m.mirror('x', s);
    m.translate([0, TURBINE_Y, INTAKE_Z], s);
  }
}

/**
 * A glowing rotor, built like the library's fan rotor (disc in XY, cap
 * toward −Z) so `fanSpinner` can aim it: thin swept blades that leave the
 * glow disc behind them visible, lit from within (bright at the root,
 * deepening to the rotor colour at the tip), and a white-hot hub.
 */
function glowRotor(P: Paints, radius: number, blades: number): SolidMesh {
  const G = glowPaints(P);
  const m = new SolidMesh();
  const R = radius;
  const hub = R * 0.26;
  sphere(m, { radius: hub, segments: 16, rings: 6, latitude: [0, 90], caps: false, rot: [-90, 0, 0], at: [0, 0, 0] }, G.core);
  // Steel collar behind the dome, its top tucked inside the dome's rim.
  revolve(m, { profile: [[0, -R * 0.1], [hub * 1.06, -R * 0.1], [hub * 1.06, R * 0.01], [hub * 0.95, R * 0.03]], segments: 16, rot: [-90, 0, 0] }, STEEL);
  const BLADE = paint(P.ROTOR, { emissive: 0.75, gloss: 0.85 });
  const tip = toRGB(P.ROTOR.color);
  const root = mixOklab(P.GLOW.color, toRGB('#FFFFFF'), 0.2);
  for (let k = 0; k < blades; k++) {
    const s = m.mark();
    const st: [number, number, number, number][] = [
      [hub * 0.9, R * 0.1, 42, 0],
      [R * 0.6, R * 0.13, 30, 6],
      [R * 0.97, R * 0.1, 20, 14],
    ];
    const rings = st.map(([y, chord, pitch, sweep]) => {
      const a = (pitch * Math.PI) / 180;
      const b = (sweep * Math.PI) / 180;
      const t = R * 0.025;
      const corners: [number, number][] = [[-chord / 2, -t], [chord / 2, -t], [chord / 2, t], [-chord / 2, t]];
      return corners.map(([cx, cz]) => {
        const x = cx * Math.cos(a) - cz * Math.sin(a);
        const z = cx * Math.sin(a) + cz * Math.cos(a);
        return new Vector3(x * Math.cos(b) + y * Math.sin(b), y * Math.cos(b) - x * Math.sin(b), z);
      });
    });
    loft(m, { rings, subdivisions: 1, caps: true }, BLADE);
    m.recolor((p) => mixOklab(root, tip, Math.min(1, Math.max(0, (Math.hypot(p.x, p.y) - hub) / (R - hub)))), s);
    m.rotate('z', (k * 360) / blades, s);
  }
  return m;
}

/** The three spinning parts: the rear rotor in the nozzle and one rotor in
 * each lateral intake. */
export function turbineSpinners(P: Paints): CarSpinner[] {
  const rear = glowRotor(P, ROTOR_R, 9);
  const side = (): SolidMesh => glowRotor(P, INTAKE_R - 0.012, 8);
  return [
    fanSpinner(rear, [0, TURBINE_Y, ROTOR_Z], [0, 0, -1], { idle: 10, full: 90 }),
    fanSpinner(side(), [INTAKE_X - 0.03, TURBINE_Y, INTAKE_Z], [1, 0, 0], { idle: 6, full: 50 }),
    fanSpinner(side(), [-(INTAKE_X - 0.03), TURBINE_Y, INTAKE_Z], [-1, 0, 0], { idle: 6, full: 50 }),
  ];
}
