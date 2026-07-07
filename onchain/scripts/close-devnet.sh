#!/usr/bin/env bash
# Close the devnet program + any buffers and return the rent to the wallet.
# Needs deployer.json (recreate it with import-key.cjs). Run in the build container.
set -euo pipefail
cd /work
KP=/work/deployer.json
URL="${RPC_URL:-https://api.devnet.solana.com}"
[ -f "$KP" ] || { echo "missing deployer.json - run: node scripts/import-key.cjs"; exit 2; }

PID=$(solana address -k target/deploy/ggrid_payout-keypair.json)
ME=$(solana address -k "$KP")
echo "wallet: $ME"
echo "before: $(solana balance -k "$KP" --url "$URL")"

echo "== closing program $PID =="
solana program close "$PID" --bypass-warning --recipient "$ME" --keypair "$KP" --url "$URL" || echo "(already closed?)"
echo "== closing leftover buffers =="
solana program close --buffers --recipient "$ME" --keypair "$KP" --url "$URL" || echo "(none)"

echo "after: $(solana balance -k "$KP" --url "$URL")"
