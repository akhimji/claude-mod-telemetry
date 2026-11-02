// session-telemetry: the desktop Context tab. The window's fill as a gauge
// with the refresh Button and the breakdown's age; headroom; the /context grid
// beside the category rows (stacked under 56 cells); the fill history as
// sparklines; compactions; memory files, MCP servers and the listings. Pure.
//
// Exports: deskContext(T, input, onAct)

import type { RenderElement } from 'claude-code'

import { deriveContext, deriveContextGrid, fmtPct, fmtTokens, fmtUsd } from '../../derive'
import { fillTone, fmtAgo, truncateMid } from '../../ui-kit'
import { BLOAT_FOOTNOTE, bloatName, bloatView, KIND_LABEL, lastUsedText, VERDICT_TONE } from '../insights-view'
import type { TabInput } from '../layout'
import { barSvg, categoryHex, gaugeSvg, gridSvg, PALETTE, sparkSvg, swatchSvg, toneHex, type GridCell } from '../svg'

import { cap, H, kv, num, row, section, svg, toneOf, truncateTo, txt, type DeskView, type Item, type T4 } from './kit'

/** The bloat audit's items: a table from 56 cells, two-line rows under. */
function bloatItems(T: T4, input: TabInput, onAct: (act: string) => void): Item[] {
  const { Box, Button, Text } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const v = bloatView(s, now)
  const items: Item[] = [{ el: section(T, 'bloat audit', v.isReady ? `${v.rows.length} rows · ${v.detail} ${v.age}` : ''), rows: H.section }]
  if (!v.isReady) {
    items.push({
      el: row(
        T,
        [
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {cap(T, v.reason)}
          </Box>,
          <Button key="bloat:refresh" label="run full breakdown" plain onPress={() => onAct('refresh')}>
            <Text size="caption" color="claude">
              run full breakdown
            </Text>
          </Button>,
        ],
        { pad: true },
      ),
      rows: H.row,
    })
    return items
  }
  items.push({ el: txt(T, v.summary, { weight: 'semibold', size: 'caption' }), rows: H.line })
  if (v.hint) items.push({ el: cap(T, v.hint), rows: H.line })
  const wide = cols >= 56
  const showLast = cols >= 72
  const showBar = cols >= 64
  const barW = 36
  const waste = (w: number | null): string => (w === null ? '–' : `≈${fmtUsd(w)}`)
  if (wide) {
    items.push({
      el: row(T, [
        <Box width={7} flexShrink={0} overflow="hidden">
          {cap(T, 'kind')}
        </Box>,
        <Box flexGrow={1} overflow="hidden">
          {cap(T, 'name')}
        </Box>,
        num(T, 'tok/req', 7, { size: 'caption', dimColor: true }),
        ...(showBar ? [<Box width={6} flexShrink={0} />] : []),
        num(T, 'calls', 5, { size: 'caption', dimColor: true }),
        ...(showLast ? [num(T, 'last used', 9, { size: 'caption', dimColor: true })] : []),
        num(T, 'waste', 8, { size: 'caption', dimColor: true }),
        num(T, 'verdict', 7, { size: 'caption', dimColor: true }),
      ]),
      rows: H.line,
    })
  }
  for (const r of v.rows.slice(0, 40)) {
    const tone = VERDICT_TONE[r.verdict]
    const verdict = txt(T, r.verdict, { size: 'caption', ...(tone ? { color: tone } : { dimColor: true }) })
    const name = `${bloatName(r)}${r.isDeferred ? ' (deferred)' : ''}`
    const bar = svg(T, barSvg(r.windowShare === null || v.maxShare <= 0 ? null : r.windowShare / v.maxShare, { width: barW, height: 5, color: tone ? toneHex(tone) : PALETTE.neutral }))
    if (wide) {
      items.push({
        el: row(
          T,
          [
            <Box width={7} flexShrink={0} overflow="hidden">
              {cap(T, KIND_LABEL[r.kind])}
            </Box>,
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              {txt(T, name, r.verdict === 'n/a' ? { dimColor: true } : {})}
            </Box>,
            num(T, `${r.isTokenEstimate ? '≈' : ''}${fmtTokens(r.tokensPerRequest)}`, 7, { size: 'caption' }),
            ...(showBar ? [<Box width={6} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" overflow="hidden">{bar}</Box>] : []),
            num(T, r.callsThisSession === null ? '–' : String(r.callsThisSession), 5, { size: 'caption', dimColor: r.callsThisSession === null }),
            ...(showLast ? [num(T, lastUsedText(r), 9, { size: 'caption', dimColor: true })] : []),
            num(T, waste(r.estCostUsd), 8, { size: 'caption', ...(r.estCostUsd !== null && r.estCostUsd > 0 ? {} : { dimColor: true }) }),
            <Box width={7} flexShrink={0} flexDirection="row" justifyContent="flex-end" overflow="hidden">
              {verdict}
            </Box>,
          ],
          { key: `bloat:${r.key}` },
        ),
        rows: H.line,
      })
    } else {
      items.push({
        el: (
          <Box flexDirection="column" overflow="hidden" key={`bloat:${r.key}`}>
            {row(T, [
              <Box width={7} flexShrink={0} overflow="hidden">
                {cap(T, KIND_LABEL[r.kind])}
              </Box>,
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                {txt(T, truncateTo(name, Math.max(8, cols - 18)))}
              </Box>,
              <Box width={7} flexShrink={0} flexDirection="row" justifyContent="flex-end" overflow="hidden">
                {verdict}
              </Box>,
            ])}
            {row(T, [<Box width={7} flexShrink={0} />, cap(T, `${r.isTokenEstimate ? '≈' : ''}${fmtTokens(r.tokensPerRequest)} tok/req · ${r.callsThisSession === null ? '– calls' : `${r.callsThisSession} calls`} · ${lastUsedText(r)} · waste ${waste(r.estCostUsd)}`, { tabular: true })])}
          </Box>
        ),
        rows: 2,
      })
    }
  }
  items.push({ el: cap(T, BLOAT_FOOTNOTE), rows: H.line })
  return items
}

const ago = (ms: number): string => {
  const a = fmtAgo(ms)
  return a === 'now' ? 'now' : `${a} ago`
}

export function deskContext(T: T4, input: TabInput, onAct: (act: string) => void): DeskView {
  const { Box, Button, Text } = T
  const { s, now, layout } = input
  const cols = layout.cols
  const c = deriveContext(s)
  const tone = fillTone(c.fill)
  const items: Item[] = []

  // the fill and the refresh control
  const head: Item[] = [
    {
      el: row(
        T,
        [
          row(T, [svg(T, gaugeSvg(c.fill, { size: 18, color: toneHex(tone) })), txt(T, c.fill === null ? '–' : fmtPct(c.fill), { weight: 'semibold', tabular: true, ...toneOf(tone) }), cap(T, `${fmtTokens(c.tokens)} / ${fmtTokens(c.window)}`, { tabular: true })]),
          <Button key="refresh" label="r refresh" plain hotkey="r" dimColor onPress={() => onAct('refresh')}>
            <Text>refresh</Text>
          </Button>,
        ],
        { justify: 'space-between', pad: true },
      ),
      rows: H.row,
    },
    {
      el: cap(T, c.breakdownAt === null ? 'no breakdown yet' : `${c.breakdownDetail ?? ''} breakdown · ${ago(now - c.breakdownAt)}${c.breakdownModel ? ` · ${c.breakdownModel}` : ''}${c.breakdownError ? ` · ${c.breakdownError}` : ''}`, c.breakdownError ? { color: 'error', dimColor: false } : {}),
      rows: H.line,
    },
  ]

  // headroom
  items.push({
    el: kv(
      T,
      'headroom',
      txt(T, `${fmtTokens(c.headroomTokens)}${c.tokensUntilAutoCompact === null ? '' : ` · autocompact in ${fmtTokens(c.tokensUntilAutoCompact)}`}${c.isAutoCompactEnabled === false ? ' · autocompact off' : ''}`, {
        tabular: true,
        ...toneOf(c.autoCompactThreshold && c.tokens !== null ? fillTone(c.tokens / c.autoCompactThreshold) : null),
      }),
    ),
    rows: H.line,
  })

  // the grid and the categories
  const cats = c.categories.filter(cat => cat.tokens > 0 || cat.kind === 'free')
  if (cats.length === 0) items.push({ el: cap(T, 'no breakdown yet: it arrives after the first turn, or press refresh'), rows: H.line })
  else {
    const max = s.context.breakdown?.maxTokens ?? c.window ?? 0
    // used categories take a slot each (the engine draws several of them grey); free and buffer stay neutral
    const colorOf = new Map<string, string>()
    let slot = 0
    for (const cat of cats) colorOf.set(cat.name, cat.kind === 'used' || cat.kind === 'deferred' ? categoryHex(cat.color, slot++) : categoryHex(cat.color))
    const cells: GridCell[] = deriveContextGrid(cats, max, 100).map(g => ({ color: colorOf.get(g.category) ?? categoryHex(g.color), kind: g.kind, fullness: g.fullness }))
    const grid = svg(T, gridSvg(cells, { side: 10, cell: 8, gap: 2 }))
    const table: RenderElement[] = cats.map(cat => {
      const muted = cat.kind === 'free' || cat.kind === 'deferred'
      return row(T, [
        svg(T, swatchSvg(cat.kind === 'free' ? PALETTE.track : colorOf.get(cat.name) ?? PALETTE.neutral, { alt: cat.name })),
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          {muted ? cap(T, cat.name) : txt(T, cat.name)}
        </Box>,
        num(T, fmtTokens(cat.tokens), 6, muted ? { dimColor: true } : {}),
        num(T, fmtPct(cat.fill), 5, { size: 'caption', dimColor: true }),
        ...(cols >= 80 ? [svg(T, barSvg(cat.kind === 'free' ? null : cat.fill, { width: 48, height: 5, color: colorOf.get(cat.name) }))] : []),
      ])
    })
    table.push(kv(T, 'used', txt(T, `${fmtTokens(c.usedTokens)} · ${fmtPct(max > 0 ? c.usedTokens / max : null)}`, { weight: 'semibold', tabular: true })))
    items.push({ el: section(T, 'window', `${cats.length} categories`), rows: H.section })
    if (cols >= 56) {
      items.push({
        el: (
          <Box flexDirection="row" gap="md" alignItems="flex-start" overflow="hidden">
            <Box flexShrink={0}>{grid}</Box>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {table}
            </Box>
          </Box>
        ),
        rows: Math.max(H.grid, table.length),
      })
    } else {
      items.push({ el: <Box paddingY="xs">{grid}</Box>, rows: H.grid })
      for (const t of table) items.push({ el: t, rows: H.line })
    }
  }

  // the bloat audit: what each request carries and whether anything calls it
  items.push(...bloatItems(T, input, onAct))

  // history
  const sw = Math.max(48, Math.min(160, (cols - 24) * 4))
  items.push({ el: section(T, 'history', `${c.history.length} pts`), rows: H.section })
  if (c.sparkline.length === 0) items.push({ el: cap(T, 'no turns measured yet'), rows: H.line })
  else {
    const lastFill = c.sparklineFill[c.sparklineFill.length - 1] ?? null
    const color = toneHex(fillTone(lastFill))
    items.push({ el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, 'tokens')}</Box>, svg(T, sparkSvg(c.sparkline, { width: sw, height: 18, color })), cap(T, `peak ${fmtTokens(Math.max(...c.sparkline))}`, { tabular: true })]), rows: H.spark })
    items.push({ el: row(T, [<Box flexGrow={1} overflow="hidden">{cap(T, 'fill')}</Box>, svg(T, sparkSvg(c.sparklineFill, { width: sw, height: 18, color, max: 1 })), cap(T, `now ${fmtPct(lastFill)}`, { tabular: true })]), rows: H.spark })
  }

  // compactions
  items.push({ el: section(T, 'compactions', `${c.compactions.length}`), rows: H.section })
  if (c.compactions.length === 0) items.push({ el: cap(T, 'none'), rows: H.line })
  for (const k of c.compactions.slice(0, 10)) {
    items.push({
      el: kv(T, `${fmtAgo(now - k.at)} ago · ${k.trigger}${k.agentId !== 'main' ? ` · ${k.agentId}` : ''}`, txt(T, k.skipped ? `skipped: ${k.skipped}` : `${fmtTokens(k.tokensBefore)} → ${fmtTokens(k.tokensAfter)}${k.costUsd === null ? '' : ` · ${fmtUsd(k.costUsd)}`}`, { tabular: true, ...(k.skipped ? { color: 'warning' } : {}) })),
      rows: H.line,
    })
  }

  // what the window holds
  const pathW = Math.max(12, cols - 14)
  if (c.memoryFiles.length > 0) {
    items.push({ el: section(T, 'memory files', `${c.memoryFiles.length}`), rows: H.section })
    for (const f of c.memoryFiles.slice(0, 8)) items.push({ el: kv(T, `${truncateMid(f.path.split(/[\\/]+/).filter(Boolean).slice(-3).join('/'), pathW)} · ${f.type}`, fmtTokens(f.tokens)), rows: H.line })
  }
  if (c.mcpServers.length > 0) {
    items.push({ el: section(T, 'mcp servers', `${c.mcpServers.length}`), rows: H.section })
    for (const m of c.mcpServers.slice(0, 12)) items.push({ el: kv(T, `${truncateMid(m.server, 24)} · ${m.loadedTools}/${m.tools} tools`, fmtTokens(m.tokens)), rows: H.line })
  }
  const extras: RenderElement[] = []
  if (c.skills) extras.push(kv(T, `skills · ${c.skills.included}/${c.skills.total} listed`, `${fmtTokens(c.skills.tokens)} tok`))
  if (c.slashCommands) extras.push(kv(T, `commands · ${c.slashCommands.included}/${c.slashCommands.total} listed`, `${fmtTokens(c.slashCommands.tokens)} tok`))
  if (c.customAgents.length > 0) extras.push(kv(T, `agents · ${c.customAgents.length} types`, `${fmtTokens(c.customAgents.reduce((n, a) => n + a.tokens, 0))} tok`))
  if (c.deferredTokens > 0) extras.push(kv(T, 'deferred · outside the window', `${fmtTokens(c.deferredTokens)} tok`))
  if (extras.length > 0) {
    items.push({ el: section(T, 'listings'), rows: H.section })
    for (const e of extras) items.push({ el: e, rows: H.line })
  }
  return { head, items }
}
