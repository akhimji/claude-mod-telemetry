// session-telemetry: the desktop Agents tab, the hero: "htop for the harness".
//
// A summary strip (`N running · M done · K failed`, the burn at the right), a
// swim-lane strip (one thin lane per subagent over the recent window, lit while
// it runs), then the process table: one dense row per agent, main pinned at the
// top, then the running group (spawn order), the failed group and the done
// group (newest first), each in spawn-tree order with the depth drawn as an
// indent and a tree guide. A row is: status dot, name (a Button: click
// selects), elapsed, context bar + %, cost, in fixed cells. A running row has a
// second dim line saying what it does now (its running tool, or the model
// request in flight, with the time in that phase). A running loop that went
// quiet (isStaleLoop) is in the stale group with a `◌ stale` line and no
// phase. The done group shows the RECENT_DONE newest, with a `+N done · show
// all` Button (ui.showAllAgents). Agents never spawned under this mod's eyes
// with nothing to show, and finished ones with no model and no usage, fold
// into one dim `+N unattributed` line.
//
// The selected row opens an inline drawer: type · model · effort, the tokens
// with a stacked mix bar, the top tools, context peak · requests · tools ·
// duration, and the foreground report's figures. Never a tool's input text.
//
// Exports: deskAgents(T, input, onAct), agentPhase, orderAgents, groupOf,
//          isFoldedAgent, RECENT_DONE (pure, shared with the terminal path)

import type { RenderElement } from 'claude-code'

import type { TelemetryState } from '../../../types'
import { ageOf, deriveAgents, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtUsd, groupOf, isFoldedAgent, isStaleLoop, isTime, sessionAgeMs, sessionStartOf, type AgentGroup, type TelemetryAgentPlanView, type TelemetryAgentRow } from '../../derive'
import { modelLabel } from '../../pricing'
import { ACCENT, fillTone, fmtAgo } from '../../ui-kit'
import { toolName } from '../common'
import { agentControls, PLAN_GLYPH, planChecklist, planCountText, planTaskText, workflowCards, type AgentControls, type WorkflowCard } from '../insights-view'
import type { TabInput } from '../layout'
import { barSvg, guideSvg, lanesSvg, PALETTE, stackSvg, toneHex, type DotStatus, type Lane } from '../svg'

import { cap, card, dotOf, dot, H, kv, modelShort, num, row, svg, toneOf, truncateTo, txt, type DeskView, type Item, type T4 } from './kit'

/** What an agent does now: its running tool, or the model request since its last activity. */
export type AgentPhase = { kind: 'tool' | 'request' | 'waiting'; text: string; sinceMs: number | null }

/**
 * The phase of a running agent: the newest running tool call of its own
 * (`tool · Read`), `waiting on a subagent` while its running call is the
 * Agent tool, else a model request in flight since its last step or tool
 * ended (or its spawn). Null for an agent that is not running.
 */
export function agentPhase(s: Pick<TelemetryState, 'tools' | 'steps' | 'agents' | 'meta' | 'totals'>, id: string, now: number): AgentPhase | null {
  const agent = s.agents.byId[id]
  if (!agent || agent.status !== 'running') return null
  // a loop gone quiet has no phase: it is not doing anything this mod can see
  if (id !== 'main' && isStaleLoop(s, id, now)) return null
  const age = sessionAgeMs(s, now)
  let running: { tool: string; startedAt: number } | null = null
  let lastEnd: number | null = null
  for (let i = s.tools.length - 1; i >= 0; i -= 1) {
    const ev = s.tools[i]
    if (!ev || ev.agentId !== id) continue
    if (ev.status === 'running' && isTime(ev.startedAt)) {
      if (running === null || ev.startedAt > running.startedAt) running = { tool: ev.tool, startedAt: ev.startedAt }
    } else if (lastEnd === null && isTime(ev.endedAt)) lastEnd = ev.endedAt
    if (running !== null && lastEnd !== null) break
  }
  if (running !== null) {
    if (running.tool === 'Agent') return { kind: 'waiting', text: 'waiting on a subagent', sinceMs: ageOf(now, running.startedAt, age) }
    return { kind: 'tool', text: toolName(running.tool), sinceMs: ageOf(now, running.startedAt, age) }
  }
  let lastStep: number | null = null
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    const step = s.steps[i]
    if (step && step.agentId === id && isTime(step.endedAt)) {
      lastStep = step.endedAt
      break
    }
  }
  const spawn = isTime(agent.spawnedAt) ? agent.spawnedAt : isTime(agent.firstSeenAt) ? agent.firstSeenAt : null
  const since = [lastStep, lastEnd, spawn].filter((t): t is number => t !== null)
  const from = since.length > 0 ? Math.max(...since) : null
  return { kind: 'request', text: `model request · ${modelShort(agent.model === null ? null : modelLabel(agent.model))}`, sinceMs: ageOf(now, from, age) }
}

