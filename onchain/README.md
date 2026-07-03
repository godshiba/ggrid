# GpuGrid on-chain layer — $GGRID

This is **Phase 5**: the Solana side of GpuGrid. It contains two independent pieces:

1. **`ggrid_payout`** — an Anchor (Rust) program that takes a billed amount and splits it
   **75% provider · 12.5% burn · 7.5% stakers · 5% treasury**, atomically, on-chain.
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
anchor test                      # asserts the 75/12.5/7.5/5 split

# 3. deploy (devnet first, then mainnet-beta)
anchor deploy --provider.cluster devnet

# 4. create the token (only for Token-2022 route B)
cd scripts && npm i
RPC_URL=https://api.devnet.solana.com KEYPAIR=~/.config/solana/id.json npm run create-token

# 5. initialize the program (creates vault + treasury/stakers, calls initialize 7500/1250/750/500)
AUTHORITY_KEYPAIR=~/.config/solana/id.json PROGRAM_ID=<id> GGRID_MINT=<mint> npm run initialize
#    -> prints the exact GGRID_* env values to paste into the gateway

# 6. turn on payouts in the gateway: set SOLANA_RPC_URL / GGRID_PROGRAM_ID / GGRID_MINT /
#    GGRID_TOKEN_PROGRAM in .env, and GGRID_AUTHORITY_KEY in the deploy platform Secrets. Done.
```

The split (7500/1250/750/500 bps) matches `server/src/pricing.ts::feeSplit` exactly, so the
on-chain and off-chain numbers reconcile.

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
