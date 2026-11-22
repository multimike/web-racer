import { SolidMesh, aim, box, cylinder, extrudePolygon, paint, revolve, roundedBox, sphere, toV3, tube } from '../../../gfx/solid';
import type { Paint, Vec2 } from '../../../gfx/solid';
import { CHARCOAL, GUNMETAL, STEEL, addBolt } from '../parts';
import type { P3 } from '../parts';
import { AXLE_F, AXLE_R, CLIP_FRONT_Z, FLOOR, HALF_SHAFT, N, POD_JOINT_Z, RAIL_Y, REAR_HOOP_Z, TUBE } from './layout';
import type { Paints } from './layout';

/**
 * TUBE FRAME — the violet space frame the whole car hangs from, tube by tube
 * as the sheet draws it, plus the floor, the undertrays and the motor /
 * battery box in the tail. Every tube ends ON the centre line of the tube it
 * joins (a weld bead there) or disappears into a shell.
 */

const mx = (p: readonly [number, number, number], s: number): P3 => [s * p[0], p[1], p[2]];

interface BarOptions {
  radius?: number;
  sides?: number;
  fillet?: number;
  /** Which ends get a weld bead (default both). */
  welds?: 'both' | 'start' | 'end' | 'none';
}

/** A weld bead round a tube end: the shared `addWeldCollar` at three bands
 * instead of four — this frame has some forty joints. */
function weld(m: SolidMesh, at: P3, toward: P3, radius: number, sides: number, p: Paint): void {
  // Where four or more tubes meet, one smooth node ball stands in for the
  // whole cluster (see BALL_NODES): a ring of collars there piles up.
  if (BALL_NODES.some((q) => Math.abs(Math.abs(at[0]) - q[0]) < 1e-6 && Math.abs(at[1] - q[1]) < 1e-6 && Math.abs(at[2] - q[2]) < 1e-6)) return;
  const a = toV3(at);
  const d = toV3(toward).subtract(a);
  const len = d.length();
  if (len < 1e-6) return;
  d.scaleInPlace(1 / len);
  // One tube radius back from the end: where this tube breaks the surface of
  // the (equally thick) tube it runs into.
  const c = a.add(d.scale(Math.min(TUBE * 1.02, len * 0.4)));
  const r = radius;
  revolve(
    m,
    {
      // A rounded bead: two bands, smooth-shaded.
      profile: [
        [r * 0.98, -r * 0.62],
        [r * 1.24, 0],
        [r * 0.98, r * 0.62],
      ],
      segments: Math.min(sides, 8),
      at: aim(c, c.add(d)),
    },
    p,
  );
}

/** Extra rings along the straight runs of a long tube (clear of the
 * fillets): the AO bake stores one value per vertex, and a tube with rings
 * only at its ends smears one dark corner over its whole length. */
