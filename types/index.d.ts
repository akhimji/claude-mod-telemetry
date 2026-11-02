// session-telemetry: the contract of the values this mod keeps in `$.state`.
//
// Every key below lives under the plugin `session-telemetry` and is kept as a
// `Shaped<T>` (tag "v1"): read it through the atoms in hooks/atoms.ts with
// `read($, atoms.totals)` and the like, which unwrap the tag and answer the
// initial value while nothing is written. A raw `$.state.get` answers
// `{ shape, value }`. Only this mod writes these values.
//
// Self-contained on purpose (no import, no reference): the engine lays this
// file into a dependent mod's types folder as it is.
//
// Units: tokens are counts, money is US dollars, times are `$.clock.now()`
// milliseconds since the epoch, durations are milliseconds. `agentId` is the
// engine's agent id, or "main" for the main loop.

/** How a model id was priced: its own row, its family's newest row, or the default row. */
export type TelemetryPricingMatch = 'exact' | 'family' | 'default'

/** The four token counts the API reports for one or more requests. */
export type TelemetryTokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Running token and cost totals for any slice (session, model, agent, turn). */
export type TelemetryUsage = TelemetryTokenCounts & {
  /** API responses counted. */
  requests: number
  /** Estimated cost from the pricing table (hooks/pricing.ts). */
  costUsd: number
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  /**
   * Net estimate of what prompt caching saved: cache reads priced as uncached
   * input minus their read price, less the premium paid on cache writes.
   */
  cacheSavedUsd: number
}

/** Totals for one model id as the API reported it. */
export type TelemetryModelTotals = TelemetryUsage & {
  model: string
  /** Display name of the pricing row it matched ("Claude Opus 5.5"). */
  label: string
  /** fable, mythos, opus, sonnet, haiku, or "unknown". */
  family: string
  pricing: TelemetryPricingMatch
  lastAt: number
}

/** Aggregates for one tool name over the whole session (survive ring eviction). */
export type TelemetryToolStats = {
  tool: string
  /** The MCP server for an `mcp__<server>__<tool>` name; null otherwise. */
  server: string | null
  /** True for a tool the API ran inside a request (the advisor), seen on steps only. */
  isServerTool: boolean
  calls: number
  ok: number
  errors: number
  denied: number
  interrupted: number
  /** Calls started and not yet answered. */
  running: number
  /** Wall time around the engine's tool chain (permission prompts included). */
  wallMsTotal: number
  wallMsMax: number
  /** Execution time the engine reported (PostToolUse `duration_ms`), when it did. */
  execMsTotal: number
  execCount: number
  /** Size of results as the model read them (text), in characters and UTF-8 bytes. */
  resultChars: number
  resultBytes: number
  lastAt: number
}

/** Calls of one skill through the Skill tool (its `skill` argument), over the whole session. */
export type TelemetrySkillStats = {
  calls: number
  lastAt: number
}

export type TelemetryTotals = {
  session: TelemetryUsage
  byModel: Record<string, TelemetryModelTotals>
  byTool: Record<string, TelemetryToolStats>
  /**
   * Skill name (as the Skill tool's `skill` argument spells it) to its calls;
   * at most 200 names. Added later: absent in values stored before, read as `{}`.
   * Skills a person runs as a slash command do not pass the Skill tool and are not counted.
   */
  bySkill?: Record<string, TelemetrySkillStats>
  steps: number
  toolCalls: number
  toolErrors: number
  serverToolCalls: number
  firstStepAt: number | null
  lastStepAt: number | null
  /** Records that fell off the ring buffers (their totals are still counted here). */
  evictedSteps: number
  evictedToolEvents: number
  evictedTurns: number
}

export type TelemetryAgentKind = 'main' | 'subagent' | 'teammate' | 'fork' | 'workflow' | 'unknown'

export type TelemetryAgentStatus =
  | 'running'
  | 'idle'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'refused'
  | 'unknown'

/** What a completed foreground Agent tool call reported about its run. */
export type TelemetryAgentReport = {
  status: string
  totalTokens: number
  totalDurationMs: number
  totalToolUseCount: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The 5-minute / 1-hour split of cache writes: observable only here. */
  cacheWrite5m: number | null
  cacheWrite1h: number | null
  modelsUsed: string[]
}

