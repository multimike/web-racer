import type { ViewMode } from './contracts/camera';
import type { PropClass, QualityName, QualitySettings } from './contracts/quality';
import type { WorldData } from './contracts/world';
import { natureClass } from '../world/catalog';
import type { GameOptions } from './options';

/**
 * Quality presets. `high` is the desktop preset (its numbers are also every
 * render module's own defaults); `quest` is what the Quest 3 browser gets by
 * default. The measured cost of each, per view, is the Performance table of
 * CLAUDE.md.
 */
export const QUALITY: Record<QualityName, QualitySettings> = {
  high: {
    name: 'high',
    shadowQuality: 2048,
    shadowTaps: 9,
    hardwareScaling: 1,
    groundTextureSize: 512,
    terrainChunks: 4,
    nearRadius: 46,
    buildingRadius: 90,
    variantLimit: { tree: 4, bush: 3, lowPlant: 2, largeRock: 3, smallRock: 2, dressing: 4, building: 3 },
    farTriangles: { tree: 72, bush: 24, lowPlant: 12, largeRock: 36, smallRock: 8, dressing: 40, building: 900 },
    scatterDensity: 1,
    shadowCasters: ['tree', 'largeRock', 'dressing', 'building'],
    carLodDistances: [14, 45],
    carLiteRatio: 0.12,
    rivalDust: true,
  },
  quest: {
    name: 'quest',
    shadowQuality: 1024,
    shadowTaps: 4,
    hardwareScaling: 1,
    // 512 like `high` (was 256): the "toothed shadow edge" on the foreground
    // paving of the quest grid is the
    // cobble outlines of the 256 px ground texture, magnified — not a shadow
    // (a smaller shadow region and 9 PCF taps both left it unchanged in
    // pictures). Texture memory only: no draw call, no triangle.
    groundTextureSize: 512,
    terrainChunks: 4,
    nearRadius: 32,
    buildingRadius: 60,
    variantLimit: { tree: 2, bush: 2, lowPlant: 1, largeRock: 2, smallRock: 1, dressing: 2, building: 3 },
    farTriangles: { tree: 48, bush: 16, lowPlant: 8, largeRock: 24, smallRock: 6, dressing: 24, building: 600 },
    scatterDensity: 0.5,
    shadowCasters: ['tree', 'largeRock', 'building'],
    carLodDistances: [8, 25],
    carLiteRatio: 0.1,
    // No rival dust in CHASE (the plume of every car ahead veils the road).
    // The game still gives rivals a short rear-wheel plume in high and xr
    // (the diorama is the view Quest ships; +3 draw calls).
    rivalDust: false,
  },
};

/**
 * Render resolution, device pixels per CSS pixel (the game sets the engine's
 * hardware scaling to `hardwareScaling / ratio`):
 *  - `?dpr=` forces a value (and switches the automatic step-down off);
 *  - `quest`: 1 (the headset's own resolution is set by WebXR, not this);
 *  - `high`: min(devicePixelRatio, 2) — a ratio-2 laptop display renders at
 *    its native resolution instead of a soft upscale; the game steps down
 *    through DPR_STEPS when the frame rate cannot hold it.
 */
export function renderRatio(quality: Pick<QualitySettings, 'name'>, forced: number | null, deviceRatio: number): number {
  if (forced !== null) return forced;
  if (quality.name === 'quest') return 1;
  return Math.min(Math.max(Number.isFinite(deviceRatio) ? deviceRatio : 1, 1), 2);
}

/** The ratios the automatic step-down goes through. A step is kept only
 * when it pays (see DprGovernor); a failed trial returns to the ratio it
 * started from, and nothing ever goes above the starting ratio. */
export const DPR_STEPS: readonly number[] = [2, 1.5, 1];

