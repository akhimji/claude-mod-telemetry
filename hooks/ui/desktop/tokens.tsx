// session-telemetry: the desktop Tokens tab. Model rows (name, requests, a
// share bar, cost) with the untracked remainder and the total; the token mix
// as a stacked bar with its legend; the recent main-loop turns. Pure.
//
// Exports: deskTokens(T, input, o)

import type { RenderElement } from 'claude-code'

import { deriveModels, deriveReconciliation, deriveTurns, fmtDuration, fmtPct, fmtTokens, fmtUsd, type TelemetryOverview } from '../../derive'
import { ACCENT, fmtAgo } from '../../ui-kit'
import type { TabInput } from '../layout'
import { barSvg, PALETTE, stackSvg, swatchSvg } from '../svg'

import { cap, dot, H, kv, modelShort, num, row, section, svg, txt, type DeskView, type Item, type T4 } from './kit'

const MIX = [
  { key: 'input', label: 'in' },
  { key: 'output', label: 'out' },
  { key: 'cacheRead', label: 'cache read' },
  { key: 'cacheWrite', label: 'cache write' },
] as const

export function deskTokens(T: T4, input: TabInput, o: TelemetryOverview): DeskView {
  const { Box } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const items: Item[] = []
  const rec = deriveReconciliation(s)
  const models = deriveModels(s)

  items.push({ el: section(T, 'models', `${models.length}`), rows: H.section })
  if (models.length === 0) items.push({ el: cap(T, 'no model requests yet'), rows: H.line })
  for (const m of models) {
    items.push({
      el: row(
        T,
        [
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {txt(T, modelShort(m.label), m.pricing === 'exact' ? { weight: 'semibold' } : { weight: 'semibold', color: 'warning' })}
          </Box>,
          num(T, `${m.usage.requests} req`, 8, { size: 'caption', dimColor: true }),
          ...(cols >= 48 ? [num(T, `${fmtPct(m.cacheHitRate)} hit`, 8, { size: 'caption', dimColor: true })] : []),
          svg(T, barSvg(m.costShare, { width: 36, height: 5 })),
          num(T, fmtUsd(m.costUsd), 8),
        ],
        { pad: true },
      ),
      rows: H.row,
    })
  }
  if (models.length > 0) {
    if (rec.untrackedUsd !== null && rec.untrackedUsd > 0) items.push({ el: kv(T, 'untracked · before load', fmtUsd(rec.untrackedUsd)), rows: H.line })
    items.push({ el: kv(T, `total · ${rec.source}`, txt(T, fmtUsd(rec.totalUsd), { weight: 'semibold', tabular: true })), rows: H.line })
  }

  // the mix
  const t = o.tokens
  items.push({ el: section(T, 'mix', `${fmtTokens(t.total)} tok`), rows: H.section })
  if (t.total === 0) items.push({ el: cap(T, 'no tokens yet'), rows: H.line })
  else {
    const width = Math.max(120, Math.min(480, (cols - 2) * 6))
    items.push({ el: row(T, [svg(T, stackSvg(MIX.map(m => t[m.key]), { width, height: 8, labels: MIX.map(m => m.label) }))]), rows: H.mix })
    const legend: RenderElement[] = MIX.map((m, i) =>
      row(T, [svg(T, swatchSvg(PALETTE.mix[i] ?? PALETTE.neutral, { alt: m.label })), cap(T, `${m.label} ${fmtTokens(t[m.key])} · ${fmtPct(t.total > 0 ? t[m.key] / t.total : null)}`, { tabular: true })]),
    )
    items.push({
      el: (
        <Box flexDirection="row" flexWrap="wrap" gap="sm" overflow="hidden">
          {legend}
        </Box>
      ),
      rows: cols >= 80 ? H.line : 2,
    })
  }

  // turns
  const turns = deriveTurns(s, { limit: 50 })
  items.push({ el: section(T, 'turns', `main · ${o.mainTurns}`), rows: H.section })
  if (turns.length === 0) items.push({ el: cap(T, 'no turns yet'), rows: H.line })
  turns.forEach((r, i) => {
    const live = r.isRunning
    const n = o.mainTurns - i
    const state = live ? 'running' : r.reason === 'answer' || r.reason === null ? (r.reason ?? '–') : r.reason
    items.push({
      el: row(
        T,
        [
          dot(T, live ? 'running' : r.reason === 'aborted' ? 'stopped' : r.reason === 'error' ? 'error' : 'done', 8),
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {row(T, [txt(T, `#${n}`, { weight: 'semibold', tabular: true }), cap(T, live ? state : `${state} · ${fmtAgo(now - r.startedAt)} ago`, live ? { color: ACCENT, dimColor: false } : {})])}
          </Box>,
          ...(cols >= 56 ? [num(T, `${r.steps} req · ${r.toolCalls} tools`, 16, { size: 'caption', dimColor: true })] : []),
          num(T, fmtTokens(r.tokens), 6, { size: 'caption', dimColor: true }),
          num(T, live ? fmtDuration(now - r.startedAt) : fmtDuration(r.durationMs), 7, live ? { color: ACCENT } : { dimColor: true }),
          num(T, fmtUsd(r.costUsd), 7),
        ],
        { pad: true },
      ),
      rows: H.row,
    })
  })
  return { head: [], items }
}