// `isFoldedAgent`, `groupOf` and `AgentGroup` now live in derive.ts (insights.ts's filter chips use them too); re-exported here unchanged.
export { groupOf, isFoldedAgent }
export type { AgentGroup }

/** The done group shows this many (newest first) unless the person asks for all. */
export const RECENT_DONE = 8

export type OrderedAgents = {
  rows: TelemetryAgentRow[]
  counts: Record<AgentGroup, number>
  /** Rows folded into the `+N other` line. */
  folded: number
  /** Done rows left out by the recent cap (0 when every one shows). */
  hiddenDone: number
}

/**
 * Main first, then the running, stale, failed and done groups, each in
 * spawn-tree order (done: newest first by subtree root, and only the
 * RECENT_DONE newest roots unless `all`). Folded rows are counted, not listed.
 */
export function orderAgents(rows: TelemetryAgentRow[], s: Pick<TelemetryState, 'agents'>, all: boolean): OrderedAgents {
  const main = rows.filter(r => r.id === 'main')
  const rest = rows.filter(r => r.id !== 'main' && !isFoldedAgent(r))
  const folded = rows.length - main.length - rest.length
  const byGroup: Record<AgentGroup, TelemetryAgentRow[]> = { running: [], stale: [], failed: [], done: [] }
  for (const r of rest) byGroup[groupOf(r)].push(r)
  const counts: Record<AgentGroup, number> = { running: byGroup.running.length, stale: byGroup.stale.length, failed: byGroup.failed.length, done: byGroup.done.length }
  const endOf = (r: TelemetryAgentRow): number => {
    const a = s.agents.byId[r.id]
    return a && isTime(a.endedAt) ? a.endedAt : a && isTime(a.lastActiveAt) ? a.lastActiveAt : 0
  }
  // tree order is deriveAgents' order; the done group's top-level rows go newest first, their subtrees kept together
  const done: TelemetryAgentRow[] = []
  const roots = byGroup.done.filter(r => r.depth <= 1 || !byGroup.done.some(p => p.id === r.parentId))
  const sortedRoots = [...roots].sort((a, z) => endOf(z) - endOf(a))
  const shownRoots = all ? sortedRoots : sortedRoots.slice(0, RECENT_DONE)
  for (const root of shownRoots) {
    done.push(root)
    const idx = byGroup.done.indexOf(root)
    for (let i = idx + 1; i < byGroup.done.length; i += 1) {
      const r = byGroup.done[i]
      if (!r || r.depth <= root.depth) break
      if (!roots.includes(r)) done.push(r)
    }
  }
  return { rows: [...main, ...byGroup.running, ...byGroup.stale, ...byGroup.failed, ...done], counts, folded, hiddenDone: byGroup.done.length - done.length }
}

/** The drawers' controls on the chips row: how many are open, and which running rows are closed. */
export type DrawerControls = { openCount: number; runningClosed: string[] }

