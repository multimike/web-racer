import { SolidMesh, paint, roundedBox } from '../../gfx/solid';
import type { RGB } from '../../gfx/solid';
import { COMET_FOX, REEF_ROCKET, RIOT_RAM } from '../palette';
import type { CarAsset, CarGeometry, CarSpec } from '../types';
import {
  addAntenna,
  addBashPlate,
  addBoltRow,
  addCageTube,
  addDashboard,
  addExhaustTip,
  addFanDuct,
  addFloorPan,
  addLampPod,
  addLightBar,
  addNozzle,
  addNumberPlate,
  addPedals,
  addSeat,
  addSteeringColumn,
  addTailLamp,
  addTowHook,
  buildDriver,
  buildFanRotor,
  buildSteeringWheel,
  buildRunningGear,
  columnAxis,
  fanSpinner,
} from './parts';
import type { P3, RunningGear, SuspensionOptions } from './parts';

/**
 * BLOCKOUT — the reference implementation of the car contract (`types.ts`),
 * built from the shared parts library (`parts.ts`, whose header is the
 * step-by-step guide). The BODY is deliberately crude boxes; everything
 * bolted to it is the real thing, so read this file to see how a car is put
 * together and how the assembler (`assemble.ts`) will move it:
 *
 *   body           one mesh, model space: origin on the GROUND under the
 *                  wheelbase centre, +x right, +y up, +z nose
 *   driver         the figure in the seat — same space as the body, its own
 *                  mesh so it can be hidden (lab: driver=0)
 *   wheelFront/    ONE right-hand wheel per axle, around the wheel centre,
 *   wheelRear      axle on X, detailed face on +X; mirrored for the left
 *   hubFront/      non-spinning upright + brake for a RIGHT wheel, inboard
 *   hubRear        toward −x; mirrored for the left
 *   links          wishbones, tie rods, springs, damper halves for all four
 *                  corners — re-posed every frame between two anchors
 *   spinners       the tail fan's rotor
 *   steeringWheel  turns with the steering input
 *
 * Nothing here is mirrored by hand: the parts take RIGHT-side points and
 * mirror themselves. No `bakeAO` either: the assembler bakes every part (the
 * body together with the wheels at rest, so the arches darken).
 *
 * Review it:  /asset-lab.html?asset=blockout
 *             …&view=hero&steer=30&bump=0.08   links at lock + compression
 *             …&view=hero&bump=-0.1            full droop
 *             …&view=hero&focus=wheelFR        a wheel up close
 *             …&run=1                          everything moving
 */

// The spec is the single source of truth: the assembler places the hubs
// from it, the parts are sized from it, and the lab measures the built car
// against it.
const SPEC: CarSpec = {
  length: 3.6,
  width: 2.0, // = rearTrack + rearTireWidth, the widest axle over the tires
  height: 1.5,
  wheelbase: 2.4,
  frontTrack: 1.6,
  rearTrack: 1.56,
  frontTireRadius: 0.36,
  rearTireRadius: 0.46,
  frontTireWidth: 0.3,
  rearTireWidth: 0.44,
  groundClearance: 0.28,
};

const AXLE_F = SPEC.wheelbase / 2; // z of the front axle
const AXLE_R = -SPEC.wheelbase / 2;

// ---------------------------------------------------------------------------
// The hard points every part is hung from. Decide these first.

/** Hip point: centre of the seat cushion's top surface. */
const SEAT: P3 = [0, 0.47, -0.42];
/** Seat-back / torso lean, degrees — the seat and the driver share it. */
const RECLINE = 12;
/** Steering wheel pivot (0.45 m ahead of and 0.34 m above the hip point: the
 * driver's elbows come out bent), and where its column leaves the scuttle
 * under the dashboard — ON the scuttle's face, so the gaiter has something to
 * sit on. The axis runs up the column TOWARD THE DRIVER. */
const WHEEL: P3 = [0, 0.81, 0.03];
const COLUMN_FROM: P3 = [0, 0.645, 0.6];
const WHEEL_AXIS = columnAxis(COLUMN_FROM, WHEEL);
const WHEEL_RADIUS = 0.16;
/** Floor point between the pedals — also where the driver's feet go. */
const PEDALS: P3 = [0, 0.31, 0.24];
/** Tail fan: pivot of the rotor and the direction it blows. */
const FAN: P3 = [0, 1.1, -1.56];
const FAN_DIR: P3 = [0, 0, -1];
const FAN_RADIUS = 0.2;

/** The rear coil-overs stand this far BEHIND the axle line: a driven axle's
 * half-shaft runs where the coil-over's foot would be, so the library moves
 * the foot back by the spring's radius + 10 cm, and the tower goes with it. */
