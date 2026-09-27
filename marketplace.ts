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
  settleFloatTransfer,
  getChainBalance,
  isValidAddress,
  PUBLIC_FLOAT_ADDRESS,
  LedgerError,
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
}

let storeInstance: MarketStore | null = null;
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
  route("POST", "/api/v1/trades/buy", async (ctx) => {
    try {
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

      // Idempotent replay: same key -> original trade, no second settlement.
      const replay = await ms.getTradeByIdempotency(key);
      if (replay) {
        sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, idempotentReplay: true, trade: replay });
        return;
      }

      const issuance = await getIssuanceStore();
      const coin: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
      if (!coin) throw new HttpError(404, "coin_not_found", "No issued coin for this chain.");
      const priceUsd = Number(coin.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new HttpError(422, "coin_not_priced", "This coin has no trade price yet.");
      }
      const sellerUserId = coin.userId;

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

      // Money leg: buyer -> issuer, atomic in the store.
      await ms.transfer(buyerUserId, sellerUserId, USD, chargedUsd);

      // Coin leg: float -> buyer on the sovereign chain.
      let txId: string;
      try {
        const settled = await settleFloatTransfer(chainId, buyerAddress, unitsBase.toString(),
          `marketplace buy ${units} ${coin.ticker}`);
        txId = settled.tx_id;
      } catch (err) {
        // Compensate: unwind the money leg, best effort.
        try { await ms.transfer(sellerUserId, buyerUserId, USD, chargedUsd); } catch { /* log below */ }
        console.error("[marketplace] coin leg failed after money leg; compensated:", (err as Error).message);
        throw err;
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