/**
 * When to step the render resolution down, measured against what THIS
 * display delivers rather than a fixed 50 fps: a browser that paces frames
 * at 30 Hz (a 30 Hz monitor, a battery saver) reads 30 fps however idle the
 * GPU is, and a fixed threshold dropped such a machine to ratio 1 for good.
 *
 *  - frame time is smoothed (time constant `SMOOTH_TAU`), so one slow or
 *    one early frame moves nothing;
 *  - an ISOLATED frame longer than `MAX_FRAME` is a pause, not a rate (a
 *    hidden tab — Babylon hands over the whole gap as one frame — a
 *    breakpoint, a long GC or compile): it is left out of the smoothing and
 *    the wall clock and starts a settle time (which freezes, but does not
 *    clear, the low-rate timer, so a slow machine with a hitch every few
 *    seconds still steps). A long frame that FOLLOWS a long frame is a rate
 *    sample: a machine running at 3 fps is slow, not paused — unless it is
 *    longer than `PAUSE_GAP` s, which is always a pause (a hitch straight
 *    followed by hidden time is not 0 fps);
 *  - the CEILING is the best smoothed rate seen, after a short warm-up
 *    (shader compiles, the first shadow map) — the display's refresh rate
 *    on any machine that can hold it for half a second;
 *  - after `ESTIMATE_SECONDS` of wall time, LOW TIME is counted: it grows
 *    by every frame whose smoothed rate is under `LOW_SHARE` × the ceiling
 *    and shrinks by every frame that is not (never under 0), so a rate that
 *    is low MORE THAN HALF of the time builds up even when it never stays
 *    low for `LOW_SECONDS` in one run (slow 2.2 s of every 3.2 s). At
 *    `LOW_SECONDS` of low time the ratio steps down one DPR_STEPS ratio;
 *  - a pause that comes within `PAUSE_GAP` s of wall time of the previous
 *    pause starts no new settle: hitches every second are part of how this
 *    machine runs, and a settle restarted by each of them never ended (the
 *    governor judged nothing);
 *  - EVERY step is a trial: after a settle, the rate at the lower ratio
 *    must be at least `TRIAL_GAIN` × the rate before the step. Under vsync a
 *    gain may only show one step further down (31 ms at ratio 2 and 17 ms at
 *    1.5 both present at 30 fps, 8 ms at 1 presents at 60), so a trial that
 *    shows no gain continues to the next ratio before it gives up. A trial
 *    that gives up returns to the ratio it started from, and the rate before
 *    the step becomes the ceiling (resolution is not what limits this
 *    machine: a CPU-bound frame, a browser cap that arrived mid-session). A
 *    later rise of the rate raises the ceiling again;
 *  - EVERY gain is checked back at the trial's own ratio: a slow spell
 *    that simply ENDS during the trial looks like a gain (a CPU-bound dip of
 *    2.5–5.5 s used to leave ratio 1.5 for the rest of the session, as
 *    nothing ever steps back up). If the old ratio is still `TRIAL_GAIN` ×
 *    slower than the gain, the trial goes down to the gain's ratio once more
 *    and keeps it only if the gain still shows against that verify rate (a
 *    CPU-bound load that changes every few seconds fakes one comparison
 *    often, two rarely). Any other outcome is a failed trial (back to the
 *    old ratio, with the retry wait below). A kept step therefore costs
 *    three ratio changes over ~7.5 s (down, back, down). A gain within
 *    `CHAIN_SECONDS` of a kept step that did NOT cure the fall (the rate
 *    there still under `LOW_SHARE` × the ceiling, or under `TRIAL_BELOW`)
 *    is the next step of the same fall and is kept without another
 *    check-back. A step that cured the fall opens no chain, so a CPU-bound
 *    dip in the next 20 s gets the full check-back (it used to be kept and
 *    left ratio 1 for the session). Changes per fall: four when both steps
 *    pay within 20 s (2 → 1.5 → 2 → 1.5 → 1), five when the next step
 *    shows no gain, six when the second step comes later, and up to eight
 *    in 20 s while the load is still rising (each stage cured, then the
 *    load rises again and gets a full check-back);
 *  - after a failed trial, a dip to about the rate that failed
 *    (≥ `RETRY_SHARE` × it) makes no new trial for `RETRY_SECONDS`, and the
 *    wait doubles on every further failure: a machine whose frame is
 *    CPU-bound in the heavy part of the track does not go soft and sharp
 *    again once a lap. A deeper fall (under that share) is a new limit and
 *    is tried at once; a GPU that falls to exactly the failed rate is only
 *    tried after the wait (indistinguishable from the CPU-bound dip without
 *    a trial);
 *  - a ceiling under `TRIAL_BELOW` fps is ambiguous: a capped display, or a
 *    GPU that never kept up at this ratio from the first frame. At
 *    `PROBE_SECONDS` one trial is made without waiting for a drop (a 30 Hz
 *    display costs one ~5 s dip in sharpness: 1.5, then 1, then back). The
 *    line is 49, not 50: a 50 Hz display reads a ceiling of 49.99 and is not
 *    ambiguous, and a GPU at a third of 144 Hz (48.0) still is. A CPU-bound warm-up longer than `PROBE_SECONDS` makes that
 *    trial fail (the verify sees the warm-up end) and stays at the starting
 *    ratio. A kept gain that still leaves the rate under `TRIAL_BELOW` is
 *    followed by one more (45 ms at ratio 2 is 30 fps at 1.5 and 60 at 1).
 *
 * KNOWN LIMITS. Nothing ever steps back UP, so the governor keeps a step
 * only on evidence it can check at once, and some loads are judged wrong
 * for the rest of the session (each pinned by a KNOWN LIMIT probe case):
 *  - a GPU-bound section shorter than ~8 s a lap (3 s to notice + 2.5 s at
 *    the lower ratio + 2.5 s back) is NOT stepped down: the check-back sees
 *    the section end. Before the check-back such sections mostly stepped,
 *    by the same mechanism that left a CPU-bound dip at 1.5 for good;
 *  - a failed trial makes the rate before the step the ceiling, so a GPU
 *    fall to about that rate later in the session is only tried after the
 *    doubled retry wait, or never (a machine with frequent CPU-bound dips
 *    and a GPU fall can stay at the starting ratio);
 *  - two CPU-bound dips a few seconds apart can fake both comparisons
 *    (3 s, 3 s gap, 3 s ends at 1.5), and a long CPU-bound dip whose frame
 *    sits just over a vsync multiple gains for real while it lasts: both
 *    keep the lower ratio after the load is gone;
 *  - ratio changes per session: every trial costs 2–4 changes and the
 *    retry wait doubles (120, 240, 480 s …), so a lap-like CPU-bound load
 *    makes more than 4 changes in its first 10 minutes. It converges; it
 *    does not oscillate without end;
 *  - a load that keeps rising (a thermal sink: GPU cost growing over tens
 *    of seconds to minutes) makes a full check-back at every stage, so it
 *    can make 6–8 changes within 20–30 s and more than 4 in 10 minutes. It
 *    converges to the ratio the final load needs.
 *
 * Plain numbers, no Babylon. The mock-clock probe that drives it (pause,
 * CPU-bound, cap, vsync-bucket, dip and alternating-load cases, each with an
 * expected end ratio and trial count) is `tools/node/dpr-probe.ts`:
 * `node --import ./tools/node/register.mjs tools/node/dpr-probe.ts`.
 */
