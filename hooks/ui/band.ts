// session-telemetry: the band above the prompt, the pure half. What both
// surfaces draw from (hooks/ui/desktop/band.tsx, hooks/ui/term/band.tsx): the
// mode (hidden, one compact row, or the full 4 rows), the segmented context bar
// (parts with widths that add up exactly), the legend, the chips, the badge
// tone, the cache countdown. No elements, no `$`.
//
// Exports: BandShow, bandShow, badgeTone, bandTab, BarPart, barParts,
//          SEGMENT_HEX, SEGMENT_THEME, allocate, segmentPx, fmtCountdown,
//          cacheChip, Chip, bandChips, legendItems, LegendItem, compactParts,
//          contextSummary, BAND_FULL_ROWS

import type { TelemetryBandMode, TelemetryContextCategory, TelemetryUiTab } from '../../types'

import { fmtPct, fmtRate, fmtTokens, fmtUsd } from '../derive'
import { contextSegmentOf, type TelemetryBand, type TelemetryBandSegmentKey, type TelemetryBandTone } from '../insights'
import { cpLen, stack, type Tone } from '../ui-kit'

/** Content rows of the full band: title row, bar, legend, chips. */
export const BAND_FULL_ROWS = 4

export type BandShow = 'hidden' | 'compact' | 'full'

/**
 * How the band shows for a mode: `off` hides it; `compact` and `full` force a
 * shape; `auto` (and `on`) show the full band while something runs, the
 * context is at or past the warning line, or an alert is active, and one
 * compact row otherwise. A slot under BAND_FULL_ROWS rows gets the compact row.
 */
export function bandShow(mode: TelemetryBandMode, band: Pick<TelemetryBand, 'isActive' | 'alertCount' | 'context'>, maxRows: number): BandShow {
  if (mode === 'off') return 'hidden'
  if (maxRows < BAND_FULL_ROWS) return 'compact'
  if (mode === 'compact') return 'compact'
  if (mode === 'full') return 'full'
  const pressed = band.context.tone === 'warn' || band.context.tone === 'crit'
  return band.isActive || band.alertCount > 0 || pressed ? 'full' : 'compact'
}

/** The percentage badge's state colour: green under the warning line, amber to the critical one, red past it; none when unknown. */
export function badgeTone(tone: TelemetryBandTone): Tone | null {
  switch (tone) {
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'crit':
      return 'error'
    default:
      return null
  }
}

/** Where a press on the band opens the pane: an alert goes to Overview, context pressure to Context, else Agents. */
export function bandTab(band: Pick<TelemetryBand, 'alertCount' | 'context'>): TelemetryUiTab {
  if (band.alertCount > 0) return 'overview'
  if (band.context.tone === 'warn' || band.context.tone === 'crit') return 'context'
  return 'agents'
}

/** The desktop fills of the segments: the context categories' palette, one slot each, in the band's fixed order. */
export const SEGMENT_HEX: Record<TelemetryBandSegmentKey, string> = {
  'system-prompt': '#3b7dd8',
  'system-tools': '#d2704e',
  'mcp-tools': '#1f9bb0',
  skills: '#b8800f',
  memory: '#8b5cf6',
  messages: '#2fa36b',
  other: '#808080',
}

/** The terminal fallback theme keys, used only when the breakdown names no colour for a segment. */
export const SEGMENT_THEME: Record<TelemetryBandSegmentKey, string> = {
  'system-prompt': 'permission',
  'system-tools': 'claude',
  'mcp-tools': 'success',
  skills: 'warning',
  memory: 'planMode',
  messages: 'text',
  other: 'inactive',
}

export type BarPart = {
  kind: 'segment' | 'free' | 'buffer'
  key: TelemetryBandSegmentKey | 'free' | 'buffer'
  label: string
  tokens: number
  /** Of the window. */
  share: number | null
  /** The desktop fill. */
  hex: string
  /** The terminal colour: the engine's own key for the category (as /context draws it), else a fallback. */
  theme: string
}

/**
 * The bar's parts in order: the used segments, the free space, the
 * auto-compact buffer. Zero parts are left out. The terminal colour of a
 * segment is the theme key the engine gave the first category in it.
 */
export function barParts(band: Pick<TelemetryBand, 'context'>, categories: readonly TelemetryContextCategory[] = []): BarPart[] {
  const c = band.context
  const themeOf = (key: TelemetryBandSegmentKey): string => categories.find(cat => cat.kind === 'used' && !cat.isDeferred && contextSegmentOf(cat.name) === key)?.color ?? SEGMENT_THEME[key]
  const parts: BarPart[] = c.segments.filter(s => s.tokens > 0).map(s => ({ kind: 'segment', key: s.key, label: s.label, tokens: s.tokens, share: s.share, hex: SEGMENT_HEX[s.key], theme: themeOf(s.key) }))
  const window = c.window
  if (c.freeTokens !== null && c.freeTokens > 0) parts.push({ kind: 'free', key: 'free', label: 'Free', tokens: c.freeTokens, share: window ? c.freeTokens / window : null, hex: 'rgba(128,128,128,0.25)', theme: 'inactive' })
  if (c.bufferTokens !== null && c.bufferTokens > 0) parts.push({ kind: 'buffer', key: 'buffer', label: 'Autocompact buffer', tokens: c.bufferTokens, share: window ? c.bufferTokens / window : null, hex: '#808080', theme: 'inactive' })
  return parts
}

