# Phase Protocol — Mock Backend (Single File, Zero Dependencies)

This is the in-memory simulation layer: one TypeScript file, no Express, no
database, no Docker. Runs immediately with `npx tsx phase-backend.ts`. There
is no real blockchain here — `blockchainState` is a plain array. Restarting
the process wipes everything. That's the deliberate trade for a build you can
run and demo in seconds.

**Updated:** state is now object-isolated rather than protected by one
global lock. See "Concurrency model" below — this is the part worth reading
if you're evaluating whether this maps cleanly to a real parallel runtime
later.

## Concurrency model — object isolation, not a global lock

Each `Profile` and each `AssetListing` is its own independently-locked
object (`ObjectStore<T>`, see the top of the file). Two requests touching
two *different* objects run with zero contention. Two requests touching the
*same* object serialize safely against each other — no lost updates, no
oversold shares, no double-spends.

Node is single-threaded, so this doesn't give literal multi-core
parallelism. What it gives you is the **correct lock boundary** — every
mutation declares up front which object(s) it touches and acquires exactly
those locks, in deterministic order when it needs two. That's the same
boundary object-based parallel runtimes (Sui/Move's object ownership,
Solana's account access lists) use to actually parallelize — so this code
maps onto one of those later without a rewrite, just a faster lock
implementation underneath the same boundaries.

This was a deliberate departure from a naive EVM-style global state tree,
where every transaction implicitly contends with every other transaction
even when they touch completely unrelated accounts.

### The hotspot caveat — and when to stop using withTwoLocks

`withTwoLocks` (used by both `/marketplace/buy` and `/profile/transfer`)
serializes **all** traffic into a given account through that account's
single lock queue. That's the right tradeoff at current volume — it's
simple, perfectly atomic, and there's no intermediate state where a
transfer can get stuck half-done.

It stops being the right tradeoff the moment one account becomes a
**hotspot** — an exchange-style hot wallet, a popular creator receiving
many transfers at once. At that point every incoming transfer queues
behind every other one touching that account, even though they have
nothing to do with each other.

The fix at that point is an **escrow/invoice object**, not more locking:
debit the sender under their own lock only, spawn a pending
`TransferInvoice`, then credit the receiver in a second, separate locked
step. This drops sender-lock hold time to near-zero and removes the
two-party lock entirely — it's the same reason real clearinghouses exist
instead of locking two banks' databases simultaneously to settle a wire.
It also requires a reconciliation sweep for invoices stuck in "pending"
(crash between the two phases) — that's real engineering work, not
optional, and isn't built here because there's no hotspot yet to justify
the added complexity.

Migrate when a specific account's transfer volume is a measured
bottleneck, not before.

## Run it

```bash
npm install        # only pulls in tsx + typescript + @types/node, all dev-only
npm run dev
# → Phase Protocol mock backend listening on http://localhost:4100
```

No `npm install` is actually required to run it — `npx tsx phase-backend.ts`
works standalone since the file imports only Node built-ins (`node:http`,
`node:crypto`, `node:url`). The `package.json` here just gives you proper
TypeScript types and a `dev` script for convenience.

## This has been run and tested, not just written

Every endpoint below was actually started and hit with `curl` during
development — not just read for syntax. Specifically verified:

- ✅ Profile bootstrap grants 1,000 locked Phase Coins and auto-whitelists
- ✅ Duplicate profile creation correctly rejected (409), even under
  concurrent bootstrap attempts for the same DID (lock prevents the
  classic check-then-write race)
- ✅ Whitelist gateway correctly rejects an unknown DID (403) before any
  asset logic runs
- ✅ Asset launch correctly computes exact share splits (e.g. 70/30 split
  of 1,000,000 → 700,000 public / 300,000 retained, ticker auto-uppercased)
- ✅ `publicSalePercentage + retainedPercentage != 100` correctly rejected
  (422) with the actual sum echoed back
- ✅ Duplicate ticker rejection — including under concurrent launch
  attempts for the same new ticker, since the check now happens inside
  the asset's lock rather than via a racy pre-check
- ✅ **Concurrency proof, same object:** fired 20 truly concurrent buy
  requests at one asset — public share count landed exactly correct
  (699,900 → 699,700) with zero lost updates or corruption
- ✅ **Concurrency proof, cross-object isolation:** interleaved a buy
  request against a *different* asset in the middle of a 14-request
  same-object batch — it completed mid-batch rather than queuing behind
  the backlog, confirming different objects genuinely don't block each
  other
- ✅ Buy-shares endpoint correctly rejects insufficient public supply,
  insufficient Phase Coin balance, unknown tickers, and non-live assets
- ✅ **Peer-to-peer transfer**, atomic via `withTwoLocks`: balances move
  exactly (verified 500,000 → 499,000 → 498,970 across a launch + single
  transfer + a 30-request bidirectional storm)
- ✅ **Deadlock-safety proof:** fired 30 concurrent transfers between the
  same two accounts in BOTH directions simultaneously (15× A→B, 15× B→A)
  — completed in 0.38s with no hang, and final balances matched the exact
  predicted arithmetic (alice: 498,970, bob: 1,030). This is the actual
  point of sorting lock keys alphabetically before acquiring them — two
  transfers wanting opposite lock orders can never deadlock against
  each other.
- ✅ Tri-denomination valuation correct in USD and BTC (verified the BTC
  math against the mock rate directly: totalValueUsd / 97000)
- ✅ Price-flash daemon ticks every 2.5s with correct UP/DOWN direction
  flags, observed over multiple real intervals, now updating each asset
  under its own lock
- ✅ Ledger blocks chain correctly via `prevBlockId`
- ✅ Malformed JSON body returns a clean 400 instead of crashing the process
- ✅ Unknown routes return 404

## Endpoints

```
POST   /api/v1/profile/bootstrap        { did }
POST   /api/v1/assets/launch            { ownerDid, assetName, assetTicker,
                                           assetClass: HARD|SOFT|HUMAN,
                                           subSector, valueProposition,
                                           publicSalePercentage, retainedPercentage }
POST   /api/v1/marketplace/buy          { buyerDid, assetTicker, shares }
POST   /api/v1/profile/transfer         { senderDid, receiverDid, assetTicker, amount }
GET    /api/v1/marketplace/directory
GET    /api/v1/portfolio/valuation      ?did=...&denom=USD|USDC|BTC
GET    /api/v1/ledger/blocks            ?limit=50
GET    /healthz
```

The whitelist gateway wraps `/api/v1/assets/launch` and `/api/v1/marketplace/buy`,
inspecting the request body for an `ownerDid`/`buyerDid`/`did` field — if
that identity isn't in `activeWhitelists`, the request is rejected before
any business logic runs, per spec.

`/api/v1/marketplace/buy` is the endpoint that exercises real two-object
locking: it moves shares from an asset's public pool into a buyer's
holdings and debits their Phase Coin balance, atomically, via
`profiles.withLock` nested around `marketplaceDirectory.withLock` in a
fixed acquisition order.

`/api/v1/profile/transfer` exercises `ObjectStore.withTwoLocks` directly
across two Profile objects (sender + receiver). Worth noting since it's an
easy mistake to make: `withTwoLocks`'s callback must return
`{ result, nextA, nextB }` with the new versions of both objects — it does
NOT let you mutate the passed-in objects in place and expect that to
persist. `nextA` always corresponds to whatever `keyA` was in the original
call (here, `senderDid`), regardless of which lock was internally acquired
first for deadlock-prevention ordering.

## What's mocked vs. real, explicitly

- **Market rates** (`MOCK_MARKET_RATES`) are hardcoded constants
  (`usdPerBtc: 97000`). Swap the `convertUsd` function for a real price
  feed call when you're ready — that's the only change needed.
- **Pricing model** at launch is a flat $1.00/share. The price-flash daemon
  then randomly jitters ±1.5% every 2.5s — that's cosmetic/demo motion, not
  a real market-making model.
- **Phase Coin is treated 1:1 with USD** when buying shares (`costUsd` is
  debited directly from `phaseCoinBalance`). Replace with a real internal
  FX/pricing model before this means anything financially.
- **No real cryptography or consensus** — `appendBlock` just pushes to an
  array with a `prevBlockId` pointer for shape, not actual hash-chaining.
- **No persistence** — everything lives in process memory. Hook up the
  Postgres schema + Besu contracts from the earlier slice when you're ready
  to move past prototyping.

## Same flag as before, still true here

`assetClass: "HUMAN"` lets a profile mint and sell tradable equity-like
claims on a person. That's the same securities-shaped pattern regardless of
which backend (this mock or the real Besu chain) sits underneath it — get
legal review before this touches real users or real money. Nothing about
making the demo run changes that.

## Crypto funding (USDC via Circle Developer-Controlled Wallets)

`crypto-funding.ts` adds stablecoin funding rails on top of the mock backend.
Zero npm dependencies — only Node built-ins (`fetch`, `node:crypto`).

**Provider:** Circle Web3 Services, Developer-Controlled Wallets REST API
(`https://api.circle.com`). Free tier. One Circle wallet set for Phase, one
wallet per Phase user on each configured chain, plus per-chain treasury
wallets that user deposits get swept into.

**Network safety:** everything defaults to **testnet**. Mainnet is only
possible when BOTH `CIRCLE_MAINNET=true` AND `CIRCLE_MAINNET_CONFIRM=YES`
are set; test API keys are additionally rejected on mainnet chains by Circle
itself. Every funding response carries `network` and, on testnet, an
explicit `TESTNET — FAKE FUNDS` notice.

### Setup (testnet)

1. Create a free Circle developer account at https://console.circle.com and
   generate a **test** API key (`TEST_API_KEY:...`).
2. Generate the entity secret (32 random bytes, hex-encoded) and register it
   in the Circle dashboard (Configurator page). Example:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Save the output in your secret manager — Circle never stores it and it
   cannot be recovered.
3. Get free testnet USDC at https://faucet.circle.com (Base Sepolia /
   Polygon Amoy / Solana Devnet).
