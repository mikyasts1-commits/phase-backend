/**
 * solana-mint.ts — Phase backend Solana devnet coin minter.
 *
 * DEVNET ONLY. There is no mainnet code path in this module:
 *  - The RPC endpoint is a hardcoded devnet constant.
 *  - If the SOLANA_NETWORK env var is set to anything other than "devnet",
 *    every entry point throws. (Unset defaults to devnet.)
 *  - Any URL containing "mainnet" (case-insensitive) is refused.
 *
 * The mint-authority keypair is persisted at .secrets/solana-mint-authority.json
 * (JSON array of the 64 secret-key bytes, chmod 600). Secret bytes are never
 * logged or printed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

export interface CreateCoinMintOptions {
  name: string;
  ticker: string;
  description?: string;
}

export interface CoinMintResult {
  mintAddress: string; // base58 SPL mint address
  txSignature: string; // base58 transaction signature of the mintTo
  supply: string; // "1000000" (human units)
  decimals: number; // 6
  authorityAddress: string;
}

/** Hardcoded devnet RPC endpoint. Never point this at mainnet. */
const DEVNET_RPC_URL = "https://api.devnet.solana.com";

/** SPL token decimals used for every Phase coin. */
const COIN_DECIMALS = 6;

/** Whole-unit supply minted for each new coin. */
const COIN_SUPPLY_WHOLE_UNITS = 1_000_000n;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// File path override for deploys (Render persistent disk, etc.).
const AUTHORITY_KEYPAIR_PATH =
  (process.env.SOLANA_MINT_AUTHORITY_PATH ?? "").trim() ||
  path.join(MODULE_DIR, ".secrets", "solana-mint-authority.json");

/** Refuse any mainnet endpoint. */
function assertDevnetOnlyUrl(url: string): void {
  if (typeof url === "string" && url.toLowerCase().includes("mainnet")) {
    throw new Error(
      "[solana-mint] Refused: mainnet endpoint forbidden. This module is devnet-only."
    );
  }
}

/** Refuse to run when SOLANA_NETWORK names anything but devnet. */
function assertDevnetNetworkEnv(): void {
  const raw = process.env.SOLANA_NETWORK;
  if (raw === undefined || raw === null || raw.trim() === "") return; // unset -> devnet default
  if (raw.trim().toLowerCase() !== "devnet") {
    throw new Error(
      `[solana-mint] Refused: SOLANA_NETWORK="${raw}" is not allowed. ` +
        `This module is devnet-only (use SOLANA_NETWORK=devnet or leave it unset).`
    );
  }
}

// Enforce the network guard at import time as well as per call.
assertDevnetNetworkEnv();

export function getDevnetRpcUrl(): string {
  assertDevnetOnlyUrl(DEVNET_RPC_URL);
  return DEVNET_RPC_URL;
}

function getConnection(): Connection {
  assertDevnetNetworkEnv();
  return new Connection(getDevnetRpcUrl(), "confirmed");
}

/**
 * Load the persisted mint-authority keypair. Precedence:
 *   1. SOLANA_MINT_AUTHORITY_JSON env var (JSON array, for hosted deploys)
 *   2. AUTHORITY_KEYPAIR_PATH file (SOLANA_MINT_AUTHORITY_PATH or .secrets/)
 *   3. Generate + persist a fresh keypair (chmod 600) — dev only.
 */
async function loadOrCreateAuthority(): Promise<Keypair> {
  const fromEnv = (process.env.SOLANA_MINT_AUTHORITY_JSON ?? "").trim();
  if (fromEnv) {
    const parsed: unknown = JSON.parse(fromEnv);
    if (!Array.isArray(parsed)) {
      throw new Error("[solana-mint] SOLANA_MINT_AUTHORITY_JSON is not a JSON array");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  try {
    const raw = await fs.readFile(AUTHORITY_KEYPAIR_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `[solana-mint] Keypair file is corrupt (not a JSON array): ${AUTHORITY_KEYPAIR_PATH}`
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    const kp = Keypair.generate();
    await fs.mkdir(path.dirname(AUTHORITY_KEYPAIR_PATH), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      AUTHORITY_KEYPAIR_PATH,
      JSON.stringify(Array.from(kp.secretKey)),
      { mode: 0o600 }
    );
    await fs.chmod(AUTHORITY_KEYPAIR_PATH, 0o600);
    return kp;
  }
}

let cachedAuthority: Keypair | null = null;

async function getAuthority(): Promise<Keypair> {
  if (!cachedAuthority) cachedAuthority = await loadOrCreateAuthority();
  return cachedAuthority;
}

export async function getMintAuthorityAddress(): Promise<string> {
  assertDevnetNetworkEnv();
  return (await getAuthority()).publicKey.toBase58();
}

function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw new Error("[solana-mint] name must be a string");
  }
  const n = name.trim();
  if (n.length < 1 || n.length > 60) {
    throw new Error("[solana-mint] name must be 1-60 characters");
  }
  return n;
}

function validateTicker(ticker: unknown): string {
  if (typeof ticker !== "string") {
    throw new Error("[solana-mint] ticker must be a string");
  }
  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(t)) {
    throw new Error("[solana-mint] ticker must be 2-10 chars, A-Z0-9 only");
  }
  return t;
}

export async function createCoinMint(
  opts: CreateCoinMintOptions
): Promise<CoinMintResult> {
  assertDevnetNetworkEnv();
  const name = validateName(opts?.name);
  const ticker = validateTicker(opts?.ticker);
  void name;
  void ticker;
  // Note: `description` is accepted for API compatibility but is not stored
  // on-chain — a plain SPL Token program mint carries no name/ticker metadata.

  const connection = getConnection();
  const authority = await getAuthority();

  // 1. Create the SPL token mint (6 decimals); mint authority = backend authority.
  const mint = await createMint(
    connection,
    authority,
    authority.publicKey,
    null, // no freeze authority
    COIN_DECIMALS
  );

  // 2. Associated token account for the authority (receives the minted supply).
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    authority.publicKey
  );

  // 3. Mint exactly 1,000,000 whole units.
  const baseUnits = COIN_SUPPLY_WHOLE_UNITS * 10n ** BigInt(COIN_DECIMALS);
  const txSignature = await mintTo(
    connection,
    authority,
    mint,
    ata.address,
    authority,
    baseUnits
  );

  return {
    mintAddress: mint.toBase58(),
    txSignature,
    supply: COIN_SUPPLY_WHOLE_UNITS.toString(),
    decimals: COIN_DECIMALS,
    authorityAddress: authority.publicKey.toBase58(),
  };
}
