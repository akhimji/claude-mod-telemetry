// The pure SVG builders (hooks/ui/svg.ts): every spec is well-formed markup of
// the stated size with an alt and a bounded source; the geometry is right at the
// edges (empty, null, NaN, over 1); the palette maps theme keys to fixed hues.

import { describe, expect, test } from 'claude-code/testing'

import { barSvg, categoryHex, dotSvg, gaugeSvg, gridSvg, guideSvg, lanesSvg, PALETTE, sparkSvg, stackSvg, swatchSvg, toneHex, type SvgSpec } from '../hooks/ui/svg'

function wellFormed(spec: SvgSpec): void {
  expect(spec.source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(spec.source.endsWith('</svg>')).toBe(true)
  expect(spec.source.length).toBeLessThanOrEqual(131072)
  expect(spec.source).toContain(`width="${spec.width}"`)
  expect(spec.source).toContain(`height="${spec.height}"`)
  expect(spec.alt.length).toBeGreaterThan(0)
  // no text, no script, no event handler reaches the markup
  expect(spec.source).not.toMatch(/<text|<script|on[a-z]+=/i)
  // every opened tag closes
  const opened = (spec.source.match(/<(rect|circle|polyline|path|g)(?:\s[^>]*?)?(?<!\/)>/g) ?? []).length
  const closed = (spec.source.match(/<\/(rect|circle|polyline|path|g)>/g) ?? []).length
  expect(opened).toBe(closed)
}

const rects = (source: string): { x: number; w: number; fill: string }[] =>
  [...source.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" rx="[\d.]+" fill="([^"]+)"\/>/g)].map(m => ({ x: Number(m[1]), w: Number(m[2]), fill: m[3] ?? '' }))

describe('bars', () => {
  test('a bar is its width, the fill clamped to 0..1 and never thinner than its height', () => {
    for (const f of [null, undefined, Number.NaN, -1, 0, 0.004, 0.5, 1, 7]) {
      const spec = barSvg(f, { width: 40, height: 6 })
      wellFormed(spec)
      expect([spec.width, spec.height]).toEqual([40, 6])
      const r = rects(spec.source)
      expect(r[0]).toMatchObject({ x: 0, w: 40, fill: PALETTE.track })
      const fill = r[1]
      if (f === null || f === undefined || Number.isNaN(f) || f <= 0) expect(fill).toBeUndefined()
      else expect(fill?.w).toBe(Math.max(6, Math.min(1, f) * 40))
    }
    expect(barSvg(0.5).alt).toBe('50% bar')
    expect(barSvg(null).alt).toBe('unknown bar')
    expect(barSvg(0.5, { color: '#123456' }).source).toContain('#123456')
  })

  test('a stacked bar shares its width by part with 2px gaps, skipping zero parts', () => {
    const spec = stackSvg([1, 1, 0, 2], { width: 100, height: 8, labels: ['a', 'b', 'c', 'd'] })
    wellFormed(spec)
    const r = rects(spec.source)
    expect(r.map(x => x.w)).toEqual([24, 24, 48])
    expect(r.map(x => x.x)).toEqual([0, 26, 52])
    expect(r.map(x => x.fill)).toEqual([PALETTE.mix[0], PALETTE.mix[1], PALETTE.mix[3]])
    expect(spec.alt).toBe('a 25%, b 25%, d 50%')
    // a sliver is drawn a dot wide (the bar's height), the rest giving up the difference
    const sliver = stackSvg([1, 999], { width: 102, height: 8 })
    expect(rects(sliver.source).map(x => x.w)).toEqual([8, 92])
    const empty = stackSvg([0, 0, Number.NaN], { width: 50 })
    wellFormed(empty)
    expect(rects(empty.source)).toHaveLength(1)
    expect(empty.alt).toBe('empty')
  })
})

describe('lines and dots', () => {
  test('a sparkline draws the history as a line and the last value as a dot', () => {
    const spec = sparkSvg([1, 2, 3, 0, 5], { width: 60, height: 20 })
    wellFormed(spec)
    expect(spec.source).toContain('<polyline')
    expect((spec.source.match(/<circle/g) ?? []).length).toBe(1)
    expect(spec.alt).toBe('5 values, last 5, max 5')
    // the max value sits at the top, zero on the floor, the last at the right edge
    expect(spec.source).toContain('cx="58"')
    const points = /points="([^"]+)"/.exec(spec.source)?.[1]?.split(' ') ?? []
    expect(points).toHaveLength(5)
    expect(points[3]?.split(',')[1]).toBe('18')
    const one = sparkSvg([3], { width: 60 })
    wellFormed(one)
    expect(one.source).not.toContain('<polyline')
    expect((one.source.match(/<circle/g) ?? []).length).toBe(1)
    const none = sparkSvg([], { width: 60 })
    wellFormed(none)
    expect(none.alt).toBe('no values')
    // more values than fit: only the tail is drawn
    expect(sparkSvg(Array.from({ length: 200 }, (_, i) => i), { width: 44 }).alt).toMatch(/^11 values/)
    // a fixed max keeps the scale
    expect(sparkSvg([0.5], { width: 20, height: 20, max: 1 }).source).toContain('cy="10"')
  })

  test('a gauge is a track ring and an arc of the fraction', () => {
    const full = gaugeSvg(1, { size: 20, stroke: 4 })
    wellFormed(full)
    expect((full.source.match(/<circle/g) ?? []).length).toBe(2)
    expect(full.alt).toBe('100% full')
    const none = gaugeSvg(null, { size: 20 })
    wellFormed(none)
    expect((none.source.match(/<circle/g) ?? []).length).toBe(1)
    expect(none.alt).toBe('unknown full')
    const half = gaugeSvg(0.5, { size: 20, stroke: 4 })
    const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(half.source)
    expect(Math.abs(Number(dash?.[1]) - Number(dash?.[2]) / 2)).toBeLessThan(0.05)
  })

  test('a swatch is one rounded square of its colour', () => {
    const sw = swatchSvg('#3b7dd8', { alt: 'Messages' })
    wellFormed(sw)
    expect([sw.width, sw.height, sw.alt]).toEqual([8, 8, 'Messages'])
    expect(rects(sw.source)).toEqual([{ x: 0, w: 8, fill: '#3b7dd8' }])
    expect(swatchSvg('#000', { size: 2 }).width).toBe(4)
  })

  test('status dots differ by shape and fill', () => {
    const running = dotSvg('running')
    wellFormed(running)
    expect(running.source).toContain(PALETTE.accent)
    expect((running.source.match(/<circle/g) ?? []).length).toBe(2)
    expect(dotSvg('done').source).toContain(PALETTE.good)
    expect(dotSvg('error').source).toContain(PALETTE.danger)
    expect(dotSvg('stopped').source).toContain(`<rect`)
    expect(dotSvg('stopped').source).toContain(PALETTE.warning)
    expect(dotSvg('idle').source).toContain('fill="none"')
    for (const s of ['running', 'done', 'error', 'stopped', 'idle'] as const) {
      const d = dotSvg(s, { size: 12 })
      wellFormed(d)
      expect(d.alt).toBe(s)
      expect([d.width, d.height]).toEqual([12, 12])
    }
  })
})

