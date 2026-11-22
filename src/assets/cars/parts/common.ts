import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Matrix } from '@babylonjs/core/Maths/math.vector';
import { frame, paint, toV3 } from '../../../gfx/solid';
import type { Paint, RGB, Vec3 } from '../../../gfx/solid';
import { CAR_COMMON } from '../../palette';

/**
 * Shared vocabulary of the car parts library: the stock paints every car
 * uses for its unpainted hardware, and the small types the builders share.
 */

/** A model-space point as a plain tuple (what `CarLink` anchors use). */
export type P3 = [number, number, number];

/** Anything a part accepts as a colour: hex string, RGB tuple, or a Paint
 * (whose gloss / metal are then kept as given). */
export type Color = string | RGB | Paint;

/**
 * Resolve a `Color` option. A Paint passes through untouched; a hex / RGB
 * gets the surface the part asks for (`surface`), so `ring: '#FF6373'` on a
 * rim comes out glossy and the same value on a seat comes out matte.
 */
export function asPaint(c: Color | undefined, fallback: Paint, surface: { gloss?: number; metal?: number; smooth?: number } = {}): Paint {
  if (c === undefined) return fallback;
  if (typeof c === 'object' && !Array.isArray(c) && 'color' in (c as object)) return c as Paint;
  return paint(c as string | RGB, surface);
}

/** Dark warm rubber: tires, boots, bump stops, grips. */
export const RUBBER = paint(CAR_COMMON.rubber, { gloss: 0.2, smooth: 35 });
/** Bright brushed metal: bolts, rods, discs, bare tube. */
export const STEEL = paint(CAR_COMMON.metal, { gloss: 0.7, metal: 1 });
/** Polished chrome: damper shafts, exhaust lips, reflector bowls. */
export const CHROME = paint('#D6DAE0', { gloss: 0.95, metal: 1 });
/** Dark anodised metal: uprights, arms, damper bodies. */
export const GUNMETAL = paint('#4A4C56', { gloss: 0.55, metal: 0.7 });
/** Charcoal moulded plastic: rim centres, dashboards, seat shells. Not
 * black — a near-black albedo gives the light nothing to work on. */
export const CHARCOAL = paint('#3A3A43', { gloss: 0.45 });
/** Matte seat / suit fabric black. */
export const FABRIC = paint('#34343C', { gloss: 0.12 });
/** Warm lamp glow: never white, never emissive 1 on a broad face. */
export const LAMP_WARM = paint('#FFD9A0', { emissive: 0.8, gloss: 0.9 });
/** Hot core of a lamp — small faces only. */
export const LAMP_CORE = paint('#FFF0CC', { emissive: 0.95, gloss: 0.9 });
/** Tail-lamp red. */
export const LAMP_RED = paint('#FF3A2E', { emissive: 0.75, gloss: 0.9 });


function perpendicularUp(z: Vector3, up: Vec3): Vector3 {
  const u = toV3(up);
  let y = u.subtract(z.scale(Vector3.Dot(u, z)));
  // Pointing straight along `up`: any horizontal direction will do.
  if (y.lengthSquared() < 1e-8) y = new Vector3(0, 0, 1).subtract(z.scale(z.z));
  if (y.lengthSquared() < 1e-8) y = new Vector3(1, 0, 0);
  return y.normalize();
}

/**
 * Rigid placement for a part built pointing along its local +Z (lamp pods,
 * exhausts, fans, hooks): local +Z goes onto `dir`, local +Y as close to
 * `up` as the direction allows, the local origin to `at`.
 */
export function aimZ(at: Vec3, dir: Vec3, up: Vec3 = [0, 1, 0]): Matrix {
  const z = toV3(dir).clone().normalize();
  const y = perpendicularUp(z, up);
  return frame(at, Vector3.Cross(y, z), y, z);
}

/**
 * Placement for a part AUTHORED AS YOU SEE IT — local x = the viewer's
 * right, y = up, z = toward the viewer (plates, numbers, dashboards) — so
 * that it faces `normal` at `at`. Text and anything else asymmetric then
 * reads the right way round from outside. (The matrix mirrors; the kit turns
 * the winding back.)
 */
export function facingAt(at: Vec3, normal: Vec3, up: Vec3 = [0, 1, 0]): Matrix {
  const z = toV3(normal).clone().normalize();
  const y = perpendicularUp(z, up);
  return frame(at, Vector3.Cross(z, y), y, z);
}
