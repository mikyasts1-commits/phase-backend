-- 005_stripe_fiat.sql — Fiat (Stripe) funding ledger support.
--
-- Extends ledger_entries for Stripe test-mode deposits:
--   - kind gains 'fiat_deposit' (fiat via Stripe PaymentIntent)
--   - stripe_payment_intent_id links the ledger entry to the Stripe object
--     (unique: one PaymentIntent credits at most once)

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_kind_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check
  CHECK (kind IN ('deposit', 'sweep', 'fiat_deposit'));

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_stripe_pi_uniq
  ON ledger_entries (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
