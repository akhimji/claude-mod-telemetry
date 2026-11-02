# session-telemetry: notes

The session-telemetry mod observes the session, keeps the figures in
`$.state`, and draws them in a pane (`Telemetry`, `/telemetry`). The data layer
is described first; the pane is under "UI" at the end.

## Files

| File | What it is | Uses `$` |
| --- | --- | --- |
| `.claude-plugin/plugin.json` | Manifest, `types: ./types/index.d.ts` | – |
| `hooks/hooks.json` | `{"modules":["./register.tsx"]}` | – |
| `hooks/register.tsx` | The hooks; hands each event to collect.ts | Only via `ioOf($)` |
| `hooks/state.ts` | The atoms, `TELEMETRY`, `readTelemetry($)`, `ioOf($)` | Yes |
| `hooks/collect.ts` | Collection over a `TelemetryIO`: memory, hydration, coalesced writes, guards | No |
| `hooks/model.ts` | State model and reducers (each mutates a state and returns the keys it changed) | No |
| `hooks/pricing.ts` | Pricing table, model-id matching, `costOf` | No |
| `hooks/derive.ts` | Selectors and formatters for the UI | No |
| `hooks/insights.ts` | Bloat audit, cache clock, alert rules and reducer, workflows, agent filter, band (see "Insights API") | No |
| `hooks/api.ts` | The pure exports a UI needs, in one place | No |
| `hooks/clients.ts` | The remote clients: the `clients` value's reducers, `deriveClients`, `isRemoteOnly`, `shouldAutoOpen`, `remoteChip` (see "Remote monitoring") | No |
| `types/index.d.ts` | The contract: every state value's type, `PluginState['session-telemetry']` | – |
| `hooks/ui-kit.ts` | The pane's text kit: widths, bars, sparklines, column fitting, windows, the line model | No |
| `hooks/ui/*.ts(x)` | The pane and the band: registration, the two frames (`term/`, `desktop/`), one builder per tab, the band builders (see "UI", "Band" and "Insights views") | Only `pane.tsx`, `ui-state.ts` |
| `tests/*.test.ts(x)` | pricing, model, derive, collect (fake IO), hooks (through the engine's kit), ui-kit, pane (the terminal path, kit `mount`, laid out as text by `term-render.ts`), frames (every terminal frame within its size; printable), svg (the builders), desktop (the desktop path, kit `mount` on desktop and vscode), insights (the pure insights), alerts (the alert engine over a fake IO, and options through the kit), band (the band on both surfaces and its geometry), views (the insights views on both surfaces), views-frames (the new views' terminal frames; printable); `fixture.ts` is a populated state, with `withGhosts` and `withManyDone`; `insights-fixture.ts` the insights' sessions; `views-fixture.ts` adds `withBloat`, `withAlerts`, `alertsLog` | – |

### The scan rules that shape the layout

`claude plugin validate` reads the module the way the engine will. These are
the rules it enforces, each checked against it:

- **Passing `$`.** `$` may be passed only to:
  - a function declared in the same file;
  - a function **named-imported** from one of the module's own files (`import { readTelemetry } from './state'`).

  It may **not** be passed through a namespace import (`import * as x` then
  `x.fn($)`): that is refused with "$ itself is passed as an argument".
  Handing another file a closure over `$` is fine.
- **Literal references.** Every `$.state.set` reference, and every atom
  `read`/`update` takes, must have its `{ plugin, key }` written as literals in
  the file that uses it. So the atoms and every function that reads or writes
  them live in `state.ts`. Another file that wants to read calls
  `readTelemetry($)` from there.

## Exports

**`hooks/state.ts`** (import by name)
- `TOTALS`, `AGENTS`, `STEPS`, `TOOLS`, `TURNS`, `CONTEXT`, `META`: the atoms
  (`atom(ref, initial, { shape: 'v1' })`). These can only be `read` inside
  state.ts.
- `TELEMETRY`: `derive([...all seven], ...)`, giving a `TelemetryState`.
- `readTelemetry($)`: `read($, TELEMETRY)`. Inside a `ui.render` hook it
  subscribes the drawing to every atom.
- `ioOf($)`: the `TelemetryIO` over a hook's `$`. Use it for
  `collect.refreshContext(ioOf($), 'full')` from a press handler.

**`hooks/register.tsx`**: `register`.

**`hooks/collect.ts`**
- `TelemetryIO` and `guard`.
- Event handlers: `onSessionStart`, `onSessionEnd`, `onTurnStart`, `onStep`,
  `onTurnComplete`, `onToolStart`, `onToolEnd`, `onAgentToolEnd`, `onToolExec`,
  `onAgentSpawn`, `onCompact`, `onMeasure`, `onModelSwitch`.
- `refreshContext(io, 'auto' | 'summary' | 'full')`.
- `FULL_BREAKDOWN_EVERY_MS` (30 min), `peek()`, `resetForTests()`.

**`hooks/derive.ts`** (also exported from `api.ts`). All pure. Pass `now` in
ms, and pass only the slices each function reads.

- **Time.** A timestamp of 0 or null is "unknown" (`isTime`): the atoms' initial
  value is built at time 0, and an unbound session answers `startedAt: 0`.
  `sessionStartOf(s, now)` is the earliest known of `meta.startedAt`,
  `meta.firstSeenAt` (when the mod first saw the session: the start when it
  loaded mid-session) and `totals.firstStepAt`; `sessionAgeMs` is `now` less
  that. `saneDuration(ms, maxMs)` answers `ms` only when it is not negative
  and not past `maxMs` (the session's age, plus a minute), else null;
  `ageOf(now, at, maxMs)` is the same for `now - at`. Every duration a derive
  function answers goes through these, so a start of 0 shows as NONE rather
  than as 20,000 days. `fmtDuration` itself shows NONE for a negative or an
  absurd (over 400 days) value.
- **`deriveReconciliation(s)`** sets the engine's ledger (the whole session:
  before the mod loaded, every loop, the compaction summarizer, pricing
  modifiers) against what the mod tracked (observed and priced since
  `meta.firstSeenAt`): `ledgerUsd`, `trackedUsd`, `trackedSince`,
  `untrackedUsd` (`ledger - tracked` when the ledger is the larger; 0 when the
  tracked sum is at or over it, which is drift, not untracked; null without a
  ledger), `untrackedShare`, `totalUsd` (the ledger when known and not under
  the tracked sum, else the tracked sum) and `source` (`ledger` | `estimate`).
  Wherever totals are shown, the UI adds the untracked remainder so the rows
  add up to the headline.
