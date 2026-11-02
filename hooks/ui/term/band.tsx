// session-telemetry: the band above the prompt on the terminal. The desktop's
// shape (hooks/ui/desktop/band.tsx) in monospace glyphs:
//
//   ╭──────────────────────────────────────────────────────────────────────╮
//   │ ◆ telemetry                        450k of 1M · compacts at 800k  45% │
//   │ ████▓▓▓▓▓▓▓▓▓▓▓▓──────────────────────────────────────────────░░░░░░ │
//   │ ■ Messages 46k 5%  ■ MCP tools 22k 2%  ■ System tools 22k 2%        │
//   │ $30.36 tracked · 3 ▶ running · 21 done · $0.15/min · cache 3m 12s    │
//   ╰──────────────────────────────────────────────────────────────────────╯
//
// The bar: one cell per share (`allocate`, the cells add up to the width), the
// segments `█` in the engine's own category colours, the free space a dim
// `─` track, the auto-compact buffer dim `░` at the right end. The border
// costs two rows, so it is drawn only where the slot has six; under four
// the band is its compact row: `◆ telemetry · $30.36 · ctx 25% ━━━──── ·
// cache 3m`. Pure.
//
// Exports: termBand(T, band, opts, onAct): { tree, rows }

import type { RenderElement } from 'claude-code'

import type { TelemetryContextCategory } from '../../../types'
import type { TelemetryBand } from '../../insights'
import { ACCENT, cpLen, dim, fitGroups, fitSegs, lr, seg, thinBar, type Group, type Seg } from '../../ui-kit'
import { allocate, badgeTone, bandChips, barParts, compactParts, contextSummary, legendItems, type BandShow, type Chip } from '../band'

import { segsEl, txt, type T3 } from './kit'

export type TermBandOpts = {
  show: Exclude<BandShow, 'hidden'>
  cols: number
  /** Rows the band may take in all (the border's two included). */
  maxRows: number
  /** Seconds on the cache countdown (a tick is running), else minutes. */
  precise: boolean
  categories?: readonly TelemetryContextCategory[]
}

/** The border is drawn from this many rows (four of content and two of frame). */
export const BORDER_FROM_ROWS = 6

const runSeg = (r: Chip['runs'][number]): Seg => {
  const s: Seg = { t: r.t }
  if (r.bold) s.bold = true
  if (r.dim) s.dim = true
  if (r.tone === 'accent') s.c = ACCENT
  else if (r.tone) s.c = r.tone
  return s
}

const chipGroup = (chip: Chip): Group => ({ segs: chip.runs.filter(r => r.t !== '').map(runSeg), prio: chip.prio })

export function termBand(T: T3, band: TelemetryBand, opts: TermBandOpts, onAct: (act: string) => void): { tree: RenderElement; rows: number } {
  const { Box, Button, Text } = T
  const { cols } = opts
  const tone = badgeTone(band.context.tone)
  const pct = band.context.percent === null ? '–' : `${Math.round(band.context.percent)}%`
  const sep = dim(' · ')
  const title = (
    <Button key="band:open" label="telemetry" plain onPress={() => onAct('band:open')}>
      <Text weight="bold">◆ telemetry</Text>
    </Button>
  )
  const TITLE_W = cpLen('◆ telemetry')

  if (opts.show === 'compact') {
    const p = compactParts(band, opts.precise)
    const barW = cols >= 60 ? 10 : cols >= 44 ? 6 : 0
    const groups: Group[] = [{ segs: [seg(p.cost, { bold: true })], prio: 9 }]
    if (p.ctx !== null) groups.push({ segs: [seg(p.ctx, tone ? { c: tone } : { dim: true }), ...(barW > 0 ? [seg(' '), ...thinBar(band.context.fill, barW, tone ?? 'inactive')] : [])], prio: 8 })
    if (p.cache) groups.push(chipGroup(p.cache))
    if (p.alert) groups.push({ segs: [seg(p.alert.text, { c: p.alert.tone })], prio: 10 })
    const rest = fitGroups(groups, Math.max(1, cols - TITLE_W - 3), sep) as Seg[]
    const tree = (
      <Box flexDirection="row" height={1} overflow="hidden">
        {title}
        {segsEl(T, [sep, ...rest])}
      </Box>
    )
    return { tree, rows: 1 }
  }

  const bordered = opts.maxRows >= BORDER_FROM_ROWS
  const inner = Math.max(8, bordered ? cols - 4 : cols)

  // row 1: the title at the left; the summary and the badge at the right
  const badge: Seg = seg(` ${pct} `, tone ? { c: tone, inv: true, bold: true } : { dim: true, inv: true })
  const summary = contextSummary(band, inner >= 72)
  const rightSegs: Seg[] = inner - TITLE_W - 2 >= cpLen(summary) + 6 ? [dim(summary), seg(' '), badge] : [badge]
  const right = segsEl(T, lr([], rightSegs, Math.max(1, inner - TITLE_W - 1)))
  const row1 = (
    <Box flexDirection="row" height={1} overflow="hidden" gap={1}>
      {title}
      <Box flexGrow={1} flexShrink={1} flexDirection="row" justifyContent="flex-end" overflow="hidden">
        {right}
      </Box>
    </Box>
  )

  // row 2: the bar
  const parts = barParts(band, opts.categories)
  const cells = allocate(
    parts.map(p => p.tokens),
    inner,
    1,
  )
  const barSegs: Seg[] = parts.map((p, i) => {
    const w = cells[i] ?? 0
    if (p.kind === 'free') return dim('─'.repeat(w))
    if (p.kind === 'buffer') return dim('░'.repeat(w))
    return seg('█'.repeat(w), { c: p.theme })
  })
  const row2 = parts.length === 0 ? txt(T, '─'.repeat(inner), { dimColor: true }) : segsEl(T, barSegs)

  // row 3: the legend
  const legend = legendItems(parts, inner, 2)
  const legendSegs: Seg[] = []
  legend.forEach((it, i) => {
    if (i > 0) legendSegs.push(seg('  '))
    legendSegs.push(it.part.kind === 'buffer' ? dim('░') : seg('■', { c: it.part.theme }), dim(` ${it.part.label} `), seg(it.value, { bold: true }))
    if (it.pct) legendSegs.push(dim(` ${it.pct}`))
  })
  const row3 = legend.length === 0 ? txt(T, band.context.breakdownAt === null ? 'no breakdown yet: the categories arrive after the first turn' : 'nothing in the window', { dimColor: true }) : segsEl(T, fitSegs(legendSegs, inner))

  // row 4: the chips
  const row4 = segsEl(T, fitGroups(bandChips(band, { precise: opts.precise, wide: inner >= 100 }).map(chipGroup), inner, sep) as Seg[])

  const lines = [row1, row2, row3, row4]
  if (bordered) {
    return {
      tree: (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} overflow="hidden">
          {lines}
        </Box>
      ),
      rows: 6,
    }
  }
  return {
    tree: (
      <Box flexDirection="column" overflow="hidden">
        {lines}
      </Box>
    ),
    rows: 4,
  }
}
