import { SolidMesh, cylinder, extrudePolygon, paint, roundedBox, sphere, tube } from '../../../gfx/solid';
import type { Paint } from '../../../gfx/solid';
import { CHARCOAL, GUNMETAL, STEEL, addBolt, addCageTube, addFloorPan } from '../parts';
import type { P3, RunningGear } from '../parts';
import { AXLE_F, AXLE_R, BELT_FRONT, BELT_MID, BELT_REAR, FLOOR, HOOP_Z, ROOF_Y, SILL_A, SILL_B, SILL_FRONT, SILL_REAR, TUBE, TURBINE_R, TURBINE_Y } from './layout';
import type { Paints } from './layout';
import { noseBottom, noseTop } from './shell';

/**
 * COMET FOX chassis: the dark tub and keel the shell lies on, the teal tube
 * frame, the rear gearbox and the cradle that carries the turbine.
 *
 * Every tube ends ON the centre line of the tube it joins (or deep inside a
 * panel), on a straight run — a filleted corner point is thin air.
 */

const mx = (p: P3): P3 => [-p[0], p[1], p[2]];
const lerp3 = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Half-width of the main hoop's leg at height y (it leans in above the belt). */
const HOOP_KNEE: P3 = [BELT_REAR[0], 0.92, HOOP_Z];
const HOOP_TOP: P3 = [0.3, ROOF_Y, HOOP_Z];
/** Front corner of the roof rail, where the A-pillar bends into it. */
const ROOF_FRONT: P3 = [0.29, ROOF_Y, -0.06];
const hoopAt = (y: number): P3 => lerp3(HOOP_KNEE, HOOP_TOP, (y - HOOP_KNEE[1]) / (HOOP_TOP[1] - HOOP_KNEE[1]));

/** Keel: the narrow spine under the nose that the front suspension hangs on. */
export const KEEL = { half: 0.15, top: 0.5, front: AXLE_F + 0.145, back: 0.8 };
/** Gearbox between the rear wheels. */
export const GEARBOX = { half: 0.15, top: 0.64, front: AXLE_R + 0.27, back: AXLE_R - 0.25 };

export function addTub(m: SolidMesh, P: Paints): void {
  const TUB = paint(CHARCOAL, { gloss: 0.4 });
  // Undertray: its underside IS the ground clearance.
  addFloorPan(m, { min: [-0.41, -1.0], max: [0.41, 0.7], y: FLOOR, ribs: 4 });
  addFloorPan(m, { min: [-0.33, 0.68], max: [0.33, KEEL.back + 0.02], y: FLOOR, ribs: 0 });
  addFloorPan(m, { min: [-KEEL.half + 0.01, KEEL.back - 0.02], max: [KEEL.half - 0.01, KEEL.front - 0.02], y: FLOOR, ribs: 0 });
  // Sills inside the lower rails, and the firewall behind the seat.
  for (const s of [-1, 1]) {
    roundedBox(m, { min: [s * 0.365 - 0.04, FLOOR + 0.008, -0.98], max: [s * 0.365 + 0.04, 0.4, 0.68], radius: 0.03, segments: 2 }, TUB);
  }
  roundedBox(m, { min: [-0.42, FLOOR + 0.008, -0.74], max: [0.42, 0.9, -0.675], radius: 0.028, segments: 2 }, TUB);
  // Pedal box: the footwell's front wall, up to the underside of the nose.
  roundedBox(m, { min: [-0.2, FLOOR + 0.008, 0.66], max: [0.2, 0.69, KEEL.back + 0.03], radius: 0.04, segments: 2 }, TUB);
  // Keel.
  roundedBox(m, { min: [-KEEL.half, FLOOR + 0.006, KEEL.back - 0.05], max: [KEEL.half, KEEL.top, KEEL.front], radius: 0.035, segments: 2 }, TUB);
  // The keel's back rises into the nose's underside, so there is no
  // daylight between the two. Side view [z, y].
  extrudePolygon(m, { outline: [[KEEL.back, 0.45], [1.0, 0.45], [1.0, 0.47], [0.9, 0.53], [KEEL.back, 0.6]], depth: 0.25, centered: true, facing: '+x' }, TUB);
  // Fuel cell and gearbox behind the firewall.
  roundedBox(m, { min: [-0.27, FLOOR + 0.008, -1.0], max: [0.27, 0.68, -0.72], radius: 0.05, segments: 2 }, TUB);
  roundedBox(m, { min: [-GEARBOX.half, FLOOR + 0.012, GEARBOX.back], max: [GEARBOX.half, GEARBOX.top, GEARBOX.front], radius: 0.04, segments: 2 }, GUNMETAL);
  // Teal cover plate on the gearbox's tail (the sheet's rear view), bolted
  // at its corners, with the steel differential boss in the middle.
  roundedBox(m, { min: [-0.13, 0.37, GEARBOX.back - 0.03], max: [0.13, 0.6, GEARBOX.back + 0.01], radius: 0.014, segments: 2 }, P.CAGE);
  cylinder(m, { from: [0, 0.47, GEARBOX.back - 0.02], to: [0, 0.47, GEARBOX.back - 0.05], radius: 0.06, sides: 14, bevel: { top: 0.012 }, bevelSegments: 2 }, STEEL);
  for (const [x, y] of [[-0.1, 0.4], [0.1, 0.4], [-0.1, 0.57], [0.1, 0.57]]) {
    addBolt(m, { at: [x, y, GEARBOX.back - 0.029], normal: [0, 0, -1], radius: 0.012 });
  }
  // Filler cap on the fuel cell.
  cylinder(m, { from: [0.18, 0.675, -0.86], to: [0.18, 0.705, -0.86], radius: 0.045, sides: 12, bevel: { top: 0.01 } }, STEEL);
}

