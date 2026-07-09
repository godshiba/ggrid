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

  // --- Thermal-aware routing (Apple-Silicon "metal" tier) ---
  routing: {
    // A chat request that streams or asks for more than this many output tokens
    // is a "long job" → routed away from fanless (MacBook Air) nodes when a
    // cooled node is available, since Airs throttle under sustained load.
    longJobTokens: num(process.env.LONG_JOB_TOKENS, 256),
  },
}

// On-chain payouts are live only when the core Solana settings are all present.
export function solanaConfigured(): boolean {
  const s = config.solana
  return !!(s.rpcUrl && s.programId && s.mint && s.authorityKey)
}
