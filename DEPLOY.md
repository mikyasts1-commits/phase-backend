# Phase backend — deploy runbook (testnet only)

Nothing here is deployed yet. Follow in order; each step is a manual gate.

## 0. Prereqs (accounts that must exist first)

| Account | Purpose | Status |
|---|---|---|
| Render (free) | web service + Postgres | not created |
| Supabase (free) | Auth (JWTs the app sends as Bearer) | not created |
| Circle Console (testnet) | API key, entity secret, webhook subscription | testnet key exists; webhook NOT registered |
| Finnhub (free) | server-side market data | account exists; key not pasted |

## 1. Environment variables

All in `render.yaml` (values: `sync: false` = paste in the Render dashboard,
never commit). Full list:

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Render Postgres internal URL. The server runs `migrate()` at boot (001–003). |
| `CIRCLE_API_KEY` | yes | Circle **testnet** key. Never a mainnet key. |
| `CIRCLE_ENTITY_SECRET` | yes | Hex secret for developer-controlled wallets (in `.secrets/` locally). |
| `CIRCLE_WALLET_SET_ID` | yes | Already pinned. |
| `CIRCLE_WEBHOOK_SECRET` | yes | HMAC secret; must match the Circle Console subscription. |
| `CIRCLE_CHAINS` | no | Defaults to testnet chains. |
| `SOLANA_MINT_AUTHORITY_JSON` | yes* | *Or upload `.secrets/solana-mint-authority.json` via Render shell. The keypair that signs SPL mints on devnet. |
| `SOLANA_MINT_AUTHORITY_PATH` | no | Override keypair file path. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | when auth lands | App sends Supabase JWT as `Authorization: Bearer`. |
| `FINNHUB_API_KEY` | when market data wires | Server-side only; the app never sees it. |

Local dev: same vars in `phase-backend/.env` (chmod 600). `.secrets/` is chmod 700.

## 2. Deploy steps (Render)

1. Create Render account → **New + → Web Service** → connect the repo
   (or deploy from this directory).
2. `render.yaml` fills build (`npm install`) and start (`npm start`).
3. Add a **Render Postgres (free)** → copy its internal URL → `DATABASE_URL`.
4. Paste the remaining env vars from the table above.
5. Deploy. Verify `GET /healthz` → `{"status":"ok",...}`.
6. Verify `GET /api/v1/issuance/agreement?draftId=...` 404s cleanly (routes mounted).

## 3. Circle webhook registration (after HTTPS is live)

1. In Circle Console → Developers → Webhooks → **Add subscription**:
   - URL: `https://<your-render-host>/api/v1/funding/webhooks`
   - Circle sends a `HEAD` validation on subscribe — the endpoint answers it.
2. Copy the subscription's secret → `CIRCLE_WEBHOOK_SECRET`.
3. Send testnet USDC to a deposit address; watch the ledger row move
   `pending → confirming → confirmed` via `GET /api/v1/funding/deposits?userId=`.

The receiver verifies Circle's signature and dedups by notification id
(`webhook_dedup`). Unknown-token sightings are recorded as `UNKNOWN` and
never credited (fail closed).

## 4. What is intentionally NOT here

- **Mainnet.** `isMainnetUnlocked()` in crypto-funding.ts gates every money
  path; solana-mint.ts hardcodes devnet and throws on mainnet config.
  Mainnet needs: production Circle key + entity secret, `CIRCLE_MAINNET=true`
  + `CIRCLE_MAINNET_CONFIRM=YES`, FINTRAC MSB + Sep-28 legal sign-off,
  Mikyas's explicit approval.
- **Real funds.** Everything is testnet USDC/USDT + devnet SOL. No fiat.

## 5. Currency support (verified 2026-09-26)

- **Circle testnet deposits:** USDC on all configured testnet chains
  (BASE-SEPOLIA, MATIC-AMOY, SOL-DEVNET, ETH-SEPOLIA…); USDT receivable on
  EVM testnet chains (same deposit address — ERC-20). Native BTC/ETH are
  NOT reliably credited by Circle's balance API — the backend only credits
  USDC/USDT (everything else lands as `UNKNOWN`, held for manual review).
- **QCAD:** NOT Circle-supported (Stablecorp asset, no Circle rail).
  Needs a separate rail later (direct on-chain monitoring or another provider).
- **Bitcoin/Ethereum funding:** needs a separate rail (not Circle).
