import { Geometry, Matrix, Mesh, Quaternion, TransformNode, Vector3, VertexData } from '@babylonjs/core';
import type { AbstractMesh, Scene, ShaderMaterial } from '@babylonjs/core';
import { hubRestPositions, prepareCar, prepareProp } from '../boot/prepare';
import type { CarLayout, PreparedCar, PreparedMesh } from '../boot/prepare';
import { getLook } from '../gfx/look/lighting';
import type { ContactOccluder } from '../gfx/look/lighting';
import { createToyMaterial } from '../gfx/look/ToyMaterial';
import type { CarAsset, PropAsset, WheelIndex } from './types';

/**
 * Assembly: turns the pure-geometry assets of `types.ts` into Babylon meshes
 * with the toy material. The asset lab and the game both go through here, so
 * what is reviewed is what ships.
 *
 *   const tree = instantiateProp(scene, oak, 3);              // seed 3
 *   const car  = instantiateCar(scene, reefRocket, 0);        // livery 0, assembled at rest
 *   car.root.parent = chassisNode;
 *   // every frame:
 *   car.setWheelFromWorld(i, wheelBodyMesh.getWorldMatrix()); // or setWheelPose(i, pos, steer, spin)
 *   car.update(dt, throttle, steer);                          // links, spinners, steering wheel
 *
 * TWO STAGES, so the expensive part runs once:
 *  1. PREPARE (CPU, cached): run the builder, bake ambient occlusion, weld
 *     and index. Keyed by the asset OBJECT and (seed, scheme) / (livery); a
 *     second call is free. The game's boot runs this stage in bake workers
 *     (src/boot/bakePool.ts) and adopts the results into the same cache.
 *  2. INSTANTIATE (GPU): meshes built from one prepared mesh in one scene
 *     share a single vertex buffer; identical parts inside one car (the same
 *     `SolidMesh` object used for several links or wheels) become Babylon
 *     instances and draw in one call.
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
// Stage 1 — settings and prepared geometry: src/boot/prepare.ts (renderer-
// free, so the bake workers can run it). Re-exported here, so
// importing it from the assembler keeps working.

export {
  adoptPreparedCar,
  adoptPreparedProp,
  assembleSettings,
  clearAssembleCache,
  hasPreparedCar,
  hubRestPositions,
  prepareCar,
  prepareProp,
} from '../boot/prepare';
export type { AssembleSettings, CarLayout, PreparedCar, PreparedMesh, PreparedProp } from '../boot/prepare';

// ---------------------------------------------------------------------------
// Stage 2 — Babylon meshes

export interface InstantiateOptions {
  /** Register the meshes as sun-shadow casters with the scene's look runtime
   * (default true; harmless while shadows are off). */
  castShadows?: boolean;
  /** Props only: use the thin-instance variant of the toy material. The
   * caller then adds the thin instances AND both per-instance buffers the
   * shader reads, `instanceTint` (vec3) and `instanceShade` (vec2: AO, sun
   * visibility) — a missing one reads as 0 and the mesh renders black. */
  instanced?: boolean;
}

const toyMaterials = new WeakMap<Scene, Map<string, ShaderMaterial>>();

/** The scene's shared toy material (one per variant, created on first use). */
export function toyMaterial(scene: Scene, options: { wind?: boolean; instanced?: boolean } = {}): ShaderMaterial {
  let perScene = toyMaterials.get(scene);
  if (!perScene) {
    perScene = new Map();
    toyMaterials.set(scene, perScene);
  }
  const key = `${options.wind ? 'w' : ''}${options.instanced ? 'i' : ''}`;
  let mat = perScene.get(key);
  if (!mat) {
    mat = createToyMaterial(scene, { wind: options.wind, instanced: options.instanced });
    perScene.set(key, mat);
  }
  return mat;
}

const geometries = new WeakMap<Scene, WeakMap<PreparedMesh, Geometry>>();
let geometryId = 0;

/**
 * A new Mesh on the prepared mesh's GPU geometry — shared between all plain
 * meshes of that prepared mesh in the scene, or `ownGeometry` for a mesh
 * that will carry THIN INSTANCES: Babylon keeps thin-instance buffers
 * (world0..3, instanceTint, instanceShade) on the Geometry, so two
 * thin-instanced meshes sharing one would silently overwrite each other's
 * placements.
 */
