-- 011_auth.sql — Real account auth: password + session tokens on top of
-- the existing issuance_users table (previously just a thin profile keyed
-- by the anonymous per-device id). Applied through the shared migrate() in
-- db.ts. Idempotent: safe to re-run.

ALTER TABLE issuance_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE issuance_users ADD COLUMN IF NOT EXISTS name TEXT;

-- One email maps to at most one account. Multiple NULL emails are fine —
-- Postgres does not treat NULLs as equal for uniqueness purposes, so the
-- many issuance_users rows created anonymously (no email yet) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS issuance_users_email_uniq
  ON issuance_users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES issuance_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);
