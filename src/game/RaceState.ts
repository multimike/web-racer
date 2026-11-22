/**
 * Race logic behind the HUD: track progress, laps, timing, positions, phases,
 * wrong-way and stuck detection, respawn poses.
 *
 * Deliberately free of Babylon AND of the DOM: it is fed plain numbers once
 * per frame and produces a plain `HudSnapshot`. The DOM overlay (`ui/Hud.ts`)
 * only paints that snapshot; a world-space panel in WebXR (where DOM overlays
 * do not exist) can paint the very same object. Everything is deterministic —
 * no clocks, no randomness — so the same inputs give the same race on every
 * peer.
 *
 * Coordinates follow the game: +y up, track in the xz-plane, heading yaw =
 * atan2(forward.x, forward.z) (yaw 0 looks down +z, positive turns right).
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** What the race needs from a track — structurally satisfied by
 * `terrain/track.ts` `Track`, and trivially built by hand in tests. */
export interface RaceTrackSource {
  /** Closed polyline, [x0,z0, x1,z1, ...]; the last point connects to the first.
   * Point 0 is the start/finish line, travel direction = increasing index. */
  points: ArrayLike<number>;
  count: number;
  /** Drivable half-width, m. */
  halfWidth: number;
  /** Extra width beyond the road edge that still counts as "on the course". */
  shoulder?: number;
  /** Road surface height per point (world y). Missing = flat at y 0. */
  roadHeights?: ArrayLike<number>;
}

/** Result of projecting a point onto the track centreline. */
export interface TrackHit {
  segment: number;
  /** 0..1 along the segment. */
  t: number;
  /** Arc length from the start line, 0..length. */
  s: number;
  /** Closest centreline point. */
  x: number;
  z: number;
  /** Unit tangent of the segment (travel direction). */
  tx: number;
  tz: number;
  /** Signed offset from the centreline, m: positive = right of travel. */
  lateral: number;
  /** Distance to the centreline, m (≥ |lateral| past a segment end). */
  distance: number;
}

/** Centreline sample at an arc length. */
export interface TrackSample {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  segment: number;
}

export function createTrackHit(): TrackHit {
  return { segment: 0, t: 0, s: 0, x: 0, z: 0, tx: 0, tz: 1, lateral: 0, distance: 0 };
}

/**
 * Arc-length view of the closed track polyline: nearest-point queries
 * (windowed or global) and sampling by distance.
 */
export class TrackPath {
  readonly count: number;
  /** Total loop length, m. */
  readonly length: number;
  readonly halfWidth: number;
  readonly shoulder: number;
  /** Lowest road height — reference for "fell out of the world". */
  readonly minHeight: number;

  // count + 1 entries: the first point is repeated at the end so segment i is
  // always (i, i + 1) with no modulo in the hot loop.
  private readonly px: Float64Array;
  private readonly pz: Float64Array;
  private readonly py: Float64Array;
  private readonly segLen: Float64Array;
  /** cum[i] = arc length at point i; cum[count] = length. */
  private readonly cum: Float64Array;

  constructor(src: RaceTrackSource) {
    const n = src.count;
    if (n < 3) throw new Error('TrackPath: a closed track needs at least 3 points');
    this.count = n;
    this.halfWidth = src.halfWidth;
    this.shoulder = src.shoulder ?? 0;
    this.px = new Float64Array(n + 1);
    this.pz = new Float64Array(n + 1);
    this.py = new Float64Array(n + 1);
    this.segLen = new Float64Array(n);
    this.cum = new Float64Array(n + 1);
    let minH = Infinity;
    for (let i = 0; i <= n; i++) {
      const j = i % n;
      this.px[i] = src.points[j * 2];
      this.pz[i] = src.points[j * 2 + 1];
      this.py[i] = src.roadHeights ? src.roadHeights[j] : 0;
      if (this.py[i] < minH) minH = this.py[i];
    }
    this.minHeight = minH;
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.cum[i] = total;
      const l = Math.hypot(this.px[i + 1] - this.px[i], this.pz[i + 1] - this.pz[i]);
      this.segLen[i] = l;
      total += l;
    }
    this.cum[n] = total;
    this.length = total;
  }

  /** Wrap an arc length into [0, length). */
  wrap(s: number): number {
    const L = this.length;
    const w = s % L;
    return w < 0 ? w + L : w;
  }

  /** Signed shortest arc from `a` to `b`, in (−length/2, length/2]. */
  delta(a: number, b: number): number {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L;
    else if (d <= -L / 2) d += L;
    return d;
  }

  /** Segment containing arc length `s` (wrapped). */
  segmentAt(s: number): number {
    const w = this.wrap(s);
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= w) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Nearest centreline point over the WHOLE loop. Only for (re)acquisition:
   * where the loop passes close to itself the global nearest can be the wrong
   * branch, so per-frame tracking must use `locateNear`. */
  locate(x: number, z: number, out: TrackHit): TrackHit {
    this.qx = x;
    this.qz = z;
    return this.scan(0, this.count, out);
  }

  /** Nearest centreline point within the arc window [s − back, s + fwd].
   * The window is what makes tracking immune to another part of the loop
   * passing nearby: segments outside it are never even looked at. */
  locateNear(x: number, z: number, s: number, back: number, fwd: number, out: TrackHit): TrackHit {
    this.qx = x;
    this.qz = z;
    if (back + fwd >= this.length) return this.scan(0, this.count, out);
    const first = this.segmentAt(s - back);
    const last = this.segmentAt(s + fwd);
    const n = ((last - first + this.count) % this.count) + 1;
    return this.scan(first, n, out);
  }

  /** Centreline position, height and tangent at arc length `s`. */
  sample(s: number, out: TrackSample): TrackSample {
    const w = this.wrap(s);
    const i = this.segmentAt(w);
    const len = this.segLen[i];
    const t = len > 0 ? Math.min(Math.max((w - this.cum[i]) / len, 0), 1) : 0;
    const dx = this.px[i + 1] - this.px[i];
    const dz = this.pz[i + 1] - this.pz[i];
    out.x = this.px[i] + dx * t;
    out.z = this.pz[i] + dz * t;
    out.y = this.py[i] + (this.py[i + 1] - this.py[i]) * t;
    out.tx = len > 0 ? dx / len : 0;
    out.tz = len > 0 ? dz / len : 1;
    out.segment = i;
    return out;
  }

  // The query point travels in two fields rather than as arguments: `scan`
  // is too big to be inlined, and a float handed to a non-inlined function
  // is boxed on the heap — two allocations per car per frame.
  private qx = 0;
  private qz = 0;

  private scan(first: number, n: number, out: TrackHit): TrackHit {
    const x = this.qx;
    const z = this.qz;
    const count = this.count;
    let best = Infinity;
    let bi = first % count;
    let bt = 0;
    let i = bi;
    for (let k = 0; k < n; k++) {
      const ax = this.px[i];
      const az = this.pz[i];
      const dx = this.px[i + 1] - ax;
      const dz = this.pz[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x;
      const ez = az + dz * t - z;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
      }
      i = i + 1 === count ? 0 : i + 1;
    }
    const len = this.segLen[bi];
    const dx = this.px[bi + 1] - this.px[bi];
    const dz = this.pz[bi + 1] - this.pz[bi];
    out.segment = bi;
    out.t = bt;
    out.s = this.cum[bi] + len * bt;
    out.x = this.px[bi] + dx * bt;
    out.z = this.pz[bi] + dz * bt;
    out.tx = len > 0 ? dx / len : 0;
    out.tz = len > 0 ? dz / len : 1;
    // Right of travel is positive: for a tangent of +z the right side is +x.
    out.lateral = (x - out.x) * out.tz - (z - out.z) * out.tx;
    out.distance = Math.sqrt(best);
    return out;
  }
}

