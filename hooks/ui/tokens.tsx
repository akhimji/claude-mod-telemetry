// session-telemetry: tab 3, Tokens. Per-model cost and usage (cards under
// NARROW cells, a table above), the untracked remainder so the models add up to
// the headline, the session's token mix as a stacked bar, and the recent
// main-loop turns.
//
// Exports: tokensTab(input, o)

import { deriveModels, deriveReconciliation, deriveTurns, fmtDuration, fmtPct, fmtTokens, fmtUsd, type TelemetryOverview } from '../derive'
import { ACCENT, cells, dim, fitColumns, fitSegs, fmtAgo, lr, seg, stack, type Column, type Line, type Seg } from '../ui-kit'

import { card, empty, NARROW, section, shareBar, tableHead } from './common'
import { rowsOf, type TabInput, type TabView } from './layout'

const MODEL_COLUMNS: Column[] = [
  { id: 'model', head: 'model', w: 'flex', min: 12, prio: 10 },
  { id: 'req', head: 'req', w: 5, align: 'r', prio: 6 },
  { id: 'in', head: 'in', w: 6, align: 'r', prio: 5 },
  { id: 'out', head: 'out', w: 6, align: 'r', prio: 7 },
  { id: 'cr', head: 'cache r', w: 7, align: 'r', prio: 4 },
  { id: 'cw', head: 'cache w', w: 7, align: 'r', prio: 3 },
  { id: 'hit', head: 'hit', w: 4, align: 'r', prio: 2 },
  { id: 'cost', head: 'cost', w: 8, align: 'r', prio: 9 },
  { id: 'share', head: 'share', w: 10, prio: 8 },
]

const TURN_COLUMNS: Column[] = [
  { id: 'n', head: '#', w: 4, align: 'r', prio: 10 },
  { id: 'age', head: 'age', w: 4, align: 'r', prio: 6 },
  { id: 'dur', head: 'dur', w: 7, align: 'r', prio: 8 },
  { id: 'steps', head: 'req', w: 4, align: 'r', prio: 5 },
  { id: 'tools', head: 'tools', w: 5, align: 'r', prio: 4 },
  { id: 'tokens', head: 'tokens', w: 7, align: 'r', prio: 9 },
  { id: 'cost', head: 'cost', w: 8, align: 'r', prio: 9 },
  { id: 'hit', head: 'hit', w: 4, align: 'r', prio: 3 },
  { id: 'ctx', head: 'ctx', w: 7, align: 'r', prio: 5 },
  { id: 'end', head: 'result', w: 'flex', min: 6, prio: 2 },
]

/** The four parts of the mix, as glyph density (one colour, no legend colours to learn). */
const MIX = [
  { key: 'input', label: 'in', glyph: '█' },
  { key: 'output', label: 'out', glyph: '▓' },
  { key: 'cacheRead', label: 'cache r', glyph: '▒' },
  { key: 'cacheWrite', label: 'cache w', glyph: '░' },
] as const

