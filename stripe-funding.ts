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
 *    - Retrieves PaymentIntent status so the app can poll for confirmation.
 *    - Reports configuration/mode status.
 *
 *  WHAT'S REAL vs WHAT'S SIMULATED
 *    - Stripe API calls are REAL (test mode — Stripe's sandbox, no real
 *      charges). Every response carries an explicit TESTMODE label.
 *    - No ledger crediting happens here yet: confirming a payment and
 *      crediting the Phase account balance is wired separately once the
 *      funding flow is finalized.
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

  // --- Create a test PaymentIntent ---
  deps.route("POST", "/api/v1/stripe/payment-intents", async (ctx) => {
    if (stripeError(deps, ctx)) return;
    const b = requireBodyObject(ctx.body, deps.HttpError);
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
    if (b.metadata && typeof b.metadata === "object") {
      for (const [k, v] of Object.entries(b.metadata as Record<string, unknown>)) {
        params[`metadata[${k}]`] = String(v).slice(0, 200);
      }
    }
    const { status, data } = await stripeApi("POST", "/v1/payment_intents", params);
    const d = data as Record<string, unknown>;
    deps.sendJson(ctx.res, status, {
      testmode: true,
      livemode: false,
      id: d.id,
      client_secret: d.client_secret,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
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
}
