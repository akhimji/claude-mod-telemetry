// session-telemetry: collection, written against a small IO interface rather than
// `$`, so it is testable with a fake one (state.ts's `ioOf($)` builds the real one
// and register.tsx hands it here). It keeps
// the TelemetryState in memory (read back from `$.state` the first time after a
// reload), runs the reducers of model.ts on each event, and writes back only the
// atoms they changed, coalescing bursts. Nothing here calls `next`; every handler
// runs inside `guard`, so a failure is logged to the debug log and goes no further.
// Unit-tested with a fake IO in tests/collect.test.ts.
//
// Exports:
//   TelemetryIO                    what register.tsx's ioOf($) provides
//   guard(io, name, fn)            runs fn; a failure is logged once per name per load
//   onSessionStart, onSessionEnd, onTurnStart, onStep, onTurnComplete,
//   onToolStart, onToolEnd, onAgentToolEnd, onToolExec, onAgentSpawn,
//   onCompact, onMeasure, onModelSwitch      the event handlers
//   refreshContext(io, detail)     recompute the context breakdown ('summary' is free;
//                                  'full' sends one token-count request per tool and memory file)
//   FULL_BREAKDOWN_EVERY_MS        how often a turn end may ask for a 'full' breakdown
//   configure(options)             the alert rules from the manifest's userConfig (register's `options`)
//   evaluateAlerts(io)             the alert engine: fires new alerts once, toasts, the status line,
//                                  and arms the next time-driven check (run after steps, turn ends,
//                                  measures, session start, and on its own timer)
//   currentRules(), peekAlerts()   the rules in force; the alert memory held without an atom (tests)
//   peek()                         the in-memory state (tests and debugging)
//   resetForTests()                forget everything held in memory

