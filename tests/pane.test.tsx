// The pane's terminal path (hooks/ui/term/) through the engine's kit, the
// trees laid out as text by tests/term-render.ts (the desktop path has
// tests/desktop.test.tsx): every tab draws, empty and populated, at 40x24,
// 80x24 and 160x50, within the rows and columns it was given; the header's
// row and tiles; the Agents table with its lanes, phase lines, drawer, stale
// rows, the done cap and its toggle; the controls (tabs, rows, pager, refresh,
// /telemetry) act; a shell command's text never reaches the drawing; the 1 s
// tick runs while active; a ledger far above the tracked sum reconciles; a
// main loop first seen at 0 has no absurd duration.

import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import type { TelemetryState } from '../types'

import { deriveOverview } from '../hooks/derive'
import { emptyState } from '../hooks/model'
import { layoutOf } from '../hooks/ui/layout'
import { laneSegs, termCellWidths } from '../hooks/ui/term/agents'
import type { T3 } from '../hooks/ui/term/kit'
import { termTree } from '../hooks/ui/term/view'
import { TABS } from '../hooks/ui/ui-state'

import { ledgerGap, NOW, populated, SECRET, withGhosts, withManyDone } from './fixture'
import { withPlans } from './plans-fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'

const SIZES = [
  [40, 24],
  [80, 24],
  [160, 50],
] as const

const pane = (cols: number, rows: number) =>
  ({
    plugin: 'session-telemetry',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

/** Answers the telemetry atoms from `s` (the pane's own `ui` value is left to the kit's store). */
function seed(on: On, s: TelemetryState): void {
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: 1 } }
  })
}

const width = (s: string): number => Array.from(s).length

/** The frame's rows, trailing spaces trimmed. */
const rowsOf = (tree: unknown, cols: number): string[] => trimmed(renderText(tree, cols))

/** The tab bar's row: the first that starts with the first tab's hotkey hint. */
const tabRow = (lines: string[]): number => lines.findIndex(l => /^1: /.test(l))

test('every tab draws on the terminal, empty and populated, within its rows and columns', async ($, on) => {
  mock.clock(on, { now: NOW })
  let state: TelemetryState = emptyState(NOW - 1000)
  // the kit keeps a value by its version: a new fixture is a new version, or the old one would be redrawn
  let version = 1
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (state as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version } }
  })
  for (const which of ['empty', 'populated', 'ledgerGap'] as const) {
    state = which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : ledgerGap()
    version += 1
    // the headline is the tracked cost; the ledger sits beneath it in the cost tile
    const headline = which === 'empty' ? '$0.00' : which === 'populated' ? '$3.21' : '$0.63'
    const ledger = which === 'empty' ? 'estimate' : which === 'populated' ? '$2.80' : '$1200.00'
    for (const [cols, rows] of SIZES) {
      const ui = await $.ui.mount(pane(cols, rows))
      for (const tab of TABS) {
        await ui.press({ key: `tab:${tab}` })
        const tree = await ui.drawn()
        const lines = rowsOf(tree, cols)
        const where = `${which} ${cols}x${rows} ${tab}`
        expect(lines.length, `${where}: rows`).toBeLessThanOrEqual(rows)
        expect(lines.length, `${where}: header, tabs and content`).toBeGreaterThan(5)
        for (const line of lines) expect(width(line), `${where}: "${line}"`).toBeLessThanOrEqual(cols)
        // the renderer pads and cuts to the width by construction: the real check is that the fixed cells
        // of any row (a Text row's own text included) leave the growing cell at least four columns
        expect(fixedOverflow(tree, cols), `${where}: fixed cells within the body`).toBeLessThanOrEqual(0)
        const text = lines.join('\n')
        expect(text, `${where}: no shell command text`).not.toContain(SECRET)
        expect(text, `${where}: no epoch-sized duration`).not.toMatch(/\d{3,}d /)
        expect(text, `${where}: no unknown placeholder`).not.toMatch(/\bunknown\b/)
        const tabs = tabRow(lines)
        expect(tabs, `${where}: tab bar`).toBe(4)
        expect(lines[0], `${where}: the uptime`).toMatch(/up /)
        // the four tiles: labels, the tracked headline, the ledger beneath it, the context fill
        expect(lines[1], `${where}: the tile labels`).toMatch(/^COST\s+TOKENS\s+BURN\s+CONTEXT/)
        expect(lines[2], `${where}: the tracked headline`).toContain(headline)
        expect(lines[3], `${where}: the ledger beneath`).toContain(ledger)
        expect(lines[2], `${where}: the context fill`).toMatch(/(━|─).* (\d+%|–)$/)
        expect(lines[2], `${where}: the burn`).toMatch(/\/min|–/)
        expect(lines[tabs], `${where}: the hotkeys once`).toMatch(/^1: \S+ +2: \S+ +3: \S+ +4: \S+ +5: \S+ +6: \S+ +7: \S+$/)
        const shown = await ui.find({ type: 'Button', key: `tab:${tab}` })
        expect(JSON.stringify(shown?.children), `${where}: shown tab in the accent`).toContain('"claude"')
      }
      await ui.unmount()
    }
  }
})

