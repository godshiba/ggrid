import { db } from './db'

// Coarse node location ("City, CC") for the marketplace / playground meta line.
//
// Source of truth is the IP the node's agent CONNECTS FROM at register/heartbeat
// time — NOT the node URL, which is usually a cloudflared tunnel and would
// geolocate to a Cloudflare edge, not the provider's machine. On prod Caddy
// rewrites X-Forwarded-For, so that IP is the real one.
//
// Privacy: only the resolved "City, CC" string is ever stored; the IP itself is
// never written anywhere. Everything here is best-effort and fail-open — a geo
// outage can never affect registration, heartbeats, or routing.

const PRIVATE_IP =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|unknown$|localhost$)/i

export async function resolveGeo(ip: string): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null // local/dev/test traffic has no public location
  try {
    // ip-api.com free tier: 45 req/min, HTTP only — fine for coarse city lookups.
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,countryCode`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return null
    const j: any = await res.json()
    if (j?.status !== 'success') return null
    const city = typeof j.city === 'string' ? j.city.trim() : ''
    const cc = typeof j.countryCode === 'string' ? j.countryCode.trim() : ''
    if (!city && !cc) return null
    return city && cc ? `${city}, ${cc}` : city || cc
  } catch {
    return null
  }
}

// Fire-and-forget: resolve + store a node's location once. Retries at most every
// 6h per node (in-memory), only ever fills an empty geo — never overwrites.
const lastAttempt = new Map<string, number>()
const RETRY_MS = 6 * 60 * 60 * 1000

export function tagNodeGeo(nodeId: string, ip: string): void {
  const last = lastAttempt.get(nodeId)
  if (last && Date.now() - last < RETRY_MS) return
  lastAttempt.set(nodeId, Date.now())
  void resolveGeo(ip)
    .then((geo) => {
      if (geo) db.query('UPDATE nodes SET geo = ? WHERE id = ? AND geo IS NULL').run(geo, nodeId)
    })
    .catch(() => {})
}

// The client IP as seen through the proxy chain (same rule as the API's clientIp).
export function requestIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
}
