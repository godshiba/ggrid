/**
 * Create the $GGRID token as a Token-2022 mint (self-issued route, "Option B").
 *
 * What this does:
 *   - Mints $GGRID under the Token-2022 program (TOKEN_2022_PROGRAM_ID).
 *   - Adds the MetadataPointer + on-chain TokenMetadata extensions (name / symbol / uri).
 *   - Optionally adds a TransferFee extension (set TRANSFER_FEE_BPS to enable).
 *   - Mints the full supply to your wallet's associated token account.
 *
 * What this does NOT do:
 *   - It does not launch on pump.fun. pump.fun mints a *standard* SPL token and keeps
 *     the mint authority, so Token-2022 extensions are impossible there. If you want a
 *     pump.fun fair launch, do that on pump.fun directly - you don't need this script,
 *     and the payout program works with the resulting SPL token unchanged.
 *
 * Run:
 *   npm i
 *   export RPC_URL=https://api.devnet.solana.com
 *   export KEYPAIR=~/.config/solana/id.json
 *   npx ts-node create-token.ts
 */
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from '@solana/web3.js'
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeTransferFeeConfigInstruction,
  getMintLen,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token'
import {
  createInitializeInstruction as createInitializeMetadataInstruction,
  pack,
  TokenMetadata,
} from '@solana/spl-token-metadata'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// ----- config -----
const NAME = process.env.TOKEN_NAME ?? 'GpuGrid'
const SYMBOL = process.env.TOKEN_SYMBOL ?? 'GGRID'
const URI = process.env.TOKEN_URI ?? 'https://gpugrid.xyz/token.json' // hosts the off-chain JSON (image, description)
const DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6)
const SUPPLY = BigInt(process.env.TOKEN_SUPPLY ?? '1000000000') // 1,000,000,000 $GGRID
const TRANSFER_FEE_BPS = Number(process.env.TRANSFER_FEE_BPS ?? 0) // 0 = no on-chain transfer fee (recommended; the payout program handles fees)
const MAX_FEE = BigInt(process.env.TRANSFER_FEE_MAX ?? '0')

function loadKeypair(): Keypair {
  const path = (process.env.KEYPAIR ?? '~/.config/solana/id.json').replace('~', homedir())
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? clusterApiUrl('devnet'), 'confirmed')
  const payer = loadKeypair()
  const mint = Keypair.generate()
  console.log('payer:', payer.publicKey.toBase58())
  console.log('mint :', mint.publicKey.toBase58())

  const metadata: TokenMetadata = {
    mint: mint.publicKey,
    name: NAME,
    symbol: SYMBOL,
    uri: URI,
    additionalMetadata: [['project', 'GpuGrid - decentralized GPU compute']],
  }

  const extensions = [ExtensionType.MetadataPointer]
  if (TRANSFER_FEE_BPS > 0) extensions.push(ExtensionType.TransferFeeConfig)

  // Token-2022 stores metadata in the mint account; size = base extensions + packed metadata.
  const mintLen = getMintLen(extensions)
  const metadataLen = pack(metadata).length + 4 // TLV type+length prefix
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen)

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      payer.publicKey,
      mint.publicKey, // metadata lives in the mint itself
      TOKEN_2022_PROGRAM_ID,
    ),
  )

  if (TRANSFER_FEE_BPS > 0) {
    tx.add(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey, // transfer-fee config authority
        payer.publicKey, // withdraw-withheld authority
        TRANSFER_FEE_BPS,
        MAX_FEE,
        TOKEN_2022_PROGRAM_ID,
      ),
    )
  }

  tx.add(
    createInitializeMintInstruction(
      mint.publicKey,
      DECIMALS,
      payer.publicKey, // mint authority
      null, // freeze authority disabled (cleaner for a community token)
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: payer.publicKey,
      mint: mint.publicKey,
      mintAuthority: payer.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  )

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint])
  console.log('mint created, sig:', sig)

  // Mint the full supply to the payer.
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint.publicKey,
    payer.publicKey,
    false,
    'confirmed',
    undefined,
    TOKEN_2022_PROGRAM_ID,
  )
  const rawSupply = SUPPLY * 10n ** BigInt(DECIMALS)
  const mintSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createMintToInstruction(
        mint.publicKey,
        ata.address,
        payer.publicKey,
        rawSupply,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
    [payer],
  )
  console.log(`minted ${SUPPLY} ${SYMBOL} to ${ata.address.toBase58()}, sig:`, mintSig)

  console.log('\nNEXT STEPS')
  console.log('  - Set GGRID_MINT in the gateway env to:', mint.publicKey.toBase58())
  console.log('  - To renounce control later: disable mint authority and transfer metadata update authority.')
  console.log('  - Seed liquidity on Raydium/Orca (this script does not touch liquidity).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

// silence unused import warnings for helpers kept for reference
void getAssociatedTokenAddressSync
void createAssociatedTokenAccountInstruction
