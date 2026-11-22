import { Color3, Effect, Matrix, Scene, Vector3, Vector4 } from '@babylonjs/core';
import type { Observer, ShaderMaterial } from '@babylonjs/core';
import { SUN_DIR } from '../../terrain/generateTerrain';
import { SunShadows } from './shadows';
import type { ShadowQuality, ShadowTaps } from './shadows';
import { SkyDome } from './sky';
import { LOOK_WIND_UNIFORM, registerWindChunk } from './wind';

/**
 * The look core: ONE lighting model for every surface in the game.
 *
 * `#include<lookLighting>` in a fragment shader gives it `lookShade(...)`,
 * which takes a surface (linear albedo, normal, gloss, metal, AO, baked sun
 * visibility, emissive) and returns the final display colour — sun + sky
 * lighting in LINEAR space, real-time shadow, specular, a procedural
 * environment reflection, rim, emissive, tone mapping, grade, gamma and fog,
 * all in the one forward pass. Nothing depends on post-processing, so the
 * picture is identical on a desktop canvas and inside a WebXR layer.
 *
 * `LookRuntime` owns the uniforms: materials register once and are refreshed
 * every frame, so a tweak to `look.config` (or `__look.config` in the dev
 * console) shows up everywhere on the next frame.
 */

export type RGB = [number, number, number];

/** Every colour is authored in sRGB 0..1 (what you would pick in a paint
 * program) and linearized on upload; intensities are linear multipliers. */
export interface LookConfig {
  /** Unit vector pointing TOWARD the sun. */
  sunDir: { x: number; y: number; z: number };
  sunColor: RGB;
  sunIntensity: number;
  /** Hemispheric ambient arriving from above (the sky fill). */
  skyColor: RGB;
  skyIntensity: number;
  /** Hemispheric ambient arriving from below (light bounced off the ground). */
  groundColor: RGB;
  groundIntensity: number;
  /** Multiplies the ambient wherever the sun is blocked — the hue shift that
   * makes shadows read lavender-blue instead of grey. 1,1,1 = neutral. */
  shadowTint: RGB;
  /** The GROUND's cast shade (matte path only: terrain, paving — never
   * cars, props or buildings), where a real-time or baked shadow blocks the
   * sun and only there: every sunlit pixel and every face merely turned
   * away from the sun is unchanged. In the vision the shade on dirt is a
   * mauve-tan (160,114,101 on ochre dirt) where a plain light gives brown —
   * no per-channel light can do that without moving the cobbles too, so
   * the shade is brightened by `gain` and its WARM
   * colours (red over green AND red over blue: dirt, plaster; greens keep
   * their hue) are pulled by `pull` toward `mauve` at the same luminance.
   * Shade that is already violet (blue >= red: the lavender cobbles, whose
   * shadows in BOTH vision images are violet, about 145,125,150) keeps only
   * the gain. `mauve` is a linear colour of luminance 1. gain 1 / pull 0 =
   * off. */
  groundShade: { gain: number; pull: number; mauve: RGB };
  /** N·L range over which a surface turns from shadow to lit (the soft toon
   * terminator). Small = crisp cartoon edge, 1 = plain Lambert. */
  terminator: number;
  /** Strength of the warm glow just past the terminator (toy-plastic
   * scatter). 0 = off. */
  scatter: number;
  /** Sun highlight strength. */
  specular: number;
  /** How far the highlight / softbox colour is pulled from the sun colour
   * toward white (0 = sun-coloured, 1 = white). The sun is strongly warm, a
   * highlight in that colour would read as orange paint. */
  specularWhiteness: number;
  /** Strength of the "studio softbox" strip in the reflection environment —
   * the long soft sheen on glossy paint. */
  softbox: number;
  /** Environment (sky / horizon / ground / softbox) reflection strength. */
  reflection: number;
  /** Fresnel rim-light strength. */
  rim: number;
  /** Radiance multiplier of fully emissive paint; > 1 so lamps burn out to
   * white through the tone-map shoulder. */
  emissiveBoost: number;
  /** How dark the real-time shadow is (0 = invisible, 1 = full). */
  shadowStrength: number;
  /** Horizon / distance-fog colour (display space; also scene.fogColor). */
  fogColor: RGB;
  /** EXP2 density — same meaning as scene.fogDensity. */
  fogDensity: number;
  exposure: number;
  /** 1 = neutral; > 1 pushes the palette toward candy. */
  saturation: number;
  /** 0 = linear response, 1 = full filmic S-curve. */
  contrast: number;
  /** Sky dome. */
  zenithColor: RGB;
  /** Sun disc + halo strength on the dome. */
  sunGlow: number;
  cloudLight: RGB;
  cloudShade: RGB;
  /** Foliage sway: horizontal direction (x, z), amplitude in meters at wind
   * weight 1, and speed multiplier. */
  windDir: [number, number];
  windStrength: number;
  windSpeed: number;
}

