/**
 * PHYSICS LAB — the measurement harness every vehicle model is judged with.
 * Page: /physics-lab.html (dev server only). Headless: tools/physlab.sh.
 *
 *   ?model=<name>   vehicle model from src/car/createVehicle.ts (raycast | assist |
 *                   hybrid | rigid = legacy;
 *                   'reference' = the lab's own known-answer planar car, for
 *                   checking the harness itself — flat maneuvers only)
 *   &car=<id>       reef-rocket (default) | riot-ram | comet-fox | neon-wasp | rb01
 *                   (rb01 + model 'rigid' = the old hardcoded RB-01 layout, lab only)
 *   &suite=<list>   all (default) | comma-separated maneuver names
 *   &dt=<step>      fixed physics step, e.g. 1/60 (default), 1/72, 0.0111
 *   &seed=<n>       terrain seed for the hill lap (default 1)
 *   &watch=1        render in real time (chase camera, collider proxies)
 *   &series=0       drop the 10 Hz debug time series from the JSON
 *   &handling=0     skip the car's handling preset (src/car/handling.ts)
 *   &tune=k:v,k:v   tuning overrides pushed through Vehicle.setTuning
 *   &driver=k:v,..  DriverModel parameter overrides for every driver in the
 *                   suite (sensitivity check: is it the car or the driver?)
 *
 * When finished, the full result JSON is in <pre id="result"> and
 * document.title is "done" ("error" if the harness itself failed).
 *
 * HOW IT WORKS: every maneuver case builds a fresh scene + Havok world +
 * vehicle (src/lab/physics/sim.ts) and advances it with manual fixed steps —
 * no render loop, no wall clock — so a rerun reproduces the same numbers.
 *
 * ADD A MODEL:    see the header of src/car/createVehicle.ts.
 * ADD A MANEUVER: see src/lab/physics/maneuvers/index.ts.
 */
import { ArcRotateCamera, Color3, Color4, Engine, NullEngine, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { AbstractEngine, Mesh } from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import { loadVehicleModel, registerVehicleModel, vehicleModelNames } from '../car/createVehicle';
import { CAR_SPECS, DEFAULT_CAR_ID, rigFor } from '../car/rig';
import type { VehicleRig } from '../car/rig';
import { MANEUVERS } from './physics/maneuvers';
import { FLAT } from './physics/maneuvers/common';
import { buildScorecard } from './physics/scorecard';
import { referenceModel } from './physics/ReferenceVehicle';
import { Sim, round } from './physics/sim';
import type { LabEnv } from './physics/sim';
import { LAB_GRAVITY } from './physics/world';
import type { LabResult, ManeuverResult, MetricValue } from './physics/types';

const HARNESS_VERSION = 'physics-lab/1';

// Lab-only calibration model (known-answer planar car, flat maneuvers only).
registerVehicleModel(referenceModel);

const statusEl = document.getElementById('status')!;
const resultEl = document.getElementById('result')!;
const scoreEl = document.getElementById('scorecard')!;
const errors: string[] = [];

window.addEventListener('error', (e) => errors.push(`error: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${String(e.reason)}`));

function parseDt(text: string | null): number {
  if (!text) return 1 / 60;
  const parts = text.split('/');
  const value = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(text);
  if (!(value > 0.0005 && value <= 0.1)) throw new Error(`bad dt '${text}'`);
  return value;
}

function parseTune(text: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!text) return out;
  for (const pair of text.split(',')) {
    const [key, value] = pair.split(':');
    if (!key || !Number.isFinite(Number(value))) throw new Error(`bad tune entry '${pair}'`);
    out[key] = Number(value);
  }
  return out;
}

