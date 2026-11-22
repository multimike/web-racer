import { adoptPreparedCar, adoptPreparedProp, assembleSettings, hasPreparedCar, prepareCar, prepareProp } from './prepare';
import type { PreparedMesh } from './prepare';
import { loadAsset } from '../assets/registry';
import { adoptLiteData, peekLiteData } from '../game/car/CarLod';
import type { SolidVertexData } from '../gfx/solid/SolidMesh';
import { adoptFarModel, farModel } from '../render/scatter/farModel';
import { simplifyMesh } from '../render/scatter/simplify';
import type { PropPrepJob } from '../render/scatter/worldProps';
import type { PropAsset } from '../assets/types';
import type { BakeJob, CarResult, PropResult } from './bakeProtocol';
import { BakePool, defaultPoolSize } from './bakePool';
import { clearPersisted, loadPersisted, persistEntries, tidyPersisted } from './persist';
import { bakeStore } from './store';
import { ContentHash } from './hash';

/**
 * The game's side of the boot bakes. What it changes is WHERE
 * and HOW OFTEN the CPU stage of the assets runs — never its result:
 *
 *  - WORKERS: every car (prepare + lite meshes) and every prop variant
 *    (prepare + far models) of the world is baked in a pool of
 *    `min(4, cores − 1)` workers, cars dispatched at the very start of the
 *    boot (they bake while the world data and the terrain are made on the
 *    main thread), props as soon as the plan is known. The results are put
 *    into the caches the main thread's `prepareProp` / `prepareCar` /
 *    `farModel` / CarLod read, so the rest of the boot is unchanged and
 *    finds everything ready. A job that fails in a worker is simply done on
 *    the main thread as before. While it waits for the props, the main
 *    thread takes the smallest queued prop jobs itself (`runLocal`; the
 *    workers get the big ones first).
 *  - CACHE: AO bakes and simplifications are stored by a content hash of
 *    their exact input (src/boot/store.ts) and persisted in IndexedDB
 *    (src/boot/persist.ts), so a second visit skips them.
 *
 * URL: `?workers=0` bakes on the main thread (the old path), `?workers=N`
 * sets the pool size; `?nocache=1` neither reads nor writes the cache,
 * `?nocache=0` forces it on. Shot pages default to `workers=0&nocache=1`.
 */

export interface BootFlags {
  workers: number;
  cache: boolean;
}

export function bootFlags(shot: boolean, search: string = typeof location !== 'undefined' ? location.search : ''): BootFlags {
  const p = new URLSearchParams(search);
  const w = p.get('workers');
  // Shot pages run on headless Chrome's VIRTUAL clock, which does not wait
  // for workers (nor for IndexedDB): the page would be captured blank. They
  // bake on the main thread without the cache — the path every other boot
  // is byte-for-byte checked against — unless the URL asks otherwise.
  let workers = shot ? 0 : defaultPoolSize();
  if (w !== null) {
    const n = Number(w);
    workers = Number.isFinite(n) ? Math.max(0, Math.min(16, Math.round(n))) : workers;
  }
  if (typeof Worker === 'undefined') workers = 0;
  const nc = p.get('nocache');
  const cache = nc === null ? !shot : !(nc === '1' || nc === 'true' || nc === '');
  return { workers, cache };
}

/** Let the browser paint (the loading bar); a hidden tab has no animation
 * frames, so a short timer stands in. */
const paintYield = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => finish());
    setTimeout(finish, 50);
  });

/** Relative job costs for the pool's longest-first order and the progress bar. */
const COST = { car: 2000, building: 400, tree: 80, dressing: 40, other: 15 };

/**
 * Prop cost the progress bar reserves while the cars bake and the prop plan
 * is not known yet (hills only), so four finished cars cannot carry the bar
 * to the end of the bake stretch and then leave it standing. About what the
 * hills worlds queue (`bake.propCost` in the boot report: seeds 1 / 6 / 16
 * queue 11,610 / 12,010 / 11,970); once the plan is known the real cost replaces it.
 */
const PROP_COST_ESTIMATE = 12000;

export interface CarBake {
  carId: string;
  livery: number;
}

export class BootBakes {
  readonly flags: BootFlags;
  readonly pool: BakePool | null;
  /** Numbers for the boot report (merged into `game.boot` as `bake.*`). */
  readonly stats: Record<string, number> = {};
  /** (fraction of the queued bake work done, jobs done, jobs queued). */
  onProgress: ((fraction: number, done: number, queued: number) => void) | null = null;

