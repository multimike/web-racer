import {
  Camera,
  Constants,
  Effect,
  Matrix,
  RenderTargetTexture,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector4,
} from '@babylonjs/core';
import type { AbstractMesh, Scene } from '@babylonjs/core';
import { LOOK_WIND_UNIFORM, registerWindChunk } from './wind';

/**
 * Real-time sun shadows: ONE orthographic depth map that follows a focus
 * point (the car), sampled with hardware-compared PCF inside the shared
 * lighting chunk (`lookShadow` in lighting.ts).
 *
 * Why an own depth pass and not Babylon's ShadowGenerator:
 *  - the receivers are custom ShaderMaterials, so the generator's shader
 *    plumbing (light UBO, `shadowsInfo`, `lightMatrix` includes) would have
 *    to be re-implemented by hand anyway;
 *  - the generator fits its frustum to the caster bounds every frame, which
 *    is exactly what makes a moving-focus shadow shimmer; here the projection
 *    is a fixed-size box snapped to whole shadow texels;
 *  - no Light object is needed (a second DirectionalLight would also light
 *    every legacy StandardMaterial in the scene).
 *
 * The map is a depth texture with a COMPARISON sampler (`sampler2DShadow`):
 * each tap is a free bilinear 2×2 percentage-closer test, so 4 taps give a
 * 3×3 tent and 9 taps a 5×5 tent. WebGL2 only — on WebGL1 quality is forced
 * to 'off'.
 */

export type ShadowQuality = 'off' | 1024 | 2048;
export type ShadowTaps = 1 | 4 | 9;

export interface SunShadowOptions {
  quality?: ShadowQuality;
  /** Side of the square region covered around the focus, meters (measured in
   * the light's plane; the ground footprint is longer along the sun azimuth
   * by 1/sin(elevation)). */
  region?: number;
  /** PCF taps; default 9 at 2048 and 4 at 1024. */
  taps?: ShadowTaps;
}

interface Caster {
  wind: boolean;
  instanced: boolean;
}

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const DEPTH_SHADER = 'lookDepth';

