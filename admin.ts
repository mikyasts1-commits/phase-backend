/**
 * admin.ts — secure administrative API for the Phase fee & treasury system.
 *
 * Every endpoint requires an admin session:
 *   - Authorization: Bearer <token> belonging to a user with
 *     issuance_users.is_admin = TRUE, or whose email is listed in
 *     PHASE_ADMIN_EMAILS (comma-separated, case-insensitive).
 * Ordinary users get 403. Every administrative action is audit-logged.
 */
import { resolveBearerUserId } from "./auth.js";
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import { auditLog } from "./sovereign-ledger-core.js";
import { dbQuery, dbQueryOne } from "./db.js";
import {
  getFeeConfig,
  setFeeConfig,
  isAdminUser,
  getTreasuryAccountId,
  getTreasuryBalances,
  ensureTreasuryAccount,
  requestWithdrawal,
  listWithdrawals,
  getWithdrawal,
  approveWithdrawal,
  executeWithdrawal,
  runFeeReconciliation,
  latestReconciliation,
  runProductionChecks,
  fromMicroUnits,
  toMicroUnits,
  type FeeRecord,
} from "./fee.js";

export interface AdminMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => Promise<void>) => void;
  sendJson: (res: any, status: number, body: unknown) => void;
  HttpError: new (status: number, code: string, message: string) => Error;
}

class AdminHttpError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

