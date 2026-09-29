-- 016_fee_treasury.sql — Phase 80-bps transaction fee & treasury system.
--
-- Tables:
--   fee_config            versioned, server-controlled fee configuration (append-only)
--   treasury_accounts     Phase treasury account registry (no secrets here — ever)
--   treasury_balances     per-asset treasury balances (authoritative for reporting)
--   fee_ledger            immutable per-transaction fee records
--   treasury_withdrawals  authorized treasury withdrawal workflow
--   reconciliation_runs   daily reconciliation history
-- Alters:
--   issuance_users        ADD is_admin
--   market_trades         ADD fee_bps / fee_amount / net_amount
--   settlement_attempts   ADD fee_units / fee_bps / fee_tx_id (swap coin-fee tracking)

-- ---------------------------------------------------------------------------
-- 1. Fee configuration (append-only; latest row wins)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_config (
  version      INT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fee_bps      INT NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the launch configuration (80 bps) when the table is empty.
-- The seed default may come from TRANSACTION_FEE_BPS at application boot;
-- this row only guarantees the table is never empty on fresh installs.
INSERT INTO fee_config (fee_bps, created_by, reason)
SELECT 80, 'system:seed', 'Launch configuration: 80 basis points (0.80%)'
WHERE NOT EXISTS (SELECT 1 FROM fee_config);

-- ---------------------------------------------------------------------------
-- 2. Treasury accounts (registry only — secrets live in env/secret manager)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS treasury_accounts (
  account_id TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO treasury_accounts (account_id, label)
VALUES ('PHASE_TREASURY', 'Phase corporate treasury')
ON CONFLICT (account_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Treasury balances — one row per (account, asset). Asset-specific.
--    NUMERIC(30,6): covers USD microunits and whole-unit coin amounts.
--
--    PRECISION CONTRACT (enforced in fee.ts, the authoritative layer):
--    USD is stored as exact microunits (6dp). Coin assets are whole units
--    in v1 and are stored as exact "N.000000" values — NUMERIC(30,6)
--    represents these exactly; no fractional coin amounts may be written.
--    The asset precision registry (fee.ts: assetDecimals/toBaseUnits) is
--    the single source of truth for base-unit rules; this schema stays
--    asset-agnostic by design.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS treasury_balances (
  account_id   TEXT NOT NULL REFERENCES treasury_accounts(account_id),
  asset_symbol TEXT NOT NULL,
  balance      NUMERIC(30,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, asset_symbol)
);

-- ---------------------------------------------------------------------------
-- 4. Fee ledger — immutable, one row per fee-bearing transaction.
--    Every row records the fee_bps actually applied (auditable across changes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_ledger (
  fee_id             TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL UNIQUE,
  transaction_id     TEXT,
  transaction_type   TEXT NOT NULL CHECK (transaction_type IN ('marketplace_buy', 'marketplace_swap')),
  user_id            TEXT NOT NULL,
  asset_id           TEXT,
  asset_symbol       TEXT NOT NULL,
  gross_quantity     NUMERIC(30,6) NOT NULL CHECK (gross_quantity >= 0),
  fee_bps            INT NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  fee_quantity       NUMERIC(30,6) NOT NULL CHECK (fee_quantity >= 0),
  net_quantity       NUMERIC(30,6) NOT NULL CHECK (net_quantity >= 0),
  treasury_account_id TEXT NOT NULL REFERENCES treasury_accounts(account_id),
  status             TEXT NOT NULL DEFAULT 'settled'
                     CHECK (status IN ('settled', 'pending', 'reversed', 'failed')),
  coin_tx_id         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at         TIMESTAMPTZ,
  reversed_at        TIMESTAMPTZ,
  reversal_reason    TEXT,
  CONSTRAINT fee_math_check CHECK (gross_quantity = fee_quantity + net_quantity)
);

CREATE INDEX IF NOT EXISTS idx_fee_ledger_tx      ON fee_ledger (transaction_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_user    ON fee_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_asset  ON fee_ledger (asset_symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_status  ON fee_ledger (status);

-- ---------------------------------------------------------------------------
-- 5. Treasury withdrawals — requested -> approved -> executed (audited)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS treasury_withdrawals (
  id                  TEXT PRIMARY KEY,
  treasury_account_id TEXT NOT NULL REFERENCES treasury_accounts(account_id),
  asset_symbol        TEXT NOT NULL,
  amount              NUMERIC(30,6) NOT NULL CHECK (amount > 0),
  destination_ref     TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'manual',
  provider_ref        TEXT,
  status              TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'approved', 'rejected', 'executed', 'cancelled')),
  requested_by        TEXT NOT NULL,
  approved_by         TEXT,
  executed_by         TEXT,
  self_approved       BOOLEAN NOT NULL DEFAULT FALSE,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON treasury_withdrawals (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Reconciliation runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id           BIGSERIAL PRIMARY KEY,
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  totals       JSONB NOT NULL,
  invariant_ok BOOLEAN NOT NULL,
  alerted      BOOLEAN NOT NULL DEFAULT FALSE
);

-- ---------------------------------------------------------------------------
-- 7. Alters
-- ---------------------------------------------------------------------------
ALTER TABLE issuance_users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE market_trades
  ADD COLUMN IF NOT EXISTS fee_bps INT,
  ADD COLUMN IF NOT EXISTS fee_amount TEXT,
  ADD COLUMN IF NOT EXISTS net_amount TEXT;

ALTER TABLE settlement_attempts
  ADD COLUMN IF NOT EXISTS fee_units TEXT,
  ADD COLUMN IF NOT EXISTS fee_bps INT,
  ADD COLUMN IF NOT EXISTS fee_tx_id TEXT;
