// session-telemetry: the in-memory model and its reducers. Pure (no `$`); each
// `record*` function MUTATES the TelemetryState it is given and returns the keys
// it changed, so collect.ts writes only those atoms. Unit-tested in tests/model.test.ts.
//
// Exports:
//   MAIN, LIMITS, StateKey, STATE_KEYS, SHAPE
//                                     the main loop's agent key, ring caps, atom keys, shape tag
//   emptyState(now), emptyUsage()     fresh values
//   resetState(prev, now)             a fresh state that counts the reset
//   recordSession, recordTurnStart, recordStep, recordTurnComplete,
//   recordToolStart, recordToolExec, recordToolEnd,
//   recordAgentSpawn, recordAgentReport, recordAgentList,
//   recordMeasure, recordBreakdown, recordBreakdownError,
//   recordCompaction, recordModelSwitch  the reducers (input types beside each)
//   recordPlan, PLAN_TOOLS, PLAN_ITEMS_MAX, planText
//                                     a loop's task list from its plan tools (savvy-progress step /
//                                     progress, TodoWrite, Task*), its text redacted
//   STALE_AFTER_MS, STALE_TOOL_MS, isLiveTool, hasLiveTool, isStaleLoop,
//   expireStaleAgents, reconcileAgents, isUnattributed
//                                     liveness: a loop that went quiet is stale, not running
//   toolLabel, mcpServerOf, utf8Length  helpers, exported for tests and the UI

import type {
  TelemetryAgent,
  TelemetryAgentKind,
  TelemetryAgentPlan,
  TelemetryAgentPlanItem,
  TelemetryAgentPlanItemStatus,
  TelemetryAgentReport,
  TelemetryAgentStatus,
  TelemetryContextBreakdown,
  TelemetryMcpServerContext,
  TelemetryMcpServerDetail,
  TelemetryState,
  TelemetryStep,
  TelemetryTokenCounts,
  TelemetryToolEvent,
  TelemetryToolStats,
  TelemetryTurn,
  TelemetryUsage,
} from '../types'

import { canonicalModel, costOf, findPricing, type CostBreakdown } from './pricing'

export const MAIN = 'main'

export const LIMITS = {
  steps: 500,
  tools: 200,
  turns: 200,
  contextHistory: 200,
  compactions: 50,
  modelSwitches: 50,
  agents: 200,
  toolNames: 300,
  memoryFiles: 50,
  stepToolNames: 10,
  skillNames: 200,
  skillRows: 100,
} as const

export type StateKey = 'totals' | 'agents' | 'steps' | 'tools' | 'turns' | 'context' | 'meta'

export const STATE_KEYS: readonly StateKey[] = ['totals', 'agents', 'steps', 'tools', 'turns', 'context', 'meta']

/** The tag every `$.state` value is kept under; bump it when a shape changes. */
export const SHAPE = 'v1'

/** The loop key of an event: the agent id, or "main" for the main loop. */
export const agentKey = (agentId: string | null | undefined): string =>
  agentId === undefined || agentId === null || agentId === '' ? MAIN : agentId

// ---------------------------------------------------------------- fresh values

export function emptyUsage(): TelemetryUsage {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    cacheSavedUsd: 0,
  }
}

function newAgent(id: string, kind: TelemetryAgentKind, now: number): TelemetryAgent {
  const isMain = id === MAIN
  return {
    id,
    kind,
    type: isMain ? 'main' : 'unknown',
    description: isMain ? 'Main session' : '',
    name: null,
    parentId: isMain ? null : MAIN,
    toolUseId: null,
    model: null,
    models: [],
    requestedModel: null,
    isBackground: false,
    status: isMain ? 'idle' : 'running',
    firstSeenAt: now,
    spawnedAt: null,
    lastActiveAt: now,
    endedAt: null,
    turns: 0,
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
}

export function emptyState(now: number): TelemetryState {
  return {
    totals: {
      session: emptyUsage(),
      byModel: {},
      byTool: {},
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      serverToolCalls: 0,
      firstStepAt: null,
      lastStepAt: null,
      evictedSteps: 0,
      evictedToolEvents: 0,
      evictedTurns: 0,
    },
    agents: { byId: { [MAIN]: newAgent(MAIN, 'main', now) }, order: [MAIN], evicted: 0 },
    steps: [],
    tools: [],
    turns: [],
    context: {
      updatedAt: null,
      window: null,
      tokens: null,
      percent: null,
      breakdown: null,
      lastFullAt: null,
      breakdownError: null,
      history: [],
      rateLimits: [],
      engineCostUsd: null,
      compactions: [],
    },
    meta: {
      schema: 1,
      sessionId: null,
      startedAt: null,
      firstSeenAt: now,
      cwd: null,
      isInteractive: null,
      mainModel: null,
      mainModelFrom: null,
      modelSwitches: [],
      cacheTtl: '5m',
      enginePricing: null,
      managedPricingSet: null,
      mainTurns: 0,
      activeTurns: {},
      resets: 0,
      updatedAt: now,
    },
  }
}

/** A fresh state for a new conversation (/clear, resume), counting the reset. */
export function resetState(prev: TelemetryState | null, now: number): TelemetryState {
  const next = emptyState(now)
  next.meta.resets = (prev?.meta.resets ?? 0) + 1
  return next
}

// ---------------------------------------------------------------- helpers

/** Appends to a ring buffer, dropping the oldest past `cap`; answers how many fell off. */
function pushRing<T>(list: T[], item: T, cap: number): number {
  list.push(item)
  const over = list.length - cap
  if (over > 0) {
    list.splice(0, over)
    return over
  }
  return 0
}

function findLast<T>(list: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]
    if (item !== undefined && test(item)) return item
  }
  return undefined
}

function addUsage(u: TelemetryUsage, counts: TelemetryTokenCounts, cost: CostBreakdown): void {
  u.requests += 1
  u.input += counts.input
  u.output += counts.output
  u.cacheRead += counts.cacheRead
  u.cacheWrite += counts.cacheWrite
  u.costUsd += cost.usd
  u.inputUsd += cost.inputUsd
  u.outputUsd += cost.outputUsd
  u.cacheReadUsd += cost.cacheReadUsd
  u.cacheWriteUsd += cost.cacheWriteUsd
  u.cacheSavedUsd += cost.cacheSavedUsd
}

