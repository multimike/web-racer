import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { bakeAO } from '../gfx/solid/ao';
import type { SolidMesh, SolidVertexData } from '../gfx/solid/SolidMesh';
import type { CarAsset, CarLink, CarSpec, CarSpinner, PropAsset } from '../assets/types';

/**
 * Stage 1 of asset assembly — PREPARE (CPU): run the builder, bake ambient
 * occlusion, weld and index. Moved here from src/assets/assemble.ts (which
 * re-exports all of it, so every import of it keeps working) so that it has
 * no dependency on the renderer: the bake workers
 * (src/boot/bakeWorker.ts) import exactly this module, and the results they
 * send back are adopted into the same caches (`adoptPreparedProp`,
 * `adoptPreparedCar`) that `prepareProp` / `prepareCar` read.
 *
 * AMBIENT OCCLUSION is baked HERE, not in the builders — builders return
 * plain geometry and never need to call `bakeAO`:
 *  - props / buildings: the whole mesh with a ground plane at y = 0;
 *  - car body: with the ground AND the four wheels + hubs at the static pose
 *    as occluders (wheel arches and the underside darken), written to the
 *    body only;
 *  - wheels, hubs, links, spinners, steering wheel: each on its own, without
 *    ground — they move, so only their self-occlusion is valid everywhere.
 * AO lives on vertices, so before the bake big flat faces (a wall that is two
 * triangles) are REFINED — long edges split until they are about the size of
 * the contact shadows, as far as the asset's triangle budget allows. Shading
 * does not change (split faces keep their normals); the wall just gains the
 * vertices a contact gradient needs instead of one diagonal smear. Builders
 * therefore do not call `tessellate` for AO's sake either.
 * A builder that needs a special bake (a custom `maxDistance` for a deep
 * cavity) simply bakes itself: a mesh that already carries AO (any corner
 * below 1) is left exactly as authored.
 */

// ---------------------------------------------------------------------------
// Settings

export const assembleSettings = {
  /** false = skip the bake (AO 1 everywhere unless the builder wrote some). */
  ao: true,
  /** Rays per sample for props and buildings. */
  propRays: 16,
  /** Rays per sample for car parts. Cars are ~10× denser than props, where
   * the smoothing pass hides the noise of 8 rays; 16 costs twice the time. */
  carRays: 8,
  /** Split long edges before the bake so flat faces can hold a contact
   * gradient: target edge = this fraction of the bake's occlusion range
   * (which is 20 % of the asset's largest dimension). 0 = never refine. */
  aoRefine: 0.55,
  /** Keep the source SolidMesh on each prepared mesh (analysis in the asset
   * lab). Off in the game: a 60k-triangle car is ~10 MB of JS arrays. */
  keepSolids: false,
};

export type AssembleSettings = typeof assembleSettings;

// ---------------------------------------------------------------------------
// Prepared geometry

/** One finalized mesh: GPU-ready buffers plus what the lab reports. */
export interface PreparedMesh {
  data: SolidVertexData;
  min: [number, number, number];
  max: [number, number, number];
  triangles: number;
  /** Triangles the builder returned, before the AO refinement added any. */
  authoredTriangles: number;
  /** 'baked' here, 'builder' = the asset supplied its own AO, 'off'. */
  ao: 'baked' | 'builder' | 'off';
  aoMs: number;
  /** Only with `assembleSettings.keepSolids`. */
  solid?: SolidMesh;
}

export interface PreparedProp {
  mesh: PreparedMesh;
  seed: number;
  scheme: string | undefined;
  /** Builder time, AO time, weld + index time — milliseconds. */
  buildMs: number;
  aoMs: number;
  finalizeMs: number;
}

/** A car's moving parts without their meshes: what the instance needs to
 * pose them. (The builder's SolidMeshes themselves are dropped once they are
 * finalized — a dense car is ~10 MB of JS arrays.) */
export interface CarLayout {
  links: Omit<CarLink, 'mesh'>[];
  spinners: Omit<CarSpinner, 'mesh'>[];
  steeringWheel: { pivot: [number, number, number]; axis: [number, number, number] } | null;
}

export interface PreparedCar {
  livery: number;
  body: PreparedMesh;
  /** The optional driver figure (body model space). */
  driver: PreparedMesh | null;
  /** Indexed by WheelIndex; the left ones are mirrored copies. */
  wheels: [PreparedMesh, PreparedMesh, PreparedMesh, PreparedMesh];
  hubs: [PreparedMesh | null, PreparedMesh | null, PreparedMesh | null, PreparedMesh | null];
  /** Parallel to `layout.links` / `.spinners`. Links that share one
   * SolidMesh object share one PreparedMesh. */
  links: PreparedMesh[];
  spinners: PreparedMesh[];
  steeringWheel: PreparedMesh | null;
  layout: CarLayout;
  triangles: number;
  buildMs: number;
  aoMs: number;
  finalizeMs: number;
}

