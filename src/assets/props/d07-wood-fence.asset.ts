import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SolidMesh, cylinder, jitterColor, mix, paint, rng, roundedBox } from '../../gfx/solid';
import type { Paint, RGB } from '../../gfx/solid';
import { FLOWERS, FOLIAGE } from '../palette';
import type { ColliderSpec, PropAsset } from '../types';
import { CLOTH, IRON, SMALL_SWAY, WOOD, blade, bolt, capHeight, flower, ironPaint, stem, timberPaint, timberPost } from './dressing-village-parts';
import { farBox, farCheckerCard, farPrism, farRidge, farStick, outTri } from './farKit';

/**
 * Post-and-rail fence of the gameplay vision: a chunky square post with a
 * dark pyramid cap, two thick rounded rails let into it, iron bolt heads on
 * the road face (−z).
 *
 * TILING (pitch 2.4 m, the planner's FENCE_PITCH): the capped post stands at
 * the segment's START (x = −1.2) and the rails run the whole pitch, so every
 * rail joint is buried in the next segment's post — a run can bend at each
 * joint without a rail end showing. At the END (x = +1.2) stands a slimmer,
 * shorter, capless post: inside a run it is wholly hidden in the neighbour's
 * capped post (which is why neither post leans — they have 15 mm of cover);
 * on the last segment of a run it is what closes the fence, and reads as one
 * of the vision's plain round-topped posts.
 *
 * Schemes: 'plain', and 'banner', which adds a post at mid-span and hangs
 * the vision's teal cloth with the white checker between the two capped
 * posts on the road side, tied at its four corners. The cloth sways (wind
 * weight 0 at the ties). The plain fence carries a flower clump at the post
 * foot instead, as the vision's fences do, so every build has something for
 * the wind.
 */

const LENGTH = 2.4;
const POST_X = LENGTH / 2;
const POST_W = 0.2;
const POST_H = 1.0;
const END_W = 0.17;
const END_H = 0.93;
const RAIL_H = 0.17;
const RAIL_T = 0.1;
const RAIL_Y = [0.83, 0.43] as const;
const TOP = POST_H + capHeight(POST_W);

/** Wind the quad a-b-c-d to face `out`, keeping the pinned normals with their corners. */
function quadOut(m: SolidMesh, a: Vector3, b: Vector3, c: Vector3, d: Vector3, out: Vector3, p: Paint, n: readonly [Vector3, Vector3, Vector3, Vector3]): void {
  const face = Vector3.Cross(b.subtract(a), d.subtract(a));
  if (Vector3.Dot(face, out) >= 0) m.quad(a, b, c, d, p, undefined, n);
  else m.quad(a, d, c, b, p, undefined, [n[0], n[3], n[2], n[1]]);
}

/**
 * Rail through `stations` (centre-line points, in order): a plank with broad
 * chamfers, shaded like the kit's rounded box (flats exactly flat, the
 * chamfers blending between them). No end caps: both ends are buried in
 * posts — unless `endCap` closes the last one. 16 triangles per span.
 */
function rail(m: SolidMesh, stations: readonly Vector3[], twistDeg: readonly number[], p: Paint, endCap?: Paint): void {
  const t = RAIL_T / 2;
  const h = RAIL_H / 2;
  const c = 0.03;
  // Section in (z, y), with the normal of the flat each point belongs to.
  const sec: [number, number, number, number][] = [
    [-t, -h + c, -1, 0],
    [-t, h - c, -1, 0],
    [-t + c, h, 0, 1],
    [t - c, h, 0, 1],
    [t, h - c, 1, 0],
    [t, -h + c, 1, 0],
    [t - c, -h, 0, -1],
    [-t + c, -h, 0, -1],
  ];
  const ring = (s: number): { p: Vector3[]; n: Vector3[] } => {
    const a = (twistDeg[s] * Math.PI) / 180;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const rot = (z: number, y: number): Vector3 => new Vector3(0, y * cs + z * sn, z * cs - y * sn);
    return { p: sec.map(([z, y]) => stations[s].add(rot(z, y))), n: sec.map(([, , nz, ny]) => rot(nz, ny)) };
  };
  let a = ring(0);
  for (let s = 1; s < stations.length; s++) {
    const b = ring(s);
    for (let k = 0; k < 8; k++) {
      const k1 = (k + 1) % 8;
      const out = a.n[k].add(a.n[k1]);
      quadOut(m, a.p[k], a.p[k1], b.p[k1], b.p[k], out, p, [a.n[k], a.n[k1], b.n[k1], b.n[k]]);
    }
    a = b;
  }
  if (endCap) {
    // Sawn end at the last station (the loose end of a fallen rail).
    const last = stations[stations.length - 1];
    const along = last.subtract(stations[stations.length - 2]);
    for (let k = 0; k < 8; k++) {
      const u = a.p[k];
      const v = a.p[(k + 1) % 8];
      if (Vector3.Dot(Vector3.Cross(u.subtract(last), v.subtract(last)), along) >= 0) m.tri(last, u, v, endCap);
      else m.tri(last, v, u, endCap);
    }
  }
}

