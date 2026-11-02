// session-telemetry: the pane and the band. Registers the `/telemetry` command,
// opens the pane at session start, draws it on `ui.render` for { component:
// 'Pane', requestId: 'session-telemetry' }, takes the pane's scroll keys for
// its own lists, and draws the band above the prompt on `ui.render` for
// { component: 'AbovePrompt' } (hooks/ui/desktop/band.tsx, term/band.tsx).
//
// `$` goes only to functions named-imported from the module's own files
// (readInsights, ackAlerts, ioOf from ../state; the ui-state functions) or
// declared here; the tab builders and the drawing get plain data and closures.
//
// Live refresh: the drawing reads every telemetry atom (the alerts included),
// so it redraws on each write. While anything runs (a turn, a subagent, a tool
// call) it also arms one 1 s `$.clock.after` that invalidates every render hook
// of this plugin (the band too), so elapsed times and the spinner move with no
// write; idle, no timer is armed, except while the pane shows the Overview's
// cache clock with the cache still warm (1 s under ten minutes left, 15 s
// above). The band alone never polls: idle, its cache chip shows minutes.
// There is one shared timer for every component (`armTick`); when every
// surface that can draw is remote (no terminal binding), the pane ticks at 2 s
// and 15 s, the band arms nothing, and a tick that fires while `$.ui.panes()`
// says the pane is drawn nowhere redraws nothing (hooks/ui/cadence.ts).
//
// Remote clients (NOTES.md, "Remote monitoring"): `session.attach` records the
// client and opens the pane unasked, without focus, on a desktop or vscode
// client, unless the person closed the pane by hand (`ui.close`, origin
// `person`; `/telemetry` or the band's title clears that); `session.detach`
// records the departure; a `session.receive` or `prompt.submit` from the Remote
// Control bridge is noted once, for the header's `remote` chip.
//
// Exports: registerUi(on), startUi($, surface?), PANE_ID

import type { EngineInterface, On } from 'claude-code'

import type { TelemetryBandMode, TelemetryUiTab } from '../../types'

import { hostOf, isRemoteOnly, remoteChip, shouldAutoOpen, whereReport } from '../clients'
import * as collect from '../collect'
import { deriveOverview } from '../derive'
import { deriveBand, deriveCacheClock } from '../insights'
import { ackAlerts, ioOf, readInsights } from '../state'

import { bandShow, bandTab } from './band'
import { bandTickMs, paneTickMs } from './cadence'
import { deskBand } from './desktop/band'
import { type T4 } from './desktop/kit'
import { deskTree } from './desktop/view'
import { isActive } from './header'
import { layoutOf, type Layout, type TabInput } from './layout'
import { termBand } from './term/band'
import { type T3 } from './term/kit'
import { termTree } from './term/view'
import {
  bandModeOf,
  clearPaneClosed,
  collapseAgents,
  expandAgents,
  isBandMode,
  markPaneClosed,
  moveAgent,
  noteAttachSeen,
  readClients,
  readUi,
  recordAttach,
  recordBridge,
  recordDetach,
  recordOpen,
  recordStart,
  scrollTab,
  setAgentFilter,
  setAgentQuery,
  setAgentsMode,
  setBandMode,
  setTab,
  TABS,
  toggleAgent,
  toggleAllAgents,
  toggleWorkflow,
} from './ui-state'

export const PANE_ID = 'session-telemetry'
const TITLE = 'Telemetry'

// What the last drawing showed, for the scroll handler (not drawing state: a
// reload loses it and the next drawing sets it again).
const last: { tab: TelemetryUiTab; maxOffset: number; agentIds: string[] } = { tab: 'agents', maxOffset: 0, agentIds: [] }
/**
 * The one pending redraw shared by every component (null: none): when it is due,
 * its sequence number (a timer whose number is no longer this one was
 * superseded by a sooner one and does nothing), and whether only remote-only
 * drawings asked for it (then it checks the pane is drawn before redrawing).
 */
let pending: { due: number; seq: number; remote: boolean } | null = null
let tickSeq = 0
/** A pending redraw this long past due was lost (its timer died with a reload or a failed callback) and no longer holds back a new one. */
const LOST_TICK_MS = 5_000

/** The next redraw `ms` after `now`; a pending one due no later stands (a non-remote ask makes it unconditional). */
function armTick($: EngineInterface, now: number, ms: number, remote: boolean): void {
  const due = now + ms
  if (pending !== null && now > pending.due + LOST_TICK_MS) pending = null
  if (pending !== null && pending.due <= due) {
    if (!remote) pending.remote = false
    return
  }
  tickSeq += 1
  const seq = tickSeq
  pending = { due, seq, remote: remote && (pending === null || pending.remote) }
  try {
    $.clock.after(ms, () => {
      void fire($, seq).catch(() => undefined)
    })
  } catch {
    pending = null
  }
}

