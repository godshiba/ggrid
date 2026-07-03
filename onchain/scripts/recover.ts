/**
 * Step 1 of teardown — reclaim rent locked in the PROGRAM's accounts.
 *
 * Calls `shutdown`, which:
 *   - moves any leftover $GGRID from the vault back to your recipient token account,
 *   - closes the vault token account (rent -> authority),
 *   - closes the config PDA (rent -> authority).
 * Then closes the treasury & stakers token accounts you own (after sweeping their
 * tokens to the recipient), reclaiming their rent too.
 *
 * The BIG chunk (the ~1.5-2 SOL program rent) is reclaimed separately by recover.sh
 * via `solana program close` — a PDA instruction can't close the program itself.
 *
 * Run:
 *   AUTHORITY_KEYPAIR=~/.config/solana/id.json \
 *   PROGRAM_ID=... GGRID_MINT=... RECIPIENT_WALLET=<pubkey to receive tokens> \
 *   npx ts-node recover.ts
 */
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import idl from '../target/idl/ggrid_payout.json'

// Match the mint's token program. pump.fun mints classic SPL -> TOKEN_PROGRAM=token.
const TP = (process.env.TOKEN_PROGRAM ?? 'token2022') === 'token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID

function loadKeypair(envVar: string, fallback: string): Keypair {
  const path = (process.env[envVar] ?? fallback).replace('~', homedir())
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed')
  const authority = loadKeypair('AUTHORITY_KEYPAIR', '~/.config/solana/id.json')
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: 'confirmed' })
  anchor.setProvider(provider)

  const programId = new PublicKey(process.env.PROGRAM_ID ?? (idl as any).address)
  const program = new anchor.Program(idl as anchor.Idl, provider)
  const mint = new PublicKey(process.env.GGRID_MINT!)
  const recipientWallet = new PublicKey(process.env.RECIPIENT_WALLET ?? authority.publicKey.toBase58())

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)
  const cfg = await (program.account as any).config.fetch(config)

  // recipient ATA that will receive any leftover $GGRID
  const recipientToken = (
    await getOrCreateAssociatedTokenAccount(connection, authority, mint, recipientWallet, false, 'confirmed', undefined, TP)
  ).address

  console.log('calling shutdown (sweeps vault, closes vault + config)...')
  const sig = await program.methods
    .shutdown()
    .accounts({
      config,
      authority: authority.publicKey,
      mint,
      vault: cfg.vault,
      recipientToken,
      tokenProgram: TP,
    })
    .rpc()
  console.log('  shutdown sig:', sig)

  // close treasury + stakers token accounts if the authority owns them (sweep first).
  for (const [label, addr] of [['treasury', cfg.treasury], ['stakers', cfg.stakers]] as const) {
    try {
      const acc = await getAccount(connection, addr, 'confirmed', TP)
      if (!acc.owner.equals(authority.publicKey)) {
        console.log(`  skip ${label}: owned by ${acc.owner.toBase58()}, close it from that wallet`)
        continue
      }
      const tx = new Transaction()
      if (acc.amount > 0n) {
        const dec = (await import('@solana/spl-token')).getMint
        const mintInfo = await dec(connection, mint, 'confirmed', TP)
        tx.add(
          createTransferCheckedInstruction(addr, mint, recipientToken, authority.publicKey, acc.amount, mintInfo.decimals, [], TP),
        )
      }
      tx.add(createCloseAccountInstruction(addr, authority.publicKey, authority.publicKey, [], TP))
      const s = await sendAndConfirmTransaction(connection, tx, [authority])
      console.log(`  closed ${label}, sig:`, s)
    } catch (e) {
      console.log(`  ${label}: nothing to close (${(e as Error).message})`)
    }
  }

  console.log('\nprogram accounts reclaimed. Now run recover.sh to close the program itself.')
  console.log('authority SOL balance:', (await connection.getBalance(authority.publicKey)) / 1e9, 'SOL')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

void getAssociatedTokenAddressSync
