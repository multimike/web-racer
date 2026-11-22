/**
 * Triangle target of a car's LITE mesh (LOD 2) for one prepared part.
 * Renderer-free on purpose: CarLod and the boot's bake workers
 * (src/boot/bakeWorker.ts) must agree on it to the triangle, or the lite
 * meshes a worker simplified in advance would not be found.
 */
export function liteTarget(triangles: number, ratio: number): number {
  return Math.max(12, Math.round(triangles * ratio));
}
