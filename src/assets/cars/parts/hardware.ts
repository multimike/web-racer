import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, circleRing, compose, cylinder, extrudePolygon, filletPath, paint, polygonRing, revolve, rotation, roundedBox, roundedRectRing, sphere, superellipseRing, toV3, torus, translation, tube } from '../../../gfx/solid';
import type { Paint, Vec2, Vec3 } from '../../../gfx/solid';
import type { CarSpinner } from '../../types';
import { CHARCOAL, CHROME, GUNMETAL, LAMP_CORE, LAMP_RED, LAMP_WARM, STEEL, aimZ, asPaint, facingAt } from './common';
import type { Color, P3 } from './common';

/**
 * HARDWARE — the small parts every car is dressed with: cage tubes with
 * welded joints, bolts, tow hook, bash plate, lamp pods, tail lamps, light
 * bar, exhaust tip, jet nozzle, fan duct + rotor, antenna, number plate. All
 * `add…` helpers append to
 * a mesh in its own space (normally the car BODY, model space: +x right,
 * +y up, +z nose); `buildFanRotor` returns the spinning part.
 *
 * Directions: a part that points somewhere takes `dir` (where its business
 * end faces — a headlight's `dir` is [0, 0, 1], a tail lamp's [0, 0, −1]) and
 * is rolled so its own "up" stays as close to +y as possible.
 */

// ---------------------------------------------------------------------------
// Cage tubes

export interface CageTubeOptions {
  /** Centre-line points. Corners are rounded with `fillet`. */
  path: readonly Vec3[];
  /** Tube radius (half the spec's cage_tube_diameter). */
  radius: number;
  /** Bend radius at the path's corners, at the centre line (default 3 ×
   * radius; 0 = mitred). */
  fillet?: number;
  /** Segments around (default 12; 14–16 for a glossy hero cage). */
  sides?: number;
  /**
   * Which ends get a weld collar — a short fat ring where this tube meets
   * the tube (or panel) it runs into (default 'both'). An end WITHOUT a
   * collar should be sunk into something. Either way the path should end ON
   * the other tube's centre line: the collar is drawn one radius back from
   * the end, right where this tube breaks the other's surface.
   */
  collars?: 'both' | 'start' | 'end' | 'none';
  /** Radius of the tube being joined at each end, if different (moves the
   * collar to that tube's surface). Default: same as `radius`. */
  joinRadius?: number;
}

/**
 * A roll-cage tube: filleted bends, and at its ends a weld collar that hides
 * the intersection line with the tube it joins — so a cage built from
 * separate tubes reads as one welded frame, with no razor seams.
 *   addCageTube(m, { path: [[-0.5, 0.6, -0.4], [-0.45, 1.5, -0.4], [0.45, 1.5, -0.4], [0.5, 0.6, -0.4]], radius: 0.03, collars: 'none' }, CAGE);   // main hoop, feet sunk in the body
 *   addCageTube(m, { path: [[0.4, 1.5, -0.4], [0.35, 0.9, -1.3]], radius: 0.03 }, CAGE);                                                          // stay, welded at both ends
 */
export function addCageTube(m: SolidMesh, o: CageTubeOptions, p: Paint): void {
  const r = o.radius;
  const sides = o.sides ?? 12;
  const fillet = o.fillet ?? r * 3;
  tube(m, { path: o.path, radius: r, sides, fillet }, p);
  const collars = o.collars ?? 'both';
  const pts = o.path.map((q) => toV3(q));
  const n = pts.length;
  const end = (at: Vector3, next: Vector3): void => {
    const dir = next.subtract(at);
    const len = dir.length();
    if (len < 1e-6) return;
    dir.scaleInPlace(1 / len);
    // The collar's centre sits where this tube emerges from its partner.
    const back = Math.min((o.joinRadius ?? r) * 1.02, len * 0.4);
    addWeldCollar(m, { at: at.add(dir.scale(back)), axis: dir, radius: r, sides }, p);
  };
  if (collars === 'both' || collars === 'start') end(pts[0], pts[1]);
  if (collars === 'both' || collars === 'end') end(pts[n - 1], pts[n - 2]);
}

/** A weld collar on its own: a soft fat ring around a tube of `radius` at
 * `at`, its axis along `axis`. Also good as a clamp or a tube-end bead. */
export function addWeldCollar(m: SolidMesh, o: { at: Vec3; axis: Vec3; radius: number; sides?: number }, p: Paint): void {
  const r = o.radius;
  // Lathed along local +Z: a low rounded bead, widest at the middle.
  revolve(
    m,
    {
      profile: [
        [r * 0.98, -r * 0.75],
        [r * 1.22, -r * 0.42],
        [r * 1.3, 0],
        [r * 1.22, r * 0.42],
        [r * 0.98, r * 0.75],
      ],
      segments: o.sides ?? 12,
      at: compose(rotation('x', 90), aimZ(o.at, o.axis)),
    },
    p,
  );
}

