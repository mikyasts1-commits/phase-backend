/**
 * Webhook verification test (no network, no real funds):
 * exercises handleCircleWebhook with HMAC-signed synthetic payloads.
 * Covers: valid signature accept, tamper rejection, missing signature,
 * missing body, dedup (same notificationId twice), inbound deposit
 * creation + confirm transition, and unknown-transfer no-op.
 * Run with: npx tsx test-webhook.ts
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
// Dedicated test secret so the real API key is never the HMAC fallback.
process.env.CIRCLE_WEBHOOK_SECRET = "wh-test-secret-do-not-use-in-prod";

const { migrate, closeDb, dbQuery } = await import("./db.js");
await migrate();

const mod = await import("./crypto-funding.js");

// Seed the token registry so webhook tokenId -> symbol resolution is
// hermetic (no Circle network calls in this suite).
mod.registerTokenContract("tok-usdc-base-sepolia", "BASE-SEPOLIA", "USDC");
mod.registerTokenContract("tok-usdt-base-sepolia", "BASE-SEPOLIA", "USDT");

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
// Hermetic re-runs: dedup + ledger now persist across processes, so clear
// this test's rows before seeding (test-persistence.ts uses unique ids).
await dbQuery("DELETE FROM webhook_dedup WHERE notification_id LIKE 'wh-test-%'");
await dbQuery("DELETE FROM ledger_entries WHERE idempotency_key LIKE 'wh-test-%'");

const sign = (raw: Buffer) =>
  createHmac("sha256", process.env.CIRCLE_WEBHOOK_SECRET!).update(raw).digest("hex");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const basePayload = (over: Record<string, unknown> = {}) => ({
  subscriptionId: "sub-test",
  notificationType: "transactions.inbound",
  timestamp: new Date().toISOString(),
  version: 2,
  ...over,
});

// --- 1. Valid inbound deposit webhook: creates a confirming deposit entry ---
const p1 = basePayload({
  notificationId: "wh-test-1",
  notification: {
    id: "0xdeadbeef01",
    blockchain: "BASE-SEPOLIA",
    walletId: saved.base.walletId,
    tokenId: "tok-usdc-base-sepolia",
    destinationAddress: saved.base.address,
    sourceAddress: "0xfaucet0000000000000000000000000000000001",
    amounts: ["20"],
    state: "PENDING",
    txHash: "0xdeadbeef01",
    confirmations: 0,
  },
});
const raw1 = Buffer.from(JSON.stringify(p1));
const r1 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw1) }, raw1, p1);
check("valid HMAC accepted", r1.verified === true && r1.scheme === "hmac", JSON.stringify(r1));
check("inbound creates confirming deposit", r1.action === "deposit_confirming", r1.action);
{
  const row = await dbQuery<{ currency: string; status: string }>(
    "SELECT currency, status FROM ledger_entries WHERE idempotency_key = 'wh-test-1'"
  );
  check("USDC tokenId resolves to USDC currency", row[0]?.currency === "USDC", JSON.stringify(row[0]));
}

// --- 2. Replay same notificationId: dedup ---
const r2 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw1) }, raw1, p1);
check("duplicate notificationId ignored", r2.action === "duplicate_ignored", r2.action);

// --- 3. Same tx, new notificationId, COMPLETE: transitions existing entry ---
const p3 = basePayload({
  notificationId: "wh-test-2",
  notification: {
    id: "0xdeadbeef01",
    blockchain: "BASE-SEPOLIA",
    walletId: saved.base.walletId,
    tokenId: "tok-usdc-base-sepolia",
    destinationAddress: saved.base.address,
    sourceAddress: "0xfaucet0000000000000000000000000000000001",
    amounts: ["20"],
    state: "COMPLETE",
    txHash: "0xdeadbeef01",
    confirmations: 12,
  },
});
const raw3 = Buffer.from(JSON.stringify(p3));
const r3 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw3) }, raw3, p3);
check("existing deposit transitions to confirmed", r3.action === "deposit_confirmed", r3.action);

// --- 4. Outbound webhook for unknown transfer: verified but no-op ---
const p4 = basePayload({
  notificationId: "wh-test-3",
  notificationType: "transactions.outbound",
  notification: { id: "no-such-transfer", state: "COMPLETE", txHash: "0x9999" },
});
const raw4 = Buffer.from(JSON.stringify(p4));
const r4 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw4) }, raw4, p4);
check(
  "unknown transfer verified but no ledger match",
  r4.verified === true && r4.action === "no_matching_ledger_entry",
  r4.action
);

// --- 5. Tampered body with original signature: rejected ---
const tampered = Buffer.from(JSON.stringify(p1).replace('"20"', '"2000000"'));
try {
  await mod.handleCircleWebhook({ "x-circle-signature": sign(raw1) }, tampered, p1);
  check("tampered body rejected", false, "no error thrown");
} catch (e: unknown) {
  const code = (e as { code?: string })?.code;
  check("tampered body rejected", code === "webhook_bad_signature", String(code));
}

// --- 6. Missing signature header: rejected ---
try {
  await mod.handleCircleWebhook({}, raw1, p1);
  check("missing signature rejected", false, "no error thrown");
} catch (e: unknown) {
  check("missing signature rejected", (e as { code?: string })?.code === "webhook_missing_signature");
}

// --- 7. Missing raw body: rejected ---
try {
  await mod.handleCircleWebhook({ "x-circle-signature": sign(raw1) }, undefined, p1);
  check("missing raw body rejected", false, "no error thrown");
} catch (e: unknown) {
  check("missing raw body rejected", (e as { code?: string })?.code === "webhook_no_raw_body");
}

// --- 8. Wrong secret signature: rejected ---
const wrongSig = createHmac("sha256", "wrong-secret").update(raw1).digest("hex");
try {
  await mod.handleCircleWebhook({ "x-circle-signature": wrongSig }, raw1, p1);
  check("wrong-secret signature rejected", false, "no error thrown");
} catch (e: unknown) {
  check("wrong-secret signature rejected", (e as { code?: string })?.code === "webhook_bad_signature");
}

// --- 9. Inbound USDT deposit: resolves to USDT currency ---
const p9 = basePayload({
  notificationId: "wh-test-9",
  notification: {
    id: "0xusdt00000001",
    blockchain: "BASE-SEPOLIA",
    walletId: saved.base.walletId,
    tokenId: "tok-usdt-base-sepolia",
    destinationAddress: saved.base.address,
    sourceAddress: "0xfaucet0000000000000000000000000000000002",
    amounts: ["35.5"],
    state: "COMPLETE",
    txHash: "0xusdt00000001",
    confirmations: 12,
  },
});
const raw9 = Buffer.from(JSON.stringify(p9));
const r9 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw9) }, raw9, p9);
check("USDT inbound confirmed", r9.action === "deposit_confirmed", r9.action);
{
  const row = await dbQuery<{ currency: string; status: string; verified: boolean }>(
    "SELECT currency, status, verified FROM ledger_entries WHERE idempotency_key = 'wh-test-9'"
  );
  check(
    "USDT deposit credited as USDT",
    row[0]?.currency === "USDT" && row[0]?.status === "confirmed" && row[0]?.verified === true,
    JSON.stringify(row[0])
  );
}

// --- 10. Inbound unknown token: recorded as UNKNOWN, held for review ---
const p10 = basePayload({
  notificationId: "wh-test-10",
  notification: {
    id: "0xmystery00001",
    blockchain: "BASE-SEPOLIA",
    walletId: saved.base.walletId,
    tokenId: "tok-mystery-not-registered",
    destinationAddress: saved.base.address,
    sourceAddress: "0xfaucet0000000000000000000000000000000003",
    amounts: ["100"],
    state: "COMPLETE",
    txHash: "0xmystery00001",
    confirmations: 12,
  },
});
const raw10 = Buffer.from(JSON.stringify(p10));
const r10 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw10) }, raw10, p10);
{
  const row = await dbQuery<{ currency: string; status: string }>(
    "SELECT currency, status FROM ledger_entries WHERE idempotency_key = 'wh-test-10'"
  );
  check(
    "unknown token held, never auto-confirmed",
    r10.action === "deposit_confirming" && row[0]?.currency === "UNKNOWN" && row[0]?.status === "confirming",
    JSON.stringify({ action: r10.action, row: row[0] })
  );
}

console.log(`\nwebhook test: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
