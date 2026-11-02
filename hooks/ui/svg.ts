// session-telemetry: the pane's graphics for the surfaces that draw `Svg`
// (desktop, vscode, mobile). Pure: numbers in, SVG markup out, nothing of the
// engine. Every builder answers an `SvgSpec` the desktop kit hands to `<Svg>`
// as it is: `source`, `alt`, and the width and height in CSS pixels, which the
// markup also carries, so a surface that sizes the box from the markup agrees.
//
// No text is ever drawn inside an SVG (labels are `Text` elements with theme
// keys), so the only theme question here is the fills: mid-tone hexes that
// clear 3:1 on a light and on a dark surface alike (NOTES.md, "Desktop design
// spec", validated with the dataviz skill's checker), and a translucent grey
// track that reads on both.
//
// Payload: a remote surface receives every Svg's markup on each redraw, so the
// many-part builders are capped (lanes and segments at 120 parts, sparklines at
// 120 points, the grid at 200 cells) and memoised: the same data at the same
// size answers the very same markup (a bounded map, SVG_MEMO_MAX entries).
//
// Exports: SvgSpec, PALETTE, toneHex, categoryHex, barSvg, sparkSvg, stackSvg,
//          segmentsSvg (the band's context bar, hatched buffer), gridSvg,
//          gaugeSvg, swatchSvg, dotSvg, lanesSvg, guideSvg, DotStatus, Lane, SegmentPart,
//          SVG_CAPS, SVG_MEMO_MAX, svgMemoSize, clearSvgMemo

import type { Tone } from '../ui-kit'

export type SvgSpec = { source: string; alt: string; width: number; height: number }

export const PALETTE = {
  accent: '#d2704e',
  good: '#2fa36b',
  warning: '#b8800f',
  danger: '#d9484e',
  neutral: '#808080',
  track: 'rgba(128,128,128,0.25)',
  faint: 'rgba(128,128,128,0.14)',
  /** The token mix, in / out / cache read / cache write: one hue, light to dark. */
  mix: ['#e9a386', '#d9825f', '#c25c3a', '#8f3f22'],
  /** The context categories: blue, accent, teal, amber, violet, green. */
  categories: ['#3b7dd8', '#d2704e', '#1f9bb0', '#b8800f', '#8b5cf6', '#2fa36b'],
} as const

/** A state tone's fill, the accent with none. */
export function toneHex(tone: Tone | null | undefined): string {
  switch (tone) {
    case 'success':
      return PALETTE.good
    case 'warning':
      return PALETTE.warning
    case 'error':
      return PALETTE.danger
    default:
      return PALETTE.accent
  }
}

/**
 * A /context category's fill from the theme key the engine names for it. A
 * key with a hue of its own (claude, permission, cyan, purple, warning,
 * success, error) keeps it; a neutral or unknown key takes the categorical
 * slot at `index` (so two categories the engine draws grey stay distinct),
 * and neutral past the six slots or with no index (-1: free space, buffer).
 */
export function categoryHex(themeKey: string, index = -1): string {
  const k = themeKey.toLowerCase()
  if (k === 'claude') return PALETTE.accent
  if (k === 'permission' || k.startsWith('blue')) return PALETTE.categories[0]
  if (k.startsWith('cyan')) return PALETTE.categories[2]
  if (k === 'warning' || k.startsWith('yellow')) return PALETTE.warning
  if (k.startsWith('purple') || k.startsWith('violet')) return PALETTE.categories[4]
  if (k === 'success' || k.startsWith('green')) return PALETTE.good
  if (k === 'error' || k.startsWith('red')) return PALETTE.danger
  return index >= 0 && index < PALETTE.categories.length ? (PALETTE.categories[index] ?? PALETTE.neutral) : PALETTE.neutral
}

/** The most parts a many-part builder draws: lanes, the band's segments, sparkline points, grid cells. */
export const SVG_CAPS = { lanes: 120, segments: 120, sparkPoints: 120, gridCells: 200 } as const

/** At most this many markups are remembered. */
export const SVG_MEMO_MAX = 64

const memo = new Map<string, SvgSpec>()

