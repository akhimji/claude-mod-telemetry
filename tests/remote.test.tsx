// Remote monitoring (NOTES.md, "Remote monitoring"): a session runs on one
// machine and a desktop app on another watches it as a remote surface.
//
// - The clients' reducers and what the UI reads of them (hooks/clients.ts).
// - Through the kit: a desktop or vscode client attaching opens the pane
//   unasked and unfocused, a reconnect too; a phone does not; a pane the person
//   closed stays closed until `/telemetry`; detaches are recorded.
// - The cadence (hooks/ui/cadence.ts and pane.tsx): remote-only ticks at 2 s and
//   15 s, none while `$.ui.panes()` says the pane is drawn nowhere; the terminal
//   keeps 1 s.
// - Payload: the Svg caps and memo; the populated-max pane (many agents, every
//   drawer open, the workflows view) serializes under 40k characters on desktop.
// - Reconnect: detach, a hot-reload hydrate, re-attach: the same headline, and
//   the `ui` state (tab, open drawers) kept.
// - The header's `remote · <machine>` chip, only after a Remote Control delivery.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TelemetryClients, TelemetryState, TelemetryUi } from '../types'

import { attachClient, CLIENTS_MAX, deriveClients, detachClient, hostOf, isRemoteOnly, markBridge, remoteChip, shouldAutoOpen, startClients, whereReport } from '../hooks/clients'
import * as collect from '../hooks/collect'
import { deriveWorkflows } from '../hooks/insights'
import { bandTickMs, paneTickMs, REMOTE_CACHE_TICK_MS, REMOTE_TICK_MS, TICK_MS } from '../hooks/ui/cadence'
import { clearSvgMemo, gridSvg, lanesSvg, segmentsSvg, sparkSvg, SVG_CAPS, SVG_MEMO_MAX, svgMemoSize, type Lane, type SegmentPart } from '../hooks/ui/svg'
import { PAYLOAD_JSON_BUDGET, payloadOf } from '../hooks/ui/desktop/view'
import { TABS } from '../hooks/ui/ui-state'

import { NOW, populated, withGhosts, withManyDone } from './fixture'
import { withPlans } from './plans-fixture'

const PANE_ID = 'session-telemetry'

type Surface = 'desktop' | 'vscode' | 'terminal'

const pane = (cols: number, rows: number, surface: Surface) =>
  ({
    plugin: 'session-telemetry',
    surface,
    component: 'Pane',
    requestId: PANE_ID,
    props: { title: 'Telemetry', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols, rows, isFullscreen: true },
  }) as const

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

/**
 * Answers the telemetry atoms from `world.s`; `ui` and `clients` from the world
 * when set there (each write the plugin makes to them is kept, so a press reads
 * back), else from the kit's store.
 */
type World = { s: TelemetryState; ui?: TelemetryUi; clients?: TelemetryClients; version: number }

function seed(on: On, world: World): void {
  on('state.get', (_, e, next) => {
    if (e.plugin !== 'session-telemetry') return next(e)
    if (e.key === 'ui') return world.ui === undefined ? next(e) : { value: { value: { shape: 'v1', value: world.ui }, version: world.version } }
    if (e.key === 'clients') return world.clients === undefined ? next(e) : { value: { value: { shape: 'v1', value: world.clients }, version: world.version } }
    const value = (world.s as Record<string, unknown>)[e.key]
    return value === undefined ? next(e) : { value: { value: { shape: 'v1', value }, version: world.version } }
  })
}

/** Answers the core events a remote client's arrival raises, and records each pane open. */
function core(on: On): { opened: { id: string; focus?: boolean }[] } {
  const opened: { id: string; focus?: boolean }[] = []
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, ...(e.focus ? { focus: e.focus } : {}) })
    return { value: { isPlaced: true } }
  })
  return { opened }
}

const settle = async (clock: { advance: (ms: number) => Promise<void> }): Promise<void> => {
  await clock.advance(0)
}

// ── the clients, pure ─────────────────────────────────────────────────────────