function meshFrom(name: string, prepared: PreparedMesh, scene: Scene, material: ShaderMaterial, ownGeometry = false): Mesh {
  let perScene = geometries.get(scene);
  if (!perScene) {
    perScene = new WeakMap();
    geometries.set(scene, perScene);
  }
  let geometry = ownGeometry ? undefined : perScene.get(prepared);
  // Babylon disposes a Geometry when its last mesh goes; then rebuild it.
  if (!geometry || geometry.isDisposed()) {
    const d = prepared.data;
    const vd = new VertexData();
    vd.positions = d.positions;
    vd.normals = d.normals;
    vd.colors = d.colors;
    vd.uvs = d.uvs;
    vd.uvs2 = d.uvs2;
    vd.indices = d.indices;
    geometry = new Geometry(`asset-geometry-${geometryId++}`, scene, vd, false);
    if (!ownGeometry) perScene.set(prepared, geometry);
  }
  const mesh = new Mesh(name, scene);
  geometry.applyToMesh(mesh);
  // Vertex alpha is the EMISSIVE amount; Babylon would otherwise treat the
  // mesh as transparent (blended pass, depth writes off).
  mesh.hasVertexAlpha = false;
  mesh.material = material;
  mesh.applyFog = false; // fog is done in the toy shader
  return mesh;
}

/**
 * One variant of a prop / building as a Mesh with the toy material (the wind
 * variant when `asset.wind`), origin on the ground contact centre. For
 * hundreds of copies call it with `instanced: true` and add thin instances
 * to that mesh, rather than calling it per copy. Every `instanced` call
 * returns a mesh with its OWN vertex buffers, so one variant can be split
 * into several thin-instanced chunks (for culling, or scatter and village
 * dressing each placing the same rock) without the chunks clobbering each
 * other's instance data.
 */
export function instantiateProp(
  scene: Scene,
  asset: PropAsset,
  seed = 0,
  scheme?: string,
  options: InstantiateOptions = {},
): Mesh {
  const prepared = prepareProp(asset, seed, scheme);
  const wind = asset.wind ?? false;
  const material = toyMaterial(scene, { wind, instanced: options.instanced });
  const mesh = meshFrom(`${asset.id}#${seed}`, prepared.mesh, scene, material, options.instanced ?? false);
  mesh.metadata = { assetId: asset.id, seed, scheme: prepared.scheme };
  if (options.castShadows ?? true) getLook(scene).shadows.addCaster(mesh, { wind });
  return mesh;
}

/**
 * The contact pool of a car for the look runtime (`look.contacts`): the soft
 * ambient-occlusion patch on the ground under it. Call every frame with the
 * same `out` object once the car's root has moved:
 *   const pool = carContact(car);  look.contacts.push(pool);
 *   // per frame:  carContact(car, pool);
 */
export function carContact(car: CarInstance, out: ContactOccluder = { x: 0, z: 0, yaw: 0, halfX: 0, halfZ: 0, y: 0 }): ContactOccluder {
  const m = car.root.computeWorldMatrix(true).m;
  const spec = car.asset.spec;
  out.x = m[12];
  out.z = m[14];
  out.y = m[13];
  // World direction of the model's +z (the nose).
  out.yaw = Math.atan2(m[8], m[10]);
  out.halfX = spec.width * 0.46;
  out.halfZ = spec.length * 0.45;
  return out;
}

/** Instantiate a car, fully assembled at its static pose. */
export function instantiateCar(scene: Scene, asset: CarAsset, livery = 0, options: InstantiateOptions = {}): CarInstance {
  return new CarInstance(scene, asset, livery, options);
}

// ---------------------------------------------------------------------------
// Car instance

export type CarPart = 'body' | 'driver' | 'wheels' | 'hubs' | 'links' | 'spinners' | 'steeringWheel';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Per-link constants worked out once at the static pose. */
interface LinkState {
  link: CarLayout['links'][number];
  mesh: AbstractMesh;
  body: Vector3;
  hub: Vector3;
  /** Unit aim direction and the mesh's three axes at the static pose. */
  dir0: Vector3;
  x0: Vector3;
  y0: Vector3;
  z0: Vector3;
}

