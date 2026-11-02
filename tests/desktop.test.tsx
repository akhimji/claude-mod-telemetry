// The desktop rendering path (hooks/ui/desktop/): through the kit on the
// `desktop` and `vscode` surfaces, every tab, empty / populated / ledgerGap, at
// 40, 48, 64 and 120 cells, the tree validates (Box, Text, Button, Svg), each
// fixture's headline appears, no fixed-width row overflows the pane, every Svg
// has an alt and a bounded source, the estimated rows never exceed the body;
// the Agents table, its drawer, the pager, the Tokens total, the Live now row
// moving with the clock, the refresh control; and the pure helpers (the window,
// the agent phase, the cell widths).

import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import type { TelemetryState } from '../types'

import { deriveOverview } from '../hooks/derive'
import { emptyState } from '../hooks/model'
import { agentPhase, cellWidths, elapsedText, laneWidth } from '../hooks/ui/desktop/agents'
import type { T4 } from '../hooks/ui/desktop/kit'
import { deskTree } from '../hooks/ui/desktop/view'
import { windowItems } from '../hooks/ui/desktop/window'
import { layoutOf } from '../hooks/ui/layout'
import { TABS, UI_INITIAL } from '../hooks/ui/ui-state'

import { ledgerGap, NOW, populated, SECRET, withGhosts, withManyDone } from './fixture'
import { withPlans } from './plans-fixture'

const SIZES = [
  [40, 24],
  [48, 24],
  [64, 32],
  [120, 50],
] as const

type Surface = 'desktop' | 'vscode'

const pane = (cols: number, rows: number, surface: Surface) =>
  ({
    plugin: 'session-telemetry',
    surface,
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

function seed(on: On, s: TelemetryState): void {
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: 1 } }
  })
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function walk(el: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(el)) {
    for (const x of el) walk(x, fn)
    return
  }
  if (!el || typeof el !== 'object') return
  const n = el as Node
  fn(n)
  for (const c of n.children ?? []) walk(c, fn)
}

/** Every Text's string, in document order. */
function texts(tree: unknown): string[] {
  const out: string[] = []
  walk(tree, n => {
    if (n.type !== 'Text') return
    const own = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
    if (own.trim() !== '') out.push(own)
  })
  return out
}

function svgs(tree: unknown): { alt: string; source: string }[] {
  const out: { alt: string; source: string }[] = []
  walk(tree, n => {
    if (n.type === 'Svg') out.push({ alt: String(n.props?.alt ?? ''), source: String(n.props?.source ?? '') })
  })
  return out
}

/** The widest sum of fixed cell widths in any row Box. */
function widestRow(tree: unknown): number {
  let widest = 0
  walk(tree, n => {
    if (n.type !== 'Box' || n.props?.flexDirection !== 'row') return
    let sum = 0
    for (const c of n.children ?? []) {
      const child = c as Node
      const w = child?.props?.width
      // Box widths are cells; an Svg's is CSS pixels, sized by its own rule (laneWidth and the like)
      if (child?.type === 'Box' && typeof w === 'number') sum += w
    }
    widest = Math.max(widest, sum)
  })
  return widest
}

function buttons(tree: unknown): { key: string; label: string; texts: string[]; colors: string[] }[] {
  const out: { key: string; label: string; texts: string[]; colors: string[] }[] = []
  walk(tree, n => {
    if (n.type !== 'Button') return
    const colors: string[] = []
    walk(n.children, c => {
      if (c.type === 'Text' && typeof c.props?.color === 'string') colors.push(c.props.color)
    })
    out.push({ key: String(n.props?.key ?? ''), label: String(n.props?.label ?? ''), texts: texts(n.children), colors })
  })
  return out
}

