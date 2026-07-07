import { db, uid, now } from './db'
import { config } from './config'
import {
  solanaEnabled,
  createReference,
  depositParams,
  buildDepositTransaction,
  findDepositByReference,
} from './solana'

export interface DepositResult {
  status: number
  body: unknown
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function userBalance(userId: string): number {
  return (db.query('SELECT balance FROM users WHERE id=?').get(userId) as { balance: number } | undefined)?.balance ?? 0
}

// Step 1 — the developer picks an amount and connects a wallet. We mint a unique
// reference, build the (unsigned) deposit tx server-side, and hand both back. The
// wallet signs + sends the tx; nothing is credited yet.
export async function createIntent(userId: string, wallet: string, tokens: number): Promise<DepositResult> {
  if (!solanaEnabled()) return { status: 503, body: { error: 'on-chain top-ups are not enabled on this gateway yet' } }
  if (!WALLET_RE.test((wallet ?? '').trim())) return { status: 400, body: { error: 'valid Solana wallet address required' } }
  if (!Number.isFinite(tokens) || tokens <= 0) return { status: 400, body: { error: 'positive $GGRID amount required' } }

  const decimals = config.solana.decimals
  const rawAmount = BigInt(Math.round(tokens * 10 ** decimals))
  if (rawAmount <= 0n) return { status: 400, body: { error: 'amount too small' } }

  const credits = Number(rawAmount / BigInt(config.solana.rawPerCredit))
  if (credits < config.solana.minDepositCredits)
    return { status: 400, body: { error: `top-up below minimum (${config.solana.minDepositCredits} credits)` } }

  const reference = await createReference()
  const transaction = await buildDepositTransaction(wallet.trim(), rawAmount, reference)

  db.query('INSERT INTO deposit_intents (reference,user_id,status,created_at) VALUES (?,?,?,?)').run(
    reference,
    userId,
    'PENDING',
    now(),
  )

  const params = await depositParams()
  return {
    status: 200,
    body: { reference, transaction, credits, rawAmount: rawAmount.toString(), ...params },
  }
}

// Step 2 — polled by the web app after it sends the tx. Finds the on-chain deposit
// carrying our reference, verifies the vault actually received $GGRID, and credits
// the user exactly once (dedup by signature). Idempotent: safe to call repeatedly.
export async function checkIntent(userId: string, reference: string): Promise<DepositResult> {
  if (!solanaEnabled()) return { status: 503, body: { error: 'on-chain top-ups are not enabled on this gateway yet' } }

  const intent = db
    .query('SELECT reference,user_id,status,signature,credits FROM deposit_intents WHERE reference=? AND user_id=?')
    .get(reference, userId) as
    | { reference: string; user_id: string; status: string; signature: string | null; credits: number | null }
    | undefined
  if (!intent) return { status: 404, body: { error: 'unknown reference' } }

  if (intent.status === 'CONFIRMED')
    return { status: 200, body: { status: 'CONFIRMED', credits: intent.credits, signature: intent.signature, balance: userBalance(userId) } }

  const found = await findDepositByReference(reference)
  if (!found) return { status: 200, body: { status: 'PENDING' } }

  // Guard against the same on-chain tx crediting two intents.
  const dup = db.query('SELECT reference FROM deposit_intents WHERE signature=?').get(found.signature) as
    | { reference: string }
    | undefined
  if (dup && dup.reference !== reference) return { status: 409, body: { error: 'deposit already credited' } }

  const credits = Number(found.rawAmount / BigInt(config.solana.rawPerCredit))
  if (credits <= 0) return { status: 200, body: { status: 'PENDING', note: 'deposit below 1 credit' } }

  try {
    db.transaction(() => {
      const r = db
        .query(
          'UPDATE deposit_intents SET status=?, signature=?, raw_amount=?, credits=?, confirmed_at=? WHERE reference=? AND status=?',
        )
        .run('CONFIRMED', found.signature, found.rawAmount.toString(), credits, now(), reference, 'PENDING')
      if (r.changes === 0) throw new Error('already processed')
      db.query('UPDATE users SET balance = balance + ? WHERE id=?').run(credits, userId)
      db.query('INSERT INTO ledger (id,type,amount,user_id,created_at) VALUES (?,?,?,?,?)').run(
        uid('led_'),
        'DEPOSIT',
        credits,
        userId,
        now(),
      )
    })()
  } catch {
    // Lost the race to another poll that already credited it — just report state.
    return { status: 200, body: { status: 'CONFIRMED', credits, signature: found.signature, balance: userBalance(userId) } }
  }

  return { status: 200, body: { status: 'CONFIRMED', credits, signature: found.signature, balance: userBalance(userId) } }
}