interface SpinnerState {
  mesh: AbstractMesh;
  axis: Vector3;
  idle: number;
  full: number;
  speed: number;
  angle: number;
}

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);
// Scratch — the pose code runs for every link of every car every frame.
const T0 = new Vector3();
const T1 = new Vector3();
const T2 = new Vector3();
const T3 = new Vector3();
const T4 = new Vector3();
const T5 = new Vector3();
const TM = new Matrix();
const TM2 = new Matrix();

/**
 * A car in a scene. All positions and angles handed to it are in MODEL SPACE
 * — the space of `root`: origin on the ground under the wheelbase centre at
 * static ride height, +x right, +y up, +z nose. Angles are RADIANS (this is
 * the runtime side; only the geometry kit works in degrees).
 *
 * Node tree:
 *   root (TransformNode — parent it to the chassis)
 *   ├─ body
 *   ├─ driver                optional; rigid, same space as the body
 *   ├─ hubNodes[0..3]        non-spinning hub frames: position + steer/camber
 *   │   ├─ wheels[i]         spins about its local X
 *   │   └─ hubMeshes[i]      upright / brake, does not spin
 *   ├─ links[..]             re-posed by updateLinks()
 *   ├─ spinners[..]
 *   └─ steeringWheel
 *
 * Sign conventions (same as the vehicle code): positive steer turns the
 * wheel's nose to the RIGHT (+z toward +x); positive spin is FORWARD roll.
 */
export class CarInstance {
  readonly asset: CarAsset;
  readonly livery: number;
  readonly prepared: PreparedCar;
  readonly root: TransformNode;
  readonly body: Mesh;
  /** The driver figure, when the asset has one (`setPartEnabled('driver', false)` hides it). */
  readonly driver: Mesh | null = null;
  readonly hubNodes: TransformNode[] = [];
  readonly wheels: AbstractMesh[] = [];
  readonly hubMeshes: (AbstractMesh | null)[] = [];
  /** Parallel to `prepared.layout.links`. */
  readonly links: AbstractMesh[] = [];
  readonly spinners: AbstractMesh[] = [];
  readonly steeringWheel: AbstractMesh | null = null;
  /** Hub centres at the static pose (model space), FL FR RL RR. */
  readonly restHubs: Vector3[];
  /** Hand-wheel angle per radian of road-wheel steer. */
  steeringRatio = 4;
  /** Seconds for a spinner to follow a throttle change (63 %). */
  spinnerLag = 0.35;

  private readonly linkStates: LinkState[] = [];
  private readonly spinnerStates: SpinnerState[] = [];
  private steeringAxes: { x: Vector3; y: Vector3; z: Vector3; sign: number } | null = null;

