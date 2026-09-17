# Milestone 053B: Authenticated Coordinator Replica Bootstrap

053B adds a protocol boundary for a future standby coordinator. It does not
replicate the registry, elect a leader, or promote a standby.

## Trust model

The current coordinator remains the sole placement authority. A bootstrap
snapshot is authoritative only when it contains a complete bounded snapshot,
the source instance identity is trusted by the receiving deployment, and an
Ed25519 authority proof verifies over the exact canonical snapshot digest.
Reachability, a hostname, a larger revision, recency, or a DHT observation is
not authority.

`CoordinatorInstanceIdentity` is public metadata derived from a durable
coordinator public key. Its canonical representation can be persisted beside
the coordinator registry and reloaded after a normal restart. If durable
identity is unavailable, a receiver must remain non-authoritative.

## Snapshot and proof

Snapshots contain versioned coordinator instance metadata, a bounded local
revision, observation time, and authoritative node state: registrations and
identity bindings, endpoint/transport metadata, availability and heartbeat
timestamps, capacity, and bounded reliability counters. Metrics, events,
conditions, replay caches, process state, and client caches are excluded.

Canonical key ordering and array ordering are used to calculate a SHA-256
snapshot digest. The versioned proof binds the protocol version, instance
identity/public key, revision, digest, `authoritative` classification, issued
time, and Ed25519 signature. Proof timestamps have bounded age and clock-skew
checks. Snapshot counts and serialized size are bounded; duplicate or
malformed node state is rejected. Proofs contain no private key or secret.

This proves integrity and authorship by the configured instance key. It does
not prove that the signer is the only live coordinator or that it has won a
future election.

## Bootstrap contract and state machine

`CoordinatorBootstrapMachine` accepts a snapshot only after validating the
trusted instance identity and proof. It transitions through
`uninitialized`, `bootstrapping`, `authoritative`, `stale`, `rejected`, and
`unavailable` outcomes. Incomplete, tampered, stale, future-dated,
identity-conflicting, or unverifiable input fails closed. A higher revision
from an untrusted source does not replace accepted state, and an unreachable
coordinator cannot cause automatic promotion.

The transport/API that carries a bounded request and response remains a future
integration concern. Existing coordinator and client APIs continue to operate
unchanged; 052B outage behavior remains in force: known-manifest downloads
and deletes may continue, while new placement and repair require fresh
authoritative coordinator information.

## Future work and limitations

The deployment must still define how a bootstrap source is configured and
trusted, how the complete registry is durably transferred before serving,
how writes are ordered, and what consensus or fencing authority prevents
split brain. Backups are not authority proofs. DHT is never a bootstrap
authority. Authenticated revocation and automatic failover remain future
architecture work.