test('the header: model, state, uptime on row one; the four tiles beneath; the tab bar in full at 80 columns', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  const ui = await $.ui.mount(pane(80, 24))
  const lines = rowsOf(await ui.drawn(), 80)
  const [l1 = '', l2 = '', l3 = '', l4 = '', l5 = ''] = lines
  expect(l1).toMatch(/^Opus 5\.5 · ◐ live · 1 agent ▶ +up 1h 00m$/)
  expect(l2).toMatch(/^COST\s+TOKENS\s+BURN\s+CONTEXT$/)
  expect(l3).toMatch(/^\$3\.21\s+1\.24M\s+\$0\.10\/min\s+━+╸?─+ 45%$/)
  expect(l4).toMatch(/^ledger \$2\.80\s+92% cached\s+5m window\s+of 1M$/)
  expect(l5).toBe('1: Agents  2: Overview  3: Tokens  4: Context  5: Tools  6: Flow  7: Live')
  await ui.unmount()
})

test('at 40x24 the header is four rows, the cost tile reads tracked over the ledger, the tabs stay on one row', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(40, 24))
  await ui.press({ key: 'tab:overview' })
  const lines = rowsOf(await ui.drawn(), 40)
  expect(lines[0]).toContain('Opus 5.5')
  expect(lines[0]).toContain('up 10m 00s')
  expect(lines[2]).toMatch(/^\$0\.63 /)
  expect(lines[3]).toMatch(/^\$1200\.00 /)
  expect(lines[2]).toMatch(/\$0\.02\/min/)
  expect(lines[2]).toMatch(/45%$/)
  expect(lines[4]).toContain('2: O')
  expect(lines[4]).toMatch(/7: (Lv|V)$/)
  expect(width(lines[4] ?? '')).toBeLessThanOrEqual(40)
  expect(lines.length).toBeLessThanOrEqual(24)
  // the cost card: tracked over the ledger and its untracked remainder, once each
  const text = lines.join('\n')
  expect(text).toMatch(/│ TRACKED THIS SESSION/)
  expect(text).toMatch(/│ \$0\.63 /)
  expect(text).toContain('ledger $1200.00 · untracked $1199.37')
  expect(text.split('$1200.00').length - 1).toBe(2)
  await ui.unmount()
})

test('a narrow pane compresses and never draws rows past its room; the dock floor keeps all seven tabs', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  for (const [cols, rows] of [
    [40, 10],
    [30, 6],
    [24, 4],
  ] as const) {
    const ui = await $.ui.mount(pane(cols, rows))
    for (const tab of TABS) {
      await ui.press({ key: `tab:${tab}` })
      const lines = rowsOf(await ui.drawn(), cols)
      expect(lines.length, `${cols}x${rows} ${tab}: rows`).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(width(line), `${cols}x${rows} ${tab}: "${line}"`).toBeLessThanOrEqual(cols)
      // under 14 rows the header is two rows: the tiles give way to one compact stats row
      expect(lines[1], `${cols}x${rows} ${tab}: compact header`).toMatch(/\d+%|–/)
      const tabs = await ui.find({ type: 'Button', key: `tab:${tab}` })
      expect(tabs, `${cols}x${rows} ${tab}: the shown tab is drawn`).toBeDefined()
    }
    await ui.unmount()
  }
})