  constructor(scene: Scene, asset: CarAsset, livery = 0, options: InstantiateOptions = {}) {
    this.asset = asset;
    this.livery = livery;
    const prepared = prepareCar(asset, livery);
    this.prepared = prepared;
    const layout = prepared.layout;
    const material = toyMaterial(scene);
    const name = asset.id;

    this.root = new TransformNode(`${name}.root`, scene);
    this.root.metadata = { assetId: asset.id, livery };

    // First use of a prepared mesh inside this car is a real Mesh, every
    // further use an instance of it: one draw call per distinct part.
    const sources = new Map<PreparedMesh, Mesh>();
    const make = (label: string, p: PreparedMesh): AbstractMesh => {
      const source = sources.get(p);
      if (source) return source.createInstance(`${name}.${label}`);
      const mesh = meshFrom(`${name}.${label}`, p, scene, material);
      sources.set(p, mesh);
      return mesh;
    };

    this.body = meshFrom(`${name}.body`, prepared.body, scene, material);
    this.body.parent = this.root;
    if (prepared.driver) {
      this.driver = meshFrom(`${name}.driver`, prepared.driver, scene, material);
      this.driver.parent = this.root;
    }

    this.restHubs = hubRestPositions(asset.spec).map((p) => new Vector3(p[0], p[1], p[2]));
    const corner = ['FL', 'FR', 'RL', 'RR'];
    for (let i = 0; i < 4; i++) {
      const node = new TransformNode(`${name}.hub${corner[i]}`, scene);
      node.parent = this.root;
      node.position.copyFrom(this.restHubs[i]);
      node.rotationQuaternion = Quaternion.Identity();
      this.hubNodes.push(node);

      const wheel = make(`wheel${corner[i]}`, prepared.wheels[i]);
      wheel.parent = node;
      this.wheels.push(wheel);

      const hp = prepared.hubs[i];
      const hub = hp ? make(`upright${corner[i]}`, hp) : null;
      if (hub) hub.parent = node;
      this.hubMeshes.push(hub);
    }

    layout.links.forEach((link, i) => {
      const mesh = make(`link${i}.${corner[link.wheel]}`, prepared.links[i]);
      mesh.parent = this.root;
      mesh.rotationQuaternion = Quaternion.Identity();
      this.links.push(mesh);
      this.linkStates.push(this.linkRest(link, mesh));
    });

    layout.spinners.forEach((s, i) => {
      const mesh = make(`spinner${i}`, prepared.spinners[i]);
      mesh.parent = this.root;
      mesh.position.set(s.pivot[0], s.pivot[1], s.pivot[2]);
      mesh.rotationQuaternion = Quaternion.Identity();
      this.spinners.push(mesh);
      this.spinnerStates.push({
        mesh,
        axis: new Vector3(s.axis[0], s.axis[1], s.axis[2]).normalize(),
        idle: s.idleSpeed,
        full: s.fullSpeed,
        speed: s.idleSpeed,
        angle: 0,
      });
    });

    if (layout.steeringWheel && prepared.steeringWheel) {
      const sw = layout.steeringWheel;
      const mesh = make('steeringWheel', prepared.steeringWheel);
      mesh.parent = this.root;
      mesh.position.set(sw.pivot[0], sw.pivot[1], sw.pivot[2]);
      mesh.rotationQuaternion = Quaternion.Identity();
      this.steeringWheel = mesh;
      // Local +Z (the rim's normal) goes onto the column axis, local +Y (the
      // top of the wheel) as far up as the column allows.
      const z = new Vector3(sw.axis[0], sw.axis[1], sw.axis[2]).normalize();
      const y = AXIS_Y.subtract(z.scale(Vector3.Dot(AXIS_Y, z)));
      if (y.lengthSquared() < 1e-8) y.copyFrom(AXIS_Z); // vertical column
      y.normalize();
      const x = Vector3.Cross(y, z);
      // Steering right must carry the TOP of the wheel toward the car's
      // right, whichever way the author pointed the column axis.
      this.steeringAxes = { x, y, z, sign: x.x >= 0 ? 1 : -1 };
    }

    if (options.castShadows ?? true) {
      const shadows = getLook(scene).shadows;
      for (const mesh of this.meshes()) shadows.addCaster(mesh);
    }

    this.setSteering(0);
    this.updateLinks();
  }

  // -------------------------------------------------------------------------
  // Posing

  /**
   * Place wheel `i`: hub centre in model space, steer angle about the model's
   * up axis, spin angle about the axle. Call `updateLinks()` (or `update`)
   * after moving wheels.
   */
  setWheelPose(i: WheelIndex | number, position: Vec3Like, steer = 0, spin = 0): void {
    const node = this.hubNodes[i];
    node.position.set(position.x, position.y, position.z);
    Quaternion.RotationAxisToRef(AXIS_Y, steer, node.rotationQuaternion!);
    this.wheels[i].rotation.x = spin;
  }

  /**
   * Place wheel `i` with an arbitrary NON-SPINNING hub frame (model space):
   * `rotation` turns the hub frame's axes (x = axle toward the car's right,
   * y = up, z = forward), so it can carry camber and toe as well as steer.
   */
  setHubTransform(i: WheelIndex | number, position: Vec3Like, rotation: Quaternion, spin = 0): void {
    const node = this.hubNodes[i];
    node.position.set(position.x, position.y, position.z);
    node.rotationQuaternion!.copyFrom(rotation);
    this.wheels[i].rotation.x = spin;
  }