const propCache = new WeakMap<PropAsset, Map<string, PreparedProp>>();
const carCache = new WeakMap<CarAsset, Map<number, PreparedCar>>();
/** Bumped by `clearAssembleCache`; entries from an older epoch are ignored. */
let cacheEpoch = 0;
const epochOf = new WeakMap<object, number>();

/** Forget every prepared mesh (after changing `assembleSettings`). Meshes
 * already in a scene are unaffected. */
export function clearAssembleCache(): void {
  cacheEpoch++;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function hasAuthoredAO(m: SolidMesh): boolean {
  const a = m.cornerAO;
  for (let i = 0; i < a.length; i++) if (a[i] < 0.999) return true;
  return false;
}

function finalize(m: SolidMesh, ao: PreparedMesh['ao'], aoMs: number, authored = m.triangleCount): PreparedMesh {
  const b = m.bounds();
  const data = m.toVertexData();
  const out: PreparedMesh = {
    data,
    min: [b.min.x, b.min.y, b.min.z],
    max: [b.max.x, b.max.y, b.max.z],
    triangles: data.triangleCount,
    authoredTriangles: authored,
    ao,
    aoMs,
  };
  if (assembleSettings.keepSolids) out.solid = m;
  return out;
}

/**
 * Give big faces the vertices a contact gradient needs: split edges longer
 * than a fraction of the occlusion range, coarser and coarser until the
 * result fits `budget` triangles (not at all if even the coarsest pass would
 * not). Shading is unaffected — `tessellate` pins the normals.
 */
function refineForAO(m: SolidMesh, budget: number): void {
  const k = assembleSettings.aoRefine;
  const T = m.triangleCount;
  if (!(k > 0) || T === 0 || T >= budget) return;
  const size = m.bounds().size;
  const range = Math.max(size.x, size.y, size.z) * 0.2;
  for (const scale of [1, 1.5, 2.25, 3.4]) {
    const edge = range * k * scale;
    // Predict the count first: the commonest outcome is "nothing to split".
    const P = m.positions;
    let predicted = 0;
    let longest = 0;
    for (let t = 0; t < T; t++) {
      let worst = 0;
      for (let e = 0; e < 3; e++) {
        const a = t * 9 + e * 3;
        const b = t * 9 + ((e + 1) % 3) * 3;
        worst = Math.max(worst, Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]));
      }
      longest = Math.max(longest, worst);
      const n = Math.max(1, Math.ceil(worst / edge));
      predicted += n * n; // upper bound for an evenly split triangle
    }
    if (longest <= edge) return;
    if (predicted > budget * 1.5) continue;
    const trial = m.clone().tessellate(edge);
    if (trial.triangleCount > budget) continue;
    m.truncate().append(trial);
    return;
  }
}

/** Bake `m` on its own unless the builder already did (or baking is off). */
function bakeAlone(m: SolidMesh, rays: number, ground: boolean, budget: number): { ao: PreparedMesh['ao']; ms: number } {
  if (hasAuthoredAO(m)) return { ao: 'builder', ms: 0 };
  if (!assembleSettings.ao || m.triangleCount === 0) return { ao: 'off', ms: 0 };
  const t0 = now();
  refineForAO(m, budget);
  bakeAO(m, { rays, ground });
  return { ao: 'baked', ms: now() - t0 };
}

function propVariants(asset: PropAsset): Map<string, PreparedProp> {
  let variants = propCache.get(asset);
  if (!variants || epochOf.get(variants) !== cacheEpoch) {
    variants = new Map();
    epochOf.set(variants, cacheEpoch);
    propCache.set(asset, variants);
  }
  return variants;
}

const propKey = (asset: PropAsset, seed: number, scheme: string | undefined): string => `${seed}|${scheme ?? asset.schemes?.[0] ?? ''}`;

/** Run a prop's builder for one variant, bake, finalize. Cached. */
export function prepareProp(asset: PropAsset, seed = 0, scheme?: string): PreparedProp {
  const pick = scheme ?? asset.schemes?.[0];
  const variants = propVariants(asset);
  const key = propKey(asset, seed, scheme);
  const hit = variants.get(key);
  if (hit) return hit;

  const t0 = now();
  const solid = asset.build(seed, pick);
  const authored = solid.triangleCount;
  const t1 = now();
  // Only built things are refined. Scatter (trees, plants, rocks) is drawn by
  // the thousand and is all small facets already: every extra triangle there
  // is paid for on every instance and buys nothing. Buildings (a handful of
  // instances, big walls) may use their whole budget; dressing (fence
  // segments, signs — dozens of instances) at most doubles.
  const refineBudget =
    asset.category === 'building' ? asset.triBudget : asset.category === 'dressing' ? Math.min(asset.triBudget, authored * 2) : 0;
  const bake = bakeAlone(solid, assembleSettings.propRays, true, refineBudget);
  const t2 = now();
  const mesh = finalize(solid, bake.ao, bake.ms, authored);
  const prepared: PreparedProp = {
    mesh,
    seed,
    scheme: pick,
    buildMs: t1 - t0,
    aoMs: t2 - t1,
    finalizeMs: now() - t2,
  };
  variants.set(key, prepared);
  return prepared;
}