/** Where the A-pillar's centre line leaves the nose's top surface. */
function pillarExit(): P3 {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const t = (lo + hi) / 2;
    const p = lerp3(BELT_FRONT, ROOF_FRONT, t);
    if (p[1] < noseTop(p[0], p[2])) lo = t;
    else hi = t;
  }
  return lerp3(BELT_FRONT, ROOF_FRONT, hi);
}

export function addFrame(m: SolidMesh, P: Paints, gear: RunningGear): void {
  const C = P.CAGE;
  const r = TUBE;
  const t = (path: P3[], o: { fillet?: number; collars?: 'both' | 'start' | 'end' | 'none'; radius?: number; sides?: number; join?: number } = {}, p: Paint = C): void => {
    addCageTube(m, { path, radius: o.radius ?? r, fillet: o.fillet, sides: o.sides ?? 8, collars: o.collars ?? 'both', joinRadius: o.join }, p);
  };
  /** Ball node where several tubes meet (every end sunk into it). */
  const node = (at: P3, radius: number): void => {
    sphere(m, { radius, segments: 10, rings: 5, at }, C);
  };
  const both = (fn: (s: (p: P3) => P3) => void): void => {
    fn((p) => p);
    fn(mx);
  };

  // Main hoop: wide at the sills, leaning in above the belt to a narrow roof.
  const sillAtHoop: P3 = [SILL_B[0], SILL_B[1], HOOP_Z];
  t([mx(sillAtHoop), mx(HOOP_KNEE), mx(HOOP_TOP), HOOP_TOP, HOOP_KNEE, sillAtHoop], { fillet: 0.13, sides: 12 });
  // Harness bar across the hoop behind the seat's shoulders.
  t([mx(hoopAt(1.02)), hoopAt(1.02)], { radius: r * 0.85 });

  both((s) => {
    // Lower rail: out of the keel, round the cockpit, into the gearbox.
    t([s([KEEL.half - 0.03, 0.365, 1.14]), s(SILL_FRONT), s(SILL_A), s(SILL_B), s(SILL_REAR), s([GEARBOX.half - 0.03, 0.4, GEARBOX.front - 0.1])], { fillet: 0.12, collars: 'none', sides: 12 });
    // A-pillar and roof rail in one bend, from inside the nose's rear corner
    // to the hoop's top bar.
    t([s(BELT_FRONT), s(ROOF_FRONT), s([0.15, ROOF_Y, HOOP_Z])], { fillet: 0.1, collars: 'end', sides: 12 });
    // Down tube under the nose's flank to the lower rail.
    t([s(BELT_FRONT), s(lerp3(SILL_FRONT, SILL_A, 0.3))], { collars: 'end' });
    // Belt rail along the top of the flank panel.
    t([s(BELT_FRONT), s(BELT_MID), s(BELT_REAR)], { fillet: 0.1, collars: 'none', sides: 12 });
    // The two diagonals behind the panel's raked edges.
    t([s(lerp3(BELT_FRONT, BELT_MID, 0.9)), s([SILL_A[0], SILL_A[1], 0.26])]);
    t([s(BELT_REAR), s([SILL_B[0], SILL_B[1], -0.38])], { collars: 'end' });
    // Under the panel: a mid rail between the two diagonals and a V from it
    // down to the lower rail — the open W-truss the sheet shows below the
    // beltline.
    const F0 = lerp3(BELT_FRONT, BELT_MID, 0.9);
    const F1: P3 = [SILL_A[0], SILL_A[1], 0.26];
    const R1: P3 = [SILL_B[0], SILL_B[1], -0.38];
    const MID_Y = 0.49;
    const fm = lerp3(F0, F1, (F0[1] - MID_Y) / (F0[1] - F1[1]));
    const rm = lerp3(BELT_REAR, R1, (BELT_REAR[1] - MID_Y) / (BELT_REAR[1] - R1[1]));
    t([s(fm), s(rm)], { collars: 'both', radius: r * 0.9 });
    const apex = lerp3(fm, rm, 0.5);
    t([s(apex), s([SILL_A[0], SILL_A[1], 0.03])], { collars: 'both', radius: r * 0.85 });
    t([s(apex), s([SILL_B[0], SILL_B[1], -0.48])], { collars: 'both', radius: r * 0.85 });
    // Front bay: a diagonal from the lower rail up into the nose's underside,
    // crossing the down tube — open teal truss between wheel and panel.
    t([s(lerp3(SILL_FRONT, SILL_A, 0.72)), s([0.34, noseBottom(0.88) + 0.06, 0.88])], { collars: 'start' });
    // Stay from high on the hoop's leg (below its bend — the roof corners
    // are filleted, not noded) down to the belt's rear node, and the leg
    // from there down into the gearbox.
    t([s(hoopAt(ROOF_Y - 0.13)), s(BELT_REAR)], { collars: 'start' });
    t([s(BELT_REAR), s([GEARBOX.half - 0.02, 0.46, GEARBOX.front - 0.04])], { collars: 'none' });
    node(s(BELT_REAR), r * 1.45);
    // Weld boss where the A-pillar comes up through the bonnet.
    const exit = pillarExit();
    cylinder(m, { from: s(lerp3(exit, BELT_FRONT, 0.05)), to: s(lerp3(exit, ROOF_FRONT, 0.035)), radius: r + 0.016, sides: 12, bevel: { top: 0.008 }, bevelSegments: 2 }, C);
    node(s(BELT_FRONT), r * 1.45);

    // Turbine cradle: a longeron from the roof bar onto the housing's back, a
    // stay from the belt node into its side.
    t([s([0.13, ROOF_Y, HOOP_Z]), s([0.1, TURBINE_Y + 0.17, -1.02])], { collars: 'start', radius: r * 0.9 });
    t([s(BELT_REAR), s([0.15, TURBINE_Y - 0.17, -1.22])], { collars: 'none', radius: r * 0.9 });
  });
  // Roof bar ahead of the driver's head.
  const roofX = ROOF_FRONT[0] + (0.15 - ROOF_FRONT[0]) * ((ROOF_FRONT[2] + 0.15) / (ROOF_FRONT[2] - HOOP_Z));
  t([[-roofX, ROOF_Y, -0.15], [roofX, ROOF_Y, -0.15]], { radius: r * 0.9 });

  // Shock towers. Front: an outrigger from the keel up to each coil-over's
  // top eye, tucked under the nose's edge. Rear: an A-frame from the gearbox
  // up to the eye and on into the turbine's belly — the cradle's rear legs.
  const front = gear.anchors[1].damperTop;
  const rear = gear.anchors[3].damperTop;
  both((s) => {
    t([s([KEEL.half - 0.04, 0.44, front[2]]), s([front[0] - 0.02, front[1] + 0.005, front[2]])], { collars: 'none', radius: r * 0.9 });
    node(s([front[0] - 0.02, front[1] + 0.005, front[2]]), r * 1.25);
    t([s([GEARBOX.half - 0.04, GEARBOX.top - 0.06, rear[2]]), s([rear[0] - 0.015, rear[1] + 0.01, rear[2]]), s([0.1, TURBINE_Y - 0.13, rear[2]])], { fillet: 0.07, collars: 'none' });
    // V-brace from the gearbox's centre to the turbine's flanks (rear view).
    t([s([0.03, GEARBOX.top - 0.03, AXLE_R - 0.08]), s([0.14, TURBINE_Y - 0.14, AXLE_R - 0.08])], { collars: 'none', radius: r * 0.85 });
  });

  // Fuel line from the cell's filler side up into the turbine's belly.
  tube(m, { path: [[-0.18, 0.66, -0.84], [-0.2, 0.88, -0.86], [-0.1, 1.0, -0.98], [-0.06, TURBINE_Y - TURBINE_R + 0.04, -1.0]], radius: 0.016, sides: 8, fillet: 0.06, caps: false }, STEEL);

  // Side bar: the bare-metal rub rail under each lower rail, on two stubs.
  both((s) => {
    const x = SILL_A[0] + 0.075;
    const y = SILL_A[1] - 0.025;
    // It spans the whole gap between the wheels and bends in at both ends
    // into the lower rail.
    tube(m, { path: [s([0.37, 0.335, 0.74]), s([x, y, 0.56]), s([x, y, -0.5]), s([0.47, 0.335, -0.66])], radius: 0.021, sides: 10, fillet: 0.08, caps: 'round' }, STEEL);
    for (const z of [0.3, -0.45]) {
      cylinder(m, { from: s([SILL_A[0], SILL_A[1], z]), to: s([x, y, z]), radius: 0.016, sides: 8, caps: false }, GUNMETAL);
      sphere(m, { radius: 0.03, segments: 8, rings: 5, at: s([x, y, z]) }, STEEL);
    }
  });
}