const tokensOf = (c: TelemetryTokenCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite

/** The engine's four counts as the API spells them. */
export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function countsOf(usage: Partial<ApiUsage> | null | undefined): TelemetryTokenCounts {
  return {
    input: num(usage?.input_tokens),
    output: num(usage?.output_tokens),
    cacheRead: num(usage?.cache_read_input_tokens),
    cacheWrite: num(usage?.cache_creation_input_tokens),
  }
}

/** UTF-8 length of a string without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        i += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** The MCP server of an `mcp__<server>__<tool>` name, else null. */
export function mcpServerOf(tool: string): string | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match?.[1] ?? null
}

const LABEL_KEYS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'subagent_type'],
  Skill: ['skill'],
}

const FALLBACK_LABEL_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'name', 'skill', 'prompt']

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A short one-line hint of what a call works on (command, path, pattern, url), at most 80 chars. */
export function toolLabel(tool: string, input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of LABEL_KEYS[tool] ?? FALLBACK_LABEL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(value, 80)
  }
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_INPUT_KEYS.has(key)) continue
    if (typeof value === 'string' && value.trim() !== '') return clip(value, 80)
  }
  return null
}

/** Keys `tool.call` carries beside a tool's own arguments. */
const RESERVED_INPUT_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

/** The agent under `id`, made if absent (evicting the oldest finished one past the cap). */
function ensureAgent(s: TelemetryState, id: string, now: number): TelemetryAgent {
  const known = s.agents.byId[id]
  if (known) return known
  const agent = newAgent(id, id === MAIN ? 'main' : 'unknown', now)
  s.agents.byId[id] = agent
  s.agents.order.push(id)
  while (s.agents.order.length > LIMITS.agents) {
    let oldest: TelemetryAgent | undefined
    for (const key of s.agents.order) {
      const candidate = s.agents.byId[key]
      if (!candidate || candidate.id === MAIN || candidate.status === 'running' || candidate.id === id) continue
      if (!oldest || candidate.lastActiveAt < oldest.lastActiveAt) oldest = candidate
    }
    if (!oldest) break
    const evicted = oldest.id
    delete s.agents.byId[evicted]
    s.agents.order = s.agents.order.filter(key => key !== evicted)
    s.agents.evicted += 1
  }
  return agent
}

function ensureToolStats(s: TelemetryState, tool: string, isServerTool: boolean, now: number): TelemetryToolStats {
  const known = s.totals.byTool[tool]
  if (known) return known
  const stats: TelemetryToolStats = {
    tool,
    server: mcpServerOf(tool),
    isServerTool,
    calls: 0,
    ok: 0,
    errors: 0,
    denied: 0,
    interrupted: 0,
    running: 0,
    wallMsTotal: 0,
    wallMsMax: 0,
    execMsTotal: 0,
    execCount: 0,
    resultChars: 0,
    resultBytes: 0,
    lastAt: now,
  }
  s.totals.byTool[tool] = stats
  const names = Object.keys(s.totals.byTool)
  if (names.length > LIMITS.toolNames) {
    let oldest: TelemetryToolStats | undefined
    for (const name of names) {
      const candidate = s.totals.byTool[name]
      if (!candidate || candidate.running > 0 || name === tool) continue
      if (!oldest || candidate.lastAt < oldest.lastAt) oldest = candidate
    }
    if (oldest) delete s.totals.byTool[oldest.tool]
  }
  return stats
}

function newTurn(turnId: string, agentId: string, now: number): TelemetryTurn {
  return {
    turnId,
    agentId,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    reason: null,
    promptChars: 0,
    steps: 0,
    toolCalls: 0,
    usage: emptyUsage(),
    engineUsage: null,
    contextTokensEnd: 0,
    model: null,
  }
}

function ensureTurn(s: TelemetryState, turnId: string, agentId: string, now: number): TelemetryTurn {
  const known = findLast(s.turns, turn => turn.turnId === turnId)
  if (known) return known
  const turn = newTurn(turnId, agentId, now)
  s.totals.evictedTurns += pushRing(s.turns, turn, LIMITS.turns)
  return turn
}

function addModel(agent: TelemetryAgent, model: string): void {
  agent.model = model
  if (!agent.models.includes(model)) agent.models.push(model)
}

// ---------------------------------------------------------------- session

export type SessionInfo = {
  sessionId?: string | null
  startedAt?: number | null
  cwd?: string | null
  isInteractive?: boolean | null
  mainModel?: string | null
  managedPricingSet?: boolean | null
}

export function recordSession(s: TelemetryState, info: SessionInfo, now: number): StateKey[] {
  const meta = s.meta
  if (info.sessionId) meta.sessionId = info.sessionId
  // a start of 0 (an unbound session answers the epoch) or in the future is no start
  if (typeof info.startedAt === 'number' && Number.isFinite(info.startedAt) && info.startedAt > 0 && info.startedAt <= now) meta.startedAt = info.startedAt
  if (info.cwd) meta.cwd = info.cwd
  if (typeof info.isInteractive === 'boolean') meta.isInteractive = info.isInteractive
  if (typeof info.managedPricingSet === 'boolean') meta.managedPricingSet = info.managedPricingSet
  if (info.mainModel && meta.mainModelFrom === null) {
    meta.mainModel = info.mainModel
    meta.mainModelFrom = 'session'
  }
  meta.updatedAt = now
  return ['meta']
}

// ---------------------------------------------------------------- turns

export type TurnStartInput = { turnId: string; agentId?: string; text: string }

export function recordTurnStart(s: TelemetryState, i: TurnStartInput, now: number): StateKey[] {
  const key = agentKey(i.agentId)
  const agent = ensureAgent(s, key, now)
  agent.turns += 1
  agent.status = 'running'
  agent.endedAt = null
  agent.lastActiveAt = now
  if (key === MAIN) s.meta.mainTurns += 1
  s.meta.activeTurns[key] = i.turnId
  s.meta.updatedAt = now
  const turn = ensureTurn(s, i.turnId, key, now)
  turn.startedAt = now
  turn.promptChars = i.text.length
  return ['agents', 'turns', 'meta', 'totals']
}

