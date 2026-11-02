// Agent plans and the Agents tab's drawers:
// - the reducer (model.ts `recordPlan`): savvy-progress `step` and `progress`,
//   TodoWrite, TaskCreate / TaskUpdate / TaskList, the latest call winning,
//   the caps, redaction (a fake secret in a todo), unknown shapes ignored;
// - the derive (`deriveAgentPlan`, `deriveAgents` rows, the workflow sum);
// - through the kit: an answered plan call recorded on its loop, a refused one
//   not, and a subagent's own call (raised inside the Agent call, `agentId`
//   set) attributed to the subagent;
// - the drawers: a click opens, a second click closes, several open at once,
//   `collapse all`, `expand running`; on both surfaces;
// - the frames at 40 / 48 / 80 / 120 cells with drawers closed, one open and
//   several open, with and without plans: within the rows (a drawer taller
//   than the body windowed by its lines), within the width, no secret.
// With PRINT set to true the terminal frames are printed between PLANS-BEGIN
// and PLANS-END, and the desktop trees as JSON between PLANS-DESK-BEGIN and
// PLANS-DESK-END (for the HTML mock this layout was based on).

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TelemetryState, TelemetryUi } from '../types'

import { deriveAgentPlan, deriveAgents, deriveOverview, planCountText, PLAN_STALE_MS } from '../hooks/derive'
import { emptyState, PLAN_ITEMS_MAX, planText, recordPlan } from '../hooks/model'
import type { T4 } from '../hooks/ui/desktop/kit'
import { deskTree } from '../hooks/ui/desktop/view'
import { flattenItems, windowItems } from '../hooks/ui/desktop/window'
import { planChecklist, workflowCards, workflowPlan } from '../hooks/ui/insights-view'
import { layoutOf } from '../hooks/ui/layout'
import type { T3 } from '../hooks/ui/term/kit'
import { termTree } from '../hooks/ui/term/view'
import { toggledIds } from '../hooks/ui/ui-state'

import { NOW, populated, SECRET } from './fixture'
import { withPlans } from './plans-fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'

/** Print the frames (see the note above). */
const PRINT = false

const fresh = (): TelemetryState => emptyState(NOW - 60_000)
const planOf = (s: TelemetryState, id = 'main') => s.agents.byId[id]?.plan ?? null

// ================================================================ the reducer

test('step: done, total and note; a total left out keeps the last; a bad done changes nothing', () => {
  const s = fresh()
  expect(recordPlan(s, { tool: 'mcp__savvy-progress__step', input: { done: 0, total: 5, note: 'read the brief' } }, 1)).toEqual(['agents'])
  expect(planOf(s)).toEqual({ source: 'step', done: 0, total: 5, current: 'read the brief', updatedAt: 1 })
  recordPlan(s, { tool: 'mcp__savvy-progress__step', input: { done: 2, note: 'write tests' } }, 2)
  expect(planOf(s)).toMatchObject({ done: 2, total: 5, current: 'write tests', updatedAt: 2 })
  for (const bad of [{ done: -1 }, { done: 'two' }, { done: Number.NaN }, {}, { total: 3 }]) {
    expect(recordPlan(s, { tool: 'mcp__savvy-progress__step', input: bad }, 3)).toEqual([])
  }
  expect(planOf(s)?.updatedAt).toBe(2)
})

test('progress: main only; partial calls merge; the tasks become the checklist; finished completes it', () => {
  const s = fresh()
  // a subagent's call is ignored, as the tool itself does
  recordPlan(s, { agentId: 'w1', tool: 'mcp__savvy-progress__progress', input: { title: 'x', total: 2 } }, 1)
  expect(s.agents.byId.w1).toBeUndefined()
  const tasks = [{ title: 'data layer', tier: 'medium' }, { title: 'desktop view', tier: 'medium' }, { title: 'terminal view', tier: 'light', after: [1] }]
  recordPlan(s, { tool: 'mcp__savvy-progress__progress', input: { title: 'Agent plans', total: 3, tasks, phase: 'delegate' } }, 1)
  expect(planOf(s)).toMatchObject({ source: 'progress', done: 0, total: 3, current: 'data layer', title: 'Agent plans', phase: 'delegate' })
  expect(planOf(s)?.items?.map(i => i.status)).toEqual(['active', 'pending', 'pending'])
  // fields left out keep their value
  recordPlan(s, { tool: 'mcp__savvy-progress__progress', input: { done: 2 } }, 2)
  expect(planOf(s)).toMatchObject({ done: 2, total: 3, current: 'terminal view', title: 'Agent plans' })
  expect(planOf(s)?.items?.map(i => i.status)).toEqual(['done', 'done', 'active'])
  recordPlan(s, { tool: 'mcp__savvy-progress__progress', input: { finished: true } }, 3)
  expect(planOf(s)).toMatchObject({ done: 3, total: 3 })
  expect(planOf(s)?.current).toBeUndefined()
  expect(planOf(s)?.items?.every(i => i.status === 'done')).toBe(true)
})

