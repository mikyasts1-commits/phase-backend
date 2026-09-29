/**
 * test-fees-integration.ts — DB-backed tests for the 80-bps fee engine
 * (CORRECTED model: fees denominated in the purchased asset).
 *
 * Run:  DATABASE_URL=postgres://... npx tsx test-fees-integration.ts
 *
 * Requires a Postgres database. Applies migrations (incl. 016 fee/treasury
 * tables), then verifies:
 *   1. fee_config seeded at 80 bps, versioned updates, cache invalidation
 *   2. recordFee idempotency (duplicate idempotency key -> one row)
 *   3. settleBuyCashWithFee: buyer debited GROSS usd, seller credited FULL
 *      GROSS usd (no fee deducted from proceeds), fee row pending in the
 *      PURCHASED asset (ticker), fee payer = buyer
 *   4. settleBuyCashWithFee replay: second call returns replayed, no double move
 *   5. insufficient funds: throws, NO fee row, balances unchanged (atomicity)
 *   6. recordBuyFeeSettlement: fee pending -> settled, treasury_balances
 *      credited in the purchased asset
 *   7. compensateBuyCashWithFee: buyer refunded gross, seller proceeds
 *      clawed back, fee marked reversed, second compensation is a no-op
 *   8. runFeeReconciliation invariant holds after settled fees
 *   9. fee rate change: 100 bps applies to new settlements only
 *
 * Uses isolated test user ids; cleans up its own rows at the end.
 */
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.error("Requires DATABASE_URL — refusing to run without Postgres.");
  process.exit(2);
}

const { migrate, getPool, closeDb } = await import("./db.js");
const fee = await import("./fee.js");
const mkt = await import("./marketplace.js");

await migrate();

