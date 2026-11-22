import { Color4, DynamicTexture, ParticleSystem, Vector3 } from '@babylonjs/core';
import type { Matrix, Particle, Texture } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { Vehicle } from '../car/Vehicle';
import type { DustGround } from '../game/contracts/car';
import { sampleSplat } from '../terrain/generateTerrain';
import type { TerrainData } from '../terrain/generateTerrain';

/** Per-surface dust look, index-aligned with the splat channels
 * (0 grass, 1 rock, 2 dirt road, 3 meadow). `amount` scales how much material
 * the tires kick up — a dirt road plumes, bare rock barely dusts. Colors sit
 * near the terrain palette but a touch lighter (dust catches the sun). */
const SURFACES = [
  { r: 0.42, g: 0.5, b: 0.24, amount: 0.8 }, // grass: green clippings
  { r: 0.62, g: 0.62, b: 0.65, amount: 0.3 }, // rock: sparse grey dust
  { r: 0.74, g: 0.57, b: 0.36, amount: 1.6 }, // dirt road: big tan plumes
  { r: 0.58, g: 0.6, b: 0.28, amount: 1.0 }, // meadow: yellow-green
];

/** What a cobbled / paved patch throws up instead: a little pale grit in the
 * vision's lavender-grey stone tone, not a plume. Applied AFTER the light
 * lift below, so paving really ends up lavender-grey. */
const PAVED_DUST = { r: 0.76, g: 0.73, b: 0.8 };
const PAVED_PULL = 0.85;
/** Sunlit beige the dust colour is lifted toward. Particles skip the look's
 * lighting, and the ground they fly over is sunlit: in the vision the plume is
 * clearly LIGHTER than the dirt under it (sRGB plume ≈ 250,200,163 over dirt
 * ≈ 212,135,87). Lifted most of the way (0.32 / 0.1 read 0–18
 * luma levels DARKER than the lab's dirt — soot spots, not a sunlit plume).
 * The two lifts give puffs a little variety, never a dark core. */
const DUST_LIGHT = { r: 1.0, g: 0.88, b: 0.74 };
const LIFT_LIGHT = 0.78;
const LIFT_DARK = 0.66;
/** Alpha over a puff's life, × the frame's alpha: fades in, stays dense
 * while it billows out, fades only at the end. (A linear fade to colorDead
 * left only each puff's small young core visible: dotted trails.) */
const ALPHA_SHAPE: readonly (readonly [number, number])[] = [
  [0, 0.55],
  [0.12, 1],
  [0.6, 0.8],
  [1, 0],
];
/** Front wheels: plain rolling throws nothing (the plume comes out from
 * behind the car, as in the vision — at 0.35 × the rear rate they drew two
 * thin dotted lines wherever the front tracks left the rear ones); a front
 * skid still dusts. */
const FRONT_ROLL_SHARE = 0;
const FRONT_SKID_SHARE = 0.6;
/** A wheel the vehicle reports as off the ground for longer than this, s,
 * throws no dust (short contact flicker over bumps does not cut the plume). */
const AIR_GRACE = 0.1;
/** Particle life, s. */
const MIN_LIFE = 0.7;
const MAX_LIFE = 1.3;

export interface DustParams {
  /** Rolling speed below which clean rolling kicks up nothing, m/s. */
  rollMinSpeed: number;
  /** Particles/s per m/s of rolling speed above the floor (at amount 1). */
  rollRate: number;
  /** Contact slip below this is normal tire squirm, not a skid, m/s. */
  skidThreshold: number;
  /** Particles/s per m/s of slip above the threshold (at amount 1). */
  skidRate: number;
  /** Emit-rate ceiling per wheel, particles/s (capacity guard). */
  maxRate: number;
  /** Extra wheel-center-to-ground clearance still counted as grounded, m. */
  groundedMargin: number;
  /** Fraction of the hub velocity thrown back into the rooster tail. */
  kickBack: number;
  /** Base upward throw speed, m/s (skids add more). */
  kickUp: number;
  /** Random sideways velocity spread, m/s. */
  spread: number;
  /** Multiplier on every puff's alpha (1 = the player's plume). */
  opacity: number;
  /** Multiplier on every puff's size (1 = the player's plume). */
  size: number;
  /** Share of the dust amount paving removes at full paving. */
  pavedDamping: number;
  /** Multiplier on every puff's life (1 = the player's plume); the plume's
   * length behind a moving car scales with it. */
  life: number;
  /** How much of the NEAR-CAMERA look (see NEAR) a car gets when the camera
   * is close to it: 0 = off, 1 = full. */
  nearBoost: number;
}

