// session-telemetry: the terminal Agents tab, "htop for the harness", the
// desktop's information architecture (hooks/ui/desktop/agents.tsx) in
// monospace glyphs and flex rows:
//
//   ▶ 1 running · 2 done · 1 failed · 1 stale                     $0.02/min
//   Explore      ───━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶   lanes: one row per
//   draft the p… ───────────────────━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   agent, lit from its
//                last 10m 00s                                          now   start to its end
//     agent                               tokens  elapsed          ctx   cost
//   ▶ main session                          1.0M   1h 00m  ━━━━╸──  45%  $2.50
//     ▸ Bash · 7s
//   ▶ ├ draft the plan                       94k  10m 00s  ╸──────   3%  $0.20
//     ▸ model request · Haiku 5.5 · 10m 00s
//   ✓ └ find every caller of the pricing…    94k   9m 00s  ╸──────   3%  $0.30
//   ✗   └ nested check                       94k   9m 00s  ╸──────   3%  $0.10
//     +14 done · show all
//     +2 unattributed (no spawn seen, no usage)
//
// A row is a flex `Box`: the glyph cell, the name cell (a Button, grows and
// truncates; a tree guide before a nested name), then fixed numeric cells.
// The selected row's name is inverted, and a drawer (a rounded card) opens
// under it: type · model · effort, the token mix, the tools, context peak ·
// requests · tools · duration, the report. Never a tool's input text.
//
// Exports: termAgents(T, input, onAct), termCellWidths, laneSegs (pure)

import type { RenderElement } from 'claude-code'

import type { TelemetryState } from '../../../types'
import { ageOf, deriveAgents, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtUsd, isTime, sessionAgeMs, sessionStartOf, type TelemetryAgentPlanView, type TelemetryAgentRow } from '../../derive'
import { ACCENT, btn, cpLen, dim, fillTone, fitLine, fitSegs, lineWidth, lr, seg, stack, thinBar, truncate, type Line, type Seg } from '../../ui-kit'
import { toolName } from '../common'
import { agentPhase, elapsedText, orderAgents } from '../desktop/agents'
import { agentControls, PLAN_GLYPH, planChecklist, planCountText, planTaskText, workflowCards, type AgentControls, type WorkflowCard } from '../insights-view'
import type { TabInput } from '../layout'

import { card, CARD_CHROME, cell, dotOf, fillCells, grow, lineEl, segsEl, trow, txt, type Item, type T3, type TermView } from './kit'

/** Fixed cell widths (columns) by the pane's width; the name cell takes the rest. */
export function termCellWidths(cols: number): { tok: number; elapsed: number; ctx: number; cost: number } {
  if (cols < 48) return { tok: 0, elapsed: 5, ctx: 4, cost: 6 }
  if (cols < 64) return { tok: 0, elapsed: 7, ctx: 10, cost: 7 }
  if (cols < 100) return { tok: 6, elapsed: 7, ctx: 12, cost: 8 }
  return { tok: 7, elapsed: 8, ctx: 16, cost: 8 }
}

const GAP = 1

/** How many lane rows the strip may take at `rows`. */
const laneRowsFor = (rows: number): number => (rows >= 30 ? 6 : rows >= 20 ? 4 : rows >= 14 ? 2 : 0)

/**
 * One lane as runs over `width` cells of the window `from`..`to`: a dim track,
 * lit (`━`) from the agent's start to its end, to the edge with a `▶` while it
 * runs, in the status colour. At least one cell is lit.
 */
export function laneSegs(lane: { start: number; end: number | null; status: TelemetryAgentRow['status'] }, from: number, to: number, width: number): Seg[] {
  const w = Math.max(1, width)
  const span = Math.max(1, to - from)
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(((lane.start - from) / span) * w)))
  const running = lane.end === null
  const x1 = lane.end === null ? w : Math.max(x0 + 1, Math.min(w, Math.ceil(((lane.end - from) / span) * w)))
  const color = running ? ACCENT : lane.status === 'error' || lane.status === 'refused' ? 'error' : lane.status === 'aborted' || lane.status === 'stale' ? 'warning' : 'success'
  const lit = running ? `${'━'.repeat(Math.max(0, x1 - x0 - 1))}▶` : '━'.repeat(x1 - x0)
  return [...(x0 > 0 ? [dim('─'.repeat(x0))] : []), seg(lit, { c: color }), ...(w - x1 > 0 ? [dim('─'.repeat(w - x1))] : [])]
}

