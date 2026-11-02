// session-telemetry: selectors and formatters for a UI. Pure (no `$`, no clock:
// pass `now`); unit-tested in tests/derive.test.ts. Each derive function takes
// only the slices it reads (a `Pick` of TelemetryState), so a drawing can read
// just those atoms.
//
// Exports:
//   deriveOverview(s, now, opts?)   headline numbers: cost (engine and estimate), tokens,
//                                   cache hit rate and savings, per-turn figures, burn rate
//   deriveAgents(s, now)            one row per agent loop, in spawn-tree order
//   deriveModels(s)                 one row per model, by cost
//   deriveTools(s, now, opts?)      one row per tool, MCP servers, recent and running calls
//   deriveContext(s)                the window, its categories, sparkline, compactions
//   deriveContextGrid(cats, max, n) /context-style squares for a breakdown
//   deriveTurns(s, opts?)           recent turns of one loop, newest first
//   deriveFlow(s, opts?)            nodes and edges: agent -> agent / model / tool
//   deriveReconciliation(s)         the engine's ledger against what this mod tracked: the untracked remainder
//   deriveTimeline(s, now, opts?)   what the harness is doing now, and the recent events newest first
//   deriveHarness(s)                what feeds the context each request (fixed overhead, messages, top consumers)
//   sessionStartOf(s, now), sessionAgeMs(s, now), saneDuration(ms, maxMs), ageOf(now, at, maxMs), isTime(t)
//   isStaleLoop(s, id, now), isLiveTool(ev, now), isUnattributed(agent), STALE_AFTER_MS   (from model.ts)
//   deriveAgentPlan(agent, now, isRunning), planCountText(plan), PLAN_STALE_MS
//                                   a loop's plan (its task list) as drawn: counts, fraction, current task
//
// Stale: a running loop with no event of its own for STALE_AFTER_MS (and no
// live call) is answered with status 'stale' by deriveAgents, counted as
// running nowhere, and comes back once a later event of its own arrives.
//   cacheHitRate(counts), percentile(values, p), share(part, whole)
//   fmtTokens, fmtUsd, fmtDuration, fmtBytes, fmtPct, fmtRate, NONE
//
// Ratios (shares, hit rates, fill) are 0..1; `percent` fields carried from the
// engine stay 0..100 and say so in their name.
//
// Times: a timestamp of 0 or null is "unknown" (the atoms' initial value is
// built at 0), and a duration is shown only when it can be true of this session
// (not negative, not longer than the session's age); otherwise it is null and
// the formatter shows NONE.

import type {
  TelemetryAgent,
  TelemetryAgentPlanItem,
  TelemetryAgentPlanSource,
  TelemetryAgentReport,
  TelemetryAgentStatus,
  TelemetryCompaction,
  TelemetryContextCategory,
  TelemetryContextPoint,
  TelemetryMcpServerContext,
  TelemetryPricingMatch,
  TelemetryRateLimit,
  TelemetryState,
  TelemetryStep,
  TelemetryTokenCounts,
  TelemetryToolEvent,
  TelemetryToolStatus,
  TelemetryUsage,
} from '../types'

import { isLiveTool, isStaleLoop, isUnattributed, STALE_AFTER_MS } from './model'
import { modelLabel } from './pricing'

export { isLiveTool, isStaleLoop, isUnattributed, STALE_AFTER_MS }

const MAIN = 'main'

/** What a formatter shows for a value there is none of. */
export const NONE = '–'

export const BURN_WINDOW_MS = 5 * 60_000

// ---------------------------------------------------------------- numbers

export function share(part: number, whole: number): number | null {
  return whole > 0 && Number.isFinite(part) ? part / whole : null
}

/** Cache reads over the whole prompt (input + cache read + cache write); null with no prompt. */
export function cacheHitRate(c: TelemetryTokenCounts): number | null {
  return share(c.cacheRead, c.input + c.cacheRead + c.cacheWrite)
}

const tokensOf = (c: TelemetryTokenCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite

/** Nearest-rank percentile (p in 0..100) of the values; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, z) => a - z)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1] ?? null
}

// ---------------------------------------------------------------- formatters

const trim = (text: string): string => text.replace(/\.0+([kMB]?)$/, '$1').replace(/(\.\d*?)0+([kMB]?)$/, '$1$2')

/** 950 -> "950", 1234 -> "1.2k", 45_600 -> "46k", 1_234_567 -> "1.23M". */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a < 1000) return `${sign}${Math.round(a)}`
  if (a < 10_000) return `${sign}${trim((a / 1000).toFixed(1))}k`
  if (Math.round(a / 1000) < 1000) return `${sign}${Math.round(a / 1000)}k`
  if (a < 10_000_000) return `${sign}${trim((a / 1e6).toFixed(2))}M`
  if (Math.round(a / 1e5) < 10_000) return `${sign}${trim((a / 1e6).toFixed(1))}M`
  return `${sign}${trim((a / 1e9).toFixed(2))}B`
}

/** 0 -> "$0.00", 0.0042 -> "$0.0042", 1.5 -> "$1.50", 12_345 -> "$12.3k". */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a === 0) return '$0.00'
  if (a < 0.0001) return `${sign}<$0.0001`
  if (a < 0.01) return `${sign}$${a.toFixed(4)}`
  if (a < 10_000) return `${sign}$${a.toFixed(2)}`
  if (a < 1e6) return `${sign}$${trim((a / 1000).toFixed(1))}k`
  return `${sign}$${trim((a / 1e6).toFixed(2))}M`
}

/** No session runs this long: a duration past it is a timestamp mistaken for one (epoch 0 is ~20,000 days). */
const ABSURD_MS = 400 * 86_400_000

/**
 * 850 -> "850ms", 4200 -> "4.2s", 42_000 -> "42s", 245_000 -> "4m 05s", 3_720_000 -> "1h 02m".
 * NONE for a missing, negative or absurd (over 400 days) value.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0 || ms > ABSURD_MS) return NONE
  const a = ms
  if (a < 1000) return `${Math.round(a)}ms`
  if (a < 10_000) return `${trim((a / 1000).toFixed(1))}s`
  const seconds = Math.round(a / 1000)
  if (seconds < 60) return `${seconds}s`
  const pad = (v: number): string => String(v).padStart(2, '0')
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
  const hours = Math.floor(minutes / 60)
  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`
}

/** 512 -> "512 B", 1536 -> "1.5 KB", 5_242_880 -> "5 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE
  const a = Math.max(0, n)
  if (a < 1024) return `${Math.round(a)} B`
  if (a < 1024 ** 2) return `${trim((a / 1024).toFixed(1))} KB`
  if (a < 1024 ** 3) return `${trim((a / 1024 ** 2).toFixed(1))} MB`
  return `${trim((a / 1024 ** 3).toFixed(2))} GB`
}

/** A 0..1 ratio: 0.423 -> "42%", 0.0423 -> "4.2%", 0.00042 -> "0.04%". */
export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return NONE
  const pct = ratio * 100
  const a = Math.abs(pct)
  if (a === 0) return '0%'
  if (a >= 10) return `${Math.round(pct)}%`
  if (a >= 1) return `${trim(pct.toFixed(1))}%`
  return `${trim(pct.toFixed(2))}%`
}

