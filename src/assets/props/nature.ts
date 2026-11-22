import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  DEG,
  adjustOklch,
  anyPerpendicular,
  applyMatrix,
  bezierPath,
  catmullRomPath,
  clamp,
  compose,
  hash3,
  loopNormal,
  mixOklab,
  paint,
  pathFrames,
  rng,
  rotation,
  scaling,
  smoothstep,
  toV3,
  toV3s,
  translation,
} from '../../gfx/solid';
import type { Paint, RGB, Rng, SolidMesh, Vec3 } from '../../gfx/solid';
import { BARK, FOLIAGE, STONE, SUCCULENT } from '../palette';

/**
 * NATURE KIT — shared helpers for every tree, plant and rock of the
 * environment design pack. Read `t01-rally-oak.asset.ts` (tree) and
 * `r01-shoulder-boulder.asset.ts` (rock) next to this file: they are the
 * worked examples and set the standard.
 *
 * HOW TO BUILD A NATURE PROP
 *
 *   build(seed) {
 *     const v = variant(seed, 'v01-puff-bush');           // 1. seeded variation
 *     const leaves = foliageTones(v);                     // 2. palettes, already shifted for this seed
 *     const bark = barkTones(v);
 *     const m = new SolidMesh();
 *     limb(m, { path: […], radius: […], sides: 5 }, barkPaint(bark, { seed })); // 3. structure (shaded per flute)
 *     canopy(m, { blobs: […], seed }, leaves);            // 4. masses (shaded per facet)
 *     lean(m, v.num(4, 6), v.range(20, 0, 360));          // 5. pose
 *     fitSize(m, v.size(asset.size), { recenter: false });// 6. land exactly on the design's box
 *     sway(m, { from: 0.4, to: 1.3 });                    // 7. wind weights, LAST
 *     return m;                                           //    (no bakeAO: the assembler bakes)
 *   }
 *
 * THE RULES THESE HELPERS ENCODE
 *
 *  - SEED 0 IS THE DESIGN. Every random choice goes through a `Variant`:
 *    `v.num(hero, spread)`, `v.range(hero, lo, hi)`, `v.int(hero, lo, hi)`,
 *    `v.pick(hero, options)` return the HERO value for seed 0 and a draw for
 *    every other seed, so the sheet's numbers sit in the code next to the
 *    range the variants may wander in. Never call an Rng for something seed
 *    0 should fix. Seeds ≥ 1 must differ VISIBLY: vary counts (blobs,
 *    blades, chunks), arrangement, lean and proportions — not just a
 *    two-degree wobble — and let `fitSize(m, v.size(size))` hold the bounds.
 *  - COLOUR VARIES AS ONE MOOD PER PLANT, not per part: `v.mood` is a
 *    (hue, lightness, chroma) shift that the `…Tones` functions apply to a
 *    whole palette, so a "warm" oak has warm tops AND warm undersides and
 *    still reads as an oak. Moods cycle through distinct corners (warm-bright,
 *    cool-deep, …) so neighbouring seeds never look alike.
 *  - FACETS, NOT NOISE. Foliage masses and rocks are `Polytope`s: convex
 *    solids carved by planes. Every face is one broad polygon — the
 *    "medium-size planes" of the style guide — with ONE flat colour chosen
 *    from its normal (warm top / cool underside, cream top plane / lavender
 *    flank). Compare a hull of scattered points, which gives triangles.
 *    Wood is the same idea along a path: a limb is a prism of long clean
 *    FLUTES, one tone per flute — never a ring-twisted antiprism with a tone
 *    per triangle (wrung rope with confetti on it).
 *  - A FACE COSTS FOUR TRIANGLES wherever it is, so put faces where they are
 *    seen: a canopy mass crowds its planes toward the outside of the cluster
 *    (`LumpOptions.focus`) and shows 12–14 facets a side where an even lump
 *    of the same budget shows 8 — the difference between leaves and a d12.
 *  - A HERO IS AUTHORED, SCATTER IS ROLLED. Where the design sheet dictates
 *    the planes (a landmark rock's top plane, its ridge, which walls are
 *    tall) carve them by compass with `Polytope.block` + `wall` and let the
 *    seed nudge each one; `mound` / `rockChunk` roll the planes for you and
 *    are right for pebbles, slabs and secondary lumps.
 *  - JOINTS: a limb starts on its parent's centre line at about half the
 *    parent's radius and leaves it at an acute angle in ONE arc (`bough`);
 *    it climbs at 30° or more (`climb` ≥ 0.6) and arrives heading up and
 *    out. Level = a beam, a knee-and-elbow polyline = a pipe.
 *  - PALETTE DISCIPLINE (see palette.ts): the "shadow" / "deep" entries are
 *    not albedos for shaded faces — the shader shades. Undersides here are a
 *    HUE shift with a small value step.
 *  - PARTS ARE SUNK INTO EACH OTHER. Blobs overlap by a third of their
 *    radius, branches end inside blobs, roots start inside the trunk, rock
 *    chunks share volume. `canopy` and `emitRock` drop faces buried inside a
 *    neighbouring convex piece (exact test), so overlap costs no triangles.
 *  - GROUND: origin = ground contact centre, a skirt of 5–10 cm below y = 0.
 *    The lab measures the box INCLUDING the skirt; `fitSize` keeps tiny
 *    props inside the 8 % band.
 *  - WIND is ONE function of position for the whole plant (`sway`), called
 *    last, so a branch tip and the blob it sits in move together. Weight 1
 *    sways ±0.22 m; `sway` scales the maximum with the plant's height.
 *  - THIN THINGS HAVE TWO SIDES. The toy material culls back faces: `blade`,
 *    `leaf`, `frond` and `flower` always emit both sides (or a closed
 *    solid), with the underside in the cooler tone.
 *  - Paint: foliage masses, rock and petals are faceted (`smooth: 0`) and
 *    matte (gloss ≈ 0.2 / 0.08 / 0.35); bark is matte (0.1) with a 16°
 *    crease angle, so a flute is one plane and the edges between flutes stay
 *    crisp; blades, leaves and fronds are smooth toy shapes (gloss ≈ 0.35)
 *    with a crisp fold line.
 *  - BUDGETS ARE HARD (tree 1 400, large rock 300, low plant 350, small rock
 *    80 triangles): these are instanced by the hundreds on a Quest 3. Each
 *    helper's comment says what it costs.
 *
 * RECIPES (which helper is which design; T01 and R01 are the built examples,
 * the rest are starting points)
 *   T01 oak      limb (trunk, with the crown limb as its continuation) + `bough`
 *                arcs for the Y and the branches + rootFlare, all in
 *                barkPaint; canopy (8 masses, 22–40 planes) → t01-rally-oak.asset.ts
 *   T02 pine     limb + rootFlare, four `skirt` tiers (the top one `topRadius: 0`),
 *                jade tones: foliageTones(v, { top, mid, under })
 *   T03 palm     limb with `rough: 0.1` (ring steps: repeat a path point with two
 *                radii), 8–10 `frond`s on `archPath`s with fold + thickness, rib colour
 *   V01 bush     canopy (5–6 small blobs, `flat: 1`), a few short limbs under it
 *   V02 grass    `blade` on `archPath`, fold −0.35, base → tip gradient
 *   V03 fern     `frond` with fold 0 / thickness 0 (40 triangles a frond)
 *   V04 rosette  `leaf` with thickness, fold and `edge` colour (succulentTones)
 *   V05 blooms   `flower` on thin `limb` stems, `leaf` at the base
 *   R01 boulder  AUTHORED main mass: Polytope.block + ten `wall`s + waist planes on
 *                the tall side + two roof planes (`cut`), `bevel`, `clip`; then
 *                `crack`; rockChunk shoulders sunk half into it → r01-shoulder-boulder.asset.ts
 *   R02 fin      a tall narrow rockChunk with `top: { tilt: 55 }` and `crown: 0.4`
 *                (the cream is the steep face), `groove` opening upward from mid-height
 *   R03 terrace  rockChunk(low, level top), then `slice` + `scaleAbout` twice
 *   S01–S05      rockChunk(small, skirt ≈ 0.03): wedge = steep top tilt,
 *                slab = a low chunk, cluster = three separate chunks, broken
 *                chunk = groove. No colliders, rim [0.01, 0.04].
 *
 * CONTENTS
 *   variation   variant, Variant, tint
 *   palettes    foliageTones, barkTones, stoneTones, succulentTones
 *   solids      Polytope (lump, mound, block + wall, cut, groove, crack, clip, bevel, slice, surface, …), faceShape
 *   foliage     canopy, skirt, foliageColor, shadeFoliage
 *   wood        limb, bough, climb, alongPath, pathClearance, rootFlare, barkPaint, barkColor, shadeBark
 *   rock        rockChunk, emitRock, stonePaint, BOULDER_RINGS
 *   leaves      archPath, blade, leaf, frond, flower
 *   finishing   lean, fitSize, fitPoint, sway
 */

// ---------------------------------------------------------------------------
// Variation

/** A colour mood in unit amounts (−1 … 1); scaled per material by a
 * `ToneAmp`. hue −1 = WARMER, +1 = cooler, whatever the material. */
export interface ColorShift {
  hue: number;
  lightness: number;
  chroma: number;
}

/** How far a unit mood moves one material: hue in degrees (OKLCH; the sign
 * makes "−1" the warm direction for that material), lightness on the 0..1
 * perceptual scale, chroma as a fraction. */
export interface ToneAmp {
  hue: number;
  lightness: number;
  chroma: number;
}

// The hue amplitudes are deliberately SMALL: lit by the warm sun, a lime
// canopy 11° warmer reads lemon yellow, bark 8° redder reads tomato and stone
// 12° warmer reads pink — a different species / rock type next to the hero.
// Variants are told apart by silhouette first; colour only has to break the
// repetition.
/** Leaves: warm = toward yellow-lime, cool = toward jade. */
export const FOLIAGE_AMP: ToneAmp = { hue: 6, lightness: 0.04, chroma: 0.1 };
/** Bark: warm = redder cinnamon, cool = ochre-brown. */
export const BARK_AMP: ToneAmp = { hue: 4, lightness: 0.04, chroma: 0.1 };
/** Stone: warm = mauve, cool = blue slate (negative: lavender's warm side is
 * the HIGHER hue angle). */
export const STONE_AMP: ToneAmp = { hue: -5, lightness: 0.035, chroma: 0.12 };
/** Petals: warm = orange-coral, cool = pink. */
export const FLOWER_AMP: ToneAmp = { hue: -14, lightness: 0.04, chroma: 0.1 };

// Distinct corners of the mood space. Seeds walk through them in order, so
// seeds 1…6 are guaranteed to differ from the hero and from each other; a
// little seeded jitter on top keeps seed 7 from repeating seed 1 exactly.
const MOODS: readonly ColorShift[] = [
  { hue: -1.0, lightness: 0.7, chroma: 0.4 }, // warm, bright
  { hue: 1.0, lightness: -0.8, chroma: -0.1 }, // cool, deep
  { hue: -0.6, lightness: -0.5, chroma: 0.7 }, // warm, deep, saturated
  { hue: 0.7, lightness: 0.9, chroma: -0.6 }, // cool, pale
  { hue: -0.3, lightness: -0.1, chroma: -1.0 }, // muted
  { hue: 0.35, lightness: 0.35, chroma: 0.9 }, // vivid
];

/**
 * One prop variant: the seed, its random stream and its colour mood. The
 * accessors take the HERO value first — what seed 0 (the design sheet) uses —
 * then the range the other seeds draw from.
 */
export class Variant {
  readonly seed: number;
  /** Seed 0: reproduce the design exactly. */
  readonly hero: boolean;
  /** The raw stream, for choices that have no hero value (facet jitter…). */
  readonly r: Rng;
  /** Colour mood of this variant; all zero for the hero. */
  readonly mood: ColorShift;

  constructor(seed: number, r: Rng, mood: ColorShift) {
    this.seed = seed;
    this.hero = seed === 0;
    this.r = r;
    this.mood = mood;
  }

  /** `hero`, or a triangular draw in hero ± spread (most near the design,
   * the tails still clearly different). */
  num(hero: number, spread: number): number {
    return this.hero ? hero : hero + (this.r.next() + this.r.next() - 1) * spread;
  }

  /** `hero`, or uniform in [lo, hi) — for things with no "typical" value
   * (which way a tree leans, where the big blob sits). */
  range(hero: number, lo: number, hi: number): number {
    return this.hero ? hero : this.r.range(lo, hi);
  }

  /** `hero`, or a uniform integer in [lo, hi] (counts). */
  int(hero: number, lo: number, hi: number): number {
    return this.hero ? hero : this.r.int(lo, hi);
  }

  /** `hero`, or one of `options`. */
  pick<T>(hero: T, options: readonly T[]): T {
    return this.hero ? hero : this.r.pick(options);
  }

  /** `hero`, or true with probability p. */
  chance(hero: boolean, p: number): boolean {
    return this.hero ? hero : this.r.chance(p);
  }

  /** Independent sub-stream with the same mood: fork one per feature
   * (`v.fork('canopy')`) so a change in the trunk cannot reshuffle the
   * leaves. */
  fork(label: string): Variant {
    return new Variant(this.seed, this.r.fork(label), this.mood);
  }

  /** This variant's mood applied to a colour. */
  tint(color: RGB, amp: ToneAmp, strength = 1): RGB {
    return tint(color, this.mood, amp, strength);
  }

  /**
   * The design's bounding box for this variant: exact for the hero, for
   * other seeds a uniform size factor (± `scale`) times a small per-axis
   * proportion change (± `stretch`). Defaults keep every seed well inside
   * the lab's 30 % band. Feed it to `fitSize`.
   */
  size(size: { x: number; y: number; z: number }, scale = 0.1, stretch = 0.07): { x: number; y: number; z: number } {
    if (this.hero) return { ...size };
    const r = this.r.fork('size');
    const s = 1 + (r.next() * 2 - 1) * scale;
    const k = (): number => s * (1 + (r.next() * 2 - 1) * stretch);
    return { x: size.x * k(), y: size.y * k(), z: size.z * k() };
  }
}

/** Start a variant: `const v = variant(seed, 't01-rally-oak')`. */
export function variant(seed: number, id: string): Variant {
  const r = rng(seed, id);
  if (seed === 0) return new Variant(0, r, { hue: 0, lightness: 0, chroma: 0 });
  const base = MOODS[(Math.abs(Math.trunc(seed)) - 1) % MOODS.length];
  const j = r.fork('mood');
  const wobble = (): number => (j.next() * 2 - 1) * 0.22;
  return new Variant(seed, r, {
    hue: clamp(base.hue + wobble(), -1.15, 1.15),
    lightness: clamp(base.lightness + wobble(), -1, 1),
    chroma: clamp(base.chroma + wobble(), -1, 1),
  });
}

/** Shift a colour by a mood (OKLCH — perceptually even, stays in family). */
export function tint(color: RGB, mood: ColorShift, amp: ToneAmp, strength = 1): RGB {
  return adjustOklch(
    color,
    mood.lightness * amp.lightness * strength,
    1 + mood.chroma * amp.chroma * strength,
    mood.hue * amp.hue * strength,
  );
}

// ---------------------------------------------------------------------------
// Palettes

/** Leaf mass colours by facet direction. */
export interface FoliageTones {
  /** Sun-facing top facets: warm yellow-lime. */
  top: RGB;
  /** Flanks: the species' main green. */
  mid: RGB;
  /** Undersides and low inner facets: cooler, a little deeper. */
  under: RGB;
  /** Facets that look into a neighbouring mass (the creases of a canopy):
   * a material shade tone, mixed in by how closed-in the facet is. */
  deep: RGB;
}

/**
 * Leaf tones for this variant. Defaults are the broadleaf set of the vision
 * (oak, bush, palm): yellow-lime tops over lime flanks over a jade-leaning
 * underside. Pass your species' hero colours to override any of them —
 * e.g. a pine: `foliageTones(v, { top: mixOklab(FOLIAGE.jade, FOLIAGE.lime, 0.4), mid: FOLIAGE.jade, under: mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.5) })`.
 */
