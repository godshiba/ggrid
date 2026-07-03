use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    burn, close_account, transfer_checked, Burn, CloseAccount, Mint, TokenAccount,
    TokenInterface, TransferChecked,
};

// Replace with the address printed by `anchor keys list` after the first build.
declare_id!("GXYY8m1oddHVaUKjQoZkDL3QYrv3c16sethk2BpKktfN");

const BPS_DENOM: u64 = 10_000;

/// GpuGrid payout splitter.
///
/// Trust model (be honest about this):
///   - The gateway backend is the `authority`. It meters usage OFF-chain (the SQLite
///     ledger) exactly as it does today, then calls `settle` to release funds.
///   - Users `deposit` $GGRID into a program-owned vault. Their deposited total is
///     tracked on-chain in a `UserAccount` PDA so anyone can audit deposits vs. payouts.
///   - `settle` applies the fee split atomically: provider / stakers / treasury get
///     a transfer, the burn cut is burned from the vault. The parts always sum to
///     `amount` (treasury takes the rounding remainder), so the vault never leaks.
///
/// This program is token-program-agnostic: it uses `token_interface`, so the same
/// bytecode works whether $GGRID is a classic SPL token (pump.fun route) or a
/// Token-2022 mint (self-issued route).
#[program]
pub mod ggrid_payout {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        provider_bps: u16,
        burn_bps: u16,
        stakers_bps: u16,
        treasury_bps: u16,
    ) -> Result<()> {
        require!(
            provider_bps as u64 + burn_bps as u64 + stakers_bps as u64 + treasury_bps as u64
                == BPS_DENOM,
            GgridError::InvalidFeeSplit
        );
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.mint = ctx.accounts.mint.key();
        c.vault = ctx.accounts.vault.key();
        c.treasury = ctx.accounts.treasury.key();
        c.stakers = ctx.accounts.stakers.key();
        c.provider_bps = provider_bps;
        c.burn_bps = burn_bps;
        c.stakers_bps = stakers_bps;
        c.treasury_bps = treasury_bps;
        c.total_deposited = 0;
        c.total_settled = 0;
        c.total_burned = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// User funds their balance by moving $GGRID into the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, GgridError::ZeroAmount);
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let ua = &mut ctx.accounts.user_account;
        ua.owner = ctx.accounts.user.key();
        ua.deposited = ua.deposited.checked_add(amount).ok_or(GgridError::Overflow)?;
        ua.bump = ctx.bumps.user_account;

        let c = &mut ctx.accounts.config;
        c.total_deposited = c.total_deposited.checked_add(amount).ok_or(GgridError::Overflow)?;

        emit!(Deposited { user: ua.owner, amount });
        Ok(())
    }

    /// Authority-signed settlement of a single billed amount.
    /// 75% -> provider, 12.5% burned, 7.5% -> stakers, 5% -> treasury (remainder).
    pub fn settle(ctx: Context<Settle>, amount: u64) -> Result<()> {
        require!(amount > 0, GgridError::ZeroAmount);
        let c = &ctx.accounts.config;

        let provider_cut = mul_bps(amount, c.provider_bps)?;
        let burn_cut = mul_bps(amount, c.burn_bps)?;
        let stakers_cut = mul_bps(amount, c.stakers_bps)?;
        // treasury takes the remainder so the parts always sum to `amount`.
        let treasury_cut = amount
            .checked_sub(provider_cut)
            .and_then(|x| x.checked_sub(burn_cut))
            .and_then(|x| x.checked_sub(stakers_cut))
            .ok_or(GgridError::Overflow)?;

        let bump = c.bump;
        let seeds: &[&[u8]] = &[b"config", core::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;

        let token_program = ctx.accounts.token_program.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();
        let mint_ai = ctx.accounts.mint.to_account_info();
        let config_ai = ctx.accounts.config.to_account_info();

        // provider 75%
        if provider_cut > 0 {
            transfer_from_vault(
                &token_program,
                &vault,
                &mint_ai,
                &config_ai,
                ctx.accounts.provider_token.to_account_info(),
                provider_cut,
                decimals,
                signer,
            )?;
        }
        // stakers 7.5%
        if stakers_cut > 0 {
            transfer_from_vault(
                &token_program,
                &vault,
                &mint_ai,
                &config_ai,
                ctx.accounts.stakers.to_account_info(),
                stakers_cut,
                decimals,
                signer,
            )?;
        }
        // treasury 5%
        if treasury_cut > 0 {
            transfer_from_vault(
                &token_program,
                &vault,
                &mint_ai,
                &config_ai,
                ctx.accounts.treasury.to_account_info(),
                treasury_cut,
                decimals,
                signer,
            )?;
        }
        // burn 12.5%
        if burn_cut > 0 {
            burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                burn_cut,
            )?;
        }

        let c = &mut ctx.accounts.config;
        c.total_settled = c.total_settled.checked_add(amount).ok_or(GgridError::Overflow)?;
        c.total_burned = c.total_burned.checked_add(burn_cut).ok_or(GgridError::Overflow)?;

        emit!(Settled {
            provider: ctx.accounts.provider_token.key(),
            amount,
            provider_cut,
            burn_cut,
            stakers_cut,
            treasury_cut,
        });
        Ok(())
    }

    /// Authority returns unspent deposit to a user (e.g. account closed). Bounded by
    /// `amount`; the authority is responsible for not refunding already-metered credits.
    pub fn refund(ctx: Context<Refund>, amount: u64) -> Result<()> {
        require!(amount > 0, GgridError::ZeroAmount);
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", core::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;

        let ua = &mut ctx.accounts.user_account;
        ua.deposited = ua.deposited.saturating_sub(amount);
        Ok(())
    }

    /// Teardown: authority sweeps any leftover $GGRID out of the vault, closes the
    /// vault token account (rent -> authority), and closes the config PDA (rent ->
    /// authority). After this, run `solana program close` to reclaim the program rent
    /// (the big ~1.5-2 SOL chunk). Authority-only.
    pub fn shutdown(ctx: Context<Shutdown>) -> Result<()> {
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", core::slice::from_ref(&bump)];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;

        // 1. move any remaining tokens in the vault back to the recipient
        let remaining = ctx.accounts.vault.amount;
        if remaining > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.recipient_token.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                remaining,
                decimals,
            )?;
        }

        // 2. close the (now empty) vault token account; its rent goes to authority
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ))?;

        // 3. config PDA is closed by the `close = authority` constraint on exit.
        Ok(())
    }

    pub fn set_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    pub fn set_fees(
        ctx: Context<Admin>,
        provider_bps: u16,
        burn_bps: u16,
        stakers_bps: u16,
        treasury_bps: u16,
    ) -> Result<()> {
        require!(
            provider_bps as u64 + burn_bps as u64 + stakers_bps as u64 + treasury_bps as u64
                == BPS_DENOM,
            GgridError::InvalidFeeSplit
        );
        let c = &mut ctx.accounts.config;
        c.provider_bps = provider_bps;
        c.burn_bps = burn_bps;
        c.stakers_bps = stakers_bps;
        c.treasury_bps = treasury_bps;
        Ok(())
    }
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    Ok((amount as u128 * bps as u128 / BPS_DENOM as u128) as u64)
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer: &[&[&[u8]]],
) -> Result<()> {
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TransferChecked {
                from: vault.clone(),
                mint: mint.clone(),
                to,
                authority: config.clone(),
            },
            signer,
        ),
        amount,
        decimals,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub stakers: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = mint, has_one = vault)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserAccount::LEN,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
        has_one = mint,
        has_one = vault,
        has_one = treasury,
        has_one = stakers
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub provider_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.stakers)]
    pub stakers: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.treasury)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority, has_one = mint, has_one = vault)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"user", user_account.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Shutdown<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
        has_one = mint,
        has_one = vault,
        close = authority
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// receives any $GGRID still sitting in the vault
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub recipient_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub treasury: Pubkey,
    pub stakers: Pubkey,
    pub provider_bps: u16,
    pub burn_bps: u16,
    pub stakers_bps: u16,
    pub treasury_bps: u16,
    pub total_deposited: u64,
    pub total_settled: u64,
    pub total_burned: u64,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 32 * 5 + 2 * 4 + 8 * 3 + 1;
}

#[account]
pub struct UserAccount {
    pub owner: Pubkey,
    pub deposited: u64,
    pub bump: u8,
}
impl UserAccount {
    pub const LEN: usize = 32 + 8 + 1;
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Settled {
    pub provider: Pubkey,
    pub amount: u64,
    pub provider_cut: u64,
    pub burn_cut: u64,
    pub stakers_cut: u64,
    pub treasury_cut: u64,
}

#[error_code]
pub enum GgridError {
    #[msg("fee split must sum to 10000 bps")]
    InvalidFeeSplit,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    Overflow,
}
