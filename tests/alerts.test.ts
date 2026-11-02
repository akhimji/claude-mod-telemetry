// The alert engine's IO side (collect.ts evaluateAlerts) over a fake IO: an
// alert fires once into the atom, re-arms, toasts at most once per 30 s, keeps
// the view's acks, starts over on /clear; the status line is set only when its
// text changes; the timer fires the cache-expiry alert while main sits idle.
// And through the engine's kit: register's `options` reach the rules.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionMeasureInput, ToolCallInput, ToolCallResult, TurnStepInput, TurnStepResult } from 'claude-code'

import type { TelemetryAlerts, TelemetryState } from '../types'

import * as collect from '../hooks/collect'
import { emptyAlerts } from '../hooks/insights'
import { emptyState, type StateKey } from '../hooks/model'

import { SECRET } from './fixture'

const ev = <T>(value: unknown): T => value as T

function fake() {
  const store = new Map<StateKey, unknown>()
  const world = {
    now: 1_000_000,
    alerts: emptyAlerts(0) as TelemetryAlerts,
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    timers: [] as { at: number; fn: () => void }[],
    updates: 0,
  }
  const io: collect.TelemetryIO = {
    now: async () => world.now,
    readState: async () => {
      const base = emptyState(0)
      const pick = <K extends StateKey>(key: K): TelemetryState[K] => (store.has(key) ? (store.get(key) as TelemetryState[K]) : base[key])
      return { totals: pick('totals'), agents: pick('agents'), steps: pick('steps'), tools: pick('tools'), turns: pick('turns'), context: pick('context'), meta: pick('meta') }
    },
    writeState: async (key, s) => {
      store.set(key, JSON.parse(JSON.stringify(s[key])))
    },
    log: () => undefined,
    sessionId: async () => 'session-1',
    sessionStartedAt: async () => 500,
    sessionModel: async () => 'claude-opus-5-5',
    sessionCwd: async () => '/work',
    managedPricing: async () => undefined,
    breakdown: async () => undefined,
    agentList: async () => [],
    after: (ms, fn) => {
      world.timers.push({ at: world.now + ms, fn })
    },
    readAlerts: async () => JSON.parse(JSON.stringify(world.alerts)) as TelemetryAlerts,
    updateAlerts: async fn => {
      world.updates += 1
      world.alerts = fn(JSON.parse(JSON.stringify(world.alerts)) as TelemetryAlerts)
      return world.alerts
    },
    toast: text => {
      world.toasts.push(text)
    },
    status: text => {
      world.statuses.push(text)
    },
  }
  return { io, world }
}

const measure = (costUsd: number, tokens = 10_000) =>
  ev<SessionMeasureInput>({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [], cost: { usd: costUsd }, changed: ['cost'] })

const stepE = (over: Record<string, unknown> = {}) => ev<TurnStepInput>({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...over })
const stepR = (cacheRead: number) =>
  ev<TurnStepResult>({
    turnId: 't1',
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
  })

