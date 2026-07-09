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

  // Non-streaming (incl. embeddings): read JSON, bill, return. A mid-read failure
  // (the node dropped before we got the full body) is retryable -> return null so
  // the caller fails over to another node instead of erroring.
  if (endpoint === 'embeddings' || !body.stream) {
    let data: any
    try {
      data = await upstream.json()
    } catch (e) {
      fail('upstream read failed: ' + String(e))
      return null // retryable
    }
    finish({ in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 })
    return json(data, 200)
  }

  // Streaming: read the FIRST chunk before committing to this node. If the node
  // dies at/before the first token, we return null and the caller fails over to
  // another node - the client never sees a broken stream. Once the first token
  // arrives we commit and stream the rest; a drop AFTER that can't fail over (the
  // client is already receiving), so that request ends with the partial output.
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  let firstValue: Uint8Array
  try {
    const first = await reader.read()
    if (first.done || !first.value) {
      fail('upstream closed with no output')
      return null // retryable
    }
    firstValue = first.value
    acc += decoder.decode(firstValue, { stream: true })
  } catch (e) {
    fail('stream error before first chunk: ' + String(e))
    return null // retryable
  }

  let sentFirst = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true
        controller.enqueue(firstValue)
        return
      }
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
        finish(extractUsage(acc)) // bill what was delivered
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
