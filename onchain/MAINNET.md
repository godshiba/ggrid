# $GGRID — mainnet launch runbook

Everything here is **proven on devnet** (8/8: initialize → deposit → settle 75/12.5/7.5/5 → shutdown).
Mainnet is the same steps with a mainnet RPC, a mainnet wallet, and **real SOL**.

> I (the assistant) write the code/scripts and can run the deploy if you hand me a keypair
> *file* (stays on your disk). I do **not** create the live token, move funds, or run a
> pump.fun launch for you — those are your actions.

---

## Step 0 — token route: **pump.fun (chosen 2026-06-24)**

You launch $GGRID on **pump.fun** and give the assistant the **CA (mint address)**. That's a
**classic SPL** token, so:
- `GGRID_TOKEN_PROGRAM=token`
- in `scripts/initialize.ts` / `settle.ts` / `tests/run.cjs`: `TP = TOKEN_PROGRAM_ID`
  (the scripts already read `TOKEN_PROGRAM=token` to switch).

You do **not** run `create-token.ts` (that's the Token-2022 alternative, unused on this route).
The payout program is token-program-agnostic, so nothing in the contract changes.

> Heads-up: the **CA alone is not enough for mainnet**. Deploying the program + `initialize`
> needs a **mainnet wallet funded with ~3–4 REAL SOL** (devnet SOL does not work on mainnet)
> and its keypair to sign. Plan for that wallet separately from the pump.fun coin.

---

## Step 1 — deploy the program to mainnet (~2.5 SOL rent, reclaimable)

```bash
cd onchain
# build is reproducible thanks to the committed Cargo.lock
anchor build                      # produces target/deploy/ggrid_payout.so
# OR reuse the already-built .so

solana program deploy target/deploy/ggrid_payout.so \
  --program-id target/deploy/ggrid_payout-keypair.json \
  --keypair <YOUR_MAINNET_KEYPAIR> \
  --url https://api.mainnet-beta.solana.com \
  --with-compute-unit-price 50000 --max-sign-attempts 1000
```
Use a real RPC (public mainnet is rate-limited for deploys — a paid/keyed RPC like Helius/
QuickNode lands the program reliably). Note the printed **program id**.

> Consider generating a *fresh* program keypair for mainnet (`solana-keygen new -o
> target/deploy/ggrid_payout-keypair.json`) and re-running `anchor keys sync` + `anchor build`
> so the mainnet program id is distinct from the devnet one.

## Step 2 — create the token

- **Route A:** launch $GGRID on pump.fun. Copy the resulting **mint address**. (Classic SPL.)
- **Route B:** `cd scripts && npm i && RPC_URL=<mainnet> KEYPAIR=<your key> npm run create-token`
  → prints the Token-2022 **mint address**.

## Step 3 — initialize the splitter

```bash
cd onchain/scripts
AUTHORITY_KEYPAIR=<your key> PROGRAM_ID=<from step 1> GGRID_MINT=<from step 2> \
TOKEN_PROGRAM=<token|token2022> npm run initialize
```
Creates the vault + treasury/stakers accounts and locks in the 7500/1250/750/500 split.

## Step 4 — turn on payouts in the gateway

Set in the server env (config in `.env`, the **keypair in the deploy platform Secrets**):
```
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com   (or your keyed RPC)
GGRID_PROGRAM_ID=<step 1>
GGRID_MINT=<step 2>
GGRID_TOKEN_PROGRAM=<token|token2022>
GGRID_RAW_PER_CREDIT=<set from token price>
GGRID_AUTHORITY_KEY=<the program authority keypair>   ← the deploy platform Secret, never in repo
```
The gateway then pays providers in real $GGRID via `settle` (it's already wired:
`server/src/payouts.ts`, `POST /api/provider/payout`).

## Smoke test on mainnet (optional, tiny amounts)
`tests/run.cjs` works against any cluster — point `ANCHOR_PROVIDER_URL` at mainnet and it
runs the same initialize→deposit→settle→shutdown with a throwaway test mint. Costs a little
real SOL; safe because it shuts itself down and cleans up.

## Safety
- Use a **dedicated deploy wallet**, funded with just what's needed (~3–4 SOL).
- Keep the authority keypair only in the deploy platform Secrets.
- Don't market "trustless" until the authority is a multisig (`set_authority`).
- Reclaim rent anytime by closing the program (see `scripts/close-devnet.sh`, swap the RPC).
