import type { Usage } from './types'

// Credits charged per 1,000,000 tokens, per model.
// Unit: 1 credit = 1 micro-USD (1e-6 USD), so a price of 50_000 ≈ $0.05 / 1M tokens.
// Fine-grained on purpose: a typical request costs hundreds of credits, so the
// 50/25/15/10 fee split divides cleanly instead of rounding to zero.
const PRICES: Record<string, { in: number; out: number }> = {
  'llama3:8b': { in: 50_000, out: 150_000 },
  'llama3.1:8b': { in: 50_000, out: 150_000 },
  'qwen2.5:7b': { in: 50_000, out: 150_000 },
  'mistral:7b': { in: 50_000, out: 150_000 },
  'gemma2:9b': { in: 60_000, out: 180_000 },
  'llama3:70b': { in: 300_000, out: 900_000 },
}
const DEFAULT = { in: 100_000, out: 300_000 }

export function priceFor(model: string, usage: Usage): number {
  const p = PRICES[model] ?? DEFAULT
  const cost = (usage.in / 1e6) * p.in + (usage.out / 1e6) * p.out
  return Math.max(0, Math.ceil(cost))
}

// Fee split per job. Remainder goes to treasury so the parts always sum to cost.
export function feeSplit(cost: number): {
  provider: number
  burn: number
  stakers: number
  treasury: number
} {
  // 75% provider · 25% split as burn 12.5 / stakers 7.5 / treasury 5
  const provider = Math.floor(cost * 0.75)
  const burn = Math.floor(cost * 0.125)
  const stakers = Math.floor(cost * 0.075)
  const treasury = cost - provider - burn - stakers
  return { provider, burn, stakers, treasury }
}

export function knownModels(): string[] {
  return Object.keys(PRICES)
}

// The published price sheet (per 1,000,000 tokens) + the fallback for unlisted models.
export function priceTable(): { model: string; in: number; out: number }[] {
  return Object.entries(PRICES).map(([model, p]) => ({ model, in: p.in, out: p.out }))
}
export const defaultPrice = DEFAULT