export function defaultLookConfig(): LookConfig {
  return {
    sunDir: { x: SUN_DIR.x, y: SUN_DIR.y, z: SUN_DIR.z },
    // Balanced against pixel samples of the vision images. FULL cast shadows
    // there are dark and muted, not bright blue: on a pale kerb (252,226,212)
    // → (128,108,130), on cobble (215,166,178) → (91,92,105), under a car on
    // dirt (220,142,90) → (114,81,71). Only the dappled, half-lit shadow of a
    // tree keeps most of its blue. That is a warm (not orange) sun carrying
    // most of the light over a moderate, mildly blue sky fill. On UP-facing
    // surfaces sun + fill sum to a slightly warm white (linear 1.13, 1.05,
    // 0.95), so paints show close to their authored hex on the ground and
    // on bonnets; sun-facing WALLS get little sky and go clearly warm, as
    // the vision's cream cottage walls do.
    sunColor: [1.0, 0.93, 0.8],
    sunIntensity: 0.86,
    skyColor: [0.82, 0.88, 1.0],
    skyIntensity: 0.42,
    // The bounce is what lights walls turned away from the sun (they see a
    // quarter of the sky): the vision's shaded cream wall is (172,135,116),
    // i.e. lit by about (0.46, 0.32, 0.32) linear — warm, and brighter than
    // the sky alone would make it.
    groundColor: [0.92, 0.8, 0.72],
    groundIntensity: 0.6,
    shadowTint: [0.97, 0.97, 1.12],
    // Fitted to the shade on dirt (161,106,77 before) against the
    // vision's 160,114,101; on the cobbles only `gain` acts (see the type).
    groundShade: { gain: 1.25, pull: 0.8, mauve: [1.625, 0.845, 0.7] },
    terminator: 0.36,
    scatter: 0.3,
    specular: 1.6,
    specularWhiteness: 0.7,
    softbox: 1.8,
    reflection: 1.0,
    rim: 0.35,
    emissiveBoost: 2.2,
    shadowStrength: 1.0,
    fogColor: [0.74, 0.88, 0.97],
    fogDensity: 0.0035,
    exposure: 1.0,
    saturation: 1.0,
    contrast: 0.3,
    zenithColor: [0.33, 0.62, 0.96],
    sunGlow: 0.6,
    cloudLight: [1.0, 0.96, 0.92],
    cloudShade: [0.76, 0.77, 0.93],
    windDir: [0.8, 0.6],
    windStrength: 0.22,
    windSpeed: 1.0,
  };
}

/**
 * Per-view settings to apply ON TOP of the defaults: the chase camera sees
 * ~100 m of world around the car, the XR diorama camera sees the whole
 * 200 m table from above at once — which wants the shadow map over
 * everything and fixed in place (static casters then never shimmer and no
 * fade band crosses the view), and far less haze (at the default density
 * the far side of the table would be 40 % fog).
 *   const v = LOOK_VIEWS.diorama;
 *   const look = createLook(scene, { shadowQuality: 2048, shadowRegion: v.shadowRegion, sky: true, config: { fogDensity: v.fogDensity } });
 *   // diorama: look.shadows.setFocus(worldCentre) once; chase: setFocus(car) every frame.
 */
export const LOOK_VIEWS = {
  chase: { shadowRegion: 80, fogDensity: 0.0035, followCar: true },
  diorama: { shadowRegion: 210, fogDensity: 0.0013, followCar: false },
} as const;

/** Uniform names a material that includes the chunk must list. */
export const LOOK_UNIFORMS: readonly string[] = [
  'cameraPosition',
  'lookSunDir',
  'lookSunColor',
  'lookSpecColor',
  'lookSkyColor',
  'lookGroundColor',
  'lookShadowTint',
  'lookGroundShade',
  'lookGroundShadeGain',
  'lookEnvZenith',
  'lookEnvHorizon',
  'lookFog',
  'lookShape',
  'lookGrade',
  'lookMisc',
  'lookShadowMatrix',
  'lookShadowInfo',
  'lookContactA',
  'lookContactB',
];

/** Most contact occluders (cars) a receiver evaluates. */
export const LOOK_MAX_CONTACTS = 4;

/**
 * A soft pool of ambient occlusion under a car: an oriented rectangle on the
 * ground that darkens the FILL light (never the sun) of every receiver
 * registered with `contact: true`. It is what sits a car on the road — the
 * cast shadow alone is one flat tone, the vision has a clearly darker core
 * under every car. Analytic, no texture taps.
 */
export interface ContactOccluder {
  /** Footprint centre, world x / z. */
  x: number;
  z: number;
  /** Heading in RADIANS (0 = +z, positive turns toward +x). */
  yaw: number;
  /** Half extents of the footprint across / along the heading, meters. */
  halfX: number;
  halfZ: number;
  /** World height of the wheels' contact plane; the pool fades out on
   * ground more than ~0.3 m below it (a car in the air). */
  y: number;
  /** 0..1: how much of the fill light is removed at the centre (default
   * 0.55, which takes a cast shadow from ~50 % to ~37 % of the lit ground,
   * the vision's numbers under a car). */
  strength?: number;
}

/** Sampler names a material that includes the chunk must list. */
export const LOOK_SAMPLERS: readonly string[] = ['lookShadowMap'];

const SHADOW_SAMPLER = 'lookShadowMap';