// ───────────────────────────── respawn ─────────────────────────────

export interface RespawnPose {
  /** Point ON the road surface, centre of the road — what `Vehicle.reset`
   * wants as its ground point. */
  ground: Vec3Like;
  /** The same point lifted by `lift`, for models that are dropped in. */
  position: Vec3Like;
  /** Unit heading along the track (y = 0). */
  forward: Vec3Like;
  /** atan2(forward.x, forward.z). */
  yaw: number;
  /** Arc length of the pose, 0..length. */
  s: number;
}

export interface RespawnOptions {
  /** Height above the ground of `position`, m. Default 0.5. */
  lift?: number;
  /** Ground height lookup (e.g. `Heightfield.getHeight`). Without it the
   * track's own smoothed road heights are used. */
  heightAt?: (x: number, z: number) => number;
}

// The tangent of a single ~1 m segment is noisy on a resampled spline; a
// chord across a few metres gives the heading a driver would call "along the
// road".
const RESPAWN_CHORD = 2.5;

/** Safe pose on the road centre at arc length `s`, heading along the track.
 * Pure: the caller teleports the car (and tells the race via
 * `RaceState.respawn`, which calls this). */
export function respawnPose(path: TrackPath, s: number, options: RespawnOptions = {}): RespawnPose {
  const at = path.sample(s, scratchSampleA);
  const x = at.x;
  const z = at.z;
  let y = at.y;
  const a = path.sample(s - RESPAWN_CHORD, scratchSampleA);
  const ax = a.x;
  const az = a.z;
  const b = path.sample(s + RESPAWN_CHORD, scratchSampleB);
  let fx = b.x - ax;
  let fz = b.z - az;
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-9) {
    fx /= fl;
    fz /= fl;
  } else {
    fx = 0;
    fz = 1;
  }
  if (options.heightAt) y = options.heightAt(x, z);
  const lift = options.lift ?? 0.5;
  return {
    ground: { x, y, z },
    position: { x, y: y + lift, z },
    forward: { x: fx, y: 0, z: fz },
    yaw: Math.atan2(fx, fz),
    s: path.wrap(s),
  };
}

const scratchSampleA: TrackSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, segment: 0 };
const scratchSampleB: TrackSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, segment: 0 };

// ───────────────────────────── storage ─────────────────────────────

/** Where the PLAYER's all-time best lap lives. Injected so the race logic can
 * run in tests, workers and on a server without touching `localStorage`.
 * Only laps of the player car are ever written (see `RaceConfig.playerId`). */
export interface BestLapStorage {
  load(key: string): number | null;
  save(key: string, seconds: number): void;
}

export function memoryBestLapStorage(initial: Record<string, number> = {}): BestLapStorage {
  const map = new Map<string, number>(Object.entries(initial));
  return {
    load: (key) => map.get(key) ?? null,
    save: (key, seconds) => void map.set(key, seconds),
  };
}

/** `localStorage`-backed storage. Every access is guarded: private browsing
 * and embedded webviews throw on access rather than returning null. */
