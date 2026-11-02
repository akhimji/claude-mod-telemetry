// session-telemetry: what the insights views share between the two surfaces,
// pure and element-free: the alert block (active alerts with their age, the
// rules line, the budget), the cache card's figures, the bloat audit's rows
// and summary, the workflow cards, and the Agents tab's controls.
//
// Exports: alertBlock, AlertBlock, rulesLine, cacheCard, CacheCard, bloatView,
//          BloatView, bloatHint, workflowCards, WorkflowCard, agentControls,
//          AgentControls, VERDICT_TONE, KIND_LABEL, alertLogRows,
//          planChecklist, PlanChecklist, PLAN_GLYPH, planTaskText, workflowPlan,
//          planCountText (the agent plans: the drawer's checklist, the row's task line)

import type { TelemetryAgentFilterChip, TelemetryAlert, TelemetryContextCategory, TelemetryUi } from '../../types'

import type { TelemetryAgentPlanItemStatus } from '../../types'
import { deriveAgents, fmtDuration, fmtPct, fmtTokens, fmtUsd, deriveReconciliation, planCountText, type TelemetryAgentPlanView, type TelemetryAgentRow } from '../derive'
import {
  DEFAULT_ALERT_RULES,
  deriveAgentFilter,
  deriveAlerts,
  deriveBloat,
  deriveCacheClock,
  deriveWorkflows,
  type TelemetryActiveAlert,
  type TelemetryAlertRules,
  type TelemetryBloatKind,
  type TelemetryBloatRow,
  type TelemetryBloatVerdict,
  type TelemetryCacheClock,
  type TelemetryInsightsState,
  type TelemetryWorkflow,
} from '../insights'
import { fmtAgo, type Tone } from '../ui-kit'

import { fmtCountdown } from './band'

// ================================================================ alerts

export type AlertBlock = {
  active: (TelemetryActiveAlert & { ageMs: number | null })[]
  unacked: number
  log: TelemetryAlert[]
  rules: string
  /** The budget's fill when one is set. */
  budget: { frac: number; usd: number; spent: number } | null
}

/** The rules in force, one line: `ctx warn 70% · crit 90% · burn ×3 · tool errors 30% · budget $20`. */
export function rulesLine(rules: TelemetryAlertRules): string {
  const parts = [`ctx warn ${Math.round(rules.contextWarnPct)}% · crit ${Math.round(rules.contextCritPct)}%`, `burn ×${rules.burnSpikeMultiplier}`, `tool errors ${Math.round(rules.toolErrorRate * 100)}%`, `stale ${Math.round(rules.agentLongRunMs / 60_000)}m long run`]
  if (rules.budgetUsd > 0) parts.push(`budget ${fmtUsd(rules.budgetUsd)}`)
  if (rules.mode === 'off') parts.unshift('alerts off')
  return parts.join(' · ')
}

/** The alerts as the Overview and the header show them: active with their age (the condition's `since`), the rules, the budget. */
export function alertBlock(s: TelemetryInsightsState, now: number, rules: TelemetryAlertRules = DEFAULT_ALERT_RULES): AlertBlock {
  const view = deriveAlerts(s, now, rules)
  const conditions = s.alerts?.conditions ?? {}
  const active = view.active.map(a => {
    const since = conditions[a.key]?.since
    return { ...a, ageMs: typeof since === 'number' && since > 0 && since <= now ? now - since : null }
  })
  const spent = deriveReconciliation(s).totalUsd
  const budget = rules.budgetUsd > 0 ? { frac: Math.min(1, spent / rules.budgetUsd), usd: rules.budgetUsd, spent } : null
  return { active, unacked: view.unacked, log: view.log, rules: rulesLine(rules), budget }
}

/** The tone of an alert level. */
export const levelTone = (level: 'warn' | 'crit'): Tone => (level === 'crit' ? 'error' : 'warning')

/** The alert log as Live rows: `{ at, level, message, ackd }`, newest first, at most `limit`. */
export function alertLogRows(s: TelemetryInsightsState, limit = 20): TelemetryAlert[] {
  return [...(s.alerts?.log ?? [])].reverse().slice(0, limit)
}

// ================================================================ cache

