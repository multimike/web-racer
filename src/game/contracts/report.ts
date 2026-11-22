/**
 * CONTRACT — numbers a page reports about itself, and the page protocol that
 * lets `tools/physlab.sh` collect them headlessly (it is the only sanctioned
 * way to read numbers out of a page: `tools/shot.sh` only makes pictures and
 * runs on a virtual clock, on which every duration reads 0).
 *
 * PROTOCOL (every page that supports `?report=1`: index.html, drive-lab,
 * terrain-lab, props-lab):
 *   - while working: put a short progress text into `<div id="status">`;
 *   - when finished: write `JSON.stringify(report)` into `<pre id="result">`
 *     and THEN set `document.title = 'done'`;
 *   - if it cannot finish: write `{ ...report, fatal: message }` and set
 *     `document.title = 'error'`.
 *   Both elements must exist in the page's HTML (they may be `hidden`).
 *   The page's HTML must also carry `<link rel="icon" href="data:," />`:
 *   without it Chrome asks the dev server for /favicon.ico, the 404 is logged
 *   as an error and the tool fails the run.
 *   Run:  PHYSLAB_PAGE=<page>.html tools/physlab.sh "<query>&report=1" <out.json> [timeout-s]
 *   The tool prints `report.scorecard.text`, fails on any console error or
 *   uncaught exception in the page, and needs `report.totals.simSeconds`.
 *
 *   EXIT STATUS: the tool exits 0 whenever the page ran to the end without
 *   page errors — it does NOT look at `checks` (it exits 1 on a timeout, a
 *   `fatal`, an uncaught exception or a console error). A failed check is a
 *   result, not a crash: the page still writes the report and sets the title
 *   to 'done'. The gate is a second command (plain Node):
 *     node tools/node/report-checks.mjs <out.json> [--allow=id,prefix.] [--need=id,prefix.]
 *   which exits 1 on any failed check, on `fatal`, and on page errors.
 *
 * Types only.
 */

/**
 * Render cost of one frame. How to measure (the labs do it this way):
 *   const dc = (engine as unknown as { _drawCalls: { current: number; fetchNewFrame(): void } })._drawCalls;
 *   dc.fetchNewFrame();  scene.render();  drawCalls = dc.current;
 *   triangles = scene.getActiveIndices() / 3;
 * Both count EVERY pass of the frame (main view + the sun-shadow map).
 */
export interface FrameStats {
  drawCalls: number;
  triangles: number;
  /** Of those, the shadow-map pass alone: the number of enabled meshes in
   * `look.shadows.map.renderList` and the sum of their triangles × instances
   * (0 with shadows off). */
  shadowDrawCalls: number;
  shadowTriangles: number;
}

export type ReportValue = number | string | boolean | null;

export interface LabReport {
  /** Which page and query produced it. */
  page: string;
  query: string;
  /** Required by tools/physlab.sh. `simSeconds`: simulated game time, 0 for
   * a page that only builds and draws. */
  totals: { simSeconds: number };
  /** Required by tools/physlab.sh: a human-readable summary, one line per
   * number, printed to the terminal. */
  scorecard: { text: string };
  /** Page-side errors (the tool appends console errors it saw). */
  errors: string[];
  /** Set (with document.title = 'error') when the page could not finish. */
  fatal?: string;
  /** Flat, named numbers: 'frame.drawCalls', 'boot.propsMs' … */
  stats: Record<string, ReportValue>;
  /** Named pass / fail checks the page evaluated itself. */
  checks: { id: string; value: ReportValue; target: string; pass: boolean }[];
}