test('TodoWrite: counts, the active form as the current task, the latest call wins, an empty list clears its own plan', () => {
  const s = fresh()
  recordPlan(s, { tool: 'mcp__savvy-progress__step', input: { done: 1, total: 4 } }, 1)
  recordPlan(
    s,
    {
      tool: 'TodoWrite',
      input: {
        todos: [
          { content: 'a', status: 'completed', activeForm: 'Doing a' },
          { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
          { content: 'c', status: 'pending', activeForm: 'Doing c' },
          { content: '', status: 'pending', activeForm: 'empty is dropped' },
          'not a todo',
          null,
        ],
      },
    },
    2,
  )
  expect(planOf(s)).toEqual({
    source: 'todos',
    done: 1,
    total: 3,
    current: 'Doing b',
    items: [
      { text: 'a', status: 'done' },
      { text: 'b', status: 'active' },
      { text: 'c', status: 'pending' },
    ],
    updatedAt: 2,
  })
  // a step call now wins over the todos
  recordPlan(s, { tool: 'mcp__savvy-progress__step', input: { done: 3, total: 4 } }, 3)
  expect(planOf(s)?.source).toBe('step')
  // an empty todo list clears only a todos plan
  recordPlan(s, { tool: 'TodoWrite', input: { todos: [] } }, 4)
  expect(planOf(s)?.source).toBe('step')
  recordPlan(s, { tool: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending', activeForm: 'X' }] } }, 5)
  recordPlan(s, { tool: 'TodoWrite', input: { todos: [] } }, 6)
  expect(planOf(s)).toBeNull()
})

test('the caps: 30 items around the active one, the true counts kept, every text within 80 characters', () => {
  const s = fresh()
  const todos = Array.from({ length: 50 }, (_, i) => ({ content: `todo ${i + 1} ${'x'.repeat(120)}`, status: i < 35 ? 'completed' : i === 35 ? 'in_progress' : 'pending', activeForm: `doing ${i + 1}` }))
  recordPlan(s, { tool: 'TodoWrite', input: { todos } }, 1)
  const p = planOf(s)
  expect(p?.done).toBe(35)
  expect(p?.total).toBe(50)
  expect(p?.items).toHaveLength(PLAN_ITEMS_MAX)
  expect(p?.items?.some(i => i.status === 'active')).toBe(true)
  for (const it of p?.items ?? []) expect(Array.from(it.text).length).toBeLessThanOrEqual(80)
  const view = deriveAgentPlan(s.agents.byId.main, 2, true)
  expect(view?.hiddenItems).toBe(20)
  const list = planChecklist(view ?? { items: [], hiddenItems: 0 })
  expect(list.items).toHaveLength(7)
  expect(list.items.some(i => i.status === 'active')).toBe(true)
  expect(list.more).toBe(43)
})

test('the Task tools: create (the id from the result), update, delete, list replaces; a task description is never kept', () => {
  const s = fresh()
  recordPlan(s, { tool: 'TaskCreate', input: { subject: 'first', description: `do it with ${SECRET}` }, result: { task: { id: '1', subject: 'first' } } }, 1)
  recordPlan(s, { tool: 'TaskCreate', input: { subject: 'second', description: 'more' }, result: { task: { id: '2', subject: 'second' } } }, 2)
  expect(planOf(s)).toMatchObject({ source: 'tasks', done: 0, total: 2 })
  recordPlan(s, { tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }, 3)
  recordPlan(s, { tool: 'TaskUpdate', input: { taskId: '2', status: 'in_progress', subject: 'second, renamed' } }, 4)
  expect(planOf(s)).toMatchObject({ done: 1, total: 2, current: 'second, renamed' })
  recordPlan(s, { tool: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } }, 5)
  expect(planOf(s)).toMatchObject({ done: 0, total: 1 })
  // an update of an unknown task without a subject says nothing
  expect(recordPlan(s, { tool: 'TaskUpdate', input: { taskId: '9', status: 'completed' } }, 6)).toEqual([])
  recordPlan(
    s,
    { tool: 'TaskList', input: {}, result: { tasks: [{ id: '3', subject: 'listed a', status: 'completed', blockedBy: [] }, { id: '4', subject: 'listed b', status: 'pending', blockedBy: [] }, { id: 5, nope: true }] } },
    7,
  )
  expect(planOf(s)?.items).toEqual([
    { text: 'listed a', status: 'done', id: '3' },
    { text: 'listed b', status: 'pending', id: '4' },
  ])
  expect(JSON.stringify(s.agents)).not.toContain(SECRET)
})

test('unknown shapes are ignored and nothing throws', () => {
  const s = fresh()
  const odd: unknown[] = [null, undefined, 3, 'text', [], [1, 2], { todos: 'nope' }, { todos: [{ content: 4 }] }, { tasks: {} }, { done: {} }]
  for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'mcp__savvy-progress__step', 'mcp__savvy-progress__progress', 'Bash', 'Read']) {
    for (const input of odd) {
      for (const result of [undefined, null, 'x', { task: 3 }, { tasks: 'x' }]) {
        expect(() => recordPlan(s, { tool, input, result }, 1)).not.toThrow()
      }
    }
  }
  // a Bash call never makes a plan, whatever it holds
  recordPlan(s, { tool: 'Bash', input: { command: `echo ${SECRET}`, todos: [{ content: 'x', status: 'pending' }] } }, 2)
  expect(planOf(s)).toBeNull()
  // a stored plan of another shape reads as none
  const main = s.agents.byId.main
  if (main) main.plan = { source: 'other', done: 1, total: 2, updatedAt: 1 } as never
  expect(deriveAgentPlan(main, 2, true)).toBeNull()
})

