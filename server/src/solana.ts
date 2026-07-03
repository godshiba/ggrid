import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { config, solanaConfigured } from './config'

// On-chain payout client for the ggrid_payout program. Heavy Solana deps are
// imported lazily so the gateway boots (and tests run) without them installed —
// they're only pulled in the first time a payout is actually attempted.
//
// Disabled cleanly when the Solana env isn't set (see solanaConfigured()).

export function solanaEnabled(): boolean {
  return solanaConfigured()
}

interface SolClient {
  anchor: any
  web3: any
  splToken: any
  authority: any
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

  cached = { anchor, web3, splToken, authority, program, tokenProgram, mint, configPda, cfg }
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
