// session-telemetry: insights over the state collect.ts keeps. Pure (no `$`, no
// clock: pass `now`); unit-tested in tests/insights.test.ts, the alert engine's
// IO side in tests/alerts.test.ts. Exported through api.ts.
//
// Exports:
//   deriveBloat(s, now, opts?)        what the context carries each request and whether it is used:
//                                     MCP servers, skills, custom agents, memory files, the fixed rows;
//                                     the tokens re-sent for nothing, as an estimate (BLOAT_DEFAULTS)
//   deriveCacheClock(s, now)          the main loop's prompt cache: when it expires, what re-caching costs,
//                                     whether the last request missed; the same per running subagent
//   deriveAlerts(s, now, rules?)      the alert conditions active now (crit first) and the stored log
//   stepAlerts(prev, active, now, rules)  the alert engine's reducer: fire once per key, re-arm on clear,
//                                     cooldown, at most one toast per `toastEveryMs`
//   nextAlertCheckAt(s, now, rules)   when a time-driven condition or the status line next changes
//   rulesFromOptions(options), DEFAULT_ALERT_RULES, emptyAlerts(now)
//   deriveWorkflows(s, now, opts?)    agents grouped by the root-level run (or main turn) that spawned them
//   deriveAgentFilter(rows, opts?)    the Agents rows for a status chip and a search, with each chip's count
//   deriveBand(s, now, opts?)         one compact model for a bar above the prompt
//   formatStatusLine(band)            the status line's text (`$30.36 · ctx 25% · 3▶ · cache 3m`)
//   contextSegmentOf(name)            which band segment a breakdown row's label belongs to
//
// Estimates are labelled as such in their field docs; see NOTES.md, "Insights API".

import type {
  TelemetryAgentReport,
  TelemetryAlert,
  TelemetryAlertLevel,
  TelemetryAlerts,
  TelemetryContextCategory,
  TelemetryState,
  TelemetryStep,
} from '../types'

import {
  ageOf,
  deriveAgents,
  deriveOverview,
  deriveReconciliation,
  fmtPct,
  fmtTokens,
  fmtUsd,
  groupOf,
  isActive,
  isFoldedAgent,
  isStaleLoop,
  isTime,
  percentile,
  sessionAgeMs,
  share,
  type AgentGroup,
  type TelemetryAgentRow,
} from './derive'
import { STALE_AFTER_MS } from './model'
import { costOf, DEFAULT_PRICING_ID, findPricing, modelLabel, ratesFor } from './pricing'

const MAIN = 'main'

/** The state the insights read: every telemetry atom, and the alert engine's atom when the caller has it. */
export type TelemetryInsightsState = TelemetryState & { alerts?: TelemetryAlerts | null }

const sumBy = <T>(list: readonly T[], f: (item: T) => number): number => list.reduce((n, item) => n + f(item), 0)

/** The latest main-loop request with usage, and the one before it. */
function lastMainSteps(steps: readonly TelemetryStep[], agentId = MAIN): { last: TelemetryStep | null; prev: TelemetryStep | null } {
  let last: TelemetryStep | null = null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (!step || step.agentId !== agentId || !step.hasUsage) continue
    if (last === null) last = step
    else return { last, prev: step }
  }
  return { last, prev: null }
}

const mainModelOf = (s: Pick<TelemetryState, 'meta' | 'context'>): string => s.meta.mainModel ?? s.context.breakdown?.model ?? DEFAULT_PRICING_ID

// ================================================================ bloat

/** Thresholds of the bloat verdict: under `rareCalls` calls, or no call for `rareIdleMs`, is rare. */
export const BLOAT_DEFAULTS = { rareCalls: 3, rareIdleMs: 30 * 60_000 } as const

export type TelemetryBloatKind = 'mcp-server' | 'skill' | 'skills' | 'custom-agent' | 'memory' | 'system-tools' | 'system-prompt' | 'slash-commands'

/** `n/a`: nothing a call could show is observable for the row (a memory file, the system prompt, the listings). */
export type TelemetryBloatVerdict = 'unused' | 'rare' | 'active' | 'n/a'

export type TelemetryBloatRow = {
  /** `<kind>:<name>`, stable across breakdowns. */
  key: string
  kind: TelemetryBloatKind
  name: string
  /** Tokens it puts in the window on every main-loop request (deferred schemas excluded). */
  tokensPerRequest: number
  /** Tokens of its schemas outside the window (MCP tools loaded on demand): never counted as waste. */
  deferredTokens: number
  /** All of it is outside the window. */
  isDeferred: boolean
  /** tokensPerRequest over the window the breakdown measured against. */
  windowShare: number | null
  /** Calls this session (MCP tools, Skill calls, spawns of the agent type, built-in tool calls); null where none is observable. */
  callsThisSession: number | null
  lastUsedAt: number | null
  lastUsedAgoMs: number | null
  /** Main-loop requests this mod saw (each one re-sent the row). */
  requestsSeen: number
  /**
   * ESTIMATE: tokensPerRequest × requestsSeen when it was never called; 0 when
   * it was; null where calls are not observable. Assumes the row was in the
   * context for every request seen (it may have been connected later).
   */
  wasteTokens: number | null
  /** ESTIMATE: wasteTokens at the main model's cache-read rate (a cached prefix is billed so); null with wasteTokens. */
  estCostUsd: number | null
  verdict: TelemetryBloatVerdict
  /** The token figure itself is approximate (an old breakdown without the loaded/deferred split: split by tool count). */
  isTokenEstimate: boolean
  /** Extra facts: `4 of 30 tools loaded`, the memory file's type, the skill's source. */
  detail: string | null
}

export type TelemetryBloatTotals = {
  windowTokens: number | null
  /** Sum of the rows' tokensPerRequest. */
  inWindowTokens: number
  /** Deferred rows of the breakdown (outside the window). */
  deferredTokens: number
  /** ESTIMATE. */
  wasteTokens: number
  /** ESTIMATE. */
  estCostUsd: number
  unused: number
  rare: number
  requestsSeen: number
  model: string
  cacheReadUsdPerMTok: number
}

export type TelemetryBloat =
  | { isReady: false; needsFullBreakdown: true; reason: string }
  | {
      isReady: true
      needsFullBreakdown: false
      /** The waste figures are estimates (see the row docs). */
      isEstimate: true
      rows: TelemetryBloatRow[]
      totals: TelemetryBloatTotals
      breakdownAt: number
      breakdownDetail: 'summary' | 'full'
    }

const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_')

function verdictOf(calls: number, lastUsedAgoMs: number | null, rare: { rareCalls: number; rareIdleMs: number }): TelemetryBloatVerdict {
  if (calls === 0) return 'unused'
  if (calls < rare.rareCalls || (lastUsedAgoMs !== null && lastUsedAgoMs > rare.rareIdleMs)) return 'rare'
  return 'active'
}

/**
 * The context-bloat audit: every row the latest breakdown says each request
 * carries, its calls this session, and the tokens re-sent for nothing when it
 * was never called (an estimate). Needs a `full` breakdown taken once
 * (`collect.refreshContext(io, 'full')`); before, `{ isReady: false }`.
 * Sorted by waste, then by tokens.
 */