test('redaction: a token, a key pair, a bearer, URL user info and query, long secrets; plain text and paths kept', () => {
  expect(planText(`rotate key ${SECRET} in staging`)).toBe('rotate key ••• in staging')
  expect(planText('check https://user:hunter2@example.com/docs?token=abc123 for the API')).toBe('check example.com/docs for the API')
  expect(planText('set api_key=abcd1234efgh and password: "p w"')).toBe('set api_key=••• and password: •••')
  expect(planText('curl -H "Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"')).not.toMatch(/eyJ/)
  expect(planText('push with ghp_abcdefghijklmnop0123 then xoxb-1234-abcdef')).toBe('push with ••• then •••')
  expect(planText('aws AKIAABCDEFGHIJKLMNOP done')).toBe('aws ••• done')
  expect(planText('blob 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end')).toBe('blob ••• end')
  expect(planText('db at postgres://admin:s3cret@db.internal:5432/app')).toBe('db at db.internal:5432/app')
  // what a plan says stays
  expect(planText('Wire the plan line into hooks/ui/desktop/agents.tsx')).toBe('Wire the plan line into hooks/ui/desktop/agents.tsx')
  expect(planText('Update NOTES.md and run 189 tests')).toBe('Update NOTES.md and run 189 tests')
  expect(planText('  two\nlines\tand\u0007bell  ')).toBe('two lines and bell')
  expect(planText('x'.repeat(200))?.length).toBe(80)
  expect(planText('')).toBeNull()
  expect(planText(42)).toBeNull()
})

// ================================================================ derive

