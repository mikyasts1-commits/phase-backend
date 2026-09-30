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
  settleOperatorTransfer,
  getChainBalance,
  isValidAddress,
  PUBLIC_FLOAT_ADDRESS,
  LedgerError,
  auditLog,
} from "./sovereign-ledger-core.js";
import { getIssuanceStore, type IssuanceCoin } from "./issuance.js";
import { resolveBearerUserId } from "./auth.js";
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import {
  getFeeConfig,
  toMicroUnits,
  fromMicroUnits,
  coinUnitsToDecimal,
  decimalToCoinUnits,
  recordFee,
  getFeeByIdempotencyKey,
  setFeeTransactionId,
  markFeeReversed,
  markFeeSettled,
  feeIdempotencyKey,
  getTreasuryAccountId,
  ensureTreasuryAccount,
  creditTreasury,
  debitTreasury,
  getTreasurySovereignAddress,
  requireTreasurySovereignAddress,
  FEE_DISCLOSURE,
} from "./fee.js";

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
  /** "buy" (cash for coins) or "swap" (offer coins for coins). */
  kind: "buy" | "swap";
  /** Swap offer leg (null for buys): the buyer's own coin they are offering. */
  offerChainId: string | null;
  offerCoinId: string | null;
  offerUnits: string | null; // human units, 6dp
  offerTxId: string | null;
  /** 80-bps fee actually applied (null until the fee leg settles). */
  feeBps: number | null;
  /** Fee in settlement-asset units, 6dp text (USD for buys, whole coins for swaps). */
  feeAmount: string | null;
  /** Net settlement to the proceeds recipient, 6dp text. */
  netAmount: string | null;
}

// ---------------------------------------------------------------------------
// Durable settlement attempts — the two-legged buy as a crash-safe state
// machine. States: started -> cash_moved -> coin_queued -> coin_confirmed.
// Failure states: failed (nothing moved), compensated (cash moved then
// reversed). reconcileSettlements() finishes or unwinds stuck attempts.
// ---------------------------------------------------------------------------

export type SettlementState =
  | "started" | "cash_moved" | "coin_queued" | "coin_confirmed"
  | "offer_moved" | "target_queued"
  | "failed" | "compensated";

export interface SettlementAttempt {
  id: string;
  idempotencyKey: string;
  /** "buy" or "swap". */
  kind: "buy" | "swap";
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
  /** Swap offer leg (null for buys). */
  offerChainId: string | null;
  offerCoinId: string | null;
  offerUnits: string | null;
  offerTxId: string | null;
  /** Swap target: the target coin issuer's sovereign address (null for buys). */
  sellerAddress: string | null;
  /** Swap coin-fee tracking: fee in whole target-coin units (null for buys). */
  feeUnits: string | null;
  /** Fee basis points recorded on the attempt (null until computed). */
  feeBps: number | null;
  /** On-chain tx id of the float -> treasury fee transfer (swaps). */
  feeTxId: string | null;
}

const TERMINAL_STATES: SettlementState[] = ["coin_confirmed", "failed", "compensated"];
const OPEN_STATES: SettlementState[] = ["started", "cash_moved", "coin_queued", "offer_moved", "target_queued"];

const ATTEMPT_COLS = `id, idempotency_key AS "idempotencyKey", kind,
  chain_id AS "chainId",
  coin_id AS "coinId", buyer_user_id AS "buyerUserId", seller_user_id AS "sellerUserId",
  buyer_address AS "buyerAddress", units::text AS "units", price_usd::text AS "priceUsd",
  amount_usd::text AS "amountUsd", state, coin_tx_id AS "coinTxId", trade_id AS "tradeId",
  error_code AS "errorCode",
  offer_chain_id AS "offerChainId", offer_coin_id AS "offerCoinId",
  offer_units AS "offerUnits", offer_tx_id AS "offerTxId",
  seller_address AS "sellerAddress",
  fee_units AS "feeUnits", fee_bps AS "feeBps", fee_tx_id AS "feeTxId"`;

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

/**
 * Exact integer parsing for authoritative money math. Parses the raw input
 * directly to BigInt microunits — no floating point at any step. Rejects
 * non-numeric, non-positive, and over-limit values.
 */
function parsePositiveMicroUnits(raw: unknown, field: string, maxMicro = 1_000_000_000_000000n): bigint {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  let v: bigint;
  try {
    v = toMicroUnits(s);
  } catch {
    throw new MarketplaceHttpError(422, "invalid_amount", `${field} must be a positive number.`);
  }
  if (v <= 0n || v > maxMicro) {
    throw new MarketplaceHttpError(422, "invalid_amount", `${field} must be a positive number.`);
  }
  return v;
}

