import { SolidMesh, paint } from '../../gfx/solid';
import { BUILDING, COMET_FOX, FOLIAGE } from '../palette';
import type { CarAsset, CarGeometry } from '../types';
import { addDashboard, addPedals, addSeat, addSteeringColumn, buildDriver, buildRunningGear, buildSteeringWheel, columnAxis, suspensionAnchors } from './parts';
import type { RunningGear, RunningGearOptions, TreadPattern } from './parts';
import { addFrame, addTub } from './comet-fox/frame';
import { AXLE_F, AXLE_R, COLUMN_FROM, PEDALS, RECLINE, SEAT, SPEC, WHEEL, WHEEL_RADIUS, paintsOf } from './comet-fox/layout';
import type { Livery, Paints } from './comet-fox/layout';
import { addFin, addFlankPanels, addNose, addSeatPiping, addShockEars } from './comet-fox/shell';
import { addTurbine, turbineSpinners } from './comet-fox/turbine';

/**
 * COMET FOX — the arrow-nosed vermilion buggy with the teal space frame, the
 * swept dorsal fin and the turbine on its back.
 *
 *   comet-fox/layout.ts    spec, hard points, liveries' paints
 *   comet-fox/shell.ts     nose, flank panels + fox emblem, fin
 *   comet-fox/frame.ts     tub, keel, tube frame, gearbox, turbine cradle
 *   comet-fox/turbine.ts   housing, lateral intakes, the three rotors
 *
 * Review:  /asset-lab.html?asset=comet-fox&view=hero&yaw=215&pitch=18
 */

const WHEEL_AXIS = columnAxis(COLUMN_FROM, WHEEL);

const LIVERIES: Livery[] = [
  // 0 — the design sheet.
  { name: 'Vermilion', body: COMET_FOX.bodyVermilion, graphic: COMET_FOX.stripeWhite, cage: COMET_FOX.cageTeal, glow: COMET_FOX.emissionBlue, spring: COMET_FOX.bodyVermilion, rotor: '#1F5BE8', suit: BUILDING.cobalt },
  // 1 — night comet: cobalt shell, cream graphics, ochre frame.
  { name: 'Cobalt', body: BUILDING.cobalt, graphic: BUILDING.cream, cage: BUILDING.mustard, glow: BUILDING.cyanLight, spring: BUILDING.mustard, rotor: '#2B6FE0', suit: BUILDING.coral },
  // 2 — arctic fox: cream shell, coral graphics, turquoise frame.
  { name: 'Arctic', body: BUILDING.cream, graphic: BUILDING.coral, cage: BUILDING.turquoise, glow: COMET_FOX.emissionBlue, spring: BUILDING.coral, rotor: '#1F5BE8', suit: BUILDING.cobalt },
  // 3 — jade: green shell, cream graphics, lavender frame, lime light.
  { name: 'Jade', body: FOLIAGE.jade, graphic: BUILDING.cream, cage: '#A694E6', glow: FOLIAGE.highlight, spring: '#A694E6', rotor: '#5FA81C', suit: '#7C68C8' },
];

// The rear coil-overs stand BEHIND the driven axle's half-shafts; the tower
// has to stand at the same z as the foot the library puts there.
const REAR_FOOT_Z = AXLE_R + suspensionAnchors(SPEC, { rear: { halfShaft: true } })[3].hubPoints.damperFoot[2];

/** Rear tread: the sheet's chevron bars — two arms meeting at the centre
 * line in one continuous V and running on over the shoulder. They stop just
 * past the tire's widest point (±1 = the equator), so a smooth balloon
 * sidewall shows below them and the silhouette stays round. */
const REAR_TREAD: TreadPattern = {
  pitch: 0.185,
  bars: [
    { halfWidth: 0.31, path: [[0.17, -0.025], [0.5, -0.58], [0.54, -0.84], [0.54, -1.02]] },
    { halfWidth: 0.31, path: [[0.17, 0.025], [0.5, 0.58], [0.54, 0.84], [0.54, 1.06]] },
  ],
};

/** Front tread: neat rows of square-ish blocks over the crown, short
 * shoulder blocks, smooth sidewall. */
