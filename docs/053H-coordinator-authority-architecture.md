# Milestone 053H: Coordinator Authority & Promotion Architecture

## Decision scope

053H defines the contract for a future authority mechanism. It does not
implement promotion, failover, election, consensus, quorum, fencing, or
client coordinator failover.

The current runtime has exactly one authoritative coordinator: the existing
registry/coordinator. A synchronized replica is an authenticated,
non-authoritative observation. **Identity proof != authority proof.** An
Ed25519 signature proves control of an instance key and integrity of a
snapshot; it does not prove exclusive authority to place data.

## Authority states

The vendor-neutral contract in
`packages/coordinator-ha/authority-contract.ts` classifies a coordinator as:

| State | Placement | Existing known-manifest operations | Export | Import |
| --- | --- | --- | --- | --- |
| authoritative | allowed | allowed | allowed | allowed |
| replica | denied | allowed only through existing cached replicas | denied as authority | allowed |
| stale | denied | allowed through known replicas | denied as authority | allowed |
| conflicted | denied | allowed through known replicas; no winner selection | denied | allowed for operator-controlled recovery |
| unavailable | denied | only already-known safe operations | denied | allowed |
| rejected | denied | denied as coordinator state | denied | allowed after validation |
| unknown | denied | denied as coordinator state | denied | allowed |

Only an explicit future authority mechanism may transition a candidate to
`authoritative`. Synchronization, a higher revision, a newer timestamp, DHT
observation, reachability, or absence of another coordinator never performs
that transition. Ambiguity always fails closed for new placement and repair.

## Required authority evidence

A future promotion mechanism must validate, at minimum:

- authenticated coordinator instance identity;
- a fully validated current state revision and snapshot digest;
- a proof whose signer and instance match the candidate/source binding;
- bounded freshness and anti-replay evidence;
- explicit authorization from the authority mechanism;
- an authority epoch/generation, if adopted;
- evidence that split-brain conditions are excluded;
- durable prior authority state and promotion/revocation audit evidence.

The contract deliberately requires both `proofVerified` and
`explicitlyAuthorized`. A valid snapshot proof alone is insufficient.

## Epoch/generation decision

The current system does **not** adopt or generate an authority epoch. Local
snapshot revision orders observations within one trusted coordinator instance;
it is not an authority generation and cannot distinguish two simultaneous
promotions. Instance identity, revision, digest, and timestamps are therefore
insufficient for safe automatic promotion.

Before promotion exists, an authority epoch must have a single explicit
owner, durable monotonic storage, authenticated issuance, replay protection,
rollover rules, and conflict behavior. A restart, persistence rollback, or
instance change must not create an epoch locally. Defining that owner is an
unresolved architecture decision.

## Split-brain safety

| Situation | Placement/repair | Existing download/delete | Authority action |
| --- | --- | --- | --- |
| Authoritative coordinator reachable | allowed | allowed | source may export |
| Source temporarily unavailable | denied | known replicas may continue | retain state; retry |
| Two coordinators claim authority | denied | known replicas may continue | operator/authority intervention |
| Replica has newer observation without authority proof | denied | known replicas may continue | import only; no promotion |
| Identity changes after restart | denied until explicitly reconciled | known replicas may continue | reject implicit replacement |
| Stale proof | denied | known replicas may continue | reject proof |
| Network partition | denied while ambiguous | known replicas may continue | fail closed |
| Persistence divergence/corruption | denied | known replicas may continue | reject state; explicit recovery |

The current 052B semantics remain unchanged: existing-manifest downloads and
deletes can use known replicas during coordinator outage; new placement and
repair replacement require fresh coordinator authority.

## Future promotion models

The following models remain possible and are intentionally not ranked:

| Model | Authority evidence | Main tradeoffs |
| --- | --- | --- |
| External/manual grant | authenticated operator grant plus durable audit | simple runtime; depends on a secure control plane and human recovery |
| Static primary/standby | configured role plus operator promotion evidence | predictable operations; manual split-brain prevention and failback are required |
| Quorum election | quorum membership and term/epoch proof | tolerates failures; requires membership, quorum, fencing, and more failure semantics |
| Raft/other consensus | committed term and replicated log | strong ordering; substantial protocol, persistence, and operational complexity |
| External coordination service | authenticated lease/epoch from an external authority | delegates coordination; adds dependency, trust, and availability assumptions |

Each model must define stale-return behavior, persistence rollback handling,
revocation, recovery, and how a partitioned coordinator is prevented from
serving placement.

## Future contract

`CoordinatorAuthorityController` defines contract-only operations:
`requestPromotion`, `validateAuthorityGrant`, `establishAuthority`,
`revokeAuthority`, `inspectAuthority`, and `demote`. The current repository
provides no implementation. An implementation must reject calls based only on
local availability, highest revision, latest timestamp, DHT data, network
reachability, or absence of another coordinator.

Operator actions require an authenticated control plane, explicit intent,
authorization evidence, bounded/replay-protected requests, and audit records.
There is no force-promote endpoint.

## Persistence and threat invariants

Authority-safe restart must preserve coordinator instance identity,
authoritative revision, authority status, any future epoch, promotion and
revocation evidence, and relevant audit information. Derived discovery,
metrics, caches, and process-local timers are not authority evidence.
Incomplete or corrupted authority state starts non-authoritative.

The invariants cover stale return after partition, replayed proofs, forged
identity, compromised replicas, snapshot rollback, simultaneous promotion,
network partition, clock manipulation, DHT poisoning, and operator credential
compromise: validate signatures and bindings, require explicit authority
evidence, reject stale/ambiguous state, persist atomically, and fail closed.

## DHT boundary and unresolved decisions

DHT remains discovery only: it may provide peer discovery, transport metadata,
and liveness hints, but never coordinator authority, promotion authorization,
or revocation authority.

Unresolved before any promotion implementation:

- authority epoch ownership and durable issuance;
- split-brain fencing or equivalent exclusion;
- operator versus quorum versus external authority;
- revocation and recovery after persistence rollback;
- authenticated control-plane and audit deployment model.