export class DprGovernor {
  static readonly SMOOTH_TAU = 0.5;
  static readonly MAX_FRAME = 0.25;
  static readonly WARMUP_SECONDS = 1;
  static readonly ESTIMATE_SECONDS = 4;
  static readonly PROBE_SECONDS = 7;
  static readonly LOW_SHARE = 0.8;
  static readonly LOW_SECONDS = 3;
  static readonly SETTLE_SECONDS = 1;
  static readonly TRIAL_BELOW = 49;
  static readonly TRIAL_GAIN = 1.15;
  static readonly TRIAL_SECONDS = 1.5;
  static readonly RETRY_SHARE = 0.85;
  static readonly RETRY_SECONDS = 120;
  static readonly CHAIN_SECONDS = 20;
  static readonly PAUSE_GAP = 2;
  /** Current ratio (device pixels per CSS pixel). */
  ratio: number;
  /** Best sustained frame rate seen, fps (0 until the warm-up is over). */
  ceiling = 0;
  /** Smoothed frame rate, fps. */
  fps = 0;
  /** Trials made so far (for probes and the console). */
  trials = 0;
  private wall = 0;
  private lowFor = 0;
  private settle = 0;
  private meanDt = 0;
  /** Long frames in a row: the first two are pauses (a hitch, then hidden time). */
  private longRun = 0;
  /** The ambiguous-ceiling trial has been made. */
  private probed = false;
  /** A step is being judged. */
  private trial = false;
  private trialFrom = 0;
  private trialFps = 0;
  private trialFor = 0;
  /** Checking a gain back at the trial's own ratio. */
  private verify = false;
  private keptRatio = 0;
  /** Rate at the lower ratio that showed the gain, fps. */
  private gainFps = 0;
  /** Going down once more after a verify that kept the gain. */
  private confirm = false;
  /** Rate measured by the verify at the old ratio, fps. */
  private verifyFps = 0;
  /** Wall time of the last step that was verified and kept (−∞: none). */
  private keptAt = -Infinity;
  /** Wall time of the last pause (−∞: none yet). */
  private lastPause = -Infinity;
  /** Rate at which the last trial failed, fps (0: none failed). */
  private failedFps = 0;
  /** Wall time before which a dip near `failedFps` makes no trial. */
  private retryAt = 0;
  private retryWait = DprGovernor.RETRY_SECONDS;

