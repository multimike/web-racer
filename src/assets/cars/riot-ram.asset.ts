import { hex, paint } from '../../gfx/solid';
import { BUILDING, FOLIAGE, RIOT_RAM } from '../palette';
import type { CarAsset, CarGeometry } from '../types';
import { buildDriver, buildFanRotor, buildRunningGear, buildSteeringWheel, fanSpinner } from './parts';
import type { TreadPattern } from './parts';
import { FAN, FAN_RADIUS, buildBody } from './riot-ram/body';
import { PEDALS, RECLINE, SEAT, SPEC, SUSPENSION, WHEEL, WHEEL_AXIS, WHEEL_RADIUS } from './riot-ram/layout';
import type { RamLivery } from './riot-ram/layout';

/**
 * RIOT RAM — the broadest and most square of the four buggies: equal
 * oversized tires, cobalt cage and hood, orange fenders and side panels,
 * lime coil springs, a three-cell roof light and a silver bash plate with
 * four cut-outs.
 *
 *   riot-ram/layout.ts   spec, hard points, cage nodes, livery type
 *   riot-ram/shapes.ts   bevelled-panel solids, rivets, lamp cells
 *   riot-ram/body.ts     the sprung body
 *
 * Review:  /asset-lab.html?asset=riot-ram&view=hero&yaw=215&pitch=18
 *          …&steer=30&bump=0.08   …&variants=4
 */

// Colours of the alternative liveries that the shared palette does not name.
const LAVENDER = hex('#9A8BE0');
const INK = hex('#2B3A8F');

/** The brief's cool charcoal rubber (#29292F), a touch lifted so the lugs
 * still read under the toy shader; the shared CAR_COMMON.rubber is a warm
 * mauve that renders chocolate brown on this car. */
const RAM_RUBBER = paint('#37373F', { gloss: 0.22, smooth: 35 });
const FAN_CAP = paint('#8E929C', { gloss: 0.7, metal: 0.8, emissive: 0.08 });

/**
 * The sheet's tire: directional V blocks across the crown and short shoulder
 * lugs that wrap only over the shoulder (they stop at the tire's widest
 * point), leaving a smooth balloon sidewall between the lugs and the
 * beadlock. Tread space: around in pitch fractions, across in crown→equator
 * arcs (±1 = the widest point).
 */
const RAM_TREAD: TreadPattern = {
  pitch: 0.16,
  bars: [
    { halfWidth: 0.3, path: [[0.0, -0.07], [0.2, -0.6]] },
    { halfWidth: 0.3, path: [[0.5, 0.07], [0.7, 0.6]] },
    { halfWidth: 0.32, path: [[0.42, -0.72], [0.46, -1.04]] },
    { halfWidth: 0.32, path: [[0.92, 0.72], [0.96, 1.06]] },
  ],
};

const LIVERIES: RamLivery[] = [
  {
    name: 'Riot (design sheet)',
    body: RIOT_RAM.bodyCobalt,
    panel: RIOT_RAM.panelsOrange,
    stripe: RIOT_RAM.stripeWhite,
    spring: RIOT_RAM.springsLime,
    sideStripes: [
      [0.16, 0.14],
      [-0.04, 0.14],
    ],
    hoodStripes: [
      [0.205, 0.1],
      [0.015, 0.1],
    ],
    helmet: RIOT_RAM.panelsOrange,
    helmetStripe: RIOT_RAM.bodyCobalt,
    suit: RIOT_RAM.bodyCobalt,
    trim: RIOT_RAM.stripeWhite,
  },
  {
    // Cream body, cobalt panels, coral accents: one broad stripe with a
    // pinstripe beside it.
    name: 'Regatta',
    body: BUILDING.cream,
    panel: BUILDING.cobalt,
    stripe: BUILDING.coral,
    spring: BUILDING.coral,
    sideStripes: [
      [0.2, 0.2],
      [-0.06, 0.06],
    ],
    hoodStripes: [
      [0.2, 0.16],
      [-0.02, 0.05],
    ],
    helmet: BUILDING.coral,
    helmetStripe: BUILDING.cobalt,
    suit: BUILDING.cobalt,
    trim: BUILDING.cream,
  },
  {
    // Jade body, ochre panels, cream triple pinstripes.
    name: 'Orchard',
    body: FOLIAGE.jade,
    panel: BUILDING.mustard,
    stripe: BUILDING.cream,
    spring: BUILDING.cream,
    sideStripes: [
      [0.2, 0.07],
      [0.07, 0.07],
      [-0.06, 0.07],
    ],
    hoodStripes: [
      [0.2, 0.07],
      [0.05, 0.07],
    ],
    helmet: BUILDING.mustard,
    helmetStripe: FOLIAGE.jade,
    suit: FOLIAGE.jade,
    trim: BUILDING.cream,
  },
  {
    // Lavender body, cream panels, ink-blue stripes, turquoise springs.
    name: 'Lilac',
    body: LAVENDER,
    panel: BUILDING.cream,
    stripe: INK,
    spring: BUILDING.turquoise,
    sideStripes: [
      [0.16, 0.14],
      [-0.04, 0.14],
    ],
    hoodStripes: [
      [0.205, 0.1],
      [0.015, 0.1],
    ],
    helmet: BUILDING.turquoise,
    helmetStripe: INK,
    suit: INK,
    trim: BUILDING.cream,
  },
];

function build(livery = 0): CarGeometry {
  const l = LIVERIES[livery % LIVERIES.length];
  const gear = buildRunningGear(SPEC, {
    ...SUSPENSION,
    wheels: { both: { ring: l.panel, tread: RAM_TREAD, lugs: 18, segments: 26, lettering: false, rim: 'beadlock', rubber: RAM_RUBBER } },
    caliper: l.spring,
    // A whisper of emissive keeps the lime springs lime in the shade under
    // the fenders (unlit they sink to olive).
    springColor: paint(l.spring, { gloss: 0.75, smooth: 60, emissive: 0.07 }),
    armColor: l.panel,
  });
  return {
    body: buildBody(l, gear),
    driver: buildDriver({
      seat: SEAT,
      recline: RECLINE,
      wheel: { pivot: WHEEL, axis: WHEEL_AXIS, radius: WHEEL_RADIUS },
      feet: PEDALS,
      helmet: l.helmet,
      stripe: l.helmetStripe,
      band: l.trim,
      suit: l.suit,
      trim: l.trim,
    }),
    wheelFront: gear.wheelFront,
    wheelRear: gear.wheelRear,
    hubFront: gear.hubFront,
    hubRear: gear.hubRear,
    links: gear.links,
    // The cooling fan behind the rear grille.
    // Nothing at the tail glows but the lamps: the hub cap is plain metal
    // with only a whisper of emissive (the rotor forces some on).
    spinners: [fanSpinner(buildFanRotor({ radius: FAN_RADIUS, blades: 7, glow: FAN_CAP }), FAN, [0, 0, -1], { idle: 6, full: 55 })],
    steeringWheel: { mesh: buildSteeringWheel({ radius: WHEEL_RADIUS, accent: l.panel }), pivot: WHEEL, axis: WHEEL_AXIS },
  };
}

const riotRam: CarAsset = {
  kind: 'car',
  id: 'riot-ram',
  name: 'Riot Ram',
  category: 'car',
  spec: SPEC,
  liveries: LIVERIES.length,
  build,
  triBudget: 60000,
  reference: {
    sheet: 'design-documents/buggy-design-pack/riot-ram/turnaround.png',
    brief: 'design-documents/buggy-design-pack/riot-ram/modeling-brief.txt',
  },
};

export default riotRam;
