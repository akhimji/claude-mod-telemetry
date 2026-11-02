// Tests of hooks/insights.ts (pure) and the collector additions it reads
// (per-server loaded tokens and wire prefixes, skill rows, Skill call counts).

import { describe, expect, test } from 'claude-code/testing'

import type { TelemetryState } from '../types'

import { deriveAgents, groupOf, isFoldedAgent } from '../hooks/derive'
import {
  contextSegmentOf,
  DEFAULT_ALERT_RULES,
  deriveAgentFilter,
  deriveAlerts,
  deriveBand,
  deriveBloat,
  deriveCacheClock,
  deriveWorkflows,
  emptyAlerts,
  formatStatusLine,
  nextAlertCheckAt,
  rulesFromOptions,
  stepAlerts,
  type TelemetryActiveAlert,
  type TelemetryBloatRow,
} from '../hooks/insights'
import { emptyState, recordBreakdown, recordToolStart } from '../hooks/model'

import { NOW, populated, SECRET, withGhosts } from './fixture'
import { agentRun, bloatSession, cacheSession, MIN, stepOf, T0, workflowSession } from './insights-fixture'

const close = (a: number | null | undefined, b: number, eps = 1e-9): boolean => a !== null && a !== undefined && Math.abs(a - b) < eps

const ready = (s: TelemetryState, now: number) => {
  const b = deriveBloat(s, now)
  if (!b.isReady) throw new Error('not ready')
  return b
}
const rowOf = (rows: TelemetryBloatRow[], key: string): TelemetryBloatRow => {
  const row = rows.find(r => r.key === key)
  if (!row) throw new Error(`no row ${key}`)
  return row
}

describe('bloat', () => {
  test('not ready before a full breakdown', () => {
    const none = deriveBloat(emptyState(0), 1)
    expect(none.isReady).toBe(false)
    expect(none.needsFullBreakdown).toBe(true)
    const s = bloatSession()
    s.context.lastFullAt = null
    expect(deriveBloat(s, T0).isReady).toBe(false)
  })

  test('an MCP server never called over many requests is the top waste, priced at the cache-read rate', () => {
    const b = ready(bloatSession(), T0)
    const top = b.rows[0]
    expect(top?.key).toBe('mcp-server:claude.ai Slack')
    expect(top?.verdict).toBe('unused')
    expect(top?.callsThisSession).toBe(0)
    expect(top?.requestsSeen).toBe(200)
    expect(top?.wasteTokens).toBe(4_000_000)
    expect(close(top?.estCostUsd, 0.8)).toBe(true)
    expect(close(top?.windowShare, 0.02)).toBe(true)
    expect(b.isEstimate).toBe(true)
    expect(b.totals.wasteTokens).toBe(4_060_000)
    expect(close(b.totals.estCostUsd, 0.812)).toBe(true)
    expect(b.totals.unused).toBe(3)
    expect(b.totals.rare).toBe(2)
    expect(b.totals.deferredTokens).toBe(43_000)
    expect(b.totals.inWindowTokens).toBe(54_700)
    expect(b.totals.cacheReadUsdPerMTok).toBe(0.2)
  })

  test('calls are matched by the wire prefix; deferred schemas never count as waste', () => {
    const { rows } = ready(bloatSession(), T0)
    const linear = rowOf(rows, 'mcp-server:linear')
    expect(linear.callsThisSession).toBe(5)
    expect(linear.tokensPerRequest).toBe(2_000)
    expect(linear.deferredTokens).toBe(13_000)
    expect(linear.verdict).toBe('active')
    expect(linear.wasteTokens).toBe(0)
    expect(linear.lastUsedAgoMs).toBe(5 * MIN)
    const notion = rowOf(rows, 'mcp-server:notion')
    expect(notion.isDeferred).toBe(true)
    expect(notion.tokensPerRequest).toBe(0)
    expect(notion.wasteTokens).toBe(0)
  })

  test('skills, custom agents and the rows nothing calls', () => {
    const { rows } = ready(bloatSession(), T0)
    expect(rowOf(rows, 'skill:anthropic-skills:pdf').wasteTokens).toBe(60_000)
    expect(rowOf(rows, 'skill:docx').verdict).toBe('rare')
    const search = rowOf(rows, 'custom-agent:search')
    expect(search.callsThisSession).toBe(2)
    expect(search.verdict).toBe('rare')
    for (const key of ['memory:/work/CLAUDE.md', 'system-prompt:System prompt', 'slash-commands:Slash commands', 'system-tools:System tools']) {
      const row = rowOf(rows, key)
      expect(row.verdict, key).toBe('n/a')
      expect(row.wasteTokens, key).toBeNull()
    }
    expect(rowOf(rows, 'system-tools:System tools').callsThisSession).toBe(51)
    // sorted by waste, the rows nothing calls last
    const wastes = rows.map(r => r.wasteTokens ?? -1)
    expect(wastes).toEqual([...wastes].sort((a, z) => z - a))
  })

  test('a breakdown stored before the loaded split still derives, its tokens flagged as estimates', () => {
    const { rows } = ready(populated(), NOW)
    const linear = rowOf(rows, 'mcp-server:linear')
    expect(linear.tokensPerRequest).toBe(2_000)
    expect(linear.isTokenEstimate).toBe(true)
    expect(linear.callsThisSession).toBe(2)
    expect(rowOf(rows, 'skills:Skill listing').tokensPerRequest).toBe(3_000)
  })
})