/** The spec built for `key` before (moved to the newest), or built now and kept; the oldest goes past SVG_MEMO_MAX. */
function memoSvg(key: string, build: () => SvgSpec): SvgSpec {
  const hit = memo.get(key)
  if (hit !== undefined) {
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }
  const spec = build()
  memo.set(key, spec)
  while (memo.size > SVG_MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
  return spec
}

/** How many markups are remembered (tests). */
export const svgMemoSize = (): number => memo.size

/** Forgets every remembered markup (tests). */
export function clearSvgMemo(): void {
  memo.clear()
}

const keyOf = (name: string, ...args: unknown[]): string => `${name}|${JSON.stringify(args)}`

const unit = (frac: number | null | undefined): number | null =>
  frac === null || frac === undefined || !Number.isFinite(frac) ? null : Math.min(1, Math.max(0, frac))

/** A number for an attribute: at most two decimals, no trailing zeros. */
const n = (v: number): string => {
  const r = Math.round(v * 100) / 100
  return Number.isFinite(r) ? String(r) : '0'
}

const open = (w: number, h: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}">`
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="${n(rx)}" fill="${fill}"/>`

const pct = (frac: number | null): string => (frac === null ? 'unknown' : `${Math.round(frac * 100)}%`)

/**
 * A thin rounded bar: the fill in `color` on a translucent track, exactly
 * `width` by `height`. A positive fill is never thinner than the bar's own
 * height, so 1% still shows as a dot; null draws the track alone.
 */
export function barSvg(frac: number | null | undefined, opts: { width?: number; height?: number; color?: string } = {}): SvgSpec {
  const width = Math.max(4, opts.width ?? 36)
  const height = Math.max(2, opts.height ?? 6)
  const color = opts.color ?? PALETTE.accent
  const f = unit(frac)
  const r = height / 2
  let body = rect(0, 0, width, height, PALETTE.track, r)
  if (f !== null && f > 0) body += rect(0, 0, Math.max(height, f * width), height, color, r)
  return { source: `${open(width, height)}${body}</svg>`, alt: `${pct(f)} bar`, width, height }
}

/**
 * A sparkline of the last values that fit: the history as a thin neutral
 * line, the last value as a dot in `color`. Scaled from 0 to the max (a flat
 * series lies on the floor). One value draws the dot alone.
 */
export function sparkSvg(values: readonly number[], opts: { width?: number; height?: number; color?: string; max?: number } = {}): SvgSpec {
  const width = Math.max(8, opts.width ?? 72)
  const step = 4
  const keep = Math.min(SVG_CAPS.sparkPoints, Math.max(1, Math.floor((width - 4) / step) + 1))
  // only the values drawn are part of the key, so a long history keys by its tail
  const tail0 = values.slice(-keep)
  return memoSvg(keyOf('spark', tail0, opts), () => sparkOf(tail0, opts, width))
}

function sparkOf(values: readonly number[], opts: { height?: number; color?: string; max?: number }, width: number): SvgSpec {
  const height = Math.max(6, opts.height ?? 20)
  const color = opts.color ?? PALETTE.accent
  const tail = values.map(v => (Number.isFinite(v) ? Math.max(0, v) : 0))
  const max = Math.max(opts.max ?? 0, ...tail, 0)
  const pad = 2
  const x = (i: number): number => (tail.length <= 1 ? width - pad : pad + (i * (width - 2 * pad)) / (tail.length - 1))
  const y = (v: number): number => (max <= 0 ? height - pad : height - pad - (v / max) * (height - 2 * pad))
  let body = ''
  if (tail.length >= 2) {
    const points = tail.map((v, i) => `${n(x(i))},${n(y(v))}`).join(' ')
    body += `<polyline points="${points}" fill="none" stroke="${PALETTE.neutral}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
  }
  const last = tail[tail.length - 1]
  if (last !== undefined) body += `<circle cx="${n(x(tail.length - 1))}" cy="${n(y(last))}" r="2.2" fill="${color}"/>`
  const alt = tail.length === 0 ? 'no values' : `${tail.length} values, last ${n(last ?? 0)}, max ${n(max)}`
  return { source: `${open(width, height)}${body}</svg>`, alt, width, height }
}

/**
 * A stacked bar of `parts` (by share), each segment in its colour with a 2px
 * surface gap between neighbours, rounded at the ends. Zero parts take no
 * room; all zero draws the track alone.
 */
export function stackSvg(parts: readonly number[], opts: { width?: number; height?: number; colors?: readonly string[]; labels?: readonly string[] } = {}): SvgSpec {
  return memoSvg(keyOf('stack', parts, opts), () => stackOf(parts, opts))
}

