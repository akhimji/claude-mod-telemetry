// Through the engine's own test kit: the hooks module loads, every event is passed
// on unchanged, and what it records reaches `$.state` under the shape tag.
// The test's `on` hooks sit beneath the plugin and stand for the engine; its
// `state.set` hook watches the writes on their way to the kit's own store.

import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import type { TelemetryState } from '../types'

import { emptyState } from '../hooks/model'

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 2_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 995_000, color: 'inactive', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 5_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'auto',
  percentage: 1,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [{ path: '/work/CLAUDE.md', type: 'Project', tokens: 400 }],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 4_970, cache_creation_input_tokens: 0 },
}

/** The engine beneath the plugin: session facts, and a record of every state write. */
function world(on: On) {
  const written: Partial<Record<keyof TelemetryState, { shape: string; value: unknown }>> = {}
  on('session.id', () => ({ value: 'sess-T' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('settings.read', () => ({ value: {} }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 9_000,
      context: { tokens: 5_000, window: 1_000_000, percent: 1, ...(e.breakdown ? { breakdown: BREAKDOWN } : {}) },
      rateLimits: [],
      cost: { usd: 0.02 },
    },
  }))
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry') written[e.key as keyof TelemetryState] = e.value as { shape: string; value: unknown }
    return next(e)
  })
  const get = <K extends keyof TelemetryState>(key: K): TelemetryState[K] | undefined => {
    const entry = written[key]
    expect(entry === undefined || entry.shape === 'v1', `${key} is kept under the shape tag`).toBe(true)
    return entry?.value as TelemetryState[K] | undefined
  }
  return { get }
}

test('a turn is recorded and every event passes through unchanged', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  const { get } = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 4_970, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
  on('tool.call', () => ({ result: { stdout: 'a b', stderr: '' }, text: 'a b' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect((await $.turn.start({ turnId: 't1', text: 'hello' })).turnId).toBe('t1')

  // the stream's own end carries the step's result as the plugin passed it up
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  const step = next.value
  expect(step.answer).toBe('hi')
  expect(step.usage?.output_tokens).toBe(20)

  await clock.advance(250)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.text).toBe('a b')
  expect(ran.isError).toBeUndefined()

  const done = await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 500, isAborted: false, reason: 'answer' })
  expect(done.text).toBe('hi')

  const measured = await $.session.measure({
    context: { tokens: 5_000, window: 1_000_000, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
    cost: { usd: 0.02 },
    changed: ['context', 'cost'],
  })
  expect(measured.changed).toEqual(['context', 'cost'])
  await clock.settle() // the deferred context breakdown

  const totals = get('totals')
  expect(totals?.steps).toBe(1)
  expect(totals?.session.requests).toBe(1)
  expect(totals?.session.cacheRead).toBe(4_970)
  expect(totals?.toolCalls).toBe(1)
  expect(totals?.byModel['claude-opus-5-5']?.label).toBe('Claude Opus 5.5')

  const tools = get('tools') ?? []
  expect(tools).toHaveLength(1)
  expect(tools[0]?.tool).toBe('Bash')
  expect(tools[0]?.status).toBe('ok')
  expect(tools[0]?.label).toBe('ls')
  expect(tools[0]?.turnId).toBe('t1')
  expect(tools[0]?.resultBytes).toBe(3)

  const meta = get('meta')
  expect(meta?.sessionId).toBe('sess-T')
  expect(meta?.startedAt).toBe(9_000)
  expect(meta?.mainTurns).toBe(1)
  expect(meta?.mainModel).toBe('claude-opus-5-5')
  expect(meta?.managedPricingSet).toBe(false)

  const agents = get('agents')
  expect(agents?.byId.main?.status).toBe('idle')
  expect(agents?.byId.main?.activeMs).toBe(500)

  const context = get('context')
  expect(context?.engineCostUsd).toBe(0.02)
  expect(context?.history.map(point => point.tokens)).toEqual([5_000])
  expect(context?.rateLimits[0]?.percentUsed).toBe(12)
  expect(context?.breakdown?.detail).toBe('full')
  expect(context?.breakdown?.memoryFiles[0]?.path).toBe('/work/CLAUDE.md')
  expect(context?.breakdownError).toBeNull()
})

test('after a reload the module reads the stored values back through its atoms and goes on', async ($, on) => {
  mock.clock(on, { now: 50_000 })
  // what an earlier load of the module left in the host's state, in the stored form
  const before = emptyState(1_000)
  before.totals.steps = 5
  before.totals.session.requests = 5
  before.meta.sessionId = 'sess-T'
  before.meta.mainTurns = 2
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry') return next(e)
    const value = e.key === 'totals' ? before.totals : e.key === 'meta' ? before.meta : undefined
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: 3 } }
  })
  const { get } = world(on)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' } }
  })
  const stream = $.turn.step({ turnId: 't9', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  expect(get('totals')?.steps).toBe(6)
  expect(get('totals')?.session.requests).toBe(6)
  expect(get('meta')?.mainTurns).toBe(2)
  expect(get('meta')?.firstSeenAt).toBe(1_000)
})

test('a tool the chain refuses is recorded as denied and the refusal passes up', async ($, on) => {
  mock.clock(on, { now: 0 })
  const { get } = world(on)
  on('tool.call', () => ({ deny: 'not here' }))

  const ran = await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' })
  expect(ran.deny).toBe('not here')
  const tools = get('tools') ?? []
  expect(tools[0]?.status).toBe('denied')
  expect(tools[0]?.error).toBe('not here')
  expect(tools[0]?.label).toBe('/etc/hosts')
})

test('when the chain beneath rejects, the call is recorded as an error and the rejection reaches the caller', async ($, on) => {
  mock.clock(on, { now: 0 })
  const { get } = world(on)
  on('tool.call', () => {
    throw new Error('tool exploded')
  })
  let caught: unknown
  try {
    await $.tool.call({ tool: 'Bash', command: 'boom' })
  } catch (err) {
    caught = err
  }
  // the kit skips the failing hook and its bottom then rejects ("no implementation")
  expect(caught).toBeDefined()
  const tools = get('tools') ?? []
  expect(tools[0]?.status).toBe('error')
  expect(tools[0]?.endedAt).toBe(0)
})