export function webBestLapStorage(prefix = 'web-racer.bestLap.'): BestLapStorage {
  const store = (): Storage | null => {
    try {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    load(key) {
      try {
        const raw = store()?.getItem(prefix + key);
        const v = raw === null || raw === undefined ? NaN : Number.parseFloat(raw);
        return Number.isFinite(v) && v > 0 ? v : null;
      } catch {
        return null;
      }
    },
    save(key, seconds) {
      try {
        store()?.setItem(prefix + key, seconds.toFixed(3));
      } catch {
        // Quota or privacy mode: the best lap simply does not persist.
      }
    },
  };
}

// ───────────────────────────── snapshot ─────────────────────────────

export type RacePhase = 'countdown' | 'racing' | 'finished';
export type ResetReason = 'flipped' | 'fell' | 'stranded' | 'shortcut';
export type FlashKind = 'lap' | 'final-lap' | 'best-lap' | 'respawn' | 'cut';

export interface HudFlash {
  /** Increments for every new flash — renderers restart their animation when
   * it changes. */
  seq: number;
  kind: FlashKind;
  /** Headline, e.g. "BEST LAP". */
  text: string;
  /** Second line, e.g. the lap time; '' when there is none. */
  sub: string;
  /** Seconds since the flash started. */
  age: number;
  duration: number;
}

export interface FinishSummary {
  /** Race time at the finish line, s. */
  totalTime: number;
  lapTimes: readonly number[];
  /** Index into `lapTimes` of the fastest lap. */
  bestLapIndex: number;
  position: number;
  count: number;
  /** The player's all-time best lap for this track after this race, s. */
  bestLap: number | null;
  /** This car (the player) set a new all-time best lap in this race. */
  newRecord: boolean;
}

/**
 * Everything a HUD renderer needs for one car, as plain data. The object is
 * owned by the `RaceState` and UPDATED IN PLACE every frame (no per-frame
 * garbage) — copy it if you need to keep a frame.
 */
export interface HudSnapshot {
  phase: RacePhase;
  /** 3, 2, 1 while counting down; 0 while "GO" is showing (the first second
   * of the race); null otherwise. */
  countdown: number | null;
  /** True during the countdown: the game must feed the car zero input. */
  inputLocked: boolean;
  /** Seconds since GO (0 during the countdown); frozen once this car finished. */
  raceTime: number;
  /** Displayed speed, whole km/h, ≥ 0 (already de-flickered). */
  speedKmh: number;
  /** 0..1 value for the bar under the speed readout — supplied by the game
   * (boost, engine load, ...), only clamped here. */
  bar: number;
  /** Current lap, 1-based, never above `laps`. */
  lap: number;
  /** Total laps; Infinity = endless free run. */
  laps: number;
  /** Time on the current lap, s (the last lap's time once finished). */
  lapTime: number;
  lastLap: number | null;
  /** The PLAYER's all-time best lap for this track (storage ∪ this session),
   * s — the same value in every car's snapshot; laps of other cars never
   * touch it. */
  bestLap: number | null;
  /** 1 = leading. */
  position: number;
  /** Number of cars in the race. With 1 the position is meaningless and the
   * HUD shows the lap timer in its place. */
  count: number;
  wrongWay: boolean;
  /** Beyond road + shoulder. */
  offTrack: boolean;
  /** 0..1 around the current lap. */
  lapProgress: number;
  /** Set when the car should be teleported back. The game MUST answer it —
   * `const pose = race.respawn(id)` and move the car to the pose — and it
   * stays set until then. After a 'shortcut' the car's progress is already a
   * lap behind: left unanswered, its next crossing of the line counts for
   * nothing. */
  needsReset: ResetReason | null;
  flash: HudFlash | null;
  /** Non-null once this car has finished. */
  finish: FinishSummary | null;
}

// ───────────────────────────── race ─────────────────────────────

/** One car's state for this frame. */
export interface CarSample {
  id: string;
  /** World position of the car (chassis centre). */
  position: Vec3Like;
  /** World-space forward axis of the chassis (need not be normalised). */
  forward: Vec3Like;
  /** World-space up axis of the chassis — lets the race see a car on its
   * side or roof. Omit for cars that cannot roll (AI on rails). */
  up?: Vec3Like;
  /** Signed speed along the forward axis, m/s. */
  speed: number;
  /** 0..1 for the HUD bar. */
  bar?: number;
}

export type RaceEvent =
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  /** `best`: a new all-time record — only ever true for the player car. */
  | { type: 'lap'; id: string; lap: number; time: number; best: boolean }
  /** Emitted after every car of the frame was updated, in finishing order. */
  | { type: 'finish'; id: string; time: number; position: number }
  /** The car rejoined the road `skipped` metres further on than it can have
   * driven: that progress is void (see the progress model on `RaceState`).
   * Followed by 'needs-reset' when `resetOnShortcut` is on. */
  | { type: 'shortcut'; id: string; skipped: number }
  | { type: 'wrong-way'; id: string; active: boolean }
  | { type: 'needs-reset'; id: string; reason: ResetReason };

export interface RaceConfig {
  /** Laps to finish. Default 3. Infinity = endless. */
  laps: number;
  /** Length of the 3-2-1 countdown, s. 0 starts racing immediately. */
  countdownSeconds: number;
  /** How long "GO" stays up after the start, s. */
  goSeconds: number;
  /** Identifies the track for best-lap persistence (e.g. `hills-1`). */
  trackKey: string;
  storage: BestLapStorage | null;
  /** The local player's car: its finish ends the race phase, and ONLY its
   * laps count for the stored best lap (AI and remote cars must not write
   * their times into this user's record). Default: the first car seen. */
  playerId: string | null;
  /** Audio / effects hook, called synchronously from `update`. */
  onEvent: ((event: RaceEvent) => void) | null;

  /** On course = within halfWidth + shoulder + this, m. */
  courseMargin: number;
  /** Tracking is frozen ("lost") beyond halfWidth + shoulder + this, m. */
  lostMargin: number;
  /** Arc window searched each frame, m, each way (plus 4× the distance moved). */
  searchWindow: number;
  /** While OFF the course, forward progress is only believed up to this many
   * metres per metre actually driven. Running a few metres inside a bend
   * gains R/(R − offset) ≈ 1.1–1.4; cutting across the neck of a hairpin
   * gains many times its length. */
  gainRatio: number;
  /** Unearned forward progress that is forgiven on rejoining the road, m.
   * More than that is a shortcut: not credited (and, by default, a reset).
   * In checkpoint terms: gates this far apart, anything between two of them
   * is the driver's business. */
  legalSkip: number;
  /** Seconds a global re-acquisition must hold before it is believed. */
  reacquireSeconds: number;
  /** A shortcut asks for a respawn at the point where the car left. Off:
   * the car is only told (TRACK CUT flash, 'shortcut' event) and has to
   * drive back to where it left before it makes progress again. */
  resetOnShortcut: boolean;

  /** Chassis up.y below this counts as on its side / roof. */
  flipUpY: number;
  flipSeconds: number;
  /** Stranded = further than halfWidth + shoulder + this from the centreline… */
  strandMargin: number;
  /** …slower than this, m/s… */
  strandSpeed: number;
  /** …for this long, s. */
  strandSeconds: number;
  /** Below this world y the car has fallen out. Default: lowest road − 25 m. */
  killY: number | null;
  /** |x| or |z| beyond this is out of the world. Default: no limit. */
  worldHalfExtent: number;
  /** Respawn this far behind the last valid progress, m. */
  respawnBackoff: number;
  /** No stuck detection for this long after a respawn, s. */
  respawnGrace: number;
  respawn: RespawnOptions;
}

export const DEFAULT_RACE_CONFIG: RaceConfig = {
  laps: 3,
  countdownSeconds: 3,
  goSeconds: 1,
  trackKey: 'default',
  storage: null,
  playerId: null,
  onEvent: null,
  courseMargin: 1,
  lostMargin: 8,
  searchWindow: 12,
  gainRatio: 1.5,
  legalSkip: 10,
  reacquireSeconds: 0.35,
  resetOnShortcut: true,
  flipUpY: 0.35,
  flipSeconds: 2,
  strandMargin: 3,
  strandSpeed: 1,
  strandSeconds: 3,
  killY: null,
  worldHalfExtent: Infinity,
  respawnBackoff: 2,
  respawnGrace: 1.5,
  respawn: {},
};

/** Read-only view of one car's race state (debug overlays, AI, netcode). */
export interface CarRaceState {
  readonly id: string;
  /** Arc length of the tracked centreline point, 0..length. */
  readonly s: number;
  /** Unwrapped distance: `s` plus whole laps, negative behind the line. */
  readonly dist: number;
  /** Furthest legitimately reached `dist` — laps and positions come from it.
   * Only `resync` ever lowers it. */
  readonly validDist: number;
  /** `dist` the race has agreed to pay for; `dist − credit` is progress not
   * (yet) earned by driving. */
  readonly credit: number;
  readonly lateral: number;
  readonly distance: number;
  readonly lost: boolean;
  readonly onCourse: boolean;
  readonly lapsDone: number;
  readonly lapTimes: readonly number[];
  readonly finished: boolean;
  readonly wrongWay: boolean;
  readonly needsReset: ResetReason | null;
}

interface Car {
  id: string;
  order: number;
  located: boolean;
  /** Re-locate globally on the next sample, keeping the laps done. */
  resync: boolean;
  startS: number | null;
  s: number;
  dist: number;
  /** Distance the race has agreed to pay for: lags `dist` by any progress
   * that was not earned by actually driving (off the road, progress is only
   * believed in proportion to the distance really covered). */
  credit: number;
  /** Metres driven since tracking was lost. */
  lostTravel: number;
  /** Off-course progress the car may still be credited (see GAIN_BUCKET). */
  allowance: number;
  validDist: number;
  lateral: number;
  distance: number;
  tx: number;
  tz: number;
  lost: boolean;
  onCourse: boolean;
  reacquireT: number;
  hasPrev: boolean;
  prevX: number;
  prevZ: number;
  along: number;
  /** Race time at which `dist` last went up over the pending lap line
   * (NaN: it has not, or the lap was since credited). The lap is only
   * CREDITED on the road, possibly seconds later — but it is timed here. */
  crossT: number;
  wrongWay: boolean;
  wrongT: number;
  rightT: number;
  flipT: number;
  strandT: number;
  graceT: number;
  needsReset: ResetReason | null;
  lapsDone: number;
  lapStart: number;
  lapTimes: number[];
  lastLap: number | null;
  finished: boolean;
  finishTime: number;
  /** 0 while the finishers of the current frame are still being ordered. */
  finishPosition: number;
  /** Removed after finishing: stays classified until the next restart. */
  left: boolean;
  newRecord: boolean;
  speedKmh: number;
  flash: HudFlash | null;
  position: number;
  snapshot: HudSnapshot;
}

// Wrong-way hysteresis: it takes a second of driving against the track with
// the nose pointing backwards to raise the flag, and a clear forward heading
// for a moment to drop it. Reversing (nose forward) never raises it.
const WRONG_FACING_ON = -0.35;
const WRONG_FACING_OFF = 0.15;
const WRONG_ALONG = -1.0;
const WRONG_ON_SECONDS = 1.0;
const WRONG_OFF_SECONDS = 0.4;

const FLASH_SECONDS = 2.6;
// A move this large in one frame is a teleport the caller did not announce.
const TELEPORT_DISTANCE = 20;
// Off-course progress allowance that can be banked, m. Big enough for the
// step the projection takes at a polyline vertex, small enough that driving
// in circles off the road cannot save up for a shortcut.
const GAIN_BUCKET = 3;
// The readout only changes once the true speed is this far from the shown
// integer, so a speed hovering on x.5 (±0.5 km/h of physics noise) does not
// flicker between two numbers. Costs at most 1 km/h of lag.
const SPEED_HYSTERESIS = 1.0;

/**
 * The race: phases, per-car progress, laps, timing, positions.
 *
 * Progress model (why laps cannot be faked):
 *  - Each car has a tracked centreline point `s`, followed by a WINDOWED
 *    nearest-segment search around the previous one — other parts of the loop
 *    that pass nearby are never candidates, so `s` moves continuously.
 *  - `dist` is `s` unwrapped (plus whole laps, negative behind the line). It
 *    goes down when the car goes backwards, so reversing over the line, or a
 *    whole lap the wrong way, simply un-earns distance.
 *  - `validDist` is the furthest `dist` reached while on the course. It only
 *    grows. Laps are `floor(validDist / length)`; positions sort by it.
 *  - Off the road, progress is only believed in proportion to the distance
 *    really driven. A car that leaves, cuts across and rejoins further on has
 *    gained track it did not drive: that is not credited — `dist` drops a
 *    whole lap (it must stay congruent to `s`), so the car has to come back
 *    to where it left before `validDist` moves again — and by default a
 *    reset to that point is requested.
 *  This is "ordered checkpoints" taken to the limit: every metre of the
 *  track is a checkpoint, `legalSkip` being how far apart the gates are.
 *
 * Contract for the game: honour `snapshot.needsReset` (call `respawn(id)` and
 * move the car to the pose), and announce its own teleports with `resync` or
 * `respawn` — an unannounced jump forward is judged like any other shortcut.
 */
export class RaceState {
  readonly path: TrackPath;
  readonly config: RaceConfig;

  private phaseValue: RacePhase;
  private countdownLeft: number;
  private countdownShown: number;
  private raceClock = 0;
  private best: number | null;
  private flashSeq = 0;
  private finishedCount = 0;
  /** Cars that completed their last lap this frame and await a position. */
  private pendingFinish = 0;
  private lastFinishTime = 0;
  // Tie-break for equal progress. A counter, not `cars.size`: after a
  // removal the size would hand out an order that is already taken.
  private nextOrder = 0;
  private readonly cars = new Map<string, Car>();
  private readonly ranking: Car[] = [];
  private readonly hit = createTrackHit();
  private readonly globalHit = createTrackHit();
  private playerId: string | null;

  constructor(track: RaceTrackSource | TrackPath, config: Partial<RaceConfig> = {}) {
    this.path = track instanceof TrackPath ? track : new TrackPath(track);
    this.config = { ...DEFAULT_RACE_CONFIG, ...config };
    this.playerId = this.config.playerId;
    this.best = this.config.storage?.load(this.config.trackKey) ?? null;
    this.phaseValue = this.config.countdownSeconds > 0 ? 'countdown' : 'racing';
    this.countdownLeft = Math.max(this.config.countdownSeconds, 0);
    this.countdownShown = -1;
  }

  get phase(): RacePhase {
    return this.phaseValue;
  }

  /** True during the countdown — gate the car's input with it. */
  get inputLocked(): boolean {
    return this.phaseValue === 'countdown';
  }

  /** Seconds since GO. */
  get raceTime(): number {
    return this.raceClock;
  }

  /** The player's all-time best lap for this track, s. */
  get bestLap(): number | null {
    return this.best;
  }

  /** Cars classified in the race (including finishers that have left). */
  get carCount(): number {
    return this.cars.size;
  }

  hasCar(id: string): boolean {
    return this.cars.has(id);
  }

  /**
   * Register a car before its first sample. Optional — unknown ids are added
   * on first sight — but lets a grid be set up so the car count is right
   * from frame one, and takes a start arc length for tracks where the grid
   * slot is close to another part of the loop.
   */
  addCar(id: string, startS: number | null = null): void {
    const known = this.cars.get(id);
    if (known) {
      known.left = false;
      return;
    }
    const car = createCar(id, this.nextOrder++, this.config.laps);
    car.startS = startS;
    this.cars.set(id, car);
    this.ranking.push(car);
    if (this.playerId === null) this.playerId = id;
  }

  /**
   * Take a car out of the race. A car that has FINISHED keeps its place in
   * the classification until the next `restart` — the cars behind it did not
   * move up because the winner closed the game, and "3rd of 2" must not
   * appear — it merely needs no more samples. Removing the player without a
   * configured `playerId` hands the default snapshot to the longest-serving
   * remaining car.
   */
  removeCar(id: string): void {
    const car = this.cars.get(id);
    if (!car) return;
    if (car.finished && car.finishPosition > 0) {
      car.left = true;
      return;
    }
    this.drop(car);
  }

  /** Back to the countdown with every car's progress cleared. Cars are
   * re-located from their next sample, so teleport them to the grid first. */
  restart(): void {
    this.phaseValue = this.config.countdownSeconds > 0 ? 'countdown' : 'racing';
    this.countdownLeft = Math.max(this.config.countdownSeconds, 0);
    this.countdownShown = -1;
    this.raceClock = 0;
    this.finishedCount = 0;
    this.pendingFinish = 0;
    this.lastFinishTime = 0;
    const r = this.ranking;
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i].left) this.drop(r[i]);
      else resetCar(r[i]);
    }
  }

  /**
   * Advance the race by one frame. Call once per frame with every car's
   * current state (one sample or an array), then read `snapshot()`.
   */
  update(dt: number, cars: CarSample | readonly CarSample[]): void {
    const step = dt > 0 ? Math.min(dt, 0.25) : 0;
    let raceDt = step;
    if (this.phaseValue === 'countdown') {
      this.countdownLeft -= step;
      if (this.countdownLeft <= 0) {
        // The overshoot of the last countdown frame already belongs to the race.
        raceDt = -this.countdownLeft;
        this.countdownLeft = 0;
        this.phaseValue = 'racing';
        this.raceClock = 0;
        // Index loops over `ranking` throughout the frame path: a Map
        // iterator is a fresh object per call, i.e. per-frame garbage.
        const all = this.ranking;
        for (let i = 0; i < all.length; i++) {
          const car = all[i];
          // Whatever the car did while settling on the grid is not progress.
          car.validDist = car.dist;
          car.credit = car.dist;
          car.lapStart = 0;
          car.crossT = NaN;
        }
        this.emit({ type: 'go' });
      } else {
        raceDt = 0;
        const shown = Math.ceil(this.countdownLeft);
        if (shown !== this.countdownShown) {
          this.countdownShown = shown;
          this.emit({ type: 'countdown', value: shown });
        }
      }
    }
    this.raceClock += raceDt;

    if (isSampleArray(cars)) {
      for (let i = 0; i < cars.length; i++) this.updateCar(cars[i], step, raceDt);
    } else {
      this.updateCar(cars, step, raceDt);
    }

    if (this.pendingFinish > 0) this.classify();
    this.rank();
    const all = this.ranking;
    for (let i = 0; i < all.length; i++) this.writeSnapshot(all[i]);
  }

  /** Snapshot for one car (default: the player). Updated in place by `update`. */
  snapshot(id?: string): HudSnapshot {
    return this.need(id).snapshot;
  }

  /** Internal progress of one car, for debug views, AI and netcode. */
  carState(id?: string): CarRaceState {
    return this.need(id);
  }

  /**
   * Where to put a car back on the road: centre of the road at its last
   * valid progress. Pure — does not change the race.
   */
  respawnPoseFor(id?: string): RespawnPose {
    const car = this.need(id);
    return respawnPose(this.path, this.respawnDist(car), this.config.respawn);
  }

  /**
   * Returns the respawn pose AND tells the race the car is being teleported
   * there (progress, timers and the reset request are cleared). The caller
   * must move the car, e.g. `car.reset(pose.ground, pose.yaw)`. Also the
   * entry point for a manual "reset car" button.
   */
  respawn(id?: string): RespawnPose {
    const car = this.need(id);
    const dist = this.respawnDist(car);
    const pose = respawnPose(this.path, dist, this.config.respawn);
    const reason = car.needsReset;
    car.s = pose.s;
    car.dist = dist;
    car.credit = dist;
    car.lostTravel = 0;
    car.allowance = GAIN_BUCKET;
    car.lateral = 0;
    car.distance = 0;
    car.lost = false;
    car.onCourse = true;
    car.reacquireT = 0;
    car.hasPrev = false;
    car.along = 0;
    car.crossT = NaN;
    car.wrongT = 0;
    car.rightT = 0;
    car.flipT = 0;
    car.strandT = 0;
    car.needsReset = null;
    car.graceT = this.config.respawnGrace;
    if (car.wrongWay) {
      car.wrongWay = false;
      this.emit({ type: 'wrong-way', id: car.id, active: false });
    }
    if (this.phaseValue === 'racing' && !car.finished) {
      this.flash(car, 'respawn', reason === 'shortcut' ? 'TRACK CUT' : 'RESET', '');
    }
    this.writeSnapshot(car);
    return pose;
  }

  /**
   * Accept a car wherever it is now — for teleports the game does on purpose
   * (reset to the grid, scripted moves): no "lost" phase, no shortcut
   * verdict, no reset request. The car keeps its laps and continues from the
   * nearest point of the track, and its furthest-progress marker moves there
   * with it (so does a later respawn).
   *
   * A resync never EARNS anything: the new place is taken the shortest way
   * round from the old one, and if that is further ahead than the car can
   * have driven (beyond `legalSkip`) it is the same place one lap earlier.
   * Resyncing a car that has not moved changes nothing, wherever it stands
   * relative to the start line.
   */
  resync(id?: string): void {
    const car = this.need(id);
    car.resync = true;
    car.hasPrev = false;
    car.needsReset = null;
  }

  // ── per car ──

  private updateCar(sample: CarSample, dt: number, raceDt: number): void {
    let car = this.cars.get(sample.id);
    if (!car) {
      this.addCar(sample.id);
      car = this.cars.get(sample.id)!;
    }
    const cfg = this.config;
    const path = this.path;
    const x = sample.position.x;
    const z = sample.position.z;

    // Math.sqrt, not Math.hypot, on the per-frame path: V8 does not inline
    // hypot and hands its result back as a heap-allocated number — the only
    // per-frame garbage this function produced.
    const mx = x - car.prevX;
    const mz = z - car.prevZ;
    let travel = car.hasPrev ? Math.sqrt(mx * mx + mz * mz) : 0;
    car.prevX = x;
    car.prevZ = z;
    car.hasPrev = true;

    const courseLimit = path.halfWidth + path.shoulder + cfg.courseMargin;
    const lostLimit = path.halfWidth + path.shoulder + cfg.lostMargin;
    const hit = this.hit;
    let ds = 0;
    let tracked = false;
    let jumped = false;

    if (!car.located) {
      if (car.startS !== null) path.locateNear(x, z, car.startS, 30, 30, hit);
      else path.locate(x, z, hit);
      car.located = true;
      car.s = hit.s;
      // A grid slot behind the line is negative distance, not most of a lap.
      car.dist = hit.s > path.length / 2 ? hit.s - path.length : hit.s;
      car.credit = car.dist;
      car.validDist = car.dist;
      car.lost = false;
      tracked = true;
    } else if (car.resync) {
      car.resync = false;
      // A car still on its own stretch of road stays on it: where the loop
      // passes close to itself the global nearest can be the other branch.
      let own = false;
      if (!car.lost) {
        path.locateNear(x, z, car.s, cfg.searchWindow, cfg.searchWindow, hit);
        own = hit.distance <= path.halfWidth + path.shoulder;
      }
      if (!own) path.locate(x, z, hit);
      // `lapsDone · L + s` would be wrong on both sides of the line: a car
      // waiting just behind it (s ≈ L) would be credited most of a lap it
      // never drove and complete it by rolling forward.
      let dist = car.dist + path.delta(car.s, hit.s);
      const limit = Math.max(car.validDist, car.credit) + cfg.legalSkip;
      while (dist > limit) dist -= path.length;
      car.s = hit.s;
      car.dist = dist;
      car.credit = dist;
      if (dist < car.validDist) car.validDist = dist;
      car.lost = false;
      car.lostTravel = 0;
      car.allowance = GAIN_BUCKET;
      car.reacquireT = 0;
      car.along = 0;
      car.crossT = NaN;
      tracked = true;
    } else {
      if (travel > TELEPORT_DISTANCE) {
        // Unannounced teleport: nothing about the old window is meaningful.
        travel = 0;
        car.lost = true;
        hit.distance = Infinity;
      } else {
        const reach = cfg.searchWindow + 4 * travel;
        path.locateNear(x, z, car.s, reach, reach, hit);
      }
      if (hit.distance <= lostLimit) {
        car.lost = false;
        car.reacquireT = 0;
        ds = path.delta(car.s, hit.s);
        tracked = true;
      } else {
        car.lost = true;
        car.lostTravel += travel;
        const g = path.locate(x, z, this.globalHit);
        if (g.distance <= courseLimit) {
          car.reacquireT += dt;
          if (car.reacquireT >= cfg.reacquireSeconds) {
            // Back on the road somewhere else: the tracker follows, what the
            // jump is worth is decided below.
            ds = path.delta(car.s, g.s);
            copyHit(g, hit);
            car.lost = false;
            car.reacquireT = 0;
            tracked = true;
            jumped = true;
          }
        } else {
          car.reacquireT = 0;
        }
        if (!tracked) {
          // Still report how far off the car is, for the stranded check.
          car.distance = g.distance;
          car.onCourse = false;
        }
      }
    }

    if (tracked) {
      const wasOnCourse = car.onCourse;
      const lapLine = (car.lapsDone + 1) * path.length;
      const before = car.dist;
      car.s = hit.s;
      car.dist += ds;
      // Interpolated inside the frame: at 14 m/s a frame is a quarter of a
      // metre, i.e. ±8 ms of lap time if left at frame ends.
      if (before < lapLine && car.dist >= lapLine) {
        car.crossT = this.raceClock - raceDt * (1 - (lapLine - before) / ds);
      }
      car.lateral = hit.lateral;
      car.distance = hit.distance;
      car.tx = hit.tx;
      car.tz = hit.tz;
      car.onCourse = hit.distance <= courseLimit;

      // What is this frame's progress worth? Never more than the car can
      // have earned by driving:
      if (jumped) {
        // …after being lost, at most the distance covered meanwhile (a wide
        // detour round the outside is honest, a chord across the infield
        // is not);
        if (ds > 0) car.credit += Math.min(ds, car.lostTravel);
      } else if (wasOnCourse && car.onCourse) {
        // …on the road, all of it — also where the projection of an offset
        // car legitimately skips ahead on the inside of a tight bend;
        if (ds > 0) car.credit += ds;
      } else {
        // …off the road, in proportion to the distance really driven: the
        // tracked point racing round a hairpin while the car cuts straight
        // across its neck is followed, but not paid for. The allowance is
        // a small bucket rather than a per-frame limit because the
        // projection onto a polyline advances in steps at every vertex.
        car.allowance = Math.min(car.allowance + cfg.gainRatio * travel, GAIN_BUCKET);
        if (ds > 0) {
          const pay = Math.min(ds, car.allowance);
          car.credit += pay;
          car.allowance -= pay;
        }
      }
      // Going BACK first gives back progress that was never paid for; only
      // then does it cost credit. Taking it off the credit straight away
      // (keeping the debt) let a car shuffling to and fro inside a bend run
      // up a debt for the same few metres again and again — a "shortcut"
      // with no net progress at all.
      if (car.credit > car.dist) car.credit = car.dist;
      if (car.onCourse) car.allowance = GAIN_BUCKET;
      car.lostTravel = 0;
      // A re-acquisition jump is not motion along the track.
      if (jumped) car.along = 0;
      else if (dt > 0) car.along += (ds / dt - car.along) * Math.min(1, dt * 8);

      if (car.onCourse) {
        const debt = car.dist - car.credit;
        if (debt > cfg.legalSkip && car.dist > car.validDist) {
          // Shortcut. `dist` must stay congruent to `s`, so the car is put a
          // whole lap behind: it has to return to where it left the road (or
          // drive all the way round) before it makes progress again.
          car.dist -= path.length;
          car.credit = car.dist;
          this.emit({ type: 'shortcut', id: car.id, skipped: debt });
          if (this.phaseValue === 'racing' && !car.finished) {
            if (cfg.resetOnShortcut) this.requestReset(car, 'shortcut');
            // Without the teleport the driver must be TOLD: from here to
            // the point where the car left, the HUD stands still.
            else this.flash(car, 'cut', 'TRACK CUT', 'REJOIN WHERE YOU LEFT');
          }
        } else if (debt > cfg.legalSkip) {
          // Unearned, but the car is still behind its own furthest point
          // (it reversed, or an earlier cut already cost it a lap): nothing
          // was gained, so there is nothing to void. Punishing it again put
          // a car whose reset request went unanswered TWO laps behind after
          // two clipped bends.
          car.credit = car.dist;
        } else {
          car.credit = car.dist;
          if (this.phaseValue !== 'countdown' && car.dist > car.validDist) {
            this.advance(car, car.dist, raceDt);
          }
        }
      }
      // Back behind the line (reversed, or the crossing was a shortcut):
      // that crossing never happened.
      if (car.dist < (car.lapsDone + 1) * path.length) car.crossT = NaN;
    }

    this.updateWrongWay(car, sample, dt, tracked);
    this.updateStuck(car, sample, dt);

    const kmh = Math.abs(sample.speed) * 3.6;
    if (Math.abs(kmh - car.speedKmh) >= SPEED_HYSTERESIS || kmh < 0.5) car.speedKmh = Math.round(kmh);

    // NaN-safe clamp: a NaN here would make every renderer repaint the bar
    // each frame (NaN never equals the value it painted last).
    const bar = sample.bar;
    car.snapshot.bar = bar !== undefined && bar > 0 ? Math.min(bar, 1) : 0;

    if (car.flash) {
      car.flash.age += dt;
      if (car.flash.age >= car.flash.duration) car.flash = null;
    }
  }

  private advance(car: Car, to: number, raceDt: number): void {
    const L = this.path.length;
    const from = car.validDist;
    car.validDist = to;
    while (!car.finished && car.validDist >= (car.lapsDone + 1) * L) {
      // The lap ends when the car crossed the line, not when the crossing
      // is credited: a car that runs wide over the line (off the course)
      // is credited when it is back on the road, seconds later — timing it
      // then would lengthen this lap and shorten the next by the same
      // amount, a false best lap. NaN (no crossing seen: a resync placed the
      // car past the line) falls back to this frame.
      let at = car.crossT;
      if (at !== at) {
        const line = (car.lapsDone + 1) * L;
        const f = to > from ? Math.min(Math.max((line - from) / (to - from), 0), 1) : 1;
        at = this.raceClock - raceDt * (1 - f);
      }
      car.crossT = NaN;
      // A finish credited late must not be classified behind a car with a
      // LATER time: the board stays ordered by time.
      if (car.lapsDone + 1 >= this.config.laps && at < this.lastFinishTime) at = this.lastFinishTime;
      this.completeLap(car, at);
    }
  }

  private completeLap(car: Car, at: number): void {
    const cfg = this.config;
    const time = at - car.lapStart;
    car.lapStart = at;
    car.lapTimes.push(time);
    car.lastLap = time;
    car.lapsDone++;

    // The stored best is the PLAYER's record: an AI or remote car lapping
    // faster must neither overwrite it nor use up the player's BEST LAP.
    // And "best" needs something to beat: the very first lap ever driven on
    // a track is a reference, not a record worth a fanfare.
    let isBest = false;
    if (car.id === this.playerId) {
      const reference = this.best;
      isBest = reference !== null && time < reference;
      if (reference === null || time < reference) {
        this.best = time;
        cfg.storage?.save(cfg.trackKey, time);
        if (isBest) car.newRecord = true;
      }
    }
    this.emit({ type: 'lap', id: car.id, lap: car.lapsDone, time, best: isBest });

    if (car.lapsDone >= cfg.laps) {
      // Position, phase change and the 'finish' event wait for `classify`:
      // another car later in this frame's sample array may have crossed
      // the line a few milliseconds earlier.
      car.finished = true;
      car.finishTime = at;
      car.finishPosition = 0;
      car.flash = null;
      this.pendingFinish++;
      return;
    }
    const lapText = formatLapTime(time);
    const final = car.lapsDone + 1 === cfg.laps;
    if (isBest) this.flash(car, 'best-lap', 'BEST LAP', final ? `${lapText}  ·  FINAL LAP` : lapText);
    else if (final) this.flash(car, 'final-lap', 'FINAL LAP', lapText);
    else this.flash(car, 'lap', lapLabel(car.lapsDone + 1, cfg.laps), lapText);
  }

  private updateWrongWay(car: Car, sample: CarSample, dt: number, tracked: boolean): void {
    if (this.phaseValue !== 'racing' || car.finished) {
      car.wrongT = 0;
      car.rightT = 0;
      if (car.wrongWay) {
        car.wrongWay = false;
        this.emit({ type: 'wrong-way', id: car.id, active: false });
      }
      return;
    }
    // While lost there is no trustworthy track direction: hold the last verdict.
    if (!tracked) return;
    const fl = Math.sqrt(sample.forward.x * sample.forward.x + sample.forward.z * sample.forward.z);
    // A car standing on its nose has no planar heading — treat as undecided.
    const facing = fl > 1e-3 ? (sample.forward.x * car.tx + sample.forward.z * car.tz) / fl : 0;
    if (!car.wrongWay) {
      if (facing < WRONG_FACING_ON && car.along < WRONG_ALONG) car.wrongT += dt;
      else car.wrongT = Math.max(0, car.wrongT - 2 * dt);
      if (car.wrongT >= WRONG_ON_SECONDS) {
        car.wrongWay = true;
        car.rightT = 0;
        this.emit({ type: 'wrong-way', id: car.id, active: true });
      }
    } else {
      if (facing > WRONG_FACING_OFF) car.rightT += dt;
      else car.rightT = 0;
      if (car.rightT >= WRONG_OFF_SECONDS) {
        car.wrongWay = false;
        car.wrongT = 0;
        this.emit({ type: 'wrong-way', id: car.id, active: false });
      }
    }
  }

  private updateStuck(car: Car, sample: CarSample, dt: number): void {
    const cfg = this.config;
    if (this.phaseValue !== 'racing' || car.finished) {
      car.flipT = 0;
      car.strandT = 0;
      return;
    }
    if (car.graceT > 0) {
      car.graceT -= dt;
      return;
    }
    if (car.needsReset) return;

    const p = sample.position;
    // Compared in place for the same reason (see writeSnapshot): `a ?? b`
    // of a config value and a computed one allocates a number per frame.
    const kill = cfg.killY;
    if ((kill !== null ? p.y < kill : p.y < this.path.minHeight - 25) || Math.abs(p.x) > cfg.worldHalfExtent || Math.abs(p.z) > cfg.worldHalfExtent) {
      this.requestReset(car, 'fell');
      return;
    }

    if (sample.up) {
      const u = sample.up;
      const ul = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z) || 1;
      if (u.y / ul < cfg.flipUpY) car.flipT += dt;
      else car.flipT = 0;
      if (car.flipT >= cfg.flipSeconds) {
        this.requestReset(car, 'flipped');
        return;
      }
    }

    const strandLimit = this.path.halfWidth + this.path.shoulder + cfg.strandMargin;
    if (car.distance > strandLimit && Math.abs(sample.speed) < cfg.strandSpeed) car.strandT += dt;
    else car.strandT = 0;
    if (car.strandT >= cfg.strandSeconds) this.requestReset(car, 'stranded');
  }

  private requestReset(car: Car, reason: ResetReason): void {
    if (car.needsReset) return;
    car.needsReset = reason;
    this.emit({ type: 'needs-reset', id: car.id, reason });
  }

  private respawnDist(car: Car): number {
    // A little before the furthest valid point: that point is where the car
    // was last seen ON the road, usually already aimed at whatever it hit.
    return car.located ? car.validDist - this.config.respawnBackoff : 0;
  }

  private flash(car: Car, kind: FlashKind, text: string, sub: string): void {
    car.flash = { seq: ++this.flashSeq, kind, text, sub, age: 0, duration: FLASH_SECONDS };
  }

  // ── ranking & snapshot ──

  /** Hand out finishing positions to this frame's finishers by crossing
   * TIME — the order of the sample array says nothing about who was first. */
  private classify(): void {
    const r = this.ranking;
    while (this.pendingFinish > 0) {
      let next: Car | null = null;
      for (let i = 0; i < r.length; i++) {
        const c = r[i];
        if (!c.finished || c.finishPosition !== 0) continue;
        if (!next || c.finishTime < next.finishTime || (c.finishTime === next.finishTime && c.order < next.order)) next = c;
      }
      this.pendingFinish--;
      if (!next) continue;
      next.finishPosition = ++this.finishedCount;
      this.lastFinishTime = next.finishTime;
      if (next.id === this.playerId) this.phaseValue = 'finished';
      this.emit({ type: 'finish', id: next.id, time: next.finishTime, position: next.finishPosition });
    }
  }

  private drop(car: Car): void {
    this.cars.delete(car.id);
    this.ranking.splice(this.ranking.indexOf(car), 1);
    if (this.playerId === car.id) {
      this.playerId = this.config.playerId ?? (this.ranking.length > 0 ? this.oldest().id : null);
    }
  }

  private oldest(): Car {
    const r = this.ranking;
    let first = r[0];
    for (let i = 1; i < r.length; i++) if (r[i].order < first.order) first = r[i];
    return first;
  }

  private rank(): void {
    const r = this.ranking;
    // Insertion sort: the order barely changes between frames, and it is
    // stable, so ties keep the order the cars were added in.
    for (let i = 1; i < r.length; i++) {
      const c = r[i];
      let j = i - 1;
      while (j >= 0 && ahead(c, r[j])) {
        r[j + 1] = r[j];
        j--;
      }
      r[j + 1] = c;
    }
    for (let i = 0; i < r.length; i++) r[i].position = i + 1;
  }

  private writeSnapshot(car: Car): void {
    const s = car.snapshot;
    const cfg = this.config;
    const L = this.path.length;
    s.phase = car.finished ? 'finished' : this.phaseValue === 'finished' ? 'racing' : this.phaseValue;
    if (this.phaseValue === 'countdown') s.countdown = Math.ceil(this.countdownLeft);
    else if (!car.finished && this.raceClock < cfg.goSeconds && cfg.countdownSeconds > 0) s.countdown = 0;
    else s.countdown = null;
    s.inputLocked = this.phaseValue === 'countdown';
    s.raceTime = car.finished ? car.finishTime : this.raceClock;
    s.speedKmh = car.speedKmh;
    s.laps = cfg.laps;
    s.lap = Math.min(car.lapsDone + 1, cfg.laps);
    // Two stores, not one conditional expression: merging the (boxed) last
    // lap with the freshly computed time makes V8 box the latter every frame.
    if (car.finished) s.lapTime = car.lastLap ?? 0;
    else s.lapTime = Math.max(this.raceClock - car.lapStart, 0);
    s.lastLap = car.lastLap;
    s.bestLap = this.best;
    s.position = car.finished ? car.finishPosition : car.position;
    s.count = this.cars.size;
    s.wrongWay = car.wrongWay;
    s.offTrack = car.located && car.distance > this.path.halfWidth + this.path.shoulder;
    const lapDist = car.validDist - car.lapsDone * L;
    s.lapProgress = car.finished ? 1 : lapDist <= 0 ? 0 : lapDist >= L ? 1 : lapDist / L;
    s.needsReset = car.needsReset;
    s.flash = car.flash;
    if (car.finished) {
      // Built once; position can still be read live from the snapshot.
      if (!s.finish) {
        let bi = 0;
        for (let i = 1; i < car.lapTimes.length; i++) if (car.lapTimes[i] < car.lapTimes[bi]) bi = i;
        s.finish = {
          totalTime: car.finishTime,
          lapTimes: car.lapTimes.slice(),
          bestLapIndex: bi,
          position: car.finishPosition,
          count: this.cars.size,
          bestLap: this.best,
          newRecord: car.newRecord,
        };
      }
    } else {
      s.finish = null;
    }
  }

  private need(id?: string): Car {
    const key = id ?? this.playerId;
    const car = key === null ? undefined : this.cars.get(key);
    if (!car) throw new Error(`RaceState: unknown car "${String(key)}" — call addCar() or update() first`);
    return car;
  }

  private emit(event: RaceEvent): void {
    this.config.onEvent?.(event);
  }
}

