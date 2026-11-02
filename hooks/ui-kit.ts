// session-telemetry: the pane's text kit. Pure (no `$`, no clock, no elements):
// widths, padding, block bars, sparklines, column fitting, windows over lists,
// and the line model the tab builders emit. Unit-tested in tests/ui-kit.test.ts.
//
// Widths are counted in code points: every glyph this kit draws (box drawing,
// blocks, arrows) is one cell. A label with wide (CJK) characters may draw a
// cell or two wider than counted; labels are truncated, so the cost is a ragged
// right edge on that row, never an extra row.
//
// Exports:
//   Seg, Btn, Item, Line, Tone, ACCENT                   the line model
//   seg, dim, btn, isBtn, itemWidth, lineWidth, fitLine, padLine, joinH, lineText, lr
//   cpLen, truncate, truncateMid, padLeft, padRight, align
//   bar, barParts, thinBar, thinBarParts, spark, sparkSegs, stack, BAR_EIGHTHS, SPARK_GLYPHS
//   Column, fitColumns, cells
//   clampOffset, windowAround, Group, fitGroups
//   fillTone, rateTone, driftTone, fmtAgo, fmtCount, fmtResetIn, shortLabel, isShellTool, fitSegs

// ---------------------------------------------------------------- line model

/** The one accent colour (a theme key, so it follows the person's theme). */
export const ACCENT = 'claude'

/** State colours: green / amber / red, theme keys. */
export type Tone = 'success' | 'warning' | 'error'

/** A run of text in one style. `c` is a theme key or a raw colour. */
export type Seg = { t: string; c?: string; dim?: boolean; bold?: boolean; inv?: boolean }

/**
 * A pressable run. `key` is its address (unique per tree), `act` the action the
 * pane maps to a closure, `hk` a hotkey (one digit or lowercase letter). Drawn
 * plain: `hk: label` on the terminal, the label alone without a hotkey; a
 * desktop draws a native button and no prefix. `hkw` is the width of the
 * prefix the surface draws (default `hk: `, 3 cells for one key; 0 on a
 * desktop, where the builder puts its own dim hint in `segs`).
 */
export type Btn = { btn: string; act: string; hk?: string; hkw?: number; segs: Seg[] }

export type Item = Seg | Btn

/** One drawn row. */
export type Line = Item[]

export const seg = (t: string, style: Omit<Seg, 't'> = {}): Seg => ({ t, ...style })
export const dim = (t: string): Seg => ({ t, dim: true })
export const btn = (key: string, act: string, segs: Seg[], hk?: string, hkw?: number): Btn => {
  if (hk === undefined) return { btn: key, act, segs }
  return hkw === undefined ? { btn: key, act, hk, segs } : { btn: key, act, hk, hkw, segs }
}
export const isBtn = (item: Item): item is Btn => 'btn' in item

/** The cells a Button's surface-drawn hotkey prefix takes (`k: `), or none. */
export const hotkeyWidth = (item: Btn): number => (item.hk === undefined ? 0 : item.hkw ?? cpLen(item.hk) + 2)

/** Cells an item takes: a plain Button with a hotkey draws `k: ` before its label. */
export function itemWidth(item: Item): number {
  if (!isBtn(item)) return cpLen(item.t)
  const label = item.segs.reduce((n, s) => n + cpLen(s.t), 0)
  return label + hotkeyWidth(item)
}

export const lineWidth = (line: Line): number => line.reduce((n, item) => n + itemWidth(item), 0)

/** The line's text as plain characters (a Button's hotkey prefix included where the surface draws one). */
export function lineText(line: Line): string {
  return line.map(item => (isBtn(item) ? `${hotkeyWidth(item) > 0 ? `${item.hk}: ` : ''}${item.segs.map(s => s.t).join('')}` : item.t)).join('')
}

/**
 * `left` at the left edge and `right` at the right edge of `width` cells, a
 * space at least between them; the left runs are cut first (an ellipsis), the
 * right ones kept whole while they fit alone.
 */
export function lr(left: readonly Seg[], right: readonly Seg[], width: number): Seg[] {
  const rw = right.reduce((n, s) => n + cpLen(s.t), 0)
  if (rw >= width) return fitSegs(right, width)
  const room = width - rw - 1
  const l = fitSegs(left, room)
  const lw = l.reduce((n, s) => n + cpLen(s.t), 0)
  return [...l, seg(' '.repeat(width - lw - rw)), ...right]
}

/** Runs cut to `width` cells, the last kept one ending in an ellipsis. */
export function fitSegs(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const w = cpLen(s.t)
    if (used + w <= width) {
      out.push(s)
      used += w
      continue
    }
    if (width - used > 0) out.push({ ...s, t: truncate(s.t, width - used) })
    break
  }
  return out
}