import type {
  AgentSpawnInput,
  AgentSpawnResult,
  Frozen,
  SessionCompactInput,
  SessionCompactResult,
  SessionEndInput,
  SessionMeasureInput,
  SessionStartInput,
  ToolCallInput,
  ToolCallResult,
  TurnCompleteInput,
  TurnStartInput,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { TelemetryAlerts, TelemetryState } from '../types'

import { alertsOrEmpty, DEFAULT_ALERT_RULES, deriveAlerts, deriveBand, emptyAlerts, formatStatusLine, nextAlertCheckAt, rulesFromOptions, stepAlerts, type TelemetryAlertRules } from './insights'
import * as M from './model'

/** What collection needs from the engine; state.ts's `ioOf($)` builds it from `$`. */
export type TelemetryIO = {
  now: () => Promise<number>
  /** Every atom, as `read` answers them (initial values where nothing is written). */
  readState: () => Promise<TelemetryState>
  /** Writes one atom of `s` under the shape tag. */
  writeState: (key: M.StateKey, s: TelemetryState) => Promise<unknown>
  /** A line to the debug log. */
  log: (text: string) => void
  sessionId: () => Promise<string>
  sessionStartedAt: () => Promise<number>
  sessionModel: () => Promise<string>
  sessionCwd: () => Promise<string>
  /** The settings' `modelPricing` value, whatever its shape; undefined when unset. */
  managedPricing: () => Promise<unknown>
  /** `$.session.usage({ breakdown })`'s breakdown; undefined when the engine computed none. */
  breakdown: (detail: 'summary' | 'full') => Promise<M.BreakdownInput | undefined>
  agentList: () => Promise<readonly M.AgentListEntry[]>
  /** Runs fn after ms, off the current dispatch. */
  after: (ms: number, fn: () => void) => void
  /** The alert engine's atom; without it the engine keeps its memory in the module (tests). */
  readAlerts?: () => Promise<TelemetryAlerts>
  /** Read-modify-write of the alert atom (retried on a concurrent write, so the view's acks are kept). */
  updateAlerts?: (fn: (value: TelemetryAlerts) => TelemetryAlerts) => Promise<TelemetryAlerts>
  /** `$.ui.toast(text)`. */
  toast?: (text: string) => void
  /** `$.ui.status(text)`: this plugin's one status line; undefined clears it. */
  status?: (text: string | undefined) => void
}

/** A turn end asks for a 'full' breakdown at most this often (the first one included). */
export const FULL_BREAKDOWN_EVERY_MS = 30 * 60_000

let mem: TelemetryState | null = null
let hydrating: Promise<TelemetryState> | null = null
let sessionInfoTried = false
let sweptOnLoad = false
const pending = new Set<M.StateKey>()
let flushing: Promise<void> | null = null
let refreshing: Promise<void> | null = null
const enrichTried = new Set<string>()
const reported = new Set<string>()

// the alert engine (per load: its memory proper is the `alerts` atom)
let rules: TelemetryAlertRules = DEFAULT_ALERT_RULES
let localAlerts: TelemetryAlerts | null = null
let evaluating: Promise<void> | null = null
let evalAgain = false
let tickDueAt: number | null = null
let statusText: string | null = null
let statusAt = 0
let statusCleared = false

/** The alert rules from the manifest's `userConfig` values, as `register(on, options)` receives them. */
export function configure(options: Readonly<Record<string, unknown>> | null | undefined): void {
  rules = rulesFromOptions(options)
}

export const currentRules = (): TelemetryAlertRules => rules

/** The state held in memory, or null before the first event of this load. */
export const peek = (): TelemetryState | null => mem

export function resetForTests(): void {
  mem = null
  hydrating = null
  sessionInfoTried = false
  sweptOnLoad = false
  pending.clear()
  flushing = null
  refreshing = null
  enrichTried.clear()
  reported.clear()
  rules = DEFAULT_ALERT_RULES
  localAlerts = null
  evaluating = null
  evalAgain = false
  tickDueAt = null
  statusText = null
  statusAt = 0
  statusCleared = false
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const message = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/** Runs `fn`; a failure goes to the debug log (once per name per load) and no further. */
export async function guard(io: TelemetryIO, name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (reported.has(name)) return
    reported.add(name)
    try {
      io.log(`session-telemetry: ${name} failed (${message(err)}); telemetry skipped it`)
    } catch {
      // nothing more to do
    }
  }
}

// ---------------------------------------------------------------- state

async function hydrate(io: TelemetryIO): Promise<TelemetryState> {
  const at = (await attempt(io.now)) ?? 0
  try {
    const state = clone(await io.readState())
    const main = state.agents?.byId?.[M.MAIN]
    if (!main || state.meta?.schema !== 1) return M.emptyState(at)
    // the atoms' initial value is built at time 0: anything still at 0 was never seen, so it is seen now
    if (!(state.meta.firstSeenAt > 0)) state.meta.firstSeenAt = at
    if (!(main.firstSeenAt > 0)) main.firstSeenAt = at
    if (!(main.lastActiveAt > 0)) main.lastActiveAt = at
    return state
  } catch {
    return M.emptyState(at)
  }
}

/** The in-memory state, read back from `$.state` the first time after a (re)load. */
async function load(io: TelemetryIO): Promise<TelemetryState> {
  if (!mem) {
    hydrating ??= hydrate(io).then(
      state => {
        mem ??= state
        hydrating = null
        return mem
      },
      (err: unknown) => {
        hydrating = null // the next event tries again
        throw err
      },
    )
    await hydrating
  }
  const state = mem as TelemetryState
  if (!sweptOnLoad) {
    sweptOnLoad = true
    // a (re)load: loops whose end was lost while the module was down are settled, not left running
    const keys = M.expireStaleAgents(state, await io.now())
    if (keys.length > 0) commit(io, keys).catch(() => undefined)
  }
  if (!sessionInfoTried) {
    sessionInfoTried = true
    // best effort: the event that brought us here is recorded either way
    await fillSessionInfo(io, state, {}).catch(() => undefined)
  }
  return state
}

/** The engine's agent list against the running loops, then the stale sweep (session start, the end of a main turn). */
async function reconcile(io: TelemetryIO, s: TelemetryState): Promise<void> {
  const list = (await attempt(io.agentList)) ?? null
  await commit(io, M.reconcileAgents(s, list, await io.now()))
}

/**
 * Writes the changed atoms. A call made while a write is in flight joins it: the
 * loop picks its keys up and every caller resolves once all are written, so a
 * burst of events costs one write per atom per round, each with the latest value.
 */
function commit(io: TelemetryIO, keys: readonly M.StateKey[]): Promise<void> {
  for (const key of keys) pending.add(key)
  if (pending.size === 0) return flushing ?? Promise.resolve()
  flushing ??= (async () => {
    try {
      while (pending.size > 0) {
        const batch = [...pending]
        pending.clear()
        const s = mem
        if (!s) return
        try {
          await Promise.all(batch.map(key => io.writeState(key, s)))
        } catch (err) {
          // keep them dirty: the next commit writes them again
          for (const key of batch) pending.add(key)
          throw err
        }
      }
    } finally {
      flushing = null
    }
  })()
  return flushing
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

async function fillSessionInfo(io: TelemetryIO, s: TelemetryState, base: M.SessionInfo): Promise<void> {
  const info: M.SessionInfo = { ...base }
  info.sessionId = (await attempt(io.sessionId)) ?? null
  info.startedAt = (await attempt(io.sessionStartedAt)) ?? null
  info.mainModel = (await attempt(io.sessionModel)) ?? null
  const pricing = await attempt(io.managedPricing)
  info.managedPricingSet = pricing !== undefined && pricing !== null
  info.cwd ??= (await attempt(io.sessionCwd)) ?? null
  await commit(io, M.recordSession(s, info, await io.now()))
}

// ---------------------------------------------------------------- session

export async function onSessionStart(io: TelemetryIO, e: Frozen<SessionStartInput>): Promise<void> {
  sessionInfoTried = true
  const s = await load(io)
  await fillSessionInfo(io, s, { cwd: e.cwd, isInteractive: e.isInteractive })
  // also each hot reload: what the engine lists as over is over, and quiet loops are settled
  await reconcile(io, s)
  // each (re)load: the status line is set (or cleared) and the timer re-armed
  await guard(io, 'alerts', () => evaluateAlerts(io))
}

/** /clear and resume go on in this process as another conversation: start over. */
export async function onSessionEnd(io: TelemetryIO, e: Frozen<Pick<SessionEndInput, 'reason'>>): Promise<void> {
  if (e.reason !== 'clear' && e.reason !== 'resume') return
  const prev = mem ?? (await load(io))
  const at = await io.now()
  mem = M.resetState(prev, at)
  sessionInfoTried = false
  enrichTried.clear()
  await commit(io, M.STATE_KEYS)
  // the alerts start over with the telemetry
  await guard(io, 'alerts reset', async () => {
    localAlerts = null
    statusText = null
    if (io.updateAlerts) await io.updateAlerts(() => emptyAlerts(at))
  })
}

// ---------------------------------------------------------------- turns and steps

export async function onTurnStart(io: TelemetryIO, e: Frozen<TurnStartInput>): Promise<void> {
  const s = await load(io)
  await commit(io, M.recordTurnStart(s, { turnId: e.turnId, agentId: e.agentId, text: e.text }, await io.now()))
  // a loop first heard of here (spawned before the mod loaded, or under a hook that could not hear the spawn) gets its kind at once
  await enrich(io, s, e.agentId)
}

export async function onStep(io: TelemetryIO, e: Frozen<TurnStepInput>, r: TurnStepResult, startedAt: number | null): Promise<void> {
  const s = await load(io)
  const endedAt = await io.now()
  const keys = M.recordStep(
    s,
    {
      turnId: e.turnId,
      index: e.index,
      agentId: e.agentId,
      model: e.model,
      effort: e.effort ?? null,
      messageCount: e.messageCount,
      startedAt: startedAt ?? endedAt,
      endedAt,
      usage: r.usage,
      stopReason: r.stopReason,
      toolUses: r.toolUses,
      serverToolUses: r.serverToolUses,
    },
    endedAt,
  )
  await commit(io, keys)
  await enrich(io, s, e.agentId)
  await guard(io, 'alerts', () => evaluateAlerts(io))
}

export async function onTurnComplete(io: TelemetryIO, e: Frozen<TurnCompleteInput>): Promise<void> {
  const s = await load(io)
  await commit(
    io,
    M.recordTurnComplete(
      s,
      { turnId: e.turnId, agentId: e.agentId, durationMs: e.durationMs, reason: e.reason, usage: e.usage ?? null },
      await io.now(),
    ),
  )
  await enrich(io, s, e.agentId)
  // the end of a main turn: a running subagent still on the books is checked against the engine's list
  if (M.agentKey(e.agentId) === M.MAIN && s.agents.order.some(id => id !== M.MAIN && s.agents.byId[id]?.status === 'running')) await reconcile(io, s)
  await guard(io, 'alerts', () => evaluateAlerts(io))
}

/** An agent seen on events but never spawned under this mod's eyes: ask `$.agent.list()` once. */
async function enrich(io: TelemetryIO, s: TelemetryState, agentId: string | undefined): Promise<void> {
  const key = M.agentKey(agentId)
  if (key === M.MAIN || enrichTried.has(key)) return
  const agent = s.agents.byId[key]
  if (!agent || agent.kind !== 'unknown') return
  enrichTried.add(key)
  const list = await io.agentList()
  await commit(io, M.recordAgentList(s, list, await io.now()))
}

// ---------------------------------------------------------------- tools

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

function inputOf(e: Frozen<ToolCallInput>): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) if (!RESERVED.has(key)) input[key] = value
  return input
}

