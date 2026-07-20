import { Effect, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';

/** Procedural toon terrain material — no textures, one cheap fragment path
 * (Quest-friendly): albedo = Σ splat_i × palette_i, banded N·L sun, per-vertex
 * AO on the ambient term, height tint, and one octave of hash noise for macro
 * color variation. Tiling textures multiply into the same weights later. */
export function createTerrainMaterial(scene: Scene): ShaderMaterial {
  Effect.ShadersStore['terrainVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    attribute float ao;
    uniform mat4 worldViewProjection;
    uniform mat4 world;
    varying vec3 vNormal;
    varying vec4 vSplat;
    varying float vAo;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      vSplat = color;
      vAo = ao;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;

  Effect.ShadersStore['terrainFragmentShader'] = `
    precision highp float;
    varying vec3 vNormal;
    varying vec4 vSplat;
    varying float vAo;
    varying vec3 vWorldPos;
    uniform vec3 lightDir;
    uniform vec3 sunColor;
    uniform vec3 ambientColor;
    uniform vec3 cGrass;
    uniform vec3 cRock;
    uniform vec3 cDirt;
    uniform vec3 cMeadow;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    // One octave of smoothed value noise — macro color variation.
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y);
    }

    void main() {
      vec3 n = normalize(vNormal);
      vec3 albedo = vSplat.r * cGrass + vSplat.g * cRock + vSplat.b * cDirt + vSplat.a * cMeadow;
      // Macro variation: large slow patches, subtle.
      albedo *= 0.90 + 0.20 * vnoise(vWorldPos.xz * 0.045);
      // Height tint: lift and warm the tops slightly.
      albedo = mix(albedo, albedo * vec3(1.12, 1.08, 0.95), smoothstep(2.0, 12.0, vWorldPos.y));

      // 3-band toon ramp on N.L (fixed softening width — no derivatives needed).
      float ndl = clamp(dot(n, lightDir), 0.0, 1.0);
      float shade = 0.22;
      shade += 0.38 * smoothstep(0.22, 0.30, ndl);
      shade += 0.40 * smoothstep(0.58, 0.68, ndl);

      vec3 light = ambientColor * mix(0.55, 1.0, vAo) + sunColor * shade * mix(0.85, 1.0, vAo);
      gl_FragColor = vec4(albedo * light, 1.0);
    }
  `;

  const mat = new ShaderMaterial('terrainMat', scene, 'terrain', {
    attributes: ['position', 'normal', 'color', 'ao'],
    uniforms: [
      'worldViewProjection',
      'world',
      'lightDir',
      'sunColor',
      'ambientColor',
      'cGrass',
      'cRock',
      'cDirt',
      'cMeadow',
    ],
  });

  // Same direction as the scene's hemispheric light so props match the terrain.
  mat.setVector3('lightDir', new Vector3(0.3, 1, 0.2).normalize());
  mat.setColor3('sunColor', new Color3(1.0, 0.96, 0.88));
  mat.setColor3('ambientColor', new Color3(0.38, 0.42, 0.50));
  // Cosy palette: warm greens, grey-brown rock, tan dirt, dry meadow.
  mat.setColor3('cGrass', new Color3(0.45, 0.62, 0.30));
  mat.setColor3('cRock', new Color3(0.52, 0.49, 0.45));
  mat.setColor3('cDirt', new Color3(0.68, 0.54, 0.38));
  mat.setColor3('cMeadow', new Color3(0.62, 0.64, 0.33));
  mat.backFaceCulling = true;
  return mat;
}