/** The controls: `Tree | Workflows`, the search field; then the filter chips with their counts, `collapse all` / `expand running` at the right. Two head items. */
function controlItems(T: T4, input: TabInput, ctl: AgentControls, onAct: (act: string) => void, onType: (value: string) => void, drawers: DrawerControls | null = null): Item[] {
  const { Box, Button, Text, Input } = T
  const cols = input.layout.cols
  const modeBtn = (mode: 'tree' | 'workflows', label: string): RenderElement => {
    const on = ctl.mode === mode
    return (
      <Button key={`agents:${mode}`} label={label} plain {...(on ? {} : { hotkey: 'w' })} onPress={() => onAct(`agents:${mode}`)}>
        <Text size="caption" weight={on ? 'semibold' : 'regular'} {...(on ? { color: ACCENT } : { dimColor: true })}>
          {label}
        </Text>
      </Button>
    )
  }
  const search = Input ? (
    <Box width={Math.max(10, Math.min(24, Math.floor(cols / 3)))} flexShrink={0} overflow="hidden">
      <Input key="agents:search" placeholder="search" value={ctl.query} submitLabel="filter" onSubmit={v => onType(v)} />
    </Box>
  ) : null
  const controls = row(T, [row(T, [modeBtn('tree', 'Tree'), cap(T, '|'), modeBtn('workflows', 'Workflows')]), ...(search ? [search] : [])], { justify: 'space-between' })
  const chipRow = row(
    T,
    ctl.chips.map(c => (
      <Button key={`filter:${c.id}`} label={`${c.label} ${c.count}`} plain {...(c.on ? { hotkey: 'f' } : {})} onPress={() => onAct(c.on ? 'filter:next' : `filter:${c.id}`)}>
        <Text size="caption" weight={c.on ? 'semibold' : 'regular'} {...(c.on ? { color: ACCENT } : { dimColor: true })}>
          {c.label} {String(c.count)}
        </Text>
      </Button>
    )),
  )
  // the drawers: `collapse all` while any is open, `expand running` while a running row is closed
  const short = cols < 64
  const drawerBtns: RenderElement[] = []
  if (drawers && drawers.openCount > 0) {
    const label = short ? 'collapse' : 'collapse all'
    drawerBtns.push(
      <Button key="agents:collapse" label={label} plain hotkey="c" onPress={() => onAct('agents:collapse')}>
        <Text size="caption" dimColor>
          {label}
        </Text>
      </Button>,
    )
  }
  if (drawers && drawers.runningClosed.length > 0) {
    const label = short ? 'expand' : 'expand running'
    drawerBtns.push(
      <Button key="agents:expand" label={label} plain hotkey="e" onPress={() => onAct(`agents:expand:${JSON.stringify(drawers.runningClosed)}`)}>
        <Text size="caption" dimColor>
          {label}
        </Text>
      </Button>,
    )
  }
  const chips = drawerBtns.length === 0 ? chipRow : row(T, [<Box flexShrink={1} overflow="hidden">{chipRow}</Box>, <Box flexShrink={0}>{row(T, drawerBtns)}</Box>], { justify: 'space-between' })
  return [
    { el: controls, rows: H.line },
    { el: chips, rows: H.line },
  ]
}