function stackOf(parts: readonly number[], opts: { width?: number; height?: number; colors?: readonly string[]; labels?: readonly string[] }): SvgSpec {
  const width = Math.max(8, opts.width ?? 120)
  const height = Math.max(2, opts.height ?? 8)
  const colors = opts.colors ?? PALETTE.mix
  const clean = parts.map(p => (Number.isFinite(p) && p > 0 ? p : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  const r = height / 2
  if (total <= 0) return { source: `${open(width, height)}${rect(0, 0, width, height, PALETTE.track, r)}</svg>`, alt: 'empty', width, height }
  const shown = clean.filter(p => p > 0).length
  const gap = 2
  const usable = width - gap * Math.max(0, shown - 1)
  // a segment is never thinner than the bar's height (a dot); the others give up the difference
  const minW = Math.min(height, usable / Math.max(1, shown))
  const raw = clean.map(p => (p > 0 ? (p / total) * usable : 0))
  const small = raw.reduce((n, w) => n + (w > 0 && w < minW ? minW : 0), 0)
  const bigSum = raw.reduce((n, w) => n + (w >= minW ? w : 0), 0)
  const scale = bigSum > 0 ? Math.max(0, usable - small) / bigSum : 1
  let x = 0
  let body = ''
  const alts: string[] = []
  clean.forEach((p, i) => {
    if (p <= 0) return
    const w0 = raw[i] ?? 0
    const w = w0 < minW ? minW : w0 * scale
    body += rect(x, 0, w, height, colors[i % colors.length] ?? PALETTE.neutral, r)
    alts.push(`${opts.labels?.[i] ?? `part ${i + 1}`} ${Math.round((p / total) * 100)}%`)
    x += w + gap
  })
  return { source: `${open(width, height)}<g>${body}</g></svg>`, alt: alts.join(', '), width, height }
}

export type SegmentPart = { px: number; color: string; kind: 'segment' | 'free' | 'buffer'; label?: string }

/**
 * The band's context bar: the used segments as filled blocks in their colours
 * with a 1px surface gap between neighbours, the free space as a thin
 * translucent track (half the bar's height, centred), the auto-compact buffer
 * as a hatched block (diagonal neutral strokes over a faint fill) at the right
 * end. `parts` carry their pixel widths (segmentPx), which add up to `width`.
 */
export function segmentsSvg(parts0: readonly SegmentPart[], opts: { width?: number; height?: number } = {}): SvgSpec {
  const parts = parts0.length > SVG_CAPS.segments ? parts0.slice(0, SVG_CAPS.segments) : parts0
  return memoSvg(keyOf('segments', parts, opts), () => segmentsOf(parts, opts))
}

function segmentsOf(parts: readonly SegmentPart[], opts: { width?: number; height?: number }): SvgSpec {
  const width = Math.max(8, opts.width ?? 240)
  const height = Math.max(4, opts.height ?? 8)
  const r = Math.min(2, height / 2)
  const id = `h${width}x${height}`
  let body = `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="4" height="4"><path d="M-1 1 l2 -2 M0 4 l4 -4 M3 5 l2 -2" stroke="${PALETTE.neutral}" stroke-width="1" stroke-opacity="0.7"/></pattern></defs>`
  let x = 0
  const alts: string[] = []
  let shown = 0
  for (const p of parts) {
    if (p.px <= 0) continue
    const w = Math.max(0, Math.min(width - x, p.px))
    if (p.kind === 'free') body += rect(x, (height - height / 2) / 2, w, height / 2, PALETTE.track, r)
    else if (p.kind === 'buffer') {
      body += rect(x, 0, w, height, PALETTE.faint, r)
      body += rect(x, 0, w, height, `url(#${id})`, r)
    } else body += rect(x, 0, w, height, p.color, r)
    if (p.label) alts.push(`${p.label} ${n(w)}px`)
    x += w + 1
    shown += 1
  }
  if (shown === 0) body += rect(0, (height - height / 2) / 2, width, height / 2, PALETTE.track, r)
  return { source: `${open(width, height)}${body}</svg>`, alt: shown === 0 ? 'context bar: nothing measured' : `context bar: ${alts.join(', ')}`, width, height }
}

export type GridCell = { color: string; kind: 'used' | 'free' | 'buffer' | 'deferred'; fullness: number }

/**
 * The /context grid: `side` × `side` squares of `cell` px with a `gap`, row by
 * row. A used square is its category's colour (a partial last square faded by
 * its fullness), a buffer square hatched neutral, a free square the track.
 */
export function gridSvg(cells: readonly GridCell[], opts: { side?: number; cell?: number; gap?: number } = {}): SvgSpec {
  // never more than SVG_CAPS.gridCells squares: the side is clamped (14 × 14 = 196)
  const side = Math.min(Math.floor(Math.sqrt(SVG_CAPS.gridCells)), Math.max(1, opts.side ?? 10))
  const drawn = cells.slice(0, side * side)
  return memoSvg(keyOf('grid', drawn, { ...opts, side }), () => gridOf(drawn, side, opts))
}

function gridOf(cells: readonly GridCell[], side: number, opts: { cell?: number; gap?: number }): SvgSpec {
  const cell = Math.max(2, opts.cell ?? 8)
  const gap = Math.max(0, opts.gap ?? 2)
  const size = side * cell + (side - 1) * gap
  let body = ''
  let used = 0
  for (let i = 0; i < side * side; i += 1) {
    const c = cells[i]
    const x = (i % side) * (cell + gap)
    const y = Math.floor(i / side) * (cell + gap)
    if (!c || c.kind === 'free') {
      body += rect(x, y, cell, cell, PALETTE.track, 1.5)
      continue
    }
    if (c.kind === 'buffer') {
      body += rect(x, y, cell, cell, PALETTE.faint, 1.5)
      body += `<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(cell - 1)}" height="${n(cell - 1)}" rx="1.5" fill="none" stroke="${PALETTE.neutral}" stroke-width="1" stroke-dasharray="2 1.5"/>`
      continue
    }
    used += 1
    const f = unit(c.fullness) ?? 1
    const opacity = f >= 1 ? 1 : 0.45 + 0.55 * f
    body += `<rect x="${n(x)}" y="${n(y)}" width="${n(cell)}" height="${n(cell)}" rx="1.5" fill="${c.color}" fill-opacity="${n(opacity)}"/>`
  }
  return { source: `${open(size, size)}${body}</svg>`, alt: `context grid: ${used} of ${side * side} squares used`, width: size, height: size }
}

/** A ring gauge of `frac`, the arc in `color` on a translucent track. */
export function gaugeSvg(frac: number | null | undefined, opts: { size?: number; color?: string; stroke?: number } = {}): SvgSpec {
  const size = Math.max(8, opts.size ?? 18)
  const stroke = Math.max(1, opts.stroke ?? 3)
  const color = opts.color ?? PALETTE.accent
  const f = unit(frac)
  const c = size / 2
  const r = c - stroke / 2
  const circ = 2 * Math.PI * r
  let body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="none" stroke="${PALETTE.track}" stroke-width="${n(stroke)}"/>`
  if (f !== null && f > 0) {
    body += `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${n(stroke)}" stroke-linecap="round" stroke-dasharray="${n(circ * f)} ${n(circ)}" transform="rotate(-90 ${n(c)} ${n(c)})"/>`
  }
  return { source: `${open(size, size)}${body}</svg>`, alt: `${pct(f)} full`, width: size, height: size }
}

/** A legend swatch: one rounded square of `color`. */
export function swatchSvg(color: string, opts: { size?: number; alt?: string } = {}): SvgSpec {
  const size = Math.max(4, opts.size ?? 8)
  return { source: `${open(size, size)}${rect(0, 0, size, size, color, 2)}</svg>`, alt: opts.alt ?? 'swatch', width: size, height: size }
}

export type DotStatus = 'running' | 'stale' | 'done' | 'error' | 'stopped' | 'idle'

/**
 * A status dot: running filled accent with a thin ring (the pulse), stale a
 * hollow dashed ring in the warning tone (a running loop gone quiet), done
 * good, error danger, stopped warning, idle a hollow neutral ring.
 */
export function dotSvg(status: DotStatus, opts: { size?: number } = {}): SvgSpec {
  const size = Math.max(6, opts.size ?? 10)
  const c = size / 2
  let body: string
  switch (status) {
    case 'running':
      body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(c - 0.75)}" fill="none" stroke="${PALETTE.accent}" stroke-width="1" stroke-opacity="0.55"/><circle cx="${n(c)}" cy="${n(c)}" r="${n(c * 0.55)}" fill="${PALETTE.accent}"/>`
      break
    case 'done':
      body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(c * 0.6)}" fill="${PALETTE.good}"/>`
      break
    case 'error':
      body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(c * 0.6)}" fill="${PALETTE.danger}"/>`
      break
    case 'stopped':
      body = `<rect x="${n(c * 0.45)}" y="${n(c * 0.45)}" width="${n(c * 1.1)}" height="${n(c * 1.1)}" rx="1" fill="${PALETTE.warning}"/>`
      break
    case 'stale':
      body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(c - 0.75)}" fill="none" stroke="${PALETTE.warning}" stroke-width="1.25" stroke-dasharray="2 1.5"/>`
      break
    default:
      body = `<circle cx="${n(c)}" cy="${n(c)}" r="${n(c * 0.55)}" fill="none" stroke="${PALETTE.neutral}" stroke-width="1.25"/>`
  }
  return { source: `${open(size, size)}${body}</svg>`, alt: status, width: size, height: size }
}

