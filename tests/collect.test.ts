// Tests of hooks/collect.ts over a fake IO: hydration, coalesced writes, guards,
// the deferred context breakdown, resets. No engine needed.

import { describe, expect, test } from 'claude-code/testing'
import type {
  AgentSpawnInput,
  AgentSpawnResult,
  SessionMeasureInput,
  ToolCallInput,
  ToolCallResult,
  TurnCompleteInput,
  TurnStartInput,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { TelemetryState } from '../types'

import * as collect from '../hooks/collect'
import { emptyState, STALE_AFTER_MS, type BreakdownInput, type StateKey } from '../hooks/model'

const ev = <T>(value: unknown): T => value as T

const BREAKDOWN: BreakdownInput = {
  categories: [{ name: 'Messages', tokens: 10, kind: 'used', color: 'permission', isDeferred: false }],
  totalTokens: 10,
  maxTokens: 100,
  percentage: 10,
  autocompactSource: 'auto',
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
}

function fake(store = new Map<StateKey, unknown>()) {
  const world = {
    now: 1_000,
    store,
    writes: [] as StateKey[],
    logs: [] as string[],
    timers: [] as (() => void)[],
    breakdowns: [] as string[],
    failWrites: false,
    agentListCalls: 0,
  }
  const io: collect.TelemetryIO = {
    now: async () => world.now,
    readState: async () => {
      const base = emptyState(0)
      const pick = <K extends StateKey>(key: K): TelemetryState[K] => (store.has(key) ? (store.get(key) as TelemetryState[K]) : base[key])
      return {
        totals: pick('totals'),
        agents: pick('agents'),
        steps: pick('steps'),
        tools: pick('tools'),
        turns: pick('turns'),
        context: pick('context'),
        meta: pick('meta'),
      }
    },
    writeState: async (key, s) => {
      if (world.failWrites) throw new Error('state is gone')
      world.writes.push(key)
      store.set(key, JSON.parse(JSON.stringify(s[key])))
    },
    log: text => {
      world.logs.push(text)
    },
    sessionId: async () => 'session-1',
    sessionStartedAt: async () => 500,
    sessionModel: async () => 'claude-opus-5-5',
    sessionCwd: async () => '/work',
    managedPricing: async () => undefined,
    breakdown: async detail => {
      world.breakdowns.push(detail)
      return BREAKDOWN
    },
    agentList: async () => {
      world.agentListCalls += 1
      return [{ id: 'z9', type: 'general-purpose', description: 'Side quest', status: 'running' }]
    },
    after: (_ms, fn) => {
      world.timers.push(fn)
    },
  }
  return { io, world }
}

const stored = <K extends StateKey>(store: Map<StateKey, unknown>, key: K): TelemetryState[K] => store.get(key) as TelemetryState[K]

const stepE = (over: Record<string, unknown> = {}) => ev<TurnStepInput>({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...over })

const stepR = (over: Record<string, unknown> = {}) =>
  ev<TurnStepResult>({
    turnId: 't1',
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    ...over,
  })

describe('collect', () => {
  test('a turn with a tool call ends up in the atoms', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    await collect.onSessionStart(io, ev({ cwd: '/work', surface: 'terminal', isInteractive: true }))
    await collect.onTurnStart(io, ev<TurnStartInput>({ turnId: 't1', text: 'hi' }))
    world.now = 1_100
    const call = ev<ToolCallInput>({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' })
    await collect.onToolStart(io, call)
    world.now = 1_400
    await collect.onToolEnd(io, call, ev<ToolCallResult>({ result: {}, text: 'a\nb', ref: 1 }))
    world.now = 2_000
    await collect.onStep(io, stepE(), stepR(), 1_000)
    await collect.onTurnComplete(io, ev<TurnCompleteInput>({ turnId: 't1', durationMs: 1_000, reason: 'answer', answer: '', isAborted: false }))

    const meta = stored(world.store, 'meta')
    expect(meta.sessionId).toBe('session-1')
    expect(meta.startedAt).toBe(500)
    expect(meta.cwd).toBe('/work')
    expect(meta.isInteractive).toBe(true)
    expect(meta.managedPricingSet).toBe(false)
    expect(meta.mainTurns).toBe(1)
    const totals = stored(world.store, 'totals')
    expect(totals.steps).toBe(1)
    expect(totals.toolCalls).toBe(1)
    expect(totals.byTool.Bash?.wallMsTotal).toBe(300)
    const tools = stored(world.store, 'tools')
    expect(tools[0]?.status).toBe('ok')
    expect(tools[0]?.label).toBe('ls')
    expect(tools[0]?.resultBytes).toBe(3)
    expect(stored(world.store, 'steps')[0]?.durationMs).toBe(1_000)
    expect(stored(world.store, 'agents').byId.main?.status).toBe('idle')
    expect(world.logs).toEqual([])
  })

  test('after a reload the state is read back and goes on', async () => {
    collect.resetForTests()
    const first = fake()
    await collect.onStep(first.io, stepE(), stepR(), 1_000)
    collect.resetForTests() // a fresh module environment, same host state
    const second = fake(first.world.store)
    await collect.onStep(second.io, stepE({ index: 1 }), stepR({ index: 1 }), 1_000)
    const totals = stored(second.world.store, 'totals')
    expect(totals.steps).toBe(2)
    expect(totals.session.requests).toBe(2)
    expect(stored(second.world.store, 'steps')).toHaveLength(2)
  })

  test('a burst of events writes each atom with its latest value', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    await collect.onStep(io, stepE(), stepR(), 1_000)
    world.writes.length = 0
    await Promise.all([0, 1, 2, 3, 4].map(i => collect.onStep(io, stepE({ index: i + 1 }), stepR({ index: i + 1 }), 1_000)))
    expect(stored(world.store, 'totals').steps).toBe(6)
    expect(stored(world.store, 'steps')).toHaveLength(6)
    // fewer writes of `steps` than events: later ones joined the write in flight
    expect(world.writes.filter(key => key === 'steps').length < 5).toBe(true)
  })

  test('a failure is contained by guard and logged once', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    world.failWrites = true
    let threw = false
    try {
      await collect.guard(io, 'turn.step', () => collect.onStep(io, stepE(), stepR(), 1_000))
      await collect.guard(io, 'turn.step', () => collect.onStep(io, stepE({ index: 1 }), stepR({ index: 1 }), 1_000))
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]).toMatch(/turn\.step failed .*state is gone/)
    // the next write lands once the host takes writes again
    world.failWrites = false
    await collect.guard(io, 'turn.step', () => collect.onStep(io, stepE({ index: 2 }), stepR({ index: 2 }), 1_000))
    expect(stored(world.store, 'totals').steps).toBe(3)
  })

  test('the breakdown runs off the dispatch: full first, then summary, full again later', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    const measure = (tokens: number) =>
      ev<SessionMeasureInput>({ context: { tokens, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: 0.01 }, changed: ['context', 'cost'] })
    await collect.onMeasure(io, measure(1_000))
    expect(world.breakdowns).toEqual([])
    expect(world.timers).toHaveLength(1)
    world.timers.shift()?.()
    await collect.refreshContext(io, 'auto') // joins the run the timer started
    expect(world.breakdowns).toEqual(['full'])
    expect(stored(world.store, 'context').breakdown?.detail).toBe('full')
    expect(stored(world.store, 'context').engineCostUsd).toBe(0.01)

    world.now += 60_000
    await collect.onMeasure(io, measure(2_000))
    world.timers.shift()?.()
    await collect.refreshContext(io, 'auto')
    expect(world.breakdowns).toEqual(['full', 'summary'])

    world.now += collect.FULL_BREAKDOWN_EVERY_MS
    await collect.refreshContext(io, 'auto')
    expect(world.breakdowns).toEqual(['full', 'summary', 'full'])
    await collect.refreshContext(io, 'summary')
    expect(world.breakdowns.at(-1)).toBe('summary')
  })

  test('/clear starts over; an exit keeps the record', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    await collect.onStep(io, stepE(), stepR(), 1_000)
    await collect.onSessionEnd(io, ev({ reason: 'prompt_input_exit' }))
    expect(stored(world.store, 'totals').steps).toBe(1)
    world.writes.length = 0
    await collect.onSessionEnd(io, ev({ reason: 'clear' }))
    expect(stored(world.store, 'totals').steps).toBe(0)
    expect(stored(world.store, 'meta').resets).toBe(1)
    expect([...new Set(world.writes)].sort()).toEqual(['agents', 'context', 'meta', 'steps', 'tools', 'totals', 'turns'])
  })

  test('a reload settles loops whose end was lost while the module was down; session start checks the engine list', async () => {
    collect.resetForTests()
    const first = fake()
    // a loop heard of at its turn start (an engine fork, a spawn under a hook that could not hear it) and a real spawn
    await collect.onTurnStart(first.io, ev<TurnStartInput>({ turnId: 'f1', agentId: 'fork', text: '' }))
    await collect.onAgentSpawn(
      first.io,
      ev<AgentSpawnInput>({ tool_use_id: 'tu2', prompt: 'go', description: 'Side job', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', background: true, fork: false, provider: { plugin: 'engine', tier: 'core' } }),
      ev<AgentSpawnResult>({ model: 'claude-haiku-5-5', agentId: 'bg' }),
    )
    expect(stored(first.world.store, 'agents').byId.fork?.status).toBe('running')
    expect(stored(first.world.store, 'meta').activeTurns.fork).toBe('f1')
    // the module reloads, STALE_AFTER_MS and more later; both ends were missed meanwhile
    collect.resetForTests()
    const second = fake(first.world.store)
    second.world.now = first.world.now + STALE_AFTER_MS + 1
    await collect.onStep(second.io, stepE(), stepR(), second.world.now - 10)
    const agents = stored(second.world.store, 'agents')
    expect(agents.byId.fork?.status).toBe('unknown')
    expect(agents.byId.bg?.status).toBe('unknown')
    expect(stored(second.world.store, 'meta').activeTurns.fork).toBeUndefined()
    // session start (also each hot reload) asks the engine's list: what it says is over is over
    collect.resetForTests()
    const third = fake(first.world.store)
    third.world.now = second.world.now + 1000
    const bg = stored(third.world.store, 'agents').byId.bg
    if (bg) bg.status = 'running'
    third.world.store.set('agents', stored(third.world.store, 'agents'))
    third.io.agentList = async () => [{ id: 'bg', type: 'general-purpose', description: 'Side job', status: 'completed' }]
    await collect.onSessionStart(third.io, ev({ cwd: '/work', surface: 'terminal', isInteractive: true }))
    expect(stored(third.world.store, 'agents').byId.bg?.status).toBe('completed')
  })

  test('a loop first heard of at its turn start is looked up in the engine list at once', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    await collect.onTurnStart(io, ev<TurnStartInput>({ turnId: 'z1', agentId: 'z9', text: 'go' }))
    expect(world.agentListCalls).toBe(1)
    expect(stored(world.store, 'agents').byId.z9).toMatchObject({ kind: 'subagent', type: 'general-purpose', description: 'Side quest', status: 'running' })
    await collect.onTurnStart(io, ev<TurnStartInput>({ turnId: 'z2', agentId: 'z9', text: 'again' }))
    expect(world.agentListCalls).toBe(1)
  })

  test('agents: spawn, foreground report, and an unknown one filled in once', async () => {
    collect.resetForTests()
    const { io, world } = fake()
    const call = ev<ToolCallInput>({ tool: 'Agent', tool_use_id: 'tu1', description: 'Map repo', prompt: 'go', subagent_type: 'Explore' })
    await collect.onToolStart(io, call)
    await collect.onAgentSpawn(
      io,
      ev<AgentSpawnInput>({ tool_use_id: 'tu1', prompt: 'go', description: 'Map repo', subagentType: 'Explore', parentModel: 'claude-opus-5-5', background: false, fork: false, provider: { plugin: 'engine', tier: 'core' } }),
      ev<AgentSpawnResult>({ model: 'claude-haiku-5-5', agentId: 'a1' }),
    )
    await collect.onAgentToolEnd(
      io,
      call,
      ev<ToolCallResult>({ result: { status: 'completed', agentId: 'a1', totalTokens: 99, totalDurationMs: 10, totalToolUseCount: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, text: 'done' }),
    )
    const a1 = stored(world.store, 'agents').byId.a1
    expect(a1?.type).toBe('Explore')
    expect(a1?.toolUseId).toBe('tu1')
    expect(a1?.report?.totalTokens).toBe(99)
    expect(a1?.status).toBe('completed')

    await collect.onStep(io, stepE({ agentId: 'z9' }), stepR(), 1_000)
    await collect.onStep(io, stepE({ agentId: 'z9', index: 1 }), stepR({ index: 1 }), 1_000)
    expect(world.agentListCalls).toBe(1)
    expect(stored(world.store, 'agents').byId.z9?.description).toBe('Side quest')
  })
})