const LIGHTING_CHUNK = `
// ---- lookLighting ---------------------------------------------------------
uniform vec3 cameraPosition;
uniform vec3 lookSunDir;      // unit, toward the sun
uniform vec3 lookSunColor;    // linear, x intensity
uniform vec3 lookSpecColor;   // highlight colour: whitened sun x specular strength
uniform vec3 lookSkyColor;    // linear ambient from above, x intensity
uniform vec3 lookGroundColor; // linear ambient from below, x intensity
uniform vec3 lookShadowTint;
uniform vec4 lookGroundShade; // rgb mauve (linear, luminance 1), a pull
uniform float lookGroundShadeGain; // gain - 1 (unset uniforms = off)
uniform vec3 lookEnvZenith;   // linear sky radiance for reflections
uniform vec3 lookEnvHorizon;
uniform vec4 lookFog;         // rgb display-space fog colour, a = EXP2 density
uniform vec4 lookShape;       // x terminator, y scatter, z softbox, w reflection
uniform vec4 lookGrade;       // x exposure, y saturation, z contrast, w emissive boost
uniform vec4 lookMisc;        // x rim, y shadow strength, z time, w debug view
#ifdef LOOK_SHADOWS
uniform mat4 lookShadowMatrix; // world -> shadow uv + compare depth, all 0..1
uniform vec4 lookShadowInfo;   // x map size, y 1/size, z normal bias (m), w depth bias
uniform highp sampler2DShadow lookShadowMap;
#endif
#ifdef LOOK_CONTACT
uniform vec4 lookContactA[4];  // xy = footprint centre x/z, z = cos(yaw), w = sin(yaw)
uniform vec4 lookContactB[4];  // xy = half extents, z = contact-plane height, w = strength (0 = unused)
#endif

vec3 lookToLinear(vec3 srgb) { return pow(srgb, vec3(2.2)); }

// Fill-light factor from the contact occluders (cars): 1 = open ground,
// lower under and just around a car's footprint.
float lookContact(vec3 worldPos) {
#ifdef LOOK_CONTACT
  float open = 1.0;
  for (int i = 0; i < 4; i++) {
    vec4 a = lookContactA[i];
    vec4 b = lookContactB[i];
    vec2 d = worldPos.xz - a.xy;
    vec2 q = abs(vec2(d.x * a.z - d.y * a.w, d.x * a.w + d.y * a.z)) - b.xy;
    // Signed distance to the rectangle: negative inside.
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float pool = 1.0 - smoothstep(-0.45 * min(b.x, b.y), 0.55, dist);
    // Gone when the car is well above this piece of ground.
    pool *= 1.0 - smoothstep(0.3, 1.6, b.z - worldPos.y);
    open *= 1.0 - b.w * pool;
  }
  return open;
#else
  return 1.0;
#endif
}

#ifdef LOOK_SHADOWS
// Tent-filtered PCF built from hardware bilinear comparison taps: each
// texture() below already averages a 2x2 compare, so 4 taps cover 3x3 texels
// and 9 taps cover 5x5 with exact tent weights (no banding, no noise).
float lookPcf(vec2 uv, float z) {
#if LOOK_PCF == 1
  return texture(lookShadowMap, vec3(uv, z));
#else
  vec2 t = uv * lookShadowInfo.x + 0.5;
  vec2 st = fract(t);
  vec2 base = (floor(t) - 0.5) * lookShadowInfo.y;
  float s = lookShadowInfo.y;
#if LOOK_PCF == 4
  vec2 w0 = 3.0 - 2.0 * st;
  vec2 w1 = 1.0 + 2.0 * st;
  vec2 u = vec2((2.0 - st.x) / w0.x - 1.0, st.x / w1.x + 1.0) * s;
  vec2 v = vec2((2.0 - st.y) / w0.y - 1.0, st.y / w1.y + 1.0) * s;
  float sum = w0.x * w0.y * texture(lookShadowMap, vec3(base + vec2(u.x, v.x), z));
  sum += w1.x * w0.y * texture(lookShadowMap, vec3(base + vec2(u.y, v.x), z));
  sum += w0.x * w1.y * texture(lookShadowMap, vec3(base + vec2(u.x, v.y), z));
  sum += w1.x * w1.y * texture(lookShadowMap, vec3(base + vec2(u.y, v.y), z));
  return sum / 16.0;
#else
  vec2 w0 = 4.0 - 3.0 * st;
  vec2 w1 = vec2(7.0);
  vec2 w2 = 1.0 + 3.0 * st;
  vec3 u = vec3((3.0 - 2.0 * st.x) / w0.x - 2.0, (3.0 + st.x) / w1.x, st.x / w2.x + 2.0) * s;
  vec3 v = vec3((3.0 - 2.0 * st.y) / w0.y - 2.0, (3.0 + st.y) / w1.y, st.y / w2.y + 2.0) * s;
  float sum = w0.x * w0.y * texture(lookShadowMap, vec3(base + vec2(u.x, v.x), z));
  sum += w1.x * w0.y * texture(lookShadowMap, vec3(base + vec2(u.y, v.x), z));
  sum += w2.x * w0.y * texture(lookShadowMap, vec3(base + vec2(u.z, v.x), z));
  sum += w0.x * w1.y * texture(lookShadowMap, vec3(base + vec2(u.x, v.y), z));
  sum += w1.x * w1.y * texture(lookShadowMap, vec3(base + vec2(u.y, v.y), z));
  sum += w2.x * w1.y * texture(lookShadowMap, vec3(base + vec2(u.z, v.y), z));
  sum += w0.x * w2.y * texture(lookShadowMap, vec3(base + vec2(u.x, v.z), z));
  sum += w1.x * w2.y * texture(lookShadowMap, vec3(base + vec2(u.y, v.z), z));
  sum += w2.x * w2.y * texture(lookShadowMap, vec3(base + vec2(u.z, v.z), z));
  return sum / 144.0;
#endif
#endif
}
#endif

// Real-time sun visibility at a world position: 1 = lit, 0 = in cast shadow.
float lookShadow(vec3 worldPos, vec3 n) {
#ifdef LOOK_SHADOWS
  // Normal-offset bias: look the shadow up a little off the surface, further
  // at grazing sun. Kills acne without the peter-panning of a depth bias.
  float graze = 1.0 - clamp(dot(n, lookSunDir), 0.0, 1.0);
  vec3 p = worldPos + n * (lookShadowInfo.z * (0.35 + graze));
  vec3 sc = (lookShadowMatrix * vec4(p, 1.0)).xyz;
  // Beyond the far plane the map holds its clear value; clamp so the compare
  // reads "lit" there instead of a wall of shadow.
  float z = min(sc.z - lookShadowInfo.w, 0.9999);
  float lit = lookPcf(sc.xy, z);
  // Fade out toward the edge of the covered square (baked visibility takes
  // over beyond it) so the region border never shows as a line.
  vec2 e = abs(sc.xy - 0.5);
  float fade = smoothstep(0.43, 0.495, max(e.x, e.y));
  return mix(1.0 - lookMisc.y * (1.0 - lit), 1.0, fade);
#else
  return 1.0;
#endif
}

// Soft toon response of the sun: a smoothstep terminator (a readable edge
// that is still a gradient) times a shallow Lambert slope, so the lit side
// keeps enough falloff to show form instead of going poster-flat. Reaches 0
// exactly at N.L = 0, which also hides the self-shadow noise every shadow
// map has along the terminator.
float lookSunTerm(float ndl) {
  float t = smoothstep(0.0, lookShape.x, ndl);
  return t * (0.62 + 0.38 * clamp(ndl, 0.0, 1.0));
}

// Sun + sky diffuse light (linear, not multiplied by albedo). Outputs the
// sun visibility so the caller can gate its highlight with it.
vec3 lookDiffuseLight(vec3 n, vec3 worldPos, float ao, float bakedSun, out float sunVis) {
  float ndl = dot(n, lookSunDir);
  sunVis = bakedSun * lookShadow(worldPos, n);
  float sun = lookSunTerm(ndl) * sunVis;

  // Hemisphere fill: sky from above, warm bounce from below.
  // Squared: vertical faces get a quarter of the sky, not half, so the
  // sides of things fall clearly darker than their tops.
  float up = n.y * 0.5 + 0.5;
  vec3 amb = mix(lookGroundColor, lookSkyColor, up * up);
  // Where the sun is blocked the fill is all there is: shift its hue so
  // shadows go lavender-blue rather than grey.
  amb *= mix(lookShadowTint, vec3(1.0), sun);
  // AO eats ambient (toward the tint, never to black) and a little sun.
  amb *= mix(lookShadowTint * 0.5, vec3(1.0), ao) * lookContact(worldPos);

  // Scatter: a warm band just past the terminator, as light bleeds through
  // the edge of a plastic toy. Not shadow-mapped on purpose (the map is
  // unreliable exactly there); the baked term still gates it. Golden rather
  // than red, so it lifts shaded GREENS toward olive (the vision's canopy
  // undersides) instead of adding nothing to them.
  float sc = smoothstep(-0.45, 0.05, ndl) * (1.0 - smoothstep(0.0, lookShape.x, ndl));
  vec3 scatter = lookSunColor * vec3(1.0, 0.74, 0.42) * (sc * lookShape.y * bakedSun);

  return amb + lookSunColor * (sun * mix(0.7, 1.0, ao)) + scatter * ao;
}

// Procedural environment for reflections: warm ground -> pale horizon ->
// zenith. No cube map, no texture taps.
vec3 lookEnv(vec3 r, float blur) {
  float sky = smoothstep(-blur, blur, r.y);
  float h = clamp(r.y, 0.0, 1.0);
  vec3 above = mix(lookEnvHorizon, lookEnvZenith, sqrt(h));
  // The ground half is DARK and nearly neutral: metal then shows a bright
  // sky half over a dark belly (steel), where a bright beige ground made it
  // read as pearl or porcelain.
  vec3 ground = mix(lookGroundColor * 0.9, vec3(0.14), 0.5);
  vec3 below = mix(lookEnvHorizon, ground, clamp(-r.y * 3.0 + 0.25, 0.0, 1.0));
  return mix(below, above, sky);
}

// "Studio softbox": a bright strip above the horizon, strongest on the sun
// side. A sun-only highlight is a dot that is usually out of view; with the
// strip every rounded panel carries a long soft sheen from any camera
// angle, which is what makes paint read as glossy toy plastic.
float lookSoftbox(vec3 r, float blur) {
  float side = dot(r.xz, lookSunDir.xz) * 0.5 + 0.5;
  // The box reaches right overhead at reduced strength instead of ending at
  // 45 degrees: from the diorama camera (looking 45-60 degrees down) a
  // bonnet or fender crown reflects almost straight up, and with a strip
  // that stops short every car goes matte exactly in the shipping view.
  float band = smoothstep(0.2 - blur * 0.6, 0.4, r.y) * (1.0 - 0.5 * smoothstep(0.5, 0.8 + blur * 0.6, r.y));
  // Overhead the "sun side" loses its meaning; blend the falloff out.
  float dir = mix(0.2 + 0.8 * side * side, 0.75, smoothstep(0.55, 0.95, r.y));
  return band * dir;
}

// Full surface, linear HDR radiance.
//   albedo   LINEAR base colour (lookToLinear() an sRGB one)
//   n        unit world normal
//   gloss    0 chalk .. 1 glossy toy paint        metal  0 .. 1
//   ao       baked ambient occlusion, 1 = open    bakedSun  baked sun visibility, 1 = lit
//   emissive 0 lit .. 1 full glow
vec3 lookLight(vec3 albedo, vec3 n, vec3 worldPos, float gloss, float metal, float ao, float bakedSun, float emissive) {
  float sunVis;
  vec3 light = lookDiffuseLight(n, worldPos, ao, bakedSun, sunVis);

  vec3 v = normalize(cameraPosition - worldPos);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float ndl = clamp(dot(n, lookSunDir), 0.0, 1.0);

  // GGX lobe; roughness from gloss. Plastic F0 is lifted above the physical
  // 0.04 so mid-gloss toys still show a soft sheen.
  float rough = mix(0.9, 0.2, gloss);
  float a2 = rough * rough;
  a2 *= a2;
  vec3 hv = normalize(v + lookSunDir);
  float ndh = clamp(dot(n, hv), 0.0, 1.0);
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  float ggx = a2 / (3.14159 * d * d);
  vec3 f0 = mix(vec3(0.045), albedo, metal);
  float f1 = 1.0 - ndv;
  float f2 = f1 * f1;
  float fres = f2 * f2 * f1;
  // Dielectric fresnel is capped well below 1: a physically correct glancing
  // mirror turns every rounded toy edge into pale sky and washes the paint
  // colour out — the vision keeps paint saturated right to the silhouette.
  vec3 fr = f0 + (max(vec3(mix(0.3, 1.0, metal)), f0) - f0) * fres;
  // Clamp the lobe: an unbounded GGX peak on a smooth sphere is a few
  // sub-pixel fireflies in motion; a capped one is a stable soft dot.
  vec3 spec = lookSpecColor * fr * (min(ggx, 24.0) * 0.25 * ndl * sunVis);

  // Environment reflection. Dielectrics only mirror when glossy; metal
  // reflects at any roughness (just blurrier) and tints by its albedo.
  float mirror = mix(gloss * gloss * 0.7, 1.0, metal);
  vec3 r = reflect(-v, n);
  float blur = 0.04 + rough * 0.7;
  // The softbox gets its own floor on top of fresnel: at F0 = 4.5 % a
  // face-on panel would barely show it, and face-on is how the chase
  // camera sees the car's deck and fender crowns.
  vec3 refl = lookEnv(r, blur) * fr * lookShape.w
            + lookSpecColor * (fr + 0.07 * (1.0 - metal)) * (lookSoftbox(r, blur) * lookShape.z);
  refl *= mirror * mix(0.45, 1.0, ao);

  // Rim: sky light catching the silhouette, stronger on upward edges.
  float rim = f2 * f1 * lookMisc.x * (0.3 + 0.7 * (n.y * 0.5 + 0.5)) * mix(0.5, 1.0, ao);
  vec3 rimCol = lookSkyColor * mix(albedo, vec3(1.0), 0.35 + 0.4 * gloss) * rim * 1.6;

  vec3 col = albedo * light * (1.0 - metal * 0.9) + spec + refl + rimCol;
  // Emissive paint ignores the lighting and glows hotter face-on than at the
  // silhouette: with the shoulder above that reads as a bright core inside a
  // saturated edge — a lit bulb, not a flat pastel disc — with no bloom pass.
  return mix(col, albedo * (lookGrade.w * (0.55 + 0.9 * ndv * ndv)), emissive);
}

// Matte fast path (terrain, anything with gloss 0 / metal 0): no view
// vector, no specular, no reflection.
vec3 lookLightMatte(vec3 albedo, vec3 n, vec3 worldPos, float ao, float bakedSun) {
  float sunVis;
  vec3 c = albedo * lookDiffuseLight(n, worldPos, ao, bakedSun, sunVis);
  // Ground shade (LookConfig.groundShade): only where the sun is blocked.
  float shade = 1.0 - sunVis;
  c *= 1.0 + lookGroundShadeGain * shade;
  // Only WARM shade is pulled: red over green (greens keep their hue) AND
  // red over blue. Shade that is already violet (blue >= red: the lavender
  // cobbles under the sky fill) keeps only the gain — in the vision a
  // shadow on the cobbles is violet, not rose.
  float warm = clamp(4.0 * (c.r - c.g) / max(c.r, 1e-4), 0.0, 1.0)
             * clamp(3.0 * (c.r - c.b) / max(c.r, 1e-4), 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, lum * lookGroundShade.rgb, lookGroundShade.a * shade * warm);
}

// Linear HDR -> display: exposure, highlight shoulder, saturation, gamma,
// filmic S-curve.
vec3 lookTonemap(vec3 c) {
  c *= lookGrade.x;
  // Per-channel shoulder: below the knee the palette is untouched (a paint
  // lit at 1.0 shows as its authored hex); above it each channel rolls off
  // toward 1 on its own, so a hot red lamp climbs red -> orange -> yellow as
  // film does (a hue-locked curve can only go red -> pink). Far beyond
  // range everything drifts to white: highlights burn out, never clip flat.
  const float knee = 0.7;
  const float room = 1.0 - knee;
  float peak = max(c.r, max(c.g, c.b));
  vec3 over = max(c - knee, 0.0);
  c = min(c, vec3(knee)) + room * over / (over + room);
  c = mix(c, vec3(1.0), clamp((peak - 1.5) * 0.06, 0.0, 0.7));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, lookGrade.y), 0.0);
  c = pow(c, vec3(0.4545));
  c = mix(c, c * c * (3.0 - 2.0 * c), lookGrade.z);
  return clamp(c, 0.0, 1.0);
}

// EXP2 distance fog in display space — the same formula and the same space
// Babylon's own fog uses on a StandardMaterial with this scene.fogColor /
// fogDensity, and the sky dome's horizon is that same colour, so legacy
// materials, toy materials and the sky all meet at one horizon.
vec3 lookFogged(vec3 display, vec3 worldPos) {
  float dist = length(worldPos - cameraPosition) * lookFog.a;
  return mix(lookFog.rgb, display, clamp(exp(-dist * dist), 0.0, 1.0));
}

// One-call entry points: surface in, gl_FragColor out.
#ifdef LOOK_DEBUG
// Inspection views (look.debugView): 1 albedo, 2 normal, 3 real-time shadow,
// 4 baked AO, 5 lighting on mid grey, 6 baked sun visibility, 7 shadow-map
// coordinates.
vec4 lookDebug(vec3 albedo, vec3 n, vec3 worldPos, float ao, float bakedSun) {
  float mode = lookMisc.w;
  if (mode < 1.5) return vec4(pow(albedo, vec3(0.4545)), 1.0);
  if (mode < 2.5) return vec4(n * 0.5 + 0.5, 1.0);
  if (mode < 3.5) return vec4(vec3(lookShadow(worldPos, n)), 1.0);
  if (mode < 4.5) return vec4(vec3(ao), 1.0);
  if (mode < 5.5) return vec4(lookTonemap(lookLightMatte(vec3(0.6), n, worldPos, ao, bakedSun)), 1.0);
#ifdef LOOK_SHADOWS
  if (mode > 6.5) return vec4((lookShadowMatrix * vec4(worldPos, 1.0)).xyz, 1.0);
#endif
  return vec4(vec3(bakedSun), 1.0);
}
#endif

vec4 lookShade(vec3 albedo, vec3 n, vec3 worldPos, float gloss, float metal, float ao, float bakedSun, float emissive) {
#ifdef LOOK_DEBUG
  return lookDebug(albedo, n, worldPos, ao, bakedSun);
#else
  vec3 hdr = lookLight(albedo, n, worldPos, gloss, metal, ao, bakedSun, emissive);
  return vec4(lookFogged(lookTonemap(hdr), worldPos), 1.0);
#endif
}
vec4 lookShadeMatte(vec3 albedo, vec3 n, vec3 worldPos, float ao, float bakedSun) {
#ifdef LOOK_DEBUG
  return lookDebug(albedo, n, worldPos, ao, bakedSun);
#else
  vec3 hdr = lookLightMatte(albedo, n, worldPos, ao, bakedSun);
  return vec4(lookFogged(lookTonemap(hdr), worldPos), 1.0);
#endif
}
// ---------------------------------------------------------------------------
`;