/** Per-model slice of one agent's usage (for the data-flow view). */
export type TelemetryAgentModelSlice = {
  requests: number
  tokens: number
  costUsd: number
}

/** One agent loop: the main loop ("main") or one subagent / teammate / fork run. */
export type TelemetryAgent = {
  id: string
  kind: TelemetryAgentKind
  /** Agent type (`general-purpose`, `Explore`, a plugin's), "main" for the main loop. */
  type: string
  /** The Agent call's short description; "" when unknown. */
  description: string
  /** SendMessage name, when it has one. */
  name: string | null
  /** The spawning loop: "main", another agent's id, or null for the main loop itself. */
  parentId: string | null
  /** The Agent tool call that started it. */
  toolUseId: string | null
  /** Latest model it ran on; `models` lists every one it used. */
  model: string | null
  models: string[]
  /** The Agent call's `model` parameter as given (alias or id). */
  requestedModel: string | null
  isBackground: boolean
  status: TelemetryAgentStatus
  firstSeenAt: number
  spawnedAt: number | null
  lastActiveAt: number
  endedAt: number | null
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  usage: TelemetryUsage
  byModel: Record<string, TelemetryAgentModelSlice>
  /** Tool name to call count. */
  byTool: Record<string, number>
  /** Prompt size of its latest request (input + cache read + cache write). */
  lastContextTokens: number
  peakContextTokens: number
  /** Sum of its turns' durations. */
  activeMs: number
  report: TelemetryAgentReport | null
  /**
   * The loop's own task list as it last reported it (savvy-progress `step` /
   * `progress`, TodoWrite, the Task* tools), latest call wins. Added later:
   * absent in values stored before, read as no plan.
   */
  plan?: TelemetryAgentPlan | null
}

/** Where a loop's plan came from: savvy-progress `step` (workers) or `progress` (main only), TodoWrite, or the Task* tools. */
export type TelemetryAgentPlanSource = 'step' | 'todos' | 'progress' | 'tasks'

export type TelemetryAgentPlanItemStatus = 'pending' | 'active' | 'done'

/** One entry of a loop's task list: the text the model wrote (redacted, at most 80 characters). */
export type TelemetryAgentPlanItem = {
  text: string
  status: TelemetryAgentPlanItemStatus
  /** The Task* tools' task id (absent for todos and progress tasks). */
  id?: string
}

/**
 * A loop's plan: how far through its task list it is. Only text the model
 * wrote as a title or a note (todo content, a task subject, a step note), run
 * through the redaction in hooks/model.ts and cut at 80 characters; never a
 * command, a tool's output, or a task's description.
 */
export type TelemetryAgentPlan = {
  source: TelemetryAgentPlanSource
  /** Items finished. */
  done: number
  /** Items planned (at least `done` when shown). */
  total: number
  /** The item in progress (or the step's note), at most 80 characters. */
  current?: string
  /** At most 30, in the list's order (a window around the active one when the list is longer). */
  items?: TelemetryAgentPlanItem[]
  /** progress only: the savvy-flow title and phase, kept so a partial update can merge. */
  title?: string
  phase?: string
  updatedAt: number
}

export type TelemetryAgents = {
  byId: Record<string, TelemetryAgent>
  /** Ids in the order first seen; "main" first. */
  order: string[]
  evicted: number
}

/** One model request (a `turn.step`). Ring buffer, newest last. */
export type TelemetryStep = {
  turnId: string
  index: number
  agentId: string
  /** The model that answered (API id), else the one requested. */
  model: string
  effort: string | null
  startedAt: number
  endedAt: number
  durationMs: number
  messageCount: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Prompt size: input + cache read + cache write. */
  contextTokens: number
  costUsd: number
  pricing: TelemetryPricingMatch
  stopReason: string | null
  toolUses: number
  /** Up to 10 tool names the response asked for. */
  toolNames: string[]
  serverToolUses: number
  /** False when the response carried no usage (aborted or failed request). */
  hasUsage: boolean
}

export type TelemetryToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'interrupted'

/** One tool call. Ring buffer, newest last. */
export type TelemetryToolEvent = {
  id: string
  tool: string
  server: string | null
  agentId: string
  turnId: string | null
  /** A short hint from the input (command, path, pattern, url), at most 80 characters. */
  label: string | null
  startedAt: number
  endedAt: number | null
  wallMs: number | null
  execMs: number | null
  status: TelemetryToolStatus
  resultChars: number | null
  resultBytes: number | null
  isReadOnly: boolean
  isServerTool: boolean
  /** The first 160 characters of an error or deny text. */
  error: string | null
}

