/* Standalone integration test for ggrid_payout (local validator OR devnet).
 *
 * Robust against flaky public RPC: confirms every program tx by HTTP polling
 * (no websockets, which devnet often refuses), retries transient errors, and is
 * idempotent against the singleton `config` PDA (resets it first if it already
 * exists, and shuts it down at the end so re-runs start clean).
 *
 * Bypasses anchor's IDL build (can't compile ark-bn254 here) with an inline IDL
 * whose discriminators are derived from the source, and bypasses ts-mocha (ESM).
 *
 * Env: PROGRAM_ID, ANCHOR_PROVIDER_URL, ANCHOR_WALLET.
 */
const anchor = require('@coral-xyz/anchor')
const { PublicKey, Keypair, Connection } = require('@solana/web3.js')
const {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
  mintTo, getAccount, getMint,
} = require('@solana/spl-token')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { SystemProgram } = anchor.web3

const TP = TOKEN_2022_PROGRAM_ID
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disc = (p, n) => Array.from(createHash('sha256').update(`${p}:${n}`).digest().subarray(0, 8))
const ix = (name, accounts, args) => ({ name, discriminator: disc('global', name), accounts, args })
const W = (name) => ({ name, writable: true })
const WS = (name) => ({ name, writable: true, signer: true })
const S = (name) => ({ name, signer: true })
const R = (name) => ({ name })

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID)
const URL = process.env.ANCHOR_PROVIDER_URL || 'http://127.0.0.1:8899'

const idl = {
  address: PROGRAM_ID.toBase58(),
  metadata: { name: 'ggrid_payout', version: '0.1.0', spec: '0.1.0' },
  instructions: [
    ix('initialize',
      [WS('authority'), W('config'), R('mint'), W('vault'), R('treasury'), R('stakers'),
       R('token_program'), R('associated_token_program'), R('system_program')],
      [{ name: 'provider_bps', type: 'u16' }, { name: 'burn_bps', type: 'u16' },
       { name: 'stakers_bps', type: 'u16' }, { name: 'treasury_bps', type: 'u16' }]),
    ix('deposit',
      [W('config'), WS('user'), W('user_account'), W('mint'), W('user_token'), W('vault'),
       R('token_program'), R('system_program')],
      [{ name: 'amount', type: 'u64' }]),
    ix('settle',
      [W('config'), S('authority'), W('mint'), W('vault'), W('provider_token'), W('stakers'), W('treasury'),
       R('token_program')],
      [{ name: 'amount', type: 'u64' }]),
    ix('shutdown',
      [W('config'), WS('authority'), W('mint'), W('vault'), W('recipient_token'), R('token_program')],
      []),
  ],
  accounts: [], types: [], events: [], errors: [],
}

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.error('  ✗', name) } }

const TRANSIENT = /fetch failed|not confirmed|ECONNREFUSED|ETIMEDOUT|timed out|timeout|429|503|Blockhash not found|block height exceeded|socket hang up/i
async function withRetry(label, fn, n = 6) {
  let last
  for (let i = 0; i < n; i++) {
    try { return await fn() }
    catch (e) {
      last = e; const m = String(e.message || e)
      if (!TRANSIENT.test(m)) throw e
      console.log(`  ↺ retry ${label} (${i + 1}/${n}): ${m.slice(0, 70)}`)
      await sleep(3000)
    }
  }
  throw last
}

// Transport-level resilience: retry every RPC HTTP call on connect/transport errors,
// which the public devnet endpoint throws intermittently under load.
async function resilientFetch(url, opts) {
  let last
  for (let i = 0; i < 8; i++) {
    try { return await globalThis.fetch(url, opts) }
    catch (e) {
      last = e
      const m = String(e?.cause?.code || e?.message || e)
      if (!/TIMEOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket|aborted/i.test(m)) throw e
      await sleep(1500)
    }
  }
  throw last
}