/** One workflow card: the header row, and the critical path, failures and agent rows when open. */
function workflowItem(T: T4, input: TabInput, c: WorkflowCard, onAct: (act: string) => void): Item {
  const { Box, Button, Text } = T
  const cols = input.layout.cols
  const wf = c.wf
  const status: DotStatus = wf.status === 'running' ? 'running' : wf.status === 'stale' ? 'stale' : wf.status === 'failed' ? 'error' : 'done'
  const wide = cols >= 64
  const nameCells = Math.max(6, cols - 2 - 8 - 7 - (wide ? 14 : 0) - 6)
  const head = row(
    T,
    [
      dot(T, status, 10),
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Button key={`wf:${wf.id}`} label={wf.name} plain onPress={() => onAct(`wf:${wf.id}`)}>
          <Text weight="semibold">{`${c.isOpen ? '▾ ' : '▸ '}${truncateTo(wf.name, nameCells)}`}</Text>
        </Button>
      </Box>,
      ...(wide ? [<Box flexShrink={0} overflow="hidden">{cap(T, c.counts, { tabular: true })}</Box>] : []),
      num(T, fmtUsd(wf.costUsd), 8),
      ...(wide ? [svg(T, barSvg(wf.costShare, { width: 36, height: 5 }))] : []),
      num(T, c.wall, 7, wf.status === 'running' ? { color: ACCENT } : { dimColor: true }),
      num(T, c.parallelism, 6, { size: 'caption', dimColor: true }),
    ],
    { pad: true, key: `wfrow:${wf.id}` },
  )
  if (!c.isOpen) return { el: head, rows: H.row }
  const lines: RenderElement[] = [head]
  const facts = [...(wide ? [] : [c.counts]), ...(c.critical ? [`critical path ${c.critical}`] : []), ...(c.failures ? [c.failures] : []), ...(wf.types.length > 0 ? [wf.types.join(', ')] : [])]
  if (facts.length > 0) lines.push(row(T, [<Box width={2} flexShrink={0} />, cap(T, facts.join(' · '), c.failures ? { color: 'error', dimColor: false } : {})]))
  for (const r of c.agents) {
    lines.push(
      row(
        T,
        [
          <Box width={2} flexShrink={0} />,
          dot(T, dotOf(r.status), 8),
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Button key={`agent:${r.id}`} label={r.label || r.type} plain onPress={() => onAct(`agent:${r.id}`)}>
              <Text size="caption">{truncateTo(r.label || r.type, nameCells)}</Text>
            </Button>
          </Box>,
          num(T, elapsedText(r.durationMs, cols < 48), 7, r.isRunning ? { color: ACCENT, size: 'caption' } : { dimColor: true, size: 'caption' }),
          num(T, fmtUsd(r.costUsd), 8, { size: 'caption' }),
        ],
        { key: `wfagent:${wf.id}:${r.id}` },
      ),
    )
  }
  return { el: <Box flexDirection="column">{lines}</Box>, rows: H.row + (lines.length - 1) * H.line }
}

