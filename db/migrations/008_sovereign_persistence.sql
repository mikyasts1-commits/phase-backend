-- 008_sovereign_persistence.sql
-- Durable sovereign-ledger state: chains survive backend restarts.
-- Previously everything lived in process memory and was wiped on every
-- Render restart (including deployments). These tables are the write-through
-- store behind sovereign-ledger-core.ts: the in-memory Store stays the hot
-- path, every mutation is persisted, and loadLedgerFromDb() rebuilds the
-- Store at boot.
--
-- Also: durable settlement attempts (two-legged buy state machine) and an
-- append-only audit log.

CREATE TABLE IF NOT EXISTS sovereign_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sovereign_chains (
  chain_id TEXT PRIMARY KEY,
  coin_name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  genesis_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  total_supply NUMERIC(39,0) NOT NULL,
  current_supply NUMERIC(39,0) NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 6,
  equity_public_pct INTEGER NOT NULL DEFAULT 0,
  equity_retained_pct INTEGER NOT NULL DEFAULT 0,
  issuer_address TEXT NOT NULL,
  transfer_rules JSONB NOT NULL DEFAULT '{}',
  covenant_hash TEXT,
  is_meme BOOLEAN NOT NULL DEFAULT false,
  issuance_draft_id TEXT,
  issuance_signature_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sovereign_chains_ticker ON sovereign_chains (ticker);
CREATE INDEX IF NOT EXISTS idx_sovereign_chains_status ON sovereign_chains (status);

CREATE TABLE IF NOT EXISTS sovereign_blocks (
  chain_id TEXT NOT NULL REFERENCES sovereign_chains(chain_id) ON DELETE CASCADE,
  height INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  tx_root TEXT NOT NULL,
  state_root TEXT NOT NULL,
  tx_count INTEGER NOT NULL,
  header_hash TEXT NOT NULL,
  sequencer_sig TEXT NOT NULL,
  transactions JSONB NOT NULL DEFAULT '[]',
  state_snapshot JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (chain_id, height)
);

CREATE TABLE IF NOT EXISTS sovereign_balances (
  chain_id TEXT NOT NULL REFERENCES sovereign_chains(chain_id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  balance NUMERIC(39,0) NOT NULL DEFAULT 0,
  nonce INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS sovereign_txs (
  tx_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL REFERENCES sovereign_chains(chain_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  sender TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  signatures JSONB NOT NULL DEFAULT '[]',
  submitted_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  block_height INTEGER,
  tx_index INTEGER,
  confirmed_at BIGINT,
  operator_settled BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_sovereign_txs_chain ON sovereign_txs (chain_id);
CREATE INDEX IF NOT EXISTS idx_sovereign_txs_sender ON sovereign_txs (sender);

-- Mempool entries rehydrated into memory at boot so pending transfers
-- submitted just before a restart still get sequenced.
CREATE TABLE IF NOT EXISTS sovereign_mempool (
  tx_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  tx JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sovereign_mempool_chain ON sovereign_mempool (chain_id);

-- Durable two-legged settlement state for marketplace buys.
-- States: started -> cash_moved -> coin_queued -> coin_confirmed
--        started -> failed_* | cash_moved -> compensated
-- reconcileSettlements() at boot finishes or unwinds anything stuck.
CREATE TABLE IF NOT EXISTS settlement_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  chain_id TEXT NOT NULL,
  coin_id TEXT,
  buyer_user_id TEXT NOT NULL,
  seller_user_id TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  units TEXT NOT NULL,
  price_usd TEXT NOT NULL,
  amount_usd TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'started',
  coin_tx_id TEXT,
  trade_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlement_attempts_state ON settlement_attempts (state);
CREATE INDEX IF NOT EXISTS idx_settlement_attempts_buyer ON settlement_attempts (buyer_user_id);

-- Append-only audit log for money-moving and chain-mutating actions.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at);
