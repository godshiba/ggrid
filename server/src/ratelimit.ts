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
export const DAY_MS = 24 * 60 * 60 * 1000

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

// --- Generic per-IP limiter (defense-in-depth for public, keyless endpoints) ---
// NOTE: the client IP comes from X-Forwarded-For, which is spoofable, so a flood of
// forged IPs could otherwise grow this map without bound. `rateLimitMaxTracked` caps
// it: once exceeded we sweep expired entries, and if still over, clear the map (a
// fail-open reset that bounds memory - the RPC cache + in-flight guard remain the
// real protection against amplification, independent of IP identity).
const ipBuckets = new Map<string, { count: number; reset: number }>()

export function allowIp(ip: string, limit: number, windowMs = WINDOW_MS): boolean {
  const t = Date.now()
  if (ipBuckets.size > config.security.rateLimitMaxTracked) {
    for (const [k, b] of ipBuckets) if (t > b.reset) ipBuckets.delete(k)
    if (ipBuckets.size > config.security.rateLimitMaxTracked) ipBuckets.clear()
  }
  const b = ipBuckets.get(ip)
  if (!b || t > b.reset) {
    ipBuckets.set(ip, { count: 1, reset: t + windowMs })
    return true
  }
  if (b.count >= limit) return false
  b.count++
  return true
}

// How many calls remain in an `allowIp` bucket WITHOUT consuming one. Used by the
// playground to show "N of M free requests left today". Keys share the ipBuckets
// map, so callers namespace them (e.g. 'pg:' + ip) to avoid cross-limiter collisions.
export function ipRemaining(key: string, limit: number): number {
  const b = ipBuckets.get(key)
  if (!b || Date.now() > b.reset) return limit
  return Math.max(0, limit - b.count)
}

// Per-IP cap on provider creation (unbounded providers = DB bloat + more node slots).
const providerBuckets = new Map<string, { count: number; reset: number }>()

export function allowProviderCreate(ip: string): boolean {
  const t = Date.now()
  const b = providerBuckets.get(ip)
  if (!b || t > b.reset) {
    providerBuckets.set(ip, { count: 1, reset: t + DAY_MS })
    return true
  }
  if (b.count >= config.security.providerCreatePerIpPerDay) return false
  b.count++
  return true
}

// Periodically drop expired buckets so long-running instances don't accumulate them.
export function sweepRateLimit(): void {
  const t = Date.now()
  for (const m of [buckets, signupBuckets, ipBuckets, providerBuckets]) {
    for (const [k, b] of m) if (t > b.reset) m.delete(k)
  }
}
