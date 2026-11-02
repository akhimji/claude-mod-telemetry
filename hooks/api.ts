// session-telemetry: the pure half of what a UI imports, in one place (no `$`).
// The atoms and the functions that take `$` live in state.ts; import those from
// './state' by name, not through this file (the engine's scan follows `$` into
// named imports of the module's own files; a re-export is not promised). A render
// hook does
//
//   import { readTelemetry } from './state'
//   import { deriveOverview, fmtUsd } from './api'
//   const s = await readTelemetry($)             // subscribes the drawing to every atom
//   const o = deriveOverview(s, await $.clock.now())
//   ... fmtUsd(o.costUsd), fmtTokens(o.tokens.total) ...
//
// Exports:
//   deriveOverview, deriveAgents, deriveModels, deriveTools, deriveContext,
//   deriveContextGrid, deriveTurns, deriveFlow, cacheHitRate, percentile, share,
//   fmtTokens, fmtUsd, fmtDuration, fmtBytes, fmtPct, fmtRate, NONE, BURN_WINDOW_MS,
//   and the row / view types                                   (derive.ts)
//   PRICING, PRICING_SOURCE, DEFAULT_PRICING_ID, findPricing, costOf, modelLabel,
//   canonicalModel, normalizeModelId, ratesFor                  (pricing.ts)
//   MAIN, LIMITS, SHAPE, STATE_KEYS, toolLabel, mcpServerOf, emptyState  (model.ts)
//   FULL_BREAKDOWN_EVERY_MS                                     (collect.ts)
//   deriveBloat, deriveCacheClock, deriveAlerts, stepAlerts, nextAlertCheckAt,
//   rulesFromOptions, DEFAULT_ALERT_RULES, emptyAlerts, deriveWorkflows,
//   deriveAgentFilter, deriveBand, formatStatusLine, contextSegmentOf, ... (insights.ts;
//   the alerts atom is read with readAlerts / readInsights from './state')
//   deriveClients, clientsOrEmpty, isRemoteOnly, remoteChip, CLIENTS_MAX,
//   TelemetryClientsView                                         (clients.ts; the atom is
//   read with readClients from './ui/ui-state')
//   the state types                                             (../types)

export {
  ageOf,
  BURN_WINDOW_MS,
  cacheHitRate,
  deriveAgentPlan,
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
  isLiveTool,
  isStaleLoop,
  isTime,
  isUnattributed,
  NONE,
  PLAN_STALE_MS,
  planCountText,
  STALE_AFTER_MS,
  percentile,
  saneDuration,
  sessionAgeMs,
  sessionStartOf,
  share,
} from './derive'
export type {
  TelemetryAgentPlanView,
  TelemetryAgentRow,
  TelemetryContextCategoryRow,
  TelemetryContextView,
  TelemetryFlow,
  TelemetryFlowEdge,
  TelemetryFlowNode,
  TelemetryGridCell,
  TelemetryHarness,
  TelemetryModelRow,
  TelemetryNow,
  TelemetryOverview,
  TelemetryPhase,
  TelemetryReconciliation,
  TelemetryServerRow,
  TelemetryTimelineEvent,
  TelemetryTimelineKind,
  TelemetryTimelineStatus,
  TelemetryToolRow,
  TelemetryTools,
  TelemetryTurnRow,
} from './derive'
export {
  canonicalModel,
  costOf,
  DEFAULT_PRICING_ID,
  findPricing,
  modelLabel,
  normalizeModelId,
  PRICING,
  PRICING_SOURCE,
  ratesFor,
} from './pricing'
export type { CostBreakdown, ModelRates, PricingEntry } from './pricing'
export { emptyState, LIMITS, MAIN, mcpServerOf, PLAN_TOOLS, planText, SHAPE, STATE_KEYS, toolLabel } from './model'
export type { StateKey } from './model'
export { FULL_BREAKDOWN_EVERY_MS } from './collect'
export { groupOf, isActive, isFoldedAgent } from './derive'
export type { AgentGroup } from './derive'
export {
  alertsOrEmpty,
  BLOAT_DEFAULTS,
  CACHE_COOLING_MS,
  contextPressure,
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
} from './insights'
export type {
  TelemetryActiveAlert,
  TelemetryAgentFilter,
  TelemetryAgentFilterStatus,
  TelemetryAlertKind,
  TelemetryAlertRules,
  TelemetryAlertsMode,
  TelemetryAlertStep,
  TelemetryAlertsView,
  TelemetryBand,
  TelemetryBandSegmentKey,
  TelemetryBandTone,
  TelemetryBloat,
  TelemetryBloatKind,
  TelemetryBloatRow,
  TelemetryBloatTotals,
  TelemetryBloatVerdict,
  TelemetryCacheClock,
  TelemetryCacheLoop,
  TelemetryCacheStatus,
  TelemetryInsightsState,
  TelemetryWorkflow,
  TelemetryWorkflowStatus,
} from './insights'
export type {
  TelemetryAgent,
  TelemetryAgentKind,
  TelemetryAgentReport,
  TelemetryAgents,
  TelemetryAgentStatus,
  TelemetryAlert,
  TelemetryAlertCondition,
  TelemetryAlertLevel,
  TelemetryAlerts,
  TelemetryClient,
  TelemetryClients,
  TelemetryCompaction,
  TelemetryContext,
  TelemetryContextBreakdown,
  TelemetryContextCategory,
  TelemetryContextPoint,
  TelemetryMcpServerDetail,
  TelemetryMeta,
  TelemetryModelSwitch,
  TelemetryModelTotals,
  TelemetryPricingMatch,
  TelemetryRateLimit,
  TelemetrySkillContext,
  TelemetrySkillStats,
  TelemetryState,
  TelemetryStep,
  TelemetryTokenCounts,
  TelemetryToolEvent,
  TelemetryToolStats,
  TelemetryToolStatus,
  TelemetryTotals,
  TelemetryTurn,
  TelemetryUsage,
} from '../types'

export { CLIENTS_MAX, clientsOrEmpty, deriveClients, isRemoteOnly, remoteChip, type TelemetryClientsView } from './clients'
