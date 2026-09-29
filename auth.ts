/**
 * Phase account auth — real email+password accounts with server-side
 * sessions, on top of the existing `issuance_users` table (previously just
 * a thin profile keyed by the anonymous per-device id, filled in lazily by
 * issuance.ts's ensureUser()).
 *
 * This replaces the client-only "login" that used to just swap a JSON blob
 * in localStorage. A real account here means: the userId this returns is
 * the SAME id the app should use for every issuance/trades/funding call —
 * so a person's issued coins, holdings, and balances follow their account
 * across devices and reinstalls, not just their current app install.
 *
 * Passwords are hashed with scrypt (Node's built-in crypto — no new
 * dependency). Sessions are opaque random tokens stored server-side, not
 * signed JWTs, so logout / revocation is a plain DELETE.
 *
 * Persistence: Postgres when DATABASE_URL is set, otherwise an in-memory
 * store (dev/test) — same dual-mode pattern as issuance.ts.
 *
 * Mounted from phase-backend.ts: mountAuthRoutes({ route, sendJson, HttpError })
 */
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getPool } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Store: Postgres when DATABASE_URL is set, in-memory fallback otherwise.
// ---------------------------------------------------------------------------

export interface AuthAccount {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export interface AuthStore {
  createAccount(email: string, passwordHash: string, name?: string): Promise<AuthAccount>;
  findByEmail(email: string): Promise<(AuthAccount & { passwordHash: string | null }) | null>;
  findById(id: string): Promise<AuthAccount | null>;
  createSession(userId: string): Promise<{ token: string; expiresAt: string }>;
  getSession(token: string): Promise<{ userId: string; expiresAt: string } | null>;
  deleteSession(token: string): Promise<void>;
  // Password reset
  createPasswordResetToken(userId: string): Promise<string>;
  validatePasswordResetToken(token: string): Promise<string | null>; // returns userId
  usePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean>;
  // Email verification
  createEmailVerificationToken(userId: string): Promise<string>;
  verifyEmailToken(token: string): Promise<boolean>;
  isEmailVerified(userId: string): Promise<boolean>;
  // Login rate limiting
  recordLoginAttempt(email: string, ip: string, success: boolean): Promise<void>;
  countRecentFailedLogins(email: string, ip: string, sinceMinutes: number): Promise<number>;
}

class PgAuthStore implements AuthStore {
  private async q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query(text, params as unknown[]);
    return r.rows as T[];
  }

  async createAccount(email: string, passwordHash: string, name?: string): Promise<AuthAccount> {
    const id = randomUUID();
    const rows = await this.q<AuthAccount>(
      `INSERT INTO issuance_users(id, email, password_hash, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, created_at AS "createdAt"`,
      [id, email, passwordHash, name ?? null]
    );
    return rows[0]!;
  }