export function deskAgents(T: T4, input: TabInput, onAct: (act: string) => void, onType: (value: string) => void = () => undefined): DeskView {
  const { Box, Button, Text } = T
  const { s, ui, now, layout } = input
  const cols = layout.cols
  const all = deriveAgents(s, now)
  if (all.length === 0) return { head: [], items: [{ el: cap(T, 'no agent activity yet'), rows: H.line }] }
  const ctl = agentControls(all, ui)
  if (ctl.mode === 'workflows') {
    const controls = controlItems(T, input, ctl, onAct, onType)
    const cards = workflowCards(s, now, ui, all)
    const items: Item[] = cards.map(c => workflowItem(T, input, c, onAct))
    const ids: (string | null)[] = cards.map(() => null)
    if (cards.length === 0) items.push({ el: cap(T, ctl.isFiltered ? 'no workflow matches the filter' : 'no workflows yet: one appears per subagent run under main'), rows: H.line })
    return { head: controls, items, ids }
  }
  const { rows, counts, folded, hiddenDone } = orderAgents(ctl.rows, s, ui.showAllAgents === true)
  // the drawers open are the ones the person opened (several at once); the focus (arrow keys) opens nothing by itself
  const open = new Set(ui.expandedAgents ?? [])
  const focusId = ui.agentId !== null && rows.some(r => r.id === ui.agentId) ? ui.agentId : null
  const drawers: DrawerControls = { openCount: rows.filter(r => open.has(r.id)).length, runningClosed: rows.filter(r => r.isRunning && !open.has(r.id)).map(r => r.id) }
  const controls = controlItems(T, input, ctl, onAct, onType, drawers)
  const burn = burnOf(input)

  // the summary strip
  const strip = row(
    T,
    [
      row(T, [
        ...(counts.running > 0 ? [dot(T, 'running', 10), txt(T, `${counts.running} running`, { color: ACCENT, size: 'caption', tabular: true })] : [cap(T, 'nothing running')]),
        cap(T, `· ${counts.done} done`, { tabular: true }),
        ...(counts.failed > 0 ? [cap(T, `· ${counts.failed} failed`, { color: 'error', dimColor: false, tabular: true })] : []),
        ...(counts.stale > 0 ? [cap(T, `· ${counts.stale} stale`, { color: 'warning', dimColor: false, tabular: true })] : []),
      ]),
      cap(T, burn === null ? '' : `${fmtRate(burn)}`, { tabular: true }),
    ],
    { justify: 'space-between' },
  )
  const head: Item[] = [...controls, { el: strip, rows: H.line }]

  // the lanes
  const lanes = laneRows(rows, s, now)
  if (lanes.lanes.length > 0) {
    const width = laneWidth(cols)
    const spec = lanesSvg(lanes.lanes, { width, from: lanes.from, to: now, laneHeight: 4, gap: 2 })
    head.push({
      el: (
        <Box flexDirection="column" overflow="hidden" paddingY="xs">
          {svg(T, spec)}
          {row(T, [cap(T, `last ${fmtDuration(now - lanes.from)}`), cap(T, 'now')], { justify: 'space-between' })}
        </Box>
      ),
      rows: Math.min(5, 1.5 + Math.ceil(spec.height / 16)),
    })
  }

  // the table head
  const widths = cellWidths(cols)
  head.push({
    el: row(T, [
      <Box width={2} flexShrink={0} />,
      <Box flexGrow={1} overflow="hidden">
        {cap(T, 'agent')}
      </Box>,
      ...(widths.tok > 0 ? [num(T, 'tokens', widths.tok, { size: 'caption', dimColor: true })] : []),
      num(T, 'elapsed', widths.elapsed, { size: 'caption', dimColor: true }),
      num(T, 'ctx', widths.ctx, { size: 'caption', dimColor: true }),
      num(T, 'cost', widths.cost, { size: 'caption', dimColor: true }),
    ]),
    rows: H.line,
  })

  // the rows
  const items: Item[] = []
  const ids: (string | null)[] = []
  let select: number | undefined
  let selectTo: number | undefined
  rows.forEach((r, i) => {
    const selected = r.id === focusId
    const isOpen = open.has(r.id)
    if (selected) select = items.length
    const phase = agentPhase(s, r.id, now)
    const next = rows[i + 1]
    const isLast = next === undefined || next.depth < r.depth
    // a finished (or idle, or stale) row with a plan: its count, faint, between the name and the numbers
    const doneCount = r.plan && !r.isRunning && cols >= 44 ? `${r.plan.isComplete ? '✓ ' : ''}${planCountText(r.plan)}` : null
    const countCells = doneCount === null ? 0 : doneCount.length + 1
    const nameCells = cols - 2 - widths.elapsed - widths.ctx - widths.cost - widths.tok - 5 - Math.min(3, r.depth) * 2 - 1 - countCells
    const name = r.id === 'main' ? 'main session' : r.label || r.type
    const nameEl = (
      <Button key={`agent:${r.id}`} label={name} plain onPress={() => onAct(`agent:${r.id}`)}>
        <Text size="caption" dimColor>
          {isOpen ? '▾ ' : '▸ '}
        </Text>
        <Text weight={selected ? 'semibold' : 'regular'} {...(selected ? { color: ACCENT } : {})}>
          {truncateTo(name, nameCells)}
        </Text>
      </Button>
    )
    const fill = r.peakContextTokens > 0 && s.context.window ? Math.min(1, r.lastContextTokens / s.context.window) : null
    const main = row(
      T,
      [
        dot(T, dotOf(r.status), 10),
        ...(r.depth > 0 ? [<Box flexShrink={0} paddingLeft={Math.max(0, Math.min(3, r.depth) - 1) * 2}>{svg(T, guideSvg({ width: 12, height: 16, isLast }))}</Box>] : []),
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          {nameEl}
        </Box>,
        ...(doneCount === null ? [] : [<Box flexShrink={0}>{cap(T, doneCount, { tabular: true, ...(r.plan?.isComplete ? { color: 'success', dimColor: true } : {}) })}</Box>]),
        ...(widths.tok > 0 ? [num(T, fmtTokens(r.tokens), widths.tok, { dimColor: true })] : []),
        num(T, elapsedText(r.durationMs, widths.elapsed < 7), widths.elapsed, r.isRunning ? { color: ACCENT } : { dimColor: true }),
        ctxCell(T, fill, widths.ctx),
        num(T, fmtUsd(r.costUsd), widths.cost),
      ],
      { pad: true, key: `row:${r.id}` },
    )
    const lines: RenderElement[] = [main]
    let height: number = H.row
    if (r.isStale) {
      // a running loop that went quiet: say so, and since when, instead of a phase
      const a = s.agents.byId[r.id]
      const quiet = a ? ageOf(now, a.lastActiveAt, sessionAgeMs(s, now)) : null
      lines.push(row(T, [<Box width={2} flexShrink={0} />, cap(T, `◌ stale · no activity${quiet === null ? '' : ` for ${fmtDuration(quiet)}`}`, { color: 'warning', dimColor: false })]))
      height += H.line
    }
    if (r.plan && r.isRunning) {
      // a running row with a plan: the task in progress, its bar and count (the phase stands in when the plan names no task)
      lines.push(planLine(T, r.plan, phase, cols, r.id))
      height += H.line
    } else if (phase) {
      lines.push(
        row(T, [<Box width={2} flexShrink={0} />, cap(T, `▸ ${phase.text}`, phase.kind === 'tool' ? { color: ACCENT, dimColor: false } : {}), ...(phase.sinceMs === null ? [] : [cap(T, fmtDuration(phase.sinceMs), { tabular: true })])]),
      )
      height += H.line
    }
    const rowEl = lines.length === 1 ? main : <Box flexDirection="column">{lines}</Box>
    if (isOpen) {
      // the row and its drawer are one item; taller than the body, it is windowed as its parts (the row, then the drawer a line at a time)
      const drawer = drawerOf(T, input, r)
      if (selected) selectTo = items.length
      items.push({
        el: (
          <Box flexDirection="column">
            {rowEl}
            {drawer.el}
          </Box>
        ),
        rows: height + drawer.rows,
        parts: [{ el: rowEl, rows: height }, ...(drawer.parts ?? [])],
      })
    } else items.push({ el: rowEl, rows: height })
    ids.push(r.id)
  })
  if (hiddenDone > 0 || ui.showAllAgents === true) {
    // the recent cap on the done group, and the way back
    const label = hiddenDone > 0 ? `+${hiddenDone} done · show all` : 'show recent only'
    items.push({
      el: row(T, [
        <Box width={2} flexShrink={0} />,
        <Button key="agents:all" label={label} plain onPress={() => onAct('agents:all')}>
          <Text size="caption" color={ACCENT}>
            {label}
          </Text>
        </Button>,
      ]),
      rows: H.row,
    })
    ids.push(null)
  }
  if (folded > 0) {
    items.push({ el: row(T, [<Box width={2} flexShrink={0} />, cap(T, `+${folded} unattributed (no spawn seen, no usage)`)]), rows: H.line })
    ids.push(null)
  }
  if (rows.length === 0) {
    items.push({ el: cap(T, 'no agent matches the filter'), rows: H.line })
    ids.push(null)
  }
  // the ledger's untracked remainder is the Overview's footnote (and the header tile shows the ledger): no orphan line here
  if (select === undefined) return { head, items, ids }
  return selectTo === undefined ? { head, items, select, ids } : { head, items, select, selectTo, ids }
}

