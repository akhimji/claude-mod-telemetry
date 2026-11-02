// session-telemetry: the remote clients. Pure: the reducers of the `clients`
// state value (TelemetryClients, kept by hooks/ui/ui-state.ts), what the UI
// reads of it, and the rules the pane follows for a remote viewer (when to open
// itself, whether every drawing surface is remote, the header's `remote` chip).
//
// A remote client (the desktop app, a phone, an editor) joins the roster with
// `session.attach` and leaves with `session.detach`; the terminal's binding
// raises neither, so the REPL is known from `session.start`'s `surface`.
//
// Exports: CLIENTS_INITIAL, CLIENTS_MAX, AUTO_OPEN_SURFACES, clientsOrEmpty,
//          attachClient, detachClient, startClients, markBridge,
//          deriveClients, TelemetryClientsView, isRemoteOnly, shouldAutoOpen,
//          remoteChip, hostOf, whereReport

import type { TelemetryClient, TelemetryClients, TelemetryUi } from '../types'

/** At most this many clients are remembered; the oldest detached go first, then the oldest. */
export const CLIENTS_MAX = 20

/** The surfaces a pane opens itself on when they attach: the ones that dock a pane beside the transcript. */
export const AUTO_OPEN_SURFACES: readonly string[] = ['desktop', 'vscode']

export const CLIENTS_INITIAL: TelemetryClients = { schema: 1, clients: [], updatedAt: 0 }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A stored value made safe to read (an older or foreign shape reads as empty). */
export function clientsOrEmpty(v: TelemetryClients | null | undefined): TelemetryClients {
  if (!v || typeof v !== 'object' || !Array.isArray(v.clients)) return CLIENTS_INITIAL
  const clients = v.clients.filter(
    (c): c is TelemetryClient => !!c && typeof c === 'object' && typeof c.clientId === 'string' && typeof c.surface === 'string' && num(c.attachedAt) !== null,
  )
  const out: TelemetryClients = { schema: 1, clients, updatedAt: num(v.updatedAt) ?? 0 }
  if (v.startSurface === null || typeof v.startSurface === 'string') out.startSurface = v.startSurface
  if (num(v.bridgeSeenAt) !== null) out.bridgeSeenAt = v.bridgeSeenAt ?? null
  if (typeof v.host === 'string' && v.host !== '') out.host = v.host
  return out
}

/** The list kept within CLIENTS_MAX: the oldest detached are dropped first, then the oldest attached. */
function bounded(list: TelemetryClient[]): TelemetryClient[] {
  const out = [...list]
  while (out.length > CLIENTS_MAX) {
    const gone = out.findIndex(c => c.detachedAt !== null)
    out.splice(gone >= 0 ? gone : 0, 1)
  }
  return out
}

type ViewportIn = { columns?: unknown; rows?: unknown; isFullscreen?: unknown } | undefined

function viewportOf(v: ViewportIn): TelemetryClient['viewport'] {
  const columns = num(v?.columns)
  const rows = num(v?.rows)
  if (columns === null || rows === null) return null
  return typeof v?.isFullscreen === 'boolean' ? { columns, rows, isFullscreen: v.isFullscreen } : { columns, rows }
}

/**
 * A client attached: a new one is added at the end; one already known (a
 * reconnect under the same id) is moved to the end, attached again, its count
 * of attaches raised.
 */
export function attachClient(prev: TelemetryClients | null | undefined, e: { surface: string; clientId: string; viewport?: ViewportIn }, now: number): TelemetryClients {
  const c = clientsOrEmpty(prev)
  const known = c.clients.find(x => x.clientId === e.clientId)
  const next: TelemetryClient = {
    surface: String(e.surface),
    clientId: e.clientId,
    attachedAt: now,
    lastSeen: now,
    detachedAt: null,
    detachReason: null,
    attaches: (known?.attaches ?? 0) + 1,
    viewport: viewportOf(e.viewport) ?? known?.viewport ?? null,
  }
  return { ...c, clients: bounded([...c.clients.filter(x => x.clientId !== e.clientId), next]), updatedAt: now }
}

