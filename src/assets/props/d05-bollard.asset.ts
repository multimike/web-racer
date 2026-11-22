import { SolidMesh, darken, jitterColor, mix, paint, revolve, rng, sphere } from '../../gfx/solid';
import type { Paint, Vec2 } from '../../gfx/solid';
import { BUILDING } from '../palette';
import type { PropAsset } from '../types';
import { TRACK } from './dressing-track-parts';

/**
 * Garage bollard, as in front of the workshop doors in the vision: a glossy
 * yellow post with a round top, a deep-orange foot flange and a matching
 * stripe under the dome. The seed changes paint (reflective band, scuffed
 * foot), proportions and how far it has been knocked off vertical.
 */

const HEIGHT = 0.8;
const RADIUS = 0.115;
const FLANGE = 0.04;

function build(seed: number): SolidMesh {
  const r = rng(seed, 'bollard');
  const hero = seed === 0;
  const body = hero ? TRACK.bollard : jitterColor(r, TRACK.bollard, { hue: 5, lightness: 0.03 });
  const tall = hero ? 1 : r.range(0.88, 1.1);
  const fat = hero ? 1 : r.range(0.94, 1.12);
  const banded = !hero && seed % 2 === 1;
  const scuffed = !hero && seed % 3 === 2;

  // A wide crease angle: the foot's chamfer shades round.
  const YELLOW = paint(body, { gloss: 0.7, smooth: 75 });
  const ORANGE = darken(mix(body, BUILDING.coral, 0.4), 0.06);
  const FOOT = paint(scuffed ? mix(TRACK.iron, body, 0.25) : ORANGE, { gloss: 0.5, smooth: 75 });
  const STRIPE = paint(ORANGE, { gloss: 0.6, smooth: 75 });
  const BAND = paint(seed % 4 === 3 ? TRACK.navy : BUILDING.cream, { gloss: 0.6, smooth: 75 });

  const R = RADIUS * fat;
  const H = HEIGHT * tall;
  // Lathe profile for foot and shaft — [radius, y, paint of the band BELOW
  // this row], bottom → top; the 5 cm skirt keeps the foot in the ground on
  // a slope. An orange stripe runs round the shaft just under the dome.
  const cy = H - R;
  const s1 = cy - 0.05;
  const s0 = s1 - 0.055;
  const shaft: [number, number, Paint][] = banded
    ? [
        [R, s0 - 0.2, YELLOW],
        [R, s0 - 0.08, BAND],
        [R, s0, YELLOW],
      ]
    : [[R, s0, YELLOW]];
  const rows: [number, number, Paint][] = [
    [R + FLANGE, -0.05, FOOT],
    [R + FLANGE, 0.05, FOOT],
    [R, 0.09, FOOT],
    ...shaft,
    [R, s1, STRIPE],
    [R, cy, YELLOW],
  ];
  const profile: Vec2[] = rows.map(([x, y]) => [x, y]);
  const segments = banded ? 16 : 18;
  const m = new SolidMesh();
  revolve(m, { profile, segments }, (band): Paint => rows[band + 1][2]);
  // A true hemisphere on top, tangent to the shaft (exact normals, so the
  // two shade as one surface).
  sphere(m, { radius: R, segments, rings: 10, latitude: [0, 90], caps: false, at: [0, cy, 0] }, YELLOW);
  if (!hero) {
    // Knocked by a car at some point: pivot at the foot.
    m.rotate('y', r.range(0, 360));
    m.rotate('z', r.range(2, 6) * (scuffed ? 1.3 : 0.6), 0, [0, 0, 0]);
    m.rotate('y', r.range(0, 360));
  }
  return m;
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd05-bollard',
  name: 'Garage bollard',
  category: 'dressing',
  size: { x: (RADIUS + FLANGE) * 2, y: HEIGHT + 0.05, z: (RADIUS + FLANGE) * 2 },
  variants: 4,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
  colliders: () => [{ shape: 'cylinder', base: [0, 0, 0], height: HEIGHT - 0.04, radius: RADIUS + 0.02 }],
  build,
};

export default asset;
