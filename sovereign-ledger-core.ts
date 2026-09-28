/**
 * Phase Sovereign Ledger — Backend (Phase 1 MVP)
 * ================================================
 * Implements the "Phase 1: Sovereign Ledger MVP" checklist from
 * Phase-Sovereign-Ledger-Spec.pdf (Section 17):
 *   - Chain Registry (create / get / list sovereign chains)
 *   - Ledger Engine: GENESIS, TRANSFER, MINT, BURN
 *   - Centralized sequencer producing blocks every BLOCK_INTERVAL_MS
 *   - REST API Gateway (JWT bearer auth, togglable)
 *   - Balance / transaction / block / Merkle-proof query API
 *   - In-memory mempool + store (see "Not implemented" below for the
 *     Postgres/Redis swap-in points)
 *
 * Zero dependencies — only Node built-ins (node:crypto, node:http).
 * Matches the existing phase-backend.ts pattern: one file, run with
 * `tsx phase-ledger-backend.ts`, no npm install required.
 *
 * NOT implemented here (all explicitly Phase 2/3 in the spec's own
 * roadmap, not Phase 1):
 *   - Solana anchoring (Section 10) — chain state is never posted to Solana
 *   - TRADE_OPEN / TRADE_FILL / TRADE_CANCEL + HTLC cross-chain swaps (7.5-7.6)
 *   - FREEZE / UNFREEZE (referenced in schema, semantics never specified in spec)
 *   - Phase-hosted HSM custodial wallets — callers sign their own txs client-side
 *   - WebSocket subscriptions (Section 11.4)
 *   - Postgres/Redis persistence — everything lives in process memory and
 *     is lost on restart. The `Store` class below is the seam: swap its
 *     internals for `pg`/`ioredis` calls without touching the engine or API.
 *
 * Implementation decisions the source spec left unspecified (flagged so
 * they can be revisited):
 *   - Signing payload = canonical JSON of the tx MINUS `signatures`, over
 *     {chain_id, tx_id, type, sender, nonce, payload, submitted_at}.
 *   - `signatures[0]` = { pubkey: hex(32 bytes), signature: hex(64 bytes) };
 *     single-signature only (no multisig) since no Phase-1 tx type needs it.
 *   - State-leaf hash = SHA256(`${chain_id}|${address}|${balance}|${nonce}`)
 *     (delimited string, not fixed-width binary) so it never overflows for
 *     balances near the NUMERIC(39,0) ceiling.
 *   - MINT is issuer-only + requires transfer_rules.allow_mint === true.
 *     BURN is NOT issuer-restricted — any holder burns from their own
 *     balance (the spec's BURN payload has no issuer check and no `to`).
 *   - The genesis "public float" address is a fixed reserved constant
 *     (PUBLIC_FLOAT_ADDRESS below), not a per-chain derived address — this
 *     is safe because balances are already isolated per (chain_id, address).
 *
 * Run:
 *   tsx phase-ledger-backend.ts
 *   PORT=4600 REQUIRE_AUTH=false tsx phase-ledger-backend.ts   (defaults shown)
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';

// ============================================================
// Config
// ============================================================
const PORT = process.env.PORT ? Number(process.env.PORT) : 4600;
const BLOCK_INTERVAL_MS = process.env.BLOCK_INTERVAL_MS ? Number(process.env.BLOCK_INTERVAL_MS) : 2000;
const MAX_TX_PER_BLOCK = 1000;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Reserved system addresses (see header notes above)
const PUBLIC_FLOAT_ADDRESS = 'ph1FLOAT00000000000000000000000000000';
const PLATFORM_ADDRESS = 'ph1PLATFORM0000000000000000000000000';

// ============================================================
// base58 (Bitcoin alphabet) — no external deps
// ============================================================
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

function b58encode(buf: Buffer): string {
  if (buf.length === 0) return '';
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let num = 0n;
  for (const byte of buf) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  return B58_ALPHABET[0].repeat(zeros) + out;
}

function b58decode(str: string): Buffer {
  if (str.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === B58_ALPHABET[0]) zeros++;
  let num = 0n;
  for (const ch of str) {
    const v = B58_MAP[ch];
    if (v === undefined) throw new Error('invalid base58 character: ' + ch);
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

// ============================================================
// Crypto: SHA-256, Ed25519, address derivation (spec Section 9)
// ============================================================
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function sha256(...bufs: Buffer[]): Buffer {
  const h = crypto.createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest();
}

function rawPublicKey(publicKey: crypto.KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32);
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function addressFromRaw(raw: Buffer): string {
  return 'ph1' + b58encode(raw);
}

function isValidAddress(addr: unknown): addr is string {
  if (typeof addr !== 'string' || !addr.startsWith('ph1')) return false;
  try {
    return b58decode(addr.slice(3)).length === 32;
  } catch {
    return false;
  }
}

// ============================================================
// Canonical JSON (deterministic key ordering, for signing + hashing)
// ============================================================
function canonicalize(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// ============================================================
// Merkle tree (spec Section 9.3) — binary, duplicates last leaf if odd
// ============================================================
interface ProofStep {
  hash: string; // hex
  isRight: boolean;
}

function buildMerkleTree(leaves: Buffer[]): { root: Buffer; levels: Buffer[][] } {
  if (leaves.length === 0) return { root: Buffer.alloc(32), levels: [[Buffer.alloc(32)]] };
  let level = leaves.slice();
  const levels = [level];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(left, right));
    }
    level = next;
    levels.push(level);
  }
  return { root: level[0], levels };
}

function getMerkleProof(levels: Buffer[][], index: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let idx = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const cur = levels[lvl];
    const isRightNode = idx % 2 === 1;
    const sibIndex = isRightNode ? idx - 1 : idx + 1;
    const sibling = sibIndex < cur.length ? cur[sibIndex] : cur[idx];
    proof.push({ hash: sibling.toString('hex'), isRight: !isRightNode });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyMerkleProof(leaf: Buffer, proof: ProofStep[], root: Buffer): boolean {
  let computed = leaf;
  for (const step of proof) {
    const sib = Buffer.from(step.hash, 'hex');
    computed = step.isRight ? sha256(computed, sib) : sha256(sib, computed);
  }
  return computed.equals(root);
}

// ============================================================
// Domain types (mirrors spec Sections 4, 5, 7)
// ============================================================
type TxType = 'GENESIS' | 'TRANSFER' | 'MINT' | 'BURN';
type ChainStatus = 'active' | 'paused' | 'retired';
type TxStatus = 'pending' | 'confirmed' | 'failed';

interface Tx {
  chainId: string;
  txId: string;
  type: TxType;
  sender: string;
  nonce: number;
  payload: Record<string, any>;
  signatures: { pubkey: string; signature: string }[];
  submittedAt: number;
}

interface TxRecord extends Tx {
  status: TxStatus;
  errorCode?: string;
  blockHeight?: number;
  txIndex?: number;
  confirmedAt?: number;
  // Set only by settleFloatTransfer() (platform-operated float settlement).
  // Never accepted from client input; applyTransfer() skips sender-signature
  // verification for these but keeps nonce/balance/allowlist checks.
  operatorSettled?: boolean;
}

interface ChainRecord {
  chainId: string;
  coinName: string;
  ticker: string;
  genesisHash: string;
  status: ChainStatus;
  totalSupply: bigint; // genesis (immutable, historical)
  currentSupply: bigint; // live circulating supply, moves with MINT/BURN
  decimals: number;
  equityPublicPct: number;
  equityRetainedPct: number;
  issuerAddress: string;
  transferRules: Record<string, any>;
  covenantHash: string | null;
  isMeme: boolean;
  issuanceDraftId: string | null;
  issuanceSignatureId: string | null;
  createdAt: number;
}

interface BlockRecord {
  chainId: string;
  height: number;
  prevHash: string;
  timestampMs: number;
  txRoot: string;
  stateRoot: string;
  txCount: number;
  headerHash: string;
  sequencerSig: string;
  transactions: TxRecord[];
  stateSnapshot: { address: string; balance: string; nonce: number }[];
}

class LedgerError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ============================================================
// Store — in-memory (swap point for Postgres/Redis in production;
// see spec Section 5 for the target Postgres schema, and schema.sql)
// ============================================================
class Store {
  chains = new Map<string, ChainRecord>();
  tickerIndex = new Map<string, string>(); // ticker -> chainId, active chains only
  blocksByChain = new Map<string, BlockRecord[]>();
  balances = new Map<string, Map<string, { balance: bigint; nonce: number }>>();
  txById = new Map<string, TxRecord>();
  mempoolByChain = new Map<string, TxRecord[]>();

  getBalanceEntry(chainId: string, address: string) {
    let chainBalances = this.balances.get(chainId);
    if (!chainBalances) {
      chainBalances = new Map();
      this.balances.set(chainId, chainBalances);
    }
    let entry = chainBalances.get(address);
    if (!entry) {
      entry = { balance: 0n, nonce: 0 };
      chainBalances.set(address, entry);
    }
    return entry;
  }

  getLatestBlock(chainId: string): BlockRecord | undefined {
    const blocks = this.blocksByChain.get(chainId);
    return blocks && blocks.length ? blocks[blocks.length - 1] : undefined;
  }
}

// Per-key async mutex: same pattern as an ObjectStore<T>-style keyed lock —
// operations on the SAME chain_id are serialized; different chains never
// contend (spec Section 16.2: "writes to different chains never contend").
class KeyedAsyncLock {
  private tails = new Map<string, Promise<any>>();
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prior = this.tails.get(key) || Promise.resolve();
    const result = prior.then(() => fn());
    this.tails.set(
      key,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }
}

const store = new Store();
const chainLock = new KeyedAsyncLock();
let sequencerKeys = crypto.generateKeyPairSync('ed25519');

// ============================================================
// Postgres persistence — write-through + boot load (migration 008)
// ============================================================
// The in-memory Store above stays the hot path. Every mutation persists
// the affected rows; loadLedgerFromDb() rebuilds the Store at boot so
// sovereign chains survive backend restarts (previously wiped on every
// Render restart/deploy). All helpers are no-ops when DATABASE_URL is
// unset or the 008 tables are absent (standalone mode).

let _persistPool: any = null;
let _persistReady: Promise<any> | null = null;

function persistPoolAsync(): Promise<any> {
  if (!_persistReady) {
    _persistReady = (async () => {
      try {
        const mod: any = await import('./db.js');
        const pool = mod.getPool();
        await pool.query('SELECT 1');
        const t = await pool.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'sovereign_chains'"
        );
        if (t.rowCount === 0) return null;
        _persistPool = pool;
        return pool;
      } catch {
        return null;
      }
    })();
  }
  return _persistReady;
}

function persistLog(err: unknown, what: string) {
  console.error(`[ledger-persist] ${what}:`, err instanceof Error ? err.message : String(err));
}

async function persistChainRow(chainId: string): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  const c = store.chains.get(chainId);
  if (!c) return;
  try {
    await pool.query(
      `INSERT INTO sovereign_chains (chain_id, coin_name, ticker, genesis_hash, status,
        total_supply, current_supply, decimals, equity_public_pct, equity_retained_pct,
        issuer_address, transfer_rules, covenant_hash, is_meme,
        issuance_draft_id, issuance_signature_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (chain_id) DO UPDATE SET
         genesis_hash = EXCLUDED.genesis_hash, status = EXCLUDED.status,
         current_supply = EXCLUDED.current_supply,
         transfer_rules = EXCLUDED.transfer_rules, covenant_hash = EXCLUDED.covenant_hash`,
      [c.chainId, c.coinName, c.ticker, c.genesisHash, c.status,
        c.totalSupply.toString(), c.currentSupply.toString(), c.decimals,
        c.equityPublicPct, c.equityRetainedPct, c.issuerAddress,
        JSON.stringify(c.transferRules ?? {}), c.covenantHash, c.isMeme,
        c.issuanceDraftId, c.issuanceSignatureId,
        new Date(c.createdAt).toISOString()]
    );
  } catch (e) { persistLog(e, 'persistChainRow'); }
}

async function persistBlockRow(block: BlockRecord): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sovereign_blocks (chain_id, height, prev_hash, timestamp_ms, tx_root,
        state_root, tx_count, header_hash, sequencer_sig, transactions, state_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
       ON CONFLICT (chain_id, height) DO NOTHING`,
      [block.chainId, block.height, block.prevHash, block.timestampMs, block.txRoot,
        block.stateRoot, block.txCount, block.headerHash, block.sequencerSig,
        JSON.stringify(block.transactions), JSON.stringify(block.stateSnapshot)]
    );
  } catch (e) { persistLog(e, 'persistBlockRow'); }
}

async function persistBalances(chainId: string): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  const entries = store.balances.get(chainId);
  if (!entries || entries.size === 0) return;
  try {
    const addrs = [...entries.keys()];
    const bals = addrs.map((a) => entries.get(a)!.balance.toString());
    const nonces = addrs.map((a) => entries.get(a)!.nonce);
    await pool.query(
      `INSERT INTO sovereign_balances (chain_id, address, balance, nonce)
       SELECT $1, u.addr, u.bal::numeric, u.nonce
       FROM unnest($2::text[], $3::text[], $4::int[]) AS u(addr, bal, nonce)
       ON CONFLICT (chain_id, address) DO UPDATE SET
         balance = EXCLUDED.balance, nonce = EXCLUDED.nonce`,
      [chainId, addrs, bals, nonces]
    );
  } catch (e) { persistLog(e, 'persistBalances'); }
}

async function persistTxRow(tx: TxRecord): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sovereign_txs (tx_id, chain_id, type, sender, nonce, payload, signatures,
        submitted_at, status, error_code, block_height, tx_index, confirmed_at, operator_settled)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (tx_id) DO UPDATE SET
         status = EXCLUDED.status, error_code = EXCLUDED.error_code,
         block_height = EXCLUDED.block_height, tx_index = EXCLUDED.tx_index,
         confirmed_at = EXCLUDED.confirmed_at`,
      [tx.txId, tx.chainId, tx.type, tx.sender, tx.nonce,
        JSON.stringify(tx.payload ?? {}), JSON.stringify(tx.signatures ?? []),
        tx.submittedAt, tx.status, tx.errorCode ?? null,
        tx.blockHeight ?? null, tx.txIndex ?? null, tx.confirmedAt ?? null,
        !!tx.operatorSettled]
    );
  } catch (e) { persistLog(e, 'persistTxRow'); }
}

async function persistMempoolPut(tx: TxRecord): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sovereign_mempool (tx_id, chain_id, tx) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (tx_id) DO NOTHING`,
      [tx.txId, tx.chainId, JSON.stringify(tx)]
    );
  } catch (e) { persistLog(e, 'persistMempoolPut'); }
}

async function persistMempoolDel(txId: string): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    await pool.query(`DELETE FROM sovereign_mempool WHERE tx_id = $1`, [txId]);
  } catch (e) { persistLog(e, 'persistMempoolDel'); }
}

// The sequencer key is stable across restarts so blocks stay verifiable.
async function loadOrCreateSequencerKey(): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    const r = await pool.query(`SELECT value FROM sovereign_meta WHERE key = 'sequencer_jwk'`);
    if (r.rowCount && r.rows[0]?.value) {
      const jwk = JSON.parse(r.rows[0].value);
      const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
      sequencerKeys = { privateKey: priv, publicKey: crypto.createPublicKey(priv) } as typeof sequencerKeys;
      return;
    }
    const jwk = sequencerKeys.privateKey.export({ format: 'jwk' });
    await pool.query(
      `INSERT INTO sovereign_meta (key, value) VALUES ('sequencer_jwk', $1)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(jwk)]
    );
  } catch (e) { persistLog(e, 'sequencer key'); }
}

/** Rebuild the in-memory Store from Postgres. Call once at boot, before
 *  the sequencer starts. No-op when persistence is unavailable. Safe to
 *  call multiple times — the load runs once per process. */
