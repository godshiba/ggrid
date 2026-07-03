#!/usr/bin/env bash
# Teardown — return ALL SOL from the GpuGrid on-chain deployment back to your wallet.
#
# Order matters:
#   1. recover.ts  -> closes the program's accounts (config PDA + vault + treasury/stakers)
#   2. this script -> closes the PROGRAM itself (the big ~1.5-2 SOL rent) + leftover buffers
#   3. optional    -> sweeps every last lamport from the deploy wallet to RECIPIENT
#
# Usage:
#   PROGRAM_ID=<program id> RECIPIENT=<wallet pubkey to receive SOL> \
#   AUTHORITY_KEYPAIR=~/.config/solana/id.json bash recover.sh
#
# Use RPC_URL to pick the network (defaults to devnet — change for mainnet).
set -euo pipefail

RPC="${RPC_URL:-https://api.devnet.solana.com}"
KEYPAIR="${AUTHORITY_KEYPAIR:-$HOME/.config/solana/id.json}"
: "${PROGRAM_ID:?set PROGRAM_ID}"
RECIPIENT="${RECIPIENT:-$(solana address -k "$KEYPAIR")}"

echo "network : $RPC"
echo "wallet  : $(solana address -k "$KEYPAIR")"
echo "recipient: $RECIPIENT"
echo "balance before: $(solana balance -k "$KEYPAIR" --url "$RPC")"

# 1. close the program account -> reclaims the program's rent (the big chunk)
echo ">> closing program $PROGRAM_ID ..."
solana program close "$PROGRAM_ID" \
  --recipient "$RECIPIENT" \
  --keypair "$KEYPAIR" \
  --url "$RPC"

# 2. close any leftover buffer accounts from failed/partial deploys
echo ">> closing leftover buffers (if any) ..."
solana program close --buffers \
  --recipient "$RECIPIENT" \
  --keypair "$KEYPAIR" \
  --url "$RPC" || echo "   (no buffers to close)"

# 3. OPTIONAL: sweep every remaining lamport from the deploy wallet to RECIPIENT.
#    Skip this if RECIPIENT is the deploy wallet itself.
if [ "${SWEEP:-0}" = "1" ] && [ "$RECIPIENT" != "$(solana address -k "$KEYPAIR")" ]; then
  echo ">> sweeping remaining SOL to $RECIPIENT ..."
  solana transfer "$RECIPIENT" ALL \
    --keypair "$KEYPAIR" \
    --url "$RPC" \
    --allow-unfunded-recipient \
    --fee-payer "$KEYPAIR"
fi

echo "balance after: $(solana balance -k "$KEYPAIR" --url "$RPC")"
echo "recipient balance: $(solana balance "$RECIPIENT" --url "$RPC")"
echo "done — everything reclaimable has been returned."