export function foliageTones(v: Variant, hero: Partial<FoliageTones> = {}, strength = 1): FoliageTones {
  const top = hero.top ?? mixOklab(FOLIAGE.lime, FOLIAGE.highlight, 0.55);
  // Pure lime on the flanks turns olive-khaki on the side the sun does not
  // reach (yellow-green albedo × cool fill); a third of jade keeps the shade
  // side a fresh green and costs the lit side nothing.
  const mid = hero.mid ?? mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.32);
  // The sheet's undersides are a saturated mid green on the way to jade.
  // (Pure jade is shaded twice — albedo and shader — and reads near-black
  // under a canopy; much less than this and the shade side goes mint.)
  const under = hero.under ?? adjustOklch(mixOklab(FOLIAGE.lime, FOLIAGE.jade, 0.52), 0, 1.1);
  const deep = hero.deep ?? mixOklab(FOLIAGE.jade, FOLIAGE.deepTeal, 0.15);
  // The top tone already sits at the yellow edge of the family: a full warm
  // shift would push it out of "leaf" into "autumn". Half for the tops. And
  // leaves may get deeper or more vivid, but only a little paler: a pale,
  // greyed canopy is pastel mint, a different plant.
  const mood: ColorShift = { hue: v.mood.hue, lightness: Math.min(v.mood.lightness, 0.5), chroma: Math.max(v.mood.chroma, -0.3) };
  const warm = mood.hue < 0;
  return {
    top: tint(top, { ...mood, hue: mood.hue * (warm ? 0.5 : 1) }, FOLIAGE_AMP, strength),
    mid: tint(mid, mood, FOLIAGE_AMP, strength),
    under: tint(under, mood, FOLIAGE_AMP, strength),
    deep: tint(deep, mood, FOLIAGE_AMP, strength),
  };
}

export interface BarkTones {
  base: RGB;
  /** Upward and sun-catching facets. */
  light: RGB;
  /** Root crotches and the odd deep facet — a HALF step toward the
   * palette's shadow, never the shadow itself. */
  dark: RGB;
}

export function barkTones(v: Variant, hero: Partial<BarkTones> = {}, strength = 1): BarkTones {
  const base = hero.base ?? BARK.base;
  const light = hero.light ?? mixOklab(BARK.base, BARK.highlight, 0.6);
  const dark = hero.dark ?? mixOklab(BARK.base, BARK.shadow, 0.55);
  return {
    base: v.tint(base, BARK_AMP, strength),
    light: v.tint(light, BARK_AMP, strength),
    dark: v.tint(dark, BARK_AMP, strength),
  };
}

export interface StoneTones {
  /** Cream sunlit top planes. */
  top: RGB;
  /** Chamfer facets between top and flank: cream bleeding into lavender. */
  rim: RGB;
  /** Flanks: lavender. */
  side: RGB;
  /** Second flank tone (slate blue) so neighbouring planes separate. */
  alt: RGB;
  /** Third flank tone (mauve), used on a minority of planes. */
  warm: RGB;
  /** Faces that lean toward the ground. */
  low: RGB;
  /** Groove and split walls only. */
  crevice: RGB;
}

export function stoneTones(v: Variant, hero: Partial<StoneTones> = {}, strength = 1): StoneTones {
  // The warm sun pulls lit lavender toward mauve-pink and its shade toward
  // grey-plum; the sheet and the vision are BLUE-lavender lit with violet
  // shade. The flank albedos therefore sit a few degrees on the blue side of
  // the palette entries with a little more chroma — same family, measured
  // against the lit result, not the swatch.
  const cool = (c: RGB): RGB => adjustOklch(c, 0, 1.14, -5);
  const side = hero.side ?? cool(STONE.base);
  const top = hero.top ?? STONE.upperFace;
  const t = (c: RGB): RGB => v.tint(c, STONE_AMP, strength);
  return {
    // The cream keeps its warmth in every mood: only a third of the shift.
    top: v.tint(top, STONE_AMP, strength * 0.35),
    // A pale, slightly greyed lavender with NO cream in it: mixed toward
    // cream it turns pink and rings the top plane like a cut gem's bevel.
    rim: t(hero.rim ?? adjustOklch(side, 0.07, 0.88)),
    side: t(side),
    alt: t(hero.alt ?? mixOklab(side, cool(STONE.midSlate), 0.75)),
    warm: t(hero.warm ?? adjustOklch(side, 0.005, 1.04, 4)),
    // palette.ts: lower faces in base / midSlate — the shader does the dark.
    // Measured on the sheet and the vision: the foot of a rock is a deeper,
    // more saturated violet than its flanks (#716195 under #ABA1D0), more
    // than the baked occlusion alone gives.
    low: t(hero.low ?? adjustOklch(mixOklab(cool(STONE.midSlate), STONE.shadow, 0.28), 0, 1.12)),
    // Walls of a groove are in shade already (cast shadow and baked
    // occlusion both land there): a sixth of the way to the palette's shadow
    // reads as a crevice, a third already as a drawn black line.
    crevice: t(hero.crevice ?? mixOklab(cool(STONE.base), STONE.shadow, 0.16)),
  };
}

export interface SucculentTones {
  base: RGB;
  under: RGB;
  edge: RGB;
}

export function succulentTones(v: Variant, strength = 1): SucculentTones {
  return {
    base: v.tint(SUCCULENT.base, FOLIAGE_AMP, strength),
    under: v.tint(mixOklab(SUCCULENT.base, SUCCULENT.shadow, 0.5), FOLIAGE_AMP, strength),
    edge: v.tint(SUCCULENT.edge, FOLIAGE_AMP, strength),
  };
}

export interface FlowerTones {
  petal: RGB;
  /** Petal underside / base of the petal. */
  petalDeep: RGB;
  center: RGB;
  stem: RGB;
}

// ---------------------------------------------------------------------------
// Polytope — convex solids carved by planes

/** One polygonal face. `points` run so that (p1 − p0) × (p2 − p0) points
 * along `normal` (out of the solid) — the SolidMesh winding rule. */
export interface PolyFace {
  points: Vector3[];
  normal: Vector3;
  /** Which operation made it: 'lump', 'cut', 'groove', 'inner', or the tag
   * passed to `cut` / `bevel` ('top', 'rim', 'flank', 'shoulder', 'crown',
   * 'base' come from the rock helpers). Shading functions key on it. */
  tag: string;
}

export interface LumpOptions {
  /** Half extents of the finished lump (it is normalised to fill exactly
   * this box, centred on the origin), or one number for a ball. */
  radii: Vec3 | number;
  /** Number of carving planes ≈ number of faces (default 20). 12–16 = a
   * small bush blob, 22–34 = a tree canopy mass. Triangles ≈ 4 × facets − 12. */
  facets?: number;
  seed?: number;
  /** 0 = regular, geodesic-looking … 1 = planes pointing every which way
   * (default 0.5). */
  jitter?: number;
  /** 0 = every plane touches the ellipsoid (even facets) … 1 = some planes
   * bite deep, giving unequal large faces (default 0.4). */
  dent?: number;
  /** Crowd the planes toward this direction (in the lump's own frame): the
   * side people see gets many medium facets, the far side a few big ones.
   * Triangles follow the face count, so this is how a foliage mass shows
   * twice the facets for the same budget. */
  focus?: Vec3;
  /** How strongly, 0..0.8 (default 0.45 ≈ three planes in four on the
   * `focus` hemisphere). */
  bias?: number;
}

/** One band of planes of a mound. */
export interface MoundRing {
  /** Number of planes around. */
  count: number;
  /** How far the planes lean in from vertical, degrees (0 = a wall, 90 = a
   * lid). */
  pitch: number;
  /** Height where the band starts, as a fraction of the mound's height. */
  at: number;
  /** Face tag (default 'flank'). */
  tag?: string;
}

// cos 26°: the least angle between a mound band and the sloping top plane.
const COS_TOP_CLEAR = Math.cos(26 * DEG);

/** A boulder: a steep foot, a leaning waist, chamfered shoulders and a few
 * near-flat crown planes — ~29 faces ≈ 100 triangles before the top plane.
 * The pitches are what a BROAD stone gets; where a chunk is tall for its
 * footprint it cannot lean that much and still reach its height, so `mound`
 * steepens the bands there (see there). Under a sloping top the near-flat
 * crown planes drop out on the downhill side by themselves. For a 300-
 * triangle landmark boulder see r01-shoulder-boulder, which authors its
 * main mass plane by plane instead (`Polytope.block` + `wall`). */
export const BOULDER_RINGS: readonly MoundRing[] = [
  { count: 9, pitch: 15, at: 0 },
  { count: 8, pitch: 34, at: 0.42 },
  { count: 7, pitch: 54, at: 0.7, tag: 'shoulder' },
  { count: 5, pitch: 74, at: 0.9, tag: 'crown' },
];

export interface MoundOptions {
  /** [half width, height, half depth] of the finished mound. */
  radii: Vec3;
  /** The bands of planes, from the ground up (default `BOULDER_RINGS`). */
  rings?: readonly MoundRing[];
  seed?: number;
  /** 0 = evenly spaced planes … 1 = very irregular (default 0.5). */
  jitter?: number;
  /** 0 = every plane touches the profile … 1 = some bite deep (default 0.5). */
  dent?: number;
  /** How far the flanks continue below y = 0 (default 0.08). */
  skirt?: number;
  /** Least radius of the level cross-section left at full height, as a
   * fraction of the footprint (default 0.2). The bands are steepened until
   * the dome keeps this much; raise it for a blockier stone with a larger
   * top. */
  crown?: number;
  /**
   * The sloping top plane the profile HANGS FROM (`rockChunk` passes its
   * `top` here): `tilt` degrees down toward compass direction `toward`.
   * Every band then starts at its fraction of the LOCAL height under that
   * plane instead of the full height, so the low side of a wedge is a short
   * wall under a broad top plane and the high side a tall one — the same
   * stone all round. Bands that would lie within ~26° of the top plane are
   * left out (they would shave the top plane away instead of chamfering it;
   * `bevel` makes the chamfer there).
   */
  slope?: { tilt: number; toward: number };
  /** With `slope`: how far a band may run in under the top plane before it
   * meets it, as a fraction of the footprint radius (default 0.24). This is
   * what guarantees the size of the top plane for every seed; lower it for
   * a larger plane and taller walls. */
  bite?: number;
}

export interface GrooveOptions {
  /** A point on the groove's BOTTOM line (inside the solid). */
  at: Vec3;
  /** Direction of the bottom line. */
  along: Vec3;
  /** Direction the groove opens toward (out of the solid, roughly). */
  out: Vec3;
  /** Full opening angle of the V in degrees (default 75). Under ~60° a
   * groove 15 cm deep is a hairline at game distance. */
  angle?: number;
  /** Lean the V about its bottom line, degrees (default 0): positive lays
   * the first piece's wall flatter and stands the second piece's wall up, so
   * the second piece becomes a slab lying against the first. */
  skew?: number;
}

export interface CrackOptions {
  /** The groove's BOTTOM line: two points (straight) or three (one kink).
   * Put them 0.12–0.2 m under the surface (`surface(origin, dir, depth)`);
   * where the line leaves the stone the groove fades out. */
  path: readonly Vec3[];
  /** The direction the groove opens toward: the outward normal of the flank
   * it runs down (made square to the line between the path's ends; a kink
   * point is moved along it into the plane of the two ends, which is what
   * makes the two halves of the V meet cleanly at the kink). */
  out: Vec3;
  /** Roughly the direction from the groove toward the side that becomes the
   * SLAB: the side whose surface is set back at the groove. */
  slab: Vec3;
  /** Full opening angle, degrees (default 80). */
  angle?: number;
  /** Degrees (default 10): how much flatter the main piece's wall lies than
   * the slab's edge stands. */
  skew?: number;
  /** How far the slab side is set back at the groove, meters (default
   * 0.07): the two sides sit at different levels, which is what makes it
   * read as a crack between two masses and not as a drawn line. */
  step?: number;
}

export interface ClipOptions {
  /** How many corners to clip. */
  count: number;
  /** Depth of the cut under the corner, meters (each clip draws 0.6–1.3 ×
   * this). The new facet is roughly three times as wide. */
  size: number;
  seed?: number;
  /** Only corners above this height (default 0.15: never the ground line). */
  above?: number;
  /** Tag of the new facets (default 'clip'). */
  tag?: string;
}

/**
 * A convex solid stored as polygon faces, built by cutting planes off a box:
 * the tool for faceted foliage masses and rocks. Start from `lump` (a
 * free-floating faceted ball: canopy blobs) or `mound` (a dome standing on
 * the ground: rocks — usually through `rockChunk`), chain the carving, then
 * `emit` into a SolidMesh.
 *
 *   const rock = rockChunk({ radii: [1.5, 2.4, 1.3], seed: 4, lean: { deg: 9, toward: 40 }, top: { tilt: 24, toward: 220 }, rim: [0.08, 0.3], clips: 4 });
 *   emitRock(m, rock.crack({ path: [a, b, c], out: [-0.3, 0.3, -1], slab: [-1, 0, 0] }), tones);
 *
 *   Polytope.lump({ radii: [1.3, 0.8, 1.2], facets: 22, seed: 7 })
 *     .cut([0, -1, 0], [0, -0.6, 0], 'under')        // flat underside
 *     .move([0, 3.2, 0])
 *     .emit(m, stonePaint(tones));
 *
 * All methods mutate and return `this`, except `clone`, `groove` and `slice`
 * which return new solids. A plane that would remove the whole solid throws.
 */
export class Polytope {
  faces: PolyFace[] = [];

