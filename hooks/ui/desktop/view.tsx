// session-telemetry: the desktop pane's frame. Header, tab bar, then one
// tab's view windowed by its items' estimated heights (window.ts), a pager row
// when it does not fit, the window following the selection on Agents. Pure:
// the element table, plain data and the press closure in; a tree and what the
// scroll handler needs (the max offset, the agent ids) out.
//
// Payload: every surface this frame draws on is remote, so the whole tree
// crosses the wire on each redraw. The window is also held to a budget: at most
// PAYLOAD_TEXT_BUDGET characters of tree text (every string in the tree: the
// Texts, the labels, the Svg markup) and PAYLOAD_JSON_BUDGET serialized. When
// the rows would show more, the room is shrunk (the pane under-fills, with the
// pager) until the tree fits, so a tall pane over a large session stays far
// under the engine's 100k cut. Ordinary panes never reach it.
//
// Exports: deskTree(T, input, o, onAct), DeskFrame, PAYLOAD_TEXT_BUDGET,
//          PAYLOAD_JSON_BUDGET, payloadOf

import type { RenderElement } from 'claude-code'

import type { TelemetryUiTab } from '../../../types'
import type { TelemetryOverview } from '../../derive'
import type { TabInput } from '../layout'

import { deskAgents } from './agents'
import { deskContext } from './context'
import { deskFlow } from './flow'
import { deskHeader, deskTabs, headerRows, tabRows } from './header'
import { cap, row, type DeskView, type T4 } from './kit'
import { deskLive } from './live'
import { deskOverview } from './overview'
import { deskTokens } from './tokens'
import { deskTools } from './tools'
import { flattenItems, windowItems } from './window'

/** The most tree text the frame aims to draw: every string in it (header, tabs, head, the shown items, the pager). */
export const PAYLOAD_TEXT_BUDGET = 36_000
/** The most serialized characters the frame aims to draw (the strings, the props and the structure). */
export const PAYLOAD_JSON_BUDGET = 80_000

/** What the pager row and the frame's own Boxes are allowed for in the budgets (built after the window; generous). */
const PAGER_COST = { text: 300, json: 2_000 }

type Cost = { text: number; json: number }

/** The strings of an element, summed (Text children, labels, Svg markup and every other string prop). */
function textOf(el: unknown, depth = 0): number {
  if (typeof el === 'string') return el.length
  if (depth > 64 || el === null || typeof el !== 'object') return 0
  if (Array.isArray(el)) return el.reduce((n: number, x) => n + textOf(x, depth + 1), 0)
  let n = 0
  for (const v of Object.values(el as Record<string, unknown>)) n += textOf(v, depth + 1)
  return n
}

/** An element's tree text and serialized length (handlers are neither). */
export function payloadOf(el: unknown): Cost {
  let json = 0
  try {
    json = JSON.stringify(el)?.length ?? 0
  } catch {
    json = 0
  }
  return { text: textOf(el), json }
}

const over = (c: Cost): boolean => c.text > PAYLOAD_TEXT_BUDGET || c.json > PAYLOAD_JSON_BUDGET

export type DeskFrame = {
  tree: RenderElement
  maxOffset: number
  agentIds: string[]
  /** The estimated rows the tree takes (header, tabs, head, the shown items, the pager): never over the layout's rows. */
  usedRows: number
  /** Items shown of the tab's list. */
  shown: number
  total: number
}

function buildDesk(T: T4, tab: TelemetryUiTab, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void, onType: (value: string) => void): DeskView {
  switch (tab) {
    case 'agents':
      return deskAgents(T, input, onAct, onType)
    case 'tokens':
      return deskTokens(T, input, o)
    case 'context':
      return deskContext(T, input, onAct)
    case 'tools':
      return deskTools(T, input)
    case 'flow':
      return deskFlow(T, input)
    case 'live':
      return deskLive(T, input)
    default:
      return deskOverview(T, input, o, onAct)
  }
}