describe('clients (pure)', () => {
  test('attach, reconnect under the same id, detach: the roster, the counts, the ages', () => {
    let c = attachClient(undefined, { surface: 'desktop', clientId: 'desk-1', viewport: { columns: 60, rows: 40, isFullscreen: true } }, 1000)
    c = attachClient(c, { surface: 'mobile', clientId: 'phone' }, 2000)
    c = detachClient(c, { surface: 'desktop', clientId: 'desk-1', reason: 'detach' }, 3000)
    let v = deriveClients(c, 4000)
    expect(v.attached.map(x => x.clientId)).toEqual(['phone'])
    expect(v.detached.map(x => [x.clientId, x.detachedAt, x.detachReason])).toEqual([['desk-1', 3000, 'detach']])
    // the reconnect: same id, attached again, its count raised, its last viewport kept when none is told
    c = attachClient(c, { surface: 'desktop', clientId: 'desk-1' }, 5000)
    v = deriveClients(c, 6000)
    const desk = v.attached.find(x => x.clientId === 'desk-1')
    expect(desk).toMatchObject({ surface: 'desktop', attachedAt: 5000, lastSeen: 5000, detachedAt: null, attaches: 2, viewport: { columns: 60, rows: 40, isFullscreen: true } })
    expect(v.attached.map(x => x.clientId)).toEqual(['phone', 'desk-1'])
    expect(v.remoteAttached).toBe(2)
    expect(v.reconnects).toBe(1)
    expect(v.lastAttachAt).toBe(5000)
    expect(v.ageMs['desk-1']).toBe(1000)
    // a detach of an id never seen attaching is still recorded
    c = detachClient(c, { surface: 'vscode', clientId: 'vs', reason: 'end' }, 7000)
    expect(deriveClients(c, 7000).detached[0]).toMatchObject({ clientId: 'vs', attaches: 0, detachReason: 'end' })
  })

  test('the roster is bounded: the oldest detached go first', () => {
    let c = attachClient(undefined, { surface: 'desktop', clientId: 'keep' }, 1)
    for (let i = 0; i < CLIENTS_MAX + 10; i += 1) {
      c = attachClient(c, { surface: 'mobile', clientId: `p${i}` }, 10 + i)
      c = detachClient(c, { surface: 'mobile', clientId: `p${i}`, reason: 'detach' }, 11 + i)
    }
    expect(c.clients.length).toBe(CLIENTS_MAX)
    expect(c.clients.some(x => x.clientId === 'keep')).toBe(true)
    expect(c.clients.some(x => x.clientId === 'p0')).toBe(false)
  })

  test('a foreign or broken stored value reads as empty; start, bridge and host are kept', () => {
    expect(deriveClients({ nonsense: true } as unknown as TelemetryClients, 0).attached).toEqual([])
    let c = startClients(undefined, null, 'mbp', 10)
    expect(c.startSurface).toBe(null)
    c = markBridge(c, null, 20)
    c = markBridge(c, 'other', 30)
    expect(c.bridgeSeenAt).toBe(20)
    expect(c.host).toBe('other')
    expect(deriveClients(c, 40)).toMatchObject({ startSurface: null, isBridged: true, host: 'other' })
  })

  test('remote-only: never on the terminal, never with a terminal binding, never when no start was seen', () => {
    expect(isRemoteOnly('terminal', startClients(undefined, null, null, 1))).toBe(false)
    expect(isRemoteOnly('desktop', undefined)).toBe(false)
    expect(isRemoteOnly('desktop', startClients(undefined, 'terminal', null, 1))).toBe(false)
    expect(isRemoteOnly('desktop', startClients(undefined, null, null, 1))).toBe(true)
    expect(isRemoteOnly('vscode', startClients(undefined, 'desktop', null, 1))).toBe(true)
  })

  test('auto-open: desktop and vscode, not a phone, never after the person closed the pane', () => {
    expect(shouldAutoOpen('desktop', undefined)).toBe(true)
    expect(shouldAutoOpen('vscode', undefined)).toBe(true)
    expect(shouldAutoOpen('mobile', undefined)).toBe(false)
    expect(shouldAutoOpen('terminal', undefined)).toBe(false)
    expect(shouldAutoOpen('desktop', 123)).toBe(false)
  })

  test('the remote chip: only on a remote surface after a bridge prompt; the host, else the cwd basename', () => {
    const bridged = markBridge(undefined, null, 5)
    expect(remoteChip('desktop', undefined, '/w/my-project')).toBe(null)
    expect(remoteChip('terminal', bridged, '/w/my-project')).toBe(null)
    expect(remoteChip('desktop', bridged, '/w/my-project/')).toBe('remote · my-project')
    expect(remoteChip('desktop', bridged, null)).toBe('remote')
    expect(remoteChip('vscode', markBridge(undefined, 'studio-mac', 5), '/w/my-project')).toBe('remote · studio-mac')
    expect(hostOf('mbp-of-aly.local')).toBe('mbp-of-aly')
    expect(hostOf('  ')).toBe(null)
    expect(hostOf(undefined)).toBe(null)
  })

  test('the cadence: the terminal unchanged, remote-only slower, the band silent remotely', () => {
    expect(paneTickMs({ live: true, cacheMs: null, remoteOnly: false })).toBe(TICK_MS)
    expect(paneTickMs({ live: false, cacheMs: 1000, remoteOnly: false })).toBe(1000)
    expect(paneTickMs({ live: false, cacheMs: 15_000, remoteOnly: false })).toBe(15_000)
    expect(paneTickMs({ live: false, cacheMs: null, remoteOnly: false })).toBe(null)
    expect(paneTickMs({ live: true, cacheMs: 1000, remoteOnly: true })).toBe(REMOTE_TICK_MS)
    expect(paneTickMs({ live: false, cacheMs: 1000, remoteOnly: true })).toBe(REMOTE_CACHE_TICK_MS)
    expect(paneTickMs({ live: false, cacheMs: null, remoteOnly: true })).toBe(null)
    expect(bandTickMs({ active: true, remoteOnly: false })).toBe(TICK_MS)
    expect(bandTickMs({ active: true, remoteOnly: true })).toBe(null)
    expect(bandTickMs({ active: false, remoteOnly: false })).toBe(null)
  })
})

