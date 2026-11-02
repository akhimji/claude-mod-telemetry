// session-telemetry: the band above the prompt on the surfaces that draw Svg
// (desktop, vscode). The engine's own context band imitated: a rounded box;
// row 1 `◆ telemetry` (a Button: opens the pane) at the left, the context
// summary dim and a solid percentage badge (a Button: the Context tab) at the
// right; row 2 one segmented context bar (segmentsSvg: the categories' fills,
// the free space a thin track, the auto-compact buffer hatched at the end);
// row 3 the legend (swatch, label, bold value, dim share; the least
// significant dropped to fit); row 4 the chips: cost, agents, burn, the cache
// clock, the top alert. Collapsed: one row, `◆ telemetry · $30.36 · ctx 25%
// ▬▬ · cache 3m`. Pure: the element table, the band model and plain options
// in, a tree out. No box glyphs on this path (the bars are Svg).
//
// Exports: deskBand(T, band, opts, onAct), BAND_BAR_PX

import type { RenderElement, TextProps } from 'claude-code'

import type { TelemetryContextCategory } from '../../../types'
import type { TelemetryBand } from '../../insights'
import { ACCENT } from '../../ui-kit'
import { badgeTone, bandChips, barParts, compactParts, contextSummary, fitChips, legendItems, segmentPx, type BandShow, type Chip } from '../band'
import { barSvg, segmentsSvg, swatchSvg, toneHex } from '../svg'

import { cap, row, svg, txt, type T4 } from './kit'

/** The bar's width in CSS px for a band of `cols` cells: about 7px a cell, within bounds, so it never runs past the slot. */
export const BAND_BAR_PX = (cols: number): number => Math.max(160, Math.min(1400, cols * 7 - 24))

export type DeskBandOpts = {
  show: Exclude<BandShow, 'hidden'>
  cols: number
  /** Seconds on the cache countdown (a tick is running), else minutes. */
  precise: boolean
  categories?: readonly TelemetryContextCategory[]
}

const runProps = (r: Chip['runs'][number]): TextProps => {
  const p: TextProps = { size: 'caption' }
  if (r.bold) p.weight = 'semibold'
  if (r.dim) p.dimColor = true
  if (r.tone === 'accent') p.color = ACCENT
  else if (r.tone) p.color = r.tone
  return p
}

function chipEl(T: T4, chip: Chip): RenderElement {
  const { Box, Text } = T
  return (
    <Box flexDirection="row" flexShrink={0} overflow="hidden" key={`chip:${chip.id}`}>
      <Text wrap="truncate" size="caption">
        {chip.runs.filter(r => r.t !== '').map(r => (
          <Text {...runProps(r)}>{r.t}</Text>
        ))}
      </Text>
    </Box>
  )
}

export function deskBand(T: T4, band: TelemetryBand, opts: DeskBandOpts, onAct: (act: string) => void): RenderElement {
  const { Box, Button, Text } = T
  const { cols } = opts
  const tone = badgeTone(band.context.tone)
  const toneProps: TextProps = tone ? { color: tone } : { dimColor: true }
  const pct = band.context.percent === null ? '–' : `${Math.round(band.context.percent)}%`
  const title = (
    <Button key="band:open" label="telemetry" plain hotkey="t" onPress={() => onAct('band:open')}>
      <Text weight="semibold">◆ telemetry</Text>
    </Button>
  )

  if (opts.show === 'compact') {
    const p = compactParts(band, opts.precise)
    const sep = cap(T, '·')
    const cells: RenderElement[] = [title, sep, txt(T, p.cost, { weight: 'semibold', tabular: true, size: 'caption' })]
    if (p.ctx !== null) cells.push(sep, cap(T, p.ctx, { ...toneProps, tabular: true }), svg(T, barSvg(band.context.fill, { width: 36, height: 5, color: toneHex(tone) })))
    if (p.cache && cols >= 40) cells.push(sep, chipEl(T, p.cache))
    if (p.alert && cols >= 48) cells.push(sep, cap(T, p.alert.text, { color: p.alert.tone, dimColor: false }))
    return (
      <Box flexDirection="row" alignItems="center" gap="xs" overflow="hidden">
        {cells}
      </Box>
    )
  }

  const parts = barParts(band, opts.categories)
  const width = BAND_BAR_PX(cols)
  const px = segmentPx(
    parts.map(p => p.tokens),
    width,
    { gap: 1, min: 3 },
  )
  const bar = segmentsSvg(
    parts.map((p, i) => ({ px: px[i] ?? 0, color: p.hex, kind: p.kind, label: p.label })),
    { width, height: 8 },
  )
  const legend = legendItems(parts, cols - 2, 2)
  const chips = fitChips(bandChips(band, { precise: opts.precise, wide: cols >= 100 }), cols - 2, 3)
  const badge = (
    <Button key="band:context" label={`context ${pct}`} plain onPress={() => onAct('band:context')}>
      <Text weight="semibold" tabular inverse {...(tone ? { color: tone } : {})}>
        {` ${pct} `}
      </Text>
    </Button>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} overflow="hidden">
      {row(T, [title, row(T, [cap(T, contextSummary(band, cols >= 72), { tabular: true }), badge], {})], { justify: 'space-between' })}
      <Box flexDirection="row" overflow="hidden">
        {svg(T, bar)}
      </Box>
      <Box flexDirection="row" alignItems="center" gap="sm" overflow="hidden">
        {legend.length === 0
          ? [cap(T, band.context.breakdownAt === null ? 'no breakdown yet: the categories arrive after the first turn' : 'nothing in the window')]
          : legend.map(it => (
              <Box flexDirection="row" alignItems="center" gap="xs" flexShrink={0} overflow="hidden" key={`legend:${it.part.key}`}>
                {svg(T, swatchSvg(it.part.kind === 'buffer' ? '#808080' : it.part.hex, { size: 8, alt: it.part.label }))}
                {cap(T, it.part.label)}
                {txt(T, it.value, { weight: 'semibold', tabular: true, size: 'caption' })}
                {it.pct ? cap(T, it.pct, { tabular: true }) : txt(T, '', { size: 'caption' })}
              </Box>
            ))}
      </Box>
      <Box flexDirection="row" alignItems="center" gap="sm" overflow="hidden">
        {chips.map(c => chipEl(T, c))}
      </Box>
    </Box>
  )
}