export function deriveBloat(
  s: Pick<TelemetryState, 'context' | 'totals' | 'agents' | 'meta'>,
  now: number,
  opts: { rareCalls?: number; rareIdleMs?: number } = {},
): TelemetryBloat {
  const b = s.context.breakdown
  if (b === null || s.context.lastFullAt === null) {
    return { isReady: false, needsFullBreakdown: true, reason: b === null ? 'no context breakdown yet' : 'only a summary breakdown so far: per-tool counts need a full one' }
  }
  const rare = { rareCalls: opts.rareCalls ?? BLOAT_DEFAULTS.rareCalls, rareIdleMs: opts.rareIdleMs ?? BLOAT_DEFAULTS.rareIdleMs }
  const main = s.agents.byId[MAIN]
  const requestsSeen = main?.usage.requests ?? 0
  const model = mainModelOf(s)
  const rate = ratesFor(findPricing(model).entry, main?.lastContextTokens ?? 0).cacheRead
  const window = b.maxTokens > 0 ? b.maxTokens : s.context.window
  const tools = Object.values(s.totals.byTool)
  const rows: TelemetryBloatRow[] = []

  const add = (
    kind: TelemetryBloatKind,
    name: string,
    tokens: number,
    calls: number | null,
    lastUsedAt: number | null,
    extra: { deferredTokens?: number; isTokenEstimate?: boolean; detail?: string | null; observable?: boolean } = {},
  ): void => {
    const deferred = Math.max(0, extra.deferredTokens ?? 0)
    const inWindow = Math.max(0, tokens)
    const ago = isTime(lastUsedAt) ? Math.max(0, now - lastUsedAt) : null
    const observable = calls !== null && extra.observable !== false
    const waste = !observable ? null : calls === 0 ? inWindow * requestsSeen : 0
    rows.push({
      key: `${kind}:${name}`,
      kind,
      name,
      tokensPerRequest: inWindow,
      deferredTokens: deferred,
      isDeferred: inWindow === 0 && deferred > 0,
      windowShare: window ? share(inWindow, window) : null,
      callsThisSession: calls,
      lastUsedAt: isTime(lastUsedAt) ? lastUsedAt : null,
      lastUsedAgoMs: ago,
      requestsSeen,
      wasteTokens: waste,
      estCostUsd: waste === null ? null : (waste * rate) / 1_000_000,
      verdict: !observable || calls === null ? 'n/a' : inWindow === 0 && deferred > 0 && calls === 0 ? 'unused' : verdictOf(calls, ago, rare),
      isTokenEstimate: extra.isTokenEstimate ?? false,
      detail: extra.detail ?? null,
    })
  }

  // MCP servers: calls matched by the wire name's server segment (mcp__<segment>__tool)
  const details = new Map((b.mcpServerDetail ?? []).map(d => [d.server, d]))
  for (const srv of b.mcpServers) {
    const detail = details.get(srv.server)
    const loaded = detail ? detail.loadedTokens : srv.tools > 0 ? Math.round((srv.tokens * srv.loadedTools) / srv.tools) : 0
    const prefixes = new Set((detail?.wirePrefixes.length ? detail.wirePrefixes : [srv.server]).map(norm))
    const mine = tools.filter(t => t.server !== null && prefixes.has(norm(t.server)))
    const lastAt = mine.reduce<number | null>((m, t) => (isTime(t.lastAt) && (m === null || t.lastAt > m) ? t.lastAt : m), null)
    add('mcp-server', srv.server, loaded, sumBy(mine, t => t.calls), lastAt, {
      deferredTokens: srv.tokens - loaded,
      isTokenEstimate: detail === undefined && srv.loadedTools < srv.tools,
      detail: `${srv.loadedTools} of ${srv.tools} tools loaded`,
    })
  }

  // skills: one row each when the breakdown listed them, else the listing as one row
  const bySkill = s.totals.bySkill ?? {}
  if (b.skillRows && b.skillRows.length > 0) {
    for (const k of b.skillRows) {
      const names = [k.name, k.pluginName ? `${k.pluginName}:${k.name}` : null].filter((n): n is string => n !== null)
      const hits = names.map(n => bySkill[n]).filter((x): x is NonNullable<typeof x> => x !== undefined)
      const lastAt = hits.reduce<number | null>((m, x) => (m === null || x.lastAt > m ? x.lastAt : m), null)
      add('skill', k.pluginName ? `${k.pluginName}:${k.name}` : k.name, k.tokens, sumBy(hits, x => x.calls), lastAt, { detail: k.source })
    }
  } else if (b.skills && b.skills.tokens > 0) {
    const skill = s.totals.byTool.Skill
    add('skills', 'Skill listing', b.skills.tokens, skill?.calls ?? 0, skill?.lastAt ?? null, { detail: `${b.skills.included} of ${b.skills.total} skills listed` })
  }

  // custom agents: spawns of the type
  for (const a of b.customAgents) {
    const runs = s.agents.order.map(id => s.agents.byId[id]).filter(x => x !== undefined && x.id !== MAIN && x.type === a.agentType)
    const lastAt = runs.reduce<number | null>((m, x) => {
      const t = x?.spawnedAt ?? x?.firstSeenAt ?? null
      return isTime(t) && (m === null || t > m) ? t : m
    }, null)
    add('custom-agent', a.agentType, a.tokens, runs.length, lastAt, { detail: a.source })
  }

  // memory files: nothing calls them
  for (const f of b.memoryFiles) add('memory', f.path, f.tokens, null, null, { detail: f.type })

  // the fixed rows of the breakdown
  const used = b.categories.filter(c => c.kind === 'used')
  const prompt = used.filter(c => contextSegmentOf(c.name) === 'system-prompt')
  if (prompt.length > 0) add('system-prompt', 'System prompt', sumBy(prompt, c => c.tokens), null, null)
  const builtin = used.filter(c => contextSegmentOf(c.name) === 'system-tools')
  if (builtin.length > 0) {
    // per built-in tool tokens are not in the breakdown: the calls are shown, the verdict is n/a
    const own = tools.filter(t => t.server === null && !t.isServerTool)
    const lastAt = own.reduce<number | null>((m, t) => (isTime(t.lastAt) && (m === null || t.lastAt > m) ? t.lastAt : m), null)
    add('system-tools', 'System tools', sumBy(builtin, c => c.tokens), sumBy(own, t => t.calls), lastAt, { observable: false, detail: `${own.length} tools called` })
  }
  if (b.slashCommands && b.slashCommands.tokens > 0) {
    add('slash-commands', 'Slash commands', b.slashCommands.tokens, null, null, { detail: `${b.slashCommands.included} of ${b.slashCommands.total} listed` })
  }

  rows.sort((a, z) => (z.wasteTokens ?? -1) - (a.wasteTokens ?? -1) || z.tokensPerRequest - a.tokensPerRequest || a.key.localeCompare(z.key))
  const wasteTokens = sumBy(rows, r => r.wasteTokens ?? 0)
  return {
    isReady: true,
    needsFullBreakdown: false,
    isEstimate: true,
    rows,
    totals: {
      windowTokens: window,
      inWindowTokens: sumBy(rows, r => r.tokensPerRequest),
      deferredTokens: sumBy(b.categories.filter(c => c.kind === 'deferred' || c.isDeferred), c => c.tokens),
      wasteTokens,
      estCostUsd: (wasteTokens * rate) / 1_000_000,
      unused: rows.filter(r => r.verdict === 'unused').length,
      rare: rows.filter(r => r.verdict === 'rare').length,
      requestsSeen,
      model,
      cacheReadUsdPerMTok: rate,
    },
    breakdownAt: b.at,
    breakdownDetail: b.detail,
  }
}

