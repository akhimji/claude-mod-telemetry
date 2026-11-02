// session-telemetry: the desktop Overview tab. The cost card (tracked this
// session as the headline, the ledger and its untracked remainder as the
// footnote), the cost and activity rows, the harness consumers with bars, the
// rate limits with bars, the trend sparklines, and the notices. Pure.
//
// Exports: deskOverview(T, input, o)

import type { RenderElement } from 'claude-code'

import { deriveContext, deriveHarness, deriveTurns, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtUsd, type TelemetryOverview } from '../../derive'
import { driftTone, fillTone, fmtAgo, fmtResetIn, rateTone } from '../../ui-kit'
import { limitName } from '../common'
import { alertBlock, cacheCard, levelTone } from '../insights-view'
import type { TabInput } from '../layout'
import { barSvg, gaugeSvg, sparkSvg, toneHex } from '../svg'

import { cap, card, dot, H, kv, row, section, svg, toneOf, txt, type DeskView, type Item, type T4 } from './kit'

export function deskOverview(T: T4, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void = () => undefined): DeskView {
  const { Box, Button, Text } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const r = o.ledger
  const drift = driftTone(o.estimateDrift)
  const items: Item[] = []
  const barW = Math.max(36, Math.min(120, (cols - 24) * 4))

  // alerts: the active conditions first, the rules in force, the budget
  const al = alertBlock(s, now, input.rules)
  if (al.active.length > 0 || al.budget !== null) {
    const ack =
      al.unacked > 0 ? (
        <Button key="ack" label={`ack ${al.unacked}`} plain hotkey="a" dimColor onPress={() => onAct('ack')}>
          <Text size="caption">ack {al.unacked}</Text>
        </Button>
      ) : null
    items.push({
      el: (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingTop="sm" overflow="hidden">
          {cap(T, 'ALERTS', { weight: 'semibold', ...(al.active.length > 0 ? { color: levelTone(al.active[0]?.level ?? 'warn'), dimColor: false } : {}) })}
          {ack ?? cap(T, `${al.active.length}`, { tabular: true })}
        </Box>
      ),
      rows: H.section,
    })
    for (const a of al.active) {
      items.push({
        el: row(T, [dot(T, a.level === 'crit' ? 'error' : 'stopped', 8), <Box flexGrow={1} flexShrink={1} overflow="hidden">{txt(T, a.message, { color: levelTone(a.level) })}</Box>, cap(T, a.ageMs === null ? '' : `${fmtAgo(a.ageMs)} ago`, { tabular: true })], { key: `alert:${a.key}` }),
        rows: H.line,
      })
    }
    if (al.active.length === 0) items.push({ el: cap(T, 'none active'), rows: H.line })
    items.push({ el: cap(T, `rules · ${al.rules}`), rows: H.line })
    if (al.budget) {
      const tone = al.budget.frac >= 1 ? 'error' : al.budget.frac >= 0.8 ? 'warning' : 'success'
      items.push({ el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, 'budget')}</Box>, svg(T, barSvg(al.budget.frac, { width: barW, height: 5, color: toneHex(tone) })), cap(T, `${fmtUsd(al.budget.spent)} of ${fmtUsd(al.budget.usd)}`, { tabular: true, color: tone, dimColor: false })]), rows: H.line })
    }
  }

  // the cost card
  const costLines: RenderElement[] = [
    row(T, [cap(T, 'TRACKED THIS SESSION', { weight: 'semibold' }), cap(T, r.trackedSince === null ? '' : `since ${fmtAgo(now - r.trackedSince)} ago`)], { justify: 'space-between' }),
    txt(T, fmtUsd(r.trackedUsd), { weight: 'semibold', tabular: true }),
  ]
  if (r.source === 'ledger') {
    costLines.push(cap(T, `ledger ${fmtUsd(r.ledgerUsd)}${r.untrackedUsd !== null && r.untrackedUsd > 0 ? ` · untracked ${fmtUsd(r.untrackedUsd)}` : ''}`, { tabular: true }))
    if (o.estimateDrift !== null && r.untrackedUsd === 0) costLines.push(cap(T, `estimate ${o.estimateDrift >= 0 ? '+' : ''}${fmtPct(o.estimateDrift)} over the ledger`, drift ? { color: drift, dimColor: false } : {}))
  } else costLines.push(cap(T, 'no engine ledger: estimate only'))
  items.push({ el: card(T, costLines, { key: 'cost-card' }), rows: costLines.length + H.cardChrome })

  // the cache card: the clock's state, the countdown with its ring, the figures
  const cc = cacheCard(s, now, true)
  const ringTone = cc.state.tone
  const cacheLines: RenderElement[] = [
    row(
      T,
      [
        row(T, [cap(T, 'CACHE', { weight: 'semibold' }), cap(T, cc.state.text, ringTone ? { color: ringTone, dimColor: false, weight: 'semibold' } : { weight: 'semibold' })]),
        row(T, [svg(T, gaugeSvg(cc.remaining, { size: 16, color: toneHex(ringTone) })), txt(T, cc.countdown, { weight: 'semibold', tabular: true, ...(ringTone ? { color: ringTone } : { dimColor: true }) })]),
      ],
      { justify: 'space-between' },
    ),
    ...cc.lines.map(l => kv(T, l.label, txt(T, l.value, { tabular: true, size: 'caption', ...(l.tone ? { color: l.tone } : {}) }))),
  ]
  items.push({ el: card(T, cacheLines, { key: 'cache-card' }), rows: cacheLines.length + H.cardChrome })

  // cost rows
  items.push({ el: section(T, 'cost'), rows: H.section })
  items.push({ el: kv(T, 'per turn', `${fmtUsd(o.perTurn.costUsd)} · ${fmtTokens(o.perTurn.tokens)} tok · ${fmtDuration(o.perTurn.avgDurationMs)}`), rows: H.line })
  items.push({ el: kv(T, 'cache', `${fmtPct(o.cacheHitRate)} hit · ${fmtUsd(o.cacheSavedUsd)} saved`), rows: H.line })
  items.push({ el: kv(T, 'burn', `${o.burn.usdPerMinute === null ? '–' : fmtRate(o.burn.usdPerMinute)} · ${o.burn.tokensPerMinute === null ? '–' : fmtTokens(o.burn.tokensPerMinute)} tok/min`), rows: H.line })

  // activity
  items.push({ el: section(T, 'activity'), rows: H.section })
  items.push({ el: kv(T, 'requests', `${o.requests} · ${o.mainTurns} turns`), rows: H.line })
  items.push({ el: kv(T, 'tools', txt(T, `${o.toolCalls} calls · ${o.toolErrors} err (${fmtPct(o.toolErrorRate)})`, { tabular: true, ...toneOf(o.toolErrors > 0 ? rateTone(o.toolErrorRate) : null) })), rows: H.line })
  items.push({ el: kv(T, 'agents', `${o.agents.subagents} spawned · ${o.agents.running} running`), rows: H.line })
  items.push({ el: kv(T, 'context', txt(T, `${fmtTokens(o.context.tokens)} / ${fmtTokens(o.context.window)} · ${fmtPct(o.context.fill)}`, { tabular: true, ...toneOf(fillTone(o.context.fill)) })), rows: H.line })

  // the harness
  const hz = deriveHarness(s)
  items.push({ el: section(T, 'harness', hz.consumers.length === 0 ? '' : `${fmtTokens(hz.usedTokens)} used`), rows: H.section })
  if (hz.consumers.length === 0) items.push({ el: cap(T, 'no breakdown yet'), rows: H.line })
  else {
    items.push({ el: kv(T, 'fixed (prompt, tools, memory)', `${fmtTokens(hz.fixedTokens)} tok`), rows: H.line })
    items.push({ el: kv(T, 'messages', `${fmtTokens(hz.messagesTokens)} tok · ${fmtPct(hz.usedTokens > 0 ? hz.messagesTokens / hz.usedTokens : null)}`), rows: H.line })
    for (const c of hz.consumers.slice(0, 3)) {
      items.push({
        el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, c.name.toLowerCase())}</Box>, svg(T, barSvg(c.fill, { width: barW, height: 5 })), cap(T, `${fmtPct(c.fill)} · ${fmtTokens(c.tokens)}`, { tabular: true })]),
        rows: H.line,
      })
    }
  }
  if (hz.lastRequest) {
    const q = hz.lastRequest
    items.push({ el: kv(T, 're-sent per request', `${fmtTokens(q.promptTokens)} tok · ${fmtPct(q.hitRate)} from cache`), rows: H.line })
  }

  // rate limits
  if (o.rateLimits.length > 0) {
    items.push({ el: section(T, 'rate limits'), rows: H.section })
    for (const l of o.rateLimits) {
      const frac = l.percentUsed / 100
      const tone = fillTone(frac)
      const reset = fmtResetIn(l.resetsAt, now, fmtDuration)
      items.push({
        el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, limitName(l.kind))}</Box>, svg(T, barSvg(frac, { width: barW, height: 5, color: toneHex(tone) })), cap(T, `${fmtPct(frac)}${reset ? ` · resets in ${reset}` : ''}`, { tabular: true, ...toneOf(tone) })]),
        rows: H.line,
      })
    }
  }

  // trends
  const sw = Math.max(48, Math.min(160, (cols - 24) * 4))
  const turns = deriveTurns(s, { limit: 40 }).reverse()
  const costs = turns.map(t => t.costUsd)
  const ctx = deriveContext(s)
  items.push({ el: section(T, 'trends'), rows: H.section })
  items.push({
    el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, '$ per turn')}</Box>, ...(costs.length === 0 ? [cap(T, 'no turns yet')] : [svg(T, sparkSvg(costs, { width: sw, height: 18 })), cap(T, `max ${fmtUsd(Math.max(...costs))}`, { tabular: true })])]),
    rows: H.spark,
  })
  const lastFill = ctx.sparklineFill[ctx.sparklineFill.length - 1] ?? null
  items.push({
    el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, 'context')}</Box>, ...(ctx.sparkline.length === 0 ? [cap(T, 'no turns yet')] : [svg(T, sparkSvg(ctx.sparkline, { width: sw, height: 18, color: toneHex(fillTone(lastFill)) })), cap(T, `peak ${fmtTokens(Math.max(...ctx.sparkline))}`, { tabular: true })])]),
    rows: H.spark,
  })

  // notices
  if (o.pricing.hasFallback) items.push({ el: cap(T, '! a model is priced at a family or default row; its estimate is approximate', { color: 'warning', dimColor: false }), rows: H.line })
  if (o.pricing.cacheTtl === '1h') items.push({ el: cap(T, 'cache writes priced at the 1h rate'), rows: H.line })
  return { head: [], items }
}
