import { Effect, ShaderMaterial, Vector4 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { bindGroundLayer, groundLayerSamplers, groundLayerUniforms, registerGroundShader } from '../../gfx/ground';
import type { GroundTextureSet } from '../../gfx/ground';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, getLook, registerLookShaders } from '../../gfx/look/lighting';
import { groundVertexShader } from './TerrainLookMaterial';

/**
 * Materials of the paving (paving.ts builds the meshes):
 *
 * ROAD RIBBON — road surface, kerb stones and the painted start line in one
 * mesh / one draw call. The road-ribbon shader of src/gfx/ground/index.ts,
 * changed to read the surface from the vertex instead of a `roadShape`
 * uniform:
 *   uv     vec2   x = lateral meters from the centreline (+ = left of
 *                 travel), y = arc length meters (0 at the start line, the
 *                 closing row carries the loop length)
 *   color  vec4   x kind (0 road, 1 kerb), y cobble weight 0..1, z kerb
 *                 style (0 rough, 0.5 dressed, 1 flush), w kerb u across the
 *                 kerb 0 (road side) .. 1 (verge side)
 *   shade  vec2   ambient occlusion and baked hill shadow of the ground
 *                 under the vertex (WorldData.shade), so the road darkens
 *                 inside a hill's shadow exactly as the terrain beside it
 *
 * PADS — asphalt apron, paver forecourts and paths, cobble square, painted
 * markings, all sampled by world x / z:
 *   color  vec4   x surface (0 asphalt, 0.5 pavers, 1 cobble), y paint 0 / 1,
 *                 z paint colour (0 yellow, 1 white)
 *   shade  vec2   as above
 *
 * Both: lookShadeMatte, registered as contact receivers, double-sided,
 * pinned opaque (the 4-float colour is data, not alpha). The road's cobbles
 * are sampled by world x / z as the pads' are (one continuous stone field
 * from road to square); dirt streaks, kerbs and the start line keep the
 * track coordinates. Pads never lie under the ribbon (paving.ts cuts them
 * away under the road and kerbs), so the two zOffsets never compete.
 */

const RIBBON = 'renderPavingRibbon';
const PADS = 'renderPavingPads';

