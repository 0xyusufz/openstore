# OpenStore Economics (070) — Internal Credits

Internal, deterministic accounting for future marketplace usage. **No real money, fiat prices, blockchain, or settlement finality.** All values are integer credits.

## Goals

- Provide a minimal, auditable credit ledger that can support marketplace consumption without coupling to marketplace discovery.
- Keep provider and consumer accounting separate.

## Units & Conversions

- **Base unit:** 1 credit (integer, `0 .. Number.MAX_SAFE_INTEGER`).
- **Constants:**
  - `BYTES_PER_GIB = 1024^3`
  - `MS_PER_HOUR = 3_600_000`
  - `CREDITS_PER_GIB_HOUR = 1` — 1 GiB allocated for 1 hour earns/spends 1 credit.
- **Conversion (integer-safe, floor):**
  `credits = floor(bytes * durationMs * CREDITS_PER_GIB_HOUR * replicationFactor / (BYTES_PER_GIB * MS_PER_HOUR))`
  Uses `BigInt` internally, then checks `<= MAX_SAFE_INTEGER`. No floating point.
- **Deterministic:** same `bytes, durationMs, replicationFactor` always yields same credits.

## Accounts

- `AccountId` matches `^[A-Za-z0-9._-]+$`, 1–256 chars (public identifier, e.g., provider nodeId or consumer id).
- `Account {id, balance, createdAt}` — balance is non-negative safe integer.
- Balances never negative; spends that would go negative throw `insufficient balance`. No overdraft.

## Provider Contribution (earn) — Idempotent

- `recordProviderContribution(providerId, NodeRecord, durationMs, eventId?)` — reuses `isMarketplaceEligible` from `packages/marketplace` (draining/released/unavailable/stale/invalid capacity and HTTP `lifecycle===undefined` are ineligible). Only `lifecycle==="sharing"` with `available===true` and `availableBytes>0` generates credits.
- Credits based on `allocatedBytes` (contributed capacity), not `usedBytes`, so idle capacity still earns when eligible.
- Ineligible or zero-duration yields `0` and no ledger entry (auditable via snapshot totals).
- **Idempotency (070 hardening):** each provider contribution period has a deterministic event identity. If `eventId` is provided, the key is `id:eventId|providerId|nodeId|allocatedBytes|durationMs`; otherwise it is `auto:providerId|nodeId|allocatedBytes|durationMs`. Repeating the exact same `providerId, NodeRecord, durationMs, eventId` does **not** create a second ledger entry, does not double `balance`, and does not increase `totalSupply`. A genuinely different period (different `eventId` or different `allocatedBytes`/`durationMs`/`nodeId`) is a separate earnings event and is recorded. Ledger remains append-only; prior entries are never mutated or deleted.

## Consumer Usage (spend)

- `recordConsumerUsage(consumerId, bytesStored, durationMs, replicationFactor)` — `credits = f(bytesStored, durationMs, replicationFactor)`.
- Requires sufficient balance; otherwise fail-closed.
- `spendCredits(consumerId, amount)` for explicit marketplace consumption.

## Marketplace Separation

- `packages/marketplace` lists *available* capacity (`availableBytes`) for discovery, independent of economics.
- Economics `recordProviderContribution` consults `isMarketplaceEligible` for eligibility but does not mutate marketplace listings.
- `getMarketplaceSnapshot` and economics `getSnapshot` are independent.

## Ledger / Audit

- `LedgerEntry {id, timestamp, accountId, type, amount, delta, balanceAfter, reason, metadata}` where `type` is `issuance|earn|spend|adjustment`, `delta = +amount` for earn/issuance, `-amount` for spend, `balanceAfter` is post-state.
- Ledger is **append-only**: `getLedger()` returns copies; no update/delete API; `id` monotonic.
- `issuance` increases `totalSupply`; `earn` increases both balance and `totalSupply`; `spend` decreases balance but not `totalSupply` (supply tracks issued+earned; spends are allocation). Snapshot `{version, totalSupply, accountCount, ledgerCount, generatedAt}`.

## Invariants

- `balance >=0` for all accounts.
- `totalSupply == sum(issuance + earn)` (spends do not reduce supply; net supply auditable via ledger).
- Repeated `calculateProviderCredits`/`calculateConsumerCredits` with same inputs yields same output.
- Ineligible `NodeRecord` never yields `earn` credits.
- **Provider earn idempotency:** same `providerId, NodeRecord, durationMs, eventId` → single `earn` entry; second submission returns `0` credits, `null` entry, no balance/totalSupply change, ledger remains append-only.
- All credit math uses `Number.isSafeInteger` inputs and `BigInt` intermediate, throws on overflow.

## Future (071+)

- Settlement, real payments, fiat, blockchain, or token contracts are out of scope and must not be inferred from these primitives.