  private readonly cars = new Map<string, Promise<void>>();
  /** What was asked for, for `digests()`. */
  private readonly carList: CarBake[] = [];
  private carLite: number | null = null;
  private propJobs: PropPrepJob[] = [];
  private readonly t0 = performance.now();
  private mainCacheReady: Promise<void> = Promise.resolve();
  /** The main thread's own cache copy is loaded (or there is no cache). */
  private mainCacheLoaded: boolean;
  private tidy: Promise<unknown> = Promise.resolve();

  /** Prop cost not queued yet that the bar reserves (see PROP_COST_ESTIMATE). */
  private propReserve: number;

  /** `expectProps`: the boot will queue prop jobs later (hills). */
  constructor(flags: BootFlags, expectProps = false) {
    this.flags = flags;
    this.propReserve = expectProps ? PROP_COST_ESTIMATE : 0;
    bakeStore.enabled = flags.cache;
    this.mainCacheLoaded = !flags.cache;
    let pool: BakePool | null = null;
    if (flags.workers > 0) {
      try {
        pool = new BakePool({ size: flags.workers, cache: flags.cache, settings: () => assembleSettings });
      } catch {
        // No module workers here: bake on the main thread, as before.
        pool = null;
      }
    }
    this.pool = pool;
    if (!pool && flags.workers > 0) this.stats['bake.workerStartFailed'] = 1;
    if (this.pool) {
      this.pool.onJobDone = (done, queued, costDone, costQueued): void => {
        const total = costQueued + this.propReserve;
        this.onProgress?.(total > 0 ? costDone / total : 1, done, queued);
      };
    }
    if (flags.cache) {
      this.tidy = tidyPersisted().then((r) => {
        this.stats['bake.cacheStoredEntries'] = r.entries;
        this.stats['bake.cacheStoredBytes'] = r.bytes;
        this.stats['bake.cacheDeleted'] = r.deleted;
      });
      // The main thread bakes too (all of it without workers, the small
      // prop jobs with them — see propsPrefetch): it needs the cache itself.
      const t = performance.now();
      this.mainCacheReady = loadPersisted().then((r) => {
        bakeStore.seed(r.entries);
        this.mainCacheLoaded = true;
        this.stats['bake.mainCacheLoadMs'] = performance.now() - t;
      });
    }
    this.stats['bake.workers'] = this.pool?.size ?? 0;
    this.stats['bake.cache'] = flags.cache ? 1 : 0;
  }

  /** Resolves when the main thread may bake (its cache is loaded). With
   * workers nothing waits for it: the main thread only helps once it is. */
  ready(): Promise<void> {
    return this.pool ? Promise.resolve() : this.mainCacheReady;
  }

  /**
   * Start baking these cars (prepare + lite meshes at `liteRatio`; null =
   * no lite meshes). Returns at once; `car(carId, livery)` waits for one.
   */
  prefetchCars(list: readonly CarBake[], liteRatio: number | null): void {
    for (const c of list) if (!this.carList.some((x) => x.carId === c.carId && x.livery === c.livery)) this.carList.push(c);
    this.carLite = liteRatio;
    const pool = this.pool;
    if (!pool) return;
    for (const c of list) {
      const k = `${c.carId}|${c.livery}`;
      if (this.cars.has(k)) continue;
      const job = pool.run({ kind: 'car', assetId: c.carId, livery: c.livery, liteRatio }, COST.car).then(
        async (r) => {
          const asset = await loadAsset(c.carId);
          if (asset.kind !== 'car' || r.kind !== 'car') return;
          const res = r as CarResult;
          if (!hasPreparedCar(asset, c.livery)) adoptPreparedCar(asset, c.livery, res.prepared);
          if (liteRatio === null) return;
          // The lite data belongs to the prepared meshes the cache now holds.
          const p = prepareCar(asset, c.livery);
          const parts = [p.body, p.driver, ...p.wheels];
          parts.forEach((m, i) => {
            const d = res.lite[i];
            if (m && d && m === (i === 0 ? res.prepared.body : i === 1 ? res.prepared.driver : res.prepared.wheels[i - 2])) adoptLiteData(m, simplifyMesh, liteRatio, d);
          });
        },
        () => {
          this.stats['bake.failedCars'] = (this.stats['bake.failedCars'] ?? 0) + 1;
        },
      );
      this.cars.set(k, job);
    }
  }

