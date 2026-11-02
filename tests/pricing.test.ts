// Pure tests of hooks/pricing.ts: model-id matching and per-request cost.

import { describe, expect, test } from 'claude-code/testing'

import { canonicalModel, costOf, findPricing, modelLabel, normalizeModelId, PRICING } from '../hooks/pricing'

const close = (actual: number, wanted: number, label: string): void => {
  expect(Math.abs(actual - wanted) < 1e-9, `${label}: ${actual} != ${wanted}`).toBe(true)
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('normalizeModelId', () => {
  test('folds provider spellings', () => {
    expect(normalizeModelId('us.anthropic.claude-opus-5-5-v1:0')).toBe('claude-opus-5-5')
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5-20251101')
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModelId('Claude Opus 4.5')).toBe('claude-opus-4-5')
    expect(normalizeModelId('global.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5-20250929')
  })
})

describe('findPricing', () => {
  test('matches the most specific row', () => {
    const cases: [string, string][] = [
      ['claude-fable-5-1', 'claude-fable-5-1'],
      ['claude-fable-5', 'claude-fable-5'],
      ['claude-mythos-5-1', 'claude-mythos-5-1'],
      ['claude-opus-5-5', 'claude-opus-5-5'],
      ['claude-opus-5', 'claude-opus-5'],
      ['claude-opus-5-20260301', 'claude-opus-5'],
      ['claude-opus-4-8', 'claude-opus-4-8'],
      ['claude-opus-4-7', 'claude-opus-4-7'],
      ['claude-opus-4-6', 'claude-opus-4-6'],
      ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
      ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
      ['claude-opus-4-20250514', 'claude-opus-4-0'],
      ['claude-opus-4-0', 'claude-opus-4-0'],
      ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
      ['claude-sonnet-5', 'claude-sonnet-5'],
      ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
      ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
      ['claude-sonnet-4-20250514', 'claude-sonnet-4-0'],
      ['claude-haiku-5-5', 'claude-haiku-5-5'],
      ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
      ['claude-3-5-haiku-20241022', 'claude-3-5-haiku'],
      ['us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5'],
      ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ]
    for (const [id, row] of cases) {
      const found = findPricing(id)
      expect(found.entry.id, id).toBe(row)
      expect(found.match, id).toBe('exact')
    }
  })

  test('falls back to the family, then to the default row', () => {
    expect(findPricing('claude-opus-9').match).toBe('family')
    expect(findPricing('claude-opus-9').entry.id).toBe('claude-opus-5-5')
    expect(findPricing('claude-3-haiku-20240307').entry.id).toBe('claude-haiku-5-5')
    expect(findPricing('claude-3-haiku-20240307').match).toBe('family')
    expect(findPricing('<synthetic>').match).toBe('default')
    expect(findPricing('gpt-x').entry.id).toBe('claude-opus-5-5')
  })

  test('every row has positive rates and a pattern', () => {
    for (const entry of PRICING) {
      expect(entry.patterns.length > 0, entry.id).toBe(true)
      for (const value of Object.values(entry.rates)) expect(value > 0, entry.id).toBe(true)
      // each row's own id matches itself
      expect(findPricing(entry.id).entry.id, entry.id).toBe(entry.id)
    }
  })

  test('labels and canonical ids', () => {
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Claude Opus 5.5')
    expect(modelLabel('mystery-model')).toBe('mystery-model')
    expect(canonicalModel('us.anthropic.claude-opus-5-5-v1:0')).toBe(canonicalModel('claude-opus-5-5'))
    expect(canonicalModel('claude-opus-5-5') === canonicalModel('claude-opus-5')).toBe(false)
  })
})

describe('costOf', () => {
  test('Opus 5.5 at list price', () => {
    const c = costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, 'claude-opus-5-5')
    close(c.inputUsd, 4, 'input')
    close(c.outputUsd, 20, 'output')
    close(c.cacheReadUsd, 0.2, 'cache read')
    close(c.cacheWriteUsd, 5, 'cache write 5m')
    close(c.usd, 29.2, 'total')
    // savings: reads 1M * (4 - 0.2) - writes 1M * (5 - 4) = 3.8 - 1 = 2.8
    close(c.cacheSavedUsd, 2.8, 'saved')
    expect(c.pricing).toBe('exact')
  })

  test('cache-read multipliers differ per model', () => {
    const read = { ...zero, cacheRead: 1_000_000 }
    close(costOf(read, 'claude-fable-5-1').usd, 0.25, 'fable 5.1')
    close(costOf(read, 'claude-fable-5').usd, 1, 'fable 5')
    close(costOf(read, 'claude-sonnet-5-5').usd, 0.1, 'sonnet 5.5')
    close(costOf(read, 'claude-sonnet-5').usd, 0.2, 'sonnet 5')
    close(costOf(read, 'claude-haiku-4-5').usd, 0.1, 'haiku 4.5')
  })

  test('1h cache writes', () => {
    const write = { ...zero, cacheWrite: 1_000_000 }
    close(costOf(write, 'claude-opus-5-5', '1h').usd, 8, 'opus 5.5 1h')
    close(costOf(write, 'claude-opus-4-1', '1h').usd, 30, 'opus 4.1 1h')
    close(costOf(write, 'claude-opus-4-1').usd, 18.75, 'opus 4.1 5m')
  })

  test('Haiku 5.5 is priced by prompt size, per request', () => {
    const small = costOf({ input: 50_000, output: 1_000_000, cacheRead: 50_000, cacheWrite: 0 }, 'claude-haiku-5-5')
    close(small.outputUsd, 0.5, 'output at the low tier')
    const big = costOf({ input: 50_000, output: 1_000_000, cacheRead: 50_001, cacheWrite: 0 }, 'claude-haiku-5-5')
    close(big.outputUsd, 2.5, 'output over 100K prompt')
    close(big.inputUsd, 0.025, 'input over 100K prompt')
  })

  test('zero usage costs nothing', () => {
    const c = costOf(zero, 'claude-fable-5-1')
    expect(c.usd).toBe(0)
    expect(c.cacheSavedUsd).toBe(0)
  })
})
