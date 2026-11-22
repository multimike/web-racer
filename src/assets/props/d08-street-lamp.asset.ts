import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, cone, cylinder, hex, jitterColor, mix, paint, quadFacing, revolve, rng, tube } from '../../gfx/solid';
import type { Paint, RGB, Vec3 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { IRON } from './dressing-village-parts';

/**
 * Village street lamp, toy-chunky like the vision's ironwork: a stout dark
 * pole on a ringed, flared foot, a fat bracket arm, and the vision's lantern
 * — four tapered panes of glowing glass with a cross mullion in a dark frame
 * with broad chamfered corners, pyramid roof, pointed foot.
 *
 * The arm reaches toward −z (the street side). Seeds change the bracket
 * style (gooseneck / straight arm with a brace / curled crook), the colour
 * of the lantern roof and the pole tone; every seed keeps the same envelope.
 */

const POLE_TOP = 2.95;
const REACH = 0.6;
const ARC_Y = POLE_TOP + 0.1;
const ARC_R = REACH / 2;
// The glass is a light SOURCE: nearly full emissive, so the sun does not
// shade one pane lemon and the next orange, and a gradient from a cream
// core (the flame, behind the mullion crossing) to amber at the frame.
// Saturated on purpose — the tone map pushes a lit emissive toward white.
const GLOW_CORE = hex('#FFDF9C');
const GLOW_EDGE = hex('#F26A0C');

interface LanternOptions {
  /** Hanging point: the top of the roof finial. */
  x: number;
  y: number;
  z: number;
  frame: Paint;
  roof: Paint;
  glow: number;
}

/** Hanging lantern, 0.74 m tall below its hanging point. */
function lantern(m: SolidMesh, o: LanternOptions): void {
  const at: Vec3 = [o.x, o.y, o.z];
  const sq = Math.SQRT2;
  // Half-widths of the glass body: wider at the eave than at the foot.
  const top = 0.19;
  const bottom = 0.135;
  const chamfer = 0.04;
  const yRoof = -0.27;
  const yFoot = -0.63;
  // Roof with a pointed finial: one four-sided revolve (flat sides, square
  // in plan — the "radius" of a 4-segment revolve is the half-diagonal).
  // Its underside is real: the lantern hangs above eye height.
  revolve(
    m,
    {
      profile: [
        [0, yRoof - 0.012],
        [(top + 0.085) * sq, yRoof - 0.012],
        [(top + 0.085) * sq, yRoof + 0.028],
        [0.075 * sq, yRoof + 0.175],
        [0.04 * sq, yRoof + 0.27],
        [0, yRoof + 0.27],
      ],
      segments: 4,
      arcStart: 45,
      round: false,
      at,
    },
    o.roof,
  );
  // Glass panes with a cross mullion. The mullions are part of the pane grid
  // (split faces), not bars laid on top: crisp, nothing to z-fight or float.
  const PANE = paint(GLOW_EDGE, { emissive: o.glow, gloss: 0.6 });
  const mid: RGB = mix(GLOW_CORE, GLOW_EDGE, 0.55);
  const bar = 0.02;
  const vs = [0, 0.5 - 0.055, 0.5 + 0.055, 1];
  const half = (v: number): number => bottom + (top - bottom) * v;
  const yAt = (v: number): number => o.y + yFoot + (yRoof - yFoot) * v;
  for (let f = 0; f < 4; f++) {
    // Face f: outward normal n, in-plane tangent t (turning with the face).
    const nx = [0, 1, 0, -1][f];
    const nz = [-1, 0, 1, 0][f];
    const tx = -nz;
    const tz = nx;
    const out = new Vector3(nx, 0, nz);
    const pt = (i: number, j: number): Vector3 => {
      const h = half(vs[j]);
      // The mullion keeps its width up the taper; the pane edges follow it.
      const along = [-(h - chamfer), -bar, bar, h - chamfer][i];
      return new Vector3(o.x + nx * h + tx * along, yAt(vs[j]), o.z + nz * h + tz * along);
    };
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        if (i === 1 || j === 1) {
          quadFacing(m, pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), out, o.frame);
          continue;
        }
        // Pane: fanned from its corner at the mullion crossing, which
        // carries the cream core; the far corner is deepest amber.
        const ci = i === 0 ? 1 : 2;
        const cj = j === 0 ? 1 : 2;
        const oi = i === 0 ? 0 : 3;
        const oj = j === 0 ? 0 : 3;
        const inner = pt(ci, cj);
        const far = pt(oi, oj);
        const sideA = pt(oi, cj);
        const sideB = pt(ci, oj);
        for (const sidePt of [sideA, sideB]) {
          const nrm = Vector3.Cross(sidePt.subtract(inner), far.subtract(inner));
          if (Vector3.Dot(nrm, out) >= 0) m.tri(inner, sidePt, far, PANE, [GLOW_CORE, mid, GLOW_EDGE]);
          else m.tri(inner, far, sidePt, PANE, [GLOW_CORE, GLOW_EDGE, mid]);
        }
      }
    }
    // Corner of the frame between this face and the next: a broad chamfer.
    const f1 = (f + 1) % 4;
    const mx = [0, 1, 0, -1][f1];
    const mz = [-1, 0, 1, 0][f1];
    const edge = (v: number, mine: boolean): Vector3 => {
      const h = half(v);
      return mine
        ? new Vector3(o.x + nx * h + tx * (h - chamfer), yAt(v), o.z + nz * h + tz * (h - chamfer))
        : new Vector3(o.x + mx * h - -mz * (h - chamfer), yAt(v), o.z + mz * h - mx * (h - chamfer));
    };
    quadFacing(m, edge(0, true), edge(0, false), edge(1, false), edge(1, true), new Vector3(nx + mx, 0, nz + mz), o.frame);
  }
  // Foot: a shallow tray under the glass, drawn down to a point.
  revolve(
    m,
    {
      profile: [
        [0, yFoot - 0.11],
        [(bottom + 0.028) * sq, yFoot - 0.02],
        [(bottom + 0.028) * sq, yFoot + 0.02],
        [0, yFoot + 0.02],
      ],
      segments: 4,
      arcStart: 45,
      round: false,
      at,
    },
    o.frame,
  );
}