export type TurnCompleteInput = {
  turnId: string
  agentId?: string
  durationMs: number
  reason: string
  usage?: (Partial<ApiUsage> & { model?: string }) | null
}

function endStatus(agent: TelemetryAgent, reason: string): TelemetryAgentStatus {
  if (agent.id === MAIN || agent.kind === 'teammate') return reason === 'error' ? 'error' : 'idle'
  if (reason === 'answer') return 'completed'
  if (reason === 'aborted') return 'aborted'
  if (reason === 'refusal') return 'refused'
  if (reason === 'error') return 'error'
  return 'unknown'
}

export function recordTurnComplete(s: TelemetryState, i: TurnCompleteInput, now: number): StateKey[] {
  const key = agentKey(i.agentId)
  const agent = ensureAgent(s, key, now)
  const turn = ensureTurn(s, i.turnId, key, now - Math.max(0, i.durationMs))
  turn.endedAt = now
  turn.durationMs = Math.max(0, i.durationMs)
  turn.reason = i.reason
  if (i.usage) turn.engineUsage = { ...countsOf(i.usage), model: i.usage.model ?? turn.model ?? '' }
  agent.activeMs += turn.durationMs
  agent.status = endStatus(agent, i.reason)
  agent.lastActiveAt = now
  if (agent.status !== 'idle' && agent.status !== 'running') agent.endedAt = now
  if (s.meta.activeTurns[key] === i.turnId) delete s.meta.activeTurns[key]
  s.meta.updatedAt = now
  return ['agents', 'turns', 'meta', 'totals']
}

// ---------------------------------------------------------------- steps

export type StepInput = {
  turnId: string
  index: number
  agentId?: string
  /** The model the request named. */
  model: string
  effort?: string | number | null
  messageCount: number
  startedAt: number
  endedAt: number
  usage: (Partial<ApiUsage> & { model?: string }) | null
  stopReason: string | null
  toolUses: readonly { name: string }[]
  serverToolUses?: readonly { id: string; name: string; startedAt: number; endedAt?: number }[]
}

export function recordStep(s: TelemetryState, i: StepInput, now: number): StateKey[] {
  const dirty: StateKey[] = ['totals', 'agents', 'steps', 'turns']
  const key = agentKey(i.agentId)
  const counts = countsOf(i.usage)
  const model = i.usage?.model || i.model
  const cost = costOf(counts, model, s.meta.cacheTtl)
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite
  const hasUsage = i.usage !== null

  const totals = s.totals
  totals.steps += 1
  totals.firstStepAt ??= i.startedAt
  totals.lastStepAt = i.endedAt

  const agent = ensureAgent(s, key, now)
  agent.steps += 1
  agent.lastActiveAt = now
  if (key !== MAIN && agent.status !== 'running' && agent.endedAt === null) agent.status = 'running'
  addModel(agent, model)

  const turn = ensureTurn(s, i.turnId, key, i.startedAt)
  turn.steps += 1
  turn.model = model

  if (hasUsage) {
    addUsage(totals.session, counts, cost)
    const { entry, match } = findPricing(model)
    const perModel = (totals.byModel[model] ??= {
      ...emptyUsage(),
      model,
      label: match === 'exact' ? entry.label : model,
      family: match === 'default' ? 'unknown' : entry.family,
      pricing: match,
      lastAt: now,
    })
    addUsage(perModel, counts, cost)
    perModel.lastAt = now
    addUsage(agent.usage, counts, cost)
    const slice = (agent.byModel[model] ??= { requests: 0, tokens: 0, costUsd: 0 })
    slice.requests += 1
    slice.tokens += tokensOf(counts)
    slice.costUsd += cost.usd
    agent.lastContextTokens = prompt
    agent.peakContextTokens = Math.max(agent.peakContextTokens, prompt)
    addUsage(turn.usage, counts, cost)
    turn.contextTokensEnd = prompt

    if (key === MAIN) {
      const meta = s.meta
      if (meta.mainModel !== null && meta.mainModelFrom === 'step' && canonicalModel(meta.mainModel) !== canonicalModel(model)) {
        pushRing(
          meta.modelSwitches,
          { at: now, from: meta.mainModel, to: model, source: 'observed', contextTokens: prompt, estimatedCacheWriteUsd: null, pricing: null },
          LIMITS.modelSwitches,
        )
      }
      if (meta.mainModel !== model || meta.mainModelFrom !== 'step') {
        meta.mainModel = model
        meta.mainModelFrom = 'step'
        dirty.push('meta')
      }
    }
  }

  const step: TelemetryStep = {
    turnId: i.turnId,
    index: i.index,
    agentId: key,
    model,
    effort: i.effort === undefined || i.effort === null ? null : String(i.effort),
    startedAt: i.startedAt,
    endedAt: i.endedAt,
    durationMs: Math.max(0, i.endedAt - i.startedAt),
    messageCount: i.messageCount,
    ...counts,
    contextTokens: prompt,
    costUsd: hasUsage ? cost.usd : 0,
    pricing: cost.pricing,
    stopReason: i.stopReason,
    toolUses: i.toolUses.length,
    toolNames: i.toolUses.slice(0, LIMITS.stepToolNames).map(use => use.name),
    serverToolUses: i.serverToolUses?.length ?? 0,
    hasUsage,
  }
  totals.evictedSteps += pushRing(s.steps, step, LIMITS.steps)

  for (const use of i.serverToolUses ?? []) {
    const ended = use.endedAt ?? null
    const wallMs = ended === null ? null : Math.max(0, ended - use.startedAt)
    const event: TelemetryToolEvent = {
      id: use.id,
      tool: use.name,
      server: null,
      agentId: key,
      turnId: i.turnId,
      label: null,
      startedAt: use.startedAt,
      endedAt: ended,
      wallMs,
      execMs: wallMs,
      status: ended === null ? 'interrupted' : 'ok',
      resultChars: null,
      resultBytes: null,
      isReadOnly: true,
      isServerTool: true,
      error: null,
    }
    totals.evictedToolEvents += pushRing(s.tools, event, LIMITS.tools)
    const stats = ensureToolStats(s, use.name, true, now)
    stats.calls += 1
    if (ended === null) stats.interrupted += 1
    else stats.ok += 1
    if (wallMs !== null) {
      stats.wallMsTotal += wallMs
      stats.wallMsMax = Math.max(stats.wallMsMax, wallMs)
      stats.execMsTotal += wallMs
      stats.execCount += 1
    }
    stats.lastAt = now
    totals.serverToolCalls += 1
    agent.byTool[use.name] = (agent.byTool[use.name] ?? 0) + 1
  }
  if (i.serverToolUses?.length) dirty.push('tools')
  return dirty
}

