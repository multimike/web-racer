import { Effect, ShaderMaterial } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { bindGroundLayer, groundLayerSamplers, groundLayerUniforms, registerGroundShader } from '../../gfx/ground';
import type { GroundTextureSet } from '../../gfx/ground';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, getLook, registerLookShaders } from '../../gfx/look/lighting';

/**
 * The terrain chunks' material: the terrain fragment shader of
 * src/gfx/ground/index.ts on the world's splat weights, lit through
 * `lookShadeMatte` with the baked AO and hill shadow of `WorldData.shade`.
 *
 * Vertex format (terrainSurface.ts):
 *   position  vec3   on the heightfield samples
 *   normal    vec3   central differences
 *   color     vec4   splat weights grass / rock / dirt / meadow (NOT a colour:
 *                    the mesh must set hasVertexAlpha = false)
 *   shade     vec3   AO, baked sun visibility, albedo tint
 *
 * Meadow is folded into the grass layer with a lighter, yellower tint (two
 * taps instead of a fourth texture; flowers and tufts are props).
 */

const SHADER = 'renderTerrainLook';
const LAYERS = ['gGrass', 'gRock', 'gDirt'];

/** The vertex shader every ground mesh of this folder shares the shape of:
 * world position, normal, and the toy shader's MULTIVIEW branch (Quest
 * stereo in one pass). `extraAttributes` / `extraVaryings` / `copy` add the
 * per-mesh data. */
export function groundVertexShader(extraAttributes: string, extraVaryings: string, copy: string): string {
  return `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    ${extraAttributes}
    uniform mat4 world;
    uniform mat4 viewProjection;
    #ifdef MULTIVIEW
    uniform mat4 viewProjectionR;
    #endif
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    ${extraVaryings}
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      // Ground meshes are never scaled or rotated (Havok writes world-space
      // transforms; the XR rig scales the camera instead): no inverse-transpose.
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      ${copy}
      #ifdef MULTIVIEW
      gl_Position = gl_ViewID_OVR == 0u ? viewProjection * wp : viewProjectionR * wp;
      #else
      gl_Position = viewProjection * wp;
      #endif
    }
  `;
}

const FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec4 vSplat;
  varying vec3 vShade;
  uniform sampler2D gGrassTex;
  uniform vec4 gGrassMean;
  uniform vec4 gGrassInfo;
  uniform sampler2D gRockTex;
  uniform vec4 gRockMean;
  uniform vec4 gRockInfo;
  uniform sampler2D gDirtTex;
  uniform vec4 gDirtMean;
  uniform vec4 gDirtInfo;
  #include<lookLighting>
  #include<groundLayers>
  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 vary = groundVary(xz);
    // Derivatives once, outside the branches: the Grad samplers take them.
    vec2 dx = dFdx(xz);
    vec2 dy = dFdy(xz);
    // grass + meadow share the grass layer
    vec4 splat = vec4(vSplat.r + vSplat.a, vSplat.g, vSplat.b, 0.0);
    vec4 sG = vec4(0.0);
    vec4 sR = vec4(0.0);
    vec4 sD = vec4(0.0);
    // Only the layers present at this pixel are sampled: 2 taps on most.
    if (splat.x > 0.004) sG = groundSampleGrad(gGrassTex, xz * gGrassInfo.xy, dx * gGrassInfo.xy, dy * gGrassInfo.xy, vary.x, gGrassMean, gGrassInfo.w);
    if (splat.y > 0.004) sR = groundSampleGrad(gRockTex, xz * gRockInfo.xy, dx * gRockInfo.xy, dy * gRockInfo.xy, vary.x, gRockMean, gRockInfo.w);
    if (splat.z > 0.004) sD = groundSampleGrad(gDirtTex, xz * gDirtInfo.xy, dx * gDirtInfo.xy, dy * gDirtInfo.xy, vary.x, gDirtMean, gDirtInfo.w);
    // Meadow = the same grass, a little lighter and yellower.
    sG.rgb *= mix(vec3(1.0), vec3(1.07, 1.04, 0.9), clamp(vSplat.a / max(splat.x, 0.004), 0.0, 1.0));
    // Height-aware weights: where layers meet, the higher surface wins.
    vec4 w = groundWeights(splat, vec4(sG.a, sR.a, sD.a, 0.0), 0.2);
    vec4 s = w.x * sG + w.y * sR + w.z * sD;
    float bump = dot(w.xyz, vec3(gGrassInfo.z, gRockInfo.z, gDirtInfo.z));
    vec3 srgb = groundMacro(s.rgb, vary, 0.1) * vShade.z;
    vec3 n = groundNormal(normalize(vNormal), vWorldPos, s.a * bump);
    gl_FragColor = lookShadeMatte(lookToLinear(srgb), n, vWorldPos, vShade.x * groundCavity(s.a, 0.1, 0.5), vShade.y);
  }
`;

function registerTerrainShader(): void {
  if (Effect.ShadersStore[`${SHADER}VertexShader`]) return;
  registerLookShaders();
  registerGroundShader();
  Effect.ShadersStore[`${SHADER}VertexShader`] = groundVertexShader(
    'attribute vec4 color;\n    attribute vec3 shade;',
    'varying vec4 vSplat;\n    varying vec3 vShade;',
    'vSplat = color;\n      vShade = shade;',
  );
  Effect.ShadersStore[`${SHADER}FragmentShader`] = FRAGMENT;
}

/** ONE material for all terrain chunks, registered with the look runtime as
 * a contact receiver (the cars' soft pools). Not frozen: the look runtime
 * pushes its uniforms every frame. */
export function createTerrainLookMaterial(scene: Scene, ground: GroundTextureSet): ShaderMaterial {
  registerTerrainShader();
  const mat = new ShaderMaterial('terrainLook', scene, SHADER, {
    attributes: ['position', 'normal', 'color', 'shade'],
    uniforms: ['world', 'viewProjection', ...LOOK_UNIFORMS, ...groundLayerUniforms(...LAYERS)],
    samplers: [...LOOK_SAMPLERS, ...groundLayerSamplers(...LAYERS)],
  });
  bindGroundLayer(mat, 'gGrass', ground.layers['meadow-grass']);
  bindGroundLayer(mat, 'gRock', ground.layers['lavender-gravel']);
  bindGroundLayer(mat, 'gDirt', ground.layers['rally-dirt']);
  // The 4-float `color` holds splat weights; Babylon would otherwise draw the
  // terrain in the transparent pass.
  mat.needAlphaBlendingForMesh = () => false;
  getLook(scene).register(mat, { contact: true });
  return mat;
}
