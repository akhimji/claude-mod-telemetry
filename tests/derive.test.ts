// Pure tests of hooks/derive.ts: selectors over a state built with the reducers, and formatters.

import { describe, expect, test } from 'claude-code/testing'

import {
  cacheHitRate,
  deriveAgents,
  deriveContext,
  deriveContextGrid,
  deriveFlow,
  deriveHarness,
  deriveModels,
  deriveOverview,
  deriveReconciliation,
  deriveTimeline,
  deriveTools,
  deriveTurns,
  fmtBytes,
  fmtDuration,
  fmtPct,
  fmtRate,
  fmtTokens,
  fmtUsd,
  isTime,
  NONE,
  percentile,
  saneDuration,
  sessionStartOf,
  STALE_AFTER_MS,
} from '../hooks/derive'
import { isActive } from '../hooks/ui/header'
import {
  emptyState,
  recordAgentSpawn,
  recordBreakdown,
  recordMeasure,
  recordStep,
  recordToolEnd,
  recordToolStart,
  recordTurnComplete,
  recordTurnStart,
} from '../hooks/model'

const MIN = 60_000

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model,
})

/** The session's clock starts here (0 would read as "unknown"); `at(ms)` is a moment `ms` into it. */
const T0 = 1_000_000_000
const at = (ms: number): number => T0 + ms

/** A session: two main turns, one Explore subagent on Haiku, a few tool calls. */
function session() {
  const s = emptyState(at(0))
  s.meta.startedAt = at(0)
  recordTurnStart(s, { turnId: 'm1', text: 'first' }, at(0))
  recordStep(s, { turnId: 'm1', index: 0, model: 'claude-opus-5-5', messageCount: 1, startedAt: at(0), endedAt: at(MIN), usage: usage(1000, 1000, 8000, 1000), stopReason: 'tool_use', toolUses: [{ name: 'Agent' }] }, at(MIN))
  recordAgentSpawn(s, { agentId: 'a1', subagentType: 'Explore', description: 'Map repo', background: false, fork: false, model: 'claude-haiku-5-5' }, at(MIN))
  recordTurnStart(s, { turnId: 's1', agentId: 'a1', text: 'go' }, at(MIN))
  recordToolStart(s, { id: 'r1', tool: 'Read', agentId: 'a1', input: { file_path: '/a' } }, at(MIN))
  recordToolEnd(s, { id: 'r1', tool: 'Read', agentId: 'a1', text: 'x'.repeat(400) }, at(MIN + 100))
  recordToolStart(s, { id: 'r2', tool: 'Read', agentId: 'a1', input: { file_path: '/b' } }, at(MIN))
  recordToolEnd(s, { id: 'r2', tool: 'Read', agentId: 'a1', text: 'y' }, at(MIN + 300))
  recordToolStart(s, { id: 'g1', tool: 'mcp__gh__search', agentId: 'a1', input: { q: 'x' } }, at(MIN))
  recordToolEnd(s, { id: 'g1', tool: 'mcp__gh__search', agentId: 'a1', isError: true, text: 'boom' }, at(MIN + 50))
  recordStep(s, { turnId: 's1', index: 0, agentId: 'a1', model: 'claude-haiku-5-5', messageCount: 1, startedAt: at(MIN), endedAt: at(2 * MIN), usage: usage(5000, 500, 0, 0, 'claude-haiku-5-5'), stopReason: 'end_turn', toolUses: [] }, at(2 * MIN))
  recordTurnComplete(s, { turnId: 's1', agentId: 'a1', durationMs: MIN, reason: 'answer' }, at(2 * MIN))
  recordStep(s, { turnId: 'm1', index: 1, model: 'claude-opus-5-5', messageCount: 3, startedAt: at(2 * MIN), endedAt: at(3 * MIN), usage: usage(100, 400, 10_000, 0), stopReason: 'end_turn', toolUses: [] }, at(3 * MIN))
  recordTurnComplete(s, { turnId: 'm1', durationMs: 3 * MIN, reason: 'answer' }, at(3 * MIN))
  recordTurnStart(s, { turnId: 'm2', text: 'second' }, at(4 * MIN))
  recordStep(s, { turnId: 'm2', index: 0, model: 'claude-opus-5-5', messageCount: 5, startedAt: at(4 * MIN), endedAt: at(5 * MIN), usage: usage(200, 600, 12_000, 0), stopReason: 'end_turn', toolUses: [] }, at(5 * MIN))
  recordTurnComplete(s, { turnId: 'm2', durationMs: MIN, reason: 'answer' }, at(5 * MIN))
  recordMeasure(s, { context: { tokens: 12_800, window: 1_000_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }], cost: { usd: 0.1 }, changed: ['context', 'cost'] }, at(5 * MIN))
  return s
}