/**
 * Whole widths for `parts` over `width` units (largest remainder, as
 * `stack`), each positive part at least `min` wide where the width allows,
 * the difference taken from the widest parts. The widths add up to `width`
 * exactly when any part is positive.
 */
export function allocate(parts: readonly number[], width: number, min = 1): number[] {
  const w = Math.max(0, Math.floor(width))
  const cells = stack(parts, w)
  const positive = cells.map((_, i) => (parts[i] ?? 0) > 0)
  const n = positive.filter(Boolean).length
  if (n === 0 || w === 0) return cells
  const floor = Math.max(0, Math.min(min, Math.floor(w / n)))
  // raise the thin ones to the floor
  let debt = 0
  cells.forEach((c, i) => {
    if (positive[i] && c < floor) {
      debt += floor - c
      cells[i] = floor
    }
  })
  // and take the difference from the widest, never under the floor
  while (debt > 0) {
    let big = -1
    cells.forEach((c, i) => {
      if (positive[i] && c > floor && (big < 0 || c > (cells[big] ?? 0))) big = i
    })
    if (big < 0) break
    cells[big] = (cells[big] ?? 0) - 1
    debt -= 1
  }
  return cells
}

/**
 * Pixel widths of the bar's segments across `width` px with `gap` px between
 * neighbours: the widths and the gaps add up to `width` exactly; a shown part
 * is at least `min` px.
 */
export function segmentPx(parts: readonly number[], width: number, opts: { gap?: number; min?: number } = {}): number[] {
  const gap = Math.max(0, opts.gap ?? 1)
  const shown = parts.filter(p => p > 0).length
  const usable = Math.max(0, Math.floor(width) - gap * Math.max(0, shown - 1))
  return allocate(parts, usable, opts.min ?? 2)
}

