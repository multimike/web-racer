import { PathPlan } from '../../car/DriverModel';

/** Speed-plan budgets that never bind — for paths driven at a fixed speed. */
const FREE = { cornerAccel: 1e6, brakeAccel: 1e6, driveAccel: 1e6, maxSpeed: 1e3 };

/**
 * Circle of radius R through the origin, tangent to +z there. `dir` +1 turns
 * right (centre at (+R, 0)), −1 left.
 */
export function circlePath(R: number, dir: 1 | -1 = 1): PathPlan {
  const n = Math.max(72, Math.round((2 * Math.PI * R) / 0.5));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * 2 * Math.PI;
    pts.push(dir * (R - R * Math.cos(phi)), R * Math.sin(phi));
  }
  return new PathPlan(pts, { ...FREE, closed: true });
}

/** Polyline along +z with lateral position x(z), sampled every 0.5 m. */
export function profilePath(z0: number, z1: number, x: (z: number) => number): PathPlan {
  const pts: number[] = [];
  for (let z = z0; z <= z1 + 1e-6; z += 0.5) pts.push(x(z), z);
  return new PathPlan(pts, { ...FREE, closed: false });
}

export interface LaneChange {
  plan: PathPlan;
  /** z where the last transition ends (settle time is measured from here). */
  zEnd: number;
  offset: number;
}

/**
 * Double lane change: 20 m straight, shift `offset` over `transition`
 * metres, 20 m in the other lane, shift back, straight on. Cosine blends.
 * Sized for this game's gravity: at 20 m/s the 18 m transitions ask for
 * ≈ 0.7 of mu·g (25 m/s², mu 1.2) — a hard but feasible avoidance move.
 */
export function laneChangePath(offset = 3.5, transition = 18): LaneChange {
  const a = 20;
  const b = a + transition;
  const c = b + 20;
  const d = c + transition;
  const blend = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
  const x = (z: number) => {
    if (z < a) return 0;
    if (z < b) return offset * blend((z - a) / transition);
    if (z < c) return offset;
    if (z < d) return offset * (1 - blend((z - c) / transition));
    return 0;
  };
  return { plan: profilePath(-20, d + 80, x), zEnd: d, offset };
}

export interface Slalom {
  plan: PathPlan;
  /** z of each cone (cones stand on x = 0). */
  cones: number[];
  /** Side the car must pass each cone on: +1 = right (x > 0). */
  sides: number[];
  zEnd: number;
}

/** Cones `spacing` apart on the centreline; the path weaves ±amplitude. */
export function slalomPath(count = 6, spacing = 18, amplitude = 2.2): Slalom {
  const first = 30;
  const zIn = first - spacing / 2;
  const zOut = first + (count - 1) * spacing + spacing / 2;
  const x = (z: number) => (z < zIn || z > zOut ? 0 : amplitude * Math.cos((Math.PI * (z - first)) / spacing));
  const cones: number[] = [];
  const sides: number[] = [];
  for (let k = 0; k < count; k++) {
    cones.push(first + k * spacing);
    sides.push(k % 2 === 0 ? 1 : -1);
  }
  return { plan: profilePath(-20, zOut + 70, x), cones, sides, zEnd: zOut };
}
