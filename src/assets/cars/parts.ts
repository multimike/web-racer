/**
 * CAR PARTS LIBRARY — wheels, hubs, suspension, cockpit, driver and hardware
 * shared by every car. Import everything from here:
 *
 *   import { buildRunningGear, addSeat, buildDriver, addLampPod, … } from './parts';
 *
 * HOW TO BUILD A CAR WITH THESE PARTS  (worked example: blockout.asset.ts)
 *
 *  0. Conventions. `build…` returns a new SolidMesh for one slot of
 *     `CarGeometry`; `add…(m, options)` appends to a mesh you own — normally
 *     the BODY, in model space (origin on the ground under the wheelbase
 *     centre, +x right, +y up, +z nose). Every point is a plain [x, y, z]
 *     tuple. Colours are options: a hex string, a palette RGB, or a Paint if
 *     you want your own gloss. Left/right symmetry is automatic everywhere:
 *     give RIGHT-side points (x > 0).
 *  1. Copy the spec from model-spec.json into a `CarSpec`. Wheels, hubs and
 *     suspension are sized from it — never from the picture.
 *  2. Running gear — wheels, hubs and suspension in ONE call, so their sizes
 *     cannot disagree:
 *       const gear = buildRunningGear(SPEC, {
 *         wheels: { both: { ring: accent }, front: { tread: 'knobby', rim: 'split' }, rear: { tread: 'block' } },
 *         caliper: accent, springColor: glow,
 *         front: { damperTop: [x, y, z] }, rear: { damperTop: [x, y, z], halfShaft: true },
 *       });
 *     then `wheelFront: gear.wheelFront, wheelRear, hubFront, hubRear, links:
 *     gear.links` in the returned geometry and `gear.addMounts(body)` for the
 *     body-side brackets (the wishbones' pivot bushings are part of them).
 *     Treads: 'block' | 'chevron' | 'bar' | 'knobby', or your own
 *     `TreadPattern` (copy one from `TREAD_PATTERNS`). Rims: 'spoke' | 'split'
 *     | 'beadlock' | 'turbine'; `ring` = the coloured lip, `barrel` = the bowl
 *     behind it (default: the ring colour).
 *  3. Where the suspension meets YOUR shell. Every body-side point has a
 *     default derived from the spec; `gear.anchors` (= `suspensionAnchors`)
 *     lists them all, so either run your frame tubes and shock towers to
 *     them, or pass your own `lowerPivot` / `upperPivot` / `damperTop` /
 *     `tieRod` per axle. What the library solves for you:
 *       - dampers and tie rods telescope over the whole travel;
 *       - the coil-over stands on the upright and goes THROUGH the upper
 *         wishbone, whose two legs are bent round it just far enough;
 *       - nothing touches the spring, the tire or a half-shaft at any bump /
 *         droop / steer — anchors that cannot work THROW, naming the point
 *         to move. `gear.report` has the solved clearances.
 *     A driven axle (`halfShaft: true`) moves the coil-over's foot out of
 *     the shaft's way: rear → 10 cm + the spring's radius BEHIND the axle
 *     line (give `damperTop` that z too: `gear.anchors[3].hubPoints
 *     .damperFoot[2]`), front → on top of the upright. Heavier or lighter
 *     look: `armRadius`, `arms: 'flat'`, `coilRadius` per axle, `springWire`.
 *     Check `steer=30`, `bump=0.08`, `bump=-0.1` in the lab: the library
 *     keeps its own parts apart, the lab shows what pokes through your shell.
 *  4. Cockpit: choose the hip point SEAT and the steering WHEEL pivot
 *     (0.38–0.50 m ahead of the hip point and 0.28–0.38 m above it), then
 *     `addSeat(body, { at: SEAT })`, `addDashboard`, `addSteeringColumn(body,
 *     { from, to: WHEEL })` with `from` ON a panel (the gaiter sits there),
 *     `addPedals`, `addFloorPan` (its underside IS the ground clearance), and
 *     `steeringWheel: { mesh: buildSteeringWheel(), pivot: WHEEL, axis:
 *     columnAxis(from, WHEEL) }`.
 *  5. Driver: `driver: buildDriver({ seat: SEAT, recline, wheel: { pivot:
 *     WHEEL, axis, radius }, feet: PEDALS, helmet, stripe, suit, trim })`.
 *     Give seat and driver the same `recline`. The helmet top is
 *     0.92 m above the hip point at scale 1 and helmetScale
 *     1.3 — keep it under the cage. The fists hold the rim at 9 and 3
 *     and the rim slides through them as it turns, so give driver and wheel
 *     the same pivot / axis / radius. Limbs that cannot reach THROW.
 *  6. Dress the body: `addCageTube` (filleted bends + weld collars; end each
 *     tube ON the centre line of the tube it joins), `addLampPod` /
 *     `addTailLamp` / `addLightBar` (warm glow, never white), `addBashPlate`,
 *     `addTowHook`, `addExhaustTip`, `addNozzle` (jet / thruster),
 *     `addAntenna`, `addNumberPlate`, `addBolt(Row)`.
 *  7. Fans / turbines: `addFanDuct(body, { at, radius, dir })` for the static
 *     duct and `spinners: [fanSpinner(buildFanRotor({ radius }), at, dir)]`
 *     for the rotor (the rotor is built for a fan blowing straight back).
 *  8. Join by SINKING parts into each other; nothing may float and no two
 *     faces may be coplanar. Stock paints: RUBBER, STEEL, CHROME, GUNMETAL,
 *     CHARCOAL, FABRIC, LAMP_WARM, LAMP_RED (common.ts).
 *
 * WHAT THE PARTS COST (triangles; a car's budget is 60k):
 *   wheel 3.5–4.5k each (tire 1.9–3.4k by tread and size + rim 1.4–2.1k) —
 *   `lugs`, `lettering: false` and `segments` trade detail for triangles ·
 *   hub 0.7k each · suspension links 2.3–2.5k per corner (spring 1.2k) ·
 *   mounts 2.1k · driver 3.9k · seat 2.1k · dashboard 1.2k · steering wheel
 *   0.7k · pedals 0.2k · lamp pod 0.7k · fan duct + rotor 1.3k · nozzle 0.7k.
 *   Shared parts on a typical car: about 37k, which leaves 23k for the shell.
 *
 * Building wheels, hubs and suspension one by one (`buildWheel`, `buildHub`,
 * `buildSuspension`, `addSuspensionMounts`) still works — then YOU pass the
 * same radius / width / rimRatio to all of them, and `damperFoot` /
 * `coilRadius` from `suspensionAnchors(…)[1 | 3].hubPoints` to `buildHub`.
 */

export * from './parts/common';
export * from './parts/wheel';
export * from './parts/hub';
export * from './parts/suspension';
export * from './parts/gear';
export * from './parts/cockpit';
export * from './parts/driver';
export * from './parts/hardware';