let _ledgerLoadPromise: Promise<{ chains: number; blocks: number; mempool: number }> | null = null;
export function loadLedgerFromDb(): Promise<{ chains: number; blocks: number; mempool: number }> {
  if (!_ledgerLoadPromise) _ledgerLoadPromise = loadLedgerFromDbInner();
  return _ledgerLoadPromise;
}

async function loadLedgerFromDbInner(): Promise<{ chains: number; blocks: number; mempool: number }> {
  const pool = await persistPoolAsync();
  if (!pool) return { chains: 0, blocks: 0, mempool: 0 };
  try {
    await loadOrCreateSequencerKey();

    const chainRows = await pool.query(`SELECT * FROM sovereign_chains ORDER BY created_at`);
    for (const r of chainRows.rows) {
      const chain: ChainRecord = {
        chainId: r.chain_id, coinName: r.coin_name, ticker: r.ticker,
        genesisHash: r.genesis_hash, status: r.status,
        totalSupply: BigInt(r.total_supply), currentSupply: BigInt(r.current_supply),
        decimals: r.decimals, equityPublicPct: r.equity_public_pct,
        equityRetainedPct: r.equity_retained_pct, issuerAddress: r.issuer_address,
        transferRules: r.transfer_rules ?? {}, covenantHash: r.covenant_hash,
        isMeme: !!r.is_meme, issuanceDraftId: r.issuance_draft_id,
        issuanceSignatureId: r.issuance_signature_id,
        createdAt: new Date(r.created_at).getTime(),
      };
      store.chains.set(chain.chainId, chain);
      if (chain.status === 'active') store.tickerIndex.set(chain.ticker, chain.chainId);
    }

    const balRows = await pool.query(`SELECT chain_id, address, balance, nonce FROM sovereign_balances`);
    for (const r of balRows.rows) {
      let m = store.balances.get(r.chain_id);
      if (!m) { m = new Map(); store.balances.set(r.chain_id, m); }
      m.set(r.address, { balance: BigInt(r.balance), nonce: r.nonce });
    }

    const blockRows = await pool.query(`SELECT * FROM sovereign_blocks ORDER BY chain_id, height`);
    let blockCount = 0;
    for (const r of blockRows.rows) {
      const block: BlockRecord = {
        chainId: r.chain_id, height: r.height, prevHash: r.prev_hash,
        timestampMs: Number(r.timestamp_ms), txRoot: r.tx_root, stateRoot: r.state_root,
        txCount: r.tx_count, headerHash: r.header_hash, sequencerSig: r.sequencer_sig,
        transactions: r.transactions ?? [], stateSnapshot: r.state_snapshot ?? [],
      };
      let arr = store.blocksByChain.get(block.chainId);
      if (!arr) { arr = []; store.blocksByChain.set(block.chainId, arr); }
      arr.push(block);
      blockCount++;
    }

    const txRows = await pool.query(`SELECT * FROM sovereign_txs`);
    for (const r of txRows.rows) {
      const tx: TxRecord = {
        chainId: r.chain_id, txId: r.tx_id, type: r.type, sender: r.sender,
        nonce: r.nonce, payload: r.payload ?? {}, signatures: r.signatures ?? [],
        submittedAt: Number(r.submitted_at), status: r.status,
        errorCode: r.error_code ?? undefined, blockHeight: r.block_height ?? undefined,
        txIndex: r.tx_index ?? undefined,
        confirmedAt: r.confirmed_at != null ? Number(r.confirmed_at) : undefined,
        operatorSettled: !!r.operator_settled,
      };
      store.txById.set(tx.txId, tx);
    }

    const memRows = await pool.query(`SELECT tx FROM sovereign_mempool ORDER BY enqueued_at`);
    let memCount = 0;
    for (const r of memRows.rows) {
      const tx = r.tx as TxRecord;
      if (!tx || !tx.txId || !tx.chainId) continue;
      let q = store.mempoolByChain.get(tx.chainId);
      if (!q) { q = []; store.mempoolByChain.set(tx.chainId, q); }
      q.push(tx);
      if (!store.txById.has(tx.txId)) store.txById.set(tx.txId, tx);
      memCount++;
    }

    console.log(`[ledger-persist] loaded ${chainRows.rows.length} chains, ${blockCount} blocks, ${memCount} mempool txs`);
    return { chains: chainRows.rows.length, blocks: blockCount, mempool: memCount };
  } catch (e) {
    persistLog(e, 'loadLedgerFromDb');
    return { chains: 0, blocks: 0, mempool: 0 };
  }
}