export type CacheCard = {
  clock: TelemetryCacheClock
  /** The state word and its tone. */
  state: { text: string; tone: Tone | null }
  /** The countdown text (`3m 12s` with seconds, `3m` without; `cold` once past; `–` unknown). */
  countdown: string
  /** The TTL's share still left, 0..1 (null unknown). */
  remaining: number | null
  ttl: string
  lines: { label: string; value: string; tone?: Tone | null }[]
}

/** The Overview's cache card. `precise` puts seconds on the countdown (a tick runs). */
export function cacheCard(s: TelemetryInsightsState, now: number, precise: boolean): CacheCard {
  const clock = deriveCacheClock(s, now)
  const stateText = clock.status === 'unknown' ? 'no request yet' : clock.status === 'cold' && clock.invalidatedBy ? `cold · ${clock.invalidatedBy === 'compaction' ? 'compacted' : 'model switched'}` : clock.status
  const tone: Tone | null = clock.status === 'warm' ? 'success' : clock.status === 'cooling' ? 'warning' : null
  const remaining = clock.expiresInMs === null || clock.status === 'cold' || clock.status === 'unknown' ? (clock.status === 'cold' ? 0 : null) : Math.max(0, Math.min(1, clock.expiresInMs / clock.ttlMs))
  const ttl = `${clock.ttl}${clock.ttlSource === 'default' ? ' (assumed)' : ''}`
  const lines: CacheCard['lines'] = []
  lines.push({ label: 'ttl', value: ttl })
  lines.push({ label: 'context', value: clock.contextTokens > 0 ? `${fmtTokens(clock.contextTokens)} tok to re-cache` : '–' })
  if (clock.recacheCostUsd !== null) lines.push({ label: 're-cache', value: `≈${fmtUsd(clock.recacheCostUsd)}${clock.recacheExtraUsd !== null ? ` · ${fmtUsd(clock.recacheExtraUsd)} over a hit` : ''}` })
  if (clock.lastTurnWasCacheMiss) lines.push({ label: 'last turn', value: `cache miss${clock.missCostUsd !== null ? ` · ≈${fmtUsd(clock.missCostUsd)} extra` : ''}`, tone: 'warning' })
  else if (clock.lastRequestAt !== null) lines.push({ label: 'last turn', value: 'served from cache' })
  if (clock.isMainIdle && clock.status === 'warm') lines.push({ label: 'main', value: 'idle · nothing refreshes it until you send' })
  const agents = clock.agents.filter(a => a.status !== 'unknown')
  if (agents.length > 0) lines.push({ label: 'agents', value: agents.map(a => `${a.label} ${a.status}`).join(' · ') })
  return { clock, state: { text: stateText, tone }, countdown: fmtCountdown(clock.expiresInMs, precise), remaining, ttl, lines }
}

// ================================================================ bloat

export const KIND_LABEL: Record<TelemetryBloatKind, string> = {
  'mcp-server': 'mcp',
  skill: 'skill',
  skills: 'skills',
  'custom-agent': 'agent',
  memory: 'memory',
  'system-tools': 'tools',
  'system-prompt': 'prompt',
  'slash-commands': 'cmds',
}

export const VERDICT_TONE: Record<TelemetryBloatVerdict, Tone | null> = { unused: 'error', rare: 'warning', active: 'success', 'n/a': null }

export type BloatView =
  | { isReady: false; reason: string }
  | {
      isReady: true
      rows: TelemetryBloatRow[]
      /** `3 unused items re-send ≈45k tok/request ≈ $1.20 this session`. */
      summary: string
      /** Which unused MCP servers / skills could be disabled; empty when none. */
      hint: string
      age: string
      detail: 'summary' | 'full'
      maxShare: number
    }

