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
      sendJson(ctx.res, 201, { ...accountPayload(account), token: session.token, expiresAt: session.expiresAt });
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
      const account = await s.findByEmail(email);
      // Same generic error whether the email is unknown or the password is
      // wrong — don't reveal which one to an attacker.
      if (!account || !account.passwordHash || !verifyPassword(password, account.passwordHash)) {
        throw new HttpError(401, "invalid_credentials", "No account found for that email and password.");
      }

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
}
