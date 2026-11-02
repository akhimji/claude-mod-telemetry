// The band above the prompt (hooks/ui/band.ts, desktop/band.tsx, term/band.tsx)
// through the engine's kit on the terminal and the desktop, at 40, 48, 80 and
// 120 cells: empty (one compact row), populated (something runs: the full
// band), with an alert (the chip, the Overview target), with a breakdown (the
// segments and the legend); never over four content rows; the fixed cells
// within the width; no secret, no `unknown`, no epoch; the mode from
// `/telemetry band`; a survey yields; another mod's band is kept beneath; a
// press opens the pane on the right tab. And the pure geometry: widths that
// add up exactly, the badge tone, the countdown, the chips that fit.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TelemetryState } from '../types'

import { emptyState } from '../hooks/model'
import { deriveBand } from '../hooks/insights'
import { allocate, badgeTone, bandShow, bandTab, barParts, fitChips, fmtCountdown, legendItems, segmentPx, bandChips } from '../hooks/ui/band'
import { segmentsSvg } from '../hooks/ui/svg'

import { ledgerGap, NOW, populated, SECRET, withGhosts } from './fixture'
import { bloatSession, T0, usageOf } from './insights-fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'

const SIZES = [40, 48, 80, 120] as const

const band = (cols: number, surface: 'terminal' | 'desktop' | 'vscode', maxRows = 10) =>
  ({
    plugin: 'session-telemetry',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: cols, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
    viewport: { columns: cols + 5, rows: 40, isFullscreen: true },
  }) as const

function seed(on: On, s: TelemetryState, alerts?: unknown): void {
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    if (e.key === 'alerts') return alerts === undefined ? next(e) : { value: { value: { shape: 'v1', value: alerts }, version: 1 } }
    const value = (s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: 1 } }
  })
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function walk(el: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(el)) {
    for (const x of el) walk(x, fn)
    return
  }
  if (!el || typeof el !== 'object') return
  const n = el as Node
  fn(n)
  for (const c of n.children ?? []) walk(c, fn)
}

function texts(tree: unknown): string[] {
  const out: string[] = []
  walk(tree, n => {
    if (n.type !== 'Text') return
    const own = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
    if (own.trim() !== '') out.push(own)
  })
  return out
}

function svgs(tree: unknown): { alt: string; source: string }[] {
  const out: { alt: string; source: string }[] = []
  walk(tree, n => {
    if (n.type === 'Svg') out.push({ alt: String(n.props?.alt ?? ''), source: String(n.props?.source ?? '') })
  })
  return out
}

/** The content rows of the desktop tree: the children of the outer column Box (the border is CSS there). */
function deskRows(tree: unknown): number {
  const root = tree as Node
  if (root.type !== 'Box') return 0
  if (root.props?.flexDirection === 'row') return 1
  return (root.children ?? []).flat(4).filter(c => c !== null && c !== undefined && c !== false).length
}

/** The bloat session with a running main turn (the full band) and a stale alert in the log. */
function breakdownSession(): TelemetryState {
  const s = bloatSession()
  s.meta.activeTurns = { main: 't9' }
  const main = s.agents.byId.main
  if (main) main.lastActiveAt = T0 - 1000
  s.totals.session = usageOf(10_000, 50_000, 5_000_000, 100_000, 5, 200)
  return s
}

/** Print the frames (the sandbox has no environment to switch on). */
const PRINT = false