test('every tab draws on desktop and vscode, at 40, 48, 64 and 120 cells, for every fixture', async ($, on) => {
  mock.clock(on, { now: NOW })
  let state: TelemetryState = emptyState(NOW - 1000)
  let version = 1
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (state as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version } }
  })
  for (const which of ['empty', 'populated', 'ledgerGap'] as const) {
    state = which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : ledgerGap()
    version += 1
    // the headline is the tracked cost; the ledger sits beneath it
    const headline = which === 'empty' ? '$0.00' : which === 'populated' ? '$3.21' : '$0.63'
    const ledger = which === 'populated' ? '$2.80' : which === 'ledgerGap' ? '$1200.00' : 'estimate'
    for (const surface of ['desktop', 'vscode'] as const) {
      for (const [cols, rows] of SIZES) {
        const ui = await $.ui.mount(pane(cols, rows, surface))
        for (const tab of TABS) {
          await ui.press({ key: `tab:${tab}` })
          const tree = await ui.drawn()
          const where = `${which} ${surface} ${cols}x${rows} ${tab}`
          const root = tree as unknown as Node
          expect(root.type, where).toBe('Box')
          const all = texts(tree)
          const text = all.join('\n')
          expect(all.length, `${where}: content`).toBeGreaterThan(8)
          expect(text, `${where}: the tracked headline`).toContain(headline)
          expect(text, `${where}: the ledger beneath it`).toContain(ledger)
          expect(text, `${where}: no shell command text`).not.toContain(SECRET)
          expect(text, `${where}: no epoch-sized duration`).not.toMatch(/\d{3,}d /)
          expect(text, `${where}: no box glyphs`).not.toMatch(/[━╸─│╭╮╰╯█▓▒░]/)
          expect(text, `${where}: no unknown placeholder`).not.toMatch(/\bunknown\b/)
          expect(widestRow(tree), `${where}: fixed cells within the body`).toBeLessThanOrEqual(cols - 2)
          for (const s of svgs(tree)) {
            expect(s.alt.length, `${where}: svg alt`).toBeGreaterThan(0)
            expect(s.source.startsWith('<svg'), `${where}: svg source`).toBe(true)
            expect(s.source.length, `${where}: svg size`).toBeLessThanOrEqual(131072)
          }
          const tabs = buttons(tree).filter(b => b.key.startsWith('tab:'))
          // the hotkey once: the desktop draws its own badge for `hotkey`; neither the label nor the text carries a digit
          expect(tabs.map(b => b.label), `${where}: the tab bar, each once, the plain name as the label`).toEqual(['Agents', 'Overview', 'Tokens', 'Context', 'Tools', 'Flow', 'Live'])
          for (const b of tabs) expect(b.texts.join(''), `${where}: no digit drawn on the tab`).not.toMatch(/\d/)
          expect(tabs.map(b => b.texts.join('')).filter(t => t.length > 0), `${where}: seven tabs drawn`).toHaveLength(7)
          const shown = tabs.find(b => b.key === `tab:${tab}`)
          expect(shown?.colors, `${where}: the shown tab in the accent`).toContain('claude')
          expect(texts(tree).some(t => /^up /.test(t)), `${where}: the uptime`).toBe(true)
          expect(text, `${where}: the four tiles`).toMatch(/COST[\s\S]*TOKENS[\s\S]*BURN[\s\S]*CONTEXT/)
          expect(text, `${where}: the ledger is not the headline tile`).not.toMatch(/COST\n\$1200\.00/)
        }
        await ui.unmount()
      }
    }
  }
})

test('the agents tab is the default and the estimated rows never exceed the body', () => {
  const T = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as unknown as T4
  expect(UI_INITIAL.tab).toBe('agents')
  for (const which of ['empty', 'populated', 'ledgerGap', 'plans'] as const) {
    const s = which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : which === 'plans' ? withPlans() : ledgerGap()
    const o = deriveOverview(s, NOW)
    for (const [cols, rows] of [...SIZES, [40, 12], [36, 10]] as const) {
      const layout = layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'desktop')
      for (const tab of TABS) {
        for (const agentId of [null, 'a3', 'a2']) {
         // the drawers: none, the focused row's, several; a drawer taller than the body is windowed by its lines, so the estimate always holds
         for (const expandedAgents of [[], agentId === null ? [] : [agentId], ['main', 'a1', 'a2', 'a3']]) {
          const frame = deskTree(T, { s, ui: { tab, agentId, scroll: {}, expandedAgents }, now: NOW, layout }, o, () => undefined)
          // the Agents tab always (a drawer is windowed by its lines); elsewhere one item alone may be taller than a tiny pane's room
          if (tab === 'agents' || frame.shown > 1 || rows >= 24) expect(frame.usedRows, `${which} ${cols}x${rows} ${tab} ${agentId} open ${expandedAgents.join(',')}: rows`).toBeLessThanOrEqual(rows)
          expect(frame.shown, `${which} ${cols}x${rows} ${tab}: something shown`).toBeGreaterThanOrEqual(frame.total === 0 ? 0 : 1)
          const tree = frame.tree as unknown as Node
          expect(tree.type).toBe('Box')
         }
        }
      }
    }
  }
})