function burnOf(input: TabInput): number | null {
  // the session's burn over the last window; the running agents' share is not separable from the steps ring cheaply
  const { s, now } = input
  const windowMs = 5 * 60_000
  let cost = 0
  let any = false
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    const step = s.steps[i]
    if (!step || step.endedAt <= now - windowMs) break
    cost += step.costUsd
    any = true
  }
  if (!any) return null
  const first = s.totals.firstStepAt
  const span = first === null ? windowMs : Math.max(60_000, Math.min(windowMs, now - first))
  return cost / (span / 60_000)
}

/** Fixed cell widths (cells) by the pane's width; under 48 the elapsed cell holds a compact age (`10m`, not `10m 00s`). */
export function cellWidths(cols: number): { elapsed: number; ctx: number; cost: number; tok: number } {
  if (cols < 48) return { elapsed: 5, ctx: 5, cost: 7, tok: 0 }
  if (cols < 64) return { elapsed: 7, ctx: 10, cost: 8, tok: 0 }
  return { elapsed: 7, ctx: 10, cost: 8, tok: 7 }
}

/** A duration for the elapsed cell: `fmtDuration` (`10m 00s`), or compact (`10m`) where the cell is under 7 cells. */
export const elapsedText = (ms: number | null, compact: boolean): string => (compact ? fmtAgo(ms) : fmtDuration(ms))

