import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, compose, cylinder, frame, loft, paint, paintStripe, paintWhere, placeRing, rotation, roundedBox, sphere, superellipseRing, torus, translation, tube } from '../../../gfx/solid';
import { FABRIC, STEEL, asPaint } from './common';
import type { Color, P3 } from './common';

/**
 * DRIVER — the chunky toy figure of the gameplay vision: a big full-face
 * helmet with a visor and racing stripes, race suit, gloves on the wheel,
 * legs into the footwell. Returned as its own mesh for `CarGeometry.driver`,
 * in the BODY's model space (it is authored right where it sits).
 *
 * THE HANDS AND THE TURNING WHEEL. The driver is rigid; the steering wheel
 * turns under the hands. The pose that survives that is the plain
 * quarter-to-three grip: each fist is a closed block around the rim's tube
 * at 9 and at 3 o'clock, and because the rim is a torus about the column
 * axis it simply slides through the closed fists as it turns — nothing
 * detaches, stretches or needs animating; only the spokes and the 12 o'clock
 * band sweep past the knuckles. (That is why `buildSteeringWheel` keeps its
 * rim a perfect torus, and why the hands must sit ON the rim circle: pass
 * the same pivot, axis and radius here as to the wheel.)
 *
 * Proportions are toy, not human: the helmet is as wide as the shoulders and
 * well over a third of the seated height. At scale 1 and helmetScale 1.3 the
 * helmet top is 0.92 m above the seat's hip point (it grows with both
 * scales); check it against the cage (the lab's height
 * row includes the driver).
 *
 * REACH. Arms are 0.62 m × scale from shoulder to wrist, legs 0.66 m × scale
 * from hip to ankle. The wheel pivot belongs 0.38–0.50 m ahead of and
 * 0.28–0.38 m above the hip point, the pedals 0.55–0.72 m ahead of it; a
 * layout the limbs cannot reach THROWS with the numbers instead of quietly
 * stretching them.
 */

export interface DriverOptions {
  /** Hip point: the seat's `at` (centre of the cushion top), model space. */
  seat: P3;
  /** Backward lean of the torso, degrees — the seat's recline (default 12). */
  recline?: number;
  /** Overall size (default 1). */
  scale?: number;
  /** Helmet size on top of `scale` (default 1.3 — the vision's big toy
   * head; 1 = a realistic helmet). */
  helmetScale?: number;
  /** The steering wheel the hands hold: its pivot, the column axis (pointing
   * toward the driver) and the rim radius — the same three values the
   * steering wheel was built and placed with. */
  wheel: { pivot: P3; axis: P3; radius?: number };
  /** Where the feet rest: floor point midway between the two feet (the
   * pedals' `at`). The soles stand on its height. Default: 0.62 m ahead of
   * and 0.16 m below the hip point. */
  feet?: P3;
  /** How far the elbows / knees stand out sideways, 0 (tucked in) … 1
   * (wide). Defaults 0.45 / 0.5. */
  elbows?: number;
  knees?: number;
  /** Helmet shell colour. */
  helmet?: Color;
  /** Centre band over the top of the helmet (default: the suit's `trim`). */
  band?: Color;
  /** The two stripes either side of the band. */
  stripe?: Color;
  /** Visor (default dark smoked; try the car's glow colour). */
  visor?: Color;
  /** Race suit — a saturated livery colour (a pale suit reads as bare skin). */
  suit?: Color;
  /** Shoulder yoke, belt, cuffs — the suit's second colour. */
  trim?: Color;
  gloves?: Color;
  boots?: Color;
  /** Shoulder straps painted over the suit: colour, or false for none
   * (default dark). */
  harness?: Color | false;
}

const V = (p: P3): Vector3 => new Vector3(p[0], p[1], p[2]);

/** Helmet centre up the spine from the hip, and out of the chest (so the
 * back of the big helmet rests on the seat instead of inside it). */
const HEAD_UP = 0.6;
const HEAD_FORWARD = (helmetScale: number): number => 0.178 * helmetScale - 0.124;

/** Two-bone joint position: the elbow / knee between `a` and `b` for limb
 * lengths `la` + `lb`, bent toward `pole`. Throws if `b` is out of reach. */