// ---------------------------------------------------------------------------
// Bolts

export interface BoltOptions {
  /** Centre of the head's base, on the surface. */
  at: Vec3;
  /** Direction the head points (the surface normal). */
  normal: Vec3;
  /** Head radius (default 0.012). */
  radius?: number;
  /** 'hex' (default) bolt head, 'button' domed cap screw, 'rivet' low dome. */
  style?: 'hex' | 'button' | 'rivet';
}

/** One bolt / rivet head standing on a surface (sunk 3 mm into it). */
export function addBolt(m: SolidMesh, o: BoltOptions, p: Paint = STEEL): void {
  const r = o.radius ?? 0.012;
  const style = o.style ?? 'hex';
  const place = compose(rotation('x', 90), aimZ(o.at, o.normal));
  if (style === 'hex') {
    const h = r * 0.9 + 0.003;
    cylinder(m, { radius: r, height: h, sides: 6, round: false, bevel: { top: r * 0.2 }, bevelSegments: 1, caps: 'top', at: compose(translation(0, h / 2 - 0.003, 0), place) }, p);
  } else {
    const h = style === 'button' ? r * 0.7 : r * 0.4;
    sphere(m, { radii: [r, h, r], segments: 10, latitude: [0, 90], caps: false, at: compose(translation(0, -0.0005, 0), place) }, p);
  }
}

/** `count` bolts evenly spaced from `from` to `to` (both included). */
export function addBoltRow(m: SolidMesh, o: Omit<BoltOptions, 'at'> & { from: Vec3; to: Vec3; count: number }, p: Paint = STEEL): void {
  const a = toV3(o.from);
  const b = toV3(o.to);
  for (let k = 0; k < o.count; k++) addBolt(m, { ...o, at: Vector3.Lerp(a, b, o.count === 1 ? 0.5 : k / (o.count - 1)) }, p);
}

// ---------------------------------------------------------------------------
// Tow hook, bash plate

/** A tow hook: a base plate bolted to the chassis and a fat open hook,
 * pointing along `dir` (default forward); it reaches 0.17 m × size out from
 * `at`. About 400 triangles. */
export function addTowHook(m: SolidMesh, o: { at: Vec3; dir?: Vec3; size?: number; color?: Color }): void {
  const k = (o.size ?? 1) * 0.14;
  const P = asPaint(o.color, paint('#E23A30', { gloss: 0.7 }), { gloss: 0.7 });
  const s = new SolidMesh();
  roundedBox(s, { size: [k * 1.1, k * 0.9, k * 0.3], radius: k * 0.08, segments: 1, at: [0, 0, k * 0.1] }, P);
  // The hook lies in the local YZ plane: out along +Z, round, and back.
  const path = filletPath(
    [
      [0, k * 0.2, k * 0.2],
      [0, k * 0.2, k * 1.05],
      [0, -k * 0.5, k * 1.05],
      [0, -k * 0.5, k * 0.5],
    ],
    k * 0.3,
    { segments: 4 },
  );
  tube(s, { path, radius: k * 0.17, sides: 10, caps: 'round' }, P);
  for (const x of [-1, 1]) addBolt(s, { at: [x * k * 0.36, -k * 0.2, k * 0.25], normal: [0, 0, 1], radius: k * 0.1 });
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, 1]));
}

export interface BashPlateOptions {
  /** Centre of the plate's outer face. */
  at: Vec3;
  /** Which way that face looks (default forward and a little down:
   * [0, −0.35, 1]). */
  normal?: Vec3;
  /** Overall size of the plate, meters. */
  width: number;
  height: number;
  /** Plate thickness (default 0.03). */
  thickness?: number;
  /** Number of cut-outs across (Reef Rocket 3, Riot Ram 4; 0 = solid). */
  holes?: number;
  /** 'round' holes, 'slot' rounded slots, 'hex' angular windows. */
  holeShape?: 'round' | 'slot' | 'hex';
  /** Chamfer the two lower corners by this much (default 30 % of height). */
  cornerCut?: number;
  color?: Color;
  /** Bolt heads in the upper corners (default true). */
  bolts?: boolean;
}

/**
 * Bash / skid plate: a thick bevelled plate with a row of real cut-outs and
 * chamfered lower corners. The holes are real: you see whatever is behind
 * the plate, so stand it a few centimetres off the chassis or put something
 * dark there.
 */
