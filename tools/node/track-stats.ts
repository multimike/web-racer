// Usage (from the repo root):
//   node --import <this dir>/register.mjs <this dir>/track-stats.ts [fromSeed] [toSeed]
// Prints, per seed: centreline length, minimum centreline radius (TrackFrame's
// smoothed curvature), straight length ahead of the start line, extent, the
// closest approach of two different legs of the loop, road half width, and
// the world plan's warnings / self-check failures.
import { generateTerrain } from '../../src/terrain/generateTerrain.ts';
import { TrackFrame } from '../../src/world/trackFrame.ts';

const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? from);
const rows: string[] = [];
for (let seed = from; seed <= to; seed++) {
  const t0 = performance.now();
  const data = generateTerrain(seed) as ReturnType<typeof generateTerrain> & { plan?: { warnings: string[] } };
  const ms = performance.now() - t0;
  const track = data.track;
  const f = new TrackFrame(track, data.heightfield.size);
  let maxK = 0;
  let maxKAt = 0;
  for (let i = 0; i < f.n; i++) {
    const k = Math.abs(f.curv[i]);
    if (k > maxK) {
      maxK = k;
      maxKAt = f.s[i];
    }
  }
  // Straight ahead of the line: distance until |curvature| first exceeds 1/150.
  let straight = 0;
  for (let i = 0; i < f.n; i++) {
    if (Math.abs(f.curv[i]) > 1 / 150) break;
    straight = f.s[i + 1];
  }
  let behind = 0;
  for (let i = f.n - 1; i >= 0; i--) {
    if (Math.abs(f.curv[i]) > 1 / 150) break;
    behind = f.length - f.s[i];
  }
  let extent = 0;
  for (let i = 0; i < f.n; i++) extent = Math.max(extent, Math.abs(f.px[i]), Math.abs(f.pz[i]));
  // Closest approach of two legs: points more than 40 m apart along the loop.
  let pinch = Infinity;
  for (let i = 0; i < f.n; i += 2) {
    for (let j = i + 2; j < f.n; j += 2) {
      const ds = Math.min(f.s[j] - f.s[i], f.length - (f.s[j] - f.s[i]));
      if (ds < 40) continue;
      const d = Math.hypot(f.px[i] - f.px[j], f.pz[i] - f.pz[j]);
      if (d < pinch) pinch = d;
    }
  }
  let dh = 0;
  let maxGrade = 0;
  for (let i = 0; i < f.n; i++) {
    const j = (i + 1) % f.n;
    const g = Math.abs(f.h[j] - f.h[i]) / Math.max(1e-6, Math.hypot(f.px[j] - f.px[i], f.pz[j] - f.pz[i]));
    maxGrade = Math.max(maxGrade, g);
    dh = Math.max(dh, Math.abs(f.h[i] - f.h[0]));
  }
  rows.push(
    `seed ${String(seed).padStart(3)}  length ${f.length.toFixed(0).padStart(4)} m  minRadius ${(1 / maxK).toFixed(1).padStart(5)} m (at s=${maxKAt.toFixed(0)})` +
      `  straightAhead ${straight.toFixed(0).padStart(3)} m  straightBehind ${behind.toFixed(0).padStart(3)} m  extent ${extent.toFixed(0)} m` +
      `  pinch ${pinch.toFixed(1)} m  halfWidth ${track.halfWidth}  maxGrade ${(maxGrade * 100).toFixed(1)} %  gen ${ms.toFixed(0)} ms` +
      (data.plan ? `  planWarnings ${data.plan.warnings.length}` : ''),
  );
}
console.log(rows.join('\n'));