test('agents: the table, the running row\'s phase line, a click opens the drawer, the pager moves the selection', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(44, 24, 'desktop'))
  const first = await ui.drawn()
  const text = texts(first).join('\n')
  expect(text).toContain('1 running')
  expect(text).toContain('1 done')
  expect(text).toContain('1 failed')
  expect(text).toContain('main session')
  expect(text).toContain('draft the plan')
  expect(text).toContain('nested check')
  // main runs a Bash call: its phase line names the tool and the time in it
  expect(text).toContain('▸ Bash')
  expect(text).toContain('7s')
  // the running subagent has no tool of its own in flight: a model request
  expect(text).toContain('▸ model request · Haiku 5.5')
  // no drawer until a row is selected; the lanes strip is there
  expect(text).not.toContain('context peak')
  expect(svgs(first).some(s => s.alt.includes('agent lanes'))).toBe(true)
  expect(text).not.toContain('20752')
  // the main row's elapsed is the uptime since the mod first saw the session
  expect(text).toContain('10m 00s')
  // the ledger's remainder is the Overview's footnote: no orphan line under the table
  expect(text).not.toContain('$1199.37')
  expect(text).not.toContain('untracked')
  // the cost tile reads tracked over `of ledger`
  expect(text).toMatch(/COST\n\$0\.63\nof \$1200\.00/)

  await ui.press({ key: 'agent:a2' })
  const after = texts(await ui.drawn()).join('\n')
  expect(after).toContain('general-purpose · Haiku 5.5 · in Explore')
  expect(after).toContain('in 1k · out 5k · cache r 80k · w 8k')
  expect(after).toContain('Read 8 · Grep 4')
  expect(after).toContain('context peak')
  const selected = buttons(await ui.drawn()).find(b => b.key === 'agent:a2')
  expect(selected?.colors).toContain('claude')

  // the pager row: the down arrow moves the selection on
  await ui.press({ key: 'agents:down' })
  const moved = buttons(await ui.drawn()).filter(b => b.colors.includes('claude') && b.key.startsWith('agent:'))
  expect(moved).toHaveLength(1)
  expect(moved[0]?.key).not.toBe('agent:a2')
  await ui.unmount()
})

test('agents: a loop with no model and no usage folds into one other line', async ($, on) => {
  mock.clock(on, { now: NOW })
  const s = populated()
  const ghost = s.agents.byId.a1
  if (ghost) {
    s.agents.byId.ghost = { ...ghost, id: 'ghost', type: 'unknown', description: '', model: null, models: [], status: 'unknown', usage: { ...ghost.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0 }, toolCalls: 0, byTool: {}, byModel: {} }
    s.agents.order.push('ghost')
  }
  seed(on, s)
  const ui = await $.ui.mount(pane(64, 40, 'desktop'))
  const text = texts(await ui.drawn()).join('\n')
  expect(text).toContain('+1 unattributed')
  expect(text).not.toMatch(/\bunknown\b/)
  await ui.unmount()
})

test('agents: ghosts fold or go stale; a quiet run is not counted running and has no phase line', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withGhosts(populated()))
  const ui = await $.ui.mount(pane(64, 40, 'desktop'))
  const tree = await ui.drawn()
  const text = texts(tree).join('\n')
  // the two loops with nothing to show are folded, never rows, never `unknown`
  expect(text).toContain('+2 unattributed')
  expect(text).not.toMatch(/\bunknown\b/)
  // the quiet Explore run is a stale row with its own line, not a running one
  expect(text).toContain('1 running')
  expect(text).toContain('· 1 stale')
  expect(text).toContain('long search that went')
  expect(text).toContain('◌ stale · no activity for 20m 00s')
  expect(text.split('▸ model request').length - 1).toBe(1)
  // its dot is the stale one; the header still counts one agent, not four
  expect(svgs(tree).some(s => s.alt === 'stale')).toBe(true)
  expect(text).toContain('· 1 agent\n')
  await ui.unmount()
})

test('agents: the done group shows the newest 8 with a show-all toggle kept in the ui state', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withManyDone(populated(), 21))
  const ui = await $.ui.mount(pane(64, 60, 'desktop'))
  let text = texts(await ui.drawn()).join('\n')
  // a1 (the newest end) and 21 more are done: the newest 8 roots show (a1, d21 down to d15), the rest fold behind the toggle
  expect(text).toContain('· 22 done')
  expect(text).toContain('find every caller')
  expect(text).toContain('done task 21')
  expect(text).toContain('done task 15')
  expect(text).not.toContain('done task 14')
  expect(text).toContain('+14 done · show all')
  await ui.press({ key: 'agents:all' })
  text = texts(await ui.drawn()).join('\n')
  expect(text).toContain('show recent only')
  // every done row is listed now (the pager windows them)
  const frame = deskTree({ Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as unknown as T4, { s: withManyDone(populated(), 21), ui: { tab: 'agents', agentId: null, scroll: {}, showAllAgents: true }, now: NOW, layout: layoutOf({ bodyColumns: 64, scroll: { bodyRows: 60 } }, { columns: 64, rows: 60 }, 'desktop') }, deriveOverview(withManyDone(populated(), 21), NOW), () => undefined)
  expect(frame.total).toBeGreaterThanOrEqual(25)
  await ui.press({ key: 'agents:all' })
  expect(texts(await ui.drawn()).join('\n')).toContain('+14 done · show all')
  await ui.unmount()
})