// ================================================================ cache clock

export type TelemetryCacheStatus = 'warm' | 'cooling' | 'cold' | 'unknown'

/** Under this long to expiry the cache is `cooling`. */
export const CACHE_COOLING_MS = 60_000

export type TelemetryCacheLoop = {
  agentId: string
  label: string
  model: string | null
  /** The start of the loop's latest request (the cache's TTL is refreshed when the prefix is read). */
  lastRequestAt: number | null
  ttl: '5m' | '1h'
  ttlMs: number
  /**
   * Where the TTL comes from: `switch` when a model-switch event set it (the
   * only event that reports it), else `default`: 5 minutes is then an
   * assumption, not an observation.
   */
  ttlSource: 'switch' | 'default'
  expiresAt: number | null
  /** Negative once expired. */
  expiresInMs: number | null
  status: TelemetryCacheStatus
  /** A compaction or a model switch after the latest request: the cache is cold whatever the clock says. */
  invalidatedBy: 'compaction' | 'model-switch' | null
  /** The prompt the next request would re-send: the latest request's input + cache read + cache write. */
  contextTokens: number
  /** ESTIMATE: writing `contextTokens` to the cache again at the TTL's write rate. */
  recacheCostUsd: number | null
  /** Reading them from the cache instead. */
  hitCostUsd: number | null
  /** recache - hit: what letting it expire costs on the next request. */
  recacheExtraUsd: number | null
  /** The latest request wrote more than it read (≥ 2,048 written): its prefix was not served from the cache. */
  lastTurnWasCacheMiss: boolean
  /** ESTIMATE: what the miss cost over a hit: min(cache write, the request before's prompt) at write minus read rate; null without a request before. */
  missCostUsd: number | null
}

export type TelemetryCacheClock = TelemetryCacheLoop & {
  /** No main turn open (or its loop went quiet): nothing will refresh the cache until the person sends something. */
  isMainIdle: boolean
  /** A completed Agent report showed 1-hour cache writes (the only per-request split observable). */
  oneHourWritesSeen: boolean
  /** The same, per running subagent with a request (stale and unattributed loops left out). */
  agents: TelemetryCacheLoop[]
}

function cacheLoop(
  s: Pick<TelemetryState, 'steps' | 'meta' | 'context'>,
  agentId: string,
  label: string,
  fallbackModel: string | null,
  now: number,
): TelemetryCacheLoop {
  const { last, prev } = lastMainSteps(s.steps, agentId)
  const ttl = s.meta.cacheTtl
  const ttlMs = ttl === '1h' ? 3_600_000 : 300_000
  const ttlSource: 'switch' | 'default' = ttl === '1h' || s.meta.modelSwitches.some(sw => sw.source !== 'observed') ? 'switch' : 'default'
  const model = last?.model ?? fallbackModel
  const base = { agentId, label, model, ttl, ttlMs, ttlSource }
  if (last === null || !isTime(last.startedAt)) {
    return { ...base, lastRequestAt: null, expiresAt: null, expiresInMs: null, status: 'unknown', invalidatedBy: null, contextTokens: 0, recacheCostUsd: null, hitCostUsd: null, recacheExtraUsd: null, lastTurnWasCacheMiss: false, missCostUsd: null }
  }
  const at = last.startedAt
  const expiresAt = at + ttlMs
  const expiresInMs = expiresAt - now
  let invalidatedBy: TelemetryCacheLoop['invalidatedBy'] = null
  if (agentId === MAIN) {
    if (s.context.compactions.some(k => k.skipped === null && k.agentId === MAIN && isTime(k.at) && k.at > last.endedAt)) invalidatedBy = 'compaction'
    else if (s.meta.modelSwitches.some(sw => isTime(sw.at) && sw.at > last.endedAt)) invalidatedBy = 'model-switch'
  }
  const status: TelemetryCacheStatus = invalidatedBy !== null || expiresInMs <= 0 ? 'cold' : expiresInMs <= CACHE_COOLING_MS ? 'cooling' : 'warm'
  const ctx = last.contextTokens
  const pricedModel = model ?? DEFAULT_PRICING_ID
  const recache = costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: ctx }, pricedModel, ttl).cacheWriteUsd
  const hit = costOf({ input: 0, output: 0, cacheRead: ctx, cacheWrite: 0 }, pricedModel, ttl).cacheReadUsd
  const isMiss = last.cacheWrite >= 2048 && last.cacheWrite > last.cacheRead
  let missCostUsd: number | null = null
  if (isMiss && prev !== null) {
    const rewritten = Math.min(last.cacheWrite, prev.contextTokens)
    const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: rewritten }
    missCostUsd = costOf(counts, last.model, ttl).cacheWriteUsd - costOf({ ...counts, cacheRead: rewritten, cacheWrite: 0 }, last.model, ttl).cacheReadUsd
  }
  return {
    ...base,
    lastRequestAt: at,
    expiresAt,
    expiresInMs,
    status,
    invalidatedBy,
    contextTokens: ctx,
    recacheCostUsd: recache,
    hitCostUsd: hit,
    recacheExtraUsd: recache - hit,
    lastTurnWasCacheMiss: isMiss,
    missCostUsd,
  }
}

const reportHasOneHour = (r: TelemetryAgentReport | null): boolean => r !== null && (r.cacheWrite1h ?? 0) > 0

/** The prompt cache's clock for the main loop (and each running subagent). */
export function deriveCacheClock(s: Pick<TelemetryState, 'steps' | 'meta' | 'context' | 'agents' | 'tools'>, now: number): TelemetryCacheClock {
  const main = cacheLoop(s, MAIN, 'main', s.meta.mainModel, now)
  const mainTurnOpen = s.meta.activeTurns[MAIN] !== undefined && !isStaleLoop(s, MAIN, now)
  const agents: TelemetryCacheLoop[] = []
  let oneHour = false
  for (const id of s.agents.order) {
    const agent = s.agents.byId[id]
    if (!agent || id === MAIN) continue
    if (reportHasOneHour(agent.report)) oneHour = true
    if (agent.status !== 'running' || isStaleLoop(s, id, now) || agent.steps === 0) continue
    agents.push(cacheLoop(s, id, agent.name ?? (agent.description || agent.type), agent.model, now))
  }
  return { ...main, isMainIdle: !mainTurnOpen, oneHourWritesSeen: oneHour, agents }
}

// ================================================================ alerts

export type TelemetryAlertsMode = 'off' | 'quiet' | 'all'

export type TelemetryAlertRules = {
  /** off: no alerts; quiet: toasts for crit only; all: toasts for warn and crit. */
  mode: TelemetryAlertsMode
  statusLine: boolean
  /** 0 turns the budget alert off. */
  budgetUsd: number
  budgetWarnShare: number
  /** Of the auto-compact threshold (of the window when auto-compact is off), 0..100. */
  contextWarnPct: number
  contextCritPct: number
  burnSpikeMultiplier: number
  /** The median is floored at this, so a near-idle baseline does not make every busy minute a spike. */
  burnMinUsdPerMin: number
  burnBaselineMs: number
  /** No spike alert before this much history (from the first step). */
  burnMinHistoryMs: number
  agentLongRunMs: number
  toolErrorRate: number
  toolErrorMinCalls: number
  toolErrorWindowMs: number
  /** Warn this long before the cache expires while main is idle. */
  cacheWarnMs: number
  cacheMinRecacheUsd: number
  /** At most one toast per this long. */
  toastEveryMs: number
  /** A key that fired does not fire again within this, even after it cleared and came back. */
  cooldownMs: number
  /** The status line is rewritten at most this often. */
  statusEveryMs: number
  logSize: number
}