/**
 * Records the call as running. Its write is started, not awaited: the hook goes on
 * to run the tool, and `onToolEnd` waits for both writes.
 */
export async function onToolStart(io: TelemetryIO, e: Frozen<ToolCallInput>): Promise<void> {
  const s = await load(io)
  const keys = M.recordToolStart(s, { id: e.tool_use_id, tool: String(e.tool), agentId: e.agentId, input: inputOf(e) }, await io.now())
  commit(io, keys).catch(() => undefined)
}

function endInput(e: Frozen<ToolCallInput>, ran: ToolCallResult | undefined): M.ToolEndInput {
  if (ran === undefined) return { id: e.tool_use_id, tool: String(e.tool), agentId: e.agentId, threw: true }
  return {
    id: e.tool_use_id,
    tool: String(e.tool),
    agentId: e.agentId,
    deny: ran.deny,
    isError: ran.isError === true,
    text: ran.text,
    isReadOnly: ran.isReadOnly === true,
  }
}

/** `ran` is what the chain answered; undefined when it rejected. */
export async function onToolEnd(io: TelemetryIO, e: Frozen<ToolCallInput>, ran: ToolCallResult | undefined): Promise<void> {
  const s = await load(io)
  const at = await io.now()
  const keys = M.recordToolEnd(s, endInput(e, ran), at)
  keys.push(...planKeys(s, e, ran, at))
  await commit(io, keys)
}

