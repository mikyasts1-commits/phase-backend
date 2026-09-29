/**
 * btc-funding.ts — Bitcoin (testnet) funding rail for Phase.
 *
 * Circle doesn't support Bitcoin, so this is a standalone rail alongside
 * the Circle stablecoin module (crypto-funding.ts):
 *
 * - Each user gets a deterministic BTC testnet (or mainnet) address derived
 *   from HMAC-SHA256(userId, BTC_SEED_SECRET). Same user → same address,
 *   no database needed, key recoverable from the seed.
 * - Balances monitored via the free Blockstream Esplora API
 *   (https://blockstream.info/testnet/api). No API key, no account.
 * - TESTNET ONLY unless BTC_MAINNET=true + BTC_MAINNET_CONFIRM=YES.
 *
 * Endpoints (mounted by phase-backend.ts):
 * - GET /api/v1/funding/btc/address?userId=   → deposit address
 * - GET /api/v1/funding/btc/balance?userId=   → confirmed + mempool balance
 *
 * For mainnet use, replace the single-key derivation with proper HD wallet
 * (BIP32/BIP84) derivation and a custody solution. This module is NOT
 * mainnet-custody-grade.
 */

import { createHmac } from "node:crypto";
import { resolveBearerUserId } from "./auth.js";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";

const ECPair = ECPairFactory(ecc);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isMainnetUnlocked(): boolean {
  return process.env.BTC_MAINNET === "true" && process.env.BTC_MAINNET_CONFIRM === "YES";
}

function btcNetwork() {
  return isMainnetUnlocked() ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

function esploraBase(): string {
  return isMainnetUnlocked()
    ? "https://blockstream.info/api"
    : "https://blockstream.info/testnet/api";
}

function seedSecret(): string {
  const s = process.env.BTC_SEED_SECRET || "";
  if (!s) {
    console.warn("[btc] BTC_SEED_SECRET not set — using insecure dev fallback. Set it in production.");
  }
  return s || "phase-dev-btc-seed-do-not-use-in-prod";
}

function networkEnvelope() {
  const testnet = !isMainnetUnlocked();
  return {
    network: testnet ? "testnet" : "mainnet",
    testnet,
    currency: "BTC",
    fundsNotice: testnet
      ? "TESTNET — FAKE FUNDS. This BTC has no monetary value."
      : "MAINNET — real bitcoin.",
  };
}

// ---------------------------------------------------------------------------
// Address derivation — deterministic per userId
// ---------------------------------------------------------------------------

/** Derive a P2WPKH (bech32) address for a userId. Same input → same address. */
export function btcAddressForUser(userId: string): { address: string; network: string } {
  const network = btcNetwork();
  // HMAC-SHA256 gives us 32 bytes — a valid secp256k1 private key (overwhelmingly likely < n)
  const privKey = createHmac("sha256", seedSecret()).update(`btc-deposit:${userId}`).digest();
  const keyPair = ECPair.fromPrivateKey(privKey, { network });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
  if (!address) throw new Error("Failed to derive BTC address");
  return { address, network: isMainnetUnlocked() ? "mainnet" : "testnet" };
}

// ---------------------------------------------------------------------------
// Blockstream Esplora API (no key needed)
// ---------------------------------------------------------------------------

async function esplora<T>(path: string): Promise<T> {
  const res = await fetch(`${esploraBase()}${path}`, {
    headers: { "User-Agent": "phase-backend/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Esplora ${res.status} on ${path}`);
  return (await res.json()) as T;
}

export interface BtcBalance {
  confirmedSats: number;
  mempoolSats: number;
  confirmedBtc: string;
  mempoolBtc: string;
  txCount: number;
}

export async function btcBalanceForAddress(address: string): Promise<BtcBalance> {
  const data = await esplora<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(
    `/address/${address}`
  );
  const confirmedSats = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const mempoolSats = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
  const toBtc = (sats: number) => (sats / 1e8).toFixed(8);
  return {
    confirmedSats,
    mempoolSats,
    confirmedBtc: toBtc(confirmedSats),
    mempoolBtc: toBtc(mempoolSats),
    txCount: data.chain_stats.tx_count,
  };
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

interface BtcMountDeps {
  route(method: string, path: string, handler: (ctx: any) => void | Promise<void>): void;
  sendJson(res: any, statusCode: number, body: unknown): void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

export function mountBtcRoutes(deps: BtcMountDeps): void {
  const { route, sendJson, HttpError } = deps;

  // The userId for private routes ALWAYS comes from the authenticated Bearer
  // session. A client-supplied userId in the query is never trusted: if one
  // is present and disagrees with the session, the request is rejected.
  const requireUserId = async (ctx: { req: { headers: Record<string, string | string[] | undefined> }; query: URLSearchParams }): Promise<string> => {
    const authed = await resolveBearerUserId(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    const claimed = ctx.query.get("userId");
    if (claimed && claimed !== authed) {
      throw new HttpError(403, "forbidden", "This request is for a different user.");
    }
    return authed;
  };

  // --- GET /api/v1/funding/btc/address?userId= ---
  route("GET", "/api/v1/funding/btc/address", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const { address, network } = btcAddressForUser(userId);
      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        address,
        addressType: "bech32 (P2WPKH)",
        network,
        note: "Send BTC to this address. Balances credit after 1 confirmation (testnet).",
      });
    } catch (err: any) {
      const status = err.statusCode ?? 500;
      sendJson(ctx.res, status, { ...networkEnvelope(), error: err.code ?? "internal_error", message: err.message });
    }
  });

  // --- GET /api/v1/funding/btc/balance?userId= ---
  route("GET", "/api/v1/funding/btc/balance", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const { address } = btcAddressForUser(userId);
      const balance = await btcBalanceForAddress(address);
      sendJson(ctx.res, 200, {
        ...networkEnvelope(),
        userId,
        address,
        ...balance,
        funded: balance.confirmedSats > 0 || balance.mempoolSats > 0,
      });
    } catch (err: any) {
      const status = err.statusCode ?? 500;
      sendJson(ctx.res, status, { ...networkEnvelope(), error: err.code ?? "internal_error", message: err.message });
    }
  });
}
