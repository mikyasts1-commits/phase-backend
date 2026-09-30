/**
 * test-offers.ts — hermetic coverage for the consent-based swap offer flow.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-offers.ts
 *
 * Fully hermetic (no DATABASE_URL): exercises the real offer routes for
 *   POST /api/v1/offers, GET inbox/outbox, POST accept/counter/decline,
 * including the inverted swap-quote (requestUnits -> required offerUnits).
 *
 * Covers: offer creation, fee preview, inbox visibility, seller counter,
 * buyer acceptance of a counter (settles via the shared engine), direct
 * seller acceptance, decline, self_trade, offer_not_yours,
 * insufficient_offer_balance, double-accept conflict, idempotent create.
 */
import * as crypto from "node:crypto";
import {
  createChain,
  b58encode,
  getChainBalance,
  PUBLIC_FLOAT_ADDRESS,
  startSequencerLoop,
} from "./sovereign-ledger-core.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountOffersRoutes } from "./offers.js";
import { mountAuthRoutes } from "./auth.js";
import { getIssuanceStore } from "./issuance.js";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run: unset DATABASE_URL so the test stays hermetic (in-memory).");
  process.exit(2);
}

// Settlement needs a treasury address; a throwaway valid ph1 (set after helpers).
process.env.PHASE_TREASURY_SOVEREIGN_ADDRESS = "ph1" + b58encode(crypto.randomBytes(32));

let passed = 0;
let failed = 0;
function ok(name: string, cond: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

function ph1(): string {
  return "ph1" + b58encode(crypto.randomBytes(32));
}

// --- fake HTTP plumbing ----------------------------------------------------
const handlers = new Map<string, (ctx: any) => Promise<void> | void>();
class HttpError extends Error {
  statusCode: number; code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message); this.statusCode = statusCode; this.code = code;
  }
}
const deps = {
  route: (m: string, p: string, h: any) => { handlers.set(`${m} ${p}`, h); },
  sendJson: (res: any, status: number, body: unknown) => { res.status = status; res.body = body; },
  HttpError: HttpError as any,
};
import { mountIssuanceRoutes } from "./issuance.js";
mountAuthRoutes(deps);
mountIssuanceRoutes(deps);
mountMarketplaceRoutes(deps);
mountOffersRoutes(deps);

