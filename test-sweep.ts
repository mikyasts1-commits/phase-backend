/**
 * Sweep test (TESTNET, fake funds): sweeps the faucet-funded USDC from the
 * saved test wallet to the Phase treasury and polls until Circle confirms.
 * Never prints secrets. Run with: npx tsx test-sweep.ts
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { migrate, closeDb } = await import("./db.js");
await migrate();
const API_KEY = process.env.CIRCLE_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function usdcBalance(walletId: string): Promise<number> {
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as {
    data?: { tokenBalances?: Array<{ amount?: string; token?: { symbol?: string }; symbol?: string }> };
  };
  const list = j.data?.tokenBalances ?? [];
  const usdc = list.find((b) => ((b.token?.symbol ?? b.symbol) ?? "").toUpperCase() === "USDC");
  return Number(usdc?.amount ?? 0);
}

const mod = await import("./crypto-funding.js");
console.log("network:", mod.fundingNetwork());

const saved = JSON.parse(readFileSync(new URL("./faucet-test-wallet.json", import.meta.url), "utf8")) as {
  userId: string;
  base: { walletId: string; address: string };
  at: string;
};
await mod.seedUserWalletRecord({
  userId: saved.userId,
  walletSetId: process.env.CIRCLE_WALLET_SET_ID!,
  wallets: [
    { walletId: saved.base.walletId, address: saved.base.address, blockchain: "BASE-SEPOLIA", state: "LIVE" },
  ],
  createdAt: saved.at,
});

const balance = await usdcBalance(saved.base.walletId);
console.log(`USDC balance: ${balance}`);
if (balance <= 0) {
  console.log("No USDC to sweep — faucet drip has not arrived yet.");
  process.exit(3);
}

console.log(`Sweeping ${balance} USDC to treasury...`);
const { entry } = await mod.sweepToTreasury({
  userId: saved.userId,
  amount: String(balance),
  chain: "BASE-SEPOLIA",
});
console.log(
  "ledger:",
  entry.id,
  "| status:",
  entry.status,
  "| circleTransferId:",
  entry.circleTransferId ?? "-",
  "| note:",
  entry.note ?? "-"
);

console.log("Polling transfer status (every 20s, up to 10 min)...");
const t0 = Date.now();
let cur = entry;
while (Date.now() - t0 < 10 * 60_000) {
  const updated = await mod.refreshTransferFromCircle(entry.id);
  if (updated) cur = updated;
  console.log(`  status: ${cur.status} | txHash: ${cur.txHash ?? "-"} | note: ${cur.note ?? "-"}`);
  if (cur.status === "confirmed" || cur.status === "failed") break;
  await sleep(20_000);
}
console.log(
  cur.status === "confirmed"
    ? "SWEEP OK — faucet USDC swept to treasury and confirmed on Base Sepolia."
    : `SWEEP ENDED WITH STATUS: ${cur.status}`
);
await closeDb();
