import { db, now } from './db'
import { config } from './config'

// The sandbox fund is an ORDINARY user row with a fixed id. Every free request
// (anonymous playground + post-signup free-request counter) settles against it
// through the unchanged job pipeline: the provider earns their 75%, the fee
// split runs as usual, and the fund drains like any balance. When it (or the
// daily cap) is spent, the free tier pauses by itself — no separate accounting.
export const SANDBOX_USER_ID = 'usr_sandbox_fund'

// Create the fund once with its initial balance. Never re-funds on restart —
// topping it up later is an ordinary deposit/admin credit to this account.
export function ensureSandboxUser(): void {
  const exists = db.query('SELECT id FROM users WHERE id = ?').get(SANDBOX_USER_ID)
  if (exists) return
  db.query('INSERT INTO users (id,email,balance,created_at) VALUES (?,?,?,?)').run(
    SANDBOX_USER_ID,
    'sandbox@internal',
    config.playground.sandboxInitialCredits,
    now(),
  )
}

export function sandboxBalance(): number {
  const row = db.query('SELECT balance FROM users WHERE id = ?').get(SANDBOX_USER_ID) as
    | { balance: number }
    | undefined
  return row?.balance ?? 0
}

// Credits charged to the fund since UTC midnight (ledger CHARGE rows are negative).
export function sandboxSpentToday(): number {
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const row = db
    .query("SELECT COALESCE(SUM(-amount),0) AS spent FROM ledger WHERE user_id = ? AND type = 'CHARGE' AND created_at >= ?")
    .get(SANDBOX_USER_ID, dayStart.getTime()) as { spent: number }
  return row.spent
}

// May free traffic run right now? Fund not empty AND today's ceiling not hit.
// The daily cap is the hard roof that stops the whole fund burning overnight.
export function sandboxBudgetOk(): boolean {
  return sandboxBalance() > 0 && sandboxSpentToday() < config.playground.sandboxDailyCapCredits
}
