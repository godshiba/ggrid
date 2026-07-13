import { createHash } from 'node:crypto'
import { config, stakeConfigured } from './config'
import { rpcFetch } from './cache'

// $GGRID staking client.
//
// Stakers earn the 20% cut that `ggrid_payout::settle` pays into a token account
// owned by the stake pool PDA. All three user actions (stake / unstake / claim) are
// signed by the STAKER, so this module never touches the authority key - it reads
// the pool from chain and hands back unsigned transactions for the wallet to sign.
//
// Accounts are decoded by hand (no IDL dependency), mirroring the layouts in
// onchain/programs/ggrid_stake/src/lib.rs. Heavy Solana deps load lazily so the
// gateway boots and tests run without them.

const ACC_SCALE = 1_000_000_000_000n

/// Mirrors `MIN_STAKE` in lib.rs: a position is 0 or >= 1 $GGRID (1e6 raw). The program
/// rejects anything else; we reject it here too so the user sees a readable message
/// instead of a simulation failure in their wallet.
export const MIN_STAKE_RAW = 1_000_000n

export function stakeEnabled(): boolean {
  return stakeConfigured()
}

interface StakeClient {
  web3: any
  splToken: any
  connection: any
  programId: any
  mint: any
  tokenProgram: any
  pool: any
  stakeVault: any
}
let cached: StakeClient | null = null

async function client(): Promise<StakeClient> {
  if (cached) return cached
  if (!stakeConfigured()) throw new Error('staking not configured (needs SOLANA_RPC_URL + GGRID_MINT + GGRID_STAKE_PROGRAM_ID)')
  const web3 = await import('@solana/web3.js')
  const splToken = await import('@solana/spl-token')
  const connection = new web3.Connection(config.solana.rpcUrl, { commitment: 'confirmed', fetch: rpcFetch })
  const programId = new web3.PublicKey(config.stake.programId)
  const mint = new web3.PublicKey(config.solana.mint)
  const tokenProgram = config.solana.tokenProgram === 'token' ? splToken.TOKEN_PROGRAM_ID : splToken.TOKEN_2022_PROGRAM_ID
  const [pool] = web3.PublicKey.findProgramAddressSync([Buffer.from('pool')], programId)
  const [stakeVault] = web3.PublicKey.findProgramAddressSync([Buffer.from('stake_vault')], programId)
  cached = { web3, splToken, connection, programId, mint, tokenProgram, pool, stakeVault }
  return cached
}

// Anchor instruction discriminator = first 8 bytes of sha256("global:<name>").
export function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

const u64 = (buf: Buffer, o: number): bigint => buf.readBigUInt64LE(o)
const u128 = (buf: Buffer, o: number): bigint => u64(buf, o) | (u64(buf, o + 8) << 64n)

// Pool: disc(8) authority(32) mint(32) stake_vault(32) reward_vault(32)
//       total_staked(8) acc_reward_per_share(16) last_reward_balance(8)
//       total_claimed(8) total_rewards(8) stranded_rewards(8) bump(1)
// lib.rs asserts `Pool::LEN == Pool::INIT_SPACE` at compile time, so POOL_SIZE below
// is the authority on whether these offsets still line up with the Rust struct.
export const POOL_SIZE = 8 + 32 * 4 + 8 + 16 + 8 + 8 + 8 + 8 + 1
export const STAKE_ACCOUNT_SIZE = 8 + 32 + 8 + 16 + 8 + 1

export interface PoolState {
  rewardVault: string
  totalStaked: bigint
  accRewardPerShare: bigint
  lastRewardBalance: bigint
  totalClaimed: bigint
  totalRewards: bigint
  strandedRewards: bigint
}
export function decodePool(data: Buffer, web3: any): PoolState {
  // Anchor allocates exactly 8 + Pool::LEN. Any other size means the deployed program
  // no longer matches these offsets - refuse to guess rather than misread a balance.
  if (data.length !== POOL_SIZE)
    throw new Error(`pool layout drift: account is ${data.length} bytes, expected ${POOL_SIZE}`)
  let o = 8 + 32 + 32 + 32
  const rewardVault = new web3.PublicKey(data.subarray(o, o + 32)).toBase58()
  o += 32
  const totalStaked = u64(data, o); o += 8
  const accRewardPerShare = u128(data, o); o += 16
  const lastRewardBalance = u64(data, o); o += 8
  const totalClaimed = u64(data, o); o += 8
  const totalRewards = u64(data, o); o += 8
  const strandedRewards = u64(data, o)
  return { rewardVault, totalStaked, accRewardPerShare, lastRewardBalance, totalClaimed, totalRewards, strandedRewards }
}

// StakeAccount: disc(8) owner(32) amount(8) reward_debt(16) pending(8) bump(1)
export interface StakeState {
  amount: bigint
  rewardDebt: bigint
  pending: bigint
}
export function decodeStake(data: Buffer): StakeState {
  if (data.length !== STAKE_ACCOUNT_SIZE)
    throw new Error(`stake layout drift: account is ${data.length} bytes, expected ${STAKE_ACCOUNT_SIZE}`)
  let o = 8 + 32
  const amount = u64(data, o); o += 8
  const rewardDebt = u128(data, o); o += 16
  const pending = u64(data, o)
  return { amount, rewardDebt, pending }
}