/** Dollars per minute: "$0.12/min". */
export function fmtRate(usdPerMinute: number | null | undefined): string {
  if (usdPerMinute === null || usdPerMinute === undefined || !Number.isFinite(usdPerMinute)) return NONE
  return `${fmtUsd(usdPerMinute)}/min`
}

// ---------------------------------------------------------------- time

/** A timestamp worth using: finite and after the epoch (0 and null read as "unknown"). */
export const isTime = (t: number | null | undefined): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0

/**
 * When the session began, as far as is known: the earliest of the engine's
 * start, the moment this mod first saw the session and its first step; null
 * when none is known. A time after `now` is not trusted.
 */
export function sessionStartOf(s: Pick<TelemetryState, 'meta' | 'totals'>, now: number): number | null {
  const known = [s.meta.startedAt, s.meta.firstSeenAt, s.totals.firstStepAt].filter(isTime).filter(t => t <= now)
  return known.length > 0 ? Math.min(...known) : null
}

/** How long the session has run; null when its start is unknown. */
export function sessionAgeMs(s: Pick<TelemetryState, 'meta' | 'totals'>, now: number): number | null {
  const start = sessionStartOf(s, now)
  return start === null ? null : now - start
}

/** Durations may run this far past the session's age (two clocks, a late measure) and still count. */
const SLACK_MS = 60_000

/**
 * `ms` when it can be true of this session: finite, not negative, and not
 * longer than `maxMs` (the session's age; null for no bound). Else null.
 */
export function saneDuration(ms: number | null | undefined, maxMs: number | null): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  if (maxMs !== null && Number.isFinite(maxMs) && ms > maxMs + SLACK_MS) return null
  return ms
}

/** The age of a moment, `now - at`, as a sane duration; null for an unknown or impossible `at`. */
export function ageOf(now: number, at: number | null | undefined, maxMs: number | null): number | null {
  return isTime(at) ? saneDuration(now - at, maxMs) : null
}

// ---------------------------------------------------------------- reconciliation

/**
 * The engine's ledger against what this mod tracked. The ledger (`/cost`) covers
 * the whole session: before the mod loaded, every loop, the compaction
 * summarizer, pricing modifiers. The tracked sum is what the mod observed and
 * priced since it loaded. Their difference is shown as "untracked" so that the
 * rows of a table add up to the headline.
 */
export type TelemetryReconciliation = {
  /** The engine's figure, when the host keeps one. */
  ledgerUsd: number | null
  /** Observed since the mod loaded, priced from the table. */
  trackedUsd: number
  /** Since when the mod has been tracking (its first sight of the session), when known. */
  trackedSince: number | null
  /**
   * `ledger - tracked` when the ledger is the larger (spent before load, or
   * where the mod does not see); 0 when the tracked sum is at or over the
   * ledger (an over-estimate: see `deriveOverview().estimateDrift`); null
   * without a ledger.
   */
  untrackedUsd: number | null
  /** untracked / total; null without a ledger. */
  untrackedShare: number | null
  /** What totals are shown against: the ledger when known and not under the tracked sum, else the tracked sum. */
  totalUsd: number
  /** Whether `totalUsd` is the engine's figure or this mod's estimate. */
  source: 'ledger' | 'estimate'
}

export function deriveReconciliation(s: Pick<TelemetryState, 'totals' | 'context' | 'meta'>): TelemetryReconciliation {
  const ledger = s.context.engineCostUsd
  const tracked = s.totals.session.costUsd
  const since = isTime(s.meta.firstSeenAt) ? s.meta.firstSeenAt : isTime(s.totals.firstStepAt) ? s.totals.firstStepAt : null
  if (ledger === null || !Number.isFinite(ledger)) {
    return { ledgerUsd: null, trackedUsd: tracked, trackedSince: since, untrackedUsd: null, untrackedShare: null, totalUsd: tracked, source: 'estimate' }
  }
  const total = Math.max(ledger, tracked)
  const untracked = Math.max(0, ledger - tracked)
  return {
    ledgerUsd: ledger,
    trackedUsd: tracked,
    trackedSince: since,
    untrackedUsd: untracked,
    untrackedShare: share(untracked, total) ?? 0,
    totalUsd: total,
    source: 'ledger',
  }
}

// ---------------------------------------------------------------- overview

export type TelemetryOverview = {
  /** The session's start as far as known (sessionStartOf), else when this mod first saw it. */
  startedAt: number
  /** Uptime; null when no start is known or the figure cannot be true. */
  elapsedMs: number | null
  ledger: TelemetryReconciliation
  /** The pricing table's estimate. */
  estimatedCostUsd: number
  /** The engine's ledger (what /cost shows), when known. */
  engineCostUsd: number | null
  /** The engine's figure when known, else the estimate. */
  costUsd: number
  costSource: 'engine' | 'estimate'
  /** (estimate - engine) / engine; null without an engine figure. */
  estimateDrift: number | null
  tokens: TelemetryTokenCounts & { total: number; prompt: number }
  requests: number
  cacheHitRate: number | null
  cacheSavedUsd: number
  mainTurns: number
  /** Tracked totals over main-loop turns (subagent work counted in the turn that spawned it). */
  perTurn: { tokens: number | null; costUsd: number | null; avgDurationMs: number | null }
  /** Over the last `burnWindowMs` of steps. */
  burn: { windowMs: number; costUsd: number; tokens: number; usdPerMinute: number | null; tokensPerMinute: number | null; isPartial: boolean }
  steps: number
  toolCalls: number
  toolErrors: number
  toolErrorRate: number | null
  agents: { total: number; subagents: number; running: number }
  mainModel: string | null
  mainModelLabel: string | null
  context: { tokens: number | null; window: number | null; fill: number | null; percent: number | null }
  rateLimits: TelemetryRateLimit[]
  pricing: {
    /** Some model was priced at a family or default row. */
    hasFallback: boolean
    cacheTtl: '5m' | '1h'
    enginePricing: string | null
    managedPricingSet: boolean | null
  }
}

