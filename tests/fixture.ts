// A populated TelemetryState for the pane's render tests: a main loop with two
// models, three subagents (one nested, one running), tools including MCP and a
// running Bash call whose label holds a fake secret, a context breakdown, rate
// limits, compactions and an engine ledger that drifts from the estimate.
// `ledgerGap()` is the same session as the mod saw it when loaded mid-session
// into a long one: a ledger of $1200.00 against $0.63 tracked, the main loop's
// first sight at 0 (the atoms' initial value) and no engine start time.

import type { TelemetryState, TelemetryUsage } from '../types'

import { emptyState, emptyUsage } from '../hooks/model'

export const NOW = 10_000_000
export const SECRET = 'sk-test-SECRET-do-not-show'

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number): TelemetryUsage {
  return { ...emptyUsage(), input, output, cacheRead, cacheWrite, requests: Math.max(1, Math.round(output / 500)), costUsd, cacheSavedUsd: costUsd * 0.4 }
}

export function populated(): TelemetryState {
  const s = emptyState(NOW - 3_600_000)
  const start = NOW - 3_600_000
  s.meta.sessionId = 'sess-fixture'
  s.meta.startedAt = start
  s.meta.mainModel = 'claude-opus-5-5'
  s.meta.mainModelFrom = 'session'
  s.meta.mainTurns = 6
  s.meta.activeTurns = { main: 't6' }

  s.totals.session = usage(12_000, 45_000, 1_100_000, 80_000, 3.21)
  s.totals.byModel = {
    'claude-opus-5-5': { ...usage(10_000, 40_000, 1_000_000, 70_000, 3.0), model: 'claude-opus-5-5', label: 'Claude Opus 5.5', family: 'opus', pricing: 'exact', lastAt: NOW - 1000 },
    'claude-haiku-5-5': { ...usage(2_000, 5_000, 100_000, 10_000, 0.21), model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', family: 'haiku', pricing: 'exact', lastAt: NOW - 5000 },
    'claude-sonnet-9': { ...usage(10, 10, 0, 0, 0.0001), model: 'claude-sonnet-9', label: 'Claude Sonnet 5.5', family: 'sonnet', pricing: 'family', lastAt: NOW - 9000 },
  }
  const tool = (name: string, calls: number, errors: number, server: string | null = null) => ({
    tool: name,
    server,
    isServerTool: false,
    calls,
    ok: calls - errors,
    errors,
    denied: 0,
    interrupted: 0,
    running: name === 'Bash' ? 1 : 0,
    wallMsTotal: calls * 420,
    wallMsMax: 3000,
    execMsTotal: calls * 300,
    execCount: calls,
    resultChars: calls * 4000,
    resultBytes: calls * 4100,
    lastAt: NOW - 2000,
  })
  s.totals.byTool = {
    Read: tool('Read', 42, 0),
    Bash: tool('Bash', 31, 4),
    Edit: tool('Edit', 12, 1),
    Grep: tool('Grep', 9, 0),
    Agent: tool('Agent', 3, 0),
    mcp__linear__create_issue: tool('mcp__linear__create_issue', 2, 1, 'linear'),
  }
  s.totals.steps = 90
  s.totals.toolCalls = 99
  s.totals.toolErrors = 6
  s.totals.firstStepAt = start + 10_000
  s.totals.lastStepAt = NOW - 1000

  const main = s.agents.byId.main
  if (main) {
    main.status = 'running'
    main.turns = 6
    main.steps = 60
    main.usage = usage(9_000, 30_000, 900_000, 60_000, 2.5)
    main.model = 'claude-opus-5-5'
    main.models = ['claude-opus-5-5']
    main.byModel = { 'claude-opus-5-5': { requests: 60, tokens: 999_000, costUsd: 2.5 } }
    main.byTool = { Read: 30, Bash: 31, Edit: 12, Agent: 3, mcp__linear__create_issue: 2 }
    main.activeMs = 1_200_000
    main.lastContextTokens = 450_000
    main.peakContextTokens = 460_000
  }
  const sub = (id: string, parentId: string, type: string, description: string, status: 'running' | 'completed' | 'error', cost: number) => {
    s.agents.byId[id] = {
      ...(s.agents.byId.main ?? ({} as never)),
      id,
      kind: 'subagent',
      type,
      description,
      name: null,
      parentId,
      toolUseId: `tu-${id}`,
      model: 'claude-haiku-5-5',
      models: ['claude-haiku-5-5'],
      requestedModel: 'haiku',
      isBackground: id === 'a3',
      status,
      firstSeenAt: NOW - 600_000,
      spawnedAt: NOW - 600_000,
      lastActiveAt: NOW - 1000,
      endedAt: status === 'running' ? null : NOW - 60_000,
      turns: 1,
      steps: 10,
      toolCalls: 12,
      toolErrors: status === 'error' ? 2 : 0,
      usage: usage(1_000, 5_000, 80_000, 8_000, cost),
      byModel: { 'claude-haiku-5-5': { requests: 10, tokens: 94_000, costUsd: cost } },
      byTool: { Read: 8, Grep: 4 },
      lastContextTokens: 30_000,
      peakContextTokens: 42_000,
      activeMs: 500_000,
      report:
        status === 'completed'
          ? { status: 'completed', totalTokens: 94_000, totalDurationMs: 540_000, totalToolUseCount: 12, input: 1000, output: 5000, cacheRead: 80000, cacheWrite: 8000, cacheWrite5m: 8000, cacheWrite1h: 0, modelsUsed: ['claude-haiku-5-5'] }
          : null,
    }
    s.agents.order.push(id)
  }
  sub('a1', 'main', 'Explore', 'find every caller of the pricing table across the repository', 'completed', 0.3)
  sub('a2', 'a1', 'general-purpose', 'nested check', 'error', 0.1)
  sub('a3', 'main', 'Plan', 'draft the plan', 'running', 0.2)

  for (let i = 0; i < 30; i += 1) {
    s.steps.push({
      turnId: `t${1 + Math.floor(i / 5)}`,
      index: i % 5,
      agentId: 'main',
      model: 'claude-opus-5-5',
      effort: null,
      startedAt: NOW - (30 - i) * 60_000,
      endedAt: NOW - (30 - i) * 60_000 + 4000,
      durationMs: 4000,
      messageCount: 10 + i,
      input: 100,
      output: 900 + i * 10,
      cacheRead: 30_000 + i * 1000,
      cacheWrite: 1000,
      contextTokens: 31_100 + i * 1000,
      costUsd: 0.05 + i * 0.002,
      pricing: 'exact',
      stopReason: 'tool_use',
      toolUses: 1,
      toolNames: ['Read'],
      serverToolUses: 0,
      hasUsage: true,
    })
  }
  const names = ['Read', 'Edit', 'Grep', 'WebFetch', 'mcp__linear__create_issue']
  for (let i = 0; i < 25; i += 1) {
    const t = names[i % names.length] ?? 'Read'
    s.tools.push({
      id: `call-${i}`,
      tool: t,
      server: t.startsWith('mcp__') ? 'linear' : null,
      agentId: i % 7 === 0 ? 'a1' : 'main',
      turnId: 't5',
      label: t === 'WebFetch' ? 'https://example.com/api/items?token=abc123' : t === 'Read' ? '/Users/someone/project/src/very/deep/file.ts' : 'pattern',
      startedAt: NOW - (25 - i) * 30_000,
      endedAt: NOW - (25 - i) * 30_000 + 500,
      wallMs: 500 + i * 10,
      execMs: 400,
      status: i === 3 ? 'error' : 'ok',
      resultChars: 3000,
      resultBytes: 3100,
      isReadOnly: true,
      isServerTool: false,
      error: i === 3 ? 'not found' : null,
    })
  }
  s.tools.push({
    id: 'call-bash',
    tool: 'Bash',
    server: null,
    agentId: 'main',
    turnId: 't6',
    label: `export API_KEY=${SECRET} && deploy`,
    startedAt: NOW - 7000,
    endedAt: null,
    wallMs: null,
    execMs: null,
    status: 'running',
    resultChars: null,
    resultBytes: null,
    isReadOnly: false,
    isServerTool: false,
    error: null,
  })
  s.tools.push({
    id: 'call-bash-err',
    tool: 'Bash',
    server: null,
    agentId: 'main',
    turnId: 't6',
    label: `curl -H "Authorization: ${SECRET}"`,
    startedAt: NOW - 9000,
    endedAt: NOW - 8000,
    wallMs: 1000,
    execMs: 900,
    status: 'error',
    resultChars: 10,
    resultBytes: 10,
    isReadOnly: false,
    isServerTool: false,
    error: `401 for ${SECRET}`,
  })

  for (let i = 1; i <= 6; i += 1) {
    const running = i === 6
    s.turns.push({
      turnId: `t${i}`,
      agentId: 'main',
      startedAt: NOW - (7 - i) * 300_000,
      endedAt: running ? null : NOW - (7 - i) * 300_000 + 120_000,
      durationMs: running ? null : 120_000,
      reason: running ? null : i === 3 ? 'aborted' : 'answer',
      promptChars: 200,
      steps: 5,
      toolCalls: 6,
      usage: usage(1500, 5000, 150_000, 10_000, 0.3 + i * 0.05),
      engineUsage: null,
      contextTokensEnd: 300_000 + i * 25_000,
      model: 'claude-opus-5-5',
    })
  }

  s.context = {
    updatedAt: NOW - 1000,
    window: 1_000_000,
    tokens: 450_000,
    percent: 45,
    breakdown: {
      at: NOW - 120_000,
      detail: 'full',
      model: 'claude-opus-5-5',
      totalTokens: 450_000,
      maxTokens: 1_000_000,
      percentage: 45,
      autoCompactThreshold: 800_000,
      isAutoCompactEnabled: true,
      autocompactSource: 'auto',
      categories: [
        { name: 'System prompt', tokens: 8_000, kind: 'used', color: 'promptBorder', isDeferred: false },
        { name: 'System tools', tokens: 22_000, kind: 'used', color: 'inactive', isDeferred: false },
        { name: 'MCP tools', tokens: 15_000, kind: 'used', color: 'cyan_FOR_SUBAGENTS_ONLY', isDeferred: false },
        { name: 'Memory files', tokens: 5_000, kind: 'used', color: 'claude', isDeferred: false },
        { name: 'Skills', tokens: 3_000, kind: 'used', color: 'warning', isDeferred: false },
        { name: 'Messages', tokens: 397_000, kind: 'used', color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false },
        { name: 'Free space', tokens: 467_000, kind: 'free', color: 'promptBorder', isDeferred: false },
        { name: 'Autocompact buffer', tokens: 83_000, kind: 'buffer', color: 'inactive', isDeferred: false },
        { name: 'Deferred MCP tools', tokens: 40_000, kind: 'deferred', color: 'inactive', isDeferred: true },
      ],
      memoryFiles: [
        { path: '/Users/someone/.claude/CLAUDE.md', type: 'User', tokens: 1200 },
        { path: '/Users/someone/project/CLAUDE.md', type: 'Project', tokens: 3800 },
      ],
      mcpServers: [{ server: 'linear', tools: 30, loadedTools: 4, tokens: 15_000 }],
      customAgents: [{ agentType: 'search', source: 'user', tokens: 400 }],
      skills: { total: 40, included: 12, tokens: 3_000 },
      slashCommands: { total: 20, included: 20, tokens: 900 },
      apiUsage: null,
    },
    lastFullAt: NOW - 120_000,
    breakdownError: null,
    history: Array.from({ length: 6 }, (_, i) => ({ at: NOW - (6 - i) * 300_000, turn: i + 1, tokens: 300_000 + i * 30_000, percent: 30 + i * 3, window: 1_000_000 })),
    rateLimits: [
      { kind: 'five_hour', percentUsed: 72, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 35, resetsAt: null },
    ],
    engineCostUsd: 2.8,
    compactions: [{ at: NOW - 1_800_000, trigger: 'auto', agentId: 'main', tokensBefore: 790_000, tokensAfter: 60_000, usage: null, costUsd: 0.4, skipped: null }],
  }
  return s
}

/**
 * The ghosts of the live pane: loops heard of only on a `turn.start` whose end
 * was never seen. `g1` (30 min quiet) and `g2` (7 h quiet, from before the
 * session's known start) have no spawn, no usage and no tool call; `g3` is a
 * real Explore run with usage that went quiet 20 minutes ago. Each still has
 * an open turn on the books.
 */
export function withGhosts(s: TelemetryState): TelemetryState {
  const ghost = (id: string, firstSeenAt: number, lastActiveAt: number): void => {
    s.agents.byId[id] = {
      ...(s.agents.byId.main ?? ({} as never)),
      id,
      kind: 'unknown',
      type: 'unknown',
      description: '',
      name: null,
      parentId: 'main',
      toolUseId: null,
      model: null,
      models: [],
      requestedModel: null,
      isBackground: false,
      status: 'running',
      firstSeenAt,
      spawnedAt: null,
      lastActiveAt,
      endedAt: null,
      turns: 1,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: emptyUsage(),
      byModel: {},
      byTool: {},
      lastContextTokens: 0,
      peakContextTokens: 0,
      activeMs: 0,
      report: null,
    }
    s.agents.order.push(id)
    s.meta.activeTurns[id] = `turn-${id}`
  }
  ghost('g1', NOW - 30 * 60_000, NOW - 30 * 60_000)
  ghost('g2', NOW - 7 * 3_600_000, NOW - 7 * 3_600_000)
  ghost('g3', NOW - 40 * 60_000, NOW - 20 * 60_000)
  const g3 = s.agents.byId.g3
  if (g3) {
    g3.kind = 'subagent'
    g3.type = 'Explore'
    g3.description = 'long search that went quiet'
    g3.spawnedAt = NOW - 40 * 60_000
    g3.model = 'claude-haiku-5-5'
    g3.models = ['claude-haiku-5-5']
    g3.steps = 4
    g3.toolCalls = 3
    g3.usage = usage(500, 2_000, 40_000, 4_000, 0.05)
    g3.byModel = { 'claude-haiku-5-5': { requests: 4, tokens: 46_500, costUsd: 0.05 } }
    g3.byTool = { Read: 3 }
  }
  return s
}

/** `n` more finished subagents of main, `d1` the oldest and `dn` the newest end, each with a little usage. */
export function withManyDone(s: TelemetryState, n: number): TelemetryState {
  const a1 = s.agents.byId.a1
  if (!a1) return s
  for (let i = 1; i <= n; i += 1) {
    const id = `d${i}`
    const endedAt = NOW - (n - i + 2) * 120_000
    s.agents.byId[id] = {
      ...a1,
      id,
      parentId: 'main',
      toolUseId: `tu-${id}`,
      description: `done task ${i}`,
      status: 'completed',
      firstSeenAt: endedAt - 60_000,
      spawnedAt: endedAt - 60_000,
      lastActiveAt: endedAt,
      endedAt,
      usage: usage(100, 400, 8_000, 800, 0.01 * i),
      byModel: { 'claude-haiku-5-5': { requests: 2, tokens: 9_300, costUsd: 0.01 * i } },
      byTool: { Read: 2 },
      report: null,
    }
    s.agents.order.push(id)
  }
  return s
}

/** The populated session with the ledger far above what the mod tracked, and the main loop's start unknown (0). */
export function ledgerGap(): TelemetryState {
  const s = populated()
  const scale = 0.63 / s.totals.session.costUsd
  const scaleUsage = (u: TelemetryUsage): void => {
    u.costUsd *= scale
    u.cacheSavedUsd *= scale
  }
  scaleUsage(s.totals.session)
  for (const m of Object.values(s.totals.byModel)) scaleUsage(m)
  for (const a of Object.values(s.agents.byId)) {
    scaleUsage(a.usage)
    for (const slice of Object.values(a.byModel)) slice.costUsd *= scale
  }
  for (const step of s.steps) step.costUsd *= scale
  for (const turn of s.turns) scaleUsage(turn.usage)
  s.context.engineCostUsd = 1200.00
  s.meta.startedAt = null
  s.meta.firstSeenAt = NOW - 600_000
  s.totals.firstStepAt = NOW - 590_000
  const main = s.agents.byId.main
  if (main) {
    main.firstSeenAt = 0
    main.lastActiveAt = 0
    main.spawnedAt = null
  }
  s.meta.modelSwitches = [{ at: NOW - 900_000, from: 'claude-sonnet-5-5', to: 'claude-opus-5-5', source: 'command', contextTokens: 300_000, estimatedCacheWriteUsd: 1.2, pricing: 'list' }]
  return s
}
