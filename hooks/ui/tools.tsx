// session-telemetry: tab 5, Tools. Per-tool figures (cards under NARROW cells, a
// table above), the MCP servers rolled up, and the recent calls as a log, the
// running ones in the accent. A call's input label is never shown for shell
// tools (a command line can hold secrets) or server tools, and other labels are
// shortened (ui-kit `shortLabel`: URL queries dropped).
//
// Exports: toolsTab(input), callRow(...)

import { deriveTools, fmtBytes, fmtDuration, fmtPct, fmtTokens } from '../derive'
import { ACCENT, cells, dim, fitColumns, fitSegs, fmtAgo, lr, rateTone, seg, shortLabel, type Column, type Line, type Seg } from '../ui-kit'

import { card, empty, legend, NARROW, safeError, section, shareBar, statusGlyph, tableHead, toned, toolName } from './common'
import type { TabInput, TabView } from './layout'

const TOOL_COLUMNS: Column[] = [
  { id: 'tool', head: 'tool', w: 'flex', min: 12, prio: 10 },
  { id: 'calls', head: 'calls', w: 5, align: 'r', prio: 9 },
  { id: 'ok', head: 'ok', w: 4, align: 'r', prio: 3 },
  { id: 'err', head: 'err', w: 4, align: 'r', prio: 7 },
  { id: 'errp', head: 'err%', w: 5, align: 'r', prio: 8 },
  { id: 'p50', head: 'p50', w: 6, align: 'r', prio: 6 },
  { id: 'p95', head: 'p95', w: 6, align: 'r', prio: 5 },
  { id: 'size', head: 'avg out', w: 8, align: 'r', prio: 4 },
  { id: 'tok', head: '~tok', w: 5, align: 'r', prio: 2 },
  { id: 'share', head: 'share', w: 8, prio: 6 },
]

const SERVER_COLUMNS: Column[] = [
  { id: 'server', head: 'server', w: 'flex', min: 10, prio: 10 },
  { id: 'tools', head: 'tools', w: 5, align: 'r', prio: 5 },
  { id: 'calls', head: 'calls', w: 5, align: 'r', prio: 9 },
  { id: 'err', head: 'err', w: 4, align: 'r', prio: 8 },
  { id: 'bytes', head: 'out', w: 8, align: 'r', prio: 6 },
  { id: 'wall', head: 'wall', w: 7, align: 'r', prio: 7 },
]

/**
 * One log row for a call: `age ✓ tool target …… 420ms  3 KB`; the age cell
 * fixed, the target cut, the figures whole. An error's text takes the target's
 * place (sanitised; never for a shell tool).
 */
export function callRow(
  cols: number,
  now: number,
  ev: { tool: string; label: string | null; isServerTool: boolean; status: 'running' | 'ok' | 'error' | 'denied' | 'interrupted'; startedAt: number; wallMs: number | null; resultBytes: number | null; agentId: string; error: string | null },
  actor: string | null,
): Seg[] {
  const live = ev.status === 'running'
  const name = live ? seg(toolName(ev.tool), { c: ACCENT, bold: true }) : seg(toolName(ev.tool))
  const wall = live ? seg(fmtDuration(now - ev.startedAt), { c: ACCENT }) : seg(fmtDuration(ev.wallMs))
  const size = ev.resultBytes === null || cols < NARROW ? [] : [dim(`  ${fmtBytes(ev.resultBytes).padStart(7)}`)]
  const right: Seg[] = [wall, ...size]
  const left: Seg[] = [dim(fmtAgo(now - ev.startedAt).padStart(3)), seg(' '), statusGlyph(ev.status), seg(' '), name]
  if (actor !== null && actor !== 'main') left.push(dim(` (${actor})`))
  const used = left.reduce((n, x) => n + x.t.length, 0) + right.reduce((n, x) => n + x.t.length, 0) + 2
  const room = cols - used
  if (room > 3) {
    const label = shortLabel(ev.tool, ev.label, room - 1, ev.isServerTool)
    const err = ev.status === 'error' || ev.status === 'denied' ? safeError(ev.tool, ev.error) : ''
    const text = label || err
    if (text) left.push(seg(' '), ev.status === 'error' || ev.status === 'denied' ? seg(text.slice(0, room - 1), { c: ev.status === 'error' ? 'error' : 'warning' }) : dim(text))
  }
  return lr(left, right, cols)
}