// Mirror of the program's accrue + harvest, read-only, so the UI can show the exact
// number the next `claim` would pay. Must stay in step with lib.rs.
export function claimableOf(pool: PoolState, s: StakeState, rewardBalance: bigint): bigint {
  let acc = pool.accRewardPerShare
  const delta = rewardBalance > pool.lastRewardBalance ? rewardBalance - pool.lastRewardBalance : 0n
  if (delta > 0n && pool.totalStaked > 0n) acc += (delta * ACC_SCALE) / pool.totalStaked
  const accrued = s.amount * acc
  const owed = (accrued > s.rewardDebt ? accrued - s.rewardDebt : 0n) / ACC_SCALE
  const total = s.pending + owed
  return total < rewardBalance ? total : rewardBalance // the program caps at the vault
}

async function tokenBalance(c: StakeClient, account: any): Promise<bigint> {
  try {
    const res = await c.connection.getTokenAccountBalance(account)
    return BigInt(res.value.amount)
  } catch {
    return 0n // account doesn't exist yet
  }
}

export interface PoolInfo {
  programId: string
  pool: string
  mint: string
  decimals: number
  minStake: string
  totalStaked: string
  rewardPool: string // $GGRID sitting in the reward vault right now
  claimableRewards: string // rewardPool minus what nobody can ever claim
  strandedRewards: string // arrived while nothing was staked; unclaimable by design
  totalRewards: string
  totalClaimed: string
  initialized: boolean
}

// Public view of the staking pool. `initialized:false` when the pool PDA doesn't
// exist yet (program deployed but `initialize` not run) - the UI degrades gracefully.
export async function poolInfo(): Promise<PoolInfo> {
  const c = await client()
  const base = {
    programId: config.stake.programId,
    pool: c.pool.toBase58(),
    mint: c.mint.toBase58(),
    decimals: config.solana.decimals,
    minStake: MIN_STAKE_RAW.toString(),
  }
  const acct = await c.connection.getAccountInfo(c.pool)
  if (!acct) {
    return {
      ...base, totalStaked: '0', rewardPool: '0', claimableRewards: '0', strandedRewards: '0',
      totalRewards: '0', totalClaimed: '0', initialized: false,
    }
  }
  const p = decodePool(acct.data as Buffer, c.web3)
  const rewardBalance = await tokenBalance(c, new c.web3.PublicKey(p.rewardVault))
  // Don't advertise stranded tokens as a reward pool - nobody can ever claim them.
  const claimable = rewardBalance > p.strandedRewards ? rewardBalance - p.strandedRewards : 0n
  return {
    ...base,
    totalStaked: p.totalStaked.toString(),
    rewardPool: rewardBalance.toString(),
    claimableRewards: claimable.toString(),
    strandedRewards: p.strandedRewards.toString(),
    totalRewards: p.totalRewards.toString(),
    totalClaimed: p.totalClaimed.toString(),
    initialized: true,
  }
}

export interface Position {
  wallet: string
  staked: string
  claimable: string
  walletBalance: string
  decimals: number
}

// A wallet's stake + exactly what `claim` would pay right now.
export async function position(wallet: string): Promise<Position> {
  const c = await client()
  const owner = new c.web3.PublicKey(wallet)
  const [stakePda] = c.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('stake'), owner.toBuffer()],
    c.programId,
  )
  const userToken = c.splToken.getAssociatedTokenAddressSync(c.mint, owner, true, c.tokenProgram)
  const walletBalance = await tokenBalance(c, userToken)

  const [poolAcct, stakeAcct] = await Promise.all([
    c.connection.getAccountInfo(c.pool),
    c.connection.getAccountInfo(stakePda),
  ])
  if (!poolAcct || !stakeAcct)
    return { wallet, staked: '0', claimable: '0', walletBalance: walletBalance.toString(), decimals: config.solana.decimals }

  const p = decodePool(poolAcct.data as Buffer, c.web3)
  const s = decodeStake(stakeAcct.data as Buffer)
  const rewardBalance = await tokenBalance(c, new c.web3.PublicKey(p.rewardVault))
  return {
    wallet,
    staked: s.amount.toString(),
    claimable: claimableOf(p, s, rewardBalance).toString(),
    walletBalance: walletBalance.toString(),
    decimals: config.solana.decimals,
  }
}

type Action = 'stake' | 'unstake' | 'claim'

export interface IxAccounts {
  pool: any
  user: any
  stakePda: any
  mint: any
  userToken: any
  stakeVault: any
  rewardVault: any
  tokenProgram: any
  systemProgram: any
}
export interface IxKey {
  pubkey: any
  isSigner: boolean
  isWritable: boolean
}