describe('cache clock', () => {
  test('a cache that expired while main sat idle is cold, with what re-caching costs', () => {
    const c = deriveCacheClock(cacheSession(T0), T0 + 6 * MIN)
    expect(c.status).toBe('cold')
    expect(c.expiresInMs).toBe(-MIN)
    expect(c.isMainIdle).toBe(true)
    expect(c.ttl).toBe('5m')
    expect(c.ttlSource).toBe('default')
    expect(c.contextTokens).toBe(400_000)
    expect(close(c.recacheCostUsd, 2.0)).toBe(true)
    expect(close(c.hitCostUsd, 0.08)).toBe(true)
    expect(close(c.recacheExtraUsd, 1.92)).toBe(true)
    expect(c.lastTurnWasCacheMiss).toBe(false)
  })

  test('warm, cooling, and the clock runs from the request start', () => {
    expect(deriveCacheClock(cacheSession(T0), T0 + MIN).status).toBe('warm')
    const cooling = deriveCacheClock(cacheSession(T0), T0 + 4.5 * MIN)
    expect(cooling.status).toBe('cooling')
    expect(cooling.expiresInMs).toBe(30_000)
    expect(cooling.lastRequestAt).toBe(T0)
  })

  test('a miss on the last request, and what it cost over a hit', () => {
    const c = deriveCacheClock(cacheSession(T0, { cacheRead: 0, cacheWrite: 399_900 }), T0 + MIN)
    expect(c.lastTurnWasCacheMiss).toBe(true)
    expect(close(c.missCostUsd, 301_100 * (5 - 0.2) / 1e6)).toBe(true)
  })

  test('a compaction after the last request makes it cold; a 1-hour TTL comes from a switch event', () => {
    const s = cacheSession(T0)
    s.context.compactions.push({ at: T0 + 5000, trigger: 'auto', agentId: 'main', tokensBefore: 400_000, tokensAfter: 40_000, usage: null, costUsd: null, skipped: null })
    const c = deriveCacheClock(s, T0 + MIN)
    expect(c.status).toBe('cold')
    expect(c.invalidatedBy).toBe('compaction')
    const h = cacheSession(T0)
    h.meta.cacheTtl = '1h'
    const one = deriveCacheClock(h, T0 + 6 * MIN)
    expect(one.status).toBe('warm')
    expect(one.ttlSource).toBe('switch')
    expect(one.expiresInMs).toBe(54 * MIN)
  })

  test('main busy is not idle; running subagents get a clock of their own', () => {
    const s = cacheSession(T0)
    s.meta.activeTurns = { main: 't1' }
    agentRun(s, { id: 'x1', status: 'running', lastActiveAt: T0, endedAt: null })
    s.steps.push(stepOf({ startedAt: T0, agentId: 'x1', model: 'claude-haiku-5-5', cacheRead: 20_000 }))
    const c = deriveCacheClock(s, T0 + MIN)
    expect(c.isMainIdle).toBe(false)
    expect(c.agents.map(a => a.agentId)).toEqual(['x1'])
    expect(c.agents[0]?.status).toBe('warm')
  })
})