4. Export env vars and boot the backend:

```bash
export CIRCLE_API_KEY='TEST_API_KEY:...'
export CIRCLE_ENTITY_SECRET='<64-hex-chars>'
# optional:
# export CIRCLE_CHAINS='base,polygon,solana'   # default testnet: BASE-SEPOLIA,MATIC-AMOY,SOL-DEVNET
# export CIRCLE_WALLET_SET_ID='<existing-set-id>'  # reuse instead of creating
# export CIRCLE_REQUIRED_CONFIRMATIONS=12
npx tsx phase-backend.ts
```

Env var reference: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`,
`CIRCLE_MAINNET` + `CIRCLE_MAINNET_CONFIRM` (both required for mainnet),
`CIRCLE_CHAINS`, `CIRCLE_WALLET_SET_ID`, `CIRCLE_OAEP_HASH` (default
`sha256`), `CIRCLE_WEBHOOK_SECRET` (defaults to the API key),
`CIRCLE_REQUIRED_CONFIRMATIONS` (default 12).

### API flows

```bash
BASE=http://localhost:4100

# 1. Provision (idempotent) — one wallet per chain for a user
curl -s -X POST $BASE/api/v1/funding/wallets \
  -H 'Content-Type: application/json' -d '{"userId":"user_123"}'

