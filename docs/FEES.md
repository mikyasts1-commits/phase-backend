# Phase 80-bps Transaction-Fee & Treasury System

**Status:** corrected model implemented, code-verified, not yet device-tested.
**Legal disclosure (shown in-app before every confirmation):**
> Phase charges 0.80% on applicable transactions.

## 1. Overview

Phase collects an 80 basis-point (0.80%) fee on eligible transactions. The
backend is the **authoritative** fee calculator: it computes the fee, records
it immutably, routes it to the Phase treasury, and discloses it to the user
before confirmation. The client is never trusted for fee amounts, rates,
treasury destinations, or settlement amounts.

Fees are **always denominated in the transacted/purchased asset** — never in
USD deducted from seller proceeds.

Eligible transactions (v1):

| Type | Fee base | Who pays | Denomination |
|---|---|---|---|
| `marketplace_buy` | gross purchased-asset units | buyer (deducted from received coins) | purchased coin |
| `marketplace_swap` | gross target-coin units the buyer receives | buyer (deducted from received coins) | target coin |

Buyer experience on a buy: the buyer pays exactly the quoted gross USD and
receives **net** coin units (gross − fee); the fee units are sent on-chain to
the Phase treasury sovereign address. **The seller receives the full gross
USD proceeds — no fee is ever deducted from seller proceeds.** On a swap the
buyer receives net target units and the fee goes on-chain to the Phase
treasury sovereign address.

Canonical example: gross 10,000 PHI → 80 PHI treasury fee → 9,920 PHI to the
buyer.

## 2. Rounding rule (deterministic, documented, tested)

All fee math uses **BigInt integer arithmetic** — never JavaScript floating
point in the authoritative path. Amounts are parsed from exact decimal
strings (or exact integer strings) straight into BigInt base units via the
asset precision registry (`fee.ts`: `assetDecimals`, `toBaseUnits`,
`coinUnitsToDecimal`, `decimalToCoinUnits`).

- USD amounts: 6-decimal microunits (1 USD = 1,000,000 microunits).
- Coin amounts: whole units (coins are indivisible on the sovereign chain;
  fractional coin input is rejected, never truncated).

```
fee_bps            = 80 (server-controlled, versioned; see §4)
fee                = floor(gross_base_units × fee_bps / 10_000)
net                = gross_base_units − fee
```

Flooring means the fee never exceeds 80 bps and the user never pays more
than the quoted gross. Sub-minimum-unit remainders stay with the fee payer's
net — they are never credited to Phase.

Boundary examples (80 bps, coin units):

| Gross | Fee | Net |
|---|---|---|
| 10,000 PHI | 80 PHI | 9,920 PHI |
| 125 units | 1 | 124 |
| 124 units | 0 | 124 |
| 1 unit | 0 | 1 |

## 3. Architecture

```
fee.ts            — fee engine: integer math, versioned config, treasury
                    abstraction, fee ledger, withdrawals, reconciliation,
                    asset precision registry
marketplace.ts    — fee settlement integrated into buy/swap settlement:
                    atomic money legs, idempotency keys, compensation,
                    crash-safe coin legs, boot reconciliation
admin.ts          — admin-only treasury API (balances, withdrawals,
                    config, reconciliation)
016_fee_treasury.sql — fee_config, treasury_accounts, treasury_balances,
                    fee_ledger, treasury_withdrawals, reconciliation_runs
```

### 3.1 Buy settlement (corrected model)

```
1. quote (GET /api/v1/trades/quote)
     server computes, integer-exact:
       units     = floor(amount_usd / price_usd)          (whole coins)
       gross_usd = units × price_usd                       (6dp USD)
       fee_units = floor(units × 80 / 10_000)              (whole coins)
       net_units = units − fee_units                       (whole coins)
     client displays: you pay (gross USD), gross (units),
     Phase fee (fee units + ticker), you receive (net units),
     plus the disclosure sentence.
2. money leg (Postgres, ONE transaction):
     insert fee_ledger row (status 'pending', idempotency guard)
       → debit buyer USD (gross)
       → credit seller USD (gross, IN FULL — no fee deducted)
   Idempotent: the fee row is inserted FIRST; a retry after a crash
   between COMMIT and the attempt-state update sees the row and returns
   { replayed: true } without moving cash twice.
3. coin leg (sovereign chain, crash-safe):
     float → buyer (net units), then float → Phase treasury (fee units).
     Each transfer's tx id is persisted to the attempt row immediately,
     so a retry can never double-transfer.
     Fail closed: when a fee is owed, the treasury sovereign address
     must be configured — trades never settle while fee collection is
     impossible.
4. fee collection (Postgres, ONE transaction):
     mark fee row 'settled' + credit treasury_balances (ticker, fee units).
     Idempotent on the fee key.
5. trade recorded; the fee row is attached to the trade for history.
```

On coin-leg failure: any completed on-chain transfer is reversed
(best effort), then the money leg is unwound (seller → buyer, gross USD)
and the fee row is marked reversed — never throws; the original error
propagates.

