-- 004_social_connections.sql
-- Social media OAuth connections for Go Live verification.
-- Stores encrypted provider tokens + public profile snapshots.

CREATE TABLE IF NOT EXISTS social_connections (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('tiktok', 'youtube', 'instagram')),
  provider_user_id TEXT NOT NULL,
  username         TEXT NOT NULL DEFAULT '',
  display_name     TEXT NOT NULL DEFAULT '',
  avatar_url       TEXT,
  follower_count   BIGINT,
  access_token     TEXT NOT NULL,   -- encrypted via social-auth.ts
  refresh_token    TEXT,            -- encrypted, nullable
  token_expires_at TIMESTAMPTZ,
  scopes           TEXT[] NOT NULL DEFAULT '{}',
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_social_connections_user ON social_connections(user_id);

-- Short-lived OAuth state for PKCE flows (state -> userId/provider/verifier)
CREATE TABLE IF NOT EXISTS social_oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- States expire after 10 minutes; cleaned opportunistically
CREATE INDEX IF NOT EXISTS idx_social_oauth_states_created ON social_oauth_states(created_at);
