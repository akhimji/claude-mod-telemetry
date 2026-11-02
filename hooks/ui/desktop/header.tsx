// session-telemetry: the desktop header and tab bar. Pure.
//
// Header, three rows: (1) the model chip, the live / idle state with its dot,
// the running agents, the alert chip, `remote · <machine>` when a remote
// viewer watches a Remote Control session (TabInput.remote), the uptime at the right; (2-3) four stat tiles in a flex
// row: Cost (tracked this session; the ledger small beneath), Tokens, Burn,
// Context (a ring gauge and the percentage). The ledger's untracked remainder
// is the Overview's footnote, not a headline.
//
// Tab bar: seven Buttons in a wrapping row, Agents first; the shown one in
// the accent, the others dim and as short as the width asks (tabVariant). The
// hotkey is drawn once, by the desktop's own badge for `hotkey`; the label is
// the plain name.
//
// Exports: deskHeader(T, input, o), deskTabs(T, tab, cols), headerRows, tabRows, tabVariant

import type { RenderElement } from 'claude-code'

import type { TelemetryUiTab } from '../../../types'
import { deriveContext, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtUsd, type TelemetryOverview } from '../../derive'
import { ACCENT, cpLen, fillTone } from '../../ui-kit'
import { TAB_LABELS, TAB_ORDER, isActive } from '../header'
import { alertBlock, levelTone } from '../insights-view'
import type { TabInput } from '../layout'
import { gaugeSvg, toneHex } from '../svg'

import { cap, dot, modelShort, row, svg, tile, toneOf, txt, type T4 } from './kit'

/** Under this many rows the header is its first row alone: the tiles give way to the list. */
export const TILES_FROM_ROWS = 14

/** Rows the header takes: row 1, and the tiles (two captions and a value) where the pane has the rows. */
export const headerRows = (rows: number): number => (rows < TILES_FROM_ROWS ? 1.5 : 4.5)

/** Rows the tab bar takes at `cols`: one, or two when the labels wrap. */
export function tabRows(cols: number): number {
  return tabLabelsWidth(tabVariant(cols)) > cols ? 2.5 : 1.5
}

/** Cells the desktop's own hotkey badge (`[1]`) and the gap take beside each label: an estimate, the native chrome cannot be measured here. */
const BADGE_CELLS = 4

/** The width the seven labels of `variant` come to with their badges, whichever tab is shown in full. */
function tabLabelsWidth(variant: 0 | 1 | 2): number {
  const all = TAB_ORDER.reduce((n, id) => n + cpLen(TAB_LABELS[id][variant]) + BADGE_CELLS, 0)
  const grow = Math.max(...TAB_ORDER.map(id => cpLen(TAB_LABELS[id][0]) - cpLen(TAB_LABELS[id][variant])))
  return all + grow
}

/** The shortest label variant that keeps the seven tabs on one row at `cols` (the last when none does). */
export function tabVariant(cols: number): 0 | 1 | 2 {
  for (const v of [0, 1, 2] as const) if (tabLabelsWidth(v) <= cols) return v
  return 2
}

export function deskHeader(T: T4, input: TabInput, o: TelemetryOverview): RenderElement {
  const { Box } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const active = isActive(s, now)
  const r = o.ledger
  const running = o.agents.running

  const al = alertBlock(s, now, input.rules)
  const top = al.active[0]
  const left: RenderElement[] = [
    txt(T, modelShort(o.mainModelLabel ?? 'no model yet'), { weight: 'semibold', color: ACCENT }),
    dot(T, active ? 'running' : 'idle', 10),
    cap(T, active ? 'live' : 'idle', active ? { color: ACCENT, dimColor: false } : {}),
    ...(running > 0 ? [cap(T, `· ${running} agent${running === 1 ? '' : 's'}`)] : []),
    // the alert chip: a dot in the level's tone and the count, while any condition is active
    ...(top ? [dot(T, top.level === 'crit' ? 'error' : 'stopped', 8), cap(T, `${top.level === 'crit' ? '!!' : '!'} ${al.active.length}`, { color: levelTone(top.level), dimColor: false, weight: 'semibold' })] : []),
    // which machine a remote viewer is watching (only where a Remote Control prompt was seen)
    ...(input.remote !== undefined ? [cap(T, `· ${input.remote}`)] : []),
  ]
  const line1 = row(T, [row(T, left), cap(T, `up ${fmtDuration(o.elapsedMs)}`, { tabular: true })], { justify: 'space-between' })
  if (layout.rows < TILES_FROM_ROWS) return line1

  // cost: tracked this session is the headline; the ledger beneath it
  const costSub = r.source === 'ledger' ? (cols >= 56 ? `ledger ${fmtUsd(r.ledgerUsd)}` : `of ${fmtUsd(r.ledgerUsd)}`) : 'estimate'
  const fill = o.context.fill ?? deriveContext(s).fill
  const tone = fillTone(fill)
  const tiles = (
    <Box flexDirection="row" gap="sm" overflow="hidden">
      {tile(T, 'cost', txt(T, fmtUsd(r.trackedUsd), { weight: 'semibold', tabular: true }), cap(T, costSub, { tabular: true }))}
      {tile(T, 'tokens', txt(T, fmtTokens(o.tokens.total), { weight: 'semibold', tabular: true }), cap(T, `${fmtPct(o.cacheHitRate)} cached`, { tabular: true }))}
      {tile(T, 'burn', txt(T, o.burn.usdPerMinute === null ? '–' : fmtRate(o.burn.usdPerMinute), { weight: 'semibold', tabular: true }), cap(T, `${Math.round(o.burn.windowMs / 60_000)}m window`))}
      {tile(
        T,
        'context',
        row(T, [svg(T, gaugeSvg(fill, { size: 16, color: toneHex(tone) })), txt(T, fill === null ? '–' : fmtPct(fill), { weight: 'semibold', tabular: true, ...toneOf(tone) })]),
        cap(T, `of ${fmtTokens(o.context.window ?? deriveContext(s).window)}`, { tabular: true }),
      )}
    </Box>
  )
  return (
    <Box flexDirection="column" gap="xs" overflow="hidden">
      {line1}
      {tiles}
    </Box>
  )
}

export function deskTabs(T: T4, tab: TelemetryUiTab, cols: number, onAct: (act: string) => void): RenderElement {
  const { Box, Button, Text } = T
  const variant = tabVariant(cols)
  return (
    <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center" overflow="hidden">
      {TAB_ORDER.map((id, i) => {
        const shown = id === tab
        const name = shown ? TAB_LABELS[id][0] : TAB_LABELS[id][variant]
        // the hotkey once: the desktop draws its own badge for `hotkey`, so the label is the plain name
        return (
          <Button key={`tab:${id}`} label={TAB_LABELS[id][0]} plain hotkey={String(i + 1)} onPress={() => onAct(`tab:${id}`)}>
            {shown ? (
              <Text color={ACCENT} weight="semibold">
                {name}
              </Text>
            ) : (
              <Text dimColor>{name}</Text>
            )}
          </Button>
        )
      })}
    </Box>
  )
}
