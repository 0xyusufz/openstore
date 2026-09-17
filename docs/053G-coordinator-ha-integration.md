# Milestone 053G: Coordinator HA Integration Boundary

053G integrates the existing coordinator runtime with the vendor-neutral
`coordinator-ha` contracts without creating a second registry or granting
replica authority.

## Runtime adapter

`packages/coordinator-ha/integration.ts` provides:

- `parseCoordinatorHaConfig`, which validates the HA environment settings.
- `createCoordinatorHaAdapter`, which wraps an existing `Registry`.
- bounded authoritative snapshot export and proof generation for a standalone
  coordinator.
- replica import, synchronization, status, explicit rebootstrap, and clean
  stop operations for `replica-observer` mode.

The adapter delegates snapshot validation, ordering, persistence, retry, and
conflict handling to the 053B–053F implementations. It never copies registry
state into a second authoritative store.

## Configuration and lifecycle

HA defaults to `standalone` and disabled. Supported settings are:

- `OPENSTORE_COORDINATOR_HA_ENABLED=true|false`
- `OPENSTORE_COORDINATOR_HA_ROLE=standalone|replica-observer`
- `OPENSTORE_COORDINATOR_HA_TRUSTED_INSTANCE_ID`
- `OPENSTORE_COORDINATOR_HA_SYNC_INTERVAL_MS`
- `OPENSTORE_COORDINATOR_HA_STALE_AFTER_MS`

Observer mode requires one validated trusted coordinator instance ID and an
injected authenticated state source. Invalid configuration fails closed.
Startup calls `start()` on the observer synchronizer; shutdown calls `stop()`.

## Authority and failure boundaries

The existing registry/coordinator remains the only authoritative runtime.
Observer snapshots are authenticated observations and are always reported as
`non-authoritative`; synchronized state cannot authorize placement, mutate the
registry, or advertise coordinator authority. DHT discovery remains
non-authoritative, and the 052B outage behavior is unchanged.

Temporary source failures retain the last accepted snapshot and use bounded
retry/staleness behavior. Invalid proofs, conflicts, malformed state, and
persistence failures are handled by the existing fail-closed importer and
sync manager. Rebootstrap is explicit and never selects a local winner.

No election, promotion, consensus, quorum, fencing, locking, client failover,
or automatic trust migration is implemented. A future authority mechanism must
define those guarantees separately and must not infer them from this adapter.