export const DEFAULT_DUST_PARAMS: DustParams = {
  rollMinSpeed: 3,
  // 4 → 3 (and no rolling dust from the fronts). Plain rolling at
  // 24 m/s on dirt used the whole particle budget, so a skid added nothing.
  // Now ≈ 200/s of the ≈ 360/s the default 400 particles sustain.
  rollRate: 3,
  skidThreshold: 1.2,
  skidRate: 30,
  maxRate: 200,
  groundedMargin: 0.35,
  // Dust hangs in the air where the tire kicked it rather than being hurled
  // backward: a small backward throw keeps successive puffs overlapping into
  // one plume (with 0.35 they were spread one every half metre — a dotted
  // line).
  kickBack: 0.08,
  kickUp: 2.0,
  spread: 1.3,
  opacity: 1,
  size: 1,
  pavedDamping: 0.85,
  life: 1,
  nearBoost: 1,
};

/**
 * The near-camera look: seen from the
 * chase camera at ~85 km/h on dirt the plume was a thin grey-brown haze at the
 * rear wheels and almost nothing on cobbles, where vision image 1 has big,
 * light, clumpy puffs on both. The high view's plume had been SHORTENED to
 * ~1.4 car lengths on purpose (vision image 2) and must stay so, and the
 * diorama sees cars from 100 m — so the boost follows the CAMERA DISTANCE to
 * the car, not the view: full within `from` m (the chase camera sits ~6 m
 * from its car), none past `to` m (the high camera is ~28 m away, xr 100 m+).
 * A rival close beside the player in chase gets part of it, as the brief
 * asks; one 20 m ahead gets none. LIFE is not touched, so the plume's length
 * behind a car — what the high view was tuned on — never changes; the boost
 * only makes each puff bigger, denser, lighter and clumped.
 */
const NEAR = {
  from: 10,
  to: 18,
  /** Multipliers at full boost. */
  size: 1.45,
  opacity: 1.3,
  rate: 1.5,
  kickUp: 1.35,
  /** Multiplier on what paving LEAVES (0.15 → 0.45 of the dirt amount). */
  pavedKeep: 3,
  /** Extra lift toward DUST_LIGHT (share of what is left). */
  lift: 0.45,
  /** Share of puffs born in a clump (see startPosition). */
  clump: 0.85,
};
/** Puffs per clump and the clump's scatter: a clump is a few puffs born
 * together within `tight` m of a centre that jumps up to `jump` m. */
const CLUMP_SIZE = 5;
const CLUMP_TIGHT = 0.12;
const CLUMP_JUMP = 0.45;

/**
 * A camera view's adjustment of a car's dust, as MULTIPLIERS on `params`
 * (1 = unchanged). The game sets this on every camera change and never
 * writes `params` itself, so a console tweak of `__game.dust[i].params`
 * survives pressing C: the view preset only owns this object.
 */
export interface DustViewScale {
  rollRate: number;
  skidRate: number;
  maxRate: number;
  kickUp: number;
  size: number;
  opacity: number;
  life: number;
  /** Multiplier on what paving LEAVES of the dust (1 − pavedDamping). */
  pavedKeep: number;
}

export const NEUTRAL_DUST_VIEW: Readonly<DustViewScale> = {
  rollRate: 1, skidRate: 1, maxRate: 1, kickUp: 1, size: 1, opacity: 1, life: 1, pavedKeep: 1,
};

export interface DustOptions {
  /** Particle capacity of the car's one system. Default 400. */
  capacity?: number;
  /** 'rear' = only wheels 2 and 3 throw dust (cheaper; rivals). Default 'all'. */
  wheels?: 'all' | 'rear';
}

