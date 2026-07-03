/**
 * Anchor test for the payout splitter. Runs against a local validator:
 *   anchor test
 *
 * It mints a Token-2022 $GGRID, deposits, settles a gross amount, and asserts the
 * 75/12.5/7.5/5 split landed (provider/treasury/stakers received, burn reduced supply).
 */
import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import { assert } from 'chai'
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'

describe('ggrid_payout', () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const program = anchor.workspace.GgridPayout as Program<any>
  const authority = (provider.wallet as anchor.Wallet).payer
  const TP = TOKEN_2022_PROGRAM_ID

  let mint: PublicKey
  let config: PublicKey
  let vault: PublicKey
  let treasury: PublicKey
  let stakers: PublicKey
  const providerWallet = Keypair.generate()

  it('sets up the mint and config', async () => {
    mint = await createMint(provider.connection, authority, authority.publicKey, null, 6, undefined, undefined, TP)

    const t = await getOrCreateAssociatedTokenAccount(provider.connection, authority, mint, authority.publicKey, false, undefined, undefined, TP)
    // dedicated treasury + stakers accounts (here owned by authority for the test)
    treasury = (await getOrCreateAssociatedTokenAccount(provider.connection, authority, mint, Keypair.generate().publicKey, false, undefined, undefined, TP)).address
    stakers = (await getOrCreateAssociatedTokenAccount(provider.connection, authority, mint, Keypair.generate().publicKey, false, undefined, undefined, TP)).address
    await mintTo(provider.connection, authority, mint, t.address, authority, 1_000_000_000, [], undefined, TP)

    ;[config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)
    vault = getAssociatedTokenAddressSync(mint, config, true, TP)

    await program.methods
      .initialize(7500, 1250, 750, 500)
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

    const cfg = await program.account.config.fetch(config)
    assert.equal(cfg.providerBps, 7500)
  })

  it('deposits and settles with the 75/12.5/7.5/5 split', async () => {
    const userToken = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TP)
    const [userAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), authority.publicKey.toBuffer()],
      program.programId,
    )

    await program.methods
      .deposit(new anchor.BN(1_000_000))
      .accounts({ config, user: authority.publicKey, userAccount, mint, userToken, vault, tokenProgram: TP })
      .rpc()

    const providerToken = (await getOrCreateAssociatedTokenAccount(provider.connection, authority, mint, providerWallet.publicKey, false, undefined, undefined, TP)).address
    const supplyBefore = (await getMint(provider.connection, mint, undefined, TP)).supply

    await program.methods
      .settle(new anchor.BN(1_000_000))
      .accounts({ config, authority: authority.publicKey, mint, vault, providerToken, stakers, treasury, tokenProgram: TP })
      .rpc()

    const prov = await getAccount(provider.connection, providerToken, undefined, TP)
    const treas = await getAccount(provider.connection, treasury, undefined, TP)
    const stk = await getAccount(provider.connection, stakers, undefined, TP)
    const supplyAfter = (await getMint(provider.connection, mint, undefined, TP)).supply

    assert.equal(prov.amount.toString(), '750000', 'provider 75%')
    assert.equal(stk.amount.toString(), '75000', 'stakers 7.5%')
    assert.equal(treas.amount.toString(), '50000', 'treasury 5%')
    assert.equal((supplyBefore - supplyAfter).toString(), '125000', 'burned 12.5%')
  })

  it('shutdown sweeps the vault and closes config + vault (rent back to authority)', async () => {
    const recipientToken = (await getOrCreateAssociatedTokenAccount(provider.connection, authority, mint, authority.publicKey, false, undefined, undefined, TP)).address
    const before = await provider.connection.getBalance(authority.publicKey)

    await program.methods
      .shutdown()
      .accounts({ config, authority: authority.publicKey, mint, vault, recipientToken, tokenProgram: TP })
      .rpc()

    const after = await provider.connection.getBalance(authority.publicKey)
    assert.isAbove(after, before, 'reclaimed rent landed back in authority')

    // config PDA must be gone
    const acc = await provider.connection.getAccountInfo(config)
    assert.isNull(acc, 'config PDA closed')
  })
})