describe('alert engine', () => {
  test('fires once into the atom, escalates once, dedupes, re-arms', async () => {
    collect.resetForTests()
    collect.configure({ budgetUsd: 1 })
    const { io, world } = fake()
    await collect.onMeasure(io, measure(0.85))
    expect(world.alerts.log.map(a => `${a.key}:${a.level}`)).toEqual(['budget:warn'])
    expect(world.toasts).toEqual([]) // quiet: warn stays in the pane
    await collect.onMeasure(io, measure(0.9))
    expect(world.alerts.log).toHaveLength(1)
    const writes = world.updates
    await collect.onMeasure(io, measure(0.9))
    expect(world.updates).toBe(writes) // nothing changed, nothing written

    world.now += 1000
    await collect.onMeasure(io, measure(1.2))
    expect(world.alerts.log.map(a => a.level)).toEqual(['warn', 'crit'])
    expect(world.toasts).toEqual(['Session cost $1.20 is over the $1.00 budget'])

    // clears, comes back after the cooldown: fires again
    await collect.onMeasure(io, measure(0.1))
    expect(world.alerts.conditions.budget?.active).toBe(false)
    world.now += collect.currentRules().cooldownMs + 1
    await collect.onMeasure(io, measure(0.95))
    expect(world.alerts.log).toHaveLength(3)
  })

  test('at most one toast per 30 s, in the all mode warn too', async () => {
    collect.resetForTests()
    collect.configure({ alertsEnabled: 'all', budgetUsd: 1, contextWarnPct: 50 })
    const { io, world } = fake()
    await collect.onMeasure(io, measure(0.85, 600_000)) // budget warn and context warn at once
    expect(world.alerts.log).toHaveLength(2)
    expect(world.toasts).toHaveLength(1)
    world.now += 10_000
    await collect.onMeasure(io, measure(1.5, 600_000)) // budget escalates: rate-limited
    expect(world.alerts.log).toHaveLength(3)
    expect(world.toasts).toHaveLength(1)
    world.now += 25_000
    await collect.onMeasure(io, measure(1.5, 950_000)) // context escalates 35 s after the toast
    expect(world.toasts).toHaveLength(2)
    expect(world.toasts[1]).toMatch(/^Context at 95% of the window/)
  })

  test('the view acks survive the next write; /clear starts over', async () => {
    collect.resetForTests()
    collect.configure({ budgetUsd: 1, contextWarnPct: 50 })
    const { io, world } = fake()
    await collect.onMeasure(io, measure(0.85))
    const first = world.alerts.log[0]
    if (first) first.ackd = true // as ackAlerts($) would
    await collect.onMeasure(io, measure(0.85, 600_000))
    expect(world.alerts.log.map(a => a.ackd)).toEqual([true, false])
    await collect.onSessionEnd(io, { reason: 'clear' })
    expect(world.alerts.log).toEqual([])
    expect(world.alerts.conditions).toEqual({})
  })

  test('the status line: set when its text changes, at most every 2 s, cleared once when off', async () => {
    collect.resetForTests()
    collect.configure({ statusLine: true })
    const { io, world } = fake()
    await collect.onMeasure(io, measure(0.5))
    expect(world.statuses).toEqual(['$0.50 · ctx 1%'])
    await collect.onMeasure(io, measure(0.5))
    expect(world.statuses).toHaveLength(1)
    world.now += 500
    await collect.onMeasure(io, measure(0.75))
    expect(world.statuses).toHaveLength(1) // too soon: a timer brings it
    const timer = world.timers.at(-1)
    expect(timer?.at).toBe(world.now - 500 + 2000)
    world.now = timer?.at ?? world.now
    timer?.fn()
    await collect.evaluateAlerts(io)
    expect(world.statuses.at(-1)).toBe('$0.75 · ctx 1%')

    collect.resetForTests()
    collect.configure({})
    const off = fake()
    await collect.onMeasure(off.io, measure(0.5))
    await collect.onMeasure(off.io, measure(0.6))
    expect(off.world.statuses).toEqual([undefined])
  })

  test('the timer fires the cache-expiry alert while main sits idle, and never carries a tool input', async () => {
    collect.resetForTests()
    collect.configure({ alertsEnabled: 'all' })
    const { io, world } = fake()
    const call = ev<ToolCallInput>({ tool: 'Bash', tool_use_id: 'u1', command: `export KEY=${SECRET}` })
    await collect.onToolStart(io, call)
    await collect.onToolEnd(io, call, ev<ToolCallResult>({ result: {}, text: `denied ${SECRET}`, isError: true, ref: 1 }))
    const startedAt = world.now
    world.now += 2000
    await collect.onStep(io, stepE(), stepR(400_000), startedAt)
    // the timer is capped at a minute: run them in turn, as the clock would
    let fired = 0
    while (world.alerts.log.length === 0 && fired < 10) {
      const next = [...world.timers].sort((x, z) => x.at - z.at)[0]
      if (!next) break
      world.timers.splice(world.timers.indexOf(next), 1)
      expect(next.at - world.now <= 60_000).toBe(true)
      world.now = next.at
      next.fn()
      await collect.evaluateAlerts(io)
      fired += 1
    }
    expect(world.now).toBe(startedAt + 4 * 60_000)
    expect(world.alerts.log.map(a => a.key)).toEqual(['cache-expiring'])
    expect(world.toasts[0]).toMatch(/^Prompt cache expires in 60s; re-caching 400k tokens would cost about \$2\.00$/)
    expect(JSON.stringify(world.alerts)).not.toContain(SECRET)
    // it expires: the condition clears
    world.now = startedAt + 5 * 60_000 + 1
    await collect.evaluateAlerts(io)
    expect(world.alerts.conditions['cache-expiring']?.active).toBe(false)
  })

  test('without an alerts atom the memory stays in the module; off records nothing', async () => {
    collect.resetForTests()
    collect.configure({ budgetUsd: 1 })
    const { io } = fake()
    const bare: collect.TelemetryIO = { ...io, readAlerts: undefined, updateAlerts: undefined }
    await collect.onMeasure(bare, measure(2))
    expect(collect.peekAlerts()?.log.map(a => a.key)).toEqual(['budget'])

    collect.resetForTests()
    collect.configure({ alertsEnabled: 'off', budgetUsd: 1 })
    const off = fake()
    await collect.onMeasure(off.io, measure(2))
    expect(off.world.alerts.log).toEqual([])
    expect(off.world.toasts).toEqual([])
  })
})

test('register passes its userConfig options to the rules: a critical alert toasts, the status line is set', { options: { budgetUsd: 0.01, statusLine: true } }, async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.id', () => ({ value: 'sess-T' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('settings.read', () => ({ value: {} }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 9_000, context: { tokens: 5_000, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0.02 } } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 5_000, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0.02 }, changed: ['cost'] })
  expect(toasts).toEqual(['Session cost $0.02 is over the $0.01 budget'])
  expect(statuses.at(-1)).toBe('!! budget 200% · $0.02 · ctx 1%')
})