  /** Axis-aligned box. */
  static box(min: Vec3, max: Vec3): Polytope {
    const a = toV3(min);
    const b = toV3(max);
    const p = new Polytope();
    const axes: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let ax = 0; ax < 3; ax++) {
      for (const sign of [-1, 1]) {
        const n = new Vector3(axes[ax][0] * sign, axes[ax][1] * sign, axes[ax][2] * sign);
        const u = (ax + 1) % 3;
        const w = (ax + 2) % 3;
        const corner = (su: number, sw: number): Vector3 => {
          const c = [0, 0, 0];
          c[ax] = sign > 0 ? b.asArray()[ax] : a.asArray()[ax];
          c[u] = su > 0 ? b.asArray()[u] : a.asArray()[u];
          c[w] = sw > 0 ? b.asArray()[w] : a.asArray()[w];
          return new Vector3(c[0], c[1], c[2]);
        };
        const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        if (Vector3.Dot(loopNormal(pts), n) < 0) pts.reverse();
        p.faces.push({ points: pts, normal: n, tag: 'box' });
      }
    }
    return p;
  }

  /**
   * The blank for an AUTHORED rock: a block standing on the ground (its
   * underside at −skirt, tagged 'base'), far wider than the stone will be,
   * to be carved with `wall` after `wall` and then `cut` by its top planes.
   * Use it for a hero whose planes the design sheet dictates; `mound` rolls
   * the planes for you and is right for scatter stones.
   *   const rock = Polytope.block(2.4, 0.08);
   *   for (const [az, reach, lean] of WALLS) rock.wall(az, reach, lean);
   *   rock.wall(165, 1.0, 22, 1.1);                       // a waist plane from 1.1 m up
   *   rock.cut(tilted(24, 250), [0.6, 2.2, 0.3], 'top');  // the broad top plane
   */
  static block(height: number, skirt = 0.08, half = 8): Polytope {
    const p = Polytope.box([-half, -skirt, -half], [half, height, half]);
    for (const f of p.faces) f.tag = f.normal.y < -0.5 ? 'base' : f.normal.y > 0.5 ? 'crown' : 'box';
    return p;
  }

  /**
   * Carve one plane by compass: its outward normal points toward compass
   * direction `az` (degrees about y, 0 = +z, 90 = +x) and is tipped up by
   * `lean` degrees (0 = a vertical wall, 15 = a boulder's flank, 45 = a
   * chamfer, 90 = a lid); it passes through the point `reach` meters out
   * from the y-axis that way, at height `y`. A plane that would miss or
   * swallow the solid is skipped (seeded variants must never fail).
   */
  wall(az: number, reach: number, lean: number, y = 0, tag = 'flank'): this {
    const a = az * DEG;
    const e = clamp(lean, 0, 90) * DEG;
    const n = new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    try {
      this.cutPlane(n, Vector3.Dot(n, new Vector3(Math.sin(a) * reach, y, Math.cos(a) * reach)), tag);
    } catch {
      /* the plane removes everything: leave it out */
    }
    return this;
  }

  /**
   * A faceted lump: planes tangent to an ellipsoid, spread evenly (Fibonacci
   * spiral) then jittered, some biting deeper than others. Unlike a hull of
   * points, every face is a broad POLYGON (pentagons and hexagons), which is
   * the foliage-blob and boulder look of the design sheets.
   */
  static lump(o: LumpOptions): Polytope {
    const r = rng(o.seed ?? 1, 'lump');
    const count = Math.max(6, Math.round(o.facets ?? 20));
    const jitter = o.jitter ?? 0.5;
    const dent = o.dent ?? 0.4;
    const radii = typeof o.radii === 'number' ? new Vector3(o.radii, o.radii, o.radii) : toV3(o.radii);
    if (!(radii.x > 0 && radii.y > 0 && radii.z > 0)) throw new Error('Polytope.lump: radii must be positive');
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spin = r.range(0, Math.PI * 2);
    const spacing = 2 / Math.sqrt(count);
    let planes: { n: Vector3; d: number }[] = [];
    const focus = o.focus ? toV3(o.focus).clone().normalize().scale(clamp(o.bias ?? 0.45, 0, 0.8)) : null;
    for (let i = 0; i < count; i++) {
      const y = 1 - ((i + 0.5) / count) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const a = spin + i * golden;
      const n = new Vector3(
        Math.cos(a) * ring + (r.next() - 0.5) * spacing * jitter,
        y + (r.next() - 0.5) * spacing * jitter,
        Math.sin(a) * ring + (r.next() - 0.5) * spacing * jitter,
      );
      if (focus) n.normalize().addInPlace(focus);
      n.normalize();
      // Squared: most planes stay near the surface, a few bite deeper and
      // become the big faces — mixed sizes, not a d12. (Much deeper than
      // this and one plane swallows all its neighbours.)
      const u = r.next();
      planes.push({ n, d: 1 - u * u * 0.17 * dent });
    }
    // Carve in unit-sphere space; the box is only a start and is always cut
    // away completely by the first few planes.
    const carve = (): Polytope => {
      const p = Polytope.box([-1.9, -1.9, -1.9], [1.9, 1.9, 1.9]);
      planes.forEach((pl, i) => p.cutPlane(pl.n, pl.d, `#${i}`));
      return p.tidy(1e-5);
    };
    let p = carve();
    // A plane that only grazes the lump leaves a sliver or a speck: seen
    // edge-on that is a spike, and either way it costs triangles for no
    // facet. Drop those planes and carve again (their neighbours close up).
    for (let pass = 0; pass < 3; pass++) {
      const shapes = p.faces.map((f) => ({ f, ...faceShape(f) }));
      const areas = shapes.map((q) => q.area).sort((x, y) => x - y);
      const median = areas[areas.length >> 1];
      const drop = new Set<number>();
      for (const q of shapes) if (q.f.tag[0] === '#' && (q.slender < 0.3 || q.area < median * 0.14)) drop.add(Number(q.f.tag.slice(1)));
      if (drop.size === 0 || planes.length - drop.size < 6) break;
      planes = planes.filter((_, i) => !drop.has(i));
      p = carve();
    }
    for (const f of p.faces) f.tag = 'lump';
    // Normalise to the unit box, then stretch to the radii (an affine image
    // of a convex polytope is a convex polytope with the same face layout).
    const b = p.bounds();
    const c = b.min.add(b.max).scale(0.5);
    const h = b.max.subtract(b.min).scale(0.5);
    p.transform(compose(translation(c.scale(-1)), scaling(radii.x / h.x, radii.y / h.y, radii.z / h.z)));
    return p.tidy();
  }

  /**
   * A faceted MOUND resting on the ground: the rock primitive. Bands of
   * planes stacked up a dome profile — each band starts at its height and
   * leans further in than the one below — so the flanks rise from the ground
   * leaning inward (no vertical or undercut walls: a boulder, not a crystal),
   * break into chamfers and close toward the top. Bands are staggered and
   * jittered in direction, pitch and bite, which gives the unequal pentagon
   * / hexagon planes of the design sheets.
   *
   * THE PROFILE IS HONEST: band heights and pitches are what you get, with
   * no hidden stretch — EXCEPT that a dome cannot lean in further than its
   * footprint allows. Where the bands would close the dome below the local
   * height, that side's pitches are steepened by one factor (on their
   * tangent) until `crown` of the radius is left. A stone 2.4 m tall on a
   * 2.6 m footprint simply cannot have 25° flanks all round.
   *
   * THE WAY OUT IS THE WEDGE (`slope`, set by `rockChunk`'s `top`): under a
   * top plane tilted 25° or more the bands hang from the plane, so the low
   * side is a short wall under a broad cream plane and only the side behind
   * the summit is tall. But `crown` then also places the summit: near 0.7 it
   * sits on the tall side's edge and the stone is a tooth from behind, near
   * 0.4 the bands close in and the cream shrinks to a cap. A landmark that
   * needs both a squat profile and a cream plane over half its plan is
   * authored instead (`block` + `wall`, see r01-shoulder-boulder).
   *
   * The result fills the box `radii` = [half width, height, half depth],
   * standing on y = 0 with its flanks carried on down to y = −skirt, and
   * ends in a level lid tagged 'crown' — `rockChunk` replaces that with the
   * sloping top plane.
   */
  static mound(o: MoundOptions): Polytope {
    const r = rng(o.seed ?? 1, 'mound');
    const R = toV3(o.radii);
    if (!(R.x > 0 && R.y > 0 && R.z > 0)) throw new Error('Polytope.mound: radii must be positive');
    const jitter = o.jitter ?? 0.5;
    const dent = o.dent ?? 0.5;
    const skirt = o.skirt ?? 0.08;
    const rings = o.rings ?? BOULDER_RINGS;
    if (rings.length === 0) throw new Error('Polytope.mound: needs at least one ring');
    const crown = clamp(o.crown ?? 0.2, 0.05, 0.95);
    const p = Polytope.box([-R.x * 2.4, -skirt, -R.z * 2.4], [R.x * 2.4, R.y, R.z * 2.4]);
    for (const f of p.faces) f.tag = f.normal.y < -0.5 ? 'base' : f.normal.y > 0.5 ? 'crown' : 'box';
    const at = rings.map((ring) => clamp(ring.at, 0, 0.98));
    const slope = rings.map((ring) => Math.tan(clamp(ring.pitch, 1, 86) * DEG));
    // Inset of the profile per meter of local height, from the ground to the
    // start of band j, and to the top.
    const run: number[] = [0];
    rings.forEach((_, j) => run.push(run[j] + Math.max(0, (at[j + 1] ?? 1) - at[j]) * slope[j]));
    // Footprint radius in the unit direction (sx, sz).
    const rhoAt = (sx: number, sz: number): number => (R.x * R.z) / Math.hypot(R.z * sx, R.x * sz);
    // The top plane: full height over the up-slope end of the crown, falling
    // toward `slope.toward`.
    const tanT = o.slope ? Math.tan(clamp(o.slope.tilt, 0, 60) * DEG) : 0;
    const downAz = (o.slope?.toward ?? 0) * DEG;
    const dx = Math.sin(downAz);
    const dz = Math.cos(downAz);
    const peak = rhoAt(dx, dz) * crown;
    const topN = new Vector3(dx * tanT, 1, dz * tanT).normalize();
    const bite = clamp(o.bite ?? 0.24, 0.02, 1);
    rings.forEach((ring, j) => {
      const count = Math.max(0, Math.round(ring.count));
      const spin = r.range(0, 360);
      for (let i = 0; i < count; i++) {
        const az = (spin + ((i + (r.next() - 0.5) * jitter) / count) * 360) * DEG;
        const pitch = clamp(ring.pitch + (r.next() - 0.5) * 14 * jitter, 2, 86) * DEG;
        const k = 1 - r.next() * 0.16 * dent;
        const wobble = j > 0 ? (r.next() - 0.5) * 0.08 * jitter : 0;
        const sx = Math.sin(az);
        const sz = Math.cos(az);
        const rho = rhoAt(sx, sz);
        // Local height: the top plane over the footprint's edge this way.
        const H = clamp(R.y - tanT * ((sx * rho + dx * peak) * dx + (sz * rho + dz * peak) * dz), R.y * 0.3, R.y);
        // A dome cannot lean in further than its footprint allows: steepen
        // this side's bands by one factor until `crown` of the radius is
        // left at the local height.
        const steepen = Math.min(1, (rho * (1 - crown)) / Math.max(H * run[rings.length], 1e-9));
        const e = Math.atan(Math.tan(pitch) * steepen);
        const n = new Vector3(Math.cos(e) * sx, Math.sin(e), Math.cos(e) * sz);
        const reach = (rho - H * run[j] * steepen) * k;
        let y = (at[j] + wobble) * H;
        if (tanT > 0) {
          // A band nearly parallel to the top plane does not chamfer it, it
          // replaces it: leave it out.
          if (Vector3.Dot(n, topN) > COS_TOP_CLEAR) continue;
          // And no band may run in under the top plane further than `bite`
          // of the radius before it meets it (a band leaning the same way
          // as the plane falls gains on it only slowly, and would eat half
          // the cream): start such a band higher. `gain` = how fast the
          // band climbs toward the top plane per meter inward.
          const gain = 1 / Math.tan(e) - tanT * (sx * dx + sz * dz);
          const over = Math.min(R.y, R.y - tanT * ((sx * reach + dx * peak) * dx + (sz * reach + dz * peak) * dz));
          const most = rho * bite;
          if (gain > 1e-6 && over - y > most * gain) y = over - most * gain;
        }
        p.cutPlane(n, Vector3.Dot(n, new Vector3(sx * reach, y, sz * reach)), ring.tag ?? 'flank');
      }
    });
    return p.fitBox(R).tidy();
  }

  /** Stretch so the footprint spans exactly ±rx, ±rz about the origin and
   * the highest point is at y = height (the part below y = 0 keeps its
   * depth). `radii` = [rx, height, rz]. */
  fitBox(radii: Vec3): this {
    const R = toV3(radii);
    const b = this.bounds();
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const sx = (2 * R.x) / (b.max.x - b.min.x);
    const sz = (2 * R.z) / (b.max.z - b.min.z);
    const sy = R.y / b.max.y;
    for (const f of this.faces) {
      // Fresh vectors: corners are shared by reference between faces.
      f.points = f.points.map((q) => new Vector3((q.x - cx) * sx, q.y > 0 ? q.y * sy : q.y, (q.z - cz) * sz));
      const n = loopNormal(f.points);
      if (n.lengthSquared() > 1e-24) f.normal = n.normalize();
    }
    return this;
  }

  clone(): Polytope {
    const p = new Polytope();
    p.faces = this.faces.map((f) => ({ points: f.points.map((q) => q.clone()), normal: f.normal.clone(), tag: f.tag }));
    return p;
  }

  /**
   * Slice off everything on the `normal` side of the plane through
   * `through`; the cut becomes one new flat face tagged `tag`. This is how a
   * rock gets its broad top plane and chamfers and a canopy blob its flat
   * underside.
   */
  cut(normal: Vec3, through: Vec3, tag = 'cut'): this {
    const n = toV3(normal).clone();
    if (n.lengthSquared() < 1e-18) throw new Error('Polytope.cut: zero normal');
    n.normalize();
    return this.cutPlane(n, Vector3.Dot(n, toV3(through)), tag);
  }

  private cutPlane(n: Vector3, d: number, tag: string): this {
    const eps = 1e-9;
    const cap: Vector3[] = [];
    const out: PolyFace[] = [];
    let removed = false;
    for (const f of this.faces) {
      const pts = f.points;
      const s = pts.map((q) => Vector3.Dot(n, q) - d);
      const kept: Vector3[] = [];
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const ain = s[i] <= eps;
        const bin = s[j] <= eps;
        if (ain) {
          kept.push(pts[i]);
          if (s[i] >= -eps) cap.push(pts[i]);
        } else removed = true;
        if (ain !== bin && Math.abs(s[i]) > eps && Math.abs(s[j]) > eps) {
          const q = crossing(pts[i], pts[j], s[i], s[j]);
          kept.push(q);
          cap.push(q);
        }
      }
      if (kept.length >= 3) out.push({ points: kept, normal: f.normal, tag: f.tag });
    }
    if (!removed) return this;
    const rim = dedupe(cap, 1e-9);
    if (out.length < 3 || rim.length < 3) throw new Error('Polytope.cut: the plane removes the whole solid');
    // Order the rim counter-clockwise about the normal: u × w = n.
    const c = rim.reduce((acc, q) => acc.addInPlace(q), new Vector3()).scale(1 / rim.length);
    const u = anyPerpendicular(n);
    const w = Vector3.Cross(n, u);
    rim.sort(
      (a, b) =>
        Math.atan2(Vector3.Dot(a.subtract(c), w), Vector3.Dot(a.subtract(c), u)) -
        Math.atan2(Vector3.Dot(b.subtract(c), w), Vector3.Dot(b.subtract(c), u)),
    );
    out.push({ points: rim, normal: n.clone(), tag });
    this.faces = out;
    return this;
  }

  // The two pieces either side of a V whose bottom line runs through `at`
  // along `along` and which opens toward `out` (unit, perpendicular to
  // `along`). `main` is everything behind the plane of wall 1 — that plane
  // runs on through the stone under the other piece, and all of it is
  // emitted as 'groove', so the stone stays closed whatever is done to the
  // slab; `slab` is the rest minus the V, its hidden back tagged 'inner'. A
  // wall that misses the solid leaves that side null (cut throws): random
  // seeds must degrade to "no groove", never to a failed build.
  private splitV(at: Vector3, along: Vector3, out: Vector3, h1: number, h2: number): { main: Polytope | null; slab: Polytope | null } {
    const side = Vector3.Cross(along, out);
    // Normals of the two walls, each pointing INTO the V.
    const m1 = out.scale(Math.sin(h1)).subtract(side.scale(Math.cos(h1)));
    const m2 = out.scale(Math.sin(h2)).add(side.scale(Math.cos(h2)));
    let main: Polytope | null = null;
    let slab: Polytope | null = null;
    try {
      main = this.clone().cut(m1, at, 'groove');
    } catch {
      /* this side is empty */
    }
    try {
      slab = this.clone().cut(m2, at, 'groove').cut(m1.scale(-1), at, 'inner');
    } catch {
      /* this side is empty */
    }
    return { main, slab };
  }

  /**
   * Cut a straight V-groove and return the pieces either side of it —
   * normally two, still one rock: they touch along the hidden plane behind
   * the groove's bottom line (one piece if the groove misses the solid). The
   * groove exists only where the bottom line runs UNDER the surface, so the
   * chord between two points just under a flank (`surface(…, depth)`) gives
   * a groove that fades out at both ends; a line right through the solid,
   * opening upward, gives a split from the top down to that line (a forked
   * fin, a broken chunk). Groove walls are tagged 'groove' (painted
   * `crevice`); the second piece's hidden back is tagged 'inner' and never
   * emitted — so the pieces must stay in contact: to step the two sides,
   * move or shrink one piece INTO the other, never apart. For a groove on a
   * flank with a kink and a step, use `crack`.
   *   chunks.push(...rock.groove({ at: hi, along: lo.subtract(hi), out: [0, 0.3, -1] }));
   */
  groove(o: GrooveOptions): Polytope[] {
    const at = toV3(o.at);
    const along = toV3(o.along).clone().normalize();
    let out = toV3(o.out).clone();
    out = out.subtract(along.scale(Vector3.Dot(out, along)));
    if (out.lengthSquared() < 1e-12) throw new Error('Polytope.groove: `out` is parallel to `along`');
    out.normalize();
    const half = (o.angle ?? 75) / 2;
    const skew = o.skew ?? 0;
    const s = this.splitV(at, along, out, clamp(half + skew, 5, 85) * DEG, clamp(half - skew, 5, 85) * DEG);
    const pieces = [s.main, s.slab].filter((q): q is Polytope => q !== null);
    return pieces.length ? pieces : [this.clone()];
  }

  /**
   * The "deliberate groove" of the rock sheets: a V-groove along a line of
   * two or three points under a flank — three give it a kink — whose one
   * side is set back a few centimetres, so the groove has a lit shoulder
   * and a shaded step instead of two flush edges. Call it on a finished
   * chunk (after its top plane). Returns the convex pieces (2–4), main
   * pieces first; emit them together with `emitRock`. Still ONE rock: the
   * pieces stay in contact, nothing is moved. Costs 30–45 triangles on a
   * boulder (every face the contact planes cross is split).
   *   const a = rock.surface(heart, [-0.3, 0.9, -1], 0.04);     // start at the top edge
   *   const b = rock.surface(heart, [-0.6, 0.2, -1], 0.18);     // kink, 18 cm deep
   *   const c = rock.surface(heart, [-0.7, -0.6, -1], 0.18);    // down to the ground
   *   const pieces = rock.crack({ path: [a, b, c], out: [-0.3, 0.3, -1], slab: [-1, 0, 0] });
   */
  crack(o: CrackOptions): Polytope[] {
    let pts = toV3s(o.path).map((q) => q.clone());
    if (pts.length < 2 || pts.length > 3) throw new Error('Polytope.crack: path needs two or three points');
    const dir = (a: Vector3, b: Vector3): Vector3 => b.subtract(a).normalize();
    let out = toV3(o.out).clone();
    const chord = dir(pts[0], pts[pts.length - 1]);
    out = out.subtract(chord.scale(Vector3.Dot(out, chord)));
    if (out.lengthSquared() < 1e-12) throw new Error('Polytope.crack: `out` is parallel to the path');
    out.normalize();
    if (pts.length === 3) {
      // Both halves of the V must open the same way, so the whole path has
      // to lie in one plane square to `out`: bring the kink into the plane
      // of the two ends. (Taking the plane of the three points instead lets
      // a kink point that merely sits deeper turn the groove on its side,
      // and the "groove" then slices the face off the stone.)
      pts[1] = pts[1].subtract(out.scale(Vector3.Dot(out, pts[1].subtract(pts[0]))));
      // Nearly straight: treat it as one segment.
      if (Vector3.Cross(dir(pts[0], pts[1]), dir(pts[1], pts[2])).lengthSquared() < 4e-3) pts = [pts[0], pts[2]];
    }
    // `splitV` puts the slab on the −(along × out) side: run the path the
    // way that makes that the requested side.
    if (Vector3.Dot(Vector3.Cross(chord, out), toV3(o.slab)) > 0) pts.reverse();
    const half = (o.angle ?? 80) / 2;
    const skew = o.skew ?? 10;
    const h1 = clamp(half + skew, 5, 85) * DEG;
    const h2 = clamp(half - skew, 5, 85) * DEG;

    // A kink: split the stone by the plane that bisects the two segments —
    // the two Vs are mirror images in it, so their sections coincide there.
    let parts: Polytope[] = [this.clone()];
    let segs: [Vector3, Vector3][] = [[pts[0], pts[pts.length - 1]]];
    if (pts.length === 3) {
      const b = dir(pts[0], pts[1]).add(dir(pts[1], pts[2])).normalize();
      try {
        parts = [this.clone().cut(b, pts[1], 'inner'), this.clone().cut(b.scale(-1), pts[1], 'inner')];
        segs = [
          [pts[0], pts[1]],
          [pts[1], pts[2]],
        ];
      } catch {
        /* the kink lies outside the stone: one straight groove */
      }
    }
    const main: Polytope[] = [];
    const slab: Polytope[] = [];
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i].splitV(segs[i][0], dir(segs[i][0], segs[i][1]), out, h1, h2);
      if (s.main) main.push(s.main);
      if (s.slab) slab.push(s.slab);
    }

    // The step: every flank face of the slab side that borders the groove is
    // cut `step` deeper, parallel to itself. Nothing moves, so the pieces
    // stay seated on each other and the top plane stays one unbroken plane;
    // the main piece's wall simply stands that much taller than the slab's.
    // (The main piece's whole wall plane is emitted, so the strip the
    // lowered slab uncovers is closed.) Both halves of a kinked slab get the
    // same cuts — they came off the same faces — and stay flush.
    const step = o.step ?? 0.07;
    if (step > 0 && main.length > 0) {
      const planes: { n: Vector3; d: number; tag: string }[] = [];
      const near = (a: Vector3, b: Vector3): boolean => Vector3.DistanceSquared(a, b) < 1e-8;
      for (const q of slab) {
        const walls = q.faces.filter((f) => f.tag === 'groove');
        for (const f of q.faces) {
          if (f.tag === 'groove' || f.tag === 'inner' || f.tag === 'top' || f.tag === 'base') continue;
          if (!walls.some((w) => w.points.some((a) => f.points.some((b) => near(a, b))))) continue;
          const d = Vector3.Dot(f.normal, f.points[0]);
          if (!planes.some((pl) => Vector3.Dot(pl.n, f.normal) > 0.99999 && Math.abs(pl.d - d) < 1e-5)) planes.push({ n: f.normal.clone(), d, tag: f.tag });
        }
      }
      for (const q of slab) {
        for (const pl of planes) {
          try {
            q.cutPlane(pl.n, pl.d - step, pl.tag);
          } catch {
            /* a sliver thinner than the step: leave it */
          }
        }
        q.tidy();
      }
    }
    return [...main, ...slab];
  }

  /**
   * Clip `count` random corners: each chosen vertex is cut off by a plane
   * facing the average of the faces that meet there, leaving a small extra
   * facet — the "clipped corners" of the style guide, and the cheapest way
   * to break up faces that run from the ground to the rim in one piece
   * (about 2–4 triangles a clip). Corners on the ground line and on groove
   * walls are left alone.
   */
  clip(o: ClipOptions): this {
    const r = rng(o.seed ?? 1, 'clip');
    const above = o.above ?? 0.15;
    interface Corner {
      p: Vector3;
      n: Vector3;
      skip: boolean;
    }
    const corners: Corner[] = [];
    for (const f of this.faces) {
      for (const q of f.points) {
        let c = corners.find((k) => Vector3.DistanceSquared(k.p, q) < 1e-10);
        if (!c) {
          c = { p: q, n: new Vector3(), skip: false };
          corners.push(c);
        }
        c.n.addInPlace(f.normal);
        if (f.tag === 'base' || f.tag === 'groove' || f.tag === 'inner') c.skip = true;
      }
    }
    const picked: Corner[] = [];
    for (const c of r.shuffle(corners.filter((k) => !k.skip && k.p.y > above))) {
      if (picked.length >= o.count) break;
      // Two clips side by side eat the face between them.
      if (picked.some((k) => Vector3.Distance(k.p, c.p) < o.size * 4)) continue;
      picked.push(c);
    }
    for (const c of picked) {
      const n = c.n.clone().normalize();
      try {
        this.cut(n, c.p.subtract(n.scale(o.size * r.range(0.6, 1.3))), o.tag ?? 'clip');
      } catch {
        /* a clip larger than the piece: skip it */
      }
    }
    return this.tidy();
  }

  /**
   * Chamfer every edge of the faces tagged `tag` with a strip `width` meters
   * wide (measured on the face; a function gives each edge its own width,
   * 0 = leave that edge crisp), tagged `as`. The broad bevel that keeps a
   * rock's top plane from meeting its flanks in a razor edge — and, painted
   * light, the pale rim the design sheets draw round every top plane. Edges
   * between nearly coplanar faces (under `minAngle` degrees) are left alone.
   * Costs about 2–4 triangles per edge.
   */
  bevel(tag: string, width: number | ((edge: number) => number), as = 'rim', minAngle = 18): this {
    const planes: { n: Vector3; through: Vector3 }[] = [];
    const near = (a: Vector3, b: Vector3): boolean => Vector3.DistanceSquared(a, b) < 1e-10;
    let edge = 0;
    for (const f of this.faces) {
      if (f.tag !== tag) continue;
      const centre = faceCenter(f);
      for (let i = 0; i < f.points.length; i++) {
        const a = f.points[i];
        const b = f.points[(i + 1) % f.points.length];
        const g = this.faces.find((o) => o !== f && o.points.some((q) => near(q, a)) && o.points.some((q) => near(q, b)));
        if (!g || g.tag === tag) continue;
        if (Vector3.Dot(f.normal, g.normal) > Math.cos(minAngle * DEG)) continue;
        const n = f.normal.add(g.normal).normalize();
        const mid = a.add(b).scale(0.5);
        const inward = Vector3.Cross(f.normal, b.subtract(a)).normalize();
        if (Vector3.Dot(inward, centre.subtract(mid)) < 0) inward.scaleInPlace(-1);
        const w = typeof width === 'number' ? width : width(edge++);
        if (w > 1e-4) planes.push({ n, through: mid.add(inward.scale(w)) });
      }
    }
    for (const pl of planes) this.cut(pl.n, pl.through, as);
    return this.tidy();
  }

  /** Split by a plane into [the part behind the normal, the part in front].
   * Shrink the front part about a point on the plane and the cut face of
   * the back part shows as a ledge — strata steps. */
  slice(normal: Vec3, through: Vec3): [Polytope, Polytope] {
    const n = toV3(normal);
    return [this.clone().cut(n, through, 'top'), this.clone().cut(n.scale(-1), through, 'inner')];
  }

  /** Apply any affine matrix (non-uniform scale and mirrors included). */
  transform(mat: Matrix): this {
    const flip = mat.determinant() < 0;
    for (const f of this.faces) {
      f.points = f.points.map((q) => applyMatrix(q, mat));
      if (flip) f.points.reverse();
      const n = loopNormal(f.points);
      if (n.lengthSquared() > 1e-24) f.normal = n.normalize();
    }
    return this;
  }

  move(by: Vec3): this {
    return this.transform(translation(by));
  }

  /** Rotate by degrees about 'x' | 'y' | 'z' or an axis, through the origin. */
  turn(axis: 'x' | 'y' | 'z' | Vec3, deg: number): this {
    return this.transform(rotation(axis, deg));
  }

  /** Scale about the origin. */
  scale(s: number | Vec3): this {
    const v = typeof s === 'number' ? new Vector3(s, s, s) : toV3(s);
    return this.transform(scaling(v.x, v.y, v.z));
  }

  /** Scale about a point (shrink a piece into its neighbour). */
  scaleAbout(pivot: Vec3, s: number | Vec3): this {
    const c = toV3(pivot);
    const v = typeof s === 'number' ? new Vector3(s, s, s) : toV3(s);
    return this.transform(compose(translation(c.scale(-1)), scaling(v.x, v.y, v.z), translation(c)));
  }

  bounds(): { min: Vector3; max: Vector3 } {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const f of this.faces) {
      for (const q of f.points) {
        min.minimizeInPlace(q);
        max.maximizeInPlace(q);
      }
    }
    return { min, max };
  }

  /**
   * The point where a ray from `origin` (inside the solid) along `dir`
   * leaves it. Lumps are random per seed; this is how to find "the surface
   * toward the front-left" to start a groove or seat a part on a rock.
   * `inset` pulls the result back toward the origin by that many meters.
   */
  surface(origin: Vec3, dir: Vec3, inset = 0): Vector3 {
    const o = toV3(origin);
    const d = toV3(dir).clone().normalize();
    let best = Infinity;
    for (const f of this.faces) {
      const along = Vector3.Dot(f.normal, d);
      if (along <= 1e-9) continue;
      const t = Vector3.Dot(f.normal, f.points[0].subtract(o)) / along;
      if (t < best) best = t;
    }
    if (!(best < Infinity)) throw new Error('Polytope.surface: the ray never leaves the solid');
    return o.add(d.scale(Math.max(0, best - inset)));
  }

  /**
   * The point on the outline of the first face tagged `tag` that lies
   * furthest in plan direction `toward` ([x, ·, z]) — e.g. where a groove
   * coming up the front flank should meet the top plane:
   * `rock.rimPoint('top', [-0.3, 0, -1])`.
   */
  rimPoint(tag: string, toward: Vec3): Vector3 {
    const face = this.faces.find((f) => f.tag === tag);
    if (!face) throw new Error(`Polytope.rimPoint: no face tagged '${tag}'`);
    const t = toV3(toward);
    const d = new Vector3(t.x, 0, t.z).normalize();
    let best = face.points[0];
    const n = face.points.length;
    for (let i = 0; i < n; i++) {
      for (const q of [face.points[i], Vector3.Lerp(face.points[i], face.points[(i + 1) % n], 0.5)]) {
        if (Vector3.Dot(q, d) > Vector3.Dot(best, d)) best = q;
      }
    }
    return best.clone();
  }

  /** True if `p` is inside the solid by at least `margin`. */
  contains(p: Vector3, margin = 0): boolean {
    for (const f of this.faces) {
      if (Vector3.Dot(f.normal, p.subtract(f.points[0])) > -margin) return false;
    }
    return true;
  }

  /**
   * Merge vertices closer than `tolerance` and drop the faces that collapse.
   * Plane cuts through near-corners leave edges a few µm long; welded by the
   * mesh they would become degenerate slivers with garbage normals. One
   * shared vertex pool keeps the solid watertight.
   */
  tidy(tolerance = 2e-4): this {
    const pool: Vector3[] = [];
    const rep = (q: Vector3): Vector3 => {
      for (const p of pool) if (Vector3.DistanceSquared(p, q) < tolerance * tolerance) return p;
      pool.push(q);
      return q;
    };
    const out: PolyFace[] = [];
    for (const f of this.faces) {
      const pts: Vector3[] = [];
      for (const q of f.points) {
        const p = rep(q);
        if (pts.length === 0 || pts[pts.length - 1] !== p) pts.push(p);
      }
      while (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
      if (pts.length >= 3 && loopNormal(pts).lengthSquared() > 1e-20) out.push({ points: pts, normal: f.normal, tag: f.tag });
    }
    this.faces = out;
    return this;
  }

  /**
   * Append the solid to a mesh, one flat colour per face. `p` is a Paint or
   * a function of the face (`stonePaint`); returning null
   * skips the face. `hidden` (optional) drops faces lying entirely inside
   * any of the given other solids — exact for convex pieces, so sinking
   * parts into each other costs nothing.
   */
  emit(m: SolidMesh, p: Paint | ((face: PolyFace, index: number) => Paint | null), hidden: readonly Polytope[] = []): void {
    this.tidy();
    this.faces.forEach((f, i) => {
      // Contact faces between the pieces of one stone (`groove`, `crack`,
      // `slice`) lie flush against the neighbouring piece: never visible.
      if (f.tag === 'inner') return;
      for (const other of hidden) {
        if (other !== this && f.points.every((q) => other.contains(q, 1e-4))) return;
      }
      const fp = typeof p === 'function' ? p(f, i) : p;
      if (fp) m.fan(f.points, fp);
    });
  }
}