  constructor(ratio: number) {
    this.ratio = ratio;
  }

  /** Feed one presented frame's wall interval, s. Returns true when the
   * ratio was just changed (read `ratio`). */
  frame(dt: number): boolean {
    if (!(dt > 0) || !Number.isFinite(dt)) return false;
    if (dt > DprGovernor.MAX_FRAME) {
      const pause = this.longRun < 2 || dt > DprGovernor.PAUSE_GAP;
      this.longRun++;
      if (pause) {
        // A pause, not a rate: judge nothing across it (unless pauses come
        // so often that they are how this machine runs).
        const repeated = this.wall - this.lastPause < DprGovernor.PAUSE_GAP;
        this.lastPause = this.wall;
        if (this.wall >= DprGovernor.WARMUP_SECONDS && !repeated) this.settle = Math.max(this.settle, DprGovernor.SETTLE_SECONDS);
        return false;
      }
    } else {
      this.longRun = 0;
    }
    this.wall += dt;
    const k = 1 - Math.exp(-dt / DprGovernor.SMOOTH_TAU);
    this.meanDt = this.meanDt > 0 ? this.meanDt + (dt - this.meanDt) * k : dt;
    this.fps = 1 / this.meanDt;
    if (this.wall < DprGovernor.WARMUP_SECONDS) return false;
    if (!this.trial && this.fps > this.ceiling) this.ceiling = this.fps;
    if (this.wall < DprGovernor.ESTIMATE_SECONDS) return false;
    if (this.settle > 0) {
      this.settle -= dt;
      return false;
    }
    if (this.trial) {
      this.trialFor += dt;
      if (this.trialFor < DprGovernor.TRIAL_SECONDS) return false;
      if (this.confirm) {
        // Down at the gain's ratio once more: the gain must still show
        // against the rate just measured at the old ratio.
        this.trial = false;
        this.confirm = false;
        if (this.fps >= DprGovernor.TRIAL_GAIN * this.verifyFps) {
          this.failedFps = 0;
          this.lowFor = 0;
          this.ceiling = Math.max(this.ceiling, this.fps);
          this.keptAt = this.chainOpen() ? this.wall : -Infinity;
          // Still under the ambiguous line: one more step may pay (vsync).
          if (this.fps < DprGovernor.TRIAL_BELOW) this.probed = false;
          return false;
        }
        this.ratio = this.trialFrom;
        this.fail();
        return true;
      }
      if (this.verify) {
        // Back at the trial's own ratio: did the gain come from resolution?
        this.verify = false;
        if (this.fps * DprGovernor.TRIAL_GAIN <= this.gainFps) {
          // Still slow here: go down again to confirm (a load that changes
          // every few seconds can fake one comparison, rarely two).
          this.confirm = true;
          this.verifyFps = this.fps;
          this.ratio = this.keptRatio;
          this.trialFor = 0;
          this.settle = DprGovernor.SETTLE_SECONDS;
          return true;
        }
        // The load changed during the trial: it showed nothing.
        this.trial = false;
        this.fail();
        return false;
      }
      if (this.fps >= DprGovernor.TRIAL_GAIN * this.trialFps) {
        if (this.wall - this.keptAt < DprGovernor.CHAIN_SECONDS) {
          // The next step of a fall whose first step was just verified:
          // keep it without another check-back.
          this.trial = false;
          this.failedFps = 0;
          this.lowFor = 0;
          this.ceiling = Math.max(this.ceiling, this.fps);
          this.keptAt = this.chainOpen() ? this.wall : -Infinity;
          if (this.fps < DprGovernor.TRIAL_BELOW) this.probed = false;
          return false;
        }
        // A gain, or a slow spell that just ended: check once at the ratio
        // the trial started from.
        this.verify = true;
        this.gainFps = this.fps;
        this.keptRatio = this.ratio;
        this.ratio = this.trialFrom;
        this.trialFor = 0;
        this.settle = DprGovernor.SETTLE_SECONDS;
        return true;
      }
      if (this.ratio > 1) {
        // No gain yet: under vsync it may show one step further down.
        this.ratio = this.lower(this.ratio);
        this.trialFor = 0;
        this.settle = DprGovernor.SETTLE_SECONDS;
        return true;
      }
      // No gain at all: something else than resolution sets the rate.
      this.trial = false;
      this.ratio = this.trialFrom;
      this.fail();
      return true;
    }
    if (this.ratio <= 1) return false;
    if (!this.probed && this.ceiling < DprGovernor.TRIAL_BELOW) {
      if (this.wall < DprGovernor.PROBE_SECONDS) return false;
      this.probed = true;
      return this.step();
    }
    this.lowFor = this.fps < DprGovernor.LOW_SHARE * this.ceiling ? this.lowFor + dt : Math.max(0, this.lowFor - dt);
    if (this.lowFor < DprGovernor.LOW_SECONDS) return false;
    if (this.failedFps > 0 && this.wall < this.retryAt && this.fps >= DprGovernor.RETRY_SHARE * this.failedFps) return false;
    return this.step();
  }

