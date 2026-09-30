/**
 * fee.ts — Phase 80-bps transaction-fee engine + treasury system.
 *
 * The backend is the authoritative fee calculator. The client is NEVER trusted
 * for fee amounts, fee rates, treasury destinations, or settlement amounts.
 *
 * Integer-exact arithmetic:
 *   All money math uses BigInt over base units — 6-decimal microunits for
 *   USD, whole coins for coin assets (v1 asset precision registry below).
 *   No JavaScript floating point anywhere in the fee path.
 *
 * Rounding rule (documented, deterministic):
 *   fee = floor(gross_base_units * fee_bps / 10_000)
 *   net = gross_base_units - fee
 * Flooring means the fee never exceeds 80 bps and the user never pays more
 * than the quoted gross. Sub-minimum-unit remainders stay with the fee
 * payer's net (they are credited to the payer, not to Phase).
 *
 * Eligible transactions (v1) — fees are ALWAYS denominated in the
 * transacted/purchased asset:
 *   - marketplace_buy : fee = 80 bps of the gross PURCHASED-ASSET UNITS,
 *                       deducted from the coins the BUYER receives and sent
 *                       on-chain to the Phase treasury sovereign address.
 *                       The buyer pays the quoted gross USD; the seller
 *                       receives the FULL gross USD proceeds (no fee is
 *                       deducted from seller proceeds).
 *   - marketplace_swap: fee = 80 bps of the TARGET coin units the buyer
 *                       receives, deducted from the buyer's coins and sent
 *                       on-chain to the Phase treasury sovereign address.
 *
 * Canonical example: gross 10,000 PHI -> 80 PHI treasury fee -> 9,920 PHI
 * to the buyer.
 *
 * Secrets: the treasury is referenced by PHASE_TREASURY_ACCOUNT_ID (an
 * opaque account id, not a key). Private keys / bank credentials live in
 * server-side secret management only — never in the repo, APK, or logs.
 */
import { randomUUID } from "node:crypto";
import { getPool, dbQuery, dbQueryOne } from "./db.js";
import { auditLog } from "./sovereign-ledger-core.js";

// ---------------------------------------------------------------------------
// Integer-exact money helpers (6 decimal places = microunits)
// ---------------------------------------------------------------------------

export const FEE_BPS_DENOMINATOR = 10_000;
export const MICROUNIT_SCALE = 6;

/** Canonical in-app fee disclosure (exact wording). */
export const FEE_DISCLOSURE = "Phase charges 0.80% on applicable transactions.";

// ---------------------------------------------------------------------------
// Asset precision registry (v1)
//
// Every asset has a fixed number of base-unit decimals. All authoritative
// money math converts decimal strings to BigInt base units via this
// registry — never via floating point.
//
//   USD         -> 6 decimals (microunits; 1 USD = 1,000,000 base units)
//   coin assets -> 0 decimals (whole coins; the sovereign chain's base unit
//                  is one whole coin — supply and balances are whole shares)
//
// When fractional coin units are introduced, add the asset here with its
// decimals instead of scattering scale factors through settlement code.
// ---------------------------------------------------------------------------

export function assetDecimals(assetSymbol: string): number {
  return assetSymbol === "USD" ? MICROUNIT_SCALE : 0;
}

/** Parse a decimal string into BigInt base units for the given asset. Exact. */
export function toBaseUnits(assetSymbol: string, amount: string | number): bigint {
  const decimals = assetDecimals(assetSymbol);
  if (decimals === MICROUNIT_SCALE) return toMicroUnits(amount);
  // Whole-unit assets: reject fractional input (v1 coins are indivisible).
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`fractional_coin_amount: ${s}`);
  const v = BigInt(s);
  if (v < 0n) throw new Error(`negative_money: ${s}`);
  return v;
}

/** Format BigInt base units back to a decimal string for the given asset. */
export function fromBaseUnits(assetSymbol: string, base: bigint): string {
  const decimals = assetDecimals(assetSymbol);
  if (decimals === MICROUNIT_SCALE) return fromMicroUnits(base);
  if (base < 0n) throw new Error("negative_coin_units");
  return base.toString();
}

/** Whole coin units -> 6dp decimal text (matches NUMERIC(30,6) columns). Exact. */
export function coinUnitsToDecimal(units: bigint): string {
  if (units < 0n) throw new Error("negative_coin_units");
  return fromMicroUnits(units * 1_000_000n);
}