export function toolsTab(input: TabInput): TabView {
  const { s, now, layout } = input
  const cols = layout.cols
  const narrow = cols < NARROW
  const t = deriveTools(s, now, { recent: 40 })
  const items: Line[][] = []
  const dot = dim(' · ')

  const sc = t.totals.statusCounts
  items.push([section('tools', cols, narrow ? `${t.totals.calls} calls · ${t.totals.errors} err` : `${t.totals.calls} calls · ${t.totals.errors} err · ${t.totals.running} running`)])
  if (t.rows.length === 0) items.push([empty('no tool calls yet')])
  else if (narrow) {
    for (const r of t.rows) {
      const finished = r.ok + r.errors + r.denied + r.interrupted
      const errs = r.errors + r.interrupted
      const title: Seg[] = [seg(toolName(r.tool), { bold: true, ...(r.running > 0 ? { c: ACCENT } : {}) })]
      const primary: Seg[] = [seg(String(r.calls), { bold: true }), dim(' calls')]
      items.push(
        card(cols, r.running > 0 ? seg('▶', { c: ACCENT }) : rateTone(r.errorRate) === 'error' ? statusGlyph('error') : seg(' '), title, primary, [
          [toned(`${errs} err`, errs > 0 ? rateTone(r.errorRate) : null)],
          [dim('p50 '), seg(fmtDuration(r.p50WallMs))],
          [dim('p95 '), seg(fmtDuration(r.p95WallMs))],
          [seg(finished > 0 ? fmtBytes(r.resultBytes / finished) : '–'), dim(' avg out')],
        ]),
      )
    }
  } else {
    const tf = fitColumns(TOOL_COLUMNS, cols)
    const shareW = tf.find(c => c.id === 'share')?.width ?? 8
    items.push([cells(tf, tableHead(tf))])
    for (const r of t.rows) {
      const finished = r.ok + r.errors + r.denied + r.interrupted
      items.push([
        cells(tf, {
          tool: seg(toolName(r.tool), r.running > 0 ? { c: ACCENT } : {}),
          calls: seg(String(r.calls)),
          ok: dim(String(r.ok)),
          err: r.errors + r.interrupted > 0 ? toned(String(r.errors + r.interrupted), rateTone(r.errorRate)) : dim('0'),
          errp: toned(fmtPct(r.errorRate), r.errorRate ? rateTone(r.errorRate) : null),
          p50: seg(fmtDuration(r.p50WallMs)),
          p95: seg(fmtDuration(r.p95WallMs)),
          size: seg(finished > 0 ? fmtBytes(r.resultBytes / finished) : '–'),
          tok: dim(finished > 0 ? fmtTokens(r.resultTokensEstimate / finished) : '–'),
          share: shareBar(r.callShare, shareW),
        }),
      ])
    }
  }
  if (t.rows.length > 0) {
    items.push([fitSegs([dim(`  ring ${sc.ok} ok`), dot, dim(`${sc.error} error`), dot, dim(`${sc.denied} denied`), dot, dim(`${sc.interrupted} interrupted`), dot, dim(`out ${fmtBytes(t.totals.resultBytes)}`)], cols)])
  }

  if (t.servers.length > 0) {
    items.push([[]], [section('mcp servers', cols, `${t.servers.length}`)])
    if (narrow) {
      for (const m of t.servers) {
        items.push(
          card(cols, seg(' '), [seg(m.server, { bold: true })], [seg(String(m.calls), { bold: true }), dim(' calls')], [
            [seg(String(m.tools)), dim(' tools')],
            [m.errors > 0 ? toned(`${m.errors} err`, rateTone(m.calls > 0 ? m.errors / m.calls : null)) : dim('0 err')],
            [seg(fmtBytes(m.resultBytes)), dim(' out')],
            [seg(fmtDuration(m.wallMsTotal)), dim(' wall')],
          ]),
        )
      }
    } else {
      const sf = fitColumns(SERVER_COLUMNS, cols)
      items.push([cells(sf, tableHead(sf))])
      for (const m of t.servers) {
        items.push([
          cells(sf, {
            server: seg(m.server),
            tools: seg(String(m.tools)),
            calls: seg(String(m.calls)),
            err: m.errors > 0 ? toned(String(m.errors), rateTone(m.calls > 0 ? m.errors / m.calls : null)) : dim('0'),
            bytes: seg(fmtBytes(m.resultBytes)),
            wall: seg(fmtDuration(m.wallMsTotal)),
          }),
        ])
      }
    }
  }

  items.push([[]], [section('recent calls', cols, t.running.length > 0 ? `${t.running.length} running` : '')])
  if (t.recent.length === 0) items.push([empty('none')])
  else {
    for (const ev of t.recent) {
      const actor = ev.agentId === 'main' ? null : s.agents.byId[ev.agentId]?.type ?? ev.agentId.slice(0, 6)
      items.push([callRow(cols, now, ev, actor)])
    }
  }
  return { head: [], items, foot: [legend(cols)] }
}