type Lane = { name: string; start: number; end: number | null; status: TelemetryAgentRow['status']; at: number }

/** The lanes: the running first, then the newest, at most `max`; and the window they span. */
function lanesOf(rows: TelemetryAgentRow[], s: TelemetryState, now: number, max: number): { lanes: Lane[]; from: number } {
  const age = sessionAgeMs(s, now)
  const start0 = sessionStartOf(s, now)
  const lanes: Lane[] = []
  for (const r of rows) {
    if (r.id === 'main') continue
    const a = s.agents.byId[r.id]
    if (!a) continue
    const start = isTime(a.spawnedAt) ? a.spawnedAt : isTime(a.firstSeenAt) ? a.firstSeenAt : null
    if (start === null || (age !== null && now - start > age + 60_000)) continue
    const end = r.isRunning ? null : isTime(a.endedAt) ? a.endedAt : isTime(a.lastActiveAt) ? a.lastActiveAt : start
    lanes.push({ name: r.label || r.type, start, end, status: r.status, at: end ?? now })
  }
  const kept = lanes.sort((x, y) => Number(y.end === null) - Number(x.end === null) || y.at - x.at).slice(0, max)
  if (kept.length === 0) return { lanes: [], from: now }
  const earliest = Math.min(...kept.map(l => l.start))
  const floor = start0 === null ? earliest : Math.max(start0, earliest)
  return { lanes: kept, from: Math.min(floor, now - 60_000) }
}

function burnOf(input: TabInput): number | null {
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

const shortModel = (label: string | null): string => (label ?? '–').replace(/^Claude /, '')

/** The drawers' controls on the chips row: how many are open, and which running rows are closed. */
type DrawerControls = { openCount: number; runningClosed: string[] }

/** The controls: row 1 `Tree | Workflows` with the search field at the right; row 2 the filter chips with their counts (`f` cycles, `w` switches the view), `c: collapse all` / `e: expand running` at the right when they fit. */
function controlItems(T: T3, input: TabInput, ctl: AgentControls, onAct: (act: string) => void, onType: (value: string) => void, drawers: DrawerControls | null = null): Item[] {
  const { Box, Button, Text, Input } = T
  const { cols, hkPrefix } = input.layout
  const modeBtn = (mode: 'tree' | 'workflows', label: string): RenderElement => {
    const on = ctl.mode === mode
    return (
      <Button key={`agents:${mode}`} label={label} plain onPress={() => onAct(`agents:${mode}`)}>
        <Text {...(on ? { color: ACCENT, inverse: true, weight: 'bold' } : { dimColor: true })}>{on ? ` ${label} ` : label}</Text>
      </Button>
    )
  }
  const searchW = Math.max(10, Math.min(24, Math.floor(cols / 3)))
  const left = (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} gap={1} overflow="hidden">
      {modeBtn('tree', 'Tree')}
      <Text dimColor>|</Text>
      {modeBtn('workflows', 'Workflows')}
      {hkPrefix ? <Text dimColor> w: switch</Text> : []}
    </Box>
  )
  const search = Input ? cell(T, searchW, <Input key="agents:search" placeholder="search" value={ctl.query} submitLabel="filter" onSubmit={v => onType(v)} />, 'l') : null
  const row1 = trow(T, [left, ...(search ? [search] : [])], { gap: 1 })
  const chipLine: Line = []
  ctl.chips.forEach((c, i) => {
    if (i > 0) chipLine.push(dim(' · '))
    const segs: Seg[] = c.on ? [seg(`${c.label} ${c.count}`, { c: ACCENT, bold: true })] : [dim(`${c.label} ${c.count}`)]
    chipLine.push(c.on ? btn(`filter:${c.id}`, 'filter:next', segs, 'f', hkPrefix ? undefined : 0) : btn(`filter:${c.id}`, `filter:${c.id}`, segs))
  })
  // the drawers, at the right, only where the chips keep their room: both in full, both short, then the one that matters most (collapse while any is open)
  const hkw = hkPrefix ? undefined : 0
  const collapse = (long: boolean): Line => (drawers && drawers.openCount > 0 ? [btn('agents:collapse', 'agents:collapse', [dim(long ? 'collapse all' : 'collapse')], 'c', hkw)] : [])
  const expand = (long: boolean): Line => (drawers && drawers.runningClosed.length > 0 ? [btn('agents:expand', `agents:expand:${JSON.stringify(drawers.runningClosed)}`, [dim(long ? 'expand running' : 'expand')], 'e', hkw)] : [])
  const both = (long: boolean): Line => {
    const c = collapse(long)
    const e = expand(long)
    return c.length > 0 && e.length > 0 ? [...c, dim(' · '), ...e] : [...c, ...e]
  }
  const chipsW = lineWidth(chipLine)
  const choices: Line[] = [both(true), both(false), collapse(true).length > 0 ? collapse(true) : expand(true), collapse(false).length > 0 ? collapse(false) : expand(false)]
  const right = choices.find(c => c.length > 0 && chipsW + 2 + lineWidth(c) <= cols) ?? []
  const line: Line = right.length > 0 ? [...chipLine, seg(' '.repeat(cols - chipsW - lineWidth(right))), ...right] : chipLine
  return [
    { el: row1, rows: 1 },
    { el: lineEl(T, fitLine(line, cols), onAct), rows: 1 },
  ]
}

