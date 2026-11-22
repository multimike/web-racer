import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { soften } from './SolidMesh';
import type { Paint, SolidMesh } from './SolidMesh';
import { placementMatrix, toV3 } from './math';
import type { Placement, Vec3 } from './math';

/**
 * Subdivision-surface modelling: a coarse CONTROL CAGE of quads / triangles
 * smoothed by Catmull-Clark subdivision into a SolidMesh. This is how rounded
 * car shells — bulbous fenders, pods, helmets, noses — are modelled from a
 * handful of control points: place ~10–40 cage vertices, connect them with
 * faces, subdivide twice.
 *
 * RULES OF THUMB
 *  - The surface shrinks INSIDE the cage (a cube cage becomes a ball about
 *    80 % of its size); pull control points outward to compensate, add edge
 *    loops near where the surface should stay tight, or use creases.
 *  - Faces are wound like everything else in the kit: face (a, b, c, …)
 *    points along (b − a) × (c − a), outward. But winding a cage by hand is
 *    where mistakes happen, so `emit` REPAIRS it: faces are first made
 *    consistent with their neighbours, then every CLOSED shell is turned to
 *    face outward (positive volume). Only an OPEN cage depends on your
 *    winding — and then only on its first face; pass `flip: true` to `emit` if it
 *    comes out inside-out.
 *  - Open boundaries (a cage that is not closed) are kept as smooth curves.
 *  - `crease(a, b)` keeps a cage edge sharp; a chain of creased edges gives a
 *    crisp feature line (panel edge, wheel-arch lip). A vertex where three or
 *    more creased/boundary edges meet stays put as a sharp corner; `corner(v)`
 *    pins any vertex.
 *  - Each level multiplies the face count by 4 (level 2 = 16 quads = 32
 *    triangles per cage quad). 2 is right for most parts, 3 for hero curves.
 *  - Model the right half and call `mirror('x')` for symmetric shells.
 *
 * EXAMPLE — a soft pod from a box cage with a crisp bottom rim:
 *
 *   const c = new Cage();
 *   const v = c.vertices([
 *     [-0.5, 0, -1], [0.5, 0, -1], [0.5, 0, 1], [-0.5, 0, 1],            // bottom ring 0..3
 *     [-0.6, 0.5, -1.2], [0.6, 0.5, -1.2], [0.6, 0.5, 1.2], [-0.6, 0.5, 1.2], // top ring 4..7
 *   ]);
 *   c.face([v[0], v[1], v[2], v[3]], BELLY);                 // bottom (faces −y)
 *   c.face([v[7], v[6], v[5], v[4]], BODY);                  // top (faces +y)
 *   c.face([v[4], v[5], v[1], v[0]], BODY);                  // −z side
 *   c.face([v[5], v[6], v[2], v[1]], BODY);                  // +x side
 *   c.face([v[6], v[7], v[3], v[2]], BODY);                  // +z side
 *   c.face([v[7], v[4], v[0], v[3]], BODY);                  // −x side
 *   c.creaseLoop([v[0], v[1], v[2], v[3]]);                  // keep the floor edge crisp
 *   c.emit(m, { levels: 2 });
 */

interface CageFace {
  v: number[];
  paint: Paint;
}

const KEY = 1 << 22; // max cage vertices per level; ample for subdivision cages

function edgeKey(a: number, b: number): number {
  return a < b ? a * KEY + b : b * KEY + a;
}

export class Cage {
  /** Control points (mutable: move them before emitting). */
  readonly points: Vector3[] = [];
  private faces: CageFace[] = [];
  private creases = new Map<number, number>();
  private pinned = new Set<number>();

  /** Add a control point; returns its index. */
  vertex(p: Vec3): number {
    this.points.push(toV3(p).clone());
    return this.points.length - 1;
  }

  /** Add several control points; returns their indices in order. */
  vertices(list: readonly Vec3[]): number[] {
    return list.map((p) => this.vertex(p));
  }