test('tokens: the models add up to the ledger with an untracked row; the mix has its legend', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(40, 30, 'desktop'))
  await ui.press({ key: 'tab:tokens' })
  const tree = await ui.drawn()
  const text = texts(tree).join('\n')
  expect(text).toContain('untracked · before load')
  expect(text).toContain('$1199.37')
  expect(text).toContain('total · ledger')
  expect(text).toContain('$1200.00')
  expect(text).toContain('cache read 1.1M')
  expect(svgs(tree).some(s => s.alt.startsWith('in '))).toBe(true)
  await ui.unmount()
})

test('overview: the cost card says tracked, ledger and untracked; the harness and the trends draw', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(48, 60, 'desktop'))
  await ui.press({ key: 'tab:overview' })
  const tree = await ui.drawn()
  const text = texts(tree).join('\n')
  expect(text).toContain('TRACKED THIS SESSION')
  expect(text).toContain('ledger $1200.00 · untracked $1199.37')
  expect(text).toContain('HARNESS')
  expect(text).toContain('messages')
  expect(text).toContain('re-sent per request')
  expect(text).toContain('TRENDS')
  expect(svgs(tree).filter(s => /values/.test(s.alt)).length).toBe(2)
  expect(svgs(tree).filter(s => / bar$/.test(s.alt)).length).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})

test('tools: Bash shows its name only; a URL loses its query', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  for (const [cols, rows] of [
    [40, 24],
    [120, 60],
  ] as const) {
    const ui = await $.ui.mount(pane(cols, rows, 'desktop'))
    await ui.press({ key: 'tab:tools' })
    let text = ''
    for (let i = 0; i < 14; i += 1) {
      text += `\n${texts(await ui.drawn()).join('\n')}`
      if (!(await ui.find({ type: 'Button', key: 'tools:down' }))) break
      await ui.press({ key: 'tools:down' })
    }
    expect(text).toContain('Bash')
    expect(text).not.toContain('API_KEY')
    expect(text).not.toContain('Authorization')
    expect(text).not.toContain('token=abc123')
    if (cols === 120) {
      expect(text).toContain('example.com/api/items')
      expect(text).toContain('linear:create_issue')
    }
    await ui.unmount()
  }
})

test('live: the now row names the running tool and moves with the clock', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, populated())
  const ui = await $.ui.mount(pane(40, 30, 'desktop'))
  await ui.press({ key: 'tab:live' })
  const text = texts(await ui.drawn()).join('\n')
  expect(text).toContain('tool running')
  expect(text).toContain('· Bash')
  expect(text).toContain('7s')
  expect(text).not.toContain(SECRET)
  expect(text).toContain('Opus 5.5')
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n')).toContain('8s')
  await ui.unmount()
})

test('context: the gauge, the grid beside the categories, and the refresh control asking for a full breakdown', async ($, on) => {
  mock.clock(on, { now: NOW })
  const asked: unknown[] = []
  const breakdown: SessionContextBreakdown = {
    categories: [
      { name: 'Messages', tokens: 2_000, color: 'permission', isDeferred: false, kind: 'used' },
      { name: 'Free space', tokens: 998_000, color: 'inactive', isDeferred: false, kind: 'free' },
    ],
    totalTokens: 2_000,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    autocompactSource: 'auto',
    percentage: 0.2,
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
  on('session.usage', (_, e) => {
    asked.push(e.breakdown)
    return { value: { startedAt: 0, context: { tokens: 2_000, window: 1_000_000, percent: 0.2, ...(e.breakdown ? { breakdown } : {}) }, rateLimits: [] } }
  })
  const ui = await $.ui.mount(pane(64, 40, 'desktop'))
  await ui.press({ key: 'tab:context' })
  expect(texts(await ui.drawn()).join('\n')).toContain('no breakdown yet')
  await ui.press({ key: 'refresh' })
  expect(asked).toContain('full')
  const tree = await ui.drawn()
  const text = texts(tree).join('\n')
  expect(text).toContain('Messages')
  expect(text).toContain('full breakdown · now')
  expect(svgs(tree).some(s => s.alt.startsWith('context grid'))).toBe(true)
  expect(svgs(tree).some(s => / full$/.test(s.alt))).toBe(true)
  await ui.unmount()
})

test('context: the populated grid draws the categories in their hues beside the rows', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  const wide = await $.ui.mount(pane(120, 50, 'vscode'))
  await wide.press({ key: 'tab:context' })
  const w = await wide.drawn()
  const grid = svgs(w).find(s => s.alt.startsWith('context grid'))
  expect(grid?.alt).toBe('context grid: 48 of 100 squares used')
  expect(grid?.source).toContain('#3b7dd8')
  expect(texts(w).join('\n')).toContain('MEMORY FILES')
  await wide.unmount()
})

