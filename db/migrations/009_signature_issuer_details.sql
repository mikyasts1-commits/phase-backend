-- 009_signature_issuer_details.sql
-- Issuer category (Individual vs Entity, per the minting agreement's
-- signature block) and entity title, captured at sign time so the signed
-- agreement PDF can be auto-populated.

ALTER TABLE issuance_signatures
  ADD COLUMN IF NOT EXISTS issuer_category TEXT NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS title TEXT;
