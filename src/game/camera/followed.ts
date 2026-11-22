import type { Vehicle } from '../../car/Vehicle';

/**
 * Which vehicles a camera rig is FOLLOWING right now (chase / high with that
 * vehicle as its subject). `GameCar.syncVisual` keeps such a car at full
 * detail whatever its distance: the high camera sits ~18 m from its subject,
 * beyond the 14 m LOD 0 distance, and the followed car is the one the player
 * looks at — its suspension must show. Other cars keep distance LOD.
 *
 * A side channel between the camera rig and the game car (the rig sets it, the game car
 * reads it), so the consumer wires nothing: `car.syncVisual(dt, rig.eye)`
 * stays the whole contract. Counted, so two rigs on one car work.
 */
const followers = new WeakMap<Vehicle, number>();

export function isFollowedByCamera(vehicle: Vehicle): boolean {
  return (followers.get(vehicle) ?? 0) > 0;
}

/** Move one rig's "follows" mark from `from` to `to` (either may be null). */
export function moveFollowMark(from: Vehicle | null, to: Vehicle | null): void {
  if (from === to) return;
  if (from) {
    const n = (followers.get(from) ?? 0) - 1;
    if (n > 0) followers.set(from, n);
    else followers.delete(from);
  }
  if (to) followers.set(to, (followers.get(to) ?? 0) + 1);
}
