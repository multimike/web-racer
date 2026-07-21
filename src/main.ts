import { createScene } from './scene/createScene';
import type { TerrainMode, ViewMode } from './scene/createScene';
import { CompositeInput } from './input/CompositeInput';
import { DesktopGamepadInput } from './input/DesktopGamepadInput';
import { KeyboardInput } from './input/KeyboardInput';
import { RigidWheelVehicle } from './car/RigidWheelVehicle';
import { EngineSound } from './audio/EngineSound';
import { createTuningPanel } from './ui/TuningPanel';

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;

const params = new URLSearchParams(location.search);
const terrain: TerrainMode = params.get('terrain') === 'flat' ? 'flat' : 'hills';
const seed = Number.parseInt(params.get('seed') ?? '', 10) || 1;
const view: ViewMode = params.get('view') === 'xr' ? 'xr' : 'chase';

// A/B links that flip one param and keep the rest.
function linkWith(overrides: Record<string, string>): string {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(overrides)) p.set(k, v);
  return `?${p.toString()}`;
}

const otherTerrain: TerrainMode = terrain === 'hills' ? 'flat' : 'hills';
const otherView: ViewMode = view === 'xr' ? 'chase' : 'xr';
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:10;color:#fff;font:13px monospace;' +
  'background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:4px;';
hud.innerHTML =
  `terrain: <b>${terrain}</b> <a href="${linkWith({ terrain: otherTerrain })}" style="color:#8cf">switch</a>` +
  ` &nbsp;|&nbsp; seed: <b>${seed}</b> <a href="${linkWith({ seed: String(seed + 1) })}" style="color:#8cf">next</a>` +
  ` &nbsp;|&nbsp; view: <b>${view}</b> <a href="${linkWith({ view: otherView })}" style="color:#8cf">switch</a>`;
document.body.appendChild(hud);

const input = new CompositeInput([new DesktopGamepadInput(), new KeyboardInput()]);

// Engine sound rpm: idle floor and how far flooring it from a stop revs the
// engine. Gearless for now (AutomaticGearbox is parked — shifts were barely
// audible against the car's ~2 s full acceleration run).
const SOUND_IDLE_RPM = 0.08;
const SOUND_STALL_REV = 0.25;

createScene(canvas, input, terrain, seed, view).then((game) => {
  let engineSound: EngineSound | undefined;
  if (game.car instanceof RigidWheelVehicle) {
    const car = game.car;
    // Sine-layer engine sound (see sound-lab.html for the tuning playground).
    // Audio unlocks on the first click/key press.
    const sound = new EngineSound();
    engineSound = sound;
    sound.attachUnlock();
    game.scene.onBeforeRenderObservable.add(() => {
      const intent = input.poll();
      // While reversing, the brake pedal is the active "throttle".
      const pedal = car.isReversing ? intent.brake : intent.throttle;
      const speedRpm = Math.min(Math.abs(car.forwardSpeed) / car.tuning.maxSpeed, 1);
      const rpm = Math.max(speedRpm, pedal * SOUND_STALL_REV, SOUND_IDLE_RPM);
      sound.update(pedal, rpm);
    });
    createTuningPanel(game.scene, car, input);
  }
  if (import.meta.env.DEV) {
    // Handy for the Babylon Inspector / console poking during development.
    const dev = { ...game, engineSound };
    (window as unknown as { __game: typeof dev }).__game = dev;
  }
});
