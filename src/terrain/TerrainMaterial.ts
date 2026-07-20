import { Effect, ShaderMaterial, Vector3, Color3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import { SUN_DIR } from './generateTerrain';

/** Procedural toon terrain material — no textures, one cheap fragment path
 * (Quest-friendly): albedo = Σ splat_i × palette_i with quantized grass
 * patchwork, banded N·L sun × baked terrain self-shadow, per-vertex AO on the
 * ambient term, road-edge outline tint, height tint, manual distance fog
 * (ShaderMaterial ignores scene.fog). Tiling textures multiply into the same
 * weights later. */
export function createTerrainMaterial(scene: Scene): ShaderMaterial {
  Effect.ShadersStore['terrainVertexShader'] = `
    precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec4 color;
    attribute vec3 shade; // x: AO, y: baked sun visibility, z: albedo tint
    uniform mat4 worldViewProjection;
    uniform mat4 world;
    varying vec3 vNormal;
    varying vec4 vSplat;
    varying vec3 vShade;
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = world * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vNormal = mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal;
      vSplat = color;
      vShade = shade;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;

  Effect.ShadersStore['terrainFragmentShader'] = `
    precision highp float;
    varying vec3 vNormal;
    varying vec4 vSplat;
    varying vec3 vShade;
    varying vec3 vWorldPos;
    uniform vec3 lightDir;
    uniform vec3 sunColor;
    uniform vec3 ambientColor;
    uniform vec3 cGrass;
    uniform vec3 cRock;
    uniform vec3 cDirt;
    uniform vec3 cMeadow;
    uniform vec3 cameraPosition;
    uniform vec3 fogColor;
    uniform float fogDensity;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    // One octave of smoothed value noise — drives the grass patchwork.
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

      // Quantized two-tone patchwork on grass/meadow only: bounded tone
      // patches (picture-book fields) instead of smooth noise stains.
      // ("patch" is a reserved word in GLSL ES 3.00 — hence "fieldTone".)
      float grassy = vSplat.r + vSplat.a;
      float fieldTone = smoothstep(0.46, 0.56, vnoise(vWorldPos.xz * 0.09));
      albedo = mix(albedo, albedo * vec3(1.08, 1.02, 0.72), fieldTone * 0.45 * grassy);

      // Height tint: lift and warm the tops slightly.
      albedo = mix(albedo, albedo * vec3(1.12, 1.08, 0.95), smoothstep(2.0, 12.0, vWorldPos.y));
      // Road-edge outline (and future prop darkening).
      albedo *= vShade.z;

      // 4-band toon ramp on N.L. Flat ground sits at ndl = ${SUN_DIR.y.toFixed(3)},
      // inside the third band — so sun-facing slopes still pop one band
      // brighter than the flats, and away-slopes drop off in two steps.
      float ndl = clamp(dot(n, lightDir), 0.0, 1.0);
      float band = 0.18;
      band += 0.34 * smoothstep(0.32, 0.40, ndl);
      band += 0.28 * smoothstep(0.60, 0.68, ndl);
      band += 0.20 * smoothstep(0.78, 0.86, ndl);

      float sunVis = vShade.y;
      float ao = vShade.x;
      vec3 light = ambientColor * mix(0.35, 1.0, ao) + sunColor * band * sunVis * mix(0.8, 1.0, ao);
      vec3 color = albedo * light;

      // Manual EXP2 fog, matched to the scene fog on standard materials.
      float dist = length(vWorldPos - cameraPosition);
      float fog = clamp(exp(-pow(dist * fogDensity, 2.0)), 0.0, 1.0);
      gl_FragColor = vec4(mix(fogColor, color, fog), 1.0);
    }
  `;

  const mat = new ShaderMaterial('terrainMat', scene, 'terrain', {
    attributes: ['position', 'normal', 'color', 'shade'],
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
      'cameraPosition',
      'fogColor',
      'fogDensity',
    ],
  });

  mat.setVector3('lightDir', new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z));
  // Warm sun / cool sky ambient — the split is what makes the palette pop.
  mat.setColor3('sunColor', new Color3(1.0, 0.93, 0.78));
  mat.setColor3('ambientColor', new Color3(0.42, 0.50, 0.62));
  // Candy palette: saturated grass, warm cream road, warm grey rock.
  mat.setColor3('cGrass', new Color3(0.40, 0.70, 0.28));
  mat.setColor3('cRock', new Color3(0.56, 0.53, 0.48));
  mat.setColor3('cDirt', new Color3(0.83, 0.67, 0.44));
  mat.setColor3('cMeadow', new Color3(0.72, 0.71, 0.32));
  mat.setColor3('fogColor', scene.fogColor);
  mat.setFloat('fogDensity', scene.fogDensity);
  mat.backFaceCulling = true;
  return mat;
}
