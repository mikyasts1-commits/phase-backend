-- Idempotency keys for issuance drafts and signatures.
-- Allows safe retries: if a draft/sign request is retried with the same key,
-- the existing record is returned instead of creating a duplicate.

ALTER TABLE issuance_drafts
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE issuance_signatures
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique indexes: only enforce uniqueness when a key is provided.
-- Multiple NULLs are allowed (drafts/signs created without a key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_issuance_drafts_idempotency
  ON issuance_drafts (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_issuance_signatures_idempotency
  ON issuance_signatures (idempotency_key) WHERE idempotency_key IS NOT NULL;