async function call(method: string, path: string, body: any, headers: Record<string, string> = {}, params: Record<string, string> = {}, query = "") {
  const res: any = {};
  // match ":id" style routes
  let h = handlers.get(`${method} ${path}`);
  if (!h) {
    for (const [k, v] of handlers) {
      const [km, kp] = k.split(" ", 2);
      if (km !== method) continue;
      const kre = "^" + kp.replace(/:[^/]+/g, "([^/]+)") + "$";
      const m = path.match(new RegExp(kre));
      if (m) {
        const names = [...kp.matchAll(/:([^/]+)/g)].map((x) => x[1]);
        names.forEach((n, i) => { params[n] = m[i + 1]; });
        h = v;
        break;
      }
    }
  }
  if (!h) throw new Error(`no handler for ${method} ${path}`);
  await h({ req: { headers }, res, params, query: new URLSearchParams(query), body });
  return res;
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function main() {
  console.log("offer tests (in-memory)");
  const sequencer = startSequencerLoop();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- users ----------------------------------------------------------------
  const mkUser = async (name: string, email: string) => {
    const r = await call("POST", "/api/v1/auth/signup",
      { name, email, password: "test-password-123" });
    ok(`signup ${name} 201`, r.status === 201 && r.body.token);
    return { userId: r.body.userId as string, token: r.body.token as string };
  };
  const buyer = await mkUser("Buyer", "buyer@example.com");
  const seller = await mkUser("Seller", "seller@example.com");
  const buyerAddr = ph1();
  const sellerAddr = ph1();

  // --- chains ---------------------------------------------------------------
  // Buyer issued ALP (50% retained -> buyer holds 50000 at buyerAddr).
  const offerChain = await createChain({
    coin_name: "Alpha Coin", ticker: "ALP2", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: buyerAddr, is_meme: true,
  });
  const offerChainId: string = offerChain.chain_id;
  ok("buyer holds 50000 ALP2", getChainBalance(offerChainId, buyerAddr) === "50000");
  // Seller issued BET (50% public float).
  const targetChain = await createChain({
    coin_name: "Beta Coin", ticker: "BET2", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: sellerAddr, is_meme: true,
  });
  const targetChainId: string = targetChain.chain_id;
  ok("BET2 float funded 50000", getChainBalance(targetChainId, PUBLIC_FLOAT_ADDRESS) === "50000");

  const issuance = await getIssuanceStore();
  await issuance.storeCoin({
    draftId: "draft-alp2", userId: buyer.userId, signatureId: "sig-alp2",
    isMeme: true, name: "Alpha Coin", ticker: "ALP2", mintAddress: offerChainId,
    txSignature: offerChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 10, issuerAddress: buyerAddr, idempotencyKey: "coin-alp-2",
    category: null, totalShares: 100000, retainedShares: 50000, websiteUrl: null,
  });
  await issuance.storeCoin({
    draftId: "draft-bet2", userId: seller.userId, signatureId: "sig-bet2",
    isMeme: true, name: "Beta Coin", ticker: "BET2", mintAddress: targetChainId,
    txSignature: targetChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 20, issuerAddress: sellerAddr, idempotencyKey: "coin-bet-2",
    category: null, totalShares: 100000, retainedShares: 50000, websiteUrl: null,
  });

  // --- myCoins enrichment ---------------------------------------------------
  let r = await call("GET", "/api/v1/issuance/coins", {}, auth(buyer.token), {}, `userId=${buyer.userId}`);
  const myCoin = r.body.coins?.[0];
  ok("myCoins 200", r.status === 200);
  ok("myCoins availableUnits = 50000", myCoin?.availableUnits === "50000");
  ok("myCoins realizationRatio = 0 (nothing sold)", myCoin?.realizationRatio === 0);
  ok("myCoins publicFloatUnits = 50000", myCoin?.publicFloatUnits === "50000");

  // --- inverted swap quote ---------------------------------------------------
  // Buyer wants 100 BET2 net. Price ratio 20/10 = 2 ALP per BET.
  r = await call("GET", "/api/v1/trades/swap-quote", {},
    {}, {}, `chainId=${targetChainId}&offerChainId=${offerChainId}&requestUnits=100`);
  ok("quote requestUnits 200", r.status === 200);
  const q = r.body.quote;
  // grossUnitsForNet(100, 80) = 100 (fee floors to 0 at this size); offer = ceil(100 * 20 / 10) = 200.
  ok(`quote gross=100.000000 (got ${q?.grossUnits})`, q?.grossUnits === "100.000000");
  ok(`quote offerUnits=200 (got ${q?.offerUnits})`, q?.offerUnits === "200");
  ok(`quote buyerReceives >= 100 (got ${q?.buyerReceivesUnits})`, Number(q?.buyerReceivesUnits) >= 100);

  // --- create offer ----------------------------------------------------------
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId, offerUnits: "202", requestUnits: "100", buyerAddress: buyerAddr, idempotencyKey: "offer-1" },
    auth(buyer.token));
  ok("create offer 201", r.status === 201);
  const offerId = r.body.offer?.id;
  ok("offer pending", r.body.offer?.status === "pending");
  ok("offer has fee preview", !!r.body.feePreview?.grossUnits);
  ok("offer display tickers", r.body.offer?.targetTicker === "BET2" && r.body.offer?.offerTicker === "ALP2");

  // idempotent replay
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId, offerUnits: "202", requestUnits: "100", buyerAddress: buyerAddr, idempotencyKey: "offer-1" },
    auth(buyer.token));
  ok("idempotent replay same id", r.status === 201 && r.body.offer?.id === offerId);

  // --- inbox / outbox ----------------------------------------------------------
  r = await call("GET", "/api/v1/offers/inbox", {}, auth(seller.token));
  ok("seller inbox has the offer", r.status === 200 && r.body.offers?.length === 1 && r.body.offers[0].id === offerId);
  r = await call("GET", "/api/v1/offers/outbox", {}, auth(buyer.token));
  ok("buyer outbox has the offer", r.status === 200 && r.body.offers?.length === 1);
  r = await call("GET", "/api/v1/offers/inbox", {}, auth(buyer.token));
  ok("buyer inbox empty", r.status === 200 && r.body.offers?.length === 0);

  // --- counter -----------------------------------------------------------------
  // Seller counters: wants 300 ALP2, will give 100 BET2 net.
  r = await call("POST", `/api/v1/offers/${offerId}/counter`,
    { offerUnits: "300", requestUnits: "100" }, auth(seller.token));
  ok("counter 200", r.status === 200 && r.body.offer?.status === "countered");
  ok("counter terms stored", r.body.offer?.counterOfferUnits === "300.000000");

  // Buyer (not seller) must accept the counter.
  r = await call("POST", `/api/v1/offers/${offerId}/accept`, {}, auth(seller.token));
  ok("seller cannot accept own counter 403", r.status === 403);

  // --- accept the counter (settles) ----------------------------------------------
  const betFloatBefore = BigInt(getChainBalance(targetChainId, PUBLIC_FLOAT_ADDRESS));
  r = await call("POST", `/api/v1/offers/${offerId}/accept`, {}, auth(buyer.token));
  ok("accept counter 200", r.status === 200);
  ok("offer accepted", r.body.offer?.status === "accepted");
  ok("trade recorded", !!r.body.trade?.id);
  // 300 ALP2 @ $10 = $3000 -> 150 BET2 gross; fee 1; buyer nets 149 >= 100 requested.
  const net = Number(r.body.trade?.targetUnits ?? r.body.fee?.buyerReceivesUnits ?? 0);
  ok(`buyer received >= 100 BET2 net (got ${r.body.fee?.buyerReceivesUnits})`,
    Number(r.body.fee?.buyerReceivesUnits) >= 100);
  // The float leg is queued to the mempool; the sequencer confirms it into a
  // block (~2s cadence), which is when balances actually move.
  await sleep(2500);
  const grossDec = String(r.body.trade?.units ?? "0").split(".")[0];
  ok("float reduced by gross", BigInt(getChainBalance(targetChainId, PUBLIC_FLOAT_ADDRESS)) === betFloatBefore - BigInt(grossDec));

  // double accept -> 409
  r = await call("POST", `/api/v1/offers/${offerId}/accept`, {}, auth(buyer.token));
  ok("double accept 409", r.status === 409);

  // --- realization moved ---------------------------------------------------------
  r = await call("GET", "/api/v1/issuance/coins", {}, auth(seller.token), {}, `userId=${seller.userId}`);
  const sellerCoin = r.body.coins?.[0];
  ok("realizationRatio > 0 after sale", typeof sellerCoin?.realizationRatio === "number" && sellerCoin.realizationRatio > 0);

  // --- direct accept path ----------------------------------------------------------
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId, offerUnits: "20", requestUnits: "9", buyerAddress: buyerAddr, idempotencyKey: "offer-2" },
    auth(buyer.token));
  const offer2 = r.body.offer?.id;
  ok("second offer created", r.status === 201 && !!offer2);
  r = await call("POST", `/api/v1/offers/${offer2}/accept`, {}, auth(seller.token));
  ok("seller accepts pending offer directly", r.status === 200 && r.body.offer?.status === "accepted");

  // --- decline path ----------------------------------------------------------------
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId, offerUnits: "20", requestUnits: "9", buyerAddress: buyerAddr, idempotencyKey: "offer-3" },
    auth(buyer.token));
  const offer3 = r.body.offer?.id;
  r = await call("POST", `/api/v1/offers/${offer3}/decline`, {}, auth(seller.token));
  ok("seller declines", r.status === 200 && r.body.offer?.status === "declined");
  r = await call("GET", "/api/v1/offers/inbox", {}, auth(seller.token));
  ok("declined offer leaves active inbox", r.body.offers?.every((o: any) => o.id !== offer3));

  // --- validation --------------------------------------------------------------------
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId, offerUnits: "999999999", requestUnits: "1", buyerAddress: buyerAddr, idempotencyKey: "offer-4" },
    auth(buyer.token));
  ok("insufficient_offer_balance 409", r.status === 409);
  r = await call("POST", "/api/v1/offers",
    { targetChainId: offerChainId, offerChainId, offerUnits: "10", requestUnits: "1", buyerAddress: buyerAddr, idempotencyKey: "offer-5" },
    auth(buyer.token));
  ok("self_trade 422", r.status === 422 && r.body.error === "self_trade");
  r = await call("POST", "/api/v1/offers",
    { targetChainId, offerChainId: targetChainId, offerUnits: "10", requestUnits: "1", buyerAddress: buyerAddr, idempotencyKey: "offer-6" },
    auth(buyer.token));
  ok("offer_not_yours 422", r.status === 422 && r.body.error === "offer_not_yours");

  clearInterval(sequencer as any);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
