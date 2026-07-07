#!/usr/bin/env bash
# ============================================================================
#  $GGRID - one-command mainnet launch.
#
#  Runs the whole on-chain half of the launch in one go:
#    preflight → deploy the ggrid_payout program → initialize the 75/12.5/7.5/5
#    splitter → print the exact gateway env block to paste into the deploy platform.
#
#  What it does NOT do (these are YOUR actions - money / live token):
#    - create the $GGRID coin on pump.fun (you do that; give me the CA/mint)
#    - fund the deploy wallet with real SOL (~3-4 SOL)
#
#  Usage (from onchain/):
#    KEYPAIR=/path/to/mainnet-wallet.json \
#    GGRID_MINT=<pump.fun CA> \
#    RPC_URL=https://your-keyed-mainnet-rpc \
#    bash scripts/launch-mainnet.sh
#
#  Optional:
#    TOKEN_PROGRAM=token        # pump.fun = classic SPL (default here)
#    FRESH_PROGRAM=1            # mint a brand-new mainnet program id
#    REUSE_SO=1                 # skip `anchor build`, reuse target/deploy/*.so
#    CU_PRICE=50000            # priority fee (micro-lamports) for the deploy
# ============================================================================
set -euo pipefail

TOKEN_PROGRAM="${TOKEN_PROGRAM:-token}"
CU_PRICE="${CU_PRICE:-50000}"
here="$(cd "$(dirname "$0")/.." && pwd)"     # onchain/
cd "$here"

say()  { printf "\033[36m[launch]\033[0m %s\n" "$1"; }
die()  { printf "\033[31m[launch] %s\033[0m\n" "$1" >&2; exit 1; }

# ---- 0. preflight -----------------------------------------------------------
: "${KEYPAIR:?set KEYPAIR=/path/to/funded/mainnet-wallet.json}"
: "${GGRID_MINT:?set GGRID_MINT=<your pump.fun CA / mint address>}"
: "${RPC_URL:?set RPC_URL=<a keyed mainnet RPC (Helius/QuickNode); public is rate-limited>}"
[ -f "$KEYPAIR" ] || die "keypair file not found: $KEYPAIR"
command -v solana >/dev/null || die "solana CLI not found (install the Solana toolchain)"

PAYER="$(solana address -k "$KEYPAIR")"
BAL="$(solana balance -k "$KEYPAIR" --url "$RPC_URL" | awk '{print $1}')"
say "deploy wallet : $PAYER"
say "balance       : ${BAL} SOL"
say "mint (CA)     : $GGRID_MINT"
say "token program : $TOKEN_PROGRAM"
awk "BEGIN{ exit !($BAL < 3) }" && die "balance looks low (<3 SOL) - fund the wallet first (~3-4 SOL)."

read -rp $'\nProceed with MAINNET deploy using REAL SOL? [y/N] ' ok
[ "$ok" = "y" ] || die "aborted."

# ---- 1. (optional) fresh program id + build --------------------------------
if [ "${FRESH_PROGRAM:-0}" = "1" ]; then
  say "generating a fresh mainnet program keypair"
  solana-keygen new --no-bip39-passphrase -f -o target/deploy/ggrid_payout-keypair.json
  anchor keys sync
fi

if [ "${REUSE_SO:-0}" = "1" ] && [ -f target/deploy/ggrid_payout.so ]; then
  say "reusing existing target/deploy/ggrid_payout.so"
else
  say "building program (reproducible via committed Cargo.lock)"
  anchor build
fi

PROGRAM_ID="$(solana address -k target/deploy/ggrid_payout-keypair.json)"
say "program id    : $PROGRAM_ID"

# ---- 2. deploy --------------------------------------------------------------
say "deploying to mainnet (this spends ~2.5 SOL rent, reclaimable)…"
solana program deploy target/deploy/ggrid_payout.so \
  --program-id target/deploy/ggrid_payout-keypair.json \
  --keypair "$KEYPAIR" \
  --url "$RPC_URL" \
  --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 1000

# ---- 3. initialize the splitter --------------------------------------------
say "initializing splitter (75 / 12.5 / 7.5 / 5)…"
( cd scripts && npm i --silent >/dev/null 2>&1 || true
  AUTHORITY_KEYPAIR="$KEYPAIR" PROGRAM_ID="$PROGRAM_ID" GGRID_MINT="$GGRID_MINT" \
  RPC_URL="$RPC_URL" TOKEN_PROGRAM="$TOKEN_PROGRAM" npm run --silent initialize )

# ---- 4. hand off the gateway env -------------------------------------------
cat <<EOF

\033[32m========================  ON-CHAIN LAUNCH DONE  ========================\033[0m
Set these in the gateway (.env for the non-secret ones, the deploy platform Secrets for the key):

  SOLANA_RPC_URL      = $RPC_URL
  GGRID_PROGRAM_ID    = $PROGRAM_ID
  GGRID_MINT          = $GGRID_MINT
  GGRID_TOKEN_PROGRAM = $TOKEN_PROGRAM
  GGRID_RAW_PER_CREDIT= <set from the token price - 1 credit = \$0.000001>
  GGRID_AUTHORITY_KEY = <contents of $KEYPAIR>   ← the deploy platform Secret, NEVER in the repo

Then redeploy the gateway (push to main). Payouts flip ON automatically once all
four core values (RPC, program, mint, authority key) are present.
========================================================================
EOF