/** Ground access the dust needs, as closures (see GroundQuery: unbound). */
interface DustGroundFns {
  heightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number, out: Float32Array): void;
  pavedAt(x: number, z: number): number;
}

function adaptGround(ground: DustGround | TerrainData | null): DustGroundFns | null {
  if (!ground) return null;
  if ('heightfield' in ground) {
    // Legacy caller (createScene.ts): a TerrainData-like object. Only its
    // `heightfield` and `splat` are read (other fields may come).
    const terrain = ground;
    const hf = terrain.heightfield;
    return {
      heightAt: (x, z) => hf.getHeight(x, z),
      surfaceAt: (x, z, out) => sampleSplat(terrain, x, z, out),
      pavedAt: () => 0,
    };
  }
  const g = ground;
  return { heightAt: g.heightAt, surfaceAt: g.surfaceAt, pavedAt: g.pavedAt };
}

/**
 * Ground dust kicked up at the wheels' contact points, for ANY `Vehicle`:
 * light trail while rolling, heavy plume while skidding (lateral slides AND
 * wheelspin / lockup — slip comes straight from the physics as
 * rim-vs-ground speed, so any way of overwhelming the tires counts). Amount
 * and colour follow the ground's splat under each wheel; paving damps it.
 *
 * ONE ParticleSystem per car (one draw call): the emit rate is the sum over
 * the wheels; every new particle starts at one of the emitting wheels, picked
 * in proportion to their rates (`startPositionFunction`), and is thrown by
 * that wheel's velocity (`startDirectionFunction`). Colour, alpha and size are
 * the rate-weighted blend of this frame's wheels.
 */
export class WheelDust {
  /** Live-tweakable from the console: __game.dust[i].params. */
  readonly params: DustParams = { ...DEFAULT_DUST_PARAMS };
  /** The camera view's multipliers on `params` (see DustViewScale). */
  readonly view: DustViewScale = { ...NEUTRAL_DUST_VIEW };
  private readonly car: Vehicle;
  private readonly ground: DustGroundFns | null;
  private readonly system: ParticleSystem;
  private readonly scene: Scene;
  private readonly weights = new Float32Array(4);
  private readonly first: number;
  private readonly capacity: number;
  /** Per wheel, this frame: emit rate, contact point, throw velocity, skid. */
  private readonly rate = new Float64Array(4);
  private readonly contact = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly kick = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  /** Hub travel over one frame, per wheel: a frame's new particles are
   * spread along it instead of all starting at the frame-end contact (at
   * 25 m/s that is 0.4 m — they bunched into separate clumps). */
  private readonly travel = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  /** Seconds each wheel has been reported off the ground. */
  private readonly airTime = new Float64Array(4);
  /** The colour gradient keys (Babylon keeps references: written per frame). */
  private readonly gradA: Color4[] = [];
  private readonly gradB: Color4[] = [];
  private totalRate = 0;
  /** Wheel chosen for the particle being created (position runs before
   * direction in Babylon's creation queue). */
  private pick = 0;
  private spread = 1.2;
  /** This frame's near-camera boost, 0..1 (see NEAR). */
  private near = 0;
  /** The particle being created belongs to a clump. */
  private clumped = false;
  /** Current clump: puffs left in it and its offset from the contact. */
  private clumpLeft = 0;
  private clumpWheel = 0;
  private readonly clumpOffset = new Vector3();
  private readonly clumpKick = new Vector3();
  /** Seeded generator for the start functions (shot pages repeat exactly as
   * far as this class is concerned; Babylon's own life / size / angle ranges
   * still use Math.random). */
  private seed = 0x9e3779b9;
  private disposed = false;