export function deriveOverview(
  s: Pick<TelemetryState, 'totals' | 'agents' | 'steps' | 'tools' | 'context' | 'meta'>,
  now: number,
  opts: { burnWindowMs?: number } = {},
): TelemetryOverview {
  const { totals, agents, steps, context, meta } = s
  const session = totals.session
  const start0 = sessionStartOf(s, now)
  const startedAt = start0 ?? meta.firstSeenAt
  const engine = context.engineCostUsd
  const windowMs = opts.burnWindowMs ?? BURN_WINDOW_MS
  const since = now - windowMs

  let recentCost = 0
  let recentTokens = 0
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (!step || step.endedAt <= since) break
    recentCost += step.costUsd
    recentTokens += tokensOf(step)
  }
  const first = totals.firstStepAt
  const span = first === null ? null : Math.max(60_000, Math.min(windowMs, now - first))
  const oldest = steps[0]
  const isPartial = totals.evictedSteps > 0 && oldest !== undefined && oldest.endedAt > since

  const main = agents.byId[MAIN]
  const mainTurns = meta.mainTurns
  const finishedMainTurns = main ? Math.max(0, main.turns - (main.status === 'running' ? 1 : 0)) : 0
  let running = 0
  for (const id of agents.order) if (id !== MAIN && agents.byId[id]?.status === 'running' && !isStaleLoop(s, id, now)) running += 1
  const hasFallback = Object.values(totals.byModel).some(m => m.pricing !== 'exact')
  const window = context.window

  return {
    startedAt,
    elapsedMs: start0 === null ? null : saneDuration(now - start0, null),
    ledger: deriveReconciliation(s),
    estimatedCostUsd: session.costUsd,
    engineCostUsd: engine,
    costUsd: engine ?? session.costUsd,
    costSource: engine === null ? 'estimate' : 'engine',
    estimateDrift: engine !== null && engine > 0 ? (session.costUsd - engine) / engine : null,
    tokens: {
      input: session.input,
      output: session.output,
      cacheRead: session.cacheRead,
      cacheWrite: session.cacheWrite,
      total: tokensOf(session),
      prompt: session.input + session.cacheRead + session.cacheWrite,
    },
    requests: session.requests,
    cacheHitRate: cacheHitRate(session),
    cacheSavedUsd: session.cacheSavedUsd,
    mainTurns,
    perTurn: {
      tokens: mainTurns > 0 ? tokensOf(session) / mainTurns : null,
      costUsd: mainTurns > 0 ? session.costUsd / mainTurns : null,
      avgDurationMs: main && finishedMainTurns > 0 ? saneDuration(main.activeMs / finishedMainTurns, null) : null,
    },
    burn: {
      windowMs,
      costUsd: recentCost,
      tokens: recentTokens,
      usdPerMinute: span === null ? null : recentCost / (span / 60_000),
      tokensPerMinute: span === null ? null : recentTokens / (span / 60_000),
      isPartial,
    },
    steps: totals.steps,
    toolCalls: totals.toolCalls,
    toolErrors: totals.toolErrors,
    toolErrorRate: share(totals.toolErrors, totals.toolCalls),
    agents: { total: agents.order.length + agents.evicted, subagents: agents.order.length - (main ? 1 : 0) + agents.evicted, running },
    mainModel: meta.mainModel,
    mainModelLabel: meta.mainModel === null ? null : modelLabel(meta.mainModel),
    context: {
      tokens: context.tokens,
      window,
      fill: context.tokens !== null && window ? context.tokens / window : null,
      percent: context.percent,
    },
    rateLimits: context.rateLimits,
    pricing: { hasFallback, cacheTtl: meta.cacheTtl, enginePricing: meta.enginePricing, managedPricingSet: meta.managedPricingSet },
  }
}

// ---------------------------------------------------------------- agents

/** A running loop whose plan has not changed for this long has a stale plan (drawn dim). */
export const PLAN_STALE_MS = 10 * 60_000

/** A loop's plan as the UI draws it (deriveAgentPlan). */
export type TelemetryAgentPlanView = {
  source: TelemetryAgentPlanSource
  done: number
  /** At least `done`; 0 when the loop never said how many (a `step` without a total). */
  total: number
  /** done / total, 0..1; null when the total is unknown. */
  fraction: number | null
  /** The task in progress (or the step's note); null when the plan names none. */
  currentTask: string | null
  items: TelemetryAgentPlanItem[]
  /** Items the stored window leaves out (total less items shown, for list sources). */
  hiddenItems: number
  /** Running and not updated for PLAN_STALE_MS. */
  isStale: boolean
  /** Every planned item done. */
  isComplete: boolean
  updatedAt: number
  /** The savvy-flow title (progress only). */
  title: string | null
}

/**
 * A loop's stored plan made safe to draw: counts clamped (`total` at least
 * `done`), the fraction (none without a total), the current task, staleness.
 * Null when the loop has no plan, or a stored value of another shape.
 */
export function deriveAgentPlan(agent: Pick<TelemetryAgent, 'plan'> | null | undefined, now: number, isRunning: boolean): TelemetryAgentPlanView | null {
  const p = agent?.plan
  if (!p || typeof p !== 'object' || !(['step', 'todos', 'progress', 'tasks'] as const).includes(p.source)) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  const done = num(p.done)
  const total = Math.max(num(p.total), p.total > 0 ? done : 0)
  const items = Array.isArray(p.items) ? p.items.filter(it => it && typeof it.text === 'string') : []
  const updatedAt = num(p.updatedAt)
  const isList = p.source === 'todos' || p.source === 'tasks' || p.source === 'progress'
  return {
    source: p.source,
    done: total > 0 ? Math.min(done, total) : done,
    total,
    fraction: total > 0 ? Math.min(1, done / total) : null,
    currentTask: typeof p.current === 'string' && p.current !== '' ? p.current : null,
    items,
    hiddenItems: isList ? Math.max(0, total - items.length) : 0,
    isStale: isRunning && updatedAt > 0 && now - updatedAt > PLAN_STALE_MS,
    isComplete: total > 0 && done >= total,
    updatedAt,
    title: typeof p.title === 'string' && p.title !== '' ? p.title : null,
  }
}

/** `3/7`, or `3 done` when the total is unknown. */
export const planCountText = (p: Pick<TelemetryAgentPlanView, 'done' | 'total'>): string => (p.total > 0 ? `${p.done}/${p.total}` : `${p.done} done`)

export type TelemetryAgentRow = {
  id: string
  /** name, else description, else type. */
  label: string
  kind: TelemetryAgent['kind']
  type: string
  description: string
  /** The stored status, or `stale` for a running loop that went quiet (isStaleLoop). */
  status: TelemetryAgentStatus | 'stale'
  /** Running and not stale. */
  isRunning: boolean
  isStale: boolean
  /** Never spawned under this mod's eyes, no request, no tool call: nothing to show but an id. */
  isUnattributed: boolean
  /** 0 for main, 1 for its children, and so on. */
  depth: number
  parentId: string | null
  childIds: string[]
  model: string | null
  modelLabel: string | null
  models: string[]
  usage: TelemetryUsage
  tokens: number
  costUsd: number
  costShare: number | null
  cacheHitRate: number | null
  steps: number
  turns: number
  toolCalls: number
  toolErrors: number
  /**
   * Main: the session's uptime. Others: from spawn (or first sight) to end, or
   * to now while it runs. Null when unknown or when it cannot be true of this
   * session (a start of 0, an end before the start).
   */
  durationMs: number | null
  activeMs: number
  lastContextTokens: number
  peakContextTokens: number
  isBackground: boolean
  report: TelemetryAgentReport | null
  /** Its plan (deriveAgentPlan); null when it reported none. */
  plan: TelemetryAgentPlanView | null
}

