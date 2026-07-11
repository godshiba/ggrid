use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// Replace with the address printed by `anchor keys list` after the first build.
declare_id!("DNScf1sutG7Aaq9KNjTejgJPyntTCXH1ntvY3K3LDekt");

/// Fixed-point scale for `acc_reward_per_share`. 1e12 gives ample precision for a
/// 6-decimal mint without ever coming close to overflowing the u128 accumulator.
const ACC_SCALE: u128 = 1_000_000_000_000;

/// The mint this program is built for. Pinned at `initialize` because both
/// `MIN_STAKE` and the overflow bound below are stated in raw units and only hold
/// at this scale. A different mint must re-derive them, not silently reuse them.
const MINT_DECIMALS: u8 = 6;

/// Smallest position anyone may hold: 1 $GGRID (1e6 raw).
///
/// This is not a UX knob, it is the overflow bound. `acc_reward_per_share` grows by
/// `delta * ACC_SCALE / total_staked`, so a lone 1-raw-unit staker would let it climb
/// by 1e12 per raw unit of fees. `harvest` then computes `amount * acc`, and a whale
/// staking afterwards would overflow the u128 - reverting their `unstake` and locking
/// their principal forever. Holding every position at >= 1e6 raw caps the accumulator
/// at `1e6 * total_rewards`, so `amount * acc <= 1e15 * 1e21 = 1e36`, comfortably
/// inside u128::MAX (~3.4e38) even if the entire supply were staked.
const MIN_STAKE: u64 = 1_000_000;

/// GpuGrid $GGRID staking.
///
/// What it does: you stake $GGRID, and you earn a proportional share of the 20%
/// "stakers" cut that `ggrid_payout::settle` takes out of every job.
///
/// How the two programs connect (this is the whole trick):
///   `ggrid_payout` blindly transfers the stakers cut into whatever token account
///   is stored in its `config.stakers`. If that account is owned by THIS program's
///   `pool` PDA, the fee stream lands directly in `reward_vault` and no change to
///   the already-deployed payout program is needed. Set it up either by
///   initializing payout with `stakers = reward_vault`, or by re-assigning the
///   existing stakers token account's owner to the pool PDA (`spl-token authorize`).
///
/// Accounting model (MasterChef-style accumulator):
///   Rewards arrive with NO callback - the payout program just moves tokens in. So
///   new rewards are detected as the balance delta of `reward_vault` since the last
///   accrual (`last_reward_balance`). That delta is folded into a global
///   `acc_reward_per_share`; each staker's claim is `amount * acc / SCALE` minus the
///   `reward_debt` snapshot taken when their stake last changed.
///
///   Principal and rewards live in SEPARATE vaults on purpose. They are the same
///   mint, so if staked principal shared the reward account, every stake deposit
///   would look like an incoming reward and be handed out to everyone.
///
/// Solvency: every division floors the pool's way, so total claimable is bounded
/// above by the tokens that actually arrived and `reward_vault` can never be drained
/// below zero. The trade-off is a sub-unit of dust forfeited per harvest, which stays
/// in the vault permanently (it is already counted in `acc_reward_per_share`, so it
/// is not redistributed). At 6 decimals that is under a millionth of a token per
/// harvest - deliberately preferred over any rounding that could over-credit a
/// pre-funded pool.
///
/// Empty pool: fees that land while `total_staked == 0` have no one to accrue to. They
/// are banked into `stranded_rewards` and the accrual baseline moves past them, so they
/// sit in the vault unclaimable forever. Rolling them into the next accrual instead
/// would hand the whole backlog to whoever stakes first - and since the share is
/// proportional, staking a single raw unit would be enough to take all of it. Stranding
/// is the safe direction; the deployment runbook avoids the loss entirely by seeding a
/// stake BEFORE pointing `ggrid_payout.config.stakers` at `reward_vault`.
/// Invariant: `reward_vault == stranded_rewards + total_rewards - total_claimed`.
///
/// Unstaking is instant - there is no lock-up. Rewards accrued up to that moment are
/// preserved in `pending` and can still be claimed.
///
/// Mint: built with `token_interface` for code reuse, but `initialize` PINS the pool to
/// the classic SPL Token program. $GGRID is a classic SPL mint (pump.fun route). This is
/// a solvency guard, not a style choice: a Token-2022 mint carrying a transfer-fee (or
/// transfer-hook) extension would skim principal in transit, so `stake_vault` would
/// receive less than the `amount` we credit to `sa.amount` / `total_staked`. The reward
/// side is immune (it measures the real balance delta), but the principal side trusts
/// the requested amount, so the last unstakers would revert on an underfunded vault -
/// their principal locked. Pinning to a fee-less token program removes the whole class.
#[program]
pub mod ggrid_stake {
    use super::*;

