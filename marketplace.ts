/**
 * Phase marketplace settlement — the "does the issuer get paid" infrastructure.
 *
 * A buy is a two-legged settlement executed atomically from the buyer's view:
 *   money leg: buyer's USD cash ledger -> issuer's USD cash ledger (full
 *              amount; no platform fee in this version)
 *   coin leg:  coin's public float -> buyer's ph1 address on the coin's own
 *              sovereign chain (platform-operated float settlement)
 *
 * Routes (mounted from phase-backend.ts):
 *   POST /api/v1/trades/buy       execute a buy (idempotent)
 *   GET  /api/v1/trades/balances   per-user cash balances + lifetime sales
 *   GET  /api/v1/trades/history     trades where the user was buyer/seller
 *   POST /api/v1/trades/topup      TEST-MODE faucet: credit USD for trying
 *                                       the flow. Test rails only — never wire
 *                                       this to real money.
 *
 * Persistence: Postgres when DATABASE_URL is set, otherwise a small in-memory
 * store (dev/test). The interface is identical in both modes.
 */
import { randomUUID } from "node:crypto";
import { getPool } from "./db.js";
import {
  store as ledgerStore,
  loadLedgerFromDb,
  settleFloatTransfer,
  getChainBalance,
  isValidAddress,
  PUBLIC_FLOAT_ADDRESS,
  LedgerError,
  auditLog,
} from "./sovereign-ledger-core.js";
import { getIssuanceStore, type IssuanceCoin } from "./issuance.js";

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

export interface MarketplaceMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface MarketplaceCtx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface MarketTrade {
  id: string;
  chainId: string;
  coinId: string;
  buyerUserId: string;
  sellerUserId: string;
  units: string; // human units, 6dp
  priceUsd: string;
  amountUsd: string;
  buyerAddress: string;
  txId: string | null;
  idempotencyKey: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Durable settlement attempts — the two-legged buy as a crash-safe state
// machine. States: started -> cash_moved -> coin_queued -> coin_confirmed.
// Failure states: failed (nothing moved), compensated (cash moved then
// reversed). reconcileSettlements() finishes or unwinds stuck attempts.
// ---------------------------------------------------------------------------

export type SettlementState =
  | "started" | "cash_moved" | "coin_queued" | "coin_confirmed"
  | "failed" | "compensated";

export interface SettlementAttempt {
  id: string;
  idempotencyKey: string;
  chainId: string;
  coinId: string | null;
  buyerUserId: string;
  sellerUserId: string;
  buyerAddress: string;
  units: string;
  priceUsd: string;
  amountUsd: string;
  state: SettlementState;
  coinTxId: string | null;
  tradeId: string | null;
  errorCode: string | null;
}

const TERMINAL_STATES: SettlementState[] = ["coin_confirmed", "failed", "compensated"];
const OPEN_STATES: SettlementState[] = ["started", "cash_moved", "coin_queued"];

const ATTEMPT_COLS = `id, idempotency_key AS "idempotencyKey", chain_id AS "chainId",
  coin_id AS "coinId", buyer_user_id AS "buyerUserId", seller_user_id AS "sellerUserId",
  buyer_address AS "buyerAddress", units::text AS "units", price_usd::text AS "priceUsd",
  amount_usd::text AS "amountUsd", state, coin_tx_id AS "coinTxId", trade_id AS "tradeId",
  error_code AS "errorCode"`;

const NETWORK_ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };
const USD = "USD";

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function money6(n: number): string {
  return n.toFixed(6);
}
function parsePositiveMoney(raw: unknown, field: string, max = 1_000_000_000): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new MarketplaceHttpError(422, "invalid_amount", `${field} must be a positive number.`);
  }
  return Math.round(n * 1e6) / 1e6; // normalize to 6dp
}

class MarketplaceHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Cash-ledger + trade store (Postgres with in-memory fallback)
// ---------------------------------------------------------------------------