/** Put a prop prepared elsewhere (a bake worker, same code, same input) into
 * the cache `prepareProp` reads. An entry already there wins. */
export function adoptPreparedProp(asset: PropAsset, seed: number, scheme: string | undefined, prepared: PreparedProp): void {
  const variants = propVariants(asset);
  const key = propKey(asset, seed, scheme);
  if (!variants.has(key)) variants.set(key, prepared);
}

/** Static hub centres from the spec, model space (origin on the ground under
 * the wheelbase centre, +z nose). Order FL, FR, RL, RR. */
export function hubRestPositions(spec: CarSpec): [number, number, number][] {
  const zf = spec.wheelbase / 2;
  return [
    [-spec.frontTrack / 2, spec.frontTireRadius, zf],
    [spec.frontTrack / 2, spec.frontTireRadius, zf],
    [-spec.rearTrack / 2, spec.rearTireRadius, -zf],
    [spec.rearTrack / 2, spec.rearTireRadius, -zf],
  ];
}

function carLiveries(asset: CarAsset): Map<number, PreparedCar> {
  let liveries = carCache.get(asset);
  if (!liveries || epochOf.get(liveries) !== cacheEpoch) {
    liveries = new Map();
    epochOf.set(liveries, cacheEpoch);
    carCache.set(asset, liveries);
  }
  return liveries;
}

/** Put a car prepared elsewhere (a bake worker) into `prepareCar`'s cache.
 * An entry already there wins. */
export function adoptPreparedCar(asset: CarAsset, livery: number, prepared: PreparedCar): void {
  const liveries = carLiveries(asset);
  if (!liveries.has(livery)) liveries.set(livery, prepared);
}

/** Whether `prepareCar(asset, livery)` would be a cache hit. */
export function hasPreparedCar(asset: CarAsset, livery = 0): boolean {
  return carLiveries(asset).has(livery);
}

