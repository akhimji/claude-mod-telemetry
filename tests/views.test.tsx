// The insights views (hooks/ui/insights-view.ts and the tabs that draw it)
// through the engine's kit on the terminal and the desktop, at 40, 48, 80 and
// 120 cells, for the empty, populated, with-alerts and with-bloat fixtures:
// every tab draws within its rows and width with no secret, `unknown` or
// epoch artefact; the Overview's alerts block (active alerts, the rules, an
// ack Button that writes the alerts atom) and cache card (state, countdown
// with its ring or bar, ticking while the pane shows it idle); the Context
// tab's bloat audit (rows by waste, the summary, the hint, the footnote, the
// run-full-breakdown control); the Live tab's alert rows; the header's alert
// chip; the Agents tab's Tree | Workflows toggle, filter chips, search field
// and workflow cards, kept in the ui state.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TelemetryState, TelemetryUi } from '../types'

import { deriveOverview } from '../hooks/derive'
import { emptyState } from '../hooks/model'
import type { T4 } from '../hooks/ui/desktop/kit'
import { deskTree } from '../hooks/ui/desktop/view'
import { agentControls, alertBlock, bloatView, cacheCard, rulesLine, workflowCards } from '../hooks/ui/insights-view'
import { layoutOf } from '../hooks/ui/layout'
import type { T3 } from '../hooks/ui/term/kit'
import { termTree } from '../hooks/ui/term/view'
import { TABS } from '../hooks/ui/ui-state'
import { deriveAgents } from '../hooks/derive'
import { DEFAULT_ALERT_RULES } from '../hooks/insights'

import { ledgerGap, NOW, populated, SECRET } from './fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'
import { alertsLog, withAlerts, withBloat } from './views-fixture'

const SIZES = [
  [40, 24],
  [48, 30],
  [80, 40],
  [120, 50],
] as const

type Surface = 'terminal' | 'desktop' | 'vscode'

const pane = (cols: number, rows: number, surface: Surface) =>
  ({
    plugin: 'session-telemetry',
    surface,
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

type Seeded = { s: TelemetryState; alerts?: unknown; version: number }

/** Answers the telemetry atoms (and the alerts when given) from the box, which a test may swap (bump `version` so the kit redraws). */
function seed(on: On, s: TelemetryState, alerts?: unknown): Seeded {
  const box: Seeded = alerts === undefined ? { s, version: 1 } : { s, alerts, version: 1 }
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    if (e.key === 'alerts') return box.alerts === undefined ? next(e) : { value: { value: { shape: 'v1', value: box.alerts }, version: box.version } }
    const value = (box.s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: box.version } }
  })
  return box
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

function texts(tree: unknown): string[] {
  const out: string[] = []
  walk(tree, n => {
    if (n.type !== 'Text') return
    const own = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
    if (own.trim() !== '') out.push(own)
  })
  return out
}

function widestRow(tree: unknown): number {
  let widest = 0
  walk(tree, n => {
    if (n.type !== 'Box' || n.props?.flexDirection !== 'row') return
    let sum = 0
    for (const c of n.children ?? []) {
      const child = c as Node
      const w = child?.props?.width
      if (child?.type === 'Box' && typeof w === 'number') sum += w
    }
    widest = Math.max(widest, sum)
  })
  return widest
}

function svgs(tree: unknown): { alt: string; source: string }[] {
  const out: { alt: string; source: string }[] = []
  walk(tree, n => {
    if (n.type === 'Svg') out.push({ alt: String(n.props?.alt ?? ''), source: String(n.props?.source ?? '') })
  })
  return out
}

const FIXTURES = ['empty', 'populated', 'alerts', 'bloat'] as const
const make = (which: (typeof FIXTURES)[number]): TelemetryState => (which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : which === 'alerts' ? withAlerts() : withBloat())

type Mounted = { drawn: () => Promise<unknown>; find: (q: { type: string; key: string }) => Promise<unknown>; press: (q: { key: string }) => Promise<unknown> }

