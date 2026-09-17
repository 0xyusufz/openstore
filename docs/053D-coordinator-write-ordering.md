# Milestone 053D: Coordinator Replica Write Ordering and Conflict Safety

053D makes replica observation ordering explicit without creating distributed
write coordination or a second authority.

## Ordering tuple

Every accepted observation is bound to:

```text
coordinatorInstanceId + revision + snapshotDigest
```

The same tuple is a duplicate and is idempotent. A lower revision is stale.
The same instance and revision with a different digest is a hard conflict.
A higher revision is accepted only after the configured trusted source,
complete snapshot, and authority proof all validate. A different instance
cannot replace accepted state, and an unknown source is rejected. Timestamps
only enforce freshness/skew; they never decide ordering.

## Replica states and diagnostics

The importer reports `uninitialized`, `bootstrapping`, `synchronized`,
`stale`, `conflicted`, `rejected`, or `unavailable`. `synchronized` means a
validated snapshot was accepted; it never means coordinator authority.
`conflicted` means ordering or source ambiguity exists and cannot serve as an
authority source. Status includes only source instance ID, revision, digest,
validated/import timestamps, persistence health, and an allowlisted conflict
reason. Authority classification remains permanently
`non-authoritative`.

## Atomic conflict handling and persistence

Input, proof, digest, schema, bounds, source identity, and ordering are
validated before installation. Persistence writes a versioned snapshot and
proof through a restrictive temporary file, flushes and atomically renames
it, and leaves the previous state intact if any step fails. Startup validates
the persisted schema, digest/proof relationship, trusted source, and
timestamps. Corrupt or missing state is non-authoritative and unavailable.

No unbounded replay cache is used. Old revisions are rejected, duplicates are
safe to replay, and same-revision digest conflicts remain visible rather than
being overwritten.

## Trust and future HA authority

The replica has one explicitly configured trusted coordinator source. Trust
does not migrate automatically. A valid signature proves snapshot integrity
and signer identity, not exclusive leadership. This milestone does not add
consensus, fencing, quorum, leader election, automatic promotion, failover,
LWW resolution, client failover, DHT authority, or blockchain authority.
Actual HA authority still requires a future authenticated single-writer or
consensus/fencing design.
