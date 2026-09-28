/**
 * test-swap.ts — committed coverage for the coin-for-coin swap rail.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-swap.ts
 *
 * Fully hermetic (no DATABASE_URL): exercises the real route handlers for
 * POST /api/v1/trades/swap, GET /api/v1/marketplace/coins, the swap
 * settlement state machine, and the boot reconciler.
 *
 * Covers: directory listing, happy-path swap, idempotent replay,
 * offer_not_yours, self_trade, amount_too_small, insufficient_offer_balance,
 * insufficient_float, and reconcile of a stuck swap attempt.
 */
import * as crypto from "node:crypto";
import {
  createChain,
  b58encode,
  getChainBalance,
  PUBLIC_FLOAT_ADDRESS,
  startSequencerLoop,
} from "./sovereign-ledger-core.js";
import { mountMarketplaceRoutes, getMarketStore, reconcileSettlements } from "./marketplace.js";
import { getIssuanceStore } from "./issuance.js";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run: unset DATABASE_URL so the test stays hermetic (in-memory).");
  process.exit(2);
}

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
mountMarketplaceRoutes({
  route: (m: string, p: string, h: any) => { handlers.set(`${m} ${p}`, h); },
  sendJson: (res: any, status: number, body: unknown) => { res.status = status; res.body = body; },
  HttpError: HttpError as any,
});

async function call(method: string, path: string, body: any, headers: Record<string, string> = {}) {
  const res: any = {};
  const h = handlers.get(`${method} ${path}`);
  if (!h) throw new Error(`no handler for ${method} ${path}`);
  await h({ req: { headers }, res, params: {}, query: new URLSearchParams(), body });
  return res;
}
const swap = (body: any, key?: string) =>
  call("POST", "/api/v1/trades/swap", body, key ? { "idempotency-key": key } : {});
const coins = () => call("GET", "/api/v1/marketplace/coins", {});

