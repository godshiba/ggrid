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

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_provider ON ledger(provider_id);
CREATE INDEX IF NOT EXISTS idx_payouts_provider ON payouts(provider_id);
`)

// Idempotent migrations for databases created before a column existed.
for (const ddl of [
  'ALTER TABLE users ADD COLUMN runpod_allowed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE nodes ADD COLUMN price_factor REAL NOT NULL DEFAULT 1.0',
  'ALTER TABLE nodes ADD COLUMN perf REAL NOT NULL DEFAULT 0',
  'ALTER TABLE nodes ADD COLUMN jobs_done INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(ddl)
  } catch {
    /* column already present */
  }
}

export const now = (): number => Date.now()
export const uid = (prefix = ''): string => prefix + crypto.randomUUID().replace(/-/g, '')
