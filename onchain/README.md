# GpuGrid on-chain layer — $GGRID

This is **Phase 5**: the Solana side of GpuGrid. It contains two independent pieces:

1. **`ggrid_payout`** — an Anchor (Rust) program that takes a billed amount and splits it
   **75% provider · 20% stakers · 5% treasury**, atomically, on-chain.
2. **`scripts/create-token.ts`** — creates the **$GGRID Token-2022 mint** (metadata + optional
   transfer fee), for the self-issued launch route.

Today the gateway meters usage in an off-chain SQLite ledger (rows: `PROVIDER_REWARD`,
`BURN`, `STAKERS`, `TREASURY`). This layer is the on-chain destination for those rows —
the program does the split so the backend just passes the **gross** amount.

---

## ⚠️ Read this before you launch: pump.fun vs Token-2022

These two things you asked for **partly conflict**, so here is the plain truth:

- **pump.fun mints a *standard* SPL token and keeps the mint authority** (the bonding
  curve owns it). You **cannot** add Token-2022 extensions (transfer fee, on-chain
  metadata, etc.) to a coin launched *through* pump.fun. So "pump.fun + Token-2022" is
  not a single thing you can do.

You therefore pick **one launch route**:

| | **A — pump.fun fair launch** | **B — self-issued Token-2022** |
|---|---|---|
| Token standard | classic SPL | Token-2022 |
| Mint authority | pump.fun (you don't control) | you |
| Extensions (fee/metadata) | ❌ no | ✅ yes |
| Liquidity | automatic bonding curve | you seed it (Raydium/Orca) |
| Vibe | meme / fair-launch | controlled / "real product" |
| Use this script? | no (launch on pump.fun) | yes (`create-token.ts`) |

**Good news: the `ggrid_payout` program works with either.** It's written against
anchor-spl's `token_interface`, so the same deployed program handles a classic SPL mint
*and* a Token-2022 mint. You don't have to choose before deploying the program — only
before you create the coin. In the settle/create scripts, switch `TOKEN_2022_PROGRAM_ID`
↔ `TOKEN_PROGRAM_ID` to match whichever mint you end up with.

My recommendation: **launch on pump.fun (A)** for distribution/attention, OR go
**Token-2022 (B)** if you want the on-chain transfer-fee mechanic. Don't try to fake both.

---

## What I can and can't do

I wrote all the code here. **You** run the parts that move money or create the live token:
deploying to mainnet, creating the pump.fun coin, minting Token-2022, seeding liquidity,
holding the authority key. I can't (and won't) do those for you.

---

## The payout program

`programs/ggrid_payout/src/lib.rs`

Accounts/PDAs:
- **`config`** PDA (`["config"]`) — authority (the gateway hot wallet), the mint, the
  vault/treasury/stakers token accounts, the fee bps, and lifetime totals.
- **`vault`** — an associated token account owned by the `config` PDA; holds user deposits.
- **`user`** PDA (`["user", wallet]`) — tracks how much each wallet has deposited, so
  deposits vs. payouts are publicly auditable.

Instructions:
- `initialize(provider_bps, burn_bps, stakers_bps, treasury_bps)` — bps must sum to 10000.
- `deposit(amount)` — user moves $GGRID into the vault (this is "buy credits with our token").
- `settle(amount)` — **authority only**. Splits the gross `amount` from the vault:
  provider/stakers/treasury get `transfer_checked`, the burn cut is `burn`ed. Treasury
  takes the rounding remainder so the parts always sum to `amount`. Emits a `Settled` event.
- `refund(amount)` — authority returns unspent deposit to a user.
- `set_authority`, `set_fees` — admin (e.g. point authority at a multisig later).

### Trust model (honest)
The `authority` is trusted to settle correct amounts — exactly the same trust you place in
the off-chain ledger today. What the chain adds: deposits, payouts, burns, and the split
ratio are **public and tamper-evident**, and the fee math can't be fudged. Path to less
trust later: move `authority` to a multisig/governance, or publish signed usage receipts
users can verify. Don't claim "trustless" until that's done.

---

## Deploy & wire-up

