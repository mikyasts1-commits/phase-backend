/**
 * Live testnet smoke test: provision a Phase user wallet set + per-chain
 * wallets via the crypto-funding module. TESTNET ONLY — fake funds.
 * Reads credentials from ./.env (chmod 600). Never prints secrets.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
  console.error("missing Circle credentials in .env");
  process.exit(1);
}
const { migrate, closeDb } = await import("./db.js");
await migrate();

const { getOrCreateUserWallets, fundingNetwork } = await import("./crypto-funding.js");
console.log("network:", fundingNetwork());

const started = Date.now();
try {
  const { record, created } = await getOrCreateUserWallets("test-mikyas-1");
  console.log("created:", created, `(${(Date.now() - started) / 1000}s)`);
  console.log("walletSetId:", record.walletSetId);
  for (const w of record.wallets) {
    console.log(`- chain=${w.blockchain} walletId=${w.walletId} address=${w.address}`);
  }
  console.log("WALLET TEST OK");
} catch (err) {
  console.error("WALLET TEST FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(2);
}
await closeDb();
