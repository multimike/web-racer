import type { CreateGroundQuery, GroundQuery, Vec3Like, WorldData } from '../game/contracts/world';
import { samplePaved, sampleSplat } from './generateTerrain';

/**
 * What gameplay asks the hills ground (contract `GroundQuery`). Every member
 * is a closure over `data` — callers hand single methods around unbound
 * (`{ heightAt: ground.heightAt }`) — and none allocates.
 */
export const createGroundQuery: CreateGroundQuery = (data: WorldData): GroundQuery => {
  const hf = data.heightfield;
  const e = hf.step;

  const heightAt = (x: number, z: number): number => hf.getHeight(x, z);

  // Central differences one sample apart, as Heightfield.getNormal does —
  // which allocates its result, so it is not used here.
  const normalAt = (x: number, z: number, out: Vec3Like): Vec3Like => {
    const dhdx = (hf.getHeight(x + e, z) - hf.getHeight(x - e, z)) / (2 * e);
    const dhdz = (hf.getHeight(x, z + e) - hf.getHeight(x, z - e)) / (2 * e);
    const len = Math.hypot(dhdx, 1, dhdz);
    out.x = -dhdx / len;
    out.y = 1 / len;
    out.z = -dhdz / len;
    return out;
  };

  const surfaceAt = (x: number, z: number, out: Float32Array): void => sampleSplat(data, x, z, out);
  const pavedAt = (x: number, z: number): number => samplePaved(data, x, z);

  return { heightAt, normalAt, surfaceAt, pavedAt, halfExtent: hf.size / 2 };
};