test('deriveAgentPlan: the fraction, the clamp, an unknown total, stale while running, complete; rows carry it', () => {
  const base = { source: 'step' as const, done: 3, total: 7, current: 'x', updatedAt: NOW - 1000 }
  expect(deriveAgentPlan({ plan: base }, NOW, true)).toMatchObject({ done: 3, total: 7, currentTask: 'x', isStale: false, isComplete: false })
  expect(Math.abs((deriveAgentPlan({ plan: base }, NOW, true)?.fraction ?? 0) - 3 / 7) < 1e-9).toBe(true)
  expect(deriveAgentPlan({ plan: { ...base, done: 9 } }, NOW, true)).toMatchObject({ done: 9, total: 9, fraction: 1, isComplete: true })
  const noTotal = deriveAgentPlan({ plan: { ...base, total: 0 } }, NOW, true)
  expect(noTotal).toMatchObject({ done: 3, total: 0, fraction: null, isComplete: false })
  expect(planCountText(noTotal ?? { done: 0, total: 0 })).toBe('3 done')
  expect(planCountText({ done: 3, total: 7 })).toBe('3/7')
  expect(deriveAgentPlan({ plan: { ...base, updatedAt: NOW - PLAN_STALE_MS - 1 } }, NOW, true)?.isStale).toBe(true)
  // a finished loop's plan is never stale
  expect(deriveAgentPlan({ plan: { ...base, updatedAt: NOW - PLAN_STALE_MS - 1 } }, NOW, false)?.isStale).toBe(false)
  expect(deriveAgentPlan({ plan: null }, NOW, true)).toBeNull()
  expect(deriveAgentPlan({}, NOW, true)).toBeNull()

  const s = withPlans(populated(), { stale: true })
  const rows = deriveAgents(s, NOW)
  const by = (id: string) => rows.find(r => r.id === id)
  expect(by('main')?.plan).toMatchObject({ source: 'todos', done: 3, total: 10, currentTask: 'Wiring the plan line' })
  expect(by('a3')?.plan).toMatchObject({ source: 'step', done: 3, total: 7, isStale: true })
  expect(by('a1')?.plan).toMatchObject({ done: 7, total: 7, isComplete: true })
  // the main loop's todo with the secret was redacted on the way in
  expect(JSON.stringify(rows)).not.toContain(SECRET)
  expect(JSON.stringify(rows)).not.toContain('hunter2')
  // the workflows sum the members that have a plan: a1 7/7 and its child a2 2/5
  expect(workflowPlan(rows.filter(r => r.id === 'a1' || r.id === 'a2'))).toEqual({ done: 9, total: 12 })
  expect(workflowPlan(rows.filter(r => r.id === 'a3' && false))).toBeNull()
  const cards = workflowCards(s, NOW, {}, rows)
  const a1card = cards.find(c => c.wf.rootIds.includes('a1'))
  expect(a1card?.plan).toEqual({ done: 9, total: 12 })
  expect(a1card?.counts).toContain('9/12 tasks')
  // an agent without a plan shows none
  expect(deriveAgents(populated(), NOW).every(r => r.plan === null)).toBe(true)
})

// ================================================================ through the kit

function world(on: On) {
  const written: Record<string, unknown> = {}
  on('session.id', () => ({ value: 'sess-P' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('settings.read', () => ({ value: {} }))
  on('agent.list', () => ({ value: [] }))
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry') written[e.key] = (e.value as { value: unknown }).value
    return next(e)
  })
  return { agents: () => written.agents as TelemetryState['agents'] | undefined, tools: () => written.tools as TelemetryState['tools'] | undefined }
}

test('through the kit: an answered TodoWrite sets the main plan, a refused one does not, a secret never reaches the store', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  let refuse = false
  on('tool.call', () => (refuse ? { deny: 'no' } : { result: { oldTodos: [], newTodos: [] }, text: 'ok' }))
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: `ship it with ${SECRET}`, status: 'in_progress', activeForm: 'Shipping' }, { content: 'b', status: 'pending', activeForm: 'B' }] })
  expect(w.agents()?.byId.main?.plan).toMatchObject({ source: 'todos', done: 0, total: 2, current: 'Shipping' })
  expect(JSON.stringify(w.agents())).not.toContain(SECRET)
  refuse = true
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'refused', status: 'completed', activeForm: 'R' }] })
  expect(w.agents()?.byId.main?.plan?.total).toBe(2)
})