/**
 * One row per agent, in spawn-tree order. Cost shares are of the tracked sum
 * (how what this mod observed splits between the loops); the ledger's
 * untracked remainder is a row of its own in the UI (deriveReconciliation).
 */
export function deriveAgents(s: Pick<TelemetryState, 'agents' | 'totals' | 'meta' | 'tools'>, now: number): TelemetryAgentRow[] {
  const { byId, order } = s.agents
  const total = s.totals.session.costUsd
  const age = sessionAgeMs(s, now)
  const start0 = sessionStartOf(s, now)
  const children = new Map<string, string[]>()
  for (const id of order) {
    const agent = byId[id]
    if (!agent || id === MAIN) continue
    const parent = agent.parentId !== null && byId[agent.parentId] ? agent.parentId : MAIN
    const list = children.get(parent) ?? []
    list.push(id)
    children.set(parent, list)
  }
  const rows: TelemetryAgentRow[] = []
  const seen = new Set<string>()
  const visit = (id: string, depth: number): void => {
    const agent = byId[id]
    if (!agent || seen.has(id)) return
    seen.add(id)
    const isStale = id !== MAIN && agent.status === 'running' && isStaleLoop(s, id, now)
    const status: TelemetryAgentStatus | 'stale' = isStale ? 'stale' : agent.status
    let durationMs: number | null
    if (id === MAIN) durationMs = start0 === null ? null : saneDuration(now - start0, null)
    else {
      const start = isTime(agent.spawnedAt) ? agent.spawnedAt : isTime(agent.firstSeenAt) ? agent.firstSeenAt : null
      // a stale loop's clock stopped at its last activity
      const end = isTime(agent.endedAt) ? agent.endedAt : status === 'running' ? now : isTime(agent.lastActiveAt) ? agent.lastActiveAt : null
      durationMs = start === null || end === null ? null : saneDuration(end - start, age)
    }
    rows.push({
      id,
      label: agent.name ?? (agent.description || agent.type),
      kind: agent.kind,
      type: agent.type,
      description: agent.description,
      status,
      isRunning: status === 'running',
      isStale,
      isUnattributed: isUnattributed(agent),
      depth,
      parentId: agent.parentId,
      childIds: children.get(id) ?? [],
      model: agent.model,
      modelLabel: agent.model === null ? null : modelLabel(agent.model),
      models: agent.models,
      usage: agent.usage,
      tokens: tokensOf(agent.usage),
      costUsd: agent.usage.costUsd,
      costShare: share(agent.usage.costUsd, total),
      cacheHitRate: cacheHitRate(agent.usage),
      steps: agent.steps,
      turns: agent.turns,
      toolCalls: agent.toolCalls,
      toolErrors: agent.toolErrors,
      durationMs,
      activeMs: agent.activeMs,
      lastContextTokens: agent.lastContextTokens,
      peakContextTokens: agent.peakContextTokens,
      isBackground: agent.isBackground,
      report: agent.report,
      plan: deriveAgentPlan(agent, now, status === 'running'),
    })
    for (const child of children.get(id) ?? []) visit(child, depth + 1)
  }
  visit(MAIN, 0)
  for (const id of order) visit(id, 1)
  return rows
}

// ---------------------------------------------------------------- models

export type TelemetryModelRow = {
  model: string
  label: string
  family: string
  pricing: TelemetryPricingMatch
  usage: TelemetryUsage
  tokens: number
  costUsd: number
  costShare: number | null
  tokenShare: number | null
  cacheHitRate: number | null
}

/** One row per model, most expensive first; cost shares of the tracked sum (as deriveAgents). */
export function deriveModels(s: Pick<TelemetryState, 'totals'>): TelemetryModelRow[] {
  const session = s.totals.session
  const allTokens = tokensOf(session)
  const total = session.costUsd
  return Object.values(s.totals.byModel)
    .map(m => ({
      model: m.model,
      label: m.label,
      family: m.family,
      pricing: m.pricing,
      usage: m,
      tokens: tokensOf(m),
      costUsd: m.costUsd,
      costShare: share(m.costUsd, total),
      tokenShare: share(tokensOf(m), allTokens),
      cacheHitRate: cacheHitRate(m),
    }))
    .sort((a, z) => z.costUsd - a.costUsd || z.tokens - a.tokens)
}

// ---------------------------------------------------------------- tools

export type TelemetryToolRow = {
  tool: string
  /** The tool's own name: `create_issue` for `mcp__linear__create_issue`. */
  shortName: string
  server: string | null
  isServerTool: boolean
  calls: number
  ok: number
  errors: number
  denied: number
  interrupted: number
  running: number
  errorRate: number | null
  callShare: number | null
  avgWallMs: number | null
  maxWallMs: number | null
  avgExecMs: number | null
  /** From the calls still in the ring buffer. */
  p50WallMs: number | null
  p95WallMs: number | null
  resultChars: number
  resultBytes: number
  /** chars / 4: an estimate, the API reports no per-result token count. */
  resultTokensEstimate: number
  lastAt: number
}

export type TelemetryServerRow = {
  server: string
  tools: number
  calls: number
  errors: number
  resultBytes: number
  wallMsTotal: number
}

export type TelemetryTools = {
  rows: TelemetryToolRow[]
  servers: TelemetryServerRow[]
  /** Newest first. */
  recent: TelemetryToolEvent[]
  running: (TelemetryToolEvent & { elapsedMs: number })[]
  totals: { calls: number; errors: number; running: number; resultBytes: number; statusCounts: Record<TelemetryToolStatus, number> }
}

