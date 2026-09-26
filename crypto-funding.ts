/**
 * ============================================================================
 *  PHASE PROTOCOL — Crypto Funding (USDC via Circle + USDT on EVM chains)
 * ============================================================================
 *
 *  Stablecoin funding rails for Phase accounts. Uses Circle's Web3 Services
 *  (W3S) Developer-Controlled Wallets REST API — free tier, no npm packages:
 *  only Node built-ins (global fetch, node:crypto).
 *
 *  Phase accounts are funded with crypto ONLY — USDC (Circle) and USDT
 *  (Tether) on EVM chains. There is no fiat rail in this module.
 *
 *  WHAT THIS DOES
 *    - Provisions one Circle wallet set for Phase, plus one wallet per Phase
 *      user on each configured chain (idempotent: same userId always returns
 *      the existing record).
 *    - Hands out USDC/USDT deposit addresses (EVM testnets by default —
 *      cheap gas; override with CIRCLE_CHAINS). USDT is EVM-only in Circle's
 *      token list (no USDT contract on Solana); USDC is available on all
 *      configured chains including Solana.
 *    - Sweeps deposited stablecoins from a user's wallet into the Phase
 *      treasury wallet on the same chain (Circle transfer, idempotency-keyed).
 *    - Keeps a persisted funding ledger (pending -> confirmed / failed) and
 *      updates it from Circle webhooks (signature-verified) or direct API
 *      polls of pending transfers.
 *    - Balances endpoint reports on-chain Circle balances plus ledger-credited
 *      totals per user per currency, so the mobile app can show funding status.
 *
 *  WHAT'S REAL vs WHAT'S SIMULATED — read before treating output as money
 *    - Balances, transfers, and on-chain settlement are REAL Circle API calls
 *      (testnet by default). The funding ledger, user wallets, treasury
 *      wallets, and webhook dedup are persisted to Postgres (see db.ts and
 *      db/migrations/001_init.sql); only the webhook public-key cache and
 *      small API response caches are in-memory.
 *    - Every response carries `network` plus an explicit TESTNET fake-funds
 *      label unless mainnet is deliberately unlocked (see SAFETY below).
 *    - Anything learned from an UNVERIFIED webhook is labelled
 *      verified:false and never advances a ledger entry to "confirmed".
 *    - Testnet USDT: Circle's faucet dispenses testnet USDC only; testnet
 *      USDT for the EVM chains must come from a public testnet faucet. The
 *      rail treats both identically once the tokens are on-chain.
 *
 *  SAFETY — mainnet is opt-in twice, or it doesn't happen
 *    - Default mode is TESTNET. Test API keys (TEST_API_KEY:...) are rejected
 *      by Circle on mainnet chains anyway (defense in depth).
 *    - Mainnet requires BOTH env flags:
 *          CIRCLE_MAINNET=true  AND  CIRCLE_MAINNET_CONFIRM=YES
 *      Anything less -> testnet behavior. No exceptions, no overrides.
 *    - MAINNET IS NOT ACTIVE. Do not set these flags outside a reviewed
 *      production deployment with counsel sign-off (see COMPLIANCE).
 *
 *  COMPLIANCE — not legal advice, do not skip
 *    - Holding or moving real client funds in Canada generally requires
 *      FINTRAC money-services-business (MSB) registration and provincial
 *      money-transmitter licensing analysis. Testnet first, counsel before
 *      mainnet.
 *    - Phase's "HUMAN" tradable claims are securities-shaped; the funding
 *      rail does not change the need for the securities-law review already
 *      flagged in phase-backend.ts before launch.
 *
 *  ENV VARS
 *    CIRCLE_API_KEY            Circle API key (TEST_API_KEY:... for testnet).
 *                              Absent -> all Circle routes return 503
 *                              `circle_not_configured`; nothing is faked.
 *    CIRCLE_ENTITY_SECRET      32-byte hex entity secret (generate once, keep
 *                              in a secret manager; Circle never stores it).
 *    CIRCLE_MAINNET            "true" to allow mainnet (needs CONFIRM too).
 *    CIRCLE_MAINNET_CONFIRM    must be exactly "YES" to unlock mainnet.
 *    CIRCLE_CHAINS             comma-separated chain ids or aliases
 *                              (base,polygon,solana,ethereum,avalanche).
 *                              Default testnet: BASE-SEPOLIA,MATIC-AMOY,
 *                              SOL-DEVNET. Default mainnet: BASE,MATIC,SOL.
 *    CIRCLE_WALLET_SET_ID      reuse an existing wallet set instead of
 *                              creating one.
 *    CIRCLE_OAEP_HASH          RSA-OAEP hash for entity-secret encryption
 *                              (default "sha256"; Circle's current spec).
 *    CIRCLE_WEBHOOK_SECRET     HMAC secret for legacy W3S webhook signatures
 *                              (defaults to CIRCLE_API_KEY when unset).
 *    CIRCLE_REQUIRED_CONFIRMATIONS  on-chain confirmations before a deposit
 *                              counts as confirmed (default 12).
 *
 *  Wiring: phase-backend.ts calls mountFundingRoutes({ route, sendJson,
 *  HttpError }) once at boot. Type-only import below keeps zero runtime
 *  circularity with phase-backend.ts.
 */

import {
  randomUUID,
  publicEncrypt,
  constants,
  createHmac,
  timingSafeEqual,
  createPublicKey,
  createVerify,
} from "node:crypto";
import type { RouteContext, RouteHandler } from "./phase-backend.js";
import { dbQuery, dbQueryOne } from "./db.js";

// ============================================================================
// 1. CONFIG & NETWORK SAFETY
// ============================================================================

const CIRCLE_BASE_URL = "https://api.circle.com"; // same host for test+prod; the API key picks the tier
const FAKE_FUNDS_NOTICE = "TESTNET — FAKE FUNDS. This USDC/USDT has no monetary value.";

function isMainnetUnlocked(): boolean {
  // MAINNET GATE — FINTRAC MSB REGISTRATION REQUIRED BEFORE REAL FUNDS.
  // Moving or holding real client funds in Canada requires FINTRAC
  // money-services-business (MSB) registration plus provincial
  // money-transmitter licensing analysis and counsel sign-off. These two
  // flags must never be set until that compliance work is complete.
  // Mainnet is NOT active; testnet is the only live mode today.
  return process.env.CIRCLE_MAINNET === "true" && process.env.CIRCLE_MAINNET_CONFIRM === "YES";
}

export type FundingNetwork = "testnet" | "mainnet";

export function fundingNetwork(): FundingNetwork {
  return isMainnetUnlocked() ? "mainnet" : "testnet";
}

function apiKey(): string | null {
  const k = (process.env.CIRCLE_API_KEY ?? "").trim();
  return k.length > 0 ? k : null;
}