// ── attach, reconnect, close ─────────────────────────────────────────────────

test('a desktop client attaching opens the pane unasked and unfocused; a reconnect opens it again; a phone does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { opened } = core(on)
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1', viewport: { columns: 60, rows: 40, isFullscreen: true } })
  await settle(clock)
  expect(opened).toEqual([{ id: PANE_ID }])
  await $.session.attach({ surface: 'mobile', clientId: 'phone' })
  await settle(clock)
  expect(opened.length).toBe(1)
  await $.session.detach({ surface: 'desktop', clientId: 'desk-1', reason: 'detach' })
  await clock.advance(5000)
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await settle(clock)
  expect(opened).toEqual([{ id: PANE_ID }, { id: PANE_ID }])
  await $.session.attach({ surface: 'vscode', clientId: 'vs-1' })
  await settle(clock)
  expect(opened.length).toBe(3)
  expect(opened.every(o => o.focus === undefined)).toBe(true)
})

test('the clients are recorded in the `clients` value: attach, detach and the reconnect', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  core(on)
  const writes: TelemetryClients[] = []
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry' && e.key === 'clients') writes.push((e.value as { value: TelemetryClients }).value)
    return next(e)
  })
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await $.session.detach({ surface: 'desktop', clientId: 'desk-1', reason: 'detach' })
  await clock.advance(1000)
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await settle(clock)
  const last = writes[writes.length - 1]
  const v = deriveClients(last, NOW + 1000)
  expect(v.attached.map(x => [x.clientId, x.attaches, x.attachedAt])).toEqual([['desk-1', 2, NOW + 1000]])
  expect(v.reconnects).toBe(1)
  expect(writes.some(w => w.clients.some(x => x.detachedAt === NOW && x.detachReason === 'detach'))).toBe(true)
})

test('a pane the person closed stays closed on attach and on session start, until /telemetry opens it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { opened } = core(on)
  const world: World = { s: populated(), ui: { tab: 'agents', agentId: null, scroll: {}, paneClosedAt: NOW - 60_000 }, version: 1 }
  seed(on, world)
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry' && e.key === 'ui') {
      world.ui = (e.value as { value: TelemetryUi }).value
      world.version += 1
    }
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'telemetry' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await settle(clock)
  expect(opened).toEqual([])
  // the person asks: it opens with the keyboard, and the close is lifted
  await $.command.run({ command: 'telemetry', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(opened).toEqual([{ id: PANE_ID, focus: true }])
  expect(world.ui?.paneClosedAt).toBeUndefined()
  // from then on an attach opens it unasked again
  await $.session.attach({ surface: 'desktop', clientId: 'desk-2' })
  await settle(clock)
  expect(opened).toEqual([{ id: PANE_ID, focus: true }, { id: PANE_ID }])
})

// ── cadence ──────────────────────────────────────────────────────────────────

/** A remote-only world: the session's start named no terminal. */
function remoteWorld(s: TelemetryState): World {
  return { s, clients: startClients(undefined, null, null, NOW - 1000), version: 1 }
}