export const DEFAULT_ALERT_RULES: TelemetryAlertRules = {
  mode: 'quiet',
  statusLine: false,
  budgetUsd: 0,
  budgetWarnShare: 0.8,
  contextWarnPct: 70,
  contextCritPct: 90,
  burnSpikeMultiplier: 3,
  burnMinUsdPerMin: 0.05,
  burnBaselineMs: 15 * 60_000,
  burnMinHistoryMs: 5 * 60_000,
  agentLongRunMs: 30 * 60_000,
  toolErrorRate: 0.3,
  toolErrorMinCalls: 10,
  toolErrorWindowMs: 5 * 60_000,
  cacheWarnMs: 60_000,
  cacheMinRecacheUsd: 0.1,
  toastEveryMs: 30_000,
  cooldownMs: 5 * 60_000,
  statusEveryMs: 2_000,
  logSize: 50,
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null)

/**
 * The rules from the manifest's `userConfig` values (`register(on, options)`):
 * `alertsEnabled` (`quiet` | `all` | `off`; a boolean reads as quiet / off),
 * `budgetUsd`, `contextWarnPct`, `burnSpikeMultiplier`, `statusLine`. A value
 * missing or out of range keeps the default.
 */
export function rulesFromOptions(options: Readonly<Record<string, unknown>> | null | undefined): TelemetryAlertRules {
  const o = options ?? {}
  const rules = { ...DEFAULT_ALERT_RULES }
  const mode = o.alertsEnabled
  if (mode === 'off' || mode === 'quiet' || mode === 'all') rules.mode = mode
  else if (mode === false) rules.mode = 'off'
  else if (mode === true) rules.mode = 'quiet'
  const budget = finite(o.budgetUsd)
  if (budget !== null && budget >= 0) rules.budgetUsd = budget
  const warn = finite(o.contextWarnPct)
  if (warn !== null && warn > 0) rules.contextWarnPct = Math.min(warn, rules.contextCritPct)
  const mult = finite(o.burnSpikeMultiplier)
  if (mult !== null && mult >= 1) rules.burnSpikeMultiplier = mult
  if (typeof o.statusLine === 'boolean') rules.statusLine = o.statusLine
  else if (o.statusLine === 'on' || o.statusLine === 'true') rules.statusLine = true
  return rules
}

export type TelemetryAlertKind = 'context' | 'burn' | 'agent-stale' | 'agent-long' | 'tool-errors' | 'cache-expiring' | 'budget'

/** One condition active now. Its text holds figures, tool names and agent descriptions only: never a tool's input or error text. */
export type TelemetryActiveAlert = {
  key: string
  kind: TelemetryAlertKind
  level: TelemetryAlertLevel
  message: string
  /** A few words for the status line and the band (`ctx 92%`). */
  short: string
}

export type TelemetryAlertsView = {
  /** Crit first, then by kind. */
  active: TelemetryActiveAlert[]
  /** The stored log (the `alerts` atom), newest first; empty without it. */
  log: TelemetryAlert[]
  unacked: number
  /** The burn rule's figures, for a view that wants to show the baseline. */
  burn: { usdPerMinute: number | null; medianUsdPerMinute: number | null; threshold: number | null }
}

const KIND_ORDER: Record<TelemetryAlertKind, number> = { budget: 0, context: 1, 'cache-expiring': 2, burn: 3, 'tool-errors': 4, 'agent-stale': 5, 'agent-long': 6 }
const LEVEL_RANK: Record<TelemetryAlertLevel, number> = { warn: 1, crit: 2 }

