// session-telemetry: the `$.state` side. The atoms, and the only functions that
// read or write them. The engine's scan wants every `$.state` reference (and every
// atom `read` takes) written as a literal in the file that uses it, and follows `$`
// only into functions of the same file or ones named-imported from the module's
// own files, so the atoms and these functions all live here, and callers import
// them by name (`import { readTelemetry } from './state'`, never `import * as`).
//
// Exports:
//   TOTALS, AGENTS, STEPS, TOOLS, TURNS, CONTEXT, META   the atoms (`read($, TOTALS)`)
//   TELEMETRY              all seven as one TelemetryState (`read($, TELEMETRY)`)
//   readTelemetry($)       the same, as a call: `const s = await readTelemetry($)`;
//                          inside ui.render it subscribes the drawing to every atom
//   ioOf($)                the TelemetryIO collect.ts runs on, over a hook's `$`
//   ALERTS                 the alert engine's atom (TelemetryAlerts; not part of TelemetryState)
//   INSIGHTS               all eight atoms as one TelemetryInsightsState (TelemetryState & { alerts })
//   readAlerts($), readInsights($)   the same as calls; inside ui.render they subscribe the drawing
//   ackAlerts($, ids?)     marks alerts (all when ids is left out) as seen by the person

import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TelemetryAlerts, TelemetryState } from '../types'

import type { TelemetryIO } from './collect'
import { alertsOrEmpty, emptyAlerts, type TelemetryInsightsState } from './insights'
import { emptyState, SHAPE, type StateKey } from './model'

const initial = emptyState(0)

export const TOTALS = atom({ plugin: 'session-telemetry', key: 'totals' } as const, initial.totals, { shape: SHAPE })
export const AGENTS = atom({ plugin: 'session-telemetry', key: 'agents' } as const, initial.agents, { shape: SHAPE })
export const STEPS = atom({ plugin: 'session-telemetry', key: 'steps' } as const, initial.steps, { shape: SHAPE })
export const TOOLS = atom({ plugin: 'session-telemetry', key: 'tools' } as const, initial.tools, { shape: SHAPE })
export const TURNS = atom({ plugin: 'session-telemetry', key: 'turns' } as const, initial.turns, { shape: SHAPE })
export const CONTEXT = atom({ plugin: 'session-telemetry', key: 'context' } as const, initial.context, { shape: SHAPE })
export const META = atom({ plugin: 'session-telemetry', key: 'meta' } as const, initial.meta, { shape: SHAPE })

export const TELEMETRY = derive(
  [TOTALS, AGENTS, STEPS, TOOLS, TURNS, CONTEXT, META],
  (totals, agents, steps, tools, turns, context, meta): TelemetryState => ({ totals, agents, steps, tools, turns, context, meta }),
)

export const ALERTS = atom({ plugin: 'session-telemetry', key: 'alerts' } as const, emptyAlerts(0), { shape: SHAPE })

export const INSIGHTS = derive(
  [TOTALS, AGENTS, STEPS, TOOLS, TURNS, CONTEXT, META, ALERTS],
  (totals, agents, steps, tools, turns, context, meta, alerts): TelemetryInsightsState => ({ totals, agents, steps, tools, turns, context, meta, alerts }),
)

const REF_TOTALS = { plugin: 'session-telemetry', key: 'totals' } as const
const REF_AGENTS = { plugin: 'session-telemetry', key: 'agents' } as const
const REF_STEPS = { plugin: 'session-telemetry', key: 'steps' } as const
const REF_TOOLS = { plugin: 'session-telemetry', key: 'tools' } as const
const REF_TURNS = { plugin: 'session-telemetry', key: 'turns' } as const
const REF_CONTEXT = { plugin: 'session-telemetry', key: 'context' } as const
const REF_META = { plugin: 'session-telemetry', key: 'meta' } as const

/** Every atom at once, as the derive functions take it. */
export function readTelemetry($: EngineInterface): Promise<TelemetryState> {
  return read($, TELEMETRY)
}

function writeKey($: EngineInterface, key: StateKey, s: TelemetryState): Promise<unknown> {
  switch (key) {
    case 'totals':
      return $.state.set(REF_TOTALS, { shape: SHAPE, value: s.totals })
    case 'agents':
      return $.state.set(REF_AGENTS, { shape: SHAPE, value: s.agents })
    case 'steps':
      return $.state.set(REF_STEPS, { shape: SHAPE, value: s.steps })
    case 'tools':
      return $.state.set(REF_TOOLS, { shape: SHAPE, value: s.tools })
    case 'turns':
      return $.state.set(REF_TURNS, { shape: SHAPE, value: s.turns })
    case 'context':
      return $.state.set(REF_CONTEXT, { shape: SHAPE, value: s.context })
    case 'meta':
      return $.state.set(REF_META, { shape: SHAPE, value: s.meta })
  }
}

/** The alert engine's atom (its log, newest last, and its memory of each condition). */
export function readAlerts($: EngineInterface): Promise<TelemetryAlerts> {
  return read($, ALERTS)
}

/** Every telemetry atom and the alerts, as the insights functions take them. */
export function readInsights($: EngineInterface): Promise<TelemetryInsightsState> {
  return read($, INSIGHTS)
}

/** Marks the alerts with these ids (every alert when `ids` is left out) as seen. */
export function ackAlerts($: EngineInterface, ids?: readonly string[]): Promise<TelemetryAlerts> {
  return update($, ALERTS, a => {
    const value = alertsOrEmpty(a, 0)
    return { ...value, log: value.log.map(x => (ids === undefined || ids.includes(x.id) ? { ...x, ackd: true } : x)) }
  })
}

/** The IO collect.ts runs on, over this hook's `$`. */
export function ioOf($: EngineInterface): TelemetryIO {
  return {
    now: () => $.clock.now(),
    readState: () => read($, TELEMETRY),
    writeState: (key, s) => writeKey($, key, s),
    log: text => $.ui.log(text, { to: 'debug' }),
    sessionId: () => $.session.id(),
    sessionStartedAt: async () => (await $.session.usage()).startedAt,
    sessionModel: () => $.session.model(),
    sessionCwd: () => $.session.cwd(),
    managedPricing: () => $.settings.read({ key: 'modelPricing' }),
    breakdown: async detail => (await $.session.usage({ breakdown: detail })).context.breakdown,
    agentList: () => $.agent.list(),
    after: (ms, fn) => {
      $.clock.after(ms, fn)
    },
    readAlerts: () => read($, ALERTS),
    updateAlerts: fn => update($, ALERTS, fn),
    toast: text => $.ui.toast(text),
    status: text => $.ui.status(text),
  }
}
