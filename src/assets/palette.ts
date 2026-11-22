import { hex } from '../gfx/solid/color';
import type { RGB } from '../gfx/solid/color';

/**
 * The shared palette: every named colour from the design packs as an sRGB
 * `RGB` tuple (0..1), ready for `paint(FOLIAGE.jade, { … })`.
 *
 * Sources (the hex codes are copied verbatim — these are BASE colours, not
 * lit colours; lighting, the warm-top / cool-underside split and seeded
 * variation are applied on top by the look shader, `recolor` and
 * `jitterColor`):
 *   design-documents/environment-design-pack/palette.json  → FOLIAGE, BARK, SUCCULENT, FLOWERS, STONE
 *   design-documents/building-design-pack/palette.json     → BUILDING
 *   design-documents/buggy-design-pack/<car>/model-spec.json palette_srgb → REEF_ROCKET, NEON_WASP, RIOT_RAM, COMET_FOX
 *
 * Add a colour here only when a design really needs one that is not listed.
 *
 * THE "shadow" / "deep" ENTRIES ARE HOW A COLOUR LOOKS IN SHADE, NOT A SECOND
 * ALBEDO TO PAINT SHADED FACES WITH. The shader already darkens and cools
 * whatever faces away from the sun; a facet painted with FOLIAGE.deepTeal or
 * STONE.shadow gets shaded AGAIN and lands near black (measured: canopy
 * undersides at value 0.28 against the vision's 0.48–0.61). Rules of thumb,
 * from pixel samples of the vision images:
 *  - foliage: `lime` and `highlight` are the dominant canopy colours (the
 *    vision's lit tops are yellow-lime, hue 55–58°); use `jade` for the
 *    lower / inner facets and `deepTeal` only as a small accent;
 *  - rocks: lower faces in `base` or `midSlate`, top planes `upperFace`;
 *    `shadow` only in deep crevices;
 *  - a warm-top / cool-underside `recolor` should shift HUE and change value
 *    by at most ~20–25 %.
 */

// --- environment ------------------------------------------------------------

export const FOLIAGE = {
  jade: hex('#139B68'),
  deepTeal: hex('#116957'),
  lime: hex('#9BD916'),
  highlight: hex('#C7F039'),
} as const satisfies Record<string, RGB>;

export const BARK = {
  base: hex('#B86132'),
  shadow: hex('#87452B'),
  highlight: hex('#E8994A'),
} as const satisfies Record<string, RGB>;

export const SUCCULENT = {
  base: hex('#169F8E'),
  shadow: hex('#126A60'),
  edge: hex('#C3DF38'),
} as const satisfies Record<string, RGB>;

export const FLOWERS = {
  petal: hex('#F56C72'),
  center: hex('#FFD141'),
  stem: hex('#399E3E'),
} as const satisfies Record<string, RGB>;

export const STONE = {
  base: hex('#8C88B8'),
  shadow: hex('#655584'),
  midSlate: hex('#777CAE'),
  /** Cream sunlit top planes of rocks. */
  upperFace: hex('#F0CDB1'),
} as const satisfies Record<string, RGB>;

// --- buildings ---------------------------------------------------------------

export const BUILDING = {
  cream: hex('#F4E3C4'),
  mustard: hex('#E5AB35'),
  turquoise: hex('#1CAFAE'),
  coral: hex('#F16B59'),
  apricot: hex('#EBA17A'),
  cobalt: hex('#3153BA'),
  timber: hex('#AD6338'),
  stone: hex('#8C88B8'),
  stoneDark: hex('#655584'),
  roofMetal: hex('#A7ADB9'),
  glass: hex('#164C52'),
  solar: hex('#233E83'),
  cyanLight: hex('#44DDE8'),
} as const satisfies Record<string, RGB>;

// --- cars --------------------------------------------------------------------

/** Shared by all four cars. */
export const CAR_COMMON = {
  // Warm charcoal, not black: the vision's tires are (95,73,72) on the dark
  // side and (132,99,97) on sunlit tread. A near-black albedo has nothing
  // for the light to work on and tires render as flat silhouettes. Pair it
  // with gloss ≈ 0.2 so tread tops catch the sky.
  rubber: hex('#50474A'),
  metal: hex('#A7ABB2'),
} as const satisfies Record<string, RGB>;

export const REEF_ROCKET = {
  bodyTurquoise: hex('#04B9BE'),
  cageCoral: hex('#FF6373'),
  trimCream: hex('#F4E4C8'),
  emissionCyan: hex('#00E6EF'),
  rubber: CAR_COMMON.rubber,
  metal: CAR_COMMON.metal,
} as const satisfies Record<string, RGB>;

export const NEON_WASP = {
  bodyYellow: hex('#E9EF00'),
  cageViolet: hex('#8624C8'),
  accentCyan: hex('#00D7E8'),
  rubber: CAR_COMMON.rubber,
  metal: CAR_COMMON.metal,
} as const satisfies Record<string, RGB>;

export const RIOT_RAM = {
  bodyCobalt: hex('#244BCC'),
  panelsOrange: hex('#FF7D17'),
  springsLime: hex('#C9EE18'),
  stripeWhite: hex('#F5F2E9'),
  rubber: CAR_COMMON.rubber,
  metal: CAR_COMMON.metal,
} as const satisfies Record<string, RGB>;

export const COMET_FOX = {
  bodyVermilion: hex('#F12532'),
  stripeWhite: hex('#F5F0E7'),
  cageTeal: hex('#0AB8B5'),
  emissionBlue: hex('#00CFF5'),
  rubber: CAR_COMMON.rubber,
  metal: CAR_COMMON.metal,
} as const satisfies Record<string, RGB>;
