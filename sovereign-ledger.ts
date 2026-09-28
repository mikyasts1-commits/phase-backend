/**
 * Phase Sovereign Ledger — mount adapter for phase-backend.ts.
 *
 * Exposes the sovereign ledger (Phase 1 MVP) under /api/v1/ledger/*,
 * using the backend's route()/sendJson() pattern. The core engine lives in
 * ./sovereign-ledger-core.js (zero-dependency, Ed25519-signed transactions,
 * per-chain sequencer lock, Merkle proofs).
 *
 * TESTNET / EXPERIMENTAL: in-memory only (state lost on restart), no auth
 * by default. Do not use for real value until the Postgres swap-in
 * (schema.sql) and legal review are complete.
 *
 * Mounted from phase-backend.ts: mountSovereignLedgerRoutes({ route, sendJson, HttpError })
 */
import {
  store,
  createChain,
  submitTransaction,
  startSequencerLoop,
  loadLedgerFromDb,
  serializeChain,
  serializeTx,
  serializeBlock,
  buildMerkleTree,
  getMerkleProof,
  stateLeaf,
  txMerkleLeaf,
  LedgerError,
} from "./sovereign-ledger-core.js";

interface LedgerCtx {
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface LedgerDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: any;
}

const PREFIX = "/api/v1/sovereign";