const REAR_COIL_Z = AXLE_R - 0.18;
/** Where the suspension meets this body. Only the coil-over tops are moved
 * off their defaults (onto the two shock towers). */
const SUSPENSION: SuspensionOptions = {
  front: { damperTop: [0.37, 0.82, AXLE_F] },
  rear: { damperTop: [0.3, 1.04, REAR_COIL_Z], halfShaft: true },
};

// ---------------------------------------------------------------------------
// Paints. A livery swaps colours only — never the shape.

interface Livery {
  body: RGB;
  cage: RGB;
  trim: RGB;
  glow: RGB;
}

const LIVERIES: Livery[] = [
  { body: REEF_ROCKET.bodyTurquoise, cage: REEF_ROCKET.cageCoral, trim: REEF_ROCKET.trimCream, glow: REEF_ROCKET.emissionCyan },
  { body: RIOT_RAM.bodyCobalt, cage: RIOT_RAM.panelsOrange, trim: RIOT_RAM.stripeWhite, glow: RIOT_RAM.springsLime },
  { body: COMET_FOX.bodyVermilion, cage: COMET_FOX.cageTeal, trim: COMET_FOX.stripeWhite, glow: COMET_FOX.emissionBlue },
];

// ---------------------------------------------------------------------------
// Body

function buildBody(l: Livery, gear: RunningGear): SolidMesh {
  const BODY = paint(l.body, { gloss: 0.85 });
  const CAGE = paint(l.cage, { gloss: 0.6 });
  const TRIM = paint(l.trim, { gloss: 0.5 });
  const m = new SolidMesh();
  const floor = SPEC.groundClearance;

  // Crude shell: floor pan, two sills, scuttle, nose and engine deck. The
  // underside of the floor pan is the car's lowest sprung face: exactly the
  // spec's ground clearance.
  addFloorPan(m, { min: [-0.44, -0.95], max: [0.44, 0.8], y: floor });
  for (const s of [-1, 1]) {
    roundedBox(m, { min: [s * 0.36, floor + 0.01, -0.98], max: [s * 0.5, 0.62, 0.84], radius: 0.06, segments: 3 }, BODY);
  }
  roundedBox(m, { min: [-0.46, floor + 0.01, 0.6], max: [0.46, 0.68, 0.84], radius: 0.07, segments: 3 }, BODY);
  roundedBox(m, { min: [-0.27, floor + 0.01, 0.74], max: [0.27, 0.6, 1.76], radius: 0.1, segments: 3 }, BODY);
  roundedBox(m, { min: [-0.46, floor + 0.01, -1.0], max: [0.46, 0.76, -0.8], radius: 0.07, segments: 3 }, BODY);
  roundedBox(m, { min: [-0.31, floor + 0.01, -1.7], max: [0.31, 0.88, -0.86], radius: 0.1, segments: 3 }, TRIM);

  // Cockpit, from the two hard points SEAT and WHEEL.
  addSeat(m, { at: SEAT, recline: RECLINE, accent: l.cage });
  addDashboard(m, { at: [0, 0.77, 0.6], accent: l.cage });
  addSteeringColumn(m, { from: COLUMN_FROM, to: WHEEL });
  addPedals(m, { at: PEDALS });

  // Cage. Each tube ENDS ON the centre line of the tube it joins and gets a
  // weld collar there; feet that disappear into the body get none. Join on a
  // STRAIGHT run of the other tube — its corners are filleted, so the corner
  // point itself is thin air.
  const r = 0.03;
  // Main hoop. The car's highest point is the weld collar on top of it:
  // 1.46 + 1.3 r = spec height.
  addCageTube(m, { path: [[-0.45, 0.5, -0.74], [-0.42, 1.46, -0.74], [0.42, 1.46, -0.74], [0.45, 0.5, -0.74]], radius: r, fillet: 0.14, sides: 14, collars: 'none' }, CAGE);
  for (const s of [-1, 1]) {
    // Roof rail + A-pillar in one bent tube, and a stay down to the deck.
    addCageTube(m, { path: [[s * 0.25, 1.46, -0.74], [s * 0.32, 1.43, -0.06], [s * 0.43, 0.62, 0.72]], radius: r, fillet: 0.18, sides: 14, collars: 'start' }, CAGE);
    addCageTube(m, { path: [[s * 0.14, 1.46, -0.74], [s * 0.24, 0.84, -1.6]], radius: r * 0.85, sides: 12, collars: 'start', joinRadius: r }, CAGE);
  }
  addCageTube(m, { path: [[-0.295, 1.445, -0.3], [0.295, 1.445, -0.3]], radius: r * 0.85, sides: 12, joinRadius: r }, CAGE);
  // Shock towers: the coil-over tops hang from their upper corners.
  addCageTube(m, { path: [[-0.22, 0.45, AXLE_F], [-0.42, 0.87, AXLE_F], [0.42, 0.87, AXLE_F], [0.22, 0.45, AXLE_F]], radius: 0.024, fillet: 0.07, collars: 'none' }, CAGE);
  addCageTube(m, { path: [[-0.26, 0.8, REAR_COIL_Z], [-0.35, 1.09, REAR_COIL_Z], [0.35, 1.09, REAR_COIL_Z], [0.26, 0.8, REAR_COIL_Z]], radius: 0.024, fillet: 0.07, collars: 'none' }, CAGE);
  gear.addMounts(m);

  // Lamps. The lens rims are the car's front extreme.
  for (const s of [-1, 1]) {
    // `at` is the lens rim; the bowl behind it must clear the nose's face.
    addLampPod(m, { at: [s * 0.14, 0.525, 1.8], radius: 0.075, housing: l.trim });
    addTailLamp(m, { at: [s * 0.2, 0.74, -1.7], size: [0.11, 0.05] });
  }

  // Fan duct on the deck — static; the rotor inside it is a CarSpinner.
  addFanDuct(m, { at: FAN, dir: FAN_DIR, radius: FAN_RADIUS, shell: l.trim, lip: l.cage });

  // Dressing.
  addBashPlate(m, { at: [0, 0.365, 1.765], width: 0.5, height: 0.14, holes: 3 }); // its top edge stays under the lamps
  addTowHook(m, { at: [0, 0.42, -1.7], dir: [0, 0, -1], size: 0.58 }); // its tip is the car's rear extreme
  addNozzle(m, { at: [-0.2, 0.52, -1.77], radius: 0.055, glow: l.glow });
  // A lamp bar let into the front shock tower's cross tube.
  addLightBar(m, { at: [0, 0.87, AXLE_F + 0.035], width: 0.4, height: 0.05, lamps: 3 });
  addExhaustTip(m, { from: [0.2, 0.52, -1.6], to: [0.22, 0.52, -1.775], radius: 0.04 });
  addAntenna(m, { at: [-0.24, 0.88, -1.2], height: 0.52 });
  for (const s of [-1, 1]) {
    addNumberPlate(m, { at: [s * 0.5, 0.46, -0.1], normal: [s, 0, 0], number: '7', size: 0.25, ring: l.cage });
    addBoltRow(m, { from: [s * 0.5, 0.46, 0.2], to: [s * 0.5, 0.46, 0.7], count: 4, normal: [s, 0, 0], style: 'button' });
  }
  return m;
}

