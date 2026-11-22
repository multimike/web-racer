import { RawTexture, Texture, Vector4 } from '@babylonjs/core';
import type { Scene, ShaderMaterial } from '@babylonjs/core';
import type { GroundPalette, GroundTile } from './core';
import { registerGroundShader } from './groundShader';
import { GROUND_MATERIALS, GROUND_MATERIAL_IDS } from './materials';
import type { GroundMaterialId } from './materials';

/**
 * Babylon side of the generated ground materials: builds the tiles once at
 * load, uploads them as small mip-mapped, repeating, anisotropically
 * filtered textures and hands them out with everything a shader needs.
 *
 * Per layer the fragment shader declares (names = the prefix you bound):
 *   uniform sampler2D gGrassTex;   // rgb sRGB albedo, a height
 *   uniform vec4 gGrassMean;       // tile mean (rgb, height)
 *   uniform vec4 gGrassInfo;       // x 1/tile u (1/m), y 1/tile v (1/m), z bump height (m), w sampling argument
 * and, for a stone layout (cobblestone, pavers) only:
 *   uniform sampler2D gCobbleIds;  // stone id map, read with texelFetch
 * and samples it with the functions of `#include<groundLayers>`
 * (groundShader.ts). Setup and complete terrain / road-ribbon fragment
 * snippets are in src/gfx/ground/index.ts.
 */

/** Tile resolution presets. 256 px keeps every shape (the cobblestone joint
 * is still a texel wide) at a quarter of the memory, generation and upload. */
export const GROUND_TEXTURE_SIZE = { desktop: 512, quest: 256 } as const;

export interface GroundTextureOptions {
  /** Pixels along a tile's long side (power of two). Default 512. */
  size?: number;
  /** Per-material size override, e.g. { 'village-cobblestone': 1024 } to
   * give the one material whose shapes are read up close four times the
   * texels (costs four times its generation time). */
  sizes?: Partial<Record<GroundMaterialId, number>>;
  /** World size of a stone layout's tile, meters (GroundGenOptions.tileMeters).
   * For a village SQUARE seen from above pair { 'village-cobblestone': 12 }
   * with sizes { 'village-cobblestone': 1024 }; a road ribbon is fine with
   * the default 6 m. */
  tileMeters?: Partial<Record<'village-cobblestone' | 'stone-pavers', number>>;
  /** World seed: every material derives its own stream from it. Omit for
   * the authored default look. */
  seed?: number;
  /** 'vision' (default) or 'pack' colours. */
  palette?: GroundPalette;
  /** Build only these (default: all eight). */
  materials?: readonly GroundMaterialId[];
  /** Anisotropic filtering level (default 8; 4 is plenty on Quest). Ground
   * is always seen at a grazing angle — without it the far half of the
   * road turns to mush. */
  anisotropy?: number;
}

export interface GroundLayer {
  id: string;
  name: string;
  texture: RawTexture;
  /** World size of one repeat, meters: [u, v]. */
  tileMeters: [number, number];
  /** Physical relief of the height channel, meters. */
  reliefMeters: number;
  /** Relief exaggeration recommended for the lighting normal. */
  bump: number;
  /** Tile mean: sRGB albedo 0..1, height 0..1. */
  mean: [number, number, number, number];
  /** Stone layouts only: the stone id map (RGBA8, no mips, same size as
   * `texture`) that `groundStones` reads with texelFetch. */
  idTexture: RawTexture | null;
  /** Recommended sampling function, see GroundMaterialDef.sampling.
   * 'tinted' = a stone layout WITHOUT an id map (a foreign tile):
   * `groundTinted`. */
  sampling: 'blend' | 'stones' | 'tinted' | 'single';
  /** The sampling argument bound as <prefix>Info.w: `crisp` of groundSample /
   * tone spread of groundStones / `amount` of groundTinted. */
  arg: number;
  width: number;
  height: number;
  /** Time spent generating the pixels, milliseconds. */
  generationMs: number;
}

export interface GroundTextureSet {
  layers: Record<GroundMaterialId, GroundLayer>;
  size: number;
  /** Sum of the generators' time, milliseconds. */
  generationMs: number;
  /** Texture creation + mip generation, milliseconds. */
  uploadMs: number;
  /** One line per material, for the console. */
  summary: string;
  dispose(): void;
}

