// session-telemetry: tab 4, Context. The window's fill and the refresh control
// (always shown), the /context-style grid beside the category table (stacked
// under 64 cells), headroom before autocompact, the fill history, compactions,
// and what the window holds: memory files, MCP servers, skills and commands.
//
// Exports: contextTab(input), GRID_SIDE

import { deriveContext, deriveContextGrid, fmtPct, fmtTokens, fmtUsd, type TelemetryGridCell } from '../derive'
import { ACCENT, btn, cells, cpLen, dim, fillTone, fitColumns, fmtAgo, joinH, seg, sparkSegs, truncate, truncateMid, type Column, type Line, type Seg } from '../ui-kit'

import { card, empty, kv, LABEL_W, NARROW, section, shareBar, tableHead, toned } from './common'
import { fillGroup } from './header'
import { BLOAT_FOOTNOTE, bloatName, bloatView, KIND_LABEL, lastUsedText, VERDICT_TONE } from './insights-view'
import { rowsOf, type TabInput, type TabView } from './layout'

const BLOAT_COLUMNS: Column[] = [
  { id: 'kind', head: 'kind', w: 7, prio: 7 },
  { id: 'name', head: 'name', w: 'flex', min: 10, prio: 10 },
  { id: 'tok', head: 'tok/req', w: 7, align: 'r', prio: 9 },
  { id: 'bar', head: '', w: 8, prio: 4 },
  { id: 'calls', head: 'calls', w: 5, align: 'r', prio: 8 },
  { id: 'last', head: 'last used', w: 9, align: 'r', prio: 5 },
  { id: 'waste', head: 'waste', w: 8, align: 'r', prio: 9 },
  { id: 'verdict', head: 'verdict', w: 7, align: 'r', prio: 8 },
]

/** The bloat audit's lines: a column table from NARROW cells, cards under. */
function bloatLines(input: TabInput, cols: number): Line[] {
  const { s, now } = input
  const v = bloatView(s, now)
  const out: Line[] = [[], section('bloat audit', cols, v.isReady ? `${v.rows.length} rows · ${v.detail} ${v.age}` : '')]
  if (!v.isReady) {
    out.push([dim(v.reason)], [btn('bloat:refresh', 'refresh', [seg('run full breakdown', { c: ACCENT })])])
    return out
  }
  out.push([seg(v.summary, { bold: true })])
  if (v.hint) out.push([dim(v.hint)])
  const waste = (w: number | null): string => (w === null ? '–' : `≈${fmtUsd(w)}`)
  const rows = v.rows.slice(0, 40)
  if (cols >= NARROW) {
    const cf = fitColumns(BLOAT_COLUMNS, cols)
    const barW = cf.find(c => c.id === 'bar')?.width ?? 8
    out.push(cells(cf, tableHead(cf)))
    for (const r of rows) {
      const tone = VERDICT_TONE[r.verdict]
      out.push(
        cells(cf, {
          kind: dim(KIND_LABEL[r.kind]),
          name: seg(`${bloatName(r)}${r.isDeferred ? ' (deferred)' : ''}`, r.verdict === 'n/a' ? { dim: true } : {}),
          tok: seg(`${r.isTokenEstimate ? '≈' : ''}${fmtTokens(r.tokensPerRequest)}`),
          bar: shareBar(r.windowShare === null || v.maxShare <= 0 ? null : r.windowShare / v.maxShare, barW, tone ?? 'inactive'),
          calls: r.callsThisSession === null ? dim('–') : seg(String(r.callsThisSession)),
          last: dim(lastUsedText(r)),
          waste: r.estCostUsd !== null && r.estCostUsd > 0 ? seg(waste(r.estCostUsd)) : dim(waste(r.estCostUsd)),
          verdict: toned(r.verdict, tone, tone ? {} : { dim: true }),
        }),
      )
    }
  } else {
    for (const r of rows) {
      const tone = VERDICT_TONE[r.verdict]
      out.push(
        ...card(
          cols,
          dim('·'),
          [dim(`${KIND_LABEL[r.kind]} `), seg(truncate(bloatName(r), Math.max(6, cols - 24)), { bold: true })],
          [toned(r.verdict, tone, tone ? {} : { dim: true })],
          [[seg(`${r.isTokenEstimate ? '≈' : ''}${fmtTokens(r.tokensPerRequest)}`), dim(' tok/req')], [seg(r.callsThisSession === null ? '–' : String(r.callsThisSession)), dim(' calls')], [dim(lastUsedText(r))], [dim('waste '), seg(waste(r.estCostUsd))]],
        ),
      )
    }
  }
  out.push([dim(BLOAT_FOOTNOTE)])
  return out
}

