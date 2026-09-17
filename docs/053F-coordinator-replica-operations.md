# Milestone 053F: Coordinator Replica Observability and Operator Controls

053F adds safe operational visibility around the 053E synchronization manager.
The current coordinator remains the only runtime authority.

## Diagnostics

`inspectStatus()` returns bounded aggregate metadata:

- lifecycle/synchronization state;
- non-authoritative authority classification;
- trusted/accepted source metadata;
- accepted revision and snapshot digest;
- synchronization and retry timestamps;
- retry count, freshness age, and failure category;
- persistence health, conflict reason, and bootstrap status.

It never returns snapshot contents, node data, URLs, credentials, private
keys, passwords, bearer tokens, or file/piece information.

## Operator controls

- `forceSync()` starts a normal authenticated transfer. It does not bypass
  proof, trusted-source, revision, or persistence validation.
- `resetForRebootstrap()` explicitly clears accepted replica state and
  persistence, then requires a fresh valid bootstrap. It is not automatic on
  restart.
- `clearConflict()` is a convenience control that does not choose a winner;
  it invokes explicit rebootstrap only while conflicted.

These controls are library-level vendor-neutral operations. Any HTTP or CLI
adapter must authenticate and authorize the operator request, bound its input,
apply replay protection, and return sanitized errors. No control grants
authority or changes the trusted source.

## Events, metrics, and conditions

The manager can emit bounded transition/failure events for bootstrap, sync,
retry, stale, conflict, rebootstrap, and operator actions through the existing
`EventStore`. Metrics use fixed aggregate series for attempts, successes,
failures, retries, conflicts, rebootstrap, state, revision, age, retry count,
and duration; identifiers and digests are never labels. Replica conditions
cover synchronized, stale/retrying, conflicted, bootstrap failure, and
persistence degradation without changing the existing bounded default output.

## Restart and recovery runbook

1. Inspect status and persistence health.
2. If stale or unavailable, verify coordinator availability and allow bounded
   retries or invoke `forceSync()`.
3. If conflicted, do not select a local winner. Investigate the sanitized
   conflict reason and invoke `clearConflict()` or `resetForRebootstrap()`
   explicitly.
4. Confirm a fresh authenticated snapshot restores `synchronized`.
5. Confirm status still reports `non-authoritative`.

Valid persisted state restores as synchronized/non-authoritative. Corrupt or
invalid state restores as rejected/unavailable and requires explicit
rebootstrap. Restart never promotes a replica.

## Authority boundary

Observability and operator actions do not implement election, consensus,
quorum, fencing, failover, distributed locking, LWW resolution, client
failover, DHT authority, or blockchain authority. A future promotion design
must establish exclusive authority independently.
