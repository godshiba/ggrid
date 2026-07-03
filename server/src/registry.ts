import { db } from './db'
import { config } from './config'
import type { NodeRow } from './types'

// In-memory liveness for a single instance. Static node data lives in SQLite;
// "is it alive / how busy / uptime" lives here (would be Redis when we scale out).
interface Live {
  lastBeat: number
  activeJobs: number
  status: string
  since: number // first seen
  onlineMs: number // accumulated time spent online
}
const live = new Map<string, Live>()
const PERF_ALPHA = 0.3 // EWMA weight for throughput samples

export function touch(nodeId: string, status = 'ONLINE'): void {
  const now = Date.now()
  const prev = live.get(nodeId)
  const since = prev?.since ?? now
  let onlineMs = prev?.onlineMs ?? 0
  // count the gap as uptime only if the node was still alive at the last beat
  if (prev && now - prev.lastBeat < config.heartbeatTtlMs) onlineMs += now - prev.lastBeat
  live.set(nodeId, { lastBeat: now, activeJobs: prev?.activeJobs ?? 0, status, since, onlineMs })
}

export function setActive(nodeId: string, delta: number): void {
  const now = Date.now()
  const base: Live = live.get(nodeId) ?? { lastBeat: now, activeJobs: 0, status: 'ONLINE', since: now, onlineMs: 0 }
  base.activeJobs = Math.max(0, base.activeJobs + delta)
  live.set(nodeId, base)
}

export function isOnline(nodeId: string): boolean {
  const l = live.get(nodeId)
  return !!l && Date.now() - l.lastBeat < config.heartbeatTtlMs
}

// Share of time the node has been online since it first registered (0..100).
export function uptimePct(nodeId: string): number {
  const l = live.get(nodeId)
  if (!l) return 0
  const total = Date.now() - l.since
  if (total <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((l.onlineMs / total) * 1000) / 10))
}

export function dropNode(nodeId: string): void {
  live.delete(nodeId)
}

export function getNode(id: string): NodeRow | null {
  return (db.query('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow) ?? null
}

// Pick the best live node serving `model`: cheapest first (price_factor), then
// fastest (perf), most reliable, least busy. Nodes below the reliability floor
// are quarantined (auto-slashed) out of routing entirely.
export function selectNode(model: string, exclude?: Set<string>): NodeRow | null {
  const rows = db.query('SELECT * FROM nodes').all() as NodeRow[]
  const candidates = rows
    .map((n) => ({ n, models: JSON.parse(n.models) as string[], l: live.get(n.id) }))
    .filter((x) => !exclude?.has(x.n.id))
    .filter((x) => x.models.includes(model))
    .filter((x) => !!x.l && Date.now() - x.l.lastBeat < config.heartbeatTtlMs)
    .filter((x) => x.l!.activeJobs < config.maxConcurrencyPerNode)
    .filter((x) => x.n.reliability >= config.minReliability)
    .sort((a, b) => {
      if (a.n.price_factor !== b.n.price_factor) return a.n.price_factor - b.n.price_factor
      if (a.n.perf !== b.n.perf) return b.n.perf - a.n.perf
      if (a.n.reliability !== b.n.reliability) return b.n.reliability - a.n.reliability
      return a.l!.activeJobs - b.l!.activeJobs
    })
  return candidates[0]?.n ?? null
}

export function onlineModels(): string[] {
  const rows = db.query('SELECT id, models FROM nodes').all() as { id: string; models: string }[]
  const set = new Set<string>()
  for (const r of rows) if (isOnline(r.id)) for (const m of JSON.parse(r.models) as string[]) set.add(m)
  return [...set]
}

export function onlineCount(): number {
  const rows = db.query('SELECT id FROM nodes').all() as { id: string }[]
  return rows.filter((r) => isOnline(r.id)).length
}

export function penalize(nodeId: string): void {
  db.query('UPDATE nodes SET reliability = MAX(0, reliability - 0.1) WHERE id = ?').run(nodeId)
}

// Slowly restore trust on successful jobs.
export function reward(nodeId: string): void {
  db.query('UPDATE nodes SET reliability = MIN(1.0, reliability + 0.02) WHERE id = ?').run(nodeId)
}

// Record throughput (tokens/sec) on a successful job → EWMA + jobs_done++.
export function recordPerf(nodeId: string, tokensPerSec: number): void {
  const row = db.query('SELECT perf FROM nodes WHERE id=?').get(nodeId) as { perf: number } | undefined
  if (!row) return
  const perf = row.perf > 0 ? PERF_ALPHA * tokensPerSec + (1 - PERF_ALPHA) * row.perf : tokensPerSec
  db.query('UPDATE nodes SET perf=?, jobs_done=jobs_done+1 WHERE id=?').run(perf, nodeId)
}

// Public-facing view of a node's quality (for dashboards / admin).
export function nodeStats(n: NodeRow) {
  return {
    id: n.id,
    url: n.url,
    source: n.source,
    models: JSON.parse(n.models) as string[],
    priceFactor: n.price_factor,
    reliability: Math.round(n.reliability * 100) / 100,
    perfTokensPerSec: Math.round(n.perf * 10) / 10,
    jobsDone: n.jobs_done,
    uptimePct: uptimePct(n.id),
    online: isOnline(n.id),
    quarantined: n.reliability < config.minReliability,
  }
}
