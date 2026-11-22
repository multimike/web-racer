import { Matrix, Mesh, Quaternion, Vector3, VertexData } from '@babylonjs/core';
import type { PhysicsBody, Scene } from '@babylonjs/core';
import { instantiateProp, prepareProp } from '../../assets/assemble';
import { loadAsset } from '../../assets/registry';
import type { ColliderSpec, PropAsset } from '../../assets/types';
import type { CreateWorldProps, PropsView, WorldProps, WorldPropsOptions, WorldPropsStats } from '../../game/contracts/props';
import type { PropClass } from '../../game/contracts/quality';
import type { WorldData } from '../../game/contracts/world';
import { getLook } from '../../gfx/look/lighting';
import type { SolidVertexData } from '../../gfx/solid/SolidMesh';
import { createGroundQuery } from '../../terrain/groundQuery';
import { natureClass } from '../../world/catalog';
import { buildColliders } from './colliders';
import type { BuiltColliders, ColliderGroup, ColliderItem } from './colliders';
import { createFarMaterial, ringInside } from './farMaterial';
import type { FarMaterial } from './farMaterial';
import { farModel } from './farModel';
import type { FarModel } from './farModel';
import type { SimplifyMethod } from './simplify';

/**
 * World props (contract: src/game/contracts/props.ts) — everything the world
 * plan places, drawn in two thin-instance tiers around a moving focus.
 *
 * NEAR: one thin-instance mesh per (asset, variant, scheme) with the full
 *   asset mesh, holding only the placements inside the ring. Its three
 *   instance buffers are preallocated for every placement of the batch and
 *   rewritten (front of the buffer, count set) when the focus has moved
 *   `refreshStep` metres; a 16 m grid over the world finds the candidates.
 * FAR: one thin-instance mesh per (asset, variant, scheme) — the SAME
 *   variant the near tier draws, so nothing changes shape, colour or size at
 *   the ring — of the far model (`farModel`: the asset's designed far model,
 *   else the simplified near mesh), ALL placements, static buffers; the far
 *   shader drops the instances inside the ring. Buildings and the dressing
 *   (each a few dozen placements of many different models) are instead
 *   MERGED in world space, one static mesh each, with a per-vertex origin
 *   (and tint / AO) for the same test: one draw call for ~300 fence
 *   segments, banners and tyre stacks of every variant.
 * The ring the far shaders test and the ring the near tier was filled with
 * are the same float32 numbers (`FarMaterial.ring`), and both sides test
 * `dx² + dz² < r²` in float32 — so every placement is drawn by exactly one
 * tier.
 *
 * Shadow casters: near meshes of `shadowCasters` OR (view.farShadows) the far
 * meshes of trees, large rocks and the merged buildings — never both, the
 * depth pass does not know the ring. Permanently near batches (no far twin)
 * cast in both modes.
 *
 * Permanently near (no far mesh, radius treated as infinite): the start
 * gantry and every dressing asset with a single placement in the plan.
 */

const CLASSES: readonly PropClass[] = ['tree', 'bush', 'lowPlant', 'largeRock', 'smallRock', 'dressing', 'building'];
const CLS: Record<PropClass, number> = { tree: 0, bush: 1, lowPlant: 2, largeRock: 3, smallRock: 4, dressing: 5, building: 6 };

const DEFAULT_VARIANTS: Record<PropClass, number> = { tree: 4, bush: 3, lowPlant: 2, largeRock: 3, smallRock: 2, dressing: 4, building: 3 };
/**
 * The variant every COLLIDER uses: `seed % COLLIDER_VARIANTS[class]`, fixed
 * and independent of the quality preset, so the physics world is identical
 * on every device. Equal to the `high` preset's variant limits:
 * there the near tier draws exactly the variant that collides. A preset
 * with fewer variants (quest) draws `seed % variantLimit` — except the
 * props whose colliders differ by variant (DRAW_AS_COLLIDER_*), which are
 * drawn as their collider variant everywhere; what is left differs by
 * < 0.3 m (tree trunks, tyre stacks).
 */
export const COLLIDER_VARIANTS: Readonly<Record<PropClass, number>> = DEFAULT_VARIANTS;
/**
 * Props whose variants differ in shape AND collider by more than a few
 * decimetres (large rocks: mirrored lobes, up to 1.2 m; chevron boards 1.56
 * against 2.2 m): on EVERY preset they are drawn as the variant that
 * collides, `seed % COLLIDER_VARIANTS` — whatever the preset's
 * `variantLimit` — and their far tier keeps one mesh per variant, so what a
 * car hits is what it sees, in both tiers. Measured on seeds 1–200 (plans
 * only): quest gains 0–3 near batches (max active 73 at 20 focus points,
 * was 70) and 3 far batches (max 43); high is unchanged for rocks.
 * Everything else (trees, tyres, dressing) differs by < 0.3 m between
 * variants and follows the preset.
 */
const DRAW_AS_COLLIDER_CLASSES = new Set<number>([CLS.largeRock]);
const DRAW_AS_COLLIDER_ASSETS = new Set<string>(['d02-chevron-sign']);
/**
 * Buildings that crumple at the preset's far budget get a larger share of
 * the merged far mesh:
 *  - the race garage (2.25 ×): at the quest's 600 triangles its orange
 *    arches, wrench sign and door average away into a striped dome, and it
 *    is the landmark at the end of the start straight (one lot a world);
 *  - the terrace house and the gable cottage (1.5 ×): at 600 the terrace's
 *    railing and pergola shatter into shards and the cottage's walls,
 *    awning and plinth melt; at 900 both read as their building at 40 m.
 *    2–5 lots each a world: about + 2k triangles on quest, paid for by the
 *    far pine's upper tiers (one bough fewer: − 4 a pine, ≈ − 5k a world).
 */
export const FAR_BUILDING_FACTOR: Readonly<Record<string, number>> = { 'b07-race-garage': 2.25, 'b05-terrace-house': 1.5, 'b04-gable-cottage': 1.5 };
export const farBuildingTarget = (assetId: string, base: number): number => Math.round(base * (FAR_BUILDING_FACTOR[assetId] ?? 1));
const DEFAULT_FAR: Record<PropClass, number> = { tree: 72, bush: 24, lowPlant: 12, largeRock: 36, smallRock: 8, dressing: 40, building: 900 };
const DEFAULT_CASTERS: readonly PropClass[] = ['tree', 'largeRock', 'dressing', 'building'];
/** Classes whose far tier is only drawn with `view.farDetail`. */
const DETAIL_ONLY = new Set<number>([CLS.lowPlant, CLS.smallRock]);
/** Classes whose far tier casts with `view.farShadows` (plus the merged buildings). */
const FAR_CASTERS = new Set<number>([CLS.tree, CLS.largeRock]);
/** Collider-less scatter thinned by `scatterDensity`. */
const THINNED = new Set<number>([CLS.bush, CLS.lowPlant, CLS.smallRock]);
/** Long props laid along the ground normal. */
const TILTED = new Set(['d07-wood-fence', 'd12-stone-wall', 'd13-bench', 'd02-chevron-sign', 'd06-kerb-marker']);
const GANTRY = 'd01-start-gantry';
const CELL = 16;

