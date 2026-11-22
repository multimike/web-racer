import { adjustOklch, darken, jitterColor, lighten, mix, paint, rng } from '../../../gfx/solid';
import type { Paint, RGB, Rng } from '../../../gfx/solid';
import { BARK, BUILDING, FLOWERS, FOLIAGE } from '../../palette';

/**
 * Scheme palettes and seeded detail variation for the village buildings.
 *
 * A building never names a colour: it asks for the scheme's NAMED PAINTS
 * (`P.wall`, `P.roof`, `P.trim` …) so that the same geometry repaints into
 * the three combinations of the style guide:
 *
 *   warm     cream walls,     coral roof,  teal frames / shutters / door
 *   coastal  turquoise walls, cobalt roof, cream frames, coral door
 *   sunny    mustard walls,   teal roof,   teal frames,  coral door
 *
 * Stone, timber and the cream trim are the same in every scheme — that is
 * what holds the village together (style guide: "keep stone, timber and
 * cream trim consistent").
 */

export type SchemeName = 'warm' | 'coastal' | 'sunny';
export const SCHEMES: readonly SchemeName[] = ['warm', 'coastal', 'sunny'];

export interface BuildingPaints {
  scheme: SchemeName;
  /** Main plaster / board colour of the body. */
  wall: Paint;
  /** Second wall colour of the scheme (upper storey, annex, gable infill). */
  wallAlt: Paint;
  /** The village's thick cream trim: fascia, bargeboards, sills, surrounds, steps. */
  trim: Paint;
  /** Seamed roof metal. */
  roof: Paint;
  /** Second roof colour (ridge rolls, canopy, awning stripe partner). */
  roofAlt: Paint;
  door: Paint;
  shutter: Paint;
  /** Window frames and mullions. */
  frame: Paint;
  /** Structural timber: posts, beams, braces, pergolas. */
  timber: Paint;
  /** Recessed timber: gable infill boards, soffits, shadowed planks. */
  timberDark: Paint;
  /** Lavender plinth blocks: base, a lighter and a darker block, and the
   * dark joint colour between them. */
  stone: Paint;
  stoneLight: Paint;
  stoneDark: Paint;
  /** Bright exposed metal: knobs, rails, hinges, lamp cages. */
  metal: Paint;
  /** Dark iron: strap hinges, bar handles, vent slots. */
  iron: Paint;
  /** Dark glossy glass, and its lit (evening) variant. */
  glass: Paint;
  glassLit: Paint;
  /** Warm emissive lamp lens — never white, never emissive 1 on a broad face. */
  lamp: Paint;
  /** Cool emissive strip (garage lights only). */
  lampCool: Paint;
  /** The scheme's pop colour: sign boards, awning stripes, flower pots. */
  accent: Paint;
  /** Awning canvas partner of `accent` (cream). */
  fabric: Paint;
  solar: Paint;
  /** Faceted planter foliage and its flowers. */
  foliage: Paint;
  foliageLight: Paint;
  flower: Paint;
  flowerCenter: Paint;
}

// Surface classes, from the style guide's roughness targets (gloss ≈ 1 − roughness).
const PLASTER = { gloss: 0.2 };
const PAINTED = { gloss: 0.35 };
const ROOF = { gloss: 0.55 };
// smooth 60: a block's 45° chamfers shade into its face — pillowy, not machined.
const STONE = { gloss: 0.12, smooth: 60 };

// The sheet's "cream" wall is a shade deeper than the cream trim and leans
// peach, not yellow — with the palette cream on both, bargeboards and sills
// dissolve into the wall, and a mustard-tinted cream goes lemon in the sun.
const PLASTER_CREAM: RGB = mix(mix(BUILDING.cream, BUILDING.apricot, 0.14), BUILDING.mustard, 0.03);
// Timber on the sheets is a clear orange-brown — the palette value pulled a
// little toward the bark highlight, or beams go red-brown in shade; the
// recessed boards behind the gable framing are the same wood one step darker.
const TIMBER: RGB = mix(BUILDING.timber, BARK.highlight, 0.18);
const TIMBER_DARK: RGB = adjustOklch(TIMBER, -0.03, 1.0, -2);
const IRON: RGB = [0.33, 0.33, 0.38];

interface SchemeColors {
  wall: RGB;
  wallAlt: RGB;
  roof: RGB;
  roofAlt: RGB;
  door: RGB;
  shutter: RGB;
  frame: RGB;
  accent: RGB;
}

