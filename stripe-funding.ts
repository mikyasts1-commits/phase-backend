/**
 * ============================================================================
 *  PHASE PROTOCOL — Stripe Fiat Funding (LIVE MODE)
 * ============================================================================
 *
 *  Card/fiat funding rail for Phase accounts via Stripe. Live mode in
 *  production — real money moves. Uses Stripe's REST API directly
 *  (global fetch, form-encoded bodies) — no npm packages.
 *
 *  WHAT THIS DOES
 *    - Creates Stripe PaymentIntents for account funding
 *      (e.g. fund $50 CAD by card).
 *    - Records each intent in the funding ledger (kind='fiat_deposit',
 *      status pending -> confirmed). Idempotent on the PaymentIntent id:
 *      one intent credits at most once.
 *    - Confirm endpoint polls Stripe; when the intent reaches `succeeded`,
 *      the ledger entry flips to confirmed + verified, which is what the
 *      fiat-balances endpoint sums.
 *    - Fiat balances endpoint reports credited vs pending per currency.
 *    - Webhook endpoint (/api/v1/stripe/webhooks) receives Stripe events,
 *      verifies the HMAC signature, and credits/fails ledger entries —
 *      push-based confirmation so the app doesn't poll.
 *
 *  WHAT'S REAL vs WHAT'S SIMULATED
 *    - Stripe API calls are REAL. In production the configured key is a
 *      live key (sk_live_*); every response carries explicit
 *      testmode/livemode flags so clients can tell which mode applied.
 *    - The funding ledger is persisted to Postgres (see db.ts and
 *      db/migrations/005_stripe_fiat.sql). Ledger crediting follows the
 *      same confirmed + verified rule as the crypto funding rail.
 *
 *  SAFETY — strict environment separation
 *    - Production accepts ONLY live secret keys (sk_live_*); every other
 *      environment accepts ONLY test keys (sk_test_*). A mismatched key
 *      is refused outright — real cards can never be charged from a
 *      non-production build, and test traffic can never silently run
 *      as production.
 *
 *  ENV VARS
 *    STRIPE_SECRET_KEY       Stripe secret key — sk_live_* in production,
 *                            sk_test_* elsewhere. Absent or mismatched ->
 *                            all Stripe routes return 503
 *                            `stripe_not_configured`; nothing is faked.
 *    STRIPE_WEBHOOK_SECRET   Webhook endpoint secret (whsec_*). Required
 *                            for /api/v1/stripe/webhooks; absent -> 503.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { dbQuery, dbQueryOne } from "./db.js";
import { resolveBearerUserId } from "./auth.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import { auditLog } from "./sovereign-ledger-core.js";

interface MountDeps {
  route: (method: string, path: string, handler: (ctx: RouteContext) => void | Promise<void>) => void;
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  rawBody?: Buffer;
}

const STRIPE_API = "https://api.stripe.com";

/** Ledger network label for Stripe deposits: mainnet for live keys, testnet otherwise. */
function stripeNetworkLabel(): string {
  return stripeModeFlags().livemode ? "mainnet" : "testnet";
}