/** Lab-only extras on top of the contract's options. */
export interface WorldPropsLabOptions extends WorldPropsOptions {
  /** Multiply the near tier's instance tints (the lab's `ring=1` view). */
  nearTint?: [number, number, number];
  /** Keep every collider child's world transform (the lab's wireframes). */
  colliderDebug?: boolean;
}

/** One (asset, variant, scheme) the props will prepare, with the far-model
 * targets they will ask for — what the game's boot bakes in workers ahead
 * of time (src/boot). */
export interface PropPrepJob {
  asset: PropAsset;
  seed: number;
  scheme: string | undefined;
  cls: PropClass;
  far: number[];
}

/** Boot extras on top of the contract's options (the game only). */
export interface WorldPropsBootOptions extends WorldPropsOptions {
  /**
   * Called once with every preparation the build is about to do, before it
   * starts; resolves when whatever it could do ahead (bake workers) is in
   * the caches `prepareProp` / `farModel` read. What it leaves out is done
   * here as before.
   */
  prefetch?: (jobs: PropPrepJob[]) => Promise<void>;
}

interface NearBatch {
  asset: PropAsset;
  variant: number;
  scheme: string | undefined;
  cls: number;
  mesh: Mesh;
  triangles: number;
  count: number;
  matrix: Float32Array;
  tint: Float32Array;
  shade: Float32Array;
  /** Item index of every instance written, front of the array. */
  items: Int32Array;
  caster: boolean;
  wind: boolean;
  permanent: boolean;
}

interface FarBatch {
  asset: PropAsset;
  /** The variant the far mesh was simplified from. */
  variant: number;
  scheme: string | undefined;
  cls: number;
  mesh: Mesh;
  triangles: number;
  count: number;
  /** Instances inside the ring at the last refresh (collapsed by the shader). */
  inside: number;
  method: SimplifyMethod;
  silhouette: number;
  boundsError: number;
  target: number;
  /** Fit stretch of a designed far model (1 = none / simplified). */
  stretch: number;
}

/** One far model inside a merged mesh (a lot, or a dressing placement). */
export interface MergedItem {
  assetId: string;
  variant: number;
  scheme: string | undefined;
  method: SimplifyMethod;
  triangles: number;
  target: number;
  silhouette: number;
  boundsError: number;
}

/** What the props lab inspects (not part of the contract). */
export interface WorldPropsInternals {
  count: number;
  /** Float32 world x / z of every placement (exactly what the shaders see). */
  x: Float32Array;
  z: Float32Array;
  cls: Uint8Array;
  /** 1 = drawn (asset loaded, kept by scatterDensity). */
  drawn: Uint8Array;
  /** 1 = always in the near tier. */
  permanent: Uint8Array;
  /** Far batch index (−1: building → merged mesh, or permanent, or not drawn). */
  far: Int32Array;
  assetId: string[];
  near: readonly NearBatch[];
  farBatches: readonly FarBatch[];
  merged: { mesh: Mesh | null; triangles: number; lots: number; inside: number; perLot: MergedItem[] };
  /** The far dressing, merged (props ring): `items` = its placements. */
  mergedDressing: { mesh: Mesh | null; triangles: number; items: number; inside: number; perItem: MergedItem[] };
  /** 1 = this placement's far model is in the merged dressing mesh. */
  farMergedDressing: Uint8Array;
  propsRing: FarMaterial['ring'];
  buildingRing: FarMaterial['ring'];
  permanentAssets: string[];
  skippedAssets: string[];
  colliders: BuiltColliders | null;
  colliderItems: number;
  /** Σ over items with colliders of their asset's collider count. */
  colliderExpected: number;
  /** Collider variant of every placement (computed with or without colliders). */
  colliderVariant: Int32Array;
  /** Variant the near tier draws for every placement. */
  drawVariant: Int32Array;
  /** 1 = drawn as its collider variant on every preset (rocks, chevrons,
   * and the hero pieces: buildings and the permanently near dressing). */
  drawAsCollider: Uint8Array;
  /** Variant of the far model each placement is drawn with in the far tier
   * (−1: none — permanently near, or not drawn). */
  farVariant: Int32Array;
  /** Meshes currently registered as shadow casters by this object. */
  casters: ReadonlySet<Mesh>;
  /** Force the next update to refresh the near tier. */
  invalidate(): void;
}

const INTERNALS = new WeakMap<WorldProps, WorldPropsInternals>();

export function inspectWorldProps(props: WorldProps): WorldPropsInternals | undefined {
  return INTERNALS.get(props);
}

/** Stable hash of an integer to [0, 1). */
function hash01(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Bilinear sample of one channel of `data.shade` (3 floats per sample). */
function sampleShade(data: WorldData, x: number, z: number, ch: number): number {
  const hf = data.heightfield;
  const half = hf.size / 2;
  const n = hf.n;
  const fx = Math.min(Math.max((x + half) / hf.step, 0), n - 1.001);
  const fz = Math.min(Math.max((z + half) / hf.step, 0), n - 1.001);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const s = data.shade;
  const i = (z0 * n + x0) * 3 + ch;
  return (s[i] * (1 - tx) + s[i + 3] * tx) * (1 - tz) + (s[i + n * 3] * (1 - tx) + s[i + n * 3 + 3] * tx) * tz;
}

function meshFromData(name: string, d: SolidVertexData, scene: Scene): Mesh {
  const vd = new VertexData();
  vd.positions = d.positions;
  vd.normals = d.normals;
  vd.colors = d.colors;
  vd.uvs = d.uvs;
  vd.uvs2 = d.uvs2;
  vd.indices = d.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh, false);
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false;
  mesh.isPickable = false;
  return mesh;
}

/** Yield to the browser at most every ~30 ms of work, through a message
 * (a hidden tab throttles timers to one a second; messages are not). */
