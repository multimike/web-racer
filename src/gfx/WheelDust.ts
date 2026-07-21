import { DynamicTexture, ParticleSystem, Texture, Vector3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core/scene';
import type { RigidWheelVehicle } from '../car/RigidWheelVehicle';
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
}

export const DEFAULT_DUST_PARAMS: DustParams = {
  rollMinSpeed: 3,
  rollRate: 1.5,
  skidThreshold: 1.2,
  skidRate: 30,
  maxRate: 200,
  groundedMargin: 0.35,
  kickBack: 0.35,
  kickUp: 1.5,
  spread: 1.2,
};

/**
 * Ground dust kicked up at each wheel's contact point: light trail while
 * rolling, heavy plume while skidding (lateral slides AND wheelspin/lockup —
 * slip comes straight from the physics as rim-vs-ground speed, so any way of
 * overwhelming the tires counts). Amount and color follow the terrain splat
 * under the wheel; flat mode is treated as all-grass. One ParticleSystem per
 * wheel = 4 draw calls, a few hundred quads total.
 */
export class WheelDust {
  /** Live-tweakable from the console: __game.dust.params. */
  readonly params: DustParams = { ...DEFAULT_DUST_PARAMS };
  private car: RigidWheelVehicle;
  private terrain: TerrainData | null;
  private systems: ParticleSystem[] = [];
  private weights = new Float32Array(4);

  constructor(scene: Scene, car: RigidWheelVehicle, terrain: TerrainData | null) {
    this.car = car;
    this.terrain = terrain;

    const texture = createDustTexture(scene);
    for (let i = 0; i < car.wheelStates.length; i++) {
      const ps = new ParticleSystem(`wheelDust${i}`, 300, scene);
      ps.particleTexture = texture;
      // Alpha blend, not additive: dirt occludes, it doesn't glow.
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      ps.emitter = new Vector3(0, -100, 0);
      ps.minEmitBox = new Vector3(-0.35, 0, -0.35);
      ps.maxEmitBox = new Vector3(0.35, 0.15, 0.35);
      ps.minLifeTime = 0.45;
      ps.maxLifeTime = 0.9;
      // Direction carries the throw velocity (set per frame); keep the power
      // multiplier ~1 so those numbers stay in real m/s.
      ps.minEmitPower = 0.8;
      ps.maxEmitPower = 1.2;
      ps.minAngularSpeed = -2;
      ps.maxAngularSpeed = 2;
      // Gentler than world gravity (25): fine dust hangs in the air a bit.
      ps.gravity = new Vector3(0, -9, 0);
      ps.updateSpeed = 1 / 60;
      ps.emitRate = 0;
      ps.start();
      this.systems.push(ps);
    }
  }

  /** Call once per frame after vehicle.update(). */
  update(): void {
    const p = this.params;
    const radius = this.car.tuning.wheelRadius;
    for (let i = 0; i < this.car.wheelStates.length; i++) {
      const state = this.car.wheelStates[i];
      const ps = this.systems[i];
      const groundY = this.terrain
        ? this.terrain.heightfield.getHeight(state.position.x, state.position.z)
        : 0;
      // Airborne (or up on a ramp, which the heightfield doesn't know about —
      // ramps are planking, no dust): stop emitting, let live particles fade.
      // The lower bound matters too: a car that fell out of the world is far
      // BELOW groundY and must not spray full-rate dust at the map edge.
      const clearance = state.position.y - groundY;
      if (clearance > radius + p.groundedMargin || clearance < -radius) {
        ps.emitRate = 0;
        continue;
      }

      // Surface blend under the contact: color and dustiness follow the same
      // weights the terrain shader paints with.
      let r = SURFACES[0].r;
      let g = SURFACES[0].g;
      let b = SURFACES[0].b;
      let amount = SURFACES[0].amount;
      if (this.terrain) {
        sampleSplat(this.terrain, state.position.x, state.position.z, this.weights);
        r = g = b = amount = 0;
        for (let c = 0; c < 4; c++) {
          const w = this.weights[c];
          r += w * SURFACES[c].r;
          g += w * SURFACES[c].g;
          b += w * SURFACES[c].b;
          amount += w * SURFACES[c].amount;
        }
      }

      const roll = Math.max(state.rollSpeed - p.rollMinSpeed, 0);
      const skid = Math.max(state.slipSpeed - p.skidThreshold, 0);
      const rate = amount * (roll * p.rollRate + skid * p.skidRate);
      if (rate < 1) {
        ps.emitRate = 0;
        continue;
      }
      ps.emitRate = Math.min(rate, p.maxRate);

      (ps.emitter as Vector3).set(state.position.x, groundY + 0.05, state.position.z);
      // Skids read denser and chunkier, not just more numerous.
      const alpha = Math.min(0.3 + 0.05 * skid, 0.7);
      ps.color1.set(r * 1.12, g * 1.12, b * 1.12, alpha);
      ps.color2.set(r * 0.82, g * 0.82, b * 0.82, alpha);
      ps.colorDead.set(r, g, b, 0);
      const grow = Math.min(skid * 0.05, 0.3);
      ps.minSize = 0.16 + grow;
      ps.maxSize = 0.55 + 2 * grow;

      // Rooster tail: throw material back along the hub's travel and upward,
      // harder the harder the skid.
      const kickX = -state.velocity.x * p.kickBack;
      const kickZ = -state.velocity.z * p.kickBack;
      const kickY = p.kickUp + 0.25 * skid;
      ps.direction1.set(kickX - p.spread, kickY * 0.35, kickZ - p.spread);
      ps.direction2.set(kickX + p.spread, kickY, kickZ + p.spread);
    }
  }
}

/** Soft white radial blob the per-particle color tints — no asset needed. */
function createDustTexture(scene: Scene): Texture {
  const size = 64;
  const tex = new DynamicTexture('dustTex', size, scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2 - 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  return tex;
}