describe('alerts: conditions', () => {
  const keys = (list: TelemetryActiveAlert[]) => list.map(a => `${a.key}:${a.level}`)

  test('context against the auto-compact threshold, warn then crit', () => {
    const s = bloatSession()
    s.context.tokens = 600_000
    expect(keys(deriveAlerts(s, T0).active)).toEqual(['context:warn'])
    s.context.tokens = 750_000
    const crit = deriveAlerts(s, T0).active[0]
    expect(crit?.level).toBe('crit')
    expect(crit?.message).toMatch(/auto-compact/)
    expect(crit?.short).toBe('ctx 94%')
    // against the window when auto-compact is off
    s.context.tokens = 600_000
    if (s.context.breakdown) s.context.breakdown.isAutoCompactEnabled = false
    expect(deriveAlerts(s, T0).active).toEqual([])
  })

  test('a session budget at 80% and 100%', () => {
    const s = emptyState(T0)
    s.context.engineCostUsd = 9
    const rules = { ...DEFAULT_ALERT_RULES, budgetUsd: 10 }
    expect(keys(deriveAlerts(s, T0, rules).active)).toEqual(['budget:warn'])
    s.context.engineCostUsd = 11
    expect(keys(deriveAlerts(s, T0, rules).active)).toEqual(['budget:crit'])
    expect(deriveAlerts(s, T0).active).toEqual([])
  })

  test('a burn spike over the 15-minute median, floored at $0.05/min', () => {
    const now = T0
    const build = (recent: number) => {
      const s = emptyState(now - 30 * MIN)
      s.totals.firstStepAt = now - 20 * MIN
      for (let k = 14; k >= 0; k -= 1) s.steps.push(stepOf({ startedAt: now - k * MIN - 33_000, costUsd: k <= 2 ? recent : 0.02 }))
      return s
    }
    const view = deriveAlerts(build(1), now)
    expect(keys(view.active)).toEqual(['burn:warn'])
    expect(close(view.burn.medianUsdPerMinute, 0.02)).toBe(true)
    expect(close(view.burn.threshold, 0.15)).toBe(true)
    expect(deriveAlerts(build(0.02), now).active).toEqual([])
    const young = build(1)
    young.totals.firstStepAt = now - 3 * MIN
    expect(deriveAlerts(young, now).active).toEqual([])
  })

  test('tool errors over 30% of at least 10 calls in 5 minutes, never with the error text', () => {
    const build = (calls: number, errors: number) => {
      const s = emptyState(T0 - 30 * MIN)
      for (let i = 0; i < calls; i += 1) {
        const failed = i < errors
        s.tools.push({
          id: `c${i}`,
          tool: failed ? 'Bash' : 'Read',
          server: null,
          agentId: 'main',
          turnId: null,
          label: failed ? `curl -H "${SECRET}"` : '/a',
          startedAt: T0 - 60_000 + i,
          endedAt: T0 - 50_000 + i,
          wallMs: 10_000,
          execMs: null,
          status: failed ? 'error' : 'ok',
          resultChars: 1,
          resultBytes: 1,
          isReadOnly: false,
          isServerTool: false,
          error: failed ? `401 for ${SECRET}` : null,
        })
      }
      return s
    }
    const hit = deriveAlerts(build(12, 4), T0).active
    expect(keys(hit)).toEqual(['tool-errors:warn'])
    expect(hit[0]?.message).toBe('4 of 12 tool calls failed in the last 5m (mostly Bash)')
    expect(JSON.stringify(hit)).not.toContain(SECRET)
    expect(deriveAlerts(build(9, 4), T0).active).toEqual([])
    expect(deriveAlerts(build(12, 3), T0).active).toEqual([])
  })

  test('a stale real agent alerts, the ghosts do not; a long run alerts; off is silent', () => {
    const s = withGhosts(populated())
    expect(keys(deriveAlerts(s, NOW).active)).toEqual(['agent-stale:g3:warn'])
    const long = cacheSession(T0)
    agentRun(long, { id: 'L', description: 'big refactor', status: 'running', spawnedAt: T0 - 40 * MIN, lastActiveAt: T0 - MIN, endedAt: null })
    const view = deriveAlerts(long, T0)
    expect(keys(view.active)).toEqual(['agent-long:L:warn'])
    expect(view.active[0]?.message).toBe('Agent "big refactor" has been running for 40m')
    expect(deriveAlerts(s, NOW, { ...DEFAULT_ALERT_RULES, mode: 'off' }).active).toEqual([])
  })

  test('the cache about to expire while main is idle, only when re-caching is worth it', () => {
    const now = T0 + 4.5 * MIN
    expect(keys(deriveAlerts(cacheSession(T0), now).active)).toEqual(['cache-expiring:warn'])
    const busy = cacheSession(T0)
    busy.meta.activeTurns = { main: 't1' }
    expect(deriveAlerts(busy, now).active).toEqual([])
    const small = cacheSession(T0, { cacheRead: 10_000 })
    expect(deriveAlerts(small, now).active).toEqual([])
    expect(deriveAlerts(cacheSession(T0), T0 + MIN).active).toEqual([])
  })

  test('crit first; the stored log newest first with the unacked count', () => {
    const s = bloatSession()
    s.context.tokens = 750_000
    s.context.engineCostUsd = 9
    const log = emptyAlerts(T0)
    log.log = [
      { id: 'a1', key: 'x', level: 'warn', message: 'one', at: 1, ackd: true },
      { id: 'a2', key: 'y', level: 'warn', message: 'two', at: 2, ackd: false },
    ]
    const view = deriveAlerts({ ...s, alerts: log }, T0, { ...DEFAULT_ALERT_RULES, budgetUsd: 10 })
    expect(keys(view.active)).toEqual(['context:crit', 'budget:warn'])
    expect(view.log.map(a => a.id)).toEqual(['a2', 'a1'])
    expect(view.unacked).toBe(1)
  })
})

