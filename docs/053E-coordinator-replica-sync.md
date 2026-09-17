# Milestone 053E: Coordinator Replica Synchronization and Recovery

053E adds a bounded synchronization manager around the authenticated 053C
state-transfer and 053D ordering primitives. It schedules recovery; it does
not create coordinator authority.

## Lifecycle and freshness

`CoordinatorReplicaSyncManager` reports `stopped`, `bootstrapping`,
`synchronized`, `stale`, `conflicted`, `unavailable`, `rejected`, and
`retry_wait`. One sync operation may run at a time; concurrent `syncNow()`
calls share the same operation. `start()` is idempotent and `stop()` cancels
the active request and pending retry timer.

Successful imports record the source instance, accepted revision, digest, and
successful synchronization time. Once the configured freshness threshold is
exceeded, status becomes `stale` while the accepted snapshot remains
available. Freshness is an operational lease only; timestamps never replace
revision/digest ordering.

## Outage, retry, and recovery

Transport and temporary coordinator failures retain the last valid snapshot,
report `unavailable` or `retry_wait`, and retry with bounded exponential
backoff. Maximum attempts and delay are configurable and there is no
unbounded timer or queue. Invalid proofs, malformed snapshots, trust
mismatches, revision/digest conflicts, and unsupported input are terminal
outcomes. The manager never promotes a replica.

When the source returns, the normal authenticated importer validates transport
context, snapshot bounds, identity, digest, proof, timestamps, persistence,
and 053D ordering before returning to `synchronized`.

## Conflict and explicit rebootstrap

Conflicts do not choose a local winner. The accepted snapshot remains intact,
the manager reports `conflicted`, and authority classification remains
`non-authoritative`. `resetForRebootstrap()` is an explicit operator-driven
operation. It clears the conflicted in-memory/persisted state, enters a
bootstrap-ready state, and requires a new valid snapshot and proof; restart
does not silently reset state.

Persisted state is still loaded fail-closed by the 053C importer. Corrupt,
missing, digest-invalid, proof-invalid, or schema-invalid state is rejected or
unavailable and may only be replaced through explicit rebootstrap.

## Observability and authority boundary

The manager exposes only aggregate safe status: state, source instance ID,
revision, digest, timestamps, retry count, failure class, retry deadline,
freshness age, persistence-derived metadata, and
`authorityClassification: non-authoritative`. Optional bounded metrics record
attempts, successes, failures, retries, stale observations, and duration.
No files, pieces, credentials, keys, or snapshot contents are emitted.

This is not consensus, election, quorum, fencing, failover, distributed
locking, LWW resolution, client failover, DHT authority, or blockchain
authority. A future promotion design must independently establish exclusive
write authority and split-brain safety.