/** One workflow card: the header row (glyph, name, counts, cost, share bar, wall, parallelism) and, open, its facts and agent rows. */
function workflowItem(T: T3, input: TabInput, c: WorkflowCard, onAct: (act: string) => void): Item {
  const { Box, Button, Text } = T
  const { cols } = input.layout
  const wf = c.wf
  const status: TelemetryAgentRow['status'] = wf.status === 'running' ? 'running' : wf.status === 'stale' ? 'stale' : wf.status === 'failed' ? 'error' : 'completed'
  const wide = cols >= 64
  const barW = wide ? 8 : 0
  const fixed = 1 + 8 + 7 + 5 + (wide ? 20 + barW + 2 : 0) + GAP * (wide ? 6 : 4)
  const nameCells = Math.max(6, cols - fixed)
  const name = truncate(`${c.isOpen ? '▾ ' : '▸ '}${wf.name}`, nameCells)
  const head = trow(
    T,
    [
      cell(T, 1, dotOf(T, status)),
      grow(
        T,
        <Button key={`wf:${wf.id}`} label={wf.name} plain onPress={() => onAct(`wf:${wf.id}`)}>
          <Text weight="bold">{name}</Text>
        </Button>,
      ),
      ...(wide ? [cell(T, 20, txt(T, truncate(c.counts, 20), { dimColor: true }), 'l')] : []),
      cell(T, 8, txt(T, fmtUsd(wf.costUsd))),
      ...(wide ? [cell(T, barW, segsEl(T, thinBar(wf.costShare, barW)))] : []),
      cell(T, 7, txt(T, c.wall, wf.status === 'running' ? { color: ACCENT } : { dimColor: true })),
      cell(T, 5, txt(T, c.parallelism, { dimColor: true })),
    ],
    { gap: GAP, key: `wfrow:${wf.id}` },
  )
  if (!c.isOpen) return { el: head, rows: 1 }
  const lines: RenderElement[] = [head]
  const facts = [...(wide ? [] : [c.counts]), ...(c.critical ? [`critical path ${c.critical}`] : []), ...(c.failures ? [c.failures] : []), ...(wf.types.length > 0 ? [wf.types.join(', ')] : [])]
  if (facts.length > 0) lines.push(segsEl(T, fitSegs([dim('  '), seg(facts.join(' · '), c.failures ? { c: 'error' } : { dim: true })], cols)))
  for (const r of c.agents) {
    lines.push(
      trow(
        T,
        [
          cell(T, 3, dotOf(T, r.status)),
          grow(
            T,
            <Button key={`agent:${r.id}`} label={r.label || r.type} plain onPress={() => onAct(`agent:${r.id}`)}>
              <Text>{truncate(r.label || r.type, Math.max(4, cols - 3 - 7 - 8 - GAP * 3))}</Text>
            </Button>,
          ),
          cell(T, 7, txt(T, elapsedText(r.durationMs, cols < 48), r.isRunning ? { color: ACCENT } : { dimColor: true })),
          cell(T, 8, txt(T, fmtUsd(r.costUsd))),
        ],
        { gap: GAP, key: `wfagent:${wf.id}:${r.id}` },
      ),
    )
  }
  return { el: <Box flexDirection="column" overflow="hidden">{lines}</Box>, rows: lines.length }
}

