// End-to-end test of the full backend with an in-memory DB and a mock node.
// Run: bun test/e2e.ts
import { server as mock } from './mock-node'

// Configure env BEFORE the app (and config) load.
process.env.DATABASE_URL = 'file::memory:'
process.env.ADMIN_KEY = 'test-admin'
process.env.LOG = 'off'
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

// --- Apple-Silicon ("metal") node type - joins and serves like any node ---
const regMac = await (
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
check('metal node registers verified', regMac.state === 'verified')
const macNodes = await (await call('/api/nodes?all=1')).json()
const macRow = macNodes.nodes.find((n: any) => n.id === regMac.nodeId)
check('metal node appears in marketplace', !!macRow)
check('metal node reports backend=metal', macRow?.backend === 'metal')
check('metal node reports its chip', macRow?.chip === 'Apple M5 Max')
check('metal node reports memory', macRow?.memGb === 48)
const macServe = await jpost('/v1/chat/completions', { model: 'metal-test:1', messages: [{ role: 'user', content: 'hi' }] }, auth)
check('metal node serves immediately → 200', macServe.status === 200)

// A fanless MacBook Air is flagged (from hardware, no benchmark) for burst labelling.
const regAir = await (
  await jpost('/nodes/register', {
    url: mockUrl,
    models: ['metal-air:1'],
    providerToken: pv.providerToken,
    backend: 'metal',
    chip: 'Apple M4',
    fanless: true,
  })
).json()
const airNodes = await (await call('/api/nodes?all=1')).json()
const airRow = airNodes.nodes.find((n: any) => n.id === regAir.nodeId)
check('fanless metal node flagged fanless', airRow?.fanless === true)
check('fanless metal node still serves', (await jpost('/v1/chat/completions', { model: 'metal-air:1', messages: [{ role: 'user', content: 'hi' }] }, auth)).status === 200)

// --- stats ---
const stats = await (await call('/api/stats')).json()
check('stats.totalJobs >= 3', stats.totalJobs >= 3)

console.log(`\n${pass} passed, ${fail} failed`)
mock.stop()
process.exit(fail ? 1 : 0)