function entitySecretHex(): string | null {
  const s = (process.env.CIRCLE_ENTITY_SECRET ?? "").trim().toLowerCase();
  // 32 bytes hex-encoded = 64 hex chars (Circle's documented format).
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

function requiredConfirmations(): number {
  const n = Number(process.env.CIRCLE_REQUIRED_CONFIRMATIONS ?? "12");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12;
}

/** Throw unless Circle is configured AND (on mainnet) properly unlocked. */
function requireCircleReady(): string {
  const key = apiKey();
  if (!key) {
    throw new FundingHttpError(
      503,
      "circle_not_configured",
      "Circle is not configured: set CIRCLE_API_KEY (and CIRCLE_ENTITY_SECRET for signing calls). " +
        "Get a free test key at https://console.circle.com and testnet USDC at https://faucet.circle.com."
    );
  }
  if (fundingNetwork() === "mainnet" && key.startsWith("TEST_API_KEY:")) {
    throw new FundingHttpError(
      403,
      "circle_test_key_on_mainnet",
      "CIRCLE_MAINNET is unlocked but the API key is a TEST_API_KEY key, which Circle rejects on mainnet chains. Refusing to proceed."
    );
  }
  return key;
}

/** Envelope fields stamped on every funding response. */
function networkEnvelope(): {
  network: FundingNetwork;
  testnet: boolean;
  fundsNotice: string;
} {
  const network = fundingNetwork();
  return {
    network,
    testnet: network === "testnet",
    fundsNotice:
      network === "testnet"
        ? FAKE_FUNDS_NOTICE
        : "MAINNET — REAL FUNDS. These transfers move real USDC/USDT with real monetary value.",
  };
}

// Local error type so this module never has to import the value HttpError
// (keeps the dependency direction one-way: phase-backend -> crypto-funding).
class FundingHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

// ============================================================================
// 2. CHAIN CONFIGURATION
// ============================================================================

/** Friendly alias -> Circle blockchain id per network. */
const CHAIN_ALIASES: Record<string, { testnet: string; mainnet: string }> = {
  base: { testnet: "BASE-SEPOLIA", mainnet: "BASE" },
  ethereum: { testnet: "ETH-SEPOLIA", mainnet: "ETH" },
  polygon: { testnet: "MATIC-AMOY", mainnet: "MATIC" },
  solana: { testnet: "SOL-DEVNET", mainnet: "SOL" },
  avalanche: { testnet: "AVAX-FUJI", mainnet: "AVAX" },
};

const DEFAULT_TESTNET_CHAINS = ["BASE-SEPOLIA", "MATIC-AMOY", "SOL-DEVNET"];
const DEFAULT_MAINNET_CHAINS = ["BASE", "MATIC", "SOL"];

/** Configured Circle blockchain ids for the active network. */
function configuredChains(): string[] {
  const raw = (process.env.CIRCLE_CHAINS ?? "").trim();
  const network = fundingNetwork();
  if (!raw) return network === "mainnet" ? [...DEFAULT_MAINNET_CHAINS] : [...DEFAULT_TESTNET_CHAINS];
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const alias = CHAIN_ALIASES[c.toLowerCase()];
      return alias ? alias[network] : c.toUpperCase().replace(/-/g, "-");
    });
}

/** Normalize a user-supplied chain alias/id to a configured Circle chain id. */
function resolveChain(input: string | null | undefined): string {
  const chains = configuredChains();
  if (!input) return chains[0];
  const network = fundingNetwork();
  const alias = CHAIN_ALIASES[input.trim().toLowerCase()];
  const id = alias ? alias[network] : input.trim().toUpperCase();
  if (!chains.includes(id)) {
    throw new FundingHttpError(
      400,
      "unsupported_chain",
      `Chain '${input}' is not enabled. Configured chains: ${chains.join(", ")} (override with CIRCLE_CHAINS).`
    );
  }
  return id;
}

// ============================================================================
// 2b. SUPPORTED CURRENCIES (USDC + USDT; crypto-only funding)
// ============================================================================

export type FundingCurrency = "USDC" | "USDT";

/**
 * Circle lists USDT contracts on EVM chains only — there is no USDT on
 * Solana in Circle's token list. USDC is available on every configured
 * chain. A custom CIRCLE_CHAINS value containing a non-EVM, non-Solana
 * chain falls back to USDC-only for safety.
 */
const EVM_CHAIN_IDS = new Set([
  "BASE-SEPOLIA",
  "MATIC-AMOY",
  "ETH-SEPOLIA",
  "AVAX-FUJI",
  "BASE",
  "MATIC",
  "ETH",
  "AVAX",
]);

/** Stablecoins Phase accepts for funding on a given Circle chain id. */
export function currenciesForChain(chain: string): FundingCurrency[] {
  return EVM_CHAIN_IDS.has(chain.toUpperCase()) ? ["USDC", "USDT"] : ["USDC"];
}

/** Validate a user-supplied currency for a chain; defaults to USDC. */
export function resolveCurrency(input: string | null | undefined, chain: string): FundingCurrency {
  const supported = currenciesForChain(chain);
  const want = (input ?? "USDC").trim().toUpperCase();
  if (!(supported as string[]).includes(want)) {
    throw new FundingHttpError(
      400,
      "unsupported_currency",
      `Currency '${input ?? ""}' is not supported on ${chain}. Supported: ${supported.join(", ")}.`
    );
  }
  return want as FundingCurrency;
}

// ============================================================================
// 3. TYPES & PERSISTED STORES (Postgres — see db.ts and db/migrations/)
// ============================================================================

export interface CircleWalletInfo {
  walletId: string;
  address: string;
  blockchain: string;
  state: string;
}

export interface UserWalletRecord {
  userId: string;
  walletSetId: string;
  wallets: CircleWalletInfo[]; // one per configured chain
  createdAt: string;
}

export type LedgerStatus = "pending" | "confirming" | "confirmed" | "failed";
export type LedgerKind = "deposit" | "sweep";

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  userId: string;
  chain: string;
  amount: string; // stablecoin decimal string (USDC/USDT), 6dp max
  currency: FundingCurrency | "UNKNOWN"; // UNKNOWN = token seen on-chain that Phase does not credit
  walletId: string | null;
  address: string | null; // user deposit address (for deposits)
  circleTransferId: string | null;
  txHash: string | null;
  status: LedgerStatus;
  confirmations: number;
  requiredConfirmations: number;
  idempotencyKey: string;
  network: FundingNetwork;
  /** True only when confirmed via signature-verified webhook or direct Circle API poll. */
  verified: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// Durable state lives in Postgres (user_wallets, treasury_wallets,
// ledger_entries, webhook_dedup). The db* helpers below are the only
// accessors; nothing else in this module touches the tables directly.

let cachedWalletSetId: string | null = null;
let cachedEntityPublicKey: string | null = null;
let cachedTokens: { at: number; tokens: Array<{ id: string; blockchain: string; symbol: string }> } | null = null;
const webhookPubkeyCache = new Map<string, string>(); // keyId -> base64 SPKI (pure cache; refetch on restart)

// ============================================================================
// 3b. PERSISTENCE LAYER (Postgres-backed stores)
// ============================================================================

interface LedgerRow {
  id: string;
  user_id: string;
  kind: string;
  chain: string;
  amount: string;
  currency: string;
  wallet_id: string | null;
  address: string | null;
  circle_transfer_id: string | null;
  tx_hash: string | null;
  status: string;
  verified: boolean;
  confirmations: number;
  required_confirmations: number;
  idempotency_key: string;
  network: string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoDate(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToLedgerEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    kind: r.kind as LedgerKind,
    userId: r.user_id,
    chain: r.chain,
    amount: r.amount,
    currency: r.currency as FundingCurrency | "UNKNOWN",
    walletId: r.wallet_id,
    address: r.address,
    circleTransferId: r.circle_transfer_id,
    txHash: r.tx_hash,
    status: r.status as LedgerStatus,
    confirmations: r.confirmations,
    requiredConfirmations: r.required_confirmations,
    idempotencyKey: r.idempotency_key,
    network: r.network as FundingNetwork,
    verified: r.verified,
    note: r.note,
    createdAt: isoDate(r.created_at),
    updatedAt: isoDate(r.updated_at),
  };
}

