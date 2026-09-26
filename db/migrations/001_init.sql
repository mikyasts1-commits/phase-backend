-- 001_init.sql — Phase crypto-funding persistence (testnet).
-- Idempotent: safe to apply more than once (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per Phase user: the full UserWalletRecord as JSONB plus the
-- wallet_set_id denormalized for quick lookups.
CREATE TABLE IF NOT EXISTS user_wallets (
  user_id       TEXT PRIMARY KEY,
  wallet_set_id TEXT NOT NULL,
  record        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase treasury wallets, one per chain (replaces the in-memory Map).
CREATE TABLE IF NOT EXISTS treasury_wallets (
  chain_id   TEXT PRIMARY KEY,
  wallet     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Funding ledger: deposits (inbound) and sweeps (user -> treasury).
-- amount stays TEXT so the exact USDC decimal string is never rounded.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('deposit', 'sweep')),
  chain                 TEXT NOT NULL,
  amount                TEXT NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USDC',
  wallet_id             TEXT,
  address               TEXT,
  circle_transfer_id    TEXT,
  tx_hash               TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed')),
  verified              BOOLEAN NOT NULL DEFAULT false,
  confirmations         INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL DEFAULT 12,
  idempotency_key       TEXT NOT NULL,
  network               TEXT NOT NULL DEFAULT 'testnet',
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency keys are globally unique: a repeated insert returns the
-- existing row instead of creating a duplicate ledger entry.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_idempotency_key_uniq
  ON ledger_entries (idempotency_key);

-- A Circle transfer maps to at most one ledger entry; NULLs (entries not
-- yet submitted to Circle) are exempt via the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_circle_transfer_uniq
  ON ledger_entries (circle_transfer_id)
  WHERE circle_transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_entries_user_id_idx
  ON ledger_entries (user_id, created_at DESC);

-- Webhook notification ids already processed (dedup). Bounded by pruning
-- rows older than 30 days whenever the table grows past ~10k rows.
CREATE TABLE IF NOT EXISTS webhook_dedup (
  notification_id TEXT PRIMARY KEY,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
