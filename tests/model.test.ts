// Pure tests of hooks/model.ts: the reducers over an in-memory TelemetryState.

import { describe, expect, test } from 'claude-code/testing'

import {
  emptyState,
  expireStaleAgents,
  hasLiveTool,
  isLiveTool,
  isStaleLoop,
  isUnattributed,
  LIMITS,
  MAIN,
  mcpServerOf,
  reconcileAgents,
  STALE_AFTER_MS,
  STALE_TOOL_MS,
  recordAgentList,
  recordAgentReport,
  recordAgentSpawn,
  recordBreakdown,
  recordCompaction,
  recordMeasure,
  recordModelSwitch,
  recordSession,
  recordStep,
  recordToolEnd,
  recordToolExec,
  recordToolStart,
  recordTurnComplete,
  recordTurnStart,
  resetState,
  toolLabel,
  utf8Length,
  type StepInput,
} from '../hooks/model'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model,
})

const step = (over: Partial<StepInput> = {}): StepInput => ({
  turnId: 't1',
  index: 0,
  model: 'claude-opus-5-5',
  messageCount: 3,
  startedAt: 1000,
  endedAt: 3000,
  usage: usage(1000, 500, 9000, 0),
  stopReason: 'end_turn',
  toolUses: [],
  ...over,
})