function densify(path: P3[], fillet: number, step = 0.24): P3[] {
  const out: P3[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const margin = Math.min(len * 0.3, fillet * 1.3 + 0.02);
    const k = Math.floor((len - 2 * margin) / step);
    for (let j = 1; j <= k; j++) {
      const t = (margin + ((len - 2 * margin) * j) / (k + 1)) / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    out.push(b);
  }
  return out;
}

/** Frame nodes where four or more tubes end: a welded ball, no collars. */
const BALL_NODES: readonly (readonly [number, number, number])[] = [N.rearNode, N.doorRear, N.aFoot];

function bar(m: SolidMesh, path: P3[], p: Paint, o: BarOptions = {}): void {
  const radius = o.radius ?? TUBE;
  const sides = o.sides ?? 10;
  const fillet = o.fillet ?? 0.1;
  tube(m, { path: densify(path, fillet), radius, sides, fillet }, p);
  const welds = o.welds ?? 'both';
  const n = path.length;
  if (welds === 'both' || welds === 'start') weld(m, path[0], path[1], radius, sides, p);
  if (welds === 'both' || welds === 'end') weld(m, path[n - 1], path[n - 2], radius, sides, p);
}

export function addFrame(m: SolidMesh, P: Paints): void {
  const { CAGE } = P;
  const r = TUBE;

  for (const s of [-1, 1]) {
    const n = (k: keyof typeof N): P3 => mx(N[k], s);

    // Lower rail, nose to tail in one bent tube. Ahead of the front clip it
    // dives into the belly of the nose shell; its tail sinks into the hoop.
    bar(m, [[s * 0.02, 0.39, 1.44], n('lowFront'), n('lowNeck'), n('lowDoorFront'), n('lowDoorRear'), n('lowWaist'), n('lowRear')], CAGE, { welds: 'none', fillet: 0.16, sides: 10 });

    // Front clip: upper rail. It runs just under the beak's edge and stops
    // at the clip's front upright (ball node there).
    bar(m, [n('upFront'), n('upNeck')], CAGE, { welds: 'none' });
    sphere(m, { radius: r * 1.06, segments: 12, rings: 6, at: n('upFront') }, CAGE);
    // … and from the neck on up and out to the A-pillar's foot.
    bar(m, [n('upNeck'), n('aFoot')], CAGE);
    // Uprights and diagonal of the clip's side truss.
    bar(m, [n('lowFront'), n('upFront')], CAGE, { radius: r * 0.85, sides: 8, welds: 'none' });
    bar(m, [[s * 0.115, RAIL_Y, 0.88], [s * 0.205, 0.54, 0.88]], CAGE, { radius: r * 0.85, sides: 8, welds: 'none' });
    bar(m, [[s * 0.115, RAIL_Y, 0.9], [s * 0.2, 0.54, CLIP_FRONT_Z - 0.03]], CAGE, { radius: r * 0.75, sides: 8, welds: 'none' });

    // Door bar: horn → A-pillar foot → widest point → rear post. The horn's
    // free end is capped with a ball; the front coil-over hangs under it.
    bar(m, [n('hornTip'), n('doorFront'), n('aFoot'), n('doorWide'), n('doorRear')], CAGE, { fillet: 0.3, sides: 10, welds: 'end' });
    sphere(m, { radius: r * 1.04, segments: 12, rings: 6, at: n('hornTip') }, CAGE);
    // Strut holding the horn up: down and back to the lower rail, clear of
    // the hood (the diagonal of the sheet's side view).
    bar(m, [n('doorFront'), [s * 0.445, RAIL_Y, POD_JOINT_Z[0] + 0.02]], CAGE, { radius: r * 0.9, welds: 'start' });

    // A-pillar, roof rail and rear stay in one bent tube.
    bar(m, [n('aFoot'), n('roofFront'), n('roofRear'), n('rearNode')], CAGE, { fillet: 0.12, sides: 10 });
    // Rear post: door bar up to the rear node.
    bar(m, [n('doorRear'), n('rearNode')], CAGE, { sides: 10 });

    // Uprights between the door bar and the lower rail.
    // Their feet stand on the steel ball joints (below).
    bar(m, [n('aFoot'), [s * 0.455, RAIL_Y, POD_JOINT_Z[0]]], CAGE, { welds: 'start' });
    bar(m, [n('doorRear'), [s * 0.455, RAIL_Y, POD_JOINT_Z[1]]], CAGE, { welds: 'start' });
    // Rear clip: upper rail, and the tower leg from the rear node down
    // through it to the lower rail.
    bar(m, [n('upWaist'), n('upRear')], CAGE, { welds: 'none' });
    bar(m, [n('rearNode'), n('upWaist'), [s * 0.165, RAIL_Y, -0.9]], CAGE, { fillet: 0.08 });
    // Upper longeron: rear node back to the hoop's top corner.
    bar(m, [n('rearNode'), n('hoopTop')], CAGE);
    bar(m, [[s * 0.16, RAIL_Y, -1.28], [s * 0.19, 0.56, AXLE_R + 0.02]], CAGE, { radius: r * 0.75, sides: 8, welds: 'none' });
    // Brace from the lower rail's waist up to the door bar's rear end.
    bar(m, [[s * 0.3, RAIL_Y, -0.66], n('doorRear')], CAGE, { radius: r * 0.9 });
    for (const q of BALL_NODES) sphere(m, { radius: r * 1.25, segments: 14, rings: 8, at: mx(q, s) }, CAGE);
  }

  // Cross members.
  const cross = (p: readonly [number, number, number], o: BarOptions = {}): void => bar(m, [mx(p, -1), mx(p, 1)], CAGE, o);
  // Rear hoop: narrow at the floor, wide under the boosters.
  tube(m, { path: [mx(N.lowRear, -1), mx(N.upRear, -1), mx(N.hoopTop, -1), mx(N.hoopTop, 1), mx(N.upRear, 1), mx(N.lowRear, 1)], radius: r, fillet: 0.07, sides: 10, closed: true }, CAGE);
  cross(N.roofFront, { sides: 10 });
  cross(N.roofRear, { sides: 10 });
  cross(N.rearNode, { sides: 10 });
  cross(N.upNeck, { welds: 'none' });
  // The nose shell sits on this one: it passes through the beak's chin.
  cross([N.upFront[0], 0.555, 1.2], { welds: 'none', radius: r * 0.85 });
  cross([N.lowFront[0], RAIL_Y, CLIP_FRONT_Z], { welds: 'none', radius: r * 0.85 });
  cross([N.lowNeck[0], RAIL_Y, 0.84], { welds: 'none' });
  cross([N.lowWaist[0], RAIL_Y, -0.84], { welds: 'none' });
  // Booster cradle: a cross tube between the two upper longerons.
  cross([0.315, 1.035, -1.05]);

  // Hood posts: the nose shell stands on the clip's upper cross tube.
  for (const s of [-1, 1]) cylinder(m, { from: [s * 0.1, 0.54, 0.86], to: [s * 0.115, 0.745, 0.86], radius: 0.016, sides: 6, caps: false }, GUNMETAL);

  // Steering rack across the clip, between the two tie-rod ends.
  cylinder(m, { from: [-0.13, RAIL_Y + 0.06, AXLE_F - 0.126], to: [0.13, RAIL_Y + 0.06, AXLE_F - 0.126], radius: 0.026, sides: 8 }, GUNMETAL);
  cylinder(m, { from: [-0.05, RAIL_Y + 0.06, AXLE_F - 0.126], to: [0.05, RAIL_Y + 0.06, AXLE_F - 0.126], radius: 0.036, sides: 8, bevel: 0.008, bevelSegments: 1 }, GUNMETAL);

  // Steel ball joints where the pods bolt to the lower rail (the big round
  // nodes of the sheet's side view).
  for (const s of [-1, 1]) {
    for (const z of POD_JOINT_Z) {
      sphere(m, { radius: 0.031, segments: 12, rings: 6, at: [s * 0.462, RAIL_Y + 0.008, z] }, paint(STEEL, { smooth: 180 }));
      addBolt(m, { at: [s * 0.49, RAIL_Y + 0.008, z], normal: [s, 0, 0], radius: 0.012 }, GUNMETAL);
    }
  }
}

/** Floor pan, undertrays and the motor / battery box. */
export function addFloorAndMotor(m: SolidMesh, P: Paints): void {
  const { GLOW, CAGE } = P;
  // Dark pan: the sheet's floor is near-black, and a light floor glares up
  // through the open frame from every high camera.
  const PAN = paint('#34353D', { gloss: 0.4 });
  const t = 0.03;
  // One plate under the whole frame, following the lower rail's plan: its
  // underside is the car's ground clearance.
  const half: Vec2[] = [
    [0.07, CLIP_FRONT_Z + 0.035],
    [0.13, CLIP_FRONT_Z - 0.02],
    [0.13, 0.86],
    [0.47, 0.6],
    [0.47, -0.38],
    [0.175, -0.84],
    [0.175, REAR_HOOP_Z - 0.015],
  ];
  const outline: Vec2[] = [...half, ...half.map(([x, z]) => [-x, z] as Vec2).reverse()];
  // facing '+y': drawn as a top view, the solid grows upward from `at`.
  extrudePolygon(m, { outline, depth: t, bevel: 0.01, bevelSegments: 2, bevelBack: true, facing: '+y', at: [0, FLOOR, 0] }, PAN);
  // Pressed ribs in the footwell and under the seat.
  for (const x of [-0.3, -0.18, -0.06, 0.06, 0.18, 0.3]) {
    box(m, { min: [x - 0.026, FLOOR + t - 0.004, -0.4], max: [x + 0.026, FLOOR + t + 0.011, 0.46], faces: { ny: null } }, PAN);
  }
  // Under the pan: three skid runners and a row of bolt heads along each
  // edge, so the belly a jumping car shows has something to read.
  for (const x of [-0.2, 0, 0.2]) {
    box(m, { min: [x - 0.03, FLOOR - 0.012, -0.3], max: [x + 0.03, FLOOR + 0.004, 0.55], faces: { py: null } }, PAN);
  }
  for (const s of [-1, 1]) {
    for (const z of [0.45, 0.05, -0.3]) addBolt(m, { at: [s * 0.4, FLOOR, z], normal: [0, -1, 0], radius: 0.016 }, GUNMETAL);
  }
  // Heel plate under the pedals.
  roundedBox(m, { min: [-0.2, FLOOR + t - 0.004, 0.36], max: [0.2, FLOOR + t + 0.016, 0.62], radius: 0.008, segments: 1 }, GUNMETAL);

  // Motor / battery box, low between the rear rails.
  const BOX = paint(CHARCOAL, { gloss: 0.5 });
  const z0 = -1.27;
  const z1 = -0.76;
  roundedBox(m, { min: [-0.135, FLOOR + 0.02, z0], max: [0.135, 0.8, z1], radius: 0.05, segments: 2 }, BOX);
  // Cooling fins across its lid and down its back.
  for (let i = 0; i < 6; i++) {
    const z = z0 + 0.075 + i * 0.072;
    box(m, { min: [-0.115, 0.79, z - 0.014], max: [0.115, 0.828, z + 0.014], faces: { ny: null } }, PAN);
  }
  for (const x of [-0.07, 0, 0.07]) {
    box(m, { min: [x - 0.014, 0.42, z0 - 0.026], max: [x + 0.014, 0.76, z0 + 0.02], faces: { pz: null } }, PAN);
  }
  // Charge-state strip on the lid, and the frame straps holding the box.
  roundedBox(m, { min: [-0.05, 0.795, z1 - 0.075], max: [0.05, 0.815, z1 - 0.04], radius: 0.008, segments: 1 }, GLOW);
  for (const z of [z0 + 0.1, z1 - 0.12]) {
    box(m, { min: [-0.142, 0.5, z - 0.02], max: [0.142, 0.53, z + 0.02], faces: { ny: null } }, CAGE);
  }
  // Differential outputs: the half-shafts come out of these.
  for (const s of [-1, 1]) {
    cylinder(m, { from: [s * 0.12, HALF_SHAFT[1], AXLE_R], to: [s * (HALF_SHAFT[0] - 0.095), HALF_SHAFT[1], AXLE_R], radius: 0.085, sides: 10, bevel: { top: 0.015 }, bevelSegments: 1, caps: 'top' }, PAN);
  }
  // Firewall plate behind the seat.
  roundedBox(m, { min: [-0.3, FLOOR + 0.02, -0.74], max: [0.3, 0.6, -0.7], radius: 0.015, segments: 1 }, PAN);

  // Tow plate on the rear hoop, as on the sheet's rear view.
  cylinder(m, { from: [-0.205, 0.665, REAR_HOOP_Z], to: [0.205, 0.665, REAR_HOOP_Z], radius: TUBE * 0.8, sides: 8, caps: false }, CAGE);
  roundedBox(m, { min: [-0.16, 0.62, REAR_HOOP_Z - 0.05], max: [0.16, 0.71, REAR_HOOP_Z - 0.012], radius: 0.014, segments: 2 }, STEEL);
  for (const x of [-0.11, 0.11]) addBolt(m, { at: [x, 0.665, REAR_HOOP_Z - 0.05], normal: [0, 0, -1], radius: 0.02 }, GUNMETAL);
}
