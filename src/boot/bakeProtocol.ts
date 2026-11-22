import type { SolidVertexData } from '../gfx/solid/SolidMesh';
import type { AssembleSettings, PreparedCar, PreparedProp } from './prepare';
import type { FarModel } from '../render/scatter/farModel';
import type { StoredEntry } from './store';

/** Messages between the bake pool (main thread) and a bake worker. */

/** One prop variant: prepare it and make its far models at these targets. */
export interface PropJob {
  kind: 'prop';
  assetId: string;
  seed: number;
  scheme: string | undefined;
  far: number[];
}

/** One car livery: prepare it and simplify its lite meshes at this ratio
 * (body, driver, the four wheels — what CarLod builds). */
export interface CarJob {
  kind: 'car';
  assetId: string;
  livery: number;
  liteRatio: number | null;
}

export type BakeJob = PropJob | CarJob;

export interface PropResult {
  kind: 'prop';
  prepared: PreparedProp;
  /** Parallel to the job's `far`; null where the far model threw. */
  far: (FarModel | null)[];
}

export interface CarResult {
  kind: 'car';
  prepared: PreparedCar;
  /** [body, driver (null without one), wheel FL, FR, RL, RR]; null where not made. */
  lite: (SolidVertexData | null)[];
}

/** A job the main thread ran itself (BakePool.runLocal): its results are
 * already in the main thread's caches. */
export interface LocalResult {
  kind: 'local';
}

export type BakeResult = PropResult | CarResult | LocalResult;

export type ToWorker =
  | { type: 'init'; cache: boolean }
  | { type: 'job'; id: number; job: BakeJob; settings: AssembleSettings };

export interface WorkerStats {
  hits: number;
  misses: number;
  hashMs: number;
}

export type FromWorker =
  | { type: 'ready'; cacheEntries: number; cacheBytes: number; loadMs: number }
  | { type: 'done'; id: number; result: BakeResult; fresh: StoredEntry[]; ms: number; stats: WorkerStats }
  | { type: 'fail'; id: number; error: string; ms: number };
