-- 006: issuance moves to sovereign in-house minting (no Solana).
-- Replace the devnet-only network check with sovereign-only for new rows.
-- Existing historical rows (devnet test mints) are left untouched via NOT VALID.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issuance_coins_network_check') THEN
    ALTER TABLE issuance_coins DROP CONSTRAINT issuance_coins_network_check;
  END IF;
END $$;

ALTER TABLE issuance_coins ALTER COLUMN network SET DEFAULT 'sovereign';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issuance_coins_network_check') THEN
    ALTER TABLE issuance_coins
      ADD CONSTRAINT issuance_coins_network_check
      CHECK (network IN ('sovereign')) NOT VALID;
  END IF;
END $$;
