import { STEP_VERSIONS } from './store';
import type { StoredEntry } from './store';

/**
 * IndexedDB persistence of the boot bake cache: a second visit
 * reads the AO bakes and simplifications of the first instead of computing
 * them. Every failure (no IndexedDB, private mode, quota, a blocked open)
 * resolves quietly to "nothing cached" — the boot then simply bakes.
 *
 * Two object stores with the same keys: `bake` {key, buf} holds the data,
 * `meta` {key, step, ver, bytes, t} what housekeeping needs, so the main
 * thread can tidy up without reading megabytes of buffers: records of a
 * step whose version is no longer current are deleted, and while the total
 * is over `CACHE_CAP` the oldest records (by write time `t`) go, down to
 * three quarters of the cap.
 */

const DB_NAME = 'web-racer-boot-cache';
const DATA = 'bake';
const META = 'meta';
/** Total size cap of the persistent cache, bytes. */
export const CACHE_CAP = 96 * 1024 * 1024;
/** Give up on an open that hangs (another tab holding an upgrade). */
const OPEN_TIMEOUT_MS = 1500;

interface Meta {
  key: string;
  step: string;
  ver: number;
  bytes: number;
  t: number;
}

function hasIDB(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function open(): Promise<IDBDatabase | null> {
  if (!hasIDB()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null): void => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = (): void => {
        clearTimeout(timer);
        done(req.result);
      };
      req.onerror = (): void => {
        clearTimeout(timer);
        done(null);
      };
      req.onblocked = (): void => {
        clearTimeout(timer);
        done(null);
      };
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

function txDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = (): void => resolve(true);
    tx.onerror = (): void => resolve(false);
    tx.onabort = (): void => resolve(false);
  });
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[] | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = (): void => resolve(req.result as T[]);
      req.onerror = (): void => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Keys of the current step versions, for `loadPersisted`. */
function currentKeys(metas: readonly Meta[]): Set<string> {
  const keys = new Set<string>();
  for (const m of metas) if (m && STEP_VERSIONS[m.step] !== undefined && STEP_VERSIONS[m.step] === m.ver) keys.add(m.key);
  return keys;
}

/** Every stored result of a current step version (a bake worker's start). */
export async function loadPersisted(): Promise<{ entries: { key: string; buf: ArrayBuffer }[]; ok: boolean }> {
  const db = await open();
  if (!db) return { entries: [], ok: false };
  try {
    const metas = await getAll<Meta>(db, META);
    if (!metas) return { entries: [], ok: false };
    const keep = currentKeys(metas);
    if (keep.size === 0) return { entries: [], ok: true };
    const recs = await getAll<{ key: string; buf: ArrayBuffer }>(db, DATA);
    if (!recs) return { entries: [], ok: false };
    const entries = recs.filter((r) => r && keep.has(r.key) && r.buf instanceof ArrayBuffer);
    return { entries, ok: true };
  } finally {
    db.close();
  }
}

/**
 * Housekeeping (main thread, once per boot): delete old step versions and
 * trim to the cap. Returns what is left and what was deleted.
 */
export async function tidyPersisted(): Promise<{ entries: number; bytes: number; deleted: number; ok: boolean }> {
  const db = await open();
  if (!db) return { entries: 0, bytes: 0, deleted: 0, ok: false };
  try {
    const metas = await getAll<Meta>(db, META);
    if (!metas) return { entries: 0, bytes: 0, deleted: 0, ok: false };
    const keep: Meta[] = [];
    const drop: string[] = [];
    for (const m of metas) {
      if (!m) continue;
      const cur = STEP_VERSIONS[m.step];
      if (cur === undefined) keep.push(m); // a step this build does not know: leave it
      else if (cur !== m.ver) drop.push(m.key);
      else keep.push(m);
    }
    let total = keep.reduce((n, m) => n + m.bytes, 0);
    if (total > CACHE_CAP) {
      keep.sort((a, b) => a.t - b.t);
      while (keep.length && total > CACHE_CAP * 0.75) {
        const m = keep.shift()!;
        total -= m.bytes;
        drop.push(m.key);
      }
    }
    if (drop.length) {
      const tx = db.transaction([DATA, META], 'readwrite');
      for (const k of drop) {
        tx.objectStore(DATA).delete(k);
        tx.objectStore(META).delete(k);
      }
      if (!(await txDone(tx))) return { entries: keep.length, bytes: total, deleted: 0, ok: false };
    }
    return { entries: keep.length, bytes: total, deleted: drop.length, ok: true };
  } catch {
    return { entries: 0, bytes: 0, deleted: 0, ok: false };
  } finally {
    db.close();
  }
}

/** Write new entries (one transaction). Resolves false on any failure. */
export async function persistEntries(entries: readonly StoredEntry[]): Promise<boolean> {
  if (entries.length === 0) return true;
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction([DATA, META], 'readwrite');
    const t = Date.now();
    for (const e of entries) {
      tx.objectStore(DATA).put({ key: e.key, buf: e.buf });
      tx.objectStore(META).put({ key: e.key, step: e.step, ver: e.ver, bytes: e.buf.byteLength, t } satisfies Meta);
    }
    return await txDone(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Remove the whole cache (dev console: `__bootCache.clear()`, set up in gameBoot.ts). */
export async function clearPersisted(): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).clear();
    tx.objectStore(META).clear();
    return await txDone(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}
