/**
 * securities.ts — Tokenized-securities integration layer for the Phase backend.
 *
 * "Back end of the front end" for listing/trading tokenized stocks, ETFs,
 * bonds and T-bills through the Phase interface.
 *
 * STANDING ASSUMPTION (per user): a licensed securities dealer partnership
 * exists. The dealer handles KYC, custody of the underlying assets, and all
 * regulatory compliance. This module builds ONLY product/integration
 * infrastructure: instrument catalog, quotes, order routing, positions, and
 * transaction history. It contains NO KYC/compliance flows.
 *
 * Testnet/sandbox only. No real money moves here.
 *
 * Providers:
 *   - SandboxSecuritiesProvider (default, SECURITIES_PROVIDER=sandbox):
 *     realistic mock with a seeded 20-instrument catalog, bid/ask spreads,
 *     immediate market fills, working limit orders, and a dividend stub.
 *   - DinariProvider (SECURITIES_PROVIDER=dinari): implements the same
 *     interface against Dinari dShares (tokenized US stocks, 1:1 backed,
 *     USDC settlement). Throws `not_configured` without DINARI_API_KEY;
 *     the live REST wiring is a dealer-step and throws `not_implemented`
 *     until then. Swapping providers later is config-only.
 *
 * USDC SETTLEMENT SEAM: every fill calls settleUsdc() — currently a no-op
 * hook point (see setUsdcSettlementHook). The future wiring debits/credits
 * the user's Circle USDC wallet (crypto-funding.ts). Do NOT settle across
 * modules until the dealer + compliance steps are done.
 *
 * Dependencies: node built-ins + the shared pg pool from db.ts only.
 */

import { getPool, migrate } from "./db.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveBearerUserId } from "./auth.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";

// ============================================================================
// 1. ERRORS
// ============================================================================

export class SecuritiesHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "SecuritiesHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ============================================================================
// 2. TYPES
// ============================================================================

export type InstrumentKind = "stock" | "etf" | "bond" | "treasury";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "open" | "filled" | "cancelled" | "failed";

export interface Instrument {
  id: string; // e.g. 'AAPL.D'
  symbol: string;
  name: string;
  kind: InstrumentKind;
  provider: string;
  chain: string | null;
  tokenAddress: string | null;
  metadata: Record<string, unknown>;
}

export interface InstrumentFilter {
  kind?: InstrumentKind;
  symbol?: string;
  search?: string;
  limit?: number;
}

export interface Quote {
  instrumentId: string;
  bid: number; // USDC per share — what a seller receives
  ask: number; // USDC per share — what a buyer pays
  mid: number;
  timestamp: string;
}

export interface PlaceOrderInput {
  userId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number; // shares, > 0
  orderType: OrderType;
  limitPrice?: number; // required for limit orders; USDC per share
  idempotencyKey: string;
}

export interface ProviderOrder {
  providerOrderId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number;
  status: "open" | "filled" | "cancelled" | "failed";
  filledQty: number;
  avgFillPrice: number | null;
  txHash: string | null;
}

export interface CorporateAction {
  id: string;
  instrumentId: string;
  type: "dividend" | "split";
  amountPerShare: number; // USDC per share (dividends)
  announcedAt: string;
}

