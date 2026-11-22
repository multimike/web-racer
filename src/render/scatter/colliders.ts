import {
  Matrix,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  PhysicsShapeCylinder,
  PhysicsShapeSphere,
  Quaternion,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { PhysicsShape, Scene } from '@babylonjs/core';
import type { ColliderSpec, PropAsset } from '../../assets/types';

/**
 * Static collision for the world props: ONE compound body per group
 * (buildings, trees, rocks, dressing). Child shapes are created once per
 * (asset, variant, collider index) from `PropAsset.colliders(variant)` and
 * added to the group's `PhysicsShapeContainer` per placement with the
 * placement's translation, rotation (tilt · yaw) and uniform scale.
 * Every child shape carries an explicit material — static bodies otherwise
 * default to low friction.
 */

export type ColliderGroup = 'building' | 'tree' | 'rock' | 'dressing';

export interface ColliderItem {
  asset: PropAsset;
  /** Collider variant seed: `seed % COLLIDER_VARIANTS[class]`, the same on every preset (worldProps.ts). */
  variant: number;
  group: ColliderGroup;
  position: Vector3;
  rotation: Quaternion;
  scale: number;
}

/** One child shape in world space (for the lab's wireframes and checks). */
export interface ColliderDebugShape {
  kind: 'box' | 'cylinder' | 'sphere';
  /** Unit shape → world: box of side 1, cylinder of radius 1 and height 1
   * centred on the origin, sphere of radius 1. */
  matrix: Matrix;
}

export interface BuiltColliders {
  bodies: PhysicsBody[];
  /** Child shapes added over all bodies. */
  shapes: number;
  /** Placements that received at least one child. */
  items: number;
  /** Only with `debug: true`. */
  debug: ColliderDebugShape[];
  dispose(): void;
}

const MATERIAL = { friction: 0.6, restitution: 0.05 };
const ROCK_MATERIAL = { friction: 0.9, restitution: 0.05 };

interface Child {
  shape: PhysicsShape;
  spec: ColliderSpec;
}

export function buildColliders(
  scene: Scene,
  items: readonly ColliderItem[],
  options: {
    debug?: boolean;
    /** The collider specs of (asset, variant) when the caller already has
     * them (some assets rebuild their whole construction to answer
     * `colliders(variant)`); default: ask the asset. */
    specs?: (asset: PropAsset, variant: number) => readonly ColliderSpec[];
  } = {},
): BuiltColliders {
  const cache = new Map<PropAsset, Map<number, Child[]>>();
  const created: PhysicsShape[] = [];
  const childrenOf = (asset: PropAsset, variant: number, rock: boolean): Child[] => {
    let perAsset = cache.get(asset);
    if (!perAsset) {
      perAsset = new Map();
      cache.set(asset, perAsset);
    }
    let list = perAsset.get(variant);
    if (list) return list;
    list = [];
    for (const spec of options.specs ? options.specs(asset, variant) : (asset.colliders?.(variant) ?? [])) {
      let shape: PhysicsShape;
      if (spec.shape === 'box') {
        const q = Quaternion.RotationAxis(Vector3.UpReadOnly, ((spec.rotY ?? 0) * Math.PI) / 180);
        shape = new PhysicsShapeBox(new Vector3(...spec.center), q, new Vector3(spec.half[0] * 2, spec.half[1] * 2, spec.half[2] * 2), scene);
      } else if (spec.shape === 'cylinder') {
        const a = new Vector3(...spec.base);
        shape = new PhysicsShapeCylinder(a, a.add(new Vector3(0, spec.height, 0)), spec.radius, scene);
      } else {
        shape = new PhysicsShapeSphere(new Vector3(...spec.center), spec.radius, scene);
      }
      shape.material = rock ? ROCK_MATERIAL : MATERIAL;
      created.push(shape);
      list.push({ shape, spec });
    }
    perAsset.set(variant, list);
    return list;
  };

  const containers = new Map<ColliderGroup, PhysicsShapeContainer>();
  const debug: ColliderDebugShape[] = [];
  let shapes = 0;
  let withShapes = 0;
  const scl = new Vector3();
  const itemM = new Matrix();
  for (const it of items) {
    const children = childrenOf(it.asset, it.variant, it.group === 'rock');
    if (children.length === 0) continue;
    let c = containers.get(it.group);
    if (!c) {
      c = new PhysicsShapeContainer(scene);
      containers.set(it.group, c);
    }
    scl.set(it.scale, it.scale, it.scale);
    for (const ch of children) c.addChild(ch.shape, it.position, it.rotation, scl);
    shapes += children.length;
    withShapes++;
    if (options.debug) {
      Matrix.ComposeToRef(scl, it.rotation, it.position, itemM);
      for (const ch of children) debug.push({ kind: ch.spec.shape, matrix: localMatrix(ch.spec).multiply(itemM) });
    }
  }

  const bodies: PhysicsBody[] = [];
  const nodes: TransformNode[] = [];
  for (const [group, container] of containers) {
    const node = new TransformNode(`propColliders.${group}`, scene);
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
    body.shape = container;
    bodies.push(body);
    nodes.push(node);
  }

  return {
    bodies,
    shapes,
    items: withShapes,
    debug,
    dispose(): void {
      for (const b of bodies) b.dispose();
      for (const n of nodes) n.dispose();
      for (const c of containers.values()) c.dispose();
      for (const s of created) s.dispose();
    },
  };
}

/** Unit shape → asset-local space for one collider spec. */
function localMatrix(spec: ColliderSpec): Matrix {
  if (spec.shape === 'box') {
    const q = Quaternion.RotationAxis(Vector3.UpReadOnly, ((spec.rotY ?? 0) * Math.PI) / 180);
    return Matrix.Compose(new Vector3(spec.half[0] * 2, spec.half[1] * 2, spec.half[2] * 2), q, new Vector3(...spec.center));
  }
  if (spec.shape === 'cylinder') {
    return Matrix.Compose(
      new Vector3(spec.radius, spec.height, spec.radius),
      Quaternion.Identity(),
      new Vector3(spec.base[0], spec.base[1] + spec.height / 2, spec.base[2]),
    );
  }
  return Matrix.Compose(new Vector3(spec.radius, spec.radius, spec.radius), Quaternion.Identity(), new Vector3(...spec.center));
}
