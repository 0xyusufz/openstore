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

## Non-goals

052A does not add Raft, etcd, leader election, distributed locks, blockchain,
external discovery infrastructure, DHT consensus, automatic unsafe failover,
new per-piece state, or changes to crypto, manifests, provenance, repair
algorithms, Docker topology, or P2P transport.
