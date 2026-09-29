/**
 * ============================================================================
 *  PHASE PROTOCOL — Backend & Ledger Engine
 * ============================================================================
 *
 *  A single-file, zero-dependency TypeScript/Node backend that simulates a
 *  permissioned, zero-gas Proof-of-Authority ledger entirely in memory.
 *  There is no real blockchain underneath this — `blockchainState` is a
 *  plain in-process array standing in for one. Restarting the process wipes
 *  all state. This is intentional: it's a fast, dependency-free simulation
 *  layer to prototype against before wiring up a real chain (see the
 *  earlier Besu/QBFT slice for that path).
 *
 *  Deliberately built on Node's built-in `http` module only — no Express,
 *  no npm install required. Run with:
 *      npx tsx phase-backend.ts
 *  or compile with `tsc` and run with plain `node`.
 *
 *  ----------------------------------------------------------------------
 *  WHAT'S REAL vs WHAT'S SIMULATED (read this before treating any output
 *  as financial fact):
 *    - "Shares", "Phase Coins", "balances" — all just numbers in a JS
 *      object. No cryptography, no consensus, no actual settlement.
 *    - Market prices for BTC/USDC conversion — hardcoded mock rates, not
 *      live market data. Swap MOCK_MARKET_RATES for a real price feed
 *      (Chainlink, CoinGecko, etc.) before this means anything financially.
 *    - "HUMAN" asset class lets a profile mint tradable equity-like claims
 *      on a person. Whatever the chain layer ends up being, that pattern
 *      is securities-shaped in most jurisdictions — get real legal review
 *      before any of this touches real users or real money. Nothing about
 *      this file changes that.
 *  ----------------------------------------------------------------------
 *
 *  CONCURRENCY MODEL — object-isolated execution, not a global state lock
 *  ----------------------------------------------------------------------
 *  State here is NOT protected by one giant lock the way a naive port of
 *  "the blockchain is an array" might suggest. Each Profile and each
 *  AssetListing is its own independently-locked object (see ObjectStore
 *  below). Two requests touching two different objects run fully
 *  concurrently with no contention. Two requests touching the SAME object
 *  serialize against each other automatically and safely.
 *
 *  This mirrors how real object-based parallel-execution runtimes (Sui/
 *  Move's object model, Solana's account-access-list scheduling) get
 *  parallelism: by declaring up front which objects a transaction touches,
 *  the runtime only has to serialize the transactions that actually
 *  collide. Node itself is single-threaded, so this file can't give you
 *  literal multi-core parallelism — what it gives you is the *correct
 *  lock boundary*, so the business logic ports cleanly to a runtime that
 *  can parallelize it for real, without a rewrite.
 *  ----------------------------------------------------------------------
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { getUsdPerBtc, getQuote, getFeedStatus } from "./market-data.js";
import { mountFundingRoutes } from "./crypto-funding.js";
import { mountBtcRoutes } from "./btc-funding.js";
import { mountStripeRoutes } from "./stripe-funding.js";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountAuthRoutes, resolveBearerUserId } from "./auth.js";
import { mountSovereignLedgerRoutes } from "./sovereign-ledger.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountLegalDocsRoutes } from "./legal-docs.js";
import { mountSocialRoutes } from "./social-auth.js";
import { mountAnnounceRoutes } from "./social-announce.js";
import { migrate as migrateFundingDb } from "./db.js";

// ============================================================================
// 0. OBJECT STORE — per-key async locking (the object-isolation primitive)
// ============================================================================

/**
 * A keyed store where each key gets its own independent lock queue.
 *
 * Why this exists: the EVM-style trap is one global state tree where every
 * transaction implicitly contends with every other transaction, even ones
 * that touch completely unrelated accounts. Phase's actual objects
 * (a Profile, an AssetListing) are naturally independent — Alice trading
 * Asset A and Bob launching Asset B never need to wait on each other.
 *
 * `withLock(key, fn)` guarantees:
 *   - Only one in-flight mutation per key at a time (no lost updates, no
 *     read-modify-write races on the SAME object).
 *   - Zero contention across DIFFERENT keys — they run interleaved/concurrently
 *     as far as the event loop is concerned, with no shared queue.
 *
 * This is a real, working concurrency primitive (not a simulation of one).
 * It's also exactly the boundary a future port to an object-based parallel
 * runtime (Sui/Move object ownership, Solana account access lists) would
 * need — this file draws that boundary at the data-model level now, so
 * there's no re-architecture later, just a faster lock implementation.
 */
class ObjectStore<T> {
  private items = new Map<string, T>();
  private lockQueues = new Map<string, Promise<unknown>>();

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Direct read without locking — safe for simple snapshot reads (GETs). */
  peek(key: string): T | undefined {
    return this.items.get(key);
  }

  keys(): string[] {
    return Array.from(this.items.keys());
  }

  values(): T[] {
    return Array.from(this.items.values());
  }

  get size(): number {
    return this.items.size;
  }

