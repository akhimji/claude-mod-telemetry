// session-telemetry: the desktop body's window over a tab's items, by their
// estimated heights (kit.tsx `H`). Pure; unit-tested in tests/desktop.test.tsx.
//
// Exports: windowItems, flattenItems

export type Window = {
  /** The first item shown. */
  offset: number
  /** How many items are shown from it. */
  count: number
  /** The furthest the offset can go (the tail fits from there). */
  maxOffset: number
  /** Whether a pager row is needed (the items do not all fit). */
  pager: boolean
}

/** How many items from `from` fit in `room` rows (at least one, when any is there and there is room). */
function fitFrom(heights: readonly number[], from: number, room: number): number {
  let used = 0
  let k = 0
  for (let i = from; i < heights.length; i += 1) {
    const h = Math.max(0.5, heights[i] ?? 1)
    if (used + h > room) break
    used += h
    k += 1
  }
  return k === 0 && from < heights.length && room > 0 ? 1 : k
}

/** The smallest offset from which the tail fits in `room` rows. */
function lastOffset(heights: readonly number[], room: number): number {
  let used = 0
  let o = heights.length
  for (let i = heights.length - 1; i >= 0; i -= 1) {
    const h = Math.max(0.5, heights[i] ?? 1)
    if (used + h > room) break
    used += h
    o = i
  }
  return Math.min(o, Math.max(0, heights.length - 1))
}

/**
 * The window of items to show in `room` rows from `offset`, a pager row
 * (`pagerRows` tall) taken from the room when the items do not all fit, and
 * the window moved so that `select`, when given, is wholly inside it (a
 * selection in the tail shows the tail whole); with `selectTo`, as much of
 * `select`..`selectTo` as fits, from `select` on.
 */
export function windowItems(heights: readonly number[], room: number, offset: number, select?: number, pagerRows = 1.5, selectTo?: number): Window {
  const total = heights.reduce((n, h) => n + Math.max(0.5, h), 0)
  let r = Math.max(0, room)
  let pager = false
  if (total > r && r > 0) {
    pager = true
    r = Math.max(0.5, r - pagerRows)
  }
  const maxOffset = r > 0 ? lastOffset(heights, r) : 0
  let o = Math.min(maxOffset, Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)))
  if (select !== undefined && heights.length > 0) {
    const sel = Math.min(heights.length - 1, Math.max(0, select))
    // `selectTo`: the selection runs to there (an open drawer under the focused row); its end is brought in, then its start wins
    const end = selectTo === undefined ? sel : Math.min(heights.length - 1, Math.max(sel, selectTo))
    if (sel < o) o = sel
    else while (o < end && o + fitFrom(heights, o, r) <= end) o += 1
    if (o > sel) o = sel
    o = end >= maxOffset && sel >= maxOffset ? maxOffset : Math.min(o, maxOffset)
  }
  const count = r > 0 ? fitFrom(heights, o, r) : 0
  return { offset: o, count, maxOffset, pager }
}

/**
 * The items as the frame windows them: an item taller than `room` with `parts`
 * is replaced by its parts (so a drawer taller than the body scrolls with the
 * list, a line at a time), and the selected item's index is carried over.
 * `ids` (one per item) follow, a part taking null.
 */
export function flattenItems<I extends { rows: number; parts?: I[] }>(
  items: readonly I[],
  room: number,
  select: number | undefined,
  ids?: readonly (string | null)[],
  selectTo?: number,
): { items: I[]; select: number | undefined; selectTo: number | undefined; ids: (string | null)[] | undefined } {
  const out: I[] = []
  const outIds: (string | null)[] = []
  let sel: number | undefined
  let selTo: number | undefined
  items.forEach((item, i) => {
    if (i === select) sel = out.length
    if (item.parts && item.parts.length > 0 && item.rows > room) {
      for (const part of item.parts) {
        out.push(part)
        outIds.push(null)
      }
    } else {
      out.push(item)
      outIds.push(ids?.[i] ?? null)
    }
    if (i === selectTo) selTo = out.length - 1
  })
  return { items: out, select: sel, selectTo: selTo, ids: ids ? outIds : undefined }
}
