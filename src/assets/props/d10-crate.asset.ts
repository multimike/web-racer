import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, box, jitterColor, mix, paint, rng } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FOLIAGE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { FRUIT, WOOD, crateCorners, fruit, leaf, mound, slat, tray } from './dressing-village-parts';

/**
 * Slatted market crate from the vision's fruit stall: pale plank slats with
 * dark gaps between them, chunky corner posts standing a little proud, and
 * small glossy toy fruit packed to the brim.
 *
 * Seeds: 0 apples (the vision's hero crate) · 1 oranges · 2 greens ·
 * 3 empty; then the four repeat with different timber tones and sizes.
 */

// Sized so that five small fruit (15 cm) fill its width, as in the vision.
const W = 0.8;
const D = 0.56;
const H = 0.46;
const POST = 0.085;
const SLAT_T = 0.035;

function build(seed: number): SolidMesh {
  const r = rng(seed, 'd10-crate');
  const hero = seed === 0;
  const kind = hero ? 0 : seed % 4;
  const sc = hero ? 1 : r.range(0.9, 1.08);
  const w = W * sc;
  const d = D * (hero ? 1 : r.range(0.92, 1.06));
  const h = H * (hero ? 1 : r.range(0.9, 1.1));
  const wood: RGB = hero ? WOOD.pale : jitterColor(r, r.pick([WOOD.pale, WOOD.plank, mix(WOOD.pale, [0.8, 0.72, 0.62], 0.35)]), { hue: 4, lightness: 0.04 });
  const SLAT: Paint[] = [paint(wood, { gloss: 0.2 }), paint(mix(wood, WOOD.plank, 0.45), { gloss: 0.2 })];
  const POSTP = paint(mix(wood, WOOD.post, 0.7), { gloss: 0.25 });
  const INSIDE = paint(mix(wood, WOOD.dark, 0.75), { gloss: 0.05 });
  const m = new SolidMesh();

  // Dark liner: a thin-walled open box just behind the slats, so the gaps
  // between them read as shadow, not as holes to the grass, and the empty
  // crate has an inside. Its wall is thick enough that the inner skin
  // clears the backs of the slats.
  const hx = w / 2 - SLAT_T * 0.6;
  const hz = d / 2 - SLAT_T * 0.6;
  const full = kind === 0 || kind === 1;
  // (A crate packed to the brim needs no inside: just the dark outer skin.)
  if (full) box(m, { min: [-hx, -0.05, -hz], max: [hx, h - 0.004, hz], faces: { ny: null, py: null } }, INSIDE);
  else tray(m, hx, hz, -0.05, h - 0.004, 0.07, SLAT_T * 0.4 + 0.014, INSIDE, INSIDE);

  // Corner posts standing 12 mm proud of the slats.
  crateCorners(m, w / 2 + 0.012, d / 2 + 0.012, POST, -0.05, h + 0.02, POSTP);

  // Slats: two per side, with a gap between them and above the ground.
  const rows = 2;
  const gap = 0.06;
  const slatH = (h - 0.05 - gap * rows) / rows;
  for (let k = 0; k < rows; k++) {
    const y = 0.05 + gap + slatH / 2 + k * (slatH + gap) - gap * 0.4;
    const inset = POST * 0.5;
    for (const sz of [-1, 1]) {
      slat(m, new Vector3(-w / 2 + inset, y, sz * (d / 2 - SLAT_T)), new Vector3(w / 2 - inset, y, sz * (d / 2 - SLAT_T)), slatH, SLAT_T, new Vector3(0, 0, sz), SLAT[(k + (sz > 0 ? 1 : 0)) % 2]);
    }
    for (const sx of [-1, 1]) {
      slat(m, new Vector3(sx * (w / 2 - SLAT_T), y, -d / 2 + inset), new Vector3(sx * (w / 2 - SLAT_T), y, d / 2 - inset), slatH, SLAT_T, new Vector3(sx, 0, 0), SLAT[(k + (sx > 0 ? 0 : 1)) % 2]);
    }
  }

  if (full) {
    // One packed layer of small fruit, 5 × 3, standing proud of the rim,
    // and two riding on top. Packed a little tighter than their own width
    // so they press into each other; a dark filler under them closes the
    // gaps at the corners.
    const colors: RGB[] = kind === 0 ? [FRUIT.apple, FRUIT.apple, FRUIT.greenApple] : [FRUIT.orange, FRUIT.orange, FRUIT.lemon];
    const cols = 5;
    const rowsN = 3;
    const ex = hx - 0.004;
    const ez = hz - 0.004;
    const dx = (ex * 2) / cols;
    const dz = (ez * 2) / rowsN;
    const fr = Math.max(dx, dz) / 1.9;
    const yLayer = h - fr * 0.3;
    const FILL = paint(mix(colors[0], [0.2, 0.08, 0.08], 0.65), { gloss: 0.1 });
    // The filler closes the liner at its very top edge: set lower, the strip
    // of liner above it would show its inside from across the crate.
    const yFill = h - 0.004;
    m.quad([-hx, yFill, -hz], [-hx, yFill, hz], [hx, yFill, hz], [hx, yFill, -hz], FILL);
    const put = (x: number, y: number, z: number): void => {
      fruit(m, [x, y, z], { radius: fr * (hero ? 1 : r.range(0.95, 1.04)), color: jitterColor(r, r.weighted(colors, [6, 5, 2]), { hue: 4, lightness: 0.03 }), yaw: r.range(0, 360), sides: 5, full: true });
    };
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rowsN; j++) {
        put(-ex + dx * (i + 0.5), yLayer + r.range(-0.01, 0.012), -ez + dz * (j + 0.5));
      }
    }
    put(-dx * 0.52, yLayer + fr * 0.82, dz * 0.42);
    put(dx * 0.98, yLayer + fr * 0.8, -dz * 0.5);
  } else if (kind === 2) {
    // Inside clear span of the liner.
    const ix = hx - (SLAT_T * 0.4 + 0.014);
    const iz = hz - (SLAT_T * 0.4 + 0.014);
    // Greens: six cabbage heads, 3 × 2, bedded on a raised floor of dark
    // leaf so nothing empty shows between them, outer leaves lying over the
    // crate's edge.
    const GREEN = mix(FOLIAGE.lime, FRUIT.leaf, 0.5);
    const floorY = h - 0.13;
    const BED = paint(mix(FOLIAGE.jade, WOOD.dark, 0.35), { gloss: 0.1 });
    m.quad([-ix, floorY, -iz], [-ix, floorY, iz], [ix, floorY, iz], [ix, floorY, -iz], BED);
    const dx = (ix * 2) / 3;
    const dz = iz;
    let k = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const x = -ix + dx * (i + 0.5) + r.range(-0.012, 0.012);
        const z = -iz + dz * (j + 0.5) + r.range(-0.012, 0.012);
        const tone = (i + j) % 2 ? mix(GREEN, FOLIAGE.highlight, 0.4) : GREEN;
        const rad = Math.min(dx, dz) * 0.54;
        mound(m, { at: [x, floorY - 0.01, z], radius: rad, height: rad * r.range(1.0, 1.15), rings: [5, 7], seed: seed * 7 + k++, jitter: 0.6, color: tone });
        // One outer leaf per head, toward the nearest long side.
        const out = j === 0 ? -1 : 1;
        const lean = r.range(-0.06, 0.06);
        leaf(m, new Vector3(x, floorY + 0.1, z + out * rad * 0.3), new Vector3(x + lean, h + 0.035, out * (d / 2 + 0.035)), 0.2, mix(GREEN, FOLIAGE.jade, 0.3));
      }
    }
  }
  if (!hero) m.rotate('y', r.range(-8, 8));
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'box', center: [0, H / 2, 0], half: [W / 2, H / 2, D / 2] }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd10-crate',
  name: 'Market crate',
  category: 'dressing',
  size: { x: W + 0.024, y: H + 0.19, z: D + 0.024 },
  variants: 4,
  build,
  colliders,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