/** One turn of a loop (main or agent). Ring buffer, newest last. */
export type TelemetryTurn = {
  turnId: string
  agentId: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  /** answer, aborted, refusal, error; null while it runs. */
  reason: string | null
  promptChars: number
  steps: number
  toolCalls: number
  usage: TelemetryUsage
  /** `turn.complete`'s own summed usage, kept as a cross-check. */
  engineUsage: (TelemetryTokenCounts & { model: string }) | null
  /** Prompt size of the turn's last request. */
  contextTokensEnd: number
  model: string | null
}

export type TelemetryContextCategory = {
  name: string
  tokens: number
  /** used, free, buffer (autocompact reserve), deferred (outside the window). */
  kind: 'used' | 'free' | 'buffer' | 'deferred'
  /** The theme key /context draws the row in. */
  color: string
  isDeferred: boolean
}

export type TelemetryMcpServerContext = {
  server: string
  tools: number
  loadedTools: number
  tokens: number
}

/** The context window broken down as /context does, condensed (no grid). */
export type TelemetryContextBreakdown = {
  at: number
  detail: 'summary' | 'full'
  model: string
  totalTokens: number
  /** The window measured against (may be a compaction window smaller than the model's). */
  maxTokens: number
  /** totalTokens over maxTokens, 0 to 100 (past 100 when over). */
  percentage: number
  autoCompactThreshold: number | null
  isAutoCompactEnabled: boolean
  autocompactSource: string
  categories: TelemetryContextCategory[]
  /** Up to 50, largest first. */
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpServers: TelemetryMcpServerContext[]
  customAgents: { agentType: string; source: string; tokens: number }[]
  skills: { total: number; included: number; tokens: number } | null
  slashCommands: { total: number; included: number; tokens: number } | null
  apiUsage: TelemetryTokenCounts | null
  /**
   * Per MCP server: the tokens of its schemas inside the window (`isLoaded`;
   * the rest are deferred, outside it) and the server segment of its tools'
   * wire names (`mcp__<segment>__tool`), which is how tool calls name it.
   * Added later: absent in breakdowns stored before.
   */
  mcpServerDetail?: TelemetryMcpServerDetail[]
  /** One row per listed skill, largest first, at most 100. Added later: absent in breakdowns stored before. */
  skillRows?: TelemetrySkillContext[]
}

export type TelemetryMcpServerDetail = {
  server: string
  loadedTokens: number
  wirePrefixes: string[]
}

export type TelemetrySkillContext = {
  name: string
  /** Where it came from, by the engine's word (`userSettings`, `plugin`, `built-in`, ...). */
  source: string
  pluginName: string | null
  tokens: number
}

/** One reading of the main window's fill, taken after each main-thread turn. */
export type TelemetryContextPoint = {
  at: number
  /** Main-loop turns started so far when it was taken. */
  turn: number
  tokens: number
  /** 0 to 100, as the status line has it. */
  percent: number | null
  window: number
}

export type TelemetryRateLimit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

export type TelemetryCompaction = {
  at: number
  /** manual, auto, plugin, precompute (precompute installs nothing). */
  trigger: string
  agentId: string
  tokensBefore: number | null
  tokensAfter: number | null
  usage: TelemetryTokenCounts | null
  costUsd: number | null
  /** The skip reason when it did not happen. */
  skipped: string | null
}

export type TelemetryContext = {
  updatedAt: number | null
  /** The main model's window, its fill and percentage (0 to 100), from session.measure. */
  window: number | null
  tokens: number | null
  percent: number | null
  breakdown: TelemetryContextBreakdown | null
  lastFullAt: number | null
  breakdownError: string | null
  /** Ring buffer, newest last. */
  history: TelemetryContextPoint[]
  rateLimits: TelemetryRateLimit[]
  /** The engine's own session cost (the /cost ledger), when the host keeps one. */
  engineCostUsd: number | null
  /** Ring buffer, newest last. */
  compactions: TelemetryCompaction[]
}

