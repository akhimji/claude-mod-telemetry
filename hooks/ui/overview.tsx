// session-telemetry: the Overview's sections (the terminal's cost card and the
// header's stat tiles sit above them: term/overview.tsx and term/header.tsx):
// cost (tracked, untracked, drift, per turn, cache), activity, the harness
// (what feeds the context each request and what the last request re-sent),
// rate limits with bars and reset times, the cost-per-turn and context
// sparklines, and the drift and pricing notices. Two columns of sections from
// 100 cells.
//
// Exports: overviewTab(input, o)

import { deriveContext, deriveHarness, deriveTurns, fmtDuration, fmtPct, fmtTokens, fmtUsd, type TelemetryOverview } from '../derive'
import { ACCENT, dim, driftTone, fillTone, fitSegs, fmtAgo, fmtResetIn, joinH, padLeft, rateTone, seg, sparkSegs, type Line, type Seg } from '../ui-kit'

import { figure, kv, LABEL_W, limitName, section, shareBar, toned } from './common'
import { rowsOf, type TabInput, type TabView } from './layout'

export function overviewTab(input: TabInput, o: TelemetryOverview): TabView {
  const { s, now, layout } = input
  const cols = layout.cols
  const wide = cols >= 100
  const half = wide ? Math.floor((cols - 3) / 2) : cols
  const sep = dim(' · ')
  const drift = driftTone(o.estimateDrift)
  const r = o.ledger

  // the first value of a kv row sits right-aligned in a fixed cell
  const VAL_W = 9
  const val = (text: string, style: Omit<Seg, 't'> = {}): Seg => figure(text, VAL_W, style)

  // the cost card above says tracked, ledger, untracked and drift; this section adds the rest
  const money: Line[] = [
    section('cost', half),
    ...(r.untrackedUsd !== null && r.untrackedUsd > 0 ? [kv('untracked', val(fmtUsd(r.untrackedUsd)), dim(cols >= 56 ? '  before load, other loops, modifiers' : '  before load, others'))] : []),
    kv('per turn', val(fmtUsd(o.perTurn.costUsd)), sep, seg(`${fmtTokens(o.perTurn.tokens)} tok`), sep, seg(fmtDuration(o.perTurn.avgDurationMs))),
    kv('cache', val(fmtPct(o.cacheHitRate)), dim(' hit'), sep, seg(fmtUsd(o.cacheSavedUsd)), dim(' saved')),
    kv('tok/min', val(o.burn.tokensPerMinute === null ? '–' : fmtTokens(o.burn.tokensPerMinute)), dim(` over ${Math.round(o.burn.windowMs / 60_000)}m${o.burn.isPartial ? ', partial' : ''}`)),
  ]
  const activity: Line[] = [
    section('activity', half),
    kv('requests', val(String(o.requests)), sep, seg(String(o.mainTurns)), dim(' turns')),
    kv('tools', val(`${o.toolCalls}`), dim(' calls'), sep, toned(`${o.toolErrors} err`, o.toolErrors > 0 ? rateTone(o.toolErrorRate) : null), sep, toned(fmtPct(o.toolErrorRate), rateTone(o.toolErrorRate))),
    kv('agents', val(`${o.agents.subagents}`), dim(' spawned'), sep, o.agents.running > 0 ? seg(`${o.agents.running} running`, { c: ACCENT }) : dim('0 running')),
    kv('context', val(fmtTokens(o.context.tokens)), dim(` / ${fmtTokens(o.context.window)}`), sep, toned(fmtPct(o.context.fill), fillTone(o.context.fill))),
  ]

  // the harness: what feeds the context
  const h = deriveHarness(s)
  const harness: Line[] = [section('harness', half)]
  if (h.consumers.length === 0) harness.push(kv('context', dim('no breakdown yet')))
  else {
    const bw = Math.max(6, Math.min(16, half - LABEL_W - 24))
    harness.push(kv('fixed', val(fmtTokens(h.fixedTokens)), dim(' tok'), sep, dim('prompt, tools, mcp, memory, skills')))
    harness.push(kv('messages', val(fmtTokens(h.messagesTokens)), dim(' tok'), sep, dim(`${fmtPct(h.usedTokens > 0 ? h.messagesTokens / h.usedTokens : null)} of used`)))
    for (const c of h.consumers.slice(0, 3)) harness.push(kv(c.name.toLowerCase(), ...shareBar(c.fill, bw), dim(` ${fmtPct(c.fill).padStart(4)}`), sep, seg(fmtTokens(c.tokens))))
  }
  if (h.lastRequest) {
    const q = h.lastRequest
    harness.push(kv('re-sent', val(fmtTokens(q.promptTokens)), dim(' tok/request'), sep, seg(fmtPct(q.hitRate)), dim(' from cache'), ...(cols >= 70 ? [sep, dim(`${q.messageCount} messages`)] : [])))
  }

  const blocks: Line[] = wide ? [...joinH(money, half, activity, 3), [], ...harness] : [...money, [], ...activity, [], ...harness]
  const list: Line[] = [...blocks]

  // rate limits
  if (o.rateLimits.length > 0) {
    list.push([], section('rate limits', cols))
    const bw = Math.max(6, Math.min(30, cols - LABEL_W - 26))
    for (const l of o.rateLimits) {
      const frac = l.percentUsed / 100
      const tone = fillTone(frac)
      const reset = fmtResetIn(l.resetsAt, now, fmtDuration)
      list.push(kv(limitName(l.kind), ...shareBar(frac, bw, tone ?? ACCENT), toned(` ${fmtPct(frac).padStart(4)}`, tone), ...(reset ? [dim(`  resets in ${reset}`)] : [])))
    }
  }

  // trends
  const sw = Math.max(8, cols - LABEL_W - 22)
  const turns = deriveTurns(s, { limit: sw }).reverse()
  const costs = turns.map(t => t.costUsd)
  const ctx = deriveContext(s)
  list.push([], section('trends', cols))
  list.push(costs.length === 0 ? kv('$/turn', dim('no turns yet')) : kv('$/turn', ...sparkSegs(costs, sw), dim(`  max ${fmtUsd(Math.max(...costs))}`)))
  const fills = ctx.sparklineFill
  const lastFill = fills.length > 0 ? fills[fills.length - 1] ?? null : null
  list.push(ctx.sparkline.length === 0 ? kv('context', dim('no turns yet')) : kv('context', ...sparkSegs(ctx.sparkline, sw, fillTone(lastFill) ?? ACCENT), dim(`  peak ${fmtTokens(Math.max(...ctx.sparkline))}`)))

  // notices
  const notes: Line[] = []
  if (drift !== null && o.estimateDrift !== null && o.engineCostUsd !== null && r.untrackedUsd === 0) {
    notes.push([toned('! ', drift, { bold: true }), toned(`estimate ${fmtUsd(o.estimatedCostUsd)} drifts ${o.estimateDrift >= 0 ? '+' : ''}${fmtPct(o.estimateDrift)} from the ledger ${fmtUsd(o.engineCostUsd)}`, drift)])
  }
  if (o.pricing.hasFallback) notes.push([toned('! ', 'warning', { bold: true }), dim('a model is priced at a family or default row; its estimate is approximate')])
  if (o.pricing.cacheTtl === '1h') notes.push([dim('  cache writes priced at the 1h rate')])
  if (notes.length > 0) list.push([], ...notes)
  return { head: [], items: rowsOf(list.map(l => fitSegs(l as Seg[], cols))) }
}
