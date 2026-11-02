// session-telemetry: what the two headers share. Pure.
//
// The tab labels and their order, `isActive` (whether the pane is live and
// ticks), `fillGroup` (the context fill as a thin bar with its percentage),
// and `tabBar`, the terminal's tab row of seven plain Buttons.
//
// Exports: tabBar(tab, layout), TAB_LABELS, TAB_ORDER, isActive(s, now), fillGroup

import type { TelemetryUiTab } from '../../types'

import { fmtPct, isActive } from '../derive'
import { ACCENT, btn, dim, fillTone, fitSegs, lineWidth, seg, thinBarParts, type Line, type Seg } from '../ui-kit'

import type { Layout } from './layout'

/** Full name, then the short names tried in turn as the width shrinks. */
export const TAB_LABELS: Record<TelemetryUiTab, [string, string, string, string]> = {
  overview: ['Overview', 'Ovw', 'Ov', 'O'],
  agents: ['Agents', 'Agt', 'Ag', 'A'],
  tokens: ['Tokens', 'Tok', 'Tk', 'T'],
  context: ['Context', 'Ctx', 'Cx', 'C'],
  tools: ['Tools', 'Tool', 'Tl', 'L'],
  flow: ['Flow', 'Flow', 'Fl', 'F'],
  live: ['Live', 'Live', 'Lv', 'V'],
}

/** Agents first: it is the pane's hero and its default tab (hotkeys 1 to 7 follow this order). */
export const TAB_ORDER: TelemetryUiTab[] = ['agents', 'overview', 'tokens', 'context', 'tools', 'flow', 'live']

/** Whether the pane is live and ticks: now in derive.ts (insights.ts uses it too), re-exported here unchanged. */
export { isActive }

/** The context fill as `ctx ━━━━╸───── 45%`: a thin bar in the 70/90 state colour, dim when unknown. */
export function fillGroup(fill: number | null, width: number, label = 'ctx'): Seg[] {
  const tone = fillTone(fill)
  const { fill: f, rest } = thinBarParts(fill, width)
  return [
    ...(label ? [dim(`${label} `)] : []),
    ...(f ? [seg(f, tone ? { c: tone } : { dim: true })] : []),
    ...(rest > 0 ? [dim('─'.repeat(rest))] : []),
    seg(` ${fill === null ? '–' : fmtPct(fill)}`, tone ? { c: tone } : { dim: true }),
  ]
}

/**
 * The terminal's tab bar: seven plain Buttons, hotkeys 1 to 7, which the
 * terminal draws once as `n: ` before each label. The shown tab is named in
 * full and inverted in the accent; the others are dim and as short as the
 * width needs. At the dock's narrowest (24 cells) the others lose their
 * hotkeys (a click, or Tab and Enter, still switches) so all seven stay drawn.
 */
export function tabBar(tab: TelemetryUiTab, layout: Layout): Line {
  const { cols, hkPrefix } = layout
  type V = 0 | 1 | 2 | 3
  const build = (variant: V, shownVariant: V, gap: string, keys: boolean): Line => {
    const line: Line = []
    TAB_ORDER.forEach((id, i) => {
      if (i > 0 && gap !== '') line.push(seg(gap))
      const shown = id === tab
      const label = shown ? TAB_LABELS[id][shownVariant] : TAB_LABELS[id][variant]
      const withKey = shown || keys
      const hint: Seg[] = hkPrefix || !withKey ? [] : [dim(`${i + 1} `)]
      const segs: Seg[] = shown ? [...hint, seg(label, { c: ACCENT, bold: true, inv: true })] : [...hint, dim(label)]
      line.push(withKey ? btn(`tab:${id}`, `tab:${id}`, segs, String(i + 1), hkPrefix ? undefined : 0) : btn(`tab:${id}`, `tab:${id}`, segs))
    })
    return line
  }
  // the shown tab in full first; then it shortens too, before the gaps go (a row with no gaps is hard to read)
  const tries: [V, V, string, boolean][] = [
    [0, 0, '  ', true],
    [1, 0, '  ', true],
    [1, 0, ' ', true],
    [2, 0, ' ', true],
    [3, 0, ' ', true],
    [3, 1, ' ', true],
    [3, 2, ' ', true],
    [3, 3, ' ', true],
    [3, 3, '', true],
    [3, 3, ' ', false],
    [3, 3, '', false],
  ]
  const room = hkPrefix ? cols : cols - Math.min(TAB_ORDER.length, Math.floor(cols / 10))
  for (const [variant, shownVariant, gap, keys] of tries) {
    const line = build(variant, shownVariant, gap, keys)
    if (lineWidth(line) <= room) return line
  }
  return fitSegs(build(3, 3, '', false) as Seg[], cols)
}