/**
 * The line cut to `width` cells: text runs are truncated (the last kept one
 * ends in an ellipsis). A hotkey Button that does not fit whole is dropped,
 * since a half-drawn control reads as something else; a row Button (no
 * hotkey) has its label cut and stays pressable.
 */
export function fitLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const item of line) {
    const w = itemWidth(item)
    if (used + w <= width) {
      out.push(item)
      used += w
      continue
    }
    const room = width - used
    if (room > 0) {
      if (!isBtn(item)) out.push({ ...item, t: truncate(item.t, room) })
      else if (item.hk === undefined) out.push({ ...item, segs: fitSegs(item.segs, room) })
    }
    break
  }
  return out
}

/** The line padded with spaces (or cut) to exactly `width` cells. */
export function padLine(line: Line, width: number): Line {
  const fitted = fitLine(line, width)
  const w = lineWidth(fitted)
  return w < width ? [...fitted, seg(' '.repeat(width - w))] : fitted
}

/** Two blocks side by side: each left line padded to `leftWidth`, then `gap`, then the right line. */
export function joinH(left: Line[], leftWidth: number, right: Line[], gap = 2): Line[] {
  const rows = Math.max(left.length, right.length)
  const out: Line[] = []
  for (let i = 0; i < rows; i += 1) {
    const r = right[i] ?? []
    out.push([...padLine(left[i] ?? [], leftWidth), ...(r.length > 0 ? [seg(' '.repeat(gap)), ...r] : [])])
  }
  return out
}

// ---------------------------------------------------------------- text