/** Wrap one generated (or foreign) tile as a texture + its shader data. */
export function createGroundLayer(
  scene: Scene,
  tile: GroundTile,
  meta: { name?: string; bump?: number; arg?: number; sampling?: GroundLayer['sampling']; anisotropy?: number; generationMs?: number } = {},
): GroundLayer {
  registerGroundShader();
  // RawTexture, not DynamicTexture: no canvas round trip (which would
  // premultiply by the height stored in alpha), and mips are built by the GPU.
  const texture = RawTexture.CreateRGBATexture(tile.pixels, tile.width, tile.height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.name = `ground:${tile.id}`;
  // A strip (kerb) repeats along v only; clamping u keeps the block bevels
  // from bleeding around the edge through the mips.
  const strip = tile.width !== tile.height;
  texture.wrapU = strip ? Texture.CLAMP_ADDRESSMODE : Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = meta.anisotropy ?? 8;
  let idTexture: RawTexture | null = null;
  if (tile.stoneIds) {
    // Ids must never be averaged: no mips, nearest (the shader uses
    // texelFetch, which ignores the sampler anyway).
    idTexture = RawTexture.CreateRGBATexture(tile.stoneIds, tile.width, tile.height, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    idTexture.name = `ground:${tile.id}:ids`;
    idTexture.wrapU = idTexture.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  // A stone layout without an id map can only be brightness-tinted.
  const sampling = meta.sampling === 'stones' && !idTexture ? 'tinted' : (meta.sampling ?? 'blend');
  return {
    id: tile.id,
    name: meta.name ?? tile.id,
    texture,
    idTexture,
    tileMeters: tile.tileMeters,
    reliefMeters: tile.reliefMeters,
    bump: meta.bump ?? 1,
    mean: tile.mean,
    // The tone spread of a stone layout is a property of the tile (it
    // differs per palette), not of the catalogue.
    arg: sampling === 'stones' ? (tile.stoneSpread ?? meta.arg ?? 1) : sampling === 'tinted' ? 0.25 : (meta.arg ?? 0),
    sampling,
    width: tile.width,
    height: tile.height,
    generationMs: meta.generationMs ?? 0,
  };
}

/**
 * Generate and upload the ground materials. Synchronous. Measured in Node
 * on a (busy) M1 Pro, all eight, best of 25: ~120 ms at 512 px once the JIT
 * is warm and ~2.5x that for the very first call of a process, ~35 ms at
 * 256 px; upload + mips a few ms. NOT measured on a Quest — time it there
 * (`summary`) before choosing between this call at load and a worker; the
 * generators are Babylon-free, so they can move.
 */
export function createGroundTextures(scene: Scene, options: GroundTextureOptions = {}): GroundTextureSet {
  registerGroundShader();
  const size = options.size ?? GROUND_TEXTURE_SIZE.desktop;
  const ids = options.materials ?? GROUND_MATERIAL_IDS;
  const layers = {} as Record<GroundMaterialId, GroundLayer>;
  let generationMs = 0;
  let uploadMs = 0;
  const lines: string[] = [];
  for (const id of ids) {
    const def = GROUND_MATERIALS[id];
    const t0 = performance.now();
    const tile = def.generate({
      size: options.sizes?.[id] ?? size,
      palette: options.palette,
      tileMeters: id === 'village-cobblestone' || id === 'stone-pavers' ? options.tileMeters?.[id] : undefined,
      // The shader paints the stone tones (groundStones), per repeat.
      stoneTones: 'plain',
      // Each material keeps its own stream under a shared world seed.
      seed: options.seed === undefined ? undefined : (Math.imul(options.seed, 7919) + GROUND_MATERIAL_IDS.indexOf(id) * 104729) >>> 0,
    });
    const t1 = performance.now();
    const layer = createGroundLayer(scene, tile, {
      name: def.name,
      bump: def.bump,
      arg: def.arg,
      sampling: def.sampling,
      anisotropy: options.anisotropy,
      generationMs: t1 - t0,
    });
    const t2 = performance.now();
    layers[id] = layer;
    generationMs += t1 - t0;
    uploadMs += t2 - t1;
    lines.push(`${id.padEnd(20)} ${tile.width}x${tile.height}  ${(t1 - t0).toFixed(1)} ms  tile ${tile.tileMeters[0]}x${tile.tileMeters[1]} m`);
  }
  const summary = `[ground] ${ids.length} materials @${size}px: generate ${generationMs.toFixed(1)} ms, upload ${uploadMs.toFixed(1)} ms\n  ${lines.join('\n  ')}`;
  return {
    layers,
    size,
    generationMs,
    uploadMs,
    summary,
    dispose() {
      for (const id of ids) {
        layers[id]?.texture.dispose();
        layers[id]?.idTexture?.dispose();
      }
    },
  };
}

/** Uniform names of the given layer prefixes, for ShaderMaterial options. */
export function groundLayerUniforms(...prefixes: string[]): string[] {
  return prefixes.flatMap((p) => [`${p}Mean`, `${p}Info`]);
}

/** Sampler names of the given layer prefixes, for ShaderMaterial options.
 * Lists `<prefix>Ids` for every prefix, stone layout or not: a sampler name
 * the shader does not declare is ignored, a missing one silently reads
 * texture unit 0. */
export function groundLayerSamplers(...prefixes: string[]): string[] {
  return prefixes.flatMap((p) => [`${p}Tex`, `${p}Ids`]);
}

/**
 * Bind a layer to a material under a uniform prefix:
 *   <prefix>Tex   sampler2D
 *   <prefix>Ids   sampler2D  stone id map — stone layouts only
 *   <prefix>Mean  vec4  tile mean (rgb sRGB, height)
 *   <prefix>Info  vec4  x = 1 / tile u (1/m), y = 1 / tile v (1/m),
 *                       z = bump height in meters (relief x exaggeration),
 *                       w = the layer's `arg` (crisp of groundSample / spread of groundStones)
 */
export function bindGroundLayer(material: ShaderMaterial, prefix: string, layer: GroundLayer, overrides: { bump?: number; arg?: number } = {}): void {
  material.setTexture(`${prefix}Tex`, layer.texture);
  if (layer.idTexture) material.setTexture(`${prefix}Ids`, layer.idTexture);
  material.setVector4(`${prefix}Mean`, new Vector4(layer.mean[0], layer.mean[1], layer.mean[2], layer.mean[3]));
  material.setVector4(
    `${prefix}Info`,
    new Vector4(1 / layer.tileMeters[0], 1 / layer.tileMeters[1], layer.reliefMeters * (overrides.bump ?? layer.bump), overrides.arg ?? layer.arg),
  );
}
