import { SolidMesh, circleRing, cylinder, extrudePolygon, paint, sphere } from '../../../gfx/solid';
import type { Vec2, Vec3 } from '../../../gfx/solid';
import { CHARCOAL, CHROME, LAMP_RED, STEEL, addBolt, aimZ, facingAt } from '../parts';

/**
 * Close-up variants of two shared parts (`addBashPlate`, `addTailLamp`):
 * the same shapes, but with round things made round enough for a hero car
 * seen from a metre away — the shared plate cuts 12-gon holes and the shared
 * lamp has a 16-sided bezel, both of which show their corners up close.
 */

/** Bash plate with round 24-sided bores (shared `addBashPlate`, 'round'). */
export function addReefBashPlate(m: SolidMesh, o: { at: Vec3; normal: Vec3; width: number; height: number; holes: number }): void {
  const P = paint(STEEL, { gloss: 0.6, metal: 1 });
  const w = o.width / 2;
  const h = o.height / 2;
  const t = 0.03;
  const cut = Math.min(o.height * 0.3, w * 0.5);
  const outline: Vec2[] = [[-w, h], [w, h], [w, -h + cut], [w - cut, -h], [-w + cut, -h], [-w, -h + cut]];
  const pitch = (o.width - cut) / o.holes;
  const hr = Math.min(pitch * 0.33, o.height * 0.26);
  const holes: Vec2[][] = [];
  for (let k = 0; k < o.holes; k++) {
    const x = (k - (o.holes - 1) / 2) * pitch;
    holes.push(circleRing(hr, 24).map(([a, b]) => [a + x, b - h * 0.12] as Vec2));
  }
  const s = new SolidMesh();
  extrudePolygon(s, { outline, holes, depth: t, bevel: 0.008, bevelSegments: 1, bevelBack: true }, P);
  s.translate([0, 0, -t]);
  for (const x of [-1, 1]) addBolt(s, { at: [x * (w - 0.035), h - 0.03, 0], normal: [0, 0, 1], radius: 0.013 }, CHROME);
  m.append(s, facingAt(o.at, o.normal));
}

/** Round tail lamp: a dark bezel with a domed glowing lens (shared
 * `addTailLamp`, round), 28 sides. */
export function addReefTailLamp(m: SolidMesh, o: { at: Vec3; radius: number; dir?: Vec3 }): void {
  const r = o.radius;
  const s = new SolidMesh();
  cylinder(s, { from: [0, 0, -0.02], to: [0, 0, 0.018], radius: r + 0.014, sides: 28, bevel: { top: 0.008 }, bevelSegments: 2 }, paint(CHARCOAL, { gloss: 0.5 }));
  sphere(s, { radii: [r, r * 0.5, r], segments: 24, rings: 6, latitude: [0, 90], caps: false, rot: [90, 0, 0], at: [0, 0, 0.012] }, LAMP_RED);
  m.append(s, aimZ(o.at, o.dir ?? [0, 0, -1]));
}
