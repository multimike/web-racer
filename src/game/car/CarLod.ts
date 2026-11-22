import { Mesh, VertexData } from '@babylonjs/core';
import type { AbstractMesh, Scene } from '@babylonjs/core';
import { toyMaterial } from '../../assets/assemble';
import type { CarInstance, PreparedMesh } from '../../assets/assemble';
import { getLook } from '../../gfx/look/lighting';
import type { SolidVertexData } from '../../gfx/solid/SolidMesh';
import type { CarLodLevel } from '../contracts/car';
import type { SimplifyMesh } from '../contracts/props';
import { liteTarget } from './lite';

/**
 * Level of detail of one game car:
 *
 *   level  when (eye → car)       shown                                    sun-shadow casters
 *   0      < lodDistances[0]      everything                               body, driver, 4 wheels
 *   1      < lodDistances[1]      body, driver, wheels, spinners           body, driver, 4 wheels
 *   2      beyond                 LITE body, driver, wheels                lite body, 4 lite wheels
 *
 * Links, uprights (hubs) and the steering wheel go at level 1; they are the
 * many small draw calls of a car. A wheel is one draw call each (front / rear
 * sizes, left ones mirrored = four meshes), so six is the floor for a car
 * whose wheels still turn and steer.
 *
 * The lite meshes exist only when a `simplify` function is given and are
 * built here, at creation, so switching never hitches mid-race. Without them
 * level 2 shows what level 1 shows.
 *
 * Switching uses a 10 % hysteresis band around each distance (±5 %), so a
 * car hovering at a threshold does not flicker between levels.
 *
 * Casters: the full set (body, driver, 4 wheels) and the lite set (lite body,
 * 4 lite wheels) are registered ONCE at creation and removed at dispose. The
 * shadow depth pass skips disabled meshes, so only the set of the level shown
 * casts. (Swapping them on every level change leaked one dispose observer per
 * add in the shadow module.)
 */

export interface CarLodOptions {
  lodDistances: [number, number];
  simplify?: SimplifyMesh;
  liteRatio: number;
  castShadows: boolean;
}

/** Simplified data per simplifier, prepared mesh and target, shared by every
 * car of the same design and livery (rivals, restarts). */
const liteCache = new WeakMap<SimplifyMesh, WeakMap<PreparedMesh, Map<number, SolidVertexData>>>();

function liteMap(prepared: PreparedMesh, simplify: SimplifyMesh): Map<number, SolidVertexData> {
  let perMesh = liteCache.get(simplify);
  if (!perMesh) {
    perMesh = new WeakMap();
    liteCache.set(simplify, perMesh);
  }
  let perTarget = perMesh.get(prepared);
  if (!perTarget) {
    perTarget = new Map();
    perMesh.set(prepared, perTarget);
  }
  return perTarget;
}

function liteData(prepared: PreparedMesh, simplify: SimplifyMesh, ratio: number): SolidVertexData {
  const target = liteTarget(prepared.triangles, ratio);
  const perTarget = liteMap(prepared, simplify);
  let data = perTarget.get(target);
  if (!data) {
    data = simplify(prepared.data, target);
    perTarget.set(target, data);
  }
  return data;
}

/** Put a lite mesh simplified elsewhere (a bake worker of the game's boot:
 * the same simplifier on the same prepared data and target) into the cache
 * the LOD reads. */
export function adoptLiteData(prepared: PreparedMesh, simplify: SimplifyMesh, ratio: number, data: SolidVertexData): void {
  const perTarget = liteMap(prepared, simplify);
  const target = liteTarget(prepared.triangles, ratio);
  if (!perTarget.has(target)) perTarget.set(target, data);
}

/** The cached lite data of a prepared part, if any (boot checks). */
export function peekLiteData(prepared: PreparedMesh, simplify: SimplifyMesh, ratio: number): SolidVertexData | undefined {
  return liteCache.get(simplify)?.get(prepared)?.get(liteTarget(prepared.triangles, ratio));
}

function buildLite(name: string, data: SolidVertexData, scene: Scene): Mesh {
  const vd = new VertexData();
  vd.positions = data.positions;
  vd.normals = data.normals;
  vd.colors = data.colors;
  vd.uvs = data.uvs;
  vd.uvs2 = data.uvs2;
  vd.indices = data.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh, false);
  // Vertex alpha is the EMISSIVE amount (headlights), not opacity: without
  // this the mesh would go to the blended pass with depth writes off.
  mesh.hasVertexAlpha = false;
  mesh.applyFog = false; // the toy shader fogs itself
  mesh.material = toyMaterial(scene);
  mesh.isPickable = false;
  return mesh;
}

function trianglesOf(meshes: readonly AbstractMesh[]): number {
  let n = 0;
  for (const m of meshes) n += m.getTotalIndices() / 3;
  return n;
}

