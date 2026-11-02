// session-telemetry: the desktop kit. The small pieces every desktop tab is
// built from, each a function of the surface's element table `T` (Box, Text,
// Button, Svg) and plain data; pure, no `$`. Layout is flex (NOTES.md,
// "Desktop design spec"): a row is a Box, a number sits right-aligned in a
// fixed-width cell, graphics are `Svg` from ../svg.ts, and nothing is aligned
// with spaces or drawn with box glyphs.
//
// Exports: T4, Item, DeskView, H, txt, cap, num, row, kv, section, card, svg,
//          tile, truncateTo, modelShort, dotOf, toneOf

import type { BoxProps, ButtonProps, ElementConstructor, InputProps, RenderElement, SvgProps, TextProps } from 'claude-code'

import type { TelemetryAgentStatus, TelemetryToolStatus } from '../../../types'
import type { TelemetryTimelineStatus } from '../../derive'
import { truncate, type Tone } from '../../ui-kit'
import { dotSvg, type DotStatus, type SvgSpec } from '../svg'

/** The four elements the desktop path draws with (vscode and mobile carry them too), and Input for the Agents search field. */
export type T4 = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Svg: ElementConstructor<SvgProps>
  Input?: ElementConstructor<InputProps>
}

/**
 * One windowed item of a tab: its element and its estimated height in rows;
 * `parts`, the same content as smaller items, which the frame windows instead
 * when the whole is taller than the body's room (an agent drawer).
 */
export type Item = { el: RenderElement; rows: number; parts?: Item[] }

/** What a desktop tab builder returns (as the terminal's TabView, with elements). */
/** `selectTo`: the selection's extent (the focused row's open drawer), kept in view with it as far as it fits. */
export type DeskView = { head: Item[]; items: Item[]; select?: number; selectTo?: number; ids?: (string | null)[] }

/** Estimated heights in rows of the body's cells: under-fill rather than overflow. */
export const H = {
  /** A plain text line. */
  line: 1,
  /** A row with `paddingY="xs"`. */
  row: 1.5,
  /** A section head (a caption with space above). */
  section: 1.5,
  /** The agent lanes strip. */
  lanes: 3,
  /** A sparkline row. */
  spark: 2,
  /** The context grid (100px). */
  grid: 6,
  /** A stacked mix bar row. */
  mix: 1.5,
  /** A card's border and padding, on top of its rows. */
  cardChrome: 1.5,
} as const

export const modelShort = (label: string | null | undefined): string => (label ?? '–').replace(/^Claude /, '')

/** A text run; `wrap="truncate"` so a row is never taller than one line. */
export function txt(T: T4, text: string, p: TextProps = {}): RenderElement {
  const { Text } = T
  return (
    <Text wrap="truncate" {...p}>
      {text === '' ? ' ' : text}
    </Text>
  )
}

/** A caption: small and dim unless told otherwise. */
export const cap = (T: T4, text: string, p: TextProps = {}): RenderElement => txt(T, text, { size: 'caption', dimColor: true, ...p })

/** A number in a fixed cell of `w` cells, right-aligned, tabular digits. */
export function num(T: T4, text: string, w: number, p: TextProps = {}): RenderElement {
  const { Box } = T
  return (
    <Box width={w} flexShrink={0} flexDirection="row" justifyContent="flex-end" overflow="hidden">
      {txt(T, text, { tabular: true, ...p })}
    </Box>
  )
}

/** A row of cells: centred, a small gap, padded top and bottom when `pad` (a click target). */
export function row(T: T4, children: RenderElement[], opts: { pad?: boolean; justify?: BoxProps['justifyContent']; key?: string } = {}): RenderElement {
  const { Box } = T
  const props: BoxProps = { flexDirection: 'row', alignItems: 'center', gap: 'xs', overflow: 'hidden' }
  if (opts.pad) props.paddingY = 'xs'
  if (opts.justify) props.justifyContent = opts.justify
  if (opts.key) props.key = opts.key
  return <Box {...props}>{children}</Box>
}

/** A label at the left and a value at the right of one row. */
export function kv(T: T4, label: string, value: RenderElement | string, opts: { pad?: boolean } = {}): RenderElement {
  const { Box } = T
  return row(T, [<Box flexShrink={1} overflow="hidden">{cap(T, label)}</Box>, <Box flexShrink={0}>{typeof value === 'string' ? txt(T, value, { tabular: true }) : value}</Box>], { justify: 'space-between', pad: opts.pad ?? false })
}

/** A section head: a dim uppercase caption, a count at the right, space above. */
export function section(T: T4, title: string, right = ''): RenderElement {
  const { Box } = T
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingTop="sm" overflow="hidden">
      {cap(T, title.toUpperCase(), { weight: 'semibold' })}
      {right ? cap(T, right, { tabular: true }) : txt(T, ' ')}
    </Box>
  )
}

/** A rounded, dim-bordered card holding rows. */
export function card(T: T4, children: RenderElement[], opts: { key?: string } = {}): RenderElement {
  const { Box } = T
  const props: BoxProps = { flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, overflow: 'hidden' }
  if (opts.key) props.key = opts.key
  return <Box {...props}>{children}</Box>
}

/** An `Svg` from a spec, sized as the markup is. */
export function svg(T: T4, spec: SvgSpec): RenderElement {
  const { Svg } = T
  return <Svg source={spec.source} alt={spec.alt} width={spec.width} height={spec.height} />
}

/** A stat tile: a caption label over a semibold value, a caption below; a quarter of the row. */
export function tile(T: T4, label: string, value: RenderElement, sub: RenderElement | null): RenderElement {
  const { Box } = T
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} width="25%" overflow="hidden">
      {cap(T, label.toUpperCase())}
      {value}
      {sub ?? txt(T, ' ', { size: 'caption' })}
    </Box>
  )
}

export const truncateTo = (text: string, cells: number): string => truncate(text, Math.max(1, cells))

/** A status dot's kind for an agent, tool or timeline status. */
export function dotOf(status: TelemetryAgentStatus | TelemetryToolStatus | TelemetryTimelineStatus | 'stale'): DotStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'stale':
      return 'stale'
    case 'completed':
    case 'ok':
      return 'done'
    case 'error':
      return 'error'
    case 'aborted':
    case 'interrupted':
    case 'refused':
    case 'denied':
      return 'stopped'
    default:
      return 'idle'
  }
}

/** The status dot element. */
export const dot = (T: T4, status: DotStatus, size = 10): RenderElement => svg(T, dotSvg(status, { size }))

/** A tone as a Text colour prop (none when there is no state). */
export const toneOf = (tone: Tone | null): TextProps => (tone ? { color: tone } : {})
