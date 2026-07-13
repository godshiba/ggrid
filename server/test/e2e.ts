// End-to-end test of the full backend with an in-memory DB and a mock node.
// Run: bun test/e2e.ts
import { server as mock } from './mock-node'

// Configure env BEFORE the app (and config) load.
process.env.DATABASE_URL = 'file::memory:'
process.env.ADMIN_KEY = 'test-admin'
process.env.LOG = 'off'
process.env.VERIFY_SUSTAINED_ROUNDS = '2' // keep the metal benchmark quick in tests
process.env.QUEUE_MAX_WAIT_MS = '500' // keep the capacity-queue timeout test quick
process.env.JOB_RETENTION_DAYS = '30' // exercise the usage-history purge
process.env.MAX_INFLIGHT_RPC = '2' // small so the RPC in-flight guard is testable
process.env.PUBLIC_RPC_RATE_PER_MIN = '30' // fixed so the per-IP limit test is deterministic
process.env.NODES_CACHE_TTL_MS = '0' // disable the /api/nodes cache so live-data assertions stay fresh
// The legacy $5-credit signup bonus is now a rollback knob (default 0). The suite
// pins it ON so every pre-free-tier test keeps its funded-user assumptions; the
// free-tier tests below build their own zero-balance users directly.
process.env.SIGNUP_BONUS = '5000000'
// Keep the suite hermetic: bun auto-loads .env / .env.local, and a developer with a
// real RPC + mint configured would otherwise flip the on-chain paths on and hit the
// network from tests. The disabled-path assertions below depend on these being unset.
delete process.env.SOLANA_RPC_URL
delete process.env.GGRID_MINT
delete process.env.GGRID_PROGRAM_ID
delete process.env.GGRID_AUTHORITY_KEY
delete process.env.GGRID_STAKE_PROGRAM_ID
// Dev-only demo flags (a populated .env.local sets these); the disabled-path tests below
// assert the untouched behaviour, so clear them too.
delete process.env.DEV_MOCK_STAKE
delete process.env.DEV_MOCK_TOPUP
const { buildApp } = await import('../src/app')
const app = buildApp()

const base = 'http://local.test'
const call = (path: string, init?: RequestInit) => app.fetch(new Request(base + path, init))
const jpost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

let pass = 0
let fail = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.error('  ✗', name)
  }
}

console.log('GpuGrid backend e2e\n')

// --- accounts ---
const su = await (await jpost('/api/signup', { email: 'dev@test' }, { 'x-forwarded-for': '10.0.0.1' })).json()
check('signup returns apiKey', typeof su.apiKey === 'string' && su.apiKey.startsWith('ggrid_sk_'))
check('signup grants bonus balance', su.balance > 0)
const auth = { authorization: `Bearer ${su.apiKey}` }

const pv = await (await jpost('/api/providers', { email: 'kolya@test' })).json()
check('provider returns token', typeof pv.providerToken === 'string')
const provAuth = { authorization: `Bearer ${pv.providerToken}` }

// --- node registration + heartbeat ---
const mockUrl = `http://localhost:${mock.port}`
const reg = await (await jpost('/nodes/register', { url: mockUrl, models: ['llama3:8b'], providerToken: pv.providerToken })).json()
check('node registered', !!reg.nodeId && !!reg.nodeSecret)
const hb = await (await jpost(`/nodes/${reg.nodeId}/heartbeat`, { status: 'ONLINE', models: ['llama3:8b'] }, { 'x-node-secret': reg.nodeSecret })).json()
check('heartbeat ok', hb.ok === true)

// --- models ---
const models = await (await call('/v1/models')).json()
check('models includes llama3:8b', models.data.some((m: any) => m.id === 'llama3:8b'))

// --- chat (non-stream) + billing ---
const chatRes = await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [{ role: 'user', content: 'hi' }] }, auth)
const chat = await chatRes.json()
check('chat returns 200', chatRes.status === 200)
check('chat has assistant content', !!chat.choices?.[0]?.message?.content)

// --- account auth ---
const me = await (await call('/api/me', { headers: auth })).json()
check('me uses token auth (no userId param)', me.userId === su.userId)
check('balance decreased', me.balance < su.balance)
check('me unauthorized → 401', (await call('/api/me')).status === 401)
check('free user is NOT runpod-allowed', me.runpodAllowed === false)

// --- provider credited ---
const earn = await (await call('/api/provider/earnings', { headers: provAuth })).json()
check('provider earned > 0', earn.earned > 0)
check('provider node shows online', earn.nodes.some((n: any) => n.online === true))

// --- streaming + billing ---
const streamRes = await jpost('/v1/chat/completions', { model: 'llama3:8b', stream: true, messages: [{ role: 'user', content: 'hi' }] }, auth)
check('stream is event-stream', streamRes.headers.get('content-type')?.includes('event-stream') === true)
const text = await streamRes.text()
check('stream terminates with [DONE]', text.includes('[DONE]'))
const me2 = await (await call('/api/me', { headers: auth })).json()
check('streaming also charged', me2.balance < me.balance)

// --- embeddings ---
const emb = await jpost('/v1/embeddings', { model: 'llama3:8b', input: 'hello' }, auth)
const embJson = await emb.json()
check('embeddings 200', emb.status === 200)
check('embeddings returns vector', Array.isArray(embJson.data?.[0]?.embedding))

// --- output cap: a huge max_tokens is clamped, not rejected ---
const clamp = await jpost('/v1/chat/completions', { model: 'llama3:8b', max_tokens: 9_999_999, messages: [{ role: 'user', content: 'hi' }] }, auth)
check('huge max_tokens still served (clamped)', clamp.status === 200)