```bash
# 0. prerequisites: solana-cli, anchor 0.30.1, node
cd onchain

# 1. build (this prints the real program id)
anchor build
anchor keys list                 # copy the ggrid_payout id...
# ...paste it into declare_id! in lib.rs AND into Anchor.toml, then rebuild
anchor build

# 2. test on a local validator
anchor test                      # asserts the 75/0/20/5 split

# 3. deploy (devnet first, then mainnet-beta)
anchor deploy --provider.cluster devnet

# 4. create the token (only for Token-2022 route B)
cd scripts && npm i
RPC_URL=https://api.devnet.solana.com KEYPAIR=~/.config/solana/id.json npm run create-token

# 5. initialize the program (creates vault + treasury/stakers, calls initialize 7500/0/2000/500)
AUTHORITY_KEYPAIR=~/.config/solana/id.json PROGRAM_ID=<id> GGRID_MINT=<mint> npm run initialize
#    -> prints the exact GGRID_* env values to paste into the gateway

# 6. turn on payouts in the gateway: set SOLANA_RPC_URL / GGRID_PROGRAM_ID / GGRID_MINT /
#    GGRID_TOKEN_PROGRAM in .env, and GGRID_AUTHORITY_KEY in Forgejo Secrets. Done.
```

The split (7500/0/2000/500 bps) matches `server/src/pricing.ts::feeSplit` exactly, so the
on-chain and off-chain numbers reconcile.

---

## The staking program

`programs/ggrid_stake/src/lib.rs` — stake $GGRID, earn the 20% stakers cut of every job.

**How it hooks into payouts without touching the deployed splitter.** `ggrid_payout::settle`
transfers the stakers cut into whatever token account sits in `config.stakers`, and it has no
instruction to change that account. So we don't change it: we re-assign the *owner* of the
existing stakers account to the stake pool PDA. The fee stream then lands in `reward_vault`
and the payout program is none the wiser.

Accounts/PDAs:
- **`pool`** PDA (`["pool"]`) — mint, both vaults, `acc_reward_per_share`, and lifetime totals.
- **`stake_vault`** PDA (`["stake_vault"]`) — staked principal. Separate from rewards on
  purpose: same mint, so a shared account would make every deposit look like a reward.
- **`reward_vault`** — the re-owned stakers account. Must already be owned by `pool`.
- **`stake`** PDA (`["stake", wallet]`) — one staker's position.

Instructions: `initialize`, `stake(amount)`, `unstake(amount)`, `claim()`, `set_authority`.
Unstaking is instant (no lock-up) and rewards earned before an exit stay claimable.

**Rules that exist for a reason** (see the header comment in `lib.rs`):
- A position is `0` or `>= 1 $GGRID` (`MIN_STAKE`). This is not a UX knob — it bounds
  `acc_reward_per_share`, keeping `amount * acc` inside `u128`. Without it, a lone 1-raw-unit
  staker inflates the accumulator until a whale's `unstake` overflows and their principal is
  stuck forever.
- Rewards that land while `total_staked == 0` are banked into `stranded_rewards` and can never
  be claimed. The alternative — deferring them to the next accrual — hands the entire backlog
  to whoever stakes first, at *any* size, because the divisor is `total_staked`. The runbook
  below avoids the loss instead of the program pretending it can be shared out fairly.
- `initialize` pins the pool to the **classic SPL Token program**. $GGRID is a classic SPL
  mint, and a fee-bearing Token-2022 mint would skim principal in transit — `stake_vault`
  would receive less than the credited `amount`, stranding the last unstakers' funds. The
  reward path is immune (it measures the real balance delta); the pin closes the principal path.

### Wiring it up (the order matters)

Fees keep flowing the whole time, and anything that lands before the first staker exists is
stranded. So do it in **one atomic transaction**:

```
1. SPL SetAuthority: stakers token account  ->  owner = pool PDA
2. ggrid_stake::initialize                       (reward_vault = that account)
3. ggrid_stake::stake(seed)                      (seed >= MIN_STAKE)
```

Before that, sweep the stakers account with `spl-token transfer` while the authority still
owns it — whatever balance is present at `initialize` is counted as stranded and is gone.
After step 1 the authority can no longer move those tokens, which is the point.

Then set `GGRID_STAKE_PROGRAM_ID` in the gateway env. Unset, `/api/stake/*` reports
`available:false` and the console hides the panel, so shipping the gateway first is safe.

### Verification status