  /**
   * Runs `fn` with exclusive access to the object at `key`. If another
   * operation already holds this key's lock, `fn` waits for it — but
   * operations on OTHER keys are entirely unaffected and proceed immediately.
   *
   * `fn` receives the current value (or undefined if not yet created) and
   * must return the new value to store (or undefined to delete/leave absent).
   */
  async withLock<R>(
    key: string,
    fn: (current: T | undefined) => Promise<{ result: R; next: T | undefined }> | { result: R; next: T | undefined }
  ): Promise<R> {
    // Chain onto whatever's currently pending for this key. If nothing is
    // pending, this resolves immediately — no cross-key contention.
    const previous = this.lockQueues.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lockQueues.set(key, previous.then(() => current));

    await previous;

    try {
      const outcome = await fn(this.items.get(key));
      if (outcome.next === undefined) {
        this.items.delete(key);
      } else {
        this.items.set(key, outcome.next);
      }
      return outcome.result;
    } finally {
      release();
      // Clean up the queue entry if nothing chained onto us further.
      if (this.lockQueues.get(key) === current) {
        this.lockQueues.delete(key);
      }
    }
  }

  /**
   * Locks TWO keys at once, in a fixed deterministic order (alphabetical
   * by key), to prevent deadlock. This is the primitive a trade/transfer
   * endpoint needs — it touches a buyer's Profile AND an AssetListing,
   * and must not corrupt either if two trades race.
   *
   * Real object-parallel runtimes solve this with the same trick: sort the
   * object IDs a transaction declares it will touch, acquire in that order,
   * every transaction, every time. That alone is enough to make deadlock
   * structurally impossible without a deadlock detector.
   */
  async withTwoLocks<R>(
    keyA: string,
    keyB: string,
    fn: (a: T | undefined, b: T | undefined) => Promise<{ result: R; nextA: T | undefined; nextB: T | undefined }>
  ): Promise<R> {
    if (keyA === keyB) {
      throw new Error("withTwoLocks: keyA and keyB must be different objects");
    }
    const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];

    return this.withLock(first, async (firstVal) => {
      const result = await this.withLock(second, async (secondVal) => {
        const a = first === keyA ? firstVal : secondVal;
        const b = first === keyA ? secondVal : firstVal;
        const outcome = await fn(a, b);
        const nextSecond = first === keyA ? outcome.nextB : outcome.nextA;
        return { result: outcome, next: nextSecond };
      });
      const nextFirst = first === keyA ? result.nextA : result.nextB;
      return { result: result.result, next: nextFirst };
    });
  }
}

// ============================================================================
// 1. CORE STATE — the "blockchain" (an array of immutable-once-written blocks)
// ============================================================================

type AssetClass = "HARD" | "SOFT" | "HUMAN";

interface LedgerBlock {
  blockId: string;
  index: number;
  timestamp: string;
  type: string; // e.g. "ASSET_LAUNCH", "WHITELIST_GRANT", "SIGNUP_BONUS", "TRANSFER"
  payload: Record<string, unknown>;
  prevBlockId: string | null;
}

/** The simulated chain. Append-only by convention (see appendBlock). */
const blockchainState: LedgerBlock[] = [];

function appendBlock(type: string, payload: Record<string, unknown>): LedgerBlock {
  const prev = blockchainState[blockchainState.length - 1] ?? null;
  const block: LedgerBlock = {
    blockId: randomUUID(),
    index: blockchainState.length,
    timestamp: new Date().toISOString(),
    type,
    payload,
    prevBlockId: prev ? prev.blockId : null,
  };
  blockchainState.push(block);
  return block;
}

// ============================================================================
// 2. IDENTITY & WHITELIST STATE
// ============================================================================

interface Profile {
  did: string;
  walletAddress: string;
  createdAt: string;
  isWhitelisted: boolean;
  phaseCoinBalance: number; // locked, marketplace-only currency
  holdings: Record<string, number>; // assetTicker -> share count owned
}

/** did -> active boolean. The whitelistGateway middleware checks this. */
const activeWhitelists = new Map<string, boolean>();

/** did -> session userId that bootstrapped it. The whitelistGateway
 *  middleware requires the Bearer session user to own the asserted DID. */
const didOwners = new Map<string, string>();

/** did -> Profile, object-isolated: each DID has its own independent lock. */
const profiles = new ObjectStore<Profile>();

const SIGN_UP_BONUS = 1000;

async function createProfile(did: string): Promise<Profile> {
  // The existence check and the write must happen under the SAME lock,
  // otherwise two concurrent bootstrap requests for the same DID could
  // both pass the check before either writes (a classic TOCTOU race).
  return profiles.withLock(did, (existing) => {
    if (existing) {
      throw new HttpError(409, "profile_already_exists", `Profile ${did} already exists`);
    }

    const profile: Profile = {
      did,
      walletAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      createdAt: new Date().toISOString(),
      isWhitelisted: true, // bootstrap auto-whitelists; swap for manual review gate in prod
      phaseCoinBalance: SIGN_UP_BONUS,
      holdings: {},
    };

    activeWhitelists.set(did, true);

    appendBlock("PROFILE_CREATED", { did, walletAddress: profile.walletAddress });
    appendBlock("SIGNUP_BONUS", { did, amount: SIGN_UP_BONUS, locked: true });

    return { result: profile, next: profile };
  });
}

// ============================================================================
// 3. MARKETPLACE / ASSET DIRECTORY
// ============================================================================