/** The Context tab's bloat audit. */
export function bloatView(s: TelemetryInsightsState, now: number): BloatView {
  const b = deriveBloat(s, now)
  if (!b.isReady) return { isReady: false, reason: b.reason }
  const unused = b.rows.filter(r => r.verdict === 'unused')
  const unusedTok = unused.reduce((n, r) => n + r.tokensPerRequest, 0)
  const summary = unused.length === 0 ? `nothing unused · ${fmtTokens(b.totals.inWindowTokens)} tok/request in the window` : `${unused.length} unused item${unused.length === 1 ? '' : 's'} re-send ≈${fmtTokens(unusedTok)} tok/request ≈ ${fmtUsd(b.totals.estCostUsd)} this session`
  const servers = unused.filter(r => r.kind === 'mcp-server').map(r => r.name)
  const skills = unused.filter(r => r.kind === 'skill').map(r => r.name)
  const hints: string[] = []
  if (servers.length > 0) hints.push(`mcp ${servers.slice(0, 4).join(', ')}${servers.length > 4 ? ` +${servers.length - 4}` : ''}`)
  if (skills.length > 0) hints.push(`skill ${skills.slice(0, 4).join(', ')}${skills.length > 4 ? ` +${skills.length - 4}` : ''}`)
  const hint = hints.length === 0 ? '' : `could be disabled: ${hints.join(' · ')}`
  const maxShare = Math.max(0, ...b.rows.map(r => r.windowShare ?? 0))
  return { isReady: true, rows: b.rows, summary, hint, age: `${fmtAgo(now - b.breakdownAt)} ago`, detail: b.breakdownDetail, maxShare }
}

/** The bloat footnote. */
export const BLOAT_FOOTNOTE = '≈ estimates: assume the row was in every main request seen, priced at the cache-read rate'

/** The last-used cell: `5m ago`, `never`, or `–` where calls are not observable. */
export function lastUsedText(r: TelemetryBloatRow): string {
  if (r.callsThisSession === null) return '–'
  if (r.lastUsedAgoMs === null) return 'never'
  const ago = fmtAgo(r.lastUsedAgoMs)
  return ago === 'now' ? 'just now' : `${ago} ago`
}

/** The bloat row's name for a narrow cell: a memory file by its tail, a plugin skill by its skill. */
export function bloatName(r: TelemetryBloatRow): string {
  if (r.kind === 'memory') return r.name.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')
  return r.name
}

// ================================================================ workflows

export type WorkflowCard = {
  wf: TelemetryWorkflow
  isOpen: boolean
  /** `4 agents · 2 running`, `3 agents · 1 failed`. */
  counts: string
  wall: string
  parallelism: string
  critical: string | null
  failures: string | null
  agents: TelemetryAgentRow[]
  /** The members' plans summed (those that have one); null when none has. */
  plan: { done: number; total: number } | null
}

/** The Agents tab's workflow cards: the filter and the search applied to the agents in each, a card left out when none of its agents match. */
export function workflowCards(s: TelemetryInsightsState, now: number, ui: Pick<TelemetryUi, 'expandedWorkflows' | 'agentFilter' | 'agentQuery'>, rows: TelemetryAgentRow[] = deriveAgents(s, now)): WorkflowCard[] {
  const flows = deriveWorkflows(s, now)
  const open = new Set(ui.expandedWorkflows ?? [])
  const filter = ui.agentFilter ?? 'all'
  const query = ui.agentQuery ?? ''
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: WorkflowCard[] = []
  for (const wf of flows) {
    const own = wf.agentIds.map(id => byId.get(id)).filter((r): r is TelemetryAgentRow => r !== undefined)
    const kept = deriveAgentFilter(own, { status: filter, query }).rows
    if (kept.length === 0 && (filter !== 'all' || query.trim() !== '')) continue
    const plan = workflowPlan(own)
    const counts = [
      `${wf.agentCount} agent${wf.agentCount === 1 ? '' : 's'}`,
      ...(wf.runningCount > 0 ? [`${wf.runningCount} running`] : []),
      ...(wf.staleCount > 0 ? [`${wf.staleCount} stale`] : []),
      ...(plan ? [`${planCountText(plan)} tasks`] : []),
    ].join(' · ')
    out.push({
      wf,
      isOpen: open.has(wf.id),
      counts,
      wall: fmtDuration(wf.wallMs),
      parallelism: wf.parallelism === null ? '' : `×${wf.parallelism >= 10 ? Math.round(wf.parallelism) : wf.parallelism.toFixed(1)}`,
      critical: wf.criticalPath && wf.criticalPath.agentIds.length > 1 ? `${wf.criticalPath.label} · ${fmtDuration(wf.criticalPath.durationMs)}` : null,
      failures: wf.failureCount > 0 ? `${wf.failureCount} failed` : null,
      agents: kept,
      plan,
    })
  }
  return out
}