describe('steps', () => {
  test('accumulate into session, model, agent and turn', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 't1', text: 'hello' }, 900)
    const dirty = recordStep(s, step(), 3000)
    recordStep(s, step({ index: 1, startedAt: 3000, endedAt: 4000, usage: usage(10, 20, 10_000, 100) }), 4000)

    expect(dirty).toContain('steps')
    expect(s.totals.session.requests).toBe(2)
    expect(s.totals.session.input).toBe(1010)
    expect(s.totals.session.output).toBe(520)
    expect(s.totals.session.cacheRead).toBe(19_000)
    expect(s.totals.session.cacheWrite).toBe(100)
    expect(s.totals.steps).toBe(2)
    expect(s.totals.firstStepAt).toBe(1000)
    expect(s.totals.lastStepAt).toBe(4000)

    const perModel = s.totals.byModel['claude-opus-5-5']
    expect(perModel?.requests).toBe(2)
    expect(perModel?.label).toBe('Claude Opus 5.5')
    expect(perModel?.pricing).toBe('exact')

    const main = s.agents.byId[MAIN]
    expect(main?.steps).toBe(2)
    expect(main?.usage.requests).toBe(2)
    expect(main?.lastContextTokens).toBe(10 + 10_000 + 100)
    expect(main?.peakContextTokens).toBe(10_110)
    expect(main?.byModel['claude-opus-5-5']?.requests).toBe(2)

    const turn = s.turns.at(-1)
    expect(turn?.steps).toBe(2)
    expect(turn?.usage.requests).toBe(2)
    expect(turn?.contextTokensEnd).toBe(10_110)

    const last = s.steps.at(-1)
    expect(last?.durationMs).toBe(1000)
    expect(last?.contextTokens).toBe(10_110)
    expect(last?.agentId).toBe(MAIN)
    // the step's own cost: 10*4 + 20*20 + 10000*0.2 + 100*5 per million
    expect(Math.abs((last?.costUsd ?? 0) - (40 + 400 + 2000 + 500) / 1e6) < 1e-12).toBe(true)
    // the session's cost is the sum of its steps'
    const sum = s.steps.reduce((total, one) => total + one.costUsd, 0)
    expect(Math.abs(s.totals.session.costUsd - sum) < 1e-12).toBe(true)
  })

  test('a step without usage is counted but costs nothing', () => {
    const s = emptyState(0)
    recordStep(s, step({ usage: null, stopReason: null }), 3000)
    expect(s.totals.steps).toBe(1)
    expect(s.totals.session.requests).toBe(0)
    expect(s.steps[0]?.hasUsage).toBe(false)
    expect(s.steps[0]?.costUsd).toBe(0)
  })

  test('the ring keeps the newest and counts what fell off', () => {
    const s = emptyState(0)
    for (let i = 0; i < LIMITS.steps + 7; i += 1) recordStep(s, step({ index: i, startedAt: i, endedAt: i + 1 }), i + 1)
    expect(s.steps).toHaveLength(LIMITS.steps)
    expect(s.totals.evictedSteps).toBe(7)
    expect(s.steps[0]?.index).toBe(7)
    expect(s.totals.steps).toBe(LIMITS.steps + 7)
    expect(s.totals.session.requests).toBe(LIMITS.steps + 7)
  })

  test('a subagent step creates its agent, running', () => {
    const s = emptyState(0)
    recordStep(s, step({ agentId: 'a1', model: 'claude-haiku-5-5', usage: usage(100, 100, 0, 0, 'claude-haiku-5-5') }), 3000)
    const agent = s.agents.byId.a1
    expect(agent?.kind).toBe('unknown')
    expect(agent?.status).toBe('running')
    expect(agent?.parentId).toBe(MAIN)
    expect(agent?.model).toBe('claude-haiku-5-5')
    expect(s.agents.order).toEqual([MAIN, 'a1'])
    expect(s.agents.byId[MAIN]?.steps).toBe(0)
  })

  test('server tool uses become tool events', () => {
    const s = emptyState(0)
    recordStep(s, step({ serverToolUses: [{ id: 'srv1', name: 'advisor', startedAt: 1500, endedAt: 2500 }] }), 3000)
    expect(s.tools).toHaveLength(1)
    expect(s.tools[0]?.isServerTool).toBe(true)
    expect(s.tools[0]?.wallMs).toBe(1000)
    expect(s.totals.byTool.advisor?.calls).toBe(1)
    expect(s.totals.byTool.advisor?.isServerTool).toBe(true)
    expect(s.totals.serverToolCalls).toBe(1)
    expect(s.totals.toolCalls).toBe(0)
  })

  test('a change of the main model is recorded once it is seen on steps', () => {
    const s = emptyState(0)
    recordSession(s, { mainModel: 'opus' }, 0)
    recordStep(s, step(), 3000)
    expect(s.meta.modelSwitches).toHaveLength(0)
    expect(s.meta.mainModel).toBe('claude-opus-5-5')
    recordStep(s, step({ index: 1, usage: usage(1, 1, 0, 0, 'claude-opus-5-5') }), 3100)
    expect(s.meta.modelSwitches).toHaveLength(0)
    recordStep(s, step({ index: 2, usage: usage(1, 1, 0, 0, 'claude-sonnet-5-5') }), 3200)
    expect(s.meta.modelSwitches).toHaveLength(1)
    expect(s.meta.modelSwitches[0]?.source).toBe('observed')
    expect(s.meta.modelSwitches[0]?.to).toBe('claude-sonnet-5-5')
  })

  test('an engine model switch is not recorded twice', () => {
    const s = emptyState(0)
    recordStep(s, step(), 3000)
    recordModelSwitch(s, { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', source: 'command', cacheTtl: '1h', pricing: 'catalog' }, 3500)
    recordStep(s, step({ index: 1, usage: usage(1, 1, 0, 0, 'claude-sonnet-5-5') }), 4000)
    expect(s.meta.modelSwitches).toHaveLength(1)
    expect(s.meta.cacheTtl).toBe('1h')
    expect(s.meta.enginePricing).toBe('catalog')
    expect(s.meta.mainModelFrom).toBe('step')
  })
})