  /** Wait until the worker bake of this car (if any) is in the caches. */
  async car(carId: string, livery: number): Promise<void> {
    const t = performance.now();
    await this.cars.get(`${carId}|${livery}`);
    this.stats['bake.carWaitMs'] = (this.stats['bake.carWaitMs'] ?? 0) + performance.now() - t;
  }

  /** `WorldPropsBootOptions.prefetch`: bake every prop variant in the pool. */
  readonly propsPrefetch = async (jobs: PropPrepJob[]): Promise<void> => {
    const pool = this.pool;
    this.propJobs = jobs;
    this.stats['bake.propJobs'] = jobs.length;
    this.propReserve = 0;
    if (!pool) return;
    const t = performance.now();
    const byId = new Map(jobs.map((j) => [j.asset.id, j.asset]));
    let propCost = 0;
    const all = Promise.all(
      jobs.map((j) => {
        const cost = j.cls === 'building' ? COST.building : j.cls === 'tree' ? COST.tree : j.cls === 'dressing' ? COST.dressing : COST.other;
        propCost += cost;
        return pool.run({ kind: 'prop', assetId: j.asset.id, seed: j.seed, scheme: j.scheme, far: j.far }, cost).then(
          (r) => {
            if (r.kind !== 'prop') return; // 'local': already in this thread's caches
            const res = r as PropResult;
            adoptPreparedProp(j.asset, j.seed, j.scheme, res.prepared);
            j.far.forEach((target, i) => {
              const f = res.far[i];
              if (f) adoptFarModel(j.asset, j.seed, j.scheme, target, f);
            });
          },
          () => {
            this.stats['bake.failedProps'] = (this.stats['bake.failedProps'] ?? 0) + 1;
          },
        );
      }),
    );
    this.stats['bake.propCost'] = propCost;
    let settled = false;
    void all.then(() => {
      settled = true;
    });
    // The main thread has nothing else to do until the props are baked:
    // it takes the SMALL jobs itself (the pool hands the workers the big
    // ones first), in slices of ~40 ms with a paint in between so the
    // loading bar keeps moving. Same code, same caches, same bytes. A pool
    // of one or two workers (a 2- or 3-core machine) cannot finish the big
    // jobs much before the main thread runs out of small ones: there the
    // main thread takes any prop job (still the cheapest first, so the two
    // ends meet in the middle), at the price of longer slices.
    const accept = pool.size <= 2 ? (job: BakeJob): boolean => job.kind === 'prop' : (job: BakeJob, cost: number): boolean => job.kind === 'prop' && cost <= COST.tree;
    while (!settled) {
      if (!this.mainCacheLoaded) {
        await Promise.race([all, this.mainCacheReady]);
        continue;
      }
      const slice = performance.now();
      let ran = false;
      while (performance.now() - slice < 40 && pool.runLocal(accept, (job) => this.runPropHere(job, byId))) ran = true;
      if (!ran) break;
      await paintYield();
    }
    await all;
    this.stats['bake.propWaitMs'] = performance.now() - t;
  };

  /** A prop job on this thread: prepare + far models into the caches. */
  private runPropHere(job: BakeJob, byId: ReadonlyMap<string, PropAsset>): void {
    const asset = byId.get(job.assetId);
    if (job.kind !== 'prop' || !asset) throw new Error('not a prop job');
    prepareProp(asset, job.seed, job.scheme);
    for (const target of job.far) {
      try {
        farModel(asset, job.seed, job.scheme, target);
      } catch {
        // Not cached: the props build asks again and reports it.
      }
    }
  }

  /** A boot that failed: stop the workers and drop the main thread's cache
   * copy (nothing is persisted). */
  abort(): void {
    this.pool?.dispose();
    bakeStore.release();
  }

