// A text renderer for the terminal trees the pane answers: the subset of the
// surface's flex layout the mod uses (a column of rows; row Boxes with fixed
// widths in cells or percent, one growing cell, numeric gaps, flex-end
// alignment, round borders, truncating Texts, plain Buttons drawn `k: label`),
// laid out as Yoga would within what the mod relies on. It is this test
// suite's approximation of the terminal, so the frames can be looked at and
// their widths checked; the real terminal may differ in what the mod does not
// constrain (a Text outside a cell, a step-named gap).
//
// Exports: renderText(tree, cols): string[]  (each row exactly `cols` cells, space-padded)

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const cpLen = (s: string): number => Array.from(s).length

function cut(s: string, width: number): string {
  if (width <= 0) return ''
  const cps = Array.from(s)
  if (cps.length <= width) return s
  if (width === 1) return '…'
  return `${cps.slice(0, width - 1).join('')}…`
}

const pad = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - cpLen(s)))

/** The plain text of a Text or Button (its hotkey prefix included) and its children. */
function textOf(el: unknown): string {
  if (typeof el === 'string') return el
  if (typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(textOf).join('')
  if (!el || typeof el !== 'object') return ''
  const n = el as Node
  if (n.type === 'Input') {
    const label = typeof n.props?.label === 'string' ? `${n.props.label} ` : ''
    const value = typeof n.props?.value === 'string' && n.props.value !== '' ? n.props.value : typeof n.props?.placeholder === 'string' ? n.props.placeholder : ''
    return `${label}[${value}]`
  }
  const hk = n.type === 'Button' && typeof n.props?.hotkey === 'string' ? `${n.props.hotkey}: ` : ''
  return hk + (n.children ?? []).map(textOf).join('')
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function widthOf(v: unknown, parent: number): number | null {
  if (typeof v === 'number') return Math.max(0, Math.floor(v))
  if (typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v)) return Math.max(0, Math.floor((parseFloat(v) / 100) * parent))
  return null
}

const kids = (n: Node): unknown[] => (n.children ?? []).flat(8).filter(c => c !== null && c !== undefined && c !== false)

/** The width a node asks for when nothing constrains it. */
function intrinsic(el: unknown, parent: number): number {
  if (typeof el === 'string' || typeof el === 'number') return cpLen(String(el))
  if (Array.isArray(el)) return el.reduce<number>((n, c) => n + intrinsic(c, parent), 0)
  if (!el || typeof el !== 'object') return 0
  const n = el as Node
  if (n.type === 'Text' || n.type === 'Button' || n.type === 'Input') return cpLen(textOf(n))
  if (n.type !== 'Box') return kids(n).reduce<number>((s, c) => s + intrinsic(c, parent), 0)
  const fixed = widthOf(n.props?.width, parent)
  if (fixed !== null) return fixed
  const border = n.props?.borderStyle ? 2 : 0
  const px = (num(n.props?.paddingX) ?? 0) * 2 + (num(n.props?.paddingLeft) ?? 0) + (num(n.props?.paddingRight) ?? 0)
  const inner = parent - border - px
  const children = kids(n)
  if (n.props?.flexDirection === 'row') {
    const gap = num(n.props?.gap) ?? (typeof n.props?.gap === 'string' ? 1 : 0)
    return children.reduce<number>((s, c) => s + intrinsic(c, inner), 0) + Math.max(0, children.length - 1) * gap + border + px
  }
  return Math.max(0, ...children.map(c => intrinsic(c, inner))) + border + px
}

/** Renders a node into rows of exactly `width` cells. */
function render(el: unknown, width: number): string[] {
  if (width <= 0) return []
  if (typeof el === 'string' || typeof el === 'number') return [pad(cut(String(el), width), width)]
  if (Array.isArray(el)) return el.flatMap(c => render(c, width))
  if (!el || typeof el !== 'object') return []
  const n = el as Node
  if (n.type === 'Text' || n.type === 'Button' || n.type === 'Input') return [pad(cut(textOf(n), width), width)]
  if (n.type !== 'Box') return kids(n).flatMap(c => render(c, width))
  const border = n.props?.borderStyle ? 1 : 0
  const pl = (num(n.props?.paddingX) ?? 0) + (num(n.props?.paddingLeft) ?? 0)
  const pr = (num(n.props?.paddingX) ?? 0) + (num(n.props?.paddingRight) ?? 0)
  const inner = width - 2 * border - pl - pr
  let rows: string[]
  if (n.props?.flexDirection === 'row') rows = renderRow(n, inner)
  else rows = kids(n).flatMap(c => render(c, inner))
  const height = num(n.props?.height)
  if (height !== null) {
    const h = Math.max(0, height - 2 * border)
    rows = rows.slice(0, h)
    while (rows.length < h) rows.push(' '.repeat(inner))
  }
  rows = rows.map(r => `${' '.repeat(pl)}${pad(cut(r, inner), inner)}${' '.repeat(pr)}`)
  if (border) {
    const w = width - 2
    return [`╭${'─'.repeat(w)}╮`, ...rows.map(r => `│${r}│`), `╰${'─'.repeat(w)}╯`]
  }
  return rows
}

/** A row Box: fixed cells, growing cells, gaps, justification; the cells side by side, as tall as the tallest. */
function renderRow(n: Node, width: number): string[] {
  const children = kids(n)
  if (children.length === 0) return [' '.repeat(width)]
  const gap = num(n.props?.gap) ?? (typeof n.props?.gap === 'string' ? 1 : 0)
  const gaps = Math.max(0, children.length - 1) * gap
  const widths = children.map(c => intrinsic(c, width))
  const grows = children.map(c => (c && typeof c === 'object' && !Array.isArray(c) ? num((c as Node).props?.flexGrow) ?? 0 : 0))
  const shrinks = children.map(c => (c && typeof c === 'object' && !Array.isArray(c) && (c as Node).type === 'Box' ? num((c as Node).props?.flexShrink) ?? 1 : 0))
  let total = widths.reduce((a, b) => a + b, 0) + gaps
  if (total < width) {
    const g = grows.reduce((a, b) => a + b, 0)
    if (g > 0) {
      let extra = width - total
      grows.forEach((w, i) => {
        if (w <= 0) return
        const add = Math.floor((extra * w) / g)
        widths[i] = (widths[i] ?? 0) + add
      })
      extra = width - (widths.reduce((a, b) => a + b, 0) + gaps)
      const last = grows.lastIndexOf(Math.max(...grows))
      if (extra > 0 && last >= 0) widths[last] = (widths[last] ?? 0) + extra
    }
  } else if (total > width) {
    // over: the shrinkable cells give way, the widest first
    let over = total - width
    const order = shrinks.map((s, i) => ({ s, i, w: widths[i] ?? 0 })).filter(x => x.s > 0).sort((a, z) => z.w - a.w)
    for (const x of order) {
      if (over <= 0) break
      const take = Math.min(over, x.w)
      widths[x.i] = x.w - take
      over -= take
    }
    // still over: the last cells are clipped by overflow hidden
  }
  total = widths.reduce((a, b) => a + b, 0) + gaps
  const justify = n.props?.justifyContent
  let lead = 0
  let between = gap
  if (total < width) {
    if (justify === 'flex-end') lead = width - total
    else if (justify === 'center') lead = Math.floor((width - total) / 2)
    else if (justify === 'space-between' && children.length > 1) between = gap + Math.floor((width - total) / (children.length - 1))
  }
  // the cells side by side, as many rows as the tallest cell (a row Box of height 1 is cut to one by its height)
  const cells = children.map((c, i) => render(c, widths[i] ?? 0))
  const height = Math.max(1, ...cells.map(r => r.length))
  const out: string[] = []
  for (let r = 0; r < height; r += 1) {
    let line = ' '.repeat(lead)
    children.forEach((_, i) => {
      const w = widths[i] ?? 0
      line += pad(cut(cells[i]?.[r] ?? '', w), w)
      if (i < children.length - 1) line += ' '.repeat(between)
    })
    out.push(pad(cut(line, width), width))
  }
  return out
}

/** The tree as rows of text, each exactly `cols` cells (space-padded). */
export function renderText(tree: unknown, cols: number): string[] {
  return render(tree, cols)
}

/** The rows with their trailing spaces trimmed (for reading and printing). */
export const trimmed = (rows: string[]): string[] => rows.map(r => r.replace(/\s+$/, ''))

/** The room a growing cell must keep: a name of four cells at the least. */
const GROW_MIN = 4

/**
 * How far any row `Box` of the tree overflows `cols`: its fixed cell widths,
 * its Texts and Buttons, its gaps, and GROW_MIN for a growing cell, less the
 * width; the largest such excess (at most 0 when nothing overflows).
 * `renderText` pads and cuts every row to the width by construction, so
 * this is the overflow check a frame test needs.
 */
export function fixedOverflow(tree: unknown, cols: number): number {
  let worst = -Infinity
  const walk = (el: unknown, width: number): void => {
    if (Array.isArray(el)) {
      for (const x of el) walk(x, width)
      return
    }
    if (!el || typeof el !== 'object') return
    const n = el as Node
    if (n.type !== 'Box') return
    const border = n.props?.borderStyle ? 2 : 0
    const px = (num(n.props?.paddingX) ?? 0) * 2 + (num(n.props?.paddingLeft) ?? 0) + (num(n.props?.paddingRight) ?? 0)
    const own = widthOf(n.props?.width, width) ?? width
    const inner = own - border - px
    const children = kids(n)
    if (n.props?.flexDirection === 'row') {
      const gap = num(n.props?.gap) ?? (typeof n.props?.gap === 'string' ? 1 : 0)
      let sum = Math.max(0, children.length - 1) * gap
      for (const c of children) {
        const child = c as Node
        if (child?.type === 'Box') sum += widthOf(child.props?.width, inner) ?? ((num(child.props?.flexGrow) ?? 0) > 0 ? GROW_MIN : 0)
        else if (child?.type === 'Text' || child?.type === 'Button' || child?.type === 'Input') sum += cpLen(textOf(child))
      }
      worst = Math.max(worst, sum - inner)
      for (const c of children) {
        const child = c as Node
        if (child?.type === 'Box') walk(child, widthOf(child.props?.width, inner) ?? inner)
      }
      return
    }
    for (const c of children) walk(c, inner)
  }
  walk(tree, cols)
  return worst === -Infinity ? 0 : worst
}