  async findByEmail(email: string): Promise<(AuthAccount & { passwordHash: string | null }) | null> {
    const rows = await this.q<AuthAccount & { passwordHash: string | null }>(
      `SELECT id, email, name, password_hash AS "passwordHash", created_at AS "createdAt"
       FROM issuance_users WHERE lower(email) = lower($1)`,
      [email]
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<AuthAccount | null> {
    const rows = await this.q<AuthAccount>(
      `SELECT id, email, name, created_at AS "createdAt" FROM issuance_users WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  async createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomUUID() + randomUUID(); // extra entropy, no dashes stripped — fine as an opaque token
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.q(
      `INSERT INTO auth_sessions(token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, userId, expiresAt]
    );
    return { token, expiresAt };
  }

  async getSession(token: string): Promise<{ userId: string; expiresAt: string } | null> {
    const rows = await this.q<{ userId: string; expiresAt: string }>(
      `SELECT user_id AS "userId", expires_at AS "expiresAt" FROM auth_sessions
       WHERE token = $1 AND expires_at > now()`,
      [token]
    );
    return rows[0] ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.q(`DELETE FROM auth_sessions WHERE token = $1`, [token]);
  }

  async createPasswordResetToken(userId: string): Promise<string> {
    const token = randomUUID() + randomUUID();
    await this.q(
      `INSERT INTO password_reset_tokens(token, user_id) VALUES ($1, $2)`,
      [token, userId]
    );
    return token;
  }

  async validatePasswordResetToken(token: string): Promise<string | null> {
    const rows = await this.q<{ userId: string }>(
      `SELECT user_id AS "userId" FROM password_reset_tokens
       WHERE token = $1 AND expires_at > now() AND used_at IS NULL`,
      [token]
    );
    return rows[0]?.userId ?? null;
  }

  async usePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean> {
    const userId = await this.validatePasswordResetToken(token);
    if (!userId) return false;
    await this.q(`UPDATE issuance_users SET password_hash = $1 WHERE id = $2`, [newPasswordHash, userId]);
    await this.q(`UPDATE password_reset_tokens SET used_at = now() WHERE token = $1`, [token]);
    // Invalidate all sessions for security
    await this.q(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
    return true;
  }

  async createEmailVerificationToken(userId: string): Promise<string> {
    const token = randomUUID() + randomUUID();
    await this.q(
      `INSERT INTO email_verification_tokens(token, user_id) VALUES ($1, $2)`,
      [token, userId]
    );
    return token;
  }

  async verifyEmailToken(token: string): Promise<boolean> {
    const rows = await this.q<{ userId: string }>(
      `SELECT user_id AS "userId" FROM email_verification_tokens
       WHERE token = $1 AND expires_at > now() AND used_at IS NULL`,
      [token]
    );
    const userId = rows[0]?.userId;
    if (!userId) return false;
    await this.q(`UPDATE issuance_users SET email_verified = TRUE WHERE id = $1`, [userId]);
    await this.q(`UPDATE email_verification_tokens SET used_at = now() WHERE token = $1`, [token]);
    return true;
  }

  async isEmailVerified(userId: string): Promise<boolean> {
    const rows = await this.q<{ emailVerified: boolean }>(
      `SELECT email_verified AS "emailVerified" FROM issuance_users WHERE id = $1`,
      [userId]
    );
    return rows[0]?.emailVerified ?? false;
  }

  async recordLoginAttempt(email: string, ip: string, success: boolean): Promise<void> {
    await this.q(
      `INSERT INTO login_attempts(email, ip, success) VALUES ($1, $2, $3)`,
      [email, ip, success]
    );
  }

  async countRecentFailedLogins(email: string, ip: string, sinceMinutes: number): Promise<number> {
    const rows = await this.q<{ count: string }>(
      `SELECT COUNT(*) as count FROM login_attempts
       WHERE (lower(email) = lower($1) OR ip = $2)
       AND success = FALSE
       AND created_at > now() - ($3 || ' minutes')::INTERVAL`,
      [email, ip, String(sinceMinutes)]
    );
    return parseInt(rows[0]?.count || "0", 10);
  }
}

class MemoryAuthStore implements AuthStore {
  private accounts = new Map<string, AuthAccount & { passwordHash: string | null }>(); // by id
  private byEmail = new Map<string, string>(); // lower(email) -> id
  private sessions = new Map<string, { userId: string; expiresAt: string }>();

  async createAccount(email: string, passwordHash: string, name?: string): Promise<AuthAccount> {
    const id = randomUUID();
    const acc = { id, email, name: name ?? null, passwordHash, createdAt: new Date().toISOString() };
    this.accounts.set(id, acc);
    this.byEmail.set(email.toLowerCase(), id);
    return acc;
  }

  async findByEmail(email: string) {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.accounts.get(id) ?? null : null;
  }

  async findById(id: string) {
    return this.accounts.get(id) ?? null;
  }

  async createSession(userId: string) {
    const token = randomUUID() + randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.sessions.set(token, { userId, expiresAt });
    return { token, expiresAt };
  }

  async getSession(token: string) {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  async deleteSession(token: string) {
    this.sessions.delete(token);
  }

  private resetTokens = new Map<string, { userId: string; expiresAt: number; used: boolean }>();
  private verifyTokens = new Map<string, { userId: string; expiresAt: number; used: boolean }>();
  private verifiedEmails = new Set<string>();
  private loginAttempts: Array<{ email: string; ip: string; success: boolean; at: number }> = [];

  async createPasswordResetToken(userId: string): Promise<string> {
    const token = randomUUID() + randomUUID();
    this.resetTokens.set(token, { userId, expiresAt: Date.now() + 3600000, used: false });
    return token;
  }

  async validatePasswordResetToken(token: string): Promise<string | null> {
    const t = this.resetTokens.get(token);
    if (!t || t.used || t.expiresAt <= Date.now()) return null;
    return t.userId;
  }

  async usePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean> {
    const userId = await this.validatePasswordResetToken(token);
    if (!userId) return false;
    const acc = this.accounts.get(userId);
    if (acc) acc.passwordHash = newPasswordHash;
    this.resetTokens.get(token)!.used = true;
    // Invalidate sessions
    for (const [tok, s] of this.sessions) {
      if (s.userId === userId) this.sessions.delete(tok);
    }
    return true;
  }

  async createEmailVerificationToken(userId: string): Promise<string> {
    const token = randomUUID() + randomUUID();
    this.verifyTokens.set(token, { userId, expiresAt: Date.now() + 86400000, used: false });
    return token;
  }

  async verifyEmailToken(token: string): Promise<boolean> {
    const t = this.verifyTokens.get(token);
    if (!t || t.used || t.expiresAt <= Date.now()) return false;
    this.verifiedEmails.add(t.userId);
    t.used = true;
    return true;
  }

  async isEmailVerified(userId: string): Promise<boolean> {
    return this.verifiedEmails.has(userId);
  }

  async recordLoginAttempt(email: string, ip: string, success: boolean): Promise<void> {
    this.loginAttempts.push({ email: email.toLowerCase(), ip, success, at: Date.now() });
    // Keep only last 1000
    if (this.loginAttempts.length > 1000) this.loginAttempts = this.loginAttempts.slice(-1000);
  }

  async countRecentFailedLogins(email: string, ip: string, sinceMinutes: number): Promise<number> {
    const cutoff = Date.now() - sinceMinutes * 60000;
    const e = email.toLowerCase();
    return this.loginAttempts.filter(
      (a) => !a.success && a.at > cutoff && (a.email === e || a.ip === ip)
    ).length;
  }
}

let storeInstance: AuthStore = new MemoryAuthStore();
let storePromise: Promise<AuthStore> | null = null;

async function getStoreAsync(): Promise<AuthStore> {
  if ((process.env.DATABASE_URL ?? "").trim()) {
    try {
      await getPool().query("SELECT 1");
      return new PgAuthStore();
    } catch {
      return storeInstance; // Postgres configured but unreachable — fall back
    }
  }
  return storeInstance;
}

function store(): Promise<AuthStore> {
  if (!storePromise) {
    storePromise = getStoreAsync().then((s) => {
      storeInstance = s;
      return s;
    });
  }
  return storePromise;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface AuthMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface AuthCtx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  query: URLSearchParams;
  body: unknown;
}

function asRecord(body: unknown): Record<string, unknown> {
  return (body !== null && typeof body === "object" && !Array.isArray(body))
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bearerToken(ctx: AuthCtx): string | null {
  const header = ctx.req.headers["authorization"];
  const h = Array.isArray(header) ? header[0] : header;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim() || null;
}

function clientIp(ctx: AuthCtx): string {
  const h = ctx.req.headers;
  const fwd = h["x-forwarded-for"] ?? h["x-real-ip"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof first === "string" && first) return first.split(",")[0].trim();
  return "unknown";
}

// Shared session resolver for other route modules (issuance, marketplace).
// Returns the authenticated userId for a valid Bearer token, or null when the
// token is missing, malformed, expired, or unknown. Private routes must derive
// the userId from this — never from a client-supplied body/query value.
export async function resolveBearerUserId(
  headers: Record<string, string | string[] | undefined>
): Promise<string | null> {
  const header = headers["authorization"];
  const h = Array.isArray(header) ? header[0] : header;
  if (!h || !h.startsWith("Bearer ")) return null;
  const token = h.slice("Bearer ".length).trim();
  if (!token) return null;
  const s = await store();
  const session = await s.getSession(token);
  return session ? session.userId : null;
}

export function mountAuthRoutes(deps: AuthMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError;

  const fail = (ctx: AuthCtx, err: unknown): void => {
    const e = err as { statusCode?: number; code?: string };
    const statusCode = e.statusCode ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { error: code, message });
  };

  const accountPayload = (acc: { id: string; email: string; name: string | null }) => ({
    userId: acc.id,
    email: acc.email,
    name: acc.name,
  });

  // --- POST /api/v1/auth/signup ---
  route("POST", "/api/v1/auth/signup", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const email = str(body.email).trim().toLowerCase();
      const password = str(body.password);
      const name = str(body.name).trim().slice(0, 80) || undefined;

      if (!EMAIL_RE.test(email)) {
        throw new HttpError(422, "invalid_email", "Enter a valid email address.");
      }
      if (password.length < 8) {
        throw new HttpError(422, "weak_password", "Password must be at least 8 characters.");
      }

      const s = await store();
      const existing = await s.findByEmail(email);
      if (existing && existing.passwordHash) {
        throw new HttpError(409, "account_exists", "An account with that email already exists — log in instead.");
      }

      // A row may already exist for this email with no password (created
      // anonymously via ensureUser() when a draft was started before ever
      // signing up) — claim it instead of failing on the email being taken.
      let account: { id: string; email: string; name: string | null };
      if (existing) {
        const pool = getPool();
        await pool.query(
          `UPDATE issuance_users SET password_hash = $1, name = COALESCE($2, name) WHERE id = $3`,
          [hashPassword(password), name ?? null, existing.id]
        );
        account = { id: existing.id, email: existing.email, name: name ?? existing.name };
      } else {
        account = await s.createAccount(email, hashPassword(password), name);
      }

      const session = await s.createSession(account.id);
      // Generate email verification token (in production, this would be emailed)
      const verificationToken = await s.createEmailVerificationToken(account.id);
      sendJson(ctx.res, 201, {
        ...accountPayload(account),
        token: session.token,
        expiresAt: session.expiresAt,
        verificationToken,
        emailVerified: false,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/login ---
  route("POST", "/api/v1/auth/login", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const email = str(body.email).trim().toLowerCase();
      const password = str(body.password);
      if (!email || !password) {
        throw new HttpError(400, "missing_credentials", "email and password are required.");
      }

      const s = await store();
      // Rate limiting: max 10 failed attempts per 15 min per email/IP.
      const ip = clientIp(ctx);
      const failedCount = await s.countRecentFailedLogins(email, ip, 15);
      if (failedCount >= 10) {
        throw new HttpError(429, "too_many_attempts", "Too many failed login attempts. Please wait 15 minutes and try again.");
      }

      const account = await s.findByEmail(email);
      // Same generic error whether the email is unknown or the password is
      // wrong — don't reveal which one to an attacker.
      if (!account || !account.passwordHash || !verifyPassword(password, account.passwordHash)) {
        await s.recordLoginAttempt(email, ip, false);
        throw new HttpError(401, "invalid_credentials", "No account found for that email and password.");
      }

      await s.recordLoginAttempt(email, ip, true);
      const session = await s.createSession(account.id);
      sendJson(ctx.res, 200, { ...accountPayload(account), token: session.token, expiresAt: session.expiresAt });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/auth/me ---
  // Called on app launch to silently restore a session (or find out it's
  // expired/invalid) without asking the person to type their password again.
  route("GET", "/api/v1/auth/me", async (ctx) => {
    try {
      const token = bearerToken(ctx);
      if (!token) throw new HttpError(401, "missing_token", "Provide an Authorization: Bearer <token> header.");
      const s = await store();
      const session = await s.getSession(token);
      if (!session) throw new HttpError(401, "invalid_session", "Session expired or invalid — please log in again.");
      const account = await s.findById(session.userId);
      if (!account) throw new HttpError(401, "invalid_session", "Account no longer exists.");
      sendJson(ctx.res, 200, accountPayload(account));
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/logout ---
  route("POST", "/api/v1/auth/logout", async (ctx) => {
    try {
      const token = bearerToken(ctx);
      if (token) {
        const s = await store();
        await s.deleteSession(token);
      }
      sendJson(ctx.res, 200, { ok: true });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/forgot-password ---
  // Generates a password reset token. In production this would be emailed;
  // for now the token is returned so the app can display it (dev mode).
  route("POST", "/api/v1/auth/forgot-password", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const email = str(body.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        throw new HttpError(422, "invalid_email", "Enter a valid email address.");
      }
      const s = await store();
      const account = await s.findByEmail(email);
      // Always return success to avoid revealing whether the email exists.
      if (account && account.passwordHash) {
        const token = await s.createPasswordResetToken(account.id);
        sendJson(ctx.res, 200, { ok: true, resetToken: token, message: "If an account exists for this email, a reset token was generated." });
      } else {
        sendJson(ctx.res, 200, { ok: true, message: "If an account exists for this email, a reset token was generated." });
      }
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/reset-password ---
  route("POST", "/api/v1/auth/reset-password", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const token = str(body.token).trim();
      const password = str(body.password);
      if (!token) throw new HttpError(400, "missing_token", "Reset token is required.");
      if (password.length < 8) {
        throw new HttpError(422, "weak_password", "Password must be at least 8 characters.");
      }
      const s = await store();
      const ok = await s.usePasswordResetToken(token, hashPassword(password));
      if (!ok) throw new HttpError(400, "invalid_token", "Reset token is invalid or expired.");
      sendJson(ctx.res, 200, { ok: true, message: "Password has been reset. Please log in with your new password." });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/verify-email ---
  route("POST", "/api/v1/auth/verify-email", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const token = str(body.token).trim();
      if (!token) throw new HttpError(400, "missing_token", "Verification token is required.");
      const s = await store();
      const ok = await s.verifyEmailToken(token);
      if (!ok) throw new HttpError(400, "invalid_token", "Verification token is invalid or expired.");
      sendJson(ctx.res, 200, { ok: true, message: "Email verified successfully." });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/auth/resend-verification ---
  // Requires auth — resends verification token for the logged-in user.
  route("POST", "/api/v1/auth/resend-verification", async (ctx) => {
    try {
      const userId = await resolveBearerUserId(ctx.req.headers);
      if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
      const s = await store();
      if (await s.isEmailVerified(userId)) {
        sendJson(ctx.res, 200, { ok: true, message: "Email is already verified." });
        return;
      }
      const token = await s.createEmailVerificationToken(userId);
      sendJson(ctx.res, 200, { ok: true, verificationToken: token });
    } catch (err) { fail(ctx, err); }
  });
}