/** Centre of a face (mean of its corners). */
export function faceCenter(f: PolyFace): Vector3 {
  const c = new Vector3();
  for (const q of f.points) c.addInPlace(q);
  return c.scaleInPlace(1 / f.points.length);
}

/** Area of a face and how slender it is: its width across its longest
 * span, as a fraction of that span (1 = round, 0.1 = a splinter). */
export function faceShape(f: PolyFace): { area: number; slender: number } {
  const pts = f.points;
  let area = 0;
  for (let i = 1; i + 1 < pts.length; i++) area += Vector3.Cross(pts[i].subtract(pts[0]), pts[i + 1].subtract(pts[0])).length() * 0.5;
  let span = 0;
  let along = new Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Vector3.DistanceSquared(pts[i], pts[j]);
      if (d > span) {
        span = d;
        along = pts[j].subtract(pts[i]);
      }
    }
  }
  span = Math.sqrt(span);
  if (span < 1e-9) return { area, slender: 0 };
  const across = Vector3.Cross(f.normal, along).normalize();
  let lo = Infinity;
  let hi = -Infinity;
  for (const q of pts) {
    const t = Vector3.Dot(q, across);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { area, slender: (hi - lo) / span };
}

// The same edge is clipped once from each of its two faces, walking it in
// opposite directions. Evaluating from a canonical end makes both results
// bit-identical, so the solid stays watertight without a weld pass.
function crossing(a: Vector3, b: Vector3, sa: number, sb: number): Vector3 {
  if (b.x < a.x || (b.x === a.x && (b.y < a.y || (b.y === a.y && b.z < a.z)))) {
    const t = a;
    a = b;
    b = t;
    const s = sa;
    sa = sb;
    sb = s;
  }
  const t = sa / (sa - sb);
  return new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

function dedupe(points: Vector3[], tolerance: number): Vector3[] {
  const out: Vector3[] = [];
  for (const q of points) {
    if (!out.some((p) => Vector3.DistanceSquared(p, q) <= tolerance * tolerance)) out.push(q);
  }
  return out;
}

/** Stable 0..1 hash of a point on a ~15 cm lattice (per-facet variation). */
function cellHash(p: Vector3, seed: number): number {
  return hash3(Math.round(p.x * 7), Math.round(p.y * 7), Math.round(p.z * 7), seed);
}

// ---------------------------------------------------------------------------
// Foliage masses

export interface FoliageShade {
  /** World heights between which the mass goes from "low" to "high": low
   * facets lean to the underside tone, high ones to the top tone. Default:
   * no height term. */
  yLow?: number;
  yHigh?: number;
  seed?: number;
  /** Default 0.2. */
  gloss?: number;
  /** Per-facet lightness scatter, ± (default 0.022). */
  scatter?: number;
  /** 0..1: how closed-in the facet is (it looks into a neighbouring mass).
   * `canopy` works it out per facet; it pulls the tone toward `deep`. */
  crease?: number;
}

/** Tone for a facet with normal `n` at `center`: the warm-top / cool-
 * underside rule, flat per facet. Exposed for custom foliage geometry. */
export function foliageColor(tones: FoliageTones, n: Vector3, center: Vector3, o: FoliageShade = {}): RGB {
  const height = o.yLow !== undefined && o.yHigh !== undefined ? clamp((center.y - o.yLow) / (o.yHigh - o.yLow), 0, 1) : 0.5;
  // 0 = fully underside … 1 = fully top. The normal leads, so the low blobs
  // of a canopy still show a lit top; height takes the FLANKS of the lower
  // half toward the underside green (left at the lime mid tone they go
  // olive on the shade side) and the upper flanks toward the top tone.
  const light = clamp(0.5 + n.y * 0.5 + (height - 0.55) * 0.4, 0, 1);
  const c =
    light < 0.5
      ? mixOklab(tones.under, tones.mid, smoothstep(0.08, 0.5, light))
      : mixOklab(tones.mid, tones.top, smoothstep(0.5, 0.92, light));
  const k = cellHash(center, o.seed ?? 0) - 0.5;
  const scattered = adjustOklch(c, k * 2 * (o.scatter ?? 0.022), 1, k * 6);
  return o.crease ? mixOklab(scattered, tones.deep, clamp(o.crease, 0, 1) * 0.44) : scattered;
}

/** The same rule as a post-pass over existing triangles (foliage built from
 * kit primitives — `blob`, `icosphere`, cones): one tone per triangle. */
export function shadeFoliage(m: SolidMesh, tones: FoliageTones, o: FoliageShade & { from?: number } = {}): void {
  m.repaint((c, n) => paint(foliageColor(tones, n, c, o), { gloss: o.gloss ?? 0.2, smooth: 0 }), o.from ?? 0);
}

export interface CanopyBlob {
  /** Centre. */
  at: Vec3;
  /** Half extents (a canopy blob is wider than tall: [1.3, 0.8, 1.2]). */
  radii: Vec3 | number;
  /** Carving planes ≈ faces (default 30 ≈ 108 triangles before hidden
   * faces are dropped; 36–42 on the big masses of a tree, 20–24 on a bush
   * blob). Half of them face the viewer: under 30 a mass shows 8–10 equal
   * pentagons and reads as a cut gem or a die, not as leaves. */
  facets?: number;
  /** Underside: cut flat at this fraction of the vertical radius below the
   * centre (default 0.82; 1 = leave round). The umbrella look. */
  flat?: number;
  /** Turn about y, degrees. */
  yaw?: number;
  /** Tip the whole blob: degrees, toward its yaw + 90° direction. */
  tilt?: number;
}

export interface CanopyOptions extends FoliageShade {
  blobs: readonly CanopyBlob[];
  /** Facet direction irregularity, 0..1 (default 0.6). */
  jitter?: number;
  /** Unequal facet sizes, 0..1 (default 0.8). */
  dent?: number;
  /** How strongly each mass crowds its facets toward the outside of the
   * cluster (see `LumpOptions.focus`; default 0.45, 0 = even all round). */
  bias?: number;
  /** Reach of the crease shading, meters (default 0.55): a facet is closed
   * in when another mass lies within this distance in front of it. 0 = off. */
  crease?: number;
}

/**
 * A cluster of faceted foliage masses, shaded warm-top / cool-underside over
 * the height of the WHOLE cluster, with every face buried in a neighbouring
 * blob removed. Overlap the blobs by about a third of their radius; branch
 * tips go inside them. Returns the solids (to test or reuse); wind is set by
 * `sway` at the end of the asset.
 */
export function canopy(m: SolidMesh, o: CanopyOptions, tones: FoliageTones): Polytope[] {
  const seed = o.seed ?? 0;
  // Facets go where they are seen: each mass crowds its planes toward "up
  // and away from the middle of the cluster".
  const middle = new Vector3();
  for (const b of o.blobs) middle.addInPlace(toV3(b.at));
  middle.scaleInPlace(1 / Math.max(1, o.blobs.length));
  const solids = o.blobs.map((b, i) => {
    const radii = typeof b.radii === 'number' ? new Vector3(b.radii, b.radii, b.radii) : toV3(b.radii);
    const away = toV3(b.at).subtract(middle);
    away.y = 0;
    let focus = away.scale(1 / Math.max(radii.x, radii.z)).add(new Vector3(0, 0.75, 0));
    // The lump is tipped and turned after it is carved: aim in its own frame.
    if (b.yaw) focus = applyMatrix(focus, rotation('y', -b.yaw));
    if (b.tilt) focus = applyMatrix(focus, rotation('x', -b.tilt));
    const p = Polytope.lump({ radii, facets: b.facets ?? 30, seed: seed * 131 + i * 17 + 3, jitter: o.jitter ?? 0.6, dent: o.dent ?? 0.8, focus, bias: o.bias });
    const flat = b.flat ?? 0.82;
    if (flat < 0.98) p.cut([0, -1, 0], [0, -radii.y * flat, 0], 'under');
    if (b.tilt) p.turn('x', b.tilt);
    if (b.yaw) p.turn('y', b.yaw);
    return p.move(b.at);
  });
  let yLow = o.yLow;
  let yHigh = o.yHigh;
  if (yLow === undefined || yHigh === undefined) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of solids) {
      const b = s.bounds();
      lo = Math.min(lo, b.min.y);
      hi = Math.max(hi, b.max.y);
    }
    yLow = yLow ?? lo;
    yHigh = yHigh ?? hi;
  }
  const shade: FoliageShade = { ...o, yLow, yHigh, seed, crease: undefined };
  const surface = { gloss: o.gloss ?? 0.2, smooth: 0 };
  const reach = o.crease ?? 0.55;
  solids.forEach((s) => {
    const others = solids.filter((q) => q !== s);
    s.emit(
      m,
      (face) => {
        const c = faceCenter(face);
        // The crease tone: probe out along the facet's normal; every probe
        // that lands inside a neighbouring mass closes the facet in a bit
        // more. This is what separates the masses in depth — the baked
        // occlusion is per vertex and too coarse to reach into the gaps.
        let closed = 0;
        if (reach > 0) {
          for (const k of [0.3, 0.65, 1]) {
            const probe = c.add(face.normal.scale(reach * k));
            if (others.some((q) => q.contains(probe))) closed += k === 0.3 ? 0.5 : 0.25;
          }
        }
        return paint(foliageColor(tones, face.normal, c, { ...shade, crease: closed }), surface);
      },
      solids,
    );
  });
  return solids;
}

