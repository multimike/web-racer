import type { ShadowQuality, ShadowTaps } from '../../gfx/look/lighting';

/**
 * CONTRACT — one object that carries every performance knob of the game, so
 * the three render packages agree on names. The preset VALUES live in
 * src/game/quality.ts; each `create…` function also works with
 * no quality given (its own defaults equal the 'high' preset).
 *
 * Types only.
 */
export type QualityName = 'high' | 'quest';

/** Scatter classes that can be thinned or limited independently. */
export type PropClass = 'tree' | 'bush' | 'lowPlant' | 'largeRock' | 'smallRock' | 'dressing' | 'building';

export interface QualitySettings {
  name: QualityName;

  // --- look
  shadowQuality: ShadowQuality;
  shadowTaps: ShadowTaps;
  /** Canvas pixels per CSS pixel divisor for `engine.setHardwareScalingLevel`. */
  hardwareScaling: number;

  // --- terrain surface
  /** Side of the generated ground textures, px (512 on both presets). */
  groundTextureSize: number;
  /** The terrain is drawn as chunks × chunks meshes so the frustum culls it. */
  terrainChunks: number;

  // --- world props
  /** Radius around the view focus inside which props are drawn from their
   * full meshes (thin instances); beyond it they come from the far tier. */
  nearRadius: number;
  /** Same for buildings (large, few: a bigger radius). */
  buildingRadius: number;
  /** Seeded variants drawn per asset id in the NEAR tier, by class (plan
   * seeds are folded with `seed % limit`). */
  variantLimit: Record<PropClass, number>;
  /** Triangle target of ONE far-tier mesh, by class. */
  farTriangles: Record<PropClass, number>;
  /** Share 0..1 of collider-less scatter (bushes, low plants, small rocks)
   * that is drawn at all; chosen per placement by a hash of its index, so it
   * is the same subset every run. Things with colliders are always drawn. */
  scatterDensity: number;
  /** Classes whose NEAR tier casts sun shadows. */
  shadowCasters: readonly PropClass[];

  // --- cars
  /** Camera distance below which a car is at LOD 0 / LOD 1; beyond the
   * second it is LOD 2. Meters. */
  carLodDistances: [number, number];
  /** Share of a car part's triangles kept by its LOD 2 mesh. */
  carLiteRatio: number;
  /** Rivals kick up dust in the CHASE view (one particle system per car).
   * In the high and xr views the game gives rivals a plume on every preset
   * (it is what tells the pack apart from above; the diorama is the view
   * Quest ships); false only mutes it in chase, where the plume of every
   * car ahead veils the road. */
  rivalDust: boolean;
}