export function tokensTab(input: TabInput, o: TelemetryOverview): TabView {
  const { s, now, layout } = input
  const cols = layout.cols
  const narrow = cols < NARROW
  const items: Line[][] = []
  const dot = dim(' · ')
  const rec = deriveReconciliation(s)

  // models
  const models = deriveModels(s)
  items.push([section('models', cols, `${models.length}`)])
  if (models.length === 0) items.push([empty('no model requests yet')])
  else if (narrow) {
    for (const m of models) {
      const title: Seg[] = [seg(m.label.replace(/^Claude /, ''), { bold: true, ...(m.pricing === 'exact' ? {} : { c: 'warning' }) })]
      const share = m.costShare === null ? '' : ` ${fmtPct(m.costShare).padStart(3)}`
      items.push(
        card(cols, seg(' '), title, [seg(fmtUsd(m.costUsd), { bold: true })], [[seg(String(m.usage.requests)), dim(' req')], [seg(fmtTokens(m.usage.input)), dim(' in')], [seg(fmtTokens(m.usage.output)), dim(' out')], [seg(fmtPct(m.cacheHitRate)), dim(' hit')]], {
          segs: [...shareBar(m.costShare, 8), dim(share)],
          right: [dim('cache r '), seg(fmtTokens(m.usage.cacheRead)), dot, dim('w '), seg(fmtTokens(m.usage.cacheWrite))],
        }),
      )
    }
  } else {
    const mf = fitColumns(MODEL_COLUMNS, cols)
    items.push([cells(mf, tableHead(mf))])
    const shareW = mf.find(c => c.id === 'share')?.width ?? 10
    for (const m of models) {
      items.push([
        cells(mf, {
          model: seg(m.label.replace(/^Claude /, ''), m.pricing === 'exact' ? {} : { c: 'warning' }),
          req: seg(String(m.usage.requests)),
          in: seg(fmtTokens(m.usage.input)),
          out: seg(fmtTokens(m.usage.output)),
          cr: seg(fmtTokens(m.usage.cacheRead)),
          cw: seg(fmtTokens(m.usage.cacheWrite)),
          hit: dim(fmtPct(m.cacheHitRate)),
          cost: seg(fmtUsd(m.costUsd)),
          share: shareBar(m.costShare, shareW),
        }),
      ])
    }
  }
  if (models.length > 0) {
    if (rec.untrackedUsd !== null && rec.untrackedUsd > 0) {
      // no share here: the rows above are shares of the tracked sum, this is the ledger's remainder
      items.push([lr([dim('  untracked / before load')], [dim(fmtUsd(rec.untrackedUsd))], cols)])
      items.push([lr([dim('  total')], [seg(fmtUsd(rec.totalUsd), { bold: true }), dim(' ledger')], cols)])
    } else {
      items.push([lr([dim('  total')], [seg(fmtUsd(rec.totalUsd), { bold: true }), dim(rec.source === 'ledger' ? ' ledger' : ' estimate')], cols)])
    }
  }

  // token mix
  const t = o.tokens
  items.push([[]], [section('mix', cols, `${fmtTokens(t.total)} tok`)])
  if (t.total === 0) items.push([empty('no tokens yet')])
  else {
    const width = Math.max(10, cols)
    const parts = stack(MIX.map(m => t[m.key]), width)
    const barSegs: Seg[] = MIX.map((m, i) => seg(m.glyph.repeat(parts[i] ?? 0), { c: ACCENT }))
    items.push([barSegs])
    const entry = (m: (typeof MIX)[number]): Seg[] => [seg(m.glyph, { c: ACCENT }), dim(` ${m.label} `), seg(fmtTokens(t[m.key])), dim(` ${fmtPct(t.total > 0 ? t[m.key] / t.total : null)}`)]
    const legend: Seg[] = []
    MIX.forEach((m, i) => {
      if (i > 0) legend.push(dim('  '))
      legend.push(...entry(m))
    })
    const lw = legend.reduce((n, x) => n + x.t.length, 0)
    if (lw <= cols) items.push([legend])
    else items.push([[...entry(MIX[0]), dim('  '), ...entry(MIX[1])]], [[...entry(MIX[2]), dim('  '), ...entry(MIX[3])]])
  }

  // turns
  const turns = deriveTurns(s, { limit: 50 })
  items.push([[]], [section('turns', cols, `main · ${o.mainTurns}`)])
  if (turns.length === 0) items.push([empty('no turns yet')])
  else if (narrow) {
    turns.forEach((r, i) => {
      const live = r.isRunning
      const n = o.mainTurns - i
      const title: Seg[] = live ? [seg(`#${n}`, { bold: true }), dim(' · '), seg('running', { c: ACCENT })] : [seg(`#${n}`, { bold: true }), dim(' · '), r.reason === 'answer' || r.reason === null ? dim(r.reason ?? '–') : seg(r.reason, { c: 'warning' }), dim(` · ${fmtAgo(now - r.startedAt)} ago`)]
      const dur = live ? seg(fmtDuration(now - r.startedAt), { c: ACCENT }) : seg(fmtDuration(r.durationMs))
      items.push(card(cols, live ? seg('▶', { c: ACCENT }) : dim('·'), title, [seg(fmtUsd(r.costUsd), { bold: true })], [[seg(String(r.steps)), dim(' req')], [seg(String(r.toolCalls)), dim(' tools')], [seg(fmtTokens(r.tokens)), dim(' tok')], [dim('ctx '), seg(fmtTokens(r.contextTokensEnd))], [dur]]))
    })
  } else {
    const tf = fitColumns(TURN_COLUMNS, cols)
    items.push([cells(tf, tableHead(tf))])
    turns.forEach((r, i) => {
      const live = r.isRunning
      items.push([
        cells(tf, {
          n: live ? seg('▶', { c: ACCENT }) : dim(String(o.mainTurns - i)),
          age: dim(fmtAgo(now - r.startedAt)),
          dur: live ? seg(fmtDuration(now - r.startedAt), { c: ACCENT }) : seg(fmtDuration(r.durationMs)),
          steps: seg(String(r.steps)),
          tools: seg(String(r.toolCalls)),
          tokens: seg(fmtTokens(r.tokens)),
          cost: seg(fmtUsd(r.costUsd)),
          hit: dim(fmtPct(r.cacheHitRate)),
          ctx: seg(fmtTokens(r.contextTokensEnd)),
          end: live ? seg('running', { c: ACCENT }) : r.reason === 'answer' || r.reason === null ? dim(r.reason ?? '–') : seg(r.reason, { c: 'warning' }),
        }),
      ])
    })
  }
  return { head: [], items: items.flatMap(it => (it.length === 1 ? rowsOf(it) : [it])).map(it => it.map(l => fitSegs(l as Seg[], cols))) }
}
