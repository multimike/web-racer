/**
 * Perf readout (`?perf=1`, bottom left): fps, draw calls and triangles of the
 * whole frame (main + shadow pass), the shadow pass alone, near / far prop
 * instances, the cars' triangles. The game refreshes it a few times a second.
 */
export interface PerfReadout {
  fps: number;
  drawCalls: number;
  triangles: number;
  shadowDrawCalls: number;
  shadowTriangles: number;
  nearInstances: number;
  farInstances: number;
  nearActive: number;
  farActive: number;
  carTriangles: number;
  carLods: string;
  /** Render resolution, device pixels per CSS pixel, and the drawing buffer size. */
  dpr: number;
  drawWidth: number;
  drawHeight: number;
}

export interface PerfOverlayHandle {
  update(r: Readonly<PerfReadout>): void;
  dispose(): void;
}

const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));

export function createPerfOverlay(): PerfOverlayHandle {
  const root = document.createElement('pre');
  root.style.cssText =
    'position:fixed;left:10px;bottom:10px;z-index:11;margin:0;padding:6px 9px;border-radius:5px;' +
    'background:rgba(0,0,0,0.6);color:#fff;font:12px/1.35 ui-monospace,Menlo,monospace;pointer-events:none;';
  document.body.appendChild(root);
  return {
    update(r: Readonly<PerfReadout>): void {
      root.textContent =
        `${Number.isFinite(r.fps) ? r.fps.toFixed(0) : '–'} fps\n` +
        `frame   ${r.drawCalls} dc  ${k(r.triangles)} tri\n` +
        `shadow  ${r.shadowDrawCalls} dc  ${k(r.shadowTriangles)} tri\n` +
        `props   near ${r.nearInstances} inst / ${r.nearActive} meshes  far ${r.farInstances} / ${r.farActive}\n` +
        `cars    ${k(r.carTriangles)} tri  lod ${r.carLods}\n` +
        `render  ${r.dpr.toFixed(2)}x  ${r.drawWidth}×${r.drawHeight} px`;
    },
    dispose(): void {
      root.remove();
    },
  };
}
