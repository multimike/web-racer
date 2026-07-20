import { createScene } from './scene/createScene';
import type { VehicleMode } from './scene/createScene';
import { CompositeInput } from './input/CompositeInput';
import { DesktopGamepadInput } from './input/DesktopGamepadInput';
import { KeyboardInput } from './input/KeyboardInput';

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;

const mode: VehicleMode =
  new URLSearchParams(location.search).get('vehicle') === 'rigid' ? 'rigid' : 'raycast';

// Small overlay showing which vehicle model is active, with a link to the other.
const other: VehicleMode = mode === 'rigid' ? 'raycast' : 'rigid';
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;z-index:10;color:#fff;font:13px monospace;' +
  'background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:4px;';
hud.innerHTML = `vehicle: <b>${mode}</b> &nbsp;|&nbsp; <a href="?vehicle=${other}" style="color:#8cf">switch to ${other}</a>`;
document.body.appendChild(hud);

const input = new CompositeInput([new DesktopGamepadInput(), new KeyboardInput()]);

createScene(canvas, input, mode).then((game) => {
  if (import.meta.env.DEV) {
    // Handy for the Babylon Inspector / console poking during development.
    (window as unknown as { __game: typeof game }).__game = game;
  }
});