| Check | Status |
| --- | --- |
| `cargo check` (dev, release w/ `overflow-checks`, `idl-build`) | ✅ clean |
| `Pool::LEN == Pool::INIT_SPACE` (compile-time layout assert) | ✅ |
| Accrual math + solvency invariants, 20k-op fuzz | ✅ `bun scripts/verify-stake-math.ts` |
| Gateway encoding: discriminators, borsh offsets, account order | ✅ `bun server/test/e2e.ts` |
| `anchor test` against a local validator (15 tests) | ✅ 2026-07-10, Docker `backpackapp/build:v0.30.1` |
| Adversarial audit (fund-safety, Anchor constraints, client parity) | ✅ 3 independent passes — one deployment-gated finding, now fixed |
| External (paid, third-party) audit | ❌ not done |

**Program id (synced 2026-07-10):** `DNScf1sutG7Aaq9KNjTejgJPyntTCXH1ntvY3K3LDekt`
(`declare_id!` + all three `Anchor.toml` clusters). The keypair that owns it lives at
`target/deploy/ggrid_stake-keypair.json` — gitignored; back it up, it controls upgrades.

The on-chain tests ran on a real `solana-test-validator` inside the pinned Anchor image
(the local box has no Solana toolchain, and `anchor build`'s IDL step needs a nightly
`Span::source_file` — build the IDL with `RUSTUP_TOOLCHAIN=nightly RUSTFLAGS="--cfg
procmacro2_semver_exempt" anchor idl build`). `tests/ggrid_stake.ts` hand-builds its
instructions with the same account order and discriminators as `server/src/stake.ts`, so
it fails if the gateway and the program ever disagree — which an IDL-driven test would
silently paper over. The IDL's discriminators and field order were diffed against the
gateway decoder and match exactly.

Before mainnet, still do a paid third-party audit — it holds user funds with no lock-up.

### Backend wiring (already done)
The gateway is already integrated — no code left to write, just config:
- `server/src/solana.ts` — lazy on-chain client (deps load only when payouts are on).
- `server/src/payouts.ts` — reserve → `settle` → confirm/refund, recorded in the `payouts` table.
- Endpoints: `POST /api/provider/wallet` (set Solana wallet), `POST /api/provider/payout`
  (withdraw accrued balance as real $GGRID), `GET /api/provider/payouts` (history).
- With the Solana env unset, payouts return `503` and everything else runs unchanged — so
  the gateway is safe to deploy before the token exists, and turns on the moment you set the env.

---

## Recovery / teardown — get all your SOL back

Almost everything you spend is **rent** (a deposit, not a fee), so it's reclaimable. Two steps:

```bash
cd scripts && npm i

# 1. reclaim the program's account rent: empties the vault back to you,
#    closes the vault token account + config PDA, closes treasury/stakers you own.
AUTHORITY_KEYPAIR=~/.config/solana/id.json PROGRAM_ID=<id> GGRID_MINT=<mint> \
RECIPIENT_WALLET=<your pubkey> npm run recover

# 2. close the program itself (the big ~1.5-2 SOL) + leftover buffers, then
#    optionally sweep every last lamport to RECIPIENT (SWEEP=1).
PROGRAM_ID=<id> RECIPIENT=<your pubkey> SWEEP=1 \
AUTHORITY_KEYPAIR=~/.config/solana/id.json bash recover.sh
```

What comes back vs. what doesn't:
- ✅ **Program rent** (~1.5–2 SOL) — fully returned by `solana program close`.
- ✅ **config PDA + vault + treasury/stakers token-account rent** — returned by `shutdown`/close.
- ✅ **Leftover $GGRID in the vault** — swept to your recipient token account.
- ❌ **Transaction fees** (~0.000005 SOL each) — spent, not recoverable (negligible).
- ⚠️ **Token mint account rent** — stays as long as the token exists; only reclaimable if you ever close the mint (you usually don't — the coin is the product).

> Closing the program is irreversible — the on-chain logic is gone until you redeploy. Only do this when tearing down a devnet test or migrating to a new program id.

## Files
- `programs/ggrid_payout/src/lib.rs` — the splitter program
- `scripts/create-token.ts` — Token-2022 mint + metadata (route B)
- `scripts/settle.ts` — how the backend calls `settle`
- `tests/ggrid_payout.ts` — end-to-end split assertion
- `Anchor.toml`, `Cargo.toml` — build config