describe('alerts: the engine reducer', () => {
  const warn = (key = 'context'): TelemetryActiveAlert => ({ key, kind: 'context', level: 'warn', message: `${key} warn`, short: key })
  const crit = (key = 'context'): TelemetryActiveAlert => ({ key, kind: 'context', level: 'crit', message: `${key} crit`, short: key })
  const R = DEFAULT_ALERT_RULES

  test('fires once, re-arms when cleared, holds a cooldown', () => {
    let a = emptyAlerts(0)
    let step = stepAlerts(a, [warn()], 1000, R)
    expect(step.fired.map(x => x.id)).toEqual(['a1'])
    a = step.next
    step = stepAlerts(a, [warn()], 2000, R)
    expect(step.fired).toEqual([])
    expect(step.changed).toBe(false)
    a = stepAlerts(step.next, [], 3000, R).next
    expect(a.conditions.context?.active).toBe(false)
    // back within the cooldown: active, not fired
    step = stepAlerts(a, [warn()], 4000, R)
    expect(step.fired).toEqual([])
    a = stepAlerts(step.next, [], 5000, R).next
    // back after the cooldown: fires again
    step = stepAlerts(a, [warn()], 1000 + R.cooldownMs + 1, R)
    expect(step.fired.map(x => x.id)).toEqual(['a2'])
    expect(step.next.log).toHaveLength(2)
  })

  test('an escalation fires at once; a de-escalation does not', () => {
    let a = stepAlerts(emptyAlerts(0), [warn()], 1000, R).next
    const up = stepAlerts(a, [crit()], 2000, R)
    expect(up.fired.map(x => x.level)).toEqual(['crit'])
    a = up.next
    const down = stepAlerts(a, [warn()], 3000, R)
    expect(down.fired).toEqual([])
    expect(down.next.conditions.context?.level).toBe('warn')
  })

  test('toasts: crit only in quiet, warn too in all, at most one per 30 s', () => {
    expect(stepAlerts(emptyAlerts(0), [warn()], 1000, R).toasts).toEqual([])
    expect(stepAlerts(emptyAlerts(0), [warn()], 1000, { ...R, mode: 'all' }).toasts).toEqual(['context warn'])
    const first = stepAlerts(emptyAlerts(0), [crit('a'), crit('b')], 1000, R)
    expect(first.fired).toHaveLength(2)
    expect(first.toasts).toHaveLength(1)
    const soon = stepAlerts(first.next, [crit('a'), crit('b'), crit('c')], 11_000, R)
    expect(soon.fired.map(x => x.key)).toEqual(['c'])
    expect(soon.toasts).toEqual([])
    const later = stepAlerts(soon.next, [crit('a'), crit('b'), crit('c'), crit('d')], 31_001, R)
    expect(later.toasts).toEqual(['d crit'])
  })

  test('off clears everything and fires nothing; the log keeps 50', () => {
    const on = stepAlerts(emptyAlerts(0), [warn()], 1000, R).next
    const off = stepAlerts(on, [warn()], 2000, { ...R, mode: 'off' })
    expect(off.fired).toEqual([])
    expect(off.next.conditions.context?.active).toBe(false)
    let a = emptyAlerts(0)
    for (let i = 0; i < 60; i += 1) a = stepAlerts(a, [warn(`k${i}`)], 1000 + i, R).next
    expect(a.log).toHaveLength(50)
    expect(a.log[0]?.id).toBe('a11')
    expect(a.seq).toBe(60)
  })

  test('rules from the userConfig options', () => {
    expect(rulesFromOptions({})).toEqual(DEFAULT_ALERT_RULES)
    expect(rulesFromOptions(undefined).mode).toBe('quiet')
    const r = rulesFromOptions({ alertsEnabled: 'all', budgetUsd: 25, contextWarnPct: 95, burnSpikeMultiplier: 0.5, statusLine: true })
    expect(r.mode).toBe('all')
    expect(r.budgetUsd).toBe(25)
    expect(r.contextWarnPct).toBe(90)
    expect(r.burnSpikeMultiplier).toBe(3)
    expect(r.statusLine).toBe(true)
    expect(rulesFromOptions({ alertsEnabled: false }).mode).toBe('off')
    expect(rulesFromOptions({ alertsEnabled: 'bogus', budgetUsd: -4 })).toEqual(DEFAULT_ALERT_RULES)
  })

  test('the next check: the warning point, the expiry, the status line minute, agents', () => {
    const s = cacheSession(T0)
    expect(nextAlertCheckAt(s, T0 + MIN, R)).toBe(T0 + 4 * MIN)
    expect(nextAlertCheckAt(s, T0 + 4.5 * MIN, R)).toBe(T0 + 5 * MIN)
    expect(nextAlertCheckAt(s, T0 + MIN, { ...R, statusLine: true })).toBe(T0 + MIN + 1)
    expect(nextAlertCheckAt(s, T0 + 6 * MIN, R)).toBeNull()
    expect(nextAlertCheckAt(s, T0 + MIN, { ...R, mode: 'off' })).toBeNull()
    agentRun(s, { id: 'r', status: 'running', spawnedAt: T0 + 5 * MIN, lastActiveAt: T0 + 6 * MIN, endedAt: null })
    expect(nextAlertCheckAt(s, T0 + 6 * MIN, R)).toBe(T0 + 16 * MIN + 1)
  })
})

