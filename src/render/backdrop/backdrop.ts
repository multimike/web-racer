import { Color3, Effect, Mesh, ShaderMaterial, VertexData } from '@babylonjs/core';
import type { Observer, Scene } from '@babylonjs/core';
import { getLook } from '../../gfx/look/lighting';
import { buildBackdrop } from './hills';

/**
 * The backdrop in the scene: ONE mesh (hill rings + crest tree clumps), one
 * draw call, ~4k triangles, no shadows, no physics, not pickable. Its material is a
 * plain unlit vertex-colour shader (the two-tone sun shading is baked in
 * `hills.ts`) that mixes each vertex toward the look's horizon / fog colour
 * by its own aerial amount — the scene's EXP2 fog is NOT applied (at 150–390
 * m it would erase the hills), but the horizon colour it mixes toward is the
 * same, so hills, sky and fogged terrain meet at one horizon.
 *
 * In the xr diorama view the world is a table: hills beyond its edge would
 * be wrong there, so the game hides the backdrop (`setVisible(false)`) and
 * only the look's sky dome shows. The high camera never sees the horizon,
 * so it is hidden there too; it draws in chase only.
 */

const SHADER = 'backdropHills';

function registerShader(): void {
  if (Effect.ShadersStore[`${SHADER}VertexShader`]) return;
  Effect.ShadersStore[`${SHADER}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    attribute vec4 color;
    uniform mat4 world;
    uniform mat4 viewProjection;
    #ifdef MULTIVIEW
    uniform mat4 viewProjectionR;
    #endif
    varying vec4 vColor;
    void main() {
      vColor = color;
      vec4 wp = world * vec4(position, 1.0);
      #ifdef MULTIVIEW
      gl_Position = gl_ViewID_OVR == 0u ? viewProjection * wp : viewProjectionR * wp;
      #else
      gl_Position = viewProjection * wp;
      #endif
    }
  `;
  Effect.ShadersStore[`${SHADER}FragmentShader`] = `
    precision highp float;
    varying vec4 vColor;
    uniform vec3 horizonColor;
    void main() {
      gl_FragColor = vec4(mix(vColor.rgb, horizonColor, clamp(vColor.a, 0.0, 1.0)), 1.0);
    }
  `;
}

export interface Backdrop {
  readonly mesh: Mesh;
  readonly triangles: number;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  dispose(): void;
}

export interface BackdropOptions {
  /** World seed: the hills' skyline and their patches are seeded from it. */
  seed: number;
}

export function createBackdrop(scene: Scene, options: BackdropOptions): Backdrop {
  registerShader();
  const geo = buildBackdrop(options.seed);
  const mesh = new Mesh('backdrop', scene);
  const vd = new VertexData();
  vd.positions = geo.positions;
  vd.colors = geo.colors;
  const n = geo.positions.length / 3;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  vd.indices = indices;
  vd.applyToMesh(mesh, false);

  const mat = new ShaderMaterial(SHADER, scene, SHADER, {
    attributes: ['position', 'color'],
    uniforms: ['world', 'viewProjection', 'viewProjectionR', 'horizonColor'],
  });
  // Rings are seen from inside: no culling keeps the winding out of it.
  mat.backFaceCulling = false;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.applyFog = false;
  // The vertex alpha is the aerial amount, not opacity: without this the
  // mesh would go to the transparent pass (CLAUDE.md gotcha: vertex alpha is emissive).
  mesh.hasVertexAlpha = false;
  mesh.receiveShadows = false;
  mesh.freezeWorldMatrix();
  mesh.doNotSyncBoundingInfo = true;

  const horizon = new Color3();
  const observer: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    if (!mesh.isEnabled()) return;
    const c = getLook(scene).config.fogColor;
    horizon.set(c[0], c[1], c[2]);
    mat.setColor3('horizonColor', horizon);
  });

  return {
    mesh,
    triangles: geo.triangles,
    get visible(): boolean {
      return mesh.isEnabled();
    },
    setVisible(visible: boolean): void {
      mesh.setEnabled(visible);
    },
    dispose(): void {
      scene.onBeforeRenderObservable.remove(observer);
      mesh.dispose();
      mat.dispose();
    },
  };
}