export function termAgents(T: T3, input: TabInput, onAct: (act: string) => void, onType: (value: string) => void = () => undefined): TermView {
  const { Button, Text } = T
  const { s, ui, now, layout } = input
  const { cols, rows } = layout
  const all = deriveAgents(s, now)
  if (all.length === 0) return { head: [], items: [{ el: txt(T, 'no agent activity yet', { dimColor: true }), rows: 1 }] }
  const ctl = agentControls(all, ui)
  if (ctl.mode === 'workflows') {
    const controls = controlItems(T, input, ctl, onAct, onType)
    const cards = workflowCards(s, now, ui, all)
    const items: Item[] = cards.map(c => workflowItem(T, input, c, onAct))
    const ids: (string | null)[] = cards.map(() => null)
    if (cards.length === 0) items.push({ el: txt(T, ctl.isFiltered ? 'no workflow matches the filter' : 'no workflows yet: one appears per subagent run under main', { dimColor: true }), rows: 1 })
    return { head: controls, items, ids }
  }
  const { rows: list, counts, folded, hiddenDone } = orderAgents(ctl.rows, s, ui.showAllAgents === true)
  // the drawers open are the ones the person opened (several at once); the focus (arrow keys) opens nothing by itself
  const open = new Set(ui.expandedAgents ?? [])
  const focusId = ui.agentId !== null && list.some(r => r.id === ui.agentId) ? ui.agentId : null
  const controls = controlItems(T, input, ctl, onAct, onType, { openCount: list.filter(r => open.has(r.id)).length, runningClosed: list.filter(r => r.isRunning && !open.has(r.id)).map(r => r.id) })
  const sep = dim(' · ')

  // the summary strip
  const burn = burnOf(input)
  const left: Seg[] = [
    ...(counts.running > 0 ? [seg('▶ ', { c: ACCENT }), seg(`${counts.running} running`, { c: ACCENT })] : [dim('○ nothing running')]),
    sep,
    dim(`${counts.done} done`),
    ...(counts.failed > 0 ? [sep, seg(`${counts.failed} failed`, { c: 'error' })] : []),
    ...(counts.stale > 0 ? [sep, seg(`${counts.stale} stale`, { c: 'warning' })] : []),
  ]
  const head: Item[] = [...controls, { el: segsEl(T, lr(left, burn === null ? [] : [seg(fmtRate(burn))], cols)), rows: 1 }]

  // the lanes
  const maxLanes = laneRowsFor(rows)
  const { lanes, from } = maxLanes > 0 ? lanesOf(list, s, now, maxLanes) : { lanes: [], from: now }
  if (lanes.length > 0) {
    const nameW = Math.max(6, Math.min(14, Math.floor(cols / 5)))
    const laneW = cols - nameW - GAP
    for (const lane of lanes) {
      head.push({
        el: trow(T, [cell(T, nameW, txt(T, truncate(lane.name, nameW), { dimColor: true }), 'l'), grow(T, segsEl(T, laneSegs(lane, from, now, laneW)))], { gap: GAP }),
        rows: 1,
      })
    }
    head.push({ el: trow(T, [cell(T, nameW, txt(T, ' '), 'l'), grow(T, segsEl(T, lr([dim(`last ${fmtDuration(now - from)}`)], [dim('now')], laneW)))], { gap: GAP }), rows: 1 })
  }

  // the table head
  const w = termCellWidths(cols)
  const headCells = [
    cell(T, 1, txt(T, ' ')),
    grow(T, txt(T, 'agent', { dimColor: true })),
    ...(w.tok > 0 ? [cell(T, w.tok, txt(T, 'tokens', { dimColor: true }))] : []),
    cell(T, w.elapsed, txt(T, w.elapsed < 7 ? 'time' : 'elapsed', { dimColor: true })),
    cell(T, w.ctx, txt(T, 'ctx', { dimColor: true })),
    cell(T, w.cost, txt(T, 'cost', { dimColor: true })),
  ]
  head.push({ el: trow(T, headCells, { gap: GAP }), rows: 1 })

  // the rows
  const fixed = 1 + w.tok + w.elapsed + w.ctx + w.cost + GAP * (w.tok > 0 ? 5 : 4)
  const nameCells = Math.max(4, cols - fixed)
  const items: Item[] = []
  const ids: (string | null)[] = []
  let select: number | undefined
  let selectTo: number | undefined
  list.forEach((r, i) => {
    const selected = r.id === focusId
    const isOpen = open.has(r.id)
    if (selected) select = items.length
    const next = list[i + 1]
    const isLast = next === undefined || next.depth < r.depth
    const depth = Math.min(3, r.depth)
    const guide = depth === 0 ? '' : `${'  '.repeat(depth - 1)}${isLast ? '└ ' : '├ '}`
    const chevron = isOpen ? '▾ ' : '▸ '
    // a finished (or idle, or stale) row with a plan: its count, faint, between the name and the numbers (from 48 columns)
    const doneCount = r.plan && !r.isRunning && cols >= 48 ? `${r.plan.isComplete ? '✓ ' : ''}${planCountText(r.plan)}` : null
    const countW = doneCount === null ? 0 : cpLen(doneCount)
    const name = truncate(r.id === 'main' ? 'main session' : r.label || r.type, Math.max(1, nameCells - guide.length - chevron.length - (countW > 0 ? countW + GAP : 0)))
    const nameEl = (
      <Button key={`agent:${r.id}`} label={name} plain onPress={() => onAct(`agent:${r.id}`)}>
        {guide === '' ? [] : [<Text dimColor>{guide}</Text>]}
        <Text dimColor>{chevron}</Text>
        <Text weight={selected ? 'bold' : 'regular'} {...(selected ? { inverse: true } : {})}>
          {name}
        </Text>
      </Button>
    )
    const fill = r.peakContextTokens > 0 && s.context.window ? Math.min(1, r.lastContextTokens / s.context.window) : null
    const tone = fillTone(fill)
    const pct = fill === null ? '–' : fmtPct(fill)
    const ctxSegs: Seg[] = w.ctx >= 8 ? [...thinBar(fill, fillCells(w.ctx), tone ?? 'inactive'), seg(` ${pct.padStart(3)}`, tone ? { c: tone } : { dim: true })] : [seg(pct, tone ? { c: tone } : { dim: true })]
    const main = trow(
      T,
      [
        cell(T, 1, dotOf(T, r.status)),
        grow(T, nameEl),
        ...(doneCount === null ? [] : [cell(T, countW, txt(T, doneCount, r.plan?.isComplete ? { color: 'success', dimColor: true } : { dimColor: true }))]),
        ...(w.tok > 0 ? [cell(T, w.tok, txt(T, fmtTokens(r.tokens), { dimColor: true }))] : []),
        cell(T, w.elapsed, txt(T, elapsedText(r.durationMs, w.elapsed < 7), r.isRunning ? { color: ACCENT } : { dimColor: true })),
        cell(T, w.ctx, segsEl(T, ctxSegs)),
        cell(T, w.cost, txt(T, fmtUsd(r.costUsd))),
      ],
      { gap: GAP, key: `row:${r.id}` },
    )
    const lines: RenderElement[] = [main]
    let height = 1
    if (r.isStale) {
      const a = s.agents.byId[r.id]
      const quiet = a ? ageOf(now, a.lastActiveAt, sessionAgeMs(s, now)) : null
      lines.push(segsEl(T, fitSegs([seg('  ◌ stale', { c: 'warning' }), dim(` · no activity${quiet === null ? '' : ` for ${fmtDuration(quiet)}`}`)], cols)))
      height += 1
    }
    const phase = agentPhase(s, r.id, now)
    if (r.plan && r.isRunning) {
      // a running row with a plan: the task in progress, its bar and count (the phase stands in when the plan names no task)
      lines.push(planLineEl(T, r.plan, phase, cols, r.id))
      height += 1
    } else if (phase) {
      const what: Seg = phase.kind === 'tool' ? seg(phase.text, { c: ACCENT }) : dim(phase.text)
      lines.push(segsEl(T, fitSegs([dim('  ▸ '), what, ...(phase.sinceMs === null ? [] : [dim(` · ${fmtDuration(phase.sinceMs)}`)])], cols)))
      height += 1
    }
    const { Box } = T
    const rowEl = lines.length === 1 ? main : <Box flexDirection="column" overflow="hidden">{lines}</Box>
    if (isOpen) {
      // the row and its drawer are one item; taller than the body, it is windowed as its parts (the row, then the drawer a line at a time)
      const drawer = drawerOf(input, r)
      const parts: Item[] = [{ el: rowEl, rows: height }, ...drawer.map(l => ({ el: lineEl(T, fitLine([dim('│ '), ...l], cols), onAct), rows: 1 }))]
      if (selected) selectTo = items.length
      items.push({
        el: (
          <Box flexDirection="column" overflow="hidden">
            {rowEl}
            {card(T, drawer, onAct, { key: `drawer:${r.id}` })}
          </Box>
        ),
        rows: height + drawer.length + CARD_CHROME,
        parts,
      })
    } else items.push({ el: rowEl, rows: height })
    ids.push(r.id)
  })
  if (hiddenDone > 0 || ui.showAllAgents === true) {
    const label = hiddenDone > 0 ? `+${hiddenDone} done · show all` : 'show recent only'
    items.push({ el: lineEl(T, [seg('  '), btn('agents:all', 'agents:all', [seg(label, { c: ACCENT })])], onAct), rows: 1 })
    ids.push(null)
  }
  if (folded > 0) {
    items.push({ el: txt(T, `  +${folded} unattributed (no spawn seen, no usage)`, { dimColor: true }), rows: 1 })
    ids.push(null)
  }
  if (list.length === 0) {
    items.push({ el: txt(T, 'no agent matches the filter', { dimColor: true }), rows: 1 })
    ids.push(null)
  }
  if (select === undefined) return { head, items, ids }
  return selectTo === undefined ? { head, items, select, ids } : { head, items, select, selectTo, ids }
}