export interface Position {
  userId: string;
  instrumentId: string;
  qty: number;
  avgCost: number; // USDC per share
  marketValueUsdc: number | null; // qty * mid, null when no quote available
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  userId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number | null;
  idempotencyKey: string;
  providerOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerRow {
  id: string;
  userId: string;
  orderId: string | null;
  kind: "fill" | "dividend" | "fee" | "transfer";
  instrumentId: string | null;
  qty: number; // signed: +buy / -sell
  amountUsdc: number; // signed from user's perspective: +credit / -debit
  txHash: string | null;
  createdAt: string;
}

// ============================================================================
// 3. PROVIDER INTERFACE
// ============================================================================

export interface SecuritiesProvider {
  readonly name: string;
  listInstruments(filter?: InstrumentFilter): Promise<Instrument[]>;
  getQuote(instrumentId: string): Promise<Quote>;
  placeOrder(input: PlaceOrderInput): Promise<ProviderOrder>;
  cancelOrder(providerOrderId: string): Promise<ProviderOrder>;
  getOrderStatus(providerOrderId: string): Promise<ProviderOrder>;
  getCorporateActions(instrumentId: string): Promise<CorporateAction[]>;
}

// ============================================================================
// 4. SANDBOX PROVIDER
// ============================================================================

interface CatalogEntry {
  id: string;
  symbol: string;
  name: string;
  kind: InstrumentKind;
  basePrice: number; // reference USDC price; jittered per quote
}

/** Static sandbox catalog (~20 instruments). Base prices are config, not
 *  market data — a future enhancement can seed these from Finnhub. */
const SANDBOX_CATALOG: CatalogEntry[] = [
  { id: "AAPL.D", symbol: "AAPL", name: "Apple Inc.", kind: "stock", basePrice: 255 },
  { id: "NVDA.D", symbol: "NVDA", name: "NVIDIA Corporation", kind: "stock", basePrice: 185 },
  { id: "TSLA.D", symbol: "TSLA", name: "Tesla, Inc.", kind: "stock", basePrice: 330 },
  { id: "MSFT.D", symbol: "MSFT", name: "Microsoft Corporation", kind: "stock", basePrice: 540 },
  { id: "AMZN.D", symbol: "AMZN", name: "Amazon.com, Inc.", kind: "stock", basePrice: 235 },
  { id: "META.D", symbol: "META", name: "Meta Platforms, Inc.", kind: "stock", basePrice: 780 },
  { id: "GOOGL.D", symbol: "GOOGL", name: "Alphabet Inc.", kind: "stock", basePrice: 250 },
  { id: "AMD.D", symbol: "AMD", name: "Advanced Micro Devices, Inc.", kind: "stock", basePrice: 165 },
  { id: "NFLX.D", symbol: "NFLX", name: "Netflix, Inc.", kind: "stock", basePrice: 1180 },
  { id: "AVGO.D", symbol: "AVGO", name: "Broadcom Inc.", kind: "stock", basePrice: 300 },
  { id: "JPM.D", symbol: "JPM", name: "JPMorgan Chase & Co.", kind: "stock", basePrice: 300 },
  { id: "V.D", symbol: "V", name: "Visa Inc.", kind: "stock", basePrice: 355 },
  { id: "MA.D", symbol: "MA", name: "Mastercard Incorporated", kind: "stock", basePrice: 590 },
  { id: "XOM.D", symbol: "XOM", name: "Exxon Mobil Corporation", kind: "stock", basePrice: 115 },
  { id: "KO.D", symbol: "KO", name: "The Coca-Cola Company", kind: "stock", basePrice: 70 },
  { id: "DIS.D", symbol: "DIS", name: "The Walt Disney Company", kind: "stock", basePrice: 120 },
  { id: "SPY.D", symbol: "SPY", name: "SPDR S&P 500 ETF", kind: "etf", basePrice: 665 },
  { id: "QQQ.D", symbol: "QQQ", name: "Invesco QQQ Trust", kind: "etf", basePrice: 620 },
  { id: "TLT.D", symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", kind: "etf", basePrice: 88 },
  { id: "TBILL.D", symbol: "TBILL", name: "Tokenized US Treasury Bill", kind: "treasury", basePrice: 100 },
];

const SPREAD_BPS = 10; // 10 bps round-trip spread — realistic for tokenized equities

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function fakeTxHash(): string {
  return "0x" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 32);
}

export class SandboxSecuritiesProvider implements SecuritiesProvider {
  readonly name = "sandbox";
  private rngs = new Map<string, () => number>();
  private orders = new Map<string, ProviderOrder & { limitPrice: number | null; orderType: OrderType }>();
  private actions: CorporateAction[] = [];

  private rngFor(id: string): () => number {
    let r = this.rngs.get(id);
    if (!r) {
      r = mulberry32(hashSeed("phase-sandbox:" + id));
      this.rngs.set(id, r);
    }
    return r;
  }

  private entry(id: string): CatalogEntry {
    const e = SANDBOX_CATALOG.find((c) => c.id === id);
    if (!e) throw new SecuritiesHttpError(404, "unknown_instrument", `Unknown instrument: ${id}`);
    return e;
  }

  private toInstrument(e: CatalogEntry): Instrument {
    return {
      id: e.id,
      symbol: e.symbol,
      name: e.name,
      kind: e.kind,
      provider: "sandbox",
      chain: null,
      tokenAddress: null,
      metadata: { basePrice: e.basePrice, note: "sandbox tokenized instrument" },
    };
  }