test('agents: the strip, the lanes, the table with phase lines; a click opens the drawer; the pager moves the selection', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(80, 24))
  const first = rowsOf(await ui.drawn(), 80)
  const text = first.join('\n')
  expect(first[5]).toMatch(/^ Tree  \| Workflows  w: switch +\[search\]$/)
  // the chips, and at the right the drawers' control (a running row is closed)
  expect(first[6]).toMatch(/^f: all 3 · running 1 · done 1 · failed 1 · stale 0 +e: expand running$/)
  expect(first[7]).toMatch(/^▶ 1 running · 1 done · 1 failed +\$0\.02\/min$/)
  // the lanes: one row per subagent, the running one lit to the edge, then the axis
  expect(first[8]).toMatch(/^draft the plan ━+▶$/)
  expect(first[9]).toMatch(/^nested check +━+─*$/)
  expect(first[11]).toMatch(/^ +last 10m 00s +now$/)
  // the table: head, main pinned, its phase line, the tree guides
  expect(first[12]).toMatch(/^  agent +tokens elapsed +ctx +cost$/)
  expect(first[13]).toMatch(/^▶ ▸ main session +999k +10m 00s ━+╸?─* 45% +\$0\.49$/)
  expect(first[14]).toBe('  ▸ Bash · 7s')
  expect(first[15]).toMatch(/^▶ ├ ▸ draft the plan +94k 10m 00s /)
  expect(first[16]).toBe('  ▸ model request · Haiku 5.5 · 10m 00s')
  expect(first[17]).toMatch(/^✗   └ ▸ nested check /)
  expect(first[18]).toMatch(/^✓ └ ▸ find every caller of the pricing tab… /)
  expect(text).not.toContain('20752')
  expect(text).not.toContain('untracked')
  // select the nested one by click: its name inverts, the drawer opens under it
  await ui.press({ key: 'agent:a2' })
  const row = await ui.find({ type: 'Button', key: 'agent:a2' })
  expect(JSON.stringify(row?.children)).toContain('"inverse":true')
  const after = rowsOf(await ui.drawn(), 80)
  const at = after.findIndex(l => /^✗   └ ▾ nested check /.test(l))
  expect(after[at + 1]).toMatch(/^╭─+╮$/)
  expect(after[at + 2]).toMatch(/^│ general-purpose · Haiku 5.5 · in Explore +│$/)
  expect(after[at + 3]).toMatch(/^│ [█▓▒░]+ +in 1k · out 5k · cache r 80k · w 8k +│$/)
  expect(after[at + 4]).toMatch(/^│ tools Read 8 · Grep 4 +│$/)
  expect(after[at + 5]).toMatch(/^│ ctx peak 42k · 10 req · 12 tools · 2 err · 9m 00s +│$/)
  expect(after[at + 6]).toMatch(/^╰─+╯$/)
  await ui.unmount()

  // short: the drawer does not fit with the rest, so the pager appears, and its down arrow moves the selection on
  const short = await $.ui.mount(pane(80, 14))
  await short.press({ key: 'agent:a2' })
  expect(await short.find({ type: 'Button', key: 'agents:down' })).toBeDefined()
  await short.press({ key: 'agents:down' })
  const sel = await short.find({ type: 'Button', key: 'agent:a1' })
  expect(JSON.stringify(sel?.children)).toContain('"inverse":true')
  expect(rowsOf(await short.drawn(), 80).length).toBeLessThanOrEqual(14)
  await short.unmount()

  // wide: the full description, the main drawer's tools
  const wide = await $.ui.mount(pane(160, 50))
  await wide.press({ key: 'agent:main' })
  const w = rowsOf(await wide.drawn(), 160).join('\n')
  expect(w).toContain('find every caller of the pricing table across the repository')
  expect(w).toContain('tools Bash 31 · Read 30 · Edit 12 · Agent 3 · linear:create_issue 2')
  expect(w).toContain('main loop · Opus 5.5')
  await wide.unmount()
})