/** The plan bar's width by the pane's columns (none under 48: the count alone). */
const planBarW = (cols: number): number => (cols >= 100 ? 16 : cols >= 64 ? 10 : cols >= 48 ? 6 : 0)

/** A running row's plan line: `  ▸ <task>` (cut at the end), then a thin accent bar and `3/7` at the right; dim while the plan is stale. */
function planLineEl(T: T3, plan: TelemetryAgentPlanView, phase: ReturnType<typeof agentPhase>, cols: number, id: string): RenderElement {
  const task = planTaskText(plan, phase)
  const stale = plan.isStale
  const count = planCountText(plan)
  const barW = plan.fraction === null ? 0 : planBarW(cols)
  const what: Seg = stale ? dim(task.text) : task.isPhase ? (phase?.kind === 'tool' ? seg(task.text, { c: ACCENT }) : dim(task.text)) : seg(task.text)
  const left: Seg[] = [dim('  ▸ '), what, ...(task.sinceMs === null ? [] : [dim(` · ${fmtDuration(task.sinceMs)}`)])]
  const right: Seg[] = [...(barW > 0 ? [...thinBar(plan.fraction, barW, stale ? 'inactive' : ACCENT), seg(' ')] : []), seg(count, stale ? { dim: true } : { c: ACCENT })]
  const rightW = right.reduce((n, x) => n + cpLen(x.t), 0)
  // the task is cut at the end (a cut never takes the count)
  return trow(T, [grow(T, segsEl(T, fitSegs(left, Math.max(1, cols - rightW - GAP)))), cell(T, rightW, segsEl(T, right))], { gap: GAP, key: `plan:${id}` })
}

