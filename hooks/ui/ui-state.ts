// session-telemetry: the pane's own `$.state` value (selected tab, selected agent,
// per-tab scroll). Like state.ts, the reference is written as a literal here and
// every read and write of it lives in this file; callers import these by name.
//
// Exports:
//   UI                                the atom (`read($, UI)` only inside this file)
//   UI_INITIAL, TABS
//   readUi($), setTab($, tab), selectAgent($, id), moveAgent($, ids, by),
//   scrollTab($, tab, by, max), toggleAllAgents($), setBandMode($, mode),
//   setAgentsMode($, mode), setAgentFilter($, chip | 'next'), setAgentQuery($, q),
//   toggleWorkflow($, id), toggleAgent($, id), collapseAgents($), expandAgents($, ids),
//   markPaneClosed($, now), clearPaneClosed($), recordOpen($, open), noteAttachSeen($, surface, now)
//                                     reads and writes (handlers only, never while drawing)
//   CLIENTS                           the remote clients' atom (`clients`, TelemetryClients)
//   readClients($), recordAttach($, e, now), recordDetach($, e, now),
//   recordStart($, surface, host, now), recordBridge($, host, now)
//                                     its read (subscribes a drawing) and writes (hooks only)
//   BAND_MODES, AGENT_CHIPS, isBandMode, bandModeOf
//   stepAgent(ids, current, by), stepScroll(current, by, max), toggledIds(open, id),
//   EXPANDED_AGENTS_MAX               the pure halves

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TelemetryAgentFilterChip, TelemetryAgentsMode, TelemetryBandMode, TelemetryClients, TelemetryPaneOpen, TelemetryUi, TelemetryUiTab } from '../../types'

import { attachClient, CLIENTS_INITIAL, clientsOrEmpty, detachClient, markBridge, startClients } from '../clients'
import { SHAPE } from '../model'

export const TABS: readonly TelemetryUiTab[] = ['agents', 'overview', 'tokens', 'context', 'tools', 'flow', 'live']

export const BAND_MODES: readonly TelemetryBandMode[] = ['auto', 'on', 'off', 'compact', 'full']

export const AGENT_CHIPS: readonly TelemetryAgentFilterChip[] = ['all', 'running', 'done', 'failed', 'stale']

export const UI_INITIAL: TelemetryUi = { tab: 'agents', agentId: null, scroll: {} }

export const UI = atom({ plugin: 'session-telemetry', key: 'ui' } as const, UI_INITIAL, { shape: SHAPE })

const isTab = (v: unknown): v is TelemetryUiTab => typeof v === 'string' && (TABS as readonly string[]).includes(v)
export const isBandMode = (v: unknown): v is TelemetryBandMode => typeof v === 'string' && (BAND_MODES as readonly string[]).includes(v)
const isChip = (v: unknown): v is TelemetryAgentFilterChip => typeof v === 'string' && (AGENT_CHIPS as readonly string[]).includes(v)

/** A stored value made safe to draw from (an older or foreign shape reads as the initial). */
function clean(u: TelemetryUi | null | undefined): TelemetryUi {
  if (!u || typeof u !== 'object') return UI_INITIAL
  const out: TelemetryUi = {
    tab: isTab(u.tab) ? u.tab : 'agents',
    agentId: typeof u.agentId === 'string' ? u.agentId : null,
    scroll: u.scroll && typeof u.scroll === 'object' ? u.scroll : {},
    showAllAgents: u.showAllAgents === true,
  }
  if (isBandMode(u.band) && u.band !== 'auto') out.band = u.band
  if (u.agentsMode === 'workflows') out.agentsMode = 'workflows'
  if (isChip(u.agentFilter) && u.agentFilter !== 'all') out.agentFilter = u.agentFilter
  if (typeof u.agentQuery === 'string' && u.agentQuery !== '') out.agentQuery = u.agentQuery.slice(0, 80)
  if (Array.isArray(u.expandedWorkflows)) out.expandedWorkflows = u.expandedWorkflows.filter((x): x is string => typeof x === 'string').slice(0, 50)
  if (Array.isArray(u.expandedAgents)) {
    const open = [...new Set(u.expandedAgents.filter((x): x is string => typeof x === 'string'))].slice(-EXPANDED_AGENTS_MAX)
    if (open.length > 0) out.expandedAgents = open
  }
  if (typeof u.paneClosedAt === 'number' && Number.isFinite(u.paneClosedAt)) out.paneClosedAt = u.paneClosedAt
  const lo = u.lastOpen
  if (lo && typeof lo === 'object' && typeof lo.at === 'number' && typeof lo.isPlaced === 'boolean') {
    out.lastOpen = { at: lo.at, asked: lo.asked === true, isPlaced: lo.isPlaced, reason: typeof lo.reason === 'string' ? lo.reason.slice(0, 200) : null }
  }
  const as = u.attachSeen
  if (as && typeof as === 'object' && typeof as.count === 'number' && typeof as.lastSurface === 'string' && typeof as.lastAt === 'number') {
    out.attachSeen = { count: as.count, lastSurface: as.lastSurface.slice(0, 40), lastAt: as.lastAt }
  }
  return out
}