test('the window: items by height, a pager when they do not fit, the selection kept inside', () => {
  const h = [1.5, 1.5, 6.5, 1.5, 1.5, 1, 1]
  const fits = windowItems(h, 20, 0)
  expect(fits).toEqual({ offset: 0, count: 7, maxOffset: 0, pager: false })
  const tight = windowItems(h, 6, 0)
  expect(tight.pager).toBe(true)
  // 6 rows less the pager's 1.5: the first two rows (3) fit, the drawer (6.5) does not
  expect(tight.count).toBe(2)
  // one item taller than the room still shows alone
  expect(windowItems(h, 6, 2).count).toBe(1)
  // the selection pulls the window down and up
  expect(windowItems(h, 6, 0, 4).offset).toBeGreaterThan(0)
  expect(windowItems(h, 6, 5, 0).offset).toBe(0)
  // a selection in the tail shows the tail whole
  const tail = windowItems(h, 6, 0, 6)
  expect(tail.offset).toBe(tail.maxOffset)
  expect(tail.offset + tail.count).toBe(7)
  // the offset never passes the last one that fits the tail
  expect(windowItems(h, 6, 99).offset).toBe(windowItems(h, 6, 99).maxOffset)
  expect(windowItems([], 6, 0)).toEqual({ offset: 0, count: 0, maxOffset: 0, pager: false })
  expect(windowItems(h, 0, 0).count).toBe(0)
})

test('the agent phase: a running tool, waiting on a subagent, or the model request since the last activity', () => {
  const s = populated()
  // main: its newest running call is Bash, 7 s ago
  expect(agentPhase(s, 'main', NOW)).toEqual({ kind: 'tool', text: 'Bash', sinceMs: 7000 })
  // a3 runs with no call of its own: a model request since its spawn (its last step is unknown)
  expect(agentPhase(s, 'a3', NOW)).toMatchObject({ kind: 'request', text: 'model request · Haiku 5.5' })
  // a finished agent has no phase, nor does a running loop that went quiet
  expect(agentPhase(s, 'a1', NOW)).toBeNull()
  expect(agentPhase(s, 'nobody', NOW)).toBeNull()
  expect(agentPhase(withGhosts(populated()), 'g3', NOW)).toBeNull()
  // an Agent call in flight: waiting
  s.tools.push({ id: 'call-agent', tool: 'Agent', server: null, agentId: 'a3', turnId: null, label: 'x', startedAt: NOW - 3000, endedAt: null, wallMs: null, execMs: null, status: 'running', resultChars: null, resultBytes: null, isReadOnly: false, isServerTool: false, error: null })
  expect(agentPhase(s, 'a3', NOW)).toEqual({ kind: 'waiting', text: 'waiting on a subagent', sinceMs: 3000 })
  // the phase never carries a tool's input
  s.tools.push({ id: 'call-bash-2', tool: 'Bash', server: null, agentId: 'a3', turnId: null, label: `rm ${SECRET}`, startedAt: NOW - 1000, endedAt: null, wallMs: null, execMs: null, status: 'running', resultChars: null, resultBytes: null, isReadOnly: false, isServerTool: false, error: null })
  expect(JSON.stringify(agentPhase(s, 'a3', NOW))).not.toContain(SECRET)
})

test('cell widths grow with the pane and the lanes strip stays inside a narrow one', () => {
  expect(cellWidths(40)).toEqual({ elapsed: 5, ctx: 5, cost: 7, tok: 0 })
  expect(elapsedText(600_000, true)).toBe('10m')
  expect(elapsedText(600_000, false)).toBe('10m 00s')
  expect(elapsedText(null, true)).toBe('–')
  expect(cellWidths(48).ctx).toBe(10)
  expect(cellWidths(64).tok).toBe(7)
  for (const cols of [24, 40, 48, 64, 120, 200]) {
    const w = laneWidth(cols)
    expect(w).toBeGreaterThanOrEqual(120)
    expect(w).toBeLessThanOrEqual(Math.max(120, cols * 6))
  }
})

