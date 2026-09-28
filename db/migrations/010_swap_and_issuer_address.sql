-- 010: coin-for-coin swap rail.
--
-- Coin-for-coin swaps let a buyer offer units of THEIR OWN issued coin in
-- exchange for another issuer's coin (the marketplace "offer your own coins
-- as exchange" path). The trade is a two-legged, compensating settlement:
--   offer leg: buyer's coins on the offer chain -> target coin's issuer
--   target leg: target coin's public float -> buyer on the target chain
-- Swap attempts reuse the durable settlement_attempts state machine with
-- kind='swap' (states: started -> offer_moved -> target_queued -> coin_confirmed,
-- failed, compensated). Trades are recorded in market_trades with kind='swap'.
--
-- Also records the issuer's sovereign wallet address on issuance_coins so the
-- offer leg knows where to send the offered coins.

-- Where the offer leg sends coins: the target coin's issuer address.
ALTER TABLE issuance_coins
  ADD COLUMN IF NOT EXISTS issuer_address TEXT;

-- Distinguish buys from swaps on the trade record.
ALTER TABLE market_trades
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'buy',
  ADD COLUMN IF NOT EXISTS offer_chain_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_coin_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_units TEXT,
  ADD COLUMN IF NOT EXISTS offer_tx_id TEXT;

-- Swap attempts carry the offer leg fields plus the target issuer's address.
ALTER TABLE settlement_attempts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'buy',
  ADD COLUMN IF NOT EXISTS offer_chain_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_coin_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_units TEXT,
  ADD COLUMN IF NOT EXISTS offer_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS seller_address TEXT;

CREATE INDEX IF NOT EXISTS idx_settlement_attempts_kind
  ON settlement_attempts (kind);
