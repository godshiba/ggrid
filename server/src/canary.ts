import { config } from './config'
import { db } from './db'
import { isOnline, penalize } from './registry'
import { shadowChat } from './probe'
import type { NodeRow } from './types'

// Canary prompts.
//
// A node advertises which models it serves, but nothing stops it from claiming
// `llama3:70b` while actually running a tiny 3B model to pocket the higher price.
// Canaries catch that: each is a prompt with a KNOWN, deterministically checkable
// answer. A capable model answers correctly; a small model dressed up as a big one
// fails the hard ones. Answers are graded by regex on a normalized reply, so
// phrasing never matters and no judge model is needed.
//
// A node that fails enough canaries in a round is penalized — repeated failure
// drops it below the reliability floor and it is quarantined out of routing.
// Runs on a timer, OFF by default (CANARY_ENABLED=1 to turn on).

interface Canary {
  q: string
  answer: RegExp
}

// Deterministic, self-checkable. Mix of easy (any real model) and harder facts /
// counting where undersized models tend to slip.
const CANARIES: Canary[] = [
  { q: 'Compute 17 * 23. Reply with only the number.', answer: /(^|\D)391(\D|$)/ },
  { q: 'What is the capital city of Australia? Reply with only the city name.', answer: /canberra/i },
  { q: 'How many days are in a week? Reply with only the number.', answer: /(^|\D)7(\D|$)/ },
  { q: 'What is the chemical symbol for gold? Reply with only the symbol.', answer: /\bAu\b/ },
  { q: 'What is 2 to the power of 10? Reply with only the number.', answer: /(^|\D)1024(\D|$)/ },
]

// nodeId → consecutive rounds failed (for logging / escalation visibility).
const strikes = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null

// Deterministic-enough sampling without persisting an index: pick `n` distinct
// canaries starting from a rotating offset. (Runtime Math.random is fine here.)
function pickCanaries(n: number): Canary[] {
  const k = Math.min(n, CANARIES.length)
  const start = Math.floor(Math.random() * CANARIES.length)
  const out: Canary[] = []
  for (let i = 0; i < k; i++) out.push(CANARIES[(start + i) % CANARIES.length])
  return out
}

// Probe one node for one model. Unreachable canaries (null) are NOT counted as
// failures — only a live-but-wrong answer counts against the node.
export async function probeNode(node: NodeRow, model: string, count = 2): Promise<{ asked: number; failed: number }> {
  const set = pickCanaries(count)
  let asked = 0
  let failed = 0
  for (const c of set) {
    const out = await shadowChat(node, model, [{ role: 'user', content: c.q }], config.integrity.canaryMaxTokens)
    if (out === null) continue // unreachable / errored — skip, don't punish
    asked++
    if (!c.answer.test(out.trim())) failed++
  }
  return { asked, failed }
}

// One sweep over all online, verified nodes. Penalizes nodes that fail the round.
export async function runCanaryRound(): Promise<void> {
  const rows = db.query('SELECT * FROM nodes').all() as NodeRow[]
  for (const n of rows) {
    if ((n.state ?? 'verified') !== 'verified' || !isOnline(n.id)) continue
    let models: string[] = []
    try {
      models = JSON.parse(n.models) as string[]
    } catch {
      continue
    }
    if (!models.length) continue
    const model = models[0] // audit the first (typically largest) advertised model

    const { asked, failed } = await probeNode(n, model)
    if (asked === 0) continue // node didn't answer any canary this round

    if (failed >= config.integrity.canaryFailThreshold) {
      penalize(n.id)
      const s = (strikes.get(n.id) ?? 0) + 1
      strikes.set(n.id, s)
      db.query('UPDATE nodes SET verify_error=? WHERE id=?').run(
        `failed ${failed}/${asked} canaries on '${model}'`,
        n.id,
      )
      console.warn(`[canary] node ${n.id} failed ${failed}/${asked} canaries on '${model}' — penalized (strike ${s})`)
    } else {
      strikes.delete(n.id)
    }
  }
}

export function startCanary(): void {
  if (!config.integrity.canaryEnabled || timer) return
  timer = setInterval(() => {
    runCanaryRound().catch((e) => console.error('[canary] round failed:', e))
  }, config.integrity.canaryIntervalMs)
  console.log(`[canary] enabled — probing every ${Math.round(config.integrity.canaryIntervalMs / 1000)}s`)
}

export function stopCanary(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
