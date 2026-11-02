// session-telemetry: the desktop Live tab. A pinned "now" row (the phase with
// its dot, how long it has lasted at the right), then deriveTimeline's events
// newest first, one row each: age, dot, the actor when not main, what
// happened (grows, truncates), the figures at the right. Tool rows go through
// the Tools tab's `callRowEl`, so a shell command's text never shows. Pure.
//
// Exports: deskLive(T, input)

import type { RenderElement } from 'claude-code'

import { deriveTimeline, fmtDuration, fmtTokens, fmtUsd, type TelemetryTimelineEvent } from '../../derive'
import { modelLabel } from '../../pricing'
import { ACCENT, fmtAgo } from '../../ui-kit'
import { alertBlock, alertLogRows, levelTone } from '../insights-view'
import type { TabInput } from '../layout'

import { cap, dot, dotOf, H, num, row, txt, type DeskView, type Item, type T4 } from './kit'
import { callRowEl } from './tools'

const shortModel = (model: string | null): string => (model === null ? '' : modelLabel(model).replace(/^Claude /, ''))

function eventRow(T: T4, ev: TelemetryTimelineEvent, now: number, cols: number): RenderElement {
  const { Box } = T
  const wide = cols >= 64
  const sum = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number => t.input + t.output + t.cacheRead + t.cacheWrite
  let text = ''
  let textProps: Parameters<typeof txt>[2] = {}
  const right: RenderElement[] = []
  switch (ev.kind) {
    case 'request': {
      const tk = ev.tokens
      text = `${shortModel(ev.model)}${tk ? ` ${fmtTokens(tk.input + tk.cacheRead + tk.cacheWrite)}→${fmtTokens(tk.output)}` : ''}${ev.text ? ` · ${ev.text}` : ''}`
      if (ev.costUsd !== null) right.push(num(T, fmtUsd(ev.costUsd), 7, { size: 'caption', dimColor: true }))
      right.push(num(T, fmtDuration(ev.durationMs), 6, { dimColor: true }))
      break
    }
    case 'spawn':
      text = `${ev.text}${ev.model && wide ? ` · ${shortModel(ev.model)}` : ''}`
      if (ev.isRunning) right.push(num(T, fmtDuration(ev.durationMs), 6, { color: ACCENT }))
      break
    case 'finish':
      text = `${ev.text}${ev.tokens ? ` · ${fmtTokens(sum(ev.tokens))} tok` : ''}`
      if (ev.costUsd !== null) right.push(num(T, fmtUsd(ev.costUsd), 7, { size: 'caption', dimColor: true }))
      right.push(num(T, fmtDuration(ev.durationMs), 6, { dimColor: true }))
      break
    case 'turn':
      text = `${ev.text}${ev.tokens && wide ? ` · ${fmtTokens(sum(ev.tokens))} tok` : ''}`
      if (ev.costUsd !== null) right.push(num(T, fmtUsd(ev.costUsd), 7, { size: 'caption', dimColor: true }))
      if (ev.durationMs !== null) right.push(num(T, fmtDuration(ev.durationMs), 6, { dimColor: true }))
      break
    case 'compaction':
      text = ev.text
      textProps = { color: 'warning' }
      if (ev.costUsd !== null) right.push(num(T, fmtUsd(ev.costUsd), 7, { size: 'caption', dimColor: true }))
      break
    default:
      text = ev.text
  }
  const actor = ev.agentId !== 'main' || ev.kind === 'spawn' || ev.kind === 'finish'
  return row(T, [
    num(T, fmtAgo(now - ev.at), 3, { size: 'caption', dimColor: true }),
    dot(T, dotOf(ev.status), 8),
    <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row" gap="xs" alignItems="center">
      {[
        ...(actor ? [txt(T, ev.actor, { size: 'caption', weight: ev.kind === 'spawn' || ev.kind === 'finish' ? 'semibold' : 'regular', dimColor: ev.kind !== 'spawn' && ev.kind !== 'finish' })] : []),
        txt(T, text, ev.kind === 'turn' ? { dimColor: true, ...textProps } : textProps),
      ]}
    </Box>,
    ...right,
  ])
}

