// session-telemetry: the desktop Flow tab. deriveFlow's nodes and edges as an
// indented tree: each agent, then the models it ran on and the tools it called
// (weight bars relative to the heaviest edge of their kind), then the agents it
// spawned under it, each nested row hanging from a tree guide. Pure.
//
// Exports: deskFlow(T, input)

import type { RenderElement } from 'claude-code'

import { deriveFlow, fmtTokens, fmtUsd, type TelemetryFlowEdge, type TelemetryFlowNode } from '../../derive'
import { toolName } from '../common'
import type { TabInput } from '../layout'
import { barSvg, guideSvg, PALETTE } from '../svg'

import { cap, H, num, row, svg, truncateTo, txt, type DeskView, type Item, type T4 } from './kit'

export function deskFlow(T: T4, input: TabInput): DeskView {
  const { Box } = T
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
  if (flow.edges.length === 0 && flow.nodes.every(n => n.value === 0)) return { head: [], items: [{ el: cap(T, 'no data flow yet'), rows: H.line }] }
  const maxOf = (kind: TelemetryFlowEdge['kind']): number => Math.max(1, ...flow.edges.filter(e => e.kind === kind).map(e => e.value))
  const max = { model: maxOf('model'), tool: maxOf('tool'), spawn: maxOf('spawn') }
  const wide = cols >= 72
  const items: Item[] = []

  const line = (depth: number, isLast: boolean, kind: string, label: string, frac: number | null, value: string, cost: number | null, bold: boolean, color?: string): RenderElement =>
    row(
      T,
      [
        ...(depth > 0 ? [<Box flexShrink={0} paddingLeft={(depth - 1) * 2}>{svg(T, guideSvg({ width: 12, height: 16, isLast }))}</Box>] : []),
        ...(kind ? [cap(T, kind)] : []),
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          {txt(T, truncateTo(label, Math.max(8, cols - 30 - depth * 2)), bold ? { weight: 'semibold' } : {})}
        </Box>,
        ...(frac === null ? [<Box width={6} flexShrink={0} />] : [svg(T, barSvg(frac, { width: 36, height: 5, color }))]),
        num(T, value, 7, { tabular: true }),
        ...(wide ? [num(T, cost === null ? '' : fmtUsd(cost), 8, { size: 'caption', dimColor: true })] : []),
      ],
      { key: `flow:${depth}:${label}` },
    )

  const seen = new Set<string>()
  const visit = (id: string, depth: number, isLast: boolean, edge: TelemetryFlowEdge | null): void => {
    if (seen.has(id)) return
    seen.add(id)
    const node = nodes.get(id)
    if (!node) return
    items.push({ el: line(depth, isLast, depth === 0 ? '' : 'agent', depth === 0 ? 'main' : node.label, edge ? edge.value / max.spawn : null, fmtTokens(node.value), node.costUsd, true), rows: H.line })
    const edges = out.get(id) ?? []
    const models = edges.filter(e => e.kind === 'model').sort((a, z) => z.value - a.value)
    const tools = edges.filter(e => e.kind === 'tool').sort((a, z) => z.value - a.value)
    const spawns = edges.filter(e => e.kind === 'spawn')
    const total = models.length + tools.length + spawns.length
    let k = 0
    for (const e of models) {
      k += 1
      items.push({ el: line(depth + 1, k === total, 'model', (nodes.get(e.to)?.label ?? e.to.slice(6)).replace(/^Claude /, ''), e.value / max.model, fmtTokens(e.value), e.costUsd, false), rows: H.line })
    }
    for (const e of tools) {
      k += 1
      items.push({ el: line(depth + 1, k === total, 'tool', e.to === 'tool:other' ? 'other tools' : toolName(e.to.slice(5)), e.value / max.tool, `${e.value}×`, null, false, PALETTE.neutral), rows: H.line })
    }
    for (const e of spawns) {
      k += 1
      visit(e.to, depth + 1, k === total, e)
    }
  }
  visit('agent:main', 0, true, null)
  for (const node of flow.nodes) if (node.kind === 'agent' && !seen.has(node.id)) visit(node.id, 0, true, null)
  return { head: [], items }
}
