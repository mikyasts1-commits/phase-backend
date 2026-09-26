/**
 * test-securities.ts — full sandbox round trip for the tokenized-securities
 * integration layer. Testnet/sandbox only; no real money.
 *
 * Covers: schema migrate + catalog seed, instrument search, quotes, market
 * buy (idempotent), positions, ledger rows, sell, limit order cancel,
 * dividend crediting, input validation, Dinari stub gating, and the HTTP
 * route layer via a fake deps object.
 *
 * Run with: npx tsx test-securities.ts
 */
import { readFileSync } from "node:fs";
import type { RouteContextLike } from "./securities.js";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
process.env.SECURITIES_PROVIDER = "sandbox";

const db = await import("./db.js");
const sec = await import("./securities.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const expectErr = async (name: string, fn: () => Promise<unknown>, code: string) => {
  try {
    await fn();
    check(name, false, "no error thrown");
  } catch (e: unknown) {
    const c = (e as { code?: string })?.code;
    check(name, c === code, `got code=${c}, want ${code}`);
  }
};

const USER = "sec-test-user-1";

try {
  // --- 1. migrate + seed ---
  const seeded = await sec.ensureSecuritiesSchema();
  check("catalog seeded with 20 instruments", seeded.instruments === 20, `got ${seeded.instruments}`);
  // idempotent re-run
  const seeded2 = await sec.ensureSecuritiesSchema();
  check("ensureSecuritiesSchema idempotent", seeded2.instruments === 20, `got ${seeded2.instruments}`);

  // --- 1b. reset test-user state so the suite is re-runnable ---
  const pool = db.getPool();
  await pool.query(`DELETE FROM securities_ledger WHERE user_id = $1`, [USER]);
  await pool.query(`DELETE FROM securities_orders WHERE user_id = $1`, [USER]);
  await pool.query(`DELETE FROM securities_positions WHERE user_id = $1`, [USER]);
  check("test-user state reset", true);

  // --- 2. search ---
  const all = await sec.searchInstruments();
  check("searchInstruments returns 20", all.length === 20, `got ${all.length}`);
  const apple = await sec.searchInstruments({ search: "apple" });
  check("search 'apple' finds AAPL.D", apple.length === 1 && apple[0].id === "AAPL.D", JSON.stringify(apple.map((a: { id: string }) => a.id)));
  const treas = await sec.searchInstruments({ kind: "treasury" });
  check("kind=treasury finds TBILL.D", treas.length === 1 && treas[0].id === "TBILL.D");
  const bySymbol = await sec.searchInstruments({ symbol: "spy" });
  check("symbol lookup case-insensitive", bySymbol.length === 1 && bySymbol[0].id === "SPY.D");

  // --- 3. quote ---
  const q = await sec.getQuote("AAPL.D");
  check("quote bid<ask, both positive", q.bid > 0 && q.bid < q.ask, `bid=${q.bid} ask=${q.ask}`);
  await expectErr("quote unknown instrument 404", () => sec.getQuote("NOPE.D"), "unknown_instrument");

  // --- 4. market buy 10 AAPL.D, idempotent ---
  const K1 = "idem-buy-1";
  const r1 = await sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 10, orderType: "market", idempotencyKey: K1 });
  check("buy order created+filled", r1.created && r1.order.status === "filled" && r1.order.filledQty === 10, r1.order.status);
  const r1b = await sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 10, orderType: "market", idempotencyKey: K1 });
  check("idempotent replay returns same order", !r1b.created && r1b.order.id === r1.order.id, r1b.order.id);

  // --- 5. positions + ledger ---
  const positions = await sec.getPositions(USER);
  const aapl = positions.find((p: { instrumentId: string }) => p.instrumentId === "AAPL.D");
  check("position AAPL.D qty=10", !!aapl && aapl.qty === 10, JSON.stringify(aapl));
  check("position has avgCost>0", !!aapl && aapl.avgCost > 0, String(aapl?.avgCost));
  const txns = await sec.getTransactions(USER);
  const fill = txns.find((t: { kind: string }) => t.kind === "fill");
  check("fill ledger row exists", !!fill);
  check("buy fill debits USDC (negative)", !!fill && fill.amountUsdc < 0, String(fill?.amountUsdc));
  check("buy fill qty signed +10", !!fill && fill.qty === 10, String(fill?.qty));

  // --- 6. sell 4 ---
  const s1 = await sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "sell", qty: 4, orderType: "market", idempotencyKey: "idem-sell-1" });
  check("sell order filled", s1.order.status === "filled" && s1.order.filledQty === 4);
  const pos2 = (await sec.getPositions(USER)).find((p: { instrumentId: string }) => p.instrumentId === "AAPL.D");
  check("position reduced to 6", !!pos2 && pos2.qty === 6, String(pos2?.qty));
  const txns2 = await sec.getTransactions(USER);
  const sellFill = txns2.find((t: { kind: string; qty: number }) => t.kind === "fill" && t.qty === -4);
  check("sell fill credits USDC (positive)", !!sellFill && sellFill.amountUsdc > 0, String(sellFill?.amountUsdc));

  // --- 7. limit order: open, then cancel ---
  const qNow = await sec.getQuote("AAPL.D");
  const lim = await sec.placeOrder({
    userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 2,
    orderType: "limit", limitPrice: qNow.mid * 0.6, idempotencyKey: "idem-limit-1",
  });
  check("far limit buy stays open", lim.order.status === "open", lim.order.status);
  const cancelled = await sec.cancelOrder(USER, lim.order.id);
  check("cancel open limit order", cancelled.status === "cancelled", cancelled.status);
  await expectErr("re-cancel rejected (409)", () => sec.cancelOrder(USER, lim.order.id), "order_not_cancellable");

  // --- 8. dividend stub ---
  const provider = sec.getProvider() as unknown as {
    triggerDividend: (id: string, amt: number) => unknown;
  };
  provider.triggerDividend("AAPL.D", 0.25);
  const divRows = await sec.applyDividend(USER, "AAPL.D");
  check("dividend credited to holder", divRows.length === 1 && divRows[0].kind === "dividend");
  check("dividend amount = 6 * 0.25", divRows.length === 1 && Math.abs(divRows[0].amountUsdc - 1.5) < 1e-9, String(divRows[0]?.amountUsdc));

  // --- 9. input validation ---
  await expectErr("qty=0 rejected", () => sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 0, orderType: "market", idempotencyKey: "bad-1" }), "bad_qty");
  await expectErr("unknown instrument rejected", () => sec.placeOrder({ userId: USER, instrumentId: "ZZZ.D", side: "buy", qty: 1, orderType: "market", idempotencyKey: "bad-2" }), "unknown_instrument");
  await expectErr("oversell rejected", () => sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "sell", qty: 100, orderType: "market", idempotencyKey: "bad-3" }), "insufficient_position");
  await expectErr("limit without price rejected", () => sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 1, orderType: "limit", idempotencyKey: "bad-4" }), "bad_limit_price");
  await expectErr("insane limit price rejected", () => sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 1, orderType: "limit", limitPrice: 0.01, idempotencyKey: "bad-5" }), "limit_price_out_of_range");
  await expectErr("missing idempotency key rejected", () => sec.placeOrder({ userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 1, orderType: "market", idempotencyKey: "" }), "missing_idempotency_key");

  // --- 10. Dinari stub gating ---
  const dinari = new sec.DinariProvider();
  await expectErr("dinari without key → not_configured", () => dinari.listInstruments(), "not_configured");

  // --- 11. route layer (fake deps) ---
  const handlers = new Map<string, (ctx: RouteContextLike) => void | Promise<void>>();
  let last: { status: number; body: Record<string, unknown> } | null = null;
  class FakeHttpError extends Error {
    statusCode: number; code: string;
    constructor(s: number, c: string, m: string) { super(m); this.statusCode = s; this.code = c; }
  }
  sec.mountSecuritiesRoutes({
    route: (m: string, p: string, h: (ctx: RouteContextLike) => void | Promise<void>) => { handlers.set(`${m} ${p}`, h); },
    sendJson: (_res: unknown, s: number, b: unknown) => { last = { status: s, body: b as Record<string, unknown> }; },
    HttpError: FakeHttpError as unknown as new (s: number, c: string, m: string) => Error,
  });
  const call = async (key: string, ctx: Partial<RouteContextLike>) => {
    last = null;
    await handlers.get(key)!({ res: {}, params: {}, query: new URLSearchParams(), body: undefined, ...ctx });
    return last!;
  };
  const ri = await call("GET /api/v1/securities/instruments", { query: new URLSearchParams("kind=etf") });
  check("GET /instruments?kind=etf → 200, 3 etfs", ri.status === 200 && (ri.body.count as number) === 3, `status=${ri.status} count=${ri.body.count}`);
  const rq = await call("GET /api/v1/securities/quote/:id", { params: { id: "NVDA.D" } });
  check("GET /quote/:id → 200 with bid/ask", rq.status === 200 && (rq.body.quote as { bid: number }).bid > 0, `status=${rq.status}`);
  const rqBad = await call("GET /api/v1/securities/quote/:id", { params: { id: "NOPE.D" } });
  check("GET /quote/:id unknown → 404", rqBad.status === 404, `status=${rqBad.status}`);
  const roBad = await call("POST /api/v1/securities/orders", { body: { userId: USER, instrumentId: "AAPL.D", side: "buy", qty: 0, orderType: "market", idempotencyKey: "route-bad-1" } });
  check("POST /orders qty=0 → 400", roBad.status === 400 && roBad.body.error === "bad_qty", `status=${roBad.status} error=${roBad.body.error}`);
  const roNoUser = await call("POST /api/v1/securities/orders", { body: { instrumentId: "AAPL.D", side: "buy", qty: 1, orderType: "market", idempotencyKey: "route-bad-2" } });
  check("POST /orders missing userId → 400", roNoUser.status === 400, `status=${roNoUser.status}`);
  const rp = await call("GET /api/v1/securities/positions", { query: new URLSearchParams(`userId=${USER}`) });
  check("GET /positions → 200 with AAPL.D", rp.status === 200 && ((rp.body.positions as { instrumentId: string }[]).some((p) => p.instrumentId === "AAPL.D")), `status=${rp.status}`);
} finally {
  await db.closeDb();
}

console.log(`\nsecurities test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