export function deriveTools(s: Pick<TelemetryState, 'totals' | 'tools'>, now: number, opts: { recent?: number } = {}): TelemetryTools {
  const walls = new Map<string, number[]>()
  const statusCounts: Record<TelemetryToolStatus, number> = { running: 0, ok: 0, error: 0, denied: 0, interrupted: 0 }
  for (const event of s.tools) {
    statusCounts[event.status] += 1
    if (event.wallMs === null) continue
    const list = walls.get(event.tool) ?? []
    list.push(event.wallMs)
    walls.set(event.tool, list)
  }
  const stats = Object.values(s.totals.byTool)
  const allCalls = stats.reduce((sum, t) => sum + t.calls, 0)
  const rows: TelemetryToolRow[] = stats
    .map(t => {
      const finished = t.ok + t.errors + t.denied + t.interrupted
      const wall = walls.get(t.tool) ?? []
      return {
        tool: t.tool,
        shortName: t.server === null ? t.tool : t.tool.slice(`mcp__${t.server}__`.length),
        server: t.server,
        isServerTool: t.isServerTool,
        calls: t.calls,
        ok: t.ok,
        errors: t.errors,
        denied: t.denied,
        interrupted: t.interrupted,
        running: t.running,
        errorRate: share(t.errors + t.interrupted, finished),
        callShare: share(t.calls, allCalls),
        avgWallMs: finished > 0 ? t.wallMsTotal / finished : null,
        maxWallMs: finished > 0 ? t.wallMsMax : null,
        avgExecMs: t.execCount > 0 ? t.execMsTotal / t.execCount : null,
        p50WallMs: percentile(wall, 50),
        p95WallMs: percentile(wall, 95),
        resultChars: t.resultChars,
        resultBytes: t.resultBytes,
        resultTokensEstimate: Math.ceil(t.resultChars / 4),
        lastAt: t.lastAt,
      }
    })
    .sort((a, z) => z.calls - a.calls || z.lastAt - a.lastAt)

  const servers = new Map<string, TelemetryServerRow>()
  for (const t of stats) {
    if (t.server === null) continue
    const row = servers.get(t.server) ?? { server: t.server, tools: 0, calls: 0, errors: 0, resultBytes: 0, wallMsTotal: 0 }
    row.tools += 1
    row.calls += t.calls
    row.errors += t.errors + t.interrupted
    row.resultBytes += t.resultBytes
    row.wallMsTotal += t.wallMsTotal
    servers.set(t.server, row)
  }
  const limit = opts.recent ?? 20
  const recent: TelemetryToolEvent[] = []
  const runningEvents: (TelemetryToolEvent & { elapsedMs: number })[] = []
  for (let i = s.tools.length - 1; i >= 0; i -= 1) {
    const event = s.tools[i]
    if (!event) continue
    if (recent.length < limit) recent.push(event)
    if (event.status === 'running') runningEvents.push({ ...event, elapsedMs: Math.max(0, now - event.startedAt) })
  }
  return {
    rows,
    servers: [...servers.values()].sort((a, z) => z.calls - a.calls),
    recent,
    running: runningEvents,
    totals: {
      calls: s.totals.toolCalls + s.totals.serverToolCalls,
      errors: s.totals.toolErrors,
      running: stats.reduce((sum, t) => sum + t.running, 0),
      resultBytes: stats.reduce((sum, t) => sum + t.resultBytes, 0),
      statusCounts,
    },
  }
}

// ---------------------------------------------------------------- context

export type TelemetryContextCategoryRow = TelemetryContextCategory & {
  /** Share of the window measured against. */
  fill: number | null
}

export type TelemetryContextView = {
  window: number | null
  tokens: number | null
  /** tokens / window, 0..1. */
  fill: number | null
  /** As the status line has it, 0..100. */
  percent: number | null
  headroomTokens: number | null
  autoCompactThreshold: number | null
  /** Tokens left before auto-compaction runs. */
  tokensUntilAutoCompact: number | null
  isAutoCompactEnabled: boolean | null
  /** From the latest breakdown; empty before the first. */
  categories: TelemetryContextCategoryRow[]
  usedTokens: number
  freeTokens: number
  bufferTokens: number
  deferredTokens: number
  breakdownAt: number | null
  breakdownDetail: 'summary' | 'full' | null
  breakdownModel: string | null
  breakdownError: string | null
  /** Main-window tokens after each main-loop turn, oldest first. */
  sparkline: number[]
  /** The same as 0..1 of the window then. */
  sparklineFill: number[]
  history: TelemetryContextPoint[]
  /** Newest first. */
  compactions: TelemetryCompaction[]
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpServers: TelemetryMcpServerContext[]
  skills: { total: number; included: number; tokens: number } | null
  slashCommands: { total: number; included: number; tokens: number } | null
  customAgents: { agentType: string; source: string; tokens: number }[]
  apiUsage: TelemetryTokenCounts | null
  rateLimits: TelemetryRateLimit[]
}

export function deriveContext(s: Pick<TelemetryState, 'context'>): TelemetryContextView {
  const c = s.context
  const b = c.breakdown
  const window = c.window ?? b?.maxTokens ?? null
  const tokens = c.tokens ?? b?.totalTokens ?? null
  const max = b?.maxTokens ?? 0
  const sum = (kind: TelemetryContextCategory['kind']): number =>
    (b?.categories ?? []).filter(cat => cat.kind === kind).reduce((total, cat) => total + cat.tokens, 0)
  const threshold = b?.autoCompactThreshold ?? null
  return {
    window,
    tokens,
    fill: tokens !== null && window ? tokens / window : null,
    percent: c.percent,
    headroomTokens: tokens !== null && window !== null ? Math.max(0, window - tokens) : null,
    autoCompactThreshold: threshold,
    tokensUntilAutoCompact: threshold !== null && tokens !== null ? Math.max(0, threshold - tokens) : null,
    isAutoCompactEnabled: b ? b.isAutoCompactEnabled : null,
    categories: (b?.categories ?? []).map(cat => ({ ...cat, fill: share(cat.tokens, max) })),
    usedTokens: sum('used'),
    freeTokens: sum('free'),
    bufferTokens: sum('buffer'),
    deferredTokens: sum('deferred'),
    breakdownAt: b?.at ?? null,
    breakdownDetail: b?.detail ?? null,
    breakdownModel: b?.model ?? null,
    breakdownError: c.breakdownError,
    sparkline: c.history.map(p => p.tokens),
    sparklineFill: c.history.map(p => (p.window > 0 ? p.tokens / p.window : 0)),
    history: c.history,
    compactions: [...c.compactions].reverse(),
    memoryFiles: b?.memoryFiles ?? [],
    mcpServers: b?.mcpServers ?? [],
    skills: b?.skills ?? null,
    slashCommands: b?.slashCommands ?? null,
    customAgents: b?.customAgents ?? [],
    apiUsage: b?.apiUsage ?? null,
    rateLimits: c.rateLimits,
  }
}

export type TelemetryGridCell = {
  category: string
  color: string
  kind: TelemetryContextCategory['kind']
  /** 0..1: how full the square is (a category's last square is partial). */
  fullness: number
}

/**
 * The window as `cells` squares, category by category in the breakdown's order
 * (deferred rows left out, as /context does), padded with free space.
 */
export function deriveContextGrid(
  categories: readonly TelemetryContextCategory[],
  maxTokens: number,
  cells = 100,
): TelemetryGridCell[] {
  const grid: TelemetryGridCell[] = []
  if (maxTokens <= 0 || cells <= 0) return grid
  const per = maxTokens / cells
  let freeColor = 'promptBorder'
  for (const cat of categories) {
    if (cat.kind === 'deferred' || cat.isDeferred) continue
    if (cat.kind === 'free') {
      freeColor = cat.color
      continue
    }
    const exact = cat.tokens / per
    const whole = Math.floor(exact)
    const part = exact - whole
    for (let i = 0; i < whole && grid.length < cells; i += 1) grid.push({ category: cat.name, color: cat.color, kind: cat.kind, fullness: 1 })
    if (part >= 0.05 && grid.length < cells) grid.push({ category: cat.name, color: cat.color, kind: cat.kind, fullness: part })
  }
  const freeName = categories.find(cat => cat.kind === 'free')?.name ?? 'Free space'
  while (grid.length < cells) grid.push({ category: freeName, color: freeColor, kind: 'free', fullness: 0 })
  return grid
}

