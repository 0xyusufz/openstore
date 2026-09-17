# Milestone 053P: Cross-Process Authority Recovery

053P adds a bounded IPC integration harness that drives the production
authority issuer, candidate grant service, ownership service, control plane,
and `CoordinatorAuthorityRuntime` in a separate Node process. The harness uses
isolated temporary persistence and explicit stdin/stdout commands; it adds no
production HTTP endpoint or authority shortcut.

## Lifecycle and recovery

The process lifecycle is explicit: bootstrap the trusted issuer, start the
runtime, issue/deliver/accept a grant, establish ownership, inspect, stop,
restart with the same persistence, and inspect again. Valid issuer,
candidate, and ownership records restore the same epoch, grant, and token
without issuing new authority evidence.

Missing issuer state leaves the runtime running but non-authoritative.
Corrupt issuer, candidate, or ownership persistence blocks startup and remains
degraded. Epoch and issuer-identity mismatches are rejected by the runtime's
existing 053N consistency checks. No state is repaired automatically.

## Fencing and split-brain model

Fencing and release are explicit persisted operations. Restart preserves
fenced/released non-authoritative state, and old ownership evidence cannot
re-establish authority. A second process sharing the ownership record cannot
start as authoritative or override the existing owner at the same epoch.
Reachability, DHT observations, timestamps, and process order do not select a
winner.

## Observability and non-goals

The process tests validate sanitized runtime status and the EventStore,
MetricsRegistry, and conditions integration through the existing runtime
tests. Event and metric bounds remain enforced by their existing stores.

053P does not add election, promotion, failover, quorum, consensus, DHT
authority, client placement changes, blockchain behavior, or unauthenticated
authority mutation endpoints.