/** 6dp decimal text -> whole coin units. Exact; rejects fractional coins. */
export function decimalToCoinUnits(decimal: string): bigint {
  const micro = toMicroUnits(decimal);
  if (micro % 1_000_000n !== 0n) throw new Error(`fractional_coin_amount: ${decimal}`);
  return micro / 1_000_000n;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal money string (e.g. "123.456789") into integer microunits
 * as a BigInt. Exact — no floating point. Fractional digits beyond 6 are
 * truncated (inputs from the ledger are already normalized to 6dp).
 */
export function toMicroUnits(amount: string | number): bigint {
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error(`invalid_money: ${s}`);
  const negative = m[1] === "-";
  const intPart = m[2];
  const fracPart = (m[3] ?? "").padEnd(MICROUNIT_SCALE, "0").slice(0, MICROUNIT_SCALE);
  const micro = BigInt(intPart + fracPart);
  if (negative && micro !== 0n) throw new Error(`negative_money: ${s}`);
  return micro;
}

/** Format integer microunits back to a 6dp decimal string. */
/** Format microunits as a 6dp decimal string. Negative values (e.g. a
 * reconciliation shortfall) render with a leading minus sign. */
export function fromMicroUnits(micro: bigint): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  const padded = abs.toString().padStart(MICROUNIT_SCALE + 1, "0");
  const intPart = padded.slice(0, -MICROUNIT_SCALE);
  const fracPart = padded.slice(-MICROUNIT_SCALE);
  return `${sign}${intPart}.${fracPart}`;
}

export interface FeeSplit {
  /** fee in base units (microunits for USD, whole units for coins) */
  fee: bigint;
  /** net (gross - fee) in base units */
  net: bigint;
}

/**
 * Authoritative fee calculation. Pure integer math:
 *   fee = floor(gross * feeBps / 10000); net = gross - fee.
 */
export function calculateFee(grossBaseUnits: bigint, feeBps: number): FeeSplit {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_DENOMINATOR) {
    throw new Error(`invalid_fee_bps: ${feeBps}`);
  }
  if (grossBaseUnits < 0n) throw new Error("negative_gross");
  const fee = (grossBaseUnits * BigInt(feeBps)) / BigInt(FEE_BPS_DENOMINATOR);
  return { fee, net: grossBaseUnits - fee };
}

/** Convenience wrapper for 6dp decimal strings (USD-style amounts). */
export function calculateFeeOnDecimal(grossDecimal: string, feeBps: number): {
  feeDecimal: string;
  netDecimal: string;
} {
  const gross = toMicroUnits(grossDecimal);
  const { fee, net } = calculateFee(gross, feeBps);
  return { feeDecimal: fromMicroUnits(fee), netDecimal: fromMicroUnits(net) };
}

// ---------------------------------------------------------------------------
// Fee configuration — server-controlled, versioned, auditable
// ---------------------------------------------------------------------------

export interface FeeConfig {
  version: number;
  feeBps: number;
  effectiveFrom: string;
  createdBy: string;
  reason: string | null;
}

const CONFIG_TTL_MS = 30_000;
let configCache: { at: number; cfg: FeeConfig } | null = null;

function seedBpsFromEnv(): number {
  const raw = (process.env.TRANSACTION_FEE_BPS ?? "80").trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > FEE_BPS_DENOMINATOR) {
    throw new Error(
      `TRANSACTION_FEE_BPS must be an integer 0..10000 (got ${JSON.stringify(raw)})`
    );
  }
  return n;
}

/** Current fee configuration. Latest version wins; cached briefly.
 *
 * If the database is unreachable AND no DATABASE_URL is configured (explicit
 * local dev/test), falls back to the env-seeded default (TRANSACTION_FEE_BPS,
 * 80) rather than failing — marked version 0 / createdBy 'system:fallback' so
 * callers can tell.
 *
 * Production safety: when DATABASE_URL is set but the database is
 * unreachable, this THROWS instead of silently using a fallback fee config.
 * Silently mis-pricing fees in production (wrong bps, missing fee_config
 * version) is worse than failing the request loudly.
 */
export async function getFeeConfig(): Promise<FeeConfig> {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.cfg;
  try {
    return await getFeeConfigFromDb(now);
  } catch (err) {
    const hasDbUrl = (process.env.DATABASE_URL ?? "").trim().length > 0;
    if (hasDbUrl) throw err;
    const cfg: FeeConfig = {
      version: 0,
      feeBps: seedBpsFromEnv(),
      effectiveFrom: new Date(now).toISOString(),
      createdBy: "system:fallback",
      reason: "database unreachable — env default",
    };
    configCache = { at: now, cfg };
    return cfg;
  }
}

async function getFeeConfigFromDb(now: number): Promise<FeeConfig> {
  let row = await dbQueryOne<{
    version: number;
    fee_bps: number;
    effective_from: string;
    created_by: string;
    reason: string | null;
  }>(`SELECT version, fee_bps, effective_from::text, created_by, reason
      FROM fee_config ORDER BY version DESC LIMIT 1`);
  if (!row) {
    const seed = seedBpsFromEnv();
    row = await dbQueryOne<{
      version: number;
      fee_bps: number;
      effective_from: string;
      created_by: string;
      reason: string | null;
    }>(
      `INSERT INTO fee_config (fee_bps, created_by, reason)
       VALUES ($1, 'system:seed', 'Seeded from TRANSACTION_FEE_BPS')
       ON CONFLICT DO NOTHING
       RETURNING version, fee_bps, effective_from::text, created_by, reason`,
      [seed]
    );
    if (!row) {
      row = await dbQueryOne<{
        version: number;
        fee_bps: number;
        effective_from: string;
        created_by: string;
        reason: string | null;
      }>(`SELECT version, fee_bps, effective_from::text, created_by, reason
          FROM fee_config ORDER BY version DESC LIMIT 1`);
    }
  }
  if (!row) throw new Error("fee_config_unavailable");
  const cfg: FeeConfig = {
    version: row.version,
    feeBps: row.fee_bps,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    reason: row.reason,
  };
  configCache = { at: now, cfg };
  return cfg;
}

