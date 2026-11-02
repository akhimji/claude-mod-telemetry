// session-telemetry: the terminal Overview tab. The desktop's shape: the alerts
// block first (the active conditions with their age, an `a: ack` Button while
// any is unacked, the rules in force, the budget bar when one is set), the cost
// card (a rounded Box: tracked this session as the headline, the ledger and
// its untracked remainder as the footnote, the drift when the estimate is over
// the ledger), the cache card (state · countdown with a thin remaining bar;
// ttl, context to re-cache, re-cache cost, the last turn's hit or miss), then
// the line kit's sections (cost, activity, harness, rate limits, trends,
// notices; two columns from 100 cells). The stat tiles are the header's, so
// the tab does not repeat them.
//
// Exports: termOverview(T, input, o, onAct)

import { fmtPct, fmtUsd, type TelemetryOverview } from '../../derive'
import { ACCENT, btn, dim, driftTone, fitLine, fitSegs, fmtAgo, lr, seg, thinBar, type Line, type Seg } from '../../ui-kit'
import { section } from '../common'
import { alertBlock, cacheCard, levelTone } from '../insights-view'
import type { TabInput } from '../layout'
import { overviewTab } from '../overview'

import { card, CARD_CHROME, fromView, lineEl, type Item, type T3, type TermView } from './kit'

export function termOverview(T: T3, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void): TermView {
  const { s, now, layout } = input
  const cols = layout.cols
  const inner = Math.max(8, cols - 4)
  const r = o.ledger
  const drift = driftTone(o.estimateDrift)
  const items: Item[] = []

  // alerts
  const al = alertBlock(s, now, input.rules)
  if (al.active.length > 0 || al.budget !== null) {
    const head: Line = section('alerts', cols, `${al.active.length}`)
    if (al.active.length > 0) {
      const first = head[1]
      if (first && !('btn' in first)) first.c = levelTone(al.active[0]?.level ?? 'warn')
    }
    items.push({ el: lineEl(T, head, onAct), rows: 1 })
    for (const a of al.active) {
      const glyph = seg(a.level === 'crit' ? '!!' : ' !', { c: levelTone(a.level), bold: true })
      items.push({ el: lineEl(T, lr([glyph, seg(' '), seg(a.message, { c: levelTone(a.level) })], a.ageMs === null ? [] : [dim(`${fmtAgo(a.ageMs)} ago`)], cols), onAct), rows: 1 })
    }
    if (al.active.length === 0) items.push({ el: lineEl(T, [dim('none active')], onAct), rows: 1 })
    const rules: Line = al.unacked > 0 ? [btn('ack', 'ack', [seg(`ack ${al.unacked}`, { c: ACCENT })], 'a', layout.hkPrefix ? undefined : 0), dim('  rules · '), dim(al.rules)] : [dim('rules · '), dim(al.rules)]
    items.push({ el: lineEl(T, fitLine(rules, cols), onAct), rows: 1 })
    if (al.budget) {
      const tone = al.budget.frac >= 1 ? 'error' : al.budget.frac >= 0.8 ? 'warning' : 'success'
      const bw = Math.max(6, Math.min(30, cols - 30))
      items.push({ el: lineEl(T, fitSegs([dim('budget    '), ...thinBar(al.budget.frac, bw, tone), seg(` ${fmtUsd(al.budget.spent)}`, { c: tone }), dim(` of ${fmtUsd(al.budget.usd)}`)], cols), onAct), rows: 1 })
    }
    items.push({ el: lineEl(T, [seg(' ')], onAct), rows: 1 })
  }

  // the cost card
  const since = r.trackedSince === null ? '' : `since ${fmtAgo(now - r.trackedSince)} ago`
  const lines: Line[] = [
    [seg('TRACKED THIS SESSION', { dim: true, bold: true }), ...(since ? [seg(' '.repeat(Math.max(1, inner - 20 - since.length))), dim(since)] : [])],
    [seg(fmtUsd(r.trackedUsd), { bold: true })],
  ]
  if (r.source === 'ledger') {
    const foot: Seg[] = [dim(`ledger ${fmtUsd(r.ledgerUsd)}`)]
    if (r.untrackedUsd !== null && r.untrackedUsd > 0) foot.push(dim(` · untracked ${fmtUsd(r.untrackedUsd)}`))
    lines.push(foot)
    if (o.estimateDrift !== null && r.untrackedUsd === 0) lines.push([seg(`estimate ${o.estimateDrift >= 0 ? '+' : ''}${fmtPct(o.estimateDrift)} over the ledger`, drift ? { c: drift } : { dim: true })])
  } else lines.push([dim('no engine ledger: estimate only')])
  items.push({ el: card(T, lines, onAct, { key: 'cost-card' }), rows: lines.length + CARD_CHROME })

  // the cache card
  const cc = cacheCard(s, now, true)
  const tone = cc.state.tone
  const bw = Math.max(4, Math.min(12, inner - 36))
  const cacheHead = lr(
    [seg('CACHE', { dim: true, bold: true }), seg(' '), seg(cc.state.text, tone ? { c: tone, bold: true } : { bold: true })],
    [...(cc.remaining === null ? [] : [...thinBar(cc.remaining, bw, tone ?? 'inactive'), seg(' ')]), seg(cc.countdown, tone ? { c: tone, bold: true } : { dim: true })],
    inner,
  )
  const cacheLines: Line[] = [cacheHead, ...cc.lines.map(l => fitSegs([dim(l.label.padEnd(10)), seg(l.value, l.tone ? { c: l.tone } : {})], inner))]
  items.push({ el: card(T, cacheLines, onAct, { key: 'cache-card' }), rows: cacheLines.length + CARD_CHROME })

  const rest = fromView(T, overviewTab(input, o), onAct, cols)
  return { head: [], items: [...items, ...rest.items] }
}