export function addBashPlate(m: SolidMesh, o: BashPlateOptions): void {
  const P = asPaint(o.color, paint(STEEL, { gloss: 0.6 }), { gloss: 0.6, metal: 1 });
  const w = o.width / 2;
  const h = o.height / 2;
  const t = o.thickness ?? 0.03;
  const cut = Math.min(o.cornerCut ?? o.height * 0.3, o.height * 0.8, w * 0.5);
  const outline: Vec2[] = [[-w, h], [w, h], [w, -h + cut], [w - cut, -h], [-w + cut, -h], [-w, -h + cut]];
  const n = Math.max(0, Math.round(o.holes ?? 3));
  const holes: Vec2[][] = [];
  const pitch = (o.width - cut) / Math.max(n, 1);
  const hr = Math.min(pitch * 0.33, o.height * 0.26);
  for (let k = 0; k < n; k++) {
    const x = (k - (n - 1) / 2) * pitch;
    const y = -h * 0.12;
    const shape = o.holeShape ?? 'round';
    const ring: Vec2[] =
      shape === 'round' ? circleRing(hr, 12) : shape === 'slot' ? roundedRectRing(pitch * 0.62, hr * 1.5, hr * 0.7, 3) : polygonRing(6, hr * 1.25, 0).map(([a, b]) => [a * 1.25, b * 0.85] as Vec2);
    holes.push(ring.map(([a, b]) => [a + x, b + y] as Vec2));
  }
  const s = new SolidMesh();
  extrudePolygon(s, { outline, holes, depth: t, bevel: Math.min(0.008, t * 0.3), bevelSegments: 1, bevelBack: true }, P);
  s.translate([0, 0, -t]);
  if (o.bolts ?? true) for (const x of [-1, 1]) addBolt(s, { at: [x * (w - 0.035), h - 0.03, 0], normal: [0, 0, 1], radius: 0.013 }, CHROME);
  m.append(s, facingAt(o.at, o.normal ?? [0, -0.35, 1]));
}

// ---------------------------------------------------------------------------
// Lamps

export interface LampPodOptions {
  /** Centre of the lens rim. The reflector bowl reaches 0.45 × radius BACK
   * from here: on a flat panel put `at` that far proud of it (the bullet
   * housing then meets the panel), or the bowl is buried in the panel. */
  at: Vec3;
  /** Where the lamp shines (default forward). */
  dir?: Vec3;
  /** Lens radius — or `radii: [across, up]` for an oval lamp. */
  radius?: number;
  radii?: [number, number];
  /** Length of the pod's bullet-shaped housing behind the lens (default
   * 1.4 × radius; 0 = no housing, for a lamp let into a panel). */
  depth?: number;
  /** Housing colour (default charcoal; Reef Rocket's are cream). */
  housing?: Color;
  /** Bezel ring (default chrome). */
  bezel?: Color;
  /** Number of bulbs side by side (default 1; Reef Rocket's ovals show 2). */
  bulbs?: number;
  /** Glow paint (default warm `LAMP_WARM`). */
  glow?: Paint;
}

/**
 * Head-lamp pod: bullet housing, bezel ring, a chrome reflector bowl you can
 * look into, and a glowing lens dome over each bulb with a hot core. Round
 * or oval. The glow is warm and never full-white (the look shader would clip
 * a broad emissive face to a flat disc); the bowl around it is what makes it
 * read as a lamp rather than a sticker. About 600 triangles (800 as a two-bulb oval).
 */
export function addLampPod(m: SolidMesh, o: LampPodOptions): void {
  const rx = o.radii ? o.radii[0] : (o.radius ?? 0.09);
  const ry = o.radii ? o.radii[1] : (o.radius ?? 0.09);
  const r = Math.min(rx, ry);
  const HOUSING = asPaint(o.housing, CHARCOAL, { gloss: 0.8 });
  const BEZEL = asPaint(o.bezel, CHROME, { gloss: 0.9, metal: 1 });
  const GLOW = o.glow ?? LAMP_WARM;
  const depth = o.depth ?? r * 1.4;
  const s = new SolidMesh();
  // Everything is lathed round and then stretched to the oval; local +Z is
  // the beam, the lens rim is the plane z = 0.
  const lathe = (profile: Vec2[], p: Paint | ((band: number) => Paint)): void => {
    revolve(s, { profile, segments: 26, rot: [90, 0, 0] }, typeof p === 'function' ? (band) => p(band) : p);
  };
  // Bezel ring + reflector bowl in one profile (y = along the beam): outer
  // wall, rounded lip, then down into the bowl.
  lathe(
    [
      [1.08, -0.3],
      [1.1, -0.02],
      [1.04, 0.07],
      [0.93, 0.07],
      [0.88, 0.0],
      [0.55, -0.34],
      [0, -0.42],
    ],
    (band) => (band >= 4 ? CHROME : BEZEL),
  );
  if (depth > 0) {
    // Housing: a bullet from just behind the bezel back to a small flat tail.
    const d = depth / r;
    lathe(
      [
        [0, -d],
        [0.22, -d],
        [0.62, -d * 0.82],
        [0.95, -d * 0.45],
        [1.06, -0.12],
      ],
      HOUSING,
    );
  }
  s.scale([rx, ry, r]);
  // Lens domes with a hot core, standing in the bowl.
  const n = Math.max(1, Math.round(o.bulbs ?? 1));
  const br = Math.min(ry * 0.56, (rx * 0.8) / n);
  for (let k = 0; k < n; k++) {
    const x = (k - (n - 1) / 2) * br * 2.15;
    sphere(s, { radii: [br, br * 0.55, br], segments: 16, rings: 12, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [x, 0, -r * 0.36] }, GLOW);
    sphere(s, { radii: [br * 0.42, br * 0.3, br * 0.42], segments: 8, rings: 6, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [x, 0, -r * 0.36 + br * 0.42] }, LAMP_CORE);
  }
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, 1]));
}

