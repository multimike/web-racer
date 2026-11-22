import type { MenuTrackInfo, MenuTrackSource } from '../../game/contracts/menu';

/**
 * Track previews for the menu (spec 8, "Track preview"; contract
 * `MenuTrackSource`): the title's NEXT RACE plate and the setup ticket draw
 * the outline and length of the shown seed.
 *
 * - The RUNNING seed's preview comes free from the world the page built
 *   (`trackInfoOf(seed, game.data.track)`).
 * - Any other seed needs `generateTerrain(seed).track` (~0.2 s): requested
 *   300 ms after the last ask for a new seed (holding ◂ ▸ on TRACK asks for
 *   every seed it passes), computed in a module worker of its own
 *   (trackWorker.ts) — or on the main thread in a timer when the worker
 *   cannot start — and cached per seed. Until it arrives `get` returns null
 *   (the view draws a dashed ring and no length chip).
 *
 * Babylon-free (`trackInfoOf` is also used by Node tools and the menu lab).
 */

/** Outline point step (every 4th polyline point, ~4 m). */
const STEP = 4;
/** Delay after the last ask for a new seed before it is computed, ms. */
const DEBOUNCE_MS = 300;

/** Plain track data: a closed polyline `[x0, z0, x1, z1, …]`. */
export interface TrackPolyline {
  points: ArrayLike<number>;
  count: number;
}

const r1 = (v: number): string => {
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** `MenuTrackInfo` of a generated track: length = the closed polyline's
 * length (m, rounded), outline = every 4th point, x → right, svg y = −z
 * (start line at the origin heading up), closed with 'Z'. */
export function trackInfoOf(seed: number, track: TrackPolyline): MenuTrackInfo {
  const p = track.points;
  const n = track.count;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    length += Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]);
  }
  let d = '';
  for (let i = 0; i < n; i += STEP) d += `${i === 0 ? 'M' : 'L'}${r1(p[2 * i])} ${r1(-p[2 * i + 1])}`;
  return { seed, lengthM: Math.round(length), outline: `${d}Z` };
}

export interface TrackPreviews extends MenuTrackSource {
  dispose(): void;
}

/** Worker answer. */
interface TrackReply {
  seed: number;
  info: MenuTrackInfo | null;
  error?: string;
}

/**
 * `running`: the page's own track (always known). `worker: false` computes
 * on the main thread (a timer task; generateTerrain is imported dynamically,
 * so the worker path does not pull it into the page bundle a second time).
 */
export function createTrackPreviews(running: MenuTrackInfo | null, opts: { worker?: boolean } = {}): TrackPreviews {
  const cache = new Map<number, MenuTrackInfo>();
  if (running) cache.set(running.seed, running);
  const pending = new Set<number>();
  let wanted: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let worker: Worker | null = null;
  let workerFailed = opts.worker === false;
  let disposed = false;

  const store = (r: TrackReply): void => {
    pending.delete(r.seed);
    if (r.info && !disposed) cache.set(r.seed, r.info);
  };
  const computeHere = (seed: number): void => {
    // A timer task: the menu frame that asked has been drawn by then.
    setTimeout(() => {
      if (disposed) return;
      void import('../../terrain/generateTerrain')
        .then(({ generateTerrain }) => store({ seed, info: trackInfoOf(seed, generateTerrain(seed).track) }))
        .catch(() => pending.delete(seed));
    }, 0);
  };
  const startWorker = (): Worker | null => {
    if (worker || workerFailed) return worker;
    try {
      worker = new Worker(new URL('./trackWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<TrackReply>): void => store(ev.data);
      worker.onerror = (): void => {
        // Could not start (or crashed): everything still asked goes local.
        workerFailed = true;
        worker?.terminate();
        worker = null;
        for (const s of pending) computeHere(s);
      };
    } catch {
      workerFailed = true;
      worker = null;
    }
    return worker;
  };
  const request = (seed: number): void => {
    if (cache.has(seed) || pending.has(seed)) return;
    pending.add(seed);
    const w = startWorker();
    if (w) w.postMessage({ seed });
    else computeHere(seed);
  };

  return {
    get(seed: number): MenuTrackInfo | null {
      const hit = cache.get(seed);
      if (hit) return hit;
      if (disposed || pending.has(seed)) return null;
      if (wanted !== seed) {
        wanted = seed;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (wanted !== null) request(wanted);
        }, DEBOUNCE_MS);
      }
      return null;
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      worker = null;
    },
  };
}
