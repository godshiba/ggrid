import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { config, solanaConfigured } from './config'

// On-chain payout client for the ggrid_payout program. Heavy Solana deps are
// imported lazily so the gateway boots (and tests run) without them installed —
// they're only pulled in the first time a payout is actually attempted.
//
// Disabled cleanly when the Solana env isn't set (see solanaConfigured()).

export function solanaEnabled(): boolean {
  return solanaConfigured()
}

// Balance READS need far less than payouts: just an RPC + the mint (no authority
// key, no program, no IDL). So the console can show a wallet's real on-chain
// $GGRID even on a gateway that can't sign payouts yet.
export function solanaReadable(): boolean {
  const s = config.solana
  return !!(s.rpcUrl && s.mint)
}

interface ReadClient {
  web3: any
  splToken: any
  connection: any
  mint: any
  tokenProgram: any
  decimals: number
}
let readCached: ReadClient | null = null

async function readClient(): Promise<ReadClient> {
  if (readCached) return readCached
  if (!solanaReadable()) throw new Error('solana reader not configured (needs SOLANA_RPC_URL + GGRID_MINT)')
  const web3 = await import('@solana/web3.js')
  const splToken = await import('@solana/spl-token')
  const s = config.solana
  const connection = new web3.Connection(s.rpcUrl, 'confirmed')
  const mint = new web3.PublicKey(s.mint)
  const tokenProgram = s.tokenProgram === 'token' ? splToken.TOKEN_PROGRAM_ID : splToken.TOKEN_2022_PROGRAM_ID
  readCached = { web3, splToken, connection, mint, tokenProgram, decimals: s.decimals }
  return readCached
}

// Read a wallet's real on-chain $GGRID balance. Returns 0 (not an error) when the
// wallet has no associated token account yet — that just means it never held any.
// A pure public chain read; never touches the authority key.
export async function getWalletBalance(
  walletAddress: string,
): Promise<{ rawAmount: string; uiAmount: number; decimals: number; mint: string }> {
  const c = await readClient()
  const owner = new c.web3.PublicKey(walletAddress)
  const ata = c.splToken.getAssociatedTokenAddressSync(c.mint, owner, true, c.tokenProgram)
  const mint = c.mint.toBase58()
  try {
    const res = await c.connection.getTokenAccountBalance(ata)
    return {
      rawAmount: String(res.value.amount),
      uiAmount: res.value.uiAmount ?? Number(res.value.amount) / 10 ** c.decimals,
      decimals: res.value.decimals,
      mint,
    }
  } catch {
    // getTokenAccountBalance throws if the ATA doesn't exist → zero balance.
    return { rawAmount: '0', uiAmount: 0, decimals: c.decimals, mint }
  }
}

interface SolClient {
  anchor: any
  web3: any
  splToken: any
  authority: any
  connection: any
  program: any
  tokenProgram: any
  mint: any
  configPda: any
  cfg: any
}

let cached: SolClient | null = null

function loadAuthority(web3: any): any {
  const raw = config.solana.authorityKey.trim()
  const secret = raw.startsWith('[')
    ? JSON.parse(raw)
    : JSON.parse(readFileSync(raw.replace('~', process.env.HOME ?? process.env.USERPROFILE ?? ''), 'utf8'))
  return web3.Keypair.fromSecretKey(Uint8Array.from(secret))
}

async function client(): Promise<SolClient> {
  if (cached) return cached
  if (!solanaEnabled()) throw new Error('solana payouts not configured')

  const anchor = await import('@coral-xyz/anchor')
  const web3 = await import('@solana/web3.js')
  const splToken = await import('@solana/spl-token')
  const s = config.solana

  const authority = loadAuthority(web3)
  const connection = new web3.Connection(s.rpcUrl, 'confirmed')
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: 'confirmed' })

  const idl = JSON.parse(readFileSync(resolve(s.idlPath), 'utf8'))
  const program = new anchor.Program(idl, provider)
  const programId = new web3.PublicKey(s.programId)
  const tokenProgram = s.tokenProgram === 'token' ? splToken.TOKEN_PROGRAM_ID : splToken.TOKEN_2022_PROGRAM_ID
  const mint = new web3.PublicKey(s.mint)
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from('config')], programId)
  const cfg = await (program.account as any).config.fetch(configPda)

  cached = { anchor, web3, splToken, authority, connection, program, tokenProgram, mint, configPda, cfg }
  return cached
}