interface ClothOptions {
  /** x of the cloth centre, y of its top corners, z of its plane. */
  x: number;
  top: number;
  z: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  cell: number;
  /** Which checker cells are white: (col + row) parity. */
  parity: number;
  /** How far one side hangs lower than the other. */
  skew: number;
  base: RGB;
  check: RGB;
}

/**
 * Cloth tied at its four corners, with a crisp checker: the pattern is the
 * quad grid itself (margin / checker cells / margin), never a texture. It
 * hangs like cloth, not like a board: both the top edge and the hem sag
 * between the ties and the middle bellies out toward the road. The two
 * sides share every vertex on the border and stand 4 mm apart inside, so
 * the cloth is one closed, paper-thin solid — no rim for the other side to
 * show through.
 */
function checkerCloth(m: SolidMesh, o: ClothOptions): void {
  const mx = (o.width - o.cols * o.cell) / 2;
  const my = (o.height - o.rows * o.cell) / 2;
  const xs: number[] = [0];
  for (let c = 0; c <= o.cols; c++) xs.push(mx + c * o.cell);
  xs.push(o.width);
  // A little more margin above the checker than below, as in the vision.
  const ys: number[] = [0];
  for (let r = 0; r <= o.rows; r++) ys.push(my * 0.9 + r * o.cell);
  ys.push(o.height);
  const NX = xs.length - 1;
  const NY = ys.length - 1;
  const start = m.mark();
  const BASE = paint(o.base, { gloss: 0.12, smooth: 80 });
  const CHECK = paint(o.check, { gloss: 0.12, smooth: 80 });
  const at = (i: number, j: number, sideSign: number): Vector3 => {
    const u = xs[i] / o.width;
    const v = ys[j] / o.height;
    const span = Math.sin(Math.PI * u);
    const sag = span * (0.035 + 0.03 * v);
    const belly = span * (0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, v * 1.15))) * 0.075;
    const border = i === 0 || i === NX || j === 0 || j === NY;
    return new Vector3(o.x - o.width / 2 + xs[i], o.top - ys[j] - sag - o.skew * (u - 0.5), o.z - belly + (border ? 0 : sideSign * 0.002));
  };
  for (const sideSign of [-1, 1]) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const inChecker = i >= 1 && i <= o.cols && j >= 1 && j <= o.rows;
        const p = inChecker && (i + j) % 2 === o.parity ? CHECK : BASE;
        const a = at(i, j, sideSign);
        const b = at(i + 1, j, sideSign);
        const c = at(i + 1, j + 1, sideSign);
        const d = at(i, j + 1, sideSign);
        // −z skin faces the road, +z skin faces the field. Both are split
        // along the SAME diagonal: the cells are not flat, and two skins
        // folded along different diagonals would pass through each other.
        // In two corner cells that diagonal would leave a triangle made of
        // border vertices only — the same triangle on both skins, back to
        // back in one plane. Those cells fold the other way.
        const other = (i === NX - 1 && j === 0) || (i === 0 && j === NY - 1);
        if (other) {
          if (sideSign < 0) {
            m.tri(a, b, d, p);
            m.tri(b, c, d, p);
          } else {
            m.tri(a, d, b, p);
            m.tri(b, d, c, p);
          }
        } else if (sideSign < 0) {
          m.tri(a, b, c, p);
          m.tri(a, c, d, p);
        } else {
          m.tri(a, c, b, p);
          m.tri(a, d, c, p);
        }
      }
    }
  }
  // Still at the four ties, freest in the middle of the hem — but capped low
  // (see SMALL_SWAY): the cloth hangs a few centimetres in front of the rails.
  const x0 = o.x - o.width / 2;
  m.setWind((p) => {
    const u = (p.x - x0) / o.width;
    const v = (o.top - p.y) / o.height;
    const fromTie = Math.min(1, Math.hypot(Math.min(u, 1 - u) * o.width, Math.min(Math.max(v, 0), Math.max(1 - v, 0)) * o.height) / 0.4);
    return fromTie ** 1.3 * SMALL_SWAY;
  }, start);
}