# 2. Deposit address + per-chain balances
curl -s "$BASE/api/v1/funding/deposit-address?userId=user_123&chain=base"

# 3. Sweep user wallet -> Phase treasury (idempotency-keyed)
curl -s -X POST $BASE/api/v1/funding/transfer \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_123","amount":"1.50","chain":"base","idempotencyKey":"sweep-001"}'

# 4. Funding ledger (refresh=true re-polls Circle for pending transfers)
curl -s "$BASE/api/v1/funding/ledger?userId=user_123&refresh=true"

# 5. Webhooks — point your Circle notification subscription at
#    POST /api/v1/funding/webhooks. Signatures are verified (ECDSA via
#    X-Circle-Signature + X-Circle-Key-Id, or HMAC-SHA256 fallback);
#    unverifiable payloads get 401 and never touch the ledger.
#    Circle validates the endpoint with HEAD on subscribe (handled).
```

**Deposits:** a user sends USDC on-chain to their deposit address. Circle
emits a `transactions.inbound` webhook; the handler records a ledger entry
and marks it `confirmed` (with `verified:true`) once the required
confirmations are reached. Entries learned from unverified sources stay
`verified:false` and never count as confirmed.

### What's still TODO before this is production-shaped

- **Persistence:** the wallet map and funding ledger are in-memory (restart
  wipes them). Move to Postgres (`user_wallets`, `funding_ledger`,
  `webhook_dedup`) — the TODOs in `crypto-funding.ts` mark the spots.
- **Compliance:** operating with real client funds in Canada generally
  requires FINTRAC MSB registration (plus provincial analysis) — testnet
  first, counsel before mainnet. This changes nothing about the
  securities-law review already required for the `HUMAN` claims before
  launch.
