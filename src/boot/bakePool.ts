import type { AssembleSettings } from './prepare';
import type { BakeJob, BakeResult, FromWorker, ToWorker } from './bakeProtocol';
import type { StoredEntry } from './store';

/**
 * Pool of bake workers for the game's boot.
 *
 * `run(job, cost)` queues a job; an idle worker always takes the job with the
 * highest estimated cost first (longest-first keeps the last worker from
 * finishing long after the others). Each worker holds one job at a time.
 * A job that fails in a worker rejects; the caller then simply does the work
 * on the main thread as before (and gets the real error there).
 *
 * Size: `min(4, hardwareConcurrency − 1)`, at least 1. Workers load the
 * persistent bake cache themselves on `init`, so they start baking with it.
 *
 * A worker that fails to load, sends a message that cannot be read, or holds
 * one job longer than `JOB_TIMEOUT_MS` is retired (its job rejects and is
 * redone on the main thread); with no worker left every queued job rejects
 * the same way. Each retirement logs one `console.warn` and counts in
 * `stats.lost`, so a broken worker path is visible in the boot report.
 */

/** A job a worker holds longer than this is taken back (the worker was killed
 * or hangs). Far above any real job: a whole car on this Mac takes ~2 s. */
const JOB_TIMEOUT_MS = 60000;

interface Pending {
  id: number;
  job: BakeJob;
  cost: number;
  resolve: (r: BakeResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  /** Watchdog of the job it holds. */
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BakePoolStats {
  workers: number;
  jobs: number;
  /** Jobs that did not come back with a result (redone on the main thread). */
  failed: number;
  /** Workers retired because they failed to load, sent an unreadable
   * message or hung on a job. */
  lost: number;
  /** Sum of the jobs' own run times inside the workers, ms. */
  workMs: number;
  /** First job queued → last job done, ms. */
  spanMs: number;
  cacheHits: number;
  cacheMisses: number;
  hashMs: number;
  /** Cache entries / bytes worker 0 loaded, and its load time. */
  cacheEntries: number;
  cacheBytes: number;
  cacheLoadMs: number;
  /** Jobs the main thread ran itself (`runLocal`) and their time, ms. */
  localJobs: number;
  localMs: number;
}

export function defaultPoolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

export class BakePool {
  readonly size: number;
  readonly stats: BakePoolStats;
  /** Results computed in the workers that the persistent cache does not hold yet. */
  readonly fresh: StoredEntry[] = [];
  /** Called after every finished job: (jobs done, jobs queued so far, cost done, cost queued). */
  onJobDone: ((done: number, queued: number, costDone: number, costQueued: number) => void) | null = null;

  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private done = 0;
  private queued = 0;
  private costDone = 0;
  private costQueued = 0;
  private t0 = 0;
  private disposed = false;
  private readonly settings: () => AssembleSettings;

  constructor(options: { size?: number; cache: boolean; settings: () => AssembleSettings }) {
    this.size = options.size ?? defaultPoolSize();
    this.settings = options.settings;
    this.stats = { workers: this.size, jobs: 0, failed: 0, lost: 0, workMs: 0, spanMs: 0, cacheHits: 0, cacheMisses: 0, hashMs: 0, cacheEntries: 0, cacheBytes: 0, cacheLoadMs: 0, localJobs: 0, localMs: 0 };
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: null, timer: null };
      worker.onmessage = (ev: MessageEvent<FromWorker>): void => this.receive(slot, i, ev.data);
      worker.onerror = (ev: ErrorEvent): void => {
        // A worker that cannot even load (or threw outside a job).
        ev.preventDefault();
        this.retire(slot, ev.message || 'bake worker failed to load');
      };
      worker.onmessageerror = (): void => this.retire(slot, 'a bake worker message could not be read');
      worker.postMessage({ type: 'init', cache: options.cache } satisfies ToWorker);
      this.slots.push(slot);
    }
  }

  run(job: BakeJob, cost: number): Promise<BakeResult> {
    if (this.queued === 0) this.t0 = performance.now();
    this.queued++;
    this.costQueued += cost;
    return new Promise<BakeResult>((resolve, reject) => {
      if (this.disposed || this.slots.length === 0) {
        // Counted like any other job that did not come back.
        this.finish({ id: this.nextId++, job, cost, resolve, reject }, null, this.disposed ? 'bake pool closed' : 'no bake worker left');
        return;
      }
      this.queue.push({ id: this.nextId++, job, cost, resolve, reject });
      this.pump();
    });
  }

