// Central runtime config. All knobs come from env so the deploy platform
// (docker-db) can inject them; sensible defaults for local dev.

function num(v: string | undefined, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function clamp01(v: string | undefined, d: number): number {
  const n = Number(v ?? d)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d
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

  // Free credits granted at signup. Default 0 — the free tier is now a REQUEST
  // COUNTER (signupFreeRequests) billed to the sandbox fund, not a cash bonus.
  // Set SIGNUP_BONUS=5000000 to roll back to the old $5-credit behaviour.
  signupBonus: num(process.env.SIGNUP_BONUS, 0),

  // Free requests granted at signup (billed to the sandbox fund, like the
  // playground). Enough to wire a real API integration before topping up.
  signupFreeRequests: num(process.env.SIGNUP_FREE_REQUESTS, 20),

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

  // Privy App ID — the console's login/identity provider. Public value (also lives
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
  // so the funding flow can be tested locally. Default false — never set in prod.
  devMockTopup: process.env.DEV_MOCK_TOPUP === '1',

  // DEV ONLY: serve a canned, initialized staking pool + position so the console
  // Staking panel can be viewed locally without a deployed program. Default false —
  // never set in prod (real on-chain reads take over the moment the program is live).
  devMockStake: process.env.DEV_MOCK_STAKE === '1',

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
    // $GGRID mint decimals — needed to build the deposit `transfer_checked`.
    decimals: num(process.env.GGRID_MINT_DECIMALS, 6),
    // Don't credit a top-up worth fewer than this many credits (dust guard).
    minDepositCredits: num(process.env.GGRID_MIN_DEPOSIT_CREDITS, 0),
    // Supply minted at launch. The mint authority is renounced, so live supply can
    // only fall; `initial - live` is the amount burned to date (the fee split no
    // longer burns, so this figure is now effectively fixed at the historical total).
    initialSupply: num(process.env.GGRID_INITIAL_SUPPLY, 1_000_000_000),
  },

  // --- $GGRID staking (optional; fully disabled if unset) ---
  // Stakers earn the 20% cut that ggrid_payout::settle takes out of every job. The
  // payout program pays that cut into a token account owned by the stake pool PDA,
  // so the two programs need no direct coupling. stake/unstake/claim are signed by
  // the USER, so the gateway never needs the authority key here - it only reads the
  // pool and builds unsigned transactions for the wallet to sign.
  stake: {
    programId: process.env.GGRID_STAKE_PROGRAM_ID ?? '',
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

  // --- Privacy: prompt/response content is NEVER persisted or logged ---
  // The gateway proxies request bodies in memory only; nothing about the content
  // of a prompt or a completion is written to the database or the logs. The only
  // per-job record kept is metadata (model, token counts, cost, latency, status).
  // `retentionDays` optionally purges even that usage history after N days; the
  // financial ledger (charges/payouts) is always kept as the money trail.
  privacy: {
    storePrompts: false as const, // hard guarantee — no code path persists prompt/answer text
    retentionDays: num(process.env.JOB_RETENTION_DAYS, 0), // 0 = keep usage history until account deletion
    sweepMs: num(process.env.RETENTION_SWEEP_MS, 6 * 60 * 60_000), // how often the purge runs
  },

  // --- Integrity: catch a node that returns junk or fakes the model it serves ---
  // Two independent, best-effort audits. Both are OFF by default (additive — the
  // live network is unaffected until enabled) and NEVER block or bill a user job,
  // and NEVER persist prompt/answer content.
  integrity: {
    // Spot-check: replay a small fraction of finished chat jobs on a SECOND node
    // and have a judge model decide if the two answers agree in meaning. A node
    // whose answer diverges is penalized (→ quarantined if it keeps failing).
    spotcheckRate: clamp01(process.env.SPOTCHECK_RATE, 0), // 0..1, e.g. 0.03 = 3% of jobs
    spotcheckJudgeModel: process.env.SPOTCHECK_JUDGE_MODEL ?? '', // '' → judge with the same model
    spotcheckMinTokensOut: num(process.env.SPOTCHECK_MIN_TOKENS_OUT, 12), // skip trivial replies
    spotcheckMaxTokens: num(process.env.SPOTCHECK_MAX_TOKENS, 512), // cap the shadow replay
    // Canary: periodically ask each node a prompt with a KNOWN answer for the model
    // it claims. A node serving a smaller model than advertised fails the hard ones.
    canaryEnabled: process.env.CANARY_ENABLED === '1',
    canaryIntervalMs: num(process.env.CANARY_INTERVAL_MS, 10 * 60_000),
    canaryMaxTokens: num(process.env.CANARY_MAX_TOKENS, 64),
    canaryFailThreshold: num(process.env.CANARY_FAIL_THRESHOLD, 2), // fails per round before penalize
    probeTimeoutMs: num(process.env.INTEGRITY_PROBE_TIMEOUT_MS, 60_000), // per shadow/probe request
  },

  // --- Playground + sandbox fund: anonymous try-before-signup inference ---
  // The landing-page playground lets anyone run a small prompt on a real grid
  // node with NO account. Every free request (anonymous playground AND the
  // post-signup free-request counter) is billed to an internal sandbox user
  // through the ordinary job pipeline — the provider still earns their 75%,
  // the fee split runs untouched. The fund is a hard ceiling: when the sandbox
  // balance (or the daily cap) is spent, the free tier pauses by itself.
  playground: {
    enabled: process.env.PLAYGROUND_ENABLED !== '0', // kill switch (no deploy needed)
    model: process.env.PLAYGROUND_MODEL ?? 'llama3:8b', // the ONE model the playground serves
    maxTokens: num(process.env.PLAYGROUND_MAX_TOKENS, 400), // output cap per free request
    maxPromptChars: num(process.env.PLAYGROUND_MAX_PROMPT_CHARS, 2_000), // bounds tokens_in
    perIpPerDay: num(process.env.PLAYGROUND_PER_IP_PER_DAY, 5), // anonymous quota (real IP — Caddy rewrites XFF)
    // Sandbox fund: created once with this balance (credits, micro-USD). $10 ≈ 100k requests.
    sandboxInitialCredits: num(process.env.SANDBOX_INITIAL_CREDITS, 10_000_000),
    // Daily spend ceiling across ALL free traffic — the fund can't burn down overnight.
    // $1/day → a $10 fund lasts ~10+ days even under a flood; raise once traction proves out.
    sandboxDailyCapCredits: num(process.env.SANDBOX_DAILY_CAP_CREDITS, 1_000_000), // $1/day
    // Browsers must call from these hosts (curl/no-Origin is allowed; the IP cap
    // still applies) — other sites can't embed our free inference as their API.
    allowedOrigins: (process.env.PLAYGROUND_ORIGINS ?? 'gpugrid.app,www.gpugrid.app,localhost,127.0.0.1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

  // --- DoS hardening: protect the public, unauthenticated endpoints ---
  // The public reads that hit the Solana RPC (/api/token, /api/stake/*, /api/wallet/*)
  // are the main abuse surface: no key needed, and each call can fan out to the RPC.
  // These knobs bound that: per-IP rate, short result cache, a hard RPC timeout, and a
  // global in-flight cap so a flood returns 503 fast instead of piling up into timeouts.
  security: {
    publicRpcRatePerMin: num(process.env.PUBLIC_RPC_RATE_PER_MIN, 60), // per-IP on RPC-backed public reads
    rpcCacheTtlMs: num(process.env.RPC_CACHE_TTL_MS, 15_000), // cache token/pool/wallet/position reads
    rpcTimeoutMs: num(process.env.RPC_TIMEOUT_MS, 8_000), // hard timeout on any single outbound RPC call
    maxInflightRpc: num(process.env.MAX_INFLIGHT_RPC, 24), // global cap; excess public RPC reads → 503 fast
    providerCreatePerIpPerDay: num(process.env.PROVIDER_CREATE_PER_IP_PER_DAY, 10), // anti-bloat on /api/providers
    maxNodesPerProvider: num(process.env.MAX_NODES_PER_PROVIDER, 50), // cap junk-node registration per provider
    maxBodyBytes: num(process.env.MAX_BODY_BYTES, 64 * 1024), // reject oversized JSON bodies (memory guard)
    rateLimitMaxTracked: num(process.env.RATE_LIMIT_MAX_TRACKED, 100_000), // bound limiter memory vs IP spoofing
    nodesCacheTtlMs: num(process.env.NODES_CACHE_TTL_MS, 10_000), // cache the public /api/nodes catalogue (0 = off)
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
