import { db, uid, now } from './db'
import { config } from './config'
import { solanaEnabled, settleProvider } from './solana'
import type { ProviderRow } from './types'

export interface PayoutResult {
  status: number
  body: unknown
}

// Convert a provider's accrued off-chain balance (net credits owed) into a real
// on-chain $GGRID payout. The provider's `balance` is the 75% net we owe, so we
// push the GROSS to the splitter (gross = net / providerShare); it pays the
// provider ~net and funds burn/stakers/treasury from the deposit pool.
//
// Flow: reserve (deduct) the balance first so concurrent calls can't double-spend,
// send the tx, then either confirm or compensate (refund) on failure.
export async function requestPayout(provider: ProviderRow): Promise<PayoutResult> {
  if (!solanaEnabled())
    return { status: 503, body: { error: 'on-chain payouts are not enabled on this gateway yet' } }
  if (!provider.payout_wallet)
    return { status: 400, body: { error: 'set a payout wallet first (POST /api/provider/wallet)' } }

  const fresh = db.query('SELECT balance FROM providers WHERE id=?').get(provider.id) as { balance: number } | undefined
  const net = fresh?.balance ?? 0
  if (net < config.solana.minPayoutCredits)
    return {
      status: 400,
      body: { error: `balance below minimum payout (${config.solana.minPayoutCredits} credits)`, balance: net },
    }

  const share = config.solana.providerBps / 10_000
  const grossCredits = Math.ceil(net / share)
  const rawAmount = BigInt(grossCredits) * BigInt(config.solana.rawPerCredit)
  const wallet = provider.payout_wallet
  const id = uid('pay_')
  const ts = now()

  // --- reserve ---
  try {
    db.transaction(() => {
      const r = db.query('UPDATE providers SET balance = balance - ? WHERE id=? AND balance >= ?').run(net, provider.id, net)
      if (r.changes === 0) throw new Error('balance changed')
      db.query(
        'INSERT INTO payouts (id,provider_id,net_credits,gross_credits,raw_amount,wallet,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(id, provider.id, net, grossCredits, rawAmount.toString(), wallet, 'PENDING', ts)
      db.query('INSERT INTO ledger (id,type,amount,provider_id,created_at) VALUES (?,?,?,?,?)').run(
        uid('led_'), 'PAYOUT', -net, provider.id, ts,
      )
    })()
  } catch {
    return { status: 409, body: { error: 'balance changed during payout, try again' } }
  }

  // --- send on-chain (outside the db tx) ---
  try {
    const { signature } = await settleProvider(wallet, rawAmount)
    db.query('UPDATE payouts SET status=?, signature=?, settled_at=? WHERE id=?').run('SENT', signature, now(), id)
    return {
      status: 200,
      body: { payoutId: id, netCredits: net, grossCredits, rawAmount: rawAmount.toString(), wallet, signature },
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300)
    // --- compensate: restore the reserved balance ---
    db.transaction(() => {
      db.query('UPDATE providers SET balance = balance + ? WHERE id=?').run(net, provider.id)
      db.query('UPDATE payouts SET status=?, error=? WHERE id=?').run('FAILED', msg, id)
      db.query('INSERT INTO ledger (id,type,amount,provider_id,created_at) VALUES (?,?,?,?,?)').run(
        uid('led_'), 'PAYOUT_REVERSED', net, provider.id, now(),
      )
    })()
    return { status: 502, body: { error: 'on-chain settlement failed; balance restored', detail: msg } }
  }
}