describe('workflows', () => {
  test('a root with 4 parallel children: parallelism, the critical path, cost per minute', () => {
    const flows = deriveWorkflows(workflowSession(), T0 + 40 * MIN)
    expect(flows.map(f => f.id)).toEqual(['root:r3', 'root:r2', 'root:r1'])
    const w = flows.find(f => f.id === 'root:r1')
    expect(w?.name).toBe('plan the migration')
    expect(w?.agentCount).toBe(5)
    expect(w?.status).toBe('done')
    expect(w?.wallMs).toBe(12 * MIN)
    expect(w?.agentMs).toBe(52.5 * MIN)
    expect(close(w?.parallelism, 52.5 / 12)).toBe(true)
    expect(w?.criticalPath?.agentIds).toEqual(['r1', 'c3'])
    expect(w?.criticalPath?.durationMs).toBe(11.5 * MIN)
    expect(close(w?.costUsd, 1.5)).toBe(true)
    expect(close(w?.costShare, 0.75)).toBe(true)
    expect(close(w?.costPerMinute, 0.125)).toBe(true)
    expect(w?.longest?.agentId).toBe('r1')
    expect(w?.types).toEqual(['Plan', 'Explore'])
  })

  test('stale and failed runs; the unattributed ghost is left out', () => {
    const flows = deriveWorkflows(workflowSession(), T0 + 40 * MIN)
    expect(flows.flatMap(f => f.agentIds)).not.toContain('g1')
    const stale = flows.find(f => f.id === 'root:r3')
    expect(stale?.status).toBe('stale')
    expect(stale?.runningCount).toBe(0)
    expect(stale?.staleCount).toBe(1)
    expect(stale?.wallMs).toBe(17 * MIN)
    const failed = flows.find(f => f.id === 'root:r2')
    expect(failed?.status).toBe('failed')
    expect(failed?.failureCount).toBe(1)
  })

  test('grouped by main turn: every root spawned in the turn is one workflow', () => {
    const flows = deriveWorkflows(workflowSession(), T0 + 40 * MIN, { groupBy: 'turn' })
    expect(flows).toHaveLength(1)
    const w = flows[0]
    expect(w?.id).toBe('turn:t1')
    expect(w?.turnId).toBe('t1')
    expect(w?.rootIds).toEqual(['r1', 'r2', 'r3'])
    expect(w?.name).toBe('plan the migration +2')
    expect(w?.agentCount).toBe(7)
    expect(w?.status).toBe('stale')
    expect(w?.failureCount).toBe(1)
    expect(w?.wallMs).toBe(20 * MIN)
    expect(close(w?.parallelism, 72.5 / 20)).toBe(true)
  })
})

