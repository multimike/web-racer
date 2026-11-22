import { prepareProp } from '../../boot/prepare';
import type { PropAsset } from '../../assets/types';
import { bakeAO } from '../../gfx/solid/ao';
import type { SolidMesh, SolidVertexData } from '../../gfx/solid/SolidMesh';
import { measureFar, simplifyWithInfo } from './simplify';
import type { SimplifyResult } from './simplify';

/**
 * The far-tier model of one (asset, variant, scheme) at a triangle target:
 * the asset's DESIGNED far model when it has one (`PropAsset.buildFar` — the
 * diorama view draws only the far tier, so the trees and plants people look
 * at there are drawn, not simplified), else the generic simplifier
 * (`simplifyWithInfo`) on the prepared near mesh.
 *
 * A designed model is
 *  - fitted per axis onto the near model's box (x / z: min and max; y: the
 *    height above ground, the skirt keeps its depth — the same map `fitSize`
 *    uses), so it has the near model's size whatever the shortcuts of its
 *    shapes, and `stretch` reports how far that had to go (≈ 1 for a far
 *    model built in the near model's frame and fit);
 *  - baked for AO here (8 rays with the ground: foot and undersides darken
 *    like the near model's, at a fraction of a millisecond);
 *  - measured with the simplifier's own silhouette and bounds numbers.
 * If the builder throws, returns nothing usable or more than 1.15 × the
 * target, the simplifier steps in and a warning says why.
 *
 * Cached per asset object: the game asks once per (variant, scheme, target),
 * the props lab asks again for its checks and gets the same object.
 */

export interface FarModel extends SimplifyResult {
  /** Largest per-axis stretch applied to fit a designed model onto the near
   * model's box (1 = none; simplifier results: 1). */
  stretch: number;
}

const cache = new WeakMap<PropAsset, Map<string, FarModel>>();

const farKey = (asset: PropAsset, variant: number, scheme: string | undefined, target: number, simplify: boolean | undefined): string =>
  `${variant}|${scheme ?? asset.schemes?.[0] ?? ''}|${target}|${simplify ? 's' : 'd'}`;

/** Put a far model made elsewhere (a bake worker of the game's boot: the
 * same code on the same input) into the cache `farModel` reads. */
export function adoptFarModel(asset: PropAsset, variant: number, scheme: string | undefined, target: number, model: FarModel): void {
  let map = cache.get(asset);
  if (!map) cache.set(asset, (map = new Map()));
  const key = farKey(asset, variant, scheme, target, false);
  if (!map.has(key)) map.set(key, model);
}

/** `simplify: true` forces the generic simplifier (lab A/B). */
export function farModel(asset: PropAsset, variant: number, scheme: string | undefined, target: number, options: { simplify?: boolean } = {}): FarModel {
  const pick = scheme ?? asset.schemes?.[0];
  const key = farKey(asset, variant, scheme, target, options.simplify);
  let map = cache.get(asset);
  if (!map) cache.set(asset, (map = new Map()));
  const hit = map.get(key);
  if (hit) return hit;
  const source = prepareProp(asset, variant, pick).mesh;
  let out: FarModel | null = null;
  if (asset.buildFar && !options.simplify) {
    try {
      out = designed(asset, variant, pick, target, source.data, source.min, source.max);
    } catch (e) {
      console.warn(`[props] buildFar('${asset.id}', ${variant}) threw — simplifier used: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!out) out = { ...simplifyWithInfo(source.data, target), stretch: 1 };
  map.set(key, out);
  return out;
}

function designed(asset: PropAsset, variant: number, scheme: string | undefined, target: number, src: SolidVertexData, min: readonly number[], max: readonly number[]): FarModel | null {
  const m = asset.buildFar!(variant, scheme, target);
  if (m.triangleCount === 0) {
    console.warn(`[props] buildFar('${asset.id}', ${variant}) returned no triangles — simplifier used`);
    return null;
  }
  const stretch = fitOnto(m, min, max);
  bakeAO(m, { rays: 8, ground: true });
  const data = m.toVertexData();
  const limit = Math.floor(1.15 * Math.max(4, Math.floor(target)));
  const q = measureFar(src, data, limit);
  if (!q.valid) {
    console.warn(`[props] buildFar('${asset.id}', ${variant}) gave ${data.triangleCount} triangles for a target of ${target} (limit ${limit}) — simplifier used`);
    return null;
  }
  return {
    data,
    method: 'designed',
    clusterSilhouette: NaN,
    silhouette: q.silhouette,
    iou: q.iou,
    boundsError: q.boundsError,
    detail: 0,
    colourErrors: [NaN, NaN],
    stretch,
  };
}

/** Map `m` onto the box [min, max]: x and z affinely; y in two pieces that
 * both keep the ground (y = 0) where it is — what is above it scaled to the
 * top, the skirt below scaled to the near model's skirt depth.
 * Returns the largest stretch factor (≥ 1, either direction) of x, z and
 * the height above ground. */
function fitOnto(m: SolidMesh, min: readonly number[], max: readonly number[]): number {
  const b = m.bounds();
  const sx = (max[0] - min[0]) / Math.max(1e-6, b.max.x - b.min.x);
  const sz = (max[2] - min[2]) / Math.max(1e-6, b.max.z - b.min.z);
  const sy = max[1] / Math.max(1e-6, b.max.y);
  const sk = b.min.y < -1e-6 && min[1] < 0 ? min[1] / b.min.y : 1;
  m.displace((p) => [min[0] + (p.x - b.min.x) * sx, p.y > 0 ? p.y * sy : p.y * sk, min[2] + (p.z - b.min.z) * sz]);
  return Math.max(...[sx, sy, sz].map((s) => (s >= 1 ? s : 1 / s)));
}