// ---------------------------------------------------------------- tools

export type ToolStartInput = { id: string; tool: string; agentId?: string; input: unknown }

export function recordToolStart(s: TelemetryState, i: ToolStartInput, now: number): StateKey[] {
  const key = agentKey(i.agentId)
  const turnId = s.meta.activeTurns[key] ?? null
  const event: TelemetryToolEvent = {
    id: i.id,
    tool: i.tool,
    server: mcpServerOf(i.tool),
    agentId: key,
    turnId,
    label: toolLabel(i.tool, i.input),
    startedAt: now,
    endedAt: null,
    wallMs: null,
    execMs: null,
    status: 'running',
    resultChars: null,
    resultBytes: null,
    isReadOnly: false,
    isServerTool: false,
    error: null,
  }
  s.totals.evictedToolEvents += pushRing(s.tools, event, LIMITS.tools)
  const stats = ensureToolStats(s, i.tool, false, now)
  stats.calls += 1
  stats.running += 1
  stats.lastAt = now
  s.totals.toolCalls += 1
  const agent = ensureAgent(s, key, now)
  agent.toolCalls += 1
  agent.byTool[i.tool] = (agent.byTool[i.tool] ?? 0) + 1
  agent.lastActiveAt = now
  if (turnId !== null) {
    const turn = findLast(s.turns, t => t.turnId === turnId)
    if (turn) turn.toolCalls += 1
  }
  if (i.tool === 'Skill') countSkill(s, i.input, now)
  return ['tools', 'totals', 'agents', 'turns']
}

/** A Skill tool call, counted under its `skill` argument (the name only: never any other input). */
function countSkill(s: TelemetryState, input: unknown, now: number): void {
  if (input === null || typeof input !== 'object') return
  const raw = (input as Record<string, unknown>).skill
  if (typeof raw !== 'string' || raw.trim() === '') return
  const name = clip(raw, 120)
  const bySkill = (s.totals.bySkill ??= {})
  const stats = (bySkill[name] ??= { calls: 0, lastAt: now })
  stats.calls += 1
  stats.lastAt = now
  const names = Object.keys(bySkill)
  if (names.length > LIMITS.skillNames) {
    let oldest: string | null = null
    for (const key of names) {
      if (key === name) continue
      if (oldest === null || (bySkill[key]?.lastAt ?? 0) < (bySkill[oldest]?.lastAt ?? 0)) oldest = key
    }
    if (oldest !== null) delete bySkill[oldest]
  }
}

export type ToolEndInput = {
  id: string
  tool: string
  agentId?: string
  deny?: string
  isError?: boolean
  text?: string
  isReadOnly?: boolean
  /** The chain beneath rejected (the call threw). */
  threw?: boolean
}

export function recordToolEnd(s: TelemetryState, i: ToolEndInput, now: number): StateKey[] {
  const key = agentKey(i.agentId)
  const event = findLast(s.tools, e => e.id === i.id && !e.isServerTool)
  const stats = ensureToolStats(s, i.tool, false, now)
  const agent = ensureAgent(s, key, now)
  const wasInterrupted = event?.status === 'interrupted'
  const status =
    i.deny !== undefined ? 'denied' : wasInterrupted ? 'interrupted' : i.threw || i.isError ? 'error' : 'ok'
  const text = typeof i.text === 'string' ? i.text : null
  const wallMs = event ? Math.max(0, now - event.startedAt) : null

  if (event) {
    event.status = status
    event.endedAt = now
    event.wallMs = wallMs
    event.isReadOnly = i.isReadOnly === true
    if (text !== null) {
      event.resultChars = text.length
      event.resultBytes = utf8Length(text)
    }
    if (status === 'denied') event.error = clip(i.deny ?? '', 160)
    else if (status === 'error' || status === 'interrupted') event.error = text === null ? null : clip(text, 160)
  }

  stats.running = Math.max(0, stats.running - 1)
  if (status === 'ok') stats.ok += 1
  else if (status === 'denied') stats.denied += 1
  else if (status === 'interrupted') stats.interrupted += 1
  else stats.errors += 1
  if (wallMs !== null) {
    stats.wallMsTotal += wallMs
    stats.wallMsMax = Math.max(stats.wallMsMax, wallMs)
  }
  if (text !== null) {
    stats.resultChars += text.length
    stats.resultBytes += event?.resultBytes ?? utf8Length(text)
  }
  stats.lastAt = now
  if (status === 'error' || status === 'interrupted') {
    s.totals.toolErrors += 1
    agent.toolErrors += 1
  }
  agent.lastActiveAt = now
  return ['tools', 'totals', 'agents']
}

export type ToolExecInput = { id: string; durationMs?: number; isInterrupt?: boolean }

/** The engine's own execution time for a call (classic PostToolUse / PostToolUseFailure). */
export function recordToolExec(s: TelemetryState, i: ToolExecInput, now: number): StateKey[] {
  const event = findLast(s.tools, e => e.id === i.id && !e.isServerTool)
  if (!event) return []
  const stats = s.totals.byTool[event.tool]
  if (typeof i.durationMs === 'number' && event.execMs === null) {
    event.execMs = Math.max(0, i.durationMs)
    if (stats) {
      stats.execMsTotal += event.execMs
      stats.execCount += 1
    }
  }
  if (i.isInterrupt && event.status !== 'interrupted') {
    if (stats && event.status === 'error') {
      stats.errors = Math.max(0, stats.errors - 1)
      stats.interrupted += 1
    }
    if (event.status === 'running' || event.status === 'error') event.status = 'interrupted'
  }
  if (stats) stats.lastAt = now
  return ['tools', 'totals']
}

// ---------------------------------------------------------------- plans

/** The tools a loop reports its task list through (recordPlan). */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(['mcp__savvy-progress__step', 'mcp__savvy-progress__progress', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])

