// Fixtures for the insights tests (hooks/insights.ts): built on emptyState so
// every figure is known.
//
// - bloatSession(): a full breakdown with an MCP server never called over 200
//   main requests (Slack, whose wire prefix differs from its /mcp name), one in
//   use (linear, partly deferred), one wholly deferred (notion), listed skills
//   (one called once), a custom agent spawned twice, a memory file and the
//   fixed rows.
// - cacheSession(at): one main request started at `at` with a 400k prompt, the
//   main loop idle.
// - workflowSession(): one root agent with 4 children running in parallel, a
//   second root that failed, a stale real agent, and an unattributed ghost.
// - agentRun(): one subagent record.

import type { TelemetryAgent, TelemetryState, TelemetryStep, TelemetryUsage } from '../types'

import { emptyState, emptyUsage } from '../hooks/model'

export const T0 = 50_000_000
export const MIN = 60_000

export function usageOf(input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number, requests = 1): TelemetryUsage {
  return { ...emptyUsage(), input, output, cacheRead, cacheWrite, costUsd, requests }
}

export function stepOf(over: Partial<TelemetryStep> & { startedAt: number }): TelemetryStep {
  const input = over.input ?? 100
  const cacheRead = over.cacheRead ?? 0
  const cacheWrite = over.cacheWrite ?? 0
  return {
    turnId: 't1',
    index: 0,
    agentId: 'main',
    model: 'claude-opus-5-5',
    effort: null,
    endedAt: over.startedAt + 3000,
    durationMs: 3000,
    messageCount: 4,
    input,
    output: 200,
    cacheRead,
    cacheWrite,
    contextTokens: input + cacheRead + cacheWrite,
    costUsd: 0.01,
    pricing: 'exact',
    stopReason: 'end_turn',
    toolUses: 0,
    toolNames: [],
    serverToolUses: 0,
    hasUsage: true,
    ...over,
  }
}

export function agentRun(s: TelemetryState, over: Partial<TelemetryAgent> & { id: string }): TelemetryAgent {
  const base = s.agents.byId.main
  if (!base) throw new Error('no main')
  const agent: TelemetryAgent = {
    ...base,
    kind: 'subagent',
    type: 'general-purpose',
    description: over.id,
    name: null,
    parentId: 'main',
    toolUseId: `tu-${over.id}`,
    model: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5'],
    requestedModel: null,
    isBackground: false,
    status: 'completed',
    firstSeenAt: T0,
    spawnedAt: T0,
    lastActiveAt: T0,
    endedAt: T0 + MIN,
    turns: 1,
    steps: 3,
    toolCalls: 2,
    toolErrors: 0,
    usage: usageOf(100, 200, 1000, 100, 0.1, 3),
    byModel: {},
    byTool: {},
    lastContextTokens: 1200,
    peakContextTokens: 1200,
    activeMs: MIN,
    report: null,
    ...over,
  }
  s.agents.byId[agent.id] = agent
  if (!s.agents.order.includes(agent.id)) s.agents.order.push(agent.id)
  return agent
}

const toolStats = (tool: string, calls: number, server: string | null, lastAt: number) => ({
  tool,
  server,
  isServerTool: false,
  calls,
  ok: calls,
  errors: 0,
  denied: 0,
  interrupted: 0,
  running: 0,
  wallMsTotal: calls * 100,
  wallMsMax: 100,
  execMsTotal: 0,
  execCount: 0,
  resultChars: 0,
  resultBytes: 0,
  lastAt,
})

export function bloatSession(): TelemetryState {
  const s = emptyState(T0 - 60 * MIN)
  const now = T0
  s.meta.mainModel = 'claude-opus-5-5'
  s.meta.mainModelFrom = 'step'
  const main = s.agents.byId.main
  if (main) {
    main.usage = usageOf(10_000, 50_000, 5_000_000, 100_000, 5, 200)
    main.lastContextTokens = 90_000
  }
  s.totals.byTool = {
    Read: toolStats('Read', 40, null, now - MIN),
    Bash: toolStats('Bash', 10, null, now - 2 * MIN),
    mcp__linear__create_issue: toolStats('mcp__linear__create_issue', 5, 'linear', now - 5 * MIN),
    Skill: toolStats('Skill', 1, null, now - 10 * MIN),
  }
  s.totals.bySkill = { docx: { calls: 1, lastAt: now - 10 * MIN } }
  agentRun(s, { id: 's1', type: 'search', spawnedAt: now - 20 * MIN })
  agentRun(s, { id: 's2', type: 'search', spawnedAt: now - 15 * MIN })
  s.context.window = 1_000_000
  s.context.tokens = 100_000
  s.context.updatedAt = now - 5 * MIN
  s.context.lastFullAt = now - 10 * MIN
  s.context.breakdown = {
    at: now - 10 * MIN,
    detail: 'full',
    model: 'claude-opus-5-5',
    totalTokens: 100_000,
    maxTokens: 1_000_000,
    percentage: 10,
    autoCompactThreshold: 800_000,
    isAutoCompactEnabled: true,
    autocompactSource: 'auto',
    categories: [
      { name: 'System prompt', tokens: 8_000, kind: 'used', color: 'promptBorder', isDeferred: false },
      { name: 'System tools', tokens: 22_000, kind: 'used', color: 'inactive', isDeferred: false },
      { name: 'MCP tools', tokens: 22_000, kind: 'used', color: 'cyan_FOR_SUBAGENTS_ONLY', isDeferred: false },
      { name: 'Custom agents', tokens: 400, kind: 'used', color: 'permission', isDeferred: false },
      { name: 'Memory files', tokens: 1_200, kind: 'used', color: 'claude', isDeferred: false },
      { name: 'Skills', tokens: 500, kind: 'used', color: 'warning', isDeferred: false },
      { name: 'Messages', tokens: 45_900, kind: 'used', color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false },
      { name: 'Free space', tokens: 717_000, kind: 'free', color: 'promptBorder', isDeferred: false },
      { name: 'Autocompact buffer', tokens: 183_000, kind: 'buffer', color: 'inactive', isDeferred: false },
      { name: 'MCP tools (deferred)', tokens: 43_000, kind: 'deferred', color: 'inactive', isDeferred: true },
    ],
    memoryFiles: [{ path: '/work/CLAUDE.md', type: 'Project', tokens: 1_200 }],
    mcpServers: [
      { server: 'notion', tools: 20, loadedTools: 0, tokens: 30_000 },
      { server: 'claude.ai Slack', tools: 10, loadedTools: 10, tokens: 20_000 },
      { server: 'linear', tools: 30, loadedTools: 4, tokens: 15_000 },
    ],
    mcpServerDetail: [
      { server: 'notion', loadedTokens: 0, wirePrefixes: ['notion'] },
      { server: 'claude.ai Slack', loadedTokens: 20_000, wirePrefixes: ['slack-conn-slack'] },
      { server: 'linear', loadedTokens: 2_000, wirePrefixes: ['linear'] },
    ],
    customAgents: [{ agentType: 'search', source: 'userSettings', tokens: 400 }],
    skills: { total: 2, included: 2, tokens: 500 },
    skillRows: [
      { name: 'pdf', source: 'plugin', pluginName: 'anthropic-skills', tokens: 300 },
      { name: 'docx', source: 'userSettings', pluginName: null, tokens: 200 },
    ],
    slashCommands: { total: 12, included: 12, tokens: 600 },
    apiUsage: null,
  }
  return s
}

