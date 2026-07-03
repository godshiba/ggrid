import { createHash, randomBytes } from 'node:crypto'
import type { Context, Next } from 'hono'
import { db, uid, now } from './db'
import { config } from './config'
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
export function createUser(email: string | null, balance: number): UserRow {
  const id = uid('usr_')
  const ts = now()
  db.query('INSERT INTO users (id,email,balance,created_at) VALUES (?,?,?,?)').run(id, email, balance, ts)
  return { id, email, balance, created_at: ts }
}

export function getUser(id: string): UserRow | null {
  return (db.query('SELECT * FROM users WHERE id = ?').get(id) as UserRow) ?? null
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

// --- auth middleware ---

// Developer dashboard: authenticated by any of the user's (non-revoked) API keys.
export const requireUser = async (c: Context<Env>, next: Next) => {
  const key = bearer(c.req.header('authorization'))
  const user = key ? userByApiKey(key) : null
  if (!user) return c.json({ error: { message: 'authentication required', type: 'auth' } }, 401)
  c.set('user', user)
  await next()
}

// Provider dashboard: authenticated by the provider token.
export const requireProvider = async (c: Context<Env>, next: Next) => {
  const token = bearer(c.req.header('authorization')) ?? c.req.header('x-provider-token') ?? null
  const prov = token ? providerByToken(token) : null
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
