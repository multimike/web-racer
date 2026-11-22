/**
 * In-memory side of the boot bake cache. Babylon-free; lives in
 * the main thread AND in every bake worker (one instance each).
 *
 * Steps that can be skipped when their exact input was seen before (the AO
 * bake in src/gfx/solid/ao.ts, the far / lite simplifier in
 * src/render/scatter/simplify.ts) ask `bakeStore.get(key)` with a content
 * hash of that input, and `put` what they computed. The key always contains
 * the step's own version constant (kept in the file that implements the
 * step), never an asset name: editing a model changes its geometry and so
 * its key; editing a step means bumping its version.
 *
 * Disabled (the default) it stores nothing and every lookup misses — the
 * labs and the Node tools run exactly as before. The game enables it
 * (`?nocache=1` keeps it off); `src/boot/persist.ts` fills it from IndexedDB
 * and writes the new entries back.
 */

export interface StoredEntry {
  key: string;
  /** Step id ('ao', 'simplify'); with `ver`, what old-version cleanup reads. */
  step: string;
  ver: number;
  buf: ArrayBuffer;
}

/** Versions of the steps that use the store, registered by their modules. */
export const STEP_VERSIONS: Record<string, number> = {};

export function registerStep(step: string, ver: number): void {
  STEP_VERSIONS[step] = ver;
}

/** Memory cap of one store (bytes). Beyond it new results are not kept. */
const MEMORY_CAP = 160 * 1024 * 1024;

class BakeStore {
  enabled = false;
  hits = 0;
  misses = 0;
  /** Milliseconds spent hashing inputs (the cost of asking). */
  hashMs = 0;
  private readonly map = new Map<string, ArrayBuffer>();
  private fresh: StoredEntry[] = [];
  private bytes = 0;

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  get(key: string): ArrayBuffer | undefined {
    if (!this.enabled) return undefined;
    const v = this.map.get(key);
    if (v) this.hits++;
    else this.misses++;
    return v;
  }

  /** A newly computed result: kept (if room) and queued for persistence. */
  put(key: string, step: string, buf: ArrayBuffer): void {
    if (!this.enabled || this.map.has(key)) return;
    if (this.bytes + buf.byteLength > MEMORY_CAP) return;
    this.map.set(key, buf);
    this.bytes += buf.byteLength;
    this.fresh.push({ key, step, ver: STEP_VERSIONS[step] ?? 0, buf });
  }

  /** Entries loaded from persistence (not queued again). */
  seed(entries: Iterable<{ key: string; buf: ArrayBuffer }>): void {
    for (const e of entries) {
      if (this.map.has(e.key)) continue;
      if (this.bytes + e.buf.byteLength > MEMORY_CAP) break;
      this.map.set(e.key, e.buf);
      this.bytes += e.buf.byteLength;
    }
  }

  /** Drop the stored results (memory); stays enabled, counters kept. */
  release(): void {
    this.map.clear();
    this.bytes = 0;
  }

  /** The results computed since the last call (for the persistence writer). */
  takeFresh(): StoredEntry[] {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }
}

export const bakeStore = new BakeStore();
