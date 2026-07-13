import { createHash, randomBytes } from 'node:crypto'
import type { Context, Next } from 'hono'
import { db, uid, now } from './db'
import { config } from './config'
import { verifyPrivyToken, looksLikeJwt } from './privy'
import type { UserRow, ProviderRow } from './types'

export type Env = { Variables: { user: UserRow; provider: ProviderRow } }

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
export const randToken = (prefix: string): string => prefix + randomBytes(24).toString('base64url')

export function bearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

// --- users ---
export function createUser(email: string | null, balance: number, freeRequests = 0): UserRow {
  const id = uid('usr_')
  const ts = now()
  db.query('INSERT INTO users (id,email,balance,free_requests,created_at) VALUES (?,?,?,?,?)').run(
    id,
    email,
    balance,
    freeRequests,
    ts,
  )
  return { id, email, balance, runpod_allowed: 0, free_requests: freeRequests, created_at: ts }
}

export function getUser(id: string): UserRow | null {
  return (db.query('SELECT * FROM users WHERE id = ?').get(id) as UserRow) ?? null
}

// --- Privy identity link ---
export function getUserByPrivyId(privyId: string): UserRow | null {
  return (db.query('SELECT * FROM users WHERE privy_id = ?').get(privyId) as UserRow) ?? null
}

// Create a GGRID account tied to a Privy identity (first console login).
export function createUserWithPrivy(privyId: string, email: string | null, balance: number, freeRequests = 0): UserRow {
  const id = uid('usr_')
  const ts = now()
  db.query('INSERT INTO users (id,email,balance,free_requests,privy_id,created_at) VALUES (?,?,?,?,?,?)').run(
    id,
    email,
    balance,
    freeRequests,
    privyId,
    ts,
  )
  return { id, email, balance, runpod_allowed: 0, free_requests: freeRequests, created_at: ts }
}

// --- api keys ---
export function issueApiKey(userId: string, label?: string): { id: string; key: string } {
  const key = randToken('ggrid_sk_')
  const id = uid('key_')
  db.query('INSERT INTO api_keys (id,hash,prefix,user_id,label,created_at) VALUES (?,?,?,?,?,?)').run(
    id,
    sha256(key),
    key.slice(0, 16),
    userId,
    label ?? null,
    now(),
  )
  return { id, key }
}

export function userByApiKey(key: string): UserRow | null {
  const row = db.query('SELECT user_id FROM api_keys WHERE hash = ? AND revoked_at IS NULL').get(sha256(key)) as
    | { user_id: string }
    | undefined
  if (!row) return null
  return getUser(row.user_id)
}

export function providerByToken(token: string): ProviderRow | null {
  return (db.query('SELECT * FROM providers WHERE token_hash = ?').get(sha256(token)) as ProviderRow) ?? null
}

// --- provider ↔ Privy identity link (provider console login) ---
export function getProviderByPrivyId(privyId: string): ProviderRow | null {
  return (db.query('SELECT * FROM providers WHERE privy_id = ?').get(privyId) as ProviderRow) ?? null
}

// Create a provider tied to a Privy identity (first provider-console login). Still
// mints a node token (the installer credential); the raw token is returned once.
export function createProviderWithPrivy(privyId: string): { provider: ProviderRow; token: string } {
  const id = uid('prv_')
  const token = randToken('ggrid_pv_')
  const ts = now()
  db.query(
    'INSERT INTO providers (id,email,token_hash,payout_wallet,balance,privy_id,created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(id, null, sha256(token), null, 0, privyId, ts)
  return { provider: { id, email: null, token_hash: sha256(token), payout_wallet: null, balance: 0, privy_id: privyId, created_at: ts }, token }
}

// Rotate a provider's node token (installer credential). The old token stops
// working for NEW registrations; already-registered nodes keep their own node
// secret, so rotating never knocks a live node offline. Returns the new token.
export function rotateProviderToken(providerId: string): string {
  const token = randToken('ggrid_pv_')
  db.query('UPDATE providers SET token_hash = ? WHERE id = ?').run(sha256(token), providerId)
  return token
}

// Resolve a provider from a bearer that is EITHER a Privy access token (console
// login) OR a raw provider token (the node agent / paste-token fallback).
export async function providerFromToken(token: string | null): Promise<ProviderRow | null> {
  if (!token) return null
  if (looksLikeJwt(token)) {
    const claims = await verifyPrivyToken(token)
    return claims ? getProviderByPrivyId(claims.privyId) : null
  }
  return providerByToken(token)
}

// --- auth middleware ---

// Resolve the caller from a bearer token that is EITHER a ggrid_sk_ API key or a
// Privy access token (JWT). The console logs in with Privy; external API clients
// use API keys. Privy users must already exist (created via POST /api/auth/privy).
export async function userFromToken(token: string | null): Promise<UserRow | null> {
  if (!token) return null
  if (token.startsWith('ggrid_sk_')) return userByApiKey(token)
  if (looksLikeJwt(token)) {
    const claims = await verifyPrivyToken(token)
    if (claims) return getUserByPrivyId(claims.privyId)
  }
  return null
}

// Developer dashboard: authenticated by a Privy login OR any of the user's API keys.
export const requireUser = async (c: Context<Env>, next: Next) => {
  const user = await userFromToken(bearer(c.req.header('authorization')))
  if (!user) return c.json({ error: { message: 'authentication required', type: 'auth' } }, 401)
  c.set('user', user)
  await next()
}

// Provider dashboard: authenticated by a Privy login OR the raw provider token.
export const requireProvider = async (c: Context<Env>, next: Next) => {
  const token = bearer(c.req.header('authorization')) ?? c.req.header('x-provider-token') ?? null
  const prov = await providerFromToken(token)
  if (!prov) return c.json({ error: 'provider authentication required' }, 401)
  c.set('provider', prov)
  await next()
}

// Admin: single shared key from env. Disabled (403) if ADMIN_KEY is unset.
export const requireAdmin = async (c: Context, next: Next) => {
  const key = c.req.header('x-admin-key') ?? bearer(c.req.header('authorization'))
  if (!config.adminKey || key !== config.adminKey) return c.json({ error: 'forbidden' }, 403)
  await next()
}