  /**
   * Add a face from vertex indices (3 or more; quads subdivide best). It
   * faces along (b − a) × (c − a): list the corners so that direction points
   * OUT of the solid.
   */
  face(indices: readonly number[], paint: Paint): this {
    if (indices.length >= 3) this.faces.push({ v: indices.slice(), paint });
    return this;
  }

  /**
   * Add a rows × columns grid of quads over a rectangular array of vertex
   * indices `grid[row][col]`. The patch faces along (next column) × (next
   * row); pass `flip` to face the other way.
   */
  patch(grid: readonly (readonly number[])[], paint: Paint, flip = false): this {
    for (let r = 0; r + 1 < grid.length; r++) {
      for (let c = 0; c + 1 < grid[r].length; c++) {
        const a = grid[r][c], b = grid[r][c + 1], d = grid[r + 1][c], e = grid[r + 1][c + 1];
        this.face(flip ? [a, d, e, b] : [a, b, e, d], paint);
      }
    }
    return this;
  }

  /**
   * Keep the cage edge a–b sharp. `sharpness` = how many subdivision levels
   * it stays hard: Infinity (default) = a true crease; 1 or 2 = a tight but
   * rounded edge (the classic soft-bevel look) when emitting at a higher
   * level.
   */
  crease(a: number, b: number, sharpness = Infinity): this {
    if (sharpness > 0) this.creases.set(edgeKey(a, b), sharpness);
    return this;
  }

  /** Crease consecutive edges along a chain of vertices. */
  creasePath(indices: readonly number[], sharpness = Infinity): this {
    for (let i = 0; i + 1 < indices.length; i++) this.crease(indices[i], indices[i + 1], sharpness);
    return this;
  }

  /** Crease a closed loop of vertices (last connects to first). */
  creaseLoop(indices: readonly number[], sharpness = Infinity): this {
    for (let i = 0; i < indices.length; i++) this.crease(indices[i], indices[(i + 1) % indices.length], sharpness);
    return this;
  }

  /** Pin a vertex: it does not move during subdivision (a sharp point). */
  corner(v: number): this {
    this.pinned.add(v);
    return this;
  }

  /**
   * Mirror the cage across the plane through the origin perpendicular to
   * `axis`, in place: every face gets a mirrored twin (winding fixed up),
   * creases and pins are mirrored, and vertices lying ON the plane (within
   * `tolerance`) are shared so the two halves join into one smooth surface.
   * Do not put faces IN the mirror plane.
   */
  mirror(axis: 'x' | 'y' | 'z', tolerance = 1e-6): this {
    const n = this.points.length;
    const twin: number[] = [];
    for (let i = 0; i < n; i++) {
      const q = this.points[i];
      if (Math.abs(q[axis]) <= tolerance) {
        q[axis] = 0;
        twin.push(i);
      } else {
        const c = q.clone();
        c[axis] = -c[axis];
        this.points.push(c);
        twin.push(this.points.length - 1);
      }
    }
    for (const f of this.faces.slice()) this.faces.push({ v: f.v.map((i) => twin[i]).reverse(), paint: f.paint });
    for (const [key, s] of [...this.creases]) {
      const a = Math.floor(key / KEY);
      const b = key % KEY;
      this.creases.set(edgeKey(twin[a], twin[b]), s);
    }
    for (const v of [...this.pinned]) this.pinned.add(twin[v]);
    return this;
  }

  /** Number of faces in the cage. */
  get faceCount(): number {
    return this.faces.length;
  }

