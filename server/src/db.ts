import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config'

const isMemory = config.dbPath === ':memory:'
if (!isMemory) {
  try {
    mkdirSync(dirname(config.dbPath), { recursive: true })
  } catch {
    /* dir exists */
  }
}

export const db = new Database(config.dbPath, { create: true })
if (!isMemory) db.exec('PRAGMA journal_mode = WAL;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT,
  balance        INTEGER NOT NULL DEFAULT 0,
  runpod_allowed INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  hash        TEXT UNIQUE NOT NULL,
  prefix      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  token_hash    TEXT NOT NULL,
  payout_wallet TEXT,
  balance       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'LOCAL',
  models       TEXT NOT NULL DEFAULT '[]',
  gpu_info     TEXT,
  reliability  REAL NOT NULL DEFAULT 1.0,
  price_factor REAL NOT NULL DEFAULT 1.0,
  perf         REAL NOT NULL DEFAULT 0,
  jobs_done    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  node_id     TEXT,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL,
  source      TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  user_id     TEXT,
  provider_id TEXT,
  job_id      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  net_credits   INTEGER NOT NULL,
  gross_credits INTEGER NOT NULL,
  raw_amount    TEXT NOT NULL,     -- $GGRID raw units (bigint as string)
  wallet        TEXT NOT NULL,
  signature     TEXT,
  status        TEXT NOT NULL,     -- PENDING | SENT | FAILED
  error         TEXT,
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER
);

CREATE TABLE IF NOT EXISTS deposit_intents (
  reference    TEXT PRIMARY KEY,   -- Solana Pay reference pubkey (base58), unguessable, single-use
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL,      -- PENDING | CONFIRMED
  signature    TEXT,               -- deposit tx signature once found on-chain
  raw_amount   TEXT,               -- $GGRID raw units deposited (bigint as string)
  credits      INTEGER,            -- credits added to the user's balance
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_provider ON ledger(provider_id);
CREATE INDEX IF NOT EXISTS idx_payouts_provider ON payouts(provider_id);
CREATE INDEX IF NOT EXISTS idx_deposit_user ON deposit_intents(user_id);
-- Backstop against a single on-chain deposit being credited twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_sig ON deposit_intents(signature) WHERE signature IS NOT NULL;
`)

// Idempotent migrations for databases created before a column existed.
for (const ddl of [
  'ALTER TABLE users ADD COLUMN runpod_allowed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN privy_id TEXT', // Privy identity (did:privy:...) — console login
  'ALTER TABLE providers ADD COLUMN privy_id TEXT', // Privy identity — provider console login
  'ALTER TABLE nodes ADD COLUMN price_factor REAL NOT NULL DEFAULT 1.0',
  'ALTER TABLE nodes ADD COLUMN perf REAL NOT NULL DEFAULT 0',
  'ALTER TABLE nodes ADD COLUMN jobs_done INTEGER NOT NULL DEFAULT 0',
  // --- Apple-Silicon ("metal") node tier + measured verification gate ---
  // Existing rows default to backend 'cuda' and state 'verified' so the live
  // network is untouched; only new metal nodes enter the benchmark gate.
  "ALTER TABLE nodes ADD COLUMN backend TEXT NOT NULL DEFAULT 'cuda'", // 'cuda' | 'metal'
  'ALTER TABLE nodes ADD COLUMN chip TEXT', // e.g. 'Apple M5 Max' (self-reported, cross-checked by bench)
  'ALTER TABLE nodes ADD COLUMN mem_gb INTEGER', // unified memory, GB
  'ALTER TABLE nodes ADD COLUMN fanless INTEGER NOT NULL DEFAULT 0', // 1 = MacBook Air (no active cooling)
  'ALTER TABLE nodes ADD COLUMN caps TEXT NOT NULL DEFAULT \'["chat","embeddings"]\'', // endpoints this node serves
  "ALTER TABLE nodes ADD COLUMN state TEXT NOT NULL DEFAULT 'verified'", // 'provisional' | 'verified' | 'rejected'
  'ALTER TABLE nodes ADD COLUMN bench_perf REAL NOT NULL DEFAULT 0', // measured sustained tokens/sec at verify
  'ALTER TABLE nodes ADD COLUMN thermal_ratio REAL', // last/first sustained sample (<1 = throttled)
  'ALTER TABLE nodes ADD COLUMN thermal_limited INTEGER NOT NULL DEFAULT 0', // 1 = throttles under sustained load
  'ALTER TABLE nodes ADD COLUMN tier TEXT', // coarse class label (chip for metal)
  'ALTER TABLE nodes ADD COLUMN verify_error TEXT', // why a node was rejected
  'ALTER TABLE nodes ADD COLUMN verified_at INTEGER',
  // --- Free tier: request counter granted at signup (billed to the sandbox fund) ---
  'ALTER TABLE users ADD COLUMN free_requests INTEGER NOT NULL DEFAULT 0',
  // --- Node geo: coarse "City, CC" for the marketplace / playground meta line.
  // Resolved once from the node's public address; the IP itself is never stored.
  'ALTER TABLE nodes ADD COLUMN geo TEXT',
]) {
  try {
    db.exec(ddl)
  } catch {
    /* column already present */
  }
}
// One GGRID account per Privy identity.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_privy ON users(privy_id) WHERE privy_id IS NOT NULL')
} catch {
  /* index already present */
}
// One provider per Privy identity.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_privy ON providers(privy_id) WHERE privy_id IS NOT NULL')
} catch {
  /* index already present */
}

export const now = (): number => Date.now()
export const uid = (prefix = ''): string => prefix + crypto.randomUUID().replace(/-/g, '')