/** The cache countdown: `3m 12s` / `42s` when precise, else `3m` / `<1m`; `cold` once past. */
export function fmtCountdown(ms: number | null, precise: boolean): string {
  if (ms === null || !Number.isFinite(ms)) return '–'
  if (ms <= 0) return 'cold'
  const s = Math.floor(ms / 1000)
  if (!precise) return s < 60 ? '<1m' : `${Math.floor(s / 60)}m`
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export type Chip = {
  id: 'cost' | 'agents' | 'burn' | 'cache' | 'alert'
  /** Runs: the text and whether it is the emphasised part. */
  runs: { t: string; bold?: boolean; dim?: boolean; tone?: Tone | 'accent' | null }[]
  /** Lower goes first when the width runs short. */
  prio: number
}

/** The cache chip: green while warm, amber while cooling (with what re-caching costs), dim once cold (the same), none when unknown. */
export function cacheChip(band: Pick<TelemetryBand, 'cache'>, precise: boolean): Chip | null {
  const c = band.cache
  if (c.status === 'unknown') return null
  const recache = c.recacheCostUsd !== null && c.recacheCostUsd >= 0.005 ? ` · re-cache ≈${fmtUsd(c.recacheCostUsd)}` : ''
  if (c.status === 'cold') return { id: 'cache', runs: [{ t: 'cache cold', dim: true }, { t: recache, dim: true }], prio: 5 }
  const tone: Tone = c.status === 'cooling' ? 'warning' : 'success'
  return { id: 'cache', runs: [{ t: 'cache ', dim: true }, { t: fmtCountdown(c.expiresInMs, precise), bold: true, tone }, ...(c.status === 'cooling' ? [{ t: recache, dim: true }] : [])], prio: 5 }
}

/** The chips row of the full band, in order: cost, agents, burn, the cache clock, the top alert (its message from 100 cells, its short form under). */
export function bandChips(band: TelemetryBand, opts: { precise: boolean; wide?: boolean }): Chip[] {
  const chips: Chip[] = []
  chips.push({ id: 'cost', runs: [{ t: fmtUsd(band.costUsd), bold: true }, { t: band.costSource === 'ledger' && band.costUsd > band.trackedUsd ? ' ledger' : ' tracked', dim: true }], prio: 9 })
  const agents: Chip['runs'] = []
  if (band.running > 0) agents.push({ t: `${band.running} ▶ running`, tone: 'accent' })
  agents.push({ t: `${agents.length > 0 ? ' · ' : ''}${band.done} done`, dim: true })
  if (band.failed > 0) agents.push({ t: ` · ${band.failed} failed`, tone: 'error' })
  if (band.stale > 0) agents.push({ t: ` · ${band.stale} stale`, tone: 'warning' })
  if (band.running > 0 || band.done > 0 || band.failed > 0 || band.stale > 0) chips.push({ id: 'agents', runs: agents, prio: 7 })
  if (band.burnUsdPerMin !== null && band.burnUsdPerMin > 0) chips.push({ id: 'burn', runs: [{ t: fmtRate(band.burnUsdPerMin), bold: true }], prio: 4 })
  const cache = cacheChip(band, opts.precise)
  if (cache) chips.push(cache)
  if (band.topAlert) {
    const a = band.topAlert
    const tone: Tone = a.level === 'crit' ? 'error' : 'warning'
    const more = band.alertCount > 1 ? ` +${band.alertCount - 1}` : ''
    chips.push({ id: 'alert', runs: [{ t: a.level === 'crit' ? '!! ' : '! ', bold: true, tone }, { t: opts.wide === false ? a.short : a.message, tone }, { t: more, dim: true }], prio: 10 })
  }
  return chips
}

/** Cells a chip takes. */
export const chipCells = (chip: Chip): number => chip.runs.reduce((n, r) => n + cpLen(r.t), 0)

/** The chips that fit `width` cells with `sep` cells between them, the lowest priority dropped first (the first kept whatever). */
export function fitChips(chips: readonly Chip[], width: number, sep = 3): Chip[] {
  let kept = [...chips]
  const w = (list: readonly Chip[]): number => list.reduce((n, c) => n + chipCells(c), 0) + Math.max(0, list.length - 1) * sep
  while (kept.length > 1 && w(kept) > width) {
    let drop = 0
    kept.forEach((c, i) => {
      const d = kept[drop]
      if (d && c.prio <= d.prio) drop = i
    })
    kept = kept.filter((_, i) => i !== drop)
  }
  return kept
}

export type LegendItem = { part: BarPart; value: string; pct: string }

/**
 * The legend's items: the used segments by size with the buffer last, each
 * with its tokens and share; the least significant dropped until they fit
 * `width` cells (`swatch label value pct`, `gap` cells apart). The buffer
 * goes first, then the smallest segments.
 */
export function legendItems(parts: readonly BarPart[], width: number, gap = 2): LegendItem[] {
  const segs = parts.filter(p => p.kind === 'segment')
  const buffer = parts.find(p => p.kind === 'buffer')
  const make = (p: BarPart): LegendItem => ({ part: p, value: fmtTokens(p.tokens), pct: p.share === null ? '' : fmtPct(p.share) })
  let items = [...segs.map(make), ...(buffer ? [make(buffer)] : [])]
  const cells = (it: LegendItem): number => 2 + cpLen(it.part.label) + 1 + cpLen(it.value) + (it.pct ? 1 + cpLen(it.pct) : 0)
  const w = (list: LegendItem[]): number => list.reduce((n, it) => n + cells(it), 0) + Math.max(0, list.length - 1) * gap
  while (items.length > 1 && w(items) > width) {
    const bufferAt = items.findIndex(it => it.part.kind === 'buffer')
    if (bufferAt >= 0) items = items.filter((_, i) => i !== bufferAt)
    else {
      let small = 0
      items.forEach((it, i) => {
        if (it.part.tokens < (items[small]?.part.tokens ?? Infinity)) small = i
      })
      items = items.filter((_, i) => i !== small)
    }
  }
  return items
}

/** Row 1's dim summary: `450k of 1M · compacts at 800k`. */
export function contextSummary(band: Pick<TelemetryBand, 'context'>, wide: boolean): string {
  const c = band.context
  if (c.tokens === null || c.window === null) return 'no context measure yet'
  const base = `${fmtTokens(c.tokens)} of ${fmtTokens(c.window)}`
  if (!wide || c.compactAtTokens === null) return base
  return `${base} · compacts at ${fmtTokens(c.compactAtTokens)}`
}

/** The compact row's parts after the title: cost, `ctx N%` (the bar is the surface's), the cache, the top alert's short text. */
export function compactParts(band: TelemetryBand, precise: boolean): { cost: string; ctx: string | null; cache: Chip | null; alert: { text: string; tone: Tone } | null } {
  const alert = band.topAlert ? { text: `${band.topAlert.level === 'crit' ? '!! ' : '! '}${band.topAlert.short}`, tone: (band.topAlert.level === 'crit' ? 'error' : 'warning') as Tone } : null
  return { cost: fmtUsd(band.costUsd), ctx: band.context.percent === null ? null : `ctx ${Math.round(band.context.percent)}%`, cache: cacheChip(band, precise), alert }
}