export type TelemetryModelSwitch = {
  at: number
  from: string | null
  to: string
  /** command, picker, sdk, auto, resume from the engine; "observed" when seen on steps only. */
  source: string
  contextTokens: number | null
  estimatedCacheWriteUsd: number | null
  pricing: string | null
}

export type TelemetryMeta = {
  schema: 1
  sessionId: string | null
  /** When the engine says the session began (resumed sessions: first launch). */
  startedAt: number | null
  /** When this mod first saw the session. */
  firstSeenAt: number
  cwd: string | null
  isInteractive: boolean | null
  mainModel: string | null
  /** Where `mainModel` came from: `$.session.model()`, a main-loop step, or a model-switch event. */
  mainModelFrom: 'session' | 'step' | 'switch' | null
  /** Ring buffer, newest last. */
  modelSwitches: TelemetryModelSwitch[]
  /** The cache TTL cache writes are priced at; updated from model-switch events. */
  cacheTtl: '5m' | '1h'
  /** The engine's pricing basis from its last model-switch event, when one was seen. */
  enginePricing: string | null
  /** Whether a `modelPricing` key is present in settings (its shape is not typed). */
  managedPricingSet: boolean | null
  mainTurns: number
  /** Loop ("main" or agent id) to its running turn's id. */
  activeTurns: Record<string, string>
  /** Times the telemetry was reset (/clear, resume). */
  resets: number
  updatedAt: number
}

/** Every value together, as the derive functions take it. */
export type TelemetryState = {
  totals: TelemetryTotals
  agents: TelemetryAgents
  steps: TelemetryStep[]
  tools: TelemetryToolEvent[]
  turns: TelemetryTurn[]
  context: TelemetryContext
  meta: TelemetryMeta
}

/** The pane's tabs, in their order (hotkeys 1 to 7). */
export type TelemetryUiTab = 'overview' | 'agents' | 'tokens' | 'context' | 'tools' | 'flow' | 'live'

/**
 * The pane's own state: which tab shows, which agent row is selected, and how
 * far each tab's list is scrolled. Written by the pane's press and scroll
 * handlers only; not reset by /clear (the telemetry is, the view is not).
 */
export type TelemetryUi = {
  tab: TelemetryUiTab
  /** The focused agent row (the arrow keys move it; it opens nothing by itself); null: none yet. */
  agentId: string | null
  /** First list row shown, per tab. */
  scroll: Partial<Record<TelemetryUiTab, number>>
  /** Agents: every finished agent, not only the most recent few (added later; absent reads as false). */
  showAllAgents?: boolean
  /** The band above the prompt: `auto` (absent) collapses to one row while idle; `/telemetry band <mode>` sets it. */
  band?: TelemetryBandMode
  /** Agents: the spawn tree (absent) or one card per workflow. */
  agentsMode?: TelemetryAgentsMode
  /** Agents: the filter chip in force (absent reads as `all`). */
  agentFilter?: TelemetryAgentFilterChip
  /** Agents: the search text (absent reads as empty). */
  agentQuery?: string
  /** Agents, workflows mode: the ids of the expanded workflow cards. */
  expandedWorkflows?: string[]
  /** Agents, tree mode: the ids of the rows whose drawer is open (several at once; absent reads as none). */
  expandedAgents?: string[]
  /**
   * When the person closed the pane by hand (`ui.close`, origin `person`). While
   * set, nothing opens the pane unasked (session start, a remote client
   * attaching); `/telemetry` or the band's title clears it. Absent: never closed.
   */
  paneClosedAt?: number
  /** The latest `$.ui.open` of the pane (`/telemetry where` prints it): when, whether the person asked (focus), and its answer. */
  lastOpen?: TelemetryPaneOpen
  /** The `session.attach` events seen (`/telemetry where`): how many, and the latest one's surface. */
  attachSeen?: { count: number; lastSurface: string; lastAt: number }
}

/** One `$.ui.open` of the pane as it answered (`reason` only when not placed). */
export type TelemetryPaneOpen = { at: number; asked: boolean; isPlaced: boolean; reason: string | null }

