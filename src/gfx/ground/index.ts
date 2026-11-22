/**
 * Generated ground materials — public entry point.
 *
 * Eight tileable materials built IN CODE at load (no downloads): the six of
 * design-documents/ground-material-pack (rally-dirt, sunlit-sand,
 * meadow-grass, lavender-gravel, worn-asphalt, village-cobblestone) plus
 * kerb-stone (a strip that tiles along the road) and stone-pavers.
 *
 *   generate*.ts      Babylon-free generators: seed -> RGBA8 tile
 *                     (rgb = sRGB albedo, a = height), mathematically
 *                     periodic; stone layouts add an RGBA8 stone id map
 *   materials.ts      the catalogue + per-material sampling recommendation
 *   GroundTextures.ts createGroundTextures(scene): textures + shader data
 *   groundShader.ts   `#include<groundLayers>`: sampling without visible
 *                     repeat, height blending, lighting normal from height
 *
 * Review page: /ground-lab.html (src/lab/groundLab.ts) — side-by-side with
 * the pack, lit strips, a 200 m repetition test and a vision-style road.
 *
 * How the repeat is hidden (measured in the lab, top-down, 51 m across):
 *  - grainy materials (grass, dirt, sand, gravel, asphalt): `groundSample`,
 *    2 taps. Autocorrelation at the tile period is at the noise floor.
 *  - stone layouts (cobblestone, pavers): `groundStones`, 1 tap + 1 texel
 *    fetch. Every stone of every repeat gets its own tone, so the COLOUR
 *    mosaic never repeats; the joint network still does, every tile. That
 *    is invisible on a road ribbon and, to the eye, on a 50 m square; for a
 *    large plaza seen from above ask for a 12 m cobblestone tile
 *    (GroundTextureOptions.tileMeters + sizes, see below).
 *
 * ===========================================================================
 * SETUP (once per scene)
 *
 *   import { createGroundTextures, bindGroundLayer, groundLayerUniforms, groundLayerSamplers } from '../gfx/ground';
 *
 *   const ground = createGroundTextures(scene, { size: 512 });   // GROUND_TEXTURE_SIZE.quest = 256
 *   console.log(ground.summary);                                 // per-material generation ms
 *   // plaza variant: { sizes: { 'village-cobblestone': 1024 }, tileMeters: { 'village-cobblestone': 12 } }
 *
 *   const mat = new ShaderMaterial('terrainMat', scene, 'terrain', {
 *     attributes: ['position', 'normal', 'color', 'shade'],
 *     uniforms: ['world', 'worldViewProjection', ...LOOK_UNIFORMS,
 *                ...groundLayerUniforms('gGrass', 'gRock', 'gDirt')],
 *     samplers: [...LOOK_SAMPLERS, ...groundLayerSamplers('gGrass', 'gRock', 'gDirt')],
 *   });
 *   // The terrain's splat channels are grass / rock / dirt / MEADOW. Meadow
 *   // is grass too (flowers and tufts are props), so the snippet below folds
 *   // it into the grass layer with a lighter tint instead of spending two
 *   // more taps on a fourth texture.
 *   bindGroundLayer(mat, 'gGrass', ground.layers['meadow-grass']);
 *   bindGroundLayer(mat, 'gRock', ground.layers['lavender-gravel']);
 *   bindGroundLayer(mat, 'gDirt', ground.layers['rally-dirt']);
 *   getLook(scene).register(mat, { contact: true });
 *
 * GLSL gotchas (all hit while building the lab):
 *  - no semicolon inside a comment on a `uniform` line — Babylon's shader
 *    processor splits declarations on it and the comment tail becomes code;
 *  - "sample", "cast" and "patch" are reserved words in GLSL ES 3.00;
 *  - inside an `if` that depends on a varying, use the ...Grad functions
 *    with derivatives taken outside it;
 *  - declare `<prefix>Ids` only for stone layouts (bindGroundLayer binds it
 *    only for those).
 *
 * ---------------------------------------------------------------------------
 * TERRAIN FRAGMENT SHADER (world-XZ projection, splat weights in vSplat =
 * grass / rock / dirt / meadow). 2 taps per layer PRESENT at the pixel (a
 * layer with no weight costs none): 2 on most pixels, 6 worst case.
 *
 *   precision highp float;
 *   varying vec3 vWorldPos;  varying vec3 vNormal;  varying vec4 vSplat;  varying vec3 vShade;
 *   uniform sampler2D gGrassTex;  uniform vec4 gGrassMean;  uniform vec4 gGrassInfo;
 *   uniform sampler2D gRockTex;   uniform vec4 gRockMean;   uniform vec4 gRockInfo;
 *   uniform sampler2D gDirtTex;   uniform vec4 gDirtMean;   uniform vec4 gDirtInfo;
 *   #include<lookLighting>
 *   #include<groundLayers>
 *   void main() {
 *     vec2 xz = vWorldPos.xz;
 *     vec3 vary = groundVary(xz);
 *     vec2 dx = dFdx(xz);
 *     vec2 dy = dFdy(xz);
 *     // grass + meadow share the grass layer
 *     vec4 splat = vec4(vSplat.r + vSplat.a, vSplat.g, vSplat.b, 0.0);
 *     vec4 sG = vec4(0.0);  vec4 sR = vec4(0.0);  vec4 sD = vec4(0.0);
 *     if (splat.x > 0.004) sG = groundSampleGrad(gGrassTex, xz * gGrassInfo.xy, dx * gGrassInfo.xy, dy * gGrassInfo.xy, vary.x, gGrassMean, gGrassInfo.w);
 *     if (splat.y > 0.004) sR = groundSampleGrad(gRockTex, xz * gRockInfo.xy, dx * gRockInfo.xy, dy * gRockInfo.xy, vary.x, gRockMean, gRockInfo.w);
 *     if (splat.z > 0.004) sD = groundSampleGrad(gDirtTex, xz * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, gDirtInfo.w);
 *     // Meadow = the same grass, a little lighter and yellower.
 *     sG.rgb *= mix(vec3(1.0), vec3(1.07, 1.04, 0.9), vSplat.a / max(splat.x, 0.004));
 *     // Height-aware weights: where layers meet, the higher surface wins.
 *     vec4 w = groundWeights(splat, vec4(sG.a, sR.a, sD.a, 0.0), 0.2);
 *     vec4 s = w.x * sG + w.y * sR + w.z * sD;
 *     float bump = dot(w.xyz, vec3(gGrassInfo.z, gRockInfo.z, gDirtInfo.z));
 *     vec3 srgb = groundMacro(s.rgb, vary, 0.1) * vShade.z;
 *     vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
 *     gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, vShade.x * groundCavity(s.a, 0.1, 0.5), vShade.y);
 *   }
 *
 * ---------------------------------------------------------------------------
 * ROAD-RIBBON FRAGMENT SHADER (mesh uv in METERS: uv.x = signed distance
 * from the centreline, uv.y = distance along it; the ribbon is as wide as
 * road + both kerbs). 1 tap on the kerb; on the driving surface 2 taps
 * where it is dirt, 1 tap + 1 texel fetch where it is cobblestone, both
 * only inside the ~4 m transition.
 *
 *   precision highp float;
 *   varying vec3 vWorldPos;  varying vec3 vNormal;  varying vec2 vUV;
 *   uniform sampler2D gDirtTex;    uniform vec4 gDirtMean;    uniform vec4 gDirtInfo;
 *   uniform sampler2D gCobbleTex;  uniform sampler2D gCobbleIds;  uniform vec4 gCobbleMean;  uniform vec4 gCobbleInfo;
 *   uniform sampler2D gKerbTex;    uniform vec4 gKerbMean;    uniform vec4 gKerbInfo;
 *   uniform vec4 roadShape;   // see below
 *   #include<lookLighting>
 *   #include<groundLayers>
 *   // roadShape: x half width of the driving surface (3.5), y kerb width (0.4),
 *   //            z uv.y where the village paving starts, w length of the transition (9)
 *   void main() {
 *     vec3 vary = groundVary(vWorldPos.xz);
 *     float across = abs(vUV.x);
 *     vec2 dx = dFdx(vUV);
 *     vec2 dy = dFdy(vUV);
 *     // Kerb | road border, filtered (0 road, 1 kerb, both sampled in the one pixel between).
 *     float kerb = groundEdge(across - roadShape.x);
 *     vec4 sKerb = vec4(0.0);  vec4 sRoad = vec4(0.0);  float bumpRoad = 0.0;  float aoRoad = 1.0;
 *     if (kerb > 0.0) {
 *       // u: 0 at the road, 1 at the verge. The two sides get different v
 *       // offsets so their joints do not mirror.
 *       vec2 kscale = vec2(1.0 / roadShape.y, gKerbInfo.y);
 *       vec2 kuv = vec2((across - roadShape.x) * kscale.x, vUV.y * kscale.y + step(0.0, vUV.x) * 0.37);
 *       sKerb = groundTapGrad(gKerbTex, kuv, dx * kscale, dy * kscale);
 *     }
 *     if (kerb < 1.0) {
 *       // 0 = dirt road, 1 = village paving, along a wobbly front. groundBlend
 *       // only mixes for t in 0.28 .. 0.72 (these height ranges, soft 0.07),
 *       // so outside it one of the two surfaces is not sampled at all.
 *       float t = clamp((vUV.y - roadShape.z) / roadShape.w + (groundNoise(vUV * 0.35) - 0.5) * 0.5, 0.0, 1.0);
 *       vec4 dirt = vec4(0.0, 0.0, 0.0, 0.5);  vec4 cobble = vec4(0.0);
 *       if (t < 0.72) dirt = groundStreakedGrad(gDirtTex, vUV * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, 0.6);
 *       if (t > 0.28) cobble = groundStonesGrad(gCobbleTex, gCobbleIds, vUV, dx, dy, gCobbleInfo);
 *       // Stones break through the dirt top-first.
 *       float w = groundBlend(dirt.a * 0.6 + 0.2, cobble.a, t, 0.07);
 *       sRoad = mix(dirt, cobble, w);
 *       bumpRoad = mix(gDirtInfo.z, gCobbleInfo.z, w);
 *       aoRoad = mix(1.0, groundCavity(sRoad.a, 0.08, 0.5), w);
 *     }
 *     vec4 s = mix(sRoad, sKerb, kerb);
 *     float bump = mix(bumpRoad, gKerbInfo.z, kerb);
 *     float ao = mix(aoRoad, groundCavity(sKerb.a, 0.08, 0.5), kerb);
 *     vec3 srgb = groundMacro(s.rgb, vary, 0.1);
 *     vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
 *     gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, ao, 1.0);
 *   }
 *
 * Other surfaces: garage apron = groundSample of worn-asphalt, lines with
 * groundPaint(srgb, s.a, lineMask, vec3(0.93, 0.76, 0.2)); forecourts and
 * paths = groundStones(gPaveTex, gPaveIds, vWorldPos.xz, gPaveInfo) of
 * stone-pavers. Both are in the lab's strip shader. A foreign stone texture
 * without an id map (the pack's cobblestone) can only use groundTinted.
 * ===========================================================================
 */
export type { GroundGenOptions, GroundPalette, GroundTile } from './core';
export { GROUND_MATERIALS, GROUND_MATERIAL_IDS, PACK_MATERIAL_IDS, generateGroundTile } from './materials';
export type { GroundMaterialDef, GroundMaterialId } from './materials';
export {
  GROUND_TEXTURE_SIZE,
  bindGroundLayer,
  createGroundLayer,
  createGroundTextures,
  groundLayerSamplers,
  groundLayerUniforms,
} from './GroundTextures';
export type { GroundLayer, GroundTextureOptions, GroundTextureSet } from './GroundTextures';
export { registerGroundShader } from './groundShader';