### 3.2 Swap settlement

The offer leg moves first (buyer → issuer on the offer chain). The target
leg then sends net units to the buyer and the fee units to the Phase
treasury sovereign address, with the same crash-safe incremental
persistence. The immutable fee record is written after the target leg;
boot reconciliation (`recoverSwapFee`) covers the crash window between the
on-chain fee transfer and the ledger insert.

### 3.3 Treasury

- `treasury_accounts` / `treasury_balances`: asset-specific balances
  (one row per asset — USD, PHI, …). The treasury account row is created
  **inside** the settling transaction (never on a separate connection),
  so FK ordering is safe.
- `PHASE_TREASURY_ACCOUNT_ID` is an opaque account id, not a key.
  Private keys and bank credentials live in server-side secret management
  only — never in the repo, APK, bundle, logs, or analytics.
- Withdrawals go through official regulated provider APIs only, with
  admin authorization — never scraped credentials or browser automation.
- Provider webhooks, where applicable, must be signed, idempotent, and
  support refunds/chargebacks.

### 3.4 Reconciliation

`runFeeReconciliation(days)` verifies, per asset:
`sum(fee_ledger settled) − sum(reversed) == treasury_balances`. Results are
stored in `reconciliation_runs`; mismatches raise alerts. Boot
reconciliation (`reconcileSettlements`) finishes or unwinds settlement
attempts stuck by a crash, reusing the exact persisted fee split.

## 4. Configuration

`fee_config` is versioned and server-controlled:

| Column | Meaning |
|---|---|
| `fee_bps` | current rate (80) |
| `version` | increments on every change |
| `changed_by` / `changed_at` / `reason` | audit trail |

- A cached copy is invalidated on update.
- In-flight settlements keep the rate recorded on their attempt row —
  a mid-flight config change can never alter an in-flight trade.
- Admin-only changes via `admin.ts` (audited; see §6).

## 5. API surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/trades/quote?chainId=&amountUsd=` | user | buy quote: gross/net/fee units + USD |
| `GET /api/v1/trades/swap-quote?…` | user | swap quote: gross/net/fee units |
| `POST /api/v1/trades/buy` | user | buy with fee; response includes `fee` object |
| `POST /api/v1/trades/swap` | user | swap with fee; response includes `fee` object |
| `GET /api/v1/trades/history` | user | trades with attached fee rows |
| `GET /api/v1/admin/treasury/*` | admin | balances, withdrawals, config, reconciliation |

Buy `fee` response object:

```json
{
  "feeBps": 80,
  "assetSymbol": "PHI",
  "grossUnits": "10000.000000",
  "feeUnits": "80.000000",
  "buyerReceivesUnits": "9920.000000",
  "grossUsd": "10000.000000",
  "sellerReceivesUsd": "10000.000000",
  "treasuryAccountId": "phase_treasury",
  "feeTxId": "tx_…",
  "disclosure": "Phase charges 0.80% on applicable transactions."
}
```

## 6. Admin controls (audited)

- View per-asset treasury balances and the immutable fee ledger.
- Change the fee rate (versioned, audited, never retroactive).
- Request/approve/execute treasury withdrawals (multi-state workflow with
  external references; execution records the provider reference — it is not
  itself bank settlement).
- Run reconciliation on demand; review reconciliation runs.
- All admin actions are audit-logged with the acting admin's identity.

## 7. Invariants (tested)

- `fee = floor(gross × bps / 10_000)`; `net = gross − fee`; `fee + net = gross`.
- Buy: buyer debited gross USD; seller credited gross USD in full;
  buyer receives net units; treasury receives fee units.
- Duplicate idempotency keys never double-move money or double-collect fees.
- Failed money legs leave no fee row and move no balances.
- Reversed fees return balances to their pre-settlement state.
- Reconciliation: settled − reversed fees == treasury balances, per asset.

Run: `npx tsx test-fees-math.ts` (72 unit tests, no DB) and
`DATABASE_URL=… npx tsx test-fees-integration.ts` (DB-backed).

## 8. Production readiness

- [x] Exact integer math, deterministic rounding, idempotency, atomic legs
- [x] Crash-safe coin legs, boot reconciliation, compensation paths
- [x] Admin API with audited controls, disclosure in UI and API
- [ ] Isolated-Postgres integration test run (no local Postgres available)
- [ ] Deploy migration 016 + code; smoke-test fee/admin routes live
- [ ] Corporate bank info + regulated provider selection (Mike to supply)
- [ ] Provider verification, KYC/AML, legal approval, Play declarations
- [ ] Device-tested release build

**Out of scope for v1:** `securities.ts` (tokenized stocks/ETFs) is
testnet/sandbox-only, unmounted from the fee engine, and uses JS floats
end-to-end — it must not be fee-bearing until it is rebuilt on exact
integer math and integrated with the fee ledger.

Gross transaction volume is **not** Phase revenue. Phase revenue is the
collected fee units only, recognized when the fee settles on-chain and is
recorded in the fee ledger.