test('terminal: compact when idle, full while something runs, within the rows and the width, at every size', async ($, on) => {
  mock.clock(on, { now: NOW })
  let state: TelemetryState = emptyState(NOW - 1000)
  let version = 1
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (state as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version } }
  })
  const out: string[] = []
  for (const which of ['empty', 'populated', 'alert', 'breakdown'] as const) {
    state = which === 'empty' ? emptyState(NOW - 1000) : which === 'populated' ? populated() : which === 'alert' ? withGhosts(populated()) : breakdownSession()
    version += 1
    const now = which === 'breakdown' ? T0 : NOW
    const b = deriveBand(state, now)
    for (const cols of SIZES) {
      for (const maxRows of [10, 5, 3]) {
        const ui = await $.ui.mount(band(cols, 'terminal', maxRows))
        const tree = await ui.drawn()
        const lines = trimmed(renderText(tree, cols))
        const where = `${which} ${cols} rows ${maxRows}`
        out.push(`── ${where} ${'─'.repeat(Math.max(0, cols - where.length - 4))}`, ...lines, '')
        const full = which !== 'empty' && maxRows >= 4
        // the border's two rows are chrome: the content is four rows at most, the whole at most six, and never over the slot
        expect(lines.length, `${where}: rows`).toBeLessThanOrEqual(Math.min(maxRows >= 6 ? 6 : 4, Math.max(1, maxRows)))
        if (full) expect(lines.length, `${where}: the full band`).toBeGreaterThanOrEqual(4)
        else expect(lines.length, `${where}: one row`).toBe(1)
        for (const line of lines) expect(Array.from(line).length, `${where}: "${line}"`).toBeLessThanOrEqual(cols)
        expect(fixedOverflow(tree, cols), `${where}: fixed cells`).toBeLessThanOrEqual(0)
        const text = lines.join('\n')
        expect(text, `${where}: the title`).toContain('◆ telemetry')
        expect(text, `${where}: the cost`).toContain(which === 'empty' ? '$0.00' : which === 'breakdown' ? '$5.00' : '$3.21')
        expect(text, `${where}: no secret`).not.toContain(SECRET)
        expect(text, `${where}: no unknown`).not.toMatch(/\bunknown\b/)
        expect(text, `${where}: no epoch`).not.toMatch(/\d{3,}d /)
        if (full) {
          expect(text, `${where}: the badge`).toMatch(new RegExp(` ${Math.round(b.context.percent ?? 0)}%`))
          expect(lines[maxRows >= 6 ? 2 : 1], `${where}: the bar row`).toMatch(/[█─░]/)
        }
        if (which === 'alert' && full) expect(text, `${where}: the alert chip`).toContain('! ')
        if (which === 'breakdown' && full && cols >= 80) {
          expect(text, `${where}: the legend`).toContain('Messages')
          expect(text, `${where}: the hatched buffer`).toContain('░')
        }
        await ui.unmount()
      }
    }
  }
  const g = globalThis as unknown as { console?: { log: (text: string) => void } }
  if (PRINT) g.console?.log(`\nBAND-BEGIN\n${out.join('\n')}\nBAND-END\n`)
})

test('desktop and vscode: the box, the segmented bar, the legend swatches, the chips; four content rows; no box glyphs', async ($, on) => {
  mock.clock(on, { now: T0 })
  seed(on, breakdownSession())
  for (const surface of ['desktop', 'vscode'] as const) {
    for (const cols of SIZES) {
      const ui = await $.ui.mount(band(cols, surface))
      const tree = await ui.drawn()
      const where = `${surface} ${cols}`
      const all = texts(tree)
      const text = all.join('\n')
      expect((tree as Node).props?.borderStyle, `${where}: the rounded box`).toBe('round')
      expect(deskRows(tree), `${where}: four content rows`).toBe(4)
      expect(text, `${where}: the title`).toContain('◆ telemetry')
      expect(text, `${where}: the badge`).toContain(' 10% ')
      expect(text, `${where}: the cost chip`).toContain('$5.00')
      expect(text, `${where}: no box glyphs`).not.toMatch(/[━╸─│╭╮╰╯█▓▒░]/)
      expect(text, `${where}: no secret`).not.toContain(SECRET)
      const bar = svgs(tree).find(s => s.alt.startsWith('context bar'))
      expect(bar, `${where}: the bar`).toBeDefined()
      expect(bar?.source, `${where}: the hatch pattern`).toContain('<pattern')
      expect(bar?.source, `${where}: the messages segment colour`).toContain('#2fa36b')
      const sw = svgs(tree).filter(s => s.source.includes('rx="2"') && s.alt !== 'context bar').length
      if (cols >= 80) {
        expect(text, `${where}: the legend`).toContain('Messages')
        expect(sw, `${where}: legend swatches`).toBeGreaterThanOrEqual(3)
      }
      for (const s of svgs(tree)) {
        expect(s.alt.length).toBeGreaterThan(0)
        expect(s.source.startsWith('<svg')).toBe(true)
      }
      await ui.unmount()
    }
  }
})