let chunksRegistered = false;

/** Put the shared chunks into Babylon's include store. Idempotent; called by
 * the runtime, but safe to call from any material factory too. */
export function registerLookShaders(): void {
  if (chunksRegistered) return;
  chunksRegistered = true;
  Effect.IncludesShadersStore['lookLighting'] = LIGHTING_CHUNK;
  registerWindChunk();
}

export interface LookOptions {
  /** Real-time sun shadow map: 'off' | 1024 | 2048. Default 'off'. */
  shadowQuality?: ShadowQuality;
  /** Side of the shadowed square around the focus, meters. Default 80. */
  shadowRegion?: number;
  shadowTaps?: ShadowTaps;
  /** Build the sky dome + clouds. Default false. */
  sky?: boolean;
  /** Keep scene.fogMode/fogColor/fogDensity/clearColor in step with the
   * config so legacy StandardMaterials fog to the same horizon. Default true. */
  syncScene?: boolean;
  config?: Partial<LookConfig>;
}

interface Registered {
  material: ShaderMaterial;
  wind: boolean;
  contact: boolean;
  bindObserver: Observer<unknown> | null;
}

const RUNTIMES = new WeakMap<Scene, LookRuntime>();

/** The scene's look runtime, created with defaults (no shadows, no sky) on
 * first use — so a material factory works in any scene without setup. */