interface AssetListing {
  assetId: string;
  ownerDid: string;
  assetName: string;
  assetTicker: string;
  assetClass: AssetClass;
  subSector: string;
  valueProposition: string;
  publicSalePercentage: number;
  retainedPercentage: number;
  totalShares: 1_000_000;
  publicShares: number;
  retainedShares: number;
  currentPriceUsd: number;
  initialPriceUsd: number;
  tickDirection: "UP" | "DOWN" | "FLAT";
  externalReferenceUrl: string;
  isLive: boolean;
  createdAt: string;
}

/** Global marketplace directory, object-isolated and keyed by ticker. */
const marketplaceDirectory = new ObjectStore<AssetListing>();

/** assetTicker -> true once registered. Existence check happens under the
 *  asset's own lock at write time (see launch route) — this set is only a
 *  fast read-side helper, never the source of truth for the race check. */
const tickerRegistry = new Set<string>();

// REMOVED (production): seedZeroStateListing() seeded a "Phase Genesis Demo
// Asset" on every boot. The marketplace directory is now populated only by
// real issuance through the /api/v1/issuance flow.

// ============================================================================
// 4. MOCK MARKET RATES (tri-denomination conversion)
// ============================================================================

/**
 * Mock, hardcoded conversion rates. In a real system these come from a live
 * price feed (Chainlink, CoinGecko, etc.) — swapping the lookup function
 * below for a real fetch is the only change needed to go live.
 */
const MOCK_MARKET_RATES = {
  usdPerBtc: 97_000,
  usdPerUsdc: 1.0,
};

type Denomination = "USD" | "USDC" | "BTC";

function convertUsd(amountUsd: number, denom: Denomination): number {
  switch (denom) {
    case "USD":
      return amountUsd;
    case "USDC":
      return amountUsd / MOCK_MARKET_RATES.usdPerUsdc;
    case "BTC":
      return amountUsd / MOCK_MARKET_RATES.usdPerBtc;
  }
}

function isValidDenom(value: string): value is Denomination {
  return value === "USD" || value === "USDC" || value === "BTC";
}

// ============================================================================
// 5. PRICE-FLASH DAEMON — runs every 2.5s, jitters marketplace prices
// ============================================================================

const PRICE_TICK_INTERVAL_MS = 2_500;
const MAX_TICK_PERCENT = 0.015; // up to +/-1.5% per tick, kept small & demo-safe

function runPriceTick(): void {
  // Fire-and-forget a lock-scoped update per asset. Each asset's update is
  // fully independent — the daemon ticking Asset A never waits on Asset B,
  // and if a user trade is mid-flight against Asset A right now, this tick
  // correctly queues behind it rather than racing it.
  for (const ticker of marketplaceDirectory.keys()) {
    void marketplaceDirectory.withLock(ticker, (asset) => {
      if (!asset) return { result: undefined, next: asset };

      const changePercent = (Math.random() * 2 - 1) * MAX_TICK_PERCENT;
      const previousPrice = asset.currentPriceUsd;
      const nextPrice = Math.max(0.0001, previousPrice * (1 + changePercent));

      const updated: AssetListing = {
        ...asset,
        currentPriceUsd: Number(nextPrice.toFixed(8)),
        tickDirection: nextPrice > previousPrice ? "UP" : nextPrice < previousPrice ? "DOWN" : "FLAT",
      };

      return { result: undefined, next: updated };
    });
  }
}

let priceTickHandle: NodeJS.Timeout | null = null;

function startPriceDaemon(): void {
  if (priceTickHandle) return;
  priceTickHandle = setInterval(runPriceTick, PRICE_TICK_INTERVAL_MS);
}

function stopPriceDaemon(): void {
  if (priceTickHandle) {
    clearInterval(priceTickHandle);
    priceTickHandle = null;
  }
}

