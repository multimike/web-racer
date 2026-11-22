import { generateBaseTerrain, generateTerrain, sampleSplat } from '../terrain/generateTerrain';
import { Noise2D } from '../terrain/noise';
import {
  CATALOG,
  TrackFrame,
  applyPlanToTerrain,
  catalogEntry,
  copyHeightfield,
  formatChecks,
  recarveRoad,
  roadDims,
  runSelfChecks,
} from '../world';
import type { CheckResult, Lot, Placement, WorldPlan } from '../world';

/**
 * World lab: a top-down 2D map of a world plan (no WebGL), drawn to scale —
 * every symbol has the real footprint of its asset, so a 60 × 35 m window of
 * the map can be laid next to the elevated-camera vision image and compared
 * for density and arrangement. The side panel prints the planner's
 * self-checks; the same text goes to the console and, as JSON, into
 * #lab-report for headless runs.
 *
 * With the default road width the map is the GAME's world: the plan and the
 * final ground of generateTerrain(seed), and the self-checks run on
 * generateBaseTerrain(seed) — the planner's input exactly as the game hands
 * it over (no splat lookup).
 *
 * URL: ?seed=1 &road=half width (default: the track's own, 5)
 *      &focus=world|village|start|x,z,radius
 *      &rot=deg|auto (auto = direction of travel up) &layers=a,b | -a,-b
 *      &ui=0 (map only) &catalog=1 (cross-check the catalog against the
 *      live asset registry) &splat=1 (other widths only: plan with the
 *      game terrain's splat lookup)
 *      &carve=0 (plan a road wider than the track's own on the terrain as
 *      generated, instead of on a re-carved copy: shows the planner's
 *      carve warning and the failing check).
 */

const params = new URLSearchParams(location.search);
const seed = Number.parseInt(params.get('seed') ?? '', 10) || 1;
/** Road half width to plan for; default (0) = the track's own. */
const hwParam = Number.parseFloat(params.get('road') ?? '') || 0;
const focus = params.get('focus') ?? 'world';
const bare = params.get('ui') === '0';
if (bare) document.body.classList.add('bare');

