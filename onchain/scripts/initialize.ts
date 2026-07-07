/**
 * Initialize the deployed ggrid_payout program (run once, after `anchor deploy`).
 *
 * Creates the treasury + stakers token accounts (by default ATAs owned by the
 * authority - pass TREASURY_OWNER / STAKERS_OWNER to use other wallets / a multisig),
 * derives the vault ATA of the config PDA, and calls
 * initialize(provider_bps, burn_bps, stakers_bps, treasury_bps) = 7500/1250/750/500.
 *
 * Run:
 *   AUTHORITY_KEYPAIR=~/.config/solana/id.json PROGRAM_ID=... GGRID_MINT=... \
 *   npx ts-node initialize.ts
 */
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import idl from '../target/idl/ggrid_payout.json'

const TP = (process.env.TOKEN_PROGRAM ?? 'token2022') === 'token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID

const PROVIDER_BPS = Number(process.env.PROVIDER_BPS ?? 7500)
const BURN_BPS = Number(process.env.BURN_BPS ?? 1250)
const STAKERS_BPS = Number(process.env.STAKERS_BPS ?? 750)
const TREASURY_BPS = Number(process.env.TREASURY_BPS ?? 500)

function loadKeypair(envVar: string, fallback: string): Keypair {
  const path = (process.env[envVar] ?? fallback).replace('~', homedir())
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

async function main() {
  if (PROVIDER_BPS + BURN_BPS + STAKERS_BPS + TREASURY_BPS !== 10000)
    throw new Error('bps must sum to 10000')

  const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed')
  const authority = loadKeypair('AUTHORITY_KEYPAIR', '~/.config/solana/id.json')
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: 'confirmed' })
  anchor.setProvider(provider)

  const programId = new PublicKey(process.env.PROGRAM_ID ?? (idl as any).address)
  const program = new anchor.Program(idl as anchor.Idl, provider)
  const mint = new PublicKey(process.env.GGRID_MINT!)

  const treasuryOwner = new PublicKey(process.env.TREASURY_OWNER ?? authority.publicKey.toBase58())
  const stakersOwner = new PublicKey(process.env.STAKERS_OWNER ?? authority.publicKey.toBase58())

  const treasury = (await getOrCreateAssociatedTokenAccount(connection, authority, mint, treasuryOwner, false, 'confirmed', undefined, TP)).address
  const stakers = (await getOrCreateAssociatedTokenAccount(connection, authority, mint, stakersOwner, false, 'confirmed', undefined, TP)).address

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)
  const vault = getAssociatedTokenAddressSync(mint, config, true, TP)

  console.log('program  :', programId.toBase58())
  console.log('mint     :', mint.toBase58())
  console.log('config   :', config.toBase58())
  console.log('vault    :', vault.toBase58())
  console.log('treasury :', treasury.toBase58())
  console.log('stakers  :', stakers.toBase58())
  console.log(`split    : ${PROVIDER_BPS}/${BURN_BPS}/${STAKERS_BPS}/${TREASURY_BPS} bps`)

  const sig = await program.methods
    .initialize(PROVIDER_BPS, BURN_BPS, STAKERS_BPS, TREASURY_BPS)
    .accounts({
      authority: authority.publicKey,
      config,
      mint,
      vault,
      treasury,
      stakers,
      tokenProgram: TP,
    })
    .rpc()

  console.log('\ninitialized, sig:', sig)
  console.log('\nNow set these in the gateway env (.env / the deploy platform Secrets):')
  console.log('  SOLANA_RPC_URL =', process.env.RPC_URL ?? 'https://api.devnet.solana.com')
  console.log('  GGRID_PROGRAM_ID =', programId.toBase58())
  console.log('  GGRID_MINT =', mint.toBase58())
  console.log('  GGRID_TOKEN_PROGRAM =', TP.equals(TOKEN_2022_PROGRAM_ID) ? 'token2022' : 'token')
  console.log('  GGRID_AUTHORITY_KEY = <the authority keypair> (the deploy platform Secret)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
