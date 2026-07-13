/* ============================================================
   GpuGrid gateway client.
   Same-origin in production (the Bun gateway serves this site AND the API);
   in dev, vite.config.ts proxies /api, /v1 and /health to the gateway.
   ============================================================ */

export interface Me {
  userId: string
  email: string | null
  balance: number
  freeRequests?: number // signup grant, spent before credits are needed
  runpodAllowed: boolean
}
export interface ApiKeyRow {
  id: string
  prefix: string
  label: string | null
  created_at: number
  revoked_at: number | null
}
export interface Job {
  id: string
  model: string
  status: string
  tokens_in: number
  tokens_out: number
  cost: number
  latency_ms: number
  source: string
  created_at: number
}
export interface Stats {
  onlineNodes: number
  models: string[]
  users: number
  totalJobs: number
  totalTokens: number
}
export interface NodeInfo {
  id: string
  models?: string[]
  online?: boolean
  reliability?: number
  region?: string | null
  [k: string]: unknown
}
export interface ProviderEarnings {
  providerId: string
  balance: number
  nodes: NodeInfo[]
  jobsServed: number
  earned: number
  payoutWallet: string | null
  payoutsEnabled: boolean
}
export interface Payout {
  id: string
  net_credits: number
  gross_credits: number
  raw_amount: number
  wallet: string | null
  signature: string | null
  status: string
  error: string | null
  created_at: number
  settled_at: number | null
}

export interface CreditIntent {
  reference: string
  transaction: string // base64 unsigned deposit tx
  credits: number
  rawAmount: string
  programId: string
  mint: string
  vault: string
  decimals: number
  rawPerCredit: number
}
export interface CreditStatus {
  status: 'PENDING' | 'CONFIRMED'
  credits?: number
  signature?: string
  balance?: number
  note?: string
}

// Live on-chain facts about the $GGRID mint (supply drops as the burn cut fires).
export interface TokenInfo {
  available: boolean
  symbol?: string
  name?: string
  network?: string
  mint?: string
  tokenProgram?: 'token' | 'token2022'
  decimals?: number
  supply?: number
  initialSupply?: number
  burned?: number
  mintAuthorityRenounced?: boolean
  freezeAuthorityRenounced?: boolean
  error?: string
}

// $GGRID staking. All amounts are RAW token units (strings, to survive u64).
export interface StakePool {
  available: boolean
  initialized?: boolean
  totalStaked?: string
  rewardPool?: string // everything sitting in the reward vault
  claimableRewards?: string // rewardPool minus strandedRewards - what stakers can actually earn
  strandedRewards?: string // landed while nothing was staked; unclaimable by design
  totalRewards?: string
  totalClaimed?: string
  minStake?: string // smallest position the program allows (raw units)
  decimals?: number
  error?: string
}
export interface StakePosition {
  available: boolean
  wallet: string
  staked?: string
  claimable?: string // exactly what `claim` would pay right now
  walletBalance?: string
  decimals?: number
  error?: string
}

// A GPU in the public marketplace (safe view - no url/secret).
export interface GpuNode {
  id: string
  gpu: string
  geo?: string | null // coarse "City, CC" of the node
  source: 'LOCAL' | 'RUNPOD'
  backend: 'cuda' | 'metal' | string
  chip: string | null
  memGb: number | null
  fanless: boolean
  thermalLimited: boolean
  tier: string
  state: string
  models: string[]
  priceFactor: number
  reliability: number
  perfTokensPerSec: number
  uptimePct: number
  activeJobs: number
  freeSlots: number
  online: boolean
  quarantined: boolean
}

// A wallet's real on-chain $GGRID balance (distinct from off-chain credits).
export interface WalletBalance {
  available: boolean
  wallet: string
  mint?: string
  decimals?: number
  rawAmount?: string
  uiAmount?: number
  error?: string
}

export interface Pricing {
  creditUnitUsd: number
  models: { model: string; in: number; out: number }[]
  defaultPrice: { in: number; out: number }
  feeSplit: { providerPct: number; burnPct: number; stakersPct: number; treasuryPct: number }
  ggrid: { rawPerCredit: number; decimals: number; tokensPerCredit: number }
  staking?: { enabled: boolean; minStake: string }
  free: {
    signupFreeRequests?: number
    playgroundPerIpPerDay?: number
    playgroundModel?: string
    freeMaxOutputTokens?: number
    signupBonusCredits: number
    signupBonusUsd: number
    rateLimitPerMin: number
    signupsPerIpPerDay: number
    maxOutputTokens: number
    communityGpusOnly: boolean
  }
}

// ---- anonymous playground (landing page "try it now" box) ----
export interface PlaygroundInfo {
  enabled: boolean
  model: string
  maxTokens: number
  perIpPerDay: number
  remaining: number
  budgetOkToday: boolean
  signupFreeRequests: number
}
export interface PlaygroundMeta {
  node: string
  gpu: string
  geo: string | null
  model: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}
export interface PlaygroundReply {
  answer: string
  meta: PlaygroundMeta
  remaining: number
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, opts: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError('network error - is the gateway reachable?', 0)
  }
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? `request failed (${res.status})`
    throw new ApiError(typeof msg === 'string' ? msg : 'request failed', res.status)
  }
  return data as T
}