    /// One-time setup. `reward_vault` must already exist and be owned by the `pool`
    /// PDA - that is the account `ggrid_payout` pays the 20% stakers cut into.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // Both vaults satisfy `token::authority = pool`, so nothing in the account
        // constraints stops the caller passing the freshly-created stake vault as the
        // reward vault too. That single account would then hold principal AND rewards,
        // making every stake deposit look like an incoming reward.
        require_keys_neq!(
            ctx.accounts.stake_vault.key(),
            ctx.accounts.reward_vault.key(),
            StakeError::VaultsMustDiffer
        );
        // Pin to the classic SPL Token program: a fee-bearing Token-2022 mint would skim
        // principal in transit and eventually strand the last unstakers' funds. $GGRID is
        // classic SPL, so this only forbids a mis-wire, never a legitimate deployment.
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            StakeError::UnsupportedTokenProgram
        );
        // MIN_STAKE and the u128 bound in `harvest` are stated in raw units at 6 decimals.
        require_eq!(ctx.accounts.mint.decimals, MINT_DECIMALS, StakeError::UnexpectedDecimals);

        let p = &mut ctx.accounts.pool;
        p.authority = ctx.accounts.authority.key();
        p.mint = ctx.accounts.mint.key();
        p.stake_vault = ctx.accounts.stake_vault.key();
        p.reward_vault = ctx.accounts.reward_vault.key();
        p.total_staked = 0;
        p.acc_reward_per_share = 0;
        // Baseline at the vault's current balance: whatever is already sitting there is
        // treated as accounted, so the first staker cannot scoop fees earned before the
        // pool existed. The flip side: any balance present at init is never distributed,
        // and there is deliberately no sweep instruction (that would be a rug vector).
        // => Initialize this pool BEFORE ggrid_payout starts settling fees into it.
        p.last_reward_balance = ctx.accounts.reward_vault.amount;
        p.stranded_rewards = ctx.accounts.reward_vault.amount;
        p.total_claimed = 0;
        p.total_rewards = 0;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Move `amount` $GGRID from the caller into the stake vault.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);

        let reward_balance = ctx.accounts.reward_vault.amount;
        accrue(&mut ctx.accounts.pool, reward_balance)?;
        harvest(&ctx.accounts.pool, &mut ctx.accounts.stake_account)?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let sa = &mut ctx.accounts.stake_account;
        sa.owner = ctx.accounts.user.key();
        sa.bump = ctx.bumps.stake_account;
        sa.amount = sa.amount.checked_add(amount).ok_or(StakeError::Overflow)?;

        // Topping up a small amount is fine; the resulting POSITION must clear MIN_STAKE.
        require!(sa.amount >= MIN_STAKE, StakeError::BelowMinimumStake);

        let p = &mut ctx.accounts.pool;
        p.total_staked = p.total_staked.checked_add(amount).ok_or(StakeError::Overflow)?;

        sa.reward_debt = reward_debt_of(sa.amount, p.acc_reward_per_share)?;

        emit!(Staked { user: sa.owner, amount, total_staked: p.total_staked });
        Ok(())
    }

    /// Withdraw `amount` of staked principal. Instant, no lock-up. Accrued rewards
    /// are preserved in `pending` and remain claimable.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        require!(amount <= ctx.accounts.stake_account.amount, StakeError::InsufficientStake);

        let reward_balance = ctx.accounts.reward_vault.amount;
        accrue(&mut ctx.accounts.pool, reward_balance)?;
        harvest(&ctx.accounts.pool, &mut ctx.accounts.stake_account)?;

        let bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[b"pool", core::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let sa = &mut ctx.accounts.stake_account;
        sa.amount = sa.amount.checked_sub(amount).ok_or(StakeError::Overflow)?;
        // Exit fully or stay above the floor - never leave a dust position behind, or
        // `total_staked` could shrink to a few raw units and blow up the accumulator.
        require!(sa.amount == 0 || sa.amount >= MIN_STAKE, StakeError::BelowMinimumStake);

        let p = &mut ctx.accounts.pool;
        p.total_staked = p.total_staked.checked_sub(amount).ok_or(StakeError::Overflow)?;

        sa.reward_debt = reward_debt_of(sa.amount, p.acc_reward_per_share)?;

        emit!(Unstaked { user: sa.owner, amount, total_staked: p.total_staked });
        Ok(())
    }

    /// Pay out everything the caller has earned so far, in real $GGRID.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let reward_balance = ctx.accounts.reward_vault.amount;
        accrue(&mut ctx.accounts.pool, reward_balance)?;
        harvest(&ctx.accounts.pool, &mut ctx.accounts.stake_account)?;

        // Never try to move more than the vault actually holds.
        let payout = ctx.accounts.stake_account.pending.min(reward_balance);
        require!(payout > 0, StakeError::NothingToClaim);

        let bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[b"pool", core::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            payout,
            ctx.accounts.mint.decimals,
        )?;

        let sa = &mut ctx.accounts.stake_account;
        sa.pending = sa.pending.saturating_sub(payout);

        let p = &mut ctx.accounts.pool;
        // The vault balance just dropped; keep the accrual baseline in step or the
        // next `accrue` would read a negative delta.
        p.last_reward_balance = p.last_reward_balance.saturating_sub(payout);
        p.total_claimed = p.total_claimed.checked_add(payout).ok_or(StakeError::Overflow)?;

        emit!(Claimed { user: sa.owner, amount: payout });
        Ok(())
    }

    pub fn set_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.pool.authority = new_authority;
        Ok(())
    }
}

