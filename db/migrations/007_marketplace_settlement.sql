-- 007: marketplace settlement — coin price + per-user cash ledger + trades.
-- Lets a buyer purchase a sovereign coin and routes the payment to the
-- issuer's account (the "does the issuer get paid" infrastructure).
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

-- Starting price per coin (USD per whole coin), set by the issuer at draft
-- time. Carried onto the coin record at mint.
ALTER TABLE issuance_drafts
  ADD COLUMN IF NOT EXISTS price_usd NUMERIC(20,6) NOT NULL DEFAULT 10;
ALTER TABLE issuance_coins
  ADD COLUMN IF NOT EXISTS price_usd NUMERIC(20,6) NOT NULL DEFAULT 10;

-- Per-user cash ledger for marketplace settlement. Balances only move via
-- the trade/top-up code paths below (never negative).
CREATE TABLE IF NOT EXISTS market_balances (
  user_id    TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  balance    NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);

-- One row per executed buy: buyer paid amount_usd, seller (the issuer) was
-- credited, and units of the coin moved float -> buyer on the sovereign chain.
CREATE TABLE IF NOT EXISTS market_trades (
  id              TEXT PRIMARY KEY,
  chain_id        TEXT NOT NULL,
  coin_id         TEXT NOT NULL REFERENCES issuance_coins(id),
  buyer_user_id   TEXT NOT NULL,
  seller_user_id  TEXT NOT NULL,
  units           NUMERIC(20,6) NOT NULL CHECK (units > 0),
  price_usd       NUMERIC(20,6) NOT NULL CHECK (price_usd > 0),
  amount_usd      NUMERIC(20,6) NOT NULL CHECK (amount_usd > 0),
  buyer_address   TEXT NOT NULL,
  tx_id           TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One idempotency key maps to at most one trade: retries return the original.
CREATE UNIQUE INDEX IF NOT EXISTS market_trades_idempotency_key_uniq
  ON market_trades (idempotency_key);
CREATE INDEX IF NOT EXISTS market_trades_chain_id_idx
  ON market_trades (chain_id);
CREATE INDEX IF NOT EXISTS market_trades_seller_idx
  ON market_trades (seller_user_id, created_at DESC);