// ---------------------------------------------------------------- turns

export type TelemetryTurnRow = {
  turnId: string
  agentId: string
  startedAt: number
  durationMs: number | null
  isRunning: boolean
  reason: string | null
  steps: number
  toolCalls: number
  tokens: number
  costUsd: number
  cacheHitRate: number | null
  contextTokensEnd: number
  model: string | null
}

export function deriveTurns(s: Pick<TelemetryState, 'turns'>, opts: { agentId?: string; limit?: number } = {}): TelemetryTurnRow[] {
  const agentId = opts.agentId ?? MAIN
  const limit = opts.limit ?? 20
  const rows: TelemetryTurnRow[] = []
  for (let i = s.turns.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const turn = s.turns[i]
    if (!turn || turn.agentId !== agentId) continue
    rows.push({
      turnId: turn.turnId,
      agentId: turn.agentId,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs,
      isRunning: turn.endedAt === null,
      reason: turn.reason,
      steps: turn.steps,
      toolCalls: turn.toolCalls,
      tokens: tokensOf(turn.usage),
      costUsd: turn.usage.costUsd,
      cacheHitRate: cacheHitRate(turn.usage),
      contextTokensEnd: turn.contextTokensEnd,
      model: turn.model,
    })
  }
  return rows
}

// ---------------------------------------------------------------- flow

export type TelemetryFlowNode = {
  id: string
  kind: 'agent' | 'model' | 'tool'
  label: string
  /** agent: its tokens; model: its tokens; tool: its calls. */
  value: number
  costUsd: number | null
}

export type TelemetryFlowEdge = {
  from: string
  to: string
  kind: 'spawn' | 'model' | 'tool'
  /** spawn: the child's tokens; model: tokens sent and received; tool: calls. */
  value: number
  costUsd: number | null
  requests: number | null
}

export type TelemetryFlow = { nodes: TelemetryFlowNode[]; edges: TelemetryFlowEdge[] }

/**
 * Who spent what where: agent nodes linked to the agents they spawned, the
 * models they ran on and the tools they called (the `maxTools` most-called
 * tools by name; the rest folded into one "other" node).
 */
export function deriveFlow(s: Pick<TelemetryState, 'agents' | 'totals'>, opts: { maxTools?: number } = {}): TelemetryFlow {
  const nodes: TelemetryFlowNode[] = []
  const edges: TelemetryFlowEdge[] = []
  const { byId, order } = s.agents
  const maxTools = opts.maxTools ?? 8
  const topTools = new Set(
    Object.values(s.totals.byTool)
      .sort((a, z) => z.calls - a.calls)
      .slice(0, maxTools)
      .map(t => t.tool),
  )
  const toolCalls = new Map<string, number>()
  for (const id of order) {
    const agent = byId[id]
    // a loop never spawned under this mod's eyes with nothing to show is folded everywhere else: no `unknown` node here either
    if (!agent || (id !== MAIN && isUnattributed(agent))) continue
    nodes.push({ id: `agent:${id}`, kind: 'agent', label: agent.name ?? (agent.description || agent.type), value: tokensOf(agent.usage), costUsd: agent.usage.costUsd })
    if (id !== MAIN) {
      const parent = agent.parentId !== null && byId[agent.parentId] ? agent.parentId : MAIN
      edges.push({ from: `agent:${parent}`, to: `agent:${id}`, kind: 'spawn', value: tokensOf(agent.usage), costUsd: agent.usage.costUsd, requests: agent.usage.requests })
    }
    for (const [model, slice] of Object.entries(agent.byModel)) {
      edges.push({ from: `agent:${id}`, to: `model:${model}`, kind: 'model', value: slice.tokens, costUsd: slice.costUsd, requests: slice.requests })
    }
    const folded = new Map<string, number>()
    for (const [tool, calls] of Object.entries(agent.byTool)) {
      const key = topTools.has(tool) ? tool : 'other'
      folded.set(key, (folded.get(key) ?? 0) + calls)
    }
    for (const [tool, calls] of folded) {
      edges.push({ from: `agent:${id}`, to: `tool:${tool}`, kind: 'tool', value: calls, costUsd: null, requests: null })
      toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + calls)
    }
  }
  for (const m of Object.values(s.totals.byModel)) {
    nodes.push({ id: `model:${m.model}`, kind: 'model', label: m.label, value: tokensOf(m), costUsd: m.costUsd })
  }
  for (const [tool, calls] of toolCalls) {
    nodes.push({ id: `tool:${tool}`, kind: 'tool', label: tool === 'other' ? 'Other tools' : tool, value: calls, costUsd: null })
  }
  return { nodes, edges }
}

// ---------------------------------------------------------------- timeline

export type TelemetryTimelineKind = 'request' | 'tool' | 'spawn' | 'finish' | 'compaction' | 'switch' | 'turn'

export type TelemetryTimelineStatus = TelemetryToolStatus | 'info'

/** One thing the harness did, for a log newest first. Never carries a tool's input: `toolLabel` is raw and the UI decides (shortLabel). */
export type TelemetryTimelineEvent = {
  /** When it happened; for a thing still running, when it started. */
  at: number
  isRunning: boolean
  kind: TelemetryTimelineKind
  agentId: string
  /** "main", or the subagent's type ("agent" when unknown). */
  actor: string
  status: TelemetryTimelineStatus
  /** Short words for what happened (an answer, a spawn, a compaction's sizes), without any input text. */
  text: string
  tool: string | null
  /** The call's input hint as recorded (may hold a command line): show only through `shortLabel`. */
  toolLabel: string | null
  isServerTool: boolean
  model: string | null
  tokens: TelemetryTokenCounts | null
  costUsd: number | null
  /** Wall time; for a running thing, how long so far. Null when unknown. */
  durationMs: number | null
}

export type TelemetryPhase = 'idle' | 'request' | 'tool' | 'agents'

/** What the harness is doing at `now`. */
export type TelemetryNow = {
  phase: TelemetryPhase
  /** tool: its name; agents: how many are waited on, as text; request: the model; idle: null. */
  detail: string | null
  tool: string | null
  /** How long the phase has lasted; null when unknown. */
  sinceMs: number | null
  runningTools: number
  runningAgents: number
  turnActive: boolean
  lastActivityAt: number | null
}