// Push a gross amount on-chain; the program splits it 75/12.5/7.5/5 and the
// provider receives ~75% in real $GGRID. Creates the provider's token account
// if missing (authority pays the rent). Returns the transaction signature.
export async function settleProvider(payoutWallet: string, grossRaw: bigint): Promise<{ signature: string }> {
  const c = await client()
  const wallet = new c.web3.PublicKey(payoutWallet)
  const providerToken = c.splToken.getAssociatedTokenAddressSync(c.mint, wallet, true, c.tokenProgram)
  const createAta = c.splToken.createAssociatedTokenAccountIdempotentInstruction(
    c.authority.publicKey,
    providerToken,
    wallet,
    c.mint,
    c.tokenProgram,
  )
  const amount = new c.anchor.BN(grossRaw.toString())

  const signature: string = await c.program.methods
    .settle(amount)
    .accounts({
      config: c.configPda,
      authority: c.authority.publicKey,
      mint: c.mint,
      vault: c.cfg.vault,
      providerToken,
      stakers: c.cfg.stakers,
      treasury: c.cfg.treasury,
      tokenProgram: c.tokenProgram,
    })
    .preInstructions([createAta])
    .rpc()

  return { signature }
}

// ---------- developer top-ups: deposit $GGRID → credits ----------
// The on-chain `deposit` moves $GGRID into the SAME vault the splitter pays
// providers from, so developer top-ups directly fund payouts. We hand-build the
// instruction (no IDL dependency) and attach a Solana-Pay "reference" key so the
// gateway can find the payment and credit exactly the user who requested it.

// Anchor instruction discriminator = first 8 bytes of sha256("global:<name>").
function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

// A fresh, unguessable reference pubkey (never signs — used only as a tx marker).
export async function createReference(): Promise<string> {
  const c = await client()
  return c.web3.Keypair.generate().publicKey.toBase58()
}

// Public parameters the web app shows / needs; all strings so they serialize cleanly.
export async function depositParams(): Promise<{
  programId: string
  mint: string
  vault: string
  decimals: number
  rawPerCredit: number
}> {
  const c = await client()
  return {
    programId: config.solana.programId,
    mint: c.mint.toBase58(),
    vault: c.cfg.vault.toBase58(),
    decimals: config.solana.decimals,
    rawPerCredit: config.solana.rawPerCredit,
  }
}

// Build an UNSIGNED deposit transaction for `userWallet` moving `rawAmount` of
// $GGRID into the vault, tagged with `reference`. Returned base64 for the wallet
// to deserialize, sign and send. feePayer = the user (they pay the network fee).
export async function buildDepositTransaction(
  userWallet: string,
  rawAmount: bigint,
  reference: string,
): Promise<string> {
  const c = await client()
  const { PublicKey, TransactionInstruction, Transaction, SystemProgram } = c.web3
  const user = new PublicKey(userWallet)
  const ref = new PublicKey(reference)
  const programId = new PublicKey(config.solana.programId)

  const [userAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('user'), user.toBuffer()],
    programId,
  )
  const userToken = c.splToken.getAssociatedTokenAddressSync(c.mint, user, false, c.tokenProgram)

  const amountLE = Buffer.alloc(8)
  amountLE.writeBigUInt64LE(rawAmount)
  const data = Buffer.concat([anchorDiscriminator('deposit'), amountLE])

  // Account order MUST match the `Deposit` struct in lib.rs.
  const keys = [
    { pubkey: c.configPda, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: userAccount, isSigner: false, isWritable: true },
    { pubkey: c.mint, isSigner: false, isWritable: true },
    { pubkey: userToken, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(c.cfg.vault), isSigner: false, isWritable: true },
    { pubkey: c.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // trailing reference — Anchor drops extras into remaining_accounts (ignored),
    // but getSignaturesForAddress(reference) can then find this exact payment.
    { pubkey: ref, isSigner: false, isWritable: false },
  ]
  const ix = new TransactionInstruction({ programId, keys, data })

  const { blockhash } = await c.connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: user, recentBlockhash: blockhash }).add(ix)
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
}

// Look for a confirmed deposit carrying `reference` and return the exact raw
// amount that landed in the vault. Null until the payment shows up on-chain.
export async function findDepositByReference(
  reference: string,
): Promise<{ signature: string; rawAmount: bigint } | null> {
  const c = await client()
  const ref = new c.web3.PublicKey(reference)
  const vault = c.cfg.vault.toBase58()
  const mint = c.mint.toBase58()
  const programId = config.solana.programId

  const sigs = await c.connection.getSignaturesForAddress(ref, { limit: 10 }, 'confirmed')
  for (const s of sigs) {
    if (s.err) continue
    const tx = await c.connection.getParsedTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    if (!tx || tx.meta?.err) continue

    // Only trust deposits that actually invoked our program.
    const keys: string[] = (tx.transaction.message.accountKeys ?? []).map((k: any) =>
      typeof k === 'string' ? k : k.pubkey.toString(),
    )
    if (!keys.includes(programId)) continue

    // Vault balance delta of our mint = the amount deposited.
    const pre = (tx.meta?.preTokenBalances ?? []).find(
      (b: any) => keys[b.accountIndex] === vault && b.mint === mint,
    )
    const post = (tx.meta?.postTokenBalances ?? []).find(
      (b: any) => keys[b.accountIndex] === vault && b.mint === mint,
    )
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0')
    const postAmt = BigInt(post?.uiTokenAmount?.amount ?? '0')
    const delta = postAmt - preAmt
    if (delta > 0n) return { signature: s.signature, rawAmount: delta }
  }
  return null
}
