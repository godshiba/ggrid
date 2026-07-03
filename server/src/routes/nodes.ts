import { Hono } from 'hono'
import { z } from 'zod'
import { db, uid, now } from '../db'
import { sha256, randToken } from '../auth'
import { touch, dropNode, getNode } from '../registry'

export const nodes = new Hono()

const regSchema = z.object({
  url: z.string().url(),
  models: z.array(z.string()).default([]),
  gpuInfo: z.unknown().optional(),
  providerToken: z.string().min(1),
  priceFactor: z.number().optional(), // provider can bid cheaper to win jobs
})

// A provider's agent registers a node (after Ollama + tunnel are up).
nodes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null)
  const p = regSchema.safeParse(body)
  if (!p.success) return c.json({ error: 'url and providerToken are required' }, 400)

  const prov = db.query('SELECT id FROM providers WHERE token_hash = ?').get(sha256(p.data.providerToken)) as
    | { id: string }
    | undefined
  if (!prov) return c.json({ error: 'invalid providerToken' }, 401)

  const id = uid('nod_')
  const secret = randToken('ggrid_node_')
  const priceFactor = Math.min(3, Math.max(0.5, p.data.priceFactor ?? 1.0))
  db.query(
    'INSERT INTO nodes (id,provider_id,url,secret_hash,source,models,gpu_info,reliability,price_factor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    prov.id,
    p.data.url,
    sha256(secret),
    'LOCAL',
    JSON.stringify(p.data.models),
    p.data.gpuInfo ? JSON.stringify(p.data.gpuInfo) : null,
    1.0,
    priceFactor,
    now(),
  )
  touch(id, 'ONLINE')
  return c.json({ nodeId: id, nodeSecret: secret })
})

const beatSchema = z.object({
  status: z.string().optional(),
  activeJobs: z.number().optional(),
  models: z.array(z.string()).optional(),
})

// Keepalive. The node proves itself with the secret returned at registration.
nodes.post('/:id/heartbeat', async (c) => {
  const id = c.req.param('id')
  const node = getNode(id)
  if (!node) return c.json({ error: 'unknown node' }, 404)
  if (sha256(c.req.header('x-node-secret') ?? '') !== node.secret_hash)
    return c.json({ error: 'bad node secret' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const p = beatSchema.safeParse(body)
  if (p.success && p.data.models) db.query('UPDATE nodes SET models=? WHERE id=?').run(JSON.stringify(p.data.models), id)
  touch(id, (p.success && p.data.status) || 'ONLINE')
  return c.json({ ok: true, ttlMs: 30_000 })
})

nodes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const node = getNode(id)
  if (!node) return c.json({ error: 'unknown node' }, 404)
  if (sha256(c.req.header('x-node-secret') ?? '') !== node.secret_hash)
    return c.json({ error: 'bad node secret' }, 401)
  db.query('DELETE FROM nodes WHERE id=?').run(id)
  dropNode(id)
  return c.json({ ok: true })
})
