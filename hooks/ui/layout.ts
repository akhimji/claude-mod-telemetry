// session-telemetry: the pane's sizes and the shapes the tab builders share.
// Pure. The body's size comes from the Pane's props; a line-kit tab answers a
// TabView (lines), which the terminal frame (term/view.tsx) turns into items
// and windows, and the desktop frame (desktop/view.tsx) draws its own.
//
// Exports: Layout, TabView, TabInput, layoutOf, rowsOf

import type { TelemetryUi } from '../../types'

import type { TelemetryAlertRules, TelemetryInsightsState } from '../insights'
import type { Line } from '../ui-kit'

export type Layout = {
  /** Cells across the pane's body. */
  cols: number
  /** Rows the tree may take (never more is drawn). */
  rows: number
  /** True where the surface draws a plain Button's hotkey itself as `k: ` (the terminal); a desktop draws a native button. */
  hkPrefix: boolean
}

/**
 * What a tab builder reads: plain data only (`s.alerts` is the alert log when the pane read it; `rules` the alert rules in force, the defaults when absent;
 * `remote` the header's `remote · <machine>` chip, present only on a remote surface of a session a Remote Control prompt was seen in: hooks/clients.ts `remoteChip`).
 */
export type TabInput = { s: TelemetryInsightsState; ui: TelemetryUi; now: number; layout: Layout; rules?: TelemetryAlertRules; remote?: string }

/**
 * What a line-kit tab builder returns: `head` rows always shown (a pinned line,
 * a table's header), `items` windowed (each a row or a card of lines), `foot`
 * rows shown after the list, `select`, the item to keep in view, and `ids`,
 * the agent id of each item (null for one that is not an agent).
 */
export type TabView = { head: Line[]; items: Line[][]; foot?: Line[]; select?: number; ids?: (string | null)[] }

const DEFAULT = { cols: 80, rows: 24 }

/** The body's size: `bodyColumns` across, the lesser of `scroll.bodyRows` and the viewport's rows down. */
export function layoutOf(props: unknown, viewport: { columns?: number; rows?: number } | undefined, surface?: string): Layout {
  const p = (props ?? {}) as { bodyColumns?: unknown; scroll?: { bodyRows?: unknown } }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null)
  const cols = num(p.bodyColumns) ?? num(viewport?.columns) ?? DEFAULT.cols
  const bodyRows = num(p.scroll?.bodyRows)
  const vpRows = num(viewport?.rows)
  const rows = bodyRows !== null && vpRows !== null ? Math.min(bodyRows, vpRows) : bodyRows ?? vpRows ?? DEFAULT.rows
  return { cols: Math.max(1, cols), rows: Math.max(1, rows), hkPrefix: surface === undefined || surface === 'terminal' }
}

/** Each line as an item of its own (a plain list). */
export const rowsOf = (lines: readonly Line[]): Line[][] => lines.map(l => [l])