async function main() {
  console.log("swap tests (in-memory)");

  // The sequencer confirms queued operator/float transfers into blocks so
  // balance assertions reflect settled state. (2s block cadence.)
  const sequencer = startSequencerLoop();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const buyer = "swap-buyer-1";
  const buyerAddr = ph1();
  const seller = "swap-seller-1";
  const sellerAddr = ph1();

  // --- fixtures -------------------------------------------------------------
  // Offer chain: buyer holds the 50% retained allocation at buyerAddr.
  const offerChain = await createChain({
    coin_name: "Alpha Coin", ticker: "ALP1", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: buyerAddr, is_meme: true,
  });
  const offerChainId: string = offerChain.chain_id;
  ok("offer chain created", !!offerChainId);
  ok("buyer holds 50000 ALP", getChainBalance(offerChainId, buyerAddr) === "50000");

  // Target chain: 50% public float, issuer = seller.
  const targetChain = await createChain({
    coin_name: "Beta Coin", ticker: "BET1", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: sellerAddr, is_meme: true,
  });
  const targetChainId: string = targetChain.chain_id;
  ok("target chain created", !!targetChainId);
  ok("target float funded 50000", getChainBalance(targetChainId, PUBLIC_FLOAT_ADDRESS) === "50000");

  // Skinny-float chain for the insufficient_float case (1% public = 1000).
  const gammaChain = await createChain({
    coin_name: "Gamma Coin", ticker: "GAM1", total_supply: "100000",
    decimals: 6, equity_public_pct: 1, issuer_address: sellerAddr, is_meme: true,
  });
  const gammaChainId: string = gammaChain.chain_id;

  const issuance = await getIssuanceStore();
  await issuance.storeCoin({
    draftId: "draft-alp", userId: buyer, signatureId: "sig-alp",
    isMeme: true, name: "Alpha Coin", ticker: "ALP1", mintAddress: offerChainId,
    txSignature: offerChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 10, issuerAddress: buyerAddr, idempotencyKey: "coin-alp-1",
  });
  const targetCoin = await issuance.storeCoin({
    draftId: "draft-bet", userId: seller, signatureId: "sig-bet",
    isMeme: true, name: "Beta Coin", ticker: "BET1", mintAddress: targetChainId,
    txSignature: targetChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 20, issuerAddress: sellerAddr, idempotencyKey: "coin-bet-1",
  });
  await issuance.storeCoin({
    draftId: "draft-gam", userId: seller, signatureId: "sig-gam",
    isMeme: true, name: "Gamma Coin", ticker: "GAM1", mintAddress: gammaChainId,
    txSignature: gammaChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 5, issuerAddress: sellerAddr, idempotencyKey: "coin-gam-1",
  });
  ok("target coin has issuerAddress", targetCoin.issuerAddress === sellerAddr);

  // --- 1. directory ----------------------------------------------------------
  let r = await coins();
  ok("directory 200", r.status === 200 && Array.isArray(r.body.coins));
  ok("directory lists 3 coins", r.body.coins.length === 3);
  const bet = r.body.coins.find((c: any) => c.ticker === "BET1");
  ok("directory BET row", !!bet && bet.chainId === targetChainId
    && bet.priceUsd === 20 && bet.supply === "100000"
    && bet.hasAgreement === true && bet.isMeme === true
    && bet.issuerUserId === seller && bet.issuerAddress === sellerAddr
    && bet.online === true);
  ok("directory floatAvailable", bet.floatAvailable === "50000");
  const gam = r.body.coins.find((c: any) => c.ticker === "GAM1");
  ok("directory GAM floatAvailable", gam.floatAvailable === "1000");
  ok("directory category null for missing draft", bet.category === null);

  // --- 2. happy path: 20 ALP ($200) -> 10 BET --------------------------------
  r = await swap({
    userId: buyer, chainId: targetChainId, buyerAddress: buyerAddr,
    offerChainId, offerUnits: 20,
  }, "swap-happy-1");
  ok("swap 201", r.status === 201);
  ok("trade kind swap", r.body.trade?.kind === "swap");
  ok("target units 10", r.body.trade?.units === "10.000000");
  ok("offer units 20", r.body.trade?.offerUnits === "20.000000");
  ok("trade offer chain", r.body.trade?.offerChainId === offerChainId);
  ok("trade has both tx ids", typeof r.body.offerTxId === "string" && typeof r.body.targetTxId === "string");
  ok("trade offerTxId matches", r.body.trade?.offerTxId === r.body.offerTxId);
  ok("trade amountUsd = offer value", r.body.trade?.amountUsd === "200.000000");

  // Let the sequencer confirm both legs into blocks.
  await sleep(2500);

  ok("buyer got 10 BET", getChainBalance(targetChainId, buyerAddr) === "10");
  ok("seller got 20 ALP", getChainBalance(offerChainId, sellerAddr) === "20");
  ok("buyer ALP reduced", getChainBalance(offerChainId, buyerAddr) === "49980");
  ok("target float reduced", getChainBalance(targetChainId, PUBLIC_FLOAT_ADDRESS) === "49990");

  const ms = await getMarketStore();
  ok("attempt coin_confirmed", (await ms.getAttemptByIdempotency("swap-happy-1"))?.state === "coin_confirmed");

  // --- 3. idempotent replay ----------------------------------------------------
  const betBefore = getChainBalance(targetChainId, buyerAddr);
  r = await swap({
    userId: buyer, chainId: targetChainId, buyerAddress: buyerAddr,
    offerChainId, offerUnits: 20,
  }, "swap-happy-1");
  ok("replay 200 + flag", r.status === 200 && r.body.idempotentReplay === true);
  ok("no double-settle", getChainBalance(targetChainId, buyerAddr) === betBefore);

  // --- 4. offer_not_yours -------------------------------------------------------
  r = await swap({
    userId: "stranger-1", chainId: targetChainId, buyerAddress: ph1(),
    offerChainId, offerUnits: 5,
  }, "swap-stranger-1");
  ok("offer_not_yours 422", r.status === 422 && r.body.error === "offer_not_yours");

  // --- 5. self_trade --------------------------------------------------------------
  r = await swap({
    userId: seller, chainId: targetChainId, buyerAddress: sellerAddr,
    offerChainId: gammaChainId, offerUnits: 5,
  }, "swap-self-1");
  ok("self_trade 422", r.status === 422 && r.body.error === "self_trade");

  // --- 6. amount_too_small: 1 ALP ($10) buys 0 BET ($20) ---------------------------
  r = await swap({
    userId: buyer, chainId: targetChainId, buyerAddress: buyerAddr,
    offerChainId, offerUnits: 1,
  }, "swap-small-1");
  ok("amount too small 422", r.status === 422 && r.body.error === "amount_too_small");

  // --- 7. insufficient_offer_balance --------------------------------------------------
  r = await swap({
    userId: buyer, chainId: targetChainId, buyerAddress: buyerAddr,
    offerChainId, offerUnits: 99999,
  }, "swap-poor-1");
  ok("insufficient offer balance 409", r.status === 409 && r.body.error === "insufficient_offer_balance");

  // --- 8. insufficient_float: 2000 ALP ($20000) -> 4000 GAM, float is 1000 -------------
  r = await swap({
    userId: buyer, chainId: gammaChainId, buyerAddress: buyerAddr,
    offerChainId, offerUnits: 2000,
  }, "swap-thin-1");
  ok("insufficient float 409", r.status === 409 && r.body.error === "insufficient_float");

  // --- 9. directory reflects post-swap float -------------------------------------------
  r = await coins();
  const bet2 = r.body.coins.find((c: any) => c.ticker === "BET1");
  ok("directory floatAvailable after swap", bet2.floatAvailable === "49990");

  // --- 10. reconcile: stuck swap attempt at started --------------------------------------
  const sellerAlpBefore = getChainBalance(offerChainId, sellerAddr);
  const { attempt } = await ms.createAttempt({
    idempotencyKey: "swap-recon-1", kind: "swap",
    chainId: targetChainId, coinId: targetCoin.id,
    buyerUserId: buyer, sellerUserId: seller, buyerAddress: buyerAddr,
    units: "2.000000", priceUsd: "20.000000", amountUsd: "50.000000",
    offerChainId, offerCoinId: "coin-alp-id", offerUnits: "5.000000",
    offerTxId: null, sellerAddress: sellerAddr,
  });
  ok("stuck swap attempt starts at started", attempt.state === "started");
  await reconcileSettlements();
  const ra = await ms.getAttemptByIdempotency("swap-recon-1");
  ok("reconcile moved offer leg", ra?.state === "target_queued" && !!ra?.offerTxId);
  await sleep(2500); // let the sequencer confirm the retried legs
  ok("reconcile offer coins landed",
    getChainBalance(offerChainId, sellerAddr) === String(Number(sellerAlpBefore) + 5));
  ok("reconcile target leg queued", !!ra?.coinTxId);

  clearInterval(sequencer);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