// ---------------------------------------------------------------------------

function build(livery = 0): CarGeometry {
  const l = LIVERIES[livery % LIVERIES.length];
  // Wheels, hubs and links in one call, so their sizes cannot disagree.
  const gear = buildRunningGear(SPEC, {
    ...SUSPENSION,
    wheels: { both: { ring: l.cage }, front: { tread: 'knobby', rim: 'split' }, rear: { tread: 'block', rim: 'spoke' } },
    caliper: l.cage,
    springColor: l.glow,
  });
  return {
    body: buildBody(l, gear),
    driver: buildDriver({
      seat: SEAT,
      recline: RECLINE,
      wheel: { pivot: WHEEL, axis: WHEEL_AXIS, radius: WHEEL_RADIUS },
      feet: PEDALS,
      helmet: l.body,
      stripe: l.cage,
      suit: l.cage,
      trim: l.trim,
    }),
    wheelFront: gear.wheelFront,
    wheelRear: gear.wheelRear,
    hubFront: gear.hubFront,
    hubRear: gear.hubRear,
    links: gear.links,
    spinners: [fanSpinner(buildFanRotor({ radius: FAN_RADIUS, glow: l.glow }), FAN, FAN_DIR)],
    steeringWheel: { mesh: buildSteeringWheel({ radius: WHEEL_RADIUS, accent: l.cage }), pivot: WHEEL, axis: WHEEL_AXIS },
  };
}

const blockout: CarAsset = {
  kind: 'car',
  id: 'blockout',
  name: 'Blockout buggy (contract reference)',
  category: 'car',
  spec: SPEC,
  liveries: LIVERIES.length,
  build,
  triBudget: 60000,
  reference: { sheet: 'design-documents/buggy-design-pack/original-concepts.png', brief: 'src/assets/types.ts' },
};

export default blockout;