/** The drawn tree as text: the terminal's rows, or the desktop's Text runs. */
const textOf = (tree: unknown, cols: number, surface: Surface): string => (surface === 'terminal' ? trimmed(renderText(tree, cols)).join('\n') : texts(tree).join('\n'))

/** A tab's whole text, the pager walked to its end. */
async function allText(ui: Mounted, tab: string, cols: number, surface: Surface): Promise<string> {
  let text = ''
  for (let i = 0; i < 40; i += 1) {
    text += `\n${textOf(await ui.drawn(), cols, surface)}`
    if (!(await ui.find({ type: 'Button', key: `${tab}:down` }))) break
    await ui.press({ key: `${tab}:down` })
  }
  return text
}

for (const which of FIXTURES) {
  test(`every tab draws for the ${which} fixture on both paths at every size, within its rows and width, with no artefact`, async ($, on) => {
    mock.clock(on, { now: NOW })
    seed(on, make(which), which === 'alerts' ? alertsLog() : undefined)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const [cols, rows] of SIZES) {
        const ui = await $.ui.mount(pane(cols, rows, surface))
        for (const tab of TABS) {
          await ui.press({ key: `tab:${tab}` })
          const tree = await ui.drawn()
          const where = `${which} ${surface} ${cols}x${rows} ${tab}`
          if (surface === 'terminal') {
            const lines = trimmed(renderText(tree, cols))
            expect(lines.length, `${where}: rows`).toBeLessThanOrEqual(rows)
            for (const line of lines) expect(Array.from(line).length, `${where}: "${line}"`).toBeLessThanOrEqual(cols)
            expect(fixedOverflow(tree, cols), `${where}: fixed cells`).toBeLessThanOrEqual(0)
          } else {
            expect(widestRow(tree), `${where}: fixed cells within the body`).toBeLessThanOrEqual(cols - 2)
            for (const s of svgs(tree)) expect(s.alt.length, `${where}: svg alt`).toBeGreaterThan(0)
          }
          const text = textOf(tree, cols, surface)
          expect(text, `${where}: no shell command text`).not.toContain(SECRET)
          expect(text, `${where}: no epoch-sized duration`).not.toMatch(/\d{3,}d /)
          expect(text, `${where}: no unknown placeholder`).not.toMatch(/\bunknown\b/)
          if (surface !== 'terminal') expect(text, `${where}: no box glyphs`).not.toMatch(/[━╸─│╭╮╰╯█▓▒░]/)
          if (which === 'alerts' && tab === 'agents') expect(text, `${where}: the header's alert chip`).toContain('! 1')
          if (which !== 'alerts' && tab === 'agents') expect(text, `${where}: no alert chip`).not.toMatch(/(^|\n)! 1/)
        }
        await ui.unmount()
      }
    }
  })
}

test('the frames never take more rows than the body with the new blocks, in both agent views, for every fixture', () => {
  const T4 = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg', Input: 'Input' } as unknown as T4
  const T3 = { Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input' } as unknown as T3
  for (const which of FIXTURES) {
    const s = make(which)
    const o = deriveOverview(s, NOW)
    for (const [cols, rows] of [...SIZES, [40, 12], [36, 10]] as const) {
      for (const tab of TABS) {
        for (const agentsMode of ['tree', 'workflows'] as const) {
          for (const agentId of [null, 'a3']) {
            const ui: TelemetryUi = { tab, agentId, scroll: {}, agentsMode, expandedWorkflows: ['root:a1', 'root:a3'] }
            const desk = deskTree(T4, { s, ui, now: NOW, layout: layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'desktop') }, o, () => undefined)
            if (desk.shown > 1 || rows >= 24) expect(desk.usedRows, `desktop ${which} ${cols}x${rows} ${tab} ${agentsMode} ${agentId}: rows`).toBeLessThanOrEqual(rows)
            const term = termTree(T3, { s, ui, now: NOW, layout: layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'terminal') }, o, () => undefined)
            expect(term.usedRows, `terminal ${which} ${cols}x${rows} ${tab} ${agentsMode} ${agentId}: rows`).toBeLessThanOrEqual(rows)
            expect(trimmed(renderText(term.tree, cols)).length, `terminal ${which} ${cols}x${rows} ${tab} ${agentsMode}: drawn rows`).toBeLessThanOrEqual(rows)
          }
        }
      }
    }
  }
})