/** One main request started at `at` with a 400k prompt (cache read 399.9k), main idle. */
export function cacheSession(at: number, over: Partial<TelemetryStep> = {}): TelemetryState {
  const s = emptyState(at - 60 * MIN)
  s.meta.mainModel = 'claude-opus-5-5'
  s.meta.mainModelFrom = 'step'
  s.totals.firstStepAt = at - 30 * MIN
  s.steps.push(stepOf({ startedAt: at - 10 * MIN, cacheRead: 300_000, cacheWrite: 1_000, input: 100 }))
  s.steps.push(stepOf({ startedAt: at, cacheRead: 399_900, cacheWrite: 0, input: 100, ...over }))
  const main = s.agents.byId.main
  if (main) {
    main.lastActiveAt = at + 3000
    main.status = 'idle'
  }
  return s
}

/**
 * r1 (Plan) spawned at T0, with children c1..c4 (Explore) from T0+1m to
 * T0+11m (c3 to T0+11.5m), r1 itself ending at T0+12m; r2 failed (T0+2m to
 * T0+5m); r3 a real Explore run gone quiet (stale); g1 an unattributed ghost
 * running for hours. All spawned during main turn t1.
 */
export function workflowSession(now = T0 + 40 * MIN): TelemetryState {
  const s = emptyState(T0 - 10 * MIN)
  s.meta.mainModel = 'claude-opus-5-5'
  s.meta.startedAt = T0 - 10 * MIN
  s.turns.push({
    turnId: 't1',
    agentId: 'main',
    startedAt: T0 - MIN,
    endedAt: null,
    durationMs: null,
    reason: null,
    promptChars: 10,
    steps: 1,
    toolCalls: 3,
    usage: emptyUsage(),
    engineUsage: null,
    contextTokensEnd: 0,
    model: 'claude-opus-5-5',
  })
  s.meta.activeTurns = { main: 't1' }
  agentRun(s, { id: 'r1', type: 'Plan', description: 'plan the migration', spawnedAt: T0, firstSeenAt: T0, endedAt: T0 + 12 * MIN, lastActiveAt: T0 + 12 * MIN, usage: usageOf(100, 200, 1000, 100, 0.5) })
  for (const n of [1, 2, 3, 4]) {
    const end = T0 + (n === 3 ? 11.5 : 11) * MIN
    agentRun(s, {
      id: `c${n}`,
      parentId: 'r1',
      type: 'Explore',
      description: `scan part ${n}`,
      spawnedAt: T0 + MIN,
      firstSeenAt: T0 + MIN,
      endedAt: end,
      lastActiveAt: end,
      usage: usageOf(100, 200, 1000, 100, 0.25),
    })
  }
  agentRun(s, { id: 'r2', type: 'general-purpose', description: 'try the fix', status: 'error', spawnedAt: T0 + 2 * MIN, firstSeenAt: T0 + 2 * MIN, endedAt: T0 + 5 * MIN, lastActiveAt: T0 + 5 * MIN, usage: usageOf(10, 20, 100, 10, 0.1) })
  agentRun(s, { id: 'r3', type: 'Explore', description: 'long search', status: 'running', spawnedAt: T0 + 3 * MIN, firstSeenAt: T0 + 3 * MIN, endedAt: null, lastActiveAt: now - 20 * MIN, usage: usageOf(10, 20, 100, 10, 0.05) })
  agentRun(s, {
    id: 'g1',
    kind: 'unknown',
    type: 'unknown',
    description: '',
    status: 'running',
    spawnedAt: null,
    firstSeenAt: T0 - 5 * MIN,
    endedAt: null,
    lastActiveAt: T0 - 5 * MIN,
    steps: 0,
    toolCalls: 0,
    model: null,
    models: [],
    usage: emptyUsage(),
  })
  s.totals.session = usageOf(0, 0, 0, 0, 2.0, 10)
  return s
}