describe('deriveOverview', () => {
  test('totals, cache, per-turn and burn', () => {
    const s = session()
    const o = deriveOverview(s, at(5 * MIN))
    expect(o.requests).toBe(4)
    expect(o.tokens.input).toBe(6300)
    expect(o.tokens.cacheRead).toBe(30_000)
    expect(o.tokens.prompt).toBe(6300 + 30_000 + 1000)
    expect(o.mainTurns).toBe(2)
    expect(o.costSource).toBe('engine')
    expect(o.costUsd).toBe(0.1)
    expect(o.estimatedCostUsd).toBe(s.totals.session.costUsd)
    expect(o.estimateDrift !== null && Math.abs(o.estimateDrift - (o.estimatedCostUsd - 0.1) / 0.1) < 1e-12).toBe(true)
    expect(o.cacheHitRate).toBe(30_000 / 37_300)
    expect(o.cacheSavedUsd > 0).toBe(true)
    expect(o.perTurn.costUsd).toBe(s.totals.session.costUsd / 2)
    expect(o.perTurn.avgDurationMs).toBe(2 * MIN)
    expect(o.agents).toEqual({ total: 2, subagents: 1, running: 0 })
    expect(o.toolCalls).toBe(3)
    expect(o.toolErrors).toBe(1)
    expect(o.mainModelLabel).toBe('Claude Opus 5.5')
    expect(o.context.fill).toBe(0.0128)
    expect(o.rateLimits[0]?.percentUsed).toBe(30)
    expect(o.pricing.hasFallback).toBe(false)
  })

  test('burn rate counts only the window', () => {
    const s = session()
    // window of 5 minutes ending at 5:00 takes steps that ended after 0:00, i.e. all four
    const all = deriveOverview(s, at(5 * MIN))
    const total = s.steps.reduce((sum, one) => sum + one.costUsd, 0)
    expect(Math.abs(all.burn.costUsd - total) < 1e-12).toBe(true)
    expect(Math.abs((all.burn.usdPerMinute ?? 0) - total / 5) < 1e-12).toBe(true)
    // a 90 s window ending at 5:00 holds the last step alone
    const last = deriveOverview(s, at(5 * MIN), { burnWindowMs: 90_000 })
    expect(last.burn.costUsd).toBe(s.steps.at(-1)?.costUsd ?? -1)
    expect(Math.abs((last.burn.usdPerMinute ?? 0) - (s.steps.at(-1)?.costUsd ?? 0) / 1.5) < 1e-12).toBe(true)
    expect(last.burn.isPartial).toBe(false)
  })

  test('an empty session', () => {
    const o = deriveOverview(emptyState(1000), 2000)
    expect(o.elapsedMs).toBe(1000)
    expect(o.ledger.source).toBe('estimate')
    expect(o.costSource).toBe('estimate')
    expect(o.costUsd).toBe(0)
    expect(o.cacheHitRate).toBeNull()
    expect(o.perTurn.tokens).toBeNull()
    expect(o.burn.usdPerMinute).toBeNull()
    expect(o.toolErrorRate).toBeNull()
  })
})