// --- API key management ---
const keys1 = await (await call('/api/keys', { headers: auth })).json()
check('keys list has default key', keys1.keys.length >= 1)
const newKey = await (await jpost('/api/keys', { label: 'second' }, auth)).json()
check('issue second key', newKey.apiKey?.startsWith('ggrid_sk_'))
const keys2 = await (await call('/api/keys', { headers: auth })).json()
const secondId = keys2.keys.find((k: any) => k.label === 'second')?.id
const rev = await call(`/api/keys/${secondId}`, { method: 'DELETE', headers: auth })
check('revoke key ok', rev.status === 200)
check('revoked key → 401', (await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [] }, { authorization: `Bearer ${newKey.apiKey}` })).status === 401)

// --- admin top-up enables paid (RunPod-allowed) tier ---
const before = (await (await call('/api/me', { headers: auth })).json()).balance
const topup = await jpost('/api/admin/topup', { userId: su.userId, amount: 1_000_000 }, { 'x-admin-key': 'test-admin' })
check('admin topup ok', topup.status === 200)
const meAfter = await (await call('/api/me', { headers: auth })).json()
check('balance increased by topup', meAfter.balance === before + 1_000_000)
check('topup enables runpod for user', meAfter.runpodAllowed === true)
check('admin without key → 403', (await jpost('/api/admin/topup', { userId: su.userId, amount: 1 }, {})).status === 403)

// --- retry: dead node first, good node serves ---
await (await jpost('/nodes/register', { url: 'http://127.0.0.1:1', models: ['qwen2.5:7b'], providerToken: pv.providerToken })).json().then((r: any) =>
  jpost(`/nodes/${r.nodeId}/heartbeat`, { models: ['qwen2.5:7b'] }, { 'x-node-secret': r.nodeSecret }),
)
await (await jpost('/nodes/register', { url: mockUrl, models: ['qwen2.5:7b'], providerToken: pv.providerToken })).json().then((r: any) =>
  jpost(`/nodes/${r.nodeId}/heartbeat`, { models: ['qwen2.5:7b'] }, { 'x-node-secret': r.nodeSecret }),
)
const retryRes = await jpost('/v1/chat/completions', { model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] }, auth)
check('retry routes around dead node → 200', retryRes.status === 200)

