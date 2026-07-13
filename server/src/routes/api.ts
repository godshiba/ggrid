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
import { onlineCount, onlineModels, dropNode, nodeStats, listNodes, getNode, selectNode, gpuLabel } from '../registry'
import { verifyNode } from '../verify'
import { allowSignup, allowIp, allowProviderCreate, ipRemaining, DAY_MS } from '../ratelimit'
import { memo, rpcGuard, RpcBusyError } from '../cache'
import { tryProxy } from '../proxy'
import { SANDBOX_USER_ID, sandboxBudgetOk } from '../sandbox'
import { config } from '../config'
import { solanaEnabled, solanaReadable, getWalletBalance, getTokenInfo } from '../solana'
import { stakeEnabled, poolInfo, position as stakePosition, buildTx as buildStakeTx, MIN_STAKE_RAW } from '../stake'
import { requestPayout } from '../payouts'
import { createIntent, checkIntent } from '../deposits'
import { priceTable, defaultPrice, priceFor } from '../pricing'
import type { NodeRow } from '../types'

function clientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
}

// Per-IP throttle for the public, keyless RPC-backed reads (token / stake / wallet).
function rpcRateOk(c: any): boolean {
  return allowIp(clientIp(c), config.security.publicRpcRatePerMin)
}

// Run a public RPC read behind the short-TTL cache and the global in-flight cap, so a
// flood collapses to at most one call per key per window and never piles up unbounded.
function cachedRpc<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return memo(key, config.security.rpcCacheTtlMs, () => rpcGuard.run(fn))
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
  // Free tier = a request counter billed to the sandbox fund (bonus credits are 0
  // by default now; SIGNUP_BONUS stays as a rollback knob).
  const user = createUser(body?.email ?? null, config.signupBonus, config.signupFreeRequests)
  const { key } = issueApiKey(user.id, 'default')
  return c.json({ userId: user.id, apiKey: key, balance: user.balance, freeRequests: user.free_requests })
})

api.post('/providers', async (c) => {
  if (!allowProviderCreate(clientIp(c)))
    return c.json({ error: { message: 'too many providers created from your network today', type: 'rate_limit' } }, 429)
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
  if (existing)
    return c.json({ userId: existing.id, balance: existing.balance, freeRequests: existing.free_requests ?? 0, isNew: false })

  // new account — same per-IP anti-abuse cap as /signup
  if (!allowSignup(clientIp(c)))
    return c.json({ error: { message: 'signup limit reached for your network, try later', type: 'rate_limit' } }, 429)
  const user = createUserWithPrivy(claims.privyId, null, config.signupBonus, config.signupFreeRequests)
  const { key } = issueApiKey(user.id, 'default')
  return c.json({ userId: user.id, balance: user.balance, freeRequests: user.free_requests, apiKey: key, isNew: true })
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
  return c.json({
    userId: u.id,
    email: u.email,
    balance: u.balance,
    freeRequests: u.free_requests ?? 0,
    runpodAllowed: !!u.runpod_allowed,
  })
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

// Withdraw accrued balance as real $GGRID through the on-chain splitter.
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
  if (!rpcRateOk(c)) return c.json({ error: 'rate limit exceeded' }, 429)
  if (!solanaReadable()) return c.json({ available: false, wallet })
  try {
    const b = await cachedRpc(`wbal:${wallet}`, () => getWalletBalance(wallet))
    return c.json({ available: true, wallet, ...b })
  } catch (e) {
    if (e instanceof RpcBusyError) return c.json({ error: 'service busy, retry shortly' }, 503)
    return c.json({ available: false, wallet, error: String((e as Error)?.message ?? e).slice(0, 200) })
  }
})

// ---------- public: $GGRID token facts ----------
// Live from chain: supply reflects tokens already burned (the fee split no longer burns), and the
// renounced authorities are the trust claim - so neither is hard-coded here.
// `available:false` when the gateway has no RPC/mint (UI degrades gracefully).
api.get('/token', async (c) => {
  if (!rpcRateOk(c)) return c.json({ error: 'rate limit exceeded' }, 429)
  if (!solanaReadable()) return c.json({ available: false })
  try {
    const t = await cachedRpc('token', () => getTokenInfo())
    return c.json({ available: true, ...t, symbol: 'GGRID', name: 'GpuGrid', network: 'Solana' })
  } catch (e) {
    if (e instanceof RpcBusyError) return c.json({ error: 'service busy, retry shortly' }, 503)
    return c.json({ available: false, error: String((e as Error)?.message ?? e).slice(0, 200) })
  }
})

