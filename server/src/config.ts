// Central runtime config. All knobs come from env so the deploy platform
// (docker-db) can inject them; sensible defaults for local dev.

function num(v: string | undefined, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const config = {
  // Port the gateway listens on (platform sets APP_PORT for docker).
  port: num(process.env.APP_PORT ?? process.env.PORT, 8080),

  // SQLite path. Platform docker-db injects DATABASE_URL=file:/data/app.db.
  dbPath: (process.env.DATABASE_URL ?? 'file:./data/app.db').replace(/^file:/, ''),

  // Node liveness: heartbeat must arrive within this window.
  heartbeatTtlMs: num(process.env.HEARTBEAT_TTL_MS, 30_000),

  // Max concurrent jobs routed to a single node.
  maxConcurrencyPerNode: num(process.env.MAX_CONCURRENCY, 4),

  // Nodes below this reliability are quarantined (auto-slashed) out of routing.
  minReliability: Number(process.env.MIN_RELIABILITY ?? 0.3),

  // Price multiplier applied to RunPod nodes (cloud is pricier than community).
  runpodPriceFactor: Number(process.env.RUNPOD_PRICE_FACTOR ?? 1.5),

  // New users get this many free credits (MVP). 1 credit = 1 micro-USD,
  // so 5_000_000 ≈ $5 of free trial compute.
  signupBonus: num(process.env.SIGNUP_BONUS, 5_000_000),

  // Block requests when balance drops to/below this.
  minBalance: num(process.env.MIN_BALANCE, 0),

  // Per-key requests/minute.
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 120),

  // RunPod fallback (optional; disabled if no key).
  runpodApiKey: process.env.RUNPOD_API_KEY ?? '',
  runpodGpuType: process.env.RUNPOD_GPU_TYPE ?? 'NVIDIA GeForce RTX 4090',
  runpodImage: process.env.RUNPOD_IMAGE ?? 'ollama/ollama:latest',
  runpodIdleMs: num(process.env.RUNPOD_IDLE_MS, 5 * 60_000),

  // Control-plane admin key (enables /api/admin/*). Empty = admin disabled.
  adminKey: process.env.ADMIN_KEY ?? '',

  // CORS origin for the dashboard / API. '*' for MVP.
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  // Privy App ID - the console's login/identity provider. Public value (also lives
  // in the frontend); used to verify Privy access tokens against Privy's JWKS.
  privyAppId: process.env.PRIVY_APP_ID ?? 'cmraq7xzq00i60cjv2vahcpsm',

  // Abort a node request that exceeds this (covers cold generations).
  upstreamTimeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 180_000),

  // Anti-abuse: max signups per client IP per day.
  signupPerIpPerDay: num(process.env.SIGNUP_PER_IP_PER_DAY, 3),

  // Cap output tokens per request (bounds cost + cloud-GPU time).
  maxOutputTokens: num(process.env.MAX_OUTPUT_TOKENS, 4096),

  // Whether free-tier users may trigger the (paid) RunPod fallback.
  // Default false: free signups can't drain the cloud budget.
  freeTierRunpod: process.env.FREE_TIER_RUNPOD === 'true',

  // DEV ONLY: enable a no-wallet, no-chain simulated top-up (POST /api/credits/dev-topup)
  // so the funding flow can be tested locally. Default false - never set in prod.
  devMockTopup: process.env.DEV_MOCK_TOPUP === '1',

  // Where the built web app lives (served by the same container in prod).
  webDir: process.env.WEB_DIR ?? '../web/dist',

  // --- Solana / $GGRID on-chain payouts (optional; fully disabled if unset) ---
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? '',
    programId: process.env.GGRID_PROGRAM_ID ?? '',
    mint: process.env.GGRID_MINT ?? '',
    // Authority keypair: a JSON secret-key array OR a path to a keypair file.
    // Keep this in Forgejo Secrets, never in the repo.
    authorityKey: process.env.GGRID_AUTHORITY_KEY ?? '',
    // 'token2022' (self-issued Token-2022) or 'token' (classic / pump.fun SPL).
    tokenProgram: (process.env.GGRID_TOKEN_PROGRAM ?? 'token2022') as 'token2022' | 'token',
    // Anchor IDL produced by `anchor build` (path relative to the server cwd, or absolute).
    idlPath: process.env.GGRID_IDL_PATH ?? '../onchain/target/idl/ggrid_payout.json',
    // Raw token units per 1 credit (1 credit = 1 micro-USD). Set from your token price.
    rawPerCredit: num(process.env.GGRID_RAW_PER_CREDIT, 1),
    // Provider share in bps; MUST match the on-chain config (default 7500 = 75%).
    providerBps: num(process.env.GGRID_PROVIDER_BPS, 7500),
    // Don't pay out below this many credits (avoids dust + fee waste).
    minPayoutCredits: num(process.env.GGRID_MIN_PAYOUT_CREDITS, 100_000),
    // $GGRID mint decimals - needed to build the deposit `transfer_checked`.
    decimals: num(process.env.GGRID_MINT_DECIMALS, 6),
    // Don't credit a top-up worth fewer than this many credits (dust guard).
    minDepositCredits: num(process.env.GGRID_MIN_DEPOSIT_CREDITS, 0),
  },

  // --- Node verification / Apple-Silicon ("metal") tier ---
  // Metal nodes must pass a MEASURED benchmark before serving paid traffic;
  // cuda/runpod nodes are auto-verified (unchanged behaviour). We never trust a
  // node's self-declared hardware - the benchmark floor is the real gate.
  verify: {
    // Minimum sustained tokens/sec to be accepted. M4/M5 clear this; older Macs
    // and weak boxes don't -> rejected regardless of the chip string they claim.
    minTokensPerSec: Number(process.env.VERIFY_MIN_TPS ?? 12),
    // Policy: only these Apple-Silicon chips are allowed (declared chip must
    // contain one of these substrings). "M4,M5" -> M1/M2/M3 are declined.
    allowedMacChips: (process.env.VERIFY_MAC_CHIPS ?? 'M4,M5')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Handshake bench length (quick gate) and sustained-probe length + rounds
    // (runs back-to-back to surface thermal throttling on fanless Airs).
    handshakeTokens: num(process.env.VERIFY_HANDSHAKE_TOKENS, 48),
    sustainedTokens: num(process.env.VERIFY_SUSTAINED_TOKENS, 256),
    sustainedRounds: num(process.env.VERIFY_SUSTAINED_ROUNDS, 6),
    // If the last sustained sample drops below (1 - thermalDropPct) x the first,
    // flag the node thermal_limited (auto-catches MacBook Air throttling).
    thermalDropPct: Number(process.env.VERIFY_THERMAL_DROP_PCT ?? 0.2),
    // A chat request that streams or asks for more than this many output tokens
    // is a "long job" -> routed away from fanless / thermal_limited nodes when a
    // cooled node is available.
    longJobTokens: num(process.env.LONG_JOB_TOKENS, 256),
    // Per-benchmark upstream timeout (cold generations on a fresh node are slow).
    benchTimeoutMs: num(process.env.VERIFY_BENCH_TIMEOUT_MS, 120_000),
  },

  // --- Resilient routing: failover + capacity queue ---
  routing: {
    // Failover: how many different nodes a single request may be tried on before
    // giving up. A node that dies at/before its first token fails over to the
    // next, so one node dropping does not fail the request.
    maxAttempts: num(process.env.ROUTING_MAX_ATTEMPTS, 3),
    // Queue: when every node serving the model is at capacity, wait up to this
    // long for a slot to free instead of returning 503 immediately.
    queueMaxWaitMs: num(process.env.QUEUE_MAX_WAIT_MS, 20_000),
    // Cap on how many requests may be waiting in the capacity queue at once
    // (backpressure - beyond this we 503 rather than queue unboundedly).
    queueMaxDepth: num(process.env.QUEUE_MAX_DEPTH, 100),
  },

  // --- $GGRID staking (optional; fully disabled if unset) ---
  // Stakers earn the 20% cut that ggrid_payout::settle takes out of every job. The
  // payout program pays that cut into a token account owned by the stake pool PDA, so
  // the two programs need no direct coupling. stake/unstake/claim are signed by the
  // USER, so the gateway never needs the authority key here - it only reads the pool
  // and builds unsigned transactions for the wallet to sign.
  stake: {
    programId: process.env.GGRID_STAKE_PROGRAM_ID ?? '',
  },
}

// On-chain payouts are live only when the core Solana settings are all present.
export function solanaConfigured(): boolean {
  const s = config.solana
  return !!(s.rpcUrl && s.programId && s.mint && s.authorityKey)
}

// Staking needs the RPC, the $GGRID mint and the stake program. No authority key:
// the staker signs their own stake/unstake/claim.
export function stakeConfigured(): boolean {
  return !!(config.solana.rpcUrl && config.solana.mint && config.stake.programId)
}
