/**
 * HUD lab (hud-lab.html): the race HUD over a backdrop that looks like the
 * game, driven by the REAL `RaceState` fed from fake cars lapping the real
 * generated track — so every state the HUD can show is reachable without the
 * 3D game, and can be pinned by URL for screenshots.
 *
 *   state=   countdown | racing | wrongway | bestlap | lap | finallap |
 *            finished | reset | cut    pin that state (simulated, then frozen)
 *   n=       3 | 2 | 1 | go           which countdown frame (state=countdown)
 *   speed= lap= laps= pos= count= bar= time= best=
 *                                     override snapshot fields when pinned
 *   cars=    number of cars (default 1 → lap timer instead of position)
 *   seed=    track seed (default 1)   vmax= fake car top speed, m/s (default 24)
 *   bg=      scene (default: vision image cropped past its painted HUD) |
 *            vision | elevated (1:1, to align against the painted HUD) | css
 *   ghost=   0..1 HUD opacity (to see the painted HUD through ours)
 *   scale=   HUD size multiplier       font= override the font stack
 *   tl=      position | timer          force the top-left panel (default auto)
 *   chips=0  no best-lap / lap-time chips (the three vision panels only)
 *   ticks=   bar tick positions, e.g. 0.375,0.56 (the painted bar exactly)
 *   clone=1  hand the HUD a fresh deep copy of the snapshot every frame, as
 *            netcode or an XR mirror would (must cost no extra DOM writes)
 *   anim=0   no animations (default when a state is pinned)
 *   warp=    simulated seconds per real second in live mode (default 1)
 *   bench=1  run a whole race through the HUD headlessly and report how
 *            often it touched the DOM and what update() cost
 *   dev=1    mock boxes where the game's dev overlays sit + the insets that clear them
 *   ui=0     hide the lab's own map / readout
 *
 * Live mode keys: W drive the wrong way, F flip the car (stuck → respawn),
 * C cut across the infield, R restart.
 */
import { Hud } from '../ui/Hud';
import { RaceState, createTrackHit, memoryBestLapStorage } from '../game/RaceState';
import type { CarSample, HudSnapshot, TrackSample } from '../game/RaceState';
import { generateTerrain } from '../terrain/generateTerrain';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number.parseFloat(params.get(key) ?? '');
  return Number.isFinite(v) ? v : fallback;
};

const fatal = document.getElementById('fatal') as HTMLElement;
window.addEventListener('error', (e) => (fatal.textContent += `${e.message}\n`));
window.addEventListener('unhandledrejection', (e) => (fatal.textContent += `${String(e.reason)}\n`));

const STEP = 1 / 60;
const state = params.get('state');
const pinned = state !== null;
const seed = Math.max(1, Math.round(num('seed', 1)));
const carCount = Math.max(1, Math.min(12, Math.round(num('cars', 1))));
const laps = Math.max(1, Math.round(num('laps', 3)));
const vmax = num('vmax', 24);
const warp = Math.max(0.1, num('warp', 1));

// ───────── backdrop ─────────

const VISION = '/design-documents/gameplay-vision/';
const bg = params.get('bg') ?? 'scene';
const shot = document.getElementById('shot') as HTMLImageElement;
if (bg === 'css') {
  shot.remove();
} else {
  // The CSS scene stays underneath, so a missing image degrades to it.
  shot.addEventListener('error', () => shot.remove());
  if (bg === 'scene') shot.classList.add('crop');
  shot.src = VISION + (bg === 'elevated' ? 'village-race-elevated-camera.png' : 'village-race-gameplay-vision.png');
}
if (params.get('ui') === '0') document.body.classList.add('bare');

// ───────── track + race ─────────

const terrain = generateTerrain(seed);
const track = terrain.track;

// "bestlap" needs a stored time to beat; "lap" needs one that will not be beaten.
const storedBest = state === 'bestlap' ? 600 : state === 'lap' || state === 'finallap' ? 1 : null;
const storage = memoryBestLapStorage(storedBest === null ? {} : { lab: storedBest });
const race = new RaceState(track, {
  laps,
  trackKey: 'lab',
  storage,
  respawn: { heightAt: (x, z) => terrain.heightfield.getHeight(x, z) },
});
const path = race.path;

// Middle of the loop: where a car that cuts across the infield heads for.
const centroid = { x: 0, z: 0 };
for (let i = 0; i < track.count; i++) {
  centroid.x += track.points[i * 2] / track.count;
  centroid.z += track.points[i * 2 + 1] / track.count;
}

// ───────── fake cars ─────────

/** Corner speed from the local turn radius, so the readout rises and falls
 * the way it will in the game. */
