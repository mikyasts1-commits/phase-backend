/**
 * ============================================================================
 *  PHASE PROTOCOL — Stripe Fiat Funding (TEST MODE ONLY)
 * ============================================================================
 *
 *  Card/fiat funding rail for Phase accounts via Stripe. Test mode only —
 *  no real money moves. Uses Stripe's REST API directly (global fetch,
 *  form-encoded bodies) — no npm packages.
 *
 *  WHAT THIS DOES
 *    - Creates Stripe PaymentIntents in TEST mode for account funding
 *      (e.g. fund $50 CAD via test card 4242 4242 4242 4242).
 *    - Records each intent in the funding ledger (kind='fiat_deposit',
 *      status pending -> confirmed). Idempotent on the PaymentIntent id:
 *      one intent credits at most once.
 *    - Confirm endpoint polls Stripe; when the intent reaches `succeeded`,
 *      the ledger entry flips to confirmed + verified, which is what the
 *      fiat-balances endpoint sums.
 *    - Fiat balances endpoint reports credited vs pending per currency.
 *
 *  WHAT'S REAL vs WHAT'S SIMULATED
 *    - Stripe API calls are REAL (test mode — Stripe's sandbox, no real
 *      charges). Every response carries an explicit TESTMODE label.
 *    - The funding ledger is persisted to Postgres (see db.ts and
 *      db/migrations/005_stripe_fiat.sql). Ledger crediting follows the
 *      same confirmed + verified rule as the crypto funding rail.
 *
 *  SAFETY — test mode is the only mode
 *    - The module REFUSES to boot with a live secret key (sk_live_*).
 *      Only sk_test_* is accepted. There is no override flag.
 *    - Live payments require: a reviewed production deployment, FINTRAC
 *      MSB analysis, and Mikyas's explicit approval. None of that exists
 *      yet — do not add a live-mode bypass to this file.
 *
 *  ENV VARS
 *    STRIPE_SECRET_KEY       Stripe test secret key (sk_test_*). Absent or
 *                            live -> all Stripe routes return 503
 *                            `stripe_not_configured`; nothing is faked.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dbQuery, dbQueryOne } from "./db.js";

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

function getSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!key.startsWith("sk_test_")) return null; // live keys refused, no override
  return key;
}

function stripeError(deps: MountDeps, ctx: RouteContext): boolean {
  if (getSecretKey()) return false;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const reason = !key ? "STRIPE_SECRET_KEY is not set"
    : "only test-mode keys (sk_test_*) are accepted; live keys are refused";
  deps.sendJson(ctx.res, 503, {
    error: "stripe_not_configured",
    message: reason,
    testmode: true,
  });
  return true;
}

async function stripeApi(
  method: string,
  path: string,
  params?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const key = getSecretKey();
  if (!key) throw new Error("stripe_not_configured");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": "2025-08-27.basil",
  };
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
             $5, 'testnet', $6, 'Stripe test-mode deposit')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING
     RETURNING id, user_id, amount, currency, stripe_payment_intent_id, status, verified`,
    [id, args.userId, String(args.amountMinor), args.currency.toUpperCase(),
     idempotencyKey, args.paymentIntentId],
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

function requireUserId(
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
  HttpError: new (statusCode: number, code: string, message: string) => Error,
): string {
  const v = query.get("userId") ?? (typeof body?.userId === "string" ? body.userId : null);
  if (!v || !v.trim()) {
    throw new HttpError(400, "missing_user_id", "userId is required (query param or JSON body).");
  }
  return v.trim();
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
  // --- Status: configured? test mode? ---
  deps.route("GET", "/api/v1/stripe/status", (ctx) => {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    deps.sendJson(ctx.res, 200, {
      configured: !!getSecretKey(),
      testmode: true,
      livemode: false,
      key_present: !!key,
      key_is_test: key?.startsWith("sk_test_") ?? false,
      note: key && !key.startsWith("sk_test_")
        ? "live key detected and refused — only sk_test_* accepted"
        : undefined,
    });
  });

  // --- Create a test PaymentIntent (+ ledger entry) ---
  deps.route("POST", "/api/v1/stripe/payment-intents", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    const b = requireBodyObject(ctx.body, deps.HttpError);
    const userId = requireUserId(ctx.query, b, deps.HttpError);
    const amount = Number(b.amount);
    const currency = String(b.currency ?? "cad").toLowerCase();
    if (!Number.isInteger(amount) || amount < 50) {
      throw new deps.HttpError(400, "bad_amount", "`amount` must be an integer >= 50 (minor units, e.g. cents)");
    }
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new deps.HttpError(400, "bad_currency", "`currency` must be a 3-letter ISO code");
    }
    const params: Record<string, string> = {
      amount: String(amount),
      currency,
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
    };
    if (b.description) params.description = String(b.description).slice(0, 200);
    params["metadata[phase_user_id]"] = userId;
    if (b.metadata && typeof b.metadata === "object") {
      for (const [k, v] of Object.entries(b.metadata as Record<string, unknown>)) {
        params[`metadata[${k}]`] = String(v).slice(0, 200);
      }
    }
    const { status, data } = await stripeApi("POST", "/v1/payment_intents", params);
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
    deps.sendJson(ctx.res, status, {
      testmode: true,
      livemode: false,
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
    const id = ctx.params.id;
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) {
      throw new deps.HttpError(400, "bad_id", "Invalid PaymentIntent id");
    }
    const { status, data } = await stripeApi("GET", `/v1/payment_intents/${id}`);
    const d = data as Record<string, unknown>;
    deps.sendJson(ctx.res, status, {
      testmode: true,
      livemode: false,
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
    const id = ctx.params.id;
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) {
      throw new deps.HttpError(400, "bad_id", "Invalid PaymentIntent id");
    }
    const { status, data } = await stripeApi("GET", `/v1/payment_intents/${id}`);
    const d = data as Record<string, unknown>;
    if (status >= 400) {
      deps.sendJson(ctx.res, status, {
        testmode: true,
        livemode: false,
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
    } else {
      ledger = await dbQueryOne<FiatLedgerEntry>(
        `SELECT id, user_id, amount, currency, stripe_payment_intent_id, status, verified
         FROM ledger_entries WHERE stripe_payment_intent_id = $1`,
        [id],
      );
    }
    deps.sendJson(ctx.res, 200, {
      testmode: true,
      livemode: false,
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
    const userId = requireUserId(ctx.query, undefined, deps.HttpError);
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
      testmode: true,
      livemode: false,
      userId,
      totals, // minor units per currency, e.g. { CAD: { credited: "5000", pending: "0" } }
      note: "credited = confirmed + verified fiat deposits only. Amounts are in minor units (cents).",
    });
  });
}