test("through the kit: a subagent's own plan calls, raised inside the Agent call with its agentId, are its own", async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') {
      // the subagent's loop, as the engine raises its calls: inside the Agent call, `agentId` its own
      // cast: the laid TodoWrite type does not carry `agentId` (the engine fills it for a subagent's own call)
      await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'sub todo', status: 'in_progress', activeForm: 'Doing the sub todo' }], agentId: 'sub-1' } as never)
      // cast: the MCP tool types are laid per session, and savvy-progress may not be connected in another
      await $.tool.call({ tool: 'mcp__savvy-progress__step', done: 1, total: 3, note: 'worker step', agentId: 'sub-2' } as never)
      return { result: { status: 'completed', content: [] }, text: 'done' }
    }
    return { result: {}, text: 'ok' }
  })
  await $.tool.call({ tool: 'Agent', description: 'a worker', prompt: 'go', subagent_type: 'general-purpose' } as never)
  const tools = w.tools() ?? []
  expect(tools.find(t => t.tool === 'TodoWrite')?.agentId).toBe('sub-1')
  expect(tools.find(t => t.tool === 'mcp__savvy-progress__step')?.agentId).toBe('sub-2')
  expect(w.agents()?.byId['sub-1']?.plan).toMatchObject({ source: 'todos', current: 'Doing the sub todo' })
  expect(w.agents()?.byId['sub-2']?.plan).toMatchObject({ source: 'step', done: 1, total: 3, current: 'worker step' })
  // the main loop's plan is untouched
  expect(w.agents()?.byId.main?.plan ?? null).toBeNull()
})

// ================================================================ the drawers

const termPane = (cols: number, rows: number) =>
  ({
    plugin: 'session-telemetry',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

const deskPane = (cols: number, rows: number) => ({ ...termPane(cols, rows), surface: 'desktop' as const })

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
function texts(tree: unknown): string[] {
  const out: string[] = []
  walk(tree, n => {
    if (n.type !== 'Text') return
    const own = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
    if (own.trim() !== '') out.push(own)
  })
  return out
}
const svgAlts = (tree: unknown): string[] => {
  const out: string[] = []
  walk(tree, n => {
    if (n.type === 'Svg') out.push(String(n.props?.alt ?? ''))
  })
  return out
}
const rowsOf = (tree: unknown, cols: number): string[] => trimmed(renderText(tree, cols))

test('terminal: a click opens a drawer, a second closes it; several open at once; collapse all and expand running', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withPlans())
  const ui = await $.ui.mount(termPane(80, 70))
  let lines = rowsOf(await ui.drawn(), 80)
  // closed rows: the chevron, the plan line under the running rows, the faint count on the done one
  expect(lines.some(l => /^▶ ▸ main session /.test(l))).toBe(true)
  expect(lines).toContainEqual(expect.stringMatching(/^ {2}▸ Wiring the plan line +━+╸?─* 3\/10$/))
  expect(lines).toContainEqual(expect.stringMatching(/^ {2}▸ wire the plan line into both paths +━+╸?─* 3\/7$/))
  expect(lines.some(l => /^✓ └ ▸ find every caller.* ✓ 7\/7 +94k/.test(l))).toBe(true)
  expect(lines.some(l => /^╭/.test(l))).toBe(false)
  await ui.press({ key: 'agent:a3' })
  lines = rowsOf(await ui.drawn(), 80)
  const at = lines.findIndex(l => /▾ draft the plan/.test(l))
  expect(at).toBeGreaterThan(0)
  expect(lines[at + 1]).toMatch(/▸ wire the plan line/)
  expect(lines[at + 2]).toMatch(/^╭─+╮$/)
  const drawer = lines.slice(at + 2, lines.findIndex((l, i) => i > at + 2 && /^╰/.test(l)) + 1).join('\n')
  expect(drawer).toMatch(/│ plan · steps +3\/7 │/)
  expect(drawer).toContain('▸ wire the plan line into both paths')
  // a second drawer opens beside the first
  await ui.press({ key: 'agent:main' })
  lines = rowsOf(await ui.drawn(), 80)
  expect(lines.filter(l => /^╭/.test(l))).toHaveLength(2)
  const text = lines.join('\n')
  expect(text).toMatch(/│ plan · todos +3\/10 │/)
  expect(text).toMatch(/│ ✓ Add the plan type to the contract/)
  expect(text).toMatch(/│ ▸ Wire the plan line into both paths/)
  expect(text).toMatch(/│ ○ rotate key ••• in staging/)
  expect(text).toMatch(/│ {3}\+3 more/)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('hunter2')
  expect(text).toContain('c: collapse all')
  // the same click closes it again
  await ui.press({ key: 'agent:a3' })
  lines = rowsOf(await ui.drawn(), 80)
  expect(lines.filter(l => /^╭/.test(l))).toHaveLength(1)
  expect(lines.some(l => /▸ draft the plan/.test(l))).toBe(true)
  await ui.press({ key: 'agents:collapse' })
  lines = rowsOf(await ui.drawn(), 80)
  expect(lines.filter(l => /^╭/.test(l))).toHaveLength(0)
  expect(lines.join('\n')).not.toContain('collapse all')
  // expand running opens main's and a3's drawers (the running rows)
  await ui.press({ key: 'agents:expand' })
  lines = rowsOf(await ui.drawn(), 80)
  expect(lines.filter(l => /^╭/.test(l))).toHaveLength(2)
  expect(lines.join('\n')).not.toContain('expand running')
  for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(80)
  await ui.unmount()
})