test('agents: ghosts fold or go stale; a quiet run is a stale row with its own line, not counted running', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withGhosts(populated()))
  const ui = await $.ui.mount(pane(80, 24))
  const lines = rowsOf(await ui.drawn(), 80)
  const text = lines.join('\n')
  expect(lines[0]).toContain('· 1 agent ▶')
  expect(lines[5]).toMatch(/^ Tree  \| Workflows/)
  expect(lines[6]).toMatch(/^f: all 4 · running 1 · done 1 · failed 1 · stale 1 +e: expand running$/)
  expect(lines[7]).toMatch(/^▶ 1 running · 1 done · 1 failed · 1 stale /)
  const stale = lines.findIndex(l => /^◌ ├ ▸ long search that went quiet /.test(l))
  expect(stale).toBeGreaterThan(10)
  expect(lines[stale + 1]).toBe('  ◌ stale · no activity for 20m 00s')
  expect(text.split('▸ model request').length - 1).toBe(1)
  expect(text).toContain('+2 unattributed (no spawn seen, no usage)')
  expect(text).not.toMatch(/\bunknown\b/)
  await ui.unmount()
})

test('agents: the done group shows the newest 8 with a show-all toggle kept in the ui state', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withManyDone(populated(), 21))
  const ui = await $.ui.mount(pane(80, 40))
  let text = rowsOf(await ui.drawn(), 80).join('\n')
  expect(text).toContain('· 22 done')
  expect(text).toContain('done task 21')
  expect(text).toContain('done task 15')
  expect(text).not.toContain('done task 14')
  expect(text).toContain('+14 done · show all')
  await ui.press({ key: 'agents:all' })
  text = rowsOf(await ui.drawn(), 80).join('\n')
  expect(text).toContain('done task 14')
  for (let i = 0; i < 30 && (await ui.find({ type: 'Button', key: 'agents:down' })); i += 1) await ui.press({ key: 'agents:down' })
  text = rowsOf(await ui.drawn(), 80).join('\n')
  expect(text).toContain('done task 1 ')
  expect(text).toContain('show recent only')
  await ui.press({ key: 'agents:all' })
  expect(rowsOf(await ui.drawn(), 80).join('\n')).toContain('+14 done · show all')
  await ui.unmount()
})

test('the frame never takes more rows than the body, for every tab, fixture, size, selection and open drawers', { timeoutMs: 60_000 }, () => {
  const T = { Box: 'Box', Text: 'Text', Button: 'Button' } as unknown as T3
  for (const which of ['empty', 'populated', 'ledgerGap', 'ghosts', 'manyDone', 'plans'] as const) {
    const s = which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : which === 'ledgerGap' ? ledgerGap() : which === 'ghosts' ? withGhosts(populated()) : which === 'plans' ? withPlans(withGhosts(populated())) : withManyDone(populated(), 21)
    const o = deriveOverview(s, NOW)
    for (const [cols, rows] of [...SIZES, [48, 24], [40, 10], [30, 6], [24, 4], [120, 40]] as const) {
      const layout = layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'terminal')
      for (const tab of TABS) {
        for (const agentId of [null, 'a3', 'a2', 'g3']) {
          for (const showAllAgents of [false, true]) {
           // the drawers: none, the focused row's, several (a click opens one; the focus alone opens none)
           for (const expandedAgents of [[], agentId === null ? [] : [agentId], ['main', 'a1', 'a2', 'a3', 'g3']]) {
            const frame = termTree(T, { s, ui: { tab, agentId, scroll: {}, showAllAgents, expandedAgents }, now: NOW, layout }, o, () => undefined)
            const where = `${which} ${cols}x${rows} ${tab} ${agentId} ${showAllAgents} open ${expandedAgents.join(',')}`
            // one item always shows, even where it alone (a selected row with its drawer) is taller than a tiny pane's room
            expect(frame.shown, `${where}: something shown`).toBeGreaterThanOrEqual(frame.total === 0 ? 0 : 1)
            // the body Box is as tall as its room and clips: the drawn tree is never taller than the body
            const lines = renderText(frame.tree, cols)
            expect(lines.length, `${where}: drawn rows`).toBeLessThanOrEqual(rows)
            expect(frame.usedRows, `${where}: rows counted`).toBeLessThanOrEqual(rows)
            expect(fixedOverflow(frame.tree, cols), `${where}: fixed cells within the body`).toBeLessThanOrEqual(0)
           }
          }
        }
      }
    }
  }
})