// --- capacity + auth edges ---
check('unknown model → 503', (await jpost('/v1/chat/completions', { model: 'ghost:1b', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 503)
check('bad key → 401', (await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [] }, { authorization: 'Bearer nope' })).status === 401)

// --- signup anti-abuse: per-IP cap ---
let okCount = 0
let blocked = false
for (let i = 0; i < 5; i++) {
  const r = await jpost('/api/signup', {}, { 'x-forwarded-for': '203.0.113.7' })
  if (r.status === 200) okCount++
  else if (r.status === 429) blocked = true
}
check('signup per-IP cap (3 ok, rest 429)', okCount === 3 && blocked)

// --- node economics: a cheaper node lowers the developer's charge ---
const regCheap = await (await jpost('/nodes/register', { url: mockUrl, models: ['mistral:7b'], providerToken: pv.providerToken, priceFactor: 0.5 })).json()
await jpost(`/nodes/${regCheap.nodeId}/heartbeat`, { models: ['mistral:7b'] }, { 'x-node-secret': regCheap.nodeSecret })
check('cheap-node chat 200', (await jpost('/v1/chat/completions', { model: 'mistral:7b', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 200)
const usage = await (await call('/api/usage', { headers: auth })).json()
const mistralJob = usage.jobs.find((j: any) => j.model === 'mistral:7b')
// base cost @ (1280,845) = 191; priceFactor 0.5 → ceil(95.5) = 96
check('price_factor halves the charge', mistralJob?.cost === 96)

// --- uptime + performance surfaced to the provider ---
const earn2 = await (await call('/api/provider/earnings', { headers: provAuth })).json()
const cheapNode = earn2.nodes.find((n: any) => n.id === regCheap.nodeId)
check('node reports perf (tokens/sec)', cheapNode?.perfTokensPerSec > 0)
check('node reports uptime%', typeof cheapNode?.uptimePct === 'number' && cheapNode.uptimePct >= 0 && cheapNode.uptimePct <= 100)
check('node reports priceFactor 0.5', cheapNode?.priceFactor === 0.5)
check('node jobsDone >= 1', cheapNode?.jobsDone >= 1)

// --- auto-slashing: a flaky node is quarantined out of routing, then reset ---
const regBad = await (await jpost('/nodes/register', { url: 'http://127.0.0.1:1', models: ['phantom:7b'], providerToken: pv.providerToken })).json()
await jpost(`/nodes/${regBad.nodeId}/heartbeat`, { models: ['phantom:7b'] }, { 'x-node-secret': regBad.nodeSecret })
let lastStatus = 0
for (let i = 0; i < 9; i++) {
  lastStatus = (await jpost('/v1/chat/completions', { model: 'phantom:7b', messages: [{ role: 'user', content: 'x' }] }, auth)).status
}
check('flaky node quarantined → 503', lastStatus === 503)
const adminNodes = await (await call('/api/admin/nodes', { headers: { 'x-admin-key': 'test-admin' } })).json()
check('quarantined flag set', adminNodes.nodes.find((n: any) => n.id === regBad.nodeId)?.quarantined === true)
check('admin reset un-quarantines', (await jpost(`/api/admin/nodes/${regBad.nodeId}/reset`, {}, { 'x-admin-key': 'test-admin' })).status === 200)
const adminNodes2 = await (await call('/api/admin/nodes', { headers: { 'x-admin-key': 'test-admin' } })).json()
check('reliability restored after reset', adminNodes2.nodes.find((n: any) => n.id === regBad.nodeId)?.reliability === 1)

// --- on-chain payouts: wallet management + disabled-path behavior (Solana off in tests) ---
const setWallet = await jpost('/api/provider/wallet', { wallet: 'So11111111111111111111111111111111111111112' }, provAuth)
check('provider sets payout wallet', setWallet.status === 200)
check('reject malformed wallet', (await jpost('/api/provider/wallet', { wallet: 'nope' }, provAuth)).status === 400)
const earnW = await (await call('/api/provider/earnings', { headers: provAuth })).json()
check('earnings echoes payout wallet', earnW.payoutWallet === 'So11111111111111111111111111111111111111112')
check('earnings reports payouts disabled', earnW.payoutsEnabled === false)
const payoutOff = await jpost('/api/provider/payout', {}, provAuth)
check('payout without Solana config → 503', payoutOff.status === 503)
const phist = await (await call('/api/provider/payouts', { headers: provAuth })).json()
check('payouts history is empty + flagged disabled', Array.isArray(phist.payouts) && phist.payouts.length === 0 && phist.payoutsEnabled === false)

const pricing = await (await call('/api/pricing')).json()

// --- $GGRID token facts (no RPC/mint in tests -> must degrade, never invent supply) ---
const tok = await (await call('/api/token')).json()
check('token facts degrade gracefully when unconfigured', tok.available === false && tok.supply === undefined)

// --- $GGRID staking: disabled-path behavior + validation (stake program unset in tests) ---
check('pricing exposes staking block (disabled)', pricing.staking && pricing.staking.enabled === false)
const stPool = await (await call('/api/stake/pool')).json()
check('stake pool degrades gracefully when unconfigured', stPool.available === false)
const stPos = await (await call('/api/stake/position?wallet=So11111111111111111111111111111111111111112')).json()
check('stake position degrades gracefully when unconfigured', stPos.available === false)
check('stake position rejects malformed wallet', (await call('/api/stake/position?wallet=nope')).status === 400)
const stTx = await jpost('/api/stake/tx', { action: 'stake', wallet: 'So11111111111111111111111111111111111111112', tokens: 10 })
check('stake tx without config → 503', stTx.status === 503)
check('pricing publishes the MIN_STAKE floor', pricing.staking?.minStake === '1000000')
// Input is rejected before the availability check, so these are 400 not 503.
const stBad = await jpost('/api/stake/tx', { action: 'restake', wallet: 'So11111111111111111111111111111111111111112' })
check('stake tx rejects unknown action → 400', stBad.status === 400)
const stZero = await jpost('/api/stake/tx', { action: 'stake', wallet: 'So11111111111111111111111111111111111111112', tokens: 0 })
check('stake tx rejects non-positive amount → 400', stZero.status === 400)

// --- $GGRID staking: the client's on-chain encoding, verified without a validator ---
// Anchor matches accounts POSITIONALLY and reads account data by fixed byte offsets,
// so a swapped key or a stale offset is a silent, funds-losing bug. lib.rs asserts
// `Pool::LEN == Pool::INIT_SPACE` at compile time; these lock the TS side to the same
// numbers, and pin the account order against the #[derive(Accounts)] structs.
{
  const { buildStakeIx, decodePool, decodeStake, discriminator, claimableOf, assertMinStake, MIN_STAKE_RAW, POOL_SIZE, STAKE_ACCOUNT_SIZE } =
    await import('../src/stake')
  const web3 = await import('@solana/web3.js')

  check('MIN_STAKE_RAW matches lib.rs', MIN_STAKE_RAW === 1_000_000n)
  check('Pool account size matches Pool::LEN + 8', POOL_SIZE === 193)
  check('StakeAccount size matches StakeAccount::LEN + 8', STAKE_ACCOUNT_SIZE === 73)
  // sha256("global:stake").slice(0,8) - the Anchor sighash rule, pinned as bytes.
  check('stake discriminator is stable', [...discriminator('stake')].join() === '206,176,202,18,200,209,179,108')
  check('unstake discriminator is stable', [...discriminator('unstake')].join() === '90,95,107,42,205,124,50,225')
  check('claim discriminator is stable', [...discriminator('claim')].join() === '62,198,214,193,213,159,108,210')

  // Round-trip a Pool through the exact borsh layout the program writes.
  const key = (n: number) => new web3.PublicKey(new Uint8Array(32).fill(n))
  const pool = Buffer.alloc(POOL_SIZE)
  key(1).toBuffer().copy(pool, 8)        // authority
  key(2).toBuffer().copy(pool, 40)       // mint
  key(3).toBuffer().copy(pool, 72)       // stake_vault
  key(4).toBuffer().copy(pool, 104)      // reward_vault
  pool.writeBigUInt64LE(5_000_000n, 136) // total_staked
  pool.writeBigUInt64LE(7n, 144)         // acc_reward_per_share (u128 lo)
  pool.writeBigUInt64LE(0n, 152)         //                      (u128 hi)
  pool.writeBigUInt64LE(11n, 160)        // last_reward_balance
  pool.writeBigUInt64LE(13n, 168)        // total_claimed
  pool.writeBigUInt64LE(17n, 176)        // total_rewards
  pool.writeBigUInt64LE(19n, 184)        // stranded_rewards
  const dp = decodePool(pool, web3)
  check('decodePool reads every field at the right offset',
    dp.rewardVault === key(4).toBase58() && dp.totalStaked === 5_000_000n && dp.accRewardPerShare === 7n &&
    dp.lastRewardBalance === 11n && dp.totalClaimed === 13n && dp.totalRewards === 17n && dp.strandedRewards === 19n)

  // u128 is little-endian: high limb must be shifted, not added.
  const hi = Buffer.from(pool)
  hi.writeBigUInt64LE(1n, 152)
  check('decodePool reads the u128 high limb', decodePool(hi, web3).accRewardPerShare === (1n << 64n) + 7n)

  const sk = Buffer.alloc(STAKE_ACCOUNT_SIZE)
  key(9).toBuffer().copy(sk, 8)     // owner
  sk.writeBigUInt64LE(2_000_000n, 40) // amount
  sk.writeBigUInt64LE(3n, 48)         // reward_debt (u128 lo)
  sk.writeBigUInt64LE(0n, 56)         //             (u128 hi)
  sk.writeBigUInt64LE(23n, 64)        // pending
  const ds = decodeStake(sk)
  check('decodeStake reads every field at the right offset', ds.amount === 2_000_000n && ds.rewardDebt === 3n && ds.pending === 23n)

  // A truncated/oversized account must be rejected, not silently misread.
  let drifted = false
  try { decodePool(Buffer.alloc(POOL_SIZE + 8), web3) } catch { drifted = true }
  check('decodePool rejects a layout that drifted', drifted)

  // Account order + signer/writable flags, against the #[derive(Accounts)] structs.
  const a = {
    pool: 'POOL', user: 'USER', stakePda: 'STAKE_PDA', mint: 'MINT', userToken: 'USER_TOKEN',
    stakeVault: 'STAKE_VAULT', rewardVault: 'REWARD_VAULT', tokenProgram: 'TOKEN_PROG', systemProgram: 'SYS_PROG',
  }
  const shape = (ks: any[]) => ks.map((k) => `${k.pubkey}${k.isSigner ? '+s' : ''}${k.isWritable ? '+w' : ''}`).join(' ')

  const stakeIx = buildStakeIx('stake', a, 1_000_000n)
  check('stake account order matches Stake<\'info>',
    shape(stakeIx.keys) === 'POOL+w USER+s+w STAKE_PDA+w MINT USER_TOKEN+w STAKE_VAULT+w REWARD_VAULT TOKEN_PROG SYS_PROG')
  check('stake data = discriminator + u64 LE amount',
    stakeIx.data.length === 16 && stakeIx.data.readBigUInt64LE(8) === 1_000_000n &&
    stakeIx.data.subarray(0, 8).equals(discriminator('stake')))

  const unstakeIx = buildStakeIx('unstake', a, 2_000_000n)
  check('unstake account order matches Unstake<\'info> (no system_program)',
    shape(unstakeIx.keys) === 'POOL+w USER+s STAKE_PDA+w MINT USER_TOKEN+w STAKE_VAULT+w REWARD_VAULT TOKEN_PROG')

  const claimIx = buildStakeIx('claim', a, 0n)
  check('claim account order matches Claim<\'info> (no stake_vault, reward_vault is mut)',
    shape(claimIx.keys) === 'POOL+w USER+s STAKE_PDA+w MINT USER_TOKEN+w REWARD_VAULT+w TOKEN_PROG')
  check('claim carries no amount', claimIx.data.length === 8)

  let zeroRejected = false
  try { buildStakeIx('stake', a, 0n) } catch { zeroRejected = true }
  check('buildStakeIx rejects a zero amount', zeroRejected)

  // MIN_STAKE applies to the resulting POSITION, not to the amount moved.
  const throws = (fn: () => void) => { try { fn(); return false } catch { return true } }
  check('a fresh stake below the floor is rejected', throws(() => assertMinStake('stake', 0n, 999_999n)))
  check('a fresh stake at the floor is allowed', !throws(() => assertMinStake('stake', 0n, 1_000_000n)))
  check('a small top-up onto a healthy position is allowed', !throws(() => assertMinStake('stake', 10_000_000n, 1n)))
  check('unstaking down to dust is rejected', throws(() => assertMinStake('unstake', 10_000_000n, 9_500_000n)))
  check('a full exit is always allowed', !throws(() => assertMinStake('unstake', 10_000_000n, 10_000_000n)))

  // claimableOf must equal what `claim` would actually pay.
  const p0 = { rewardVault: '', totalStaked: 2_000_000n, accRewardPerShare: 0n, lastRewardBalance: 0n, totalClaimed: 0n, totalRewards: 0n, strandedRewards: 0n }
  const s0 = { amount: 1_000_000n, rewardDebt: 0n, pending: 0n }
  check('claimableOf folds in un-accrued rewards (half of 1000)', claimableOf(p0, s0, 1000n) === 500n)
  check('claimableOf never promises more than the vault holds', claimableOf(p0, { ...s0, pending: 10_000n }, 200n) === 200n)
  // Rewards banked while the pool was empty are already past the baseline -> not claimable.
  const stranded = { ...p0, totalStaked: 1_000_000n, lastRewardBalance: 900n, strandedRewards: 900n }
  check('claimableOf pays nothing from a stranded backlog', claimableOf(stranded, s0, 900n) === 0n)
}

// --- GPU marketplace: public catalogue + pinning a specific node ---
const regGpu = await (await jpost('/nodes/register', { url: mockUrl, models: ['gemma2:9b'], gpuInfo: 'NVIDIA RTX 4090', providerToken: pv.providerToken })).json()
await jpost(`/nodes/${regGpu.nodeId}/heartbeat`, { models: ['gemma2:9b'] }, { 'x-node-secret': regGpu.nodeSecret })
const cat = await (await call('/api/nodes')).json()
const listed = cat.nodes.find((n: any) => n.id === regGpu.nodeId)
check('/api/nodes lists the online node', !!listed)
check('/api/nodes shows GPU label from gpuInfo', listed?.gpu === 'NVIDIA RTX 4090')
check('/api/nodes never leaks url/secret', listed && !('url' in listed) && !('secret_hash' in listed))
check('/api/nodes reports free slots', typeof listed?.freeSlots === 'number' && listed.freeSlots > 0)
// pin to that exact node → served
const pinOk = await jpost('/v1/chat/completions', { model: 'gemma2:9b', messages: [{ role: 'user', content: 'hi' }] }, { ...auth, 'x-ggrid-node': regGpu.nodeId })
check('pinned request to a valid node → 200', pinOk.status === 200)
// pin to a node that doesn't serve the model → 409, no fallback
const pinWrongModel = await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [{ role: 'user', content: 'hi' }] }, { ...auth, 'x-ggrid-node': regGpu.nodeId })
check('pin to node not serving the model → 409', pinWrongModel.status === 409)
// pin to an unknown node id → 409
const pinUnknown = await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [{ role: 'user', content: 'hi' }] }, { ...auth, 'x-ggrid-node': 'nod_does_not_exist' })
check('pin to unknown node → 409', pinUnknown.status === 409)
// pin via the body `node` field works too (and is stripped, not forwarded)
const pinBody = await jpost('/v1/chat/completions', { model: 'gemma2:9b', node: regGpu.nodeId, messages: [{ role: 'user', content: 'hi' }] }, auth)
check('pin via body.node field → 200', pinBody.status === 200)

