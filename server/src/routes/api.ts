import { Hono } from 'hono'
import { db, uid, now } from '../db'
import {
  createUser,
  issueApiKey,
  getUser,
  getUserByPrivyId,
  createUserWithPrivy,
  getProviderByPrivyId,
  createProviderWithPrivy,
  rotateProviderToken,
  sha256,
  randToken,
  requireUser,
  requireProvider,
  requireAdmin,
  type Env,
} from '../auth'
import { verifyPrivyToken } from '../privy'
import { onlineCount, onlineModels, dropNode, nodeStats, listNodes } from '../registry'
import { allowSignup } from '../ratelimit'
import { config } from '../config'
import { solanaEnabled, solanaReadable, getWalletBalance } from '../solana'
import { requestPayout } from '../payouts'
import { createIntent, checkIntent } from '../deposits'
import { priceTable, defaultPrice } from '../pricing'
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

// ---------- Privy login exchange ----------
// The console logs in with Privy, then posts the Privy access token here. We
// find-or-create the GGRID account tied to that Privy identity; on first login
// it gets the free-credit bonus + a default API key (returned once). Afterwards
// the console authenticates its calls with the Privy token directly (requireUser).
api.post('/auth/privy', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const claims = await verifyPrivyToken(String(body?.token ?? ''))
  if (!claims) return c.json({ error: { message: 'invalid or expired Privy session', type: 'auth' } }, 401)

  const existing = getUserByPrivyId(claims.privyId)
  if (existing) return c.json({ userId: existing.id, balance: existing.balance, isNew: false })

  // new account — same per-IP anti-abuse cap as /signup
  if (!allowSignup(clientIp(c)))
    return c.json({ error: { message: 'signup limit reached for your network, try later', type: 'rate_limit' } }, 429)
  const user = createUserWithPrivy(claims.privyId, null, config.signupBonus)
  const { key } = issueApiKey(user.id, 'default')
  return c.json({ userId: user.id, balance: user.balance, apiKey: key, isNew: true })
})

// Provider console login via Privy: find-or-create the provider tied to this Privy
// identity. On first login we return the node token once (for the installer);
// afterwards the console authenticates with the Privy token directly (requireProvider).
api.post('/auth/privy-provider', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const claims = await verifyPrivyToken(String(body?.token ?? ''))
  if (!claims) return c.json({ error: { message: 'invalid or expired Privy session', type: 'auth' } }, 401)

  const existing = getProviderByPrivyId(claims.privyId)
  if (existing) return c.json({ providerId: existing.id, isNew: false })

  const { provider, token } = createProviderWithPrivy(claims.privyId)
  return c.json({ providerId: provider.id, providerToken: token, isNew: true })
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

// Issue/rotate the node token used by the installer (PROVIDER_TOKEN=...). Needed
// because a Privy-logged-in provider never sees a raw token otherwise; the old
// token stops working for new registrations, live nodes are unaffected.
api.post('/provider/node-token', requireProvider, (c) => {
  const token = rotateProviderToken(c.get('provider').id)
  return c.json({ providerToken: token })
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

// ---------- developer: buy credits with $GGRID (on-chain top-up) ----------
// intent → returns an unsigned deposit tx + a reference; the wallet signs+sends it.
api.post('/credits/intent', requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const r = await createIntent(c.get('user').id, String(body?.wallet ?? ''), Number(body?.tokens))
  return c.json(r.body as object, r.status as 200)
})

// status → polled after sending; finds the on-chain deposit and credits the user.
api.get('/credits/status', requireUser, async (c) => {
  const reference = String(c.req.query('reference') ?? '')
  if (!reference) return c.json({ error: 'reference required' }, 400)
  const r = await checkIntent(c.get('user').id, reference)
  return c.json(r.body as object, r.status as 200)
})

// DEV ONLY: simulate a $GGRID deposit with no wallet / no chain, so the funding
// flow is testable on a local stand. Disabled unless DEV_MOCK_TOPUP=1 (never prod).
api.post('/credits/dev-topup', requireUser, async (c) => {
  if (!config.devMockTopup) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const tokens = Number(body?.tokens)
  if (!Number.isFinite(tokens) || tokens <= 0) return c.json({ error: 'positive tokens required' }, 400)
  // Mirror createIntent() exactly: rawAmount = tokens × 10^decimals, credits = rawAmount / rawPerCredit.
  const rawAmount = BigInt(Math.round(tokens * 10 ** config.solana.decimals))
  const credits = Number(rawAmount / BigInt(config.solana.rawPerCredit))
  if (credits <= 0) return c.json({ error: 'amount too small' }, 400)
  const userId = c.get('user').id
  db.transaction(() => {
    db.query('UPDATE users SET balance = balance + ?, runpod_allowed = 1 WHERE id = ?').run(credits, userId)
    db.query('INSERT INTO ledger (id,type,amount,user_id,created_at) VALUES (?,?,?,?,?)').run(
      uid('led_'),
      'DEPOSIT',
      credits,
      userId,
      now(),
    )
  })()
  return c.json({ status: 'CONFIRMED', credits, balance: getUser(userId)!.balance, dev: true })
})

// ---------- public: on-chain $GGRID wallet balance ----------
// The REAL token balance sitting in a Solana wallet, read live from chain. This is
// distinct from the user's off-chain spendable credit balance (/api/me): it's what
// they actually hold on-chain and can deposit. `available:false` when the gateway
// has no RPC/mint configured (e.g. token not live) — the UI degrades gracefully.
api.get('/wallet/balance', async (c) => {
  const wallet = String(c.req.query('wallet') ?? '').trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))
    return c.json({ error: 'valid Solana wallet address required' }, 400)
  if (!solanaReadable()) return c.json({ available: false, wallet })
  try {
    const b = await getWalletBalance(wallet)
    return c.json({ available: true, wallet, ...b })
  } catch (e) {
    return c.json({ available: false, wallet, error: String((e as Error)?.message ?? e).slice(0, 200) })
  }
})

// ---------- public: pricing + plan limits (powers the pricing/docs pages) ----------
api.get('/pricing', (c) => {
  return c.json({
    // 1 credit = 1 micro-USD; prices below are credits per 1,000,000 tokens.
    creditUnitUsd: 0.000001,
    models: priceTable(),
    defaultPrice,
    // $GGRID conversion so the UI can show balances/costs in tokens.
    // tokens = credits × tokensPerCredit (= rawPerCredit / 10^decimals).
    ggrid: {
      rawPerCredit: config.solana.rawPerCredit,
      decimals: config.solana.decimals,
      tokensPerCredit: config.solana.rawPerCredit / 10 ** config.solana.decimals,
    },
    // Fee split applied to every job (percent).
    feeSplit: { providerPct: 75, burnPct: 12.5, stakersPct: 7.5, treasuryPct: 5 },
    free: {
      signupBonusCredits: config.signupBonus,
      signupBonusUsd: config.signupBonus / 1_000_000,
      rateLimitPerMin: config.rateLimitPerMin,
      signupsPerIpPerDay: config.signupPerIpPerDay,
      maxOutputTokens: config.maxOutputTokens,
      communityGpusOnly: !config.freeTierRunpod, // free tier can't spend the paid cloud budget
    },
  })
})

// ---------- public: GPU marketplace ----------
// Safe catalogue of live GPUs so developers can pick a node to pin (via the
// x-ggrid-node header). Never exposes node url/secret. ?all=1 includes offline.
api.get('/nodes', (c) => {
  const includeOffline = c.req.query('all') === '1'
  return c.json({ nodes: listNodes({ includeOffline }) })
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