const RIBBON_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUV;
  varying vec4 vInfo;
  varying vec2 vShade;
  uniform sampler2D gDirtTex;
  uniform vec4 gDirtMean;
  uniform vec4 gDirtInfo;
  uniform sampler2D gCobbleTex;
  uniform sampler2D gCobbleIds;
  uniform vec4 gCobbleMean;
  uniform vec4 gCobbleInfo;
  uniform sampler2D gKerbTex;
  uniform vec4 gKerbMean;
  uniform vec4 gKerbInfo;
  // No semicolons in comments on uniform lines (Babylon splits on them).
  // ribbonShape: x loop length (m), y start-line depth (m), z checker square (m), w dirt streak amount
  uniform vec4 ribbonShape;
  #include<lookLighting>
  #include<groundLayers>

  // Box-filtered checker (0 / 1), anti-aliased by its own footprint: a bare
  // step() pattern drawn in the shader is a staircase MSAA cannot touch.
  float checker(vec2 p) {
    vec2 w = max(fwidth(p), vec2(1e-4));
    vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
    return 0.5 - 0.5 * i.x * i.y;
  }

  void main() {
    vec3 vary = groundVary(vWorldPos.xz);
    // Every derivative outside the branches (the Grad samplers take them).
    vec2 dx = dFdx(vUV);
    vec2 dy = dFdy(vUV);
    // Road cobbles by world x / z, like the pads' stones: track coordinates
    // squeeze the stones on a bend's inside (half length at a 10 m radius)
    // and cut a seam where the road's field meets a square's.
    vec2 xz = vWorldPos.xz;
    vec2 wdx = dFdx(xz);
    vec2 wdy = dFdy(xz);
    float ku = clamp(vInfo.w, 0.0, 1.0);
    float kdx = dFdx(vInfo.w);
    float kdy = dFdy(vInfo.w);
    // Start line: s wraps, so the band is s < depth/2 OR s > length - depth/2.
    float sw = vUV.y > ribbonShape.x * 0.5 ? vUV.y - ribbonShape.x : vUV.y;
    float band = groundEdge(ribbonShape.y * 0.5 - abs(sw));
    float squares = checker(vec2(vUV.x, sw + ribbonShape.y * 0.5) / ribbonShape.z);
    // Dirt-to-cobble front: a broad wander plus a finer one, so the stones
    // straggle a metre or two into the dirt instead of stopping on a line.
    float front = (groundNoise(vUV * 0.35) - 0.5) * 0.75 + (groundNoise(vUV * 1.6 + vec2(4.3, 7.9)) - 0.5) * 0.45;

    vec4 s;
    float bump;
    float ao;
    if (vInfo.x > 0.5) {
      // Kerb: u across the kerb, v along; the two sides get different v
      // offsets so their joints do not mirror across the road.
      vec2 kuv = vec2(ku, vUV.y * gKerbInfo.y + step(0.0, vUV.x) * 0.37);
      s = groundTapGrad(gKerbTex, kuv, vec2(kdx, dx.y * gKerbInfo.y), vec2(kdy, dy.y * gKerbInfo.y));
      // Styles: dressed (village) lighter and cleaner, rough (countryside)
      // darker with a stone-to-stone wander, flush (dropped kerb at a pad)
      // darker still.
      float style = vInfo.z;
      float wander = groundNoise(vec2(vUV.y * 1.7, vUV.x * 0.3 + 9.1)) - 0.5;
      // Softer than the raw strip: joints and stone faces pulled toward the
      // tile mean, and a stone-to-stone tone wander on every style, so the
      // row reads as worn stones rather than bright blocks.
      s.rgb = mix(gKerbMean.rgb, s.rgb, 0.78);
      float tone = style < 0.25 ? 0.93 + 0.18 * wander : style < 0.75 ? 1.03 + 0.1 * wander : 0.88 + 0.08 * wander;
      s.rgb *= tone;
      bump = gKerbInfo.z * (style < 0.25 ? 1.25 : style < 0.75 ? 0.85 : 0.6);
      ao = groundCavity(s.a, 0.08, 0.5);
    } else {
      // 0 = dirt road, 1 = cobbles, along a wobbly front instead of a ruled
      // line. groundBlend only mixes for t in 0.28 .. 0.72 (soft 0.07), so
      // outside it one of the two surfaces is not sampled at all.
      // Full wander only inside the cross-fade; at w = 0 / 1 it stays under
      // 0.24, so pure dirt and pure cobble road never leave their side of
      // groundBlend's 0.28 .. 0.72 window (no stones on the open road, no
      // dirt in the village's joints).
      float w0 = vInfo.y;
      float t = clamp(w0 + front * (0.4 + 2.4 * w0 * (1.0 - w0)), 0.0, 1.0);
      vec4 dirt = vec4(0.0, 0.0, 0.0, 0.5);
      vec4 cobble = vec4(0.0);
      if (t < 0.72) dirt = groundStreakedGrad(gDirtTex, vUV * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, ribbonShape.w);
      if (t > 0.28) cobble = groundStonesGrad(gCobbleTex, gCobbleIds, xz, wdx, wdy, gCobbleInfo);
      // Stones break through the dirt top-first.
      float w = groundBlend(dirt.a * 0.6 + 0.2, cobble.a, t, 0.07);
      s = mix(dirt, cobble, w);
      bump = mix(gDirtInfo.z, gCobbleInfo.z, w);
      ao = mix(1.0, groundCavity(s.a, 0.08, 0.5), w);
    }
    vec3 srgb = groundMacro(s.rgb, vary, 0.1);
    // Checker band: cream and near-black squares. With 0.5 m squares a
    // square spans only one or two stones, so groundPaint's wear on the
    // stone FACES (45 %) let every face show through and left the fully
    // painted joints as a black web: the band read dirty. Here the paint
    // covers faces and joints alike and wears only on the stones' shoulders
    // (the rim between joint and face), and the joint cavities are filled
    // (their darkening mostly lifted), so a black square reads near-black
    // and a cream one cream from the high camera.
    float paint = band * (1.0 - vInfo.x);
    float shoulder = smoothstep(0.38, 0.5, s.a) * (1.0 - smoothstep(0.55, 0.68, s.a));
    float cover = paint * (0.97 - 0.25 * shoulder);
    srgb = mix(srgb, vec3(0.93, 0.9, 0.8), cover * squares);
    srgb = mix(srgb, vec3(0.11, 0.11, 0.12), cover * (1.0 - squares));
    ao = mix(ao, 1.0, 0.75 * paint);
    bump *= 1.0 - 0.7 * paint;
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, ao * vShade.x, vShade.y);
  }