  /**
   * Place wheel `i` from the WORLD matrix of a spinning wheel body (the
   * physics wheel: local X = axle, either direction). The hub frame keeps the
   * axle and stays upright relative to the car; whatever rotation is left
   * about the axle becomes the spin. Needs `root`'s world matrix up to date.
   */
  setWheelFromWorld(i: WheelIndex | number, world: Matrix): void {
    this.root.getWorldMatrix().invertToRef(TM);
    const m = world.multiplyToRef(TM, TM2).m;
    const axle = T0.set(m[0], m[1], m[2]).normalize();
    // The body's X axis may point at either side of the car; the hub frame's
    // x always points to the car's right.
    if (axle.x < 0) axle.scaleInPlace(-1);
    const fwd = Vector3.CrossToRef(axle, AXIS_Y, T1).normalize();
    const up = Vector3.CrossToRef(fwd, axle, T2);
    const node = this.hubNodes[i];
    node.position.set(m[12], m[13], m[14]);
    Quaternion.RotationQuaternionFromAxisToRef(axle, up, fwd, node.rotationQuaternion!);
    // The wheel body's Y axis, seen in the hub frame, is (0, cos, sin) of the
    // spin angle — independent of which way its X axis points.
    const wy = T3.set(m[4], m[5], m[6]);
    this.wheels[i].rotation.x = Math.atan2(Vector3.Dot(wy, fwd), Vector3.Dot(wy, up));
  }

  /**
   * Review pose: wheels at their static positions raised by `bump` meters
   * (one number, or one per wheel; positive = compression), front wheels
   * steered by `steer`, all wheels spun to `spin`. Links follow.
   */
  setReviewPose(pose: { steer?: number; bump?: number | readonly number[]; spin?: number } = {}): void {
    for (let i = 0; i < 4; i++) {
      const bump = typeof pose.bump === 'number' ? pose.bump : (pose.bump?.[i] ?? 0);
      const rest = this.restHubs[i];
      this.setWheelPose(i, T4.set(rest.x, rest.y + bump, rest.z), i < 2 ? (pose.steer ?? 0) : 0, pose.spin ?? 0);
    }
    this.setSteering(pose.steer ?? 0);
    this.updateLinks();
  }

  /** Turn the steering wheel for a road-wheel steer angle (positive = right). */
  setSteering(steer: number): void {
    const s = this.steeringAxes;
    const mesh = this.steeringWheel;
    if (!s || !mesh) return;
    const a = steer * this.steeringRatio * s.sign;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Rotate the rim's x/y axes within its own plane.
    const x = T0.set(s.x.x * c - s.y.x * sn, s.x.y * c - s.y.y * sn, s.x.z * c - s.y.z * sn);
    const y = T1.set(s.y.x * c + s.x.x * sn, s.y.y * c + s.x.y * sn, s.y.z * c + s.x.z * sn);
    Quaternion.RotationQuaternionFromAxisToRef(x, y, s.z, mesh.rotationQuaternion!);
  }

  /** Advance the spinners by `dt` seconds at `throttle` 0..1. */
  advanceSpinners(dt: number, throttle: number): void {
    const t = Math.min(Math.max(throttle, 0), 1);
    const follow = this.spinnerLag > 0 ? 1 - Math.exp(-dt / this.spinnerLag) : 1;
    for (const s of this.spinnerStates) {
      const target = s.idle + (s.full - s.idle) * t;
      s.speed += (target - s.speed) * follow;
      // Wrapped so the angle keeps float precision over a long session.
      s.angle = (s.angle + s.speed * dt) % (Math.PI * 2);
      Quaternion.RotationAxisToRef(s.axis, s.angle, s.mesh.rotationQuaternion!);
    }
  }

  /** The per-frame call once the wheels are placed: links, spinners,
   * steering wheel. */
  update(dt: number, throttle: number, steer: number): void {
    this.updateLinks();
    this.advanceSpinners(dt, throttle);
    this.setSteering(steer);
  }