/** `/telemetry where`: the pane's latest `$.ui.open` and its answer. */
export function recordOpen($: EngineInterface, open: TelemetryPaneOpen): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), lastOpen: open }))
}

/** `/telemetry where`: one more `session.attach` seen, on `surface`. */
export function noteAttachSeen($: EngineInterface, surface: string, now: number): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    return { ...c, attachSeen: { count: (c.attachSeen?.count ?? 0) + 1, lastSurface: surface.slice(0, 40), lastAt: now } }
  })
}

/** The person closed the pane by hand: nothing opens it unasked until they open it again. */
export function markPaneClosed($: EngineInterface, now: number): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), paneClosedAt: now }))
}

/** The person opened the pane (`/telemetry`, the band's title): unasked opens are allowed again. */
export function clearPaneClosed($: EngineInterface): Promise<unknown> {
  return update($, UI, u => {
    const { paneClosedAt: _drop, ...rest } = clean(u)
    return rest
  })
}

// ── The remote clients (`clients`; the pure reducers are in ../clients.ts) ──

export const CLIENTS = atom({ plugin: 'session-telemetry', key: 'clients' } as const, CLIENTS_INITIAL, { shape: SHAPE })

/** The clients and where the session draws; inside `ui.render` it subscribes the drawing. */
export async function readClients($: EngineInterface): Promise<TelemetryClients> {
  return clientsOrEmpty(await read($, CLIENTS))
}

/** `session.attach`: the client joins (or rejoins) the roster. */
export function recordAttach($: EngineInterface, e: { surface: string; clientId: string; viewport?: { columns?: unknown; rows?: unknown; isFullscreen?: unknown } }, now: number): Promise<TelemetryClients> {
  return update($, CLIENTS, c => attachClient(c, e, now))
}

/** `session.detach`: the client leaves the roster. */
export function recordDetach($: EngineInterface, e: { surface: string; clientId: string; reason: 'detach' | 'end' }, now: number): Promise<TelemetryClients> {
  return update($, CLIENTS, c => detachClient(c, e, now))
}

/** `session.start`: where the session draws first, and the machine's name when known. */
export function recordStart($: EngineInterface, surface: string | null, host: string | null, now: number): Promise<TelemetryClients> {
  return update($, CLIENTS, c => startClients(c, surface, host, now))
}

/** A prompt arrived over the Remote Control bridge. */
export function recordBridge($: EngineInterface, host: string | null, now: number): Promise<TelemetryClients> {
  return update($, CLIENTS, c => markBridge(c, host, now))
}

/** The band's mode (`auto` when none is stored). */
export const bandModeOf = (u: Pick<TelemetryUi, 'band'>): TelemetryBandMode => u.band ?? 'auto'

/** `/telemetry band <mode>`: how the band above the prompt shows. */
export function setBandMode($: EngineInterface, band: TelemetryBandMode): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    if (band === 'auto') {
      const { band: _drop, ...rest } = c
      return rest
    }
    return { ...c, band }
  })
}

/** Agents: the spawn tree or the workflow cards. */
export function setAgentsMode($: EngineInterface, mode: TelemetryAgentsMode): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), agentsMode: mode }))
}