function bend(what: string, a: Vector3, b: Vector3, la: number, lb: number, pole: Vector3): Vector3 {
  const d = b.subtract(a);
  const dist = d.length();
  const dir = d.scale(1 / (dist || 1));
  if (dist > (la + lb) * 1.04) {
    throw new Error(`buildDriver: the ${what} cannot reach — ${dist.toFixed(2)} m to go with ${(la + lb).toFixed(2)} m of limb. Move the ${what === 'arm' ? 'steering wheel pivot closer to the hip point (0.38–0.50 m ahead, 0.28–0.38 m above)' : 'pedals closer to the seat (0.55–0.72 m ahead of the hip point)'} or raise \`scale\`.`);
  }
  // A limb never quite locks straight.
  const k = Math.max(1, dist / ((la + lb) * 0.985));
  const A = la * k;
  const B = lb * k;
  const x = (A * A - B * B + dist * dist) / (2 * dist || 1);
  const h = Math.sqrt(Math.max(A * A - x * x, 0));
  const side = pole.subtract(dir.scale(Vector3.Dot(pole, dir)));
  if (side.lengthSquared() < 1e-9) side.set(0, 1, 0);
  side.normalize();
  return a.add(dir.scale(x)).add(side.scale(h));
}

/**
 * The driver figure for `CarGeometry.driver`. About 4k triangles.
 *   driver: buildDriver({ seat: SEAT, wheel: { pivot: WHEEL_PIVOT, axis: WHEEL_AXIS, radius: 0.16 },
 *                         feet: PEDALS, helmet: REEF_ROCKET.bodyTurquoise, stripe: REEF_ROCKET.cageCoral,
 *                         suit: REEF_ROCKET.cageCoral, trim: REEF_ROCKET.trimCream })
 */
