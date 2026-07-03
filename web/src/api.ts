/* ============================================================
   GpuGrid gateway client.
   Same-origin in production (the Bun gateway serves this site AND the API);
   in dev, vite.config.ts proxies /api, /v1 and /health to the gateway.
   ============================================================ */

export interface Me {
  userId: string
  email: string | null
  balance: number
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
  stats: () => req<Stats>('/api/stats'),
  models: () => req<{ data: { id: string }[] }>('/v1/models'),

  // ---- developer (apiKey) ----
  me: (token: string) => req<Me>('/api/me', { token }),
  usage: (token: string) => req<{ jobs: Job[] }>('/api/usage', { token }),
  listKeys: (token: string) => req<{ keys: ApiKeyRow[] }>('/api/keys', { token }),
  createKey: (token: string, label?: string) => req<{ apiKey: string }>('/api/keys', { token, body: { label } }),
  revokeKey: (token: string, id: string) => req<{ ok: true }>(`/api/keys/${id}`, { token, method: 'DELETE' }),

  // ---- provider (providerToken) ----
  createProvider: (payoutWallet?: string) =>
    req<{ providerId: string; providerToken: string }>('/api/providers', {
      body: { payoutWallet: payoutWallet ?? null },
    }),
  providerEarnings: (token: string) => req<ProviderEarnings>('/api/provider/earnings', { token }),
  setProviderWallet: (token: string, wallet: string) =>
    req<{ ok: true; payoutWallet: string }>('/api/provider/wallet', { token, body: { wallet } }),
  providerPayout: (token: string) => req<any>('/api/provider/payout', { token, method: 'POST' }),
  providerPayouts: (token: string) => req<{ payouts: Payout[]; payoutsEnabled: boolean }>('/api/provider/payouts', { token }),
}

/* 1 credit = 1 micro-USD. Render balances/costs as dollars. */
export const usd = (credits: number) => `$${(credits / 1_000_000).toFixed(2)}`