test('desktop: the chevron, the plan line with its bar, the faint count; toggling and several drawers; the checklist', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withPlans())
  const ui = await $.ui.mount(deskPane(64, 60))
  let tree = await ui.drawn()
  let text = texts(tree).join('\n')
  expect(text).toContain('▸ Wiring the plan line')
  expect(text).toContain('3/10')
  expect(text).toContain('▸ wire the plan line into both paths')
  expect(text).toContain('3/7')
  expect(text).toContain('✓ 7/7')
  expect(svgAlts(tree).filter(a => a.startsWith('plan '))).toEqual(['plan 3/10', 'plan 3/7'])
  expect(text).not.toContain('context peak')
  await ui.press({ key: 'agent:main' })
  await ui.press({ key: 'agent:a1' })
  tree = await ui.drawn()
  text = texts(tree).join('\n')
  expect(text.match(/context peak/g)).toHaveLength(2)
  expect(text).toContain('plan · todos')
  // seven around the one in progress, then `+3 more`
  expect(text).not.toContain('Read NOTES and the collector')
  expect(text).toContain('Add the plan type to the contract')
  expect(text).toContain('+3 more')
  expect(text).toContain('caller group 7')
  expect(text).toContain('collapse all')
  expect(text).not.toContain(SECRET)
  expect(text).not.toMatch(/[━╸─│╭╮╰╯█▓▒░]/)
  await ui.press({ key: 'agent:main' })
  text = texts(await ui.drawn()).join('\n')
  expect(text.match(/context peak/g)).toHaveLength(1)
  await ui.press({ key: 'agents:collapse' })
  expect(texts(await ui.drawn()).join('\n')).not.toContain('context peak')
  await ui.unmount()
})

test('a stale plan dims; an agent without a plan has no bar and no count', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withPlans(populated(), { stale: true }))
  const desk = await $.ui.mount(deskPane(64, 40))
  const tree = await desk.drawn()
  expect(svgAlts(tree)).toContain('plan 3/7 (stale)')
  // the stale line's text and count are dim (no accent)
  let staleDim = false
  walk(tree, n => {
    if (n.type === 'Text' && (n.children ?? []).join('') === '3/7') staleDim = n.props?.dimColor === true && n.props?.color === undefined
  })
  expect(staleDim).toBe(true)
  await desk.unmount()
  const term = await $.ui.mount(termPane(80, 40))
  const t = await term.drawn()
  let dimTask = false
  walk(t, n => {
    if (n.type === 'Text' && (n.children ?? []).join('') === 'wire the plan line into both paths') dimTask = n.props?.dimColor === true
  })
  expect(dimTask).toBe(true)
  await term.unmount()
})

test('without plans: the phase lines as before, no plan bar, no count', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  const desk = await $.ui.mount(deskPane(64, 40))
  const tree = await desk.drawn()
  expect(svgAlts(tree).filter(a => a.startsWith('plan'))).toEqual([])
  expect(texts(tree).join('\n')).not.toMatch(/\d+\/\d+/)
  await desk.unmount()
  const term = await $.ui.mount(termPane(80, 30))
  const lines = rowsOf(await term.drawn(), 80)
  expect(lines).toContain('  ▸ Bash · 7s')
  expect(lines.join('\n')).not.toMatch(/ \d+\/\d+$/m)
  await term.unmount()
})

// ================================================================ the frames

const OPEN_SETS: [string, string[]][] = [
  ['closed', []],
  ['one open', ['a3']],
  ['several open', ['main', 'a3', 'a1', 'a2']],
]