describe('deriveAgents', () => {
  test('tree order, shares and durations', () => {
    const s = session()
    recordAgentSpawn(s, { agentId: 'a2', subagentType: 'Plan', description: 'Nested', background: true, fork: false, parentAgentId: 'a1' }, at(6 * MIN))
    const rows = deriveAgents(s, at(7 * MIN))
    expect(rows.map(r => [r.id, r.depth])).toEqual([
      ['main', 0],
      ['a1', 1],
      ['a2', 2],
    ])
    const a1 = rows[1]
    expect(a1?.label).toBe('Map repo')
    expect(a1?.status).toBe('completed')
    expect(a1?.durationMs).toBe(MIN)
    expect(a1?.toolCalls).toBe(3)
    expect(a1?.childIds).toEqual(['a2'])
    // shares are of the tracked sum; the ledger's remainder is reconciled apart
    const rec = deriveReconciliation(s)
    expect(rec.source).toBe('ledger')
    expect(rec.ledgerUsd).toBe(0.1)
    expect(rec.trackedUsd).toBe(s.totals.session.costUsd)
    expect(rec.untrackedUsd !== null && rec.untrackedUsd > 0).toBe(true)
    expect(Math.abs((rec.untrackedUsd ?? 0) + rec.trackedUsd - 0.1) < 1e-12).toBe(true)
    const shares = rows.reduce((sum, r) => sum + (r.costShare ?? 0), 0)
    expect(Math.abs(shares - 1) < 1e-9).toBe(true)
    expect(rows[2]?.isRunning).toBe(true)
    expect(rows[2]?.durationMs).toBe(MIN)
    // main's duration is the session's uptime
    expect(rows[0]?.durationMs).toBe(7 * MIN)
  })

  test('a main loop first seen at time 0 (the atoms\' initial value) has no 20,000-day duration', () => {
    const s = session()
    const main = s.agents.byId.main
    if (main) {
      main.firstSeenAt = 0
      main.lastActiveAt = 0
      main.spawnedAt = null
    }
    s.meta.startedAt = null
    s.meta.firstSeenAt = 0
    s.totals.firstStepAt = null
    const now = 1_793_000_000_000
    const rows = deriveAgents(s, now)
    expect(rows[0]?.durationMs).toBeNull()
    expect(fmtDuration(rows[0]?.durationMs)).toBe(NONE)
    expect(deriveOverview(s, now).elapsedMs).toBeNull()
    // with the mod's first sight known, that is the start
    s.meta.firstSeenAt = now - 10 * MIN
    expect(deriveAgents(s, now)[0]?.durationMs).toBe(10 * MIN)
    expect(deriveOverview(s, now).elapsedMs).toBe(10 * MIN)
    expect(sessionStartOf(s, now)).toBe(now - 10 * MIN)
    // a subagent whose spawn is unknown shows no duration rather than a wrong one
    const a1 = s.agents.byId.a1
    if (a1) {
      a1.spawnedAt = 0
      a1.firstSeenAt = 0
    }
    expect(deriveAgents(s, now)[1]?.durationMs).toBeNull()
  })

  test('saneDuration rejects negative spans and spans longer than the session', () => {
    expect(saneDuration(500, 1000)).toBe(500)
    expect(saneDuration(-1, 1000)).toBeNull()
    expect(saneDuration(2_000_000, 1000)).toBeNull()
    expect(saneDuration(2_000_000, null)).toBe(2_000_000)
    expect(saneDuration(Number.NaN, null)).toBeNull()
    expect(isTime(0)).toBe(false)
    expect(isTime(null)).toBe(false)
    expect(isTime(5)).toBe(true)
  })
})