async function fire($: EngineInterface, seq: number): Promise<void> {
  if (pending === null || pending.seq !== seq) return
  const { remote } = pending
  pending = null
  // remote-only: a redraw crosses the wire, so none while no surface shows the pane
  if (remote && !(await isPaneDrawn($))) return
  $.ui.invalidate('ui.render')
}

/** Whether a surface draws the pane now (`$.ui.panes()`: listed and placed); true when the engine cannot say. */
async function isPaneDrawn($: EngineInterface): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    return panes.some(p => p.id === PANE_ID && p.isPlaced)
  } catch {
    return true
  }
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A delivery or a prompt came over the Remote Control bridge: noted the first time (a read, and a write only then). */
async function noteBridge($: EngineInterface): Promise<void> {
  try {
    if (typeof (await readClients($)).bridgeSeenAt === 'number') return
    await recordBridge($, await hostName($), await $.clock.now())
  } catch (err) {
    $.ui.log(`session-telemetry: bridge not recorded: ${why(err)}`, { to: 'debug' })
  }
}

/** The machine's name from the environment (`HOSTNAME`), when it is set. */
async function hostName($: EngineInterface): Promise<string | null> {
  try {
    return hostOf(await $.env.get('HOSTNAME'))
  } catch {
    return null
  }
}

async function onAct($: EngineInterface, act: string): Promise<void> {
  if (act.startsWith('tab:')) {
    const tab = act.slice(4) as TelemetryUiTab
    if ((TABS as readonly string[]).includes(tab)) await setTab($, tab)
    return
  }
  if (act.startsWith('agent:')) {
    // a click or Enter on a row's name: its drawer opens, or closes when open (several may be open)
    await toggleAgent($, act.slice(6))
    return
  }
  if (act === 'agents:collapse') {
    await collapseAgents($)
    return
  }
  if (act.startsWith('agents:expand:')) {
    let ids: unknown
    try {
      ids = JSON.parse(act.slice(14))
    } catch {
      ids = null
    }
    if (Array.isArray(ids)) await expandAgents($, ids.filter((x): x is string => typeof x === 'string'))
    return
  }
  if (act === 'up' || act === 'down') {
    await move($, act === 'up' ? -1 : 1)
    return
  }
  if (act === 'agents:all') {
    await toggleAllAgents($)
    return
  }
  if (act === 'agents:tree' || act === 'agents:workflows') {
    await setAgentsMode($, act === 'agents:tree' ? 'tree' : 'workflows')
    return
  }
  if (act.startsWith('filter:')) {
    const chip = act.slice(7)
    await setAgentFilter($, chip === 'next' ? 'next' : (chip as 'all'))
    return
  }
  if (act.startsWith('wf:')) {
    await toggleWorkflow($, act.slice(3))
    return
  }
  if (act === 'ack') {
    await ackAlerts($)
    return
  }
  if (act.startsWith('open:')) {
    // from the band: the pane on a tab, focused
    const tab = act.slice(5) as TelemetryUiTab
    if ((TABS as readonly string[]).includes(tab)) await setTab($, tab)
    await openPane($, true)
    return
  }
  if (act === 'refresh') {
    await collect.refreshContext(ioOf($), 'full')
  }
}

async function move($: EngineInterface, by: number): Promise<void> {
  if (last.tab === 'agents') await moveAgent($, last.agentIds, by)
  else await scrollTab($, last.tab, by, last.maxOffset)
}

/** Opens the pane: `focus`, the person asked (a command, a press), which also lifts a close they made by hand. */
async function openPane($: EngineInterface, focus: boolean): Promise<void> {
  if (focus) await clearPaneClosed($).catch(() => undefined)
  const opened = await $.ui.open(focus ? { id: PANE_ID, title: TITLE, focus: true } : { id: PANE_ID, title: TITLE })
  if (!opened.isPlaced) $.ui.log(`session-telemetry: pane waits (asked=${focus}): ${opened.reason}`, { to: 'debug' })
  // kept for `/telemetry where`
  try {
    await recordOpen($, { at: await $.clock.now(), asked: focus, isPlaced: opened.isPlaced, reason: opened.isPlaced ? null : opened.reason })
  } catch (err) {
    $.ui.log(`session-telemetry: open not recorded: ${why(err)}`, { to: 'debug' })
  }
}