  /**
   * After the first frame: stop the workers and write what was computed to
   * the persistent cache (in the background; the game does not wait).
   */
  finish(): Promise<void> {
    const pool = this.pool;
    if (pool) {
      const s = pool.stats;
      this.stats['bake.jobs'] = s.jobs;
      this.stats['bake.failed'] = s.failed;
      this.stats['bake.lost'] = s.lost;
      this.stats['bake.workMs'] = s.workMs;
      this.stats['bake.spanMs'] = s.spanMs;
      this.stats['bake.cacheHits'] = s.cacheHits;
      this.stats['bake.cacheMisses'] = s.cacheMisses;
      this.stats['bake.hashMs'] = s.hashMs;
      this.stats['bake.cacheEntries'] = s.cacheEntries;
      this.stats['bake.cacheBytes'] = s.cacheBytes;
      this.stats['bake.cacheLoadMs'] = s.cacheLoadMs;
      this.stats['bake.localJobs'] = s.localJobs;
      this.stats['bake.localMs'] = s.localMs;
      pool.dispose();
    }
    this.stats['bake.mainCacheHits'] = bakeStore.hits;
    this.stats['bake.mainCacheMisses'] = bakeStore.misses;
    this.stats['bake.mainHashMs'] = bakeStore.hashMs;
    this.stats['bake.sinceStartMs'] = performance.now() - this.t0;
    if (!this.flags.cache) {
      bakeStore.release();
      return Promise.resolve();
    }
    const fresh = [...(pool?.fresh ?? []), ...bakeStore.takeFresh()];
    if (pool) pool.fresh.length = 0;
    let bytes = 0;
    for (const e of fresh) bytes += e.buf.byteLength;
    this.stats['bake.freshEntries'] = fresh.length;
    this.stats['bake.freshBytes'] = bytes;
    return this.tidy.then(() => persistEntries(fresh)).then((ok) => {
      this.stats['bake.persisted'] = ok ? 1 : 0;
      // Nothing bakes after the boot: the main thread's copies can go.
      bakeStore.release();
    });
  }

  /**
   * Content hash of every buffer the boot prepared — per car, per prop
   * variant, and all together — read back from the main thread's caches
   * (after the boot they hold exactly what the scene was built from). Two
   * boot paths (workers / main thread, cache / none) produced the same bytes
   * iff these are equal. Report pages print them with `?bakehash=1`.
   */
  async digests(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const all = new ContentHash();
    const mesh = (h: ContentHash, d: SolidVertexData | undefined | null): void => {
      if (!d) {
        h.str('-');
        return;
      }
      h.f32(d.positions).f32(d.normals).f32(d.colors).f32(d.uvs).f32(d.uvs2).i32(d.indices);
    };
    const prepared = (h: ContentHash, p: PreparedMesh | null): void => {
      if (!p) return void h.str('-');
      mesh(h, p.data);
      h.f64(p.min).f64(p.max).num(p.triangles).num(p.authoredTriangles).str(p.ao);
    };
    for (const c of this.carList) {
      const asset = await loadAsset(c.carId);
      if (asset.kind !== 'car') continue;
      const p = prepareCar(asset, c.livery);
      const h = new ContentHash();
      for (const m of [p.body, p.driver, ...p.wheels, ...p.hubs, ...p.links, ...p.spinners, p.steeringWheel]) prepared(h, m);
      if (this.carLite !== null) for (const m of [p.body, p.driver, ...p.wheels]) mesh(h, m ? peekLiteData(m, simplifyMesh, this.carLite) : null);
      const d = h.digest();
      out[`car:${c.carId}|${c.livery}`] = d;
      all.str(d);
    }
    for (const j of this.propJobs) {
      const h = new ContentHash();
      prepared(h, prepareProp(j.asset, j.seed, j.scheme).mesh);
      for (const target of j.far) {
        try {
          const f = farModel(j.asset, j.seed, j.scheme, target);
          mesh(h, f.data);
          h.str(f.method).num(f.silhouette).num(f.boundsError).num(f.stretch);
        } catch {
          h.str('far failed');
        }
      }
      const d = h.digest();
      out[`prop:${j.asset.id}|${j.seed}|${j.scheme ?? ''}`] = d;
      all.str(d);
    }
    out.all = all.digest();
    return out;
  }

  /** Forget everything persisted (dev console: `__bootCache.clear()`). */
  static clear(): Promise<boolean> {
    return clearPersisted();
  }
}

// Dev builds: the console is the only place short of DevTools' storage panel
// where a developer can drop a stale cache.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __bootCache: { clear: () => Promise<boolean> } }).__bootCache = { clear: () => BootBakes.clear() };
}