const cornerSpeed = (() => {
  const n = track.count;
  const out = new Float32Array(n);
  const p = track.points;
  for (let i = 0; i < n; i++) {
    const a = (i - 4 + n) % n;
    const c = (i + 4) % n;
    const ab = Math.hypot(p[i * 2] - p[a * 2], p[i * 2 + 1] - p[a * 2 + 1]);
    const bc = Math.hypot(p[c * 2] - p[i * 2], p[c * 2 + 1] - p[i * 2 + 1]);
    const ca = Math.hypot(p[a * 2] - p[c * 2], p[a * 2 + 1] - p[c * 2 + 1]);
    const area = Math.abs((p[i * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[i * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2])) / 2;
    const radius = area > 1e-6 ? (ab * bc * ca) / (4 * area) : 1e6;
    out[i] = Math.sqrt(9 * radius);
  }
  return out;
})();

interface FakeCar {
  sample: CarSample;
  /** Unwrapped arc length the driver is at. */
  s: number;
  v: number;
  /** Pace relative to the fastest car. */
  pace: number;
  lane: number;
  /** +1 with the track, −1 against it. */
  dir: number;
  /** Seconds left of a scripted off-road excursion (the C key). */
  cutT: number;
  cutLost: boolean;
  flipT: number;
}

const tmp: TrackSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, segment: 0 };
const scratchHit = createTrackHit();
const cars: FakeCar[] = [];
for (let i = 0; i < carCount; i++) {
  const id = i === 0 ? 'player' : `ai${i}`;
  cars.push({
    sample: { id, position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, speed: 0, bar: 0 },
    // The player starts at the back of the grid, like the "4 / 4" of the vision.
    s: i === 0 ? -(carCount - 1) * 5 : -(i - 1) * 5,
    v: 0,
    pace: i === 0 ? 1 : 0.9 - 0.035 * i,
    lane: i === 0 ? 0 : i % 2 ? 1.6 : -1.6,
    dir: 1,
    cutT: 0,
    cutLost: false,
    flipT: 0,
  });
  race.addCar(id, path.wrap(cars[i].s));
}
const player = cars[0];
const samples = cars.map((c) => c.sample);

function placeCar(car: FakeCar): void {
  const at = path.sample(car.s, tmp);
  const weave = car.lane + 1.2 * Math.sin(car.s / 13 + car.pace * 40);
  const p = car.sample.position;
  p.x = at.x + at.tz * weave;
  p.z = at.z - at.tx * weave;
  p.y = at.y + 0.6;
  car.sample.forward.x = at.tx * car.dir;
  car.sample.forward.z = at.tz * car.dir;
}

function stepCar(car: FakeCar, dt: number): void {
  const sample = car.sample;
  if (race.inputLocked) {
    car.v = 0;
    sample.speed = 0;
    sample.bar = 0;
    placeCar(car);
    return;
  }
  if (car.cutT > 0) {
    // Straight across the infield: tracking is lost, the far side of the
    // loop is re-acquired, and RaceState decides what that was worth —
    // normally a TRACK CUT reset, handled in step().
    car.cutT -= dt;
    const f = sample.forward;
    sample.position.x += f.x * car.v * dt;
    sample.position.z += f.z * car.v * dt;
    const st = race.carState(sample.id);
    car.cutLost = car.cutLost || st.lost;
    if ((car.cutLost && !st.lost && st.onCourse) || car.cutT <= 0) {
      // Accepted as honest (or gave up): carry on from wherever that is.
      car.cutT = 0;
      if (st.lost) race.resync(sample.id);
      car.s = st.lost ? path.locate(sample.position.x, sample.position.z, scratchHit).s : st.dist;
    }
    return;
  }
  const finished = race.snapshot(sample.id).finish !== null;
  const i = path.segmentAt(car.s + car.dir * car.v * 0.6);
  const target = finished ? 0 : Math.min(vmax * car.pace, cornerSpeed[i] * car.pace) * (car.dir < 0 ? 0.5 : 1);
  const accel = target > car.v ? 7 : -11;
  const next = car.v + accel * dt;
  car.v = accel > 0 ? Math.min(next, target) : Math.max(next, target);
  car.s += car.dir * car.v * dt;
  placeCar(car);
  sample.speed = car.v;
  // Engine load stand-in: high while accelerating, easing off at speed.
  const load = accel > 0 && car.v < target ? 1 : 0.35 + 0.4 * (car.v / vmax);
  sample.bar = (sample.bar ?? 0) + (load - (sample.bar ?? 0)) * Math.min(1, dt * 5);
  if (car.flipT > 0) {
    car.flipT -= dt;
    sample.up!.y = -1;
    car.v = 0;
  } else {
    sample.up!.y = 1;
  }
}

