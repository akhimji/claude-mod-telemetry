import { describe, expect, test } from 'claude-code/testing'

import {
  bar,
  barParts,
  btn,
  cells,
  clampOffset,
  cpLen,
  dim,
  driftTone,
  fillTone,
  fitColumns,
  fitGroups,
  fitLine,
  fmtAgo,
  fmtResetIn,
  isShellTool,
  joinH,
  lineText,
  lineWidth,
  padLeft,
  padLine,
  padRight,
  rateTone,
  seg,
  shortLabel,
  spark,
  stack,
  truncate,
  windowAround,
  type Column,
} from '../hooks/ui-kit'
import { stepAgent, stepScroll } from '../hooks/ui/ui-state'

describe('text', () => {
  test('truncate and pad count code points and keep the width', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello world', 5)).toBe('hell…')
    expect(truncate('hello', 1)).toBe('…')
    expect(truncate('hello', 0)).toBe('')
    expect(truncate('██████', 3)).toBe('██…')
    expect(padRight('ab', 4)).toBe('ab  ')
    expect(padLeft('ab', 4)).toBe('  ab')
    expect(padLeft('abcdef', 4)).toBe('abc…')
    expect(cpLen('▕█▌·')).toBe(4)
  })
})

describe('bars', () => {
  test('a bar is exactly its width, eighths at the edge', () => {
    for (const w of [0, 1, 5, 10, 33]) for (const f of [0, 0.01, 0.33, 0.5, 0.999, 1]) expect(cpLen(bar(f, w))).toBe(w)
    expect(bar(0.5, 4)).toBe('██  ')
    expect(bar(1, 3)).toBe('███')
    expect(bar(0, 3)).toBe('   ')
    expect(bar(0.5, 1)).toBe('▌')
    expect(bar(0.125, 1)).toBe('▏')
    expect(barParts(0.25, 2)).toEqual({ fill: '▌', rest: 1 })
  })
  test('out-of-range and missing fractions clamp', () => {
    expect(bar(2, 3)).toBe('███')
    expect(bar(-1, 3)).toBe('   ')
    expect(bar(null, 3)).toBe('   ')
    expect(bar(Number.NaN, 3)).toBe('   ')
  })
  test('sparklines scale from zero to the max and keep the newest values', () => {
    expect(spark([], 10)).toBe('')
    expect(spark([1, 2, 3], 0)).toBe('')
    expect(spark([0, 0, 0], 5)).toBe('▁▁▁')
    expect(spark([5, 5], 5)).toBe('██')
    expect(spark([0, 4, 8], 3)).toBe('▁▅█')
    expect(cpLen(spark(Array.from({ length: 50 }, (_, i) => i), 12))).toBe(12)
    expect(spark([1, 2, 3, 100], 2)).toBe('▁█')
    expect(spark([Number.NaN, -3, 4], 3)).toBe('▁▁█')
  })
  test('a stacked bar splits its width by largest remainder', () => {
    expect(stack([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10)
    expect(stack([3, 1], 8)).toEqual([6, 2])
    expect(stack([0, 0], 8)).toEqual([0, 0])
    expect(stack([1, 0, 1], 5)).toEqual([3, 0, 2])
    expect(stack([5], 0)).toEqual([0])
  })
})

describe('tables', () => {
  const COLS: Column[] = [
    { id: 'name', head: 'name', w: 'flex', min: 6, prio: 10 },
    { id: 'a', head: 'a', w: 5, align: 'r', prio: 2 },
    { id: 'b', head: 'b', w: 5, align: 'r', prio: 5 },
    { id: 'c', head: 'c', w: 5, align: 'r', prio: 2 },
  ]
  test('columns drop lowest priority first (rightmost on a tie), the flex one fills', () => {
    const wide = fitColumns(COLS, 40)
    expect(wide.map(c => c.id)).toEqual(['name', 'a', 'b', 'c'])
    expect(wide.reduce((n, c) => n + c.width, 0) + 3).toBe(40)
    expect(fitColumns(COLS, 18).map(c => c.id)).toEqual(['name', 'a', 'b'])
    expect(fitColumns(COLS, 12).map(c => c.id)).toEqual(['name', 'b'])
    expect(fitColumns(COLS, 3).map(c => c.id)).toEqual(['name'])
  })
  test('a row pads and aligns each cell to its column', () => {
    const fit = fitColumns(COLS, 25)
    const row = cells(fit, { name: seg('x'), a: seg('1'), b: [seg('██', { c: 'claude' }), dim('·')] })
    expect(lineText(row).startsWith('x      ')).toBe(true)
    expect(lineText(row)).toContain('    1 ██·  ')
    expect(lineWidth(row)).toBe(25)
  })
})

describe('lines', () => {
  test('fitLine cuts text, drops a hotkey Button that does not fit, cuts a row Button', () => {
    const line = [seg('abc'), btn('k', 'act', [seg('press')], 'r')]
    expect(lineText(fitLine(line, 20))).toBe('abcr: press')
    expect(lineText(fitLine(line, 6))).toBe('abc')
    expect(lineWidth(fitLine([seg('abcdef')], 4))).toBe(4)
    const row = [btn('row', 'act', [seg('a long row label')])]
    expect(lineText(fitLine(row, 6))).toBe('a lon…')
  })
  test('padLine and joinH line blocks up', () => {
    expect(lineWidth(padLine([seg('ab')], 6))).toBe(6)
    const joined = joinH([[seg('L1')], [seg('L2')]], 4, [[seg('R1')]], 1)
    expect(joined.map(lineText)).toEqual(['L1   R1', 'L2  '])
  })
  test('fitGroups drops the least important group until the rest fit', () => {
    const groups = [
      { prio: 10, segs: [seg('model')] },
      { prio: 2, segs: [seg('uptime')] },
      { prio: 8, segs: [seg('cost')] },
    ]
    expect(lineText(fitGroups(groups, 40))).toBe('model  uptime  cost')
    expect(lineText(fitGroups(groups, 14))).toBe('model  cost')
    expect(lineText(fitGroups(groups, 3))).toBe('mo…')
  })
})

describe('windows', () => {
  test('offsets clamp to the list', () => {
    expect(clampOffset(5, 10, 4)).toBe(5)
    expect(clampOffset(9, 10, 4)).toBe(6)
    expect(clampOffset(-2, 10, 4)).toBe(0)
    expect(clampOffset(3, 2, 4)).toBe(0)
  })
  test('the window follows a selected row', () => {
    expect(windowAround(0, 10, 4, 0)).toBe(0)
    expect(windowAround(5, 10, 4, 0)).toBe(2)
    expect(windowAround(1, 10, 4, 3)).toBe(1)
    expect(windowAround(9, 10, 4, 0)).toBe(6)
    expect(windowAround(3, 10, 0, 0)).toBe(0)
  })
  test('selection and scroll steps stay in range', () => {
    expect(stepAgent(['main', 'a', 'b'], null, 1)).toBe('a')
    expect(stepAgent(['main', 'a', 'b'], 'b', 5)).toBe('b')
    expect(stepAgent(['main', 'a', 'b'], 'a', -9)).toBe('main')
    expect(stepAgent(['main', 'a'], 'gone', 1)).toBe('a')
    expect(stepAgent([], 'x', 1)).toBe('x')
    expect(stepScroll(0, -3, 10)).toBe(0)
    expect(stepScroll(8, 5, 10)).toBe(10)
    expect(stepScroll(8, 5, null)).toBe(13)
  })
})

describe('tones and labels', () => {
  test('fill thresholds are 70 and 90 percent', () => {
    expect(fillTone(0.69)).toBe('success')
    expect(fillTone(0.7)).toBe('warning')
    expect(fillTone(0.9)).toBe('error')
    expect(fillTone(null)).toBeNull()
    expect(rateTone(0)).toBe('success')
    expect(rateTone(0.05)).toBe('warning')
    expect(rateTone(0.2)).toBe('error')
    expect(driftTone(0.01)).toBeNull()
    expect(driftTone(-0.1)).toBe('warning')
    expect(driftTone(0.3)).toBe('error')
  })
  test('ages and reset times', () => {
    expect(fmtAgo(500)).toBe('now')
    expect(fmtAgo(42_000)).toBe('42s')
    expect(fmtAgo(3_700_000)).toBe('1h')
    expect(fmtResetIn(null, 0, String)).toBeNull()
    expect(fmtResetIn(new Date(60_000).toISOString(), 0, ms => `${ms}`)).toBe('60000')
    expect(fmtResetIn(new Date(0).toISOString(), 1000, String)).toBeNull()
    expect(fmtResetIn('not a date', 0, String)).toBeNull()
  })
  test('labels never show a shell command; URLs lose their query; paths keep their tail', () => {
    expect(isShellTool('Bash')).toBe(true)
    expect(shortLabel('Bash', 'export TOKEN=abc && deploy', 40)).toBe('')
    expect(shortLabel('PowerShell', '$env:KEY="x"', 40)).toBe('')
    expect(shortLabel('WebFetch', 'https://user:pw@example.com/a/b?token=abc#x', 40)).toBe('example.com/a/b')
    expect(shortLabel('Read', '/Users/me/project/src/file.ts', 40)).toBe('src/file.ts')
    expect(shortLabel('Grep', 'needle   in\nhay', 40)).toBe('needle in hay')
    expect(shortLabel('advisor', 'anything', 40, true)).toBe('')
    expect(cpLen(shortLabel('Grep', 'x'.repeat(100), 10))).toBe(10)
  })
})