// ---------- public: $GGRID staking ----------
// Stakers earn the 20% cut of every job. All three actions are signed by the staker,
// so the gateway only reads the pool and builds unsigned transactions.
const SOL_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// DEV ONLY: canned, initialized pool/position so the console Staking panel can be
// viewed locally without a deployed program. Gated on DEV_MOCK_STAKE; never prod.
const MOCK_POOL = {
  available: true, initialized: true, decimals: 6, minStake: '1000000',
  totalStaked: '12480000000000', rewardPool: '84320420000', claimableRewards: '84320420000',
  strandedRewards: '0', totalRewards: '84320420000', totalClaimed: '15660000000',
}
const MOCK_POS = {
  available: true, decimals: 6,
  staked: '250000000000', claimable: '1206840000', walletBalance: '48900000000',
}

api.get('/stake/pool', async (c) => {
  if (!rpcRateOk(c)) return c.json({ error: 'rate limit exceeded' }, 429)
  if (!stakeEnabled()) return c.json(config.devMockStake ? MOCK_POOL : { available: false })
  try {
    return c.json({ available: true, ...(await cachedRpc('stakepool', () => poolInfo())) })
  } catch (e) {
    if (e instanceof RpcBusyError) return c.json({ error: 'service busy, retry shortly' }, 503)
    return c.json({ available: false, error: String((e as Error)?.message ?? e).slice(0, 200) })
  }
})

api.get('/stake/position', async (c) => {
  const wallet = String(c.req.query('wallet') ?? '').trim()
  if (!SOL_WALLET.test(wallet)) return c.json({ error: 'valid Solana wallet address required' }, 400)
  if (!rpcRateOk(c)) return c.json({ error: 'rate limit exceeded' }, 429)
  if (!stakeEnabled()) return c.json(config.devMockStake ? { wallet, ...MOCK_POS } : { available: false, wallet })
  try {
    return c.json({ available: true, ...(await cachedRpc(`stakepos:${wallet}`, () => stakePosition(wallet))) })
  } catch (e) {
    if (e instanceof RpcBusyError) return c.json({ error: 'service busy, retry shortly' }, 503)
    return c.json({ available: false, wallet, error: String((e as Error)?.message ?? e).slice(0, 200) })
  }
})

// Returns an unsigned stake/unstake/claim tx (base64) for the wallet to sign + send.
// Input is validated before the availability check so a malformed request is a 400
// whether or not this gateway has staking configured.
api.post('/stake/tx', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const action = String(body?.action ?? '')
  const wallet = String(body?.wallet ?? '').trim()
  if (!['stake', 'unstake', 'claim'].includes(action)) return c.json({ error: 'action must be stake, unstake or claim' }, 400)
  if (!SOL_WALLET.test(wallet)) return c.json({ error: 'valid Solana wallet address required' }, 400)

  let raw = 0n
  if (action !== 'claim') {
    const tokens = Number(body?.tokens)
    if (!Number.isFinite(tokens) || tokens <= 0) return c.json({ error: 'positive $GGRID amount required' }, 400)
    raw = BigInt(Math.round(tokens * 10 ** config.solana.decimals))
    if (raw <= 0n) return c.json({ error: 'amount too small' }, 400)
    // The MIN_STAKE floor applies to the resulting POSITION, not to this amount - a
    // 0.5 $GGRID top-up onto an existing stake is legal. buildTx reads the caller's
    // current position and enforces it there.
  }
  if (!stakeEnabled()) return c.json({ error: 'staking is not enabled on this gateway yet' }, 503)
  try {
    const transaction = await buildStakeTx(action as 'stake' | 'unstake' | 'claim', wallet, raw)
    return c.json({ transaction, action, rawAmount: raw.toString() })
  } catch (e) {
    return c.json({ error: String((e as Error)?.message ?? e).slice(0, 200) }, 400)
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
    // Staking: is the stake pool live on this gateway? Stakers earn the 20% cut.
    // minStake is the floor the program enforces on a position (raw units).
    staking: { enabled: stakeEnabled() || config.devMockStake, minStake: MIN_STAKE_RAW.toString() },
    // Fee split applied to every job (percent).
    feeSplit: { providerPct: 75, burnPct: 0, stakersPct: 20, treasuryPct: 5 },
    free: {
      // The free tier is a REQUEST COUNTER billed to the sandbox fund; the old
      // credit bonus is 0 by default (SIGNUP_BONUS remains a rollback knob).
      signupFreeRequests: config.signupFreeRequests,
      playgroundPerIpPerDay: config.playground.perIpPerDay, // anonymous, no account
      playgroundModel: config.playground.model,
      freeMaxOutputTokens: config.playground.maxTokens, // free requests are capped like the playground
      signupBonusCredits: config.signupBonus,
      signupBonusUsd: config.signupBonus / 1_000_000,
      rateLimitPerMin: config.rateLimitPerMin,
      signupsPerIpPerDay: config.signupPerIpPerDay,
      maxOutputTokens: config.maxOutputTokens,
      communityGpusOnly: !config.freeTierRunpod, // free tier can't spend the paid cloud budget
    },
  })
})