let simTime = 0;

/** One fixed step of the whole lab world. */
function step(): void {
  simTime += STEP;
  for (const car of cars) stepCar(car, STEP);
  race.update(STEP, samples);
  for (const car of cars) {
    if (race.snapshot(car.sample.id).needsReset) {
      const pose = race.respawn(car.sample.id);
      // What the game does with the pose: put the car there, stopped.
      car.s = race.carState(car.sample.id).dist;
      car.v = 0;
      car.dir = 1;
      car.cutT = 0;
      car.cutLost = false;
      car.flipT = 0;
      car.sample.position.x = pose.position.x;
      car.sample.position.y = pose.position.y;
      car.sample.position.z = pose.position.z;
      car.sample.forward.x = pose.forward.x;
      car.sample.forward.z = pose.forward.z;
    }
  }
}

function restart(): void {
  simTime = 0;
  cars.forEach((car, i) => {
    car.s = i === 0 ? -(carCount - 1) * 5 : -(i - 1) * 5;
    car.v = 0;
    car.dir = 1;
    car.cutT = 0;
    car.flipT = 0;
    placeCar(car);
  });
  race.restart();
}

/** Send the player straight across the infield (the C key, state=cut). */
function startCut(): void {
  const p = player.sample.position;
  const dx = centroid.x - p.x;
  const dz = centroid.z - p.z;
  const dl = Math.hypot(dx, dz) || 1;
  player.sample.forward.x = dx / dl;
  player.sample.forward.z = dz / dl;
  player.v = Math.max(player.v, 12);
  player.cutT = 30;
  player.cutLost = false;
}

// ───────── pinned states ─────────

const snap = (): HudSnapshot => race.snapshot('player');

/** Run the simulation (no rendering) until `done`, at most `limit` seconds. */
function runUntil(done: () => boolean, limit = 900): boolean {
  for (let i = 0; i < limit / STEP; i++) {
    step();
    if (done()) return true;
  }
  return false;
}

function pin(name: string): boolean {
  switch (name) {
    case 'countdown': {
      const n = params.get('n') === 'go' ? 0 : Math.round(num('n', 3));
      // A little into the frame so the number is fully popped in.
      return runUntil(() => snap().countdown === n) && (runUntil(() => false, 0.4), true);
    }
    case 'racing':
      return runUntil(() => snap().phase === 'racing' && snap().countdown === null && snap().raceTime > num('at', 7));
    case 'wrongway':
      runUntil(() => snap().raceTime > 4);
      player.dir = -1;
      return runUntil(() => snap().wrongWay) && (runUntil(() => false, 0.5), true);
    case 'bestlap':
      return runUntil(() => snap().flash?.kind === 'best-lap' && snap().flash!.age > 0.6);
    case 'lap':
      return runUntil(() => snap().flash?.kind === 'lap' && snap().flash!.age > 0.6);
    case 'finallap':
      return runUntil(() => snap().flash?.kind === 'final-lap' && snap().flash!.age > 0.6);
    case 'reset':
      runUntil(() => snap().raceTime > 4);
      player.flipT = 3;
      return runUntil(() => snap().flash?.kind === 'respawn' && snap().flash!.age > 0.3);
    case 'cut':
      // Where the cut starts decides whether it is one: from some places
      // the chord across the infield is no shorter than the road.
      runUntil(() => snap().raceTime > num('at', 9));
      startCut();
      return runUntil(() => snap().flash?.kind === 'respawn' && snap().flash!.age > 0.3, 60);
    case 'finished':
      return runUntil(() => snap().finish !== null) && (runUntil(() => false, 0.5), true);
    default:
      fatal.textContent += `unknown state "${name}"\n`;
      return false;
  }
}

/** URL overrides on top of the simulated snapshot (pinned shots only). */
function withOverrides(s: HudSnapshot): HudSnapshot {
  const out = { ...s };
  if (params.has('speed')) out.speedKmh = Math.round(num('speed', out.speedKmh));
  if (params.has('bar')) out.bar = num('bar', out.bar);
  if (params.has('lap')) out.lap = Math.round(num('lap', out.lap));
  if (params.has('pos')) out.position = Math.round(num('pos', out.position));
  if (params.has('count')) out.count = Math.round(num('count', out.count));
  if (params.has('time')) out.lapTime = num('time', out.lapTime);
  if (params.has('best')) out.bestLap = num('best', 0) > 0 ? num('best', 0) : null;
  return out;
}

// ───────── HUD ─────────

