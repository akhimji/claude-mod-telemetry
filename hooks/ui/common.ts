// session-telemetry: small pieces the tab builders share. Pure.
//
// The look: one accent colour (the theme's `claude`) for the shown tab, live
// things and bar fills; green / amber / red only for state; everything
// secondary dim. Numbers sit right-aligned in fixed cells; labels in a fixed
// column. Below NARROW cells there are no column tables: a row is a card of
// two or three lines (glyph + title + the primary number; then dim metrics
// separated by `·`; then a thin bar with figures to its right).
//
// Exports: NARROW, LABEL_W, section, toned, kv, statusGlyph, legend, shareBar,
//          empty, tableHead, toolName, limitName, safeError, card, cardLine, figure

import type { TelemetryAgentStatus, TelemetryToolStatus } from '../../types'

import type { TelemetryTimelineStatus } from '../derive'
import { mcpServerOf } from '../model'
import { ACCENT, cpLen, dim, fitSegs, isShellTool, lr, padLeft, padRight, seg, thinBar, truncate, type Column, type Line, type Seg, type Tone } from '../ui-kit'

/** Under this many cells a tab draws cards, not column tables. */
export const NARROW = 60

/** Label column width of a key/value row. */
export const LABEL_W = 10

/** A section rule: `── title ─────────` or `── title ────── right ──`, dim, the title a little heavier. */
export function section(title: string, cols: number, right = ''): Line {
  const t = title.toLowerCase()
  const used = 3 + cpLen(t) + 1 + (right ? cpLen(right) + 4 : 0)
  const rule = '─'.repeat(Math.max(1, cols - used))
  return [dim('── '), seg(t, { dim: true, bold: true }), dim(` ${rule}`), ...(right ? [dim(` ${right} ──`)] : [])]
}

/** Text in a state colour, or plain when there is no state. */
export const toned = (t: string, tone: Tone | null, extra: Omit<Seg, 't' | 'c'> = {}): Seg => (tone ? seg(t, { c: tone, ...extra }) : seg(t, extra))

/** `label      value...`: the label dim in a fixed column. */
export function kv(label: string, ...value: Seg[]): Line {
  return [dim(padRight(truncate(label, LABEL_W - 1), LABEL_W)), ...value]
}

/**
 * One glyph per status, one set everywhere: ▶ running (accent), ◌ stale (a
 * running loop gone quiet, amber), ✓ done (green), ✗ error (red), ■ stopped
 * (amber), ⊘ refused or denied (amber), ○ idle or not yet running (dim),
 * · informational (dim).
 */
export function statusGlyph(status: TelemetryAgentStatus | TelemetryToolStatus | TelemetryTimelineStatus | 'stale'): Seg {
  switch (status) {
    case 'running':
      return seg('▶', { c: ACCENT })
    case 'stale':
      return seg('◌', { c: 'warning' })
    case 'completed':
    case 'ok':
      return seg('✓', { c: 'success' })
    case 'error':
      return seg('✗', { c: 'error' })
    case 'aborted':
    case 'interrupted':
      return seg('■', { c: 'warning' })
    case 'refused':
    case 'denied':
      return seg('⊘', { c: 'warning' })
    case 'idle':
      return dim('○')
    case 'info':
      return dim('·')
    default:
      return dim('?')
  }
}

/** The glyph legend, one dim line (shown where there is room). */
export function legend(cols: number): Line {
  const full: Seg[] = [seg('▶', { c: ACCENT }), dim(' running  '), seg('✓', { c: 'success' }), dim(' done  '), seg('✗', { c: 'error' }), dim(' error  '), seg('■', { c: 'warning' }), dim(' stopped  '), dim('○ idle')]
  const short: Seg[] = [seg('▶', { c: ACCENT }), dim(' running  '), seg('✓', { c: 'success' }), dim(' done  '), seg('✗', { c: 'error' }), dim(' error  '), dim('○ idle')]
  const w = (segs: Seg[]): number => segs.reduce((n, s) => n + cpLen(s.t), 0)
  return w(full) <= cols ? full : fitSegs(short, cols)
}

/** A share bar: thin, the fill in a colour (the accent unless a state colour is given), the track dim. */
export const shareBar = (frac: number | null | undefined, width: number, color: string = ACCENT): Seg[] => thinBar(frac, width, color)

/** A dim one-liner for a list with nothing in it yet. */
export const empty = (text: string): Line => [dim(text)]

/** A table's header row: dim column heads aligned as their cells are. */
export function tableHead(cols: readonly (Column & { width: number })[]): Record<string, Seg> {
  const out: Record<string, Seg> = {}
  for (const c of cols) out[c.id] = dim(c.head)
  return out
}

/** An MCP tool as `server:tool`; any other name as it is. */
export function toolName(tool: string): string {
  const server = mcpServerOf(tool)
  return server === null ? tool : `${server}:${tool.slice(`mcp__${server}__`.length)}`
}

/** A rate-limit window's kind, short: `five_hour` -> `5h`, `seven_day_opus` -> `7d opus`. */
export function limitName(kind: string): string {
  return kind.replace(/^five_hour/, '5h').replace(/^seven_day/, '7d').replace(/_/g, ' ').trim()
}

/**
 * A call's error text made safe to draw: none for a shell tool (its errors
 * quote the command line), URL user info and queries dropped otherwise.
 */
export function safeError(tool: string, error: string | null | undefined): string {
  if (!error || isShellTool(tool)) return ''
  return error.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]*@/gi, '$1').replace(/([?#])\S*/g, '')
}

/** A number for a fixed cell: right-aligned in `width`. */
export const figure = (text: string, width: number, style: Omit<Seg, 't'> = {}): Seg => seg(padLeft(text, width), style)

/**
 * One line of a card: a glyph (or none), the title runs, and figures at the
 * right edge; `indent` cells before the title when there is no glyph.
 */
export function cardLine(cols: number, glyph: Seg | null, title: readonly Seg[], right: readonly Seg[] = [], indent = 2): Seg[] {
  const lead: Seg[] = glyph === null ? [seg(' '.repeat(indent))] : [glyph, seg(' ')]
  return lr([...lead, ...title], right, cols)
}

/**
 * A card: the title line (glyph, title in bold, the primary number right),
 * a dim metrics line indented under it, and, when given, a bar line (the
 * bar at the left, figures at the right). `metrics` are joined by ` · `.
 */
export function card(
  cols: number,
  glyph: Seg,
  title: readonly Seg[],
  primary: readonly Seg[],
  metrics: readonly Seg[][],
  bar?: { segs: Seg[]; right: Seg[] },
): Line[] {
  const dot = dim(' · ')
  const metricSegs: Seg[] = []
  metrics.forEach(m => {
    if (m.length === 0) return
    if (metricSegs.length > 0) metricSegs.push(dot)
    metricSegs.push(...m)
  })
  const lines: Line[] = [cardLine(cols, glyph, title, primary)]
  if (metricSegs.length > 0) lines.push([seg('  '), ...fitSegs(metricSegs, cols - 2)])
  if (bar) lines.push(lr([seg('  '), ...bar.segs], bar.right, cols))
  return lines
}