export interface SkirtOptions {
  /** Centre of the rim plane: the tier hangs around this point. */
  at: Vec3;
  /** Radius of the lobe tips. */
  radius: number;
  /** From the rim plane up to the top ring. */
  height: number;
  /** Radius at the top (default 0.2 × radius; 0 = a point, the tree tip). */
  topRadius?: number;
  /** Offset of the top ring from the rim centre, [x, z] — a windswept tier. */
  shift?: readonly [number, number];
  /** Lobes round the rim (default 7). */
  lobes?: number;
  /** How far the rim pulls in between lobes, fraction of radius (default 0.22). */
  notch?: number;
  /** How far the lobe tips hang below the rim plane, fraction of height
   * (default 0.2). */
  droop?: number;
  /** Thickness of the chunky rim edge, meters (default 0.12 × height). */
  thickness?: number;
  /** Irregularity of lobe size and spacing, 0..1 (default 0.5). */
  jitter?: number;
  seed?: number;
}

/**
 * A conifer TIER: a faceted cone skirt with a lobed, drooping rim, a chunky
 * rim edge and a tucked-in underside (closed, so a low camera sees foliage,
 * not a hole). Stack four on a trunk, each smaller and shifted a little, for
 * a pine; one with `topRadius: 0` is the tip. About 10 triangles per lobe.
 */
export function skirt(m: SolidMesh, o: SkirtOptions, tones: FoliageTones, shade: FoliageShade = {}): void {
  const from = m.mark();
  const c = toV3(o.at);
  const r = rng(o.seed ?? 1, 'skirt');
  const L = Math.max(3, Math.round(o.lobes ?? 7));
  const jitter = o.jitter ?? 0.5;
  const H = o.height;
  const R = o.radius;
  const topR = o.topRadius ?? R * 0.2;
  const thick = o.thickness ?? H * 0.12;
  const droop = (o.droop ?? 0.2) * H;
  const notch = o.notch ?? 0.22;
  const spin = r.range(0, Math.PI * 2);
  const top = c.add(new Vector3(o.shift?.[0] ?? 0, H, o.shift?.[1] ?? 0));
  const p = paint(tones.mid, { gloss: shade.gloss ?? 0.2, smooth: 0 });
  const tips: Vector3[] = [];
  const dips: Vector3[] = [];
  const crown: Vector3[] = [];
  for (let i = 0; i < L; i++) {
    const a = spin + ((i + (r.next() - 0.5) * 0.5 * jitter) / L) * Math.PI * 2;
    const b = a + Math.PI / L;
    const rt = R * (1 - r.next() * 0.22 * jitter);
    tips.push(c.add(new Vector3(Math.sin(a) * rt, -droop * (0.6 + r.next() * 0.8), Math.cos(a) * rt)));
    dips.push(c.add(new Vector3(Math.sin(b) * R * (1 - notch), H * 0.07, Math.cos(b) * R * (1 - notch))));
    crown.push(top.add(new Vector3(Math.sin(a) * topR, 0, Math.cos(a) * topR)));
  }
  const axis = c.add(new Vector3(0, H * 0.4, 0));
  const tri = (a: Vector3, b: Vector3, d: Vector3, dir?: Vector3): void => {
    const out = dir ?? a.add(b).add(d).scale(1 / 3).subtract(axis);
    if (Vector3.Dot(loopNormal([a, b, d]), out) >= 0) m.tri(a, b, d, p);
    else m.tri(a, d, b, p);
  };
  const down = new Vector3(0, -1, 0);
  const drop = new Vector3(0, -thick, 0);
  // Tuck the underside up toward the trunk so it reads as a shaded hollow.
  const belly = c.add(new Vector3(0, H * 0.22, 0));
  for (let i = 0; i < L; i++) {
    const j = (i + 1) % L;
    const k = (i + L - 1) % L;
    // Top surface: each lobe is two facets, the valley between lobes a third.
    tri(crown[i], dips[k], tips[i]);
    tri(crown[i], tips[i], dips[i]);
    tri(crown[i], dips[i], crown[j]);
    // Rim edge and underside, tip → dip → next tip.
    for (const [a, b] of [
      [tips[i], dips[i]],
      [dips[i], tips[j]],
    ]) {
      const a2 = a.add(drop);
      const b2 = b.add(drop);
      tri(a, b, b2);
      tri(a, b2, a2);
      tri(belly, a2, b2, down);
    }
    if (topR > 1e-6) tri(top, crown[i], crown[j], new Vector3(0, 1, 0));
  }
  shadeFoliage(m, tones, { ...shade, from });
}

// ---------------------------------------------------------------------------
// Wood: limbs, roots, bark

/** One flat facet of a limb or root, as handed to a `LimbPaint` function. */
export interface LimbFacet {
  /** The limb's own seed: the same flute of two limbs need not match. */
  limb: number;
  /** Flute index round the limb (0 … sides − 1); −1 on an end cap. */
  side: number;
  /** Band index along the limb, base → tip. */
  band: number;
  /** 0 at the base … 1 at the tip (middle of the band). */
  t: number;
  /** Outward normal and centre of the facet. */
  normal: Vector3;
  center: Vector3;
}

/** A fixed paint, or one chosen per facet (`barkPaint`). */
export type LimbPaint = Paint | ((facet: LimbFacet) => Paint);

export interface LimbOptions {
  /** Centre line, base → tip. */
  path: readonly Vec3[];
  /** Radius at each path point (array, same length as `path`), one number,
   * or a function of t = 0 (base) … 1 (tip). A radius of 0 ends in a point. */
  radius: number | readonly number[] | ((t: number) => number);
  /** Polygon sides (default 6; 5 for branches). Few sides are the style: a
   * trunk is a faceted prism, not a pipe. */
  sides?: number;
  /** Smooth the path through its points with this many Catmull-Rom samples
   * per span (default 0 = straight runs between the points). */
  curve?: number;
  /** Total turn of the section from base to tip, as a fraction of one side
   * (default 0 = flutes run straight up the limb; 0.5–1 = a slow spiral).
   * It is NOT a per-ring twist: turning every ring against the last makes
   * every band a zig-zag of triangles and the limb reads as wrung rope. */
  twist?: number;
  /** Irregularity of the SECTION, 0..1 (default 0.25): each corner gets its
   * own radius and spacing, kept from base to tip, so the flutes are of
   * unequal width but every one stays a clean strip. */
  rough?: number;
  seed?: number;
  /** Close the tip with a flat cap (default true; false for a tip that ends
   * inside foliage). */
  capTip?: boolean;
  /** Close the base (default false: bases are sunk into the ground or the
   * parent limb). */
  capBase?: boolean;
  /** Flatten the base ring to the height of the first path point (a trunk
   * that starts leaning would otherwise dig one side of its foot deep into
   * the ground and lift the other). */
  levelBase?: boolean;
}

/**
 * A tapered, FLUTED limb along a path: trunk, branch, stem. The section is
 * one irregular polygon carried from base to tip on twist-free frames, so
 * every side is a long near-planar strip — the clean flutes of the design
 * sheet — and each strip facet (two triangles) gets ONE paint. Start it
 * INSIDE whatever it grows from (with a radius under the parent's, so no
 * corner breaks the parent's surface) and end it inside the foliage it
 * carries. Triangles: 2 × sides per band, + sides per cap.
 *   const WOOD = barkPaint(bark, { seed });
 *   limb(m, { path: [[0, -0.1, 0], [0.1, 1.2, 0], [0.5, 2.3, 0.1]], radius: [0.55, 0.4, 0.3], curve: 2 }, WOOD);
 */