const FRONT_TREAD: TreadPattern = {
  pitch: 0.165,
  bars: [
    { halfWidth: 0.34, path: [[0.25, -0.42], [0.25, -0.06]] },
    { halfWidth: 0.34, path: [[0.75, 0.06], [0.75, 0.42]] },
    { halfWidth: 0.34, path: [[0.75, -0.56], [0.75, -1.0]] },
    { halfWidth: 0.34, path: [[0.25, 0.56], [0.25, 1.06]] },
  ],
};

/** The sheet's tires are near-black charcoal; the shared rubber is warmer. */
const RUBBER_FOX = paint('#36343B', { gloss: 0.2, smooth: 35 });
/** Wishbones and tie rods: mid gunmetal, as on the concept. */
const ARMS = paint('#7A7E88', { gloss: 0.5, metal: 0.7 });

/** Front coil-over top eye: swept back to the nose's edge as on the sheet. */
const FRONT_TOP: [number, number, number] = [0.34, 0.8, 1.17];

function gearOptions(l: Livery): RunningGearOptions {
  return {
    front: { damperTop: FRONT_TOP, wheel: { tieRodZ: 0.125 }, armSpread: 0.32, lowerPivot: [0.183, 0.33, AXLE_F - 0.03], upperPivot: [0.213, 0.44, AXLE_F - 0.03] },
    rear: { damperTop: [0.27, 1.02, REAR_FOOT_Z], halfShaft: true },
    armColor: ARMS,
    springColor: paint(l.spring, { gloss: 0.75 }),
    springTurns: 5,
    springWire: 0.2,
    caliper: l.cage,
    wheels: {
      both: { ring: paint(l.cage, { gloss: 0.9, smooth: 50 }), barrel: '#2E2F37', centre: '#4A4B55', floor: '#1E1F25', cap: '#8A8D96', rim: 'spoke', spokes: 6, ringWidth: 0.08, rubber: RUBBER_FOX, lettering: false, lugHeight: 0.019, segments: 28 },
      front: { tread: FRONT_TREAD },
      rear: { tread: REAR_TREAD },
    },
  };
}

function buildBody(l: Livery, P: Paints, gear: RunningGear): SolidMesh {
  const m = new SolidMesh();
  addTub(m, P);
  addNose(m, P);
  addShockEars(m, FRONT_TOP);
  addFlankPanels(m, P);
  addFrame(m, P, gear);
  gear.addMounts(m);
  addTurbine(m, P);
  addFin(m, P);

  // Cockpit.
  addSeat(m, { at: SEAT, recline: RECLINE, accent: paint(l.spring, { gloss: 0.25 }) });
  addSeatPiping(m, P.GRAPHIC);
  addDashboard(m, { at: [0, 0.835, 0.445], width: 0.56, accent: l.glow });
  addSteeringColumn(m, { from: COLUMN_FROM, to: WHEEL });
  addPedals(m, { at: PEDALS });
  return m;
}

function build(livery = 0): CarGeometry {
  const l = LIVERIES[livery % LIVERIES.length];
  const P = paintsOf(l);
  const gear = buildRunningGear(SPEC, gearOptions(l));
  return {
    body: buildBody(l, P, gear),
    driver: buildDriver({
      seat: SEAT,
      recline: RECLINE,
      wheel: { pivot: WHEEL, axis: WHEEL_AXIS, radius: WHEEL_RADIUS },
      feet: PEDALS,
      helmet: l.graphic,
      band: l.body,
      stripe: l.cage,
      suit: l.suit,
      trim: l.graphic,
    }),
    wheelFront: gear.wheelFront,
    wheelRear: gear.wheelRear,
    hubFront: gear.hubFront,
    hubRear: gear.hubRear,
    links: gear.links,
    spinners: turbineSpinners(P),
    steeringWheel: { mesh: buildSteeringWheel({ radius: WHEEL_RADIUS, accent: l.cage }), pivot: WHEEL, axis: WHEEL_AXIS },
  };
}

const cometFox: CarAsset = {
  kind: 'car',
  id: 'comet-fox',
  name: 'Comet Fox',
  category: 'car',
  spec: SPEC,
  liveries: LIVERIES.length,
  build,
  triBudget: 60000,
  reference: {
    sheet: 'design-documents/buggy-design-pack/comet-fox/turnaround.png',
    brief: 'design-documents/buggy-design-pack/comet-fox/modeling-brief.txt',
  },
};

export default cometFox;