/** True when running as the production deployment. */
function isProduction(): boolean {
  return (process.env.PHASE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

/** Response flags describing whether the configured Stripe key is a live key. */
function stripeModeFlags(): { testmode: boolean; livemode: boolean } {
  const live = (process.env.STRIPE_SECRET_KEY ?? "").trim().startsWith("sk_live_");
  return { testmode: !live, livemode: live };
}

function getSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  // Strict environment separation: production accepts ONLY live keys
  // (sk_live_*); every other environment accepts ONLY test keys (sk_test_*).
  // A test key in production (or a live key in dev) is refused outright so
  // real cards can never be charged from a non-production build and test
  // traffic can never silently run as production.
  if (isProduction()) {
    if (!key.startsWith("sk_live_")) return null;
  } else {
    if (!key.startsWith("sk_test_")) return null;
  }
  return key;
}

function stripeError(deps: MountDeps, ctx: RouteContext): boolean {
  if (getSecretKey()) return false;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const reason = !key ? "STRIPE_SECRET_KEY is not set"
    : isProduction()
      ? "production requires a live key (sk_live_*); test keys are refused"
      : "only test-mode keys (sk_test_*) are accepted outside production; live keys are refused";
  deps.sendJson(ctx.res, 503, {
    error: "stripe_not_configured",
    message: reason,
    ...stripeModeFlags(),
  });
  return true;
}

async function stripeApi(
  method: string,
  path: string,
  params?: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ status: number; data: unknown }> {
  const key = getSecretKey();
  if (!key) throw new Error("stripe_not_configured");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": "2025-08-27.basil",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let url = STRIPE_API + path;
  let body: string | undefined;
  if (method === "GET" && params) {
    url += "?" + new URLSearchParams(params).toString();
  } else if (params) {
    body = new URLSearchParams(params).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const resp = await fetch(url, { method, headers, body });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// --- webhook signature verification --------------------------------------
// Stripe signs webhooks as: stripe-signature: t=<unix_ts>,v1=<hex_hmac>
// Signed payload is "<ts>.<raw_body>", HMAC-SHA256 with the endpoint secret
// (whsec_...). Timestamp must be within 5 minutes to block replays.

function getWebhookSecret(): string | null {
  const s = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return s && s.startsWith("whsec_") ? s : null;
}

function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const parts: Record<string, string> = {};
  for (const seg of signatureHeader.split(",")) {
    const [k, v] = seg.split("=", 2);
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  // 5-minute tolerance against replay attacks.
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const signed = `${ts}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(signed, "utf8").digest("hex");
  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function dbMarkWebhookSeen(notificationId: string): Promise<boolean> {
  const rows = await dbQuery<{ notification_id: string }>(
    "INSERT INTO webhook_dedup (notification_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING notification_id",
    [notificationId],
  );
  return rows.length > 0;
}

// --- ledger ---------------------------------------------------------------
// Fiat deposits live in ledger_entries with kind='fiat_deposit'. The
// stripe_payment_intent_id unique index makes inserts idempotent: a repeated
// call for the same PaymentIntent returns the existing row.

interface FiatLedgerEntry {
  id: string;
  user_id: string;
  amount: string; // minor units, as text
  currency: string;
  stripe_payment_intent_id: string;
  status: string;
  verified: boolean;
}

async function insertFiatLedgerEntry(args: {
  userId: string;
  amountMinor: number;
  currency: string; // lowercase ISO
  paymentIntentId: string;
}): Promise<{ entry: FiatLedgerEntry; created: boolean }> {
  const idempotencyKey = `stripe:${args.paymentIntentId}`;
  const id = randomUUID();
  const rows = await dbQuery<FiatLedgerEntry>(
    `INSERT INTO ledger_entries
       (id, user_id, kind, chain, amount, currency, status, verified,
        idempotency_key, network, stripe_payment_intent_id, note)
     VALUES ($1, $2, 'fiat_deposit', 'stripe', $3, $4, 'pending', false,
             $5, $6, $7, 'Stripe deposit')
     ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL DO NOTHING
     RETURNING id, user_id, amount, currency, stripe_payment_intent_id, status, verified`,
    [id, args.userId, String(args.amountMinor), args.currency.toUpperCase(),
     idempotencyKey, stripeNetworkLabel(), args.paymentIntentId],
  );
  if (rows.length > 0) return { entry: rows[0], created: true };
  const existing = await dbQueryOne<FiatLedgerEntry>(
    `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
     FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
    [args.paymentIntentId],
  );
  if (!existing) throw new Error("ledger insert failed: no row returned and no existing entry found");
  return { entry: existing, created: false };
}

async function confirmFiatLedgerEntry(paymentIntentId: string): Promise<FiatLedgerEntry | null> {
  const rows = await dbQuery<FiatLedgerEntry>(
    `UPDATE ledger_entries
     SET status = 'confirmed', verified = true, updated_at = now()
     WHERE stripe_payment_intent_id = $1 AND status <> 'confirmed'
     RETURNING id, user_id, amount, currency, stripe_payment_intent_id, status, verified`,
    [paymentIntentId],
  );
  if (rows.length > 0) return rows[0];
  return dbQueryOne<FiatLedgerEntry>(
    `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
     FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
}

async function failFiatLedgerEntry(paymentIntentId: string): Promise<FiatLedgerEntry | null> {
  const rows = await dbQuery<FiatLedgerEntry>(
    `UPDATE ledger_entries
     SET status = 'failed', updated_at = now()
     WHERE stripe_payment_intent_id = $1 AND status IN ('pending', 'confirming')
     RETURNING id, user_id, amount, currency, stripe_payment_intent_id, status, verified`,
    [paymentIntentId],
  );
  if (rows.length > 0) return rows[0];
  return dbQueryOne<FiatLedgerEntry>(
    `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
     FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
}

// The userId for private routes ALWAYS comes from the authenticated Bearer
// session. A client-supplied userId in the body/query is never trusted: if
// one is present and disagrees with the session, the request is rejected.
async function requireUserId(
  ctx: { req: { headers: Record<string, string | string[] | undefined> }; query: URLSearchParams; body: unknown },
  HttpError: new (statusCode: number, code: string, message: string) => Error,
): Promise<string> {
  const authed = await resolveBearerUserId(ctx.req.headers);
  if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
  const body = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body : {}) as Record<string, unknown>;
  const claimed = (typeof body.userId === "string" ? body.userId : null) || ctx.query.get("userId");
  if (claimed && claimed !== authed) {
    throw new HttpError(403, "forbidden", "This request is for a different user.");
  }
  return authed;
}

function requireBodyObject(
  body: unknown,
  HttpError: new (statusCode: number, code: string, message: string) => Error,
): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new HttpError(400, "bad_request", "JSON object body required");
}

export function mountStripeRoutes(deps: MountDeps): void {
  const ipOf = (ctx: RouteContext): string => clientIpFromHeaders(ctx.req.headers);
  const limit = (key: string): void => {
    if (!checkRateLimit(key, 20, 60_000)) {
      throw new deps.HttpError(429, "rate_limited", "Too many funding requests — wait a minute and try again.");
    }
  };

  // --- Status: configured? test mode? ---
  deps.route("GET", "/api/v1/stripe/status", (ctx) => {
    limit(`stripe:status:${ipOf(ctx)}`);
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    deps.sendJson(ctx.res, 200, {
      configured: !!getSecretKey(),
      ...stripeModeFlags(),
      key_present: !!key,
      key_is_test: key?.startsWith("sk_test_") ?? false,
      key_is_live: key?.startsWith("sk_live_") ?? false,
      note: !key ? undefined
        : isProduction() && !key.startsWith("sk_live_")
          ? "production requires a live key (sk_live_*); this key is refused"
          : !isProduction() && !key.startsWith("sk_test_")
            ? "only test keys (sk_test_*) are accepted outside production; this key is refused"
            : undefined,
    });
  });

  // --- Create a PaymentIntent (+ ledger entry) ---
  deps.route("POST", "/api/v1/stripe/payment-intents", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    const b = requireBodyObject(ctx.body, deps.HttpError);
    const userId = await requireUserId(ctx, deps.HttpError);
    limit(`stripe:pi:create:${userId}`);
    const amount = Number(b.amount);
    const currency = String(b.currency ?? "cad").toLowerCase();
    if (!Number.isInteger(amount) || amount < 50) {
      throw new deps.HttpError(400, "bad_amount", "`amount` must be an integer >= 50 (minor units, e.g. cents)");
    }
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new deps.HttpError(400, "bad_currency", "`currency` must be a 3-letter ISO code");
    }
    const idemHeader = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
    const idemKey = (Array.isArray(idemHeader) ? idemHeader[0] : idemHeader)?.trim()
      || (typeof b.idempotencyKey === "string" && b.idempotencyKey.trim())
      || randomUUID();
    const params: Record<string, string> = {
      amount: String(amount),
      currency,
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
    };
    params["metadata[phase_idempotency_key]"] = idemKey;
    if (b.description) params.description = String(b.description).slice(0, 200);
    if (b.metadata && typeof b.metadata === "object") {
      for (const [k, v] of Object.entries(b.metadata as Record<string, unknown>)) {
        // Reserved keys are always authoritative from the session, never
        // from the client.
        if (k === "phase_user_id" || k === "phase_idempotency_key") continue;
        params[`metadata[${k}]`] = String(v).slice(0, 200);
      }
    }
    params["metadata[phase_user_id]"] = userId;
    const { status, data } = await stripeApi("POST", "/v1/payment_intents", params, idemKey);
    const d = data as Record<string, unknown>;
    let ledger: FiatLedgerEntry | null = null;
    let ledgerCreated = false;
    if (status < 400 && typeof d.id === "string") {
      try {
        const r = await insertFiatLedgerEntry({
          userId,
          amountMinor: amount,
          currency,
          paymentIntentId: d.id,
        });
        ledger = r.entry;
        ledgerCreated = r.created;
      } catch (err) {
        // Ledger write failed: surface it, don't silently credit later.
        // The PaymentIntent exists at Stripe; confirm will retry the insert.
        console.warn(`[stripe] ledger insert failed for ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (status < 400 && typeof d.id === "string") {
      await auditLog(userId, "stripe_pi_created", "stripe_payment_intent", d.id,
        { amountMinor: amount, currency, ledgerCreated });
    }
    deps.sendJson(ctx.res, status, {
      ...stripeModeFlags(),
      id: d.id,
      client_secret: d.client_secret,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      ledger: ledger ? {
        id: ledger.id,
        status: ledger.status,
        verified: ledger.verified,
        created: ledgerCreated,
      } : null,
      ...(status >= 400 ? { stripe_error: d.error } : {}),
    });
  });

  // --- Retrieve a PaymentIntent (poll for confirmation) ---
  deps.route("GET", "/api/v1/stripe/payment-intents/:id", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    limit(`stripe:pi:get:${ipOf(ctx)}`);
    const id = ctx.params.id;
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) {
      throw new deps.HttpError(400, "bad_id", "Invalid PaymentIntent id");
    }
    const { status, data } = await stripeApi("GET", `/v1/payment_intents/${id}`);
    const d = data as Record<string, unknown>;
    deps.sendJson(ctx.res, status, {
      ...stripeModeFlags(),
      id: d.id,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      amount_received: d.amount_received,
      ...(status >= 400 ? { stripe_error: d.error } : {}),
    });
  });

  // --- Confirm: poll Stripe, credit the ledger when the intent succeeds ---
  // Idempotent: confirming an already-confirmed intent is a no-op.
  deps.route("POST", "/api/v1/stripe/payment-intents/:id/confirm", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    limit(`stripe:pi:confirm:${ipOf(ctx)}`);
    const id = ctx.params.id;
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) {
      throw new deps.HttpError(400, "bad_id", "Invalid PaymentIntent id");
    }
    const { status, data } = await stripeApi("GET", `/v1/payment_intents/${id}`);
    const d = data as Record<string, unknown>;
    if (status >= 400) {
      deps.sendJson(ctx.res, status, {
        ...stripeModeFlags(),
        id,
        stripe_error: d.error,
      });
      return;
    }
    let ledger: FiatLedgerEntry | null = null;
    if (d.status === "succeeded") {
      // Ensure a ledger entry exists (creation may have failed earlier).
      const meta = (d.metadata ?? {}) as Record<string, unknown>;
      const metaUser = typeof meta.phase_user_id === "string" ? meta.phase_user_id : null;
      const existing = await dbQueryOne<FiatLedgerEntry>(
        `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
         FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
        [id],
      );
      if (!existing && metaUser && typeof d.amount === "number" && typeof d.currency === "string") {
        const r = await insertFiatLedgerEntry({
          userId: metaUser,
          amountMinor: d.amount,
          currency: d.currency,
          paymentIntentId: id,
        });
        ledger = r.entry;
      }
      ledger = await confirmFiatLedgerEntry(id);
      if (ledger) {
        await auditLog(ledger.user_id ?? metaUser ?? "unknown", "stripe_pi_confirmed",
          "stripe_payment_intent", id, { ledgerId: ledger.id, status: ledger.status });
      }
    } else {
      ledger = await dbQueryOne<FiatLedgerEntry>(
        `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
         FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
        [id],
      );
    }
    deps.sendJson(ctx.res, 200, {
      ...stripeModeFlags(),
      id: d.id,
      stripe_status: d.status,
      amount_received: d.amount_received,
      credited: d.status === "succeeded",
      ledger: ledger ? {
        id: ledger.id,
        status: ledger.status,
        verified: ledger.verified,
      } : null,
    });
  });

  // --- Fiat balances: credited vs pending per currency ---
  deps.route("GET", "/api/v1/stripe/balances", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    const userId = await requireUserId(ctx, deps.HttpError);
    limit(`stripe:balances:${userId}`);
    const rows = await dbQuery<{ currency: string; status: string; verified: boolean; total: string }>(
      `SELECT currency, status, verified, SUM(amount::numeric)::text AS total
       FROM ledger_entries
       WHERE user_id = $1 AND kind = 'fiat_deposit'
       GROUP BY currency, status, verified`,
      [userId],
    );
    const totals: Record<string, { credited: string; pending: string }> = {};
    for (const r of rows) {
      const bucket = (totals[r.currency] ??= { credited: "0", pending: "0" });
      if (r.status === "confirmed" && r.verified) {
        bucket.credited = String(BigInt(bucket.credited) + BigInt(r.total));
      } else if (r.status === "pending" || r.status === "confirming") {
        bucket.pending = String(BigInt(bucket.pending) + BigInt(r.total));
      }
    }
    deps.sendJson(ctx.res, 200, {
      ...stripeModeFlags(),
      userId,
      totals, // minor units per currency, e.g. { CAD: { credited: "5000", pending: "0" } }
      note: "credited = confirmed + verified fiat deposits only. Amounts are in minor units (cents).",
    });
  });

  // --- POST /api/v1/stripe/webhooks — Stripe event notifications ---
  // Verifies the Stripe signature (fail-closed: no secret -> 503, bad
  // signature -> 401, ledger untouched). Handles:
  //   payment_intent.succeeded      -> confirm + verify the ledger entry
  //   payment_intent.payment_failed -> mark the ledger entry failed
  //   payment_intent.canceled       -> mark the ledger entry failed
  // Idempotent on the Stripe event id via webhook_dedup.
  deps.route("POST", "/api/v1/stripe/webhooks", async (ctx) => {
    limit(`stripe:webhook:${ipOf(ctx)}`);
    const secret = getWebhookSecret();
    if (!secret) {
      deps.sendJson(ctx.res, 503, {
        error: "stripe_webhook_not_configured",
        message: "STRIPE_WEBHOOK_SECRET is not set; webhooks are refused until it is.",
        ...stripeModeFlags(),
      });
      return;
    }
    const rawBody: Buffer | undefined = (ctx as { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new deps.HttpError(400, "webhook_no_raw_body", "Raw request body is required for signature verification.");
    }
    const sigHeader = ctx.req.headers["stripe-signature"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!sig || !verifyStripeSignature(rawBody, sig, secret)) {
      throw new deps.HttpError(401, "webhook_bad_signature", "Stripe webhook signature could not be verified. Ledger untouched.");
    }
    const event = (ctx.body ?? {}) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    const eventId = typeof event.id === "string" ? event.id : null;
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventId) {
      const fresh = await dbMarkWebhookSeen(`stripe:${eventId}`);
      if (!fresh) {
        deps.sendJson(ctx.res, 200, { ...stripeModeFlags(), received: true, action: "duplicate_ignored", event_id: eventId });
        return;
      }
    }
    const obj = event.data?.object ?? {};
    const piId = typeof obj.id === "string" && obj.id.startsWith("pi_") ? obj.id : null;
    let action = "ignored";
    let ledger: FiatLedgerEntry | null = null;
    if (piId) {
      if (eventType === "payment_intent.succeeded") {
        // Ensure a ledger entry exists (may predate the ledger integration).
        const existing = await dbQueryOne<FiatLedgerEntry>(
          `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
           FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
          [piId],
        );
        if (!existing) {
          const meta = (obj.metadata ?? {}) as Record<string, unknown>;
          const metaUser = typeof meta.phase_user_id === "string" ? meta.phase_user_id : null;
          if (metaUser && typeof obj.amount === "number" && typeof obj.currency === "string") {
            const r = await insertFiatLedgerEntry({
              userId: metaUser,
              amountMinor: obj.amount,
              currency: obj.currency,
              paymentIntentId: piId,
            });
            ledger = r.entry;
          }
        }
        ledger = await confirmFiatLedgerEntry(piId);
        action = "credited";
      } else if (eventType === "payment_intent.payment_failed" || eventType === "payment_intent.canceled") {
        ledger = await failFiatLedgerEntry(piId);
        action = "marked_failed";
      }
    }
    await auditLog("stripe", "stripe_webhook", "stripe_event", eventId ?? undefined,
      { eventType, action, paymentIntentId: piId, ledgerId: ledger?.id ?? null });
    deps.sendJson(ctx.res, 200, {
      ...stripeModeFlags(),
      received: true,
      action,
      event_id: eventId,
      event_type: eventType,
      ledger: ledger ? { id: ledger.id, status: ledger.status, verified: ledger.verified } : null,
    });
  });
}