  constructor(scene: Scene, car: Vehicle, ground: DustGround | TerrainData | null, options: DustOptions = {}) {
    this.car = car;
    this.scene = scene;
    this.ground = adaptGround(ground);
    this.first = options.wheels === 'rear' ? 2 : 0;
    this.capacity = options.capacity ?? 400;

    const ps = new ParticleSystem('wheelDust', this.capacity, scene);
    ps.particleTexture = acquireDustTexture(scene);
    // Alpha blend, not additive: dirt occludes, it doesn't glow.
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    // Positions are written in world space by startPositionFunction; the
    // emitter only has to exist (a fixed point, never culled).
    ps.emitter = new Vector3(0, 0, 0);
    ps.minLifeTime = MIN_LIFE;
    ps.maxLifeTime = MAX_LIFE;
    // Puffs start about tire-sized and billow out over their life: overlapping
    // growing puffs read as one plume. Absolute sizes (m); `update` scales
    // them per frame through scaleX / scaleY (skids are chunkier).
    ps.addSizeGradient(0, 0.45, 0.7);
    ps.addSizeGradient(0.35, 1.1, 1.5);
    ps.addSizeGradient(1, 1.7, 2.4);
    // Colour + alpha over life (see ALPHA_SHAPE); `update` writes the keys.
    for (const [t] of ALPHA_SHAPE) {
      const a = new Color4(1, 1, 1, 0);
      const b = new Color4(1, 1, 1, 0);
      this.gradA.push(a);
      this.gradB.push(b);
      ps.addColorGradient(t, a, b);
    }
    // Direction carries the throw velocity; keep the power multiplier ~1 so
    // those numbers stay in real m/s.
    ps.minEmitPower = 0.8;
    ps.maxEmitPower = 1.2;
    ps.minAngularSpeed = -1.5;
    ps.maxAngularSpeed = 1.5;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    // Much gentler than world gravity (25): fine dust hangs in the air and
    // drifts up and out rather than sinking back into the ground (puffs that
    // sink are cut by the floor in a hard straight line).
    ps.gravity = new Vector3(0, -1.2, 0);
    ps.updateSpeed = 1 / 60;
    ps.emitRate = 0;
    ps.startPositionFunction = (_world: Matrix, out: Vector3, _p: Particle, _local: boolean) => this.startPosition(out);
    ps.startDirectionFunction = (_world: Matrix, out: Vector3, _p: Particle, _local: boolean) => this.startDirection(out);
    ps.start();
    this.system = ps;
  }

  /**
   * True once the particle shaders are loaded and compiled. Babylon 9 loads
   * them with an async dynamic import after construction, and a system that
   * is not ready silently emits nothing — a page that simulates frames
   * synchronously (shot mode) must wait for this first.
   */
  isReady(): boolean {
    return this.system.isReady();
  }

  /** Particles currently alive (labs: "is the dust emitting?"). */
  get activeParticles(): number {
    return this.system.getActiveCount();
  }