export const cpLen = (s: string): number => {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/** At most `width` cells; a cut text ends in `…`. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return ''
  const cps = Array.from(s)
  if (cps.length <= width) return s
  if (width === 1) return '…'
  return `${cps.slice(0, width - 1).join('')}…`
}

/** At most `width` cells, cut in the middle (`src/…/file.ts`): for paths and ids, whose ends both matter. */
export function truncateMid(s: string, width: number): string {
  if (width <= 0) return ''
  const cps = Array.from(s)
  if (cps.length <= width) return s
  if (width <= 2) return truncate(s, width)
  const keep = width - 1
  const head = Math.ceil(keep / 2)
  return `${cps.slice(0, head).join('')}…${cps.slice(cps.length - (keep - head)).join('')}`
}

export const padRight = (s: string, width: number): string => {
  const t = truncate(s, width)
  return t + ' '.repeat(Math.max(0, width - cpLen(t)))
}

export const padLeft = (s: string, width: number): string => {
  const t = truncate(s, width)
  return ' '.repeat(Math.max(0, width - cpLen(t))) + t
}

export const align = (s: string, width: number, side: 'l' | 'r'): string => (side === 'r' ? padLeft(s, width) : padRight(s, width))

// ---------------------------------------------------------------- bars

/** Eighth blocks, thinnest first: index n draws n/8 of a cell. */
export const BAR_EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
export const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

const unit = (frac: number | null | undefined): number => (frac === null || frac === undefined || !Number.isFinite(frac) ? 0 : Math.min(1, Math.max(0, frac)))

/** The filled part of a bar (`█` and one eighth block) and the cells left over. */
export function barParts(frac: number | null | undefined, width: number): { fill: string; rest: number } {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return { fill: '', rest: 0 }
  const eighths = Math.round(unit(frac) * w * 8)
  const full = Math.floor(eighths / 8)
  const part = BAR_EIGHTHS[eighths % 8] ?? ''
  const fill = '█'.repeat(full) + part
  return { fill, rest: w - cpLen(fill) }
}

/** A bar of exactly `width` cells: the fill, then spaces. */
export function bar(frac: number | null | undefined, width: number): string {
  const { fill, rest } = barParts(frac, width)
  return fill + ' '.repeat(rest)
}

/**
 * A thin bar: heavy rule for the fill (`━`, a half cell `╸` at its end), light
 * rule for the track (`─`), so the full width reads at any fill, in one colour
 * or none: the two differ by weight alone.
 */
export function thinBarParts(frac: number | null | undefined, width: number): { fill: string; rest: number } {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return { fill: '', rest: 0 }
  const u = unit(frac)
  // a sliver: anything over nothing shows as the half cell, so a 1% fill is not mistaken for none
  const halves = Math.max(u > 0 ? 1 : 0, Math.round(u * w * 2))
  const full = Math.floor(halves / 2)
  const fill = '━'.repeat(full) + (halves % 2 === 1 && full < w ? '╸' : '')
  return { fill, rest: w - cpLen(fill) }
}

/** The thin bar as two runs: the fill in `color` (a theme key), the track dim. Exactly `width` cells. */
export function thinBar(frac: number | null | undefined, width: number, color: string = ACCENT): Seg[] {
  const { fill, rest } = thinBarParts(frac, width)
  return [...(fill === '' ? [] : [seg(fill, { c: color })]), ...(rest > 0 ? [dim('─'.repeat(rest))] : [])]
}

/**
 * A sparkline of the last `width` values, scaled from 0 to their max (a series
 * of zeros is a flat floor). Non-finite values draw as the floor.
 */
export function spark(values: readonly number[], width: number): string {
  const w = Math.max(0, Math.floor(width))
  if (w === 0 || values.length === 0) return ''
  const tail = values.slice(-w).map(v => (Number.isFinite(v) ? Math.max(0, v) : 0))
  const max = Math.max(...tail)
  return tail
    .map(v => {
      if (max <= 0) return SPARK_GLYPHS[0]
      const i = Math.min(SPARK_GLYPHS.length - 1, Math.floor((v / max) * SPARK_GLYPHS.length))
      return SPARK_GLYPHS[Math.max(0, i)]
    })
    .join('')
}

/** The sparkline as runs: the history dim, the last value in `color` (a theme key). */
export function sparkSegs(values: readonly number[], width: number, color: string = ACCENT): Seg[] {
  const s = spark(values, width)
  if (s === '') return []
  const cps = Array.from(s)
  const last = cps.pop() ?? ''
  return [...(cps.length > 0 ? [dim(cps.join(''))] : []), seg(last, { c: color })]
}

/**
 * Cells per part of a stacked bar `width` wide, by largest remainder, so the
 * cells add up to `width` exactly when any part is positive (all zero: none).
 */
export function stack(parts: readonly number[], width: number): number[] {
  const w = Math.max(0, Math.floor(width))
  const clean = parts.map(p => (Number.isFinite(p) && p > 0 ? p : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (total <= 0 || w === 0) return clean.map(() => 0)
  const exact = clean.map(p => (p / total) * w)
  const cells = exact.map(Math.floor)
  let left = w - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, z) => z.r - a.r || a.i - z.i)
  for (const { i } of order) {
    if (left <= 0) break
    if (clean[i] === 0) continue
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }
  return cells
}

// ---------------------------------------------------------------- tables

/**
 * A table column. `w` is its width in cells (`flex`: what is left, at least
 * `min`); `prio` decides which columns go first when the width runs short
 * (lowest first; equal: rightmost first).
 */
export type Column = { id: string; head: string; w: number | 'flex'; min?: number; align?: 'l' | 'r'; prio: number }

/** The columns that fit `width` with `gap` between them, the flex one sized; order kept. */
export function fitColumns(cols: readonly Column[], width: number, gap = 1): (Column & { width: number })[] {
  let kept = [...cols]
  const need = (list: readonly Column[]): number =>
    list.reduce((n, c) => n + (c.w === 'flex' ? (c.min ?? 8) : c.w), 0) + Math.max(0, list.length - 1) * gap
  while (kept.length > 1 && need(kept) > width) {
    let drop = 0
    for (let i = 1; i < kept.length; i += 1) {
      const a = kept[i]
      const b = kept[drop]
      if (a && b && a.prio <= b.prio) drop = i
    }
    kept = kept.filter((_, i) => i !== drop)
  }
  const fixed = kept.reduce((n, c) => n + (c.w === 'flex' ? 0 : c.w), 0) + Math.max(0, kept.length - 1) * gap
  const flexCount = kept.filter(c => c.w === 'flex').length
  const flexWidth = flexCount > 0 ? Math.max(0, Math.floor((width - fixed) / flexCount)) : 0
  return kept.map(c => ({ ...c, width: c.w === 'flex' ? Math.max(c.min ?? 0, flexWidth) : c.w }))
}

/**
 * One table row as segments: each kept column's cell padded to its width and
 * aligned, cells joined by `gap` spaces. `row` maps a column id to its cell (one
 * run, or several drawn left-aligned, such as a bar's fill and track); a
 * missing cell draws blank.
 */
export function cells(cols: readonly (Column & { width: number })[], row: Readonly<Record<string, Seg | Seg[] | undefined>>, gap = 1): Seg[] {
  const out: Seg[] = []
  cols.forEach((c, i) => {
    if (i > 0) out.push(seg(' '.repeat(gap)))
    const cell = row[c.id] ?? seg('')
    if (Array.isArray(cell)) {
      out.push(...(padLine(cell, c.width) as Seg[]))
      return
    }
    out.push({ ...cell, t: align(cell.t, c.width, c.align ?? 'l') })
  })
  return out
}

// ---------------------------------------------------------------- windows

/** An offset into `total` rows that shows `room` of them: within 0..total-room. */
export function clampOffset(offset: number, total: number, room: number): number {
  const max = Math.max(0, total - Math.max(0, room))
  return Math.min(max, Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)))
}