// --- user wallets ------------------------------------------------------------
async function dbGetUserWalletRecord(userId: string): Promise<UserWalletRecord | null> {
  const row = await dbQueryOne<{ record: unknown }>("SELECT record FROM user_wallets WHERE user_id = $1", [
    userId,
  ]);
  return row ? (row.record as UserWalletRecord) : null;
}

async function dbListUserWalletRecords(): Promise<UserWalletRecord[]> {
  const rows = await dbQuery<{ record: unknown }>("SELECT record FROM user_wallets");
  return rows.map((r) => r.record as UserWalletRecord);
}

/** Upsert a user wallet record (seed + get-or-create paths). */
async function dbPutUserWalletRecord(record: UserWalletRecord): Promise<void> {
  await dbQuery(
    `INSERT INTO user_wallets (user_id, wallet_set_id, record, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET
       wallet_set_id = EXCLUDED.wallet_set_id,
       record = EXCLUDED.record,
       updated_at = now()`,
    [record.userId, record.walletSetId, JSON.stringify(record)]
  );
}

// --- treasury wallets --------------------------------------------------------
async function dbGetTreasuryWallet(chain: string): Promise<CircleWalletInfo | null> {
  const row = await dbQueryOne<{ wallet: unknown }>("SELECT wallet FROM treasury_wallets WHERE chain_id = $1", [
    chain,
  ]);
  return row ? (row.wallet as CircleWalletInfo) : null;
}

async function dbPutTreasuryWallet(chain: string, wallet: CircleWalletInfo): Promise<void> {
  await dbQuery(
    `INSERT INTO treasury_wallets (chain_id, wallet, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (chain_id) DO UPDATE SET wallet = EXCLUDED.wallet, updated_at = now()`,
    [chain, JSON.stringify(wallet)]
  );
}

// --- ledger ------------------------------------------------------------------
async function dbGetLedgerEntry(id: string): Promise<LedgerEntry | null> {
  const row = await dbQueryOne<LedgerRow>("SELECT * FROM ledger_entries WHERE id = $1", [id]);
  return row ? rowToLedgerEntry(row) : null;
}

async function dbGetLedgerEntryByIdempotency(key: string): Promise<LedgerEntry | null> {
  const row = await dbQueryOne<LedgerRow>("SELECT * FROM ledger_entries WHERE idempotency_key = $1", [key]);
  return row ? rowToLedgerEntry(row) : null;
}

async function dbGetLedgerEntryByCircleTransfer(txId: string): Promise<LedgerEntry | null> {
  const row = await dbQueryOne<LedgerRow>("SELECT * FROM ledger_entries WHERE circle_transfer_id = $1", [txId]);
  return row ? rowToLedgerEntry(row) : null;
}

async function dbListLedgerEntriesByUser(userId: string): Promise<LedgerEntry[]> {
  const rows = await dbQuery<LedgerRow>(
    "SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC",
    [userId]
  );
  return rows.map(rowToLedgerEntry);
}

/**
 * Insert a ledger entry. The idempotency key is globally unique: on conflict
 * the existing entry is returned instead of creating a duplicate — the
 * duplicate check is atomic (INSERT ... ON CONFLICT DO NOTHING).
 */
async function dbAddLedgerEntry(e: Omit<LedgerEntry, "id" | "createdAt" | "updatedAt">): Promise<LedgerEntry> {
  const id = randomUUID();
  const rows = await dbQuery<LedgerRow>(
    `INSERT INTO ledger_entries
       (id, user_id, kind, chain, amount, currency, wallet_id, address,
        circle_transfer_id, tx_hash, status, verified, confirmations,
        required_confirmations, idempotency_key, network, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      id,
      e.userId,
      e.kind,
      e.chain,
      e.amount,
      e.currency,
      e.walletId,
      e.address,
      e.circleTransferId,
      e.txHash,
      e.status,
      e.verified,
      e.confirmations,
      e.requiredConfirmations,
      e.idempotencyKey,
      e.network,
      e.note,
    ]
  );
  let row: LedgerRow | null = rows[0] ?? null;
  if (!row) {
    // Idempotency conflict: return the existing entry.
    row = await dbQueryOne<LedgerRow>("SELECT * FROM ledger_entries WHERE idempotency_key = $1", [
      e.idempotencyKey,
    ]);
  }
  if (!row && e.circleTransferId) {
    // Belt-and-braces: a concurrent deposit insert for the same Circle
    // transfer won the race (partial unique index guards this).
    row = await dbQueryOne<LedgerRow>("SELECT * FROM ledger_entries WHERE circle_transfer_id = $1", [
      e.circleTransferId,
    ]);
  }
  if (!row) throw new Error("ledger insert failed: no row returned and no existing entry found");
  return rowToLedgerEntry(row);
}

/** Apply a patch to a ledger entry; returns the updated entry. */
async function dbTouchLedger(entry: LedgerEntry, patch: Partial<LedgerEntry>): Promise<LedgerEntry> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const col = (name: string, v: unknown): void => {
    sets.push(`${name} = $${vals.length + 1}`);
    vals.push(v);
  };
  if (patch.status !== undefined) col("status", patch.status);
  if (patch.verified !== undefined) col("verified", patch.verified);
  if (patch.txHash !== undefined) col("tx_hash", patch.txHash);
  if (patch.currency !== undefined) col("currency", patch.currency);
  if (patch.circleTransferId !== undefined) col("circle_transfer_id", patch.circleTransferId);
  if (patch.confirmations !== undefined) col("confirmations", patch.confirmations);
  if (patch.requiredConfirmations !== undefined) col("required_confirmations", patch.requiredConfirmations);
  if (patch.note !== undefined) col("note", patch.note);
  sets.push("updated_at = now()");
  vals.push(entry.id);
  const rows = await dbQuery<LedgerRow>(
    `UPDATE ledger_entries SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (rows.length === 0) throw new Error(`ledger entry ${entry.id} not found for update`);
  return rowToLedgerEntry(rows[0]);
}

// --- webhook dedup -----------------------------------------------------------
const WEBHOOK_DEDUP_LIMIT = 10_000;
const WEBHOOK_DEDUP_PRUNE_DAYS = 30;

/**
 * Record a webhook notification id. Returns true on first sight, false for
 * duplicates. The INSERT ... ON CONFLICT makes the duplicate check atomic.
 * When the table grows past ~10k rows, rows older than 30 days are pruned
 * to keep it bounded.
 */
async function dbMarkWebhookSeen(notificationId: string): Promise<boolean> {
  const rows = await dbQuery<{ notification_id: string }>(
    "INSERT INTO webhook_dedup (notification_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING notification_id",
    [notificationId]
  );
  if (rows.length === 0) return false;
  const countRow = await dbQueryOne<{ count: string }>("SELECT count(*)::text AS count FROM webhook_dedup");
  if (countRow && Number(countRow.count) > WEBHOOK_DEDUP_LIMIT) {
    await dbQuery("DELETE FROM webhook_dedup WHERE received_at < now() - make_interval(days => $1)", [
      WEBHOOK_DEDUP_PRUNE_DAYS,
    ]);
  }
  return true;
}

// ============================================================================
// 4. CIRCLE REST CLIENT (zero deps — global fetch + node:crypto)
// ============================================================================

class CircleApiError extends Error {
  constructor(public httpStatus: number, public circleCode: unknown, message: string) {
    super(message);
  }
}

/**
 * Authenticated Circle API call. Secrets are never logged: on failure we
 * surface status + Circle's error code/message, never headers or bodies that
 * could contain credentials.
 */
async function circleRequest<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = requireCircleReady();
  const method = opts.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(`${CIRCLE_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new CircleApiError(0, "network_error", `Circle request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data as { code?: unknown; message?: unknown } | null;
    throw new CircleApiError(
      res.status,
      d?.code ?? "unknown",
      `Circle API error ${res.status}: ${typeof d?.message === "string" ? d.message : JSON.stringify(d) ?? "no body"}`
    );
  }
  return (data as { data?: T }).data as T;
}

