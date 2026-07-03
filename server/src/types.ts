export interface UserRow {
  id: string
  email: string | null
  balance: number
  runpod_allowed: number
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
  created_at: number
}

export interface ProviderRow {
  id: string
  email: string | null
  token_hash: string
  payout_wallet: string | null
  balance: number
  created_at: number
}

export interface Usage {
  in: number
  out: number
}