test('overview: the alerts block leads with the active condition, its age, the rules and an ack that writes the atom; the cache card follows the cost card', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withAlerts(), alertsLog())
  const writes: unknown[] = []
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry' && e.key === 'alerts') writes.push(e.value)
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(80, 40, surface))
    await ui.press({ key: 'tab:overview' })
    const tree = await ui.drawn()
    const text = textOf(tree, 80, surface)
    const at = (s: string): number => text.indexOf(s)
    expect(text, surface).toMatch(/ALERTS|── alerts/)
    expect(text, surface).toContain('Agent "long search that went quiet" has been quiet for 20m')
    expect(text, surface).toContain('10m ago')
    expect(text, surface).toContain('rules · ctx warn 70% · crit 90% · burn ×3')
    expect(text, surface).toContain('ack 1')
    expect(text, surface).toContain('TRACKED THIS SESSION')
    expect(text, surface).toContain('CACHE')
    expect(text, surface).toContain('warm')
    expect(text, surface).toContain('4m 00s')
    expect(text, surface).toContain('60k tok to re-cache')
    expect(text, surface).toContain('≈$0.30')
    expect(text, surface).toContain('served from cache')
    // the order: alerts, the cost card, the cache card
    expect(at('quiet for 20m'), surface).toBeLessThan(at('TRACKED THIS SESSION'))
    expect(at('TRACKED THIS SESSION'), surface).toBeLessThan(at('CACHE'))
    if (surface === 'desktop') expect(svgs(tree).some(s => / full$/.test(s.alt)), 'the ring').toBe(true)
    else expect(text).toMatch(/CACHE warm +━+╸?─* 4m 00s/)
    await ui.press({ key: 'ack' })
    await ui.unmount()
  }
  expect(writes.length).toBeGreaterThanOrEqual(1)
  const last = writes[writes.length - 1] as { value: { log: { ackd: boolean }[] } }
  expect(last.value.log.every(x => x.ackd)).toBe(true)
})

test('overview: the cache clock counts down while the pane shows it with main idle, and stops cold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = populated()
  s.meta.activeTurns = {}
  const main = s.agents.byId.main
  if (main) main.status = 'idle'
  s.tools = s.tools.filter(t => t.status !== 'running')
  seed(on, s)
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:overview' })
  expect(texts(await ui.drawn()).join('\n')).toContain('4m 00s')
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n')).toContain('3m 59s')
  await clock.advance(4 * 60_000)
  const text = texts(await ui.drawn()).join('\n')
  expect(text).toContain('cold')
  expect(text).not.toContain('nothing refreshes it')
  await ui.unmount()
})

