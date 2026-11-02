// session-telemetry: the desktop Tools tab. One row per tool (name, calls,
// errors in the rate's tone, p50, a share bar), the MCP servers, and the
// recent calls as a log, the running ones in the accent. A call's input label
// goes through `shortLabel` and never shows for a shell or server tool; an
// error's text through `safeError`. Pure.
//
// Exports: deskTools(T, input), callRowEl(T, cols, now, ev, actor)

import type { RenderElement } from 'claude-code'

import { deriveTools, fmtBytes, fmtDuration } from '../../derive'
import { ACCENT, fmtAgo, rateTone, shortLabel } from '../../ui-kit'
import { safeError, toolName } from '../common'
import type { TabInput } from '../layout'
import { barSvg } from '../svg'

import { cap, dot, dotOf, H, num, row, section, svg, toneOf, truncateTo, txt, type DeskView, type Item, type T4 } from './kit'

export type CallLike = { tool: string; label: string | null; isServerTool: boolean; status: 'running' | 'ok' | 'error' | 'denied' | 'interrupted'; startedAt: number; wallMs: number | null; resultBytes: number | null; agentId: string; error: string | null }

/** One log row for a call: age, dot, tool (and actor), the safe label or error, the wall time and size at the right. */
export function callRowEl(T: T4, cols: number, now: number, ev: CallLike, actor: string | null): RenderElement {
  const { Box } = T
  const live = ev.status === 'running'
  const label = shortLabel(ev.tool, ev.label, Math.max(8, cols - 30), ev.isServerTool)
  const err = ev.status === 'error' || ev.status === 'denied' ? safeError(ev.tool, ev.error) : ''
  const detail = label || err
  return row(T, [
    num(T, fmtAgo(now - ev.startedAt), 3, { size: 'caption', dimColor: true }),
    dot(T, dotOf(ev.status), 8),
    <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row" gap="xs" alignItems="center">
      {[
        txt(T, toolName(ev.tool), live ? { color: ACCENT, weight: 'semibold' } : {}),
        ...(actor !== null && actor !== 'main' ? [cap(T, actor)] : []),
        ...(detail ? [cap(T, truncateTo(detail, Math.max(8, cols - 30)), err ? { color: ev.status === 'error' ? 'error' : 'warning', dimColor: false } : {})] : []),
      ]}
    </Box>,
    ...(ev.resultBytes !== null && cols >= 64 ? [num(T, fmtBytes(ev.resultBytes), 7, { size: 'caption', dimColor: true })] : []),
    num(T, live ? fmtDuration(now - ev.startedAt) : fmtDuration(ev.wallMs), 7, live ? { color: ACCENT } : { dimColor: true }),
  ])
}

export function deskTools(T: T4, input: TabInput): DeskView {
  const { Box } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const t = deriveTools(s, now, { recent: 40 })
  const items: Item[] = []

  items.push({ el: section(T, 'tools', `${t.totals.calls} calls · ${t.totals.errors} err${t.totals.running > 0 ? ` · ${t.totals.running} running` : ''}`), rows: H.section })
  if (t.rows.length === 0) items.push({ el: cap(T, 'no tool calls yet'), rows: H.line })
  for (const r of t.rows) {
    const errs = r.errors + r.interrupted
    items.push({
      el: row(
        T,
        [
          dot(T, r.running > 0 ? 'running' : errs > 0 && rateTone(r.errorRate) === 'error' ? 'error' : 'idle', 8),
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {txt(T, toolName(r.tool), r.running > 0 ? { color: ACCENT, weight: 'semibold' } : { weight: 'semibold' })}
          </Box>,
          num(T, `${r.calls}`, 5, { tabular: true }),
          num(T, errs > 0 ? `${errs} err` : '', 6, { size: 'caption', ...(errs > 0 ? toneOf(rateTone(r.errorRate)) : { dimColor: true }) }),
          ...(cols >= 48 ? [num(T, `p50 ${fmtDuration(r.p50WallMs)}`, 10, { size: 'caption', dimColor: true })] : []),
          svg(T, barSvg(r.callShare, { width: 36, height: 5 })),
        ],
        { pad: true },
      ),
      rows: H.row,
    })
  }
  if (t.rows.length > 0) {
    const sc = t.totals.statusCounts
    items.push({ el: cap(T, `ring: ${sc.ok} ok · ${sc.error} error · ${sc.denied} denied · ${sc.interrupted} interrupted · out ${fmtBytes(t.totals.resultBytes)}`, { tabular: true }), rows: H.line })
  }

  if (t.servers.length > 0) {
    items.push({ el: section(T, 'mcp servers', `${t.servers.length}`), rows: H.section })
    for (const m of t.servers) {
      items.push({
        el: row(T, [
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {txt(T, m.server, { weight: 'semibold' })}
          </Box>,
          num(T, `${m.tools} tools`, 8, { size: 'caption', dimColor: true }),
          num(T, `${m.calls} calls`, 9, { tabular: true }),
          num(T, m.errors > 0 ? `${m.errors} err` : '', 6, { size: 'caption', ...(m.errors > 0 ? toneOf(rateTone(m.calls > 0 ? m.errors / m.calls : null)) : { dimColor: true }) }),
          ...(cols >= 64 ? [num(T, fmtBytes(m.resultBytes), 7, { size: 'caption', dimColor: true }), num(T, fmtDuration(m.wallMsTotal), 7, { size: 'caption', dimColor: true })] : []),
        ]),
        rows: H.line,
      })
    }
  }

  items.push({ el: section(T, 'recent calls', t.running.length > 0 ? `${t.running.length} running` : ''), rows: H.section })
  if (t.recent.length === 0) items.push({ el: cap(T, 'none'), rows: H.line })
  for (const ev of t.recent) {
    const actor = ev.agentId === 'main' ? null : s.agents.byId[ev.agentId]?.type ?? ev.agentId.slice(0, 6)
    items.push({ el: callRowEl(T, cols, now, ev, actor), rows: H.line })
  }
  return { head: [], items }
}
