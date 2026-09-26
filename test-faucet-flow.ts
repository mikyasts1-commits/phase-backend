/**
 * Full funding-flow test (TESTNET, fake funds):
 *  1. Create wallets for a faucet-test user, print the Base Sepolia address.
 *  2. Poll Circle for USDC balance until the faucet drip arrives.
 *  3. Sweep the USDC to the Phase treasury via the module's sweepToTreasury.
 *  4. Poll the transfer until Circle marks it confirmed/failed.
 * Never prints secrets. Run with: npx tsx test-faucet-flow.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { migrate, closeDb } = await import("./db.js");
await migrate();
const API_KEY = process.env.CIRCLE_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function circleGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.circle.com${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json()) as { data?: T };
  if (!res.ok) throw new Error(`Circle ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.data as T;
}

async function usdcBalance(walletId: string): Promise<number> {
  const bal = await circleGet<{ tokenBalances?: Array<{ symbol?: string; amount?: string }> }>(
    `/v1/w3s/wallets/${walletId}/balances`
  );
  const list = bal?.tokenBalances ?? [];
  const usdc = list.find((b) => (b.symbol ?? "").toUpperCase() === "USDC");
  return Number(usdc?.amount ?? 0);
}

const mod = await import("./crypto-funding.js");
console.log("network:", mod.fundingNetwork());

const USER = "faucet-test-1";
const { record, created } = await mod.getOrCreateUserWallets(USER);
console.log("wallets created:", created, "set:", record.walletSetId);
const base = record.wallets.find((w: { blockchain: string }) => w.blockchain === "BASE-SEPOLIA")!;
console.log("BASE_SEPOLIA_ADDRESS=" + base.address);
console.log("BASE_WALLET_ID=" + base.walletId);
writeFileSync(
  new URL("./faucet-test-wallet.json", import.meta.url),
  JSON.stringify({ userId: USER, base, at: new Date().toISOString() }, null, 2)
);

console.log("Waiting for faucet USDC drip (polling every 20s, up to 15 min)...");
let balance = 0;
const t0 = Date.now();
while (Date.now() - t0 < 15 * 60_000) {
  try {
    balance = await usdcBalance(base.walletId);
  } catch (e) {
    console.log("balance poll error:", e instanceof Error ? e.message : String(e));
  }
  console.log(`  balance: ${balance} USDC (${Math.round((Date.now() - t0) / 1000)}s elapsed)`);
  if (balance > 0) break;
  await sleep(20_000);
}
if (balance <= 0) {
  console.log("FAUCET WAIT TIMED OUT — no USDC arrived.");
  process.exit(3);
}

const amount = String(balance);
console.log(`Sweeping ${amount} USDC to treasury...`);
const { entry } = await mod.sweepToTreasury({ userId: USER, amount, chain: "BASE-SEPOLIA" });
console.log("ledger:", entry.id, "status:", entry.status, "circleTransferId:", entry.circleTransferId, "note:", entry.note);

console.log("Polling transfer status (every 20s, up to 10 min)...");
const t1 = Date.now();
let cur = entry;
while (Date.now() - t1 < 10 * 60_000) {
  const updated = await mod.refreshTransferFromCircle(entry.id);
  if (updated) cur = updated;
  console.log(`  status: ${cur.status} txHash: ${cur.txHash ?? "-"} note: ${cur.note ?? "-"}`);
  if (cur.status === "confirmed" || cur.status === "failed") break;
  await sleep(20_000);
}
console.log(cur.status === "confirmed" ? "FAUCET FLOW OK — deposit swept and confirmed." : `FLOW ENDED WITH STATUS: ${cur.status}`);
await closeDb();