test('the frames at 40, 48, 80 and 120 cells: closed, one and several drawers open, with and without plans, within rows and width', () => {
  const T3t = { Box: 'Box', Text: 'Text', Button: 'Button' } as unknown as T3
  const T4t = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg' } as unknown as T4
  const out: string[] = []
  const desk: string[] = []
  for (const [plans, s] of [
    ['plans', withPlans()],
    ['stale plans', withPlans(populated(), { stale: true })],
    ['no plans', populated()],
  ] as const) {
    const o = deriveOverview(s, NOW)
    for (const [cols, rows] of [
      [40, 24],
      [48, 24],
      [80, 24],
      [120, 40],
      [80, 12],
      [40, 10],
    ] as const) {
      for (const [name, open] of OPEN_SETS) {
        for (const focus of [null, 'a3', 'main', 'a2']) {
          const ui: TelemetryUi = { tab: 'agents', agentId: focus, scroll: {}, ...(open.length > 0 ? { expandedAgents: open } : {}) }
          const where = `${plans} ${cols}x${rows} ${name} focus ${focus}`
          const term = termTree(T3t, { s, ui, now: NOW, layout: layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'terminal') }, o, () => undefined)
          const lines = renderText(term.tree, cols)
          expect(lines.length, `${where}: terminal rows`).toBeLessThanOrEqual(rows)
          expect(term.usedRows, `${where}: terminal rows counted`).toBeLessThanOrEqual(rows)
          expect(fixedOverflow(term.tree, cols), `${where}: terminal fixed cells`).toBeLessThanOrEqual(0)
          const text = lines.join('\n')
          expect(text, `${where}: no secret`).not.toContain(SECRET)
          // the focused row is in view, and its open drawer's first line under it when there is room
          if (focus !== null && rows >= 24) expect(text, `${where}: the focused row shows`).toMatch(focus === 'main' ? /main session/ : focus === 'a3' ? /draft the p/ : /nested c/)
          const dk = deskTree(T4t, { s, ui, now: NOW, layout: layoutOf({ bodyColumns: cols, scroll: { bodyRows: rows } }, { columns: cols, rows }, 'desktop') }, o, () => undefined)
          // a drawer taller than the body is windowed by its lines: the estimate never passes the body
          expect(dk.usedRows, `${where}: desktop rows`).toBeLessThanOrEqual(rows)
          expect(texts(dk.tree).join('\n'), `${where}: desktop no secret`).not.toContain(SECRET)
          if (focus === 'a3' && (rows === 24 || rows === 12)) out.push(`── ${where} ${'─'.repeat(Math.max(0, cols - where.length - 4))}`, ...trimmed(lines), '')
          if (focus === 'a3' && rows === 24 && (cols === 48 || cols === 80) && plans !== 'stale plans') desk.push(JSON.stringify({ where, cols, tree: dk.tree }))
        }
      }
    }
  }
  const g = globalThis as unknown as { console?: { log: (text: string) => void } }
  if (PRINT) {
    g.console?.log(`\nPLANS-BEGIN\n${out.join('\n')}\nPLANS-END\n`)
    g.console?.log(`\nPLANS-DESK-BEGIN\n${desk.join('\n')}\nPLANS-DESK-END\n`)
  }
})

test('the window: a drawer taller than the room is windowed by its parts; the focused row and its drawer kept in view', () => {
  const part = { rows: 1 }
  const items = [{ rows: 1 }, { rows: 2 }, { rows: 12, parts: Array.from({ length: 10 }, () => ({ ...part })) }, { rows: 1 }]
  // fits: kept whole
  expect(flattenItems(items, 20, 1).items).toHaveLength(4)
  // too tall: its parts, the selection carried over
  const flat = flattenItems(items, 6, 3, ['x', 'y', null, 'z'], 2)
  expect(flat.items).toHaveLength(13)
  expect(flat.select).toBe(12)
  expect(flat.selectTo).toBe(11)
  expect(flat.ids?.[0]).toBe('x')
  expect(flat.ids?.[12]).toBe('z')
  // the range: the drawer's end brought in, then the row's start wins
  const h = [1, 1, 1, 4, 1, 1]
  // 7 rows less the pager's 1: rows 1..3 hold the row and its drawer
  expect(windowItems(h, 7, 0, 2, 1, 3).offset).toBe(1)
  // too little room for both: the row at the top, the drawer cut beneath
  expect(windowItems(h, 4, 0, 2, 1, 3).offset).toBe(2)
  // without a range, as before
  expect(windowItems(h, 6, 0, 2, 1).offset).toBe(0)
  // toggling ids
  expect(toggledIds([], 'a')).toEqual(['a'])
  expect(toggledIds(['a', 'b'], 'a')).toEqual(['b'])
})