/**
 * Change the fee rate. Appends a new version (history is preserved);
 * audited. Only callable from the admin API.
 */
export async function setFeeConfig(
  feeBps: number,
  actor: string,
  reason?: string
): Promise<FeeConfig> {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_DENOMINATOR) {
    throw new Error(`invalid_fee_bps: ${feeBps}`);
  }
  const row = await dbQueryOne<{
    version: number;
    fee_bps: number;
    effective_from: string;
    created_by: string;
    reason: string | null;
  }>(
    `INSERT INTO fee_config (fee_bps, created_by, reason)
     VALUES ($1, $2, $3)
     RETURNING version, fee_bps, effective_from::text, created_by, reason`,
    [feeBps, actor, reason ?? null]
  );
  if (!row) throw new Error("fee_config_write_failed");
  configCache = null;
  const cfg: FeeConfig = {
    version: row.version,
    feeBps: row.fee_bps,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    reason: row.reason,
  };
  await auditLog(actor, "fee_config_changed", "fee_config", String(cfg.version), {
    feeBps: cfg.feeBps,
    reason: reason ?? null,
  });
  return cfg;
}

/** Test hook: clear the config cache. */
export function clearFeeConfigCache(): void {
  configCache = null;
}

// ---------------------------------------------------------------------------
// Treasury abstraction
// ---------------------------------------------------------------------------

/** Opaque treasury account id — never a key, never a secret. */
export function getTreasuryAccountId(): string {
  return (process.env.PHASE_TREASURY_ACCOUNT_ID ?? "PHASE_TREASURY").trim() || "PHASE_TREASURY";
}

/**
 * Sovereign-chain address where coin-denominated fees (swaps) are collected.
 * Must be configured by the operator; swaps fail closed without it.
 */
export function getTreasurySovereignAddress(): string | null {
  const a = (process.env.PHASE_TREASURY_SOVEREIGN_ADDRESS ?? "").trim();
  return a || null;
}

