# Milestone 053A: Coordinator HA Architecture Foundation

## Current coordinator state classification

The current registry/coordinator remains a single authority.

| State | Role | Durable or derived | Notes |
| --- | --- | --- | --- |
| Node registrations and signed identity bindings | Authoritative registry state | Persisted when persistence is enabled | Determines which node records may be used by placement. |
| Node heartbeat timestamps and availability | Authoritative registry state | Persisted snapshot; continuously updated | Expiry/pruning changes availability and must not be reconstructed from metrics. |
| Capacity and transport metadata | Authoritative registry state | Persisted with node records | Used by placement and replacement selection. |
| Reliability and audit counters | Authoritative registry state | Persisted with node records | Deterministic scores are derived from counters. |
| Expiry worker status and lifecycle | Derived/process-local | Process-local | Rebuilt on startup; does not establish authority. |
| Persistence health and write metadata | Process-local operational state | Process-local | Readiness reflects current persistence health. |
| Replay cache | Process-local security state | Process-local | Bounded and reset on restart; it is not registry history. |
| Metrics | Process-local derived state | Process-local | Bounded series/counters; never placement authority. |
| Events and conditions | Process-local derived state | Process-local | Bounded sanitized observations; never durable authority. |
| Client endpoint snapshot | Client-side cached state | Process-local | May support existing manifest operations, never new placement when stale. |

The registry JSON file is a durable local snapshot, not a replicated log. A
restart can restore it, but a running process, metrics sample, event, or
cached endpoint does not become authoritative merely because it exists.

## Stable coordinator service boundary

`packages/coordinator-ha` defines the minimal future service contract:

- authenticated node registration;
- authenticated heartbeat;
- authenticated unregister;
- node discovery;
- persistence status;
- health/readiness;
- bounded state snapshot metadata.

The interface does not expose registry files, replay-cache internals,
implementation-specific persistence, or a replication protocol. The current
HTTP coordinator remains the only implementation. This contract is
descriptive and additive; it does not route production traffic through a new
adapter yet.

## Instance identity and state versioning

Future coordinator instances need a stable, non-secret `instanceId`. The
current process does not yet persist or publish a coordinator instance
identity. A restart should therefore be treated as a new observation until a
future design defines durable instance identity semantics.

`CoordinatorStateSnapshot` provides bounded metadata:

- protocol version;
- source instance identity;
- non-negative monotonic local `revision`;
- validated observation timestamp;
- `known`, `stale`, or `unknown` state;
- explicit authority boolean.

Local revisions are useful for detecting changes from one source. They are not
Lamport clocks, quorum evidence, or distributed conflict resolution. Equal or
conflicting revisions from different instances remain ambiguous. Future
replication must add an authenticated ordering/authority mechanism rather than
using last-writer-wins.

## Outage semantics

If one coordinator instance fails:

- existing known manifest downloads and deletes may continue under 052B;
- new placement remains blocked unless fresh authoritative coordinator data is
  available;
- repair replacement remains blocked without fresh authoritative data;
- a second reachable instance must not become authoritative solely because it
  responds;
- stale registry state must not silently authorize placement.

Ambiguous authority always fails closed for new placement and repair.

## Future replica bootstrap and split-brain boundary

A future replica must receive an authenticated complete state snapshot, not
just metrics, events, conditions, or a client endpoint cache. The bootstrap
must include all authoritative node records, heartbeat/expiry observations,
capacity, reliability/audit counters, registry revision metadata, and
integrity/format metadata. The receiver must validate the schema, identities,
revision/timestamp bounds, completeness, and durable persistence before
serving authoritative discovery.

Bootstrap from a stale, unavailable, incomplete, or unverifiable source must
leave the replica non-authoritative. It may report `unknown` or `stale`, but
must not place or authorize repairs.

Simple active/standby promotion is unsafe because liveness is not proof of
exclusive authority. Last-writer-wins is insufficient because concurrent
registrations, expiry, capacity, and unregister operations can be lost.
A future leader would require an authenticated authority proof with explicit
single-writer/consensus semantics. During ambiguity, all new placement and
repair selection fail closed; existing manifest operations retain their 052B
behavior.

## Non-goals and unresolved decisions

053A does not add Raft, etcd, quorum, leader election, distributed locks,
external databases, automatic failover, cryptographic revocation, or a second
coordinator deployment. It does not change registry persistence, manifests,
provenance, cryptography, P2P, DHT, or repair algorithms.

Future work must decide how coordinator instance identity persists across
restart, what authority proof a replica accepts, how complete snapshots are
transferred and verified, how writes are ordered, and how clients discover a
single authoritative service without unsafe promotion.