export class CarLod {
  /** Level currently shown. */
  level: CarLodLevel = 0;
  /** Force a level; null = by distance. */
  override: CarLodLevel | null = null;
  readonly distances: [number, number];
  /** Triangles drawn (main pass) at each level. */
  readonly trianglesAt: [number, number, number];
  /** Lite meshes (null without a simplifier): body, driver, wheels FL FR RL RR. */
  readonly liteBody: Mesh | null = null;
  readonly liteDriver: Mesh | null = null;
  readonly liteWheels: Mesh[] = [];

  private readonly instance: CarInstance;
  private readonly scene: Scene;
  private readonly castShadows: boolean;
  private readonly casters: AbstractMesh[];
  private readonly lite: AbstractMesh[] = [];
  private castersAdded = false;
  private applied = -1;

  constructor(scene: Scene, instance: CarInstance, options: CarLodOptions) {
    this.scene = scene;
    this.instance = instance;
    this.distances = [options.lodDistances[0], options.lodDistances[1]];
    this.castShadows = options.castShadows;

    const prepared = instance.prepared;
    const name = instance.asset.id;
    if (options.simplify) {
      const simplify = options.simplify;
      const ratio = options.liteRatio;
      const body = buildLite(`${name}.lite.body`, liteData(prepared.body, simplify, ratio), scene);
      body.parent = instance.root;
      this.liteBody = body;
      this.lite.push(body);
      if (prepared.driver && instance.driver) {
        const driver = buildLite(`${name}.lite.driver`, liteData(prepared.driver, simplify, ratio), scene);
        driver.parent = instance.root;
        this.liteDriver = driver;
        this.lite.push(driver);
      }
      const corner = ['FL', 'FR', 'RL', 'RR'];
      for (let i = 0; i < 4; i++) {
        const wheel = buildLite(`${name}.lite.wheel${corner[i]}`, liteData(prepared.wheels[i], simplify, ratio), scene);
        wheel.parent = instance.hubNodes[i];
        this.liteWheels.push(wheel);
        this.lite.push(wheel);
      }
      for (const m of this.lite) m.setEnabled(false);
    }

    const core: AbstractMesh[] = [instance.body, ...instance.wheels];
    if (instance.driver) core.push(instance.driver);
    this.casters = this.liteBody ? [...core, this.liteBody, ...this.liteWheels] : core;

    const t0 = trianglesOf(instance.meshes());
    const t1 = trianglesOf([...core, ...instance.spinners]);
    const t2 = this.liteBody ? trianglesOf(this.lite) : t1;
    this.trianglesAt = [t0, t1, t2];
    this.apply(0);
    if (this.castShadows) {
      const shadows = getLook(scene).shadows;
      for (const m of this.casters) shadows.addCaster(m);
      this.castersAdded = true;
    }
  }

  /** The lite meshes are what is drawn (level 2 with a simplifier). */
  get showsLite(): boolean {
    return this.level === 2 && this.liteBody !== null;
  }

  get triangles(): number {
    return this.trianglesAt[this.level];
  }

  /** Level for an eye at `distance` m, with hysteresis around the current
   * level; applies it. Returns the level shown. */
  choose(distance: number): CarLodLevel {
    let next: CarLodLevel;
    if (this.override !== null) {
      next = this.override;
    } else {
      const [d0, d1] = this.distances;
      const L = this.level;
      if (!Number.isFinite(distance)) next = L;
      else if (L === 0) next = distance > d1 * 1.05 ? 2 : distance > d0 * 1.05 ? 1 : 0;
      else if (L === 1) next = distance > d1 * 1.05 ? 2 : distance < d0 * 0.95 ? 0 : 1;
      else next = distance < d0 * 0.95 ? 0 : distance < d1 * 0.95 ? 1 : 2;
    }
    if (next !== this.applied) this.apply(next);
    return next;
  }

  /** Copy the wheels' spin onto the lite wheels (they hang off the same
   * non-spinning hub nodes). Only while level 2 is shown. */
  syncLite(): void {
    if (!this.showsLite) return;
    const wheels = this.instance.wheels;
    for (let i = 0; i < this.liteWheels.length; i++) this.liteWheels[i].rotation.x = wheels[i].rotation.x;
  }

  dispose(): void {
    if (this.castersAdded) {
      const shadows = getLook(this.scene).shadows;
      for (const m of this.casters) shadows.removeCaster(m);
      this.castersAdded = false;
    }
    for (const m of this.lite) m.dispose(false, false);
    this.lite.length = 0;
  }

  private apply(level: CarLodLevel): void {
    const inst = this.instance;
    const lite = level === 2 && this.liteBody !== null;
    const full = !lite;
    inst.setPartEnabled('body', full);
    inst.setPartEnabled('driver', full);
    inst.setPartEnabled('wheels', full);
    inst.setPartEnabled('spinners', full);
    inst.setPartEnabled('hubs', full && level === 0);
    inst.setPartEnabled('links', full && level === 0);
    inst.setPartEnabled('steeringWheel', full && level === 0);
    for (const m of this.lite) m.setEnabled(lite);
    this.level = level;
    this.applied = level;
    this.syncLite();
  }
}
