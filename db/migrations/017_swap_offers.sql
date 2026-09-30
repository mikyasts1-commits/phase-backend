-- 017: swap offers — coin-for-coin swap proposals with seller consent.
-- A buyer offers units of their own issued coin in exchange for a target
-- coin's units. Nothing moves until the seller accepts (or counters); the
-- buyer accepts a counter. Idempotent: safe to re-run (IF NOT EXISTS).
--
-- request_units is the NET target-coin units the buyer wants to receive
-- (fee is assessed on top at accept time, same 80-bps model as instant
-- swaps: fee = floor(gross * bps / 10000), buyer receives gross - fee).

CREATE TABLE IF NOT EXISTS swap_offers (
  id                  TEXT PRIMARY KEY,
  target_chain_id     TEXT NOT NULL,
  target_coin_id      TEXT NOT NULL REFERENCES issuance_coins(id),
  seller_user_id      TEXT NOT NULL,
  buyer_user_id       TEXT NOT NULL,
  buyer_address       TEXT NOT NULL,
  offer_chain_id      TEXT NOT NULL,
  offer_coin_id       TEXT NOT NULL REFERENCES issuance_coins(id),
  offer_units         NUMERIC(20,6) NOT NULL CHECK (offer_units > 0),
  request_units       NUMERIC(20,6) NOT NULL CHECK (request_units > 0),
  counter_offer_units NUMERIC(20,6) CHECK (counter_offer_units IS NULL OR counter_offer_units > 0),
  counter_request_units NUMERIC(20,6) CHECK (counter_request_units IS NULL OR counter_request_units > 0),
  fee_bps             INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','countered','accepted','declined','cancelled')),
  idempotency_key     TEXT NOT NULL UNIQUE,
  trade_id            TEXT REFERENCES market_trades(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_swap_offers_seller
  ON swap_offers (seller_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_offers_buyer
  ON swap_offers (buyer_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_offers_target
  ON swap_offers (target_chain_id, status);