function rigSummary(rig: VehicleRig | null): Record<string, MetricValue> {
  if (!rig) return { layout: 'legacy RB-01 (hardcoded in RigidWheelVehicle): 1300 kg chassis + 4 x 50 kg wheels' };
  return {
    totalMass: round(rig.totalMass, 1),
    sprungMass: round(rig.sprungMass, 1),
    frontWheelMass: round(rig.front.wheelMass, 1),
    rearWheelMass: round(rig.rear.wheelMass, 1),
    wheelbase: rig.wheelbase,
    frontTrack: rig.front.track,
    rearTrack: rig.rear.track,
    frontTireRadius: rig.front.tireRadius,
    rearTireRadius: rig.rear.tireRadius,
    comHeight: round(rig.com[1], 3),
    comZ: round(rig.com[2], 3),
    frontWeightFraction: rig.frontWeightFraction,
    yawInertia: round(rig.inertia[1], 1),
    rollInertia: round(rig.inertia[2], 1),
    frontSpringRate: round(rig.front.springRate, 0),
    rearSpringRate: round(rig.rear.springRate, 0),
    staticSag: round(rig.front.staticSag, 4),
    // Quasi-static rollover threshold over grip: track / (2 h) in g.
    staticStabilityFactor: round(Math.min(rig.front.track, rig.rear.track) / (2 * rig.com[1]), 3),
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const model = params.get('model') ?? 'rigid';
  const carId = params.get('car') ?? DEFAULT_CAR_ID;
  const dt = parseDt(params.get('dt'));
  const seed = Number.parseInt(params.get('seed') ?? '', 10) || 1;
  const watch = params.get('watch') === '1';
  const keepSeries = params.get('series') !== '0';
  const tune = parseTune(params.get('tune'));
  const driverTune = parseTune(params.get('driver'));
  const suiteParam = params.get('suite') ?? 'all';
  const names = suiteParam === 'all' ? MANEUVERS.map((m) => m.name) : suiteParam.split(',').filter(Boolean);
  for (const name of names) {
    if (!MANEUVERS.some((m) => m.name === name)) {
      throw new Error(`unknown maneuver '${name}' (available: ${MANEUVERS.map((m) => m.name).join(', ')})`);
    }
  }
  if (!CAR_SPECS[carId]) throw new Error(`unknown car '${carId}' (available: ${Object.keys(CAR_SPECS).join(', ')})`);

  statusEl.textContent = `loading model '${model}' (available: ${vehicleModelNames().join(', ')})…`;
  await loadVehicleModel(model);
  const havok = await HavokPhysics();

  let engine: AbstractEngine;
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  if (watch) {
    document.body.classList.add('watch');
    engine = new Engine(canvas, true);
    window.addEventListener('resize', () => engine.resize());
  } else {
    // No WebGL needed: nothing is ever rendered.
    engine = new NullEngine();
  }

  // 'rigid' + rb01 = the old hardcoded RB-01 layout (lab only); everything else is rig-built.
  const rig = model === 'rigid' && carId === 'rb01' ? null : rigFor(carId, { gravity: LAB_GRAVITY });

  const env: LabEnv = {
    engine, havok, model, carId, rig, dt, seed, watch, keepSeries, tune,
    handling: params.get('handling') !== '0',
    nominalGrip: 1,
    driverTune,
    totals: { steps: 0, simSeconds: 0 },
  };
  if (watch) attachWatch(env, canvas);

  // Probe vehicle: tuning snapshot + declared grip for the result header.
  const probe = new Sim(env, FLAT);
  const tuning: Record<string, number> = {};
  for (const p of probe.vehicle.tuningParams) {
    const v = probe.vehicle.getTuning(p.key);
    if (v !== undefined) tuning[p.key] = round(v, 4);
  }
  const nominalGrip = probe.vehicle.nominalGrip;
  env.nominalGrip = nominalGrip;
  // What Havok actually holds for the chassis body (models must agree here).
  const mp = probe.vehicle.chassisBody.getMassProperties();
  const chassisBody: Record<string, MetricValue> = {
    mass: round(mp.mass ?? NaN, 2),
    // Havok stores inertia per unit mass; reported here in kg·m².
    inertiaPitch: round((mp.inertia?.x ?? NaN) * (mp.mass ?? NaN), 1),
    inertiaYaw: round((mp.inertia?.y ?? NaN) * (mp.mass ?? NaN), 1),
    inertiaRoll: round((mp.inertia?.z ?? NaN) * (mp.mass ?? NaN), 1),
    comY: round(mp.centerOfMass?.y ?? NaN, 3),
    comZ: round(mp.centerOfMass?.z ?? NaN, 3),
  };
  probe.dispose();

  const maneuvers: Record<string, ManeuverResult> = {};
  const wallStart = performance.now();
  for (const name of names) {
    const def = MANEUVERS.find((m) => m.name === name)!;
    statusEl.textContent = `${model} / ${carId} — running ${def.title}`;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const t0 = performance.now();
    const sim0 = env.totals.simSeconds;
    let result: ManeuverResult;
    try {
      const out = await def.run(env);
      result = {
        name,
        ...out,
        pass: out.checks.every((c) => c.pass),
        simSeconds: round(env.totals.simSeconds - sim0, 2),
        wallMs: Math.round(performance.now() - t0),
      };
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      errors.push(`maneuver ${name} threw: ${message}`);
      result = {
        name, cases: [], summary: {}, pass: false,
        checks: [{ id: `${name}.ran`, value: false, target: 'maneuver completes', pass: false }],
        simSeconds: round(env.totals.simSeconds - sim0, 2),
        wallMs: Math.round(performance.now() - t0),
        error: message,
      };
    }
    maneuvers[name] = result;
  }

  const partial: Omit<LabResult, 'scorecard'> = {
    harness: HARNESS_VERSION,
    model, car: carId, suite: names, dt, seed,
    overrides: { tune, driver: driverTune },
    gravity: LAB_GRAVITY,
    nominalGrip,
    rig: rigSummary(rig),
    chassisBody,
    tuning,
    maneuvers,
    totals: {
      simSeconds: round(env.totals.simSeconds, 1),
      wallMs: Math.round(performance.now() - wallStart),
      steps: env.totals.steps,
    },
    errors,
  };
  const result: LabResult = { ...partial, scorecard: buildScorecard(partial) };
  scoreEl.textContent = result.scorecard.text;
  resultEl.textContent = JSON.stringify(result);
  (window as unknown as { __lab: unknown }).__lab = { result, env };
  statusEl.textContent =
    `${model} / ${carId}: score ${result.scorecard.total.toFixed(1)} — ` +
    `${result.totals.simSeconds} s simulated in ${(result.totals.wallMs / 1000).toFixed(1)} s`;
  document.title = 'done';
}

/** ?watch=1: chase camera + visible collider proxies, one render per 1/60 s
 * of simulated time, paced by requestAnimationFrame. */
function attachWatch(env: LabEnv, canvas: HTMLCanvasElement): void {
  env.onSim = (sim) => {
    const scene = sim.world.scene;
    scene.clearColor = new Color4(0.13, 0.16, 0.2, 1);
    const camera = new ArcRotateCamera('labCam', -Math.PI / 2, 1.05, 22, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.maxZ = 2000;
    camera.wheelPrecision = 8;
    scene.activeCamera = camera;
    // Show what physics collides with: chassis box + wheel cylinders.
    const proxy = new StandardMaterial('proxyMat', scene);
    proxy.diffuseColor = new Color3(0.2, 0.75, 0.95);
    proxy.alpha = 0.55;
    const tire = new StandardMaterial('tireProxyMat', scene);
    tire.diffuseColor = new Color3(0.95, 0.75, 0.2);
    tire.wireframe = true;
    for (const mesh of scene.meshes) {
      if (!mesh.physicsBody || mesh.name.startsWith('lab')) continue;
      mesh.isVisible = true;
      mesh.material = mesh === sim.vehicle.chassisMesh ? proxy : tire;
    }
    for (const child of sim.vehicle.chassisMesh.getChildMeshes() as Mesh[]) child.setEnabled(false);
  };
  env.onFrame = async (sim) => {
    const scene = sim.world.scene;
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.target.copyFrom(sim.vehicle.chassisMesh.position);
    statusEl.textContent =
      `${env.model}/${env.carId}  t=${sim.time.toFixed(1)}s  v=${sim.tel.speed.toFixed(1)} m/s  ` +
      `beta=${((sim.tel.beta * 180) / Math.PI).toFixed(0)}°  steer=${sim.tel.steering.toFixed(2)} ` +
      `thr=${sim.tel.throttle.toFixed(2)} brk=${sim.tel.brake.toFixed(2)}`;
    scene.render();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };
}

main().catch((err) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  errors.push(`fatal: ${message}`);
  statusEl.textContent = `FAILED: ${message}`;
  resultEl.textContent = JSON.stringify({ harness: HARNESS_VERSION, fatal: message, errors });
  document.title = 'error';
});