export const api = {
  // ---- public ----
  signup: (email?: string) =>
    req<{ userId: string; apiKey: string; balance: number }>('/api/signup', { body: { email: email ?? null } }),
  // Exchange a Privy access token for a GGRID account (creates on first login).
  authPrivy: (privyToken: string) =>
    req<{ userId: string; balance: number; apiKey?: string; isNew: boolean }>('/api/auth/privy', { body: { token: privyToken } }),
  stats: () => req<Stats>('/api/stats'),
  pricing: () => req<Pricing>('/api/pricing'),
  // Anonymous playground: quota/status for the widget, and one free inference.
  playgroundInfo: () => req<PlaygroundInfo>('/api/playground'),
  playgroundAsk: (messages: { role: string; content: string }[]) =>
    req<PlaygroundReply>('/api/playground', { body: { messages } }),
  // Live $GGRID mint facts (supply, burn, renounced authorities).
  token: () => req<TokenInfo>('/api/token'),
  // GPU marketplace catalogue. all=true also lists offline nodes.
  nodes: (all = false) => req<{ nodes: GpuNode[] }>(`/api/nodes${all ? '?all=1' : ''}`),
  // Real on-chain $GGRID balance for a Solana wallet (public chain read).
  walletBalance: (wallet: string) => req<WalletBalance>(`/api/wallet/balance?wallet=${encodeURIComponent(wallet)}`),

  // ---- $GGRID staking (public reads; the staker signs the tx themselves) ----
  stakePool: () => req<StakePool>('/api/stake/pool'),
  stakePosition: (wallet: string) => req<StakePosition>(`/api/stake/position?wallet=${encodeURIComponent(wallet)}`),
  // Unsigned stake/unstake/claim tx (base64) for the wallet to sign + send.
  stakeTx: (action: 'stake' | 'unstake' | 'claim', wallet: string, tokens?: number) =>
    req<{ transaction: string; action: string; rawAmount: string }>('/api/stake/tx', {
      body: { action, wallet, tokens },
    }),
  models: () => req<{ data: { id: string }[] }>('/v1/models'),

  // ---- developer (apiKey) ----
  me: (token: string) => req<Me>('/api/me', { token }),
  usage: (token: string) => req<{ jobs: Job[] }>('/api/usage', { token }),
  listKeys: (token: string) => req<{ keys: ApiKeyRow[] }>('/api/keys', { token }),
  createKey: (token: string, label?: string) => req<{ apiKey: string }>('/api/keys', { token, body: { label } }),
  revokeKey: (token: string, id: string) => req<{ ok: true }>(`/api/keys/${id}`, { token, method: 'DELETE' }),

  // top up credits by depositing $GGRID on-chain: intent returns an unsigned
  // deposit tx + a reference; the wallet signs+sends it, then we poll status.
  creditsIntent: (token: string, wallet: string, tokens: number) =>
    req<CreditIntent>('/api/credits/intent', { token, body: { wallet, tokens } }),
  creditsStatus: (token: string, reference: string) =>
    req<CreditStatus>(`/api/credits/status?reference=${encodeURIComponent(reference)}`, { token }),
  // DEV ONLY: simulate a deposit (no wallet / no chain). 404s unless the gateway
  // runs with DEV_MOCK_TOPUP=1 - only wired up from the vite dev server.
  creditsDevTopup: (token: string, tokens: number) =>
    req<CreditStatus>('/api/credits/dev-topup', { token, body: { tokens } }),

  // ---- provider (Privy login, or providerToken) ----
  // Exchange a Privy access token for a provider account (creates on first login).
  authPrivyProvider: (privyToken: string) =>
    req<{ providerId: string; providerToken?: string; isNew: boolean }>('/api/auth/privy-provider', { body: { token: privyToken } }),
  // Issue/rotate the node token for the installer (auth: Privy token or provider token).
  providerNodeToken: (token: string) =>
    req<{ providerToken: string }>('/api/provider/node-token', { token, method: 'POST' }),
  createProvider: (payoutWallet?: string) =>
    req<{ providerId: string; providerToken: string }>('/api/providers', {
      body: { payoutWallet: payoutWallet ?? null },
    }),
  providerEarnings: (token: string) => req<ProviderEarnings>('/api/provider/earnings', { token }),
  setProviderWallet: (token: string, wallet: string) =>
    req<{ ok: true; payoutWallet: string }>('/api/provider/wallet', { token, body: { wallet } }),
  // Withdraw accrued balance as real $GGRID through the on-chain splitter.
  providerPayout: (token: string) =>
    req<any>('/api/provider/payout', { token, method: 'POST' }),
  providerPayouts: (token: string) =>
    req<{ payouts: Payout[]; payoutsEnabled: boolean }>('/api/provider/payouts', { token }),
}

/* 1 credit = 1 micro-USD. Render balances/costs as dollars. */
export const usd = (credits: number) => `$${(credits / 1_000_000).toFixed(2)}`

/* Render a credit balance as $GGRID tokens. tokensPerCredit comes from /api/pricing
   (= rawPerCredit / 10^decimals), so it stays correct if the token rate changes. */
export const ggrid = (credits: number, tokensPerCredit: number) => {
  const tokens = credits * tokensPerCredit
  const digits = tokens > 0 && tokens < 1 ? 6 : 2
  return `${tokens.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })} $GGRID`
}