export function mountSovereignLedgerRoutes(deps: LedgerDeps): void {
  const { route, sendJson } = deps;

  const fail = (ctx: LedgerCtx, err: unknown): void => {
    if (err instanceof LedgerError) {
      sendJson(ctx.res, err.status, { error: err.code, message: err.message });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    sendJson(ctx.res, statusCode, { error: "internal_error", message: err instanceof Error ? err.message : String(err) });
  };

  // POST /api/v1/ledger/chains — create a sovereign chain + genesis block
  route("POST", `${PREFIX}/chains`, async (ctx: LedgerCtx) => {
    try {
      const result = await createChain(ctx.body);
      sendJson(ctx.res, 201, result);
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains — list chains
  route("GET", `${PREFIX}/chains`, (ctx: LedgerCtx) => {
    try {
      const ticker = ctx.query.get("ticker");
      const status = ctx.query.get("status");
      const limit = Math.min(Number(ctx.query.get("limit")) || 50, 200);
      const cursor = Number(ctx.query.get("cursor")) || 0;
      let chains = Array.from(store.chains.values());
      if (ticker) chains = chains.filter((c: any) => c.ticker === ticker);
      if (status) chains = chains.filter((c: any) => c.status === status);
      const page = chains.slice(cursor, cursor + limit);
      sendJson(ctx.res, 200, {
        chains: page.map(serializeChain),
        next_cursor: cursor + limit < chains.length ? cursor + limit : null,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id — get chain
  route("GET", `${PREFIX}/chains/:id`, (ctx: LedgerCtx) => {
    try {
      const chain = store.chains.get(ctx.params.id);
      if (!chain) return sendJson(ctx.res, 404, { error: "chain_not_found" });
      sendJson(ctx.res, 200, serializeChain(chain));
    } catch (err) {
      fail(ctx, err);
    }
  });

  // POST /api/v1/ledger/chains/:id/transactions — submit a signed transaction
  route("POST", `${PREFIX}/chains/:id/transactions`, async (ctx: LedgerCtx) => {
    try {
      const result = await submitTransaction(ctx.params.id, ctx.body);
      sendJson(ctx.res, result.status, result.body);
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/transactions — list transactions
  route("GET", `${PREFIX}/chains/:id/transactions`, (ctx: LedgerCtx) => {
    try {
      const chainId = ctx.params.id;
      if (!store.chains.has(chainId)) return sendJson(ctx.res, 404, { error: "chain_not_found" });
      const sender = ctx.query.get("sender");
      const type = ctx.query.get("type");
      const limit = Math.min(Number(ctx.query.get("limit")) || 50, 200);
      let txs = Array.from(store.txById.values()).filter((t: any) => t.chainId === chainId);
      if (sender) txs = txs.filter((t: any) => t.sender === sender);
      if (type) txs = txs.filter((t: any) => t.type === type);
      txs.sort((a: any, b: any) => b.submittedAt - a.submittedAt);
      sendJson(ctx.res, 200, { transactions: txs.slice(0, limit).map(serializeTx) });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/transactions/:txId — get transaction
  route("GET", `${PREFIX}/chains/:id/transactions/:txId`, (ctx: LedgerCtx) => {
    try {
      const tx: any = store.txById.get(ctx.params.txId);
      if (!tx || tx.chainId !== ctx.params.id) return sendJson(ctx.res, 404, { error: "transaction_not_found" });
      sendJson(ctx.res, 200, serializeTx(tx));
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/blocks/latest — latest block
  route("GET", `${PREFIX}/chains/:id/blocks/latest`, (ctx: LedgerCtx) => {
    try {
      const block = store.getLatestBlock(ctx.params.id);
      if (!block) return sendJson(ctx.res, 404, { error: "block_not_found" });
      sendJson(ctx.res, 200, serializeBlock(block));
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/blocks/:height — get block by height
  route("GET", `${PREFIX}/chains/:id/blocks/:height`, (ctx: LedgerCtx) => {
    try {
      const blocks = store.blocksByChain.get(ctx.params.id) || [];
      const block = blocks[Number(ctx.params.height)];
      if (!block) return sendJson(ctx.res, 404, { error: "block_not_found" });
      sendJson(ctx.res, 200, serializeBlock(block));
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/balances/:address — balance
  route("GET", `${PREFIX}/chains/:id/balances/:address`, (ctx: LedgerCtx) => {
    try {
      const chainId = ctx.params.id;
      if (!store.chains.has(chainId)) return sendJson(ctx.res, 404, { error: "chain_not_found" });
      const entry = store.getBalanceEntry(chainId, ctx.params.address);
      const latest = store.getLatestBlock(chainId);
      sendJson(ctx.res, 200, {
        address: ctx.params.address,
        balance: entry.balance.toString(),
        nonce: entry.nonce,
        last_updated_height: latest?.height ?? 0,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/proofs/balance/:address — Merkle balance proof
  route("GET", `${PREFIX}/chains/:id/proofs/balance/:address`, (ctx: LedgerCtx) => {
    try {
      const chainId = ctx.params.id;
      const address = ctx.params.address;
      if (!store.chains.has(chainId)) return sendJson(ctx.res, 404, { error: "chain_not_found" });
      const heightParam = ctx.query.get("height");
      const blocks = store.blocksByChain.get(chainId) || [];
      const block: any = heightParam ? blocks[Number(heightParam)] : blocks[blocks.length - 1];
      if (!block) return sendJson(ctx.res, 404, { error: "block_not_found" });
      const leafIndex = block.stateSnapshot.findIndex((e: any) => e.address === address);
      if (leafIndex === -1) {
        return sendJson(ctx.res, 404, {
          error: "address_not_in_state",
          message: "address has zero balance at this height (zero-balance entries are not included in the state tree)",
        });
      }
      const leaves = block.stateSnapshot.map((e: any) => stateLeaf(chainId, e.address, BigInt(e.balance), e.nonce));
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, leafIndex);
      const entry = block.stateSnapshot[leafIndex];
      sendJson(ctx.res, 200, {
        address,
        balance: entry.balance,
        nonce: entry.nonce,
        height: block.height,
        state_root: block.stateRoot,
        proof: proof.map((p: any) => p.hash),
        proof_directions: proof.map((p: any) => (p.isRight ? "right" : "left")),
        leaf_index: leafIndex,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/ledger/chains/:id/proofs/transaction/:txId — Merkle tx proof
  route("GET", `${PREFIX}/chains/:id/proofs/transaction/:txId`, (ctx: LedgerCtx) => {
    try {
      const tx: any = store.txById.get(ctx.params.txId);
      if (!tx || tx.chainId !== ctx.params.id || tx.blockHeight === undefined) {
        return sendJson(ctx.res, 404, { error: "transaction_not_found_or_unconfirmed" });
      }
      const blocks = store.blocksByChain.get(ctx.params.id) || [];
      const block: any = blocks[tx.blockHeight];
      if (!block) return sendJson(ctx.res, 404, { error: "block_not_found" });
      const leaves = block.transactions.map(txMerkleLeaf);
      const { levels } = buildMerkleTree(leaves);
      const proof = getMerkleProof(levels, tx.txIndex);
      sendJson(ctx.res, 200, {
        tx_id: tx.txId,
        block_height: tx.blockHeight,
        tx_root: block.txRoot,
        proof: proof.map((p: any) => p.hash),
        proof_directions: proof.map((p: any) => (p.isRight ? "right" : "left")),
        leaf_index: tx.txIndex,
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // Rebuild in-memory ledger state from Postgres (chains survive restarts),
  // then start the sequencer (block production loop). Runs once per process.
  loadLedgerFromDb()
    .then((s) => console.log(`[sovereign-ledger] restored ${s.chains} chains from Postgres`))
    .catch((e) => console.error("[sovereign-ledger] restore failed", e));
  startSequencerLoop();
  console.log("[sovereign-ledger] mounted at /api/v1/sovereign/*, sequencer started");
}