export interface TailLampOptions {
  /** Centre of the lens face. */
  at: Vec3;
  /** Where it shines (default backward). */
  dir?: Vec3;
  /** Round lamp radius — or `size: [width, height]` for a rounded bar. */
  radius?: number;
  size?: [number, number];
  /** Surround (default charcoal). */
  bezel?: Color;
  /** Glow paint (default red `LAMP_RED`; amber for indicators). */
  glow?: Paint;
}

/** Tail lamp: a dark surround with a domed glowing lens, round or bar-shaped,
 * standing 2–3 cm proud of the panel it is placed on (and sunk 2 cm in). */
export function addTailLamp(m: SolidMesh, o: TailLampOptions): void {
  const BEZEL = asPaint(o.bezel, CHARCOAL, { gloss: 0.5 });
  const GLOW = o.glow ?? LAMP_RED;
  const s = new SolidMesh();
  if (o.size) {
    const [w, h] = o.size;
    roundedBox(s, { min: [-w / 2 - 0.012, -h / 2 - 0.012, -0.02], max: [w / 2 + 0.012, h / 2 + 0.012, 0.018], radius: Math.min(0.016, h * 0.4), segments: 2 }, BEZEL);
    roundedBox(s, { min: [-w / 2, -h / 2, 0], max: [w / 2, h / 2, 0.03], radius: Math.min(0.014, h * 0.45, w * 0.45), segments: 2 }, GLOW);
  } else {
    const r = o.radius ?? 0.05;
    cylinder(s, { from: [0, 0, -0.02], to: [0, 0, 0.018], radius: r + 0.014, sides: 16, bevel: { top: 0.008 }, bevelSegments: 2 }, BEZEL);
    sphere(s, { radii: [r, r * 0.5, r], segments: 14, rings: 8, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [0, 0, 0.012] }, GLOW);
  }
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, -1]));
}

// ---------------------------------------------------------------------------
// Exhaust, fan, antenna

/** Exhaust tip: a short hollow pipe from `from` to its mouth at `to`, with a
 * rolled chrome lip and a dark bore you can look into. */
export function addExhaustTip(m: SolidMesh, o: { from: Vec3; to: Vec3; radius?: number; color?: Color }): void {
  const r = o.radius ?? 0.045;
  const P = asPaint(o.color, STEEL, { gloss: 0.8, metal: 1 });
  const a = toV3(o.from);
  const b = toV3(o.to);
  const len = Vector3.Distance(a, b);
  const BORE = paint('#1C1C22', { gloss: 0.2 });
  revolve(
    m,
    {
      // Along local +Y from the pipe's root to its mouth, then back down the bore.
      profile: [
        [r * 0.92, 0],
        [r * 0.92, len - r * 0.5],
        [r * 1.08, len - r * 0.32],
        [r * 1.12, len - r * 0.08],
        [r * 1.02, len],
        [r * 0.84, len - r * 0.06],
        [r * 0.8, len * 0.25],
        [0, len * 0.25],
      ],
      segments: 14,
      at: compose(rotation('x', 90), aimZ(a, b.subtract(a))),
    },
    (band) => (band >= 5 ? BORE : band >= 1 ? CHROME : P),
  );
}

export interface FanDuctOptions {
  /** Centre of the duct = the rotor's pivot. */
  at: Vec3;
  /** Where the air goes (default backward [0, 0, −1]). */
  dir?: Vec3;
  /** Rotor radius; the duct is built around it. */
  radius: number;
  /** Length of the duct along the flow (default 0.9 × radius). */
  depth?: number;
  /** Duct shell colour. */
  shell?: Color;
  /** Colour of the band round the duct's outlet lip (default: shell). */
  lip?: Color;
  /** Motor pod + stator struts colour (default gunmetal). */
  motor?: Color;
}

/**
 * Fan duct (static): a hollow aerofoil ring with real wall thickness, a
 * motor pod on the centre line and three stator struts holding it. The
 * rotor is a separate spinning part — `buildFanRotor` with the same radius,
 * `fanSpinner` to place it at the same `at` / `dir`. About 600 triangles.
 */