/** A client left the roster (it detached, or the session ended under it); an id never seen attach is recorded as one that left. */
export function detachClient(prev: TelemetryClients | null | undefined, e: { surface: string; clientId: string; reason: 'detach' | 'end' }, now: number): TelemetryClients {
  const c = clientsOrEmpty(prev)
  const known = c.clients.find(x => x.clientId === e.clientId)
  const left: TelemetryClient = known
    ? { ...known, lastSeen: now, detachedAt: now, detachReason: e.reason }
    : { surface: String(e.surface), clientId: e.clientId, attachedAt: now, lastSeen: now, detachedAt: now, detachReason: e.reason, attaches: 0, viewport: null }
  return { ...c, clients: bounded(known ? c.clients.map(x => (x.clientId === e.clientId ? left : x)) : [...c.clients, left]), updatedAt: now }
}

/** `session.start` (every load and reload): where the session draws first, and the machine's name when known. */
export function startClients(prev: TelemetryClients | null | undefined, surface: string | null, host: string | null, now: number): TelemetryClients {
  const c = clientsOrEmpty(prev)
  const out: TelemetryClients = { ...c, startSurface: surface, updatedAt: now }
  if (host !== null && host !== '') out.host = host
  return out
}

/** A prompt arrived over the Remote Control bridge: kept once (the first); the host refreshed when known. */
export function markBridge(prev: TelemetryClients | null | undefined, host: string | null, now: number): TelemetryClients {
  const c = clientsOrEmpty(prev)
  const out: TelemetryClients = { ...c, bridgeSeenAt: c.bridgeSeenAt ?? now, updatedAt: now }
  if (host !== null && host !== '') out.host = host
  return out
}

export type TelemetryClientsView = {
  /** The clients attached now, in the order they attached. */
  attached: TelemetryClient[]
  /** The ones that left, newest departure first. */
  detached: TelemetryClient[]
  /** Attached clients on a surface other than the terminal. */
  remoteAttached: number
  /** Re-attaches under a known id, summed over every client. */
  reconnects: number
  /** The latest attach, or null. */
  lastAttachAt: number | null
  /** How long ago each attached client last attached, by id (ms; null for a time in the future). */
  ageMs: Record<string, number | null>
  startSurface: string | null | undefined
  isBridged: boolean
  host: string | null
}

/** The clients as the UI reads them. */
export function deriveClients(v: TelemetryClients | null | undefined, now: number): TelemetryClientsView {
  const c = clientsOrEmpty(v)
  const attached = c.clients.filter(x => x.detachedAt === null)
  const detached = c.clients.filter(x => x.detachedAt !== null).sort((a, b) => (b.detachedAt ?? 0) - (a.detachedAt ?? 0))
  const ageMs: Record<string, number | null> = {}
  for (const x of attached) ageMs[x.clientId] = now >= x.attachedAt ? now - x.attachedAt : null
  return {
    attached,
    detached,
    remoteAttached: attached.filter(x => x.surface !== 'terminal').length,
    reconnects: c.clients.reduce((n, x) => n + Math.max(0, x.attaches - 1), 0),
    lastAttachAt: c.clients.reduce<number | null>((m, x) => (m === null || x.attachedAt > m ? x.attachedAt : m), null),
    ageMs,
    startSurface: c.startSurface,
    isBridged: typeof c.bridgeSeenAt === 'number',
    host: c.host ?? null,
  }
}

/**
 * Whether every surface the pane can draw on is remote: this drawing's surface
 * is not the terminal, and the session has no terminal binding (its
 * `session.start` named another surface, or none). Unknown (no start seen,
 * as in a test that never starts a session) reads as false, so the terminal's
 * behaviour is what an unknown case gets.
 */
export function isRemoteOnly(renderSurface: string, v: TelemetryClients | null | undefined): boolean {
  if (renderSurface === 'terminal') return false
  const c = clientsOrEmpty(v)
  if (c.startSurface === undefined) return false
  return c.startSurface !== 'terminal'
}

/** Whether a client attaching on `surface` opens the pane unasked: a docking surface, and the person has not closed the pane. */
export function shouldAutoOpen(surface: string, paneClosedAt: number | undefined): boolean {
  return AUTO_OPEN_SURFACES.includes(surface) && paneClosedAt === undefined
}