describe('agent filter', () => {
  const rows = () => deriveAgents(withGhosts(populated()), NOW)

  test('chips count as the Agents tab groups them; ghosts and main left out', () => {
    const f = deriveAgentFilter(rows())
    expect(f.counts).toEqual({ all: 4, running: 1, stale: 1, failed: 1, done: 1 })
    expect(f.rows.map(r => r.id)).toEqual(['a1', 'a2', 'a3', 'g3'])
    for (const status of ['running', 'stale', 'failed', 'done'] as const) {
      const picked = deriveAgentFilter(rows(), { status }).rows
      expect(picked.every(r => groupOf(r) === status), status).toBe(true)
      expect(picked.length, status).toBe(rows().filter(r => r.id !== 'main' && !isFoldedAgent(r) && groupOf(r) === status).length)
    }
    expect(deriveAgentFilter(rows(), { includeMain: true, includeFolded: true }).rows).toHaveLength(7)
  })

  test('search is case-insensitive over name, description, type and model', () => {
    expect(deriveAgentFilter(rows(), { query: 'PLAN' }).rows.map(r => r.id)).toEqual(['a3'])
    expect(deriveAgentFilter(rows(), { query: 'plan' }).counts.all).toBe(1)
    expect(deriveAgentFilter(rows(), { query: 'haiku' }).rows.map(r => r.id)).toEqual(['a1', 'a2', 'a3', 'g3'])
    expect(deriveAgentFilter(rows(), { query: 'explore', status: 'stale' }).rows.map(r => r.id)).toEqual(['g3'])
  })
})