export function limb(m: SolidMesh, o: LimbOptions, p: LimbPaint): void {
  const control = toV3s(o.path);
  if (control.length < 2) throw new Error('limb: path needs at least two points');
  const pts = o.curve && o.curve > 1 && control.length > 2 ? catmullRomPath(control, Math.round(o.curve)) : control;
  const n = pts.length;
  const sides = Math.max(3, Math.round(o.sides ?? 6));
  const radiusAt = (k: number): number => {
    const t = k / (n - 1);
    if (typeof o.radius === 'number') return o.radius;
    if (typeof o.radius === 'function') return o.radius(t);
    // Array: radius[i] belongs to control point i; in between, interpolate.
    const x = t * (o.radius.length - 1);
    const i = Math.min(o.radius.length - 2, Math.floor(x));
    if (o.radius.length === 1) return o.radius[0];
    return o.radius[i] + (o.radius[i + 1] - o.radius[i]) * (x - i);
  };
  const frames = pathFrames(pts);
  const seed = o.seed ?? 1;
  const r = rng(seed, 'limb');
  const rough = o.rough ?? 0.25;
  const twist = (o.twist ?? 0) * ((Math.PI * 2) / sides);
  const phase = r.range(0, Math.PI * 2);
  // The section: corner angles and radii, the same at every ring.
  const cornerAngle: number[] = [];
  const cornerRadius: number[] = [];
  for (let j = 0; j < sides; j++) {
    cornerAngle.push(phase + ((j + (r.next() - 0.5) * 0.7 * rough) / sides) * Math.PI * 2);
    cornerRadius.push(1 + (r.next() - 0.5) * 0.6 * rough);
  }
  const rings: Vector3[][] = [];
  for (let k = 0; k < n; k++) {
    const f = frames[k];
    const rad = radiusAt(k);
    if (!(rad >= 0)) throw new Error('limb: radius must be ≥ 0 and finite');
    const ring: Vector3[] = [];
    for (let j = 0; j < sides; j++) {
      const a = cornerAngle[j] + (k / (n - 1)) * twist;
      // A whisper of per-ring wobble: enough to keep the strips from looking
      // extruded, too little to fold them.
      const rr = rad * cornerRadius[j] * (1 + (r.next() - 0.5) * 0.16 * rough);
      ring.push(f.position.add(f.normal.scale(Math.cos(a) * rr)).add(f.binormal.scale(Math.sin(a) * rr)));
    }
    rings.push(ring);
  }
  if (o.levelBase) for (const q of rings[0]) q.y = pts[0].y;
  const tri = (a: Vector3, b: Vector3, c: Vector3, out: Vector3, fp: Paint): void => {
    if (Vector3.Dot(loopNormal([a, b, c]), out) >= 0) m.tri(a, b, c, fp);
    else m.tri(a, c, b, fp);
  };
  const paintOf = (side: number, band: number, t: number, loop: Vector3[], out: Vector3): Paint => {
    if (typeof p !== 'function') return p;
    const normal = loopNormal(loop);
    if (normal.lengthSquared() < 1e-24) return p({ limb: seed, side, band, t, normal: out.clone().normalize(), center: loop[0] });
    normal.normalize();
    if (Vector3.Dot(normal, out) < 0) normal.scaleInPlace(-1);
    const center = loop.reduce((acc, q) => acc.addInPlace(q), new Vector3()).scaleInPlace(1 / loop.length);
    return p({ limb: seed, side, band, t, normal, center });
  };
  for (let k = 0; k < n - 1; k++) {
    const mid = pts[k].add(pts[k + 1]).scale(0.5);
    for (let j = 0; j < sides; j++) {
      const a = rings[k][j];
      const b = rings[k][(j + 1) % sides];
      const c = rings[k + 1][(j + 1) % sides];
      const d = rings[k + 1][j];
      const out = a.add(b).add(c).add(d).scale(0.25).subtract(mid);
      const fp = paintOf(j, k, (k + 0.5) / (n - 1), [a, b, c, d], out);
      // Split along the shorter diagonal: the flatter pair of triangles.
      if (Vector3.DistanceSquared(a, c) < Vector3.DistanceSquared(b, d)) {
        tri(a, b, c, out, fp);
        tri(a, c, d, out, fp);
      } else {
        tri(a, b, d, out, fp);
        tri(b, c, d, out, fp);
      }
    }
  }
  const cap = (ring: Vector3[], center: Vector3, dir: Vector3, band: number, t: number): void => {
    const fp = paintOf(-1, band, t, ring, dir);
    for (let j = 0; j < sides; j++) tri(center, ring[j], ring[(j + 1) % sides], dir, fp);
  };
  if (o.capTip ?? true) cap(rings[n - 1], pts[n - 1], frames[n - 1].tangent, n - 1, 1);
  if (o.capBase) cap(rings[0], pts[0], frames[0].tangent.scale(-1), 0, 0);
}

export interface RootFlareOptions {
  /** Trunk centre on the ground (default the origin). */
  at?: Vec3;
  /** Trunk radius just above the flare. */
  radius: number;
  /** Number of root toes (default 5). */
  toes?: number;
  /** How far the toes reach from the centre (default 2.6 × radius). */
  reach?: number;
  /** Height where the roots leave the trunk (default 2.3 × radius). */
  height?: number;
  /** How far the toes are buried (default 0.1). */
  skirt?: number;
  /** Direction of the first toe, degrees about y (default seeded). */
  startDeg?: number;
  seed?: number;
}

/**
 * The broad root flare of the design sheets: buttress toes that leave the
 * trunk high up in a concave sweep, run out along the ground and dive into
 * it with a blunt nose. Each toe is a ridge with a flat back — three long
 * facets (flank, back, flank) per band over a closed sole, 34 triangles a
 * toe — whose flanks carry on down to −skirt for sloping ground. A toe
 * starts on the trunk's axis: give the trunk limb a base radius of about
 * 1.3 × `radius` and the two grow into one foot.
 */
export function rootFlare(m: SolidMesh, o: RootFlareOptions, p: LimbPaint): void {
  const at = o.at ? toV3(o.at) : new Vector3();
  const seed = o.seed ?? 1;
  const r = rng(seed, 'roots');
  const toes = Math.max(2, Math.round(o.toes ?? 5));
  const R = o.radius;
  const reach = o.reach ?? R * 2.6;
  const height = o.height ?? R * 2.3;
  const skirt = o.skirt ?? 0.1;
  const start = o.startDeg ?? r.range(0, 360);
  // Stations along a toe: [distance as a fraction of its length, ridge
  // height as a fraction of `height`, half width of the flat back, half
  // width at the ground] — widths in trunk radii. The second station sits
  // about where the toe leaves the trunk.
  const stations: readonly (readonly [number, number, number, number])[] = [
    [0.05, 1.15, 0.17, 0.3],
    [0.4, 0.8, 0.17, 0.36],
    [0.62, 0.36, 0.18, 0.4],
    [0.86, 0.14, 0.16, 0.36],
    [1.0, 0, 0.1, 0.24],
  ];
  for (let i = 0; i < toes; i++) {
    const a = (start + (i + (r.next() - 0.5) * 0.45) * (360 / toes)) * DEG;
    const dir = new Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new Vector3(dir.z, 0, -dir.x);
    const len = reach * r.range(0.82, 1.08);
    const h = height * r.range(0.82, 1.1);
    const wide = r.range(0.85, 1.2);
    // A slight sideways curl, so the toes do not radiate like spokes.
    const curl = r.range(-0.22, 0.22) * R;
    const rows = stations.map(([s, y, back, foot], k) => {
      const c = at.add(dir.scale(len * s)).add(side.scale(curl * s * s));
      const top = k === stations.length - 1 ? -skirt : h * y;
      const wb = R * back * wide;
      const wf = R * foot * wide;
      return [
        c.add(side.scale(-wf)).add(new Vector3(0, -skirt, 0)),
        c.add(side.scale(-wb)).add(new Vector3(0, top, 0)),
        c.add(side.scale(wb)).add(new Vector3(0, top, 0)),
        c.add(side.scale(wf)).add(new Vector3(0, -skirt, 0)),
      ];
    });
    const limbSeed = seed * 31 + i;
    // The inner end, inside the trunk: closed, so the toe is a solid.
    const back = dir.scale(-1);
    const bp = typeof p === 'function' ? p({ limb: limbSeed, side: 3, band: 0, t: 0, normal: back, center: rows[0][1].add(rows[0][3]).scale(0.5) }) : p;
    for (const [a3, b3, c3] of [
      [rows[0][0], rows[0][1], rows[0][2]],
      [rows[0][0], rows[0][2], rows[0][3]],
    ]) {
      if (Vector3.Dot(loopNormal([a3, b3, c3]), back) >= 0) m.tri(a3, b3, c3, bp);
      else m.tri(a3, c3, b3, bp);
    }
    for (let k = 0; k < rows.length - 1; k++) {
      const inside = at.add(dir.scale(len * (stations[k][0] + stations[k + 1][0]) * 0.5)).add(new Vector3(0, -skirt, 0));
      for (let j = 0; j < 3; j++) {
        const q = [rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]];
        const out = q[0].add(q[1]).add(q[2]).add(q[3]).scale(0.25).subtract(inside);
        const n = loopNormal(q);
        if (n.lengthSquared() < 1e-20) continue;
        n.normalize();
        if (Vector3.Dot(n, out) < 0) n.scaleInPlace(-1);
        const center = q[0].add(q[1]).add(q[2]).add(q[3]).scale(0.25);
        const fp = typeof p === 'function' ? p({ limb: limbSeed, side: j, band: k, t: (k + 0.5) / (rows.length - 1), normal: n, center }) : p;
        for (const [a3, b3, c3] of [
          [q[0], q[1], q[2]],
          [q[0], q[2], q[3]],
        ]) {
          if (Vector3.Dot(loopNormal([a3, b3, c3]), out) >= 0) m.tri(a3, b3, c3, fp);
          else m.tri(a3, c3, b3, fp);
        }
      }
      // The sole, so a toe hanging over a dip in the ground is not hollow.
      const sole = [rows[k][0], rows[k][3], rows[k + 1][3], rows[k + 1][0]];
      const down = new Vector3(0, -1, 0);
      const sp = typeof p === 'function' ? p({ limb: limbSeed, side: 3, band: k, t: (k + 0.5) / (rows.length - 1), normal: down, center: sole[0].add(sole[2]).scale(0.5) }) : p;
      for (const [a3, b3, c3] of [
        [sole[0], sole[1], sole[2]],
        [sole[0], sole[2], sole[3]],
      ]) {
        if (loopNormal([a3, b3, c3]).y <= 0) m.tri(a3, b3, c3, sp);
        else m.tri(a3, c3, b3, sp);
      }
    }
  }
}

/** Point and unit direction at fraction `t` (0..1, by length) along a
 * polyline. */
export function alongPath(path: readonly Vec3[], t: number): { point: Vector3; dir: Vector3 } {
  const pts = toV3s(path);
  if (pts.length < 2) throw new Error('alongPath: path needs at least two points');
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Vector3.Distance(pts[i - 1], pts[i]);
  let left = clamp(t, 0, 1) * total;
  for (let i = 1; i < pts.length; i++) {
    const len = Vector3.Distance(pts[i - 1], pts[i]);
    if (left <= len || i === pts.length - 1) {
      const dir = pts[i].subtract(pts[i - 1]).normalize();
      return { point: pts[i - 1].add(dir.scale(Math.min(left, len))), dir };
    }
    left -= len;
  }
  throw new Error('alongPath: unreachable');
}

/** Least distance between the sample points of polyline `path` (from
 * fraction `from` of its length on) and polyline `other`. */
export function pathClearance(path: readonly Vec3[], other: readonly Vec3[], from = 0): number {
  const b = toV3s(other);
  let best = Infinity;
  for (let i = 0; i <= 8; i++) {
    const p = alongPath(path, from + ((1 - from) * i) / 8).point;
    for (let k = 1; k < b.length; k++) {
      const ab = b[k].subtract(b[k - 1]);
      const u = clamp(Vector3.Dot(p.subtract(b[k - 1]), ab) / Math.max(ab.lengthSquared(), 1e-12), 0, 1);
      best = Math.min(best, Vector3.Distance(p, b[k - 1].add(ab.scale(u))));
    }
  }
  return best;
}

export interface BoughOptions {
  /** Unit-ish direction the bough leaves in (the parent's own direction
   * leaned toward the target is the natural choice). */
  leave: Vec3;
  /** How steeply it arrives, degrees above horizontal (default 48): the tip
   * heads outward AND up into its mass. Near 90 the bough turns straight up
   * under the foliage like a pipe elbow; near 0 it is a level beam. */
  arrive?: number;
  /** Segments (default 5 → 6 rings). */
  segments?: number;
  /** How far the two ends pull the curve, as a fraction of its length
   * (default 0.3; 0 = a straight stick). */
  bow?: number;
}

/**
 * The centre line of a bough: ONE smooth arc (a cubic Bézier) from `start`
 * — a point inside the parent — leaving along `leave` and arriving at `end`
 * heading outward and upward. Feed it to `limb` as it is. A polyline of
 * knee / elbow / tip points bends in visible corners; this cannot.
 *   const path = bough(fork.subtract(axis.scale(0.4)), seat, { leave: axis.scale(0.8).add(out.scale(0.6)) });
 *   limb(m, { path, radius: [g * 0.5, g * 0.55, g * 0.3], sides: 6, capTip: false }, WOOD);
 */
export function bough(start: Vec3, end: Vec3, o: BoughOptions): Vector3[] {
  const a = toV3(start);
  const b = toV3(end);
  const chord = b.subtract(a);
  const len = chord.length();
  if (len < 1e-6) return [a.clone(), b.clone()];
  const leave = toV3(o.leave).clone().normalize();
  const flat = new Vector3(chord.x, 0, chord.z);
  if (flat.lengthSquared() < 1e-10) flat.copyFrom(anyPerpendicular(new Vector3(0, 1, 0)));
  flat.normalize();
  const e = clamp(o.arrive ?? 48, 0, 90) * DEG;
  const arrive = flat.scale(Math.cos(e)).add(new Vector3(0, Math.sin(e), 0));
  const bow = (o.bow ?? 0.3) * len;
  return bezierPath(a, a.add(leave.scale(bow)), b.subtract(arrive.scale(bow)), b, Math.max(2, Math.round(o.segments ?? 5)));
}

/** Rise over run of the straight line between two points (∞ = vertical):
 * 0.58 ≈ 30° above level. The test for "is this branch a branch or a beam". */
export function climb(from: Vec3, to: Vec3): number {
  const a = toV3(from);
  const b = toV3(to);
  return (b.y - a.y) / Math.max(1e-9, Math.hypot(b.x - a.x, b.z - a.z));
}

export interface BarkShade {
  seed?: number;
  /** Height below which facets lean dark (root crotches), default 0.35. */
  rootHeight?: number;
  /** Default 0.1. */
  gloss?: number;
  /** Crease angle, degrees (default 16): the two triangles of a strip facet
   * and the gentle bends along a flute shade as one plane, the edges between
   * flutes (60° on a six-sided trunk) stay crisp. */
  smooth?: number;
}

/** Tone of one bark facet: its FLUTE picks base, a lighter or a deeper tone
 * and keeps it from base to tip; upward facets lean light, undersides and
 * facets near the ground lean deep. `key` identifies the flute. */
export function barkColor(tones: BarkTones, n: Vector3, center: Vector3, key: readonly [number, number, number], o: BarkShade = {}): RGB {
  const seed = o.seed ?? 0;
  const k = hash3(key[0], key[1], 0, seed + 77);
  // Most flutes stay in the base tone: the sun and the sky do the light and
  // dark sides. One in six is a lighter plank, one in six a deeper one.
  let tone = k < 0.16 ? mixOklab(tones.base, tones.light, 0.4) : k > 0.84 ? mixOklab(tones.base, tones.dark, 0.45) : tones.base;
  tone = mixOklab(tone, tones.light, clamp(n.y, 0, 1) * 0.55);
  tone = mixOklab(tone, tones.dark, clamp(-n.y, 0, 1) * 0.3);
  tone = mixOklab(tone, tones.dark, (1 - smoothstep(0, o.rootHeight ?? 0.35, center.y)) * 0.4);
  // A hair of difference between the bands of one flute.
  return adjustOklch(tone, (hash3(key[0], key[1], key[2], seed + 78) - 0.5) * 0.024);
}

/**
 * The wood paint for `limb` and `rootFlare`: matte, one tone per strip
 * facet (see `barkColor`). A material pattern, not baked light — it turns
 * with the tree.
 */
export function barkPaint(tones: BarkTones, o: BarkShade = {}): (facet: LimbFacet) => Paint {
  const surface = { gloss: o.gloss ?? 0.1, smooth: o.smooth ?? 16 };
  return (f) => paint(barkColor(tones, f.normal, f.center, [f.limb, f.side, f.band], o), surface);
}

/**
 * The same bark rule as a post-pass over triangles `from` … `to`, for wood
 * built from kit primitives (a `frustum` stump, a `box` plank). The tone is
 * keyed on the facet's DIRECTION and a coarse cell, so the triangles of one
 * flat face agree. Limbs and roots do not need it: `barkPaint` shades them.
 */
export function shadeBark(m: SolidMesh, tones: BarkTones, o: BarkShade & { from?: number; to?: number } = {}): void {
  const from = o.from ?? 0;
  const to = o.to ?? m.triangleCount;
  let t = from;
  m.repaint((c, n, old) => {
    if (t++ >= to) return;
    const key: [number, number, number] = [Math.round(n.x * 4) + 16 * Math.round(n.z * 4), Math.round(n.y * 4) + 16 * Math.round(c.y * 1.5), 0];
    return paint(old, { color: barkColor(tones, n, c, key, o) });
  }, from);
}

// ---------------------------------------------------------------------------
// Rock