// ---------- public: privacy & integrity posture ----------
// Truthful, machine-readable statement of what the gateway does with request
// content and how it audits nodes. Lets the site/docs state guarantees without
// hardcoding them. No auth: these are public policy facts, not secrets.
api.get('/privacy', (c) => {
  return c.json({
    // Prompt and completion CONTENT is never written to the DB or the logs.
    storesPromptContent: config.privacy.storePrompts, // always false
    storesCompletionContent: config.privacy.storePrompts, // always false
    // Per-job metadata kept (model, token counts, cost, latency, status).
    usageMetadataRetentionDays: config.privacy.retentionDays, // 0 = until account deletion
    // Node integrity audits currently active on this gateway.
    integrity: {
      spotCheck: config.integrity.spotcheckRate > 0, // replay a sample on a 2nd node + judge
      spotCheckRate: config.integrity.spotcheckRate,
      canary: config.integrity.canaryEnabled, // known-answer probes catch model spoofing
    },
  })
})

// ---------- public: GPU marketplace ----------
// Safe catalogue of live GPUs so developers can pick a node to pin (via the
// x-ggrid-node header). Never exposes node url/secret. ?all=1 includes offline.
api.get('/nodes', async (c) => {
  if (!rpcRateOk(c)) return c.json({ error: 'rate limit exceeded' }, 429)
  const includeOffline = c.req.query('all') === '1'
  // Short-TTL cache (single-flight): the catalogue changes slowly, so a flood of
  // reads collapses to at most one full nodes scan per key per window. TTL 0 = off.
  const ttl = config.security.nodesCacheTtlMs
  const nodes =
    ttl > 0 ? await memo(`nodes:${includeOffline}`, ttl, async () => listNodes({ includeOffline })) : listNodes({ includeOffline })
  return c.json({ nodes })
})

// ---------- public: network stats ----------
api.get('/stats', (c) => {
  const users = (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const done = (db.query("SELECT COUNT(*) AS n FROM jobs WHERE status='DONE'").get() as { n: number }).n
  const tokens = (db.query('SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS t FROM jobs').get() as { t: number }).t
  return c.json({ onlineNodes: onlineCount(), models: onlineModels(), users, totalJobs: done, totalTokens: tokens })
})

// ---------- public: anonymous playground ----------
// The landing-page "try it before signing up" box. No account needed; the spend
// is bounded three ways: per-IP daily cap (real IP — Caddy rewrites XFF on prod),
// the sandbox fund's daily budget, and the fund balance itself. Jobs run through
// the ORDINARY pipeline on the sandbox account, so the provider still earns 75%.
// Community GPUs only (never the paid RunPod fallback), fixed model, output capped.

// Browsers must call from our own site; curl/no-Origin passes (IP cap still holds).
function playgroundOriginOk(c: any): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return config.playground.allowedOrigins.some((a) => host === a || host.endsWith('.' + a))
  } catch {
    return false
  }
}

