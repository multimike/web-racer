import { Effect } from '@babylonjs/core';

/**
 * `#include<groundLayers>` — the fragment-shader side of the generated
 * ground materials (see GroundTextures.ts for the texture side and index.ts
 * for the integration snippets).
 *
 * A layer texture holds sRGB albedo in rgb and height in a, so one tap gives
 * colour AND relief. The chunk provides:
 *
 *   groundVary(worldXZ)            the slow fields, ONCE per pixel
 *   groundSample(...)              grainy layer, 2 taps, no repeat
 *   groundStones(...)              stone layout, 1 tap + 1 texel fetch of
 *                                  the id map: every stone of every repeat
 *                                  gets its own tone
 *   groundStreaked(...)            road dirt on a ribbon, 2 taps, streaks
 *                                  along the road
 *   groundTinted(...)              stone layout WITHOUT an id map, 2 taps
 *   groundTap(...)                 1 tap (kerb strip)
 *   (each also as ...Grad with explicit derivatives, for use inside a branch)
 *   groundBlend(hA, hB, t, soft)   height-aware weight between two layers
 *   groundWeights(w, h, soft)      height-aware splat weights, up to 4 layers
 *   groundMacro(rgb, vary, amt)    patchy + broad tonal drift, no taps
 *   groundCavity(h, lo, hi)        ambient occlusion from the height, no taps
 *   groundNormal(n, worldPos, h)   lighting normal from the blended height,
 *                                  no taps (screen-space derivatives)
 *   groundPaint(rgb, h, mask, c)   worn painted line over a layer
 *   groundEdge(d)                  filtered 0..1 step at d = 0, for borders
 *                                  drawn in the shader (kerb | road)
 *
 * Needs GLSL ES 3.00 (WebGL2: textureGrad, texelFetch, derivatives) — the
 * same baseline the look lighting chunk already has. Do not name anything
 * "cast", "patch" or "sample" in a shader that includes it (reserved words).
 */

