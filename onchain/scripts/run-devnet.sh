#!/usr/bin/env bash
# Deploy ggrid_payout to devnet and run the integration test, signing with the
# wallet in deployer.json (created by import-key.cjs). Run inside the build container.
set -euo pipefail
cd /work
KP=/work/deployer.json
URL="${RPC_URL:-https://api.devnet.solana.com}"

[ -f "$KP" ] || { echo "missing deployer.json — run: node scripts/import-key.cjs"; exit 2; }

echo "== wallet =="
echo "address: $(solana address -k "$KP")"
echo "balance: $(solana balance -k "$KP" --url "$URL")"

echo "== deploy program to devnet =="
solana program deploy target/deploy/ggrid_payout.so \
  --program-id target/deploy/ggrid_payout-keypair.json \
  --keypair "$KP" --url "$URL"

PID=$(solana address -k target/deploy/ggrid_payout-keypair.json)
echo "program id: $PID"

echo "== integration test on devnet =="
PROGRAM_ID="$PID" ANCHOR_PROVIDER_URL="$URL" ANCHOR_WALLET="$KP" node tests/run.cjs
