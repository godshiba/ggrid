// Measured node verification — the "prove your hardware" gate.
//
// We NEVER trust a node's self-declared chip. A new Apple-Silicon ("metal") node
// registers as `provisional` and is benchmarked here: a quick handshake bench
// gates admission, then a back-to-back sustained probe measures real throughput
// and surfaces thermal throttling (a fanless MacBook Air slows 30-50% after a few
// minutes of sustained inference). Only nodes that clear the tokens/sec floor AND
// declare an allowed chip (M4/M5) become `verified` and serve paid traffic.
//
// cuda / runpod nodes skip the gate (auto-verified) — this is additive, the live
// CUDA network is unaffected.

import { db, now } from './db'
import { config } from './config'
import { getNode } from './registry'
import type { NodeRow } from './types'

// One non-billed generation against the node → tokens/sec.
async function benchOnce(node: NodeRow, model: string, maxTokens: number): Promise<number> {
  const t0 = Date.now()
  const res = await fetch(node.url.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Write a detailed technical paragraph about GPU memory bandwidth.' }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(config.verify.benchTimeoutMs),
  })
  if (!res.ok) throw new Error(`bench http ${res.status}`)
  const data: any = await res.json()
  const out: number = data?.usage?.completion_tokens ?? 0
  if (out <= 0) throw new Error('bench produced no tokens')
  const secs = Math.max(0.001, (Date.now() - t0) / 1000)
  return out / secs
}

// Declared chip must contain one of the allowed substrings (M4 / M5).
function chipAllowed(chip: string | null): boolean {
  if (!chip) return false
  return config.verify.allowedMacChips.some((c) => chip.includes(c))
}

function reject(nodeId: string, reason: string): void {
  db.query('UPDATE nodes SET state=?, verify_error=? WHERE id=?').run('rejected', reason.slice(0, 300), nodeId)
}

// Benchmark + gate a single node. Safe to call fire-and-forget (never throws).
export async function verifyNode(nodeId: string): Promise<void> {
  const node = getNode(nodeId)
  if (!node) return

  // Non-metal nodes are trusted as before — auto-verify.
  if ((node.backend ?? 'cuda') !== 'metal') {
    db.query('UPDATE nodes SET state=?, verified_at=? WHERE id=?').run('verified', now(), nodeId)
    return
  }

  try {
    if (!chipAllowed(node.chip)) throw new Error(`unsupported chip '${node.chip ?? 'unknown'}' — M4/M5 only`)
    const models = JSON.parse(node.models) as string[]
    const model = models[0]
    if (!model) throw new Error('node advertises no model to benchmark')

    // 1) Handshake gate — quick floor check.
    const handshake = await benchOnce(node, model, config.verify.handshakeTokens)
    if (handshake < config.verify.minTokensPerSec)
      throw new Error(`below floor: ${handshake.toFixed(1)} < ${config.verify.minTokensPerSec} tok/s`)

    // 2) Sustained probe — back-to-back rounds; compare first vs last for throttle.
    const samples: number[] = []
    for (let i = 0; i < config.verify.sustainedRounds; i++) {
      samples.push(await benchOnce(node, model, config.verify.sustainedTokens))
    }
    const first = samples[0]
    const last = samples[samples.length - 1]
    const sustained = samples.reduce((a, b) => a + b, 0) / samples.length
    const ratio = first > 0 ? last / first : 1
    const thermalLimited = ratio < 1 - config.verify.thermalDropPct

    if (sustained < config.verify.minTokensPerSec)
      throw new Error(`sustained below floor: ${sustained.toFixed(1)} < ${config.verify.minTokensPerSec} tok/s`)

    // Seed `perf` with the measured throughput so the node shows a real speed
    // before it has served any user jobs (real jobs then EWMA-adjust it).
    db.query(
      'UPDATE nodes SET state=?, bench_perf=?, perf=?, thermal_ratio=?, thermal_limited=?, tier=?, verify_error=NULL, verified_at=? WHERE id=?',
    ).run('verified', sustained, sustained, ratio, thermalLimited ? 1 : 0, node.chip, now(), nodeId)
  } catch (e) {
    reject(nodeId, String(e instanceof Error ? e.message : e))
  }
}
