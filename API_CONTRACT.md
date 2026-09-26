# Phase API contract — app wiring handoff

Base URL: `https://<render-host>` (local dev: `http://localhost:3000`).
All responses are JSON. Every response carries `{ network, chain }`
(`devnet`/`solana` for issuance, `testnet` for funding).

## Auth (target)

`Authorization: Bearer <Supabase JWT>`. The backend derives `userId` from the
token. **Today** (auth not built yet): pass `userId` in the body or query
string, exactly as documented below. When Supabase lands, the `userId` param
is ignored in favor of the token — request shapes otherwise unchanged.

## Error shape

```json
{ "network": "devnet", "chain": "solana", "error": "code", "message": "human-readable" }
```

Common codes: `missing_user_id` (400), `invalid_json_body` (400),
`draft_not_found` / `coin_not_found` (404), `forbidden` (403),
`invalid_name` / `invalid_ticker` / `invalid_split` / `invalid_legal_name` /
`not_accepted` / `signature_required` (422), `already_minted` (409),
`missing_idempotency_key` (400), `unsupported_currency` / `unsupported_chain` (400).

---

## Issuance (real — Solana devnet)

### POST /api/v1/issuance/draft
Create a coin draft.

```json
// request
{ "userId": "u_123", "name": "MyCoin", "ticker": "MYC",
  "category": "Creator", "tagline": "Coin for my community",
  "valueThesis": "Revenue share from my channel",
  "equityPublic": 60, "equityRetained": 40,
  "socialProfiles": [{ "platform": "x", "url": "https://x.com/..." }] }
// 201 response
{ "network": "devnet", "chain": "solana",
  "draftId": "uuid", "status": "draft", "draft": { ... } }
```
Rules: `name` 1–60 chars; `ticker` 2–10 chars A–Z0–9 (auto-uppercased);
`equityPublic` + `equityRetained` must be whole numbers summing to 100
(default 50/50).

### GET /api/v1/issuance/agreement?draftId=<id>
The issuer agreement with the draft's fields filled in. Show this full text
in the app before the signature step.

```json
// 200
{ "network": "devnet", "chain": "solana", "draftId": "uuid",
  "agreementText": "PHASE ISSUER AGREEMENT\n...",
  "agreementHash": "sha256 hex of agreementText",
  "templateNote": "TEMPLATE ONLY — NOT LEGAL ADVICE..." }
```

### POST /api/v1/issuance/sign
Digital signature. No printing, no uploads.

```json
// request
{ "userId": "u_123", "draftId": "uuid",
  "legalName": "Mikyas Tesema", "accepted": true }
// 201 response
{ "network": "devnet", "chain": "solana",
  "signatureId": "uuid", "draftId": "uuid",
  "legalName": "Mikyas Tesema",
  "agreementHash": "sha256 hex", "signedAt": "2026-09-26T..." }
```
`legalName` must be ≥ 2 chars; `accepted` must be exactly `true`.

### POST /api/v1/issuance/mint
Mints the SPL token on Solana devnet (1,000,000 supply, 6 decimals).
**Requires** `Idempotency-Key` header (or `idempotencyKey` in body) — retries
with the same key return the original coin (`idempotentReplay: true`).

```json
// request
{ "userId": "u_123", "draftId": "uuid", "meme": false }
// 201 response
{ "network": "devnet", "chain": "solana", "idempotentReplay": false,
  "coin": {
    "id": "uuid", "draftId": "uuid", "userId": "u_123",
    "signatureId": "uuid", "isMeme": false,
    "name": "MyCoin", "ticker": "MYC",
    "mintAddress": "base58...", "txSignature": "base58...",
    "supply": "1000000", "decimals": 6, "network": "devnet",
    "createdAt": "2026-09-26T..."
  },
  "explorerUrl": "https://explorer.solana.com/address/<mint>?cluster=devnet" }
```
- Non-meme without a signature → `422 signature_required`.
- `"meme": true` skips the signature; coin is flagged `isMeme: true` and
  `signatureId: null`. Offer this in the app as the explicit alternative.

### GET /api/v1/issuance/coins?userId=<id>
List the user's minted coins → `{ coins: [...] }` (same coin shape as above).

### GET /api/v1/issuance/coins/:id
One coin, by coin id or mint address → `{ coin, explorerUrl }`.

---

## Funding (real — Circle testnet, crypto only)

### POST /api/v1/funding/wallets
Create (or fetch) the user's deposit wallets. → `201` new / `200` existing.

```json
// request
{ "userId": "u_123" }
// response
{ "network": "testnet", "userId": "u_123", "created": true,
  "walletSetId": "…",
  "wallets": [{ "walletId": "…", "blockchain": "BASE-SEPOLIA",
                 "address": "0x…", "supportedCurrencies": ["USDC","USDT"] }] }
```

### POST /api/v1/funding/deposit-address
One address for one currency.

```json
// request
{ "userId": "u_123", "currency": "USDC", "chain": "BASE-SEPOLIA" }
// 200/201
{ "network": "testnet", "userId": "u_123", "currency": "USDC",
  "chain": "BASE-SEPOLIA", "address": "0x…", "walletId": "…",
  "supportedCurrencies": ["USDC","USDT"] }
```
`chain` optional (defaults to first configured chain). `currency` optional
(defaults USDC). Supported: **USDC** everywhere; **USDT** on EVM chains only
(rejected on SOL-DEVNET with `unsupported_currency`).

### GET /api/v1/funding/balances?userId=<id>
```json
{ "network": "testnet", "userId": "u_123",
  "totals": { "USDC": { "credited": "20.00", "pending": "0" },
              "USDT": { "credited": "0", "pending": "0" } },
  "chains": [{ "chain": "BASE-SEPOLIA", "address": "0x…",
                "supportedCurrencies": ["USDC","USDT"],
                "onchainBalances": { "USDC": "20.00", "USDT": "0" } }] }
```
`credited` = verified + confirmed deposits only.

### GET /api/v1/funding/deposits?userId=<id>
Deposit history (deposits only; sweeps under `/ledger`).

```json
{ "network": "testnet", "userId": "u_123",
  "deposits": [{ "id": "…", "currency": "USDC", "amount": "20.00",
                 "chain": "BASE-SEPOLIA", "address": "0x…",
                 "txHash": "0x…", "status": "confirmed",
                 "verified": true, "confirmations": 12,
                 "requiredConfirmations": 12,
                 "createdAt": "2026-09-26T..." }] }
```
`status`: `pending` → `confirming` → `confirmed` (or `failed`).

### GET /api/v1/funding/ledger?userId=<id>&refresh=true
Full ledger (deposits + sweeps). `refresh=true` re-checks pending transfers
against Circle directly.

### POST /api/v1/funding/webhooks  (+ HEAD)
Circle delivery endpoint. Not called by the app.

---

## What stays mock (app-side, do NOT wire)

- **Marketplace listings/prices** — mock in-app until real listings source,
  pricing, and seller verification exist.
- **Dashboard figures** — unlock on first deposit or first minted coin;
  read from `/funding/balances` + `/issuance/coins`.
- **Tokenized securities** — sandbox BFF only; live dealer not started.
- **Phi live brain / connector API** — stubs.

## App gating rules (from product)

- Marketplace tab: locked (blurred) until further notice.
- Fund Account: locked until backend deployed + webhook registered.
- Go Live: unlocked now — draft → agreement → digital sign (or meme path) → mint.
- Dashboard: locked until the user has a confirmed deposit or a minted coin.
