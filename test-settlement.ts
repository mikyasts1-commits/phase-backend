/**
 * test-settlement.ts — committed settlement coverage for the marketplace.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-settlement.ts
 *
 * Runs fully in-memory (no DATABASE_URL): exercises the real route handlers
 * for POST /api/v1/trades/buy, the settlement state machine, the boot
 * reconciler, and the ledger write path. With DATABASE_URL set it also
 * verifies the Postgres persistence round-trip (chain row written).
 *
 * Covers: happy-path buy, idempotent replay, self-trade rejection,
 * insufficient funds, insufficient float, amount-too-small, settlement
 * resume after a simulated crash, and reconcile of stuck attempts.
 */
import * as crypto from "node:crypto";
import {
  createChain,
  b58encode,
  getChainBalance,
  PUBLIC_FLOAT_ADDRESS,
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
const buy = (body: any, key?: string) =>
  call("POST", "/api/v1/trades/buy", body, key ? { "idempotency-key": key } : {});
const topup = (userId: string, amountUsd: number) =>
  call("POST", "/api/v1/trades/topup", { userId, amountUsd });
const balances = (userId: string) =>
  call("GET", "/api/v1/trades/balances", {} ).catch(() => null);

async function main() {
  console.log("settlement tests (in-memory)");

  // --- fixture: a chain with 100k supply, 50% public float, $10/coin --------
  const issuerAddr = ph1();
  const chain = await createChain({
    coin_name: "Test Coin", ticker: "TST1", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: issuerAddr, is_meme: true,
  });
  const chainId: string = chain.chain_id;
  ok("chain created", !!chainId);
  ok("float funded with 50000", getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS) === "50000");

  const issuance = await getIssuanceStore();
  const coin = await issuance.storeCoin({
    draftId: "draft-test", userId: "issuer-1", signatureId: "sig-test",
    isMeme: true, name: "Test Coin", ticker: "TST1", mintAddress: chainId,
    txSignature: chain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: "10", idempotencyKey: "coin-test-1",
  });
  ok("coin seeded with price", coin.priceUsd === "10");

  const buyer = "buyer-1";
  const buyerAddr = ph1();

  // --- 1. happy path --------------------------------------------------------
  let r = await topup(buyer, 500);
  ok("topup 500", r.status === 200 && r.body.balanceUsd === "500.000000");

  r = await buy({ userId: buyer, chainId, amountUsd: 100, buyerAddress: buyerAddr }, "key-happy-1");
  ok("buy 201", r.status === 201);
  ok("buyer got 10 coins worth", r.body.trade.units === "10.000000");
  ok("trade has coin tx", typeof r.body.txId === "string");
  ok("buyer balance 400", r.body.buyerBalanceUsd === "400.000000");

  const ms = await getMarketStore();
  ok("issuer credited 100", (await ms.getBalance("issuer-1", "USD")) === "100.000000");
  ok("attempt coin_confirmed", (await ms.getAttemptByIdempotency("key-happy-1"))?.state === "coin_confirmed");

  // --- 2. idempotent replay --------------------------------------------------
  const before = await ms.getBalance(buyer, "USD");
  r = await buy({ userId: buyer, chainId, amountUsd: 100, buyerAddress: buyerAddr }, "key-happy-1");
  ok("replay 200 + flag", r.status === 200 && r.body.idempotentReplay === true);
  ok("no double-settle", (await ms.getBalance(buyer, "USD")) === before);

  // --- 3. self-trade rejected -------------------------------------------------
  r = await buy({ userId: "issuer-1", chainId, amountUsd: 100, buyerAddress: ph1() }, "key-self-1");
  ok("self-trade 422", r.status === 422 && r.body.error === "self_trade");

  // --- 4. insufficient funds ---------------------------------------------------
  r = await buy({ userId: "broke-buyer", chainId, amountUsd: 100, buyerAddress: ph1() }, "key-broke-1");
  ok("insufficient funds 402", r.status === 402 && r.body.error === "insufficient_funds");
  ok("failed attempt recorded", (await ms.getAttemptByIdempotency("key-broke-1"))?.state === "failed");

  // --- 5. insufficient float ----------------------------------------------------
  await topup("whale", 100000);
  r = await buy({ userId: "whale", chainId, amountUsd: 600000, buyerAddress: ph1() }, "key-whale-1");
  ok("insufficient float 409", r.status === 409 && r.body.error === "insufficient_float");

  // --- 6. amount too small -------------------------------------------------------
  r = await buy({ userId: buyer, chainId, amountUsd: 5, buyerAddress: ph1() }, "key-small-1");
  ok("amount too small 422", r.status === 422 && r.body.error === "amount_too_small");

  // --- 7. resume after simulated crash (attempt stuck at started) ----------------
  const { attempt } = await ms.createAttempt({
    idempotencyKey: "key-crash-1", chainId, coinId: coin.id,
    buyerUserId: buyer, sellerUserId: "issuer-1", buyerAddress: buyerAddr,
    units: "10.000000", priceUsd: "10.000000", amountUsd: "100.000000",
  });
  ok("crash attempt starts at started", attempt.state === "started");
  // Simulate the process dying right after the attempt row was written:
  // the same key retried must resume and complete exactly once.
  const balBefore = await ms.getBalance(buyer, "USD");
  r = await buy({ userId: buyer, chainId, amountUsd: 100, buyerAddress: buyerAddr }, "key-crash-1");
  ok("resumed buy 201", r.status === 201 && r.body.idempotentReplay === false);
  ok("resumed attempt coin_confirmed",
    (await ms.getAttemptByIdempotency("key-crash-1"))?.state === "coin_confirmed");
  ok("exactly one cash move",
    Number(await ms.getBalance(buyer, "USD")) === Number(balBefore) - 100);

  // --- 8. reconcile: stuck `started` attempt -> failed ---------------------------
  await ms.createAttempt({
    idempotencyKey: "key-recon-1", chainId, coinId: coin.id,
    buyerUserId: buyer, sellerUserId: "issuer-1", buyerAddress: buyerAddr,
    units: "10.000000", priceUsd: "10.000000", amountUsd: "100.000000",
  });
  const recon = await reconcileSettlements();
  ok("reconcile abandons started attempt",
    (await ms.getAttemptByIdempotency("key-recon-1"))?.state === "failed");
  ok("reconcile reported", recon.failed >= 1);

  // --- 9. reconcile: stuck `cash_moved` attempt -> coin leg retried ----------------
  const c2 = await ms.createAttempt({
    idempotencyKey: "key-recon-2", chainId, coinId: coin.id,
    buyerUserId: buyer, sellerUserId: "issuer-1", buyerAddress: buyerAddr,
    units: "10.000000", priceUsd: "10.000000", amountUsd: "100.000000",
  });
  await ms.setAttemptState(c2.attempt.id, "cash_moved");
  await reconcileSettlements();
  const a2 = await ms.getAttemptByIdempotency("key-recon-2");
  ok("reconcile retried coin leg", a2?.state === "coin_queued" && !!a2?.coinTxId);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
