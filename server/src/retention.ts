import { config } from './config'
import { db, now } from './db'

// Data retention.
//
// The gateway never stores prompt or completion CONTENT (see config.privacy) —
// the only per-job record is metadata (model, token counts, cost, latency,
// status). When JOB_RETENTION_DAYS is set, even that usage history is purged after
// the window. The financial ledger, payouts and deposit records are the money
// trail and are always kept.

// Delete `jobs` rows older than the retention window. Returns rows removed.
export function purgeExpired(): number {
  const days = config.privacy.retentionDays
  if (!days || days <= 0) return 0
  const cutoff = now() - days * 24 * 60 * 60_000
  const res = db.query('DELETE FROM jobs WHERE created_at < ?').run(cutoff)
  return Number((res as { changes?: number })?.changes ?? 0)
}

let timer: ReturnType<typeof setInterval> | null = null

export function startRetention(): void {
  if (config.privacy.retentionDays <= 0 || timer) return
  purgeExpired() // sweep once at boot
  timer = setInterval(() => {
    try {
      const n = purgeExpired()
      if (n) console.log(`[retention] purged ${n} job rows older than ${config.privacy.retentionDays}d`)
    } catch (e) {
      console.error('[retention] sweep failed:', e)
    }
  }, config.privacy.sweepMs)
  console.log(`[retention] enabled — purging usage history older than ${config.privacy.retentionDays}d`)
}

export function stopRetention(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