export function getLook(scene: Scene): LookRuntime {
  return RUNTIMES.get(scene) ?? new LookRuntime(scene);
}

/** Create (or reconfigure) the scene's look runtime. Call once at scene
 * setup, before or after creating materials. */
export function createLook(scene: Scene, options: LookOptions = {}): LookRuntime {
  const existing = RUNTIMES.get(scene);
  if (!existing) return new LookRuntime(scene, options);
  Object.assign(existing.config, options.config ?? {});
  if (options.shadowRegion !== undefined) existing.shadows.region = options.shadowRegion;
  if (options.shadowTaps !== undefined) existing.shadows.taps = options.shadowTaps;
  if (options.shadowQuality !== undefined) existing.shadows.setQuality(options.shadowQuality);
  if (options.syncScene !== undefined) existing.syncScene = options.syncScene;
  if (options.sky) existing.enableSky();
  return existing;
}

export class LookRuntime {
  /** Live-tunable. Mutate fields (or replace arrays) at any time. */
  readonly config: LookConfig;
  readonly shadows: SunShadows;
  sky: SkyDome | null = null;
  syncScene: boolean;
  /** Inspection view, compiled in only while non-zero: 1 albedo, 2 normal,
   * 3 real-time shadow, 4 baked AO, 5 lighting on grey, 6 baked sun,
   * 7 shadow-map coordinates. */
  debugView = 0;
  private appliedDebugView = 0;
  /** Shader clock in seconds (wind). Set `freezeTime` to stop it. */
  time = 0;
  freezeTime = false;
  /**
   * Cars currently on the ground (at most `LOOK_MAX_CONTACTS` are used).
   * Keep the objects and update their fields every frame, or replace the
   * array — both work. See `ContactOccluder`.
   */
  contacts: ContactOccluder[] = [];
  private readonly contactA = new Array<number>(LOOK_MAX_CONTACTS * 4).fill(0);
  private readonly contactB = new Array<number>(LOOK_MAX_CONTACTS * 4).fill(0);