  /** Call once per frame after the physics step. No allocations. */
  update(): void {
    const p = this.params;
    const vs = this.view;
    const ps = this.system;
    const rollRate = p.rollRate * vs.rollRate;
    const skidRate = p.skidRate * vs.skidRate;
    const maxRate = p.maxRate * vs.maxRate;
    const kickUp = p.kickUp * vs.kickUp;
    const states = this.car.wheelStates;
    const near = this.nearFactor(states) * Math.min(Math.max(p.nearBoost, 0), 1);
    this.near = near;
    const nearRate = 1 + (NEAR.rate - 1) * near;
    const pavedKeep = vs.pavedKeep * (1 + (NEAR.pavedKeep - 1) * near);
    const pavedDamping = Math.max(1 - (1 - p.pavedDamping) * pavedKeep, 0);
    const ground = this.ground;
    let total = 0;
    let r = 0, g = 0, b = 0, alpha = 0, grow = 0, paving = 0;
    const frameDt = this.scene.getAnimationRatio() / 60;
    this.rate.fill(0);
    for (let i = this.first; i < states.length && i < 4; i++) {
      const state = states[i];
      const pos = state.position;
      const radius = state.radius;
      const groundY = ground ? ground.heightAt(pos.x, pos.z) : 0;
      // Airborne (or up on a ramp the ground query doesn't know about —
      // ramps are planking, no dust): no emission from this wheel. The lower
      // bound matters too: a car that fell out of the world is far BELOW
      // groundY and must not spray full-rate dust at the map edge.
      const clearance = pos.y - groundY;
      // And the vehicle's own contact flag (a wheel spinning in the air close
      // to the ground — a car on its side, a hop — reports full roll speed).
      this.airTime[i] = state.grounded ? 0 : this.airTime[i] + frameDt;
      if (this.airTime[i] > AIR_GRACE) continue;
      if (!Number.isFinite(clearance) || clearance > radius + p.groundedMargin || clearance < -radius) continue;

      // Surface blend under the contact: colour and dustiness follow the
      // same weights the terrain shader paints with.
      let sr = SURFACES[0].r, sg = SURFACES[0].g, sb = SURFACES[0].b, amount = SURFACES[0].amount;
      let paved = 0;
      if (ground) {
        ground.surfaceAt(pos.x, pos.z, this.weights);
        sr = sg = sb = amount = 0;
        for (let c = 0; c < 4; c++) {
          const w = this.weights[c];
          sr += w * SURFACES[c].r;
          sg += w * SURFACES[c].g;
          sb += w * SURFACES[c].b;
          amount += w * SURFACES[c].amount;
        }
        paved = Math.min(Math.max(ground.pavedAt(pos.x, pos.z), 0), 1);
        if (paved > 0) amount *= 1 - pavedDamping * paved;
      }

      const roll = Math.max(Math.abs(state.rollSpeed) - p.rollMinSpeed, 0);
      const skid = Math.max(state.slipSpeed - p.skidThreshold, 0);
      const front = i < 2;
      const rate = Math.min(
        amount * nearRate * ((front ? FRONT_ROLL_SHARE : 1) * roll * rollRate + (front ? FRONT_SKID_SHARE : 1) * skid * skidRate),
        maxRate * nearRate,
      );
      if (!(rate >= 1)) continue;

      this.rate[i] = rate;
      total += rate;
      this.contact[i].set(pos.x, groundY + 0.05, pos.z);
      // Thrown a little back along the hub's travel and upward — harder in
      // a skid.
      const v = state.velocity;
      this.kick[i].set(-v.x * p.kickBack, (kickUp + 0.2 * skid) * (1 + (NEAR.kickUp - 1) * near), -v.z * p.kickBack);
      this.travel[i].set(v.x * frameDt, 0, v.z * frameDt);
      r += rate * sr;
      g += rate * sg;
      b += rate * sb;
      paving += rate * paved;
      // Skids read denser and chunkier, not just more numerous.
      alpha += rate * Math.min(0.72 + 0.04 * skid, 0.92);
      grow += rate * Math.min(skid * 0.06, 0.4);
    }

    this.totalRate = total;
    if (total < 1) {
      ps.emitRate = 0;
      return;
    }
    r /= total;
    g /= total;
    b /= total;
    alpha /= total;
    grow /= total;
    paving /= total;
    // Capacity guard: what the system can keep alive is capacity / mean
    // life. Above that, fewer but larger puffs (same covered area) instead of
    // a plume that stutters when the pool runs dry.
    const life = p.life * vs.life > 0.05 ? p.life * vs.life : 0.05;
    if (ps.minLifeTime !== MIN_LIFE * life) {
      ps.minLifeTime = MIN_LIFE * life;
      ps.maxLifeTime = MAX_LIFE * life;
    }
    const sustainable = (0.9 * this.capacity) / (0.5 * (MIN_LIFE + MAX_LIFE) * life);
    let scale = (1 + grow) * p.size * vs.size * (1 + (NEAR.size - 1) * near);
    if (total > sustainable) {
      scale *= Math.min(Math.sqrt(total / sustainable), 1.6);
      ps.emitRate = sustainable;
      for (let i = 0; i < 4; i++) this.rate[i] *= sustainable / total;
      this.totalRate = sustainable;
    } else {
      ps.emitRate = total;
    }
    scale = Math.min(scale, 2.4);
    ps.minScaleX = ps.minScaleY = 0.85 * scale;
    ps.maxScaleX = ps.maxScaleY = 1.15 * scale;

    // Particles skip the look's lighting while the ground they fly over is
    // sunlit and tone-mapped: the bare surface colour reads as a dark smudge.
    // Lift most of the way toward a sunlit beige (keeping the surface's hue);
    // then pull paved contacts to the lavender-grey stone tone.
    // Near the camera paving keeps more of the dirt's warm tone: the puff a
    // car throws on cobbles in vision image 1 is beige, not stone-grey.
    const kp = PAVED_PULL * paving * (1 - 0.85 * near);
    const liftLight = LIFT_LIGHT + (1 - LIFT_LIGHT) * NEAR.lift * near;
    const liftDark = LIFT_DARK + (1 - LIFT_DARK) * NEAR.lift * near;
    let r1 = r + (DUST_LIGHT.r - r) * liftLight, g1 = g + (DUST_LIGHT.g - g) * liftLight, b1 = b + (DUST_LIGHT.b - b) * liftLight;
    let r2 = r + (DUST_LIGHT.r - r) * liftDark, g2 = g + (DUST_LIGHT.g - g) * liftDark, b2 = b + (DUST_LIGHT.b - b) * liftDark;
    if (kp > 0) {
      r1 += (PAVED_DUST.r - r1) * kp; g1 += (PAVED_DUST.g - g1) * kp; b1 += (PAVED_DUST.b - b1) * kp;
      r2 += (PAVED_DUST.r - r2) * kp; g2 += (PAVED_DUST.g - g2) * kp; b2 += (PAVED_DUST.b - b2) * kp;
    }
    for (let k = 0; k < ALPHA_SHAPE.length; k++) {
      const a = Math.min(alpha * p.opacity * vs.opacity * (1 + (NEAR.opacity - 1) * near) * ALPHA_SHAPE[k][1], 1);
      this.gradA[k].set(r1, g1, b1, a);
      this.gradB[k].set(r2, g2, b2, a);
    }
    this.spread = p.spread;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.system.stop();
    // The texture is shared by every car of the scene: released below.
    this.system.dispose(false);
    releaseDustTexture(this.scene);
  }