/** `/telemetry where`: what the engine and the recorded state say about where the pane draws (NOTES.md, "Remote monitoring"). */
async function where($: EngineInterface): Promise<string> {
  const [surfaces, panes, clients, ui, now, s] = await Promise.all([
    $.session.surfaces().catch(() => null),
    $.ui.panes().catch(() => null),
    readClients($),
    readUi($),
    $.clock.now(),
    readInsights($).catch(() => null),
  ])
  return whereReport({ now, surfaces, panes, paneId: PANE_ID, clients, ui, cwd: s?.meta.cwd ?? null })
}

/**
 * The pane's part of `session.start` (one `session.start` hook per module, so
 * register.tsx calls this from its own): where the session draws first (for
 * the remote cadence), the `/telemetry` command, and the pane opened unasked
 * (placed only where the surface has room for a sidebar) unless the person
 * closed it by hand. `surface` is `session.start`'s; undefined records nothing.
 */
export async function startUi($: EngineInterface, surface?: string | null): Promise<void> {
  if (surface !== undefined) {
    try {
      await recordStart($, surface, await hostName($), await $.clock.now())
    } catch (err) {
      $.ui.log(`session-telemetry: start surface not recorded: ${why(err)}`, { to: 'debug' })
    }
  }
  try {
    await $.command.register({
      name: 'telemetry',
      description: 'Open the session telemetry pane (`full` also refreshes the context breakdown; `band auto|on|off|compact|full` sets the band above the prompt; `where` reports where the pane can draw)',
      argumentHint: '[full | where | band <mode>]',
    })
  } catch (err) {
    $.ui.log(`session-telemetry: /telemetry not registered: ${why(err)}`, { to: 'debug' })
  }
  let closed: number | undefined
  try {
    closed = (await readUi($)).paneClosedAt
  } catch {
    closed = undefined
  }
  if (closed !== undefined) {
    $.ui.log('session-telemetry: pane not opened unasked: the person closed it (/telemetry opens it)', { to: 'debug' })
    return
  }
  void openPane($, false).catch(err => $.ui.log(`session-telemetry: pane not opened: ${why(err)}`, { to: 'debug' }))
}

/** Whether the cache clock on the Overview tab wants a tick, and how often. */
function cacheTickMs(input: TabInput): number | null {
  if (input.ui.tab !== 'overview') return null
  const clock = deriveCacheClock(input.s, input.now)
  if (clock.status !== 'warm' && clock.status !== 'cooling') return null
  return clock.expiresInMs !== null && clock.expiresInMs <= 10 * 60_000 ? 1000 : 15_000
}