/** Agents: the filter chip (`next` steps to the chip after the one in force, wrapping). */
export function setAgentFilter($: EngineInterface, chip: TelemetryAgentFilterChip | 'next'): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    const now = c.agentFilter ?? 'all'
    const to = chip === 'next' ? (AGENT_CHIPS[(AGENT_CHIPS.indexOf(now) + 1) % AGENT_CHIPS.length] ?? 'all') : chip
    return { ...c, agentFilter: to }
  })
}

/** Agents: the search text (cut at 80 characters). */
export function setAgentQuery($: EngineInterface, query: string): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), agentQuery: query.slice(0, 80) }))
}

/** Agents, workflows mode: opens or closes one card. */
export function toggleWorkflow($: EngineInterface, id: string): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    const open = c.expandedWorkflows ?? []
    return { ...c, expandedWorkflows: open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-50) }
  })
}

/** At most this many agent drawers are remembered open (the oldest opened goes first). */
export const EXPANDED_AGENTS_MAX = 100

/** `open` with `id` added (at the end) or, when it is there, taken out. */
export function toggledIds(open: readonly string[], id: string): string[] {
  return open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-EXPANDED_AGENTS_MAX)
}

/** Agents: a click (or Enter) on a row's name opens its drawer, or closes it when open; the row takes the focus either way. */
export function toggleAgent($: EngineInterface, id: string): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    const open = toggledIds(c.expandedAgents ?? [], id)
    const { expandedAgents: _drop, ...rest } = c
    return { ...rest, agentId: id, ...(open.length > 0 ? { expandedAgents: open } : {}) }
  })
}

/** Agents: closes every drawer (the focus stays). */
export function collapseAgents($: EngineInterface): Promise<unknown> {
  return update($, UI, u => {
    const { expandedAgents: _drop, ...rest } = clean(u)
    return rest
  })
}

/** Agents: opens the drawers of `ids` (the running rows as drawn), keeping those already open. */
export function expandAgents($: EngineInterface, ids: readonly string[]): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    const open = [...(c.expandedAgents ?? [])]
    for (const id of ids) if (typeof id === 'string' && !open.includes(id)) open.push(id)
    return { ...c, ...(open.length > 0 ? { expandedAgents: open.slice(-EXPANDED_AGENTS_MAX) } : {}) }
  })
}

/** Agents: show every finished agent, or back to the most recent few. */
export function toggleAllAgents($: EngineInterface): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    return { ...c, showAllAgents: !c.showAllAgents }
  })
}

/** The pane's view state; inside `ui.render` it subscribes the drawing. */
export async function readUi($: EngineInterface): Promise<TelemetryUi> {
  return clean(await read($, UI))
}

export function setTab($: EngineInterface, tab: TelemetryUiTab): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), tab }))
}

export function selectAgent($: EngineInterface, agentId: string): Promise<unknown> {
  return update($, UI, u => ({ ...clean(u), agentId }))
}

/** Moves the selection `by` rows through `ids` (the rows as last drawn). */
export function moveAgent($: EngineInterface, ids: readonly string[], by: number): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    return { ...c, agentId: stepAgent(ids, c.agentId, by) }
  })
}

/** Scrolls one tab's list `by` rows, kept within 0..max. */
export function scrollTab($: EngineInterface, tab: TelemetryUiTab, by: number, max: number): Promise<unknown> {
  return update($, UI, u => {
    const c = clean(u)
    return { ...c, scroll: { ...c.scroll, [tab]: stepScroll(c.scroll[tab] ?? 0, by, max) } }
  })
}

/** The id `by` rows from `current` in `ids` (clamped at the ends); `current` unknown counts as row 0. */
export function stepAgent(ids: readonly string[], current: string | null, by: number): string | null {
  if (ids.length === 0) return current
  const at = current === null ? 0 : Math.max(0, ids.indexOf(current))
  const to = Math.min(ids.length - 1, Math.max(0, at + Math.trunc(by)))
  return ids[to] ?? current
}

/** `current + by` within 0..max (max unknown: no upper bound). */
export function stepScroll(current: number, by: number, max: number | null): number {
  const next = Math.max(0, Math.trunc(current) + Math.trunc(by))
  return max === null ? next : Math.min(Math.max(0, max), next)
}