/** The drawer's plan lines: `plan · source` with the count, then the checklist (✓ done, ▸ active, ○ pending; `+N more`). */
function planDrawerLines(plan: TelemetryAgentPlanView, inner: number): Line[] {
  const label = [plan.title ?? 'plan', PLAN_SOURCE_LABEL[plan.source], ...(plan.isStale ? ['stale'] : [])].join(' · ')
  const count = planCountText(plan)
  const lines: Line[] = [lr([dim(label)], [seg(count, plan.isComplete ? { c: 'success' } : {})], inner)]
  if (plan.items.length === 0) {
    if (plan.currentTask !== null) lines.push(fitSegs([dim('▸ '), seg(plan.currentTask)], inner))
    return lines
  }
  const list = planChecklist(plan)
  for (const it of list.items) {
    const glyph = seg(`${PLAN_GLYPH[it.status]} `, it.status === 'done' ? { c: 'success' } : it.status === 'active' ? { c: ACCENT } : { dim: true })
    lines.push(fitSegs([glyph, it.status === 'active' ? seg(it.text) : dim(it.text)], inner))
  }
  if (list.more > 0) lines.push([dim(`  +${list.more} more`)])
  return lines
}

const PLAN_SOURCE_LABEL: Record<TelemetryAgentPlanView['source'], string> = { step: 'steps', todos: 'todos', progress: 'flow', tasks: 'tasks' }