export function requireTreasurySovereignAddress(): string {
  const a = getTreasurySovereignAddress();
  if (!a || !/^ph1[0-9a-zA-Z]+$/.test(a)) {
    const err = new Error(
      "fee_treasury_unconfigured: set PHASE_TREASURY_SOVEREIGN_ADDRESS to a valid ph1 treasury address"
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 503;
    err.code = "fee_treasury_unconfigured";
    throw err;
  }
  return a;
}

export async function ensureTreasuryAccount(
  accountId: string,
  client?: { query: (t: string, p?: unknown[]) => Promise<unknown> }
): Promise<void> {
  const q = client ?? { query: (t: string, p?: unknown[]) => dbQuery(t, p) };
  await q.query(
    `INSERT INTO treasury_accounts (account_id, label)
     VALUES ($1, 'Phase corporate treasury')
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId]
  );
}

export interface TreasuryBalance {
  accountId: string;
  assetSymbol: string;
  balance: string;
}

/** Credit the treasury balance sheet (call inside the caller's transaction). */
export async function creditTreasury(
  client: { query: (t: string, p?: unknown[]) => Promise<{ rows: { balance: string }[] }> },
  accountId: string,
  assetSymbol: string,
  amountDecimal: string
): Promise<string> {
  const rows = (
    await client.query(
      `INSERT INTO treasury_balances (account_id, asset_symbol, balance)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (account_id, asset_symbol)
       DO UPDATE SET balance = treasury_balances.balance + EXCLUDED.balance,
                     updated_at = now()
       RETURNING balance::text AS balance`,
      [accountId, assetSymbol, amountDecimal]
    )
  ).rows;
  return rows[0].balance;
}

/** Debit the treasury balance sheet; throws insufficient_treasury_balance. */
export async function debitTreasury(
  client: { query: (t: string, p?: unknown[]) => Promise<{ rows: { balance: string }[]; rowCount: number | null }> },
  accountId: string,
  assetSymbol: string,
  amountDecimal: string
): Promise<string> {
  const res = await client.query(
    `UPDATE treasury_balances
     SET balance = balance - $3::numeric, updated_at = now()
     WHERE account_id = $1 AND asset_symbol = $2 AND balance >= $3::numeric
     RETURNING balance::text AS balance`,
    [accountId, assetSymbol, amountDecimal]
  );
  if (!res.rows[0]) {
    const err = new Error("insufficient_treasury_balance") as Error & { code?: string };
    err.code = "insufficient_treasury_balance";
    throw err;
  }
  return res.rows[0].balance;
}

export async function getTreasuryBalances(accountId?: string): Promise<TreasuryBalance[]> {
  const rows = accountId
    ? await dbQuery<{ account_id: string; asset_symbol: string; balance: string }>(
        `SELECT account_id, asset_symbol, balance::text AS balance
         FROM treasury_balances WHERE account_id = $1 ORDER BY asset_symbol`,
        [accountId]
      )
    : await dbQuery<{ account_id: string; asset_symbol: string; balance: string }>(
        `SELECT account_id, asset_symbol, balance::text AS balance
         FROM treasury_balances ORDER BY account_id, asset_symbol`
      );
  return rows.map((r) => ({
    accountId: r.account_id,
    assetSymbol: r.asset_symbol,
    balance: r.balance,
  }));
}

// ---------------------------------------------------------------------------
// Fee ledger
// ---------------------------------------------------------------------------

export type FeeTransactionType = "marketplace_buy" | "marketplace_swap";
export type FeeStatus = "settled" | "pending" | "reversed" | "failed";

export interface FeeRecordInput {
  idempotencyKey: string;
  transactionId?: string | null;
  transactionType: FeeTransactionType;
  /** Fee payer: the buyer (deducted from the purchased/received asset units). */
  userId: string;
  assetId?: string | null;
  assetSymbol: string;
  grossQuantity: string;
  feeBps: number;
  feeQuantity: string;
  netQuantity: string;
  treasuryAccountId: string;
  coinTxId?: string | null;
  status?: FeeStatus;
}

export interface FeeRecord extends FeeRecordInput {
  feeId: string;
  status: FeeStatus;
  createdAt: string;
  settledAt: string | null;
}

const FEE_COLS = `fee_id AS "feeId", idempotency_key AS "idempotencyKey",
  transaction_id AS "transactionId", transaction_type AS "transactionType",
  user_id AS "userId", asset_id AS "assetId", asset_symbol AS "assetSymbol",
  gross_quantity::text AS "grossQuantity", fee_bps AS "feeBps",
  fee_quantity::text AS "feeQuantity", net_quantity::text AS "netQuantity",
  treasury_account_id AS "treasuryAccountId", status,
  coin_tx_id AS "coinTxId", created_at AS "createdAt", settled_at AS "settledAt"`;

/**
 * Insert a fee record. Idempotent on idempotency_key: a repeated call with
 * the same key returns the ORIGINAL row without creating a second fee.
 * `client` may be a pg Pool client (inside a transaction) or the pool.
 */
export async function recordFee(
  client: { query: (t: string, p?: unknown[]) => Promise<{ rows: FeeRecord[] }> },
  input: FeeRecordInput
): Promise<{ record: FeeRecord; created: boolean }> {
  const feeId = randomUUID();
  const rows = (
    await client.query(
      `INSERT INTO fee_ledger
         (fee_id, idempotency_key, transaction_id, transaction_type, user_id,
          asset_id, asset_symbol, gross_quantity, fee_bps, fee_quantity,
          net_quantity, treasury_account_id, status, coin_tx_id, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10::numeric,$11::numeric,$12,$13,$14,
               CASE WHEN $13 = 'settled' THEN now() ELSE NULL END)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${FEE_COLS}`,
      [
        feeId,
        input.idempotencyKey,
        input.transactionId ?? null,
        input.transactionType,
        input.userId,
        input.assetId ?? null,
        input.assetSymbol,
        input.grossQuantity,
        input.feeBps,
        input.feeQuantity,
        input.netQuantity,
        input.treasuryAccountId,
        input.status ?? "settled",
        input.coinTxId ?? null,
      ]
    )
  ).rows;
  if (rows[0]) return { record: rows[0], created: true };
  const existing = await getFeeByIdempotencyKey(input.idempotencyKey);
  if (!existing) throw new Error("fee idempotency conflict without existing record");
  return { record: existing, created: false };
}

export async function getFeeByIdempotencyKey(key: string): Promise<FeeRecord | null> {
  const rows = await dbQuery<FeeRecord>(
    `SELECT ${FEE_COLS} FROM fee_ledger WHERE idempotency_key = $1`,
    [key]
  );
  return rows[0] ?? null;
}

export async function getFeeByTransactionId(transactionId: string): Promise<FeeRecord | null> {
  const rows = await dbQuery<FeeRecord>(
    `SELECT ${FEE_COLS} FROM fee_ledger WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [transactionId]
  );
  return rows[0] ?? null;
}

export async function setFeeTransactionId(idempotencyKey: string, transactionId: string): Promise<void> {
  await dbQuery(`UPDATE fee_ledger SET transaction_id = $2 WHERE idempotency_key = $1`, [
    idempotencyKey,
    transactionId,
  ]);
}

/** Mark a fee reversed (refunds/compensation). The treasury debit happens in the caller's transaction. */
export async function markFeeReversed(
  client: { query: (t: string, p?: unknown[]) => Promise<unknown> },
  idempotencyKey: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE fee_ledger
     SET status = 'reversed', reversed_at = now(), reversal_reason = $2
     WHERE idempotency_key = $1 AND status = 'settled'`,
    [idempotencyKey, reason]
  );
}

/**
 * Mark a pending fee settled once its on-chain collection is confirmed.
 * Records the fee-transfer tx id and stamps settled_at. Only transitions
 * pending -> settled (idempotent: a second call is a no-op).
 */
export async function markFeeSettled(
  client: { query: (t: string, p?: unknown[]) => Promise<{ rowCount?: number | null }> },
  idempotencyKey: string,
  coinTxId: string | null
): Promise<boolean> {
  const r = await client.query(
    `UPDATE fee_ledger
     SET status = 'settled', settled_at = now(),
         coin_tx_id = COALESCE($2, coin_tx_id)
     WHERE idempotency_key = $1 AND status = 'pending'`,
    [idempotencyKey, coinTxId]
  );
  // True only when the row actually transitioned pending -> settled. A
  // retry on an already-settled fee returns false so callers never
  // double-credit the treasury.
  return (r.rowCount ?? 0) > 0;
}

/**
 * Mark a pending fee failed (e.g. the money leg could not move). Only
 * transitions pending -> failed.
 */
export async function markFeeFailed(
  client: { query: (t: string, p?: unknown[]) => Promise<unknown> },
  idempotencyKey: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE fee_ledger
     SET status = 'failed', reversal_reason = $2
     WHERE idempotency_key = $1 AND status = 'pending'`,
    [idempotencyKey, reason]
  );
}