// ================================================================ controls

export type AgentControls = {
  mode: 'tree' | 'workflows'
  filter: TelemetryAgentFilterChip
  query: string
  /** The chips in order with their counts over the rows that match the query. */
  chips: { id: TelemetryAgentFilterChip; label: string; count: number; on: boolean }[]
  /** The rows the chip and the query leave (main kept in tree mode; ghosts kept so they can fold). */
  rows: TelemetryAgentRow[]
  isFiltered: boolean
}

export function agentControls(rows: readonly TelemetryAgentRow[], ui: Pick<TelemetryUi, 'agentsMode' | 'agentFilter' | 'agentQuery'>): AgentControls {
  const filter = ui.agentFilter ?? 'all'
  const query = ui.agentQuery ?? ''
  const f = deriveAgentFilter(rows, { status: filter, query, includeMain: true, includeFolded: true })
  const order: TelemetryAgentFilterChip[] = ['all', 'running', 'done', 'failed', 'stale']
  const chips = order.map(id => ({ id, label: id, count: f.counts[id], on: id === filter }))
  const isFiltered = filter !== 'all' || query.trim() !== ''
  // main stays pinned only when nothing filters the list
  const kept = isFiltered ? f.rows.filter(r => r.id !== 'main' || filter === 'all') : f.rows
  return { mode: ui.agentsMode ?? 'tree', filter, query, chips, rows: kept, isFiltered }
}

/** `fmtPct` of a share, `–` for none (exported for the tables). */
export const shareText = (share: number | null): string => (share === null ? '–' : fmtPct(share))

/** The categories of the stored breakdown (for the band's terminal colours). */
export const categoriesOf = (s: Pick<TelemetryInsightsState, 'context'>): readonly TelemetryContextCategory[] => s.context.breakdown?.categories ?? []

// ================================================================ agent plans

export { planCountText }

/** The checklist glyphs: done, in progress, pending. */
export const PLAN_GLYPH: Record<TelemetryAgentPlanItemStatus, string> = { done: '✓', active: '▸', pending: '○' }

export type PlanChecklist = {
  /** At most `max` lines (with `more`, one less), a window around the item in progress. */
  items: { text: string; status: TelemetryAgentPlanItemStatus }[]
  /** Items left out (the window's and the stored list's); a `+N more` line when over 0. */
  more: number
}

/** The drawer's checklist: every item when they fit in `max` lines, else `max - 1` around the active one and `+N more`. */
export function planChecklist(plan: Pick<TelemetryAgentPlanView, 'items' | 'hiddenItems'>, max = 8): PlanChecklist {
  const items = plan.items.map(it => ({ text: it.text, status: it.status }))
  if (items.length + plan.hiddenItems <= max && items.length <= max) return { items, more: 0 }
  const room = Math.max(1, max - 1)
  const firstOpen = items.findIndex(it => it.status !== 'done')
  const anchor = firstOpen < 0 ? items.length - 1 : firstOpen
  const start = Math.max(0, Math.min(anchor - 2, items.length - room))
  const shown = items.slice(start, start + room)
  return { items: shown, more: items.length - shown.length + plan.hiddenItems }
}

/** A running row's task line: the plan's task, else what it does now (the phase), else the flow's title. */
export function planTaskText(plan: Pick<TelemetryAgentPlanView, 'currentTask' | 'title'>, phase: { text: string; sinceMs: number | null } | null): { text: string; isPhase: boolean; sinceMs: number | null } {
  if (plan.currentTask !== null) return { text: plan.currentTask, isPhase: false, sinceMs: null }
  if (phase) return { text: phase.text, isPhase: true, sinceMs: phase.sinceMs }
  return { text: plan.title ?? 'working', isPhase: false, sinceMs: null }
}

/** A workflow's progress: done and total summed over the members that report a plan with a total. */
export function workflowPlan(rows: readonly TelemetryAgentRow[]): { done: number; total: number } | null {
  let done = 0
  let total = 0
  let any = false
  for (const r of rows) {
    if (!r.plan || r.plan.total <= 0) continue
    any = true
    done += r.plan.done
    total += r.plan.total
  }
  return any ? { done, total } : null
}