/** The mix of the four token kinds as glyph density in the accent (as the Tokens tab draws it). */
const MIX_GLYPHS = ['█', '▓', '▒', '░'] as const

/** The selected agent's drawer lines (inside a card: two columns of chrome). */
function drawerOf(input: TabInput, r: TelemetryAgentRow): Line[] {
  const { s, layout } = input
  const inner = Math.max(8, layout.cols - 4)
  const agent = s.agents.byId[r.id]
  const sep = dim(' · ')
  const lines: Line[] = []
  let effort: string | null = null
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    const step = s.steps[i]
    if (step && step.agentId === r.id) {
      effort = step.effort
      break
    }
  }
  const parent = r.parentId !== null && r.parentId !== 'main' ? s.agents.byId[r.parentId]?.type ?? null : null
  const who: Seg[] = [seg(r.id === 'main' ? 'main loop' : r.type, { bold: true }), sep, seg(shortModel(r.modelLabel))]
  if (effort) who.push(sep, dim(`${effort} effort`))
  if (r.isBackground) who.push(sep, dim('background'))
  if (parent) who.push(sep, dim(`in ${parent}`))
  lines.push(fitSegs(who, inner))
  const u = r.usage
  const parts = stack([u.input, u.output, u.cacheRead, u.cacheWrite], Math.min(inner, 24))
  const mix: Seg[] = parts.map((n, i) => seg((MIX_GLYPHS[i] ?? '█').repeat(n), { c: ACCENT }))
  lines.push(fitSegs([...mix, dim('  in '), seg(fmtTokens(u.input)), sep, dim('out '), seg(fmtTokens(u.output)), sep, dim('cache r '), seg(fmtTokens(u.cacheRead)), sep, dim('w '), seg(fmtTokens(u.cacheWrite))], inner))
  if (agent) {
    const tools = Object.entries(agent.byTool)
      .sort((a, z) => z[1] - a[1])
      .slice(0, 5)
    if (tools.length > 0) {
      const segs: Seg[] = [dim('tools ')]
      tools.forEach(([tool, calls], i) => {
        if (i > 0) segs.push(sep)
        segs.push(seg(toolName(tool)), dim(` ${calls}`))
      })
      lines.push(fitSegs(segs, inner))
    }
  }
  const errs = r.toolErrors > 0 ? [sep, seg(`${r.toolErrors} err`, { c: 'error' })] : []
  lines.push(fitSegs([dim('ctx peak '), seg(fmtTokens(r.peakContextTokens)), sep, seg(`${r.steps}`), dim(' req'), sep, seg(`${r.toolCalls}`), dim(' tools'), ...errs, sep, seg(fmtDuration(r.durationMs))], inner))
  if (r.report) lines.push(fitSegs([dim('report '), dim(r.report.status), sep, seg(`${fmtTokens(r.report.totalTokens)} tok`), sep, seg(fmtDuration(r.report.totalDurationMs)), sep, seg(`${r.report.totalToolUseCount} tools`)], inner))
  if (r.plan) lines.push(...planDrawerLines(r.plan, inner))
  return lines
}
