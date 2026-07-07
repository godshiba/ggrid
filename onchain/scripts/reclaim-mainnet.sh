#!/usr/bin/env bash
# ============================================================================
#  $GGRID - one-command FULL RECLAIM.
#
#  Returns every reclaimable lamport from the on-chain deployment back to your
#  wallet, in one run:
#    1. shutdown()          - sweep the vault, close vault + config PDA (rent -> you)
#    2. close treasury/stakers token accounts (rent -> you)
#    3. solana program close - reclaim the BIG program-rent chunk (~2.5 SOL)
#    4. close leftover deploy buffers
#    5. print how much SOL came back
#
#  Only the tiny transaction fees (~0.02 SOL) are unrecoverable. Everything else
#  is rent and comes straight back.
#
#  Usage (from onchain/):
#    KEYPAIR=/path/to/mainnet-wallet.json \
#    PROGRAM_ID=<deployed program id> \
#    GGRID_MINT=<your pump.fun CA> \
#    RPC_URL=https://your-keyed-mainnet-rpc \
#    bash scripts/reclaim-mainnet.sh
#
#  Optional:
#    TOKEN_PROGRAM=token          # pump.fun = classic SPL (default here)
#    RECIPIENT=<pubkey>           # where SOL goes (default: the deploy wallet)
#    SKIP_SHUTDOWN=1              # if the program has no config/vault (deploy failed early)
# ============================================================================
set -euo pipefail

TOKEN_PROGRAM="${TOKEN_PROGRAM:-token}"
here="$(cd "$(dirname "$0")/.." && pwd)"     # onchain/
cd "$here"

say() { printf "\033[36m[reclaim]\033[0m %s\n" "$1"; }
die() { printf "\033[31m[reclaim] %s\033[0m\n" "$1" >&2; exit 1; }

: "${KEYPAIR:?set KEYPAIR=/path/to/mainnet-wallet.json}"
: "${PROGRAM_ID:?set PROGRAM_ID=<deployed program id>}"
: "${RPC_URL:?set RPC_URL=<a keyed mainnet RPC>}"
[ -f "$KEYPAIR" ] || die "keypair file not found: $KEYPAIR"
command -v solana >/dev/null || die "solana CLI not found"

WALLET="$(solana address -k "$KEYPAIR")"
RECIPIENT="${RECIPIENT:-$WALLET}"
BEFORE="$(solana balance -k "$KEYPAIR" --url "$RPC_URL" | awk '{print $1}')"
say "wallet    : $WALLET"
say "recipient : $RECIPIENT"
say "program   : $PROGRAM_ID"
say "balance before: ${BEFORE} SOL"

# ---- 1+2. close the program's owned accounts (config PDA, vault, treasury, stakers)
if [ "${SKIP_SHUTDOWN:-0}" != "1" ]; then
  : "${GGRID_MINT:?set GGRID_MINT=<your mint/CA> (or SKIP_SHUTDOWN=1 if never initialized)}"
  say "closing program accounts (shutdown + token accounts)…"
  ( cd scripts && npm i --silent >/dev/null 2>&1 || true
    AUTHORITY_KEYPAIR="$KEYPAIR" PROGRAM_ID="$PROGRAM_ID" GGRID_MINT="$GGRID_MINT" \
    RECIPIENT_WALLET="$RECIPIENT" RPC_URL="$RPC_URL" TOKEN_PROGRAM="$TOKEN_PROGRAM" \
    npm run --silent recover ) || say "shutdown step reported an issue (already torn down?) - continuing"
fi

# ---- 3. close the program itself -> reclaims the big rent chunk
say "closing the program (reclaims ~2.5 SOL program rent)…"
solana program close "$PROGRAM_ID" --bypass-warning \
  --recipient "$RECIPIENT" --keypair "$KEYPAIR" --url "$RPC_URL" || say "(program already closed?)"

# ---- 4. close any leftover buffers from partial/failed deploys
say "closing leftover deploy buffers (if any)…"
solana program close --buffers --bypass-warning \
  --recipient "$RECIPIENT" --keypair "$KEYPAIR" --url "$RPC_URL" || say "(no buffers)"

# ---- 5. report
AFTER="$(solana balance -k "$KEYPAIR" --url "$RPC_URL" | awk '{print $1}')"
say "balance after : ${AFTER} SOL"
if [ "$RECIPIENT" != "$WALLET" ]; then
  say "recipient bal : $(solana balance "$RECIPIENT" --url "$RPC_URL")"
fi
awk "BEGIN{ printf \"\033[32m[reclaim] returned ~%.4f SOL to the wallet. Only tx fees are gone.\033[0m\n\", ($AFTER-$BEFORE) }"
