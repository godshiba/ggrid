import { Hono } from 'hono'
import { z } from 'zod'
import { userByApiKey, bearer } from '../auth'
import { selectNode, nodeForRequest, onlineModels } from '../registry'
import { ensureNode } from '../runpod'
import { tryProxy, type Endpoint } from '../proxy'
import { knownModels } from '../pricing'
import { allow } from '../ratelimit'
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
  if (user.balance <= config.minBalance)
    return c.json({ error: { message: 'insufficient balance', type: 'billing' } }, 402)

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { message: 'invalid JSON body' } }, 400)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return c.json({ error: { message: 'field "model" is required' } }, 400)
  const model = parsed.data.model

  if (endpoint === 'chat' && body.stream)
    body.stream_options = { ...(body.stream_options ?? {}), include_usage: true }

  // Cap output length to bound per-request cost (and cloud-GPU time).
  if (typeof body.max_tokens === 'number' && body.max_tokens > config.maxOutputTokens)
    body.max_tokens = config.maxOutputTokens

  // GPU marketplace: a developer can pin a specific node via the `x-ggrid-node`
  // header (or a `node` field in the body). When pinned we honor the choice
  // exactly - one attempt on that node, no auto-fallback to another GPU.
  const pin = (c.req.header('x-ggrid-node') || (typeof body.node === 'string' ? body.node : '') || '').trim()
  if (typeof body.node !== 'undefined') delete body.node // never forward to Ollama
  if (pin) {
    const r = nodeForRequest(pin, model)
    if ('error' in r) return c.json({ error: { message: r.error, type: 'node_unavailable' } }, 409)
    const res = await tryProxy({ userId: user.id, node: r.node, model, body, endpoint })
    if (res) return res
    return c.json({ error: { message: `pinned GPU '${pin}' failed`, type: 'upstream_error' } }, 502)
  }

  // Try the best node. The RunPod fallback costs us real money, so it's gated
  // to paid/allowed users - free signups can only use community GPUs.
  const tried = new Set<string>()
  let node = selectNode(model)
  if (!node && (user.runpod_allowed || config.freeTierRunpod)) node = await ensureNode(model)
  let attempted = false
  for (let i = 0; i < 2 && node; i++) {
    attempted = true
    const res = await tryProxy({ userId: user.id, node, model, body, endpoint })
    if (res) return res
    tried.add(node.id)
    node = selectNode(model, tried)
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
