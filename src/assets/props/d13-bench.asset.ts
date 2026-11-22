import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, jitterColor, paint, rng, roundedBox } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { WOOD, bolt, ironPaint, timberPaint } from './dressing-village-parts';

/**
 * Timber village bench, toy-chunky: three fat seat slats and two broad back
 * slats on a pair of stout end frames (front leg, raked back leg, armrest),
 * bolted through. The sitter faces −z, the street. Every timber has broad
 * soft chamfers — nothing on it is a bare box.
 *
 * Seed 0 is bare timber. Other seeds paint the slats in one of the village
 * colours (turquoise, coral, mustard, cream) over timber frames — or the
 * other way round — vary length, tone and wear, and every fourth is the
 * plain kind without armrests (front legs stop under the seat).
 */

const LENGTH = 1.7;
const SEAT_Y = 0.46;
const BACK_TOP = 0.95;
const RAKE = 12;
const LEG_W = 0.12;
const LEG_D = 0.11;

/**
 * Square timber from `a` to `b` (centre line; it must run in the y–z plane),
 * `w` wide along x and `d` deep, its four long edges chamfered. Shaded like
 * the kit's rounded box: the flats exactly flat, the chamfers blending
 * between them, so 16 triangles read as a soft-edged beam. `capA` / `capB`
 * close an end (6 triangles); leave an end open where it is buried.
 */
