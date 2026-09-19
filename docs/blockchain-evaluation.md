# OpenStore 072 — Blockchain IF REQUIRED: Architecture Evaluation

**Context:** 068 Provider UX, 069 Marketplace, 070 Economics, 071 Settlement are complete and pushed at `49c4b3e` (economics) / `settlement` internal. System has coordinator-authoritative control plane, deterministic internal credits (`packages/economics`), append-only in-memory ledger with idempotent `recordProviderContribution` and `transferCredits`, `packages/settlement` with `pending→finalized|rejected|failed` and replay-safe `id` (= `eventId`), provider lifecycle `sharing→draining→released`, marketplace `isMarketplaceEligible` requiring explicit `lifecycle==="sharing"`, client-side encryption mandatory, no real money, no blockchain.

**Question:** Does OpenStore's *intended* architecture and economics require a blockchain, or can the existing signed/idempotent off-chain model satisfy it?

## Requirements Matrix

| # | Requirement | Current off-chain solution | Gap | Blockchain actually required? |
|---|-------------|----------------------------|-----|-------------------------------|
| 1a | **Coordinator authority** — single source of truth for node records, lifecycle, capacity | `packages/registry` + `packages/coordinator-ha` (single authoritative coordinator, `Registry` with `registerSigned`/`heartbeatSigned`, idempotent settlement via `settlement.id`/`economics seenTransfers`) | Single trusted coordinator; no BFT. If coordinator is compromised or partitions, no second authoritative writer. | **No** for current trusted-coordinator model. **Yes** only if we need multi-writer without trusted coordinator. |
| 1b | **Provider/consumer identities** | `packages/identity` Ed25519, `AccountId` `^[A-Za-z0-9._-]+$`, `NodeRecord.nodeId = base64(publicKey)`, settlement `providerId`/`consumerId` validated. | Identities self-sovereign, but binding to coordinator record is via coordinator signature, not on-chain. | **No** — Ed25519 already suffices; blockchain would only add global registry, not needed for current trust. |
| 1c | **Settlement trust boundaries** | `packages/settlement: requestSettlement` validates `isMarketplaceEligible`, derives `amount = floor(bytes*duration*rate)`, checks `consumerBalance>=amount`, then atomic `economics.transferCredits(consumer→provider, amount, "settlement:"+id, id)` (balanced, `totalSupply` unchanged, append-only). | Trust is coordinator + `economics` in-memory. No external verifiability if coordinator is untrusted. | **No** for internal settlement with trusted coordinator. |
| 2 | **Double-spend prevention** | Deterministic `transferKey = transfer:${eventId}|${from}|${to}|${amount}` in `seenTransfers` + `seenProviderEvents` + settlement `id` map; same `eventId`/`settlement.id` → `null`/existing record, no second debit/credit; `balance>=amount` check before mutation. | Works only while single `createEconomics`/`createSettlement` instance is authoritative. Cross-process or multi-coordinator double-spend would require shared log. | **No** for single coordinator; **Yes** for multi-party double-spend without trusted coordinator. |
| 3 | **Multi-party settlement without trusted coordinator** | Not supported; settlement requires `createSettlement(economics)` with authoritative `economics` + `isMarketplaceEligible` via coordinator. | If provider and consumer run independent coordinators that do not trust each other, no shared settlement log. | **Yes** — this is the first genuine blockchain/consensus trigger. Current model explicitly trusts coordinator (`docs/053A` says second instance must not become authoritative solely because it responds). |
| 4 | **Auditability / verifiability of economic history** | `getLedger()` returns copies, `id` monotonic, `totalSupply == sum(issuance+earn)`, `calculate*` pure, settlement `providerEntryId`/`consumerEntryId` linked. In-memory, not persisted, not cryptographically chained. | No durability (restart loses ledger), no tamper-evidence, no third-party verifiability. `docs/economics.md` notes ledger is append-only but not persistent. | **No** for internal audit (persistence via file/DB would suffice). **Yes** only if we need *public, tamper-evident, third-party verifiable* history without trusting coordinator storage. |
| 5 | **Provider incentives across independently operated nodes** | Provider `earn` via `recordProviderContribution` (1 credit/GiB-hour) when `lifecycle==="sharing"` and `available` and `availableBytes>0`; marketplace lists `availableBytes`. Incentive relies on coordinator honesty to credit. | Independent operators must trust coordinator to credit correctly; no slashing or proof-of-storage. | **No** for cooperative testnet with trusted coordinator. **Yes** for trustless incentives/slashing (requires proof-of-storage + on-chain adjudication). |
| 6 | **Cross-organization / cross-account settlement** | `transferCredits` is internal, `AccountId` is just a string, no org boundary. Works within one `createEconomics` domain. | No org-scoped accounts, no external settlement rails, no dispute across orgs that run separate coordinators. | **No** for single-org internal credits. **Yes** if 072 intends settlement *between* organizations that do not share a coordinator. |
| 7 | **Recovery, dispute, replay protection** | `recordProviderContribution` dedupes on `providerId|nodeId|allocated|duration|eventId`; `transferCredits` dedupes on `transfer:${eventId}|from|to|amount`; `settlement` dedupes on `id` with `pending→finalized|rejected|failed` and `retrySettlement` only for `pending`/`failed`. `getLedger`/`listSettlements` append-only. | Recovery from coordinator crash loses in-memory ledger (no persistence beyond 071). No dispute arbitration beyond `rejected` reason. | **No** — persistence (file/DB) + idempotency already covers replay; blockchain would only add *untrusted* recovery. |
| 8 | **Can signed/idempotent settlement satisfy without blockchain?** | Yes, for current model: `isMarketplaceEligible` (sharing vs draining/released, HTTP `undefined` fail-closed), `calculate*` pure `BigInt` floor, `transferCredits` atomic (validate → mutate both balances → append two entries with same `timestamp` → add `seenTransfers` only after success, rollback on failure), `requestSettlement` idempotent on `id`, `totalSupply` unchanged for transfers, no negative balances. | Fails only when requirement 3 is added (no trusted coordinator). | **Yes — current off-chain suffices.** |
| 9 | **What would genuinely require blockchain** | — | — | See below. |
| 10 | **Operational / privacy costs & attack surface of blockchain** | Off-chain: no public ledger, no gas, no consensus, no smart-contract bugs, encrypted `bytes` never on-chain. | Blockchain would publish `providerId`, `consumerId`, `amount`, `bytes`, `duration`, `timestamp` (even if `bytes` encrypted, metadata leaks), require operating consensus nodes, bridge to off-chain storage, and add re-entrancy/consensus attacks. | Blockchain **adds** cost without benefit for current model. |