const actorOf = (s: Pick<TelemetryState, 'agents'>, agentId: string): string => {
  if (agentId === MAIN) return MAIN
  const agent = s.agents.byId[agentId]
  return agent && agent.type !== 'unknown' && agent.type !== '' ? agent.type : 'agent'
}

/**
 * The harness's recent doings as one list, newest first (running things first),
 * from the steps, tool calls, spawns and finishes, compactions, model switches
 * and main-loop turn boundaries already recorded; and the phase it is in now.
 */
export function deriveTimeline(
  s: Pick<TelemetryState, 'steps' | 'tools' | 'agents' | 'turns' | 'context' | 'meta' | 'totals'>,
  now: number,
  opts: { limit?: number } = {},
): { now: TelemetryNow; events: TelemetryTimelineEvent[] } {
  const limit = opts.limit ?? 80
  const age = sessionAgeMs(s, now)
  const events: TelemetryTimelineEvent[] = []
  const base = (at: number, kind: TelemetryTimelineKind, agentId: string, status: TelemetryTimelineStatus, text: string): TelemetryTimelineEvent => ({
    at,
    isRunning: false,
    kind,
    agentId,
    actor: actorOf(s, agentId),
    status,
    text,
    tool: null,
    toolLabel: null,
    isServerTool: false,
    model: null,
    tokens: null,
    costUsd: null,
    durationMs: null,
  })

  // requests
  for (let i = s.steps.length - 1; i >= 0 && i >= s.steps.length - limit; i -= 1) {
    const step = s.steps[i]
    if (!step || !isTime(step.endedAt)) continue
    const tools = step.toolUses
    const text = !step.hasUsage ? 'no usage (aborted or failed)' : tools > 0 ? `asked ${tools} tool${tools === 1 ? '' : 's'}` : step.stopReason === 'end_turn' ? 'answered' : step.stopReason ?? ''
    events.push({
      ...base(step.endedAt, 'request', step.agentId, step.hasUsage ? 'ok' : 'error', text),
      model: step.model,
      tokens: { input: step.input, output: step.output, cacheRead: step.cacheRead, cacheWrite: step.cacheWrite },
      costUsd: step.hasUsage ? step.costUsd : null,
      durationMs: saneDuration(step.durationMs, age),
    })
  }

  // tool calls
  let runningTools = 0
  let runningTool: TelemetryToolEvent | null = null
  for (let i = s.tools.length - 1; i >= 0 && i >= s.tools.length - limit; i -= 1) {
    const ev = s.tools[i]
    if (!ev || !isTime(ev.startedAt)) continue
    const running = ev.status === 'running'
    // the phase follows live calls only: one whose end was never seen does not hold it forever
    if (isLiveTool(ev, now)) {
      runningTools += 1
      if (ev.tool !== 'Agent' && (runningTool === null || ev.startedAt > runningTool.startedAt)) runningTool = ev
    }
    events.push({
      ...base(running ? ev.startedAt : ev.endedAt ?? ev.startedAt, 'tool', ev.agentId, ev.status, running ? 'running' : ev.status),
      isRunning: running,
      tool: ev.tool,
      toolLabel: ev.label,
      isServerTool: ev.isServerTool,
      durationMs: running ? ageOf(now, ev.startedAt, age) : saneDuration(ev.wallMs, age),
    })
  }

  // agents
  let runningAgents = 0
  let oldestRunningSpawn: number | null = null
  for (const id of s.agents.order) {
    const agent = s.agents.byId[id]
    if (!agent || id === MAIN) continue
    const spawnedAt = isTime(agent.spawnedAt) ? agent.spawnedAt : isTime(agent.firstSeenAt) ? agent.firstSeenAt : null
    if (isUnattributed(agent)) continue
    const running = agent.status === 'running' && !isStaleLoop(s, id, now)
    if (running) {
      runningAgents += 1
      if (spawnedAt !== null && (oldestRunningSpawn === null || spawnedAt < oldestRunningSpawn)) oldestRunningSpawn = spawnedAt
    }
    if (spawnedAt !== null) {
      const by = agent.parentId !== null && agent.parentId !== MAIN ? ` by ${actorOf(s, agent.parentId)}` : ''
      events.push({
        ...base(spawnedAt, 'spawn', id, running ? 'running' : 'info', `spawned${by}${agent.isBackground ? ' · background' : ''}`),
        isRunning: running,
        model: agent.model,
        durationMs: running ? ageOf(now, spawnedAt, age) : null,
      })
    }
    if (isTime(agent.endedAt) && agent.status !== 'running') {
      const status: TelemetryTimelineStatus = agent.status === 'completed' ? 'ok' : agent.status === 'error' || agent.status === 'refused' ? 'error' : agent.status === 'aborted' ? 'interrupted' : 'info'
      events.push({
        ...base(agent.endedAt, 'finish', id, status, agent.status === 'completed' ? 'done' : agent.status),
        model: agent.model,
        tokens: { input: agent.usage.input, output: agent.usage.output, cacheRead: agent.usage.cacheRead, cacheWrite: agent.usage.cacheWrite },
        costUsd: agent.usage.costUsd,
        durationMs: spawnedAt === null ? null : saneDuration(agent.endedAt - spawnedAt, age),
      })
    }
  }

  // compactions and model switches
  for (const k of s.context.compactions) {
    if (!isTime(k.at)) continue
    const text = k.skipped ? `compaction skipped: ${k.skipped}` : `compaction ${fmtTokens(k.tokensBefore)} → ${fmtTokens(k.tokensAfter)}`
    events.push({ ...base(k.at, 'compaction', k.agentId, k.skipped ? 'info' : 'ok', text), costUsd: k.costUsd })
  }
  for (const sw of s.meta.modelSwitches) {
    if (!isTime(sw.at)) continue
    const from = sw.from === null ? '' : ` from ${modelLabel(sw.from).replace(/^Claude /, '')}`
    events.push({ ...base(sw.at, 'switch', MAIN, 'info', `model → ${modelLabel(sw.to).replace(/^Claude /, '')}${from} (${sw.source})`), model: sw.to })
  }

  // main-loop turn boundaries, numbered back from the count
  let n = s.meta.mainTurns
  let lastTurnEnd: number | null = null
  let activeTurnStart: number | null = null
  for (let i = s.turns.length - 1; i >= 0; i -= 1) {
    const turn = s.turns[i]
    if (!turn || turn.agentId !== MAIN) continue
    if (isTime(turn.startedAt)) {
      events.push(base(turn.startedAt, 'turn', MAIN, 'info', `turn ${n} started`))
      if (turn.endedAt === null && activeTurnStart === null) activeTurnStart = turn.startedAt
    }
    if (isTime(turn.endedAt)) {
      if (lastTurnEnd === null) lastTurnEnd = turn.endedAt
      const ended = turn.reason === 'answer' ? 'answered' : turn.reason === 'refusal' ? 'refused' : turn.reason ?? 'ended'
      events.push({
        ...base(turn.endedAt, 'turn', MAIN, turn.reason === 'error' ? 'error' : turn.reason === 'aborted' ? 'interrupted' : 'info', `turn ${n} ${ended}`),
        tokens: { input: turn.usage.input, output: turn.usage.output, cacheRead: turn.usage.cacheRead, cacheWrite: turn.usage.cacheWrite },
        costUsd: turn.usage.costUsd,
        durationMs: saneDuration(turn.durationMs, age),
      })
    }
    n -= 1
  }

  // newest first, running things first; at one moment a turn's end comes before (above) the request that ended it
  const rank: Record<TelemetryTimelineKind, number> = { turn: 0, finish: 1, request: 2, compaction: 3, switch: 4, tool: 5, spawn: 6 }
  events.sort((a, z) => Number(z.isRunning) - Number(a.isRunning) || z.at - a.at || rank[a.kind] - rank[z.kind])

  // the phase: an open turn whose loop went quiet (its end lost) does not hold it
  const turnActive = Object.keys(s.meta.activeTurns).some(id => !isStaleLoop(s, id, now))
  const lastStepAt = isTime(s.totals.lastStepAt) ? s.totals.lastStepAt : null
  let lastToolEnd: number | null = null
  for (let i = s.tools.length - 1; i >= 0; i -= 1) {
    const ev = s.tools[i]
    if (ev && isTime(ev.endedAt)) {
      lastToolEnd = ev.endedAt
      break
    }
  }
  const latest = (...times: (number | null)[]): number | null => {
    const known = times.filter((t): t is number => t !== null)
    return known.length > 0 ? Math.max(...known) : null
  }
  const lastActivityAt = latest(lastStepAt, lastToolEnd, lastTurnEnd, isTime(s.agents.byId[MAIN]?.lastActiveAt) ? s.agents.byId[MAIN]?.lastActiveAt ?? null : null)
  let phase: TelemetryNow = { phase: 'idle', detail: null, tool: null, sinceMs: ageOf(now, lastActivityAt, age), runningTools, runningAgents, turnActive, lastActivityAt }
  if (runningTool !== null) {
    phase = { ...phase, phase: 'tool', detail: runningTool.tool, tool: runningTool.tool, sinceMs: ageOf(now, runningTool.startedAt, age) }
  } else if (runningAgents > 0) {
    phase = { ...phase, phase: 'agents', detail: `${runningAgents} subagent${runningAgents === 1 ? '' : 's'}`, sinceMs: ageOf(now, oldestRunningSpawn, age) }
  } else if (turnActive) {
    const since = latest(lastStepAt, lastToolEnd, activeTurnStart)
    phase = { ...phase, phase: 'request', detail: s.meta.mainModel === null ? null : modelLabel(s.meta.mainModel), sinceMs: ageOf(now, since, age) }
  }
  return { now: phase, events: events.slice(0, limit) }
}