/** The offset nearest `offset` that keeps row `index` in a window of `room` rows. */
export function windowAround(index: number, total: number, room: number, offset: number): number {
  if (room <= 0) return 0
  let o = clampOffset(offset, total, room)
  if (index < o) o = index
  else if (index >= o + room) o = index - room + 1
  return clampOffset(o, total, room)
}

/** A run of segments that is shown whole or not at all; lower `prio` goes first. */
export type Group = { segs: Seg[]; prio: number }

/**
 * The groups that fit `width` cells with `sep` between them, in their order;
 * the lowest-priority group (rightmost on a tie) is dropped until they fit.
 * The first group alone is cut to fit rather than dropped.
 */
export function fitGroups(groups: readonly Group[], width: number, sep: Seg = seg('  ')): Line {
  let kept = groups.filter(g => g.segs.length > 0)
  const w = (list: readonly Group[]): number =>
    list.reduce((n, g) => n + g.segs.reduce((m, s) => m + cpLen(s.t), 0), 0) + Math.max(0, list.length - 1) * cpLen(sep.t)
  while (kept.length > 1 && w(kept) > width) {
    let drop = 1
    for (let i = 1; i < kept.length; i += 1) {
      const a = kept[i]
      const b = kept[drop]
      if (a && b && a.prio <= b.prio) drop = i
    }
    kept = kept.filter((_, i) => i !== drop)
  }
  const out: Line = []
  kept.forEach((g, i) => {
    if (i > 0) out.push(sep)
    out.push(...g.segs)
  })
  return fitLine(out, width)
}

// ---------------------------------------------------------------- tones and labels

/** A 0..1 fill: under 70% green, under 90% amber, else red; null with no figure. */
export function fillTone(frac: number | null | undefined): Tone | null {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return null
  return frac >= 0.9 ? 'error' : frac >= 0.7 ? 'warning' : 'success'
}

/** An error rate: none green, from 5% amber, from 20% red. */
export function rateTone(rate: number | null | undefined): Tone | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null
  return rate >= 0.2 ? 'error' : rate >= 0.05 ? 'warning' : 'success'
}

/** The estimate's drift from the ledger: within 5% none, from 5% amber, from 25% red. */
export function driftTone(drift: number | null | undefined): Tone | null {
  if (drift === null || drift === undefined || !Number.isFinite(drift)) return null
  const a = Math.abs(drift)
  return a >= 0.25 ? 'error' : a >= 0.05 ? 'warning' : null
}

/** Age of a moment: "4s", "12m", "3h", "2d"; "now" under a second. */
export function fmtAgo(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 1) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** A count with thousands folded: 950, 1.2k, 46k, 1.2M. */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (a < 1e6) return `${Math.round(n / 1000)}k`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

/** Time until an ISO reset moment, as the duration formatter has it; null when unknown or past. */
export function fmtResetIn(resetsAt: string | null | undefined, now: number, fmt: (ms: number) => string): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at) || at <= now) return null
  return fmt(at - now)
}

/** Shell tools: their label is a command line, which can hold secrets. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Monitor'])

/** A tool whose input label, and error text, may hold a command line. */
export const isShellTool = (tool: string): boolean => SHELL_TOOLS.has(tool)

/**
 * A short, safe hint for a tool call's label: none for shell tools and server
 * tools; a URL as its host and path (query and fragment dropped, they can carry
 * tokens); a path as its last two parts; anything else truncated to `width`.
 */
export function shortLabel(tool: string, label: string | null | undefined, width: number, isServerTool = false): string {
  if (!label || isServerTool || SHELL_TOOLS.has(tool) || width <= 0) return ''
  const text = label.trim()
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)([^?#\s]*)/i.exec(text)
  if (url) {
    const host = (url[1] ?? '').replace(/^[^@]*@/, '')
    return truncate(`${host}${url[2] ?? ''}`, width)
  }
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(text) && !/\s/.test(text)) {
    const parts = text.split(/[\\/]+/).filter(Boolean)
    return truncateMid(parts.slice(-2).join('/'), width)
  }
  return truncate(text.replace(/\s+/g, ' '), width)
}