function beam(m: SolidMesh, a: Vector3, b: Vector3, w: number, d: number, chamfer: number, p: Paint, capA = false, capB = false): void {
  const along = b.subtract(a).normalize();
  const X = new Vector3(1, 0, 0);
  const D = Vector3.Cross(along, X).normalize();
  const hw = w / 2;
  const hd = d / 2;
  const c = chamfer;
  // Section in (x, depth), with the normal of the flat each point belongs to.
  const sec: [number, number, number, number][] = [
    [-hw, -hd + c, -1, 0],
    [-hw, hd - c, -1, 0],
    [-hw + c, hd, 0, 1],
    [hw - c, hd, 0, 1],
    [hw, hd - c, 1, 0],
    [hw, -hd + c, 1, 0],
    [hw - c, -hd, 0, -1],
    [-hw + c, -hd, 0, -1],
  ];
  const ring = (o: Vector3): Vector3[] => sec.map(([x, dd]) => o.add(X.scale(x)).add(D.scale(dd)));
  const normals = sec.map(([, , nx, nd]) => X.scale(nx).add(D.scale(nd)));
  const A = ring(a);
  const B = ring(b);
  for (let k = 0; k < 8; k++) {
    const k1 = (k + 1) % 8;
    const out = normals[k].add(normals[k1]);
    const face = Vector3.Cross(A[k1].subtract(A[k]), B[k].subtract(A[k]));
    if (Vector3.Dot(face, out) >= 0) m.quad(A[k], A[k1], B[k1], B[k], p, undefined, [normals[k], normals[k1], normals[k1], normals[k]]);
    else m.quad(A[k], B[k], B[k1], A[k1], p, undefined, [normals[k], normals[k], normals[k1], normals[k1]]);
  }
  const cap = (pts: Vector3[], out: Vector3): void => {
    for (let k = 1; k + 1 < 8; k++) {
      if (Vector3.Dot(Vector3.Cross(pts[k].subtract(pts[0]), pts[k + 1].subtract(pts[0])), out) >= 0) m.tri(pts[0], pts[k], pts[k + 1], p);
      else m.tri(pts[0], pts[k + 1], pts[k], p);
    }
  };
  if (capA) cap(A, along.scale(-1));
  if (capB) cap(B, along);
}

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd13-bench');
  const hero = seed === 0;
  const len = hero ? LENGTH : LENGTH * r.range(0.86, 1.12);
  const timber: RGB = hero ? WOOD.plank : jitterColor(r, WOOD.plank, { hue: 5, lightness: 0.04 });
  const frameTimber: RGB = hero ? WOOD.post : jitterColor(r, WOOD.post, { hue: 5, lightness: 0.04 });
  const accents: RGB[] = [BUILDING.turquoise, BUILDING.coral, BUILDING.mustard, BUILDING.cream];
  const accent = accents[(seed + 3) % 4];
  // Seeds 1, 2, 3 mod 4: painted slats; every fourth seed after the hero:
  // painted frames with timber slats.
  const mode = hero ? 0 : seed % 4 === 0 ? 2 : 1;
  const armless = !hero && seed % 4 === 2;
  const SLAT: Paint = mode === 1 ? paint(accent, { gloss: 0.45 }) : timberPaint(timber, 0.25);
  const FRAME: Paint = mode === 2 ? paint(accent, { gloss: 0.45 }) : timberPaint(frameTimber, 0.25);
  const BOLT = ironPaint();
  const m = new SolidMesh();

  const fx = len / 2 - 0.2; // x of the end frames
  const rad = (RAKE * Math.PI) / 180;
  const rake = Math.tan(rad);
  // z of the back leg's centre line at height y.
  const backZ = (y: number): number => 0.17 + y * rake;

  // Seat slats: fat planks with soft edges on every side.
  const slatD = 0.15;
  const slatT = 0.07;
  const seatZ = [-0.215, -0.05, 0.115];
  seatZ.forEach((z, i) => {
    const s = m.mark();
    roundedBox(m, { size: [len, slatT, slatD], radius: 0.024, segments: 1, at: [0, SEAT_Y - slatT / 2, z] }, SLAT);
    // The front slat rolls forward a little, as on a real bench.
    if (i === 0) m.rotate('x', -7, s, [0, SEAT_Y - slatT / 2, z]);
  });
  // Back slats, lying on the raked back legs.
  const backY = [0.67, 0.86];
  const backT = 0.06;
  backY.forEach((y) => {
    roundedBox(m, { size: [len, 0.16, backT], radius: 0.024, segments: 1, rot: [RAKE, 0, 0], at: [0, y, backZ(y) - (LEG_D / 2 + backT / 2 - 0.008) / Math.cos(rad)] }, SLAT);
  });

  const armY = 0.66;
  for (const sx of [-1, 1]) {
    const x = sx * fx;
    // Front leg: up into the armrest, or stopping under the seat slats.
    const frontTop = armless ? SEAT_Y - slatT + 0.012 : armY + 0.02;
    beam(m, new Vector3(x, -0.05, -0.23), new Vector3(x, frontTop, -0.23), LEG_W, LEG_D, 0.022, FRAME);
    // Back leg: raked, up past the top slat, its sawn top showing.
    beam(m, new Vector3(x, -0.06, backZ(-0.06)), new Vector3(x, BACK_TOP - 0.01, backZ(BACK_TOP - 0.01)), LEG_W, LEG_D, 0.022, FRAME, false, true);
    // Seat rail under the slats, front leg to back leg (its ends are buried).
    box(m, { min: [x - 0.04, SEAT_Y - slatT - 0.1, -0.22], max: [x + 0.04, SEAT_Y - slatT + 0.012, backZ(SEAT_Y - 0.12)], faces: { nz: null, pz: null } }, FRAME);
    if (!armless) {
      // Armrest: a broad paddle over the front leg, dying into the back leg
      // (it is wider than the leg, so its far end shows either side of it).
      beam(m, new Vector3(x, armY + 0.035, -0.35), new Vector3(x, armY + 0.035, backZ(armY + 0.035) - 0.01), 0.16, 0.075, 0.026, FRAME, true, true);
    }
    // Bolt heads where the back slats meet the frame.
    const bz = (y: number): number => backZ(y) - (LEG_D / 2 + backT - 0.008) / Math.cos(rad) - 0.002;
    for (const y of backY) bolt(m, [x, y, bz(y)], [0, Math.sin(rad), -Math.cos(rad)], 0.024, BOLT);
  }

  if (!hero) {
    m.rotate('y', r.range(-3, 3));
    // A hint of sag toward one end on some benches.
    if (r.chance(0.5)) m.rotate('z', r.range(-0.8, 0.8));
  }
  return m;
}

function colliders(): ColliderSpec[] {
  return [
    { shape: 'box', center: [0, SEAT_Y / 2, -0.03], half: [LENGTH / 2, SEAT_Y / 2, 0.27] },
    { shape: 'box', center: [0, 0.7, 0.3], half: [LENGTH / 2, 0.25, 0.07] },
  ];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd13-bench',
  name: 'Village bench',
  category: 'dressing',
  size: { x: LENGTH, y: 1.0, z: 0.78 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-elevated-camera.png' },
};

export default asset;
