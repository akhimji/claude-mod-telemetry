// session-telemetry: how often the pane and the band redraw with no write. Pure.
//
// The terminal (and any case where a terminal may draw) keeps its cadence: 1 s
// while something runs or the Live tab shows, the Overview's cache clock 1 s
// under ten minutes left and 15 s above. When every surface that can draw is
// remote (hooks/clients.ts `isRemoteOnly`), each redraw crosses the wire, so the
// pane ticks every 2 s while something runs and every 15 s for the cache
// clock, and the band arms nothing of its own (its cache chip shows minutes).
// Whether the pane is drawn at all is checked when a remote tick fires
// (`$.ui.panes()`, in pane.tsx), not here.
//
// Exports: TICK_MS, REMOTE_TICK_MS, REMOTE_CACHE_TICK_MS, paneTickMs, bandTickMs

/** The terminal's tick while something runs. */
export const TICK_MS = 1000
/** The remote-only tick while something runs. */
export const REMOTE_TICK_MS = 2000
/** The remote-only tick of the Overview's cache clock. */
export const REMOTE_CACHE_TICK_MS = 15_000

/**
 * The pane's next redraw: `live` (something runs, or the Live tab shows its
 * ages) or the cache clock's own delay (`cacheMs`, null when it wants none);
 * null when nothing changes with the clock alone.
 */
export function paneTickMs(o: { live: boolean; cacheMs: number | null; remoteOnly: boolean }): number | null {
  if (o.live) return o.remoteOnly ? REMOTE_TICK_MS : TICK_MS
  if (o.cacheMs !== null) return o.remoteOnly ? REMOTE_CACHE_TICK_MS : o.cacheMs
  return null
}

/** The band's next redraw: the terminal's 1 s while active; nothing when every surface is remote. */
export function bandTickMs(o: { active: boolean; remoteOnly: boolean }): number | null {
  if (!o.active || o.remoteOnly) return null
  return TICK_MS
}