/** Append-only audit entry. No-op when persistence is unavailable. */
export async function auditLog(actor: string, action: string, entity?: string, entityId?: string, detail?: Record<string, any>): Promise<void> {
  const pool = await persistPoolAsync();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [actor, action, entity ?? null, entityId ?? null, JSON.stringify(detail ?? {})]
    );
  } catch (e) { persistLog(e, 'auditLog'); }
}

// ============================================================
// Signing / verification (spec Section 9.2, 9.5)
// ============================================================
function txWireObject(tx: Tx) {
  return {
    chain_id: tx.chainId,
    tx_id: tx.txId,
    type: tx.type,
    sender: tx.sender,
    nonce: tx.nonce,
    payload: tx.payload,
    signatures: tx.signatures,
    submitted_at: tx.submittedAt,
  };
}

function signingMessage(tx: Tx): Buffer {
  const obj = txWireObject(tx) as any;
  delete obj.signatures;
  return Buffer.from(canonicalize(obj), 'utf8');
}

function txMerkleLeaf(tx: Tx): Buffer {
  return sha256(Buffer.from(tx.txId, 'utf8'), Buffer.from(canonicalize(txWireObject(tx)), 'utf8'));
}

function verifyTxSignature(tx: Tx): boolean {
  if (!Array.isArray(tx.signatures) || tx.signatures.length !== 1) return false;
  const sig = tx.signatures[0];
  if (!sig || typeof sig.pubkey !== 'string' || typeof sig.signature !== 'string') return false;
  let pubBytes: Buffer, sigBytes: Buffer;
  try {
    pubBytes = Buffer.from(sig.pubkey, 'hex');
    sigBytes = Buffer.from(sig.signature, 'hex');
  } catch {
    return false;
  }
  if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;
  if (addressFromRaw(pubBytes) !== tx.sender) return false;
  try {
    return crypto.verify(null, signingMessage(tx), publicKeyFromRaw(pubBytes), sigBytes);
  } catch {
    return false;
  }
}