  /**
   * Let the caller (the main thread, idle while it waits for the pool) run
   * the CHEAPEST queued job that `accept(job, cost)` allows itself: `fn(job)`
   * must do the work synchronously (into the caches the results would be
   * adopted into); the job's promise then resolves with `{ kind: 'local' }`.
   * Returns false when no such job is queued.
   */
  runLocal(accept: (job: BakeJob, cost: number) => boolean, fn: (job: BakeJob) => void): boolean {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const c = this.queue[i].cost;
      if ((best < 0 || c < this.queue[best].cost) && accept(this.queue[i].job, c)) best = i;
    }
    if (best < 0) return false;
    const p = this.queue.splice(best, 1)[0];
    const t = performance.now();
    let error = '';
    try {
      fn(p.job);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ms = performance.now() - t;
    this.stats.localJobs++;
    this.stats.localMs += ms;
    this.finish(p, error ? null : { kind: 'local' }, error);
    return true;
  }

  /** Terminate the workers (after the boot; jobs still queued reject). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.slots) {
      s.worker.terminate();
      if (s.timer !== null) clearTimeout(s.timer);
      if (s.busy) s.busy.reject(new Error('bake pool closed'));
    }
    for (const q of this.queue.splice(0)) q.reject(new Error('bake pool closed'));
    this.slots.length = 0;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy || this.queue.length === 0) continue;
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].cost > this.queue[best].cost) best = i;
      const p = this.queue.splice(best, 1)[0];
      slot.busy = p;
      slot.timer = setTimeout(() => this.retire(slot, `a bake worker held '${p.job.assetId}' for over ${JOB_TIMEOUT_MS / 1000} s`), JOB_TIMEOUT_MS);
      slot.worker.postMessage({ type: 'job', id: p.id, job: p.job, settings: { ...this.settings() } } satisfies ToWorker);
    }
  }

  private receive(slot: Slot, index: number, msg: FromWorker): void {
    if (msg.type === 'ready') {
      if (index === 0) {
        this.stats.cacheEntries = msg.cacheEntries;
        this.stats.cacheBytes = msg.cacheBytes;
        this.stats.cacheLoadMs = msg.loadMs;
      }
      return;
    }
    const p = slot.busy;
    if (!p || p.id !== msg.id) return;
    slot.busy = null;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    this.stats.workMs += msg.ms;
    if (msg.type === 'done') {
      this.stats.cacheHits += msg.stats.hits;
      this.stats.cacheMisses += msg.stats.misses;
      this.stats.hashMs += msg.stats.hashMs;
      for (const e of msg.fresh) this.fresh.push(e);
      this.finish(p, msg.result, '');
    } else {
      this.finish(p, null, msg.error);
    }
    this.pump();
  }

  /** Take a worker out of the pool: its job and, with no worker left, every
   * queued job reject (their callers redo them on the main thread). */
  private retire(slot: Slot, reason: string): void {
    const at = this.slots.indexOf(slot);
    if (at < 0 || this.disposed) return;
    this.slots.splice(at, 1);
    slot.worker.terminate();
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    this.stats.lost++;
    console.warn(`[boot] bake worker retired (${reason}); ${this.slots.length} of ${this.size} left — ${this.slots.length ? 'its job is' : 'all remaining jobs are'} baked on the main thread`);
    const p = slot.busy;
    slot.busy = null;
    if (p) this.finish(p, null, reason);
    if (this.slots.length === 0) for (const q of this.queue.splice(0)) this.finish(q, null, 'no bake worker left');
    else this.pump();
  }

  private finish(p: Pending, result: BakeResult | null, error: string): void {
    this.done++;
    this.costDone += p.cost;
    this.stats.jobs = this.done;
    this.stats.spanMs = performance.now() - this.t0;
    if (result) p.resolve(result);
    else {
      this.stats.failed++;
      p.reject(new Error(error));
    }
    this.onJobDone?.(this.done, this.queued, this.costDone, this.costQueued);
  }
}