  /** 1 when the active camera is within NEAR.from m of the car, 0 past
   * NEAR.to m (smooth between). No camera: 0. */
  private nearFactor(states: Vehicle['wheelStates']): number {
    const cam = this.scene.activeCamera;
    const n = Math.min(states.length, 4);
    if (!cam || n === 0) return 0;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) {
      x += states[i].position.x;
      y += states[i].position.y;
      z += states[i].position.z;
    }
    const c = cam.globalPosition;
    const dx = c.x - x / n, dy = c.y - y / n, dz = c.z - z / n;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(d)) return 0;
    const t = Math.min(Math.max((NEAR.to - d) / (NEAR.to - NEAR.from), 0), 1);
    return t * t * (3 - 2 * t);
  }

  /** Uniform [0, 1) from a xorshift32 state — deterministic per system. */
  private random(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  // Called once per new particle by Babylon: no allocations.
  private startPosition(out: Vector3): void {
    let wheel = this.first;
    let x = this.random() * this.totalRate;
    for (let i = this.first; i < 4; i++) {
      const rate = this.rate[i];
      if (rate <= 0) continue;
      wheel = i;
      if (x < rate) break;
      x -= rate;
    }
    this.clumped = this.near > 0 && this.random() < NEAR.clump * this.near;
    // A clump stays on its wheel while that wheel still throws dust.
    if (this.clumped && this.clumpLeft > 0 && this.rate[this.clumpWheel] > 0) wheel = this.clumpWheel;
    this.pick = wheel;
    const c = this.contact[wheel];
    const back = this.random();
    const t = this.travel[wheel];
    out.set(
      c.x - t.x * back + (this.random() - 0.5) * 0.5,
      // Lifted off the floor: a puff is up to 2.4 m wide, and one centred on
      // the ground shows the floor cutting it in a hard straight edge.
      c.y + 0.25 + this.random() * 0.2,
      c.z - t.z * back + (this.random() - 0.5) * 0.5,
    );
    // Near the camera most puffs are born in CLUMPS: a few together around
    // a centre that jumps, all thrown the same way, so they billow out as one
    // lump (vision image 1) instead of an even haze.
    if (this.clumped) {
      if (this.clumpLeft <= 0 || this.clumpWheel !== wheel) {
        this.clumpWheel = wheel;
        this.clumpLeft = CLUMP_SIZE;
        this.clumpOffset.set((this.random() - 0.5) * 2 * CLUMP_JUMP, this.random() * 0.25, (this.random() - 0.5) * 2 * CLUMP_JUMP);
        this.clumpKick.set((this.random() * 2 - 1) * this.spread, 0.35 + 0.65 * this.random(), (this.random() * 2 - 1) * this.spread);
      }
      this.clumpLeft--;
      out.set(
        c.x - t.x * back + this.clumpOffset.x + (this.random() - 0.5) * 2 * CLUMP_TIGHT,
        c.y + 0.25 + this.clumpOffset.y + this.random() * 0.1,
        c.z - t.z * back + this.clumpOffset.z + (this.random() - 0.5) * 2 * CLUMP_TIGHT,
      );
    }
  }

  private startDirection(out: Vector3): void {
    const k = this.kick[this.pick];
    const s = this.spread;
    if (this.clumped) {
      // The clump's shared throw, a little jitter per puff.
      const ck = this.clumpKick;
      out.set(
        k.x + ck.x + (this.random() - 0.5) * 0.3 * s,
        k.y * ck.y,
        k.z + ck.z + (this.random() - 0.5) * 0.3 * s,
      );
      return;
    }
    out.set(
      k.x + (this.random() * 2 - 1) * s,
      k.y * (0.35 + 0.65 * this.random()),
      k.z + (this.random() * 2 - 1) * s,
    );
  }
}

