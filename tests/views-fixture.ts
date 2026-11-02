// Fixtures for the insights views (the band, the Overview's alerts and cache
// card, the Context tab's bloat audit, the Agents tab's workflows), built on
// tests/fixture.ts and tests/insights-fixture.ts:
//
// - withBloat(s): the populated session with the bloat session's full
//   breakdown, per-server detail, skill rows and tool counts, so the audit is
//   ready (an MCP server never called, a skill called once, a custom agent).
// - alertsLog(now): a stored alerts atom with a stale-agent condition active
//   since 20 minutes and two log entries, one acked.
// - withAlerts(s): the ghosts fixture (a stale real agent alerts) as a state.

import type { TelemetryAlerts, TelemetryState } from '../types'

import { NOW, populated, withGhosts } from './fixture'
import { bloatSession } from './insights-fixture'

export function withBloat(s: TelemetryState = populated()): TelemetryState {
  const b = bloatSession()
  const at = NOW - 10 * 60_000
  s.context.lastFullAt = at
  s.context.breakdown = b.context.breakdown ? { ...b.context.breakdown, at } : null
  s.context.updatedAt = NOW - 5 * 60_000
  s.totals.byTool = { ...s.totals.byTool, ...b.totals.byTool }
  s.totals.bySkill = b.totals.bySkill
  return s
}

export function alertsLog(now = NOW): TelemetryAlerts {
  return {
    schema: 1,
    log: [
      { id: 'a1', key: 'burn', level: 'warn', message: 'Burn rate $0.62/min is 4× the recent median', at: now - 15 * 60_000, ackd: true },
      { id: 'a2', key: 'agent-stale:g3', level: 'warn', message: 'Agent "long search that went quiet" has been quiet for 20m', at: now - 10 * 60_000, ackd: false },
    ],
    seq: 2,
    conditions: { 'agent-stale:g3': { active: true, level: 'warn', since: now - 10 * 60_000, lastFiredAt: now - 10 * 60_000 } },
    lastToastAt: null,
    updatedAt: now - 10 * 60_000,
  }
}

export const withAlerts = (s: TelemetryState = populated()): TelemetryState => withGhosts(s)