/** One client that joined the session's roster (`session.attach`): a desktop app, a phone, an editor. */
export type TelemetryClient = {
  /** The surface it declared (`desktop`, `vscode`, `mobile`, or a name outside the known set). */
  surface: string
  /** Its id in the roster (`<surface>:default` when it never named itself). */
  clientId: string
  /** Its latest attach. */
  attachedAt: number
  /** Its latest attach or detach, whichever is later. */
  lastSeen: number
  /** When it left the roster; null while attached. */
  detachedAt: number | null
  /** Why it left (`detach` or `end`); null while attached. */
  detachReason: 'detach' | 'end' | null
  /** How many times it attached under this id (2 and more: reconnects). */
  attaches: number
  /** The size it reported at its latest attach, when it said. */
  viewport: { columns: number; rows: number; isFullscreen?: boolean } | null
}

/**
 * The remote clients and the facts about where the session draws
 * (hooks/ui/ui-state.ts `CLIENTS`; pure reducers in hooks/clients.ts). Not part
 * of TelemetryState and not reset by /clear: an attached desktop stays attached.
 */
export type TelemetryClients = {
  schema: 1
  /** Newest attach last; at most 20 (the oldest detached ones go first). */
  clients: TelemetryClient[]
  /**
   * `session.start`'s `surface` at the latest (re)load: `terminal` under the REPL,
   * null for a run with no terminal binding; absent when no start was seen.
   */
  startSurface?: string | null
  /** The first prompt seen arriving over the Remote Control bridge (`prompt.submit` origin `bridge`); absent: none seen. */
  bridgeSeenAt?: number | null
  /** The machine's name from `HOSTNAME` when the environment has it; absent or null: not known. */
  host?: string | null
  updatedAt: number
}

/** How the band above the prompt shows: `auto` collapses to one row while nothing runs, no alert is active and the context is under the warning line. */
export type TelemetryBandMode = 'auto' | 'on' | 'off' | 'compact' | 'full'

/** The Agents tab's two views. */
export type TelemetryAgentsMode = 'tree' | 'workflows'

/** The Agents tab's filter chips (the groups of `groupOf`, or all). */
export type TelemetryAgentFilterChip = 'all' | 'running' | 'stale' | 'failed' | 'done'

/** How serious an alert is: `crit` may raise a toast in the quiet mode, `warn` only in `all`. */
export type TelemetryAlertLevel = 'warn' | 'crit'

/** One alert as it fired. Ring buffer (50), newest last. Never carries a tool's input or error text. */
export type TelemetryAlert = {
  /** `a<seq>`, unique within the session. */
  id: string
  /** The condition it is about: `context`, `burn`, `tool-errors`, `cache-expiring`, `budget`, `agent-stale:<id>`, `agent-long:<id>`. */
  key: string
  level: TelemetryAlertLevel
  message: string
  at: number
  /** Set by the view (`ackAlerts($, ids)` in hooks/state.ts). */
  ackd: boolean
}

/** What the alert engine remembers of one condition key, so it fires once, re-arms when it clears, and keeps a cooldown. */
export type TelemetryAlertCondition = {
  active: boolean
  level: TelemetryAlertLevel
  /** When it last became active. */
  since: number
  /** When it last fired (raised a log entry); 0 when it never did. */
  lastFiredAt: number
}

/**
 * The alert engine's state (hooks/insights.ts `stepAlerts`, run by
 * collect.ts `evaluateAlerts`). Kept in `$.state` rather than in the module so
 * a hot reload does not fire again what is already active. Reset with the
 * telemetry on /clear and resume.
 */
export type TelemetryAlerts = {
  schema: 1
  /** Newest last; at most 50. */
  log: TelemetryAlert[]
  /** The last alert id's number. */
  seq: number
  conditions: Record<string, TelemetryAlertCondition>
  /** When the last toast was raised (at most one per 30 s). */
  lastToastAt: number | null
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-telemetry': {
      /** The alert engine's log and memory (hooks/state.ts `ALERTS`); not part of TelemetryState. */
      alerts: Shaped<TelemetryAlerts>
      totals: Shaped<TelemetryTotals>
      agents: Shaped<TelemetryAgents>
      steps: Shaped<TelemetryStep[]>
      tools: Shaped<TelemetryToolEvent[]>
      turns: Shaped<TelemetryTurn[]>
      context: Shaped<TelemetryContext>
      meta: Shaped<TelemetryMeta>
      /** The pane's view state (hooks/ui/ui-state.ts). */
      ui: Shaped<TelemetryUi>
      /** The remote clients and where the session draws (hooks/ui/ui-state.ts `CLIENTS`). */
      clients: Shaped<TelemetryClients>
    }
  }
}