  /** One Catmull-Clark step; returns a NEW, finer cage (all quads). */
  subdivided(): Cage {
    const P = this.points;
    const nV = P.length;
    const faces = this.faces;

    interface Edge {
      a: number;
      b: number;
      faces: number[];
      sharp: number;
      point: number;
    }
    const edges = new Map<number, Edge>();
    const vertEdges: Edge[][] = Array.from({ length: nV }, () => []);
    const vertFaces: number[][] = Array.from({ length: nV }, () => []);
    faces.forEach((f, fi) => {
      const k = f.v.length;
      for (let i = 0; i < k; i++) {
        const a = f.v[i];
        const b = f.v[(i + 1) % k];
        vertFaces[a].push(fi);
        const key = edgeKey(a, b);
        let e = edges.get(key);
        if (!e) {
          e = { a, b, faces: [], sharp: this.creases.get(key) ?? 0, point: -1 };
          edges.set(key, e);
          vertEdges[a].push(e);
          vertEdges[b].push(e);
        }
        e.faces.push(fi);
      }
    });

    const out = new Cage();
    // New vertex order: [moved originals][face points][edge points].
    const facePoint = faces.map((f) => {
      const c = Vector3.Zero();
      for (const i of f.v) c.addInPlace(P[i]);
      return c.scaleInPlace(1 / f.v.length);
    });
    // An edge is "hard" when creased or on an open boundary.
    const hardness = (e: Edge): number => (e.faces.length !== 2 ? Infinity : e.sharp);

    const moved: Vector3[] = [];
    for (let v = 0; v < nV; v++) {
      const es = vertEdges[v];
      const p = P[v];
      if (es.length === 0 || this.pinned.has(v)) {
        moved.push(p.clone());
        continue;
      }
      const hard = es.filter((e) => hardness(e) > 0);
      const n = es.length;
      const smoothRule = (): Vector3 => {
        const F = Vector3.Zero();
        for (const fi of vertFaces[v]) F.addInPlace(facePoint[fi]);
        F.scaleInPlace(1 / Math.max(vertFaces[v].length, 1));
        const R = Vector3.Zero();
        for (const e of es) R.addInPlace(P[e.a]).addInPlace(P[e.b]);
        R.scaleInPlace(1 / (2 * n));
        return F.add(R.scale(2)).add(p.scale(n - 3)).scaleInPlace(1 / n);
      };
      if (hard.length < 2) {
        moved.push(smoothRule());
      } else if (hard.length === 2) {
        const o0 = hard[0].a === v ? hard[0].b : hard[0].a;
        const o1 = hard[1].a === v ? hard[1].b : hard[1].a;
        const creaseRule = p.scale(6).add(P[o0]).add(P[o1]).scaleInPlace(1 / 8);
        // Semi-sharp: a crease about to expire blends toward the smooth rule.
        const s = Math.min(1, (hardness(hard[0]) + hardness(hard[1])) / 2);
        moved.push(s >= 1 ? creaseRule : Vector3.Lerp(smoothRule(), creaseRule, s));
      } else {
        moved.push(p.clone());
      }
    }
    for (const q of moved) out.points.push(q);
    for (const q of facePoint) out.points.push(q);
    for (const e of edges.values()) {
      const mid = P[e.a].add(P[e.b]).scaleInPlace(0.5);
      const h = hardness(e);
      let q = mid;
      if (h < 1) {
        const smooth = P[e.a].add(P[e.b]).add(facePoint[e.faces[0]]).add(facePoint[e.faces[1]]).scaleInPlace(0.25);
        q = h <= 0 ? smooth : Vector3.Lerp(smooth, mid, h);
      }
      e.point = out.points.length;
      out.points.push(q);
      if (e.sharp > 1) {
        // Children inherit the crease, one level weaker.
        out.creases.set(edgeKey(e.a, e.point), e.sharp - 1);
        out.creases.set(edgeKey(e.point, e.b), e.sharp - 1);
      }
    }
    for (const v of this.pinned) out.pinned.add(v);

    faces.forEach((f, fi) => {
      const k = f.v.length;
      const fp = nV + fi;
      for (let i = 0; i < k; i++) {
        const v = f.v[i];
        const eNext = edges.get(edgeKey(v, f.v[(i + 1) % k]))!;
        const ePrev = edges.get(edgeKey(f.v[(i + k - 1) % k], v))!;
        out.faces.push({ v: [v, eNext.point, fp, ePrev.point], paint: f.paint });
      }
    });
    return out;
  }