describe('turns', () => {
  test('start and complete', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 't1', text: 'abc' }, 100)
    expect(s.meta.mainTurns).toBe(1)
    expect(s.meta.activeTurns[MAIN]).toBe('t1')
    expect(s.agents.byId[MAIN]?.status).toBe('running')
    recordTurnComplete(s, { turnId: 't1', durationMs: 900, reason: 'answer', usage: usage(1, 2, 3, 4) }, 1000)
    expect(s.meta.activeTurns[MAIN]).toBeUndefined()
    expect(s.agents.byId[MAIN]?.status).toBe('idle')
    expect(s.agents.byId[MAIN]?.activeMs).toBe(900)
    const turn = s.turns[0]
    expect(turn?.promptChars).toBe(3)
    expect(turn?.durationMs).toBe(900)
    expect(turn?.reason).toBe('answer')
    expect(turn?.engineUsage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: 'claude-opus-5-5' })
  })

  test('a subagent run ends by its reason', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 'x', agentId: 'a1', text: '' }, 0)
    recordTurnComplete(s, { turnId: 'x', agentId: 'a1', durationMs: 50, reason: 'aborted' }, 50)
    expect(s.agents.byId.a1?.status).toBe('aborted')
    expect(s.agents.byId.a1?.endedAt).toBe(50)
    expect(s.meta.mainTurns).toBe(0)
  })
})

describe('tools', () => {
  test('a call from start to end', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 't1', text: '' }, 0)
    recordToolStart(s, { id: 'u1', tool: 'Bash', input: { command: 'ls -la   /tmp\nmore' } }, 100)
    expect(s.tools[0]?.status).toBe('running')
    expect(s.tools[0]?.label).toBe('ls -la /tmp more')
    expect(s.tools[0]?.turnId).toBe('t1')
    expect(s.totals.byTool.Bash?.running).toBe(1)
    recordToolExec(s, { id: 'u1', durationMs: 40 }, 150)
    recordToolEnd(s, { id: 'u1', tool: 'Bash', text: 'héllo', isReadOnly: true }, 160)
    const event = s.tools[0]
    expect(event?.status).toBe('ok')
    expect(event?.wallMs).toBe(60)
    expect(event?.execMs).toBe(40)
    expect(event?.resultChars).toBe(5)
    expect(event?.resultBytes).toBe(6)
    expect(event?.isReadOnly).toBe(true)
    const stats = s.totals.byTool.Bash
    expect(stats?.calls).toBe(1)
    expect(stats?.ok).toBe(1)
    expect(stats?.running).toBe(0)
    expect(stats?.execCount).toBe(1)
    expect(s.turns[0]?.toolCalls).toBe(1)
    expect(s.agents.byId[MAIN]?.byTool.Bash).toBe(1)
  })

  test('denied, errored and interrupted calls', () => {
    const s = emptyState(0)
    recordToolStart(s, { id: 'a', tool: 'Edit', input: { file_path: '/x' } }, 0)
    recordToolEnd(s, { id: 'a', tool: 'Edit', deny: 'protected' }, 10)
    recordToolStart(s, { id: 'b', tool: 'Bash', input: { command: 'false' } }, 0)
    recordToolEnd(s, { id: 'b', tool: 'Bash', isError: true, text: 'exit 1' }, 10)
    recordToolStart(s, { id: 'c', tool: 'Bash', input: { command: 'sleep 9' } }, 0)
    recordToolExec(s, { id: 'c', isInterrupt: true }, 5)
    recordToolEnd(s, { id: 'c', tool: 'Bash', isError: true }, 10)
    recordToolStart(s, { id: 'd', tool: 'Read', input: { file_path: '/y' } }, 0)
    recordToolEnd(s, { id: 'd', tool: 'Read', threw: true }, 10)

    expect(s.tools.map(t => t.status)).toEqual(['denied', 'error', 'interrupted', 'error'])
    expect(s.tools[0]?.error).toBe('protected')
    expect(s.totals.byTool.Edit?.denied).toBe(1)
    expect(s.totals.byTool.Bash?.errors).toBe(1)
    expect(s.totals.byTool.Bash?.interrupted).toBe(1)
    expect(s.totals.toolErrors).toBe(3)
    expect(s.agents.byId[MAIN]?.toolErrors).toBe(3)
  })

  test('labels, servers and byte lengths', () => {
    expect(toolLabel('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolLabel('mcp__linear__create_issue', { title: 'Bug' })).toBe('Bug')
    expect(toolLabel('Agent', { description: 'Find it', prompt: 'long' })).toBe('Find it')
    expect(toolLabel('X', { tool: 'X', tool_use_id: 'u', n: 1 })).toBeNull()
    expect(toolLabel('Bash', { command: 'x'.repeat(200) })?.length).toBe(80)
    expect(mcpServerOf('mcp__linear__create_issue')).toBe('linear')
    expect(mcpServerOf('Bash')).toBeNull()
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
  })

  test('the tool ring is capped', () => {
    const s = emptyState(0)
    for (let i = 0; i < LIMITS.tools + 3; i += 1) recordToolStart(s, { id: `u${i}`, tool: 'Read', input: {} }, i)
    expect(s.tools).toHaveLength(LIMITS.tools)
    expect(s.totals.evictedToolEvents).toBe(3)
    expect(s.totals.byTool.Read?.calls).toBe(LIMITS.tools + 3)
  })
})

