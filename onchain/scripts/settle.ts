/**
 * Backend settlement helper — this is how the GpuGrid gateway turns an off-chain
 * ledger entry into an on-chain payout.
 *
 * Wiring (do this after `anchor deploy` + `initialize`):
 *   - The gateway already records PROVIDER_REWARD / BURN / STAKERS / TREASURY rows.
 *     Instead of (or in addition to) crediting the off-chain provider balance, batch
 *     up a provider's accrued amount and call `settle(amount)` here. The program does
 *     the 75/12.5/7.5/5 split itself, so you pass the GROSS amount, not the cuts.
 *   - `amount` is in raw token units (apply the mint's decimals).
 *   - The signer MUST be the `authority` set at `initialize` (the gateway's hot wallet).
 *     Keep that key in the deploy platform Secrets, never in the repo.
 *
 * Run a one-off:
 *   PROGRAM_ID=... GGRID_MINT=... PROVIDER_WALLET=... AMOUNT=1000000 npx ts-node settle.ts
 */
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import idl from '../target/idl/ggrid_payout.json'

const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID // swap to TOKEN_PROGRAM_ID for a classic/pump.fun SPL mint

function loadKeypair(envVar: string, fallback: string): Keypair {
  const path = (process.env[envVar] ?? fallback).replace('~', homedir())
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed')
  const authority = loadKeypair('AUTHORITY_KEYPAIR', '~/.config/solana/id.json')
  const wallet = new anchor.Wallet(authority)
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' })
  anchor.setProvider(provider)

  const programId = new PublicKey(process.env.PROGRAM_ID ?? (idl as any).address)
  const program = new anchor.Program(idl as anchor.Idl, provider)

  const mint = new PublicKey(process.env.GGRID_MINT!)
  const providerWallet = new PublicKey(process.env.PROVIDER_WALLET!)
  const amount = new anchor.BN(process.env.AMOUNT ?? '0')

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)
  const cfg = await (program.account as any).config.fetch(config)

  const providerToken = getAssociatedTokenAddressSync(mint, providerWallet, true, TOKEN_PROGRAM)

  const sig = await program.methods
    .settle(amount)
    .accounts({
      config,
      authority: authority.publicKey,
      mint,
      vault: cfg.vault,
      providerToken,
      stakers: cfg.stakers,
      treasury: cfg.treasury,
      tokenProgram: TOKEN_PROGRAM,
    })
    .rpc()

  console.log('settled', amount.toString(), 'raw units for provider', providerWallet.toBase58())
  console.log('sig:', sig)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