/** Circle's entity public key (cached) for entity-secret encryption. */
async function getEntityPublicKey(): Promise<string> {
  if (cachedEntityPublicKey) return cachedEntityPublicKey;
  const data = await circleRequest<{ publicKey: string }>("/v1/w3s/config/entity/publicKey");
  if (!data?.publicKey) throw new CircleApiError(0, "missing_public_key", "Circle did not return an entity public key");
  cachedEntityPublicKey = data.publicKey;
  return cachedEntityPublicKey;
}

/**
 * Decode a Circle public key field. Despite the naming, Circle returns the
 * entity public key as a PEM *string* (not base64-wrapped); the webhook
 * notification key has been observed both ways. Handle PEM text, base64 of
 * PEM text, and raw DER (SPKI or PKCS#1) so OpenSSL 3 never has to guess.
 */
function decodeCirclePublicKey(publicKeyField: string): ReturnType<typeof createPublicKey> {
  const asText = publicKeyField.includes("-----BEGIN")
    ? publicKeyField
    : Buffer.from(publicKeyField, "base64").toString("utf8");
  if (asText.includes("-----BEGIN")) {
    const type = asText.includes("RSA PUBLIC KEY") ? "pkcs1" : "spki";
    return createPublicKey({ key: asText, format: "pem", type });
  }
  const raw = Buffer.from(publicKeyField, "base64");
  try {
    return createPublicKey({ key: raw, format: "der", type: "spki" });
  } catch {
    return createPublicKey({ key: raw, format: "der", type: "pkcs1" });
  }
}
/**
 * Fresh entity-secret ciphertext for ONE API request. Circle requires
 * re-encryption on every signed call (replay protection), so this is never
 * cached. Uses RSA-OAEP with SHA-256 (Circle's current spec).
 */
async function entitySecretCiphertext(): Promise<string> {
  const secret = entitySecretHex();
  if (!secret) {
    throw new FundingHttpError(
      503,
      "circle_entity_secret_missing",
      "CIRCLE_ENTITY_SECRET is not set (or not 64 hex chars). Generate a 32-byte hex secret once and store it in the secret manager."
    );
  }
  const publicKeyB64 = await getEntityPublicKey();
  const oaepHash = (process.env.CIRCLE_OAEP_HASH ?? "sha256").trim() || "sha256";
  const encrypted = publicEncrypt(
    {
      key: decodeCirclePublicKey(publicKeyB64),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash,
    },
    Buffer.from(secret, "hex")
  );
  return encrypted.toString("base64");
}

// ============================================================================
// 5. WALLET PROVISIONING (idempotent)
// ============================================================================

interface CircleWalletSet {
  id: string;
  name?: string;
}

interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
  walletSetId: string;
  state: string;
}

/** One wallet set for all of Phase; created once, then reused. */
async function getOrCreateWalletSet(): Promise<string> {
  if (cachedWalletSetId) return cachedWalletSetId;
  const configured = (process.env.CIRCLE_WALLET_SET_ID ?? "").trim();
  if (configured) {
    cachedWalletSetId = configured;
    return configured;
  }
  const network = fundingNetwork();
  const data = await circleRequest<CircleWalletSet & { walletSet?: CircleWalletSet }>(
    "/v1/w3s/developer/walletSets",
    {
      method: "POST",
      body: {
        idempotencyKey: randomUUID(),
        name: `Phase Protocol Funding (${network})`,
        entitySecretCiphertext: await entitySecretCiphertext(),
      },
    }
  );
  // Circle nests the created set as data.walletSet; older docs show it flat.
  const walletSetId = data?.walletSet?.id ?? data?.id;
  if (!walletSetId) throw new CircleApiError(0, "wallet_set_failed", "Circle did not return a wallet set id");
  cachedWalletSetId = walletSetId;
  return walletSetId;
}

async function createWalletsOnChains(walletSetId: string, chains: string[], refPrefix: string): Promise<CircleWalletInfo[]> {
  const data = await circleRequest<{ wallets: CircleWallet[] }>("/v1/w3s/developer/wallets", {
    method: "POST",
    body: {
      idempotencyKey: randomUUID(),
      entitySecretCiphertext: await entitySecretCiphertext(),
      blockchains: chains,
      count: 1,
      walletSetId,
      refId: `${refPrefix}:${Date.now()}`,
    },
  });
  const wallets = data?.wallets ?? [];
  if (wallets.length === 0) throw new CircleApiError(0, "wallet_create_failed", "Circle returned no wallets");
  return wallets.map((w) => ({
    walletId: w.id,
    address: w.address,
    blockchain: w.blockchain,
    state: w.state ?? "LIVE",
  }));
}

/**
 * Get-or-create the wallet record for a Phase user (one wallet per
 * configured chain). Idempotent: same userId returns the existing record
 * without touching Circle again.
 */
/**
 * Seed the persisted user-wallet store with a previously created record
 * (e.g. rehydrating after a process restart). Upserts on userId.
 */
export async function seedUserWalletRecord(record: UserWalletRecord): Promise<void> {
  await dbPutUserWalletRecord(record);
}

export async function getOrCreateUserWallets(userId: string): Promise<{ record: UserWalletRecord; created: boolean }> {
  requireCircleReady();
  const existing = await dbGetUserWalletRecord(userId);
  if (existing) return { record: existing, created: false };
  const walletSetId = await getOrCreateWalletSet();
  const wallets = await createWalletsOnChains(walletSetId, configuredChains(), `phase:user:${userId}`);
  const record: UserWalletRecord = {
    userId,
    walletSetId,
    wallets,
    createdAt: new Date().toISOString(),
  };
  await dbPutUserWalletRecord(record);
  return { record, created: true };
}

/** Phase treasury wallets (one per chain) — sweep destination. */
async function getOrCreateTreasuryWallet(chain: string): Promise<CircleWalletInfo> {
  const existing = await dbGetTreasuryWallet(chain);
  if (existing) return existing;
  const walletSetId = await getOrCreateWalletSet();
  const [w] = await createWalletsOnChains(walletSetId, [chain], "phase:treasury");
  await dbPutTreasuryWallet(chain, w);
  return w;
}

// ============================================================================
// 6. TOKEN RESOLUTION (USDC + USDT)
// ============================================================================

interface TokenContractInfo {
  id: string;
  blockchain: string;
  symbol: string;
}

/**
 * Test seam / manual registration: record a token contract id -> symbol
 * mapping without hitting Circle. Used by the webhook test suite and
 * available for operational backfill. Production entries arrive via the
 * Circle token list / wallet balances below.
 */