async function main() {
  const conn = new Connection(URL, { commitment: 'confirmed', confirmTransactionInitialTimeout: 90_000, fetch: resilientFetch })
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, 'utf8'))))
  const wallet = new anchor.Wallet(authority)
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' })
  const program = new anchor.Program(idl, provider)
  const co = { commitment: 'confirmed', skipPreflight: false }

  console.log('ggrid_payout integration test')
  console.log('  program:', PROGRAM_ID.toBase58())
  console.log('  rpc    :', URL, '\n')

  // HTTP-only send+confirm for a program instruction (authority is the sole signer).
  const send = (builder, label) => withRetry(label, async () => {
    const tx = await builder.transaction()
    tx.feePayer = authority.publicKey
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.sign(authority)
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatus(sig)).value
      if (st?.err) throw new Error('tx error ' + JSON.stringify(st.err))
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig
      await sleep(2000)
    }
    throw new Error('not confirmed ' + sig)
  })

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)
  const [userAccount] = PublicKey.findProgramAddressSync([Buffer.from('user'), authority.publicKey.toBuffer()], PROGRAM_ID)

  // --- idempotency: if config already exists (prior run), shut it down first ---
  const existing = await withRetry('get-config', () => conn.getAccountInfo(config))
  if (existing) {
    const d = existing.data
    const oldMint = new PublicKey(d.subarray(40, 72))
    const oldVault = new PublicKey(d.subarray(72, 104))
    console.log('  (config exists from a prior run - resetting via shutdown)')
    const recip = (await withRetry('recip-ata', () => getOrCreateAssociatedTokenAccount(conn, authority, oldMint, authority.publicKey, false, 'confirmed', undefined, TP))).address
    await send(program.methods.shutdown().accountsPartial({
      config, authority: authority.publicKey, mint: oldMint, vault: oldVault, recipientToken: recip, tokenProgram: TP,
    }), 'reset-shutdown')
  }

  // --- fresh token + accounts ---
  const mint = await withRetry('createMint', () => createMint(conn, authority, authority.publicKey, null, 6, undefined, co, TP))
  const authAta = await withRetry('auth-ata', () => getOrCreateAssociatedTokenAccount(conn, authority, mint, authority.publicKey, false, 'confirmed', co, TP))
  const treOwner = Keypair.generate().publicKey, stkOwner = Keypair.generate().publicKey, prvOwner = Keypair.generate().publicKey
  const treasury = (await withRetry('treasury-ata', () => getOrCreateAssociatedTokenAccount(conn, authority, mint, treOwner, false, 'confirmed', co, TP))).address
  const stakers = (await withRetry('stakers-ata', () => getOrCreateAssociatedTokenAccount(conn, authority, mint, stkOwner, false, 'confirmed', co, TP))).address
  const providerToken = (await withRetry('provider-ata', () => getOrCreateAssociatedTokenAccount(conn, authority, mint, prvOwner, false, 'confirmed', co, TP))).address
  await withRetry('mintTo', () => mintTo(conn, authority, mint, authAta.address, authority, 1_000_000_000, [], co, TP))
  const vault = getAssociatedTokenAddressSync(mint, config, true, TP)

  // --- initialize ---
  await send(program.methods.initialize(7500, 1250, 750, 500).accountsPartial({
    authority: authority.publicKey, config, mint, vault, treasury, stakers,
    tokenProgram: TP, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }), 'initialize')
  const acctInfo = (pk, l) => withRetry(l, () => conn.getAccountInfo(pk))
  const amt = (pk, l) => withRetry(l, async () => (await getAccount(conn, pk, undefined, TP)).amount)
  const supply = (l) => withRetry(l, async () => (await getMint(conn, mint, undefined, TP)).supply)

  check('initialize created config + vault', !!(await acctInfo(config, 'r-config')) && !!(await acctInfo(vault, 'r-vault')))

  // --- deposit ---
  await send(program.methods.deposit(new anchor.BN(1_000_000)).accountsPartial({
    config, user: authority.publicKey, userAccount, mint, userToken: authAta.address, vault,
    tokenProgram: TP, systemProgram: SystemProgram.programId,
  }), 'deposit')
  check('deposit funded the vault (1000000)', (await amt(vault, 'r-vault-amt')) === 1_000_000n)

  // --- settle: the core 75 / 12.5 / 7.5 / 5 split ---
  const supplyBefore = await supply('r-supply-before')
  await send(program.methods.settle(new anchor.BN(1_000_000)).accountsPartial({
    config, authority: authority.publicKey, mint, vault, providerToken, stakers, treasury, tokenProgram: TP,
  }), 'settle')

  const prov = await amt(providerToken, 'r-prov')
  const stk = await amt(stakers, 'r-stk')
  const treas = await amt(treasury, 'r-treas')
  const supplyAfter = await supply('r-supply-after')
  check('provider got 75% (750000)', prov === 750_000n)
  check('stakers got 7.5% (75000)', stk === 75_000n)
  check('treasury got 5% (50000)', treas === 50_000n)
  check('burned 12.5% (125000)', supplyBefore - supplyAfter === 125_000n)
  check('vault emptied to 0', (await amt(vault, 'r-vault-final')) === 0n)

  // --- shutdown (cleanup so re-runs start clean) ---
  await send(program.methods.shutdown().accountsPartial({
    config, authority: authority.publicKey, mint, vault, recipientToken: authAta.address, tokenProgram: TP,
  }), 'shutdown')
  check('shutdown closed the config PDA', (await acctInfo(config, 'r-config-final')) === null)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('FATAL:', e.message || e); process.exit(1) })