export interface RockChunkOptions extends MoundOptions {
  /** Where the chunk stands: [x, lift, z]. Keep lift at 0 unless the chunk
   * sits on another one. */
  at?: Vec3;
  /** Turn about y, degrees. */
  yaw?: number;
  /**
   * Lean the whole chunk: `deg` degrees toward compass direction `toward`
   * (degrees about y, 0 = +z, 90 = +x). A shear, so the foot stays where it
   * is: the flank on that side stands up steeper by `deg`, the opposite one
   * lies back by `deg`. A few degrees give a stone a direction; keep it
   * under the foot band's pitch or the steep side overhangs. (It does NOT
   * make a tall stone squat — the sloping `top` does.)
   */
  lean?: { deg: number; toward: number };
  /**
   * The broad top plane, sloping `tilt` degrees down toward compass
   * direction `toward`, and the plane the flanks hang from (see
   * `MoundOptions.slope`). Its HIGH corner is the top of the chunk (y =
   * `radii.y`) and sits `crown` of the radius up-slope of the centre; how
   * far down the other side it reaches follows from the tilt. On a chunk
   * about as tall as it is wide: 30–35° with `crown` 0.6–0.7 = a wedge with
   * the plane over 40 % of the plan; 12–20° = a block with a tilted lid;
   * 0 = a level table (slabs, terraces). Every chunk should have one.
   */
  top?: {
    tilt?: number;
    toward?: number;
    /** Cut the summit off with a second, nearly level plane: this fraction
     * of the height that the tilted plane alone would reach (default 0;
     * 0.1–0.15 on a wedge, whose summit is otherwise a knife edge seen from
     * behind). The chunk still ends at `radii.y`. */
    crest?: number;
  };
  /**
   * Bevel round the top plane, meters: one width for every edge, or
   * [min, max] to give each edge its own (seeded) and leave about a third
   * of them crisp. A uniform bevel rings the plane like the table of a cut
   * gem, and one under ~4 % of the chunk's width reads as a drawn outline —
   * use a range of 4–10 % on anything larger than a pebble. Bevels that
   * stay within ~35° of level are painted with the cream (they are the
   * extra facets of the cap), steeper ones pale lavender. Needs `top`.
   */
  rim?: number | readonly [number, number];
  /** Clip this many random corners (see `Polytope.clip`), each about
   * `clipSize` deep (default 10 % of the smaller half extent). */
  clips?: number;
  clipSize?: number;
}

/**
 * One convex rock chunk standing on the ground: a `Polytope.mound`, leaned,
 * cut by its broad top plane, bevelled and corner-clipped, fitted to `radii`
 * = [half width, height, half depth], turned and placed. A boulder is 1–3 of
 * these sharing volume; a slab is a low chunk; a wedge is a chunk with a steep top tilt; a pebble
 * is a small one (own `rings` optional, default `BOULDER_RINGS`).
 */
export function rockChunk(o: RockChunkOptions): Polytope {
  const R = toV3(o.radii);
  // The crest cut takes its share off the top: build that much taller.
  const crest = o.top ? clamp(o.top.crest ?? 0, 0, 0.4) : 0;
  const tall = R.y / (1 - crest);
  const p = Polytope.mound({
    ...o,
    radii: [R.x, tall, R.z],
    slope: o.slope ?? (o.top?.tilt ? { tilt: o.top.tilt, toward: o.top.toward ?? 0 } : undefined),
  });
  const seed = o.seed ?? 1;
  if (o.lean && o.lean.deg) {
    const k = Math.tan(o.lean.deg * DEG);
    const a = o.lean.toward * DEG;
    // x += kx·y, z += kz·y.
    p.transform(Matrix.FromValues(1, 0, 0, 0, k * Math.sin(a), 1, k * Math.cos(a), 0, 0, 0, 1, 0, 0, 0, 0, 1));
  }
  if (o.top) {
    const tilt = (o.top.tilt ?? 0) * DEG;
    const toward = (o.top.toward ?? 0) * DEG;
    const plane = (t: number): Vector3 => new Vector3(Math.sin(toward) * Math.sin(t), Math.cos(t), Math.cos(toward) * Math.sin(t));
    const n = plane(tilt);
    // Through the corner of the lid that lies furthest up the slope: the
    // plane then removes the whole lid and that corner stays the summit.
    let through: Vector3 | null = null;
    for (const f of p.faces) {
      for (const q of f.points) {
        if (q.y > tall - 1e-6 && (!through || Vector3.Dot(n, q) < Vector3.Dot(n, through))) through = q;
      }
    }
    if (through) {
      p.cut(n, through, 'top');
      // The crest: a second, nearly level plane takes the knife edge off
      // the summit and gives the cream cap its second facet.
      if (crest > 0) p.cut(plane(tilt * 0.25), [through.x, R.y, through.z], 'top');
    }
    // tilt 0: the lid itself is the top plane.
    for (const f of p.faces) if (f.tag === 'crown' && f.normal.y > 0.9999) f.tag = 'top';
  }
  p.fitBox(R).tidy();
  if (o.top && o.rim) {
    if (typeof o.rim === 'number') p.bevel('top', o.rim);
    else {
      const [lo, hi] = o.rim;
      const r = rng(seed, 'rim');
      p.bevel('top', () => (r.chance(0.35) ? 0 : r.range(lo, hi)));
    }
  }
  if (o.clips) p.clip({ count: o.clips, size: o.clipSize ?? Math.min(R.x, R.z) * 0.1, seed, above: R.y * 0.2 });
  if (o.yaw) p.turn('y', o.yaw);
  if (o.at) p.move(o.at);
  return p;
}

export interface StoneShade {
  seed?: number;
  /** Untagged faces whose normal rises above this are cream top planes too
   * (default 0.82 ≈ within 35° of level). */
  topAbove?: number;
  /** … and above this, chamfers in the pale rim tone (default 0.5). */
  rimAbove?: number;
  /** How much of the cream this chunk gets, 0..1 (default 1). 0 for a
   * secondary lump under the hero top plane: its top stays pale lavender,
   * so the stone has ONE cream plane. */
  cream?: number;
  /** Height of the whole stone: faces whose centre lies in its lowest third
   * lean toward the deeper `low` tone (`emitRock` fills it in). */
  height?: number;
  /** Default 0.08. */
  gloss?: number;
  /** Tones this chunk uses instead of the stone's own (a mauve shoulder on
   * a lavender boulder: `{ side: tones.warm }`). */
  tones?: Partial<StoneTones>;
}

/**
 * Paint function for `Polytope.emit`: the cream top plane and those of its
 * bevels that stay near level (the sheet's cream cap is several facets),
 * pale lavender for the steeper bevels and the chamfer band under the top,
 * lavender / slate / mauve flanks chosen per PLANE (keyed on the face
 * normal, so a face keeps one colour however it was split or triangulated),
 * a deeper violet toward the foot and on ground-leaning faces, groove walls
 * in the crevice tone. The warm top is a material region by face normal and
 * tag, as the style guide asks — it turns with the rock.
 */
export function stonePaint(stone: StoneTones, o: StoneShade = {}): (face: PolyFace) => Paint | null {
  const tones: StoneTones = { ...stone, ...o.tones };
  const seed = o.seed ?? 0;
  const topAbove = o.topAbove ?? 0.82;
  const rimAbove = Math.min(o.rimAbove ?? 0.5, topAbove);
  const cream = clamp(o.cream ?? 1, 0, 1);
  const surface = { gloss: o.gloss ?? 0.08, smooth: 0 };
  // The top of a chunk without cream is a sunlit FLANK — lavender a step
  // toward the rim tone. Painted as pale as a rim it reads as a second lid:
  // a block set beside the stone instead of a bulge of it.
  const pale = mixOklab(tones.side, tones.rim, 0.5);
  return (face) => {
    const n = face.normal;
    const k = hash3(Math.round(n.x * 9), Math.round(n.y * 9), Math.round(n.z * 9), seed + 5);
    const k2 = hash3(Math.round(n.x * 9), Math.round(n.y * 9), Math.round(n.z * 9), seed + 11);
    let c: RGB;
    if (face.tag === 'groove') c = tones.crevice;
    else if (face.tag === 'top') c = mixOklab(pale, tones.top, cream);
    // Bevels of the top plane that stay within ~35° of level belong to the
    // cream cap (the sheet's cream is four or five facets, not one polygon);
    // steeper ones are the pale lavender band under its edge.
    else if (face.tag === 'rim') c = n.y >= topAbove ? mixOklab(pale, adjustOklch(tones.top, (k2 - 0.5) * 0.04), cream) : mixOklab(pale, tones.rim, cream);
    else if (n.y >= topAbove) c = mixOklab(pale, adjustOklch(tones.top, (k - 0.5) * 0.03), cream);
    else if (n.y >= rimAbove) c = mixOklab(pale, tones.rim, cream);
    // The chamfer band under the top is pale as a MATERIAL region, whatever
    // its pitch: on the tall side of a wedge that band stands nearly as
    // steep as the wall, and a stone seen from behind still needs its light
    // upper planes.
    else if (face.tag === 'shoulder' || face.tag === 'crown') c = mixOklab(tones.side, tones.rim, 0.3 + 0.45 * cream);
    else {
      c = k < 0.42 ? tones.side : k < 0.75 ? tones.alt : tones.warm;
      c = mixOklab(c, tones.rim, smoothstep(0.25, rimAbove, n.y) * 0.4);
      c = mixOklab(c, tones.low, smoothstep(0.0, -0.45, n.y) * 0.8);
      // Faces standing on the ground lean to the foot tone.
      if (o.height) c = mixOklab(c, tones.low, (1 - smoothstep(0.08, 0.42, faceCenter(face).y / o.height)) * 0.4);
      c = adjustOklch(c, (k - 0.5) * 0.035);
    }
    return paint(c, surface);
  };
}

/**
 * Emit rock chunks as one stone: shaded by `stonePaint`, faces buried in a
 * neighbouring chunk dropped. `shade` may be a function of the chunk index
 * when chunks differ (`(i) => (i === 2 ? { cream: 0 } : {})`).
 */
export function emitRock(
  m: SolidMesh,
  chunks: readonly Polytope[],
  tones: StoneTones,
  shade: StoneShade | ((index: number) => StoneShade) = {},
): void {
  let height = 0;
  for (const c of chunks) height = Math.max(height, c.bounds().max.y);
  chunks.forEach((c, i) => c.emit(m, stonePaint(tones, { height, ...(typeof shade === 'function' ? shade(i) : shade) }), chunks));
}

// ---------------------------------------------------------------------------
// Blades, leaves, fronds, flowers

export interface ArchOptions {
  /** Root of the blade. */
  from: Vec3;
  /** Compass heading it grows toward, degrees about y (0 = +z, 90 = +x). */
  yaw: number;
  /** Length along the curve, meters. */
  length: number;
  /** Elevation at the root, degrees above horizontal (90 = straight up). */
  lift: number;
  /** Total downward bend from root to tip, degrees (positive droops). */
  droop: number;
  /** Stations = segments + 1 (default 4 segments). */
  segments?: number;
  /** > 1 keeps the base straight and bends near the tip (default 1.4). */
  bias?: number;
}

/** The arching centre line of a blade, leaf or frond: leaves the root at
 * `lift` and bends over by `droop`. Planar, so it frames cleanly. */
export function archPath(o: ArchOptions): Vector3[] {
  const n = Math.max(1, Math.round(o.segments ?? 4));
  const yaw = o.yaw * DEG;
  const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const step = o.length / n;
  const out = [toV3(o.from).clone()];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const pitch = (o.lift - o.droop * Math.pow(t, o.bias ?? 1.4)) * DEG;
    const last = out[out.length - 1];
    out.push(last.add(dir.scale(Math.cos(pitch) * step)).add(new Vector3(0, Math.sin(pitch) * step, 0)));
  }
  return out;
}

export interface BladeColors {
  /** Top surface at the root and at the tip (gradient between). */
  base: RGB;
  tip: RGB;
  /** Underside (default: the top colours). */
  under?: RGB;
  /** Colour of a crisp strip along both edges (a succulent's lime rim).
   * Costs two extra quads per segment; width = `edgeWidth`. */
  edge?: RGB;
  /** Colour of the centre line when `fold` is set (a palm frond's midrib). */
  rib?: RGB;
}

export interface BladeOptions {
  /** Centre line, root → tip. */
  path: readonly Vec3[];
  /** FULL width at each path point: one number, an array (same length as
   * `path`), or a function of t = 0 … 1. Width 0 ends in a point. */
  width: number | readonly number[] | ((t: number) => number);
  /** Roughly where the TOP surface faces (default +y). For an upright blade
   * pass the outward direction. */
  face?: Vec3;
  /** Centre line raised (+, a tent ridge) or sunk (−, a V channel) by this
   * fraction of the half width. 0 = flat. A fold makes a card read as a
   * solid leaf from every angle. */
  fold?: number;
  /** Width of the `colors.edge` strip, as a fraction of the half width
   * (default 0.22). */
  edgeWidth?: number;
  /** Keel depth under the centre line at the widest station, meters. 0 =
   * a two-sided card; > 0 = a closed solid (succulent leaves, palm fronds
   * seen up close). */
  thickness?: number;
  /** Default 0.35. */
  gloss?: number;
  /** Crease angle (default 50: smooth along the blade, crisp at the fold). */
  smooth?: number;
}

/**
 * A blade / leaf / frond surface along a path, always visible from both
 * sides. Triangles per segment: 4 (flat card), 8 (folded card or solid),
 * +4 with an edge strip.
 *   blade(m, { path: archPath({ from: [0, 0, 0], yaw: 40, length: 0.7, lift: 80, droop: 110 }),
 *              width: (t) => 0.09 * Math.sin(Math.PI * Math.pow(t, 0.6)), fold: -0.35 },
 *         { base: FOLIAGE.jade, tip: FOLIAGE.highlight });
 */