/** The machine's name for the chip: the first label of `HOSTNAME` (`mbp.local` → `mbp`), else null. */
export function hostOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t === '') return null
  const first = t.split('.')[0] ?? t
  return first.replace(/[^\w.-]/g, '').slice(0, 40) || null
}

/**
 * The header's chip, `remote · <machine>`, when the drawing surface is not the
 * terminal and a Remote Control prompt was seen; the machine is the host when
 * known, else the working directory's last part. Null otherwise: a remote
 * session is never presumed.
 */
export function remoteChip(renderSurface: string, v: TelemetryClients | null | undefined, cwd: string | null | undefined): string | null {
  if (renderSurface === 'terminal') return null
  const c = clientsOrEmpty(v)
  if (typeof c.bridgeSeenAt !== 'number') return null
  const host = hostOf(c.host)
  const base = typeof cwd === 'string' ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : ''
  const where = host ?? (base !== '' ? base.slice(0, 40) : null)
  return where === null ? 'remote' : `remote · ${where}`
}

/** One pane as `$.ui.panes()` lists it (UiPane's fields). */
export type WherePane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

const at = (t: number | null | undefined, now: number): string => {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '-'
  const ago = now - t
  return `${new Date(t).toISOString()} (${ago >= 0 ? `${Math.round(ago / 1000)}s ago` : 'future'})`
}

/**
 * `/telemetry where`: plain text, what the engine and the recorded state say
 * about where the pane can draw. Never prompt text, paths (only the cwd's last
 * part) nor env values beyond the chip's host. `surfaces`/`panes` null: the call failed.
 */
export function whereReport(input: {
  now: number
  surfaces: readonly string[] | null
  panes: readonly WherePane[] | null
  paneId: string
  clients: TelemetryClients | null | undefined
  ui: Pick<TelemetryUi, 'paneClosedAt' | 'lastOpen' | 'attachSeen'>
  cwd?: string | null
}): string {
  const { now, ui } = input
  const v = deriveClients(input.clients, now)
  const base = typeof input.cwd === 'string' ? (input.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : ''
  const lines: string[] = ['Telemetry where:']
  lines.push(`cwd folder: ${base !== '' ? base.slice(0, 40) : '-'}; host: ${hostOf(v.host) ?? '-'}`)
  lines.push(`surfaces(): ${input.surfaces === null ? 'unavailable' : input.surfaces.length === 0 ? '(none)' : input.surfaces.join(', ')}`)
  const own = input.panes === null ? null : input.panes.filter(p => p.id === input.paneId)
  if (own === null) lines.push('panes(): unavailable')
  else if (own.length === 0) lines.push('panes(): (none for this plugin)')
  else for (const p of own) lines.push(`pane ${p.id} "${p.title}": isPlaced=${p.isPlaced} isShown=${p.isShown} isFocused=${p.isFocused}`)
  lines.push(`start surface: ${v.startSurface === undefined ? '(no start seen)' : String(v.startSurface)}; remote-only (desktop): ${isRemoteOnly('desktop', input.clients)}; bridge seen: ${v.isBridged}`)
  const all = [...v.attached, ...v.detached]
  if (all.length === 0) lines.push('clients: (none)')
  else for (const c of all) lines.push(`client ${c.clientId} [${c.surface}]: attached ${at(c.attachedAt, now)}; detached ${c.detachedAt === null ? '-' : `${at(c.detachedAt, now)} (${c.detachReason ?? '?'})`}; attaches ${c.attaches}`)
  lines.push(`paneClosedAt: ${ui.paneClosedAt === undefined ? 'never' : at(ui.paneClosedAt, now)}`)
  const lo = ui.lastOpen
  lines.push(lo === undefined ? 'last open: (none recorded)' : `last open: ${at(lo.at, now)} asked=${lo.asked} isPlaced=${lo.isPlaced}${lo.isPlaced ? '' : ` reason="${lo.reason ?? ''}"`}`)
  const as = ui.attachSeen
  lines.push(as === undefined ? 'session.attach seen: 0' : `session.attach seen: ${as.count} (last ${as.lastSurface} at ${at(as.lastAt, now)})`)
  return lines.join('\n')
}