export function feeIdempotencyKey(kind: "buy" | "swap", attemptKey: string): string {
  return `fee:${kind}:${attemptKey}`;
}

// ---------------------------------------------------------------------------
// Admin authorization
// ---------------------------------------------------------------------------

/** PHASE_ADMIN_EMAILS: comma-separated allowlist; matched case-insensitively. */
export function getAdminEmails(): Set<string> {
  return new Set(
    (process.env.PHASE_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** True when the user is flagged is_admin OR their email is on the allowlist. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const row = await dbQueryOne<{ is_admin: boolean; email: string | null }>(
    `SELECT is_admin, email FROM issuance_users WHERE id = $1`,
    [userId]
  );
  if (!row) return false;
  if (row.is_admin) return true;
  if (row.email && getAdminEmails().has(row.email.trim().toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Treasury withdrawals (requested -> approved -> executed)
// ---------------------------------------------------------------------------

export type WithdrawalStatus = "requested" | "approved" | "rejected" | "executed" | "cancelled";

export interface WithdrawalRecord {
  id: string;
  treasuryAccountId: string;
  assetSymbol: string;
  amount: string;
  destinationRef: string;
  provider: string;
  providerRef: string | null;
  status: WithdrawalStatus;
  requestedBy: string;
  approvedBy: string | null;
  executedBy: string | null;
  selfApproved: boolean;
  note: string | null;
  createdAt: string;
}

const WD_COLS = `id, treasury_account_id AS "treasuryAccountId",
  asset_symbol AS "assetSymbol", amount::text AS "amount",
  destination_ref AS "destinationRef", provider,
  provider_ref AS "providerRef", status,
  requested_by AS "requestedBy", approved_by AS "approvedBy",
  executed_by AS "executedBy", self_approved AS "selfApproved",
  note, created_at AS "createdAt"`;

export async function requestWithdrawal(input: {
  treasuryAccountId?: string;
  assetSymbol: string;
  amount: string;
  destinationRef: string;
  provider?: string;
  note?: string;
  requestedBy: string;
}): Promise<WithdrawalRecord> {
  const accountId = (input.treasuryAccountId ?? getTreasuryAccountId()).trim();
  await ensureTreasuryAccount(accountId);
  const amountMicro = toMicroUnits(input.amount);
  if (amountMicro <= 0n) throw new Error("withdrawal_amount_must_be_positive");
  const provider = (input.provider ?? "manual").trim() || "manual";
  if (!SUPPORTED_WITHDRAWAL_PROVIDERS.includes(provider)) {
    throw new Error(`unsupported_withdrawal_provider: ${provider}`);
  }
  const rows = await dbQuery<WithdrawalRecord>(
    `INSERT INTO treasury_withdrawals
       (id, treasury_account_id, asset_symbol, amount, destination_ref, provider, status, requested_by, note)
     VALUES ($1,$2,$3,$4::numeric,$5,$6,'requested',$7,$8)
     RETURNING ${WD_COLS}`,
    [
      randomUUID(),
      accountId,
      input.assetSymbol.trim().toUpperCase(),
      fromMicroUnits(amountMicro),
      input.destinationRef.trim(),
      provider,
      input.requestedBy,
      input.note?.trim() || null,
    ]
  );
  const wd = rows[0];
  await auditLog(input.requestedBy, "treasury_withdrawal_requested", "treasury_withdrawal", wd.id, {
    assetSymbol: wd.assetSymbol,
    amount: wd.amount,
    provider,
  });
  return wd;
}

export async function getWithdrawal(id: string): Promise<WithdrawalRecord | null> {
  const rows = await dbQuery<WithdrawalRecord>(
    `SELECT ${WD_COLS} FROM treasury_withdrawals WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listWithdrawals(status?: string, limit = 50): Promise<WithdrawalRecord[]> {
  const rows = status
    ? await dbQuery<WithdrawalRecord>(
        `SELECT ${WD_COLS} FROM treasury_withdrawals WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, Math.min(limit, 200)]
      )
    : await dbQuery<WithdrawalRecord>(
        `SELECT ${WD_COLS} FROM treasury_withdrawals ORDER BY created_at DESC LIMIT $1`,
        [Math.min(limit, 200)]
      );
  return rows;
}

/**
 * Approve (or reject) a requested withdrawal. Self-approval by the same admin
 * who requested it requires explicit selfApprove=true and is audited.
 */
export async function approveWithdrawal(
  id: string,
  approverUserId: string,
  approve: boolean,
  opts?: { selfApprove?: boolean }
): Promise<WithdrawalRecord> {
  const wd = await getWithdrawal(id);
  if (!wd) throw new Error("withdrawal_not_found");
  if (wd.status !== "requested") throw new Error(`withdrawal_not_approvable: ${wd.status}`);
  const selfApproval = wd.requestedBy === approverUserId;
  if (selfApproval && !(opts?.selfApprove === true)) {
    throw new Error("self_approval_requires_explicit_confirmation");
  }
  const rows = await dbQuery<WithdrawalRecord>(
    `UPDATE treasury_withdrawals
     SET status = $2, approved_by = $3, self_approved = $4, updated_at = now()
     WHERE id = $1 AND status = 'requested'
     RETURNING ${WD_COLS}`,
    [id, approve ? "approved" : "rejected", approverUserId, selfApproval]
  );
  if (!rows[0]) throw new Error("withdrawal_approve_conflict");
  await auditLog(approverUserId, approve ? "treasury_withdrawal_approved" : "treasury_withdrawal_rejected",
    "treasury_withdrawal", id, { selfApproved: selfApproval, amount: wd.amount, assetSymbol: wd.assetSymbol });
  return rows[0];
}

// --- Withdrawal providers --------------------------------------------------
// v1 ships a "manual" provider: an authorized admin records the external
// transfer reference (wire confirmation, bank batch id, exchange payout id).
// Regulated provider integrations (bank API / Stripe payouts / custody)
// are NOT implemented — wiring them requires provider credentials and
// legal sign-off (see docs/FEE_SYSTEM.md). They must never be faked.

export const SUPPORTED_WITHDRAWAL_PROVIDERS = ["manual"];

interface WithdrawalProvider {
  name: string;
  execute(wd: WithdrawalRecord): Promise<{ providerRef: string }>;
}

const withdrawalProviders: Record<string, WithdrawalProvider> = {
  manual: {
    name: "manual",
    execute: async (wd) => ({
      // The admin records the real-world transfer reference at execute time.
      providerRef: wd.providerRef ?? `manual-${wd.id}`,
    }),
  },
};

/**
 * Execute an approved withdrawal: debit the treasury balance sheet and mark
 * executed, atomically. Provider ref must be supplied for manual execution
 * (the real-world transfer reference), or it defaults to a manual marker.
 */
export async function executeWithdrawal(
  id: string,
  executorUserId: string,
  providerRef?: string
): Promise<WithdrawalRecord> {
  const wd = await getWithdrawal(id);
  if (!wd) throw new Error("withdrawal_not_found");
  if (wd.status !== "approved") throw new Error(`withdrawal_not_executable: ${wd.status}`);
  const provider = withdrawalProviders[wd.provider];
  if (!provider) throw new Error(`unsupported_withdrawal_provider: ${wd.provider}`);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await debitTreasury(client, wd.treasuryAccountId, wd.assetSymbol, wd.amount);
    const ref = providerRef?.trim() || (await provider.execute(wd)).providerRef;
    const rows = (
      await client.query(
        `UPDATE treasury_withdrawals
         SET status = 'executed', executed_by = $2, provider_ref = $3, updated_at = now()
         WHERE id = $1 AND status = 'approved'
         RETURNING ${WD_COLS}`,
        [id, executorUserId, ref]
      )
    ).rows as WithdrawalRecord[];
    if (!rows[0]) throw new Error("withdrawal_execute_conflict");
    await client.query("COMMIT");
    await auditLog(executorUserId, "treasury_withdrawal_executed", "treasury_withdrawal", id, {
      assetSymbol: wd.assetSymbol,
      amount: wd.amount,
      provider: wd.provider,
      providerRef: ref,
    });
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface AssetReconciliation {
  assetSymbol: string;
  /** Σ fee_ledger.fee_quantity where status='settled' */
  collected: string;
  /** Σ treasury_withdrawals.amount where status='executed' */
  withdrawn: string;
  treasuryBalance: string;
  expected: string;
  difference: string;
  ok: boolean;
}

export interface ReconciliationResult {
  ranAt: string;
  periodStart: string;
  periodEnd: string;
  assets: AssetReconciliation[];
  /** USD cross-check: treasury_balances(USD) vs market_balances PHASE_TREASURY row */
  usdOperationalBalance: string | null;
  usdOperationalDifference: string | null;
  invariantOk: boolean;
  runId: number | null;
}

/**
 * Daily reconciliation. Invariant per asset:
 *   Σ settled fees = treasury balance + Σ executed withdrawals
 * (reversed fees are excluded from "settled", so they drop out of both
 * sides — the treasury debit on reversal keeps the equation balanced).
 * Discrepancies are NEVER silently repaired: they are recorded and alerted.
 */
export async function runFeeReconciliation(periodDays = 1): Promise<ReconciliationResult> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 3600 * 1000);

  const collected = await dbQuery<{ asset_symbol: string; total: string }>(
    `SELECT asset_symbol, COALESCE(SUM(fee_quantity), 0)::text AS total
     FROM fee_ledger WHERE status = 'settled'
     GROUP BY asset_symbol`
  );
  const withdrawn = await dbQuery<{ asset_symbol: string; total: string }>(
    `SELECT asset_symbol, COALESCE(SUM(amount), 0)::text AS total
     FROM treasury_withdrawals WHERE status = 'executed'
     GROUP BY asset_symbol`
  );
  const balances = await getTreasuryBalances();

  const collectedBy = new Map(collected.map((r) => [r.asset_symbol, toMicroUnits(r.total)]));
  const withdrawnBy = new Map(withdrawn.map((r) => [r.asset_symbol, toMicroUnits(r.total)]));
  const symbols = new Set<string>([
    ...collectedBy.keys(),
    ...withdrawnBy.keys(),
    ...balances.map((b) => b.assetSymbol),
  ]);

  const assets: AssetReconciliation[] = [];
  for (const symbol of [...symbols].sort()) {
    const c = collectedBy.get(symbol) ?? 0n;
    const w = withdrawnBy.get(symbol) ?? 0n;
    const balRow = balances.find(
      (b) => b.assetSymbol === symbol && b.accountId === getTreasuryAccountId()
    );
    const bal = balRow ? toMicroUnits(balRow.balance) : 0n;
    const expected = c - w;
    const difference = bal - expected;
    assets.push({
      assetSymbol: symbol,
      collected: fromMicroUnits(c),
      withdrawn: fromMicroUnits(w),
      treasuryBalance: fromMicroUnits(bal),
      expected: fromMicroUnits(expected),
      difference: fromMicroUnits(difference),
      ok: difference === 0n,
    });
  }

  // USD operational cross-check: the spendable market_balances row for the
  // treasury account should mirror treasury_balances(USD).
  let usdOperationalBalance: string | null = null;
  let usdOperationalDifference: string | null = null;
  try {
    const op = await dbQueryOne<{ balance: string }>(
      `SELECT balance::text AS balance FROM market_balances
       WHERE user_id = $1 AND currency = 'USD'`,
      [getTreasuryAccountId()]
    );
    const tb = assets.find((a) => a.assetSymbol === "USD");
    if (op && tb) {
      usdOperationalBalance = op.balance;
      const diff = toMicroUnits(op.balance) - toMicroUnits(tb.treasuryBalance);
      usdOperationalDifference = fromMicroUnits(diff < 0n ? -diff : diff);
      if (diff !== 0n) {
        assets.push({
          assetSymbol: "USD:operational",
          collected: tb.treasuryBalance,
          withdrawn: "0.000000",
          treasuryBalance: op.balance,
          expected: tb.treasuryBalance,
          difference: fromMicroUnits(diff),
          ok: false,
        });
      }
    }
  } catch {
    // market_balances may not exist in some deployments; cross-check is best-effort.
  }

  const invariantOk = assets.every((a) => a.ok);
  const result: ReconciliationResult = {
    ranAt: new Date().toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    assets,
    usdOperationalBalance,
    usdOperationalDifference,
    invariantOk,
    runId: null,
  };

  const runRow = await dbQueryOne<{ id: number }>(
    `INSERT INTO reconciliation_runs (period_start, period_end, totals, invariant_ok, alerted)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING id`,
    [result.periodStart, result.periodEnd, JSON.stringify(result), invariantOk, !invariantOk]
  );
  result.runId = runRow?.id ?? null;

  if (!invariantOk) {
    const bad = assets.filter((a) => !a.ok);
    console.error("[fees] RECONCILIATION MISMATCH:", JSON.stringify(bad));
    await auditLog("system", "fee_reconciliation_alert", "reconciliation",
      result.runId != null ? String(result.runId) : null, {
        mismatches: bad,
        note: "Discrepancy recorded — never auto-repaired. Investigate before any further withdrawals.",
      });
    // Outbound alert: optional webhook (PagerDuty/Opsgenie event endpoint,
    // Slack incoming webhook, ...). Best-effort; never throws, never repairs.
    const hook = process.env.PHASE_ALERT_WEBHOOK_URL;
    if (hook) {
      try {
        await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "phase_fee_reconciliation_mismatch",
            run_id: result.runId,
            ran_at: result.ranAt,
            mismatches: bad,
          }),
        });
      } catch (e) {
        console.error("[fees] alert webhook failed:", (e as Error).message);
      }
    }
  } else {
    await auditLog("system", "fee_reconciliation_ok", "reconciliation",
      result.runId != null ? String(result.runId) : null, {
        assets: assets.length,
      });
  }
  return result;
}