const REDACTED = '•••'

/**
 * Plan text made safe to keep and draw: one line; a URL as its host and path
 * (user info, query and fragment dropped); `key=value` pairs for secret-ish
 * keys, `Bearer …`, known token prefixes (sk-, ghp_, xox?-, AKIA…, AIza…, JWTs)
 * and long letter-and-digit runs replaced by `•••`; cut at `max` (80). Null
 * when nothing is left.
 */
export function planText(raw: unknown, max = 80): string | null {
  if (typeof raw !== 'string') return null
  // control characters out, one line
  let t = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (t === '') return null
  t = t.slice(0, 2_000)
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#]+)([^\s?#]*)(?:[?#]\S*)?/gi, (_m, host: string, path: string) => `${host.replace(/^[^@]*@/, '')}${path}`)
  t = t.replace(/\b[^\s:@/]+:[^\s:@/]+@(?=[a-z0-9.-]+\.[a-z]{2,})/gi, '')
  t = t.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
  t = t.replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${REDACTED}`)
  t = t.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, REDACTED)
  t = t.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}/g, REDACTED)
  t = t.replace(/\bxox[abprs]-[A-Za-z0-9-]{6,}/g, REDACTED)
  t = t.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, REDACTED)
  t = t.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED)
  t = t.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED)
  t = t.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m))
  t = t.replace(/\b[A-Za-z0-9_-]{24,}\b/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m))
  t = t.replace(/\s+/g, ' ').trim()
  if (t === '') return null
  return clip(t, max)
}

export const PLAN_ITEMS_MAX = 30

export type PlanInput = { agentId?: string; tool: string; input: unknown; result?: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A finite count ≥ 0 (floored), else null. */
function countOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1_000_000, Math.floor(v)) : null
}

function itemStatus(v: unknown): TelemetryAgentPlanItemStatus {
  return v === 'completed' || v === 'done' ? 'done' : v === 'in_progress' || v === 'active' ? 'active' : 'pending'
}

/** At most PLAN_ITEMS_MAX items: a window starting a few before the first one not done. */
function windowPlanItems(items: TelemetryAgentPlanItem[]): TelemetryAgentPlanItem[] {
  if (items.length <= PLAN_ITEMS_MAX) return items
  const firstOpen = items.findIndex(it => it.status !== 'done')
  const anchor = firstOpen < 0 ? items.length - 1 : firstOpen
  const start = Math.max(0, Math.min(anchor - 5, items.length - PLAN_ITEMS_MAX))
  return items.slice(start, start + PLAN_ITEMS_MAX)
}

function countsFrom(items: readonly TelemetryAgentPlanItem[]): { done: number; total: number; current?: string } {
  const active = items.find(it => it.status === 'active')
  return { done: items.filter(it => it.status === 'done').length, total: items.length, ...(active ? { current: active.text } : {}) }
}

/** The Task* tools' list: TaskCreate adds (its id from the result), TaskUpdate changes or deletes, TaskList replaces. Null: nothing to say. */
function tasksPlan(prev: TelemetryAgentPlan | null, tool: string, input: Record<string, unknown>, result: unknown): TelemetryAgentPlanItem[] | 'clear' | null {
  const base = prev?.source === 'tasks' ? (prev.items ?? []).map(it => ({ ...it })) : []
  if (tool === 'TaskList') {
    const tasks = isRecord(result) && Array.isArray(result.tasks) ? result.tasks : null
    if (tasks === null) return null
    const out: TelemetryAgentPlanItem[] = []
    for (const t of tasks.slice(0, 500)) {
      if (!isRecord(t)) continue
      const text = planText(t.subject)
      if (text === null) continue
      out.push({ text, status: itemStatus(t.status), ...(typeof t.id === 'string' ? { id: t.id.slice(0, 64) } : {}) })
    }
    return out.length === 0 ? (prev?.source === 'tasks' ? 'clear' : null) : out
  }
  if (tool === 'TaskCreate') {
    const task = isRecord(result) && isRecord(result.task) ? result.task : null
    const text = planText(task?.subject ?? input.subject)
    if (text === null) return null
    const id = typeof task?.id === 'string' ? task.id.slice(0, 64) : undefined
    if (id !== undefined && base.some(it => it.id === id)) return null
    base.push({ text, status: 'pending', ...(id !== undefined ? { id } : {}) })
    return base
  }
  // TaskUpdate
  const id = typeof input.taskId === 'string' ? input.taskId.slice(0, 64) : null
  if (id === null) return null
  const at = base.findIndex(it => it.id === id)
  if (input.status === 'deleted') {
    if (at < 0) return null
    base.splice(at, 1)
    return base.length === 0 ? 'clear' : base
  }
  const text = planText(input.subject)
  if (at < 0) {
    if (text === null) return null
    base.push({ id, text, status: typeof input.status === 'string' ? itemStatus(input.status) : 'pending' })
    return base
  }
  const item = base[at]
  if (!item) return null
  if (typeof input.status === 'string') item.status = itemStatus(input.status)
  if (text !== null) item.text = text
  return base
}

/** Keeps at most PLAN_ITEMS_MAX tasks, the earliest finished ones dropped first. */
function capTasks(items: TelemetryAgentPlanItem[]): TelemetryAgentPlanItem[] {
  const out = [...items]
  while (out.length > PLAN_ITEMS_MAX) {
    const firstDone = out.findIndex(it => it.status === 'done')
    out.splice(firstDone < 0 ? 0 : firstDone, 1)
  }
  return out
}

function nextPlan(prev: TelemetryAgentPlan | null, key: string, tool: string, input: Record<string, unknown>, result: unknown, now: number): TelemetryAgentPlan | null | undefined {
  switch (tool) {
    case 'mcp__savvy-progress__step': {
      const done = countOf(input.done)
      if (done === null) return undefined
      const total = countOf(input.total) ?? (prev?.source === 'step' ? prev.total : 0)
      const note = planText(input.note)
      return { source: 'step', done, total, ...(note !== null ? { current: note } : {}), updatedAt: now }
    }
    case 'mcp__savvy-progress__progress': {
      // main only, by the tool's own contract: a subagent's call is ignored there, so here too
      if (key !== MAIN) return undefined
      // a call naming none of the tool's fields says nothing
      if (countOf(input.total) === null && countOf(input.done) === null && !Array.isArray(input.tasks) && input.finished !== true && typeof input.title !== 'string' && typeof input.phase !== 'string') return undefined
      const base = prev?.source === 'progress' ? prev : null
      const titles: string[] = Array.isArray(input.tasks)
        ? input.tasks
            .slice(0, 200)
            .map(t => (isRecord(t) ? planText(t.title) : null))
            .filter((t): t is string => t !== null)
        : (base?.items ?? []).map(it => it.text)
      const finished = input.finished === true
      const total = countOf(input.total) ?? (Array.isArray(input.tasks) ? titles.length : base?.total ?? titles.length)
      const doneRaw = countOf(input.done) ?? base?.done ?? 0
      const done = finished ? Math.max(total, doneRaw) : doneRaw
      const items = windowPlanItems(titles.map((text, i) => ({ text, status: (finished || i < done ? 'done' : i === done ? 'active' : 'pending') as TelemetryAgentPlanItemStatus })))
      const title = planText(input.title) ?? base?.title
      const phase = typeof input.phase === 'string' ? planText(input.phase, 20) ?? undefined : base?.phase
      const current = finished ? undefined : (titles[done] ?? (phase ? `phase ${phase}` : undefined))
      return {
        source: 'progress',
        done,
        total,
        ...(current !== undefined ? { current } : {}),
        ...(items.length > 0 ? { items } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(phase !== undefined ? { phase } : {}),
        updatedAt: now,
      }
    }
    case 'TodoWrite': {
      if (!Array.isArray(input.todos)) return undefined
      const all: TelemetryAgentPlanItem[] = []
      let current: string | undefined
      for (const t of input.todos.slice(0, 500)) {
        if (!isRecord(t)) continue
        const text = planText(t.content)
        if (text === null) continue
        const status = itemStatus(t.status)
        if (status === 'active' && current === undefined) current = planText(t.activeForm) ?? text
        all.push({ text, status })
      }
      if (all.length === 0) return prev?.source === 'todos' ? null : undefined
      const counts = countsFrom(all)
      return { source: 'todos', done: counts.done, total: counts.total, ...(current !== undefined ? { current } : {}), items: windowPlanItems(all), updatedAt: now }
    }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList': {
      const items = tasksPlan(prev, tool, input, result)
      if (items === null) return undefined
      if (items === 'clear') return null
      const kept = capTasks(items)
      const counts = countsFrom(kept)
      return { source: 'tasks', done: counts.done, total: counts.total, ...(counts.current !== undefined ? { current: counts.current } : {}), items: kept, updatedAt: now }
    }
    default:
      return undefined
  }
}

/**
 * A finished, answered call of a plan tool (PLAN_TOOLS) sets its loop's plan:
 * the latest call wins (a `progress` call merges with the plan it updates, as
 * the tool keeps fields left out). Only titles and notes are read, redacted
 * (planText); an input or result of an unknown shape changes nothing, and
 * nothing here throws.
 */
export function recordPlan(s: TelemetryState, i: PlanInput, now: number): StateKey[] {
  try {
    if (!PLAN_TOOLS.has(i.tool) || !isRecord(i.input)) return []
    const key = agentKey(i.agentId)
    const agent = s.agents.byId[key]
    if (!agent) return []
    const prev = agent.plan ?? null
    const next = nextPlan(prev, key, i.tool, i.input, i.result, now)
    if (next === undefined) return []
    agent.plan = next
    return ['agents']
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- agents

export type AgentSpawnInput = {
  agentId: string
  subagentType: string
  description: string
  name?: string
  parentAgentId?: string
  /** The resolved model the engine answered. */
  model?: string
  /** The Agent call's own `model` parameter. */
  requestedModel?: string
  background: boolean
  fork: boolean
  isTeammate?: boolean
  isWorkflow?: boolean
  toolUseId?: string
}

export function recordAgentSpawn(s: TelemetryState, i: AgentSpawnInput, now: number): StateKey[] {
  const agent = ensureAgent(s, i.agentId, now)
  agent.kind = i.isTeammate ? 'teammate' : i.isWorkflow ? 'workflow' : i.fork ? 'fork' : 'subagent'
  agent.type = i.subagentType || agent.type
  agent.description = i.description || agent.description
  agent.name = i.name ?? agent.name
  agent.parentId = agentKey(i.parentAgentId)
  agent.toolUseId = i.toolUseId || agent.toolUseId
  agent.requestedModel = i.requestedModel ?? agent.requestedModel
  if (i.model && agent.model === null) addModel(agent, i.model)
  agent.isBackground = i.background
  agent.spawnedAt ??= now
  agent.status = 'running'
  agent.endedAt = null
  agent.lastActiveAt = now
  return ['agents']
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** What a completed Agent tool call answered (`result`), recorded on the agent it ran. */
export function recordAgentReport(s: TelemetryState, agentIdHint: string | null, result: unknown, now: number): StateKey[] {
  if (result === null || typeof result !== 'object') return []
  const r = result as Record<string, unknown>
  const agentId = str(r.agentId) ?? agentIdHint
  if (!agentId) return []
  const agent = ensureAgent(s, agentId, now)
  const status = str(r.status) ?? 'unknown'
  if (agent.kind === 'unknown') agent.kind = 'subagent'
  const type = str(r.agentType)
  if (type && (agent.type === 'unknown' || agent.type === '')) agent.type = type
  const description = str(r.description)
  if (description && agent.description === '') agent.description = description
  const resolved = str(r.resolvedModel)
  if (resolved && agent.model === null) addModel(agent, resolved)
  if (status === 'completed') {
    const usage = (r.usage ?? null) as Record<string, unknown> | null
    const split = (usage?.cache_creation ?? null) as Record<string, unknown> | null
    const counts = countsOf(usage as Partial<ApiUsage> | null)
    const report: TelemetryAgentReport = {
      status,
      totalTokens: num(r.totalTokens),
      totalDurationMs: num(r.totalDurationMs),
      totalToolUseCount: num(r.totalToolUseCount),
      ...counts,
      cacheWrite5m: split ? num(split.ephemeral_5m_input_tokens) : null,
      cacheWrite1h: split ? num(split.ephemeral_1h_input_tokens) : null,
      modelsUsed: Array.isArray(r.modelsUsed) ? r.modelsUsed.filter((m): m is string => typeof m === 'string') : [],
    }
    agent.report = report
    if (agent.status === 'running') agent.status = 'completed'
    agent.endedAt ??= now
  }
  agent.lastActiveAt = now
  return ['agents']
}

export type AgentListEntry = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
  name?: string
  teammateId?: string
}

const LIST_STATUS: Readonly<Record<string, TelemetryAgentStatus>> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'idle',
  completed: 'completed',
  failed: 'error',
  killed: 'aborted',
}

/** Fills in what `$.agent.list()` knows of agents this mod saw without a spawn. */
export function recordAgentList(s: TelemetryState, list: readonly AgentListEntry[], now: number): StateKey[] {
  let changed = false
  let metaChanged = false
  for (const info of list) {
    const agent = s.agents.byId[info.id]
    if (!agent) continue
    if (agent.type === 'unknown' && info.type) agent.type = info.type
    if (agent.description === '' && info.description) agent.description = info.description
    if (agent.name === null && info.name) agent.name = info.name
    if (info.parentId) agent.parentId = info.parentId
    if (agent.kind === 'unknown') agent.kind = info.teammateId || info.type === 'teammate' ? 'teammate' : 'subagent'
    const status = LIST_STATUS[info.status]
    // a running loop, or one the stale sweep settled (unknown, no end seen), takes the engine's word for its end
    const open = agent.status === 'running' || (agent.status === 'unknown' && agent.endedAt === null)
    if (status && open && status !== 'running') {
      agent.status = status
      agent.lastActiveAt = now
      if (status !== 'idle') agent.endedAt ??= now
      // the engine says the loop is over: its open turn (whose end was never seen) is over too
      if (s.meta.activeTurns[agent.id] !== undefined) {
        delete s.meta.activeTurns[agent.id]
        s.meta.updatedAt = now
        metaChanged = true
      }
    }
    changed = true
  }
  return changed ? (metaChanged ? ['agents', 'meta'] : ['agents']) : []
}

// ---------------------------------------------------------------- liveness

/**
 * A loop that reported nothing of its own (no step, no tool start or end, no
 * turn) for this long is stale: its end was most likely never seen (an engine
 * fork whose steps no hook sees, a completion that landed while the module
 * hot-reloaded). A stale loop is not counted as running, not drawn as live,
 * and comes back the moment a later event of its own arrives.
 */
export const STALE_AFTER_MS = 10 * 60_000

/** A tool call still "running" this long after it started no longer counts as activity (its end was most likely never seen). */
export const STALE_TOOL_MS = 60 * 60_000

/** A call in flight that still counts as activity: running, the engine's (not a server tool), and started within STALE_TOOL_MS. */
export const isLiveTool = (ev: Pick<TelemetryToolEvent, 'status' | 'isServerTool' | 'startedAt'>, now: number): boolean =>
  ev.status === 'running' && !ev.isServerTool && ev.startedAt > 0 && now - ev.startedAt <= STALE_TOOL_MS

/** Whether a call of the loop's own is live (a long Bash, a wait on a subagent). */
export function hasLiveTool(s: Pick<TelemetryState, 'tools'>, id: string, now: number): boolean {
  for (let i = s.tools.length - 1; i >= 0; i -= 1) {
    const ev = s.tools[i]
    if (ev && ev.agentId === id && isLiveTool(ev, now)) return true
  }
  return false
}

/**
 * Whether the loop `id` has gone quiet: no event of its own for STALE_AFTER_MS
 * and no live call. An unknown id is stale. The main loop counts too (its
 * `turn.complete` can be lost to a reload as well).
 */
export function isStaleLoop(s: Pick<TelemetryState, 'agents' | 'tools'>, id: string, now: number): boolean {
  const agent = s.agents.byId[id]
  if (!agent) return true
  if (now - agent.lastActiveAt <= STALE_AFTER_MS) return false
  return !hasLiveTool(s, id, now)
}

/**
 * Settles every stale loop: a running subagent goes `unknown` (its `endedAt`
 * stays null, so a later step of its own revives it), and its open turn is
 * forgotten; a stale open main turn is closed as idle. Run on hydration (a
 * reload), at session start and at the end of a main turn, so what is stored
 * matches what is drawn.
 */
export function expireStaleAgents(s: TelemetryState, now: number): StateKey[] {
  const dirty = new Set<StateKey>()
  for (const id of s.agents.order) {
    const agent = s.agents.byId[id]
    if (!agent) continue
    const open = s.meta.activeTurns[id] !== undefined
    if (agent.status !== 'running' && !open) continue
    if (!isStaleLoop(s, id, now)) continue
    if (id === MAIN) {
      if (agent.status === 'running') agent.status = 'idle'
    } else if (agent.status === 'running') agent.status = 'unknown'
    dirty.add('agents')
    if (open) {
      delete s.meta.activeTurns[id]
      s.meta.updatedAt = now
      dirty.add('meta')
    }
  }
  return [...dirty]
}

/** What the engine's agent list says, then the stale sweep: the reconciliation run at session start and after a main turn. */
export function reconcileAgents(s: TelemetryState, list: readonly AgentListEntry[] | null, now: number): StateKey[] {
  const keys = new Set<StateKey>(list === null ? [] : recordAgentList(s, list, now))
  for (const key of expireStaleAgents(s, now)) keys.add(key)
  return [...keys]
}

/** Whether a loop is worth a row of its own: it was spawned under this mod's eyes, or it reported usage or tool calls. */
export const isUnattributed = (agent: TelemetryAgent): boolean =>
  agent.id !== MAIN && agent.kind === 'unknown' && !(agent.spawnedAt !== null && agent.spawnedAt > 0) && agent.usage.requests === 0 && agent.toolCalls === 0

// ---------------------------------------------------------------- context

export type MeasureInput = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
  changed: readonly string[]
}

export function recordMeasure(s: TelemetryState, i: MeasureInput, now: number): StateKey[] {
  const c = s.context
  c.updatedAt = now
  c.window = i.context.window
  c.tokens = i.context.tokens ?? null
  c.percent = i.context.percent ?? null
  c.rateLimits = i.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt ?? null }))
  if (i.cost) c.engineCostUsd = i.cost.usd
  if (i.changed.includes('context') && c.tokens !== null) {
    const last = c.history[c.history.length - 1]
    const turn = s.meta.mainTurns
    if (last && last.turn === turn) {
      last.at = now
      last.tokens = c.tokens
      last.percent = c.percent
      last.window = i.context.window
    } else {
      pushRing(c.history, { at: now, turn, tokens: c.tokens, percent: c.percent, window: i.context.window }, LIMITS.contextHistory)
    }
  }
  return ['context']
}

/** The engine's SessionContextBreakdown, as far as this mod reads it. */
export type BreakdownInput = {
  categories: readonly { name: string; tokens: number; kind: string; color: string; isDeferred: boolean }[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens?: number
  percentage: number
  autocompactSource: string
  model: string
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  mcpTools: readonly { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: readonly { agentType: string; source: string; tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter?: readonly { name: string; source: string; pluginName?: string; tokens: number }[]
  }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  apiUsage: Partial<ApiUsage> | null
}

const KINDS = new Set(['used', 'free', 'buffer', 'deferred'])

export function recordBreakdown(s: TelemetryState, b: BreakdownInput, detail: 'summary' | 'full', now: number): StateKey[] {
  const servers = new Map<string, TelemetryMcpServerContext>()
  const details = new Map<string, TelemetryMcpServerDetail>()
  for (const tool of b.mcpTools) {
    const entry = servers.get(tool.serverName) ?? { server: tool.serverName, tools: 0, loadedTools: 0, tokens: 0 }
    entry.tools += 1
    if (tool.isLoaded) entry.loadedTools += 1
    entry.tokens += tool.tokens
    servers.set(tool.serverName, entry)
    const detail = details.get(tool.serverName) ?? { server: tool.serverName, loadedTokens: 0, wirePrefixes: [] }
    if (tool.isLoaded) detail.loadedTokens += tool.tokens
    const prefix = mcpServerOf(tool.name)
    if (prefix !== null && !detail.wirePrefixes.includes(prefix)) detail.wirePrefixes.push(prefix)
    details.set(tool.serverName, detail)
  }
  const breakdown: TelemetryContextBreakdown = {
    at: now,
    detail,
    model: b.model,
    totalTokens: b.totalTokens,
    maxTokens: b.rawMaxTokens ?? b.maxTokens,
    percentage: b.percentage,
    autoCompactThreshold: b.autoCompactThreshold ?? null,
    isAutoCompactEnabled: b.isAutoCompactEnabled,
    autocompactSource: b.autocompactSource,
    categories: b.categories.map(c => ({
      name: c.name,
      tokens: c.tokens,
      kind: (KINDS.has(c.kind) ? c.kind : 'used') as 'used' | 'free' | 'buffer' | 'deferred',
      color: c.color,
      isDeferred: c.isDeferred,
    })),
    memoryFiles: [...b.memoryFiles]
      .sort((a, z) => z.tokens - a.tokens)
      .slice(0, LIMITS.memoryFiles)
      .map(f => ({ path: f.path, type: f.type, tokens: f.tokens })),
    mcpServers: [...servers.values()].sort((a, z) => z.tokens - a.tokens),
    customAgents: b.agents.map(a => ({ agentType: a.agentType, source: a.source, tokens: a.tokens })),
    skills: b.skills ? { total: b.skills.totalSkills, included: b.skills.includedSkills, tokens: b.skills.tokens } : null,
    slashCommands: b.slashCommands
      ? { total: b.slashCommands.totalCommands, included: b.slashCommands.includedCommands, tokens: b.slashCommands.tokens }
      : null,
    apiUsage: b.apiUsage ? countsOf(b.apiUsage) : null,
    mcpServerDetail: [...details.values()],
    skillRows: [...(b.skills?.skillFrontmatter ?? [])]
      .sort((a, z) => z.tokens - a.tokens)
      .slice(0, LIMITS.skillRows)
      .map(k => ({ name: k.name, source: String(k.source), pluginName: k.pluginName ?? null, tokens: k.tokens })),
  }
  s.context.breakdown = breakdown
  s.context.breakdownError = null
  if (detail === 'full') s.context.lastFullAt = now
  return ['context']
}

export function recordBreakdownError(s: TelemetryState, message: string): StateKey[] {
  s.context.breakdownError = clip(message, 200)
  return ['context']
}

export type CompactionInput = {
  trigger: string
  agentId?: string
  tokensBefore?: number
  tokensAfter?: number
  usage?: Partial<ApiUsage> | null
  skip?: string
}

export function recordCompaction(s: TelemetryState, i: CompactionInput, now: number): StateKey[] {
  const usage = i.usage ? countsOf(i.usage) : null
  const model = s.meta.mainModel
  pushRing(
    s.context.compactions,
    {
      at: now,
      trigger: i.trigger,
      agentId: agentKey(i.agentId),
      tokensBefore: i.tokensBefore ?? null,
      tokensAfter: i.tokensAfter ?? null,
      usage,
      costUsd: usage && model ? costOf(usage, model, s.meta.cacheTtl).usd : null,
      skipped: i.skip ?? null,
    },
    LIMITS.compactions,
  )
  return ['context']
}

export type ModelSwitchInput = {
  from: string | null
  to: string
  source: string
  contextTokens?: number
  cacheTtl?: string
  estimatedCacheWriteUsd?: number
  pricing?: string
}

export function recordModelSwitch(s: TelemetryState, i: ModelSwitchInput, now: number): StateKey[] {
  const meta = s.meta
  pushRing(
    meta.modelSwitches,
    {
      at: now,
      from: i.from,
      to: i.to,
      source: i.source,
      contextTokens: i.contextTokens ?? null,
      estimatedCacheWriteUsd: i.estimatedCacheWriteUsd ?? null,
      pricing: i.pricing ?? null,
    },
    LIMITS.modelSwitches,
  )
  meta.mainModel = i.to
  meta.mainModelFrom = 'switch'
  if (i.cacheTtl === '5m' || i.cacheTtl === '1h') meta.cacheTtl = i.cacheTtl
  if (i.pricing) meta.enginePricing = i.pricing
  meta.updatedAt = now
  return ['meta']
}