describe('lanes, grid and guides', () => {
  test('lanes light each agent from its start to its end, clipped to the window, the running ones to now', () => {
    const spec = lanesSvg(
      [
        { start: 0, end: 50, status: 'done' },
        { start: 50, end: null, status: 'running' },
        { start: -100, end: 25, status: 'error' },
        { start: 10, end: 10, status: 'done' },
      ],
      { width: 100, from: 0, to: 100, laneHeight: 4, gap: 2 },
    )
    wellFormed(spec)
    expect(spec.height).toBe(4 * 4 + 3 * 2)
    const r = rects(spec.source)
    // a track and a lit part per lane
    expect(r).toHaveLength(8)
    expect(r[1]).toMatchObject({ x: 0, w: 50, fill: PALETTE.neutral })
    expect(r[3]).toMatchObject({ x: 50, w: 50, fill: PALETTE.accent })
    expect(r[5]).toMatchObject({ x: 0, w: 25, fill: PALETTE.danger })
    // an instant: a dot of the lane's height
    expect(r[7]?.w).toBe(4)
    expect(spec.alt).toBe('4 agent lanes, 1 running')
    const none = lanesSvg([], { width: 50, from: 0, to: 1 })
    wellFormed(none)
    expect(none.height).toBe(4)
  })

  test('the grid draws side x side squares: used in their colour, buffer hatched, free as the track', () => {
    const cells = [
      ...Array.from({ length: 5 }, () => ({ color: '#3b7dd8', kind: 'used' as const, fullness: 1 })),
      { color: '#3b7dd8', kind: 'used' as const, fullness: 0.5 },
      { color: '#808080', kind: 'buffer' as const, fullness: 1 },
    ]
    const spec = gridSvg(cells, { side: 3, cell: 8, gap: 2 })
    wellFormed(spec)
    expect([spec.width, spec.height]).toEqual([28, 28])
    expect((spec.source.match(/fill="#3b7dd8"/g) ?? []).length).toBe(6)
    expect(spec.source).toContain('fill-opacity="0.73"')
    expect(spec.source).toContain('stroke-dasharray')
    expect((spec.source.match(new RegExp(PALETTE.track.replace(/[()]/g, '\\$&'), 'g')) ?? []).length).toBe(2)
    expect(spec.alt).toBe('context grid: 6 of 9 squares used')
    expect(gridSvg([], { side: 10 }).alt).toBe('context grid: 0 of 100 squares used')
  })

  test('a tree guide is a hairline and an elbow; the last child stops at the elbow', () => {
    const mid = guideSvg({ width: 12, height: 16 })
    wellFormed(mid)
    expect(mid.source).toContain('M3 0 V16 M3 8 H11')
    expect(guideSvg({ width: 12, height: 16, isLast: true }).source).toContain('M3 0 V8 M3 8 H11')
  })
})