const ALL_LAYERS = ['terrain', 'road', 'pads', 'lots', 'mods', 'dressing', 'nature', 'bends', 'labels'] as const;
type Layer = (typeof ALL_LAYERS)[number];
const layers = new Set<Layer>(ALL_LAYERS.filter((l) => l !== 'mods'));
{
  const spec = (params.get('layers') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (spec.length > 0 && spec.every((s) => !s.startsWith('-'))) layers.clear();
  for (const s of spec) {
    const name = (s.startsWith('-') ? s.slice(1) : s) as Layer;
    if (s.startsWith('-')) layers.delete(name);
    else layers.add(name);
  }
}

// Map colours: the vision's palette, flattened.
const C = {
  dirt: '#c98f55',
  cobble: '#b9a6c9',
  kerbRough: '#cdbf9f',
  kerbDressed: '#f3ead2',
  kerbFlush: '#9aa0ab',
  asphalt: '#59627a',
  paver: '#e6dcc0',
  ink: '#1f2a33',
  oak: '#9ccb3b',
  pine: '#2f7d55',
  palm: '#c4d94a',
  bush: '#5fae4a',
  grass: '#d7ee8a',
  fern: '#2fa08a',
  rosette: '#3b8f6e',
  bloom: '#ff7a66',
  rock: '#a996cf',
  rockTop: '#e9dcc8',
  stone: '#8d86a6',
  fence: '#8a5a2b',
  banner: '#19a5a0',
  lamp: '#ffd45c',
  chevron: '#ffc928',
  navy: '#22306b',
  flag: '#19a5a0',
  tire: '#23262b',
  bollard: '#ffb400',
  kerbMarker: '#ff6f5e',
  planter: '#e9668a',
  bench: '#b77b3c',
  barrel: '#a05f2c',
  crate: '#d9a55b',
  sign: '#ffffff',
  wall: '#7d74a3',
  gantry: '#e8483f',
};
const SCHEME_ROOF: Record<string, string> = { warm: '#e9584c', coastal: '#3d6fd6', sunny: '#f2b53a' };
const SCHEME_WALL: Record<string, string> = { warm: '#f3dcb6', coastal: '#f1ece0', sunny: '#f7e7a8' };

const fatal = (e: unknown): void => {
  document.getElementById('fatal')!.textContent = `WORLD LAB FAILED\n\n${e instanceof Error ? e.stack : String(e)}`;
  console.error(e);
};

try {
  main();
} catch (e) {
  fatal(e);
}

function main(): void {
  // The game's world: the planner's input (carved terrain BEFORE the plan)
  // and the finished WorldData, made exactly as the game makes them.
  const baseTerrain = generateBaseTerrain(seed);
  const track = baseTerrain.track;
  const hw = hwParam > 0 ? hwParam : track.halfWidth;
  const ownWidth = Math.abs(hw - track.halfWidth) <= 0.01;
  const terrain = ownWidth || params.get('splat') === '1' ? generateTerrain(seed) : null;
  // Any other ?road= is planned on a re-carved copy of the base terrain (the
  // planner needs terrain CARVED to the width it plans for); &carve=0 keeps
  // the generator's carve to show the planner's warning.
  const recarved = !ownWidth && params.get('carve') !== '0';
  const base = copyHeightfield(baseTerrain.heightfield);
  if (recarved) recarveRoad(base, track, hw);
  const input = ownWidth
    ? { track, heightfield: base, seed }
    : {
        track,
        heightfield: base,
        seed,
        roadHalfWidth: hw,
        splat: terrain ? (x: number, z: number, out: Float32Array): void => sampleSplat(terrain, x, z, out) : undefined,
      };
  const run = runSelfChecks(input);
  let plan = run.plan;
  let ground = copyHeightfield(base);
  const frame = new TrackFrame(track, plan.worldSize);
  if (ownWidth && terrain) {
    // Draw the game's own plan on the game's final ground, and prove the
    // self-checks above ran on that very plan.
    const same = JSON.stringify(terrain.plan) === JSON.stringify(run.plan);
    run.checks.unshift({ name: 'lab plan = generateTerrain plan', pass: same, value: same ? 'identical' : 'DIFFERENT' });
    plan = terrain.plan;
    ground = terrain.heightfield;
  } else {
    applyPlanToTerrain(ground, plan, track, frame);
  }
  const dims = roadDims(hw);

  console.log(`[world-lab] seed ${seed}, road half width ${hw}${recarved ? ' (terrain re-carved from ' + track.halfWidth + ')' : ''}\n${formatChecks(run.checks)}${plan.warnings.map((w) => '\nWARNING ' + w).join('')}`);
  (window as unknown as { __world: unknown }).__world = { plan, checks: run.checks, frame, terrain, base: baseTerrain, rerun: () => runSelfChecks(input) };
  document.getElementById('lab-report')!.textContent = JSON.stringify({ seed, hw, recarved, ms: run.ms, stats: plan.stats, warnings: plan.warnings, checks: run.checks });

  // ----------------------------------------------------------------- view
  const canvas = document.getElementById('map') as HTMLCanvasElement;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);

  let cx = 0;
  let cz = 0;
  let radius = plan.worldSize / 2;
  let rot = 0;
  if (focus === 'village') {
    [cx, cz] = plan.village.center;
    radius = plan.village.radius + 6;
  } else if (focus === 'start') {
    radius = 30;
  } else if (focus !== 'world') {
    const [a, b, c] = focus.split(',').map(Number);
    if ([a, b, c].every(Number.isFinite)) {
      cx = a;
      cz = b;
      radius = c;
    }
  }
  const rotParam = params.get('rot');
  if (rotParam === 'auto') {
    const hit = frame.nearest(cx, cz);
    const p = frame.at(hit.s);
    rot = Math.atan2(p.tx, p.tz);
  } else if (rotParam) {
    rot = (Number.parseFloat(rotParam) * Math.PI) / 180;
  }
  /** Pixels per meter; `radius` meters fit in the shorter half of the canvas. */
  const k = Math.min(W, H) / (2 * radius);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  /** World → screen. Unrotated: +x right, +z UP the screen. `rot` turns the
   * world so that the direction (sin rot, cos rot) points up. */
  const sx = (x: number, z: number): number => W / 2 + ((x - cx) * cr - (z - cz) * sr) * k;
  const sy = (x: number, z: number): number => H / 2 - ((x - cx) * sr + (z - cz) * cr) * k;
  const visible = (x: number, z: number, r: number): boolean => {
    const px = sx(x, z);
    const py = sy(x, z);
    return px > -r * k && px < W + r * k && py > -r * k && py < H + r * k;
  };
  /** Draw in an asset's local frame: +x right, local +z up, 1 unit = 1 m. */
  const local = (x: number, z: number, yaw: number, draw: () => void): void => {
    g.save();
    g.translate(sx(x, z), sy(x, z));
    // Screen y is down and world yaw is clockwise seen from above, as is a
    // positive canvas rotation — so the angles add directly.
    g.rotate(yaw - rot);
    g.scale(k, -k);
    draw();
    g.restore();
  };
  const poly = (pts: readonly (readonly [number, number])[]): void => {
    g.beginPath();
    pts.forEach(([x, z], i) => (i === 0 ? g.moveTo(sx(x, z), sy(x, z)) : g.lineTo(sx(x, z), sy(x, z))));
    g.closePath();
  };

  // -------------------------------------------------------------- terrain
  if (layers.has('terrain')) {
    const STEP = radius > 60 ? 3 : 2;
    const w = Math.ceil(W / STEP);
    const h = Math.ceil(H / STEP);
    const img = new ImageData(w, h);
    const macro = new Noise2D(seed + 101);
    const half = plan.worldSize / 2;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dx = (px * STEP - W / 2) / k;
        const dz = -(py * STEP - H / 2) / k;
        const x = cx + dx * cr + dz * sr;
        const z = cz - dx * sr + dz * cr;
        const i = (py * w + px) * 4;
        if (Math.abs(x) > half || Math.abs(z) > half) {
          img.data[i] = 233;
          img.data[i + 1] = 230;
          img.data[i + 2] = 220;
          img.data[i + 3] = 255;
          continue;
        }
        const e = 1.2;
        const hh = ground.getHeight(x, z);
        const ddx = (ground.getHeight(x + e, z) - ground.getHeight(x - e, z)) / (2 * e);
        const ddz = (ground.getHeight(x, z + e) - ground.getHeight(x, z - e)) / (2 * e);
        // Sun from the upper left of the unrotated map, like the game's.
        const shade = Math.max(0.55, Math.min(1.25, 1 + 0.9 * (0.5 * ddx + 0.48 * ddz)));
        const meadow = Math.max(0, Math.min(1, (macro.fbm(x / 40 + 31, z / 40 - 17, 3) - 0.15) / 0.3));
        const t = Math.max(0, Math.min(1, (hh + 3) / 14));
        const slope = Math.hypot(ddx, ddz);
        const rock = Math.max(0, Math.min(1, (slope - 0.55) / 0.4));
        let r = 122 + 40 * meadow + 30 * t;
        let gg = 176 + 22 * meadow + 14 * t;
        let b = 88 - 10 * meadow + 30 * t;
        r += (168 - r) * rock;
        gg += (156 - gg) * rock;
        b += (190 - b) * rock;
        img.data[i] = r * shade;
        img.data[i + 1] = gg * shade;
        img.data[i + 2] = b * shade;
        img.data[i + 3] = 255;
      }
    }
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    off.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(off, 0, 0, w * STEP, h * STEP);
    // World edge.
    g.strokeStyle = 'rgba(31,42,51,0.5)';
    g.lineWidth = 1;
    poly([[-half, -half], [half, -half], [half, half], [-half, half]]);
    g.stroke();
  } else {
    g.fillStyle = '#a8c98a';
    g.fillRect(0, 0, W, H);
  }

  // ----------------------------------------------------- terrain modifiers
  if (layers.has('mods')) {
    g.lineWidth = 1;
    for (const m of plan.terrainModifiers) {
      if (m.kind === 'flatten') {
        local(m.x, m.z, m.yaw, () => {
          g.lineWidth = 1 / k;
          g.strokeStyle = 'rgba(255,255,255,0.9)';
          g.strokeRect(-m.halfX, -m.halfZ, m.halfX * 2, m.halfZ * 2);
          g.setLineDash([0.5, 0.5]);
          g.strokeStyle = 'rgba(255,255,255,0.7)';
          g.strokeRect(-m.halfX - m.falloff.left, -m.halfZ - m.falloff.front, m.halfX * 2 + m.falloff.left + m.falloff.right, m.halfZ * 2 + m.falloff.front + m.falloff.back);
          g.setLineDash([]);
        });
      } else {
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.setLineDash([4, 3]);
        for (const side of m.side === 0 ? [1, -1] : [m.side]) {
          g.beginPath();
          const span = frame.wrap(m.s1 - m.s0);
          for (let u = 0; u <= span; u += 1) {
            const [x, z] = frame.offset(m.s0 + u, side * m.outer);
            if (u === 0) g.moveTo(sx(x, z), sy(x, z));
            else g.lineTo(sx(x, z), sy(x, z));
          }
          g.stroke();
        }
        g.setLineDash([]);
      }
    }
  }

  // ----------------------------------------------------------------- pads
  if (layers.has('pads')) {
    for (const pad of plan.pads) {
      poly(pad.polygon);
      g.fillStyle = pad.surface === 'asphalt' ? C.asphalt : pad.surface === 'cobble' ? C.cobble : C.paver;
      g.fill();
      g.strokeStyle = 'rgba(31,42,51,0.35)';
      g.lineWidth = 0.8;
      g.stroke();
      for (const m of pad.markings) {
        g.strokeStyle = m.color === 'yellow' ? '#ffd23c' : '#fff';
        g.lineWidth = Math.max(1, m.width * k);
        g.beginPath();
        g.moveTo(sx(m.a[0], m.a[1]), sy(m.a[0], m.a[1]));
        g.lineTo(sx(m.b[0], m.b[1]), sy(m.b[0], m.b[1]));
        g.stroke();
      }
    }
  }

  // ----------------------------------------------------------------- road
  if (layers.has('road')) {
    const mix = (a: string, b: string, t: number): string => {
      const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
      const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
      return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
    };
    for (let i = 0; i < frame.n; i++) {
      const j = (i + 1) % frame.n;
      const a0 = frame.offset(frame.s[i], hw);
      const a1 = frame.offset(frame.s[i], -hw);
      const b0 = frame.offset(frame.s[i] + (frame.s[i + 1] - frame.s[i]), hw);
      const b1 = frame.offset(frame.s[i] + (frame.s[i + 1] - frame.s[i]), -hw);
      poly([a0, b0, b1, a1]);
      const col = mix(C.dirt, C.cobble, (plan.road.cobble[i] + plan.road.cobble[j]) / 2);
      g.fillStyle = col;
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.fill();
      g.stroke();
    }
    for (const kerb of plan.road.kerbs) {
      const span = frame.wrap(kerb.s1 - kerb.s0);
      g.strokeStyle = kerb.style === 'dressed' ? C.kerbDressed : kerb.style === 'flush' ? C.kerbFlush : C.kerbRough;
      g.lineWidth = Math.max(1, kerb.width * k);
      g.setLineDash(kerb.style === 'flush' ? [0.8 * k, 0.5 * k] : kerb.style === 'dressed' ? [1.1 * k, 0.12 * k] : [0.7 * k, 0.18 * k]);
      g.beginPath();
      for (let u = 0; u <= span; u += 0.5) {
        const [x, z] = frame.offset(kerb.s0 + u, kerb.side * (hw + kerb.width / 2));
        // Inside a hairpin the offset line folds back: do not draw the fold.
        if (frame.fastDist(x, z) < hw + kerb.width / 2 - 0.25) {
          g.stroke();
          g.beginPath();
          continue;
        }
        g.lineTo(sx(x, z), sy(x, z));
      }
      g.stroke();
      g.setLineDash([]);
    }
    // Start line: two rows of checkers across the road.
    const sl = plan.road.startLine;
    local(sl.x, sl.z, sl.yaw, () => {
      const n = Math.round((sl.halfWidth * 2) / 0.5);
      const cw = (sl.halfWidth * 2) / n;
      for (let i = 0; i < n; i++) {
        for (let r = 0; r < 2; r++) {
          g.fillStyle = (i + r) % 2 === 0 ? '#fff' : '#1b1b1f';
          g.fillRect(-sl.halfWidth + i * cw, -sl.depth / 2 + (r * sl.depth) / 2, cw, sl.depth / 2);
        }
      }
    });
    // Direction of travel.
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let s = 12; s < frame.length - 6; s += 24) {
      const p = frame.at(s);
      local(p.x, p.z, Math.atan2(p.tx, p.tz), () => {
        g.beginPath();
        g.moveTo(0, 1.3);
        g.lineTo(0.8, -0.6);
        g.lineTo(0, -0.1);
        g.lineTo(-0.8, -0.6);
        g.closePath();
        g.fill();
      });
    }
  }

  // ---------------------------------------------------------------- bends
  if (layers.has('bends')) {
    g.lineWidth = 2;
    g.strokeStyle = '#d6249f';
    for (const b of plan.bends) {
      const outside = b.direction === 'left' ? -1 : 1;
      const span = frame.wrap(b.s1 - b.s0);
      g.beginPath();
      for (let u = 0; u <= span; u += 0.5) {
        const [x, z] = frame.offset(b.s0 + u, outside * (hw + 0.2));
        if (u === 0) g.moveTo(sx(x, z), sy(x, z));
        else g.lineTo(sx(x, z), sy(x, z));
      }
      g.stroke();
    }
  }

  // --------------------------------------------------------------- nature
  const drawNature = (p: Placement): void => {
    const e = catalogEntry(p.asset);
    const r = Math.max(e.size[0], e.size[2]) / 2 * p.scale;
    if (!visible(p.x, p.z, r + 1)) return;
    const px = sx(p.x, p.z);
    const py = sy(p.x, p.z);
    const R = r * k;
    const shade = (hex: string): string => {
      const v = [1, 3, 5].map((i) => Math.min(255, Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * p.tint[(i - 1) / 2])));
      return `rgb(${v.join(',')})`;
    };
    switch (p.asset) {
      case 't01-rally-oak': {
        g.fillStyle = shade(C.oak);
        g.globalAlpha = 0.88;
        // Three lobes: reads as a broadleaf crown, not a dot.
        for (let i = 0; i < 3; i++) {
          const a = p.yaw + (i * Math.PI * 2) / 3;
          g.beginPath();
          g.arc(px + Math.cos(a) * R * 0.34, py + Math.sin(a) * R * 0.34, R * 0.68, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        g.strokeStyle = 'rgba(40,80,20,0.55)';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(px, py, R, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = '#7a4a22';
        g.beginPath();
        g.arc(px, py, Math.max(1.2, 0.45 * p.scale * k), 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 't02-switchback-pine': {
        g.fillStyle = shade(C.pine);
        g.globalAlpha = 0.9;
        g.beginPath();
        for (let i = 0; i < 12; i++) {
          const a = p.yaw + (i * Math.PI) / 6;
          const rr = i % 2 === 0 ? R : R * 0.62;
          g.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr);
        }
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
        g.fillStyle = '#cfe7c2';
        g.beginPath();
        g.arc(px, py, Math.max(0.8, R * 0.14), 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 't03-turbo-palm': {
        g.strokeStyle = shade(C.palm);
        g.lineWidth = Math.max(1.2, R * 0.3);
        g.lineCap = 'round';
        g.globalAlpha = 0.92;
        for (let i = 0; i < 7; i++) {
          const a = p.yaw + (i * Math.PI * 2) / 7;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * R, py + Math.sin(a) * R);
          g.stroke();
        }
        g.globalAlpha = 1;
        g.lineCap = 'butt';
        g.fillStyle = '#8a5a2b';
        g.beginPath();
        g.arc(px, py, Math.max(1.2, 0.3 * p.scale * k), 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 'v01-puff-bush':
        g.fillStyle = shade(C.bush);
        g.strokeStyle = 'rgba(30,70,25,0.6)';
        g.lineWidth = 0.8;
        g.beginPath();
        g.arc(px, py, Math.max(1.2, R), 0, Math.PI * 2);
        g.fill();
        g.stroke();
        break;
      case 'v02-ribbon-grass':
        g.strokeStyle = shade(C.grass);
        g.lineWidth = Math.max(1, R * 0.35);
        g.beginPath();
        g.moveTo(px - R, py + R * 0.6);
        g.lineTo(px, py - R);
        g.lineTo(px + R, py + R * 0.6);
        g.stroke();
        break;
      case 'v03-fan-fern':
        g.fillStyle = shade(C.fern);
        g.beginPath();
        g.moveTo(px, py + R);
        g.arc(px, py + R, R * 1.7, -Math.PI * 0.82, -Math.PI * 0.18);
        g.closePath();
        g.fill();
        break;
      case 'v04-spike-rosette':
        g.fillStyle = shade(C.rosette);
        g.beginPath();
        g.moveTo(px, py - R);
        g.lineTo(px + R, py);
        g.lineTo(px, py + R);
        g.lineTo(px - R, py);
        g.closePath();
        g.fill();
        break;
      case 'v05-coral-blooms':
        g.fillStyle = shade(C.bloom);
        g.beginPath();
        g.arc(px, py, Math.max(1.1, R), 0, Math.PI * 2);
        g.fill();
        if (R > 3) {
          g.fillStyle = '#ffe36b';
          g.beginPath();
          g.arc(px, py, R * 0.35, 0, Math.PI * 2);
          g.fill();
        }
        break;
      default: {
        // Rocks: an irregular hexagon; large ones get their cream top plane.
        const large = e.category === 'large-rock';
        const w = (e.size[0] / 2) * p.scale * k;
        const d = (e.size[2] / 2) * p.scale * k;
        g.save();
        g.translate(px, py);
        g.rotate(p.yaw - rot);
        g.fillStyle = shade(large ? C.rock : C.stone);
        g.strokeStyle = 'rgba(60,45,95,0.8)';
        g.lineWidth = large ? 1 : 0.5;
        g.beginPath();
        const ws = [1, 0.62, -0.5, -1, -0.7, 0.45];
        const ds = [0.1, 0.9, 1, 0.15, -0.85, -1];
        ws.forEach((wx, i) => (i === 0 ? g.moveTo(wx * w, ds[i] * d) : g.lineTo(wx * w, ds[i] * d)));
        g.closePath();
        g.fill();
        if (large || w > 2.5) g.stroke();
        if (large) {
          g.fillStyle = C.rockTop;
          g.beginPath();
          ws.forEach((wx, i) => (i === 0 ? g.moveTo(wx * w * 0.5 - w * 0.12, ds[i] * d * 0.5 - d * 0.12) : g.lineTo(wx * w * 0.5 - w * 0.12, ds[i] * d * 0.5 - d * 0.12)));
          g.closePath();
          g.fill();
        }
        g.restore();
      }
    }
  };
  if (layers.has('nature')) {
    // Low things first, crowns last, so the map reads like the scene from above.
    const rank = (p: Placement): number => {
      const c = catalogEntry(p.asset).category;
      return c === 'tree' ? 4 : c === 'large-rock' ? 3 : p.asset === 'v01-puff-bush' ? 2 : c === 'small-rock' ? 1 : 0;
    };
    const sorted = plan.nature.slice().sort((a, b) => rank(a) - rank(b));
    for (const p of sorted) if (rank(p) < 4) drawNature(p);
    if (layers.has('dressing')) drawDressing();
    if (layers.has('lots')) drawLots();
    for (const p of sorted) if (rank(p) === 4) drawNature(p);
  } else {
    if (layers.has('dressing')) drawDressing();
    if (layers.has('lots')) drawLots();
  }

  // ------------------------------------------------------------- dressing
  function drawSymbol(asset: string, scheme: string | undefined): void {
    // Local frame, meters, +z up; front is −z (down).
    const e = catalogEntry(asset);
    const w = e.size[0];
    const d = e.size[2];
    g.lineWidth = 1 / k;
    switch (asset) {
      case 'd01-start-gantry':
        g.fillStyle = C.gantry;
        g.fillRect(-w / 2, -0.35, w, 0.7);
        g.fillStyle = '#f3ead2';
        for (const x of [-6.45, 6.45]) g.fillRect(x - 0.8, -0.8, 1.6, 1.6);
        g.strokeStyle = C.ink;
        g.strokeRect(-w / 2, -0.35, w, 0.7);
        break;
      case 'd02-chevron-sign': {
        g.fillStyle = C.navy;
        g.fillRect(-w / 2, -0.12, w, 0.42);
        // Arrows as read from the front: the reader stands at −z looking
        // toward +z, so their left is local −x.
        const dir = scheme === 'left' ? -1 : 1;
        g.fillStyle = C.chevron;
        const pitch = w * 0.3;
        for (let i = -1; i <= 1; i++) {
          g.beginPath();
          g.moveTo(i * pitch + dir * pitch * 0.4, 0.09);
          g.lineTo(i * pitch - dir * pitch * 0.33, -0.5);
          g.lineTo(i * pitch - dir * pitch * 0.33, 0.68);
          g.closePath();
          g.fill();
        }
        // Tick on the printed face.
        g.strokeStyle = C.chevron;
        g.lineWidth = 2 / k;
        g.beginPath();
        g.moveTo(-w / 2, -0.14);
        g.lineTo(w / 2, -0.14);
        g.stroke();
        break;
      }
      case 'd03-flag-pole':
        g.fillStyle = C.flag;
        g.fillRect(0, -0.12, 1.9, 0.3);
        g.fillStyle = '#fff';
        g.fillRect(0.5, -0.12, 0.45, 0.3);
        g.fillRect(1.4, -0.12, 0.45, 0.3);
        g.fillStyle = C.ink;
        g.beginPath();
        g.arc(0, 0, 0.24, 0, Math.PI * 2);
        g.fill();
        break;
      case 'd04-tire-stack':
        g.fillStyle = C.tire;
        g.beginPath();
        g.arc(0, 0, 0.43, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#8c9199';
        g.beginPath();
        g.arc(0, 0, 0.17, 0, Math.PI * 2);
        g.fill();
        break;
      case 'd05-bollard':
        g.fillStyle = C.bollard;
        g.strokeStyle = C.ink;
        g.beginPath();
        g.arc(0, 0, 0.22, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        break;
      case 'd06-kerb-marker':
        g.fillStyle = scheme === 'teal' ? C.banner : C.kerbMarker;
        g.fillRect(-w / 2, -d / 2, w, d);
        g.fillStyle = '#fff';
        g.fillRect(-w / 6, -d / 2, w / 3, d);
        break;
      case 'd07-wood-fence':
        g.fillStyle = C.fence;
        // Drawn fatter than life (rails are 6 cm): the fence line must read on the map.
        g.fillRect(-w / 2, -0.11, w, 0.22);
        for (const x of [-0.6, 0.6]) g.fillRect(x - 0.17, -0.17, 0.34, 0.34);
        if (scheme === 'banner') {
          g.fillStyle = C.banner;
          g.fillRect(-0.5, -0.3, 1.0, 0.2);
          g.fillStyle = '#fff';
          g.fillRect(-0.25, -0.3, 0.25, 0.2);
          g.fillRect(0.25, -0.3, 0.25, 0.2);
        }
        break;
      case 'd08-street-lamp':
        g.fillStyle = 'rgba(255,212,92,0.3)';
        g.beginPath();
        g.arc(0, -0.75, 1.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = C.ink;
        g.lineWidth = 0.1;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -0.75);
        g.stroke();
        g.fillStyle = C.lamp;
        g.beginPath();
        g.arc(0, -0.75, 0.24, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = C.ink;
        g.beginPath();
        g.arc(0, 0, 0.15, 0, Math.PI * 2);
        g.fill();
        break;
      case 'd09-barrel':
        g.fillStyle = C.barrel;
        g.strokeStyle = '#4f2d12';
        g.beginPath();
        g.arc(0, 0, 0.35, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        break;
      case 'd10-crate':
        g.fillStyle = C.crate;
        g.strokeStyle = '#7a5320';
        g.fillRect(-0.45, -0.45, 0.9, 0.9);
        g.strokeRect(-0.45, -0.45, 0.9, 0.9);
        g.beginPath();
        g.moveTo(-0.45, -0.45);
        g.lineTo(0.45, 0.45);
        g.stroke();
        break;
      case 'd11-flower-planter':
        g.fillStyle = '#b9a6c9';
        g.fillRect(-w / 2, -d / 2, w, d);
        g.fillStyle = C.planter;
        for (const x of [-0.3, 0, 0.3]) {
          g.beginPath();
          g.arc(x, 0, 0.17, 0, Math.PI * 2);
          g.fill();
        }
        break;
      case 'd12-stone-wall':
        g.fillStyle = C.wall;
        g.strokeStyle = '#4a4370';
        g.fillRect(-w / 2, -d / 2, w, d);
        g.strokeRect(-w / 2, -d / 2, w, d);
        break;
      case 'd13-bench':
        g.fillStyle = C.bench;
        g.fillRect(-w / 2, -d / 2, w, d);
        g.fillStyle = '#6b431b';
        g.fillRect(-w / 2, d / 2 - 0.14, w, 0.14);
        break;
      case 'd14-signpost':
        g.fillStyle = C.sign;
        g.strokeStyle = C.ink;
        g.fillRect(-0.45, -0.1, 0.9, 0.2);
        g.strokeRect(-0.45, -0.1, 0.9, 0.2);
        g.fillStyle = C.ink;
        g.beginPath();
        g.arc(0, 0, 0.12, 0, Math.PI * 2);
        g.fill();
        break;
      case 'd20-tool-chest':
        g.fillStyle = '#e8483f';
        g.strokeStyle = C.ink;
        g.fillRect(-w / 2, -d / 2, w, d);
        g.strokeRect(-w / 2, -d / 2, w, d);
        g.fillStyle = C.ink;
        g.fillRect(-w / 2 + 0.1, -d / 2, w - 0.2, 0.1);
        break;
      case 'd21-checker-banner':
        g.fillStyle = C.banner;
        g.fillRect(-0.85, -0.12, 1.7, 0.16);
        g.fillStyle = '#ffffff';
        for (let i = 0; i < 4; i++) g.fillRect(-0.75 + i * 0.4, -0.12, 0.2, 0.16);
        g.fillStyle = C.fence;
        for (const x of [-0.93, 0.93]) g.fillRect(x - 0.09, -0.09, 0.18, 0.18);
        break;
      case 'd30-produce-stand':
        g.fillStyle = C.crate;
        g.strokeStyle = '#7a5320';
        g.fillRect(-w / 2, -d / 2, w, d);
        g.strokeRect(-w / 2, -d / 2, w, d);
        for (const [x, c] of [[-0.42, '#e8483f'], [0.42, '#ff9d2e']] as [number, string][]) {
          g.fillStyle = c;
          g.beginPath();
          g.arc(x, -0.05, 0.24, 0, Math.PI * 2);
          g.fill();
        }
        break;
    }
  }
  function drawDressing(): void {
    for (const p of plan.dressing) {
      if (!visible(p.x, p.z, 8)) continue;
      local(p.x, p.z, p.yaw, () => drawSymbol(p.asset, p.scheme));
    }
  }

  // ----------------------------------------------------------------- lots
  function drawLots(): void {
    for (const l of plan.lots) {
      local(l.x, l.z, l.yaw, () => {
        g.lineWidth = 1 / k;
        // Envelope (dashed) and main body (filled, roof in scheme colour).
        g.setLineDash([0.4, 0.3]);
        g.strokeStyle = 'rgba(31,42,51,0.8)';
        g.strokeRect(-l.halfX, -l.halfZ, l.halfX * 2, l.halfZ * 2);
        g.setLineDash([]);
        g.fillStyle = SCHEME_WALL[l.scheme] ?? '#eee';
        g.fillRect(-l.bodyHalfX, -l.bodyHalfZ, l.bodyHalfX * 2, l.bodyHalfZ * 2);
        g.fillStyle = SCHEME_ROOF[l.scheme] ?? '#999';
        g.fillRect(-l.bodyHalfX + 0.35, -l.bodyHalfZ + 0.35, l.bodyHalfX * 2 - 0.7, l.bodyHalfZ * 2 - 0.7);
        g.strokeStyle = C.ink;
        g.lineWidth = 1.5 / k;
        g.strokeRect(-l.bodyHalfX, -l.bodyHalfZ, l.bodyHalfX * 2, l.bodyHalfZ * 2);
        // Front arrow: from the body's front wall toward the road (−z).
        g.fillStyle = C.ink;
        g.beginPath();
        g.moveTo(0, -l.bodyHalfZ - 1.5);
        g.lineTo(0.7, -l.bodyHalfZ - 0.2);
        g.lineTo(-0.7, -l.bodyHalfZ - 0.2);
        g.closePath();
        g.fill();
      });
    }
  }

  // --------------------------------------------------------------- labels
  if (layers.has('labels')) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tag = (x: number, z: number, text: string, bold = true): void => {
      g.font = `${bold ? '700 ' : ''}${Math.max(9, Math.min(13, k * 1.1))}px ui-monospace, Menlo, monospace`;
      const px = sx(x, z);
      const py = sy(x, z);
      const tw = g.measureText(text).width + 6;
      g.fillStyle = 'rgba(255,255,255,0.82)';
      g.fillRect(px - tw / 2, py - 7, tw, 14);
      g.fillStyle = C.ink;
      g.fillText(text, px, py + 0.5);
    };
    if (layers.has('lots')) {
      for (const l of plan.lots) tag(l.x, l.z, `${l.asset.slice(0, 3).toUpperCase()} ${l.asset.slice(4).replace(/-/g, ' ')}${radius < 60 ? ` #${l.id}` : ''}`);
    }
    if (layers.has('bends') && radius >= 40) {
      for (const b of plan.bends) {
        const outside = b.direction === 'left' ? -1 : 1;
        const [x, z] = frame.offset(b.apexS, outside * (hw + 6));
        tag(x, z, `${b.direction === 'left' ? '↰' : '↱'} R${b.minRadius.toFixed(0)}`, false);
      }
    }
    const st = frame.offset(0, -(hw + 3));
    if (radius >= 25) tag(st[0], st[1], 'START', true);
  }

  // Scale bar + north arrow.
  {
    const meters = radius > 60 ? 20 : radius > 25 ? 10 : 5;
    const x0 = 16;
    const y0 = H - 18;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(x0 - 6, y0 - 18, meters * k + 12, 30);
    g.fillStyle = C.ink;
    g.fillRect(x0, y0, meters * k, 3);
    g.fillRect(x0, y0 - 4, 1.5, 8);
    g.fillRect(x0 + meters * k - 1.5, y0 - 4, 1.5, 8);
    g.font = '700 11px ui-monospace, Menlo, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(`${meters} m`, x0, y0 - 6);
    // +z arrow.
    g.save();
    g.translate(W - 28, H - 30);
    g.rotate(-rot);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.arc(0, 0, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.ink;
    g.beginPath();
    g.moveTo(0, -13);
    g.lineTo(6, 6);
    g.lineTo(0, 2);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.font = '700 9px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText('+z', 0, 15);
    g.restore();
  }

  // ---------------------------------------------------------------- panel
  document.getElementById('title')!.textContent =
    `seed ${seed} · road half width ${hw} m · loop ${plan.road.length.toFixed(0)} m · village ${plan.village.length.toFixed(0)} m · planned in ${run.ms.toFixed(1)} ms`;
  renderChecks(run.checks);
  renderSummary(plan, dims.fence);
  renderLegend();
  renderCounts(plan);
  if (params.get('catalog') === '1') void crossCheckCatalog();

}

function renderChecks(checks: readonly CheckResult[]): void {
  const table = document.getElementById('checks') as HTMLTableElement;
  for (const c of checks) {
    const tr = table.insertRow();
    // Advisory rows are composition goals the planner may fall short of on
    // purpose: shown as a note, not as a failure.
    tr.className = c.pass ? 'ok' : c.advisory ? 'note' : 'bad';
    const s = tr.insertCell();
    s.className = 's';
    s.textContent = c.pass ? '✓' : c.advisory ? '!' : '✗';
    tr.insertCell().textContent = c.name;
    const v = tr.insertCell();
    v.className = 'v';
    v.textContent = c.value;
    if (c.detail) {
      const d = table.insertRow();
      d.className = c.advisory ? 'detail note' : 'detail';
      const cell = d.insertCell();
      cell.colSpan = 3;
      cell.textContent = c.detail;
    }
  }
}

function renderSummary(plan: WorldPlan, fence: number): void {
  const table = document.getElementById('summary') as HTMLTableElement;
  const row = (k: string, v: string): void => {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    const c = tr.insertCell();
    c.className = 'v';
    c.textContent = v;
  };
  const lot = (id: number): Lot | undefined => plan.lots[id];
  const s = plan.stats;
  row('village stretch s', `${plan.village.s0.toFixed(0)} → ${plan.village.s1.toFixed(0)} m (score ${plan.village.score.toFixed(2)})`);
  row('start line', plan.road.startLine.marker === 'gantry' ? 'gantry + flags' : 'flags only');
  row('buildings village + outlying', `${s.villageBuildings} + ${s.outlyingBuildings}`);
  row('garage / hall / market / tower', [plan.village.garageLot, plan.village.hallLot, plan.village.marketLot, plan.village.towerLot].map((id) => `#${id}${lot(id) ? (lot(id)!.side === 1 ? 'L' : 'R') : ''}`).join(' '));
  row('bends signed', `${plan.bends.length} (R ${plan.bends.map((b) => b.minRadius.toFixed(0)).join(' ')})`);
  row('fence line from centreline', `${fence.toFixed(2)} m`);
  row('terrain modifiers / pads', `${plan.terrainModifiers.length} / ${plan.pads.length}`);
  row('max cut / fill', `${Math.max(...plan.lots.map((l) => l.cut)).toFixed(2)} / ${Math.max(...plan.lots.map((l) => l.fill)).toFixed(2)} m`);
  row('dressing', String(s.dressing));
  row('trees / bushes / low plants', `${s.trees} / ${s.bushes} / ${s.lowPlants}`);
  row('large / small rocks', `${s.largeRocks} / ${s.smallRocks}`);
  row('backdrop trees + rocks (> 30 m off road)', String(s.backdrop));
  row('prop batches (asset × seed × scheme)', String(s.batches));
  for (const w of plan.warnings) {
    const tr = table.insertRow();
    tr.className = 'detail';
    const c = tr.insertCell();
    c.colSpan = 2;
    c.textContent = `WARNING: ${w}`;
  }
}

function renderLegend(): void {
  const el = document.getElementById('legend')!;
  const swatch = (label: string, paint: (g: CanvasRenderingContext2D) => void): void => {
    const div = document.createElement('div');
    const c = document.createElement('canvas');
    c.width = 44;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.scale(2, 2);
    paint(g);
    div.append(c, label);
    el.append(div);
  };
  const dot = (color: string, r = 5, stroke?: string) => (g: CanvasRenderingContext2D): void => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(11, 8, r, 0, Math.PI * 2);
    g.fill();
    if (stroke) {
      g.strokeStyle = stroke;
      g.stroke();
    }
  };
  const bar = (color: string, h = 6, dash?: number[]) => (g: CanvasRenderingContext2D): void => {
    g.strokeStyle = color;
    g.lineWidth = h;
    if (dash) g.setLineDash(dash);
    g.beginPath();
    g.moveTo(1, 8);
    g.lineTo(21, 8);
    g.stroke();
  };
  const box = (fill: string, stroke = C.ink) => (g: CanvasRenderingContext2D): void => {
    g.fillStyle = fill;
    g.fillRect(4, 3, 14, 10);
    g.strokeStyle = stroke;
    g.strokeRect(4, 3, 14, 10);
  };
  swatch('road: dirt', bar(C.dirt, 10));
  swatch('road: cobble', bar(C.cobble, 10));
  swatch('kerb rough', bar(C.kerbRough, 4, [4, 1]));
  swatch('kerb dressed', bar(C.kerbDressed, 5, [6, 1]));
  swatch('kerb flush (pad)', bar(C.kerbFlush, 4, [4, 3]));
  swatch('pad: asphalt apron', box(C.asphalt));
  swatch('pad: cobble square', box(C.cobble));
  swatch('pad: paver path', box(C.paver));
  swatch('building warm', box(SCHEME_ROOF.warm));
  swatch('building coastal', box(SCHEME_ROOF.coastal));
  swatch('building sunny', box(SCHEME_ROOF.sunny));
  swatch('envelope · ▲ front', (g) => {
    g.setLineDash([2, 2]);
    g.strokeStyle = C.ink;
    g.strokeRect(3, 2, 16, 12);
  });
  swatch('t01 oak', dot(C.oak, 7, 'rgba(40,80,20,0.6)'));
  swatch('t02 pine', (g) => {
    g.fillStyle = C.pine;
    g.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      const r = i % 2 === 0 ? 7 : 4.3;
      g.lineTo(11 + Math.cos(a) * r, 8 + Math.sin(a) * r);
    }
    g.fill();
  });
  swatch('t03 palm', (g) => {
    g.strokeStyle = C.palm;
    g.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = (i * Math.PI * 2) / 7;
      g.beginPath();
      g.moveTo(11, 8);
      g.lineTo(11 + Math.cos(a) * 7, 8 + Math.sin(a) * 7);
      g.stroke();
    }
  });
  swatch('v01 bush', dot(C.bush, 4, 'rgba(30,70,25,0.6)'));
  swatch('v02 ribbon grass', (g) => {
    g.strokeStyle = C.grass;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(7, 11);
    g.lineTo(11, 4);
    g.lineTo(15, 11);
    g.stroke();
  });
  swatch('v03 fern', (g) => {
    g.fillStyle = C.fern;
    g.beginPath();
    g.moveTo(11, 13);
    g.arc(11, 13, 8, -Math.PI * 0.82, -Math.PI * 0.18);
    g.fill();
  });
  swatch('v04 rosette', (g) => {
    g.fillStyle = C.rosette;
    g.beginPath();
    g.moveTo(11, 3);
    g.lineTo(16, 8);
    g.lineTo(11, 13);
    g.lineTo(6, 8);
    g.fill();
  });
  swatch('v05 coral blooms', dot(C.bloom, 3));
  swatch('r01–r03 large rock', (g) => {
    g.fillStyle = C.rock;
    g.fillRect(4, 3, 14, 10);
    g.fillStyle = C.rockTop;
    g.fillRect(6, 4, 7, 5);
  });
  swatch('s01–s05 small rock', dot(C.stone, 2));
  swatch('d01 start gantry', bar(C.gantry, 4));
  swatch('d02 chevron', (g) => {
    g.fillStyle = C.navy;
    g.fillRect(2, 5, 18, 6);
    g.fillStyle = C.chevron;
    for (const x of [6, 11, 16]) {
      g.beginPath();
      g.moveTo(x - 2, 8);
      g.lineTo(x + 2, 4);
      g.lineTo(x + 2, 12);
      g.fill();
    }
  });
  swatch('d03 flag pole', (g) => {
    g.fillStyle = C.flag;
    g.fillRect(8, 6, 12, 4);
    g.fillStyle = C.ink;
    g.beginPath();
    g.arc(7, 8, 2.5, 0, Math.PI * 2);
    g.fill();
  });
  swatch('d04 tire stack', dot(C.tire, 5));
  swatch('d05 bollard', dot(C.bollard, 3, C.ink));
  swatch('d06 apex kerb', (g) => {
    g.fillStyle = C.kerbMarker;
    g.fillRect(2, 6, 18, 4);
    g.fillStyle = '#fff';
    g.fillRect(8, 6, 6, 4);
  });
  swatch('d07 fence / banner', (g) => {
    g.fillStyle = C.fence;
    g.fillRect(1, 7, 20, 2);
    g.fillRect(5, 5.5, 3, 5);
    g.fillRect(14, 5.5, 3, 5);
    g.fillStyle = C.banner;
    g.fillRect(7, 10, 8, 3);
  });
  swatch('d08 street lamp', (g) => {
    g.fillStyle = 'rgba(255,212,92,0.4)';
    g.beginPath();
    g.arc(11, 8, 8, 0, Math.PI * 2);
    g.fill();
    dot(C.lamp, 3)(g);
  });
  swatch('d09 barrel', dot(C.barrel, 4, '#4f2d12'));
  swatch('d10 crate', box(C.crate, '#7a5320'));
  swatch('d11 planter', (g) => {
    g.fillStyle = '#b9a6c9';
    g.fillRect(3, 5, 16, 6);
    g.fillStyle = C.planter;
    for (const x of [7, 11, 15]) {
      g.beginPath();
      g.arc(x, 8, 2, 0, Math.PI * 2);
      g.fill();
    }
  });
  swatch('d12 stone wall', box(C.wall, '#4a4370'));
  swatch('d13 bench', box(C.bench, '#6b431b'));
  swatch('d14 signpost', box(C.sign));
  swatch('d20 tool chest', (g) => {
    box('#e8483f')(g);
    g.fillStyle = C.ink;
    g.fillRect(5, 3, 12, 1.5);
  });
  swatch('d21 checker banner', (g) => {
    g.fillStyle = C.banner;
    g.fillRect(3, 6, 16, 4);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 4; i++) g.fillRect(4 + i * 4, 6, 2, 4);
    g.fillStyle = C.fence;
    for (const x of [1.5, 18.5]) g.fillRect(x, 6.5, 2, 3);
  });
  swatch('d30 produce stand', (g) => {
    box(C.crate, '#7a5320')(g);
    for (const [x, c] of [[8, '#e8483f'], [14, '#ff9d2e']] as [number, string][]) {
      g.fillStyle = c;
      g.beginPath();
      g.arc(x, 8, 2.6, 0, Math.PI * 2);
      g.fill();
    }
  });
  swatch('signed bend (outside)', bar('#d6249f', 2));
}

function renderCounts(plan: WorldPlan): void {
  const el = document.getElementById('counts')!;
  for (const e of CATALOG) {
    const div = document.createElement('div');
    const n = plan.stats.perAsset[e.id] ?? 0;
    div.innerHTML = `<span>${e.id}</span><b>${n}</b>`;
    if (n === 0) div.style.color = '#b3261e';
    el.append(div);
  }
}

/** Compare the planner's static catalog with the assets that really exist. */
async function crossCheckCatalog(): Promise<void> {
  document.getElementById('catalogTitle')!.hidden = false;
  const table = document.getElementById('catalog') as HTMLTableElement;
  const row = (text: string, ok: boolean): void => {
    const tr = table.insertRow();
    tr.className = ok ? 'ok' : 'bad';
    const s = tr.insertCell();
    s.className = 's';
    s.textContent = ok ? '✓' : '✗';
    tr.insertCell().textContent = text;
  };
  try {
    const registry = await import('../assets/registry');
    for (const e of CATALOG) {
      if (!registry.hasAsset(e.id)) {
        row(`${e.id}: not in the registry yet`, false);
        continue;
      }
      try {
        const a = await registry.loadAsset(e.id);
        if (a.kind !== 'prop') {
          row(`${e.id}: is not a prop asset`, false);
          continue;
        }
        const issues: string[] = [];
        if (a.variants !== e.variants) issues.push(`variants ${a.variants} ≠ catalog ${e.variants}`);
        const schemes = (a.schemes ?? []).join(',');
        if (schemes !== (e.schemes ?? []).join(',')) issues.push(`schemes [${schemes}] ≠ catalog [${(e.schemes ?? []).join(',')}]`);
        const size = [a.size.x, a.size.y, a.size.z];
        if (e.envelope) {
          // A building's own size includes steps and eaves: what matters to
          // the plan is that it fits the envelope its lot was cut for.
          if (a.size.x > e.envelope[0] + 0.15 || a.size.z > e.envelope[1] + 0.15) issues.push(`footprint ${a.size.x.toFixed(2)}×${a.size.z.toFixed(2)} exceeds envelope ${e.envelope.join('×')}`);
        } else if (size.some((v, i) => Math.abs(v - e.size[i]) > 0.15 + 0.1 * e.size[i])) {
          issues.push(`size ${size.map((v) => v.toFixed(2)).join('×')} ≠ catalog ${e.size.join('×')}`);
        }
        row(`${e.id}${issues.length ? ': ' + issues.join('; ') : ''}`, issues.length === 0);
      } catch (err) {
        row(`${e.id}: failed to load (${err instanceof Error ? err.message : String(err)})`, false);
      }
    }
  } catch (err) {
    row(`registry failed to load: ${err instanceof Error ? err.message : String(err)}`, false);
  }
}