  /** After a kept step: is the fall still not cured (the rate still low
   * against the ceiling, or under the ambiguous line)? Only then may the
   * next step of the same fall skip the check-back. */
  private chainOpen(): boolean {
    return this.fps < DprGovernor.LOW_SHARE * this.ceiling || this.fps < DprGovernor.TRIAL_BELOW;
  }

  /** A trial that showed no gain from resolution: remember the rate and
   * back off further trials near it. */
  private fail(): void {
    this.ceiling = this.trialFps;
    this.failedFps = this.trialFps;
    this.retryAt = this.wall + this.retryWait;
    this.retryWait *= 2;
    // A failed step ends the fall's chain: a dip after it gets the full check-back.
    this.keptAt = -Infinity;
    this.lowFor = 0;
    this.settle = DprGovernor.SETTLE_SECONDS;
  }

  private lower(ratio: number): number {
    return DPR_STEPS.find((r) => r < ratio - 1e-6) ?? 1;
  }

  private step(): boolean {
    this.lowFor = 0;
    this.probed = true;
    this.trial = true;
    this.trials++;
    this.trialFrom = this.ratio;
    this.trialFps = this.fps;
    this.trialFor = 0;
    this.settle = DprGovernor.SETTLE_SECONDS;
    this.ratio = this.lower(this.ratio);
    return true;
  }
}

/**
 * Quest diorama budget on heavy worlds. The far tier draws EVERY placement
 * it holds in the diorama, so the quest + xr frame grows with the world's
 * tree and plant count (gate 420,000 triangles; seeds 1, 6, 7, 16 measure
 * 402–414k, the heaviest seeds 417–422k at the preset's density). On a
 * heavy world the collider-less scatter (bushes, low plants, small rocks —
 * nothing with a collider, nothing that casts) is thinned below the
 * preset's 0.5, just enough to bring the ESTIMATE to `QUEST_FRAME_TARGET`.
 * The density hash keeps a SUBSET of what 0.5 keeps, so a thinned world
 * only loses specks (3–5 px each in the diorama).
 *
 * The estimate is made from the plan, for any seed, at boot:
 *   offset + road × track length
 *   + Σ far placements × the preset's far triangles per class
 *     (trees at 46 / 48 of the target: the far pines simplify to 44–48),
 *   + the same again for the classes that cast (shadow pass),
 *   buildings at 600 × a per-asset factor.
 * `QUEST_ESTIMATE` was fitted to 17 quest + xr
 * report runs on seeds 1–567: residual −1.4k … +2.2k (leave-one-out
 * −1.5k … +2.4k). The target leaves that margin under 415,000. Any change
 * to the planner, the far models or the far triangle targets moves the
 * fit, and nothing notices a stale one: after such a change re-measure a
 * few heavy seeds (147, 430, 567, 1128, 1300) with `quality=quest&view=xr
 * &report=1` and re-fit if a frame passes 415,000.
 */
