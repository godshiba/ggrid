import { config } from './config'

// DoS hardening helpers for the public RPC-backed reads.
//
//  - `memo`     : short TTL cache with single-flight, so a flood of identical reads
//                 collapses to at most one RPC call per TTL window.
//  - `rpcGuard` : a global in-flight cap, so a flood of DISTINCT reads (e.g. a new
//                 wallet each time) returns 503 fast instead of piling up unbounded
//                 outbound calls into timeouts.
//  - `rpcFetch` : a fetch with a hard timeout, passed to the Solana Connection so a
//                 slow/throttled RPC can never hang a request handler indefinitely.

interface Entry {
  expires: number
  value: Promise<unknown>
}
const store = new Map<string, Entry>()

// Cache `fn()`'s result under `key` for `ttlMs`. Concurrent callers with the same
// key share the one in-flight promise (single-flight). A rejected load is NOT
// cached, so a transient RPC error doesn't get stuck for the whole TTL.
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value as Promise<T>

  const value = fn().catch((e) => {
    if (store.get(key)?.value === value) store.delete(key) // don't cache failures
    throw e
  })
  store.set(key, { expires: now + ttlMs, value })
  return value
}

// Drop expired cache entries (called periodically to bound memory).
export function sweepCache(): void {
  const now = Date.now()
  for (const [k, e] of store) if (e.expires <= now) store.delete(k)
}

export class RpcBusyError extends Error {
  constructor() {
    super('rpc capacity exceeded')
    this.name = 'RpcBusyError'
  }
}

// Global in-flight limiter for outbound RPC work. Over the cap, `run` rejects with
// RpcBusyError immediately (caller should 503) rather than adding to the pile-up.
export const rpcGuard = {
  inflight: 0,
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight >= config.security.maxInflightRpc) throw new RpcBusyError()
    this.inflight++
    try {
      return await fn()
    } finally {
      this.inflight--
    }
  },
}

// A fetch with a hard per-call timeout, for the Solana web3 Connection. Merges any
// caller-supplied AbortSignal with our timeout so neither is lost.
export function rpcFetch(input: any, init?: any): Promise<Response> {
  const timeout = AbortSignal.timeout(config.security.rpcTimeoutMs)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}