export function registerTokenContract(tokenId: string, blockchain: string, symbol: string): void {
  if (!cachedTokens) cachedTokens = { at: Date.now(), tokens: [] };
  const id = tokenId.trim();
  const chain = blockchain.trim().toUpperCase();
  const sym = symbol.trim().toUpperCase();
  if (!cachedTokens.tokens.some((t) => t.id === id && t.blockchain === chain)) {
    cachedTokens.tokens.push({ id, blockchain: chain, symbol: sym });
  }
}

/** Refresh the cached Circle token-contract list (tolerant: may 404). */
async function refreshTokenList(): Promise<void> {
  const data = await circleRequest<unknown>("/v1/w3s/tokens");
  // Defensive: Circle nests the list differently across API versions.
  const d = data as { tokenContracts?: unknown[]; tokens?: unknown[] } | unknown[];
  const list = Array.isArray(d) ? d : d?.tokenContracts ?? d?.tokens ?? [];
  const existing = cachedTokens?.tokens ?? [];
  const merged = new Map<string, TokenContractInfo>();
  for (const t of existing) merged.set(`${t.id}|${t.blockchain}`, t);
  for (const t of list as Array<{ id?: unknown; blockchain?: unknown; symbol?: unknown }>) {
    if (typeof t?.id !== "string") continue;
    const info: TokenContractInfo = {
      id: t.id,
      blockchain: String(t.blockchain ?? "").toUpperCase(),
      symbol: String(t.symbol ?? "").toUpperCase(),
    };
    merged.set(`${info.id}|${info.blockchain}`, info);
  }
  cachedTokens = { at: Date.now(), tokens: [...merged.values()] };
}

/**
 * Resolve a Circle token contract id -> symbol. Order: manually registered /
 * cached list, then the wallet's own balances endpoint (token ids appear
 * there with symbols), then a token-list refresh. Returns null when the
 * token cannot be identified — the caller must treat that as uncredited.
 */
export async function resolveTokenSymbol(
  tokenId: string,
  blockchain: string | undefined,
  walletId?: string
): Promise<string | null> {
  const wantChain = (blockchain ?? "").toUpperCase();
  const find = (): string | null => {
    if (!cachedTokens) return null;
    const hit = cachedTokens.tokens.find(
      (t) => t.id === tokenId && (!wantChain || t.blockchain === wantChain)
    );
    return hit ? hit.symbol : null;
  };
  let symbol = find();
  if (symbol) return symbol;
  if (walletId) {
    try {
      const bal = await circleRequest<{
        tokenBalances?: Array<{
          id?: string;
          symbol?: string;
          token?: { id?: string; symbol?: string; blockchain?: string };
        }>;
      }>(`/v1/w3s/wallets/${walletId}/balances`);
      for (const b of bal?.tokenBalances ?? []) {
        const id = b.token?.id ?? b.id;
        const sym = ((b.token?.symbol ?? b.symbol) ?? "").toUpperCase();
        const chain = (b.token?.blockchain ?? "").toUpperCase();
        if (id && sym) registerTokenContract(id, chain || wantChain, sym);
      }
      symbol = find();
      if (symbol) return symbol;
    } catch {
      // Fall through to the token-list endpoint below.
    }
  }
  const now = Date.now();
  if (!cachedTokens || now - cachedTokens.at > 10 * 60_000) {
    try {
      await refreshTokenList();
    } catch {
      // Circle's /v1/w3s/tokens list has been observed to 404; the wallet
      // balances path above is the reliable fallback.
    }
  }
  return find();
}

async function resolveTokenId(blockchain: string, currency: FundingCurrency, walletId?: string): Promise<string> {
  const want = blockchain.toUpperCase();
  // Primary: derive the token id from a wallet's own balances — this endpoint
  // is verified live (Circle's /v1/w3s/tokens list currently 404s).
  if (walletId) {
    try {
      const bal = await circleRequest<{
        tokenBalances?: Array<{
          id?: string;
          amount?: string;
          symbol?: string;
          token?: { id?: string; symbol?: string; blockchain?: string };
        }>;
      }>(`/v1/w3s/wallets/${walletId}/balances`);
      const hit = (bal?.tokenBalances ?? []).find(
        (b) => ((b.token?.symbol ?? b.symbol) ?? "").toUpperCase() === currency
      );
      const id = hit?.token?.id ?? hit?.id;
      if (id) return id;
    } catch {
      // Fall through to the token-list endpoint below.
    }
  }
  const now = Date.now();
  if (!cachedTokens || now - cachedTokens.at > 10 * 60_000) {
    try {
      await refreshTokenList();
    } catch {
      // Tolerated; the error below reports the missing token.
    }
  }
  const hit = (cachedTokens?.tokens ?? []).find((t) => t.symbol === currency && t.blockchain === want);
  if (!hit) {
    throw new FundingHttpError(
      502,
      "token_not_found",
      `No ${currency} token contract found for chain ${blockchain} in Circle's token list.`
    );
  }
  return hit.id;
}

// ============================================================================
// 7. TRANSFERS (user wallet -> treasury) + LEDGER
// ============================================================================

interface CircleTransfer {
  id: string;
  state: string;
  txHash?: string;
}

function validateAmount(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d+(\.\d{1,6})?$/.test(raw.trim())) {
    throw new FundingHttpError(400, "invalid_amount", "amount must be a positive decimal string with at most 6 decimals, e.g. \"1.50\".");
  }
  const n = Number(raw);
  if (!(n > 0)) throw new FundingHttpError(400, "invalid_amount", "amount must be greater than zero.");
  // Normalize: strip trailing zeros for Circle ("1.50" -> "1.5").
  return String(n);
}

/**
 * Add two decimal strings without float error (stablecoin 6dp scale).
 * Used to total ledger amounts in JS when SQL didn't already aggregate.
 */