let passed = 0;
let failed = 0;
function ok(name: string, cond: unknown, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

const pool = getPool();
const q = (t: string, p?: unknown[]) => pool.query(t, p);
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;
const buyer = uid("fee_buyer");
const seller = uid("fee_seller");
const treasury = fee.getTreasuryAccountId();
const TICKER = "TESTPHI";
const createdKeys: string[] = [];

async function bal(userId: string): Promise<string> {
  const r = await q(`SELECT balance::text AS b FROM market_balances WHERE user_id = $1 AND currency = 'USD'`, [userId]);
  return r.rows[0]?.b ?? "0";
}
async function treasuryBal(asset: string): Promise<string> {
  const r = await q(
    `SELECT balance::text AS b FROM treasury_balances WHERE account_id = $1 AND asset_symbol = $2`,
    [treasury, asset]);
  return r.rows[0]?.b ?? "0";
}
async function cleanup() {
  await q(`DELETE FROM fee_ledger WHERE idempotency_key = ANY($1)`, [createdKeys]);
  await q(`DELETE FROM market_balances WHERE user_id IN ($1,$2)`, [buyer, seller]);
  await q(`DELETE FROM treasury_balances WHERE account_id = $1 AND asset_symbol = $2`, [treasury, TICKER]);
}

try {
  console.log("fee config");
  {
    const cfg = await fee.getFeeConfig();
    ok("seeded at 80 bps", cfg.feeBps === 80, `got ${cfg.feeBps}`);
    // Versioned update by an admin actor, then restore.
    const updated = await fee.setFeeConfig(100, "test-admin", "integration test");
    ok("config update to 100 bps", updated.feeBps === 100);
    const reread = await fee.getFeeConfig();
    ok("cache invalidated on update", reread.feeBps === 100 && reread.version === updated.version);
    await fee.setFeeConfig(80, "test-admin", "restore after integration test");
    const restored = await fee.getFeeConfig();
    ok("config restored to 80 bps", restored.feeBps === 80);
    let threw = false;
    try { await fee.setFeeConfig(10001, "test-admin"); } catch { threw = true; }
    ok("rejects bps > 10000", threw);
  }

  console.log("recordFee idempotency (coin-denominated)");
  {
    const key = `test:fee:${randomUUID()}`;
    createdKeys.push(key);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await fee.ensureTreasuryAccount(treasury, client);
      const r1 = await fee.recordFee(client, {
        idempotencyKey: key, transactionId: null, transactionType: "marketplace_buy",
        userId: buyer, assetId: null, assetSymbol: TICKER,
        grossQuantity: "10000.000000", feeBps: 80, feeQuantity: "80.000000",
        netQuantity: "9920.000000", treasuryAccountId: treasury, status: "settled",
      });
      const r2 = await fee.recordFee(client, {
        idempotencyKey: key, transactionId: null, transactionType: "marketplace_buy",
        userId: buyer, assetId: null, assetSymbol: TICKER,
        grossQuantity: "10000.000000", feeBps: 80, feeQuantity: "80.000000",
        netQuantity: "9920.000000", treasuryAccountId: treasury, status: "settled",
      });
      await client.query("COMMIT");
      ok("first insert created", r1.created === true);
      ok("duplicate key not created", r2.created === false);
    } finally { client.release(); }
    const count = await q(`SELECT COUNT(*)::int AS n FROM fee_ledger WHERE idempotency_key = $1`, [key]);
    ok("exactly one fee row", count.rows[0].n === 1);
    const byKey = await fee.getFeeByIdempotencyKey(key);
    ok("getFeeByIdempotencyKey finds it", byKey?.feeQuantity === "80.000000");
    ok("fee payer is the buyer", byKey?.userId === buyer);
  }

  console.log("settleBuyCashWithFee — corrected money leg (buyer pays gross, seller gets full gross)");
  {
    // Canonical example: gross 10,000 PHI @ 80 bps -> 80 PHI fee -> 9,920 PHI buyer.
    // Money leg: buyer pays gross USD (10,000 @ $1), seller receives FULL gross USD.
    const key = fee.feeIdempotencyKey("buy", `testbuy:${randomUUID()}`);
    createdKeys.push(key);
    await q(`INSERT INTO market_balances (user_id, currency, balance) VALUES ($1,'USD',10000)`, [buyer]);

    const r1 = await mkt.settleBuyCashWithFee({
      buyerUserId: buyer, sellerUserId: seller,
      grossUsd: "10000.000000",
      grossUnits: 10000n, feeUnits: 80n, netUnits: 9920n,
      feeBps: 80, feeKey: key, coinId: null, ticker: TICKER,
    });
    ok("first settlement not a replay", r1.replayed === false);
    ok("buyer debited gross USD", (await bal(buyer)) === "0.000000", await bal(buyer));
    ok("seller credited FULL gross USD (no fee deducted)", (await bal(seller)) === "10000.000000", await bal(seller));

    const feeRow = await fee.getFeeByIdempotencyKey(key);
    ok("fee row exists and is pending", feeRow?.status === "pending", feeRow?.status);
    ok("fee denominated in purchased asset", feeRow?.assetSymbol === TICKER, feeRow?.assetSymbol);
    ok("fee payer is the buyer", feeRow?.userId === buyer);
    ok("fee quantities exact", feeRow?.grossQuantity === "10000.000000"
      && feeRow?.feeQuantity === "80.000000" && feeRow?.netQuantity === "9920.000000",
      `${feeRow?.grossQuantity}/${feeRow?.feeQuantity}/${feeRow?.netQuantity}`);
    ok("no treasury USD movement", (await bal(treasury)) === "0");

    const r2 = await mkt.settleBuyCashWithFee({
      buyerUserId: buyer, sellerUserId: seller,
      grossUsd: "10000.000000",
      grossUnits: 10000n, feeUnits: 80n, netUnits: 9920n,
      feeBps: 80, feeKey: key, coinId: null, ticker: TICKER,
    });
    ok("second call is a replay", r2.replayed === true);
    ok("no double debit on replay", (await bal(buyer)) === "0.000000");
    ok("no double credit on replay", (await bal(seller)) === "10000.000000");

    console.log("recordBuyFeeSettlement — fee collection");
    await mkt.recordBuyFeeSettlement({
      feeKey: key, ticker: TICKER, feeUnits: 80n, feeTxId: "tx_test_fee_1",
    });
    const settled = await fee.getFeeByIdempotencyKey(key);
    ok("fee marked settled", settled?.status === "settled", settled?.status ?? "");
    ok("fee tx id recorded", settled?.coinTxId === "tx_test_fee_1", settled?.coinTxId ?? "");
    const tb = await fee.getTreasuryBalances(treasury);
    const phiMirror = tb.find((b) => b.assetSymbol === TICKER);
    ok("treasury_balances credited 80 TESTPHI", phiMirror?.balance === "80.000000", phiMirror?.balance);

    console.log("compensateBuyCashWithFee");
    await mkt.compensateBuyCashWithFee({
      sellerUserId: seller, buyerUserId: buyer,
      grossUsd: "10000.000000",
      feeKey: key, reason: "integration test unwind",
    });
    ok("buyer refunded gross", (await bal(buyer)) === "10000.000000", await bal(buyer));
    ok("seller proceeds clawed back", (await bal(seller)) === "0.000000", await bal(seller));
    ok("treasury balance-sheet fee clawed back", (await treasuryBal(TICKER)) === "0.000000", await treasuryBal(TICKER));
    const reversed = await fee.getFeeByIdempotencyKey(key);
    ok("fee marked reversed", reversed?.status === "reversed");

    // Second compensation is a no-op (never double-unwinds).
    await mkt.compensateBuyCashWithFee({
      sellerUserId: seller, buyerUserId: buyer,
      grossUsd: "10000.000000",
      feeKey: key, reason: "duplicate unwind",
    });
    ok("duplicate compensation no-op", (await bal(buyer)) === "10000.000000");
  }

  console.log("settleBuyCashWithFee — insufficient funds atomicity");
  {
    const poor = uid("fee_poor");
    const key = fee.feeIdempotencyKey("buy", `testpoor:${randomUUID()}`);
    createdKeys.push(key);
    await q(`INSERT INTO market_balances (user_id, currency, balance) VALUES ($1,'USD',5)`, [poor]);
    let threw = false;
    try {
      await mkt.settleBuyCashWithFee({
        buyerUserId: poor, sellerUserId: seller,
        grossUsd: "100.000000",
        grossUnits: 100n, feeUnits: 1n, netUnits: 99n,
        feeBps: 80, feeKey: key, coinId: null, ticker: TICKER,
      });
    } catch (e) {
      threw = (e as { code?: string }).code === "insufficient_funds";
    }
    ok("throws insufficient_funds", threw);
    const feeRow = await fee.getFeeByIdempotencyKey(key);
    ok("no fee row on failed settlement (atomic)", feeRow === null);
    ok("buyer balance untouched", (await bal(poor)) === "5.000000");
    ok("seller balance untouched", (await bal(seller)) === "0.000000");
    await q(`DELETE FROM market_balances WHERE user_id = $1`, [poor]);
  }

  console.log("fee rate change applies to new settlements only");
  {
    await fee.setFeeConfig(200, "test-admin", "integration test 2%");
    const key = fee.feeIdempotencyKey("buy", `testbps:${randomUUID()}`);
    createdKeys.push(key);
    // gross 1000 units @ 200bps -> fee 20 units, net 980 units
    const r = await mkt.settleBuyCashWithFee({
      buyerUserId: buyer, sellerUserId: seller,
      grossUsd: "1000.000000",
      grossUnits: 1000n, feeUnits: 20n, netUnits: 980n,
      feeBps: 200, feeKey: key, coinId: null, ticker: TICKER,
    });
    ok("settles at new rate", r.replayed === false);
    const row = await fee.getFeeByIdempotencyKey(key);
    ok("fee row records the applied rate", row?.feeBps === 200);
    ok("fee row records new-rate quantities",
      row?.feeQuantity === "20.000000" && row?.netQuantity === "980.000000");
    await mkt.recordBuyFeeSettlement({ feeKey: key, ticker: TICKER, feeUnits: 20n, feeTxId: "tx_test_fee_2" });
    ok("treasury got 20 TESTPHI", (await treasuryBal(TICKER)) === "20.000000", await treasuryBal(TICKER));
    await fee.setFeeConfig(80, "test-admin", "restore after integration test");
  }

  console.log("runFeeReconciliation invariant");
  {
    const result = await fee.runFeeReconciliation(30);
    const phi = result.assets.find((a) => a.assetSymbol === TICKER);
    ok("reconciliation ran", result.runId !== null);
    // settled fees (20 TESTPHI; the 80 was reversed) == treasury TESTPHI balance
    ok("TESTPHI invariant holds", phi?.ok === true, JSON.stringify(phi));
    ok("overall invariant ok", result.invariantOk === true);
  }
} finally {
  await cleanup();
  await closeDb();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