/** An answered call of a plan tool (savvy-progress, TodoWrite, Task*) sets its loop's plan; a refused, failed or thrown one does not. */
function planKeys(s: TelemetryState, e: Frozen<ToolCallInput>, ran: ToolCallResult | undefined, at: number): M.StateKey[] {
  const tool = String(e.tool)
  if (!M.PLAN_TOOLS.has(tool) || ran === undefined || ran.deny !== undefined || ran.isError === true) return []
  try {
    return M.recordPlan(s, { agentId: e.agentId, tool, input: inputOf(e), result: ran.result }, at)
  } catch {
    return []
  }
}

/** As onToolEnd; a completed foreground Agent call's report also goes on the agent it ran. */
export async function onAgentToolEnd(io: TelemetryIO, e: Frozen<ToolCallInput>, ran: ToolCallResult | undefined): Promise<void> {
  const s = await load(io)
  const at = await io.now()
  const keys = M.recordToolEnd(s, endInput(e, ran), at)
  if (ran !== undefined && ran.deny === undefined && ran.isError !== true) {
    const hint = Object.values(s.agents.byId).find(agent => agent.toolUseId === e.tool_use_id)?.id ?? null
    keys.push(...M.recordAgentReport(s, hint, ran.result, at))
  }
  await commit(io, keys)
}

