export interface UserRow {
  id: string
  email: string | null
  balance: number
  runpod_allowed: number
  free_requests: number // signup grant, billed to the sandbox fund while balance is empty
  created_at: number
}

export interface NodeRow {
  id: string
  provider_id: string
  url: string
  secret_hash: string
  source: 'LOCAL' | 'RUNPOD'
  models: string // JSON array
  gpu_info: string | null // JSON
  reliability: number
  price_factor: number
  perf: number // EWMA throughput, tokens/sec
  jobs_done: number
  // --- Apple-Silicon ("metal") tier + verification gate ---
  backend: 'cuda' | 'metal' | string
  chip: string | null // e.g. 'Apple M5 Max'
  mem_gb: number | null
  fanless: number // 1 = MacBook Air (no active cooling)
  caps: string // JSON array of endpoints: ['chat','embeddings']
  state: 'provisional' | 'verified' | 'rejected' | string
  bench_perf: number // measured sustained tokens/sec at verify time
  thermal_ratio: number | null // last/first sustained sample (<1 = throttled)
  thermal_limited: number // 1 = throttles under sustained load
  tier: string | null
  verify_error: string | null
  verified_at: number | null
  geo: string | null // coarse "City, CC" resolved from the node's address (never the IP itself)
  created_at: number
}

export interface ProviderRow {
  id: string
  email: string | null
  token_hash: string
  payout_wallet: string | null
  balance: number
  privy_id: string | null
  created_at: number
}

export interface Usage {
  in: number
  out: number
}
