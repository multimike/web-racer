import { Effect, ShaderMaterial, Vector4 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { LOOK_SAMPLERS, LOOK_UNIFORMS, getLook, registerLookShaders } from '../../gfx/look/lighting';

/**
 * Far-tier material: the instanced toy shader (src/gfx/look/ToyMaterial.ts)
 * without wind, plus the RING TEST that makes the near and far tiers an
 * exact partition. `lodRing` = (centre x, centre z, radius, unused); an
 * instance whose origin lies strictly inside the ring is collapsed to a
 * point outside the clip volume (all three corners on one point: nothing is
 * rasterised), because the near tier draws that placement from its full mesh.
 *
 *  - instanced (default): origin = the thin instance's translation,
 *    `finalWorld[3].xz` (the mesh's own world matrix is the identity);
 *  - `merged` (define FAR_MERGED): a static mesh of many placements merged
 *    in world space (all far buildings; all far dressing), no instance
 *    attributes; per vertex `lodOrigin` (vec2) = the placement's x, z,
 *    `lodShade` (vec2) = the placement's (ground AO, baked sun visibility)
 *    and `lodTint` (vec3) = its tint — exactly the values the near tier's
 *    `instanceShade` / `instanceTint` carry, so nothing changes colour or
 *    brightness when it changes tier (buildings: AO 1, tint 1).
 *
 * The CPU side keeps the same float32 centre and radius it uploads and tests
 * `dx² + dz² < r²` in float32 too (`ringInside`), so which tier draws a
 * placement is decided identically on both sides.
 */

const SHADER = 'lookFar';

function registerFarShader(): void {
  if (Effect.ShadersStore[`${SHADER}VertexShader`]) return;
  registerLookShaders();

  Effect.ShadersStore[`${SHADER}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    attribute vec2 uv;
    attribute vec2 uv2;
    #ifdef FAR_MERGED
    attribute vec2 lodOrigin;
    attribute vec2 lodShade;
    attribute vec3 lodTint;
    #else
    attribute vec3 instanceTint;
    attribute vec2 instanceShade;
    #endif
    #include<instancesDeclaration>
    uniform mat4 viewProjection;
    #ifdef MULTIVIEW
    uniform mat4 viewProjectionR;
    #endif
    uniform vec4 lodRing;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec4 vColor; // rgb LINEAR albedo, a emissive
    varying vec4 vSurf;  // gloss, metal, ao, baked sun visibility
    void main() {
      #include<instancesVertex>
      #ifdef FAR_MERGED
      vec2 o = lodOrigin - lodRing.xy;
      #else
      vec2 o = finalWorld[3].xz - lodRing.xy;
      #endif
      if (dot(o, o) < lodRing.z * lodRing.z) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vec4 wp = finalWorld * vec4(position, 1.0);
      vWorldPos = wp.xyz;

      mat3 m = mat3(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
      vNormal = m * (normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2])));

      vec3 base = color.rgb;
      float ao = uv2.x;
      float sunVis = 1.0;
      #ifdef FAR_MERGED
      base *= lodTint;
      ao *= lodShade.x;
      sunVis = lodShade.y;
      #else
      base *= instanceTint;
      ao *= instanceShade.x;
      sunVis = instanceShade.y;
      #endif
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
      gl_FragColor = lookShade(vColor.rgb, n, vWorldPos, vSurf.x, vSurf.y, vSurf.z, vSurf.w, vColor.a);
    }
  `;
}

export interface FarMaterial {
  material: ShaderMaterial;
  /** The values last uploaded, already float32-rounded. */
  readonly ring: { x: number; z: number; radius: number };
  /** Upload a new ring (no-op when unchanged). */
  setRing(x: number, z: number, radius: number): void;
}

export function createFarMaterial(scene: Scene, options: { merged?: boolean } = {}): FarMaterial {
  registerFarShader();
  const merged = options.merged ?? false;
  const attributes = ['position', 'normal', 'color', 'uv', 'uv2'];
  attributes.push(...(merged ? ['lodOrigin', 'lodShade', 'lodTint'] : ['instanceTint', 'instanceShade']));
  const material = new ShaderMaterial(merged ? 'farMerged' : 'farInst', scene, SHADER, {
    attributes,
    uniforms: ['world', 'viewProjection', 'lodRing', ...LOOK_UNIFORMS],
    samplers: [...LOOK_SAMPLERS],
    defines: merged ? ['FAR_MERGED'] : [],
  });
  material.backFaceCulling = true;
  // Vertex alpha is the emissive amount, never opacity.
  material.needAlphaBlendingForMesh = () => false;
  getLook(scene).register(material);

  const ring = { x: NaN, z: NaN, radius: NaN };
  const v = new Vector4(0, 0, 0, 0);
  const setRing = (x: number, z: number, radius: number): void => {
    const fx = Math.fround(x), fz = Math.fround(z), fr = Math.fround(radius);
    if (fx === ring.x && fz === ring.z && fr === ring.radius) return;
    ring.x = fx;
    ring.z = fz;
    ring.radius = fr;
    v.set(fx, fz, fr, 0);
    material.setVector4('lodRing', v);
  };
  setRing(0, 0, 0);
  return { material, ring, setRing };
}

/** The shader's ring test on the CPU, in float32: is (x, z) drawn by the
 * near tier? `x`, `z` must be the float32 values the GPU sees (the matrix
 * buffer / `lodOrigin` are Float32Arrays). */
export function ringInside(x: number, z: number, ring: { x: number; z: number; radius: number }): boolean {
  const f = Math.fround;
  const dx = f(f(x) - ring.x);
  const dz = f(f(z) - ring.z);
  return f(f(dx * dx) + f(dz * dz)) < f(ring.radius * ring.radius);
}