  /**
   * Make the cage's winding trustworthy, in place: flood-fill across shared
   * edges so neighbouring faces agree, then flip every closed shell whose
   * volume is negative (inside-out). Open shells keep the orientation of
   * their first face. Called by `emit`.
   */
  orient(): this {
    const faces = this.faces;
    const P = this.points;
    const edgeFaces = new Map<number, number[]>();
    faces.forEach((f, fi) => {
      for (let i = 0; i < f.v.length; i++) {
        const key = edgeKey(f.v[i], f.v[(i + 1) % f.v.length]);
        const list = edgeFaces.get(key);
        if (list) list.push(fi);
        else edgeFaces.set(key, [fi]);
      }
    });
    const hasDirected = (f: CageFace, a: number, b: number): boolean => {
      for (let i = 0; i < f.v.length; i++) if (f.v[i] === a && f.v[(i + 1) % f.v.length] === b) return true;
      return false;
    };
    const seen = new Uint8Array(faces.length);
    for (let seed = 0; seed < faces.length; seed++) {
      if (seen[seed]) continue;
      seen[seed] = 1;
      const component = [seed];
      let closed = true;
      for (let q = 0; q < component.length; q++) {
        const f = faces[component[q]];
        for (let i = 0; i < f.v.length; i++) {
          const a = f.v[i];
          const b = f.v[(i + 1) % f.v.length];
          const sharing = edgeFaces.get(edgeKey(a, b))!;
          if (sharing.length !== 2) {
            closed = false;
            continue;
          }
          const gi = sharing[0] === component[q] ? sharing[1] : sharing[0];
          if (seen[gi]) continue;
          seen[gi] = 1;
          // A consistent neighbour runs the shared edge the other way.
          if (hasDirected(faces[gi], a, b)) faces[gi].v.reverse();
          component.push(gi);
        }
      }
      if (!closed) continue;
      let volume = 0;
      for (const fi of component) {
        const v = faces[fi].v;
        for (let i = 1; i + 1 < v.length; i++) {
          volume += Vector3.Dot(P[v[0]], Vector3.Cross(P[v[i]], P[v[i + 1]]));
        }
      }
      if (volume < 0) for (const fi of component) faces[fi].v.reverse();
    }
    return this;
  }

  /**
   * Subdivide and append the result to a SolidMesh.
   *   cage.emit(m);                                   // 2 levels, in place
   *   cage.emit(m, { levels: 3, at: [0, 0.4, 1.2] }); // finer, moved
   * Winding is repaired first (`orient`); `flip` reverses the result (for an
   * open cage that came out inside-out, or a deliberate inner surface).
   * Shading smoothness comes from each face's paint (`smooth` crease angle):
   * creased cage edges usually exceed it and stay crisp; for a shallow crease
   * that should still shade as a hard line, lower the paint's `smooth`.
   */
  emit(m: SolidMesh, o: CageEmitOptions = {}): void {
    this.orient();
    const levels = Math.max(0, Math.round(o.levels ?? 2));
    let cage: Cage = this;
    for (let l = 0; l < levels; l++) cage = cage.subdivided();
    const start = m.mark();
    const cache = new Map<Paint, Paint>();
    for (const f of cage.faces) {
      // After a single level neighbouring quads still differ by up to ~45°;
      // the surface is meant to be round, so keep it smooth.
      let fp = f.paint;
      if (levels === 1) {
        fp = cache.get(f.paint) ?? soften(f.paint, 45);
        cache.set(f.paint, fp);
      }
      const pts = f.v.map((i) => cage.points[i]);
      if (pts.length === 4) m.quad(pts[0], pts[1], pts[2], pts[3], fp);
      else m.fan(pts, fp);
    }
    if (o.flip) m.flip(start);
    const mat = placementMatrix(o);
    if (mat) m.transform(mat, start);
  }
}

export interface CageEmitOptions extends Placement {
  /** Catmull-Clark levels (default 2; 0 emits the raw cage). Each level
   * multiplies the face count by 4. */
  levels?: number;
  /** Reverse the facing of the emitted surface. */
  flip?: boolean;
}