/** The engine's execution time for a call (classic PostToolUse / PostToolUseFailure). */
export async function onToolExec(io: TelemetryIO, e: { tool_use_id: string; duration_ms?: number; is_interrupt?: boolean }): Promise<void> {
  const s = await load(io)
  await commit(io, M.recordToolExec(s, { id: e.tool_use_id, durationMs: e.duration_ms, isInterrupt: e.is_interrupt === true }, await io.now()))
}

// ---------------------------------------------------------------- agents

export async function onAgentSpawn(io: TelemetryIO, e: Frozen<AgentSpawnInput>, r: AgentSpawnResult): Promise<void> {
  if (r.deny !== undefined || !r.agentId || e.resume) return
  const s = await load(io)
  await commit(
    io,
    M.recordAgentSpawn(
      s,
      {
        agentId: r.agentId,
        subagentType: e.subagentType,
        description: e.description,
        name: e.name,
        parentAgentId: e.parentAgentId,
        model: r.model,
        requestedModel: e.model,
        background: e.background,
        fork: e.fork,
        isTeammate: e.isTeammate === true,
        isWorkflow: e.workflow !== undefined,
        toolUseId: e.tool_use_id,
      },
      await io.now(),
    ),
  )
}

// ---------------------------------------------------------------- context

export async function onCompact(io: TelemetryIO, e: Frozen<SessionCompactInput>, r: SessionCompactResult): Promise<void> {
  const s = await load(io)
  await commit(
    io,
    M.recordCompaction(
      s,
      {
        trigger: e.trigger,
        agentId: e.agentId,
        tokensBefore: r.skip === undefined ? r.tokensBefore : undefined,
        tokensAfter: r.skip === undefined ? r.tokensAfter : undefined,
        usage: r.skip === undefined ? r.usage : undefined,
        skip: r.skip,
      },
      await io.now(),
    ),
  )
}

/**
 * The engine's figures after each main-thread turn. The breakdown is computed
 * off this dispatch, on a timer, so a slow 'full' count never holds the session.
 */
export async function onMeasure(io: TelemetryIO, e: Frozen<SessionMeasureInput>): Promise<void> {
  const s = await load(io)
  await commit(io, M.recordMeasure(s, e, await io.now()))
  if (e.changed.includes('context')) {
    io.after(0, () => {
      void guard(io, 'context breakdown', () => refreshContext(io, 'auto'))
    })
  }
  await guard(io, 'alerts', () => evaluateAlerts(io))
}

/**
 * Recomputes the context breakdown. `auto` asks for 'full' when none was taken in
 * FULL_BREAKDOWN_EVERY_MS, else 'summary'. One runs at a time; a call made
 * meanwhile joins it.
 */