export function addFanDuct(m: SolidMesh, o: FanDuctOptions): void {
  const R = o.radius;
  const D = o.depth ?? R * 0.9;
  const SHELL = asPaint(o.shell, paint('#F4E4C8', { gloss: 0.85 }), { gloss: 0.85 });
  const LIP = asPaint(o.lip, SHELL, { gloss: 0.85 });
  const MOTOR = asPaint(o.motor, GUNMETAL, { gloss: 0.55 });
  const s = new SolidMesh();
  const wall = Math.max(0.025, R * 0.16);
  const gap = Math.max(0.008, R * 0.05);
  const ri = R + gap;
  // Lathed about local +Z (the flow). Closed aerofoil section: fat rounded
  // inlet lip at −z (the front), tapering to the outlet at +z.
  revolve(
    s,
    {
      profile: [
        [ri + wall * 0.55, D * 0.5],
        [ri + wall * 0.25, D * 0.5 + wall * 0.12],
        [ri, D * 0.5],
        [ri, -D * 0.32],
        [ri + wall * 0.18, -D * 0.5],
        [ri + wall * 0.62, -D * 0.56],
        [ri + wall * 1.0, -D * 0.46],
        [ri + wall * 1.1, -D * 0.2],
        [ri + wall * 0.9, D * 0.25],
      ],
      closed: true,
      segments: 28,
      rot: [90, 0, 0],
    },
    (band) => (band === 8 || band <= 1 ? LIP : SHELL),
  );
  // Motor pod and its three struts on the INLET side, so that from behind
  // the car (the outlet, the side the camera sees) the rotor and its glowing
  // cap are unobstructed.
  revolve(s, { profile: [[0, -D * 0.5], [R * 0.13, -D * 0.47], [R * 0.25, -D * 0.28], [R * 0.25, -R * 0.1], [0, -R * 0.1]], segments: 12, rot: [90, 0, 0] }, MOTOR);
  for (let k = 0; k < 3; k++) {
    const st = s.mark();
    box(s, { min: [R * 0.18, -R * 0.035, -D * 0.4], max: [ri + wall * 0.3, R * 0.035, -D * 0.2] }, MOTOR);
    s.rotate('z', k * 120 + 90, st);
  }
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, -1]));
}

export interface FanRotorOptions {
  radius: number;
  /** Blade count (default 9). */
  blades?: number;
  /** Blade colour (default charcoal). */
  blade?: Color;
  /** Spinner cone colour (default steel). */
  hub?: Color;
  /** Glowing hub cap and ring — the "it is running" light (default cyan;
   * pass an emissive Paint, or a colour to get emissive 0.8). */
  glow?: Color;
}

/**
 * Fan rotor, the spinning part: hub, twisted swept blades, and a glowing cap
 * with a glowing ring round the hub. Disc in the local XY plane, spin axis
 * along Z: that is the orientation of a fan blowing straight back or forward
 * (axis [0, 0, ∓1]) — which is what `CarSpinner` needs, since the assembler
 * does not turn the mesh onto the axis; for any other axis use `fanSpinner`,
 * which does. The detailed face (cap) is on −Z, the side you see from behind
 * the car. About 600 triangles.
 */
export function buildFanRotor(o: FanRotorOptions): SolidMesh {
  const R = o.radius;
  const BLADE = asPaint(o.blade, CHARCOAL, { gloss: 0.5 });
  const HUB = asPaint(o.hub, STEEL, { gloss: 0.7, metal: 1 });
  const glowBase = asPaint(o.glow, paint('#00E6EF', { emissive: 0.8, gloss: 0.9 }));
  const GLOW = glowBase.emissive > 0 ? glowBase : paint(glowBase, { emissive: 0.8 });
  const m = new SolidMesh();
  const hub = R * 0.32;
  // Lathed about +Y, then +Y is turned onto −Z: the bevelled end and the cap
  // face the rear.
  revolve(m, { profile: [[0, -0.55], [hub * 0.55, -0.55], [hub, -0.35], [hub, 0.25], [hub * 0.6, 0.5], [0, 0.5]].map(([r, y]) => [r, y * R * 0.3] as Vec2), segments: 16, rot: [-90, 0, 0] }, HUB);
  sphere(m, { radii: [hub * 0.5, hub * 0.35, hub * 0.5], segments: 12, rings: 6, latitude: [0, 90], caps: false, rot: [-90, 0, 0], at: [0, 0, -R * 0.15] }, GLOW);
  // A thin glowing ring round the hub's shoulder: at speed it is the bright
  // circle the vision's fans show.
  torus(m, { radius: hub * 0.86, tube: R * 0.028, segments: 18, sides: 5, rot: [90, 0, 0], at: [0, 0, -R * 0.115] }, GLOW);
  const n = Math.max(2, Math.round(o.blades ?? 9));
  // A blade is a real thin section at five stations out along +Y: pitched
  // steeply at the root and flat at the tip (the twist), each station turned
  // a little further back round the axis (the sweep), the last one small so
  // the tip comes out rounded.
  const st: [number, number, number, number][] = [
    [hub * 0.8, R * 0.24, 40, 0],
    [R * 0.5, R * 0.32, 31, 4],
    [R * 0.76, R * 0.33, 23, 10],
    [R * 0.92, R * 0.26, 18, 15],
    [R * 0.985, R * 0.12, 16, 18],
  ];
  for (let k = 0; k < n; k++) {
    const s = m.mark();
    const rings = st.map(([y, chord, pitch, sweep]) => {
      const a = (pitch * Math.PI) / 180;
      const b = (sweep * Math.PI) / 180;
      const t = R * 0.02;
      const corners: [number, number][] = [[-chord / 2, -t], [chord / 2, -t], [chord / 2, t], [-chord / 2, t]];
      return corners.map(([cx, cz]) => {
        const x = cx * Math.cos(a) - cz * Math.sin(a);
        const z = cx * Math.sin(a) + cz * Math.cos(a);
        return new Vector3(x * Math.cos(b) + y * Math.sin(b), y * Math.cos(b) - x * Math.sin(b), z);
      });
    });
    for (let i = 0; i + 1 < rings.length; i++) {
      const A = rings[i];
      const B = rings[i + 1];
      for (let j = 0; j < 4; j++) {
        const j1 = (j + 1) % 4;
        const mid = A[j].add(A[j1]).add(B[j]).add(B[j1]).scale(0.25);
        const core = A[0].add(A[2]).add(B[0]).add(B[2]).scale(0.25);
        quadOut(m, A[j], A[j1], B[j1], B[j], mid.subtract(core), BLADE);
      }
    }
    const tip = rings[rings.length - 1];
    quadOut(m, tip[0], tip[1], tip[2], tip[3], tip[0].add(tip[2]).scale(0.5), BLADE);
    m.rotate('z', (k * 360) / n, s);
  }
  return m;
}