  /**
   * Re-pose every link between its body anchor and its hub anchor (which
   * moves and steers with the hub):
   *  - 'stretch'  origin on the body anchor, −Y aimed at the hub anchor,
   *               Y scaled to the span (the mesh is unit length);
   *  - 'fromBody' origin on the body anchor, −Y aimed at the hub anchor;
   *  - 'fromHub'  origin on the hub anchor, −Y aimed at the body anchor.
   * ROLL about the link's own axis is fixed at the static pose — local +Z as
   * far FORWARD as the direction allows (links running within ~37° of
   * fore-aft: local +X to the car's right instead) — and from there the link
   * turns by the smallest rotation that keeps it aimed, so a flat wishbone
   * stays flat and nothing ever flips.
   */
  updateLinks(): void {
    for (const s of this.linkStates) {
      const node = this.hubNodes[s.link.wheel];
      const hub = s.hub.rotateByQuaternionToRef(node.rotationQuaternion!, T0).addInPlace(node.position);
      const fromHub = s.link.mode === 'fromHub';
      const origin = fromHub ? hub : s.body;
      const target = fromHub ? s.body : hub;
      const dir = target.subtractToRef(origin, T1);
      const span = dir.length();
      if (span < 1e-9) continue;
      dir.scaleInPlace(1 / span);

      // Rodrigues' rotation carrying dir0 onto dir, applied to the rest axes:
      //   R(u) = u·c + (v × u) + v·(v·u) / (1 + c),  v = dir0 × dir, c = dir0·dir
      const v = Vector3.CrossToRef(s.dir0, dir, T2);
      const c = Vector3.Dot(s.dir0, dir);
      const k = c > -0.999999 ? 1 / (1 + c) : 0;
      const x = turn(s.x0, v, c, k, T3);
      const z = turn(s.z0, v, c, k, T4);
      const y = T5.copyFrom(dir).scaleInPlace(-1);

      s.mesh.position.copyFrom(origin);
      Quaternion.RotationQuaternionFromAxisToRef(x, y, z, s.mesh.rotationQuaternion!);
      if (s.link.mode === 'stretch') s.mesh.scaling.y = span;
    }
  }

  // -------------------------------------------------------------------------
  // Bookkeeping

  /** Every renderable mesh of the car. */
  meshes(): AbstractMesh[] {
    const out: AbstractMesh[] = [this.body, ...this.wheels];
    if (this.driver) out.push(this.driver);
    for (const h of this.hubMeshes) if (h) out.push(h);
    out.push(...this.links, ...this.spinners);
    if (this.steeringWheel) out.push(this.steeringWheel);
    return out;
  }

  /** The meshes of one part group (lab toggles, LOD decisions). */
  part(part: CarPart): AbstractMesh[] {
    switch (part) {
      case 'body':
        return [this.body];
      case 'driver':
        return this.driver ? [this.driver] : [];
      case 'wheels':
        return [...this.wheels];
      case 'hubs':
        return this.hubMeshes.filter((h): h is AbstractMesh => h !== null);
      case 'links':
        return [...this.links];
      case 'spinners':
        return [...this.spinners];
      case 'steeringWheel':
        return this.steeringWheel ? [this.steeringWheel] : [];
    }
  }

  setPartEnabled(part: CarPart, enabled: boolean): void {
    for (const mesh of this.part(part)) mesh.setEnabled(enabled);
  }

  dispose(): void {
    // Disposing the root takes every child (and each source's instances).
    this.root.dispose(false, false);
  }

  private linkRest(link: CarLayout['links'][number], mesh: AbstractMesh): LinkState {
    const body = new Vector3(link.bodyAnchor[0], link.bodyAnchor[1], link.bodyAnchor[2]);
    const hub = new Vector3(link.hubAnchor[0], link.hubAnchor[1], link.hubAnchor[2]);
    const hubRest = hub.add(this.restHubs[link.wheel]);
    const dir0 = (link.mode === 'fromHub' ? body.subtract(hubRest) : hubRest.subtract(body)).normalize();
    const y0 = dir0.scale(-1);
    let x0: Vector3;
    let z0: Vector3;
    if (Math.abs(dir0.z) < 0.8) {
      z0 = AXIS_Z.subtract(y0.scale(y0.z)).normalize();
      x0 = Vector3.Cross(y0, z0);
    } else {
      x0 = AXIS_X.subtract(y0.scale(y0.x)).normalize();
      z0 = Vector3.Cross(x0, y0);
    }
    return { link, mesh, body, hub, dir0, x0, y0, z0 };
  }
}

/** Rodrigues' rotation of `u` (see updateLinks); `k` = 1 / (1 + c). */
function turn(u: Vector3, v: Vector3, c: number, k: number, out: Vector3): Vector3 {
  const d = Vector3.Dot(v, u) * k;
  return out.set(
    u.x * c + (v.y * u.z - v.z * u.y) + v.x * d,
    u.y * c + (v.z * u.x - v.x * u.z) + v.y * d,
    u.z * c + (v.x * u.y - v.y * u.x) + v.z * d,
  );
}