describe('agents', () => {
  test('spawn, then its report from the Agent call', () => {
    const s = emptyState(0)
    recordAgentSpawn(
      s,
      { agentId: 'a1', subagentType: 'Explore', description: 'Map repo', background: false, fork: false, model: 'claude-haiku-5-5', toolUseId: 'tu1' },
      10,
    )
    const agent = s.agents.byId.a1
    expect(agent?.kind).toBe('subagent')
    expect(agent?.type).toBe('Explore')
    expect(agent?.status).toBe('running')
    expect(agent?.spawnedAt).toBe(10)
    expect(agent?.model).toBe('claude-haiku-5-5')
    recordAgentReport(
      s,
      null,
      {
        status: 'completed',
        agentId: 'a1',
        totalTokens: 1234,
        totalDurationMs: 5000,
        totalToolUseCount: 3,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 } },
        modelsUsed: ['claude-haiku-5-5'],
      },
      20,
    )
    expect(agent?.report?.totalTokens).toBe(1234)
    expect(agent?.report?.cacheWrite5m).toBe(4)
    expect(agent?.status).toBe('completed')
    expect(agent?.endedAt).toBe(20)
  })

  test('kinds and parents', () => {
    const s = emptyState(0)
    recordAgentSpawn(s, { agentId: 't', subagentType: 'teammate', description: '', background: true, fork: false, isTeammate: true }, 0)
    recordAgentSpawn(s, { agentId: 'f', subagentType: 'fork', description: '', background: false, fork: true, parentAgentId: 't' }, 0)
    expect(s.agents.byId.t?.kind).toBe('teammate')
    expect(s.agents.byId.f?.kind).toBe('fork')
    expect(s.agents.byId.f?.parentId).toBe('t')
    recordTurnStart(s, { turnId: 'x', agentId: 't', text: '' }, 0)
    recordTurnComplete(s, { turnId: 'x', agentId: 't', durationMs: 1, reason: 'answer' }, 1)
    expect(s.agents.byId.t?.status).toBe('idle')
  })

  test('the list fills in an agent seen only on its steps', () => {
    const s = emptyState(0)
    recordStep(s, step({ agentId: 'z' }), 1)
    const keys = recordAgentList(s, [{ id: 'z', type: 'general-purpose', description: 'Do it', status: 'completed', name: 'zed' }], 5)
    expect(keys).toEqual(['agents'])
    expect(s.agents.byId.z?.type).toBe('general-purpose')
    expect(s.agents.byId.z?.name).toBe('zed')
    expect(s.agents.byId.z?.kind).toBe('subagent')
    expect(s.agents.byId.z?.status).toBe('completed')
    expect(recordAgentList(s, [{ id: 'nobody', type: 'x', description: '', status: 'running' }], 6)).toEqual([])
  })

  test('a loop heard of only at its turn start goes stale after STALE_AFTER_MS, is settled by the sweep, and a later step revives it', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 'g', agentId: 'ghost', text: '' }, 1000)
    expect(s.agents.byId.ghost?.status).toBe('running')
    expect(isUnattributed(s.agents.byId.ghost as never)).toBe(true)
    // fresh: not stale
    expect(isStaleLoop(s, 'ghost', 1000 + STALE_AFTER_MS)).toBe(false)
    expect(expireStaleAgents(s, 1000 + STALE_AFTER_MS)).toEqual([])
    // quiet past the threshold: stale, and the sweep settles it as unknown, its open turn forgotten, its end unknown
    const later = 1000 + STALE_AFTER_MS + 1
    expect(isStaleLoop(s, 'ghost', later)).toBe(true)
    expect(expireStaleAgents(s, later).sort()).toEqual(['agents', 'meta'])
    expect(s.agents.byId.ghost?.status).toBe('unknown')
    expect(s.agents.byId.ghost?.endedAt).toBeNull()
    expect(s.meta.activeTurns.ghost).toBeUndefined()
    expect(expireStaleAgents(s, later)).toEqual([])
    // a later step of its own proves it alive again
    recordStep(s, step({ agentId: 'ghost', startedAt: later, endedAt: later + 10 }), later + 10)
    expect(s.agents.byId.ghost?.status).toBe('running')
    expect(isUnattributed(s.agents.byId.ghost as never)).toBe(false)
    expect(isStaleLoop(s, 'ghost', later + 10)).toBe(false)
  })

  test('a live tool call keeps a loop fresh; one whose end was never seen does not, past STALE_TOOL_MS', () => {
    const s = emptyState(0)
    recordAgentSpawn(s, { agentId: 'a', subagentType: 'x', description: 'slow', background: true, fork: false }, 1000)
    recordToolStart(s, { id: 'b', tool: 'Bash', agentId: 'a', input: { command: 'sleep 900' } }, 1000)
    const t = 1000 + STALE_AFTER_MS + 1
    expect(isLiveTool(s.tools[0] as never, t)).toBe(true)
    expect(hasLiveTool(s, 'a', t)).toBe(true)
    expect(isStaleLoop(s, 'a', t)).toBe(false)
    expect(expireStaleAgents(s, t)).toEqual([])
    const t2 = 1000 + STALE_TOOL_MS + 1
    expect(isLiveTool(s.tools[0] as never, t2)).toBe(false)
    expect(isStaleLoop(s, 'a', t2)).toBe(true)
    // a stale open main turn (its complete lost to a reload) is closed as idle too
    recordTurnStart(s, { turnId: 'm', text: 'x' }, 1000)
    expect(expireStaleAgents(s, t2).sort()).toEqual(['agents', 'meta'])
    expect(s.agents.byId.a?.status).toBe('unknown')
    expect(s.agents.byId[MAIN]?.status).toBe('idle')
    expect(s.meta.activeTurns).toEqual({})
  })

  test('reconcile applies the engine list to running loops, then sweeps the quiet ones', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 't1', agentId: 'listed', text: '' }, 1000)
    recordTurnStart(s, { turnId: 't2', agentId: 'fork', text: '' }, 1000)
    recordTurnStart(s, { turnId: 't3', agentId: 'busy', text: '' }, 1000)
    const now = 1000 + STALE_AFTER_MS + 1
    recordToolStart(s, { id: 'r', tool: 'Read', agentId: 'busy', input: { file_path: '/x' } }, now - 10)
    const keys = reconcileAgents(s, [{ id: 'listed', type: 'Explore', description: 'map', status: 'completed' }], now)
    expect(keys.sort()).toEqual(['agents', 'meta'])
    // listed as over: completed with its end at the list's time, its open turn forgotten
    expect(s.agents.byId.listed).toMatchObject({ status: 'completed', endedAt: now, kind: 'subagent', type: 'Explore' })
    // not listed and quiet: settled as unknown
    expect(s.agents.byId.fork?.status).toBe('unknown')
    // not listed but active: still running
    expect(s.agents.byId.busy?.status).toBe('running')
    expect(Object.keys(s.meta.activeTurns)).toEqual(['busy'])
    // no list at all: the sweep alone
    expect(reconcileAgents(s, null, now)).toEqual([])
  })

  test('the agent map is capped, finished agents leave first', () => {
    const s = emptyState(0)
    for (let i = 0; i < LIMITS.agents + 5; i += 1) {
      recordAgentSpawn(s, { agentId: `a${i}`, subagentType: 'x', description: '', background: false, fork: false }, i)
      recordTurnComplete(s, { turnId: `t${i}`, agentId: `a${i}`, durationMs: 0, reason: 'answer' }, i)
    }
    expect(s.agents.order.length).toBe(LIMITS.agents)
    // main + 205 spawned = 206 entries for 200 seats
    expect(s.agents.evicted).toBe(6)
    expect(s.agents.byId.a0).toBeUndefined()
    expect(s.agents.byId[`a${LIMITS.agents + 4}`]).toBeDefined()
    expect(s.agents.byId[MAIN]).toBeDefined()
  })
})