function quadOut(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, d: Vector3, dir: Vector3, p: Paint): void {
  const n = Vector3.Cross(b.subtract(a), c.subtract(a));
  if (Vector3.Dot(n, dir) >= 0) m.quad(a, b, c, d, p);
  else m.quad(a, d, c, b, p);
}

/**
 * Wrap a rotor as a `CarSpinner` at `pivot`, spinning about `dir` (the flow
 * direction, as given to `addFanDuct`). The rotor mesh is turned from its
 * built orientation (cap toward −Z) so that its cap faces along `dir`.
 */
export function fanSpinner(rotor: SolidMesh, pivot: P3, dir: P3 = [0, 0, -1], speed: { idle?: number; full?: number } = {}): CarSpinner {
  const d = new Vector3(dir[0], dir[1], dir[2]).normalize();
  // Built with the cap on −Z: aim local −Z along dir (= local +Z along −dir).
  const mesh = d.z < -0.9999 && Math.abs(d.x) < 1e-6 ? rotor : rotor.clone().transform(aimZ([0, 0, 0], d.scale(-1)));
  return { mesh, pivot, axis: [d.x, d.y, d.z], idleSpeed: speed.idle ?? 8, fullSpeed: speed.full ?? 70 };
}

/** Whip antenna: spring base, thin whip leaning by `lean` degrees backward,
 * a ball on top. `height` is the overall height above `at`. */
export function addAntenna(m: SolidMesh, o: { at: Vec3; height?: number; lean?: number; ball?: Color }): void {
  const h = o.height ?? 0.6;
  const BALL = asPaint(o.ball, paint('#FF6373', { gloss: 0.8 }), { gloss: 0.8 });
  const s = new SolidMesh();
  cylinder(s, { from: [0, -0.01, 0], to: [0, 0.02, 0], radius: 0.022, sides: 8, bevel: { top: 0.006 }, bevelSegments: 1 }, CHARCOAL);
  for (let i = 0; i < 3; i++) torus(s, { radius: 0.011, tube: 0.0065, segments: 6, sides: 4, at: [0, 0.028 + i * 0.014, 0] }, STEEL);
  tube(s, { path: [[0, 0.06, 0], [0, h * 0.6, 0], [0, h - 0.02, -h * 0.03]], radius: [0.006, 0.0045, 0.0035], sides: 5, caps: false }, STEEL);
  cylinder(s, { from: [0, 0.02, 0], to: [0, 0.07, 0], radius: 0.007, sides: 5, caps: false }, STEEL);
  sphere(s, { radius: 0.02, segments: 8, rings: 5, at: [0, h - 0.02, -h * 0.03] }, BALL);
  s.rotate('x', -(o.lean ?? 8));
  m.append(s, toV3(o.at));
}

// ---------------------------------------------------------------------------
// Light bar, jet nozzle

export interface LightBarOptions {
  /** Centre of the bar's lens face. */
  at: Vec3;
  /** Where it shines (default forward). */
  dir?: Vec3;
  /** Overall width and height of the housing (default 0.6 × 0.09). */
  width?: number;
  height?: number;
  /** Number of lamps across (default 3; 1 = one long LED strip). */
  lamps?: number;
  /** Housing colour (default charcoal). */
  housing?: Color;
  /** Glow paint (default warm `LAMP_WARM`; pass a cyan emissive paint for an
   * LED strip). */
  glow?: Paint;
  /** Stand it on two feet reaching this far DOWN to a cage tube (default 0 =
   * none; the bar is then let into whatever is behind it). */
  feet?: number;
}

