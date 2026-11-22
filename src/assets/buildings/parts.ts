/**
 * BUILDING PARTS — the shared kit the ten village buildings are assembled
 * from. One import:
 *
 *   import { schemePaints, variation, variantPaints, wallBox, stonePlinth, gableRoof, windowUnit, door, … } from './parts';
 *
 * `b04-gable-cottage.asset.ts` is the worked example; read it next to this.
 *
 * HOW A BUILDING IS ASSEMBLED
 *
 *  1. PAINTS (parts/paints.ts). `const v = variation(seed, '<id>')`, then
 *     `const P = variantPaints(schemePaints(scheme, '<sheet scheme>'), v)`.
 *     Never name a colour: use `P.wall`, `P.wallAlt`, `P.trim`, `P.roof`,
 *     `P.roofAlt`, `P.door`, `P.shutter`, `P.frame`, `P.timber`,
 *     `P.timberDark`, `P.stone…`, `P.metal`, `P.iron`, `P.glass`, `P.lamp`,
 *     `P.accent` — that is what makes 'warm' / 'coastal' / 'sunny' work
 *     without touching geometry. A sheet whose colours are none of the three
 *     (B06 apricot + cobalt, B07 cobalt + orange) overrides its hero scheme
 *     with `withPaints`. List the sheet's own scheme FIRST in `schemes`.
 *
 *  2. AXES AND ORIGIN. Origin = centre of the main footprint on the ground;
 *     the door side faces −z (`F.front`). The briefs' +Y (into the building)
 *     is +z here, their +Z is +y, and their pivot (front wall centre) sits at
 *     z = −depth / 2. In the asset lab `view=hero&yaw=0` looks at the FRONT
 *     (camera on −z); yaw 90 at the right side (+x), 180 at the back, 270 at
 *     the left side.
 *
 *  3. FACADES (parts/facade.ts). Everything on a wall is placed in that
 *     wall's elevation: u = meters to the viewer's right of the wall centre,
 *     v = height above the ground, w = out of the wall. `wallBox` returns the
 *     four facades `F.front / back / left / right`; `boxFacades(w, d, cx, cz)`
 *     makes them for an annex or an upper storey, `offsetFacade` for a porch
 *     front. "Left / right" in a brief's opening schedule = −u / +u on
 *     `F.front`.
 *
 *  4. ORDER (each step sinks into the previous one — nothing floats, nothing
 *     shares a plane):
 *       a. roof first — it returns a `RoofInfo` (`rise`, `heightAt`, `tiltAt`):
 *          `gableRoof` | `hipRoof` | `shedRoof` | `flatRoof`
 *       b. `stonePlinth` (top 0.5 by default, skirt 10 cm below y = 0):
 *          irregular two-course masonry with leaning joints; `blockLength`
 *          and `split` tune it, `seed` lays it out
 *       c. declare each `Opening` once; `wallBox` / `wallPanel` cut them
 *          (walls start 0.1 m below the plinth top and stop at the eave;
 *          `boards` adds weatherboard / board-and-batten joints). A second
 *          skin laid over a wall needs the opening cut in BOTH
 *       d. corners: `cornerPosts` (timber, or cream pilasters with base / cap),
 *          `quoins`, or `wallBox({ cornerRadius })` for a soft plaster shell
 *       e. bands and timber: `trimBand`, `gableFraming`, `beam`, `post`, `kneeBrace`
 *       f. fill EVERY opening: `windowUnit`, `door` — they carry the glass /
 *          leaf that closes the hole; an opening left empty shows the sky
 *       g. attachments: `canopy`, `awning`, `bracket`, `balcony`, `railing`,
 *          `pergola`, `steps`, `stairFlight`, `chimney`, `solarPanel`,
 *          `wallLamp`, `wallLantern`, `lantern`, `signBoard`, `emblem`
 *          (+ `EMBLEMS`), `louvreVent`. Nothing may overlap a band, a
 *          surround or a bracket: a lamp over a door needs its whole height
 *          between the surround and whatever is above (see gallery.ts)
 *       h. dressing by seed: `planter`, `barrel`, `crate`, `flowerBox`
 *       i. `return finishBuilding(m);` — ALWAYS the last line (see 7)
 *
 *  5. VARIANTS. Seed 0 is the sheet. Every optional choice goes through `v`
 *     — `v.cycle([...])` for the choices that must differ between
 *     neighbouring seeds (door colour, shutters, covering), `v.chance`,
 *     `v.flip`, `v.pick`, `v.shift` for the rest — so seed 0 gets the hero
 *     answer and other seeds change secondary detail only. Do not move
 *     openings or change the massing. THE GAME INSTANTIATES SEEDS 0 – 2 ONLY
 *     (`variants: 3` in src/world/catalog.ts): an option that should ever be
 *     seen has to `cycle` onto seed 1 or 2, not `chance` its way onto seed 4.
 *
 *  6. BUDGET. 6 000 triangles, and with `finishBuilding` what you author is
 *     what ships (nothing is added for AO). Check every seed (`variants=3`
 *     in the lab) and leave ~150 spare. The cottage is 5 480 – 5 840; the
 *     three reference assemblies in parts/gallery.ts (two-storey hip-roof
 *     house with balcony, pilasters, quoins and two bands · rounded
 *     flat-roof terrace with pergola, railings, stair and solar panel ·
 *     boarded shed with awning, signs, vent, porch and dressing) are 5 350 /
 *     5 130 / 5 520 — open them in the lab as `zz-kit-two-storey`,
 *     `zz-kit-terrace`, `zz-kit-shed`.
 *     Measured costs: wallBox 6 × 5 m with 7 openings 480 (two-storey 5 × 4
 *     with 9 openings 610 at the default 0.9 m grid; a rounded shell 800) ·
 *     stonePlinth 480 for 6 × 5 m (22 a metre of wall) · gableRoof 1 190
 *     (tiles 1 340) · hipRoof 350 · shedRoof 150 · flatRoof 380 rounded, 75
 *     square · cornerPosts 176 (530 with base and cap) · gableFraming 230 ·
 *     window 90, with shutters 195, with surround 215 (a pill 270) · door
 *     350 (arched 380, double 345) · canopy 560 · steps 86 · chimney 325 ·
 *     trimBand 128 · quoins 180 a storey-high corner · balcony 400 · railing
 *     ≈ 40 per metre of rails or boards · pergola 420 · stairFlight 250 slab,
 *     290 open · awning 330 · wallLamp 175 · wallLantern 106 · signBoard 290
 *     (hanging 420) · wrench emblem 195 · louvreVent 140 · solarPanel 184 ·
 *     barrel 180 (planted 245) · crate 300 · planter 144 · flowerBox 110 ·
 *     bracket 60 · kneeBrace 28.
 *     The cheap shapes (parts/shapes.ts) are `beam` (16 a segment + 6 a cap;
 *     10 a segment with `back: false`), `pillow` (18), `plankPanel` (~20 a
 *     board), `frameRing` (10 a point), `rib` (8) and `chamferRing` sections;
 *     a `roundedBox` is 44 at `segments: 1`, 92 at 2 and 156 at 3 — 2 for
 *     the long cream trim, 3 where the section is seen end on at eye level
 *     (canopy boards, chimney cap): at 2 it reads as an octagon up close.
 *
 *  7. AO is baked by `finishBuilding` (parts/finish.ts), not by the asset
 *     assembler: tight 0.9 m contact shadows on clean walls instead of the
 *     generic bake's murk. It lives on vertices, and a part whose only
 *     vertices are buried in its neighbours bakes one flat contact tone — so
 *     `wallPanel` builds its face as a grid (with a row just above the
 *     plinth), `beam` rings itself, roof slabs carry a column inside each
 *     gable end and a station below the ridge roll, seams break there
 *     (`rib({ breakAt })`), board faces end inside their opening. A big flat
 *     part of your own with only corner vertices needs a few rows (or
 *     `m.tessellate(edge, start)` right after you add it). After the bake
 *     `finishBuilding` turns the diagonal of every flat quad along its AO
 *     gradient, which removes the light / dark wedges beside openings.
 *
 *  8. COLLIDERS. One box hugging the walls (plinth included); the roof as a
 *     few stacked boxes that follow the slopes — `gableRoofInfo(…).heightAt`
 *     gives the surface without building the roof (see the cottage) — so a
 *     car that lands on it rests on the roof it sees; a box for the chimney;
 *     plus boxes for whatever stands on the road side: steps, stairs, posts,
 *     stilts, pots. Leave canopies, awnings and balconies above 2.3 m out.
 *
 *  9. `size` on the asset = bounding box of the finished seed 0 including
 *     overhangs, steps and chimney; x and z must fit the brief's placement
 *     envelope. State the main-body dimensions in the file comment.
 *
 * 10. PROPORTIONS measured on the sheets (they are chunkier than they look):
 *     corner posts and pilasters 0.34 – 0.38 m, tie beams 0.34 – 0.37,
 *     bargeboards 0.44 deep × 0.3 thick with a 0.77 m boss on the apex,
 *     chimney stacks 0.8 – 0.85 with a 1.05 cap, canopy side boards 0.27,
 *     door knobs 0.18 on a 0.24 rose, plinths 0.5 high, roof seams 0.9
 *     apart. The part defaults are these numbers. Roofs are STEEP: the
 *     sheets draw 35 – 37° gables whatever "ridge height" a brief quotes —
 *     keep the brief's eave and take the pitch from the drawing.
 *
 * KNOWN LIMITS: `stonePlinth` has square corners (under a `cornerRadius`
 * shell its corner blocks stand ~10 cm proud of the curve); openings must lie
 * inside their panel and below its top line; gutters and downpipes are not
 * drawn on any sheet and are not in the kit. Do not build frames with
 * `extrudePolygon({ holes })` — for some sizes its front face comes out with
 * a triangle across the hole; `frameRing` is the robust way.
 */

export * from './parts/paints';
export * from './parts/facade';
export * from './parts/shapes';
export * from './parts/walls';
export * from './parts/openings';
export * from './parts/roofs';
export * from './parts/attachments';
export * from './parts/finish';
