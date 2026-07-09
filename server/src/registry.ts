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

// Which endpoints a node advertises (defaults to both for legacy nodes).
export function nodeCaps(n: NodeRow): string[] {
  try {
    const c = JSON.parse(n.caps ?? '["chat","embeddings"]')
    return Array.isArray(c) && c.length ? (c as string[]) : ['chat', 'embeddings']
  } catch {
    return ['chat', 'embeddings']
  }
}

// Pick the best live node serving `model`: cheapest first (price_factor), then
// fastest (perf), most reliable, least busy. Nodes below the reliability floor
// are quarantined (auto-slashed) out of routing entirely. The `state` guard is a
// forward-compat hook (all nodes are currently 'verified'). A `longJob` (streaming
// or high max_tokens) prefers cooled nodes - a fanless MacBook Air throttles under
// sustained load, so it takes long jobs only as a fallback.
export function selectNode(
  model: string,
  exclude?: Set<string>,
  opts: { endpoint?: 'chat' | 'embeddings'; longJob?: boolean } = {},
): NodeRow | null {
  const endpoint = opts.endpoint ?? 'chat'
  const rows = db.query('SELECT * FROM nodes').all() as NodeRow[]
  const candidates = rows
    .map((n) => ({ n, models: JSON.parse(n.models) as string[], l: live.get(n.id) }))
    .filter((x) => !exclude?.has(x.n.id))
    .filter((x) => x.models.includes(model))
    .filter((x) => (x.n.state ?? 'verified') === 'verified')
    .filter((x) => nodeCaps(x.n).includes(endpoint))
    .filter((x) => !!x.l && Date.now() - x.l.lastBeat < config.heartbeatTtlMs)
    .filter((x) => x.l!.activeJobs < config.maxConcurrencyPerNode)
    .filter((x) => x.n.reliability >= config.minReliability)
    .sort((a, b) => {
      if (a.n.price_factor !== b.n.price_factor) return a.n.price_factor - b.n.price_factor
      if (a.n.perf !== b.n.perf) return b.n.perf - a.n.perf
      if (a.n.reliability !== b.n.reliability) return b.n.reliability - a.n.reliability
      return a.l!.activeJobs - b.l!.activeJobs
    })
  if (opts.longJob) {
    // Prefer actively-cooled nodes for sustained work; fall back to hot ones.
    const cooled = candidates.filter((x) => !x.n.fanless && !x.n.thermal_limited)
    return (cooled[0] ?? candidates[0])?.n ?? null
  }
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

// Coarse class label for a node (chip for Apple-Silicon, else backend/source).
export function tierLabel(n: NodeRow): string {
  if (n.backend === 'metal') return n.chip || 'Apple Silicon'
  if (n.source === 'RUNPOD') return 'Cloud'
  return 'CUDA'
}

// Public-facing view of a node's quality (for dashboards / admin).
export function nodeStats(n: NodeRow) {
  return {
    id: n.id,
    url: n.url,
    source: n.source,
    backend: n.backend ?? 'cuda',
    chip: n.chip ?? null,
    memGb: n.mem_gb ?? null,
    fanless: !!n.fanless,
    thermalLimited: !!n.thermal_limited,
    tier: tierLabel(n),
    state: n.state ?? 'verified',
    caps: nodeCaps(n),
    models: JSON.parse(n.models) as string[],
    priceFactor: n.price_factor,
    reliability: Math.round(n.reliability * 100) / 100,
    perfTokensPerSec: Math.round(n.perf * 10) / 10,
    jobsDone: n.jobs_done,
    uptimePct: uptimePct(n.id),
    online: isOnline(n.id),
    quarantined: n.reliability < config.minReliability,
    verifyError: n.verify_error ?? null,
  }
}

// Human-readable GPU name from the (nullable) gpu_info JSON. Providers send
// `{ name: 'RTX 4090', ... }` at register time; older/RunPod nodes have none.
export function gpuLabel(n: NodeRow): string {
  if (!n.gpu_info) return 'Unknown GPU'
  try {
    const info = JSON.parse(n.gpu_info) as unknown
    // Shell installer sends the raw name string; the PS/richer path sends an object.
    if (typeof info === 'string') return info.trim() || 'Unknown GPU'
    if (info && typeof info === 'object') {
      const rec = info as Record<string, unknown>
      const name = rec.name ?? rec.gpu ?? rec.model
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
    return 'Unknown GPU'
  } catch {
    return 'Unknown GPU'
  }
}

// Safe, public catalogue of nodes for the GPU marketplace. Never leaks url or
// secrets - only what a developer needs to pick a GPU. Online nodes first, then
// cheapest/fastest, so the picker reads top-to-bottom like the auto-router.
export function listNodes(opts: { includeOffline?: boolean } = {}) {
  const rows = db.query('SELECT * FROM nodes').all() as NodeRow[]
  return rows
    .map((n) => {
      const l = live.get(n.id)
      const online = isOnline(n.id)
      const activeJobs = l?.activeJobs ?? 0
      const freeSlots = Math.max(0, config.maxConcurrencyPerNode - activeJobs)
      return {
        id: n.id,
        gpu: gpuLabel(n),
        source: n.source,
        backend: n.backend ?? 'cuda',
        chip: n.chip ?? null,
        memGb: n.mem_gb ?? null,
        fanless: !!n.fanless,
        thermalLimited: !!n.thermal_limited,
        tier: tierLabel(n),
        state: n.state ?? 'verified',
        models: JSON.parse(n.models) as string[],
        priceFactor: n.price_factor,
        reliability: Math.round(n.reliability * 100) / 100,
        perfTokensPerSec: Math.round(n.perf * 10) / 10,
        uptimePct: uptimePct(n.id),
        activeJobs,
        freeSlots,
        online,
        quarantined: n.reliability < config.minReliability,
      }
    })
    // state guard (forward-compat; all nodes are currently 'verified').
    .filter((n) => (n.state ?? 'verified') === 'verified')
    .filter((n) => opts.includeOffline || n.online)
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      if (a.priceFactor !== b.priceFactor) return a.priceFactor - b.priceFactor
      if (a.perfTokensPerSec !== b.perfTokensPerSec) return b.perfTokensPerSec - a.perfTokensPerSec
      return b.reliability - a.reliability
    })
}

// Resolve a developer-pinned node for a request. Returns the row to proxy to,
// or an error string explaining why the pin can't be honored (→ 409, no
// silent fallback: the choice was explicit).
export function nodeForRequest(
  nodeId: string,
  model: string,
  endpoint: 'chat' | 'embeddings' = 'chat',
): { node: NodeRow } | { error: string } {
  const n = getNode(nodeId)
  if (!n) return { error: `unknown GPU node '${nodeId}'` }
  if ((n.state ?? 'verified') !== 'verified') return { error: `GPU '${nodeId}' is not verified` }
  const models = JSON.parse(n.models) as string[]
  if (!models.includes(model)) return { error: `GPU '${nodeId}' does not serve model '${model}'` }
  if (!nodeCaps(n).includes(endpoint)) return { error: `GPU '${nodeId}' does not serve ${endpoint} requests` }
  if (!isOnline(n.id)) return { error: `GPU '${nodeId}' is offline` }
  if (n.reliability < config.minReliability) return { error: `GPU '${nodeId}' is quarantined` }
  const active = live.get(n.id)?.activeJobs ?? 0
  if (active >= config.maxConcurrencyPerNode) return { error: `GPU '${nodeId}' is at capacity` }
  return { node: n }
}