/** What the far model needs to know of one built segment: its very
 * colours and the few seeded shapes that change its outline. Filled by
 * `construct` without drawing anything from its random stream. */
interface FenceLook {
  post: RGB;
  rails: RGB[];
  cap: RGB;
  railY: number[];
  fallen: boolean;
  cloth?: RGB;
  /** Flower heads at the post foot (plain scheme). */
  blooms: { at: Vector3; petal: RGB }[];
}

function build(seed: number, scheme?: string): SolidMesh {
  return construct(seed, scheme);
}

function construct(seed: number, scheme?: string, look?: FenceLook): SolidMesh {
  const banner = scheme === 'banner';
  const r = rng(seed, 'd07-wood-fence');
  const hero = seed === 0;
  const tone = (c: RGB): RGB => (hero ? c : jitterColor(r, c, { hue: 4, lightness: 0.05, chroma: 0.08 }));
  // Odd seeds are sun-bleached: timber drifts toward a greyer tan.
  const bleach = hero ? 0 : seed % 2 === 1 ? r.range(0.15, 0.3) : r.range(0, 0.08);
  const weather = (c: RGB): RGB => mix(c, [0.72, 0.62, 0.55], bleach);
  const postColor = weather(tone(WOOD.post));
  const POST = timberPaint(postColor);
  const CAP: Paint = paint(hero ? IRON.cap : jitterColor(r, IRON.cap, { hue: 8, lightness: 0.04 }), { gloss: 0.3 });
  if (look) {
    look.post = postColor;
    look.cap = CAP.color;
  }
  const BOLT = ironPaint();
  const m = new SolidMesh();

  // Every fourth seed has a lower rail that has come loose at its far end
  // and dropped to the grass — the one clearly "worn" variant of the set.
  const fallen = !hero && !banner && seed % 4 === 3;
  // One seed in four has lost its cap: a plain post with a rounded top.
  const capless = !hero && seed % 4 === 2;
  const postH = (hero ? POST_H : POST_H * r.range(0.95, 1.08)) + (capless ? 0.06 : 0);

  // Rails (they run through the posts). Each sags a little at mid-span and
  // has its own slight twist, so a run of segments does not look ruled.
  const railY: number[] = [];
  RAIL_Y.forEach((y0, k) => {
    const y = y0 + (hero ? 0 : r.range(-0.015, 0.015));
    const RAIL = timberPaint(weather(tone(k === 0 ? WOOD.rail : mix(WOOD.rail, WOOD.plank, 0.5))));
    look?.rails.push(RAIL.color);
    const sag = hero ? 0.012 : r.range(0.008, 0.03);
    const twist = hero ? (k === 0 ? 2 : -2.5) : r.range(-5, 5);
    if (k === 1 && fallen) {
      // Still bolted to the capped post; the far end lies on the ground just
      // short of the end post, its sawn end showing.
      const end = new Vector3(POST_X - 0.16, RAIL_H / 2 - 0.01, -0.13);
      rail(m, [new Vector3(-POST_X, y, 0), end], [0, 14], RAIL, timberPaint(mix(RAIL.color, WOOD.pale, 0.5), 0.1));
    } else if (banner && k === 1) {
      // Half hidden behind the cloth: one straight span.
      rail(m, [new Vector3(-POST_X, y, 0), new Vector3(POST_X, y, 0)], [0, 0], RAIL);
    } else {
      rail(m, [new Vector3(-POST_X, y, 0), new Vector3(0, y - sag, 0), new Vector3(POST_X, y, 0)], [0, twist, 0], RAIL);
    }
    railY.push(y);
  });
  if (look) {
    look.railY = railY.slice();
    look.fallen = fallen;
  }

  // Capped post at the start of the segment (and at mid-span under a banner).
  const posts = banner ? [-POST_X, 0] : [-POST_X];
  // A bolt has dropped out of one joint on the weathered seeds.
  const missing = hero || seed % 2 === 0 ? -1 : r.int(0, posts.length * 2 - 1);
  posts.forEach((x, i) => {
    const h = i === 0 ? postH : postH - (hero ? 0.0 : r.range(0, 0.04));
    if (capless && i === 0) {
      roundedBox(m, { min: [x - POST_W / 2, -0.05, -POST_W / 2], max: [x + POST_W / 2, h, POST_W / 2], radius: 0.05, segments: 1, faces: { ny: null } }, POST);
    } else {
      timberPost(m, { x, height: h, width: POST_W, post: POST, cap: CAP });
    }
    railY.forEach((y, k) => {
      if (i * 2 + k === missing) return;
      // The rail sags toward mid-span: the mid post's bolts follow it.
      bolt(m, [x, y - (i === 1 && k === 0 ? 0.012 : 0), -POST_W / 2], [0, 0, -1], 0.032, BOLT);
    });
  });
  // End post: slimmer and shorter than a capped post, so that in a run it
  // disappears inside the next segment's.
  roundedBox(
    m,
    { min: [POST_X - END_W / 2, -0.05, -END_W / 2], max: [POST_X + END_W / 2, END_H, END_W / 2], radius: 0.035, segments: 1, faces: { ny: null } },
    timberPaint(mix(postColor, WOOD.dark, 0.12)),
  );

  if (banner) {
    // Seeds differ in the checker itself: 4 × 3, 3 × 2 big squares, 4 × 3
    // on the other parity, 4 × 2.
    const v = hero ? 0 : seed % 4;
    const cols = [4, 3, 4, 4][v];
    const rows = [3, 2, 3, 2][v];
    const cell = [0.15, 0.19, 0.15, 0.17][v];
    const width = 0.86;
    const height = 0.66;
    const top = railY[0] + RAIL_H / 2 - 0.005;
    const z = -RAIL_T / 2 - 0.022;
    const x = -POST_X / 2;
    checkerCloth(m, {
      x,
      top,
      z,
      width,
      height,
      cols,
      rows,
      cell,
      parity: v >> 1,
      skew: hero ? 0 : r.range(-0.035, 0.035),
      base: (() => {
        const c = hero ? CLOTH.teal : jitterColor(r, CLOTH.teal, { hue: 5, lightness: 0.03 });
        if (look) look.cloth = c;
        return c;
      })(),
      check: CLOTH.white,
    });
    // Ties: a dark cord from each corner of the cloth round to the side of
    // the post it hangs from.
    const TIE = paint(mix(IRON.cap, CLOTH.teal, 0.25), { gloss: 0.15 });
    for (const sx of [-1, 1]) {
      const postFace = x + sx * (POST_X / 2 - POST_W / 2 + 0.02);
      for (const y of [top, top - height]) {
        cylinder(m, { from: [x + sx * (width / 2 - 0.03), y - (y === top ? 0.018 : -0.018), z - 0.004], to: [postFace, y + (y === top ? 0.02 : 0.05), -POST_W / 2 + 0.035], radius: 0.014, sides: 3, caps: false }, TIE);
      }
    }
  } else {
    // Flower clump at the foot of the capped post, on the road side. It
    // stays inside the depth of the post cap so both schemes share one
    // bounding box.
    const s = m.mark();
    const side = hero ? 1 : r.sign();
    const foot = new Vector3(-POST_X + side * (hero ? 0.3 : r.range(0.26, 0.5)) + (side < 0 ? 0.24 : 0), 0, -0.03);
    // The clump must not hang off the start of the segment.
    foot.x = Math.max(foot.x, -POST_X + 0.25);
    const GREEN = mix(FOLIAGE.lime, FLOWERS.stem, 0.45);
    const blooms = hero ? 2 : seed % 3;
    for (let i = 0; i < blooms; i++) {
      // Heads stay clear of the lower rail: below it and out toward the road.
      const lean = new Vector3((i === 0 ? -0.07 : 0.11) + (hero ? 0 : r.range(-0.03, 0.03)), i === 0 ? 0.25 : 0.18, i === 0 ? -0.05 : -0.055);
      const head = foot.add(lean);
      stem(m, foot.add(new Vector3(0, -0.03, 0)), head, 0.012);
      const petal = hero || r.chance(0.7) ? FLOWERS.petal : FLOWERS.center;
      look?.blooms.push({ at: head.clone(), petal });
      flower(m, {
        at: head,
        facing: new Vector3(lean.x * 2.2, 1, -0.6),
        radius: i === 0 ? 0.085 : 0.072,
        petal,
        center: hero ? FLOWERS.center : undefined,
        spin: i * 40,
      });
    }
    const blades: [number, number, number][] = [
      [-0.17, 0.2, 0.02],
      [0.19, 0.16, 0.03],
      [0.02, 0.23, 0.05],
    ];
    for (const [dx, dy, dz] of blades) {
      blade(m, { root: foot.add(new Vector3(dx * 0.2, -0.03, dz * 0.5)), tip: foot.add(new Vector3(dx, dy, dz)), width: 0.07, color: GREEN });
    }
    m.setWind((p) => Math.min(1, Math.max(0, p.y / 0.3)) ** 1.5 * SMALL_SWAY, s);
  }
  return m;
}

