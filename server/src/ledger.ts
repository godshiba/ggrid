import { db, uid, now } from './db'
import { feeSplit } from './pricing'

interface SettleInput {
  jobId: string
  userId: string
  nodeId: string
  providerId: string
  tokensIn: number
  tokensOut: number
  cost: number
  latencyMs: number
  // Who PAYS. Defaults to userId. Free-tier / playground jobs keep the real user
  // on the job row (their usage history) but charge the sandbox fund instead.
  billUserId?: string
}

// Mark job DONE, charge the payer, pay the provider, and record the fee split —
// all in one transaction. Idempotency is by job id (a job settles once).
export function settleJob(i: SettleInput): void {
  const payer = i.billUserId ?? i.userId
  const split = feeSplit(i.cost)
  const ts = now()
  const tx = db.transaction(() => {
    db.query(
      'UPDATE jobs SET status=?, tokens_in=?, tokens_out=?, cost=?, latency_ms=?, finished_at=? WHERE id=? AND status!=?',
    ).run('DONE', i.tokensIn, i.tokensOut, i.cost, i.latencyMs, ts, i.jobId, 'DONE')
    db.query('UPDATE users SET balance = balance - ? WHERE id = ?').run(i.cost, payer)
    db.query('UPDATE providers SET balance = balance + ? WHERE id = ?').run(split.provider, i.providerId)

    const led = db.query(
      'INSERT INTO ledger (id,type,amount,user_id,provider_id,job_id,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    led.run(uid('led_'), 'CHARGE', -i.cost, payer, null, i.jobId, ts)
    led.run(uid('led_'), 'PROVIDER_REWARD', split.provider, null, i.providerId, i.jobId, ts)
    led.run(uid('led_'), 'BURN', split.burn, null, null, i.jobId, ts)
    led.run(uid('led_'), 'STAKERS', split.stakers, null, null, i.jobId, ts)
    led.run(uid('led_'), 'TREASURY', split.treasury, null, null, i.jobId, ts)
  })
  tx()
}

export function failJob(jobId: string, error: string): void {
  db.query('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run(
    'FAILED',
    error.slice(0, 300),
    now(),
    jobId,
  )
}
