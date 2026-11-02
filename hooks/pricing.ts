// session-telemetry: model pricing. Pure (no `$`), unit-tested in tests/pricing.test.ts.
//
// Exports:
//   PRICING                 the table, USD per million tokens, most specific row first
//   PRICING_SOURCE          where and when the table was taken
//   DEFAULT_PRICING_ID      the row an unrecognised model is priced at
//   normalizeModelId(id)    lowercased, provider prefixes/suffixes stripped, dots as dashes
//   findPricing(id)         { entry, match } for a model id ('exact' | 'family' | 'default')
//   ratesFor(entry, prompt) the rates one request pays (Haiku 5.5 is priced by prompt size)
//   costOf(counts, id, ttl) a CostBreakdown for one request's token counts
//   modelLabel(id)          display name of the row a model id matches
//   canonicalModel(id)      the row id a model id matches (for comparing spellings)
//
// Rates are Anthropic first-party list prices (platform.claude.com pricing page,
// fetched 2026-10-25). Not modelled, because no event reports them: fast mode,
// `inference_geo: "us"` (1.1x), Batch discounts, partner-platform pricing, and
// managed `modelPricing` overrides. The engine's own ledger (session.measure's
// `cost.usd`) does include them; derive.ts reports the drift between the two.

import type { TelemetryPricingMatch, TelemetryTokenCounts } from '../types'

/** USD per million tokens. */
export type ModelRates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export type PricingEntry = {
  /** Canonical id, as the API names the model. */
  id: string
  label: string
  family: 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'
  /**
   * Matched against the normalized id. A version is only matched when it is
   * not followed by a further minor number (`opus-4` does not match
   * `opus-4-1`), and an 8-digit date suffix is allowed after it.
   */
  patterns: readonly RegExp[]
  rates: ModelRates
  /** Rates for a request whose prompt (input + cache read + cache write) is over the threshold. */
  longContext?: { overPromptTokens: number; rates: ModelRates }
}

export type CostBreakdown = {
  usd: number
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  /** Cache reads priced as uncached input minus their read price, less the write premium. */
  cacheSavedUsd: number
  pricing: TelemetryPricingMatch
  /** The row used. */
  pricedAs: string
}

export const PRICING_SOURCE = 'platform.claude.com/docs/en/about-claude/pricing (2026-10-25)'

const r = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): ModelRates => ({
  input,
  output,
  cacheRead,
  cacheWrite5m,
  cacheWrite1h,
})

// `(?!\d)` stops `opus-5` matching `opus-50`; `(?!-\d{1,2}(?!\d))` stops it matching
// `opus-5-5` while still allowing a date suffix such as `-20250514`.
const v = (family: string, version: string): RegExp => new RegExp(`${family}-${version}(?!\\d)(?!-\\d{1,2}(?!\\d))`)
// The pre-4 naming put the version first: `claude-3-5-haiku-20241022`.
const old = (version: string, family: string): RegExp => new RegExp(`(?:^|-)${version}-${family}(?![a-z])`)

export const PRICING: readonly PricingEntry[] = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', family: 'fable', patterns: [v('fable', '5-1')], rates: r(10, 12.5, 20, 0.25, 50) },
  { id: 'claude-mythos-5-1', label: 'Claude Mythos 5.1', family: 'mythos', patterns: [v('mythos', '5-1')], rates: r(10, 12.5, 20, 0.25, 50) },
  { id: 'claude-fable-5', label: 'Claude Fable 5', family: 'fable', patterns: [v('fable', '5')], rates: r(10, 12.5, 20, 1, 50) },
  { id: 'claude-mythos-5', label: 'Claude Mythos 5', family: 'mythos', patterns: [v('mythos', '5')], rates: r(10, 12.5, 20, 1, 50) },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', family: 'opus', patterns: [v('opus', '5-5')], rates: r(4, 5, 8, 0.2, 20) },
  { id: 'claude-opus-5', label: 'Claude Opus 5', family: 'opus', patterns: [v('opus', '5')], rates: r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', family: 'opus', patterns: [v('opus', '4-8')], rates: r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', family: 'opus', patterns: [v('opus', '4-7')], rates: r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', family: 'opus', patterns: [v('opus', '4-6')], rates: r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', family: 'opus', patterns: [v('opus', '4-5')], rates: r(5, 6.25, 10, 0.5, 25) },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', family: 'opus', patterns: [v('opus', '4-1')], rates: r(15, 18.75, 30, 1.5, 75) },
  { id: 'claude-opus-4-0', label: 'Claude Opus 4', family: 'opus', patterns: [v('opus', '4-0'), v('opus', '4')], rates: r(15, 18.75, 30, 1.5, 75) },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', family: 'sonnet', patterns: [v('sonnet', '5-5')], rates: r(2, 2.5, 4, 0.1, 10) },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', family: 'sonnet', patterns: [v('sonnet', '5')], rates: r(2, 2.5, 4, 0.2, 10) },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', family: 'sonnet', patterns: [v('sonnet', '4-6')], rates: r(3, 3.75, 6, 0.3, 15) },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', family: 'sonnet', patterns: [v('sonnet', '4-5')], rates: r(3, 3.75, 6, 0.3, 15) },
  { id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4', family: 'sonnet', patterns: [v('sonnet', '4-0'), v('sonnet', '4')], rates: r(3, 3.75, 6, 0.3, 15) },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    family: 'haiku',
    patterns: [v('haiku', '5-5')],
    rates: r(0.1, 0.125, 0.2, 0.01, 0.5),
    longContext: { overPromptTokens: 100_000, rates: r(0.5, 0.625, 1, 0.05, 2.5) },
  },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', family: 'haiku', patterns: [v('haiku', '4-5')], rates: r(1, 1.25, 2, 0.1, 5) },
  { id: 'claude-3-5-haiku', label: 'Claude Haiku 3.5', family: 'haiku', patterns: [old('3-5', 'haiku')], rates: r(0.8, 1, 1.6, 0.08, 4) },
]
// Models the pricing page no longer lists (Opus 3, Sonnet 3.x, Haiku 3) have no
// row: they are priced at their family's newest row and flagged 'family'.