/** Run a car's builder for one livery, bake every part, finalize. Cached. */
export function prepareCar(asset: CarAsset, livery = 0): PreparedCar {
  const liveries = carLiveries(asset);
  const hit = liveries.get(livery);
  if (hit) return hit;

  const t0 = now();
  const geo = asset.build(livery);
  const t1 = now();
  const rays = assembleSettings.carRays;
  let aoMs = 0;
  let finalizeMs = 0;

  // One PreparedMesh per distinct SolidMesh OBJECT: an asset that hands the
  // same spring mesh to all four corners gets one bake, one vertex buffer and
  // (in instantiateCar) one draw call for the four.
  // Of a car only the BODY is refined for the bake (flat floor pans, slab
  // sides), by at most half again and within the share of the budget the
  // builder left unused. Wheels, hubs and links are small round parts whose
  // long edges run along cylinders — splitting those buys nothing.
  const authoredTotal =
    geo.body.triangleCount +
    (geo.driver?.triangleCount ?? 0) +
    2 * (geo.wheelFront.triangleCount + geo.wheelRear.triangleCount) +
    2 * ((geo.hubFront?.triangleCount ?? 0) + (geo.hubRear?.triangleCount ?? 0)) +
    geo.links.reduce((n, l) => n + l.mesh.triangleCount, 0) +
    geo.spinners.reduce((n, s) => n + s.mesh.triangleCount, 0) +
    (geo.steeringWheel?.mesh.triangleCount ?? 0);
  const growth = Math.min(1.5, Math.max(1, asset.triBudget / Math.max(1, authoredTotal)));
  const done = new Map<SolidMesh, PreparedMesh>();
  const part = (m: SolidMesh): PreparedMesh => {
    let p = done.get(m);
    if (!p) {
      const authored = m.triangleCount;
      const bake = bakeAlone(m, rays, false, 0);
      aoMs += bake.ms;
      const f0 = now();
      p = finalize(m, bake.ao, bake.ms, authored);
      finalizeMs += now() - f0;
      done.set(m, p);
    }
    return p;
  };
  // The left side is a mirrored COPY of the baked right-hand part (mirroring
  // keeps the AO), so the detailed outboard face ends up outboard and both
  // sides shade identically. Baked into the vertices rather than a negative
  // node scale: a mirrored world matrix would flip face culling per draw
  // and rule out instancing.
  const mirrored = new Map<SolidMesh, PreparedMesh>();
  const leftOf = (m: SolidMesh): PreparedMesh => {
    let p = mirrored.get(m);
    if (!p) {
      const right = part(m); // bakes m first
      const f0 = now();
      p = finalize(m.clone().mirror('x'), right.ao, 0, right.authoredTriangles);
      finalizeMs += now() - f0;
      mirrored.set(m, p);
    }
    return p;
  };

  const wheels: PreparedCar['wheels'] = [
    leftOf(geo.wheelFront),
    part(geo.wheelFront),
    leftOf(geo.wheelRear),
    part(geo.wheelRear),
  ];
  const hubs: PreparedCar['hubs'] = [
    geo.hubFront ? leftOf(geo.hubFront) : null,
    geo.hubFront ? part(geo.hubFront) : null,
    geo.hubRear ? leftOf(geo.hubRear) : null,
    geo.hubRear ? part(geo.hubRear) : null,
  ];

  // Body: bake inside a temporary scene of body + wheels + hubs at the static
  // pose, sampling ONLY the body (the wheels and hubs occlude, but their own
  // values were baked above and would be thrown away here). The body's
  // triangles come first in the temporary mesh, so its AO is the head of the
  // result.
  let bodyAO: PreparedMesh['ao'] = 'off';
  let bodyAoMs = 0;
  const bodyAuthored = geo.body.triangleCount;
  if (hasAuthoredAO(geo.body)) {
    bodyAO = 'builder';
  } else if (assembleSettings.ao && geo.body.triangleCount > 0) {
    refineForAO(geo.body, Math.floor(bodyAuthored * growth));
    const stage = geo.body.clone();
    const rest = hubRestPositions(asset.spec);
    for (let i = 0; i < 4; i++) {
      const wheel = i < 2 ? geo.wheelFront : geo.wheelRear;
      const hub = i < 2 ? geo.hubFront : geo.hubRear;
      const place = i % 2 === 0 ? Matrix.Scaling(-1, 1, 1).multiply(Matrix.Translation(...rest[i])) : Matrix.Translation(...rest[i]);
      stage.append(wheel, place);
      if (hub) stage.append(hub, place);
    }
    const stats = bakeAO(stage, { rays, ground: true, only: [0, geo.body.triangleCount] });
    geo.body.writeAO(stage.cornerAO);
    bodyAO = 'baked';
    bodyAoMs = stats.ms;
    aoMs += stats.ms;
  }
  const f0 = now();
  const body = finalize(geo.body, bodyAO, bodyAoMs, bodyAuthored);
  finalizeMs += now() - f0;

  // Driver: rigid on the body, so the body is a valid occluder for it (seat
  // and tub darken its back and legs) — sampled on the driver only, with a
  // short reach so sitting in the cockpit does not grey the whole figure.
  let driver: PreparedMesh | null = null;
  if (geo.driver) {
    const d = geo.driver;
    let ao: PreparedMesh['ao'] = 'off';
    let ms = 0;
    if (hasAuthoredAO(d)) {
      ao = 'builder';
    } else if (assembleSettings.ao && d.triangleCount > 0) {
      const stage = d.clone().append(geo.body);
      ms = bakeAO(stage, { rays, maxDistance: 0.3, only: [0, d.triangleCount] }).ms;
      d.writeAO(stage.cornerAO);
      ao = 'baked';
      aoMs += ms;
    }
    const d0 = now();
    driver = finalize(d, ao, ms);
    finalizeMs += now() - d0;
  }

  const links = geo.links.map((l) => part(l.mesh));
  const spinners = geo.spinners.map((s) => part(s.mesh));
  const steeringWheel = geo.steeringWheel ? part(geo.steeringWheel.mesh) : null;

  let triangles = body.triangles + (driver?.triangles ?? 0);
  for (const w of wheels) triangles += w.triangles;
  for (const h of hubs) triangles += h?.triangles ?? 0;
  for (const l of links) triangles += l.triangles;
  for (const s of spinners) triangles += s.triangles;
  triangles += steeringWheel?.triangles ?? 0;

  const prepared: PreparedCar = {
    livery,
    body,
    driver,
    wheels,
    hubs,
    links,
    spinners,
    steeringWheel,
    layout: {
      links: geo.links.map((l) => ({ wheel: l.wheel, bodyAnchor: l.bodyAnchor, hubAnchor: l.hubAnchor, mode: l.mode })),
      spinners: geo.spinners.map((sp) => ({ pivot: sp.pivot, axis: sp.axis, idleSpeed: sp.idleSpeed, fullSpeed: sp.fullSpeed })),
      steeringWheel: geo.steeringWheel ? { pivot: geo.steeringWheel.pivot, axis: geo.steeringWheel.axis } : null,
    },
    triangles,
    buildMs: t1 - t0,
    aoMs,
    finalizeMs,
  };
  liveries.set(livery, prepared);
  return prepared;
}