const dev = params.get('dev') === '1';
if (dev) {
  const links = document.createElement('div');
  links.className = 'devbox';
  links.id = 'dev-links';
  links.innerHTML = 'terrain: <b>hills</b> switch &nbsp;|&nbsp; seed: <b>1</b> next &nbsp;|&nbsp; view: <b>chase</b> switch';
  const tuning = document.createElement('div');
  tuning.className = 'devbox';
  tuning.id = 'dev-tuning';
  tuning.innerHTML = '<b>car tuning</b>';
  document.body.append(links, tuning);
}

const tlParam = params.get('tl');
const ticksParam = params.get('ticks');
const hud = new Hud({
  scale: num('scale', 1),
  topLeft: tlParam === 'position' || tlParam === 'timer' ? tlParam : 'auto',
  chips: params.get('chips') !== '0',
  barTicks:
    ticksParam === null
      ? undefined
      : ticksParam
          .split(',')
          .map((t) => Number.parseFloat(t))
          .filter((t) => Number.isFinite(t)),
  animate: params.has('anim') ? params.get('anim') !== '0' : !pinned,
  fontFamily: params.get('font') ?? undefined,
  // With the dev overlays up: drop below the link bar, move the lap panel
  // left of the tuning panel. This is the recipe the game integration uses
  // until the dev panels are hidden by default.
  insets: dev ? { top: 34 } : undefined,
  lapPanelShift: dev ? { x: 262 } : undefined,
});
if (params.has('ghost')) hud.root.style.opacity = String(num('ghost', 1));

// How often the HUD really touches the DOM (it should be a couple of text
// nodes per frame, never a rebuild) — shown in the readout. takeRecords()
// right after update() attributes mutations to exactly that call.
const observer = new MutationObserver(() => {});
observer.observe(hud.root, { subtree: true, childList: true, characterData: true, attributes: true });
const dom = { frames: 0, writes: 0, max: 0, idleFrames: 0, ms: 0 };
const cloneEachFrame = params.get('clone') === '1';
function paint(live: HudSnapshot): void {
  const s = cloneEachFrame ? structuredClone(live) : live;
  observer.takeRecords();
  const t0 = performance.now();
  hud.update(s);
  dom.ms += performance.now() - t0;
  const n = observer.takeRecords().length;
  dom.frames++;
  dom.writes += n;
  if (n > dom.max) dom.max = n;
  if (n === 0) dom.idleFrames++;
}

// ───────── lab furniture: map + readout ─────────

const map = document.getElementById('map') as HTMLCanvasElement;
const ctx = map.getContext('2d')!;
const readout = document.getElementById('readout') as HTMLElement;
// Fit the loop's bounding box: the start line is at the origin, so the loop
// itself sits off to one side of it.
const bounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
for (let i = 0; i < track.count; i++) {
  bounds.x0 = Math.min(bounds.x0, track.points[i * 2]);
  bounds.x1 = Math.max(bounds.x1, track.points[i * 2]);
  bounds.z0 = Math.min(bounds.z0, track.points[i * 2 + 1]);
  bounds.z1 = Math.max(bounds.z1, track.points[i * 2 + 1]);
}
const mapScale = (map.width - 90) / Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
const mx = (x: number): number => map.width / 2 + (x - (bounds.x0 + bounds.x1) / 2) * mapScale;
// +z (the start heading) points up the map.
const mz = (z: number): number => map.height / 2 - (z - (bounds.z0 + bounds.z1) / 2) * mapScale;

function drawMap(): void {
  ctx.clearRect(0, 0, map.width, map.height);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= track.count; i++) {
    const j = i % track.count;
    if (i === 0) ctx.moveTo(mx(track.points[0]), mz(track.points[1]));
    else ctx.lineTo(mx(track.points[j * 2]), mz(track.points[j * 2 + 1]));
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = (track.halfWidth + track.shoulder) * 2 * mapScale;
  ctx.stroke();
  ctx.strokeStyle = '#c9a070';
  ctx.lineWidth = track.halfWidth * 2 * mapScale;
  ctx.stroke();
  // start line
  ctx.fillStyle = '#fff';
  ctx.fillRect(mx(-track.halfWidth), mz(0) - 2, track.halfWidth * 2 * mapScale, 4);
  // where the player would be put back
  const pose = race.respawnPoseFor('player');
  ctx.strokeStyle = '#ffd76a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(mx(pose.ground.x), mz(pose.ground.z), 9, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = cars.length - 1; i >= 0; i--) {
    const p = cars[i].sample.position;
    const f = cars[i].sample.forward;
    ctx.fillStyle = i === 0 ? '#1fe4f2' : '#ff7a59';
    ctx.beginPath();
    ctx.arc(mx(p.x), mz(p.z), i === 0 ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mx(p.x), mz(p.z));
    ctx.lineTo(mx(p.x + f.x * 7), mz(p.z + f.z * 7));
    ctx.stroke();
  }
}