/**
 * The data + account list for one stake/unstake/claim instruction. Pure: no RPC, no
 * clock, no wallet - so a test can assert the exact ordering and the writable/signer
 * flags against the `#[derive(Accounts)]` structs in lib.rs. Anchor matches accounts
 * POSITIONALLY, so a single swapped entry is a silent, funds-losing bug.
 */
export function buildStakeIx(action: Action, a: IxAccounts, rawAmount: bigint): { keys: IxKey[]; data: Buffer } {
  const rw = (pubkey: any, isWritable: boolean, isSigner = false): IxKey => ({ pubkey, isSigner, isWritable })

  if (action === 'claim') {
    // Claim<'info>: pool, user, stake_account, mint, user_token, reward_vault, token_program
    return {
      data: discriminator('claim'),
      keys: [
        rw(a.pool, true),
        rw(a.user, false, true),
        rw(a.stakePda, true),
        rw(a.mint, false),
        rw(a.userToken, true),
        rw(a.rewardVault, true),
        rw(a.tokenProgram, false),
      ],
    }
  }

  if (rawAmount <= 0n) throw new Error('amount must be greater than zero')
  const amountLE = Buffer.alloc(8)
  amountLE.writeBigUInt64LE(rawAmount)
  const data = Buffer.concat([discriminator(action), amountLE])

  if (action === 'stake') {
    // Stake<'info>: pool, user(mut, payer), stake_account, mint, user_token,
    //               stake_vault, reward_vault(ro), token_program, system_program
    return {
      data,
      keys: [
        rw(a.pool, true),
        rw(a.user, true, true),
        rw(a.stakePda, true),
        rw(a.mint, false),
        rw(a.userToken, true),
        rw(a.stakeVault, true),
        rw(a.rewardVault, false),
        rw(a.tokenProgram, false),
        rw(a.systemProgram, false),
      ],
    }
  }

  // Unstake<'info>: same as Stake minus system_program (no init).
  return {
    data,
    keys: [
      rw(a.pool, true),
      rw(a.user, false, true),
      rw(a.stakePda, true),
      rw(a.mint, false),
      rw(a.userToken, true),
      rw(a.stakeVault, true),
      rw(a.rewardVault, false),
      rw(a.tokenProgram, false),
    ],
  }
}

/// Reject positions the program would reject, with a message a human can act on.
/// `current` is the staker's position BEFORE this action.
export function assertMinStake(action: Action, current: bigint, rawAmount: bigint): void {
  const min = MIN_STAKE_RAW
  if (action === 'stake' && current + rawAmount < min)
    throw new Error(`a stake position must be at least ${Number(min) / 1e6} $GGRID`)
  if (action === 'unstake') {
    const left = current - rawAmount
    if (left > 0n && left < min)
      throw new Error(`unstake everything, or leave at least ${Number(min) / 1e6} $GGRID staked`)
  }
}

// Build an UNSIGNED stake/unstake/claim transaction. feePayer = the staker; they sign
// and send it.
export async function buildTx(action: Action, wallet: string, rawAmount: bigint): Promise<string> {
  const c = await client()
  const { PublicKey, TransactionInstruction, Transaction, SystemProgram } = c.web3
  const user = new PublicKey(wallet)
  const [stakePda] = PublicKey.findProgramAddressSync([Buffer.from('stake'), user.toBuffer()], c.programId)
  const userToken = c.splToken.getAssociatedTokenAddressSync(c.mint, user, true, c.tokenProgram)

  const [poolAcct, stakeAcct] = await Promise.all([
    c.connection.getAccountInfo(c.pool),
    c.connection.getAccountInfo(stakePda),
  ])
  if (!poolAcct) throw new Error('staking pool is not initialized yet')
  const p = decodePool(poolAcct.data as Buffer, c.web3)
  const rewardVault = new PublicKey(p.rewardVault)

  if (action !== 'claim') {
    const current = stakeAcct ? decodeStake(stakeAcct.data as Buffer).amount : 0n
    if (action === 'unstake' && rawAmount > current) throw new Error('you have not staked that much')
    assertMinStake(action, current, rawAmount)
  }

  const { keys, data } = buildStakeIx(
    action,
    { pool: c.pool, user, stakePda, mint: c.mint, userToken, stakeVault: c.stakeVault, rewardVault, tokenProgram: c.tokenProgram, systemProgram: SystemProgram.programId },
    rawAmount,
  )

  const ix = new TransactionInstruction({ programId: c.programId, keys, data })
  const { blockhash } = await c.connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: user, recentBlockhash: blockhash })
  // `unstake` and `claim` send tokens BACK to the staker. If they closed their ATA (or
  // claim rewards from a wallet that never held $GGRID) the transfer would fail on an
  // account the program can't create. Idempotent: a no-op when the ATA already exists.
  if (action !== 'stake') {
    tx.add(
      c.splToken.createAssociatedTokenAccountIdempotentInstruction(user, userToken, user, c.mint, c.tokenProgram),
    )
  }
  tx.add(ix)
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
}
