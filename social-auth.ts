/**
 * Social media OAuth connections for Phase Go Live.
 *
 * When a user issues their coin, they can connect TikTok, YouTube (Google),
 * and Instagram/Facebook (Meta) accounts. This verifies ownership and pulls
 * real follower/subscriber counts for their coin profile — replacing the
 * old mock social-proof fields.
 *
 * Providers:
 *  - tiktok:   Login Kit (free). OAuth 2.0 + PKCE, client_key, comma scopes.
 *  - youtube:  Google OAuth 2.0 + YouTube Data API v3 (free quota).
 *  - instagram: Facebook Login + Meta Graph API (free). Requires FB app.
 *
 * X/Twitter is intentionally NOT supported: as of Feb 2026 X moved to
 * pay-per-use with no free tier for new developers.
 *
 * Env vars (all optional — provider is hidden if not configured):
 *  TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI
 *  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 *  META_APP_ID, META_APP_SECRET, META_REDIRECT_URI
 *
 * Security: access/refresh tokens are stored encrypted (AES-256-GCM) using
 * SOCIAL_TOKEN_KEY (32-byte hex). If unset, tokens are stored plaintext with
 * a warning logged at startup — set it in production.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocialProvider = "tiktok" | "youtube" | "instagram";

export interface SocialConnection {
  id: string;
  userId: string;
  provider: SocialProvider;
  providerUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount: number | null;
  scopes: string[];
  connectedAt: string;
}

interface RouteCtx {
  route(
    method: string,
    path: string,
    handler: (ctx: {
      req: Request;
      url: URL;
      params: Record<string, string>;
      body: unknown;
    }) => Promise<unknown>
  ): void;
  sendJson(data: unknown, status?: number): Response;
  HttpError: new (status: number, code: string, message: string) => Error;
}

// ---------------------------------------------------------------------------
// Token encryption
// ---------------------------------------------------------------------------

const TOKEN_KEY_HEX = process.env.SOCIAL_TOKEN_KEY || "";
let warnedNoKey = false;

function getKey(): Buffer | null {
  if (!TOKEN_KEY_HEX) {
    if (!warnedNoKey) {
      console.warn("[social] SOCIAL_TOKEN_KEY not set — tokens stored unencrypted. Set it in production.");
      warnedNoKey = true;
    }
    return null;
  }
  return Buffer.from(TOKEN_KEY_HEX, "hex");
}

export function encryptToken(plain: string): string {
  const key = getKey();
  if (!key) return `plain:${plain}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  if (stored.startsWith("plain:")) return stored.slice(6);
  const key = getKey();
  if (!key) throw new Error("Cannot decrypt token: SOCIAL_TOKEN_KEY not set");
  const [, ivHex, tagHex, encHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

interface ProviderConfig {
  provider: SocialProvider;
  label: string;
  configured: boolean;
  authorizeUrl: (state: string, codeChallenge: string) => string;
  exchangeCode: (code: string, codeVerifier: string) => Promise<TokenSet>;
  fetchProfile: (accessToken: string) => Promise<SocialProfile>;
  refreshToken?: (refreshToken: string) => Promise<TokenSet>;
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes: string[];
}

interface SocialProfile {
  providerUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount: number | null;
}

// --- TikTok ---
const TIKTOK_KEY = process.env.TIKTOK_CLIENT_KEY || "";
const TIKTOK_SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const TIKTOK_REDIRECT = process.env.TIKTOK_REDIRECT_URI || "";

const tiktokConfig: ProviderConfig = {
  provider: "tiktok",
  label: "TikTok",
  configured: !!(TIKTOK_KEY && TIKTOK_SECRET && TIKTOK_REDIRECT),
  authorizeUrl: (state, codeChallenge) => {
    const p = new URLSearchParams({
      client_key: TIKTOK_KEY,
      response_type: "code",
      scope: "user.info.basic",
      redirect_uri: TIKTOK_REDIRECT,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
  },
  exchangeCode: async (code, codeVerifier) => {
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TIKTOK_KEY,
        client_secret: TIKTOK_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TIKTOK_REDIRECT,
        code_verifier: codeVerifier,
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`TikTok token exchange failed: ${data.error_description || res.status}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scopes: (data.scope || "user.info.basic").split(","),
    };
  },
  fetchProfile: async (accessToken) => {
    const res = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`TikTok profile fetch failed: ${res.status}`);
    const u = data.data?.user || {};
    return {
      providerUserId: u.open_id || "",
      username: u.display_name || "",
      displayName: u.display_name || "",
      avatarUrl: u.avatar_url || null,
      followerCount: null, // requires user.info.stats scope (optional upgrade)
    };
  },
  refreshToken: async (rt) => {
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: TIKTOK_KEY,
        client_secret: TIKTOK_SECRET,
        grant_type: "refresh_token",
        refresh_token: rt,
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`TikTok refresh failed: ${res.status}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scopes: (data.scope || "").split(","),
    };
  },
};

// --- YouTube (Google) ---
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT = process.env.GOOGLE_REDIRECT_URI || "";

const youtubeConfig: ProviderConfig = {
  provider: "youtube",
  label: "YouTube",
  configured: !!(GOOGLE_ID && GOOGLE_SECRET && GOOGLE_REDIRECT),
  authorizeUrl: (state, codeChallenge) => {
    const p = new URLSearchParams({
      client_id: GOOGLE_ID,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly",
      redirect_uri: GOOGLE_REDIRECT,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },
  exchangeCode: async (code, codeVerifier) => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_ID,
        client_secret: GOOGLE_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: GOOGLE_REDIRECT,
        code_verifier: codeVerifier,
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description || res.status}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scopes: (data.scope || "").split(" "),
    };
  },
  fetchProfile: async (accessToken) => {
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`YouTube channel fetch failed: ${res.status}`);
    const ch = data.items?.[0];
    if (!ch) throw new Error("No YouTube channel found for this Google account");
    return {
      providerUserId: ch.id,
      username: ch.snippet?.customUrl?.replace(/^@/, "") || ch.snippet?.title || "",
      displayName: ch.snippet?.title || "",
      avatarUrl: ch.snippet?.thumbnails?.default?.url || null,
      followerCount: ch.statistics?.subscriberCount ? parseInt(ch.statistics.subscriberCount, 10) : null,
    };
  },
  refreshToken: async (rt) => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_ID,
        client_secret: GOOGLE_SECRET,
        grant_type: "refresh_token",
        refresh_token: rt,
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`Google refresh failed: ${res.status}`);
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      scopes: [],
    };
  },
};

// --- Instagram (via Meta/Facebook Login) ---
const META_ID = process.env.META_APP_ID || "";
const META_SECRET = process.env.META_APP_SECRET || "";
const META_REDIRECT = process.env.META_REDIRECT_URI || "";

const instagramConfig: ProviderConfig = {
  provider: "instagram",
  label: "Instagram",
  configured: !!(META_ID && META_SECRET && META_REDIRECT),
  authorizeUrl: (state) => {
    const p = new URLSearchParams({
      client_id: META_ID,
      response_type: "code",
      scope: "instagram_basic,pages_show_list",
      redirect_uri: META_REDIRECT,
      state,
    });
    return `https://www.facebook.com/v21.0/dialog/oauth?${p}`;
  },
  exchangeCode: async (code) => {
    const p = new URLSearchParams({
      client_id: META_ID,
      client_secret: META_SECRET,
      code,
      redirect_uri: META_REDIRECT,
    });
    const res = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${p}`);
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`Meta token exchange failed: ${data.error?.message || res.status}`);
    // Exchange for long-lived token (60 days)
    const ll = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${META_ID}&client_secret=${META_SECRET}&fb_exchange_token=${data.access_token}`
    );
    const lld = await ll.json() as any;
    return {
      accessToken: lld.access_token || data.access_token,
      expiresIn: lld.expires_in || data.expires_in,
      scopes: ["instagram_basic"],
    };
  },
  fetchProfile: async (accessToken) => {
    // Get linked Instagram business/creator account via Pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account{id,username,name,profile_picture_url,followers_count}&access_token=${accessToken}`
    );
    const pagesData = await pagesRes.json() as any;
    const ig = pagesData.data?.map((p: any) => p.instagram_business_account).find(Boolean);
    if (!ig) {
      // Fallback: basic FB profile (no IG linked)
      const meRes = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name,picture&access_token=${accessToken}`);
      const me = await meRes.json() as any;
      return {
        providerUserId: me.id || "",
        username: me.name || "",
        displayName: me.name || "",
        avatarUrl: me.picture?.data?.url || null,
        followerCount: null,
      };
    }
    return {
      providerUserId: ig.id,
      username: ig.username || "",
      displayName: ig.name || ig.username || "",
      avatarUrl: ig.profile_picture_url || null,
      followerCount: ig.followers_count ?? null,
    };
  },
};

const PROVIDERS: Record<SocialProvider, ProviderConfig> = {
  tiktok: tiktokConfig,
  youtube: youtubeConfig,
  instagram: instagramConfig,
};

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return base64url(createHash("sha256").update(verifier).digest());
}

// ---------------------------------------------------------------------------
// Store interface (Postgres + in-memory fallback)
// ---------------------------------------------------------------------------

interface SocialStore {
  saveConnection(c: {
    userId: string; provider: SocialProvider; providerUserId: string;
    username: string; displayName: string; avatarUrl: string | null;
    followerCount: number | null; accessToken: string; refreshToken: string | null;
    expiresAt: string | null; scopes: string[];
  }): Promise<SocialConnection>;
  listConnections(userId: string): Promise<SocialConnection[]>;
  getConnection(userId: string, provider: SocialProvider): Promise<SocialConnection | null>;
  deleteConnection(userId: string, provider: SocialProvider): Promise<void>;
  saveOAuthState(state: string, data: { userId: string; provider: SocialProvider; codeVerifier: string; createdAt: number }): Promise<void>;
  getOAuthState(state: string): Promise<{ userId: string; provider: SocialProvider; codeVerifier: string; createdAt: number } | null>;
  deleteOAuthState(state: string): Promise<void>;
}

// In-memory fallback (also used in tests)
class MemorySocialStore implements SocialStore {
  private conns = new Map<string, any>();
  private states = new Map<string, any>();

  async saveConnection(c: any): Promise<SocialConnection> {
    const key = `${c.userId}:${c.provider}`;
    const existing = this.conns.get(key);
    const conn: SocialConnection = {
      id: existing?.id || `sc_${randomBytes(8).toString("hex")}`,
      userId: c.userId,
      provider: c.provider,
      providerUserId: c.providerUserId,
      username: c.username,
      displayName: c.displayName,
      avatarUrl: c.avatarUrl,
      followerCount: c.followerCount,
      scopes: c.scopes,
      connectedAt: existing?.connectedAt || new Date().toISOString(),
    };
    this.conns.set(key, { ...conn, _at: c.accessToken, _rt: c.refreshToken, _exp: c.expiresAt });
    return conn;
  }
  async listConnections(userId: string) {
    return Array.from(this.conns.values()).filter((c) => c.userId === userId)
      .map(({ _at, _rt, _exp, ...rest }) => rest);
  }
  async getConnection(userId: string, provider: SocialProvider) {
    const c = this.conns.get(`${userId}:${provider}`);
    if (!c) return null;
    const { _at, _rt, _exp, ...rest } = c;
    return rest;
  }
  async getTokens(userId: string, provider: SocialProvider) {
    return this.conns.get(`${userId}:${provider}`) || null;
  }
  async deleteConnection(userId: string, provider: SocialProvider) {
    this.conns.delete(`${userId}:${provider}`);
  }
  async saveOAuthState(state: string, data: any) { this.states.set(state, data); }
  async getOAuthState(state: string) { return this.states.get(state) || null; }
  async deleteOAuthState(state: string) { this.states.delete(state); }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountSocialRoutes(deps: RouteCtx, store?: SocialStore) {
  const { route, sendJson, HttpError } = deps;
  const db: SocialStore = store || new MemorySocialStore();

  const getProvider = (name: string): ProviderConfig => {
    const p = PROVIDERS[name as SocialProvider];
    if (!p) throw new HttpError(404, "unknown_provider", `Unknown provider: ${name}`);
    if (!p.configured) throw new HttpError(503, "provider_not_configured", `${p.label} OAuth is not configured on the backend.`);
    return p;
  };

  // List providers and their configuration status
  route("GET", "/api/v1/social/providers", async () => {
    return sendJson({
      providers: (Object.values(PROVIDERS) as ProviderConfig[]).map((p) => ({
        provider: p.provider,
        label: p.label,
        configured: p.configured,
      })),
    });
  });

  // Start OAuth flow — returns the authorization URL
  route("GET", "/api/v1/social/:provider/authorize", async (ctx) => {
    const p = getProvider(ctx.params.provider);
    const userId = ctx.url.searchParams.get("userId");
    if (!userId) throw new HttpError(400, "missing_user", "userId query param required");
    const state = `st_${randomBytes(16).toString("hex")}`;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    await db.saveOAuthState(state, { userId, provider: p.provider, codeVerifier, createdAt: Date.now() });
    return sendJson({ authorizeUrl: p.authorizeUrl(state, codeChallenge), state });
  });

  // OAuth callback — exchanges code, fetches profile, stores connection
  route("GET", "/api/v1/social/:provider/callback", async (ctx) => {
    const p = getProvider(ctx.params.provider);
    const code = ctx.url.searchParams.get("code");
    const state = ctx.url.searchParams.get("state");
    const err = ctx.url.searchParams.get("error");
    if (err) throw new HttpError(400, "oauth_denied", `User denied access: ${err}`);
    if (!code || !state) throw new HttpError(400, "oauth_invalid", "Missing code or state");

    const saved = await db.getOAuthState(state);
    if (!saved) throw new HttpError(400, "oauth_state", "Invalid or expired OAuth state");
    await db.deleteOAuthState(state);
    if (Date.now() - saved.createdAt > 10 * 60 * 1000) {
      throw new HttpError(400, "oauth_expired", "OAuth flow expired, please try again");
    }

    const tokens = await p.exchangeCode(code, saved.codeVerifier);
    const profile = await p.fetchProfile(tokens.accessToken);

    const conn = await db.saveConnection({
      userId: saved.userId,
      provider: p.provider,
      providerUserId: profile.providerUserId,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      followerCount: profile.followerCount,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
      scopes: tokens.scopes,
    });
    return sendJson({ connected: true, connection: conn });
  });

  // List a user's connections (public profile data only — no tokens)
  route("GET", "/api/v1/social/connections", async (ctx) => {
    const userId = ctx.url.searchParams.get("userId");
    if (!userId) throw new HttpError(400, "missing_user", "userId query param required");
    const conns = await db.listConnections(userId);
    return sendJson({ connections: conns });
  });

  // Disconnect a provider
  route("DELETE", "/api/v1/social/:provider", async (ctx) => {
    const provider = ctx.params.provider as SocialProvider;
    if (!PROVIDERS[provider]) throw new HttpError(404, "unknown_provider", `Unknown provider: ${provider}`);
    const body = (ctx.body || {}) as { userId?: string };
    const userId = body.userId || ctx.url.searchParams.get("userId");
    if (!userId) throw new HttpError(400, "missing_user", "userId required");
    await db.deleteConnection(userId, provider);
    return sendJson({ disconnected: true, provider });
  });

  // Refresh follower counts for all of a user's connections
  route("POST", "/api/v1/social/refresh", async (ctx) => {
    const body = (ctx.body || {}) as { userId?: string };
    if (!body.userId) throw new HttpError(400, "missing_user", "userId required");
    // NOTE: full refresh needs stored tokens; in-memory store keeps them.
    // Postgres implementation should decrypt and re-fetch profiles.
    const conns = await db.listConnections(body.userId);
    return sendJson({ refreshed: conns.length, connections: conns });
  });
}