const SCHEME_COLORS: Record<SchemeName, SchemeColors> = {
  warm: {
    wall: PLASTER_CREAM,
    wallAlt: BUILDING.apricot,
    roof: BUILDING.coral,
    roofAlt: BUILDING.cobalt,
    door: BUILDING.turquoise,
    shutter: BUILDING.turquoise,
    frame: BUILDING.turquoise,
    accent: BUILDING.coral,
  },
  coastal: {
    wall: BUILDING.turquoise,
    wallAlt: BUILDING.cream,
    roof: BUILDING.cobalt,
    roofAlt: BUILDING.coral,
    door: BUILDING.coral,
    shutter: BUILDING.cobalt,
    frame: BUILDING.cream,
    accent: BUILDING.coral,
  },
  sunny: {
    wall: BUILDING.mustard,
    wallAlt: BUILDING.cream,
    roof: BUILDING.turquoise,
    roofAlt: BUILDING.coral,
    door: BUILDING.coral,
    shutter: BUILDING.turquoise,
    frame: BUILDING.turquoise,
    accent: BUILDING.coral,
  },
};

/** Unknown / missing names fall back to `fallback` (the asset's own sheet scheme). */
export function schemeName(scheme: string | undefined, fallback: SchemeName = 'warm'): SchemeName {
  return (SCHEMES as readonly string[]).includes(scheme ?? '') ? (scheme as SchemeName) : fallback;
}

/**
 * The named paints of a scheme.
 *   const P = schemePaints(scheme);            // 'warm' when the name is missing
 *   roundedBox(m, { … }, P.trim);
 * A building whose sheet colours differ from the three combinations swaps the
 * odd paints for its hero scheme only — see `withPaints`.
 */
export function schemePaints(scheme?: string, fallback: SchemeName = 'warm'): BuildingPaints {
  const name = schemeName(scheme, fallback);
  const c = SCHEME_COLORS[name];
  return {
    scheme: name,
    wall: paint(c.wall, PLASTER),
    wallAlt: paint(c.wallAlt, PLASTER),
    trim: paint(BUILDING.cream, { gloss: 0.3 }),
    roof: paint(c.roof, ROOF),
    roofAlt: paint(c.roofAlt, ROOF),
    door: paint(c.door, PAINTED),
    shutter: paint(c.shutter, PAINTED),
    frame: paint(c.frame, PAINTED),
    timber: paint(TIMBER, { gloss: 0.25 }),
    timberDark: paint(TIMBER_DARK, { gloss: 0.2 }),
    stone: paint(lighten(BUILDING.stone, 0.04), STONE),
    stoneLight: paint(lighten(BUILDING.stone, 0.14), STONE),
    stoneDark: paint(BUILDING.stoneDark, STONE),
    metal: paint(BUILDING.roofMetal, { gloss: 0.6, metal: 1 }),
    iron: paint(IRON, { gloss: 0.45, metal: 0.6 }),
    // Glass on the sheets is nearly black with a teal cast; the palette teal
    // alone reads as a painted panel, so it is pulled down and made glossy.
    glass: paint(darken(BUILDING.glass, 0.45), { gloss: 0.95 }),
    // Lit glass and lamp lenses are a saturated amber: at these emissive levels
    // anything paler tone-maps to white.
    glassLit: paint('#FFBE5E', { gloss: 0.6, emissive: 0.45 }),
    lamp: paint('#FFB454', { gloss: 0.5, emissive: 0.55 }),
    lampCool: paint(BUILDING.cyanLight, { gloss: 0.5, emissive: 0.7 }),
    accent: paint(c.accent, PAINTED),
    fabric: paint(BUILDING.cream, { gloss: 0.15 }),
    solar: paint(BUILDING.solar, { gloss: 0.85 }),
    foliage: paint(FOLIAGE.lime, { gloss: 0.15, smooth: 0 }),
    foliageLight: paint(FOLIAGE.highlight, { gloss: 0.15, smooth: 0 }),
    flower: paint(FLOWERS.petal, { gloss: 0.2, smooth: 0 }),
    flowerCenter: paint(FLOWERS.center, { gloss: 0.2, smooth: 0 }),
  };
}

type PaintKey = Exclude<keyof BuildingPaints, 'scheme'>;

/**
 * Copy of `P` with some paints replaced. A colour keeps the surface class of
 * the paint it replaces (a new wall colour is still matte plaster); a full
 * Paint replaces it outright.
 *   // B06's sheet is apricot + cobalt, which no scheme is: override the hero only
 *   const P = scheme === 'warm' ? withPaints(base, { wall: BUILDING.apricot, roof: BUILDING.cobalt }) : base;
 */
