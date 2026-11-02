// session-telemetry: the terminal header. Pure. The same information
// architecture as the desktop's (hooks/ui/desktop/header.tsx):
//
//   row 1   model (accent, bold) · ◐ live / ○ idle · N agents ▶      up 1h 00m
//   rows 2-4  four stat tiles in a flex row, a quarter each: a dim upper-case
//             label, a bold value, a dim second line:
//             COST (tracked; `ledger $x` beneath), TOKENS (+% cached),
//             BURN ($/min; the window), CONTEXT (thin bar + % in the fill tone;
//             the window)
//
// Under TILES_FROM_ROWS rows, or under 36 columns, the tiles give way to one
// compact row (`$3.21 · 1.2M · $0.02/min · ━━━╸── 45%`), so a 40x10 pane keeps
// its list. The tab bar is the line kit's (`tabBar`): seven plain Buttons with
// their hotkeys drawn once by the terminal (`1: Agents`), the shown one
// inverted in the accent, the others dim and as short as the width asks.
//
// Exports: termHeader(T, input, o), TILES_FROM_ROWS, headerRowsOf(layout)

import type { RenderElement } from 'claude-code'

import { deriveContext, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtUsd, type TelemetryOverview } from '../../derive'
import { ACCENT, dim, fillTone, fitGroups, lr, seg, thinBar, type Seg } from '../../ui-kit'
import { fillGroup, isActive } from '../header'
import { alertBlock, levelTone } from '../insights-view'
import type { TabInput } from '../layout'

import { segsEl, txt, type Item, type T3 } from './kit'

/** Under this many rows the header is its first row and one compact stats row. */
export const TILES_FROM_ROWS = 14

/** Under this many columns the four tiles would be too narrow to read. */
export const TILES_FROM_COLS = 36

const SPIN = ['◐', '◓', '◑', '◒'] as const

const hasTiles = (layout: { rows: number; cols: number }): boolean => layout.rows >= TILES_FROM_ROWS && layout.cols >= TILES_FROM_COLS

/** Rows the header takes (the tab bar not counted): 4 with the tiles, 2 without. */
export const headerRowsOf = (layout: { rows: number; cols: number }): number => (hasTiles(layout) ? 4 : 2)

export function termHeader(T: T3, input: TabInput, o: TelemetryOverview): Item[] {
  const { Box } = T
  const { s, now, layout } = input
  const { cols } = layout
  const active = isActive(s, now)
  const r = o.ledger
  const sep = dim(' · ')

  // row 1: model · state · agents · uptime
  const model = seg((o.mainModelLabel ?? 'no model yet').replace(/^Claude /, ''), { c: ACCENT, bold: true })
  const state: Seg = active ? seg(`${SPIN[Math.floor(now / 1000) % SPIN.length] ?? '◐'} live`, { c: ACCENT }) : dim('○ idle')
  const running = o.agents.running
  const sub: Seg[] = running > 0 ? [sep, seg(`${running} agent${running === 1 ? '' : 's'} ▶`, { c: ACCENT })] : []
  // the alert chip, while any condition is active: kept before the agent count when the row is short
  const al = alertBlock(s, now, input.rules)
  const top = al.active[0]
  const chip: Seg[] = top ? [sep, seg(`${top.level === 'crit' ? '!!' : '!'} ${al.active.length}`, { c: levelTone(top.level), bold: true })] : []
  const up: Seg[] = [dim('up '), seg(fmtDuration(o.elapsedMs))]
  const w = (segs: readonly Seg[]): number => segs.reduce((n, x) => n + x.t.length, 0)
  const fits = (segs: Seg[]): boolean => w(segs) + 1 + w(up) <= cols
  const line1 = fits([model, sep, state, ...sub, ...chip]) ? lr([model, sep, state, ...sub, ...chip], up, cols) : fits([model, sep, state, ...chip]) ? lr([model, sep, state, ...chip], up, cols) : lr([model, sep, state], up, cols)
  const row1: Item = { el: segsEl(T, line1), rows: 1 }

  const c = deriveContext(s)
  const fill = o.context.fill ?? c.fill
  const tone = fillTone(fill)
  const window = o.context.window ?? c.window
  const burn = o.burn.usdPerMinute === null ? '–' : fmtRate(o.burn.usdPerMinute)

  if (!hasTiles(layout)) {
    // one compact row: the context fill (kept whole or cut, never dropped), then cost, burn, tokens, dropped as the width runs out
    const line2 = fitGroups(
      [
        { segs: fillGroup(fill, cols >= 48 ? 8 : 5), prio: 9 },
        { segs: [seg(fmtUsd(r.trackedUsd), { bold: true }), dim(r.source === 'ledger' ? ` of ${fmtUsd(r.ledgerUsd)}` : ' est')], prio: 8 },
        { segs: [seg(burn), dim(' burn')], prio: 6 },
        { segs: [seg(fmtTokens(o.tokens.total)), dim(' tok')], prio: 4 },
      ],
      cols,
      dim(' · '),
    )
    return [row1, { el: segsEl(T, line2 as Seg[]), rows: 1 }]
  }

  // the tiles: a quarter of the row each, three rows tall
  const quarter = Math.floor(cols / 4)
  const ledger = fmtUsd(r.ledgerUsd)
  const costSub = r.source !== 'ledger' ? 'estimate' : quarter >= 16 ? `ledger ${ledger}` : quarter >= ledger.length + 3 ? `of ${ledger}` : ledger
  const barW = Math.max(3, Math.min(10, quarter - 6))
  const tile = (label: string, value: RenderElement, sub: string): RenderElement => (
    <Box flexDirection="column" width="25%" flexShrink={0} overflow="hidden">
      {txt(T, label.toUpperCase(), { dimColor: true })}
      {value}
      {txt(T, sub, { dimColor: true })}
    </Box>
  )
  const tiles = (
    <Box flexDirection="row" height={3} overflow="hidden">
      {tile('cost', txt(T, fmtUsd(r.trackedUsd), { weight: 'bold' }), costSub)}
      {tile('tokens', txt(T, fmtTokens(o.tokens.total), { weight: 'bold' }), `${fmtPct(o.cacheHitRate)} cached`)}
      {tile('burn', txt(T, burn, { weight: 'bold' }), `${Math.round(o.burn.windowMs / 60_000)}m window`)}
      {tile('context', segsEl(T, [...thinBar(fill, barW, tone ?? 'inactive'), seg(` ${fill === null ? '–' : fmtPct(fill)}`, tone ? { c: tone, bold: true } : { bold: true })]), `of ${fmtTokens(window)}`)}
    </Box>
  )
  return [row1, { el: tiles, rows: 3 }]
}
