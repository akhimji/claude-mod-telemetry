// Plans on the populated session (tests/fixture.ts), set through the reducer
// itself (model.ts `recordPlan`), so the stored text is what redaction left:
//
// - main (running): a TodoWrite of 10 todos, 3 done, 1 in progress
//   (`Wiring the plan line`), 6 pending; one pending todo carries the fake
//   SECRET, another a URL with user info and a token query.
// - a3 `draft the plan` (running): savvy-progress `step` 3 of 7, note
//   `wire the plan line into both paths`; with `stale`, last updated 15 min ago.
// - a1 `find every caller…` (completed): a TodoWrite of 7, all done.
// - a2 `nested check` (error): `step` 2 of 5.

import type { TelemetryState } from '../types'

import { recordPlan } from '../hooks/model'

import { NOW, populated, SECRET } from './fixture'

export const MAIN_TODOS = [
  { content: 'Read NOTES and the collector', status: 'completed', activeForm: 'Reading NOTES' },
  { content: 'Add the plan type to the contract', status: 'completed', activeForm: 'Adding the plan type' },
  { content: 'Record plans from the tool calls', status: 'completed', activeForm: 'Recording plans' },
  { content: 'Wire the plan line into both paths', status: 'in_progress', activeForm: 'Wiring the plan line' },
  { content: `rotate key ${SECRET} in staging`, status: 'pending', activeForm: 'Rotating the key' },
  { content: 'check https://user:hunter2@example.com/docs?token=abc123def456 for the API', status: 'pending', activeForm: 'Checking the docs' },
  { content: 'Add render tests at four widths', status: 'pending', activeForm: 'Adding render tests' },
  { content: 'Look at the frames', status: 'pending', activeForm: 'Looking at the frames' },
  { content: 'Update NOTES', status: 'pending', activeForm: 'Updating NOTES' },
  { content: 'Report back', status: 'pending', activeForm: 'Reporting' },
]

export function withPlans(s: TelemetryState = populated(), opts: { stale?: boolean } = {}): TelemetryState {
  recordPlan(s, { tool: 'TodoWrite', input: { todos: MAIN_TODOS } }, NOW - 30_000)
  recordPlan(s, { agentId: 'a3', tool: 'mcp__savvy-progress__step', input: { done: 3, total: 7, note: 'wire the plan line into both paths' } }, opts.stale ? NOW - 15 * 60_000 : NOW - 60_000)
  recordPlan(
    s,
    { agentId: 'a1', tool: 'TodoWrite', input: { todos: Array.from({ length: 7 }, (_, i) => ({ content: `caller group ${i + 1}`, status: 'completed', activeForm: `Group ${i + 1}` })) } },
    NOW - 90_000,
  )
  recordPlan(s, { agentId: 'a2', tool: 'mcp__savvy-progress__step', input: { done: 2, total: 5, note: 'check nested' } }, NOW - 70_000)
  return s
}