  private readonly scene: Scene;
  private readonly materials = new Map<ShaderMaterial, Registered>();
  private readonly observer: Observer<Scene>;

  // Scratch uniforms, refilled every frame.
  private readonly sunDir = new Vector3();
  private readonly sunColor = new Color3();
  private readonly specColor = new Color3();
  private readonly skyColor = new Color3();
  private readonly groundColor = new Color3();
  private readonly shadowTint = new Color3();
  private readonly groundShade = new Vector4();
  private readonly envZenith = new Color3();
  private readonly envHorizon = new Color3();
  private readonly fog = new Vector4();
  private readonly shape = new Vector4();
  private readonly grade = new Vector4();
  private readonly misc = new Vector4();
  private readonly wind = new Vector4();
  private readonly identity = Matrix.Identity();

  constructor(scene: Scene, options: LookOptions = {}) {
    registerLookShaders();
    this.scene = scene;
    RUNTIMES.set(scene, this);
    this.config = { ...defaultLookConfig(), ...(options.config ?? {}) };
    this.syncScene = options.syncScene ?? true;
    this.shadows = new SunShadows(scene, {
      quality: options.shadowQuality ?? 'off',
      region: options.shadowRegion,
      taps: options.shadowTaps,
    });
    this.shadows.onChanged = () => {
      for (const reg of this.materials.values()) this.applyDefines(reg.material);
    };
    if (options.sky) this.enableSky();

    // Before-render (not before-camera-render): the shadow map is drawn at
    // the top of scene.render() and needs this frame's matrix.
    this.observer = scene.onBeforeRenderObservable.add(() => this.update());
    scene.onDisposeObservable.addOnce(() => this.dispose());
    this.update();

    if (import.meta.env.DEV) {
      (window as unknown as { __look: LookRuntime }).__look = this;
    }
  }

