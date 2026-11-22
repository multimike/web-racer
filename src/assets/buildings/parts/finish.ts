import { bakeAO } from '../../../gfx/solid';
import type { SolidMesh } from '../../../gfx/solid';

export interface FinishOptions {
  /** Reach of the contact shadows in meters (default 0.9). */
  range?: number;
  /** Split every edge longer than this before the bake (default: no
   * splitting). Only for a building with big bare faces of its own — the
   * parts already carry the vertices their gradients need, and a global
   * split spends most of its triangles on roof seams and boards. */
  refine?: number;
}

/**
 * LAST CALL of every building builder: `return finishBuilding(m);`
 *
 * Bakes the building's ambient occlusion here instead of leaving it to the
 * asset assembler (which keeps any AO a builder authored, and then adds no
 * triangles of its own — what the builder returns is what ships). The
 * assembler's generic bake reaches 20 % of the asset's largest side — 1.3 m
 * on a cottage, 2 m on the village hall — so whole walls under an eave
 * settle at 0.6 and shaded cream plaster turns taupe; and its 16 rays and
 * single smoothing pass leave big wall cells visibly blotchy. A building
 * wants what the small props get by being small: tight contact shadows
 * (under eaves, sills and canopies, where the wall meets the plinth and the
 * plinth the ground) on otherwise clean walls. So: a fixed 0.9 m reach, more
 * rays, two smoothing passes, and the result eased so that light contact
 * shading stays light and only real creases go dark (never below 0.35).
 *
 * AO lives on vertices. A part whose only vertices are its buried ends
 * bakes one flat contact tone — the parts therefore bring their own
 * vertices in the open (wall grid, beam rings, board rows). Give a big
 * custom face of your own a few rows, or pass `refine`.
 */
export function finishBuilding(m: SolidMesh, o: FinishOptions = {}): SolidMesh {
  if (o.refine) m.tessellate(o.refine);
  bakeAO(m, { rays: 24, ground: true, maxDistance: o.range ?? 0.9, smoothPasses: 2, floor: 0 });
  alignDiagonals(m);
  const FLOOR = 0.35;
  const A = m.cornerAO;
  const out = new Float32Array(A.length);
  let authored = false;
  for (let i = 0; i < A.length; i++) {
    // occ^1.35: 0.2 → 0.11, 0.5 → 0.39, 1 → 1.
    out[i] = Math.max(FLOOR, 1 - Math.pow(1 - A[i], 1.35));
    if (out[i] < 0.999) authored = true;
  }
  // The assembler recognises a builder's bake by any corner below 1.
  if (!authored && out.length) out[0] = 0.99;
  m.writeAO(out);
  return m;
}

/**
 * Turn the diagonal of every flat quad to run ALONG its baked AO gradient.
 *
 * A wall cell with one corner in a contact shadow and three in the open
 * shades as a dark triangle if its diagonal happens to end in that corner,
 * and as a soft corner fade if it does not; a wall of cells split whichever
 * way their corners were listed shows both, as light and dark wedges beside
 * every door and window. The diagonal whose two ends are closer in AO is the
 * right one. Only pairs of triangles that are one flat, evenly coloured,
 * convex quad are touched, and only their shared edge moves — outlines,
 * neighbours and triangle count stay exactly as built.
 */
