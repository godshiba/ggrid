import { db, uid, now } from './db'
import { config } from './config'
import { priceFor } from './pricing'
import { settleJob, failJob } from './ledger'
import { setActive, penalize, reward, recordPerf } from './registry'
import { markRunpodUse } from './runpod'
import type { NodeRow, Usage } from './types'

export type Endpoint = 'chat' | 'embeddings'
const UPSTREAM_PATH: Record<Endpoint, string> = {
  chat: '/v1/chat/completions',
  embeddings: '/v1/embeddings',
}

// Pull token usage out of an OpenAI-style SSE transcript (the final chunk
// carries `usage` when stream_options.include_usage is set).
export function extractUsage(sseText: string): Usage {
  let usage: Usage = { in: 0, out: 0 }
  for (const line of sseText.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      if (obj.usage) usage = { in: obj.usage.prompt_tokens ?? 0, out: obj.usage.completion_tokens ?? 0 }
    } catch {
      /* partial chunk; ignore */
    }
  }
  return usage
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

interface Attempt {
  userId: string
  node: NodeRow
  model: string
  body: any
  endpoint: Endpoint
}

// Run one job against one node. Returns a Response on success (or a definitive
// answer). Returns null if the node failed BEFORE producing output - the caller
// may then retry on a different node. Billing happens here on completion.
export async function tryProxy(a: Attempt): Promise<Response | null> {
  const { userId, node, model, body, endpoint } = a
  const jobId = uid('job_')
  db.query('INSERT INTO jobs (id,user_id,node_id,model,status,source,created_at) VALUES (?,?,?,?,?,?,?)').run(
    jobId,
    userId,
    node.id,
    model,
    'RUNNING',
    node.source,
    now(),
  )
  setActive(node.id, +1)
  if (node.source === 'RUNPOD') markRunpodUse(node.id)
  const t0 = Date.now()
  let closed = false

  const finish = (u: Usage): void => {
    if (closed) return
    closed = true
    const latencyMs = Date.now() - t0
    // The developer pays the chosen node's price (price_factor) → cheapest wins.
    settleJob({
      jobId,
      userId,
      nodeId: node.id,
      providerId: node.provider_id,
      tokensIn: u.in,
      tokensOut: u.out,
      cost: Math.max(0, Math.ceil(priceFor(model, u) * node.price_factor)),
      latencyMs,
    })
    setActive(node.id, -1)
    reward(node.id)
    if (u.out > 0) recordPerf(node.id, (u.out / Math.max(1, latencyMs)) * 1000)
  }
  const fail = (msg: string): void => {
    if (closed) return
    closed = true
    failJob(jobId, msg)
    penalize(node.id)
    setActive(node.id, -1)
  }

  let upstream: Response
  try {
    upstream = await fetch(node.url.replace(/\/$/, '') + UPSTREAM_PATH[endpoint], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    })
  } catch (e) {
    fail('upstream unreachable: ' + String(e))
    return null // retryable
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    fail(`upstream ${upstream.status}: ${text.slice(0, 200)}`)
    return null // retryable
  }

  // Non-streaming (incl. embeddings): read JSON, bill, return.
  if (endpoint === 'embeddings' || !body.stream) {
    const data = await upstream.json()
    finish({ in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 })
    return json(data, 200)
  }

  // Streaming: pass bytes straight through, capture usage, bill on completion.
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finish(extractUsage(acc))
          controller.close()
          return
        }
        acc += decoder.decode(value, { stream: true })
        controller.enqueue(value)
      } catch (e) {
        fail('stream error: ' + String(e))
        controller.error(e)
      }
    },
    cancel() {
      finish(extractUsage(acc))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}
