/**
 * Colour helpers for the solid kit. Every colour in the kit is an `RGB` tuple
 * of sRGB components in 0..1 — the same numbers a design palette's hex codes
 * describe. Nothing here is linear-light: the look shader converts to linear
 * itself, so authors only ever handle "what the swatch looks like".
 */

/** sRGB colour, components 0..1. */
export type RGB = readonly [number, number, number];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Parse '#RRGGBB', 'RRGGBB', '#RGB' or a 0xRRGGBB number into an RGB tuple.
 * Throws on anything else, so a typo in a palette fails loudly at build time
 * instead of painting a part black.
 */
export function hex(value: string | number): RGB {
  if (typeof value === 'number') {
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }
  let s = value.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`hex(): not a colour: "${value}"`);
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Accept a hex string or an RGB tuple. */
export function toRGB(c: string | RGB): RGB {
  return typeof c === 'string' ? hex(c) : c;
}

/** Linear blend a→b in sRGB space (t = 0 gives a, t = 1 gives b). */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Multiply brightness (k < 1 darker, k > 1 brighter, clamped to 1). */
export function shade(c: RGB, k: number): RGB {
  return [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];
}

/** Blend toward white by `amount` 0..1. */
export function lighten(c: RGB, amount: number): RGB {
  return mix(c, [1, 1, 1], amount);
}

/** Blend toward black by `amount` 0..1. */
export function darken(c: RGB, amount: number): RGB {
  return mix(c, [0, 0, 0], amount);
}

// ---------------------------------------------------------------------------
// HSV

/** RGB → [hue 0..360, saturation 0..1, value 0..1]. */
export function rgbToHsv(c: RGB): [number, number, number] {
  const r = c[0];
  const g = c[1];
  const b = c[2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max <= 0 ? 0 : d / max, max];
}

/** [hue degrees, saturation 0..1, value 0..1] → RGB. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  v = clamp01(v);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH — perceptually even, so "±5 % lightness" looks like the same
// step on a lime as on a cobalt (HSV value does not).

export function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB → OKLab [L 0..1, a, b]. */
export function rgbToOklab(c: RGB): [number, number, number] {
  const r = srgbToLinear(c[0]);
  const g = srgbToLinear(c[1]);
  const b = srgbToLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB, clamped into gamut per channel. */
export function oklabToRgb(L: number, a: number, b: number): RGB {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/**
 * Shift a colour in OKLCH: `lightness` is ADDED (−1..1, e.g. 0.05 = a touch
 * lighter), `chroma` MULTIPLIES colourfulness (1 = unchanged), `hue` is added
 * in degrees.
 */
export function adjustOklch(c: RGB, lightness = 0, chroma = 1, hue = 0): RGB {
  const [L, a, b] = rgbToOklab(c);
  const C = Math.hypot(a, b) * chroma;
  const h = Math.atan2(b, a) + (hue * Math.PI) / 180;
  return oklabToRgb(clamp01(L + lightness), C * Math.cos(h), C * Math.sin(h));
}

/** Blend a→b through OKLab (no muddy mid-tones between distant hues). */
export function mixOklab(a: RGB, b: RGB, t: number): RGB {
  const A = rgbToOklab(a);
  const B = rgbToOklab(b);
  return oklabToRgb(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
