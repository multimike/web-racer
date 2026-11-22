import type { SolidMesh } from '../../../gfx/solid';
import type { CarGeometry, CarSpec } from '../../types';
import type { Color } from './common';
import { buildHub } from './hub';
import type { HubSize } from './hub';
import { addSuspensionMounts, buildSuspension, suspensionAnchors, suspensionReport } from './suspension';
import type { AxleMounts, CornerAnchors, MountOptions, SuspensionOptions } from './suspension';
import { buildWheel } from './wheel';
import type { WheelOptions } from './wheel';

/**
 * RUNNING GEAR — wheels, hubs and suspension of a car from ONE call.
 *
 * A wheel, the hub behind it and the suspension that meets that hub must all
 * be built from the same radius / width / rim ratio / damper foot, or joints
 * silently miss each other. Built one by one that is four places to keep in
 * step; `buildRunningGear` takes the sizes from the `CarSpec` once.
 */

/** Everything about a wheel except its size, which comes from the spec. */
export type WheelStyle = Omit<WheelOptions, 'radius' | 'width'>;

export interface RunningGearOptions extends SuspensionOptions {
  /** Tread, rim and colours per axle; `both` is the base for the two. */
  wheels?: { both?: WheelStyle; front?: WheelStyle; rear?: WheelStyle };
  /** Brake caliper colour (both axles). */
  caliper?: Color;
}

export interface RunningGear extends Pick<CarGeometry, 'wheelFront' | 'wheelRear' | 'links'> {
  hubFront: SolidMesh;
  hubRear: SolidMesh;
  /** The resolved hard points of all four corners (`suspensionAnchors`):
   * run your frame tubes and shock towers to these. */
  anchors: CornerAnchors[];
  /** Put the matching body-side brackets on the body mesh. */
  addMounts(body: SolidMesh, mount?: MountOptions): void;
  /** Solved clearances around the coil-overs (`suspensionReport`). */
  report: ReturnType<typeof suspensionReport>;
}

/**
 * Wheels + hubs + suspension links, sized from the spec and guaranteed to
 * agree with each other.
 *   const gear = buildRunningGear(SPEC, {
 *     wheels: { both: { ring: accent }, front: { tread: 'knobby', rim: 'split' }, rear: { tread: 'block' } },
 *     springColor: glow, caliper: accent,
 *     front: { damperTop: [0.37, 0.82, 1.2] },
 *     rear:  { damperTop: [0.30, 1.04, -1.2], halfShaft: true },
 *   });
 *   gear.addMounts(body);
 *   return { body, ...pick(gear), … }   // wheelFront, wheelRear, hubFront, hubRear, links
 */
export function buildRunningGear(spec: CarSpec, o: RunningGearOptions = {}): RunningGear {
  const style = (axle: 'front' | 'rear'): WheelStyle => ({ ...o.wheels?.both, ...o.wheels?.[axle] });
  const size = (axle: 'front' | 'rear'): { radius: number; width: number } =>
    axle === 'front' ? { radius: spec.frontTireRadius, width: spec.frontTireWidth } : { radius: spec.rearTireRadius, width: spec.rearTireWidth };
  // The wheel's own proportions are the hub's and the suspension's too.
  const mounts = (axle: 'front' | 'rear'): AxleMounts => {
    const w = style(axle);
    const shared: Partial<HubSize> = {};
    if (w.rimRatio !== undefined) shared.rimRatio = w.rimRatio;
    if (w.dish !== undefined) shared.dish = w.dish;
    if (w.lugHeight !== undefined) shared.lugHeight = w.lugHeight;
    return { ...o[axle], wheel: { ...shared, ...o[axle]?.wheel } };
  };
  const suspension: SuspensionOptions = { ...o, front: mounts('front'), rear: mounts('rear') };
  const anchors = suspensionAnchors(spec, suspension);
  const hub = (axle: 'front' | 'rear'): SolidMesh => {
    const c = anchors[axle === 'front' ? 1 : 3];
    return buildHub({
      ...suspension[axle]?.wheel,
      ...size(axle),
      damperFoot: c.hubPoints.damperFoot,
      coilRadius: c.hubPoints.coilRadius,
      caliper: o.caliper,
      steeringArm: c.tieRod !== null,
    });
  };
  return {
    wheelFront: buildWheel({ ...style('front'), ...size('front') }),
    wheelRear: buildWheel({ ...style('rear'), ...size('rear') }),
    hubFront: hub('front'),
    hubRear: hub('rear'),
    links: buildSuspension(spec, suspension),
    anchors,
    addMounts: (body, mount) => addSuspensionMounts(body, spec, suspension, mount),
    report: suspensionReport(spec, suspension),
  };
}