test('remote-only, a running session ticks every 2 s, not every second', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, remoteWorld(populated()))
  on('ui.panes', () => ({ value: [{ id: PANE_ID, title: 'Telemetry', isShown: true, isFocused: false, isPlaced: true }] }))
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:live' })
  const first = texts(await ui.drawn()).join('\n')
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n'), 'no redraw after 1 s').toBe(first)
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n'), 'a redraw after 2 s').not.toBe(first)
  await ui.unmount()
})

test('remote-only, no tick redraws while `$.ui.panes()` says the pane is drawn nowhere', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, remoteWorld(populated()))
  let asked = 0
  on('ui.panes', () => {
    asked += 1
    return { value: [{ id: PANE_ID, title: 'Telemetry', isShown: false, isFocused: false, isPlaced: false }] }
  })
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:live' })
  const first = texts(await ui.drawn()).join('\n')
  await clock.advance(2000)
  await clock.advance(2000)
  expect(asked).toBeGreaterThanOrEqual(1)
  expect(texts(await ui.drawn()).join('\n')).toBe(first)
  await ui.unmount()
})

test('remote-only, the cache clock ticks every 15 s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = populated()
  s.meta.activeTurns = {}
  // nothing runs (main idle, every subagent over), so only the cache clock asks for a tick
  for (const a of Object.values(s.agents.byId)) a.status = a.id === 'main' ? 'idle' : 'completed'
  s.tools = s.tools.filter(t => t.status !== 'running')
  seed(on, remoteWorld(s))
  on('ui.panes', () => ({ value: [{ id: PANE_ID, title: 'Telemetry', isShown: true, isFocused: false, isPlaced: true }] }))
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:overview' })
  expect(texts(await ui.drawn()).join('\n')).toContain('4m 00s')
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n')).toContain('4m 00s')
  await clock.advance(14_000)
  expect(texts(await ui.drawn()).join('\n')).toContain('3m 45s')
  await ui.unmount()
})

test('with a terminal binding, a desktop drawing keeps the 1 s tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  seed(on, { s: populated(), clients: startClients(undefined, 'terminal', null, NOW - 1000), version: 1 })
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:live' })
  const first = texts(await ui.drawn()).join('\n')
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n')).not.toBe(first)
  await ui.unmount()
})

// ── payload ──────────────────────────────────────────────────────────────────

describe('Svg payload', () => {
  test('lanes are capped at 120, the rest counted in the alt', () => {
    const lanes: Lane[] = Array.from({ length: 300 }, (_, i) => ({ start: i * 10, end: i * 10 + 50, status: 'done' }))
    const spec = lanesSvg(lanes, { width: 600, from: 0, to: 4000 })
    const rects = (spec.source.match(/<rect /g) ?? []).length
    expect(rects).toBeLessThanOrEqual(SVG_CAPS.lanes * 2)
    expect(spec.alt).toContain('120 agent lanes')
    expect(spec.alt).toContain('180 more not drawn')
  })

  test('the grid is never over 200 cells; segments and spark points are capped at 120', () => {
    const cells = Array.from({ length: 900 }, () => ({ color: '#3b7dd8', kind: 'used' as const, fullness: 1 }))
    const grid = gridSvg(cells, { side: 30 })
    expect((grid.source.match(/<rect /g) ?? []).length).toBeLessThanOrEqual(SVG_CAPS.gridCells)
    const parts: SegmentPart[] = Array.from({ length: 400 }, (_, i) => ({ px: 2, color: '#d2704e', kind: 'segment', label: `s${i}` }))
    const seg = segmentsSvg(parts, { width: 1200 })
    expect((seg.source.match(/<rect /g) ?? []).length).toBeLessThanOrEqual(SVG_CAPS.segments)
    const spark = sparkSvg(Array.from({ length: 2000 }, (_, i) => i % 17), { width: 1400 })
    const points = (spark.source.match(/points="([^"]*)"/)?.[1] ?? '').split(' ').length
    expect(points).toBeLessThanOrEqual(SVG_CAPS.sparkPoints)
  })

  test('identical data at one width answers the very same markup; the memo stays bounded', () => {
    clearSvgMemo()
    const lanes: Lane[] = [{ start: 0, end: null, status: 'running' }]
    const a = lanesSvg(lanes, { width: 300, from: 0, to: 100 })
    const b = lanesSvg([{ start: 0, end: null, status: 'running' }], { width: 300, from: 0, to: 100 })
    expect(b).toBe(a)
    expect(lanesSvg(lanes, { width: 301, from: 0, to: 100 }).source).not.toBe(a.source)
    for (let i = 0; i < SVG_MEMO_MAX * 3; i += 1) sparkSvg([i, i + 1], { width: 40 })
    expect(svgMemoSize()).toBeLessThanOrEqual(SVG_MEMO_MAX)
  })
})

