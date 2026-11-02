// session-telemetry: tab 7, Live. What the harness is doing now (a pinned line:
// the phase and how long it has lasted) and the recent events newest first, one
// row each: age, status glyph, actor (when not main), what happened, and the
// figures at the right (tokens, cost, duration). Tool rows go through the same
// `callRow` as the Tools tab, so a shell command's text never shows.
//
// Exports: liveTab(input)

import { deriveTimeline, fmtDuration, fmtTokens, fmtUsd, type TelemetryTimelineEvent } from '../derive'
import { ACCENT, dim, fitSegs, fmtAgo, lr, seg, type Line, type Seg } from '../ui-kit'
import { modelLabel } from '../pricing'

import { empty, legend, NARROW, statusGlyph } from './common'
import { alertBlock, alertLogRows, levelTone } from './insights-view'
import type { TabInput, TabView } from './layout'
import { callRow } from './tools'

const shortModel = (model: string | null): string => (model === null ? '' : modelLabel(model).replace(/^Claude /, ''))

function eventRow(ev: TelemetryTimelineEvent, now: number, cols: number): Seg[] {
  const dot = dim(' · ')
  const age = dim(fmtAgo(now - ev.at).padStart(3))
  const actor: Seg[] = ev.agentId === 'main' && ev.kind !== 'spawn' && ev.kind !== 'finish' ? [] : [seg(ev.actor, ev.kind === 'spawn' || ev.kind === 'finish' ? { bold: true } : { dim: true }), seg(' ')]
  const wide = cols >= NARROW
  let text: Seg[] = []
  let right: Seg[] = []
  switch (ev.kind) {
    case 'request': {
      const tk = ev.tokens
      text = [seg(shortModel(ev.model)), ...(tk ? [dim(' '), seg(fmtTokens(tk.input + tk.cacheRead + tk.cacheWrite)), dim('→'), seg(fmtTokens(tk.output))] : []), ...(ev.text ? [dot, dim(ev.text)] : [])]
      right = [...(ev.costUsd === null ? [] : [dim(fmtUsd(ev.costUsd).padStart(7)), seg(' ')]), seg(fmtDuration(ev.durationMs).padStart(6))]
      break
    }
    case 'spawn':
      text = [dim(ev.text), ...(ev.model && wide ? [dot, dim(shortModel(ev.model))] : [])]
      right = ev.isRunning ? [seg(fmtDuration(ev.durationMs), { c: ACCENT })] : []
      break
    case 'finish':
      text = [dim(ev.text), ...(ev.tokens ? [dot, seg(fmtTokens(ev.tokens.input + ev.tokens.output + ev.tokens.cacheRead + ev.tokens.cacheWrite)), dim(' tok')] : [])]
      right = [...(ev.costUsd === null ? [] : [dim(fmtUsd(ev.costUsd).padStart(7)), seg(' ')]), seg(fmtDuration(ev.durationMs).padStart(6))]
      break
    case 'turn':
      text = [dim(ev.text), ...(ev.tokens && wide ? [dot, dim(`${fmtTokens(ev.tokens.input + ev.tokens.output + ev.tokens.cacheRead + ev.tokens.cacheWrite)} tok`)] : [])]
      right = [...(ev.costUsd === null ? [] : [dim(fmtUsd(ev.costUsd).padStart(7)), seg(' ')]), ...(ev.durationMs === null ? [] : [seg(fmtDuration(ev.durationMs).padStart(6))])]
      break
    case 'compaction':
      text = [seg(ev.text, { c: 'warning' })]
      right = ev.costUsd === null ? [] : [dim(fmtUsd(ev.costUsd))]
      break
    default:
      text = [seg(ev.text)]
  }
  return lr([age, seg(' '), statusGlyph(ev.status), seg(' '), ...actor, ...text], right, cols)
}

export function liveTab(input: TabInput): TabView {
  const { s, now, layout } = input
  const cols = layout.cols
  const { now: n, events } = deriveTimeline(s, now, { limit: 100 })
  const dot = dim(' · ')

  // the pinned "now" line
  const since = n.sinceMs === null ? '' : fmtDuration(n.sinceMs)
  let phase: Seg[]
  switch (n.phase) {
    case 'tool':
      phase = [seg('▶ tool running', { c: ACCENT, bold: true }), dot, seg(n.tool ?? ''), ...(n.runningTools > 1 ? [dim(` +${n.runningTools - 1}`)] : [])]
      break
    case 'agents':
      phase = [seg('▶ waiting on', { c: ACCENT, bold: true }), seg(` ${n.detail ?? ''}`)]
      break
    case 'request':
      phase = [seg('▶ model request in flight', { c: ACCENT, bold: true }), ...(n.detail ? [dot, seg(n.detail.replace(/^Claude /, ''))] : [])]
      break
    default:
      phase = [dim('○ idle'), ...(n.lastActivityAt === null ? [] : [dot, dim('last activity')])]
  }
  const head: Line[] = [lr([dim('now '), ...phase], [seg(since, n.phase === 'idle' ? { dim: true } : { c: ACCENT })], cols)]
  // the active alerts, pinned under the now line
  const al = alertBlock(s, now, input.rules)
  for (const a of al.active) head.push(lr([dim((a.ageMs === null ? '' : fmtAgo(a.ageMs)).padStart(3)), seg(' '), seg(`${a.level === 'crit' ? '!!' : '!'} ${a.message}`, { c: levelTone(a.level) })], [], cols))
  head.push(fitSegs([dim('─'.repeat(cols))], cols))

  const log = alertLogRows(s, 20)
  if (events.length === 0 && log.length === 0) return { head, items: [[empty('nothing yet: events appear as the session works')]] }
  const items: Line[][] = events.map(ev => {
    if (ev.kind === 'tool' && ev.tool !== null) {
      const row = callRow(
        cols,
        now,
        { tool: ev.tool, label: ev.toolLabel, isServerTool: ev.isServerTool, status: ev.status === 'info' ? 'ok' : ev.status, startedAt: ev.at, wallMs: ev.durationMs, resultBytes: null, agentId: ev.agentId, error: null },
        ev.agentId === 'main' ? null : ev.actor,
      )
      return [row]
    }
    return [eventRow(ev, now, cols)]
  })
  // the alert log merged in by time (a running event stays first)
  const ats = events.map(ev => ({ at: ev.at, isRunning: ev.isRunning }))
  for (const a of log) {
    const line = lr([dim(fmtAgo(now - a.at).padStart(3)), seg(' '), seg(`${a.level === 'crit' ? '!!' : '!'} alert · ${a.message}`, a.ackd ? { dim: true } : { c: levelTone(a.level) })], a.ackd ? [dim('ackd')] : [], cols)
    let at = ats.findIndex(x => !x.isRunning && x.at <= a.at)
    if (at < 0) at = items.length
    items.splice(at, 0, [line])
    ats.splice(at, 0, { at: a.at, isRunning: false })
  }
  return { head, items, foot: [legend(cols)] }
}