/** Whole coin units from user input (fractional input is floored; < 1 rejected). */
function parseWholeCoinUnits(raw: unknown, field: string): bigint {
  const units = parsePositiveMicroUnits(raw, field) / 1_000_000n;
  if (units < 1n) {
    throw new MarketplaceHttpError(422, "amount_too_small", `${field} must be at least one whole coin.`);
  }
  return units;
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
  recordTrade(t: Omit<MarketTrade, "id" | "createdAt" | "feeBps" | "feeAmount" | "netAmount">): Promise<MarketTrade>;
  listTrades(userId: string, role: "buyer" | "seller"): Promise<MarketTrade[]>;
  lifetimeSalesUsd(sellerUserId: string): Promise<string>;
  // --- durable settlement attempts ---
  createAttempt(a: Omit<SettlementAttempt, "id" | "state" | "coinTxId" | "tradeId" | "errorCode">): Promise<{ attempt: SettlementAttempt; created: boolean }>;
  getAttemptByIdempotency(key: string): Promise<SettlementAttempt | null>;
  setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string; offerTxId?: string; sellerAddress?: string; feeTxId?: string }): Promise<void>;
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
          "Not enough USD in your cash account. Insufficient balance. Add funds to continue.");
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

  async recordTrade(t: Omit<MarketTrade, "id" | "createdAt" | "feeBps" | "feeAmount" | "netAmount">): Promise<MarketTrade> {
    const id = randomUUID();
    // Attach the authoritative fee record (written during the fee leg) so
    // every trade row carries gross/fee/net for history display.
    const feeKey = feeIdempotencyKey(t.kind === "swap" ? "swap" : "buy", t.idempotencyKey);
    const feeRows = await this.q<{ fee_bps: number; fee_quantity: string; net_quantity: string }>(
      `SELECT fee_bps, fee_quantity::text AS fee_quantity, net_quantity::text AS net_quantity
       FROM fee_ledger WHERE idempotency_key = $1`,
      [feeKey]
    );
    const feeBps = feeRows[0]?.fee_bps ?? null;
    const feeAmount = feeRows[0]?.fee_quantity ?? null;
    const netAmount = feeRows[0]?.net_quantity ?? null;
    const rows = await this.q<MarketTrade>(
      `INSERT INTO market_trades
         (id, chain_id, coin_id, buyer_user_id, seller_user_id, units, price_usd,
          amount_usd, buyer_address, tx_id, idempotency_key,
          kind, offer_chain_id, offer_coin_id, offer_units, offer_tx_id,
          fee_bps, fee_amount, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,
               $12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${TRADE_COLS}`,
      [id, t.chainId, t.coinId, t.buyerUserId, t.sellerUserId, t.units, t.priceUsd,
       t.amountUsd, t.buyerAddress, t.txId, t.idempotencyKey,
       t.kind ?? "buy", t.offerChainId ?? null, t.offerCoinId ?? null,
       t.offerUnits ?? null, t.offerTxId ?? null,
       feeBps, feeAmount, netAmount]
    );
    if (rows[0]) {
      // Link the fee record to its trade (idempotent; harmless on replay).
      await this.q(`UPDATE fee_ledger SET transaction_id = $1 WHERE idempotency_key = $2`,
        [id, feeKey]);
      return rows[0];
    }
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
         (id, idempotency_key, kind, chain_id, coin_id, buyer_user_id, seller_user_id,
          buyer_address, units, price_usd, amount_usd, state,
          offer_chain_id, offer_coin_id, offer_units, offer_tx_id, seller_address,
          fee_units, fee_bps, fee_tx_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11::numeric,'started',
               $12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ATTEMPT_COLS}`,
      [id, a.idempotencyKey, a.kind ?? "buy", a.chainId, a.coinId, a.buyerUserId, a.sellerUserId,
       a.buyerAddress, a.units, a.priceUsd, a.amountUsd,
       a.offerChainId ?? null, a.offerCoinId ?? null, a.offerUnits ?? null,
       a.offerTxId ?? null, a.sellerAddress ?? null,
       a.feeUnits ?? null, a.feeBps ?? null, a.feeTxId ?? null]
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

  async setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string; offerTxId?: string; sellerAddress?: string; feeTxId?: string }): Promise<void> {
    await this.q(
      `UPDATE settlement_attempts SET state = $2,
         coin_tx_id = COALESCE($3, coin_tx_id),
         trade_id = COALESCE($4, trade_id),
         error_code = COALESCE($5, error_code),
         offer_tx_id = COALESCE($6, offer_tx_id),
         seller_address = COALESCE($7, seller_address),
         fee_tx_id = COALESCE($8, fee_tx_id),
         updated_at = now()
       WHERE id = $1`,
      [id, state, patch?.coinTxId ?? null, patch?.tradeId ?? null, patch?.errorCode ?? null,
       patch?.offerTxId ?? null, patch?.sellerAddress ?? null, patch?.feeTxId ?? null]
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
  idempotency_key AS "idempotencyKey", created_at AS "createdAt",
  kind,
  offer_chain_id AS "offerChainId", offer_coin_id AS "offerCoinId",
  offer_units AS "offerUnits", offer_tx_id AS "offerTxId",
  fee_bps AS "feeBps", fee_amount AS "feeAmount", net_amount AS "netAmount"`;

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
        "Not enough USD in your cash account. Insufficient balance. Add funds to continue.");
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
  async recordTrade(t: Omit<MarketTrade, "id" | "createdAt" | "feeBps" | "feeAmount" | "netAmount">): Promise<MarketTrade> {
    const existing = this.tradesByKey.get(t.idempotencyKey);
    if (existing) return existing;
    const trade: MarketTrade = { ...t, feeBps: null, feeAmount: null, netAmount: null, id: randomUUID(), createdAt: new Date().toISOString() };
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

  async setAttemptState(id: string, state: SettlementState, patch?: { coinTxId?: string; tradeId?: string; errorCode?: string; offerTxId?: string; sellerAddress?: string; feeTxId?: string }): Promise<void> {
    const a = this.attempts.get(id);
    if (!a) return;
    a.state = state;
    if (patch?.coinTxId) a.coinTxId = patch.coinTxId;
    if (patch?.tradeId) a.tradeId = patch.tradeId;
    if (patch?.errorCode) a.errorCode = patch.errorCode;
    if (patch?.offerTxId) a.offerTxId = patch.offerTxId;
    if (patch?.sellerAddress) a.sellerAddress = patch.sellerAddress;
    if (patch?.feeTxId) a.feeTxId = patch.feeTxId;
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
// 80-bps fee settlement — atomic and idempotent.
//
// CORRECTED buy model: fees are denominated in the PURCHASED ASSET.
//   money leg (Postgres, one transaction):
//     insert fee_ledger row (pending; idempotency guard) ->
//     debit buyer USD (gross) -> credit seller USD (gross, IN FULL)
//   coin leg (sovereign chain, crash-safe):
//     float -> buyer (net units = gross - fee)
//     float -> Phase treasury sovereign address (fee units)
//   fee collection (Postgres, one transaction):
//     mark fee row settled + credit treasury_balances (ticker, fee units)
//
// The seller's USD proceeds are NEVER fee-deducted. The buyer pays the
// quoted gross USD and receives net purchased-asset units.
// ---------------------------------------------------------------------------

export interface BuyFeeSettlement {
  buyerUserId: string;
  sellerUserId: string;
  /** Total the buyer pays (6dp USD). */
  grossUsd: string;
  /** Gross purchased-asset units (whole coins). */
  grossUnits: bigint;
  /** Phase fee in purchased-asset units (whole coins). */
  feeUnits: bigint;
  /** Buyer net units = grossUnits - feeUnits (whole coins). */
  netUnits: bigint;
  feeBps: number;
  /** Fee idempotency key — guards the whole money leg. */
  feeKey: string;
  coinId: string | null;
  /** Purchased-asset ticker (the fee denomination). */
  ticker: string;
}

/**
 * Atomic buy money leg with the 80-bps fee, in ONE Postgres transaction:
 *   insert fee row (pending) -> debit buyer USD (gross) ->
 *   credit seller USD (gross, in full — no fee deducted from proceeds)
 *
 * The fee itself is coin-denominated and is only collected on-chain in the
 * coin leg; the fee row stays 'pending' until then. There is no USD fee
 * split: the seller receives the full gross proceeds.
 *
 * Idempotent: the fee row is inserted FIRST under its idempotency key; a
 * retry after a crash between COMMIT and the attempt-state update sees the
 * existing row and returns { replayed: true } WITHOUT moving cash twice.
 * This also closes the pre-existing double-debit hazard on money-leg retry.
 */
export async function settleBuyCashWithFee(s: BuyFeeSettlement): Promise<{ replayed: boolean }> {
  const treasuryId = getTreasuryAccountId();
  if (s.grossUnits < 0n || s.feeUnits < 0n || s.netUnits !== s.grossUnits - s.feeUnits) {
    throw new Error("buy_fee_math_mismatch");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Treasury account row must exist before the balance-sheet FK can
    // reference it — inside this transaction, not on a separate connection.
    await ensureTreasuryAccount(treasuryId, client);
    const { created } = await recordFee(client, {
      idempotencyKey: s.feeKey,
      transactionId: null,
      transactionType: "marketplace_buy",
      userId: s.buyerUserId, // fee payer = buyer (deducted from received coins)
      assetId: s.coinId,
      assetSymbol: s.ticker,
      grossQuantity: coinUnitsToDecimal(s.grossUnits),
      feeBps: s.feeBps,
      feeQuantity: coinUnitsToDecimal(s.feeUnits),
      netQuantity: coinUnitsToDecimal(s.netUnits),
      treasuryAccountId: treasuryId,
      status: "pending",
    });
    if (!created) {
      // This money leg already settled — do not move cash again.
      await client.query("ROLLBACK");
      return { replayed: true };
    }
    const debit = await client.query(
      `UPDATE market_balances SET balance = balance - $1::numeric, updated_at = now()
       WHERE user_id = $2 AND currency = 'USD' AND balance >= $1::numeric`,
      [s.grossUsd, s.buyerUserId]
    );
    if (debit.rowCount === 0) {
      throw new MarketplaceHttpError(402, "insufficient_funds",
        "Not enough USD in your cash account. Insufficient balance. Add funds to continue.");
    }
    // Seller proceeds: the FULL gross. The Phase fee is collected in the
    // purchased asset, never deducted from seller proceeds.
    await client.query(
      `INSERT INTO market_balances (user_id, currency, balance)
       VALUES ($1, 'USD', $2::numeric)
       ON CONFLICT (user_id, currency)
       DO UPDATE SET balance = market_balances.balance + EXCLUDED.balance, updated_at = now()`,
      [s.sellerUserId, s.grossUsd]
    );
    await client.query("COMMIT");
    return { replayed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface BuyFeeCollection {
  feeKey: string;
  /** Purchased-asset ticker (the fee denomination). */
  ticker: string;
  /** Fee units collected on-chain (whole coins). */
  feeUnits: bigint;
  /** On-chain tx id of the float -> treasury fee transfer (null when fee is 0). */
  feeTxId: string | null;
}

/**
 * Record the on-chain fee collection after the buy coin leg completes:
 * mark the fee row settled and credit the treasury balance sheet
 * (ticker, fee units) — atomically. Idempotent on the fee key.
 */
export async function recordBuyFeeSettlement(c: BuyFeeCollection): Promise<void> {
  const treasuryId = getTreasuryAccountId();
  if (c.feeUnits < 0n) throw new Error("negative_fee_units");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureTreasuryAccount(treasuryId, client);
    // Only credit the treasury when this call actually transitioned the
    // fee pending -> settled. Retries on an already-settled fee are safe
    // no-ops (never double-credit).
    const transitioned = await markFeeSettled(client, c.feeKey, c.feeTxId);
    if (transitioned && c.feeUnits > 0n) {
      await creditTreasury(client, treasuryId, c.ticker, coinUnitsToDecimal(c.feeUnits));
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface BuyFeeCompensation {
  sellerUserId: string;
  buyerUserId: string;
  /** Full gross USD the seller received (and must return). */
  grossUsd: string;
  feeKey: string;
  reason: string;
}

/**
 * Best-effort unwind of the buy money leg (coin leg failed after cash moved):
 *   seller -> buyer (gross USD), fee marked reversed — atomically, or not at
 *   all. The coin-denominated fee was never collected on-chain in the normal
 *   path (its transfer runs inside the failed coin leg), so no treasury
 *   movement is needed; the defensive 'settled' branch claws back the
 *   balance-sheet credit if one ever exists.
 * Never throws: callers log and continue with the original error, matching
 * the pre-existing compensation behavior.
 */
export async function compensateBuyCashWithFee(c: BuyFeeCompensation): Promise<void> {
  const treasuryId = getTreasuryAccountId();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const feeRows = await client.query(
      `SELECT status, fee_quantity::text AS "feeQuantity", asset_symbol AS "assetSymbol"
       FROM fee_ledger WHERE idempotency_key = $1`, [c.feeKey]);
    const feeRow = feeRows.rows[0] as
      | { status: string; feeQuantity: string; assetSymbol: string } | undefined;
    if (!feeRow || (feeRow.status !== "pending" && feeRow.status !== "settled")) {
      await client.query("ROLLBACK");
      return; // nothing (or already reversed/failed) — do not double-compensate
    }
    const sellerDebit = await client.query(
      `UPDATE market_balances SET balance = balance - $1::numeric, updated_at = now()
       WHERE user_id = $2 AND currency = 'USD' AND balance >= $1::numeric`,
      [c.grossUsd, c.sellerUserId]
    );
    if (sellerDebit.rowCount === 0) throw new Error("seller_balance_insufficient_for_compensation");
    await client.query(
      `INSERT INTO market_balances (user_id, currency, balance)
       VALUES ($1, 'USD', $2::numeric)
       ON CONFLICT (user_id, currency)
       DO UPDATE SET balance = market_balances.balance + EXCLUDED.balance, updated_at = now()`,
      [c.buyerUserId, c.grossUsd]
    );
    if (feeRow.status === "settled") {
      // Defensive: a settled fee means the fee was collected on-chain before
      // the failure — claw back the balance-sheet credit. (The on-chain
      // units themselves are reversed by the caller's coin-leg compensation.)
      await debitTreasury(client, treasuryId, feeRow.assetSymbol, feeRow.feeQuantity);
      await markFeeReversed(client, c.feeKey, c.reason);
    } else {
      // Pending: the fee never left the float — void the row.
      await client.query(
        `UPDATE fee_ledger
         SET status = 'reversed', reversed_at = now(), reversal_reason = $2
         WHERE idempotency_key = $1 AND status = 'pending'`,
        [c.feeKey, c.reason]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[marketplace] fee compensation failed:", (err as Error).message);
    await auditLog("system", "fee_compensation_failed", "fee", c.feeKey,
      { reason: c.reason, error: (err as Error).message });
  } finally {
    client.release();
  }
}

/**
 * Record a swap fee (coin-denominated) after the on-chain fee transfer.
 * Idempotent on the fee key; credits the treasury balance sheet.
 */
export async function recordSwapFee(input: {
  feeKey: string;
  buyerUserId: string;
  coinId: string | null;
  assetSymbol: string;
  grossUnits: string;
  feeBps: number;
  feeUnits: string;
  netUnits: string;
  feeTxId: string | null;
}): Promise<void> {
  const treasuryId = getTreasuryAccountId();
  let client;
  try {
    client = await getPool().connect();
  } catch {
    // No database (dev/test without DATABASE_URL): the on-chain fee transfer
    // to the treasury is the source of truth for funds; the accounting row
    // is best-effort. Production always has a live DB.
    console.warn("[marketplace] recordSwapFee: database unreachable — skipping fee accounting row");
    return;
  }
  try {
    await client.query("BEGIN");
    await ensureTreasuryAccount(treasuryId, client);
    const { created } = await recordFee(client, {
      idempotencyKey: input.feeKey,
      transactionId: null,
      transactionType: "marketplace_swap",
      userId: input.buyerUserId, // fee payer = buyer (deducted from received coins)
      assetId: input.coinId,
      assetSymbol: input.assetSymbol,
      grossQuantity: input.grossUnits,
      feeBps: input.feeBps,
      feeQuantity: input.feeUnits,
      netQuantity: input.netUnits,
      treasuryAccountId: treasuryId,
      coinTxId: input.feeTxId,
      status: "settled",
    });
    if (created && toMicroUnits(input.feeUnits) > 0n) {
      await creditTreasury(client, treasuryId, input.assetSymbol, input.feeUnits);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Rate limiting — shared helper (see rate-limit.ts). Kept re-exported here
// for backward compatibility with the previous local definition.
// ---------------------------------------------------------------------------

export const checkRateLimit = sharedCheckRateLimit;

function clientIp(ctx: MarketplaceCtx): string {
  return clientIpFromHeaders(ctx.req.headers);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared swap settlement — used by instant POST /trades/swap AND by accepted
// swap offers (offers.ts). The caller supplies the agreed terms; validation,
// balance pre-checks, the 80-bps fee math, both settlement legs, and the
// trade record are identical for both paths.
//
// targetUnits is the GROSS whole target-coin units taken from the public
// float. The Phase fee is assessed in the target coin:
//   fee = floor(targetUnits * feeBps / 10000); buyer receives targetUnits - fee.
// Integer math throughout — no floats.
//
// Settlement states: started -> offer_moved -> target_queued -> coin_confirmed.
// Failure states: failed (offer leg never moved), compensated (offer leg
// reversed after the target leg failed). reconcileSettlements() resumes or
// unwinds stuck attempts at boot; a retried idempotency key resumes.
// ---------------------------------------------------------------------------

export interface SwapSettlementInput {
  /** Target coin's chain (the coin being bought). */
  chainId: string;
  /** Buyer's own coin chain (the coin being offered). */
  offerChainId: string;
  /** Whole coins the buyer gives. */
  offerUnits: bigint;
  /**
   * GROSS whole target coins taken from float. When omitted, derived from the
   * live quote: floor(offerUnits * offerPrice / targetPrice). Offer acceptance
   * passes the explicitly agreed gross instead.
   */
  targetUnits?: bigint;
  buyerUserId: string;
  buyerAddress: string;
  idempotencyKey: string;
}

export interface SwapFeeBreakdown {
  feeBps: number;
  assetSymbol: string;
  grossUnits: string;
  feeUnits: string;
  buyerReceivesUnits: string;
  feeTxId: string | null;
  treasuryAddress: string;
  disclosure: string;
}

export interface SwapSettlementResult {
  trade: MarketTrade;
  idempotentReplay: boolean;
  offerTxId?: string | null;
  targetTxId?: string | null;
  fee?: SwapFeeBreakdown | null;
}

/** Integer-exact swap quote: gross target units for an offer (floor). */
export function quoteSwapTargetUnits(offerUnits: bigint, offerPriceMicro: bigint, targetPriceMicro: bigint): bigint {
  return (offerUnits * offerPriceMicro) / targetPriceMicro;
}

/**
 * Minimal gross target units G such that the buyer nets at least `netWanted`
 * after the fee: net(G) = G - floor(G * feeBps / 10000). Any dust (< 1 coin)
 * goes to the buyer.
 */
export function grossUnitsForNet(netWanted: bigint, feeBps: number): bigint {
  if (netWanted < 1n) {
    throw new MarketplaceHttpError(422, "amount_too_small", "Request must be at least one whole coin.");
  }
  let gross = netWanted + (netWanted * BigInt(feeBps)) / BigInt(10000 - feeBps) + 1n;
  const net = (g: bigint) => g - (g * BigInt(feeBps)) / 10000n;
  while (net(gross) < netWanted) gross += 1n;
  while (gross > 1n && net(gross - 1n) >= netWanted) gross -= 1n;
  return gross;
}

export async function executeSwapSettlement(input: SwapSettlementInput): Promise<SwapSettlementResult> {
  const {
    chainId, offerChainId, offerUnits, buyerUserId, buyerAddress,
    idempotencyKey: key, targetUnits: targetUnitsOverride,
  } = input;
  if (!isValidAddress(buyerAddress)) {
    throw new MarketplaceHttpError(422, "invalid_buyer_address", "buyerAddress must be a valid ph1 address.");
  }
  if (offerUnits < 1n) {
    throw new MarketplaceHttpError(422, "amount_too_small", "offerUnits must be at least one whole coin.");
  }

  const ms = await getStoreAsync();

  const issuance = await getIssuanceStore();

  const target: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
  if (!target) throw new MarketplaceHttpError(404, "coin_not_found", "No issued coin for this chain.");
  const offer: IssuanceCoin | null = await issuance.getCoinByChainId(offerChainId);
  if (!offer) throw new MarketplaceHttpError(404, "offer_coin_not_found", "No issued coin for the offer chain.");

  const targetPrice = Number(target.priceUsd);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    throw new MarketplaceHttpError(422, "coin_not_priced", "The target coin has no trade price yet.");
  }
  const offerPrice = Number(offer.priceUsd);
  if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
    throw new MarketplaceHttpError(422, "offer_not_priced", "Your offered coin has no trade price yet.");
  }

  const sellerUserId = target.userId;
  if (buyerUserId === sellerUserId) {
    throw new MarketplaceHttpError(422, "self_trade",
      "You can't swap for your own coin — switch to a different account to trade it.");
  }
  if (offer.userId !== buyerUserId) {
    throw new MarketplaceHttpError(422, "offer_not_yours",
      "You can only offer coins you issued.");
  }
  const sellerAddress = target.issuerAddress;
  if (!sellerAddress) {
    throw new MarketplaceHttpError(422, "issuer_no_address",
      "The target coin's issuer has no sovereign wallet address on file — swaps are unavailable for it.");
  }

  // Integer-exact: offer value = offer_units * offer_price (microunits);
  // target units = floor(offer_value / target_price). Raw DB strings.
  const targetPriceMicro = toMicroUnits(String(target.priceUsd));
  const offerPriceMicro = toMicroUnits(String(offer.priceUsd));
  const offerValueMicro = offerUnits * offerPriceMicro;
  const targetUnits = targetUnitsOverride ?? quoteSwapTargetUnits(offerUnits, offerPriceMicro, targetPriceMicro);
  if (targetUnits < 1n) {
    throw new MarketplaceHttpError(422, "amount_too_small",
      "The offer is worth less than one whole target coin at current prices.");
  }
  const offerUnitsBase = offerUnits.toString();

  // 80-bps Phase fee (server-authoritative) on swaps: assessed in the
  // TARGET coin — fee = floor(targetUnits * bps / 10000) whole coins,
  // deducted from the coins the buyer receives and sent on-chain to the
  // Phase treasury address. Fail closed when no treasury is configured.
  const freshSwapFeeCfg = await getFeeConfig();
  const treasurySovereignAddr = requireTreasurySovereignAddress();
  const swapFeeUnitsBig = (targetUnits * BigInt(freshSwapFeeCfg.feeBps)) / 10000n;

  // Pre-check the buyer's offer balance before writing anything.
  // The issuer's retained stake lives at the coin's recorded issuerAddress
  // (credited at genesis); a device wallet can change across installs, so
  // when the client-supplied address doesn't hold the offered units, fall
  // back to the recorded issuer address. The caller is already proven to be
  // this coin's issuer (offer.userId === buyerUserId is enforced above), so
  // debiting the recorded address is safe. Settlement below uses the
  // resolved address for both legs.
  let effectiveBuyerAddress = buyerAddress;
  let offerBal: bigint;
  try {
    offerBal = BigInt(getChainBalance(offerChainId, buyerAddress));
  } catch (err) {
    throw new MarketplaceHttpError(404, "offer_coin_not_found", "The offer chain is unknown on this node.");
  }
  if (offerBal < offerUnits && isValidAddress(offer.issuerAddress) && offer.issuerAddress !== buyerAddress) {
    let issuerBal = 0n;
    try { issuerBal = BigInt(getChainBalance(offerChainId, offer.issuerAddress)); } catch { issuerBal = 0n; }
    if (issuerBal >= offerUnits) {
      effectiveBuyerAddress = offer.issuerAddress;
      offerBal = issuerBal;
    }
  }
  if (offerBal < offerUnits) {
    throw new MarketplaceHttpError(409, "insufficient_offer_balance",
      "You don't hold enough of your offered coin for this swap.");
  }
  // Pre-check the target float before writing anything.
  const floatBal = BigInt(getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS));
  if (floatBal < targetUnits) {
    throw new MarketplaceHttpError(409, "insufficient_float",
      "The target coin's public float doesn't have enough coins left for this swap.");
  }

  // Idempotent attempt: same key -> resume or replay, never double-settle.
  let attempt: SettlementAttempt;
  {
    const { attempt: a, created } = await ms.createAttempt({
      idempotencyKey: key,
      kind: "swap",
      chainId,
      coinId: target.id,
      buyerUserId,
      sellerUserId,
      buyerAddress: effectiveBuyerAddress,
      units: coinUnitsToDecimal(targetUnits),
      priceUsd: fromMicroUnits(targetPriceMicro),
      amountUsd: fromMicroUnits(offerValueMicro),
      offerChainId,
      offerCoinId: offer.id,
      offerUnits: coinUnitsToDecimal(offerUnits),
      offerTxId: null,
      sellerAddress,
      feeUnits: coinUnitsToDecimal(swapFeeUnitsBig),
      feeBps: freshSwapFeeCfg.feeBps,
      feeTxId: null,
    });
    attempt = a;
    if (!created) {
      if (attempt.tradeId) {
        const replay = await ms.getTradeByIdempotency(key);
        if (replay) {
          return { trade: replay, idempotentReplay: true };
        }
      }
      if ((TERMINAL_STATES as string[]).includes(attempt.state)) {
        throw new MarketplaceHttpError(409, "already_attempted",
          "This swap was already attempted and did not complete. Use a new idempotency key.");
      }
      if (attempt.state !== "started" && attempt.state !== "offer_moved" && attempt.state !== "target_queued") {
        throw new MarketplaceHttpError(409, "settlement_in_progress",
          "This swap is already being processed — wait a moment and check history.");
      }
      // else: resume the crashed attempt from its recorded state.
    }
  }
  await auditLog(buyerUserId, "settlement_started", "settlement", attempt.id,
    { kind: "swap", chainId, offerChainId, targetUnits: targetUnits.toString(), offerUnits: offerUnits.toString() });

  // A resumed attempt keeps the fee values recorded when it was created.
  // The split is deterministic from (units, feeBps), both persisted.
  const swapFeeBps = attempt.feeBps ?? freshSwapFeeCfg.feeBps;
  const swapGrossUnits = decimalToCoinUnits(attempt.units);
  const swapFeeUnits = attempt.feeUnits !== null && attempt.feeUnits !== undefined
    ? decimalToCoinUnits(attempt.feeUnits)
    : (swapGrossUnits * BigInt(swapFeeBps)) / 10000n;
  const swapNetUnits = swapGrossUnits - swapFeeUnits;
  const swapFeeKey = feeIdempotencyKey("swap", key);

  // Offer leg: buyer -> target issuer on the OFFER chain. Skipped when
  // resuming an attempt that already moved the offer.
  let offerTxId = attempt.offerTxId;
  if (attempt.state === "started") {
    try {
      const settled = await settleOperatorTransfer(offerChainId, effectiveBuyerAddress, sellerAddress,
        offerUnitsBase, `swap offer ${offerUnits} ${offer.ticker} for ${target.ticker}`);
      offerTxId = settled.tx_id;
    } catch (err) {
      await ms.setAttemptState(attempt.id, "failed",
        { errorCode: (err as { code?: string }).code ?? "offer_leg_failed" });
      throw err;
    }
    await ms.setAttemptState(attempt.id, "offer_moved", { offerTxId: offerTxId! });
    attempt.state = "offer_moved";
    attempt.offerTxId = offerTxId;
    await auditLog(buyerUserId, "swap_offer_moved", "settlement", attempt.id,
      { offerTxId, offerChainId, offerUnits: offerUnits.toString(), sellerAddress });
  }

  // Target leg (crash-safe): float -> buyer (net of the Phase fee) on the
  // TARGET chain, then float -> Phase treasury (the fee). Each transfer is
  // persisted to the attempt row immediately after it succeeds, so a
  // crash between the two can never double-transfer on retry. Skipped
  // when resuming an attempt that already queued them. On failure the
  // moved legs are reversed (best effort) and the attempt is compensated.
  let targetTxId = attempt.coinTxId;
  let feeTxId = attempt.feeTxId;
  if (attempt.state === "offer_moved") {
    try {
      if (!targetTxId) {
        const buyerSettled = await settleFloatTransfer(chainId, effectiveBuyerAddress, swapNetUnits.toString(),
          `swap receive ${swapNetUnits} ${target.ticker} (net of ${swapFeeUnits} ${target.ticker} Phase fee)`);
        targetTxId = buyerSettled.tx_id;
        await ms.setAttemptState(attempt.id, "offer_moved", { coinTxId: targetTxId });
      }
      if (!feeTxId && swapFeeUnits > 0n) {
        const feeSettled = await settleFloatTransfer(chainId, treasurySovereignAddr,
          swapFeeUnits.toString(), `Phase swap fee ${swapFeeUnits} ${target.ticker}`);
        feeTxId = feeSettled.tx_id;
        await ms.setAttemptState(attempt.id, "offer_moved", { feeTxId });
      }
    } catch (err) {
      // Reverse the buyer's net receipt (best effort), then the offer leg.
      try {
        if (targetTxId) {
          await settleOperatorTransfer(chainId, effectiveBuyerAddress, PUBLIC_FLOAT_ADDRESS,
            swapNetUnits.toString(), "swap compensation: return net target units to float");
        }
      } catch { /* best effort — the attempt row records what happened */ }
      try {
        await settleOperatorTransfer(offerChainId, sellerAddress, effectiveBuyerAddress,
          offerUnitsBase, "swap compensation reversal");
      } catch { /* best effort — the attempt row records what happened */ }
      await ms.setAttemptState(attempt.id, "compensated",
        { errorCode: (err as { code?: string }).code ?? "target_leg_failed" });
      console.error("[marketplace] swap target leg failed after offer leg; compensated:", (err as Error).message);
      throw err;
    }
    await ms.setAttemptState(attempt.id, "target_queued",
      { coinTxId: targetTxId!, feeTxId: feeTxId ?? undefined });
    attempt.state = "target_queued";
    attempt.coinTxId = targetTxId;
    attempt.feeTxId = feeTxId;
    // Immutable fee record (idempotent) + treasury balance-sheet credit.
    await recordSwapFee({
      feeKey: swapFeeKey,
      buyerUserId,
      coinId: target.id,
      assetSymbol: target.ticker,
      grossUnits: coinUnitsToDecimal(swapGrossUnits),
      feeBps: swapFeeBps,
      feeUnits: coinUnitsToDecimal(swapFeeUnits),
      netUnits: coinUnitsToDecimal(swapNetUnits),
      feeTxId,
    });
    await auditLog(buyerUserId, "swap_target_queued", "settlement", attempt.id,
      { targetTxId, feeTxId, feeUnits: swapFeeUnits.toString(), feeBps: swapFeeBps });
  }

  const trade = await ms.recordTrade({
    kind: "swap",
    chainId,
    coinId: target.id,
    buyerUserId,
    sellerUserId,
    units: coinUnitsToDecimal(targetUnits),
    priceUsd: fromMicroUnits(targetPriceMicro),
    amountUsd: fromMicroUnits(offerValueMicro),
    buyerAddress: effectiveBuyerAddress,
    txId: targetTxId,
    idempotencyKey: key,
    offerChainId,
    offerCoinId: offer.id,
    offerUnits: coinUnitsToDecimal(offerUnits),
    offerTxId,
  });
  await ms.setAttemptState(attempt.id, "coin_confirmed",
    { tradeId: trade.id, coinTxId: targetTxId ?? undefined });
  await auditLog(buyerUserId, "trade_recorded", "trade", trade.id,
    { kind: "swap", chainId, targetUnits: targetUnits.toString(), offerUnits: offerUnits.toString(), offerTxId, targetTxId });

  return {
    trade,
    idempotentReplay: false,
    offerTxId,
    targetTxId,
    fee: {
      feeBps: swapFeeBps,
      assetSymbol: target.ticker,
      grossUnits: coinUnitsToDecimal(swapGrossUnits),
      feeUnits: coinUnitsToDecimal(swapFeeUnits),
      buyerReceivesUnits: coinUnitsToDecimal(swapNetUnits),
      feeTxId,
      treasuryAddress: treasurySovereignAddr,
      disclosure: FEE_DISCLOSURE,
    },
  };
}

  // --- POST /api/v1/trades/swap ---
  // Body: { userId, chainId (target coin), buyerAddress, offerChainId, offerUnits, idempotencyKey? }

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

  // The userId for private routes ALWAYS comes from the authenticated Bearer
  // session. A client-supplied userId in the body/query is never trusted: if
  // one is present and disagrees with the session, the request is rejected.
  const requireUserId = async (ctx: MarketplaceCtx): Promise<string> => {
    const authed = await resolveBearerUserId(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    const body = asRecord(ctx.body);
    const claimed = str(body.userId) || str(ctx.query.get("userId"));
    if (claimed && claimed !== authed) {
      throw new HttpError(403, "forbidden", "This request is for a different user.");
    }
    return authed;
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
      const buyerUserId = await requireUserId(ctx);
      const chainId = str(body.chainId);
      if (!chainId) throw new HttpError(400, "missing_chain_id", "Body must include chainId.");
      const buyerAddress = str(body.buyerAddress);
      if (!isValidAddress(buyerAddress)) {
        throw new HttpError(422, "invalid_buyer_address", "buyerAddress must be a valid ph1 address.");
      }
      const amountMicro = parsePositiveMicroUnits(body.amountUsd, "amountUsd");
      const key = idempotencyKey(ctx, `buy-${chainId}-${Date.now()}`);

      const ms = await getStoreAsync();

      const issuance = await getIssuanceStore();
      const coin: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
      if (!coin) throw new HttpError(404, "coin_not_found", "No issued coin for this chain.");
      const priceUsd = Number(coin.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new HttpError(422, "coin_not_priced", "This coin has no trade price yet.");
      }
      // Authoritative conversion uses the raw DB decimal string — never the
      // float round-trip (Number -> String can lose microunit precision).
      const priceMicro = toMicroUnits(String(coin.priceUsd));
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
      // Integer-exact: units = floor(amount_micro / price_micro).
      const units = amountMicro / priceMicro;
      if (units < 1n) {
        throw new HttpError(422, "amount_too_small", "amountUsd buys less than one whole coin at this price.");
      }
      const chargedUsd = fromMicroUnits(units * priceMicro);

      // 80-bps Phase fee (server-authoritative): assessed on the gross
      // PURCHASED-ASSET UNITS, deducted from the coins the BUYER receives
      // and sent on-chain to the Phase treasury sovereign address.
      // Integer-exact: fee = floor(units * bps / 10000); net = units - fee.
      // The buyer pays exactly the quoted gross USD; the seller receives
      // the full gross proceeds (no fee is deducted from seller proceeds).
      const freshFeeCfg = await getFeeConfig();

      // Pre-check the float before touching money.
      const floatBal = BigInt(getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS));
      if (floatBal < units) {
        throw new HttpError(409, "insufficient_float",
          "The public float doesn't have enough coins left for this purchase.");
      }

      // Idempotent attempt: same key -> resume or replay, never double-settle.
      let attempt: SettlementAttempt;
      {
        const { attempt: a, created } = await ms.createAttempt({
          idempotencyKey: key,
          kind: "buy",
          chainId,
          coinId: coin.id,
          buyerUserId,
          sellerUserId,
          buyerAddress,
          units: coinUnitsToDecimal(units),
          priceUsd: fromMicroUnits(priceMicro),
          amountUsd: chargedUsd,
          offerChainId: null,
          offerCoinId: null,
          offerUnits: null,
          offerTxId: null,
          sellerAddress: null,
          feeUnits: null,
          feeBps: freshFeeCfg.feeBps,
          feeTxId: null,
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
        { chainId, units: units.toString(), amountUsd: chargedUsd });

      // A resumed attempt keeps the fee rate recorded when it was created,
      // so a mid-flight config change can never alter an in-flight trade.
      // The fee split is deterministic from (units, feeBps), both persisted
      // on the attempt, so retries always reuse the exact same split.
      const feeBps = attempt.feeBps ?? freshFeeCfg.feeBps;
      const feeUnits = (units * BigInt(feeBps)) / 10000n;
      const netUnits = units - feeUnits;
      const feeKey = feeIdempotencyKey("buy", key);

      // Money leg: debit buyer (gross USD), credit seller (gross USD in
      // full), insert the pending fee record — atomically in one Postgres
      // transaction. The coin-denominated fee is collected on-chain in the
      // coin leg; no USD fee split exists. Skipped when resuming an
      // attempt that already moved cash (the fee row idempotency guard
      // inside settleBuyCashWithFee makes even a missed state update safe).
      if (attempt.state === "started") {
        try {
          await settleBuyCashWithFee({
            buyerUserId,
            sellerUserId,
            grossUsd: chargedUsd,
            grossUnits: units,
            feeUnits,
            netUnits,
            feeBps,
            feeKey,
            coinId: coin.id,
            ticker: coin.ticker,
          });
        } catch (err) {
          await ms.setAttemptState(attempt.id, "failed",
            { errorCode: (err as { code?: string }).code ?? "cash_leg_failed" });
          throw err;
        }
        // Persist the fee units decided at creation so retries and the
        // reconciliation pass reuse the exact split.
        await ms.setAttemptState(attempt.id, "cash_moved");
        await getPool().query(
          `UPDATE settlement_attempts SET fee_units = $2 WHERE id = $1`,
          [attempt.id, coinUnitsToDecimal(feeUnits)]
        );
        attempt.state = "cash_moved";
        await auditLog(buyerUserId, "settlement_cash_moved", "settlement", attempt.id,
          { amountUsd: chargedUsd, feeBps, feeUnits: feeUnits.toString(), netUnits: netUnits.toString(), sellerUserId });
      } else {
        // Resumed after cash moved: recover the exact fee split from the
        // immutable fee record (authoritative over any recomputation).
        const feeRow = await getFeeByIdempotencyKey(feeKey);
        if (!feeRow) {
          await ms.setAttemptState(attempt.id, "failed", { errorCode: "fee_record_missing" });
          throw new HttpError(409, "settlement_inconsistent",
            "The purchase cash leg cannot be verified. Contact support with this attempt id.");
        }
        // Same idempotency key must mean the same purchase parameters.
        if (feeRow.grossQuantity !== coinUnitsToDecimal(units) || feeRow.feeBps !== feeBps) {
          throw new HttpError(409, "idempotency_key_conflict",
            "This idempotency key was already used for a different purchase amount.");
        }
      }

      // Coin leg (crash-safe): float -> buyer (net units, the primary
      // obligation) then float -> Phase treasury (fee units). Each transfer
      // is persisted to the attempt row immediately after it succeeds, so a
      // crash between the two can never double-transfer on retry.
      // Fail closed: when a fee is owed, the treasury address must be
      // configured — never settle trades while fee collection is impossible.
      let txId = attempt.coinTxId;
      let feeTxId = attempt.feeTxId;
      if (attempt.state === "cash_moved") {
        const treasuryAddr = feeUnits > 0n ? requireTreasurySovereignAddress() : null;
        try {
          if (!txId) {
            const settled = await settleFloatTransfer(chainId, buyerAddress, netUnits.toString(),
              `marketplace buy ${netUnits} ${coin.ticker} (net of Phase fee)`);
            txId = settled.tx_id;
            await ms.setAttemptState(attempt.id, "cash_moved", { coinTxId: txId });
          }
          if (!feeTxId && feeUnits > 0n) {
            const feeSettled = await settleFloatTransfer(chainId, treasuryAddr!, feeUnits.toString(),
              `Phase treasury fee ${feeUnits} ${coin.ticker}`);
            feeTxId = feeSettled.tx_id;
            await ms.setAttemptState(attempt.id, "cash_moved", { feeTxId });
          }
        } catch (err) {
          // Best-effort: reverse any on-chain transfer that did complete
          // (buyer -> float) before unwinding the money leg.
          if (txId) {
            try {
              await settleOperatorTransfer(chainId, buyerAddress, PUBLIC_FLOAT_ADDRESS,
                netUnits.toString(), "reversed marketplace buy (coin leg failed)");
            } catch (e) {
              console.error("[marketplace] buy coin-leg reversal failed:",
                (e as Error).message);
            }
          }
          // Compensate: unwind the money leg (seller -> buyer, gross),
          // best effort. The fee was never collected on-chain here.
          await compensateBuyCashWithFee({
            sellerUserId,
            buyerUserId,
            grossUsd: chargedUsd,
            feeKey,
            reason: "coin_leg_failed",
          });
          await ms.setAttemptState(attempt.id, "compensated",
            { errorCode: (err as { code?: string }).code ?? "coin_leg_failed" });
          console.error("[marketplace] coin leg failed after money leg; compensated:", (err as Error).message);
          throw err;
        }
        // Fee collection recorded atomically: fee row settled + treasury
        // balance sheet credited. Idempotent on the fee key.
        await recordBuyFeeSettlement({
          feeKey,
          ticker: coin.ticker,
          feeUnits,
          feeTxId,
        });
        await ms.setAttemptState(attempt.id, "coin_queued", { coinTxId: txId!, feeTxId: feeTxId ?? undefined });
        attempt.state = "coin_queued";
        attempt.coinTxId = txId;
        attempt.feeTxId = feeTxId;
        await auditLog(buyerUserId, "settlement_coin_queued", "settlement", attempt.id,
          { txId, feeTxId, netUnits: netUnits.toString(), feeUnits: feeUnits.toString() });
      }

      const trade = await ms.recordTrade({
        kind: "buy",
        chainId,
        coinId: coin.id,
        buyerUserId,
        sellerUserId,
        units: coinUnitsToDecimal(units),
        priceUsd: fromMicroUnits(priceMicro),
        amountUsd: chargedUsd,
        buyerAddress,
        txId,
        idempotencyKey: key,
        offerChainId: null,
        offerCoinId: null,
        offerUnits: null,
        offerTxId: null,
      });
      await ms.setAttemptState(attempt.id, "coin_confirmed", { tradeId: trade.id, coinTxId: txId ?? undefined });
      await auditLog(buyerUserId, "trade_recorded", "trade", trade.id,
        { chainId, units: units.toString(), amountUsd: chargedUsd, txId });

      const buyerBalance = await ms.getBalance(buyerUserId, USD);
      sendJson(ctx.res, 201, {
        ...NETWORK_ENVELOPE,
        idempotentReplay: false,
        trade,
        txId,
        buyerBalanceUsd: buyerBalance,
        fee: {
          feeBps,
          assetSymbol: coin.ticker,
          grossUnits: coinUnitsToDecimal(units),
          feeUnits: coinUnitsToDecimal(feeUnits),
          buyerReceivesUnits: coinUnitsToDecimal(netUnits),
          grossUsd: chargedUsd,
          sellerReceivesUsd: chargedUsd,
          treasuryAccountId: getTreasuryAccountId(),
          feeTxId,
          disclosure: FEE_DISCLOSURE,
        },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/trades/quote?chainId=&amountUsd= ---
  // Server-authoritative pre-confirmation quote for buys. The client displays
  // these values; the final settlement always recomputes them server-side.
  // The Phase fee is denominated in the purchased asset: the buyer receives
  // net units (gross - fee); the seller receives the full gross USD.
  route("GET", "/api/v1/trades/quote", async (ctx) => {
    try {
      if (!checkRateLimit(`quote:${clientIp(ctx)}`, 120, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many quote requests — wait a moment.");
      }
      const chainId = ctx.query.get("chainId") ?? "";
      if (!chainId) throw new HttpError(400, "missing_chain_id", "Query must include chainId.");
      const amountMicro = parsePositiveMicroUnits(ctx.query.get("amountUsd"), "amountUsd");
      const issuance = await getIssuanceStore();
      const coin: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
      if (!coin) throw new HttpError(404, "coin_not_found", "No issued coin for this chain.");
      const priceUsd = Number(coin.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new HttpError(422, "coin_not_priced", "This coin has no trade price yet.");
      }
      const priceMicro = toMicroUnits(String(coin.priceUsd)); // raw DB string, not the float
      // Integer-exact: units = floor(amount / price); fee = floor(units * bps / 10000).
      const units = amountMicro / priceMicro;
      if (units < 1n) {
        throw new HttpError(422, "amount_too_small", "amountUsd buys less than one whole coin at this price.");
      }
      const grossUsd = fromMicroUnits(units * priceMicro);
      const cfg = await getFeeConfig();
      const feeUnits = (units * BigInt(cfg.feeBps)) / 10000n;
      const netUnits = units - feeUnits;
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        quote: {
          kind: "buy",
          chainId,
          ticker: coin.ticker,
          priceUsd: fromMicroUnits(priceMicro),
          grossUnits: coinUnitsToDecimal(units),
          grossUsd,
          feeBps: cfg.feeBps,
          feeAssetSymbol: coin.ticker,
          feeUnits: coinUnitsToDecimal(feeUnits),
          buyerReceivesUnits: coinUnitsToDecimal(netUnits),
          sellerReceivesUsd: grossUsd,
          treasuryAccountId: getTreasuryAccountId(),
          disclosure: FEE_DISCLOSURE,
        },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/trades/swap-quote?chainId=&offerChainId=&offerUnits=[&requestUnits=] ---
  // Two directions:
  //   offerUnits   -> what the buyer receives (net of the fee).
  //   requestUnits -> the offerUnits required so the buyer nets requestUnits.
  // Exactly one of offerUnits / requestUnits must be given.
  route("GET", "/api/v1/trades/swap-quote", async (ctx) => {
    try {
      if (!checkRateLimit(`squote:${clientIp(ctx)}`, 120, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many quote requests — wait a moment.");
      }
      const chainId = ctx.query.get("chainId") ?? "";
      const offerChainId = ctx.query.get("offerChainId") ?? "";
      if (!chainId || !offerChainId) {
        throw new HttpError(400, "missing_params", "Query must include chainId and offerChainId.");
      }
      const rawOffer = ctx.query.get("offerUnits");
      const rawRequest = ctx.query.get("requestUnits");
      const hasOffer = rawOffer !== null && rawOffer !== "";
      const hasRequest = rawRequest !== null && rawRequest !== "";
      if (hasOffer === hasRequest) {
        throw new HttpError(400, "missing_params", "Query must include exactly one of offerUnits or requestUnits.");
      }
      const issuance = await getIssuanceStore();
      const target: IssuanceCoin | null = await issuance.getCoinByChainId(chainId);
      const offer: IssuanceCoin | null = await issuance.getCoinByChainId(offerChainId);
      if (!target || !offer) throw new HttpError(404, "coin_not_found", "Unknown coin chain.");
      const targetPrice = Number(target.priceUsd);
      const offerPrice = Number(offer.priceUsd);
      if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(offerPrice) || offerPrice <= 0) {
        throw new HttpError(422, "coin_not_priced", "Both coins need a trade price for swaps.");
      }
      // Integer-exact: target = floor(offer_units * offer_price / target_price),
      // fee = floor(target * bps / 10000), net = target - fee.
      // Raw DB decimal strings — never the float round-trip.
      const targetPriceMicro = toMicroUnits(String(target.priceUsd));
      const offerPriceMicro = toMicroUnits(String(offer.priceUsd));
      const cfg = await getFeeConfig();
      let offerUnits: bigint;
      let targetUnits: bigint;
      if (hasOffer) {
        offerUnits = parseWholeCoinUnits(rawOffer, "offerUnits");
        targetUnits = quoteSwapTargetUnits(offerUnits, offerPriceMicro, targetPriceMicro);
      } else {
        // Inverse: the buyer names the NET units they want; solve for the
        // gross, then the offer that covers it (ceiling — never short).
        const requestUnits = parseWholeCoinUnits(rawRequest, "requestUnits");
        targetUnits = grossUnitsForNet(requestUnits, cfg.feeBps);
        offerUnits = (targetUnits * targetPriceMicro + offerPriceMicro - 1n) / offerPriceMicro;
      }
      if (targetUnits < 1n) {
        throw new HttpError(422, "amount_too_small",
          "The offer is worth less than one whole target coin at current prices.");
      }
      const feeUnits = (targetUnits * BigInt(cfg.feeBps)) / 10000n;
      const netUnits = targetUnits - feeUnits;
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        quote: {
          kind: "swap",
          chainId,
          targetTicker: target.ticker,
          offerChainId,
          offerTicker: offer.ticker,
          offerUnits: offerUnits.toString(),
          grossUnits: coinUnitsToDecimal(targetUnits),
          feeBps: cfg.feeBps,
          feeUnits: coinUnitsToDecimal(feeUnits),
          buyerReceivesUnits: coinUnitsToDecimal(netUnits),
          treasuryAddress: getTreasurySovereignAddress(),
          disclosure: FEE_DISCLOSURE,
        },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/marketplace/coins ---
  // The "issuers online" directory: every issued sovereign coin, newest first.
  // Public — no auth. Powers marketplace browsing: each row carries the
  // float still available to buy, the trade price, and the issuer's address
  // so the app can show per-coin detail and compare before trading.
  route("GET", "/api/v1/marketplace/coins", async (ctx) => {
    try {
      if (!checkRateLimit(`coins:${clientIp(ctx)}`, 120, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      const issuance = await getIssuanceStore();
      const coins = await issuance.listAllCoins();
      const out = [];
      for (const c of coins) {
        let category: string | null = null;
        let tagline: string | null = null;
        let valueThesis: string | null = null;
        let socialProfiles: Array<{ platform: string; url: string }> = [];
        try {
          const draft = c.draftId ? await issuance.getDraft(c.draftId) : null;
          const raw = draft?.category?.trim();
          category = raw ? raw : null;
          const rawTag = draft?.tagline?.trim();
          tagline = rawTag ? rawTag : null;
          const rawThesis = draft?.valueThesis?.trim();
          valueThesis = rawThesis ? rawThesis : null;
          if (draft?.socialProfiles) {
            socialProfiles = Array.isArray(draft.socialProfiles)
              ? draft.socialProfiles
              : JSON.parse(draft.socialProfiles as unknown as string);
          }
        } catch { category = null; }
        let floatAvailable = "0";
        try {
          floatAvailable = BigInt(getChainBalance(c.mintAddress, PUBLIC_FLOAT_ADDRESS)).toString();
        } catch { floatAvailable = "0"; }
        out.push({
          id: c.id,
          chainId: c.mintAddress,
          name: c.name,
          ticker: c.ticker,
          priceUsd: Number(c.priceUsd),
          supply: c.supply,
          category,
          tagline,
          valueThesis,
          isMeme: c.isMeme,
          hasAgreement: c.signatureId != null,
          issuerUserId: c.userId,
          issuerAddress: c.issuerAddress ?? null,
          socialProfiles,
          websiteUrl: c.websiteUrl ?? null,
          createdAt: c.createdAt,
          floatAvailable,
          online: true,
        });
      }
      sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, coins: out });
    } catch (err) { fail(ctx, err); }
  });

  // Instant coin-for-coin swap: settles immediately via executeSwapSettlement.
  // (Consent-based swaps go through the offers API instead: POST /api/v1/offers.)

  route("POST", "/api/v1/trades/swap", async (ctx) => {
    try {
      if (!checkRateLimit(`swap:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many swap attempts — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const buyerUserId = await requireUserId(ctx);
      const chainId = str(body.chainId);
      if (!chainId) throw new HttpError(400, "missing_chain_id", "Body must include chainId (the target coin's chain).");
      const buyerAddress = str(body.buyerAddress);
      if (!isValidAddress(buyerAddress)) {
        throw new HttpError(422, "invalid_buyer_address", "buyerAddress must be a valid ph1 address.");
      }
      const offerChainId = str(body.offerChainId);
      if (!offerChainId) throw new HttpError(400, "missing_offer_chain_id", "Body must include offerChainId (your coin's chain).");
      // offerUnits: whole coins only, >= 1 (fractional offers are floored).
      const offerUnits = parseWholeCoinUnits(body.offerUnits, "offerUnits");
      const key = idempotencyKey(ctx, `swap-${chainId}-${Date.now()}`);
      const result = await executeSwapSettlement({
        chainId, offerChainId, offerUnits, buyerUserId, buyerAddress, idempotencyKey: key,
      });
      sendJson(ctx.res, result.idempotentReplay ? 200 : 201, {
        ...NETWORK_ENVELOPE,
        idempotentReplay: result.idempotentReplay,
        trade: result.trade,
        ...(!result.idempotentReplay
          ? { offerTxId: result.offerTxId, targetTxId: result.targetTxId, fee: result.fee }
          : {}),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/trades/balances?userId= ---
  route("GET", "/api/v1/trades/balances", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
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
      const userId = await requireUserId(ctx);
      const role = ctx.query.get("role") === "buyer" ? "buyer" : "seller";
      const ms = await getStoreAsync();
      const trades = await ms.listTrades(userId, role);
      sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, role, trades });
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

  // Reverse a completed swap offer leg (best effort) when the target leg
  // cannot complete.
  const compensateSwap = async (a: SettlementAttempt, errorCode: string): Promise<void> => {
    const offerUnitsBase = a.offerUnits ? decimalToCoinUnits(a.offerUnits) : 0n;
    try {
      if (a.offerChainId && a.sellerAddress && offerUnitsBase > 0n) {
        await settleOperatorTransfer(a.offerChainId, a.sellerAddress, a.buyerAddress,
          offerUnitsBase.toString(), "reconciled swap compensation reversal");
      }
    } catch { /* best effort — the attempt row records the outcome */ }
    await ms.setAttemptState(a.id, "compensated", { errorCode });
    await auditLog("system", "swap_compensated", "settlement", a.id, { errorCode });
  };

  // Fee-aware unwind of a buy money leg (coin leg failed after cash moved).
  // Falls back to the legacy full-gross reversal for attempts that predate
  // the fee system (no fee row).
  const compensateBuy = async (a: SettlementAttempt, errorCode: string): Promise<void> => {
    const fee = await getFeeByIdempotencyKey(feeIdempotencyKey("buy", a.idempotencyKey));
    if (fee && (fee.status === "pending" || fee.status === "settled")) {
      await compensateBuyCashWithFee({
        sellerUserId: a.sellerUserId,
        buyerUserId: a.buyerUserId,
        grossUsd: a.amountUsd,
        feeKey: fee.idempotencyKey,
        reason: errorCode,
      });
    } else {
      try { await ms.transfer(a.sellerUserId, a.buyerUserId, USD, a.amountUsd); } catch { /* best effort */ }
    }
    await ms.setAttemptState(a.id, "compensated", { errorCode });
    await auditLog("system", "buy_compensated", "settlement", a.id, { errorCode });
  };

  /** Fee split for a swap attempt: { gross, fee, net } in whole coin units. */
  const swapFeeSplit = async (a: SettlementAttempt): Promise<{ gross: bigint; fee: bigint; net: bigint; feeBps: number }> => {
    const gross = decimalToCoinUnits(a.units);
    const feeBps = a.feeBps ?? (await getFeeConfig()).feeBps;
    const fee = a.feeUnits ? decimalToCoinUnits(a.feeUnits) : (gross * BigInt(feeBps)) / 10000n;
    return { gross, fee, net: gross - fee, feeBps };
  };

  const swapTicker = async (a: SettlementAttempt): Promise<string> => {
    try {
      const issuance = await getIssuanceStore();
      const coin = await issuance.getCoinByChainId(a.chainId);
      return coin?.ticker ?? "UNKNOWN";
    } catch { return "UNKNOWN"; }
  };

  /**
   * Ensure the swap fee record exists after the target leg. Covers the crash
   * window between the on-chain fee transfer and the fee_ledger insert:
   * if the fee transfer never ran and a fee is owed, run it now.
   */
  const recoverSwapFee = async (a: SettlementAttempt): Promise<void> => {
    const feeKey = feeIdempotencyKey("swap", a.idempotencyKey);
    if (await getFeeByIdempotencyKey(feeKey)) return;
    const { gross, fee, net, feeBps } = await swapFeeSplit(a);
    let feeTxId = a.feeTxId;
    if (!feeTxId && fee > 0n) {
      const treasuryAddr = getTreasurySovereignAddress();
      if (treasuryAddr) {
        try {
          const settled = await settleFloatTransfer(a.chainId, treasuryAddr,
            fee.toString(), "recovered Phase swap fee");
          feeTxId = settled.tx_id;
          await ms.setAttemptState(a.id, a.state, { feeTxId });
          a.feeTxId = feeTxId;
        } catch (e) {
          console.error("[marketplace] swap fee recovery transfer failed:",
            e instanceof Error ? e.message : String(e));
        }
      }
    }
    if (feeTxId || fee === 0n) {
      await recordSwapFee({
        feeKey,
        buyerUserId: a.buyerUserId,
        coinId: a.coinId,
        assetSymbol: await swapTicker(a),
        grossUnits: coinUnitsToDecimal(gross),
        feeBps,
        feeUnits: coinUnitsToDecimal(fee),
        netUnits: coinUnitsToDecimal(net),
        feeTxId,
      });
    } else {
      await auditLog("system", "swap_fee_recovery_pending", "settlement", a.id,
        { note: "fee transfer could not complete; left for operator review" });
    }
  };

  for (const a of open) {
    try {
      // --- swap attempts: started -> offer_moved -> target_queued -> coin_confirmed ---
      if (a.kind === "swap") {
        const offerUnitsBase = BigInt(Math.round(Number(a.offerUnits ?? "0")));
        if (a.state === "started") {
          // Offer leg never moved — safe to attempt it fresh.
          try {
            const settled = await settleOperatorTransfer(
              a.offerChainId!, a.buyerAddress, a.sellerAddress!,
              offerUnitsBase.toString(), "reconciled swap offer");
            await ms.setAttemptState(a.id, "offer_moved", { offerTxId: settled.tx_id });
            a.state = "offer_moved";
            a.offerTxId = settled.tx_id;
          } catch (err) {
            await ms.setAttemptState(a.id, "failed",
              { errorCode: (err as { code?: string }).code ?? "offer_leg_failed" });
            result.failed++;
            continue;
          }
        }
        if (a.state === "offer_moved") {
          // Offer moved, target leg never queued — check float then retry.
          // The retry mirrors the endpoint: buyer receives net units,
          // the Phase fee goes to the treasury address. Each transfer is
          // persisted immediately so a crash between them can't double-send.
          const { gross, fee, net } = await swapFeeSplit(a);
          let floatBal: bigint;
          try {
            floatBal = BigInt(getChainBalance(a.chainId, PUBLIC_FLOAT_ADDRESS));
          } catch {
            floatBal = 0n;
          }
          if (floatBal < gross) {
            await compensateSwap(a, "insufficient_float_on_retry");
            result.compensated++;
            continue;
          }
          try {
            let coinTxId = a.coinTxId;
            let feeTxId: string | null = a.feeTxId;
            if (!coinTxId) {
              const settled = await settleFloatTransfer(a.chainId, a.buyerAddress,
                net.toString(), "reconciled swap target (net of Phase fee)");
              coinTxId = settled.tx_id;
              await ms.setAttemptState(a.id, "offer_moved", { coinTxId });
            }
            if (!feeTxId && fee > 0n) {
              const treasuryAddr = getTreasurySovereignAddress();
              if (treasuryAddr) {
                const feeSettled = await settleFloatTransfer(a.chainId, treasuryAddr,
                  fee.toString(), "reconciled Phase swap fee");
                feeTxId = feeSettled.tx_id;
                await ms.setAttemptState(a.id, "offer_moved", { feeTxId });
              }
            }
            await ms.setAttemptState(a.id, "target_queued",
              { coinTxId: coinTxId, feeTxId: feeTxId ?? undefined });
            a.state = "target_queued";
            a.coinTxId = coinTxId;
            a.feeTxId = feeTxId;
          } catch (err) {
            await compensateSwap(a, (err as { code?: string }).code ?? "target_leg_failed");
            result.compensated++;
            continue;
          }
        }
        if (a.state === "target_queued") {
          // Target tx was queued — check whether it confirmed.
          const tx = a.coinTxId ? ledgerStore.txById.get(a.coinTxId) : undefined;
          if (tx && tx.status === "confirmed") {
            if (!a.tradeId) {
              const trade = await ms.recordTrade({
                kind: "swap",
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
                offerChainId: a.offerChainId,
                offerCoinId: a.offerCoinId,
                offerUnits: a.offerUnits,
                offerTxId: a.offerTxId,
              });
              await ms.setAttemptState(a.id, "coin_confirmed", { tradeId: trade.id });
            } else {
              await ms.setAttemptState(a.id, "coin_confirmed");
            }
            // Fee recovery: if the fee transfer completed but its ledger row
            // was never written (crash window), record it now. If the fee
            // transfer never ran and a fee is owed, run it now.
            try { await recoverSwapFee(a); } catch (e) {
              console.error("[marketplace] swap fee recovery failed:",
                e instanceof Error ? e.message : String(e));
            }
            result.finished++;
          } else if (!tx || tx.status === "failed") {
            // Target coins never landed — reverse the offer leg.
            await compensateSwap(a, "coin_tx_failed");
            result.compensated++;
          }
          // else still pending — the sequencer will confirm it from the
          // rehydrated mempool; leave the attempt open.
        }
        continue;
      }

      if (a.state === "started") {
        // Nothing moved — safe to abandon, UNLESS the money leg already
        // settled (crash between COMMIT and the state update). The fee row
        // is the authoritative idempotency guard for the buy money leg: it
        // exists (pending or settled) iff the money leg committed.
        let moneySettled = false;
        if (a.kind === "buy") {
          const fee = await getFeeByIdempotencyKey(feeIdempotencyKey("buy", a.idempotencyKey));
          moneySettled = !!fee && (fee.status === "pending" || fee.status === "settled");
        }
        if (!moneySettled) {
          await ms.setAttemptState(a.id, "failed", { errorCode: "abandoned_at_boot" });
          result.failed++;
          continue;
        }
        a.state = "cash_moved"; // resume into the coin-leg retry below
      }
      if (a.state === "cash_moved") {
        // Cash moved, coin leg never queued — retry the coin leg once.
        // Corrected model: buyer receives NET units, the Phase fee goes to
        // the treasury address. Each transfer is persisted immediately so a
        // crash between them can't double-send on the next retry.
        const unitsBase = decimalToCoinUnits(a.units);
        const feeBps = a.feeBps ?? (await getFeeConfig()).feeBps;
        const feeUnits = a.feeUnits ? decimalToCoinUnits(a.feeUnits)
          : (unitsBase * BigInt(feeBps)) / 10000n;
        const netUnits = unitsBase - feeUnits;
        let floatBal: bigint;
        try {
          floatBal = BigInt(getChainBalance(a.chainId, PUBLIC_FLOAT_ADDRESS));
        } catch {
          floatBal = 0n;
        }
        if (floatBal < unitsBase) {
          await compensateBuy(a, "insufficient_float_on_retry");
          result.compensated++;
          continue;
        }
        const feeKey = feeIdempotencyKey("buy", a.idempotencyKey);
        let ticker = "UNKNOWN";
        try {
          const issuance = await getIssuanceStore();
          const coin = await issuance.getCoinByChainId(a.chainId);
          if (coin) ticker = coin.ticker;
        } catch { /* keep UNKNOWN */ }
        try {
          let coinTxId = a.coinTxId;
          let feeTxId: string | null = a.feeTxId;
          if (!coinTxId) {
            const settled = await settleFloatTransfer(a.chainId, a.buyerAddress, netUnits.toString(),
              "reconciled marketplace buy (net of Phase fee)");
            coinTxId = settled.tx_id;
            await ms.setAttemptState(a.id, "cash_moved", { coinTxId });
          }
          if (!feeTxId && feeUnits > 0n) {
            const treasuryAddr = getTreasurySovereignAddress();
            if (!treasuryAddr) throw new Error("treasury_unconfigured");
            const feeSettled = await settleFloatTransfer(a.chainId, treasuryAddr,
              feeUnits.toString(), "reconciled Phase buy fee");
            feeTxId = feeSettled.tx_id;
            await ms.setAttemptState(a.id, "cash_moved", { feeTxId });
          }
          // Fee collection recorded atomically (idempotent on the fee key).
          await recordBuyFeeSettlement({ feeKey, ticker, feeUnits, feeTxId });
          await ms.setAttemptState(a.id, "coin_queued",
            { coinTxId: coinTxId, feeTxId: feeTxId ?? undefined });
          result.finished++;
        } catch (err) {
          await compensateBuy(a, (err as { code?: string }).code ?? "coin_leg_failed");
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
              kind: "buy",
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
              offerChainId: null,
              offerCoinId: null,
              offerUnits: null,
              offerTxId: null,
            });
            await ms.setAttemptState(a.id, "coin_confirmed", { tradeId: trade.id });
          } else {
            await ms.setAttemptState(a.id, "coin_confirmed");
          }
          result.finished++;
        } else if (!tx || tx.status === "failed") {
          // Coin never landed — unwind the cash (fee-aware).
          await compensateBuy(a, "coin_tx_failed");
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