## What Genuinely Requires a Blockchain vs. What Remains Off-Chain

**Remains off-chain (current and intended):**
- Deterministic credit calculations (`BYTES_PER_GIB`, `MS_PER_HOUR`, `CREDITS_PER_GIB_HOUR`, `BigInt` floor) — pure functions.
- Provider eligibility (`lifecycle==="sharing"`, `available`, `availableBytes>0`, `hasTrustedCapacity`) — in `packages/placement`/`marketplace`.
- Idempotent `earn`/`transfer`/`settlement` with `seen*` sets and `amount` balancing — in-memory with future file persistence.
- Marketplace discovery (`availableBytes` listing) — read-only, no economics coupling.
- Client-side encryption (AES-GCM per chunk, `packages/crypto`) — never on-chain.

**Would genuinely require blockchain (or equivalent BFT log):**
- Multi-writer settlement without a trusted coordinator (provider and consumer each run a coordinator that do not trust each other).
- Public, tamper-evident, third-party verifiable audit log without trusting coordinator storage.
- Trustless provider slashing / proof-of-storage challenges.
- Cross-organization settlement where organizations do not share `createEconomics` instance.
- Tokenization for real-money exit or external exchange.

None of these are in the current intended economic model (internal credits, `49c4b3e`, no fiat, no external payments).

## Recommendation

**A) Blockchain not required now.**

The existing `coordinator → marketplace → economics → settlement` stack satisfies the current intended model with a trusted coordinator:

- Double-spend prevented by single authoritative `seenTransfers`/`settlement.id` + `balance>=amount` check.
- Replay-safe via deterministic `id`/`eventId`.
- Auditability via append-only `getLedger()`/`listSettlements()` (add file persistence in next hardening, not a chain).
- Ineligible capacity (draining/released/HTTP `undefined`, `available===false`, `availableBytes<=0`) never earns or settles.

## Architecture Implications for A

- Keep `coordinator` authoritative; do not add smart contracts, token contracts, or consensus.
- Harden off-chain instead: add durable append-only file for `economics`/`settlement` ledgers (atomic `tmp+fsync+rename` like `packages/registry`), keep `transferCredits` internal to `settlement` (already `reason.startsWith("settlement:")` + `eventId` required).
- Keep `packages/placement` as single source of eligibility; `isMarketplaceEligible` remains `lifecycle==="sharing"` fail-closed for HTTP.
- Preserve `docs/economics.md`/`docs/settlement.md` invariants; add this evaluation as `docs/blockchain-evaluation.md` and reference from `OPENSTORE_ROADMAP_HANDOFF.md` if needed.
- If future `072` is re-scoped to *cross-organization trustless* settlement, re-evaluate **B** (blockchain justified for that specific capability) with explicit threat model, privacy (no `bytes`/`providerId` on-chain, only commitments), and cost analysis — still no speculative token design now.

**Not C:** Blockchain is not required for the current internal-credits model; adding it now would increase operational/privacy cost and attack surface without closing a real gap.