/** Points of an arc in the pole's z–y plane: centre (z, y), from angle a0
 * to a1 in degrees, 0° = +z, 90° = up, 180° = −z. */
function arcZY(cz: number, cy: number, radius: number, a0: number, a1: number, steps: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([0, cy + Math.sin(a) * radius, cz + Math.cos(a) * radius]);
  }
  return out;
}

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd08-street-lamp');
  const hero = seed === 0;
  const iron: RGB = hero ? IRON.pole : jitterColor(r, IRON.pole, { hue: 10, lightness: 0.04 });
  const POLE = paint(iron, { gloss: 0.4, metal: 0.25 });
  const roofColor: RGB = hero ? iron : ([iron, BUILDING.turquoise, BUILDING.coral, BUILDING.cobalt] as const)[seed % 4];
  const ROOF = paint(roofColor, { gloss: 0.45, metal: roofColor === iron ? 0.25 : 0 });
  const style = hero ? 0 : seed % 3;
  const m = new SolidMesh();

  // Foot + shaft in one lathe: plinth, step ring, flared column, a ridge
  // collar, then the stout shaft up to a second collar under the bracket.
  revolve(
    m,
    {
      profile: [
        [0.215, -0.05],
        [0.215, 0.09],
        [0.165, 0.15],
        [0.148, 0.5],
        [0.19, 0.575],
        [0.105, 0.72],
        // (A ring just under the collar gives its contact shade a place to
        // end, instead of smearing down the long shaft faces.)
        [0.089, POLE_TOP - 0.5],
        [0.088, POLE_TOP - 0.36],
        [0.128, POLE_TOP - 0.3],
        [0.08, POLE_TOP - 0.19],
        // Closed top: the bracket rises out of it.
        [0, POLE_TOP - 0.17],
      ],
      segments: 8,
    },
    POLE,
  );

  // Bracket. Each style ends at its own hanging point, all within the same
  // envelope.
  let hang: Vec3;
  if (style === 0) {
    // Gooseneck: up out of the pole, over in a half circle, down to the
    // lantern.
    const path: Vec3[] = [[0, POLE_TOP - 0.3, 0], ...arcZY(-ARC_R, ARC_Y, ARC_R, 0, 180, 8)];
    tube(m, { path, radius: 0.05, sides: 6, caps: true }, POLE);
    hang = [0, ARC_Y + 0.03, -REACH];
  } else if (style === 1) {
    // Straight arm with a diagonal brace and a spike on the pole top.
    const armY = POLE_TOP + 0.2;
    tube(m, { path: [[0, armY, 0.14], [0, armY, -REACH - 0.1]], radius: 0.048, sides: 6 }, POLE);
    tube(m, { path: [[0, POLE_TOP - 0.22, 0], [0, armY - 0.02, -REACH * 0.72]], radius: 0.034, sides: 5, caps: false }, POLE);
    cylinder(m, { from: [0, POLE_TOP - 0.24, 0], to: [0, POLE_TOP + 0.3, 0], radius: 0.068, sides: 6, caps: false }, POLE);
    cone(m, { from: [0, POLE_TOP + 0.3, 0], to: [0, POLE_TOP + 0.45, 0], radius: 0.085, sides: 6 }, POLE);
    hang = [0, armY - 0.01, -REACH];
  } else {
    // Shepherd's crook: the half circle carries on round and curls back in
    // above the lantern.
    const path: Vec3[] = [[0, POLE_TOP - 0.3, 0], ...arcZY(-ARC_R, ARC_Y, ARC_R, 0, 235, 8)];
    tube(m, { path, radius: 0.048, sides: 6, caps: true }, POLE);
    const end = path[path.length - 1] as readonly [number, number, number];
    hang = [0, end[1] + 0.03, end[2] - 0.01];
  }

  lantern(m, { x: hang[0], y: hang[1], z: hang[2], frame: POLE, roof: ROOF, glow: 0.85 });

  if (!hero) m.rotate('z', r.range(-1.2, 1.2));
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'cylinder', base: [0, 0, 0], height: POLE_TOP, radius: 0.2 }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd08-street-lamp',
  name: 'Street lamp',
  category: 'dressing',
  // y includes the 5 cm skirt below ground.
  size: { x: 0.55, y: 3.45, z: 1.09 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