`;

const PADS_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec4 vInfo;
  varying vec2 vShade;
  uniform sampler2D gAsphaltTex;
  uniform vec4 gAsphaltMean;
  uniform vec4 gAsphaltInfo;
  uniform sampler2D gPaverTex;
  uniform sampler2D gPaverIds;
  uniform vec4 gPaverMean;
  uniform vec4 gPaverInfo;
  uniform sampler2D gCobbleTex;
  uniform sampler2D gCobbleIds;
  uniform vec4 gCobbleMean;
  uniform vec4 gCobbleInfo;
  #include<lookLighting>
  #include<groundLayers>
  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 vary = groundVary(xz);
    vec2 dx = dFdx(xz);
    vec2 dy = dFdy(xz);
    vec4 s;
    float bump;
    float ao;
    if (vInfo.x < 0.25) {
      s = groundSampleGrad(gAsphaltTex, xz * gAsphaltInfo.xy, dx * gAsphaltInfo.xy, dy * gAsphaltInfo.xy, vary.x, gAsphaltMean, gAsphaltInfo.w);
      bump = gAsphaltInfo.z;
      ao = groundCavity(s.a, 0.1, 0.5);
    } else if (vInfo.x < 0.75) {
      s = groundStonesGrad(gPaverTex, gPaverIds, xz, dx, dy, gPaverInfo);
      bump = gPaverInfo.z;
      ao = groundCavity(s.a, 0.08, 0.5);
    } else {
      s = groundStonesGrad(gCobbleTex, gCobbleIds, xz, dx, dy, gCobbleInfo);
      bump = gCobbleInfo.z;
      ao = groundCavity(s.a, 0.08, 0.5);
    }
    vec3 srgb = groundMacro(s.rgb, vary, 0.1);
    vec3 paintColor = vInfo.z > 0.5 ? vec3(0.95, 0.94, 0.9) : vec3(0.93, 0.76, 0.2);
    srgb = groundPaint(srgb, s.a, vInfo.y, paintColor);
    bump *= 1.0 - 0.6 * vInfo.y;
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, ao * vShade.x, vShade.y);
  }
`;

function registerPavingShaders(): void {
  if (Effect.ShadersStore[`${RIBBON}VertexShader`]) return;
  registerLookShaders();
  registerGroundShader();
  Effect.ShadersStore[`${RIBBON}VertexShader`] = groundVertexShader(
    'attribute vec2 uv;\n    attribute vec4 color;\n    attribute vec2 shade;',
    'varying vec2 vUV;\n    varying vec4 vInfo;\n    varying vec2 vShade;',
    'vUV = uv;\n      vInfo = color;\n      vShade = shade;',
  );
  Effect.ShadersStore[`${RIBBON}FragmentShader`] = RIBBON_FRAGMENT;
  Effect.ShadersStore[`${PADS}VertexShader`] = groundVertexShader(
    'attribute vec4 color;\n    attribute vec2 shade;',
    'varying vec4 vInfo;\n    varying vec2 vShade;',
    'vInfo = color;\n      vShade = shade;',
  );
  Effect.ShadersStore[`${PADS}FragmentShader`] = PADS_FRAGMENT;
}

function finish(scene: Scene, mat: ShaderMaterial, zOffset: number): ShaderMaterial {
  mat.backFaceCulling = false;
  // Laid a few cm over the same heightfield as the terrain: the depth offset
  // keeps it in front where the two are within a depth step of each other.
  mat.zOffset = zOffset;
  mat.needAlphaBlendingForMesh = () => false;
  getLook(scene).register(mat, { contact: true });
  return mat;
}

export interface RibbonShape {
  /** Loop length, m. */
  length: number;
  /** Start-line band depth along the road, m. */
  lineDepth: number;
  /** Checker square, m. */
  square: number;
}

export function createRibbonMaterial(scene: Scene, ground: GroundTextureSet, shape: RibbonShape): ShaderMaterial {
  registerPavingShaders();
  const layers = ['gDirt', 'gCobble', 'gKerb'];
  const mat = new ShaderMaterial('pavingRibbon', scene, RIBBON, {
    attributes: ['position', 'normal', 'uv', 'color', 'shade'],
    uniforms: ['world', 'viewProjection', 'ribbonShape', ...LOOK_UNIFORMS, ...groundLayerUniforms(...layers)],
    samplers: [...LOOK_SAMPLERS, ...groundLayerSamplers(...layers)],
  });
  bindGroundLayer(mat, 'gDirt', ground.layers['rally-dirt']);
  bindGroundLayer(mat, 'gCobble', ground.layers['village-cobblestone']);
  bindGroundLayer(mat, 'gKerb', ground.layers['kerb-stone']);
  mat.setVector4('ribbonShape', new Vector4(shape.length, shape.lineDepth, shape.square, 0.6));
  return finish(scene, mat, -2);
}

export function createPadMaterial(scene: Scene, ground: GroundTextureSet): ShaderMaterial {
  registerPavingShaders();
  const layers = ['gAsphalt', 'gPaver', 'gCobble'];
  const mat = new ShaderMaterial('pavingPads', scene, PADS, {
    attributes: ['position', 'normal', 'color', 'shade'],
    uniforms: ['world', 'viewProjection', ...LOOK_UNIFORMS, ...groundLayerUniforms(...layers)],
    samplers: [...LOOK_SAMPLERS, ...groundLayerSamplers(...layers)],
  });
  bindGroundLayer(mat, 'gAsphalt', ground.layers['worn-asphalt']);
  bindGroundLayer(mat, 'gPaver', ground.layers['stone-pavers']);
  bindGroundLayer(mat, 'gCobble', ground.layers['village-cobblestone']);
  return finish(scene, mat, -4);
}