/**
 * A lamp bar — the roof bar of a truck or a single LED strip: a rounded
 * housing 8 cm deep with `lamps` glowing lenses side by side, each in its own
 * recess, optionally on two feet. About 250 triangles with three lamps.
 *   addLightBar(body, { at: [0, 1.95, 0.3], width: 0.7, lamps: 4, feet: 0.06 });
 *   addLightBar(body, { at: [0, 0.6, 1.6], width: 0.4, height: 0.04, lamps: 1, glow: paint('#00E6EF', { emissive: 0.8 }) });
 */
export function addLightBar(m: SolidMesh, o: LightBarOptions): void {
  const W = o.width ?? 0.6;
  const H = o.height ?? 0.09;
  const n = Math.max(1, Math.round(o.lamps ?? 3));
  const HOUSING = asPaint(o.housing, CHARCOAL, { gloss: 0.6 });
  const GLOW = o.glow ?? LAMP_WARM;
  const s = new SolidMesh();
  const D = 0.08;
  roundedBox(s, { min: [-W / 2, -H / 2, -D], max: [W / 2, H / 2, 0], radius: Math.min(0.02, H * 0.3), segments: 2 }, HOUSING);
  const rim = Math.min(0.014, H * 0.2);
  const cell = (W - rim) / n;
  for (let k = 0; k < n; k++) {
    const x = (k - (n - 1) / 2) * cell;
    roundedBox(s, { min: [x - cell / 2 + rim, -H / 2 + rim, -0.012], max: [x + cell / 2 - rim, H / 2 - rim, 0.008], radius: Math.min(0.012, H * 0.2, cell * 0.2), segments: 2 }, GLOW);
  }
  const feet = o.feet ?? 0;
  if (feet > 0) {
    for (const x of [-1, 1]) roundedBox(s, { min: [x * W * 0.32 - 0.022, -H / 2 - feet, -D + 0.012], max: [x * W * 0.32 + 0.022, -H / 2 + 0.01, -0.016], radius: 0.008, segments: 1 }, HOUSING);
  }
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, 1]));
}

export interface NozzleOptions {
  /** Centre of the nozzle's mouth. */
  at: Vec3;
  /** Where the jet blows (default backward [0, 0, −1]). */
  dir?: Vec3;
  /** Mouth radius. */
  radius: number;
  /** Length of the nozzle back from its mouth (default 2.2 × radius). */
  length?: number;
  /** Shell colour (default gunmetal) and the band round the mouth. */
  shell?: Color;
  lip?: Color;
  /** Glow of the flame holder inside (default cyan; a colour gets emissive
   * 0.85). */
  glow?: Color;
}

/**
 * A jet / thruster nozzle: a tapered shell with cooling ribs, a rolled lip
 * and a dark throat you can look into, at the bottom of which a small flame
 * holder glows (a broad emissive face would clip to a flat disc, so the glow
 * is a cone and a ring deep in the throat). Its root (the end away from the
 * mouth) is open: sink it into the engine or the body. About 550 triangles.
 *   addNozzle(body, { at: [0, 0.9, -1.8], radius: 0.11, glow: COMET_FOX.emissionBlue });
 */
export function addNozzle(m: SolidMesh, o: NozzleOptions): void {
  const r = o.radius;
  const len = o.length ?? r * 2.2;
  const SHELL = asPaint(o.shell, GUNMETAL, { gloss: 0.6 });
  const LIP = asPaint(o.lip, CHROME, { gloss: 0.9, metal: 1 });
  const glowBase = asPaint(o.glow, paint('#00E6EF', { emissive: 0.85, gloss: 0.9 }));
  const GLOW = glowBase.emissive > 0 ? glowBase : paint(glowBase, { emissive: 0.85 });
  const THROAT = paint('#1C1C22', { gloss: 0.2 });
  const s = new SolidMesh();
  // Lathed about local +Y (root at 0, mouth at len), then aimed: outside
  // from the root to the lip, over it, and down the throat.
  const ribs: Vec2[] = [];
  for (let i = 0; i < 2; i++) {
    const y = len * (0.24 + i * 0.22);
    const rr = r * (1.2 - 0.1 * i);
    ribs.push([rr, y], [rr + r * 0.07, y + len * 0.02], [rr + r * 0.07, y + len * 0.07], [rr - r * 0.03, y + len * 0.09]);
  }
  revolve(
    s,
    {
      profile: [
        [r * 1.22, 0],
        ...ribs,
        [r * 0.98, len * 0.78],
        [r * 1.08, len * 0.86],
        [r * 1.1, len * 0.96],
        [r * 1.0, len],
        [r * 0.86, len * 0.95],
        [r * 0.62, len * 0.3],
        [0, len * 0.3],
      ],
      segments: 16,
    },
    (band) => (band >= 13 ? THROAT : band >= 9 ? LIP : SHELL),
  );
  // Flame holder: a glowing cone and ring at the bottom of the throat.
  revolve(s, { profile: [[r * 0.34, len * 0.3], [r * 0.2, len * 0.46], [0, len * 0.56]], segments: 12 }, GLOW);
  torus(s, { radius: r * 0.5, tube: r * 0.06, segments: 16, sides: 5, at: [0, len * 0.33, 0] }, GLOW);
  s.translate([0, -len, 0]);
  m.append(s, compose(rotation('x', 90), aimZ(o.at, o.dir ?? [0, 0, -1])));
}