interface MarketStore {
  getBalance(userId: string, currency: string): Promise<string>;
  /** Move money buyer -> seller atomically. Throws insufficient_funds. */
  transfer(userIdFrom: string, userIdTo: string, currency: string, amount: string): Promise<void>;
  credit(userId: string, currency: string, amount: string): Promise<void>;
  getTradeByIdempotency(key: string): Promise<MarketTrade | null>;
  recordTrade(t: Omit<MarketTrade, "id" | "createdAt">): Promise<MarketTrade>;
  listTrades(userId: string, role: "buyer" | "seller"): Promise<MarketTrade[]>;
  lifetimeSalesUsd(sellerUserId: string): Promise<string>;
  // --- durable settlement attempts ---
  createAttempt(a: Omit<SettlementAttempt, "id" | "state" | "coinTxId" | "tradeId" | "errorCode">): Promise<{ attempt: SettlementAttempt; created: boolean }>;
  getAttemptByIdempotency(key: string): Promise<SettlementAttempt | null>;
  setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string }): Promise<void>;
  listOpenAttempts(): Promise<SettlementAttempt[]>;
}

class PgMarketStore implements MarketStore {
  private async q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query(text, params as unknown[]);
    return r.rows as T[];
  }

  async getBalance(userId: string, currency: string): Promise<string> {
    const rows = await this.q<{ balance: string }>(
      `SELECT balance::text AS balance FROM market_balances WHERE user_id = $1 AND currency = $2`,
      [userId, currency]
    );
    return rows[0]?.balance ?? "0";
  }

  async transfer(from: string, to: string, currency: string, amount: string): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const debit = await client.query(
        `UPDATE market_balances SET balance = balance - $1::numeric, updated_at = now()
         WHERE user_id = $2 AND currency = $3 AND balance >= $1::numeric`,
        [amount, from, currency]
      );
      if (debit.rowCount === 0) {
        throw new MarketplaceHttpError(402, "insufficient_funds",
          "Not enough USD in your cash account. Add test funds and try again.");
      }
      await client.query(
        `INSERT INTO market_balances (user_id, currency, balance)
         VALUES ($1, $2, $3::numeric)
         ON CONFLICT (user_id, currency)
         DO UPDATE SET balance = market_balances.balance + EXCLUDED.balance, updated_at = now()`,
        [to, currency, amount]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async credit(userId: string, currency: string, amount: string): Promise<void> {
    await this.q(
      `INSERT INTO market_balances (user_id, currency, balance)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (user_id, currency)
       DO UPDATE SET balance = market_balances.balance + EXCLUDED.balance, updated_at = now()`,
      [userId, currency, amount]
    );
  }

  async getTradeByIdempotency(key: string): Promise<MarketTrade | null> {
    const rows = await this.q<MarketTrade>(`SELECT ${TRADE_COLS} FROM market_trades WHERE idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  }

  async recordTrade(t: Omit<MarketTrade, "id" | "createdAt">): Promise<MarketTrade> {
    const id = randomUUID();
    const rows = await this.q<MarketTrade>(
      `INSERT INTO market_trades
         (id, chain_id, coin_id, buyer_user_id, seller_user_id, units, price_usd,
          amount_usd, buyer_address, tx_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10,$11)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${TRADE_COLS}`,
      [id, t.chainId, t.coinId, t.buyerUserId, t.sellerUserId, t.units, t.priceUsd,
       t.amountUsd, t.buyerAddress, t.txId, t.idempotencyKey]
    );
    if (rows[0]) return rows[0];
    const existing = await this.getTradeByIdempotency(t.idempotencyKey);
    if (!existing) throw new Error("idempotency conflict without existing trade");
    return existing;
  }

  async listTrades(userId: string, role: "buyer" | "seller"): Promise<MarketTrade[]> {
    const col = role === "buyer" ? "buyer_user_id" : "seller_user_id";
    return this.q<MarketTrade>(
      `SELECT ${TRADE_COLS} FROM market_trades WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
  }

  async lifetimeSalesUsd(sellerUserId: string): Promise<string> {
    const rows = await this.q<{ total: string }>(
      `SELECT COALESCE(SUM(amount_usd), 0)::text AS total FROM market_trades WHERE seller_user_id = $1`,
      [sellerUserId]
    );
    return rows[0]?.total ?? "0";
  }

  async createAttempt(a: Omit<SettlementAttempt, "id" | "state" | "coinTxId" | "tradeId" | "errorCode">): Promise<{ attempt: SettlementAttempt; created: boolean }> {
    const id = randomUUID();
    const rows = await this.q<SettlementAttempt>(
      `INSERT INTO settlement_attempts
         (id, idempotency_key, chain_id, coin_id, buyer_user_id, seller_user_id,
          buyer_address, units, price_usd, amount_usd, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,'started')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ATTEMPT_COLS}`,
      [id, a.idempotencyKey, a.chainId, a.coinId, a.buyerUserId, a.sellerUserId,
       a.buyerAddress, a.units, a.priceUsd, a.amountUsd]
    );
    if (rows[0]) return { attempt: rows[0], created: true };
    const existing = await this.getAttemptByIdempotency(a.idempotencyKey);
    if (!existing) throw new Error("settlement idempotency conflict without existing attempt");
    return { attempt: existing, created: false };
  }

  async getAttemptByIdempotency(key: string): Promise<SettlementAttempt | null> {
    const rows = await this.q<SettlementAttempt>(
      `SELECT ${ATTEMPT_COLS} FROM settlement_attempts WHERE idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  }

  async setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string }): Promise<void> {
    await this.q(
      `UPDATE settlement_attempts SET state = $2,
         coin_tx_id = COALESCE($3, coin_tx_id),
         trade_id = COALESCE($4, trade_id),
         error_code = COALESCE($5, error_code),
         updated_at = now()
       WHERE id = $1`,
      [id, state, patch?.coinTxId ?? null, patch?.tradeId ?? null, patch?.errorCode ?? null]
    );
  }

  async listOpenAttempts(): Promise<SettlementAttempt[]> {
    return this.q<SettlementAttempt>(
      `SELECT ${ATTEMPT_COLS} FROM settlement_attempts WHERE state = ANY($1) ORDER BY created_at`,
      [OPEN_STATES]
    );
  }
}

const TRADE_COLS = `id, chain_id AS "chainId", coin_id AS "coinId",
  buyer_user_id AS "buyerUserId", seller_user_id AS "sellerUserId",
  units::text AS "units", price_usd::text AS "priceUsd", amount_usd::text AS "amountUsd",
  buyer_address AS "buyerAddress", tx_id AS "txId",
  idempotency_key AS "idempotencyKey", created_at AS "createdAt"`;

class MemoryMarketStore implements MarketStore {
  private balances = new Map<string, string>(); // `${userId}:${currency}` -> decimal string
  private trades = new Map<string, MarketTrade>();
  private tradesByKey = new Map<string, MarketTrade>();
  private keyOf(u: string, c: string) { return `${u}:${c}`; }

  private bal(u: string, c: string): number {
    return Number(this.balances.get(this.keyOf(u, c)) ?? "0");
  }
  private setBal(u: string, c: string, n: number) {
    this.balances.set(this.keyOf(u, c), money6(n));
  }

  async getBalance(userId: string, currency: string): Promise<string> {
    return money6(this.bal(userId, currency));
  }
  async transfer(from: string, to: string, currency: string, amount: string): Promise<void> {
    const amt = Number(amount);
    if (this.bal(from, currency) < amt) {
      throw new MarketplaceHttpError(402, "insufficient_funds",
        "Not enough USD in your cash account. Add test funds and try again.");
    }
    this.setBal(from, currency, this.bal(from, currency) - amt);
    this.setBal(to, currency, this.bal(to, currency) + amt);
  }
  async credit(userId: string, currency: string, amount: string): Promise<void> {
    this.setBal(userId, currency, this.bal(userId, currency) + Number(amount));
  }
  async getTradeByIdempotency(key: string): Promise<MarketTrade | null> {
    return this.tradesByKey.get(key) ?? null;
  }
  async recordTrade(t: Omit<MarketTrade, "id" | "createdAt">): Promise<MarketTrade> {
    const existing = this.tradesByKey.get(t.idempotencyKey);
    if (existing) return existing;
    const trade: MarketTrade = { ...t, id: randomUUID(), createdAt: new Date().toISOString() };
    this.trades.set(trade.id, trade);
    this.tradesByKey.set(trade.idempotencyKey, trade);
    return trade;
  }
  async listTrades(userId: string, role: "buyer" | "seller"): Promise<MarketTrade[]> {
    const col = role === "buyer" ? "buyerUserId" : "sellerUserId";
    return [...this.trades.values()]
      .filter((t) => t[col] === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 100);
  }
  async lifetimeSalesUsd(sellerUserId: string): Promise<string> {
    let total = 0;
    for (const t of this.trades.values()) if (t.sellerUserId === sellerUserId) total += Number(t.amountUsd);
    return money6(total);
  }

  private attempts = new Map<string, SettlementAttempt>();
  private attemptsByKey = new Map<string, SettlementAttempt>();

  async createAttempt(a: Omit<SettlementAttempt, "id" | "state" | "coinTxId" | "tradeId" | "errorCode">): Promise<{ attempt: SettlementAttempt; created: boolean }> {
    const existing = this.attemptsByKey.get(a.idempotencyKey);
    if (existing) return { attempt: existing, created: false };
    const attempt: SettlementAttempt = {
      ...a, id: randomUUID(), state: "started",
      coinTxId: null, tradeId: null, errorCode: null,
    };
    this.attempts.set(attempt.id, attempt);
    this.attemptsByKey.set(attempt.idempotencyKey, attempt);
    return { attempt, created: true };
  }

  async getAttemptByIdempotency(key: string): Promise<SettlementAttempt | null> {
    return this.attemptsByKey.get(key) ?? null;
  }

  async setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string }): Promise<void> {
    const a = this.attempts.get(id);
    if (!a) return;
    a.state = state;
    if (patch?.coinTxId) a.coinTxId = patch.coinTxId;
    if (patch?.tradeId) a.tradeId = patch.tradeId;
    if (patch?.errorCode) a.errorCode = patch.errorCode;
  }

  async listOpenAttempts(): Promise<SettlementAttempt[]> {
    return [...this.attempts.values()].filter((a) => (OPEN_STATES as string[]).includes(a.state));
  }
}

let storeInstance: MarketStore | null = null;
/** Test hook: direct access to the market store (used by test-settlement.ts). */
export async function getMarketStore(): Promise<MarketStore> {
  return getStoreAsync();
}
async function getStoreAsync(): Promise<MarketStore> {
  if (storeInstance) return storeInstance;
  try {
    getPool();
    await getPool().query("SELECT 1");
    storeInstance = new PgMarketStore();
  } catch {
    storeInstance = new MemoryMarketStore();
  }
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per route + client IP). Resets on restart;
// sufficient for abuse-throttling test rails, not a DDoS control.
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, { n: number; reset: number }>();

export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    rateBuckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= max;
}

function clientIp(ctx: MarketplaceCtx): string {
  const h = ctx.req.headers;
  const fwd = h["x-forwarded-for"] ?? h["x-real-ip"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof first === "string" && first) return first.split(",")[0].trim();
  const sock = (ctx.req as unknown as { socket?: { remoteAddress?: string } }).socket;
  return sock?.remoteAddress ?? "unknown";
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountMarketplaceRoutes(deps: MarketplaceMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof MarketplaceHttpError;

  const fail = (ctx: MarketplaceCtx, err: unknown): void => {
    if (err instanceof LedgerError) {
      sendJson(ctx.res, err.status ?? 400, { ...NETWORK_ENVELOPE, error: err.code, message: err.message });
      return;
    }
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...NETWORK_ENVELOPE, error: code, message });
  };

  const requireUserId = (ctx: MarketplaceCtx): string => {
    const body = asRecord(ctx.body);
    const id = str(body.userId) || str(ctx.query.get("userId"));
    if (!id) throw new HttpError(400, "missing_user_id", "Provide userId in the body or query string.");
    return id;
  };

  const idempotencyKey = (ctx: MarketplaceCtx, fallback: string): string => {
    const header = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
    const h = Array.isArray(header) ? header[0] : header;
    return str(h) || str(asRecord(ctx.body).idempotencyKey) || fallback;
  };

  // --- POST /api/v1/trades/buy ---
  // Body: { userId, chainId, amountUsd, buyerAddress, idempotencyKey? }
  //
  // Two-legged settlement as a durable state machine (settlement_attempts):
  //   started -> cash_moved -> coin_queued -> coin_confirmed
  // Crash between legs? The attempt row survives; reconcileSettlements()
  // finishes or unwinds it at boot, and a retried key resumes the attempt.
  route("POST", "/api/v1/trades/buy", async (ctx) => {
    try {
      if (!checkRateLimit(`buy:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many buy attempts — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const buyerUserId = requireUserId(ctx);
      const chainId = str(body.chainId);
      if (!chainId) throw new HttpError(400, "missing_chain_id", "Body must include chainId.");
      const buyerAddress = str(body.buyerAddress);
      if (!isValidAddress(buyerAddress)) {
        throw new HttpError(422, "invalid_buyer_address", "buyerAddress must be a valid ph1 address.");
      }
      const amountUsd = parsePositiveMoney(body.amountUsd, "amountUsd");
      const key = idempotencyKey(ctx, `buy-${chainId}-${Date.now()}`);

      const ms = await getStoreAsync();

      const issuance = await getIssuanceStore();
      const coin: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
      if (!coin) throw new HttpError(404, "coin_not_found", "No issued coin for this chain.");
      const priceUsd = Number(coin.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new HttpError(422, "coin_not_priced", "This coin has no trade price yet.");
      }
      const sellerUserId = coin.userId;

      // Self-trade guard: the issuer and buyer must be different accounts.
      // (Buys where both sides are the same account would be a self-transfer
      // that inflates volume and lifetime sales.)
      if (buyerUserId === sellerUserId) {
        throw new HttpError(422, "self_trade",
          "You can't buy your own coin — switch to a different account to trade it.");
      }

      // units: whole coins only in v1 (the chain's base unit is one whole
      // coin — supply/balances are stored and displayed as whole shares).
      const units = Math.floor(amountUsd / priceUsd);
      if (units < 1) {
        throw new HttpError(422, "amount_too_small", "amountUsd buys less than one whole coin at this price.");
      }
      const unitsBase = BigInt(units);
      const chargedUsd = money6(units * priceUsd);

      // Pre-check the float before touching money.
      const floatBal = BigInt(getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS));
      if (floatBal < unitsBase) {
        throw new HttpError(409, "insufficient_float",
          "The public float doesn't have enough coins left for this purchase.");
      }

      // Idempotent attempt: same key -> resume or replay, never double-settle.
      let attempt: SettlementAttempt;
      {
        const { attempt: a, created } = await ms.createAttempt({
          idempotencyKey: key,
          chainId,
          coinId: coin.id,
          buyerUserId,
          sellerUserId,
          buyerAddress,
          units: money6(units),
          priceUsd: money6(priceUsd),
          amountUsd: chargedUsd,
        });
        attempt = a;
        if (!created) {
          if (attempt.tradeId) {
            const replay = await ms.getTradeByIdempotency(key);
            if (replay) {
              sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, idempotentReplay: true, trade: replay });
              return;
            }
          }
          if ((TERMINAL_STATES as string[]).includes(attempt.state)) {
            throw new HttpError(409, "already_attempted",
              "This purchase was already attempted and did not complete. Use a new idempotency key.");
          }
          if (attempt.state !== "started" && attempt.state !== "cash_moved" && attempt.state !== "coin_queued") {
            throw new HttpError(409, "settlement_in_progress",
              "This purchase is already being processed — wait a moment and check history.");
          }
          // else: resume the crashed attempt from its recorded state.
        }
      }
      await auditLog(buyerUserId, "settlement_started", "settlement", attempt.id,
        { chainId, units, amountUsd: chargedUsd });

      // Money leg: buyer -> issuer, atomic in the store. Skipped when
      // resuming an attempt that already moved cash.
      if (attempt.state === "started") {
        try {
          await ms.transfer(buyerUserId, sellerUserId, USD, chargedUsd);
        } catch (err) {
          await ms.setAttemptState(attempt.id, "failed",
            { errorCode: (err as { code?: string }).code ?? "cash_leg_failed" });
          throw err;
        }
        await ms.setAttemptState(attempt.id, "cash_moved");
        attempt.state = "cash_moved";
        await auditLog(buyerUserId, "settlement_cash_moved", "settlement", attempt.id,
          { amountUsd: chargedUsd, sellerUserId });
      }

      // Coin leg: float -> buyer on the sovereign chain. Skipped when
      // resuming an attempt that already queued the coin transfer.
      let txId = attempt.coinTxId;
      if (attempt.state === "cash_moved") {
        try {
          const settled = await settleFloatTransfer(chainId, buyerAddress, unitsBase.toString(),
            `marketplace buy ${units} ${coin.ticker}`);
          txId = settled.tx_id;
        } catch (err) {
          // Compensate: unwind the money leg, best effort.
          try { await ms.transfer(sellerUserId, buyerUserId, USD, chargedUsd); } catch { /* logged below */ }
          await ms.setAttemptState(attempt.id, "compensated",
            { errorCode: (err as { code?: string }).code ?? "coin_leg_failed" });
          console.error("[marketplace] coin leg failed after money leg; compensated:", (err as Error).message);
          throw err;
        }
        await ms.setAttemptState(attempt.id, "coin_queued", { coinTxId: txId! });
        attempt.state = "coin_queued";
        attempt.coinTxId = txId;
        await auditLog(buyerUserId, "settlement_coin_queued", "settlement", attempt.id, { txId });
      }

      const trade = await ms.recordTrade({
        chainId,
        coinId: coin.id,
        buyerUserId,
        sellerUserId,
        units: money6(units),
        priceUsd: money6(priceUsd),
        amountUsd: chargedUsd,
        buyerAddress,
        txId,
        idempotencyKey: key,
      });
      await ms.setAttemptState(attempt.id, "coin_confirmed", { tradeId: trade.id, coinTxId: txId ?? undefined });
      await auditLog(buyerUserId, "trade_recorded", "trade", trade.id,
        { chainId, units, amountUsd: chargedUsd, txId });

      const buyerBalance = await ms.getBalance(buyerUserId, USD);
      sendJson(ctx.res, 201, {
        ...NETWORK_ENVELOPE,
        idempotentReplay: false,
        trade,
        txId,
        buyerBalanceUsd: buyerBalance,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/trades/balances?userId= ---
  route("GET", "/api/v1/trades/balances", async (ctx) => {
    try {
      const userId = requireUserId(ctx);
      const ms = await getStoreAsync();
      const [usd, earned] = await Promise.all([
        ms.getBalance(userId, USD),
        ms.lifetimeSalesUsd(userId),
      ]);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        balances: { [USD]: usd },
        lifetimeSalesUsd: earned,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/trades/history?userId=&role=seller|buyer ---
  route("GET", "/api/v1/trades/history", async (ctx) => {
    try {
      const userId = requireUserId(ctx);
      const role = ctx.query.get("role") === "buyer" ? "buyer" : "seller";
      const ms = await getStoreAsync();
      const trades = await ms.listTrades(userId, role);
      sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, role, trades });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/trades/topup ---
  // TEST-MODE faucet: credit USD so the buy flow can be tried end to end.
  // Test rails only. Never wire to real money.
  route("POST", "/api/v1/trades/topup", async (ctx) => {
    try {
      if (!checkRateLimit(`topup:${clientIp(ctx)}`, 10, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many top-up requests — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const userId = requireUserId(ctx);
      const amountUsd = parsePositiveMoney(body.amountUsd, "amountUsd", 100_000);
      const ms = await getStoreAsync();
      await ms.credit(userId, USD, money6(amountUsd));
      const balance = await ms.getBalance(userId, USD);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        testMode: true,
        creditedUsd: money6(amountUsd),
        balanceUsd: balance,
      });
    } catch (err) { fail(ctx, err); }
  });
}

// ---------------------------------------------------------------------------
// Boot reconciliation — finish or unwind settlements stuck by a crash.
// Call once at startup, after the ledger has been restored from Postgres.
// ---------------------------------------------------------------------------

export async function reconcileSettlements(): Promise<{ finished: number; compensated: number; failed: number }> {
  const result = { finished: 0, compensated: 0, failed: 0 };
  let ms: MarketStore;
  try {
    ms = await getStoreAsync();
  } catch (e) {
    console.error("[marketplace] reconcile: store unavailable", e);
    return result;
  }
  // Make sure the in-memory ledger (tx statuses) is rebuilt first.
  try { await loadLedgerFromDb(); } catch { /* ledger load logs on its own */ }

  let open: SettlementAttempt[];
  try {
    open = await ms.listOpenAttempts();
  } catch (e) {
    console.error("[marketplace] reconcile: cannot list attempts", e);
    return result;
  }
  if (open.length === 0) return result;
  console.log(`[marketplace] reconciling ${open.length} open settlement(s)`);

  for (const a of open) {
    try {
      if (a.state === "started") {
        // Nothing moved — safe to abandon.
        await ms.setAttemptState(a.id, "failed", { errorCode: "abandoned_at_boot" });
        result.failed++;
        continue;
      }
      if (a.state === "cash_moved") {
        // Cash moved, coin leg never queued — retry the coin leg once.
        const unitsBase = BigInt(Math.round(Number(a.units)));
        let floatBal: bigint;
        try {
          floatBal = BigInt(getChainBalance(a.chainId, PUBLIC_FLOAT_ADDRESS));
        } catch {
          floatBal = 0n;
        }
        if (floatBal < unitsBase) {
          try { await ms.transfer(a.sellerUserId, a.buyerUserId, USD, a.amountUsd); } catch { /* best effort */ }
          await ms.setAttemptState(a.id, "compensated", { errorCode: "insufficient_float_on_retry" });
          result.compensated++;
          continue;
        }
        try {
          const settled = await settleFloatTransfer(a.chainId, a.buyerAddress, unitsBase.toString(),
            "reconciled marketplace buy");
          await ms.setAttemptState(a.id, "coin_queued", { coinTxId: settled.tx_id });
          result.finished++;
        } catch (err) {
          try { await ms.transfer(a.sellerUserId, a.buyerUserId, USD, a.amountUsd); } catch { /* best effort */ }
          await ms.setAttemptState(a.id, "compensated",
            { errorCode: (err as { code?: string }).code ?? "coin_leg_failed" });
          result.compensated++;
        }
        continue;
      }
      if (a.state === "coin_queued") {
        // Coin tx was queued — check whether it confirmed.
        const tx = a.coinTxId ? ledgerStore.txById.get(a.coinTxId) : undefined;
        if (tx && tx.status === "confirmed") {
          if (!a.tradeId) {
            const trade = await ms.recordTrade({
              chainId: a.chainId,
              coinId: a.coinId ?? "",
              buyerUserId: a.buyerUserId,
              sellerUserId: a.sellerUserId,
              units: a.units,
              priceUsd: a.priceUsd,
              amountUsd: a.amountUsd,
              buyerAddress: a.buyerAddress,
              txId: a.coinTxId,
              idempotencyKey: a.idempotencyKey,
            });
            await ms.setAttemptState(a.id, "coin_confirmed", { tradeId: trade.id });
          } else {
            await ms.setAttemptState(a.id, "coin_confirmed");
          }
          result.finished++;
        } else if (!tx || tx.status === "failed") {
          // Coin never landed — unwind the cash.
          try { await ms.transfer(a.sellerUserId, a.buyerUserId, USD, a.amountUsd); } catch { /* best effort */ }
          await ms.setAttemptState(a.id, "compensated", { errorCode: "coin_tx_failed" });
          result.compensated++;
        }
        // else still pending — the sequencer will confirm it from the
        // rehydrated mempool; leave the attempt open.
        continue;
      }
    } catch (err) {
      console.error(`[marketplace] reconcile failed for attempt ${a.id}:`, (err as Error).message);
    }
  }
  console.log(`[marketplace] reconcile done: ${JSON.stringify(result)}`);
  await auditLog("system", "settlements_reconciled", "settlements", undefined, result);
  return result;
}