export function deskLive(T: T4, input: TabInput): DeskView {
  const { Box } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const { now: n, events } = deriveTimeline(s, now, { limit: 100 })
  const since = n.sinceMs === null ? '' : fmtDuration(n.sinceMs)
  let phase: RenderElement[]
  switch (n.phase) {
    case 'tool':
      phase = [dot(T, 'running', 10), txt(T, 'tool running', { color: ACCENT, weight: 'semibold' }), cap(T, `· ${n.tool ?? ''}${n.runningTools > 1 ? ` +${n.runningTools - 1}` : ''}`)]
      break
    case 'agents':
      phase = [dot(T, 'running', 10), txt(T, 'waiting on', { color: ACCENT, weight: 'semibold' }), cap(T, n.detail ?? '')]
      break
    case 'request':
      phase = [dot(T, 'running', 10), txt(T, 'model request in flight', { color: ACCENT, weight: 'semibold' }), ...(n.detail ? [cap(T, `· ${n.detail.replace(/^Claude /, '')}`)] : [])]
      break
    default:
      phase = [dot(T, 'idle', 10), cap(T, 'idle'), ...(n.lastActivityAt === null ? [] : [cap(T, '· since last activity')])]
  }
  const head: Item[] = [{ el: row(T, [row(T, phase), txt(T, since, n.phase === 'idle' ? { dimColor: true, tabular: true } : { color: ACCENT, tabular: true })], { justify: 'space-between', pad: true }), rows: H.row }]
  // the active alerts, pinned under the now row
  const al = alertBlock(s, now, input.rules)
  for (const a of al.active) {
    head.push({
      el: row(T, [num(T, a.ageMs === null ? '' : fmtAgo(a.ageMs), 3, { size: 'caption', dimColor: true }), dot(T, a.level === 'crit' ? 'error' : 'stopped', 8), <Box flexGrow={1} flexShrink={1} overflow="hidden">{txt(T, `${a.level === 'crit' ? '!! ' : '! '}${a.message}`, { color: levelTone(a.level) })}</Box>], { key: `alert:${a.key}` }),
      rows: H.line,
    })
  }
  const log = alertLogRows(s, 20)
  if (events.length === 0 && log.length === 0) return { head, items: [{ el: cap(T, 'nothing yet: events appear as the session works'), rows: H.line }] }
  const items: Item[] = events.map(ev => {
    if (ev.kind === 'tool' && ev.tool !== null) {
      return {
        el: callRowEl(T, cols, now, { tool: ev.tool, label: ev.toolLabel, isServerTool: ev.isServerTool, status: ev.status === 'info' ? 'ok' : ev.status, startedAt: ev.at, wallMs: ev.durationMs, resultBytes: null, agentId: ev.agentId, error: null }, ev.agentId === 'main' ? null : ev.actor),
        rows: H.line,
      }
    }
    return { el: eventRow(T, ev, now, cols), rows: H.line }
  })
  // the alert log merged in by time (a running event stays first)
  const ats = events.map(ev => ({ at: ev.at, isRunning: ev.isRunning }))
  for (const a of log) {
    const el = row(T, [num(T, fmtAgo(now - a.at), 3, { size: 'caption', dimColor: true }), dot(T, a.level === 'crit' ? 'error' : 'stopped', 8), <Box flexGrow={1} flexShrink={1} overflow="hidden">{txt(T, `alert · ${a.message}`, a.ackd ? { dimColor: true } : { color: levelTone(a.level) })}</Box>, ...(a.ackd ? [cap(T, 'ackd')] : [])], { key: `alertlog:${a.id}` })
    let at = ats.findIndex(x => !x.isRunning && x.at <= a.at)
    if (at < 0) at = items.length
    items.splice(at, 0, { el, rows: H.line })
    ats.splice(at, 0, { at: a.at, isRunning: false })
  }
  return { head, items }
}