// ---------------------------------------------------------------------------
// Number plate / roundel

/** Seven-segment layout, segments a–g, for a chunky stencil digit. */
const SEGMENTS: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd' };

/** Raised digits centred on the local origin, `height` tall, facing local
 * +z (authored as seen: x = right), slanted like a race number. */
function addDigits(s: SolidMesh, text: string, height: number, depth: number, p: Paint): void {
  const start = s.mark();
  const h = height / 2;
  const w = height * 0.28;
  const t = height * 0.16;
  const advance = w * 2 + t * 1.4;
  const digits = [...text].filter((c) => SEGMENTS[c]);
  digits.forEach((c, i) => {
    const x0 = (i - (digits.length - 1) / 2) * advance;
    const bar = (cx: number, cy: number, horizontal: boolean): void => {
      const len = horizontal ? w * 2 : h;
      roundedBox(s, { size: horizontal ? [len, t, depth] : [t, len, depth], radius: Math.min(t * 0.3, depth * 0.4), segments: 1, at: [x0 + cx, cy, depth / 2 - 0.002] }, p);
    };
    const seg = SEGMENTS[c];
    if (seg.includes('a')) bar(0, h - t / 2, true);
    if (seg.includes('g')) bar(0, 0, true);
    if (seg.includes('d')) bar(0, -h + t / 2, true);
    if (seg.includes('f')) bar(-w + t / 2, h / 2, false);
    if (seg.includes('b')) bar(w - t / 2, h / 2, false);
    if (seg.includes('e')) bar(-w + t / 2, -h / 2, false);
    if (seg.includes('c')) bar(w - t / 2, -h / 2, false);
  });
  // Italic shear: x += 0.2 y.
  s.transform(Matrix.FromValues(1, 0, 0, 0, 0.2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), start);
}

export interface NumberPlateOptions {
  /** Centre of the plate's face. */
  at: Vec3;
  /** Which way it faces. */
  normal: Vec3;
  /** Race number, digits only (e.g. '7', '42'). */
  number: string;
  /** 'roundel': a disc with a ring; 'plate': a rounded rectangle. */
  shape?: 'roundel' | 'plate';
  /** Roundel diameter / plate height (default 0.3). */
  size?: number;
  /** Background, ring and digit colours. */
  plate?: Color;
  ring?: Color;
  digits?: Color;
}

/**
 * Race number on a roundel or a plate: raised stencil digits on a thin
 * bevelled panel, standing 1.5 cm proud of whatever it is placed on (and
 * reaching 2 cm into it). Reads the right way round from the side it faces,
 * on either flank of the car.
 */
export function addNumberPlate(m: SolidMesh, o: NumberPlateOptions): void {
  const size = o.size ?? 0.3;
  const PLATE = asPaint(o.plate, paint('#F5F2E9', { gloss: 0.6 }), { gloss: 0.6 });
  const RING = asPaint(o.ring, CHARCOAL, { gloss: 0.5 });
  const DIGITS = asPaint(o.digits, CHARCOAL, { gloss: 0.5 });
  const s = new SolidMesh();
  const count = Math.max(1, [...o.number].filter((c) => SEGMENTS[c]).length);
  if ((o.shape ?? 'roundel') === 'roundel') {
    const r = size / 2;
    // A closed disc with a 2 cm skirt behind its face: on a rounded panel
    // edge the plate overhangs, and its back and rim are then in view.
    extrudePolygon(s, { outline: circleRing(r, 28), depth: 0.032, bevel: 0.004, at: [0, 0, -0.02] }, RING);
    extrudePolygon(s, { outline: circleRing(r * 0.86, 28), depth: 0.006, bevel: 0.002, back: false, at: [0, 0, 0.012] }, PLATE);
    const d = s.mark();
    addDigits(s, o.number, r * (count > 1 ? 0.8 : 1.0), 0.008, DIGITS);
    s.translate([0, 0, 0.018], d);
  } else {
    const w = size * (0.75 + 0.5 * count);
    extrudePolygon(s, { outline: superellipseRing(w / 2, size / 2, 6, 24), depth: 0.032, bevel: 0.004, at: [0, 0, -0.02] }, PLATE);
    const d = s.mark();
    addDigits(s, o.number, size * 0.62, 0.008, DIGITS);
    s.translate([0, 0, 0.012], d);
  }
  m.append(s, facingAt(o.at, o.normal));
}
