import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db'
import { userByApiKey, bearer } from '../auth'
import { selectNode, nodeForRequest, onlineModels, modelHasOnlineNode } from '../registry'
import { waitForSlot } from '../queue'
import { ensureNode } from '../runpod'
import { tryProxy, type Endpoint } from '../proxy'
import { knownModels } from '../pricing'
import { allow } from '../ratelimit'
import { SANDBOX_USER_ID, sandboxBudgetOk } from '../sandbox'
import { config } from '../config'

export const v1 = new Hono()

// OpenAI-compatible model list (live grid models + known catalog).
v1.get('/models', (c) => {
  const all = [...new Set([...onlineModels(), ...knownModels()])]
  return c.json({ object: 'list', data: all.map((id) => ({ id, object: 'model', owned_by: 'gpugrid' })) })
})

const schema = z.object({ model: z.string().min(1), stream: z.boolean().optional() }).passthrough()

// Shared handler for chat + embeddings: auth → balance → select → proxy (retry once).
async function handleProxy(c: any, endpoint: Endpoint): Promise<Response> {
  const key = bearer(c.req.header('authorization'))
  if (!key) return c.json({ error: { message: 'missing API key', type: 'auth' } }, 401)
  const user = userByApiKey(key)
  if (!user) return c.json({ error: { message: 'invalid API key', type: 'auth' } }, 401)
  if (!allow(key)) return c.json({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }, 429)

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { message: 'invalid JSON body' } }, 400)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return c.json({ error: { message: 'field "model" is required' } }, 400)
  const model = parsed.data.model

  // Free tier: an empty balance may still run on the signup free-request counter.
  // Those jobs bill the SANDBOX FUND (provider still earns 75%) and are capped
  // like playground requests. The counter is consumed up front, atomically —
  // AFTER body validation, so a malformed request never burns one.
  let billUserId: string | undefined
  if (user.balance <= config.minBalance) {
    if ((user.free_requests ?? 0) <= 0)
      return c.json(
        { error: { message: 'insufficient balance — top up, or sign up bonus requests are used up', type: 'billing' } },
        402,
      )
    if (!sandboxBudgetOk())
      return c.json(
        { error: { message: 'free requests are paused (daily free budget spent) — try later or top up', type: 'billing' } },
        402,
      )
    const dec = db.query('UPDATE users SET free_requests = free_requests - 1 WHERE id = ? AND free_requests > 0').run(user.id)
    if (dec.changes !== 1)
      return c.json({ error: { message: 'insufficient balance', type: 'billing' } }, 402)
    billUserId = SANDBOX_USER_ID
  }

  if (endpoint === 'chat' && body.stream)
    body.stream_options = { ...(body.stream_options ?? {}), include_usage: true }

  // Cap output length to bound per-request cost (and cloud-GPU time).
  if (typeof body.max_tokens === 'number' && body.max_tokens > config.maxOutputTokens)
    body.max_tokens = config.maxOutputTokens

  // A sandbox-funded request may not cost more than a playground one.
  if (billUserId) {
    const cap = config.playground.maxTokens
    if (typeof body.max_tokens !== 'number' || body.max_tokens > cap) body.max_tokens = cap
  }

  // GPU marketplace: a developer can pin a specific node via the `x-ggrid-node`
  // header (or a `node` field in the body). When pinned we honor the choice
  // exactly — one attempt on that node, no auto-fallback to another GPU.
  const pin = (c.req.header('x-ggrid-node') || (typeof body.node === 'string' ? body.node : '') || '').trim()
  if (typeof body.node !== 'undefined') delete body.node // never forward to Ollama
  if (pin) {
    const r = nodeForRequest(pin, model, endpoint)
    if ('error' in r) return c.json({ error: { message: r.error, type: 'node_unavailable' } }, 409)
    const res = await tryProxy({ userId: user.id, node: r.node, model, body, endpoint, billUserId })
    if (res) return res
    return c.json({ error: { message: `pinned GPU '${pin}' failed`, type: 'upstream_error' } }, 502)
  }

  // A streaming chat, or one asking for many output tokens, is a "long job" →
  // routed away from fanless / thermal-limited (Air) nodes when a cooled node is
  // free, since those throttle under sustained load.
  const longJob =
    endpoint === 'chat' &&
    (!!body.stream || (typeof body.max_tokens === 'number' && body.max_tokens > config.verify.longJobTokens))
  const pick = (tried?: Set<string>) => selectNode(model, tried, { endpoint, longJob })

  const tried = new Set<string>()
  let node = pick()

  // Capacity queue: a node serves this model but every one is busy -> wait for a
  // slot to free (up to queueMaxWaitMs) instead of returning 503 immediately.
  if (!node && modelHasOnlineNode(model, endpoint)) {
    if (await waitForSlot(() => !!pick())) node = pick()
  }

  // RunPod fallback costs real money, so it's gated to paid/allowed users — free
  // signups can only use community GPUs. Tried after the queue (community first).
  if (!node && (user.runpod_allowed || config.freeTierRunpod)) node = await ensureNode(model)

  // Failover: try up to maxAttempts different nodes. tryProxy returns null when a
  // node fails at/before its first token, so one node dropping doesn't fail the
  // request — it retries on the next.
  let attempted = false
  for (let i = 0; i < config.routing.maxAttempts && node; i++) {
    attempted = true
    const res = await tryProxy({ userId: user.id, node, model, body, endpoint, billUserId })
    if (res) return res
    tried.add(node.id)
    node = pick(tried)
  }

  return c.json(
    {
      error: {
        message: attempted ? `all GPUs failed for '${model}'` : `no online GPU for '${model}'`,
        type: attempted ? 'upstream_error' : 'no_capacity',
      },
    },
    attempted ? 502 : 503,
  )
}

v1.post('/chat/completions', (c) => handleProxy(c, 'chat'))
v1.post('/embeddings', (c) => handleProxy(c, 'embeddings'))