/** The grid is GRID_SIDE x GRID_SIDE squares, two cells each. */
export const GRID_SIDE = 10

const CAT_COLUMNS: Column[] = [
  { id: 'key', head: ' ', w: 1, prio: 9 },
  { id: 'name', head: 'category', w: 'flex', min: 10, prio: 10 },
  { id: 'tokens', head: 'tokens', w: 7, align: 'r', prio: 9 },
  { id: 'pct', head: 'share', w: 5, align: 'r', prio: 8 },
  { id: 'bar', head: '', w: 10, prio: 5 },
]

function cellGlyph(c: TelemetryGridCell): Seg {
  if (c.kind === 'free') return dim('· ')
  if (c.kind === 'buffer') return seg('▫ ', { c: c.color })
  return seg(c.fullness >= 0.7 ? '■ ' : '▪ ', { c: c.color })
}

function shortPath(path: string, width: number): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return truncateMid(parts.slice(-3).join('/'), width)
}

const ago = (ms: number): string => {
  const a = fmtAgo(ms)
  return a === 'now' ? 'now' : `${a} ago`
}

export function contextTab(input: TabInput): TabView {
  const { s, now, layout } = input
  const cols = layout.cols
  const c = deriveContext(s)
  const sep = dim(' · ')
  const fillW = Math.max(8, Math.min(40, cols - 40))
  const hk = layout.hkPrefix

  const head: Line[] = [
    [...fillGroup(c.fill, fillW, 'window'), dim(`  ${fmtTokens(c.tokens)} / ${fmtTokens(c.window)}`)],
    [
      btn('refresh', 'refresh', [...(hk ? [] : [dim('r ')]), seg('refresh full breakdown')], 'r', hk ? undefined : 0),
      dim(
        c.breakdownAt === null
          ? '  no breakdown yet'
          : `  ${c.breakdownDetail ?? ''} · ${ago(now - c.breakdownAt)}${c.breakdownModel ? ` · ${c.breakdownModel}` : ''}`,
      ),
      ...(c.breakdownError ? [seg(`  ${c.breakdownError}`, { c: 'error' })] : []),
    ],
  ]

  const list: Line[] = []
  // headroom
  list.push(
    kv(
      'headroom',
      seg(fmtTokens(c.headroomTokens)),
      ...(c.tokensUntilAutoCompact === null
        ? []
        : [sep, dim('autocompact in '), toned(fmtTokens(c.tokensUntilAutoCompact), c.autoCompactThreshold && c.tokens !== null ? fillTone(c.tokens / c.autoCompactThreshold) : null), dim(` (at ${fmtTokens(c.autoCompactThreshold)})`)]),
      ...(c.isAutoCompactEnabled === false ? [sep, seg('autocompact off', { c: 'warning' })] : []),
    ),
  )

  // grid + categories
  const cats = c.categories.filter(cat => cat.tokens > 0 || cat.kind === 'free')
  if (cats.length === 0) {
    list.push([], empty('no breakdown yet: it arrives after the first turn, or press r'))
  } else {
    const max = s.context.breakdown?.maxTokens ?? c.window ?? 0
    const grid = deriveContextGrid(cats, max, GRID_SIDE * GRID_SIDE)
    const gridLines: Line[] = []
    for (let r = 0; r < GRID_SIDE; r += 1) gridLines.push(grid.slice(r * GRID_SIDE, (r + 1) * GRID_SIDE).map(cellGlyph))
    const side = cols >= 64
    const tableW = side ? cols - GRID_SIDE * 2 - 2 : cols
    const cf = fitColumns(cols < NARROW ? CAT_COLUMNS.filter(col => col.id !== 'bar') : CAT_COLUMNS, tableW)
    const barW = cf.find(col => col.id === 'bar')?.width ?? 10
    const table: Line[] = [cells(cf, tableHead(cf))]
    for (const cat of cats) {
      const muted = cat.kind === 'free' || cat.kind === 'deferred'
      table.push(
        cells(cf, {
          key: cat.kind === 'free' ? dim('·') : seg(cat.kind === 'buffer' ? '▫' : '■', { c: cat.color }),
          name: muted ? dim(cat.name) : seg(cat.name),
          tokens: muted ? dim(fmtTokens(cat.tokens)) : seg(fmtTokens(cat.tokens)),
          pct: dim(fmtPct(cat.fill)),
          bar: cat.kind === 'free' ? [dim(' ')] : shareBar(cat.fill, barW, cat.color),
        }),
      )
    }
    table.push(cells(cf, { name: dim('used'), tokens: seg(fmtTokens(c.usedTokens), { bold: true }), pct: dim(fmtPct(max > 0 ? c.usedTokens / max : null)) }))
    list.push([])
    if (side) list.push(...joinH(gridLines, GRID_SIDE * 2, table, 2))
    else list.push(...gridLines, [], ...table)
  }

  // the bloat audit
  list.push(...bloatLines(input, cols))

  // history
  const sw = Math.max(8, cols - LABEL_W - 24)
  list.push([], section('history', cols, `${c.history.length} pts`))
  if (c.sparkline.length === 0) list.push(empty('no turns measured yet'))
  else {
    const lastFill = c.sparklineFill[c.sparklineFill.length - 1] ?? null
    const tone = fillTone(lastFill) ?? ACCENT
    list.push(kv('tokens', ...sparkSegs(c.sparkline, sw, tone), dim(`  peak ${fmtTokens(Math.max(...c.sparkline))}`)))
    list.push(kv('fill', ...sparkSegs(c.sparklineFill, sw, tone), dim(`  now ${fmtPct(lastFill)}`)))
  }

  // compactions
  list.push([], section('compactions', cols, `${c.compactions.length}`))
  if (c.compactions.length === 0) list.push(empty('none'))
  for (const k of c.compactions.slice(0, 10)) {
    list.push(
      kv(
        fmtAgo(now - k.at),
        seg(k.trigger.padEnd(8)),
        k.skipped ? seg(`skipped: ${k.skipped}`, { c: 'warning' }) : seg(`${fmtTokens(k.tokensBefore)} → ${fmtTokens(k.tokensAfter)}`),
        ...(k.costUsd === null ? [] : [sep, seg(fmtUsd(k.costUsd))]),
        ...(k.agentId !== 'main' ? [sep, dim(k.agentId)] : []),
      ),
    )
  }

  // what the window holds
  const pathW = Math.max(10, cols - LABEL_W - 10)
  if (c.memoryFiles.length > 0) {
    list.push([], section('memory files', cols, `${c.memoryFiles.length}`))
    for (const f of c.memoryFiles.slice(0, 8)) list.push([seg(fmtTokens(f.tokens).padStart(7)), dim('  '), seg(shortPath(f.path, pathW)), dim(` ${f.type}`)])
  }
  if (c.mcpServers.length > 0) {
    list.push([], section('mcp servers', cols, `${c.mcpServers.length}`))
    const nameW = Math.max(10, Math.min(28, ...c.mcpServers.map(m => cpLen(m.server))))
    for (const m of c.mcpServers.slice(0, 12)) list.push([seg(fmtTokens(m.tokens).padStart(7)), dim('  '), seg(truncateMid(m.server, nameW).padEnd(nameW)), dim(`  ${m.loadedTools}/${m.tools} tools loaded`)])
  }
  const extras: Line[] = []
  if (c.skills) extras.push(kv('skills', seg(`${c.skills.included}/${c.skills.total}`), dim(' listed · '), seg(fmtTokens(c.skills.tokens)), dim(' tok')))
  if (c.slashCommands) extras.push(kv('commands', seg(`${c.slashCommands.included}/${c.slashCommands.total}`), dim(' listed · '), seg(fmtTokens(c.slashCommands.tokens)), dim(' tok')))
  if (c.customAgents.length > 0) extras.push(kv('agents', seg(String(c.customAgents.length)), dim(' types · '), seg(fmtTokens(c.customAgents.reduce((n, a) => n + a.tokens, 0))), dim(' tok')))
  if (c.deferredTokens > 0) extras.push(kv('deferred', seg(fmtTokens(c.deferredTokens)), dim(' tok outside the window')))
  if (extras.length > 0) list.push([], section('listings', cols), ...extras)
  return { head, items: rowsOf(list) }
}