/// Fold any newly-arrived rewards into the global accumulator.
///
/// `delta` is whatever landed in `reward_vault` since the last accrual.
///
/// With nothing staked there is no denominator, so the delta cannot be shared out. It
/// is banked into `stranded_rewards` and the baseline advances past it. Leaving the
/// baseline behind instead would defer the whole backlog to the next accrual, where a
/// single raw unit of stake would collect 100% of it - `total_staked` is the divisor,
/// not a stake-weighted average, so being the only staker for one instruction is worth
/// the entire vault.
fn accrue(pool: &mut Account<Pool>, reward_balance: u64) -> Result<()> {
    let delta = reward_balance.saturating_sub(pool.last_reward_balance);
    if delta == 0 {
        return Ok(());
    }
    if pool.total_staked == 0 {
        pool.last_reward_balance = reward_balance;
        pool.stranded_rewards = pool
            .stranded_rewards
            .checked_add(delta)
            .ok_or(StakeError::Overflow)?;
        return Ok(());
    }
    let inc = (delta as u128)
        .checked_mul(ACC_SCALE)
        .ok_or(StakeError::Overflow)?
        / (pool.total_staked as u128);

    pool.acc_reward_per_share = pool
        .acc_reward_per_share
        .checked_add(inc)
        .ok_or(StakeError::Overflow)?;
    pool.last_reward_balance = reward_balance;
    pool.total_rewards = pool.total_rewards.checked_add(delta).ok_or(StakeError::Overflow)?;
    Ok(())
}

/// Roll the staker's newly-earned amount into `pending` and re-snapshot their debt.
/// Must run AFTER `accrue` and BEFORE `amount` changes.
///
/// `reward_debt` deliberately holds the UNDIVIDED product `amount * acc`, so `owed`
/// floors exactly once, over the whole period. Storing the already-divided value
/// instead would make `owed` a difference of two floors, which can exceed the true
/// increment by almost a full unit on every stake/unstake - and since this pool is
/// pre-funded (rewards are transferred in, not minted), that over-credit is a hole
/// in the vault. Rounding must always fall the pool's way.
fn harvest(pool: &Account<Pool>, sa: &mut Account<StakeAccount>) -> Result<()> {
    let accrued = reward_debt_of(sa.amount, pool.acc_reward_per_share)?;
    let owed = accrued.saturating_sub(sa.reward_debt) / ACC_SCALE;
    if owed > 0 {
        let owed_u64 = u64::try_from(owed).map_err(|_| StakeError::Overflow)?;
        sa.pending = sa.pending.checked_add(owed_u64).ok_or(StakeError::Overflow)?;
    }
    sa.reward_debt = accrued;
    Ok(())
}

