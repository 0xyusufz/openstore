# Milestone 052A: Coordinator HA and discovery failure model

## Current authority boundaries

| Boundary | Current authority | Failure consequence |
| --- | --- | --- |
| Registration and signed heartbeat | `packages/registry/index.ts` through the coordinator API | New/returning nodes cannot become authoritative while unavailable. |
| Expiry/pruning | Registry heartbeat timeout and optional coordinator expiry worker | Availability can become stale until the coordinator runs again. |
| Placement and capacity | Coordinator registry snapshot consumed by `apps/client/selection.ts` and upload | New placement fails closed without a fresh snapshot. |
| Existing replica resolution | Manifest replica IDs plus client endpoint catalog | Download/delete may try known replicas during an outage; no replacements are invented. |
| Persistence | Atomic, fsync-backed registry file | Coordinator restart can recover the last durable registry; HA is not provided. |
| Repair candidate discovery | `RepairScheduler`/`repair.ts` call `CoordinatorEndpointProvider.refresh()` | Repair requires bounded fresh observations and pauses/retries on outage. |
| Node heartbeat/reconnect | Storage-node runtime and signed registry client | Node remains local, but registration/heartbeat is unavailable until coordinator recovery. |

## Live versus cached dependencies

Uploads with coordinator-driven placement require a successful fresh coordinator
refresh. Downloads and deletes of an existing manifest use only the manifest's
recorded replica identities and the client's known endpoint catalog; they do not
add replicas during an outage. Repair requires fresh coordinator observations so
it cannot place a replacement from stale capacity or availability data. Node
startup can initialize local identity/storage without a coordinator, but
registration is deferred/fails according to the existing runtime lifecycle.

## Failure matrix

| Condition | Upload | Download | Delete | Repair | Node heartbeat |
| --- | --- | --- | --- | --- | --- |
| Coordinator unavailable, known endpoints available | Fail closed for new placement | Continue against known manifest replicas | Continue against known manifest replicas | Retry/pause; no replacement | Reconnect later |
| Coordinator unavailable, no known endpoints | Fail | Fail | Fail | Fail/pause | Local node can remain initialized |
| Fresh discovery unavailable, cached snapshot present | Do not place new replicas | Use cached endpoints only | Use cached endpoints only | Do not replace replicas | Keep retrying |
| Cached snapshot stale | Do not treat as fresh capacity | Best-effort existing-replica attempts only | Best-effort existing-replica attempts only | Fail closed for replacement | Reconnect |
| Node reachable, coordinator unavailable | Not authoritative for placement | Direct authenticated read may work | Direct authenticated delete may work | No new target selection | Node remains reachable locally |

## Capability model

`packages/discovery-state` provides a small additive model with `fresh`,
`cached`, `stale`, and `unavailable` states. It records only timestamps,
source class, endpoint count, and safe operation capabilities. Fresh information
is coordinator-sourced and within the configured age bound. Cached information
is known-good information that can support existing-replica operations but
cannot authorize new placement. Stale information is retained for diagnosis
and best-effort existing access only. Unavailable information has no usable
endpoint snapshot.

## DHT audit

`packages/p2p/dht-discovery.ts` publishes versioned `openstore-peer-v1` records
containing validated peer descriptors, identity bindings, capabilities, and
addresses. Records are obtained through signed/identity-bound libp2p transport
and descriptors are validated before use. Bootstrap peers are static inputs;
each dial/query has a one-second timeout and failures do not stop startup.
Refresh removes peers that disappear from the current query result.

The current DHT implementation does not add an application-level record
expiry/freshness timestamp, revocation record, or durable disappearance
authority. Kademlia record lifetime and provider disappearance therefore remain
future failure-model work. A stale descriptor may remain discoverable until DHT
replacement/expiry, and DHT discovery is intentionally separate from
coordinator-authoritative placement.

## Proposed 052B boundary