/** The context cell: a 28px bar, and the percentage when the cell has room. */
function ctxCell(T: T4, fill: number | null, w: number): RenderElement {
  const { Box } = T
  const tone = fillTone(fill)
  const bar = svg(T, barSvg(fill, { width: 28, height: 5, color: toneHex(tone) }))
  if (w < 8) {
    return (
      <Box width={w} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" overflow="hidden">
        {bar}
      </Box>
    )
  }
  return (
    <Box width={w} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" gap="xs" overflow="hidden">
      {bar}
      {txt(T, fill === null ? '–' : fmtPct(fill), { tabular: true, size: 'caption', ...toneOf(tone) })}
    </Box>
  )
}

/** The lanes strip's width in CSS px: conservative, so it never overflows a narrow pane. */
export const laneWidth = (cols: number): number => Math.max(120, Math.min(560, (cols - 2) * 6))

/** One lane per subagent shown (at most 8: the running first, then the newest), over the window they span. */
function laneRows(rows: TelemetryAgentRow[], s: TelemetryState, now: number): { lanes: Lane[]; from: number } {
  const age = sessionAgeMs(s, now)
  const start0 = sessionStartOf(s, now)
  const lanes: (Lane & { at: number })[] = []
  for (const r of rows) {
    if (r.id === 'main') continue
    const a = s.agents.byId[r.id]
    if (!a) continue
    const start = isTime(a.spawnedAt) ? a.spawnedAt : isTime(a.firstSeenAt) ? a.firstSeenAt : null
    if (start === null || (age !== null && now - start > age + 60_000)) continue
    // a stale lane ends where its activity did
    const end = r.isRunning ? null : isTime(a.endedAt) ? a.endedAt : isTime(a.lastActiveAt) ? a.lastActiveAt : start
    lanes.push({ start, end, status: dotOf(r.status) as DotStatus, at: end ?? now })
  }
  const kept = lanes.sort((x, y) => Number(y.end === null) - Number(x.end === null) || y.at - x.at).slice(0, 8)
  if (kept.length === 0) return { lanes: [], from: now }
  const earliest = Math.min(...kept.map(l => l.start))
  const floor = start0 === null ? earliest : Math.max(start0, earliest)
  const from = Math.min(floor, now - 60_000)
  return { lanes: kept.map(({ start, end, status }) => ({ start, end, status })), from }
}

/** A running row's plan line: `▸ <task>` (cut at the end), a thin accent bar, `3/7` at the right; dim while the plan is stale. */
function planLine(T: T4, plan: TelemetryAgentPlanView, phase: AgentPhase | null, cols: number, id: string): RenderElement {
  const { Box } = T
  const task = planTaskText(plan, phase)
  const stale = plan.isStale
  const count = planCountText(plan)
  const text = `▸ ${task.text}${task.sinceMs === null ? '' : ` · ${fmtDuration(task.sinceMs)}`}`
  const textProps = stale ? {} : task.isPhase && phase?.kind !== 'tool' ? {} : { dimColor: false }
  const barW = cols >= 64 ? 48 : 28
  return row(
    T,
    [
      <Box width={2} flexShrink={0} />,
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {cap(T, text, textProps)}
      </Box>,
      ...(plan.fraction !== null && cols >= 40 ? [svg(T, { ...barSvg(plan.fraction, { width: barW, height: 4, color: stale ? PALETTE.neutral : PALETTE.accent }), alt: `plan ${count}${stale ? ' (stale)' : ''}` })] : []),
      <Box flexShrink={0}>{cap(T, count, { tabular: true, ...(stale ? {} : { color: ACCENT, dimColor: false }) })}</Box>,
    ],
    { key: `plan:${id}` },
  )
}

