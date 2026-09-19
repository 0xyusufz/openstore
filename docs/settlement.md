# OpenStore Settlement (071) — Internal Settlement Layer

Internal, deterministic settlement that converts economic events into finalized credit transfers. **No blockchain, no external payments, no fiat pricing, no consensus/election.**

## Primitives

- **SettlementRequest** `{id, providerId, consumerId, providerRecord, bytes, durationMs, replicationFactor?, amount?}` — deterministic identity `id` (`^[A-Za-z0-9._-]+$`), provider contribution claim (`providerRecord` + `bytes`/`durationMs`) and consumer charge (`bytes`/`durationMs`/`replicationFactor`) bundled. If `amount` omitted, derived as `calculateConsumerCredits(bytes, durationMs, replicationFactor)` (integer floor).
- **ProviderContributionClaim** — `{providerId, providerRecord, bytes, durationMs}` — validated via `isMarketplaceEligible` (sharing, `available===true`, `availableBytes>0`, trusted capacity). HTTP `lifecycle===undefined` is ineligible (fail-closed).
- **ConsumerCharge** — `{consumerId, bytes, durationMs, replicationFactor}` — derived credits via `calculateConsumerCredits`.
- **FinalizedTransfer** — `{from: consumerId, to: providerId, amount, providerEntryId, consumerEntryId}` — same `amount` debited from consumer and credited to provider, `totalSupply` unchanged (transfer, not issuance).
- **SettlementStatus** `pending | finalized | rejected | failed` — `pending` initial, `finalized` on success, `rejected` deterministic not retryable (ineligible provider, insufficient balance, zero amount, invalid), `failed` transient retryable.

## State Machine

```
request(id) ──> pending ──(validate)──> rejected (ineligible/zero/invalid/insufficient)
                pending ──(transfer)──> finalized (amount balanced, ledger entries appended)
                pending ──(error)──> failed (retryable via retrySettlement)
                finalized/rejected ──(replay same id)──> same record, no duplicate transfer
                failed/pending ──(retrySettlement)──> re-validates and attempts transfer
```

- `requestSettlement(req)` is idempotent on `req.id`: same `id` returns existing record without new transfer or balance change. Different `id` with same content is separate settlement.
- `getSettlement(id)` and `listSettlements()` return copies.
- Finalized records are append-only; never mutated or deleted (`settlements` Map only adds, never updates finalized).

## Balancing & Safety

- `amount` is integer-safe via `calculateConsumerCredits` (`BigInt` floor, `MAX_SAFE_INTEGER` check).
- Finalized settlement: `provider delta = +amount`, `consumer delta = -amount`, same `amount`, same `timestamp` for both ledger entries, `totalSupply` unchanged.
- `consumerBalance < amount` → `rejected` before any ledger mutation, no negative balances.
- `providerRecord` ineligible (draining/released/unavailable/stale/HTTP undefined) → `rejected`.
- `amount===0` → `rejected` (no transfer).
- `transferCredits` used from `packages/economics` (reuses ledger, no competing balances), idempotent on `eventId = settlement id`.

## Separation

- **Economics calculation** — pure `calculateProviderCredits`/`calculateConsumerCredits` in `packages/economics`.
- **Settlement authorization/finalization** — `packages/settlement` validates eligibility/balance, calls `economics.transferCredits`.
- **Marketplace discovery** — `packages/marketplace` read-only capacity listing, not coupled to settlement.

## Determinism & Idempotency

- Settlement `id` is caller-provided deterministic identity (e.g., `fileId:chunkId:period`). Repeating `requestSettlement` with same `id` yields same `SettlementRecord` (same `status`, `amount`, `providerEntryId`/`consumerEntryId`), no second transfer.
- Different periods use different `id` (or different `bytes`/`duration`/`providerId`/`consumerId`) → separate `finalized` settlements, each with distinct ledger entries.
- All credit math uses `Number.isSafeInteger` inputs and `BigInt` intermediate, throws on overflow.

## Failure / Retry

- `rejected` — deterministic, not retryable via same `id` (ineligible, insufficient, invalid). Caller must fix inputs and use new `id`.
- `failed` — transient (e.g., `balance would exceed safe integer`), retryable via `retrySettlement(id)` which re-validates and attempts transfer.
- `pending` — initial, retryable similarly.

## Invariants

- `finalized` amount equals both provider credit and consumer debit (balanced).
- No negative balances; `totalSupply` unchanged by settlement transfers.
- Append-only: `listSettlements()` length never decreases, finalized records never mutated.
- Same `id` → same result, no duplicate ledger entries.
- Ineligible provider never yields `finalized`.

## Future

- 072 may add blockchain/token or external settlement, but 071 remains internal/off-chain and must not be extended with speculative consensus.