const GROUND_CHUNK = `
// ---- groundLayers ---------------------------------------------------------
// Sin-free hash (Hoskins): the classic fract(sin(dot())) form loses its
// bits on mobile GPUs at world-size coordinates.
float groundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Value noise 0..1, C1.
float groundNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x),
             mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// The slow fields every layer shares; evaluate ONCE per pixel and pass on.
//   x  band coordinate for groundSample: rises 0.55 per meter across the
//      world and wanders by about a unit with two noises. The ramp must
//      stay steeper than the noises can cancel, or a band grows wider than
//      a tile and the repeat is back inside it. NOT a 0..1 value.
//   y  mid tone    (features ~3.5 m): the patchiness a 4 m tile cannot carry
//                  without showing its repeat
//   z  macro tone  (features ~45 m): broad light / dark drift
// The lattice is turned 31 degrees so its cells never line up with the
// texture tiles or the terrain grid.
vec3 groundVary(vec2 worldXZ) {
  vec2 q = vec2(0.8572 * worldXZ.x - 0.5150 * worldXZ.y, 0.5150 * worldXZ.x + 0.8572 * worldXZ.y);
  float mid = groundNoise(q * 0.29 + 5.7);
  float band = q.x * 0.55 + 1.3 * groundNoise(q * 0.085) + 0.8 * mid;
  return vec3(band, mid, groundNoise(q * 0.022 + 17.3));
}

// One tap. uv = position / tile size. The Grad forms take the uv
// derivatives explicitly, which makes them legal inside a branch (implicit
// derivatives are undefined there and leave a hairline along the branch
// border).
vec4 groundTap(sampler2D tex, vec2 uv) {
  return texture(tex, uv);
}
vec4 groundTapGrad(sampler2D tex, vec2 uv, vec2 dx, vec2 dy) {
  return textureGrad(tex, uv, dx, dy);
}

// GRAINY materials (grass, dirt, sand, asphalt, gravel). The world is cut
// into wandering bands ~1.8 m wide by the band coordinate; band k shows the
// tile shifted by a random offset of its own, and the two taps are bands
// floor(band) and floor(band) + 1, cross-faded over the middle 60 % of the
// band. Where the index steps, the tap that changes offset has weight zero,
// so nothing jumps. A shifted copy of the tile is the SAME lattice, but no
// offset holds for more than a band's width — less than one tile — so no
// feature ever meets its own repeat. (Two fixed lattices, however turned
// and scaled, each still show as a grid at half contrast: measured.)
// The shift is a pure translation, so directional tiles (sand ripples)
// keep their direction.
//   band      groundVary().x
//   meanTile  the tile's mean (rgb, height) — GroundLayer.mean
//   crisp     0 = plain cross-fade. Towards 1 the HIGHER sample wins, so
//             pebbles of one tap sit on the matrix of the other instead of
//             ghosting through it (gravel: 0.5).
// The cross-fade is contrast-preserving: averaging two uncorrelated samples
// halves their variance, which would show as washed-out seams between the
// bands, so the deviation from the tile mean is rescaled by the weight norm.
vec4 groundSampleGrad(sampler2D tex, vec2 uv, vec2 dx, vec2 dy, float band, vec4 meanTile, float crisp) {
  float k = floor(band);
  float f = band - k;
  vec4 a = textureGrad(tex, uv + vec2(groundHash(vec2(k, 3.7)), groundHash(vec2(k, 11.3))), dx, dy);
  vec4 b = textureGrad(tex, uv + vec2(groundHash(vec2(k + 1.0, 3.7)), groundHash(vec2(k + 1.0, 11.3))), dx, dy);
  // The height bias fades out toward both ends of the band, where the
  // weight must reach exactly 0 or 1.
  float w = smoothstep(0.2, 0.8, f + (b.a - a.a) * crisp * 8.0 * f * (1.0 - f));
  vec4 d = (1.0 - w) * (a - meanTile) + w * (b - meanTile);
  float norm = inversesqrt((1.0 - w) * (1.0 - w) + w * w);
  return clamp(meanTile + d * mix(norm, 1.0, crisp), 0.0, 1.0);
}
vec4 groundSample(sampler2D tex, vec2 uv, float band, vec4 meanTile, float crisp) {
  return groundSampleGrad(tex, uv, dFdx(uv), dFdy(uv), band, meanTile, crisp);
}

// STONE LAYOUTS (cobblestone, pavers). Shifting or cross-fading the tile
// would cut stones in half or ghost one over another, so the outlines stay
// put — and the generators keep them free of landmark shapes — while the
// COLOUR mosaic, which is what a repeat of paving is spotted by, is painted
// here, new for every repeat of the tile: the id map (GroundLayer.idTexture,
// read unfiltered) says which stone a texel belongs to, where its centre is
// and which tone t of the stone family the albedo holds there (the middle
// one, for the 'plain' tiles createGroundTextures builds); the stone gets a
// t of its own from a hash of (stone, repeat) and the albedo is multiplied
// by tone(new) / tone(held). One flat tone per stone.
//   pos    position in METERS (world xz, or the ribbon's across / along)
//   info   the layer's <prefix>Info: xy = 1 / tile size, w = tone spread
// Unlike the other samplers this one takes meters, not uv: it has to know
// how many pixels a stone covers.
// Lavender and cream gather in drifts a few meters wide: the odds of a
// warm stone follow a noise, evaluated at the stone's CENTRE so a stone is
// never split. In the distance, where a pixel no longer falls on one stone
// (and an unfiltered id would sparkle), the stones are left in their plain
// tone and only that drift remains, as a tint — the mosaic dissolves into
// the same soft patches it was gathered in.
// Keep GROUND_STONE_WARM and groundStoneT in step with core.ts.
const vec3 GROUND_STONE_WARM = vec3(1.47, 1.37, 1.045);
float groundStoneT(float family, float within, float spread) {
  return 0.5 + 0.5 * spread * (family < 0.5 ? -1.0 : 1.0) * (0.15 + 0.85 * within);
}
// Odds of a warm stone at a place (meters).
float groundStoneWarm(vec2 at) {
  return clamp(0.5 + 1.2 * (groundNoise(at * 0.38 + 41.0) - 0.5), 0.0, 1.0);
}
vec4 groundStonesGrad(sampler2D tex, sampler2D ids, vec2 pos, vec2 dx, vec2 dy, vec4 info) {
  vec2 uv = pos * info.xy;
  vec4 a = textureGrad(tex, uv, dx * info.xy, dy * info.xy);
  const vec3 warm = GROUND_STONE_WARM - 1.0;
  // Distance: the mean tone of the stones around here (0.575 = the mean of
  // 0.15 + 0.85 * within), over the plain tone.
  float tFar = 0.5 + 0.5 * info.w * (2.0 * groundStoneWarm(pos) - 1.0) * 0.575;
  vec3 tone = (1.0 + warm * tFar) / (1.0 + warm * 0.5);
  // Individual stones while a pixel is well under a stone wide (8 cm),
  // gone by 20 cm.
  float near = 1.0 - smoothstep(0.08, 0.2, sqrt(length(dx) * length(dy)));
  if (near > 0.0) {
    ivec2 isize = textureSize(ids, 0);
    vec2 cell = floor(uv);
    vec4 id = floor(texelFetch(ids, min(ivec2((uv - cell) * vec2(isize)), isize - 1), 0) * 255.0 + 0.5);
    if (id.a < 8.5) {
      // The repeat the stone's centre lies in, then the centre itself in
      // 1/256ths of a tile: an integer key unique to this stone instance.
      vec2 home = cell - vec2(mod(id.a, 3.0), floor(id.a / 3.0)) + 1.0;
      vec2 key = home * 256.0 + id.rg;
      float family = groundHash(key) < groundStoneWarm(key / (256.0 * info.xy)) ? 0.75 : 0.25;
      float t = groundStoneT(family, groundHash(key + 57.31), info.w);
      vec3 own = (1.0 + warm * t) / (1.0 + warm * (id.b / 255.0)) * (0.97 + 0.06 * groundHash(key + 113.7));
      tone = mix(tone, own, near);
    }
  }
  // Only the stone is toned, not the joint around it (the two halves of a
  // joint would take the tones of the two stones beside it, with a seam
  // down the middle): the height tells them apart, and being filtered it
  // does so without a hard edge. The thresholds are the generators' joint
  // bed (below ~0.13) and the foot of a stone's shoulder.
  a.rgb *= mix(vec3(1.0), tone, smoothstep(0.13, 0.27, a.a));
  return a;
}
vec4 groundStones(sampler2D tex, sampler2D ids, vec2 pos, vec4 info) {
  return groundStonesGrad(tex, ids, pos, dFdx(pos), dFdy(pos), info);
}

// Stone layouts WITHOUT an id map (a downloaded tile): the shapes stay put
// and a second tap of the same tile, ~4.7x larger and blurred to soft
// patches, varies their BRIGHTNESS only (a colour tint drifts cream stones
// toward yellow). Weaker than groundStones — the patches cross stone
// borders and the layout's own colours still repeat every tile — so it is
// repeat-safe only on a ribbon about one tile wide.
vec4 groundTintedGrad(sampler2D tex, vec2 uv, vec2 dx, vec2 dy, vec4 meanTile, float amount) {
  vec4 a = textureGrad(tex, uv, dx, dy);
  // Explicit lod, never sharper than mip 3.5: up close the automatic lod of
  // the enlarged tap would go to mip 0 and print giant stone outlines.
  vec2 size = vec2(textureSize(tex, 0));
  vec2 tx = dx * size * 0.2137;
  vec2 ty = dy * size * 0.2137;
  float lod = max(0.5 * log2(max(dot(tx, tx), dot(ty, ty))), 3.5);
  vec3 tone = textureLod(tex, uv * 0.2137 + vec2(0.37, 0.61), lod).rgb;
  const vec3 luma = vec3(0.299, 0.587, 0.114);
  a.rgb *= mix(1.0, dot(tone, luma) / dot(meanTile.rgb, luma), amount);
  return a;
}
vec4 groundTinted(sampler2D tex, vec2 uv, vec4 meanTile, float amount) {
  return groundTintedGrad(tex, uv, dFdx(uv), dFdy(uv), meanTile, amount);
}

// ROAD DIRT on a ribbon (uv.x across, uv.y along, both / tile size):
// groundSample plus streaks that run ALONG the road and follow every bend —
// soft darker tracks ~30 cm wide under finer ~8 cm lines, both several
// meters long. They are stretched value noise, not texture, so they cost no
// tap, never repeat, and can be far thinner than a blurred tile mip.
//   band   groundVary().x
vec4 groundStreakedGrad(sampler2D tex, vec2 uv, vec2 dx, vec2 dy, float band, vec4 meanTile, float amount) {
  vec4 a = groundSampleGrad(tex, uv, dx, dy, band, meanTile, 0.0);
  float tracks = groundNoise(uv * vec2(13.0, 0.55) + 7.1) - 0.5;
  float lines = groundNoise(uv * vec2(47.0, 1.3) + 23.4) - 0.5;
  // The thin lines are narrower than a pixel long before the tracks are.
  float px = max(abs(dx.x), abs(dy.x));
  float tone = tracks * (1.0 - smoothstep(0.3, 0.8, px * 13.0)) + 0.5 * lines * (1.0 - smoothstep(0.3, 0.8, px * 47.0));
  // They come and go in stretches (~4 m across, ~20 m along): streaked
  // evenly from kerb to kerb the road reads as a plank.
  tone *= 0.3 + 1.4 * groundNoise(uv * vec2(0.9, 0.2) + 3.3);
  // Mostly a tint: as relief the lines catch the sun one by one and the
  // road turns to wood grain.
  a.rgb *= 1.0 + amount * 0.3 * tone;
  a.a = clamp(a.a + amount * 0.06 * tone, 0.0, 1.0);
  return a;
}
vec4 groundStreaked(sampler2D tex, vec2 uv, float band, vec4 meanTile, float amount) {
  return groundStreakedGrad(tex, uv, dFdx(uv), dFdy(uv), band, meanTile, amount);
}

// Height-aware splat weights for up to four layers: w = the plain weights
// (sum 1, 0 for an absent layer), h = the layers' sampled heights. Where
// layers meet, the higher surface wins, so the border follows pebbles and
// tufts instead of fading through a soft gradient. soft = transition width
// in height units (0.1 crisp .. 0.5 soft).
vec4 groundWeights(vec4 w, vec4 h, float soft) {
  vec4 present = step(0.004, w);
  vec4 k = (h + w * 2.0) * present;
  float top = max(max(k.x, k.y), max(k.z, k.w)) - soft;
  vec4 r = max(k - top, 0.0) * present;
  return r / (r.x + r.y + r.z + r.w);
}

// Weight of layer B over layer A for a mask t (0 = all A, 1 = all B). The
// layer whose surface is HIGHER wins first, so stones break through dirt
// top-first and the dirt stays in the joints longest. soft = width of the
// transition in height units (0.05 crisp .. 0.5 nearly linear).
float groundBlend(float hA, float hB, float t, float soft) {
  float a = hA + 1.0 - t * 2.0;
  float b = hB - 1.0 + t * 2.0;
  return smoothstep(-soft, soft, b - a);
}

// Tonal drift from the slow fields: patches a few meters across plus a
// broad drift over tens of meters, each a few percent lighter-and-warmer or
// darker-and-cooler. This is where a ground material's large-scale variety
// comes from — the tiles deliberately hold none (it would be the first
// thing to show the repeat). Apply to the sRGB albedo.
vec3 groundMacro(vec3 srgb, vec3 vary, float amount) {
  float m = (vary.y - 0.5) * 1.1 + (vary.z - 0.5) * 1.6;
  return srgb * (1.0 + amount * m * vec3(1.0, 0.85, 0.55));
}

// Ambient occlusion from the height: joints and hollows (h below lo) lose
// fill light, tops (h above hi) are open. Feed it to the ao argument of
// lookShadeMatte, which pulls occluded fill toward the lavender shadow tint.
float groundCavity(float h, float lo, float hi) {
  return 0.55 + 0.45 * smoothstep(lo, hi, h);
}

// Lighting normal from a height (METERS, already scaled by the layer's
// relief) that varies across the surface: Mikkelsen's derivative bump
// mapping. No tangents, no extra taps, works on any mesh and any uv. The
// derivative of the BLENDED height is taken, so transitions between layers
// are bevelled for free. Call it outside any branch.
vec3 groundNormal(vec3 n, vec3 worldPos, float h) {
  vec3 dpx = dFdx(worldPos);
  vec3 dpy = dFdy(worldPos);
  float hx = dFdx(h);
  float hy = dFdy(h);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * n - grad);
}

// Painted line (mask 1 = paint) laid over a layer: the paint thins on the
// layer's high points, where traffic wears it off first.
vec3 groundPaint(vec3 srgb, float h, float mask, vec3 paintSrgb) {
  return mix(srgb, paintSrgb, mask * (1.0 - 0.45 * smoothstep(0.55, 0.9, h)));
}

// Coverage of the side d > 0 of a border drawn in the shader, one pixel
// wide: a bare step() there is a staircase that MSAA cannot touch (it is
// not a geometry edge). Call it outside any branch; sample both sides only
// where the result is strictly between 0 and 1.
float groundEdge(float d) {
  return clamp(d / max(fwidth(d), 1e-6) + 0.5, 0.0, 1.0);
}
// ---------------------------------------------------------------------------
`;

let registered = false;

/** Put the chunk into Babylon's include store. Idempotent; called by
 * `createGroundTextures`, safe to call from any material factory. */
export function registerGroundShader(): void {
  if (registered) return;
  registered = true;
  Effect.IncludesShadersStore['groundLayers'] = GROUND_CHUNK;
}