describe('band', () => {
  test('one compact model: cost, counts, the context segments adding up, the cache', () => {
    const band = deriveBand(populated(), NOW)
    expect(band.title).toBe('Opus 5.5')
    expect(band.costUsd).toBe(3.21)
    expect(band.costSource).toBe('ledger')
    expect([band.running, band.done, band.failed, band.stale]).toEqual([1, 1, 1, 0])
    expect(band.context.tone).toBe('ok')
    expect(band.context.compactAtTokens).toBe(800_000)
    expect(band.context.bufferTokens).toBe(83_000)
    expect(band.context.freeTokens).toBe(467_000)
    expect(band.context.segments.map(x => x.key)).toEqual(['system-prompt', 'system-tools', 'mcp-tools', 'skills', 'memory', 'messages'])
    expect(band.context.segments.reduce((n, x) => n + x.tokens, 0)).toBe(450_000)
    expect(band.cache.status).toBe('warm')
    expect(band.topAlert).toBeNull()
    expect(band.isActive).toBe(true)
    expect(formatStatusLine(band)).toBe('$3.21 · ctx 45% · 1▶ · cache 4m')
  })

  test('messages are re-estimated from a later measure; without one the segments are the breakdown', () => {
    const s = bloatSession()
    s.context.tokens = 120_000
    const live = deriveBand(s, T0)
    expect(live.context.isMessagesEstimate).toBe(true)
    expect(live.context.segments.reduce((n, x) => n + x.tokens, 0)).toBe(120_000)
    expect(live.context.segments.map(x => x.key)).toContain('other')
    s.context.updatedAt = (s.context.breakdown?.at ?? 0) - 1
    const stored = deriveBand(s, T0)
    expect(stored.context.isMessagesEstimate).toBe(false)
    expect(stored.context.segments.reduce((n, x) => n + x.tokens, 0)).toBe(100_000)
  })

  test('the top alert leads the status line; the tone follows the rules', () => {
    const ghosts = deriveBand(withGhosts(populated()), NOW)
    expect(ghosts.topAlert?.key).toBe('agent-stale:g3')
    expect(formatStatusLine(ghosts)).toBe('! agent stale · $3.21 · ctx 45% · 1▶ · cache 4m')
    const s = populated()
    s.context.tokens = 750_000
    s.context.percent = 75
    const hot = deriveBand(s, NOW)
    expect(hot.context.tone).toBe('crit')
    expect(formatStatusLine(hot).startsWith('!! ctx 94% · ')).toBe(true)
    const cold = deriveBand(cacheSession(T0), T0 + 6 * MIN)
    expect(formatStatusLine(cold)).toBe('$0.00 · cache cold')
    expect(formatStatusLine(deriveBand(emptyState(0), 1))).toBe('$0.00')
  })

  test('segment names', () => {
    expect(contextSegmentOf('System prompt')).toBe('system-prompt')
    expect(contextSegmentOf('System tools')).toBe('system-tools')
    expect(contextSegmentOf('MCP tools')).toBe('mcp-tools')
    expect(contextSegmentOf('Memory files')).toBe('memory')
    expect(contextSegmentOf('Skills')).toBe('skills')
    expect(contextSegmentOf('Messages')).toBe('messages')
    expect(contextSegmentOf('Custom agents')).toBe('other')
  })
})

describe('collector additions', () => {
  test('a breakdown keeps each server loaded tokens and wire prefixes, and the skill rows', () => {
    const s = emptyState(0)
    recordBreakdown(
      s,
      {
        categories: [],
        totalTokens: 1,
        maxTokens: 100,
        percentage: 1,
        autocompactSource: 'auto',
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [
          { name: 'mcp__slack-conn-slack__send', serverName: 'claude.ai Slack', tokens: 100, isLoaded: true },
          { name: 'mcp__slack-conn-slack__read', serverName: 'claude.ai Slack', tokens: 50, isLoaded: false },
        ],
        agents: [],
        skills: {
          totalSkills: 2,
          includedSkills: 2,
          tokens: 30,
          skillFrontmatter: [
            { name: 'small', source: 'userSettings', tokens: 10 },
            { name: 'big', source: 'plugin', pluginName: 'kit', tokens: 20 },
          ],
        },
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
      'full',
      5,
    )
    const b = s.context.breakdown
    expect(b?.mcpServers).toEqual([{ server: 'claude.ai Slack', tools: 2, loadedTools: 1, tokens: 150 }])
    expect(b?.mcpServerDetail).toEqual([{ server: 'claude.ai Slack', loadedTokens: 100, wirePrefixes: ['slack-conn-slack'] }])
    expect(b?.skillRows).toEqual([
      { name: 'big', source: 'plugin', pluginName: 'kit', tokens: 20 },
      { name: 'small', source: 'userSettings', pluginName: null, tokens: 10 },
    ])
  })

  test('Skill calls are counted by the skill name only', () => {
    const s = emptyState(0)
    recordToolStart(s, { id: 'u1', tool: 'Skill', input: { skill: 'pdf', args: SECRET } }, 10)
    recordToolStart(s, { id: 'u2', tool: 'Skill', input: { skill: 'pdf' } }, 20)
    recordToolStart(s, { id: 'u3', tool: 'Read', input: { file_path: '/a' } }, 30)
    expect(s.totals.bySkill).toEqual({ pdf: { calls: 2, lastAt: 20 } })
    expect(JSON.stringify(s.totals.bySkill)).not.toContain(SECRET)
  })
})
