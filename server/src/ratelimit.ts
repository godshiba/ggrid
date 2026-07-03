import { config } from './config'

// Simple fixed-window limiter per key, in-memory (single instance).
const buckets = new Map<string, { count: number; reset: number }>()
const WINDOW_MS = 60_000

export function allow(key: string): boolean {
  const t = Date.now()
  const b = buckets.get(key)
  if (!b || t > b.reset) {
    buckets.set(key, { count: 1, reset: t + WINDOW_MS })
    return true
  }
  if (b.count >= config.rateLimitPerMin) return false
  b.count++
  return true
}

// Per-IP signup cap (anti-abuse on free credits). 24h window.
const signupBuckets = new Map<string, { count: number; reset: number }>()
const DAY_MS = 24 * 60 * 60 * 1000

export function allowSignup(ip: string): boolean {
  const t = Date.now()
  const b = signupBuckets.get(ip)
  if (!b || t > b.reset) {
    signupBuckets.set(ip, { count: 1, reset: t + DAY_MS })
    return true
  }
  if (b.count >= config.signupPerIpPerDay) return false
  b.count++
  return true
}