test('lanes and cells: a lane lights from start to end or to the edge while running; the cells grow with the pane', () => {
  const lit = (segs: { t: string }[]): string => segs.map(s => s.t).join('')
  expect(lit(laneSegs({ start: 0, end: 50, status: 'completed' }, 0, 100, 10))).toBe('━━━━━─────')
  expect(lit(laneSegs({ start: 50, end: null, status: 'running' }, 0, 100, 10))).toBe('─────━━━━▶')
  expect(lit(laneSegs({ start: 20, end: 21, status: 'error' }, 0, 100, 10))).toBe('──━───────')
  expect(laneSegs({ start: 20, end: 21, status: 'error' }, 0, 100, 10).find(s => s.t === '━')?.c).toBe('error')
  expect(laneSegs({ start: 0, end: 50, status: 'stale' }, 0, 100, 10)[0]?.c).toBe('warning')
  // before the window: clipped to its edge
  expect(lit(laneSegs({ start: -50, end: 10, status: 'completed' }, 0, 100, 10))).toBe('━─────────')
  expect(termCellWidths(40)).toEqual({ tok: 0, elapsed: 5, ctx: 4, cost: 6 })
  expect(termCellWidths(80)).toEqual({ tok: 6, elapsed: 7, ctx: 12, cost: 8 })
  expect(termCellWidths(160).ctx).toBe(16)
})

test('tokens: the models add up to the ledger with an untracked row', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  const ui = await $.ui.mount(pane(40, 24))
  await ui.press({ key: 'tab:tokens' })
  const text = rowsOf(await ui.drawn(), 40).join('\n')
  expect(text).toContain('untracked / before load')
  expect(text).toContain('$1199.37')
  expect(text).toMatch(/total\s+\$1200\.00 ledger/)
  await ui.unmount()
})

test('tools: Bash shows its name only; a URL loses its query', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  for (const [cols, rows] of [
    [40, 24],
    [160, 50],
  ] as const) {
    const ui = await $.ui.mount(pane(cols, rows))
    await ui.press({ key: 'tab:tools' })
    for (let i = 0; i < 12 && (await ui.find({ type: 'Button', key: 'tools:down' })); i += 1) await ui.press({ key: 'tools:down' })
    const text = rowsOf(await ui.drawn(), cols).join('\n')
    expect(text).toContain('Bash')
    expect(text).not.toContain('API_KEY')
    expect(text).not.toContain('Authorization')
    expect(text).not.toContain('token=abc123')
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane(160, 50))
  await ui.press({ key: 'tab:tools' })
  const text = rowsOf(await ui.drawn(), 160).join('\n')
  expect(text).toContain('example.com/api/items')
  expect(text).toContain('linear:create_issue')
  await ui.unmount()
})

test('live: the now line names the running tool and its elapsed time; the log holds requests, spawns and turns', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, populated())
  const ui = await $.ui.mount(pane(40, 24))
  await ui.press({ key: 'tab:live' })
  const lines = rowsOf(await ui.drawn(), 40)
  const text = lines.join('\n')
  const nowLine = lines.find(l => l.startsWith('now ')) ?? ''
  expect(nowLine).toContain('tool running')
  expect(nowLine).toContain('Bash')
  expect(nowLine).toContain('7s')
  expect(text).not.toContain(SECRET)
  expect(text).toContain('Opus 5.5')
  expect(text).toMatch(/\$0\.\d+/)
  // the ages move with the clock even with nothing else written
  await clock.advance(1000)
  const later = rowsOf(await ui.drawn(), 40).find(l => l.startsWith('now ')) ?? ''
  expect(later).toContain('8s')
  await ui.unmount()

  const wide = await $.ui.mount(pane(160, 50))
  await wide.press({ key: 'tab:live' })
  const w = rowsOf(await wide.drawn(), 160).join('\n')
  expect(w).toContain('Explore spawned')
  expect(w).toContain('turn 6 started')
  expect(w).toContain('turn 5 answered')
  for (let i = 0; i < 40 && (await wide.find({ type: 'Button', key: 'live:down' })); i += 1) await wide.press({ key: 'live:down' })
  expect(rowsOf(await wide.drawn(), 160).join('\n')).toContain('compaction 790k → 60k')
  await wide.unmount()
})