// ---------------------------------------------------------------- harness

/** What goes into the context each request, from the latest breakdown and the latest main-loop request. */
export type TelemetryHarness = {
  window: number | null
  /** Everything used except the messages: system prompt, tools, MCP, memory, skills, commands, agents. */
  fixedTokens: number
  messagesTokens: number
  usedTokens: number
  /** The used categories, largest first, with their share of the window. */
  consumers: { name: string; tokens: number; fill: number | null; kind: TelemetryContextCategory['kind'] }[]
  /** The latest main-loop request: what was re-sent, and how much of it the cache served. */
  lastRequest: { at: number; promptTokens: number; cacheRead: number; cacheWrite: number; input: number; hitRate: number | null; messageCount: number } | null
  breakdownAt: number | null
}

export function deriveHarness(s: Pick<TelemetryState, 'context' | 'steps'>): TelemetryHarness {
  const b = s.context.breakdown
  const window = s.context.window ?? b?.maxTokens ?? null
  const max = b?.maxTokens ?? window ?? 0
  const used = (b?.categories ?? []).filter(c => c.kind === 'used')
  const isMessages = (name: string): boolean => /message/i.test(name)
  const messages = used.filter(c => isMessages(c.name)).reduce((n, c) => n + c.tokens, 0)
  const usedTokens = used.reduce((n, c) => n + c.tokens, 0)
  let last: TelemetryStep | null = null
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    const step = s.steps[i]
    if (step && step.agentId === MAIN && step.hasUsage) {
      last = step
      break
    }
  }
  return {
    window,
    fixedTokens: usedTokens - messages,
    messagesTokens: messages,
    usedTokens,
    consumers: [...used].sort((a, z) => z.tokens - a.tokens).map(c => ({ name: c.name, tokens: c.tokens, fill: share(c.tokens, max), kind: c.kind })),
    lastRequest:
      last === null
        ? null
        : {
            at: last.endedAt,
            promptTokens: last.contextTokens,
            cacheRead: last.cacheRead,
            cacheWrite: last.cacheWrite,
            input: last.input,
            hitRate: cacheHitRate(last),
            messageCount: last.messageCount,
          },
    breakdownAt: b?.at ?? null,
  }
}

// ---------------------------------------------------------------- grouping and liveness (shared by the pane and insights.ts)

/** Folded into the `+N other` line: never spawned under this mod's eyes with nothing to show (isUnattributed), or finished with no model and no usage. */
export const isFoldedAgent = (r: TelemetryAgentRow): boolean => r.id !== MAIN && (r.isUnattributed || (!r.isRunning && r.model === null && r.tokens === 0 && r.toolCalls === 0))

export type AgentGroup = 'running' | 'stale' | 'failed' | 'done'

/** The Agents tab's group of a row: running, stale (a running loop gone quiet), failed (error, aborted, refused), else done. */
export const groupOf = (r: TelemetryAgentRow): AgentGroup =>
  r.isRunning ? 'running' : r.isStale ? 'stale' : r.status === 'completed' ? 'done' : r.status === 'error' || r.status === 'aborted' || r.status === 'refused' ? 'failed' : 'done'

/**
 * A turn or a subagent is running, or a tool call is in flight: the pane is
 * live and ticks. A loop that went quiet (a lost end: isStaleLoop) and a call
 * whose end was never seen (isLiveTool) do not count, so a ghost never keeps
 * the pane live.
 */
export function isActive(s: Pick<TelemetryState, 'meta' | 'agents' | 'tools'>, now: number): boolean {
  for (const id of Object.keys(s.meta.activeTurns)) if (!isStaleLoop(s, id, now)) return true
  for (const id of s.agents.order) {
    const agent = s.agents.byId[id]
    if (agent && id !== MAIN && agent.status === 'running' && !isStaleLoop(s, id, now)) return true
  }
  for (let i = s.tools.length - 1; i >= 0 && i >= s.tools.length - 50; i -= 1) {
    const ev = s.tools[i]
    if (ev && isLiveTool(ev, now)) return true
  }
  return false
}