export function withPaints(P: BuildingPaints, changes: Partial<Record<PaintKey, RGB | Paint | string>>): BuildingPaints {
  const out = { ...P };
  for (const key of Object.keys(changes) as PaintKey[]) {
    const c = changes[key];
    if (c === undefined) continue;
    const isPaint = typeof c === 'object' && !Array.isArray(c);
    out[key] = isPaint ? (c as Paint) : paint(P[key], { color: c as RGB | string });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeded detail variation

/**
 * Deterministic secondary choices for one variant. SEED 0 IS THE DESIGN
 * SHEET: every method returns its "hero" answer for seed 0 and only seeds
 * ≥ 1 roll. Each LABEL has its own random stream, so adding a new choice to
 * a building never reshuffles the ones it already had.
 *   const v = variation(seed, 'b04');
 *   const shutters = v.cycle(['open', 'closed', 'none'] as const);              // seed 0 → 'open', 1 → 'closed' …
 *   const lantern = v.chance('lantern', 0.5, false);                            // seed 0 → false
 *   const chimneyX = v.flip('chimney') * 1.4;                                   // seed 0 → +1.4
 *   const wide = 1.0 + v.shift('window', 0.1);                                  // seed 0 → 1.0
 */
export interface Variation {
  seed: number;
  /** A fresh stream for free-form use (block sizes, planter foliage …). */
  rng(label: string): Rng;
  /** One of `options`; seed 0 always gets the first. */
  pick<T>(label: string, options: readonly T[]): T;
  /** `options[seed % n]`: seed 0 gets the first and NEIGHBOURING seeds always
   * differ — for the choices that make copies look different at a glance
   * (door colour, shutters open / closed, roof covering). */
  cycle<T>(options: readonly T[]): T;
  /** True with probability `p`; seed 0 gets `hero`. */
  chance(label: string, p: number, hero: boolean): boolean;
  /** +1 for seed 0, otherwise ±1. */
  flip(label: string): 1 | -1;
  /** 0 for seed 0, otherwise uniform in ±max (small proportion shifts). */
  shift(label: string, max: number): number;
  /** The paint, slightly hue / lightness shifted (unchanged for seed 0). */
  tint(label: string, p: Paint, amount?: number): Paint;
}

export function variation(seed: number, id: string): Variation {
  const hero = seed === 0;
  const stream = (label: string): Rng => rng(seed, id, label);
  return {
    seed,
    rng: stream,
    pick: (label, options) => (hero ? options[0] : stream(label).pick(options)),
    cycle: (options) => options[Math.abs(Math.round(seed)) % options.length],
    chance: (label, p, heroValue) => (hero ? heroValue : stream(label).chance(p)),
    flip: (label) => (hero ? 1 : stream(label).sign()),
    shift: (label, max) => (hero ? 0 : stream(label).range(-max, max)),
    tint: (label, p, amount = 1) =>
      hero ? p : paint(p, { color: jitterColor(stream(label), p.color, { hue: 5 * amount, lightness: 0.035 * amount, chroma: 0.06 * amount }) }),
  };
}

const colorDistance = (a: RGB, b: RGB): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The scheme with its SECONDARY colours changed for a variant: door and
 * shutter colours cycle through the scheme's own family (never one that
 * would vanish against the wall, never the same on neighbouring seeds),
 * walls and roof are nudged a few degrees. Seed 0
 * returns `P` untouched. Use it once at the top of a builder:
 *   const P = variantPaints(schemePaints(scheme), variation(seed, 'b04'));
 */
export function variantPaints(P: BuildingPaints, v: Variation): BuildingPaints {
  if (v.seed === 0) return P;
  // Candidates: visible against the wall, no colour twice.
  const distinct = (list: Paint[]): Paint[] =>
    list.filter((c, i) => colorDistance(c.color, P.wall.color) > 0.3 && list.findIndex((d) => colorDistance(c.color, d.color) < 0.05) === i);
  const doors = distinct([P.door, P.accent, paint(P.door, { color: P.timber.color }), P.roofAlt, P.shutter, paint(P.door, { color: BUILDING.cobalt })]);
  // The sheet's shutter colour stays for every other seed.
  const shutters = [P.shutter, P.shutter, ...distinct([P.shutter, P.accent, P.roofAlt, P.door]).slice(1)];
  return {
    ...P,
    wall: v.tint('wall', P.wall),
    roof: v.tint('roof', P.roof, 0.8),
    door: v.cycle(doors),
    shutter: v.cycle(shutters),
  };
}
