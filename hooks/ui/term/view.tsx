// session-telemetry: the terminal pane's frame. The header (term/header.tsx),
// the tab bar (the line kit's), then one tab's view windowed by its items'
// heights (hooks/ui/desktop/window.ts, with whole rows), a pager row when the
// items do not fit, the window following the selection on Agents. Every row
// is one terminal row (a truncating Text, or a Box of height 1), and the count
// is exact, so the tree is never taller than the body and the engine's own
// window never scrolls. Pure: the element table, plain data and the press
// closure in; a tree and what the scroll handler needs out.
//
// Exports: termTree(T, input, o, onAct), TermFrame

import type { RenderElement } from 'claude-code'

import type { TelemetryUiTab } from '../../../types'
import type { TelemetryOverview } from '../../derive'
import { btn, dim, seg } from '../../ui-kit'
import { tabBar } from '../header'
import type { TabInput } from '../layout'
import { buildTab } from '../tabs'
import { flattenItems, windowItems } from '../desktop/window'

import { termAgents } from './agents'
import { headerRowsOf, termHeader } from './header'
import { fromView, lineEl, type T3, type TermView } from './kit'
import { termOverview } from './overview'

export type TermFrame = {
  tree: RenderElement
  maxOffset: number
  agentIds: string[]
  /** Rows the tree takes: header, tab bar, head, the shown items, the pager. Never over the layout's rows. */
  usedRows: number
  shown: number
  total: number
}

function buildTerm(T: T3, tab: TelemetryUiTab, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void, onType: (value: string) => void): TermView {
  switch (tab) {
    case 'agents':
      return termAgents(T, input, onAct, onType)
    case 'overview':
      return termOverview(T, input, o, onAct)
    default:
      return fromView(T, buildTab(tab, input, o), onAct, input.layout.cols)
  }
}

export function termTree(T: T3, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void, onType: (value: string) => void = () => undefined): TermFrame {
  const { Box } = T
  const { ui, layout } = input
  const { rows } = layout
  const tab = ui.tab
  const header = termHeader(T, input, o)
  const tabs = lineEl(T, tabBar(tab, layout), onAct)
  let used = headerRowsOf(layout) + 1
  // a pane too short for its header: the header's rows give way from the bottom
  const top: RenderElement[] = []
  let budget = rows - 1
  for (const item of header) {
    if (item.rows > budget) break
    top.push(item.el)
    budget -= item.rows
  }
  used = rows - 1 - budget + 1
  const view = buildTerm(T, tab, input, o, onAct, onType)
  // the body's room under the header and the tab bar; a Box of that height clips whatever would not fit
  const room = Math.max(0, rows - used)
  let left = room
  const head: RenderElement[] = []
  const headRows: number[] = []
  for (const item of view.head) {
    if (item.rows > left) break
    head.push(item.el)
    headRows.push(item.rows)
    left -= item.rows
  }
  // the list comes first: in a short pane the head gives way until the first item has room
  const firstRows = Math.max(1, view.items[Math.min(view.items.length - 1, Math.max(0, view.select ?? 0))]?.rows ?? 1)
  while (view.items.length > 0 && left < firstRows && head.length > 0) {
    head.pop()
    left += headRows.pop() ?? 0
  }
  // an item taller than the room (an agent drawer) is windowed as its parts, a row at a time
  const flat = flattenItems(view.items, left - 1, view.select, undefined, view.selectTo)
  const heights = flat.items.map(i => i.rows)
  const w = windowItems(heights, left, ui.scroll[tab] ?? 0, flat.select, 1, flat.selectTo)
  const shownItems = flat.items.slice(w.offset, w.offset + w.count)
  const body = shownItems.map(i => i.el)
  const bodyRows = headRows.reduce((n, h) => n + h, 0) + shownItems.reduce((n, i) => n + i.rows, 0) + (w.pager ? 1 : 0)
  used += Math.min(room, bodyRows)
  const pager = w.pager
    ? lineEl(
        T,
        [
          btn(`${tab}:up`, 'up', [seg('▲')], 'k'),
          seg(' '),
          btn(`${tab}:down`, 'down', [seg('▼')], 'j'),
          dim(`  ${w.count === 0 ? 0 : w.offset + 1}–${Math.min(flat.items.length, w.offset + w.count)} of ${flat.items.length}`),
        ],
        onAct,
      )
    : null
  const tree = (
    <Box flexDirection="column" overflow="hidden">
      {top}
      {tabs}
      <Box flexDirection="column" height={room} overflow="hidden">
        {head}
        {body}
        {pager}
      </Box>
    </Box>
  )
  const agentIds = tab === 'agents' ? (view.ids ?? []).filter((id): id is string => id !== null) : []
  return { tree, maxOffset: w.maxOffset, agentIds, usedRows: used, shown: w.count, total: flat.items.length }
}
