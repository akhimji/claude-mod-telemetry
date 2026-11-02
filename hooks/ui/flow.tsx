// session-telemetry: tab 6, Flow. deriveFlow's nodes and edges as a text tree:
// each agent, then the models it ran on and the tools it called (with weight
// bars, relative to the heaviest edge of their kind), then the agents it
// spawned, indented under it.
//
// Exports: flowTab(input)

import { deriveFlow, fmtTokens, fmtUsd, type TelemetryFlowEdge, type TelemetryFlowNode } from '../derive'
import { cpLen, dim, padLeft, seg, truncate, type Line, type Seg } from '../ui-kit'

import { empty, shareBar, toolName } from './common'
import { rowsOf, type TabInput, type TabView } from './layout'

export function flowTab(input: TabInput): TabView {
  const { s, layout } = input
  const cols = layout.cols
  const flow = deriveFlow(s, { maxTools: 8 })
  const nodes = new Map<string, TelemetryFlowNode>(flow.nodes.map(n => [n.id, n]))
  const out = new Map<string, TelemetryFlowEdge[]>()
  for (const e of flow.edges) {
    const list = out.get(e.from) ?? []
    list.push(e)
    out.set(e.from, list)
  }
  if (flow.edges.length === 0 && flow.nodes.every(n => n.value === 0)) return { head: [], items: [[empty('no data flow yet')]] }
  const maxOf = (kind: TelemetryFlowEdge['kind']): number => Math.max(1, ...flow.edges.filter(e => e.kind === kind).map(e => e.value))
  const maxModel = maxOf('model')
  const maxTool = maxOf('tool')
  const maxSpawn = maxOf('spawn')

  // right-hand figures: bar, value, cost, requests
  const wide = cols >= 72
  const barW = cols >= 110 ? 12 : cols >= 72 ? 8 : 0
  const figW = (barW > 0 ? barW + 1 : 0) + 7 + (wide ? 9 + 8 : 0)
  const labelW = Math.max(10, cols - figW - 1)

  const figures = (frac: number | null, value: string, cost: number | null, req: number | null, color = 'claude'): Seg[] => [
    ...(barW > 0 ? (frac === null ? [seg(' '.repeat(barW + 1))] : [...shareBar(frac, barW, color), seg(' ')]) : []),
    seg(padLeft(value, 7)),
    ...(wide ? [dim(padLeft(cost === null ? '' : fmtUsd(cost), 9)), dim(padLeft(req === null ? '' : `${req} req`, 8))] : []),
  ]
  const row = (prefix: string, label: Seg[], figs: Seg[]): Line => {
    const room = labelW - cpLen(prefix)
    const cut: Seg[] = []
    let used = 0
    for (const l of label) {
      const w = cpLen(l.t)
      if (used + w <= room) {
        cut.push(l)
        used += w
      } else {
        if (room - used > 0) cut.push({ ...l, t: truncate(l.t, room - used) })
        used = room
        break
      }
    }
    return [dim(prefix), ...cut, seg(' '.repeat(Math.max(0, room - used) + 1)), ...figs]
  }

  const lines: Line[] = []
  const seen = new Set<string>()
  const visit = (id: string, indent: string, isLast: boolean, isRoot: boolean, edge: TelemetryFlowEdge | null): void => {
    if (seen.has(id)) return
    seen.add(id)
    const node = nodes.get(id)
    if (!node) return
    const lead = isRoot ? '' : `${indent}${isLast ? '└─ ' : '├─ '}`
    const childIndent = isRoot ? '' : `${indent}${isLast ? '   ' : '│  '}`
    lines.push(
      row(lead, [seg(isRoot ? 'main' : 'agent ', isRoot ? { bold: true } : { dim: true }), ...(isRoot ? [] : [seg(node.label, { bold: true })])], figures(edge ? edge.value / maxSpawn : null, fmtTokens(node.value), node.costUsd, edge?.requests ?? null)),
    )
    const edges = out.get(id) ?? []
    const models = edges.filter(e => e.kind === 'model').sort((a, z) => z.value - a.value)
    const tools = edges.filter(e => e.kind === 'tool').sort((a, z) => z.value - a.value)
    const spawns = edges.filter(e => e.kind === 'spawn')
    const kids: (() => void)[] = []
    const total = models.length + tools.length + spawns.length
    let n = 0
    const branch = (): { mark: string; last: boolean } => {
      n += 1
      const last = n === total
      return { mark: `${childIndent}${last ? '└─ ' : '├─ '}`, last }
    }
    for (const e of models) {
      const b = branch()
      const label = nodes.get(e.to)?.label.replace(/^Claude /, '') ?? e.to.slice(6)
      lines.push(row(b.mark, [dim('model '), seg(label)], figures(e.value / maxModel, fmtTokens(e.value), e.costUsd, e.requests)))
    }
    for (const e of tools) {
      const b = branch()
      const label = e.to === 'tool:other' ? 'other tools' : toolName(e.to.slice(5))
      lines.push(row(b.mark, [dim('tool  '), seg(label)], figures(e.value / maxTool, `${e.value}×`, null, null, 'subtle')))
    }
    spawns.forEach(e => {
      const b = branch()
      kids.push(() => visit(e.to, childIndent, b.last, false, e))
    })
    for (const k of kids) k()
  }
  visit('agent:main', '', true, true, null)
  // agents not reachable from main (their parent evicted)
  for (const node of flow.nodes) if (node.kind === 'agent' && !seen.has(node.id)) visit(node.id, '', true, false, null)

  const head: Line[] = [
    [dim(padLeft('', labelW + 1)), ...(barW > 0 ? [dim(`${'weight'.padEnd(barW)} `)] : []), dim(padLeft('value', 7)), ...(wide ? [dim(padLeft('cost', 9)), dim(padLeft('req', 8))] : [])],
  ]
  return { head, items: rowsOf(lines.length > 0 ? lines : [empty('no data flow yet')]) }
}