/** Many agents (60 done, the ghosts, the plans), every drawer open, every workflow open, every finished agent shown. */
function populatedMax(): { s: TelemetryState; ids: string[]; workflows: string[] } {
  const s = withManyDone(withPlans(withGhosts(populated())), 60)
  s.meta.cwd = '/Users/someone/work/my-project'
  const ids = Object.keys(s.agents.byId)
  const workflows = deriveWorkflows(s, NOW).map(w => w.id)
  return { s, ids, workflows }
}

test('the populated-max pane stays under 40k characters of tree text on desktop (and its serialized tree under the JSON budget), every tab, both agent views', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { s, ids, workflows } = populatedMax()
  expect(ids.length).toBeGreaterThan(60)
  const world: World = { s, version: 1 }
  seed(on, world)
  let widest = 0
  for (const [cols, rows] of [
    [40, 24],
    [48, 24],
    [64, 40],
    [120, 50],
    [200, 120],
  ] as const) {
    for (const mode of ['tree', 'workflows'] as const) {
      for (const tab of TABS) {
        world.ui = { tab, agentId: null, scroll: {}, showAllAgents: true, agentsMode: mode, expandedAgents: ids, expandedWorkflows: workflows }
        world.version += 1
        const ui = await $.ui.mount(pane(cols, rows, 'desktop'))
        const tree = await ui.drawn()
        const size = payloadOf(tree)
        widest = Math.max(widest, size.text)
        expect(size.text, `${cols}x${rows} ${mode} ${tab}: tree text`).toBeLessThan(40_000)
        // the frame budgets the elements it builds (PAYLOAD_JSON_BUDGET); the drawn tree carries a little more (the kit's own fields), still under the 100k cut
        expect(size.json, `${cols}x${rows} ${mode} ${tab}: serialized`).toBeLessThan(Math.min(90_000, PAYLOAD_JSON_BUDGET * 1.125))
        expect(JSON.stringify(tree).length).toBe(size.json)
        await ui.unmount()
      }
    }
  }
  // the bound is meant to be a real one, not a fixture that draws nothing
  expect(widest).toBeGreaterThan(5_000)
})

// ── reconnect ────────────────────────────────────────────────────────────────

test('detach, a hot-reload hydrate, re-attach: the pane draws the same headline from $.state, with its tab and open drawers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { opened } = core(on)
  const world: World = { s: populated(), version: 1 }
  seed(on, world)
  on('command.register', () => ({ value: { command: 'telemetry' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  const ui = await $.ui.mount(pane(60, 40, 'desktop'))
  await ui.press({ key: 'tab:agents' })
  await ui.press({ key: 'agent:a1' })
  const before = texts(await ui.drawn())
  const headline = before.find(t => t.startsWith('$'))
  expect(headline).toBe('$3.21')
  expect(before.join('\n')).toContain('find every caller')
  const beforeDrawer = before.filter(t => /^(type|tokens|tools)\b/i.test(t)).length

  // the desktop goes away; the module is reloaded (its memory gone, the session.start pass re-run)
  await $.session.detach({ surface: 'desktop', clientId: 'desk-1', reason: 'detach' })
  await ui.unmount()
  collect.resetForTests()
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  world.version += 1
  await clock.advance(1000)

  // the desktop comes back under its id: the pane is opened again and draws from $.state
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await settle(clock)
  expect(opened.filter(o => o.id === PANE_ID).length).toBeGreaterThanOrEqual(2)
  const again = await $.ui.mount(pane(60, 40, 'desktop'))
  const after = texts(await again.drawn())
  expect(after.find(t => t.startsWith('$'))).toBe(headline)
  // the `ui` value survived: Agents shown (its tab in the accent), a1's drawer still open
  const shown = await again.find({ type: 'Button', key: 'tab:agents' })
  expect(JSON.stringify(shown?.children)).toContain('"claude"')
  expect(after.filter(t => /^(type|tokens|tools)\b/i.test(t)).length).toBe(beforeDrawer)
  expect(after.join('\n')).toContain('find every caller')
  await again.unmount()
})

// ── the remote chip ──────────────────────────────────────────────────────────

test('after a Remote Control delivery, a remote surface shows `remote · <machine>`; the terminal never does', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOSTNAME: 'studio-mac.local' })
  const s = populated()
  s.meta.cwd = '/Users/someone/work/my-project'
  const world: World = { s, version: 1 }
  seed(on, world)
  on('session.receive', (_, e) => ({ text: e.text }))

  const before = await $.ui.mount(pane(80, 40, 'desktop'))
  expect(texts(await before.drawn()).join('\n')).not.toContain('remote ·')
  await before.unmount()

  await $.session.receive({ origin: { kind: 'bridge' }, text: 'status?' })
  const desk = await $.ui.mount(pane(80, 40, 'desktop'))
  expect(texts(await desk.drawn())).toContain('· remote · studio-mac')
  await desk.unmount()
  const term = await $.ui.mount(pane(80, 24, 'terminal'))
  expect(texts(await term.drawn()).join('\n')).not.toContain('remote ·')
  await term.unmount()
})