// Widget bootstrap: what to render (chat box / limit CTA / busy notice).
api.get('/playground', (c) => {
  const pg = config.playground
  return c.json({
    enabled: pg.enabled,
    model: pg.model,
    maxTokens: pg.maxTokens,
    perIpPerDay: pg.perIpPerDay,
    remaining: pg.enabled ? ipRemaining('pg:' + clientIp(c), pg.perIpPerDay) : 0,
    budgetOkToday: pg.enabled && sandboxBudgetOk(),
    signupFreeRequests: config.signupFreeRequests,
  })
})

api.post('/playground', async (c) => {
  const pg = config.playground
  if (!pg.enabled) return c.json({ error: { message: 'playground is disabled', type: 'disabled' } }, 404)
  if (!playgroundOriginOk(c)) return c.json({ error: { message: 'origin not allowed', type: 'forbidden' } }, 403)

  // Budget gate BEFORE the IP gate — a paused free tier must not eat the caller's quota.
  if (!sandboxBudgetOk())
    return c.json(
      { error: { message: "today's free budget is spent — come back tomorrow, or sign up and top up", type: 'budget' } },
      503,
    )

  // 'pg:' prefix — allowIp's buckets are shared with the RPC limiter; namespacing
  // the key keeps a playground quota from colliding with the per-minute RPC quota.
  const ipKey = 'pg:' + clientIp(c)
  if (!allowIp(ipKey, pg.perIpPerDay, DAY_MS))
    return c.json(
      {
        error: {
          message: `free limit reached (${pg.perIpPerDay}/day) — sign up to get ${config.signupFreeRequests} free requests`,
          type: 'rate_limit',
        },
        remaining: 0,
      },
      429,
    )

  const body = await c.req.json().catch(() => null)
  const messages: { role: string; content: string }[] = Array.isArray(body?.messages)
    ? body.messages
    : typeof body?.prompt === 'string' && body.prompt.trim()
      ? [{ role: 'user', content: body.prompt }]
      : []
  const shaped = messages.length > 0 && messages.every((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
  if (!shaped) return c.json({ error: { message: 'send { prompt: "..." } or { messages: [...] }' } }, 400)
  const chars = messages.reduce((s, m) => s + m.content.length, 0)
  if (chars > pg.maxPromptChars)
    return c.json({ error: { message: `prompt too long (max ${pg.maxPromptChars} characters)` } }, 400)

  // Model and output cap are FORCED — whatever the body asked for is ignored.
  const reqBody = { model: pg.model, messages, stream: false, max_tokens: pg.maxTokens }
  const remaining = ipRemaining(ipKey, pg.perIpPerDay)

  // Up to two attempts on RANDOM eligible nodes (see selectNode: cheapest-first
  // would let a provider undercut his way into the free fund). No capacity queue,
  // no cloud fallback — the playground answers fast or declines honestly.
  const tried = new Set<string>()
  for (let i = 0; i < 2; i++) {
    const node = selectNode(pg.model, tried, { endpoint: 'chat', pick: 'random' })
    if (!node) break
    const t0 = Date.now()
    const res = await tryProxy({ userId: SANDBOX_USER_ID, node, model: pg.model, body: reqBody, endpoint: 'chat' })
    if (res) {
      const data: any = await res.json().catch(() => null)
      const answer = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : ''
      const usage = { in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 }
      const cost = Math.max(0, Math.ceil(priceFor(pg.model, usage) * node.price_factor))
      return c.json({
        answer,
        // The line that sells the grid: which GPU, where, and what it really cost.
        meta: {
          node: node.id,
          gpu: gpuLabel(node),
          geo: node.geo ?? null,
          model: pg.model,
          tokensIn: usage.in,
          tokensOut: usage.out,
          costUsd: cost / 1_000_000,
          latencyMs: Date.now() - t0,
        },
        remaining,
      })
    }
    tried.add(node.id)
  }
  return c.json(
    { error: { message: 'network busy — every community GPU is taken right now, try again in a minute', type: 'no_capacity' } },
    503,
  )
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

// Re-run the hardware benchmark / verification gate for a node (e.g. after a Mac
// was rejected, or to re-measure thermals). Runs in the background.
api.post('/admin/nodes/:id/verify', requireAdmin, (c) => {
  const id = c.req.param('id')
  if (!getNode(id)) return c.json({ error: 'node not found' }, 404)
  void verifyNode(id).catch(() => {})
  return c.json({ ok: true, message: 'verification started' })
})
