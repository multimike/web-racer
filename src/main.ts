import { createScene } from './scene/createScene';
import type { TerrainMode, ViewMode } from './scene/createScene';
import { CompositeInput } from './input/CompositeInput';
import { DesktopGamepadInput } from './input/DesktopGamepadInput';
import { KeyboardInput } from './input/KeyboardInput';
import { RigidWheelVehicle } from './car/RigidWheelVehicle';
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

createScene(canvas, input, terrain, seed, view).then((game) => {
  if (game.car instanceof RigidWheelVehicle) {
    createTuningPanel(game.scene, game.car, input);
  }
  if (import.meta.env.DEV) {
    // Handy for the Babylon Inspector / console poking during development.
    (window as unknown as { __game: typeof game }).__game = game;
  }
});