describe('deriveReconciliation', () => {
  test('a ledger far above the tracked sum: the remainder is untracked', () => {
    const s = session()
    s.context.engineCostUsd = 1200.00
    s.totals.session.costUsd = 0.63
    const r = deriveReconciliation(s)
    expect(r.totalUsd).toBe(1200.00)
    expect(Math.abs((r.untrackedUsd ?? 0) - 1199.37) < 1e-9).toBe(true)
    expect(r.untrackedShare !== null && r.untrackedShare > 0.99).toBe(true)
    expect(r.trackedSince).toBe(s.meta.firstSeenAt)
  })
  test('a tracked sum above the ledger is drift, not untracked; no ledger is an estimate', () => {
    const s = session()
    s.context.engineCostUsd = 0.05
    s.totals.session.costUsd = 0.08
    const r = deriveReconciliation(s)
    expect(r.untrackedUsd).toBe(0)
    expect(r.totalUsd).toBe(0.08)
    expect(r.source).toBe('ledger')
    s.context.engineCostUsd = null
    const e = deriveReconciliation(s)
    expect(e.source).toBe('estimate')
    expect(e.untrackedUsd).toBeNull()
    expect(e.totalUsd).toBe(0.08)
  })
})

describe('deriveTimeline', () => {
  test('events newest first, running first, and the phase', () => {
    const s = session()
    const { now, events } = deriveTimeline(s, at(5 * MIN))
    expect(now.phase).toBe('idle')
    expect(now.lastActivityAt).toBe(at(5 * MIN))
    expect(events[0]?.kind).toBe('turn')
    expect(events[0]?.text).toBe('turn 2 answered')
    const kinds = new Set(events.map(e => e.kind))
    expect([...kinds].sort()).toEqual(['finish', 'request', 'spawn', 'tool', 'turn'])
    const spawn = events.find(e => e.kind === 'spawn')
    expect(spawn?.actor).toBe('Explore')
    const tool = events.find(e => e.kind === 'tool' && e.tool === 'mcp__gh__search')
    expect(tool?.status).toBe('error')
    expect(tool?.durationMs).toBe(50)
    const req = events.find(e => e.kind === 'request' && e.agentId === 'main')
    expect(req?.tokens?.cacheRead).toBe(12_000)
    expect(req?.text).toBe('answered')
    // a tool in flight heads the list and sets the phase
    recordTurnStart(s, { turnId: 'm3', text: 'third' }, at(6 * MIN))
    recordToolStart(s, { id: 'b1', tool: 'Bash', input: { command: 'export SECRET=x' } }, at(6 * MIN + 1000))
    const live = deriveTimeline(s, at(6 * MIN + 4000))
    expect(live.now).toMatchObject({ phase: 'tool', tool: 'Bash', sinceMs: 3000, runningTools: 1 })
    expect(live.events[0]).toMatchObject({ kind: 'tool', isRunning: true, durationMs: 3000 })
    expect(live.events.some(e => e.text.includes('SECRET'))).toBe(false)
    // the call done, the turn still open: a model request is in flight since the call ended
    recordToolEnd(s, { id: 'b1', tool: 'Bash', text: 'ok' }, at(6 * MIN + 5000))
    const req2 = deriveTimeline(s, at(6 * MIN + 7000))
    expect(req2.now).toMatchObject({ phase: 'request', sinceMs: 2000 })
    // a subagent running
    recordAgentSpawn(s, { agentId: 'a9', subagentType: 'Plan', description: 'plan', background: false, fork: false }, at(6 * MIN + 8000))
    const agents = deriveTimeline(s, at(6 * MIN + 9000))
    expect(agents.now).toMatchObject({ phase: 'agents', detail: '1 subagent', sinceMs: 1000, runningAgents: 1 })
    expect(deriveTimeline(s, at(6 * MIN + 9000), { limit: 3 }).events).toHaveLength(3)
  })

  test('a running loop gone quiet is stale: counted nowhere as running, its clock stopped, back on its next event', () => {
    const s = session()
    // a loop heard of at a turn start only (no spawn, no steps): a ghost
    recordTurnStart(s, { turnId: 'g', agentId: 'ghost', text: '' }, at(5 * MIN))
    // a real run that went quiet after one step
    recordAgentSpawn(s, { agentId: 'q', subagentType: 'Explore', description: 'quiet', background: true, fork: false }, at(5 * MIN))
    recordStep(s, { turnId: 'q1', index: 0, agentId: 'q', model: 'claude-haiku-5-5', messageCount: 1, startedAt: at(5 * MIN), endedAt: at(6 * MIN), usage: usage(100, 100, 0, 0, 'claude-haiku-5-5'), stopReason: 'tool_use', toolUses: [{ name: 'Read' }] }, at(6 * MIN))
    const fresh = at(7 * MIN)
    expect(deriveAgents(s, fresh).filter(r => r.isRunning).map(r => r.id).sort()).toEqual(['ghost', 'q'])
    expect(deriveOverview(s, fresh).agents.running).toBe(2)
    expect(isActive(s, fresh)).toBe(true)

    const later = at(6 * MIN + STALE_AFTER_MS + 1)
    const rows = deriveAgents(s, later)
    const ghost = rows.find(r => r.id === 'ghost')
    const q = rows.find(r => r.id === 'q')
    expect(ghost).toMatchObject({ status: 'stale', isRunning: false, isStale: true, isUnattributed: true })
    expect(q).toMatchObject({ status: 'stale', isRunning: false, isStale: true, isUnattributed: false })
    // the clock stopped at its last activity: spawn at 5 min, last step at 6 min
    expect(q?.durationMs).toBe(MIN)
    expect(deriveOverview(s, later).agents.running).toBe(0)
    // the timeline neither waits on them nor lists the ghost; the header is idle and nothing ticks
    const { now, events } = deriveTimeline(s, later)
    expect(now.phase).toBe('idle')
    expect(now.runningAgents).toBe(0)
    expect(events.some(e => e.agentId === 'ghost')).toBe(false)
    expect(events.find(e => e.kind === 'spawn' && e.agentId === 'q')?.isRunning).toBe(false)
    expect(isActive(s, later)).toBe(false)
    // a step of its own proves the quiet run alive again
    recordStep(s, { turnId: 'q1', index: 1, agentId: 'q', model: 'claude-haiku-5-5', messageCount: 2, startedAt: later, endedAt: later + 10, usage: usage(10, 10, 0, 0, 'claude-haiku-5-5'), stopReason: 'end_turn', toolUses: [] }, later + 10)
    expect(deriveAgents(s, later + 10).find(r => r.id === 'q')).toMatchObject({ status: 'running', isRunning: true })
    expect(deriveOverview(s, later + 10).agents.running).toBe(1)
  })
})

