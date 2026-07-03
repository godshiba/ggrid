import { Hono } from 'hono'
import { db, uid, now } from '../db'
import {
  createUser,
  issueApiKey,
  getUser,
  sha256,
  randToken,
  requireUser,
  requireProvider,
  requireAdmin,
  type Env,
} from '../auth'
import { onlineCount, onlineModels, dropNode, nodeStats } from '../registry'
import { allowSignup } from '../ratelimit'
import { config } from '../config'
import { solanaEnabled } from '../solana'
import { requestPayout } from '../payouts'
import type { NodeRow } from '../types'

function clientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
}

// Control-plane API for the dashboards.
//  - developer routes authenticate with an API key (any of the user's keys)
//  - provider routes authenticate with the provider token
//  - admin routes authenticate with ADMIN_KEY
export const api = new Hono<Env>()

// ---------- public: account creation ----------
api.post('/signup', async (c) => {
  if (!allowSignup(clientIp(c)))
    return c.json({ error: { message: 'signup limit reached for your network, try later', type: 'rate_limit' } }, 429)
  const body = await c.req.json().catch(() => ({}))
  const user = createUser(body?.email ?? null, config.signupBonus)
  const { key } = issueApiKey(user.id, 'default')
  return c.json({ userId: user.id, apiKey: key, balance: user.balance })
})

api.post('/providers', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = uid('prv_')
  const token = randToken('ggrid_pv_')
  db.query('INSERT INTO providers (id,email,token_hash,payout_wallet,balance,created_at) VALUES (?,?,?,?,?,?)').run(
    id,
    body?.email ?? null,
    sha256(token),
    body?.payoutWallet ?? null,
    0,
    now(),
  )
  return c.json({ providerId: id, providerToken: token })
})

// ---------- developer (API-key auth) ----------
api.get('/me', requireUser, (c) => {
  const u = getUser(c.get('user').id)! // fresh balance
  return c.json({ userId: u.id, email: u.email, balance: u.balance, runpodAllowed: !!u.runpod_allowed })
})

api.get('/usage', requireUser, (c) => {
  const jobs = db
    .query(
      'SELECT id,model,status,tokens_in,tokens_out,cost,latency_ms,source,created_at FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
    )
    .all(c.get('user').id)
  return c.json({ jobs })
})

api.get('/keys', requireUser, (c) => {
  const keys = db
    .query('SELECT id,prefix,label,created_at,revoked_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC')
    .all(c.get('user').id)
  return c.json({ keys })
})

api.post('/keys', requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { key } = issueApiKey(c.get('user').id, body?.label)
  return c.json({ apiKey: key })
})

api.delete('/keys/:id', requireUser, (c) => {
  const res = db
    .query('UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL')
    .run(now(), c.req.param('id'), c.get('user').id)
  if (res.changes === 0) return c.json({ error: 'key not found' }, 404)
  return c.json({ ok: true })
})

// ---------- provider (provider-token auth) ----------
api.get('/provider/earnings', requireProvider, (c) => {
  const p = c.get('provider')
  const nodes = (db.query('SELECT * FROM nodes WHERE provider_id=?').all(p.id) as NodeRow[]).map(nodeStats)
  const agg = db
    .query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS earned FROM ledger WHERE provider_id=? AND type='PROVIDER_REWARD'",
    )
    .get(p.id) as { n: number; earned: number }
  return c.json({
    providerId: p.id,
    balance: p.balance,
    nodes,
    jobsServed: agg.n,
    earned: agg.earned,
    payoutWallet: p.payout_wallet,
    payoutsEnabled: solanaEnabled(),
  })
})

// Set the Solana wallet that on-chain $GGRID payouts are sent to.
api.post('/provider/wallet', requireProvider, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const wallet = String(body?.wallet ?? '').trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))
    return c.json({ error: 'valid Solana wallet address required' }, 400)
  db.query('UPDATE providers SET payout_wallet=? WHERE id=?').run(wallet, c.get('provider').id)
  return c.json({ ok: true, payoutWallet: wallet })
})

// Withdraw accrued balance as real $GGRID via the on-chain splitter.
api.post('/provider/payout', requireProvider, async (c) => {
  const r = await requestPayout(c.get('provider'))
  return c.json(r.body as object, r.status as 200)
})

api.get('/provider/payouts', requireProvider, (c) => {
  const payouts = db
    .query(
      'SELECT id,net_credits,gross_credits,raw_amount,wallet,signature,status,error,created_at,settled_at FROM payouts WHERE provider_id=? ORDER BY created_at DESC LIMIT 100',
    )
    .all(c.get('provider').id)
  return c.json({ payouts, payoutsEnabled: solanaEnabled() })
})

// ---------- public: network stats ----------
api.get('/stats', (c) => {
  const users = (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const done = (db.query("SELECT COUNT(*) AS n FROM jobs WHERE status='DONE'").get() as { n: number }).n
  const tokens = (db.query('SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM jobs').get() as { t: number }).t
  return c.json({ onlineNodes: onlineCount(), models: onlineModels(), users, totalJobs: done, totalTokens: tokens })
})

// ---------- admin (ADMIN_KEY) ----------
api.post('/admin/topup', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const amount = Number(body?.amount)
  if (!body?.userId || !getUser(body.userId)) return c.json({ error: 'valid userId required' }, 400)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'positive amount required' }, 400)
  db.transaction(() => {
    // Topping up = a paying user → allow the cloud (RunPod) fallback for them.
    db.query('UPDATE users SET balance = balance + ?, runpod_allowed = 1 WHERE id = ?').run(amount, body.userId)
    db.query('INSERT INTO ledger (id,type,amount,user_id,created_at) VALUES (?,?,?,?,?)').run(
      uid('led_'),
      'DEPOSIT',
      amount,
      body.userId,
      now(),
    )
  })()
  return c.json({ ok: true, userId: body.userId, balance: getUser(body.userId)!.balance })
})

api.get('/admin/nodes', requireAdmin, (c) => {
  const nodes = (db.query('SELECT * FROM nodes').all() as NodeRow[]).map(nodeStats)
  return c.json({ nodes })
})

api.delete('/admin/nodes/:id', requireAdmin, (c) => {
  const id = c.req.param('id')
  const res = db.query('DELETE FROM nodes WHERE id=?').run(id)
  if (res.changes === 0) return c.json({ error: 'node not found' }, 404)
  dropNode(id)
  return c.json({ ok: true })
})

// Un-quarantine a node (reset reliability) — manual "un-slash".
api.post('/admin/nodes/:id/reset', requireAdmin, (c) => {
  const res = db.query('UPDATE nodes SET reliability=1.0 WHERE id=?').run(c.req.param('id'))
  if (res.changes === 0) return c.json({ error: 'node not found' }, 404)
  return c.json({ ok: true })
})