export function refreshContext(io: TelemetryIO, detail: 'auto' | 'summary' | 'full' = 'summary'): Promise<void> {
  refreshing ??= (async () => {
    try {
      const s = await load(io)
      const at = await io.now()
      const last = s.context.lastFullAt
      const chosen = detail === 'auto' ? (last === null || at - last >= FULL_BREAKDOWN_EVERY_MS ? 'full' : 'summary') : detail
      let keys: M.StateKey[]
      try {
        const breakdown = await io.breakdown(chosen)
        keys = breakdown
          ? M.recordBreakdown(s, breakdown, chosen, await io.now())
          : M.recordBreakdownError(s, 'the engine computed no breakdown (no session bound yet)')
      } catch (err) {
        keys = M.recordBreakdownError(s, message(err))
      }
      await commit(io, keys)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export async function onModelSwitch(
  io: TelemetryIO,
  e: {
    from_model: string
    to_model: string
    source: string
    context_tokens?: number
    cache_ttl?: string
    estimated_cache_write_usd?: number
    pricing?: string
  },
): Promise<void> {
  const s = await load(io)
  await commit(
    io,
    M.recordModelSwitch(
      s,
      {
        from: e.from_model,
        to: e.to_model,
        source: e.source,
        contextTokens: e.context_tokens,
        cacheTtl: e.cache_ttl,
        estimatedCacheWriteUsd: e.estimated_cache_write_usd,
        pricing: e.pricing,
      },
      await io.now(),
    ),
  )
}

// ---------------------------------------------------------------- alerts

/** No timer sooner than this, or later than CHECK_MAX_MS, after a check. */
const CHECK_MIN_MS = 1_000
const CHECK_MAX_MS = 60_000

/**
 * The alert engine, one pass: the conditions active now (insights.ts
 * `deriveAlerts`), the engine's memory one step on (`stepAlerts`: fire once,
 * re-arm, cooldown, toast rate), written back to the `alerts` atom only when
 * it changed; a toast for what fired and is toasted in the mode; the status
 * line (when on) rewritten only when its text changed and no sooner than
 * `statusEveryMs`; and one timer armed for the next time-driven change. One
 * pass runs at a time; a call made meanwhile runs one more pass after it.
 * Callers run it inside `guard`: a failure never reaches the session.
 */
export function evaluateAlerts(io: TelemetryIO): Promise<void> {
  if (evaluating) {
    evalAgain = true
    return evaluating
  }
  evaluating = (async () => {
    try {
      do {
        evalAgain = false
        await evaluateOnce(io)
      } while (evalAgain)
    } finally {
      evaluating = null
    }
  })()
  return evaluating
}

async function evaluateOnce(io: TelemetryIO): Promise<void> {
  const s = await load(io)
  const now = await io.now()
  const r = rules
  const stored = alertsOrEmpty(io.readAlerts ? await io.readAlerts() : localAlerts, now)
  const active = deriveAlerts({ ...s, alerts: stored }, now, r).active
  const first = stepAlerts(stored, active, now, r)
  let current = stored
  let toasts: string[] = []
  if (first.changed) {
    if (io.updateAlerts) {
      // applied to the value as it is now: an ack the view wrote meanwhile is kept
      current = await io.updateAlerts(value => {
        const step = stepAlerts(alertsOrEmpty(value, now), active, now, r)
        toasts = step.toasts
        return step.next
      })
    } else {
      localAlerts = first.next
      current = first.next
      toasts = first.toasts
    }
  }
  for (const text of toasts) io.toast?.(text)

  let due = nextAlertCheckAt({ ...s, alerts: current }, now, r)
  if (!r.statusLine) {
    // once per load: a line left by an earlier load (the option was on) goes
    if (!statusCleared) {
      statusCleared = true
      io.status?.(undefined)
    }
  } else {
    const text = formatStatusLine(deriveBand({ ...s, alerts: current }, now, { rules: r }))
    if (text !== statusText) {
      if (statusText === null || now - statusAt >= r.statusEveryMs) {
        io.status?.(text)
        statusText = text
        statusAt = now
      } else {
        const later = statusAt + r.statusEveryMs
        due = due === null ? later : Math.min(due, later)
      }
    }
  }
  armCheck(io, now, due)
}

/** One timer for the next check; a pending one due at or before it already covers it. */
function armCheck(io: TelemetryIO, now: number, due: number | null): void {
  if (due === null) return
  const at = now + Math.min(CHECK_MAX_MS, Math.max(CHECK_MIN_MS, due - now))
  if (tickDueAt !== null && tickDueAt > now && tickDueAt <= at) return
  tickDueAt = at
  io.after(at - now, () => {
    if (tickDueAt === at) tickDueAt = null
    void guard(io, 'alerts tick', () => evaluateAlerts(io))
  })
}

/** The alert memory held in the module when the IO has no atom (tests). */
export const peekAlerts = (): TelemetryAlerts | null => localAlerts