describe('deriveHarness', () => {
  test('fixed overhead, messages and the last request', () => {
    const s = session()
    recordBreakdown(
      s,
      {
        categories: [
          { name: 'System prompt', tokens: 3000, kind: 'used', color: 'a', isDeferred: false },
          { name: 'System tools', tokens: 2000, kind: 'used', color: 'b', isDeferred: false },
          { name: 'Messages', tokens: 5000, kind: 'used', color: 'c', isDeferred: false },
          { name: 'Free space', tokens: 90_000, kind: 'free', color: 'd', isDeferred: false },
        ],
        totalTokens: 10_000,
        maxTokens: 100_000,
        percentage: 10,
        autocompactSource: 'auto',
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
      'summary',
      at(5 * MIN),
    )
    const h = deriveHarness(s)
    expect(h.fixedTokens).toBe(5000)
    expect(h.messagesTokens).toBe(5000)
    expect(h.consumers[0]?.name).toBe('Messages')
    expect(h.consumers[0]?.fill).toBe(0.05)
    expect(h.lastRequest?.promptTokens).toBe(12_200)
    expect(h.lastRequest?.messageCount).toBe(5)
    expect(deriveHarness(emptyState(0)).consumers).toEqual([])
  })
})

describe('deriveModels', () => {
  test('one row per model, by cost', () => {
    const s = session()
    const rows = deriveModels(s)
    expect(rows.map(r => r.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
    expect(rows[1]?.label).toBe('Claude Haiku 5.5')
    const shares = rows.reduce((sum, r) => sum + (r.costShare ?? 0), 0)
    expect(Math.abs(shares - 1) < 1e-9).toBe(true)
  })
})

describe('deriveTools', () => {
  test('rows, servers, percentiles', () => {
    const t = deriveTools(session(), at(5 * MIN))
    const read = t.rows.find(r => r.tool === 'Read')
    expect(read?.calls).toBe(2)
    expect(read?.avgWallMs).toBe(200)
    expect(read?.p50WallMs).toBe(100)
    expect(read?.p95WallMs).toBe(300)
    expect(read?.resultBytes).toBe(401)
    expect(read?.resultTokensEstimate).toBe(101)
    const gh = t.rows.find(r => r.server === 'gh')
    expect(gh?.shortName).toBe('search')
    expect(gh?.errorRate).toBe(1)
    expect(t.servers).toEqual([{ server: 'gh', tools: 1, calls: 1, errors: 1, resultBytes: 4, wallMsTotal: 50 }])
    expect(t.recent[0]?.id).toBe('g1')
    expect(t.running).toEqual([])
    expect(t.totals.statusCounts.ok).toBe(2)
    expect(t.totals.statusCounts.error).toBe(1)
  })

  test('running calls carry their elapsed time', () => {
    const s = emptyState(0)
    recordToolStart(s, { id: 'b', tool: 'Bash', input: { command: 'sleep 5' } }, 1000)
    const t = deriveTools(s, 4000)
    expect(t.running[0]?.elapsedMs).toBe(3000)
    expect(t.totals.running).toBe(1)
  })
})

describe('deriveContext and its grid', () => {
  const categories = [
    { name: 'System prompt', tokens: 15, kind: 'used' as const, color: 'promptBorder', isDeferred: false },
    { name: 'Messages', tokens: 22, kind: 'used' as const, color: 'permission', isDeferred: false },
    { name: 'MCP tools (deferred)', tokens: 40, kind: 'deferred' as const, color: 'inactive', isDeferred: true },
    { name: 'Free space', tokens: 43, kind: 'free' as const, color: 'inactive', isDeferred: false },
    { name: 'Autocompact buffer', tokens: 20, kind: 'buffer' as const, color: 'warning', isDeferred: false },
  ]

  test('categories, sparkline and headroom', () => {
    const s = session()
    recordBreakdown(
      s,
      {
        categories,
        totalTokens: 37,
        maxTokens: 100,
        percentage: 37,
        autocompactSource: 'auto',
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: true,
        autoCompactThreshold: 80,
        apiUsage: null,
      },
      'summary',
      at(5 * MIN),
    )
    const c = deriveContext(s)
    expect(c.window).toBe(1_000_000)
    expect(c.tokens).toBe(12_800)
    expect(c.usedTokens).toBe(37)
    expect(c.freeTokens).toBe(43)
    expect(c.bufferTokens).toBe(20)
    expect(c.deferredTokens).toBe(40)
    expect(c.categories[0]?.fill).toBe(0.15)
    expect(c.sparkline).toEqual([12_800])
    expect(c.breakdownDetail).toBe('summary')
    expect(c.tokensUntilAutoCompact).toBe(0)
  })

  test('the grid lays categories out in order, deferred left out', () => {
    const grid = deriveContextGrid(categories, 100, 10)
    expect(grid).toHaveLength(10)
    expect(grid.map(cell => cell.category)).toEqual([
      'System prompt',
      'System prompt',
      'Messages',
      'Messages',
      'Messages',
      'Autocompact buffer',
      'Autocompact buffer',
      'Free space',
      'Free space',
      'Free space',
    ])
    expect(grid[1]?.fullness).toBe(0.5)
    expect(grid[4]?.fullness !== undefined && Math.abs(grid[4].fullness - 0.2) < 1e-9).toBe(true)
    expect(grid[9]?.fullness).toBe(0)
    expect(deriveContextGrid(categories, 0, 10)).toEqual([])
  })
})

describe('deriveTurns and deriveFlow', () => {
  test('turns of the main loop, newest first', () => {
    const rows = deriveTurns(session())
    expect(rows.map(r => r.turnId)).toEqual(['m2', 'm1'])
    expect(rows[1]?.steps).toBe(2)
    expect(rows[1]?.isRunning).toBe(false)
    expect(deriveTurns(session(), { agentId: 'a1' }).map(r => r.turnId)).toEqual(['s1'])
  })

  test('flow edges', () => {
    const f = deriveFlow(session(), { maxTools: 1 })
    const ids = f.nodes.map(n => n.id)
    expect(ids).toContain('agent:main')
    expect(ids).toContain('agent:a1')
    expect(ids).toContain('model:claude-haiku-5-5')
    expect(ids).toContain('tool:Read')
    expect(ids).toContain('tool:other')
    expect(f.edges.find(e => e.kind === 'spawn')).toMatchObject({ from: 'agent:main', to: 'agent:a1' })
    expect(f.edges.find(e => e.to === 'tool:other')?.value).toBe(1)
    expect(f.edges.find(e => e.from === 'agent:a1' && e.to === 'model:claude-haiku-5-5')?.requests).toBe(1)
  })
})

describe('numbers', () => {
  test('cache hit rate and percentile', () => {
    expect(cacheHitRate({ input: 10, output: 999, cacheRead: 90, cacheWrite: 0 })).toBe(0.9)
    expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([], 50)).toBeNull()
    expect(percentile([1, 2, 3, 4], 100)).toBe(4)
  })
})

describe('formatters', () => {
  test('fmtTokens', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1000)).toBe('1k')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(9_999)).toBe('10k')
    expect(fmtTokens(45_600)).toBe('46k')
    expect(fmtTokens(999_600)).toBe('1M')
    expect(fmtTokens(1_234_567)).toBe('1.23M')
    expect(fmtTokens(12_345_678)).toBe('12.3M')
    expect(fmtTokens(2_500_000_000)).toBe('2.5B')
    expect(fmtTokens(-1500)).toBe('-1.5k')
    expect(fmtTokens(null)).toBe(NONE)
  })

  test('fmtUsd', () => {
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(0.00001)).toBe('<$0.0001')
    expect(fmtUsd(0.0042)).toBe('$0.0042')
    expect(fmtUsd(0.42)).toBe('$0.42')
    expect(fmtUsd(1.5)).toBe('$1.50')
    expect(fmtUsd(1234.567)).toBe('$1234.57')
    expect(fmtUsd(12_345)).toBe('$12.3k')
    expect(fmtUsd(-0.5)).toBe('-$0.50')
    expect(fmtUsd(Number.NaN)).toBe(NONE)
  })

  test('fmtDuration', () => {
    expect(fmtDuration(850)).toBe('850ms')
    expect(fmtDuration(4200)).toBe('4.2s')
    expect(fmtDuration(5000)).toBe('5s')
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(59_600)).toBe('1m 00s')
    expect(fmtDuration(245_000)).toBe('4m 05s')
    expect(fmtDuration(3_720_000)).toBe('1h 02m')
    expect(fmtDuration(90_000_000)).toBe('1d 01h')
    // nonsense is shown as nothing: a negative span, or a timestamp mistaken for a duration
    expect(fmtDuration(-5)).toBe(NONE)
    expect(fmtDuration(1_793_000_000_000)).toBe(NONE)
    expect(fmtDuration(undefined)).toBe(NONE)
  })

  test('fmtBytes, fmtPct, fmtRate', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(fmtPct(0.423)).toBe('42%')
    expect(fmtPct(0.0423)).toBe('4.2%')
    expect(fmtPct(0.00042)).toBe('0.04%')
    expect(fmtPct(0)).toBe('0%')
    expect(fmtPct(null)).toBe(NONE)
    expect(fmtRate(0.12)).toBe('$0.12/min')
  })
})
