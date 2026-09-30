/**
 * Swap offers — consent-based coin-for-coin swaps.
 *
 * Instant POST /trades/swap settles immediately. Offers instead create a
 * proposal: the buyer offers units of their own issued coin in exchange for
 * NET units of a target coin. Nothing moves until the seller accepts (or
 * counters); the buyer then accepts the counter or walks away.
 *
 * Lifecycle: pending -> (accepted | declined | cancelled)
 *            pending -> countered -> (accepted | declined | cancelled)
 *
 * Acceptance reuses executeSwapSettlement() from marketplace.ts, so the
 * 80-bps fee model, balance pre-checks, and crash-safe legs are identical
 * to instant swaps.
 *
 * Routes (mounted from phase-backend.ts):
 *   POST /api/v1/offers              create an offer
 *   GET  /api/v1/offers/inbox        offers where I am the seller (active)
 *   GET  /api/v1/offers/outbox       offers where I am the buyer (active)
 *   POST /api/v1/offers/:id/accept   accept (seller accepts; buyer accepts a counter)
 *   POST /api/v1/offers/:id/counter  seller proposes different terms
 *   POST /api/v1/offers/:id/decline  decline / cancel
 *
 * Persistence: Postgres when DATABASE_URL is set, otherwise in-memory.
 */
import { randomUUID } from "node:crypto";
import { getPool } from "./db.js";
import { getChainBalance, isValidAddress, auditLog } from "./sovereign-ledger-core.js";
import { getIssuanceStore, type IssuanceCoin } from "./issuance.js";
import { resolveBearerUserId } from "./auth.js";
import { clientIpFromHeaders } from "./rate-limit.js";
import { getFeeConfig, coinUnitsToDecimal, decimalToCoinUnits } from "./fee.js";
import {
  checkRateLimit,
  executeSwapSettlement,
  grossUnitsForNet,
  type SwapSettlementResult,
} from "./marketplace.js";

export interface OffersMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface OffersCtx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type OfferStatus = "pending" | "countered" | "accepted" | "declined" | "cancelled";

export interface SwapOffer {
  id: string;
  targetChainId: string;
  targetCoinId: string;
  sellerUserId: string;
  buyerUserId: string;
  buyerAddress: string;
  offerChainId: string;
  offerCoinId: string;
  /** Whole coins the buyer gives (6dp decimal text). */
  offerUnits: string;
  /** NET target coins the buyer wants to receive (6dp decimal text). */
  requestUnits: string;
  counterOfferUnits: string | null;
  counterRequestUnits: string | null;
  feeBps: number;
  status: OfferStatus;
  idempotencyKey: string;
  tradeId: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  // Display fields joined from issuance_coins (null when the coin is gone).
  targetTicker: string | null;
  targetName: string | null;
  targetPriceUsd: string | null;
  offerTicker: string | null;
  offerName: string | null;
  offerPriceUsd: string | null;
}

const NETWORK_ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };

class OffersHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Whole coin units from user input (fractional input is floored; < 1 rejected). */
function parseWholeCoinUnits(raw: unknown, field: string): bigint {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  let micro: bigint;
  try {
    const parts = s.split(".");
    if (!/^\d+$/.test(parts[0] || "") || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) throw new Error("bad");
    micro = BigInt(parts[0] || "0") * 1_000_000n;
  } catch {
    throw new OffersHttpError(422, "invalid_amount", `${field} must be a positive number.`);
  }
  const units = micro / 1_000_000n;
  if (units < 1n) {
    throw new OffersHttpError(422, "amount_too_small", `${field} must be at least one whole coin.`);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const OFFER_COLS = `id, target_chain_id AS "targetChainId", target_coin_id AS "targetCoinId",
  seller_user_id AS "sellerUserId", buyer_user_id AS "buyerUserId", buyer_address AS "buyerAddress",
  offer_chain_id AS "offerChainId", offer_coin_id AS "offerCoinId",
  offer_units::text AS "offerUnits", request_units::text AS "requestUnits",
  counter_offer_units::text AS "counterOfferUnits", counter_request_units::text AS "counterRequestUnits",
  fee_bps AS "feeBps", status, idempotency_key AS "idempotencyKey",
  trade_id AS "tradeId", created_at AS "createdAt", updated_at AS "updatedAt", decided_at AS "decidedAt"`;

interface OffersStore {
  create(o: Omit<SwapOffer, "id" | "createdAt" | "updatedAt" | "decidedAt" | "tradeId" | "counterOfferUnits" | "counterRequestUnits" | "targetTicker" | "targetName" | "targetPriceUsd" | "offerTicker" | "offerName" | "offerPriceUsd">): Promise<SwapOffer>;
  getById(id: string): Promise<SwapOffer | null>;
  getByIdempotency(key: string): Promise<SwapOffer | null>;
  listBySeller(sellerUserId: string, activeOnly: boolean): Promise<SwapOffer[]>;
  listByBuyer(buyerUserId: string, activeOnly: boolean): Promise<SwapOffer[]>;
  setCounter(id: string, counterOfferUnits: string | null, counterRequestUnits: string | null): Promise<SwapOffer>;
  setDecided(id: string, status: Extract<OfferStatus, "accepted" | "declined" | "cancelled">, tradeId?: string | null): Promise<SwapOffer>;
}

class PgOffersStore implements OffersStore {
  private async q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query(text, params as any[]);
    return r.rows as T[];
  }
  private row(o: any): SwapOffer {
    return {
      ...o,
      status: o.status as OfferStatus,
      targetTicker: null, targetName: null, targetPriceUsd: null,
      offerTicker: null, offerName: null, offerPriceUsd: null,
    };
  }
  async create(o: Omit<SwapOffer, "id" | "createdAt" | "updatedAt" | "decidedAt" | "tradeId" | "counterOfferUnits" | "counterRequestUnits" | "targetTicker" | "targetName" | "targetPriceUsd" | "offerTicker" | "offerName" | "offerPriceUsd">): Promise<SwapOffer> {
    const id = randomUUID();
    const rows = await this.q<any>(
      `INSERT INTO swap_offers (id, target_chain_id, target_coin_id, seller_user_id, buyer_user_id,
        buyer_address, offer_chain_id, offer_coin_id, offer_units, request_units, fee_bps,
        status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${OFFER_COLS}`,
      [id, o.targetChainId, o.targetCoinId, o.sellerUserId, o.buyerUserId, o.buyerAddress,
       o.offerChainId, o.offerCoinId, o.offerUnits, o.requestUnits, o.feeBps, o.idempotencyKey]
    );
    if (rows.length === 0) {
      const existing = await this.getByIdempotency(o.idempotencyKey);
      if (!existing) throw new Error("idempotency conflict without existing offer");
      return existing;
    }
    return this.row(rows[0]);
  }
  async getById(id: string): Promise<SwapOffer | null> {
    const rows = await this.q<any>(`SELECT ${OFFER_COLS} FROM swap_offers WHERE id = $1`, [id]);
    return rows.length ? this.row(rows[0]) : null;
  }
  async getByIdempotency(key: string): Promise<SwapOffer | null> {
    const rows = await this.q<any>(`SELECT ${OFFER_COLS} FROM swap_offers WHERE idempotency_key = $1`, [key]);
    return rows.length ? this.row(rows[0]) : null;
  }
  async listBySeller(sellerUserId: string, activeOnly: boolean): Promise<SwapOffer[]> {
    const rows = await this.q<any>(
      `SELECT ${OFFER_COLS} FROM swap_offers WHERE seller_user_id = $1 ${activeOnly ? `AND status = 'pending'` : ``} ORDER BY created_at DESC`,
      [sellerUserId]
    );
    return rows.map((r) => this.row(r));
  }
  async listByBuyer(buyerUserId: string, activeOnly: boolean): Promise<SwapOffer[]> {
    const rows = await this.q<any>(
      `SELECT ${OFFER_COLS} FROM swap_offers WHERE buyer_user_id = $1 ${activeOnly ? `AND status IN ('pending','countered')` : ``} ORDER BY created_at DESC`,
      [buyerUserId]
    );
    return rows.map((r) => this.row(r));
  }
  async setCounter(id: string, counterOfferUnits: string | null, counterRequestUnits: string | null): Promise<SwapOffer> {
    const rows = await this.q<any>(
      `UPDATE swap_offers SET counter_offer_units = $2, counter_request_units = $3,
        status = 'countered', updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING ${OFFER_COLS}`,
      [id, counterOfferUnits, counterRequestUnits]
    );
    if (!rows.length) throw new OffersHttpError(409, "offer_not_pending", "Only a pending offer can be countered.");
    return this.row(rows[0]);
  }
  async setDecided(id: string, status: Extract<OfferStatus, "accepted" | "declined" | "cancelled">, tradeId: string | null = null): Promise<SwapOffer> {
    const rows = await this.q<any>(
      `UPDATE swap_offers SET status = $2, trade_id = COALESCE($3, trade_id),
        decided_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('pending','countered') RETURNING ${OFFER_COLS}`,
      [id, status, tradeId]
    );
    if (!rows.length) throw new OffersHttpError(409, "offer_closed", "This offer is no longer open.");
    return this.row(rows[0]);
  }
}

class MemoryOffersStore implements OffersStore {
  private offers = new Map<string, SwapOffer>();
  private byKey = new Map<string, SwapOffer>();
  private blank(o: any): SwapOffer {
    const now = new Date().toISOString();
    return {
      ...o, counterOfferUnits: null, counterRequestUnits: null,
      tradeId: null, createdAt: now, updatedAt: now, decidedAt: null,
      targetTicker: null, targetName: null, targetPriceUsd: null,
      offerTicker: null, offerName: null, offerPriceUsd: null,
    };
  }
  async create(o: any): Promise<SwapOffer> {
    const existing = this.byKey.get(o.idempotencyKey);
    if (existing) return existing;
    const offer = this.blank({ ...o, id: randomUUID(), status: "pending" });
    this.offers.set(offer.id, offer);
    this.byKey.set(offer.idempotencyKey, offer);
    return offer;
  }
  async getById(id: string): Promise<SwapOffer | null> {
    return this.offers.get(id) ?? null;
  }
  async getByIdempotency(key: string): Promise<SwapOffer | null> {
    return this.byKey.get(key) ?? null;
  }
  async listBySeller(sellerUserId: string, activeOnly: boolean): Promise<SwapOffer[]> {
    return [...this.offers.values()]
      .filter((o) => o.sellerUserId === sellerUserId && (!activeOnly || o.status === "pending"))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async listByBuyer(buyerUserId: string, activeOnly: boolean): Promise<SwapOffer[]> {
    return [...this.offers.values()]
      .filter((o) => o.buyerUserId === buyerUserId && (!activeOnly || o.status === "pending" || o.status === "countered"))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async setCounter(id: string, counterOfferUnits: string | null, counterRequestUnits: string | null): Promise<SwapOffer> {
    const o = this.offers.get(id);
    if (!o || o.status !== "pending") throw new OffersHttpError(409, "offer_not_pending", "Only a pending offer can be countered.");
    o.counterOfferUnits = counterOfferUnits;
    o.counterRequestUnits = counterRequestUnits;
    o.status = "countered";
    o.updatedAt = new Date().toISOString();
    return o;
  }
  async setDecided(id: string, status: Extract<OfferStatus, "accepted" | "declined" | "cancelled">, tradeId: string | null = null): Promise<SwapOffer> {
    const o = this.offers.get(id);
    if (!o || (o.status !== "pending" && o.status !== "countered")) {
      throw new OffersHttpError(409, "offer_closed", "This offer is no longer open.");
    }
    o.status = status;
    if (tradeId) o.tradeId = tradeId;
    o.decidedAt = new Date().toISOString();
    o.updatedAt = o.decidedAt;
    return o;
  }
}

let storeInstance: OffersStore | null = null;
async function getStoreAsync(): Promise<OffersStore> {
  if (storeInstance) return storeInstance;
  try {
    getPool();
    await getPool().query("SELECT 1");
    storeInstance = new PgOffersStore();
  } catch {
    storeInstance = new MemoryOffersStore();
  }
  return storeInstance;
}

/** Attach coin display fields to an offer (best effort — never fails the request). */
async function withCoinDisplay(offer: SwapOffer): Promise<SwapOffer> {
  try {
    const issuance = await getIssuanceStore();
    const [target, oc]: Array<IssuanceCoin | null> = await Promise.all([
      issuance.getCoinByChainId(offer.targetChainId),
      issuance.getCoinByChainId(offer.offerChainId),
    ]);
    return {
      ...offer,
      targetTicker: target?.ticker ?? null,
      targetName: target?.name ?? null,
      targetPriceUsd: target ? String(target.priceUsd) : null,
      offerTicker: oc?.ticker ?? null,
      offerName: oc?.name ?? null,
      offerPriceUsd: oc ? String(oc.priceUsd) : null,
    };
  } catch {
    return offer;
  }
}

/** Fee preview for proposed NET request units (estimate — execution uses live config). */
async function feePreview(requestUnits: bigint): Promise<{ feeBps: number; grossUnits: string; feeUnits: string; buyerReceivesUnits: string }> {
  const cfg = await getFeeConfig();
  const gross = grossUnitsForNet(requestUnits, cfg.feeBps);
  const fee = (gross * BigInt(cfg.feeBps)) / 10000n;
  return {
    feeBps: cfg.feeBps,
    grossUnits: coinUnitsToDecimal(gross),
    feeUnits: coinUnitsToDecimal(fee),
    buyerReceivesUnits: coinUnitsToDecimal(gross - fee),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountOffersRoutes(deps: OffersMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof OffersHttpError;

  const fail = (ctx: OffersCtx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...NETWORK_ENVELOPE, error: code, message });
  };

  const requireUserId = async (ctx: OffersCtx): Promise<string> => {
    const authed = await resolveBearerUserId(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    const body = asRecord(ctx.body);
    const claimed = str(body.userId) || str(ctx.query.get("userId"));
    if (claimed && claimed !== authed) {
      throw new HttpError(403, "forbidden", "This request is for a different user.");
    }
    return authed;
  };

  const idempotencyKey = (ctx: OffersCtx, fallback: string): string => {
    const header = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
    const h = Array.isArray(header) ? header[0] : header;
    return str(h) || str(asRecord(ctx.body).idempotencyKey) || fallback;
  };

  const clientIp = (ctx: OffersCtx): string => clientIpFromHeaders(ctx.req.headers);

  // --- POST /api/v1/offers ---
  // Body: { targetChainId, offerChainId, offerUnits, requestUnits, buyerAddress, idempotencyKey? }
  // Creates a pending swap proposal. Nothing moves on-chain until accepted.
  route("POST", "/api/v1/offers", async (ctx) => {
    try {
      if (!checkRateLimit(`offer:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many offers — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const buyerUserId = await requireUserId(ctx);
      const targetChainId = str(body.targetChainId);
      if (!targetChainId) throw new HttpError(400, "missing_target_chain_id", "Body must include targetChainId.");
      const offerChainId = str(body.offerChainId);
      if (!offerChainId) throw new HttpError(400, "missing_offer_chain_id", "Body must include offerChainId.");
      const buyerAddress = str(body.buyerAddress);
      if (!isValidAddress(buyerAddress)) {
        throw new HttpError(422, "invalid_buyer_address", "buyerAddress must be a valid ph1 address.");
      }
      const offerUnits = parseWholeCoinUnits(body.offerUnits, "offerUnits");
      const requestUnits = parseWholeCoinUnits(body.requestUnits, "requestUnits");
      const key = idempotencyKey(ctx, `offer-${buyerUserId}-${targetChainId}-${Date.now()}`);

      const issuance = await getIssuanceStore();
      const target = await issuance.getCoinByChainId(targetChainId);
      if (!target) throw new HttpError(404, "coin_not_found", "No issued coin for the target chain.");
      const offerCoin = await issuance.getCoinByChainId(offerChainId);
      if (!offerCoin) throw new HttpError(404, "offer_coin_not_found", "No issued coin for the offer chain.");
      if (target.userId === buyerUserId) {
        throw new HttpError(422, "self_trade", "You can't make an offer on your own coin.");
      }
      if (offerCoin.userId !== buyerUserId) {
        throw new HttpError(422, "offer_not_yours", "You can only offer coins you issued.");
      }
      for (const [c, label] of [[target, "target"], [offerCoin, "offer"]] as const) {
        const p = Number(c.priceUsd);
        if (!Number.isFinite(p) || p <= 0) {
          throw new HttpError(422, "coin_not_priced", `The ${label} coin has no trade price yet.`);
        }
      }
      // The buyer must actually hold the offered units at creation time.
      // The issuer's retained stake lives at the coin's recorded issuerAddress
      // (credited at genesis); a device wallet can change across installs, so
      // fall back to the recorded address when the client-supplied address
      // doesn't hold the offered units. Only the coin's issuer can reach this
      // point (offer_not_yours is enforced above), so this is safe.
      let effectiveBuyerAddress = buyerAddress;
      let offerBal: bigint;
      try {
        offerBal = BigInt(getChainBalance(offerChainId, buyerAddress));
      } catch {
        throw new HttpError(404, "offer_coin_not_found", "The offer chain is unknown on this node.");
      }
      if (offerBal < offerUnits && isValidAddress(offerCoin.issuerAddress) && offerCoin.issuerAddress !== buyerAddress) {
        let issuerBal = 0n;
        try { issuerBal = BigInt(getChainBalance(offerChainId, offerCoin.issuerAddress)); } catch { issuerBal = 0n; }
        if (issuerBal >= offerUnits) {
          effectiveBuyerAddress = offerCoin.issuerAddress;
          offerBal = issuerBal;
        }
      }
      if (offerBal < offerUnits) {
        throw new HttpError(409, "insufficient_offer_balance", "You don't hold enough of your offered coin for this proposal.");
      }

      const store = await getStoreAsync();
      const cfg = await getFeeConfig();
      const offer = await store.create({
        targetChainId,
        targetCoinId: target.id,
        sellerUserId: target.userId,
        buyerUserId,
        buyerAddress: effectiveBuyerAddress,
        offerChainId,
        offerCoinId: offerCoin.id,
        offerUnits: coinUnitsToDecimal(offerUnits),
        requestUnits: coinUnitsToDecimal(requestUnits),
        feeBps: cfg.feeBps,
        status: "pending",
        idempotencyKey: key,
      });
      await auditLog(buyerUserId, "swap_offer_created", "swap_offer", offer.id,
        { targetChainId, offerChainId, offerUnits: offerUnits.toString(), requestUnits: requestUnits.toString(), buyerAddress: effectiveBuyerAddress });

      sendJson(ctx.res, 201, {
        ...NETWORK_ENVELOPE,
        offer: await withCoinDisplay(offer),
        feePreview: await feePreview(requestUnits),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/offers/inbox?filter=active|all ---
  // Offers where the caller is the seller (needs their accept/counter/decline).
  route("GET", "/api/v1/offers/inbox", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const activeOnly = (ctx.query.get("filter") || "active") !== "all";
      const store = await getStoreAsync();
      const offers = await store.listBySeller(userId, activeOnly);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        offers: await Promise.all(offers.map(withCoinDisplay)),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/offers/outbox?filter=active|all ---
  // Offers the caller sent (pending with seller, or countered back to them).
  route("GET", "/api/v1/offers/outbox", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const activeOnly = (ctx.query.get("filter") || "active") !== "all";
      const store = await getStoreAsync();
      const offers = await store.listByBuyer(userId, activeOnly);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        offers: await Promise.all(offers.map(withCoinDisplay)),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/offers/:id/accept ---
  // Seller accepts a pending offer, or buyer accepts a counter. Settles on-chain.
  route("POST", "/api/v1/offers/:id/accept", async (ctx) => {
    try {
      if (!checkRateLimit(`offerdecide:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many decisions — wait a minute and try again.");
      }
      const userId = await requireUserId(ctx);
      const store = await getStoreAsync();
      const offer = await store.getById(str(ctx.params.id));
      if (!offer) throw new HttpError(404, "offer_not_found", "No offer with that id.");

      let finalOfferUnits: bigint;
      let finalRequestUnits: bigint; // NET wanted
      if (offer.status === "pending") {
        if (userId !== offer.sellerUserId) {
          throw new HttpError(403, "not_your_decision", "Only the seller can accept this offer.");
        }
        finalOfferUnits = decimalToCoinUnits(offer.offerUnits);
        finalRequestUnits = decimalToCoinUnits(offer.requestUnits);
      } else if (offer.status === "countered") {
        if (userId !== offer.buyerUserId) {
          throw new HttpError(403, "not_your_decision", "Only the buyer can accept the counter.");
        }
        finalOfferUnits = decimalToCoinUnits(offer.counterOfferUnits ?? offer.offerUnits);
        finalRequestUnits = decimalToCoinUnits(offer.counterRequestUnits ?? offer.requestUnits);
      } else {
        throw new HttpError(409, "offer_closed", "This offer is no longer open.");
      }

      // Gross target units for the agreed NET, under the live fee config.
      const cfg = await getFeeConfig();
      const grossUnits = grossUnitsForNet(finalRequestUnits, cfg.feeBps);

      let settlement: SwapSettlementResult;
      try {
        settlement = await executeSwapSettlement({
          chainId: offer.targetChainId,
          offerChainId: offer.offerChainId,
          offerUnits: finalOfferUnits,
          targetUnits: grossUnits,
          buyerUserId: offer.buyerUserId,
          buyerAddress: offer.buyerAddress,
          idempotencyKey: `offer-accept-${offer.id}`,
        });
      } catch (err) {
        // Settlement failures (e.g. balances moved since the offer) leave the
        // offer open so the parties can adjust — the error is reported as-is.
        throw err;
      }

      const decided = await store.setDecided(offer.id, "accepted", settlement.trade.id);
      await auditLog(userId, "swap_offer_accepted", "swap_offer", offer.id,
        { tradeId: settlement.trade.id, offerUnits: finalOfferUnits.toString(), grossUnits: grossUnits.toString() });

      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        offer: await withCoinDisplay(decided),
        trade: settlement.trade,
        fee: settlement.fee,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/offers/:id/counter ---
  // Body: { requestUnits?, offerUnits? } — seller proposes different terms.
  route("POST", "/api/v1/offers/:id/counter", async (ctx) => {
    try {
      if (!checkRateLimit(`offerdecide:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many decisions — wait a minute and try again.");
      }
      const userId = await requireUserId(ctx);
      const body = asRecord(ctx.body);
      const store = await getStoreAsync();
      const offer = await store.getById(str(ctx.params.id));
      if (!offer) throw new HttpError(404, "offer_not_found", "No offer with that id.");
      if (offer.status !== "pending") {
        throw new HttpError(409, "offer_closed", "Only a pending offer can be countered.");
      }
      if (userId !== offer.sellerUserId) {
        throw new HttpError(403, "not_your_decision", "Only the seller can counter this offer.");
      }
      const hasOfferUnits = body.offerUnits !== undefined && body.offerUnits !== null && str(body.offerUnits) !== "";
      const hasRequestUnits = body.requestUnits !== undefined && body.requestUnits !== null && str(body.requestUnits) !== "";
      if (!hasOfferUnits && !hasRequestUnits) {
        throw new HttpError(400, "empty_counter", "Counter with new offerUnits and/or requestUnits.");
      }
      const counterOfferUnits = hasOfferUnits ? coinUnitsToDecimal(parseWholeCoinUnits(body.offerUnits, "offerUnits")) : null;
      const counterRequestUnits = hasRequestUnits ? coinUnitsToDecimal(parseWholeCoinUnits(body.requestUnits, "requestUnits")) : null;

      const updated = await store.setCounter(offer.id, counterOfferUnits, counterRequestUnits);
      await auditLog(userId, "swap_offer_countered", "swap_offer", offer.id,
        { counterOfferUnits, counterRequestUnits });

      const effRequest = decimalToCoinUnits(counterRequestUnits ?? updated.requestUnits);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        offer: await withCoinDisplay(updated),
        feePreview: await feePreview(effRequest),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/offers/:id/decline ---
  // Seller declines, buyer declines a counter, or buyer cancels their offer.
  route("POST", "/api/v1/offers/:id/decline", async (ctx) => {
    try {
      if (!checkRateLimit(`offerdecide:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many decisions — wait a minute and try again.");
      }
      const userId = await requireUserId(ctx);
      const store = await getStoreAsync();
      const offer = await store.getById(str(ctx.params.id));
      if (!offer) throw new HttpError(404, "offer_not_found", "No offer with that id.");
      if (offer.status !== "pending" && offer.status !== "countered") {
        throw new HttpError(409, "offer_closed", "This offer is no longer open.");
      }
      if (userId !== offer.sellerUserId && userId !== offer.buyerUserId) {
        throw new HttpError(403, "not_your_decision", "Only the buyer or seller can close this offer.");
      }
      const status = userId === offer.buyerUserId ? "cancelled" : "declined";
      const decided = await store.setDecided(offer.id, status);
      await auditLog(userId, "swap_offer_declined", "swap_offer", offer.id, { status });
      sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, offer: await withCoinDisplay(decided) });
    } catch (err) { fail(ctx, err); }
  });
}