test('desktop: idle collapses to one row with a small bar; a crit alert turns the badge red and the chip says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  let state: TelemetryState = emptyState(NOW - 1000)
  let version = 1
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (state as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version } }
  })
  const ui = await $.ui.mount(band(80, 'desktop'))
  let tree = await ui.drawn()
  expect(deskRows(tree)).toBe(1)
  expect(texts(tree).join(' ')).toContain('◆ telemetry')
  expect(texts(tree).join(' ')).toContain('$0.00')
  await ui.unmount()

  // the context at 94% of the auto-compact threshold: crit, the full band though main sits idle
  state = ledgerGap()
  state.meta.activeTurns = {}
  state.context.tokens = 940_000
  state.context.percent = 94
  state.context.window = 1_000_000
  version += 1
  const hot = await $.ui.mount(band(80, 'desktop'))
  tree = await hot.drawn()
  expect(deskRows(tree)).toBe(4)
  const text = texts(tree).join('\n')
  expect(text).toContain(' 94% ')
  expect(text).toContain('!! ')
  let badgeColor = ''
  walk(tree, n => {
    if (n.type === 'Text' && n.props?.inverse === true) badgeColor = String(n.props.color)
  })
  expect(badgeColor).toBe('error')
  await hot.unmount()
})

test('a survey or `band off` yields; another mod\'s band is kept beneath; `band compact` forces one row while a turn runs', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, populated())
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  const survey = await $.ui.mount({ ...band(80, 'terminal'), props: { ...band(80, 'terminal').props, hasSurvey: true } })
  expect(texts(await survey.drawn()).join('')).toBe('other band')
  await survey.unmount()

  const ui = await $.ui.mount(band(80, 'terminal'))
  let lines = trimmed(renderText(await ui.drawn(), 80))
  expect(lines.length).toBe(7)
  expect(lines[6]).toBe('other band')
  await $.command.run({ command: 'telemetry', args: 'band compact', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  lines = trimmed(renderText(await ui.drawn(), 80))
  expect(lines.length).toBe(2)
  expect(lines[0]).toMatch(/^◆ telemetry · \$3\.21 · ctx 45% ━+╸?─* · cache/)
  const bad = await $.command.run({ command: 'telemetry', args: 'band sideways', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(bad.text).toContain('Usage')
  await $.command.run({ command: 'telemetry', args: 'band off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(texts(await ui.drawn()).join('')).toBe('other band')
  await $.command.run({ command: 'telemetry', args: 'band auto', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(trimmed(renderText(await ui.drawn(), 80)).length).toBe(7)
  await ui.unmount()
})

test('a press on the title opens the pane on the tab the band points at; the badge opens Context', async ($, on) => {
  mock.clock(on, { now: NOW })
  seed(on, withGhosts(populated()))
  const opened: unknown[] = []
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  const ui = await $.ui.mount(band(80, 'desktop'))
  // a stale agent alerts: the title goes to Overview
  await ui.press({ key: 'band:open' })
  expect(opened[0]).toMatchObject({ id: 'session-telemetry', focus: true })
  const pane = await $.ui.mount({ plugin: 'session-telemetry', surface: 'desktop', component: 'Pane', requestId: 'session-telemetry', props: { title: 'Telemetry', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }, viewport: { columns: 80, rows: 30, isFullscreen: true } } as const)
  expect(texts(await pane.drawn()).join('\n')).toContain('TRACKED THIS SESSION')
  await ui.press({ key: 'band:context' })
  expect(opened).toHaveLength(2)
  expect(texts(await pane.drawn()).join('\n')).toContain('headroom')
  await pane.unmount()
  await ui.unmount()
})

test('geometry: the widths add up exactly, thin parts keep a floor, the badge tone, the countdown, the chips that fit', () => {
  for (const [parts, width] of [
    [[8000, 22000, 22000, 400, 1200, 500, 45900, 717000, 183000], 76],
    [[1, 1, 1, 1000], 10],
    [[5, 0, 5], 7],
    [[1, 2, 3], 1],
  ] as const) {
    const cells = allocate(parts, width, 1)
    expect(cells.reduce((a, b) => a + b, 0), `${parts.join(',')} over ${width}`).toBe(width)
    parts.forEach((p, i) => {
      if (p > 0 && width >= parts.filter(x => x > 0).length) expect(cells[i], `part ${i}`).toBeGreaterThanOrEqual(1)
      if (p === 0) expect(cells[i]).toBe(0)
    })
  }
  expect(allocate([0, 0], 10)).toEqual([0, 0])
  const px = segmentPx([8000, 22000, 400, 717000, 183000], 300, { gap: 1, min: 3 })
  expect(px.reduce((a, b) => a + b, 0) + 4).toBe(300)
  expect(Math.min(...px)).toBeGreaterThanOrEqual(3)
  const spec = segmentsSvg(
    [
      { px: px[0] ?? 0, color: '#3b7dd8', kind: 'segment', label: 'System prompt' },
      { px: px[1] ?? 0, color: '#d2704e', kind: 'segment', label: 'System tools' },
      { px: px[2] ?? 0, color: '#8b5cf6', kind: 'segment', label: 'Memory' },
      { px: px[3] ?? 0, color: '', kind: 'free', label: 'Free' },
      { px: px[4] ?? 0, color: '', kind: 'buffer', label: 'Autocompact buffer' },
    ],
    { width: 300, height: 8 },
  )
  expect(spec.width).toBe(300)
  expect(spec.source).toContain('url(#h300x8)')
  expect(spec.alt).toContain('Autocompact buffer')
  expect(segmentsSvg([], { width: 100 }).alt).toContain('nothing measured')

  expect(badgeTone('ok')).toBe('success')
  expect(badgeTone('warn')).toBe('warning')
  expect(badgeTone('crit')).toBe('error')
  expect(badgeTone('unknown')).toBeNull()

  expect(fmtCountdown(192_000, true)).toBe('3m 12s')
  expect(fmtCountdown(192_000, false)).toBe('3m')
  expect(fmtCountdown(42_000, true)).toBe('42s')
  expect(fmtCountdown(42_000, false)).toBe('<1m')
  expect(fmtCountdown(-5, true)).toBe('cold')
  expect(fmtCountdown(null, true)).toBe('–')

  const b = deriveBand(populated(), NOW)
  const chips = bandChips(b, { precise: true })
  expect(chips.map(c => c.id)).toEqual(['cost', 'agents', 'burn', 'cache'])
  expect(chips[1]?.runs.map(r => r.t).join('')).toBe('1 ▶ running · 1 done · 1 failed')
  // the burn goes first when the width runs short; the cost stays whatever
  expect(fitChips(chips, 50).map(c => c.id)).toEqual(['cost', 'agents'])
  expect(fitChips(chips, 8).map(c => c.id)).toEqual(['cost'])
  expect(bandShow('auto', b, 10)).toBe('full')
  expect(bandShow('auto', b, 3)).toBe('compact')
  expect(bandShow('auto', deriveBand(emptyState(0), 1), 10)).toBe('compact')
  expect(bandShow('full', deriveBand(emptyState(0), 1), 10)).toBe('full')
  expect(bandShow('off', b, 10)).toBe('hidden')
  expect(bandTab(b)).toBe('agents')
  expect(bandTab(deriveBand(withGhosts(populated()), NOW))).toBe('overview')

  // the legend drops the buffer first, then the smallest segments, until it fits
  const parts = barParts(deriveBand(breakdownSession(), T0), breakdownSession().context.breakdown?.categories ?? [])
  expect(parts.map(p => p.kind)).toEqual(['segment', 'segment', 'segment', 'segment', 'segment', 'segment', 'segment', 'free', 'buffer'])
  // the terminal colour is the engine's own key for the category
  expect(parts.find(p => p.key === 'system-prompt')?.theme).toBe('promptBorder')
  const wide = legendItems(parts, 200)
  expect(wide[wide.length - 1]?.part.kind).toBe('buffer')
  const narrow = legendItems(parts, 40)
  expect(narrow.some(it => it.part.kind === 'buffer')).toBe(false)
  expect(narrow.length).toBeLessThan(wide.length)
  expect(legendItems(parts, 1)).toHaveLength(1)
})