Milestone 052B implements this boundary through the additive
`CoordinatorCapabilitySnapshot` exposed by the client adapter and the
`packages/discovery-state` model. A successful coordinator observation with
at least one usable endpoint is `fresh` for the configured lease (30 seconds
by default). A failed refresh retains the last known-good endpoint set but
marks it `cached` while within the bounded stale window (five minutes by
default), then `stale`; no endpoints is `unavailable`.

Upload/new placement and repair replacement require `fresh` and fail with
typed contextual errors when the coordinator is unavailable or information
is stale. Existing-manifest download and delete continue to use their known
manifest replicas and never invent replacements. The adapter coalesces
refreshes and retains bounded metadata only; it does not add timers or
unbounded retries.

A future HA layer may replicate the registry behind this stable
coordinator/discovery interface, but consensus, leader election, quorum, and
external databases remain outside 052B.

## 052C operational state visibility

The client adapter exposes the same bounded state model through diagnostics:
`fresh` is a recent successful coordinator observation that may drive new
placement and repair; `cached` is known information retained after a failed
refresh and is usable only for existing manifest replicas; `stale` is beyond
the bounded retention window and cannot drive placement; `unavailable` means
there is no usable observation; and `reconnecting` is a transient,
refresh-in-progress state. Observation age, endpoint count, and placement
availability are the only exposed fields.

State transitions are emitted once through the bounded event store and
refresh outcomes use low-cardinality metrics. The condition evaluator exposes
one deterministic condition for each state. Coordinator status, health, and
condition responses may include the same safe aggregate when an adapter is
wired into them. This is process-local and reset on restart; readiness,
authentication, and operation policy are unchanged.

## 052D DHT freshness and trust boundary

DHT records are discovery-only and never authorize placement. OpenStore now
wraps descriptors in a versioned record envelope containing `publishedAt`.
Records are accepted only when their timestamp is a non-negative safe integer,
not more than 30 seconds in the future, and no older than five minutes at
observation time. A DHT query does not refresh or extend a record's age.

The trust states are `fresh`, `stale`, `invalid`, and `unavailable`.
Stale or invalid records are ignored rather than passed to peer refresh
callbacks. Rejections are counted by bounded low-cardinality metrics with only
`stale` or `invalid` reasons. Valid records continue to require the
OpenStore Ed25519 public identity to derive the libp2p PeerId, an equal
identity binding, and a matching `/p2p/` multiaddr suffix. Descriptor
validation rejects private material recursively.

Coordinator observations remain authoritative for placement and replacement.
DHT does not override newer coordinator data, and no signed revocation record
was added; revocation, durable expiry, and DHT record replacement authority
remain future work.

## 052E authority boundary

`packages/authority` provides the small immutable authority model used to make
this boundary explicit. A fresh coordinator observation is
`coordinator-authoritative` only when the caller explicitly marks it as
coordinator-authoritative. A fresh DHT observation is always
`dht-discovered` and can never authorize placement. Stale, invalid, and
unavailable observations remain those classifications regardless of their
source. Existing-replica usability is separate from placement authority.

When observations disagree, reconciliation deterministically selects the
coordinator as the placement winner when it has a fresh authoritative
observation; otherwise there is no placement winner. DHT may still assist
peer discovery. Neither DHT disappearance nor coordinator disappearance is
interpreted as cryptographic revocation, and reconciliation exposes
`revocation: not-established`.

Future revocation requires a separately defined authorizing identity, a
signed statement binding that identity to the revoked peer identity,
authenticated verification and bounded freshness/replay checks, and explicit
outage semantics. The current architecture does not provide that authority,
so no revocation is implemented.

## Non-goals

052A does not add Raft, etcd, leader election, distributed locks, blockchain,
external discovery infrastructure, DHT consensus, automatic unsafe failover,
new per-piece state, or changes to crypto, manifests, provenance, repair
algorithms, Docker topology, or P2P transport.
