// The terminal frames, through tests/term-render.ts (this suite's layout of
// the trees, not the terminal's own): every tab at 80x24, and the Agents tab
// at 40x10, 48x24, 120x40 and 160x50, for the populated session, the ghosts
// and the long done list. Every frame is checked to be within its rows and
// columns; with PRINT set to true below they are also printed between
// FRAMES-BEGIN and FRAMES-END, so they can be looked at (the sandbox has no
// environment or files to switch on).

import { expect, mock, test } from 'claude-code/testing'

import type { TelemetryState } from '../types'

import { TABS } from '../hooks/ui/ui-state'

import { NOW, populated, withGhosts, withManyDone } from './fixture'
import { fixedOverflow, renderText, trimmed } from './term-render'

const pane = (cols: number, rows: number) =>
  ({
    plugin: 'session-telemetry',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-telemetry',
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

const width = (s: string): number => Array.from(s).length

/** Print the frames (see the note above). */
const PRINT = false

test('the terminal frames fit their rows and columns at every size (PRINT shows them)', async ($, on) => {
  mock.clock(on, { now: NOW })
  let state: TelemetryState = populated()
  let version = 1
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry' || e.key === 'ui') return next(e)
    const value = (state as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version } }
  })
  const out: string[] = []
  const frame = (title: string, rows: string[], cols: number) => {
    out.push(`── ${title} ${'─'.repeat(Math.max(0, cols - title.length - 4))}`)
    out.push(...trimmed(rows))
    out.push('')
  }
  const fixtures: [string, () => TelemetryState][] = [
    ['populated', populated],
    ['ghosts', () => withGhosts(populated())],
    ['manyDone', () => withManyDone(populated(), 21)],
  ]
  for (const [name, make] of fixtures) {
    state = make()
    version += 1
    const sizes: [number, number][] = name === 'populated' ? [[80, 24], [40, 10], [48, 24], [120, 40], [160, 50]] : [[80, 24], [48, 24]]
    for (const [cols, rows] of sizes) {
      const ui = await $.ui.mount(pane(cols, rows))
      const tabs = cols === 80 && rows === 24 && name === 'populated' ? TABS : (['agents'] as const)
      for (const tab of tabs) {
        await ui.press({ key: `tab:${tab}` })
        if (tab === 'agents' && name === 'ghosts') await ui.press({ key: 'agent:g3' })
        const tree = await ui.drawn()
        const lines = renderText(tree, cols)
        const where = `${name} ${cols}x${rows} ${tab}`
        expect(lines.length, `${where}: rows`).toBeLessThanOrEqual(rows)
        for (const line of lines) expect(width(line), `${where}: "${line}"`).toBe(cols)
        // the renderer fits by construction; the fixed cells must leave the growing cell its room
        expect(fixedOverflow(tree, cols), `${where}: fixed cells within the body`).toBeLessThanOrEqual(0)
        frame(where, lines, cols)
      }
      await ui.unmount()
    }
  }
  // the test sandbox has no `process` (no environment to read): flip PRINT to look at the frames
  const g = globalThis as unknown as { console?: { log: (text: string) => void } }
  if (PRINT) g.console?.log(`\nFRAMES-BEGIN\n${out.join('\n')}\nFRAMES-END\n`)
})
