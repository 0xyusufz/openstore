# Milestone 053O: Authority Runtime Operational Observability

053O adds bounded, sanitized observability around the 053N authority runtime.
It does not change authority eligibility, grant validation, ownership fencing,
revocation, or coordinator behavior.

## Events

The runtime emits bounded EventStore events for startup/shutdown, restored
authority and ownership, blocked startup, ownership establishment/release/
fencing, token rejection, and revoked-grant rejection. Event details contain
only stable classifications and bounded epoch metadata. They never contain
keys, credentials, signed grants, ownership tokens, persistence contents, or
filesystem paths. EventStore capacity remains the governing bound.

## Metrics

Bounded counters include runtime starts/stops/failures, restored and
non-authoritative startup, persistence corruption, ownership establish
success/failure, release, fencing, token-validation rejection, and revoked
grant rejection. Metrics use no per-token, per-grant, or per-instance labels.

## Conditions and diagnostics

The runtime status includes lifecycle, authority classification, persistence
health, ownership state, a stable failure code, and deterministic authority
conditions:

- `authority_runtime_ready`
- `authority_runtime_non_authoritative`
- `authority_persistence_degraded`
- `authority_persistence_corrupt`
- `authority_ownership_conflict`
- `authority_fenced`

Startup classifications distinguish missing or uninitialized issuer state,
corrupt issuer/candidate/ownership persistence, epoch mismatch, issuer
identity mismatch, ownership conflict, and generic validation failure.
Observability is fail-safe: event, metric, or condition failures cannot grant
authority or weaken validation.

## Explicit non-goals

There is no automatic promotion, election, quorum, consensus, DHT authority,
network failover, client placement change, or unauthenticated mutation
endpoint. Observability never acts as authority evidence.