  enableSky(): SkyDome {
    this.sky ??= new SkyDome(this.scene);
    return this.sky;
  }

  /**
   * Hand a material to the runtime: its look uniforms are refreshed every
   * frame, its shadow defines follow the shadow quality, and the shadow map
   * is bound when it draws. The material must list `LOOK_UNIFORMS` and
   * `LOOK_SAMPLERS` in its ShaderMaterial options and `#include<lookLighting>`
   * in its fragment shader. `wind: true` also feeds the `lookWind` uniform
   * (vertex shaders that `#include<lookWind>`). `contact: true` makes it a
   * RECEIVER of the car contact pools (`look.contacts`) — for ground
   * materials (terrain, road ribbons); it costs four small rectangle tests
   * per pixel, so leave it off everything else.
   */
  register(material: ShaderMaterial, options: { wind?: boolean; contact?: boolean } = {}): void {
    if (this.materials.has(material)) return;
    const reg: Registered = { material, wind: options.wind ?? false, contact: options.contact ?? false, bindObserver: null };
    // The comparison sampler cannot go through ShaderMaterial.setTexture
    // (that binds the colour texture); bind the depth attachment on draw.
    reg.bindObserver = material.onBindObservable.add(() => {
      const effect = material.getEffect();
      if (effect && this.shadows.enabled) this.shadows.bind(effect, SHADOW_SAMPLER);
    }) as Observer<unknown>;
    material.onDisposeObservable.addOnce(() => this.materials.delete(material));
    this.materials.set(material, reg);
    this.applyDefines(material);
    this.push(reg);
  }

  unregister(material: ShaderMaterial): void {
    const reg = this.materials.get(material);
    if (!reg) return;
    if (reg.bindObserver) material.onBindObservable.remove(reg.bindObserver as never);
    this.materials.delete(material);
  }