/** One soft blob texture per scene, shared by every car's system. */
const dustTextures = new WeakMap<Scene, { texture: Texture; users: number }>();

function acquireDustTexture(scene: Scene): Texture {
  let entry = dustTextures.get(scene);
  if (!entry || entry.texture.getInternalTexture() === null) {
    entry = { texture: createDustTexture(scene), users: 0 };
    dustTextures.set(scene, entry);
  }
  entry.users++;
  return entry.texture;
}

function releaseDustTexture(scene: Scene): void {
  const entry = dustTextures.get(scene);
  if (!entry) return;
  entry.users--;
  if (entry.users <= 0) {
    entry.texture.dispose();
    dustTextures.delete(scene);
  }
}

/** Soft radial blob the per-particle colour tints — no asset needed. White
 * throughout (a darker core read as soot specks); the alpha
 * stays high over the inner half and falls off smoothly, so a puff is soft
 * and WIDE and overlapping puffs merge into one cloud.
 *
 * A cauliflower outline instead of a plain disc — a core
 * and seven lobes round it, each with a firmer edge — so a puff (and a clump
 * of them) reads as a lump of dust with a billowy rim, as in vision image 1,
 * not as fog. Particles spin, so the lobes never line up. */
function createDustTexture(scene: Scene): Texture {
  const size = 64;
  const tex = new DynamicTexture('dustTex', size, scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, size, size);
  const blob = (x: number, y: number, r: number, a: number): void => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.55, `rgba(255,255,255,${a * 0.85})`);
    grad.addColorStop(0.8, `rgba(255,255,255,${a * 0.4})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  };
  const c = size / 2;
  blob(c, c, c * 0.62, 0.62);
  // Fixed lobe layout (angles, distances, radii): deterministic.
  const lobes = [
    [0.0, 0.42, 0.34], [0.95, 0.47, 0.28], [1.8, 0.4, 0.33], [2.7, 0.48, 0.27],
    [3.55, 0.43, 0.31], [4.45, 0.46, 0.29], [5.4, 0.41, 0.32],
  ];
  for (const [ang, dist, rad] of lobes) blob(c + Math.cos(ang) * dist * c, c + Math.sin(ang) * dist * c, rad * c, 0.42);
  tex.update();
  return tex;
}
