// session-telemetry: the terminal kit. The small pieces every terminal tab is
// built from, each a function of the surface's element table `T` (Box, Text,
// Button) and plain data; pure, no `$`. Layout is flex as on the desktop
// (NOTES.md, "Terminal design"): a row is a `Box` of height 1, a number sits in
// a fixed-width cell with `justifyContent="flex-end"`, the name cell grows and
// truncates; and the graphics are the monospace glyphs of hooks/ui-kit.ts (thin
// bars, eighth blocks, sparklines, box-drawing rules) in theme colours.
//
// Exports: T3, Item, TermView, txt, segsEl, lineEl, cell, grow, trow, linesEl,
//          card, fromView, dotOf (glyph), fillCells

import type { BoxProps, ButtonProps, ElementConstructor, InputProps, RenderElement, TextProps } from 'claude-code'

import type { TelemetryAgentStatus, TelemetryToolStatus } from '../../../types'
import type { TelemetryTimelineStatus } from '../../derive'
import { fitLine, isBtn, type Line, type Seg } from '../../ui-kit'
import { statusGlyph } from '../common'
import type { TabView } from '../layout'

/** The elements the terminal path draws with (Input only for the Agents search field). */
export type T3 = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input?: ElementConstructor<InputProps>
}

/**
 * One windowed item of a tab: its element and its height in rows (an integer);
 * `parts`, the same content as smaller items, which the frame windows instead
 * when the whole is taller than the body's room (an agent drawer).
 */
export type Item = { el: RenderElement; rows: number; parts?: Item[] }

/** What a terminal tab builder returns: pinned head items, windowed items, the selected item, the agent id of each item. */
export type TermView = { head: Item[]; items: Item[]; select?: number; selectTo?: number; ids?: (string | null)[] }

function styleOf(s: Seg): TextProps {
  const p: TextProps = {}
  if (s.c !== undefined) p.color = s.c
  if (s.dim) p.dimColor = true
  if (s.bold) p.weight = 'bold'
  if (s.inv) p.inverse = true
  return p
}

/** One run of text, truncated at its cell's edge. */
export function txt(T: T3, text: string, p: TextProps = {}): RenderElement {
  const { Text } = T
  return (
    <Text wrap="truncate" {...p}>
      {text === '' ? ' ' : text}
    </Text>
  )
}

/** Runs of styled text as one truncating `Text` (nested runs keep their own style). */
export function segsEl(T: T3, segs: readonly Seg[]): RenderElement {
  const { Text } = T
  const runs = segs.filter(s => s.t !== '')
  if (runs.length === 0) return txt(T, ' ')
  return (
    <Text wrap="truncate">
      {runs.map(s => (
        <Text {...styleOf(s)}>{s.t}</Text>
      ))}
    </Text>
  )
}

/**
 * One line of the line kit as an element: a `Text` of runs, or, where it holds
 * a Button, a row `Box` of Buttons and Texts (the terminal draws `k: ` before a
 * plain Button with a hotkey).
 */
export function lineEl(T: T3, line: Line, onAct: (act: string) => void): RenderElement {
  const { Box, Button, Text } = T
  if (!line.some(isBtn)) return segsEl(T, line as Seg[])
  const runs = (segs: readonly Seg[]) => segs.filter(s => s.t !== '').map(s => <Text {...styleOf(s)}>{s.t}</Text>)
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      {line.map(item =>
        isBtn(item) ? (
          item.hk === undefined ? (
            <Button key={item.btn} label={item.segs.map(s => s.t).join('')} plain onPress={() => onAct(item.act)}>
              {runs(item.segs)}
            </Button>
          ) : (
            <Button key={item.btn} label={item.segs.map(s => s.t).join('')} plain hotkey={item.hk} onPress={() => onAct(item.act)}>
              {runs(item.segs)}
            </Button>
          )
        ) : (
          <Text wrap="truncate" {...styleOf(item)}>
            {item.t}
          </Text>
        ),
      )}
    </Box>
  )
}

/** A fixed cell of `w` columns, its content at the right edge unless `align: 'l'`. */
export function cell(T: T3, w: number, child: RenderElement, align: 'l' | 'r' = 'r'): RenderElement {
  const { Box } = T
  return (
    <Box width={w} flexShrink={0} flexDirection="row" justifyContent={align === 'r' ? 'flex-end' : 'flex-start'} overflow="hidden">
      {child}
    </Box>
  )
}

/** The cell that takes what the fixed ones leave, cut at its edge. */
export function grow(T: T3, child: RenderElement): RenderElement {
  const { Box } = T
  return (
    <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
      {child}
    </Box>
  )
}

/** A row of cells, one terminal row tall, `gap` columns between the cells. */
export function trow(T: T3, cells: RenderElement[], opts: { gap?: number; key?: string; justify?: BoxProps['justifyContent'] } = {}): RenderElement {
  const { Box } = T
  const props: BoxProps = { flexDirection: 'row', height: 1, overflow: 'hidden', gap: opts.gap ?? 1 }
  if (opts.key) props.key = opts.key
  if (opts.justify) props.justifyContent = opts.justify
  return <Box {...props}>{cells}</Box>
}

/** Several lines stacked, one row each. */
export function linesEl(T: T3, lines: readonly Line[], onAct: (act: string) => void): RenderElement {
  const { Box } = T
  return (
    <Box flexDirection="column" overflow="hidden">
      {lines.map(l => lineEl(T, l, onAct))}
    </Box>
  )
}

/** A rounded, dim-bordered card around lines: two rows and two columns of chrome. */
export function card(T: T3, lines: readonly Line[], onAct: (act: string) => void, opts: { key?: string } = {}): RenderElement {
  const { Box } = T
  const props: BoxProps = { flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, overflow: 'hidden' }
  if (opts.key) props.key = opts.key
  return <Box {...props}>{lines.map(l => lineEl(T, l, onAct))}</Box>
}

/** Rows a card of `n` lines takes. */
export const CARD_CHROME = 2

/**
 * A line-kit tab's view as terminal items, every line cut to `cols` (a hotkey
 * Button that would not fit whole is dropped, a text run ends in an ellipsis:
 * `fitLine`): each head line one row, each item one element of as many rows as
 * it has lines, the foot last.
 */
export function fromView(T: T3, view: TabView, onAct: (act: string) => void, cols: number): TermView {
  const fit = (l: Line): Line => fitLine(l, cols)
  const head: Item[] = view.head.map(l => ({ el: lineEl(T, fit(l), onAct), rows: 1 }))
  const items: Item[] = view.items.map(lines => (lines.length === 1 ? { el: lineEl(T, fit(lines[0] ?? []), onAct), rows: 1 } : { el: linesEl(T, lines.map(fit), onAct), rows: Math.max(1, lines.length) }))
  const ids = view.ids ? [...view.ids] : undefined
  for (const l of view.foot ?? []) {
    items.push({ el: lineEl(T, fit(l), onAct), rows: 1 })
    ids?.push(null)
  }
  const out: TermView = { head, items }
  if (view.select !== undefined) out.select = view.select
  if (ids) out.ids = ids
  return out
}

/** The status glyph as a Text (one cell). */
export const dotOf = (T: T3, status: TelemetryAgentStatus | TelemetryToolStatus | TelemetryTimelineStatus | 'stale'): RenderElement => segsEl(T, [statusGlyph(status)])

/** The width of a thin bar inside a `ctx` cell of `w` cells: the cell less ` 45%`. */
export const fillCells = (w: number): number => Math.max(0, w - 4)
