-- 002_securities.sql — tokenized-securities integration layer (Phase BFF).
-- Testnet/sandbox only. Applied through the shared migrate() in db.ts.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS securities_instruments (
  id            TEXT PRIMARY KEY,               -- e.g. 'AAPL.D'
  symbol        TEXT NOT NULL,                  -- e.g. 'AAPL'
  name          TEXT NOT NULL,                  -- e.g. 'Apple Inc.'
  kind          TEXT NOT NULL CHECK (kind IN ('stock', 'etf', 'bond', 'treasury')),
  provider      TEXT NOT NULL DEFAULT 'sandbox',
  chain         TEXT,                           -- e.g. 'BASE' (null until a real provider is wired)
  token_address TEXT,                           -- on-chain token contract, when known
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS securities_orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  instrument_id    TEXT NOT NULL REFERENCES securities_instruments(id),
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty              NUMERIC NOT NULL CHECK (qty > 0),
  order_type       TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  limit_price      NUMERIC,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'open', 'filled', 'cancelled', 'failed')),
  filled_qty       NUMERIC NOT NULL DEFAULT 0,
  avg_fill_price   NUMERIC,
  idempotency_key  TEXT NOT NULL UNIQUE,
  provider_order_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_securities_orders_user
  ON securities_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_securities_orders_provider
  ON securities_orders (provider_order_id);

CREATE TABLE IF NOT EXISTS securities_positions (
  user_id       TEXT NOT NULL,
  instrument_id TEXT NOT NULL REFERENCES securities_instruments(id),
  qty           NUMERIC NOT NULL DEFAULT 0,
  avg_cost      NUMERIC NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instrument_id)
);

-- Append-only transaction history for the user-facing ledger.
-- Conventions: qty is signed (+buy / -sell, +dividend shares if any);
-- amount_usdc is signed from the user's perspective (+credit / -debit).
CREATE TABLE IF NOT EXISTS securities_ledger (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  order_id     TEXT REFERENCES securities_orders(id),
  kind         TEXT NOT NULL CHECK (kind IN ('fill', 'dividend', 'fee', 'transfer')),
  instrument_id TEXT REFERENCES securities_instruments(id),
  qty          NUMERIC NOT NULL DEFAULT 0,
  amount_usdc  NUMERIC NOT NULL DEFAULT 0,
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_securities_ledger_user
  ON securities_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_securities_ledger_order
  ON securities_ledger (order_id);