describe('context', () => {
  test('measure keeps one history point per main turn', () => {
    const s = emptyState(0)
    recordTurnStart(s, { turnId: 't1', text: '' }, 0)
    recordMeasure(s, { context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12.5 }], cost: { usd: 0.5 }, changed: ['context', 'cost'] }, 10)
    recordMeasure(s, { context: { tokens: 1200, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] }, 11)
    expect(s.context.history).toHaveLength(1)
    expect(s.context.history[0]?.tokens).toBe(1200)
    recordTurnStart(s, { turnId: 't2', text: '' }, 20)
    recordMeasure(s, { context: { tokens: 3000, window: 200_000, percent: 2 }, rateLimits: [], changed: ['context'] }, 30)
    expect(s.context.history.map(p => p.tokens)).toEqual([1200, 3000])
    expect(s.context.engineCostUsd).toBe(0.5)
    expect(s.context.tokens).toBe(3000)
    recordMeasure(s, { context: { window: 200_000 }, rateLimits: [], changed: ['context'] }, 40)
    expect(s.context.tokens).toBeNull()
    expect(s.context.history).toHaveLength(2)
  })

  test('breakdown is condensed', () => {
    const s = emptyState(0)
    recordBreakdown(
      s,
      {
        categories: [
          { name: 'System prompt', tokens: 3000, kind: 'used', color: 'promptBorder', isDeferred: false },
          { name: 'Free space', tokens: 150_000, kind: 'free', color: 'inactive', isDeferred: false },
          { name: 'Autocompact buffer', tokens: 45_000, kind: 'buffer', color: 'warning', isDeferred: false },
        ],
        totalTokens: 5000,
        maxTokens: 200_000,
        percentage: 3,
        autocompactSource: 'auto',
        model: 'claude-opus-5-5',
        memoryFiles: [
          { path: '/a', type: 'User', tokens: 10 },
          { path: '/b', type: 'Project', tokens: 300 },
        ],
        mcpTools: [
          { name: 'mcp__s__a', serverName: 's', tokens: 100, isLoaded: true },
          { name: 'mcp__s__b', serverName: 's', tokens: 50, isLoaded: false },
        ],
        agents: [],
        isAutoCompactEnabled: true,
        autoCompactThreshold: 155_000,
        apiUsage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      },
      'full',
      99,
    )
    const b = s.context.breakdown
    expect(b?.memoryFiles[0]?.path).toBe('/b')
    expect(b?.mcpServers).toEqual([{ server: 's', tools: 2, loadedTools: 1, tokens: 150 }])
    expect(b?.apiUsage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
    expect(s.context.lastFullAt).toBe(99)
  })

  test('compactions are priced at the main model', () => {
    const s = emptyState(0)
    recordStep(s, step(), 1)
    recordCompaction(s, { trigger: 'auto', tokensBefore: 150_000, tokensAfter: 20_000, usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, 2)
    expect(Math.abs((s.context.compactions[0]?.costUsd ?? 0) - 4) < 1e-9).toBe(true)
    expect(s.context.compactions[0]?.agentId).toBe(MAIN)
    recordCompaction(s, { trigger: 'manual', skip: 'blocked' }, 3)
    expect(s.context.compactions[1]?.skipped).toBe('blocked')
  })
})

test('reset starts over and counts', () => {
  const s = emptyState(0)
  recordStep(s, step(), 1)
  const next = resetState(s, 50)
  expect(next.totals.steps).toBe(0)
  expect(next.meta.resets).toBe(1)
  expect(next.meta.firstSeenAt).toBe(50)
  expect(resetState(next, 60).meta.resets).toBe(2)
})