// ============================================================================
// 6. HTTP PLUMBING — tiny router + error handling (no Express, by design)
// ============================================================================

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Raw request bytes (for HMAC/ECDSA webhook signature verification). */
  rawBody?: Buffer;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const patternStr = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${patternStr}$`), paramNames };
}

export function route(method: string, path: string, handler: RouteHandler): void {
  const { pattern, paramNames } = compilePath(path);
  routes.push({ method, pattern, paramNames, handler });
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ============================================================================
// 7. WHITELIST GATEWAY MIDDLEWARE
// ============================================================================

/**
 * Per spec: every transaction payload must carry an identifying DID or
 * wallet address. If it's not flagged active in `activeWhitelists`, reject
 * instantly. This wraps a handler rather than running as Express middleware,
 * since this file has no Express — same contract, no dependency.
 */
function whitelistGateway(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    // Bearer <redacted> is required IN ADDITION to the DID whitelist check.
    // The session userId must own the asserted DID.
    const sessionUserId = await resolveBearerUserId(ctx.req.headers);
    if (!sessionUserId) {
      throw new HttpError(401, "unauthorized", "Sign in required.");
    }
    const body = ctx.body as Record<string, unknown> | undefined;
    const did =
      typeof body?.ownerDid === "string"
        ? body.ownerDid
        : typeof body?.buyerDid === "string"
        ? body.buyerDid
        : typeof body?.senderDid === "string"
        ? body.senderDid
        : typeof body?.did === "string"
        ? body.did
        : undefined;

    if (!did) {
      throw new HttpError(
        400,
        "missing_did",
        "Request payload must include a DID (ownerDid, buyerDid, senderDid, or did field)"
      );
    }

    const isActive = activeWhitelists.get(did) === true;
    if (!isActive) {
      throw new HttpError(403, "unauthorized_did", `DID '${did}' is not an active whitelisted identity`);
    }
    if (didOwners.get(did) !== sessionUserId) {
      throw new HttpError(403, "forbidden", "This DID belongs to a different user.");
    }

    await handler(ctx);
  };
}

// ============================================================================
// 8. ROUTES
// ============================================================================

// --- 8a. Bootstrap: create a profile, auto-whitelist, grant signup bonus ---
route("POST", "/api/v1/profile/bootstrap", async (ctx) => {
  // Bootstrap requires a valid Bearer session and binds the DID to it.
  // A DID already owned by a different user cannot be taken over.
  const sessionUserId = await resolveBearerUserId(ctx.req.headers);
  if (!sessionUserId) {
    throw new HttpError(401, "unauthorized", "Sign in required.");
  }
  const body = ctx.body as { did?: string } | undefined;
  const did = body?.did?.trim();

  if (!did || !did.startsWith("did:phase:")) {
    throw new HttpError(400, "invalid_did", "Body must include `did` in the form did:phase:xxxx");
  }
  const existingOwner = didOwners.get(did);
  if (existingOwner && existingOwner !== sessionUserId) {
    throw new HttpError(403, "forbidden", "This DID is already registered to a different user.");
  }

  const profile = await createProfile(did);
  didOwners.set(did, sessionUserId);
  sendJson(ctx.res, 201, {
    message: "Profile created, whitelisted, and signup bonus granted.",
    profile,
  });
});

// --- 8b. Universal "Go Live" Token Factory ---
interface LaunchRequestBody {
  ownerDid: string;
  assetName: string;
  assetTicker: string;
  assetClass: AssetClass;
  subSector: string;
  valueProposition: string;
  publicSalePercentage: number;
  retainedPercentage: number;
  externalReferenceUrl?: string;
}

function isLaunchBody(body: unknown): body is LaunchRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.ownerDid === "string" &&
    typeof b.assetName === "string" &&
    typeof b.assetTicker === "string" &&
    (b.assetClass === "HARD" || b.assetClass === "SOFT" || b.assetClass === "HUMAN") &&
    typeof b.subSector === "string" &&
    typeof b.valueProposition === "string" &&
    typeof b.publicSalePercentage === "number" &&
    typeof b.retainedPercentage === "number"
  );
}

route(
  "POST",
  "/api/v1/assets/launch",
  whitelistGateway(async (ctx) => {
    if (!isLaunchBody(ctx.body)) {
      throw new HttpError(
        400,
        "validation_failed",
        "Body must include ownerDid, assetName, assetTicker, assetClass (HARD|SOFT|HUMAN), " +
          "subSector, valueProposition, publicSalePercentage, retainedPercentage (numbers summing to 100)"
      );
    }

    const body = ctx.body;
    const { ownerDid, publicSalePercentage, retainedPercentage } = body;

    // Invariant: E_pub + E_ret == 100. Use a small epsilon for float safety.
    // Checked before acquiring any locks — pure input validation, no shared
    // state involved, so there's no reason to make other operations wait.
    const sum = publicSalePercentage + retainedPercentage;
    if (Math.abs(sum - 100) > 1e-6) {
      throw new HttpError(
        422,
        "invariant_violation",
        `publicSalePercentage + retainedPercentage must equal 100 (got ${sum})`
      );
    }
    if (publicSalePercentage < 0 || retainedPercentage < 0) {
      throw new HttpError(422, "invalid_split", "Percentages must be non-negative");
    }

    const normalizedTicker = body.assetTicker.trim().toUpperCase();

    // This is the operation that touches TWO distinct objects: the owner's
    // Profile (gains retained shares) and the new AssetListing (gets
    // created). withTwoLocks acquires both in deterministic order so this
    // can never deadlock against a concurrent trade/transfer that also
    // touches both a profile and an asset.
    //
    // Note this does NOT block a concurrent launch of a DIFFERENT ticker
    // by a different owner — that runs fully in parallel. It only
    // serializes against another operation touching THIS owner or THIS
    // ticker specifically.
    const outcome = await profiles.withLock(ownerDid, async (profileVal) => {
      if (!profileVal) {
        throw new HttpError(404, "profile_not_found", `No profile exists for ${ownerDid}`);
      }

      const inner = await marketplaceDirectory.withLock(normalizedTicker, (existingAsset) => {
        // The authoritative duplicate-ticker check happens HERE, inside
        // the lock — not via a pre-check against tickerRegistry, which
        // would be racy (two concurrent launches for the same new ticker
        // could both pass a pre-check before either writes).
        if (existingAsset || tickerRegistry.has(normalizedTicker)) {
          throw new HttpError(409, "ticker_taken", `Ticker ${normalizedTicker} is already in use`);
        }

        const totalShares = 1_000_000 as const;
        const publicShares = Math.round((publicSalePercentage / 100) * totalShares);
        const retainedShares = totalShares - publicShares; // guarantees exact total regardless of rounding
        const initialPrice = 1.0; // flat $1.00/share at launch; replace with a real pricing model later

        const listing: AssetListing = {
          assetId: randomUUID(),
          ownerDid,
          assetName: body.assetName,
          assetTicker: normalizedTicker,
          assetClass: body.assetClass,
          subSector: body.subSector,
          valueProposition: body.valueProposition,
          publicSalePercentage,
          retainedPercentage,
          totalShares,
          publicShares,
          retainedShares,
          currentPriceUsd: initialPrice,
          initialPriceUsd: initialPrice,
          tickDirection: "FLAT",
          externalReferenceUrl: body.externalReferenceUrl ?? "https://www.google.com/finance/",
          isLive: true,
          createdAt: new Date().toISOString(),
        };

        tickerRegistry.add(normalizedTicker);

        // Mutate the profile we already hold the lock for. This is safe
        // specifically because we're still inside profiles.withLock(ownerDid, ...)
        // up the call stack — no other operation can be touching this
        // profile right now.
        const updatedProfile: Profile = {
          ...profileVal,
          holdings: {
            ...profileVal.holdings,
            [normalizedTicker]: (profileVal.holdings[normalizedTicker] ?? 0) + retainedShares,
          },
        };

        const block = appendBlock("ASSET_LAUNCH", { ...listing });

        return {
          result: { listing, updatedProfile, block },
          next: listing,
        };
      });

      // Commit the profile update as the OUTER lock's `next` value — this
      // is the actual write to the Profile object. Forgetting this step
      // would silently drop the holdings update despite the asset having
      // been created, since `next` (not a side-effect mutation) is what
      // ObjectStore persists.
      return { result: inner, next: inner.updatedProfile };
    });

    sendJson(ctx.res, 201, {
      message: `Asset ${normalizedTicker} is now live.`,
      listing: outcome.listing,
      ledgerBlock: { blockId: outcome.block.blockId, index: outcome.block.index },
    });
  })
);

// --- 8c. Buy shares on the marketplace ---
// This is the route that genuinely exercises object-isolated concurrency:
// it touches TWO objects (a buyer Profile, an AssetListing) and must keep
// both in sync even when many trades for the SAME asset race each other.
interface BuySharesBody {
  buyerDid: string;
  assetTicker: string;
  shares: number;
}

function isBuySharesBody(body: unknown): body is BuySharesBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.buyerDid === "string" &&
    typeof b.assetTicker === "string" &&
    typeof b.shares === "number" &&
    Number.isFinite(b.shares)
  );
}

route(
  "POST",
  "/api/v1/marketplace/buy",
  whitelistGateway(async (ctx) => {
    if (!isBuySharesBody(ctx.body)) {
      throw new HttpError(
        400,
        "validation_failed",
        "Body must include buyerDid, assetTicker, shares (positive integer)"
      );
    }

    const { buyerDid } = ctx.body;
    const normalizedTicker = ctx.body.assetTicker.trim().toUpperCase();
    const shares = Math.floor(ctx.body.shares);

    if (shares <= 0) {
      throw new HttpError(422, "invalid_share_count", "shares must be a positive integer");
    }
    if (buyerDid === undefined) {
      throw new HttpError(400, "missing_buyer", "buyerDid is required");
    }

    // Two genuinely different objects, locked together via withTwoLocks.
    // A concurrent buy against a DIFFERENT ticker by a different buyer is
    // entirely unaffected by this — it acquires different locks and
    // proceeds without ever touching this queue. Two buys for THIS same
    // ticker (even by different buyers) correctly serialize here, so
    // share counts can never be oversold by a race.
    const result = await profiles.withLock(buyerDid, async (buyerVal) => {
      if (!buyerVal) {
        throw new HttpError(404, "profile_not_found", `No profile exists for ${buyerDid}`);
      }

      const inner = await marketplaceDirectory.withLock(normalizedTicker, (asset) => {
        if (!asset) {
          throw new HttpError(404, "asset_not_found", `No asset listed under ${normalizedTicker}`);
        }
        if (!asset.isLive) {
          throw new HttpError(409, "asset_not_live", `${normalizedTicker} is not currently live`);
        }
        if (asset.publicShares < shares) {
          throw new HttpError(
            422,
            "insufficient_public_supply",
            `Only ${asset.publicShares} public shares remain for ${normalizedTicker}`
          );
        }

        const costUsd = asset.currentPriceUsd * shares;
        // Phase Coin balance is treated 1:1 with USD for this mock — replace
        // with a real internal pricing/FX model before this means anything.
        if (buyerVal.phaseCoinBalance < costUsd) {
          throw new HttpError(
            402,
            "insufficient_balance",
            `Need ${costUsd.toFixed(2)} Phase Coin, buyer has ${buyerVal.phaseCoinBalance.toFixed(2)}`
          );
        }

        const updatedAsset: AssetListing = {
          ...asset,
          publicShares: asset.publicShares - shares,
        };

        const updatedBuyer: Profile = {
          ...buyerVal,
          phaseCoinBalance: buyerVal.phaseCoinBalance - costUsd,
          holdings: {
            ...buyerVal.holdings,
            [normalizedTicker]: (buyerVal.holdings[normalizedTicker] ?? 0) + shares,
          },
        };

        const block = appendBlock("SHARE_PURCHASE", {
          buyerDid,
          assetTicker: normalizedTicker,
          shares,
          costUsd,
          remainingPublicShares: updatedAsset.publicShares,
        });

        return {
          result: { updatedAsset, updatedBuyer, block, costUsd },
          next: updatedAsset,
        };
      });

      // Commit the buyer's updated balance/holdings as this lock's `next`.
      return { result: inner, next: inner.updatedBuyer };
    });

    sendJson(ctx.res, 200, {
      message: `Purchased ${shares} shares of ${normalizedTicker}.`,
      costUsd: result.costUsd,
      remainingPublicShares: result.updatedAsset.publicShares,
      buyerPhaseCoinBalance: result.updatedBuyer.phaseCoinBalance,
      ledgerBlock: { blockId: result.block.blockId, index: result.block.index },
    });
  })
);

// --- 8d. Peer-to-peer share transfer ---
// Direct account-to-account transfer of asset shares using withTwoLocks —
// genuinely atomic, no intermediate "floating" state. This is the right
// pattern for current volume (see the note below on when it stops being
// the right pattern).
//
// SCALING NOTE — read before assuming this scales indefinitely:
// withTwoLocks serializes ALL traffic into a given account through that
// account's single lock queue. That's fine at today's volume. It becomes
// a real bottleneck the moment one account becomes a "hotspot" — e.g. an
// exchange-style hot wallet or a popular creator receiving many transfers
// concurrently — because every incoming transfer queues behind every other
// one touching that same account, even though they have nothing to do with
// each other.
//
// The fix at that point is NOT more locking — it's removing the need to
// lock both accounts at once. The real pattern (used by actual clearing
// systems, not just blockchains) is an escrow/invoice object:
//   Phase 1: lock sender only -> debit -> create a pending TransferInvoice
//   Phase 2 (async, separate lock): lock invoice + recipient -> credit -> mark cleared
// This drops sender-lock hold time to a fraction of a millisecond and
// removes the two-party lock entirely. It also requires a reconciliation
// sweep for invoices that get stuck in "pending" (crash between phases,
// bug, etc.) — that sweep job is real engineering work, not a footnote,
// and isn't built here because there's no hotspot to justify it yet.
//
// Migrate to that pattern when a specific account's transfer volume
// actually becomes a measured bottleneck — not before.
interface TransferRequestBody {
  senderDid: string;
  receiverDid: string;
  assetTicker: string;
  amount: number;
}

function isTransferBody(body: unknown): body is TransferRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.senderDid === "string" &&
    typeof b.receiverDid === "string" &&
    typeof b.assetTicker === "string" &&
    typeof b.amount === "number" &&
    Number.isFinite(b.amount)
  );
}

route(
  "POST",
  "/api/v1/profile/transfer",
  whitelistGateway(async (ctx) => {
    if (!isTransferBody(ctx.body)) {
      throw new HttpError(
        400,
        "validation_failed",
        "Body must include senderDid, receiverDid, assetTicker, amount (positive integer)"
      );
    }

    const { senderDid, receiverDid } = ctx.body;
    const normalizedTicker = ctx.body.assetTicker.trim().toUpperCase();
    const amount = Math.floor(ctx.body.amount);

    if (amount <= 0) {
      throw new HttpError(422, "invalid_amount", "amount must be a positive integer");
    }
    if (senderDid === receiverDid) {
      throw new HttpError(422, "self_transfer", "senderDid and receiverDid must differ");
    }

    // withTwoLocks acquires both profile locks in deterministic
    // (alphabetical-by-key) order regardless of which one is sender vs.
    // receiver, so a transfer A->B and a concurrent transfer B->A can
    // never deadlock against each other.
    //
    // Note the callback signature: ObjectStore.withTwoLocks does NOT let
    // you mutate the passed-in objects in place. It's an immutable-update
    // contract — you must return { result, nextA, nextB } with the new
    // versions of both objects, or the lock releases and nothing persists.
    const outcome = await profiles.withTwoLocks(
      senderDid,
      receiverDid,
      (senderVal, receiverVal) => {
        // a/b here correspond to (keyA, keyB) as originally passed, i.e.
        // (senderVal, receiverVal) regardless of internal lock-acquisition
        // order — withTwoLocks handles that remapping for us.
        const sender = senderVal;
        const receiver = receiverVal;

        if (!sender) {
          throw new HttpError(404, "profile_not_found", `No profile exists for ${senderDid}`);
        }
        if (!receiver) {
          throw new HttpError(404, "profile_not_found", `No profile exists for ${receiverDid}`);
        }

        const senderBalance = sender.holdings[normalizedTicker] ?? 0;
        if (senderBalance < amount) {
          throw new HttpError(
            422,
            "insufficient_holdings",
            `${senderDid} holds ${senderBalance} of ${normalizedTicker}, tried to send ${amount}`
          );
        }

        const updatedSender: Profile = {
          ...sender,
          holdings: { ...sender.holdings, [normalizedTicker]: senderBalance - amount },
        };
        const updatedReceiver: Profile = {
          ...receiver,
          holdings: {
            ...receiver.holdings,
            [normalizedTicker]: (receiver.holdings[normalizedTicker] ?? 0) + amount,
          },
        };

        // Appended inside the same lock scope as the balance mutation —
        // the ledger entry and the state change are committed together,
        // so the log can never drift out of sync with actual balances.
        const block = appendBlock("PEER_TRANSFER", {
          senderDid,
          receiverDid,
          assetTicker: normalizedTicker,
          amount,
        });

        return {
          result: { block, senderRemaining: updatedSender.holdings[normalizedTicker] },
          nextA: updatedSender,
          nextB: updatedReceiver,
        };
      }
    );

    sendJson(ctx.res, 200, {
      message: `Transferred ${amount} ${normalizedTicker} from ${senderDid} to ${receiverDid}.`,
      senderRemaining: outcome.senderRemaining,
      ledgerBlock: { blockId: outcome.block.blockId, index: outcome.block.index },
    });
  })
);

// --- 8e. Marketplace directory listing (read-only, for the UI) ---
// REMOVED (production): GET /api/v1/marketplace/directory served the legacy
// in-memory mock directory. The real marketplace listing is
// GET /api/v1/marketplace/coins (Postgres-backed, see marketplace.ts).

// --- 8e. Tri-Denomination Portfolio Valuation ---
route("GET", "/api/v1/portfolio/valuation", async (ctx) => {
  const did = ctx.query.get("did");
  const denomParam = (ctx.query.get("denom") ?? "USD").toUpperCase();

  if (!did) {
    throw new HttpError(400, "missing_did", "Query parameter `did` is required");
  }
  if (!isValidDenom(denomParam)) {
    throw new HttpError(400, "invalid_denom", "denom must be one of USD, USDC, BTC");
  }

  const profile = profiles.peek(did);
  if (!profile) {
    throw new HttpError(404, "profile_not_found", `No profile exists for ${did}`);
  }

  const tickerToAsset = new Map(marketplaceDirectory.values().map((a) => [a.assetTicker, a]));

  // Live BTC rate for the BTC denomination leg. Falls back to the mock rate
  // when the feed is unconfigured or unreachable — the response labels which
  // source was used so the app can show it honestly.
  const btcRate = await getUsdPerBtc();
  const convertLive = (amountUsd: number, denom: Denomination): number =>
    denom === "BTC" ? amountUsd / btcRate.usdPerBtc : convertUsd(amountUsd, denom);

  let totalValueUsd = 0;
  const holdingsBreakdown = Object.entries(profile.holdings).map(([ticker, shares]) => {
    const asset = tickerToAsset.get(ticker);
    const pricePerShareUsd = asset?.currentPriceUsd ?? 0;
    const valueUsd = pricePerShareUsd * shares;
    totalValueUsd += valueUsd;

    return {
      assetTicker: ticker,
      assetName: asset?.assetName ?? "Unknown (delisted)",
      shares,
      pricePerShare: convertLive(pricePerShareUsd, denomParam),
      holdingValue: convertLive(valueUsd, denomParam),
    };
  });

  sendJson(ctx.res, 200, {
    did,
    denom: denomParam,
    phaseCoinBalance: profile.phaseCoinBalance,
    phaseCoinNote: "Locked balance — usable only to purchase fractional equity shares on this marketplace, not externally redeemable.",
    totalPortfolioValue: convertLive(totalValueUsd, denomParam),
    holdings: holdingsBreakdown,
    ratesUsed: {
      usdPerBtc: btcRate.usdPerBtc,
      usdPerUsdc: MOCK_MARKET_RATES.usdPerUsdc,
      source: btcRate.source,
      stale: btcRate.stale,
      fetchedAt: btcRate.fetchedAt,
    },
    mockRatesUsed: MOCK_MARKET_RATES,
  });
});

// --- 8e-ii. Live market quote (Finnhub, cached; mock-labelled fallback) ---
route("GET", "/api/v1/market/quote", async (ctx) => {
  const symbol = ctx.query.get("symbol");
  if (!symbol) {
    throw new HttpError(400, "missing_symbol", "Query parameter `symbol` is required, e.g. ?symbol=AAPL");
  }
  sendJson(ctx.res, 200, await getQuote(symbol));
});

// --- 8e-iii. Market feed status (for live/simulated price labels in the app) ---
route("GET", "/api/v1/market/status", async (ctx) => {
  sendJson(ctx.res, 200, getFeedStatus());
});

// --- 8e-iv. Crypto funding (Circle USDC + USDT on EVM chains, testnet by default — see crypto-funding.ts) ---
// Best-effort: funding routes need Postgres; if it is unavailable the server
// still boots and the funding routes fail closed at query time.
try {
  await migrateFundingDb();
} catch (err) {
  console.warn(`[funding] Postgres migrate skipped: ${err instanceof Error ? err.message : String(err)}`);
}
mountFundingRoutes({ route, sendJson, HttpError });
mountBtcRoutes({ route, sendJson, HttpError });
mountStripeRoutes({ route, sendJson, HttpError });

// --- 8d-ii. Social connections + launch announcements (see social-auth.ts, social-announce.ts) ---
// These modules were written against a fetch-style interface (handler returns
// a Response, sendJson(data, status) builds one). Adapt to this server's
// Node-style interface (handler writes via ctx.res, sendJson(res, status, body)).
{
  const adaptSendJson = (data: unknown, status = 200): Response => {
    // Build a real Response object; the route adapter below will forward it.
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const adaptRoute = (
    method: string,
    path: string,
    handler: (ctx: { req: Request; url: URL; params: Record<string, string>; body: unknown }) => Promise<unknown>
  ): void => {
    route(method, path, async (ctx: RouteContext) => {
      const url = new URL(ctx.req.url || "/", "http://localhost");
      const result: any = await handler({ req: ctx.req as any, url, params: ctx.params, body: ctx.body });
      if (result instanceof Response) {
        const text = await result.text();
        ctx.res.writeHead(result.status, {
          "Content-Type": result.headers.get("content-type") || "application/json",
        });
        ctx.res.end(text);
      } else if (result !== undefined) {
        sendJson(ctx.res, 200, result);
      }
    });
  };
  // The server's error middleware checks `err instanceof HttpError` and reads
  // `err.statusCode`; extending the real HttpError keeps both working.
  const HttpErrorAdapter = class extends HttpError {
    constructor(status: number, code: string, message: string) {
      super(status, code, message);
    }
  };
  mountSocialRoutes({ route: adaptRoute, sendJson: adaptSendJson, HttpError: HttpErrorAdapter as any });
  mountAnnounceRoutes({ route: adaptRoute, sendJson: adaptSendJson, HttpError: HttpErrorAdapter as any });
}

// --- 8e-v. Coin issuance (Solana devnet; see issuance.ts) ---
// Same best-effort pattern: issuance falls back to an in-memory store when
// Postgres is unavailable, so the server still boots.
mountIssuanceRoutes({ route, sendJson, HttpError });

// --- 8e-v(a). Real account auth (see auth.ts) ---
// Email+password accounts with server-side sessions, on top of the existing
// issuance_users table. Mounted right after issuance so /auth/* is live
// alongside the issuance flow that depends on it.
mountAuthRoutes({ route, sendJson, HttpError });

// --- 8e-vi. Sovereign ledger (Phase 1 MVP; see sovereign-ledger.ts) ---
// Per-user sovereign chains with Ed25519-signed transactions. Write-through
// Postgres persistence (migration 008) + boot restore; legal review pending.
mountSovereignLedgerRoutes({ route, sendJson, HttpError });

// --- 8e-vii. Marketplace settlement (see marketplace.ts) ---
// Two-legged trade settlement for sovereign coins: buyer's USD cash ledger
// -> issuer's USD cash ledger, plus public float -> buyer on the coin's own
// sovereign chain. Durable settlement attempts with boot reconciliation.
// Test rails only (topup is a test-mode faucet).
mountMarketplaceRoutes({ route, sendJson, HttpError });

// --- 8e-viia. Legal documents (see legal-docs.ts) ---
// The completed Phase Coin Minting Agreement (base PDF) plus per-signature
// auto-populated copies (Article 20 block filled from the signature record).
mountLegalDocsRoutes({ route });

// --- 8e-viii. Boot reconciliation for interrupted settlements ---
// Runs after mounts; the ledger restore is awaited inside.
import("./marketplace.js").then((m) => {
  if (typeof m.reconcileSettlements === "function") {
    m.reconcileSettlements().catch((e) =>
      console.error("[boot] settlement reconciliation failed:", e));
  }
}).catch((e) => console.error("[boot] marketplace import failed:", e));

// --- 8f. Ledger introspection (debug/demo aid — see the simulated chain) ---
route("GET", "/api/v1/ledger/blocks", async (ctx) => {
  const limitParam = ctx.query.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam), 500) : 50;
  const recent = blockchainState.slice(-limit);
  sendJson(ctx.res, 200, { totalBlocks: blockchainState.length, blocks: recent });
});

// --- 8g. Health check ---
route("GET", "/healthz", async (ctx) => {
  sendJson(ctx.res, 200, {
    status: "ok",
    uptimeSeconds: process.uptime(),
    blocks: blockchainState.length,
    profiles: profiles.size,
    listedAssets: marketplaceDirectory.size,
  });
});

// ============================================================================
// 9. SERVER BOOTSTRAP
// ============================================================================

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fullUrl = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // Global CORS: the Phase Android app (Capacitor WebView) calls this API
  // cross-origin. Without these headers every fetch from the device fails
  // with "Failed to fetch". setHeader merges with later writeHead calls.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature, Idempotency-Key");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Preflight short-circuit — no route needed.
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(fullUrl.pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    const rawBody = method === "GET" || method === "DELETE" ? undefined : await readRawBody(req);

    let body: unknown;
    if (rawBody !== undefined && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new HttpError(400, "invalid_json_body", "Request body is not valid JSON");
      }
    }

    await r.handler({ req, res, params, query: fullUrl.searchParams, body, rawBody });
    return;
  }

  throw new HttpError(404, "not_found", `No route for ${method} ${fullUrl.pathname}`);
}

const server = createServer((req, res) => {
  dispatch(req, res).catch((err) => {
    if (err instanceof HttpError) {
      sendJson(res, err.statusCode, { error: err.code, message: err.message });
    } else {
      console.error("[unhandled error]", err);
      sendJson(res, 500, { error: "internal_server_error", message: "Unexpected server error" });
    }
  });
});

const PORT = Number(process.env.PORT ?? 4100);

async function main(): Promise<void> {
  startPriceDaemon();

  server.listen(PORT, () => {
    console.log(`Phase Protocol backend listening on http://localhost:${PORT}`);
    console.log(`Price-flash daemon ticking every ${PRICE_TICK_INTERVAL_MS}ms`);
  });
}

main().catch((err) => {
  console.error("[phase-backend] fatal startup error:", err);
  process.exit(1);
});

// Graceful shutdown for local dev (Ctrl+C)
process.on("SIGINT", () => {
  stopPriceDaemon();
  server.close(() => process.exit(0));
});