// --- Apple-Silicon ("metal") hardware verification gate ---
const { verifyNode } = await import('../src/verify')

// A metal node registers provisional and does NOT serve until it passes the bench.
const regM5 = await (
  await jpost('/nodes/register', {
    url: mockUrl,
    models: ['metal-test:1'],
    providerToken: pv.providerToken,
    backend: 'metal',
    chip: 'Apple M5 Max',
    memGb: 48,
    fanless: false,
  })
).json()
check('metal node registers provisional', regM5.state === 'provisional')
const beforeVerify = await (await call('/api/nodes?all=1')).json()
check('provisional metal node hidden from marketplace', !beforeVerify.nodes.some((n: any) => n.id === regM5.nodeId))
check(
  'provisional metal node does not serve → 503',
  (await jpost('/v1/chat/completions', { model: 'metal-test:1', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 503,
)

await verifyNode(regM5.nodeId) // fast mock clears the floor
const m5Row = (await (await call('/api/nodes?all=1')).json()).nodes.find((n: any) => n.id === regM5.nodeId)
check('verified metal node appears', !!m5Row)
check('metal node reports chip', m5Row?.chip === 'Apple M5 Max')
check('metal node reports memory', m5Row?.memGb === 48)
check('metal node has a measured speed', m5Row?.perfTokensPerSec > 0)
check(
  'verified metal node serves → 200',
  (await jpost('/v1/chat/completions', { model: 'metal-test:1', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 200,
)

// An M2 node is declined by policy (M4/M5 only).
const regM2 = await (
  await jpost('/nodes/register', { url: mockUrl, models: ['metal-old:1'], providerToken: pv.providerToken, backend: 'metal', chip: 'Apple M2' })
).json()
await verifyNode(regM2.nodeId)
const m2Row = (await (await call('/api/admin/nodes', { headers: { 'x-admin-key': 'test-admin' } })).json()).nodes.find(
  (n: any) => n.id === regM2.nodeId,
)
check('M2 node is rejected', m2Row?.state === 'rejected')
check(
  'rejected M2 node does not serve → 503',
  (await jpost('/v1/chat/completions', { model: 'metal-old:1', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 503,
)

// --- Resilient routing: capacity queue (failover is covered by the dead-node retry test above) ---
const { waitForSlot, notifySlotFree } = await import('../src/queue')
const { modelHasOnlineNode } = await import('../src/registry')
check('modelHasOnlineNode true for a served model', modelHasOnlineNode('metal-test:1') === true)
check('modelHasOnlineNode false for an unknown model', modelHasOnlineNode('does-not-exist:1') === false)
// A queued request wakes the moment a slot frees.
let slotFree = false
const waitP = waitForSlot(() => slotFree)
setTimeout(() => {
  slotFree = true
  notifySlotFree()
}, 60)
check('queue wakes when a slot frees', (await waitP) === true)
// It gives up (→ caller 503s) after QUEUE_MAX_WAIT_MS if no slot ever frees.
const qt0 = Date.now()
const timedOut = await waitForSlot(() => false)
check('queue times out when no slot frees', timedOut === false && Date.now() - qt0 >= 400)

// --- privacy: no prompt/answer content stored + usage-history retention purge ---
{
  const { purgeExpired } = await import('../src/retention')
  const { db: rdb, now: rnow, uid: ruid } = await import('../src/db')
  const oldId = ruid('job_')
  const freshId = ruid('job_')
  const old = rnow() - 40 * 24 * 60 * 60_000 // older than the 30d window
  const ins = rdb.query(
    'INSERT INTO jobs (id,user_id,node_id,model,status,tokens_in,tokens_out,cost,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  ins.run(oldId, su.userId, null, 'llama3:8b', 'DONE', 1, 1, 1, old, old)
  ins.run(freshId, su.userId, null, 'llama3:8b', 'DONE', 1, 1, 1, rnow(), rnow())
  const removed = purgeExpired()
  const stillOld = rdb.query('SELECT id FROM jobs WHERE id=?').get(oldId)
  const stillFresh = rdb.query('SELECT id FROM jobs WHERE id=?').get(freshId)
  check('retention purges usage history older than the window', removed >= 1 && !stillOld)
  check('retention keeps usage history inside the window', !!stillFresh)
  // the jobs table has no column for prompt/answer text — content is never stored
  const cols = (rdb.query('PRAGMA table_info(jobs)').all() as any[]).map((r) => r.name)
  check('jobs table stores no prompt/answer content', !cols.some((c: string) => /prompt|message|body|content|answer|completion_text/.test(c)))
  const priv = await (await call('/api/privacy')).json()
  check('privacy endpoint: prompts not stored', priv.storesPromptContent === false && priv.storesCompletionContent === false)
  check('privacy endpoint: reports retention window', priv.usageMetadataRetentionDays === 30)
}

// --- integrity: spot-check verification (replay on a 2nd node + a judge model) ---
{
  const { makeMockNode } = await import('./mock-node')
  const { spotCheck } = await import('../src/spotcheck')
  const { db: sdb } = await import('../src/db')

  const nodeA = makeMockNode({ models: ['audit:1'] }) // honest content + acts as judge
  const nodeB = makeMockNode({ models: ['audit:1'], content: 'A completely different answer.' })
  const regA = await (await jpost('/nodes/register', { url: `http://localhost:${nodeA.port}`, models: ['audit:1'], providerToken: pv.providerToken })).json()
  await jpost(`/nodes/${regA.nodeId}/heartbeat`, { models: ['audit:1'] }, { 'x-node-secret': regA.nodeSecret })
  const regB = await (await jpost('/nodes/register', { url: `http://localhost:${nodeB.port}`, models: ['audit:1'], providerToken: pv.providerToken })).json()
  await jpost(`/nodes/${regB.nodeId}/heartbeat`, { models: ['audit:1'] }, { 'x-node-secret': regB.nodeSecret })

  const relBefore = (sdb.query('SELECT reliability FROM nodes WHERE id=?').get(regA.nodeId) as any).reliability
  const verdict = await spotCheck({
    model: 'audit:1',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    firstNodeId: regA.nodeId,
    firstAnswer: 'The capital of France is Paris.',
  })
  const relAfter = (sdb.query('SELECT reliability FROM nodes WHERE id=?').get(regA.nodeId) as any).reliability
  check('spot-check rules a diverging node INCONSISTENT', verdict === 'inconsistent')
  check('spot-check penalizes the diverging node', relAfter < relBefore)

  // no second node serving the model → cannot compare → unknown, no penalty
  const verdict2 = await spotCheck({ model: 'nobody-serves:1', messages: [{ role: 'user', content: 'hi' }], firstNodeId: regA.nodeId, firstAnswer: 'hello' })
  check('spot-check is inconclusive with no second node', verdict2 === 'unknown')

  nodeA.stop()
  nodeB.stop()
}

// --- integrity: canary prompts (catch a node faking the model it serves) ---
{
  const { makeMockNode } = await import('./mock-node')
  const { probeNode, runCanaryRound } = await import('../src/canary')
  const { getNode } = await import('../src/registry')
  const { db: cdb } = await import('../src/db')

  const honest = makeMockNode({ models: ['canary-good:1'] }) // answers canaries correctly
  const spoof = makeMockNode({ models: ['canary-bad:1'], wrong: true }) // fakes a smaller model
  const regGood = await (await jpost('/nodes/register', { url: `http://localhost:${honest.port}`, models: ['canary-good:1'], providerToken: pv.providerToken })).json()
  await jpost(`/nodes/${regGood.nodeId}/heartbeat`, { models: ['canary-good:1'] }, { 'x-node-secret': regGood.nodeSecret })
  const regBad = await (await jpost('/nodes/register', { url: `http://localhost:${spoof.port}`, models: ['canary-bad:1'], providerToken: pv.providerToken })).json()
  await jpost(`/nodes/${regBad.nodeId}/heartbeat`, { models: ['canary-bad:1'] }, { 'x-node-secret': regBad.nodeSecret })

  const goodProbe = await probeNode(getNode(regGood.nodeId)!, 'canary-good:1', 5)
  const badProbe = await probeNode(getNode(regBad.nodeId)!, 'canary-bad:1', 5)
  check('canary: honest node passes every probe', goodProbe.asked === 5 && goodProbe.failed === 0)
  check('canary: spoof node fails its probes', badProbe.asked > 0 && badProbe.failed === badProbe.asked)

  const relBadBefore = (cdb.query('SELECT reliability FROM nodes WHERE id=?').get(regBad.nodeId) as any).reliability
  const relGoodBefore = (cdb.query('SELECT reliability FROM nodes WHERE id=?').get(regGood.nodeId) as any).reliability
  await runCanaryRound()
  const badRow = cdb.query('SELECT reliability, verify_error FROM nodes WHERE id=?').get(regBad.nodeId) as any
  const relGoodAfter = (cdb.query('SELECT reliability FROM nodes WHERE id=?').get(regGood.nodeId) as any).reliability
  check('canary round penalizes the spoof node', badRow.reliability < relBadBefore)
  check('canary round records why the spoof node failed', typeof badRow.verify_error === 'string' && badRow.verify_error.includes('canaries'))
  check('canary round leaves the honest node alone', relGoodAfter === relGoodBefore)

  honest.stop()
  spoof.stop()
}

// --- DoS hardening: per-IP rate limit on public RPC-backed reads ---
{
  const ip = { 'x-forwarded-for': '198.51.100.42' }
  let got429 = 0
  let ok = 0
  for (let i = 0; i < 31; i++) {
    const r = await call('/api/token', { headers: ip }) // limit default 30/min
    if (r.status === 429) got429++
    else ok++
  }
  check('public RPC read: per-IP limit kicks in (30 ok, then 429)', ok === 30 && got429 === 1)
  check('public RPC read: a different IP is unaffected', (await call('/api/token', { headers: { 'x-forwarded-for': '198.51.100.99' } })).status === 200)

  // the public GPU catalogue (/api/nodes) is the same class — also per-IP limited
  const ipN = { 'x-forwarded-for': '198.51.100.70' }
  let nOk = 0
  let n429 = 0
  for (let i = 0; i < 31; i++) {
    const r = await call('/api/nodes', { headers: ipN })
    if (r.status === 429) n429++
    else nOk++
  }
  check('/api/nodes: per-IP limit kicks in (30 ok, then 429)', nOk === 30 && n429 === 1)
}

// --- DoS hardening: RPC in-flight guard (cap = MAX_INFLIGHT_RPC = 2) ---
{
  const { rpcGuard, RpcBusyError, memo } = await import('../src/cache')
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const held = [rpcGuard.run(() => gate), rpcGuard.run(() => gate)] // fill the 2 slots
  await new Promise((r) => setTimeout(r, 5))
  let rejected = false
  try {
    await rpcGuard.run(async () => 'x')
  } catch (e) {
    rejected = e instanceof RpcBusyError
  }
  check('rpcGuard rejects over the in-flight cap', rejected)
  release()
  await Promise.all(held)
  check('rpcGuard admits again once a slot frees', (await rpcGuard.run(async () => 'ok')) === 'ok')

  // memo single-flights + caches within TTL (a flood collapses to one call)
  let calls = 0
  const slow = () => new Promise<number>((r) => setTimeout(() => { calls++; r(calls) }, 15))
  const [a, b] = await Promise.all([memo('k', 1000, slow), memo('k', 1000, slow)])
  check('memo single-flights concurrent identical reads', a === b && calls === 1)
  check('memo serves from cache within TTL', (await memo('k', 1000, slow)) === a && calls === 1)
}

// --- DoS hardening: unbounded resource creation is capped ---
{
  const ip = { 'x-forwarded-for': '198.51.100.50' }
  let provOk = 0
  let prov429 = false
  for (let i = 0; i < 11; i++) {
    const r = await jpost('/api/providers', { email: `flood${i}@t` }, ip) // cap default 10/day/IP
    if (r.status === 200) provOk++
    else if (r.status === 429) prov429 = true
  }
  check('provider creation is per-IP capped (10 ok, rest 429)', provOk === 10 && prov429)

  // nodes-per-provider cap (default 50): a fresh provider can't register unbounded nodes
  const floodPv = await (await jpost('/api/providers', { email: 'nodeflood@t' }, { 'x-forwarded-for': '198.51.100.51' })).json()
  let nodeOk = 0
  let node429 = false
  for (let i = 0; i < 51; i++) {
    const r = await jpost('/nodes/register', { url: 'http://127.0.0.1:1', models: ['floodmodel:1'], providerToken: floodPv.providerToken })
    if (r.status === 200) nodeOk++
    else if (r.status === 429) node429 = true
  }
  check('nodes-per-provider is capped (50 ok, then 429)', nodeOk === 50 && node429)
}

// --- DoS hardening: oversized request bodies are rejected before parsing ---
{
  const huge = { email: 'x'.repeat(70_000) } // > 64 KB default cap
  const r = await jpost('/api/signup', huge, { 'x-forwarded-for': '198.51.100.60' })
  check('oversized request body → 413', r.status === 413)
}

// --- playground: anonymous inference on the sandbox fund ---
{
  const { SANDBOX_USER_ID } = await import('../src/sandbox')
  const { db: pdb } = await import('../src/db')
  const sandboxBal = () => (pdb.query('SELECT balance FROM users WHERE id=?').get(SANDBOX_USER_ID) as any).balance

  // widget bootstrap
  const info = await (await call('/api/playground', { headers: { 'x-forwarded-for': '203.0.113.10' } })).json()
  check('playground GET reports enabled + full quota', info.enabled === true && info.remaining === 5 && info.model === 'llama3:8b')

  // happy path: no account, real (mock) node, meta line included
  const before = sandboxBal()
  const p1res = await jpost('/api/playground', { prompt: 'hello grid' }, { 'x-forwarded-for': '203.0.113.10' })
  const p1 = await p1res.json()
  check('playground answers without any account', p1res.status === 200 && typeof p1.answer === 'string' && p1.answer.length > 0)
  check('playground meta has gpu/tokens/cost', !!p1.meta && typeof p1.meta.gpu === 'string' && p1.meta.tokensOut > 0 && p1.meta.costUsd >= 0)
  check('playground meta exposes the geo field', 'geo' in (p1.meta ?? {}))
  check('playground reports remaining quota', p1.remaining === 4)
  check('playground bills the sandbox fund', sandboxBal() < before)
  const led = pdb.query("SELECT COUNT(*) AS n FROM ledger WHERE user_id=? AND type='CHARGE'").get(SANDBOX_USER_ID) as any
  check('sandbox CHARGE recorded in ledger', led.n >= 1)

  // whatever model/max_tokens the body asks for is ignored
  const p2 = await (await jpost('/api/playground', { prompt: 'x', model: 'gpt-4', max_tokens: 999999 }, { 'x-forwarded-for': '203.0.113.10' })).json()
  check('playground forces its own model', p2.meta?.model === 'llama3:8b')

  // per-IP daily cap (default 5): 2 spent above, 3 more pass, the 6th → 429
  let okCount = 0
  let capped = 0
  for (let i = 0; i < 4; i++) {
    const r = await jpost('/api/playground', { prompt: 'ping' }, { 'x-forwarded-for': '203.0.113.10' })
    if (r.status === 200) okCount++
    else if (r.status === 429) capped++
  }
  check('playground per-IP daily cap (5/day) enforced', okCount === 3 && capped === 1)
  check('another IP is still served', (await jpost('/api/playground', { prompt: 'hi' }, { 'x-forwarded-for': '203.0.113.11' })).status === 200)

  // browser origin gate: our site passes, a foreign site is rejected
  check('playground allows our origin', (await jpost('/api/playground', { prompt: 'hi' }, { 'x-forwarded-for': '203.0.113.12', origin: 'https://gpugrid.app' })).status === 200)
  check('playground blocks foreign origins', (await jpost('/api/playground', { prompt: 'hi' }, { 'x-forwarded-for': '203.0.113.13', origin: 'https://evil.example' })).status === 403)

  // oversized prompt → 400 (bounds tokens_in)
  check('playground rejects oversized prompts', (await jpost('/api/playground', { prompt: 'y'.repeat(3000) }, { 'x-forwarded-for': '203.0.113.14' })).status === 400)

  // daily budget roof: a fat CHARGE today pauses the free tier honestly
  pdb.query('INSERT INTO ledger (id,type,amount,user_id,created_at) VALUES (?,?,?,?,?)').run('led_burntest', 'CHARGE', -3_000_000, SANDBOX_USER_ID, Date.now())
  check('playground pauses when the daily budget is spent', (await jpost('/api/playground', { prompt: 'hi' }, { 'x-forwarded-for': '203.0.113.15' })).status === 503)
  pdb.query("DELETE FROM ledger WHERE id='led_burntest'").run()

  // fund empty → same honest pause
  const saved = sandboxBal()
  pdb.query('UPDATE users SET balance=0 WHERE id=?').run(SANDBOX_USER_ID)
  check('playground pauses when the fund is empty', (await jpost('/api/playground', { prompt: 'hi' }, { 'x-forwarded-for': '203.0.113.16' })).status === 503)
  pdb.query('UPDATE users SET balance=? WHERE id=?').run(saved, SANDBOX_USER_ID)
}

// --- free tier: signup request counter billed to the sandbox fund ---
{
  const { SANDBOX_USER_ID } = await import('../src/sandbox')
  const { db: fdb } = await import('../src/db')
  const sandboxBal = () => (fdb.query('SELECT balance FROM users WHERE id=?').get(SANDBOX_USER_ID) as any).balance

  const fu = await (await jpost('/api/signup', { email: 'freetier@test' }, { 'x-forwarded-for': '203.0.113.20' })).json()
  check('signup reports free requests', fu.freeRequests === 20)
  const fAuth = { authorization: `Bearer ${fu.apiKey}` }

  // zero the balance so only the counter can pay; shrink it for the exhaustion test
  fdb.query('UPDATE users SET balance=0, free_requests=2 WHERE id=?').run(fu.userId)
  const before = sandboxBal()
  const fr = await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [{ role: 'user', content: 'hi' }] }, fAuth)
  check('zero-balance user runs on free requests', fr.status === 200)
  const fme = await (await call('/api/me', { headers: fAuth })).json()
  check('free request decrements the counter', fme.freeRequests === 1)
  check('free request never touches the user balance', fme.balance === 0)
  check('free request billed the sandbox fund', sandboxBal() < before)
  const fusage = await (await call('/api/usage', { headers: fAuth })).json()
  check('free job appears in the USER usage history', fusage.jobs.length >= 1)

  // counter exhausted + no balance → an honest 402
  fdb.query('UPDATE users SET free_requests=0 WHERE id=?').run(fu.userId)
  const out = await jpost('/v1/chat/completions', { model: 'llama3:8b', messages: [{ role: 'user', content: 'hi' }] }, fAuth)
  check('no balance + no free requests → 402', out.status === 402)

  // pricing advertises the new tier
  const pr = await (await call('/api/pricing')).json()
  check('pricing advertises 20 free requests', pr.free.signupFreeRequests === 20 && pr.free.playgroundPerIpPerDay === 5)
}

// --- node geo (hermetic: private IPs never resolve; stored geo is exposed) ---
{
  const { resolveGeo } = await import('../src/geo')
  check('geo: private/unknown IPs resolve to null', (await resolveGeo('192.168.1.10')) === null && (await resolveGeo('unknown')) === null)

  const { db: gdb } = await import('../src/db')
  gdb.query('UPDATE nodes SET geo=? WHERE id=?').run('Berlin, DE', reg.nodeId)
  const cat = await (await call('/api/nodes', { headers: { 'x-forwarded-for': '203.0.113.30' } })).json()
  const entry = cat.nodes.find((n: any) => n.id === reg.nodeId)
  check('/api/nodes exposes node geo', entry?.geo === 'Berlin, DE')
  const pg = await (await jpost('/api/playground', { prompt: 'where are you' }, { 'x-forwarded-for': '203.0.113.31' })).json()
  check('playground meta carries the node geo', pg.meta?.geo === 'Berlin, DE')
}

// --- stats ---
const stats = await (await call('/api/stats')).json()
check('stats.totalJobs >= 3', stats.totalJobs >= 3)

console.log(`\n${pass} passed, ${fail} failed`)
mock.stop()
process.exit(fail ? 1 : 0)