// ── /telemetry where ─────────────────────────────────────────────────────────

const WHERE = { command: 'telemetry', args: 'where', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

test('/telemetry where on an empty roster: no clients, never closed, no open, no attach; it opens nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { opened } = core(on)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.panes', () => ({ value: [] }))
  const out = await $.command.run(WHERE)
  expect(opened).toEqual([])
  expect(out.text).toContain('surfaces(): terminal')
  expect(out.text).toContain('panes(): (none for this plugin)')
  expect(out.text).toContain('clients: (none)')
  expect(out.text).toContain('paneClosedAt: never')
  expect(out.text).toContain('last open: (none recorded)')
  expect(out.text).toContain('session.attach seen: 0')
})

test('/telemetry where after a desktop client attached and its unasked open was not placed: the client, the pane, the reason', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world: World = { s: populated(), version: 1 }
  seed(on, world)
  on('state.set', (_, e, next) => {
    if (e.plugin === 'session-telemetry' && e.key === 'ui') world.ui = (e.value as { value: TelemetryUi }).value
    if (e.plugin === 'session-telemetry' && e.key === 'clients') world.clients = (e.value as { value: TelemetryClients }).value
    if (e.plugin === 'session-telemetry' && (e.key === 'ui' || e.key === 'clients')) world.version += 1
    return next(e)
  })
  const logs: string[] = []
  on('ui.log', (_, e, next) => {
    logs.push(String(e.text))
    return next(e)
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no attached surface places panes' } }))
  on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }))
  on('ui.panes', () => ({ value: [{ id: PANE_ID, title: 'Telemetry', isShown: false, isFocused: false, isPlaced: false }] }))
  await $.session.attach({ surface: 'desktop', clientId: 'desk-1' })
  await settle(clock)
  await clock.advance(3000)
  const out = await $.command.run(WHERE)
  expect(out.text).toContain('surfaces(): terminal, desktop')
  expect(out.text).toContain('pane session-telemetry "Telemetry": isPlaced=false isShown=false isFocused=false')
  expect(out.text).toContain('client desk-1 [desktop]: attached')
  expect(out.text).toContain('last open: ')
  expect(out.text).toContain('asked=false isPlaced=false reason="no attached surface places panes"')
  expect(out.text).toContain('session.attach seen: 1 (last desktop')
  expect(out.text).not.toContain('/')
  expect(logs.some(l => l.includes('pane waits (asked=false): no attached surface places panes'))).toBe(true)
})

test('whereReport (pure): a detached client, a closed pane, failed engine calls', () => {
  const c = detachClient(attachClient(undefined, { surface: 'desktop', clientId: 'd' }, NOW - 5000), { surface: 'desktop', clientId: 'd', reason: 'end' }, NOW - 1000)
  const text = whereReport({ now: NOW, surfaces: null, panes: null, paneId: PANE_ID, clients: c, ui: { paneClosedAt: NOW - 2000 }, cwd: '/a/b/proj' })
  expect(text).toContain('cwd folder: proj;')
  expect(text).toContain('surfaces(): unavailable')
  expect(text).toContain('panes(): unavailable')
  expect(text).toMatch(/client d \[desktop\]: attached .*\(5s ago\); detached .*\(1s ago\) \(end\); attaches 1/)
  expect(text).toMatch(/paneClosedAt: .*\(2s ago\)/)
})
