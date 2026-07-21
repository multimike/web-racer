import type { Scene } from '@babylonjs/core/scene';
import type { RigidWheelVehicle, RigidWheelTuning } from '../car/RigidWheelVehicle';
import type { AutomaticGearbox } from '../car/AutomaticGearbox';
import type { InputProvider } from '../input/types';

interface SliderSpec {
  key: keyof RigidWheelTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Called after the tuning field is updated, for values Havok needs pushed. */
  apply?: (car: RigidWheelVehicle) => void;
}

const SLIDERS: SliderSpec[] = [
  { key: 'comHeight', label: 'CoM height', min: -0.5, max: 0.4, step: 0.01, apply: (c) => c.applyCenterOfMass() },
  { key: 'comForward', label: 'CoM fwd/back', min: -1.0, max: 1.0, step: 0.05, apply: (c) => c.applyCenterOfMass() },
  { key: 'wheelFriction', label: 'tire friction', min: 0.2, max: 8, step: 0.1, apply: (c) => c.applyWheelFriction() },
  { key: 'maxDriveTorque', label: 'drive torque', min: 500, max: 20000, step: 250 },
  { key: 'maxSpeed', label: 'max speed', min: 5, max: 40, step: 1 },
];

/**
 * Dev tuning overlay: sliders bound straight to the vehicle's live tuning
 * object (COM and friction get pushed into Havok on change), plus throttle
 * and brake pedal bars fed from the input provider every frame.
 */
export function createTuningPanel(
  scene: Scene,
  car: RigidWheelVehicle,
  input: InputProvider,
  gearbox?: AutomaticGearbox,
): void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:10;color:#fff;font:12px monospace;' +
    'background:rgba(0,0,0,0.55);padding:8px 12px;border-radius:4px;width:230px;' +
    'user-select:none;';
  panel.innerHTML = '<b>car tuning</b><br>';

  for (const spec of SLIDERS) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:6px;';

    const caption = document.createElement('div');
    caption.style.cssText = 'display:flex;justify-content:space-between;';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const value = document.createElement('span');
    value.style.color = '#8cf';
    caption.append(name, value);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = String(car.tuning[spec.key]);
    slider.style.cssText = 'width:100%;margin:2px 0 0;';

    const decimals = spec.step < 1 ? 2 : 0;
    const show = () => (value.textContent = Number(slider.value).toFixed(decimals));
    show();

    slider.addEventListener('input', () => {
      (car.tuning[spec.key] as number) = Number(slider.value);
      spec.apply?.(car);
      show();
    });

    // Keep A/D etc. from steering the car while a slider has focus.
    slider.addEventListener('keydown', (e) => e.preventDefault());

    row.append(caption, slider);
    panel.appendChild(row);
  }

  const throttleBar = makePedalBar(panel, 'throttle', '#4c4');
  const brakeBar = makePedalBar(panel, 'brake', '#d44');
  const gearDisplay = gearbox ? makeGearDisplay(panel, gearbox.gearCount) : null;
  const rpmBar = gearbox ? makePedalBar(panel, 'rpm', '#fa4') : null;

  scene.onBeforeRenderObservable.add(() => {
    // Providers are pure state reads, so a second poll per frame is free.
    const intent = input.poll();
    throttleBar.style.width = `${(intent.throttle * 100).toFixed(0)}%`;
    brakeBar.style.width = `${(intent.brake * 100).toFixed(0)}%`;
    if (gearbox && gearDisplay && rpmBar) {
      gearDisplay(gearbox.label);
      rpmBar.style.width = `${(gearbox.rpm * 100).toFixed(0)}%`;
    }
  });

  document.body.appendChild(panel);
}

/** Row of gear chips (R 1 2 …); returns a setter highlighting the active one. */
function makeGearDisplay(panel: HTMLElement, gearCount: number): (label: string) => void {
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:8px;display:flex;gap:4px;align-items:center;';
  const name = document.createElement('span');
  name.textContent = 'gear';
  name.style.marginRight = '4px';
  row.appendChild(name);

  const labels = ['R', ...Array.from({ length: gearCount }, (_, i) => String(i + 1))];
  const chips = new Map<string, HTMLElement>();
  for (const g of labels) {
    const chip = document.createElement('span');
    chip.textContent = g;
    chip.style.cssText =
      'flex:1;text-align:center;padding:2px 0;border-radius:3px;' +
      'background:rgba(255,255,255,0.12);color:#888;font-weight:bold;';
    chips.set(g, chip);
    row.appendChild(chip);
  }
  panel.appendChild(row);

  let active = '';
  return (label: string) => {
    if (label === active) return;
    for (const [g, chip] of chips) {
      const on = g === label;
      chip.style.background = on ? (g === 'R' ? '#d44' : '#fa4') : 'rgba(255,255,255,0.12)';
      chip.style.color = on ? '#000' : '#888';
    }
    active = label;
  };
}

/** Label + track; returns the fill element whose width shows the pedal value. */
function makePedalBar(panel: HTMLElement, label: string, color: string): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:6px;';
  const name = document.createElement('div');
  name.textContent = label;
  const track = document.createElement('div');
  track.style.cssText = 'height:8px;background:rgba(255,255,255,0.15);border-radius:3px;overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText = `height:100%;width:0%;background:${color};`;
  track.appendChild(fill);
  row.append(name, track);
  panel.appendChild(row);
  return fill;
}