  async listInstruments(filter: InstrumentFilter = {}): Promise<Instrument[]> {
    let list = SANDBOX_CATALOG.map((e) => this.toInstrument(e));
    if (filter.kind) list = list.filter((i) => i.kind === filter.kind);
    if (filter.symbol) list = list.filter((i) => i.symbol.toUpperCase() === filter.symbol!.toUpperCase());
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(
        (i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
      );
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    return list.slice(0, limit);
  }

  async getQuote(instrumentId: string): Promise<Quote> {
    const e = this.entry(instrumentId);
    const jitter = (this.rngFor(instrumentId)() - 0.5) * 0.001; // ±5 bps deterministic jitter
    const mid = round4(e.basePrice * (1 + jitter));
    const half = SPREAD_BPS / 2 / 10_000;
    return {
      instrumentId,
      bid: round4(mid * (1 - half)),
      ask: round4(mid * (1 + half)),
      mid,
      timestamp: new Date().toISOString(),
    };
  }

  /** Test/ops hook: register a dividend corporate action. */
  triggerDividend(instrumentId: string, amountPerShareUsdc: number): CorporateAction {
    this.entry(instrumentId); // validates
    if (!(amountPerShareUsdc > 0) || !Number.isFinite(amountPerShareUsdc)) {
      throw new SecuritiesHttpError(400, "bad_dividend", "amountPerShareUsdc must be positive.");
    }
    const action: CorporateAction = {
      id: randomUUID(),
      instrumentId,
      type: "dividend",
      amountPerShare: amountPerShareUsdc,
      announcedAt: new Date().toISOString(),
    };
    this.actions.push(action);
    return action;
  }

  async getCorporateActions(instrumentId: string): Promise<CorporateAction[]> {
    this.entry(instrumentId);
    return this.actions.filter((a) => a.instrumentId === instrumentId);
  }

  private tryFill(
    o: ProviderOrder & { limitPrice: number | null; orderType: OrderType },
    q: Quote
  ): void {
    if (o.status !== "open") return;
    if (o.orderType === "market") {
      const px = o.side === "buy" ? q.ask : q.bid;
      o.status = "filled";
      o.filledQty = o.qty;
      o.avgFillPrice = px;
      o.txHash = fakeTxHash();
      return;
    }
    const limit = o.limitPrice!;
    if (o.side === "buy" && q.ask <= limit) {
      o.status = "filled";
      o.filledQty = o.qty;
      o.avgFillPrice = q.ask;
      o.txHash = fakeTxHash();
    } else if (o.side === "sell" && q.bid >= limit) {
      o.status = "filled";
      o.filledQty = o.qty;
      o.avgFillPrice = q.bid;
      o.txHash = fakeTxHash();
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<ProviderOrder> {
    const q = await this.getQuote(input.instrumentId); // validates instrument
    const providerOrderId = "sb-" + randomUUID();
    const o: ProviderOrder & { limitPrice: number | null; orderType: OrderType } = {
      providerOrderId,
      instrumentId: input.instrumentId,
      side: input.side,
      qty: input.qty,
      status: "open",
      filledQty: 0,
      avgFillPrice: null,
      txHash: null,
      limitPrice: input.orderType === "limit" ? input.limitPrice! : null,
      orderType: input.orderType,
    };
    this.orders.set(providerOrderId, o);
    this.tryFill(o, q);
    const { limitPrice: _lp, orderType: _ot, ...pub } = o;
    return pub;
  }

  async cancelOrder(providerOrderId: string): Promise<ProviderOrder> {
    const o = this.orders.get(providerOrderId);
    if (!o) throw new SecuritiesHttpError(404, "unknown_provider_order", "Unknown provider order.");
    if (o.status !== "open") {
      throw new SecuritiesHttpError(409, "order_not_cancellable", `Order is ${o.status}, only open orders can be cancelled.`);
    }
    o.status = "cancelled";
    const { limitPrice: _lp, orderType: _ot, ...pub } = o;
    return pub;
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrder> {
    const o = this.orders.get(providerOrderId);
    if (!o) throw new SecuritiesHttpError(404, "unknown_provider_order", "Unknown provider order.");
    // Re-evaluate working limit orders against a fresh quote.
    const q = await this.getQuote(o.instrumentId);
    this.tryFill(o, q);
    const { limitPrice: _lp, orderType: _ot, ...pub } = o;
    return pub;
  }
}

// ============================================================================
// 5. DINARI PROVIDER (stub — real REST wiring is a dealer-step)
// ============================================================================

/**
 * Dinari dShares shape: tokenized US stocks, 1:1 backed by the underlying
 * share held in qualified custody, USDC settlement. This stub implements the
 * SecuritiesProvider interface 1:1 so swapping from sandbox to Dinari is
 * config-only (SECURITIES_PROVIDER=dinari). Without DINARI_API_KEY every
 * call throws `not_configured`; with a key, calls throw `not_implemented`
 * until the live REST integration is built (needs dealer credentials and
 * the Dinari partner onboarding, which is outside this task's scope).
 */
export class DinariProvider implements SecuritiesProvider {
  readonly name = "dinari";
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = (process.env.DINARI_API_KEY ?? "").trim() || null;
  }

  private gate(): never {
    if (!this.apiKey) {
      throw new SecuritiesHttpError(503, "not_configured", "Dinari provider selected but DINARI_API_KEY is not set.");
    }
    throw new SecuritiesHttpError(
      503,
      "not_implemented",
      "Live Dinari REST wiring is pending dealer onboarding. Use the sandbox provider for now."
    );
  }

  async listInstruments(_filter: InstrumentFilter = {}): Promise<Instrument[]> { this.gate(); }
  async getQuote(_instrumentId: string): Promise<Quote> { this.gate(); }
  async placeOrder(_input: PlaceOrderInput): Promise<ProviderOrder> { this.gate(); }
  async cancelOrder(_providerOrderId: string): Promise<ProviderOrder> { this.gate(); }
  async getOrderStatus(_providerOrderId: string): Promise<ProviderOrder> { this.gate(); }
  async getCorporateActions(_instrumentId: string): Promise<CorporateAction[]> { this.gate(); }
}

let providerSingleton: SecuritiesProvider | null = null;

/** Provider selected by SECURITIES_PROVIDER env (default 'sandbox'). */
export function getProvider(): SecuritiesProvider {
  if (providerSingleton) return providerSingleton;
  const which = (process.env.SECURITIES_PROVIDER ?? "sandbox").trim().toLowerCase();
  providerSingleton = which === "dinari" ? new DinariProvider() : new SandboxSecuritiesProvider();
  return providerSingleton;
}

/** Test hook: reset the provider singleton (e.g. after changing env). */
export function resetProvider(): void {
  providerSingleton = null;
}

// ============================================================================
// 6. USDC SETTLEMENT SEAM (hook point — NOT wired yet)
// ============================================================================

export interface UsdcSettlement {
  userId: string;
  orderId: string;
  /** Signed USDC amount from the user's perspective: negative = debit (buy), positive = credit (sell). */
  amountUsdc: number;
  instrumentId: string;
}

/**
 * TODO(settlement): wire this to the user's Circle USDC wallet
 * (crypto-funding.ts). When implemented, a buy fill must debit the user's
 * wallet and a sell fill must credit it, idempotently keyed by orderId.
 * Blocked on: dealer partnership terms + compliance sign-off. Until then
 * this is a no-op and fills are recorded in securities_ledger only.
 */
let usdcSettlementHook: ((s: UsdcSettlement) => Promise<void>) | null = null;

export function setUsdcSettlementHook(fn: ((s: UsdcSettlement) => Promise<void>) | null): void {
  usdcSettlementHook = fn;
}

async function settleUsdc(s: UsdcSettlement): Promise<void> {
  if (usdcSettlementHook) await usdcSettlementHook(s);
  // default: no-op (see TODO above)
}

// ============================================================================
// 7. BFF FUNCTIONS (DB-backed)
// ============================================================================

const num = (v: unknown): number => Number(v ?? 0);

function toOrderRecord(r: Record<string, unknown>): OrderRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    instrumentId: String(r.instrument_id),
    side: r.side as OrderSide,
    qty: num(r.qty),
    orderType: r.order_type as OrderType,
    limitPrice: r.limit_price == null ? null : num(r.limit_price),
    status: r.status as OrderStatus,
    filledQty: num(r.filled_qty),
    avgFillPrice: r.avg_fill_price == null ? null : num(r.avg_fill_price),
    idempotencyKey: String(r.idempotency_key),
    providerOrderId: r.provider_order_id == null ? null : String(r.provider_order_id),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function toLedgerRow(r: Record<string, unknown>): LedgerRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    orderId: r.order_id == null ? null : String(r.order_id),
    kind: r.kind as LedgerRow["kind"],
    instrumentId: r.instrument_id == null ? null : String(r.instrument_id),
    qty: num(r.qty),
    amountUsdc: num(r.amount_usdc),
    txHash: r.tx_hash == null ? null : String(r.tx_hash),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

async function instrumentExists(instrumentId: string): Promise<boolean> {
  const r = await getPool().query("SELECT 1 FROM securities_instruments WHERE id = $1", [instrumentId]);
  return r.rowCount === 1;
}

/**
 * Bring the securities schema up to date and seed the instrument catalog.
 * Applies the shared migrate() (001) first, then 002_securities.sql through
 * the SAME shared pool — never a second pool, never a competing migrate.
 * Idempotent: safe to call on every boot.
 */
export async function ensureSecuritiesSchema(): Promise<{ instruments: number }> {
  await migrate(); // 001 via the shared mechanism (also creates schema_migrations)
  const sql = readFileSync(new URL("./db/migrations/002_securities.sql", import.meta.url), "utf8");
  await getPool().query(sql);
  await getPool().query("INSERT INTO schema_migrations(version) VALUES ('002') ON CONFLICT DO NOTHING");

  const instruments = await getProvider().listInstruments({ limit: 100 });
  for (const i of instruments) {
    await getPool().query(
      `INSERT INTO securities_instruments (id, symbol, name, kind, provider, chain, token_address, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [i.id, i.symbol, i.name, i.kind, i.provider, i.chain, i.tokenAddress, JSON.stringify(i.metadata ?? {})]
    );
  }
  const r = await getPool().query("SELECT COUNT(*)::int AS c FROM securities_instruments");
  return { instruments: Number(r.rows[0].c) };
}

export async function searchInstruments(filter: InstrumentFilter = {}): Promise<Instrument[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (filter.kind) {
    args.push(filter.kind);
    conds.push(`kind = $${args.length}`);
  }
  if (filter.symbol) {
    args.push(filter.symbol.toUpperCase());
    conds.push(`symbol = $${args.length}`);
  }
  if (filter.search) {
    args.push(`%${filter.search.toLowerCase()}%`);
    conds.push(`(LOWER(symbol) LIKE $${args.length} OR LOWER(name) LIKE $${args.length})`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  args.push(limit);
  const r = await getPool().query(
    `SELECT id, symbol, name, kind, provider, chain, token_address, metadata
     FROM securities_instruments
     ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY symbol LIMIT $${args.length}`,
    args
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    symbol: String(row.symbol),
    name: String(row.name),
    kind: row.kind as InstrumentKind,
    provider: String(row.provider),
    chain: row.chain == null ? null : String(row.chain),
    tokenAddress: row.token_address == null ? null : String(row.token_address),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

export async function getQuote(instrumentId: string): Promise<Quote> {
  if (!(await instrumentExists(instrumentId))) {
    throw new SecuritiesHttpError(404, "unknown_instrument", `Unknown instrument: ${instrumentId}`);
  }
  return getProvider().getQuote(instrumentId);
}

async function applyFill(order: OrderRecord, fill: ProviderOrder): Promise<OrderRecord> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const price = fill.avgFillPrice!;
    const fillQty = fill.filledQty;

    await client.query(
      `UPDATE securities_orders
       SET status='filled', filled_qty=$2, avg_fill_price=$3, provider_order_id=$4, updated_at=now()
       WHERE id=$1`,
      [order.id, fillQty, price, fill.providerOrderId]
    );

    // --- position update ---
    const pos = await client.query(
      "SELECT qty, avg_cost FROM securities_positions WHERE user_id=$1 AND instrument_id=$2",
      [order.userId, order.instrumentId]
    );
    const curQty = pos.rowCount ? num(pos.rows[0].qty) : 0;
    const curCost = pos.rowCount ? num(pos.rows[0].avg_cost) : 0;
    if (order.side === "buy") {
      const newQty = curQty + fillQty;
      const newCost = newQty > 0 ? (curQty * curCost + fillQty * price) / newQty : 0;
      await client.query(
        `INSERT INTO securities_positions (user_id, instrument_id, qty, avg_cost, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (user_id, instrument_id)
         DO UPDATE SET qty=$3, avg_cost=$4, updated_at=now()`,
        [order.userId, order.instrumentId, newQty, newCost]
      );
    } else {
      const newQty = curQty - fillQty;
      if (newQty > 0) {
        await client.query(
          "UPDATE securities_positions SET qty=$3, updated_at=now() WHERE user_id=$1 AND instrument_id=$2",
          [order.userId, order.instrumentId, newQty]
        );
      } else {
        await client.query("DELETE FROM securities_positions WHERE user_id=$1 AND instrument_id=$2", [
          order.userId,
          order.instrumentId,
        ]);
      }
    }

    // --- ledger: signed qty (+buy/-sell), signed USDC (+credit/-debit) ---
    const signedQty = order.side === "buy" ? fillQty : -fillQty;
    const signedUsdc = order.side === "buy" ? -(fillQty * price) : fillQty * price;
    await client.query(
      `INSERT INTO securities_ledger (id, user_id, order_id, kind, instrument_id, qty, amount_usdc, tx_hash)
       VALUES ($1,$2,$3,'fill',$4,$5,$6,$7)`,
      [randomUUID(), order.userId, order.id, order.instrumentId, signedQty, signedUsdc, fill.txHash]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // USDC settlement hook point (no-op until wired — see TODO in §6).
  const price2 = fill.avgFillPrice!;
  const signedUsdc2 = order.side === "buy" ? -(fill.filledQty * price2) : fill.filledQty * price2;
  await settleUsdc({
    userId: order.userId,
    orderId: order.id,
    amountUsdc: signedUsdc2,
    instrumentId: order.instrumentId,
  });

  const r = await getPool().query("SELECT * FROM securities_orders WHERE id=$1", [order.id]);
  return toOrderRecord(r.rows[0] as Record<string, unknown>);
}

/** Limit prices must be positive and within 50% of the current mid (fat-finger guard). */
function sanityCheckLimit(limitPrice: number, mid: number): void {
  if (!(limitPrice > 0) || !Number.isFinite(limitPrice)) {
    throw new SecuritiesHttpError(400, "bad_limit_price", "limitPrice must be a positive number.");
  }
  if (limitPrice < mid * 0.5 || limitPrice > mid * 1.5) {
    throw new SecuritiesHttpError(
      400,
      "limit_price_out_of_range",
      `limitPrice ${limitPrice} is outside ±50% of the current mid ${mid}.`
    );
  }
}

export async function placeOrder(input: {
  userId: string;
  instrumentId: string;
  side: string;
  qty: number;
  orderType: string;
  limitPrice?: number;
  idempotencyKey: string;
}): Promise<{ order: OrderRecord; created: boolean }> {
  const userId = (input.userId ?? "").trim();
  if (!userId) throw new SecuritiesHttpError(400, "missing_user_id", "userId is required.");
  const instrumentId = (input.instrumentId ?? "").trim();
  if (!instrumentId) throw new SecuritiesHttpError(400, "missing_instrument", "instrumentId is required.");
  if (!(await instrumentExists(instrumentId))) {
    throw new SecuritiesHttpError(404, "unknown_instrument", `Unknown instrument: ${instrumentId}`);
  }
  const side = input.side as OrderSide;
  if (side !== "buy" && side !== "sell") {
    throw new SecuritiesHttpError(400, "bad_side", "side must be 'buy' or 'sell'.");
  }
  const qty = Number(input.qty);
  if (!(qty > 0) || !Number.isFinite(qty) || qty > 1e9) {
    throw new SecuritiesHttpError(400, "bad_qty", "qty must be a positive number.");
  }
  const orderType = input.orderType as OrderType;
  if (orderType !== "market" && orderType !== "limit") {
    throw new SecuritiesHttpError(400, "bad_order_type", "orderType must be 'market' or 'limit'.");
  }
  const idempotencyKey = (input.idempotencyKey ?? "").trim();
  if (!idempotencyKey) throw new SecuritiesHttpError(400, "missing_idempotency_key", "idempotencyKey is required.");

  // Idempotency: same key → return the original order, never a duplicate.
  const existing = await getPool().query("SELECT * FROM securities_orders WHERE idempotency_key=$1", [idempotencyKey]);
  if (existing.rowCount) {
    return { order: toOrderRecord(existing.rows[0] as Record<string, unknown>), created: false };
  }

  // Limit sanity vs live quote (also fetches a fresh quote for the provider call).
  let limitPrice: number | null = null;
  if (orderType === "limit") {
    const q = await getProvider().getQuote(instrumentId);
    limitPrice = Number(input.limitPrice);
    sanityCheckLimit(limitPrice, q.mid);
  }

  // Long-only: sells cannot exceed the current position.
  if (side === "sell") {
    const pos = await getPool().query(
      "SELECT qty FROM securities_positions WHERE user_id=$1 AND instrument_id=$2",
      [userId, instrumentId]
    );
    const held = pos.rowCount ? num(pos.rows[0].qty) : 0;
    if (qty > held + 1e-9) {
      throw new SecuritiesHttpError(400, "insufficient_position", `Sell qty ${qty} exceeds position ${held}.`);
    }
  }

  const orderId = randomUUID();
  try {
    await getPool().query(
      `INSERT INTO securities_orders
         (id, user_id, instrument_id, side, qty, order_type, limit_price, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [orderId, userId, instrumentId, side, qty, orderType, limitPrice, idempotencyKey]
    );
  } catch (e: unknown) {
    // Lost a race with an identical idempotency key — return the winner.
    if ((e as { code?: string })?.code === "23505") {
      const won = await getPool().query("SELECT * FROM securities_orders WHERE idempotency_key=$1", [
        idempotencyKey,
      ]);
      if (won.rowCount) {
        return { order: toOrderRecord(won.rows[0] as Record<string, unknown>), created: false };
      }
    }
    throw e;
  }

  try {
    const fill = await getProvider().placeOrder({
      userId,
      instrumentId,
      side,
      qty,
      orderType,
      limitPrice: limitPrice ?? undefined,
      idempotencyKey,
    });
    await getPool().query(
      "UPDATE securities_orders SET provider_order_id=$2, updated_at=now() WHERE id=$1",
      [orderId, fill.providerOrderId]
    );
    if (fill.status === "filled") {
      const done = await applyFill(
        toOrderRecord((await getPool().query("SELECT * FROM securities_orders WHERE id=$1", [orderId])).rows[0] as Record<string, unknown>),
        fill
      );
      return { order: done, created: true };
    }
    await getPool().query("UPDATE securities_orders SET status='open', updated_at=now() WHERE id=$1", [orderId]);
    const r = await getPool().query("SELECT * FROM securities_orders WHERE id=$1", [orderId]);
    return { order: toOrderRecord(r.rows[0] as Record<string, unknown>), created: true };
  } catch (e) {
    await getPool().query("UPDATE securities_orders SET status='failed', updated_at=now() WHERE id=$1", [orderId]);
    throw e;
  }
}

export async function cancelOrder(userId: string, orderId: string): Promise<OrderRecord> {
  const r = await getPool().query("SELECT * FROM securities_orders WHERE id=$1", [orderId]);
  if (!r.rowCount) throw new SecuritiesHttpError(404, "unknown_order", "Order not found.");
  const order = toOrderRecord(r.rows[0] as Record<string, unknown>);
  if (order.userId !== userId) throw new SecuritiesHttpError(403, "order_not_owned", "Order belongs to a different user.");
  if (order.status !== "open" && order.status !== "pending") {
    throw new SecuritiesHttpError(409, "order_not_cancellable", `Order is ${order.status}; only open orders can be cancelled.`);
  }
  if (order.providerOrderId) {
    await getProvider().cancelOrder(order.providerOrderId);
  }
  const r2 = await getPool().query(
    "UPDATE securities_orders SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *",
    [orderId]
  );
  return toOrderRecord(r2.rows[0] as Record<string, unknown>);
}

export async function getPositions(userId: string): Promise<Position[]> {
  const r = await getPool().query(
    `SELECT p.user_id, p.instrument_id, p.qty, p.avg_cost, p.updated_at, i.symbol, i.name
     FROM securities_positions p JOIN securities_instruments i ON i.id = p.instrument_id
     WHERE p.user_id=$1 ORDER BY i.symbol`,
    [userId]
  );
  const out: Position[] = [];
  for (const row of r.rows as Record<string, unknown>[]) {
    let marketValue: number | null = null;
    try {
      const q = await getProvider().getQuote(String(row.instrument_id));
      marketValue = num(row.qty) * q.mid;
    } catch {
      marketValue = null;
    }
    out.push({
      userId: String(row.user_id),
      instrumentId: String(row.instrument_id),
      qty: num(row.qty),
      avgCost: num(row.avg_cost),
      marketValueUsdc: marketValue,
      updatedAt: new Date(row.updated_at as string).toISOString(),
    });
  }
  return out;
}

export async function getOrders(
  userId: string,
  opts: { status?: string; limit?: number } = {}
): Promise<OrderRecord[]> {
  const conds = ["user_id=$1"];
  const args: unknown[] = [userId];
  if (opts.status) {
    args.push(opts.status);
    conds.push(`status=$${args.length}`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  args.push(limit);
  const r = await getPool().query(
    `SELECT * FROM securities_orders WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $${args.length}`,
    args
  );
  return (r.rows as Record<string, unknown>[]).map(toOrderRecord);
}

export async function getTransactions(userId: string, limit = 50): Promise<LedgerRow[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const r = await getPool().query(
    "SELECT * FROM securities_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId, lim]
  );
  return (r.rows as Record<string, unknown>[]).map(toLedgerRow);
}

/**
 * Credit dividend cash to every holder of an instrument.
 * Uses the provider's corporate actions (sandbox: triggerDividend).
 * Dealer note: real dividends flow through the dealer's corporate-actions
 * processing; this is the BFF-side crediting primitive.
 */
export async function applyDividend(userId: string, instrumentId: string): Promise<LedgerRow[]> {
  const actions = await getProvider().getCorporateActions(instrumentId);
  const divs = actions.filter((a) => a.type === "dividend");
  if (!divs.length) {
    throw new SecuritiesHttpError(404, "no_dividend", `No dividend actions for ${instrumentId}.`);
  }
  const pos = await getPool().query(
    "SELECT qty FROM securities_positions WHERE user_id=$1 AND instrument_id=$2",
    [userId, instrumentId]
  );
  const held = pos.rowCount ? num(pos.rows[0].qty) : 0;
  if (held <= 0) return [];
  const out: LedgerRow[] = [];
  for (const d of divs) {
    const cash = held * d.amountPerShare;
    const r = await getPool().query(
      `INSERT INTO securities_ledger (id, user_id, order_id, kind, instrument_id, qty, amount_usdc, tx_hash)
       VALUES ($1,$2,NULL,'dividend',$3,0,$4,NULL) RETURNING *`,
      [randomUUID(), userId, instrumentId, cash]
    );
    out.push(toLedgerRow(r.rows[0] as Record<string, unknown>));
  }
  return out;
}

// ============================================================================
// 8. ROUTES
// ============================================================================

export interface SecuritiesMountDeps {
  route: (method: string, path: string, handler: (ctx: RouteContextLike) => void | Promise<void>) => void;
  sendJson: (res: unknown, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

export interface RouteContextLike {
  req?: any;
  res: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new SecuritiesHttpError(400, "invalid_json_body", "Request body must be a JSON object.");
}

// The userId for private routes ALWAYS comes from the authenticated Bearer
// session. A client-supplied userId in the body/query is never trusted: if
// one is present and disagrees with the session, the request is rejected.
async function requireUserId(ctx: RouteContextLike): Promise<string> {
  const headers = ((ctx.req?.headers ?? {}) as Record<string, string | string[] | undefined>);
  const authed = await resolveBearerUserId(headers);
  if (!authed) throw new SecuritiesHttpError(401, "unauthorized", "Sign in required.");
  const body = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body : {}) as Record<string, unknown>;
  const claimed = (typeof body.userId === "string" ? body.userId : null) || ctx.query.get("userId");
  if (claimed && claimed !== authed) {
    throw new SecuritiesHttpError(403, "forbidden", "This request is for a different user.");
  }
  return authed;
}

function toHttpError(err: unknown, HttpError: SecuritiesMountDeps["HttpError"]): Error {
  if (err instanceof SecuritiesHttpError) return new HttpError(err.statusCode, err.code, err.message);
  return err instanceof Error ? err : new HttpError(500, "internal_error", String(err));
}

export function mountSecuritiesRoutes(deps: SecuritiesMountDeps): void {
  const { route, sendJson, HttpError } = deps;

  const ipOf = (ctx: RouteContextLike): string => clientIpFromHeaders(ctx.req.headers);
  const limit = (key: string): void => {
    if (!checkRateLimit(key, 30, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many securities requests — wait a minute and try again.");
    }
  };

  const fail = (ctx: RouteContextLike, err: unknown): void => {
    const e = toHttpError(err, HttpError);
    const statusCode = (e as { statusCode?: number }).statusCode ?? 500;
    const code = (e as { code?: number }).code ?? "internal_error";
    sendJson(ctx.res, statusCode, { provider: providerName(), error: code, message: e.message });
  };
  const ok = (ctx: RouteContextLike, status: number, body: Record<string, unknown>): void =>
    sendJson(ctx.res, status, { provider: providerName(), ...body });

  // --- GET /api/v1/securities/instruments?kind=&search=&symbol=&limit= ---
  route("GET", "/api/v1/securities/instruments", async (ctx) => {
    try {
      limit(`securities:instruments:${ipOf(ctx)}`);
      const kind = ctx.query.get("kind");
      if (kind && !["stock", "etf", "bond", "treasury"].includes(kind)) {
        throw new SecuritiesHttpError(400, "bad_kind", "kind must be stock|etf|bond|treasury.");
      }
      const instruments = await searchInstruments({
        kind: (kind ?? undefined) as InstrumentKind | undefined,
        symbol: ctx.query.get("symbol") ?? undefined,
        search: ctx.query.get("search") ?? undefined,
        limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
      });
      ok(ctx, 200, { instruments, count: instruments.length });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/securities/quote/:id ---
  route("GET", "/api/v1/securities/quote/:id", async (ctx) => {
    try {
      limit(`securities:quote:${ipOf(ctx)}`);
      const quote = await getQuote(ctx.params.id);
      ok(ctx, 200, { quote });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- POST /api/v1/securities/orders ---
  route("POST", "/api/v1/securities/orders", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = await requireUserId(ctx);
      limit(`securities:orders-post:${userId}`);
      const { order, created } = await placeOrder({
        userId,
        instrumentId: String(body.instrumentId ?? ""),
        side: String(body.side ?? ""),
        qty: Number(body.qty),
        orderType: String(body.orderType ?? ""),
        limitPrice: body.limitPrice == null ? undefined : Number(body.limitPrice),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });
      ok(ctx, created ? 201 : 200, { order, created });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- DELETE /api/v1/securities/orders/:id?userId= ---
  route("DELETE", "/api/v1/securities/orders/:id", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      limit(`securities:orders-delete:${userId}`);
      const order = await cancelOrder(userId, ctx.params.id);
      ok(ctx, 200, { order });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/securities/positions?userId= ---
  route("GET", "/api/v1/securities/positions", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      limit(`securities:positions:${userId}`);
      const positions = await getPositions(userId);
      ok(ctx, 200, { userId, positions, count: positions.length });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/securities/orders?userId=&status= ---
  route("GET", "/api/v1/securities/orders", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      limit(`securities:orders-get:${userId}`);
      const orders = await getOrders(userId, {
        status: ctx.query.get("status") ?? undefined,
        limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
      });
      ok(ctx, 200, { userId, orders, count: orders.length });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/securities/transactions?userId=&limit= ---
  route("GET", "/api/v1/securities/transactions", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      limit(`securities:transactions:${userId}`);
      const transactions = await getTransactions(
        userId,
        ctx.query.get("limit") ? Number(ctx.query.get("limit")) : 50
      );
      ok(ctx, 200, { userId, transactions, count: transactions.length });
    } catch (err) {
      fail(ctx, err);
    }
  });
}

function providerName(): string {
  try {
    return getProvider().name;
  } catch {
    return "unknown";
  }
}
