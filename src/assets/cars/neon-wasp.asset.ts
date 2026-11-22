import { SolidMesh, paint } from '../../gfx/solid';
import type { Paint } from '../../gfx/solid';
import type { CarAsset, CarGeometry } from '../types';
import { CHARCOAL, addDashboard, addLightBar, addPedals, addSeat, addSteeringColumn, buildDriver, buildRunningGear, buildSteeringWheel } from './parts';
import type { RunningGear, TreadPattern } from './parts';
import { CAR_COMMON } from '../palette';
import { addBoosters, boosterSpinners } from './neon-wasp/booster';
import { addFloorAndMotor, addFrame } from './neon-wasp/frame';
import { COLUMN_FROM, DASH, DRIVER_SCALE, LIVERIES, N, PEDALS, RECLINE, SEAT, SPEC, SUSPENSION, TUBE, WHEEL, WHEEL_AXIS, WHEEL_RADIUS, paintsOf } from './neon-wasp/layout';
import type { Livery } from './neon-wasp/layout';
import { addNose } from './neon-wasp/nose';
import { addPodsAndFins } from './neon-wasp/panels';

/**
 * NEON WASP — the light, pointed tube-frame buggy of the design pack: a
 * narrow yellow sting of a nose, open air between the violet frame and the
 * wheels, two side pods, two separate tail fins and a pair of jet boosters
 * over the motor.
 *
 *   neon-wasp/layout.ts   spec, frame nodes, cockpit points, liveries
 *   neon-wasp/frame.ts    tube frame, floor, motor box
 *   neon-wasp/nose.ts     nose shell, louvres, head lamps
 *   neon-wasp/panels.ts   side pods, fins
 *   neon-wasp/booster.ts  boosters and their turbine spinners
 *
 * Review: /asset-lab.html?asset=neon-wasp&view=hero&yaw=215&pitch=18
 */

function buildBody(l: Livery, gear: RunningGear): SolidMesh {
  const P = paintsOf(l);
  const m = new SolidMesh();

  addFloorAndMotor(m, P);
  addFrame(m, P);
  gear.addMounts(m);
  addNose(m, P);
  addPodsAndFins(m, P);
  addBoosters(m, P);

  // Cockpit.
  // Black seat, yellow only as trim: the sheet outlines the back and its
  // bolsters in yellow piping and shows no colour on the shell's rear (which
  // the chase camera looks at between the boosters).
  const seatFrom = m.mark();
  const SEAT_TRIM = paint(l.body, { gloss: 0.35 });
  addSeat(m, { at: SEAT, recline: RECLINE, accent: SEAT_TRIM, width: 0.48 });
  const isTrim = (p: Paint): boolean => p.color.every((v, i) => Math.abs(v - SEAT_TRIM.color[i]) < 1e-6);
  const isShell = (p: Paint): boolean => p.color.every((v, i) => Math.abs(v - CHARCOAL.color[i]) < 1e-6);
  m.repaint((c, n, p) => {
    if (isTrim(p) && n.z < -0.3) return CHARCOAL;
    // Piping: the forward-facing rims of the back's wings and head rest.
    if (isShell(p) && n.z > 0.25 && c.y > SEAT[1] + 0.1) return SEAT_TRIM;
    return undefined;
  }, seatFrom);
  addDashboard(m, { at: DASH, width: 0.5, height: 0.19, accent: l.accent, gauges: 1 });
  addSteeringColumn(m, { from: COLUMN_FROM, to: WHEEL });
  addPedals(m, { at: PEDALS });

  // Roof lamp on the windscreen header: one LED strip in a dark housing.
  const roofY = N.roofFront[1] + TUBE;
  addLightBar(m, { at: [0, roofY + 0.058, N.roofFront[2] + 0.045], width: 0.34, height: 0.085, lamps: 1, housing: paint(l.dark, { gloss: 0.6 }), glow: P.GLOW, feet: 0.03 });
  return m;
}

/**
 * The sheet's balloon ATV tire: many small rectangular blocks, not a few
 * big bars. Each repeat holds a centre block and a shoulder block on each
 * side, the two sides staggered by half a pitch and the centre blocks
 * angled into a shallow V (the chevron of the front and rear views). The
 * shoulder blocks run over the shoulder and stop on the upper sidewall, so
 * the side view still reads as a tire, not a gear wheel.
 */
const TREAD: TreadPattern = {
  pitch: 0.118,
  bars: [
    { halfWidth: 0.27, path: [[0.0, -0.07], [0.1, -0.5]] },
    { halfWidth: 0.27, path: [[0.5, 0.07], [0.6, 0.5]] },
    { halfWidth: 0.28, path: [[0.56, -0.64], [0.6, -1.06]] },
    { halfWidth: 0.28, path: [[1.06, 0.64], [1.1, 1.1]] },
  ],
};

function build(livery = 0): CarGeometry {
  const l = LIVERIES[livery % LIVERIES.length];
  const P = paintsOf(l);
  const gear = buildRunningGear(SPEC, {
    ...SUSPENSION,
    wheels: {
      // Near-black rims: only the cyan band is bright, as on the sheet.
      both: { rim: 'spoke', spokes: 5, ring: P.ACCENT, ringWidth: 0.16, barrel: '#25262D', centre: '#363743', cap: CAR_COMMON.metal, tread: TREAD, lettering: false, segments: 34 },
    },
    caliper: l.accent,
    springColor: P.ACCENT,
    armColor: paint(l.cage, { gloss: 0.62 }),
  });
  return {
    body: buildBody(l, gear),
    driver: buildDriver({
      seat: SEAT,
      recline: RECLINE,
      scale: DRIVER_SCALE,
      wheel: { pivot: WHEEL, axis: WHEEL_AXIS, radius: WHEEL_RADIUS },
      feet: PEDALS,
      helmet: l.body,
      band: l.cage,
      stripe: l.accent,
      suit: l.cage,
      trim: l.body,
    }),
    wheelFront: gear.wheelFront,
    wheelRear: gear.wheelRear,
    hubFront: gear.hubFront,
    hubRear: gear.hubRear,
    links: gear.links,
    spinners: boosterSpinners(l),
    steeringWheel: { mesh: buildSteeringWheel({ radius: WHEEL_RADIUS, accent: l.accent }), pivot: WHEEL, axis: WHEEL_AXIS },
  };
}

const neonWasp: CarAsset = {
  kind: 'car',
  id: 'neon-wasp',
  name: 'Neon Wasp',
  category: 'car',
  spec: SPEC,
  liveries: LIVERIES.length,
  // Swatch: shell / tube frame (yellow on violet on the sheet).
  paints: LIVERIES.map((l) => ({ name: l.name, body: l.body, accent: l.cage })),
  build,
  triBudget: 60000,
  reference: {
    sheet: 'design-documents/buggy-design-pack/neon-wasp/turnaround.png',
    brief: 'design-documents/buggy-design-pack/neon-wasp/modeling-brief.txt',
  },
};

export default neonWasp;