const clipLabel = (text: string, max = 60): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}m`

/** The context fill against the auto-compact threshold (or the window), 0..100, with what it is measured against. */
export function contextPressure(s: Pick<TelemetryState, 'context'>): { tokens: number | null; base: number | null; against: 'auto-compact' | 'window' | null; pct: number | null } {
  const b = s.context.breakdown
  const tokens = s.context.tokens ?? b?.totalTokens ?? null
  const compactAt = b && b.isAutoCompactEnabled && b.autoCompactThreshold !== null && b.autoCompactThreshold > 0 ? b.autoCompactThreshold : null
  const window = s.context.window ?? (b && b.maxTokens > 0 ? b.maxTokens : null)
  const base = compactAt ?? window
  return { tokens, base, against: compactAt !== null ? 'auto-compact' : window !== null ? 'window' : null, pct: tokens !== null && base ? (tokens / base) * 100 : null }
}

/** Spend per minute over the `binsMs` before now, one-minute bins (zeros included), and their median. */
function burnBaseline(steps: readonly TelemetryStep[], now: number, windowMs: number): { bins: number[]; median: number | null } {
  const n = Math.max(1, Math.round(windowMs / 60_000))
  const bins = new Array<number>(n).fill(0)
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (!step) continue
    const age = now - step.endedAt
    if (age >= n * 60_000) break
    if (age < 0) continue
    const k = Math.floor(age / 60_000)
    bins[k] = (bins[k] ?? 0) + step.costUsd
  }
  return { bins, median: percentile(bins, 50) }
}

/** The alert conditions active at `now` under `rules`, and the stored log. Pure: firing, dedupe and toasts are `stepAlerts`. */
export function deriveAlerts(s: TelemetryInsightsState, now: number, rules: TelemetryAlertRules = DEFAULT_ALERT_RULES): TelemetryAlertsView {
  const log = [...(s.alerts?.log ?? [])].reverse()
  const unacked = log.filter(a => !a.ackd).length
  const active: TelemetryActiveAlert[] = []
  let burnView: TelemetryAlertsView['burn'] = { usdPerMinute: null, medianUsdPerMinute: null, threshold: null }
  if (rules.mode === 'off') return { active, log, unacked, burn: burnView }

  // budget
  const total = deriveReconciliation(s).totalUsd
  if (rules.budgetUsd > 0) {
    const used = total / rules.budgetUsd
    if (used >= 1) active.push({ key: 'budget', kind: 'budget', level: 'crit', message: `Session cost ${fmtUsd(total)} is over the ${fmtUsd(rules.budgetUsd)} budget`, short: `budget ${fmtPct(used)}` })
    else if (used >= rules.budgetWarnShare) active.push({ key: 'budget', kind: 'budget', level: 'warn', message: `Session cost ${fmtUsd(total)} is ${fmtPct(used)} of the ${fmtUsd(rules.budgetUsd)} budget`, short: `budget ${fmtPct(used)}` })
  }

  // context
  const ctx = contextPressure(s)
  if (ctx.pct !== null && ctx.base !== null) {
    const level: TelemetryAlertLevel | null = ctx.pct >= rules.contextCritPct ? 'crit' : ctx.pct >= rules.contextWarnPct ? 'warn' : null
    if (level !== null) {
      const of = ctx.against === 'auto-compact' ? 'the auto-compact threshold' : 'the window'
      active.push({ key: 'context', kind: 'context', level, message: `Context at ${Math.round(ctx.pct)}% of ${of} (${fmtTokens(ctx.tokens)} of ${fmtTokens(ctx.base)})`, short: `ctx ${Math.round(ctx.pct)}%` })
    }
  }

  // cache about to expire while main is idle
  const clock = deriveCacheClock(s, now)
  if (clock.isMainIdle && clock.status !== 'cold' && clock.status !== 'unknown' && clock.expiresInMs !== null && clock.expiresInMs <= rules.cacheWarnMs && (clock.recacheCostUsd ?? 0) >= rules.cacheMinRecacheUsd) {
    active.push({
      key: 'cache-expiring',
      kind: 'cache-expiring',
      level: 'warn',
      message: `Prompt cache expires in ${Math.max(0, Math.round(clock.expiresInMs / 1000))}s; re-caching ${fmtTokens(clock.contextTokens)} tokens would cost about ${fmtUsd(clock.recacheCostUsd)}`,
      short: 'cache <1m',
    })
  }

  // burn spike
  const overview = deriveOverview(s, now)
  const current = overview.burn.usdPerMinute
  const first = s.totals.firstStepAt
  if (current !== null && isTime(first) && now - first >= rules.burnMinHistoryMs) {
    const { median } = burnBaseline(s.steps, now, rules.burnBaselineMs)
    const threshold = rules.burnSpikeMultiplier * Math.max(median ?? 0, rules.burnMinUsdPerMin)
    burnView = { usdPerMinute: current, medianUsdPerMinute: median, threshold }
    if (current > threshold) {
      const base = Math.max(median ?? 0, rules.burnMinUsdPerMin)
      active.push({
        key: 'burn',
        kind: 'burn',
        level: 'warn',
        message: `Burn ${fmtUsd(current)}/min, ${(current / base).toFixed(1)}× the 15-minute median (${fmtUsd(median ?? 0)}/min)`,
        short: `burn ${fmtUsd(current)}/m`,
      })
    }
  }

  // tool errors over the last window (finished engine calls; errors and interrupts, as deriveTools counts them)
  let finished = 0
  let failed = 0
  const failedBy = new Map<string, number>()
  for (let i = s.tools.length - 1; i >= 0; i -= 1) {
    const ev = s.tools[i]
    if (!ev || ev.isServerTool || ev.status === 'running' || !isTime(ev.endedAt)) continue
    if (now - ev.endedAt > rules.toolErrorWindowMs || ev.endedAt > now) continue
    finished += 1
    if (ev.status === 'error' || ev.status === 'interrupted') {
      failed += 1
      failedBy.set(ev.tool, (failedBy.get(ev.tool) ?? 0) + 1)
    }
  }
  if (finished >= rules.toolErrorMinCalls && failed / finished >= rules.toolErrorRate) {
    const worst = [...failedBy.entries()].sort((a, z) => z[1] - a[1])[0]?.[0] ?? null
    active.push({
      key: 'tool-errors',
      kind: 'tool-errors',
      level: 'warn',
      message: `${failed} of ${finished} tool calls failed in the last ${minutes(rules.toolErrorWindowMs)}${worst ? ` (mostly ${worst})` : ''}`,
      short: `tool errors ${fmtPct(failed / finished)}`,
    })
  }

  // agents: stale (a running loop gone quiet) and running too long; ghosts (folded rows) left out
  const age = sessionAgeMs(s, now)
  for (const row of deriveAgents(s, now)) {
    if (row.id === MAIN || isFoldedAgent(row)) continue
    const label = clipLabel(row.label || row.type)
    if (row.isStale) {
      const quiet = ageOf(now, s.agents.byId[row.id]?.lastActiveAt ?? null, age)
      active.push({ key: `agent-stale:${row.id}`, kind: 'agent-stale', level: 'warn', message: `Agent "${label}" has been quiet for ${quiet === null ? 'a while' : minutes(quiet)}`, short: 'agent stale' })
    } else if (row.isRunning && row.durationMs !== null && row.durationMs > rules.agentLongRunMs) {
      active.push({ key: `agent-long:${row.id}`, kind: 'agent-long', level: 'warn', message: `Agent "${label}" has been running for ${minutes(row.durationMs)}`, short: 'agent long' })
    }
  }

  active.sort((a, z) => LEVEL_RANK[z.level] - LEVEL_RANK[a.level] || KIND_ORDER[a.kind] - KIND_ORDER[z.kind] || a.key.localeCompare(z.key))
  return { active, log, unacked, burn: burnView }
}

export function emptyAlerts(now: number): TelemetryAlerts {
  return { schema: 1, log: [], seq: 0, conditions: {}, lastToastAt: null, updatedAt: now }
}

/** A stored value worth using, else a fresh one (an unknown shape, a value from before). */
export function alertsOrEmpty(value: TelemetryAlerts | null | undefined, now: number): TelemetryAlerts {
  if (!value || value.schema !== 1 || !Array.isArray(value.log) || typeof value.conditions !== 'object' || value.conditions === null) return emptyAlerts(now)
  return value
}

export type TelemetryAlertStep = {
  next: TelemetryAlerts
  /** Alerts that fired on this step (log entries). */
  fired: TelemetryAlert[]
  /** Texts to toast (at most one). */
  toasts: string[]
  changed: boolean
}

/**
 * The alert engine's memory, one step on: a condition fires once when it
 * becomes active (and again only if it escalates warn → crit), re-arms when it
 * clears, and does not fire again within `cooldownMs` of its last firing. A
 * fired alert raises a toast when its level is toasted in the mode (crit in
 * quiet, warn and crit in all) and no toast was raised in `toastEveryMs`; the
 * others stay in the log. Does not mutate `prev`.
 */
export function stepAlerts(prev: TelemetryAlerts, active: readonly TelemetryActiveAlert[], now: number, rules: TelemetryAlertRules = DEFAULT_ALERT_RULES): TelemetryAlertStep {
  const next: TelemetryAlerts = { ...prev, log: [...prev.log], conditions: { ...prev.conditions } }
  const fired: TelemetryAlert[] = []
  let changed = false
  const keys = new Set<string>()
  const conditions = rules.mode === 'off' ? [] : active
  for (const c of conditions) {
    keys.add(c.key)
    const st = next.conditions[c.key]
    const fire = (): void => {
      next.seq += 1
      const alert: TelemetryAlert = { id: `a${next.seq}`, key: c.key, level: c.level, message: c.message, at: now, ackd: false }
      next.log.push(alert)
      fired.push(alert)
    }
    if (st && st.active) {
      if (LEVEL_RANK[c.level] > LEVEL_RANK[st.level]) {
        fire()
        next.conditions[c.key] = { ...st, level: c.level, lastFiredAt: now }
        changed = true
      } else if (c.level !== st.level) {
        next.conditions[c.key] = { ...st, level: c.level }
        changed = true
      }
      continue
    }
    const cooling = st !== undefined && st.lastFiredAt > 0 && now - st.lastFiredAt < rules.cooldownMs
    if (!cooling) fire()
    next.conditions[c.key] = { active: true, level: c.level, since: now, lastFiredAt: cooling && st ? st.lastFiredAt : now }
    changed = true
  }
  for (const [key, st] of Object.entries(next.conditions)) {
    if (keys.has(key)) continue
    if (st.active) {
      next.conditions[key] = { ...st, active: false }
      changed = true
    } else if (now - st.lastFiredAt >= rules.cooldownMs) {
      delete next.conditions[key]
      changed = true
    }
  }
  if (next.log.length > rules.logSize) next.log.splice(0, next.log.length - rules.logSize)

  const toasts: string[] = []
  const toastable = fired
    .filter(a => a.level === 'crit' || (rules.mode === 'all' && a.level === 'warn'))
    .sort((a, z) => LEVEL_RANK[z.level] - LEVEL_RANK[a.level])
  const head = toastable[0]
  if (head && (next.lastToastAt === null || now - next.lastToastAt >= rules.toastEveryMs)) {
    toasts.push(head.message)
    next.lastToastAt = now
    changed = true
  }
  if (changed) next.updatedAt = now
  return { next, fired, toasts, changed }
}

/**
 * When the next time-driven change is due (a cache crossing its warning point
 * or expiring, the status line's cache minute ticking over, a running agent
 * going stale or running too long); null when nothing is pending.
 */
export function nextAlertCheckAt(s: TelemetryInsightsState, now: number, rules: TelemetryAlertRules = DEFAULT_ALERT_RULES): number | null {
  if (rules.mode === 'off' && !rules.statusLine) return null
  const due: number[] = []
  const clock = deriveCacheClock(s, now)
  if (clock.expiresAt !== null && clock.expiresInMs !== null && clock.expiresInMs > 0 && clock.invalidatedBy === null) {
    due.push(clock.expiresAt)
    if (rules.mode !== 'off' && clock.isMainIdle && clock.expiresInMs > rules.cacheWarnMs) due.push(clock.expiresAt - rules.cacheWarnMs)
    if (rules.statusLine) {
      const m = Math.floor(clock.expiresInMs / 60_000)
      if (m >= 1) due.push(clock.expiresAt - m * 60_000 + 1)
    }
  }
  if (rules.mode !== 'off') {
    for (const id of s.agents.order) {
      const agent = s.agents.byId[id]
      if (!agent || id === MAIN || agent.status !== 'running' || isStaleLoop(s, id, now)) continue
      if (isTime(agent.lastActiveAt)) due.push(agent.lastActiveAt + STALE_AFTER_MS + 1)
      const start = isTime(agent.spawnedAt) ? agent.spawnedAt : isTime(agent.firstSeenAt) ? agent.firstSeenAt : null
      if (start !== null && start + rules.agentLongRunMs > now) due.push(start + rules.agentLongRunMs + 1)
    }
  }
  const future = due.filter(t => t > now)
  return future.length > 0 ? Math.min(...future) : null
}

// ================================================================ workflows

export type TelemetryWorkflowStatus = 'running' | 'stale' | 'failed' | 'done'

export type TelemetryWorkflow = {
  /** `root:<agent id>` or `turn:<turn id>`. */
  id: string
  /** The first root's label (name, description or type), `+N` for more roots. Never prompt text. */
  name: string
  rootIds: string[]
  rootLabels: string[]
  agentIds: string[]
  /** Distinct agent types in it. */
  types: string[]
  /** The main turn that spawned it, when grouped by turn (or the root's turn is known). */
  turnId: string | null
  /** running (any running), else stale (any stale), else failed (any failed), else done. */
  status: TelemetryWorkflowStatus
  agentCount: number
  runningCount: number
  staleCount: number
  doneCount: number
  failureCount: number
  tokens: number
  costUsd: number
  /** Of the tracked sum (as deriveAgents' costShare). */
  costShare: number | null
  startedAt: number | null
  /** The last end; null while running. */
  endedAt: number | null
  /** First start to last end (or now while running; a stale loop's clock stops at its last activity). */
  wallMs: number | null
  /** The agents' own durations summed (nested runs overlap their parent, so this counts both). */
  agentMs: number
  /** agentMs / wallMs: about the number of agents at work at once. */
  parallelism: number | null
  /**
   * The root-to-leaf chain that spans the most wall time (its root's start to
   * its leaf's end; on a tie the deeper chain): the deepest work that held the
   * workflow up. `agentId` is the leaf. A root with no children is a chain of one.
   */
  criticalPath: { agentIds: string[]; agentId: string; label: string; durationMs: number } | null
  /** costUsd per minute of wall time. */
  costPerMinute: number | null
  /** The agent with the longest duration. */
  longest: { agentId: string; label: string; durationMs: number; isRunning: boolean } | null
}

type Span = { row: TelemetryAgentRow; start: number | null; end: number | null }

/**
 * Agents grouped into workflows: each root-level run (a child of main) with its
 * descendants (`groupBy: 'root'`, the default), or every root spawned in one
 * main turn together (`groupBy: 'turn'`; a root whose turn is not in the ring
 * stays on its own). Ghosts (unattributed and empty finished loops) are left
 * out; a stale loop counts as stale, never running. Running and stale first,
 * then newest start first.
 */
export function deriveWorkflows(
  s: Pick<TelemetryState, 'agents' | 'totals' | 'meta' | 'tools' | 'turns'>,
  now: number,
  opts: { groupBy?: 'root' | 'turn' } = {},
): TelemetryWorkflow[] {
  const rows = deriveAgents(s, now).filter(r => r.id !== MAIN && !isFoldedAgent(r))
  const byId = new Map(rows.map(r => [r.id, r]))
  const span = (r: TelemetryAgentRow): Span => {
    const agent = s.agents.byId[r.id]
    const start = agent ? (isTime(agent.spawnedAt) ? agent.spawnedAt : isTime(agent.firstSeenAt) ? agent.firstSeenAt : null) : null
    return { row: r, start, end: start !== null && r.durationMs !== null ? start + r.durationMs : null }
  }
  // the root of each row: its highest ancestor below main that is kept
  const rootOf = (id: string): string => {
    let cur = id
    const seen = new Set<string>()
    for (;;) {
      seen.add(cur)
      const parent = byId.get(cur)?.parentId ?? null
      if (parent === null || parent === MAIN || !byId.has(parent) || seen.has(parent)) return cur
      cur = parent
    }
  }
  const mainTurns = s.turns.filter(t => t.agentId === MAIN && isTime(t.startedAt))
  const turnOf = (start: number | null): string | null => {
    if (start === null) return null
    for (let i = mainTurns.length - 1; i >= 0; i -= 1) {
      const t = mainTurns[i]
      if (t && t.startedAt <= start && start <= (t.endedAt ?? now)) return t.turnId
    }
    return null
  }
  const groups = new Map<string, { rootIds: string[]; ids: string[]; turnId: string | null }>()
  for (const r of rows) {
    const root = rootOf(r.id)
    const rootSpan = span(byId.get(root) ?? r)
    const turnId = turnOf(rootSpan.start)
    const key = opts.groupBy === 'turn' && turnId !== null ? `turn:${turnId}` : `root:${root}`
    const g = groups.get(key) ?? { rootIds: [], ids: [], turnId }
    if (r.id === root) g.rootIds.push(root)
    g.ids.push(r.id)
    groups.set(key, g)
  }
  const tracked = s.totals.session.costUsd
  const out: TelemetryWorkflow[] = []
  for (const [id, g] of groups) {
    const members = g.ids.map(x => byId.get(x)).filter((r): r is TelemetryAgentRow => r !== undefined)
    const spans = members.map(span)
    const counts: Record<AgentGroup, number> = { running: 0, stale: 0, failed: 0, done: 0 }
    for (const r of members) counts[groupOf(r)] += 1
    const status: TelemetryWorkflowStatus = counts.running > 0 ? 'running' : counts.stale > 0 ? 'stale' : counts.failed > 0 ? 'failed' : 'done'
    const starts = spans.map(x => x.start).filter((t): t is number => t !== null)
    const ends = spans.map(x => x.end).filter((t): t is number => t !== null)
    const startedAt = starts.length > 0 ? Math.min(...starts) : null
    const lastEnd = ends.length > 0 ? Math.max(...ends) : null
    const wallMs = startedAt !== null && lastEnd !== null ? Math.max(0, lastEnd - startedAt) : null
    const agentMs = sumBy(members, r => r.durationMs ?? 0)
    const costUsd = sumBy(members, r => r.costUsd)

    // critical path: every root-to-leaf chain, by the wall time it spans
    const kids = new Map<string, string[]>()
    for (const r of members) {
      if (r.parentId !== null && g.ids.includes(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id])
    }
    let best: { ids: string[]; dur: number } | null = null
    const spanOf = new Map(spans.map(x => [x.row.id, x]))
    // a chain's duration: its root's start to its leaf's end (an ancestor's end when the leaf's is unknown)
    const walk = (cur: string, path: string[], rootStart: number | null, knownEnd: number | null): void => {
      const end = spanOf.get(cur)?.end ?? knownEnd
      const next = [...path, cur]
      const children = kids.get(cur) ?? []
      if (children.length === 0) {
        const dur = rootStart !== null && end !== null ? Math.max(0, end - rootStart) : 0
        if (best === null || dur > best.dur || (dur === best.dur && next.length > best.ids.length)) best = { ids: next, dur }
        return
      }
      for (const child of children) walk(child, next, rootStart, end)
    }
    for (const root of g.rootIds) walk(root, [], spanOf.get(root)?.start ?? null, null)
    const crit = best as { ids: string[]; dur: number } | null
    const leaf = crit ? crit.ids[crit.ids.length - 1] : undefined
    const leafRow = leaf !== undefined ? byId.get(leaf) : undefined

    const longestRow = members.reduce<TelemetryAgentRow | null>((m, r) => (r.durationMs !== null && (m === null || (m.durationMs ?? -1) < r.durationMs) ? r : m), null)
    const rootLabels = g.rootIds.map(x => clipLabel(byId.get(x)?.label || byId.get(x)?.type || x))
    const firstLabel = rootLabels[0] ?? clipLabel(members[0]?.label ?? id)
    out.push({
      id,
      name: rootLabels.length > 1 ? `${firstLabel} +${rootLabels.length - 1}` : firstLabel,
      rootIds: g.rootIds,
      rootLabels,
      agentIds: g.ids,
      types: [...new Set(members.map(r => r.type))],
      turnId: g.turnId,
      status,
      agentCount: members.length,
      runningCount: counts.running,
      staleCount: counts.stale,
      doneCount: counts.done,
      failureCount: counts.failed,
      tokens: sumBy(members, r => r.tokens),
      costUsd,
      costShare: share(costUsd, tracked),
      startedAt,
      endedAt: status === 'running' ? null : lastEnd,
      wallMs,
      agentMs,
      parallelism: wallMs !== null && wallMs > 0 ? agentMs / wallMs : null,
      criticalPath: crit && leaf !== undefined ? { agentIds: crit.ids, agentId: leaf, label: clipLabel(leafRow?.label || leafRow?.type || leaf), durationMs: crit.dur } : null,
      costPerMinute: wallMs !== null && wallMs > 0 ? costUsd / (wallMs / 60_000) : null,
      longest: longestRow && longestRow.durationMs !== null ? { agentId: longestRow.id, label: clipLabel(longestRow.label || longestRow.type), durationMs: longestRow.durationMs, isRunning: longestRow.isRunning } : null,
    })
  }
  const rank: Record<TelemetryWorkflowStatus, number> = { running: 0, stale: 1, failed: 2, done: 2 }
  return out.sort((a, z) => rank[a.status] - rank[z.status] || (z.startedAt ?? 0) - (a.startedAt ?? 0))
}

// ================================================================ agent filter

export type TelemetryAgentFilterStatus = 'all' | AgentGroup

export type TelemetryAgentFilter = {
  rows: TelemetryAgentRow[]
  /** Per chip, over the rows that match the query (main and folded rows left out of the counts). */
  counts: Record<TelemetryAgentFilterStatus, number>
}

/**
 * The Agents rows for a filter chip and a search: `status` groups as the
 * Agents tab does (`groupOf`), `query` matches name / description / type /
 * model case-insensitively. Order is kept. Main is kept only with
 * `includeMain`, folded rows (ghosts) only with `includeFolded`.
 */
export function deriveAgentFilter(
  rows: readonly TelemetryAgentRow[],
  opts: { status?: TelemetryAgentFilterStatus; query?: string; includeMain?: boolean; includeFolded?: boolean } = {},
): TelemetryAgentFilter {
  const status = opts.status ?? 'all'
  const q = (opts.query ?? '').trim().toLowerCase()
  const matches = (r: TelemetryAgentRow): boolean =>
    q === '' || [r.label, r.description, r.type, r.model ?? '', r.modelLabel ?? '', ...r.models].some(text => text.toLowerCase().includes(q))
  const counts: Record<TelemetryAgentFilterStatus, number> = { all: 0, running: 0, stale: 0, failed: 0, done: 0 }
  const out: TelemetryAgentRow[] = []
  for (const r of rows) {
    const isMain = r.id === MAIN
    const folded = !isMain && isFoldedAgent(r)
    if (!matches(r)) continue
    if (!isMain && !folded) {
      counts.all += 1
      counts[groupOf(r)] += 1
    }
    if (isMain && !opts.includeMain) continue
    if (folded && !opts.includeFolded) continue
    if (status !== 'all' && (isMain || groupOf(r) !== status)) continue
    out.push(r)
  }
  return { rows: out, counts }
}

// ================================================================ band

export type TelemetryBandSegmentKey = 'system-prompt' | 'system-tools' | 'mcp-tools' | 'skills' | 'memory' | 'other' | 'messages'

const SEGMENT_ORDER: TelemetryBandSegmentKey[] = ['system-prompt', 'system-tools', 'mcp-tools', 'skills', 'memory', 'other', 'messages']
const SEGMENT_LABEL: Record<TelemetryBandSegmentKey, string> = {
  'system-prompt': 'System prompt',
  'system-tools': 'System tools',
  'mcp-tools': 'MCP tools',
  skills: 'Skills',
  memory: 'Memory',
  other: 'Other',
  messages: 'Messages',
}

/**
 * The band segment of a breakdown row, by its label: the engine's `kind`
 * cannot split the used rows, so this depends on /context's wording
 * (`System prompt`, `System tools`, `MCP tools`, `Skills`, `Memory files`,
 * `Messages`); anything else is `other`.
 */
export function contextSegmentOf(name: string): TelemetryBandSegmentKey {
  if (/system\s*prompt/i.test(name)) return 'system-prompt'
  if (/system\s*tools?/i.test(name)) return 'system-tools'
  if (/\bmcp\b/i.test(name)) return 'mcp-tools'
  if (/skill/i.test(name)) return 'skills'
  if (/memory/i.test(name)) return 'memory'
  if (/message/i.test(name)) return 'messages'
  return 'other'
}

export type TelemetryBandTone = 'ok' | 'warn' | 'crit' | 'unknown'

export type TelemetryBand = {
  /** The main model's short label (`Opus 5.5`); `Session` when unknown. */
  title: string
  model: string | null
  /** The ledger when known (and not under the tracked sum), else the tracked estimate. */
  costUsd: number
  costSource: 'ledger' | 'estimate'
  trackedUsd: number
  /** Subagents (ghosts left out), by the Agents tab's groups. */
  running: number
  done: number
  failed: number
  stale: number
  burnUsdPerMin: number | null
  context: {
    tokens: number | null
    window: number | null
    /** Of the window, 0..100. */
    percent: number | null
    fill: number | null
    /** By the alert rules' thresholds against the auto-compact threshold (or the window). */
    tone: TelemetryBandTone
    /** Of the auto-compact threshold (or the window), 0..1. */
    pressure: number | null
    compactAtTokens: number | null
    /**
     * Used rows by segment, in a fixed order, each with its share of the
     * window. From the latest breakdown; when the window was measured after it,
     * Messages is the rest of the measured tokens (an estimate), so the
     * segments add up to `tokens`. Empty before the first breakdown.
     */
    segments: { key: TelemetryBandSegmentKey; label: string; tokens: number; share: number | null }[]
    /** Messages was re-estimated from a later measure. */
    isMessagesEstimate: boolean
    freeTokens: number | null
    /** The auto-compact reserve. */
    bufferTokens: number | null
    breakdownAt: number | null
  }
  cache: {
    status: TelemetryCacheStatus
    expiresInMs: number | null
    ttl: '5m' | '1h'
    ttlSource: 'switch' | 'default'
    recacheCostUsd: number | null
    isMainIdle: boolean
    lastTurnWasCacheMiss: boolean
    missCostUsd: number | null
  }
  topAlert: TelemetryActiveAlert | null
  alertCount: number
  /** A turn, a subagent or a call is live (stale loops not counted). */
  isActive: boolean
}

/** One compact model for a bar above the prompt, assembled from the other derive functions. */
export function deriveBand(s: TelemetryInsightsState, now: number, opts: { rules?: TelemetryAlertRules } = {}): TelemetryBand {
  const rules = opts.rules ?? DEFAULT_ALERT_RULES
  const ledger = deriveReconciliation(s)
  const overview = deriveOverview(s, now)
  const counts: Record<AgentGroup, number> = { running: 0, stale: 0, failed: 0, done: 0 }
  for (const r of deriveAgents(s, now)) if (r.id !== MAIN && !isFoldedAgent(r)) counts[groupOf(r)] += 1

  const c = s.context
  const b = c.breakdown
  const window = c.window ?? (b && b.maxTokens > 0 ? b.maxTokens : null)
  const tokens = c.tokens ?? b?.totalTokens ?? null
  const pressure = contextPressure(s)
  const tone: TelemetryBandTone = pressure.pct === null ? 'unknown' : pressure.pct >= rules.contextCritPct ? 'crit' : pressure.pct >= rules.contextWarnPct ? 'warn' : 'ok'
  const used: TelemetryContextCategory[] = (b?.categories ?? []).filter(cat => cat.kind === 'used' && !cat.isDeferred)
  const bySeg = new Map<TelemetryBandSegmentKey, number>()
  for (const cat of used) bySeg.set(contextSegmentOf(cat.name), (bySeg.get(contextSegmentOf(cat.name)) ?? 0) + cat.tokens)
  let isMessagesEstimate = false
  if (b && c.tokens !== null && isTime(c.updatedAt) && c.updatedAt > b.at) {
    const fixed = sumBy([...bySeg.entries()].filter(([k]) => k !== 'messages'), ([, v]) => v)
    bySeg.set('messages', Math.max(0, c.tokens - fixed))
    isMessagesEstimate = true
  }
  const segments = SEGMENT_ORDER.filter(k => (bySeg.get(k) ?? 0) > 0).map(k => ({ key: k, label: SEGMENT_LABEL[k], tokens: bySeg.get(k) ?? 0, share: window ? share(bySeg.get(k) ?? 0, window) : null }))
  const bufferFromBreakdown = b ? sumBy(b.categories.filter(cat => cat.kind === 'buffer'), cat => cat.tokens) : null
  const compactAt = b && b.isAutoCompactEnabled && b.autoCompactThreshold !== null ? b.autoCompactThreshold : null
  const bufferTokens = bufferFromBreakdown !== null && bufferFromBreakdown > 0 ? bufferFromBreakdown : compactAt !== null && window !== null ? Math.max(0, window - compactAt) : bufferFromBreakdown
  const clock = deriveCacheClock(s, now)
  const alerts = deriveAlerts(s, now, rules)
  const model = s.meta.mainModel
  return {
    title: model === null ? 'Session' : modelLabel(model).replace(/^Claude /, ''),
    model,
    costUsd: ledger.totalUsd,
    costSource: ledger.source,
    trackedUsd: ledger.trackedUsd,
    running: counts.running,
    done: counts.done,
    failed: counts.failed,
    stale: counts.stale,
    burnUsdPerMin: overview.burn.usdPerMinute,
    context: {
      tokens,
      window,
      percent: c.percent ?? (tokens !== null && window ? Math.round((tokens / window) * 100) : null),
      fill: tokens !== null && window ? tokens / window : null,
      tone,
      pressure: pressure.pct === null ? null : pressure.pct / 100,
      compactAtTokens: compactAt,
      segments,
      isMessagesEstimate,
      freeTokens: tokens !== null && window !== null ? Math.max(0, window - tokens - (bufferTokens ?? 0)) : null,
      bufferTokens,
      breakdownAt: b?.at ?? null,
    },
    cache: {
      status: clock.status,
      expiresInMs: clock.expiresInMs,
      ttl: clock.ttl,
      ttlSource: clock.ttlSource,
      recacheCostUsd: clock.recacheCostUsd,
      isMainIdle: clock.isMainIdle,
      lastTurnWasCacheMiss: clock.lastTurnWasCacheMiss,
      missCostUsd: clock.missCostUsd,
    },
    topAlert: alerts.active[0] ?? null,
    alertCount: alerts.active.length,
    isActive: isActive(s, now),
  }
}

/**
 * The status line: `$30.36 · ctx 25% · 3▶ · cache 3m`, the top alert first
 * (`!! ctx 92% · …` for crit, `! burn $0.62/m · …` for warn). The cache shows
 * whole minutes, `<1m` in the last one and `cold` once expired, so the text
 * changes at most once a minute on the clock alone.
 */
export function formatStatusLine(band: TelemetryBand): string {
  const parts: string[] = []
  if (band.topAlert) parts.push(`${band.topAlert.level === 'crit' ? '!!' : '!'} ${band.topAlert.short}`)
  parts.push(fmtUsd(band.costUsd))
  if (band.context.percent !== null) parts.push(`ctx ${Math.round(band.context.percent)}%`)
  if (band.running > 0) parts.push(`${band.running}▶`)
  const cache = band.cache
  if (cache.status === 'cold') parts.push('cache cold')
  else if (cache.expiresInMs !== null && cache.status !== 'unknown') parts.push(cache.expiresInMs < 60_000 ? 'cache <1m' : `cache ${Math.floor(cache.expiresInMs / 60_000)}m`)
  return parts.join(' · ')
}
