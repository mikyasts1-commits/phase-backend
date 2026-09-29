-- Migration 013: Add website_url to issued coins
-- Business and asset issuers can list their website, shown on the marketplace listing.

ALTER TABLE issuance_coins ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE issuance_drafts ADD COLUMN IF NOT EXISTS website_url TEXT;