export function blade(m: SolidMesh, o: BladeOptions, colors: BladeColors): void {
  const pts = toV3s(o.path);
  const n = pts.length;
  if (n < 2) throw new Error('blade: path needs at least two points');
  const widthAt = (k: number): number => {
    if (typeof o.width === 'number') return o.width;
    if (typeof o.width === 'function') return o.width(k / (n - 1));
    if (o.width.length !== n) throw new Error('blade: width array must match the path length');
    return o.width[k];
  };
  const face = o.face ? toV3(o.face).clone().normalize() : new Vector3(0, 1, 0);
  const chord = pts[n - 1].subtract(pts[0]);
  let side0 = Vector3.Cross(face, chord);
  if (side0.lengthSquared() < 1e-10 * chord.lengthSquared()) side0 = Vector3.Cross(face, pts[Math.min(n - 1, 1)].subtract(pts[0]));
  if (side0.lengthSquared() < 1e-14) side0 = anyPerpendicular(face);
  side0.normalize();
  const fold = o.fold ?? 0;
  const thickness = o.thickness ?? 0;
  const edgeWidth = clamp(o.edgeWidth ?? 0.22, 0, 0.9);
  const rimmed = colors.edge !== undefined && edgeWidth > 0;
  const p = paint(colors.base, { gloss: o.gloss ?? 0.35, smooth: o.smooth ?? 50 });
  let wMax = 0;
  for (let k = 0; k < n; k++) wMax = Math.max(wMax, widthAt(k));
  if (!(wMax > 0)) throw new Error('blade: width is zero everywhere');

  interface Station {
    L: Vector3;
    R: Vector3;
    T: Vector3;
    Li: Vector3;
    Ri: Vector3;
    K: Vector3;
    N: Vector3;
    tan: Vector3;
    top: RGB;
    under: RGB;
    edge: RGB;
    rib: RGB;
    w: number;
  }
  const st: Station[] = [];
  for (let k = 0; k < n; k++) {
    const tan = pts[Math.min(n - 1, k + 1)].subtract(pts[Math.max(0, k - 1)]).normalize();
    let side = side0.subtract(tan.scale(Vector3.Dot(side0, tan)));
    if (side.lengthSquared() < 1e-12) side = anyPerpendicular(tan);
    side.normalize();
    const N = Vector3.Cross(tan, side);
    const w = Math.max(0, widthAt(k)) / 2;
    const t = k / (n - 1);
    const top = mixOklab(colors.base, colors.tip, t);
    const under = colors.under ? mixOklab(colors.under, top, 0.25) : top;
    const L = pts[k].subtract(side.scale(w));
    const R = pts[k].add(side.scale(w));
    const T = pts[k].add(N.scale(fold * w));
    st.push({
      L,
      R,
      T,
      Li: Vector3.Lerp(L, T, edgeWidth),
      Ri: Vector3.Lerp(R, T, edgeWidth),
      K: pts[k].subtract(N.scale(thickness * (w / (wMax / 2)))),
      N,
      tan,
      top,
      under,
      edge: colors.edge ?? top,
      rib: colors.rib ?? top,
      w,
    });
  }
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, cols: [RGB, RGB, RGB, RGB], dir: Vector3): void => {
    if (Vector3.Dot(loopNormal([a, b, c, d]), dir) >= 0) m.quad(a, b, c, d, p, cols);
    else m.quad(a, d, c, b, p, [cols[0], cols[3], cols[2], cols[1]]);
  };
  for (let k = 0; k < n - 1; k++) {
    const a = st[k];
    const b = st[k + 1];
    const up = a.N.add(b.N);
    const down = up.scale(-1);
    if (rimmed) {
      // A solid-colour strip along each edge, then the face.
      quad(a.L, a.Li, b.Li, b.L, [a.edge, a.edge, b.edge, b.edge], up);
      quad(a.Ri, a.R, b.R, b.Ri, [a.edge, a.edge, b.edge, b.edge], up);
      if (fold !== 0) {
        quad(a.Li, a.T, b.T, b.Li, [a.top, a.rib, b.rib, b.top], up);
        quad(a.T, a.Ri, b.Ri, b.T, [a.rib, a.top, b.top, b.rib], up);
      } else {
        quad(a.Li, a.Ri, b.Ri, b.Li, [a.top, a.top, b.top, b.top], up);
      }
    } else if (fold !== 0) {
      quad(a.L, a.T, b.T, b.L, [a.top, a.rib, b.rib, b.top], up);
      quad(a.T, a.R, b.R, b.T, [a.rib, a.top, b.top, b.rib], up);
    } else {
      quad(a.L, a.R, b.R, b.L, [a.top, a.top, b.top, b.top], up);
    }
    const ue = colors.edge ? [mixOklab(a.under, a.edge, 0.5), mixOklab(b.under, b.edge, 0.5)] : [a.under, b.under];
    if (thickness > 0) {
      quad(a.L, a.K, b.K, b.L, [ue[0], a.under, b.under, ue[1]], down);
      quad(a.K, a.R, b.R, b.K, [a.under, ue[0], ue[1], b.under], down);
    } else if (fold !== 0) {
      quad(a.L, a.T, b.T, b.L, [ue[0], a.under, b.under, ue[1]], down);
      quad(a.T, a.R, b.R, b.T, [a.under, ue[0], ue[1], b.under], down);
    } else {
      quad(a.L, a.R, b.R, b.L, [ue[0], ue[0], ue[1], ue[1]], down);
    }
  }
  if (thickness > 0) {
    // A solid needs its ends closed where it does not come to a point.
    const end = (s: Station, dir: Vector3): void => {
      if (s.w < 1e-6) return;
      quad(s.L, s.T, s.R, s.K, [s.under, s.under, s.under, s.under], dir);
    };
    end(st[0], st[0].tan.scale(-1));
    end(st[n - 1], st[n - 1].tan);
  }
}

export interface LeafOptions extends Omit<BladeOptions, 'path' | 'width'> {
  /** Root and tip of the leaf. */
  from: Vec3;
  to: Vec3;
  /** Widest FULL width. */
  width: number;
  /** Where along the leaf it is widest, 0..1 (default 0.42: ovate). */
  belly?: number;
  /** How far the middle of the leaf bows toward `face`, as a fraction of
   * its length (default 0.12; negative bows away). */
  arch?: number;
  /** Segments along the leaf (default 3). */
  segments?: number;
}

/** One broad pointed leaf between two points (rosette leaves, the base
 * leaves of flowers, fern leaflets with `segments: 2`). */
export function leaf(m: SolidMesh, o: LeafOptions, colors: BladeColors): void {
  const a = toV3(o.from);
  const b = toV3(o.to);
  const seg = Math.max(2, Math.round(o.segments ?? 3));
  const face = o.face ? toV3(o.face).clone().normalize() : new Vector3(0, 1, 0);
  const length = Vector3.Distance(a, b);
  const belly = clamp(o.belly ?? 0.42, 0.15, 0.85);
  const arch = (o.arch ?? 0.12) * length;
  const path: Vector3[] = [];
  const width: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    path.push(Vector3.Lerp(a, b, t).add(face.scale(Math.sin(Math.PI * t) * arch)));
    // Ovate outline: a quarter sine up to the belly, an ellipse arc down to
    // the tip.
    const w = t < belly ? Math.sin((t / belly) * Math.PI * 0.5) : Math.sqrt(Math.max(0, 1 - ((t - belly) / (1 - belly)) ** 2));
    width.push(o.width * Math.max(0, w));
  }
  // The root keeps a little width so the leaf joins its stem as a stalk.
  width[0] = o.width * 0.18;
  blade(m, { ...o, path, width, face }, colors);
}

export interface FrondOptions extends Omit<BladeOptions, 'path' | 'width'> {
  /** Centre line (rachis), root → tip; `archPath` output or any polyline. */
  path: readonly Vec3[];
  /** Widest FULL width of the frond. */
  width: number;
  /** Saw-tooth notches per side (default 4; 0 = a plain tapered blade). */
  notches?: number;
  /** How deep a notch cuts, as a fraction of the local width (default 0.45). */
  notchDepth?: number;
  /** Where the frond is widest, 0..1 (default 0.4). */
  belly?: number;
}

/**
 * A notched frond: one blade whose outline steps in at each notch and
 * widens again, so the lobes point toward the tip (palm fronds; with
 * `fold: 0` and `thickness: 0` also the cheapest fern frond). Each notch
 * adds one station.
 */
export function frond(m: SolidMesh, o: FrondOptions, colors: BladeColors): void {
  const src = toV3s(o.path);
  if (src.length < 2) throw new Error('frond: path needs at least two points');
  // Arc-length lookup on the source polyline.
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + Vector3.Distance(src[i - 1], src[i]));
  const total = cum[cum.length - 1];
  const at = (t: number): Vector3 => {
    const s = clamp(t, 0, 1) * total;
    let i = 1;
    while (i < src.length - 1 && cum[i] < s) i++;
    const span = cum[i] - cum[i - 1] || 1;
    return Vector3.Lerp(src[i - 1], src[i], (s - cum[i - 1]) / span);
  };
  const belly = clamp(o.belly ?? 0.4, 0.15, 0.85);
  const envelope = (t: number): number =>
    o.width * (t < belly ? 0.3 + 0.7 * Math.sin((t / belly) * Math.PI * 0.5) : Math.sqrt(Math.max(0, 1 - ((t - belly) / (1 - belly)) ** 2)));
  const notches = Math.max(0, Math.round(o.notches ?? 4));
  const depth = o.notchDepth ?? 0.45;
  const ts: number[] = [0];
  const ws: number[] = [envelope(0) * 0.6];
  const first = 0.16;
  const last = 0.9;
  for (let i = 0; i < notches; i++) {
    const t = first + ((i + 1) / (notches + 0.4)) * (last - first);
    // Wide lobe tip, then the cut just beyond it.
    ts.push(t - 0.012, t + 0.012);
    ws.push(envelope(t), envelope(t) * (1 - depth));
  }
  if (notches === 0) {
    ts.push(belly * 0.6, belly, (1 + belly) / 2);
    ws.push(envelope(belly * 0.6), envelope(belly), envelope((1 + belly) / 2));
  }
  ts.push(1);
  ws.push(0);
  blade(m, { ...o, path: ts.map(at), width: ws }, colors);
}

export interface FlowerOptions {
  /** Centre of the bloom. */
  at: Vec3;
  /** Direction the flower looks (default straight up). */
  facing?: Vec3;
  /** Tip radius of the petals. */
  radius: number;
  /** Default 6 (the design sheet's count). */
  petals?: number;
  /** Petal lift out of the flower's plane, degrees (default 12). */
  cup?: number;
  /** Petal width as a fraction of the spacing between petals (default 0.95:
   * just touching). */
  fullness?: number;
  /** Height of the puffy middle of each petal, fraction of radius (default 0.1). */
  puff?: number;
  /** Centre button radius, fraction of radius (default 0.26). */
  center?: number;
  /** Rotation of the petal ring, degrees. */
  spin?: number;
}

/**
 * A chunky toy flower: rounded petals as small closed solids with a puffed
 * top, and a faceted yellow button. 8 triangles per petal + 12 for the
 * centre (60 for six petals).
 */
export function flower(m: SolidMesh, o: FlowerOptions, tones: FlowerTones): void {
  const c = toV3(o.at);
  const axis = o.facing ? toV3(o.facing).clone().normalize() : new Vector3(0, 1, 0);
  const u = anyPerpendicular(axis);
  const w = Vector3.Cross(axis, u);
  const count = Math.max(3, Math.round(o.petals ?? 6));
  const R = o.radius;
  const cup = (o.cup ?? 12) * DEG;
  const half = (Math.PI / count) * (o.fullness ?? 0.95);
  const puff = (o.puff ?? 0.1) * R;
  const top = paint(tones.petal, { gloss: 0.35, smooth: 0 });
  const under = paint(tones.petalDeep, { gloss: 0.25, smooth: 0 });
  for (let i = 0; i < count; i++) {
    const a = ((o.spin ?? 0) * DEG) + (i / count) * Math.PI * 2;
    const radial = u.scale(Math.cos(a)).add(w.scale(Math.sin(a)));
    const tang = Vector3.Cross(axis, radial);
    // Petal frame tipped up by the cup angle.
    const out = radial.scale(Math.cos(cup)).add(axis.scale(Math.sin(cup)));
    const up = axis.scale(Math.cos(cup)).subtract(radial.scale(Math.sin(cup)));
    const at = (r: number, s: number, h = 0): Vector3 => c.add(out.scale(r * R)).add(tang.scale(s * R * Math.tan(half))).add(up.scale(h));
    const outline = [at(0.12, -0.1), at(0.6, -0.62), at(0.94, -0.36), at(0.94, 0.36), at(0.6, 0.62), at(0.12, 0.1)];
    const apex = at(0.58, 0, puff);
    for (let k = 0; k < outline.length; k++) {
      const p0 = outline[k];
      const p1 = outline[(k + 1) % outline.length];
      if (Vector3.Dot(loopNormal([apex, p0, p1]), up) >= 0) m.tri(apex, p0, p1, top);
      else m.tri(apex, p1, p0, top);
    }
    const rev = Vector3.Dot(loopNormal(outline), up) >= 0 ? [...outline].reverse() : outline;
    m.fan(rev, under);
  }
  // Centre button: a low six-sided dome, closed underneath by the petals.
  const button = paint(tones.center, { gloss: 0.4, smooth: 0 });
  const cr = (o.center ?? 0.26) * R;
  const tip = c.add(axis.scale(cr * 0.75));
  const mid: Vector3[] = [];
  const rim: Vector3[] = [];
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2;
    const d = u.scale(Math.cos(a)).add(w.scale(Math.sin(a)));
    rim.push(c.add(d.scale(cr)).subtract(axis.scale(cr * 0.15)));
    mid.push(c.add(d.scale(cr * 0.8)).add(axis.scale(cr * 0.45)));
  }
  const facing = (a: Vector3, b: Vector3, d: Vector3, e: Vector3 | null, dir: Vector3): void => {
    const loop = e ? [a, b, d, e] : [a, b, d];
    const ok = Vector3.Dot(loopNormal(loop), dir) >= 0;
    if (e) {
      if (ok) m.quad(a, b, d, e, button);
      else m.quad(a, e, d, b, button);
    } else if (ok) m.tri(a, b, d, button);
    else m.tri(a, d, b, button);
  };
  for (let j = 0; j < 6; j++) {
    const k = (j + 1) % 6;
    const dir = rim[j].add(rim[k]).scale(0.5).subtract(c).add(axis.scale(cr * 0.3));
    facing(rim[j], rim[k], mid[k], mid[j], dir);
    facing(mid[j], mid[k], tip, null, axis);
  }
}

// ---------------------------------------------------------------------------
// Finishing: pose, size, wind

/**
 * Lean everything from triangle `from` on by `deg` degrees toward compass
 * direction `toward` (degrees about y, 0 = +z, 90 = +x), pivoting on the
 * origin (the ground contact). It tips the foot too, lifting one side of the
 * roots: keep it under ~8° and call it BEFORE `fitSize`; for a stronger lean
 * bend the trunk's path instead (the oak does).
 */
export function lean(m: SolidMesh, deg: number, toward: number, from = 0): void {
  if (!deg) return;
  const a = toward * DEG;
  // Rotating about the horizontal axis 90° clockwise of `toward` tips +y
  // toward it.
  m.rotate([Math.cos(a), 0, -Math.sin(a)], deg, from, [0, 0, 0]);
}

export interface FitOptions {
  /** Move the footprint's centre onto the origin first (default true; false
   * for trees, whose origin is the trunk base, not the canopy's centre). */
  recenter?: boolean;
  /** First triangle (default 0 = the whole mesh). */
  from?: number;
  /** Take `size.y` as the height above ground as it is, with no allowance
   * for the skirt (default false). For an asset that has worked out its own
   * box, skirt included. */
  exact?: boolean;
}

/**
 * Scale the mesh so its bounding box is exactly `size` — width and depth
 * over everything, height from the ground (y = 0) to the top; the skirt
 * below ground is extra. This is what guarantees the lab's size band for the
 * hero and, with `v.size(...)`, for every variant, however the random parts
 * fell. Up to ~15 % of non-uniform stretch is invisible on organic shapes;
 * if the correction is larger, fix the layout instead.
 *
 * The lab measures the box INCLUDING the skirt, so on small props a deep
 * skirt alone can break the 8 % band: here the top is lowered just enough to
 * keep (height + skirt) within 6 % of the target.
 */
export function fitSize(m: SolidMesh, size: { x: number; y: number; z: number }, o: FitOptions = {}): Fit {
  const from = o.from ?? 0;
  let b = m.bounds(from);
  const shift: [number, number, number] = [0, 0, 0];
  if (o.recenter ?? true) {
    shift[0] = -(b.min.x + b.max.x) / 2;
    shift[2] = -(b.min.z + b.max.z) / 2;
    m.translate(shift, from);
    b = m.bounds(from);
  }
  const skirt = Math.max(0, -b.min.y);
  const top = o.exact ? size.y : Math.max(size.y * 0.5, Math.min(size.y, size.y * 1.06 - skirt));
  const scale: [number, number, number] = [size.x / (b.max.x - b.min.x), top / b.max.y, size.z / (b.max.z - b.min.z)];
  // Height: stretch only what is above ground, the skirt keeps its depth.
  m.displace((p) => [p.x * scale[0], p.y > 0 ? p.y * scale[1] : p.y, p.z * scale[2]], from);
  return { shift, scale };
}

/** What `fitSize` did: a point p of the unfitted model ended up at
 * (p + shift) × scale. Use it to carry colliders along. */
export interface Fit {
  shift: [number, number, number];
  scale: [number, number, number];
}

/** Map a point of the unfitted model through a `Fit`. */
export function fitPoint(f: Fit, p: readonly [number, number, number]): [number, number, number] {
  return [(p[0] + f.shift[0]) * f.scale[0], (p[1] + f.shift[1]) * f.scale[1], (p[2] + f.shift[2]) * f.scale[2]];
}

export interface SwayOptions {
  /** Height (m) below which nothing moves: the trunk, the root of a clump. */
  from: number;
  /** Height at which the weight reaches `max` (default: the top of the mesh). */
  to?: number;
  /** Weight at the top (default: scaled with height — a 5 m tree gets 1 =
   * ±0.22 m, a 0.6 m grass tuft 0.18 = ±4 cm). */
  max?: number;
  /** > 1 keeps the lower part stiffer (default 1.5). */
  power?: number;
}

/**
 * Wind weights for the WHOLE plant as one function of height, so everything
 * at the same place moves together (branch tips stay inside their blobs).
 * Call it last; the asset needs `wind: true`.
 */
export function sway(m: SolidMesh, o: SwayOptions): void {
  const b = m.bounds();
  const to = o.to ?? b.max.y;
  const max = o.max ?? clamp(b.max.y * 0.3, 0.08, 1);
  const power = o.power ?? 1.5;
  m.setWind((p) => max * Math.pow(clamp((p.y - o.from) / Math.max(1e-6, to - o.from), 0, 1), power));
}