export function registerUi(on: On): void {
  // A remote client joined: recorded; a desktop or vscode client opens the pane
  // unasked and unfocused (a reconnect under the same id too), unless the person
  // closed it by hand. Observe only: the event passes on as it came.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    // kept for `/telemetry where` (before the open, so the two writes never race); a failure never holds back the open
    try {
      await noteAttachSeen($, String(e.surface), await $.clock.now())
    } catch (err) {
      $.ui.log(`session-telemetry: attach not counted: ${why(err)}`, { to: 'debug' })
    }
    try {
      await recordAttach($, e, await $.clock.now())
      const ui = await readUi($)
      if (shouldAutoOpen(String(e.surface), ui.paneClosedAt)) {
        void openPane($, false).catch(err => $.ui.log(`session-telemetry: pane not opened on attach: ${why(err)}`, { to: 'debug' }))
      }
    } catch (err) {
      $.ui.log(`session-telemetry: attach not recorded: ${why(err)}`, { to: 'debug' })
    }
    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    try {
      await recordDetach($, e, await $.clock.now())
    } catch (err) {
      $.ui.log(`session-telemetry: detach not recorded: ${why(err)}`, { to: 'debug' })
    }
    return result
  })

  // The person's own close (the close mark or key) is kept, so nothing reopens
  // the pane unasked; a plugin's close or an unload is not theirs.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin?.kind === 'person') {
      try {
        await markPaneClosed($, await $.clock.now())
      } catch (err) {
        $.ui.log(`session-telemetry: close not recorded: ${why(err)}`, { to: 'debug' })
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // A Remote Control prompt (a delivery from the bridge, then its submission
  // with origin `bridge`) says the session is driven remotely: the header's
  // `remote` chip. Noted once; the text is never read. Both pass on unchanged.
  on('session.receive', { origin: { kind: 'bridge' } }, async ($, e, next) => {
    await noteBridge($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'bridge') await noteBridge($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'telemetry' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'band') {
      const mode = args[1] ?? ''
      if (!isBandMode(mode)) return { text: 'Usage: /telemetry band auto|on|off|compact|full' }
      await setBandMode($, mode as TelemetryBandMode)
      $.ui.invalidate('ui.render')
      return { text: `Telemetry band: ${mode}.` }
    }
    if (args[0] === 'where') return { text: await where($) }
    await openPane($, true)
    if (args[0] === 'full') {
      void collect.refreshContext(ioOf($), 'full').catch(() => undefined)
      return { text: 'Telemetry pane opened; full context breakdown requested.' }
    }
    return { text: 'Telemetry pane opened.' }
  })

  // The pane's own lists move under the header; the engine's window stays put
  // (the tree is never taller than the body). A failure keeps the window too.
  on('ui.scroll', { requestId: PANE_ID }, async ($, e) => {
    if (e.by !== 0) await move($, e.by)
    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const [s, ui, now, clients] = await Promise.all([readInsights($), readUi($), $.clock.now(), readClients($)])
    const layout: Layout = layoutOf(e.props, e.viewport, e.surface)
    const remote = remoteChip(String(e.surface), clients, s.meta.cwd)
    const input: TabInput = { s, ui, now, layout, rules: collect.currentRules(), ...(remote !== null ? { remote } : {}) }
    const o = deriveOverview(s, now)
    const press = (act: string): void => {
      void onAct($, act).catch(() => undefined)
    }
    const typed = (value: string): void => {
      void setAgentQuery($, value).catch(() => undefined)
    }
    last.tab = ui.tab
    // the Live tab's ages go stale by the second even when nothing runs; the Overview's cache clock counts down while idle
    const remoteOnly = isRemoteOnly(String(e.surface), clients)
    const tickMs = paneTickMs({ live: isActive(s, now) || ui.tab === 'live', cacheMs: cacheTickMs(input), remoteOnly })
    if (tickMs !== null) armTick($, now, tickMs, remoteOnly)
    if (e.surface === 'terminal') {
      // the terminal: flex rows of monospace glyphs (hooks/ui/term/), one terminal row each
      const { Box, Text, Button, Input } = $.ui.resolve(e)
      const T: T3 = { Box, Text, Button, Input }
      const frame = termTree(T, input, o, press, typed)
      last.maxOffset = frame.maxOffset
      last.agentIds = ui.tab === 'agents' ? frame.agentIds : last.agentIds
      return frame.tree
    }
    // every other surface draws Svg: flex layout and graphics (hooks/ui/desktop/)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = els
    const T4: T4 = { Box, Text, Button, Svg, ...('Input' in els ? { Input: els.Input } : {}) }
    const frame = deskTree(T4, input, o, press, typed)
    last.maxOffset = frame.maxOffset
    last.agentIds = ui.tab === 'agents' ? frame.agentIds : last.agentIds
    return frame.tree
  })

  // The band above the prompt. Other mods' bands are drawn beneath it (the
  // engine's own placeholder is never nested); a survey, or the mode `off`,
  // yields the band entirely.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [s, ui, now, clients] = await Promise.all([readInsights($), readUi($), $.clock.now(), readClients($)])
    const mode = bandModeOf(ui)
    if (e.props.hasSurvey || mode === 'off') return next(e)
    const band = deriveBand(s, now, { rules: collect.currentRules() })
    const show = bandShow(mode, band, e.props.maxRows)
    if (show === 'hidden') return next(e)
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    // the band ticks only with the pane's own active tick: its cache chip shows seconds while one runs, minutes otherwise;
    // remote-only, it arms nothing (each redraw crosses the wire) and shows minutes
    const bandMs = bandTickMs({ active: band.isActive, remoteOnly: isRemoteOnly(String(e.surface), clients) })
    const precise = bandMs !== null
    if (bandMs !== null) armTick($, now, bandMs, false)
    const press = (act: string): void => {
      const target = act === 'band:open' ? `open:${bandTab(band)}` : act === 'band:context' ? 'open:context' : act
      void onAct($, target).catch(() => undefined)
    }
    const cols = Math.max(16, e.props.bodyColumns)
    const categories = s.context.breakdown?.categories ?? []
    const { Box } = $.ui.resolve(e)
    let tree
    if (e.surface === 'terminal') {
      const { Text, Button, Input } = $.ui.resolve(e)
      const T: T3 = { Box, Text, Button, Input }
      tree = termBand(T, band, { show, cols, maxRows: e.props.maxRows, precise, categories }, press).tree
    } else {
      const els = $.ui.resolve(e)
      const T: T4 = { Box, Text: els.Text, Button: els.Button, Svg: els.Svg, ...('Input' in els ? { Input: els.Input } : {}) }
      tree = deskBand(T, band, { show, cols, precise, categories }, press)
    }
    if (below === null) return tree
    return (
      <Box flexDirection="column">
        {tree}
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