export const QUEST_ESTIMATE = {
  offset: 194_060,
  /** Triangles per metre of track (road ribbon, kerbs, verges). */
  road: 26.43,
  treeFill: 46 / 48,
  buildingFactor: { 'b07-race-garage': 2.25, 'b05-terrace-house': 1.5, 'b04-gable-cottage': 1.5 } as Readonly<Record<string, number>>,
};
/** What the quest + xr frame is thinned to, estimated triangles. */
export const QUEST_FRAME_TARGET = 412_500;

/** The density hash of the world props (src/render/scatter/worldProps.ts,
 * `hash01` — keep the two identical): index in `plan.nature` → [0, 1); a
 * thinned-class placement is drawn when its hash is below the density. */
export function scatterHash01(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const NATURE_PROP_CLASS: Record<string, PropClass> = {
  trees: 'tree',
  bushes: 'bush',
  lowPlants: 'lowPlant',
  largeRocks: 'largeRock',
  smallRocks: 'smallRock',
};
const THINNED_CLASSES = new Set<PropClass>(['bush', 'lowPlant', 'smallRock']);

export interface QuestBudget {
  /** Estimated quest + xr frame at the preset's density, triangles. */
  estimate: number;
  /** ... and at the returned density. */
  thinned: number;
  /** Density to use (≤ the preset's). */
  density: number;
}

/** Plan-only estimate of the quest + xr frame and the density that keeps it
 * at `QUEST_FRAME_TARGET`. Babylon-free. */
export function questBudget(quality: QualitySettings, data: Pick<WorldData, 'plan' | 'track'>, target = QUEST_FRAME_TARGET): QuestBudget {
  const far = quality.farTriangles;
  const casters = new Set<PropClass>(quality.shadowCasters);
  const passes = (c: PropClass): number => (casters.has(c) ? 2 : 1);
  const base = quality.scatterDensity;
  let fixed = QUEST_ESTIMATE.offset + QUEST_ESTIMATE.road * (data.track.points.length / 2);
  const thin: { h: number; tris: number }[] = [];
  const nature = data.plan.nature;
  for (let i = 0; i < nature.length; i++) {
    const nc = natureClass(nature[i].asset);
    const c = nc ? NATURE_PROP_CLASS[nc] : undefined;
    if (!c) continue;
    const tris = far[c] * passes(c) * (c === 'tree' ? QUEST_ESTIMATE.treeFill : 1);
    if (THINNED_CLASSES.has(c)) {
      const h = scatterHash01(i);
      if (h < base) thin.push({ h, tris });
    } else fixed += tris;
  }
  for (const l of data.plan.lots) fixed += far.building * (QUEST_ESTIMATE.buildingFactor[l.asset] ?? 1) * passes('building');
  fixed += data.plan.dressing.length * far.dressing * passes('dressing');
  let total = fixed;
  for (const t of thin) total += t.tris;
  const estimate = Math.round(total);
  if (total <= target) return { estimate, thinned: estimate, density: base };
  // Drop the highest hashes first: what stays is a subset of what `base` kept.
  thin.sort((x, y) => x.h - y.h);
  let density = base;
  for (let k = thin.length - 1; k >= 0 && total > target; k--) {
    total -= thin[k].tris;
    density = thin[k].h;
  }
  return { estimate, thinned: Math.round(total), density };
}

/** The preset of `options.quality` with the `?shadows=` override applied (a
 * fresh object: callers may keep it). The quest scatter cap is NOT applied
 * here (it needs the world plan): the boot asks `worldScatterDensity`. */
export function pickQuality(options: GameOptions): QualitySettings {
  const base = QUALITY[options.quality] ?? QUALITY.high;
  return {
    ...base,
    shadowQuality: options.shadows ?? base.shadowQuality,
    variantLimit: { ...base.variantLimit },
    farTriangles: { ...base.farTriangles },
    shadowCasters: [...base.shadowCasters],
    carLodDistances: [base.carLodDistances[0], base.carLodDistances[1]],
  };
}

/** `scatterDensity` for this world, any seed: the quest budget on quest
 * (never above the preset's), the preset's otherwise. The boot of
 * `createScene.ts` passes it to the world props. */
export function worldScatterDensity(quality: QualitySettings, data: Pick<WorldData, 'plan' | 'track'>): number {
  return quality.name === 'quest' ? Math.min(quality.scatterDensity, questBudget(quality, data).density) : quality.scatterDensity;
}

/**
 * Near-ring layout per camera view — the levers that need no new code: the near tier is NOT frustum-culled, so its radius and centre decide
 * what the full meshes cost wherever the camera looks.
 *
 *  radius / buildingRadius  factor on the preset's radii;
 *  ahead                    the ring centre moves this many radii ahead of
 *                           the car along the view direction (chase: the
 *                           full meshes go where the camera looks).
 */
export interface RingLayout {
  radius: number;
  buildingRadius: number;
  ahead: number;
}

export const RING_LAYOUT: Record<QualityName, Record<ViewMode, RingLayout>> = {
  // Desktop: the same 46 m / 90 m rings, centred 0.45 radii (20.7 m) ahead
  // along the view instead of on the car (half the ring lay behind the chase
  // camera). Ring probe, seeds 1 / 6 / 7 / 12 / 23 round whole laps:
  // chase — simplified buildings in the frame within 80 m ahead 0.03 → 0 per
  // pose; high (the new, wider high frame) — frame ground outside the near
  // ring 3.2 % → 0 %; near placements about the same (1,245 → 1,216).
  high: {
    chase: { radius: 1, buildingRadius: 1, ahead: 0.45 },
    high: { radius: 1, buildingRadius: 1, ahead: 0.45 },
    xr: { radius: 1, buildingRadius: 1, ahead: 0 },
  },
  // Quest car's-eye views: the ring levers, measured. The ring is a circle round a point AHEAD of the car along the
  // view, sized so the simplified far tier never shows near the eye
  // (geometry on flat ground, CAMERA_TUNING at 16:9):
  //  chase 27.2 m centred 0.5 radii (13.6 m) ahead: every ground point in
  //    the frame within 40 m of the eye is inside the ring (the first
  //    simplified tree stands ≥ 41 m from the eye; trees are tall, so a
  //    margin matters). The round-1 ring (24 m, 0.4 ahead) reached only
  //    35 m: its far-tier pines and oaks read as tents and wedges beside
  //    full-detail palms 25–40 m ahead.
  //  The BUILDING ring shares the near ring's centre (PropsView has one
  //    centre), so it reaches ahead by its own radius: 66 m (1.1 × 60)
  //    centred 13.6 m ahead keeps simplified buildings out of the chase
  //    frame's first ~80 m (ring probe round whole laps: 0.69 → 0.24
  //    per pose; the start straight of the default seed: none). At 51 m the
  //    race garage at the end of the start straight was a crumpled lump.
  //  high: the high camera sees much more ground (the car is 9–10 %
  //    of the frame width instead of 15 %): the frame's top edge meets the
  //    ground ~43 m ahead and ±41 m across. 38.4 m (1.2 × 32) centred 0.6
  //    radii (23 m) ahead leaves 0.5 % of that ground to the far tier (the
  //    old 27.2 m ring: 11.8 %, the top corners).
  quest: {
    chase: { radius: 0.85, buildingRadius: 1.1, ahead: 0.5 },
    high: { radius: 1.2, buildingRadius: 1, ahead: 0.6 },
    xr: { radius: 1, buildingRadius: 1, ahead: 0 },
  },
};

/** Time constant of the view direction the ring centre is pushed along, s:
 * a drift (35° camera pull), a spin or the high camera's yaw lag must not
 * swing the ring edge — and the trees on it — across tiers every frame. */
export const RING_DIR_TAU = 0.6;

/** xr: the near tier is on only while the eye is closer than this to its
 * focus (70 m = 1.4 m at the ×50 diorama scale), m. */
export const XR_NEAR_DISTANCE = 70;