- **`deriveOverview(s, now, { burnWindowMs? })`** returns a `TelemetryOverview`:
  - `elapsedMs` (uptime from `sessionStartOf`; null when no start is known) and
    `ledger` (the reconciliation above).
  - Cost: `costUsd` (the engine's ledger when known, else the estimate),
    `costSource`, `estimatedCostUsd`, `engineCostUsd`, `estimateDrift`.
  - Tokens and cache: `tokens{input,output,cacheRead,cacheWrite,total,prompt}`,
    `requests`, `cacheHitRate`, `cacheSavedUsd`.
  - Turns: `mainTurns`, `perTurn{tokens,costUsd,avgDurationMs}` (tracked
    figures over main turns; the ledger is not divided by turns the mod saw).
  - Burn rate: `burn{windowMs,costUsd,tokens,usdPerMinute,tokensPerMinute,isPartial}`,
    over a 5-minute window by default.
  - Activity: `steps`, `toolCalls`, `toolErrors`, `toolErrorRate`,
    `agents{total,subagents,running}`.
  - Model and limits: `mainModel`, `mainModelLabel`,
    `context{tokens,window,fill,percent}`, `rateLimits`.
  - Pricing flags: `pricing{hasFallback,cacheTtl,enginePricing,managedPricingSet}`.
- **`deriveAgents(s, now)`** (takes `agents`, `totals`, `meta`, `tools`) returns
  agent rows in spawn-tree order (`depth`, `childIds`). Each row has usage,
  cost and cost share (of the tracked sum), cache hit rate, duration (main:
  the session's uptime; others: spawn to end or now; a stale loop's clock
  stops at its last activity; null when unknown or impossible), active time,
  context peak, and the Agent call's `report`. A running loop that went quiet
  (`isStaleLoop`) is answered with `status: 'stale'`, `isRunning: false`,
  `isStale: true`; `isUnattributed` marks one never spawned under this mod's
  eyes with no request and no tool call. `deriveOverview.agents.running`,
  `deriveTimeline`'s `runningAgents` and `agents` phase, and `isActive` all
  leave stale loops out.
- **`deriveModels(s)`** returns model rows, most expensive first (shares of the
  tracked sum).
- **`deriveTimeline(s, now, { limit = 80 })`** returns `{ now, events }`:
  - `now`: the phase (`idle`, `request` in flight, `tool` running, waiting on
    `agents`), its `detail` and `tool`, `sinceMs` (how long the phase has
    lasted), running counts, `lastActivityAt`. A running tool wins; else
    running subagents; else an open turn means a model request is in flight
    since the last step or tool ended.
  - `events`, newest first with running things first: one per step
    (`request`: model, tokens, cost, duration, "answered" / "asked N tools"),
    tool call (`tool`: status, duration; `toolLabel` is the raw input hint, the
    UI passes it through `shortLabel`), agent `spawn` and `finish`,
    `compaction`, model `switch`, and main-loop `turn` start and end (numbered
    back from `meta.mainTurns`). Built from what the collector already keeps;
    no collector change was needed.
- **`deriveHarness(s)`** says what feeds the context each request, from the
  latest breakdown and the latest main-loop step: `fixedTokens` (everything
  used but the messages), `messagesTokens`, `consumers` largest first with
  their fill, and `lastRequest` (prompt tokens re-sent, cache read / write,
  hit rate, message count).
- **`deriveTools(s, now, { recent? })`** returns `{ rows, servers, recent, running, totals }`.
  Each row has:
  - call counts: total, ok, errors, denied, interrupted, running;
  - error rate;
  - wall time: average, max, p50, p95; and average execution time;
  - result size in chars and bytes, plus an estimated token count (chars / 4).
- **`deriveContext(s)`** returns:
  - the window, its fill, the headroom, and the tokens left before autocompact;
  - the categories with their share of the window, and the used, free, buffer
    and deferred totals;
  - `sparkline` (tokens after each main turn) and `sparklineFill`;
  - compactions, newest first;
  - memory files, MCP servers, skills, slash commands, custom agents, rate limits.
- **`deriveContextGrid(categories, maxTokens, cells = 100)`** returns
  `/context`-style squares.
- **`deriveTurns(s, { agentId = 'main', limit = 20 })`** returns recent turns,
  newest first.
- **`deriveFlow(s, { maxTools = 8 })`** returns `{ nodes, edges }`: agent to
  agent (spawn), agent to model, agent to tool.
- **Helpers:** `cacheHitRate`, `percentile`, `share`, `BURN_WINDOW_MS`.
- **Formatters:** `fmtTokens`, `fmtUsd`, `fmtDuration` (NONE for negative or
  absurd values too), `fmtBytes`, `fmtPct` (takes a 0..1 ratio), `fmtRate`,
  and `NONE` ('–', shown for a missing value).

Ratios are 0..1. Fields named `percent` come from the engine and run 0..100.

**`hooks/pricing.ts`**
- `PRICING`, `PRICING_SOURCE`, `DEFAULT_PRICING_ID`.
- `normalizeModelId`, `findPricing` (returns `{ entry, match: 'exact' | 'family' | 'default' }`),
  `ratesFor`, `costOf`, `modelLabel`, `canonicalModel`.

**`hooks/model.ts`**
- Constants: `MAIN` ("main"), `LIMITS`, `SHAPE` ("v1"), `STATE_KEYS`, `StateKey`.
- State: `emptyState`, `emptyUsage`, `resetState`, and the `record*` reducers
  with their input types.
- Helpers: `toolLabel`, `mcpServerOf`, `utf8Length`, `agentKey`, `countsOf`.
- Liveness (see "Stale loops" below): `STALE_AFTER_MS` (10 min), `STALE_TOOL_MS`
  (60 min), `isLiveTool(ev, now)`, `hasLiveTool(s, id, now)`,
  `isStaleLoop(s, id, now)`, `expireStaleAgents(s, now)`,
  `reconcileAgents(s, list | null, now)`, `isUnattributed(agent)`. The first
  four are re-exported from derive.ts and api.ts.

## Atoms (plugin `session-telemetry`, every value a `Shaped<T>` under tag `v1`)

The full types are in `types/index.d.ts`. A raw `$.state.get` answers
`{ shape, value }`, and `read` with the atoms unwraps it. A write under another
shape tag reads back as the atom's initial value. Both behaviours were tested
against the real store; see Verification.

| Key | Type | Written on | Bound |
| --- | --- | --- | --- |
| `totals` | `TelemetryTotals`: session usage, `byModel`, `byTool` stats, counters, eviction counts | step, tool start / end / exec | 300 tool names |
| `agents` | `TelemetryAgents`: `byId` (main plus each subagent run: kind, type, description, parent, models, status, usage, byModel, byTool, context peak, report) and `order` | step, turn, tool, spawn | 200 agents |
| `steps` | `TelemetryStep[]`, one per model request | step | ring of 500 |
| `tools` | `TelemetryToolEvent[]`, one per tool call, including server tools such as the advisor | tool start / end / exec, step | ring of 200 |
| `turns` | `TelemetryTurn[]`, main and agent turns | turn start / complete, step | ring of 200 |
| `context` | `TelemetryContext`: window, fill and %, breakdown, context history, rate limits, the engine's cost, compactions | measure, breakdown, compact | 200 points, 50 compactions |
| `meta` | `TelemetryMeta`: session id, start, cwd, main model and its source, model switches, cache TTL, pricing basis, turn count, active turns, resets | session start, turns, switches | 50 switches |
| `alerts` | `TelemetryAlerts`: the alert log, the engine's memory per condition key, the last toast time. Not part of `TelemetryState` (read with `readAlerts` / `readInsights`) | an alert firing, clearing or being acked | 50 alerts |

Totals and the per-agent and per-tool aggregates are kept apart from the
rings, so they stay correct after old records are evicted.

Nothing is kept in `$.store`, so a new session starts empty. `/clear` and
resume (`session.end` with reason `clear` or `resume`) reset everything and
count it in `meta.resets`.

After a hot reload, the module reads the atoms back (tested) and carries on.
If it is loaded into a session that is already running, no `session.start`
fires. The first event then fills in the session id, start time, model and cwd
itself. Hydration also stamps anything still at time 0 (the atoms' initial
value: `meta.firstSeenAt`, the main agent's `firstSeenAt` and `lastActiveAt`)
with the current time, and `recordSession` ignores a `startedAt` of 0 or in
the future: before this, a mod loaded mid-session kept main's start at the
epoch and the pane showed a 20,752-day duration.

## Events hooked

Every hook returns what `next(e)` returned, unchanged. A rejection from beneath
is recorded, then re-thrown. Telemetry work runs inside `guard`, which logs a
failure to the debug log once per name and keeps it from reaching the session.
Every gating site also has a pass-through `.catch(($, e, next) => next(e))`.
The gating sites are both `tool.call` hooks, `agent.spawn`, `session.compact`,
`classic.PostToolUse`, `classic.PostToolUseFailure` and
`classic.PostModelSwitch`.

| Event | Records |
| --- | --- |
| `session.start` | session id, `startedAt`, model, cwd, whether it is interactive, whether a `modelPricing` setting exists; then the reconciliation (`$.agent.list()` against the running loops, and the stale sweep): it fires on every hot reload too |
| `session.end` | a reset, on `clear` and `resume` |
| `turn.start` | opens a turn for main or an agent, counts main turns, notes each loop's active turn; a loop first heard of here is looked up in `$.agent.list()` once |
| `turn.step` (async generator, `yield* next(e)`) | for each request: model, effort, the four token counts, cost, duration, stop reason, tool names, server tool uses; rolled up into session, model, agent and turn |
| `turn.complete` | closes the turn: duration, reason, the engine's own summed usage (kept as a cross-check), agent status; at the end of a main turn with a subagent still running on the books, the reconciliation |
| `tool.call` (not Agent) | at start, a running event with a short input label; at end: ok, error or denied, wall time, result chars and bytes, read-only flag |
| `tool.call` (Agent) | the same, plus a completed foreground run's report: `totalTokens`, duration, tool count, the 5m/1h cache-write split, models used |
| `agent.spawn` | type, description, name, parent, requested and resolved model, whether background, fork / teammate / workflow, tool_use_id |
| `session.compact` | trigger, loop, tokens before and after, the summarizer's usage and estimated cost, skips |
| `session.measure` | window, fill and %, rate-limit windows, the engine's cost, one context-history point per main turn; also schedules the breakdown |
| `classic.PostToolUse` and `PostToolUseFailure` | the engine's execution time (`duration_ms`, which leaves out permission prompts), interrupts |
| `classic.PostModelSwitch` | from, to, source, context tokens, re-cache estimate, pricing basis, cache TTL |

### Context breakdown

`session.measure` only schedules the breakdown, with `$.clock.after(0)`, so a
slow count never holds up the session.

A `'full'` breakdown sends one token-count request per tool and per memory
file. `auto` therefore asks for `'full'` at most every 30 minutes, the first
time included, and asks for `'summary'` the rest of the time. A summary is
estimated locally and costs nothing. A UI button can call `refreshContext(...,
'full')` to get a full one on demand.

### Stale loops (the ghost rows, fixed 2026-10-26)

The live pane showed three agents named `unknown`, RUNNING for 7h03m, 5h17m
and 5h04m, 0 tokens, model unknown, phase `model request · –`. The cause:

- `ensureAgent` makes every loop it has not seen `running` (a `turn.start`,
  a tool event or a step with a new `agentId`), and only a `turn.complete`,
  an Agent report or a listed status ends it. The types say a `turn.start`
  can carry ids `$.agent.list()` never names ("a workflow's agents and the
  engine's own forks (compaction, memory) carry ids no list names"; "a run
  whose steps no hook sees"), and a hot reload (each save, applied when the
  turn ends) drops the module while a `turn.complete` lands. A loop whose
  end is lost that way stayed `running` forever: it also kept the header
  `live` and the 1 s tick armed, and `ensureAgent`'s eviction never evicts a
  running loop.
- The `$.agent.list()` lookup (`enrich`) ran only on a step or a turn end,
  so a loop heard of at its `turn.start` alone was never looked up.

The fix, in three parts, all tested (`tests/model.test.ts`,
`collect.test.ts`, `derive.test.ts`, the two UI suites):

1. **Stale, at derive time.** `isStaleLoop(s, id, now)`: no event of the
   loop's own (`lastActiveAt`) for `STALE_AFTER_MS` (10 min) and no live call
   (`isLiveTool`: a running call of its own started within `STALE_TOOL_MS`,
   60 min; a long Bash or a wait on a subagent is activity). `deriveAgents`
   answers `status: 'stale'`; nothing counts a stale loop as running
   (`deriveOverview`, `deriveTimeline`, `isActive`, `agentPhase`); the UI
   draws it with `◌` in the warning tone, under a `stale` count, with a
   `◌ stale · no activity for 20m 00s` line and no phase. The next event of
   its own (a step bumps `lastActiveAt`) brings it back, with no stored
   change needed.
2. **Settled in the store.** `expireStaleAgents(s, now)` turns a stale
   running subagent `unknown` (its `endedAt` stays null, so `recordStep`'s
   revive rule still applies), forgets its open turn in `meta.activeTurns`,
   and closes a stale open main turn as idle (a lost main `turn.complete`
   kept the pane live too). It runs on hydration (the first event after a
   (re)load), inside `reconcileAgents` at `session.start` (every hot reload)
   and at the end of a main turn while a subagent is still running on the
   books. `reconcileAgents` first applies `$.agent.list()`: a loop the engine
   lists as over is ended as it says (its open turn forgotten), a swept
   `unknown` one included.
3. **Unattributed.** `isUnattributed(agent)`: kind `unknown`, never spawned
   under this mod's eyes, no request, no tool call. Both Agents tabs fold such
   loops into one dim `+N unattributed (no spawn seen, no usage)` line, running
   or not, and the timeline leaves them out; nothing draws the word `unknown`.
   `turn.start` now looks a new loop up in the list at once, so a real
   subagent gets its kind and description from its first event.

Not reproduced live (the session's debug log was not kept; its transcript
holds no compaction summary, so which fork it was is not known); the fix
covers every path that makes a running row without an end.

### Pricing

The table holds list prices from
platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-25. It covers:
- Fable 5.1 and 5, Mythos 5.1 and 5;
- Opus 5.5, 5, 4.8, 4.7, 4.6, 4.5, 4.1 and 4;
- Sonnet 5.5, 5, 4.6, 4.5 and 4;
- Haiku 5.5 (each request priced by prompt size, with a higher rate over 100K
  tokens), Haiku 4.5 and Haiku 3.5.

The page wins over the claude-api skill's cached table. For example, Sonnet 5.5
cache reads are $0.10/MTok, not $0.20.

When a model is not in the table:
- An unknown version of a known family gets the family's newest row, flagged
  `family`.
- Anything else gets Opus 5.5 rates, flagged `default`.

Cache writes are priced at the 5-minute rate unless a model-switch event
reported a 1-hour TTL.

Treat the engine's ledger (`context.engineCostUsd`) as authoritative.
`deriveOverview` reports how far the estimate drifts from it.

## What is NOT observable (so not faked)

- **Managed `modelPricing`.** The types declare no shape for it, so only its
  presence is recorded (`meta.managedPricingSet`). The `pricing:
  'configured'` value from PostModelSwitch is kept in `meta.enginePricing`.
- **Pricing modifiers.** No step reports fast mode, `inference_geo` (1.1×),
  batch discounts or partner-platform prices. The engine's ledger includes
  them; check the drift.
- **The 5m/1h cache-write split per step.** It shows only on a completed
  foreground Agent call's result (`agent.report.cacheWrite5m/1h`).
- **Server-tool dollar charges.** Charges such as web search at $10 per 1,000
  are not in usage.
- **Token count of a tool result.** Only its characters and UTF-8 bytes are
  known. Derive gives chars / 4 as an estimate, labelled as one.
- **Per-agent context-window fill.** `session.usage` and `measure` cover the
  main loop only. For each agent there is only the last and peak prompt size
  from its steps.
- **The `/context` grid (`gridRows`).** It is not stored, because it repeats
  the categories; `deriveContextGrid` rebuilds it.
- **Time to first token.** Measuring it would mean iterating the stream chunk
  by chunk with a clock call, so it is left out.
- **Compaction as an engine fork.** If the engine runs compaction as a fork
  whose steps pass `turn.step`, those steps are counted like any other loop.
  The compaction record keeps its own `usage` but does not add it to totals,
  so nothing is counted twice.
- **Model switches without a classic event.** These are inferred from main
  steps and marked `source: 'observed'`.

## Not verified in a live session (only through the test kit)

- **The separate `tool.call` registration for Agent.** It assumes "a hook
  does not hear what its own frame raised" is per hook, which is how the
  types describe it for `$.agent.spawn`. If it were per plugin, subagents'
  tool calls would go unseen; their step usage would still arrive through
  `turn.step`, and the Agent result's `report` would still cover totals. A
  quick live check: run a foreground Explore agent and confirm its Read
  calls show up in `tools` with its `agentId`.
- **Timers on a hook's `$`.** `$.clock.after` callbacks reuse the `$` of the
  hook that scheduled them, which is the documented pattern for timers. Tests
  exercise this only with `mock.clock`.
- **Version skew.** Types come from the skill's 2.1.308 d.ts, while the CLI
  here is 2.1.306, and the tests ran on its kit. The engine had not yet laid
  `.claude-plugin/types/` in the mod folder; it loads the mod when the turn
  ends. Once it has, re-run tsc against that copy.
- **Skipped hooks.** These show up as a dim line in the transcript (while the
  folder hot-reloads) or under `claude --debug`. Look once after the mod
  loads.

## Insights API (2026-10-26)

Added for the views still to be built (tabs, a band above the prompt): pure
derive functions in `hooks/insights.ts`, exported through `api.ts`, a new
`alerts` atom, the alert engine in collect.ts, and the manifest's first
`userConfig`. No drawing was added or changed. The contract change is additive:
new optional fields on stored types, one new atom, `SHAPE` still `v1`.

### Reading it

```ts
import { readInsights, ackAlerts } from './state'   // named imports: they take $
import { deriveBand, deriveBloat } from './api'     // pure
import * as collect from './collect'               // currentRules(): the userConfig rules in force
const s = await readInsights($)          // TelemetryState & { alerts }; subscribes to all 8 atoms
const band = deriveBand(s, await $.clock.now(), { rules: collect.currentRules() })
```

`readTelemetry($)` is unchanged and does not read `alerts`. Every insights
function takes the plain state (`TelemetryInsightsState` = `TelemetryState &
{ alerts? }`) and `now`; none reads the clock.

### Exports (`hooks/insights.ts`, all re-exported by `api.ts`)

- **`deriveBloat(s, now, { rareCalls?, rareIdleMs? })`**: what the context
  carries on each main request and whether anything calls it. Answers `{
  isReady: false, needsFullBreakdown: true, reason }` until a `full`
  breakdown has been taken (`context.lastFullAt`; the first `auto` refresh asks
  for one, and `collect.refreshContext(ioOf($), 'full')` forces one). Once
  ready it answers `{ isReady: true, isEstimate: true, rows, totals,
  breakdownAt, breakdownDetail }`. Each row has `key`, `kind`, `name`,
  `tokensPerRequest`, `deferredTokens`, `isDeferred`, `windowShare`,
  `callsThisSession`, `lastUsedAt` / `lastUsedAgoMs`, `requestsSeen`,
  `wasteTokens`, `estCostUsd`, `verdict`, `isTokenEstimate` and `detail`. Rows are sorted by waste,
  then by tokens. The kinds:
  - `mcp-server`: one row per server. The breakdown's MCP rows are per tool,
    and `recordBreakdown` sums them by server. Only the loaded schemas count
    toward the window; the deferred ones go in `deferredTokens` and are never
    waste. Calls come from `totals.byTool`, matched by the wire name's server
    segment (`mcp__<segment>__tool`, kept per server in
    `breakdown.mcpServerDetail`), because `/mcp`'s server name (`claude.ai
    Slack`) is not what tool names carry.
  - `skill`: one row per listed skill (`breakdown.skillRows`). Calls come
    from the new `totals.bySkill`, the Skill tool's `skill` argument. A
    breakdown without rows gives one `skills` row (the listing), with calls
    from `byTool.Skill`.
  - `custom-agent`: calls are spawns of that agent type.
  - `memory`, `system-prompt`, `slash-commands`: nothing calls them, so
    `verdict: 'n/a'` and `wasteTokens: null`.
  - `system-tools`: one row, because the breakdown gives no tokens per built-in
    tool. The built-in calls are counted, but the verdict is `n/a`.

  The verdict is `unused` (no call), `rare` (fewer than
  `BLOAT_DEFAULTS.rareCalls` = 3 calls, or none for `rareIdleMs` = 30 min),
  `active`, or `n/a`. `totals` has `windowTokens`, `inWindowTokens`,
  `deferredTokens`, `wasteTokens`, `estCostUsd`, `unused`, `rare`,
  `requestsSeen`, `model` and `cacheReadUsdPerMTok`.
- **`deriveCacheClock(s, now)`**: the main loop's prompt cache. It gives:
  - `lastRequestAt`: the start of the latest main request with usage. A
    cache read refreshes the TTL, so the clock runs from the start.
  - `ttl`, `ttlMs` and `ttlSource` (`switch` | `default`).
  - `expiresAt` and `expiresInMs` (negative once expired).
  - `status`: `warm`, `cooling` (under `CACHE_COOLING_MS` = 60 s), `cold` or
    `unknown`.
  - `invalidatedBy`: a compaction or a model switch after the last request
    makes the cache cold whatever the clock says.
  - `contextTokens`, `recacheCostUsd` (a write at the TTL's rate),
    `hitCostUsd` and `recacheExtraUsd`.
  - `lastTurnWasCacheMiss` and `missCostUsd`.
  - `isMainIdle` (no main turn open, or its loop is stale) and
    `oneHourWritesSeen`.
  - `agents`: the same per running, non-stale subagent with a request.
- **`deriveAlerts(s, now, rules?)`**: `{ active, log, unacked, burn }`.
  `active` lists the conditions true now, crit first, each as `{ key, kind,
  level, message, short }`. `log` is the stored atom's log, newest first.
  `burn` holds the spike rule's current rate, median and threshold. This is
  pure; firing happens in `stepAlerts`.
- **`stepAlerts(prev, active, now, rules)`**: the engine's reducer. It
  returns `{ next, fired, toasts, changed }` and never mutates `prev`.
- **`nextAlertCheckAt(s, now, rules)`**: the next moment something
  time-driven changes, or null.
- **`rulesFromOptions(options)`**, **`DEFAULT_ALERT_RULES`**,
  **`emptyAlerts(now)`**, **`alertsOrEmpty(value, now)`**: the rules and the
  alert state.
- **`deriveWorkflows(s, now, { groupBy: 'root' | 'turn' })`**: by default
  each root-level run (a child of main) with its descendants. With `turn`,
  every root spawned in one main turn is one workflow (`spawnedAt` within the
  main turn's span, from the `turns` ring); a root whose turn left the ring
  stays on its own. Each workflow has:
  - `id` (`root:<id>` | `turn:<id>`), `name` (the first root's label, plus
    `+N` for more roots: name, description or type, never prompt text),
    `rootIds`, `rootLabels`, `agentIds`, `types`, `turnId`.
  - `status`: running > stale > failed > done. A stale loop is never counted
    as running.
  - Counts: `agentCount`, `runningCount`, `staleCount`, `doneCount`,
    `failureCount`.
  - Spend: `tokens`, `costUsd`, `costShare` (of the tracked sum),
    `costPerMinute`.
  - Time: `startedAt`, `endedAt` (null while running), `wallMs` (first start
    to last end), `agentMs` (the agents' own durations summed: a nested run
    overlaps its parent, so both count) and `parallelism = agentMs / wallMs`.
  - `criticalPath`: the root-to-leaf chain spanning the most wall time, from
    its root's start to its leaf's end, the deeper chain on a tie. `agentId`
    is the leaf.
  - `longest`: the agent with the longest duration.

  Ghosts (`isFoldedAgent`: unattributed, or finished with nothing) are left
  out.
- **`deriveAgentFilter(rows, { status, query, includeMain, includeFolded })`**:
  the `deriveAgents` rows for a chip (`all` | `running` | `stale` | `failed` |
  `done`, grouped exactly as the Agents tab's `groupOf`) and a
  case-insensitive search over label, description, type and models. It
  returns `{ rows, counts }`, where `counts` are per chip over the rows that
  match the query (main and ghosts left out).
- **`deriveBand(s, now, { rules? })`**: one compact model for a bar above the
  prompt. It has:
  - `title` (`Opus 5.5`), `model`.
  - `costUsd` with `costSource` (`ledger` | `estimate`, as
    `deriveReconciliation`), and `trackedUsd`.
  - The `running` / `done` / `failed` / `stale` subagent counts (ghosts left
    out) and `burnUsdPerMin`.
  - `context`: `tokens`, `window`, `percent` (of the window), `fill`,
    `pressure` (of the auto-compact threshold, else the window), `tone` (by
    the alert rules' 70/90), `compactAtTokens`, `segments`,
    `isMessagesEstimate`, `freeTokens`, `bufferTokens`, `breakdownAt`.
  - `cache`: a summary of the cache clock.
  - `topAlert`, `alertCount` and `isActive`.

  The `segments` are system prompt, system tools, MCP tools, skills, memory,
  other and messages, each with its share of the window.
- **`formatStatusLine(band)`**: `$30.36 · ctx 25% · 3▶ · cache 3m`, with the
  top alert first (`!! ctx 94% · …` for crit, `! agent stale · …` for warn).
  The cache shows whole minutes, `<1m` in the last one and `cold` after, so
  the clock alone changes the text at most once a minute. The glyphs and
  wording are a placeholder: the view worker owns them, and the engine only
  needs a function that maps the band to a string.
- **`contextSegmentOf(name)`**, **`contextPressure(s)`**.
- Moved to `derive.ts` so insights need not import UI files (re-exported
  unchanged from `ui/header.tsx` and `ui/desktop/agents.tsx`): `isActive`,
  `groupOf`, `isFoldedAgent`, `AgentGroup`.

**`hooks/state.ts`** adds:
- `ALERTS`: the atom.
- `INSIGHTS`: the derive over all eight atoms.
- `readAlerts($)`, `readInsights($)`.
- `ackAlerts($, ids?)`: an `update` (read-modify-write with retry); every
  alert when `ids` is left out.
- In `ioOf`: `readAlerts`, `updateAlerts`, `toast`, `status`.

**`hooks/collect.ts`** adds:
- `configure(options)`: register calls it with its second argument.
- `currentRules()`.
- `evaluateAlerts(io)`.
- `peekAlerts()`: the memory used when the IO has no atom (tests).
- New optional `TelemetryIO` members: `readAlerts`, `updateAlerts`, `toast`,
  `status`.

### The alert engine

`evaluateAlerts(io)` runs inside `guard` at the end of `onSessionStart`
(every reload), `onStep`, `onTurnComplete` and `onMeasure`, and on its own
timer. One pass does the following:
1. It reads the `alerts` atom and computes `deriveAlerts`.
2. It steps the reducer. Only when that changed something, it writes through
   `updateAlerts`. That is `update($, ALERTS, fn)`: the reducer runs again on
   the value as it is then, so an ack the view wrote meanwhile is kept.
3. It raises the toasts, sets the status line, and arms one `io.after` for
   `nextAlertCheckAt`, kept between 1 s and 60 s. A pending timer that is due
   sooner covers a later one. A reload drops the timer, and the reload's
   `session.start` arms it again.

One pass runs at a time. A call made during a pass runs one more pass after it.

- **Memory in the atom, not the module.** A hot reload (each save) must not
  fire again what is already active, so the memory per key (`active`,
  `level`, `since`, `lastFiredAt`) and `lastToastAt` are stored. `/clear` and
  resume reset the atom with the telemetry.
- **Fire once, re-arm, cooldown.**
  - A key fires when it becomes active.
  - While it stays active it fires again only on an escalation from warn to
    crit (a de-escalation is silent).
  - It re-arms when it clears.
  - It does not fire again within `cooldownMs` (5 min) of its last firing,
    even after clearing.
  - An inactive key is forgotten once its cooldown has passed.
- **Toasts.** In `quiet` (the default) only crit raises a toast; in `all`,
  warn does too; in `off` nothing is kept. There is at most one toast per
  `toastEveryMs` (30 s): an alert that is held back stays in the log, with no
  later toast. Only crit conditions are the context at 90% and the budget
  spent, so by default a toast is rare.
- **The status line.** `$.ui.status` is "one per plugin", beside the
  engine's own notices, so it cannot clobber anyone else's line. When
  `statusLine` is on, it is rewritten only when its text changed, and no
  sooner than `statusEveryMs` (2 s); a held-back change arms a timer. When it
  is off, the line is cleared once per load, so turning the option off
  removes a line an earlier load set. The line is off by default.
- **The rules** (`DEFAULT_ALERT_RULES`; the options in brackets):
  - `context`: the context's share of the auto-compact threshold (or of the
    window when auto-compact is off) at `contextWarnPct` (70, [contextWarnPct])
    is warn, and at 90 crit.
  - `burn`: the 5-minute `burn.usdPerMinute` over `burnSpikeMultiplier` (3,
    [burnSpikeMultiplier]) × max(median of the last fifteen 1-minute bins,
    zeros included, $0.05/min). There must be at least 5 min since the first
    step. The floor keeps a near-idle baseline from turning every busy minute
    into a spike. It is warn.
  - `agent-stale:<id>`: `isStaleLoop`, ghosts left out. Warn.
  - `agent-long:<id>`: running past `agentLongRunMs` (30 min). Warn.
  - `tool-errors`: errors plus interrupts at 30% or more of at least 10
    finished engine calls that ended in the last 5 min (the same count as
    `deriveTools.errorRate`). Warn.
  - `cache-expiring`: main idle, the cache cooling (60 s left), and
    `recacheCostUsd` ≥ $0.10. Warn.
  - `budget`: when `budgetUsd` > 0, the session cost
    (`deriveReconciliation().totalUsd`) at 80% is warn, and at 100% crit.
- **Alert text.** It is built from figures, tool names and agent
  descriptions or types only. It never holds a tool's input (`label`) or
  error text; the tests check this with a fake secret in a Bash label and
  error.

### userConfig (`.claude-plugin/plugin.json`, accepted by validate)

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `alertsEnabled` | string, `quiet` / `all` / `off` | `quiet` | quiet: only crit toasts. all: warn toasts too. off: no alerts. A boolean reads as quiet / off. |
| `budgetUsd` | number | 0 | 0 is off. |
| `contextWarnPct` | number | 70 | Clamped to the crit value, 90. |
| `burnSpikeMultiplier` | number | 3 | Values under 1 are ignored. |
| `statusLine` | boolean | false | Pins the status line under the prompt. |

The values reach `register(on, options)`, and a change in `/config` reloads
the module with the new ones. In a test, set them with `test(name, { options
}, body)`.

### Observed, estimated, not derivable

- **Observed:**
  - per-tool and per-server call counts, last use, the per-skill Skill calls
    (new), and the spawns per agent type;
  - each row's breakdown tokens: estimates by the engine itself, counted with
    the token-count API in a `full` breakdown;
  - the loaded or deferred state of each MCP tool;
  - the start, prompt size and cache read / write of each request;
  - compactions and model switches;
  - agent status, spawn and end;
  - the engine's ledger.
- **Estimated (labelled in the field docs):**
  - `wasteTokens` and `estCostUsd`: they assume the row was in the prompt on
    every main request the mod saw, priced at the cache-read rate.
    Subagents' requests also carry tool schemas but are not counted, and a
    server connected mid-session is over-counted.
  - `recacheCostUsd` and `missCostUsd`: list prices. The rewritten part of a
    miss is min(cache write, the prompt of the request before).
  - The cache expiry assumes the TTL refreshes at each request's start and
    that only main's own requests keep main's prefix warm.
  - `ttlSource: 'default'`: 5 minutes is an assumption until a model-switch
    event reports the TTL. `switch` is over-generous: a switch event that
    reported no TTL also reads as `switch`, because whether one carried a TTL
    is not stored.
  - The band's messages segment, when the window was measured after the
    breakdown (the measured total less the breakdown's fixed rows).
  - An old breakdown's per-server loaded tokens (split by tool count,
    `isTokenEstimate`).
- **Not derivable:**
  - per built-in tool schema tokens (the breakdown has one "System tools" row);
  - the 5m / 1h split of the main loop's cache writes (only completed Agent
    reports carry it);
  - whether a memory file, the system prompt or a slash command "was used";
  - skills run as slash commands (they do not pass the Skill tool);
  - a subagent's own context breakdown;
  - the server-side cache state itself (the clock is inferred from request
    times).
- **Depends on the engine's wording:** the band's segments split the used
  rows by label (`System prompt`, `System tools`, `MCP`, `Skill`, `Memory`,
  `Message`; anything else is `other`), because `kind` cannot tell them
  apart. If the engine renames a row, it falls into `other`. The segments
  still add up.

### Contract change (additive)

- `types/index.d.ts` gains `TelemetryAlertLevel`, `TelemetryAlert`,
  `TelemetryAlertCondition`, `TelemetryAlerts`,
  `PluginState['session-telemetry'].alerts`, `TelemetrySkillStats`,
  `TelemetryMcpServerDetail` and `TelemetrySkillContext`.
- It also gains the optional `TelemetryTotals.bySkill` and
  `TelemetryContextBreakdown.mcpServerDetail` and `skillRows`. Values stored
  before these fields existed read as before: absent means `{}` or no rows.
- `BreakdownInput.skills` reads `skillFrontmatter`.
- Nothing existing was renamed or retyped, and `SHAPE` stays `v1`.

### Verification (2026-10-26)

- `claude plugin test <mod>`: 171 tests in 12 files pass, the 130 from
  before and 41 new ones.
  - `tests/insights.test.ts` (34): bloat with an unused MCP server over 200
    requests, the wire-prefix match, deferred schemas, skills, custom agents,
    the n/a rows, an old breakdown, and the not-ready state. The cache clock:
    expired during idle, warm, cooling, a miss, a compaction, a 1 h TTL, a
    busy main, subagents. Each alert rule, including the fake secret, ghosts
    excluded and off. The reducer: dedupe, re-arm, cooldown, escalation, the
    toast rate and modes, the 50-entry log. The rules from options and the
    next check. Workflows: 4 parallel children, the critical path, stale and
    failed runs, the ghost excluded, grouping by turn. The filter chips
    against `groupOf`, the search. The band: segments adding up, the
    messages estimate, the status line, tones. The two collector additions.
  - `tests/alerts.test.ts` (7): over a fake IO, fire once, escalate,
    dedupe, re-arm after the cooldown, one toast per 30 s, acks kept, `/clear`,
    the status line's change and rate and its clearing when off, the timer
    walking to the cache-expiry alert (each timer within 60 s), and no atom.
    Through the kit, `test(…, { options })` reaching the rules: a crit
    budget toast and the status line `!! budget 200% · $0.02 · ctx 1%`.
  - Fixtures are in `tests/insights-fixture.ts`.
- `claude plugin validate <mod>`: passes. It lists the new calls
  `$.ui.status` and `$.ui.toast` (via ioOf) and the `alerts` state reads and
  writes. The warnings are unchanged.
- `npx -p typescript@5.6.3 tsc -p <mod>/tsconfig.json` in place (the
  engine-laid types): clean.
- Headless load, `claude -p --plugin-dir <mod> --debug-file … "/telemetry
  full"`: the module loads with its events, the options are their defaults,
  `$.ui.status` is cleared once (the line is off by default) and no
  telemetry failure is logged.
- Not tested: `ackAlerts($)` against the real store. A test's own `$` has no
  `state` noun for another plugin's atoms, so the first press handler that
  calls it in the view is its first run. The engine's merge of an ack is
  tested over the fake IO.
- Not seen live: the hot reload into the running session (it lands when that
  session's turn ends). Look for a dim `session-telemetry: … skipped` line, or
  `telemetry skipped it` in the debug log, and for `$.ui.status
  (session-telemetry): (cleared)`, which shows the new session-start pass ran.
  Also not seen: the toast and the status line in a real terminal or on the
  desktop. Nothing draws the insights yet.

## Notes for the UI

- In a `ui.render` hook, draw from `const s = await readTelemetry($)` (named
  import from `./state`). Then pass `await $.clock.now()` to the derive
  functions from `./api`. Never write the atoms.
- Each event writes each atom at most once, so redraws follow activity.
  Elapsed time and the burn rate change with the clock alone; to keep them
  live, invalidate on a timer (`$.clock.every`).
- Calls in flight are `tools` events with `status: 'running'`. Live subagents
  are `agents.byId[id].status === 'running'`.
- `TelemetryToolEvent.label` holds the first 80 characters of the input. For
  Bash that is the command, which can contain inline secrets. Whether and how
  to show it is a UI decision.
- On a resumed session, `meta.startedAt` is the first launch, while the
  counters start at zero when the mod loads, so `elapsedMs` can dwarf the
  data. The burn rate uses `totals.firstStepAt` and is not affected.

## Verification

- **`claude plugin validate <mod>`** passes. Its only warnings are the missing
  `author` and the plugin-directory listing checks (README, LICENSE, icon),
  which don't matter for a local mod.
- **`claude plugin test <mod>`**: 130 tests in 10 files pass (72 data-layer,
  see the UI section for the rest). They include a hydration test, in which
  stored values are read back through `read($, TELEMETRY)` and counting
  carries on from them, derive tests for the reconciliation, the timeline,
  the harness block and a main loop first seen at 0, and the stale-loop
  tests (a ghost goes stale, is settled by the sweep and revived by a step; a
  live call keeps a loop fresh until STALE_TOOL_MS; the reconciliation
  applies the engine's list then sweeps; a reload settles lost ends; session
  start takes the list's word; a turn start looks a new loop up once).
- **Shape round trip.** A separate probe plugin in the scratchpad checked
  against the kit's real store that a raw `$.state.set(ref, { shape: 'v1',
  value })` reads back through a `{ shape: 'v1' }` atom via `derive` + `read`,
  and that a different tag reads as the initial value.
- **`npx -p typescript@5.6.3 tsc -p <mod>/tsconfig.json`** is clean, with
  `strict` and `noUncheckedIndexedAccess`. The mod's `tsconfig.json` extends
  the one the engine lays in `.claude-plugin/types/` at every (re)load, which
  covers `hooks/`, `types/` and `tests/`. (Before the engine had laid it, a
  copy of the d.ts header's tsconfig in the scratchpad did the same.)

## UI

Two rendering paths share the data layer, the `ui` atom, the press actions
and the scroll handler. `pane.tsx` picks one by `e.surface`: the **terminal**
draws the flex-and-glyph tree of `hooks/ui/term/` (see "Terminal design"
below); every other surface (desktop, vscode, mobile: the ones whose table
has `Svg`) draws the flex-and-Svg tree of `hooks/ui/desktop/` (see "Desktop
design spec" above). The two share one information architecture (header
with four tiles, one-row tab bar, the Agents hero with strip, lanes, table,
drawer and folds) and the pure pieces under it (`orderAgents`, `agentPhase`,
`windowItems`, the line-kit builders of the secondary tabs). Agents is the
first and the default tab on both (hotkeys 1-7 in the order Agents,
Overview, Tokens, Context, Tools, Flow, Live).

### Files

| File | What it is | Uses `$` |
| --- | --- | --- |
| `hooks/ui/pane.tsx` | `registerUi(on)` (called at the end of register.tsx): `command.run` for `/telemetry`, `ui.scroll` and `ui.render` for the pane (the surface branch); `startUi($)`, called from register.tsx's own `session.start` hook | Yes |
| `hooks/ui/svg.ts` | The SVG builders (bar, spark, stack, grid, gauge, dot, lanes, guide) and the palette; pure, no text in any markup | No |
| `hooks/ui/desktop/kit.tsx` | The desktop kit: `T4` (Box, Text, Button, Svg), `Item`/`DeskView`, the row heights `H`, `txt`/`cap`/`num`/`row`/`kv`/`section`/`card`/`tile`/`svg`/`dot` | No |
| `hooks/ui/desktop/window.ts` | `windowItems(heights, room, offset, select, pagerRows)`: a body's window by item heights (the desktop's estimates, the terminal's whole rows) | No |
| `hooks/ui/desktop/view.tsx` | `deskTree(T, input, o, onAct)`: header, tab bar, the windowed tab, the pager; answers `usedRows`, `maxOffset`, `agentIds` | No |
| `hooks/ui/desktop/header.tsx` | `deskHeader` (row 1 and the four tiles; row 1 alone under 14 rows), `deskTabs` (seven Buttons, the hotkey drawn once by the desktop's badge; `tabVariant` picks the label length) | No |
| `hooks/ui/desktop/agents.tsx` | The hero: `deskAgents`, and the pure pieces both paths use: `orderAgents` (main, running, stale, failed, done; the RECENT_DONE cap; the folds), `groupOf`, `isFoldedAgent`, `agentPhase` (a running agent's tool / waiting / model request; none when stale), `cellWidths`, `elapsedText`, `laneWidth` | No |
| `hooks/ui/desktop/overview.tsx`, `tokens.tsx`, `context.tsx`, `tools.tsx` (`callRowEl`), `flow.tsx`, `live.tsx` | One builder per tab, `(T, input[, o | onAct]) → DeskView` | No |
| `hooks/ui/term/kit.tsx` | The terminal kit: `T3` (Box, Text, Button), `Item`/`TermView`, `txt`/`segsEl`/`lineEl`/`linesEl` (runs and lines as truncating Texts), `cell`/`grow`/`trow` (flex cells and a one-row Box), `card` (a round-bordered Box), `fromView` (a line-kit TabView as items), `dotOf` (the status glyph) | No |
| `hooks/ui/term/view.tsx` | `termTree(T, input, o, onAct)`: header, tab bar, the body (a Box of exactly the rows left, which clips) with the windowed tab and the pager; answers `usedRows`, `maxOffset`, `agentIds` | No |
| `hooks/ui/term/header.tsx` | `termHeader` (row 1 and the four tiles as a flex row; one compact row under 14 rows or 36 columns), `headerRowsOf` | No |
| `hooks/ui/term/agents.tsx` | The hero: `termAgents` (strip, lanes, table, phase and stale lines, drawer, folds), `termCellWidths`, `laneSegs` | No |
| `hooks/ui/term/overview.tsx` | `termOverview`: the cost card, then the line kit's sections | No |
| `hooks/ui/ui-state.ts` | The `ui` atom (`{ plugin: 'session-telemetry', key: 'ui' }`, literal here) and its reads and writes: `readUi`, `setTab`, `selectAgent`, `moveAgent`, `scrollTab`, `toggleAllAgents`, `setBandMode`, `setAgentsMode`, `setAgentFilter`, `setAgentQuery`, `toggleWorkflow`; pure `stepAgent`, `stepScroll`, `bandModeOf` | Yes |
| `hooks/ui/band.ts` | The band's pure half: `bandShow`, `badgeTone`, `bandTab`, `barParts`, `allocate` / `segmentPx` (widths that add up exactly), `legendItems`, `bandChips` / `fitChips`, `cacheChip`, `fmtCountdown`, `compactParts`, `contextSummary` | No |
| `hooks/ui/desktop/band.tsx`, `hooks/ui/term/band.tsx` | `deskBand(T, band, opts, onAct)`, `termBand(T, band, opts, onAct)`: the band's two drawings | No |
| `hooks/ui/insights-view.ts` | What the insights views share: `alertBlock`, `rulesLine`, `cacheCard`, `bloatView`, `workflowCards`, `agentControls`, `alertLogRows`, the kind labels and verdict tones | No |
| `hooks/ui/layout.ts` | `layoutOf(props, viewport, surface)`, the `Layout`, `TabInput` and `TabView` shapes, `rowsOf(lines)` | No |
| `hooks/ui/cadence.ts` | `paneTickMs`, `bandTickMs`: the redraw cadence on the terminal and when every surface is remote (see "Remote monitoring") | No |
| `hooks/ui/header.tsx` | `tabBar` (the terminal's seven plain Buttons), `TAB_LABELS`, `TAB_ORDER`, `isActive(s, now)`, `fillGroup` | No |
| `hooks/ui/common.ts` | `NARROW`, `section`, `kv`, `statusGlyph`, `legend`, `shareBar`, `card`, `cardLine`, `safeError`, `toolName`, `limitName`, ... | No |
| `hooks/ui/tabs.tsx` | `buildTab(tab, input, overview)`: the line-kit builders of the secondary tabs | No |
| `hooks/ui/overview.tsx`, `tokens.tsx`, `context.tsx`, `tools.tsx`, `flow.tsx`, `live.tsx` | The line-kit builders: `TabInput` (state, ui, now, layout: plain data) to `TabView` (`head`, `items`, `foot`, `select`, `ids`); the terminal frame turns them into items | No |

Only `pane.tsx` and `ui-state.ts` take `$`. Every other file is pure and is
handed plain data, the element table and closures (a closure over `$` may
cross files; `$` itself only goes to same-file or named-imported functions).

### Contract change (additive)

`types/index.d.ts` gains `TelemetryUiTab`, `TelemetryUi` and
`PluginState['session-telemetry'].ui: Shaped<TelemetryUi>` (tag `v1`). It is not
in `STATE_KEYS`, so `/clear` and resume reset the telemetry but keep the
selected tab. `TelemetryUi.showAllAgents?: boolean` (added 2026-10-26, absent
reads as false) is the Agents tab's `+N done · show all` toggle. Nothing else
in the data layer changed. register.tsx now calls
`startUi($)` at the end of its `session.start` hook and `registerUi(on)` at
the marked spot: the engine refuses a second `session.start` registration
without a matcher in one module.

### Opening

- `session.start` (also fired on each hot reload) registers `/telemetry` and
  opens the pane unasked, without focus. The engine places an unasked pane only
  from 144 terminal columns (110 for an id the person opened before); below
  that it waits, and the reason goes to the debug log.
- `/telemetry` opens (or raises) it with `focus: true`, so the hotkeys work at
  once. `/telemetry full` also runs `collect.refreshContext(ioOf($), 'full')`.

### Terminal design (2026-10-26, parity with the desktop)

80x24 is the primary size; it degrades to 40x10 and grows to 160x50 with
wider cells and more lanes, not another design. One accent colour (`claude`)
for the shown tab, live things and bar fills; `success` / `warning` / `error`
only for state; everything secondary dim; theme keys only (no 24-bit colour),
so it reads on a dark and a light terminal alike. Graphics are monospace
glyphs on a dim track: thin bars draw the fill as a heavy rule (`━`, a half
cell `╸`; a sliver for any fill over nothing) on a light rule (`─`), the token
mix as `█▓▒░` density in the accent, sparklines as `▁▂▃▄▅▆▇█` with the last
value in the accent, section heads as dim rules `── name ────── count ──`,
tree guides as `├ ` / `└ `. Status glyphs are one set everywhere: `▶`
running, `◌` stale (warning), `✓` done, `✗` error, `■` stopped, `⊘` refused,
`○` idle. Prose is cut at the end, paths and ids in the middle; a cut never
takes a number.

**Layout by `Box`.** A row is a `Box` of `height={1}` with `overflow="hidden"`
and `gap={1}` (a number, not a step name: the terminal maps steps its own
way): a one-cell glyph cell, a name cell that grows and truncates
(`flexGrow`, a `Button`), then fixed numeric cells (`width`, `flexShrink={0}`,
`justifyContent="flex-end"`), so alignment comes from the layout. Monospace
makes padding safe, so where a line is one run of text (a line-kit row, a
left/right pair) it is one truncating `Text` laid out with the ui-kit's
`lr` / `fitSegs`. The body under the header and the tab bar is a `Box` of
exactly the rows left that clips, and every item's height is whole rows, so
the tree is never taller than the body and the engine's own window never
scrolls. The tiles are a flex row of four column Boxes `width="25%"`; the
drawer and the cost card are `borderStyle="round"` Boxes.

```
Opus 5.5 · ◐ live · 1 agent ▶                                          up 1h 00m
COST                TOKENS              BURN                CONTEXT
$3.21               1.24M               $0.10/min           ━━━━╸───── 45%
ledger $2.80        92% cached          5m window           of 1M
1: Agents  2: Overview  3: Tokens  4: Context  5: Tools  6: Flow  7: Live
▶ 1 running · 1 done · 1 failed                                        $0.10/min
draft the plan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶
nested check   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────
find every ca… ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────
               last 10m 00s                                                  now
  agent                                     tokens elapsed          ctx     cost
▶ main session                                999k  1h 00m ━━━╸──── 45%    $2.50
  ▸ Bash · 7s
▶ ├ draft the plan                             94k 10m 00s ╸───────  3%    $0.20
  ▸ model request · Haiku 5.5 · 10m 00s
✗   └ nested check                             94k  9m 00s ╸───────  3%    $0.10
✓ └ find every caller of the pricing table…    94k  9m 00s ╸───────  3%    $0.30
```

- **Header** (`term/header.tsx`): row 1, model (accent, bold) · `◐ live`
  (spinner) or `○ idle` · `N agents ▶` · `up` uptime at the right; then the
  four tiles, three rows: a dim upper-case label, a bold value, a dim second
  line: COST (tracked; `ledger $x`, `of $x` or the figure beneath, by the
  quarter's width), TOKENS (`92% cached`), BURN (`$/min`; `5m window`),
  CONTEXT (thin bar + % in the 70/90 tone; `of 1M`). Under 14 rows or 36
  columns the tiles give way to one compact row, the context fill first (kept
  whole or cut, never dropped), then cost, burn and tokens dropped from the
  right.
- **Tab bar** (`tabBar` in `header.tsx`): seven plain Buttons with hotkeys
  `1`-`7`, which the terminal draws once as `n: ` before each label. The shown
  tab is inverted in the accent; the others dim. The width fitter tries full
  names, then shorter ones (`Agents` → `Agt` → `Ag` → `A`), then the shown
  tab's own shorter names, before it gives up the gaps; at the dock's 24-cell
  floor the others lose their hotkeys (a click, or Tab and Enter, still
  switches) so all seven stay drawn. At 80 columns all seven are in full; at
  48, `1: Agents 2: Ov 3: Tk 4: Cx 5: Tl 6: Fl 7: Lv`; at 40 the others are one
  letter (the `n: ` prefixes alone take 21 cells).
- **Agents** (`term/agents.tsx`, the hero): the summary strip (`▶ N running ·
  M done · K failed · S stale`, the 5-minute burn at the right); the lanes
  (one row per subagent, the running first then the newest, up to 2 / 4 / 6 by
  the rows: the name in a fixed cell, then the lane lit `━` from its start to
  its end, to the edge with `▶` while it runs, in the status colour on a dim
  track; an axis row `last 40m 00s … now`); the table head; the rows, main
  pinned, then the running, stale, failed and done groups in spawn-tree
  order (`orderAgents`), each a flex row: glyph, guide + name (a Button:
  click selects; inverted and bold when selected), tokens (from 64 columns),
  elapsed (compact `10m` under 48), ctx (thin bar + % from 48 columns, the %
  alone under), cost. A running row has a dim `▸ Bash · 7s` or `▸ model
  request · Haiku 5.5 · 10m 00s` line (`agentPhase`); a stale row a `◌ stale ·
  no activity for 20m 00s` line in the warning tone and no phase. The done
  group shows the `RECENT_DONE` (8) newest roots and a `+N done · show all`
  Button (`agents:all`, kept in `ui.showAllAgents`; `show recent only` goes
  back); unattributed and empty finished loops fold into one dim `+N
  unattributed (no spawn seen, no usage)` line. The selected row opens a
  drawer (a round card): type · model · effort · background · in parent; the
  mix bar with in / out / cache r / w; the top tools; ctx peak · req · tools
  · err · duration; the report. Never a tool's input text. The cell widths
  (`termCellWidths`): under 48 columns elapsed 5 / ctx 4 / cost 6; to 63: 7 /
  10 / 7; to 99: tokens 6 / 7 / 12 / 8; from 100: 7 / 8 / 16 / 8.
- **Overview** (`term/overview.tsx`): the cost card (TRACKED THIS SESSION ·
  since; the tracked figure, bold; `ledger $x · untracked $y`; the drift when
  the estimate is over the ledger), then the line kit's sections: cost (per
  turn, cache, tok/min), activity, harness, rate limits, trends, notices; two
  columns from 100 cells.
- **Tokens, Context, Tools, Flow, Live**: the line-kit builders as before
  (tables above `NARROW` (60) cells, cards under; thin share bars; the mix bar
  and legend; the `/context` grid beside the categories from 64 cells; the
  recent calls log `age glyph tool (actor) target …… wall`; the flow tree with
  weight bars; the Live `now` line and the events newest first), each line a
  truncating `Text`, each item as many rows as it has lines, the foot (a
  legend) last. The width is `e.props.bodyColumns`; the height the lesser of
  `e.props.scroll.bodyRows` and `e.viewport.rows`.
- **Windowing** (`term/view.tsx`): the head items (strip, lanes, table head)
  stay while they fit and give way, from the bottom, until the first (or the
  selected) item has room; the items are windowed by `windowItems` with whole
  rows, a pager row `k: ▲ j: ▼  12–20 of 54` when they do not all fit, the
  window following the selection on Agents.

### Keys and pointer

- `1`-`7` switch tabs; a click on a tab works where the surface reports clicks;
  Tab walks the Buttons and Enter presses one.
- Up/Down, the wheel and PageUp/PageDown raise `ui.scroll` on the pane. The
  hook answers `{}` without `next` (the window stays) and moves the pane's own
  list instead: the selected agent on Agents, the tab's offset elsewhere
  (stored per tab in the `ui` atom, clamped to the last drawn maximum). `k` /
  `j` on the pager row do the same.
- Left/Right are not available: in a Pane the arrows are scroll keys, and a
  plugin receives raw keys only inside a `Client` surface module. Not built.
- Agent rows' name cells are Buttons (`agent:<id>`): a click or Enter selects
  one; the window shows the list's tail whole once the selection is in it.
  `agents:all` toggles the done group's recent cap.
- Context has `r: refresh full breakdown` (`collect.refreshContext(..., 'full')`).

### Live refresh

The drawing reads every telemetry atom through `readTelemetry($)` and the
`ui` atom through `readUi($)`, so each write redraws it. Elapsed times and the
spinner change with the clock alone, so while `isActive(s, now)` (a main or
agent turn in `meta.activeTurns` whose loop is not stale, a running agent that
is not stale, or a live call among the last 50 tool events) the render arms
one `$.clock.after(1000)` that calls
`$.ui.invalidate('ui.render')`; each redraw re-arms it while still active, and
nothing is armed when idle. The armed flag is a module variable (not drawing
state); a reload drops pending timers and the next active drawing re-arms.

### Safety of labels

Tool input labels are never drawn for shell tools (`Bash`, `PowerShell`,
`BashOutput`, `KillShell`, `Monitor`) or server tools, nor is their error text
(`safeError` in common.ts, shared by Tools and Live). Other labels go through
`shortLabel`: a URL becomes host + path (user info, query and fragment
dropped), a path its last two parts, anything else is cut. The timeline's
events carry the raw label as `toolLabel` and only `callRow` draws it. The
pane and derive tests check a fake secret in a Bash label and error never
reaches the drawing or the timeline's text.

### Verification (terminal parity, the tab labels and the stale fix, 2026-10-26)

- `claude plugin test <mod>`: 130 tests in 10 files pass. The pane suite
  (`tests/pane.test.tsx`, 17) mounts the terminal path through the kit and
  lays each tree out as text with `tests/term-render.ts` (below): every tab ×
  empty / populated / ledgerGap × 40x24, 80x24, 160x50 within its rows and
  columns, no shell text, no epoch duration, no `unknown`, the tab bar on row
  5 with each hotkey once (`1: Agents  2: Overview …`), the four tile labels,
  the tracked headline over the ledger, the context fill and the burn in the
  tiles, the shown tab in the accent; the 80-column header row by row; the
  40x24 header and cost card; 40x10, 30x6 and 24x4 compressing to the
  two-row header; the Agents strip, lanes, table rows, phase lines, guides,
  the drawer's five lines after a click, the pager moving the selection in a
  short pane, the wide drawer's tools; the ghosts (a stale row with its line,
  `1 stale`, `+2 unattributed`, the header counting one agent); the done cap
  and its toggle both ways; the frame's rows never over the body for every
  fixture × size × tab × selection × toggle (pure, `termTree`); `laneSegs`
  and `termCellWidths`; Tokens, Tools, Live, Overview (the card, then the
  harness), Context's refresh, `/telemetry`, session start, the tick, and
  idle with ghosts alone never keeping the pane live. `tests/frames.test.tsx`
  checks every frame of the three fixtures at five sizes fits, and prints
  them between `FRAMES-BEGIN` / `FRAMES-END` when its `PRINT` constant is
  true (the test sandbox has no `process`, environment or files). The desktop
  suite gained the stale row, the done cap and the plain tab labels; the
  data-layer suites the stale-loop tests.
- `tests/term-render.ts` is this suite's layout of the trees: a column of
  rows; row Boxes with fixed widths (cells or percent), one growing cell,
  numeric gaps, `flex-end`, round borders, truncating Texts, plain Buttons as
  `k: label`; the cells side by side as tall as the tallest; a Box's `height`
  cutting or padding. It follows Yoga within what the mod relies on and is
  not the terminal: a Text outside a cell, a step-named gap or a wrapping
  Text would differ. Its `renderText` pads and cuts every row to the width by
  construction, so the width check that means something is `fixedOverflow`:
  the fixed cells, texts, gaps and a growing cell's four-cell minimum of any
  row Box, against its width; it caught the Context tab's refresh row at 40
  columns (now every line-kit line goes through `fitLine` in `fromView`).
- Chosen and untested: a selected agent that leaves the view when the done
  cap hides it is not in `ids`, so the next arrow press moves the selection
  to the first row (`stepAgent`); a swept loop a later step revives has lost
  its `meta.activeTurns` entry, so its later tool events carry `turnId: null`
  until its next `turn.start`. The pure-text fallback (`draw.tsx`, the card
  `agents.tsx`) is gone: vscode and mobile take the desktop path, as before.
- `claude plugin validate <mod>`: passes (the same directory-listing
  warnings).
- `npx -p typescript@5.6.3 tsc -p <mod>/tsconfig.json` in place (the
  engine-laid 2.1.311 types): clean.
- Headless load `claude -p --plugin-dir <mod> --debug-file … "/telemetry
  full"` on 2.1.311: the module loads with all 15 events, `/telemetry` is
  listed and answers, no hook skipped or refused, no telemetry failure
  logged; `ui.render` does not run there (no surface).
- Looked at (`scratchpad/frames.txt`, the printed frames): every tab at
  80x24, and Agents at 40x10, 48x24, 120x40, 160x50, for the populated
  session, the ghosts (with the stale row's drawer open) and 21 done agents:
  the header and tiles, the one-row tab bar, the strip, the lanes, the table's
  alignment, the phase and stale lines, the drawer, the folds and the pager.
- Not seen live: the real terminal pane. What it will settle: whether the
  terminal lays a row Box's fixed cells and the growing Button cell out as
  the renderer does (the widths add up to the body, so an off-by-one would
  clip a cost's last digit rather than wrap), whether a column Box of fixed
  height clips its overflow as expected, the `inverse` of the selected name
  against the terminal's focus inversion, the `borderStyle="round"` card, and
  the `25%` tile widths; on the desktop, the width of the native hotkey badge
  (`tabVariant` budgets 4 cells per tab) and so whether the seven tabs hold
  one row at 48 cells.

### Verification (desktop path, 2026-10-26)

- `claude plugin test <mod>`: 119 tests in 9 files pass: the 96 before (the
  pane tests' desktop cases now run on the terminal path, whose text they
  asserted; the two terminal assertions on the tab order read `1: Agents`),
  13 in `tests/svg.test.ts` (every builder: markup well-formed, the stated
  size, an alt, bounded; fill clamps; the stack's shares, gaps and the
  sliver-as-dot rule; the sparkline's tail and scale; the gauge's arc; the
  dots; lanes clipped to the window; the grid's kinds; the theme-key hues) and
  10 in `tests/desktop.test.tsx`: through the kit on `desktop` and `vscode`,
  every tab × empty / populated / ledgerGap × 40x24, 48x24, 64x32, 120x50: the
  tree validates (the kit refuses an element or prop the surface lacks), the
  tracked headline and the ledger beneath it, no shell text, no epoch
  duration, no box glyph, no `unknown`, fixed cells within `bodyColumns - 2`,
  every Svg with an alt and a bounded source, the seven tabs each once with
  the hotkey in the label only and the shown one in the accent; the row budget
  (`deskTree(...).usedRows ≤ rows` for every tab, fixture and size, selections
  included); the Agents table (counts, phase lines `▸ Bash 7s` and `▸ model
  request · Haiku 5.5`, the lanes, no drawer unasked, no orphan footnote), a click
  opening the drawer and the pager moving the selection, the `+N other` fold;
  the Tokens total and untracked row and the mix legend; the Overview card
  (`ledger $1200.00 · untracked $1199.37`), harness and trends; Tools labels
  safe; the Live now row moving with the clock; Context's refresh asking
  `full`, the gauge and the grid in the category hues; and the pure window,
  `agentPhase`, `cellWidths`, `elapsedText`, `laneWidth`.
- `claude plugin validate <mod>`: passes (the same directory-listing warnings).
- `tsc` strict against the skill's 2.1.308 d.ts (scratch tsconfig): clean. In
  place, the engine-laid `claude-code-mcp/index.d.ts` still gives the two
  TS2589 sites noted below when the session has many MCP tools; on 2026-10-26 the in-place check (2.1.310-laid types) was clean too.
- Headless load `claude -p --plugin-dir <mod> --debug-file … "/telemetry
  full"` on 2.1.310: the module loads with all 15 events, `/telemetry` is
  listed, the command answers, no hook skipped; `ui.render` does not run there
  (no surface), so the desktop tree's acceptance rests on the kit's `desktop`
  and `vscode` mounts.
- Looked at (Chrome headless, `scratchpad/visual/gallery.png` and `mock.png`):
  every SVG builder on a light and a dark surface (bars, the sliver dot, the
  track, sparklines, the stack with gaps, the gauges, the five dots, lanes,
  the grid with buffer hatching, the guides), and a flex mock of the Agents
  tab at ~300px in both themes (header, tiles, tabs, strip, lanes, rows with
  phase lines, the drawer). The mock approximates the desktop's own Box and
  Text rendering (fonts, button chrome, cell widths) and is not the live pane.
- Not seen live: the real desktop pane. Unknowns it will settle: the px per
  cell (the full-width Svgs are sized at 6px per cell and clipped by their
  Box), the native button's chrome around the tab labels and the row names,
  whether `borderStyle="round"` draws as a CSS border (the drawer and the cost
  card), the desktop's size for the `xs`/`sm` spacing steps, and how many rows
  a padded row takes against the `H` estimates (under-filling is the designed
  failure; a tree taller than the body scrolls under the engine's window).

### Verification (UI, line kit, as of the previous pass)

- `claude plugin test <mod>`: 96 tests in 7 files passed then (the 64 data-layer tests
  plus 18 in `tests/ui-kit.test.ts` and 14 in `tests/pane.test.tsx`). The pane
  tests mounted through the kit on `terminal` and `desktop`: every tab, with the
  empty, the populated and the `ledgerGap` fixture (a $1200.00 ledger against
  $0.63 tracked, main first seen at 0, no engine start), at 40x24, 80x24 and
  160x50 (and 40x10, 30x6, 24x4 on the terminal), never more rows than given,
  no row wider than `bodyColumns`, no epoch-sized duration, the context bar and
  burn in every header, the hotkey hints as each surface draws them; the 40x24
  header's four rows; the tiles; agent cards, selection by click and pager and
  the untracked card; the Tokens untracked row and total; the Live now line
  moving with the clock; the harness block; the refresh Button and `/telemetry
  full` asking `session.usage` for a full breakdown; `session.start`
  registering the command and opening unfocused; the tick redrawing while
  active and nothing redrawing when idle (a minute on). The test's own row
  text mirrors the surfaces: `k: ` before a hotkey Button on the terminal only.
- The kit is the 2.1.306 CLI's; it accepted every element and prop used
  (`Button` `plain` / `hotkey` / Text children, `Text` `wrap` / `mono` /
  `weight` / `inverse`, nested `Text`, row `Box` with `height` / `overflow`).
- `claude plugin validate <mod>`: passes; warnings are only the missing
  `author` and the directory-listing checks (README, LICENSE, icon). It lists
  `command.run{command=telemetry}` as answering its own command, and
  `ui.scroll` as a gating hook with `.catch` (the catch keeps the window).
- `tsc -p <mod>/tsconfig.json` strict (the engine-laid tsconfig, as above): clean
  against the engine's API d.ts. One caveat: on a reload the engine also lays
  `.claude-plugin/types/claude-code-mcp/index.d.ts` with the session's
  connected MCP tools; in a session with some 300 of them (3,690 lines) tsc
  reports TS2589 ("type instantiation is excessively deep") at two unchanged
  sites that name a tool, `on('tool.call', { tool: /^(?!Agent$)/ }, ...)` in
  register.tsx and `$.tool.call({ tool: 'Bash', ... })` in tests/hooks.test.ts.
  The same code is clean with the 10-line stub that file holds in a session
  with few MCP servers (checked both ways on 2026-10-26); it is the depth of
  the engine's tool-name union, not the mod.
- Headless load: `claude -p --plugin-dir <mod> "/telemetry full"` on 2.1.306
  loads the module (all 15 events listed), registers `/telemetry`, prints
  `Telemetry pane opened; full context breakdown requested.`, and logs only the
  expected `no-surface` for the unasked open. No hook was skipped.
- Not seen live in an interactive session: the hot reload lands when the
  session's turn ends. Things to check there: the pane opens docked from 144
  columns (or via `/telemetry`); Up/Down reach the `ui.scroll` hook when the
  tree already fits the body (documented as "at its edges too"; `k` / `j` are
  the fallback); clicks on tabs and agent rows; the theme colours of the
  `/context` category keys in the grid; whether the selected agent row's
  `inverse` and the terminal's focus inversion cancel on the focused row.
- The row budget relies on the Pane's `scroll.bodyRows` (the tests supply it).
  The 2.1.306 binary contains `bodyRows` and `bodyColumns` (11 and 6 matches),
  so it is expected to send them; without `scroll`, `layoutOf` falls back to
  `viewport.rows`, the whole surface, and the tree would overshoot the body.
  Once the engine lays `.claude-plugin/types/` here, diff its `Pane` props
  against the 2.1.308 copy.
- Each hot reload re-runs `session.start`, so the pane reopens unasked (as in
  the skill's example), unless the person closed it by hand (since
  2026-10-27: `ui.paneClosedAt`, see "Remote monitoring").
- Not seen live either (the polish pass was verified through the kit, the
  type-checker and a headless load only): the desktop's native buttons for the
  tab bar, the pager and the refresh control, which the width fitter counts
  without a hotkey prefix and whose own padding is not knowable here (the tab
  bar is built a few cells under the width); whether the desktop keeps the
  accent colour inside a Button's children (the thin bars read by weight alone
  in case it does not); the `inverse` of the shown tab and the selected card's
  title line; the box-drawing tiles in the desktop's face.

## Desktop design spec (2026-10-26 redesign)

The desktop (and vscode, mobile: every surface with `Svg`) gets its own
rendering path, `hooks/ui/desktop/`; the line-based path above stays as the
terminal's. The person's verdict on the line-based pane in the desktop's
side pane (~40-48 cells, light and dark app theme) was "I don't like how this
looks": alignment faked with padded strings and block glyphs breaks in the
desktop's proportional face, every line had one weight, cards repeated
themselves, and the tab bar overflowed. The rules below replace that.

### Principles

- **Layout by `Box`, never by spaces.** Alignment is flex: `flexDirection`,
  `justifyContent="space-between"`, `flexGrow`, fixed `width` cells for numeric
  columns with `justifyContent="flex-end"`. No box-drawing or block glyphs
  on this path; no `mono` (one family, inherited); numbers `tabular`.
- **Graphics are `Svg`.** Bars, sparklines, the token mix, the context grid,
  the fill gauge, status dots, the agent lanes and the tree guides are SVG
  markup from the pure builders in `hooks/ui/svg.ts`. No text inside an SVG:
  labels are `Text` with theme keys, so the theme question for an SVG is
  only its fills, which are mid-tone hexes that clear 3:1 on both a light
  (`#fcfcfb`) and a dark (`#1a1a19`) surface. An `Svg` draws as an image, so
  theme keys and `currentColor` cannot reach it, and a `prefers-color-scheme`
  query would follow the OS rather than the app's theme; neither is used.
- **Three text sizes**: `caption` (labels, secondary rows, section heads),
  `body` (rows), `heading` (the four stat values). Weights: `regular`,
  `semibold` for names and headline values. Dim (`dimColor`) for secondary.
- **Spacing rhythm**: Box `gap`/`padding` in step names (`xs` ≈ 4px on the
  desktop's own scale, `sm`, `md`) and cells; rows carry `paddingY="xs"` so a
  row is at least ~28px tall as a click target; the pane has a 1-cell gutter.
  Dividers are spacing and section heads, not rules.
- **Colour**: the theme's `claude` key for text and Buttons of live things;
  `success` / `warning` / `error` for state words only; the SVG palette below.
- **One Button per thing that acts**: the 7 tabs, the name cell of each agent
  row (a `Button` may hold only strings and `Text`, so a row with an `Svg` in
  it is a `Box` whose name cell is the Button), the context refresh, the
  pager's two arrows, the done cap's toggle. A tab Button's `label` is the
  plain name (`Agents`) and its `hotkey` the digit: the desktop draws its own
  badge for the hotkey, so the digit shows once (2026-10-26: before, the label
  carried `1 Agents` too and the tab read `[1] 1 Agents`). The label length
  follows `tabVariant(cols)`, which budgets 4 cells per badge and the shown
  tab in full: full names from 68 cells, `Ovw`-length from 57, two letters
  from 48 (the brief's one-row target), and under that the row wraps
  (`flexWrap`), which `tabRows` counts.

### Tokens

| Token | Value | Where |
| --- | --- | --- |
| accent | `#d2704e` | running dot, bar fills, spark last point, lit lanes |
| good | `#2fa36b` | done dot, fill < 70% |
| warning | `#b8800f` | stopped/refused dot, fill 70-90%, rates 5-20% |
| danger | `#d9484e` | error dot, fill ≥ 90%, rates ≥ 20% |
| neutral | `#808080` | idle dot (hollow), spark history, "other" |
| track | `rgba(128,128,128,0.25)` | every bar's track, unlit lanes, free cells |
| mix ramp | `#e9a386 #d9825f #c25c3a #8f3f22` | token mix: in, out, cache read, cache write (ordinal, one hue) |
| categories | `#3b7dd8 #d2704e #1f9bb0 #b8800f #8b5cf6 #2fa36b` | context categories by theme key (`permission`→blue, `claude`→accent, `cyan_*`→teal, `warning`→amber, `purple_*`→violet, `success`→green; `inactive`/`promptBorder`/unknown→neutral) |

Validated with the dataviz skill's `validate_palette.js` on 2026-10-26: the
six categories pass every check in `--mode light` and `--mode dark` (worst
adjacent CVD ΔE 12.5, normal ΔE 21.8, all ≥ 3:1); the mix ramp passes
`--ordinal` in both modes; the accent clears both lightness bands. The four
status colours are not a categorical set (red↔amber is 5.6 CVD apart) and
never sit side by side as identity: a status always ships as a shape (filled,
hollow, ringed dot) and a word.

Status dots: running = filled accent with a thin accent ring (the "pulse"),
stale = a hollow dashed ring in the warning tone, done = filled good, error =
filled danger, stopped/refused = filled warning, idle/unknown = hollow neutral.

### Layout grid (cells across = `bodyColumns`, rows = `scroll.bodyRows`)

```
┌ header (3 rows) ────────────────────────────────┐
│ [Opus 5.5] ● live · 1 agent          up 1h 00m │  row 1: model chip · state · uptime
│ COST     TOKENS    BURN      CONTEXT           │  row 2-3: 4 tiles, flex row, 25% each
│ $3.21    1.2M      $0.02/m   ◔ 45%             │  (caption label over heading value)
├ tabs (1 row, wraps to 2 under ~56 cells) ───────┤
│ Agents  Overview  Tokens  Context  Tools  Flow  Live
├ tab body (the rest, windowed by estimated rows) ┤
```

Every item of a tab carries an estimated height in rows (a row Box 1, a row
with `paddingY` 1.5, a lanes strip 3, a drawer 6, a sparkline 2) and the body
is windowed by those estimates, pinned head first, a pager row when it does
not fit, the window following the selection on Agents; under-filling is
preferred to overflow, so the engine's own window never has to scroll and the
header stays put.

### Components (`hooks/ui/desktop/`)

| Piece | Shape |
| --- | --- |
| `Row` | `Box row alignItems=center gap=xs paddingY=xs`: cells |
| `Num` | `Box width=n justifyContent=flex-end` + `Text tabular` |
| `Label/Value` | `Box row space-between` with a dim caption label and a value |
| `Section` | caption, dim, uppercase title with a count at the right |
| `Card` | `Box column borderStyle=round borderDimColor paddingX=1` |
| `Tile` | `Box column flexGrow=1 width=25%`: caption label, heading value, caption sub |
| `Dot` | `Svg` 10×10 status dot |
| `Bar` | `Svg` w×6 rounded fill on a track (inline 36px; wide 120px) |
| `Spark` | `Svg` w×20 polyline, history neutral, last point accent |
| `Mix` | `Svg` stacked bar, 2px gaps, the mix ramp |
| `Grid` | `Svg` 10×10 squares, 8px each with a 2px gap |
| `Gauge` | `Svg` 18×18 ring gauge in the fill tone |
| `Lanes` | `Svg` one 6px lane per agent over the recent window, lit while running |
| `Guide` | `Svg` tree elbow for a nested row |

### Tabs (Agents first and default; hotkeys 1-7 in this order)

1. **Agents** (hero): summary strip (`N running · M done · K failed`, running
   $/min at the right); lanes strip; table head; rows: dot, guide + name
   (Button; truncated), elapsed (w 7), ctx bar + % (w 9), cost (w 8); a
   running row has a second dim caption line, `▸ Bash · 7s` or `model request
   · Opus 5.5 · 12s`; a stale row (a running loop gone quiet) has a `◌ stale
   · no activity for 20m 00s` line, a hollow dashed dot in the warning tone and
   no phase. Order (`orderAgents`): main pinned, then the running group
   (spawn order), the stale group, the failed group, the done group (newest
   end first; only the RECENT_DONE (8) newest roots unless the `+N done · show
   all` Button, `ui.showAllAgents`, says otherwise), each in spawn-tree order
   with depth indent; loops never spawned under this mod's eyes with no
   usage, and finished ones with no model and no usage, fold into one dim `+N
   unattributed` line. Selecting a row (click, or ▲▼ / wheel) opens an inline
   drawer under it: type · model · effort, tokens with the mix bar, top-5
   tools, context peak · requests · tools · duration, the report's figures.
   Never a Bash command's text (`shortLabel`).
2. **Overview**: cost card (tracked headline; footnote `ledger $x · untracked
   $y`), cost rows, activity rows, harness consumers with bars, rate limits
   with bars, trends sparklines, notices.
3. **Tokens**: model rows (share bar, cost), total; mix bar + legend; turns.
4. **Context**: gauge row + refresh Button + breakdown age; headroom; the
   grid beside the category rows (stacked under 48 cells); history
   sparklines; compactions; memory files; MCP servers; listings.
5. **Tools**: tool rows (calls, err, p50, share bar); servers; recent calls.
6. **Flow**: the agent → model / tool tree with weight bars.
7. **Live**: now row (dot, phase, since at the right); event rows: age
   (caption, w 4), actor (caption dim), text (grows, truncates), cost and
   duration at the right (tabular).

## Band (2026-10-26)

The band above the prompt: a `ui.render` hook on `{ component: 'AbovePrompt' }`
in `hooks/ui/pane.tsx`, drawn from `deriveBand(readInsights($), now, { rules:
collect.currentRules() })`. It imitates the engine's own context band.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ◆ telemetry                              450k of 1M · compacts at 800k  45%  │  row 1: title (Button) · summary · badge (Button)
│ ████████████████████████████████████──────────────────────────────────░░░░░░ │  row 2: one segmented context bar
│ ■ System tools 22k 2.2%  ■ MCP tools 15k 1.5%  ■ Messages 397k 40%           │  row 3: legend (least significant dropped to fit)
│ $3.21 tracked · 1 ▶ running · 1 done · 1 failed · $0.10/min · cache 4m 00s   │  row 4: chips
╰──────────────────────────────────────────────────────────────────────────────╯
◆ telemetry · $3.21 · ctx 45% ━━━━╸───── · cache 4m                               collapsed: one row
```

- **Rows.** Four content rows at most (`BAND_FULL_ROWS`), tested on both
  paths. The rounded box is CSS on the desktop; on the terminal it costs two
  rows, so it is drawn only when `e.props.maxRows` ≥ 6 (`BORDER_FROM_ROWS`),
  the four rows stand bare from 4 to 5, and under 4 the band is its compact
  row. The decision taken: the budget counts content rows, the terminal frame
  is chrome on top (six rows in all).
- **Modes** (`bandShow`): `/telemetry band auto|on|off|compact|full`, kept in
  `ui.band` (`TelemetryUi.band`, absent = `auto`; the `ui` atom survives
  `/clear`). `off` passes (`next(e)`), as does a survey (`hasSurvey`). `auto`
  (and `on`) draw the full band while `isActive`, the context tone is
  `warn`/`crit` (70/90 of the auto-compact threshold, the alert rules), or an
  alert is active; one compact row otherwise. `compact` and `full` force a
  shape. The command invalidates `ui.render` so the band follows at once.
- **Row 1.** `◆ telemetry` is a Button (`band:open`): it opens the pane,
  focused, on the tab the band points at (`bandTab`: an alert → Overview,
  context pressure → Context, else Agents); on the desktop it carries hotkey
  `t` (the native badge), on the terminal none (the `t: ` prefix would deface
  the title; Tab and Enter press it). At the right the dim summary (`450k of
  1M`, `· compacts at 800k` from 72 cells) and the solid badge: the percentage
  of the window, inverse in `success` / `warning` / `error` by
  `band.context.tone` (`badgeTone`), itself a Button (`band:context`) to the
  Context tab.
- **Row 2.** `barParts`: the used segments in `deriveBand`'s order, the free
  space, the auto-compact buffer. Widths by `allocate` (largest remainder, as
  `stack`, then a floor per positive part taken from the widest) so the cells
  add up to the width exactly; the desktop's `segmentPx` adds a 1px gap
  between neighbours and a 3px floor, the sum of widths and gaps being the
  bar's width. The desktop draws `segmentsSvg` (segment fills, the free space
  a half-height track, the buffer a faint fill under a diagonal `<pattern>`
  hatch) at `BAND_BAR_PX(cols)` = 7px a cell, within 160..1400 (chosen, not
  measured: the slot's px per cell is not known here). The terminal draws `█`
  per segment, `─` dim for free, `░` dim for the buffer. Desktop fills are the
  fixed `SEGMENT_HEX` map (the categories' palette, one hue per segment);
  terminal colours are the engine's own theme key for the first category of
  each segment (as `/context` draws it), the `SEGMENT_THEME` fallback only
  when the breakdown names none.
- **Row 3.** `legendItems`: swatch · label · bold value · dim share, for the
  segments by size with the buffer last; while they do not fit `cols - 2`
  cells the buffer goes first, then the smallest segment. Before the first
  breakdown the row says so.
- **Row 4.** `bandChips`, then `fitChips` (lowest `prio` dropped first; the
  cost chip stays): `$3.21 tracked` (`ledger` when the engine's figure is the
  larger), `3 ▶ running · 21 done [· 2 failed · 1 stale]`, `$0.15/min`, the
  cache chip (`cache 3m 12s` green while warm; amber while cooling with `·
  re-cache ≈$0.42`; dim `cache cold · re-cache ≈$0.42`; none when unknown),
  and the top alert (`! …` warn amber, `!! …` crit red, `+N` for more): its
  `message` from 100 cells, its `short` under, so the agents chip survives at
  80. On the terminal `fitGroups` fits the same groups.
- **Redraw cadence.** The band reads every atom (the alerts included), so it
  redraws on each write. It arms no timer of its own: while `band.isActive`
  it shares the pane's 1 s tick (`armTick`; `$.ui.invalidate('ui.render')`
  re-runs every render hook of the plugin), and the cache chip then shows
  seconds; idle, the chip shows minutes (`3m`, `<1m`), so its text changes at
  most once a minute with no tick.
- **Other bands.** The hook awaits `next(e)` and nests what came back beneath
  its own tree unless it is the engine's placeholder (`type: 'engine'`), the
  pattern savvy-progress uses, so the two bands stack; the hook has a
  `.catch` that passes the event on.
- **Status line.** `formatStatusLine`'s `!`/`!!` prefixes are kept as the
  band's own glyphs; nothing else in the data layer's wording was changed.

Looked at: the terminal frames (`tests/band.test.tsx` with `PRINT`, and
`views-frames.test.tsx`) at 40, 48, 80 and 120 cells, 10, 5 and 3 rows:
the bordered band, the bare four rows, the compact row, the legend dropping
items, the alert chip in both forms; and the desktop shape as an HTML mock
(`scratchpad/visual/band.html` → `band.png`, light and dark, 120 / 80 / 48 /
40 cells, running, breakdown, alert, 94% crit, compact and empty) with the
real `segmentsSvg` / `swatchSvg` / `barSvg` markup: the hatch reads on both
surfaces, the badge colours clear both backgrounds, the free track is thin.
Not seen live: the desktop's px per cell (a bar wider than the slot wraps or
clips as its Box says), the native Button chrome around `◆ telemetry` and the
badge, the `inverse` badge on a terminal theme, and whether `maxRows` is ever
under 6 outside fullscreen.

## Insights views (2026-10-26)

Drawn from `readInsights($)` (`TabInput.s` is `TelemetryInsightsState`; the
pane subscribes to the alerts atom too) and `collect.currentRules()`
(`TabInput.rules`). The pure pieces are in `hooks/ui/insights-view.ts`; each
tab draws them on both paths.

- **Header**: a dot (red for crit, amber for warn) and `! N` / `!! N` after
  the agent count while any alert is active (`alertBlock`). On the terminal
  the chip stays when the agent count has to go.
- **Overview**: first the alerts block when any alert is active or a budget
  is set: the section head (toned), one row per active condition (dot or
  `!`/`!!`, the message, `10m ago` from the condition's `since`), `rules ·
  ctx warn 70% · crit 90% · burn ×3 · tool errors 30% · stale 30m long run [·
  budget $20]`, an `ack N` Button (`ackAlerts($)`, hotkey `a`) while any log
  entry is unacked, the budget bar (`$3.21 of $10.00`) when `budgetUsd` > 0.
  Then the cost card, then the cache card: `CACHE warm|cooling|cold [·
  compacted|model switched]|no request yet`, the countdown (`3m 12s`) with a
  ring (desktop `gaugeSvg` of the TTL's share left) or a thin bar
  (terminal), then `ttl 5m (assumed)` (`(assumed)` while `ttlSource` is
  `default`), `context 60k tok to re-cache`, `re-cache ≈$0.30 · $0.29 over a
  hit`, `last turn served from cache` / `cache miss · ≈$x extra`, `main idle ·
  nothing refreshes it until you send`, running subagents' clocks. The card
  ticks while the pane shows Overview, main is idle and the cache is warm or
  cooling: 1 s under ten minutes left, 15 s above (`cacheTickMs` in
  pane.tsx); nothing is armed once cold. `armTick` keeps the shortest
  pending delay: a sooner ask (a turn starting under a 15 s cache tick) arms
  a second timer rather than waiting.
- **Context → bloat audit** (`bloatView`): under the headroom row, a section
  `BLOAT AUDIT · N rows · full 10m ago`, the summary (`4 unused items re-send
  ≈21k tok/request ≈ $0.25 this session`), the hint (`could be disabled: mcp
  claude.ai Slack, notion · skill pdf`, text only), the table by waste: kind
  (`mcp`, `skill`, `skills`, `agent`, `memory`, `tools`, `prompt`, `cmds`),
  name (a memory file by its last two path parts; `(deferred)` when all of
  it is outside the window), tok/request (`≈` when the figure is itself an
  estimate), a share bar (of the largest row; desktop from 64 cells, terminal
  by column priority), calls, last used (`never`, `5m ago`, `–` where calls
  are not observable), waste `≈$0.24`, the verdict toned (unused red, rare
  amber, active green, n/a dim). The desktop draws two-line rows under 56
  cells, the terminal cards under `NARROW`. The footnote states the estimate.
  Not ready (no full breakdown yet), the section shows the reason and a `run
  full breakdown` Button (`bloat:refresh` → the existing `refresh` action).
- **Live**: the active alerts are pinned under the now row; the stored log's
  entries (newest 20) are merged among the events by time as `! alert · …`
  rows, an acked one dim with `ackd` (`alertLogRows`).
- **Agents**: two control rows in the head: `Tree | Workflows` (Buttons
  `agents:tree` / `agents:workflows`; hotkey `w` on the other view) with the
  search `Input` (`agents:search`; Enter, `onSubmit`, writes `ui.agentQuery`,
  cut at 80 characters; `onInput` is left alone, because the drawn `value`
  replaces the typed text and a redraw per keystroke could lose one over the
  wire) at the right; then the chips `all ·
  running · done · failed · stale` with counts over the rows matching the
  query (`deriveAgentFilter`; Buttons `filter:<chip>`, hotkey `f` on the one
  in force cycles to the next). The tree view feeds the filtered rows to
  `orderAgents` (main pinned only with `all`); the workflows view
  (`workflowCards`: `deriveWorkflows` by root) draws one row per workflow:
  dot, `▸`/`▾` name (Button `wf:<id>` toggles `ui.expandedWorkflows`), `N
  agents · M running` (from 64 cells), cost, share bar, wall time, `×2.0`;
  open, a facts line (`critical path <leaf> · <duration>`, `N failed`, the
  types) and its agent rows (dot, name Button, elapsed, cost). A chip or a
  query hides the workflows none of whose agents match. `ui.agentsMode`,
  `ui.agentFilter`, `ui.agentQuery` and `ui.expandedWorkflows` are the new
  optional `TelemetryUi` fields (`types/index.d.ts`), read back safely by
  `clean`. The existing row-index assertions moved down two rows.
- **Data layer touched (additive):** `deriveFlow` now leaves unattributed
  loops out (`isUnattributed`), as every other view does, so the Flow tab
  draws no `unknown` node for a ghost. Nothing else in derive/insights
  changed; the status line's `!`/`!!` and the workflow name's `+N` stay.
- **Desktop row estimates.** The two control rows count `H.line` each; a
  workflow row `H.row` plus `H.line` per open line; a bloat row `H.line`
  (two under 56 cells). `deskTree` now pops head items until the first (or
  selected) item has room, as the terminal frame does, so a 40x24 pane with
  a drawer open stays within its rows.

### Verification (band and views, 2026-10-26)

- `claude plugin test <mod>`: 189 tests in 15 files pass (the 171 before, 6
  in `tests/band.test.tsx`, 11 in `tests/views.test.tsx`, 1 in
  `views-frames.test.tsx`). The band: terminal × 40/48/80/120 × 10/5/3 rows
  × empty / populated / alert / breakdown (rows ≤ 4 content, the width, no
  secret / `unknown` / epoch, the badge, the bar row, the alert chip, the
  legend, the hatched buffer); desktop and vscode (the round Box, four
  content rows, the `<pattern>`, the segment colours, the swatches, no box
  glyphs); idle collapsing, a crit badge red; a survey and `band off`
  yielding with another mod's band kept beneath, `band compact` forcing one
  row, a bad mode answered with usage; the title and badge presses opening
  the pane on Overview and Context; the geometry (`allocate` sums, floors,
  `segmentPx` with gaps, `segmentsSvg`, tones, countdown, chip fitting,
  `bandShow`, `bandTab`, legend dropping). The views: every tab × both paths ×
  4 sizes × empty / populated / alerts / bloat within rows and width with no
  artefact; the frame budget in both agent views; the Overview's alerts
  block, rules, ack writing the atom (`state.set` observed), the cache card
  order and ring/bar; the cache clock ticking idle and going cold; the bloat
  audit ready and not (the Button asking `full`), sorted by waste, the hint
  and footnote; the Live rows; the Agents controls, chips, search (`ui.input`)
  and workflow cards kept across a remount; the pure pieces.
- `claude plugin validate <mod>`: passes (the same directory-listing
  warnings; it lists the new `ui.render` registration and the `ui.scroll`
  catch as before).
- `npx -p typescript@5.6.3 tsc -p <mod>/tsconfig.json` in place: clean.
- Headless load, `claude -p --plugin-dir <mod> --debug-file … "/telemetry band
  compact"`: the module loads with its 15 events (`ui.render` among them),
  the command answers `Telemetry band: compact.`, no hook skipped or refused;
  only the known `ui.open: no-surface` line.
- Not seen: the hot reload into the live session (no debug log of it is
  readable from here: `~/.claude/debug/latest` points at a file that no
  longer exists), the real band under the prompt on either surface, the
  Input's chrome on the Agents head rows, `ackAlerts($)` against the real
  store (its first run is the first `ack` press).

## Agent drawers and task progress (2026-10-26)

### Plan data (`hooks/model.ts` `recordPlan`, called from `collect.ts` `onToolEnd`)

- `TelemetryAgent.plan?: TelemetryAgentPlan | null`: `{source, done, total,
  current? (≤80), items? (≤30 of {text ≤80, status, id?}), title?, phase?,
  updatedAt}`. Bounded: 200 agents × 30 items × 80 chars.
- Sources (`PLAN_TOOLS`), only on a call that answered (no deny, not
  `isError`):
  - `mcp__savvy-progress__step` (`done` required; `total` falls back to the
    previous step plan's, else 0; `note` → current);
  - `mcp__savvy-progress__progress` (main only; ignored unless one known
    field is valid; merged with the previous progress plan; items from task
    titles by index against `done`; `finished` marks all done);
  - `TodoWrite` (current = the in-progress item's activeForm; an empty list
    clears only a todos plan);
  - `TaskCreate` / `TaskUpdate` / `TaskList` (id from `result.task`; status,
    subject and `deleted` updates; TaskList replaces from `result.tasks`;
    capping drops done items first).
- Defensive: every input shape is checked; unknown shapes are ignored;
  `recordPlan` and `planKeys` are wrapped in try/catch.
- Privacy: only the text the model wrote (todo content/activeForm, step
  note, task subject, progress titles) is kept, through `planText`: control
  chars stripped, whitespace collapsed, URLs to host+path (userinfo, query,
  fragment dropped), `user:pass@`, `bearer|basic <tok>`, `key|token|secret|
  password|pwd|credential|auth = value`, known key prefixes (`sk-`, `pk-`,
  `rk-`, `gh?_`, `github_pat_`, `xox?-`, `AKIA`/`ASIA`, `AIza`, JWT) and long
  mixed letter+digit runs become `•••`; clipped to 80. `planText` is its own
  redactor in the data layer (it does not call `ui-kit.ts` `shortLabel`,
  which treats a whole label as one URL/path); it applies shortLabel's URL
  rule to every URL inside the text, plus the rules above. Never tool outputs,
  never Bash commands. Test: the fixture's todo with `SECRET` and a URL with
  `user:hunter2@…?token=…`.

### Attribution

- A subagent's own tool calls carry `agentId` and reach the non-Agent
  `tool.call` hook, so `step`, `TodoWrite` and `Task*` are recorded on that
  agent. Verified in the kit only (a nested `$.tool.call` with `agentId`
  inside the Agent call); not yet watched live with a real subagent.
- `progress` is main-only by design. The Task* list is session-shared in
  Claude Code but is attributed to whichever agent made the call.

### Derive (`hooks/derive.ts`)

- `deriveAgentPlan(agent, now, isRunning)` → `TelemetryAgentRow.plan`:
  fraction (null without a total), currentTask, hiddenItems, isStale
  (running and older than `PLAN_STALE_MS` = 10 min), isComplete, title.
  `planCountText` gives `3/7` or `3 done`.

### Drawers (both surfaces)

- `ui.expandedAgents` (deduplicated, last 100) is the open set; `ui.agentId`
  is the focused row and opens nothing by itself. `agent:<id>` toggles
  (`toggleAgent`); `agents:collapse` (`c`) and `agents:expand:<ids>` (`e`,
  the closed running rows) on the chips row. Chevron `▸`/`▾` (Text on the
  desktop).
- An open row and its drawer are one item with `parts` (the row, then the
  drawer a line at a time); `flattenItems` splits an item taller than the
  body into its parts, and `selectTo` keeps the focused row's drawer in view
  (`windowItems` brings the end in, then the start wins). The pager counts
  parts.

### Look

- Running row with a plan: `▸ <current task>` + thin accent bar + `3/7`
  (neutral/dim when stale), else the phase text. Done/error rows: a faint
  `✓ 7/7` / `2/5` before the tokens (≥44 cells desktop, ≥48 terminal).
  Drawer: head `plan · steps|todos|flow|tasks[ · stale]` + count, checklist
  `✓ ▸ ○` (≤8 lines, `+N more`). Workflow cards: `N/M tasks` in the counts.
  No plan → no bar, no count. Header and band unchanged.

### Contract change (additive)

- `TelemetryAgent.plan`, `TelemetryAgentPlan*` types,
  `TelemetryUi.expandedAgents`; `api.ts` exports `deriveAgentPlan`,
  `PLAN_STALE_MS`, `planCountText`, `TelemetryAgentPlanView`, `PLAN_TOOLS`,
  `planText`. `Item.parts`, `DeskView/TermView.selectTo`.

### Tests

- New `tests/plans-fixture.ts`, `tests/plans.test.tsx` (16): reducer per
  tool, caps, unknown shapes, redaction, derive, kit attribution, toggle /
  multi / collapse / expand on both surfaces, stale, no plan, frames
  (3 fixtures × 6 sizes × 3 open sets × 4 focuses × both surfaces), window
  and flatten units. `PRINT = true` prints the frames.
- Changed: `pane.test.tsx` row regexes include the chevron, the chips row
  ends `… e: expand running`, the budget test adds the plans fixture and an
  `expandedAgents` axis (60 s timeout); `desktop.test.tsx` the same axis.

### Verification (2026-10-26)

- `claude plugin test`: 205 pass in 16 files. `claude plugin validate`:
  passes with the known warnings. `tsc` (5.6.3, strict): clean.
- Headless load `claude -p --plugin-dir <mod> "/telemetry full"`: module
  loads with its 15 events, plugin admitted, command answers.
- Not seen: the live hot reload, a real subagent's TodoWrite/step arriving
  with its `agentId`, the desktop pane rendered for real (trees only).

## Remote monitoring (2026-10-27)

The case: a session runs on machine X (often started via Remote Control) and
the person watches it from the Claude desktop app on another machine, which
attaches to the session as a remote surface. Everything below is in
`hooks/ui/pane.tsx` (the hooks), `hooks/clients.ts` (pure reducers and rules),
`hooks/ui/cadence.ts` (pure cadence), `hooks/ui/ui-state.ts` (the `clients`
atom and `ui.paneClosedAt`), `hooks/ui/svg.ts` and `hooks/ui/desktop/view.tsx`
(payload).

### Events hooked (added; 20 events in all, `session.receive` new among them)

| Event | What it does |
| --- | --- |
| `session.attach` | Observe: `await next(e)`, then records the client (`recordAttach`) and, on `desktop` or `vscode`, opens the pane unasked and unfocused (`$.ui.open({ id: 'session-telemetry', title: 'Telemetry' })`, no `focus`) unless `ui.paneClosedAt` is set. A reconnect (the same `clientId` again) goes the same way. Returns what `next(e)` returned. |
| `session.detach` | Observe: records the departure (`detachedAt`, `detachReason` `detach` / `end`). |
| `ui.close` `{ id: 'session-telemetry' }` | After `next(e)`, an origin `person` close (the close mark or key) sets `ui.paneClosedAt`; `plugin` and `unload` closes do not. `.catch` passes on. |
| `session.receive` `{ origin: { kind: 'bridge' } }` | A Remote Control delivery: `bridgeSeenAt` is set once (a read, a write only the first time; the text is never read). `.catch` passes on. |
| `prompt.submit` | The same when `e.origin.kind === 'bridge'`; every other prompt passes untouched. `.catch` passes on. |
| `session.start` (existing) | `startUi($, e.surface)` now also records `startSurface` and the host (`$.env.get('HOSTNAME')`, the only env read), and skips the unasked open while `ui.paneClosedAt` is set. |

### State (additive)

- `clients: Shaped<TelemetryClients>` (tag `v1`, `{ plugin: 'session-telemetry',
  key: 'clients' }` literal in ui-state.ts): `clients[]` of `{ surface,
  clientId, attachedAt, lastSeen, detachedAt, detachReason, attaches,
  viewport }` (at most 20, the oldest detached dropped first), `startSurface`
  (`session.start`'s `surface`; absent when no start was seen), `bridgeSeenAt`,
  `host`. Not in `STATE_KEYS`: `/clear` keeps it.
- `TelemetryUi.paneClosedAt?: number` (kept by `clean`). `/telemetry`, and the
  band's title or badge (both open the pane with `focus`), clear it
  (`openPane($, true)` → `clearPaneClosed`).
- `deriveClients(v, now)` (exported from `api.ts`): `attached`, `detached`
  (newest first), `remoteAttached`, `reconnects`, `lastAttachAt`, `ageMs`,
  `startSurface`, `isBridged`, `host`.

### Cadence

- One shared timer for every component (`armTick($, now, ms, remote)`): one
  pending redraw, kept by its due time; a sooner ask arms a new timer and the
  later one finds itself superseded and does nothing; a pending redraw more
  than 5 s past due is treated as lost (its timer died with a reload).
- **Remote-only** (`isRemoteOnly(e.surface, clients)`): the drawing is not on
  the terminal and `startSurface` is not `terminal` (no terminal binding).
  Unknown (no start seen) counts as not remote, so the terminal's behaviour is
  what an unknown case gets; every pre-existing test runs that way.
- Terminal (unchanged): 1 s while `isActive` or on the Live tab; the
  Overview's cache clock 1 s under ten minutes left, 15 s above; the band 1 s
  while `band.isActive`.
- Remote-only: the pane 2 s (`REMOTE_TICK_MS`) while active or on Live, 15 s
  (`REMOTE_CACHE_TICK_MS`) for the cache clock; the band arms nothing and its
  cache chip shows minutes. When a remote-only tick fires, `$.ui.panes()` is
  asked: unless the pane is listed with `isPlaced: true`, nothing is
  invalidated, so no redraw crosses the wire and the chain stops until the
  next write (a failing `panes()` call counts as drawn).

### Payload caps

- Svg builders (`SVG_CAPS`): lanes ≤ 120 (the rest counted in the alt:
  `N more not drawn`), the band's segments ≤ 120, sparkline points ≤ 120, the
  context grid ≤ 200 cells (the side clamped to 14). The callers already drew
  fewer; these are clamps.
- Memo: `spark`, `stack`, `segments`, `grid`, `lanes` answer the very same
  spec for the same data and size (key: the builder, the drawn data and the
  options, so the width is part of it); a bounded map of `SVG_MEMO_MAX` (64),
  least recently used dropped. A running lane's `to: now` changes every tick,
  so lanes re-key while something runs.
- The desktop frame's budget (`deskTree`): at most `PAYLOAD_TEXT_BUDGET`
  (36,000) characters of tree text (every string: Texts, labels, Svg markup)
  and `PAYLOAD_JSON_BUDGET` (80,000) serialized. Over either, the room is
  shrunk (proportionally, at least one item per pass) and the pager shows: a
  tall pane over a large session under-fills rather than ship a huge tree.
  Ordinary panes never reach it (every pre-existing desktop test is
  unchanged). Measured before: the populated-max fixture at 200x120 drew a
  177k-character serialized Flow tab.
- Test: the populated-max fixture (`withManyDone(withPlans(withGhosts(...)),
  60)`, over 60 agents, every drawer and every workflow open, show-all) on desktop
  at 40x24, 48x24, 64x40, 120x50 and 200x120, every tab, tree and workflows:
  tree text < 40,000 and the drawn tree serialized < 90,000. The kit's drawn
  JSON is a few percent over what the frame measures (its own fields).

### Header chip

`remote · <machine>` (a caption after the alert chip on row 1 of the desktop
header) when the drawing surface is not the terminal and a Remote Control
delivery was seen (`bridgeSeenAt`). The machine is `HOSTNAME`'s first label
when the environment has it, else the working directory's last part
(`meta.cwd`), else just `remote`. No field of `$.session` names the host or
says the session was started via Remote Control; the bridge origin is the only
observable, so before the first remote prompt there is no chip (not faked).
The terminal path draws none.

### Tests (`tests/remote.test.tsx`, 20)

- Pure: attach / reconnect / detach and the counts, the bound, a foreign
  value, start / bridge / host, `isRemoteOnly`, `shouldAutoOpen`,
  `remoteChip` / `hostOf`, `paneTickMs` / `bandTickMs`.
- Kit: a desktop attach opens the pane unfocused, a phone does not, a
  reconnect and a vscode client open it again; the `clients` writes; a
  closed pane stays closed on attach and `session.start` until `/telemetry`
  (which opens with focus and clears the mark); remote-only 2 s (no redraw
  at 1 s, one at 2 s), none while `ui.panes` says not placed, the cache clock
  at 15 s; with a terminal binding a desktop drawing keeps 1 s; the Svg caps
  and memo; the populated-max payload; detach → unmount →
  `collect.resetForTests()` + `session.start` (the hot-reload hydrate) →
  re-attach (the pane opened again) → remount: the same `$3.21` headline,
  the Agents tab in the accent, a1's drawer still open; the chip after
  `$.session.receive({ origin: { kind: 'bridge' } })` with `HOSTNAME`
  mocked, none on the terminal, none before.

### Verification (2026-10-27)

- `claude plugin test`: 225 pass in 17 files (the 205 before and 20 new).
- `claude plugin validate`: passes (warnings: LICENSE, icon). It lists the new
  hooks, `$.ui.panes (via isPaneDrawn)`, `$.env.get (via hostName)`, env
  reads `HOSTNAME`, and `session-telemetry.clients` reads and writes.
- `npx -p typescript@5.6.3 tsc -p tsconfig.json` in place (the engine-laid
  2.1.308 types): clean. One pre-existing error in `tests/plans.test.tsx`
  (`agentId` not in the laid `TodoWrite` type) was cast `as never`, as the
  next line there already was.
- Headless `claude -p --plugin-dir <mod> --debug-file … "/telemetry full"`
  (2.1.311): loads with 20 events, admitted, the command answers, no hook
  skipped or refused, only the known `ui.open: no-surface`.

### Not verified live (kit only)

- `ui.close` is not raisable from a test (`$.ui.close` and the event are not
  on a test's `$`), so the person-close hook is untested; only its state
  transition (`markPaneClosed` / `clearPaneClosed` through a seeded `ui`) is.
- `$.ui.panes()`, `$.session.surfaces()` and `$.ui.open()` have no kit
  implementation; the tests answer them. Whether the desktop app reports
  `isPlaced: false` for a pane it is not showing, and whether a remote attach
  is followed by a `ui.render` for an already open pane, are not seen.
- `startSurface`: assumed `terminal` under a REPL that enabled Remote Control
  and null for a session with no terminal binding, as the types say; not
  observed for a Remote-Control-spawned session.
- Whether a desktop prompt over Remote Control raises `session.receive` with
  origin `bridge`, `prompt.submit` with origin `bridge`, or both.
- `HOSTNAME` is usually not exported on macOS (zsh's `HOST` is a shell
  variable), so the chip will most often show the cwd's last part.
- The 2 s / 15 s cadence and the payload budget on a real desktop pane (how
  many characters the engine actually serializes per redraw).

