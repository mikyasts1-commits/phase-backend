/**
 * Postgres persistence round-trip test (no Circle network calls, no funds):
 *
 *   Seed mode (default):  npx tsx test-persistence.ts [tag]
 *     - migrates, seeds a wallet record via seedUserWalletRecord
 *     - inserts a synthetic deposit ledger entry via handleCircleWebhook
 *       (HMAC-signed synthetic payload, same pattern as test-webhook.ts)
 *     - re-sends the same webhook -> must be deduped (duplicate_ignored)
 *     - prints USER_ID and LEDGER_ID, exits 0
 *
 *   Verify mode:  npx tsx test-persistence.ts --verify <userId> <ledgerId>
 *     - fresh process: proves the wallet record + ledger entry survived
 *       the restart. Exits 0 when both are present, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
// Dedicated test secret so the real API key is never the HMAC fallback.
process.env.CIRCLE_WEBHOOK_SECRET = "wh-test-secret-do-not-use-in-prod";

const { migrate, closeDb, dbQueryOne } = await import("./db.js");
const mod = await import("./crypto-funding.js");

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

const args = process.argv.slice(2);

if (args[0] === "--verify") {
  const [userId, ledgerId] = [args[1], args[2]];
  if (!userId || !ledgerId) {
    console.error("usage: npx tsx test-persistence.ts --verify <userId> <ledgerId>");
    process.exit(2);
  }
  const walletRow = await dbQueryOne<{ user_id: string; record: unknown }>(
    "SELECT user_id, record FROM user_wallets WHERE user_id = $1",
    [userId]
  );
  check("wallet record survived restart", !!walletRow, `user_id=${userId}`);
  if (walletRow) {
    const rec = walletRow.record as { wallets?: Array<{ address?: string }> };
    console.log(`  wallet address: ${rec.wallets?.[0]?.address ?? "(none)"}`);
  }
  const ledgerRow = await dbQueryOne<{ id: string; kind: string; amount: string; status: string; user_id: string }>(
    "SELECT id, kind, amount, status, user_id FROM ledger_entries WHERE id = $1",
    [ledgerId]
  );
  check("ledger entry survived restart", !!ledgerRow, `id=${ledgerId}`);
  if (ledgerRow) {
    check("ledger entry belongs to seeded user", ledgerRow.user_id === userId, ledgerRow.user_id);
    console.log(`  entry: kind=${ledgerRow.kind} amount=${ledgerRow.amount} status=${ledgerRow.status}`);
  }
  await closeDb();
  console.log(`\npersistence verify: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- seed mode ----
await migrate();

const tag = args[0] ?? String(Date.now());
const userId = `persist-${tag}`;
// Unique per tag: the inbound webhook matches wallets by address, so two
// runs must not share one.
const address = `0x${Buffer.from(tag).toString("hex").padEnd(40, "0").slice(0, 40)}`;
const notificationId = `persist-wh-${tag}`;

await mod.seedUserWalletRecord({
  userId,
  walletSetId: "ws-persist-test",
  wallets: [{ walletId: `wallet-persist-${tag}`, address, blockchain: "BASE-SEPOLIA", state: "LIVE" }],
  createdAt: new Date().toISOString(),
});

// Read-back through the module's public get-or-create (created:false path).
const { record, created } = await mod.getOrCreateUserWallets(userId);
check("seeded wallet readable via getOrCreateUserWallets", created === false, `created=${created}`);
check("seeded wallet address matches", record.wallets[0]?.address === address, record.wallets[0]?.address);

// Synthetic HMAC-signed inbound deposit webhook -> creates a ledger entry.
const sign = (raw: Buffer) => createHmac("sha256", process.env.CIRCLE_WEBHOOK_SECRET!).update(raw).digest("hex");
const payload = {
  subscriptionId: "sub-persist",
  notificationId,
  notificationType: "transactions.inbound",
  timestamp: new Date().toISOString(),
  version: 2,
  notification: {
    id: `0xpersist${tag}`.slice(0, 42),
    blockchain: "BASE-SEPOLIA",
    walletId: `wallet-persist-${tag}`,
    destinationAddress: address,
    sourceAddress: "0xfaucet0000000000000000000000000000000001",
    amounts: ["5.25"],
    state: "PENDING",
    txHash: `0xpersist${tag}hash`.slice(0, 42),
    confirmations: 0,
  },
};
const raw = Buffer.from(JSON.stringify(payload));
const r1 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw) }, raw, payload);
check("synthetic deposit webhook accepted", r1.action === "deposit_confirming", r1.action);

// Same notification again -> dedup must ignore it, no second ledger entry.
const r2 = await mod.handleCircleWebhook({ "x-circle-signature": sign(raw) }, raw, payload);
check("duplicate webhook ignored", r2.action === "duplicate_ignored", r2.action);

// Resolve the created ledger entry id via its idempotency key (= notificationId).
const row = await dbQueryOne<{ id: string }>("SELECT id FROM ledger_entries WHERE idempotency_key = $1", [
  notificationId,
]);
check("ledger entry persisted with idempotency key", !!row, `notificationId=${notificationId}`);
const countRow = await dbQueryOne<{ count: string }>(
  "SELECT count(*)::text AS count FROM ledger_entries WHERE idempotency_key = $1",
  [notificationId]
);
check("no duplicate ledger entry from replay", countRow?.count === "1", `count=${countRow?.count}`);

await closeDb();
console.log(`\npersistence seed: ${pass} passed, ${fail} failed`);
if (fail === 0 && row) {
  console.log(`USER_ID=${userId}`);
  console.log(`LEDGER_ID=${row.id}`);
  console.log(`verify with: npx tsx test-persistence.ts --verify ${userId} ${row.id}`);
}
process.exit(fail === 0 ? 0 : 1);
