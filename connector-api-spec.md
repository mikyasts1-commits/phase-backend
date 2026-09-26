# Phase Public API — Connector Spec (Draft)

The API surface a Muse connector (and any third-party integration) will call.
Design follows Meta's connector guidance: narrow idempotent endpoints, explicit
typed schemas, human-readable errors, least-privilege scopes, audit trails.

Status: DRAFT — backend is not yet deployed; no endpoint here is live.
Legal gate: user-coin issuance/purchase through an agent needs the Sep 28
legal review before real money or real instruments move.

## Base & versioning

- Base URL: `https://api.phase.example` (placeholder — set on deploy)
- Versioned path prefix: `/api/v1`
- Auth: OAuth 2.0 authorization code flow. Muse acts on behalf of the user;
  every mutating call carries the user's token and is approval-gated client-side.

## Scopes (least privilege)

| Scope | Grants |
|---|---|
| `read:coins` | List coins, coin detail, quotes |
| `read:portfolio` | Holdings, balances, transactions |
| `write:listings` | Draft/submit coin listings, sign issuer agreement |
| `write:orders` | Place buy/sell orders |

## Endpoints

### Coins (marketplace)
- `GET /api/v1/coins?category=&search=&limit=&cursor=` — list coins
  → `{ coins: [{ id, name, ticker, category, tagline, priceUsd, marketCap, issuer: { name, socialProfiles: [{ platform, url }] } }], nextCursor }`
- `GET /api/v1/coins/{id}` — full detail (split, agreement status, socials)
- `GET /api/v1/coins/{id}/quote?side=buy&amount=` — executable quote with expiry

### Issuance (go live)
- `POST /api/v1/coins` — draft a listing. Idempotent: requires `Idempotency-Key` header.
  Body: `{ name, category, tagline, equityPublic, equityRetained, socialProfiles: [{ platform, url }], valueThesis }`
  → `{ id, status: "draft" }`
- `GET /api/v1/coins/{id}/issuer-agreement` — returns the agreement text + PDF URL
- `POST /api/v1/coins/{id}/issuer-agreement/sign` — typed e-signature. Body: `{ legalName, accepted: true }`
  → `{ signedAt }`. A coin cannot publish without this.

### Orders & portfolio
- `POST /api/v1/orders` — idempotent (`Idempotency-Key`). Body: `{ coinId, side: "buy"|"sell", amount, currency }`
  → `{ orderId, status: "filled"|"pending", filledPrice }`
- `GET /api/v1/portfolio` — holdings with live values
- `GET /api/v1/transactions?limit=&cursor=` — ledger

## Cross-cutting conventions

- **Idempotency:** all POSTs accept `Idempotency-Key`; duplicate keys return the original result, never double-execute. (Agents retry.)
- **Errors:** `{ error: "code", message: "human-readable sentence the agent may show the user" }`
- **Pagination:** cursor-based, `limit` default 20, max 100.
- **Rate limits:** per-token bucket; `429` with `Retry-After`.
- **Audit:** every agent-initiated mutation is logged with actor=`connector:muse`, user id, timestamp, and full request/response. Agent traffic is queryable separately from human sessions.
- **Money:** no endpoint moves real funds until the dealer/legal/compliance steps land. Until then, responses carry `"mode": "sandbox"`.

## Connector submission checklist (Meta)

1. Live product on a custom domain
2. This API deployed at the public base URL with OAuth working
3. Landing page explaining Phase
4. Privacy policy, terms of service, support contact
5. Connector manifest: name, description, tool list (the endpoints above), auth scheme, scopes requested
6. Submit via muse.ai/platform → three-step Meta review → directory listing

## Sequencing

1. Deploy backend HTTPS (already on the backend roadmap)
2. Real authN/authZ (OAuth2) — required before any connector
3. Implement this spec against the existing BFF modules (securities, funding, guide)
4. Legal sign-off on agent-initiated issuance/trading (extends the Sep 28 review)
5. Submit connector, iterate on review