export function buildDriver(o: DriverOptions): SolidMesh {
  const k = o.scale ?? 1;
  const hs = o.helmetScale ?? 1.3;
  const recline = ((o.recline ?? 12) * Math.PI) / 180;
  const HELMET = asPaint(o.helmet, paint('#04B9BE', { gloss: 0.9 }), { gloss: 0.9 });
  const STRIPE = asPaint(o.stripe, paint('#FF6373', { gloss: 0.9 }), { gloss: 0.9 });
  const VISOR = asPaint(o.visor, paint('#23272F', { gloss: 1, metal: 0.4 }), { gloss: 1, metal: 0.4 });
  const SUIT = asPaint(o.suit, paint('#FF6373', { gloss: 0.25 }), { gloss: 0.25 });
  const TRIM = asPaint(o.trim, paint('#F4E4C8', { gloss: 0.3 }), { gloss: 0.3 });
  const BAND = asPaint(o.band, paint(TRIM, { gloss: 0.9 }), { gloss: 0.9 });
  const GLOVE = asPaint(o.gloves, paint('#2E2E36', { gloss: 0.35 }), { gloss: 0.35 });
  const BOOT = asPaint(o.boots, paint('#2E2E36', { gloss: 0.4 }), { gloss: 0.4 });
  const m = new SolidMesh();

  // Body frame: X = the car's right, U = up the spine, F = out of the chest.
  const X = new Vector3(1, 0, 0);
  const U = new Vector3(0, Math.cos(recline), -Math.sin(recline));
  const F = new Vector3(0, Math.sin(recline), Math.cos(recline));
  const hip = V(o.seat).add(new Vector3(0, 0.1 * k, -0.02 * k));
  const along = (u: number, f = 0, x = 0): Vector3 => hip.add(U.scale(u * k)).add(F.scale(f * k)).add(X.scale(x * k));

  // Torso: one loft up the spine, hips → waist → chest → shoulders → neck.
  // Narrow enough to sit BETWEEN the seat's shoulder wings.
  const torso = m.mark();
  const stations: [number, number, number, number][] = [
    [-0.085, 0.11, 0.09, 0.01],
    [-0.02, 0.165, 0.125, 0.01],
    [0.13, 0.145, 0.105, 0.0],
    [0.27, 0.168, 0.12, 0.005],
    [0.365, 0.16, 0.105, 0.0],
    [0.43, 0.08, 0.075, -0.005],
  ];
  loft(
    m,
    {
      rings: stations.map(([u, rx, ry, f]) => placeRing(superellipseRing(rx * k, ry * k, 2.6, 14), frame(along(u, f), X, F, U))),
      subdivisions: 2,
      caps: true,
    },
    SUIT,
  );
  // Two-colour suit: a yoke over the shoulders and a belt. Then the harness
  // straps painted over the chest (the seat's own straps are hidden behind
  // the driver).
  const height = (p: Vector3): number => Vector3.Dot(p.subtract(hip), U) / k;
  const across = (p: Vector3): number => Math.abs(p.x - hip.x) / k;
  paintWhere(m, { from: torso, inside: (p) => height(p) - 0.3 }, TRIM);
  paintWhere(m, { from: torso, inside: (p) => Math.min(height(p) - 0.075, 0.118 - height(p)) }, TRIM);
  if (o.harness !== false) {
    const STRAP = asPaint(o.harness, paint('#26262C', { gloss: 0.25 }), { gloss: 0.25 });
    paintWhere(
      m,
      {
        from: torso,
        only: (_c, n) => Vector3.Dot(n, F) > 0.1,
        inside: (p) => Math.min(0.026 - Math.abs(across(p) - 0.07), height(p) - 0.118, 0.41 - height(p)),
      },
      STRAP,
    );
    cylinder(m, { from: along(0.096, 0.08), to: along(0.096, 0.128), radius: 0.04 * k, sides: 12, bevel: { top: 0.006 }, bevelSegments: 1, caps: 'top' }, STEEL);
  }

  // Helmet, built around its own centre looking along +z, painted, then
  // tipped back a little with the spine.
  const K = k * hs;
  const head = along(HEAD_UP, HEAD_FORWARD(hs));
  cylinder(m, { from: along(0.4, 0), to: head.subtract(U.scale(0.1 * K)), radius: 0.075 * k, sides: 10, caps: false }, FABRIC);
  const h = new SolidMesh();
  sphere(h, { radii: [0.162 * K, 0.166 * K, 0.178 * K], segments: 24, rings: 12 }, HELMET);
  // Centre band with a stripe either side — three clean bands from the
  // visor's top edge over the crown and down the back.
  paintStripe(h, { axis: 'x', min: -0.075 * K, max: 0.075 * K }, STRIPE);
  paintStripe(h, { axis: 'x', min: -0.042 * K, max: 0.042 * K }, BAND);
  // Visor: a rounded window wrapped round the front, cut out of whatever
  // was painted before (the stripes stop at its edge).
  const vy = 0.018 * K;
  paintWhere(
    h,
    {
      // Signed distance to a rounded rectangle in (arc round the helmet,
      // height): a true distance keeps the cut smooth across the coarse
      // sphere, where a steeper function staircases.
      inside: (p) => {
        const rc = 0.036 * K;
        const qx = Math.abs(Math.atan2(p.x, p.z)) * 0.17 * K - (0.19 * K - rc);
        const qy = Math.abs(p.y - vy) - (0.056 * K - rc);
        return rc - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0);
      },
    },
    VISOR,
  );
  // Rolled rubber edge round the helmet's opening, chin vent and the visor's
  // two pivots.
  torus(h, { radius: 0.118 * K, tube: 0.022 * K, segments: 16, sides: 5, at: [0, -0.118 * K, 0.008 * K] }, paint(FABRIC, { gloss: 0.3 }));
  roundedBox(h, { size: [0.1 * K, 0.026 * K, 0.03 * K], radius: 0.01 * K, segments: 1, at: [0, -0.085 * K, 0.14 * K] }, paint(FABRIC, { gloss: 0.3 }));
  for (const side of [-1, 1]) {
    cylinder(h, { from: [side * 0.125 * K, vy, 0.045 * K], to: [side * 0.172 * K, vy, 0.045 * K], radius: 0.026 * K, sides: 10, bevel: { top: 0.006 * K }, bevelSegments: 1, caps: 'top' }, STRIPE);
  }
  m.append(h, compose(rotation('x', (-recline * 0.35 * 180) / Math.PI), translation(head)));

  // Arms: shoulder → elbow → wrist, the fists closed round the rim at 9 and 3.
  const axis = V(o.wheel.axis).normalize();
  const upOnWheel = new Vector3(0, 1, 0).subtract(axis.scale(axis.y));
  if (upOnWheel.lengthSquared() < 1e-8) upOnWheel.set(0, 0, 1);
  upOnWheel.normalize();
  let right = Vector3.Cross(upOnWheel, axis);
  if (right.x < 0) right = right.scale(-1);
  const R = o.wheel.radius ?? 0.16;
  const pivot = V(o.wheel.pivot);
  const elbows = o.elbows ?? 0.45;
  for (const side of [-1, 1]) {
    const shoulder = along(0.352, 0.0, side * 0.158);
    const grip = pivot.add(right.scale(side * R));
    // The wrist sits just behind the fist, on the driver's side of the rim.
    const wrist = grip.add(axis.scale(0.05 * k)).add(right.scale(side * 0.012 * k));
    const elbow = bend('arm', shoulder, wrist, 0.32 * k, 0.3 * k, new Vector3(side * (0.25 + elbows), -1, -0.15));
    // One round-ended bar per bone: its ball end IS the shoulder / elbow, so
    // there is no seam between a joint sphere and the limb.
    tube(m, { path: [shoulder, elbow], radius: [0.074 * k, 0.062 * k], sides: 10, caps: 'round' }, SUIT);
    tube(m, { path: [elbow, wrist], radius: [0.061 * k, 0.05 * k], sides: 10, caps: 'round' }, SUIT);
    const fore = wrist.subtract(elbow).normalize();
    cylinder(m, { from: wrist.subtract(fore.scale(0.075 * k)), to: wrist.subtract(fore.scale(0.02 * k)), radius: 0.064 * k, sides: 10, bevel: 0.01 * k, bevelSegments: 1 }, TRIM);
    // Fist: a rounded block in the wheel's own frame, centred on the rim,
    // with a knuckle ridge across the front and the thumb locked over the
    // rim on the inside.
    const hand = frame(grip.add(axis.scale(0.004 * k)), right, upOnWheel, axis);
    roundedBox(m, { size: [0.094 * k, 0.112 * k, 0.106 * k], radius: 0.034 * k, segments: 2, at: hand }, GLOVE);
    roundedBox(m, { size: [0.1 * k, 0.03 * k, 0.05 * k], radius: 0.013 * k, segments: 1, at: compose(translation(0, 0.012 * k, -0.04 * k), hand) }, GLOVE);
    roundedBox(m, { size: [0.04 * k, 0.05 * k, 0.085 * k], radius: 0.016 * k, segments: 1, at: compose(rotation('y', -side * 24), translation(-side * 0.036 * k, 0.05 * k, -0.012 * k), hand) }, GLOVE);
  }

  // Legs: knees up and apart, soles on the floor at the pedals.
  const feet = o.feet ? V(o.feet) : V(o.seat).add(new Vector3(0, -0.16 * k, 0.62 * k));
  const knees = o.knees ?? 0.5;
  for (const side of [-1, 1]) {
    const joint = along(-0.02, 0.06, side * 0.09);
    const ankle = feet.add(new Vector3(side * 0.105 * k, 0.116 * k, -0.05 * k));
    const knee = bend('leg', joint, ankle, 0.34 * k, 0.32 * k, new Vector3(side * (0.15 + knees * 0.8), 1, 0));
    tube(m, { path: [joint, knee], radius: [0.094 * k, 0.08 * k], sides: 10, caps: 'round' }, SUIT);
    tube(m, { path: [knee, ankle], radius: [0.079 * k, 0.06 * k], sides: 10, caps: 'round' }, SUIT);
    const shin = ankle.subtract(knee).normalize();
    cylinder(m, { from: ankle.subtract(shin.scale(0.07 * k)), to: ankle.subtract(shin.scale(0.02 * k)), radius: 0.07 * k, sides: 10, bevel: 0.01 * k, bevelSegments: 1 }, TRIM);
    // Boot: heel under the ankle, toe up on the pedal. Its lowest corner is
    // 0.114 × scale below the ankle — standing on the floor, not in it.
    roundedBox(m, { size: [0.112 * k, 0.11 * k, 0.24 * k], radius: 0.042 * k, segments: 2, rot: [-15, 0, 0], at: [ankle.x, ankle.y - 0.038 * k, ankle.z + 0.062 * k] }, BOOT);
  }
  return m;
}