test('overview: the cost card, then the harness block saying what feeds the context and what the last request re-sent', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  const ui = await $.ui.mount(pane(40, 24))
  await ui.press({ key: 'tab:overview' })
  const first = rowsOf(await ui.drawn(), 40).join('\n')
  expect(first).toContain('TRACKED THIS SESSION')
  expect(first).toMatch(/│ \$3\.21 +│/)
  expect(first).toContain('ledger $2.80')
  expect(first).toContain('estimate +15% over the ledger')
  for (let i = 0; i < 20; i += 1) await ui.press({ key: 'overview:down' })
  const text = rowsOf(await ui.drawn(), 40).join('\n')
  expect(text).toContain('── harness')
  expect(text).toContain('fixed')
  expect(text).toContain('messages')
  expect(text).toContain('re-sent')
  await ui.unmount()
})

test('context: the refresh control asks for a full breakdown', async ($, on) => {
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
  const ui = await $.ui.mount(pane(120, 40))
  await ui.press({ key: 'tab:context' })
  expect(rowsOf(await ui.drawn(), 120).join('\n')).toContain('no breakdown yet')
  await ui.press({ key: 'refresh' })
  expect(asked).toContain('full')
  const after = rowsOf(await ui.drawn(), 120).join('\n')
  expect(after).toContain('Messages')
  expect(after).toContain('full · now')
  await ui.unmount()
})

test('/telemetry opens the pane with the keyboard; `full` also asks for a full breakdown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const opened: unknown[] = []
  const asked: unknown[] = []
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('session.usage', (_, e) => {
    asked.push(e.breakdown)
    return { value: { startedAt: 0, context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }
  })
  const plain = await $.command.run({ command: 'telemetry', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(plain.text).toBe('Telemetry pane opened.')
  expect(opened[0]).toMatchObject({ id: 'session-telemetry', title: 'Telemetry', focus: true })
  const full = await $.command.run({ command: 'telemetry', args: 'full', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(full.text).toContain('full context breakdown')
  await clock.advance(0)
  expect(asked).toContain('full')
})

test('session start registers /telemetry and opens the pane unasked', async ($, on) => {
  mock.clock(on, { now: NOW })
  const registered: unknown[] = []
  const opened: unknown[] = []
  on('command.register', (_, e) => {
    registered.push(e)
    return { value: { command: 'telemetry' } }
  })
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: false, reason: 'narrow' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered[0]).toMatchObject({ name: 'telemetry' })
  expect(opened[0]).toMatchObject({ id: 'session-telemetry' })
  expect((opened[0] as { focus?: boolean }).focus).toBeUndefined()
})

test('while a turn runs, a 1 s tick redraws the elapsed figures', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, populated())
  const ui = await $.ui.mount(pane(160, 50))
  const before = rowsOf(await ui.drawn(), 160)[0] ?? ''
  expect(before).toContain('live')
  await clock.advance(1000)
  const after = rowsOf(await ui.drawn(), 160)[0] ?? ''
  expect(after).not.toBe(before)
  await ui.unmount()
})

test('idle, no tick is armed and the drawing stays as it was; ghosts alone never keep it live', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = withGhosts(populated())
  s.meta.activeTurns = { g1: 'turn-g1', g2: 'turn-g2', g3: 'turn-g3' }
  for (const id of ['main', 'a1', 'a2', 'a3']) {
    const a = s.agents.byId[id]
    if (a) a.status = 'completed'
  }
  s.tools = s.tools.map(t => ({ ...t, status: t.status === 'running' ? 'ok' : t.status }))
  seed(on, s)
  const ui = await $.ui.mount(pane(160, 50))
  const first = rowsOf(await ui.drawn(), 160)[0] ?? ''
  expect(first).toContain('idle')
  expect(first).toContain('up 1h 00m')
  // a redraw a minute on would read `up 1h 01m`
  await clock.advance(61_000)
  expect(rowsOf(await ui.drawn(), 160)[0]).toBe(first)
  await ui.unmount()
})