interface AdminCtx {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export function mountAdminRoutes(deps: AdminMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof AdminHttpError;

  const fail = (ctx: AdminCtx, err: unknown): void => {
    if (err instanceof AdminHttpError || err instanceof HttpError) {
      const e = err as AdminHttpError;
      sendJson(ctx.res, (e as { statusCode?: number }).statusCode ?? 500,
        { error: (e as { code?: string }).code ?? "error", message: e.message });
      return;
    }
    console.error("[admin]", err);
    sendJson(ctx.res, 500, { error: "internal", message: "Internal error." });
  };

  const asRecord = (body: unknown): Record<string, unknown> =>
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const clientIp = (ctx: AdminCtx): string => clientIpFromHeaders(ctx.req.headers);

  /** Admin gate: authenticated session + admin privilege. Returns admin userId. */
  const requireAdmin = async (ctx: AdminCtx): Promise<string> => {
    const userId = await resolveBearerUserId(ctx.req.headers);
    if (!userId) throw new HttpError(401, "unauthorized", "Admin sign-in required.");
    if (!(await isAdminUser(userId))) {
      await auditLog(userId, "admin_access_denied", "admin", undefined, {
        path: ctx.req.url,
      });
      throw new HttpError(403, "forbidden", "Administrator privileges required.");
    }
    return userId;
  };

  const rateLimitAdmin = (ctx: AdminCtx): void => {
    if (!sharedCheckRateLimit(`admin:${clientIp(ctx)}`, 120, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many admin requests — wait a minute.");
    }
  };

  // --- GET /api/v1/admin/me — is the current user an admin? ---
  // Lets the app decide whether to show the admin dashboard. Returns 200
  // with { isAdmin: false } for non-admins (never 403) so the client can
  // probe without triggering access-denied audits.
  route("GET", "/api/v1/admin/me", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const userId = await resolveBearerUserId(ctx.req.headers);
      if (!userId) throw new HttpError(401, "unauthorized", "Sign-in required.");
      sendJson(ctx.res, 200, { userId, isAdmin: await isAdminUser(userId) });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/config — current fee configuration ---
  route("GET", "/api/v1/admin/fees/config", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const cfg = await getFeeConfig();
      sendJson(ctx.res, 200, { config: cfg });
    } catch (err) { fail(ctx, err); }
  });

  // --- PUT /api/v1/admin/fees/config — change the fee rate (versioned) ---
  route("PUT", "/api/v1/admin/fees/config", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const feeBps = Number(body.feeBps);
      if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
        throw new HttpError(422, "invalid_fee_bps", "feeBps must be an integer 0..10000.");
      }
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
      const cfg = await setFeeConfig(feeBps, adminId, reason);
      sendJson(ctx.res, 200, { config: cfg });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/summary — dashboard aggregates ---
  route("GET", "/api/v1/admin/fees/summary", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const days = Math.min(Math.max(Number(ctx.query.get("days") ?? 30) || 30, 1), 365);

      const config = await getFeeConfig();

      const today = await dbQuery<{
        transaction_type: string; asset_symbol: string;
        tx_count: string; gross: string; fees: string;
      }>(
        `SELECT transaction_type, asset_symbol, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= date_trunc('day', now()) AND status = 'settled'
         GROUP BY transaction_type, asset_symbol`
      );

      const byDay = await dbQuery<{
        day: string; asset_symbol: string;
        tx_count: string; gross: string; fees: string;
      }>(
        `SELECT date_trunc('day', created_at)::date::text AS day, asset_symbol,
                COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY 1, 2 ORDER BY 1 DESC`,
        [String(days)]
      );

      const byAsset = await dbQuery<{
        asset_symbol: string; tx_count: string; gross: string; fees: string;
      }>(
        `SELECT asset_symbol, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY asset_symbol ORDER BY SUM(fee_quantity) DESC`,
        [String(days)]
      );

      const byType = await dbQuery<{
        transaction_type: string; tx_count: string; gross: string; fees: string;
      }>(
        `SELECT transaction_type, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY transaction_type`,
        [String(days)]
      );

      const statusCounts = await dbQuery<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM fee_ledger GROUP BY status`
      );

      const treasuryAccountId = getTreasuryAccountId();
      await ensureTreasuryAccount(treasuryAccountId);
      const treasuryBalances = await getTreasuryBalances(treasuryAccountId);
      const withdrawals = await listWithdrawals(undefined, 10);
      const reconciliation = await latestReconciliation();

      sendJson(ctx.res, 200, {
        config,
        treasuryAccountId,
        today,
        byDay,
        byAsset,
        byType,
        statusCounts,
        treasuryBalances,
        recentWithdrawals: withdrawals,
        reconciliation,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/ledger — fee records (JSON or CSV export) ---
  route("GET", "/api/v1/admin/fees/ledger", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const asset = ctx.query.get("asset")?.toUpperCase() || null;
      const transactionType = ctx.query.get("transactionType") || null;
      const status = ctx.query.get("status") || null;
      const limit = Math.min(Number(ctx.query.get("limit") ?? 100) || 100, 1000);
      const offset = Math.max(Number(ctx.query.get("offset") ?? 0) || 0, 0);
      const format = ctx.query.get("format") ?? "json";

      const conds: string[] = [];
      const params: unknown[] = [];
      if (asset) { params.push(asset); conds.push(`asset_symbol = $${params.length}`); }
      if (transactionType) { params.push(transactionType); conds.push(`transaction_type = $${params.length}`); }
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

      const countRow = await dbQueryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM fee_ledger ${where}`, params
      );
      const rows = await dbQuery<FeeRecord>(
        `SELECT fee_id AS "feeId", idempotency_key AS "idempotencyKey",
                transaction_id AS "transactionId", transaction_type AS "transactionType",
                user_id AS "userId", asset_id AS "assetId", asset_symbol AS "assetSymbol",
                gross_quantity::text AS "grossQuantity", fee_bps AS "feeBps",
                fee_quantity::text AS "feeQuantity", net_quantity::text AS "netQuantity",
                treasury_account_id AS "treasuryAccountId", status,
                coin_tx_id AS "coinTxId", created_at AS "createdAt", settled_at AS "settledAt"
         FROM fee_ledger ${where}
         ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      await auditLog(adminId, "fee_ledger_exported", "fee_ledger", undefined, {
        format, asset, transactionType, status, limit, offset,
      });

      if (format === "csv") {
        const header = "fee_id,transaction_id,transaction_type,user_id,asset_symbol,gross_quantity,fee_bps,fee_quantity,net_quantity,treasury_account_id,status,coin_tx_id,created_at,settled_at";
        const lines = rows.map((r) =>
          [r.feeId, r.transactionId ?? "", r.transactionType, r.userId, r.assetSymbol,
           r.grossQuantity, String(r.feeBps), r.feeQuantity, r.netQuantity,
           r.treasuryAccountId, r.status, r.coinTxId ?? "", r.createdAt, r.settledAt ?? ""]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
        );
        ctx.res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=phase-fee-ledger.csv",
        });
        ctx.res.end(header + "\n" + lines.join("\n"));
        return;
      }
      sendJson(ctx.res, 200, { total: Number(countRow?.n ?? 0), limit, offset, records: rows });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/treasury/balances ---
  route("GET", "/api/v1/admin/treasury/balances", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const accountId = getTreasuryAccountId();
      await ensureTreasuryAccount(accountId);
      sendJson(ctx.res, 200, {
        treasuryAccountId: accountId,
        balances: await getTreasuryBalances(accountId),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals — request a withdrawal ---
  route("POST", "/api/v1/admin/treasury/withdrawals", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const assetSymbol = String(body.assetSymbol ?? "").trim();
      const amount = String(body.amount ?? "").trim();
      const destinationRef = String(body.destinationRef ?? "").trim();
      if (!assetSymbol) throw new HttpError(422, "missing_asset", "assetSymbol is required.");
      if (!amount) throw new HttpError(422, "missing_amount", "amount is required.");
      if (!destinationRef) {
        throw new HttpError(422, "missing_destination",
          "destinationRef is required (opaque reference to the approved destination — never a secret).");
      }
      // Validate the amount parses as positive money before touching the DB.
      toMicroUnits(amount);
      const wd = await requestWithdrawal({
        assetSymbol,
        amount,
        destinationRef,
        provider: typeof body.provider === "string" ? body.provider : "manual",
        note: typeof body.note === "string" ? body.note : undefined,
        requestedBy: adminId,
      });
      sendJson(ctx.res, 201, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/treasury/withdrawals ---
  route("GET", "/api/v1/admin/treasury/withdrawals", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const status = ctx.query.get("status") || undefined;
      sendJson(ctx.res, 200, { withdrawals: await listWithdrawals(status) });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals/:id/approve ---
  route("POST", "/api/v1/admin/treasury/withdrawals/:id/approve", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const wd = await approveWithdrawal(ctx.params.id, adminId, body.approve !== false, {
        selfApprove: body.selfApprove === true,
      });
      sendJson(ctx.res, 200, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals/:id/execute ---
  route("POST", "/api/v1/admin/treasury/withdrawals/:id/execute", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const wd = await executeWithdrawal(
        ctx.params.id,
        adminId,
        typeof body.providerRef === "string" ? body.providerRef : undefined
      );
      sendJson(ctx.res, 200, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/reconciliation/run ---
  route("POST", "/api/v1/admin/reconciliation/run", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const periodDays = Math.min(Math.max(Number(body.periodDays ?? 1) || 1, 1), 90);
      const result = await runFeeReconciliation(periodDays);
      await auditLog(adminId, "fee_reconciliation_manual_run", "reconciliation",
        result.runId != null ? String(result.runId) : undefined,
        { invariantOk: result.invariantOk });
      sendJson(ctx.res, 200, { reconciliation: result });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/reconciliation/latest ---
  route("GET", "/api/v1/admin/reconciliation/latest", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      sendJson(ctx.res, 200, { reconciliation: await latestReconciliation() });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/system/checks — production safety checks ---
  route("GET", "/api/v1/admin/system/checks", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      sendJson(ctx.res, 200, { checks: await runProductionChecks() });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/users/admins — who can administer ---
  route("GET", "/api/v1/admin/users/admins", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const rows = await dbQuery<{ id: string; email: string | null; name: string | null }>(
        `SELECT id, email, name FROM issuance_users WHERE is_admin = TRUE ORDER BY email`
      );
      sendJson(ctx.res, 200, { admins: rows });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/users/:id/grant — flag a user as admin ---
  route("POST", "/api/v1/admin/users/:id/grant", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const target = await dbQueryOne<{ id: string }>(
        `UPDATE issuance_users SET is_admin = TRUE WHERE id = $1 RETURNING id`,
        [ctx.params.id]
      );
      if (!target) throw new HttpError(404, "user_not_found", "No such user.");
      await auditLog(adminId, "admin_granted", "user", target.id, {});
      sendJson(ctx.res, 200, { ok: true, userId: target.id });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/users/:id/revoke — remove admin flag ---
  route("POST", "/api/v1/admin/users/:id/revoke", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      if (ctx.params.id === adminId) {
        throw new HttpError(422, "cannot_revoke_self", "You cannot revoke your own admin access.");
      }
      await dbQuery(`UPDATE issuance_users SET is_admin = FALSE WHERE id = $1`, [ctx.params.id]);
      await auditLog(adminId, "admin_revoked", "user", ctx.params.id, {});
      sendJson(ctx.res, 200, { ok: true, userId: ctx.params.id });
    } catch (err) { fail(ctx, err); }
  });
}