test('context: the bloat audit sorts by waste, says what could be disabled, marks estimates; not ready, it offers the full breakdown', async ($, on) => {
  mock.clock(on, { now: NOW })
  const asked: unknown[] = []
  on('session.usage', (_, e) => {
    asked.push(e.breakdown)
    return { value: { startedAt: 0, context: { tokens: 2_000, window: 1_000_000, percent: 0.2 }, rateLimits: [] } }
  })
  const notReady = populated()
  notReady.context.lastFullAt = null
  const box = seed(on, notReady)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 80, 120]) {
      const ui = await $.ui.mount(pane(cols, 60, surface))
      await ui.press({ key: 'tab:context' })
      const text = await allText(ui, 'context', cols, surface)
      expect(text, `${surface} ${cols}`).toMatch(/BLOAT AUDIT|── bloat audit/)
      expect(text, `${surface} ${cols}`).toContain('run full breakdown')
      await ui.unmount()
    }
  }
  const ui = await $.ui.mount(pane(80, 60, 'desktop'))
  await ui.press({ key: 'tab:context' })
  await ui.press({ key: 'bloat:refresh' })
  expect(asked).toContain('full')
  await ui.unmount()

  box.s = withBloat()
  box.version += 1
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 80, 120]) {
      const ui = await $.ui.mount(pane(cols, 80, surface))
      await ui.press({ key: 'tab:context' })
      const text = await allText(ui, 'context', cols, surface)
      const where = `${surface} ${cols}`
      expect(text, where).toMatch(/\d unused items? re-send ≈\d+(\.\d)?k tok\/req/)
      expect(text, where).toContain('could be disabled: mcp claude.ai Slack')
      expect(text, where).toContain('claude.ai Slack')
      expect(text, where).toContain('unused')
      expect(text, where).toContain('≈ estimates')
      // sorted by waste: the unused server before the active linear server
      expect(text.indexOf('claude.ai Slack'), where).toBeLessThan(text.indexOf('linear'))
      if (cols >= 80) {
        expect(text, where).toContain('never')
        expect(text, where).toMatch(/≈\$\d/)
        expect(text, where).toContain('n/a')
      }
      await ui.unmount()
    }
  }
})

test('live: the active alert is pinned under the now row and the log rows sit among the events, the acked one dim', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withAlerts(), alertsLog())
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(80, 40, surface))
    await ui.press({ key: 'tab:live' })
    const text = await allText(ui, 'live', 80, surface)
    expect(text, surface).toContain('! Agent "long search that went quiet" has been quiet for 20m')
    expect(text, surface).toContain('alert · Burn rate $0.62/min')
    expect(text, surface).toContain('ackd')
    expect(text, surface).not.toContain(SECRET)
    await ui.unmount()
  }
})

test('agents: Tree | Workflows, the chips with counts, the search field; the workflow cards expand into their agents; all kept in the ui state', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, ledgerGap())
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(pane(80, 40, surface))
    const text1 = textOf(await ui.drawn(), 80, surface)
    expect(text1, surface).toContain('Tree')
    expect(text1, surface).toContain('Workflows')
    expect(text1, surface).toMatch(/all 3/)
    expect(text1, surface).toMatch(/failed 1/)
    expect(await ui.find({ type: 'Input', key: 'agents:search' }), `${surface}: the search field`).toBeDefined()

    // the failed chip leaves the one failed row
    await ui.press({ key: 'filter:failed' })
    let text = textOf(await ui.drawn(), 80, surface)
    expect(text, surface).toContain('nested check')
    expect(text, surface).not.toContain('draft the plan')
    // `f` cycles on: failed -> stale -> all
    await ui.press({ key: 'filter:failed' })
    await ui.press({ key: 'filter:stale' })
    text = textOf(await ui.drawn(), 80, surface)
    expect(text, surface).toContain('draft the plan')

    // the search narrows by description
    await ui.input({ key: 'agents:search', text: 'draft' })
    text = textOf(await ui.drawn(), 80, surface)
    expect(text, surface).toContain('draft the plan')
    expect(text, surface).not.toContain('nested check')
    await ui.input({ key: 'agents:search', text: '' })

    // workflows: one card per root under main; a press expands it into its agents
    await ui.press({ key: 'agents:workflows' })
    text = textOf(await ui.drawn(), 80, surface)
    expect(text, surface).toContain('▸ find every caller')
    expect(text, surface).toContain('▸ draft the plan')
    expect(text, surface).toContain('2 agents')
    expect(text, surface).toMatch(/×\d/)
    expect(text, surface).not.toContain('nested check')
    await ui.press({ key: 'wf:root:a1' })
    text = textOf(await ui.drawn(), 80, surface)
    expect(text, surface).toContain('▾ find every caller')
    expect(text, surface).toContain('nested check')
    expect(text, surface).toContain('1 failed')
    expect(text, surface).not.toContain(SECRET)
    await ui.unmount()

    // the view, the chip and the open card survive a remount (the ui atom)
    const again = await $.ui.mount(pane(80, 40, surface))
    text = textOf(await again.drawn(), 80, surface)
    expect(text, `${surface}: kept`).toContain('▾ find every caller')
    await again.press({ key: 'wf:root:a1' })
    await again.press({ key: 'agents:tree' })
    await again.unmount()
  }
})