export type Lane = { start: number; end: number | null; status: DotStatus }

/**
 * Swim lanes: one thin lane per agent over the window `from`..`to`, lit from
 * its start to its end (or `to` while it runs) in its status colour on a
 * faint track, the running ones in the accent. Lanes before `from` are
 * clipped to the window's edge.
 */
export function lanesSvg(lanes0: readonly Lane[], opts: { width?: number; from: number; to: number; laneHeight?: number; gap?: number }): SvgSpec {
  // the first SVG_CAPS.lanes lanes as the caller ordered them (running first, then the newest); the rest are counted in the alt
  const lanes = lanes0.length > SVG_CAPS.lanes ? lanes0.slice(0, SVG_CAPS.lanes) : lanes0
  const more = lanes0.length - lanes.length
  return memoSvg(keyOf('lanes', lanes, opts, more), () => lanesOf(lanes, opts, more))
}

function lanesOf(lanes: readonly Lane[], opts: { width?: number; from: number; to: number; laneHeight?: number; gap?: number }, more: number): SvgSpec {
  const width = Math.max(16, opts.width ?? 200)
  const lh = Math.max(2, opts.laneHeight ?? 4)
  const gap = Math.max(0, opts.gap ?? 2)
  const span = Math.max(1, opts.to - opts.from)
  const height = Math.max(lh, lanes.length * lh + Math.max(0, lanes.length - 1) * gap)
  const x = (t: number): number => Math.min(width, Math.max(0, ((t - opts.from) / span) * width))
  let body = ''
  let lit = 0
  lanes.forEach((lane, i) => {
    const y = i * (lh + gap)
    body += rect(0, y, width, lh, PALETTE.faint, lh / 2)
    const x0 = x(lane.start)
    const x1 = x(lane.end ?? opts.to)
    if (x1 <= x0 && lane.end !== null) {
      // too short to see: a dot at its moment
      body += rect(Math.max(0, x0 - lh / 2), y, lh, lh, laneColor(lane.status), lh / 2)
      return
    }
    lit += 1
    body += rect(x0, y, Math.max(lh, x1 - x0), lh, laneColor(lane.status), lh / 2)
  })
  return { source: `${open(width, height)}${body}</svg>`, alt: `${lanes.length} agent lanes, ${lanes.filter(l => l.status === 'running').length} running${more > 0 ? `, ${more} more not drawn` : ''}`, width, height }
}

function laneColor(status: DotStatus): string {
  switch (status) {
    case 'running':
      return PALETTE.accent
    case 'error':
      return PALETTE.danger
    case 'stopped':
    case 'stale':
      return PALETTE.warning
    case 'done':
      return PALETTE.neutral
    default:
      return PALETTE.track
  }
}

/**
 * A tree guide for a nested row: a vertical hairline down the left and an
 * elbow to the right at mid height, `width` by `height`, so a child's row
 * reads as hanging from its parent without box-drawing glyphs.
 */
export function guideSvg(opts: { width?: number; height?: number; isLast?: boolean } = {}): SvgSpec {
  const width = Math.max(6, opts.width ?? 12)
  const height = Math.max(6, opts.height ?? 16)
  const x = 3
  const mid = height / 2
  const down = opts.isLast ? mid : height
  const body = `<path d="M${n(x)} 0 V${n(down)} M${n(x)} ${n(mid)} H${n(width - 1)}" fill="none" stroke="${PALETTE.neutral}" stroke-opacity="0.6" stroke-width="1"/>`
  return { source: `${open(width, height)}${body}</svg>`, alt: 'nested', width, height }
}