export async function latestReconciliation(): Promise<{
  id: number;
  ranAt: string;
  invariantOk: boolean;
  totals: unknown;
} | null> {
  const row = await dbQueryOne<{ id: number; ran_at: string; invariant_ok: boolean; totals: unknown }>(
    `SELECT id, ran_at::text AS ran_at, invariant_ok, totals
     FROM reconciliation_runs ORDER BY id DESC LIMIT 1`
  );
  if (!row) return null;
  return { id: row.id, ranAt: row.ran_at, invariantOk: row.invariant_ok, totals: row.totals };
}

// ---------------------------------------------------------------------------
// Production safety checks (spec §19)
// ---------------------------------------------------------------------------

export interface ProductionCheck {
  check: string;
  ok: boolean;
  critical: boolean;
  message: string;
}

/** Automated preflight checks. Critical failures should block production boot. */
export async function runProductionChecks(): Promise<ProductionCheck[]> {
  const checks: ProductionCheck[] = [];
  const isProd =
    (process.env.PHASE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() === "production";

  // 1. Fee configuration valid
  try {
    const cfg = await getFeeConfig();
    checks.push({
      check: "fee_config_valid",
      ok: cfg.feeBps >= 0 && cfg.feeBps <= 10000,
      critical: true,
      message: `fee_bps=${cfg.feeBps} (version ${cfg.version})`,
    });
    if (cfg.feeBps === 0) {
      checks.push({
        check: "fee_config_nonzero",
        ok: false,
        critical: false,
        message: "Fee rate is 0 bps — no revenue is being collected.",
      });
    }
  } catch (e) {
    checks.push({
      check: "fee_config_valid",
      ok: false,
      critical: true,
      message: `fee config unreadable: ${(e as Error).message}`,
    });
  }

  // 2. Treasury account configured
  const treasuryId = getTreasuryAccountId();
  checks.push({
    check: "treasury_account_configured",
    ok: treasuryId.length > 0,
    critical: isProd,
    message: `PHASE_TREASURY_ACCOUNT_ID=${treasuryId}`,
  });

  // 3. Swap-fee treasury address (required for coin-denominated fee collection)
  const tsAddr = getTreasurySovereignAddress();
  checks.push({
    check: "treasury_sovereign_address",
    ok: !!tsAddr && /^ph1[0-9a-zA-Z]+$/.test(tsAddr),
    critical: false,
    message: tsAddr
      ? "PHASE_TREASURY_SOVEREIGN_ADDRESS is set (swaps collect fees)"
      : "PHASE_TREASURY_SOVEREIGN_ADDRESS not set — swaps will fail closed until configured",
  });

  // 4. No test payment credentials in production
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  const testKeyInProd = isProd && /sk_test/.test(stripeKey);
  checks.push({
    check: "no_test_payment_credentials",
    ok: !testKeyInProd,
    critical: true,
    message: testKeyInProd
      ? "STRIPE_SECRET_KEY is a TEST key in production"
      : "no test Stripe secret detected in production",
  });

  // 5. Postgres persistence (fee ledger must not run in-memory in production)
  let hasDb = false;
  try {
    getPool();
    await getPool().query("SELECT 1");
    hasDb = true;
  } catch { /* no db */ }
  checks.push({
    check: "postgres_available",
    ok: hasDb || !isProd,
    critical: isProd,
    message: hasDb ? "Postgres reachable" : "Postgres unreachable — fee ledger would be unavailable",
  });

  // 6. Admin access configured (someone must be able to operate the treasury)
  const adminEmails = getAdminEmails();
  let flaggedAdmins = 0;
  try {
    const r = await dbQueryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM issuance_users WHERE is_admin = TRUE`
    );
    flaggedAdmins = Number(r?.n ?? 0);
  } catch { /* table may predate migration in dev */ }
  checks.push({
    check: "admin_configured",
    ok: adminEmails.size > 0 || flaggedAdmins > 0,
    critical: false,
    message:
      adminEmails.size > 0 || flaggedAdmins > 0
        ? `${flaggedAdmins} flagged admin(s), ${adminEmails.size} allowlisted email(s)`
        : "No admin configured — set PHASE_ADMIN_EMAILS or flag issuance_users.is_admin",
  });

  // 7. Debug mode off in production
  const debugOn = isProd && ["1", "true"].includes((process.env.PHASE_DEBUG ?? "").toLowerCase());
  checks.push({
    check: "debug_disabled",
    ok: !debugOn,
    critical: false,
    message: debugOn ? "PHASE_DEBUG is enabled in production" : "debug mode off",
  });

  return checks;
}

/** Log production checks at boot; throw on critical failures when enforced. */
export async function assertProductionReady(): Promise<ProductionCheck[]> {
  const checks = await runProductionChecks();
  for (const c of checks) {
    const tag = c.ok ? "ok" : c.critical ? "CRITICAL" : "warn";
    console.log(`[fees] production check [${tag}] ${c.check}: ${c.message}`);
  }
  const criticalFailed = checks.filter((c) => c.critical && !c.ok);
  if (criticalFailed.length > 0 && process.env.PHASE_REQUIRE_PRODUCTION_CHECKS === "true") {
    throw new Error(
      `production checks failed: ${criticalFailed.map((c) => c.check).join(", ")}`
    );
  }
  return checks;
}
