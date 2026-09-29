-- 012_coin_share_fields.sql — Dashboard needs per-coin category and the
-- exact share split (total + retained) to compute retained issuance value.
-- These are frozen at mint time from the draft. Idempotent: safe to re-run.

ALTER TABLE issuance_coins ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE issuance_coins ADD COLUMN IF NOT EXISTS total_shares NUMERIC(30,6);
ALTER TABLE issuance_coins ADD COLUMN IF NOT EXISTS retained_shares NUMERIC(30,6);

-- Backfill coins minted before this migration from their drafts.
UPDATE issuance_coins c
SET category = d.category,
    total_shares = c.supply::numeric,
    retained_shares = (c.supply::numeric * d.equity_retained / 100)
FROM issuance_drafts d
WHERE c.draft_id = d.id
  AND (c.category IS NULL OR c.total_shares IS NULL OR c.retained_shares IS NULL);
