// The terminal frames of the insights views, through tests/term-render.ts:
// the Overview with alerts (80x40, 48x30), the Context tab's bloat audit
// (80x40, 48x30), the Live tab with alert rows (80x30), the Agents tab in
// workflows mode with one card open (80x30, 48x24), and the band in its
// states (80 and 48 cells). Each frame is checked to be within its rows and
// columns; with PRINT set to true below they are printed between
// VIEWS-BEGIN and VIEWS-END, so they can be looked at.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TelemetryState } from '../types'

import { ledgerGap, NOW, populated, withGhosts } from './fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'
import { alertsLog, withAlerts, withBloat } from './views-fixture'

const pane = (cols: number, rows: number) =>
  ({
    plugin: 'session-telemetry',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

const band = (cols: number) =>
  ({
    plugin: 'session-telemetry',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: cols, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    viewport: { columns: cols + 5, rows: 40, isFullscreen: true },
  }) as const

/** Print the frames (see the note above). */
const PRINT = false

test('the terminal frames of the insights views fit their rows and columns (PRINT shows them)', async ($, on) => {
  mock.clock(on, { now: NOW })
  const box: { s: TelemetryState; alerts?: unknown; version: number } = { s: withAlerts(), alerts: alertsLog(), version: 1 }
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    if (e.key === 'alerts') return box.alerts === undefined ? next(e) : { value: { value: { shape: 'v1', value: box.alerts }, version: box.version } }
    const value = (box.s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: box.version } }
  })
  const out: string[] = []
  const frame = (title: string, rows: string[], cols: number) => {
    out.push(`── ${title} ${'─'.repeat(Math.max(0, cols - title.length - 4))}`, ...trimmed(rows), '')
  }
  const check = (where: string, tree: unknown, cols: number, rows: number): string[] => {
    const lines = renderText(tree, cols)
    expect(lines.length, `${where}: rows`).toBeLessThanOrEqual(rows)
    for (const line of lines) expect(Array.from(line).length, `${where}: "${line}"`).toBe(cols)
    expect(fixedOverflow(tree, cols), `${where}: fixed cells`).toBeLessThanOrEqual(0)
    return lines
  }
  const shots: [string, () => void, string, [number, number][], string[]][] = [
    ['alerts', () => undefined, 'overview', [[80, 40], [48, 30]], []],
    ['alerts', () => undefined, 'live', [[80, 30]], []],
    ['bloat', () => (box.s = withBloat()), 'context', [[80, 44], [48, 30]], ['context:down']],
    ['ledgerGap workflows', () => (box.s = ledgerGap()), 'agents', [[80, 30], [48, 24]], ['agents:workflows', 'wf:root:a1']],
    ['ledgerGap tree', () => undefined, 'agents', [[80, 30]], ['agents:tree']],
  ]
  for (const [name, prep, tab, sizes, presses] of shots) {
    prep()
    box.version += 1
    for (const [cols, rows] of sizes) {
      const ui = await $.ui.mount(pane(cols, rows))
      await ui.press({ key: `tab:${tab}` })
      for (const key of presses) if (await ui.find({ type: 'Button', key })) await ui.press({ key })
      const where = `${name} ${cols}x${rows} ${tab}`
      frame(where, check(where, await ui.drawn(), cols, rows), cols)
      await ui.unmount()
    }
  }
  // the band: the alert state, the plain running state, and the hot context
  for (const [name, make] of [
    ['band alert', () => withGhosts(populated())],
    ['band running', () => populated()],
  ] as const) {
    box.s = make()
    box.version += 1
    for (const cols of [80, 48]) {
      const ui = await $.ui.mount(band(cols))
      const tree = await ui.drawn()
      const lines = renderText(tree, cols)
      expect(lines.length, name).toBeLessThanOrEqual(6)
      frame(`${name} ${cols}`, lines, cols)
      await ui.unmount()
    }
  }
  const g = globalThis as unknown as { console?: { log: (text: string) => void } }
  if (PRINT) g.console?.log(`\nVIEWS-BEGIN\n${out.join('\n')}\nVIEWS-END\n`)
  void (null as unknown as On)
})