function alignDiagonals(m: SolidMesh): void {
  const raw = m.rawBuffers();
  const P = raw.positions.slice();
  const C = raw.colors.slice();
  const N = raw.normals.slice();
  const A = raw.ao.slice();
  const W = raw.wind.slice();
  const S = raw.surface;
  const T = P.length / 9;
  const same = (buf: number[], i: number, j: number, eps: number): boolean =>
    Math.abs(buf[i] - buf[j]) <= eps && Math.abs(buf[i + 1] - buf[j + 1]) <= eps && Math.abs(buf[i + 2] - buf[j + 2]) <= eps;
  const faceNormal = (t: number): [number, number, number] => {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let changed = false;
  for (let t = 0; t + 1 < T; t++) {
    const u = t + 1;
    let alike = true;
    for (let k = 0; k < 4 && alike; k++) alike = S[t * 4 + k] === S[u * 4 + k];
    if (!alike) continue;
    // The corner of each triangle that is NOT on the shared edge.
    let lone1 = -1;
    let lone2 = -1;
    let shared = 0;
    const partner = [-1, -1, -1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        if (same(P, t * 9 + a * 3, u * 9 + b * 3, 1e-7)) {
          partner[a] = b;
          shared++;
        }
      }
    }
    if (shared !== 2) continue;
    lone1 = partner.indexOf(-1);
    lone2 = [0, 1, 2].find((b) => !partner.includes(b)) ?? -1;
    if (lone1 < 0 || lone2 < 0) continue;
    // Flat and facing the same way.
    const n1 = faceNormal(t);
    const n2 = faceNormal(u);
    const l1 = Math.hypot(n1[0], n1[1], n1[2]);
    const l2 = Math.hypot(n2[0], n2[1], n2[2]);
    if (l1 < 1e-12 || l2 < 1e-12 || (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2) < 0.99999) continue;
    // Triangle 1 is (r, p, q) starting at its lone corner; triangle 2 holds
    // the same edge the other way round: (s, q, p).
    const r = t * 3 + lone1;
    const p = t * 3 + ((lone1 + 1) % 3);
    const q = t * 3 + ((lone1 + 2) % 3);
    const s = u * 3 + lone2;
    const q2 = u * 3 + ((lone2 + 1) % 3);
    const p2 = u * 3 + ((lone2 + 2) % 3);
    if (!same(P, p * 3, p2 * 3, 1e-7) || !same(P, q * 3, q2 * 3, 1e-7)) continue;
    // One colour, one normal (pinned or derived) over the whole quad.
    const corners = [r, p, q, s, q2, p2];
    if (!corners.every((c) => same(C, c * 3, r * 3, 1e-6) && same(N, c * 3, r * 3, 1e-6) && Math.abs(W[c] - W[r]) < 1e-6)) continue;
    const aoP = (A[p] + A[p2]) / 2;
    const aoQ = (A[q] + A[q2]) / 2;
    if (Math.abs(A[r] - A[s]) + 0.03 >= Math.abs(aoP - aoQ)) continue;
    // Convex with room to spare: both new triangles (r, p, s) and (r, s, q)
    // must keep the facing and a fair share of the area.
    const area = (i: number, j: number, k: number): number => {
      const ux = P[j * 3] - P[i * 3], uy = P[j * 3 + 1] - P[i * 3 + 1], uz = P[j * 3 + 2] - P[i * 3 + 2];
      const vx = P[k * 3] - P[i * 3], vy = P[k * 3 + 1] - P[i * 3 + 1], vz = P[k * 3 + 2] - P[i * 3 + 2];
      return ((uy * vz - uz * vy) * n1[0] + (uz * vx - ux * vz) * n1[1] + (ux * vy - uy * vx) * n1[2]) / l1;
    };
    const total = l1 + l2;
    if (area(r, p, s) < total * 0.05 || area(r, s, q) < total * 0.05) continue;
    // Rewrite the pair: every attribute of a corner travels with it.
    const order = [r, p, s, r, s, q];
    const take = (buf: number[], width: number): number[] => order.flatMap((c) => buf.slice(c * width, c * width + width));
    const np = take(P, 3), nc = take(C, 3), nn = take(N, 3), na = take(A, 1), nw = take(W, 1);
    na[1] = aoP;
    na[5] = aoQ;
    for (let i = 0; i < 18; i++) {
      P[t * 9 + i] = np[i];
      C[t * 9 + i] = nc[i];
      N[t * 9 + i] = nn[i];
    }
    for (let i = 0; i < 6; i++) {
      A[t * 3 + i] = na[i];
      W[t * 3 + i] = nw[i];
    }
    changed = true;
    t++; // the pair is settled; do not re-pair its second half
  }
  if (changed) m.replaceTriangles(0, { positions: P, colors: C, normals: N, surface: S.slice(), ao: A, wind: W });
}