export function addDecimalStrings(a: string, b: string): string {
  const SCALE = 1_000_000;
  const toInt = (s: string): bigint => {
    const [whole, frac = ""] = s.trim().split(".");
    const fracPadded = (frac + "000000").slice(0, 6);
    const neg = whole.startsWith("-");
    const w = BigInt((neg ? whole.slice(1) : whole) || "0");
    const f = BigInt(fracPadded);
    const v = w * BigInt(SCALE) + f;
    return neg ? -v : v;
  };
  const total = toInt(a) + toInt(b);
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const whole = abs / BigInt(SCALE);
  const frac = String(abs % BigInt(SCALE)).padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/**
 * Sweep stablecoins from a user's wallet to the Phase treasury on the same
 * chain. Idempotent on the caller's idempotencyKey: repeats return the
 * original ledger entry without creating a second Circle transfer.
 */
export async function sweepToTreasury(opts: {
  userId: string;
  amount: string;
  chain?: string;
  currency?: string;
  idempotencyKey?: string;
}): Promise<{ entry: LedgerEntry; created: boolean }> {
  // Validate caller input before touching any credentials or the network.
  const amount = validateAmount(opts.amount);
  const chain = resolveChain(opts.chain);
  const currency = resolveCurrency(opts.currency, chain);
  requireCircleReady();

  if (opts.idempotencyKey) {
    const prior = await dbGetLedgerEntryByIdempotency(opts.idempotencyKey);
    if (prior) return { entry: prior, created: false };
  }

  const { record } = await getOrCreateUserWallets(opts.userId);
  const from = record.wallets.find((w) => w.blockchain === chain);
  if (!from) {
    throw new FundingHttpError(500, "user_wallet_missing_chain", `User wallet for chain ${chain} not found.`);
  }
  const treasury = await getOrCreateTreasuryWallet(chain);
  const tokenId = await resolveTokenId(chain, currency, from.walletId);
  const idempotencyKey = opts.idempotencyKey ?? randomUUID();

  let entry = await dbAddLedgerEntry({
    kind: "sweep",
    userId: opts.userId,
    chain,
    amount,
    currency,
    walletId: from.walletId,
    address: from.address,
    circleTransferId: null,
    txHash: null,
    status: "pending",
    confirmations: 0,
    requiredConfirmations: requiredConfirmations(),
    idempotencyKey,
    network: fundingNetwork(),
    verified: false, // flips true once Circle confirms (verified webhook or API poll)
    note: null,
  });

  try {
    const tx = await circleRequest<CircleTransfer>("/v1/w3s/developer/transactions/transfer", {
      method: "POST",
      body: {
        idempotencyKey: randomUUID(), // Circle-level key: fresh per attempt
        entitySecretCiphertext: await entitySecretCiphertext(),
        walletId: from.walletId,
        destinationAddress: treasury.address,
        amounts: [amount],
        tokenId,
        feeLevel: "MEDIUM",
      },
    });
    entry = await dbTouchLedger(entry, {
      circleTransferId: tx.id,
      status: tx.state === "COMPLETE" ? "confirmed" : "pending",
      verified: tx.state === "COMPLETE",
      txHash: tx.txHash ?? null,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    entry = await dbTouchLedger(entry, { status: "failed", note: `circle_transfer_failed: ${reason}` });
  }
  return { entry, created: true };
}

/** Poll Circle for the latest state of a transfer; marks verified=true (direct authenticated read). */
export async function refreshTransferFromCircle(ledgerId: string): Promise<LedgerEntry | null> {
  let entry = await dbGetLedgerEntry(ledgerId);
  if (!entry) return null;
  if (!entry.circleTransferId) return entry;
  try {
    // Circle nests the lookup as data.transaction; be tolerant of a flat shape too.
    const tx = await circleRequest<CircleTransfer & { transaction?: CircleTransfer }>(
      `/v1/w3s/transactions/${entry.circleTransferId}`
    );
    const t = tx.transaction ?? tx;
    const state = (t.state ?? "").toUpperCase();
    if (state === "COMPLETE" || state === "CONFIRMED") {
      entry = await dbTouchLedger(entry, { status: "confirmed", verified: true, txHash: t.txHash ?? entry.txHash });
    } else if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
      entry = await dbTouchLedger(entry, { status: "failed", verified: true, note: `circle_state=${t.state}` });
    } else {
      entry = await dbTouchLedger(entry, { status: "confirming", verified: true, txHash: t.txHash ?? entry.txHash });
    }
  } catch (err) {
    entry = await dbTouchLedger(entry, { note: `refresh_failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return entry;
}

// ============================================================================
// 8. WEBHOOK VERIFICATION + HANDLER
// ============================================================================

interface CircleWebhookPayload {
  subscriptionId?: string;
  notificationId?: string;
  notificationType?: string;
  timestamp?: string;
  version?: number;
  notification?: {
    id?: string;
    blockchain?: string;
    walletId?: string;
    tokenId?: string;
    destinationAddress?: string;
    sourceAddress?: string;
    amounts?: string[];
    state?: string;
    status?: string;
    txHash?: string;
    confirmations?: number;
    errorReason?: string;
    transactionType?: string;
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** HMAC-SHA256 path (legacy W3S scheme): signature over raw body. */
function verifyHmacSignature(rawBody: Buffer, signature: string): boolean {
  const secret = (process.env.CIRCLE_WEBHOOK_SECRET ?? "").trim() || apiKey() || "";
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = /^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0
      ? Buffer.from(signature, "hex")
      : Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Fetch + cache Circle's ECDSA notification public key for a keyId. */
async function getWebhookPublicKey(keyId: string): Promise<string> {
  const cached = webhookPubkeyCache.get(keyId);
  if (cached) return cached;
  const template =
    (process.env.CIRCLE_WEBHOOK_PUBKEY_URL ?? "https://api.circle.com/v2/notifications/publicKey/{keyId}").trim();
  const url = template.replace("{keyId}", encodeURIComponent(keyId));
  // Circle's notification public-key endpoint requires API authentication.
  // Without the Bearer token it returns 401/403, which used to surface as a
  // webhook 401 ("bad signature") and blocked console activation tests.
  const bearer = apiKey();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  if (!res.ok) throw new Error(`webhook pubkey fetch failed: ${res.status}`);
  const data = (await res.json()) as { publicKey?: unknown; data?: { publicKey?: unknown } };
  const b64 = typeof data.publicKey === "string" ? data.publicKey : (data.data?.publicKey as string | undefined);
  if (!b64 || typeof b64 !== "string") throw new Error("webhook pubkey missing in response");
  webhookPubkeyCache.set(keyId, b64);
  return b64;
}

/** ECDSA-SHA256 path (current Circle scheme): X-Circle-Signature + X-Circle-Key-Id. */
async function verifyEcdsaSignature(rawBody: Buffer, signatureB64: string, keyId: string): Promise<boolean> {
  try {
    const pubKeyB64 = await getWebhookPublicKey(keyId);
    const key = decodeCirclePublicKey(pubKeyB64);
    const sig = Buffer.from(signatureB64, "base64");
    // Try DER encoding first, then raw IEEE-P1363 (R||S), per provider variance.
    for (const dsaEncoding of ["der", "ieee-p1363"] as const) {
      try {
        const v = createVerify("sha256");
        v.update(rawBody);
        if (v.verify({ key, dsaEncoding }, sig)) return true;
      } catch {
        /* try next encoding */
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface WebhookResult {
  verified: boolean;
  scheme: "ecdsa" | "hmac" | "none";
  notificationId: string | null;
  notificationType: string | null;
  action: string;
}

/**
 * Verify + apply a Circle webhook. Unverifiable payloads are REJECTED (the
 * route returns 401) — the ledger is never touched by them. Returns a
 * WebhookResult describing what happened.
 */
export async function handleCircleWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer | undefined,
  parsed: CircleWebhookPayload
): Promise<WebhookResult> {
  if (!rawBody || rawBody.length === 0) {
    throw new FundingHttpError(400, "webhook_no_raw_body", "Raw request body is required for signature verification.");
  }
  const signature = headerValue(headers, "x-circle-signature");
  const keyId = headerValue(headers, "x-circle-key-id");
  if (!signature) {
    throw new FundingHttpError(401, "webhook_missing_signature", "Missing X-Circle-Signature header.");
  }

  let verified = false;
  let scheme: WebhookResult["scheme"] = "none";
  if (keyId) {
    verified = await verifyEcdsaSignature(rawBody, signature, keyId);
    scheme = "ecdsa";
  } else {
    verified = verifyHmacSignature(rawBody, signature);
    scheme = "hmac";
  }
  if (!verified) {
    throw new FundingHttpError(
      401,
      "webhook_bad_signature",
      `Circle webhook signature could not be verified (scheme attempted: ${scheme}). Ledger untouched.`
    );
  }

  const notificationId = parsed.notificationId ?? null;
  const notificationType = parsed.notificationType ?? null;
  if (notificationId) {
    // Atomic dedup: INSERT ... ON CONFLICT DO NOTHING tells us whether
    // this notification was already processed.
    const fresh = await dbMarkWebhookSeen(notificationId);
    if (!fresh) {
      return { verified: true, scheme, notificationId, notificationType, action: "duplicate_ignored" };
    }
  }

  const n = parsed.notification ?? {};
  const type = (notificationType ?? "").toLowerCase();
  let action = "no_matching_ledger_entry";

  // Outbound / transfer state updates -> advance sweep entries.
  const circleTxId = n.id ?? null;
  if (circleTxId) {
    const entry = await dbGetLedgerEntryByCircleTransfer(circleTxId);
    if (entry) {
      const state = (n.state ?? n.status ?? "").toUpperCase();
      if (state === "COMPLETE" || state === "CONFIRMED") {
        await dbTouchLedger(entry, {
          status: "confirmed",
          verified: true,
          txHash: n.txHash ?? entry.txHash,
          confirmations: n.confirmations ?? entry.requiredConfirmations,
        });
        action = "sweep_confirmed";
      } else if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
        await dbTouchLedger(entry, { status: "failed", verified: true, note: `webhook_state=${n.state ?? n.status}` });
        action = "sweep_failed";
      } else {
        await dbTouchLedger(entry, {
          status: "confirming",
          verified: true,
          txHash: n.txHash ?? entry.txHash,
          confirmations: n.confirmations ?? entry.confirmations,
        });
        action = "sweep_status_updated";
      }
    }
  }

  // Inbound deposits to a user wallet -> record/confirm a deposit entry.
  if (type.includes("inbound") && n.destinationAddress) {
    const dest = n.destinationAddress.toLowerCase();
    for (const rec of await dbListUserWalletRecords()) {
      const wallet = rec.wallets.find((w) => w.address.toLowerCase() === dest);
      if (!wallet) continue;
      const amount = n.amounts?.[0] ?? "0";
      const confirmations = n.confirmations ?? 0;
      // Resolve the deposited token from the notification's tokenId. An
      // unresolvable or unsupported token is recorded as UNKNOWN and is NOT
      // credited to the funding balance (fail closed; manual review).
      let currency: FundingCurrency | "UNKNOWN" = "UNKNOWN";
      let currencyNote = "tokenId absent in Circle notification; token not identified";
      if (n.tokenId) {
        let symbol: string | null = null;
        try {
          symbol = await resolveTokenSymbol(n.tokenId, n.blockchain, n.walletId);
        } catch {
          symbol = null;
        }
        if (symbol === "USDC" || symbol === "USDT") {
          currency = symbol;
          currencyNote = `token ${symbol} resolved from Circle tokenId`;
        } else {
          currencyNote = `unresolved/unsupported token (tokenId ${n.tokenId}); not credited`;
        }
      }
      const chainComplete = (n.state ?? "").toUpperCase() === "COMPLETE" || confirmations >= requiredConfirmations();
      // UNKNOWN-currency deposits are never auto-confirmed: hold for review.
      const confirmed = chainComplete && currency !== "UNKNOWN";
      // Match an existing pending deposit for the same tx, else create one.
      const existing = circleTxId ? await dbGetLedgerEntryByCircleTransfer(circleTxId) : null;
      const note = `inbound from ${n.sourceAddress ?? "unknown"}; ${currencyNote}`;
      if (existing) {
        await dbTouchLedger(existing, {
          status: confirmed ? "confirmed" : "confirming",
          verified: true,
          txHash: n.txHash ?? existing.txHash,
          confirmations,
          // A later notification carrying tokenId can correct an earlier
          // UNKNOWN classification; never downgrade a known currency.
          currency: currency === "UNKNOWN" ? existing.currency : currency,
          note,
        });
      } else {
        await dbAddLedgerEntry({
          kind: "deposit",
          userId: rec.userId,
          chain: wallet.blockchain,
          amount,
          currency,
          walletId: wallet.walletId,
          address: wallet.address,
          circleTransferId: circleTxId,
          txHash: n.txHash ?? null,
          status: confirmed ? "confirmed" : "confirming",
          confirmations,
          requiredConfirmations: requiredConfirmations(),
          idempotencyKey: notificationId ?? randomUUID(),
          network: fundingNetwork(),
          verified: true, // signature-verified webhook
          note,
        });
      }
      action = confirmed ? "deposit_confirmed" : "deposit_confirming";
      break;
    }
  }

  return { verified: true, scheme, notificationId, notificationType, action };
}

// ============================================================================
// 9. ROUTES (mounted into phase-backend.ts)
// ============================================================================

export interface FundingMountDeps {
  route: (method: string, path: string, handler: RouteHandler) => void;
  sendJson: (res: RouteContext["res"], statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new FundingHttpError(400, "invalid_json_body", "Request body must be a JSON object.");
}

function requireUserId(query: URLSearchParams, body?: Record<string, unknown>): string {
  const v = query.get("userId") ?? (typeof body?.userId === "string" ? body.userId : null);
  if (!v || !v.trim()) throw new FundingHttpError(400, "missing_user_id", "userId is required (query param or JSON body).");
  return v.trim();
}

function toHttpError(err: unknown, HttpError: FundingMountDeps["HttpError"]): Error {
  if (err instanceof FundingHttpError) return new HttpError(err.statusCode, err.code, err.message);
  if (err instanceof CircleApiError) {
    const status = err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
    return new HttpError(status, "circle_api_error", err.message);
  }
  return err instanceof Error ? err : new HttpError(500, "internal_error", String(err));
}

export function mountFundingRoutes(deps: FundingMountDeps): void {
  const { route, sendJson, HttpError } = deps;

  const fail = (ctx: RouteContext, err: unknown): void => {
    const e = toHttpError(err, HttpError);
    const statusCode = (e as { statusCode?: number }).statusCode ?? 500;
    const code = (e as { code?: number }).code ?? "internal_error";
    sendJson(ctx.res, statusCode, { ...networkEnvelope(), error: code, message: e.message });
  };

  /**
   * On-chain stablecoin balances for one Circle wallet: symbol -> amount
   * string. Returns an empty object (never throws) when Circle is
   * unreachable, so one flaky wallet can't fail a whole response.
   */
  const fetchWalletBalances = async (walletId: string): Promise<Record<string, string>> => {
    try {
      const data = await circleRequest<{
        tokenBalances?: Array<{ symbol?: string; amount?: string; token?: { symbol?: string } }>;
      }>(`/v1/w3s/wallets/${walletId}/balances`);
      const out: Record<string, string> = {};
      for (const b of data?.tokenBalances ?? []) {
        // Circle nests the symbol under token.symbol on this endpoint.
        const sym = ((b.token?.symbol ?? b.symbol) ?? "").toUpperCase();
        if (sym && b.amount !== undefined) out[sym] = b.amount;
      }
      return out;
    } catch {
      return {};
    }
  };

  // --- POST /api/v1/funding/wallets — create (or fetch) a user's wallets ---
  route("POST", "/api/v1/funding/wallets", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = requireUserId(ctx.query, body);
      const { record, created } = await getOrCreateUserWallets(userId);
      sendJson(ctx.res, created ? 201 : 200, {
        ...networkEnvelope(),
        userId,
        created,
        walletSetId: record.walletSetId,
        wallets: record.wallets.map((w) => ({
          ...w,
          supportedCurrencies: currenciesForChain(w.blockchain),
        })),
        note: "Phase accounts fund with crypto only. Send USDC or USDT on a listed chain to the matching address. USDT is EVM chains only.",
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/funding/deposit-address?userId=&chain= ---
  route("GET", "/api/v1/funding/deposit-address", async (ctx) => {
    try {
      const userId = requireUserId(ctx.query);
      const defaultChain = resolveChain(ctx.query.get("chain")); // validate before any Circle call
      const currency = resolveCurrency(ctx.query.get("currency"), defaultChain);
      const { record } = await getOrCreateUserWallets(userId);
      const addresses: Record<string, string> = {};
      for (const w of record.wallets) addresses[w.blockchain] = w.address;

      // Best-effort per-currency balances; null per currency when Circle is
      // unreachable for a wallet.
      const balances: Record<string, Record<string, string | null>> = {};
      await Promise.all(
        record.wallets.map(async (w) => {
          const supported = currenciesForChain(w.blockchain);
          const onchain = await fetchWalletBalances(w.walletId);
          const reachable = Object.keys(onchain).length > 0;
          const per: Record<string, string | null> = {};
          for (const c of supported) per[c] = onchain[c] ?? (reachable ? "0" : null);
          balances[w.blockchain] = per;
        })
      );

      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        currency,
        supportedCurrencies: currenciesForChain(defaultChain),
        defaultChain,
        defaultAddress: addresses[defaultChain],
        addresses,
        balances,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- POST /api/v1/funding/transfer — sweep user wallet -> treasury ---
  route("GET", "/api/v1/funding/balances", async (ctx) => {
    try {
      const userId = requireUserId(ctx.query);
      const { record } = await getOrCreateUserWallets(userId);

      const chains = await Promise.all(
        record.wallets.map(async (w) => {
          const supported = currenciesForChain(w.blockchain);
          const onchain = await fetchWalletBalances(w.walletId);
          const reachable = Object.keys(onchain).length > 0;
          const per: Record<string, string | null> = {};
          for (const c of supported) per[c] = onchain[c] ?? (reachable ? "0" : null);
          return {
            chain: w.blockchain,
            address: w.address,
            supportedCurrencies: supported,
            onchainBalances: per,
          };
        })
      );

      const summaryRows = await dbQuery<{ currency: string; status: string; verified: boolean; total: string }>(
        `SELECT currency, status, verified, SUM(amount::numeric)::text AS total
         FROM ledger_entries
         WHERE user_id = $1 AND kind = 'deposit' AND currency IN ('USDC', 'USDT')
         GROUP BY currency, status, verified`,
        [userId]
      );
      const totals: Record<string, { credited: string; pending: string }> = {
        USDC: { credited: "0", pending: "0" },
        USDT: { credited: "0", pending: "0" },
      };
      for (const r of summaryRows) {
        const bucket = totals[r.currency];
        if (!bucket) continue;
        if (r.status === "confirmed" && r.verified) {
          bucket.credited = addDecimalStrings(bucket.credited, r.total);
        } else if (r.status === "pending" || r.status === "confirming") {
          bucket.pending = addDecimalStrings(bucket.pending, r.total);
        }
      }

      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        totals,
        chains,
        note: "credited = verified + confirmed deposits only. pending = deposits seen but not yet confirmed on-chain. UNKNOWN-currency sightings never credit.",
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  route("POST", "/api/v1/funding/transfer", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = requireUserId(ctx.query, body);
      const amount = body.amount;
      const chain = typeof body.chain === "string" ? body.chain : undefined;
      const currency = typeof body.currency === "string" ? body.currency : undefined;
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
      const { entry, created } = await sweepToTreasury({
        userId,
        amount: amount as string,
        chain,
        currency,
        idempotencyKey,
      });
      sendJson(ctx.res, created ? 201 : 200, {
        ...networkEnvelope(),
        created,
        idempotentReplay: !created,
        ledger: entry,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- POST /api/v1/funding/webhooks — Circle notifications ---
  route("POST", "/api/v1/funding/webhooks", async (ctx) => {
    try {
      const rawBody: Buffer | undefined = (ctx as { rawBody?: Buffer }).rawBody;
      const parsed = (ctx.body ?? {}) as CircleWebhookPayload;
      const headers = (ctx.req.headers ?? {}) as Record<string, string | string[] | undefined>;
      const result = await handleCircleWebhook(headers, rawBody, parsed);
      sendJson(ctx.res, 200, { ...networkEnvelope(), received: true, ...result });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // Circle validates webhook endpoints with a HEAD request on subscribe.
  route("HEAD", "/api/v1/funding/webhooks", async (ctx) => {
    sendJson(ctx.res, 200, { ...networkEnvelope(), ok: true });
  });

  // --- GET /api/v1/funding/ledger?userId=&refresh=true ---
  route("GET", "/api/v1/funding/ledger", async (ctx) => {
    try {
      const userId = requireUserId(ctx.query);
      const refresh = ctx.query.get("refresh") === "true";
      let entries = await dbListLedgerEntriesByUser(userId);
      if (refresh) {
        // Direct authenticated Circle reads count as verified.
        await Promise.all(
          entries
            .filter((e) => e.status === "pending" || e.status === "confirming")
            .map((e) => refreshTransferFromCircle(e.id).catch(() => null))
        );
        entries = await dbListLedgerEntriesByUser(userId);
      }
      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        entries,
        note: "Entries with verified:false were learned from unverified sources or are still awaiting confirmation.",
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- POST /api/v1/funding/deposit-address — one address for a currency ---
  // Body: { userId, currency: "USDC"|"USDT", chain? }. Circle wallets are one
  // address per chain, so the currency picks a compatible chain when `chain`
  // is omitted. Testnet only until the mainnet unlock.
  route("POST", "/api/v1/funding/deposit-address", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = requireUserId(ctx.query, body);
      const chain = resolveChain(
        typeof body.chain === "string" && body.chain ? body.chain : null
      );
      const currency = resolveCurrency(
        typeof body.currency === "string" ? body.currency : undefined,
        chain
      );
      const { record, created } = await getOrCreateUserWallets(userId);
      const wallet = record.wallets.find((w) => w.blockchain === chain);
      if (!wallet) {
        throw new FundingHttpError(
          500,
          "wallet_missing",
          `No wallet on chain ${chain} for this user.`
        );
      }
      sendJson(ctx.res, created ? 201 : 200, {
        ...networkEnvelope(),
        userId,
        currency,
        chain,
        address: wallet.address,
        walletId: wallet.walletId,
        supportedCurrencies: currenciesForChain(chain),
        note: `Send ${currency} on ${chain} to this address. Minimum confirmations before credit: ${requiredConfirmations()}.`,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // --- GET /api/v1/funding/deposits?userId= — deposit history ---
  // Deposits only (kind='deposit'); sweeps live under /api/v1/funding/ledger.
  route("GET", "/api/v1/funding/deposits", async (ctx) => {
    try {
      const userId = requireUserId(ctx.query);
      const entries = (await dbListLedgerEntriesByUser(userId)).filter(
        (e) => e.kind === "deposit"
      );
      const deposits = entries.map((e) => ({
        id: e.id,
        currency: e.currency,
        amount: e.amount,
        chain: e.chain,
        address: e.address,
        txHash: e.txHash,
        status: e.status,
        verified: e.verified,
        confirmations: e.confirmations,
        requiredConfirmations: e.requiredConfirmations,
        createdAt: e.createdAt,
      }));
      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        deposits,
        note: "Only verified+confirmed deposits are credited to the account balance.",
      });
    } catch (err) {
      fail(ctx, err);
    }
  });
}