test('the pure pieces: the alert block, the rules line, the cache card, the bloat view, the workflow cards and the controls', () => {
  const s = { ...withAlerts(), alerts: alertsLog() }
  const al = alertBlock(s, NOW)
  expect(al.active.map(a => a.key)).toEqual(['agent-stale:g3'])
  expect(al.active[0]?.ageMs).toBe(10 * 60_000)
  expect(al.unacked).toBe(1)
  expect(al.budget).toBeNull()
  expect(alertBlock(s, NOW, { ...DEFAULT_ALERT_RULES, budgetUsd: 10 }).budget).toEqual({ frac: 0.321, usd: 10, spent: 3.21 })
  expect(rulesLine({ ...DEFAULT_ALERT_RULES, budgetUsd: 20 })).toBe('ctx warn 70% · crit 90% · burn ×3 · tool errors 30% · stale 30m long run · budget $20.00')

  const cc = cacheCard(populated(), NOW, true)
  expect(cc.state).toEqual({ text: 'warm', tone: 'success' })
  expect(cc.countdown).toBe('4m 00s')
  expect(Math.round((cc.remaining ?? 0) * 100)).toBe(80)
  expect(cacheCard(populated(), NOW, false).countdown).toBe('4m')
  expect(cacheCard(emptyState(0), 1, true).state.text).toBe('no request yet')

  const summaryOnly = populated()
  summaryOnly.context.lastFullAt = null
  expect(bloatView(summaryOnly, NOW).isReady).toBe(false)
  const v = bloatView(withBloat(), NOW)
  expect(v.isReady).toBe(true)
  if (v.isReady) {
    expect(v.rows[0]?.name).toBe('claude.ai Slack')
    expect(v.rows[0]?.verdict).toBe('unused')
    expect(v.hint).toContain('could be disabled: mcp claude.ai Slack')
    expect(v.summary).toMatch(/^\d unused items? re-send ≈\d+(\.\d)?k tok\/request ≈ \$/)
  }

  const rows = deriveAgents(ledgerGap(), NOW)
  const cards = workflowCards(ledgerGap(), NOW, { expandedWorkflows: ['root:a1'] }, rows)
  expect(cards.map(c => c.wf.name)).toEqual(['draft the plan', 'find every caller of the pricing table across the repository'])
  expect(cards[1]?.isOpen).toBe(true)
  expect(cards[1]?.agents.map(a => a.id)).toEqual(['a1', 'a2'])
  expect(cards[1]?.failures).toBe('1 failed')
  expect(workflowCards(ledgerGap(), NOW, { agentFilter: 'failed' }, rows).map(c => c.wf.id)).toEqual(['root:a1'])
  expect(workflowCards(ledgerGap(), NOW, { agentQuery: 'nothing here' }, rows)).toEqual([])

  const ctl = agentControls(rows, { agentFilter: 'failed' })
  expect(ctl.chips.map(c => `${c.id} ${c.count}`)).toEqual(['all 3', 'running 1', 'done 1', 'failed 1', 'stale 0'])
  expect(ctl.rows.map(r => r.id)).toEqual(['a2'])
  expect(agentControls(rows, {}).rows.map(r => r.id)).toEqual(['main', 'a1', 'a2', 'a3'])
  expect(agentControls(rows, { agentQuery: 'HAIKU' }).rows.map(r => r.id)).toEqual(['a1', 'a2', 'a3'])
})