function drawReadout(s: HudSnapshot): void {
  const st = race.carState('player');
  readout.textContent =
    `seed ${seed}  track ${path.length.toFixed(0)} m  t ${simTime.toFixed(1)} s\n` +
    `phase ${s.phase}  lap ${s.lap}/${s.laps}  pos ${s.position}/${s.count}\n` +
    `s ${st.s.toFixed(1)}  dist ${st.dist.toFixed(1)}  valid ${st.validDist.toFixed(1)}\n` +
    `lateral ${st.lateral.toFixed(1)}  ${st.lost ? 'LOST' : st.onCourse ? 'on course' : 'off course'}` +
    `${s.wrongWay ? '  WRONG WAY' : ''}${s.needsReset ? `  RESET:${s.needsReset}` : ''}\n` +
    `HUD ${(dom.writes / Math.max(dom.frames, 1)).toFixed(2)} DOM writes/frame (max ${dom.max})`;
}

const links = document.getElementById('links') as HTMLElement;
const linkTo = (label: string, query: string): string => `<a href="?${query}">${label}</a>`;
links.innerHTML =
  [
    linkTo('live', ''),
    linkTo('live ×4', 'cars=4'),
    linkTo('countdown', 'state=countdown'),
    linkTo('racing', 'state=racing&speed=86&bar=0.74'),
    linkTo('racing ×4', 'state=racing&cars=4&speed=86&bar=0.74'),
    linkTo('wrong way', 'state=wrongway'),
    linkTo('best lap', 'state=bestlap'),
    linkTo('final lap', 'state=finallap'),
    linkTo('finished', 'state=finished'),
    linkTo('finished ×4', 'state=finished&cars=4'),
    linkTo('vs vision', 'state=racing&cars=4&pos=4&speed=86&bar=0.74&bg=vision&ghost=0.6'),
    linkTo('vision 1:1', 'state=racing&tl=position&chips=0&ticks=0.375,0.56&count=4&pos=4&speed=86&bar=0.74'),
    linkTo('12 cars', 'state=racing&cars=12&laps=12&pos=9&speed=186'),
    linkTo('10 min lap', 'state=racing&time=754.32&best=612.05'),
    linkTo('dev overlays', 'dev=1&cars=4'),
  ].join('') + '<span><kbd>W</kbd> wrong way <kbd>F</kbd> flip <kbd>C</kbd> cut <kbd>R</kbd> restart</span>';

// ───────── run ─────────


for (const car of cars) placeCar(car);

if (params.get('bench') === '1') {
  // A whole race, one HUD update per simulated frame, as the game would.
  // …and two seconds past the finish, so the summary card's repaint
  // behaviour is part of the count.
  let after = 0;
  for (let i = 0; i < 200 / STEP && after < 2; i++) {
    step();
    paint(snap());
    if (snap().finish) after += STEP;
  }
  drawMap();
  drawReadout(snap());
  readout.textContent +=
    `\nBENCH ${dom.frames} frames, ${dom.writes} DOM writes, ` +
    `${dom.idleFrames} frames with none, max ${dom.max} in one frame, ` +
    `${((dom.ms / Math.max(dom.frames, 1)) * 1000).toFixed(1)} µs per update()`;
} else if (pinned) {
  if (!pin(state)) fatal.textContent += `state "${state}" was not reached\n`;
  const frozen = withOverrides(snap());
  paint(frozen);
  drawMap();
  drawReadout(frozen);
} else {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === 'W') player.dir = -player.dir;
    else if (e.key === 'f' || e.key === 'F') player.flipT = 2.5;
    else if (e.key === 'c' || e.key === 'C') startCut();
    else if (e.key === 'r' || e.key === 'R') restart();
  });

  let last = performance.now();
  let acc = 0;
  let finishedFor = 0;
  const frame = (now: number): void => {
    // Fixed steps from real time: the race itself never sees a wall clock.
    acc += Math.min((now - last) / 1000, 0.1) * warp;
    last = now;
    while (acc >= STEP) {
      acc -= STEP;
      step();
      finishedFor = snap().finish ? finishedFor + STEP : 0;
      if (finishedFor > 6) {
        finishedFor = 0;
        restart();
      }
    }
    const s = snap();
    paint(s);
    drawMap();
    drawReadout(s);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