function isSampleArray(v: CarSample | readonly CarSample[]): v is readonly CarSample[] {
  return Array.isArray(v);
}

/** Finished cars lead in finishing order; the rest by furthest valid progress
 * (monotonic, so a spin or a reverse does not shuffle the order). */
function ahead(a: Car, b: Car): boolean {
  if (a.finished !== b.finished) return a.finished;
  if (a.finished) return a.finishPosition < b.finishPosition;
  if (a.validDist !== b.validDist) return a.validDist > b.validDist;
  return a.order < b.order;
}

function copyHit(from: TrackHit, to: TrackHit): void {
  to.segment = from.segment;
  to.t = from.t;
  to.s = from.s;
  to.x = from.x;
  to.z = from.z;
  to.tx = from.tx;
  to.tz = from.tz;
  to.lateral = from.lateral;
  to.distance = from.distance;
}

function createCar(id: string, order: number, laps: number): Car {
  return {
    id,
    order,
    located: false,
    resync: false,
    startS: null,
    s: 0,
    dist: 0,
    credit: 0,
    lostTravel: 0,
    allowance: GAIN_BUCKET,
    validDist: 0,
    lateral: 0,
    distance: 0,
    tx: 0,
    tz: 1,
    lost: false,
    onCourse: true,
    reacquireT: 0,
    hasPrev: false,
    prevX: 0,
    prevZ: 0,
    along: 0,
    crossT: NaN,
    wrongWay: false,
    wrongT: 0,
    rightT: 0,
    flipT: 0,
    strandT: 0,
    graceT: 0,
    needsReset: null,
    lapsDone: 0,
    lapStart: 0,
    lapTimes: [],
    lastLap: null,
    finished: false,
    finishTime: 0,
    finishPosition: 0,
    left: false,
    newRecord: false,
    speedKmh: 0,
    flash: null,
    position: order + 1,
    snapshot: {
      phase: 'countdown',
      countdown: null,
      inputLocked: true,
      raceTime: 0,
      speedKmh: 0,
      bar: 0,
      lap: 1,
      laps,
      lapTime: 0,
      lastLap: null,
      bestLap: null,
      position: order + 1,
      count: 1,
      wrongWay: false,
      offTrack: false,
      lapProgress: 0,
      needsReset: null,
      flash: null,
      finish: null,
    },
  };
}