/** The row a model id that names no family is priced at: the session default model. */
export const DEFAULT_PRICING_ID = 'claude-opus-5-5'

/** The newest row of each family, for an id that names a family but no known version. */
const FAMILY_DEFAULT: Readonly<Record<PricingEntry['family'], string>> = {
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

const byId = new Map(PRICING.map(entry => [entry.id, entry]))
const cache = new Map<string, { entry: PricingEntry; match: TelemetryPricingMatch }>()

/**
 * Lowercased, provider spellings folded: `us.anthropic.claude-opus-5-5-v1:0`,
 * `claude-opus-4-5@20251101`, `claude-opus-5-5[1m]` and `Claude Opus 4.5` all
 * come out as `claude-opus-…` with dashes.
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '') // context-window suffix: [1m]
    .replace(/@/g, '-') // Vertex date separator
    .replace(/-v\d+(:\d+)?$/, '') // Bedrock version suffix
    .replace(/^.*?anthropic\./, '') // Bedrock region / provider prefix
    .replace(/[.\s_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function findPricing(modelId: string): { entry: PricingEntry; match: TelemetryPricingMatch } {
  const hit = cache.get(modelId)
  if (hit) return hit
  const id = normalizeModelId(modelId)
  let found: { entry: PricingEntry; match: TelemetryPricingMatch } | undefined
  for (const entry of PRICING) {
    if (entry.patterns.some(p => p.test(id))) {
      found = { entry, match: 'exact' }
      break
    }
  }
  if (!found) {
    const family = (['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const).find(f => id.includes(f))
    const entry = byId.get(family ? FAMILY_DEFAULT[family] : DEFAULT_PRICING_ID)
    if (!entry) throw new Error('pricing table is missing its default row')
    found = { entry, match: family ? 'family' : 'default' }
  }
  if (cache.size > 200) cache.clear()
  cache.set(modelId, found)
  return found
}

/** The row id a model id is priced as, so two spellings of one model compare equal. */
export function canonicalModel(modelId: string): string {
  const { entry, match } = findPricing(modelId)
  return match === 'exact' ? entry.id : normalizeModelId(modelId)
}

export function modelLabel(modelId: string): string {
  const { entry, match } = findPricing(modelId)
  return match === 'exact' ? entry.label : modelId
}

/** Rates one request pays; `promptTokens` is input + cache read + cache write. */
export function ratesFor(entry: PricingEntry, promptTokens: number): ModelRates {
  const long = entry.longContext
  return long && promptTokens > long.overPromptTokens ? long.rates : entry.rates
}

const PER_TOKEN = 1 / 1_000_000

/** What one request with these counts cost on `modelId`, cache writes priced at `cacheTtl`. */
export function costOf(counts: TelemetryTokenCounts, modelId: string, cacheTtl: '5m' | '1h' = '5m'): CostBreakdown {
  const { entry, match } = findPricing(modelId)
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite
  const rates = ratesFor(entry, prompt)
  const write = cacheTtl === '1h' ? rates.cacheWrite1h : rates.cacheWrite5m
  const inputUsd = counts.input * rates.input * PER_TOKEN
  const outputUsd = counts.output * rates.output * PER_TOKEN
  const cacheReadUsd = counts.cacheRead * rates.cacheRead * PER_TOKEN
  const cacheWriteUsd = counts.cacheWrite * write * PER_TOKEN
  const cacheSavedUsd =
    (counts.cacheRead * (rates.input - rates.cacheRead) - counts.cacheWrite * (write - rates.input)) * PER_TOKEN
  return {
    usd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    cacheSavedUsd,
    pricing: match,
    pricedAs: entry.id,
  }
}