function registerDepthShader(): void {
  if (Effect.ShadersStore[`${DEPTH_SHADER}VertexShader`]) return;
  registerWindChunk();
  Effect.ShadersStore[`${DEPTH_SHADER}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    #ifdef LOOK_WIND
    attribute vec2 uv2;
    #include<lookWind>
    #endif
    #include<instancesDeclaration>
    uniform mat4 lookDepthMatrix;
    void main() {
      #include<instancesVertex>
      vec4 wp = finalWorld * vec4(position, 1.0);
      #ifdef LOOK_WIND
      wp.xyz = lookWindSway(wp.xyz, uv2.y);
      #endif
      gl_Position = lookDepthMatrix * wp;
    }
  `;
  // Depth-only target: the colour output is discarded (no colour attachment).
  Effect.ShadersStore[`${DEPTH_SHADER}FragmentShader`] = `
    precision highp float;
    void main() { gl_FragColor = vec4(1.0); }
  `;
}

export class SunShadows {
  /** World → shadow-map [0,1]³ (uv + compare depth). Bound by the look
   * runtime as `lookShadowMatrix`. */
  readonly matrix = Matrix.Identity();
  /** (map size, 1/size, normal-offset bias in world meters, constant depth
   * bias in map depth units). Bound as `lookShadowInfo`. */
  readonly info = new Vector4(1, 1, 0, 0);

  /** Side of the covered square, meters. Bigger = softer and blurrier. */
  region: number;
  /** Depth extent of the light box along the sun ray, meters. Casters up to
   * half of it toward the sun from the focus still land in the map. */
  depthRange = 260;
  /** Receiver normal offset, in shadow texels. The lookup is pushed off the
   * surface along its normal (more at grazing sun), which is what removes
   * acne without the peter-panning a big constant depth bias causes. */
  normalBiasTexels = 1.6;
  /** Slope-scaled polygon offset applied while rendering the depth map. */
  slopeBias = 1.75;
  /** Constant depth bias in meters along the sun ray. */
  depthBias = 0.03;
  /** Render the map every Nth frame (1 = every frame). Between renders the
   * receivers keep the matrix the map was drawn with, so shadows stay put
   * (they do not slide), but moving casters — the car — visibly lag: only
   * for static scenes or a fixed diorama focus. */
  refreshRate = 1;
  /** Fired when the map is created/destroyed or the tap count changes, so
   * receivers can flip their shader defines. */
  onChanged: (() => void) | null = null;

  private readonly scene: Scene;
  private readonly casters = new Map<AbstractMesh, Caster>();
  private readonly depthMaterials = new Map<string, ShaderMaterial>();
  private readonly focus = new Vector3(0, 0, 0);
  private readonly depthMatrix = Matrix.Identity();
  private rtt: RenderTargetTexture | null = null;
  private readonly camera: Camera;
  private currentQuality: ShadowQuality = 'off';
  private currentTaps: ShadowTaps | null = null;
  private readonly wind = new Vector4(1, 0, 0, 0);
  private appliedRefreshRate = -1;
  private framesToRender = 0;
  /** Casters added before their thin instances existed (re-checked until
   * they have some; everything else never changes state). */
  private readonly pending: AbstractMesh[] = [];

  constructor(scene: Scene, options: SunShadowOptions = {}) {
    this.scene = scene;
    this.region = options.region ?? 80;
    this.currentTaps = options.taps ?? null;
    registerDepthShader();
    // The depth pass gets a camera of its own. Its matrices are never used
    // (the depth shader has its own light matrix); it exists so that
    // scene.activeCamera is NOT the player's camera while the map renders —
    // under WebXR multiview ShaderMaterial would otherwise compile the depth
    // shader as a 2-view program, which cannot draw into this single-view
    // target. `false` = never becomes the scene's active camera.
    this.camera = new Camera('lookShadowCamera', Vector3.Zero(), scene, false);
    this.camera.doNotSerialize = true;
    this.setQuality(options.quality ?? 'off');
  }

  get quality(): ShadowQuality {
    return this.currentQuality;
  }

  /** True when receivers should compile the shadow path. */
  get enabled(): boolean {
    return this.rtt !== null;
  }

  get map(): RenderTargetTexture | null {
    return this.rtt;
  }

  get taps(): ShadowTaps {
    return this.currentTaps ?? (this.currentQuality === 2048 ? 9 : 4);
  }

  set taps(value: ShadowTaps) {
    if (this.currentTaps === value) return;
    this.currentTaps = value;
    this.onChanged?.();
  }

  setQuality(quality: ShadowQuality): void {
    // sampler2DShadow needs WebGL2; degrade to no real-time shadows rather
    // than failing to compile every receiver.
    const webgl = (this.scene.getEngine() as { webGLVersion?: number }).webGLVersion ?? 2;
    if (webgl < 2) quality = 'off';
    if (quality === this.currentQuality && (quality === 'off') === (this.rtt === null)) return;
    this.currentQuality = quality;
    this.disposeMap();
    if (quality !== 'off') this.createMap(quality);
    this.onChanged?.();
  }

  /**
   * Make a mesh cast. Thin-instanced meshes cast per instance. Pass
   * `wind: true` for meshes drawn with the wind variant of the toy material
   * (they need a `uv2` buffer) so the shadow sways with the foliage.
   * Invisible / disabled meshes are skipped automatically.
   */
  addCaster(mesh: AbstractMesh, options: { wind?: boolean } = {}): void {
    if (this.casters.has(mesh)) return;
    const caster: Caster = { wind: options.wind ?? false, instanced: mesh.hasThinInstances };
    this.casters.set(mesh, caster);
    if (!caster.instanced) this.pending.push(mesh);
    mesh.onDisposeObservable.addOnce(() => this.removeCaster(mesh));
    if (this.rtt) this.attach(mesh, caster);
  }

  removeCaster(mesh: AbstractMesh): void {
    if (!this.casters.delete(mesh)) return;
    const p = this.pending.indexOf(mesh);
    if (p >= 0) this.pending.splice(p, 1);
    const list = this.rtt?.renderList;
    if (!list) return;
    const i = list.indexOf(mesh);
    if (i >= 0) list.splice(i, 1);
  }

  /** Centre of the shadowed region; call every frame with the car position. */
  setFocus(position: Vec3Like): void {
    this.focus.set(position.x, position.y, position.z);
  }

  /** Recompute the light matrices. Called by the look runtime once per
   * frame, before the scene renders its custom render targets. */
  update(sunDir: Vec3Like, wind: Vector4): void {
    this.wind.copyFrom(wind);
    const rtt = this.rtt;
    if (!rtt) return;
    // Assigning refreshRate resets Babylon's counter ("render now"), so doing
    // it every frame would defeat any rate above 1.
    const rate = Math.max(1, Math.round(this.refreshRate));
    if (rate !== this.appliedRefreshRate) {
      this.appliedRefreshRate = rate;
      rtt.refreshRate = rate;
      this.framesToRender = 0;
    }

    // Casters may gain their thin-instance buffers after addCaster.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const mesh = this.pending[i];
      if (!mesh.hasThinInstances) continue;
      const caster = this.casters.get(mesh);
      this.pending.splice(i, 1);
      if (caster) {
        caster.instanced = true;
        this.attach(mesh, caster);
      }
    }

    // The matrix receivers use must be the one the map was DRAWN with: on
    // frames where the map is not re-rendered everything stays as it is.
    if (this.framesToRender > 0) {
      this.framesToRender--;
      return;
    }
    this.framesToRender = rate - 1;

    // Not rtt.getSize(): that reads the colour texture, and there is none.
    const size = rtt.getRenderWidth();
    const texel = this.region / size;

    // Light basis from the sun direction ONLY (never from the focus), so the
    // texel grid is fixed in the world and the snap below is exact.
    const toSun = TMP[0].set(sunDir.x, sunDir.y, sunDir.z).normalize();
    const right = Vector3.CrossToRef(Vector3.UpReadOnly, toSun, TMP[1]).normalize();
    const up = Vector3.CrossToRef(toSun, right, TMP[2]).normalize();

    // Snap the focus to whole texels along the map's two axes: a moving focus
    // then shifts the map by exact texels and every static shadow edge
    // rasterizes to the same texels frame after frame — no shimmer.
    const fx = Math.round(Vector3.Dot(this.focus, right) / texel) * texel;
    const fy = Math.round(Vector3.Dot(this.focus, up) / texel) * texel;
    const fz = Vector3.Dot(this.focus, toSun);
    const center = TMP[3].set(
      right.x * fx + up.x * fy + toSun.x * fz,
      right.y * fx + up.y * fy + toSun.y * fz,
      right.z * fx + up.z * fy + toSun.z * fz,
    );
    const eye = TMP[4].copyFrom(toSun).scaleInPlace(this.depthRange / 2).addInPlace(center);

    Matrix.LookAtLHToRef(eye, center, up, VIEW);
    Matrix.OrthoLHToRef(this.region, this.region, 0, this.depthRange, PROJ);
    VIEW.multiplyToRef(PROJ, this.depthMatrix);
    // Fold the NDC [-1,1] → [0,1] remap into the receiver matrix so the
    // fragment shader does one mat4 × vec4 and nothing else.
    this.depthMatrix.multiplyToRef(NDC_TO_UVZ, this.matrix);

    this.info.set(size, 1 / size, this.normalBiasTexels * texel, this.depthBias / this.depthRange);

    for (const mat of this.depthMaterials.values()) {
      mat.setMatrix('lookDepthMatrix', this.depthMatrix);
      mat.setVector4(LOOK_WIND_UNIFORM, this.wind);
      mat.zOffset = this.slopeBias;
    }
  }

  /** Bind the depth texture to a receiver effect (comparison sampler). */
  bind(effect: Effect, samplerName: string): void {
    if (this.rtt) effect.setDepthStencilTexture(samplerName, this.rtt);
  }

  dispose(): void {
    this.disposeMap();
    for (const mat of this.depthMaterials.values()) mat.dispose();
    this.depthMaterials.clear();
    this.casters.clear();
    this.pending.length = 0;
    this.camera.dispose();
  }

  // -------------------------------------------------------------------------

  private createMap(size: number): void {
    const rtt = new RenderTargetTexture('lookShadowMap', size, this.scene, {
      generateMipMaps: false,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      // Depth-only framebuffer: no colour texture is allocated at all
      // (2048² RGBA8 would be 16 MB of nothing on Quest).
      noColorAttachment: true,
    });
    // LESS + bilinear = hardware 2×2 PCF per tap.
    rtt.createDepthStencilTexture(Constants.LESS, true, false, 1);
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE;
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE;
    rtt.renderParticles = false;
    rtt.renderSprites = false;
    rtt.ignoreCameraViewport = true;
    rtt.noPrePassRenderer = true;
    rtt.renderList = [];
    rtt.activeCamera = this.camera;
    this.rtt = rtt;
    this.appliedRefreshRate = -1;
    for (const [mesh, caster] of this.casters) this.attach(mesh, caster);
    this.scene.customRenderTargets.push(rtt);
  }

  private disposeMap(): void {
    const rtt = this.rtt;
    if (!rtt) return;
    const i = this.scene.customRenderTargets.indexOf(rtt);
    if (i >= 0) this.scene.customRenderTargets.splice(i, 1);
    rtt.dispose();
    this.rtt = null;
  }

  private attach(mesh: AbstractMesh, caster: Caster): void {
    const rtt = this.rtt;
    if (!rtt?.renderList) return;
    if (rtt.renderList.indexOf(mesh) < 0) rtt.renderList.push(mesh);
    rtt.setMaterialForRendering(mesh, this.depthMaterial(caster.instanced, caster.wind));
  }

  /** One material per (instanced, wind) combination: a ShaderMaterial keeps a
   * single compiled effect, so sharing one across instanced and plain meshes
   * would rebuild its define string on every draw. */
  private depthMaterial(instanced: boolean, wind: boolean): ShaderMaterial {
    const key = `${instanced ? 'i' : 'm'}${wind ? 'w' : ''}`;
    let mat = this.depthMaterials.get(key);
    if (mat) return mat;
    const attributes = ['position'];
    if (wind) attributes.push('uv2');
    mat = new ShaderMaterial(`lookDepth_${key}`, this.scene, DEPTH_SHADER, {
      attributes,
      uniforms: ['world', 'lookDepthMatrix', LOOK_WIND_UNIFORM],
      defines: wind ? ['LOOK_WIND'] : [],
    });
    // Both faces go into the map: open shells and single-sided foliage cards
    // must cast, and front-face acne is handled by the biases instead.
    mat.backFaceCulling = false;
    mat.zOffset = this.slopeBias;
    mat.zOffsetUnits = 2;
    mat.setMatrix('lookDepthMatrix', this.depthMatrix);
    mat.setVector4(LOOK_WIND_UNIFORM, this.wind);
    this.depthMaterials.set(key, mat);
    return mat;
  }
}

const TMP = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const VIEW = Matrix.Identity();
const PROJ = Matrix.Identity();
const NDC_TO_UVZ = Matrix.FromValues(
  0.5, 0, 0, 0,
  0, 0.5, 0, 0,
  0, 0, 0.5, 0,
  0.5, 0.5, 0.5, 1,
);
