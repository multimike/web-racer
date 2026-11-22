import { loadAsset } from '../assets/registry';
import { farModel } from '../render/scatter/farModel';
import { simplifyMesh } from '../render/scatter/simplify';
import { liteTarget } from '../game/car/lite';
import type { SolidVertexData } from '../gfx/solid/SolidMesh';
import type { BakeResult, CarJob, FromWorker, PropJob, ToWorker } from './bakeProtocol';
import { loadPersisted } from './persist';
import { assembleSettings, clearAssembleCache, prepareCar, prepareProp } from './prepare';
import { bakeStore } from './store';

/**
 * Bake worker: runs the CPU stage of asset assembly — builder,
 * AO bake, weld + index, far models, car lite meshes — off the main thread.
 * Exactly the modules the main thread would run (src/boot/prepare.ts,
 * farModel, simplifyMesh), on exactly the same input, so every buffer it
 * sends back is bit-identical to a bake on the main thread; only the order
 * in which different meshes are baked changes, and no bake reads another's
 * state.
 *
 * Results go back by structured clone (copies): the worker's own caches keep
 * their buffers, and a detached array can never end up in one of them.
 */

// Typed by hand: the project compiles against the DOM lib, and pulling in
// the webworker lib beside it makes the two collide.
const scope = self as unknown as { postMessage(msg: unknown): void; onmessage: ((ev: MessageEvent<ToWorker>) => void) | null };
const post = (msg: FromWorker): void => scope.postMessage(msg);
let ready: Promise<void> = Promise.resolve();

async function runProp(job: PropJob): Promise<BakeResult> {
  const asset = await loadAsset(job.assetId);
  if (asset.kind !== 'prop') throw new Error(`'${job.assetId}' is not a prop asset`);
  const prepared = prepareProp(asset, job.seed, job.scheme);
  const far = job.far.map((target) => {
    try {
      return farModel(asset, job.seed, job.scheme, target);
    } catch {
      return null; // the main thread repeats it and reports the failure
    }
  });
  return { kind: 'prop', prepared, far };
}

async function runCar(job: CarJob): Promise<BakeResult> {
  const asset = await loadAsset(job.assetId);
  if (asset.kind !== 'car') throw new Error(`'${job.assetId}' is not a car asset`);
  const prepared = prepareCar(asset, job.livery);
  const lite: (SolidVertexData | null)[] = [];
  if (job.liteRatio !== null) {
    const ratio = job.liteRatio;
    for (const p of [prepared.body, prepared.driver, ...prepared.wheels]) {
      lite.push(p ? simplifyMesh(p.data, liteTarget(p.triangles, ratio)) : null);
    }
  }
  return { kind: 'car', prepared, lite };
}

let settingsKey = '';

scope.onmessage = (ev: MessageEvent<ToWorker>): void => {
  const msg = ev.data;
  if (msg.type === 'init') {
    bakeStore.enabled = msg.cache;
    const t0 = performance.now();
    ready = (async (): Promise<void> => {
      let entries = 0;
      let bytes = 0;
      if (msg.cache) {
        const got = await loadPersisted();
        bakeStore.seed(got.entries);
        entries = bakeStore.size;
        bytes = bakeStore.byteSize;
      }
      post({ type: 'ready', cacheEntries: entries, cacheBytes: bytes, loadMs: performance.now() - t0 });
    })();
    return;
  }
  if (msg.type === 'job') {
    void ready.then(async () => {
      const t0 = performance.now();
      try {
        // The lab may change these between runs; the game never does.
        const key = JSON.stringify(msg.settings);
        if (key !== settingsKey) {
          if (settingsKey !== '') clearAssembleCache();
          Object.assign(assembleSettings, msg.settings, { keepSolids: false });
          settingsKey = key;
        }
        const h0 = bakeStore.hits, m0 = bakeStore.misses, x0 = bakeStore.hashMs;
        const result = msg.job.kind === 'prop' ? await runProp(msg.job) : await runCar(msg.job);
        // Copies of the fresh entries: the worker's store keeps its own.
        const fresh = bakeStore.takeFresh().map((e) => ({ ...e, buf: e.buf.slice(0) }));
        post({
          type: 'done',
          id: msg.id,
          result,
          fresh,
          ms: performance.now() - t0,
          stats: { hits: bakeStore.hits - h0, misses: bakeStore.misses - m0, hashMs: bakeStore.hashMs - x0 },
        });
      } catch (e) {
        post({ type: 'fail', id: msg.id, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 });
      }
    });
  }
};