/** The drawer's plan block: `plan · source` with the count, then the checklist (✓ done, ▸ active, ○ pending; `+N more`). */
function planLines(T: T4, plan: TelemetryAgentPlanView): RenderElement[] {
  const { Box } = T
  const head = [plan.title ?? 'plan', PLAN_SOURCE_LABEL[plan.source], ...(plan.isStale ? ['stale'] : [])].join(' · ')
  const lines: RenderElement[] = [kv(T, head, txt(T, planCountText(plan), { size: 'caption', tabular: true, ...(plan.isComplete ? { color: 'success' } : {}) }))]
  if (plan.items.length === 0) {
    if (plan.currentTask !== null) lines.push(row(T, [<Box width={1} flexShrink={0} />, cap(T, `▸ ${plan.currentTask}`, { dimColor: false })]))
    return lines
  }
  const list = planChecklist(plan)
  for (const it of list.items) {
    lines.push(
      row(T, [
        <Box width={1} flexShrink={0} />,
        cap(T, PLAN_GLYPH[it.status], it.status === 'done' ? { color: 'success', dimColor: false } : it.status === 'active' ? { color: ACCENT, dimColor: false } : {}),
        cap(T, it.text, it.status === 'active' ? { dimColor: false } : {}),
      ]),
    )
  }
  if (list.more > 0) lines.push(row(T, [<Box width={1} flexShrink={0} />, cap(T, `+${list.more} more`)]))
  return lines
}

const PLAN_SOURCE_LABEL: Record<TelemetryAgentPlanView['source'], string> = { step: 'steps', todos: 'todos', progress: 'flow', tasks: 'tasks' }

/** An open agent's drawer (an item of its own; its lines are its parts, for a drawer taller than the body). */
function drawerOf(T: T4, input: TabInput, r: TelemetryAgentRow): Item {
  const { s, layout } = input
  const cols = layout.cols
  const agent = s.agents.byId[r.id]
  const lines: RenderElement[] = []
  const effort = lastEffort(s, r.id)
  const parent = r.parentId !== null && r.parentId !== 'main' ? s.agents.byId[r.parentId]?.type ?? null : null
  const who = [r.id === 'main' ? 'main loop' : r.type, modelShort(r.modelLabel), ...(effort ? [`${effort} effort`] : []), ...(r.isBackground ? ['background'] : []), ...(parent ? [`in ${parent}`] : [])].join(' · ')
  lines.push(cap(T, who))
  const u = r.usage
  const mix = stackSvg([u.input, u.output, u.cacheRead, u.cacheWrite], { width: Math.max(80, Math.min(240, (cols - 6) * 5)), height: 6, labels: ['in', 'out', 'cache read', 'cache write'] })
  lines.push(row(T, [svg(T, mix)]))
  lines.push(row(T, [cap(T, `in ${fmtTokens(u.input)} · out ${fmtTokens(u.output)} · cache r ${fmtTokens(u.cacheRead)} · w ${fmtTokens(u.cacheWrite)}`, { tabular: true })]))
  if (agent) {
    const tools = Object.entries(agent.byTool)
      .sort((a, z) => z[1] - a[1])
      .slice(0, 5)
      .map(([tool, calls]) => `${toolName(tool)} ${calls}`)
    if (tools.length > 0) lines.push(kv(T, 'tools', txt(T, tools.join(' · '), { size: 'caption', tabular: true })))
  }
  lines.push(kv(T, 'context peak', `${fmtTokens(r.peakContextTokens)} · ${r.steps} req · ${r.toolCalls} tools${r.toolErrors > 0 ? ` · ${r.toolErrors} err` : ''} · ${fmtDuration(r.durationMs)}`))
  if (r.report) lines.push(kv(T, 'report', `${r.report.status} · ${fmtTokens(r.report.totalTokens)} tok · ${fmtDuration(r.report.totalDurationMs)} · ${r.report.totalToolUseCount} tools`))
  if (r.plan) lines.push(...planLines(T, r.plan))
  const { Box } = T
  // windowed line by line when it is taller than the body: the same lines, indented, without the card
  const parts: Item[] = lines.map((el, i) => ({ el: <Box key={`drawer:${r.id}:${i}`} paddingLeft={2} overflow="hidden">{el}</Box>, rows: H.line }))
  return { el: card(T, lines, { key: `drawer:${r.id}` }), rows: lines.length + H.cardChrome, parts }
}

function lastEffort(s: Pick<TelemetryState, 'steps'>, id: string): string | null {
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    const step = s.steps[i]
    if (step && step.agentId === id) return step.effort
  }
  return null
}