function makeYield(): () => Promise<void> {
  let last = performance.now();
  return async (): Promise<void> => {
    if (performance.now() - last < 30) return;
    await new Promise<void>((resolve) => {
      if (typeof MessageChannel === 'undefined') {
        setTimeout(resolve);
        return;
      }
      const ch = new MessageChannel();
      ch.port1.onmessage = (): void => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
    last = performance.now();
  };
}

/** Wall time of the phases of the last `createWorldProps`, ms (the boot
 * report reads it; not part of the contract). */
export const lastWorldPropsPhases: Record<string, number> = {};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const createWorldProps: CreateWorldProps = async (scene: Scene, data: WorldData, options: WorldPropsOptions = {}): Promise<WorldProps> => {
  const lab = options as WorldPropsLabOptions;
  const yieldToBrowser = makeYield();
  const variantLimit = { ...DEFAULT_VARIANTS, ...(options.variantLimit ?? {}) };
  const farTris = { ...DEFAULT_FAR, ...(options.farTriangles ?? {}) };
  const density = Math.min(Math.max(options.scatterDensity ?? 1, 0), 1);
  const casterClasses = new Set((options.shadowCasters ?? DEFAULT_CASTERS).map((c) => CLS[c]));
  const refreshStep = options.refreshStep ?? 6;
  const plan = data.plan;
  const ground = createGroundQuery(data);
  const now = (): number => performance.now();
  const timing = { prefetchMs: 0, prepareMs: 0, simplifyMs: 0, meshMs: 0, colliderMs: 0 };
  for (const k of Object.keys(lastWorldPropsPhases)) delete lastWorldPropsPhases[k];
  let phaseT = now();
  const phase = (name: string): void => {
    const t = now();
    lastWorldPropsPhases[name] = t - phaseT;
    phaseT = t;
  };

  // -------------------------------------------------------------------------
  // Placements → items

  interface Src {
    asset: string;
    seed: number;
    scheme: string | undefined;
    x: number;
    y: number;
    z: number;
    yaw: number;
    scale: number;
    tint: readonly number[];
    cls: number;
    /** Index in plan.nature (density hash), −1 otherwise. */
    natureIndex: number;
  }
  const srcs: Src[] = [];
  for (const lot of plan.lots) {
    srcs.push({ asset: lot.asset, seed: lot.seed, scheme: lot.scheme, x: lot.x, y: lot.y, z: lot.z, yaw: lot.yaw, scale: 1, tint: [1, 1, 1], cls: CLS.building, natureIndex: -1 });
  }
  for (const p of plan.dressing) {
    srcs.push({ asset: p.asset, seed: p.seed, scheme: p.scheme, x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale, tint: p.tint, cls: CLS.dressing, natureIndex: -1 });
  }
  const unknownNature = new Set<string>();
  plan.nature.forEach((p, i) => {
    const nc = natureClass(p.asset);
    const cls = nc === 'trees' ? CLS.tree : nc === 'bushes' ? CLS.bush : nc === 'lowPlants' ? CLS.lowPlant : nc === 'largeRocks' ? CLS.largeRock : nc === 'smallRocks' ? CLS.smallRock : -1;
    if (cls < 0) {
      unknownNature.add(p.asset);
      return;
    }
    srcs.push({ asset: p.asset, seed: p.seed, scheme: p.scheme, x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale, tint: p.tint, cls, natureIndex: i });
  });
  for (const id of unknownNature) console.warn(`[props] nature asset '${id}' has no class in the catalog — skipped`);

  // Assets: one load each; a failing one is skipped, never fatal.
  phase('placements');
  const assets = new Map<string, PropAsset>();
  const skipped: string[] = [];
  // All imports in flight at once (one after the other was ~0.2–0.5 s of
  // module requests); the results are taken in the same order as before.
  const ids = [...new Set(srcs.map((s) => s.asset))];
  const loads = await Promise.allSettled(ids.map((id) => loadAsset(id)));
  ids.forEach((id, k) => {
    const r = loads[k];
    try {
      if (r.status === 'rejected') throw r.reason;
      const a = r.value;
      if (a.kind !== 'prop') throw new Error(`'${id}' is not a prop asset`);
      assets.set(id, a);
    } catch (e) {
      skipped.push(id);
      console.warn(`[props] asset '${id}' failed to load — its placements are skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  phase('loadAssets');
  const N = srcs.length;
  const ix = new Float32Array(N);
  const iz = new Float32Array(N);
  const icls = new Uint8Array(N);
  const drawn = new Uint8Array(N);
  const permanent = new Uint8Array(N);
  const farOf = new Int32Array(N).fill(-1);
  const nearOf = new Int32Array(N).fill(-1);
  const variantOf = new Int32Array(N);
  const colliderVariantOf = new Int32Array(N);
  /** 1 = drawn as its collider variant on every preset (DRAW_AS_COLLIDER_*). */
  const exact = new Uint8Array(N);
  const assetId: string[] = new Array(N);
  const M = new Float32Array(N * 16);
  const TINT = new Float32Array(N * 3);
  const SHADE = new Float32Array(N * 2);
  const positions: Vector3[] = new Array(N);
  const rotations: Quaternion[] = new Array(N);

  // Dressing assets with a single placement stay near permanently.
  const dressingCount = new Map<string, number>();
  for (const s of srcs) if (s.cls === CLS.dressing) dressingCount.set(s.asset, (dressingCount.get(s.asset) ?? 0) + 1);
  const permanentAssets = [...dressingCount.entries()].filter(([id, n]) => id === GANTRY || n === 1).map(([id]) => id).sort();
  const permanentSet = new Set(permanentAssets);

  const tmpM = new Matrix();
  const nrm = { x: 0, y: 1, z: 0 };
  const scl = new Vector3();
  for (let i = 0; i < N; i++) {
    const s = srcs[i];
    assetId[i] = s.asset;
    icls[i] = s.cls;
    const asset = assets.get(s.asset);
    drawn[i] = asset ? 1 : 0;
    if (asset && THINNED.has(s.cls) && density < 1 && hash01(s.natureIndex) >= density) drawn[i] = 0;
    colliderVariantOf[i] = s.seed % Math.max(1, COLLIDER_VARIANTS[CLASSES[s.cls]]);
    permanent[i] = s.cls === CLS.dressing && permanentSet.has(s.asset) ? 1 : 0;
    // Hero pieces (buildings, the start gantry and every other one-off
    // dressing) are one batch each whatever their variant: they are drawn as
    // their collider variant, so a seed shows the same gantry and the same
    // houses on every preset (a variant limit thins SMALL props only).
    exact[i] = DRAW_AS_COLLIDER_CLASSES.has(s.cls) || DRAW_AS_COLLIDER_ASSETS.has(s.asset) || s.cls === CLS.building || permanent[i] ? 1 : 0;
    variantOf[i] = exact[i] ? colliderVariantOf[i] : s.seed % Math.max(1, variantLimit[CLASSES[s.cls]]);
    const yawQ = Quaternion.RotationYawPitchRoll(s.yaw, 0, 0);
    let rot = yawQ;
    if (TILTED.has(s.asset)) {
      ground.normalAt(s.x, s.z, nrm);
      const ax = nrm.z, az = -nrm.x;
      const l = Math.hypot(ax, az);
      if (l > 1e-6) rot = Quaternion.RotationAxis(new Vector3(ax / l, 0, az / l), Math.acos(Math.min(1, nrm.y))).multiply(yawQ);
    }
    const pos = new Vector3(s.x, s.y, s.z);
    positions[i] = pos;
    rotations[i] = rot;
    scl.set(s.scale, s.scale, s.scale);
    Matrix.ComposeToRef(scl, rot, pos, tmpM);
    M.set(tmpM.m, i * 16);
    ix[i] = M[i * 16 + 12];
    iz[i] = M[i * 16 + 14];
    TINT[i * 3] = s.tint[0];
    TINT[i * 3 + 1] = s.tint[1];
    TINT[i * 3 + 2] = s.tint[2];
    // Trees, large rocks and buildings have their own contact stamp in the
    // ground AO: reading it back would darken them twice.
    const ownStamp = s.cls === CLS.tree || s.cls === CLS.largeRock || s.cls === CLS.building;
    SHADE[i * 2] = ownStamp ? 1 : Math.max(0.55, sampleShade(data, s.x, s.z, 0));
    SHADE[i * 2 + 1] = sampleShade(data, s.x, s.z, 1);
  }

  phase('matrices');
  // Everything the build below prepares, handed to the boot first (bake
  // workers): the same keys and far targets the loops below ask for.
  const bootOptions = options as WorldPropsBootOptions;
  if (bootOptions.prefetch) {
    const t0 = now();
    const jobs = new Map<string, PropPrepJob>();
    for (let i = 0; i < N; i++) {
      if (!drawn[i]) continue;
      const s = srcs[i];
      const k = `${s.asset}|${variantOf[i]}|${s.scheme ?? ''}`;
      let job = jobs.get(k);
      if (!job) {
        job = { asset: assets.get(s.asset)!, seed: variantOf[i], scheme: s.scheme, cls: CLASSES[s.cls], far: [] };
        jobs.set(k, job);
      }
      const target =
        s.cls === CLS.building ? farBuildingTarget(s.asset, farTris.building) : permanent[i] ? -1 : s.cls === CLS.dressing ? farTris.dressing : farTris[CLASSES[s.cls]];
      if (target >= 0 && !job.far.includes(target)) job.far.push(target);
    }
    await bootOptions.prefetch([...jobs.values()]);
    timing.prefetchMs = now() - t0;
  }

  phase('prefetch');
  // -------------------------------------------------------------------------
  // Preparation: every (asset, variant, scheme) the tiers need, built once
  // (prepareProp caches). An asset whose builder throws is skipped like one
  // that failed to load — its placements are not drawn — never fatal.

  const prepared = (asset: PropAsset, seed: number, scheme: string | undefined) => {
    const t0 = now();
    try {
      return prepareProp(asset, seed, scheme);
    } finally {
      timing.prepareMs += now() - t0;
    }
  };
  const failAsset = (id: string, what: string, e: unknown): void => {
    if (!skipped.includes(id)) skipped.push(id);
    console.warn(`[props] asset '${id}' failed in ${what} — its placements are skipped: ${errText(e)}`);
    for (let i = 0; i < N; i++) if (srcs[i].asset === id) drawn[i] = 0;
  };
  {
    const tried = new Set<string>();
    for (let i = 0; i < N; i++) {
      if (!drawn[i]) continue;
      const s = srcs[i];
      const asset = assets.get(s.asset)!;
      // The far tier draws the near variant: one preparation serves both.
      const v = variantOf[i];
      const k = `${s.asset}|${v}|${s.scheme ?? ''}`;
      if (tried.has(k)) continue;
      tried.add(k);
      try {
        prepared(asset, v, s.scheme);
      } catch (e) {
        failAsset(s.asset, `prepareProp(${v}, ${s.scheme ?? '-'})`, e);
        continue;
      }
      await yieldToBrowser();
    }
  }

  phase('prepare');
  // -------------------------------------------------------------------------
  // Batches

  const nearKeys = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    if (!drawn[i]) continue;
    const s = srcs[i];
    const nk = `${s.asset}|${variantOf[i]}|${s.scheme ?? ''}`;
    let list = nearKeys.get(nk);
    if (!list) nearKeys.set(nk, (list = []));
    list.push(i);
  }
  const lotItems: number[] = [];
  for (let i = 0; i < N; i++) if (drawn[i] && icls[i] === CLS.building) lotItems.push(i);
  // Far props: one batch per (asset, near variant, scheme); far dressing:
  // one merged mesh. Built after the near tier (an instancing failure there
  // un-draws its placements).
  const farKeyCount = new Set<string>();
  for (let i = 0; i < N; i++) {
    if (!drawn[i] || icls[i] === CLS.building || permanent[i]) continue;
    farKeyCount.add(`${srcs[i].asset}|${variantOf[i]}|${srcs[i].scheme ?? ''}`);
  }

  // The merged far meshes report one step per distinct (asset, variant,
  // scheme), so the lots count by key too.
  const lotKeys = new Set(lotItems.map((i) => `${srcs[i].asset}|${variantOf[i]}|${srcs[i].scheme ?? ''}`));
  const totalSteps = nearKeys.size + farKeyCount.size + lotKeys.size + (options.colliders === false ? 0 : 1);
  let done = 0;
  const progress = (label: string): void => {
    done++;
    options.onProgress?.(Math.min(1, done / Math.max(1, totalSteps)), label);
  };

  // [full triangles, far triangles, placements]. Full = variant 0's mesh
  // when the world draws it, else the first variant drawn (single-placement
  // dressing); far = the largest far mesh over the asset's schemes and
  // variants (0 for an asset that never leaves the near tier).
  const perAsset: Record<string, [number, number, number]> = {};
  const fullFromV0 = new Set<string>();
  for (const s of srcs) {
    const e = (perAsset[s.asset] ??= [0, 0, 0]);
    e[2]++;
  }
  const noteFull = (id: string, variant: number, tris: number): void => {
    const e = perAsset[id];
    if (fullFromV0.has(id)) return;
    if (variant === 0) {
      fullFromV0.add(id);
      e[0] = tris;
    } else if (e[0] === 0) e[0] = tris;
  };

  // Near tier.
  const near: NearBatch[] = [];
  const nearMeshes: Mesh[] = [];
  for (const [key, list] of nearKeys) {
    const first = list[0];
    const s = srcs[first];
    if (!drawn[first]) continue;
    const asset = assets.get(s.asset)!;
    const variant = variantOf[first];
    const p = prepared(asset, variant, s.scheme);
    const t0 = now();
    let mesh: Mesh;
    try {
      mesh = instantiateProp(scene, asset, variant, s.scheme, { instanced: true, castShadows: false });
    } catch (e) {
      // This batch only: its placements are not drawn, the asset's other
      // variants still are.
      console.warn(`[props] instantiateProp('${s.asset}', ${variant}) failed — ${list.length} placements skipped: ${errText(e)}`);
      if (!skipped.includes(s.asset)) skipped.push(s.asset);
      for (const i of list) drawn[i] = 0;
      continue;
    }
    mesh.name = `near:${key}`;
    // BEFORE the first buffer: otherwise every buffer write recomputes bounds.
    mesh.doNotSyncBoundingInfo = true;
    const cap = list.length;
    const b: NearBatch = {
      asset,
      variant,
      scheme: s.scheme,
      cls: s.cls,
      mesh,
      triangles: p.mesh.triangles,
      count: 0,
      matrix: new Float32Array(cap * 16),
      tint: new Float32Array(cap * 3),
      shade: new Float32Array(cap * 2),
      items: new Int32Array(cap),
      caster: casterClasses.has(s.cls),
      wind: asset.wind ?? false,
      permanent: permanent[first] === 1,
    };
    mesh.thinInstanceSetBuffer('matrix', b.matrix, 16, false);
    mesh.thinInstanceSetBuffer('instanceTint', b.tint, 3, false);
    mesh.thinInstanceSetBuffer('instanceShade', b.shade, 2, false);
    // A thin-instance mesh with a count of 0 would be drawn once at the origin.
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    timing.meshMs += now() - t0;
    for (const i of list) nearOf[i] = near.length;
    near.push(b);
    nearMeshes.push(mesh);
    noteFull(s.asset, variant, p.mesh.triangles);
    progress(s.asset);
    await yieldToBrowser();
  }

  phase('near');
  // Far tier: props.
  const farProps = createFarMaterial(scene);
  const farMerged = createFarMaterial(scene, { merged: true });
  const farDressing = createFarMaterial(scene, { merged: true });
  const farBatches: FarBatch[] = [];
  const farMeshes: Mesh[] = [];
  const farVariantOf = new Int32Array(N).fill(-1);
  const inMergedDressing = new Uint8Array(N);
  /** The far model of one placement, timed as simplification (it is that,
   * or a designed model in its place); null = none (the placement stays near). */
  const farOf_ = (i: number, target: number): FarModel | null => {
    const s = srcs[i];
    const asset = assets.get(s.asset)!;
    const t0 = now();
    try {
      return farModel(asset, variantOf[i], s.scheme, target);
    } catch (e) {
      console.warn(`[props] far model of '${s.asset}' #${variantOf[i]} failed — the placement stays near: ${errText(e)}`);
      return null;
    } finally {
      timing.simplifyMs += now() - t0;
    }
  };
  const farKeys = new Map<string, number[]>();
  const dressingItems: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!drawn[i] || icls[i] === CLS.building || permanent[i]) continue;
    if (icls[i] === CLS.dressing) {
      dressingItems.push(i);
      continue;
    }
    const s = srcs[i];
    const fk = `${s.asset}|${variantOf[i]}|${s.scheme ?? ''}`;
    let fl = farKeys.get(fk);
    if (!fl) farKeys.set(fk, (fl = []));
    fl.push(i);
  }
  for (const [key, list] of farKeys) {
    const s = srcs[list[0]];
    const asset = assets.get(s.asset)!;
    const target = farTris[CLASSES[s.cls]];
    const farVariant = variantOf[list[0]];
    noteFull(s.asset, farVariant, prepared(asset, farVariant, s.scheme).mesh.triangles);
    const r = farOf_(list[0], target);
    if (!r) {
      // No far mesh: these placements stay in the near tier everywhere.
      for (const i of list) permanent[i] = 1;
      continue;
    }
    const t1 = now();
    const mesh = meshFromData(`far:${key}`, r.data, scene);
    mesh.material = farProps.material;
    mesh.doNotSyncBoundingInfo = true;
    const n = list.length;
    const m = new Float32Array(n * 16);
    const t = new Float32Array(n * 3);
    const sh = new Float32Array(n * 2);
    list.forEach((i, k) => {
      m.set(M.subarray(i * 16, i * 16 + 16), k * 16);
      t.set(TINT.subarray(i * 3, i * 3 + 3), k * 3);
      sh.set(SHADE.subarray(i * 2, i * 2 + 2), k * 2);
      farOf[i] = farBatches.length;
      farVariantOf[i] = farVariant;
    });
    mesh.thinInstanceSetBuffer('matrix', m, 16, true);
    mesh.thinInstanceSetBuffer('instanceTint', t, 3, true);
    mesh.thinInstanceSetBuffer('instanceShade', sh, 2, true);
    mesh.thinInstanceCount = n;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    mesh.setEnabled(!DETAIL_ONLY.has(s.cls));
    timing.meshMs += now() - t1;
    perAsset[s.asset][1] = Math.max(perAsset[s.asset][1], r.data.triangleCount);
    farBatches.push({
      asset,
      variant: farVariant,
      scheme: s.scheme,
      cls: s.cls,
      mesh,
      triangles: r.data.triangleCount,
      count: n,
      inside: 0,
      method: r.method,
      silhouette: r.silhouette,
      boundsError: r.boundsError,
      target,
      stretch: r.stretch,
    });
    farMeshes.push(mesh);
    progress(`${s.asset} (far)`);
    await yieldToBrowser();
  }

  /**
   * A merged far mesh: every listed placement's far model transformed into
   * world space by `matrix(i)`, with its origin, AO / sun shade and tint per
   * vertex (the near tier's instance values). Placements whose far model
   * fails stay near. Returns the mesh (null if empty) and its items.
   */
  const buildMerged = async (
    name: string,
    items: readonly number[],
    targetOf: (i: number) => number,
    matrixOf: (i: number) => Matrix,
    shadeOf: (i: number) => [number, number],
    tintOf: (i: number) => [number, number, number],
    material: FarMaterial,
  ): Promise<{ mesh: Mesh | null; triangles: number; per: MergedItem[]; placed: number[] }> => {
    const pos: number[] = [];
    const nrmA: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const uv2: number[] = [];
    const origin: number[] = [];
    const shadeA: number[] = [];
    const tintA: number[] = [];
    const per: MergedItem[] = [];
    const placed: number[] = [];
    const v = new Vector3();
    const seen = new Set<string>();
    for (const i of items) {
      const s = srcs[i];
      if (!drawn[i]) continue;
      const target = targetOf(i);
      const asset = assets.get(s.asset)!;
      noteFull(s.asset, variantOf[i], prepared(asset, variantOf[i], s.scheme).mesh.triangles);
      const r = farOf_(i, target);
      if (!r) {
        permanent[i] = 1;
        continue;
      }
      const t1 = now();
      const d = r.data;
      const wm = matrixOf(i);
      const [ao, sun] = shadeOf(i);
      const [tr, tg, tb] = tintOf(i);
      // Unrolled by index: the indices of a SolidVertexData may share
      // vertices; the merged mesh is non-indexed (one vertex per corner).
      const I = d.indices;
      for (let c = 0; c < I.length; c++) {
        const k = I[c];
        Vector3.TransformCoordinatesFromFloatsToRef(d.positions[k * 3], d.positions[k * 3 + 1], d.positions[k * 3 + 2], wm, v);
        pos.push(v.x, v.y, v.z);
        Vector3.TransformNormalFromFloatsToRef(d.normals[k * 3], d.normals[k * 3 + 1], d.normals[k * 3 + 2], wm, v);
        v.normalize();
        nrmA.push(v.x, v.y, v.z);
        col.push(d.colors[k * 4], d.colors[k * 4 + 1], d.colors[k * 4 + 2], d.colors[k * 4 + 3]);
        uv.push(d.uvs[k * 2], d.uvs[k * 2 + 1]);
        uv2.push(d.uvs2[k * 2], d.uvs2[k * 2 + 1]);
        origin.push(ix[i], iz[i]);
        shadeA.push(ao, sun);
        tintA.push(tr, tg, tb);
      }
      timing.meshMs += now() - t1;
      perAsset[s.asset][1] = Math.max(perAsset[s.asset][1], d.triangleCount);
      per.push({ assetId: s.asset, variant: variantOf[i], scheme: s.scheme, method: r.method, triangles: d.triangleCount, target, silhouette: r.silhouette, boundsError: r.boundsError });
      placed.push(i);
      const key = `${s.asset}|${variantOf[i]}|${s.scheme ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        progress(`${s.asset} (far)`);
      }
      await yieldToBrowser();
    }
    if (pos.length === 0) return { mesh: null, triangles: 0, per, placed };
    const t1 = now();
    const count = pos.length / 3;
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.normals = new Float32Array(nrmA);
    vd.colors = new Float32Array(col);
    vd.uvs = new Float32Array(uv);
    vd.uvs2 = new Float32Array(uv2);
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let k = 0; k < count; k++) idx[k] = k;
    vd.indices = idx;
    const mesh = new Mesh(name, scene);
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData('lodOrigin', new Float32Array(origin), false, 2);
    mesh.setVerticesData('lodShade', new Float32Array(shadeA), false, 2);
    mesh.setVerticesData('lodTint', new Float32Array(tintA), false, 3);
    mesh.hasVertexAlpha = false;
    mesh.applyFog = false;
    mesh.isPickable = false;
    mesh.material = material.material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    timing.meshMs += now() - t1;
    return { mesh, triangles: count / 3, per, placed };
  };

  phase('farProps');
  // Far tier: dressing, one merged mesh in the props ring. Each placement's
  // own matrix (tilt along the ground, scale), tint and ground AO.
  const mergedDressingInfo: WorldPropsInternals['mergedDressing'] = { mesh: null, triangles: 0, items: 0, inside: 0, perItem: [] };
  {
    const lm = new Matrix();
    const r = await buildMerged(
      'far:dressing',
      dressingItems,
      () => farTris.dressing,
      (i) => Matrix.FromArrayToRef(M, i * 16, lm),
      (i) => [SHADE[i * 2], SHADE[i * 2 + 1]],
      (i) => [TINT[i * 3], TINT[i * 3 + 1], TINT[i * 3 + 2]],
      farDressing,
    );
    for (const i of r.placed) {
      inMergedDressing[i] = 1;
      farVariantOf[i] = variantOf[i];
    }
    mergedDressingInfo.mesh = r.mesh;
    mergedDressingInfo.triangles = r.triangles;
    mergedDressingInfo.items = r.placed.length;
    mergedDressingInfo.perItem = r.per;
    if (r.mesh) farMeshes.push(r.mesh);
  }

  // Far tier: buildings, one merged mesh in the building ring (no tint, AO 1:
  // a lot carries its own contact stamp).
  const mergedInfo: WorldPropsInternals['merged'] = { mesh: null, triangles: 0, lots: lotItems.length, inside: 0, perLot: [] };
  {
    const r = await buildMerged(
      'far:buildings',
      lotItems,
      (i) => farBuildingTarget(srcs[i].asset, farTris.building),
      (i) => Matrix.Compose(new Vector3(1, 1, 1), rotations[i], positions[i]),
      (i) => [1, SHADE[i * 2 + 1]],
      () => [1, 1, 1],
      farMerged,
    );
    for (const i of r.placed) farVariantOf[i] = variantOf[i];
    mergedInfo.mesh = r.mesh;
    mergedInfo.triangles = r.triangles;
    mergedInfo.perLot = r.per;
    if (r.mesh) farMeshes.push(r.mesh);
  }

  phase('farMerged');
  // -------------------------------------------------------------------------
  // Colliders: every placement whose asset has them, whatever its tier or
  // the scatter density (none of the thinned classes has colliders).

  let colliders: BuiltColliders | null = null;
  let colliderExpected = 0;
  let colliderItemsN = 0;
  if (options.colliders !== false) {
    const t0 = now();
    const items: ColliderItem[] = [];
    // Collider counts per (asset, variant): some assets rebuild their whole
    // construction to answer `colliders(seed)`, once per placement is seconds.
    const counts = new Map<string, number>();
    // The specs themselves, so buildColliders does not ask a second time.
    const specs = new Map<string, readonly ColliderSpec[]>();
    for (let i = 0; i < N; i++) {
      const asset = assets.get(assetId[i]);
      // Skipped assets (builder threw) collide neither.
      if (!asset?.colliders || skipped.includes(asset.id)) continue;
      const c = icls[i];
      const group: ColliderGroup = c === CLS.building ? 'building' : c === CLS.tree ? 'tree' : c === CLS.largeRock || c === CLS.smallRock ? 'rock' : 'dressing';
      const cv = colliderVariantOf[i];
      const ck = `${asset.id}|${cv}`;
      let n = counts.get(ck);
      if (n === undefined) {
        try {
          const list = asset.colliders(cv);
          specs.set(ck, list);
          n = list.length;
        } catch (e) {
          console.warn(`[props] colliders('${asset.id}', ${cv}) failed — no colliders for it: ${errText(e)}`);
          n = 0;
        }
        counts.set(ck, n);
      }
      if (n === 0) continue;
      colliderExpected += n;
      colliderItemsN++;
      items.push({ asset, variant: cv, group, position: positions[i], rotation: rotations[i], scale: srcs[i].scale });
    }
    colliders = buildColliders(scene, items, { debug: lab.colliderDebug, specs: (a, v) => specs.get(`${a.id}|${v}`) ?? a.colliders?.(v) ?? [] });
    timing.colliderMs = now() - t0;
    progress('colliders');
  }

  phase('colliders');
  // -------------------------------------------------------------------------
  // Grid of near candidates (not buildings, not permanent).

  const half = data.heightfield.size / 2;
  const gridN = Math.ceil(data.heightfield.size / CELL);
  const cellOf = (v: number): number => Math.min(gridN - 1, Math.max(0, Math.floor((v + half) / CELL)));
  const cellCount = new Int32Array(gridN * gridN + 1);
  const candidates: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!drawn[i] || permanent[i] || icls[i] === CLS.building) continue;
    candidates.push(i);
    cellCount[cellOf(iz[i]) * gridN + cellOf(ix[i]) + 1]++;
  }
  const cellStart = new Int32Array(gridN * gridN + 1);
  for (let c = 0; c < gridN * gridN; c++) cellStart[c + 1] = cellStart[c] + cellCount[c + 1];
  const fill = cellStart.slice(0, gridN * gridN);
  const cellItems = new Int32Array(candidates.length);
  for (const i of candidates) cellItems[fill[cellOf(iz[i]) * gridN + cellOf(ix[i])]++] = i;
  // Only placements with a near batch (an instancing failure un-draws its
  // placements); a lot whose simplification failed is permanently near and
  // written once, by the permanent list.
  const permanentItems = new Int32Array([...Array(N).keys()].filter((i) => drawn[i] && permanent[i] && nearOf[i] >= 0));
  const buildingItems = new Int32Array(lotItems.filter((i) => drawn[i] && !permanent[i] && nearOf[i] >= 0));

  // -------------------------------------------------------------------------
  // Runtime

  // Placements of a skipped asset still count as planned, not as drawn.
  const placements = N;
  let drawnCount = 0;
  for (let i = 0; i < N; i++) drawnCount += drawn[i];

  phase('grid');
  const stats: WorldPropsStats = {
    placements,
    drawn: drawnCount,
    nearBatches: near.length,
    farBatches: farMeshes.length,
    nearActive: 0,
    farActive: 0,
    nearInstances: 0,
    nearTriangles: 0,
    farInstances: 0,
    farTriangles: 0,
    casterMeshes: 0,
    casterTriangles: 0,
    colliderShapes: colliders?.shapes ?? 0,
    colliderBodies: colliders?.bodies.length ?? 0,
    perAsset,
    prepareMs: timing.prepareMs,
    simplifyMs: timing.simplifyMs,
    meshMs: timing.meshMs,
    colliderMs: timing.colliderMs,
    refreshes: 0,
    lastRefreshMs: 0,
  };

  const nearTint = lab.nearTint;
  const look = getLook(scene);
  const casters = new Set<Mesh>();
  // The same meshes as an array: iterating a Set allocates every frame.
  const casterList: Mesh[] = [];
  let first = true;
  let lastX = 0, lastZ = 0, lastNear = -1, lastBuilding = -1;
  let farShadowsOn = false;
  let farDetailOn = false;
  let dirty = false;

  const write = (b: NearBatch, i: number): void => {
    const k = b.count;
    const mo = k * 16, so = i * 16;
    for (let j = 0; j < 16; j++) b.matrix[mo + j] = M[so + j];
    if (nearTint) {
      b.tint[k * 3] = TINT[i * 3] * nearTint[0];
      b.tint[k * 3 + 1] = TINT[i * 3 + 1] * nearTint[1];
      b.tint[k * 3 + 2] = TINT[i * 3 + 2] * nearTint[2];
    } else {
      b.tint[k * 3] = TINT[i * 3];
      b.tint[k * 3 + 1] = TINT[i * 3 + 1];
      b.tint[k * 3 + 2] = TINT[i * 3 + 2];
    }
    b.shade[k * 2] = SHADE[i * 2];
    b.shade[k * 2 + 1] = SHADE[i * 2 + 1];
    b.items[k] = i;
    b.count = k + 1;
  };

  const refresh = (view: PropsView): void => {
    const t0 = now();
    farProps.setRing(view.x, view.z, Math.max(0, view.nearRadius));
    farDressing.setRing(view.x, view.z, Math.max(0, view.nearRadius));
    farMerged.setRing(view.x, view.z, Math.max(0, view.buildingRadius));
    const ring = farProps.ring;
    const bring = farMerged.ring;
    for (let b = 0; b < near.length; b++) near[b].count = 0;
    for (let f = 0; f < farBatches.length; f++) farBatches[f].inside = 0;
    let din = 0;
    if (ring.radius > 0) {
      const c0x = cellOf(ring.x - ring.radius), c1x = cellOf(ring.x + ring.radius);
      const c0z = cellOf(ring.z - ring.radius), c1z = cellOf(ring.z + ring.radius);
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const c = cz * gridN + cx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const i = cellItems[k];
            if (!ringInside(ix[i], iz[i], ring)) continue;
            write(near[nearOf[i]], i);
            const f = farOf[i];
            if (f >= 0) farBatches[f].inside++;
            else if (inMergedDressing[i]) din++;
          }
        }
      }
    }
    let bin = 0;
    for (let k = 0; k < buildingItems.length; k++) {
      const i = buildingItems[k];
      if (!ringInside(ix[i], iz[i], bring)) continue;
      write(near[nearOf[i]], i);
      bin++;
    }
    mergedInfo.inside = bin;
    mergedDressingInfo.inside = din;
    for (let k = 0; k < permanentItems.length; k++) {
      const i = permanentItems[k];
      write(near[nearOf[i]], i);
    }
    for (let b = 0; b < near.length; b++) {
      const nb = near[b];
      const mesh = nb.mesh;
      mesh.thinInstanceCount = nb.count;
      if (nb.count > 0) {
        mesh.thinInstanceBufferUpdated('matrix');
        mesh.thinInstanceBufferUpdated('instanceTint');
        mesh.thinInstanceBufferUpdated('instanceShade');
      }
      mesh.setEnabled(nb.count > 0);
    }
    lastX = view.x;
    lastZ = view.z;
    lastNear = view.nearRadius;
    lastBuilding = view.buildingRadius;
    stats.refreshes++;
    stats.lastRefreshMs = now() - t0;
  };

  // The two caster sets, fixed after the build. Switching removes and adds
  // only the meshes that change sets (permanently near batches — the gantry,
  // single dressing — have no far twin and cast in both modes; nothing is
  // drawn twice).
  const wantFar: { mesh: Mesh; wind: boolean }[] = [];
  const wantNear: { mesh: Mesh; wind: boolean }[] = [];
  for (const f of farBatches) if (FAR_CASTERS.has(f.cls)) wantFar.push({ mesh: f.mesh, wind: false });
  if (mergedInfo.mesh) wantFar.push({ mesh: mergedInfo.mesh, wind: false });
  for (const b of near) {
    if (!b.caster) continue;
    wantNear.push({ mesh: b.mesh, wind: b.wind });
    if (b.permanent) wantFar.push({ mesh: b.mesh, wind: b.wind });
  }
  const setCasters = (far: boolean): void => {
    const shadows = look.shadows;
    const want = far ? wantFar : wantNear;
    const keep = new Set(want.map((w) => w.mesh));
    for (const m of casters) {
      if (keep.has(m)) continue;
      shadows.removeCaster(m);
      casters.delete(m);
    }
    for (const w of want) {
      if (casters.has(w.mesh)) continue;
      shadows.addCaster(w.mesh, { wind: w.wind });
      casters.add(w.mesh);
    }
    casterList.length = 0;
    for (const m of casters) casterList.push(m);
  };

  const updateStats = (): void => {
    let nA = 0, nI = 0, nT = 0;
    for (let b = 0; b < near.length; b++) {
      const nb = near[b];
      if (nb.count === 0) continue;
      nA++;
      nI += nb.count;
      nT += nb.count * nb.triangles;
    }
    let fA = 0, fI = 0, fT = 0;
    for (let f = 0; f < farBatches.length; f++) {
      const fb = farBatches[f];
      if (!fb.mesh.isEnabled(false)) continue;
      fA++;
      fI += fb.count - fb.inside;
      fT += fb.count * fb.triangles;
    }
    if (mergedInfo.mesh) {
      fA++;
      fI += mergedInfo.perLot.length - mergedInfo.inside;
      fT += mergedInfo.triangles;
    }
    if (mergedDressingInfo.mesh) {
      fA++;
      fI += mergedDressingInfo.items - mergedDressingInfo.inside;
      fT += mergedDressingInfo.triangles;
    }
    let cM = 0, cT = 0;
    for (let c = 0; c < casterList.length; c++) {
      const m = casterList[c];
      if (!m.isEnabled(false)) continue;
      const n = m.hasThinInstances ? m.thinInstanceCount : m === mergedInfo.mesh || m === mergedDressingInfo.mesh ? 1 : 0;
      if (n <= 0) continue;
      cM++;
      cT += (m.getTotalIndices() / 3) * n;
    }
    stats.nearActive = nA;
    stats.nearInstances = nI;
    stats.nearTriangles = nT;
    stats.farActive = fA;
    stats.farInstances = fI;
    stats.farTriangles = fT;
    stats.casterMeshes = cM;
    stats.casterTriangles = cT;
  };

  const update = (view: PropsView): void => {
    const dx = view.x - lastX, dz = view.z - lastZ;
    if (first || dirty || dx * dx + dz * dz > refreshStep * refreshStep || view.nearRadius !== lastNear || view.buildingRadius !== lastBuilding) {
      refresh(view);
      dirty = false;
    }
    if (first || view.farDetail !== farDetailOn) {
      farDetailOn = view.farDetail;
      for (let f = 0; f < farBatches.length; f++) {
        const fb = farBatches[f];
        if (DETAIL_ONLY.has(fb.cls)) fb.mesh.setEnabled(farDetailOn && fb.count > 0);
      }
    }
    if (first || view.farShadows !== farShadowsOn) {
      farShadowsOn = view.farShadows;
      setCasters(farShadowsOn);
    }
    first = false;
    updateStats();
  };

  const bodies: PhysicsBody[] = colliders?.bodies ?? [];
  const props: WorldProps = {
    update,
    stats,
    nearMeshes,
    farMeshes,
    colliderBodies: bodies,
    dispose(): void {
      for (const m of casters) look.shadows.removeCaster(m);
      casters.clear();
      for (const m of nearMeshes) m.dispose();
      for (const m of farMeshes) m.dispose();
      for (const f of [farProps, farMerged, farDressing]) {
        look.unregister(f.material);
        f.material.dispose();
      }
      colliders?.dispose();
    },
  };
  INTERNALS.set(props, {
    count: N,
    x: ix,
    z: iz,
    cls: icls,
    drawn,
    permanent,
    far: farOf,
    assetId,
    near,
    farBatches,
    merged: mergedInfo,
    mergedDressing: mergedDressingInfo,
    farMergedDressing: inMergedDressing,
    farVariant: farVariantOf,
    propsRing: farProps.ring,
    buildingRing: farMerged.ring,
    permanentAssets,
    skippedAssets: skipped,
    colliders,
    colliderItems: colliderItemsN,
    colliderExpected,
    colliderVariant: colliderVariantOf,
    drawVariant: variantOf,
    drawAsCollider: exact,
    casters,
    invalidate: () => {
      dirty = true;
    },
  });
  return props;
};
