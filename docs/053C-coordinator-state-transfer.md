# Milestone 053C: Coordinator Replica State Transfer

053C adds a bounded runtime contract for transferring an authenticated
coordinator snapshot to a future replica. It does not create a second
coordinator authority.

## Flow and trust boundaries

The exporter accepts a versioned bounded request and returns a complete
snapshot plus the 053B Ed25519 authority proof. The receiver separately
checks transport authentication, trusted source identity, schema and size
bounds, canonical digest, proof signature, timestamps, node records, and
completeness. Transport authentication only authenticates the channel; it is
not snapshot integrity or coordinator authority. The proof authenticates the
snapshot signer and source instance; it does not grant authority to the
receiving replica.

Replica diagnostics always report `authorityClassification:
non-authoritative`. Existing clients and storage nodes continue using the
current coordinator and are not routed through this contract.

## Revision and installation rules

Accepted state is bound to `(source instance ID, revision, snapshot digest)`.
The same tuple is idempotent. The same instance and revision with a different
digest is rejected. Lower revisions are rejected. Higher revisions are
accepted only when the source instance is explicitly trusted and the complete
snapshot has a valid proof. Unknown instances, conflicting identities, stale
or future proofs, malformed input, and partial snapshots are rejected.

Installation is transactional: validation completes before the in-memory
accepted snapshot changes. Persistence writes a bounded versioned snapshot and
proof to a restrictive temporary file, flushes it, atomically renames it, and
flushes the parent directory where supported. A failed write leaves the
previous accepted state intact and never produces authority. Missing or
corrupt persisted state is reported as unavailable/non-authoritative.

## Failure and retry behavior

An unavailable source, unauthenticated transfer, invalid proof, digest
mismatch, revision conflict, cancellation, persistence failure, or corrupted
state leaves the replica non-authoritative. Callers may retry a request; no
background retry loop or unbounded cache is created. Repeated identical
transfers are safe and idempotent.

Known-manifest download/delete outage behavior from 052B is unchanged. New
placement and repair still require fresh authoritative coordinator data.

## Future authority requirements

State transfer is not replication, consensus, fencing, leader election, or
failover. A future promotion mechanism would need an independently defined
authority source, exclusive-write/fencing semantics, conflict resolution, and
authenticated proof that a replica may serve placement. Reachability, a higher
revision, a valid snapshot proof, or coordinator disappearance cannot provide
that authority. DHT, backups, and this transfer protocol remain
non-authoritative.
