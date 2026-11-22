import { Effect, ShaderMaterial } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, getLook, registerLookShaders } from './lighting';
import { LOOK_WIND_UNIFORM } from './wind';

/**
 * The "toy" material: the one shader for every solid asset (cars, props,
 * buildings). All surface properties ride on the vertices in the SolidMesh
 * format — there are no textures and no per-material parameters, so any
 * number of differently painted assets share one material and batch freely:
 *
 *   position  vec3
 *   normal    vec3   smooth or faceted, as authored
 *   color     vec4   rgb = base colour in sRGB, a = EMISSIVE amount (not opacity)
 *   uv        vec2   x = gloss 0..1, y = metal 0..1
 *   uv2       vec2   x = baked AO (1 = open), y = wind weight
 *
 * Instanced variant, per thin instance (same names as the old prop shader):
 *   instanceTint   vec3   multiplies the sRGB base colour
 *   instanceShade  vec2   x = baked AO, y = baked sun visibility
 *
 * Meshes using it must set `applyFog = false` (fog is done in the shader).
 */

export interface ToyMaterialOptions {
  /** For thin-instanced meshes; reads instanceTint / instanceShade. BOTH
   * buffers must be set on the mesh (a missing one reads as 0 = black). */
  instanced?: boolean;
  /** Sway vertices by their wind weight (uv2.y). Foliage only. */
  wind?: boolean;
  /** Render both faces and light the back face with a flipped normal (open
   * shells, leaf cards, flags). */
  doubleSided?: boolean;
}

const SHADER = 'lookToy';

function registerToyShader(): void {
  if (Effect.ShadersStore[`${SHADER}VertexShader`]) return;
  registerLookShaders();

  Effect.ShadersStore[`${SHADER}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    attribute vec2 uv;
    attribute vec2 uv2;
    #ifdef LOOK_INSTANCED
    attribute vec3 instanceTint;
    attribute vec2 instanceShade;
    #endif
    #include<instancesDeclaration>
    uniform mat4 viewProjection;
    #ifdef MULTIVIEW
    uniform mat4 viewProjectionR;
    #endif
    #ifdef LOOK_WIND
    #include<lookWind>
    #endif
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec4 vColor; // rgb LINEAR albedo, a emissive
    varying vec4 vSurf;  // gloss, metal, ao, baked sun visibility
    void main() {
      #include<instancesVertex>
      vec4 wp = finalWorld * vec4(position, 1.0);
      #ifdef LOOK_WIND
      wp.xyz = lookWindSway(wp.xyz, uv2.y);
      #endif
      vWorldPos = wp.xyz;

      // Inverse-transpose for rotation + NON-uniform scale without a matrix
      // inverse: divide by the squared axis lengths. Scatter props are
      // instanced with a separate height scale, which would otherwise tilt
      // every normal toward the stretched axis.
      mat3 m = mat3(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
      vNormal = m * (normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2])));

      vec3 base = color.rgb;
      float ao = uv2.x;
      float sunVis = 1.0;
      #ifdef LOOK_INSTANCED
      base *= instanceTint;
      ao *= instanceShade.x;
      sunVis = instanceShade.y;
      #endif
      // Linearize per VERTEX: three pow() fewer per pixel, and identical for
      // the flat-coloured faces that make up these assets.
      vColor = vec4(pow(base, vec3(2.2)), color.a);
      vSurf = vec4(uv.x, uv.y, ao, sunVis);

      #ifdef MULTIVIEW
      gl_Position = gl_ViewID_OVR == 0u ? viewProjection * wp : viewProjectionR * wp;
      #else
      gl_Position = viewProjection * wp;
      #endif
    }
  `;

  Effect.ShadersStore[`${SHADER}FragmentShader`] = `
    precision highp float;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec4 vColor;
    varying vec4 vSurf;
    #include<lookLighting>
    void main() {
      vec3 n = normalize(vNormal);
      #ifdef LOOK_DOUBLE_SIDED
      n = gl_FrontFacing ? n : -n;
      #endif
      gl_FragColor = lookShade(vColor.rgb, n, vWorldPos, vSurf.x, vSurf.y, vSurf.z, vSurf.w, vColor.a);
    }
  `;
}

export function createToyMaterial(scene: Scene, options: ToyMaterialOptions = {}): ShaderMaterial {
  registerToyShader();
  const instanced = options.instanced ?? false;
  const wind = options.wind ?? false;
  const doubleSided = options.doubleSided ?? false;

  const attributes = ['position', 'normal', 'color', 'uv', 'uv2'];
  if (instanced) attributes.push('instanceTint', 'instanceShade');
  const uniforms = ['world', 'viewProjection', ...LOOK_UNIFORMS];
  if (wind) uniforms.push(LOOK_WIND_UNIFORM);
  const defines: string[] = [];
  if (instanced) defines.push('LOOK_INSTANCED');
  if (wind) defines.push('LOOK_WIND');
  if (doubleSided) defines.push('LOOK_DOUBLE_SIDED');

  const name = `toy${instanced ? 'Inst' : ''}${wind ? 'Wind' : ''}${doubleSided ? '2S' : ''}`;
  const mat = new ShaderMaterial(name, scene, SHADER, {
    attributes,
    uniforms,
    samplers: [...LOOK_SAMPLERS],
    defines,
  });
  mat.backFaceCulling = !doubleSided;
  // Vertex alpha is the emissive amount. Babylon would otherwise move any
  // mesh flagged hasVertexAlpha into the blended pass (depth writes off,
  // triangles smearing over each other); pin the material opaque so that
  // cannot happen whatever the mesh says.
  mat.needAlphaBlendingForMesh = () => false;

  getLook(scene).register(mat, { wind });
  return mat;
}
