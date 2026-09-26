/**
 * Hermetic unit tests for the crypto-only funding rail (USDC + USDT).
 * No Postgres, no Circle network calls: exercises currency resolution,
 * token registry/symbol resolution, and decimal addition.
 * Run with: npx tsx test-funding-units.ts
 */
const mod = await import("./crypto-funding.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// --- 1. currenciesForChain: EVM chains support USDC+USDT, Solana USDC-only ---
check("BASE-SEPOLIA supports USDC+USDT",
  JSON.stringify(mod.currenciesForChain("BASE-SEPOLIA")) === JSON.stringify(["USDC", "USDT"]));
check("MATIC-AMOY supports USDC+USDT",
  JSON.stringify(mod.currenciesForChain("MATIC-AMOY")) === JSON.stringify(["USDC", "USDT"]));
check("SOL-DEVNET is USDC-only",
  JSON.stringify(mod.currenciesForChain("SOL-DEVNET")) === JSON.stringify(["USDC"]));
check("mainnet BASE supports USDC+USDT",
  JSON.stringify(mod.currenciesForChain("BASE")) === JSON.stringify(["USDC", "USDT"]));

// --- 2. resolveCurrency: validation per chain ---
check("usdt resolves on BASE-SEPOLIA", mod.resolveCurrency("usdt", "BASE-SEPOLIA") === "USDT");
check("defaults to USDC", mod.resolveCurrency(undefined, "MATIC-AMOY") === "USDC");
check("case-insensitive", mod.resolveCurrency("Usdc", "SOL-DEVNET") === "USDC");
try {
  mod.resolveCurrency("USDT", "SOL-DEVNET");
  check("USDT rejected on Solana", false, "no error thrown");
} catch (e: unknown) {
  check("USDT rejected on Solana", (e as { code?: string }).code === "unsupported_currency");
}
try {
  mod.resolveCurrency("BTC", "BASE-SEPOLIA");
  check("BTC rejected everywhere", false, "no error thrown");
} catch (e: unknown) {
  check("BTC rejected everywhere", (e as { code?: string }).code === "unsupported_currency");
}

// --- 3. Token registry + symbol resolution (no network: seeded cache hits) ---
mod.registerTokenContract("tok-unit-usdt", "BASE-SEPOLIA", "usdt"); // lowercase on purpose
const sym = await mod.resolveTokenSymbol("tok-unit-usdt", "BASE-SEPOLIA");
check("registered USDT token resolves", sym === "USDT", String(sym));
const miss = await mod.resolveTokenSymbol("tok-unit-unknown", "BASE-SEPOLIA");
check("unregistered token resolves null (cache-only, no network)", miss === null, String(miss));

// --- 4. addDecimalStrings: exact 6dp arithmetic ---
check("0.1 + 0.2 = 0.3", mod.addDecimalStrings("0.1", "0.2") === "0.3",
  mod.addDecimalStrings("0.1", "0.2"));
check("1.50 + 2.5 = 4", mod.addDecimalStrings("1.50", "2.5") === "4");
check("micro amounts", mod.addDecimalStrings("0.000001", "0.000001") === "0.000002");
check("zero identity", mod.addDecimalStrings("0", "35.5") === "35.5");
check("large amounts", mod.addDecimalStrings("999999.999999", "0.000001") === "1000000");

// --- 5. fundingNetwork defaults to testnet (mainnet flags unset) ---
check("default network is testnet", mod.fundingNetwork() === "testnet");

console.log(`\nfunding unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