  /** Recompute every uniform from the config and push it to all registered
   * materials. Runs automatically each frame. */
  update(): void {
    const c = this.config;
    const engine = this.scene.getEngine();
    if (!this.freezeTime) this.time += Math.min(engine.getDeltaTime() / 1000, 0.1) * c.windSpeed;

    const len = Math.hypot(c.sunDir.x, c.sunDir.y, c.sunDir.z) || 1;
    this.sunDir.set(c.sunDir.x / len, c.sunDir.y / len, c.sunDir.z / len);
    setLinear(this.sunColor, c.sunColor, c.sunIntensity);
    // Highlights: sun hue pulled toward white at the sun's own peak level.
    const peak = Math.max(this.sunColor.r, this.sunColor.g, this.sunColor.b);
    const wh = c.specularWhiteness;
    this.specColor.set(
      (this.sunColor.r + (peak - this.sunColor.r) * wh) * c.specular,
      (this.sunColor.g + (peak - this.sunColor.g) * wh) * c.specular,
      (this.sunColor.b + (peak - this.sunColor.b) * wh) * c.specular,
    );
    setLinear(this.skyColor, c.skyColor, c.skyIntensity);
    setLinear(this.groundColor, c.groundColor, c.groundIntensity);
    // The tint is a multiplier, not a colour: no gamma on it.
    this.shadowTint.set(c.shadowTint[0], c.shadowTint[1], c.shadowTint[2]);
    this.groundShade.set(c.groundShade.mauve[0], c.groundShade.mauve[1], c.groundShade.mauve[2], c.groundShade.pull);
    // Reflections see a paler, studio-like version of the sky: a fully
    // saturated blue dome turns gold into olive and steel into blue glass.
    setLinearTowardWhite(this.envZenith, c.zenithColor, 0.45, 1.1);
    setLinearTowardWhite(this.envHorizon, c.fogColor, 0.3, 1.25);
    for (let i = 0; i < LOOK_MAX_CONTACTS; i++) {
      const k = this.contacts[i];
      const o = i * 4;
      if (!k) {
        this.contactB[o + 3] = 0;
        continue;
      }
      this.contactA[o] = k.x;
      this.contactA[o + 1] = k.z;
      this.contactA[o + 2] = Math.cos(k.yaw);
      this.contactA[o + 3] = Math.sin(k.yaw);
      this.contactB[o] = k.halfX;
      this.contactB[o + 1] = k.halfZ;
      this.contactB[o + 2] = k.y;
      this.contactB[o + 3] = k.strength ?? 0.55;
    }
    this.fog.set(c.fogColor[0], c.fogColor[1], c.fogColor[2], c.fogDensity);
    this.shape.set(c.terminator, c.scatter, c.softbox, c.reflection);
    this.grade.set(c.exposure, c.saturation, c.contrast, c.emissiveBoost);
    this.misc.set(c.rim, c.shadowStrength, this.time, this.debugView);
    if (this.debugView !== this.appliedDebugView) {
      this.appliedDebugView = this.debugView;
      for (const reg of this.materials.values()) this.applyDefines(reg.material);
    }
    const windLen = Math.hypot(c.windDir[0], c.windDir[1]) || 1;
    this.wind.set(c.windDir[0] / windLen, c.windDir[1] / windLen, c.windStrength, this.time);

    this.shadows.update(this.sunDir, this.wind);

    if (this.syncScene) {
      const s = this.scene;
      s.fogMode = Scene.FOGMODE_EXP2;
      s.fogColor.set(c.fogColor[0], c.fogColor[1], c.fogColor[2]);
      s.fogDensity = c.fogDensity;
      s.clearColor.set(c.fogColor[0], c.fogColor[1], c.fogColor[2], 1);
    }

    this.sky?.update(c, this.sunDir);
    for (const reg of this.materials.values()) this.push(reg);
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer);
    for (const reg of this.materials.values()) {
      if (reg.bindObserver) reg.material.onBindObservable.remove(reg.bindObserver as never);
    }
    this.materials.clear();
    this.shadows.dispose();
    this.sky?.dispose();
    this.sky = null;
    if (RUNTIMES.get(this.scene) === this) RUNTIMES.delete(this.scene);
  }

  private applyDefines(material: ShaderMaterial): void {
    material.setDefine('LOOK_SHADOWS', this.shadows.enabled);
    material.setDefine('LOOK_PCF', String(this.shadows.taps));
    material.setDefine('LOOK_DEBUG', this.debugView !== 0);
    material.setDefine('LOOK_CONTACT', this.materials.get(material)?.contact ?? false);
  }

  private push(reg: Registered): void {
    const m = reg.material;
    m.setVector3('lookSunDir', this.sunDir);
    m.setColor3('lookSunColor', this.sunColor);
    m.setColor3('lookSpecColor', this.specColor);
    m.setColor3('lookSkyColor', this.skyColor);
    m.setColor3('lookGroundColor', this.groundColor);
    m.setColor3('lookShadowTint', this.shadowTint);
    m.setVector4('lookGroundShade', this.groundShade);
    m.setFloat('lookGroundShadeGain', this.config.groundShade.gain - 1);
    m.setColor3('lookEnvZenith', this.envZenith);
    m.setColor3('lookEnvHorizon', this.envHorizon);
    m.setVector4('lookFog', this.fog);
    m.setVector4('lookShape', this.shape);
    m.setVector4('lookGrade', this.grade);
    m.setVector4('lookMisc', this.misc);
    m.setMatrix('lookShadowMatrix', this.shadows.enabled ? this.shadows.matrix : this.identity);
    m.setVector4('lookShadowInfo', this.shadows.info);
    if (reg.wind) m.setVector4(LOOK_WIND_UNIFORM, this.wind);
    if (reg.contact) {
      m.setArray4('lookContactA', this.contactA);
      m.setArray4('lookContactB', this.contactB);
    }
  }
}

/** `setLinear` of the colour mixed `t` of the way to white (no temporaries:
 * this runs every frame). */
function setLinearTowardWhite(out: Color3, srgb: RGB, t: number, intensity: number): void {
  out.set(
    Math.pow(srgb[0] + (1 - srgb[0]) * t, 2.2) * intensity,
    Math.pow(srgb[1] + (1 - srgb[1]) * t, 2.2) * intensity,
    Math.pow(srgb[2] + (1 - srgb[2]) * t, 2.2) * intensity,
  );
}

function setLinear(out: Color3, srgb: RGB, intensity: number): void {
  out.set(
    Math.pow(srgb[0], 2.2) * intensity,
    Math.pow(srgb[1], 2.2) * intensity,
    Math.pow(srgb[2], 2.2) * intensity,
  );
}

export type { ShadowQuality, ShadowTaps } from './shadows';
