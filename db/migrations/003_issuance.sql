-- 003_issuance.sql — Phase coin issuance (testnet): users, drafts, digital
-- signatures, and minted coins. Applied through the shared migrate() in db.ts.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).
--
-- NOTE on deposits: the funding ledger already records deposits in
-- ledger_entries (kind='deposit') from 001_init.sql. No duplicate deposits
-- table is created here; issuance references users by user_id.

CREATE TABLE IF NOT EXISTS issuance_users (
  id         TEXT PRIMARY KEY,          -- Phase user id (Supabase Auth sub later)
  email      TEXT,                      -- thin profile; auth itself is Supabase Auth
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A coin draft: everything the issuer entered before minting.
CREATE TABLE IF NOT EXISTS issuance_drafts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT '',
  tagline         TEXT NOT NULL DEFAULT '',
  value_thesis    TEXT NOT NULL DEFAULT '',
  equity_public   INTEGER NOT NULL DEFAULT 50,   -- % of 1M shares to public float
  equity_retained INTEGER NOT NULL DEFAULT 50,   -- % retained by issuer; sums to 100
  social_profiles JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'signed', 'minted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issuance_drafts_user_id_idx
  ON issuance_drafts (user_id, created_at DESC);

-- Digital signature of the issuer agreement for a draft.
-- agreement_hash = sha256 of the exact rendered agreement text the issuer saw.
CREATE TABLE IF NOT EXISTS issuance_signatures (
  id             TEXT PRIMARY KEY,
  draft_id       TEXT NOT NULL UNIQUE REFERENCES issuance_drafts(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  legal_name     TEXT NOT NULL,
  agreement_hash TEXT NOT NULL,          -- sha256 hex of rendered agreement text
  agreement_text TEXT NOT NULL,          -- exact text signed (for audit)
  signed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issuance_signatures_user_id_idx
  ON issuance_signatures (user_id);

-- A minted coin. One draft mints at most once; the idempotency key makes
-- POST /api/v1/issuance/mint safe to retry.
CREATE TABLE IF NOT EXISTS issuance_coins (
  id              TEXT PRIMARY KEY,
  draft_id        TEXT NOT NULL UNIQUE REFERENCES issuance_drafts(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  signature_id    TEXT REFERENCES issuance_signatures(id) ON DELETE SET NULL,
  is_meme         BOOLEAN NOT NULL DEFAULT false,
  name            TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  mint_address    TEXT NOT NULL,         -- SPL mint on Solana devnet
  tx_signature    TEXT NOT NULL,         -- mintTo transaction signature
  supply          TEXT NOT NULL,         -- human units, "1000000"
  decimals        INTEGER NOT NULL DEFAULT 6,
  network         TEXT NOT NULL DEFAULT 'devnet'
                  CHECK (network IN ('devnet')),  -- mainnet has no code path
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One idempotency key maps to at most one coin: retries return the original.
CREATE UNIQUE INDEX IF NOT EXISTS issuance_coins_idempotency_key_uniq
  ON issuance_coins (idempotency_key);

CREATE INDEX IF NOT EXISTS issuance_coins_user_id_idx
  ON issuance_coins (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS issuance_coins_mint_address_idx
  ON issuance_coins (mint_address);