/**
 * The far model (diorama view): the capped start post (its cap overhanging
 * like the near cap), the two rails over the whole pitch — the lower one
 * lying in the grass on the fallen seeds — and
 *  - plain scheme: the flower clump at the post foot, in its petal colour;
 *  - banner scheme: the teal cloth with white checks printed through on both
 *    faces, hung at the depth the near cloth bellies to, and (40) the mid
 *    post.
 * Rails are 4-triangle ridges (quest, and the banner on 40) or, on the
 * plain fence at 40, boxes with a top; the plain fence at 40 also has its
 * end post. Colours are this segment's very own (`construct` records them).
 * Budgets: plain 20–24 on quest (fallen: 4-sided lying rail), 35–37 on 40;
 * banner 27 on quest (3-sided flat-topped post, 2 × 2 checks a face), 46 on
 * 40 (3 × 2 checks a face).
 */
function buildFar(seed: number, scheme: string | undefined, target: number): SolidMesh {
  const look: FenceLook = { post: WOOD.post, rails: [], cap: IRON.cap, railY: [...RAIL_Y], fallen: false, blooms: [] };
  const near = construct(seed, scheme, look);
  const banner = scheme === 'banner';
  const rich = target >= 36;
  let top = 0;
  const P = near.positions;
  for (let i = 0; i < P.length; i += 3) if (Math.abs(P[i] + POST_X) < 0.15) top = Math.max(top, P[i + 1]);
  const capless = seed !== 0 && seed % 4 === 2;
  const capHalf = POST_W / 2 + 0.025;
  const POST = paint(look.post, { gloss: 0.2, smooth: 0 });
  const CAP = paint(look.cap, { gloss: 0.3, smooth: 0 });
  const m = new SolidMesh();
  const fullCap = capHeight(POST_W);
  // A capped post's top: the start post's, or — on a capless seed, whose
  // start post is 6 cm taller and has no cap — the near mid post's.
  const cappedTop = capless ? top - 0.06 + fullCap : top;
  const post = (x: number, flat: Paint | null): void =>
    flat
      ? farPrism(m, { at: [x, 0, 0], y0: -0.05, y1: top, sides: 4, halfWidth: POST_W / 2, top: flat }, POST)
      : farPrism(m, { at: [x, 0, 0], y0: -0.05, y1: cappedTop - fullCap, sides: 4, halfWidth: POST_W / 2, cap: { height: fullCap, paint: CAP, halfWidth: capHalf } }, POST);
  if (banner && !rich) {
    // 3-sided, a flat face to the road, its back corner at the cap's depth.
    farPrism(m, { at: [-POST_X, 0, 0], y0: -0.05, y1: top, sides: 3, radius: capHalf, top: capless ? POST : CAP }, POST);
  } else post(-POST_X, capless ? POST : null);
  // The mid post (40): flat-topped to stay in budget — unless the start
  // post is the capless one, then the mid post keeps the overhanging cap
  // (the near mid post is always capped).
  if (banner && rich) post(0, capless ? null : CAP);
  look.railY.forEach((y, k) => {
    const RAIL = paint(look.rails[k] ?? WOOD.rail, { gloss: 0.2, smooth: 0 });
    if (k === 1 && look.fallen) {
      // Bolted at the capped post, its far end in the grass (as built).
      const end = new Vector3(POST_X - 0.16, RAIL_H / 2 - 0.01, -0.13);
      farStick(m, { path: [[-POST_X, y, 0], end], radius: [RAIL_H * 0.42, RAIL_H * 0.42], sides: 4, startDeg: 45 }, RAIL);
    } else if (rich && !banner) farBox(m, [-POST_X, y - RAIL_H / 2, -RAIL_T / 2], [POST_X, y + RAIL_H / 2, RAIL_T / 2], RAIL, { bottom: true, ends: true });
    // 4 triangles: a ridge, so the rail shows from above and along the run
    // (the diorama looks down on it), not two vertical cards.
    else farRidge(m, -POST_X, POST_X, y, RAIL_H / 2, RAIL_T * 0.6, RAIL);
  });
  // The plain end post (40): inside a run it is buried in the next
  // segment's capped post, on the last segment it closes the fence, as the
  // near one does. 10 triangles; no room for it on quest or under a banner.
  if (rich && !banner) {
    farPrism(m, { at: [POST_X, 0, 0], y0: -0.05, y1: END_H, sides: 4, halfWidth: END_W / 2, top: paint(mix(look.post, WOOD.dark, 0.12), { gloss: 0.2, smooth: 0 }) }, paint(mix(look.post, WOOD.dark, 0.12), { gloss: 0.2, smooth: 0 }));
  }
  if (!banner && look.blooms.length) {
    // The clump: a low 3-sided mound over the heads in the first head's
    // petal colour, reaching as far toward the road as the blooms do.
    const at = look.blooms.reduce((a, b) => a.add(b.at), new Vector3()).scale(1 / look.blooms.length);
    const front = Math.min(...look.blooms.map((b) => b.at.z)) - 0.075;
    const r = Math.max(0.07, at.z - front);
    const apex = new Vector3(at.x, Math.max(...look.blooms.map((b) => b.at.y)) + 0.03, at.z);
    const base = [0, 1, 2].map((k) => {
      const a = Math.PI + (k / 3) * Math.PI * 2;
      return new Vector3(at.x + Math.sin(a) * r, -0.03, at.z + Math.cos(a) * r);
    });
    const PETAL = paint(look.blooms[0].petal, { gloss: 0.3, smooth: 0 });
    const inside = new Vector3(at.x, -0.5, at.z);
    for (let k = 0; k < 3; k++) outTri(m, apex, base[k], base[(k + 1) % 3], inside, PETAL);
  }
  if (banner) {
    const width = 0.86;
    const height = 0.66;
    const clothTop = look.railY[0] + RAIL_H / 2 - 0.005;
    // The near cloth hangs at z = −0.072 and bellies 7.5 cm toward the road
    // across its middle: the far card hangs flat at the belly's depth.
    const z = -RAIL_T / 2 - 0.022 - 0.065;
    const v = seed === 0 ? 0 : seed % 4;
    farCheckerCard(m, {
      origin: [-POST_X / 2 - width / 2, clothTop, z],
      u: [1, 0, 0],
      v: [0, -1, 0],
      n: [0, 0, -1],
      width,
      height,
      cols: rich ? 3 : 2,
      rows: 2,
      parity: v >> 1,
      margin: 0.09,
      back: true,
      field: paint(look.cloth ?? CLOTH.teal, { gloss: 0.25, smooth: 0 }),
      check: paint(CLOTH.white, { gloss: 0.25, smooth: 0 }),
    });
  }
  return m;
}

function colliders(): ColliderSpec[] {
  return [{ shape: 'box', center: [0, TOP / 2, 0], half: [LENGTH / 2, TOP / 2, POST_W / 2] }];
}

const asset: PropAsset = {
  kind: 'prop',
  id: 'd07-wood-fence',
  name: 'Wood fence segment',
  category: 'dressing',
  // x: the 2.4 m pitch plus half a post at either end; y includes the 5 cm
  // skirt below ground; z: post cap, plus the belly of the banner.
  size: { x: LENGTH + POST_W / 2 + END_W / 2 + 0.025, y: TOP + 0.05, z: POST_W + 0.08 },
  variants: 4,
  schemes: ['plain', 'banner'],
  build,
  buildFar,
  colliders,
  wind: true,
  triBudget: 400,
  reference: { sheet: 'design-documents/gameplay-vision/village-race-gameplay-vision.png' },
};

export default asset;