// ============================================================
// Block header hashing (spec Section 9.4)
// ============================================================
function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

function computeHeaderHash(args: {
  chainId: string;
  height: number;
  prevHash: Buffer;
  timestampMs: number;
  txRoot: Buffer;
  stateRoot: Buffer;
}): Buffer {
  return sha256(
    Buffer.from(args.chainId, 'utf8'),
    u64be(args.height),
    args.prevHash,
    u64be(args.timestampMs),
    args.txRoot,
    args.stateRoot,
  );
}

function stateLeaf(chainId: string, address: string, balance: bigint, nonce: number): Buffer {
  return sha256(Buffer.from(`${chainId}|${address}|${balance.toString()}|${nonce}`, 'utf8'));
}

function computeStateSnapshotAndRoot(chainId: string) {
  const balances = store.balances.get(chainId) || new Map();
  const entries = Array.from(balances.entries())
    .filter(([, v]) => v.balance > 0n)
    .map(([address, v]) => ({ address, balance: v.balance, nonce: v.nonce }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const leaves = entries.map((e) => stateLeaf(chainId, e.address, e.balance, e.nonce));
  const { root, levels } = buildMerkleTree(leaves);
  return {
    root,
    levels,
    snapshot: entries.map((e) => ({ address: e.address, balance: e.balance.toString(), nonce: e.nonce })),
  };
}

// ============================================================
// Ledger Engine — state transitions (spec Section 6.4, 7.1-7.4)
// ============================================================
function computeExpectedNonce(chainId: string, sender: string): number {
  const committed = store.getBalanceEntry(chainId, sender).nonce;
  const pending = store.mempoolByChain.get(chainId) || [];
  const senderPending = pending.filter((t) => t.sender === sender);
  if (senderPending.length === 0) return committed + 1;
  return Math.max(...senderPending.map((t) => t.nonce)) + 1;
}

function parseAmount(raw: unknown, field = 'amount'): bigint {
  let amt: bigint;
  try {
    amt = BigInt(raw as any);
  } catch {
    throw new LedgerError('invalid_amount', `${field} must be an integer string`);
  }
  if (amt <= 0n) throw new LedgerError('invalid_amount', `${field} must be > 0`);
  return amt;
}

function applyTransfer(chain: ChainRecord, tx: Tx): void {
  const { to, amount, memo } = tx.payload as { to: string; amount: string; memo?: string };
  if (!isValidAddress(to)) throw new LedgerError('invalid_recipient', 'recipient address is invalid');
  if (memo !== undefined && (typeof memo !== 'string' || memo.length > 256)) {
    throw new LedgerError('invalid_memo', 'memo must be a string up to 256 chars');
  }
  const amt = parseAmount(amount);
  // Platform-operated float settlement bypasses sender-signature verification:
  // the public float is platform-custodied by design (vanity address, no
  // keypair exists for it), and settleFloatTransfer() is the only code path
  // that can set the operatorSettled flag — it is never accepted from client
  // input. Nonce, balance, and allowlist checks still apply.
  const operatorSettled = (tx as TxRecord).operatorSettled === true;
  if (!operatorSettled && !verifyTxSignature(tx)) throw new LedgerError('invalid_signature', 'signature verification failed');

  const senderEntry = store.getBalanceEntry(chain.chainId, tx.sender);
  if (tx.nonce !== senderEntry.nonce + 1) {
    throw new LedgerError('bad_nonce', `expected nonce ${senderEntry.nonce + 1}, got ${tx.nonce}`, 409);
  }
  if (senderEntry.balance < amt) throw new LedgerError('insufficient_balance', 'sender balance too low', 409);

  const rules = chain.transferRules || {};
  if (Array.isArray(rules.allowlist) && rules.allowlist.length > 0) {
    if (!rules.allowlist.includes(to) || !rules.allowlist.includes(tx.sender)) {
      throw new LedgerError('transfer_not_allowed', 'address not in chain allowlist', 403);
    }
  }

  senderEntry.balance -= amt;
  senderEntry.nonce = tx.nonce;
  store.getBalanceEntry(chain.chainId, to).balance += amt;
}

function applyMint(chain: ChainRecord, tx: Tx): void {
  if (tx.sender !== chain.issuerAddress) throw new LedgerError('unauthorized_mint', 'only the issuer can mint', 403);
  if ((chain.transferRules || {}).allow_mint !== true) {
    throw new LedgerError('mint_disabled', 'minting is not enabled for this chain (set transfer_rules.allow_mint)', 403);
  }
  const { to, amount } = tx.payload as { to: string; amount: string };
  if (!isValidAddress(to)) throw new LedgerError('invalid_recipient', 'recipient address is invalid');
  const amt = parseAmount(amount);
  if (!verifyTxSignature(tx)) throw new LedgerError('invalid_signature', 'signature verification failed');

  const senderEntry = store.getBalanceEntry(chain.chainId, tx.sender);
  if (tx.nonce !== senderEntry.nonce + 1) {
    throw new LedgerError('bad_nonce', `expected nonce ${senderEntry.nonce + 1}, got ${tx.nonce}`, 409);
  }
  senderEntry.nonce = tx.nonce;
  store.getBalanceEntry(chain.chainId, to).balance += amt;
  chain.currentSupply += amt;
}

function applyBurn(chain: ChainRecord, tx: Tx): void {
  const { amount } = tx.payload as { amount: string };
  const amt = parseAmount(amount);
  if (!verifyTxSignature(tx)) throw new LedgerError('invalid_signature', 'signature verification failed');

  const senderEntry = store.getBalanceEntry(chain.chainId, tx.sender);
  if (tx.nonce !== senderEntry.nonce + 1) {
    throw new LedgerError('bad_nonce', `expected nonce ${senderEntry.nonce + 1}, got ${tx.nonce}`, 409);
  }
  if (senderEntry.balance < amt) throw new LedgerError('insufficient_balance', 'sender balance too low', 409);

  senderEntry.balance -= amt;
  senderEntry.nonce = tx.nonce;
  chain.currentSupply -= amt;
}

// ============================================================
// Chain Registry — POST /chains creates + applies GENESIS in one step
// (spec Section 11.1, 12.1: Genesis Service is the only GENESIS submitter)
// ============================================================
async function createChain(body: any): Promise<{ chain_id: string; genesis_hash: string; ticker: string }> {
  const { coin_name, ticker, total_supply, decimals, equity_public_pct, issuer_address, transfer_rules, covenant_hash, is_meme, issuance_draft_id, issuance_signature_id } = body || {};

  if (typeof coin_name !== 'string' || !coin_name.trim()) throw new LedgerError('invalid_coin_name', 'coin_name is required');
  if (typeof ticker !== 'string' || !/^[A-Z0-9]{2,10}$/.test(ticker)) {
    throw new LedgerError('invalid_ticker', 'ticker must be 2-10 uppercase alphanumeric characters');
  }
  if (store.tickerIndex.has(ticker)) throw new LedgerError('ticker_taken', `ticker ${ticker} is already in use by an active chain`, 409);
  const totalSupply = parseAmount(total_supply, 'total_supply');
  const dec = Number.isInteger(decimals) ? decimals : 6;
  const pubPct = Number.isInteger(equity_public_pct) ? equity_public_pct : 0;
  if (pubPct < 0 || pubPct > 100) throw new LedgerError('invalid_equity_split', 'equity_public_pct must be between 0 and 100');
  if (!isValidAddress(issuer_address)) throw new LedgerError('invalid_issuer_address', 'issuer_address is not a valid ph1 address');

  const chainId = 'ch_' + crypto.randomUUID();
  const retainedPct = 100 - pubPct;
  const isMeme = !!is_meme;

  const chain: ChainRecord = {
    chainId,
    coinName: coin_name,
    ticker,
    genesisHash: '',
    status: 'active',
    totalSupply,
    currentSupply: totalSupply,
    decimals: dec,
    equityPublicPct: pubPct,
    equityRetainedPct: retainedPct,
    issuerAddress: issuer_address,
    transferRules: transfer_rules && typeof transfer_rules === 'object' ? transfer_rules : {},
    covenantHash: isMeme ? null : covenant_hash || null,
    isMeme,
    issuanceDraftId: issuance_draft_id ?? null,
    issuanceSignatureId: issuance_signature_id ?? null,
    createdAt: Date.now(),
  };
  store.chains.set(chainId, chain);
  store.tickerIndex.set(ticker, chainId);

  const issuerAmt = (totalSupply * BigInt(retainedPct)) / 100n;
  const floatAmt = (totalSupply * BigInt(pubPct)) / 100n;
  store.getBalanceEntry(chainId, issuer_address).balance += issuerAmt;
  store.getBalanceEntry(chainId, PUBLIC_FLOAT_ADDRESS).balance += floatAmt;

  const timestampMs = Date.now();
  const genesisTx: TxRecord = {
    chainId,
    txId: 'tx_' + crypto.randomUUID(),
    type: 'GENESIS',
    sender: PLATFORM_ADDRESS,
    nonce: 0,
    payload: {
      coin_name,
      ticker,
      total_supply: totalSupply.toString(),
      decimals: dec,
      equity_public_pct: pubPct,
      issuer_address,
      covenant_hash: chain.covenantHash,
      is_meme: isMeme,
    },
    signatures: [],
    submittedAt: timestampMs,
    status: 'confirmed',
    blockHeight: 0,
    txIndex: 0,
    confirmedAt: timestampMs,
  };
  store.txById.set(genesisTx.txId, genesisTx);

  const { root: txRoot } = buildMerkleTree([txMerkleLeaf(genesisTx)]);
  const stateInfo = computeStateSnapshotAndRoot(chainId);
  const prevHash = Buffer.alloc(32);
  const headerHash = computeHeaderHash({ chainId, height: 0, prevHash, timestampMs, txRoot, stateRoot: stateInfo.root });
  const sequencerSig = crypto.sign(null, headerHash, sequencerKeys.privateKey);

  const block: BlockRecord = {
    chainId,
    height: 0,
    prevHash: prevHash.toString('hex'),
    timestampMs,
    txRoot: txRoot.toString('hex'),
    stateRoot: stateInfo.root.toString('hex'),
    txCount: 1,
    headerHash: headerHash.toString('hex'),
    sequencerSig: sequencerSig.toString('hex'),
    transactions: [genesisTx],
    stateSnapshot: stateInfo.snapshot,
  };
  store.blocksByChain.set(chainId, [block]);
  chain.genesisHash = headerHash.toString('hex');

  // Durable from birth: chain row, genesis block, opening balances, genesis tx.
  await persistChainRow(chainId);
  await persistBlockRow(block);
  await persistBalances(chainId);
  await persistTxRow(genesisTx);
  await auditLog(chain.issuerAddress, 'chain_created', 'chain', chainId, { ticker, totalSupply: totalSupply.toString() });

  return { chain_id: chainId, genesis_hash: chain.genesisHash, ticker };
}

// ============================================================
// Mempool submission (spec Section 6.2, steps 1-3)
// ============================================================
async function submitTransaction(chainId: string, input: any): Promise<{ status: number; body: any }> {
  const chain = store.chains.get(chainId);
  if (!chain) return { status: 404, body: { error: 'chain_not_found' } };
  if (chain.status !== 'active') return { status: 409, body: { error: 'chain_not_active' } };

  if (typeof input?.tx_id !== 'string' || !input.tx_id) return { status: 400, body: { error: 'missing_tx_id' } };

  const existing = store.txById.get(input.tx_id);
  if (existing) {
    if (existing.status === 'confirmed') {
      return { status: 200, body: { tx_id: existing.txId, status: 'confirmed', block_height: existing.blockHeight } };
    }
    return { status: 202, body: { tx_id: existing.txId, status: existing.status } };
  }

  if (!['TRANSFER', 'MINT', 'BURN'].includes(input.type)) {
    return {
      status: 400,
      body: { error: 'unsupported_tx_type', message: 'GENESIS is created via POST /chains; TRADE_* and FREEZE/UNFREEZE are Phase 2/unspecified — not implemented' },
    };
  }
  if (!isValidAddress(input.sender)) return { status: 400, body: { error: 'invalid_sender' } };
  if (typeof input.nonce !== 'number' || !Number.isInteger(input.nonce)) return { status: 400, body: { error: 'invalid_nonce' } };
  if (typeof input.submitted_at !== 'number' || !Number.isInteger(input.submitted_at)) {
    return { status: 400, body: { error: 'invalid_submitted_at', message: 'submitted_at (client timestamp, Unix ms) is required and is part of the signed payload' } };
  }

  // submitted_at is CLIENT-supplied (spec 4.5) and part of the signed message —
  // it must be taken as given, never recomputed server-side, or every signature
  // verification would fail against a value the client never signed.
  const tx: Tx = {
    chainId,
    txId: input.tx_id,
    type: input.type,
    sender: input.sender,
    nonce: input.nonce,
    payload: input.payload || {},
    signatures: input.signatures || [],
    submittedAt: input.submitted_at,
  };

  if (!verifyTxSignature(tx)) return { status: 400, body: { error: 'invalid_signature' } };

  // The nonce check and mempool insert must be atomic under the per-chain
  // lock. Without this, two concurrent submissions from the same sender can
  // both read the same expected nonce before either is inserted, and one
  // gets spuriously rejected with bad_nonce. This is a liveness bug, not a
  // double-spend hole — but it makes the API unreliable under concurrency.
  return chainLock.withLock(chainId, async () => {
    const expectedNonce = computeExpectedNonce(chainId, tx.sender);
    if (tx.nonce !== expectedNonce) {
      return { status: 409, body: { error: 'bad_nonce', expected: expectedNonce, got: tx.nonce } };
    }

    const record: TxRecord = { ...tx, status: 'pending' };
    store.txById.set(record.txId, record);
    const q = store.mempoolByChain.get(chainId) || [];
    q.push(record);
    store.mempoolByChain.set(chainId, q);
    await persistTxRow(record);
    await persistMempoolPut(record);
    await auditLog(tx.sender, 'tx_submitted', 'tx', record.txId, { chainId, type: tx.type });

    return { status: 202, body: { tx_id: record.txId, status: 'pending' } };
  });
}

// ============================================================
// Platform-operated float settlement (marketplace trades)
// ============================================================
// Move coins from the chain's public float to a buyer as the coin leg of a
// marketplace trade. The float is platform-custodied by design (fixed vanity
// address, no keypair exists), so this is the ONLY way float coins move —
// there is no client-submittable path. The transfer is recorded as a normal
// TRANSFER tx (sequenced into blocks, visible in proofs/explorers) with an
// operatorSettled marker instead of a sender signature.
// Internal use only: never exposed as a public HTTP route.
async function settleFloatTransfer(
  chainId: string,
  to: string,
  amountBaseUnits: string,
  memo?: string
): Promise<{ tx_id: string; status: string }> {
  const chain = store.chains.get(chainId);
  if (!chain) throw new LedgerError('chain_not_found', 'unknown chain', 404);
  if (chain.status !== 'active') throw new LedgerError('chain_not_active', 'chain is not active', 409);
  if (!isValidAddress(to)) throw new LedgerError('invalid_recipient', 'recipient address is invalid');
  const amt = parseAmount(amountBaseUnits, 'amount');
  return chainLock.withLock(chainId, async () => {
    const floatEntry = store.getBalanceEntry(chainId, PUBLIC_FLOAT_ADDRESS);
    if (floatEntry.balance < amt) {
      throw new LedgerError('insufficient_float', 'public float has insufficient balance for this trade', 409);
    }
    const txId = 'tx_' + crypto.randomUUID();
    const record: TxRecord = {
      chainId,
      txId,
      type: 'TRANSFER',
      sender: PUBLIC_FLOAT_ADDRESS,
      nonce: computeExpectedNonce(chainId, PUBLIC_FLOAT_ADDRESS),
      payload: { to, amount: amt.toString(), memo: memo ?? 'marketplace trade settlement' },
      signatures: [],
      submittedAt: Date.now(),
      status: 'pending',
      operatorSettled: true,
    };
    store.txById.set(txId, record);
    const q = store.mempoolByChain.get(chainId) || [];
    q.push(record);
    store.mempoolByChain.set(chainId, q);
    await persistTxRow(record);
    await persistMempoolPut(record);
    await auditLog('platform', 'float_transfer_queued', 'tx', txId, { chainId, to, amount: amt.toString() });
    return { tx_id: txId, status: 'pending' };
  });
}

// Read helper for settlement pre-checks: balance of any address on a chain,
// in base units (string). Throws 404 for unknown chains.
function getChainBalance(chainId: string, address: string): string {
  const chain = store.chains.get(chainId);
  if (!chain) throw new LedgerError('chain_not_found', 'unknown chain', 404);
  return store.getBalanceEntry(chainId, address).balance.toString();
}

// ============================================================
// Sequencer — block production (spec Section 6.2 steps 4-5, 8.1)
// ============================================================
function produceBlockForChain(chainId: string): Promise<void> {
  return chainLock.withLock(chainId, async () => {
    const pending = store.mempoolByChain.get(chainId) || [];
    if (pending.length === 0) return;
    const batch = pending.splice(0, MAX_TX_PER_BLOCK);
    const chain = store.chains.get(chainId);
    if (!chain) return;

    const applied: TxRecord[] = [];
    for (const tx of batch) {
      try {
        if (tx.type === 'TRANSFER') applyTransfer(chain, tx);
        else if (tx.type === 'MINT') applyMint(chain, tx);
        else if (tx.type === 'BURN') applyBurn(chain, tx);
        tx.status = 'confirmed';
        applied.push(tx);
      } catch (err: any) {
        tx.status = 'failed';
        tx.errorCode = err instanceof LedgerError ? err.code : 'unknown_error';
      }
    }
    if (applied.length === 0) return; // no empty blocks

    const prevBlock = store.getLatestBlock(chainId);
    const height = prevBlock ? prevBlock.height + 1 : 0;
    const prevHash = prevBlock ? Buffer.from(prevBlock.headerHash, 'hex') : Buffer.alloc(32);
    const timestampMs = Date.now();

    applied.forEach((tx, i) => {
      tx.blockHeight = height;
      tx.txIndex = i;
      tx.confirmedAt = timestampMs;
    });

    const { root: txRoot } = buildMerkleTree(applied.map(txMerkleLeaf));
    const stateInfo = computeStateSnapshotAndRoot(chainId);
    const headerHash = computeHeaderHash({ chainId, height, prevHash, timestampMs, txRoot, stateRoot: stateInfo.root });
    const sequencerSig = crypto.sign(null, headerHash, sequencerKeys.privateKey);

    const block: BlockRecord = {
      chainId,
      height,
      prevHash: prevHash.toString('hex'),
      timestampMs,
      txRoot: txRoot.toString('hex'),
      stateRoot: stateInfo.root.toString('hex'),
      txCount: applied.length,
      headerHash: headerHash.toString('hex'),
      sequencerSig: sequencerSig.toString('hex'),
      transactions: applied,
      stateSnapshot: stateInfo.snapshot,
    };
    const blocks = store.blocksByChain.get(chainId) || [];
    blocks.push(block);
    store.blocksByChain.set(chainId, blocks);

    // Write-through: block, post-block balances, chain (supply may move),
    // every tx in the batch (confirmed AND failed), and mempool cleanup.
    await persistBlockRow(block);
    await persistBalances(chainId);
    await persistChainRow(chainId);
    for (const tx of batch) {
      await persistTxRow(tx);
      await persistMempoolDel(tx.txId);
    }
    await auditLog('sequencer', 'block_sealed', 'block', `${chainId}:${height}`, { txCount: applied.length });
  });
}

function startSequencerLoop(): NodeJS.Timeout {
  return setInterval(() => {
    for (const chainId of Array.from(store.mempoolByChain.keys())) {
      const q = store.mempoolByChain.get(chainId);
      if (q && q.length > 0) {
        produceBlockForChain(chainId).catch((err) => console.error('[sequencer]', chainId, err));
      }
    }
  }, BLOCK_INTERVAL_MS);
}

// ============================================================
// Minimal JWT (HS256-only, algorithm locked server-side to avoid
// alg-confusion attacks) — togglable via REQUIRE_AUTH
// ============================================================
function checkAuth(req: http.IncomingMessage): { ok: true } | { ok: false; status: number; body: any } {
  if (!REQUIRE_AUTH) return { ok: true };
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
    return { ok: false, status: 401, body: { error: 'missing_bearer_token' } };
  }
  const token = header.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, body: { error: 'invalid_token' } };
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const hdr = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    if (hdr.alg !== 'HS256') return { ok: false, status: 401, body: { error: 'unsupported_alg' } };
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${headerB64}.${payloadB64}`).digest();
    const actual = Buffer.from(sigB64, 'base64url');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return { ok: false, status: 401, body: { error: 'invalid_signature' } };
    }
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return { ok: false, status: 401, body: { error: 'token_expired' } };
    return { ok: true };
  } catch {
    return { ok: false, status: 401, body: { error: 'invalid_token' } };
  }
}

// ============================================================
// HTTP API (spec Section 11, 14)
// ============================================================
function json(res: http.ServerResponse, status: number, body: any) {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new LedgerError('invalid_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serializeChain(c: ChainRecord) {
  const latest = store.getLatestBlock(c.chainId);
  return {
    chain_id: c.chainId,
    coin_name: c.coinName,
    ticker: c.ticker,
    status: c.status,
    total_supply: c.totalSupply.toString(),
    current_supply: c.currentSupply.toString(),
    decimals: c.decimals,
    equity_public_pct: c.equityPublicPct,
    equity_retained_pct: c.equityRetainedPct,
    issuer_address: c.issuerAddress,
    is_meme: c.isMeme,
    covenant_hash: c.covenantHash,
    genesis_hash: c.genesisHash,
    latest_height: latest?.height ?? 0,
    latest_hash: latest?.headerHash ?? c.genesisHash,
    created_at: new Date(c.createdAt).toISOString(),
  };
}

function serializeTx(t: TxRecord) {
  return {
    tx_id: t.txId,
    chain_id: t.chainId,
    type: t.type,
    sender: t.sender,
    nonce: t.nonce,
    payload: t.payload,
    status: t.status,
    error_code: t.errorCode,
    block_height: t.blockHeight,
    submitted_at: new Date(t.submittedAt).toISOString(),
    confirmed_at: t.confirmedAt ? new Date(t.confirmedAt).toISOString() : null,
  };
}

function serializeBlock(b: BlockRecord, includeTxs = true) {
  return {
    chain_id: b.chainId,
    height: b.height,
    prev_hash: b.prevHash,
    timestamp_ms: b.timestampMs,
    tx_root: b.txRoot,
    state_root: b.stateRoot,
    tx_count: b.txCount,
    header_hash: b.headerHash,
    sequencer_sig: b.sequencerSig,
    transactions: includeTxs ? b.transactions.map(serializeTx) : undefined,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);

    if (segs[0] === 'healthz') return json(res, 200, { ok: true, chains: store.chains.size });

    const auth = checkAuth(req);
    if (!auth.ok) return json(res, (auth as { status: number }).status, (auth as { body: any }).body);

    if (segs[0] !== 'chains') return json(res, 404, { error: 'not_found' });

    // POST /chains
    if (segs.length === 1 && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const result = createChain(body);
        return json(res, 201, result);
      } catch (err: any) {
        if (err instanceof LedgerError) return json(res, err.status, { error: err.code, message: err.message });
        throw err;
      }
    }

    // GET /chains
    if (segs.length === 1 && req.method === 'GET') {
      const ticker = url.searchParams.get('ticker');
      const status = url.searchParams.get('status');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const cursor = Number(url.searchParams.get('cursor')) || 0;
      let chains = Array.from(store.chains.values());
      if (ticker) chains = chains.filter((c) => c.ticker === ticker);
      if (status) chains = chains.filter((c) => c.status === status);
      const page = chains.slice(cursor, cursor + limit);
      return json(res, 200, {
        chains: page.map(serializeChain),
        next_cursor: cursor + limit < chains.length ? cursor + limit : null,
      });
    }

    // GET /chains/:id
    if (segs.length === 2 && req.method === 'GET') {
      const chain = store.chains.get(segs[1]);
      if (!chain) return json(res, 404, { error: 'chain_not_found' });
      return json(res, 200, serializeChain(chain));
    }

    // /chains/:id/transactions
    if (segs.length === 3 && segs[2] === 'transactions') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await submitTransaction(segs[1], body);
        return json(res, result.status, result.body);
      }
      if (req.method === 'GET') {
        const chain = store.chains.get(segs[1]);
        if (!chain) return json(res, 404, { error: 'chain_not_found' });
        const sender = url.searchParams.get('sender');
        const type = url.searchParams.get('type');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const cursor = Number(url.searchParams.get('cursor')) || 0;
        let txs = Array.from(store.txById.values()).filter((t) => t.chainId === segs[1]);
        if (sender) txs = txs.filter((t) => t.sender === sender);
        if (type) txs = txs.filter((t) => t.type === type);
        txs.sort((a, b) => b.submittedAt - a.submittedAt);
        const page = txs.slice(cursor, cursor + limit);
        return json(res, 200, { transactions: page.map(serializeTx), next_cursor: cursor + limit < txs.length ? cursor + limit : null });
      }
    }

    // GET /chains/:id/transactions/:tx_id
    if (segs.length === 4 && segs[2] === 'transactions' && req.method === 'GET') {
      const tx = store.txById.get(segs[3]);
      if (!tx || tx.chainId !== segs[1]) return json(res, 404, { error: 'transaction_not_found' });
      return json(res, 200, serializeTx(tx));
    }

    // GET /chains/:id/blocks/latest
    if (segs.length === 4 && segs[2] === 'blocks' && segs[3] === 'latest' && req.method === 'GET') {
      const block = store.getLatestBlock(segs[1]);
      if (!block) return json(res, 404, { error: 'chain_not_found_or_no_blocks' });
      return json(res, 200, serializeBlock(block));
    }

    // GET /chains/:id/blocks/:height
    if (segs.length === 4 && segs[2] === 'blocks' && req.method === 'GET') {
      const height = Number(segs[3]);
      const blocks = store.blocksByChain.get(segs[1]) || [];
      const block = blocks[height];
      if (!block) return json(res, 404, { error: 'block_not_found' });
      return json(res, 200, serializeBlock(block));
    }

    // GET /chains/:id/balances/:address
    if (segs.length === 4 && segs[2] === 'balances' && req.method === 'GET') {
      if (!store.chains.has(segs[1])) return json(res, 404, { error: 'chain_not_found' });
      const entry = store.getBalanceEntry(segs[1], segs[3]);
      const latest = store.getLatestBlock(segs[1]);
      return json(res, 200, { address: segs[3], balance: entry.balance.toString(), nonce: entry.nonce, last_updated_height: latest?.height ?? 0 });
    }

    // GET /chains/:id/proofs/balance/:address
    if (segs.length === 5 && segs[2] === 'proofs' && segs[3] === 'balance' && req.method === 'GET') {
      const chainId = segs[1];
      const address = segs[4];
      if (!store.chains.has(chainId)) return json(res, 404, { error: 'chain_not_found' });
      const heightParam = url.searchParams.get('height');
      const blocks = store.blocksByChain.get(chainId) || [];
      const block = heightParam ? blocks[Number(heightParam)] : blocks[blocks.length - 1];
      if (!block) return json(res, 404, { error: 'block_not_found' });
      const leafIndex = block.stateSnapshot.findIndex((e) => e.address === address);
      if (leafIndex === -1) {
        return json(res, 404, { error: 'address_not_in_state', message: 'address has zero balance at this height (zero-balance entries are not included in the state tree)' });
      }
      const leaves = block.stateSnapshot.map((e) => stateLeaf(chainId, e.address, BigInt(e.balance), e.nonce));
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, leafIndex);
      const entry = block.stateSnapshot[leafIndex];
      return json(res, 200, {
        address,
        balance: entry.balance,
        nonce: entry.nonce,
        height: block.height,
        state_root: block.stateRoot,
        proof: proof.map((p) => p.hash),
        proof_directions: proof.map((p) => (p.isRight ? 'right' : 'left')),
        leaf_index: leafIndex,
      });
    }

    // GET /chains/:id/proofs/transaction/:tx_id
    if (segs.length === 5 && segs[2] === 'proofs' && segs[3] === 'transaction' && req.method === 'GET') {
      const tx = store.txById.get(segs[4]);
      if (!tx || tx.chainId !== segs[1] || tx.blockHeight === undefined) return json(res, 404, { error: 'transaction_not_found_or_unconfirmed' });
      const blocks = store.blocksByChain.get(segs[1]) || [];
      const block = blocks[tx.blockHeight];
      if (!block) return json(res, 404, { error: 'block_not_found' });
      const leaves = block.transactions.map(txMerkleLeaf);
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, tx.txIndex!);
      return json(res, 200, {
        tx_id: tx.txId,
        block_height: tx.blockHeight,
        tx_root: block.txRoot,
        proof: proof.map((p) => p.hash),
        proof_directions: proof.map((p) => (p.isRight ? 'right' : 'left')),
        leaf_index: tx.txIndex,
      });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (err: any) {
    if (err instanceof LedgerError) return json(res, err.status, { error: err.code, message: err.message });
    console.error(err);
    return json(res, 500, { error: 'internal_error', message: err?.message });
  }
});

export {
  store,
  b58encode,
  b58decode,
  addressFromRaw,
  rawPublicKey,
  publicKeyFromRaw,
  canonicalize,
  txWireObject,
  signingMessage,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  stateLeaf,
  createChain,
  submitTransaction,
  settleFloatTransfer,
  getChainBalance,
  isValidAddress,
  PUBLIC_FLOAT_ADDRESS,
  startSequencerLoop,
  computeStateSnapshotAndRoot,
  serializeChain,
  serializeTx,
  serializeBlock,
  txMerkleLeaf,
  LedgerError,
};