describe('palette', () => {
  test('tones and theme keys map to the fixed hues; unknown keys take the categorical slot', () => {
    expect(toneHex('success')).toBe(PALETTE.good)
    expect(toneHex('warning')).toBe(PALETTE.warning)
    expect(toneHex('error')).toBe(PALETTE.danger)
    expect(toneHex(null)).toBe(PALETTE.accent)
    expect(categoryHex('claude')).toBe(PALETTE.accent)
    expect(categoryHex('permission')).toBe(PALETTE.categories[0])
    expect(categoryHex('cyan_FOR_SUBAGENTS_ONLY')).toBe(PALETTE.categories[2])
    expect(categoryHex('purple_FOR_SUBAGENTS_ONLY')).toBe(PALETTE.categories[4])
    expect(categoryHex('warning')).toBe(PALETTE.warning)
    expect(categoryHex('inactive')).toBe(PALETTE.neutral)
    expect(categoryHex('promptBorder')).toBe(PALETTE.neutral)
    expect(categoryHex('inactive', 1)).toBe(PALETTE.categories[1])
    expect(categoryHex('somethingElse', 3)).toBe(PALETTE.categories[3])
    expect(categoryHex('somethingElse', 9)).toBe(PALETTE.neutral)
    // every hex is a mid-tone: it reads on a light and a dark surface alike (checked with the dataviz validator)
    for (const hex of [PALETTE.accent, PALETTE.good, PALETTE.warning, PALETTE.danger, PALETTE.neutral, ...PALETTE.categories]) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
  })
})