export function deskTree(T: T4, input: TabInput, o: TelemetryOverview, onAct: (act: string) => void, onType: (value: string) => void = () => undefined): DeskFrame {
  const { Box, Button, Text } = T
  const { ui, layout } = input
  const { cols, rows } = layout
  const tab = ui.tab
  const view = buildDesk(T, tab, input, o, onAct, onType)
  const header = deskHeader(T, input, o)
  const tabs = deskTabs(T, tab, cols, onAct)
  // the budget: one row under the stated rows, since the heights are estimates
  let used = headerRows(rows) + tabRows(cols)
  let left = Math.max(0, rows - 1 - used)
  const head: RenderElement[] = []
  const headRows: number[] = []
  for (const item of view.head) {
    if (item.rows > left) break
    head.push(item.el)
    headRows.push(item.rows)
    left -= item.rows
    used += item.rows
  }
  // the list comes first: in a tiny pane the head gives way until the first (or the selected) item has room
  const firstRows = Math.min(rows - 1 - headerRows(rows) - tabRows(cols), Math.max(1.5, view.items[Math.min(view.items.length - 1, Math.max(0, view.select ?? 0))]?.rows ?? 1.5))
  // (with the pager's row too when the items will not all fit)
  const itemsRows = view.items.reduce((n, i) => n + i.rows, 0)
  while (view.items.length > 0 && left < firstRows + (itemsRows > left ? 1.5 : 0) && head.length > 0) {
    head.pop()
    const back = headRows.pop() ?? 0
    left += back
    used -= back
  }
  // an item taller than the room (an agent drawer) is windowed as its parts, a line at a time
  const flat = flattenItems(view.items, left - 1.5, view.select, undefined, view.selectTo)
  const heights = flat.items.map(i => i.rows)
  const offset = ui.scroll[tab] ?? 0
  let w = windowItems(heights, left, offset, flat.select, 1.5, flat.selectTo)
  // the payload budget: shrink the room while the window would draw past it (never under one item)
  const fixed: Cost = [header, tabs, ...head].map(payloadOf).reduce((a, b) => ({ text: a.text + b.text, json: a.json + b.json }), { ...PAGER_COST })
  const costs = new Map<number, Cost>()
  const costOf = (i: number): Cost => {
    let c = costs.get(i)
    if (c === undefined) {
      c = payloadOf(flat.items[i]?.el)
      costs.set(i, c)
    }
    return c
  }
  let room = left
  for (let pass = 0; pass < 32 && w.count > 1 && room > 1; pass += 1) {
    const total: Cost = { ...fixed }
    let shownRows = 0
    for (let i = w.offset; i < w.offset + w.count; i += 1) {
      const c = costOf(i)
      total.text += c.text
      total.json += c.json
      shownRows += heights[i] ?? 0
    }
    if (!over(total)) break
    const share = Math.min(
      Math.max(0, PAYLOAD_TEXT_BUDGET - fixed.text) / Math.max(1, total.text - fixed.text),
      Math.max(0, PAYLOAD_JSON_BUDGET - fixed.json) / Math.max(1, total.json - fixed.json),
    )
    // at least the last shown item's rows go each pass, so the loop ends within the item count
    const lastRows = Math.max(0.5, heights[w.offset + w.count - 1] ?? 0.5)
    room = Math.max(1, Math.min(room - lastRows, shownRows * share + (w.pager ? 1.5 : 0)))
    w = windowItems(heights, room, offset, flat.select, 1.5, flat.selectTo)
  }
  const shownItems = flat.items.slice(w.offset, w.offset + w.count)
  const body = shownItems.map(i => i.el)
  used += shownItems.reduce((n, i) => n + i.rows, 0) + (w.pager ? 1.5 : 0)
  const pager = w.pager
    ? row(
        T,
        [
          row(T, [
            <Button key={`${tab}:up`} label="up" plain hotkey="k" dimColor onPress={() => onAct('up')}>
              <Text>▲</Text>
            </Button>,
            <Button key={`${tab}:down`} label="down" plain hotkey="j" dimColor onPress={() => onAct('down')}>
              <Text>▼</Text>
            </Button>,
          ]),
          cap(T, `${w.count === 0 ? 0 : w.offset + 1}–${Math.min(flat.items.length, w.offset + w.count)} of ${flat.items.length}`, { tabular: true }),
        ],
        { justify: 'space-between', pad: true },
      )
    : null
  const tree = (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {header}
      {tabs}
      <Box flexDirection="column" overflow="hidden">
        {head}
        {body}
        {pager}
      </Box>
    </Box>
  )
  const agentIds = tab === 'agents' ? (view.ids ?? []).filter((id): id is string => id !== null) : []
  return { tree, maxOffset: w.maxOffset, agentIds, usedRows: used, shown: w.count, total: flat.items.length }
}