function resetCar(car: Car): void {
  car.located = false;
  car.resync = false;
  car.lostTravel = 0;
  car.allowance = GAIN_BUCKET;
  car.hasPrev = false;
  car.lost = false;
  car.onCourse = true;
  car.reacquireT = 0;
  car.along = 0;
  car.crossT = NaN;
  car.wrongWay = false;
  car.wrongT = 0;
  car.rightT = 0;
  car.flipT = 0;
  car.strandT = 0;
  car.graceT = 0;
  car.needsReset = null;
  car.lapsDone = 0;
  car.lapStart = 0;
  car.lapTimes = [];
  car.lastLap = null;
  car.finished = false;
  car.finishTime = 0;
  car.finishPosition = 0;
  car.newRecord = false;
  car.flash = null;
  car.snapshot.finish = null;
}

// ───────────────────────────── formatting ─────────────────────────────

/** "LAP 2 / 3", or "LAP 2" for an endless run. */
export function lapLabel(lap: number, laps: number): string {
  return Number.isFinite(laps) ? `LAP ${lap} / ${laps}` : `LAP ${lap}`;
}

/** m:ss.cc — shared by every renderer so the DOM HUD and a future XR panel
 * cannot disagree on a hundredth. Truncates like a stopwatch (never shows a
 * time that has not been reached yet) and, like one, stops at 99:59.99: a
 * renderer can rely on at most 8 glyphs (7 below ten minutes). */
export function formatLapTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '-:--.--';
  const cs = Math.min(599999, Math.max(0, Math.floor(seconds * 100 + 1e-6)));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${m}:${s < 10 ? '0' : ''}${s}.${c < 10 ? '0' : ''}${c}`;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
