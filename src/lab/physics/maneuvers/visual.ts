import { Vector3 } from '@babylonjs/core';
import { DEG, RAD } from '../sim';
import { FLAT, Report, runCase } from './common';
import type { ManeuverDef } from './common';

/**
 * q. visual contract — `Vehicle.visual` (src/car/visual.ts) is what the
 * graphics pose the car from, so it is checked like physics: hub positions
 * against the rig at rest, steer / spin signs, suspension travel direction,
 * world-space refresh against the model's own wheel states, and the pose of
 * a car that is yawed, rolling and cornering (the model-space hubs must not
 * move when the chassis does).
 */
export const visual: ManeuverDef = {
  name: 'visual',
  title: 'q. visual contract: hub poses for graphics (rest, steer, spin, travel, world refresh)',
  async run(env) {
    const report = new Report();
    const c = await runCase(env, 'poses', FLAT, async (sim) => {
      const veh = sim.vehicle;
      const v = veh.visual;
      const rig = veh.rig;
      // --- at rest, yawed 40 deg (a yawed car catches frame mix-ups)
      sim.place({ x: 3, z: -2, yaw: 40 * RAD });
      sim.useFixed({ throttle: 0, steering: 0, brake: 0 });
      await sim.run(2.0);
      let restErr = 0;
      let restY = 0;
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        const rx = rig ? rig.wheels[i].x : Math.sign(w.position.x) * Math.abs(v.wheels[0].position.x);
        const rz = rig ? rig.wheels[i].z : w.position.z;
        restErr = Math.max(restErr, Math.hypot(w.position.x - rx, w.position.z - rz));
        restY = Math.max(restY, Math.abs(w.position.y - w.radius));
      }
      const leftRight = v.wheels[0].position.x < 0 && v.wheels[1].position.x > 0 && v.wheels[2].position.x < 0 && v.wheels[3].position.x > 0;
      const frontRear = v.wheels[0].position.z > 0 && v.wheels[2].position.z < 0;
      const grounded = v.wheels.every((w) => w.grounded);
      // World refresh vs the model's own wheel states (taken before the step).
      v.refreshWorld();
      let worldErr = 0;
      for (let i = 0; i < 4; i++) worldErr = Math.max(worldErr, Vector3.Distance(v.wheels[i].worldPosition, veh.wheelStates[i].position));
      // Root sits on the ground under the wheelbase centre.
      const root = v.root.getAbsolutePosition();
      const rootHeight = root.y;
      const rootOff = Math.hypot(root.x - 3, root.z + 2);

      // --- rolling forward, steering right
      sim.place({ x: 0, z: 0, yaw: 0, speed: 6 });
      sim.useFixed({ throttle: 0.25, steering: 0.5, brake: 0 });
      const spin0 = v.wheels[2].spinAngle;
      let spun = 0;
      let last = spin0;
      let rolled = 0;
      await sim.run(1.0, (tel) => {
        rolled += tel.vFwd * sim.dt;
        // Unwrap the wrapped spin angle.
        let d = v.wheels[2].spinAngle - last;
        if (d < -Math.PI) d += 2 * Math.PI;
        if (d > Math.PI) d -= 2 * Math.PI;
        spun += d;
        last = v.wheels[2].spinAngle;
      });
      const steerFL = v.wheels[0].steerAngle;
      const steerFR = v.wheels[1].steerAngle;
      const steerRear = Math.max(Math.abs(v.wheels[2].steerAngle), Math.abs(v.wheels[3].steerAngle));
      // Hub frame: forward axis of the front-right hub turned toward +x.
      const fwd = new Vector3(0, 0, 1).applyRotationQuaternion(v.wheels[1].rotation);
      // Distance rolled over the rear tire radius (the inner rear wheel of a
      // right turn travels a little less than the car's centre).
      const expected = rolled / v.wheels[2].radius;
      // Cornering right: the car rolls left-side-up... the OUTER (left)
      // wheels compress, the inner (right) extend.
      const travelOuter = (v.wheels[0].travel + v.wheels[2].travel) / 2;
      const travelInner = (v.wheels[1].travel + v.wheels[3].travel) / 2;

      // --- airborne: wheels droop, not grounded
      sim.place({ x: 0, z: 0, yaw: 0 });
      veh.chassisMesh.position.y += 3;
      veh.chassisMesh.computeWorldMatrix(true);
      veh.setMotion(new Vector3(0, 0, 0), 0);
      let airGrounded = 4;
      let airTravel = 0;
      await sim.run(0.25, () => {
        airGrounded = Math.min(airGrounded, v.wheels.filter((w) => w.grounded).length);
        airTravel = Math.min(airTravel, ...v.wheels.map((w) => w.travel));
      });
      return {
        restPlanarErr: restErr,
        restHeightErr: restY,
        leftRight,
        frontRear,
        groundedAtRest: grounded,
        worldRefreshErr: worldErr,
        rootHeight,
        rootOffset: rootOff,
        steerFLDeg: steerFL * DEG,
        steerFRDeg: steerFR * DEG,
        steerRearDeg: steerRear * DEG,
        hubForwardX: fwd.x,
        visualSteerDeg: v.steerAngle * DEG,
        stickSeen: v.steerInput,
        throttleSeen: v.throttle,
        spinRad: spun,
        spinExpectedRad: expected,
        travelOuter,
        travelInner,
        airGroundedMin: airGrounded,
        airTravelMin: airTravel,
      };
    });
    delete c.series;
    report.cases.push(c);
    const m = c.metrics;
    Object.assign(report.summary, m);
    // Real wheel bodies sag/settle a little differently from the rig's static
    // numbers: 4 cm of tolerance on positions.
    report.check('visual.restPosition', m.restPlanarErr, 'hubs at the rig wheel positions at rest (< 0.04 m) on a yawed car', (m.restPlanarErr as number) < 0.04 && m.leftRight === true && m.frontRear === true);
    report.check('visual.restHeight', m.restHeightErr, 'hub height = tire radius at rest (< 0.04 m)', (m.restHeightErr as number) < 0.04);
    report.check('visual.root', m.rootHeight, 'root on the ground under the wheelbase centre (< 0.04 m)', Math.abs(m.rootHeight as number) < 0.04 && (m.rootOffset as number) < 0.06);
    report.check('visual.worldRefresh', m.worldRefreshErr, 'refreshWorld() agrees with wheelStates at rest (< 0.01 m)', (m.worldRefreshErr as number) < 0.01);
    report.check('visual.steer', m.steerFRDeg, 'stick right: front hubs yaw right (inner more than outer), rears stay, hub frame turns with them', (m.steerFRDeg as number) > 3 && (m.steerFLDeg as number) > 3 && (m.steerFRDeg as number) >= (m.steerFLDeg as number) - 0.5 && (m.steerRearDeg as number) < 1 && (m.hubForwardX as number) > 0.05 && (m.visualSteerDeg as number) > 3 && Math.abs((m.stickSeen as number) - 0.5) < 0.01 && Math.abs((m.throttleSeen as number) - 0.25) < 0.01);
    report.check('visual.spin', m.spinRad, 'spin angle advances forward by distance rolled / radius (within 20 %: turning, light wheelspin)', (m.spinRad as number) > 0 && Math.abs((m.spinRad as number) / (m.spinExpectedRad as number) - 1) < 0.2);
    report.check('visual.travel', m.travelOuter, 'cornering right: outer (left) hubs compress, inner extend', (m.travelOuter as number) > (m.travelInner as number) + 0.005);
    report.check('visual.airborne', m.airGroundedMin, 'dropped from 3 m: no wheel grounded, hubs droop', m.airGroundedMin === 0 && (m.airTravelMin as number) < -0.01);
    return report.output();
  },
};