/// Scaled claim basis for a stake at the current accumulator: `amount * acc` (NOT
/// divided by ACC_SCALE - see `harvest`).
fn reward_debt_of(amount: u64, acc_reward_per_share: u128) -> Result<u128> {
    Ok((amount as u128)
        .checked_mul(acc_reward_per_share)
        .ok_or(StakeError::Overflow)?)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Pool::LEN, seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Holds staked principal. Created here, owned by the pool PDA.
    #[account(
        init,
        payer = authority,
        seeds = [b"stake_vault"],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,
    /// Receives the 20% stakers cut from `ggrid_payout::settle`. Must ALREADY be
    /// owned by the pool PDA - this is what wires the two programs together.
    #[account(token::mint = mint, token::authority = pool, token::token_program = token_program)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [b"pool"], bump = pool.bump, has_one = mint, has_one = stake_vault, has_one = reward_vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + StakeAccount::LEN,
        seeds = [b"stake", user.key().as_ref()],
        bump
    )]
    pub stake_account: Account<'info, StakeAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = pool.reward_vault)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [b"pool"], bump = pool.bump, has_one = mint, has_one = stake_vault, has_one = reward_vault)]
    pub pool: Account<'info, Pool>,
    pub user: Signer<'info>,
    // The seeds bind this PDA to `user`, so no extra owner check is needed.
    #[account(mut, seeds = [b"stake", user.key().as_ref()], bump = stake_account.bump)]
    pub stake_account: Account<'info, StakeAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = pool.reward_vault)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"pool"], bump = pool.bump, has_one = mint, has_one = reward_vault)]
    pub pool: Account<'info, Pool>,
    pub user: Signer<'info>,
    // The seeds bind this PDA to `user`, so no extra owner check is needed.
    #[account(mut, seeds = [b"stake", user.key().as_ref()], bump = stake_account.bump)]
    pub stake_account: Account<'info, StakeAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [b"pool"], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub stake_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub total_staked: u64,
    /// Rewards per staked unit, scaled by ACC_SCALE.
    pub acc_reward_per_share: u128,
    /// `reward_vault` balance as of the last accrual (baseline for the next delta).
    pub last_reward_balance: u64,
    pub total_claimed: u64,
    /// Rewards that were shared out to stakers (excludes `stranded_rewards`).
    pub total_rewards: u64,
    /// Tokens sitting in `reward_vault` that nobody can ever claim: the balance present
    /// at `initialize`, plus anything that arrived while `total_staked == 0`.
    pub stranded_rewards: u64,
    pub bump: u8,
}
impl Pool {
    pub const LEN: usize = 32 * 4 + 8 + 16 + 8 + 8 + 8 + 8 + 1;
}
// The borsh layout is what `server/src/stake.ts` decodes by hand, and `LEN` is what we
// rent-exempt. Let the compiler prove the two agree with Anchor's derived size, so a
// field added above can never silently under-allocate or shift an offset.
const _: () = assert!(Pool::LEN == Pool::INIT_SPACE);

#[account]
#[derive(InitSpace)]
pub struct StakeAccount {
    pub owner: Pubkey,
    pub amount: u64,
    /// Snapshot of `amount * acc_reward_per_share` (scaled, undivided) at the last change.
    pub reward_debt: u128,
    /// Earned but not yet withdrawn.
    pub pending: u64,
    pub bump: u8,
}
impl StakeAccount {
    pub const LEN: usize = 32 + 8 + 16 + 8 + 1;
}
const _: () = assert!(StakeAccount::LEN == StakeAccount::INIT_SPACE);

#[event]
pub struct Staked {
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Claimed {
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum StakeError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("not enough staked")]
    InsufficientStake,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("a position must be at least 1 $GGRID, or zero")]
    BelowMinimumStake,
    #[msg("stake_vault and reward_vault must be different accounts")]
    VaultsMustDiffer,
    #[msg("mint must have 6 decimals")]
    UnexpectedDecimals,
    #[msg("staking is pinned to the classic SPL Token program")]
    UnsupportedTokenProgram,
}
